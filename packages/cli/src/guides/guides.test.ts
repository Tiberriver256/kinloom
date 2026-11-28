import { describe, expect, it } from 'vitest';
import {
  EMBEDDED_GUIDES,
  formatGuidesCatalog,
  GUIDE_CATEGORIES,
  renderEmbeddedGuide,
  resolveEmbeddedGuide,
} from './index.js';

const SKILL_ORIGIN_GUIDE_IDS = new Set([
  'nara',
  'archive-org',
  'chronam',
  'hathi',
  'findagrave',
  'gnis',
  'wikitree',
  'persi',
  'ca-archives',
  'ky-archives',
  'michiganology',
  'mn-archives',
  'mo-archives',
  'nj-archives',
  'texas-archives',
  'va-archives',
  'fi-archives',
  'openarchieven',
  'se-archives',
  'uk-archives',
  'blm-glo',
  'cyndis-list',
  'narrative-audio',
  'pronounce',
]);

describe('embedded workflow guides', () => {
  it('ships all 28 embedded guides across the 6 guide categories plus narrative-audio/script-rules', () => {
    expect(EMBEDDED_GUIDES).toHaveLength(28);
    expect(GUIDE_CATEGORIES).toHaveLength(6);

    const ids = EMBEDDED_GUIDES.map((g) => g.id);
    expect(new Set(ids).size).toBe(28);

    const byCategory = new Map<string, number>();
    for (const guide of EMBEDDED_GUIDES) {
      byCategory.set(guide.category, (byCategory.get(guide.category) ?? 0) + 1);
    }

    expect(byCategory.get('federal-general')).toBe(8);
    expect(byCategory.get('state-archives')).toBe(8);
    expect(byCategory.get('international')).toBe(4);
    expect(byCategory.get('directories-guides')).toBe(2);
    expect(byCategory.get('media-ocr')).toBe(3);
    expect(byCategory.get('ops')).toBe(3);

    for (const guide of EMBEDDED_GUIDES) {
      const resolved = resolveEmbeddedGuide(guide.command);
      expect(resolved, `resolveEmbeddedGuide('${guide.command}')`).toBeDefined();
      expect(resolved?.guide.id).toBe(guide.id);
      expect(resolved?.subguideKey).toBeUndefined();
      expect(resolved?.content).toBe(guide.body);
    }

    const iaResolved = resolveEmbeddedGuide('ia');
    expect(iaResolved?.guide.command).toBe('archive-org');
    expect(iaResolved?.content).toContain('# Archive.org');

    const subguideResolved = resolveEmbeddedGuide('narrative-audio/script-rules');
    expect(subguideResolved?.guide.command).toBe('narrative-audio');
    expect(subguideResolved?.subguideKey).toBe('script-rules');
    expect(subguideResolved?.content).toContain('# Spoken-script rules');

    expect(resolveEmbeddedGuide('')).toBeUndefined();
    expect(resolveEmbeddedGuide('nonexistent-guide')).toBeUndefined();
    expect(resolveEmbeddedGuide('narrative-audio/does-not-exist')).toBeUndefined();
  });

  it('scrubs all legacy Python, uv, script-path, and frontmatter artifacts from every guide and subguide', () => {
    const forbiddenLegacyPatterns: ReadonlyArray<{ readonly label: string; readonly regex: RegExp }> = [
      { label: 'uv run invocation', regex: /\buv run\b/ },
      { label: 'raw monorepo script path', regex: /skills\/[a-z0-9-]+\/scripts\// },
      { label: 'prep-scan.py reference', regex: /prep-scan\.py/ },
      { label: 'cached-ocr.py reference', regex: /cached-ocr\.py/ },
      { label: 'python3 -m unittest command', regex: /\bpython3 -m unittest\b/ },
      { label: 'raw references/script-rules.md path', regex: /references\/script-rules\.md/ },
      { label: 'raw YAML frontmatter delimiter', regex: /^---\r?\n/ },
    ];

    for (const guide of EMBEDDED_GUIDES) {
      for (const { label, regex } of forbiddenLegacyPatterns) {
        expect(guide.body, `guide '${guide.id}' contains ${label}`).not.toMatch(regex);
      }

      if (guide.subguides) {
        for (const [subKey, subBody] of Object.entries(guide.subguides)) {
          for (const { label, regex } of forbiddenLegacyPatterns) {
            expect(subBody, `subguide '${guide.id}/${subKey}' contains ${label}`).not.toMatch(regex);
          }
        }
      }
    }
  });

  it('enforces ubiquitous-language and Living Privacy Rule invariants across all 24 skill-origin guides', () => {
    const forbiddenLanguagePatterns: ReadonlyArray<{
      readonly label: string;
      readonly regex: RegExp;
    }> = [
      { label: 'leaked Vitest reference', regex: /\bVitest\b/ },
      { label: 'direct data/ edit phrasing', regex: /\bin `data\/`/ },
      { label: 'deprecated manuscript scan', regex: /\bmanuscript scan\b/i },
      { label: 'deprecated living individuals', regex: /\bliving individuals\b/i },
      { label: 'deprecated phonetic guide', regex: /\bphonetic guide\b/i },
      { label: 'deprecated phonetic respelling', regex: /\bphonetic respelling\b/i },
      { label: 'deprecated Collateral Relative', regex: /\bCollateral Relative\b/ },
      { label: 'deprecated Record discussion', regex: /\bRecord discussion\b/ },
      { label: 'deprecated anchor years', regex: /\banchor years\b/i },
    ];

    expect(SKILL_ORIGIN_GUIDE_IDS.size).toBe(24);

    for (const guide of EMBEDDED_GUIDES) {
      for (const { label, regex } of forbiddenLanguagePatterns) {
        expect(guide.body, `guide '${guide.id}' contains ${label}`).not.toMatch(regex);
      }
      if (SKILL_ORIGIN_GUIDE_IDS.has(guide.id)) {
        expect(guide.body, `guide '${guide.id}' mentions Living Privacy Rule`).toContain(
          'Living Privacy Rule'
        );
      }
    }

    const pronounce = resolveEmbeddedGuide('pronounce');
    expect(pronounce?.content).toContain('--strict');
    expect(pronounce?.content).toContain('100% deceased Full-Name Pronunciation');
    expect(pronounce?.content).toContain('100% Place coverage');
    expect(pronounce?.content).toContain('Zero Living leaks');
    expect(pronounce?.content).toContain('FORVO_API_KEY');
    expect(pronounce?.content).toContain('corroborated');

    const audio = resolveEmbeddedGuide('narrative-audio');
    expect(audio?.guide.summary).toContain('Chirp 3: HD');
    expect(audio?.content).toContain('chirp3-hd');
    expect(audio?.content).toContain('GOOGLE_CLOUD_TTS_API_KEY');
    expect(audio?.content).toContain('kinloom narrative-audio');
    expect(audio?.content).toContain('kinloom guide narrative-audio/script-rules');

    const ocr = resolveEmbeddedGuide('ocr');
    expect(ocr?.content).toContain('kinloom ocr batch');
    expect(ocr?.content).toContain('--grep');
    expect(ocr?.content).toContain('--concurrency 4');
    expect(ocr?.content).toContain('--timeout 30');
    expect(ocr?.content).toContain('OMP_THREAD_LIMIT=1');
  });

  it('formats the guides catalog with all 26 topics grouped by category and renders footers cleanly', () => {
    const catalog = formatGuidesCatalog();

    for (const category of GUIDE_CATEGORIES) {
      expect(catalog).toContain(`${category.heading}:`);
    }

    for (const guide of EMBEDDED_GUIDES) {
      expect(catalog).toContain(guide.command);
    }

    expect(catalog).toContain('alias: ia');
    expect(catalog).toContain('subguide: narrative-audio/script-rules');

    const renderedArchiveOrg = renderEmbeddedGuide('ia');
    expect(renderedArchiveOrg).toContain('Aliases: kinloom ia');
    expect(renderedArchiveOrg).toContain('kinloom archive-org --script-help');

    const renderedNoFooter = renderEmbeddedGuide('archive-org', { includeFooter: false });
    expect(renderedNoFooter).not.toContain('Aliases: kinloom ia');

    const renderedGuideOnly = renderEmbeddedGuide('blm-glo');
    expect(renderedGuideOnly).not.toContain('--script-help');

    const renderedSubguide = renderEmbeddedGuide('narrative-audio/script-rules');
    expect(renderedSubguide).toContain('# Spoken-script rules');
    expect(renderedSubguide).toContain('kinloom guide narrative-audio');

    expect(() => renderEmbeddedGuide('does-not-exist')).toThrow(/Unknown guide topic/);
  });
});
