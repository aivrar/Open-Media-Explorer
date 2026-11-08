"""Favicon (.ico / icon-MIME) artwork normalization for the asset relay."""
from __future__ import annotations

import base64
import struct
import unittest
import zlib

from worldmedia_catalog import (
    CatalogError,
    MAX_ICON_ENTRIES,
    normalize_artwork,
    validate_image,
)

PNG_1X1 = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII="
)


def ico(images: list[tuple[int, int, int, bytes]]) -> bytes:
    """Build an .ico from (width, height, bpp, payload) tuples."""
    header = struct.pack("<HHH", 0, 1, len(images))
    offset = 6 + 16 * len(images)
    directory = b""
    body = b""
    for width, height, bpp, payload in images:
        directory += struct.pack(
            "<BBBBHHII", width % 256, height % 256, 0, 0, 1, bpp, len(payload), offset + len(body),
        )
        body += payload
    return header + directory + body


def dib(width: int, height: int, bpp: int, pixel_rows: bytes, *, palette: bytes = b"", mask: bytes | None = None) -> bytes:
    header = struct.pack("<IiiHHIIiiII", 40, width, height * 2, 1, bpp, 0, 0, 0, 0, len(palette) // 4, 0)
    if mask is None:
        mask = b"\x00" * (((width + 31) // 32) * 4 * height)
    return header + palette + pixel_rows + mask


def decode_png_rgba(data: bytes) -> tuple[int, int, list[bytes]]:
    width, height = struct.unpack(">II", data[16:24])
    offset, idat = 8, b""
    while offset < len(data):
        length = int.from_bytes(data[offset:offset + 4], "big")
        kind = data[offset + 4:offset + 8]
        if kind == b"IDAT":
            idat += data[offset + 8:offset + 8 + length]
        offset += 12 + length
    raw = zlib.decompress(idat)
    stride = width * 4 + 1
    return width, height, [raw[y * stride + 1:(y + 1) * stride] for y in range(height)]


class IconArtworkTests(unittest.TestCase):
    def test_32bpp_icon_becomes_valid_png_with_alpha_and_top_down_rows(self) -> None:
        # 2x2 BGRA, stored bottom-up: bottom row red/green, top row blue/transparent.
        bottom = bytes((0, 0, 255, 255, 0, 255, 0, 255))
        top = bytes((255, 0, 0, 255, 0, 0, 0, 0))
        data, mime = normalize_artwork(ico([(2, 2, 32, dib(2, 2, 32, bottom + top))]), "image/x-icon")
        self.assertEqual(mime, "image/png")
        self.assertEqual(validate_image(data, mime), (2, 2))
        _, _, rows = decode_png_rgba(data)
        self.assertEqual(rows[0], bytes((0, 0, 255, 255, 0, 0, 0, 0)))
        self.assertEqual(rows[1], bytes((255, 0, 0, 255, 0, 255, 0, 255)))

    def test_8bpp_palette_icon_uses_and_mask_for_transparency(self) -> None:
        palette = bytes((0, 0, 255, 0, 255, 255, 255, 0))  # index0 = red, index1 = white (BGRx)
        pixels = bytes((0, 1, 0, 0))  # one 2-pixel row padded to 4 bytes
        mask = bytes((0b01000000, 0, 0, 0))  # second pixel transparent
        data, mime = normalize_artwork(
            ico([(2, 1, 8, dib(2, 1, 8, pixels, palette=palette, mask=mask))]), "image/vnd.microsoft.icon",
        )
        self.assertEqual(validate_image(data, mime), (2, 1))
        _, _, rows = decode_png_rgba(data)
        self.assertEqual(rows[0], bytes((255, 0, 0, 255, 255, 255, 255, 0)))

    def test_largest_entry_wins_and_embedded_png_is_used_directly(self) -> None:
        small = dib(1, 1, 24, b"\x00\x00\x00\x00")
        data, mime = normalize_artwork(ico([(1, 1, 24, small), (64, 64, 32, PNG_1X1)]), "image/x-icon")
        self.assertEqual((data, mime), (PNG_1X1, "image/png"))

    def test_png_served_with_icon_mime_and_ico_served_as_png_are_recovered(self) -> None:
        self.assertEqual(normalize_artwork(PNG_1X1, "image/x-icon"), (PNG_1X1, "image/png"))
        icon = ico([(1, 1, 32, dib(1, 1, 32, b"\x10\x20\x30\xff"))])
        data, mime = normalize_artwork(icon, "image/png")
        self.assertEqual(validate_image(data, mime), (1, 1))

    def test_other_images_are_untouched_and_strict_mismatch_rules_still_apply(self) -> None:
        self.assertEqual(normalize_artwork(PNG_1X1, "image/png"), (PNG_1X1, "image/png"))
        data, mime = normalize_artwork(PNG_1X1, "image/jpeg")
        with self.assertRaises(CatalogError) as caught:
            validate_image(data, mime)
        self.assertEqual(caught.exception.code, "ASSET_MAGIC_MISMATCH")

    def test_malformed_hostile_and_oversized_icons_are_rejected(self) -> None:
        good = dib(1, 1, 32, b"\x00\x00\x00\xff")
        too_wide = dib(300, 1, 32, b"\x00" * 1200)
        compressed = bytearray(dib(1, 1, 32, b"\x00\x00\x00\xff"))
        compressed[16:20] = (1).to_bytes(4, "little")  # BI_RLE8 is not supported
        bad_palette = dib(1, 1, 8, b"\x05\x00\x00\x00", palette=b"\x00\x00\x00\x00")
        cases = {
            "html with icon mime": (b"<html>nope</html>", "image/x-icon", "ASSET_TYPE_REJECTED"),
            "truncated directory": (b"\x00\x00\x01\x00\x05\x00", "image/x-icon", "ASSET_ICON_REJECTED"),
            "entry points outside file": (ico([(1, 1, 32, good)])[:-4], "image/x-icon", "ASSET_ICON_REJECTED"),
            "too many entries": (struct.pack("<HHH", 0, 1, MAX_ICON_ENTRIES + 1) + b"\x00" * 16 * 65, "image/x-icon", "ASSET_ICON_REJECTED"),
            "too wide": (ico([(0, 1, 32, too_wide)]), "image/x-icon", "ASSET_ICON_REJECTED"),
            "compressed bitmap": (ico([(1, 1, 32, bytes(compressed))]), "image/x-icon", "ASSET_ICON_REJECTED"),
            "palette index out of range": (ico([(1, 1, 8, bad_palette)]), "image/x-icon", "ASSET_ICON_REJECTED"),
        }
        for name, (payload, mime, code) in cases.items():
            with self.subTest(name), self.assertRaises(CatalogError) as caught:
                normalize_artwork(payload, mime)
            self.assertEqual(caught.exception.code, code)

    def test_embedded_png_payload_must_still_pass_strict_validation(self) -> None:
        broken_png = PNG_1X1[:-12]  # missing IEND
        data, mime = normalize_artwork(ico([(1, 1, 32, broken_png)]), "image/x-icon")
        with self.assertRaises(CatalogError):
            validate_image(data, mime)


JPEG_1X1 = base64.b64decode(
    "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDABALDA4MChAODQ4SERATGCgaGBYWGDEjJR0oOjM9PDkzODdASFxOQERXRTc4UG1RV19iZ2hnPk1xeXBkeFxlZ2P/"
    "2wBDARESEhgVGC8aGi9jQjhCY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2P/wAARCAABAAEDASIAAhEBAxEB/8QA"
    "HwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkK"
    "FhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXG"
    "x8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAEC"
    "AxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOE"
    "hYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDAooorgPrT/9k="
)


class DamagedArtworkRepairTests(unittest.TestCase):
    def test_trailing_junk_after_png_iend_is_trimmed(self) -> None:
        data, mime = normalize_artwork(PNG_1X1 + b"\x00" * 1045, "image/png")
        self.assertEqual((data, mime), (PNG_1X1, "image/png"))
        self.assertEqual(validate_image(data, mime), (1, 1))

    def test_trailing_whitespace_after_jpeg_end_marker_is_trimmed(self) -> None:
        self.assertEqual(validate_image(JPEG_1X1, "image/jpeg"), (1, 1))
        data, mime = normalize_artwork(JPEG_1X1 + b"\r\n " * 700, "image/jpeg; charset=binary")
        self.assertEqual(data, JPEG_1X1)
        self.assertEqual(validate_image(data, mime), (1, 1))

    def test_image_served_as_octet_stream_gets_its_real_type(self) -> None:
        for payload, expected in ((PNG_1X1, "image/png"), (JPEG_1X1 + b"\n", "image/jpeg")):
            with self.subTest(expected):
                data, mime = normalize_artwork(payload, "application/octet-stream")
                self.assertEqual(mime, expected)
                self.assertEqual(validate_image(data, mime), (1, 1))
        icon = ico([(1, 1, 32, dib(1, 1, 32, b"\x00\x00\xff\xff"))])
        self.assertEqual(normalize_artwork(icon, "binary/octet-stream")[1], "image/png")

    def test_non_images_and_svg_are_still_refused(self) -> None:
        for payload in (b"<!DOCTYPE html><html></html>", b"you should update client",
                        b'<svg xmlns="http://www.w3.org/2000/svg"><script>x()</script></svg>'):
            with self.subTest(payload[:12]), self.assertRaises(CatalogError) as caught:
                normalize_artwork(payload, "application/octet-stream")
            self.assertEqual(caught.exception.code, "ASSET_TYPE_REJECTED")

    def test_repairs_never_relax_the_mime_and_bytes_agreement(self) -> None:
        # A PNG labelled as JPEG is left alone, so validation still rejects it.
        data, mime = normalize_artwork(PNG_1X1 + b"junk", "image/jpeg")
        with self.assertRaises(CatalogError) as caught:
            validate_image(data, mime)
        self.assertEqual(caught.exception.code, "ASSET_MAGIC_MISMATCH")
        # Truncated images are not "repaired" into something that passes.
        for payload, label in ((PNG_1X1[:-12], "image/png"), (JPEG_1X1[:-2], "image/jpeg")):
            with self.subTest(label), self.assertRaises(CatalogError):
                validate_image(*normalize_artwork(payload, label))


if __name__ == "__main__":
    unittest.main()
