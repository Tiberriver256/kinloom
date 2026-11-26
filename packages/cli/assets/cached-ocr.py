#!/usr/bin/env -S python3 -S
"""Content-addressed cached OCR CLI for printed scans (tesseract) and handwritten cursive (vision CLI)."""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
import hashlib
import json
import os
import struct
import sys
import threading
import time
from typing import Iterator

DEFAULT_CURSIVE_EFFORT = "low"
DEFAULT_VISION_CLI = "agy"
DEFAULT_PRINTED_TIMEOUT_S = 30
DEFAULT_CURSIVE_TIMEOUT_S = 90
DEFAULT_MAX_WORKERS = 4
MAX_WORKERS_CAP = 8
DEFAULT_PRINTED_MAX_DIM = 3500
CURSIVE_MAX_INPUT_BYTES = 350 * 1024
CURSIVE_TARGET_KB = 285
CURSIVE_TARGET_MAX_WIDTH = 2400
VALID_MODES = ("printed", "cursive")
VALID_EFFORTS = ("low", "medium", "high", "xhigh")

_HTML_SNIFF_PREFIXES = (b"<!doctype", b"<html", b"<head", b"<body", b"<title")
_TESSERACT_INVALID_IMAGE_MARKERS = (
    "error in pixread",
    "unsupported image",
    "could not read",
    "unknown format",
    "cannot read input file",
    "error, cannot open",
    "image file cannot be read",
)
_UV_OFFLINE_MISS_MARKERS = (
    "network was disabled",
    "network connectivity is disabled",
    "no solution found when resolving",
    "uv is set to offline mode",
    "cannot perform a network request in offline mode",
)

DEFAULT_CURSIVE_PROMPT = (
    "Call read_file ONCE on {image_path}. Do not run shell commands, do not write files, "
    "and do not invoke subagents. Transcribe verbatim all handwritten cursive text visible on "
    "this archival document: first the sheet/page header (state, county, township/city, date, "
    "ED/page/sheet numbers), then each legible household/person row with line number, "
    "dwelling/family numbers, full name, relation, sex, color/race, age, occupation, property "
    "values, and birthplace. Mark genuinely illegible words or characters as [?]; never invent "
    "or extrapolate obscured rows."
)


class InputImageError(ValueError):
    """Raised when an input path is missing, unreadable, empty, or not an image (exit 2)."""


def default_cache_dir() -> str:
    env_dir = os.environ.get("KINLOOM_OCR_CACHE_DIR", "").strip()
    if env_dir:
        return os.path.expanduser(env_dir)
    xdg = os.environ.get("XDG_CACHE_HOME", "").strip()
    if xdg:
        return os.path.join(os.path.expanduser(xdg), "kinloom-ocr")
    return os.path.join(os.path.expanduser("~"), ".cache", "kinloom-ocr")


def default_telemetry_file() -> str:
    env_file = os.environ.get("KINLOOM_TELEMETRY_FILE", "").strip()
    if env_file:
        return os.path.expanduser(env_file)
    xdg = os.environ.get("XDG_CACHE_HOME", "").strip()
    if xdg:
        return os.path.join(os.path.expanduser(xdg), "kinloom-telemetry", "calls.jsonl")
    return os.path.join(os.path.expanduser("~"), ".cache", "kinloom-telemetry", "calls.jsonl")


def resolve_vision_cli() -> str:
    configured = os.environ.get("KINLOOM_OCR_CLI", "").strip()
    return configured or DEFAULT_VISION_CLI


def print_usage() -> None:
    cache_default = default_cache_dir()
    cli_default = resolve_vision_cli()
    sys.stdout.write(
        "Usage: kinloom ocr <image> [image ...] [options]\n\n"
        "Options:\n"
        "  -m, --mode <printed|cursive>      OCR mode (default: printed; aliases: --printed, --cursive)\n"
        "  --psm <int>                       Tesseract PSM for --mode printed (default: 6)\n"
        f"  --effort <low|medium|high|xhigh>  Reasoning effort for --mode cursive (default: {DEFAULT_CURSIVE_EFFORT})\n"
        f"  --cache-dir <dir>                 Cache directory (default: {cache_default})\n"
        f"  -t, --timeout <seconds>           Per-image subprocess timeout (default: {DEFAULT_PRINTED_TIMEOUT_S} printed, {DEFAULT_CURSIVE_TIMEOUT_S} cursive)\n"
        f"  --workers <int>                   Parallel worker count for multi-file batches (default: {DEFAULT_MAX_WORKERS}, max: {MAX_WORKERS_CAP})\n"
        f"  --max-dim <px>                    Cap longest printed scan edge before Tesseract (default: {DEFAULT_PRINTED_MAX_DIM}, 0 disables)\n"
        "  --prompt <text>                   Custom prompt for --mode cursive (supports {image_path})\n"
        "  --force, --refresh                Bypass cache and recompute OCR\n"
        "  --json                            Emit structured JSON output (or {files: [...]} for multiple images)\n"
        "  --boxes                           Emit JSON line/word pixel boxes (printed mode only)\n"
        "  --tsv                             Emit raw Tesseract TSV (printed mode only)\n"
        "  --find <regex>                    Case-insensitive line filter; implies --boxes\n"
        "  -h, --help                        Show this help message\n\n"
        "Environment:\n"
        f"  KINLOOM_OCR_CACHE_DIR             Override cache directory (default: {cache_default})\n"
        f"  KINLOOM_OCR_CLI                   Vision CLI executable for --mode cursive (default: {cli_default})\n"
        "  KINLOOM_OCR_MODEL                 Override model name passed to --mode cursive vision CLI\n"
    )


def parse_args(argv: list[str]) -> dict[str, object]:
    images: list[str] = []
    opts: dict[str, object] = {
        "images": images,
        "mode": "printed",
        "psm": 6,
        "effort": DEFAULT_CURSIVE_EFFORT,
        "cache_dir": default_cache_dir(),
        "timeout": None,
        "workers": DEFAULT_MAX_WORKERS,
        "max_dim": DEFAULT_PRINTED_MAX_DIM,
        "prompt": None,
        "force": False,
        "json": False,
        "boxes": False,
        "tsv": False,
        "find": None,
    }
    short_aliases = {
        "-m": "--mode",
        "-t": "--timeout",
    }
    i = 0
    n = len(argv)
    while i < n:
        arg = argv[i]
        if arg in ("-h", "--help"):
            print_usage()
            raise SystemExit(0)
        if arg in ("--force", "--refresh", "--no-cache"):
            opts["force"] = True
            i += 1
            continue
        if arg == "--printed":
            opts["mode"] = "printed"
            i += 1
            continue
        if arg == "--cursive":
            opts["mode"] = "cursive"
            i += 1
            continue
        if arg in ("--json", "--boxes", "--tsv"):
            opts[arg[2:]] = True
            i += 1
            continue
        if arg == "--":
            images.extend(argv[i + 1 :])
            break

        # Normalize short value options (-m, -t) into their long form.
        normalized = arg
        if arg.startswith("-") and not arg.startswith("--") and len(arg) > 1:
            if "=" in arg:
                short_key, short_val = arg.split("=", 1)
                if short_key in short_aliases:
                    normalized = f"{short_aliases[short_key]}={short_val}"
            elif arg in short_aliases:
                normalized = short_aliases[arg]
            elif not os.path.exists(arg):
                raise ValueError(f"Unknown option: {arg}")

        if normalized.startswith("--"):
            if "=" in normalized:
                key, val = normalized.split("=", 1)
            else:
                key = normalized
                if i + 1 >= n:
                    raise ValueError(f"Option {key} requires a value.")
                i += 1
                val = argv[i]
            if key == "--mode":
                if val not in VALID_MODES:
                    raise ValueError(
                        f"Invalid --mode '{val}': choose from {', '.join(VALID_MODES)}."
                    )
                opts["mode"] = val
            elif key == "--psm":
                try:
                    parsed_psm = int(val)
                except ValueError as exc:
                    raise ValueError(f"Invalid --psm '{val}': must be an integer (0-13).") from exc
                if parsed_psm < 0 or parsed_psm > 13:
                    raise ValueError(f"Invalid --psm '{val}': must be between 0 and 13.")
                opts["psm"] = parsed_psm
            elif key == "--effort":
                if val not in VALID_EFFORTS:
                    raise ValueError(
                        f"Invalid --effort '{val}': choose from {', '.join(VALID_EFFORTS)}."
                    )
                opts["effort"] = val
            elif key == "--cache-dir":
                opts["cache_dir"] = val
            elif key == "--timeout":
                try:
                    parsed_timeout = int(val)
                except ValueError as exc:
                    raise ValueError(
                        f"Invalid --timeout '{val}': must be a positive integer in seconds."
                    ) from exc
                if parsed_timeout <= 0:
                    raise ValueError(
                        f"Invalid --timeout '{val}': must be a positive integer in seconds."
                    )
                opts["timeout"] = parsed_timeout
            elif key == "--workers":
                try:
                    parsed_workers = int(val)
                except ValueError as exc:
                    raise ValueError(
                        f"Invalid --workers '{val}': must be a positive integer."
                    ) from exc
                if parsed_workers <= 0:
                    raise ValueError(
                        f"Invalid --workers '{val}': must be a positive integer."
                    )
                opts["workers"] = min(parsed_workers, MAX_WORKERS_CAP)
            elif key == "--max-dim":
                try:
                    parsed_dim = int(val)
                except ValueError as exc:
                    raise ValueError(
                        f"Invalid --max-dim '{val}': must be a non-negative integer in pixels."
                    ) from exc
                if parsed_dim < 0:
                    raise ValueError(
                        f"Invalid --max-dim '{val}': must be a non-negative integer in pixels."
                    )
                opts["max_dim"] = parsed_dim
            elif key == "--prompt":
                opts["prompt"] = val
            elif key == "--find":
                import re

                try:
                    re.compile(val)
                except re.error as exc:
                    raise ValueError(f"Invalid --find regex '{val}': {exc}") from exc
                opts["find"] = val
                opts["boxes"] = True
            else:
                raise ValueError(f"Unknown option: {key}")
            i += 1
            continue
        images.append(arg)
        i += 1

    if not images:
        raise ValueError("Missing required positional argument: <image>.")
    if opts["boxes"] and opts["tsv"]:
        raise ValueError("--tsv cannot be combined with --boxes or --find.")
    if (opts["boxes"] or opts["tsv"]) and opts["mode"] != "printed":
        raise ValueError("--boxes, --tsv, and --find require --mode printed.")
    return opts


def mode_slug(mode: str, psm: int, effort: str, custom_prompt: str | None) -> str:
    if mode == "printed":
        return f"printed_psm{psm}"
    base = f"cursive_hydrogen_{effort}"
    if custom_prompt:
        digest = hashlib.sha256(custom_prompt.encode("utf-8")).hexdigest()[:8]
        return f"{base}_p{digest}"
    return base


@contextmanager
def file_lock(lock_path: str) -> Iterator[None]:
    """Advisory exclusive lock (POSIX flock); no-op when fcntl is unavailable."""
    try:
        import fcntl
    except ImportError:
        yield
        return
    parent = os.path.dirname(lock_path)
    if parent:
        os.makedirs(parent, exist_ok=True)
    with open(lock_path, "a+b") as lock_file:
        fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)


def _temp_sibling(dest: str) -> str:
    parent = os.path.dirname(dest)
    return os.path.join(
        parent,
        f".{os.path.basename(dest)}.{os.getpid()}.{threading.get_ident()}.{time.time_ns()}.tmp",
    )


def atomic_write_json(dest: str, payload: dict[str, object]) -> None:
    parent = os.path.dirname(dest)
    os.makedirs(parent, exist_ok=True)
    tmp = _temp_sibling(dest)
    try:
        with open(tmp, "w", encoding="utf-8") as fh:
            fh.write(json.dumps(payload, indent=2, ensure_ascii=False) + "\n")
        os.replace(tmp, dest)
    except Exception:
        if os.path.exists(tmp):
            try:
                os.unlink(tmp)
            except OSError:
                pass
        raise


def atomic_write_text(dest: str, text: str) -> None:
    parent = os.path.dirname(dest)
    os.makedirs(parent, exist_ok=True)
    tmp = _temp_sibling(dest)
    try:
        with open(tmp, "w", encoding="utf-8") as fh:
            fh.write(text)
        os.replace(tmp, dest)
    except Exception:
        if os.path.exists(tmp):
            try:
                os.unlink(tmp)
            except OSError:
                pass
        raise


def _read_jpeg_dimensions(data: bytes) -> tuple[int, int] | None:
    n = len(data)
    if n < 4 or data[0:2] != b"\xff\xd8":
        return None
    pos = 2
    sof_markers = {
        0xC0, 0xC1, 0xC2, 0xC3,
        0xC5, 0xC6, 0xC7,
        0xC9, 0xCA, 0xCB,
        0xCD, 0xCE, 0xCF,
    }
    while pos < n:
        while pos < n and data[pos] != 0xFF:
            pos += 1
        while pos < n and data[pos] == 0xFF:
            pos += 1
        if pos >= n:
            break
        marker = data[pos]
        pos += 1
        if marker in (0xD8, 0xD9, 0x01) or (0xD0 <= marker <= 0xD7):
            continue
        if pos + 2 > n:
            break
        seg_len = struct.unpack(">H", data[pos : pos + 2])[0]
        if seg_len < 2 or pos + seg_len > n:
            break
        if marker in sof_markers:
            if pos + 7 > n:
                return None
            height, width = struct.unpack(">HH", data[pos + 3 : pos + 7])
            return (width, height) if width > 0 and height > 0 else None
        pos += seg_len
    return None


def _read_tiff_dimensions(data: bytes) -> tuple[int, int] | None:
    if len(data) < 8:
        return None
    if data[0:4] == b"II\x2a\x00":
        endian = "<"
    elif data[0:4] == b"MM\x00\x2a":
        endian = ">"
    else:
        return None
    ifd_offset = struct.unpack(endian + "I", data[4:8])[0]
    if ifd_offset + 2 > len(data):
        return None
    num_entries = struct.unpack(endian + "H", data[ifd_offset : ifd_offset + 2])[0]
    width: int | None = None
    height: int | None = None
    pos = ifd_offset + 2
    for _ in range(num_entries):
        if pos + 12 > len(data):
            break
        tag, field_type, count = struct.unpack(endian + "HHI", data[pos : pos + 8])
        val_bytes = data[pos + 8 : pos + 12]
        if tag in (256, 257) and count >= 1:
            if field_type == 3:  # SHORT
                val = struct.unpack(endian + "H", val_bytes[:2])[0]
            elif field_type == 4:  # LONG
                val = struct.unpack(endian + "I", val_bytes)[0]
            else:
                val = None
            if val is not None:
                if tag == 256:
                    width = val
                else:
                    height = val
            if width is not None and height is not None:
                return (width, height) if width > 0 and height > 0 else None
        pos += 12
    return None


def _read_webp_dimensions(data: bytes) -> tuple[int, int] | None:
    if len(data) < 30 or data[0:4] != b"RIFF" or data[8:12] != b"WEBP":
        return None
    chunk = data[12:16]
    if chunk == b"VP8X" and len(data) >= 30:
        width = 1 + int.from_bytes(data[24:27], "little")
        height = 1 + int.from_bytes(data[27:30], "little")
        return (width, height)
    if chunk == b"VP8 " and len(data) >= 30 and data[23:26] == b"\x9d\x01\x2a":
        width = struct.unpack("<H", data[26:28])[0] & 0x3FFF
        height = struct.unpack("<H", data[28:30])[0] & 0x3FFF
        return (width, height) if width > 0 and height > 0 else None
    if chunk == b"VP8L" and len(data) >= 25 and data[20] == 0x2F:
        bits = struct.unpack("<I", data[21:25])[0]
        width = (bits & 0x3FFF) + 1
        height = ((bits >> 14) & 0x3FFF) + 1
        return (width, height)
    return None


def read_image_dimensions(raw_bytes: bytes) -> tuple[int, int] | None:
    """Read (width, height) from common raster headers using stdlib only."""
    if len(raw_bytes) >= 24 and raw_bytes[0:8] == b"\x89PNG\r\n\x1a\n":
        w, h = struct.unpack(">II", raw_bytes[16:24])
        return (w, h) if w > 0 and h > 0 else None
    if len(raw_bytes) >= 10 and raw_bytes[0:6] in (b"GIF87a", b"GIF89a"):
        w, h = struct.unpack("<HH", raw_bytes[6:10])
        return (w, h) if w > 0 and h > 0 else None
    if len(raw_bytes) >= 26 and raw_bytes[0:2] == b"BM":
        w, h = struct.unpack("<ii", raw_bytes[18:26])
        w, h = abs(w), abs(h)
        return (w, h) if w > 0 and h > 0 else None
    if raw_bytes[:2] == b"\xff\xd8":
        return _read_jpeg_dimensions(raw_bytes)
    if raw_bytes[:4] in (b"II\x2a\x00", b"MM\x00\x2a"):
        return _read_tiff_dimensions(raw_bytes)
    if raw_bytes[:4] == b"RIFF" and raw_bytes[8:12] == b"WEBP":
        return _read_webp_dimensions(raw_bytes)
    return None


def validate_image_file(img_path: str) -> bytes:
    """Validate path existence, regular-file status, non-empty size, and non-HTML/PDF content."""
    if not os.path.exists(img_path):
        raise InputImageError(f"image file not found: {img_path}")
    if not os.path.isfile(img_path):
        raise InputImageError(f"image path is not a regular file: {img_path}")
    try:
        with open(img_path, "rb") as fh:
            raw_bytes = fh.read()
    except OSError as exc:
        raise InputImageError(f"cannot read image file {img_path}: {exc}") from exc
    if len(raw_bytes) == 0:
        raise InputImageError(f"image file is empty (0 bytes): {img_path}")
    head = raw_bytes[:512].lstrip(b"\xef\xbb\xbf \t\r\n")
    if head.startswith(b"%PDF-"):
        raise InputImageError(
            f"file is a PDF, not an image: {img_path} "
            "(render pages first with 'kinloom prep-scan pdf-pages')."
        )
    head_lower = head.lower()
    if any(head_lower.startswith(prefix) for prefix in _HTML_SNIFF_PREFIXES):
        raise InputImageError(f"file is HTML, not an image: {img_path}")
    return raw_bytes


def _is_uv_offline_miss(stderr: str) -> bool:
    normalized = " ".join(stderr.lower().split())
    return any(marker in normalized for marker in _UV_OFFLINE_MISS_MARKERS)


def _run_prep_scan(args: list[str], *, timeout_s: int = 60) -> tuple[int, str, str]:
    """Run companion prep-scan.py offline-first when invoked via uv, retrying online on cache miss."""
    import shutil
    import subprocess

    prep_script = os.path.join(os.path.dirname(os.path.realpath(__file__)), "prep-scan.py")
    if not os.path.isfile(prep_script):
        raise RuntimeError(f"Companion script not found: {prep_script}")

    uv_bin = shutil.which("uv")
    use_uv = bool(uv_bin)
    prep_cmd = [uv_bin, "run", "--script", prep_script] if uv_bin else [sys.executable, prep_script]
    base_env = {
        **os.environ,
        "KINLOOM_TELEMETRY_PARENT": "1",
        "KINLOOM_TELEMETRY_ACTIVE": "1",
    }
    try_offline = use_uv and "UV_OFFLINE" not in os.environ
    first_env = {**base_env, "UV_OFFLINE": "1"} if try_offline else base_env

    proc = subprocess.run(
        [*prep_cmd, *args],
        capture_output=True,
        text=True,
        timeout=timeout_s,
        env=first_env,
    )
    if try_offline and proc.returncode != 0 and not proc.stdout and _is_uv_offline_miss(proc.stderr or ""):
        retry_env = dict(base_env)
        retry_env.pop("UV_OFFLINE", None)
        proc = subprocess.run(
            [*prep_cmd, *args],
            capture_output=True,
            text=True,
            timeout=timeout_s,
            env=retry_env,
        )
    return proc.returncode, proc.stdout, proc.stderr


def prepare_printed_image(
    img_path: str,
    raw_bytes: bytes,
    work_dir: str,
    max_dim: int = DEFAULT_PRINTED_MAX_DIM,
) -> tuple[str, str | None, dict[str, int] | None]:
    """Downscale oversized scans (> max_dim) before Tesseract so single-threaded OCR stays fast.

    Returns (path_for_tesseract, cleanup_dir, scale_info_or_none).
    """
    if max_dim <= 0:
        return img_path, None, None
    dims = read_image_dimensions(raw_bytes)
    if dims is None:
        return img_path, None, None
    orig_w, orig_h = dims
    if orig_w <= 0 or orig_h <= 0 or max(orig_w, orig_h) <= max_dim:
        return img_path, None, None

    import shutil
    import subprocess

    scale = max_dim / float(max(orig_w, orig_h))
    target_w = max(1, int(round(orig_w * scale)))
    target_h = max(1, int(round(orig_h * scale)))

    os.makedirs(work_dir, exist_ok=True)
    job_dir = os.path.join(
        work_dir, f"printed_{os.getpid()}_{threading.get_ident()}_{time.time_ns()}"
    )
    os.makedirs(job_dir, exist_ok=True)
    out_path = os.path.join(job_dir, "scaled.png")
    resized_path: str | None = None

    try:
        # 1. Fastest path: in-process Pillow when installed in the active Python environment.
        try:
            from PIL import Image  # type: ignore[import-not-found]

            with Image.open(img_path) as im:
                resampling = getattr(getattr(Image, "Resampling", Image), "LANCZOS", Image.BICUBIC)
                resized = im.resize((target_w, target_h), resampling)
                resized.save(out_path, format="PNG")
            resized_path = out_path
        except Exception:
            resized_path = None

        # 2. Fast native CLI path: ImageMagick (`magick` or `convert`).
        if resized_path is None:
            im_bin = shutil.which("magick") or shutil.which("convert")
            if im_bin:
                proc = subprocess.run(
                    [im_bin, img_path, "-resize", f"{target_w}x{target_h}", out_path],
                    capture_output=True,
                    text=True,
                    timeout=30,
                )
                if proc.returncode == 0 and os.path.isfile(out_path):
                    resized_path = out_path

        # 3. Companion prep-scan.py fallback (offline-first uv).
        if resized_path is None:
            try:
                rc, stdout, _stderr = _run_prep_scan(
                    [
                        "preview",
                        img_path,
                        "--out-dir",
                        job_dir,
                        "--max-width",
                        str(target_w),
                        "--max-kb",
                        "4096",
                        "--json",
                    ],
                    timeout_s=45,
                )
                if rc == 0 and stdout.strip():
                    info = json.loads(stdout)[0]
                    candidate = str(info["path"])
                    if os.path.isfile(candidate):
                        resized_path = candidate
            except Exception:
                resized_path = None

        if resized_path is None:
            shutil.rmtree(job_dir, ignore_errors=True)
            return img_path, None, None

        with open(resized_path, "rb") as fh:
            scaled_dims = read_image_dimensions(fh.read())
        if scaled_dims is None or scaled_dims[0] <= 0 or scaled_dims[1] <= 0:
            shutil.rmtree(job_dir, ignore_errors=True)
            return img_path, None, None

        scaled_w, scaled_h = scaled_dims
        if scaled_w >= orig_w and scaled_h >= orig_h:
            shutil.rmtree(job_dir, ignore_errors=True)
            return img_path, None, None

        return (
            resized_path,
            job_dir,
            {
                "original_width": orig_w,
                "original_height": orig_h,
                "scaled_width": scaled_w,
                "scaled_height": scaled_h,
            },
        )
    except Exception:
        shutil.rmtree(job_dir, ignore_errors=True)
        return img_path, None, None


def rescale_tesseract_tsv(
    tsv: str,
    orig_width: int,
    orig_height: int,
    scaled_width: int,
    scaled_height: int,
) -> str:
    """Rescale Tesseract TSV pixel coordinates from scaled dimensions back to original pixels."""
    if (
        orig_width <= 0
        or orig_height <= 0
        or scaled_width <= 0
        or scaled_height <= 0
        or (orig_width == scaled_width and orig_height == scaled_height)
    ):
        return tsv

    lines = tsv.splitlines()
    if not lines:
        return tsv
    header = lines[0].split("\t")
    required = ("level", "left", "top", "width", "height")
    if any(col not in header for col in required):
        return tsv
    idx_level = header.index("level")
    idx_left = header.index("left")
    idx_top = header.index("top")
    idx_width = header.index("width")
    idx_height = header.index("height")
    min_cols = max(idx_level, idx_left, idx_top, idx_width, idx_height) + 1

    sx = orig_width / float(scaled_width)
    sy = orig_height / float(scaled_height)
    out_lines: list[str] = [lines[0]]

    for raw_line in lines[1:]:
        if not raw_line.strip():
            continue
        cols = raw_line.split("\t")
        if len(cols) < min_cols:
            out_lines.append(raw_line)
            continue
        try:
            level = int(cols[idx_level])
            left = int(cols[idx_left])
            top = int(cols[idx_top])
            width = int(cols[idx_width])
            height = int(cols[idx_height])
        except ValueError:
            out_lines.append(raw_line)
            continue

        if level == 1:
            cols[idx_left] = "0"
            cols[idx_top] = "0"
            cols[idx_width] = str(orig_width)
            cols[idx_height] = str(orig_height)
        else:
            x0 = max(0, min(orig_width, int(round(left * sx))))
            y0 = max(0, min(orig_height, int(round(top * sy))))
            x1 = max(x0, min(orig_width, int(round((left + width) * sx))))
            y1 = max(y0, min(orig_height, int(round((top + height) * sy))))
            new_w = x1 - x0
            new_h = y1 - y0
            if width > 0 and new_w == 0 and x0 < orig_width:
                new_w = 1
            if height > 0 and new_h == 0 and y0 < orig_height:
                new_h = 1
            cols[idx_left] = str(x0)
            cols[idx_top] = str(y0)
            cols[idx_width] = str(new_w)
            cols[idx_height] = str(new_h)
        out_lines.append("\t".join(cols))

    trailing = "\n" if tsv.endswith("\n") else ""
    return "\n".join(out_lines) + trailing


def _is_tesseract_invalid_image_error(detail: str) -> bool:
    lowered = detail.lower()
    return any(marker in lowered for marker in _TESSERACT_INVALID_IMAGE_MARKERS)


def run_printed_ocr(
    img_path: str,
    psm: int,
    timeout_s: int,
    tsv: bool = False,
    *,
    raw_bytes: bytes | None = None,
    work_dir: str | None = None,
    max_dim: int = DEFAULT_PRINTED_MAX_DIM,
) -> tuple[str, dict[str, object]]:
    import shutil
    import subprocess

    tesseract_bin = shutil.which("tesseract")
    if not tesseract_bin:
        raise RuntimeError(
            "tesseract executable not found on PATH. Install tesseract-ocr "
            "(for example `apt install tesseract-ocr` or `brew install tesseract`)."
        )

    send_path = img_path
    cleanup_dir: str | None = None
    scale_info: dict[str, int] | None = None
    if raw_bytes is not None and work_dir is not None and max_dim > 0:
        send_path, cleanup_dir, scale_info = prepare_printed_image(
            img_path, raw_bytes, work_dir, max_dim=max_dim
        )

    try:
        # Pin OpenMP to a single thread so parallel OCR calls cannot thrash CPU cores.
        tesseract_env = {**os.environ, "OMP_THREAD_LIMIT": "1"}
        timeout_bin = shutil.which("timeout")
        tess_cmd = [
            tesseract_bin,
            send_path,
            "stdout",
            "--psm",
            str(psm),
            *(["tsv"] if tsv else []),
        ]
        cmd = [timeout_bin, "-k", "2", str(timeout_s), *tess_cmd] if timeout_bin else tess_cmd
        try:
            proc = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                timeout=timeout_s + 3 if timeout_bin else timeout_s,
                env=tesseract_env,
            )
        except subprocess.TimeoutExpired as exc:
            raise RuntimeError(
                f"tesseract timed out after {timeout_s}s on {os.path.basename(img_path)} "
                f"(increase --timeout or use --mode cursive for handwritten pages)."
            ) from exc
        if timeout_bin and proc.returncode in (124, 137):
            raise RuntimeError(
                f"tesseract timed out after {timeout_s}s on {os.path.basename(img_path)} "
                f"(increase --timeout or use --mode cursive for handwritten pages)."
            )
        if proc.returncode != 0:
            detail = (proc.stderr or proc.stdout).strip()
            if _is_tesseract_invalid_image_error(detail):
                raise InputImageError(
                    f"invalid or unreadable image {os.path.basename(img_path)}: {detail[:300]}"
                )
            raise RuntimeError(f"tesseract exited {proc.returncode}: {detail[:300]}")
        out = proc.stdout if tsv else proc.stdout.strip()
        if tsv and scale_info is not None:
            out = rescale_tesseract_tsv(
                out,
                scale_info["original_width"],
                scale_info["original_height"],
                scale_info["scaled_width"],
                scale_info["scaled_height"],
            )
        meta: dict[str, object] = {"psm": psm, "omp_thread_limit": 1, "timeout_s": timeout_s}
        if scale_info is not None:
            meta["downscaled"] = True
            meta["original_size"] = [scale_info["original_width"], scale_info["original_height"]]
            meta["scaled_size"] = [scale_info["scaled_width"], scale_info["scaled_height"]]
        return out, meta
    finally:
        if cleanup_dir is not None:
            shutil.rmtree(cleanup_dir, ignore_errors=True)


def parse_tesseract_tsv(tsv: str) -> dict[str, object]:
    """Group Tesseract TSV word rows into lines keyed by (page, block, par, line)."""
    rows = [r.split("\t") for r in tsv.splitlines() if r.strip()]
    if not rows or rows[0][:1] != ["level"]:
        raise RuntimeError("tesseract TSV output is missing its header row.")
    header = rows[0]
    image_width = image_height = 0
    lines: dict[tuple[int, int, int, int], dict[str, object]] = {}
    for raw in rows[1:]:
        if len(raw) < len(header) - 1:
            continue
        rec = dict(zip(header, raw + [""] * (len(header) - len(raw))))
        level = int(rec["level"])
        left, top = int(rec["left"]), int(rec["top"])
        right, bottom = left + int(rec["width"]), top + int(rec["height"])
        if level == 1:
            image_width = max(image_width, right)
            image_height = max(image_height, bottom)
            continue
        text = rec.get("text", "").strip()
        if level != 5 or not text:
            continue
        conf = float(rec["conf"])
        key = (int(rec["page_num"]), int(rec["block_num"]), int(rec["par_num"]), int(rec["line_num"]))
        line = lines.setdefault(key, {"words": []})
        line["words"].append(  # type: ignore[union-attr]
            {"text": text, "x0": left, "y0": top, "x1": right, "y1": bottom, "conf": conf}
        )
    out_lines: list[dict[str, object]] = []
    for (page, block, par, line_num), line in lines.items():
        words = line["words"]
        assert isinstance(words, list)
        confs = [w["conf"] for w in words if w["conf"] >= 0]
        out_lines.append(
            {
                "text": " ".join(str(w["text"]) for w in words),
                "x0": min(w["x0"] for w in words),
                "y0": min(w["y0"] for w in words),
                "x1": max(w["x1"] for w in words),
                "y1": max(w["y1"] for w in words),
                "conf": round(sum(confs) / len(confs), 2) if confs else -1.0,
                "page": page,
                "block": block,
                "par": par,
                "line": line_num,
                "words": words,
            }
        )
    return {"image_width": image_width, "image_height": image_height, "lines": out_lines}


def run_layout_data(
    opts: dict[str, object],
    img_path: str,
    raw_bytes: bytes,
    sha256_hex: str,
    cache_dir: str,
) -> tuple[str | dict[str, object], bool]:
    """Return (tsv_text_or_boxes_dict, cache_hit) using flock-protected layout cache files."""
    import re

    psm = int(opts["psm"])
    max_dim = int(opts["max_dim"])
    base = os.path.join(cache_dir, f"{sha256_hex}_printed_psm{psm}")
    tsv_path, boxes_path = f"{base}.tsv", f"{base}.boxes.json"
    lock_path = os.path.join(cache_dir, ".locks", f"{sha256_hex}_printed_psm{psm}.layout.lock")
    work_dir = os.path.join(cache_dir, ".work")
    timeout_val = opts["timeout"]
    timeout_s = int(timeout_val) if timeout_val is not None else DEFAULT_PRINTED_TIMEOUT_S
    force = bool(opts["force"])

    def _read_cached_tsv() -> str | None:
        if force or not os.path.isfile(tsv_path):
            return None
        try:
            with open(tsv_path, "r", encoding="utf-8") as fh:
                return fh.read()
        except OSError:
            return None

    def _read_cached_boxes() -> dict[str, object] | None:
        if force or not os.path.isfile(boxes_path):
            return None
        try:
            with open(boxes_path, "r", encoding="utf-8") as fh:
                parsed = json.load(fh)
            return parsed if isinstance(parsed, dict) else None
        except (OSError, json.JSONDecodeError):
            return None

    def load_tsv() -> tuple[str, bool]:
        existing = _read_cached_tsv()
        if existing is not None:
            return existing, True
        with file_lock(lock_path):
            existing = _read_cached_tsv()
            if existing is not None:
                return existing, True
            tsv, _ = run_printed_ocr(
                img_path,
                psm=psm,
                timeout_s=timeout_s,
                tsv=True,
                raw_bytes=raw_bytes,
                work_dir=work_dir,
                max_dim=max_dim,
            )
            atomic_write_text(tsv_path, tsv)
            return tsv, False

    if opts["tsv"]:
        tsv, cached = load_tsv()
        return (tsv if tsv.endswith("\n") else tsv + "\n"), cached

    boxes = _read_cached_boxes()
    cached = boxes is not None
    if boxes is None:
        with file_lock(lock_path):
            boxes = _read_cached_boxes()
            if boxes is not None:
                cached = True
            else:
                tsv = _read_cached_tsv()
                if tsv is not None:
                    cached = True
                else:
                    tsv, _ = run_printed_ocr(
                        img_path,
                        psm=psm,
                        timeout_s=timeout_s,
                        tsv=True,
                        raw_bytes=raw_bytes,
                        work_dir=work_dir,
                        max_dim=max_dim,
                    )
                    atomic_write_text(tsv_path, tsv)
                    cached = False
                boxes = {"sha256": sha256_hex, "psm": psm, **parse_tesseract_tsv(tsv)}
                atomic_write_json(boxes_path, boxes)

    out: dict[str, object] = {
        **boxes,
        "cached": cached,
        "cache_hit": cached,
        "cache_path": boxes_path,
    }
    pattern = opts["find"]
    if isinstance(pattern, str):
        rx = re.compile(pattern, re.IGNORECASE)
        lines = boxes.get("lines") or []
        assert isinstance(lines, list)
        out["find"] = pattern
        out["lines"] = [ln for ln in lines if rx.search(str(ln.get("text", "")))]
    return out, cached


def run_ocr_data(
    opts: dict[str, object],
    img_path: str,
    raw_bytes: bytes,
    sha256_hex: str,
    cache_dir: str,
) -> tuple[dict[str, object], bool]:
    """Return (ocr_record_with_cache_meta, cache_hit) for one image with per-key flock."""
    from datetime import datetime, timezone

    t_item = time.perf_counter()
    mode = str(opts["mode"])
    psm = int(opts["psm"])
    max_dim = int(opts["max_dim"])
    effort = str(opts["effort"])
    custom_prompt = opts["prompt"] if isinstance(opts["prompt"], str) else None
    slug = mode_slug(mode, psm, effort, custom_prompt)
    cache_file = os.path.join(cache_dir, f"{sha256_hex}_{slug}.json")
    lock_file = os.path.join(cache_dir, ".locks", f"{sha256_hex}_{slug}.lock")
    work_dir = os.path.join(cache_dir, ".work")

    def _try_read_cache() -> dict[str, object] | None:
        if opts["force"] or not os.path.isfile(cache_file):
            return None
        try:
            with open(cache_file, "r", encoding="utf-8") as fh:
                rec = json.load(fh)
        except (OSError, json.JSONDecodeError):
            return None
        if isinstance(rec, dict) and isinstance(rec.get("text"), str):
            return rec
        return None

    cached_rec = _try_read_cache()
    if cached_rec is not None:
        lookup_ms = round((time.perf_counter() - t_item) * 1000.0, 2)
        return (
            {
                **cached_rec,
                "cached": True,
                "cache_hit": True,
                "cache_path": cache_file,
                "lookup_ms": lookup_ms,
            },
            True,
        )

    with file_lock(lock_file):
        cached_rec = _try_read_cache()
        if cached_rec is not None:
            lookup_ms = round((time.perf_counter() - t_item) * 1000.0, 2)
            return (
                {
                    **cached_rec,
                    "cached": True,
                    "cache_hit": True,
                    "cache_path": cache_file,
                    "lookup_ms": lookup_ms,
                },
                True,
            )

        timeout_val = opts["timeout"]
        timeout_s = (
            int(timeout_val)
            if timeout_val is not None
            else (DEFAULT_PRINTED_TIMEOUT_S if mode == "printed" else DEFAULT_CURSIVE_TIMEOUT_S)
        )
        t_ocr = time.perf_counter()
        if mode == "printed":
            text, meta = run_printed_ocr(
                img_path,
                psm=psm,
                timeout_s=timeout_s,
                raw_bytes=raw_bytes,
                work_dir=work_dir,
                max_dim=max_dim,
            )
            engine = "tesseract"
        else:
            text, meta = run_cursive_ocr(
                img_path=img_path,
                raw_len=len(raw_bytes),
                effort=effort,
                timeout_s=timeout_s,
                cache_dir=cache_dir,
                custom_prompt=custom_prompt,
            )
            engine = f"{meta.get('cli', resolve_vision_cli())}:{meta.get('model', '')}"

        elapsed_ms = int(round((time.perf_counter() - t_ocr) * 1000.0))
        record = {
            "sha256": sha256_hex,
            "mode": slug,
            "engine": engine,
            "created_at": datetime.now(timezone.utc).isoformat(),
            "elapsed_ms": elapsed_ms,
            "text": text,
            "source_hint": os.path.basename(img_path),
            "meta": meta,
        }
        atomic_write_json(cache_file, record)
        return (
            {
                **record,
                "cached": False,
                "cache_hit": False,
                "cache_path": cache_file,
                "lookup_ms": round((time.perf_counter() - t_item) * 1000.0, 2),
            },
            False,
        )


def prepare_cursive_image(img_path: str, raw_len: int, work_dir: str) -> tuple[str, str | None, int]:
    if raw_len <= CURSIVE_MAX_INPUT_BYTES:
        return img_path, None, raw_len

    import shutil

    os.makedirs(work_dir, exist_ok=True)
    job_dir = os.path.join(
        work_dir, f"job_{os.getpid()}_{threading.get_ident()}_{time.time_ns()}"
    )
    os.makedirs(job_dir, exist_ok=True)
    try:
        rc, stdout, stderr = _run_prep_scan(
            [
                "preview",
                img_path,
                "--out-dir",
                job_dir,
                "--max-width",
                str(CURSIVE_TARGET_MAX_WIDTH),
                "--max-kb",
                str(CURSIVE_TARGET_KB),
                "--json",
            ],
            timeout_s=60,
        )
        if rc != 0:
            raise RuntimeError(
                f"prep-scan.py failed ({rc}): {(stderr or stdout).strip()[:300]}"
            )
        info = json.loads(stdout)[0]
        return str(info["path"]), job_dir, int(info["bytes"])
    except Exception:
        shutil.rmtree(job_dir, ignore_errors=True)
        raise


def run_cursive_ocr(
    img_path: str,
    raw_len: int,
    effort: str,
    timeout_s: int,
    cache_dir: str,
    custom_prompt: str | None,
) -> tuple[str, dict[str, object]]:
    import shutil
    import subprocess

    cli_name = resolve_vision_cli()
    cli_bin = shutil.which(cli_name)
    if not cli_bin:
        raise RuntimeError(
            f"Vision CLI '{cli_name}' not found on PATH. Install '{cli_name}' "
            "or set KINLOOM_OCR_CLI to a compatible vision CLI executable."
        )

    model = os.environ.get("KINLOOM_OCR_MODEL", "").strip() or f"gemini-4-hydrogen-{effort}"
    work_dir = os.path.join(cache_dir, ".work")
    send_path, cleanup_dir, sent_bytes = prepare_cursive_image(img_path, raw_len, work_dir)
    try:
        prompt_template = custom_prompt or DEFAULT_CURSIVE_PROMPT
        prompt = (
            prompt_template.format(image_path=send_path)
            if "{image_path}" in prompt_template
            else f"Call read_file ONCE on {send_path}. {prompt_template}"
        )
        add_dir = os.path.dirname(send_path)
        try:
            proc = subprocess.run(
                [
                    cli_bin,
                    "--model",
                    model,
                    "--dangerously-skip-permissions",
                    "--disable-slash-commands",
                    "--add-dir",
                    add_dir,
                    "--output-format",
                    "json",
                    "--print-timeout",
                    f"{timeout_s}s",
                    f"-p={prompt}",
                ],
                cwd=add_dir,
                capture_output=True,
                text=True,
                timeout=timeout_s + 15,
            )
        except subprocess.TimeoutExpired as exc:
            raise RuntimeError(
                f"{cli_name} timed out after {timeout_s}s on {os.path.basename(img_path)} "
                f"(pass a higher --timeout to override)."
            ) from exc
        if proc.returncode != 0:
            detail = (proc.stderr or proc.stdout).strip()
            raise RuntimeError(f"{cli_name} exited {proc.returncode}: {detail[:400]}")
        try:
            payload = json.loads(proc.stdout)
        except json.JSONDecodeError as exc:
            raise RuntimeError(f"{cli_name} returned non-JSON stdout: {proc.stdout[:300]}") from exc
        if payload.get("status") != "SUCCESS":
            raise RuntimeError(
                f"{cli_name} returned status={payload.get('status')}: {str(payload)[:300]}"
            )
        text = str(payload.get("response") or "").strip()
        if not text:
            raise RuntimeError(f"{cli_name} returned an empty transcription response.")
        usage = payload.get("usage") or {}
        meta: dict[str, object] = {
            "cli": cli_name,
            "model": model,
            "effort": effort,
            "sent_bytes": sent_bytes,
            "duration_seconds": payload.get("duration_seconds"),
            "thinking_tokens": usage.get("thinking_tokens"),
            "output_tokens": usage.get("output_tokens"),
        }
        return text, meta
    finally:
        if cleanup_dir is not None:
            shutil.rmtree(cleanup_dir, ignore_errors=True)


def append_telemetry(
    *,
    mode: str,
    duration_ms: float,
    cache_hit: bool | None,
    exit_code: int,
    bytes_out: int,
) -> None:
    sig_file = os.environ.get("KINLOOM_CACHE_HIT_FILE")
    if sig_file and isinstance(cache_hit, bool):
        try:
            with open(sig_file, "w", encoding="utf-8") as sfh:
                sfh.write("1" if cache_hit else "0")
        except Exception:
            pass
    if (
        os.environ.get("KINLOOM_TELEMETRY_PARENT") == "1"
        or os.environ.get("KINLOOM_TELEMETRY_ACTIVE") == "1"
    ):
        return
    try:
        from datetime import datetime, timezone

        target = default_telemetry_file()
        parent = os.path.dirname(os.path.abspath(target))
        if parent:
            os.makedirs(parent, exist_ok=True)
        entry = {
            "ts": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            "cmd": "cached-ocr.py",
            "subcmd": f"ocr {mode}" if mode else "ocr",
            "person_id": None,
            "duration_ms": max(0, int(round(duration_ms))),
            "cache_hit": cache_hit,
            "exit_code": int(exit_code),
            "bytes_out": max(0, int(bytes_out)),
        }
        with open(target, "a", encoding="utf-8") as fh:
            fh.write(json.dumps(entry, separators=(",", ":")) + "\n")
    except Exception:
        pass


def _write_stdout_safely(rendered: str) -> bool:
    """Write rendered output to stdout. Return False on BrokenPipeError without noise."""
    try:
        sys.stdout.write(rendered)
        sys.stdout.flush()
        return True
    except BrokenPipeError:
        try:
            devnull = os.open(os.devnull, os.O_WRONLY)
            os.dup2(devnull, sys.stdout.fileno())
            os.close(devnull)
        except OSError:
            pass
        return False


def main(argv: list[str] | None = None) -> int:
    t_start = time.perf_counter()
    try:
        opts = parse_args(sys.argv[1:] if argv is None else argv)
    except ValueError as exc:
        sys.stderr.write(f"Error: {exc}\n")
        append_telemetry(
            mode="",
            duration_ms=(time.perf_counter() - t_start) * 1000.0,
            cache_hit=None,
            exit_code=2,
            bytes_out=0,
        )
        return 2

    raw_images = opts["images"]
    assert isinstance(raw_images, list)
    mode = str(opts["mode"])
    workers = int(opts["workers"])
    resolved_images: list[tuple[str, str, bytes, str]] = []
    for raw_arg in raw_images:
        img_path = os.path.abspath(str(raw_arg))
        try:
            raw_bytes = validate_image_file(img_path)
        except InputImageError as exc:
            sys.stderr.write(f"Error: {exc}\n")
            append_telemetry(
                mode=mode,
                duration_ms=(time.perf_counter() - t_start) * 1000.0,
                cache_hit=None,
                exit_code=2,
                bytes_out=0,
            )
            return 2
        sha256_hex = hashlib.sha256(raw_bytes).hexdigest()
        resolved_images.append((str(raw_arg), img_path, raw_bytes, sha256_hex))

    cache_dir = os.path.abspath(str(opts["cache_dir"]))
    multi = len(resolved_images) > 1
    pool_workers = min(workers, len(resolved_images))

    if opts["boxes"] or opts["tsv"]:
        layout_mode = "tsv" if opts["tsv"] else "boxes"

        def _layout_worker(
            item: tuple[str, str, bytes, str]
        ) -> tuple[str, str, str | dict[str, object], bool]:
            raw_arg, img_path, raw_bytes, sha256_hex = item
            data, cached = run_layout_data(opts, img_path, raw_bytes, sha256_hex, cache_dir)
            return raw_arg, img_path, data, cached

        try:
            if multi and pool_workers > 1:
                with ThreadPoolExecutor(max_workers=pool_workers) as executor:
                    completed_layout = list(executor.map(_layout_worker, resolved_images))
            else:
                completed_layout = [_layout_worker(item) for item in resolved_images]
        except InputImageError as exc:
            sys.stderr.write(f"Error: {exc}\n")
            append_telemetry(
                mode=layout_mode,
                duration_ms=(time.perf_counter() - t_start) * 1000.0,
                cache_hit=False,
                exit_code=2,
                bytes_out=0,
            )
            return 2
        except Exception as exc:
            sys.stderr.write(f"Error: {exc}\n")
            append_telemetry(
                mode=layout_mode,
                duration_ms=(time.perf_counter() - t_start) * 1000.0,
                cache_hit=False,
                exit_code=1,
                bytes_out=0,
            )
            return 1

        layout_results = [(raw_arg, img_path, data) for raw_arg, img_path, data, _ in completed_layout]
        hits = [cached for _, _, _, cached in completed_layout]
        all_cached = bool(hits) and all(hits)

        if not multi:
            single_data = layout_results[0][2]
            if opts["tsv"]:
                assert isinstance(single_data, str)
                rendered = single_data
            else:
                rendered = json.dumps(single_data, indent=2, ensure_ascii=False) + "\n"
        elif opts["tsv"]:
            sections = [
                f"=== {raw_arg} ===\n{str(data).rstrip()}"
                for raw_arg, _img_path, data in layout_results
            ]
            rendered = "\n\n".join(sections) + "\n"
        else:
            files_out = []
            for raw_arg, img_path, data in layout_results:
                assert isinstance(data, dict)
                files_out.append({"file": raw_arg, "path": img_path, **data})
            rendered = (
                json.dumps(
                    {
                        "files": files_out,
                        "count": len(files_out),
                        "cache_hits": sum(1 for h in hits if h),
                        "cache_hit": all_cached,
                    },
                    indent=2,
                    ensure_ascii=False,
                )
                + "\n"
            )

        wrote = _write_stdout_safely(rendered)
        append_telemetry(
            mode=layout_mode,
            duration_ms=(time.perf_counter() - t_start) * 1000.0,
            cache_hit=all_cached,
            exit_code=0,
            bytes_out=len(rendered.encode("utf-8")) if wrote else 0,
        )
        return 0

    def _ocr_worker(
        item: tuple[str, str, bytes, str]
    ) -> tuple[str, str, dict[str, object], bool]:
        raw_arg, img_path, raw_bytes, sha256_hex = item
        record, cached = run_ocr_data(opts, img_path, raw_bytes, sha256_hex, cache_dir)
        return raw_arg, img_path, record, cached

    try:
        if multi and pool_workers > 1:
            with ThreadPoolExecutor(max_workers=pool_workers) as executor:
                completed_ocr = list(executor.map(_ocr_worker, resolved_images))
        else:
            completed_ocr = [_ocr_worker(item) for item in resolved_images]
    except InputImageError as exc:
        sys.stderr.write(f"Error: {exc}\n")
        append_telemetry(
            mode=mode,
            duration_ms=(time.perf_counter() - t_start) * 1000.0,
            cache_hit=False,
            exit_code=2,
            bytes_out=0,
        )
        return 2
    except Exception as exc:
        sys.stderr.write(f"Error: {exc}\n")
        append_telemetry(
            mode=mode,
            duration_ms=(time.perf_counter() - t_start) * 1000.0,
            cache_hit=False,
            exit_code=1,
            bytes_out=0,
        )
        return 1

    ocr_results = [(raw_arg, img_path, rec) for raw_arg, img_path, rec, _ in completed_ocr]
    hits = [cached for _, _, _, cached in completed_ocr]
    all_cached = bool(hits) and all(hits)

    if not multi:
        single_rec = ocr_results[0][2]
        if opts["json"]:
            rendered = json.dumps(single_rec, indent=2, ensure_ascii=False) + "\n"
        else:
            rendered = str(single_rec["text"]) + "\n"
    elif opts["json"]:
        files_out = [
            {"file": raw_arg, "path": img_path, **rec}
            for raw_arg, img_path, rec in ocr_results
        ]
        rendered = (
            json.dumps(
                {
                    "files": files_out,
                    "count": len(files_out),
                    "cache_hits": sum(1 for h in hits if h),
                    "cache_hit": all_cached,
                },
                indent=2,
                ensure_ascii=False,
            )
            + "\n"
        )
    else:
        sections = [
            f"=== {raw_arg} ===\n{rec['text']}"
            for raw_arg, _img_path, rec in ocr_results
        ]
        rendered = "\n\n".join(sections) + "\n"

    wrote = _write_stdout_safely(rendered)
    append_telemetry(
        mode=mode,
        duration_ms=(time.perf_counter() - t_start) * 1000.0,
        cache_hit=all_cached,
        exit_code=0,
        bytes_out=len(rendered.encode("utf-8")) if wrote else 0,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
