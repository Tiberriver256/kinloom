# Wave 51 Impeccable design quality audit specification

Date: 2026-11-26
Baseline commit: `c52e914` (Wave 50B)
Tool version: `impeccable` CLI `4.10.0`
Audit targets: `packages/ui/src`, `packages/tokens`, `examples/demo/src`, and 17 live rendered routes from `examples/demo/dist` (`Lincoln & Todd Historical Archive`)
Viewports audited: `1280x800` (desktop) and `390x844` (mobile)
Method: Static `impeccable foundations`, regex `impeccable detect --json` on source files, and headless Chromium `impeccable detect --json` against local `vite preview` serving the existing `examples/demo/dist` build.

## 1. Executive summary

Measured across 87 source files in `packages/ui/src`, `packages/tokens`, `examples/demo/src`, and 34 live browser scans (17 routes at desktop and mobile), `impeccable detect` reported 158 raw browser hits and 1 source regex hit.

1. **Zero Critical defects appeared on rendered pages.** Impeccable reported 0 hits on `low-contrast`, `overused-font`, `generic-font`, `horizontal-overflow`, `overlapping-elements`, and `repeated-container-text` across all 34 rendered scans. Every finding from the prior pronunciation audit (`packages/ui/.impeccable/audit/2026-11-26T17-00-32Z__src-components-pronunciationbadge-tsx.md`) is now resolved in code.
2. **Five genuine Impeccable detector rules failed (124 raw live hits plus 1 source regex hit).** One CSS rule (`.tree-roll-unit.is-direct`) causes 105 `side-tab` hits across desktop and mobile **List View** scans plus the single source regex hit. The other four genuine rules are `nested-cards` (10 hits on `.tree-early-strip` inside `.tree-roll-unit`), `line-length` (5 desktop hits on `/`, `/changes`, `/person/abraham-lincoln-1809`, and `/person/robert-todd-lincoln`), `tiny-text` (2 mobile hits in `LocalSurveyMap`), and `cramped-padding` (2 mobile hits on `span.conflict-pill`).
3. **One rule (`cream-palette`, 34 hits) is a confirmed false positive.** Kinloom intentionally uses Cotton Rag `#F5EFE2` (`--surface-canvas`) as its WCAG 2.2 AAA Paper and Ink editorial canvas. Wave 51B should keep `#F5EFE2`, publish a canonical root `DESIGN.md`, and add a documented waiver in `.impeccable/config.json`.
4. **Foundations and token governance need formal structure.** The repository has `brand/BRAND.md` and `packages/tokens/tokens.json`, but it has no root `DESIGN.md`, no `.impeccable/config.json`, no real 404 route in `KinloomApp`, and no automated `npm run audit:impeccable` gate. Static inspection also measured 3 undefined CSS variables (`--font-body`, `--status-error`, `--status-success`) and 39 distinct off-token raw hex literals across `packages/ui/src`.

## 2. Impeccable CLI status and foundations scorecard

### CLI status

Measured from `impeccable --version`, `impeccable status`, and `impeccable ignores list`:

- **CLI version:** `4.10.0` (global binary).
- **Account state:** Not signed in (`Not signed in. Run npx impeccable login.`). All local detector rules and foundations checks run offline without authentication, so Wave 51B CI and local scripts do not require an account.
- **Ignore configuration:** None present at repository root (`.impeccable/config.json` and `.impeccable/config.local.json` are absent, so `ignoreRules`, `ignoreFiles`, and `ignoreValues` are all empty and `designSystem` is enabled).

### Foundations scorecard

Measured with `impeccable foundations <path> --json` on three scopes:

| Foundation item | Repo root (`.`) | `packages/ui` | `examples/demo` | Triage for Kinloom |
| --- | --- | --- | --- | --- |
| `ci-runs-tests` | Pass | Pass | Pass | Complete. |
| `reduced-motion` | Pass | Pass | Pass | Complete (`archival.css:6368-6376`). |
| `secrets-out-of-repo` | Pass | Pass | Pass | Complete (`npm run check:leaks`). |
| `readme-runs` | Pass | Not checked | Not checked | Complete. |
| `design-tokens` | Pass | Fail | Not checked | False positive for `packages/ui` because tokens live in sibling `packages/tokens/`. Add root `DESIGN.md` so Impeccable validates tokens directly. |
| `no-generic-ai-patterns` | Fail | Fail | Not checked | Genuine failure caused by `side-tab` at `packages/ui/src/styles/archival.css:2728`. Fix in Wave 51B. |
| `no-giant-files` | Fail | Fail | Pass | Genuine structural debt. `packages/ui/src/styles/archival.css` is 9,103 lines, `MapPage.tsx` is 1,365 lines, `PersonPage.tsx` is 1,363 lines, and `TreePage.tsx` is 1,217 lines. |
| `not-found-page` | Not checked | Not checked | Fail | Genuine UX gap. `KinloomApp.tsx:145` redirects `*` silently to `/` instead of rendering an archival Not Found page. |
| `dependency-scanning` | Fail | Fail | Fail | Genuine repo hygiene gap. Add `.github/dependabot.yml` or an `npm audit` workflow check. |
| `app-icons` | Not checked | Fail | Fail | False positive for `packages/ui` (headless library). Actionable for `examples/demo/index.html`, which lacks `apple-touch-icon` and manifest icons. |
| `social-previews` | Not checked | Fail | Fail | False positive for `packages/ui`. Actionable for `examples/demo/index.html`, which lacks OpenGraph and Twitter preview tags. |
| `error-tracking` | Not checked | Fail | Fail | False positive for an open-source library and static public demo. |
| `legal-pages` | Not checked | Fail | Fail | False positive for an open-source library and static MIT public demo. |
| `infrastructure-as-code` | Fail | Fail | Fail | Low priority at monorepo root because deployment configs live in downstream archive templates, not the core library root. |

Summary scores reported by `impeccable foundations`:

- **Repo root:** 5 of 9 in place. Next recommended item: `no-generic-ai-patterns`.
- **`packages/ui`:** 3 of 12 in place (5 of 9 failures are app-only checks that do not apply to a component library).
- **`examples/demo`:** 4 of 11 in place. Next recommended item: `not-found-page`.

### Recommendation on `DESIGN.md`, `.impeccable/config.json`, and `npm run audit:impeccable`

Wave 51B should add all three artifacts to lock in the fixes:

1. **Add canonical root `DESIGN.md`.** Derive it from `packages/tokens/tokens.json`, `packages/tokens/kinloom.css`, and `brand/BRAND.md`. Declare the Paper and Ink color palette (including `#F5EFE2` Cotton Rag canvas and all 22 primitives), typography (`Newsreader` and `IBM Plex Mono`), border radii (`--radius-sm: 2px`, `--radius-md: 4px`, plus `9999px` for circular controls), and type scale. Once `DESIGN.md` exists, Impeccable activates its four design-system drift rules (`design-system-font`, `design-system-color`, `design-system-radius`, `design-system-font-size`) automatically on every scan.
2. **Add shared `.impeccable/config.json`.** Waive only `cream-palette` with an explicit reason documenting `#F5EFE2` Cotton Rag as Kinloom's intentional WCAG 2.2 AAA Paper and Ink surface. Do not add broad rule waivers for `side-tab`, `nested-cards`, `line-length`, `tiny-text`, or `cramped-padding`.
3. **Add `npm run audit:impeccable` in root `package.json` (plus `scripts/audit-impeccable.mjs`).** The script should run `impeccable detect --json packages/ui/src packages/tokens`, serve `examples/demo/dist` via `vite preview` on an ephemeral local port, run `impeccable detect --json` at `1280x800` and `390x844` across core routes, assert `0` non-advisory primary findings, and cleanly stop the preview server. Keep `.impeccable/audit/` scratch reports gitignored in root `.gitignore` so local ad-hoc runs never dirty git status.

## 3. Prior Impeccable pronunciation audit disposition

Inspected `packages/ui/.impeccable/audit/2026-11-26T17-00-32Z__src-components-pronunciationbadge-tsx.md` (scored 12/20 with 1 P0, 2 P1, and 2 P2 items) against current commit `c52e914`:

| Prior ID | Finding | Current status | Verified code location |
| --- | --- | --- | --- |
| P0 | Duplicate `.pronunciation-play-btn:hover` caused 1.07:1 white-on-cream speaker icon | **Fixed** | `packages/ui/src/styles/archival.css:8728-8733` pairs `background: var(--accent-primary)` with `color: var(--text-inverse)` with no duplicate override. |
| P1 | Inline pronunciation badges disrupted biography headings and prose rhythm | **Fixed** | `packages/ui/src/components/ArchivalMarkdown.tsx:799-807` skips `entityCtx` inside headings. `packages/ui/src/components/InlineEntityMention.tsx:263-270, 299-306` renders `compact iconOnly` inline and keeps full respelling, IPA, and variants inside the popover. |
| P1 | Compact `.pronunciation-play-btn` measured `20x20px` and stretched into an oval | **Fixed** | `packages/ui/src/styles/archival.css:8717-8719, 8920-8925` locks `width: 24px; height: 24px; min-width: 24px; padding: 0;`, and `8144-8150` raises profile header buttons to `44x44px` on mobile. |
| P2 | Missing `:focus-visible` indicator on pronunciation buttons | **Fixed** | `packages/ui/src/styles/archival.css:8927-8932, 8999-9002` applies `outline: 2px solid var(--action-focus); outline-offset: 2px;`. |
| P2 | Missing `prefers-reduced-motion` transition reset on pronunciation controls | **Fixed** | `packages/ui/src/styles/archival.css:6368-6376` disables transitions globally under `prefers-reduced-motion: reduce`, and `8934-8939` repeats it for pronunciation buttons. |

Residual pronunciation CSS hygiene issues discovered during this check (tracked under Low below):

- `packages/ui/src/styles/archival.css:8686` references undefined `var(--font-body)` on `.pronunciation-prefix`.
- `packages/ui/src/styles/archival.css:9097` and `9101` reference undefined `var(--status-error, #991b1b)` and `var(--status-success, #166534)` with off-token fallback hex values.
- `packages/ui/src/styles/archival.css:8974-8986` gives `.pronunciation-variant-btn` only `padding: 1px 7px` at `0.68rem`, which risks triggering `cramped-padding` whenever a person or place renders regional variants.

## 4. Complete scan matrix and false-positive triage

### Scan summary by target

Note: `packages/tokens` stores `tokens.json` and `kinloom.css` directly at the package root with no `src/` folder, and the demo app lives at `examples/demo` rather than `apps/demo`. The `/people` path is not a registered route in `KinloomApp.tsx`, so it hits the wildcard redirect to `/`.

| Target | Mode | Raw hits | False positives (`cream-palette`) | Genuine findings | Genuine rules triggered |
| --- | --- | --- | --- | --- | --- |
| `packages/ui/src` (87 files) | Regex | 1 | 0 | 1 | `side-tab` (1) |
| `packages/tokens` (2 files) | Regex | 0 | 0 | 0 | None |
| `examples/demo/src` + `index.html` | Regex | 0 | 0 | 0 | None |
| Primary 12 demo routes (`1280x800`) | Browser | 38 | 12 | 26 | `side-tab` (21), `line-length` (3), `nested-cards` (2) |
| Primary 12 demo routes (`390x844`) | Browser | 61 | 12 | 49 | `side-tab` (42), `nested-cards` (4), `tiny-text` (2), `cramped-padding` (1) |
| Extra 5 demo routes/states (`1280x800`) | Browser | 30 | 5 | 25 | `side-tab` (21), `line-length` (2), `nested-cards` (2) |
| Extra 5 demo routes/states (`390x844`) | Browser | 29 | 5 | 24 | `side-tab` (21), `nested-cards` (2), `cramped-padding` (1) |
| **Total live browser scans (34)** | **Browser** | **158** | **34** | **124** | **5 distinct rules** |

### Per-route breakdown of genuine live findings

Routes with `0` genuine findings at both `1280x800` and `390x844`: `/tree?surface=diagram`, `/tree?mode=full&surface=diagram`, `/places`, `/time`, `/map`, `/map?place=springfield-illinois`, `/evidence`, and `/kinship`.

| Route | Desktop (`1280x800`) genuine findings | Mobile (`390x844`) genuine findings |
| --- | --- | --- |
| `/` | `line-length` (1: `p`, ~158 chars) | 0 |
| `/tree` | 0 (defaults to Chart View on desktop) | `side-tab` (21), `nested-cards` (2) (defaults to List View on mobile) |
| `/tree?surface=roll` | `side-tab` (21), `nested-cards` (2) | `side-tab` (21), `nested-cards` (2) |
| `/tree?mode=full&surface=roll` | `side-tab` (21), `nested-cards` (2) | `side-tab` (21), `nested-cards` (2) |
| `/person/abraham-lincoln-1809` | `line-length` (2: `#evt_1865_gardner_portrait > p`, `#evt_1865_death_abraham > p`, ~87 chars) | `cramped-padding` (1: `span.conflict-pill`) |
| `/person/robert-todd-lincoln` | `line-length` (1: `#evt_1865_death_abraham > p`, ~87 chars) | `cramped-padding` (1: `span.conflict-pill`) |
| `/place/springfield-illinois` | 0 | `tiny-text` (1: `text:nth-of-type(2)`, `10.2px`) |
| `/place/hingham-massachusetts` | 0 | `tiny-text` (1: `text:nth-of-type(2)`, `10.2px`) |
| `/changes` | `line-length` (1: `div:nth-of-type(1) > p`, ~89 chars) | 0 |

### False-positive triage

- **`cream-palette` (`body`, `rgb(245, 239, 226)` / `#F5EFE2`, 34 live hits):** Dismissed as intentional design, not AI slop. `#F5EFE2` (`cotton-rag`, `--surface-canvas`) is Kinloom's documented Paper and Ink archival paper substrate in `packages/tokens/tokens.json:6` and `brand/BRAND.md:14`, verified at WCAG 2.2 AA and AAA across 15 foreground pairs by `scripts/check-contrast.mjs`. Do not change the background color. Waive `cream-palette` explicitly in `.impeccable/config.json` alongside root `DESIGN.md`.
- **`packages/ui` foundations failures for `app-icons`, `social-previews`, `legal-pages`, `error-tracking`, `design-tokens`:** Dismissed as package-type mismatches because `@kinloom/ui` is a reusable React library package whose tokens live in `@kinloom/tokens` and whose HTML shell lives in host apps such as `examples/demo`.

## 5. Prioritized findings and Wave 51B implementation plan

Findings are grouped by severity using reader impact, cross-route blast radius, and design-system fidelity.

### Critical

None measured. Zero contrast failures, zero horizontal overflow errors, zero element collisions, and zero broken-font findings occurred across all 34 rendered scans.

### High

#### H-1. Replace rounded left accent stripe on Direct Line family units (`side-tab`)

- **Rule ID:** `side-tab` (severity: warning, category: slop) plus foundation `no-generic-ai-patterns`.
- **Evidence:** 1 source regex hit (`packages/ui/src/styles/archival.css:2728`) and 105 live hits across `/tree` (mobile) and `/tree?surface=roll` / `/tree?mode=full&surface=roll` (desktop and mobile). Snippet: `border-left: 4px + border-radius: 6px` on `.tree-roll-unit.is-direct`.
- **Locations:**
  - `packages/ui/src/styles/archival.css:2713-2729` (`.tree-roll-unit` and `.tree-roll-unit.is-direct`)
  - `packages/ui/src/components/tree/TreePedigreeRoll.tsx:276-279`
- **Root cause:** `.tree-roll-unit` sets `border-radius: 6px` (which is also off the `--radius-md: 4px` token scale), and `.tree-roll-unit.is-direct` overrides the left edge with `border-left: 4px solid var(--surface-header)`. That creates the exact rounded side-tab stripe pattern Impeccable flags.
- **Archival-aesthetic fix:** Remove `border-left: 4px solid var(--surface-header)` from `.tree-roll-unit.is-direct`. Align `.tree-roll-unit` to `border-radius: var(--radius-md)` (`4px`). Differentiate **Direct Line** family units with a clean full-perimeter archival frame (`border: 1.5px solid var(--surface-header); box-shadow: var(--shadow-card);`) or a subtle quiet top rule plus a compact monospace `Direct Line` caption where needed, keeping the Paper and Ink ledger calm without a heavy side bar.

#### H-2. Flatten nested card box on "Died young" strips inside Family Tree units (`nested-cards`)

- **Rule ID:** `nested-cards` (severity: warning, category: slop).
- **Evidence:** 10 live hits across `/tree` (mobile) and `/tree?surface=roll` / `/tree?mode=full&surface=roll` (desktop and mobile). Selectors: `#tree-roll-gen-5` and `#tree-roll-gen-6` `.tree-roll-unit.is-direct > .tree-roll-attachments > .tree-early-strip`.
- **Locations:**
  - `packages/ui/src/styles/archival.css:2883-2906` (`.tree-roll-attachments` and `.tree-early-strip`)
  - `packages/ui/src/components/tree/TreePedigreeRoll.tsx:136-189`
- **Root cause:** `.tree-roll-unit` is already a bordered, rounded, shadowed card (`background: var(--surface-card); border: 1px solid ...; border-radius: 6px; box-shadow: var(--shadow-card);`). Inside it, `.tree-roll-attachments` adds a dashed top divider, and `.tree-early-strip` then draws a second bordered rounded card (`background: var(--surface-linen); border: 1px solid var(--border-decorative); border-radius: 4px; padding: 8px 10px;`).
- **Archival-aesthetic fix:** Remove the inner card chrome from `.tree-early-strip`. Set `background: transparent; border: none; border-radius: 0; padding: 2px 0;` and rely on the existing dashed ledger rule on `.tree-roll-attachments` (`border-top: 1px dashed var(--border-decorative)`) plus typography and chip spacing. Keep the sprig icon, `Died young (N)` heading, and interactive child chips unchanged.

#### H-3. Constrain Newsreader prose line length below 80 characters (`line-length`)

- **Rule ID:** `line-length` (severity: warning, category: quality).
- **Evidence:** 5 desktop live hits:
  - `/` (`selector: p`): `~158 chars on 2 of 3 rendered lines` (override `max-width: none` at `archival.css:638`).
  - `/changes` (`selector: div:nth-of-type(1) > p`): `~89 chars on 2 of 3 rendered lines` (`.place-page p { max-width: 66ch; }` at `archival.css:1647` overrides `.wire-banner p { max-width: 62ch; }` at `archival.css:611`).
  - `/person/abraham-lincoln-1809` (`#evt_1865_gardner_portrait > p` and `#evt_1865_death_abraham > p`): `~87 chars on 2 of 2` and `2 of 3 rendered lines` (`.story-card p { max-width: 66ch; }` at `archival.css:959`).
  - `/person/robert-todd-lincoln` (`#evt_1865_death_abraham > p`): `~87 chars on 2 of 3 rendered lines`.
- **Locations:**
  - `packages/ui/src/styles/archival.css:244-249` (`.folio-lead`, `64ch`)
  - `packages/ui/src/styles/archival.css:553-559` (`.source-details`, `66ch`)
  - `packages/ui/src/styles/archival.css:607-612` (`.wire-banner p`, `62ch`)
  - `packages/ui/src/styles/archival.css:635-639` (`.index-banner p`, `max-width: none`)
  - `packages/ui/src/styles/archival.css:955-965` (`.story-card p` and `.also-here`, `66ch`)
  - `packages/ui/src/styles/archival.css:1646-1648` (`.place-page p`, `66ch`)
  - `packages/ui/src/styles/archival.css:4362-4364` (`.person-biography-entry`, `68ch`)
- **Root cause:** Two mechanisms combine. First, `.index-banner p` explicitly clears the measure with `max-width: none`. Second, `Newsreader` has a wide `0` glyph relative to proportional lowercase letters, so `62ch` to `68ch` renders 85 to 92 actual characters per line instead of 65 to 75.
- **Archival-aesthetic fix:** Delete `max-width: none` from `.index-banner p`. Calibrate Newsreader prose containers (`.wire-banner p`, `.index-banner p`, `.folio-lead`, `.story-card p`, `.place-page p`, `.source-details`, `.person-biography-entry`) to `max-width: 56ch` (or `36rem`, which yields 68 to 76 rendered characters per line in `Newsreader` at `16.5px`). Ensure `.place-page .wire-banner p` does not widen `.wire-banner p`.

### Medium

#### M-1. Eliminate sub-12px SVG labels on mobile Place Profile survey maps (`tiny-text`)

- **Rule ID:** `tiny-text` (severity: warning, category: quality).
- **Evidence:** 2 mobile (`390x844`) live hits on `/place/springfield-illinois` and `/place/hingham-massachusetts`: `10.2px body text` on `text:nth-of-type(2)` (`scopeLabel`, e.g., `15-mi radius · 2 inside`).
- **Locations:**
  - `packages/ui/src/components/LocalSurveyMap.tsx:309-323` (neighbor pin `<text>` at `fontSize={isNarrow ? '10' : '9.2'}`)
  - `packages/ui/src/components/LocalSurveyMap.tsx:345-358` (scope `<text>` at `fontSize={compact ? '7.8' : isNarrow ? '10.2' : '9'}`)
- **Root cause:** `LocalSurveyMap` renders `scopeLabel` inside the `viewBox="0 0 360 190"` SVG at `10.2` user units on mobile, which maps almost 1:1 to `10.2px` CSS pixels. Neighbor pin text is `10` user units (`10px`) on mobile.
- **Archival-aesthetic fix:** Move `scopeLabel` out of the SVG into a semantic HTML caption strip (`.local-survey-caption` set in `IBM Plex Mono` at `0.78rem` / `12.9px`, paired cleanly above or below the SVG with `.local-survey-nearby-strip`). Removing `scopeLabel` from the SVG also eliminates label collision around the center pin. For non-compact neighbor pin labels inside the SVG (`line 313`), raise `fontSize` to `isNarrow ? '12' : '11'` and expand `charW` in `LocalSurveyMap.tsx:173` proportionally so collision placement stays clean.

#### M-2. Add breathing room to Source Discrepancy pills (`cramped-padding`)

- **Rule ID:** `cramped-padding` (severity: warning, category: quality).
- **Evidence:** 2 mobile (`390x844`) live hits on `/person/abraham-lincoln-1809` and `/person/robert-todd-lincoln`: `2.9px of space above and below the text (need >=4.0px for 11.88px text)` on `span.conflict-pill`.
- **Locations:**
  - `packages/ui/src/styles/archival.css:540-550` (`.conflict-pill`)
  - `packages/ui/src/components/Atoms.tsx:385-397`
  - `packages/ui/src/pages/EvidencePage.tsx:311`
- **Root cause:** `.conflict-pill` uses `padding: 1px 6px` with `font-size: 0.72rem` (`11.88px`), leaving only `2.9px` vertical inset between the rendered glyphs and the tinted container box.
- **Archival-aesthetic fix:** Change `.conflict-pill` padding to `padding: 4px 8px; line-height: 1.3; border-radius: var(--radius-sm);` and replace raw `rgba(143, 45, 36, 0.08)` with `var(--diff-del-bg)` paired with `var(--diff-del-fg)` (or `var(--status-conflict)`) so the badge stays on canonical WCAG AAA tokens while meeting `>= 4.0px` vertical clearance. Apply the same minimum vertical padding (`padding: 4px 8px`) to `.pronunciation-variant-btn` (`archival.css:8974-8986`) proactively so regional pronunciation variants do not trigger `cramped-padding`.

#### M-3. Add canonical `DESIGN.md`, `.impeccable/config.json`, and `npm run audit:impeccable`

- **Rule ID / Foundation:** Design-system rules (`design-system-font`, `design-system-color`, `design-system-radius`, `design-system-font-size`) and continuous regression enforcement.
- **Locations:**
  - New root `DESIGN.md`
  - New `.impeccable/config.json`
  - Root `.gitignore` (add `.impeccable/audit/` so local audit logs stay untracked)
  - New `scripts/audit-impeccable.mjs` and root `package.json` script `audit:impeccable`
- **Fix:** Publish root `DESIGN.md` from `packages/tokens/tokens.json` and `brand/BRAND.md`, register the single justified `cream-palette` waiver in `.impeccable/config.json`, and wire `npm run audit:impeccable` to verify both source files and live rendered demo routes.

#### M-4. Replace silent wildcard redirect with an archival Not Found page (`not-found-page`)

- **Foundation:** `not-found-page` (failing in `examples/demo` foundations scan).
- **Locations:**
  - `packages/ui/src/KinloomApp.tsx:145` (`<Route path="*" element={<Navigate to="/" replace />} />`)
  - New `packages/ui/src/pages/NotFoundPage.tsx` (and export if needed)
- **Root cause:** Unknown URLs silently bounce readers back to `/` with no explanation or recovery options.
- **Archival-aesthetic fix:** Render an editorial `NotFoundPage` inside `ExplorerTopBar` and `KinloomFooter` stating that the requested archive record or page was not found, with direct links to **People** (`/`), **Family Tree** (`/tree`), **Places** (`/places`), and the global **Search** modal. If `/people` should remain a supported alias, add `<Route path="/people" element={<Navigate to="/" replace />} />` explicitly above `*`.

### Low

#### L-1. Replace undefined CSS variables and consolidate off-token raw hex literals

- **Rule ID / Scope:** Prepares the codebase for `design-system-color` once `DESIGN.md` lands.
- **Evidence:** Static audit of `packages/ui/src` measured:
  - 3 undefined CSS variables in `packages/ui/src/styles/archival.css`: `--font-body` (`line 8686`), `--status-error` with fallback `#991b1b` (`line 9097`), and `--status-success` with fallback `#166534` (`line 9101`).
  - 36 raw hex literals (29 distinct off-token hexes) in `packages/ui/src/styles/archival.css` and 56 raw hex literals (10 distinct off-token hexes) in `packages/ui/src/**/*.ts(x)`, led by `LocalSurveyMap.tsx` (`#F4EFE3`, `#D5CCB8`, `#E2D9C5`, `#9E9687`) and `MapPage.tsx` (`#ece4d2`, `#736857`, `#5C5344`, `#5A4B3C`, `#F4E2B8`).
- **Locations:**
  - `packages/ui/src/styles/archival.css:41, 8686, 9097, 9101` (plus print and state tints)
  - `packages/ui/src/components/LocalSurveyMap.tsx:225-365`
  - `packages/ui/src/components/KinloomFooter.tsx:16-19`
  - `packages/ui/src/pages/MapPage.tsx:90-95, 107, 240-435`
- **Fix:** Replace `--font-body` with `var(--font-serif)`, `--status-error` with `var(--diff-del-fg)` (or `var(--status-conflict)`), and `--status-success` with `var(--diff-add-fg)` (or `var(--accent-secondary)`). Migrate `LocalSurveyMap.tsx` and `KinloomFooter.tsx` SVG strokes and fills to CSS custom properties (`var(--surface-canvas)`, `var(--border-decorative)`, `var(--surface-header)`, `var(--accent-primary)`, `var(--accent-secondary)`, `var(--text-secondary)`). Note that MapLibre GL paint expressions in `MapPage.tsx` require resolved hex strings rather than CSS `var()`, so import those hexes from `@kinloom/tokens/tokens.json` (or document the two map-only muted terrain tints in `DESIGN.md`).

#### L-2. Align `RecentChangesPage` copy with `docs/ubiquitous-language.md`

- **Scope:** DDD ubiquitous-language consistency observed on `/changes`.
- **Locations:**
  - `packages/ui/src/pages/RecentChangesPage.tsx:148-152, 334`
- **Evidence:** Line 148 uses `Recent Changes & Research Waves`, line 150 uses `audit trail`, line 151 uses `batch wave`, and line 334 uses `Undo / Revert`. Per `docs/ubiquitous-language.md:85-88`, canonical reader terms are **Revision History**, **Research Batch**, and **Revert** (avoiding `Audit log`, `Agent wave`, and `Undo / Revert` split labels).
- **Fix:** Update the heading to `Revision History`, update the lead copy to reference `Revisions` and `Research Batches` without `audit trail` or `batch wave`, and standardize the single-revision button label to `Revert` (matching line 274).

#### L-3. Repo and demo foundations hygiene (`dependency-scanning`, `app-icons`, `social-previews`, `no-giant-files`)

- **Locations:**
  - `.github/dependabot.yml` (new)
  - `examples/demo/index.html:1-18`
  - `packages/ui/src/styles/archival.css` (9,103 lines, staged modular split)
- **Fix:**
  1. Add `.github/dependabot.yml` for weekly `npm` and `github-actions` updates to satisfy `dependency-scanning`.
  2. Add `apple-touch-icon` plus `og:title`, `og:description`, `og:type`, and `twitter:card` tags to `examples/demo/index.html` to satisfy `app-icons` and `social-previews`.
  3. Plan a non-breaking CSS split of `packages/ui/src/styles/archival.css` into domain partials imported by `archival.css` (such as `base.css`, `topbar.css`, `tree.css`, `person.css`, `place.css`, `map.css`, `pronunciation.css`, `wiki.css`) in a dedicated structural wave so `no-giant-files` passes without risking style cascade regressions during Wave 51B.

## 6. Verification contract for Wave 51B

Wave 51B is complete only when every command and assertion below passes on a fresh build of `@kinloom/ui` and `@kinloom/demo`.

### Impeccable CLI target counts

1. **Source regex scan (0 primary findings):**
   ```bash
   impeccable detect --json packages/ui/src packages/tokens examples/demo/src examples/demo/index.html
   ```
   Expected result: exit code `0`, JSON array `[]` (`0` `side-tab`, `0` `design-system-*` primary warnings).

2. **Live demo desktop and mobile scans (0 primary findings with `.impeccable/config.json`):**
   ```bash
   npm run audit:impeccable
   ```
   Equivalent explicit check against `examples/demo/dist` on `http://127.0.0.1:4173`:
   ```bash
   impeccable detect --json --viewport 1280x800 \
     http://127.0.0.1:4173/ \
     http://127.0.0.1:4173/tree \
     "http://127.0.0.1:4173/tree?surface=diagram" \
     "http://127.0.0.1:4173/tree?surface=roll" \
     "http://127.0.0.1:4173/tree?mode=full&surface=roll" \
     http://127.0.0.1:4173/places \
     http://127.0.0.1:4173/time \
     http://127.0.0.1:4173/map \
     http://127.0.0.1:4173/evidence \
     http://127.0.0.1:4173/kinship \
     http://127.0.0.1:4173/changes \
     http://127.0.0.1:4173/person/abraham-lincoln-1809 \
     http://127.0.0.1:4173/person/robert-todd-lincoln \
     http://127.0.0.1:4173/place/springfield-illinois \
     http://127.0.0.1:4173/place/hingham-massachusetts
   ```
   Re-run the same URL list with `--viewport 390x844`.
   Expected target counts across both viewports:
   - `side-tab`: `0` (down from 105)
   - `nested-cards`: `0` (down from 10)
   - `line-length`: `0` (down from 5)
   - `tiny-text`: `0` (down from 2)
   - `cramped-padding`: `0` (down from 2)
   - `cream-palette`: `0` (waived in `.impeccable/config.json` with documented Cotton Rag justification)
   - Total primary findings: `0` (exit code `0`)

3. **Foundations check:**
   ```bash
   impeccable foundations . --json
   impeccable foundations examples/demo --json
   ```
   Expected improvements: `no-generic-ai-patterns` flips from `failing` to `checked` at repo root and `packages/ui`. In `examples/demo`, `not-found-page` flips to `checked`. If Wave 51B includes L-3, then `dependency-scanning`, `app-icons`, and `social-previews` also flip to `checked`.

### Playwright regression assertions (`e2e/ux-regression.spec.ts`)

Add assertions covering every Wave 51B fix across desktop (`1280x800`) and mobile (`390x844`):

1. **No side-tab stripe or nested card chrome on Family Tree List View (`/tree?surface=roll`):**
   - For every `.tree-roll-unit.is-direct`, computed `borderLeftWidth` equals computed `borderRightWidth` (no asymmetric 4px side stripe) and `borderRadius` equals `4px`.
   - For every `.tree-early-strip`, computed `borderTopWidth` equals `0px` and computed `backgroundColor` is `rgba(0, 0, 0, 0)`.
2. **Editorial line measure on `/`, `/changes`, and `/person/abraham-lincoln-1809` at `1280x800`:**
   - `.index-banner p`, `.wire-banner p`, and `.story-card p` computed `maxWidth` is not `none` and rendered box width stays `<= 620px`, keeping rendered character count per line below `80`.
3. **Survey map text legibility on `/place/springfield-illinois` and `/place/hingham-massachusetts` at `390x844`:**
   - Every visible `<text>` inside `.local-survey-svg` (excluding `aria-hidden="true"` compass `N`) renders at an effective CSS font size `>= 12px` after SVG viewBox scaling, and `.local-survey-caption` is visible with computed `fontSize >= 12px`.
4. **Source Discrepancy pill clearance on `/person/abraham-lincoln-1809` and `/evidence` at `390x844` and `1280x800`:**
   - Every visible `.conflict-pill` has computed `paddingTop >= 4px` and `paddingBottom >= 4px`.
5. **Not Found route (`/does-not-exist`):**
   - Renders a visible heading indicating the page was not found (does not silently redirect to `/`) and provides working links back to `/` and `/tree`.
6. **Existing repository gates:**
   - `npm run check` (`lint`, `build`, `typecheck`, `test`, `check:contrast`, `check:leaks`) passes with exit code `0`.
   - `npm run test:e2e` passes with `0` failures.
