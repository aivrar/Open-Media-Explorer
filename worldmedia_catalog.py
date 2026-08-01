"""Hardened catalog resolvers, bounded caches, and opaque artwork relay.

All dynamic provider URLs cross this module instead of the generic metadata
proxy.  The boundary deliberately keeps browser profile data (favorites,
settings, and EQ state) outside its storage tree.
"""
from __future__ import annotations

import contextlib
import datetime as _datetime
import email.utils
import hashlib
import heapq
import html
import ipaddress
import json
import os
import re
import secrets
import struct
import tempfile
import threading
import time
import urllib.parse
import zlib
from dataclasses import dataclass
from html.parser import HTMLParser
from http import HTTPStatus
from pathlib import Path
from typing import Any, Callable, Iterable, Mapping

from defusedxml.ElementTree import fromstring as safe_xml_fromstring
from defusedxml.common import DefusedXmlException

from worldmedia_media import ResolvedTarget, SafeConnector
from worldmedia_security import ApiError


CATALOG_CACHE_VERSION = 1
ASSET_CACHE_VERSION = 1
MAX_CACHE_ENTRIES = 256
MAX_PROVIDER_CACHE_ENTRIES = 64
MAX_CACHE_ENTRY_BYTES = 2 * 1024 * 1024
MAX_CACHE_TOTAL_BYTES = 64 * 1024 * 1024
MAX_ASSET_REGISTRATIONS = 65_536
MAX_ASSET_ENTRIES = 512
MAX_ASSET_BYTES = 5 * 1024 * 1024
MAX_ASSET_TOTAL_BYTES = 256 * 1024 * 1024
MAX_IMAGE_DIMENSION = 8192
MAX_IMAGE_PIXELS = 40_000_000
MAX_XML_ELEMENTS = 10_000
MAX_XML_DEPTH = 64
MAX_XML_ATTRIBUTES = 50_000
MAX_XML_TEXT = 2 * 1024 * 1024
MAX_FEED_ITEMS = 1_000
MAX_OWNCAST_ITEMS = 5_000
MAX_UPSTREAM_SECONDS = 30.0
ASSET_TTL_SECONDS = 6 * 60 * 60

FIXED_METADATA_HOSTS = frozenset({
    "api.media.ccc.de",
    "media.ccc.de",
    "streaming.media.ccc.de",
    "www.loc.gov",
    "loc.gov",
    "gpodder.net",
    "www.gpodder.net",
    "sepiasearch.org",
    "directory.owncast.online",
    "owncast.directory",
})
OWNCAST_PLAYLIST_URL = "https://directory.owncast.online/api/iptv"
OWNCAST_HOME_URL = "https://owncast.directory/api/home"

_CACHE_FILE = re.compile(r"^[a-z0-9-]{1,64}-[0-9a-f]{64}\.json$")
_ASSET_FILE = re.compile(r"^[0-9a-f]{64}\.(?:json|bin)$")
_CATALOG_TEMP = re.compile(r"^\.catalog-[A-Za-z0-9_-]+\.tmp$")
_ASSET_TEMP = re.compile(r"^\.asset-[A-Za-z0-9_-]+\.tmp$")
_SOURCE_ID = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")
_UUID = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
    re.IGNORECASE,
)
_SENSITIVE_QUERY = re.compile(
    r"(?i)(?:^|[_-])(?:access|auth|credential|key|pass|password|secret|sig|signature|token)(?:$|[_-])"
)
_CONTROL = re.compile(r"[\x00-\x1f\x7f]")
_BIDI_CONTROL = re.compile(r"[\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]")
_LOCAL_PATH = re.compile(r"(?i)(?:[a-z]:[\\/](?:users|windows|programdata)|/(?:home|users|etc|proc|sys)/)")
_IPV4_TEXT = re.compile(r"(?<![0-9.])(?:\d{1,3}\.){3}\d{1,3}(?![0-9.])")
_ETAG = re.compile(r'^(?:W/)?"[^\x00-\x20"\x7f]{0,1000}"$')
_ALLOWED_IMAGE_TYPES = {
    "image/jpeg": "jpeg",
    "image/png": "png",
    "image/gif": "gif",
    "image/webp": "webp",
}
_PODCAST_NS = "https://podcastindex.org/namespace/1.0"
_ITUNES_NS = "http://www.itunes.com/dtds/podcast-1.0.dtd"
_ATOM_NS = "http://www.w3.org/2005/Atom"


class CatalogError(ApiError):
    """Safe public failure raised at the catalog boundary."""

    __slots__ = ("retry_after",)

    def __init__(
        self,
        status: int,
        code: str,
        message: str,
        retryable: bool = False,
        retry_after: int | None = None,
    ) -> None:
        super().__init__(status, code, message, retryable)
        self.retry_after = (
            max(0, min(int(retry_after), 24 * 60 * 60))
            if isinstance(retry_after, int) and not isinstance(retry_after, bool)
            else None
        )


def _error(
    status: int,
    code: str,
    message: str,
    retryable: bool = False,
    *,
    retry_after: int | None = None,
) -> CatalogError:
    return CatalogError(status, code, message, retryable, retry_after)


def canonical_http_url(value: str, *, trailing_slash: bool = False) -> str:
    """Return a deterministic HTTP(S) URL without credentials or a fragment."""

    if not isinstance(value, str):
        raise _error(HTTPStatus.BAD_REQUEST, "INVALID_CATALOG_URL", "Catalog URL is invalid.")
    value = value.strip()
    if not value or len(value) > 8192 or _CONTROL.search(value) or "\\" in value:
        raise _error(HTTPStatus.BAD_REQUEST, "INVALID_CATALOG_URL", "Catalog URL is invalid.")
    if re.search(r"%(?![0-9a-fA-F]{2})", value):
        raise _error(HTTPStatus.BAD_REQUEST, "INVALID_CATALOG_URL", "Catalog URL is invalid.")
    try:
        parsed = urllib.parse.urlsplit(value)
        port = parsed.port
    except (TypeError, ValueError):
        raise _error(HTTPStatus.BAD_REQUEST, "INVALID_CATALOG_URL", "Catalog URL is invalid.") from None
    scheme = parsed.scheme.lower()
    if scheme not in {"http", "https"}:
        raise _error(HTTPStatus.BAD_REQUEST, "UNSUPPORTED_CATALOG_SCHEME", "Catalog URL must use HTTP or HTTPS.")
    if parsed.username is not None or parsed.password is not None or "%" in parsed.netloc.rsplit("@", 1)[-1]:
        raise _error(HTTPStatus.BAD_REQUEST, "CATALOG_CREDENTIALS_REJECTED", "Credentials and encoded hosts are not allowed.")
    host = (parsed.hostname or "").rstrip(".").lower()
    if not host:
        raise _error(HTTPStatus.BAD_REQUEST, "INVALID_CATALOG_HOST", "Catalog host is missing.")
    try:
        ascii_host = host.encode("idna").decode("ascii")
    except UnicodeError:
        raise _error(HTTPStatus.BAD_REQUEST, "INVALID_CATALOG_HOST", "Catalog host is invalid.") from None
    try:
        ipaddress.ip_address(ascii_host.split("%", 1)[0])
        is_ip = True
    except ValueError:
        is_ip = False
    if not is_ip:
        labels = ascii_host.split(".")
        if (
            len(ascii_host) > 253
            or any(not label or len(label) > 63 for label in labels)
            or any(not re.fullmatch(r"[a-z0-9](?:[a-z0-9-]*[a-z0-9])?", label) for label in labels)
        ):
            raise _error(HTTPStatus.BAD_REQUEST, "INVALID_CATALOG_HOST", "Catalog host is invalid.")
    if port == 0:
        raise _error(HTTPStatus.BAD_REQUEST, "INVALID_CATALOG_PORT", "Catalog port is invalid.")
    default_port = 443 if scheme == "https" else 80
    display_host = f"[{ascii_host}]" if ":" in ascii_host else ascii_host
    netloc = display_host if not port or port == default_port else f"{display_host}:{port}"
    path = parsed.path or "/"
    if trailing_slash:
        path = path.rstrip("/") + "/"
    return urllib.parse.urlunsplit((scheme, netloc, path, parsed.query, ""))


def _origin(url: str) -> str:
    parsed = urllib.parse.urlsplit(canonical_http_url(url))
    return urllib.parse.urlunsplit((parsed.scheme, parsed.netloc, "", "", ""))


def _is_public_url_literal(url: str) -> bool:
    """Reject catalog-provided local/private literals before they reach UI state.

    Hostname DNS is still re-resolved and pinned by the native media/asset
    registries. This early check closes the obvious localhost and literal-IP
    cases without pretending that string validation replaces connect-time SSRF
    enforcement.
    """

    try:
        host = (urllib.parse.urlsplit(canonical_http_url(url)).hostname or "").rstrip(".").lower()
    except CatalogError:
        return False
    if not host or host == "localhost" or host.endswith((".localhost", ".local", ".internal")):
        return False
    try:
        return ipaddress.ip_address(host.split("%", 1)[0]).is_global
    except ValueError:
        return True


def _retry_after(value: str | None, now: float) -> int | None:
    if not value or len(value) > 128 or _CONTROL.search(value):
        return None
    value = value.strip()
    if value.isdecimal():
        return min(int(value), 24 * 60 * 60)
    try:
        parsed = email.utils.parsedate_to_datetime(value)
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=_datetime.timezone.utc)
        return max(0, min(int(parsed.timestamp() - now), 24 * 60 * 60))
    except (TypeError, ValueError, OverflowError):
        return None


def _safe_etag(value: str | None) -> str:
    value = (value or "").strip()
    return value if _ETAG.fullmatch(value) else ""


def _safe_last_modified(value: str | None) -> str:
    value = (value or "").strip()
    if not value or len(value) > 128 or _CONTROL.search(value):
        return ""
    try:
        parsed = email.utils.parsedate_to_datetime(value)
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=_datetime.timezone.utc)
        return email.utils.format_datetime(parsed.astimezone(_datetime.timezone.utc), usegmt=True)
    except (TypeError, ValueError, OverflowError):
        return ""


def _json_digest(value: Any) -> str:
    encoded = json.dumps(
        value,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
        allow_nan=False,
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _contains_sensitive_persistence(value: Any) -> bool:
    """Reject values that could place credentials or local details on disk."""

    if isinstance(value, dict):
        return any(_contains_sensitive_persistence(key) or _contains_sensitive_persistence(item) for key, item in value.items())
    if isinstance(value, (list, tuple)):
        return any(_contains_sensitive_persistence(item) for item in value)
    if not isinstance(value, str):
        return False
    lowered = value.lower()
    if any(marker in lowered for marker in (
        "x-worldmedia-token", "authorization:", "cookie:", "set-cookie:", "x-api-key",
        "file://", "\\appdata\\",
        "127.0.0.1", "169.254.169.254", "localhost", "[::1]",
    )):
        return True
    if _LOCAL_PATH.search(value):
        return True
    for candidate in _IPV4_TEXT.findall(value):
        try:
            if not ipaddress.ip_address(candidate).is_global:
                return True
        except ValueError:
            continue
    if lowered.startswith(("http://", "https://")):
        try:
            parsed = urllib.parse.urlsplit(value)
            if parsed.username is not None or parsed.password is not None:
                return True
            try:
                address = ipaddress.ip_address((parsed.hostname or "").split("%", 1)[0])
                if not address.is_global:
                    return True
            except ValueError:
                pass
            for name, _item in urllib.parse.parse_qsl(parsed.query, keep_blank_values=True, max_num_fields=128):
                if _SENSITIVE_QUERY.search(name):
                    return True
        except ValueError:
            return True
    return False


@dataclass(slots=True)
class CacheRecord:
    provider: str
    key_digest: str
    value: Any
    stored_at: float
    fresh_until: float
    validators: dict[str, dict[str, str]]

    def fresh(self, now: float) -> bool:
        return self.fresh_until > now


class CatalogCache:
    """Versioned JSON cache constrained to one dedicated native cache folder."""

    def __init__(
        self,
        cache_root: Path,
        *,
        clock: Any = time,
        max_entries: int = MAX_CACHE_ENTRIES,
        max_total_bytes: int = MAX_CACHE_TOTAL_BYTES,
        max_entry_bytes: int = MAX_CACHE_ENTRY_BYTES,
    ) -> None:
        self.cache_root = Path(cache_root).resolve()
        self.root = (self.cache_root / "catalog-v1").resolve()
        self.root.relative_to(self.cache_root)
        self.clock = clock
        self.max_entries = max(1, int(max_entries))
        self.max_total_bytes = max(1024, int(max_total_bytes))
        self.max_entry_bytes = max(1024, int(max_entry_bytes))
        self._lock = threading.RLock()
        self._entry_sizes: dict[str, tuple[int, str]] = {}
        self._total_bytes = 0
        self._available = False
        self._ensure_storage()

    def _ensure_storage(self) -> bool:
        """Open the optional cache without making app startup depend on disk space."""

        with self._lock:
            try:
                if self._available and self.root.is_dir() and not self.root.is_symlink():
                    return True
                self._available = False
                self.root.mkdir(parents=True, exist_ok=True)
                if self.root.is_symlink() or not self.root.is_dir():
                    return False
                self._cleanup_temps()
                self._prune_locked()
                self._available = True
                return True
            except OSError:
                self._available = False
                return False

    def _cleanup_temps(self) -> None:
        for path in self.root.iterdir():
            if path.is_file() and not path.is_symlink() and _CATALOG_TEMP.fullmatch(path.name):
                path.unlink(missing_ok=True)

    @staticmethod
    def _digest(key: str) -> str:
        return hashlib.sha256(key.encode("utf-8")).hexdigest()

    def _path(self, provider: str, key: str) -> Path:
        if not _SOURCE_ID.fullmatch(provider):
            raise ValueError("invalid cache provider")
        return self.root / f"{provider}-{self._digest(key)}.json"

    def _forget_locked(self, filename: str) -> None:
        previous = self._entry_sizes.pop(filename, None)
        if previous:
            self._total_bytes = max(0, self._total_bytes - previous[0])

    def get(self, provider: str, key: str) -> CacheRecord | None:
        path = self._path(provider, key)
        if not self._ensure_storage():
            return None
        with self._lock:
            if not path.is_file() or path.is_symlink():
                return None
            try:
                size = path.stat().st_size
                if size > self.max_entry_bytes:
                    raise ValueError("oversize cache record")
                with path.open("rb") as handle:
                    raw = handle.read(self.max_entry_bytes + 1)
                if len(raw) > self.max_entry_bytes:
                    raise ValueError("oversize cache record")
                payload = json.loads(raw.decode("utf-8"))
                expected = self._digest(key)
                if (
                    not isinstance(payload, dict)
                    or payload.get("version") != CATALOG_CACHE_VERSION
                    or payload.get("provider") != provider
                    or payload.get("key_digest") != expected
                    or not isinstance(payload.get("stored_at"), (int, float))
                    or not isinstance(payload.get("fresh_until"), (int, float))
                    or "value" not in payload
                    or payload.get("value_sha256") != _json_digest(payload["value"])
                ):
                    raise ValueError("invalid cache record")
                validators = payload.get("validators", {})
                if not isinstance(validators, dict):
                    raise ValueError("invalid validators")
                clean_validators: dict[str, dict[str, str]] = {}
                for slot, item in validators.items():
                    if not isinstance(slot, str) or not _SOURCE_ID.fullmatch(slot) or not isinstance(item, dict):
                        raise ValueError("invalid validators")
                    etag = _safe_etag(item.get("etag") if isinstance(item.get("etag"), str) else "")
                    modified = _safe_last_modified(item.get("last_modified") if isinstance(item.get("last_modified"), str) else "")
                    clean_validators[slot] = {"etag": etag, "last_modified": modified}
                previous = self._entry_sizes.get(path.name)
                self._total_bytes += size - (previous[0] if previous else 0)
                self._entry_sizes[path.name] = (size, provider)
                os.utime(path, None)
                return CacheRecord(
                    provider=provider,
                    key_digest=expected,
                    value=payload["value"],
                    stored_at=float(payload["stored_at"]),
                    fresh_until=float(payload["fresh_until"]),
                    validators=clean_validators,
                )
            except (OSError, UnicodeDecodeError, json.JSONDecodeError, TypeError, ValueError, RecursionError):
                with contextlib.suppress(OSError):
                    path.unlink(missing_ok=True)
                self._forget_locked(path.name)
                return None

    def put(
        self,
        provider: str,
        key: str,
        value: Any,
        *,
        ttl: float,
        validators: Mapping[str, Mapping[str, str]] | None = None,
    ) -> CacheRecord | None:
        if not self._ensure_storage():
            return None
        try:
            if _contains_sensitive_persistence(value):
                return None
        except RecursionError:
            return None
        now = float(self.clock.time())
        clean_validators: dict[str, dict[str, str]] = {}
        for slot, item in (validators or {}).items():
            if not isinstance(slot, str) or not _SOURCE_ID.fullmatch(slot):
                continue
            clean_validators[slot] = {
                "etag": _safe_etag(item.get("etag", "")),
                "last_modified": _safe_last_modified(item.get("last_modified", "")),
            }
        try:
            value_sha256 = _json_digest(value)
        except (TypeError, ValueError, RecursionError):
            return None
        record = {
            "version": CATALOG_CACHE_VERSION,
            "provider": provider,
            "key_digest": self._digest(key),
            "stored_at": now,
            "fresh_until": now + max(1.0, float(ttl)),
            "validators": clean_validators,
            "value_sha256": value_sha256,
            "value": value,
        }
        try:
            encoded = (json.dumps(record, ensure_ascii=False, separators=(",", ":"), allow_nan=False) + "\n").encode("utf-8")
        except (TypeError, ValueError, RecursionError):
            return None
        if len(encoded) > self.max_entry_bytes:
            return None
        path = self._path(provider, key)
        try:
            with self._lock:
                self._atomic_write(path, encoded)
                previous = self._entry_sizes.get(path.name)
                self._total_bytes += len(encoded) - (previous[0] if previous else 0)
                self._entry_sizes[path.name] = (len(encoded), provider)
                provider_count = sum(
                    1 for _size, entry_provider in self._entry_sizes.values()
                    if entry_provider == provider
                )
                if (len(self._entry_sizes) > self.max_entries
                        or self._total_bytes > self.max_total_bytes
                        or provider_count > MAX_PROVIDER_CACHE_ENTRIES):
                    self._prune_locked()
        except OSError:
            self._available = False
            return None
        return CacheRecord(provider, record["key_digest"], value, now, record["fresh_until"], clean_validators)

    def refresh(self, provider: str, key: str, *, ttl: float) -> CacheRecord | None:
        current = self.get(provider, key)
        if not current:
            return None
        return self.put(provider, key, current.value, ttl=ttl, validators=current.validators)

    def _atomic_write(self, path: Path, data: bytes) -> None:
        path.resolve().relative_to(self.root)
        descriptor, temporary_name = tempfile.mkstemp(prefix=".catalog-", suffix=".tmp", dir=self.root)
        temporary = Path(temporary_name)
        try:
            with os.fdopen(descriptor, "wb") as handle:
                descriptor = -1
                handle.write(data)
                handle.flush()
                # Catalog responses are validated disposable cache data. The
                # atomic replace is enough for readers; a power-loss fragment
                # is rejected by the stored digest on the next launch.
            os.replace(temporary, path)
        finally:
            if descriptor >= 0:
                with contextlib.suppress(OSError):
                    os.close(descriptor)
            temporary.unlink(missing_ok=True)

    def _prune_locked(self) -> None:
        candidates: list[tuple[float, int, Path, str]] = []
        for path in self.root.glob("*.json"):
            if path.is_symlink() or not _CACHE_FILE.fullmatch(path.name):
                continue
            try:
                stat = path.stat()
            except OSError:
                continue
            provider = path.name.rsplit("-", 1)[0]
            candidates.append((stat.st_mtime, stat.st_size, path, provider))
        provider_counts: dict[str, int] = {}
        keep: list[tuple[float, int, Path, str]] = []
        raw_provider_counts: dict[str, int] = {}
        for _mtime, _size, _path, provider in candidates:
            raw_provider_counts[provider] = raw_provider_counts.get(provider, 0) + 1
        for candidate in sorted(candidates, key=lambda item: item[0], reverse=True):
            provider = candidate[3]
            count = provider_counts.get(provider, 0)
            provider_limit = max(1, int(MAX_PROVIDER_CACHE_ENTRIES * 0.90)) \
                if raw_provider_counts[provider] > MAX_PROVIDER_CACHE_ENTRIES \
                else MAX_PROVIDER_CACHE_ENTRIES
            if count >= provider_limit:
                candidate[2].unlink(missing_ok=True)
                continue
            provider_counts[provider] = count + 1
            keep.append(candidate)
        total = sum(item[1] for item in keep)
        over_limit = len(keep) > self.max_entries or total > self.max_total_bytes
        target_entries = max(1, int(self.max_entries * 0.90)) if over_limit else self.max_entries
        target_bytes = max(1024, int(self.max_total_bytes * 0.90)) \
            if over_limit else self.max_total_bytes
        while len(keep) > target_entries or total > target_bytes:
            _mtime, size, path, _provider = keep.pop()
            path.unlink(missing_ok=True)
            total -= size
        self._entry_sizes = {
            path.name: (size, provider) for _mtime, size, path, provider in keep
        }
        self._total_bytes = total

    def clear(self) -> int:
        """Delete only recognized catalog records below this dedicated root."""

        removed = 0
        if not self._ensure_storage():
            return removed
        with self._lock:
            try:
                paths = list(self.root.iterdir())
            except OSError:
                self._available = False
                return removed
            for path in paths:
                if path.is_symlink() or not path.is_file() or not (
                    _CACHE_FILE.fullmatch(path.name) or _CATALOG_TEMP.fullmatch(path.name)
                ):
                    continue
                path.resolve().relative_to(self.root)
                try:
                    path.unlink(missing_ok=True)
                    removed += 1
                except OSError:
                    continue
            self._prune_locked()
        return removed


@dataclass(slots=True)
class Fetched:
    status: int
    data: bytes
    content_type: str
    url: str
    etag: str
    last_modified: str
    retry_after: int | None = None


class BoundedFetcher:
    def __init__(self, connector: Any, *, clock: Any = time, cancel: threading.Event | None = None) -> None:
        self.connector = connector
        self.clock = clock
        self.cancel = cancel

    def fetch(
        self,
        url: str,
        *,
        accept: str,
        allowed_types: Iterable[str],
        headers: Mapping[str, str] | None = None,
        max_compressed: int = 4 * 1024 * 1024,
        max_decoded: int = 8 * 1024 * 1024,
    ) -> Fetched:
        request_headers = {"Accept": accept, **dict(headers or {})}
        started = float(self.clock.monotonic())
        upstream = self.connector.open(url, method="GET", headers=request_headers, cancel=self.cancel)
        try:
            response = upstream.response
            status = int(response.status)
            content_type = (response.getheader("Content-Type", "") or "").split(";", 1)[0].strip().lower()
            etag = _safe_etag(response.getheader("ETag"))
            modified = _safe_last_modified(response.getheader("Last-Modified"))
            retry = _retry_after(response.getheader("Retry-After"), float(self.clock.time()))
            if status == HTTPStatus.NOT_MODIFIED:
                return Fetched(status, b"", content_type, upstream.url, etag, modified, retry)
            if status == HTTPStatus.TOO_MANY_REQUESTS:
                raise _error(
                    HTTPStatus.TOO_MANY_REQUESTS,
                    "CATALOG_RATE_LIMITED",
                    "Catalog source asked the app to retry later.",
                    True,
                    retry_after=retry,
                )
            if status < 200 or status >= 300:
                retryable = status >= 500 or status in {HTTPStatus.REQUEST_TIMEOUT, HTTPStatus.TOO_MANY_REQUESTS}
                raise _error(
                    HTTPStatus.BAD_GATEWAY,
                    "CATALOG_UPSTREAM_STATUS",
                    "Catalog source returned an unusable response.",
                    retryable,
                    retry_after=retry,
                )
            allowed = tuple(item.lower() for item in allowed_types)
            if not content_type or not any(content_type == item or (item.endswith("/*") and content_type.startswith(item[:-1])) for item in allowed):
                raise _error(HTTPStatus.BAD_GATEWAY, "CATALOG_CONTENT_TYPE", "Catalog source returned an unexpected content type.")
            length_value = response.getheader("Content-Length")
            if length_value:
                if not length_value.strip().isdecimal() or int(length_value) > max_compressed:
                    raise _error(HTTPStatus.BAD_GATEWAY, "CATALOG_BODY_TOO_LARGE", "Catalog response is too large.")
            encoding = (response.getheader("Content-Encoding", "identity") or "identity").strip().lower()
            if encoding not in {"identity", "gzip", "deflate"}:
                raise _error(HTTPStatus.BAD_GATEWAY, "CATALOG_ENCODING_UNSUPPORTED", "Catalog response encoding is unsupported.")
            decoder = None
            if encoding == "gzip":
                decoder = zlib.decompressobj(16 + zlib.MAX_WBITS)
            elif encoding == "deflate":
                decoder = zlib.decompressobj()
            compressed = 0
            decoded = bytearray()
            for chunk in upstream.iter_chunks(cancel=self.cancel):
                compressed += len(chunk)
                if compressed > max_compressed:
                    raise _error(HTTPStatus.BAD_GATEWAY, "CATALOG_BODY_TOO_LARGE", "Catalog response is too large.")
                if float(self.clock.monotonic()) - started > MAX_UPSTREAM_SECONDS:
                    raise _error(HTTPStatus.GATEWAY_TIMEOUT, "CATALOG_TOTAL_TIMEOUT", "Catalog source took too long to respond.", True)
                try:
                    output = decoder.decompress(chunk, max_decoded - len(decoded) + 1) if decoder else chunk
                except zlib.error:
                    raise _error(HTTPStatus.BAD_GATEWAY, "CATALOG_DECOMPRESSION_FAILED", "Catalog response compression is invalid.") from None
                decoded.extend(output)
                if len(decoded) > max_decoded or (decoder and decoder.unconsumed_tail):
                    raise _error(HTTPStatus.BAD_GATEWAY, "CATALOG_DECODED_TOO_LARGE", "Decoded catalog response is too large.")
            if decoder:
                try:
                    decoded.extend(decoder.flush(max_decoded - len(decoded) + 1))
                except zlib.error:
                    raise _error(HTTPStatus.BAD_GATEWAY, "CATALOG_DECOMPRESSION_FAILED", "Catalog response compression is invalid.") from None
                if len(decoded) > max_decoded or not decoder.eof:
                    raise _error(HTTPStatus.BAD_GATEWAY, "CATALOG_DECOMPRESSION_FAILED", "Catalog response compression is invalid.")
            return Fetched(status, bytes(decoded), content_type, upstream.url, etag, modified, retry)
        finally:
            upstream.close()


class _PlainText(HTMLParser):
    def __init__(self, limit: int) -> None:
        super().__init__(convert_charrefs=True)
        self.limit = limit
        self.parts: list[str] = []
        self.length = 0

    def handle_data(self, data: str) -> None:
        if self.length >= self.limit:
            return
        value = data[: self.limit - self.length]
        self.parts.append(value)
        self.length += len(value)


def bounded_text(value: Any, limit: int = 4096) -> str:
    parser = _PlainText(max(0, int(limit)))
    try:
        parser.feed(str(value or ""))
        parser.close()
    except (ValueError, RecursionError):
        return ""
    value = html.unescape(" ".join(parser.parts))
    value = _BIDI_CONTROL.sub("", value)
    characters: list[str] = []
    for char in value:
        if char.isspace():
            characters.append(" ")
        elif not _CONTROL.match(char):
            characters.append(char)
    value = "".join(characters)
    return re.sub(r"\s+", " ", value).strip()[:limit]


def podcast_identifier(value: Any, limit: int = 1024) -> str:
    """Normalize an identity without display-text/HTML transformations."""

    if not isinstance(value, str):
        return ""
    value = value.strip(" \t\r\n\f\v")
    if (
        not value
        or len(value) > max(1, int(limit))
        or _CONTROL.search(value)
        or _BIDI_CONTROL.search(value)
    ):
        return ""
    return value


def _local(tag: str) -> str:
    return tag.rsplit("}", 1)[-1] if isinstance(tag, str) else ""


def _namespace(tag: str) -> str:
    return tag[1:].split("}", 1)[0] if isinstance(tag, str) and tag.startswith("{") and "}" in tag else ""


def _element_text(element: Any, limit: int = 4096) -> str:
    if element is None:
        return ""
    parts: list[str] = []
    size = 0
    for value in element.itertext():
        if not isinstance(value, str):
            continue
        value = value[: max(0, limit - size)]
        parts.append(value)
        size += len(value)
        if size >= limit:
            break
    return bounded_text(" ".join(parts), limit)


def _identifier_text(element: Any, limit: int = 1024) -> str:
    if element is None:
        return ""
    parts: list[str] = []
    size = 0
    for value in element.itertext():
        if not isinstance(value, str):
            continue
        remaining = limit + 1 - size
        if remaining <= 0:
            break
        parts.append(value[:remaining])
        size += len(parts[-1])
    return podcast_identifier("".join(parts), limit)


def _children(element: Any, name: str, namespace: str | None = None) -> list[Any]:
    return [
        child for child in list(element)
        if _local(child.tag).lower() == name.lower()
        and (namespace is None or _namespace(child.tag) == namespace)
    ]


def _first(element: Any, name: str, namespace: str | None = None) -> Any | None:
    values = _children(element, name, namespace)
    return values[0] if values else None


def _is_itunes_namespace(value: str) -> bool:
    """Accept the deployed HTTP/HTTPS and case variants of Apple's namespace."""

    try:
        parsed = urllib.parse.urlsplit(value)
    except (TypeError, ValueError):
        return False
    return (
        parsed.scheme.lower() in {"http", "https"}
        and (parsed.hostname or "").rstrip(".").lower() in {"itunes.com", "www.itunes.com"}
        and parsed.path.rstrip("/").lower() == "/dtds/podcast-1.0.dtd"
        and not parsed.query
        and not parsed.fragment
    )


def _first_itunes(element: Any, name: str) -> Any | None:
    for child in list(element):
        if _local(child.tag).lower() == name.lower() and _is_itunes_namespace(_namespace(child.tag)):
            return child
    return None


def _optional_url(value: str, *, base: str = "") -> str:
    try:
        candidate = urllib.parse.urljoin(base, value.strip()) if base else value.strip()
        return canonical_http_url(candidate)
    except CatalogError:
        return ""


def _rating(value: str) -> str:
    normalized = bounded_text(value, 64).lower()
    if normalized in {"true", "yes", "explicit", "1"}:
        return "explicit"
    if normalized in {"false", "no", "clean", "not-explicit", "0"}:
        return "not-explicit"
    return "unrated"


def _date(value: str) -> str:
    value = bounded_text(value, 128)
    if not value:
        return ""
    try:
        parsed = email.utils.parsedate_to_datetime(value)
    except (TypeError, ValueError, OverflowError):
        try:
            parsed = _datetime.datetime.fromisoformat(value.replace("Z", "+00:00"))
        except (TypeError, ValueError, OverflowError):
            return ""
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=_datetime.timezone.utc)
    return parsed.astimezone(_datetime.timezone.utc).isoformat().replace("+00:00", "Z")


def _validate_xml_tree(root: Any) -> None:
    elements = 0
    attributes = 0
    text_size = 0
    stack = [(root, 1)]
    while stack:
        element, depth = stack.pop()
        elements += 1
        if elements > MAX_XML_ELEMENTS or depth > MAX_XML_DEPTH:
            raise _error(HTTPStatus.BAD_GATEWAY, "FEED_XML_TOO_COMPLEX", "Podcast feed XML is too complex.")
        tag = str(getattr(element, "tag", ""))
        if len(tag) > 512:
            raise _error(HTTPStatus.BAD_GATEWAY, "FEED_XML_TOO_COMPLEX", "Podcast feed XML is too complex.")
        values = getattr(element, "attrib", {})
        attributes += len(values)
        if len(values) > 32 or attributes > MAX_XML_ATTRIBUTES:
            raise _error(HTTPStatus.BAD_GATEWAY, "FEED_XML_TOO_COMPLEX", "Podcast feed XML is too complex.")
        for name, value in values.items():
            if len(str(name)) > 512 or len(str(value)) > 8192 or _CONTROL.search(str(value)):
                raise _error(HTTPStatus.BAD_GATEWAY, "FEED_XML_TOO_COMPLEX", "Podcast feed XML is too complex.")
        text_size += len(element.text or "") + len(element.tail or "")
        if text_size > MAX_XML_TEXT:
            raise _error(HTTPStatus.BAD_GATEWAY, "FEED_XML_TOO_COMPLEX", "Podcast feed XML is too complex.")
        stack.extend((child, depth + 1) for child in reversed(list(element)))


def _enclosure(
    url: str,
    mime: str,
    length: Any,
    *,
    base: str = "",
    relation: str = "enclosure",
    preferred: bool = False,
    codecs: str = "",
) -> dict[str, Any] | None:
    normalized_url = _optional_url(url, base=base)
    mime = bounded_text(mime, 128).lower()
    if not normalized_url:
        return None
    try:
        byte_length = int(length or 0)
    except (TypeError, ValueError):
        byte_length = 0
    byte_length = max(0, min(byte_length, 10**15))
    path = urllib.parse.urlsplit(normalized_url).path.lower()
    mime_base = mime.split(";", 1)[0].strip()
    if "mpegurl" in mime_base:
        mime_kind = "hls"
    elif mime_base in {"audio/mpeg", "audio/mp3"}:
        mime_kind = "audio"
    elif mime_base == "video/mp4":
        mime_kind = "video"
    elif not mime_base or mime_base in {"application/octet-stream", "binary/octet-stream"}:
        mime_kind = ""
    else:
        return None
    if path.endswith(".m3u8"):
        extension_kind = "hls"
    elif path.endswith(".mp3"):
        extension_kind = "audio"
    elif path.endswith(".mp4"):
        extension_kind = "video"
    elif path.endswith((
        ".aac", ".flac", ".m4a", ".m4v", ".mkv", ".mov", ".oga",
        ".ogg", ".opus", ".torrent", ".wav", ".webm",
    )):
        return None
    else:
        extension_kind = ""
    if mime_kind and extension_kind and mime_kind != extension_kind:
        return None
    kind = mime_kind or extension_kind
    if kind not in {"audio", "video", "hls"}:
        return None
    normalized_codecs = bounded_text(codecs, 256).lower()
    if normalized_codecs and re.search(r"\b(?:av01|flac|hev1|hvc1|opus|theora|vorbis|vp0?[89])\b", normalized_codecs):
        return None
    if kind == "video" and normalized_codecs and not re.search(r"(?:^|[ ,])(?:avc1|avc3|h264)(?:[., ]|$)", normalized_codecs):
        return None
    if kind == "audio" and normalized_codecs and not re.search(r"(?:^|[ ,])(?:mp3|mpga|mpeg)(?:[., ]|$)", normalized_codecs):
        return None
    return {
        "url": normalized_url,
        "type": mime_base,
        "length": byte_length,
        "kind": kind,
        "relation": relation,
        "default": bool(preferred),
        "codecs": normalized_codecs,
    }


def _rss_artwork(element: Any, base: str) -> str:
    image = _first_itunes(element, "image")
    if image is not None:
        value = image.attrib.get("href", "")
        if value:
            return _optional_url(value, base=base)
    image = _first(element, "image")
    if image is not None:
        url = _first(image, "url")
        if url is not None:
            return _optional_url(_element_text(url, 8192), base=base)
    return ""


def _rss_license(channel: Any, base: str) -> dict[str, str]:
    node = _first(channel, "license", _PODCAST_NS)
    if node is None:
        return {"label": "", "url": ""}
    url = _optional_url(node.attrib.get("url", ""), base=base)
    return {"label": _element_text(node, 256), "url": url}


def _rss_enclosures(item: Any, base: str) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    for node in _children(item, "enclosure"):
        value = _enclosure(
            node.attrib.get("url", ""), node.attrib.get("type", ""),
            node.attrib.get("length", 0), base=base,
        )
        if value:
            result.append(value)
    for alternate in _children(item, "alternateEnclosure", _PODCAST_NS):
        mime = alternate.attrib.get("type", "")
        length = alternate.attrib.get("length", 0)
        preferred = bounded_text(alternate.attrib.get("default", ""), 16).lower() in {"true", "yes", "1"}
        codecs = alternate.attrib.get("codecs", "")
        direct = alternate.attrib.get("uri", "") or alternate.attrib.get("url", "")
        if direct:
            value = _enclosure(
                direct, mime, length, base=base, relation="alternate",
                preferred=preferred, codecs=codecs,
            )
            if value:
                result.append(value)
        for source in _children(alternate, "source", _PODCAST_NS):
            source_type = source.attrib.get("contentType", "") or mime
            value = _enclosure(
                source.attrib.get("uri", ""), source_type, length,
                base=base, relation="alternate", preferred=preferred,
                codecs=codecs,
            )
            if value:
                result.append(value)
    deduped: list[dict[str, Any]] = []
    seen: set[str] = set()
    for value in result:
        if value["url"] not in seen:
            seen.add(value["url"])
            deduped.append(value)
        if len(deduped) >= 16:
            break
    return deduped


def parse_podcast_feed(data: bytes, feed_url: str) -> dict[str, Any]:
    if not isinstance(data, bytes) or not data:
        raise _error(HTTPStatus.BAD_GATEWAY, "FEED_EMPTY", "Podcast feed was empty.")
    upper = data[: min(len(data), 128 * 1024)].upper()
    if b"<!DOCTYPE" in upper or b"<!ENTITY" in upper or b"<?XML-STYLESHEET" in upper:
        raise _error(HTTPStatus.BAD_GATEWAY, "FEED_XML_UNSAFE", "Podcast feed contains unsafe XML declarations.")
    try:
        root = safe_xml_fromstring(data, forbid_dtd=True, forbid_entities=True, forbid_external=True)
    except DefusedXmlException:
        raise _error(HTTPStatus.BAD_GATEWAY, "FEED_XML_UNSAFE", "Podcast feed contains unsafe XML declarations.") from None
    except (ValueError, SyntaxError, RecursionError):
        raise _error(HTTPStatus.BAD_GATEWAY, "FEED_XML_INVALID", "Podcast feed XML is malformed.") from None
    _validate_xml_tree(root)
    base = canonical_http_url(feed_url)
    root_name = _local(root.tag).lower()
    if root_name == "rss":
        channel = _first(root, "channel")
        if channel is None:
            raise _error(HTTPStatus.BAD_GATEWAY, "FEED_SCHEMA_INVALID", "Podcast RSS channel is missing.")
        title = _element_text(_first(channel, "title"), 512)
        homepage = _optional_url(_element_text(_first(channel, "link"), 8192), base=base)
        language = _element_text(_first(channel, "language"), 64)
        description = _element_text(_first(channel, "description"), 8192)
        explicit_node = _first_itunes(channel, "explicit")
        feed_rating = _rating(_element_text(explicit_node, 64))
        artwork = _rss_artwork(channel, base)
        license_data = _rss_license(channel, base)
        # A long archive must not crowd a currently-live broadcast out of the
        # bounded 1,000-entry parser window. Pending/ended schedule records do
        # not consume that window; current live entries intentionally lead the
        # normalized result before ordinary archived episodes.
        live_entries = [
            item for item in _children(channel, "liveItem", _PODCAST_NS)
            if bounded_text(item.attrib.get("status", ""), 32).lower() == "live"
        ][:MAX_FEED_ITEMS]
        remaining = MAX_FEED_ITEMS - len(live_entries)
        entries: list[tuple[Any, bool]] = [(item, True) for item in live_entries]
        entries.extend((item, False) for item in _children(channel, "item")[:remaining])
        items: list[dict[str, Any]] = []
        for element, live in entries[:MAX_FEED_ITEMS]:
            # Pending and ended Podcasting 2.0 entries are schedule metadata,
            # not currently playable live media.
            if live and bounded_text(element.attrib.get("status", ""), 32).lower() != "live":
                continue
            enclosures = _rss_enclosures(element, base)
            if not enclosures:
                continue
            guid = _identifier_text(_first(element, "guid"), 1024) or enclosures[0]["url"]
            item_rating_node = _first_itunes(element, "explicit")
            item_rating = _rating(_element_text(item_rating_node, 64))
            effective_rating = item_rating if item_rating != "unrated" else feed_rating
            item_artwork = _rss_artwork(element, base) or artwork
            item_license = _rss_license(element, base)
            item = {
                "guid": guid,
                "title": _element_text(_first(element, "title"), 512) or title,
                "description": _element_text(_first(element, "description"), 8192),
                "published": _date(_element_text(_first(element, "pubDate"), 128)),
                "language": _element_text(_first(element, "language"), 64) or language,
                "content_rating": effective_rating,
                "episode_content_rating": item_rating,
                "artwork_url": item_artwork,
                "homepage_url": _optional_url(_element_text(_first(element, "link"), 8192), base=base) or homepage,
                "license": item_license if item_license["label"] else license_data,
                "enclosures": enclosures,
                "live": live,
            }
            if live:
                item["live_status"] = bounded_text(element.attrib.get("status", ""), 32).lower()
                item["start"] = _date(element.attrib.get("start", ""))
                item["end"] = _date(element.attrib.get("end", ""))
            items.append(item)
        if not title:
            raise _error(HTTPStatus.BAD_GATEWAY, "FEED_SCHEMA_INVALID", "Podcast feed title is missing.")
        return {
            "format": "rss",
            "feed_url": base,
            "title": title,
            "description": description,
            "language": language,
            "content_rating": feed_rating,
            "artwork_url": artwork,
            "homepage_url": homepage,
            "license": license_data,
            "items": items,
        }
    if root_name == "feed" and _namespace(root.tag) in {"", _ATOM_NS}:
        atom_namespace = _namespace(root.tag)
        title = _element_text(_first(root, "title", atom_namespace), 512)
        feed_id = _element_text(_first(root, "id", atom_namespace), 8192)
        language = bounded_text(root.attrib.get("{http://www.w3.org/XML/1998/namespace}lang", ""), 64)
        description = _element_text(_first(root, "subtitle", atom_namespace), 8192)
        feed_rating = _rating(_element_text(_first_itunes(root, "explicit"), 64))
        homepage = ""
        artwork = _optional_url(_element_text(_first(root, "logo", atom_namespace), 8192), base=base) or _rss_artwork(root, base)
        license_data = _rss_license(root, base)
        for link in _children(root, "link", atom_namespace):
            if link.attrib.get("rel", "alternate").lower() == "alternate":
                homepage = _optional_url(link.attrib.get("href", ""), base=base)
                if homepage:
                    break
        items: list[dict[str, Any]] = []
        for entry in _children(root, "entry", atom_namespace)[:MAX_FEED_ITEMS]:
            enclosures: list[dict[str, Any]] = []
            entry_home = ""
            for link in _children(entry, "link", atom_namespace):
                relation = link.attrib.get("rel", "alternate").lower()
                if relation == "enclosure":
                    value = _enclosure(
                        link.attrib.get("href", ""), link.attrib.get("type", ""),
                        link.attrib.get("length", 0), base=base,
                    )
                    if value:
                        enclosures.append(value)
                elif relation == "alternate" and not entry_home:
                    entry_home = _optional_url(link.attrib.get("href", ""), base=base)
            if not enclosures:
                continue
            guid = _identifier_text(_first(entry, "id", atom_namespace), 1024) or enclosures[0]["url"]
            summary = _first(entry, "summary", atom_namespace)
            if summary is None:
                summary = _first(entry, "content", atom_namespace)
            item_rating = _rating(_element_text(_first_itunes(entry, "explicit"), 64))
            effective_rating = item_rating if item_rating != "unrated" else feed_rating
            item_license = _rss_license(entry, base)
            items.append({
                "guid": guid,
                "title": _element_text(_first(entry, "title", atom_namespace), 512) or title,
                "description": _element_text(summary, 8192),
                "published": _date(_element_text(_first(entry, "published", atom_namespace), 128) or _element_text(_first(entry, "updated", atom_namespace), 128)),
                "language": bounded_text(entry.attrib.get("{http://www.w3.org/XML/1998/namespace}lang", ""), 64) or language,
                "content_rating": effective_rating,
                "episode_content_rating": item_rating,
                "artwork_url": _rss_artwork(entry, base) or artwork,
                "homepage_url": entry_home or homepage,
                "license": item_license if item_license["label"] else license_data,
                "enclosures": enclosures[:16],
                "live": False,
            })
        if not title:
            raise _error(HTTPStatus.BAD_GATEWAY, "FEED_SCHEMA_INVALID", "Podcast feed title is missing.")
        return {
            "format": "atom",
            "feed_url": base,
            "feed_id": feed_id,
            "title": title,
            "description": description,
            "language": language,
            "content_rating": feed_rating,
            "artwork_url": artwork,
            "homepage_url": homepage,
            "license": license_data,
            "items": items,
        }
    raise _error(HTTPStatus.BAD_GATEWAY, "FEED_SCHEMA_INVALID", "Podcast feed must be RSS 2.0 or Atom 1.0.")


def attach_podcast_identities(
    value: Mapping[str, Any],
    requested_url: str,
    resolved_url: str | None = None,
    *,
    identity_url: str | None = None,
) -> dict[str, Any]:
    """Attach deterministic feed/episode identities and redirect aliases.

    The final resolved feed URL is the default identity so an HTTP directory
    URL and its HTTPS redirect produce the same favorite/EQ key.  A prior
    cached identity can be supplied during refresh to keep a moved redirect
    stable for callers that continue using the original directory alias.
    """

    if not isinstance(value, Mapping):
        raise _error(HTTPStatus.BAD_GATEWAY, "FEED_SCHEMA_INVALID", "Podcast feed is malformed.")
    requested = canonical_http_url(requested_url)
    resolved = canonical_http_url(
        resolved_url
        or (value.get("resolved_feed_url") if isinstance(value.get("resolved_feed_url"), str) else "")
        or requested
    )
    try:
        identity = canonical_http_url(identity_url or "") if identity_url else resolved
    except CatalogError:
        identity = resolved

    aliases: list[str] = []
    # Current mandatory identities come first so a long redirect history can
    # never crowd the requested/resolved/stable identity out of the 8-entry
    # public contract.
    for candidate in [
        requested,
        resolved,
        identity,
        *(value.get("feed_aliases", []) if isinstance(value.get("feed_aliases"), list) else []),
    ]:
        if not isinstance(candidate, str):
            continue
        try:
            canonical = canonical_http_url(candidate)
        except CatalogError:
            continue
        if canonical not in aliases:
            aliases.append(canonical)
        if len(aliases) >= 8:
            break

    raw_items = value.get("items")
    if not isinstance(raw_items, list) or len(raw_items) > MAX_FEED_ITEMS:
        raise _error(HTTPStatus.BAD_GATEWAY, "FEED_SCHEMA_INVALID", "Podcast feed items are malformed.")
    items: list[dict[str, Any]] = []
    for raw in raw_items:
        if not isinstance(raw, Mapping):
            continue
        item = dict(raw)
        guid = podcast_identifier(item.get("guid"), 1024)
        enclosures = item.get("enclosures")
        if not guid and isinstance(enclosures, list) and enclosures:
            first = enclosures[0]
            if isinstance(first, Mapping):
                guid = podcast_identifier(first.get("url"), 8192)
        if not guid:
            continue
        item["guid"] = guid
        item["stable_id"] = hashlib.sha256(f"{identity}\n{guid}".encode("utf-8")).hexdigest()
        items.append(item)

    result = dict(value)
    result["feed_url"] = requested
    result["resolved_feed_url"] = resolved
    result["feed_identity_url"] = identity
    result["feed_aliases"] = aliases
    result["items"] = items
    return result


def parse_json_object(data: bytes, *, code: str = "CATALOG_JSON_INVALID") -> dict[str, Any]:
    try:
        value = json.loads(
            data.decode("utf-8"),
            parse_constant=lambda _value: (_ for _ in ()).throw(ValueError("non-finite number")),
        )
    except (UnicodeDecodeError, json.JSONDecodeError, ValueError, RecursionError):
        raise _error(HTTPStatus.BAD_GATEWAY, code, "Catalog JSON is malformed.") from None
    if not isinstance(value, dict):
        raise _error(HTTPStatus.BAD_GATEWAY, code, "Catalog JSON must be an object.")
    return value


def _integer(value: Any, *, minimum: int = 0, maximum: int = 10**15) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        return 0
    return max(minimum, min(value, maximum))


def _peertube_choice(value: Any, *, relation: str) -> dict[str, Any] | None:
    if not isinstance(value, dict):
        return None
    url_value = value.get("fileDownloadUrl") if relation == "download" else value.get("fileUrl")
    if not isinstance(url_value, str):
        return None
    url = _optional_url(url_value)
    if not url or not urllib.parse.urlsplit(url).path.lower().endswith(".mp4"):
        return None
    resolution = value.get("resolution")
    height = 0
    label = ""
    if isinstance(resolution, dict):
        height = _integer(resolution.get("id"), maximum=100_000)
        label = bounded_text(resolution.get("label"), 64)
    return {
        "url": url,
        "relation": relation,
        "height": height,
        "label": label,
        "size": _integer(value.get("size")),
    }


def normalize_peertube_detail(detail: Mapping[str, Any], watch_url: str, expected_uuid: str) -> dict[str, Any]:
    """Validate one exact-origin PeerTube detail response and choose media."""

    if not isinstance(detail, Mapping):
        raise _error(HTTPStatus.BAD_GATEWAY, "PEERTUBE_SCHEMA_INVALID", "PeerTube detail is malformed.")
    expected_uuid = expected_uuid.lower()
    if not _UUID.fullmatch(expected_uuid):
        raise _error(HTTPStatus.BAD_REQUEST, "PEERTUBE_UUID_INVALID", "PeerTube video UUID is invalid.")
    actual_uuid = detail.get("uuid")
    if not isinstance(actual_uuid, str) or actual_uuid.lower() != expected_uuid:
        raise _error(HTTPStatus.BAD_GATEWAY, "PEERTUBE_ID_MISMATCH", "PeerTube detail did not match the requested video.")
    expected_origin = _origin(watch_url)
    detail_url = detail.get("url")
    if not isinstance(detail_url, str):
        raise _error(HTTPStatus.BAD_GATEWAY, "PEERTUBE_SCHEMA_INVALID", "PeerTube detail URL is missing.")
    try:
        canonical_detail_url = canonical_http_url(detail_url)
    except CatalogError:
        raise _error(HTTPStatus.BAD_GATEWAY, "PEERTUBE_SCHEMA_INVALID", "PeerTube detail URL is invalid.") from None
    input_path = urllib.parse.unquote(urllib.parse.urlsplit(canonical_http_url(watch_url)).path)
    detail_path = urllib.parse.unquote(urllib.parse.urlsplit(canonical_detail_url).path)
    input_match = re.fullmatch(r"/(videos/watch|w)/([A-Za-z0-9_-]{8,64})/?", input_path)
    detail_match = re.fullmatch(r"/(videos/watch|w)/([A-Za-z0-9_-]{8,64})/?", detail_path)
    detail_identity_ok = False
    if detail_match:
        route, identifier = detail_match.groups()
        if route == "videos/watch":
            detail_identity_ok = identifier.lower() == expected_uuid
        elif _UUID.fullmatch(identifier):
            detail_identity_ok = identifier.lower() == expected_uuid
        elif input_match and input_match.groups() == detail_match.groups():
            detail_identity_ok = True
    if _origin(canonical_detail_url) != expected_origin or not detail_identity_ok:
        raise _error(HTTPStatus.BAD_GATEWAY, "PEERTUBE_ID_MISMATCH", "PeerTube detail did not match the requested origin.")
    privacy = detail.get("privacy")
    state = detail.get("state")
    if (
        not isinstance(privacy, Mapping)
        or isinstance(privacy.get("id"), bool)
        or privacy.get("id") != 1
    ):
        raise _error(HTTPStatus.UNPROCESSABLE_ENTITY, "PEERTUBE_NOT_PUBLIC", "PeerTube video is not public.")
    if (
        not isinstance(state, Mapping)
        or isinstance(state.get("id"), bool)
        or state.get("id") != 1
    ):
        raise _error(HTTPStatus.UNPROCESSABLE_ENTITY, "PEERTUBE_NOT_PUBLISHED", "PeerTube video is not published.")
    nsfw = detail.get("nsfw")
    if not isinstance(nsfw, bool):
        raise _error(HTTPStatus.BAD_GATEWAY, "PEERTUBE_RATING_INVALID", "PeerTube content rating is malformed.")
    nsfw_flags = detail.get("nsfwFlags", 0)
    if (
        isinstance(nsfw_flags, bool)
        or not isinstance(nsfw_flags, int)
        or nsfw_flags < 0
        or nsfw_flags > 7
        or (not nsfw and nsfw_flags != 0)
    ):
        raise _error(HTTPStatus.BAD_GATEWAY, "PEERTUBE_RATING_INVALID", "PeerTube content rating flags are malformed.")
    is_live = detail.get("isLive")
    if not isinstance(is_live, bool):
        raise _error(HTTPStatus.BAD_GATEWAY, "PEERTUBE_SCHEMA_INVALID", "PeerTube live state is malformed.")
    title = bounded_text(detail.get("name"), 512)
    if not title:
        raise _error(HTTPStatus.BAD_GATEWAY, "PEERTUBE_SCHEMA_INVALID", "PeerTube title is missing.")

    hls_choices: list[dict[str, Any]] = []
    file_choices: list[dict[str, Any]] = []
    download_choices: list[dict[str, Any]] = []
    playlists = detail.get("streamingPlaylists", [])
    files = detail.get("files", [])
    if not isinstance(playlists, list) or not isinstance(files, list):
        raise _error(HTTPStatus.BAD_GATEWAY, "PEERTUBE_SCHEMA_INVALID", "PeerTube media choices are malformed.")
    if len(playlists) > 64 or len(files) > 256:
        raise _error(HTTPStatus.BAD_GATEWAY, "PEERTUBE_SCHEMA_TOO_LARGE", "PeerTube detail has too many media choices.")
    for playlist in playlists:
        if not isinstance(playlist, dict):
            continue
        playlist_url = playlist.get("playlistUrl")
        if isinstance(playlist_url, str):
            normalized = _optional_url(playlist_url)
            if normalized and urllib.parse.urlsplit(normalized).path.lower().endswith(".m3u8"):
                hls_choices.append({"url": normalized, "relation": "hls"})
        playlist_files = playlist.get("files", [])
        if not isinstance(playlist_files, list):
            raise _error(HTTPStatus.BAD_GATEWAY, "PEERTUBE_SCHEMA_INVALID", "PeerTube playlist files are malformed.")
        if len(playlist_files) > 64:
            raise _error(HTTPStatus.BAD_GATEWAY, "PEERTUBE_SCHEMA_TOO_LARGE", "PeerTube playlist has too many media choices.")
        for value in playlist_files:
            choice = _peertube_choice(value, relation="play")
            if choice:
                file_choices.append(choice)
            choice = _peertube_choice(value, relation="download")
            if choice:
                download_choices.append(choice)
    for value in files:
        choice = _peertube_choice(value, relation="play")
        if choice:
            file_choices.append(choice)
        choice = _peertube_choice(value, relation="download")
        if choice:
            download_choices.append(choice)

    def dedupe(values: list[dict[str, Any]]) -> list[dict[str, Any]]:
        result: list[dict[str, Any]] = []
        seen: set[str] = set()
        for value in values:
            if value["url"] in seen:
                continue
            seen.add(value["url"])
            result.append(value)
        return result

    hls_choices = sorted(dedupe(hls_choices), key=lambda item: item["url"])
    file_choices = sorted(
        dedupe(file_choices),
        key=lambda item: (-item.get("height", 0), -item.get("size", 0), item["url"]),
    )
    download_choices = sorted(
        dedupe(download_choices),
        key=lambda item: (-item.get("height", 0), -item.get("size", 0), item["url"]),
    )
    # An active live broadcast is recordable only from a real adaptive live
    # playlist. A stale/static MP4 rendition must never be relabelled as live.
    playback_url = hls_choices[0]["url"] if hls_choices else (
        file_choices[0]["url"] if file_choices and not is_live else ""
    )
    download_permission = detail.get("downloadEnabled")
    if not isinstance(download_permission, bool):
        raise _error(HTTPStatus.BAD_GATEWAY, "PEERTUBE_SCHEMA_INVALID", "PeerTube download permission is malformed.")
    download_enabled = download_permission and not is_live
    download_url = download_choices[0]["url"] if download_enabled and download_choices else ""
    licence = detail.get("licence")
    licence_id: int | None = None
    licence_label = ""
    if licence is not None:
        if not isinstance(licence, Mapping):
            raise _error(HTTPStatus.BAD_GATEWAY, "PEERTUBE_SCHEMA_INVALID", "PeerTube license metadata is malformed.")
        raw_licence_id = licence.get("id")
        if raw_licence_id is None:
            if licence.get("label") is not None and not isinstance(licence.get("label"), str):
                raise _error(HTTPStatus.BAD_GATEWAY, "PEERTUBE_SCHEMA_INVALID", "PeerTube license metadata is malformed.")
        elif (
            isinstance(raw_licence_id, bool)
            or not isinstance(raw_licence_id, int)
            or not 1 <= raw_licence_id <= 9
        ):
            raise _error(HTTPStatus.BAD_GATEWAY, "PEERTUBE_SCHEMA_INVALID", "PeerTube license metadata is malformed.")
        else:
            licence_id = int(raw_licence_id)
            licence_label = bounded_text(licence.get("label"), 256)
            if licence_id == 9:
                licence_label = "All Rights Reserved"
    return {
        "provider": "peertube",
        "origin": expected_origin,
        "uuid": expected_uuid,
        "watch_url": canonical_detail_url,
        "title": title,
        "description": bounded_text(detail.get("description"), 8192),
        "content_rating": "explicit" if nsfw or nsfw_flags else "not-explicit",
        "nsfw_flags": nsfw_flags,
        "is_live": is_live,
        "delivery": "live" if is_live else "on-demand",
        "media_type": "hls" if hls_choices else "video",
        "recording_kind": "video",
        "playback_url": playback_url,
        "download_url": download_url,
        "download_enabled": bool(download_url),
        "download_permission": download_permission,
        "hls_choices": hls_choices,
        "file_choices": file_choices[:64],
        "download_choices": download_choices[:64] if download_enabled else [],
        "license": licence_label,
        "license_id": licence_id,
    }


def _split_unquoted(value: str, separator: str = ",") -> list[str]:
    result: list[str] = []
    start = 0
    quoted = False
    escaped = False
    for index, char in enumerate(value):
        if escaped:
            escaped = False
            continue
        if char == "\\" and quoted:
            escaped = True
            continue
        if char == '"':
            quoted = not quoted
        elif char == separator and not quoted:
            result.append(value[start:index])
            start = index + 1
    result.append(value[start:])
    return result


def _m3u_metadata(value: str) -> tuple[dict[str, str], str]:
    attributes: dict[str, str] = {}
    matches = list(re.finditer(r"(?is)([a-z0-9-]{1,64})\s*=\s*\"((?:[^\"\\]|\\.)*)\"", value))
    for match in matches:
        raw = match.group(2).replace("\\\"", '"').replace("\\\\", "\\")
        attributes[match.group(1).lower()] = bounded_text(raw, 2048)
    if matches:
        remainder = value[matches[-1].end():].lstrip()
        title = bounded_text(remainder[1:] if remainder.startswith(",") else remainder, 512)
    else:
        parts = _split_unquoted(value)
        title = bounded_text(",".join(parts[1:]), 512) if len(parts) > 1 else ""
    return attributes, title


def _m3u_quotes_balanced(value: str) -> bool:
    quoted = False
    escaped = False
    for char in value:
        if escaped:
            escaped = False
        elif char == "\\" and quoted:
            escaped = True
        elif char == '"':
            quoted = not quoted
    return not quoted


def parse_owncast_playlist(data: bytes) -> list[dict[str, Any]]:
    try:
        text = data.decode("utf-8-sig")
    except UnicodeDecodeError:
        raise _error(HTTPStatus.BAD_GATEWAY, "OWNCAST_PLAYLIST_INVALID", "Owncast playlist is not UTF-8.") from None
    if not text.lstrip().startswith("#EXTM3U"):
        raise _error(HTTPStatus.BAD_GATEWAY, "OWNCAST_PLAYLIST_INVALID", "Owncast playlist header is invalid.")
    physical = text.splitlines()
    if len(physical) > 20_000 or any(len(line) > 16_384 for line in physical):
        raise _error(HTTPStatus.BAD_GATEWAY, "OWNCAST_PLAYLIST_TOO_LARGE", "Owncast playlist is too complex.")
    result: list[dict[str, Any]] = []
    index = 0
    while index < len(physical):
        line = physical[index].strip()
        index += 1
        if not line.upper().startswith("#EXTINF:"):
            continue
        metadata = line.split(":", 1)[1]
        continuation_count = 0
        while not _m3u_quotes_balanced(metadata) and index < len(physical) and continuation_count < 8:
            if physical[index].lstrip().upper().startswith("#EXTINF:"):
                break
            metadata += "\n" + physical[index]
            index += 1
            continuation_count += 1
        if not _m3u_quotes_balanced(metadata):
            continue
        uri = ""
        while index < len(physical):
            candidate = physical[index].strip()
            index += 1
            if not candidate:
                continue
            if candidate.upper().startswith("#EXTINF:"):
                index -= 1
                break
            if candidate.startswith("#"):
                continue
            uri = candidate
            break
        if not uri:
            continue
        try:
            stream_url = canonical_http_url(uri)
        except CatalogError:
            continue
        if not _is_public_url_literal(stream_url):
            continue
        if not urllib.parse.urlsplit(stream_url).path.lower().endswith(".m3u8"):
            continue
        attributes, title = _m3u_metadata(metadata)
        instance = _origin(stream_url) + "/"
        logo = _optional_url(attributes.get("tvg-logo", ""), base=instance)
        tags = [bounded_text(item, 64) for item in attributes.get("tvg-tags", "").split(",")]
        result.append({
            "instance_url": instance,
            "stream_url": stream_url,
            "name": attributes.get("tvg-id") or title,
            "title": title or attributes.get("tvg-id", ""),
            "logo_url": logo,
            "tags": [item for item in tags if item][:16],
        })
        if len(result) >= MAX_OWNCAST_ITEMS:
            break
    return result


def parse_owncast_home(data: bytes) -> dict[str, dict[str, Any]]:
    payload = parse_json_object(data, code="OWNCAST_DIRECTORY_INVALID")
    sections = payload.get("sections")
    if not isinstance(sections, list) or len(sections) > 256:
        raise _error(HTTPStatus.BAD_GATEWAY, "OWNCAST_DIRECTORY_INVALID", "Owncast rating directory is malformed.")
    result: dict[str, dict[str, Any]] = {}
    candidates: list[Any] = []
    featured = payload.get("featured")
    if isinstance(featured, dict):
        candidates.append(featured)
    for section in sections:
        if len(candidates) >= MAX_OWNCAST_ITEMS:
            break
        if not isinstance(section, dict):
            continue
        instances = section.get("instances", [])
        if isinstance(instances, list):
            candidates.extend(instances[:MAX_OWNCAST_ITEMS - len(candidates)])
    for item in candidates[:MAX_OWNCAST_ITEMS]:
        if not isinstance(item, dict) or not isinstance(item.get("nsfw"), bool) or not isinstance(item.get("url"), str):
            continue
        try:
            base = canonical_http_url(item["url"], trailing_slash=True)
        except CatalogError:
            continue
        if not _is_public_url_literal(base):
            continue
        parsed = urllib.parse.urlsplit(base)
        base = urllib.parse.urlunsplit((parsed.scheme, parsed.netloc, "/", "", ""))
        tags = item.get("tags", [])
        normalized_tags: list[str] = []
        seen_tags: set[str] = set()
        if isinstance(tags, list):
            # The directory has used both plain strings and current
            # `{name, slug}` objects. Only the bounded display name matters;
            # malformed objects are metadata loss, never a rating bypass.
            for raw_tag in tags[:64]:
                candidate = raw_tag if isinstance(raw_tag, str) else (
                    raw_tag.get("name", "") if isinstance(raw_tag, dict) else ""
                )
                tag = bounded_text(candidate, 64)
                key = tag.casefold()
                if not tag or key in seen_tags:
                    continue
                seen_tags.add(key)
                normalized_tags.append(tag)
                if len(normalized_tags) >= 16:
                    break
        existing = result.get(base)
        if existing and existing.get("nsfw") != item["nsfw"]:
            raise _error(
                HTTPStatus.BAD_GATEWAY,
                "OWNCAST_RATING_CONFLICT",
                "Owncast rating metadata contains conflicting entries.",
            )
        result[base] = {
            "instance_url": base,
            "name": bounded_text(item.get("name"), 512),
            "description": bounded_text(item.get("description"), 8192),
            "stream_title": bounded_text(item.get("streamTitle"), 512),
            "content_rating": "explicit" if item["nsfw"] else "not-explicit",
            "nsfw": item["nsfw"],
            "tags": normalized_tags,
            "logo_url": _optional_url(item.get("logo", ""), base=base) if isinstance(item.get("logo"), str) else "",
            "last_seen": _date(item.get("lastSeen", "")) if isinstance(item.get("lastSeen"), str) else "",
            "streaming_since": _date(item.get("streamingSince", "")) if isinstance(item.get("streamingSince"), str) else "",
        }
    if not result:
        raise _error(HTTPStatus.BAD_GATEWAY, "OWNCAST_RATINGS_MISSING", "Owncast rating metadata is unavailable.", True)
    return result


def normalize_owncast_snapshot(playlist_data: bytes, home_data: bytes) -> dict[str, Any]:
    playlist = parse_owncast_playlist(playlist_data)
    ratings = parse_owncast_home(home_data)
    items: list[dict[str, Any]] = []
    seen: set[str] = set()
    for stream in playlist:
        rating = ratings.get(stream["instance_url"])
        if not rating or stream["instance_url"] in seen:
            continue
        seen.add(stream["instance_url"])
        merged = {
            **rating,
            "stream_url": stream["stream_url"],
            "name": rating["name"] or stream["name"] or stream["title"],
            "stream_title": rating["stream_title"] or stream["title"],
            "logo_url": rating["logo_url"] or stream["logo_url"],
            "tags": list(dict.fromkeys([*rating["tags"], *stream["tags"]]))[:16],
            "delivery": "live",
            "media_type": "hls",
            "recording_kind": "video",
        }
        items.append(merged)
    return {"provider": "owncast", "items": items}


@dataclass(slots=True)
class AssetBlob:
    data: bytes
    content_type: str
    width: int
    height: int
    etag: str
    fresh_until: float


def validate_image(data: bytes, content_type: str) -> tuple[int, int]:
    """Validate MIME, magic, dimensions, and decoded pixel budget."""

    media_type = (content_type or "").split(";", 1)[0].strip().lower()
    expected = _ALLOWED_IMAGE_TYPES.get(media_type)
    if not expected or not isinstance(data, bytes) or not data or len(data) > MAX_ASSET_BYTES:
        raise _error(HTTPStatus.BAD_GATEWAY, "ASSET_TYPE_REJECTED", "Artwork response is not a supported image.")
    kind = ""
    width = height = 0
    if data.startswith(b"\x89PNG\r\n\x1a\n") and len(data) >= 24 and data[12:16] == b"IHDR":
        kind = "png"
        offset = 8
        chunks = 0
        saw_header = False
        saw_data = False
        saw_end = False
        while offset + 12 <= len(data) and chunks < 10_000:
            length = int.from_bytes(data[offset:offset + 4], "big")
            chunk_type = data[offset + 4:offset + 8]
            end = offset + 12 + length
            if length > MAX_ASSET_BYTES or end > len(data) or not re.fullmatch(rb"[A-Za-z]{4}", chunk_type):
                break
            chunk_data = data[offset + 8:offset + 8 + length]
            expected_crc = int.from_bytes(data[offset + 8 + length:end], "big")
            if zlib.crc32(chunk_type + chunk_data) & 0xFFFFFFFF != expected_crc:
                break
            if chunks == 0:
                if chunk_type != b"IHDR" or length != 13:
                    break
                width, height = struct.unpack(">II", chunk_data[:8])
                saw_header = True
            elif chunk_type == b"IDAT":
                saw_data = True
            if chunk_type == b"IEND":
                saw_end = saw_data and length == 0 and end == len(data)
                offset = end
                break
            offset = end
            chunks += 1
        if not saw_header or not saw_data or not saw_end:
            width = height = 0
    elif data[:6] in {b"GIF87a", b"GIF89a"} and len(data) >= 10:
        kind = "gif"
        width, height = struct.unpack("<HH", data[6:10])
        if data[-1:] != b"\x3b":
            width = height = 0
    elif data.startswith(b"\xff\xd8"):
        kind = "jpeg"
        index = 2
        while index + 4 <= len(data):
            if data[index] != 0xFF:
                index += 1
                continue
            while index < len(data) and data[index] == 0xFF:
                index += 1
            if index >= len(data):
                break
            marker = data[index]
            index += 1
            if marker in {0xD8, 0xD9} or 0xD0 <= marker <= 0xD7:
                continue
            if index + 2 > len(data):
                break
            segment_length = int.from_bytes(data[index:index + 2], "big")
            if segment_length < 2 or index + segment_length > len(data):
                break
            if marker in {0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF}:
                if segment_length < 7:
                    break
                height = int.from_bytes(data[index + 3:index + 5], "big")
                width = int.from_bytes(data[index + 5:index + 7], "big")
                break
            index += segment_length
        if not data.endswith(b"\xff\xd9"):
            width = height = 0
    elif len(data) >= 30 and data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        kind = "webp"
        if int.from_bytes(data[4:8], "little") + 8 != len(data):
            kind = ""
        chunk = data[12:16]
        if chunk == b"VP8X" and len(data) >= 30:
            width = 1 + int.from_bytes(data[24:27], "little")
            height = 1 + int.from_bytes(data[27:30], "little")
        elif chunk == b"VP8L" and len(data) >= 25 and data[20] == 0x2F:
            bits = int.from_bytes(data[21:25], "little")
            width = 1 + (bits & 0x3FFF)
            height = 1 + ((bits >> 14) & 0x3FFF)
        elif chunk == b"VP8 " and len(data) >= 30 and data[23:26] == b"\x9d\x01\x2a":
            width = int.from_bytes(data[26:28], "little") & 0x3FFF
            height = int.from_bytes(data[28:30], "little") & 0x3FFF
    if kind != expected or width <= 0 or height <= 0:
        raise _error(HTTPStatus.BAD_GATEWAY, "ASSET_MAGIC_MISMATCH", "Artwork MIME and image bytes do not match.")
    if width > MAX_IMAGE_DIMENSION or height > MAX_IMAGE_DIMENSION or width * height > MAX_IMAGE_PIXELS:
        raise _error(HTTPStatus.BAD_GATEWAY, "ASSET_DIMENSIONS_REJECTED", "Artwork dimensions are too large.")
    return width, height


class AssetCache:
    """Bounded binary cache stored only under native cache/assets-v1."""

    def __init__(
        self,
        cache_root: Path,
        *,
        clock: Any = time,
        max_entries: int = MAX_ASSET_ENTRIES,
        max_total_bytes: int = MAX_ASSET_TOTAL_BYTES,
    ) -> None:
        self.cache_root = Path(cache_root).resolve()
        self.root = (self.cache_root / "assets-v1").resolve()
        self.root.relative_to(self.cache_root)
        self.clock = clock
        self.max_entries = max(1, int(max_entries))
        self.max_total_bytes = max(MAX_ASSET_BYTES, int(max_total_bytes))
        self._lock = threading.RLock()
        self._entry_sizes: dict[str, int] = {}
        self._total_bytes = 0
        self._available = False
        self._ensure_storage()

    def _ensure_storage(self) -> bool:
        """Open/prune the optional asset cache, degrading safely if unavailable."""

        with self._lock:
            try:
                if self._available and self.root.is_dir() and not self.root.is_symlink():
                    return True
                self._available = False
                self.root.mkdir(parents=True, exist_ok=True)
                if self.root.is_symlink() or not self.root.is_dir():
                    return False
                self._cleanup_temps()
                self._prune_locked()
                self._available = True
                return True
            except OSError:
                self._available = False
                return False

    def _cleanup_temps(self) -> None:
        for path in self.root.iterdir():
            if path.is_file() and not path.is_symlink() and _ASSET_TEMP.fullmatch(path.name):
                path.unlink(missing_ok=True)

    @staticmethod
    def _key(url: str) -> str:
        return hashlib.sha256(url.encode("utf-8")).hexdigest()

    def _paths(self, url: str) -> tuple[Path, Path]:
        digest = self._key(url)
        return self.root / f"{digest}.json", self.root / f"{digest}.bin"

    def _delete_pair(self, meta: Path, binary: Path) -> None:
        meta.unlink(missing_ok=True)
        binary.unlink(missing_ok=True)

    def _forget_locked(self, digest: str) -> None:
        self._total_bytes = max(0, self._total_bytes - self._entry_sizes.pop(digest, 0))

    def get(self, url: str) -> AssetBlob | None:
        meta, binary = self._paths(url)
        if not self._ensure_storage():
            return None
        now = float(self.clock.time())
        with self._lock:
            if any(path.is_symlink() for path in (meta, binary)) or not meta.is_file() or not binary.is_file():
                return None
            try:
                meta_size = meta.stat().st_size
                binary_size = binary.stat().st_size
                if meta_size > 16 * 1024 or binary_size > MAX_ASSET_BYTES:
                    raise ValueError("oversize asset cache")
                payload = json.loads(meta.read_text(encoding="utf-8"))
                with binary.open("rb") as handle:
                    data = handle.read(MAX_ASSET_BYTES + 1)
                if len(data) > MAX_ASSET_BYTES:
                    raise ValueError("oversize asset cache")
                content_sha256 = hashlib.sha256(data).hexdigest()
                if (
                    not isinstance(payload, dict)
                    or payload.get("version") != ASSET_CACHE_VERSION
                    or payload.get("key_digest") != self._key(url)
                    or payload.get("content_sha256") != content_sha256
                    or payload.get("size") != len(data)
                    or payload.get("etag") != '"' + content_sha256 + '"'
                    or not isinstance(payload.get("fresh_until"), (int, float))
                    or float(payload["fresh_until"]) <= now
                ):
                    raise ValueError("invalid asset cache")
                content_type = payload.get("content_type")
                if content_type not in _ALLOWED_IMAGE_TYPES:
                    raise ValueError("invalid asset type")
                width, height = validate_image(data, content_type)
                if width != payload.get("width") or height != payload.get("height"):
                    raise ValueError("invalid asset dimensions")
                digest = self._key(url)
                size = meta_size + binary_size
                self._total_bytes += size - self._entry_sizes.get(digest, 0)
                self._entry_sizes[digest] = size
                os.utime(meta, None)
                os.utime(binary, None)
                return AssetBlob(data, content_type, width, height, payload["etag"], float(payload["fresh_until"]))
            except (OSError, UnicodeDecodeError, json.JSONDecodeError, TypeError, ValueError, CatalogError):
                with contextlib.suppress(OSError):
                    self._delete_pair(meta, binary)
                self._forget_locked(self._key(url))
                return None

    def put(self, url: str, data: bytes, content_type: str, *, ttl: float) -> AssetBlob:
        width, height = validate_image(data, content_type)
        if not self._ensure_storage():
            raise OSError("asset cache is unavailable")
        now = float(self.clock.time())
        content_sha256 = hashlib.sha256(data).hexdigest()
        etag = '"' + content_sha256 + '"'
        meta, binary = self._paths(url)
        payload = {
            "version": ASSET_CACHE_VERSION,
            "key_digest": self._key(url),
            "content_sha256": content_sha256,
            "content_type": content_type,
            "width": width,
            "height": height,
            "size": len(data),
            "etag": etag,
            "stored_at": now,
            "fresh_until": now + max(1.0, float(ttl)),
        }
        encoded = (json.dumps(payload, separators=(",", ":"), allow_nan=False) + "\n").encode("utf-8")
        try:
            with self._lock:
                digest = self._key(url)
                self._atomic_write(binary, data)
                try:
                    self._atomic_write(meta, encoded)
                except Exception:
                    self._delete_pair(meta, binary)
                    self._forget_locked(digest)
                    raise
                size = len(data) + len(encoded)
                self._total_bytes += size - self._entry_sizes.get(digest, 0)
                self._entry_sizes[digest] = size
                if len(self._entry_sizes) > self.max_entries or self._total_bytes > self.max_total_bytes:
                    self._prune_locked()
        except OSError:
            self._available = False
            raise
        return AssetBlob(data, content_type, width, height, etag, payload["fresh_until"])

    def _atomic_write(self, path: Path, data: bytes) -> None:
        path.resolve().relative_to(self.root)
        descriptor, temporary_name = tempfile.mkstemp(prefix=".asset-", suffix=".tmp", dir=self.root)
        temporary = Path(temporary_name)
        try:
            with os.fdopen(descriptor, "wb") as handle:
                descriptor = -1
                handle.write(data)
                handle.flush()
                # Artwork is a disposable cache, not user data. Atomic replace
                # protects readers; forcing two physical disk flushes per image
                # only delays the visible thumbnail and serializes the relay.
            os.replace(temporary, path)
        finally:
            if descriptor >= 0:
                with contextlib.suppress(OSError):
                    os.close(descriptor)
            temporary.unlink(missing_ok=True)

    def _prune_locked(self) -> None:
        entries: list[tuple[float, int, Path, Path]] = []
        for meta in self.root.glob("*.json"):
            if meta.is_symlink() or not _ASSET_FILE.fullmatch(meta.name):
                continue
            binary = meta.with_suffix(".bin")
            if binary.is_symlink() or not binary.is_file():
                meta.unlink(missing_ok=True)
                continue
            try:
                stat = meta.stat()
                size = stat.st_size + binary.stat().st_size
            except OSError:
                continue
            entries.append((stat.st_mtime, size, meta, binary))
        total = sum(entry[1] for entry in entries)
        entries.sort(key=lambda entry: entry[0], reverse=True)
        over_limit = len(entries) > self.max_entries or total > self.max_total_bytes
        target_entries = max(1, int(self.max_entries * 0.90)) if over_limit else self.max_entries
        target_bytes = max(MAX_ASSET_BYTES, int(self.max_total_bytes * 0.90)) \
            if over_limit else self.max_total_bytes
        # Prune with hysteresis so a full long-running cache does not rescan
        # and sort the directory again for every single newly viewed image.
        while len(entries) > target_entries or total > target_bytes:
            _mtime, size, meta, binary = entries.pop()
            self._delete_pair(meta, binary)
            total -= size
        known = {path for entry in entries for path in entry[2:]}
        for path in self.root.iterdir():
            if path in known or path.is_symlink() or not path.is_file() or not _ASSET_FILE.fullmatch(path.name):
                continue
            # Orphaned recognized cache files are safe to remove; unrelated files
            # are never touched.
            path.unlink(missing_ok=True)
        self._entry_sizes = {meta.stem: size for _mtime, size, meta, _binary in entries}
        self._total_bytes = total

    def clear(self) -> int:
        removed = 0
        if not self._ensure_storage():
            return removed
        with self._lock:
            try:
                paths = list(self.root.iterdir())
            except OSError:
                self._available = False
                return removed
            for path in paths:
                if path.is_symlink() or not path.is_file() or not (
                    _ASSET_FILE.fullmatch(path.name) or _ASSET_TEMP.fullmatch(path.name)
                ):
                    continue
                path.resolve().relative_to(self.root)
                try:
                    path.unlink(missing_ok=True)
                    removed += 1
                except OSError:
                    continue
            self._prune_locked()
        return removed


@dataclass(slots=True)
class AssetRegistration:
    token: str
    url: str
    source_id: str
    item_id: str
    expires_at: float

    @property
    def scope(self) -> tuple[str, str]:
        return self.source_id, self.item_id

    def public_data(self) -> dict[str, Any]:
        return {
            "asset_id": self.token,
            "relay_url": f"/api/v1/assets/{self.token}",
            "expires_at": self.expires_at,
        }


class _KeyLocks:
    def __init__(self) -> None:
        self._guard = threading.Lock()
        self._values: dict[str, tuple[threading.Lock, int]] = {}

    class _Lease:
        def __init__(self, owner: "_KeyLocks", key: str, lock: threading.Lock) -> None:
            self.owner = owner
            self.key = key
            self.lock = lock

        def __enter__(self):
            self.lock.acquire()
            return self

        def __exit__(self, _type, _value, _traceback):
            self.lock.release()
            with self.owner._guard:
                current = self.owner._values.get(self.key)
                if current and current[0] is self.lock:
                    if current[1] <= 1:
                        self.owner._values.pop(self.key, None)
                    else:
                        self.owner._values[self.key] = (self.lock, current[1] - 1)

    def lease(self, key: str) -> "_KeyLocks._Lease":
        with self._guard:
            lock, count = self._values.get(key, (threading.Lock(), 0))
            self._values[key] = (lock, count + 1)
        return self._Lease(self, key, lock)


class AssetRegistry:
    def __init__(
        self,
        cache_root: Path,
        *,
        connector: Any | None = None,
        clock: Any = time,
        ttl_seconds: float = ASSET_TTL_SECONDS,
        cache: AssetCache | None = None,
    ) -> None:
        self.connector = connector or SafeConnector()
        self.clock = clock
        self.ttl_seconds = max(60.0, min(float(ttl_seconds), 24 * 60 * 60))
        self.cache = cache or AssetCache(cache_root, clock=clock)
        self._cancel = threading.Event()
        self._lock = threading.RLock()
        self._condition = threading.Condition(self._lock)
        self._active = 0
        self._entries: dict[str, AssetRegistration] = {}
        self._index: dict[tuple[str, str, str], str] = {}
        self._expiry_heap: list[tuple[float, str]] = []
        self._fetch_locks = _KeyLocks()
        self._closed = False
        self._cache_epoch = 0

    def register(self, payload: Mapping[str, Any]) -> AssetRegistration:
        if not isinstance(payload, Mapping) or set(payload) != {"url", "source_id", "item_id"}:
            raise _error(HTTPStatus.BAD_REQUEST, "INVALID_ASSET_REQUEST", "Artwork registration requires URL, source ID, and item ID only.")
        url = payload.get("url")
        source_id = payload.get("source_id")
        item_id = payload.get("item_id")
        if not isinstance(source_id, str) or not _SOURCE_ID.fullmatch(source_id):
            raise _error(HTTPStatus.BAD_REQUEST, "INVALID_ASSET_SCOPE", "Artwork source scope is invalid.")
        if not isinstance(item_id, str) or not item_id.strip() or len(item_id) > 512 or _CONTROL.search(item_id):
            raise _error(HTTPStatus.BAD_REQUEST, "INVALID_ASSET_SCOPE", "Artwork item scope is invalid.")
        canonical = canonical_http_url(url)
        # Resolve at registration so rejected/private targets never become
        # apparently valid opaque URLs.
        self.connector.resolve(canonical)
        now = float(self.clock.time())
        key = (source_id, item_id, canonical)
        with self._lock:
            if self._closed:
                raise _error(HTTPStatus.SERVICE_UNAVAILABLE, "ASSET_SERVICE_STOPPED", "Artwork service is stopping.", True)
            self._prune_locked(now)
            existing = self._index.get(key)
            if existing and existing in self._entries:
                return self._entries[existing]
            if len(self._entries) >= MAX_ASSET_REGISTRATIONS:
                raise _error(HTTPStatus.SERVICE_UNAVAILABLE, "ASSET_REGISTRY_FULL", "Artwork relay is temporarily full.", True)
            token = secrets.token_urlsafe(32)
            registration = AssetRegistration(token, canonical, source_id, item_id.strip(), now + self.ttl_seconds)
            self._entries[token] = registration
            self._index[key] = token
            heapq.heappush(self._expiry_heap, (registration.expires_at, token))
            return registration

    def get(self, token: str, *, source_id: str | None = None, item_id: str | None = None) -> AssetRegistration:
        now = float(self.clock.time())
        with self._lock:
            self._prune_locked(now)
            registration = self._entries.get(token)
            if not registration or registration.expires_at <= now:
                raise _error(HTTPStatus.NOT_FOUND, "ASSET_TOKEN_EXPIRED", "Artwork relay token is invalid or expired.")
            if source_id is not None and (source_id, item_id) != registration.scope:
                raise _error(HTTPStatus.FORBIDDEN, "ASSET_SCOPE_MISMATCH", "Artwork relay scope does not match.")
            return registration

    @contextlib.contextmanager
    def _operation(self):
        with self._condition:
            if self._closed:
                raise _error(HTTPStatus.SERVICE_UNAVAILABLE, "ASSET_SERVICE_STOPPED", "Artwork service is stopping.", True)
            self._active += 1
        try:
            yield
        finally:
            with self._condition:
                self._active -= 1
                self._condition.notify_all()

    def read(self, token: str) -> AssetBlob:
        with self._operation():
            return self._read(token)

    def _read(self, token: str) -> AssetBlob:
        registration = self.get(token)
        cached = self.cache.get(registration.url)
        if cached:
            return cached
        with self._fetch_locks.lease(registration.url):
            registration = self.get(token)
            cached = self.cache.get(registration.url)
            if cached:
                return cached
            with self._lock:
                if self._closed:
                    raise _error(HTTPStatus.SERVICE_UNAVAILABLE, "ASSET_SERVICE_STOPPED", "Artwork service is stopping.", True)
                cache_epoch = self._cache_epoch
            fetched = BoundedFetcher(self.connector, clock=self.clock, cancel=self._cancel).fetch(
                registration.url,
                accept="image/webp,image/png,image/jpeg,image/gif;q=0.9",
                allowed_types=_ALLOWED_IMAGE_TYPES,
                max_compressed=MAX_ASSET_BYTES,
                max_decoded=MAX_ASSET_BYTES,
            )
            content_type = fetched.content_type
            width, height = validate_image(fetched.data, content_type)
            with self._lock:
                if cache_epoch != self._cache_epoch or self._closed:
                    etag = '"' + hashlib.sha256(fetched.data).hexdigest() + '"'
                    return AssetBlob(
                        fetched.data,
                        content_type,
                        width,
                        height,
                        etag,
                        float(self.clock.time()) + self.ttl_seconds,
                    )
                try:
                    return self.cache.put(registration.url, fetched.data, content_type, ttl=self.ttl_seconds)
                except OSError:
                    etag = '"' + hashlib.sha256(fetched.data).hexdigest() + '"'
                    return AssetBlob(
                        fetched.data,
                        content_type,
                        width,
                        height,
                        etag,
                        float(self.clock.time()) + self.ttl_seconds,
                    )

    def expire(self, token: str, payload: Mapping[str, Any]) -> None:
        if not isinstance(payload, Mapping) or set(payload) != {"source_id", "item_id"}:
            raise _error(HTTPStatus.BAD_REQUEST, "INVALID_ASSET_EXPIRY", "Artwork expiry requires its exact scope.")
        registration = self.get(token, source_id=payload.get("source_id"), item_id=payload.get("item_id"))
        with self._lock:
            self._entries.pop(registration.token, None)
            self._index.pop((registration.source_id, registration.item_id, registration.url), None)

    def expire_item(self, source_id: str, item_id: str) -> None:
        with self._lock:
            tokens = [token for token, value in self._entries.items() if value.scope == (source_id, item_id)]
            for token in tokens:
                value = self._entries.pop(token)
                self._index.pop((value.source_id, value.item_id, value.url), None)

    def _prune_locked(self, now: float) -> None:
        while self._expiry_heap and self._expiry_heap[0][0] <= now:
            _expires_at, token = heapq.heappop(self._expiry_heap)
            value = self._entries.get(token)
            if not value or value.expires_at > now:
                continue
            self._entries.pop(token, None)
            self._index.pop((value.source_id, value.item_id, value.url), None)

    def clear_registrations(self) -> int:
        with self._lock:
            count = len(self._entries)
            self._entries.clear()
            self._index.clear()
            self._expiry_heap.clear()
            return count

    def clear_cache(self) -> int:
        with self._lock:
            self._cache_epoch += 1
            return self.cache.clear()

    def shutdown(self, timeout: float = 5.0) -> bool:
        deadline = time.monotonic() + max(0.0, float(timeout))
        with self._condition:
            self._closed = True
            self._cache_epoch += 1
            self._cancel.set()
            self._entries.clear()
            self._index.clear()
            self._expiry_heap.clear()
            while self._active:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    return False
                self._condition.wait(min(remaining, 0.1))
            return True


def _clone_connector(connector: Any, policy: Callable[[ResolvedTarget], bool]) -> Any:
    """Clone the production connector so its redirect checks use *policy*."""

    if isinstance(connector, SafeConnector):
        previous = connector.target_policy

        def combined(target: ResolvedTarget) -> bool:
            return (previous(target) if previous else True) and policy(target)

        return SafeConnector(
            resolver=connector.resolver,
            address_policy=connector.address_policy,
            ssl_context=connector.ssl_context,
            connect_timeout=connector.connect_timeout,
            header_timeout=connector.header_timeout,
            idle_timeout=connector.idle_timeout,
            target_policy=combined,
        )
    factory = getattr(connector, "with_target_policy", None)
    if callable(factory):
        return factory(policy)
    # Test connectors may already model redirects.  Resolve the initial target
    # here; production never reaches this fallback because it is SafeConnector.
    target = connector.resolve

    class Checked:
        def resolve(self, url: str):
            resolved = target(url)
            if not policy(resolved):
                raise _error(HTTPStatus.FORBIDDEN, "CATALOG_TARGET_REJECTED", "Catalog target is not approved.")
            return resolved

        def open(self, url: str, **kwargs):
            self.resolve(url)
            return connector.open(url, **kwargs)

    return Checked()


def _exact_target(origin: str) -> Callable[[ResolvedTarget], bool]:
    parsed = urllib.parse.urlsplit(origin)

    def policy(target: ResolvedTarget) -> bool:
        return target.scheme == parsed.scheme and target.host == parsed.hostname and target.port == (parsed.port or (443 if parsed.scheme == "https" else 80))

    return policy


def _fixed_url_target(urls: Iterable[str]) -> Callable[[ResolvedTarget], bool]:
    approved = frozenset(canonical_http_url(url) for url in urls)
    return lambda target: canonical_http_url(target.url) in approved


class CatalogService:
    """Coalesced, cached resolver service used by authenticated localhost APIs."""

    def __init__(
        self,
        cache_root: Path,
        *,
        connector: Any | None = None,
        clock: Any = time,
        cache: CatalogCache | None = None,
    ) -> None:
        self.connector = connector or SafeConnector()
        self.clock = clock
        self.cache = cache or CatalogCache(cache_root, clock=clock)
        self._cancel = threading.Event()
        self._locks = _KeyLocks()
        self._state_lock = threading.RLock()
        self._condition = threading.Condition(self._state_lock)
        self._active = 0
        self._closed = False
        self._cache_epoch = 0
        self._owncast_empty_confirmations = 0

    @staticmethod
    def _conditional(record: CacheRecord | None, slot: str = "primary") -> dict[str, str]:
        if not record:
            return {}
        validators = record.validators.get(slot, {})
        result: dict[str, str] = {}
        if validators.get("etag"):
            result["If-None-Match"] = validators["etag"]
        if validators.get("last_modified"):
            result["If-Modified-Since"] = validators["last_modified"]
        return result

    @staticmethod
    def _validators(fetched: Fetched) -> dict[str, str]:
        return {"etag": fetched.etag, "last_modified": fetched.last_modified}

    def _check_open(self) -> None:
        with self._state_lock:
            if self._closed:
                raise _error(HTTPStatus.SERVICE_UNAVAILABLE, "CATALOG_SERVICE_STOPPED", "Catalog service is stopping.", True)

    @contextlib.contextmanager
    def _operation(self):
        with self._condition:
            self._check_open()
            self._active += 1
        try:
            yield
        finally:
            with self._condition:
                self._active -= 1
                self._condition.notify_all()

    def _epoch(self) -> int:
        with self._state_lock:
            self._check_open()
            return self._cache_epoch

    def _put_if_current(self, epoch: int, *args, **kwargs) -> CacheRecord | None:
        with self._state_lock:
            if self._closed or epoch != self._cache_epoch:
                return None
            return self.cache.put(*args, **kwargs)

    def _refresh_if_current(self, epoch: int, *args, **kwargs) -> CacheRecord | None:
        with self._state_lock:
            if self._closed or epoch != self._cache_epoch:
                return None
            return self.cache.refresh(*args, **kwargs)

    def _result(self, value: Any, state: str, *, reason: str = "") -> Any:
        if not isinstance(value, dict):
            return value
        result = dict(value)
        result["cache"] = {"state": state, "stale": state == "stale"}
        if reason:
            result["cache"]["reason"] = reason[:64]
        return result

    def _stale_or_raise(self, record: CacheRecord | None, error: Exception) -> Any:
        if record is not None:
            code = error.code if isinstance(error, ApiError) else "CATALOG_REFRESH_FAILED"
            return self._result(record.value, "stale", reason=code)
        raise error

    def resolve_feed(self, payload: Mapping[str, Any]) -> dict[str, Any]:
        with self._operation():
            return self._resolve_feed(payload)

    def _resolve_feed(self, payload: Mapping[str, Any]) -> dict[str, Any]:
        if not isinstance(payload, Mapping) or set(payload) != {"url"} or not isinstance(payload.get("url"), str):
            raise _error(HTTPStatus.BAD_REQUEST, "INVALID_FEED_REQUEST", "Feed resolution requires one URL.")
        requested_url = canonical_http_url(payload["url"])
        provider = "feed"
        ttl = 30 * 60
        self._check_open()
        with self._locks.lease(f"{provider}:{requested_url}"):
            self._check_open()
            cache_epoch = self._epoch()
            record = self.cache.get(provider, requested_url)
            now = float(self.clock.time())
            if record and record.fresh(now):
                return self._result(attach_podcast_identities(
                    record.value,
                    requested_url,
                    identity_url=record.value.get("feed_identity_url")
                    if isinstance(record.value, Mapping) else None,
                ), "fresh")
            try:
                fetched = BoundedFetcher(self.connector, clock=self.clock, cancel=self._cancel).fetch(
                    requested_url,
                    accept="application/rss+xml,application/atom+xml,application/xml,text/xml;q=0.9",
                    allowed_types={"application/rss+xml", "application/atom+xml", "application/xml", "text/xml", "application/octet-stream"},
                    headers=self._conditional(record),
                    max_compressed=4 * 1024 * 1024,
                    max_decoded=8 * 1024 * 1024,
                )
                if fetched.status == HTTPStatus.NOT_MODIFIED:
                    refreshed = self._refresh_if_current(cache_epoch, provider, requested_url, ttl=ttl)
                    if not refreshed:
                        raise _error(HTTPStatus.BAD_GATEWAY, "CATALOG_304_WITHOUT_CACHE", "Catalog cache validator had no usable record.", True)
                    return self._result(attach_podcast_identities(
                        refreshed.value,
                        requested_url,
                        identity_url=refreshed.value.get("feed_identity_url")
                        if isinstance(refreshed.value, Mapping) else None,
                    ), "revalidated")
                value = parse_podcast_feed(fetched.data, fetched.url)
                previous_identity = (
                    record.value.get("feed_identity_url")
                    if record and isinstance(record.value, Mapping) else None
                )
                value = attach_podcast_identities(
                    value,
                    requested_url,
                    canonical_http_url(fetched.url),
                    identity_url=previous_identity,
                )
                stored = self._put_if_current(
                    cache_epoch,
                    provider,
                    requested_url,
                    value,
                    ttl=ttl,
                    validators={"primary": self._validators(fetched)},
                )
                return self._result(value, "updated" if stored else "uncached")
            except (ApiError, OSError, ValueError) as error:
                if record is not None:
                    code = error.code if isinstance(error, ApiError) else "CATALOG_REFRESH_FAILED"
                    return self._result(attach_podcast_identities(
                        record.value,
                        requested_url,
                        identity_url=record.value.get("feed_identity_url")
                        if isinstance(record.value, Mapping) else None,
                    ), "stale", reason=code)
                raise

    def resolve_peertube(self, payload: Mapping[str, Any]) -> dict[str, Any]:
        with self._operation():
            return self._resolve_peertube(payload)

    def _resolve_peertube(self, payload: Mapping[str, Any]) -> dict[str, Any]:
        if not isinstance(payload, Mapping) or set(payload) != {"watch_url", "uuid"}:
            raise _error(HTTPStatus.BAD_REQUEST, "INVALID_PEERTUBE_REQUEST", "PeerTube resolution requires watch URL and UUID only.")
        watch_value = payload.get("watch_url")
        uuid_value = payload.get("uuid")
        if not isinstance(watch_value, str) or not isinstance(uuid_value, str) or not _UUID.fullmatch(uuid_value.strip()):
            raise _error(HTTPStatus.BAD_REQUEST, "PEERTUBE_UUID_INVALID", "PeerTube video UUID is invalid.")
        video_uuid = uuid_value.strip().lower()
        watch_url = canonical_http_url(watch_value)
        watch_path = urllib.parse.unquote(urllib.parse.urlsplit(watch_url).path)
        watch_match = re.fullmatch(r"/(videos/watch|w)/([A-Za-z0-9_-]{8,64})/?", watch_path)
        if not watch_match:
            raise _error(HTTPStatus.BAD_REQUEST, "PEERTUBE_WATCH_URL_INVALID", "PeerTube watch URL does not match the UUID.")
        watch_route, watch_identifier = watch_match.groups()
        if watch_route == "videos/watch" and (
            not _UUID.fullmatch(watch_identifier) or watch_identifier.lower() != video_uuid
        ):
            raise _error(HTTPStatus.BAD_REQUEST, "PEERTUBE_WATCH_URL_INVALID", "PeerTube watch URL does not match the UUID.")
        if watch_route == "w" and _UUID.fullmatch(watch_identifier) and watch_identifier.lower() != video_uuid:
            raise _error(HTTPStatus.BAD_REQUEST, "PEERTUBE_WATCH_URL_INVALID", "PeerTube watch URL does not match the UUID.")
        origin = _origin(watch_url)
        detail_url = f"{origin}/api/v1/videos/{video_uuid}"
        key = f"{origin}\n{video_uuid}"
        provider = "peertube-detail"
        ttl = 10 * 60
        self._check_open()
        with self._locks.lease(f"{provider}:{key}"):
            self._check_open()
            cache_epoch = self._epoch()
            record = self.cache.get(provider, key)
            now = float(self.clock.time())
            if record and record.fresh(now):
                return self._result(record.value, "fresh")
            connector = _clone_connector(self.connector, _exact_target(origin))
            try:
                fetched = BoundedFetcher(connector, clock=self.clock, cancel=self._cancel).fetch(
                    detail_url,
                    accept="application/json",
                    allowed_types={"application/json", "application/problem+json"},
                    headers=self._conditional(record),
                    max_compressed=2 * 1024 * 1024,
                    max_decoded=4 * 1024 * 1024,
                )
                if fetched.status == HTTPStatus.NOT_MODIFIED:
                    refreshed = self._refresh_if_current(cache_epoch, provider, key, ttl=ttl)
                    if not refreshed:
                        raise _error(HTTPStatus.BAD_GATEWAY, "CATALOG_304_WITHOUT_CACHE", "Catalog cache validator had no usable record.", True)
                    return self._result(refreshed.value, "revalidated")
                if _origin(fetched.url) != origin:
                    raise _error(HTTPStatus.FORBIDDEN, "PEERTUBE_CROSS_ORIGIN_REDIRECT", "PeerTube detail redirected off its exact origin.")
                detail = parse_json_object(fetched.data, code="PEERTUBE_JSON_INVALID")
                value = normalize_peertube_detail(detail, watch_url, video_uuid)
                stored = self._put_if_current(
                    cache_epoch,
                    provider,
                    key,
                    value,
                    ttl=ttl,
                    validators={"primary": self._validators(fetched)},
                )
                return self._result(value, "updated" if stored else "uncached")
            except (ApiError, OSError, ValueError) as error:
                # A cached public video may survive a temporary transport or
                # provider outage, but it must never override a new,
                # authoritative private/unpublished/malformed response.
                if isinstance(error, ApiError) and not error.retryable:
                    raise
                return self._stale_or_raise(record, error)

    def owncast_snapshot(self) -> dict[str, Any]:
        with self._operation():
            return self._owncast_snapshot()

    def _owncast_snapshot(self) -> dict[str, Any]:
        provider = "owncast-snapshot"
        key = "directory-v1"
        ttl = 2 * 60
        self._check_open()
        with self._locks.lease(f"{provider}:{key}"):
            self._check_open()
            cache_epoch = self._epoch()
            record = self.cache.get(provider, key)
            now = float(self.clock.time())
            if record and record.fresh(now):
                return self._result(record.value, "fresh")
            connector = _clone_connector(
                self.connector,
                _fixed_url_target({OWNCAST_PLAYLIST_URL, OWNCAST_HOME_URL}),
            )
            try:
                playlist = BoundedFetcher(connector, clock=self.clock, cancel=self._cancel).fetch(
                    OWNCAST_PLAYLIST_URL,
                    accept="application/vnd.apple.mpegurl,application/x-mpegURL,text/plain;q=0.8",
                    allowed_types={"application/vnd.apple.mpegurl", "application/x-mpegurl", "audio/mpegurl", "text/plain", "application/octet-stream"},
                    headers=self._conditional(record, "playlist"),
                    max_compressed=4 * 1024 * 1024,
                    max_decoded=4 * 1024 * 1024,
                )
                home = BoundedFetcher(connector, clock=self.clock, cancel=self._cancel).fetch(
                    OWNCAST_HOME_URL,
                    # The fixed Owncast directory endpoint currently serves
                    # its JSON document as text/plain. Bytes still cross the
                    # strict JSON-object parser below; HTML and malformed text
                    # remain failures rather than empty snapshots.
                    accept="application/json,text/plain;q=0.8",
                    allowed_types={"application/json", "text/plain"},
                    headers=self._conditional(record, "home"),
                    max_compressed=4 * 1024 * 1024,
                    max_decoded=8 * 1024 * 1024,
                )
                if playlist.status == HTTPStatus.NOT_MODIFIED and home.status == HTTPStatus.NOT_MODIFIED:
                    refreshed = self._refresh_if_current(cache_epoch, provider, key, ttl=ttl)
                    if not refreshed:
                        raise _error(HTTPStatus.BAD_GATEWAY, "CATALOG_304_WITHOUT_CACHE", "Catalog cache validator had no usable record.", True)
                    return self._result(refreshed.value, "revalidated")
                if playlist.status == HTTPStatus.NOT_MODIFIED:
                    playlist = BoundedFetcher(connector, clock=self.clock, cancel=self._cancel).fetch(
                        OWNCAST_PLAYLIST_URL,
                        accept="application/vnd.apple.mpegurl,application/x-mpegURL,text/plain;q=0.8",
                        allowed_types={"application/vnd.apple.mpegurl", "application/x-mpegurl", "audio/mpegurl", "text/plain", "application/octet-stream"},
                        max_compressed=4 * 1024 * 1024,
                        max_decoded=4 * 1024 * 1024,
                    )
                if home.status == HTTPStatus.NOT_MODIFIED:
                    home = BoundedFetcher(connector, clock=self.clock, cancel=self._cancel).fetch(
                        OWNCAST_HOME_URL,
                        accept="application/json,text/plain;q=0.8",
                        allowed_types={"application/json", "text/plain"},
                        max_compressed=4 * 1024 * 1024,
                        max_decoded=8 * 1024 * 1024,
                    )
                playlist_count = len(parse_owncast_playlist(playlist.data))
                value = normalize_owncast_snapshot(playlist.data, home.data)
                if playlist_count and not value["items"]:
                    raise _error(HTTPStatus.BAD_GATEWAY, "OWNCAST_RATING_JOIN_FAILED", "Owncast streams could not be joined to trusted rating metadata.", True)
                if record and record.value.get("items") and not value["items"]:
                    self._owncast_empty_confirmations += 1
                    if self._owncast_empty_confirmations < 2:
                        return self._result(record.value, "stale", reason="SUSPICIOUS_EMPTY_REFRESH")
                else:
                    self._owncast_empty_confirmations = 0
                stored = self._put_if_current(
                    cache_epoch,
                    provider,
                    key,
                    value,
                    ttl=ttl,
                    validators={
                        "playlist": self._validators(playlist),
                        "home": self._validators(home),
                    },
                )
                if value["items"]:
                    self._owncast_empty_confirmations = 0
                return self._result(value, "updated" if stored else "uncached")
            except (ApiError, OSError, ValueError) as error:
                self._owncast_empty_confirmations = 0
                return self._stale_or_raise(record, error)

    def clear_cache(self) -> dict[str, int]:
        with self._state_lock:
            self._check_open()
            self._cache_epoch += 1
            return {"catalog_records_removed": self.cache.clear()}

    def shutdown(self, timeout: float = 5.0) -> bool:
        deadline = time.monotonic() + max(0.0, float(timeout))
        with self._condition:
            self._closed = True
            self._cache_epoch += 1
            self._cancel.set()
            while self._active:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    return False
                self._condition.wait(min(remaining, 0.1))
            return True
