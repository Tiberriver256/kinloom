# Wave 52 Impeccable UX critique and CLI/skills audit

Date: 2026-11-26
Baseline commit: `a917a60` (Wave 51B)
Tool version: `impeccable` CLI `4.10.0`
Audit targets: `packages/ui/src`, `packages/cli/src`, all 24 skill folders in `skills/`, `DESIGN.md`, `docs/ubiquitous-language.md`, and 11 live rendered routes from `examples/demo/dist` (`Lincoln & Todd Historical Archive`)
Viewports audited: `360x800`, `390x844`, `768x1024`, and `1280x800`, plus `@media print` emulation on `PersonPage` and `PlacePage`
Method: Visual screenshot review in headless Chromium against `vite preview` serving the existing `examples/demo/dist` build, automated DOM/keyboard/print Playwright checks, full `impeccable detect --json` scans, and line-by-line source inspection of `packages/ui/src`, `packages/cli/src`, and `skills/*/SKILL.md`.

## 1. Executive summary: top 5 Wave 52B improvements

Automated linting is green after Wave 51B (`0` primary and advisory findings from `impeccable detect` across `360x800`, `768x1024`, and `1280x800`, `0` horizontal overflows across all 44 viewport-route scans, and `0` console errors). Direct visual review, keyboard testing, print emulation, and CLI/skill audits reveal five high-impact gaps that automated lint cannot catch.

1. **Keyboard modal focus traps, skip-to-content link, and ARIA semantics (`packages/ui/src`)**
   All 12 `<dialog open>` overlays lack `aria-modal="true"`, Tab focus trapping, and focus restoration on close. Four wiki dialogs (`SignInModal`, `EntityEditDrawer`, `CreateEntityModal`, `MediaUploaderModal`) ignore `Escape`. Every dialog inserts an invisible full-screen `.lightbox-backdrop-close` button as its first Tab stop, `.global-search-input` suppresses `:focus-visible`, interactive SVG trees and maps sit inside `role="img"` (which hides children from screen readers), and the shell lacks a skip-to-content link.
2. **Self-contained archival print stylesheet (`packages/ui/src/styles/archival.css`, `PersonPage.tsx`, `PlacePage.tsx`, `Atoms.tsx`)**
   Printing a dense Person Profile (`/person/abraham-lincoln-1809`) currently cuts off the biography mid-sentence behind a collapsed fade gradient, omits biography footnote definitions when the Sources drawer is collapsed, leaves 79 interactive buttons visible (including collapsed `▸ 2 Sources` toggles and empty `Archival Photograph Needed · Click for Details` placeholder frames), and prints interactive filter bars on `PlacePage`. Wave 52B should turn printed profiles into complete, ink-clean archival folios.
3. **Editorial craft, Family Tree Chart legibility, and broken page-logic defects (`TreeOrthogonalCanvas.tsx`, `TreePage.tsx`, `PersonPage.tsx`, `TimePage.tsx`, `KinshipPage.tsx`, `PlacePage.tsx`, `timeSnapshot.ts`)**
   Visual inspection exposed high-visibility defects that hurt reader trust: Chart View still draws an SVG `4px` side-tab stripe (`TreeOrthogonalCanvas.tsx:316-325`), omits surnames and dates at default overview zoom (leaving homonymous ancestors indistinguishable and `Died young` labels around `4px` to `6px` tall), and has no keyboard zoom/pan shortcuts or live zoom readout. `TimePage` (`timeSnapshot.ts:377-390`) prints future death events as bold current-year headlines and repeats event titles verbatim. `KinshipPage` renders broken grammar for unconnected and identical pairs. `PlacePage` hides all other decade pills once you pick one decade. Dense Person Profiles lack a section jump bar, an `<h2>Life Timeline</h2>` heading, and clean mobile metadata ordering.
4. **Tablet `768x1024` touch-target cliff and residual design-token drift (`packages/ui/src/styles/archival.css`)**
   `DESIGN.md` specifies `>= 44px` tap height at `<= 768px`, and `ExplorerTopBar` switches to mobile navigation at `max-width: 768px`. Because page-level touch-target rules use `max-width: 767px` and `max-width: 760px`, every page control drops to `24px` to `34px` at `768x1024`. Even at `360x800`, `.search-input` (`38px`), `.person-family-chip` (`28px`), `.ink-link-btn` (`32px`), `.source-read-inline` (`21px`), and `.narrative-audio-scrub-input` (`16px`) fall below `44px`. Eleven font rules also sit below the `12px` floor (`0.62rem` to `0.68rem`), and five off-token `rgba(...)` rules remain.
5. **CLI ergonomics parity and synchronization of all 24 public skills (`packages/cli/src`, `skills/*/SKILL.md`)**
   `skills/pronounce/SKILL.md` omits `--strict`, describes an obsolete surname-only audit scope, and drifts from `PRONOUNCE_HELP`. `skills/narrative-audio/SKILL.md` and `packages/cli/src/commands/records/registry.ts:263` state Gemini TTS as the default backend even though the script defaults to `chirp3-hd` (Google Cloud TTS). Across the 24 skills, 21 use monorepo-only `skills/<dir>/scripts/...` paths (breaking in downstream archives and mangling `--help` output), 8 instruct editing `data/` directly instead of staging a Research Package, 0 document the canonical `status -> context -> prep-scan/ocr -> audit -> integrate -> pronounce audit --strict -> verify -> migrate -> sync` workflow, and 7 contain deprecated vocabulary from `docs/ubiquitous-language.md`. In `packages/cli/src/cli.ts`, `seed --chunk-size` is undocumented, 5 ops commands ignore programmatic `cwd`, `audit` lacks `integrate`'s flag aliases, and `sync` rejects `--site`.

## 2. Live visual baseline and telemetry summary

Measured against the built `examples/demo/dist` (`54` people, `39` places, `120` events, `29` media items, `5` narratives, `24` sources) served locally on `vite preview`:

| Check | Scope | Measured Result |
| --- | --- | --- |
| `impeccable detect --json` (all rules, incl. advisory) | 11 routes x 3 viewports (`360x800`, `768x1024`, `1280x800`) | `0` findings (clean baseline after Wave 51B) |
| Horizontal overflow (`scrollWidth > innerWidth`) | 11 routes x 4 viewports (`360x800`, `390x844`, `768x1024`, `1280x800`) | `0` routes with overflow |
| Runtime console / page errors | 11 routes x 4 viewports | `0` errors |
| Interactive controls `< 44px` on mobile/tablet (`<= 768px`) | 11 routes x 3 narrow viewports | Found on `29` of `33` route-viewport scans (peaking at `123` elements on dense Person Profile at `768x1024`) |
| Keyboard first Tab stop on `/` | `1280x800` | `<a class="brand-link">` (no skip-to-content link) |
| `GlobalSearchModal` & `SourceReaderDrawer` keyboard trap | `1280x800` | `role="dialog"` absent (`<dialog open>`), Tab escapes into page, `Escape` drops focus to `<body>` |
| `@media print` interactive leakage on `/person/abraham-lincoln-1809` | `1280x800` print emulation | `79` interactive buttons still visible, biography clipped by fade mask |

## 3. Impeccable deep visual and UX critique

Findings below are grouped by Impeccable's review lenses (`harden`, `critique`, `arrange`, `typeset`, `clarify`, `distill`, `polish`, `delight`) so Wave 52B can fix root causes instead of patching symptoms.

### 3.1 Harden: keyboard navigation, focus traps, ARIA, print, and broken edge cases

#### W52-U1 (P0): Shared dialog focus trap, focus restoration, Escape handling, and skip-to-content link

- **Measured observations:**
  - `packages/ui/src/KinloomApp.tsx:117-156` and `packages/ui/src/components/ExplorerTopBar.tsx:106-155` provide no skip-to-content link and no `id="main-content"` on `<main>`. A keyboard reader must press Tab through up to 12 header controls on every navigation.
  - All 12 overlays render non-modal `<dialog open>` without `aria-modal="true"`, without Tab/Shift+Tab trapping, and without restoring focus to the triggering element on close:
    - `packages/ui/src/components/GlobalSearchModal.tsx:145-156` (also intercepts `Enter` globally at `:122` even when focus is on Close or a suggested query chip)
    - `packages/ui/src/components/SourceReaderDrawer.tsx:225-236` and nested scan lightbox `:490-523` (nested lightbox does not move focus on open)
    - `packages/ui/src/components/SourceInspectorDrawer.tsx:87-98`
    - `packages/ui/src/pages/PersonPage.tsx:1276-1357` (media lightbox does not move focus on open)
    - `packages/ui/src/pages/EvidencePage.tsx:707-782` (media lightbox does not move focus on open; also Arrow keys at `:196-201` cycle `filteredMedia` while Prev/Next buttons at `:704, :727-747` exclude `document_scan`)
    - `packages/ui/src/components/Atoms.tsx:245-295` (`ArchivalPhotoFrame` lightbox) and `:641-679` (`SourceCitationTag` scan lightbox)
    - `packages/ui/src/components/wiki/SignInModal.tsx:28-50` (ignores `Escape`)
    - `packages/ui/src/components/wiki/EntityEditDrawer.tsx:513-537` (ignores `Escape`)
    - `packages/ui/src/components/wiki/CreateEntityModal.tsx:553-566` (ignores `Escape`)
    - `packages/ui/src/components/wiki/MediaUploaderModal.tsx:87-99` (ignores `Escape`)
  - Every `<dialog open>` places `<button type="button" className="lightbox-backdrop-close" />` (`packages/ui/src/styles/archival.css:3780-3787`) as the first focusable node inside the dialog, creating an invisible full-screen Tab stop.
  - `packages/ui/src/styles/archival.css:3987-3997` sets `outline: none` on `.global-search-input` with no replacement focus indicator.
  - `packages/ui/src/components/tree/TreeOrthogonalCanvas.tsx:648-655` and `packages/ui/src/components/LocalSurveyMap.tsx:214-226` place interactive `<g role="button" tabIndex={0}>` controls inside `<svg role="img">`, which hides descendant roles from assistive technologies per ARIA 1.2 `childrenPresentational`.
  - Five `role="tablist"` widgets (`EvidencePage.tsx:252-290`, `RecentChangesPage.tsx:166-188`, `CreateEntityModal.tsx:569-590, 592-615`, `SourceReaderDrawer.tsx:261-279`) omit WAI-ARIA Left/Right/Home/End roving-tabindex navigation and `aria-controls`. In `SourceReaderDrawer.tsx:148-152`, global `ArrowLeft`/`ArrowRight` page turning fires even while focus sits inside the collection tablist.
  - `packages/ui/src/components/ExplorerTopBar.tsx:113-152` omits `aria-current="page"` on active nav links, and its overflow `role="menu"` (`:278-390`) neither moves focus into the menu on open nor restores focus on `Escape`.
  - `packages/ui/src/components/PronunciationBadge.tsx:325-328` sets `aria-label` on a bare `<span>` without `role="group"`.
  - `packages/ui/src/pages/TimePage.tsx:224-258` renders the mobile milestone year sheet without `role="dialog"`, focus handoff, or focus restoration.
- **Proposed Wave 52B fix:**
  1. Add a shared `packages/ui/src/lib/useDialogFocusTrap.ts` hook that captures the previously focused element, focuses the initial target on open, traps Tab and Shift+Tab inside the dialog container, invokes `onClose` on `Escape`, sets `aria-modal="true"`, and restores focus on unmount.
  2. Wire `useDialogFocusTrap` into all 12 `<dialog open>` overlays plus `TimePage`'s mobile milestone sheet. Add `tabIndex={-1}` to `.lightbox-backdrop-close` across all dialogs so backdrop click remains functional without polluting Tab order.
  3. Add `<a href="#main-content" className="skip-to-content">Skip to content</a>` at the top of `ExplorerTopBar` (visually hidden until `:focus-visible`) and `id="main-content"` on every page `<main>`.
  4. Replace `outline: none` on `.global-search-input` with a visible `:focus-within` border/outline rule on `.global-search-header`.
  5. Change `<svg role="img">` to `<svg role="group">` in `TreeOrthogonalCanvas.tsx` and `LocalSurveyMap.tsx`, add `role="group"` on `.pronunciation-variants`, add `aria-current="page"` on active top-bar links, and add a shared `handleTablistKeyDown` helper for all five `role="tablist"` controls (guarding `SourceReaderDrawer`'s global Arrow listener when `document.activeElement` is inside `[role="tablist"]`).
  6. Align `EvidencePage.tsx:196-201` Arrow-key media lightbox cycling with `navList` at `:704`.

#### W52-U2 (P0): Complete `@media print` overhaul for scholarly archival printouts

- **Measured observations (visually verified under `@media print` emulation on `/person/abraham-lincoln-1809` and `/place/springfield-illinois` at `1280x800`):**
  - `packages/ui/src/styles/archival.css:6310-6375` leaves `.person-biography-body.is-collapsed` capped at `max-height: 13.5em; overflow: hidden;` with its `::after` fade overlay, truncating biographies mid-sentence on paper.
  - `packages/ui/src/pages/PersonPage.tsx:922` mounts `.person-biography-sources` only when `sourcesOpen` is `true`, so printed biographies show `[1]` and `[2]` superscripts with zero printed footnote definitions unless the reader expanded them before printing.
  - `79` interactive buttons remain visible when printing `/person/abraham-lincoln-1809`, including `.source-toggle` (`▸ 2 Sources · 2 Family`), `.source-read-btn` (`Read Source →`), `.also-here` (`▸ Also here`), and `.person-header-actions` (`Their route`).
  - `packages/ui/src/components/Atoms.tsx:238-241` prints tall dashed `Archival Photograph Needed · Click for Details` placeholder boxes on paper for events without attached scans (`Aug 8, 1860`, `Mar 4, 1861`, `Jan 1, 1863`).
  - `PlacePage` prints `See Family in 1837 →`, `Exact Place / 15-Mile Radius / Historical County / Migration Map →`, nearby pill buttons, and the `All Decades` filter button next to an empty `Local History` notice.
  - Open drawers and lightboxes (`.drawer-backdrop`, `.lightbox-backdrop`, `.source-inspector-backdrop`, `.wiki-edit-drawer-backdrop`) are not hidden in `@media print`.
  - Pagination rules omit `break-after: avoid` on headings, omit `break-inside: avoid` on media cards, citation rows, occupancy rows, and time lanes, omit `orphans: 3; widows: 3`, and put `break-inside: avoid` on the full `.person-header` (risking a blank page 1 for large families).
  - `TreePage` Chart View keeps its pan/zoom CSS `transform` in print, clipping the chart.
- **Proposed Wave 52B fix:**
  1. In `@media print`, force `.person-biography-body.is-collapsed { max-height: none !important; overflow: visible !important; }` and hide `.person-biography-body.is-collapsed::after`.
  2. Always render `.person-biography-sources` in `PersonPage.tsx` (using a CSS `.is-collapsed-screen` helper that hides on screen when `!sourcesOpen` and displays in `@media print`) so printed footnotes are self-contained.
  3. Hide all overlays (`.drawer-backdrop`, `.lightbox-backdrop`, `.source-inspector-backdrop`, `.wiki-edit-drawer-backdrop`), interactive disclosures/buttons (`.person-header-actions`, `.source-toggle`, `.source-read-btn`, `.source-action-btn`, `.also-here`, `.wireframe-photo:not(.has-real-photo)`, `.skip-to-content`), and page filter bars on `PlacePage`, `EvidencePage`, `TimePage`, `MapPage`, `IndexPage`, `PlacesIndexPage`, and `KinshipPage`.
  4. Flatten `html`, `body`, cards, and map boxes to `#ffffff` background, `#000000` ink, and `box-shadow: none`. Add `break-after: avoid` on `h1, h2, h3, h4, .section-heading`, move `break-inside: avoid` from `.person-header` to `.person-header-top` and `.person-family-row`, add `break-inside: avoid` on `.person-media-card`, `.citation-item-card`, `.place-map-box`, `.occupancy-row`, `.time-lane`, `.evidence-source-row`, add `orphans: 3; widows: 3` on prose paragraphs, and reset `.tree-stage` transform for Chart printing.

#### W52-U3 (P0): Fix functional UX bugs on `KinshipPage`, `PlacePage`, `TimePage`, and `PersonPage`

- **Measured observations:**
  - **Broken grammar on `KinshipPage` (`packages/ui/src/pages/KinshipPage.tsx:196-198`, verified against `packages/core/src/domain/kinshipFinder.ts:231,271`):** When `fromId === toId`, the heading renders `"Alice Mercer is the Same person Alice Mercer"`. When `!result.connected`, it renders `"Alice Mercer is the No documented kinship path in this archive slice Bob Vance"` and displays `"Distinct migration eras"` even when place records are missing.
  - **Vanishing decade filters on `PlacePage` (`packages/ui/src/pages/PlacePage.tsx:187-206`):** `recordDecades` is computed from `localRecords` after applying `decadeFilter`, so selecting `1860s` deletes every other decade pill until the user clicks `All Decades`.
  - **Layered History/Family Notes on `PlacePage` (`packages/ui/src/pages/PlacePage.tsx:368-384`):** Switching to Revision History or Family Notes leaves the entire Place Profile rendered underneath, unlike `PersonPage.tsx:825` which swaps views cleanly.
  - **Future death headlines and verbatim repetition on `TimePage` (`packages/core/src/domain/timeSnapshot.ts:377-390`, visually confirmed on `/time` at `1280x800`):** In `1880`, living 78-year-old `John Hanks` (who died in `1889`) displays bold **`Death of John Hanks in Macon County, Illinois`** directly above `Recorded in 1889: Death of John Hanks in Macon County, Illinois.` because both `activityTitle` and `activityNote` reuse `cleanedBest.title`.
  - **Silent no-op on portrait click (`packages/ui/src/pages/PersonPage.tsx:563-570`):** When `person.portrait_url` exists without a matching `bundle.media` row, clicking the portrait sets gallery index `0` into an empty array and opens nothing.
- **Proposed Wave 52B fix:**
  1. Branch `KinshipPage.tsx:195-225` cleanly on `samePerson`, `!result.connected`, and connected paths, and render a helpful empty-state message when `selectablePeople.length < 2` or no path exists.
  2. Derive `recordDecades` in `PlacePage.tsx` from scope-filtered (not decade-filtered) records, and hide the reading sections while `activeView !== 'profile'` to match `PersonPage`.
  3. In `packages/core/src/domain/timeSnapshot.ts:377-390`, when falling back to a non-same-year event (`bestEv`), set `activityTitle` to `Likely in ${place.name}` (or `Near ${place.name} (from ${bestEv.year} record)`) and keep `activityNote` as `${direction} in ${bestEv.year}: ${cleanedBest.title}.` so future deaths never appear as current-year headlines and titles never repeat verbatim.
  4. In `PersonPage.tsx:563-570`, fall back to `{ kind: 'single', media: syntheticPortrait }` when `personMedia.length === 0`.

#### W52-U4 (P1): Empty and sparse record states across 8 pages

- **Measured observations:**
  - `TreePage.tsx:1082-1189`: 0 people in archive or filtered branch renders a blank canvas or empty `<ol>` with no explanation or recovery action.
  - `EvidencePage.tsx:416-480`: 0 matching sources in `Sources & Citations` renders blank space below the filter input; when `unverifiedEvents.length === 0` (`:483-545`), it still prints the warning heading `"Entries Needing Primary Citation (0)"` and a GEDCOM caution paragraph above an empty box.
  - `IndexPage.tsx:288-291` and `PlacesIndexPage.tsx:218-220`: Both show `"No people/places match the active filters."` even when the archive itself is empty, and neither renders a one-click `Clear filters` button inside the empty state.
  - `MapPage.tsx:1274-1335`: With `0` geocoded stops, the bottom playback bar renders an enabled `Play Route` button and `0–0 · 0 stops` with no empty-state notice.
  - `TimePage.tsx:405`: Empty-year message reads `"Try one of the marked anchor years above"`, which points in the wrong direction on mobile (where milestone years live in a collapsed bottom dock) and uses internal schema vocabulary (`anchor years`).
  - `PersonPage.tsx:1153-1156`: Sparse person with 0 events renders a bare sentence without links to Family Tree or `+ Add Event` for editors.
- **Proposed Wave 52B fix:** Introduce a small shared `<EmptyStateNotice title body action />` component in `Atoms.tsx` and wire distinct empty-archive versus empty-filter states (with `Clear filters` or `Open Family Tree` actions) across all 8 pages. Disable `Play Route` when `stops.length === 0`, show a positive `"All events have primary citations."` confirmation when `unverifiedEvents.length === 0`, and replace `"anchor years above"` with `"Try a milestone year"` on `TimePage`.

### 3.2 Critique & arrange: visual hierarchy, Chart View ergonomics, and dense Person Profile scannability

#### W52-U5 (P1): Family Tree Chart View legibility, side-tab removal, and List View spine clarity

- **Measured observations (visually confirmed in `tree-chart__1280x800.png`, `tree-chart__768x1024.png`, `state-tree-chart-drawer__1280x800.png`, `tree-list__1280x800.png`):**
  - `packages/ui/src/components/tree/TreeOrthogonalCanvas.tsx:316-325` still draws a `4px` left accent `<rect>` inside Direct Line SVG nodes, contradicting `DESIGN.md:79` (automated CSS lint missed it because it is an inline SVG `<rect>`).
  - At default `Fit` zoom across a 10-generation archive (`1280x800` and `768x1024`), Chart View drops surnames and life years from every node (`Samuel`, `Abraham`, `Thomas`, `Mary`, `William Wall...`, `Robert Todd...`). Multiple Abrahams, Thomases, Samuels, and Marys become indistinguishable without clicking, `Died young` nested boxes render at ~`4px` to `6px` height, `G1..G10` pill labels are unreadable, and SVG node text (`8px` to `9px` SVG units at `:395, :416, :467, :528`) lacks `<clipPath>` overflow clipping.
  - `TreePage.tsx` provides no keyboard zoom/pan shortcuts (`+`/`=`, `-`, `0` Fit, `1` 1:1, Arrow keys when canvas is focused) and no live zoom percentage badge (such as `64%`) next to `+ / - / Fit / 1:1`.
  - In `List View` (`tree-list__1280x800.png`, `TreePedigreeRoll.tsx:364`), `.tree-roll-spine-rail` draws a continuous vertical connector through stacked `G1` founding couples (`Samuel Lincoln & Martha Lyford` -> `David Todd & Hannah Owen` -> `Joseph Hanks & Ann Nanny Lee`) with no Family Branch caption, making unrelated founding couples look like a parent-child chain. The `G1..G10` jump chips also sit left-aligned above a centered tree column.
- **Proposed Wave 52B fix:**
  1. Remove the SVG `4px` side-tab `<rect>` at `TreeOrthogonalCanvas.tsx:316-325` and differentiate Direct Line nodes with a clean full-perimeter `strokeWidth={2}` frame in `var(--surface-header)`.
  2. Add `<clipPath>` per card in `TreeOrthogonalCanvas.tsx`, raise overview/compact labels to at least `10.5px` SVG units, show surname disambiguation or birth year (`Abraham L. · 1809` or two-line compact name + years) whenever a given name repeats in the visible chart, and clamp initial `Fit` zoom or center on the Focus Ancestor at a legible minimum scale (`>= 0.55`) with a one-click `Fit All` overview button.
  3. Add keyboard zoom/pan handlers (`+`/`=`, `-`, `0`, `1`, Arrow keys) on the focusable chart canvas container, plus a live `aria-live="polite"` zoom percentage pill (`{Math.round(scale * 100)}%`) in `.tree-controls`.
  4. In `TreePedigreeRoll.tsx`, center the `G1..G10` jump strip above the centered tree column, break `.tree-roll-spine-rail` visually between unrelated founding units in `G1` (draw connectors between generation groups rather than behind sibling-branch cards), and render a quiet monospace branch label on multi-branch `G1` units when `All Branches` is active.

#### W52-U6 (P1): Dense Person Profile scannability, section hierarchy, and mobile identity ordering

- **Measured observations (visually confirmed in `person-dense__1280x800.png`, `person-dense__1280x800__full.png`, `person-dense__360x800.png`, `person-sparse__1280x800.png`):**
  - On dense profiles (`/person/abraham-lincoln-1809`), the page spans ~`9,000px` vertically across 4 major sections (`Biography`, `Family Stories`, `Photos & Documents`, and 25 Life Timeline cards) with no in-page jump strip (`Biography · Stories (3) · Photos (11) · Timeline (25)`).
  - `PersonPage.tsx:1158-1213` omits an `<h2>Life Timeline</h2>` heading (and `MilestoneStoryCard.tsx:62` uses `<h2>` instead of `<h3>`, breaking document outline hierarchy). When all events are undated (`scrubberItems.length === 0`), `.timeline-spine` still reserves an empty `74px` dashed rail on the left.
  - `archival.css:8248` gives `.narrative-audio-margin-bar` a `3px` left accent border (`border-left: 3px solid var(--accent-primary)`) that visually echoes the banned side-tab stripe, and the player header wraps `· Charon` awkwardly onto a second line on desktop (`person-dense__1280x800.png`).
  - `PersonPage.tsx:791` appends raw confidence-tier jargon (`· Inferred`) to every residence chip (`Little Pigeon Creek (1816–1820 · Inferred)`), cluttering the identity block and causing double-line dotted underlines at `360x800`.
  - On `360x800` (`person-dense__360x800.png`), `Their route` and `Export GEDCOM` sit between the pronunciation/dates block and `Also recorded as:`, splitting the person's identity metadata in half.
- **Proposed Wave 52B fix:**
  1. Add a compact, single-line section anchor bar (`Biography · Stories · Photos & Documents · Life Timeline`) directly below the identity strip when a Person Profile has 2 or more content sections, and add an explicit `<h2>Life Timeline</h2>` heading while demoting `MilestoneStoryCard` titles to `<h3>`.
  2. Collapse the empty `74px` `.timeline-spine` grid column when `scrubberItems.length === 0`.
  3. Replace `.narrative-audio-margin-bar`'s `3px` left border with a clean `1px solid var(--border-decorative)` full border (`border-radius: var(--radius-md)`), and keep the title, narrator, and timestamp on one balanced flex row (`white-space: nowrap` on metadata).
  4. Move `span.confidence_tier` from inline parenthetical text into a subtle `title` tooltip (or plain-English `"approx."` only when `Possible`), removing repeated `· Inferred` noise from `Residences`.
  5. Keep `Also recorded as:` directly below the vital dates on mobile (`<= 768px`), placing `.person-header-actions` below the complete identity metadata block.

#### W52-U7 (P1): Responsive layout polish across `MapPage`, `PlacePage`, `KinshipPage`, `IndexPage`, and `NotFoundPage`

- **Measured observations (visually confirmed in screenshots):**
  - **`MapPage` (`map__1280x800.png`):** `Trace: [Full ...]` truncates the person/archive `<select>` so the user cannot read `"Full Archive"`. Era filter pills clip mid-label on the right (`Appalachian & Kentucky Frontier (2`) with no scroll cue, hiding two eras off-screen.
  - **`PlacePage` (`place-springfield__360x800.png`):** On mobile, `Springfield` collides with the dashed 15-mile survey ring, nearby pins render as unlabeled hollow circles on the SVG, and the `NEARBY:` strip aligns row 2 under the `NEARBY:` label awkwardly.
  - **`KinshipPage` (`kinship__360x800.png`, `kinship__1280x800.png`):** On `360x800`, the first example button clips mid-word (`Abraham Lincoln (1744) ↔ Abraha`). On `1280x800`, 6 unbordered monospace example links run visually together across 3 lines.
  - **`IndexPage` (`index__360x800.png`):** `Photos & Documents (22)` and `Export GEDCOM (53)` stack as two unequal-width left-aligned buttons below the search input.
  - **`NotFoundPage` (`not-found__1280x800.png`, `not-found__360x800.png`):** The `.not-found-page` block aligns narrower than the top bar and footer, leaving a noticeably off-axis column on `1280x800`.
- **Proposed Wave 52B fix:**
  1. Give the `MapPage` Trace `<select>` a sensible `min-width: 11rem` (displaying `"All People (53)"` instead of the full archive title), and add right-edge scroll-fade plus left/right chevron buttons or clean two-row wrap for era pills.
  2. In `LocalSurveyMap.tsx`, offset the center `Springfield` label cleanly outside the dashed radius circle (below-left or top-left with a white halo stroke), and tighten the `NEARBY:` flex container so wrapped chips align cleanly as a block.
  3. Style `KinshipPage` example presets as subtle bordered hairline chips that wrap cleanly on mobile (`white-space: normal; text-align: left;`) instead of clipping horizontally.
  4. On `IndexPage` (`<= 480px`), display `Photos & Documents` and `Export GEDCOM` in a clean 2-column or full-width action row.
  5. Align `.not-found-page` to the standard `.wire-page` horizontal container and vertical padding (`margin: 0 auto; max-width: var(--page-max-width);`) so the left margin matches `ExplorerTopBar` and `KinloomFooter`.

### 3.3 Typeset, polish & clarify: touch-target breakpoint alignment, token hygiene, reduced motion, and ubiquitous-language copy

#### W52-U8 (P1): Align `<= 768px` touch targets, eliminate 11 sub-12px font sizes, and purge 5 off-token `rgba(...)` rules

- **Measured observations:**
  - `packages/ui/src/styles/archival.css` switches the header at `@media (max-width: 768px)` (`:5161`), while mobile `44px` touch-target rules live inside `@media (max-width: 767px)` (`:5285, :6836, :8092, :8574`) and `@media (max-width: 760px)` (`:1736`). At `768x1024`, `.search-input` drops to `29px`, `.pill-btn` to `30px`, `.tree-gen-jump-chip` to `32px`, `.pronunciation-play-btn` to `24px`, `.time-anchor-btn` to `27px`, and `.map-bordered-btn` to `28px`.
  - Even at `360x800` and `390x844`, `.search-input` measures `38px`, `.person-family-chip` `28px`, `.ink-link-btn` `32px`, `.source-read-inline` `21px`, Kinship `.pill-btn` links `34px`, and `.narrative-audio-scrub-input` `16px` (all below the `44px` rule in `DESIGN.md:85`).
  - Eleven CSS rules declare font sizes below the `12px` floor (`DESIGN.md:65`) at `16.5px` root: `.media-kind-badge` (`0.62rem` = `10.2px`, plus `padding: 1px 6px`, `archival.css:4868`), `.time-macro-toggle-tag` (`0.64rem` = `10.6px`, `:5717`), `.map-page .maplibregl-ctrl-attrib` (`11px`, `:3278`), plus eight `0.68rem` (`11.2px`) selectors (`:1188, :1391, :2426, :4230, :5511, :5736, :8715, :9044`), with `.tree-focus-living-pill` (`:2426`) also using `padding: 1px 6px`.
  - Five off-token `rgba(...)` colors remain in `archival.css`: `:1717` (`rgba(250, 245, 236, 0.7)`), `:3800` & `:3907` (Tailwind slate `rgba(15, 23, 42, ...)`), `:4877` (`rgba(54, 89, 76, 0.92)`), and `:4885` (`rgba(140, 83, 25, 0.92)`).
  - Eight stray border-radii remain off the `2px` / `4px` / `999px` scale: `6px` (`:7224`), `3px` (`:2451, :4633, :8333, :8385, :8751, :8813`), and `99px` (`:6202`).
  - Two JS `scrollIntoView({ behavior: 'smooth' })` calls (`TreePedigreeRoll.tsx:350`, `PersonPage.tsx:1175`) ignore `prefers-reduced-motion: reduce`.
- **Proposed Wave 52B fix:**
  1. Unify all `@media (max-width: 767px)` and `@media (max-width: 760px)` blocks in `archival.css` to `@media (max-width: 768px)`, and ensure `.search-input`, `.ink-link-btn`, `.source-read-inline`, `.person-family-chip`, Kinship `.pill-btn`, and `.narrative-audio-scrub-input` reach `>= 44px` tap height at `<= 768px`.
  2. Raise all 11 sub-12px selectors to `>= 0.73rem` (`12.05px`) and raise `.media-kind-badge` and `.tree-focus-living-pill` padding to `4px 8px`.
  3. Replace the 5 off-token `rgba(...)` values with canonical palette RGB channels (`rag-card`, `archival-indigo`, `pine-moss`, `loom-ochre`) and normalize the 8 stray border-radii to `var(--radius-sm)`, `var(--radius-md)`, or `999px`.
  4. Gate `scrollIntoView` in `TreePedigreeRoll.tsx:350` and `PersonPage.tsx:1175` on `!window.matchMedia('(prefers-reduced-motion: reduce)').matches`.

#### W52-U9 (P2): Remaining ubiquitous-language copy fixes in `packages/ui/src`

| File and Line | Current Copy | Canonical Replacement (`docs/ubiquitous-language.md`) |
| --- | --- | --- |
| `packages/ui/src/components/wiki/CreateEntityModal.tsx:90` | `Collateral Relative` | `Extended Relative` |
| `packages/ui/src/components/wiki/MediaUploaderModal.tsx:87, 119` | `Upload archival media`, `Living-person privacy rule:` | `KINLOOM_VOCABULARY.wiki.uploadDialogAria` (`Upload photo or document`), `KINLOOM_VOCABULARY.wiki.livingPrivacyRuleTitle` (`Living Privacy Rule:`) |
| `packages/ui/src/components/wiki/TalkPanel.tsx:86` | `aria-label="Record discussion"` | `aria-label={KINLOOM_VOCABULARY.wiki.familyNotes}` (`Family Notes`) |
| `packages/ui/src/components/SourceReaderDrawer.tsx:246, 261` | `Primary Source Archive · ...`, `Primary source collections` | `Source Reader · ...`, `Source collections` |
| `packages/ui/src/pages/EvidencePage.tsx:295, 438, 667` | `No conflicting date, place, or fact claims...`, raw `Type: {s.source_type}` (`vital_record`), `Remaining Un-digitized Photos & Documents Entries` | `No source discrepancies are recorded.`, `formatSourceTypeLabel(s.source_type)`, `Un-digitized Photos & Documents` |
| `packages/ui/src/pages/KinshipPage.tsx:199, 219, 232` | `computed across compiled kinship links`, `SHARED ARCHIVED PLACES`, `(CLICK ANY PERSON TO OPEN PROFILE)` | `Traced through documented family links`, `SHARED PLACES`, `SHORTEST LINEAGE CHAIN` (remove mouse-only instruction) |
| `packages/ui/src/pages/TimePage.tsx:195, 405` | `Where the {familyName} Was in` (ungrammatical for plural family names), `anchor years` | `{familyName} in {activeYear}`, `milestone years` |
| `packages/ui/src/pages/PlacesIndexPage.tsx:156` | `local weather or dispatches` | `local weather or newspaper notices` |
| `packages/ui/src/components/Atoms.tsx:172` | `Click to pivot timeline.` | `Open Person Profile.` |

### 3.4 Delight and distill opportunities

- **Time View milestone counts (`TimePage.tsx`):** The desktop milestone strip renders `1637 2`, `1880 11`, `1905 4` without explaining what the trailing count means. Adding an `aria-label` plus a subtle `tooltip` and compact header caption (`"Year · people alive"`) clarifies the metric without adding chrome.
- **Source Reader horizontal tab affordance (`SourceReaderDrawer.tsx`):** In `state-source-reader__1280x800.png`, the second collection tab (`1850 U.S. Federal Cen...`) hard-clips at the right drawer edge. Adding a subtle horizontal scroll-fade mask lets readers see more documents exist.

## 4. CLI and public skills ubiquitous-language and ergonomics audit

Audited all `17` core built-in commands + `25` record/guide/media commands in `packages/cli/src/` and all `24` public skills in `skills/`.

### 4.1 `packages/cli` findings

| ID | Priority | File and Line | Measured Defect | Concrete Wave 52B Fix |
| --- | --- | --- | --- | --- |
| W52-C1 | P1 | `packages/cli/src/commands/records/registry.ts:263` | `kinloom narrative-audio` summary says `"with Gemini TTS"`, while `skills/narrative-audio/scripts/narrative-audio:53` defaults to `chirp3-hd` (Google Cloud TTS). | Update summary to `"Turn Kinloom narratives into narrated MP3 audio (Chirp 3: HD or Gemini TTS)"`. |
| W52-C2 | P1 | `packages/cli/src/cli.ts:123-133, 640` | `kinloom seed` parses `--chunk-size <N>` (`seed.ts:288`), yet `COMMAND_HELP.seed` omits `--chunk-size`. | Document `--chunk-size <N>` in `COMMAND_HELP.seed`. |
| W52-C3 | P1 | `packages/cli/src/cli.ts:883, 1070, 1104, 1125, 1160, 1200, 1236` | Five ops commands (`context`, `audit`, `verify`, `status`, `sync`) ignore programmatic `options.cwd` and fall back to `process.cwd()` (line `1070` hardcodes `process.cwd()`), unlike `integrate`, `migrate`, and `pronounce audit`. | Pass `values.repo ?? cwd` (and `parsed.repoDir ?? cwd`) consistently across all 8 repo-scoped ops commands. |
| W52-C4 | P1 | `packages/cli/src/cli.ts:1039-1047`, `help.ts:60, 64` | `kinloom audit` rejects `--person-id`, `--package`, `--patch`, and positional `patch.json`/package directory arguments that `kinloom integrate` accepts. | Add `--person-id`, `--package`, `--patch`, and positional path resolution to `kinloom audit` for parity with `integrate`. |
| W52-C5 | P1 | `packages/cli/src/cli.ts:413`, `help.ts:158` | `kinloom sync` requires `--site-url` and rejects `--site`, whereas `seed`, `submit-batch`, `export-yaml`, `upload-media`, and `reconcile` all accept `--site`. | Accept `--site` as an alias for `--site-url` in `parseSyncArgs`. |
| W52-C6 | P1 | `packages/cli/src/commands/ops/migrate.ts:402-414, 814-815`, `help.ts:235`, `sync.ts:413-415` | `migrate.ts` parses `binding.migrationsDirHint` from Wrangler config but never uses it; `MIGRATE_HELP` omits `wrangler.json` (which `migrate.ts:361` supports); `sync.ts` omits `wrangler.toml` (which `migrate.ts` supports). | Wire `binding.migrationsDirHint` (or remove dead field and document bundled migrations), add `wrangler.json` to `MIGRATE_HELP`, and add `wrangler.toml` support to `sync.ts`. |
| W52-C7 | P2 | `packages/cli/src/commands/ops/pronounce.ts:969, 995, 1048, 1080` | Prose uses deprecated `"phonetic guide"` and `"phonetic respelling"` (`docs/ubiquitous-language.md:71`), lowercase `"Pronunciation audit"`, and `"surname-only or partial pronunciation"` instead of **Respelling**, **Pronunciation Audit**, **Surname Pronunciation**, and **Partial Pronunciation**. | Update all 4 messages to canonical ubiquitous-language phrasing while keeping the `phonetic` schema key intact. |
| W52-C8 | P2 | `packages/cli/src/cli.ts:71, 87-90, 113`, `commands/sliceGedcom.ts:46`, `commands/ops/help.ts:65, 221-227` | `ROOT_HELP` describes `integrate` as single-package only (missing `--all-staged --pending-only`), omits `KINLOOM_PRONOUNCE_CACHE_DIR` (`pronounce.ts:189`), uses `"Root individual xref"` (`sliceGedcom.ts:46` too), and `AUDIT_HELP` line `65` is a single 747-character unwrapped paragraph. | Update `integrate` summary, document `KINLOOM_PRONOUNCE_CACHE_DIR` in `ROOT_HELP` and `PRONOUNCE_HELP`, change `"Root individual"` to `"Root person"`, and wrap `AUDIT_HELP` `--strict` rules as concise bullets. |

### 4.2 Audit matrix across all 24 public skills (`skills/`)

All 24 skill directories pass YAML frontmatter validation (`name` matches directory and `description` is present). Measured gaps across the 24 skills:

| Audit Dimension | Measured Count | Affected Skills |
| --- | --- | --- |
| Stale CLI flags or contradicted default backend | `2 / 24` | `pronounce`, `narrative-audio` |
| Uses raw monorepo `skills/<dir>/scripts/...` paths as primary examples | `21 / 24` | All 20 record-script skills + `narrative-audio` (only `blm-glo`, `cyndis-list`, `pronounce` do not) |
| Mixes `kinloom <cmd>` and raw script paths in one file | `1 / 24` | `archive-org` (`kinloom ia` on 6 lines vs `skills/archive-org/scripts/archive-org` on 23 lines) |
| Leaks internal monorepo test commands into `kinloom <cmd> --help` | `1 / 24` | `virginia-archives` (`SKILL.md:100` prints `unittest` and `Vitest` commands) |
| Instructs direct `data/` edits instead of staging a Research Package | `8 / 24` | `acpl-persi`, `california-archives`, `cyndis-list`, `library-of-michigan`, `uk-archives`, `usgs-gnis`, `virginia-archives`, `wikitree` |
| References canonical Kinloom ops commands (`status --missing-biography`, `context`, `audit --all-staged --pending-only --strict`, `integrate --all-staged --pending-only`, `pronounce audit --strict`, `verify`, `migrate`, `sync`) | `0 / 24` | None of the 24 skills reference the staged Research Package to Archive Sync workflow |
| References `kinloom prep-scan` or `kinloom ocr` among scan-downloading skills | `0 / 10` | `archive-org`, `chronicling-america`, `findagrave`, `library-of-michigan`, `minnesota-archives`, `missouri-archives`, `nara-catalog-search`, `openarchieven`, `swedish-archives`, `virginia-archives` |
| Mentions Kinloom's Living Privacy Rule | `5 / 24` | Only `narrative-audio`, `pronounce`, `wikitree`, `openarchieven`, `swedish-archives` mention living privacy (`0 / 19` others) |
| Contains deprecated vocabulary from `docs/ubiquitous-language.md` | `7 / 24` | `pronounce`, `narrative-audio`, `finnish-archives`, `uk-archives`, `kentucky-archives`, `virginia-archives`, `cyndis-list` |
| Divergent cache paths / env-var naming | `4 / 24` | `finnish-archives`, `minnesota-archives`, `swedish-archives` use `~/.cache/kinloom/<name>/` vs `17` skills using `~/.cache/kinloom-<name>/`; `virginia-archives` uses `KINLOOM_VA_ARCHIVES_TTL_HOURS` (missing `_CACHE_`) |

### 4.3 High-priority skill fixes for Wave 52B

1. **W52-S1 (P0): Bring `skills/pronounce/SKILL.md` into lockstep with `kinloom pronounce`**
   - Add `--strict` to `kinloom pronounce audit [--repo <path>] [--strict] [--json]` (`skills/pronounce/SKILL.md:40`).
   - Update coverage scope (`:8, :43-48`) from surname-only to 100% **Full-Name Pronunciation** coverage for deceased people, 100% **Place** coverage, and 0 **Living** leaks under the **Living Privacy Rule**.
   - Replace `living individuals` (`:43`) with `Living people`, adopt canonical terms (**Pronunciation Guide**, **Respelling**, **Pronunciation Lexicon**, **Pronunciation Audit**, **Pronunciation Variant**), and link the pre-sync step (`kinloom pronounce audit --strict` -> `kinloom verify` -> `kinloom sync`).
2. **W52-S2 (P0): Fix backend, auth, and terminology drift in `skills/narrative-audio/SKILL.md` and `references/script-rules.md`**
   - Update `skills/narrative-audio/SKILL.md:3, 10-11, 95-101` so `chirp3-hd` (Google Cloud TTS) is documented consistently as the default backend, with `GOOGLE_CLOUD_TTS_API_KEY`, `GOOGLE_CLOUD_PROJECT`, and `gcloud auth print-access-token` alongside `GEMINI_API_KEY` (`--backend gemini` and `transcribe`).
   - Replace `living individuals` and `public builds` (`:105-106`) with `Living people` and `public Archives`.
   - Update `skills/narrative-audio/references/script-rules.md:91-110` to reference `kinloom pronounce lookup <term>` and the archive **Pronunciation Lexicon** before authoring `<slug>.names.json`, and note `kinloom sync --upload-media` for uploading rendered MP3 files.
3. **W52-S3 (P1): Standardize CLI invocation syntax and remove broken monorepo paths across 21 skills**
   - Replace `skills/<dir>/scripts/<script>` primary examples across all 21 script-backed `SKILL.md` files (including the 23 mixed lines in `skills/archive-org/SKILL.md`) with `kinloom <cmd>` so skills run cleanly in private downstream archives and `kinloom <cmd> --help` stops printing awkward `Path: kinloom <cmd>` rewrites (`packages/cli/src/commands/records/help.ts:112-122`).
   - Replace `CLI=skills/narrative-audio/scripts/narrative-audio` (`skills/narrative-audio/SKILL.md:19`) with direct `kinloom narrative-audio` invocations (fixing zsh word-splitting breakage).
   - Remove the leaked internal test command from `skills/virginia-archives/SKILL.md:100`.
4. **W52-S4 (P1): Replace direct `data/` editing instructions with canonical Research Package staging and ubiquitous-language cleanup**
   - Update the 8 skills instructing direct `data/` edits (`acpl-persi:88`, `california-archives:122`, `cyndis-list:37`, `library-of-michigan:108`, `uk-archives:90`, `usgs-gnis:98`, `virginia-archives:125`, `wikitree:138-139`) to point to a uniform **Research Package** workflow: discover targets with `kinloom status --missing-biography` or `--end-of-line`, gather context with `kinloom context <person_id> --include-family`, stage findings into `research/people/<person_id>/patch.json` and `scans/` (using `kinloom prep-scan crop --redact-orig` and `kinloom ocr` for scans while enforcing the **Living Privacy Rule**), then run `kinloom audit --all-staged --pending-only --strict`, `kinloom integrate --all-staged --pending-only`, `kinloom pronounce audit --strict`, `kinloom verify`, `kinloom migrate`, and `kinloom sync --sync-missing-media --verify-live`.
   - Fix remaining deprecated phrasing: `skills/finnish-archives/SKILL.md:103` (`manuscript scan` -> `register scan`), `skills/uk-archives/SKILL.md:90` (`proved in data/` -> `cited in a staged Research Package`), `skills/kentucky-archives/SKILL.md:82, 115` (`proved` -> `documented`, `individual` -> `person`), `skills/virginia-archives/SKILL.md:106` (`proved` -> `documented`), and `skills/cyndis-list/SKILL.md:43` (`individuals` -> `people`).
   - Optionally support `KINLOOM_VA_ARCHIVES_CACHE_TTL_HOURS` alongside `KINLOOM_VA_ARCHIVES_TTL_HOURS` in `skills/virginia-archives/` for env-var consistency.

## 5. Wave 52B acceptance contract

Wave 52B is complete only when every check below passes on a fresh build of `@kinloom/core`, `@kinloom/cli`, `@kinloom/ui`, and `@kinloom/demo`.

### 5.1 Impeccable CLI gates

1. `npm run audit:impeccable` passes with exit code `0` and `0` primary findings across static targets and live `1280x800` / `390x844` demo routes.
2. Live `impeccable detect --json --viewport 360x800` and `--viewport 768x1024` across `/`, `/tree?surface=roll`, `/tree?surface=diagram`, `/person/abraham-lincoln-1809`, `/person/emilie-todd-helm`, `/place/springfield-illinois`, `/time`, `/map`, `/evidence`, `/kinship`, and `/does-not-exist` return `0` findings.

### 5.2 Playwright E2E acceptance tests (`e2e/ux-regression.spec.ts`)

1. **Skip link and dialog focus traps (`1280x800`):**
   - First `Tab` on `/` focuses `a.skip-to-content[href="#main-content"]`; pressing `Enter` moves focus to `#main-content`.
   - Opening `GlobalSearchModal`, `SourceReaderDrawer`, `SourceInspectorDrawer`, and a `PersonPage` photo lightbox sets `aria-modal="true"` on the active dialog, keeps focus strictly inside the dialog across 20 consecutive `Tab` and `Shift+Tab` presses (never hitting `.lightbox-backdrop-close`), and returns focus to the triggering button when `Escape` is pressed.
   - `TreeOrthogonalCanvas` and `LocalSurveyMap` `<svg>` containers do not use `role="img"` while wrapping interactive `role="button"` children.
   - Pressing `ArrowRight` / `ArrowLeft` / `Home` / `End` inside `EvidencePage` `[role="tablist"]` moves focus across tabs; pressing `ArrowRight` inside `SourceReaderDrawer`'s collection tablist moves tab focus without turning document pages.
2. **Print folio fidelity (`emulateMedia({ media: 'print' })`):**
   - On `/person/abraham-lincoln-1809`, `.person-biography-body` has `maxHeight === 'none'`, `.person-biography-sources` is visible (`display !== 'none'`), `0` `.source-toggle`, `.source-read-btn`, `.also-here`, or `.wireframe-photo:not(.has-real-photo)` controls are visible, and `body` background is `rgb(255, 255, 255)`.
   - On `/place/springfield-illinois`, scope tabs, `Migration Map →`, and decade filter buttons are hidden (`display === 'none'`).
3. **Tablet `768x1024` and mobile `360x800` touch targets and typography:**
   - Across `360x800`, `390x844`, and `768x1024`, `.search-input`, `.pill-btn`, `.ink-link-btn`, `.tree-gen-jump-chip`, `.pronunciation-play-btn` (header), `.time-anchor-btn`, `.map-bordered-btn`, and `.source-read-inline` measure `>= 44px` height (excluding MapLibre attribution links and inline prose links).
   - No visible `.media-kind-badge`, `.tree-focus-living-pill`, `.time-anchor-count`, `.time-person-tier`, or `.pronunciation-lang` renders below `12px` font size.
4. **Functional UX and Chart ergonomics:**
   - On `/tree?surface=diagram` at `1280x800`, `0` `<rect width="4">` side-tab bars exist inside person cards; pressing `+`, `-`, and `0` updates the live zoom percentage readout; focusing a person node and pressing `Escape` closes the Focus Drawer and restores focus.
   - On `/kinship`, selecting identical people or an unconnected pair renders grammatical headings without `"is the Same person"` or `"is the No documented kinship path"`.
   - On `/place/springfield-illinois`, clicking any decade filter keeps all other decade filter buttons visible.
   - On `/time` in `1880`, no person entry duplicates the exact same string in both its bold headline and its subtitle, and no future death event appears as the bold headline.

### 5.3 Vitest and CLI/skills parity tests (`packages/cli`, `packages/core`, `packages/ui`)

1. **`packages/core` (`timeSnapshot.test.ts`):** Unit test confirming non-same-year fallback entries use a location-oriented `activityTitle` (never a future death event title) and never duplicate `activityTitle` verbatim inside `activityNote`.
2. **`packages/cli` (`cli.test.ts` and `commands.test.ts`):**
   - Assert `runCli(['seed', '--help'])` includes `--chunk-size`.
   - Assert `runCli(['audit', '--package', ...])`, `--person-id`, `--patch`, and `runCli(['sync', '--site', ...])` parse without unknown-option errors.
   - Assert `context`, `audit`, `verify`, `status`, and `sync` honor programmatic `options.cwd` when `--repo` is omitted.
   - Assert `kinloom pronounce audit --help` and `skills/pronounce/SKILL.md` both document `--strict`, 100% deceased full-name coverage, and 0 living leaks.
   - Assert `packages/cli/src/commands/records/registry.ts` and `skills/narrative-audio/SKILL.md` agree on `chirp3-hd` as default backend.
3. **Public skills and ubiquitous-language guard test (`packages/cli/src/commands/records/records.test.ts`):**
   - Scan all 24 `skills/*/SKILL.md` files and CLI help constants to assert: `0` raw `skills/<dir>/scripts/` primary invocation examples, `0` leaked `unittest`/`Vitest` test commands, `0` direct `"in data/"` edit instructions, and `0` forbidden ubiquitous-language synonyms (`manuscript scan`, `living individuals`, `phonetic guide`, `phonetic respelling`, `Collateral Relative`, `Record discussion`, `anchor years`).
4. **Standard repository gates:**
   - `npm run check` (`lint`, `build`, `typecheck`, `test`, `check:contrast`, `check:leaks`) passes with exit code `0`.
   - `npm run test:e2e` passes with `0` failures.
