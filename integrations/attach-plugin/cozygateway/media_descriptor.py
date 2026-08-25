"""Byte-sniffing media descriptor for the CozyGateway attach plugin.

Answers one question per outbound file: what is it really, is it ready to
upload, and can the client render it? Standard library only. No network, no
subprocess, no new dependency.

    probe(path)                  readiness checks plus detection
    MediaDescriptor              immutable answer for one path
    MediaProbeError              readiness failure with an actionable message
    MEDIA_COMPATIBILITY_POLICY   the baseline policy table (one dict, so the
                                 gateway upload allowlist can read the same
                                 source)
"""

from __future__ import annotations

import hashlib
import mimetypes
import os
import struct
import threading
import time
from collections import OrderedDict
from dataclasses import dataclass
from typing import Any, Dict, Iterable, Optional, Tuple

__all__ = [
    "MediaDescriptor",
    "MediaProbeError",
    "MEDIA_COMPATIBILITY_POLICY",
    "SUPPORTED_MIME_TYPES",
    "evaluate_compatibility",
    "detect_mime",
    "probe",
    "clear_descriptor_cache",
]

# Bounds. A malformed or hostile file must never turn a probe into a long walk.
SNIFF_BYTES = 4096
MAX_ELEMENTS = 4096
MAX_DEPTH = 8
HASH_CHUNK = 1024 * 1024

# A probe reads the whole file to hash it, so re-probing the same unchanged bytes is
# the most expensive repeat in the send path (a resend, a retry, or the same asset
# attached to several messages). File identity is (device, inode, size, mtime); when
# all four match, the bytes are the bytes. The sha is not re-read to confirm that:
# it is verified against the bytes actually streamed to the gateway, which the upload
# reads anyway, so a stale entry cannot become a wrong attachment.
DESCRIPTOR_CACHE_MAX = 64
_descriptor_cache: "OrderedDict[Tuple[Any, ...], MediaDescriptor]" = OrderedDict()
_descriptor_cache_lock = threading.Lock()


def clear_descriptor_cache() -> None:
    """Drop every cached descriptor. Tests and a changed policy start from nothing."""

    with _descriptor_cache_lock:
        _descriptor_cache.clear()


def _cache_get(key: Tuple[Any, ...]) -> Optional["MediaDescriptor"]:
    with _descriptor_cache_lock:
        descriptor = _descriptor_cache.get(key)
        if descriptor is not None:
            _descriptor_cache.move_to_end(key)
        return descriptor


def _cache_put(key: Tuple[Any, ...], descriptor: "MediaDescriptor") -> None:
    with _descriptor_cache_lock:
        _descriptor_cache[key] = descriptor
        _descriptor_cache.move_to_end(key)
        while len(_descriptor_cache) > DESCRIPTOR_CACHE_MAX:
            _descriptor_cache.popitem(last=False)


class MediaProbeError(Exception):
    """A file cannot be prepared for upload.

    ``code`` is stable and machine-readable ("missing", "symlink_escape",
    "not_regular", "unreadable", "empty", "still_growing", "read_failed").
    ``str(err)`` is written for whoever has to fix the file.
    """

    def __init__(self, code: str, message: str, *, path: str = "") -> None:
        super().__init__(message)
        self.code = code
        self.path = path


# ---------------------------------------------------------------------------
# Policy table (spec finding 9)
# ---------------------------------------------------------------------------
# family: the coarse bucket reported to the platform.
# status: "supported" or "unsupported"; unsupported entries carry a reason.
# video_codecs / audio_codecs: accepted codecs, or None when not applicable.
# A None inside the tuple means a missing track of that kind is fine.
# Anything absent from this table fails closed with a generic reason.

def _rule(family, status, reason=None, video_codecs=None, audio_codecs=None):
    return {
        "family": family,
        "status": status,
        "reason": reason,
        "video_codecs": video_codecs,
        "audio_codecs": audio_codecs,
    }


MEDIA_COMPATIBILITY_POLICY: Dict[str, Dict[str, Any]] = {
    "image/png": _rule("image", "supported"),
    "image/jpeg": _rule("image", "supported"),
    "image/webp": _rule("image", "supported"),
    "image/gif": _rule("image", "supported"),
    "video/mp4": _rule("video", "supported", video_codecs=("h264",), audio_codecs=("aac", None)),
    "audio/mp4": _rule("audio", "supported", audio_codecs=("aac",)),
    "audio/mpeg": _rule("audio", "supported"),
    "audio/wav": _rule("audio", "supported"),
    "application/pdf": _rule("file", "supported"),
    "image/heic": _rule(
        "image", "unsupported", "HEIC images are not rendered by the client. Convert to PNG or JPEG before sending."
    ),
    "image/avif": _rule(
        "image", "unsupported", "AVIF images are not rendered by the client. Convert to PNG or JPEG before sending."
    ),
    "image/svg+xml": _rule(
        "image",
        "unsupported",
        "SVG is markup, not a raster image, and is not rendered by the client. Rasterize to PNG before sending.",
    ),
    "video/quicktime": _rule(
        "video",
        "unsupported",
        "QuickTime MOV playback is not guaranteed by the client. Remux to MP4 with H.264 video and AAC audio.",
    ),
    "video/webm": _rule(
        "video",
        "unsupported",
        "WebM playback is not supported by the client. Transcode to MP4 with H.264 video and AAC audio.",
    ),
    "video/x-matroska": _rule(
        "video",
        "unsupported",
        "Matroska playback is not supported by the client. Transcode to MP4 with H.264 video and AAC audio.",
    ),
    "audio/ogg": _rule(
        "audio", "unsupported", "Ogg audio is not supported by the client. Convert to M4A/AAC, MP3, or WAV."
    ),
    "application/zip": _rule("file", "supported"),
    "application/vnd.openxmlformats-officedocument": _rule(
        "file", "unsupported", "Office documents are not an allowed attachment type. Export to PDF before sending."
    ),
    "text/html": _rule(
        "file", "unsupported", "HTML is not an allowed attachment type. Send a PDF or an image instead."
    ),
    "application/octet-stream": _rule(
        "file",
        "unsupported",
        "The file type could not be identified from its bytes, so it is not an allowed attachment.",
    ),
}

SUPPORTED_MIME_TYPES: Tuple[str, ...] = tuple(
    sorted(mime for mime, rule in MEDIA_COMPATIBILITY_POLICY.items() if rule["status"] == "supported")
)


def evaluate_compatibility(
    mime: str,
    *,
    video_codec: Optional[str] = None,
    audio_codec: Optional[str] = None,
    codecs_known: bool = True,
) -> Tuple[str, Optional[str]]:
    """Apply the policy table.

    Returns ``(compatibility, incompatibility_reason)`` where compatibility is
    "supported", "unsupported", or "unknown". Pass ``codecs_known=False`` when a
    container parse failed: an otherwise supported container is then "unknown"
    rather than a guess.
    """

    rule = MEDIA_COMPATIBILITY_POLICY.get(mime)
    if rule is None:
        return "unsupported", "%s is not in the supported media policy. Supported types are: %s." % (
            mime,
            ", ".join(SUPPORTED_MIME_TYPES),
        )
    if rule["status"] != "supported":
        return "unsupported", rule["reason"]
    if rule["video_codecs"] is None and rule["audio_codecs"] is None:
        return "supported", None
    if not codecs_known:
        return "unknown", (
            "The %s container could not be parsed, so its codecs are unknown and compatibility cannot be confirmed."
            % mime
        )
    for kind, found, allowed in (
        ("video", video_codec, rule["video_codecs"]),
        ("audio", audio_codec, rule["audio_codecs"]),
    ):
        if allowed is not None and found not in allowed:
            return "unsupported", "%s carries %s %s, but only %s is supported." % (
                mime,
                found or "an unidentified",
                kind,
                "/".join(codec for codec in allowed if codec),
            )
    return "supported", None


def family_for(mime: str) -> str:
    rule = MEDIA_COMPATIBILITY_POLICY.get(mime)
    if rule is not None:
        return rule["family"]
    top = mime.partition("/")[0]
    return top if top in ("image", "audio", "video") else "file"


# ---------------------------------------------------------------------------
# Byte signature detection
# ---------------------------------------------------------------------------

_FTYP_BRANDS = {
    b"qt  ": "video/quicktime",
    b"heic": "image/heic",
    b"heix": "image/heic",
    b"heim": "image/heic",
    b"hevc": "image/heic",
    b"mif1": "image/heic",
    b"msf1": "image/heic",
    b"avif": "image/avif",
    b"avis": "image/avif",
    b"M4A ": "audio/mp4",
    b"M4B ": "audio/mp4",
}


def _looks_like_mp3_frame(head: bytes) -> bool:
    # Sync word plus a plausible version, layer, bitrate, and sample rate. The
    # extra checks keep arbitrary 0xFF-leading binaries out of audio/mpeg.
    if len(head) < 3 or head[0] != 0xFF or head[1] & 0xE0 != 0xE0:
        return False
    version, layer = (head[1] >> 3) & 0x03, (head[1] >> 1) & 0x03
    bitrate, sample_rate = (head[2] >> 4) & 0x0F, (head[2] >> 2) & 0x03
    return version != 1 and layer != 0 and bitrate not in (0, 0x0F) and sample_rate != 3


def detect_mime(head: bytes) -> str:
    """Identify a mime type from a leading chunk of file bytes.

    Returns "application/octet-stream" when nothing matches.
    """

    window = head[:2048]
    if head.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if head.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if head.startswith(b"GIF87a") or head.startswith(b"GIF89a"):
        return "image/gif"
    if head.startswith(b"RIFF") and len(head) >= 12:
        return {b"WEBP": "image/webp", b"WAVE": "audio/wav"}.get(head[8:12], "application/octet-stream")
    if len(head) >= 12 and head[4:8] == b"ftyp":
        return _FTYP_BRANDS.get(head[8:12], "video/mp4")
    if head.startswith(b"\x1a\x45\xdf\xa3"):
        return "video/x-matroska" if b"matroska" in window else "video/webm"
    if head.startswith(b"OggS"):
        return "audio/ogg"
    if head.startswith(b"%PDF-"):
        return "application/pdf"
    if head.startswith(b"PK\x03\x04") or head.startswith(b"PK\x05\x06"):
        # An OOXML package stores an uncompressed "[Content_Types].xml" entry
        # first, so no zip machinery is needed to tell it from a bare archive.
        return "application/vnd.openxmlformats-officedocument" if b"[Content_Types].xml" in window else "application/zip"
    if head.startswith(b"ID3") or _looks_like_mp3_frame(head):
        return "audio/mpeg"
    stripped = window.lstrip().lower()
    if stripped.startswith((b"<?xml", b"<svg", b"<!doctype svg")) and b"<svg" in stripped:
        return "image/svg+xml"
    if stripped.startswith((b"<!doctype html", b"<html")):
        return "text/html"
    return "application/octet-stream"


# ---------------------------------------------------------------------------
# Bounded ISO-BMFF (MP4 / MOV) parse
# ---------------------------------------------------------------------------
# ponytail: this walks only the boxes the descriptor needs (stsd for codecs,
# tkhd for dimensions, mvhd for duration). It is not, and must not grow into, a
# general ISO-BMFF library. Anything richer belongs behind ffprobe.

_MP4_CONTAINERS = {b"moov", b"trak", b"mdia", b"minf", b"stbl"}
_MP4_VIDEO_CODECS = {b"avc1": "h264", b"avc3": "h264", b"hev1": "hevc", b"hvc1": "hevc", b"av01": "av1", b"vp09": "vp9", b"mp4v": "mpeg4"}
_MP4_AUDIO_CODECS = {b"mp4a": "aac", b"Opus": "opus", b"opus": "opus", b".mp3": "mp3", b"alac": "alac", b"ac-3": "ac3"}


def _mp4a_codec(entry: bytes) -> str:
    """mp4a means AAC unless the elementary stream descriptor says otherwise."""

    marker = entry.find(b"esds")
    if marker < 0:
        return "aac"
    window = entry[marker + 4 : marker + 64]
    tag = window.find(b"\x04")  # DecoderConfigDescriptor
    if tag < 0:
        return "aac"
    index = tag + 1
    while index < len(window) and window[index] & 0x80:  # 7 bit varint length
        index += 1
    oti = window[index + 1] if index + 1 < len(window) else 0
    return "mp3" if oti in (0x69, 0x6B) else "aac"


def _parse_stsd(payload: bytes, out: Dict[str, Any]) -> None:
    offset = 8  # version/flags, entry count
    while offset + 8 <= len(payload):
        size = struct.unpack(">I", payload[offset : offset + 4])[0]
        fmt = payload[offset + 4 : offset + 8]
        if size < 8:
            return
        if fmt in _MP4_VIDEO_CODECS:
            out.setdefault("video_codec", _MP4_VIDEO_CODECS[fmt])
        elif fmt in _MP4_AUDIO_CODECS:
            base = _MP4_AUDIO_CODECS[fmt]
            out.setdefault("audio_codec", _mp4a_codec(payload[offset : offset + size]) if base == "aac" else base)
        offset += size


def _parse_mvhd(payload: bytes, out: Dict[str, Any]) -> None:
    wide = payload[0] == 1
    timescale, duration = struct.unpack(">IQ" if wide else ">II", payload[20:32] if wide else payload[12:20])
    if timescale:
        out["duration_ms"] = int(round(duration * 1000.0 / timescale))


def _parse_tkhd(payload: bytes, out: Dict[str, Any]) -> None:
    # version/flags, creation+modification+track_ID, reserved+duration,
    # reserved[2], layer+alternate_group+volume+reserved, then the 36 byte matrix.
    wide = payload[0] == 1
    offset = 4 + (20 if wide else 12) + (12 if wide else 8) + 8 + 8 + 36
    width, height = struct.unpack(">II", payload[offset : offset + 8])
    if width >> 16 and height >> 16:
        out["width"], out["height"] = width >> 16, height >> 16


_MP4_LEAVES = {b"stsd": _parse_stsd, b"mvhd": _parse_mvhd, b"tkhd": _parse_tkhd}


def _walk_mp4(handle, start: int, end: int, depth: int, budget: list, out: Dict[str, Any]) -> None:
    offset = start
    while offset + 8 <= end:
        budget[0] -= 1
        if budget[0] < 0:
            raise ValueError("box budget exhausted")
        handle.seek(offset)
        size, box_type = struct.unpack(">I4s", handle.read(8))
        body = offset + 8
        if size == 1:
            size = struct.unpack(">Q", handle.read(8))[0]
            body = offset + 16
        elif size == 0:
            size = end - offset
        if size < body - offset or offset + size > end:
            raise ValueError("box size out of range")
        if box_type in _MP4_CONTAINERS and depth < MAX_DEPTH:
            _walk_mp4(handle, body, offset + size, depth + 1, budget, out)
        elif box_type in _MP4_LEAVES and offset + size - body <= 1 << 20:
            handle.seek(body)
            _MP4_LEAVES[box_type](handle.read(offset + size - body), out)
        offset += size


# ---------------------------------------------------------------------------
# Bounded EBML (WebM / Matroska) parse
# ---------------------------------------------------------------------------
# ponytail: DocType and CodecID only. Policy rejects the container either way,
# so dimensions and duration would be facts nobody acts on.

_EBML_MASTERS = {0x18538067, 0x1654AE6B, 0xAE}  # Segment, Tracks, TrackEntry
_EBML_CODECS = {
    "V_MPEG4/ISO/AVC": ("video_codec", "h264"),
    "V_MPEGH/ISO/HEVC": ("video_codec", "hevc"),
    "V_AV1": ("video_codec", "av1"),
    "V_VP8": ("video_codec", "vp8"),
    "V_VP9": ("video_codec", "vp9"),
    "A_AAC": ("audio_codec", "aac"),
    "A_OPUS": ("audio_codec", "opus"),
    "A_VORBIS": ("audio_codec", "vorbis"),
    "A_MPEG/L3": ("audio_codec", "mp3"),
}


def _read_vint(handle, keep_marker: bool) -> Tuple[int, int]:
    first = handle.read(1)
    if not first or first[0] == 0:
        raise ValueError("invalid vint")
    byte, length, mask = first[0], 1, 0x80
    while not byte & mask:
        mask >>= 1
        length += 1
    rest = handle.read(length - 1)
    if len(rest) != length - 1:
        raise ValueError("truncated vint")
    value = byte if keep_marker else byte & (mask - 1)
    for extra in rest:
        value = (value << 8) | extra
    return value, length


def _walk_ebml(handle, start: int, end: int, depth: int, budget: list, out: Dict[str, Any]) -> None:
    offset = start
    while offset < end:
        budget[0] -= 1
        if budget[0] < 0:
            raise ValueError("element budget exhausted")
        handle.seek(offset)
        element_id, id_len = _read_vint(handle, True)
        size, size_len = _read_vint(handle, False)
        body = offset + id_len + size_len
        if body + size > end:
            raise ValueError("element size out of range")
        if element_id in _EBML_MASTERS and depth < MAX_DEPTH:
            _walk_ebml(handle, body, body + size, depth + 1, budget, out)
        elif element_id in (0x4282, 0x86) and size <= 256:  # DocType, CodecID
            handle.seek(body)
            text = handle.read(size).rstrip(b"\x00").decode("ascii", "replace")
            if element_id == 0x4282:
                out["doctype"] = text
            else:
                for prefix, (key, name) in _EBML_CODECS.items():
                    if text.startswith(prefix):
                        out.setdefault(key, name)
                        break
        offset = body + size


def _parse_container(path: str, size_bytes: int, walk) -> Optional[Dict[str, Any]]:
    """Run a bounded walk. Any malformed byte anywhere means None, never a crash."""

    out: Dict[str, Any] = {}
    try:
        with open(path, "rb") as handle:
            walk(handle, 0, size_bytes, 0, [MAX_ELEMENTS], out)
    except (OSError, ValueError, struct.error, RecursionError):
        return None
    return out


# ---------------------------------------------------------------------------
# Descriptor
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class MediaDescriptor:
    path: str
    realpath: str
    size_bytes: int
    sha256: str
    declared_mime: str
    detected_mime: str
    mime: str
    family: str
    filename: str
    container: Optional[str]
    video_codec: Optional[str]
    audio_codec: Optional[str]
    width: Optional[int]
    height: Optional[int]
    duration_ms: Optional[int]
    compatibility: str
    incompatibility_reason: Optional[str]

    @property
    def mime_mismatch(self) -> bool:
        """True when the extension and the bytes disagree (spec finding 1: log it)."""

        return "application/octet-stream" not in (self.declared_mime, self.detected_mime) and (
            self.declared_mime != self.detected_mime
        )


_MIME_ALIASES = {"audio/x-wav": "audio/wav", "audio/wave": "audio/wav", "audio/vnd.wave": "audio/wav", "audio/x-m4a": "audio/mp4"}


def _declared_mime(path: str) -> str:
    guess = mimetypes.guess_type(path)[0] or "application/octet-stream"
    return _MIME_ALIASES.get(guess, guess)


def _check_readiness(path: str, allowed_roots: Optional[Iterable[str]], stability_wait_s: float) -> Tuple[str, str, int]:
    expanded = os.path.abspath(os.path.expanduser(path))
    fail = lambda code, message: MediaProbeError(code, message, path=expanded)  # noqa: E731
    if not os.path.lexists(expanded):
        raise fail("missing", "No file exists at %s. Write the file before referencing it." % expanded)
    realpath = os.path.realpath(expanded)
    if not os.path.exists(realpath):
        raise fail("missing", "%s is a symlink whose target %s does not exist." % (expanded, realpath))
    if allowed_roots is not None:
        roots = [os.path.realpath(os.path.expanduser(root)) for root in allowed_roots]
        if not any(realpath == root or realpath.startswith(root.rstrip(os.sep) + os.sep) for root in roots):
            raise fail(
                "symlink_escape",
                "%s resolves to %s, which is outside the allowed media roots (%s)."
                % (expanded, realpath, ", ".join(roots) or "none"),
            )
    if not os.path.isfile(realpath):
        raise fail("not_regular", "%s is not a regular file. Only regular files can be uploaded." % expanded)
    if not os.access(realpath, os.R_OK):
        raise fail("unreadable", "%s is not readable by this process. Fix the file permissions and try again." % expanded)
    size_bytes = os.stat(realpath).st_size
    if size_bytes == 0:
        raise fail("empty", "%s is zero bytes. Wait for the writer to finish or regenerate the file." % expanded)
    if stability_wait_s > 0:
        time.sleep(stability_wait_s)
        try:
            second = os.stat(realpath).st_size
        except OSError as err:
            raise fail("read_failed", "%s could not be re-checked for stability: %s" % (expanded, err)) from err
        if second != size_bytes:
            raise fail(
                "still_growing",
                "%s is still being written (%d bytes then %d bytes). Wait for the writer to finish."
                % (expanded, size_bytes, second),
            )
    return expanded, realpath, size_bytes


def _read_head_and_hash(realpath: str, label: str) -> Tuple[bytes, str]:
    digest, head = hashlib.sha256(), b""
    try:
        with open(realpath, "rb") as handle:
            for chunk in iter(lambda: handle.read(HASH_CHUNK), b""):
                if len(head) < SNIFF_BYTES:
                    head += chunk[: SNIFF_BYTES - len(head)]
                digest.update(chunk)
    except OSError as err:
        raise MediaProbeError("read_failed", "%s could not be read: %s" % (label, err), path=label) from err
    return head, digest.hexdigest()


def probe(
    path: str,
    *,
    stability_wait_s: float = 0.0,
    allowed_roots: Optional[Iterable[str]] = None,
    use_cache: bool = True,
) -> MediaDescriptor:
    """Verify a file is ready to upload and describe what it actually is.

    Raises MediaProbeError with an actionable message when the file is missing,
    escapes ``allowed_roots`` through a symlink, is not a regular file, is
    unreadable, is empty, or is still growing (size sampled twice when
    ``stability_wait_s`` is positive).

    Readiness is always re-checked. ``use_cache`` only decides whether the read
    that hashes and sniffs the bytes is skipped for a file whose identity has not
    moved (see DESCRIPTOR_CACHE_MAX).
    """

    expanded, realpath, size_bytes = _check_readiness(path, allowed_roots, stability_wait_s)
    key = _identity(expanded, realpath, size_bytes)
    if use_cache and key is not None:
        cached = _cache_get(key)
        if cached is not None:
            return cached
    head, sha256 = _read_head_and_hash(realpath, expanded)
    declared, detected = _declared_mime(expanded), detect_mime(head)

    container, facts, codecs_known = None, {}, True
    if detected in ("video/mp4", "audio/mp4", "video/quicktime", "image/heic", "image/avif"):
        container = "quicktime" if detected == "video/quicktime" else "iso-bmff"
        facts = _parse_container(realpath, size_bytes, _walk_mp4)
    elif detected in ("video/webm", "video/x-matroska"):
        container = "matroska"
        facts = _parse_container(realpath, size_bytes, _walk_ebml)
    elif detected != "application/octet-stream":
        container = detected.partition("/")[2] or None
    if facts is None:
        facts, codecs_known = {}, False
    if detected == "video/mp4" and facts.get("video_codec") is None and facts.get("audio_codec"):
        detected = "audio/mp4"  # a video brand on an audio-only file

    # The bytes decide. The extension only votes when detection is inconclusive,
    # and then only when what it claims is something the policy supports.
    if detected != "application/octet-stream":
        mime = detected
    elif MEDIA_COMPATIBILITY_POLICY.get(declared, {}).get("status") == "supported":
        mime = declared
    else:
        mime = "application/octet-stream"

    compatibility, reason = evaluate_compatibility(
        mime,
        video_codec=facts.get("video_codec"),
        audio_codec=facts.get("audio_codec"),
        codecs_known=codecs_known,
    )
    descriptor = MediaDescriptor(
        path=expanded,
        realpath=realpath,
        size_bytes=size_bytes,
        sha256=sha256,
        declared_mime=declared,
        detected_mime=detected,
        mime=mime,
        family=family_for(mime),
        filename=os.path.basename(expanded),
        container=container,
        video_codec=facts.get("video_codec"),
        audio_codec=facts.get("audio_codec"),
        width=facts.get("width"),
        height=facts.get("height"),
        duration_ms=facts.get("duration_ms"),
        compatibility=compatibility,
        incompatibility_reason=reason,
    )
    if use_cache and key is not None:
        _cache_put(key, descriptor)
    return descriptor


def _identity(expanded: str, realpath: str, size_bytes: int) -> Optional[Tuple[Any, ...]]:
    """(path, device, inode, size, mtime) for a file, or None if it cannot be read.

    A rewritten file changes size or mtime, and a replaced file changes inode, so a
    hit means these exact bytes were already described.
    """

    try:
        status = os.stat(realpath)
    except OSError:
        return None
    return (expanded, realpath, status.st_dev, status.st_ino, size_bytes, status.st_mtime_ns)
