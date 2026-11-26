#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = [
#   "httpx>=0.27",
#   "pillow>=10.0",
# ]
# ///
"""Scan preparation CLI: compact previews, redacted crops, census strips, and selective PDF page renders."""

from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor
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
from typing import TYPE_CHECKING, Any
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
    parts = [p.strip() for p in raw.split(",")]
    if len(parts) != 4:
        raise argparse.ArgumentTypeError(f"Invalid box '{raw}': expected x0,y0,x1,y1.")
    try:
        x0, y0, x1, y1 = (int(p) for p in parts)
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


def clamp_box(box: Box, width: int, height: int, label: str) -> Box:
    if box.x0 >= width or box.y0 >= height:
        raise ValueError(
            f"{label} ({box.x0},{box.y0},{box.x1},{box.y1}) starts outside {width}x{height} image."
        )
    x1 = min(box.x1, width)
    y1 = min(box.y1, height)
    if x1 <= box.x0 or y1 <= box.y0:
        raise ValueError(f"{label} collapses to empty area inside {width}x{height} image.")
    return Box(box.x0, box.y0, x1, y1)


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


def save_archival_image(im: PILImageModule.Image, out_path: Path) -> SavedImage:
    rgb = to_rgb(im)
    ext = out_path.suffix.lower()
    buf = io.BytesIO()
    if ext == ".png":
        rgb.save(buf, format="PNG", optimize=True)
    elif ext == ".webp":
        rgb.save(buf, format="WEBP", quality=92)
    else:
        rgb.save(buf, format="JPEG", quality=92, optimize=True)
    data = buf.getvalue()
    atomic_write_bytes(out_path, data)
    return SavedImage(path=out_path, width=rgb.size[0], height=rgb.size[1], bytes=len(data))


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
    Image, ImageDraw, _, _ = require_pillow()
    src = Path(args.input).resolve()
    out_path = Path(args.output).resolve()
    if not src.is_file():
        print(f"Error: input file not found: {src}", file=sys.stderr)
        return 1, 0

    with Image.open(src) as raw_im:
        img = rotate_clockwise(to_rgb(raw_im), args.rotate)

    crop_box = clamp_box(args.box, img.width, img.height, "crop --box")
    cropped = img.crop((crop_box.x0, crop_box.y0, crop_box.x1, crop_box.y1))

    redactions: list[list[int]] = []
    if args.redact:
        draw = ImageDraw.Draw(cropped)
        for idx, rbox in enumerate(args.redact, 1):
            clamped = clamp_box(rbox, cropped.width, cropped.height, f"--redact #{idx}")
            draw.rectangle((clamped.x0, clamped.y0, clamped.x1, clamped.y1), fill=(0, 0, 0))
            redactions.append([clamped.x0, clamped.y0, clamped.x1, clamped.y1])

    saved = save_archival_image(cropped, out_path)

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


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="kinloom prep-scan",
        description=(
            "Generate compact inspection previews, redacted archival crops, "
            "census sheet-strip contact sheets, and selective PDF page renders."
        ),
    )
    sub = parser.add_subparsers(dest="command", required=True)

    p_prev = sub.add_parser("preview", help="Generate compact JPEG inspection previews in parallel.")
    p_prev.add_argument("images", nargs="+", help="Input image path(s).")
    p_prev.add_argument("--out-dir", required=True, help="Output directory for preview JPEGs.")
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
        help="Rotate, crop, apply solid black redaction boxes (in cropped coordinates), and auto-write a verification preview.",
    )
    p_crop.add_argument("input", help="Source scan path.")
    p_crop.add_argument("output", help="Final archival output scan path.")
    p_crop.add_argument(
        "--box", required=True, type=parse_box, help="Crop box x0,y0,x1,y1 after optional --rotate."
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
        "--out-dir", required=True, help="Output directory for rendered pages and previews."
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

    return parser


def main(argv: list[str] | None = None) -> int:
    t0 = time.perf_counter()
    parser = build_parser()
    args = parser.parse_args(argv)
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
