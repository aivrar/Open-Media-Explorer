"""Pinned upstream connector plus opaque HLS and DASH media relays."""
from __future__ import annotations

import http.client
import heapq
import ipaddress
import re
import secrets
import socket
import ssl
import threading
import time
import urllib.parse
import xml.etree.ElementTree as ET
from dataclasses import dataclass, field, replace
from typing import Callable, Iterable, Mapping

from worldmedia_security import ApiError
from http import HTTPStatus


CONNECT_TIMEOUT = 8.0
HEADER_TIMEOUT = 12.0
IDLE_TIMEOUT = 15.0
MAX_REDIRECTS = 5
MAX_MANIFEST_BYTES = 2 * 1024 * 1024
MAX_REGISTRATIONS = 4096
DEFAULT_TTL_SECONDS = 6 * 60 * 60
RELAY_USER_AGENT = "WorldMediaWindows/0.1.2"
MAX_CHILDREN_PER_ROOT = 2048
MAX_DASH_REPRESENTATIONS = 256
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
    "if-modified-since": "If-Modified-Since",
    "if-none-match": "If-None-Match",
    "if-range": "If-Range",
    "range": "Range",
    "referer": "Referer",
    "user-agent": "User-Agent",
}
_RANGE = re.compile(r"^bytes=(?:\d+-\d*|-\d+)$")
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
    except (OSError, socket.gaierror):
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


class _PinnedHTTPConnection(http.client.HTTPConnection):
    def __init__(self, target: ResolvedTarget, timeout: float) -> None:
        super().__init__(target.host, target.port, timeout=timeout)
        self._selected_ip = target.ip

    def connect(self) -> None:
        self.sock = socket.create_connection((self._selected_ip, self.port), self.timeout)


class _PinnedHTTPSConnection(_PinnedHTTPConnection):
    def __init__(self, target: ResolvedTarget, timeout: float, context: ssl.SSLContext) -> None:
        super().__init__(target, timeout)
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

    def open(
        self,
        url: str,
        *,
        method: str = "GET",
        headers: Mapping[str, str] | None = None,
        body: bytes | None = None,
        cancel: threading.Event | None = None,
    ) -> Upstream:
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
            # DNS pinning prevents rebinding, but pinning only the first valid
            # address makes a multi-address CDN less reliable than a browser:
            # one retired edge turns a healthy channel into an immediate 502.
            # Every address was validated above, so retry each pinned address
            # without performing another DNS lookup.
            for selected_ip in target.addresses or (target.ip,):
                if cancel and cancel.is_set():
                    raise _media_error(HTTPStatus.REQUEST_TIMEOUT, "MEDIA_CANCELLED", "Media request was cancelled.")
                dial_target = target if selected_ip == target.ip else replace(target, ip=selected_ip)
                if target.scheme == "https":
                    connection = _PinnedHTTPSConnection(dial_target, self.connect_timeout, self.ssl_context)
                else:
                    connection = _PinnedHTTPConnection(dial_target, self.connect_timeout)
                try:
                    connection.putrequest(current_method, target.request_target, skip_host=True, skip_accept_encoding=True)
                    connection.putheader("Host", host_header)
                    if "Accept" not in current_headers:
                        connection.putheader("Accept", "*/*")
                    connection.putheader("Accept-Encoding", "identity")
                    if "User-Agent" not in current_headers:
                        connection.putheader("User-Agent", RELAY_USER_AGENT)
                    for name, value in current_headers.items():
                        connection.putheader(name, value)
                    if current_method == "POST":
                        connection.putheader("Content-Length", str(len(current_body or b"")))
                    connection.endheaders(current_body if current_method == "POST" else None)
                    if connection.sock:
                        connection.sock.settimeout(self.header_timeout)
                    response = connection.getresponse()
                    break
                except (OSError, TimeoutError, http.client.HTTPException):
                    connection.close()
                    connection = None
            if connection is None or response is None:
                raise _media_error(
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

    def relay_template(self) -> str:
        literals = dict(self.placeholder_literals)
        query = "&".join(
            f"{_DASH_QUERY_KEYS[name]}={literals[name]}" for name in self.placeholders
        )
        suffix = media_relay_suffix(self.url_template, "video")
        return f"/api/v1/dash/{self.token}{suffix}?{query}"


class MediaRegistry:
    def __init__(self, connector: SafeConnector | None = None, *, ttl_seconds: int = DEFAULT_TTL_SECONDS) -> None:
        self.connector = connector or SafeConnector()
        self.ttl_seconds = max(60, min(int(ttl_seconds), 24 * 60 * 60))
        self._entries: dict[str, MediaRegistration] = {}
        self._child_index: dict[tuple[str, str], str] = {}
        self._child_keys_by_token: dict[str, tuple[str, str]] = {}
        self._dash_templates: dict[str, DashTemplateRegistration] = {}
        self._dash_template_index: dict[tuple, str] = {}
        self._dash_keys_by_token: dict[str, tuple] = {}
        self._root_child_counts: dict[str, int] = {}
        self._expiry_heap: list[tuple[float, str, str]] = []
        self._lock = threading.RLock()

    def register(self, payload: object) -> MediaRegistration:
        if not isinstance(payload, dict):
            raise _media_error(HTTPStatus.BAD_REQUEST, "INVALID_MEDIA_REGISTRATION", "Media registration must be an object.")
        allowed = {
            "item_id", "url", "delivery", "media_type", "capture_headers",
            "title", "source", "download_name", "recording_kind",
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
            expires_at=now + min(24 * 60 * 60, self.ttl_seconds * (4 if delivery == "live" else 1)),
            root_token=token,
            title=title.strip(),
            source=source,
            download_name=download_name.strip(),
            recording_kind=recording_kind,
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
            return registration

    def child(self, parent: MediaRegistration, url: str, *, media_type: str | None = None) -> MediaRegistration:
        target = self.connector.resolve(url)
        key = (parent.root_token, target.url)
        with self._lock:
            now = time.time()
            self._prune_locked(now)
            if parent.root_token not in self._entries or parent.expires_at <= now:
                raise _media_error(HTTPStatus.NOT_FOUND, "MEDIA_TOKEN_EXPIRED", "Media relay token is invalid or expired.")
            existing = self._child_index.get(key)
            if existing and existing in self._entries:
                return self._entries[existing]
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
            token = secrets.token_urlsafe(32)
            child = MediaRegistration(
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
            )
            self._entries[token] = child
            self._child_index[key] = token
            self._child_keys_by_token[token] = key
            self._root_child_counts[parent.root_token] = root_children + 1
            heapq.heappush(self._expiry_heap, (child.expires_at, "entry", token))
            return child

    def dash_template(
        self,
        parent: MediaRegistration,
        url_template: str,
        *,
        representation_ids: Iterable[str] = (),
        bandwidths: Iterable[str] = (),
        representation_templates: Mapping[str, str] | None = None,
    ) -> DashTemplateRegistration:
        """Register one constrained DASH URL template without exposing it."""

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
        with self._lock:
            now = time.time()
            self._prune_locked(now)
            if parent.root_token not in self._entries or parent.expires_at <= now:
                raise _media_error(HTTPStatus.NOT_FOUND, "MEDIA_TOKEN_EXPIRED", "Media relay token is invalid or expired.")
            existing = self._dash_template_index.get(key)
            if existing and existing in self._dash_templates:
                return self._dash_templates[existing]
            child_count = self._root_child_counts.get(parent.root_token, 0)
            if child_count >= MAX_CHILDREN_PER_ROOT:
                raise _media_error(
                    HTTPStatus.BAD_GATEWAY,
                    "DASH_CHILD_LIMIT",
                    "DASH manifest contains too many resource templates.",
                )
            if len(self._entries) + len(self._dash_templates) >= MAX_REGISTRATIONS:
                raise _media_error(HTTPStatus.SERVICE_UNAVAILABLE, "MEDIA_REGISTRY_FULL", "Media relay is temporarily full.", True)
            token = secrets.token_urlsafe(32)
            entry = DashTemplateRegistration(
                token=token,
                root_token=parent.root_token,
                item_id=parent.item_id,
                url_template=target.url,
                placeholders=tuple(placeholders),
                placeholder_literals=literal_items,
                representation_templates=tuple(resolved_representation_templates),
                allowed_representation_ids=allowed_representations,
                allowed_bandwidths=allowed_bandwidths,
                headers=dict(parent.headers),
                expires_at=parent.expires_at,
                delivery=parent.delivery,
                title=parent.title,
                source=parent.source,
                recording_kind=parent.recording_kind,
            )
            self._dash_templates[token] = entry
            self._dash_template_index[key] = token
            self._dash_keys_by_token[token] = key
            self._root_child_counts[parent.root_token] = child_count + 1
            heapq.heappush(self._expiry_heap, (entry.expires_at, "template", token))
            return entry

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
        )

    def expire(self, token: str, *, grace_seconds: float = 0) -> None:
        deadline = time.time() + max(0.0, min(float(grace_seconds), 30.0))
        with self._lock:
            entry = self._entries.get(token)
            if not entry:
                return
            self._expire_roots_locked({entry.root_token}, deadline)

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

    def _expire_roots_locked(self, roots: set[str], deadline: float) -> None:
        if not roots:
            return
        for registration in self._entries.values():
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
        key = self._child_keys_by_token.pop(token, None)
        if key:
            if self._child_index.get(key) == token:
                self._child_index.pop(key, None)
            self._decrement_root_locked(key[0])

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


def rewrite_hls_manifest(text: str, manifest_url: str, parent: MediaRegistration, registry: MediaRegistry) -> str:
    if not text.lstrip().startswith("#EXTM3U"):
        raise _media_error(HTTPStatus.BAD_GATEWAY, "INVALID_HLS_MANIFEST", "Upstream HLS manifest is invalid.")
    output: list[str] = []
    for line in text.splitlines():
        stripped = line.strip()
        if stripped and not stripped.startswith("#"):
            absolute = urllib.parse.urljoin(manifest_url, stripped)
            child = registry.child(parent, absolute)
            output.append(media_relay_path(child))
            continue
        if "URI" in line.upper():
            def replace(match: re.Match) -> str:
                raw = match.group(2) or match.group(3) or ""
                absolute = urllib.parse.urljoin(manifest_url, raw)
                child = registry.child(parent, absolute)
                return f'URI="{media_relay_path(child)}"'
            line = _URI_ATTRIBUTE.sub(replace, line)
        output.append(line)
    return "\n".join(output) + "\n"


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

    def rewrite_reference(
        raw: str,
        base_url: str,
        scope: ET.Element,
        *,
        representation_scoped: bool = False,
    ) -> str:
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
            template = registry.dash_template(
                parent,
                absolute,
                representation_ids=representation_ids,
                bandwidths=bandwidths,
                representation_templates=representation_templates,
            )
            return template.relay_template()
        child = registry.child(parent, absolute)
        return media_relay_path(child)

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
                element.attrib[attribute] = rewrite_reference(
                    element.attrib[attribute],
                    element_base,
                    reference_scope,
                    representation_scoped=local_name == "SegmentTemplate",
                )
        if local_name == "UTCTiming":
            scheme = (element.attrib.get("schemeIdUri") or "").lower()
            value = element.attrib.get("value") or ""
            if value.startswith(("http://", "https://")) or ":utc:http" in scheme:
                element.attrib["value"] = rewrite_reference(value, element_base, reference_scope)
        if local_name == "Location" and (element.text or "").strip():
            element.text = rewrite_reference(element.text or "", inherited_base, reference_scope)

        for base_child, original in zip(base_children, original_bases):
            if original:
                base_child.text = rewrite_reference(original, inherited_base, element)

        for child in list(element):
            if _xml_local_name(child.tag) == "BaseURL":
                continue
            child_scope = element if _xml_local_name(child.tag) in _DASH_URL_ATTRIBUTES else child
            walk(child, element_base, child_scope, depth + 1)

    walk(root, manifest_url, root)
    namespace = root.tag[1:].split("}", 1)[0] if root.tag.startswith("{") else ""
    if namespace:
        ET.register_namespace("", namespace)
    rewritten = ET.tostring(root, encoding="utf-8", xml_declaration=True)
    if len(rewritten) > MAX_MANIFEST_BYTES:
        raise _media_error(HTTPStatus.BAD_GATEWAY, "DASH_MANIFEST_TOO_LARGE", "Rewritten DASH manifest is too large.")
    return rewritten


def _xml_local_name(name: str) -> str:
    return name.rsplit("}", 1)[-1]
