# Kinloom Design System (Paper & Ink Edition)

Kinloom uses an archival Paper and Ink design language built for long-form family history reading, primary-source verification, and quiet legibility. Canonical tokens live in `packages/tokens/tokens.json` and compile to CSS custom properties in `packages/tokens/kinloom.css`. Every foreground and background pairing is verified to WCAG 2.2 AA and AAA by `npm run check:contrast`.

## Visual Direction

- **Materiality:** Unboxed cotton rag paper, hairline ink rules, matte archival photograph mats, and calm editorial hierarchy.
- **Family-first framing:** Every archive leads with the family's own name in the top bar. Kinloom appears only as a quiet footer colophon (`Built with Kinloom`).
- **Voice and vocabulary:** Reader copy follows `docs/ubiquitous-language.md` (Archive, Person Profile, Place Profile, Family Tree, Direct Line, Full Tree, List View, Chart View, Source Discrepancy, Evidence & Sources, Revision History, Research Batch).

## Color Palette

Cotton Rag `#F5EFE2` is Kinloom's intentional archival paper canvas, paired with high-contrast archival inks verified at 7:1+ (AAA) across body text, headings, badges, and diffs.

### Surfaces

| Token | Primitive | Hex | Role |
| --- | --- | --- | --- |
| `--surface-canvas` | `cotton-rag` | `#F5EFE2` | Primary page paper ground |
| `--surface-card` | `rag-card` | `#FCF9F2` | Elevated archival cards, photo mats, inputs |
| `--surface-linen` | `warm-linen` | `#EAE1CE` | Secondary bands, subtle washes, map ground |
| `--surface-muted` | `muted-rag` | `#E5DAC5` | Muted controls, grid hairlines, disabled fills |
| `--surface-header` | `archival-indigo` | `#1B2A41` | Headings, active navigation, dark header bands |

### Ink, Accents, and Borders

| Token | Primitive | Hex | Role |
| --- | --- | --- | --- |
| `--text-primary` | `iron-ink` | `#23272E` | Primary body copy |
| `--text-secondary` | `warm-sepia` | `#4E4A42` | Metadata, captions, secondary labels |
| `--text-inverse` | `rag-card` | `#FCF9F2` | Text on Archival Indigo and primary accent fills |
| `--accent-primary` | `loom-ochre` | `#7A4612` | Primary warm accent, active routes, center pins |
| — | `warm-brass` | `#D89C56` | Brand logomark accent on dark surfaces |
| `--accent-secondary` | `pine-moss` | `#2F5245` | Secondary botanical accent, local survey radius |
| `--action-focus` | `cobalt-ink` | `#1D4E89` | Keyboard `:focus-visible` outlines |
| `--status-conflict` | `seal-crimson` | `#8F2D24` | Source discrepancies, latest migration leg, destructive accents |
| `--border-strong` | `iron-ink` | `#23272E` | High-emphasis rules |
| `--border-control` | `slate-taupe` | `#827A6A` | Interactive control and input borders |
| `--border-decorative` | `parchment-hairline` | `#D6CEBE` | Subtle section dividers and hairlines |

### Diffs and Provenance Badges

| Token | Primitive | Hex | Role |
| --- | --- | --- | --- |
| `--diff-add-bg` | `sage-wash` | `#E2EFE7` | Revision addition and success background |
| `--diff-add-fg` | `deep-pine` | `#1F4D3A` | Revision addition and success foreground |
| `--diff-del-bg` | `rose-wash` | `#F6E2DF` | Revision deletion, error, and discrepancy pill background |
| `--diff-del-fg` | `deep-crimson` | `#7F231B` | Revision deletion, error, and discrepancy pill foreground |
| `--badge-memory-bg` | `amber-wash` | `#F3E4C8` | Family memory badge and transcript highlight background |
| `--badge-memory-fg` | `deep-ochre` | `#6B3D0E` | Family memory badge foreground |
| `--badge-cited-bg` | `pine-wash` | `#DFECE6` | Cited primary-source badge background |
| `--badge-cited-fg` | `deep-moss` | `#244A3C` | Cited primary-source badge foreground |

## Typography

- **Editorial and UI body:** `Newsreader` (optical size, weights `400`, `500`, `600`, `700`, `400 italic`), falling back to `Georgia`, `'Times New Roman'`, `serif`.
- **Archival data, dates, coordinates, badges, and diffs:** `IBM Plex Mono` (weights `400`, `500`, `600`), falling back to `ui-monospace`, `'SFMono-Regular'`, `Menlo`, `monospace`.
- **Base body size:** `16.5px` with `line-height: 1.64`.
- **Editorial reading measure:** Cap running `Newsreader` prose containers to `max-width: 56ch` so rendered lines stay comfortably between 65 and 76 characters (strictly below 80 characters).
- **Type scale:**
  - Page titles (`h1` / `.folio-title`): `clamp(1.75rem, 2.8vw, 2.45rem)` (`28px` to `40px`), weight `600`, `line-height: 1.15–1.18`, `text-wrap: balance`.
  - Section headings (`h2` / `.section-heading`): `1.24rem–1.28rem` (`20px–21px`), weight `600`.
  - Card and entry headings (`h3`): `1rem–1.08rem` (`16.5px–18px`), weight `600`.
  - Body text (`p`): `0.94rem–1.02rem` (`15.5px–17px`), `text-wrap: pretty`.
  - Archival metadata, badges, and monospace controls: `0.72rem–0.84rem` (`12px–14px`), minimum rendered size `>= 12px` on mobile and desktop.

## Spacing, Shape, and Elevation

- **Spacing rhythm:** Tight `4px–8px` gaps inside control groups and badges; `12px–18px` between cards and list rows; `22px–32px` between page sections. Minimum `4px` vertical padding on tinted pills and status badges.
- **Border radii:**
  - `--radius-sm`: `2px` (inline pills, citation tags, map frames, print badges)
  - `--radius-md`: `4px` (family units, person cards, buttons, inputs, drawers)
  - Circular controls: `999px` / `9999px` (avatars, marriage hubs, pronunciation play buttons, pills)
- **Shadows:**
  - `--shadow-card`: `0 1px 3px rgba(35, 39, 46, 0.07)`
  - `--shadow-print`: `0 2px 10px rgba(35, 39, 46, 0.14), 0 1px 2px rgba(35, 39, 46, 0.08)`
  - `--shadow-active`: `0 6px 22px rgba(35, 39, 46, 0.13)`
- **Structural rules:**
  - Differentiate Direct Line family units with a clean full-perimeter archival frame (`1.5px solid var(--surface-header)`) rather than a thick side-tab accent stripe.
  - Keep secondary sub-bands (such as `Died young` strips inside a family unit) flat and hairline-separated rather than nested bordered cards.

## Accessibility and Motion

- **Contrast:** WCAG 2.2 AA (`>= 4.5:1`) minimum everywhere and AAA (`>= 7.0:1`) on primary prose, metadata, badges, and diffs. Verified by `npm run check:contrast`.
- **Touch targets:** All interactive controls on mobile (`<= 768px`) maintain `>= 44px` tap height.
- **Focus:** Explicit `2px solid var(--action-focus)` with `2px` offset on `:focus-visible`.
- **Reduced motion:** Global `@media (prefers-reduced-motion: reduce)` rule disables transitions, animations, and smooth scrolling.
- **Print:** Dedicated `@media print` stylesheet strips navigation chrome and prints crisp dark ink on white paper.
