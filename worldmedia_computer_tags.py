"""Read common Computer audio formats without starting ffprobe.

TinyTag supplies stream properties. Read metadata directly where its normalization
would lose distinctions the index uses, such as repeated Vorbis comments.
"""
from __future__ import annotations

import math
import os
import re
from io import BytesIO
from pathlib import PurePosixPath
from stat import S_ISREG
from struct import unpack, unpack_from
from typing import NamedTuple

try:
    from tinytag import TinyTag
except ImportError:
    TinyTag = None

from worldmedia_computer_probe import absolute_disk_path, probe_fields

TAG_EXTENSIONS = frozenset({"flac", "mp3", "wav", "aiff", "aif", "m4a", "ogg", "opus"})
_READ_LIMIT = 8 * 1024 * 1024
_COMMENT_LIMIT = 1024 * 1024
_MP3_HEAD = 64 * 1024
_MP3_TAIL = 12 * 1024
_VORBIS_KEYS = {"albumartist": "album_artist", "tracknumber": "track", "discnumber": "disc"}
_WAVE_KEYS = {"inam": "title", "iart": "artist", "iprd": "album", "ignr": "genre",
              "icrd": "date", "iprt": "track", "itrk": "track"}
_ID3_KEYS = {
    b"TIT2": "title", b"TT2": "title", b"TPE1": "artist", b"TP1": "artist",
    b"TPE2": "album_artist", b"TP2": "album_artist", b"TALB": "album", b"TAL": "album",
    b"TCON": "genre", b"TCO": "genre", b"TCOM": "composer", b"TCM": "composer",
    b"TRCK": "track", b"TRK": "track", b"TPOS": "disc", b"TPA": "disc",
    b"TDRC": "date", b"TDRL": "date", b"TYER": "year", b"TYE": "year",
    b"TCMP": "compilation",
}
_IMAGE_MIMES = {b"image/jpeg", b"image/jpg", b"image/png", b"image/gif", b"image/bmp",
                b"image/tiff", b"image/webp"}
_NUMBERED_GENRE = re.compile(r"^\s*(?:\([0-9]+\)|[0-9])")
_SIMPLE_GENRE_NUMBER = re.compile(r"(?:\([0-9]+\)|[0-9]+)\Z")


class TagFileChanged(Exception):
    """The open file differs from the scanner's directory entry."""


class _MediaFile:
    """Bound parser reads and check cancellation between file operations."""

    def __init__(self, handle, cancel, fingerprint=None):
        self.handle = handle
        self.size = self.check_fingerprint(fingerprint).st_size
        self.cancel = cancel
        self.remaining = _READ_LIMIT

    def check_fingerprint(self, fingerprint):
        info = os.fstat(self.handle.fileno())
        if fingerprint is not None and (not S_ISREG(info.st_mode) or (info.st_size, info.st_mtime_ns) != fingerprint):
            raise TagFileChanged()
        return info

    def _check_cancel(self):
        if self.cancel is not None and self.cancel.is_set():
            raise ValueError("Cancelled tag read")

    def tell(self):
        return self.handle.tell()

    def seek(self, offset, whence=0):
        self._check_cancel()
        return self.handle.seek(offset, whence)

    def read(self, size):
        self._check_cancel()
        if not 0 <= size <= self.remaining:
            raise ValueError("Tag read limit exceeded")
        self.remaining -= size
        return self.handle.read(size)


class _MP3File:
    def __init__(self, file):
        self.file = file
        self.size = file.size
        self.position = 0
        self.head = file.read(min(self.size, _MP3_HEAD))
        self.tail_start = max(len(self.head), self.size - _MP3_TAIL)
        self.tail = b""
        if self.tail_start < self.size:
            file.seek(self.tail_start)
            self.tail = file.read(self.size - self.tail_start)

    def tell(self):
        return self.position

    def seek(self, offset, whence=0):
        self.file._check_cancel()
        origins = (0, self.position, self.size)
        self.position = origins[whence] + offset
        if self.position < 0:
            raise ValueError("Negative MP3 file position")
        return self.position

    def cached(self, start, size):
        if start < len(self.head):
            data = self.head[start:start + size]
            if self.tail_start == len(self.head) and len(data) < size:
                data += self.tail[:size - len(data)]
            return data
        if start >= self.tail_start:
            offset = start - self.tail_start
            return self.tail[offset:offset + size]
        return b""

    def read(self, size):
        self.file._check_cancel()
        size = min(size, max(0, self.size - self.position))
        data = self.cached(self.position, size)
        if len(data) < size:
            self.file.seek(self.position + len(data))
            data += self.file.read(size - len(data))
        self.position += len(data)
        return data


def _read(file, size):
    data = file.read(size)
    if len(data) != size:
        raise ValueError("Truncated metadata")
    return data


def _integer(file, size, order="big"):
    return int.from_bytes(_read(file, size), order)


def _synchsafe(data):
    value = 0
    for byte in data:
        if byte & 128:
            raise ValueError("Invalid ID3 size")
        value = (value << 7) | byte
    return value


def _picture(file, end, mime=None):
    if end - file.tell() < 8:
        raise ValueError("Truncated cover")
    signature = _read(file, 8)
    if (mime in _IMAGE_MIMES or signature.startswith((b"\xff\xd8\xff", b"\x89PNG\r\n\x1a\n",
                                                        b"GIF87a", b"GIF89a", b"BM"))):
        return True
    raise ValueError("Unknown cover format")


def _id3_header(file, limit):
    start = file.tell()
    header = file.read(10)
    if not header.startswith(b"ID3"):
        file.seek(start)
        return start, 0
    if len(header) != 10 or header[3] not in (2, 3, 4) or header[5]:
        raise ValueError("Unsupported ID3 header")
    end = start + 10 + _synchsafe(header[6:])
    if end > limit:
        raise ValueError("Truncated ID3 tag")
    return end, header[3]


def _id3_text(data):
    return data[1:].decode(("latin-1", "utf-16", "utf-16-be", "utf-8")[data[0]])


def _id3_tags(file, end, version):
    tags, cover = {}, False
    key_size = 3 if version == 2 else 4
    header_size = 6 if version == 2 else 10
    while file.tell() + header_size <= end:
        header = _read(file, header_size)
        key = header[:key_size]
        if not key[0]:
            break
        length = (_synchsafe(header[4:8]) if version == 4
                  else int.from_bytes(header[key_size:key_size * 2], "big"))
        frame_end = file.tell() + length
        if frame_end > end or (version != 2 and header[9]) or key in (b"CHAP", b"CTOC"):
            raise ValueError("Unsupported ID3 frame")
        if length and key in (b"APIC", b"PIC"):
            encoding = _integer(file, 1)
            if version == 2:
                mime = {b"JPG": b"image/jpeg", b"PNG": b"image/png"}.get(_read(file, 3))
            else:
                mime = bytearray()
                while len(mime) < 64 and file.tell() < frame_end:
                    byte = _read(file, 1)
                    if byte == b"\0":
                        break
                    mime.extend(byte)
                mime = bytes(mime).lower()
            _read(file, 1)  # picture type
            unit = 2 if encoding in (1, 2) else 1
            description_end = min(frame_end, file.tell() + 4096)
            while file.tell() + unit <= description_end:
                if _read(file, unit) == bytes(unit):
                    break
            else:
                raise ValueError("Invalid ID3 picture description")
            cover |= _picture(file, frame_end, mime)
        elif length and key.startswith(b"T"):
            if length > _COMMENT_LIMIT:
                raise ValueError("Oversized ID3 text")
            values = _id3_text(_read(file, length)).split("\0")
            if key in (b"TXXX", b"TXX") and len(values) > 1:
                name, value = (part.lstrip("\ufeff") for part in values[:2])
                tags.setdefault(name.casefold().encode("utf-8"), value)
            elif key not in (b"TXXX", b"TXX") and values[0]:
                tags.setdefault(key, values[0])
        file.seek(frame_end)
    return {_ID3_KEYS.get(key, key.decode("utf-8").lower()): value for key, value in tags.items()}, cover


def _vorbis_tags(file, end):
    file.seek(_integer(file, 4, "little"), 1)
    count = _integer(file, 4, "little")
    if file.tell() > end or count > (end - file.tell()) // 4:
        raise ValueError("Invalid Vorbis comment list")
    tags = {}
    for _ in range(count):
        size = _integer(file, 4, "little")
        if file.tell() + size > end or size > _COMMENT_LIMIT:
            raise ValueError("Oversized Vorbis comment")
        data = _read(file, size)
        key, delimiter, value = data.partition(b"=")
        key = key.decode("ascii").lower()
        if key == "metadata_block_picture" or key.startswith("chapter"):
            raise ValueError("Vorbis cover or chapters")
        if not key.startswith(("replaygain_", "r128_")):
            value = value.split(b"\0", 1)[0]
        value = value.decode("utf-8")
        if delimiter and key and value:
            tags.setdefault(key, []).append(value)
    return {_VORBIS_KEYS.get(key, key): tuple(values) if key.startswith(("replaygain_", "r128_"))
            else ";".join(values) for key, values in tags.items()}


def _flac(file):
    id3_end, version = _id3_header(file, file.size)
    id3_start = file.tell()
    file.seek(id3_end)
    marker = _read(file, 8)
    if marker[:4] != b"fLaC" or marker[4] not in (0, 128) or marker[5:] != b"\x00\x00\x22":
        raise ValueError("Missing FLAC stream info")
    stream_info = _read(file, 34)
    frame_size = max(6, int.from_bytes(stream_info[4:7], "big"))
    tags, cover, comments = {}, False, False
    block = marker[4]
    while not block & 128:
        block, *length = _read(file, 4)
        end = file.tell() + int.from_bytes(length, "big")
        if end + frame_size > file.size:
            raise ValueError("Truncated FLAC block")
        block_type = block & 127
        if block_type == 4:
            if comments:
                raise ValueError("Multiple FLAC comment blocks")
            comments = True
            tags = _vorbis_tags(file, end)
        elif block_type == 6:
            _read(file, 4)  # picture type
            mime_size = _integer(file, 4)
            if mime_size > 64 or file.tell() + mime_size + 24 > end:
                raise ValueError("Invalid FLAC cover")
            mime = _read(file, mime_size).lower()
            file.seek(_integer(file, 4) + 16, 1)  # description and dimensions
            size = _integer(file, 4)
            if file.tell() + size != end:
                raise ValueError("Invalid FLAC picture size")
            cover |= _picture(file, end, mime)
        elif block_type not in (1, 2, 3):
            raise ValueError("Unsupported FLAC block")
        file.seek(end)
    if file.tell() + frame_size > file.size:
        raise ValueError("Truncated FLAC audio")
    sync = _read(file, 2)
    if sync[0] != 255 or sync[1] & 254 != 248:
        raise ValueError("Missing FLAC audio")
    if version and not tags:
        file.seek(id3_start)
        tags, id3_cover = _id3_tags(file, id3_end, version)
        if id3_cover or _NUMBERED_GENRE.match(tags.get("genre", "")):
            raise ValueError("FLAC with ID3 cover or numbered genre")
    return tags, cover


class _MP3Frame(NamedTuple):
    length: int
    bitrate: int
    sample_rate: int
    samples: int
    channels: int
    side_info: int


def _mp3_frame(data):
    sync, header, rate, mode = data
    version = (header >> 3) & 3
    index, sample = rate >> 4, (rate >> 2) & 3
    if sync != 255 or header & 230 != 226 or version == 1 or index in (0, 15) or sample == 3:
        raise ValueError("Missing MPEG Layer III frame")
    high = version == 3
    sample_rate = (44100, 48000, 32000)[sample] >> (0 if high else 1 if version == 2 else 2)
    rates = ((0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320) if high
             else (0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160))
    bitrate = rates[index]
    samples = 1152 if high else 576
    length = samples * 125 * bitrate // sample_rate + ((rate >> 1) & 1)
    channels = 1 if mode >> 6 == 3 else 2
    side_info = (17 if channels == 1 else 32) if high else (9 if channels == 1 else 17)
    return _MP3Frame(length, bitrate, sample_rate, samples, channels, side_info)


def _mp3_sync(file, start, end, window):
    # Leave space beyond the search window to check the next frame header.
    size = min(end - start, window + 2048)
    cached = file.cached(start, size)
    result = _mp3_find_frame(cached, start, end, window)
    if result is None and len(cached) < size:
        file.seek(start)
        result = _mp3_find_frame(file.read(size), start, end, window)
    if result is None:
        raise ValueError("Missing consecutive MP3 frames")
    return result


def _mp3_find_frame(data, start, end, window):
    offset = data.find(b"\xff", 0, window)
    while offset >= 0 and offset + 4 <= len(data):
        try:
            frame = _mp3_frame(data[offset:offset + 4])
            following = offset + frame.length
            next_frame = _mp3_frame(data[following:following + 4])
            if frame.sample_rate == next_frame.sample_rate and start + following + next_frame.length <= end:
                return start + offset, frame, next_frame
        except ValueError:
            pass
        offset = data.find(b"\xff", offset + 1, window)
    return None


def _mp3_audio_end(file, start):
    end = file.size
    id3v1 = ape = False
    for _ in range(2):
        if not id3v1 and end - start >= 128:
            file.seek(end - 128)
            if _read(file, 3) == b"TAG":
                end -= 128
                id3v1 = True
                continue
        if not ape and end - start >= 32:
            file.seek(end - 32)
            footer = _read(file, 32)
            if footer.startswith(b"APETAGEX"):
                size, _, flags = unpack_from("<III", footer, 12)
                size += 32 if flags & 0x80000000 else 0
                if size < 32 or size > end - start:
                    raise ValueError("Invalid MP3 APE tag")
                end -= size
                ape = True
                continue
        break
    return end, id3v1


def _short_mp3_duration(head, start, end, expected):
    if end > len(head):
        return None
    for count in range(1, 6):
        frame = _mp3_frame(head[start:min(start + 4, end)])
        if (frame.bitrate, frame.sample_rate) != expected:
            raise ValueError("MP3 frame formats differ")
        start += frame.length
        if start == end:
            return count * frame.samples / frame.sample_rate
        if start > end:
            raise ValueError("Truncated MP3 frame")
    return None


def _mp3(file):
    start, version = _id3_header(file, file.size)
    tags, cover = _id3_tags(file, start, version) if version else ({}, False)
    end, id3v1 = _mp3_audio_end(file, start)
    if id3v1 and version and not tags:
        raise ValueError("Mixed ID3 tags")
    start, frame, following = _mp3_sync(file, start, end, 64 * 1024)
    file.seek(start + 4)
    header = _read(file, min(frame.length - 4, 52))
    duration = _mp3_duration(file, start, end, frame, following, header)
    return tags, cover, duration, frame.sample_rate, frame.channels, id3v1 and not version


def _mp3_duration(file, start, end, frame, following, header):
    for offset in (frame.side_info, frame.side_info + 2):
        if header[offset:offset + 4] in (b"Info", b"Xing"):
            if len(header) < offset + 12 or not header[offset + 7] & 1:
                raise ValueError("MP3 header has no frame count")
            count = int.from_bytes(header[offset + 8:offset + 12], "big")
            break
    else:
        count = int.from_bytes(header[46:50], "big") if header[32:36] == b"VBRI" else None
    if count is not None:
        if not count:
            raise ValueError("MP3 header has no frame count")
        return count * frame.samples / frame.sample_rate

    expected = (frame.bitrate, frame.sample_rate)
    if (following.bitrate, following.sample_rate) != expected:
        raise ValueError("MP3 frame formats differ")
    short = _short_mp3_duration(file.head, start, end, expected)
    if short is not None:
        return short
    span = max(0, end - start - 3 * max(frame.length, following.length))
    for sample in range(1, 4):
        _, sampled, next_frame = _mp3_sync(file, start + span * sample // 3, end, 8192)
        if any((candidate.bitrate, candidate.sample_rate) != expected for candidate in (sampled, next_frame)):
            raise ValueError("MP3 frame formats differ")
    return (end - start) * 8 / (frame.bitrate * 1000)


def _chunks(file, end, order):
    while file.tell() < end:
        key = _read(file, 4)
        size = _integer(file, 4, order)
        start = file.tell()
        tail = start + size + size % 2
        if tail > end:
            raise ValueError("Truncated audio chunk")
        yield key, start, size
        file.seek(tail)


def _pcm(file, wave):
    order = "little" if wave else "big"
    marker, size, form = _read(file, 4), _integer(file, 4, order), _read(file, 4)
    if size + 8 != file.size or (marker, form) not in (
            {(b"RIFF", b"WAVE")} if wave else {(b"FORM", b"AIFF"), (b"FORM", b"AIFC")}):
        raise ValueError("Unsupported PCM container")
    tags, embedded, cover, chunks, codec = {}, {}, False, set(), None
    audio_sizes = None
    broadcast_date = None
    for key, start, size in _chunks(file, file.size, order):
        if key in (b"data", b"SSND", b"fmt ", b"COMM", b"ID3 ", b"id3 ") and key in chunks:
            raise ValueError("Repeated audio chunk")
        chunks.add(key)
        if wave and key == b"fmt " and 16 <= size <= 40:
            fmt = _read(file, size)
            code, channels, _, _, align, bits = unpack_from("<HHIIHH", fmt)
            if not align or align != (channels * bits) // 8:
                raise ValueError("Invalid PCM block alignment")
            if code == 65534 and len(fmt) == 40 and fmt[26:] == bytes.fromhex("000000001000800000aa00389b71"):
                valid, = unpack_from("<H", fmt, 18)
                code, = unpack_from("<H", fmt, 24)
                if valid not in (0, bits):
                    raise ValueError("PCM bit depths differ")
            codec = ({8: "pcm_u8", 16: "pcm_s16le", 24: "pcm_s24le", 32: "pcm_s32le",
                      64: "pcm_s64le"}.get(bits) if code == 1 else
                     {32: "pcm_f32le", 64: "pcm_f64le"}.get(bits) if code == 3 else None)
        elif wave and key == b"data":
            if not codec or not size or size % align:
                raise ValueError("Incomplete WAVE audio")
            # Some DTS and IEC 61937 files identify themselves as PCM in fmt.
            sync = file.read(min(size, 4))
            if sync in (b"\xff\x1f\x00\xe8", b"\xfe\x7f\x01\x80", b"\x72\xf8\x1f\x4e"):
                raise ValueError("Non-PCM WAVE data")
        elif not wave and key == b"COMM" and 18 <= size <= 256:
            fmt = _read(file, size)
            channels, frames, bits = unpack_from(">HIH", fmt)
            compression = fmt[18:22] if form == b"AIFC" else b"NONE"
            if compression in (b"NONE", b"sowt") and bits in (8, 16, 24, 32):
                codec = "pcm_s8" if bits == 8 else f"pcm_s{bits}{'le' if compression == b'sowt' else 'be'}"
        elif not wave and key == b"SSND":
            if not codec or size < 8:
                raise ValueError("Incomplete AIFF audio")
            offset = _integer(file, 4)
            audio_sizes = size - 8 - offset, frames * channels * (bits // 8)
        elif wave and key in (b"LIST", b"list") and size >= 4 and _read(file, 4) == b"INFO":
            for field, _, length in _chunks(file, start + size, order):
                name = field.decode("ascii").lower()
                value = _read(file, length).split(b"\0", 1)[0].decode("utf-8")
                tags[name] = value
        elif wave and key == b"bext":
            if size < 602 or broadcast_date is not None:
                raise ValueError("Unsupported broadcast WAVE header")
            file.seek(start + 320)
            broadcast_date = _read(file, 10).split(b"\0", 1)[0].decode("utf-8")
        elif not wave and key == b"NAME":
            tags["title"] = _read(file, size).split(b"\0", 1)[0].decode("utf-8")
        elif key in (b"ID3 ", b"id3 "):
            if key != b"ID3 " and not wave:
                raise ValueError("Nonstandard AIFF ID3 chunk")
            end, version = _id3_header(file, start + size)
            if not version or embedded:
                raise ValueError("Invalid embedded ID3 tag")
            embedded, cover = _id3_tags(file, end, version)
        elif key in (b"cue ", b"smv ", b"SMV0", b"MARK", b"XMA2"):
            raise ValueError("PCM markers or video")
    if not codec or (b"data" if wave else b"SSND") not in chunks:
        raise ValueError("Unknown PCM format")
    if audio_sizes and audio_sizes[0] != audio_sizes[1]:
        raise ValueError("AIFF sample count does not match its data")
    if wave:
        tags = {_WAVE_KEYS.get(key, key): value for key, value in tags.items()}
        if broadcast_date:
            if "date" in tags and tags["date"] != broadcast_date:
                raise ValueError("Overlapping WAVE dates")
            tags["date"] = broadcast_date
    # Native and embedded metadata precedence can depend on the demuxer version.
    if _NUMBERED_GENRE.match(embedded.get("genre", "")):
        raise ValueError("PCM with numbered ID3 genre")
    if any(tags[key] != embedded[key] for key in tags.keys() & embedded.keys()):
        raise ValueError("Overlapping PCM tags")
    return {**tags, **embedded}, cover, codec


def _atoms(file, start, end):
    file.seek(start)
    while file.tell() < end:
        offset = file.tell()
        size, key = unpack(">I4s", _read(file, 8))
        if size == 1:
            size = _integer(file, 8)
        tail = offset + size if size else end
        if not file.tell() <= tail <= end:
            raise ValueError("Invalid MP4 atom size")
        yield key, file.tell(), tail
        file.seek(tail)


def _mp4(file):
    cover = False
    track = False
    movie = False
    media_data = False
    tags = {}
    if _read(file, 8)[4:] != b"ftyp":
        raise ValueError("Missing MP4 file type")
    for key, start, end in _atoms(file, 0, file.size):
        if key in (b"moof", b"uuid", b"meta"):
            raise ValueError("Unsupported MP4 layout")
        if key == b"mdat":
            media_data |= end > start
        if key != b"moov":
            continue
        if movie:
            raise ValueError("Multiple MP4 movies")
        movie = True
        for atom, body, tail in _atoms(file, start, end):
            if atom in (b"mvex", b"meta", b"uuid"):
                raise ValueError("Unsupported MP4 metadata")
            if atom == b"trak":
                if track:
                    raise ValueError("Multiple MP4 tracks")
                children = {key: (pos, limit) for key, pos, limit in _atoms(file, body, tail)}
                for child, pos, limit in _atoms(file, *children[b"mdia"]):
                    if child == b"hdlr" and limit - pos >= 12:
                        track = _read(file, 12)[8:] == b"soun"
                if not track or b"tref" in children:
                    raise ValueError("Non-audio MP4 track or chapter reference")
            elif atom == b"udta":
                for child, pos, limit in _atoms(file, body, tail):
                    if child != b"meta":
                        raise ValueError("MP4 chapters or alternate metadata")
                    for field, first, last in _atoms(file, pos + 4, limit):
                        if field != b"ilst":
                            continue
                        for title, contents, stop in _atoms(file, first, last):
                            if title == b"covr":
                                for entry, data, data_end in _atoms(file, contents, stop):
                                    if not track or entry != b"data" or _integer(file, 4) not in (13, 14, 27):
                                        raise ValueError("Unsupported MP4 cover")
                                    file.seek(data + 8)
                                    cover |= _picture(file, data_end)
                            elif title == b"----":
                                name = value = None
                                for entry, data, data_end in _atoms(file, contents, stop):
                                    if entry == b"name" and 4 < data_end - data <= 256:
                                        file.seek(data + 4)
                                        name = _read(file, data_end - data - 4).decode("utf-8", "replace").casefold()
                                    elif entry == b"data" and 8 < data_end - data <= _COMMENT_LIMIT:
                                        if _integer(file, 4) == 1:
                                            file.seek(data + 8)
                                            value = _read(file, data_end - data - 8).decode("utf-8", "replace")
                                if name and name.startswith("replaygain_") and value is not None:
                                    tags.setdefault(name, value)
    if not track or not media_data:
        raise ValueError("Missing MP4 audio data")
    return cover, tags


def _ogg(file):
    serial = None
    packet = bytearray()
    headers = []
    while file.tell() < file.size:
        page = _read(file, 27)
        if page[:5] != b"OggS\0" or page[5] & ~7:
            raise ValueError("Invalid Ogg page")
        flags = page[5]
        if serial is None:
            serial = page[14:18]
            if flags != 2:
                raise ValueError("Missing Ogg stream start")
        elif page[14:18] != serial or flags & 2:
            raise ValueError("Multiple Ogg streams")
        segments = _read(file, page[26])
        if file.tell() + sum(segments) > file.size:
            raise ValueError("Truncated Ogg page")
        for index, segment in enumerate(segments):
            if len(headers) == 2:
                file.seek(sum(segments[index:]), 1)
                break
            if len(packet) + segment > _COMMENT_LIMIT:
                raise ValueError("Oversized Ogg comment")
            packet.extend(_read(file, segment))
            if segment < 255:
                headers.append(bytes(packet))
                packet.clear()
        if flags & 4:
            if file.tell() != file.size:
                raise ValueError("Chained Ogg stream")
            break
    else:
        raise ValueError("Missing Ogg stream end")
    head, comment = headers
    pre_skip = 0
    if head.startswith(b"OpusHead") and len(head) >= 19 and comment.startswith(b"OpusTags"):
        codec, offset = "opus", 8
        pre_skip = int.from_bytes(head[10:12], "little")
    elif head.startswith(b"\x01vorbis") and comment.startswith(b"\x03vorbis"):
        codec, offset = "vorbis", 7
    else:
        raise ValueError("Unsupported Ogg codec")
    data = BytesIO(comment)
    data.seek(offset)
    granule = int.from_bytes(page[6:14], "little", signed=True)
    return _vorbis_tags(data, len(comment)), codec, granule - pre_skip


def _tiny_tags(tag):
    tags = {name: values[0] for name, values in tag.other.items() if values and not name.startswith("_")}
    for field, name in (("title", "title"), ("artist", "artist"), ("album", "album"), ("albumartist", "album_artist"),
                        ("composer", "composer"), ("genre", "genre"), ("year", "date")):
        value = getattr(tag, field)
        if value is not None:
            tags[name] = value
    for field, total in (("track", tag.track_total), ("disc", tag.disc_total)):
        if (value := getattr(tag, field)) is not None:
            tags[field] = f"{value}/{total}" if total else str(value)
    return tags


def read_tags(path, ext, *, rel=None, root_name=None, numbered=False, cancel=None,
              fingerprint=None) -> dict | None:
    """Map a supported, unambiguous audio file through the existing probe rules."""
    try:
        ext = ext.lower().lstrip(".")
        if TinyTag is None or ext not in TAG_EXTENSIONS:
            return None
        path = os.fsdecode(path)
        with open(absolute_disk_path(os.path.abspath(path)), "rb") as handle:
            media_file = file = _MediaFile(handle, cancel, fingerprint)
            container, codec, cover = ext, ext, False
            if ext == "flac":
                tags, cover = _flac(file)
            elif ext == "mp3":
                file = _MP3File(file)
                tags, cover, duration, sample_rate, channels, id3v1 = _mp3(file)
            elif ext in ("wav", "aiff", "aif"):
                container = "wav" if ext == "wav" else "aiff"
                tags, cover, codec = _pcm(file, ext == "wav")
            elif ext == "m4a":
                container = "mov,mp4,m4a,3gp,3g2,mj2"
                cover, tags = _mp4(file)
            else:
                container = "ogg"
                tags, codec, granule = _ogg(file)
                if ext == "opus" and codec != "opus":
                    return None
            if ext == "mp3":
                bits = None
                numbered_genre = _NUMBERED_GENRE.match(tags.get("genre", ""))
                if id3v1 or numbered_genre:
                    file.seek(0)
                    tag = TinyTag.get(filename=path, file_obj=file, tags=True, duration=False, image=False)
                    if id3v1:
                        tags = {
                            **{key: value for key, value in _tiny_tags(tag).items()
                               if not key.startswith("replaygain_")},
                            **{key: value for key, value in tags.items() if key.startswith("replaygain_")},
                        }
                    elif not _SIMPLE_GENRE_NUMBER.fullmatch(tags["genre"]) or not tag.genre:
                        return None
                    else:
                        tags["genre"] = tag.genre
            else:
                file.seek(0)
                tag = TinyTag.get(filename=path, file_obj=file, tags=ext in ("m4a", "ogg", "opus"), image=False)
                duration, sample_rate, channels, bits = tag.duration, tag.samplerate, tag.channels, tag.bitdepth
                if not sample_rate or not channels:
                    return None
                if ext == "m4a":
                    codec = {'audio/mp4; codecs="mp4a.40.2"': "aac",
                             'audio/mp4; codecs="alac"': "alac"}.get(tag.mime_type)
                    if not codec:
                        return None
                    tags = {**_tiny_tags(tag), **tags}
                elif container == "ogg":
                    duration = granule / (48000 if codec == "opus" else sample_rate)
                    if tag.mime_type != f'audio/ogg; codecs="{codec}"':
                        return None
            if duration and (not math.isfinite(duration) or duration > 10_000_000):
                return None
            duration = duration if duration and duration > 0 else None
            bitrate = int(file.size * 8 / duration) if duration is not None else None
            if fingerprint is not None:
                media_file.check_fingerprint(fingerprint)
        streams = [{"codec_type": "audio", "codec_name": codec, "sample_rate": sample_rate,
                    "channels": channels, "bits_per_raw_sample": bits}]
        if cover:
            streams.append({"codec_type": "video", "index": 1, "disposition": {"attached_pic": 1}})
        if rel is None:
            rel = os.path.basename(path)
        if root_name is None:
            root_name = PurePosixPath(path.replace("\\", "/")).parent.name
        return probe_fields({"format": {"tags": tags, "format_name": container, "duration": duration,
                                        "bit_rate": bitrate}, "streams": streams}, rel, root_name, numbered=numbered)
    except TagFileChanged:
        raise
    except Exception:
        return None
