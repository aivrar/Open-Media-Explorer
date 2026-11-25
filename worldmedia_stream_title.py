"""Read the first usable ICY title of a favorite through the playback connector."""
from __future__ import annotations

import http.client
import threading
import urllib.parse
from concurrent.futures import Future

from worldmedia_icy import ICY_REQUEST_HEADER, clean_stream_title, parse_metaint, parse_stream_title
from worldmedia_media import MediaError, MediaRegistration, MediaRegistry
from worldmedia_stream_probe import Deadline, DeadlineConnector, ProbeBusy, _close_socket, _read_some

PEEK_SECONDS = 8.0
PEEK_MAX_BYTES = 160 * 1024
PEEK_MAX_DIALS = 4  # Two redirects, the stream, and one spare address attempt.
PEEK_CONCURRENCY = 4
_PEEK_SLOTS = threading.BoundedSemaphore(PEEK_CONCURRENCY)
_DNS_SLOTS = threading.BoundedSemaphore(PEEK_CONCURRENCY)

_NO_TITLE = {"status": "no title", "title": None}
_UNAVAILABLE = {"status": "not available", "title": None}


def _title_result(title: str | None) -> dict:
    return {"status": "title", "title": title} if title else dict(_NO_TITLE)


def _is_manifest(url: str) -> bool:
    try:
        return urllib.parse.urlsplit(url).path.lower().endswith((".m3u8", ".mpd"))
    except ValueError:
        return False  # The connector reports the invalid address.


def _read_title(connector, registration: MediaRegistration, deadline: Deadline) -> dict:
    def watch(sock) -> None:
        deadline.on_stop(lambda: _close_socket(sock))
        sock.settimeout(deadline.timeout())

    try:
        upstream = connector.open(
            registration.url, method="GET", headers={**registration.headers, ICY_REQUEST_HEADER: "1"},
            cancel=deadline.cancel, on_socket=watch, max_dials=PEEK_MAX_DIALS,
        )
        try:
            response = upstream.response
            if registration.require_https and not upstream.url.lower().startswith("https:"):
                return dict(_NO_TITLE)
            if not 200 <= response.status < 300:
                return dict(_NO_TITLE)
            content_type = (response.getheader("Content-Type") or "").lower()
            if _is_manifest(upstream.url) or "mpegurl" in content_type or "dash+xml" in content_type:
                return dict(_UNAVAILABLE)
            encoding = (response.getheader("Content-Encoding") or "identity").strip().lower()
            interval = parse_metaint(response.getheader("icy-metaint"))
            if encoding != "identity" or interval is None or interval >= PEEK_MAX_BYTES:
                return dict(_NO_TITLE)

            remaining = PEEK_MAX_BYTES

            def read(count: int, *, discard: bool = False) -> bytes | None:
                nonlocal remaining
                if count > remaining:
                    return None
                chunks = bytearray()
                while count:
                    deadline.timeout()
                    chunk = _read_some(response, min(count, 16 * 1024))
                    if not chunk:
                        return None
                    count -= len(chunk)
                    remaining -= len(chunk)
                    if not discard:
                        chunks.extend(chunk)
                return bytes(chunks)

            icy_name = response.getheader("icy-name")
            names = [registration.title]
            if isinstance(icy_name, str) and len(icy_name) <= 512:
                names.append(icy_name)
            while remaining > interval and read(interval, discard=True) is not None:
                length = read(1)
                if length is None:
                    break
                size = length[0] * 16
                if not size:
                    continue
                block = read(size)
                if block is None:
                    break
                title = clean_stream_title(parse_stream_title(block), names)
                if title:
                    return _title_result(title)
            return dict(_NO_TITLE)
        finally:
            upstream.close()
    except MediaError as error:
        # Keep validation refusals, including a private target after a redirect.
        if error.status < 500:
            raise
        return dict(_NO_TITLE)
    except (OSError, http.client.HTTPException):
        return dict(_NO_TITLE)


def peek_stream_title(registry: MediaRegistry, payload: object, *, client_gone=lambda: False) -> dict:
    registration = registry.prepare_registration(payload, resolve=False)
    if registration.media_type in {"hls", "dash"} or _is_manifest(registration.url):
        return dict(_UNAVAILABLE)
    if registration.media_type != "audio" or registration.delivery == "on-demand":
        return dict(_UNAVAILABLE)
    playing = registry.playing_relay_title(registration)
    if playing and playing["title"]:
        return _title_result(playing["title"])
    if client_gone():
        return dict(_NO_TITLE)
    if not _PEEK_SLOTS.acquire(blocking=False):
        raise ProbeBusy()

    deadline = Deadline(PEEK_SECONDS)
    result = Future()
    finished = threading.Event()

    def run() -> None:
        try:
            connector = DeadlineConnector(registry.connector, deadline, resolver_slots=_DNS_SLOTS)
            result.set_result(_read_title(connector, registration, deadline))
        except BaseException as error:
            result.set_exception(error)
        finally:
            _PEEK_SLOTS.release()
            finished.set()

    try:
        threading.Thread(target=run, daemon=True, name="stream-title-peek").start()
    except BaseException:
        _PEEK_SLOTS.release()
        raise
    try:
        while not deadline.expired() and not client_gone():
            playing = registry.playing_relay_title(registration)
            if playing and playing["title"]:
                return _title_result(playing["title"])
            if finished.wait(max(0, min(0.1, deadline.left()))) and not deadline.expired():
                return result.result()
        return dict(_NO_TITLE)
    finally:
        deadline.stop()
