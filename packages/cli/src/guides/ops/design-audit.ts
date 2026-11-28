import type { EmbeddedGuide } from '../types.js';

export const DESIGN_AUDIT_GUIDE: EmbeddedGuide = {
  id: 'design-audit',
  command: 'design-audit',
  category: 'ops',
  summary: 'Run deterministic UI/UX design audits (APCA, WCAG 2.2, DTCG tokens, SARIF 2.1.0)',
  body: `# Design Audit (\`kinloom design-audit\`)

Run a deterministic-first, reference-anchored UI/UX audit across twelve universal interface quality metrics grounded in twenty-four design masters. Never score an interface from static source code alone when a live rendered surface is available, and never allow a visual critic to override a failing deterministic probe.

## Subcommands

### 1. Run a full deterministic audit (\`run\` — default)

\`\`\`bash
kinloom design-audit --url http://127.0.0.1:4173 --routes /,/tree,/places --archetype editorial
\`\`\`

- Captures archetype viewports in \`light\` and \`dark\` modes plus live \`prefers-reduced-motion: reduce\` checks.
- Evaluates APCA \`0.0.98G-4g-base-W3\` perceptual contrast (public-beta WCAG 3 candidate) paired with WCAG 2.2 AA/AAA contrast ratios, dark-mode large-text halation (> Lc 90), WCAG 1.4.10 horizontal reflow, WCAG 2.5.8 touch target bounds, WCAG 2.4.11/2.4.13 focus occlusion & perimeter, and WCAG 1.4.12 text-spacing clipping.
- Runs static CSS entropy and W3C DTCG 2025.10 \`.tokens.json\` / \`.resolver.json\` checks.
- Emits OASIS SARIF 2.1.0 (\`design-audit.sarif\`) with SHA-256 \`partialFingerprints\` and baseline ratchet diffing, plus an Executive Dossier (\`audit-dossier.md\`).
- Automatically degrades to \`static-degraded\` mode when \`--static-only\` is passed or a browser/URL is unavailable.

### 2. Scaffold an audit plan (\`init\`)

\`\`\`bash
kinloom design-audit init --url http://127.0.0.1:4173 --archetype editorial --routes /,/tree,/map
\`\`\`

### 3. Run offline CSS & DTCG token checks (\`css\`)

\`\`\`bash
kinloom design-audit css --repo . --archetype editorial --json
\`\`\`

### 4. Re-aggregate SARIF 2.1.0 & Executive Dossier (\`sarif\`)

\`\`\`bash
kinloom design-audit sarif --bundle .audit-artifacts/<run-id> --baseline .audit-baseline.sarif
\`\`\`

Merges \`track-a-deterministic.json\`, \`track-a-css-tokens.json\`, \`track-a-clutter.json\`, \`track-b-findings.json\`, and \`phase-3b-findings.json\` (deterministic findings always supersede overlapping visual findings).

### 5. Inspect calibrated archetypes & pinned standards

\`\`\`bash
kinloom design-audit archetypes [--archetype editorial|saas|ecommerce|mobile-app] [--json]
kinloom design-audit standards [--json]
\`\`\`

## Privacy

Follow the **Living Privacy Rule**: audit public or redacted builds when exporting screenshot bundles, DOM telemetry, or SARIF reports so living people are never exposed in shared artifacts.

## Reference Subguides

- \`kinloom guide design-audit/rubric\` — Twelve-metric extreme anchors (Score 1 vs. Score 5) and swapped-order pairwise comparison protocol
- \`kinloom guide design-audit/prompts\` — Isolated Track B visual critic and Phase 3B code-translator prompt templates`,
  subguides: {
    rubric: `# Reference-Anchored Critique Rubrics and Calibration Rules

Use extreme-anchored scoring (Score 1 vs. Score 5) and swapped-order pairwise comparisons to suppress visual scoring drift, position bias, and permissive clustering.

## Pairwise Comparison Protocol (Swapped-Order A/B)

1. Run Pass 1 with order \`(Option 1 = Reference/Baseline, Option 2 = Candidate)\` with an explicit \`TIE\` option.
2. Run Pass 2 with swapped order \`(Option 1 = Candidate, Option 2 = Reference/Baseline)\` with \`TIE\`.
3. Consistent winner across both passes -> \`candidate_wins\` or \`reference_wins\`. Contradictory winners -> \`swapped_conflict\` (never \`severity: "error"\`).

## Pillar I — Clarity & Information Architecture (Metrics 01-03)

- **01 Content-to-Chrome Yield:** Score 1: stacked chrome/banners consume >60% of viewport creating a false floor. Score 5: primary content owns the first screen with immediate scent.
- **02 IA & Taxonomy Cohesion:** Score 1: competing classification axes stack on one view or internal jargon leaks. Score 5: one coherent user-centered taxonomy governs each view.
- **03 Proportionality & Cognitive Load:** Score 1: stacked toolbars/competing CTAs overwhelm small datasets. Score 5: controls scale proportionally with progressive disclosure (Shrink, Hide, Embody).

## Pillar II — Visual Craft & Design Systems (Metrics 04-06)

- **04 Visual Hierarchy & Squint Clarity:** Score 1: under blur, competing boxes collapse into noise and deep links fail the Trunk Test. Score 5: unmistakable primary focal point and clean grid alignment.
- **05 Typographic Discipline:** Score 1: clashing typefaces, stretched/cramped measure, bold+italic collisions, or ALL-CAPS multi-line headings. Score 5: restrained type scale, disciplined measure, quiet baseline rhythm.
- **06 Geometric & Token Harmony:** Score 1: inconsistent corner radii, ad-hoc colors, or broken alignment under varying string lengths. Score 5: shared semantic radii, elevation, and spacing rhythms.

## Pillar III — Ergonomics & Visual Calm (Metrics 07-09)

- **07 Affordance, Signifiers & Predictability:** Score 1: interactive actions look identical to static text or filters look identical to destructive actions. Score 5: unmistakable, distinct signifiers with reversible interactions.
- **08 Spatial Calm & Negative Space:** Score 1: stacked 1px cage borders and redundant status pills crowd the screen. Score 5: deliberate negative space and subtle surface shifts without decorative clutter.
- **09 Contrast & Dual-Theme Parity:** Score 1: muddy contrast on tinted surfaces, harsh pure-white halation in dark mode, or broken theme parity. Score 5: independent light/dark palettes with effortless legibility.

## Pillar IV — Mobile, Microcopy & States (Metrics 10-12)

- **10 Mobile Ergonomics & Zero Collision:** Score 1: cramped tap targets (<44px), clipped 360px titles, or horizontal overflow. Score 5: comfortable thumb reach, generous bottom scroll padding, zero collision.
- **11 Wayfinding, Scent & Microcopy:** Score 1: vague link labels, repeated site prefixes bloating H1s, or contradictory voice. Score 5: concise, clear copy with rich information scent.
- **12 State Completeness & Perceived Polish:** Score 1: blank screens on empty results, cryptic errors, or spatial animations ignoring \`prefers-reduced-motion\`. Score 5: all five UI Stack states (Ideal, Loading, Empty, Partial, Error) feel intentional.`,
    prompts: `# Isolated Subagent Prompt Templates

## Strict Isolation Contract

- **Track B Visual Critics (\`pillar-1\` through \`pillar-4\`):** Read ONLY screenshots, archetype reference images, rubric anchors, and compact Track A telemetry JSON. Never pass repository source code or CSS files to Track B critics.
- **Phase 3B Code-Translation Critic (\`code-translator\`):** Runs AFTER Track A and Track B complete. Maps each defect to \`file:line\` physical locations and minimal semantic token or component fixes.

## Track B Template (Instantiate Once per Pillar)

- Cover Pillar \`{{PILLAR_ID}}\` (Metrics \`{{METRIC_IDS}}\`) for archetype \`{{ARCHETYPE}}\`.
- Do NOT read repository source code or override failing deterministic probes.
- Use swapped-order pairwise comparison with \`TIE\` and anchor every defect to \`screenshotUri\` + \`boundingBoxPx\` \`[x, y, w, h]\`.
- Emit JSON matching the \`DesignAuditFinding\` schema into \`track-b-findings.json\`, then run \`kinloom design-audit sarif --bundle <dir>\`.

## Phase 3B Code-Translation Template

- Read \`track-a-deterministic.json\`, \`track-a-css-tokens.json\`, and \`track-b-findings.json\`.
- Populate \`physicalLocation\` (\`uri\`, \`startLine\`, \`selector\`) and \`remediationHint\` preferring root-cause semantic token or atomic component fixes.
- Write enriched array to \`phase-3b-findings.json\` and run \`kinloom design-audit sarif --bundle <dir>\`.`,
  },
};
