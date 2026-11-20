"""A short look at two radio streams for "Pick the best stream: Auto (verified)".

The page asks for it at most twice a week per station, in the background,
after the station has played for a while. Both streams (the station's own and
the other directory entry) are opened at the same time with the media relay's
rules (the same address checks, DNS pinning and redirect rules as playback),
asked for in-band titles, and read for a short time. What comes back is only
what the streams say about themselves: the content type, icy-br, icy-name,
icy-url, the first song title, how many audio bytes arrived, and the scheme
and host the stream ended on after redirects. Nothing is decoded or kept; the
comparison is made by the page (src/lib/stream-verify.js).

Limits:
  - ONE wall-clock deadline (PROBE_SECONDS) covers everything: DNS, connect,
    TLS, every redirect and every read. Each socket gets the time that is
    left as its timeout; the DNS lookup runs on a helper thread that is
    simply abandoned when the time is up (it holds nothing).
  - At the deadline, or when the page goes away (the request was aborted),
    the sockets are closed, which ends any read at once.
  - One pair at a time: the slot stays taken until both workers have really
    ended. probe_pair waits at most PROBE_CEILING_SECONDS; a worker still
    alive after that keeps the slot, and new requests are answered "busy"
    instead of starting a second pair.
"""
from __future__ import annotations

import select
import socket
import threading
import time
import urllib.parse
from typing import Callable

from worldmedia_icy import (
    ICY_REQUEST_HEADER,
    IcyStripper,
    clean_stream_title,
    parse_metaint,
    parse_stream_title,
)
from worldmedia_media import SafeConnector

PROBE_SECONDS = 8.0
PROBE_CEILING_SECONDS = PROBE_SECONDS + 4.0
PROBE_MAX_BYTES = 256 * 1024
PROBE_READ_SIZE = 16 * 1024
PROBE_ENOUGH_AUDIO = 8 * 1024
MAX_URL_LENGTH = 2048
_HEADER_TEXT_LIMIT = 256
_MIN_TIMEOUT = 0.05
_WAIT_STEP_SECONDS = 0.1

# One probe at a time. The slot is a flag taken under the lock before the
# workers are made and given back only when both workers have ended (by the
# last worker itself, so also after the request stopped waiting for them),
# never judged by whether threads are alive yet: a pair that is still being
# started holds it too.
_SLOT_LOCK = threading.Lock()
_SLOT = {"taken": False, "workers": 0}
# The DNS helper threads still running (abandonable_resolver). One left
# behind at a deadline (a lookup that never answers) keeps new probes out
# until it ends: a probe is answered busy instead of starting more, so at most
# the two lookups of one probe can ever be outstanding.
_RESOLVERS: list[threading.Thread] = []


class ProbeBusy(Exception):
    """Another probe is running (or one has not ended yet)."""


class ProbeTimeout(OSError):
    """The probe's time is up."""


def _empty_facts() -> dict:
    return {
        "ok": False, "content_type": "", "bitrate": 0, "name": "", "url": "", "title": "",
        "audio_bytes": 0, "final_scheme": "", "final_host": "",
    }


class Deadline:
    """One wall-clock deadline, and a way to stop everything before it."""

    def __init__(self, seconds: float, clock: Callable[[], float] = time.monotonic) -> None:
        self.clock = clock
        self.ends = clock() + max(0.1, float(seconds))
        self.cancel = threading.Event()
        self._lock = threading.Lock()
        self._closers: list[Callable[[], None]] = []

    def left(self) -> float:
        return self.ends - self.clock()

    def expired(self) -> bool:
        return self.cancel.is_set() or self.left() <= 0

    def timeout(self) -> float:
        """The time left as a socket timeout; raises once it is up."""
        left = self.left()
        if self.cancel.is_set() or left <= 0:
            raise ProbeTimeout("The stream check ran out of time.")
        return max(_MIN_TIMEOUT, left)

    def on_stop(self, closer: Callable[[], None]) -> None:
        with self._lock:
            stopped = self.cancel.is_set()
            if not stopped:
                self._closers.append(closer)
        if stopped:
            closer()

    def stop(self) -> None:
        """Time is up or the page went away: close every socket now."""
        with self._lock:
            self.cancel.set()
            closers, self._closers = self._closers, []
        for closer in closers:
            try:
                closer()
            except Exception:
                pass


def abandonable_resolver(resolver: Callable[[str, int], object], deadline: Deadline) -> Callable[[str, int], list]:
    """The resolver run on a helper thread that is left behind when the time is up."""

    def resolve(host: str, port: int) -> list:
        box: dict[str, object] = {}
        done = threading.Event()

        def run() -> None:
            try:
                box["answers"] = list(resolver(host, port))
            except BaseException as error:  # handed to the caller below
                box["error"] = error
            done.set()

        helper = threading.Thread(target=run, daemon=True, name="stream-probe-dns")
        helper.start()
        with _SLOT_LOCK:
            _RESOLVERS.append(helper)
        if not done.wait(deadline.timeout()) or deadline.cancel.is_set():
            raise ProbeTimeout("The stream check ran out of time.")
        if "error" in box:
            raise box["error"]  # type: ignore[misc]
        return box["answers"]  # type: ignore[return-value]

    return resolve


class DeadlineConnector(SafeConnector):
    """The relay's connector with every timeout taken from one deadline.

    The address policy, TLS context and target policy are the relay's own;
    connect, header and idle timeouts are whatever time is left when each is
    used, and the DNS lookup can be abandoned.
    """

    def __init__(self, base: SafeConnector, deadline: Deadline) -> None:
        self._deadline = deadline
        super().__init__(
            resolver=abandonable_resolver(base.resolver, deadline),
            address_policy=base.address_policy,
            ssl_context=base.ssl_context,
            target_policy=base.target_policy,
        )

    # SafeConnector stores fixed timeouts; here they are read afresh each time.
    connect_timeout = property(lambda self: self._deadline.timeout(), lambda self, _value: None)
    header_timeout = property(lambda self: self._deadline.timeout(), lambda self, _value: None)
    idle_timeout = property(lambda self: self._deadline.timeout(), lambda self, _value: None)


def _header(response, name: str) -> str:
    value = response.getheader(name)
    if not isinstance(value, str):
        return ""
    value = value.strip()
    return value if len(value) <= _HEADER_TEXT_LIMIT and "\x00" not in value else ""


def valid_stream_url(value: object) -> str:
    """The URL when it is a plain http(s) address of sane length, else ''."""
    if not isinstance(value, str) or not value.strip() or len(value) > MAX_URL_LENGTH:
        return ""
    value = value.strip()
    try:
        parts = urllib.parse.urlsplit(value)
    except ValueError:
        return ""
    if parts.scheme.lower() not in {"http", "https"} or not parts.hostname or parts.username or parts.password:
        return ""
    return value


def _close_socket(sock) -> None:
    if sock is None:
        return
    try:
        sock.shutdown(socket.SHUT_RDWR)
    except OSError:
        pass
    try:
        sock.close()
    except OSError:
        pass


def _socket_of(upstream):
    """The socket a response reads from (http.client hands it from the
    connection to the response when the server closes after the body)."""
    sock = getattr(getattr(upstream, "connection", None), "sock", None)
    if sock is None:
        raw = getattr(getattr(getattr(upstream, "response", None), "fp", None), "raw", None)
        sock = getattr(raw, "_sock", None)
    return sock if isinstance(sock, socket.socket) else None


def _read_some(response, size: int) -> bytes:
    """At most one read from the socket (a slow drip cannot hold it open)."""
    read1 = getattr(response, "read1", None)
    return read1(size) if callable(read1) else response.read(size)


def probe_stream(connector, url: str, deadline: Deadline, *, max_bytes: int = PROBE_MAX_BYTES) -> dict:
    """What one stream says about itself before `deadline` (see the module text)."""
    facts = _empty_facts()
    try:
        upstream = connector.open(url, method="GET", headers={ICY_REQUEST_HEADER: "1"}, cancel=deadline.cancel)
    except Exception:  # Any failure to connect, or the time ran out: "did not play".
        return facts
    sock = _socket_of(upstream)
    deadline.on_stop(lambda: _close_socket(sock))
    try:
        response = upstream.response
        if not 200 <= response.status < 300:
            return facts
        try:
            final = urllib.parse.urlsplit(str(upstream.url))
            facts["final_scheme"] = final.scheme.lower()
            facts["final_host"] = (final.hostname or "").rstrip(".").lower()
        except ValueError:
            return facts
        facts["content_type"] = _header(response, "Content-Type").lower()
        bitrate = _header(response, "icy-br").split(",")[0].strip()
        facts["bitrate"] = int(bitrate) if bitrate.isdigit() and int(bitrate) <= 100_000 else 0
        facts["name"] = _header(response, "icy-name")
        facts["url"] = _header(response, "icy-url")
        titles: list[str] = []

        def record(block: bytes) -> None:
            raw = parse_stream_title(block)
            if raw is not None and not titles:
                titles.append(clean_stream_title(raw, [facts["name"]]) or "")
                facts["title"] = titles[0]

        metaint = parse_metaint(response.getheader("icy-metaint"))
        stripper = IcyStripper(metaint, record) if metaint else None
        read = 0
        while read < max_bytes:
            timeout = deadline.timeout()
            if sock is not None:
                sock.settimeout(timeout)
            chunk = _read_some(response, min(PROBE_READ_SIZE, max_bytes - read))
            if not chunk:
                break
            read += len(chunk)
            facts["audio_bytes"] += len(stripper.feed(chunk) if stripper else chunk)
            if titles and facts["audio_bytes"] >= PROBE_ENOUGH_AUDIO:
                break
        facts["ok"] = facts["audio_bytes"] > 0
        return facts
    except Exception:
        # Out of time or closed: what arrived so far still counts.
        facts["ok"] = facts["audio_bytes"] > 0 and bool(facts["final_scheme"])
        return facts
    finally:
        try:
            upstream.close()
        except Exception:
            pass


def _resolvers_running() -> bool:
    """Called with _SLOT_LOCK held."""
    _RESOLVERS[:] = [thread for thread in _RESOLVERS if thread.is_alive()]
    return bool(_RESOLVERS)


def probe_busy() -> bool:
    """True while a probe holds the slot or a DNS lookup of one still runs."""
    with _SLOT_LOCK:
        return _SLOT["taken"] or _resolvers_running()


def _worker_ended(count: int = 1) -> None:
    with _SLOT_LOCK:
        _SLOT["workers"] = max(0, _SLOT["workers"] - count)
        if _SLOT["workers"] == 0:
            _SLOT["taken"] = False


def probe_pair(
    base_connector: SafeConnector,
    payload: object,
    *,
    seconds: float = PROBE_SECONDS,
    ceiling: float = PROBE_CEILING_SECONDS,
    client_gone: Callable[[], bool] = lambda: False,
    probe: Callable[..., dict] = probe_stream,
    make_connector: Callable[[SafeConnector, Deadline], object] = DeadlineConnector,
) -> dict:
    """Probe the own stream and the other one at the same time; one pair at a time.

    Raises ValueError for a request that is not two valid addresses, and
    ProbeBusy while another probe (or what is left of one) runs.
    """
    if not isinstance(payload, dict) or set(payload) != {"own_url", "alt_url"}:
        raise ValueError("A stream check needs only own_url and alt_url.")
    own_url = valid_stream_url(payload.get("own_url"))
    alt_url = valid_stream_url(payload.get("alt_url"))
    if not own_url or not alt_url or own_url == alt_url:
        raise ValueError("A stream check needs two different web addresses.")
    deadline = Deadline(seconds)
    results: dict[str, dict] = {}

    def run(key: str, url: str) -> None:
        try:
            results[key] = probe(make_connector(base_connector, deadline), url, deadline)
        finally:
            _worker_ended()

    with _SLOT_LOCK:
        if _SLOT["taken"] or _resolvers_running():
            raise ProbeBusy()
        _SLOT["taken"] = True
        _SLOT["workers"] = 2
    threads: list[threading.Thread] = []
    try:
        threads = [threading.Thread(target=run, args=("own", own_url), daemon=True, name="stream-probe-own"),
                   threading.Thread(target=run, args=("alt", alt_url), daemon=True, name="stream-probe-alt")]
        started = 0
        try:
            for thread in threads:
                thread.start()
                started += 1
        finally:
            if started < 2:
                # The workers that never started give their share back now.
                _worker_ended(2 - started)
                threads = threads[:started]
    except BaseException:
        deadline.stop()
        raise
    hard_stop = deadline.clock() + max(seconds, ceiling)
    while any(thread.is_alive() for thread in threads):
        now = deadline.clock()
        if now >= hard_stop:
            break  # the workers keep the slot until they really end
        if not deadline.cancel.is_set() and (deadline.left() <= 0 or client_gone()):
            deadline.stop()
        for thread in threads:
            thread.join(_WAIT_STEP_SECONDS)
    deadline.stop()
    gone = client_gone()
    return {
        "own": results.get("own") or _empty_facts(),
        "alt": results.get("alt") or _empty_facts(),
        "cancelled": bool(gone),
    }


def client_went_away(sock) -> bool:
    """True when the page closed its request (the socket reads as closed).
    Asked only while a probe runs, a few times a second."""
    try:
        readable, _, _ = select.select([sock], [], [], 0)
        if not readable:
            return False
        return sock.recv(1, socket.MSG_PEEK) == b""
    except (OSError, ValueError):
        return True
