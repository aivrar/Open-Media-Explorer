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
