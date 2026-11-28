# Specialty Stories Authoring Guide

Kinloom Specialty Stories enable AI agents and family historians to author, validate, build, and publish interactive, citation-grounded stories for deceased individuals in a Kinloom archive.

## Supported Formats

| Format | Best For | Player Interaction |
|---|---|---|
| `documentary` | Timed visual narratives (16:9 widescreen or 9:16 portrait short) with captions and optional narration audio + word timestamps | Play/pause, beat scrubber, keyboard shortcuts (`Space`, `←`/`→`, `C` for captions), optional audio sync |
| `scroll` | Long-form archival essays paired with a sticky visual/artifact stage | Scroll-synced or click-focused narrative cards with pull quotes and synchronized visual panel |
| `map` | Chronological place-to-place migrations and life journeys | Interactive SVG route map, clickable dated pins, and chronological stepper (`←`/`→`) |

## Agent Workflow

### 1. Scaffold a Story Workspace

```bash
kinloom stories init \
  --person person-ada-lovelace \
  --format documentary \
  --title "Ada's Analytical Engine" \
  --out ./stories/adas-analytical-engine
```

Optional flags:
- `--site <url>` (plus `--token` or `KINLOOM_TOKEN`): hydrates `personName` and `birthYear` directly from `GET /api/bundle`.
- `--aspect-ratio <16:9|9:16>`: configures portrait or widescreen staging for `documentary` stories.

This creates:
- `story.json` — typed `SpecialtyStory` bundle (`schemaVersion: 1`)
- `style.json` — visual theme preferences mapped to Kinloom DTCG tokens
- `assets/` — local images, archival scans, illustrations, or narration audio

### 2. Author Beats & Ground Every Claim

Every beat must include:
- Unique `id`
- Non-empty prose (`narration` for `documentary`, `body` for `scroll`, `narrative` for `map`)
- Non-empty `caption` (kept concise for accessible live captions and screen readers)
- `citationIds` referencing entries in top-level `citations[]`

Format-specific invariants:
- **`documentary`**: `startMs` must be strictly monotonic and non-overlapping (`beats[i].startMs >= beats[i-1].startMs + beats[i-1].durationMs`). Optional `wordTimestamps` must also be monotonic (`startMs <= endMs`, non-overlapping).
- **`scroll`**: Each beat must have a unique `key` for step anchoring.
- **`map`**: Stops must be ordered chronologically (`beats[i].year >= beats[i-1].year`) with valid WGS-84 coordinates (`lat` in `[-90, 90]`, `lng` in `[-180, 180]`).

### 3. Validate Deterministically

```bash
kinloom stories validate ./stories/adas-analytical-engine
# Machine-readable JSON diagnostics for agent loops:
kinloom stories validate ./stories/adas-analytical-engine --json
```

`validateStoryBundle` checks schema validity, person linkage, unique beat/citation IDs, non-empty captions and prose, valid citation references, monotonic timestamps/dates, and existence of every local asset referenced in `assets/`.

### 4. Build Portable Artifacts

```bash
kinloom stories build ./stories/adas-analytical-engine --out ./dist/stories
```

Compiles `<slug>.story.json` (normalized bundle), `<slug>.html` (self-contained offline HTML preview with light/dark mode and embedded JSON), and copies `assets/`.

### 5. Publish & List

```bash
# Dry-run verification:
kinloom stories publish ./stories/adas-analytical-engine --dry-run

# Local static archive manifest (default: public/stories/stories-manifest.json):
kinloom stories publish ./stories/adas-analytical-engine --out ./public/stories

# Remote Kinloom server endpoint:
kinloom stories publish ./stories/adas-analytical-engine --site https://archive.example --token "$KINLOOM_TOKEN"

# List published stories (optionally filtered by person):
kinloom stories list --person person-ada-lovelace
```

## UI Plugin Integration

Register `storiesUiPlugin` (or `createStoriesUiPlugin(...)`) in your `KinloomApp` `plugins` array:

```tsx
import { createStoriesUiPlugin, KinloomApp } from '@kinloom/ui';

export function ArchiveApp() {
  const storiesPlugin = createStoriesUiPlugin({
    basePath: '/stories',
  });
  return <KinloomApp plugins={[storiesPlugin]} />;
}
```

Registered UI seams:
- **`personDetail` slot**: Renders a compact **Specialty Stories** shelf on deceased individuals' `PersonPage` (automatically hidden when no stories exist or for living individuals).
- **`/stories` route**: Filterable index of all published stories (`All Formats`, `Documentary`, `Scroll Story`, `Journey Map`).
- **`/stories/:slug` route**: Accessible, dark-mode and `prefers-reduced-motion` aware Story Player for all three formats.
