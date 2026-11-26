# Wave 53 signed-in editor UX and maintenance CLI audit

Date: 2026-11-26
Baseline commit: `7b76d13` (Wave 52B)
Tool version: `impeccable` CLI `4.10.0`
Audit targets: `packages/ui/src` (signed-in contributor, wiki, auth, diff, tree, and admin surfaces), `packages/cli/src/commands/ops` (`integrate.ts`, `integrate-batch.ts`, `audit.ts`, `audit-overlaps.ts`, `verify.ts`, `status.ts`, `live-media-collisions.ts`), `DESIGN.md`, `docs/ubiquitous-language.md`, and the live in-memory wiki server (`e2e/helpers/wikiTestServer.ts`) serving `examples/demo/dist` (`Lincoln & Todd Historical Archive`)
Viewports audited: `360x800`, `390x844`, `768x1024`, and `1280x800`
Method: Live Chromium Playwright capture with real session cookies and seeded Research Batches, live `impeccable detect --json --cdp` scans on open dialogs and signed-in routes, automated per-element overflow and collision sweeps across 15 routes in public, signed-in, and 3-digit count stress modes, and line-by-line source review.

## 1. Executive summary: top 5 Wave 53B improvements

Waves 50 through 52 polished the public static reader routes. Auditing the live signed-in editor experience, 3-digit count mobile layouts, and archive maintenance CLI exposed five high-impact gaps.

1. **Eliminate signed-in mobile button overflow, toolbar collisions, and nav-tab crush (`IndexPage.tsx`, `TreeToolbar.tsx`, `ExplorerTopBar.tsx`, `archival.css`)**
   Three signed-in mobile defects break above-the-fold layouts even though `documentElement.scrollWidth` stays equal to `innerWidth`. On `/` at `360x800` and `390x844`, the rigid 2-column `.index-filter-actions` grid forces `Photos & Documents (22)` to spill `11px` past both left and right button borders (`15px` each side with 3-digit `Photos & Documents (108)`), while `Export GEDCOM` drops onto row 2 as a half-width orphan. On `/tree` in signed-in mode, row 2 places `.tree-scope-segmented` beside `+ Add Person`, so `Full Tree (128)` escapes its container by `41px` at `360x800` and physically overlaps `+ Add Person` by `35px` (`5px` at `390x844`). In `ExplorerTopBar`, mobile `.nav-pill` omits `flex-shrink: 0`, so multi-word plugin tabs shrink to `44px` and spill `54.5px` onto adjacent tabs. Wave 53B must fix all three layouts and add a permanent Playwright per-element overflow, parent-containment, and sibling-collision gate.
2. **Fix Family Tree child-tray labels, transparent cross-mode counts, and full spouse names (`TreePedigreeRoll.tsx`, `TreeOrthogonalCanvas.tsx`, `archivalTreeModel.ts`, `vocabulary.ts`)**
   In Direct Line mode (`mode === 'spine'`), a couple's child tray lists every non-direct-line child as `Hide N siblings` (for example, `Hide 9 siblings` for a couple with 10 children). In Full Tree mode (`mode === 'full'`), children who have spouses or descendants move into full family units below, so the tray shrinks (for example, `Hide 7 siblings`) with no explanation. Readers see a couple appear to lose children when switching to Full Tree, and calling a couple's children "siblings" inside their parents' box is confusing vocabulary. In addition, child cards in `TreePedigreeRoll.tsx:221-235` display only the spouse's `given_name` (such as `m. Aaron` instead of `m. Aaron Grigsby`) on the shared monospace date line instead of the full name on its own sub-line.
3. **Repair signed-in Auth, Edit Drawer, Diff Table, and Admin safety workflows (`AuthStatusBanner.tsx`, `SignInModal.tsx`, `EntityEditDrawer.tsx`, `RevisionDiffView.tsx`, `RecentChangesPage.tsx`, `AdminPage.tsx`)**
   Live testing uncovered four critical interaction bugs. First, `AuthStatusBanner.tsx:44-53` strips `?auth_error` from the URL before `/api/session` resolves, so `SignInModal` never auto-opens for `invite_viewer` redirects (`autoOpenedOnRedirect = false` across all three viewports). Second, `RevisionDiffView` sets `white-space: nowrap` on `.wiki-diff-field-cell`, crushing `Before` and `After` columns into 5-character mid-word strips at `360x800`. Third, `EntityEditDrawer` has no sticky header or footer (`footerVisibleInViewport = false` on Pronunciation Edit jump across all viewports) and triggers Impeccable `nested-cards` (`div.wiki-pronunciation-breakdown`, alongside `p.inspector-formatted-citation` in `SourceInspectorDrawer`). Fourth, `RecentChangesPage` (`Revert`, `Revert Entire Batch`) and `AdminPage` (`Revoke`, `Demote to Editor`) execute destructive actions in one click with no confirmation, `AdminPage` renders no `Copy Link` button for newly created or active invites, and admins can click `Demote to Editor` on their own row.
4. **Make `kinloom integrate --all-staged --pending-only` drift-safe with content-hashed receipts (`integrate.ts`, `integrate-batch.ts`, `audit-overlaps.ts`)**
   Currently, `classifyStagedPackages()` relies only on `hasUnintegratedEffect(dryRun)` while `upsertById` replaces live narrative, media, and source objects wholesale. After any later migration or live edit (such as adding `has_primary_source: true` to `narratives.yaml`), already-integrated older packages re-enter the `pending` queue and overwrite newer live edits if `--all-staged --pending-only` runs. Wave 53B should add per-package `.integrated.json` content-hash receipts, a non-destructive containment classifier for legacy pre-receipt packages, and field-preserving merges in `integrate.ts`.
5. **Add dry-run-first `kinloom media dedupe` with atomic citation rewiring and rollback (`media-dedupe.ts`, `verify.ts`, `cli.ts`)**
   `kinloom verify` flags duplicate normalized file paths in `data/media.yaml` (`verify.ts:252-275, 682-684`) without offering an automated safe fix. Wave 53B should add a dry-run-by-default `kinloom media dedupe` command (and optional `--apply` write mode) that selects a deterministic canonical record per duplicate file, merges every unique person link, caption, provenance note, and source metadata field, rewrites inline narrative citations (`[^src_id|old_med_id]`) and YAML references atomically, validates dual-mode compilation and privacy before writing, and rolls back to a byte snapshot on any write error.

## 2. Signed-in route Impeccable and viewport audit matrix

### 2.1 Live signed-in CDP scan matrix (`360x800`, `768x1024`, `1280x800`)

Measured against `startLiveWikiTestServer()` (`examples/demo/dist`) with a seeded admin session, a seeded editor account, active and revoked invites, two agent tokens, a 2-entity Research Batch (`batch_2026_11_census_enrichment`), a human pronunciation edit (`r444`), and a Family Notes comment. Zero runtime JS page errors occurred. One 404 console error occurred on a missing static asset at `1280x800`.

| Signed-in surface / state | `360x800` (Mobile) | `768x1024` (Tablet) | `1280x800` (Desktop) | Key measured defects |
| --- | --- | --- | --- | --- |
| `AuthStatusBanner` (invite viewer strip) | `sub44=2`, `sub12=25`, `overflowX=false` | `sub44=2`, `sub12=25`, `overflowX=false` | `overflowX=false` | `Sign in to edit` (`105x15px`) and dismiss `×` (`24x24px`) miss 44px touch floor; `11.9px` text (`0.72rem`). |
| `SignInModal` (clean Google + Magic Link) | `impeccable=1` (`text-overflow` on `/` behind modal), `sub44=0`, `active=Close` | `impeccable=1` (`body-text-viewport-edge` on `/`), `sub44=0`, `active=Close` | `impeccable=0` (`1` advisory heading scale), `active=Close` | Initial focus lands on `Close` instead of email input. |
| `SignInModal` (`auth_error=INVITE_REQUIRED&auth_provider=google`) | **`autoOpenedOnRedirect=false`**, `impeccable=0`, invite form pushed off-screen | **`autoOpenedOnRedirect=false`**, `impeccable=7` (`body-text-viewport-edge` on background page) | **`autoOpenedOnRedirect=false`**, `impeccable=0` | P0 race in `AuthStatusBanner.tsx:44-53` prevents auto-open; modal header vertically centers `Close` beside 3-line `<h2>`. |
| `SignInModal` (post-send Magic Link state) | `impeccable=0`, **`active=body`** | `impeccable=7` (`body-text-viewport-edge`), **`active=body`** | `impeccable=0`, **`active=body`** | Focus drops to `<body>` when form unmounts; `Invited via ...` info box stacks redundantly over success box. |
| `PersonPage` (signed-in `WikiActionBar` + `PronunciationBadge` Edit) | `impeccable=0`, `sub44=22` (incl. `+ Add parent/spouse/child` at `23px`), `sub12=37` | `impeccable=7` (`body-text-viewport-edge`, `left 14px`), `sub44=19`, `sub12=37` | `impeccable=0`, `sub12=37` | `+ Add parent/spouse/child` buttons are `23px` tall on `360x800`; `14px` tablet padding fails `body-text-viewport-edge`. |
| `EntityEditDrawer` (via `Pronunciation` Edit jump) | **`impeccable=1` (`nested-cards`)**, `sub44=8`, `sub12=6`, **`footerVisible=false`** (`scrollTop=725/2041`) | **`impeccable=8` (`nested-cards` + 7 `body-text-viewport-edge`)**, `sub44=8`, `sub12=6`, **`footerVisible=false`** (`495/1757`) | **`impeccable=2` (`nested-cards` + 1 backdrop `low-contrast` FP)**, `sub12=6`, **`footerVisible=false`** (`203/1182`) | No sticky header/footer; `Save Changes` (`38px`), `Edit shared` (`26px`), `Generate Audio` (`36px`) under 44px; nested bordered cards. |
| `EntityEditDrawer` (shared surname sub-editor open) | `sub44=8`, `sub12=6`, 3 nested card borders | `sub44=9` (adds `Save for all` at `36px`), `sub12=6` | `sub12=6`, focus stays on toggle | `Save for all ... records` is `36px` tall; 3 nested borders create heavy visual chrome. |
| `SourceInspectorDrawer` | **`impeccable=1` (`nested-cards`) + 1 advisory (`straggler`)**, `sub44=3` (`.drawer-close` **`55x22px`**) | **`impeccable=5` (`nested-cards` + 4 `body-text-viewport-edge`)**, `sub44=20` (`.drawer-close` **`55x22px`**, usage links `25px`) | **`impeccable=1` (`nested-cards`)**, `sub12=1` | `p.inspector-formatted-citation` nests a card inside `section.inspector-block`; `.drawer-close` misses mobile 44px rule; `Copy Citation` wraps to 2 lines at `360px`. |
| `RecentChangesPage` (`/changes`, Research Batch + expanded `RevisionDiffView`) | `impeccable=0`, `sub44=0`, `sub12=101`, **diff table unreadable** (5-char mid-word columns) | `impeccable=1` (`body-text-viewport-edge`, `left 14px`), `sub44=0`, `sub12=101` | `impeccable=0`, `sub12=101` | 3-column diff table crushes prose at `360px`; 1-click `Revert` / `Revert Entire Batch` lacks confirmation; raw ISO timestamps; unlinked entity IDs. |
| `AdminPage` (`/admin`, members + invites + agent tokens) | `impeccable=0`, `sub44=2` (`Generate Invite Link` & `Create Token` **`38px`**), `sub12=3` | `impeccable=1` (`body-text-viewport-edge`, `left 14px`), `sub44=2` (`38px`), `sub12=3` | `impeccable=0`, `sub12=3` | No `Copy Link` or `Dismiss` on new invite; no copy on active invites; 1-click `Revoke` and self-demotion `Demote to Editor`; raw ISO dates and raw scope slugs. |

False-positive triage from live CDP scans:
- `low-contrast` on `button.archival-footnote-ref` at `1280x800` while `EntityEditDrawer` is open (`pixel contrast 3.0:1`): triggered on the dimmed background page underneath `.drawer-backdrop` (`rgba(35, 39, 46, 0.42)`), not inside the active drawer. Not a foreground contrast defect.
- `h1.visually-hidden` on `/tree` in the raw DOM overflow sweep: intentional `1x1px` screen-reader-only heading. The Wave 53B Playwright gate must explicitly exclude `.visually-hidden` and `.sr-only`.

### 2.2 Per-element overflow, containment, and collision sweep (`360x800`, `390x844`, `768x1024`, `1280x800`)

Measured across all 15 routes (`/`, `/places`, `/time`, `/tree`, `/tree?surface=roll`, `/tree?surface=diagram`, `/map`, `/kinship`, `/evidence`, `/evidence?tab=citations`, `/evidence?tab=media`, `/changes`, `/admin`, `/person/abraham-lincoln-1809`, `/place/springfield-illinois`) in public, signed-in, and 3-digit stress modes. Every failing case reported `documentElement.scrollWidth === window.innerWidth` (`docOverflowX = false`), proving why document-width checks alone missed these defects.

| Route & mode | Viewport | Element | Measured box vs content | Defect class |
| --- | --- | --- | --- | --- |
| `/` (signed-in, demo 2-digit counts) | `360x800` | `button.pill-btn` (`Photos & Documents (22)`) | `box=162px`, `scroll=172px`, `leftEsc=11px`, `rightEsc=11px` | Text spills past both borders (`P0-1`) |
| `/` (signed-in, demo 2-digit counts) | `390x844` | `button.pill-btn` (`Photos & Documents (22)`) | `box=177px`, `scroll=180px`, `leftEsc=3.5px`, `rightEsc=3.5px` | Text spills past both borders (`P0-1`) |
| `/` (signed-in, 3-digit stress) | `360x800` | `button.pill-btn` (`Photos & Documents (108)`) | `box=162px`, `scroll=176px`, `leftEsc=15px`, `rightEsc=15px` | Text spills `15px` past both borders; `Export GEDCOM (128)` orphaned on row 2 (`P0-1`) |
| `/` (signed-in, 3-digit stress) | `390x844` | `button.pill-btn` (`Photos & Documents (108)`) | `box=177px`, `scroll=184px`, `leftEsc=7.5px`, `rightEsc=7.5px` | Text spills `7.5px` past both borders; `Export GEDCOM (128)` orphaned on row 2 (`P0-1`) |
| `/` (signed-in, plugin nav tab) | `360x800` & `390x844` | `a.nav-pill` (`Read Memoir Chapters`) and `a.nav-pill` (`People`) | `box=44px`, `scroll=99px`, `leftEsc=54.5px`, `rightEsc=54.5px` (`People`: `2px` each side) | Mobile `.nav-pill` lacks `flex-shrink: 0` and collapses to `44px`, overlapping neighbor tabs (`P0-1`) |
| `/tree` (signed-in, 3-digit stress) | `360x800` | `.tree-scope-segmented` (`Full Tree (128)`) vs `.tree-add-person-btn` (`+ Add Person`) | `scope.right=226px`, `FullTree.right=267px` (`+41px` parent overflow), `addBtn.left=232px` -> **`35px` overlap** | Segmented pill collides directly over `+ Add Person` (`P0-2`) |
| `/tree` (signed-in, 3-digit stress) | `390x844` | `.tree-scope-segmented` (`Full Tree (128)`) vs `.tree-add-person-btn` (`+ Add Person`) | `scope.right=256px`, `FullTree.right=267px` (`+11px` parent overflow), `addBtn.left=262px` -> **`5px` overlap** | Segmented pill clips and collides with `+ Add Person` (`P0-2`) |
| `/person/abraham-lincoln-1809` | `1280x800` | `button.scrubber-tick` (`1800s`–`1860s`) | `box=61px`, `scroll=66px` (`active`) / `62px`, `rightEsc=6px` / `2px` | Decade rail narrower than `1.24rem` bold label (`P1`) |

## 3. Prioritized Wave 53B implementation plan

### 3.1 P0 signed-in mobile layout and tree usability fixes

#### W53-U1 (P0-1): Fix `IndexPage` signed-in action bar overflow, 2+1 grid orphan, and mobile `.nav-pill` flex-shrink crush

- **Affected files:**
  - `packages/ui/src/styles/archival.css:5138-5164` (`.nav-links`, `.nav-pill` mobile rules)
  - `packages/ui/src/styles/archival.css:5371-5395` (`.index-filter-actions` at `max-width: 768px`)
  - `packages/ui/src/styles/archival.css:9398-9414` (`.index-filter-actions` rigid 2-column grid at `max-width: 480px`)
  - `packages/ui/src/pages/IndexPage.tsx:226-271`
- **Root causes:**
  1. `archival.css:9398-9414` forces `.index-filter-actions` into `grid-template-columns: repeat(2, minmax(0, 1fr))` with `width: 100%` buttons, while `archival.css:5388` locks `.index-filter-actions .pill-btn` to `white-space: nowrap` at `0.8rem` monospace (`13.2px`). At `360px` (`162px` per column) and `390px` (`177px` per column), `Photos & Documents (22)` (`~172px`) and `Photos & Documents (108)` (`~176px`) exceed the cell width and spill symmetrically outside both borders.
  2. In signed-in mode, `IndexPage.tsx:251-261` inserts `+ Add Person`, producing 3 buttons in a 2-column grid so `Export GEDCOM (128)` sits as an awkward half-width orphan on row 2.
  3. `archival.css:5155-5164` omits `flex-shrink: 0` on mobile `.nav-pill` inside `.nav-links` (`overflow-x: auto; flex-wrap: nowrap`), so adding any multi-word plugin tab causes flexbox to shrink tabs to `min-width: 44px` and crash their text into adjacent links.
  4. `archival.css:876-914` constrains the desktop `.timeline-spine` scrubber column so `button.scrubber-tick.active` (`1800s`, `1.24rem` bold) overflows its `61px` box by `6px`.
- **Proposed Wave 53B fix:**
  1. Replace the rigid 2-column grid at `archival.css:9398-9414` with a responsive wrapping or structured two-row layout:
     - Let the filter button (`Photos & Documents (N)`) span full width (`grid-column: 1 / -1` when signed in, or `flex: 1 1 auto` with `white-space: normal; text-align: center; line-height: 1.25;`) and pair secondary actions (`+ Add Person` and `Export GEDCOM (N)`) cleanly side by side on row 2 (each `50%` width, both short labels that fit inside `162px` with `> 20px` spare padding even with 4-digit counts). When read-only (2 buttons total: `Photos & Documents (N)` and `Export GEDCOM (N)`), either stack cleanly (`grid-template-columns: 1fr` on `<= 420px`) or use `display: flex; flex-wrap: wrap;` with `flex: 1 1 auto; min-width: max-content;` so neither button ever compresses below its label width.
  2. Add `flex-shrink: 0; padding: 4px 10px;` to `.nav-pill` inside `@media (max-width: 768px)` (`archival.css:5155-5164`) so `.nav-links` scrolls horizontally without crushing or crowding multi-word plugin tabs. Add subtle right-edge fade masking when `.nav-links` overflows.
  3. Widen the desktop `.timeline-spine` column by `10px` (or reduce `.scrubber-tick` font-size from `1.24rem` to `1.14rem` with `min-width: max-content`) so `1800s`–`1860s` stay strictly inside their bounding box.

#### W53-U2 (P0-2): Eliminate signed-in mobile `/tree` toolbar collision (`Full Tree (128)` vs `+ Add Person`)

- **Affected files:**
  - `packages/ui/src/components/tree/TreeToolbar.tsx:54-154`
  - `packages/ui/src/styles/archival.css:5174-5275`
- **Root cause:**
  `TreeToolbar.tsx:113-152` places `.tree-scope-segmented` (`Direct Line` | `Full Tree (128)`) and `.tree-add-person-btn` (`+ Add Person`, `118px` wide) in the same horizontal flex row `.tree-toolbar-row-secondary`. At `360x800`, `.tree-scope-segmented` receives only `216px` (`340 - 118 - 6`), while `Direct Line` (`110px`) plus `Full Tree (128)` (`142px`) needs `258px`. The segmented button escapes `.tree-scope-segmented` by `41px` and overlaps `+ Add Person` by `35px` (`5px` at `390x844`).
- **Proposed Wave 53B fix:**
  1. Move `+ Add Person` out of `.tree-toolbar-row-secondary` on mobile (`<= 768px`): render a dedicated compact `44x44px` `+` icon button (`aria-label="Add person"`, `title="+ Add Person"`, visible on `<= 768px`) in `.tree-toolbar-row-primary` beside the search toggle button, while keeping the full `+ Add Person` text button on desktop (`> 768px`).
  2. Dedicate `.tree-toolbar-row-secondary` 100% to `.tree-scope-segmented` on `<= 768px`, giving `Direct Line` and `Full Tree (N)` the full `340px` width (`~168px` each at `360px`, supporting up to 4-digit counts with zero overflow or clipping).
  3. Add `overflow: hidden` safety and `flex: 1 1 auto` (instead of `flex: 1 1 0`) on `.tree-scope-segmented .tree-seg-btn` so wider labels (`Full Tree (1280)`) take proportional width cleanly instead of fighting `Direct Line` at a forced 50/50 split.

#### W53-U3 (P0-3): Clarify Family Tree child-tray vocabulary and make cross-mode child counts transparent

- **Affected files:**
  - `packages/ui/src/lib/archivalTreeModel.ts:757-856`
  - `packages/ui/src/components/tree/TreePedigreeRoll.tsx:114-242`
  - `packages/ui/src/components/tree/TreeOrthogonalCanvas.tsx:545-580`
  - `packages/ui/src/lib/vocabulary.ts:79-80`
  - `docs/ubiquitous-language.md:36`
- **Root cause:**
  `archivalTreeModel.ts:770-810` puts all non-direct surviving children into `collateralSiblings` in `spine` mode (`9` children for a 10-child couple with 1 direct-line child), whereas in `full` mode it promotes children with spouses or descendants into `visibleChildIds` (`3` children shown as family units below) and leaves only leaf children in `collateralLeaves` (`7` children). Both `TreePedigreeRoll.tsx:207-209` and `TreeOrthogonalCanvas.tsx:550-552` label the toggle `Hide 9 siblings` vs `Hide 7 siblings` without naming the children shown below, and use the word `siblings` directly inside the parents' couple unit.
- **Proposed Wave 53B fix:**
  1. Replace `sibling` / `siblings` in parent-union trays with **other child** / **other children** (updating `KINLOOM_VOCABULARY.tree` and `docs/ubiquitous-language.md:36`).
  2. Derive transparent counts directly from `union.visibleChildIds.length` (already populated on `TreeUnion` at `archivalTreeModel.ts:851`) and `model.mode`:
     - When `visibleChildIds.length > 0` in Direct Line (`spine`):
       - Collapsed: `▸ +${hidden} other ${childWord} (${shown} in direct line below)`
       - Expanded: `▾ Hide ${total} other ${childWord} (${shown} in direct line below)`
     - When `visibleChildIds.length > 0` in Full Tree (`full`):
       - Collapsed: `▸ +${hidden} other ${childWord} (${shown} shown below)`
       - Expanded: `▾ Hide ${total} other ${childWord} (${shown} shown below)`
     - When `visibleChildIds.length === 0`: `▸ +${hidden} ${childWord}` / `▾ Hide ${total} ${childWord}`.
     - Now a 10-child couple reads `9 other children (1 in direct line below)` in Direct Line and `7 other children (3 shown below)` in Full Tree (`9 + 1 === 7 + 3 === 10`), removing the illusion of missing children.
  3. In SVG Chart View (`TreeOrthogonalCanvas.tsx:550-575`), render concise pill text (`▸ +9 other children` / `▾ Hide 9 other children`), compute pill width from character count so text never clips, and put the full transparent breakdown (`Show 7 other children (3 shown below)`) in `aria-label` and `<title>`.

#### W53-U4 (P0-4): Fix `AuthStatusBanner` redirect error race condition and `SignInModal` focus management

- **Affected files:**
  - `packages/ui/src/components/wiki/AuthStatusBanner.tsx:38-119`
  - `packages/ui/src/components/wiki/SignInModal.tsx:22-65`
  - `packages/ui/src/components/wiki/AuthSignInFlow.tsx:54-196, 222-259, 340-403`
  - `packages/ui/src/styles/archival.css:7536-7622, 7984-8000, 8324-8328`
- **Root causes:**
  1. `AuthStatusBanner.tsx:44-53` calls `consumeAuthErrorFromWindow()` inside an effect that depends on `session?.principal_kind`. On first mount, `session` is `null` while `/api/session` is in flight, so the URL params are stripped without calling `setSignInOpen(true)`. When `session` resolves to `invite_viewer`, the URL params are already gone and `SignInModal` stays closed (`autoOpenedOnRedirect = false` across all viewports). If `isDismissed` is `true` in `sessionStorage`, line 63 returns `null` and hides the error completely.
  2. `SignInModal.tsx:24-28` passes `initialFocusRef: closeBtnRef`, focusing `Close` instead of the email input.
  3. Submitting `Email Magic Link` unmounts the form while focus is on the submit button, dropping focus to `<body>` (`active=body` on all viewports).
  4. Toggling `Have a family invite link?` does not move focus to `inviteInputRef`, and auto-expanding the invite form on `INVITE_REQUIRED` pushes it below the `360x800` modal fold without scrolling it into view.
  5. `.wiki-auth-banner-link` (`105x15px`) and `.wiki-auth-banner-dismiss` (`24x24px`, `::after` `32x32px`) fail the 44px mobile touch floor at `360x800` and `768x1024`, and `.wiki-auth-banner` sets `font-size: 0.72rem` (`11.9px`).
- **Proposed Wave 53B fix:**
  1. Split `AuthStatusBanner.tsx:44-53` into two effects: effect 1 runs once on mount to consume URL params into `urlAuthError`; effect 2 runs whenever `session?.principal_kind === 'invite_viewer' && urlAuthError !== null` to call `setSignInOpen(true)`.
  2. Forward an email input ref or omit `initialFocusRef: closeBtnRef` in `SignInModal` when `magicLink` is enabled so initial focus lands on the email input (or on the alert banner heading when `initialUrlError` is present).
  3. On transition to `sentTo !== null`, focus the `.wiki-auth-sent` title (`tabIndex={-1}`); hide the `Invited via ...` info banner once `sentTo` is set to eliminate stacked duplicate banners.
  4. When `inviteOpen` opens via click or `activeFeedback.showInvitePaste`, focus `inviteInputRef` (on user click) or scroll `.wiki-invite-form` into view smoothly (respecting reduced motion) on error auto-expand.
  5. Align `.wiki-modal-header` to `align-items: flex-start`. Raise `.wiki-auth-banner-link` and `.wiki-auth-banner-dismiss` to `>= 44px` hit height and `>= 0.75rem` font size under `@media (max-width: 768px)`.

#### W53-U5 (P0-5): Make `RevisionDiffView` readable on mobile `360px` and add Revert / Batch Revert confirmations

- **Affected files:**
  - `packages/ui/src/components/wiki/RevisionDiffView.tsx:65-113`
  - `packages/ui/src/pages/RecentChangesPage.tsx:96-141, 226-367`
  - `packages/ui/src/components/wiki/RevisionHistoryPanel.tsx:62-83, 127-151`
  - `packages/ui/src/styles/archival.css:7788-7916`
- **Root causes:**
  1. `archival.css:7888` sets `white-space: nowrap` on `.wiki-diff-field-cell`. At `360x800`, `+ has_primary_source` takes ~60% of the table width, squeezing `Before` and `r443` into ~5-character columns that break words mid-word (`Capita / l`, `Illino / is`).
  2. `RecentChangesPage.tsx:244, 287, 347` and `RevisionHistoryPanel.tsx:144` call `revertBatch()` and `revertRevision()` immediately on single click with zero confirmation, even though `Revert` sits `8px` from `Hide Diff` with identical borderless styling.
  3. `RecentChangesPage.tsx:272, 332` omits `aria-expanded={isExpanded}` on `View Diff` / `Hide Diff` buttons, and `role="tablist"` at `:169` lacks `aria-controls` / `role="tabpanel"`.
  4. `.wiki-action-tag` (`archival.css:7790`) uses `0.72rem` (`11.9px`, triggering 101 sub-12px hits on `/changes`).
- **Proposed Wave 53B fix:**
  1. Add `data-label={beforeLabel}` and `data-label={afterLabel}` to `RevisionDiffView.tsx` cells and transform `.wiki-diff-table` into a stacked full-width field-card layout under `@media (max-width: 640px)` (Field header row on top, full-width rose `Before` block below, full-width sage `After` block below, `overflow-wrap: break-word`). Keep the 3-column table at `>= 641px` while setting `max-width: 28%` and `white-space: normal; overflow-wrap: break-word;` on `.wiki-diff-field-cell` for tablet `768x1024`.
  2. Add a shared inline confirmation state (or `ConfirmActionDialog` using `useDialogFocusTrap`) for `Revert Entire Batch` (displaying batch ID, revision count, and affected entities) and single `Revert` (displaying `rN` and target entity) with an optional summary reason and explicit `Confirm Revert` / `Cancel` buttons.
  3. Add `aria-expanded={isExpanded}` to every `View Diff` button in `RecentChangesPage.tsx`, link the author filter tablist to a `role="tabpanel"`, format raw ISO timestamps with a shared `<time dateTime={...} title={...}>` formatter, resolve entity display names and `<Link>` paths from `bundle` when available, and raise `.wiki-action-tag` to `0.75rem`.

#### W53-U6 (P0-6): Add sticky header/footer to `EntityEditDrawer`, flatten nested cards, and fix loading/disabled states

- **Affected files:**
  - `packages/ui/src/components/wiki/EntityEditDrawer.tsx:314-319, 539-553, 861-1250, 1375, 1407-1455`
  - `packages/ui/src/styles/archival.css:1615-1645, 7961-7970, 8216-8300, 8894-9055`
- **Root causes:**
  1. `.drawer-panel` (`archival.css:1615-1628`) scrolls as one monolithic column. Clicking `Pronunciation` Edit jumps down to `scrollTop: 725px` (`360x800`), pushing both `Close` and `Save Changes` completely off-screen (`footerVisibleInViewport = false` on all 3 viewports).
  2. `EntityEditDrawer.tsx:314, 1437-1448` merges `syncingRevision` into `isBusy`, so while loading the latest revision on open, the submit button reads `"Saving…"` and renders `"Cancel Save"`.
  3. `EntityEditDrawer.tsx:1435` disables `Save Changes` silently with no inline explanation of whether no fields changed or the 3-character summary is missing.
  4. `.wiki-pronunciation-breakdown` (`archival.css:8894-8904`) and `.wiki-pronunciation-shared-editor` (`:8961-8969`) draw bordered boxes inside `<fieldset className="wiki-citation-fieldset">`, causing Impeccable `nested-cards` failures at all three viewports.
  5. Under `@media (max-width: 768px)`, `.wiki-btn-sm` outside `.wiki-action-bar` remains `38px`, `.wiki-pronunciation-shared-toggle` is `26px`, `.wiki-pronunciation-gen-btn` and `.wiki-pronunciation-shared-save-btn` are `36px`, and 6 pronunciation sub-labels sit at `11.6px`–`11.9px`.
- **Proposed Wave 53B fix:**
  1. Split `.wiki-edit-drawer-panel` into a sticky `.drawer-top`, a scrollable `.wiki-edit-drawer-body` (`flex: 1 1 auto; overflow-y: auto`), and a sticky `.wiki-drawer-footer` containing the validation hint + `Save Changes` and `Cancel` buttons.
  2. Separate `isSaving = snapshot.hasTag('busy')` from `syncingRevision`. Show a quiet inline status `"Loading latest revision…"` while syncing instead of `"Saving…"` / `"Cancel Save"`.
  3. Render an inline helper hint beside disabled `Save Changes` (`"Change any field to save."` or `"Add a short edit summary (3+ characters) to save."`).
  4. Flatten `.wiki-pronunciation-breakdown` and `.wiki-pronunciation-shared-editor` with hairline `border-bottom` dividers and subtle surface wash instead of bordered boxes inside a bordered fieldset (eliminates `nested-cards`).
  5. Under `@media (max-width: 768px)`, enforce `min-height: 44px` on `.wiki-btn-sm`, `.wiki-pronunciation-shared-toggle`, `.wiki-pronunciation-gen-btn`, `.wiki-pronunciation-shared-save-btn`, and `.wiki-radio-card` / `.wiki-checkbox-row` labels. Raise `.wiki-pronunciation-part-label`, `.pronunciation-source`, `.wiki-pronunciation-shared-toggle`, and `.wiki-pronunciation-override-heading` to `>= 0.75rem`.
  6. Update `EntityEditDrawer.tsx:1375` copy from `labeled as uncited until verified` to `labeled as Family memory until a primary source is cited` to match `docs/ubiquitous-language.md:63-64`.

#### W53-U7 (P0-7): Add `AdminPage` invite copy controls, destructive confirmations, busy states, and self-demotion guard

- **Affected files:**
  - `packages/ui/src/pages/AdminPage.tsx:31-447`
  - `packages/ui/src/styles/archival.css:7096, 7260-7264, 7733-7761, 8285-8319`
- **Root causes:**
  1. `AdminPage.tsx:293-299` renders newly created invites as bare `<code>{createdInviteUrl}</code>` with no `Copy Link` button and no `Dismiss` button, and active rows in `invites.map` (`:302-328`) have no `Copy Link` button even though `inv.token` is already loaded.
  2. `handleToggleRole`, `handleRevokeInvite`, and `handleRevokeToken` run immediately on one click with zero confirmation and zero busy/disabled state.
  3. `AdminPage.tsx:225-245` does not compare `user.email` against `session?.email` or count active admins, letting the signed-in admin click `Demote to Editor` on themselves (either triggering a backend error as the last admin or locking themselves out immediately).
  4. `Generate Invite Link` and `Create Token` (`.wiki-btn-primary.wiki-btn-sm`) measure `38px` tall on `360x800` and `768x1024`. Raw ISO timestamps (`2026-11-24T13:15:00.000Z`) and raw token scope identifiers (`write_batch`, `read_backup`) clutter every row.
- **Proposed Wave 53B fix:**
  1. Add `Copy Invite Link` (with 2-second `"Copied"` state + `aria-live="polite"`) and `Dismiss` to the created-invite banner, plus a `Copy Link` button (`${window.location.origin}/invite/${inv.token}`) on every active invite row.
  2. Add inline confirmation (`Revoke` -> `Confirm Revoke` / `Cancel`, `Demote to Editor` -> `Confirm Demote` / `Cancel`) and per-action `busyKey` disabling (`"Creating…"`, `"Updating…"`, `"Revoking…"`) to prevent double-submits and accidental revocations.
  3. Read `session` from `useArchiveData()`, badge the signed-in admin row with `(You)`, and disable self-demotion (and demotion when `adminCount <= 1`) with an explicit accessible reason.
  4. Style member role buttons with `.wiki-btn-secondary.wiki-btn-sm` (clear archival border), bump all `.wiki-btn-sm` to `min-height: 44px` on `<= 768px`, raise `.wiki-role-chip` to `0.75rem`, format dates cleanly via `<time>`, and display friendly token scope labels (`Research updates` / `Read-only backup`).

### 3.2 P1 signed-in polish, Impeccable cleanup, and ubiquitous-language alignment

#### W53-U8 (P1): Fix child-card spouse truncation on `/tree`

- **Affected files:**
  - `packages/ui/src/components/tree/TreePedigreeRoll.tsx:82-89, 221-235`
  - `packages/ui/src/styles/archival.css:2873-2899`
- **Root cause:** `TreePedigreeRoll.tsx:222` reads only `model.peopleById.get(sid)?.given_name` (dropping the spouse's surname completely, producing a date line such as `1807–1828 · m. Aaron` instead of `m. Aaron Grigsby` on a single cramped monospace line that looks abruptly cut off mid-name).
- **Proposed Wave 53B fix:** Resolve the spouse's `full_name` (or `formatTreeCardName(spouse.full_name, 26)` for very long names, plus ` (+N)` if multiple spouses) and render it on a dedicated `<span className="tree-roll-card-spouse">` line directly beneath `.tree-roll-card-dates` with clean word wrapping (`overflow-wrap: break-word; line-height: 1.25;`).

#### W53-U9 (P1): Fix `SourceInspectorDrawer` Impeccable `nested-cards`, `22px` mobile Close button, and tablet `14px` padding

- **Affected files:**
  - `packages/ui/src/components/SourceInspectorDrawer.tsx:111-119, 191-199`
  - `packages/ui/src/styles/archival.css:4988-5010, 5315-5320, 5857-5859, 6783-6795, 8285-8300`
- **Root causes:**
  1. `p.inspector-formatted-citation` (`archival.css:6783-6794`) nests a bordered card inside `section.inspector-block`, triggering Impeccable `nested-cards` at `360x800`, `768x1024`, and `1280x800`.
  2. `SourceInspectorDrawer.tsx:114` uses `className="drawer-close"` instead of `.pill-btn`, so it measures `55x22px` on `360x800` and `768x1024`.
  3. `archival.css:5319` (`.index-page, .time-page, .places-index-page, .place-page`) and `:5858` (`.narrative-pane`) drop horizontal padding to `14px` inside `@media (max-width: 768px)`, triggering Impeccable `body-text-viewport-edge` (`< 16px` above `480px`) across every page at `768x1024`.
  4. `.person-family-add-btn` (`archival.css:4988-5003`) stays `23px` tall and `11.9px` font on `360x800`.
- **Proposed Wave 53B fix:**
  1. Replace the inner box border on `.inspector-formatted-citation` with a left hairline quote bar (`border: none; border-left: 2px solid var(--border-control); background: transparent; padding: 4px 0 4px 12px;`).
  2. Add `.drawer-close` and `.person-family-add-btn` to the `@media (max-width: 768px)` `min-height: 44px` touch-target block, add `white-space: nowrap` on `.inspector-block-header .source-action-btn`, and give `.inspector-usage-link` comfortable tap padding on `<= 768px`.
  3. Raise horizontal page padding at `archival.css:5319` and `:5858` from `14px` to `16px` (`18px` at `481px..768px`) so `768x1024` clears `body-text-viewport-edge` with `0` hits.
  4. Align ubiquitous-language copy in `ExplorerTopBar.tsx:404, 417` (`Recent Changes` -> `Revision History`; align `Site Settings` / `Site Administration`) and `PlacePage.tsx:309, 322` (use `KINLOOM_VOCABULARY.person.editPronunciation` / `addPronunciation` instead of hardcoded strings).

### 3.3 Archive maintenance CLI upgrades (Wave 53B)

#### W53-C1 (P0): Drift-safe `--pending-only` detection with integration receipts and field-preserving merges

- **Affected files:**
  - `packages/cli/src/commands/ops/integrate.ts:616-653, 821-918, 1096-1128, 1502-1692, 1959-2075`
  - `packages/cli/src/commands/ops/integrate-batch.ts:23-33, 141-225, 395-445, 498-614`
  - `packages/cli/src/commands/ops/audit-overlaps.ts:256-267, 997-1052`
  - `packages/cli/src/commands/ops/help.ts:16-73`
  - `packages/cli/src/cli.ts:902-1183`
- **Root cause:**
  `classifyStagedPackages()` (`integrate-batch.ts:187-224`) determines whether a package is `already_integrated` solely by running `runIntegrateCommand({ dryRun: true })` and testing `hasUnintegratedEffect(dryRunResult)`. Because `upsertById` (`integrate.ts:1096-1128`) performs full-object replacement on `narratives` (`:1689`), `media` (`:1613`), and `sources` (`:1525`), and partial overwrites on `places` (`:1502`), `events` (`:620`), and `people` (`:837`), ANY post-integration migration or edit to live YAML (such as backfilling `has_primary_source: true` on `narratives.yaml`, updating `updated_at`, refining a biography typo, or adding a pronunciation) makes `JSON.stringify(prev) !== JSON.stringify(incoming)` evaluate to `true`. The already-integrated package flips back to `pending`, and running `kinloom integrate --all-staged --pending-only` silently re-applies the stale patch and clobbers newer live YAML.
- **Proposed Wave 53B design (two-layer defense):**
  1. **Layer 1: Per-package content-hashed integration receipt (`research/people/<person_id>/.integrated.json`).**
     - Verified safe with existing scanners: `listStagedAuditPersonIds` (`audit-overlaps.ts:256-267`) checks only for `patch.json`, and `collectScanCollisions` (`:435-455`) and `audit.ts` scan only `scans/`, so `.integrated.json` inside `research/people/<person_id>/` breaks zero existing commands.
     - Schema (written atomically via `writeFileAtomic` on every non-`dryRun` write in `executeIntegrateSingle`, and included in `BatchSnapshot` rollback in `integrate-batch.ts`):
       ```json
       {
       	"schema_version": 1,
       	"person_id": "per_arthur_alder",
       	"patch_sha256": "<sha256 hex of raw patch.json>",
       	"scans_sha256": { "census_1880.jpg": "<sha256 hex>" },
       	"integrated_at": "2026-11-26T21:00:00.000Z",
       	"integrated_entity_ids": {
       		"people": ["per_arthur_alder"],
       		"events": ["evt_1880_census"],
       		"places": ["plc_springfield"],
       		"sources": ["src_1880_census"],
       		"media": ["med_1880_scan"],
       		"narratives": ["nar_arthur_bio"]
       	}
       }
       ```
     - Deterministic classification state machine in `classifyStagedPackages()`:
       - **`already_integrated` (`reason: 'receipt_match'`):** `.integrated.json` exists and its `patch_sha256` + `scans_sha256` match the package files on disk. Always skipped by `--all-staged --pending-only`, regardless of later live YAML migrations or wiki edits.
       - **`pending` (`reason: 'package_modified'`):** `.integrated.json` exists, but `patch.json` or `scans/` changed on disk. Re-queued as pending because the author deliberately updated the staged package.
       - **`already_integrated` (`reason: 'exact_match'`):** No `.integrated.json` yet (legacy archive), and dry-run diff has `hasUnintegratedEffect === false`. Skipped safely.
       - **`already_integrated_drifted` (`reason: 'live_superseded'`):** No `.integrated.json` yet, `added === 0` across all entity buckets, `removed* === 0`, all `stagedScans` are `unchanged`, AND every entity touched by `patch.json` already exists in live YAML (including any `kind === 'biography'` narrative for `person_id`) with differences limited to live-only fields (such as `has_primary_source`, `updated_at`, `pronunciation`, `extensions.*`, or newer live edits). Skipped by `--pending-only` and reported separately in `skippedDrifted` with an explicit warning (`"Skipped N legacy already-integrated package(s) whose live YAML has diverged; run 'kinloom integrate <person_id>' explicitly to re-apply or '--mark-integrated' to record receipts"`).
       - **`pending` (`reason: 'changes'` or `'error'`):** New unintegrated records (`added > 0`, un-staged scans, explicit removals) or validation errors. Never silently skipped.
     - Explicit single-person `kinloom integrate <person_id>` always executes regardless of `.integrated.json` and refreshes the receipt on write. Add `kinloom integrate --all-staged --pending-only --mark-integrated` (or `--reconcile-receipts`) to backfill receipts for legacy archives cleanly.
  2. **Layer 2: Non-destructive field-preserving merges in `integrate.ts`.**
     - Add `mergeExisting` callbacks for `narrativesMerge` (`:1689`), `mediaMerge` (`:1613`), `sourcesMerge` (`:1525`), and `placesMerge` (`:1502`) so live-only optional fields absent from the incoming patch (`has_primary_source` via `mergedPrimarySourceFlag`, `updated_at`, `pronunciation`, and live-only `extensions` keys) are preserved instead of deleted on upsert.
     - Normalize `JSON.stringify` equality checks using deterministic key sorting (or canonical comparison) so key-order differences never register as spurious updates.

#### W53-C2 (P0): Safe dry-run-first `kinloom media dedupe` command with atomic reference rewiring and rollback

- **Affected files:**
  - New module: `packages/cli/src/commands/ops/media-dedupe.ts`
  - `packages/cli/src/commands/ops/verify.ts:682-684` (actionable remediation hint)
  - `packages/cli/src/commands/ops/help.ts` & `packages/cli/src/commands/ops/index.ts`
  - `packages/cli/src/cli.ts` (register `kinloom media dedupe [--repo <dir>] [--apply] [--prefer <id>...] [--json]`)
  - Reuses `normalizeMediaFilePath` (`live-media-collisions.ts:26-33`), `extractNarrativeCitations` / `validateNarrativeCitations` (`packages/core/src/citations.ts`), and the atomic byte-snapshot rollback helper pattern (`integrate-batch.ts:297-379`).
- **Root cause:**
  Legacy imports and multi-agent merges can leave two or more `data/media.yaml` records pointing to the same normalized file path. `kinloom verify` (`verify.ts:252-275`) rightly fails check 5 (`media: duplicate file '<file>' on id1, id2`), but operators currently must manually inspect captions, merge `person_ids`, rewrite inline narrative citations (`[^src_id|med_id]`), and edit `media.yaml` by hand, risking dangling citations or lost provenance.
- **Proposed Wave 53B design:**
  1. **Command interface (dry-run by default):**
     - `kinloom media dedupe [--repo <dir>] [--prefer <media_id> ...] [--apply] [--json]`
     - Without `--apply`, executes in **read-only dry-run mode**: computes the full merge plan, validates the post-merge archive in memory, prints every group (canonical survivor, retired IDs, merged fields, rewritten citation locations, and any metadata conflicts), and writes zero files.
     - Update `verify.ts:682-684` error text to include `Run 'kinloom media dedupe' to preview a safe merge plan (pass '--apply' to write).`
  2. **Deterministic canonical survivor selection (per duplicate normalized `file` group):**
     1. Explicit `--prefer <media_id>` match (reject conflicting `--prefer` flags targeting two IDs in the same group with exit code 2).
     2. Highest total reference count across `data/narratives.yaml` inline `[^src_id|med_id]` tokens and any `extensions` media references across `data/*.yaml`.
     3. Highest metadata completeness score (non-null `source_id`, `event_id`, `provenance`, `date_edtf`, `person_ids` count).
     4. Longest non-empty trimmed `caption`.
     5. Lexicographically smallest `id` (deterministic tie-breaker).
  3. **Lossless metadata merge rules (`mergeDuplicateMediaGroup`):**
     - `person_id` / `person_ids`: union all unique IDs from `getMediaPersonIds(item)` across the group (preserving `canonical.person_id` when set and storing the full deduplicated union in `person_ids`).
     - `caption`: keep the canonical caption (or longest non-empty caption if canonical is empty); preserve any distinct non-substring caption from retired records in `extensions.alternate_captions` so zero caption text is lost.
     - `provenance`: preserve every unique provenance note (deduplicated, joined cleanly or preserved in `extensions.alternate_provenance` when distinct).
     - `source_id` / `event_id`: fill missing/null values on canonical from retired records. If two duplicates carry *conflicting* non-null `source_id` or `event_id` values, preserve canonical's primary value, record additional IDs in `extensions.additional_source_ids` / `extensions.additional_event_ids`, and emit an explicit warning in the dry-run report.
     - `date_edtf`, `page`, `thumb_file`, `mime_type`, `duration_seconds`, `poster_url`, `transcript_url`: fill missing/null canonical fields from retired records in deterministic survivor-score order.
     - `has_primary_source`: `true` if any record in the group has `has_primary_source === true`.
     - `extensions`: merge unique keys (canonical wins on collision) and record `extensions.merged_from_media_ids: string[]` (sorted unique retired IDs) for full auditability.
  4. **Complete atomic reference rewiring across `data/*.yaml`:**
     - `data/narratives.yaml`: rewrite every inline citation token `[^src_id|retired_med_id]` -> `[^src_id|canonical_med_id]` inside `body_md`, using the exact code-fence and inline-code-span-skipping scanner from `packages/core/src/citations.ts:6-7` so code examples are never corrupted.
     - `data/people.yaml`, `data/places.yaml`, `data/events.yaml`, `data/narratives.yaml`, `data/narrative_enrichments.yaml`: recursively scan any `extensions.media_ids` or `extensions.media_refs` arrays and replace retired IDs with `canonical_med_id` (deduplicating the resulting array).
     - Read-only staged-package check: scan `research/people/*/patch.json` and warn in the report if any pending staged patch still references a retired `media_id` (never mutating `research/` automatically).
  5. **In-memory pre-write verification, transactional rollback, and idempotence:**
     - Before writing any file on `--apply`, validate all merged records with Zod (`MediaItemSchema`, `NarrativeSchema`), run `validateNarrativeCitations`, run dual-mode `compileArchive` (`private` and `public`) + `auditBundlePrivacy` (`0` leaks, `0` review flags), and assert `findDuplicateNormalizedMediaFiles(mergedMedia).length === 0`.
     - Capture an exact byte snapshot of every modified `data/*.yaml` file, write atomically via temp file + `fs.renameSync`, and automatically restore the byte snapshot if any write throws.
     - Running `kinloom media dedupe --apply` a second time finds `0` duplicate groups, writes `0` files, and exits `0`.

## 4. Wave 53B acceptance gates and regression assertions

Every Wave 53B PR must pass all of the following automated checks in addition to `npm run check`:

### 4.1 Permanent Playwright per-element overflow, containment, and collision gate (`e2e/ux-regression.spec.ts` or `e2e/wiki-live.spec.ts`)

Run across all core routes (`/`, `/places`, `/time`, `/tree`, `/tree?surface=roll`, `/tree?surface=diagram`, `/map`, `/kinship`, `/evidence`, `/changes`, `/admin`, `/person/abraham-lincoln-1809`, `/place/springfield-illinois`) in BOTH public and signed-in admin modes at `360x800`, `390x844`, `768x1024`, and `1280x800`, INCLUDING a 3-digit count stress fixture (`Photos & Documents (108)`, `Export GEDCOM (128)`, `Full Tree (128)`, plus a multi-word plugin nav tab `Read Memoir Chapters`):

1. **Document horizontal overflow:** `document.documentElement.scrollWidth <= window.innerWidth + 1`.
2. **Per-element text overflow and border escape:** For every visible `button, a[href], [role="tab"], [role="menuitem"], .pill-btn, .nav-pill, .wiki-btn-primary, .wiki-btn-secondary, .wiki-badge, .wiki-author-pill, .wiki-role-chip, .wiki-action-tag, h1, h2, h3, h4` (excluding `.visually-hidden`, `.sr-only`, `.lightbox-backdrop-close`, `.skip-to-content`, and SVG children):
   - Assert `el.scrollWidth <= el.clientWidth + 1.5` (unless the element itself is an intentional horizontal scroll container with `overflow-x: auto|scroll`).
   - Walk every non-empty text node with `Range.getClientRects()` and assert `textRect.left >= boxRect.left - 1.5` and `textRect.right <= boxRect.right + 1.5`.
3. **Parent container containment:** Every visible interactive child inside `.index-filter-actions`, `.tree-toolbar`, `.tree-scope-segmented`, `.wiki-action-bar`, and `.evidence-tabs` stays inside its non-scrollable parent bounds (`childRect.left >= parentRect.left - 1` and `childRect.right <= parentRect.right + 1`).
4. **Zero sibling bounding-box collision:** No two visible interactive controls within the same toolbar or action bar (`.topbar`, `.nav-links`, `.index-filter-actions`, `.tree-toolbar`, `.wiki-action-bar`, `.evidence-tabs`) overlap by more than `1px` on both axes.

### 4.2 Signed-in UX and Impeccable acceptance assertions

- **Impeccable CDP zero-primary gate:** `impeccable detect --json --no-advisory --cdp <port>` returns `0` primary findings across `SignInModal`, `PersonPage` (signed-in), `EntityEditDrawer` (open on Pronunciation), `SourceInspectorDrawer`, `RecentChangesPage` (expanded diff), and `AdminPage` at `360x800`, `768x1024`, and `1280x800` (fixing `nested-cards` in `EntityEditDrawer` and `SourceInspectorDrawer`, `body-text-viewport-edge` at `768x1024`, and `text-overflow` on `/`).
- **Touch targets and type floor:** `0` interactive controls `< 44px` tall inside signed-in toolbars, drawers, modals, `AuthStatusBanner`, `SourceInspectorDrawer`, and `AdminPage` at `360x800` and `768x1024`; `0` rendered UI labels `< 12px`.
- **Auth redirect & focus Playwright test:** Navigating an `invite_viewer` to `/person/abraham-lincoln-1809?auth_error=INVITE_REQUIRED&auth_provider=google` automatically opens `SignInModal` after `/api/session` resolves; submitting Magic Link moves focus inside `.wiki-auth-sent` (never `<body>`); `Escape` closes and restores focus.
- **Edit Drawer sticky footer Playwright test:** Clicking `Edit` on `PronunciationBadge` scrolls to the Pronunciation fieldset while keeping `.drawer-top` and `.wiki-drawer-footer` (`Save Changes` / `Cancel`) visible inside the viewport at `360x800`, `768x1024`, and `1280x800`.
- **Tree child-tray & spouse test:** Switching `/tree?surface=roll` between Direct Line and Full Tree renders `other children (... in direct line below)` vs `other children (... shown below)` whose counts sum to the identical surviving child total, and child cards display full spouse names without mid-name truncation.
- **Diff readability & destructive confirmation Playwright test:** At `360x800`, `RevisionDiffView` stacks `Before` and `After` full-width (`>= 260px` wide); clicking `Revert`, `Revert Entire Batch`, `Revoke`, or `Demote to Editor` requires an explicit second confirmation click; self-demotion is disabled on the signed-in admin's own row; `AdminPage` renders a working `Copy Invite Link` button for newly created and active invites.

### 4.3 CLI Vitest acceptance assertions

- **`--pending-only` drift suite (`packages/cli/src/commands/ops/integrate-batch.test.ts`):**
  1. Integrate package `per_arthur_alder` -> verify `.integrated.json` receipt is written with matching `patch_sha256` and `scans_sha256`.
  2. Mutate live `data/narratives.yaml` to add `has_primary_source: true` and an updated prose sentence -> run `kinloom integrate --all-staged --pending-only --json` and `kinloom audit --all-staged --pending-only --json` -> assert `per_arthur_alder` is skipped (`already_integrated`, `reason: 'receipt_match'`) and the live edit is untouched.
  3. Edit `research/people/per_arthur_alder/patch.json` -> assert `classifyStagedPackages()` marks it `pending` (`reason: 'package_modified'`).
  4. Delete `.integrated.json` (legacy archive simulation) after a live `has_primary_source: true` migration -> assert `--all-staged --pending-only` classifies it as `already_integrated_drifted` (`reason: 'live_superseded'`), skips overwriting live YAML, and reports it in `skippedDrifted`.
  5. Verify rollback on batch failure restores `.integrated.json` receipts alongside `data/*.yaml`.
- **`kinloom media dedupe` suite (`packages/cli/src/commands/ops/media-dedupe.test.ts`):**
  1. Seed duplicate `media.yaml` records pointing to the same normalized file path (`/media/scans/census_1880.jpg` and `media/scans/./census_1880.jpg`) with distinct `person_ids`, distinct `caption` and `provenance` notes, one inline narrative citation `[^src_1880|med_dup_2]`, and an `extensions.media_ids` reference.
  2. Run `kinloom media dedupe --json` (dry-run default) -> assert `0` files modified on disk, canonical survivor selected deterministically, and merge/rewrite plan reported accurately.
  3. Run `kinloom media dedupe --apply --json` -> assert `data/media.yaml` has `1` merged record preserving all unique `person_ids`, captions, provenance, and `extensions.merged_from_media_ids`; `data/narratives.yaml` rewrote `[^src_1880|med_dup_2]` to the canonical ID while leaving fenced code blocks untouched; `kinloom verify` passes with `0` duplicate media errors and `0` dangling citations.
  4. Re-run `kinloom media dedupe --apply --json` -> assert idempotent no-op (`0` duplicates, `0` files written, exit `0`).
  5. Simulate write failure mid-apply -> assert full byte-for-byte rollback of `data/media.yaml` and `data/narratives.yaml`.
