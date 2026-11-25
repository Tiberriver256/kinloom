# Kinloom brand guidelines

## Positioning and voice

- **Brand name:** `Kinloom` in prose and headings, `kinloom` in code, package names, and CLI commands.
- **Primary tagline:** Weave primary sources, places, and family memory into one living archive.
- **Short tagline:** Your family's Wikipedia, grounded in primary records.
- **Family-first rule:** Every deployed family archive leads with the family's own name in the top bar (for example `Alder Family Archive`). Kinloom appears as a quiet footer credit (`Built with Kinloom`).

## Logomark

The Interwoven Warp and Weft mark pairs two vertical generational threads with two horizontal shared-history threads.

- Light surfaces (`#F5EFE2`, `#FCF9F2`): `brand/logo-mark.svg` (Archival Indigo `#1B2A41` + Loom Ochre `#7A4612`).
- Dark surfaces (`#1B2A41`): `brand/logo-mark-dark.svg` (Rag White `#FCF9F2` + Warm Brass `#D89C56`).
- Single-color print or icon contexts: `brand/logo-mark-mono.svg` (`currentColor`).
- Clear space: at least 25% of mark width on every side.
- Wordmark lockup: 24 px mark left of `Kinloom` set in `Newsreader` Medium (`500`, `-0.015em` tracking) with `10px` gap.

## Typography

- **Editorial and UI body:** `Newsreader` (optical size, weights 400, 500, 600, 700, 400 italic).
- **Archival data, dates, and diffs:** `IBM Plex Mono` (weights 400, 500, 600).

## Color tokens and contrast

Canonical tokens live in `packages/tokens/tokens.json` and compile to `packages/tokens/kinloom.css`. Run `npm run check:contrast` to verify WCAG 2.2 AA and AAA contrast on every foreground and background pair.
