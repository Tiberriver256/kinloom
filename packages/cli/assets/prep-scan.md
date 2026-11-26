---
name: prep-scan
description: Prepare archival scans for inspection and publication: generate compact JPEG previews in parallel, rotate/crop/redact scans with automatic verification previews, stitch census sheet header strips, and render selective PDF pages via pdftoppm.
---

# Scan Preparation (`kinloom prep-scan`)

Generate lightweight inspection previews, redacted archival crops, census header contact strips, and selective PDF page renders. The bundled Python script uses a PEP 723 `uv run --script` header (`pillow`, `httpx`), and `pdf-pages` uses `pdftoppm` from Poppler.

## Subcommands

### 1. Compact inspection previews (`preview`)

Resize and compress one or more large archival scans in parallel into compact JPEGs (default max width `1400px`, max size `280 KB`) for fast visual review:

```bash
kinloom prep-scan preview ./raw/census-1880.tif ./raw/deed-1872.jpg --out-dir ./previews
kinloom prep-scan preview ./raw/*.jpg --out-dir ./previews --max-width 1600 --max-kb 250 --json
```

### 2. Rotate, crop, and redact (`crop`)

Apply optional clockwise rotation (`90`, `180`, `270`), crop to `x0,y0,x1,y1`, draw solid black redaction boxes in cropped coordinates, write the archival output image, and automatically generate a compact verification preview:

```bash
kinloom prep-scan crop ./raw/certificate.jpg ./media/certificate.jpg \
  --rotate 90 \
  --box 120,80,2400,3100 \
  --redact 40,2100,900,2250 \
  --preview-out ./previews/certificate.preview.jpg
```

### 3. Census header or street contact strip (`sheet-strip`)

Slice the top or left band from local scans or remote image URLs in parallel and stitch them into a single labeled contact sheet for fast enumeration-district or street scanning:

```bash
kinloom prep-scan sheet-strip ./sheets/ed-12-*.jpg --out ./strips/ed-12-headers.jpg --band top --band-pct 18
kinloom prep-scan sheet-strip ./sheets/ed-12-*.jpg --out ./strips/ed-12-streets.jpg --band left --band-pct 12 --max-kb 250
```

### 4. Selective PDF page rendering (`pdf-pages`)

Render only the requested PDF page numbers via `pdftoppm`, build compact previews in parallel, and optionally emit a labeled contact strip:

```bash
kinloom prep-scan pdf-pages ./archive/county-history.pdf --pages 1-4,18,42-45 --out-dir ./rendered --dpi 150
kinloom prep-scan pdf-pages ./archive/packet.pdf --pages 1-6 --out-dir ./rendered --strip ./rendered/contact.jpg --json
```

## Environment variables

- `KINLOOM_OCR_CACHE_DIR` (optional): overrides the default preview cache root (`$XDG_CACHE_HOME/kinloom-ocr` or `~/.cache/kinloom-ocr`).
- `XDG_CACHE_HOME` (optional): standard cache base directory used when `KINLOOM_OCR_CACHE_DIR` is unset.

## Requirements

- `uv` (or Python 3.11+ with `pillow`, plus `httpx` for URL inputs in `sheet-strip`).
- `pdftoppm` (`poppler-utils` on Linux or `poppler` on macOS) for `pdf-pages`.
