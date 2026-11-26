---
name: ocr
description: Run content-addressed cached OCR on archival scans: fast printed-text OCR via tesseract or handwritten cursive transcription via a configured vision CLI, keyed by image SHA-256 and mode so repeated runs return instantly from disk.
---

# Cached OCR (`kinloom ocr`)

Content-addressed OCR for genealogical scans. Each image is hashed by SHA-256 and cached on disk by hash and mode so repeated reads return immediately without re-running OCR or paying vision API cost twice.

## Printed text (`--mode printed`, default)

Uses local `tesseract` (default `--psm 6`, single uniform block of text). Every `tesseract` call forces `OMP_THREAD_LIMIT=1` and a hard per-image timeout (`--timeout`, default `30` seconds for printed text, `90` seconds for cursive vision OCR) so parallel runs fail fast instead of thrashing CPU cores:

```bash
kinloom ocr ./scans/obituary-1912.jpg
kinloom ocr ./scans/city-directory-p44.jpg --psm 4 --json
kinloom ocr ./scans/obituary-1912.jpg --force
```

## Handwritten cursive (`--mode cursive`)

Automatically downsizes scans larger than 350 KB using the bundled `prep-scan` preview pipeline, then invokes the configured vision CLI (`KINLOOM_OCR_CLI`, default `agy`) to transcribe headers and rows verbatim while marking illegible text as `[?]`:

```bash
kinloom ocr ./scans/census-1870-sheet4.jpg --mode cursive
kinloom ocr ./scans/deed-1848.jpg --mode cursive --effort medium --json
kinloom ocr ./scans/letter-1864.jpg --mode cursive --prompt "Transcribe this letter verbatim from {image_path}."
```

## Cache layout

Cached JSON records are written atomically to `<cache-dir>/<sha256>_<mode-slug>.json`, where `<cache-dir>` defaults to:

1. `--cache-dir <dir>`
2. `KINLOOM_OCR_CACHE_DIR`
3. `$XDG_CACHE_HOME/kinloom-ocr`
4. `~/.cache/kinloom-ocr`

Pass `--force` to recompute and overwrite an existing cache entry, or `--json` to inspect cache status, SHA-256 digest, engine metadata, and timing.

## Environment variables

- `KINLOOM_OCR_CACHE_DIR` (optional): overrides the default cache directory.
- `KINLOOM_OCR_CLI` (optional): vision CLI binary invoked in `--mode cursive` (default: `agy`).
- `KINLOOM_OCR_MODEL` (optional): overrides the model name passed to the vision CLI.
- `XDG_CACHE_HOME` (optional): standard cache base directory used when `KINLOOM_OCR_CACHE_DIR` is unset.

## Requirements

- Python 3.11+ standard library only for the wrapper itself.
- `tesseract` (`tesseract-ocr`) on `PATH` for `--mode printed`.
- Configured vision CLI (`KINLOOM_OCR_CLI`, default `agy`) on `PATH` for `--mode cursive` (plus `uv` or Pillow when oversized cursive scans need downsizing).
