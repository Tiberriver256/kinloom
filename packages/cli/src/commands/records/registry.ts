export type RecordCommandCategory =
  | 'federal-general'
  | 'state-archives'
  | 'international'
  | 'directories-guides'
  | 'media-ocr';

export interface RecordCommandCategoryInfo {
  readonly id: RecordCommandCategory;
  readonly heading: string;
}

export const RECORD_COMMAND_CATEGORIES: readonly RecordCommandCategoryInfo[] = [
  { id: 'federal-general', heading: 'Federal & general record archives' },
  { id: 'state-archives', heading: 'State archives' },
  { id: 'international', heading: 'International archives' },
  { id: 'directories-guides', heading: 'Research directories & guides' },
  { id: 'media-ocr', heading: 'Media, scan prep & OCR' },
];

export interface BaseRecordCommandSpec {
  readonly command: string;
  readonly aliases: readonly string[];
  readonly category: RecordCommandCategory;
  readonly summary: string;
}

export interface SkillScriptCommandSpec extends BaseRecordCommandSpec {
  readonly kind: 'skill-script';
  readonly skillDir: string;
  readonly scriptName: string;
}

export interface SkillGuideCommandSpec extends BaseRecordCommandSpec {
  readonly kind: 'skill-guide';
  readonly skillDir: string;
}

export interface AssetScriptCommandSpec extends BaseRecordCommandSpec {
  readonly kind: 'asset-script';
  readonly assetScript: string;
  readonly assetGuide: string;
}

export type RecordCommandSpec =
  | SkillScriptCommandSpec
  | SkillGuideCommandSpec
  | AssetScriptCommandSpec;

export const RECORD_COMMAND_SPECS: readonly RecordCommandSpec[] = [
  // Federal & general record archives (8)
  {
    kind: 'skill-script',
    command: 'nara',
    aliases: [],
    category: 'federal-general',
    skillDir: 'nara-catalog-search',
    scriptName: 'nara',
    summary: 'Search, inspect, and download National Archives Catalog records (NARA)',
  },
  {
    kind: 'skill-script',
    command: 'archive-org',
    aliases: ['ia'],
    category: 'federal-general',
    skillDir: 'archive-org',
    scriptName: 'archive-org',
    summary: 'Search, grep cached OCR, and fetch pages from Internet Archive',
  },
  {
    kind: 'skill-script',
    command: 'chronam',
    aliases: [],
    category: 'federal-general',
    skillDir: 'chronicling-america',
    scriptName: 'chronam',
    summary: 'Search and download Library of Congress Chronicling America newspapers',
  },
  {
    kind: 'skill-script',
    command: 'hathi',
    aliases: [],
    category: 'federal-general',
    skillDir: 'hathitrust',
    scriptName: 'hathi',
    summary: 'Look up books, volumes, and rights in HathiTrust Digital Library',
  },
  {
    kind: 'skill-script',
    command: 'findagrave',
    aliases: [],
    category: 'federal-general',
    skillDir: 'findagrave',
    scriptName: 'findagrave',
    summary: 'Search Find a Grave memorials, cemeteries, places, and gravestone photos',
  },
  {
    kind: 'skill-script',
    command: 'gnis',
    aliases: [],
    category: 'federal-general',
    skillDir: 'usgs-gnis',
    scriptName: 'gnis',
    summary: 'Look up historical and current U.S. place names in USGS GNIS',
  },
  {
    kind: 'skill-script',
    command: 'wikitree',
    aliases: [],
    category: 'federal-general',
    skillDir: 'wikitree',
    scriptName: 'wikitree',
    summary: 'Search and read public WikiTree profiles, ancestors, and biographies',
  },
  {
    kind: 'skill-script',
    command: 'persi',
    aliases: [],
    category: 'federal-general',
    skillDir: 'acpl-persi',
    scriptName: 'persi',
    summary: 'Search ACPL Periodical Source Index (PERSI) genealogy articles',
  },

  // State archives (7)
  {
    kind: 'skill-script',
    command: 'ca-archives',
    aliases: [],
    category: 'state-archives',
    skillDir: 'california-archives',
    scriptName: 'ca-archives',
    summary: 'Search California archives (OAC, Calisphere, State Archives, CDNC)',
  },
  {
    kind: 'skill-script',
    command: 'ky-archives',
    aliases: [],
    category: 'state-archives',
    skillDir: 'kentucky-archives',
    scriptName: 'ky-archives',
    summary: 'Search Kentucky Historical Society, KDLA, and Land Office patents',
  },
  {
    kind: 'skill-script',
    command: 'michiganology',
    aliases: [],
    category: 'state-archives',
    skillDir: 'library-of-michigan',
    scriptName: 'michiganology',
    summary: 'Search Library of Michigan and Michiganology digital collections',
  },
  {
    kind: 'skill-script',
    command: 'mo-archives',
    aliases: [],
    category: 'state-archives',
    skillDir: 'missouri-archives',
    scriptName: 'mo-archives',
    summary: 'Search Missouri State Archives death certificates and vital abstracts',
  },
  {
    kind: 'skill-script',
    command: 'nj-archives',
    aliases: [],
    category: 'state-archives',
    skillDir: 'new-jersey-archives',
    scriptName: 'nj-archives',
    summary: 'Search New Jersey State Archives databases and Monmouth OPRS census',
  },
  {
    kind: 'skill-script',
    command: 'texas-archives',
    aliases: [],
    category: 'state-archives',
    skillDir: 'texas-archives',
    scriptName: 'texas-archives',
    summary: 'Search Portal to Texas History, TSLAC, and Texas GLO land grants',
  },
  {
    kind: 'skill-script',
    command: 'va-archives',
    aliases: [],
    category: 'state-archives',
    skillDir: 'virginia-archives',
    scriptName: 'va-archives',
    summary: 'Search Library of Virginia Chancery Records Index and Primo catalog',
  },

  // International archives (2)
  {
    kind: 'skill-script',
    command: 'openarchieven',
    aliases: [],
    category: 'international',
    skillDir: 'openarchieven',
    scriptName: 'openarchieven',
    summary: 'Search Dutch and Belgian civil, parish, and Rotterdam passenger records',
  },
  {
    kind: 'skill-script',
    command: 'uk-archives',
    aliases: [],
    category: 'international',
    skillDir: 'uk-archives',
    scriptName: 'uk-archives',
    summary: 'Search UK National Archives Discovery and FreeREG parish registers',
  },

  // Research directories & guides (2)
  {
    kind: 'skill-guide',
    command: 'blm-glo',
    aliases: [],
    category: 'directories-guides',
    skillDir: 'blm-glo',
    summary: 'Research guide for BLM General Land Office federal land patents',
  },
  {
    kind: 'skill-guide',
    command: 'cyndis-list',
    aliases: [],
    category: 'directories-guides',
    skillDir: 'cyndis-list',
    summary: "Research guide for Cyndi's List county and topic genealogy directories",
  },

  // Media, scan prep & OCR (3)
  {
    kind: 'skill-script',
    command: 'narrative-audio',
    aliases: [],
    category: 'media-ocr',
    skillDir: 'narrative-audio',
    scriptName: 'narrative-audio',
    summary: 'Turn Kinloom narratives into narrated MP3 audio with Gemini TTS',
  },
  {
    kind: 'asset-script',
    command: 'prep-scan',
    aliases: [],
    category: 'media-ocr',
    assetScript: 'prep-scan.py',
    assetGuide: 'prep-scan.md',
    summary: 'Report scan size, join page images, build previews, crops, strips, and PDF pages',
  },
  {
    kind: 'asset-script',
    command: 'ocr',
    aliases: [],
    category: 'media-ocr',
    assetScript: 'cached-ocr.py',
    assetGuide: 'ocr.md',
    summary: 'Run SHA-256 cached OCR for printed (tesseract) or cursive scans',
  },
];

const SPEC_BY_NAME = new Map<string, RecordCommandSpec>();
const ALIAS_MAP: Record<string, string> = {};

for (const spec of RECORD_COMMAND_SPECS) {
  SPEC_BY_NAME.set(spec.command, spec);
  for (const alias of spec.aliases) {
    SPEC_BY_NAME.set(alias, spec);
    ALIAS_MAP[alias] = spec.command;
  }
}

export const RECORD_COMMAND_ALIASES: Readonly<Record<string, string>> = Object.freeze(ALIAS_MAP);

export function resolveRecordCommand(name: string): RecordCommandSpec | undefined {
  return SPEC_BY_NAME.get(name.trim());
}

export function isRecordCommand(name: string): boolean {
  return SPEC_BY_NAME.has(name.trim());
}
