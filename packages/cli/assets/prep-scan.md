---
name: prep-scan
description: Prepare archival scans for inspection and publication: report pixel size and file size, join separate page scans, generate compact JPEG previews in parallel, overlay original-pixel coordinate grids, rotate/crop/redact scans, stack multi-band header+household crops, stitch census sheet header strips, search PDF text by page via pdftotext, and render selective PDF pages via pdftoppm.
---

# Scan Preparation (`kinloom prep-scan`)

Report pixel size and file size, join separate page scans into one archival image, and generate lightweight inspection previews, original-pixel coordinate grids, redacted archival crops, vertically stitched multi-band crops, census header contact strips, page-indexed PDF regex searches, and selective PDF page renders. The bundled Python script uses a PEP 723 `uv run --script` header (`pillow`, `httpx`), `pdf-pages` uses `pdftoppm`, and `pdf-grep` uses `pdftotext` (or `pypdf` fallback).

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

### 4. Selective PDF page rendering (`pdf-pages`) and page-indexed text search (`pdf-grep`)

Search a multi-page PDF's text layer page by page (`pdftotext`, falling back to `pypdf`) to find exact 1-based page numbers, text snippets, and a ready-to-use `--pages` argument before rendering:

```bash
kinloom prep-scan pdf-grep ./archive/county-history.pdf --pattern "Lincoln" -i --context 200 --limit 25
kinloom prep-scan pdf-grep ./archive/county-history.pdf --pattern "Hardin County" --json
```

`pdf-grep` matches line by line (no cross-line backtracking), exits `0` when one or more matches are found, `1` when zero matches are found, and `2` on invalid regex/flags.

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

`stitch` reads every box from one input file. Use `join` when each page is already its own file.

### 7. Image size and file size (`info`)

Open each local image with Pillow. Width and height follow the same EXIF orientation correction as `preview` and `crop`. Format and mode stay the values stored in the file. `bytes` is the file size on disk. `kb` is that size divided by 1024 and rounded to 1 decimal place.

```bash
kinloom prep-scan info ./raw/page-1.jpg ./raw/page-2.jpg
kinloom prep-scan info ./raw/page-1.jpg ./raw/page-2.jpg --json
```

Text output is one line per file:

```text
/abs/page-1.jpg: 2550x3300 JPEG (842.4 KB)
```

`--json` prints `{ "count", "files" }`. Each file object has `path`, `width`, `height`, `format`, `mode`, `bytes`, and `kb`.

A missing path, an unreadable file, or a non-image exits `1` and names the path on stderr. No size line is printed for that run.

### 8. Join separate page scans (`join`)

Place two or more images in input order on one canvas. `vertical` (default, alias `v`) stacks them top to bottom. `horizontal` (alias `h`) places them left to right. `--gap` (default `8`) is the space between images. `--divider-color` (default `#222222`) fills that gap and the margin beside a shorter image. `--align` is `start`, `center` (default), or `end` on the cross axis. A vertical join aligns width. A horizontal join aligns height.

`--out` is required (aliases `-o` and `--output`). JPEG and WEBP use `--quality` (default `92`). PNG ignores quality. The write uses a temp file and `os.replace`, so a failed save does not leave a partial output. `--preview-out` writes an extra compact JPEG (max width `1400`, max size `280 KB`) for a quick look.

Fewer than two images, a missing `--out`, a negative `--gap`, or a quality outside `1..100` exits `2`.

```bash
kinloom prep-scan join ./raw/act-1.jpg ./raw/act-2.jpg \
  --out ./scans/marriage-act.jpg \
  --direction vertical \
  --gap 8 \
  --align center \
  --divider-color "#222222" \
  --quality 92 \
  --preview-out ./previews/marriage-act.preview.jpg
```

```bash
kinloom prep-scan join ./raw/card-front.jpg ./raw/card-back.jpg \
  --out ./scans/draft-card.jpg \
  --direction horizontal \
  --gap 12 \
  --align start
```

Stdout is JSON: `width`, `height`, `bytes`, `count`, `direction`, `out`, and `preview_out` when you passed `--preview-out`.

### Output flags (forgiving)

- `grid`, `stitch`, and `crop` take the output path positionally (`<in> <out.jpg>`) or as `--out <out.jpg>` (aliases `-o`, `--output`). Giving both with different paths exits 2.
- `join` takes only `--out <file>` (aliases `-o`, `--output`). The image paths stay positional.
- `preview` and `pdf-pages` take `--out-dir <dir>`; `--out`, `-o`, `--output-dir`, and `--output` are aliases.
- `--box` and `--redact` accept `x0,y0,x1,y1`, `"x0, y0, x1, y1"`, `"x0 y0 x1 y1"`, and shell-split `--box 10, 20, 30, 40`.
- `crop` accepts `--quality 1..100` for the archival output (default `92`).

## Environment variables

- `KINLOOM_OCR_CACHE_DIR` (optional): overrides the default preview cache root (`$XDG_CACHE_HOME/kinloom-ocr` or `~/.cache/kinloom-ocr`).
- `XDG_CACHE_HOME` (optional): standard cache base directory used when `KINLOOM_OCR_CACHE_DIR` is unset.

## Requirements

- `uv` (or Python 3.11+ with `pillow`, plus `httpx` for URL inputs in `sheet-strip`).
- `pdftoppm` and `pdftotext` (`poppler-utils` on Linux or `poppler` on macOS) for `pdf-pages` and `pdf-grep` (`pdf-grep` falls back to `pypdf` if `pdftotext` is unavailable).
