import type { EmbeddedGuide } from '../types.js';

export const OCR_GUIDE: EmbeddedGuide = {
  id: 'ocr',
  command: 'ocr',
  category: 'media-ocr',
  summary: 'Run SHA-256 cached OCR for printed (tesseract) or cursive scans',
  body: `# Cached OCR (\`kinloom ocr\`)

Content-addressed OCR for genealogical scans. Each image is hashed by SHA-256 and cached on disk by hash and mode so repeated reads return immediately without re-running OCR or paying vision API cost twice.

## Printed text (\`--mode printed\`, default)

Uses local \`tesseract\` (default \`--psm 6\`, single uniform block of text). Every \`tesseract\` invocation enforces built-in **\`OMP_THREAD_LIMIT=1\`** and a hard per-page timeout (**\`--timeout\`**, default **30 seconds** for printed text, **90 seconds** for cursive vision OCR) so parallel runs never thrash CPU cores or hang on noisy scans:

\`\`\`bash
kinloom ocr ./scans/obituary-1912.jpg
kinloom ocr ./scans/city-directory-p44.jpg --psm 4 --json
kinloom ocr ./scans/obituary-1912.jpg --force
\`\`\`

## Parallel batch OCR & regex search (\`kinloom ocr batch\`)

Use \`kinloom ocr batch\` to OCR an entire directory or glob of page scans in parallel with bounded concurrency, SHA-256 disk caching, and optional line-by-line regex filtering (\`--grep\`):

\`\`\`bash
# OCR a directory or glob in parallel (4 workers, 30s per-page timeout, OMP_THREAD_LIMIT=1)
kinloom ocr batch ./scans/county-history/ --concurrency 4 --timeout 30 --json

# OCR a glob and keep only pages matching a regex pattern
kinloom ocr batch "./scans/roll-*.jpg" --grep "probate|docket|Lincoln" --concurrency 4 --timeout 30 --json

# Search a directory of rendered PDF pages, force-refreshing cached entries
kinloom ocr batch ./rendered/ --grep "Hardin County" --concurrency 4 --timeout 30 --force --json
\`\`\`

Key \`batch\` protections and flags:

- **Input:** \`<glob-or-dir>\` accepts a directory (scans supported image extensions in sorted order) or a glob pattern.
- **\`--grep <regex>\`:** filters OCR output line by line (case-insensitive) and returns only matching pages and snippets without cross-line backtracking.
- **\`--concurrency <n>\`:** caps parallel \`tesseract\` workers (default \`4\`). Combined with the mandatory \`OMP_THREAD_LIMIT=1\` pin on every child \`tesseract\` process, parallel OCR stays fast without saturating all CPU threads.
- **\`--timeout <seconds>\`:** hard per-page timeout (default \`30\` seconds). A timed-out page fails cleanly and is reported per file without stalling the rest of the batch.
- **\`--json\`:** prints structured batch results (matched files, snippets, timing, errors, and cache hit counts) for downstream research scripts.

## Multi-file invocations

You can also pass two or more explicit image paths directly to \`kinloom ocr\` instead of writing a shell \`for\` loop. Every image runs with the same \`OMP_THREAD_LIMIT=1\` pin, SHA-256 disk cache, and per-image \`--timeout\`. Single-image output is unchanged; multi-image runs print \`=== <path> ===\` sections in text or \`--tsv\` mode, and \`{ files: [...], count, cache_hits }\` in \`--json\`, \`--boxes\`, or \`--find\` mode:

\`\`\`bash
kinloom ocr ./scans/page-01.jpg ./scans/page-02.jpg ./scans/page-03.jpg
kinloom ocr ./scans/page-*.jpg --find 'probate|docket'
kinloom ocr ./scans/crop-1.jpg ./scans/crop-2.jpg --json
\`\`\`

## Line boxes and raw TSV (\`--boxes\`, \`--find\`, \`--tsv\`)

Use these flags instead of ad-hoc \`tesseract ... tsv\` calls when you need pixel coordinates (printed mode only). They run the same hardened \`tesseract\` call (\`OMP_THREAD_LIMIT=1\`, \`--timeout\`, default \`30\` seconds).

- \`--boxes\` prints JSON: \`{ sha256, psm, image_width, image_height, lines: [{ text, x0, y0, x1, y1, conf, page, block, par, line, words: [...] }], cached, cache_path }\`. Words are grouped into lines by Tesseract \`(block_num, par_num, line_num)\`. \`conf\` is the mean word confidence.
- \`--find <regex>\` implies \`--boxes\` and keeps only lines whose text matches the regex (case-insensitive). Pass each \`x0 y0 x1 y1\` box to \`kinloom prep-scan crop\` or \`kinloom prep-scan stitch\`.
- \`--tsv\` prints the raw Tesseract TSV. You cannot combine it with \`--boxes\` or \`--find\`.

\`\`\`bash
kinloom ocr ./scans/county-history-p212.jpg --find 'probate|docket'
kinloom ocr ./scans/county-history-p212.jpg --boxes --psm 4
kinloom ocr ./scans/county-history-p212.jpg --tsv > p212.tsv
\`\`\`

## Handwritten cursive (\`--mode cursive\`)

Automatically downsizes scans larger than 350 KB using the \`kinloom prep-scan\` preview pipeline, then invokes the configured vision CLI (\`KINLOOM_OCR_CLI\`, default \`agy\`) to transcribe headers and rows verbatim while marking illegible text as \`[?]\`:

\`\`\`bash
kinloom ocr ./scans/census-1870-sheet4.jpg --mode cursive
kinloom ocr ./scans/deed-1848.jpg --mode cursive --effort medium --json
kinloom ocr ./scans/letter-1864.jpg --mode cursive --prompt "Transcribe this letter verbatim from {image_path}."
\`\`\`

## Cache layout

Cached JSON records are written atomically to \`<cache-dir>/<sha256>_<mode-slug>.json\`. Layout output uses separate files, so it never collides with plain-text OCR: \`<sha256>_printed_psm<N>.tsv\` (raw TSV) and \`<sha256>_printed_psm<N>.boxes.json\` (parsed boxes). \`--find\` filters the cached boxes, so a new regex on the same scan does not run \`tesseract\` again. \`<cache-dir>\` defaults to:

1. \`--cache-dir <dir>\`
2. \`KINLOOM_OCR_CACHE_DIR\`
3. \`$XDG_CACHE_HOME/kinloom-ocr\`
4. \`~/.cache/kinloom-ocr\`

Pass \`--force\` to recompute and overwrite an existing cache entry, or \`--json\` to inspect cache status, SHA-256 digest, engine metadata, and timing.

## Environment variables

- \`KINLOOM_OCR_CACHE_DIR\` (optional): overrides the default cache directory.
- \`KINLOOM_OCR_CLI\` (optional): vision CLI binary invoked in \`--mode cursive\` (default: \`agy\`).
- \`KINLOOM_OCR_MODEL\` (optional): overrides the model name passed to the vision CLI.
- \`XDG_CACHE_HOME\` (optional): standard cache base directory used when \`KINLOOM_OCR_CACHE_DIR\` is unset.

## Requirements

- \`tesseract\` (\`tesseract-ocr\`) on \`PATH\` for \`--mode printed\` and \`kinloom ocr batch\`.
- Configured vision CLI (\`KINLOOM_OCR_CLI\`, default \`agy\`) on \`PATH\` for \`--mode cursive\`.`,
};
