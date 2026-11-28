import type { SpecialtyStory, StoryManifestEntry, StoryMediaRef } from '../schemas/stories.js';

/**
 * Computes total runtime in milliseconds for a Specialty Story.
 * Documentary stories sum exact beat timing; scroll and map stories estimate reading time (~12s per beat).
 */
export function computeStoryDurationMs(story: SpecialtyStory): number {
  if (story.format === 'documentary') {
    let maxEnd = 0;
    for (const beat of story.beats) {
      const end = beat.startMs + beat.durationMs;
      if (end > maxEnd) {
        maxEnd = end;
      }
    }
    return maxEnd;
  }
  return story.beats.length * 12_000;
}

/**
 * Builds a portable manifest summary entry from a validated Specialty Story.
 */
export function buildStorySummary(
  story: SpecialtyStory,
  options: { readonly bundlePath?: string | undefined; readonly publishedAt?: string | undefined } = {}
): StoryManifestEntry {
  const durationMs = computeStoryDurationMs(story);
  return {
    id: story.id,
    slug: story.slug,
    personId: story.personId,
    ...(story.personName !== undefined ? { personName: story.personName } : {}),
    title: story.title,
    ...(story.subtitle !== undefined ? { subtitle: story.subtitle } : {}),
    summary: story.summary,
    format: story.format,
    beatCount: story.beats.length,
    durationMs,
    citationCount: story.citations.length,
    publishedAt: options.publishedAt ?? story.publishedAt ?? new Date().toISOString(),
    ...(options.bundlePath !== undefined ? { bundlePath: options.bundlePath } : {}),
  };
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function escapeJsonForScript(value: unknown): string {
  return JSON.stringify(value).replaceAll('<', '\\u003c').replaceAll('>', '\\u003e');
}

interface RenderableBeat {
  readonly id: string;
  readonly title: string;
  readonly prose: string;
  readonly caption: string;
  readonly metaParts: readonly string[];
  readonly media?: StoryMediaRef | undefined;
  readonly citationIds: readonly string[];
}

function collectRenderableBeats(story: SpecialtyStory): readonly RenderableBeat[] {
  if (story.format === 'documentary') {
    return story.beats.map((beat) => ({
      id: beat.id,
      title: beat.title,
      prose: beat.narration,
      caption: beat.caption,
      metaParts: [beat.dateLabel, beat.placeLabel].filter((v): v is string => Boolean(v)),
      media: beat.media,
      citationIds: beat.citationIds,
    }));
  }
  if (story.format === 'scroll') {
    return story.beats.map((beat) => ({
      id: beat.id,
      title: beat.title,
      prose: beat.body,
      caption: beat.caption,
      metaParts: [beat.dateLabel, beat.placeLabel].filter((v): v is string => Boolean(v)),
      media: beat.media,
      citationIds: beat.citationIds,
    }));
  }
  return story.beats.map((stop) => ({
    id: stop.id,
    title: stop.title,
    prose: stop.narrative,
    caption: stop.caption,
    metaParts: [`${stop.date} · ${stop.placeLabel}`],
    media: stop.media,
    citationIds: stop.citationIds,
  }));
}

/**
 * Compiles a validated Specialty Story into a self-contained portable HTML artifact
 * suitable for offline preview, archival export, or static hosting.
 */
export function compileStoryHtml(story: SpecialtyStory): string {
  const citationsById = new Map(story.citations.map((c) => [c.id, c]));
  const beats = collectRenderableBeats(story);
  const beatHtml = beats
    .map((beat, idx) => {
      const mediaHtml = beat.media
        ? `<figure class="story-media"><img src="${escapeHtml(beat.media.asset)}" alt="${escapeHtml(beat.media.alt)}" loading="lazy" />${
            beat.media.caption ? `<figcaption>${escapeHtml(beat.media.caption)}</figcaption>` : ''
          }</figure>`
        : '';
      const citeTags = beat.citationIds
        .map((cid) => {
          const c = citationsById.get(cid);
          return c ? `<span class="cite-pill">${escapeHtml(c.label)}</span>` : '';
        })
        .filter(Boolean)
        .join(' ');
      return `<article class="story-beat" data-beat-index="${idx}" data-beat-id="${escapeHtml(beat.id)}">
  <header>
    <span class="beat-num">${idx + 1} / ${beats.length}</span>
    ${beat.metaParts.length > 0 ? `<span class="beat-meta">${escapeHtml(beat.metaParts.join(' · '))}</span>` : ''}
    <h2>${escapeHtml(beat.title)}</h2>
  </header>
  ${mediaHtml}
  <p class="beat-prose">${escapeHtml(beat.prose)}</p>
  <p class="beat-caption">${escapeHtml(beat.caption)}</p>
  ${citeTags ? `<div class="beat-cites">${citeTags}</div>` : ''}
</article>`;
    })
    .join('\n');

  const citationsHtml =
    story.citations.length > 0
      ? `<section class="story-citations" aria-label="Sources">
  <h2>Sources &amp; Citations</h2>
  <ol>
    ${story.citations
      .map(
        (c) =>
          `<li id="cite-${escapeHtml(c.id)}"><strong>${escapeHtml(c.label)}</strong>${
            c.detail ? ` — ${escapeHtml(c.detail)}` : ''
          }${c.url ? ` <a href="${escapeHtml(c.url)}" rel="noopener noreferrer">${escapeHtml(c.url)}</a>` : ''}</li>`
      )
      .join('\n    ')}
  </ol>
</section>`
      : '';

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(story.title)} — Kinloom Specialty Story</title>
  <style>
    :root {
      color-scheme: light dark;
      --bg: #f5efe2;
      --card: #fcf9f2;
      --ink: #23272e;
      --muted: #4e4a42;
      --accent: #562e07;
      --border: #eae1ce;
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --bg: #171614;
        --card: #1f1d1a;
        --ink: #e4ddd0;
        --muted: #d7cec0;
        --accent: #f6d191;
        --border: #2a2723;
      }
    }
    body {
      margin: 0;
      font-family: 'Newsreader', Georgia, serif;
      background: var(--bg);
      color: var(--ink);
      line-height: 1.6;
    }
    main {
      max-width: 780px;
      margin: 0 auto;
      padding: 2rem 1.25rem 4rem;
    }
    .story-header {
      border-bottom: 1px solid var(--border);
      padding-bottom: 1.25rem;
      margin-bottom: 1.5rem;
    }
    .story-badge {
      display: inline-block;
      font-family: ui-monospace, monospace;
      font-size: 0.75rem;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: var(--accent);
    }
    .story-beat {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 4px;
      padding: 1.25rem;
      margin-bottom: 1.25rem;
    }
    .beat-num, .beat-meta {
      font-family: ui-monospace, monospace;
      font-size: 0.8125rem;
      color: var(--muted);
      margin-right: 0.75rem;
    }
    .story-media {
      margin: 1rem 0;
    }
    .story-media img {
      max-width: 100%;
      height: auto;
      border-radius: 4px;
    }
    .beat-caption {
      font-size: 0.9375rem;
      color: var(--muted);
      border-left: 2px solid var(--accent);
      padding-left: 0.75rem;
    }
    .cite-pill {
      display: inline-block;
      font-family: ui-monospace, monospace;
      font-size: 0.75rem;
      border: 1px solid var(--border);
      border-radius: 9999px;
      padding: 0.15rem 0.6rem;
      margin-right: 0.4rem;
    }
  </style>
</head>
<body>
  <main data-story-format="${escapeHtml(story.format)}" data-story-slug="${escapeHtml(story.slug)}">
    <header class="story-header">
      <span class="story-badge">${escapeHtml(story.format)} story</span>
      <h1>${escapeHtml(story.title)}</h1>
      ${story.subtitle ? `<p>${escapeHtml(story.subtitle)}</p>` : ''}
      <p>${escapeHtml(story.summary)}</p>
    </header>
    ${beatHtml}
    ${citationsHtml}
  </main>
  <script id="kinloom-story-data" type="application/json">${escapeJsonForScript(story)}</script>
</body>
</html>
`;
}
