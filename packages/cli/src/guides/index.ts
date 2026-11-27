import { RECORD_COMMAND_CATEGORIES } from '../commands/records/registry.js';
import { BLM_GLO_GUIDE } from './directories/blm-glo.js';
import { CYNDIS_LIST_GUIDE } from './directories/cyndis-list.js';
import { NARRATIVE_AUDIO_GUIDE } from './media/narrative-audio.js';
import { OCR_GUIDE } from './media/ocr.js';
import { PREP_SCAN_GUIDE } from './media/prep-scan.js';
import { PRONOUNCE_GUIDE } from './ops/pronounce.js';
import { ARCHIVE_ORG_GUIDE } from './records/archive-org.js';
import { CA_ARCHIVES_GUIDE } from './records/ca-archives.js';
import { CHRONAM_GUIDE } from './records/chronam.js';
import { FI_ARCHIVES_GUIDE } from './records/fi-archives.js';
import { FINDAGRAVE_GUIDE } from './records/findagrave.js';
import { GNIS_GUIDE } from './records/gnis.js';
import { HATHI_GUIDE } from './records/hathi.js';
import { KY_ARCHIVES_GUIDE } from './records/ky-archives.js';
import { MICHIGANOLOGY_GUIDE } from './records/michiganology.js';
import { MN_ARCHIVES_GUIDE } from './records/mn-archives.js';
import { MO_ARCHIVES_GUIDE } from './records/mo-archives.js';
import { NARA_GUIDE } from './records/nara.js';
import { NJ_ARCHIVES_GUIDE } from './records/nj-archives.js';
import { OPENARCHIEVEN_GUIDE } from './records/openarchieven.js';
import { PERSI_GUIDE } from './records/persi.js';
import { SE_ARCHIVES_GUIDE } from './records/se-archives.js';
import { TEXAS_ARCHIVES_GUIDE } from './records/texas-archives.js';
import { UK_ARCHIVES_GUIDE } from './records/uk-archives.js';
import { VA_ARCHIVES_GUIDE } from './records/va-archives.js';
import { WIKITREE_GUIDE } from './records/wikitree.js';
import type { EmbeddedGuide, GuideCategoryInfo } from './types.js';

export type { EmbeddedGuide, GuideCategory, GuideCategoryInfo } from './types.js';

export interface ResolvedEmbeddedGuide {
  readonly guide: EmbeddedGuide;
  readonly subguideKey?: string;
  readonly content: string;
}

export interface RenderEmbeddedGuideOptions {
  readonly includeFooter?: boolean;
  readonly isGuideOnly?: boolean;
}

export const GUIDE_CATEGORIES: readonly GuideCategoryInfo[] = [
  ...RECORD_COMMAND_CATEGORIES,
  { id: 'ops', heading: 'Archive operations & pronunciation' },
];

export const EMBEDDED_GUIDES: readonly EmbeddedGuide[] = [
  // Federal & general record archives (8)
  NARA_GUIDE,
  ARCHIVE_ORG_GUIDE,
  CHRONAM_GUIDE,
  HATHI_GUIDE,
  FINDAGRAVE_GUIDE,
  GNIS_GUIDE,
  WIKITREE_GUIDE,
  PERSI_GUIDE,

  // State archives (8)
  CA_ARCHIVES_GUIDE,
  KY_ARCHIVES_GUIDE,
  MICHIGANOLOGY_GUIDE,
  MN_ARCHIVES_GUIDE,
  MO_ARCHIVES_GUIDE,
  NJ_ARCHIVES_GUIDE,
  TEXAS_ARCHIVES_GUIDE,
  VA_ARCHIVES_GUIDE,

  // International archives (4)
  FI_ARCHIVES_GUIDE,
  OPENARCHIEVEN_GUIDE,
  SE_ARCHIVES_GUIDE,
  UK_ARCHIVES_GUIDE,

  // Research directories & guides (2)
  BLM_GLO_GUIDE,
  CYNDIS_LIST_GUIDE,

  // Media, scan prep & OCR (3)
  NARRATIVE_AUDIO_GUIDE,
  PREP_SCAN_GUIDE,
  OCR_GUIDE,

  // Archive operations & pronunciation (1)
  PRONOUNCE_GUIDE,
];

const GUIDE_BY_KEY = new Map<string, EmbeddedGuide>();

for (const guide of EMBEDDED_GUIDES) {
  GUIDE_BY_KEY.set(guide.id.toLowerCase(), guide);
  GUIDE_BY_KEY.set(guide.command.toLowerCase(), guide);
  if (guide.aliases) {
    for (const alias of guide.aliases) {
      GUIDE_BY_KEY.set(alias.toLowerCase(), guide);
    }
  }
}

export function resolveEmbeddedGuide(topic: string): ResolvedEmbeddedGuide | undefined {
  const normalized = topic.trim().replace(/^\/+|\/+$/g, '');
  if (!normalized) {
    return undefined;
  }

  const slashIndex = normalized.indexOf('/');
  if (slashIndex === -1) {
    const guide = GUIDE_BY_KEY.get(normalized.toLowerCase());
    if (!guide) {
      return undefined;
    }
    return {
      guide,
      content: guide.body,
    };
  }

  const primary = normalized.slice(0, slashIndex).trim().toLowerCase();
  const subKey = normalized
    .slice(slashIndex + 1)
    .trim()
    .toLowerCase();
  if (!primary || !subKey) {
    return undefined;
  }

  const guide = GUIDE_BY_KEY.get(primary);
  if (!guide?.subguides) {
    return undefined;
  }

  const exactSubguide = Object.entries(guide.subguides).find(([key]) => key.toLowerCase() === subKey);
  if (!exactSubguide) {
    return undefined;
  }

  return {
    guide,
    subguideKey: exactSubguide[0],
    content: exactSubguide[1],
  };
}

export function formatGuidesCatalog(): string {
  const maxNameWidth = Math.max(...EMBEDDED_GUIDES.map((g) => g.command.length)) + 2;
  const sections: string[] = [];

  for (const category of GUIDE_CATEGORIES) {
    const guides = EMBEDDED_GUIDES.filter((g) => g.category === category.id);
    if (guides.length === 0) {
      continue;
    }

    const lines: string[] = [`${category.heading}:`];
    for (const guide of guides) {
      const padded = guide.command.padEnd(maxNameWidth);
      const tags: string[] = [];
      if (guide.aliases && guide.aliases.length > 0) {
        tags.push(`alias: ${guide.aliases.join(', ')}`);
      }
      if (guide.category === 'directories-guides') {
        tags.push('guide');
      }
      if (guide.subguides) {
        const subKeys = Object.keys(guide.subguides);
        if (subKeys.length > 0) {
          tags.push(`subguide: ${subKeys.map((key) => `${guide.command}/${key}`).join(', ')}`);
        }
      }
      const suffix = tags.length > 0 ? ` (${tags.join('; ')})` : '';
      lines.push(`  ${padded}${guide.summary}${suffix}`);
    }
    sections.push(lines.join('\n'));
  }

  return sections.join('\n\n');
}

export function renderEmbeddedGuide(
  topicOrGuide: string | EmbeddedGuide,
  options?: RenderEmbeddedGuideOptions
): string {
  const resolved: ResolvedEmbeddedGuide | undefined =
    typeof topicOrGuide === 'string'
      ? resolveEmbeddedGuide(topicOrGuide)
      : { guide: topicOrGuide, content: topicOrGuide.body };

  if (!resolved) {
    throw new Error(`Unknown guide topic: '${String(topicOrGuide)}'`);
  }

  const includeFooter = options?.includeFooter ?? true;
  if (!includeFooter) {
    return resolved.content;
  }

  const { guide, subguideKey, content } = resolved;
  const footerLines: string[] = [];

  if (subguideKey !== undefined) {
    footerLines.push(`Parent guide: run \`kinloom guide ${guide.command}\` for the full workflow.`);
  } else {
    if (guide.aliases && guide.aliases.length > 0) {
      const aliasList = guide.aliases.map((alias) => `kinloom ${alias}`).join(', ');
      footerLines.push(`Aliases: ${aliasList}`);
    }
    if (guide.subguides) {
      const subKeys = Object.keys(guide.subguides);
      if (subKeys.length > 0) {
        const subList = subKeys.map((key) => `kinloom guide ${guide.command}/${key}`).join(', ');
        footerLines.push(`Subguides: ${subList}`);
      }
    }

    const isGuideOnly = options?.isGuideOnly ?? guide.category === 'directories-guides';
    if (!isGuideOnly) {
      const helpFlag = guide.category === 'ops' ? '--help' : '--script-help';
      footerLines.push(
        `CLI flags: run \`kinloom ${guide.command} ${helpFlag}\` for raw flag usage, or \`kinloom ${guide.command} <subcommand> --help\` for subcommand options.`
      );
    }
  }

  if (footerLines.length === 0) {
    return content;
  }

  return `${content}\n\n---\n${footerLines.join('\n')}`;
}
