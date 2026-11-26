# Wave 50 mobile and desktop UX audit specification

Date: 2026-11-26
Baseline commit: `6b80c31` (Wave 49)
Audit dataset: Public demo archive in `examples/demo` (`Lincoln & Todd Historical Archive`)
Viewports audited: `360x800` (small phone), `390x844` (standard phone), `768x1024` (tablet portrait), and `1280x800` (desktop)
Method: Real Chromium Playwright DOM measurement plus direct visual inspection of rendered screenshots across static reader routes and mocked HTTP wiki/auth states.

## 1. Executive summary

Measured across all four viewports, five UX defects cause the highest friction for mobile, tablet, and desktop readers:

1. **Family Tree toolbar breaks on tablet (`768x1024`) and hides core switches on phone (`360x800` and `390x844`).** At `768x1024`, `ExplorerTopBar` wraps to two rows (`89px` tall) while `--topbar-height` remains `58px`. The header overlaps the top half of `.tree-toolbar-shell` (`top: 66px`), and `.tree-toolbar` overflows the document horizontally by `+23px`, slicing off the **Chart** button. At `360x800` and `390x844`, `.tree-toolbar` packs `594px` of controls into a `338px` or `368px` pill with no scroll affordance, pushing **Full Tree**, **List**, and **Chart** off-screen while cards scroll behind the rounded pill corners.
2. **Place Profile occupancy bars clip residency dates down to single digits across every viewport.** In **Who Passed Through** on `/place/hingham-massachusetts`, `.occupancy-bar` clamps short spans to `14px` through `67px` wide with `overflow: hidden`. Dates such as `1650`, `1685-1688`, and `1860` render as `"1"`, `"165"`, and `"1688-17"` on both `360x800` and `1280x800`, and the clickable bars shrink to `14px x 19px`.
3. **Persistent narrative audio dock covers slide-over drawers and shrinks touch controls below 44px.** Both `.narrative-audio-dock` (`z-index: 60`) and `.drawer-backdrop` (`z-index: 60`) share the same stacking layer, and `<PluginSlot name="appShell" />` mounts after `<Routes>` in `KinloomApp.tsx`. When narration plays, the bottom dock (`136px` tall on `360x800`, `67px` tall on `1280x800`) paints over `EntityEditDrawer`, `SourceReaderDrawer`, and `SourceInspectorDrawer`, blocking bottom form controls. Every button inside the dock measures `27px` to `38px` tall. Clicking **Edit** beside a person's pronunciation opens `EntityEditDrawer` at the top of the form so the **Pronunciation** fieldset sits off-screen on mobile.
4. **Time year scrubber and high-frequency reader controls fail the 44px touch-target floor.** On `/time`, `input.ink-range-slider` renders at `243.8px x 2px` (`height: 2px`), forcing phone users to hit a 2px track unless they grab the 16px thumb directly. Other core interactive controls measure under 44px on `360x800` and `390x844`: topbar nav pills (`26.1px x 36px` for **Tree**, `38.7px x 36px` for **Places**), topbar icon buttons (`36px x 36px`), pronunciation speaker buttons (`24px x 24px`), inline citation triggers (`28.8px x 16.7px`), Evidence action buttons (`22px` to `25.6px` tall), and `NarrativeAudioMarginBar` buttons (`34px x 34px` play, `34.3px x 38px` speed).
5. **Navigation leaves core pages orphaned, Map toolbar bloats on every width, and ubiquitous-language drift remains.** Neither `ExplorerTopBar` nor `KinloomFooter` links to **Kinship Finder** (`/kinship`) or **Evidence & Sources** (`/evidence`), and the mobile **Archive menu** shows only a single **Sources** item when signed out. On `/map`, `.map-toolbar` stretches to `1,704px` inside a `342px` strip on `360x800` and wraps into four stacked rows (`~175px`) on `1280x800`. Across `packages/ui/src/`, deprecated terms from `docs/ubiquitous-language.md` still appear in UI copy, aria announcements, tooltips, and labels, alongside a `3.27:1` contrast failure on `.tree-focus-crumb-sep` and raw `ApiClientError: HTTP 404 Not Found` strings on load failures.

## 2. Viewport audit matrix

Each cell reports measured values in the format `ov / s44 / clip / con / dep`:

- `ov`: Document horizontal overflow in pixels (`documentElement.scrollWidth - innerWidth`).
- `s44`: Visible interactive controls with width under `44px` or height under `44px`.
- `clip`: Visible text-bearing elements clipped by `overflow: hidden` (`scrollWidth > clientWidth + 3`).
- `con`: Visible leaf text elements below WCAG 2.1 AA contrast (`4.5:1` normal, `3.0:1` large).
- `dep`: Visible DOM text hits against deprecated terms in `docs/ubiquitous-language.md` (note that `01_people_index` and drawers opened from `/` also inherit `Spouses & Collateral Siblings` from `examples/demo/data/kinloom.config.yaml`).

| Surface (Route or State) | 360x800 | 390x844 | 768x1024 | 1280x800 | Key visual and DOM observations |
| --- | --- | --- | --- | --- | --- |
| People Index (`/`) | `0 / 11 / 0 / 0 / 1` | `0 / 11 / 0 / 0 / 1` | `0 / 11 / 0 / 0 / 1` | `0 / 11 / 0 / 0 / 1` | Filter buttons lack button borders on mobile; topbar wraps to 2 rows (`89px`) at `768px`. |
| Tree List Default (`/tree`, Direct Line on phone, Chart on tablet/desktop) | `0 / 8 / 0 / 0 / 0` | `0 / 8 / 0 / 0 / 0` | `0 / 71 / 0 / 0 / 0` | `0 / 71 / 0 / 0 / 0` | Phone `.tree-toolbar` scrolls `594px` in `338px` (`Full Tree`, `List`, `Chart` hidden); `.tree-gen-jump-bar` scrolls `498px` in `340px` with `G7` cut in half. |
| Tree List Full + Focus Drawer (`/tree`, List + Full Tree + Abraham Lincoln (1688)) | `0 / 8 / 0 / 2 / 0` | `0 / 8 / 0 / 2 / 0` | `23 / 31 / 0 / 2 / 0` | `0 / 31 / 0 / 2 / 0` | `+23px` horizontal overflow at `768x1024` with wrapped topbar slicing `.tree-toolbar` in half; `.tree-focus-crumb-sep` contrast measures `3.27:1` across all 4 viewports. |
| Tree Find Person (`/tree`, search open) | `0 / 8 / 0 / 0 / 0` | `0 / 8 / 0 / 0 / 0` | `0 / 82 / 0 / 0 / 0` | `0 / 82 / 0 / 0 / 0` | Cards peek between topbar and rounded floating toolbar on phone; results list is legible and has 44px rows on mobile. |
| Tree Chart View (`/tree`, clicked **Chart**) | `0 / 56 / 0 / 0 / 0` | `0 / 56 / 0 / 0 / 0` | `0 / 71 / 0 / 0 / 0` | `0 / 71 / 0 / 0 / 0` | `/tree?surface=diagram` is ignored on load; on `360x800` left generation bands (`G1` to `G10`) clip at the left edge and fit-zoom cards shrink to unreadable text. |
| Person Profile Full Pronunciation (`/person/abraham-lincoln-1809`) | `0 / 123 / 0 / 0 / 0` | `0 / 124 / 0 / 0 / 0` | `0 / 133 / 0 / 0 / 0` | `0 / 133 / 0 / 0 / 0` | Portrait header crowds pronunciation onto 3 wrapped lines on `360px`; Residences chip splits place and dates across a wide gap; `NarrativeAudioMarginBar` wraps time (`0:00 /` and `1:21`); speaker icons are `24x24px`. |
| Person Profile Partial/Surname Pronunciation (`/person/robert-todd-lincoln`) | `0 / 67 / 0 / 0 / 0` | `0 / 67 / 0 / 0 / 0` | `0 / 76 / 0 / 0 / 0` | `0 / 76 / 0 / 0 / 0` | `Surname: LING-kun` prefix renders cleanly, but `24x24px` speaker button and `15px`-tall Wiktionary source link are undersized for touch. |
| Person Profile Gallery + Inline Citation Popover (`/person/abraham-lincoln-1809`) | `0 / 126 / 0 / 0 / 0` | `0 / 127 / 0 / 0 / 0` | `0 / 136 / 0 / 0 / 0` | `0 / 136 / 0 / 0 / 0` | Popover card reads well, but `[1]` trigger is `28.8x16.7px` and timeline `.scrubber-list` scrolls `503px` in `360px` with no scroll cue. |
| Places Index (`/places`) | `0 / 180 / 0 / 0 / 0` | `0 / 180 / 0 / 0 / 0` | `0 / 187 / 0 / 0 / 0` | `0 / 187 / 0 / 0 / 0` | Era filters stack into 5 vertical rows (`~260px`) above the search box, look borderless when inactive, and show empty `Washington & New England (0)`; resident links are `25.9px` tall. |
| Place Profile (`/place/hingham-massachusetts`) | `0 / 31 / 6 / 0 / 0` | `0 / 31 / 6 / 0 / 0` | `0 / 36 / 5 / 0 / 0` | `0 / 36 / 5 / 0 / 0` | 5 to 6 `.occupancy-bar` buttons clip year ranges to `"1"` or `"165"`; `LocalSurveyMap` SVG shrinks text to `~4.2px` on `360px` and overlaps a green neighbor pin on top of `15-mi radius · 2 inside` even at `1280px`. |
| Migration Map (`/map` and `/map?place=springfield-illinois`) | `0 / 11 / 0 / 0 / 0` | `0 / 11 / 0 / 0 / 0` | `0 / 28 / 0 / 0 / 0` | `0 / 28 / 0 / 0 / 0` | Mobile `.map-toolbar` scrolls `1,704px` in `342px`; desktop toolbar wraps into 4 rows (`~175px`); rightmost pin label clips off canvas; expanded bottom drawer covers selected pin on `360px`; drag handle shows even when no stop is selected. |
| Time (`/time` and mobile Jump sheet) | `0 / 14 / 0 / 0 / 0` | `0 / 14 / 0 / 0 / 0` | `0 / 26 / 0 / 0 / 0` | `0 / 26 / 0 / 0 / 0` | `input.ink-range-slider` measures `243.8x2px` on mobile; desktop single-resident lanes squeeze cards to `~270px` via `auto-fill`; milestone tooltip uses deprecated `living relatives`. |
| Kinship Finder (`/kinship`) | `0 / 13 / 0 / 0 / 0` | `0 / 13 / 0 / 0 / 0` | `0 / 19 / 0 / 0 / 0` | `0 / 19 / 0 / 0 / 0` | Orphaned route with zero nav links; 6 vertical preset text lines push **Person B** off-screen on `360x800`; double parenthesized years (`(1744) (1744-1786)`); uses deprecated `community match`. |
| Evidence & Sources (`/evidence`, 3 tabs + Inspector) | `0 / 61 / 0 / 0 / 2` | `0 / 64 / 0 / 0 / 2` | `0 / 78 / 0 / 0 / 2` | `0 / 78 / 0 / 0 / 2` | `1 entries needing citation` grammar error; tabs stack into 3 borderless rows on phone; `Inspect Source` (`24px` tall) and `Open Archive` (`25.6px` tall) fail touch targets; uses `Unverified` and `Archival Media` copy. |
| Source Reader Drawer (open from **Sources**) | `0 / 11 / 0 / 0 / 1` | `0 / 11 / 0 / 0 / 1` | `0 / 23 / 0 / 0 / 1` | `0 / 23 / 0 / 0 / 1` | Long 5th document tab wraps and center-aligns while siblings left-align; header + tabs + download + pager + search consume `~410px` (`>50%` height) before transcription begins. |
| Global Search Modal (`Search`) | `0 / 13 / 0 / 0 / 1` | `0 / 13 / 0 / 0 / 1` | `0 / 13 / 0 / 0 / 1` | `0 / 13 / 0 / 0 / 1` | Input measures `22px` tall; shows desktop `Esc` label and keyboard footer (`↑↓ navigate`) on touch phones; empty prompt uses deprecated `PRIMARY ARCHIVAL SOURCE PAGES`. |
| Mobile Archive Menu (`<= 768px`) | `0 / 11 / 0 / 0 / 1` | `0 / 11 / 0 / 0 / 1` | `0 / 11 / 0 / 0 / 1` | `n/a` | Floating menu holds only one item (**Sources**) when signed out and omits **Evidence & Sources** and **Kinship Finder**. |
| Auth Gate, Sign-In Modal, & Editor Drawer (mocked HTTP mode) | `0 / 9 / 1 / 0 / 0` | `n/a` | `n/a` | `0 / 10 / 0 / 0 / 0` | Private gate and Sign-In modal have 0 overflow and clean 44px form controls; signed-in `360px` header clips `brand-link` (`229px` in `244px`); `NarrativeAudioDock` (`z-index: 60`) paints over `EntityEditDrawer` (`z-index: 60`); raw `ApiClientError` text leaks on 404. |

## 3. Prioritized Wave 50B implementation plan

### P0: Must fix first (layout breakage, clipping, and modal blocking)

#### P0-1. Fix tablet `768px` topbar collision and mobile Family Tree toolbar overflow

- **Files:** `packages/ui/src/styles/archival.css` (lines 77-96, 1936-1970, 4755-4860, 5512-5580), `packages/ui/src/components/tree/TreeToolbar.tsx`, `packages/ui/src/pages/TreePage.tsx` (lines 59-72).
- **Defect observed:**
  - At `768x1024`, `.topbar` does not hit `@media (max-width: 767px)` so it renders desktop controls that wrap onto two rows (`89px` tall) while `--topbar-height` remains `58px`. `.tree-page-roll .tree-toolbar-shell` sticks at `top: calc(var(--topbar-height) + 8px)` (`66px`), so the topbar covers the upper half of the toolbar. Because `.tree-toolbar` keeps `flex-wrap: nowrap; overflow: visible` above `767px`, it overflows the viewport horizontally by `+23px` and cuts off **Chart**.
  - At `360x800` and `390x844`, `.tree-toolbar` measures `scrollWidth: 594px` inside `clientWidth: 338px` (`360px` viewport). **Full Tree**, **List**, and **Chart** disappear off the right edge with no visual indicator, and tree cards scroll visibly through the gap above the rounded pill corners.
  - Navigating to `/tree?surface=diagram` or `/tree?surface=roll` ignores the query parameter.
- **Proposed fix:**
  - Raise the mobile/compact topbar breakpoint (or add a dedicated tablet `@media (max-width: 900px)` rule) so `.topbar` never wraps onto two unmeasured rows at `768px`. Alternatively, align `.topbar` compact mode to `<= 820px` and keep `--topbar-height` synchronized with actual header height.
  - On viewports `<= 768px`, replace the single-row scrolling pill `.tree-toolbar` with a full-width sticky solid-backdrop two-row bar (edge-to-edge cotton paper background with bottom hairline so cards never peek above rounded corners). Row 1 holds the **Find person** button, the branch `<select>`, and the **List | Chart** segmented toggle. Row 2 holds **Direct Line | Full Tree (N)** (plus **+ Add Person** when `canEdit`). Keep every button at `min-height: 44px`.
  - Parse `?surface=diagram|roll` and `?mode=spine|full` in `TreePage.tsx` initial state so deep links and tests open the requested view directly.
- **Playwright acceptance assertions:**
  - At `768x1024`, `390x844`, and `360x800` on `/tree` (both List and Chart): `document.documentElement.scrollWidth <= window.innerWidth` (`0` overflow).
  - At `768x1024`, `390x844`, and `360x800`: `.tree-toolbar` `getBoundingClientRect().top >= header.getBoundingClientRect().bottom` (zero overlap with topbar).
  - At `360x800`, `390x844`, `768x1024`, and `1280x800`: **Find person**, branch selector, **Direct Line**, **Full Tree**, **List**, and **Chart** buttons are all visible within `[0, window.innerWidth]` without horizontal scrolling, and each has `height >= 44` on `<= 768px`.

#### P0-2. Fix clipped residency date bars in Place Profile "Who Passed Through"

- **Files:** `packages/ui/src/pages/PlacePage.tsx` (lines 417-447), `packages/ui/src/styles/archival.css` (lines 1717-1768).
- **Defect observed:**
  - On `/place/hingham-massachusetts`, `.occupancy-bar` puts the date text inside a proportionally sized button (`width: ${widthPct}%`, `overflow: hidden`, `height: 19px`).
  - Measured clipping: `clientW: 14px` vs `scrollW: 43px` (`1650`, `1860`) and `clientW: 14px` vs `scrollW: 80px` (`1685-1688`) at `360x800` and `390x844`, and `clientW: 14px` to `67px` vs `scrollW: 43px` to `80px` at `768x1024` and `1280x800`. Readers see `"1"`, `"165"`, or `"1688-17"`.
- **Proposed fix:**
  - Move the human-readable year span label (`1685-1688`) out of the clipped bar into a dedicated non-clipped label paired with the person name (for example, `Sarah Jones` with a right-aligned monospace `1685-1688` badge on the row header or trailing column), and render the proportional bar purely as a visual timeline indicator inside a full-row clickable link or `min-height: 44px` track button with `aria-label="Jump to Sarah Jones (1685-1688)"`.
  - Keep a minimum visible bar width (`min-width: 10px`) for single-year events so the dot/bar stays clear without carrying clipped text inside it.
- **Playwright acceptance assertions:**
  - Across `360x800`, `390x844`, `768x1024`, and `1280x800` on `/place/hingham-massachusetts`: zero `.occupancy-row` elements or children report `scrollWidth > clientWidth + 2`.
  - Full year labels (`1650`, `1685-1688`, `1860`) are visibly readable in the DOM with non-zero bounding boxes, and each interactive occupancy row control has `height >= 44` on `360x800` and `390x844`.

#### P0-3. Fix stacking collision between `NarrativeAudioDock` and drawers/modals, plus inline pronunciation edit jump

- **Files:** `packages/ui/src/styles/archival.css` (lines 1573-1578, 7938-8085), `packages/ui/src/pages/PersonPage.tsx` (lines 589-612, 1197-1224), `packages/ui/src/pages/PlacePage.tsx` (lines 271-295, 517-542), `packages/ui/src/components/wiki/EntityEditDrawer.tsx` (lines 16-27, 815-920, 1040-1055).
- **Defect observed:**
  - `.narrative-audio-dock` and `.drawer-backdrop` both declare `z-index: 60`. Because `<PluginSlot name="appShell" />` renders after page routes in `KinloomApp.tsx`, the active audio dock (`136px` tall on `360x800`, `67px` tall on `1280x800`) floats over `EntityEditDrawer`, `SourceReaderDrawer`, `SourceInspectorDrawer`, and `SignInModal`.
  - Clicking **Edit** beside a Person or Place pronunciation opens `EntityEditDrawer` scrolled to the top (`Full name`), hiding the **Pronunciation** fieldset below the fold on `360x800`.
  - Inside `EntityEditDrawer`, the pronunciation preview omits the resolved given-name pronunciation (`FIRST Abraham` shows no respelling even when `Abraham` exists in `pronunciations`) and labels the respelling input `Phonetic guide` instead of `Respelling`.
- **Proposed fix:**
  - Lower `.narrative-audio-dock` to `z-index: 45` (above page content and sticky headers at `z-index: 40`, strictly below `.drawer-backdrop` and `.lightbox-backdrop` at `z-index: 60`).
  - Add an optional `initialSection?: 'pronunciation'` prop to `EntityEditDrawer` so clicking **Edit** or **+ Add pronunciation** scrolls the **Pronunciation** `<fieldset>` into view and focuses its first input on open.
  - Display resolved given-name lexicon entries alongside surname entries inside the drawer preview, and rename `Phonetic guide` to `Respelling` to match `docs/ubiquitous-language.md`.
  - On `360x800` and `390x844`, compact `.narrative-audio-dock` to two tight lines (keep time on the same line with `white-space: nowrap`, cap dock height under `104px`) and raise all dock buttons (`.narrative-audio-dock-play`, `.narrative-audio-dock-btn`, `.narrative-audio-dock-dismiss`) to `min-width: 44px; min-height: 44px`.
- **Playwright acceptance assertions:**
  - With narration playing and `EntityEditDrawer` open at `360x800` and `1280x800`: computed `zIndex` of `.drawer-backdrop` exceeds computed `zIndex` of `.narrative-audio-dock`, and `document.elementFromPoint(...)` over the drawer's Save button hits the Save button (not the audio dock).
  - Clicking `Edit pronunciation` scrolls the `Pronunciation` fieldset into the drawer viewport on `360x800`.
  - All buttons inside `[data-testid="narrative-audio-dock"]` measure `>= 44x44px` on `360x800`.

#### P0-4. Fix 2px Time range slider and bring core mobile touch targets up to 44px

- **Files:** `packages/ui/src/styles/archival.css` (lines 1092-1122, 4327-4350, 4671-4695, 4798-4860, 7767-7835, 8152-8180), `packages/ui/src/components/GlobalSearchModal.tsx` (lines 158-172).
- **Defect observed:**
  - On `/time`, `input.ink-range-slider` has `height: 2px` (`243.8px x 2px` bounding box on `360x800`).
  - On `360x800` and `390x844`: `.nav-pill` measures `26.1px x 36px` (**Tree**) to `41.1px x 36px` (**People**); `.topbar-mobile-icon-btn` is `36px x 36px` (even with `::after`, visual and bounding box fail 44px); `.pronunciation-play-btn` is `24px x 24px`; `.narrative-audio-play-btn` is `34px x 34px`; `.narrative-audio-pill` is `34.3px x 38px`; `.source-action-btn` is `24px` tall; `.source-read-btn` is `22px` to `25.6px` tall; `.archival-footnote-ref` is `28.8px x 16.7px`; `.global-search-input` is `22px` tall.
- **Proposed fix:**
  - Style `input.ink-range-slider` with `height: 44px; background: transparent;` and draw the 2px ink line via `::-webkit-slider-runnable-track` / `::-moz-range-track` (with a `22px x 22px` thumb on mobile), giving a full 44px vertical touch target without changing the thin-rule aesthetic.
  - On `@media (max-width: 767px)`:
    - Raise `.nav-pill` to `min-height: 44px; min-width: 44px; justify-content: center;` and `.topbar-mobile-icon-btn` to `width: 44px; height: 44px;`.
    - Give `.pronunciation-play-btn` a `min-width: 44px; min-height: 44px;` hit box (keeping the 24px circular icon centered inside, or using `padding: 10px; margin: -10px -6px -10px -10px` on non-inline header badges).
    - Raise `.narrative-audio-play-btn` to `44px x 44px` and `.narrative-audio-pill` to `min-height: 44px; min-width: 44px;`.
    - Raise `.source-action-btn`, `.source-read-btn`, `.source-toggle`, `.person-biography-toggle`, `.person-biography-sources-toggle`, and `.global-search-input` to `min-height: 44px`.
    - Expand `.archival-footnote-ref` touch padding vertically (`padding: 8px 6px; margin: -8px 0`) on coarse pointers (`@media (pointer: coarse)`) so superscripts stay visually compact while offering a taller tap area.
- **Playwright acceptance assertions:**
  - On `/time` at `360x800` and `390x844`: `input.ink-range-slider` `height >= 44`.
  - On `/`, `/person/abraham-lincoln-1809`, `/evidence`, and Global Search at `360x800`: `.nav-pill`, `.topbar-mobile-icon-btn`, `.pronunciation-play-btn` (header), `.narrative-audio-play-btn`, `.source-action-btn`, and `.global-search-input` all measure `height >= 44` (and `width >= 44` for icon/compact buttons).

### P1: High-impact ergonomics, hierarchy, and ubiquitous-language fixes

#### P1-1. Make Evidence & Sources and Kinship Finder discoverable in navigation and enrich mobile Archive menu

- **Files:** `packages/ui/src/components/ExplorerTopBar.tsx` (lines 86-157, 240-330), `packages/ui/src/lib/vocabulary.ts` (lines 37-54), `packages/ui/src/styles/archival.css` (lines 4774-4797).
- **Defect observed:**
  - Zero links in `ExplorerTopBar` or `KinloomFooter` navigate to `/kinship`, and only a deep link inside `SourceInspectorDrawer` points to `/evidence`.
  - On signed-out mobile (`360x800`, `390x844`, `768x1024`), opening **Archive menu** renders an almost empty box containing a single **Sources** item.
  - When signed in on `360x800`, `a.brand-link` clips `"Lincoln & Todd Historical Arc..."` (`229px` in `244px`).
- **Proposed fix:**
  - Add **Kinship** (`/kinship`) and **Evidence** (`/evidence`) links inside the **Archive menu** dropdown (and expose a desktop **More** or secondary nav entry so readers can reach both **Evidence & Sources** and **Kinship Finder** in one or two clicks from every page).
  - Keep **Sources** (opening Source Reader) in the mobile menu alongside **Evidence & Sources** and **Kinship Finder**, so the mobile drawer is never a single-item popover.
  - Reduce `.brand-link` font-size slightly (`0.88rem`) at `<= 390px` when `.topbar-account-btn` is present, or shorten the mobile account button padding so the site title stays readable without premature ellipsis.
- **Playwright acceptance assertions:**
  - From `/` at `360x800` and `1280x800`, a reader can navigate to `/evidence` and `/kinship` using only visible navigation controls without typing a URL.
  - Opening **Archive menu** at `360x800` shows at least 3 actionable items (**Sources**, **Evidence & Sources**, **Kinship Finder**).

#### P1-2. Redesign Migration Map toolbar and mobile stop drawer ergonomics

- **Files:** `packages/ui/src/pages/MapPage.tsx` (lines 114-135, 1054-1290), `packages/ui/src/styles/archival.css` (lines 3143-3280, 5647-5715).
- **Defect observed:**
  - On `360x800`, `.map-toolbar` scrolls `1,704px` inside `342px`, clipping era names mid-word and burying **By person** / **Chronological** off-screen.
  - On `1280x800`, `.map-toolbar` wraps into 4 stacked rows (`~175px`), leaving less vertical space for the map canvas; the rightmost stop label (`1622 · Hingham (Norfolk)`) clips off the right viewport edge.
  - `div.map-drawer-handle` renders even when `selectedStop` is null (nothing to expand).
  - On `360x800`, expanding **Details** covers the selected Springfield map pin, and `.map-style-note` ("Showing offline paper basemap.") sits directly over the route curves at `top: 38%`.
- **Proposed fix:**
  - On `<= 767px`, replace the 1,704px horizontal era strip with two compact dropdowns side-by-side (`Person` select + `Era` select) plus a compact route-mode toggle chip, eliminating horizontal scrolling completely.
  - On `>= 768px`, collapse era filters into a single-row scrollable strip with right-edge fade or a compact `<select>` so `.map-toolbar` stays one row (`<= 56px` tall).
  - Render `.map-drawer-handle` only when `selectedStop !== null`.
  - Move `.map-style-note` to a quiet bottom-left or top-left status badge (`top: 64px; left: 12px; transform: none; font-size: 0.78rem`) instead of floating across the center of the map.
  - Increase right-side `getFitOptions` padding (`right: 110` on desktop, `right: 76` on mobile) and increase `bottom` padding when `drawerExpanded` is true so pin labels and the selected pin stay inside the visible map frame.
- **Playwright acceptance assertions:**
  - On `/map` at `360x800`: `.map-toolbar` `scrollWidth <= clientWidth + 2`, and `.map-drawer-handle` has count `0` when no stop is selected.
  - On `/map` at `1280x800`: `.map-toolbar` height is `<= 64px`.
  - On `/map?place=springfield-illinois` at `360x800`: clicking **Details** keeps the selected pin marker above the bottom dock (`pinY < dockRect.top`).

#### P1-3. Polish Person Profile mobile header, Residences wrapping, Audio Margin Bar, and Gallery hierarchy

- **Files:** `packages/ui/src/pages/PersonPage.tsx` (lines 542-781), `packages/ui/src/plugins/narrativeAudioPlugin.tsx` (lines 355-430), `packages/ui/src/styles/archival.css` (lines 4664-4700, 7750-7835, 8120-8200).
- **Defect observed:**
  - On `360x800`, the flex row holding the `76px` portrait next to `<h1>`, pronunciation guide, dates, and branch badge squeezes text into `~230px`, wrapping the pronunciation badge into 3 lines and vertically misaligning the portrait.
  - Inside **Residences**, `.person-family-chip` uses `display: inline-flex; align-items: baseline`, which splits `Little Pigeon Creek` into a 2-line left flex item and `(1816-1820 · Inferred)` into a 2-line right flex item with a wide blank gap between them.
  - Inside `NarrativeAudioMarginBar`, `.narrative-audio-time` wraps `0:00 /` onto two lines (`0:00 /` and `1:21`) on both `360x800` and `1280x800`, and on `1280x800` the bar stops at ~50% width instead of aligning to the biography column width.
  - **Export GEDCOM** looks like unstyled plain text next to underlined **Their route**.
- **Proposed fix:**
  - On `<= 480px`, align the portrait to `align-items: flex-start` next to `<h1>` and vital dates, and move `.person-pronunciation-row` directly beneath the portrait+name header across full width so respelling, IPA, and source attribution sit cleanly on 1 to 2 lines.
  - Change `.person-family-chip` from `display: inline-flex` to `display: inline` (with `padding: 4px 0` or `line-height: 1.8`) so long place names and date spans flow inline without splitting into two awkward flex columns.
  - Add `white-space: nowrap; flex-shrink: 0;` to `.narrative-audio-time`, remove the `50%` width squeeze on desktop so `.narrative-audio-margin-bar` matches `.person-biography-body` (`max-width: 65ch`), and keep voice label + time on one row.
  - Give secondary action buttons (**Export GEDCOM**, **Photos & Documents (22)** filter toggle on `/`, and tab pills on `/places` and `/evidence`) subtle bordered pill affordances (`border: 1px solid var(--border-control); border-radius: 4px; padding: 6px 12px;`) so readers immediately distinguish interactive buttons from static text.
- **Playwright acceptance assertions:**
  - On `/person/abraham-lincoln-1809` at `360x800` and `1280x800`: `.narrative-audio-time` renders on a single line (`height <= 22px`).
  - On `/person/abraham-lincoln-1809` at `360x800`: `.person-pronunciation-row` width is `>= 300px` (full content width rather than squeezed beside portrait).
  - `.person-family-chip` for `Little Pigeon Creek` uses inline text flow with zero inner flex column gap.

#### P1-4. Fix `TreeFocusDrawer` breadcrumb contrast and `LocalSurveyMap` mobile legibility

- **Files:** `packages/ui/src/styles/archival.css` (lines 2349-2351), `packages/ui/src/components/LocalSurveyMap.tsx` (lines 22-112, 211-246).
- **Defect observed:**
  - `.tree-focus-crumb-sep` (`›`) uses `color: var(--border-control)` (`rgb(130, 122, 106)`) on `--surface-linen` (`rgb(234, 225, 206)`), measuring `3.27:1` contrast across all 4 viewports (fails WCAG AA `4.5:1`).
  - `LocalSurveyMap` uses a fixed `720x200` `viewBox`, shrinking SVG text to `~4.2px` on `360x800` phones, and places a neighbor marker (`Scituate`) directly over the center `15-mi radius · 2 inside` caption at `1280x800`.
- **Proposed fix:**
  - Change `.tree-focus-crumb-sep` color to `var(--text-secondary)` (`>= 6.5:1` contrast on `--surface-linen`).
  - In `LocalSurveyMap.tsx`, reserve a padded collision box around the center label (`x1: cx - 16, x2: cx + 195, y1: cy - 22, y2: cy + 24`) and render a subtle `#F4EFE3` halo (`paintOrder: 'stroke'`, `stroke: '#F4EFE3'`, `strokeWidth: 4`) behind center and neighbor text labels so pins never obscure text.
  - On narrow containers (`<= 480px`), switch `LocalSurveyMap` to a taller `viewBox="0 0 360 190"` (or `compact` aspect ratio with legible `11px` SVG labels) plus a crisp neighbor list chip strip beneath the SVG for accessible 44px tap targets.
- **Playwright acceptance assertions:**
  - On `/tree` with `TreeFocusDrawer` open: `.tree-focus-crumb-sep` computed WCAG contrast ratio is `>= 4.5`.
  - On `/place/hingham-massachusetts` at `360x800`: rendered SVG center label height is `>= 10px` on screen, and nearby places are reachable via `>= 44px` links.

#### P1-5. Close remaining ubiquitous-language mismatches, grammar bugs, and raw error leaks

- **Files:**
  - `packages/ui/src/pages/TimePage.tsx` (lines 251, 386)
  - `packages/ui/src/pages/IndexPage.tsx` (line 277)
  - `packages/ui/src/pages/TreePage.tsx` (lines 519, 522)
  - `packages/ui/src/pages/PersonPage.tsx` (lines 466, 520)
  - `packages/ui/src/pages/KinshipPage.tsx` (line 209)
  - `packages/ui/src/pages/EvidencePage.tsx` (lines 244, 461, 539-540, 666)
  - `packages/ui/src/components/Atoms.tsx` (lines 385, 390, 395, 409, 422, 515, 656)
  - `packages/ui/src/components/MediaPlayer.tsx` (line 122)
  - `packages/ui/src/components/GlobalSearchModal.tsx` (lines 169-171, 220, 248)
  - `packages/ui/src/components/wiki/EntityEditDrawer.tsx` (lines 742, 915, 1042)
- **Defects observed:**
  - `TimePage.tsx:251`: tooltip reads `living relatives` for a historical year (canonical: `alive in ${m.year}`); line 386 reads `No archived relatives` instead of `KINLOOM_VOCABULARY.time.emptyStatePrefix`.
  - `IndexPage.tsx:277`: reads `No archived relatives match the active filters.` (canonical: `No people match the active filters.`).
  - `TreePage.tsx:519,522`: screen-reader announcements say `Collapsed/Expanded collateral siblings.` (canonical: `sibling group` / `siblings`).
  - `PersonPage.tsx:466`: GEDCOM header says `Individual dossier:` (canonical: `Person Profile:`).
  - `PersonPage.tsx:520`: displays raw `error` string (`ApiClientError: HTTP 404 Not Found`) directly to readers on fetch error.
  - `KinshipPage.tsx:209`: reads `community match` (canonical: `shared place`).
  - `EvidencePage.tsx:244`: renders `1 entries needing citation` (singular/plural bug); line 461 says `Open Reader →` instead of `KINLOOM_VOCABULARY.sources.openReaderCta`; lines 539-540 say `Unverified Entries` (canonical: `Entries Needing Citation`); line 666 says `Archival Media Entries` (canonical: `Photos & Documents Entries`).
  - `Atoms.tsx:385,390,395`: pills say `Date Conflict` / `Place Conflict` / `Fact Conflict` while expanded box says `Preserved Date Discrepancies` (canonical: `Date Discrepancy` / `Place Discrepancy` / `Fact Discrepancy`); line 409 says `Read Primary Text →` (canonical: `KINLOOM_VOCABULARY.sources.readSourceCta`); lines 422, 515, 656 say `Primary Record Scan` (canonical: `Record Scan`).
  - `MediaPlayer.tsx:122`: says `Audio Oral History` (canonical: `Oral History`).
  - `GlobalSearchModal.tsx:220`: says `PRIMARY ARCHIVAL SOURCE PAGES` (canonical: `SOURCE PAGES`); line 170 shows `Esc` on mobile instead of `Close` and shows keyboard-only hints on touch devices.
  - `EntityEditDrawer.tsx:915,1042`: says `Phonetic guide` (canonical: `Respelling`).
- **Proposed fix:**
  - Update every string above to pull from `KINLOOM_VOCABULARY` or match `docs/ubiquitous-language.md`.
  - Fix pluralization on `EvidencePage.tsx:244` (`entry` vs `entries`).
  - Format fetch errors in `PersonPage.tsx`, `PlacePage.tsx`, `IndexPage.tsx`, and `TimePage.tsx` through a friendly reader message helper that strips `ApiClientError:` prefixes and offers a **Try again** action.
  - Change Global Search close button label to `Close` on `<= 767px` and hide the desktop keyboard shortcut hint (`↑↓ navigate · Enter open · Esc close`) on touch viewports.
- **Playwright acceptance assertions:**
  - Across `/`, `/tree`, `/person/abraham-lincoln-1809`, `/places`, `/place/hingham-massachusetts`, `/time`, `/kinship`, `/evidence`, Source Reader, and Global Search: zero visible matches for deprecated terms (`Dossier`, `Collateral`, `Unverified`, `Archival Media`, `Audio Oral History`, `Primary Record Scan`, `Read Primary Text`, `Date Conflict`, `living relatives` on `/time`, `archived relatives`).
  - On `/evidence`, count `1` renders `1 entry needing citation`.

### P2: Visual polish and scanning ergonomics

#### P2-1. Compact Places Index era filters and Kinship preset clutter on mobile

- **Files:** `packages/ui/src/pages/PlacesIndexPage.tsx` (lines 119-185), `packages/ui/src/pages/KinshipPage.tsx` (lines 106-178), `packages/ui/src/styles/archival.css`.
- **Defect observed:**
  - On `/places` (`360x800`), 6 era filter buttons stack vertically for `~260px` above the search input and display empty `Washington & New England (0)`.
  - On `/kinship` (`360x800`), 6 multi-line preset buttons take `~300px` above the **Person A / Person B** selectors (pushing **Person B** below the fold), and people with a birth year in `full_name` display duplicate years (`Abraham Lincoln (1744) (1744-1786)`).
- **Proposed fix:**
  - Hide zero-count migration eras in `PlacesIndexPage` (matching `MapPage.tsx:1094`) and render the era filter bar as a single-row horizontally scrollable chip strip with a subtle right-edge fade on `<= 767px`.
  - On `KinshipPage`, place the **Person A / Swap / Person B** selector card above the **Examples** section (or collapse Examples into a compact horizontal chip strip on mobile), and suppress appending `(${birth}-${death})` when `full_name` already ends with a parenthesized year.
- **Playwright acceptance assertions:**
  - On `/places` at `360x800`: zero era buttons display `(0)`, and the search input is visible above `y = 420px`.
  - On `/kinship` at `360x800`: both **Person A** and **Person B** `<select>` controls are visible within the initial `800px` viewport without scrolling, and no `<option>` contains double parenthesized years like `(1744) (1744`.

#### P2-2. Fix Source Reader tab alignment and vertical chrome density

- **Files:** `packages/ui/src/components/SourceReaderDrawer.tsx` (lines 239-443), `packages/ui/src/styles/archival.css` (lines 5439-5465).
- **Defect observed:**
  - In `SourceReaderDrawer` (`768x1024` and `1280x800`), the 5th document tab wraps onto two centered lines while tabs 1 through 4 left-align.
  - Stacked document tabs, download bar, pager, and search bar consume `~410px` (`>50%` of desktop height) before the transcription sheet starts.
- **Proposed fix:**
  - When `orderedDocs.length > 3`, replace the multi-row tab stack with a compact document `<select>` switcher (or a single-row horizontally scrollable tablist with `text-align: left; white-space: nowrap`), and move secondary download actions (**All Sources (.txt)**, **Copy All Text**) into a compact overflow menu or footer row so the transcription begins within `~220px` of the top of the drawer.
- **Playwright acceptance assertions:**
  - In `SourceReaderDrawer` at `768x1024` and `1280x800`: `.transcript-sheet` starts at `y <= 280px`, and every visible collection tab shares consistent alignment with no orphaned center-aligned wrapped line.

#### P2-3. Improve Time desktop single-resident card width and horizontal scroller affordances

- **Files:** `packages/ui/src/styles/archival.css` (lines 1287-1292, 2506-2535, 5306-5315).
- **Defect observed:**
  - On `/time` at `1280x800`, `.time-people-row` uses `repeat(auto-fill, minmax(260px, 1fr))`, leaving ~75% of single-resident lanes empty and wrapping names like `Dennis Friend Hanks` across 3 lines.
  - Horizontal scroll strips (`.tree-gen-jump-bar` on `/tree`, `.scrubber-list` on `/person/:slug`) clip chips (`G7`, `1840s`) at the right edge with zero fade gradient hinting at more items.
- **Proposed fix:**
  - Update `.time-people-row` to `grid-template-columns: repeat(auto-fit, minmax(300px, 460px))` so single-resident lanes widen cleanly without stretching across the entire page.
  - Add a subtle `mask-image: linear-gradient(to right, black 90%, transparent 100%)` (or right-edge paper fade overlay) to `.tree-gen-jump-bar` and `.scrubber-list` when `scrollWidth > clientWidth`.
- **Playwright acceptance assertions:**
  - On `/time` at `1280x800`: a single-resident `.time-person-item` card renders at `width >= 340px`.
  - On `/tree` at `360x800`: `.tree-gen-jump-bar` displays a scroll fade affordance when overflowing.

## 4. Out-of-scope and follow-up candidates (Wave 51+)

- **Demo archive config copy hygiene (`examples/demo/data/kinloom.config.yaml`):** Line 82 defines `title: Spouses & Collateral Siblings` for a `lineageSections` heading, which triggers the ubiquitous-language check for `Collateral` on `/`. Rename to `Spouses & Siblings` (or `Spouses & Extended Family`) in a demo data pass outside `packages/ui`.
- **Mobile Chart View initial zoom ergonomics (`packages/ui/src/pages/TreePage.tsx`):** Fitting all 10 generations onto a `360x800` screen scales node text down to ~5px and clips left generation band badges (`G1` to `G10`). Wave 51 can add a mobile "Focus on anchor ancestor at readable 0.85x zoom" default when switching to **Chart** on phones, plus a floating mini-legend pill.
- **Audio oral history and PDF lightbox touch gestures (`packages/ui/src/components/MediaPlayer.tsx`):** Add swipe left/right navigation and pinch-to-zoom support inside the **Photos & Documents** lightbox on touch devices.
- **Automated Playwright UX regression gate (`e2e/`):** Promote the Wave 50 audit checks (overflow across `360`/`390`/`768`/`1280`, topbar/toolbar overlap, `>= 44px` mobile touch-target assertions, occupancy bar non-clipping, z-index stacking with audio dock, and ubiquitous-language DOM grep) into a dedicated `e2e/ux-regression.spec.ts` suite in Wave 50B or Wave 51.
