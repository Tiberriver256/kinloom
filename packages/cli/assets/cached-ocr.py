#!/usr/bin/env -S python3 -S
"""Content-addressed cached OCR CLI for printed scans (tesseract) and handwritten cursive (vision CLI)."""

from __future__ import annotations

import hashlib
import json
import os
import sys
import time

DEFAULT_CURSIVE_EFFORT = "low"
DEFAULT_VISION_CLI = "agy"
DEFAULT_PRINTED_TIMEOUT_S = 30
DEFAULT_CURSIVE_TIMEOUT_S = 90
CURSIVE_MAX_INPUT_BYTES = 350 * 1024
CURSIVE_TARGET_KB = 285
CURSIVE_TARGET_MAX_WIDTH = 2400
VALID_MODES = ("printed", "cursive")
VALID_EFFORTS = ("low", "medium", "high", "xhigh")

DEFAULT_CURSIVE_PROMPT = (
    "Call read_file ONCE on {image_path}. Do not run shell commands, do not write files, "
    "and do not invoke subagents. Transcribe verbatim all handwritten cursive text visible on "
    "this archival document: first the sheet/page header (state, county, township/city, date, "
    "ED/page/sheet numbers), then each legible household/person row with line number, "
    "dwelling/family numbers, full name, relation, sex, color/race, age, occupation, property "
    "values, and birthplace. Mark genuinely illegible words or characters as [?]; never invent "
    "or extrapolate obscured rows."
)


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
        "Usage: kinloom ocr <image> [options]\n\n"
        "Options:\n"
        "  --mode <printed|cursive>          OCR mode (default: printed)\n"
        "  --psm <int>                       Tesseract PSM for --mode printed (default: 6)\n"
        f"  --effort <low|medium|high|xhigh>  Reasoning effort for --mode cursive (default: {DEFAULT_CURSIVE_EFFORT})\n"
        f"  --cache-dir <dir>                 Cache directory (default: {cache_default})\n"
        f"  --timeout <seconds>               Subprocess timeout (default: {DEFAULT_PRINTED_TIMEOUT_S} printed, {DEFAULT_CURSIVE_TIMEOUT_S} cursive)\n"
        "  --prompt <text>                   Custom prompt for --mode cursive (supports {image_path})\n"
        "  --force                           Bypass cache and recompute OCR\n"
        "  --json                            Emit structured JSON output\n"
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
    opts: dict[str, object] = {
        "image": None,
        "mode": "printed",
        "psm": 6,
        "effort": DEFAULT_CURSIVE_EFFORT,
        "cache_dir": default_cache_dir(),
        "timeout": None,
        "prompt": None,
        "force": False,
        "json": False,
        "boxes": False,
        "tsv": False,
        "find": None,
    }
    i = 0
    n = len(argv)
    while i < n:
        arg = argv[i]
        if arg in ("-h", "--help"):
            print_usage()
            raise SystemExit(0)
        if arg == "--force":
            opts["force"] = True
            i += 1
            continue
        if arg in ("--json", "--boxes", "--tsv"):
            opts[arg[2:]] = True
            i += 1
            continue
        if arg.startswith("--"):
            if "=" in arg:
                key, val = arg.split("=", 1)
            else:
                key = arg
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
                opts["psm"] = int(val)
            elif key == "--effort":
                if val not in VALID_EFFORTS:
                    raise ValueError(
                        f"Invalid --effort '{val}': choose from {', '.join(VALID_EFFORTS)}."
                    )
                opts["effort"] = val
            elif key == "--cache-dir":
                opts["cache_dir"] = val
            elif key == "--timeout":
                parsed_timeout = int(val)
                if parsed_timeout <= 0:
                    raise ValueError(
                        f"Invalid --timeout '{val}': must be a positive integer in seconds."
                    )
                opts["timeout"] = parsed_timeout
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
        if opts["image"] is None:
            opts["image"] = arg
            i += 1
            continue
        raise ValueError(f"Unexpected positional argument: {arg}")

    if not opts["image"]:
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


def atomic_write_json(dest: str, payload: dict[str, object]) -> None:
    parent = os.path.dirname(dest)
    os.makedirs(parent, exist_ok=True)
    tmp = os.path.join(parent, f".{os.path.basename(dest)}.{os.getpid()}.{time.time_ns()}.tmp")
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


def run_printed_ocr(
    img_path: str, psm: int, timeout_s: int, tsv: bool = False
) -> tuple[str, dict[str, object]]:
    import shutil
    import subprocess

    tesseract_bin = shutil.which("tesseract")
    if not tesseract_bin:
        raise RuntimeError(
            "tesseract executable not found on PATH. Install tesseract-ocr "
            "(for example `apt install tesseract-ocr` or `brew install tesseract`)."
        )
    # Pin OpenMP to a single thread so parallel OCR calls cannot thrash CPU cores.
    tesseract_env = {**os.environ, "OMP_THREAD_LIMIT": "1"}
    timeout_bin = shutil.which("timeout")
    tess_cmd = [tesseract_bin, img_path, "stdout", "--psm", str(psm), *(["tsv"] if tsv else [])]
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
        raise RuntimeError(f"tesseract exited {proc.returncode}: {detail[:300]}")
    out = proc.stdout if tsv else proc.stdout.strip()
    return out, {"psm": psm, "omp_thread_limit": 1, "timeout_s": timeout_s}


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


def atomic_write_text(dest: str, text: str) -> None:
    parent = os.path.dirname(dest)
    os.makedirs(parent, exist_ok=True)
    tmp = os.path.join(parent, f".{os.path.basename(dest)}.{os.getpid()}.{time.time_ns()}.tmp")
    try:
        with open(tmp, "w", encoding="utf-8") as fh:
            fh.write(text)
        os.replace(tmp, dest)
    except Exception:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise


def run_layout(opts: dict[str, object], img_path: str, sha256_hex: str, cache_dir: str) -> str:
    """Return rendered --tsv or --boxes/--find output, using separate layout cache files."""
    import re

    psm = int(opts["psm"])
    base = os.path.join(cache_dir, f"{sha256_hex}_printed_psm{psm}")
    tsv_path, boxes_path = f"{base}.tsv", f"{base}.boxes.json"
    timeout_val = opts["timeout"]
    timeout_s = int(timeout_val) if timeout_val is not None else DEFAULT_PRINTED_TIMEOUT_S
    force = bool(opts["force"])

    def load_tsv() -> tuple[str, bool]:
        if not force and os.path.isfile(tsv_path):
            with open(tsv_path, "r", encoding="utf-8") as fh:
                return fh.read(), True
        tsv, _ = run_printed_ocr(img_path, psm=psm, timeout_s=timeout_s, tsv=True)
        atomic_write_text(tsv_path, tsv)
        return tsv, False

    if opts["tsv"]:
        tsv, cached = load_tsv()
        opts["_cache_hit"] = cached
        return tsv if tsv.endswith("\n") else tsv + "\n"

    boxes: dict[str, object] | None = None
    cached = False
    if not force and os.path.isfile(boxes_path):
        try:
            with open(boxes_path, "r", encoding="utf-8") as fh:
                boxes = json.load(fh)
            cached = True
        except (OSError, json.JSONDecodeError):
            boxes = None
    if boxes is None:
        tsv, cached = load_tsv()
        boxes = {"sha256": sha256_hex, "psm": psm, **parse_tesseract_tsv(tsv)}
        atomic_write_json(boxes_path, boxes)
    opts["_cache_hit"] = cached
    out: dict[str, object] = {**boxes, "cached": cached, "cache_path": boxes_path}
    pattern = opts["find"]
    if isinstance(pattern, str):
        rx = re.compile(pattern, re.IGNORECASE)
        lines = boxes.get("lines") or []
        assert isinstance(lines, list)
        out["find"] = pattern
        out["lines"] = [ln for ln in lines if rx.search(str(ln.get("text", "")))]
    return json.dumps(out, indent=2, ensure_ascii=False) + "\n"


def prepare_cursive_image(img_path: str, raw_len: int, work_dir: str) -> tuple[str, str | None, int]:
    if raw_len <= CURSIVE_MAX_INPUT_BYTES:
        return img_path, None, raw_len

    import shutil
    import subprocess

    prep_script = os.path.join(os.path.dirname(os.path.realpath(__file__)), "prep-scan.py")
    if not os.path.isfile(prep_script):
        raise RuntimeError(f"Companion script not found: {prep_script}")

    uv_bin = shutil.which("uv")
    prep_cmd = (
        [uv_bin, "run", "--script", prep_script]
        if uv_bin
        else [sys.executable, prep_script]
    )

    os.makedirs(work_dir, exist_ok=True)
    job_dir = os.path.join(work_dir, f"job_{os.getpid()}_{time.time_ns()}")
    os.makedirs(job_dir, exist_ok=True)
    child_env = {
        **os.environ,
        "KINLOOM_TELEMETRY_PARENT": "1",
        "KINLOOM_TELEMETRY_ACTIVE": "1",
    }
    try:
        proc = subprocess.run(
            [
                *prep_cmd,
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
            capture_output=True,
            text=True,
            timeout=60,
            env=child_env,
        )
        if proc.returncode != 0:
            raise RuntimeError(
                f"prep-scan.py failed ({proc.returncode}): {(proc.stderr or proc.stdout).strip()[:300]}"
            )
        info = json.loads(proc.stdout)[0]
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

    img_path = os.path.abspath(str(opts["image"]))
    mode = str(opts["mode"])
    if not os.path.isfile(img_path):
        sys.stderr.write(f"Error: image file not found: {img_path}\n")
        append_telemetry(
            mode=mode,
            duration_ms=(time.perf_counter() - t_start) * 1000.0,
            cache_hit=None,
            exit_code=1,
            bytes_out=0,
        )
        return 1

    cache_dir = os.path.abspath(str(opts["cache_dir"]))
    with open(img_path, "rb") as fh:
        raw_bytes = fh.read()
    sha256_hex = hashlib.sha256(raw_bytes).hexdigest()

    psm = int(opts["psm"])
    effort = str(opts["effort"])
    custom_prompt = opts["prompt"] if isinstance(opts["prompt"], str) else None
    slug = mode_slug(mode, psm, effort, custom_prompt)
    cache_file = os.path.join(cache_dir, f"{sha256_hex}_{slug}.json")

    if opts["boxes"] or opts["tsv"]:
        try:
            rendered = run_layout(opts, img_path, sha256_hex, cache_dir)
        except Exception as exc:
            sys.stderr.write(f"Error: {exc}\n")
            append_telemetry(
                mode="tsv" if opts["tsv"] else "boxes",
                duration_ms=(time.perf_counter() - t_start) * 1000.0,
                cache_hit=False,
                exit_code=1,
                bytes_out=0,
            )
            return 1
        sys.stdout.write(rendered)
        append_telemetry(
            mode="tsv" if opts["tsv"] else "boxes",
            duration_ms=(time.perf_counter() - t_start) * 1000.0,
            cache_hit=bool(opts.get("_cache_hit")),
            exit_code=0,
            bytes_out=len(rendered.encode("utf-8")),
        )
        return 0

    if not opts["force"] and os.path.isfile(cache_file):
        try:
            with open(cache_file, "r", encoding="utf-8") as fh:
                record = json.load(fh)
        except (OSError, json.JSONDecodeError):
            record = None
        if isinstance(record, dict) and isinstance(record.get("text"), str):
            lookup_ms = round((time.perf_counter() - t_start) * 1000.0, 2)
            if opts["json"]:
                out = {
                    **record,
                    "cached": True,
                    "cache_path": cache_file,
                    "lookup_ms": lookup_ms,
                }
                rendered = json.dumps(out, indent=2, ensure_ascii=False) + "\n"
            else:
                rendered = record["text"] + "\n"
            sys.stdout.write(rendered)
            append_telemetry(
                mode=mode,
                duration_ms=(time.perf_counter() - t_start) * 1000.0,
                cache_hit=True,
                exit_code=0,
                bytes_out=len(rendered.encode("utf-8")),
            )
            return 0

    from datetime import datetime, timezone

    timeout_val = opts["timeout"]
    timeout_s = (
        int(timeout_val)
        if timeout_val is not None
        else (DEFAULT_PRINTED_TIMEOUT_S if mode == "printed" else DEFAULT_CURSIVE_TIMEOUT_S)
    )
    t_ocr = time.perf_counter()
    try:
        if mode == "printed":
            text, meta = run_printed_ocr(img_path, psm=psm, timeout_s=timeout_s)
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

    if opts["json"]:
        out = {
            **record,
            "cached": False,
            "cache_path": cache_file,
            "lookup_ms": round((time.perf_counter() - t_start) * 1000.0, 2),
        }
        rendered = json.dumps(out, indent=2, ensure_ascii=False) + "\n"
    else:
        rendered = text + "\n"
    sys.stdout.write(rendered)
    append_telemetry(
        mode=mode,
        duration_ms=(time.perf_counter() - t_start) * 1000.0,
        cache_hit=False,
        exit_code=0,
        bytes_out=len(rendered.encode("utf-8")),
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
