import type { RecordHandler } from './runtime/types.js';

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

export interface NativeRecordCommandSpec extends BaseRecordCommandSpec {
  readonly kind: 'native';
  readonly loadHandler: () => Promise<RecordHandler>;
}

export interface GuideOnlyCommandSpec extends BaseRecordCommandSpec {
  readonly kind: 'guide-only';
}

export type RecordCommandSpec = NativeRecordCommandSpec | GuideOnlyCommandSpec;

export const RECORD_COMMAND_SPECS: readonly RecordCommandSpec[] = [
  // Federal & general record archives (8)
  {
    kind: 'native',
    command: 'nara',
    aliases: [],
    category: 'federal-general',
    loadHandler: () => import('./clients/nara.js').then((mod) => mod.runNaraCommand),
    summary: 'Search, inspect, and download National Archives Catalog, 1950 Census, and AAD records (NARA)',
  },
  {
    kind: 'native',
    command: 'archive-org',
    aliases: ['ia'],
    category: 'federal-general',
    loadHandler: () => import('./clients/archive-org.js').then((mod) => mod.runArchiveOrgCommand),
    summary: 'Search, grep cached OCR, and fetch pages from Internet Archive',
  },
  {
    kind: 'native',
    command: 'chronam',
    aliases: [],
    category: 'federal-general',
    loadHandler: () => import('./clients/chronam.js').then((mod) => mod.runChronamCommand),
    summary: 'Search and download Library of Congress Chronicling America newspapers',
  },
  {
    kind: 'native',
    command: 'hathi',
    aliases: [],
    category: 'federal-general',
    loadHandler: () => import('./clients/hathi.js').then((mod) => mod.runHathiCommand),
    summary: 'Look up books, volumes, and rights in HathiTrust Digital Library',
  },
  {
    kind: 'native',
    command: 'findagrave',
    aliases: [],
    category: 'federal-general',
    loadHandler: () => import('./clients/findagrave.js').then((mod) => mod.runFindagraveCommand),
    summary: 'Search Find a Grave memorials, cemeteries, places, and gravestone photos',
  },
  {
    kind: 'native',
    command: 'gnis',
    aliases: [],
    category: 'federal-general',
    loadHandler: () => import('./clients/gnis.js').then((mod) => mod.runGnisCommand),
    summary: 'Look up historical and current U.S. place names in USGS GNIS',
  },
  {
    kind: 'native',
    command: 'wikitree',
    aliases: [],
    category: 'federal-general',
    loadHandler: () => import('./clients/wikitree.js').then((mod) => mod.runWikitreeCommand),
    summary: 'Search and read public WikiTree profiles, ancestors, and biographies',
  },
  {
    kind: 'native',
    command: 'persi',
    aliases: [],
    category: 'federal-general',
    loadHandler: () => import('./clients/persi.js').then((mod) => mod.runPersiCommand),
    summary: 'Search ACPL Periodical Source Index (PERSI) genealogy articles',
  },

  // State archives (8)
  {
    kind: 'native',
    command: 'ca-archives',
    aliases: [],
    category: 'state-archives',
    loadHandler: () => import('./clients/ca-archives.js').then((mod) => mod.runCaArchivesCommand),
    summary: 'Search California archives (OAC, Calisphere, State Archives, CDNC)',
  },
  {
    kind: 'native',
    command: 'ky-archives',
    aliases: [],
    category: 'state-archives',
    loadHandler: () => import('./clients/ky-archives.js').then((mod) => mod.runKyArchivesCommand),
    summary: 'Search Kentucky Historical Society, KDLA, and Land Office patents',
  },
  {
    kind: 'native',
    command: 'michiganology',
    aliases: [],
    category: 'state-archives',
    loadHandler: () => import('./clients/michiganology.js').then((mod) => mod.runMichiganologyCommand),
    summary: 'Search Library of Michigan and Michiganology digital collections',
  },
  {
    kind: 'native',
    command: 'mn-archives',
    aliases: [],
    category: 'state-archives',
    loadHandler: () => import('./clients/mn-archives.js').then((mod) => mod.runMnArchivesCommand),
    summary: 'Search Minnesota Historical Society People Records and Digital Newspaper Hub',
  },
  {
    kind: 'native',
    command: 'mo-archives',
    aliases: [],
    category: 'state-archives',
    loadHandler: () => import('./clients/mo-archives.js').then((mod) => mod.runMoArchivesCommand),
    summary: 'Search Missouri State Archives death certificates and vital abstracts',
  },
  {
    kind: 'native',
    command: 'nj-archives',
    aliases: [],
    category: 'state-archives',
    loadHandler: () => import('./clients/nj-archives.js').then((mod) => mod.runNjArchivesCommand),
    summary: 'Search New Jersey State Archives databases and Monmouth OPRS census',
  },
  {
    kind: 'native',
    command: 'texas-archives',
    aliases: [],
    category: 'state-archives',
    loadHandler: () => import('./clients/texas-archives.js').then((mod) => mod.runTexasArchivesCommand),
    summary: 'Search Portal to Texas History, TSLAC, and Texas GLO land grants',
  },
  {
    kind: 'native',
    command: 'va-archives',
    aliases: [],
    category: 'state-archives',
    loadHandler: () => import('./clients/va-archives.js').then((mod) => mod.runVaArchivesCommand),
    summary: 'Search Library of Virginia Chancery Records Index and Primo catalog',
  },

  // International archives (4)
  {
    kind: 'native',
    command: 'fi-archives',
    aliases: [],
    category: 'international',
    loadHandler: () => import('./clients/fi-archives.js').then((mod) => mod.runFiArchivesCommand),
    summary: 'Search Finnish HisKi parish registers, Digihakemisto index, and Astia folder scans',
  },
  {
    kind: 'native',
    command: 'openarchieven',
    aliases: [],
    category: 'international',
    loadHandler: () => import('./clients/openarchieven.js').then((mod) => mod.runOpenarchievenCommand),
    summary: 'Search Dutch and Belgian civil, parish, and Rotterdam passenger records',
  },
  {
    kind: 'native',
    command: 'se-archives',
    aliases: [],
    category: 'international',
    loadHandler: () => import('./clients/se-archives.js').then((mod) => mod.runSeArchivesCommand),
    summary: 'Search Swedish National Archives (Riksarkivet) records, church books, and IIIF scans',
  },
  {
    kind: 'native',
    command: 'uk-archives',
    aliases: [],
    category: 'international',
    loadHandler: () => import('./clients/uk-archives.js').then((mod) => mod.runUkArchivesCommand),
    summary: 'Search UK National Archives Discovery and FreeREG parish registers',
  },

  // Research directories & guides (2)
  {
    kind: 'guide-only',
    command: 'blm-glo',
    aliases: [],
    category: 'directories-guides',
    summary: 'Research guide for BLM General Land Office federal land patents',
  },
  {
    kind: 'guide-only',
    command: 'cyndis-list',
    aliases: [],
    category: 'directories-guides',
    summary: "Research guide for Cyndi's List county and topic genealogy directories",
  },

  // Media, scan prep & OCR (4)
  {
    kind: 'native',
    command: 'narrative-audio',
    aliases: [],
    category: 'media-ocr',
    loadHandler: () => import('./clients/narrative-audio.js').then((mod) => mod.runNarrativeAudioCommand),
    summary: 'Turn Kinloom narratives into narrated MP3 audio (Chirp 3: HD or Gemini TTS)',
  },
  {
    kind: 'native',
    command: 'prep-scan',
    aliases: [],
    category: 'media-ocr',
    loadHandler: () => import('./clients/prep-scan.js').then((mod) => mod.runPrepScanCommand),
    summary: 'Report scan size, join page images, build previews, crops, strips, and PDF pages',
  },
  {
    kind: 'native',
    command: 'ocr',
    aliases: [],
    category: 'media-ocr',
    loadHandler: () => import('./clients/ocr.js').then((mod) => mod.runOcrCommand),
    summary: 'Run SHA-256 cached OCR for printed (tesseract) or cursive scans',
  },
  {
    kind: 'native',
    command: 'pdf-grep',
    aliases: [],
    category: 'media-ocr',
    loadHandler: () => import('./clients/pdf-grep.js').then((mod) => mod.runPdfGrepCommand),
    summary: 'Download or read PDFs with SHA-256 disk caching and grep extracted pdftotext output',
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
