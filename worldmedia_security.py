"""Security primitives for World Media's localhost control API.

This module is deliberately independent from the HTTP handler so header/body,
filename, reservation, and redaction behavior can be tested without starting
the desktop shell.
"""
from __future__ import annotations

import hmac
import json
import os
import re
import secrets
import unicodedata
import urllib.parse
from dataclasses import dataclass
from http import HTTPStatus
from pathlib import Path
from typing import Any, BinaryIO, Mapping


API_VERSION = "v1"
TOKEN_HEADER = "X-WorldMedia-Token"
MAX_JSON_BODY = 64 * 1024
MAX_SAFE_MESSAGE = 512
MAX_LOG_MESSAGE = 1024
MAX_FILENAME_STEM = 120

_WINDOWS_INVALID = re.compile(r'[<>:"/\\|?*]')
_SAFE_EXTENSION = re.compile(r"^[A-Za-z0-9]{1,10}$")
_RESERVED_WINDOWS_NAMES = frozenset(
    {"CON", "PRN", "AUX", "NUL"}
    | {f"COM{index}" for index in range(1, 10)}
    | {f"LPT{index}" for index in range(1, 10)}
)
_URL_IN_TEXT = re.compile(r"https?://[^\s<>\"']+", re.IGNORECASE)
_TOKEN_ASSIGNMENT = re.compile(
    r"(?i)(x-worldmedia-token\s*[:=]\s*|(?:access_?token|token|key|signature|sig)\s*=\s*)[^\s,;&]+"
)
_RELAY_PATH = re.compile(r"(?i)(/api/v1/(?:media|dash|assets)/)[A-Za-z0-9_-]{8,}")


@dataclass(slots=True)
class ApiError(Exception):
    """Safe, stable control-API failure."""

    status: int
    code: str
    message: str
    retryable: bool = False

    def __post_init__(self) -> None:
        try:
            self.status = int(self.status)
        except (TypeError, ValueError):
            self.status = int(HTTPStatus.INTERNAL_SERVER_ERROR)
        if self.status < 400 or self.status > 599:
            self.status = int(HTTPStatus.INTERNAL_SERVER_ERROR)
        if not re.fullmatch(r"[A-Z0-9_]{2,64}", self.code or ""):
            self.code = "INTERNAL_ERROR"
        self.message = safe_message(self.message)
        # A slotted dataclass may replace the class object during decoration;
        # calling Exception directly avoids the stale zero-argument super cell.
        Exception.__init__(self, self.message)

    def as_dict(self) -> dict[str, Any]:
        return {
            "code": self.code,
            "message": self.message,
            "retryable": self.retryable,
        }


def new_session_token() -> str:
    """Return a per-launch token with at least 256 bits of entropy."""

    return secrets.token_urlsafe(48)


def new_request_id() -> str:
    return secrets.token_hex(12)


def allowed_host_values(port: int) -> frozenset[str]:
    return frozenset({f"127.0.0.1:{port}", f"localhost:{port}"})


def _single_header(headers: Mapping[str, str], name: str) -> str | None:
    get_all = getattr(headers, "get_all", None)
    if callable(get_all):
        values = list(get_all(name, []))
    else:
        value = headers.get(name)
        values = [] if value is None else [value]
    if len(values) > 1:
        raise ApiError(HTTPStatus.BAD_REQUEST, "DUPLICATE_HEADER", f"{name} must appear at most once.")
    return values[0] if values else None


def validate_control_host(headers: Mapping[str, str], port: int) -> str:
    host = (_single_header(headers, "Host") or "").strip().lower()
    if host not in allowed_host_values(port):
        raise ApiError(HTTPStatus.FORBIDDEN, "INVALID_HOST", "Request host is not authorized.")
    return host


def validate_control_origin(headers: Mapping[str, str], port: int, *, required: bool) -> str | None:
    host = validate_control_host(headers, port)
    origin = (_single_header(headers, "Origin") or "").strip()
    if not origin:
        if required:
            raise ApiError(HTTPStatus.FORBIDDEN, "ORIGIN_REQUIRED", "A same-origin request is required.")
        return None
    expected = f"http://{host}"
    if not hmac.compare_digest(origin, expected):
        raise ApiError(HTTPStatus.FORBIDDEN, "INVALID_ORIGIN", "Request origin is not authorized.")
    return origin


def validate_token(headers: Mapping[str, str], expected_token: str) -> None:
    supplied = _single_header(headers, TOKEN_HEADER) or ""
    if not supplied or not hmac.compare_digest(supplied, expected_token):
        raise ApiError(HTTPStatus.FORBIDDEN, "INVALID_TOKEN", "Session token is missing or invalid.")


def validate_json_content_type(headers: Mapping[str, str]) -> None:
    raw = (_single_header(headers, "Content-Type") or "").strip()
    media_type, _, parameters = raw.partition(";")
    if media_type.strip().lower() != "application/json":
        raise ApiError(
            HTTPStatus.UNSUPPORTED_MEDIA_TYPE,
            "JSON_REQUIRED",
            "Content-Type must be application/json.",
        )
    if parameters:
        normalized = parameters.strip().lower().replace(" ", "")
        if normalized not in {"charset=utf-8", "charset=\"utf-8\""}:
            raise ApiError(
                HTTPStatus.UNSUPPORTED_MEDIA_TYPE,
                "UNSUPPORTED_CHARSET",
                "Only UTF-8 JSON is supported.",
            )


def read_json_body(headers: Mapping[str, str], stream: BinaryIO, *, max_bytes: int = MAX_JSON_BODY) -> dict[str, Any]:
    """Read one bounded JSON object using Content-Length (never chunked input)."""

    validate_json_content_type(headers)
    if _single_header(headers, "Transfer-Encoding"):
        raise ApiError(HTTPStatus.BAD_REQUEST, "CHUNKED_BODY_REJECTED", "Chunked control requests are not supported.")
    raw_length = _single_header(headers, "Content-Length")
    if raw_length is None:
        raise ApiError(HTTPStatus.LENGTH_REQUIRED, "CONTENT_LENGTH_REQUIRED", "Content-Length is required.")
    try:
        if not raw_length.isdecimal():
            raise ValueError
        length = int(raw_length, 10)
    except (AttributeError, TypeError, ValueError):
        raise ApiError(HTTPStatus.BAD_REQUEST, "INVALID_CONTENT_LENGTH", "Content-Length is invalid.") from None
    if length < 0:
        raise ApiError(HTTPStatus.BAD_REQUEST, "INVALID_CONTENT_LENGTH", "Content-Length is invalid.")
    if length > max_bytes:
        raise ApiError(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, "BODY_TOO_LARGE", "JSON request body is too large.")
    body = stream.read(length)
    if len(body) != length:
        raise ApiError(HTTPStatus.BAD_REQUEST, "INCOMPLETE_BODY", "JSON request body was incomplete.")
    try:
        value = json.loads(
            body.decode("utf-8"),
            parse_constant=lambda _value: (_ for _ in ()).throw(ValueError("non-finite number")),
        ) if body else {}
    except (UnicodeDecodeError, json.JSONDecodeError, RecursionError, ValueError):
        raise ApiError(HTTPStatus.BAD_REQUEST, "MALFORMED_JSON", "Request body is not valid UTF-8 JSON.") from None
    if not isinstance(value, dict):
        raise ApiError(HTTPStatus.BAD_REQUEST, "JSON_OBJECT_REQUIRED", "Request body must be a JSON object.")
    return value


def validate_authenticated_get(headers: Mapping[str, str], port: int, expected_token: str) -> None:
    validate_control_origin(headers, port, required=False)
    validate_token(headers, expected_token)


def validate_mutation(
    headers: Mapping[str, str],
    stream: BinaryIO,
    port: int,
    expected_token: str,
    *,
    max_bytes: int = MAX_JSON_BODY,
) -> dict[str, Any]:
    validate_control_origin(headers, port, required=True)
    validate_token(headers, expected_token)
    return read_json_body(headers, stream, max_bytes=max_bytes)


def sanitize_filename(title: str, extension: str, *, fallback: str = "media") -> str:
    """Create a Windows-safe filename; the extension is backend-selected."""

    normalized_extension = extension.lower().lstrip(".")
    if not _SAFE_EXTENSION.fullmatch(normalized_extension):
        raise ValueError("unsafe output extension")
    text = unicodedata.normalize("NFC", str(title or ""))
    text = "".join(" " if ch.isspace() else ch for ch in text if not unicodedata.category(ch).startswith("C"))
    text = _WINDOWS_INVALID.sub("_", text)
    text = re.sub(r"\s+", " ", text).strip(" .")
    suffix = f".{normalized_extension}"
    if text.lower().endswith(suffix):
        text = text[: -len(suffix)].rstrip(" .")
    text = text[:MAX_FILENAME_STEM].rstrip(" .")
    if not text:
        text = fallback[:MAX_FILENAME_STEM].strip(" .") or "media"
    device_stem = text.split(".", 1)[0].upper()
    if device_stem in _RESERVED_WINDOWS_NAMES:
        text = f"_{text}"
    return f"{text}{suffix}"


def reserve_output_path(
    root: Path,
    title: str,
    extension: str,
    *,
    timestamp: str | None = None,
    max_attempts: int = 1000,
) -> Path:
    """Atomically reserve a collision-safe final path inside *root*."""

    resolved_root = Path(root).resolve()
    resolved_root.mkdir(parents=True, exist_ok=True)
    base_name = sanitize_filename(title, extension)
    stem = Path(base_name).stem
    suffix = Path(base_name).suffix
    stamp = timestamp or __import__("time").strftime("%Y%m%d-%H%M%S")
    for attempt in range(max_attempts):
        if attempt == 0:
            candidate_name = base_name
        elif attempt == 1:
            candidate_name = f"{stem} ({stamp}){suffix}"
        else:
            candidate_name = f"{stem} ({stamp}-{attempt}){suffix}"
        candidate = (resolved_root / candidate_name).resolve()
        try:
            candidate.relative_to(resolved_root)
        except ValueError:
            raise ValueError("reserved output escaped its root") from None
        try:
            descriptor = os.open(candidate, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        except FileExistsError:
            continue
        try:
            os.close(descriptor)
        except Exception:
            try:
                candidate.unlink(missing_ok=True)
            finally:
                raise
        return candidate
    raise FileExistsError("could not reserve a unique output filename")


def redact_url(value: str) -> str:
    try:
        parsed = urllib.parse.urlsplit(value)
    except ValueError:
        return "<redacted-url>"
    if parsed.scheme.lower() not in {"http", "https"} or not parsed.hostname:
        return "<redacted-url>"
    host = parsed.hostname
    try:
        port = f":{parsed.port}" if parsed.port else ""
    except ValueError:
        port = ""
    path = _RELAY_PATH.sub(r"\1<redacted>", parsed.path)
    query = "?<redacted>" if parsed.query else ""
    fragment = "#<redacted>" if parsed.fragment else ""
    return f"{parsed.scheme.lower()}://{host}{port}{path}{query}{fragment}"


def redact_text(value: Any, *, limit: int = MAX_LOG_MESSAGE) -> str:
    text = str(value or "")
    text = _URL_IN_TEXT.sub(lambda match: redact_url(match.group(0)), text)
    text = _TOKEN_ASSIGNMENT.sub(lambda match: f"{match.group(1)}<redacted>", text)
    text = _RELAY_PATH.sub(r"\1<redacted>", text)
    text = "".join(ch if ch in "\t" or ord(ch) >= 32 else " " for ch in text)
    return text[: max(0, limit)]


def safe_message(value: Any) -> str:
    return redact_text(value, limit=MAX_SAFE_MESSAGE) or "Operation failed."


def success_envelope(data: Any, request_id: str) -> dict[str, Any]:
    return {
        "api_version": API_VERSION,
        "ok": True,
        "data": data,
        "error": None,
        "request_id": request_id,
    }


def error_envelope(error: ApiError, request_id: str) -> dict[str, Any]:
    return {
        "api_version": API_VERSION,
        "ok": False,
        "data": None,
        "error": error.as_dict(),
        "request_id": request_id,
    }
