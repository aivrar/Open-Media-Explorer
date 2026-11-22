"""Pinned upstream connector plus opaque HLS and DASH media relays."""
from __future__ import annotations

import errno
import functools
import http.client
import heapq
import ipaddress
import re
import secrets
import select
import socket
import ssl
import threading
import time
import urllib.parse
import xml.etree.ElementTree as ET
from collections import OrderedDict
from dataclasses import dataclass, field, replace
from typing import Callable, Iterable, Mapping

from worldmedia_security import ApiError
from http import HTTPStatus


CONNECT_TIMEOUT = 8.0
HEADER_TIMEOUT = 12.0
IDLE_TIMEOUT = 15.0
MAX_REDIRECTS = 5
MAX_MANIFEST_BYTES = 2 * 1024 * 1024
MAX_REGISTRATIONS = 8192
DEFAULT_TTL_SECONDS = 6 * 60 * 60
# A live root lives this many default TTLs (capped at 24 h) after it was last
# used; see MediaRegistry._renew_live_locked().
LIVE_TTL_MULTIPLIER = 4
# A capture job's own relay root stays usable this long after the job ends.
CAPTURE_RELEASE_GRACE_SECONDS = 5.0
RELAY_USER_AGENT = "WorldMediaWindows/0.1.15"
# One root may hold at most half the registry, so a long VOD playlist (more
# than 2,048 segments) or several live renditions with long windows still fit.
MAX_CHILDREN_PER_ROOT = 4096
# A live HLS media playlist slides, so its segments, keys and maps would fill
# MAX_CHILDREN_PER_ROOT within hours (about 600 new entries an hour at 6 s).
# They keep the root's lifetime exactly like every other child, and are removed
# early only under pressure, least recently listed first and only once not
# listed for LIVE_CHILD_MIN_RETENTION_SECONDS: after a rewrite, while the root
# holds more than LIVE_CHILD_SOFT_LIMIT such evictable children (permanent ones
# do not count); and when a new child would exceed MAX_CHILDREN_PER_ROOT, just
# enough to make room plus LIVE_CHILD_EVICTION_BATCH. So a root's first 1,024
# live children behave as before; a 6 s stream with one rendition keeps
# slid-out segments valid for about 1.7 h (1,024 x 6 s), less if permanent
# children leave fewer than 1,024 places below the hard limit; anything the
# playlist being rewritten lists, or that was listed within the last ten
# minutes, is never evicted, however large the window; and the hard limit and
# its error still apply. Ten minutes exceeds what the player can still ask
# for after a segment leaves the playlist: src/lib/hls-recovery.js buffers at
# most 120 s ahead (maxMaxBufferLength) and 45 s behind (backBufferLength), and
# vendored hls.js retries a fragment for about 30 s within a 120 s load limit.
LIVE_CHILD_SOFT_LIMIT = 1024
LIVE_CHILD_MIN_RETENTION_SECONDS = 600
LIVE_CHILD_EVICTION_BATCH = 64
MAX_DASH_REPRESENTATIONS = 256
# Latest station-announced song titles kept, one per playback root (see now_playing()).
MAX_NOW_PLAYING = 256
RELAY_CHUNK_SIZE = 64 * 1024
MEDIA_RELAY_SUFFIXES = frozenset({
    "aac", "ac3", "bin", "eac3", "flac", "key", "m3u8", "m4a", "m4s",
    "m4v", "mp3", "mp4", "mpd", "mpeg", "mpegts", "oga", "ogg", "ogv",
    "ts", "vtt", "wav", "webm", "webvtt",
})
MEDIA_RELAY_SUFFIX_PATTERN = "|".join(sorted(MEDIA_RELAY_SUFFIXES))
_OUTBOUND_HEADER_NAMES = {
    "accept": "Accept",
    "content-type": "Content-Type",
    # Set only by the plain live audio relay (see worldmedia_icy.py). Capture
    # headers cannot carry it: sanitize_capture_headers() keeps two fields.
    "icy-metadata": "Icy-MetaData",
    "if-modified-since": "If-Modified-Since",
    "if-none-match": "If-None-Match",
    "if-range": "If-Range",
    "range": "Range",
    "referer": "Referer",
    "user-agent": "User-Agent",
}
_URI_ATTRIBUTE = re.compile(r'(?i)\bURI\s*=\s*("([^"]+)"|([^,\s]+))')
_HLS_ATTRIBUTE = re.compile(r'([A-Z0-9-]+)=("[^"]*"|[^,]*)', re.IGNORECASE)
_HLS_VIDEO_CODEC = re.compile(r'(?:avc|hvc|hev|vp0?9|vp8|av01|theora|mpeg2video)', re.IGNORECASE)
_HLS_AUDIO_CODEC = re.compile(r'(?:mp4a|aac|ac-3|ec-3|opus|vorbis|mp3)', re.IGNORECASE)
_DASH_PLACEHOLDER = re.compile(
    r"\$(RepresentationID|Number|Bandwidth|Time|SubNumber)(%0([1-9]\d?)d)?\$"
)
_DASH_SAFE_REPRESENTATION = re.compile(r"^[A-Za-z0-9_.~-]{1,128}$")
_DASH_QUERY_KEYS = {
    "RepresentationID": "wm_r",
    "Number": "wm_n",
    "Bandwidth": "wm_b",
    "Time": "wm_t",
    "SubNumber": "wm_s",
}
_DASH_URL_ATTRIBUTES = {
    "SegmentTemplate": ("media", "initialization", "index", "bitstreamSwitching"),
    "SegmentURL": ("media", "index"),
    "Initialization": ("sourceURL",),
    "RepresentationIndex": ("sourceURL",),
    "BitstreamSwitching": ("sourceURL",),
}


class MediaError(ApiError):
    pass


class MediaProtocolError(MediaError):
    """MEDIA_CONNECT_FAILED where a server took the request but gave no valid HTTP reply.

    For example a first line that is neither "HTTP/..." nor an old Shoutcast
    server's "ICY ..." (see _IcyStatusLineReader), which http.client rejects
    as BadStatusLine, or a connection reset or closed after the request was
    sent and before any reply. Never a DNS, connect or timeout failure. Same
    status, code and message as the plain error, so callers that do not care
    see no difference.
    """


def _media_error(status: int, code: str, message: str, retryable: bool = False) -> MediaError:
    return MediaError(status, code, message, retryable)


def sanitize_capture_headers(value: object) -> dict[str, str]:
    if not isinstance(value, dict):
        return {}
    result: dict[str, str] = {}
    for public, wire in (("referer", "Referer"), ("userAgent", "User-Agent")):
        candidate = value.get(public)
        if not isinstance(candidate, str):
            continue
        candidate = candidate.strip()
        if candidate and len(candidate) <= 1024 and not re.search(r"[\r\n\0]", candidate):
            result[wire] = candidate
    return result


@dataclass(frozen=True, slots=True)
class ResolvedTarget:
    url: str
    scheme: str
    host: str
    port: int
    request_target: str
    ip: str
    addresses: tuple[str, ...] = ()


# getaddrinfo's answers for "this name does not exist" and "this name has no
# address" (EAI_NONAME, EAI_NODATA; on Windows WSAHOST_NOT_FOUND, WSANO_DATA).
# Anything else (EAI_AGAIN, EAI_FAIL...) means the lookup could not be done.
_NO_SUCH_NAME = frozenset(
    value for value in (
        getattr(socket, "EAI_NONAME", None), getattr(socket, "EAI_NODATA", None), 11001, 11004,
    ) if isinstance(value, int)
)


def _default_resolver(host: str, port: int) -> Iterable[tuple]:
    return socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)


def _is_global_address(value: str) -> bool:
    try:
        address = ipaddress.ip_address(value.split("%", 1)[0])
    except ValueError:
        return False
    return address.is_global


def resolve_target(
    url: str,
    resolver: Callable[[str, int], Iterable[tuple]] = _default_resolver,
    address_policy: Callable[[str], bool] = _is_global_address,
) -> ResolvedTarget:
    if not isinstance(url, str) or len(url) > 8192:
        raise _media_error(HTTPStatus.BAD_REQUEST, "INVALID_MEDIA_URL", "Media URL is invalid.")
    try:
        parsed = urllib.parse.urlsplit(url)
        port = parsed.port
    except ValueError:
        raise _media_error(HTTPStatus.BAD_REQUEST, "INVALID_MEDIA_URL", "Media URL is invalid.") from None
    scheme = parsed.scheme.lower()
    if scheme not in {"http", "https"}:
        raise _media_error(HTTPStatus.BAD_REQUEST, "UNSUPPORTED_MEDIA_SCHEME", "Media URL must use HTTP or HTTPS.")
    if parsed.username is not None or parsed.password is not None:
        raise _media_error(HTTPStatus.BAD_REQUEST, "URL_CREDENTIALS_REJECTED", "Credentials are not allowed in media URLs.")
    raw_authority = parsed.netloc.rsplit("@", 1)[-1]
    if "%" in raw_authority:
        raise _media_error(HTTPStatus.BAD_REQUEST, "ENCODED_HOST_REJECTED", "Encoded media hosts are not allowed.")
    host = (parsed.hostname or "").rstrip(".").lower()
    if not host:
        raise _media_error(HTTPStatus.BAD_REQUEST, "INVALID_MEDIA_HOST", "Media host is missing.")
    try:
        ascii_host = host.encode("idna").decode("ascii")
    except UnicodeError:
        raise _media_error(HTTPStatus.BAD_REQUEST, "INVALID_MEDIA_HOST", "Media host is invalid.") from None
    port = port or (443 if scheme == "https" else 80)
    try:
        answers = list(resolver(ascii_host, port))
    except socket.gaierror as error:
        # The name server answered that the name does not exist (the station's
        # address is wrong), or the lookup itself could not be carried out
        # (no connection, no name server): the page tells these apart.
        if error.errno in _NO_SUCH_NAME:
            raise _media_error(
                HTTPStatus.BAD_GATEWAY, "MEDIA_HOST_NOT_FOUND", "Media host name does not exist.", True
            ) from None
        raise _media_error(HTTPStatus.BAD_GATEWAY, "MEDIA_DNS_FAILED", "Media host could not be resolved.", True) from None
    except OSError:
        raise _media_error(HTTPStatus.BAD_GATEWAY, "MEDIA_DNS_FAILED", "Media host could not be resolved.", True) from None
    addresses: list[str] = []
    for answer in answers:
        try:
            address = answer[4][0]
        except (IndexError, TypeError):
            continue
        if address not in addresses:
            addresses.append(address)
    if not addresses:
        raise _media_error(HTTPStatus.BAD_GATEWAY, "MEDIA_DNS_FAILED", "Media host could not be resolved.", True)
    if any(not address_policy(address) for address in addresses):
        raise _media_error(HTTPStatus.FORBIDDEN, "NON_GLOBAL_MEDIA_TARGET", "Private or local media targets are not allowed.")
    path = parsed.path or "/"
    request_target = urllib.parse.urlunsplit(("", "", path, parsed.query, ""))
    normalized_url = urllib.parse.urlunsplit((scheme, parsed.netloc, path, parsed.query, ""))
    return ResolvedTarget(
        normalized_url, scheme, ascii_host, port, request_target,
        addresses[0], tuple(addresses),
    )


class _IcyStatusLineReader:
    """The reply's reader, with a first line of "ICY ..." read as "HTTP/1.0 ...".

    An old Shoutcast server (version 1) answers a player with "ICY 200 OK"
    where a web server says "HTTP/1.0 200 OK"; the header lines and the sound
    after it are the same. Only the reply's first line is looked at, and only
    that exact word at its start is replaced. Every other call goes to the
    real reader unchanged.
    """

    def __init__(self, reader) -> None:
        self._reader = reader
        self._first_line = True

    def readline(self, *args):
        line = self._reader.readline(*args)
        if self._first_line:
            self._first_line = False
            if line.startswith(b"ICY "):
                return b"HTTP/1.0 " + line[4:]
        return line

    def __getattr__(self, name: str):
        return getattr(self._reader, name)


class _RelayResponse(http.client.HTTPResponse):
    """http.client's reply that also takes an old Shoutcast "ICY 200 OK" first line."""

    def __init__(self, *args, **kwargs) -> None:
        super().__init__(*args, **kwargs)
        self.fp = _IcyStatusLineReader(self.fp)


# A host often has several addresses, and one of them can be dead while the
# others work (commonly an IPv6 address that is announced but not reachable).
# Trying them one after another costs a full connect time-out for every request
# to such a host. A browser starts the next address a moment after the previous
# one and uses whichever connects first; so does this. Only addresses that
# passed the address check are ever tried.
CONNECT_STAGGER = 0.25
GOOD_ADDRESS_TTL = 600.0
GOOD_ADDRESS_LIMIT = 256
_CONNECT_PENDING = frozenset({errno.EINPROGRESS, errno.EWOULDBLOCK, errno.EALREADY, 10035, 10036})
_good_addresses: OrderedDict[tuple[str, int], tuple[str, float]] = OrderedDict()
_good_addresses_lock = threading.Lock()


def _remember_good_address(host: str, port: int, address: str) -> None:
    with _good_addresses_lock:
        _good_addresses[(host, port)] = (address, time.monotonic() + GOOD_ADDRESS_TTL)
        _good_addresses.move_to_end((host, port))
        while len(_good_addresses) > GOOD_ADDRESS_LIMIT:
            _good_addresses.popitem(last=False)


def _forget_good_address(host: str, port: int, address: str) -> None:
    with _good_addresses_lock:
        entry = _good_addresses.get((host, port))
        if entry and entry[0] == address:
            del _good_addresses[(host, port)]


def _dial_order(target: ResolvedTarget) -> list[str]:
    """The validated addresses in the order to try them.

    The two address families take turns, IPv4 first, and the address that
    last answered for this host goes to the front for a few minutes. Nothing
    is added: an address that is not in this lookup's validated answer is
    never tried.

    IPv4 first because a connection that is made is kept whatever its speed:
    on a home network whose IPv6 route is poor, a host can connect over IPv6
    at once and then send at a fraction of the IPv4 speed (measured: one
    directory at a quarter to a tenth), or list an IPv6 address that never
    answers. Where there is no IPv4 at all, that attempt fails immediately
    and the IPv6 address is tried in the same moment.
    """
    addresses = list(dict.fromkeys(target.addresses or (target.ip,)))
    same = [address for address in addresses if ":" not in address]
    other = [address for address in addresses if ":" in address]
    ordered: list[str] = []
    for index in range(max(len(same), len(other))):
        if index < len(same):
            ordered.append(same[index])
        if index < len(other):
            ordered.append(other[index])
    with _good_addresses_lock:
        entry = _good_addresses.get((target.host, target.port))
    if entry and entry[1] > time.monotonic() and entry[0] in ordered:
        ordered.remove(entry[0])
        ordered.insert(0, entry[0])
    return ordered


def _connect_first(
    addresses: Iterable[str],
    port: int,
    timeout: float,
    cancelled: Callable[[], bool] | None = None,
) -> tuple[socket.socket, str]:
    """Connect to whichever address answers first; the whole attempt has one time limit.

    The first address gets a short head start, then the next one is started
    as well (at once when an attempt fails outright). The first to connect is
    returned with its address; every other attempt is closed.
    """
    waiting = list(addresses)
    if not waiting:
        raise OSError("no address to connect to")
    stagger = min(CONNECT_STAGGER, timeout / (2 * len(waiting)))
    pending: dict[socket.socket, str] = {}
    deadline = time.monotonic() + timeout
    next_start = 0.0
    last_error: OSError | None = None
    try:
        while True:
            now = time.monotonic()
            if cancelled is not None and cancelled():
                raise TimeoutError("connect cancelled")
            if waiting and now < deadline and (not pending or now >= next_start):
                address = waiting.pop(0)
                next_start = now + stagger
                attempt: socket.socket | None = None
                try:
                    attempt = socket.socket(socket.AF_INET6 if ":" in address else socket.AF_INET, socket.SOCK_STREAM)
                    attempt.setblocking(False)
                    code = attempt.connect_ex((address, port))
                except OSError as error:
                    last_error = error
                    if attempt is not None:
                        attempt.close()
                    continue
                if code == 0:
                    attempt.settimeout(timeout)
                    return attempt, address
                if code not in _CONNECT_PENDING:
                    last_error = OSError(code, "connect failed")
                    attempt.close()
                    continue
                pending[attempt] = address
                continue
            if not pending or now >= deadline:
                raise last_error if (last_error is not None and not pending) else TimeoutError("timed out")
            wait = deadline - now
            if waiting:
                wait = min(wait, max(0.0, next_start - now))
            sockets = list(pending)
            _, writable, failed = select.select([], sockets, sockets, min(wait, 0.25))
            for attempt in failed:
                if attempt not in pending:
                    continue
                code = attempt.getsockopt(socket.SOL_SOCKET, socket.SO_ERROR)
                last_error = OSError(code or errno.ECONNREFUSED, "connect failed")
                del pending[attempt]
                attempt.close()
                next_start = 0.0
            for attempt in writable:
                if attempt not in pending:
                    continue
                code = attempt.getsockopt(socket.SOL_SOCKET, socket.SO_ERROR)
                address = pending.pop(attempt)
                if code == 0:
                    attempt.settimeout(timeout)
                    return attempt, address
                last_error = OSError(code, "connect failed")
                attempt.close()
                next_start = 0.0
    finally:
        for attempt in pending:
            attempt.close()


class _PinnedHTTPConnection(http.client.HTTPConnection):
    response_class = _RelayResponse

    def __init__(
        self,
        target: ResolvedTarget,
        timeout: float,
        *,
        candidates: Iterable[str] = (),
        cancelled: Callable[[], bool] | None = None,
    ) -> None:
        super().__init__(target.host, target.port, timeout=timeout)
        self._selected_ip = target.ip
        self._candidates = tuple(candidates)
        self._cancelled = cancelled
        self.dialled = False

    def connect(self) -> None:
        if len(self._candidates) > 1:
            self.sock, self._selected_ip = _connect_first(
                self._candidates, self.port, self.timeout, self._cancelled,
            )
        else:
            self.sock = socket.create_connection((self._selected_ip, self.port), self.timeout)
        self.dialled = True


class _PinnedHTTPSConnection(_PinnedHTTPConnection):
    def __init__(
        self,
        target: ResolvedTarget,
        timeout: float,
        context: ssl.SSLContext,
        *,
        candidates: Iterable[str] = (),
        cancelled: Callable[[], bool] | None = None,
    ) -> None:
        super().__init__(target, timeout, candidates=candidates, cancelled=cancelled)
        self._context = context
        self._server_hostname = target.host

    def connect(self) -> None:
        super().connect()
        assert self.sock is not None
        self.sock = self._context.wrap_socket(self.sock, server_hostname=self._server_hostname)


@dataclass(slots=True)
class Upstream:
    response: http.client.HTTPResponse
    connection: http.client.HTTPConnection
    url: str

    def close(self) -> None:
        try:
            self.response.close()
        finally:
            self.connection.close()

    def iter_chunks(
        self,
        *,
        cancel: threading.Event | None = None,
        chunk_size: int = RELAY_CHUNK_SIZE,
    ):
        size = max(1024, min(int(chunk_size), RELAY_CHUNK_SIZE))
        while True:
            if cancel and cancel.is_set():
                raise _media_error(HTTPStatus.REQUEST_TIMEOUT, "MEDIA_CANCELLED", "Media request was cancelled.")
            try:
                chunk = self.response.read(size)
            except socket.timeout:
                raise _media_error(HTTPStatus.GATEWAY_TIMEOUT, "MEDIA_IDLE_TIMEOUT", "Media source stopped responding.", True) from None
            if not chunk:
                remaining = getattr(self.response, "length", None)
                if isinstance(remaining, int) and remaining > 0:
                    raise _media_error(
                        HTTPStatus.BAD_GATEWAY,
                        "UPSTREAM_BODY_TRUNCATED",
                        "Media source ended before its declared length.",
                        True,
                    )
                return
            yield chunk

    def iter_available(
        self,
        *,
        cancel: threading.Event | None = None,
        chunk_size: int = RELAY_CHUNK_SIZE,
    ):
        """Like iter_chunks(), but yields whatever has arrived instead of a full chunk.

        Each item is one read1(): it waits for at least one byte (with the same
        idle timeout) and then returns what is buffered or one socket read, at
        most chunk_size. Used by the stripped icy relay: the removed metadata
        leaves its first output a few bytes short of 64 KiB, and a media
        element that starts only once it holds 64 KiB would otherwise wait a
        whole further 64 KiB read on a slow station. Never a busy loop.
        """
        size = max(1024, min(int(chunk_size), RELAY_CHUNK_SIZE))
        read = getattr(self.response, "read1", None) or self.response.read
        while True:
            if cancel and cancel.is_set():
                raise _media_error(HTTPStatus.REQUEST_TIMEOUT, "MEDIA_CANCELLED", "Media request was cancelled.")
            try:
                chunk = read(size)
            except socket.timeout:
                raise _media_error(HTTPStatus.GATEWAY_TIMEOUT, "MEDIA_IDLE_TIMEOUT", "Media source stopped responding.", True) from None
            if not chunk:
                remaining = getattr(self.response, "length", None)
                if isinstance(remaining, int) and remaining > 0:
                    raise _media_error(
                        HTTPStatus.BAD_GATEWAY,
                        "UPSTREAM_BODY_TRUNCATED",
                        "Media source ended before its declared length.",
                        True,
                    )
                return
            yield chunk


class SafeConnector:
    def __init__(
        self,
        *,
        resolver: Callable[[str, int], Iterable[tuple]] = _default_resolver,
        address_policy: Callable[[str], bool] = _is_global_address,
        ssl_context: ssl.SSLContext | None = None,
        connect_timeout: float = CONNECT_TIMEOUT,
        header_timeout: float = HEADER_TIMEOUT,
        idle_timeout: float = IDLE_TIMEOUT,
        target_policy: Callable[[ResolvedTarget], bool] | None = None,
    ) -> None:
        self.resolver = resolver
        self.address_policy = address_policy
        self.ssl_context = ssl_context or ssl.create_default_context()
        self.connect_timeout = max(0.1, float(connect_timeout))
        self.header_timeout = max(0.1, float(header_timeout))
        self.idle_timeout = max(0.1, float(idle_timeout))
        self.target_policy = target_policy

    def resolve(self, url: str) -> ResolvedTarget:
        return resolve_target(url, self.resolver, self.address_policy)

    def resolve_batch(self, urls: Iterable[str]) -> dict[str, ResolvedTarget]:
        """Resolve the distinct URLs one manifest lists, looking each (host, port) up once.

        Every URL still gets its own validation, and the address policy still
        checks every address of the shared answer for every URL. The answers
        live only for this call; open() never uses them and resolves afresh.
        """
        answers: dict[tuple[str, int], list] = {}

        def resolver(host: str, port: int) -> list:
            if (host, port) not in answers:
                answers[(host, port)] = list(self.resolver(host, port))
            return answers[(host, port)]

        return {url: resolve_target(url, resolver, self.address_policy) for url in dict.fromkeys(urls)}

    def open(
        self,
        url: str,
        *,
        method: str = "GET",
        headers: Mapping[str, str] | None = None,
        body: bytes | None = None,
        cancel: threading.Event | None = None,
        accept_gzip: bool = False,
    ) -> Upstream:
        """Open url, following approved redirects.

        Media is always asked for uncompressed (Accept-Encoding: identity).
        accept_gzip=True is for metadata callers that decode or pass on a gzip
        body themselves; it asks for gzip instead. Callers cannot set
        Accept-Encoding through headers, so exactly one such header goes out.
        """
        accept_encoding = "gzip" if accept_gzip else "identity"
        safe_headers: dict[str, str] = {}
        for raw_name, raw_value in (headers or {}).items():
            if not isinstance(raw_name, str) or not isinstance(raw_value, str):
                raise _media_error(
                    HTTPStatus.BAD_REQUEST,
                    "INVALID_OUTBOUND_HEADER",
                    "Outbound request headers are invalid.",
                )
            wire_name = _OUTBOUND_HEADER_NAMES.get(raw_name.strip().lower())
            if not wire_name:
                continue
            value = raw_value.strip()
            if not value or len(value) > 4096 or re.search(r"[\r\n\0]", value):
                raise _media_error(
                    HTTPStatus.BAD_REQUEST,
                    "INVALID_OUTBOUND_HEADER",
                    "Outbound request headers are invalid.",
                )
            safe_headers[wire_name] = value

        current = url
        current_headers = dict(safe_headers)
        current_method = method.upper()
        current_body = body
        if current_method not in {"GET", "HEAD", "POST"}:
            raise ValueError("connector supports GET, HEAD, and POST only")
        if current_body is not None and not isinstance(current_body, bytes):
            raise ValueError("connector body must be bytes")
        if current_method != "POST" and current_body:
            raise ValueError("connector body is only valid for POST")
        for redirect_count in range(MAX_REDIRECTS + 1):
            if cancel and cancel.is_set():
                raise _media_error(HTTPStatus.REQUEST_TIMEOUT, "MEDIA_CANCELLED", "Media request was cancelled.")
            target = self.resolve(current)
            if self.target_policy and not self.target_policy(target):
                raise _media_error(
                    HTTPStatus.FORBIDDEN,
                    "MEDIA_TARGET_REJECTED",
                    "Media target is not approved for this operation.",
                )
            host_header = target.host
            if ":" in host_header:
                host_header = f"[{host_header}]"
            default_port = 443 if target.scheme == "https" else 80
            if target.port != default_port:
                host_header = f"{host_header}:{target.port}"
            connection: http.client.HTTPConnection | None = None
            response: http.client.HTTPResponse | None = None
            protocol_failure = False
            # DNS pinning prevents rebinding, but pinning only the first valid
            # address makes a multi-address CDN less reliable than a browser:
            # one retired edge turns a healthy channel into an immediate 502.
            # Every address was validated above, so retry each pinned address
            # without performing another DNS lookup. The addresses still to
            # try are connected to together (see _connect_first), so one dead
            # address does not hold up a host whose other addresses work.
            remaining = _dial_order(target)
            cancelled = cancel.is_set if cancel else None
            while remaining:
                if cancel and cancel.is_set():
                    raise _media_error(HTTPStatus.REQUEST_TIMEOUT, "MEDIA_CANCELLED", "Media request was cancelled.")
                dial_target = target if remaining[0] == target.ip else replace(target, ip=remaining[0])
                if target.scheme == "https":
                    connection = _PinnedHTTPSConnection(
                        dial_target, self.connect_timeout, self.ssl_context,
                        candidates=remaining, cancelled=cancelled,
                    )
                else:
                    connection = _PinnedHTTPConnection(
                        dial_target, self.connect_timeout, candidates=remaining, cancelled=cancelled,
                    )
                request_sent = False
                try:
                    connection.putrequest(current_method, target.request_target, skip_host=True, skip_accept_encoding=True)
                    connection.putheader("Host", host_header)
                    if "Accept" not in current_headers:
                        connection.putheader("Accept", "*/*")
                    connection.putheader("Accept-Encoding", accept_encoding)
                    if "User-Agent" not in current_headers:
                        connection.putheader("User-Agent", RELAY_USER_AGENT)
                    for name, value in current_headers.items():
                        connection.putheader(name, value)
                    if current_method == "POST":
                        connection.putheader("Content-Length", str(len(current_body or b"")))
                    connection.endheaders(current_body if current_method == "POST" else None)
                    request_sent = True
                    if connection.sock:
                        connection.sock.settimeout(self.header_timeout)
                    response = connection.getresponse()
                    _remember_good_address(target.host, target.port, connection._selected_ip)
                    break
                except (OSError, TimeoutError, http.client.HTTPException) as error:
                    # The server was reached and took the request, then answered
                    # with something that is not HTTP, or reset or closed the
                    # connection before any reply. Connect failures and timeouts
                    # are not this.
                    if isinstance(error, http.client.HTTPException) or (
                        request_sent
                        and isinstance(error, (ConnectionResetError, ConnectionAbortedError))
                    ):
                        protocol_failure = True
                    dialled = connection.dialled
                    failed_ip = connection._selected_ip
                    connection.close()
                    connection = None
                    if cancel and cancel.is_set():
                        raise _media_error(
                            HTTPStatus.REQUEST_TIMEOUT, "MEDIA_CANCELLED", "Media request was cancelled.",
                        ) from None
                    if not dialled:
                        # None of the addresses still to try could be connected to.
                        break
                    _forget_good_address(target.host, target.port, failed_ip)
                    if failed_ip in remaining:
                        remaining.remove(failed_ip)
            if connection is None or response is None:
                error_type = MediaProtocolError if protocol_failure else MediaError
                raise error_type(
                    HTTPStatus.BAD_GATEWAY,
                    "MEDIA_CONNECT_FAILED",
                    "Media source could not be reached.",
                    True,
                ) from None
            location = response.getheader("Location")
            if response.status in {301, 302, 303, 307, 308} and location:
                redirect_status = response.status
                response.close()
                connection.close()
                if redirect_count >= MAX_REDIRECTS:
                    raise _media_error(HTTPStatus.BAD_GATEWAY, "TOO_MANY_MEDIA_REDIRECTS", "Media source redirected too many times.")
                current = urllib.parse.urljoin(target.url, location)
                try:
                    redirected = urllib.parse.urlsplit(current)
                    redirected_port = redirected.port or (443 if redirected.scheme.lower() == "https" else 80)
                    same_origin = (
                        redirected.scheme.lower() == target.scheme
                        and (redirected.hostname or "").rstrip(".").lower() == target.host
                        and redirected_port == target.port
                    )
                except ValueError:
                    same_origin = False
                if not same_origin:
                    for name in ("If-Modified-Since", "If-None-Match", "If-Range"):
                        current_headers.pop(name, None)
                if redirect_status == 303 or (current_method == "POST" and redirect_status in {301, 302}):
                    current_method = "GET"
                    current_body = None
                continue
            if connection.sock:
                connection.sock.settimeout(self.idle_timeout)
            return Upstream(response, connection, target.url)
        raise _media_error(HTTPStatus.BAD_GATEWAY, "TOO_MANY_MEDIA_REDIRECTS", "Media source redirected too many times.")


@dataclass(slots=True)
class MediaRegistration:
    token: str
    item_id: str
    url: str
    delivery: str
    media_type: str
    headers: dict[str, str]
    expires_at: float
    root_token: str
    title: str = "Media"
    source: str = ""
    download_name: str = ""
    recording_kind: str = ""
    content_type: str | None = None
    content_length: int | None = None
    created_at: float = field(default_factory=time.time)
    # Listed only by live media playlists: may be evicted under pressure (see child()).
    evictable: bool = False
    # Set on a root once it is expired on purpose; a released root is never renewed.
    released: bool = False
    # Set on a root a capture job (recording) reads; the relay never asks it for icy metadata.
    capture: bool = False
    # A stream verified by "Pick the best stream: Auto": it must still end on
    # https after redirects, or it does not play (the server's relay checks).
    require_https: bool = False

    def public_data(self) -> dict:
        return {
            "media_id": self.token,
            "relay_url": f"/api/v1/media/{self.token}",
            "expires_at": self.expires_at,
            "delivery": self.delivery,
            "media_type": self.media_type,
            "content_type": self.content_type,
            "content_length": self.content_length,
        }


def media_relay_suffix(url: str, media_type: str) -> str:
    path = urllib.parse.urlsplit(url).path
    suffix = path.rsplit("/", 1)[-1].rsplit(".", 1)[-1].lower() if "." in path.rsplit("/", 1)[-1] else ""
    if suffix in MEDIA_RELAY_SUFFIXES:
        return f".{suffix}"
    fallback = {"hls": ".m3u8", "dash": ".mpd", "video": ".mp4", "audio": ".aac"}
    return fallback.get(media_type, "")


def media_relay_path(registration: MediaRegistration) -> str:
    """Return an opaque route with a decorative, allowlisted media suffix."""
    return f"/api/v1/media/{registration.token}{media_relay_suffix(registration.url, registration.media_type)}"


@dataclass(frozen=True, slots=True)
class HlsVariant:
    url: str
    bandwidth: int
    width: int
    height: int
    has_video: bool
    has_audio: bool


def _hls_attributes(value: str) -> dict[str, str]:
    attributes: dict[str, str] = {}
    for match in _HLS_ATTRIBUTE.finditer(value):
        raw = match.group(2).strip()
        if len(raw) >= 2 and raw.startswith('"') and raw.endswith('"'):
            raw = raw[1:-1]
        attributes[match.group(1).upper()] = raw
    return attributes


def hls_variants(text: str, manifest_url: str) -> tuple[HlsVariant, ...]:
    """Return bounded master-playlist variants without fetching child URLs."""

    if not isinstance(text, str) or not text.lstrip().startswith("#EXTM3U"):
        return ()
    lines = text.splitlines()
    variants: list[HlsVariant] = []
    for index, line in enumerate(lines):
        stripped = line.strip()
        if not stripped.upper().startswith("#EXT-X-STREAM-INF:"):
            continue
        attributes = _hls_attributes(stripped.split(":", 1)[1])
        uri = ""
        for candidate in lines[index + 1:]:
            candidate = candidate.strip()
            if not candidate:
                continue
            if candidate.startswith("#"):
                break
            uri = candidate
            break
        if not uri or len(uri) > 8192 or re.search(r"[\r\n\0]", uri):
            continue
        try:
            absolute = urllib.parse.urljoin(manifest_url, uri)
            parsed = urllib.parse.urlsplit(absolute)
        except (TypeError, ValueError):
            continue
        if parsed.scheme.lower() not in {"http", "https"} or not parsed.hostname:
            continue
        resolution = re.fullmatch(r"(\d{1,5})x(\d{1,5})", attributes.get("RESOLUTION", ""), re.IGNORECASE)
        width = int(resolution.group(1)) if resolution else 0
        height = int(resolution.group(2)) if resolution else 0
        codecs = attributes.get("CODECS", "")
        bandwidth_raw = attributes.get("AVERAGE-BANDWIDTH") or attributes.get("BANDWIDTH") or "0"
        try:
            bandwidth = max(0, min(int(bandwidth_raw), 10**10))
        except (TypeError, ValueError):
            bandwidth = 0
        variants.append(HlsVariant(
            url=absolute,
            bandwidth=bandwidth,
            width=width,
            height=height,
            has_video=bool(width and height) or bool(_HLS_VIDEO_CODEC.search(codecs)),
            has_audio=bool(_HLS_AUDIO_CODEC.search(codecs)) or bool(attributes.get("AUDIO")),
        ))
        if len(variants) >= 256:
            break
    return tuple(variants)


def select_hls_recording_variant(
    text: str,
    manifest_url: str,
    *,
    recording_kind: str,
    max_height: int,
) -> str:
    """Choose one master variant so FFmpeg does not probe every rendition."""

    variants = hls_variants(text, manifest_url)
    if not variants:
        return ""
    if recording_kind == "audio":
        audio_only = [variant for variant in variants if variant.has_audio and not variant.has_video]
        declared_audio = [variant for variant in variants if variant.has_audio]
        # A number of radio HLS masters omit CODECS entirely. Renditions with
        # neither video dimensions nor a declared video codec are the safest
        # audio fallback and still avoid probing every rendition.
        undeclared_audio = [variant for variant in variants if not variant.has_video]
        candidates = audio_only or declared_audio or undeclared_audio
        if not candidates:
            return ""
        return max(candidates, key=lambda variant: (variant.bandwidth, -variant.height)).url
    if recording_kind != "video":
        return ""
    candidates = [variant for variant in variants if variant.has_video]
    if not candidates:
        return ""
    target = max(1, int(max_height or 1080))
    within = [variant for variant in candidates if variant.height and variant.height <= target]
    if within:
        return max(within, key=lambda variant: (variant.height, variant.bandwidth, variant.width)).url
    sized = [variant for variant in candidates if variant.height]
    if sized:
        return min(sized, key=lambda variant: (variant.height, -variant.bandwidth, variant.width)).url
    return max(candidates, key=lambda variant: variant.bandwidth).url


@dataclass(frozen=True, slots=True)
class DashTemplateRegistration:
    token: str
    root_token: str
    item_id: str
    url_template: str
    placeholders: tuple[str, ...]
    placeholder_literals: tuple[tuple[str, str], ...]
    representation_templates: tuple[tuple[str, str], ...]
    allowed_representation_ids: frozenset[str]
    allowed_bandwidths: frozenset[str]
    headers: dict[str, str]
    expires_at: float
    delivery: str
    title: str
    source: str
    recording_kind: str
    # Inherited from the root: every segment it expands to must stay on https.
    require_https: bool = False

    def relay_template(self) -> str:
        literals = dict(self.placeholder_literals)
        query = "&".join(
            f"{_DASH_QUERY_KEYS[name]}={literals[name]}" for name in self.placeholders
        )
        suffix = media_relay_suffix(self.url_template, "video")
        return f"/api/v1/dash/{self.token}{suffix}?{query}"


@dataclass(frozen=True, slots=True)
class _DashTemplatePlan:
    """A validated, resolved DASH template that is not registered yet."""

    key: tuple
    url_template: str
    placeholders: tuple[str, ...]
    placeholder_literals: tuple[tuple[str, str], ...]
    representation_templates: tuple[tuple[str, str], ...]
    allowed_representation_ids: frozenset[str]
    allowed_bandwidths: frozenset[str]


class MediaRegistry:
    def __init__(self, connector: SafeConnector | None = None, *, ttl_seconds: int = DEFAULT_TTL_SECONDS) -> None:
        self.connector = connector or SafeConnector()
        self.ttl_seconds = max(60, min(int(ttl_seconds), 24 * 60 * 60))
        self.live_ttl_seconds = min(24 * 60 * 60, self.ttl_seconds * LIVE_TTL_MULTIPLIER)
        self._entries: dict[str, MediaRegistration] = {}
        self._child_index: dict[tuple[str, str], str] = {}
        self._child_keys_by_token: dict[str, tuple[str, str]] = {}
        self._dash_templates: dict[str, DashTemplateRegistration] = {}
        self._dash_template_index: dict[tuple, str] = {}
        self._dash_keys_by_token: dict[str, tuple] = {}
        self._root_child_counts: dict[str, int] = {}
        self._expiry_heap: list[tuple[float, str, str]] = []
        # Per root: evictable child tokens, least recently listed first, with the time last listed.
        self._live_listed: dict[str, OrderedDict[str, float]] = {}
        # Per root token: (latest song title or None, wall-clock time it changed),
        # least recently updated first; at most MAX_NOW_PLAYING entries.
        self._now_playing: OrderedDict[str, tuple[str | None, float]] = OrderedDict()
        self._lock = threading.RLock()

    def register(self, payload: object) -> MediaRegistration:
        if not isinstance(payload, dict):
            raise _media_error(HTTPStatus.BAD_REQUEST, "INVALID_MEDIA_REGISTRATION", "Media registration must be an object.")
        allowed = {
            "item_id", "url", "delivery", "media_type", "capture_headers",
            "title", "source", "download_name", "recording_kind", "require_https",
        }
        if set(payload) - allowed:
            raise _media_error(HTTPStatus.BAD_REQUEST, "UNEXPECTED_FIELDS", "Media registration contains unsupported fields.")
        item_id = payload.get("item_id")
        url = payload.get("url")
        delivery = payload.get("delivery")
        media_type = payload.get("media_type")
        title = payload.get("title", item_id)
        source = payload.get("source", "")
        download_name = payload.get("download_name", "")
        recording_kind = payload.get("recording_kind", "")
        require_https = payload.get("require_https", False)
        if not isinstance(require_https, bool):
            raise _media_error(HTTPStatus.BAD_REQUEST, "INVALID_MEDIA_REGISTRATION", "require_https must be true or false.")
        if not isinstance(item_id, str) or not item_id.strip() or len(item_id) > 512:
            raise _media_error(HTTPStatus.BAD_REQUEST, "INVALID_MEDIA_ITEM", "Media item ID is invalid.")
        if delivery not in {"live", "on-demand", "unknown"}:
            raise _media_error(HTTPStatus.BAD_REQUEST, "INVALID_MEDIA_DELIVERY", "Media delivery is invalid.")
        if media_type not in {"audio", "video", "hls", "dash"}:
            raise _media_error(HTTPStatus.BAD_REQUEST, "INVALID_MEDIA_TYPE", "Media type is invalid.")
        if not isinstance(title, str) or not title.strip() or len(title) > 512 or re.search(r"[\r\n\0]", title):
            raise _media_error(HTTPStatus.BAD_REQUEST, "INVALID_MEDIA_TITLE", "Media title is invalid.")
        if not isinstance(source, str) or (source and not re.fullmatch(r"[a-z0-9-]{1,64}", source)):
            raise _media_error(HTTPStatus.BAD_REQUEST, "INVALID_MEDIA_SOURCE", "Media source is invalid.")
        if not isinstance(download_name, str) or len(download_name) > 512 or re.search(r"[\r\n\0]", download_name):
            raise _media_error(HTTPStatus.BAD_REQUEST, "INVALID_DOWNLOAD_NAME", "Media download name is invalid.")
        if recording_kind not in {"", "audio", "video"}:
            raise _media_error(HTTPStatus.BAD_REQUEST, "INVALID_RECORDING_KIND", "Media recording kind is invalid.")
        if media_type == "audio":
            recording_kind = "audio"
        elif media_type == "video":
            recording_kind = "video"
        target = self.connector.resolve(url)
        now = time.time()
        token = secrets.token_urlsafe(32)
        registration = MediaRegistration(
            token=token,
            item_id=item_id.strip(),
            url=target.url,
            delivery=delivery,
            media_type=media_type,
            headers=sanitize_capture_headers(payload.get("capture_headers")),
            expires_at=now + (self.live_ttl_seconds if delivery == "live" else self.ttl_seconds),
            root_token=token,
            title=title.strip(),
            source=source,
            download_name=download_name.strip(),
            recording_kind=recording_kind,
            require_https=require_https,
        )
        with self._lock:
            self._prune_locked(now)
            if len(self._entries) + len(self._dash_templates) >= MAX_REGISTRATIONS:
                raise _media_error(HTTPStatus.SERVICE_UNAVAILABLE, "MEDIA_REGISTRY_FULL", "Media relay is temporarily full.", True)
            self._entries[token] = registration
            heapq.heappush(self._expiry_heap, (registration.expires_at, "entry", token))
        return registration

    def get(self, token: str) -> MediaRegistration:
        now = time.time()
        with self._lock:
            self._prune_locked(now)
            registration = self._entries.get(token)
            if (not registration or registration.expires_at <= now
                    or registration.root_token not in self._entries):
                raise _media_error(HTTPStatus.NOT_FOUND, "MEDIA_TOKEN_EXPIRED", "Media relay token is invalid or expired.")
            self._renew_live_locked(registration.root_token, now)
            return registration

    def _renew_live_locked(self, root_token: str, now: float) -> None:
        """Slide a live root's lease on use: every relay request looks its token up.

        Once less than half of live_ttl_seconds is left, the root, its children
        and its DASH templates all move to now + live_ttl_seconds together, so a
        live root in use never runs out, and an unused one dies between half
        and all of live_ttl_seconds after its last use. A released (expired on
        purpose) root is never renewed. Old heap records are left behind;
        _prune_locked skips them because expires_at no longer matches.
        """
        root = self._entries.get(root_token)
        if (root is None or root.delivery != "live" or root.released or root.expires_at <= now
                or root.expires_at - now >= self.live_ttl_seconds / 2):
            return
        deadline = now + self.live_ttl_seconds
        for registration in self._entries.values():
            if registration.root_token == root_token:
                registration.expires_at = deadline
                heapq.heappush(self._expiry_heap, (deadline, "entry", registration.token))
        for template_token, template in tuple(self._dash_templates.items()):
            if template.root_token == root_token:
                self._dash_templates[template_token] = replace(template, expires_at=deadline)
                heapq.heappush(self._expiry_heap, (deadline, "template", template_token))

    def child(
        self,
        parent: MediaRegistration,
        url: str,
        *,
        media_type: str | None = None,
        evictable: bool = False,
        target: ResolvedTarget | None = None,
    ) -> MediaRegistration:
        """Scoped relay entry for a resource listed by `parent`.

        Every child keeps its parent's lifetime. An evictable one (listed by a
        live media playlist) can also be removed early under pressure; see
        LIVE_CHILD_SOFT_LIMIT. Any non-evictable sighting makes it permanent.
        `target` is `url` already resolved by the caller.
        """
        target = target or self.connector.resolve(url)
        with self._lock:
            now = time.time()
            self._prune_locked(now)
            self._check_parent_locked(parent, now)
            entry = self._existing_child_locked(parent, target.url)
            if entry is not None:
                self._sight_child_locked(parent, entry, evictable=evictable, now=now)
                return entry
            root_children = self._root_child_counts.get(parent.root_token, 0)
            if root_children >= MAX_CHILDREN_PER_ROOT and evictable:
                # A playlist adding many segments at once: make room from old history first.
                excess = root_children - MAX_CHILDREN_PER_ROOT + 1 + LIVE_CHILD_EVICTION_BATCH
                self._evict_live_locked(parent.root_token, now, excess)
            child = self._new_child(parent, target, media_type=media_type, evictable=evictable)
            self._insert_child_locked(parent, child, now=now)
            return child

    def _check_parent_locked(self, parent: MediaRegistration, now: float) -> None:
        if parent.root_token not in self._entries or parent.expires_at <= now:
            raise _media_error(HTTPStatus.NOT_FOUND, "MEDIA_TOKEN_EXPIRED", "Media relay token is invalid or expired.")

    def _existing_child_locked(self, parent: MediaRegistration, url: str) -> MediaRegistration | None:
        token = self._child_index.get((parent.root_token, url))
        return self._entries.get(token) if token is not None else None

    def _sight_child_locked(self, parent: MediaRegistration, entry: MediaRegistration, *, evictable: bool, now: float) -> None:
        """An existing child listed again: a non-evictable sighting makes it permanent."""
        if not entry.evictable:
            return
        listed = self._live_listed.get(parent.root_token)
        if not evictable:
            entry.evictable = False  # Permanent for good.
            if listed is not None:
                listed.pop(entry.token, None)
                if not listed:
                    del self._live_listed[parent.root_token]
        elif listed is not None:
            listed[entry.token] = now
            listed.move_to_end(entry.token)

    @staticmethod
    def _new_child(
        parent: MediaRegistration, target: ResolvedTarget, *, media_type: str | None, evictable: bool,
    ) -> MediaRegistration:
        """A child registration with its token decided, not registered yet."""
        token = secrets.token_urlsafe(32)
        return MediaRegistration(
            token=token,
            item_id=parent.item_id,
            url=target.url,
            delivery=parent.delivery,
            media_type=media_type or infer_media_type(target.url),
            headers=dict(parent.headers),
            expires_at=parent.expires_at,
            root_token=parent.root_token,
            title=parent.title,
            source=parent.source,
            download_name=parent.download_name,
            recording_kind=parent.recording_kind,
            evictable=evictable,
            # A root that must stay on https (a verified stream) passes it to
            # every playlist and segment under it.
            require_https=parent.require_https,
        )

    def _insert_child_locked(self, parent: MediaRegistration, child: MediaRegistration, *, now: float) -> None:
        root_children = self._root_child_counts.get(parent.root_token, 0)
        if root_children >= MAX_CHILDREN_PER_ROOT:
            code = "DASH_CHILD_LIMIT" if parent.media_type == "dash" else "HLS_CHILD_LIMIT"
            raise _media_error(
                HTTPStatus.BAD_GATEWAY,
                code,
                "Streaming manifest contains too many resources.",
            )
        if len(self._entries) + len(self._dash_templates) >= MAX_REGISTRATIONS:
            raise _media_error(HTTPStatus.SERVICE_UNAVAILABLE, "MEDIA_REGISTRY_FULL", "Media relay is temporarily full.", True)
        key = (parent.root_token, child.url)
        self._entries[child.token] = child
        self._child_index[key] = child.token
        self._child_keys_by_token[child.token] = key
        self._root_child_counts[parent.root_token] = root_children + 1
        if child.evictable:
            self._live_listed.setdefault(parent.root_token, OrderedDict())[child.token] = now
        heapq.heappush(self._expiry_heap, (child.expires_at, "entry", child.token))

    def touch_live_children(self, parent: MediaRegistration, urls: Iterable[str]) -> None:
        """Mark the evictable children of `parent`'s root at these resolved URLs as listed now.

        Creates nothing and leaves permanent entries alone, so a rewrite can
        protect everything it lists before it adds anything that might evict.
        """
        with self._lock:
            listed = self._live_listed.get(parent.root_token)
            if not listed:
                return
            now = time.time()
            for url in urls:
                token = self._child_index.get((parent.root_token, url))
                if token in listed:
                    listed[token] = now
                    listed.move_to_end(token)

    def add_children(
        self, parent: MediaRegistration, targets: Mapping[str, ResolvedTarget], *, evictable: bool,
    ) -> dict[str, MediaRegistration]:
        """Register everything one rewrite lists, all or nothing, in one locked step.

        `targets` maps each listed URL to its already resolved target, so no
        network or DNS work happens under the lock. For a live playlist the
        listed evictable children first count as listed now, so nothing this
        rewrite lists can be evicted. Then both limits are worked out: if the
        new entries would not fit, a live playlist may evict old history, but
        only when that is enough for everything to fit; otherwise
        HLS_CHILD_LIMIT or MEDIA_REGISTRY_FULL is raised with nothing changed.
        The checks in _insert_child_locked() stay as a backstop.
        """
        children, _templates = self._commit(parent, targets, (), evictable=evictable, render=None)
        return children

    def add_dash_resources(
        self,
        parent: MediaRegistration,
        targets: Mapping[str, ResolvedTarget],
        plans: Iterable["_DashTemplatePlan"],
        render: Callable[[dict[str, MediaRegistration], list[DashTemplateRegistration]], object],
    ) -> object:
        """Register one DASH rewrite's children and templates, all or nothing.

        Like add_children(), and in the same locked step every entry is
        decided (an existing one, or a new one with its token) and passed to
        `render`, which builds and checks the rewritten manifest. Only when
        render returns is anything registered; its result is returned. If it
        raises, the registry is left exactly as it was (apart from pruning
        entries that had already expired).
        """
        _children, result = self._commit(parent, targets, list(plans), evictable=False, render=render)
        return result

    def _commit(
        self,
        parent: MediaRegistration,
        targets: Mapping[str, ResolvedTarget],
        plans: list["_DashTemplatePlan"],
        *,
        evictable: bool,
        render: Callable[[dict[str, MediaRegistration], list[DashTemplateRegistration]], object] | None,
    ) -> tuple[dict[str, MediaRegistration], object]:
        """The one locked step behind add_children() and add_dash_resources().

        One clock reading decides the parent's validity and every time used.
        Nothing changes until the limits are checked and render() returned.
        """
        with self._lock:
            now = time.time()
            self._prune_locked(now)
            self._check_parent_locked(parent, now)
            # 1. Decide every entry without changing anything.
            by_url: dict[str, MediaRegistration] = {}
            existing: list[MediaRegistration] = []
            new_children: list[MediaRegistration] = []
            for target in targets.values():
                if target.url in by_url:
                    continue
                entry = self._existing_child_locked(parent, target.url)
                if entry is None:
                    entry = self._new_child(parent, target, media_type=None, evictable=evictable)
                    new_children.append(entry)
                else:
                    existing.append(entry)
                by_url[target.url] = entry
            by_key: dict[tuple, DashTemplateRegistration] = {}
            new_templates: list[tuple[tuple, DashTemplateRegistration]] = []
            for plan in plans:
                if plan.key in by_key:
                    continue
                token = self._dash_template_index.get(plan.key)
                template = self._dash_templates.get(token) if token is not None else None
                if template is None:
                    template = self._new_dash_template(parent, plan)
                    new_templates.append((plan.key, template))
                by_key[plan.key] = template
            children = {url: by_url[target.url] for url, target in targets.items()}
            templates = [by_key[plan.key] for plan in plans]
            # 2. Check both limits. This rewrite's own children are re-listed
            # below, so they never count as old history that could be evicted.
            protected = {entry.token for entry in existing} if evictable else set()
            needed = self._room_needed_locked(
                parent, len(new_children) + len(new_templates), evictable=evictable, now=now, protected=protected,
            )
            # 3. Build the output; a failure here still leaves everything as it was.
            result = render(children, templates) if render is not None else None
            # 4. Commit. Nothing below is expected to fail; the insert checks are a backstop.
            for entry in existing:
                self._sight_child_locked(parent, entry, evictable=evictable, now=now)
            if needed:
                self._evict_live_locked(parent.root_token, now, needed)
            for entry in new_children:
                self._insert_child_locked(parent, entry, now=now)
            for key, template in new_templates:
                self._insert_dash_template_locked(parent, key, template)
            if evictable:
                self._trim_live_locked(parent.root_token, now)
            return children, result

    def _room_needed_locked(
        self, parent: MediaRegistration, new: int, *, evictable: bool, now: float, protected: set[str],
    ) -> int:
        """Raise unless `new` more entries fit under both limits; changes nothing.

        Returns how many old live children (evictable only) must be evicted
        first. They may be evicted only when that is enough for everything
        to fit; otherwise the limit error is raised.
        """
        root_token = parent.root_token
        over_root = self._root_child_counts.get(root_token, 0) + new - MAX_CHILDREN_PER_ROOT
        over_registry = len(self._entries) + len(self._dash_templates) + new - MAX_REGISTRATIONS
        needed = max(over_root, over_registry, 0)
        evictable_now = self._old_live_count_locked(root_token, now, needed, protected) if evictable and needed else 0
        if over_root > evictable_now:
            code = "DASH_CHILD_LIMIT" if parent.media_type == "dash" else "HLS_CHILD_LIMIT"
            raise _media_error(HTTPStatus.BAD_GATEWAY, code, "Streaming manifest contains too many resources.")
        if over_registry > evictable_now:
            raise _media_error(HTTPStatus.SERVICE_UNAVAILABLE, "MEDIA_REGISTRY_FULL", "Media relay is temporarily full.", True)
        return needed

    def _old_live_count_locked(self, root_token: str, now: float, limit: int, protected: set[str]) -> int:
        """How many of the root's evictable children, up to `limit`, _evict_live_locked() would take.

        `protected` children are about to be listed again (moved to the end
        with the time now), so they are skipped here as eviction will skip them.
        """
        count = 0
        for token, last_listed in self._live_listed.get(root_token, {}).items():
            if count >= limit:
                break
            if token in protected:
                continue
            if now - last_listed < LIVE_CHILD_MIN_RETENTION_SECONDS:
                break
            count += 1
        return count

    def _trim_live_locked(self, root_token: str, now: float) -> None:
        listed = self._live_listed.get(root_token)
        if listed and len(listed) > LIVE_CHILD_SOFT_LIMIT:
            self._evict_live_locked(root_token, now, len(listed) - LIVE_CHILD_SOFT_LIMIT)

    def _evict_live_locked(self, root_token: str, now: float, excess: int) -> None:
        """Evict up to `excess` evictable children, least recently listed first."""
        listed = self._live_listed.get(root_token)
        evicted = False
        while listed and excess > 0:
            excess -= 1
            token, last_listed = next(iter(listed.items()))
            if now - last_listed < LIVE_CHILD_MIN_RETENTION_SECONDS:
                break  # Everything after this was listed even more recently.
            listed.pop(token)
            self._remove_entry_locked(token)
            evicted = True
        # An evicted entry leaves its heap record behind until the root's expiry
        # (_prune_locked skips it); rebuild once those outnumber the live records.
        live_records = len(self._entries) + len(self._dash_templates)
        if evicted and len(self._expiry_heap) > 4 * live_records + 1024:
            self._expiry_heap = [(entry.expires_at, "entry", token) for token, entry in self._entries.items()]
            self._expiry_heap.extend(
                (template.expires_at, "template", token) for token, template in self._dash_templates.items()
            )
            heapq.heapify(self._expiry_heap)

    def plan_dash_template(
        self,
        parent: MediaRegistration,
        url_template: str,
        *,
        representation_ids: Iterable[str] = (),
        bandwidths: Iterable[str] = (),
        representation_templates: Mapping[str, str] | None = None,
    ) -> "_DashTemplatePlan":
        """Validate and resolve one DASH URL template; registers nothing."""

        raw_representation_templates = dict(representation_templates or {})
        if len(raw_representation_templates) > MAX_DASH_REPRESENTATIONS:
            raise _media_error(
                HTTPStatus.BAD_GATEWAY,
                "DASH_MANIFEST_TOO_COMPLEX",
                "DASH manifest contains too many representations.",
            )
        all_templates = [url_template, *raw_representation_templates.values()]
        template_matches: list[list[re.Match]] = []
        for candidate in all_templates:
            try:
                parsed = urllib.parse.urlsplit(candidate)
            except (TypeError, ValueError):
                raise _media_error(HTTPStatus.BAD_GATEWAY, "INVALID_DASH_TEMPLATE", "DASH segment template is invalid.") from None
            if "$" in parsed.scheme or "$" in parsed.netloc:
                raise _media_error(
                    HTTPStatus.BAD_GATEWAY,
                    "INVALID_DASH_TEMPLATE",
                    "DASH placeholders are not allowed in an upstream host.",
                )
            matches = list(_DASH_PLACEHOLDER.finditer(candidate))
            scrubbed = _DASH_PLACEHOLDER.sub("", candidate).replace("$$", "")
            if "$" in scrubbed:
                raise _media_error(
                    HTTPStatus.BAD_GATEWAY,
                    "INVALID_DASH_TEMPLATE",
                    "DASH segment template contains an unsupported placeholder.",
                )
            template_matches.append(matches)
        matches = template_matches[0]
        if not matches and not raw_representation_templates:
            raise _media_error(
                HTTPStatus.BAD_GATEWAY,
                "INVALID_DASH_TEMPLATE",
                "DASH segment template does not contain a supported placeholder.",
            )
        placeholders: list[str] = []
        literals: dict[str, str] = {}
        for match in matches:
            name = match.group(1)
            literal = match.group(0)
            if match.group(3) and int(match.group(3)) > 20:
                raise _media_error(
                    HTTPStatus.BAD_GATEWAY,
                    "INVALID_DASH_TEMPLATE",
                    "DASH numeric placeholder width is too large.",
                )
            if name in literals and literals[name] != literal:
                raise _media_error(
                    HTTPStatus.BAD_GATEWAY,
                    "INVALID_DASH_TEMPLATE",
                    "DASH repeats one placeholder with incompatible formatting.",
                )
            if name not in literals:
                placeholders.append(name)
                literals[name] = literal

        allowed_representations = frozenset(str(value) for value in representation_ids)
        raw_bandwidths = frozenset(str(value) for value in bandwidths)
        allowed_bandwidths = frozenset(str(int(value)) for value in raw_bandwidths if value.isdigit())
        if raw_representation_templates and "RepresentationID" not in placeholders:
            placeholders.append("RepresentationID")
            literals["RepresentationID"] = "$RepresentationID$"
        if "RepresentationID" in placeholders:
            if not allowed_representations or any(
                not _valid_dash_representation(value) for value in allowed_representations
            ):
                raise _media_error(
                    HTTPStatus.BAD_GATEWAY,
                    "INVALID_DASH_REPRESENTATION",
                    "DASH representation identifiers are not safe for relay substitution.",
                )
        if "Bandwidth" in placeholders and (
            not allowed_bandwidths
            or any(not value.isdigit() or len(value) > 20 for value in raw_bandwidths)
        ):
            raise _media_error(
                HTTPStatus.BAD_GATEWAY,
                "INVALID_DASH_BANDWIDTH",
                "DASH representation bandwidths are invalid.",
            )

        target = self.connector.resolve(url_template)
        resolved_representation_templates: list[tuple[str, str]] = []
        for representation_id, candidate in raw_representation_templates.items():
            if representation_id not in allowed_representations or not _valid_dash_representation(representation_id):
                raise _media_error(
                    HTTPStatus.BAD_GATEWAY,
                    "INVALID_DASH_REPRESENTATION",
                    "DASH representation template is not allowlisted.",
                )
            candidate_matches = tuple(match.group(0) for match in template_matches[len(resolved_representation_templates) + 1])
            root_matches = tuple(match.group(0) for match in matches)
            if candidate_matches != root_matches:
                raise _media_error(
                    HTTPStatus.BAD_GATEWAY,
                    "INVALID_DASH_TEMPLATE",
                    "DASH representation templates do not share one placeholder contract.",
                )
            resolved_representation_templates.append((representation_id, self.connector.resolve(candidate).url))
        resolved_representation_templates.sort()
        literal_items = tuple((name, literals[name]) for name in placeholders)
        key = (
            parent.root_token,
            target.url,
            tuple(placeholders),
            literal_items,
            tuple(resolved_representation_templates),
            tuple(sorted(allowed_representations)),
            tuple(sorted(allowed_bandwidths)),
        )
        return _DashTemplatePlan(
            key=key,
            url_template=target.url,
            placeholders=tuple(placeholders),
            placeholder_literals=literal_items,
            representation_templates=tuple(resolved_representation_templates),
            allowed_representation_ids=allowed_representations,
            allowed_bandwidths=allowed_bandwidths,
        )

    @staticmethod
    def _new_dash_template(parent: MediaRegistration, plan: "_DashTemplatePlan") -> DashTemplateRegistration:
        """A template registration with its token decided, not registered yet."""
        return DashTemplateRegistration(
            token=secrets.token_urlsafe(32),
            root_token=parent.root_token,
            item_id=parent.item_id,
            url_template=plan.url_template,
            placeholders=plan.placeholders,
            placeholder_literals=plan.placeholder_literals,
            representation_templates=plan.representation_templates,
            allowed_representation_ids=plan.allowed_representation_ids,
            allowed_bandwidths=plan.allowed_bandwidths,
            headers=dict(parent.headers),
            expires_at=parent.expires_at,
            delivery=parent.delivery,
            title=parent.title,
            source=parent.source,
            recording_kind=parent.recording_kind,
            require_https=parent.require_https,
        )

    def _insert_dash_template_locked(
        self, parent: MediaRegistration, key: tuple, template: DashTemplateRegistration,
    ) -> None:
        child_count = self._root_child_counts.get(parent.root_token, 0)
        if child_count >= MAX_CHILDREN_PER_ROOT:
            raise _media_error(
                HTTPStatus.BAD_GATEWAY,
                "DASH_CHILD_LIMIT",
                "DASH manifest contains too many resource templates.",
            )
        if len(self._entries) + len(self._dash_templates) >= MAX_REGISTRATIONS:
            raise _media_error(HTTPStatus.SERVICE_UNAVAILABLE, "MEDIA_REGISTRY_FULL", "Media relay is temporarily full.", True)
        self._dash_templates[template.token] = template
        self._dash_template_index[key] = template.token
        self._dash_keys_by_token[template.token] = key
        self._root_child_counts[parent.root_token] = child_count + 1
        heapq.heappush(self._expiry_heap, (template.expires_at, "template", template.token))

    def expand_dash_template(self, token: str, query: str) -> MediaRegistration:
        if not isinstance(query, str) or len(query) > 2048 or re.search(r"%(?![0-9A-Fa-f]{2})", query):
            raise _media_error(HTTPStatus.BAD_REQUEST, "INVALID_DASH_PARAMETERS", "DASH relay parameters are invalid.")
        now = time.time()
        with self._lock:
            self._prune_locked(now)
            entry = self._dash_templates.get(token)
            if (not entry or entry.expires_at <= now
                    or entry.root_token not in self._entries):
                raise _media_error(HTTPStatus.NOT_FOUND, "DASH_TEMPLATE_EXPIRED", "DASH relay template is invalid or expired.")
            self._renew_live_locked(entry.root_token, now)
            entry = self._dash_templates[token]  # Renewal replaces the frozen record.
        try:
            parsed = urllib.parse.parse_qs(
                query, keep_blank_values=True, strict_parsing=True, max_num_fields=5,
            )
        except ValueError:
            raise _media_error(HTTPStatus.BAD_REQUEST, "INVALID_DASH_PARAMETERS", "DASH relay parameters are invalid.") from None
        expected = {_DASH_QUERY_KEYS[name] for name in entry.placeholders}
        if set(parsed) != expected or any(len(values) != 1 for values in parsed.values()):
            raise _media_error(HTTPStatus.BAD_REQUEST, "INVALID_DASH_PARAMETERS", "DASH relay parameters are invalid.")

        values: dict[str, str] = {}
        for name in entry.placeholders:
            value = parsed[_DASH_QUERY_KEYS[name]][0]
            if name == "RepresentationID":
                if not _valid_dash_representation(value) or value not in entry.allowed_representation_ids:
                    raise _media_error(HTTPStatus.FORBIDDEN, "DASH_VALUE_REJECTED", "DASH representation is not allowed.")
            else:
                if not value.isdigit() or len(value) > 20:
                    raise _media_error(HTTPStatus.BAD_REQUEST, "INVALID_DASH_PARAMETERS", "DASH numeric parameter is invalid.")
                if name == "Bandwidth" and str(int(value)) not in entry.allowed_bandwidths:
                    raise _media_error(HTTPStatus.FORBIDDEN, "DASH_VALUE_REJECTED", "DASH bandwidth is not allowed.")
            values[name] = value

        sentinel = "\x00WORLDMEDIA_DOLLAR\x00"
        selected_templates = dict(entry.representation_templates)
        template = selected_templates.get(values.get("RepresentationID", ""), entry.url_template).replace("$$", sentinel)
        expanded = _DASH_PLACEHOLDER.sub(lambda match: values[match.group(1)], template).replace(sentinel, "$")
        if "$" in expanded:
            raise _media_error(HTTPStatus.BAD_GATEWAY, "INVALID_DASH_TEMPLATE", "DASH template expansion was incomplete.")
        target = self.connector.resolve(expanded)
        return MediaRegistration(
            token=entry.token,
            item_id=entry.item_id,
            url=target.url,
            delivery=entry.delivery,
            media_type=infer_media_type(target.url),
            headers=dict(entry.headers),
            expires_at=entry.expires_at,
            root_token=entry.root_token,
            title=entry.title,
            source=entry.source,
            recording_kind=entry.recording_kind,
            require_https=entry.require_https,
        )

    def expire(self, token: str, *, grace_seconds: float = 0) -> None:
        deadline = time.time() + max(0.0, min(float(grace_seconds), 30.0))
        with self._lock:
            entry = self._entries.get(token)
            if not entry:
                return
            self._expire_roots_locked({entry.root_token}, deadline)

    def release_root(self, token: str, *, grace_seconds: float = CAPTURE_RELEASE_GRACE_SECONDS) -> bool:
        """Expire `token`'s registrations if `token` is itself a root; never raises.

        Capture jobs call this when they end. It relies on the invariant that
        each capture job is started with its own freshly registered root
        (src/lib/download-client.js and recording-client.js register one per
        start; playback never hands its root to a job). A job started from a
        child token (another root's resource) leaves that root alone.
        """
        with self._lock:
            entry = self._entries.get(token)
            if entry is None or entry.root_token != token:
                return False
            self.expire(token, grace_seconds=grace_seconds)
            return True

    def mark_capture(self, token: str) -> None:
        """A capture job reads this registration: its relay requests never ask for icy metadata."""
        with self._lock:
            entry = self._entries.get(token)
            if entry is not None:
                entry.capture = True

    def _live_root_locked(self, token: str, now: float) -> MediaRegistration | None:
        root = self._entries.get(token)
        if root is None or root.root_token != token or root.released or root.expires_at <= now:
            return None
        return root

    def note_stream_title(self, token: str, title: str | None) -> None:
        """Record the latest song title the relay read for this playback root.

        Ignored once the root is released or expired, so a stream still being
        relayed after its release cannot bring the entry back.
        """
        now = time.time()
        with self._lock:
            if self._live_root_locked(token, now) is None:
                return
            previous = self._now_playing.get(token)
            if previous is not None and previous[0] == title:
                self._now_playing.move_to_end(token)
                return
            if previous is None and title is None:
                return
            self._now_playing[token] = (title, now)
            self._now_playing.move_to_end(token)
            while len(self._now_playing) > MAX_NOW_PLAYING:
                self._now_playing.popitem(last=False)

    def now_playing(self, token: str) -> dict:
        """The latest song title of a live playback root; nothing if unknown, released or expired.

        The page polls this only while it plays the root, and one continuous
        relay connection makes no further requests, so a poll counts as use:
        it slides the lease exactly as get() does (_renew_live_locked), so the
        title, and the root a reconnect needs, outlive the first lease. A
        released or expired root is never revived.
        """
        now = time.time()
        with self._lock:
            self._prune_locked(now)
            if self._live_root_locked(token, now) is None:
                return {"title": None, "changed_at": None}
            self._renew_live_locked(token, now)
            record = self._now_playing.get(token)
            if record is None or record[0] is None:
                return {"title": None, "changed_at": None}
            return {"title": record[0], "changed_at": record[1]}

    def expire_item(self, item_id: str, *, grace_seconds: float = 5.0) -> None:
        deadline = time.time() + max(0.0, min(float(grace_seconds), 30.0))
        with self._lock:
            roots = {entry.root_token for entry in self._entries.values() if entry.item_id == item_id}
            self._expire_roots_locked(roots, deadline)

    def clear(self) -> None:
        with self._lock:
            self._entries.clear()
            self._child_index.clear()
            self._child_keys_by_token.clear()
            self._dash_templates.clear()
            self._dash_template_index.clear()
            self._dash_keys_by_token.clear()
            self._root_child_counts.clear()
            self._expiry_heap.clear()
            self._live_listed.clear()
            self._now_playing.clear()

    def _expire_roots_locked(self, roots: set[str], deadline: float) -> None:
        if not roots:
            return
        for root_token in roots:
            self._now_playing.pop(root_token, None)  # A released playback has no song.
        for registration in self._entries.values():
            if registration.token in roots:
                registration.released = True
            if registration.root_token not in roots or registration.expires_at <= deadline:
                continue
            registration.expires_at = deadline
            heapq.heappush(self._expiry_heap, (deadline, "entry", registration.token))
        for template_token, template in tuple(self._dash_templates.items()):
            if template.root_token not in roots or template.expires_at <= deadline:
                continue
            self._dash_templates[template_token] = replace(template, expires_at=deadline)
            heapq.heappush(self._expiry_heap, (deadline, "template", template_token))

    def _decrement_root_locked(self, root_token: str) -> None:
        remaining = self._root_child_counts.get(root_token, 0) - 1
        if remaining > 0:
            self._root_child_counts[root_token] = remaining
        else:
            self._root_child_counts.pop(root_token, None)

    def _remove_entry_locked(self, token: str) -> None:
        self._entries.pop(token, None)
        self._live_listed.pop(token, None)  # A root takes its live history with it.
        self._now_playing.pop(token, None)  # ...and its song title.
        key = self._child_keys_by_token.pop(token, None)
        if key:
            if self._child_index.get(key) == token:
                self._child_index.pop(key, None)
            self._decrement_root_locked(key[0])
            listed = self._live_listed.get(key[0])
            if listed is not None:
                listed.pop(token, None)
                if not listed:
                    del self._live_listed[key[0]]

    def _remove_template_locked(self, token: str) -> None:
        template = self._dash_templates.pop(token, None)
        key = self._dash_keys_by_token.pop(token, None)
        if key and self._dash_template_index.get(key) == token:
            self._dash_template_index.pop(key, None)
        if template:
            self._decrement_root_locked(template.root_token)

    def _prune_locked(self, now: float) -> None:
        while self._expiry_heap and self._expiry_heap[0][0] <= now:
            _expires_at, kind, token = heapq.heappop(self._expiry_heap)
            if kind == "entry":
                entry = self._entries.get(token)
                if entry and entry.expires_at <= now:
                    self._remove_entry_locked(token)
            else:
                template = self._dash_templates.get(token)
                if template and template.expires_at <= now:
                    self._remove_template_locked(token)


def _valid_dash_representation(value: str) -> bool:
    return bool(
        isinstance(value, str)
        and _DASH_SAFE_REPRESENTATION.fullmatch(value)
        and value not in {".", ".."}
        and ".." not in value
    )


def infer_media_type(url: str) -> str:
    path = urllib.parse.urlsplit(url).path.lower()
    if path.endswith(".m3u8"):
        return "hls"
    if path.endswith(".mpd"):
        return "dash"
    if path.endswith((".mp4", ".webm", ".mov", ".mkv", ".ts")):
        return "video"
    return "audio"


def is_live_hls_media_playlist(text: str) -> bool:
    """A media playlist that has not ended.

    A media playlist has an #EXTINF: or #EXT-X-TARGETDURATION: tag (the latter
    is required, so a live playlist with no segments yet still counts). It has
    ended once it carries #EXT-X-ENDLIST. #EXT-X-PLAYLIST-TYPE:VOD without
    ENDLIST is treated as not live: a VOD playlist never changes, so its entries
    keep the root's lifetime for seeking. Master playlists have neither tag.
    Tags are matched whole and, like the rest of this file, ignoring case.
    """
    names, values = set(), {}
    for line in text.splitlines():
        stripped = line.strip()
        if stripped.startswith("#"):
            name, colon, value = stripped.upper().partition(":")
            if colon:
                names.add(name + ":")
                values[name] = value.strip()
            else:
                names.add(name.split()[0])
    if not names & {"#EXTINF:", "#EXT-X-TARGETDURATION:"}:
        return False
    return "#EXT-X-ENDLIST" not in names and values.get("#EXT-X-PLAYLIST-TYPE") != "VOD"


def rewrite_hls_manifest(text: str, manifest_url: str, parent: MediaRegistration, registry: MediaRegistry) -> str:
    if not text.lstrip().startswith("#EXTM3U"):
        raise _media_error(HTTPStatus.BAD_GATEWAY, "INVALID_HLS_MANIFEST", "Upstream HLS manifest is invalid.")
    # Only a live media playlist slides; its resources may be evicted under pressure.
    live = is_live_hls_media_playlist(text)
    # One pass splits the text into literal pieces and the URLs it lists.
    pieces: list[str] = []
    url_pieces: list[int] = []
    for line in text.splitlines():
        stripped = line.strip()
        if stripped and not stripped.startswith("#"):
            url_pieces.append(len(pieces))
            pieces.append(urllib.parse.urljoin(manifest_url, stripped))
        elif "URI" in line.upper():
            start = 0
            for match in _URI_ATTRIBUTE.finditer(line):
                pieces.append(line[start:match.start()] + 'URI="')
                url_pieces.append(len(pieces))
                pieces.append(urllib.parse.urljoin(manifest_url, match.group(2) or match.group(3) or ""))
                pieces.append('"')
                start = match.end()
            pieces.append(line[start:])
        else:
            pieces.append(line)
        pieces.append("\n")
    # Each distinct URL is validated once, with one DNS lookup per host and port.
    targets = registry.connector.resolve_batch(pieces[index] for index in url_pieces)
    # All entries are added in one locked step, or none if the playlist cannot fit.
    children = registry.add_children(parent, targets, evictable=live)
    for index in url_pieces:
        pieces[index] = media_relay_path(children[pieces[index]])
    return "".join(pieces)


def rewrite_dash_manifest(text: str, manifest_url: str, parent: MediaRegistration, registry: MediaRegistry) -> bytes:
    """Rewrite every supported MPD resource through an opaque scoped relay."""

    if not isinstance(text, str) or len(text.encode("utf-8")) > MAX_MANIFEST_BYTES:
        raise _media_error(HTTPStatus.BAD_GATEWAY, "DASH_MANIFEST_TOO_LARGE", "DASH manifest is too large.")
    upper = text.upper()
    if "<!DOCTYPE" in upper or "<!ENTITY" in upper or "<?XML-STYLESHEET" in upper:
        raise _media_error(
            HTTPStatus.BAD_GATEWAY,
            "UNSAFE_DASH_XML",
            "DASH manifest contains unsupported XML declarations.",
        )
    try:
        root = ET.fromstring(text)
    except ET.ParseError:
        raise _media_error(HTTPStatus.BAD_GATEWAY, "INVALID_DASH_MANIFEST", "Upstream DASH manifest is invalid.") from None
    if _xml_local_name(root.tag) != "MPD":
        raise _media_error(HTTPStatus.BAD_GATEWAY, "INVALID_DASH_MANIFEST", "Upstream DASH manifest is invalid.")
    elements = list(root.iter())
    if len(elements) > 20_000:
        raise _media_error(HTTPStatus.BAD_GATEWAY, "DASH_MANIFEST_TOO_COMPLEX", "DASH manifest is too complex.")
    if any(_xml_local_name(element.tag) == "ContentProtection" for element in elements):
        raise _media_error(
            HTTPStatus.UNPROCESSABLE_ENTITY,
            "DASH_DRM_UNSUPPORTED",
            "DRM-protected DASH media is not supported.",
        )
    for element in elements:
        for name, value in element.attrib.items():
            if _xml_local_name(name) == "href" and "xlink" in name.lower():
                if value != "urn:mpeg:dash:resolve-to-zero:2013":
                    raise _media_error(
                        HTTPStatus.BAD_GATEWAY,
                        "DASH_XLINK_UNSUPPORTED",
                        "External DASH XLink resources are not supported.",
                    )
    original_base_text = {
        id(element): (element.text or "").strip()
        for element in elements if _xml_local_name(element.tag) == "BaseURL"
    }

    # Content steering can issue independent requests and mutate segment URLs.
    # Remove it so all network access stays within the audited MPD relay path.
    for element in list(root.iter()):
        for child in list(element):
            if _xml_local_name(child.tag) in {"ContentSteering", "PatchLocation", "Metrics"}:
                element.remove(child)

    def scope_values(scope: ET.Element) -> tuple[set[str], set[str]]:
        representations = [
            element for element in scope.iter() if _xml_local_name(element.tag) == "Representation"
        ]
        if len(representations) > MAX_DASH_REPRESENTATIONS:
            raise _media_error(
                HTTPStatus.BAD_GATEWAY,
                "DASH_MANIFEST_TOO_COMPLEX",
                "DASH manifest contains too many representations.",
            )
        ids = {
            element.attrib["id"] for element in representations
            if isinstance(element.attrib.get("id"), str) and element.attrib.get("id")
        }
        bandwidths = {
            element.attrib["bandwidth"] for element in representations
            if isinstance(element.attrib.get("bandwidth"), str) and element.attrib.get("bandwidth")
        }
        return ids, bandwidths

    def representation_bases(scope: ET.Element, scope_base: str) -> tuple[dict[str, str], bool]:
        result: dict[str, str] = {}
        unidentified_distinct = False

        def collect(element: ET.Element, inherited: str) -> None:
            nonlocal unidentified_distinct
            direct_bases = [
                child for child in list(element) if _xml_local_name(child.tag) == "BaseURL"
            ]
            current = inherited
            if direct_bases:
                raw = original_base_text.get(id(direct_bases[0]), "")
                if raw:
                    current = urllib.parse.urljoin(inherited, raw)
            if _xml_local_name(element.tag) == "Representation":
                representation_id = element.attrib.get("id") or ""
                if representation_id:
                    previous = result.get(representation_id)
                    if previous and previous != current:
                        raise _media_error(
                            HTTPStatus.BAD_GATEWAY,
                            "INVALID_DASH_REPRESENTATION",
                            "DASH representation identifiers must be unique.",
                        )
                    result[representation_id] = current
                elif current != scope_base:
                    unidentified_distinct = True
                return
            for child in list(element):
                if _xml_local_name(child.tag) not in {
                    "BaseURL", "SegmentTemplate", "SegmentList", "SegmentBase",
                }:
                    collect(child, current)

        if _xml_local_name(scope.tag) == "Representation":
            representation_id = scope.attrib.get("id") or ""
            if representation_id:
                result[representation_id] = scope_base
            return result, False
        for child in list(scope):
            if _xml_local_name(child.tag) not in {
                "BaseURL", "SegmentTemplate", "SegmentList", "SegmentBase",
            }:
                collect(child, scope_base)
        return result, unidentified_distinct

    # Nothing is registered during the walk: each reference is validated (and
    # each template resolved) and its write is recorded. The walk only ever
    # reads original values, so the writes can wait until everything has been
    # registered in one all-or-nothing step.
    child_urls: list[str] = []
    plans: list[_DashTemplatePlan] = []
    writes: list[tuple[Callable[[str], None], bool, int]] = []

    def set_text(element: ET.Element, value: str) -> None:
        element.text = value

    def rewrite_reference(
        raw: str,
        base_url: str,
        scope: ET.Element,
        write: Callable[[str], None],
        *,
        representation_scoped: bool = False,
    ) -> None:
        value = (raw or "").strip()
        if not value or len(value) > 8192 or re.search(r"[\r\n\0]", value):
            raise _media_error(HTTPStatus.BAD_GATEWAY, "INVALID_DASH_URL", "DASH resource URL is invalid.")
        absolute = urllib.parse.urljoin(base_url, value)
        representation_templates: dict[str, str] = {}
        if representation_scoped:
            base_map, unidentified_distinct = representation_bases(scope, base_url)
            if unidentified_distinct:
                raise _media_error(
                    HTTPStatus.BAD_GATEWAY,
                    "DASH_BASEURL_UNSUPPORTED",
                    "DASH representations with distinct base URLs require safe identifiers.",
                )
            representation_templates = {
                representation_id: urllib.parse.urljoin(representation_base, value)
                for representation_id, representation_base in base_map.items()
                if urllib.parse.urljoin(representation_base, value) != absolute
            }
        if _DASH_PLACEHOLDER.search(absolute) or "$$" in absolute or representation_templates:
            representation_ids, bandwidths = scope_values(scope)
            plans.append(registry.plan_dash_template(
                parent,
                absolute,
                representation_ids=representation_ids,
                bandwidths=bandwidths,
                representation_templates=representation_templates,
            ))
            writes.append((write, True, len(plans) - 1))
            return
        child_urls.append(absolute)
        writes.append((write, False, len(child_urls) - 1))

    def walk(element: ET.Element, inherited_base: str, scope: ET.Element, depth: int = 0) -> None:
        if depth > 64:
            raise _media_error(
                HTTPStatus.BAD_GATEWAY,
                "DASH_MANIFEST_TOO_COMPLEX",
                "DASH manifest nesting is too deep.",
            )
        children = list(element)
        base_children = [child for child in children if _xml_local_name(child.tag) == "BaseURL"]
        original_bases = [original_base_text.get(id(child), "") for child in base_children]
        element_base = inherited_base
        if original_bases and original_bases[0]:
            element_base = urllib.parse.urljoin(inherited_base, original_bases[0])

        local_name = _xml_local_name(element.tag)
        reference_scope = scope if local_name in _DASH_URL_ATTRIBUTES else element
        for attribute in _DASH_URL_ATTRIBUTES.get(local_name, ()):
            if attribute in element.attrib:
                rewrite_reference(
                    element.attrib[attribute],
                    element_base,
                    reference_scope,
                    functools.partial(element.set, attribute),
                    representation_scoped=local_name == "SegmentTemplate",
                )
        if local_name == "UTCTiming":
            scheme = (element.attrib.get("schemeIdUri") or "").lower()
            value = element.attrib.get("value") or ""
            if value.startswith(("http://", "https://")) or ":utc:http" in scheme:
                rewrite_reference(value, element_base, reference_scope, functools.partial(element.set, "value"))
        if local_name == "Location" and (element.text or "").strip():
            rewrite_reference(element.text or "", inherited_base, reference_scope, functools.partial(set_text, element))

        for base_child, original in zip(base_children, original_bases):
            if original:
                rewrite_reference(original, inherited_base, element, functools.partial(set_text, base_child))

        for child in list(element):
            if _xml_local_name(child.tag) == "BaseURL":
                continue
            child_scope = element if _xml_local_name(child.tag) in _DASH_URL_ATTRIBUTES else child
            walk(child, element_base, child_scope, depth + 1)

    walk(root, manifest_url, root)
    targets = registry.connector.resolve_batch(child_urls)
    namespace = root.tag[1:].split("}", 1)[0] if root.tag.startswith("{") else ""
    if namespace:
        ET.register_namespace("", namespace)

    def render(children: dict[str, MediaRegistration], templates: list[DashTemplateRegistration]) -> bytes:
        for write, is_template, index in writes:
            write(templates[index].relay_template() if is_template else media_relay_path(children[child_urls[index]]))
        rewritten = ET.tostring(root, encoding="utf-8", xml_declaration=True)
        if len(rewritten) > MAX_MANIFEST_BYTES:
            raise _media_error(HTTPStatus.BAD_GATEWAY, "DASH_MANIFEST_TOO_LARGE", "Rewritten DASH manifest is too large.")
        return rewritten

    # Everything is registered in one locked step, and only once the rewritten
    # manifest is built and within size: otherwise nothing is registered.
    return registry.add_dash_resources(parent, targets, plans, render)


def _xml_local_name(name: str) -> str:
    return name.rsplit("}", 1)[-1]
