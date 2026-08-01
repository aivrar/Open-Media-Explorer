"""Fixed-profile FFmpeg recording from opaque localhost media relays."""
from __future__ import annotations

import collections
import json
import math
import os
import re
import subprocess
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

from worldmedia_downloads import _unlink_with_retry, _validated_download_root
from worldmedia_ffmpeg import FfmpegService
from worldmedia_jobs import ACTIVE_STATES, JobRegistry, JobStateError
from worldmedia_media import (
    MAX_MANIFEST_BYTES,
    MediaError,
    MediaRegistration,
    MediaRegistry,
    select_hls_recording_variant,
)
from worldmedia_runtime import RuntimePaths, get_runtime_paths, probe_writable
from worldmedia_security import MAX_FILENAME_STEM, safe_message, sanitize_filename


PROFILES = {
    "compact": {"audio": 96, "height": 480, "crf": 27, "video_audio": 96},
    "balanced": {"audio": 160, "height": 720, "crf": 23, "video_audio": 160},
    "high": {"audio": 256, "height": 1080, "crf": 20, "video_audio": 192},
}
DEFAULT_PROFILE = "balanced"
PROBE_TIMEOUT = 30
# Some live HLS origins publish short rolling windows but occasionally stall a
# segment for longer than their advertised target duration. Keep preparation
# cancellable while allowing one bounded transient gap to recover.
RECORDING_START_TIMEOUT = 45
INPUT_PROBE_BYTES = 1_000_000
INPUT_ANALYZE_MICROSECONDS = 2_000_000
REMUX_TIMEOUT = 120
GRACEFUL_STOP_TIMEOUT = 5
TERMINATE_TIMEOUT = 5
KILL_TIMEOUT = 3
MAX_STDERR_LINES = 256
LOCAL_RELAY = re.compile(r"^http://127\.0\.0\.1:(\d{1,5})/api/v1/media/([A-Za-z0-9_-]{22,128})$")
EQ_FREQUENCIES = (31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000)
EQ_MIN_DB = -12.0
EQ_MAX_DB = 12.0
EQ_PREAMP_MIN_DB = -12.0
EQ_PREAMP_MAX_DB = 6.0


class RecordingError(RuntimeError):
    code = "RECORDING_FAILED"
    retryable = False

    def __init__(self, message: str, *, code: str | None = None, retryable: bool = False) -> None:
        super().__init__(safe_message(message))
        if code:
            self.code = code
        self.retryable = retryable


@dataclass(frozen=True, slots=True)
class RecordingTool:
    ffmpeg: Path
    ffprobe: Path


@dataclass(slots=True)
class RecordingPaths:
    root: Path
    final: Path
    working: Path
    finalizing: Path | None


def _hidden_flags() -> int:
    return getattr(subprocess, "CREATE_NO_WINDOW", 0) if os.name == "nt" else 0


def _recording_flags() -> int:
    """Keep CPU-heavy encoding behind interactive playback on Windows."""

    return _hidden_flags() | (
        getattr(subprocess, "BELOW_NORMAL_PRIORITY_CLASS", 0) if os.name == "nt" else 0
    )


def validate_local_relay(url: str) -> str:
    if not isinstance(url, str) or not LOCAL_RELAY.fullmatch(url):
        raise RecordingError("Recording input must be an opaque localhost media relay.", code="INVALID_RECORDING_INPUT")
    port = int(LOCAL_RELAY.fullmatch(url).group(1))  # type: ignore[union-attr]
    if not 1 <= port <= 65535:
        raise RecordingError("Recording relay port is invalid.", code="INVALID_RECORDING_INPUT")
    return url


def normalize_profile(value: str) -> str:
    if value not in PROFILES:
        raise RecordingError("Recording quality is invalid.", code="INVALID_RECORDING_PROFILE")
    return value


def normalize_recording_eq(value: object | None) -> dict:
    """Validate a small numeric EQ snapshot; never accept FFmpeg syntax."""

    if value is None:
        return {"preamp": 0.0, "bands": [0.0] * len(EQ_FREQUENCIES), "bypassed": True}
    if not isinstance(value, dict) or set(value) != {"preamp", "bands", "bypassed"}:
        raise RecordingError("Recording EQ is invalid.", code="INVALID_RECORDING_EQ")
    preamp = value.get("preamp")
    bands = value.get("bands")
    bypassed = value.get("bypassed")
    if (
        isinstance(preamp, bool) or not isinstance(preamp, (int, float))
        or not math.isfinite(float(preamp))
        or not EQ_PREAMP_MIN_DB <= float(preamp) <= EQ_PREAMP_MAX_DB
        or not isinstance(bands, list) or len(bands) != len(EQ_FREQUENCIES)
        or not isinstance(bypassed, bool)
    ):
        raise RecordingError("Recording EQ is invalid.", code="INVALID_RECORDING_EQ")
    normalized_bands: list[float] = []
    for band in bands:
        if (
            isinstance(band, bool) or not isinstance(band, (int, float))
            or not math.isfinite(float(band)) or not EQ_MIN_DB <= float(band) <= EQ_MAX_DB
        ):
            raise RecordingError("Recording EQ is invalid.", code="INVALID_RECORDING_EQ")
        normalized_bands.append(float(band))
    return {"preamp": float(preamp), "bands": normalized_bands, "bypassed": bypassed}


def _filter_number(value: float) -> str:
    result = f"{value:.6f}".rstrip("0").rstrip(".")
    return "0" if result in {"", "-0"} else result


def recording_eq_filter(value: object | None) -> str:
    curve = normalize_recording_eq(value)
    if curve["bypassed"]:
        return ""
    filters: list[str] = []
    if curve["preamp"] != 0:
        filters.append(f"volume={_filter_number(curve['preamp'])}dB")
    for index, (frequency, gain) in enumerate(zip(EQ_FREQUENCIES, curve["bands"])):
        if gain == 0:
            continue
        amount = _filter_number(gain)
        if index == 0:
            filters.append(f"bass=f={frequency}:t=q:w=1:g={amount}")
        elif index == len(EQ_FREQUENCIES) - 1:
            filters.append(f"treble=f={frequency}:t=q:w=1:g={amount}")
        else:
            filters.append(f"equalizer=f={frequency}:t=q:w=1.414214:g={amount}")
    if not filters:
        return ""
    # Web Audio's downstream compressor prevents boosted curves from clipping.
    # Use a non-auto-level limiter for the corresponding recording safeguard.
    filters.append("alimiter=limit=0.95:level=false")
    return ",".join(filters)


def build_probe_args(tool: RecordingTool, relay_url: str) -> list[str]:
    return [
        str(tool.ffprobe), "-v", "error", "-rw_timeout", "10000000",
        "-show_entries", "stream=codec_type,codec_name,width,height",
        "-of", "json", "-seekable", "0", validate_local_relay(relay_url),
    ]


def build_record_args(
    tool: RecordingTool, relay_url: str, output: Path, *, kind: str, profile: str,
    require_audio: bool = False, eq: object | None = None,
) -> list[str]:
    selected = PROFILES[normalize_profile(profile)]
    if kind not in {"audio", "video"}:
        raise RecordingError("Recording media kind is invalid.", code="INVALID_RECORDING_KIND")
    args = [
        str(tool.ffmpeg), "-hide_banner", "-loglevel", "warning", "-y",
        "-rw_timeout", "15000000", "-reconnect", "1",
        "-reconnect_streamed", "1", "-reconnect_delay_max", "5",
        "-probesize", str(INPUT_PROBE_BYTES),
        "-analyzeduration", str(INPUT_ANALYZE_MICROSECONDS),
        "-seekable", "0", "-i", validate_local_relay(relay_url),
        "-progress", "pipe:1", "-stats_period", "0.5",
    ]
    audio_filter = recording_eq_filter(eq)
    if kind == "audio":
        if audio_filter:
            args += ["-af", audio_filter]
        args += [
            "-map", "0:a:0", "-vn", "-c:a", "libmp3lame", "-b:a", f"{selected['audio']}k",
            "-f", "mp3", str(output),
        ]
    else:
        height = selected["height"]
        scale = (
            f"scale=w=trunc(min(iw\\,iw*{height}/ih)/2)*2:"
            f"h=trunc(min(ih\\,{height})/2)*2"
        )
        args += [
            "-map", "0:v:0", "-map", "0:a:0" if require_audio else "0:a:0?",
            *(["-af", audio_filter] if audio_filter else []),
            "-c:v", "libx264", "-preset", "veryfast",
            "-crf", str(selected["crf"]), "-vf", scale, "-pix_fmt", "yuv420p",
            "-force_key_frames", "expr:gte(t,n_forced*2)",
            "-c:a", "aac", "-b:a", f"{selected['video_audio']}k",
            "-movflags", "frag_keyframe+empty_moov+default_base_moof",
            "-f", "mp4", str(output),
        ]
    return args


def build_remux_args(tool: RecordingTool, working: Path, output: Path) -> list[str]:
    return [
        str(tool.ffmpeg), "-hide_banner", "-loglevel", "error", "-y",
        "-i", str(working), "-map", "0", "-c", "copy", "-movflags", "+faststart", str(output),
    ]


def build_validate_args(tool: RecordingTool, output: Path) -> list[str]:
    return [
        str(tool.ffprobe), "-v", "error",
        "-show_entries", "format=format_name,duration:stream=codec_type,codec_name,width,height",
        "-of", "json", str(output),
    ]


def parse_probe_json(text: str) -> dict:
    try:
        value = json.loads(text)
    except (TypeError, json.JSONDecodeError):
        raise RecordingError("FFprobe returned malformed stream metadata.", code="INVALID_PROBE_OUTPUT") from None
    if not isinstance(value, dict) or not isinstance(value.get("streams"), list):
        raise RecordingError("FFprobe returned no stream metadata.", code="INVALID_PROBE_OUTPUT")
    # FFprobe 8.x can report HLS program streams only inside `programs` while
    # leaving the top-level `streams` array empty. Normalize that valid shape
    # so managed and system FFprobe builds select the same recording kind.
    if not value["streams"] and isinstance(value.get("programs"), list):
        program_streams = [
            stream
            for program in value["programs"]
            if isinstance(program, dict) and isinstance(program.get("streams"), list)
            for stream in program["streams"]
            if isinstance(stream, dict)
        ]
        if program_streams:
            value["streams"] = program_streams
    return value


def choose_recording_kind(probe: dict) -> str:
    kinds = {stream.get("codec_type") for stream in probe.get("streams", []) if isinstance(stream, dict)}
    if "video" in kinds:
        return "video"
    if "audio" in kinds:
        return "audio"
    raise RecordingError("The media relay has no recordable audio or video stream.", code="NO_RECORDABLE_STREAM")


def validate_output_probe(
    probe: dict, kind: str, max_height: int | None = None, *, require_audio: bool = False,
) -> None:
    streams = [stream for stream in probe.get("streams", []) if isinstance(stream, dict)]
    duration_raw = probe.get("format", {}).get("duration") if isinstance(probe.get("format"), dict) else None
    try:
        duration = float(duration_raw)
    except (TypeError, ValueError):
        duration = 0
    if duration <= 0:
        raise RecordingError("Recorded output has no valid duration.", code="INVALID_RECORDED_OUTPUT")
    if kind == "audio":
        if not any(s.get("codec_type") == "audio" and s.get("codec_name") == "mp3" for s in streams):
            raise RecordingError("Recorded audio is not a valid MP3 stream.", code="INVALID_RECORDED_OUTPUT")
        return
    video = next((s for s in streams if s.get("codec_type") == "video"), None)
    if not video or video.get("codec_name") != "h264":
        raise RecordingError("Recorded video is not H.264.", code="INVALID_RECORDED_OUTPUT")
    height = int(video.get("height") or 0)
    width = int(video.get("width") or 0)
    if height <= 0 or width <= 0 or height % 2 or width % 2 or (max_height and height > max_height):
        raise RecordingError("Recorded video dimensions are invalid.", code="INVALID_RECORDED_OUTPUT")
    audio = [s for s in streams if s.get("codec_type") == "audio"]
    if require_audio and not audio:
        raise RecordingError("Recorded video is missing its source audio.", code="INVALID_RECORDED_OUTPUT")
    if audio and any(s.get("codec_name") != "aac" for s in audio):
        raise RecordingError("Recorded video audio is not AAC.", code="INVALID_RECORDED_OUTPUT")


class RecordingController:
    def __init__(self) -> None:
        self.stop_requested = threading.Event()
        self.cancel_requested = threading.Event()
        self._lock = threading.RLock()
        self._process = None

    def attach(self, process) -> None:
        with self._lock:
            self._process = process
        if self.cancel_requested.is_set():
            self.cancel()
        elif self.stop_requested.is_set():
            self.stop()

    def stop(self) -> None:
        self.stop_requested.set()
        with self._lock:
            process = self._process
        if process and process.poll() is None and process.stdin:
            try:
                process.stdin.write("q\n")
                process.stdin.flush()
            except (OSError, ValueError):
                pass

    def cancel(self) -> None:
        self.cancel_requested.set()
        with self._lock:
            process = self._process
        if process and process.poll() is None:
            try:
                process.terminate()
            except OSError:
                pass

    def kill(self) -> None:
        self.cancel_requested.set()
        with self._lock:
            process = self._process
        if process and process.poll() is None:
            try:
                process.kill()
            except OSError:
                pass

    def clear(self) -> None:
        with self._lock:
            self._process = None


class RecordingService:
    def __init__(
        self,
        registry: MediaRegistry,
        jobs: JobRegistry,
        ffmpeg: FfmpegService,
        paths: RuntimePaths | None = None,
        *,
        popen: Callable = subprocess.Popen,
        runner: Callable | None = None,
        utility_popen: Callable = subprocess.Popen,
    ) -> None:
        self.registry = registry
        self.jobs = jobs
        self.ffmpeg = ffmpeg
        self.paths = paths or get_runtime_paths()
        self.popen = popen
        self.runner = runner
        self.utility_popen = utility_popen
        self._lock = threading.RLock()
        self._workers: dict[str, threading.Thread] = {}
        self._controllers: dict[str, RecordingController] = {}
        self._utility_processes: set = set()

    def start(self, media_id: str, profile: str, relay_origin: str, eq: object | None = None) -> dict:
        registration = self.registry.get(media_id)
        selected_profile = normalize_profile(profile)
        selected_eq = normalize_recording_eq(eq)
        if registration.delivery == "on-demand":
            raise RecordingError("Finite on-demand originals should be downloaded, not recorded.", code="RECORDING_NOT_LIVE")
        status = self.ffmpeg.status()
        if status.state != "ready" or not status.ffmpeg_path or not status.ffprobe_path:
            raise RecordingError(
                status.actionable_reason or "A capable FFmpeg toolchain is required.",
                code="RECORDING_TOOL_UNAVAILABLE", retryable=True,
            )
        if not re.fullmatch(r"http://127\.0\.0\.1:\d{1,5}", relay_origin):
            raise RecordingError("Recording relay origin is invalid.", code="INVALID_RECORDING_INPUT")
        relay_url = f"{relay_origin}/api/v1/media/{media_id}"
        validate_local_relay(relay_url)
        recording_kind = registration.recording_kind or (
            "video" if registration.media_type in {"video", "hls", "dash"} else "audio"
        )
        initial_kind = f"record-{recording_kind}"
        job = self.jobs.create(
            kind=initial_kind, title=registration.title, media_id=media_id,
            item_id=registration.item_id, source=registration.source, profile=selected_profile,
        )
        controller = RecordingController()
        self.jobs.attach_controller(job.id, stop=controller.stop, cancel=controller.cancel)
        tool = RecordingTool(Path(status.ffmpeg_path), Path(status.ffprobe_path))
        thread = threading.Thread(
            target=self._worker,
            args=(
                job.id, registration.title, tool, registration, relay_origin,
                selected_profile, selected_eq, controller,
            ),
            name=f"worldmedia-record-{job.id[-8:]}", daemon=True,
        )
        with self._lock:
            self._workers[job.id] = thread
            self._controllers[job.id] = controller
        try:
            thread.start()
        except Exception:
            with self._lock:
                self._workers.pop(job.id, None)
                self._controllers.pop(job.id, None)
            self.jobs.transition(
                job.id, "failed", error_code="RECORDING_START_FAILED",
                error_message="The recorder worker could not start.", retryable=True,
            )
            raise RecordingError("The recorder worker could not start.", code="RECORDING_START_FAILED", retryable=True)
        return self.jobs.snapshot(job.id)

    def shutdown(self, timeout: float = 12.0) -> bool:
        """Finalize active recordings, then synchronously reap every worker."""

        deadline = time.monotonic() + max(0.0, timeout)
        with self._lock:
            job_ids = list(self._workers)
        for job_id in job_ids:
            try:
                state = self.jobs.get(job_id).state
                if state in {"running", "stopping"}:
                    self.jobs.request_stop(job_id)
                elif state in {"queued", "preparing"}:
                    self.jobs.request_cancel(job_id)
            except JobStateError:
                pass

        # Give `q` and normal remux/validation the same bounded grace used by
        # an interactive Stop Recording operation.
        graceful_deadline = min(deadline, time.monotonic() + GRACEFUL_STOP_TIMEOUT + 2)
        self._wait_internal_until(graceful_deadline)
        with self._lock:
            remaining = list(self._controllers.values())
            utilities = list(self._utility_processes)
        for controller in remaining:
            controller.cancel()
        for process in utilities:
            if process.poll() is None:
                try:
                    process.terminate()
                except OSError:
                    pass
        self._wait_internal_until(deadline)
        with self._lock:
            remaining = list(self._controllers.values())
            utilities = list(self._utility_processes)
        for controller in remaining:
            controller.kill()
        for process in utilities:
            if process.poll() is None:
                try:
                    process.kill()
                except OSError:
                    pass
        # A killed process should be reaped immediately; this final bounded
        # join is deliberately outside the caller's grace window so shutdown
        # cannot return while a child process is still owned by the app.
        self._wait_internal_until(time.monotonic() + KILL_TIMEOUT)
        with self._lock:
            return not self._workers and not self._utility_processes

    def _wait_internal_until(self, deadline: float) -> None:
        while True:
            with self._lock:
                workers = list(self._workers.values())
                utilities = list(self._utility_processes)
            if not workers and not utilities:
                return
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return
            for worker in workers:
                worker.join(min(0.2, remaining))
            for process in utilities:
                if process.poll() is None:
                    try:
                        process.wait(timeout=min(0.05, max(0.0, deadline - time.monotonic())))
                    except subprocess.TimeoutExpired:
                        pass

    def _run(self, args: list[str], *, timeout: int) -> subprocess.CompletedProcess:
        if self.runner is not None:
            try:
                return self.runner(
                    args, check=False, capture_output=True, text=True, encoding="utf-8", errors="replace",
                    timeout=timeout, shell=False, creationflags=_hidden_flags(),
                )
            except (OSError, subprocess.SubprocessError) as error:
                raise RecordingError(
                    "A required FFmpeg operation could not run.",
                    code="FFMPEG_OPERATION_FAILED", retryable=True,
                ) from error
        try:
            process = self.utility_popen(
                args, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                text=True, encoding="utf-8", errors="replace", shell=False,
                creationflags=_hidden_flags(),
            )
        except OSError as error:
            raise RecordingError(
                "A required FFmpeg operation could not run.",
                code="FFMPEG_OPERATION_FAILED", retryable=True,
            ) from error
        with self._lock:
            self._utility_processes.add(process)
        try:
            try:
                stdout, stderr = process.communicate(timeout=timeout)
            except subprocess.TimeoutExpired:
                process.kill()
                stdout, stderr = process.communicate(timeout=KILL_TIMEOUT)
                raise RecordingError(
                    "A required FFmpeg operation timed out.",
                    code="FFMPEG_OPERATION_TIMEOUT", retryable=True,
                ) from None
            return subprocess.CompletedProcess(args, process.returncode, stdout, stderr)
        except (OSError, subprocess.SubprocessError) as error:
            raise RecordingError(
                "A required FFmpeg operation could not run.",
                code="FFMPEG_OPERATION_FAILED", retryable=True,
            ) from error
        finally:
            with self._lock:
                self._utility_processes.discard(process)

    def _probe_input(self, tool: RecordingTool, relay_url: str) -> dict:
        result = self._run(build_probe_args(tool, relay_url), timeout=PROBE_TIMEOUT)
        if result.returncode != 0:
            raise RecordingError("The media stream could not be probed for recording.", code="INPUT_PROBE_FAILED", retryable=True)
        return parse_probe_json(result.stdout)

    def _recording_relay_url(
        self,
        registration: MediaRegistration,
        relay_origin: str,
        profile: str,
        controller: RecordingController,
    ) -> str:
        root_url = validate_local_relay(
            f"{relay_origin}/api/v1/media/{registration.token}"
        )
        if registration.media_type != "hls" or controller.cancel_requested.is_set():
            return root_url
        upstream = None
        try:
            upstream = self.registry.connector.open(
                registration.url,
                headers=registration.headers,
                cancel=controller.cancel_requested,
            )
            if not 200 <= upstream.response.status < 300:
                return root_url
            encoding = (upstream.response.getheader("Content-Encoding") or "identity").lower()
            if encoding != "identity":
                return root_url
            manifest = upstream.response.read(MAX_MANIFEST_BYTES + 1)
            if len(manifest) > MAX_MANIFEST_BYTES or controller.cancel_requested.is_set():
                return root_url
            text = manifest.decode("utf-8-sig")
            recording_kind = registration.recording_kind or "video"
            selected = select_hls_recording_variant(
                text,
                upstream.url,
                recording_kind=recording_kind,
                max_height=PROFILES[profile]["height"],
            )
            if not selected:
                return root_url
            child = self.registry.child(registration, selected, media_type="hls")
            return validate_local_relay(
                f"{relay_origin}/api/v1/media/{child.token}"
            )
        except (MediaError, OSError, TimeoutError, UnicodeError, ValueError):
            # A malformed or temporarily unavailable master remains eligible
            # for FFmpeg's own demuxer. The optimization must never turn a
            # previously recordable single-playlist source into a hard failure.
            return root_url
        finally:
            if upstream is not None:
                upstream.close()

    def _probe_output(
        self, tool: RecordingTool, path: Path, kind: str, profile: str, *, require_audio: bool = False,
    ) -> None:
        result = self._run(build_validate_args(tool, path), timeout=PROBE_TIMEOUT)
        if result.returncode != 0:
            raise RecordingError("Recorded output failed validation.", code="INVALID_RECORDED_OUTPUT")
        validate_output_probe(
            parse_probe_json(result.stdout), kind,
            PROFILES[profile]["height"] if kind == "video" else None,
            require_audio=require_audio,
        )

    def _reserve_paths(self, job_id: str, title: str, kind: str) -> RecordingPaths:
        root = _validated_download_root(self.paths)
        writable, reason = probe_writable(root)
        if not writable:
            raise RecordingError(reason or "Recordings directory is not writable.", code="DOWNLOADS_NOT_WRITABLE")
        extension = "mp4" if kind == "video" else "mp3"
        base = sanitize_filename(title, extension, fallback="recording")
        stem = Path(base).stem
        stamp = time.strftime("%Y-%m-%d_%H-%M-%S")
        with self._lock:
            for attempt in range(1000):
                collision = "" if attempt == 0 else f" ({attempt + 1})"
                timestamp_suffix = f" - {stamp}{collision}"
                title_limit = max(1, MAX_FILENAME_STEM - len(timestamp_suffix))
                readable_stem = stem[:title_limit].rstrip(" .") or "recording"
                numbered_stem = f"{readable_stem}{timestamp_suffix}"
                name = sanitize_filename(numbered_stem, extension, fallback="recording")
                final = (root / name).resolve()
                final.relative_to(root)
                if final.exists():
                    continue
                working = root / f".{stem}.{job_id}.working.{extension}"
                finalizing = root / f".{stem}.{job_id}.finalizing.mp4" if kind == "video" else None
                for candidate in (working, finalizing):
                    if candidate and candidate.exists():
                        _unlink_with_retry(candidate)
                return RecordingPaths(root, final, working, finalizing)
        raise RecordingError("A unique recording filename could not be reserved.", code="RECORDING_NAME_COLLISION")

    def _drain_stderr(self, stream, lines: collections.deque[str]) -> None:
        if stream is None:
            return
        try:
            for line in stream:
                lines.append(safe_message(line.strip()))
        except (OSError, ValueError):
            pass

    def _drain_progress(self, job_id: str, stream, media_started: threading.Event, kind: str) -> None:
        if stream is None:
            return
        encoded_time_us = 0
        encoded_video_frames = 0
        try:
            for raw in stream:
                line = raw.strip()
                if "=" not in line:
                    continue
                name, value = line.split("=", 1)
                if name == "total_size" and value.isdigit():
                    if int(value) > 1024:
                        media_started.set()
                    try:
                        self.jobs.update_progress(job_id, bytes_written=int(value), indeterminate=True)
                    except JobStateError:
                        return
                elif name in {"out_time_us", "out_time_ms"} and value.isdigit():
                    # FFmpeg documents out_time_us; older builds have also used
                    # out_time_ms for the same microsecond counter.  Waiting for a
                    # full encoded second avoids declaring startup on a container
                    # header or a lone priming packet.
                    encoded_time_us = max(encoded_time_us, int(value))
                    if encoded_time_us >= 1_000_000 and (kind == "audio" or encoded_video_frames > 0):
                        media_started.set()
                elif name == "frame" and value.isdigit():
                    encoded_video_frames = max(encoded_video_frames, int(value))
                    if kind == "video" and encoded_video_frames > 0 and encoded_time_us >= 1_000_000:
                        media_started.set()
        except (OSError, ValueError):
            pass

    def _wait_escalating(self, process, controller: RecordingController) -> int:
        while process.poll() is None and not (
            controller.stop_requested.is_set() or controller.cancel_requested.is_set()
        ):
            time.sleep(0.1)
        if process.poll() is not None:
            return int(process.returncode)
        if controller.cancel_requested.is_set():
            try:
                process.terminate()
            except OSError:
                pass
            graceful_timeout = 0
        else:
            graceful_timeout = GRACEFUL_STOP_TIMEOUT
        try:
            return int(process.wait(timeout=graceful_timeout))
        except subprocess.TimeoutExpired:
            process.terminate()
        try:
            return int(process.wait(timeout=TERMINATE_TIMEOUT))
        except subprocess.TimeoutExpired:
            process.kill()
        try:
            return int(process.wait(timeout=KILL_TIMEOUT))
        except subprocess.TimeoutExpired:
            raise RecordingError("FFmpeg did not exit after forced termination.", code="FFMPEG_ORPHANED") from None

    def _worker(
        self, job_id: str, title: str, tool: RecordingTool,
        registration: MediaRegistration, relay_origin: str,
        profile: str, eq: dict, controller: RecordingController,
    ) -> None:
        paths: RecordingPaths | None = None
        process = None
        stderr_thread = None
        progress_thread = None
        stderr_lines: collections.deque[str] = collections.deque(maxlen=MAX_STDERR_LINES)
        published = False
        try:
            self.jobs.transition(job_id, "preparing")
            relay_url = self._recording_relay_url(
                registration, relay_origin, profile, controller,
            )
            if controller.cancel_requested.is_set():
                return
            if registration.recording_kind:
                # The normalized item contract already says whether the user
                # selected audio/radio or video/TV. FFmpeg performs its own
                # demux probe while opening the input and the completed file is
                # still independently ffprobed before publication, so a second
                # up-front FFprobe would only double live-stream startup time.
                kind = registration.recording_kind
                require_audio = False
            else:
                # Backward compatibility for older callers that did not carry
                # recording_kind in their opaque registration.
                probe = self._probe_input(tool, relay_url)
                kind = choose_recording_kind(probe)
                require_audio = kind == "video" and any(
                    isinstance(stream, dict) and stream.get("codec_type") == "audio"
                    for stream in probe.get("streams", [])
                )
            expected_job_kind = f"record-{kind}"
            job = self.jobs.get(job_id)
            if job.kind != expected_job_kind:
                self.jobs.set_recording_kind(job_id, expected_job_kind)
            if controller.cancel_requested.is_set():
                return
            paths = self._reserve_paths(job_id, title, kind)
            args = build_record_args(
                tool, relay_url, paths.working, kind=kind, profile=profile,
                require_audio=require_audio, eq=eq,
            )
            process = self.popen(
                args, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                text=True, encoding="utf-8", errors="replace", bufsize=1,
                shell=False, creationflags=_recording_flags(),
            )
            controller.attach(process)
            stderr_thread = threading.Thread(
                target=self._drain_stderr, args=(process.stderr, stderr_lines),
                name=f"worldmedia-record-stderr-{job_id[-8:]}", daemon=True,
            )
            stderr_thread.start()
            media_started = threading.Event()
            progress_thread = threading.Thread(
                target=self._drain_progress, args=(job_id, process.stdout, media_started, kind),
                name=f"worldmedia-record-progress-{job_id[-8:]}", daemon=True,
            )
            progress_thread.start()
            self.jobs.update_progress(job_id, indeterminate=True)
            start_deadline = time.monotonic() + RECORDING_START_TIMEOUT
            while not media_started.is_set() and process.poll() is None and not controller.cancel_requested.is_set():
                # FFmpeg's progress protocol can keep reporting the initial MP4
                # header size while the muxer has already flushed media fragments
                # to disk.  The file itself is the authoritative start signal.
                try:
                    if paths.working.stat().st_size > 1024:
                        media_started.set()
                        break
                except (FileNotFoundError, OSError):
                    pass
                if time.monotonic() >= start_deadline:
                    process.terminate()
                    raise RecordingError(
                        "FFmpeg did not begin encoding media before the startup timeout.",
                        code="RECORDING_START_TIMEOUT", retryable=True,
                    )
                media_started.wait(0.1)
            if controller.cancel_requested.is_set():
                return
            if media_started.is_set() or process.poll() == 0:
                self.jobs.transition(job_id, "running")
            return_code = self._wait_escalating(process, controller)
            if progress_thread:
                progress_thread.join(2)
            if stderr_thread:
                stderr_thread.join(2)
            if controller.cancel_requested.is_set():
                if self.jobs.get(job_id).state in ACTIVE_STATES:
                    self._preserve_or_fail(
                        job_id, paths,
                        RecordingError(
                            "Recording was interrupted during application shutdown.",
                            code="RECORDING_SHUTDOWN_INTERRUPTED", retryable=True,
                        ),
                    )
                return
            if return_code != 0 and not controller.stop_requested.is_set():
                detail = stderr_lines[-1] if stderr_lines else "FFmpeg exited before recording completed."
                raise RecordingError(detail, code="FFMPEG_RECORDING_FAILED", retryable=True)
            self.jobs.transition(job_id, "finalizing")
            if kind == "audio":
                self._probe_output(tool, paths.working, kind, profile, require_audio=require_audio)
                publish_source = paths.working
            else:
                self._probe_output(tool, paths.working, kind, profile, require_audio=require_audio)
                assert paths.finalizing is not None
                remux = self._run(build_remux_args(tool, paths.working, paths.finalizing), timeout=REMUX_TIMEOUT)
                if remux.returncode != 0:
                    raise RecordingError("Video fast-start finalization failed.", code="RECORDING_FINALIZE_FAILED", retryable=True)
                self._probe_output(tool, paths.finalizing, kind, profile, require_audio=require_audio)
                publish_source = paths.finalizing
            descriptor = os.open(paths.final, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
            os.close(descriptor)
            try:
                os.replace(publish_source, paths.final)
            except Exception:
                _unlink_with_retry(paths.final)
                raise
            self.jobs.set_validated_output_path(job_id, paths.final, paths.root)
            self.jobs.transition(job_id, "completed", return_code=return_code)
            published = True
        except JobStateError:
            pass
        except RecordingError as error:
            self._preserve_or_fail(job_id, paths, error)
        except Exception:
            self._preserve_or_fail(
                job_id, paths,
                RecordingError("Recording failed safely.", code="RECORDING_INTERNAL_ERROR", retryable=True),
            )
        finally:
            controller.clear()
            if process and process.poll() is None:
                try:
                    process.kill()
                    process.wait(timeout=KILL_TIMEOUT)
                except Exception:
                    pass
            if stderr_thread and stderr_thread.is_alive():
                stderr_thread.join(1)
            if progress_thread and progress_thread.is_alive():
                progress_thread.join(1)
            if process:
                for stream in (process.stdin, process.stdout, process.stderr):
                    if stream:
                        try:
                            stream.close()
                        except (OSError, ValueError, AttributeError):
                            pass
            if paths:
                for candidate in (paths.working, paths.finalizing):
                    if candidate and candidate.exists():
                        _unlink_with_retry(candidate)
                if paths.final.exists() and not published and self.jobs.get(job_id).state != "failed":
                    _unlink_with_retry(paths.final)
            with self._lock:
                self._workers.pop(job_id, None)
                self._controllers.pop(job_id, None)

    def _preserve_or_fail(
        self, job_id: str, paths: RecordingPaths | None, error: RecordingError,
    ) -> None:
        job = self.jobs.get(job_id)
        if job.state not in ACTIVE_STATES:
            return
        working_size = 0
        if paths:
            try:
                working_size = paths.working.stat().st_size
            except (FileNotFoundError, OSError):
                pass
        if paths and working_size > 0:
            extension = "mp4" if job.kind == "record-video" else "mp3"
            stem = Path(sanitize_filename(job.title, extension, fallback="recording")).stem
            stamp = time.strftime("%Y%m%d-%H%M%S")
            for attempt in range(1000):
                suffix = "" if attempt == 0 else f"-{attempt + 1}"
                recoverable = paths.root / sanitize_filename(
                    f"{stem} (recoverable {stamp}{suffix})", extension,
                )
                try:
                    descriptor = os.open(recoverable, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
                    os.close(descriptor)
                except FileExistsError:
                    continue
                try:
                    os.replace(paths.working, recoverable)
                    self.jobs.set_validated_output_path(job_id, recoverable, paths.root)
                    break
                except OSError:
                    _unlink_with_retry(recoverable)
                    continue
                except JobStateError:
                    break
        try:
            self.jobs.transition(
                job_id, "failed", error_code=error.code, error_message=str(error),
                retryable=error.retryable,
            )
        except JobStateError:
            pass
