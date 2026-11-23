"""Shoutcast/Icecast in-band stream titles for the plain audio relay.

A station sends titles only when asked with ``Icy-MetaData: 1``. Its reply
then carries ``icy-metaint: N``, and after every N audio bytes the body holds
one length byte L followed by L * 16 bytes of text such as
``StreamTitle='Artist - Song';StreamUrl='...';`` padded with NULs. Those
blocks are not audio and must be removed before the player sees the body.

Everything here is pure (no network, no registry): the relay decides when to
ask, strips the body with IcyStripper, and stores what clean_stream_title()
returns. Only StreamTitle is read; StreamUrl and every other field are
ignored, and nothing named in metadata is ever fetched.
"""
from __future__ import annotations

import html
import re
import threading
import time
import unicodedata
import urllib.parse
from collections import OrderedDict
from typing import Callable, Iterable

ICY_REQUEST_HEADER = "Icy-MetaData"
# A sane icy-metaint is 1 .. 1 MiB (stations use 8192, 16000 or 32768).
MIN_METAINT = 1
MAX_METAINT = 1_048_576
MAX_TITLE_CHARS = 200
# A host whose server broke when asked for metadata is not asked again for
# this long; the memory holds at most MAX_REFUSED_HOSTS hosts.
REFUSED_HOST_SECONDS = 60 * 60
MAX_REFUSED_HOSTS = 512

_METAINT_VALUE = re.compile(r"[0-9]{1,7}")
_TITLE_START = re.compile(r"(?:^|;)\s*StreamTitle\s*=\s*'", re.IGNORECASE)
# A value ends at the first "';" that is followed by the end of the block or
# by the next "Key=". So quotes and semicolons inside a title survive, as in
# StreamTitle='Don't Stop; Believin'';StreamUrl='x';
_TITLE_END = re.compile(r"';\s*(?=$|[A-Za-z][A-Za-z0-9_]*\s*=)")
_WHITESPACE = re.compile(r"\s+")
_EDGE_SEPARATORS = re.compile(r"^(?:-+\s+)+|(?:\s+-+)+$")


def parse_metaint(value: object) -> int | None:
    """The metadata interval from an icy-metaint header, or None if it is unusable."""
    if not isinstance(value, str):
        return None
    value = value.strip()
    if not _METAINT_VALUE.fullmatch(value):
        return None
    interval = int(value)
    return interval if MIN_METAINT <= interval <= MAX_METAINT else None


class IcyStripper:
    """Remove metadata blocks from an icy body, chunk by chunk.

    feed() returns exactly the audio bytes of the chunk, whatever the chunk
    boundaries (a block may be split anywhere, also right before or after its
    length byte). Audio is passed on as soon as it arrives; only metadata is
    held until its block is complete. Work is done in slices, never per byte.
    """

    __slots__ = ("_metaint", "_audio_left", "_meta_left", "_meta", "_on_metadata")

    def __init__(self, metaint: int, on_metadata: Callable[[bytes], None] | None = None) -> None:
        if not isinstance(metaint, int) or not MIN_METAINT <= metaint <= MAX_METAINT:
            raise ValueError("icy-metaint is out of range")
        self._metaint = metaint
        self._audio_left = metaint  # audio bytes until the next length byte
        self._meta_left = -1  # -1: a length byte is next; >0: metadata bytes still due
        self._meta = bytearray()
        self._on_metadata = on_metadata

    def feed(self, chunk: bytes) -> bytes:
        size = len(chunk)
        if not size:
            return b""
        view = memoryview(chunk)
        position = 0
        audio: list = []
        while position < size:
            if self._audio_left:
                take = min(self._audio_left, size - position)
                audio.append(view[position:position + take])
                position += take
                self._audio_left -= take
                continue
            if self._meta_left < 0:
                length = chunk[position] * 16
                position += 1
                if length:
                    self._meta_left = length
                else:
                    self._audio_left = self._metaint
                continue
            take = min(self._meta_left, size - position)
            self._meta += view[position:position + take]
            position += take
            self._meta_left -= take
            if not self._meta_left:
                block = bytes(self._meta)
                self._meta.clear()
                self._meta_left = -1
                self._audio_left = self._metaint
                self._deliver(block)
        if len(audio) == 1 and len(audio[0]) == size:
            return chunk
        return b"".join(audio)

    def _deliver(self, block: bytes) -> None:
        if self._on_metadata is None:
            return
        try:
            self._on_metadata(block)
        except Exception:
            pass  # Metadata must never break the audio.


# Content types of raw AAC in ADTS frames, as live stations send them.
ADTS_CONTENT_TYPES = frozenset({"audio/aac", "audio/aacp", "audio/x-aac", "audio/x-aacp"})
# How far into a stream, and for how long after its first bytes, the first
# whole frame is looked for before giving up. The time cap keeps a slow
# stream (32 kbps is 4 KB/s) from being held for long.
MAX_ALIGN_BYTES = 64 * 1024
MAX_ALIGN_SECONDS = 1.5
# A start is a header followed by this many more, all alike: three frames in a row.
CONFIRMING_HEADERS = 2
_ADTS_HEADER = 7


def _adts_frame(data, at: int) -> tuple[int, tuple[int, int, int]] | None:
    """(frame length, fixed header fields) of an ADTS header at `at`, or None."""
    if at + _ADTS_HEADER > len(data):
        return None
    b1, b2, b3 = data[at + 1], data[at + 2], data[at + 3]
    if data[at] != 0xFF or b1 & 0xF6 != 0xF0 or (b2 >> 2) & 0x0F > 12:
        return None
    length = ((b3 & 0x03) << 11) | (data[at + 4] << 3) | (data[at + 5] >> 5)
    # A frame carries sound after its header (7 bytes, 9 with a CRC).
    if length <= (_ADTS_HEADER if b1 & 0x01 else _ADTS_HEADER + 2):
        return None
    # Sync, MPEG version, layer, protection, profile, sampling rate and
    # channels are the same in every frame of a stream.
    return length, (b1, b2 & 0xFD, b3 & 0xC0)


class AdtsAligner:
    """Start a live AAC stream at its first whole frame.

    A station starts a new listener wherever its buffer is, often in the
    middle of a frame. The partial frame can hold bytes that look like a frame
    header; a decoder that starts there fails (Chromium then reports a decode
    error and the start fails). The first header that the next two headers
    confirm (each right where the one before says it ends, all with the same
    fixed fields) is where the stream starts; the bytes before it are
    dropped. A candidate whose following headers have not arrived yet does not
    stop the search: a later candidate confirmed first wins. Nothing else is
    changed. If none is confirmed in the first MAX_ALIGN_BYTES, within
    MAX_ALIGN_SECONDS of the first bytes, or before the stream ends,
    everything held is passed on unchanged.
    """

    __slots__ = ("_buffer", "_done", "_limit", "_seconds", "_clock", "_started")

    def __init__(
        self, limit: int = MAX_ALIGN_BYTES, seconds: float = MAX_ALIGN_SECONDS,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._buffer = bytearray()
        self._done = False
        self._limit = limit
        self._seconds = seconds
        self._clock = clock
        self._started: float | None = None

    def feed(self, chunk: bytes) -> bytes:
        if self._done:
            return chunk
        if self._started is None:
            self._started = self._clock()
        self._buffer += chunk
        data = self._buffer
        at = data.find(b"\xff")
        while at != -1:
            if self._confirmed(data, at):
                return self._release(at)
            at = data.find(b"\xff", at + 1)
        if len(data) >= self._limit or self._clock() - self._started >= self._seconds:
            return self._release(0)
        return b""

    @staticmethod
    def _confirmed(data, at: int) -> bool:
        """True when a header at `at` is followed by two more with the same
        fixed fields; False when not, or not yet known."""
        frame = _adts_frame(data, at)
        if frame is None:
            return False
        position, length, fields = at, frame[0], frame[1]
        for _ in range(CONFIRMING_HEADERS):
            position += length
            following = _adts_frame(data, position)
            if following is None or following[1] != fields:
                return False  # no match, or not arrived yet: try later candidates
            length = following[0]
        return True

    def finish(self) -> bytes:
        """What is still held when the stream ends (passed on unchanged)."""
        return b"" if self._done else self._release(0)

    def _release(self, start: int) -> bytes:
        self._done = True
        out = bytes(self._buffer[start:])
        self._buffer = bytearray()
        return out


def parse_stream_title(block: bytes) -> str | None:
    """The raw StreamTitle value of one metadata block, or None if it has none."""
    if not isinstance(block, (bytes, bytearray)):
        return None
    data = bytes(block).rstrip(b"\0")
    if not data:
        return None
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError:
        text = data.decode("cp1252", errors="replace")
    start = _TITLE_START.search(text)
    if not start:
        return None
    begin = start.end()
    end = _TITLE_END.search(text, begin)
    if end:
        return text[begin:end.start()]
    closing = text.rstrip().rfind("'")
    return text[begin:closing] if closing >= begin else text[begin:]


def _plain_text(value: str) -> str:
    """Control characters become spaces, other invisible ones go; whitespace collapses."""
    characters = []
    for character in value:
        category = unicodedata.category(character)
        if category == "Cc":
            characters.append(" ")
        elif category[0] != "C":
            characters.append(character)
    return _WHITESPACE.sub(" ", "".join(characters)).strip()


def clean_stream_title(raw: str | None, station_names: Iterable[str] = ()) -> str | None:
    """A displayable song title, or None for "no title".

    HTML character references are decoded once first (some stations send
    "&amp;"), so "&amp;amp;" stays "&amp;"; whatever they decode to is then
    cleaned exactly like any other text. The title is only ever shown as text.

    Rule: after dropping control and invisible characters, collapsing
    whitespace and trimming a dangling " -" or "- " at either end, the title
    is "no title" when it is empty, has no letter or digit at all (so "-",
    " - ", "..." and similar placeholders), or equals one of the station's own
    names (ignoring case and spacing). Otherwise it is capped at 200
    characters.
    """
    if not isinstance(raw, str):
        return None
    text = _EDGE_SEPARATORS.sub("", _plain_text(html.unescape(raw))).strip()
    if not text or not any(character.isalnum() for character in text):
        return None
    folded = text.casefold()
    for name in station_names:
        if isinstance(name, str) and name and _plain_text(html.unescape(name)).casefold() == folded:
            return None
    return text[:MAX_TITLE_CHARS].rstrip()


def _host_key(url: str) -> tuple[str, int] | None:
    try:
        parsed = urllib.parse.urlsplit(url)
        port = parsed.port or (443 if parsed.scheme.lower() == "https" else 80)
    except ValueError:
        return None
    host = (parsed.hostname or "").rstrip(".").lower()
    return (host, port) if host else None


class RefusedIcyHosts:
    """Hosts not to ask for metadata for a while, bounded and thread safe."""

    def __init__(
        self,
        *,
        ttl_seconds: float = REFUSED_HOST_SECONDS,
        max_hosts: int = MAX_REFUSED_HOSTS,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._ttl = float(ttl_seconds)
        self._max = max(1, int(max_hosts))
        self._clock = clock
        self._until: OrderedDict[tuple[str, int], float] = OrderedDict()
        self._lock = threading.Lock()

    def should_ask(self, url: str) -> bool:
        key = _host_key(url)
        if key is None:
            return False
        with self._lock:
            until = self._until.get(key)
            if until is None:
                return True
            if until <= self._clock():
                del self._until[key]
                return True
            return False

    def refuse(self, url: str) -> None:
        key = _host_key(url)
        if key is None:
            return
        with self._lock:
            self._until[key] = self._clock() + self._ttl
            self._until.move_to_end(key)
            while len(self._until) > self._max:
                self._until.popitem(last=False)

    def clear(self) -> None:
        with self._lock:
            self._until.clear()

    def __len__(self) -> int:
        with self._lock:
            return len(self._until)
