#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = [
#   "httpx>=0.27",
#   "pillow>=10.0",
# ]
# ///
"""Scan preparation CLI: image info, multi-file joins, compact previews, redacted crops, census strips, and selective PDF page renders."""

from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timezone
import hashlib
import io
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import time
from typing import TYPE_CHECKING, Any, Iterator
from urllib.parse import urlparse

if TYPE_CHECKING:
    from PIL import Image as PILImageModule

DEFAULT_MAX_WORKERS = 8
DEFAULT_TIMEOUT_S = 12.0
DEFAULT_PDF_TIMEOUT_S = 60
USER_AGENT = "kinloom-prep-scan/1.0 (genealogy archival tooling)"
PDF_PAGE_NUM_RE = re.compile(r"-(\d+)\.jpg$", re.IGNORECASE)


def default_cache_root() -> Path:
    env_dir = os.environ.get("KINLOOM_OCR_CACHE_DIR", "").strip()
    if env_dir:
        return Path(env_dir).expanduser()
    xdg = os.environ.get("XDG_CACHE_HOME", "").strip()
    if xdg:
        return Path(xdg).expanduser() / "kinloom-ocr"
    return Path.home() / ".cache" / "kinloom-ocr"


@contextmanager
def file_lock(lock_path: Path) -> Iterator[None]:
    """Advisory exclusive lock so two extractions of one PDF do not write the same cache file."""
    try:
        import fcntl
    except ImportError:
        yield
        return

    lock_path.parent.mkdir(parents=True, exist_ok=True)
    with open(lock_path, "a+b") as lock_file:
        fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)


def atomic_write_text(dest: Path, text: str) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_name(f".{dest.name}.{os.getpid()}.{time.time_ns()}.tmp")
    try:
        tmp.write_text(text, encoding="utf-8")
        os.replace(tmp, dest)
    except Exception:
        tmp.unlink(missing_ok=True)
        raise


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def default_telemetry_file() -> Path:
    env_file = os.environ.get("KINLOOM_TELEMETRY_FILE", "").strip()
    if env_file:
        return Path(env_file).expanduser()
    xdg = os.environ.get("XDG_CACHE_HOME", "").strip()
    if xdg:
        return Path(xdg).expanduser() / "kinloom-telemetry" / "calls.jsonl"
    return Path.home() / ".cache" / "kinloom-telemetry" / "calls.jsonl"


def require_pillow() -> tuple[Any, Any, Any, Any]:
    try:
        from PIL import Image, ImageDraw, ImageFont, ImageOps
    except ImportError as exc:
        raise RuntimeError(
            "Pillow is required for image operations. Run via `uv run --script` "
            "or install it with `pip install pillow`."
        ) from exc
    return Image, ImageDraw, ImageFont, ImageOps


def append_telemetry(subcmd: str, duration_ms: float, exit_code: int, bytes_out: int) -> None:
    if (
        os.environ.get("KINLOOM_TELEMETRY_PARENT") == "1"
        or os.environ.get("KINLOOM_TELEMETRY_ACTIVE") == "1"
    ):
        return
    try:
        target = default_telemetry_file()
        target.parent.mkdir(parents=True, exist_ok=True)
        entry = {
            "ts": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            "cmd": "prep-scan.py",
            "subcmd": f"prep-scan {subcmd}" if subcmd else "prep-scan",
            "person_id": None,
            "duration_ms": max(0, int(round(duration_ms))),
            "cache_hit": None,
            "exit_code": int(exit_code),
            "bytes_out": max(0, int(bytes_out)),
        }
        with open(target, "a", encoding="utf-8") as fh:
            fh.write(json.dumps(entry, separators=(",", ":")) + "\n")
    except Exception:
        pass


@dataclass(frozen=True)
class Box:
    x0: int
    y0: int
    x1: int
    y1: int


@dataclass(frozen=True)
class SavedImage:
    path: Path
    width: int
    height: int
    bytes: int

    def to_dict(self) -> dict[str, object]:
        return {
            "path": str(self.path),
            "width": self.width,
            "height": self.height,
            "bytes": self.bytes,
            "kb": round(self.bytes / 1024.0, 1),
        }


def parse_box(raw: str) -> Box:
    # Accept "x0,y0,x1,y1", "x0, y0, x1, y1", and "x0 y0 x1 y1".
    parts = [p for p in re.split(r"[,\s]+", raw.strip()) if p]
    if len(parts) != 4:
        raise argparse.ArgumentTypeError(f"Invalid box '{raw}': expected x0,y0,x1,y1.")
    try:
        x0, y0, x1, y1 = (int(round(float(p))) for p in parts)
    except ValueError as exc:
        raise argparse.ArgumentTypeError(f"Invalid integer coordinates in box '{raw}'.") from exc
    if x0 < 0 or y0 < 0 or x1 <= x0 or y1 <= y0:
        raise argparse.ArgumentTypeError(
            f"Invalid box '{raw}': require 0 <= x0 < x1 and 0 <= y0 < y1."
        )
    return Box(x0, y0, x1, y1)


def parse_page_spec(raw: str) -> list[int]:
    pages: set[int] = set()
    for part in raw.split(","):
        token = part.strip()
        if not token:
            continue
        if "-" in token:
            bounds = token.split("-", 1)
            try:
                start = int(bounds[0].strip())
                end = int(bounds[1].strip())
            except ValueError as exc:
                raise ValueError(f"Invalid page range '{token}' in --pages '{raw}'.") from exc
            if start < 1 or end < start:
                raise ValueError(f"Invalid page range '{token}': require 1 <= start <= end.")
            if end - start > 500:
                raise ValueError(f"Page range '{token}' exceeds 500-page safety limit.")
            pages.update(range(start, end + 1))
        else:
            try:
                num = int(token)
            except ValueError as exc:
                raise ValueError(f"Invalid page number '{token}' in --pages '{raw}'.") from exc
            if num < 1:
                raise ValueError(f"Page number must be >= 1, got {num}.")
            pages.add(num)
    if not pages:
        raise ValueError(f"No valid pages parsed from --pages '{raw}'.")
    return sorted(pages)


def coalesce_ranges(pages: list[int]) -> list[tuple[int, int]]:
    ranges: list[tuple[int, int]] = []
    start = prev = pages[0]
    for p in pages[1:]:
        if p == prev + 1:
            prev = p
        else:
            ranges.append((start, prev))
            start = prev = p
    ranges.append((start, prev))
    return ranges


def clamp_box(
    box: Box, width: int, height: int, label: str, outside_hint: str = ""
) -> Box:
    if box.x0 >= width or box.y0 >= height:
        extra = f" {outside_hint}" if outside_hint else ""
        raise ValueError(
            f"{label} ({box.x0},{box.y0},{box.x1},{box.y1}) starts outside {width}x{height} image.{extra}"
        )
    x1 = min(box.x1, width)
    y1 = min(box.y1, height)
    if x1 <= box.x0 or y1 <= box.y0:
        raise ValueError(f"{label} collapses to empty area inside {width}x{height} image.")
    return Box(box.x0, box.y0, x1, y1)


def paint_black_boxes(
    image: Any,
    boxes: list[Box],
    label: str,
    outside_hint: str = "",
) -> list[list[int]]:
    """Fill each box with black. Coordinates are pixels of `image`, inclusive of both corners."""
    painted: list[list[int]] = []
    if not boxes:
        return painted
    _, ImageDraw, _, _ = require_pillow()
    draw = ImageDraw.Draw(image)
    for idx, rbox in enumerate(boxes, 1):
        clamped = clamp_box(
            rbox, image.width, image.height, f"{label} #{idx}", outside_hint=outside_hint
        )
        draw.rectangle((clamped.x0, clamped.y0, clamped.x1, clamped.y1), fill=(0, 0, 0))
        painted.append([clamped.x0, clamped.y0, clamped.x1, clamped.y1])
    return painted


def to_rgb(im: PILImageModule.Image) -> PILImageModule.Image:
    Image, _, _, ImageOps = require_pillow()
    im = ImageOps.exif_transpose(im)
    if im.mode == "RGB":
        return im
    if im.mode in ("RGBA", "LA") or (im.mode == "P" and "transparency" in im.info):
        rgba = im.convert("RGBA")
        bg = Image.new("RGB", rgba.size, (255, 255, 255))
        bg.paste(rgba, mask=rgba.split()[3])
        return bg
    return im.convert("RGB")


def rotate_clockwise(im: PILImageModule.Image, degrees: int | None) -> PILImageModule.Image:
    if not degrees:
        return im
    Image, _, _, _ = require_pillow()
    if degrees == 90:
        return im.transpose(Image.Transpose.ROTATE_270)
    if degrees == 180:
        return im.transpose(Image.Transpose.ROTATE_180)
    if degrees == 270:
        return im.transpose(Image.Transpose.ROTATE_90)
    raise ValueError(f"Unsupported rotation '{degrees}': expected 90, 180, or 270.")


def atomic_write_bytes(dest: Path, data: bytes) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_name(f".{dest.name}.{os.getpid()}.tmp")
    try:
        tmp.write_bytes(data)
        os.replace(tmp, dest)
    except Exception:
        if tmp.exists():
            tmp.unlink(missing_ok=True)
        raise


def encode_jpeg_under_kb(
    im: PILImageModule.Image, max_width: int, max_kb: int
) -> tuple[bytes, int, int]:
    Image, _, _, _ = require_pillow()
    rgb = to_rgb(im)
    w, h = rgb.size
    if max_width > 0 and w > max_width:
        new_h = max(1, int(round(h * (max_width / w))))
        rgb = rgb.resize((max_width, new_h), Image.Resampling.LANCZOS)

    limit_bytes = max(1024, int(max_kb * 1024))
    base_w, base_h = rgb.size
    best_data: bytes = b""
    best_size = (base_w, base_h)

    for scale in (1.0, 0.88, 0.76, 0.64, 0.52, 0.42, 0.34, 0.25):
        cur = (
            rgb
            if scale == 1.0
            else rgb.resize(
                (max(1, int(round(base_w * scale))), max(1, int(round(base_h * scale)))),
                Image.Resampling.LANCZOS,
            )
        )
        for quality in (84, 76, 68, 60, 52, 44, 36):
            buf = io.BytesIO()
            cur.save(buf, format="JPEG", quality=quality, optimize=True)
            data = buf.getvalue()
            best_data = data
            best_size = cur.size
            if len(data) <= limit_bytes:
                return data, cur.size[0], cur.size[1]

    return best_data, best_size[0], best_size[1]


def save_compact_jpeg(
    im: PILImageModule.Image, out_path: Path, max_width: int, max_kb: int
) -> SavedImage:
    data, width, height = encode_jpeg_under_kb(im, max_width=max_width, max_kb=max_kb)
    atomic_write_bytes(out_path, data)
    return SavedImage(path=out_path, width=width, height=height, bytes=len(data))


def save_archival_image(
    im: PILImageModule.Image, out_path: Path, quality: int = 92
) -> SavedImage:
    rgb = to_rgb(im)
    ext = out_path.suffix.lower()
    buf = io.BytesIO()
    if ext == ".png":
        rgb.save(buf, format="PNG", optimize=True)
    elif ext == ".webp":
        rgb.save(buf, format="WEBP", quality=quality)
    else:
        rgb.save(buf, format="JPEG", quality=quality, optimize=True)
    data = buf.getvalue()
    atomic_write_bytes(out_path, data)
    return SavedImage(path=out_path, width=rgb.size[0], height=rgb.size[1], bytes=len(data))


def parse_join_direction(raw: str) -> str:
    key = raw.strip().lower()
    table = {
        "v": "vertical",
        "vertical": "vertical",
        "h": "horizontal",
        "horizontal": "horizontal",
    }
    if key not in table:
        raise argparse.ArgumentTypeError(
            f"Invalid --direction '{raw}': expected vertical, horizontal, v, or h."
        )
    return table[key]


def parse_join_align(raw: str) -> str:
    key = raw.strip().lower()
    if key not in ("start", "center", "end"):
        raise argparse.ArgumentTypeError(
            f"Invalid --align '{raw}': expected start, center, or end."
        )
    return key


def align_offset(outer: int, inner: int, align: str) -> int:
    slack = outer - inner
    if slack <= 0 or align == "start":
        return 0
    if align == "end":
        return slack
    return slack // 2


def join_frames(
    frames: list[Any],
    *,
    direction: str,
    gap: int,
    align: str,
    background: tuple[int, int, int],
) -> Any:
    Image, _, _, _ = require_pillow()
    if direction == "horizontal":
        width = sum(frame.width for frame in frames) + gap * (len(frames) - 1)
        height = max(frame.height for frame in frames)
    else:
        width = max(frame.width for frame in frames)
        height = sum(frame.height for frame in frames) + gap * (len(frames) - 1)
    canvas = Image.new("RGB", (max(1, width), max(1, height)), background)
    cursor = 0
    for frame in frames:
        if direction == "horizontal":
            x = cursor
            y = align_offset(canvas.height, frame.height, align)
            cursor += frame.width + gap
        else:
            x = align_offset(canvas.width, frame.width, align)
            y = cursor
            cursor += frame.height + gap
        canvas.paste(frame, (x, y))
    return canvas


def load_rgb_image(src: Path) -> Any:
    Image, _, _, _ = require_pillow()
    try:
        with Image.open(src) as raw:
            raw.load()
            rgb = to_rgb(raw)
            if rgb is raw:
                rgb = raw.copy()
            return rgb
    except Exception as exc:
        raise ValueError(
            f"Cannot read image '{src}': {exc}. Use a JPEG, PNG, WEBP, or TIFF file."
        ) from exc


def parse_rgb_color(raw: str) -> tuple[int, int, int]:
    try:
        from PIL import ImageColor

        rgb = ImageColor.getrgb(raw.strip())
    except Exception as exc:
        raise ValueError(f"Invalid --divider-color '{raw}': expected hex or named RGB color.") from exc
    return (int(rgb[0]), int(rgb[1]), int(rgb[2]))


def load_label_font(image_font_mod: Any, size: int = 14) -> Any:
    try:
        return image_font_mod.load_default(size=size)
    except TypeError:
        return image_font_mod.load_default()


def safe_stem(name: str) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9._-]+", "_", name).strip("_")
    return cleaned or "scan"


def emit_output(text: str) -> int:
    sys.stdout.write(text)
    return len(text.encode("utf-8"))


def cmd_preview(args: argparse.Namespace) -> tuple[int, int]:
    Image, _, _, ImageOps = require_pillow()
    out_dir = Path(args.out_dir).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)

    inputs = [Path(p).resolve() for p in args.images]
    missing = [str(p) for p in inputs if not p.is_file()]
    if missing:
        for m in missing:
            print(f"Error: input file not found: {m}", file=sys.stderr)
        return 1, 0

    stem_counts: dict[str, int] = {}
    for p in inputs:
        stem = safe_stem(p.stem)
        stem_counts[stem] = stem_counts.get(stem, 0) + 1

    def build_one(src: Path) -> dict[str, object]:
        stem = safe_stem(src.stem)
        if stem_counts[stem] > 1:
            suffix = hashlib.sha256(str(src).encode("utf-8")).hexdigest()[:8]
            out_name = f"{stem}_{suffix}.preview.jpg"
        else:
            out_name = f"{stem}.preview.jpg"
        out_path = out_dir / out_name
        with Image.open(src) as im:
            orig_w, orig_h = ImageOps.exif_transpose(im).size
            saved = save_compact_jpeg(im, out_path, max_width=args.max_width, max_kb=args.max_kb)
        return {
            "source": str(src),
            "source_size": [orig_w, orig_h],
            **saved.to_dict(),
        }

    workers = min(DEFAULT_MAX_WORKERS, max(1, len(inputs)))
    with ThreadPoolExecutor(max_workers=workers) as pool:
        results = list(pool.map(build_one, inputs))

    if args.json:
        out_bytes = emit_output(json.dumps(results, indent=2) + "\n")
    else:
        lines = [
            f"{item['path']}  {item['width']}x{item['height']}  {item['kb']:.1f} KB"
            for item in results
        ]
        out_bytes = emit_output("\n".join(lines) + ("\n" if lines else ""))
    return 0, out_bytes


def cmd_crop(args: argparse.Namespace) -> tuple[int, int]:
    if not 1 <= args.quality <= 100:
        raise ValueError(f"--quality must be between 1 and 100, got {args.quality}.")
    Image, _, _, _ = require_pillow()
    src = Path(args.input).resolve()
    out_path = Path(args.output).resolve()
    if not src.is_file():
        print(f"Error: input file not found: {src}", file=sys.stderr)
        return 1, 0

    with Image.open(src) as raw_im:
        img = rotate_clockwise(to_rgb(raw_im), args.rotate)

    redactions_orig = paint_black_boxes(img, list(args.redact_orig), "--redact-orig")

    requested = args.box if args.box is not None else Box(0, 0, img.width, img.height)
    crop_box = clamp_box(requested, img.width, img.height, "crop --box")
    cropped = img.crop((crop_box.x0, crop_box.y0, crop_box.x1, crop_box.y1))

    redactions = paint_black_boxes(
        cropped,
        list(args.redact),
        "--redact",
        outside_hint=(
            "If you read the box from prep-scan grid, pass the same numbers to --redact-orig. "
            "--redact uses coordinates on the cropped image."
        ),
    )

    saved = save_archival_image(cropped, out_path, quality=args.quality)

    if args.preview_out:
        preview_path = Path(args.preview_out).resolve()
    else:
        digest = hashlib.sha256(str(out_path).encode("utf-8")).hexdigest()[:8]
        preview_path = (
            default_cache_root()
            / "previews"
            / f"{safe_stem(out_path.stem)}_{digest}.preview.jpg"
        )

    preview = save_compact_jpeg(cropped, preview_path, max_width=args.max_width, max_kb=args.max_kb)

    payload = {
        "source": str(src),
        "rotate": args.rotate or 0,
        "box": [crop_box.x0, crop_box.y0, crop_box.x1, crop_box.y1],
        "redactions": redactions,
        "redactions_orig": redactions_orig,
        "output": saved.to_dict(),
        "preview": preview.to_dict(),
    }

    if args.json:
        out_bytes = emit_output(json.dumps(payload, indent=2) + "\n")
    else:
        text = (
            f"output:  {saved.path}  {saved.width}x{saved.height}  {saved.bytes / 1024:.1f} KB\n"
            f"preview: {preview.path}  {preview.width}x{preview.height}  {preview.bytes / 1024:.1f} KB\n"
        )
        out_bytes = emit_output(text)
    return 0, out_bytes


def is_url(target: str) -> bool:
    parsed = urlparse(target)
    return parsed.scheme in ("http", "https") and bool(parsed.netloc)


def short_label(target: str, index: int) -> str:
    if is_url(target):
        parsed = urlparse(target)
        tail = Path(parsed.path).name or parsed.netloc
        return f"[{index:02d}] {tail}"
    return f"[{index:02d}] {Path(target).name}"


def load_image_from_source(target: str, timeout_s: float) -> PILImageModule.Image:
    Image, _, _, _ = require_pillow()
    if is_url(target):
        try:
            import httpx
        except ImportError as exc:
            raise RuntimeError(
                "httpx is required for URL downloads. Run via `uv run --script` "
                "or install it with `pip install httpx`."
            ) from exc

        with httpx.Client(
            timeout=timeout_s,
            follow_redirects=True,
            headers={"User-Agent": USER_AGENT},
        ) as client:
            resp = client.get(target)
            resp.raise_for_status()
            return to_rgb(Image.open(io.BytesIO(resp.content)))
    path = Path(target).resolve()
    if not path.is_file():
        raise FileNotFoundError(f"file not found: {path}")
    with Image.open(path) as im:
        return to_rgb(im.copy())


def extract_band(
    im: PILImageModule.Image, band: str, band_pct: float, rotate_left: bool
) -> PILImageModule.Image:
    Image, _, _, _ = require_pillow()
    frac = max(0.02, min(1.0, band_pct / 100.0))
    w, h = im.size
    if band == "top":
        cut_h = max(1, int(round(h * frac)))
        return im.crop((0, 0, w, cut_h))
    cut_w = max(1, int(round(w * frac)))
    strip = im.crop((0, 0, cut_w, h))
    if rotate_left:
        strip = strip.transpose(Image.Transpose.ROTATE_270)
    return strip


def build_labeled_contact_strip(
    items: list[tuple[str, PILImageModule.Image]],
    out_path: Path,
    target_width: int,
    max_kb: int,
) -> SavedImage:
    Image, ImageDraw, ImageFont, _ = require_pillow()
    resized: list[tuple[str, Any]] = []
    for label, im in items:
        rgb = to_rgb(im)
        if rgb.width != target_width:
            scaled_h = max(1, int(round(rgb.height * (target_width / rgb.width))))
            rgb = rgb.resize((target_width, scaled_h), Image.Resampling.LANCZOS)
        resized.append((label, rgb))

    font = ImageFont.load_default()
    header_h = 26
    gap_h = 6
    total_h = sum(header_h + im.height + gap_h for _, im in resized)
    canvas = Image.new("RGB", (target_width, max(1, total_h)), (24, 24, 24))
    draw = ImageDraw.Draw(canvas)
    y = 0
    for label, im in resized:
        draw.rectangle((0, y, target_width, y + header_h), fill=(20, 28, 38))
        draw.text((8, y + 6), label[:180], fill=(255, 255, 255), font=font)
        y += header_h
        canvas.paste(im, (0, y))
        y += im.height + gap_h
    return save_compact_jpeg(canvas, out_path, max_width=target_width, max_kb=max_kb)


def cmd_sheet_strip(args: argparse.Namespace) -> tuple[int, int]:
    Image, ImageDraw, ImageFont, _ = require_pillow()
    sources: list[str] = list(args.sources)
    out_path = Path(args.out).resolve()
    target_width = args.width

    def fetch_one(item: tuple[int, str]) -> dict[str, Any]:
        idx, src = item
        label = short_label(src, idx)
        try:
            im = load_image_from_source(src, timeout_s=args.timeout)
            band_im = extract_band(
                im, args.band, args.band_pct, rotate_left=not args.no_rotate_left
            )
            if band_im.width != target_width:
                scaled_h = max(1, int(round(band_im.height * (target_width / band_im.width))))
                band_im = band_im.resize((target_width, scaled_h), Image.Resampling.LANCZOS)
            return {
                "index": idx,
                "source": src,
                "label": label,
                "image": band_im,
                "error": None,
            }
        except Exception as exc:
            return {
                "index": idx,
                "source": src,
                "label": label,
                "image": None,
                "error": str(exc),
            }

    workers = min(DEFAULT_MAX_WORKERS, max(1, len(sources)))
    with ThreadPoolExecutor(max_workers=workers) as pool:
        fetched = list(pool.map(fetch_one, enumerate(sources, 1)))

    ok_count = sum(1 for row in fetched if row["image"] is not None)
    if ok_count == 0:
        for row in fetched:
            print(f"Error {row['label']}: {row['error']}", file=sys.stderr)
        return 1, 0

    font = ImageFont.load_default()
    header_h = 26
    error_h = 36
    gap_h = 6
    total_h = sum(
        header_h + (row["image"].height if row["image"] is not None else error_h) + gap_h
        for row in fetched
    )

    canvas = Image.new("RGB", (target_width, max(1, total_h)), (24, 24, 24))
    draw = ImageDraw.Draw(canvas)
    y = 0
    for row in fetched:
        draw.rectangle((0, y, target_width, y + header_h), fill=(20, 28, 38))
        header_text = str(row["label"])
        if row["error"]:
            header_text = f"{header_text}  ERROR: {row['error']}"
        draw.text((8, y + 6), header_text[:180], fill=(255, 255, 255), font=font)
        y += header_h
        band_im = row["image"]
        if band_im is not None:
            canvas.paste(band_im, (0, y))
            y += band_im.height + gap_h
        else:
            draw.rectangle((0, y, target_width, y + error_h), fill=(90, 20, 20))
            draw.text((8, y + 10), str(row["error"])[:180], fill=(255, 220, 220), font=font)
            y += error_h + gap_h

    saved = save_compact_jpeg(canvas, out_path, max_width=target_width, max_kb=args.max_kb)
    errors = [{"source": r["source"], "error": r["error"]} for r in fetched if r["error"]]

    payload = {
        "band": args.band,
        "band_pct": args.band_pct,
        "count": len(sources),
        "ok": ok_count,
        "errors": errors,
        **saved.to_dict(),
    }

    if args.json:
        out_bytes = emit_output(json.dumps(payload, indent=2) + "\n")
    else:
        text = (
            f"{saved.path}  {saved.width}x{saved.height}  {saved.bytes / 1024:.1f} KB  "
            f"({ok_count}/{len(sources)} bands)\n"
        )
        out_bytes = emit_output(text)
        for err in errors:
            print(f"warning: {err['source']}: {err['error']}", file=sys.stderr)
    return 0, out_bytes


def cmd_pdf_pages(args: argparse.Namespace) -> tuple[int, int]:
    Image, _, _, ImageOps = require_pillow()
    pdf_path = Path(args.pdf_path).resolve()
    if not pdf_path.is_file():
        print(f"Error: PDF file not found: {pdf_path}", file=sys.stderr)
        return 1, 0

    pdftoppm_bin = shutil.which("pdftoppm")
    if not pdftoppm_bin:
        print(
            "Error: pdftoppm executable not found on PATH. Install poppler-utils "
            "(for example `apt install poppler-utils` or `brew install poppler`).",
            file=sys.stderr,
        )
        return 1, 0
    timeout_bin = shutil.which("timeout")

    requested_pages = parse_page_spec(args.pages)
    ranges = coalesce_ranges(requested_pages)

    out_dir = Path(args.out_dir).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    # Keep intermediate files inside out_dir instead of /tmp tmpfs RAM.
    stage_dir = out_dir / f".pdf_stage_{os.getpid()}_{time.time_ns()}"
    stage_dir.mkdir(parents=True, exist_ok=True)

    rendered_by_page: dict[int, Path] = {}
    try:
        for r_idx, (start_p, end_p) in enumerate(ranges):
            prefix = stage_dir / f"r{r_idx}"
            base_cmd = [
                pdftoppm_bin,
                "-jpeg",
                "-r",
                str(args.dpi),
                "-f",
                str(start_p),
                "-l",
                str(end_p),
                str(pdf_path),
                str(prefix),
            ]
            cmd = (
                [timeout_bin, str(DEFAULT_PDF_TIMEOUT_S), *base_cmd]
                if timeout_bin
                else base_cmd
            )
            try:
                proc = subprocess.run(
                    cmd, capture_output=True, text=True, timeout=DEFAULT_PDF_TIMEOUT_S + 5
                )
            except subprocess.TimeoutExpired:
                print(
                    f"Error: pdftoppm timed out after {DEFAULT_PDF_TIMEOUT_S}s on pages {start_p}-{end_p}.",
                    file=sys.stderr,
                )
                return 1, 0
            if proc.returncode != 0:
                detail = (proc.stderr or proc.stdout).strip()[:300]
                print(
                    f"Error: pdftoppm failed (exit {proc.returncode}) on pages {start_p}-{end_p}: {detail}",
                    file=sys.stderr,
                )
                return 1, 0

            for img_file in sorted(stage_dir.glob(f"r{r_idx}-*.jpg")):
                m = PDF_PAGE_NUM_RE.search(img_file.name)
                if not m:
                    continue
                page_num = int(m.group(1))
                dest_page = out_dir / f"page-{page_num:03d}.jpg"
                os.replace(img_file, dest_page)
                rendered_by_page[page_num] = dest_page
    finally:
        shutil.rmtree(stage_dir, ignore_errors=True)

    if not rendered_by_page:
        print(
            f"Error: no pages were rendered for --pages '{args.pages}' from {pdf_path}.",
            file=sys.stderr,
        )
        return 1, 0

    ordered_pages = [(p, rendered_by_page[p]) for p in requested_pages if p in rendered_by_page]

    def build_preview(item: tuple[int, Path]) -> dict[str, Any]:
        page_num, page_path = item
        preview_path = out_dir / f"page-{page_num:03d}.preview.jpg"
        page_bytes = page_path.stat().st_size
        with Image.open(page_path) as im:
            orig_w, orig_h = ImageOps.exif_transpose(im).size
            saved_prev = save_compact_jpeg(
                im, preview_path, max_width=args.max_width, max_kb=args.max_kb
            )
        return {
            "page": page_num,
            "path": str(page_path),
            "width": orig_w,
            "height": orig_h,
            "bytes": page_bytes,
            "kb": round(page_bytes / 1024.0, 1),
            "preview": saved_prev.to_dict(),
        }

    workers = min(DEFAULT_MAX_WORKERS, max(1, len(ordered_pages)))
    with ThreadPoolExecutor(max_workers=workers) as pool:
        page_records = list(pool.map(build_preview, ordered_pages))

    strip_info: dict[str, Any] | None = None
    if args.strip:
        strip_items: list[tuple[str, Any]] = []
        for rec in page_records:
            p_num = int(rec["page"])
            prev_path = Path(str(rec["preview"]["path"]))
            with Image.open(prev_path) as im:
                strip_items.append((f"[p.{p_num:03d}] {pdf_path.name}", im.copy()))
        strip_saved = build_labeled_contact_strip(
            strip_items,
            Path(args.strip).resolve(),
            target_width=args.max_width,
            max_kb=args.max_kb,
        )
        strip_info = strip_saved.to_dict()

    missing_pages = [p for p in requested_pages if p not in rendered_by_page]
    payload: dict[str, object] = {
        "pdf": str(pdf_path),
        "dpi": args.dpi,
        "requested_pages": requested_pages,
        "missing_pages": missing_pages,
        "pages": page_records,
    }
    if strip_info is not None:
        payload["strip"] = strip_info

    if args.json:
        out_bytes = emit_output(json.dumps(payload, indent=2) + "\n")
    else:
        lines: list[str] = []
        for rec in page_records:
            prev = rec["preview"]
            lines.append(
                f"p.{int(rec['page']):03d}  {rec['path']} ({rec['kb']:.1f} KB)  "
                f"preview: {prev['path']} ({prev['kb']:.1f} KB)"
            )
        if strip_info is not None:
            lines.append(
                f"strip: {strip_info['path']}  {strip_info['width']}x{strip_info['height']}  "
                f"{strip_info['kb']:.1f} KB"
            )
        out_bytes = emit_output("\n".join(lines) + "\n")
    return 0, out_bytes


def extract_pdf_pages_text(pdf_path: Path, timeout_s: int = 600) -> list[str]:
    """Return one text string per PDF page (index 0 = page 1).

    pdftotext emits a form feed after every page, so splitting on \\x0c keeps
    page numbers exact even when a page has no text layer.
    """
    pdftotext_bin = shutil.which("pdftotext")
    if pdftotext_bin:
        proc = subprocess.run(
            [pdftotext_bin, "-enc", "UTF-8", str(pdf_path), "-"],
            capture_output=True,
            timeout=timeout_s,
        )
        if proc.returncode != 0:
            detail = proc.stderr.decode("utf-8", "replace").strip()
            raise RuntimeError(f"pdftotext failed (exit {proc.returncode}): {detail}")
        pages = proc.stdout.decode("utf-8", "replace").split("\x0c")
        if pages and not pages[-1].strip():
            pages.pop()
        return pages
    try:
        from pypdf import PdfReader  # type: ignore[import-not-found]
    except ImportError as exc:
        raise RuntimeError(
            "pdftotext not found on PATH and pypdf is not installed. Install poppler-utils "
            "(for example `apt install poppler-utils` or `brew install poppler`)."
        ) from exc
    return [page.extract_text() or "" for page in PdfReader(str(pdf_path)).pages]


def pdf_text_cache_paths(pdf_path: Path, cache_root: Path) -> tuple[Path, Path]:
    digest = sha256_file(pdf_path)
    directory = cache_root / "pdf-text"
    return directory / f"{digest}.json", directory / f"{digest}.lock"


def read_cached_pdf_pages(path: Path) -> list[str] | None:
    if not path.is_file():
        return None
    try:
        parsed = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError):
        return None
    if not isinstance(parsed, dict):
        return None
    pages = parsed.get("pages")
    if not isinstance(pages, list) or any(not isinstance(page, str) for page in pages):
        return None
    return pages


def load_pdf_page_texts(pdf_path: Path, *, refresh: bool) -> tuple[list[str], bool]:
    """Return page texts and whether they came from the disk cache.

    Failed extractions raise and leave the cache unchanged. Corrupt JSON is a miss.
    """
    data_path, lock_path = pdf_text_cache_paths(pdf_path, default_cache_root())
    if not refresh:
        cached = read_cached_pdf_pages(data_path)
        if cached is not None:
            return cached, True
    with file_lock(lock_path):
        if not refresh:
            cached = read_cached_pdf_pages(data_path)
            if cached is not None:
                return cached, True
        pages = extract_pdf_pages_text(pdf_path)
        atomic_write_text(
            data_path,
            json.dumps({"pages": pages}, indent=2, ensure_ascii=False) + "\n",
        )
        return pages, False


def format_page_spec(pages: list[int]) -> str:
    if not pages:
        return ""
    return ",".join(str(a) if a == b else f"{a}-{b}" for a, b in coalesce_ranges(pages))


def cmd_pdf_grep(args: argparse.Namespace) -> tuple[int, int]:
    pdf_path = Path(args.pdf_path).resolve()
    if not pdf_path.is_file():
        print(f"Error: PDF file not found: {pdf_path}", file=sys.stderr)
        return 1, 0
    if args.limit < 1 or args.context < 0:
        raise ValueError("--limit must be >= 1 and --context must be >= 0.")
    try:
        regex = re.compile(args.pattern, re.IGNORECASE if args.ignore_case else 0)
    except re.error as exc:
        raise ValueError(f"Invalid --pattern regex {args.pattern!r}: {exc}") from exc

    page_texts, cache_hit = load_pdf_page_texts(pdf_path, refresh=bool(args.refresh))
    matches: list[dict[str, Any]] = []
    hit_pages: list[int] = []
    total = 0
    ctx = args.context
    for page_no, text in enumerate(page_texts, start=1):
        page_hit = False
        offset = 0
        for line_no, line in enumerate(text.split("\n"), start=1):
            for m in regex.finditer(line):
                if m.end() == m.start():
                    continue
                total += 1
                page_hit = True
                if len(matches) < args.limit:
                    start = offset + m.start()
                    end = offset + m.end()
                    snippet = " ".join(text[max(0, start - ctx):end + ctx].split())
                    matches.append({"page": page_no, "line": line_no,
                                    "match": m.group(0), "snippet": snippet})
            offset += len(line) + 1
        if page_hit:
            hit_pages.append(page_no)

    pages_arg = format_page_spec(hit_pages)
    result = {
        "pdf": str(pdf_path),
        "pattern": args.pattern,
        "ignore_case": bool(args.ignore_case),
        "page_count": len(page_texts),
        "match_count": total,
        "returned": len(matches),
        "truncated": total > len(matches),
        "pages": hit_pages,
        "pages_arg": pages_arg,
        "matches": matches,
        "cache_hit": cache_hit,
    }
    if args.json:
        out_bytes = emit_output(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
    else:
        lines = [f"p.{m['page']} L{m['line']}: {m['snippet']}" for m in matches]
        summary = (f"{total} match(es) on {len(hit_pages)} of {len(page_texts)} page(s)"
                   + (f"; showing first {len(matches)} (raise --limit)" if result["truncated"] else ""))
        lines.append(summary)
        if pages_arg:
            lines.append(f"next: kinloom prep-scan pdf-pages {pdf_path} --pages {pages_arg} --out-dir <dir>")
        out_bytes = emit_output("\n".join(lines) + "\n")
    return (0 if total else 1), out_bytes


def cmd_grid(args: argparse.Namespace) -> tuple[int, int]:
    Image, ImageDraw, ImageFont, _ = require_pillow()
    if args.step <= 0:
        raise ValueError(f"--step must be a positive integer, got {args.step}.")
    if args.max_width <= 0:
        raise ValueError(f"--max-width must be a positive integer, got {args.max_width}.")
    if args.max_kb <= 0:
        raise ValueError(f"--max-kb must be a positive integer, got {args.max_kb}.")

    src = Path(args.image).resolve()
    out_path = Path(args.out).resolve()
    if not src.is_file():
        print(f"Error: input file not found: {src}", file=sys.stderr)
        return 1, 0

    with Image.open(src) as raw_im:
        rgb = rotate_clockwise(to_rgb(raw_im), args.rotate)

    orig_w, orig_h = rgb.size
    if orig_w > args.max_width:
        scaled_h = max(1, int(round(orig_h * (args.max_width / orig_w))))
        base = rgb.resize((args.max_width, scaled_h), Image.Resampling.LANCZOS)
    else:
        base = rgb.copy()

    scale_x = base.width / orig_w
    scale_y = base.height / orig_h
    overlay = Image.new("RGBA", base.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)
    font = load_label_font(ImageFont, size=14)

    def draw_pill(x_pos: int, y_pos: int, label: str, accent: tuple[int, int, int, int]) -> None:
        bbox = draw.textbbox((0, 0), label, font=font)
        tw = bbox[2] - bbox[0]
        th = bbox[3] - bbox[1]
        pad_x = 4
        pad_y = 2
        left = max(0, min(base.width - (tw + pad_x * 2), x_pos))
        top = max(0, min(base.height - (th + pad_y * 2), y_pos))
        draw.rectangle(
            (left, top, left + tw + pad_x * 2, top + th + pad_y * 2),
            fill=(15, 18, 24, 195),
            outline=accent,
            width=1,
        )
        draw.text((left + pad_x - bbox[0], top + pad_y - bbox[1]), label, fill=(255, 255, 255, 255), font=font)

    major_step = args.step * 5
    last_x_label = -1000
    for orig_x in range(0, orig_w, args.step):
        px = min(base.width - 1, int(round(orig_x * scale_x)))
        is_major = orig_x % major_step == 0
        line_color = (220, 38, 38, 175) if is_major else (220, 38, 38, 110)
        draw.line([(px, 0), (px, base.height - 1)], fill=line_color, width=2 if is_major else 1)
        if orig_x == 0 or px - last_x_label >= 48:
            draw_pill(px + 2, 2, str(orig_x), (220, 38, 38, 220))
            last_x_label = px

    last_y_label = -1000
    for orig_y in range(0, orig_h, args.step):
        py = min(base.height - 1, int(round(orig_y * scale_y)))
        is_major = orig_y % major_step == 0
        line_color = (37, 99, 235, 175) if is_major else (37, 99, 235, 110)
        draw.line([(0, py), (base.width - 1, py)], fill=line_color, width=2 if is_major else 1)
        if orig_y > 0 and py - last_y_label >= 24:
            draw_pill(2, py + 2, str(orig_y), (37, 99, 235, 220))
            last_y_label = py

    composited = Image.alpha_composite(base.convert("RGBA"), overlay).convert("RGB")
    saved = save_compact_jpeg(composited, out_path, max_width=args.max_width, max_kb=args.max_kb)

    payload = {
        "original_width": orig_w,
        "original_height": orig_h,
        "preview_width": saved.width,
        "preview_height": saved.height,
        "step": args.step,
        "bytes": saved.bytes,
        "out": str(saved.path),
    }
    out_bytes = emit_output(json.dumps(payload, indent=2) + "\n")
    return 0, out_bytes


def cmd_stitch(args: argparse.Namespace) -> tuple[int, int]:
    Image, ImageDraw, _, _ = require_pillow()
    if len(args.box) < 2:
        raise ValueError("stitch requires at least 2 --box regions (for example header + target band).")
    if args.gap < 0:
        raise ValueError(f"--gap must be >= 0, got {args.gap}.")
    if args.quality < 1 or args.quality > 100:
        raise ValueError(f"--quality must be between 1 and 100, got {args.quality}.")

    divider_rgb = parse_rgb_color(args.divider_color)
    src = Path(args.image).resolve()
    out_path = Path(args.out).resolve()
    if not src.is_file():
        print(f"Error: input file not found: {src}", file=sys.stderr)
        return 1, 0

    with Image.open(src) as raw_im:
        img = rotate_clockwise(to_rgb(raw_im), args.rotate)

    redactions: list[list[int]] = []
    if args.redact:
        draw_src = ImageDraw.Draw(img)
        for idx, rbox in enumerate(args.redact, 1):
            clamped = clamp_box(rbox, img.width, img.height, f"--redact #{idx}")
            draw_src.rectangle((clamped.x0, clamped.y0, clamped.x1, clamped.y1), fill=(0, 0, 0))
            redactions.append([clamped.x0, clamped.y0, clamped.x1, clamped.y1])

    cropped_bands: list[tuple[Box, Any]] = []
    for idx, box in enumerate(args.box, 1):
        clamped = clamp_box(box, img.width, img.height, f"--box #{idx}")
        cropped_bands.append((clamped, img.crop((clamped.x0, clamped.y0, clamped.x1, clamped.y1))))

    canvas_w = max(band.width for _, band in cropped_bands)
    canvas_h = sum(band.height for _, band in cropped_bands) + args.gap * (len(cropped_bands) - 1)
    canvas = Image.new("RGB", (canvas_w, max(1, canvas_h)), divider_rgb)
    draw = ImageDraw.Draw(canvas)

    y = 0
    band_reports: list[dict[str, object]] = []
    for cbox, band in cropped_bands:
        if band.width < canvas_w:
            draw.rectangle((0, y, canvas_w - 1, y + band.height - 1), fill=(255, 255, 255))
        x_offset = (canvas_w - band.width) // 2
        canvas.paste(band, (x_offset, y))
        band_reports.append(
            {
                "box": [cbox.x0, cbox.y0, cbox.x1, cbox.y1],
                "width": band.width,
                "height": band.height,
                "x_offset": x_offset,
                "y_offset": y,
            }
        )
        y += band.height + args.gap

    saved = save_archival_image(canvas, out_path, quality=args.quality)
    payload = {
        "width": saved.width,
        "height": saved.height,
        "bytes": saved.bytes,
        "bands": band_reports,
        "redactions": redactions,
        "out": str(saved.path),
    }
    out_bytes = emit_output(json.dumps(payload, indent=2) + "\n")
    return 0, out_bytes


def cmd_info(args: argparse.Namespace) -> tuple[int, int]:
    Image, _, _, ImageOps = require_pillow()
    files: list[dict[str, object]] = []
    errors: list[str] = []
    for raw in args.images:
        src = Path(raw).expanduser().resolve()
        if not src.is_file():
            errors.append(f"input file not found: {src}")
            continue
        try:
            nbytes = src.stat().st_size
            with Image.open(src) as im:
                im.load()
                image_format = im.format or "UNKNOWN"
                mode = im.mode
                oriented = ImageOps.exif_transpose(im)
                try:
                    width, height = oriented.size
                finally:
                    if oriented is not im:
                        oriented.close()
        except Exception as exc:
            errors.append(
                f"cannot read image {src}: {exc}. Use a JPEG, PNG, WEBP, or TIFF file."
            )
            continue
        files.append(
            {
                "path": str(src),
                "width": width,
                "height": height,
                "format": image_format,
                "mode": mode,
                "bytes": nbytes,
                "kb": round(nbytes / 1024.0, 1),
            }
        )
    if errors:
        for message in errors:
            print(f"Error: {message}", file=sys.stderr)
        return 1, 0
    if args.json:
        payload = {"count": len(files), "files": files}
        return 0, emit_output(json.dumps(payload, indent=2) + "\n")
    lines = [
        f"{item['path']}: {item['width']}x{item['height']} {item['format']} ({item['kb']:.1f} KB)"
        for item in files
    ]
    return 0, emit_output("\n".join(lines) + ("\n" if lines else ""))


def cmd_join(args: argparse.Namespace) -> tuple[int, int]:
    if len(args.images) < 2:
        raise ValueError(
            "join requires at least 2 images. Pass two or more paths and --out <file>."
        )
    if args.gap < 0:
        raise ValueError(f"--gap must be >= 0, got {args.gap}.")
    if args.quality < 1 or args.quality > 100:
        raise ValueError(f"--quality must be between 1 and 100, got {args.quality}.")

    background = parse_rgb_color(args.divider_color)
    frames: list[Any] = []
    try:
        for raw in args.images:
            src = Path(raw).expanduser().resolve()
            if not src.is_file():
                print(f"Error: input file not found: {src}", file=sys.stderr)
                return 1, 0
            try:
                frames.append(load_rgb_image(src))
            except ValueError as exc:
                print(f"Error: {exc}", file=sys.stderr)
                return 1, 0
        canvas = join_frames(
            frames,
            direction=args.direction,
            gap=args.gap,
            align=args.align,
            background=background,
        )
        saved = save_archival_image(canvas, Path(args.out).resolve(), quality=args.quality)
        preview_path: str | None = None
        if args.preview_out:
            preview = save_compact_jpeg(
                canvas,
                Path(args.preview_out).resolve(),
                max_width=1400,
                max_kb=280,
            )
            preview_path = str(preview.path)
    finally:
        for frame in frames:
            frame.close()

    payload: dict[str, object] = {
        "width": saved.width,
        "height": saved.height,
        "bytes": saved.bytes,
        "count": len(args.images),
        "direction": args.direction,
        "out": str(saved.path),
    }
    if preview_path is not None:
        payload["preview_out"] = preview_path
    return 0, emit_output(json.dumps(payload, indent=2) + "\n")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="kinloom prep-scan",
        description=(
            "Report image dimensions, join separate page scans, generate compact "
            "inspection previews, redacted archival crops, census sheet-strip "
            "contact sheets, and selective PDF page renders."
        ),
    )
    sub = parser.add_subparsers(dest="command", required=True)

    p_prev = sub.add_parser("preview", help="Generate compact JPEG inspection previews in parallel.")
    p_prev.add_argument("images", nargs="+", help="Input image path(s).")
    p_prev.add_argument(
        "--out-dir", "--out", "-o", "--output-dir", "--output", dest="out_dir", required=True,
        help="Output directory for preview JPEGs (--out/-o are aliases).",
    )
    p_prev.add_argument(
        "--max-width", type=int, default=1400, help="Maximum pixel width (default: 1400)."
    )
    p_prev.add_argument(
        "--max-kb", type=int, default=280, help="Maximum file size in KB (default: 280)."
    )
    p_prev.add_argument("--json", action="store_true", help="Emit JSON output.")
    p_prev.set_defaults(func=cmd_preview)

    p_crop = sub.add_parser(
        "crop",
        help=(
            "Rotate, optionally crop, draw black redaction boxes, and write a verification preview. "
            "--redact-orig uses rotated-image coordinates. --redact uses cropped-image coordinates."
        ),
    )
    p_crop.add_argument("input", help="Source scan path.")
    p_crop.add_argument("output", nargs="?", default=None,
                        help="Final archival output scan path (or pass --out).")
    p_crop.add_argument("--out", "-o", "--output", dest="output_opt", default=None,
                        help="Alias for the positional output path.")
    p_crop.add_argument("--quality", type=int, default=92,
                        help="Archival output JPEG/WEBP quality 1..100 (default: 92).")
    p_crop.add_argument(
        "--box",
        type=parse_box,
        default=None,
        help=(
            "Crop box x0,y0,x1,y1 on the rotated image. "
            "Omit --box to keep the full rotated frame."
        ),
    )
    p_crop.add_argument(
        "--rotate",
        type=int,
        choices=(90, 180, 270),
        default=None,
        help="Optional clockwise rotation applied before cropping.",
    )
    p_crop.add_argument(
        "--redact",
        action="extend",
        nargs="+",
        type=parse_box,
        default=[],
        help="One or more x0,y0,x1,y1 black redaction boxes in cropped-image coordinates.",
    )
    p_crop.add_argument(
        "--redact-orig",
        action="extend",
        nargs="+",
        type=parse_box,
        default=[],
        help=(
            "One or more x0,y0,x1,y1 black boxes in rotated-image coordinates "
            "(the same coordinates as prep-scan grid and prep-scan stitch). "
            "Drawn before the crop. Repeatable."
        ),
    )
    p_crop.add_argument(
        "--preview-out",
        default=None,
        help="Optional explicit path for the < 280 KB verification preview (defaults to cache previews dir).",
    )
    p_crop.add_argument(
        "--max-width", type=int, default=1400, help="Preview maximum pixel width (default: 1400)."
    )
    p_crop.add_argument(
        "--max-kb", type=int, default=280, help="Preview maximum size in KB (default: 280)."
    )
    p_crop.add_argument("--json", action="store_true", help="Emit JSON output.")
    p_crop.set_defaults(func=cmd_crop)

    p_strip = sub.add_parser(
        "sheet-strip",
        help="Download or read census sheet header/street bands in parallel and stitch one labeled contact sheet.",
    )
    p_strip.add_argument("sources", nargs="+", help="Image URLs or local file paths.")
    p_strip.add_argument(
        "--out", required=True, help="Output JPEG path for the stitched contact sheet."
    )
    p_strip.add_argument(
        "--band",
        choices=("top", "left"),
        default="top",
        help="Band edge to slice (default: top).",
    )
    p_strip.add_argument(
        "--band-pct",
        type=float,
        default=18.0,
        help="Percent of image height/width to slice (default: 18).",
    )
    p_strip.add_argument(
        "--max-kb", type=int, default=250, help="Maximum output file size in KB (default: 250)."
    )
    p_strip.add_argument(
        "--width", type=int, default=1400, help="Normalized strip width in pixels (default: 1400)."
    )
    p_strip.add_argument(
        "--timeout",
        type=float,
        default=DEFAULT_TIMEOUT_S,
        help="Per-URL HTTP timeout seconds (default: 12).",
    )
    p_strip.add_argument(
        "--no-rotate-left",
        action="store_true",
        help="Keep --band left vertical instead of rotating 90 deg CW for horizontal reading.",
    )
    p_strip.add_argument("--json", action="store_true", help="Emit JSON output.")
    p_strip.set_defaults(func=cmd_sheet_strip)

    p_pdf = sub.add_parser(
        "pdf-pages",
        help="Render only requested PDF pages via pdftoppm, build < 280 KB previews in parallel, and optionally build a contact strip.",
    )
    p_pdf.add_argument("pdf_path", help="Path to source PDF file.")
    p_pdf.add_argument("--pages", required=True, help="Page range spec, e.g. 1-5,8.")
    p_pdf.add_argument(
        "--out-dir", "--out", "-o", "--output-dir", "--output", dest="out_dir", required=True,
        help="Output directory for rendered pages and previews (--out/-o are aliases).",
    )
    p_pdf.add_argument(
        "--dpi", type=int, default=150, help="Rendering DPI for pdftoppm (default: 150)."
    )
    p_pdf.add_argument(
        "--max-width", type=int, default=1400, help="Preview maximum pixel width (default: 1400)."
    )
    p_pdf.add_argument(
        "--max-kb", type=int, default=280, help="Maximum preview/strip size in KB (default: 280)."
    )
    p_pdf.add_argument(
        "--strip", default=None, help="Optional output JPEG path for a labeled contact strip."
    )
    p_pdf.add_argument("--json", action="store_true", help="Emit JSON output.")
    p_pdf.set_defaults(func=cmd_pdf_pages)

    p_pgrep = sub.add_parser(
        "pdf-grep",
        help="Search PDF text page by page (pdftotext, pypdf fallback) and print 1-based page "
             "numbers + snippets to feed `pdf-pages --pages`. Exit 1 when nothing matches.",
    )
    p_pgrep.add_argument("pdf_path", help="Path to source PDF file.")
    p_pgrep.add_argument("--pattern", "-e", required=True,
                         help="Python regex, matched within each text line.")
    p_pgrep.add_argument("-i", "--ignore-case", action="store_true", help="Case-insensitive match.")
    p_pgrep.add_argument("--context", type=int, default=200,
                         help="Characters of page text to show on each side of a match (default: 200).")
    p_pgrep.add_argument("--limit", type=int, default=25,
                         help="Maximum matches to print (default: 25); all matches still count.")
    p_pgrep.add_argument("--json", action="store_true", help="Emit JSON output.")
    p_pgrep.add_argument(
        "--refresh",
        action="store_true",
        help="Ignore cached page text and extract the PDF again.",
    )
    p_pgrep.set_defaults(func=cmd_pdf_grep)

    p_grid = sub.add_parser(
        "grid",
        help="Draw an original-pixel coordinate grid overlay onto a compact JPEG preview.",
    )
    p_grid.add_argument("image", help="Source scan image path.")
    p_grid.add_argument("out", nargs="?", default=None,
                        help="Output JPEG path for the coordinate-grid preview (or pass --out).")
    p_grid.add_argument("--out", "-o", "--output", dest="out_opt", default=None,
                        help="Alias for the positional output path.")
    p_grid.add_argument(
        "--step",
        type=int,
        default=200,
        help="Grid line interval in original image pixels (default: 200).",
    )
    p_grid.add_argument(
        "--max-width",
        type=int,
        default=1600,
        help="Maximum preview width in pixels (default: 1600).",
    )
    p_grid.add_argument(
        "--max-kb",
        type=int,
        default=280,
        help="Maximum preview file size in KB (default: 280).",
    )
    p_grid.add_argument(
        "--rotate",
        type=int,
        choices=(90, 180, 270),
        default=None,
        help="Optional clockwise rotation applied before measuring coordinates.",
    )
    p_grid.add_argument("--json", action="store_true", help="Emit JSON output (always enabled).")
    p_grid.set_defaults(func=cmd_grid)

    p_stitch = sub.add_parser(
        "stitch",
        help="Crop 2+ boxes from one scan, apply optional redactions, and stack bands vertically.",
    )
    p_stitch.add_argument("image", help="Source scan image path.")
    p_stitch.add_argument("out", nargs="?", default=None,
                          help="Output stitched JPEG path (or pass --out).")
    p_stitch.add_argument("--out", "-o", "--output", dest="out_opt", default=None,
                          help="Alias for the positional output path.")
    p_stitch.add_argument(
        "--box",
        action="extend",
        nargs="+",
        type=parse_box,
        required=True,
        help="Crop box x0,y0,x1,y1 in original image coordinates (repeatable; at least 2 required).",
    )
    p_stitch.add_argument(
        "--redact",
        action="extend",
        nargs="+",
        type=parse_box,
        default=[],
        help="Optional x0,y0,x1,y1 black redaction boxes in original image coordinates applied before cropping.",
    )
    p_stitch.add_argument(
        "--rotate",
        type=int,
        choices=(90, 180, 270),
        default=None,
        help="Optional clockwise rotation applied before redacting and cropping.",
    )
    p_stitch.add_argument(
        "--gap",
        type=int,
        default=6,
        help="Divider gap height in pixels between stacked bands (default: 6).",
    )
    p_stitch.add_argument(
        "--divider-color",
        default="#222222",
        help='Divider fill color as hex or RGB name (default: "#222222").',
    )
    p_stitch.add_argument(
        "--quality",
        type=int,
        default=90,
        help="Output JPEG quality 1..100 (default: 90).",
    )
    p_stitch.add_argument("--json", action="store_true", help="Emit JSON output (always enabled).")
    p_stitch.set_defaults(func=cmd_stitch)

    p_info = sub.add_parser(
        "info",
        help="Print pixel size, format, mode, and file size for one or more local images.",
    )
    p_info.add_argument("images", nargs="+", help="Local image path(s).")
    p_info.add_argument("--json", action="store_true", help="Emit JSON output.")
    p_info.set_defaults(func=cmd_info)

    p_join = sub.add_parser(
        "join",
        help="Join 2 or more images into one archival JPEG or PNG, in input order.",
    )
    p_join.add_argument("images", nargs="+", help="Local image paths, in join order (at least 2).")
    p_join.add_argument(
        "--out", "-o", "--output", dest="out", required=True,
        help="Archival JPEG or PNG output path.",
    )
    p_join.add_argument(
        "--direction",
        type=parse_join_direction,
        default="vertical",
        help="Stack direction: vertical or horizontal (aliases v, h). Default: vertical.",
    )
    p_join.add_argument(
        "--gap",
        type=int,
        default=8,
        help="Pixels of divider color between images (default: 8).",
    )
    p_join.add_argument(
        "--divider-color",
        default="#222222",
        help='Gap and margin fill color as hex or a named RGB color (default: "#222222").',
    )
    p_join.add_argument(
        "--align",
        type=parse_join_align,
        default="center",
        help="Place a shorter image at start, center, or end of the cross axis (default: center).",
    )
    p_join.add_argument(
        "--quality",
        type=int,
        default=92,
        help="Archival JPEG/WEBP quality 1..100 (default: 92). Ignored for PNG.",
    )
    p_join.add_argument(
        "--preview-out",
        default=None,
        help="Optional compact JPEG preview path (max width 1400, max size 280 KB).",
    )
    p_join.add_argument("--json", action="store_true", help="Emit JSON output (always enabled).")
    p_join.set_defaults(func=cmd_join)

    return parser


_BOX_FRAGMENT = re.compile(r"^-?[\d.]+(?:\s*,\s*-?[\d.]+)*\s*,$")


def normalize_argv(argv: list[str]) -> list[str]:
    """Rejoin box values the shell split on spaces: `--box 10, 20, 30, 40`."""
    out: list[str] = []
    for token in argv:
        if out and _BOX_FRAGMENT.match(out[-1]) and re.match(r"^-?[\d.]", token):
            out[-1] = out[-1] + token
        else:
            out.append(token)
    return out


# Subcommand -> (positional dest, --out alias dest).
OUTPUT_ALIASES = {"crop": ("output", "output_opt"), "grid": ("out", "out_opt"),
                  "stitch": ("out", "out_opt")}


def resolve_output_alias(parser: argparse.ArgumentParser, args: argparse.Namespace) -> None:
    dests = OUTPUT_ALIASES.get(getattr(args, "command", ""))
    if not dests:
        return
    positional, alias = dests
    pos_val, alias_val = getattr(args, positional), getattr(args, alias)
    if pos_val and alias_val and Path(pos_val) != Path(alias_val):
        parser.error(f"{args.command}: output given twice ({pos_val!r} and --out {alias_val!r}); "
                     "pass it once.")
    value = pos_val or alias_val
    if not value:
        parser.error(f"{args.command}: missing output path; pass it positionally "
                     f"(`prep-scan {args.command} <in> <out.jpg>`) or with --out <out.jpg>.")
    setattr(args, positional, value)


def main(argv: list[str] | None = None) -> int:
    t0 = time.perf_counter()
    parser = build_parser()
    args = parser.parse_args(normalize_argv(list(sys.argv[1:] if argv is None else argv)))
    resolve_output_alias(parser, args)
    rc = 1
    bytes_out = 0
    try:
        rc, bytes_out = args.func(args)
        return rc
    except ValueError as exc:
        print(f"Error: {exc}", file=sys.stderr)
        rc = 2
        return rc
    except RuntimeError as exc:
        print(f"Error: {exc}", file=sys.stderr)
        rc = 1
        return rc
    finally:
        append_telemetry(
            getattr(args, "command", ""), (time.perf_counter() - t0) * 1000.0, rc, bytes_out
        )


if __name__ == "__main__":
    raise SystemExit(main())
