"""Read bounded ffprobe output and map it to Computer library fields."""
from __future__ import annotations

import json
import math
import os
import re
import subprocess
import threading
import time
from datetime import date
from pathlib import PurePosixPath

UNREADABLE_AUDIO = "This file could not be read."
PROBE_TIMEOUT = 15
PROBE_OUTPUT_LIMIT = 4 * 1024 * 1024
# Limit probing to local media containers. Playlist and concat demuxers can
# interpret a file as instructions to open other inputs.
_FORMATS = (
    "mp3,mov,mp4,m4a,3gp,3g2,mj2,aac,flac,wav,aiff,ape,wv,dsf,iff,asf,asf_o,"
    "ogg,matroska,webm,ac3,eac3,dts,mpc,mpc8,tta,avi,mpeg,mpegts,mpegtsraw,flv,"
    "m4v,loas,mpegvideo"
)

_YEAR = re.compile(r"(?<!\d)[12][0-9]{3}(?!\d)")
_VIDEO_YEAR = re.compile(r"\((\d{4})\)|\[(\d{4})\]|(?<=\s)(\d{4})(?!\w)")
_EPISODE = re.compile(r"(?<!\w)s(\d{1,3})e(\d{1,3})(?:[ ._-]*e(\d{1,3})(?!\d))?(?!\d)", re.I)
_RELEASE_GROUP = re.compile(r"\[[^\]]+\]|\(\d{4}\)")
_SOURCE = re.compile(
    r"(?<!\w)(?:\d{3,4}p|[48]k|blu[ -]?ray|bdrip|brrip|web[ -]?(?:dl|rip)|"
    r"hdtv|dvdrip|remux|[xh][ .]?26[45]|hevc|av1)(?!\w)", re.I,
)
_RELEASE = re.compile(
    r"(?<!\w)(?:imax|extended|unrated|remastered|"
    r"proper|repack|limited|internal|uhd|hdr10|hdr|dv|10bit|8bit|multi|dual|dubbed|"
    r"subbed|criterion|directors[ -]+cut|dc)(?!\w)", re.I,
)
_DISC_TRACK_PREFIX = re.compile(r"^(\d{1,3})[-.](\d{2,3})\s+(\S.*)$")
_TRACK_PREFIX = re.compile(r"^(\d{1,3})\s*[-._–]\s*(\S.*)$")
_SPACED_TRACK_PREFIX = re.compile(r"^(\d{1,3}) +(\S.*)$")
_CONTROL_TEXT = re.compile(r"[\x00-\x1f\x7f]")
_LOSSLESS = {"alac", "ape", "dst", "flac", "mlp", "shorten", "truehd", "tta", "wavpack", "wmalossless"}


class ProbeError(RuntimeError):
    pass


class RetryableProbeError(ProbeError):
    """FFprobe could not launch or did not finish in time."""


def absolute_disk_path(path: str) -> str:
    if os.name != "nt":
        return path
    path = os.path.normpath(path)
    if path.startswith("\\\\?\\"):
        return path
    if path.startswith("\\\\"):
        return "\\\\?\\UNC\\" + path[2:]
    return "\\\\?\\" + path


def run_ffprobe(executable: str, path: str, cancel: threading.Event) -> dict | None:
    """Return the JSON object, or None when the scan was cancelled."""
    if cancel.is_set():
        return None
    command = [
        executable, "-v", "error", "-protocol_whitelist", "file", "-format_whitelist", _FORMATS,
        "-show_format", "-show_streams", "-show_chapters", "-of", "json", "-i", path,
    ]
    flags = 0
    if os.name == "nt":
        flags = subprocess.CREATE_NO_WINDOW | subprocess.BELOW_NORMAL_PRIORITY_CLASS
    deadline = time.monotonic() + PROBE_TIMEOUT
    try:
        process = subprocess.Popen(command, shell=False, stdin=subprocess.DEVNULL,
                                   stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, creationflags=flags)
    except OSError:
        raise RetryableProbeError("FFprobe could not run.") from None

    output = bytearray()
    finished = threading.Event()
    read_error = threading.Event()

    def drain() -> None:
        try:
            while len(output) <= PROBE_OUTPUT_LIMIT:
                block = process.stdout.read1(min(65_536, PROBE_OUTPUT_LIMIT + 1 - len(output)))
                if not block:
                    break
                output.extend(block)
        except OSError:
            read_error.set()
        finally:
            finished.set()

    reader = threading.Thread(target=drain, name="computer-ffprobe-output", daemon=True)
    try:
        reader.start()
        while True:
            if cancel.is_set():
                return None
            if len(output) > PROBE_OUTPUT_LIMIT:
                raise ProbeError("FFprobe output was too large.")
            if read_error.is_set():
                raise ProbeError("FFprobe output could not be read.")
            if finished.is_set() and process.poll() is not None:
                break
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise RetryableProbeError("FFprobe timed out.")
            if finished.is_set():
                cancel.wait(min(0.05, remaining))
            else:
                finished.wait(min(0.05, remaining))
        if len(output) > PROBE_OUTPUT_LIMIT:
            raise ProbeError("FFprobe output was too large.")
        if process.returncode != 0:
            raise ProbeError("FFprobe could not read this file.")
        try:
            data = json.loads(output)
        except (ValueError, RecursionError):
            raise ProbeError("FFprobe returned invalid tags.") from None
        if not isinstance(data, dict):
            raise ProbeError("FFprobe returned invalid tags.")
        return data
    finally:
        if process.poll() is None:
            try:
                process.kill()
            except ProcessLookupError:
                pass
        process.wait()
        if reader.ident is not None:
            reader.join()
        process.stdout.close()


def clean_video_title(filename: str) -> dict:
    """Clean a release name while keeping an ordinary filename readable."""
    name = PurePosixPath(filename).stem
    normalized = re.sub(r"[._]", " ", name)
    episode = _EPISODE.search(normalized)
    spaced = " " in name
    source = _SOURCE.search(normalized)
    release = _RELEASE.search(normalized) if not spaced and normalized != name else None
    boundary = min((match.start() for match in (episode, source, release) if match), default=len(name))
    result = {}
    cleaned = name if spaced else normalized
    latest_year = date.today().year + 1
    year_boundary = boundary
    for match in _VIDEO_YEAR.finditer(normalized):
        start = match.start()
        tail = normalized[match.end():].lstrip(" -[({")
        release_tail = _SOURCE.match(tail) or _RELEASE.match(tail)
        if not normalized[:start].strip() or (
            match[3] and not release_tail and name[:start].rstrip(" ")[-1:] not in {".", "_"}
        ):
            continue
        year = int(match[1] or match[2] or match[3])
        if 1900 <= year <= latest_year and (not tail or release_tail or (not match[3] and _EPISODE.match(tail))):
            result["year"] = year
            year_boundary = min(boundary, start)
    boundary = year_boundary
    if episode:
        result.update(season=int(episode[1]), episode=int(episode[2]))
    if boundary < len(cleaned):
        cleaned = " ".join(cleaned[:boundary].strip(" ._-[({").split()) or cleaned
    result["title"] = cleaned
    return result


def video_episode_title(rel: str, title: str = "") -> str:
    name = PurePosixPath(rel).stem
    normalized = re.sub(r"[._]", " ", name)
    episode = _EPISODE.search(normalized)
    if not episode:
        return title.strip()
    series = clean_video_title(PurePosixPath(rel).name)["title"]
    prefix = normalized[:episode.start()].strip(" -[({")
    series_names = {" ".join(value.casefold().split()) for value in (series, prefix)}
    if episode[3]:
        title = re.sub(r"^E\d{1,3}(?:[ ._-]+|$)", "", title, flags=re.I)
    for candidate in (title, name[episode.end():]):
        # Use the same quality, source and release markers as movie names.
        words = re.sub(r"[._]", " ", candidate).strip(" -")
        markers = (_SOURCE.search(words), _RELEASE.search(words), _RELEASE_GROUP.search(words))
        end = min((marker.start() for marker in markers if marker), default=len(words))
        cleaned = " ".join(words[:end].strip(" -[({").split())
        if cleaned and cleaned.casefold() not in series_names:
            return cleaned
    return ""


def tag_text(value) -> str | None:
    if not isinstance(value, str):
        return None
    return _CONTROL_TEXT.sub("", value.strip())[:1024].strip() or None


def _number(value, convert):
    if isinstance(value, bool):
        return None
    try:
        number = convert(value)
        return number if math.isfinite(number) else None
    except (ValueError, TypeError, OverflowError):
        return None


def _positive(value, convert=int):
    number = _number(value, convert)
    return number if number is not None and number > 0 else None


def _pair(value) -> tuple[int | None, int | None]:
    first, _, last = str(value or "").partition("/")
    return _positive(first), _positive(last)


def _ratio(value) -> float | None:
    first, _, last = str(value or "").partition("/")
    numerator = _positive(first, float)
    denominator = _positive(last or "1", float)
    return _positive(numerator / denominator, float) if numerator and denominator else None


def _tags(data: dict) -> dict:
    tags = data.get("tags")
    return {key.casefold(): value for key, value in tags.items()} if isinstance(tags, dict) else {}


def _objects(values) -> list[dict]:
    return [value for value in values if isinstance(value, dict)] if isinstance(values, list) else []


def _disposition(stream: dict, key: str) -> bool:
    values = stream.get("disposition")
    return isinstance(values, dict) and values.get(key) in (1, "1")


def _default_stream(streams: list[dict]) -> dict:
    return next((stream for stream in streams if _disposition(stream, "default")), streams[0] if streams else {})


def _compact(fields: dict) -> dict:
    return {key: value for key, value in fields.items() if value is not None and value != [] and value != {}}


def _tracks(streams: list[dict]) -> list[dict]:
    return [
        _compact({
            "index": index,
            "codec": tag_text(stream.get("codec_name")),
            "language": tag_text(_tags(stream).get("language")),
            "title": tag_text(_tags(stream).get("title")),
            "default": _disposition(stream, "default"),
        })
        for stream in streams if (index := _number(stream.get("index"), int)) is not None
    ]


_RG_NUMBER = r"[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:e[+-]?[0-9]+)?"
_RG_GAIN = re.compile(rf"({_RG_NUMBER})(?:\s*dB)?", re.I)
_RG_PEAK = re.compile(_RG_NUMBER, re.I)


def _gain_in_range(value):
    return -51 <= value <= 51


def _peak_in_range(value):
    return 0 < value <= 16


def _replaygain(value, *, peak=False, r128=False) -> float | None:
    values = value if isinstance(value, tuple) else (value,)
    for text in values:
        if not isinstance(text, str):
            continue
        text = text.strip()
        if r128:
            raw = _number(text, int) if re.fullmatch(r"[+-]?[0-9]+", text) else None
            if raw is not None and -32768 <= raw <= 32767:
                number = raw / 256 + 5
                if _gain_in_range(number):
                    return number
        elif (match := (_RG_PEAK if peak else _RG_GAIN).fullmatch(text)):
            number = float(match[0] if peak else match[1])
            if (_peak_in_range if peak else _gain_in_range)(number):
                return number
    return None


def _replaygain_fields(tags, codec):
    fields = {}
    for scope in ("track", "album"):
        gain = _replaygain(tags.get(f"r128_{scope}_gain"), r128=True) if codec == "opus" else None
        if gain is None:
            gain = _replaygain(tags.get(f"replaygain_{scope}_gain"))
        fields[f"rg_{scope}_gain"] = gain
        fields[f"rg_{scope}_peak"] = _replaygain(tags.get(f"replaygain_{scope}_peak"), peak=True)
    return fields


def numbered_audio_names(names: list[str]) -> bool:
    return len(names) >= 2 and all(_SPACED_TRACK_PREFIX.match(PurePosixPath(name).stem) for name in names)


def name_fields(rel: str, kind: str, root_name: str, *, numbered: bool = False) -> dict:
    path = PurePosixPath(rel)
    if kind == "video":
        fields = clean_video_title(path.name)
        if "episode" in fields:
            fields["episode_title"] = video_episode_title(rel)
        return fields
    disc_track = _DISC_TRACK_PREFIX.match(path.stem)
    if disc_track:
        disc, track, title = disc_track.groups()
    else:
        prefix = _TRACK_PREFIX.match(path.stem) or (numbered and _SPACED_TRACK_PREFIX.match(path.stem))
        disc = None
        track, title = prefix.groups() if prefix else (None, path.stem)
    return _compact({
        "title": title, "track": _positive(track), "disc": _positive(disc),
        "album": path.parent.name or root_name or None,
    })


def probe_fields(data: dict, rel: str, root_name: str, *, numbered: bool = False) -> dict:
    streams = _objects(data.get("streams"))
    audio_streams = [stream for stream in streams if stream.get("codec_type") == "audio"]
    videos = [stream for stream in streams if stream.get("codec_type") == "video"]
    video_streams = [stream for stream in videos if not _disposition(stream, "attached_pic")]
    cover = next((stream for stream in videos if _disposition(stream, "attached_pic")), None)
    cover_stream = cover.get("index") if cover is not None else None
    subtitles = [stream for stream in streams if stream.get("codec_type") == "subtitle"]
    audio, video = _default_stream(audio_streams), _default_stream(video_streams)
    if not video and not tag_text(audio.get("codec_name")):
        known = [stream for stream in audio_streams if tag_text(stream.get("codec_name"))]
        audio = _default_stream(known) or audio
    container = data.get("format")
    if not isinstance(container, dict):
        container = {}

    stream_tags, format_tags = (
        {key: value for key, value in _tags(source).items() if tag_text(value) is not None}
        for source in (video or audio, container)
    )
    tags = {**stream_tags, **format_tags}
    kind = "video" if video else "audio"
    duration = (_positive(container.get("duration"), float) or _positive(video.get("duration"), float)
                or _positive(audio.get("duration"), float))
    acodec = tag_text(audio.get("codec_name"))
    if kind == "audio":
        # An extension-only FLAC guess can declare an audio stream with zero
        # channels and sample rate even when the input is plain text.
        if _number(container.get("probe_score"), int) == 1 and not (
            _positive(audio.get("channels")) or _positive(audio.get("sample_rate"))
        ):
            acodec = None
    error = UNREADABLE_AUDIO if kind == "audio" and not acodec else None

    def number_tag(key: str):
        # As with other tags, format beats stream. Within a source, the plain key wins.
        return (format_tags.get(key) or format_tags.get(key + "number")
                or stream_tags.get(key) or stream_tags.get(key + "number"))

    track, total = _pair(number_tag("track"))
    disc, _ = _pair(number_tag("disc"))
    year = next((match for key in ("date", "year", "originaldate", "originalyear")
                 if (match := _YEAR.search(tags.get(key, "")))), None)
    dsd = acodec == "dst" or bool(acodec and acodec.startswith("dsd_"))
    sample_rate = _positive(audio.get("sample_rate"))
    chapters = []
    for chapter in _objects(data.get("chapters"))[:500]:
        start = _number(chapter.get("start_time"), float)
        if start is not None:
            chapters.append(_compact({"start": start, "title": tag_text(_tags(chapter).get("title"))}))

    fields = name_fields(rel, kind, root_name, numbered=numbered)
    if "episode" in fields and tags.get("title"):
        fields["episode_title"] = video_episode_title(rel, tags["title"])
    return {
        **fields,
        **_compact({
            "kind": kind,
            **{key: tag_text(tags.get(key)) for key in ("title", "artist", "album", "genre", "composer")},
            "album_artist": tag_text(tags.get("album_artist") or tags.get("albumartist") or tags.get("album artist")),
            "track": track,
            "track_total": total or _positive(tags.get("tracktotal") or tags.get("totaltracks")),
            "disc": disc,
            "year": int(year[0]) if year else None,
            "duration": duration,
            "error": error,
            "bitrate": (_positive(container.get("bit_rate")) or _positive(video.get("bit_rate"))
                        or _positive(audio.get("bit_rate"))),
            "container": tag_text(container.get("format_name")),
            "acodec": acodec,
            "sample_rate": sample_rate * 8 if dsd and sample_rate else sample_rate,
            "bits": 1 if dsd else (_positive(audio.get("bits_per_raw_sample"))
                                   or _positive(audio.get("bits_per_sample"))),
            "channels": _positive(audio.get("channels")),
            "lossless": (acodec.startswith(("pcm_", "dsd_")) or acodec in _LOSSLESS) if acodec else None,
            "vcodec": tag_text(video.get("codec_name")),
            "width": _positive(video.get("width")),
            "height": _positive(video.get("height")),
            "fps": _ratio(video.get("avg_frame_rate")) or _ratio(video.get("r_frame_rate")),
            "pix_fmt": tag_text(video.get("pix_fmt")),
            "audio_tracks": _tracks(audio_streams) if len(audio_streams) > 1 else [],
            "subtitle_tracks": _tracks(subtitles),
            "chapters": chapters,
            **_replaygain_fields({**_tags(audio), **_tags(container)}, acodec),
            "has_cover": True if cover is not None else None,
            "cover_stream": cover_stream if type(cover_stream) is int and cover_stream >= 0 else None,
        }),
    }
