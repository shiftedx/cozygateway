"""Unit matrix for the byte-sniffing MediaDescriptor (media hardening lane A).

Every fixture is synthesized in code. No binary files are committed.
"""

import os
import struct
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

from cozygateway.media_descriptor import (
    DESCRIPTOR_CACHE_MAX,
    MEDIA_COMPATIBILITY_POLICY,
    SUPPORTED_MIME_TYPES,
    MediaProbeError,
    clear_descriptor_cache,
    detect_mime,
    evaluate_compatibility,
    probe,
)


# ---------------------------------------------------------------------------
# Fixture builders
# ---------------------------------------------------------------------------


def png_bytes(width=1, height=1):
    header = b"\x89PNG\r\n\x1a\n"
    ihdr_payload = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)
    ihdr = struct.pack(">I", len(ihdr_payload)) + b"IHDR" + ihdr_payload + b"\x00\x00\x00\x00"
    iend = struct.pack(">I", 0) + b"IEND" + b"\xae\x42\x60\x82"
    return header + ihdr + iend


def jpeg_bytes():
    return b"\xff\xd8\xff\xe0\x00\x10JFIF\x00\x01\x01\x00\x00\x01\x00\x01\x00\x00" + b"\xff\xd9"


def gif_bytes():
    return b"GIF89a" + struct.pack("<HH", 1, 1) + b"\x00\x00\x00" + b";"


def webp_bytes():
    body = b"WEBPVP8 " + struct.pack("<I", 4) + b"\x00\x00\x00\x00"
    return b"RIFF" + struct.pack("<I", len(body)) + body


def wav_bytes():
    fmt = b"fmt " + struct.pack("<IHHIIHH", 16, 1, 1, 8000, 8000, 1, 8)
    data = b"data" + struct.pack("<I", 4) + b"\x00\x00\x00\x00"
    body = b"WAVE" + fmt + data
    return b"RIFF" + struct.pack("<I", len(body)) + body


def mp3_bytes():
    id3 = b"ID3\x03\x00\x00" + b"\x00\x00\x00\x0a" + b"\x00" * 10
    frame = b"\xff\xfb\x90\x00" + b"\x00" * 100
    return id3 + frame


def pdf_bytes():
    return b"%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n%%EOF\n"


def svg_bytes():
    return b'<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"></svg>\n'


def html_bytes():
    return b"<!DOCTYPE html>\n<html><body><p>hi</p></body></html>\n"


def _zip_local_entry(name):
    raw = name.encode("ascii")
    return (
        b"PK\x03\x04"
        + struct.pack("<HHHHHIIIHH", 20, 0, 0, 0, 0, 0, 0, 0, len(raw), 0)
        + raw
    )


def bare_zip_bytes():
    return _zip_local_entry("notes/readme.txt") + b"payload"


def ooxml_zip_bytes():
    return _zip_local_entry("[Content_Types].xml") + b"<Types/>"


def _box(kind, payload=b""):
    return struct.pack(">I", 8 + len(payload)) + kind + payload


def _visual_sample_entry(fourcc, width=640, height=360):
    body = (
        b"\x00" * 6
        + b"\x00\x01"
        + b"\x00" * 16
        + struct.pack(">HH", width, height)
        + struct.pack(">II", 0x00480000, 0x00480000)
        + b"\x00" * 4
        + struct.pack(">H", 1)
        + b"\x00" * 32
        + struct.pack(">H", 24)
        + b"\xff\xff"
    )
    return _box(fourcc, body)


def _audio_sample_entry(fourcc, with_esds_oti=None):
    body = (
        b"\x00" * 6
        + b"\x00\x01"
        + b"\x00" * 8
        + struct.pack(">HH", 2, 16)
        + b"\x00" * 4
        + struct.pack(">I", 44100 << 16)
    )
    if with_esds_oti is not None:
        descriptor = b"\x03\x19\x00\x01\x00" + b"\x04\x11" + bytes([with_esds_oti]) + b"\x15" + b"\x00" * 11
        body += _box(b"esds", b"\x00\x00\x00\x00" + descriptor)
    return _box(fourcc, body)


def _stbl(entries):
    payload = b"\x00\x00\x00\x00" + struct.pack(">I", len(entries)) + b"".join(entries)
    return _box(b"stbl", _box(b"stsd", payload))


def _tkhd(width, height):
    payload = (
        b"\x00\x00\x00\x00"
        + struct.pack(">III", 0, 0, 1)
        + b"\x00" * 4
        + struct.pack(">I", 0)
        + b"\x00" * 8
        + struct.pack(">HHHH", 0, 0, 0, 0)
        + b"\x00" * 36
        + struct.pack(">II", width << 16, height << 16)
    )
    return _box(b"tkhd", payload)


def _mvhd(timescale=1000, duration=2500):
    payload = b"\x00\x00\x00\x00" + struct.pack(">IIII", 0, 0, timescale, duration) + b"\x00" * 60
    return _box(b"mvhd", payload)


def _trak(entries, width=640, height=360):
    mdia = _box(b"mdia", _box(b"minf", _stbl(entries)))
    return _box(b"trak", _tkhd(width, height) + mdia)


def mp4_bytes(video_fourcc=b"avc1", audio_fourcc=b"mp4a", audio_oti=0x40, brand=b"isom"):
    traks = b""
    if video_fourcc is not None:
        traks += _trak([_visual_sample_entry(video_fourcc)])
    if audio_fourcc is not None:
        traks += _trak([_audio_sample_entry(audio_fourcc, audio_oti)], width=0, height=0)
    ftyp = _box(b"ftyp", brand + b"\x00\x00\x02\x00" + b"isomiso2avc1mp41")
    moov = _box(b"moov", _mvhd() + traks)
    mdat = _box(b"mdat", b"\x00" * 32)
    return ftyp + moov + mdat


# ---------------------------------------------------------------------------


class MediaDescriptorTestCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)

    def write(self, name, payload):
        path = os.path.join(self.tmp.name, name)
        with open(path, "wb") as handle:
            handle.write(payload)
        return path


class ReadinessTests(MediaDescriptorTestCase):
    def test_missing_file_raises_actionable_error(self):
        path = os.path.join(self.tmp.name, "nope.png")
        with self.assertRaises(MediaProbeError) as ctx:
            probe(path)
        self.assertEqual(ctx.exception.code, "missing")
        self.assertIn("nope.png", str(ctx.exception))

    def test_zero_byte_file_raises(self):
        path = self.write("empty.png", b"")
        with self.assertRaises(MediaProbeError) as ctx:
            probe(path)
        self.assertEqual(ctx.exception.code, "empty")
        self.assertIn("zero bytes", str(ctx.exception))

    def test_directory_is_not_a_regular_file(self):
        path = os.path.join(self.tmp.name, "adir")
        os.mkdir(path)
        with self.assertRaises(MediaProbeError) as ctx:
            probe(path)
        self.assertEqual(ctx.exception.code, "not_regular")

    @unittest.skipIf(hasattr(os, "geteuid") and os.geteuid() == 0, "root ignores file permissions")
    def test_unreadable_file_raises(self):
        path = self.write("secret.png", png_bytes())
        os.chmod(path, 0o000)
        self.addCleanup(os.chmod, path, 0o600)
        with self.assertRaises(MediaProbeError) as ctx:
            probe(path)
        self.assertEqual(ctx.exception.code, "unreadable")

    def test_symlink_inside_allowed_roots_is_followed(self):
        target = self.write("real.png", png_bytes())
        link = os.path.join(self.tmp.name, "link.png")
        os.symlink(target, link)
        descriptor = probe(link, allowed_roots=[self.tmp.name])
        self.assertEqual(descriptor.realpath, os.path.realpath(target))
        self.assertEqual(descriptor.mime, "image/png")

    def test_symlink_escaping_allowed_roots_raises(self):
        outside = tempfile.TemporaryDirectory()
        self.addCleanup(outside.cleanup)
        target = os.path.join(outside.name, "outside.png")
        with open(target, "wb") as handle:
            handle.write(png_bytes())
        link = os.path.join(self.tmp.name, "escape.png")
        os.symlink(target, link)
        with self.assertRaises(MediaProbeError) as ctx:
            probe(link, allowed_roots=[self.tmp.name])
        self.assertEqual(ctx.exception.code, "symlink_escape")
        self.assertIn("outside the allowed media roots", str(ctx.exception))

    def test_broken_symlink_reports_missing_target(self):
        link = os.path.join(self.tmp.name, "dangling.png")
        os.symlink(os.path.join(self.tmp.name, "gone.png"), link)
        with self.assertRaises(MediaProbeError) as ctx:
            probe(link)
        self.assertEqual(ctx.exception.code, "missing")

    def test_still_growing_file_raises_when_stability_is_requested(self):
        path = self.write("growing.png", png_bytes())
        stop = threading.Event()

        def append():
            time.sleep(0.05)
            with open(path, "ab") as handle:
                handle.write(b"\x00" * 4096)
                handle.flush()
                os.fsync(handle.fileno())
            stop.set()

        writer = threading.Thread(target=append)
        writer.start()
        self.addCleanup(writer.join)
        with self.assertRaises(MediaProbeError) as ctx:
            probe(path, stability_wait_s=0.25)
        self.assertEqual(ctx.exception.code, "still_growing")
        self.assertIn("still being written", str(ctx.exception))
        self.assertTrue(stop.is_set())

    def test_stable_file_passes_the_stability_window(self):
        path = self.write("stable.png", png_bytes())
        descriptor = probe(path, stability_wait_s=0.05)
        self.assertEqual(descriptor.mime, "image/png")
        self.assertEqual(descriptor.size_bytes, os.path.getsize(path))


class DetectionTests(MediaDescriptorTestCase):
    def test_extension_and_bytes_agree(self):
        cases = [
            ("a.png", png_bytes(), "image/png", "image"),
            ("a.jpg", jpeg_bytes(), "image/jpeg", "image"),
            ("a.gif", gif_bytes(), "image/gif", "image"),
            ("a.webp", webp_bytes(), "image/webp", "image"),
            ("a.wav", wav_bytes(), "audio/wav", "audio"),
            ("a.mp3", mp3_bytes(), "audio/mpeg", "audio"),
            ("a.pdf", pdf_bytes(), "application/pdf", "file"),
        ]
        for name, payload, expected, family in cases:
            with self.subTest(name=name):
                descriptor = probe(self.write(name, payload))
                self.assertEqual(descriptor.detected_mime, expected)
                self.assertEqual(descriptor.declared_mime, expected)
                self.assertEqual(descriptor.mime, expected)
                self.assertEqual(descriptor.family, family)
                self.assertFalse(descriptor.mime_mismatch)
                self.assertEqual(descriptor.compatibility, "supported")
                self.assertIsNone(descriptor.incompatibility_reason)

    def test_png_bytes_in_a_dat_file_are_detected_and_supported(self):
        descriptor = probe(self.write("mystery.dat", png_bytes()))
        self.assertEqual(descriptor.declared_mime, "application/octet-stream")
        self.assertEqual(descriptor.detected_mime, "image/png")
        self.assertEqual(descriptor.mime, "image/png")
        self.assertEqual(descriptor.family, "image")
        self.assertEqual(descriptor.compatibility, "supported")

    def test_png_bytes_with_mp4_extension_follow_the_bytes(self):
        descriptor = probe(self.write("liar.mp4", png_bytes()))
        self.assertEqual(descriptor.declared_mime, "video/mp4")
        self.assertEqual(descriptor.detected_mime, "image/png")
        self.assertEqual(descriptor.mime, "image/png")
        self.assertEqual(descriptor.family, "image")
        self.assertTrue(descriptor.mime_mismatch)
        self.assertEqual(descriptor.compatibility, "supported")

    def test_inconclusive_bytes_fall_back_to_a_supported_extension(self):
        # Contract: the extension only votes when sniffing is inconclusive, and
        # then only when it claims something the policy already supports.
        descriptor = probe(self.write("claimed.png", b"\x00\x01\x02\x03" * 32))
        self.assertEqual(descriptor.detected_mime, "application/octet-stream")
        self.assertEqual(descriptor.mime, "image/png")
        self.assertEqual(descriptor.family, "image")
        self.assertEqual(descriptor.compatibility, "supported")

    def test_valid_utf8_markdown_is_supported_without_host_mime_registration(self):
        with patch("cozygateway.media_descriptor.mimetypes.guess_type", return_value=(None, None)):
            descriptor = probe(
                self.write("notes.md", b"# Notes\n\n- A downloadable Markdown file.\n")
            )

        self.assertEqual(descriptor.declared_mime, "text/markdown")
        self.assertEqual(descriptor.detected_mime, "application/octet-stream")
        self.assertEqual(descriptor.mime, "text/markdown")
        self.assertEqual(descriptor.family, "file")
        self.assertEqual(descriptor.compatibility, "supported")

    def test_markdown_with_invalid_utf8_is_unsupported(self):
        descriptor = probe(self.write("binary.md", b"# title\n\xff\xfe\x80"))

        self.assertEqual(descriptor.mime, "application/octet-stream")
        self.assertEqual(descriptor.compatibility, "unsupported")
        self.assertIn("valid UTF-8", descriptor.incompatibility_reason)

    def test_markdown_with_nul_bytes_is_unsupported(self):
        descriptor = probe(self.write("nul.md", b"# title\n\x00hidden"))

        self.assertEqual(descriptor.mime, "application/octet-stream")
        self.assertEqual(descriptor.compatibility, "unsupported")
        self.assertIn("NUL", descriptor.incompatibility_reason)

    def test_binary_media_renamed_to_markdown_is_unsupported(self):
        descriptor = probe(self.write("image.md", png_bytes()))

        self.assertEqual(descriptor.declared_mime, "text/markdown")
        self.assertEqual(descriptor.detected_mime, "image/png")
        self.assertEqual(descriptor.mime, "application/octet-stream")
        self.assertEqual(descriptor.compatibility, "unsupported")

    def test_inconclusive_bytes_with_an_unsupported_extension_fail_closed(self):
        descriptor = probe(self.write("claimed.bin", b"\x00\x01\x02\x03" * 32))
        self.assertEqual(descriptor.mime, "application/octet-stream")
        self.assertEqual(descriptor.family, "file")
        self.assertEqual(descriptor.compatibility, "unsupported")
        self.assertIn("could not be identified", descriptor.incompatibility_reason)

    def test_sha256_and_size_are_recorded(self):
        import hashlib

        payload = png_bytes()
        descriptor = probe(self.write("hashed.png", payload))
        self.assertEqual(descriptor.sha256, hashlib.sha256(payload).hexdigest())
        self.assertEqual(descriptor.size_bytes, len(payload))
        self.assertEqual(descriptor.filename, "hashed.png")

    def test_svg_is_unsupported_with_a_reason(self):
        descriptor = probe(self.write("diagram.svg", svg_bytes()))
        self.assertEqual(descriptor.detected_mime, "image/svg+xml")
        self.assertEqual(descriptor.compatibility, "unsupported")
        self.assertIn("Rasterize to PNG", descriptor.incompatibility_reason)

    def test_html_is_unsupported_with_a_reason(self):
        descriptor = probe(self.write("page.html", html_bytes()))
        self.assertEqual(descriptor.detected_mime, "text/html")
        self.assertEqual(descriptor.compatibility, "unsupported")
        self.assertIn("not an allowed attachment type", descriptor.incompatibility_reason)

    def test_bare_zip_is_supported_as_a_file(self):
        descriptor = probe(self.write("bundle.zip", bare_zip_bytes()))
        self.assertEqual(descriptor.detected_mime, "application/zip")
        self.assertEqual(descriptor.mime, "application/zip")
        self.assertEqual(descriptor.family, "file")
        self.assertEqual(descriptor.compatibility, "supported")
        self.assertIsNone(descriptor.incompatibility_reason)

    def test_ooxml_zip_is_detected_as_its_own_type(self):
        descriptor = probe(self.write("report.docx", ooxml_zip_bytes()))
        self.assertEqual(descriptor.detected_mime, "application/vnd.openxmlformats-officedocument")
        self.assertNotEqual(descriptor.detected_mime, "application/zip")
        self.assertEqual(descriptor.compatibility, "unsupported")
        self.assertIn("Export to PDF", descriptor.incompatibility_reason)

    def test_ooxml_package_never_rides_the_zip_allowance(self):
        """Both start with PK. Only the bare archive is a deliverable file."""

        self.assertEqual(detect_mime(ooxml_zip_bytes()), "application/vnd.openxmlformats-officedocument")
        self.assertEqual(detect_mime(bare_zip_bytes()), "application/zip")
        self.assertEqual(evaluate_compatibility("application/zip")[0], "supported")
        self.assertEqual(evaluate_compatibility("application/vnd.openxmlformats-officedocument")[0], "unsupported")

    def test_detect_mime_on_short_and_empty_buffers_does_not_crash(self):
        for payload in (b"", b"\x89", b"RIFF", b"PK\x03\x04", b"\x00" * 3):
            with self.subTest(payload=payload):
                self.assertIsInstance(detect_mime(payload), str)


class ContainerParseTests(MediaDescriptorTestCase):
    def test_mp4_with_h264_and_aac_is_supported(self):
        descriptor = probe(self.write("clip.mp4", mp4_bytes()))
        self.assertEqual(descriptor.detected_mime, "video/mp4")
        self.assertEqual(descriptor.container, "iso-bmff")
        self.assertEqual(descriptor.video_codec, "h264")
        self.assertEqual(descriptor.audio_codec, "aac")
        self.assertEqual(descriptor.width, 640)
        self.assertEqual(descriptor.height, 360)
        self.assertEqual(descriptor.duration_ms, 2500)
        self.assertEqual(descriptor.compatibility, "supported")

    def test_mp4_with_hevc_video_is_unsupported_with_a_codec_reason(self):
        descriptor = probe(self.write("hevc.mp4", mp4_bytes(video_fourcc=b"hvc1")))
        self.assertEqual(descriptor.detected_mime, "video/mp4")
        self.assertEqual(descriptor.video_codec, "hevc")
        self.assertEqual(descriptor.compatibility, "unsupported")
        self.assertIn("hevc video", descriptor.incompatibility_reason)
        self.assertIn("only h264 is supported", descriptor.incompatibility_reason)

    def test_mp4_with_av1_video_is_unsupported(self):
        descriptor = probe(self.write("av1.mp4", mp4_bytes(video_fourcc=b"av01")))
        self.assertEqual(descriptor.video_codec, "av1")
        self.assertEqual(descriptor.compatibility, "unsupported")

    def test_mp4_with_h264_and_opus_audio_is_unsupported(self):
        descriptor = probe(self.write("opus.mp4", mp4_bytes(audio_fourcc=b"Opus", audio_oti=None)))
        self.assertEqual(descriptor.audio_codec, "opus")
        self.assertEqual(descriptor.compatibility, "unsupported")
        self.assertIn("opus audio", descriptor.incompatibility_reason)

    def test_mp4_video_only_is_supported(self):
        descriptor = probe(self.write("silent.mp4", mp4_bytes(audio_fourcc=None)))
        self.assertEqual(descriptor.video_codec, "h264")
        self.assertIsNone(descriptor.audio_codec)
        self.assertEqual(descriptor.compatibility, "supported")

    def test_audio_only_mp4_is_reclassified_as_audio(self):
        payload = mp4_bytes(video_fourcc=None, brand=b"M4A ")
        descriptor = probe(self.write("voice.m4a", payload))
        self.assertEqual(descriptor.detected_mime, "audio/mp4")
        self.assertEqual(descriptor.family, "audio")
        self.assertEqual(descriptor.audio_codec, "aac")
        self.assertEqual(descriptor.compatibility, "supported")

    def test_audio_only_mp4_with_video_brand_is_reclassified_by_its_tracks(self):
        payload = mp4_bytes(video_fourcc=None, brand=b"isom")
        descriptor = probe(self.write("audio-only.mp4", payload))
        self.assertEqual(descriptor.detected_mime, "audio/mp4")
        self.assertEqual(descriptor.family, "audio")

    def test_mp4a_carrying_mp3_is_reported_as_mp3(self):
        payload = mp4_bytes(audio_fourcc=b"mp4a", audio_oti=0x6B)
        descriptor = probe(self.write("mp3-in-mp4.mp4", payload))
        self.assertEqual(descriptor.audio_codec, "mp3")
        self.assertEqual(descriptor.compatibility, "unsupported")

    def test_quicktime_brand_is_unsupported(self):
        descriptor = probe(self.write("clip.mov", mp4_bytes(brand=b"qt  ")))
        self.assertEqual(descriptor.detected_mime, "video/quicktime")
        self.assertEqual(descriptor.container, "quicktime")
        self.assertEqual(descriptor.compatibility, "unsupported")
        self.assertIn("Remux to MP4", descriptor.incompatibility_reason)

    def test_malformed_mp4_yields_unknown_compatibility_without_crashing(self):
        # A valid ftyp followed by a box whose declared size runs off the end.
        broken = _box(b"ftyp", b"isom" + b"\x00\x00\x02\x00") + struct.pack(">I", 0x7FFFFFFF) + b"moov" + b"\x00" * 16
        descriptor = probe(self.write("broken.mp4", broken))
        self.assertEqual(descriptor.detected_mime, "video/mp4")
        self.assertIsNone(descriptor.video_codec)
        self.assertIsNone(descriptor.audio_codec)
        self.assertEqual(descriptor.compatibility, "unknown")
        self.assertIn("could not be parsed", descriptor.incompatibility_reason)

    def test_truncated_mp4_does_not_crash(self):
        payload = mp4_bytes()[:24]
        descriptor = probe(self.write("truncated.mp4", payload))
        self.assertIn(descriptor.compatibility, ("unknown", "unsupported"))

    def test_random_bytes_after_ftyp_do_not_crash(self):
        payload = _box(b"ftyp", b"isom" + b"\x00" * 8) + os.urandom(2048)
        descriptor = probe(self.write("fuzz.mp4", payload))
        self.assertIn(descriptor.compatibility, ("unknown", "unsupported"))

    def test_webm_container_is_detected_and_unsupported(self):
        # EBML header with a DocType of "webm", enough to identify the container.
        doctype = b"\x42\x82\x85" + b"webm\x00"
        header = b"\x1a\x45\xdf\xa3" + bytes([0x80 | len(doctype)]) + doctype
        descriptor = probe(self.write("clip.webm", header + b"\x18\x53\x80\x67\x81\x00"))
        self.assertEqual(descriptor.detected_mime, "video/webm")
        self.assertEqual(descriptor.container, "matroska")
        self.assertEqual(descriptor.compatibility, "unsupported")
        self.assertIn("Transcode to MP4", descriptor.incompatibility_reason)

    def test_malformed_ebml_does_not_crash(self):
        descriptor = probe(self.write("bad.webm", b"\x1a\x45\xdf\xa3" + b"\x00" * 64 + b"webm"))
        self.assertIn(descriptor.compatibility, ("unsupported", "unknown"))


class DescriptorCacheTests(MediaDescriptorTestCase):
    """The cache may skip a read. It may never answer for bytes that have moved."""

    def setUp(self):
        super().setUp()
        clear_descriptor_cache()
        self.addCleanup(clear_descriptor_cache)

    def stamp(self, path, seconds):
        """Pin mtime, so the test does not depend on the filesystem's clock resolution."""
        os.utime(path, ns=(seconds * 1_000_000_000, seconds * 1_000_000_000))

    def test_an_unchanged_file_is_described_once(self):
        path = self.write("shot.png", png_bytes())
        self.stamp(path, 1_700_000_000)
        first = probe(path)
        self.assertIs(probe(path), first)

    def test_disabling_the_cache_re_reads_the_bytes(self):
        path = self.write("shot.png", png_bytes())
        self.stamp(path, 1_700_000_000)
        first = probe(path)
        again = probe(path, use_cache=False)
        self.assertIsNot(again, first)
        self.assertEqual(again.sha256, first.sha256)

    def test_rewritten_bytes_at_the_same_path_are_described_again(self):
        path = self.write("shot.png", png_bytes())
        self.stamp(path, 1_700_000_000)
        first = probe(path)

        # Same name, same size, new bytes: only the inode and mtime say so.
        os.unlink(path)
        self.write("shot.png", png_bytes(width=2))
        self.stamp(path, 1_700_000_100)
        second = probe(path)
        self.assertIsNot(second, first)
        self.assertNotEqual(second.sha256, first.sha256)

    def test_a_deleted_file_is_reported_missing_rather_than_served_from_cache(self):
        path = self.write("shot.png", png_bytes())
        probe(path)
        os.unlink(path)
        with self.assertRaises(MediaProbeError) as caught:
            probe(path)
        self.assertEqual(caught.exception.code, "missing")

    def test_the_cache_is_bounded_and_evicts_the_oldest(self):
        paths = []
        for index in range(DESCRIPTOR_CACHE_MAX + 1):
            path = self.write("shot%d.png" % index, png_bytes(width=1, height=index + 1))
            self.stamp(path, 1_700_000_000)
            paths.append(path)
        first = probe(paths[0])
        for path in paths[1:]:
            probe(path)
        self.assertIsNot(probe(paths[0]), first)
        self.assertIs(probe(paths[-1]), probe(paths[-1]))


class PolicyTableTests(unittest.TestCase):
    def test_policy_table_shape(self):
        for mime, rule in MEDIA_COMPATIBILITY_POLICY.items():
            with self.subTest(mime=mime):
                self.assertIn(rule["family"], ("image", "audio", "video", "file"))
                self.assertIn(rule["status"], ("supported", "unsupported"))
                if rule["status"] == "unsupported":
                    self.assertTrue(rule["reason"])
                else:
                    self.assertIsNone(rule["reason"])

    def test_baseline_supported_set_matches_the_spec(self):
        self.assertEqual(
            set(SUPPORTED_MIME_TYPES),
            {
                "image/png",
                "image/jpeg",
                "image/webp",
                "image/gif",
                "video/mp4",
                "audio/mp4",
                "audio/mpeg",
                "audio/wav",
                "application/pdf",
                "application/zip",
                "text/markdown",
            },
        )

    def test_unknown_mime_fails_closed_with_a_reason(self):
        status, reason = evaluate_compatibility("application/x-nonsense")
        self.assertEqual(status, "unsupported")
        self.assertIn("not in the supported media policy", reason)

    def test_unparsed_container_is_unknown_not_unsupported(self):
        status, reason = evaluate_compatibility("video/mp4", codecs_known=False)
        self.assertEqual(status, "unknown")
        self.assertIn("could not be parsed", reason)


if __name__ == "__main__":
    unittest.main()
