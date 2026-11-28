import type { EmbeddedGuide } from '../types.js';

export const PDF_GREP_GUIDE: EmbeddedGuide = {
  id: 'pdf-grep',
  command: 'pdf-grep',
  category: 'media-ocr',
  summary: 'Download or read PDFs with SHA-256 disk caching and grep extracted pdftotext output',
  body: `# PDF Grep (\`kinloom pdf-grep\`)

Search one or more local PDF files or remote PDF URLs using regular expressions over cached \`pdftotext\` output via \`kinloom pdf-grep\`. Eliminates ad-hoc download-and-extract loops by caching downloaded PDFs and SHA-256-keyed extracted page text on disk.

## CLI usage (\`kinloom pdf-grep\`)

\`\`\`bash
# Search one local PDF file
kinloom pdf-grep ./county-history.pdf --pattern "Stout|Lincoln" --ignore-case --json

# Search multiple PDFs or remote PDF URLs in one invocation
kinloom pdf-grep ./vol1.pdf "https://example.org/rolls/1880.pdf" --pattern "Sangamon" --pages 1-50 --json

# Combine multiple regex patterns with -e / --pattern
kinloom pdf-grep ./probate.pdf -e "Estate of" -e "Administrator" -i --context 200 --limit 40
\`\`\`

## Options

- \`--pattern, -e, -p <regex>\`: Regular expression to search for (required, repeatable).
- \`-i, --ignore-case\`: Case-insensitive matching.
- \`-C, --context <chars>\`: Context characters around each match snippet (default \`160\`).
- \`-n, --limit <n>\`: Maximum matches returned per PDF source (default \`25\`).
- \`--pages <spec>\`: Optional 1-based page filter (for example \`1-10,15\`).
- \`--cache-dir <dir>\`: Override disk cache root (default \`~/.cache/kinloom-pdf-grep\`, env \`KINLOOM_PDF_GREP_CACHE_DIR\`).
- \`--cache-ttl-hours <hours>\`: Cache TTL for remote URL downloads (default \`168\`, env \`KINLOOM_PDF_GREP_CACHE_TTL_HOURS\`).
- \`--refresh\`: Bypass both URL download and extracted-text caches.
- \`--timeout <seconds>\`: Timeout for HTTP fetches and \`pdftotext\` extraction (default \`60\`).
- \`--json\`: Emit deterministic structured JSON with \`cache_hit\`, per-source page counts, and matches.

## Caching and safety guarantees

- Remote URLs are validated against SSRF rules (blocking private/loopback IPs and non-HTTP/HTTPS schemes) and verified for a \`%PDF\` magic header before caching under \`<cache-dir>/downloads/<sha256>.pdf\`.
- Extracted text is keyed by the SHA-256 hash of the PDF bytes under \`<cache-dir>/text/<sha256>.json\` using advisory file locks and atomic writes.
- Follow Kinloom's staged **Research Package** workflow and **Living Privacy Rule** when citing findings from searched PDFs.
`,
};
