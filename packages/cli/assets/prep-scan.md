---
name: prep-scan
description: Prepare archival scans for inspection and publication: generate compact JPEG previews in parallel, overlay original-pixel coordinate grids, rotate/crop/redact scans, stack multi-band header+household crops, stitch census sheet header strips, and render selective PDF pages via pdftoppm.
---

# Scan Preparation (`kinloom prep-scan`)

Generate lightweight inspection previews, original-pixel coordinate grids, redacted archival crops, vertically stitched multi-band crops, census header contact strips, and selective PDF page renders. The bundled Python script uses a PEP 723 `uv run --script` header (`pillow`, `httpx`), and `pdf-pages` uses `pdftoppm` from Poppler.

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

### 5. Coordinate-grid inspection preview (`grid`)

Draw semi-transparent grid lines every `--step` pixels in original image pixel coordinates with crisp coordinate labels along the top and left edges, resize under `--max-width` / `--max-kb`, and print JSON (`original_width`, `original_height`, `preview_width`, `preview_height`, `step`, `out`) so exact `--box x0,y0,x1,y1` values can be read from one compact preview:

```bash
kinloom prep-scan grid ./raw/census-1930.jpg ./previews/census-1930-grid.jpg --step 200 --max-width 1600 --max-kb 280
```

### 6. Multi-band vertical stitch (`stitch`)

Crop two or more boxes from one scan (such as a census sheet column header band plus the target household band, skipping unrelated neighbor rows in between), apply optional black redactions in original image pixel coordinates before cropping, center/pad narrower bands, stack them vertically separated by `--gap` pixels of `--divider-color`, and print JSON (`width`, `height`, `bytes`, `bands`, `out`):

```bash
kinloom prep-scan stitch ./raw/census-1930.jpg ./scans/census-1930-household.jpg \
  --box 80,140,3200,520 \
  --box 80,1420,3200,1760 \
  --redact 80,1710,3200,1760 \
  --gap 6 \
  --divider-color "#222222" \
  --quality 90
```

### Output flags (forgiving)

- `grid`, `stitch`, and `crop` take the output path positionally (`<in> <out.jpg>`) or as `--out <out.jpg>` (aliases `-o`, `--output`). Giving both with different paths exits 2.
- `preview` and `pdf-pages` take `--out-dir <dir>`; `--out`, `-o`, `--output-dir`, and `--output` are aliases.
- `--box` and `--redact` accept `x0,y0,x1,y1`, `"x0, y0, x1, y1"`, `"x0 y0 x1 y1"`, and shell-split `--box 10, 20, 30, 40`.
- `crop` accepts `--quality 1..100` for the archival output (default `92`).

## Environment variables

- `KINLOOM_OCR_CACHE_DIR` (optional): overrides the default preview cache root (`$XDG_CACHE_HOME/kinloom-ocr` or `~/.cache/kinloom-ocr`).
- `XDG_CACHE_HOME` (optional): standard cache base directory used when `KINLOOM_OCR_CACHE_DIR` is unset.

## Requirements

- `uv` (or Python 3.11+ with `pillow`, plus `httpx` for URL inputs in `sheet-strip`).
- `pdftoppm` (`poppler-utils` on Linux or `poppler` on macOS) for `pdf-pages`.
