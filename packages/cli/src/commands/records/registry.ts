import { runArchiveOrgCommand } from './clients/archive-org.js';
import { runCaArchivesCommand } from './clients/ca-archives.js';
import { runChronamCommand } from './clients/chronam.js';
import { runFiArchivesCommand } from './clients/fi-archives.js';
import { runFindagraveCommand } from './clients/findagrave.js';
import { runGnisCommand } from './clients/gnis.js';
import { runHathiCommand } from './clients/hathi.js';
import { runKyArchivesCommand } from './clients/ky-archives.js';
import { runMichiganologyCommand } from './clients/michiganology.js';
import { runMnArchivesCommand } from './clients/mn-archives.js';
import { runMoArchivesCommand } from './clients/mo-archives.js';
import { runNaraCommand } from './clients/nara.js';
import { runNarrativeAudioCommand } from './clients/narrative-audio.js';
import { runNjArchivesCommand } from './clients/nj-archives.js';
import { runOcrCommand } from './clients/ocr.js';
import { runOpenarchievenCommand } from './clients/openarchieven.js';
import { runPersiCommand } from './clients/persi.js';
import { runPrepScanCommand } from './clients/prep-scan.js';
import { runSeArchivesCommand } from './clients/se-archives.js';
import { runTexasArchivesCommand } from './clients/texas-archives.js';
import { runUkArchivesCommand } from './clients/uk-archives.js';
import { runVaArchivesCommand } from './clients/va-archives.js';
import { runWikitreeCommand } from './clients/wikitree.js';
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
  readonly handler: RecordHandler;
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
    handler: runNaraCommand,
    summary: 'Search, inspect, and download National Archives Catalog records (NARA)',
  },
  {
    kind: 'native',
    command: 'archive-org',
    aliases: ['ia'],
    category: 'federal-general',
    handler: runArchiveOrgCommand,
    summary: 'Search, grep cached OCR, and fetch pages from Internet Archive',
  },
  {
    kind: 'native',
    command: 'chronam',
    aliases: [],
    category: 'federal-general',
    handler: runChronamCommand,
    summary: 'Search and download Library of Congress Chronicling America newspapers',
  },
  {
    kind: 'native',
    command: 'hathi',
    aliases: [],
    category: 'federal-general',
    handler: runHathiCommand,
    summary: 'Look up books, volumes, and rights in HathiTrust Digital Library',
  },
  {
    kind: 'native',
    command: 'findagrave',
    aliases: [],
    category: 'federal-general',
    handler: runFindagraveCommand,
    summary: 'Search Find a Grave memorials, cemeteries, places, and gravestone photos',
  },
  {
    kind: 'native',
    command: 'gnis',
    aliases: [],
    category: 'federal-general',
    handler: runGnisCommand,
    summary: 'Look up historical and current U.S. place names in USGS GNIS',
  },
  {
    kind: 'native',
    command: 'wikitree',
    aliases: [],
    category: 'federal-general',
    handler: runWikitreeCommand,
    summary: 'Search and read public WikiTree profiles, ancestors, and biographies',
  },
  {
    kind: 'native',
    command: 'persi',
    aliases: [],
    category: 'federal-general',
    handler: runPersiCommand,
    summary: 'Search ACPL Periodical Source Index (PERSI) genealogy articles',
  },

  // State archives (8)
  {
    kind: 'native',
    command: 'ca-archives',
    aliases: [],
    category: 'state-archives',
    handler: runCaArchivesCommand,
    summary: 'Search California archives (OAC, Calisphere, State Archives, CDNC)',
  },
  {
    kind: 'native',
    command: 'ky-archives',
    aliases: [],
    category: 'state-archives',
    handler: runKyArchivesCommand,
    summary: 'Search Kentucky Historical Society, KDLA, and Land Office patents',
  },
  {
    kind: 'native',
    command: 'michiganology',
    aliases: [],
    category: 'state-archives',
    handler: runMichiganologyCommand,
    summary: 'Search Library of Michigan and Michiganology digital collections',
  },
  {
    kind: 'native',
    command: 'mn-archives',
    aliases: [],
    category: 'state-archives',
    handler: runMnArchivesCommand,
    summary: 'Search Minnesota Historical Society People Records and Digital Newspaper Hub',
  },
  {
    kind: 'native',
    command: 'mo-archives',
    aliases: [],
    category: 'state-archives',
    handler: runMoArchivesCommand,
    summary: 'Search Missouri State Archives death certificates and vital abstracts',
  },
  {
    kind: 'native',
    command: 'nj-archives',
    aliases: [],
    category: 'state-archives',
    handler: runNjArchivesCommand,
    summary: 'Search New Jersey State Archives databases and Monmouth OPRS census',
  },
  {
    kind: 'native',
    command: 'texas-archives',
    aliases: [],
    category: 'state-archives',
    handler: runTexasArchivesCommand,
    summary: 'Search Portal to Texas History, TSLAC, and Texas GLO land grants',
  },
  {
    kind: 'native',
    command: 'va-archives',
    aliases: [],
    category: 'state-archives',
    handler: runVaArchivesCommand,
    summary: 'Search Library of Virginia Chancery Records Index and Primo catalog',
  },

  // International archives (4)
  {
    kind: 'native',
    command: 'fi-archives',
    aliases: [],
    category: 'international',
    handler: runFiArchivesCommand,
    summary: 'Search Finnish HisKi parish registers and National Archives Digihakemisto index',
  },
  {
    kind: 'native',
    command: 'openarchieven',
    aliases: [],
    category: 'international',
    handler: runOpenarchievenCommand,
    summary: 'Search Dutch and Belgian civil, parish, and Rotterdam passenger records',
  },
  {
    kind: 'native',
    command: 'se-archives',
    aliases: [],
    category: 'international',
    handler: runSeArchivesCommand,
    summary: 'Search Swedish National Archives (Riksarkivet) records, church books, and IIIF scans',
  },
  {
    kind: 'native',
    command: 'uk-archives',
    aliases: [],
    category: 'international',
    handler: runUkArchivesCommand,
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

  // Media, scan prep & OCR (3)
  {
    kind: 'native',
    command: 'narrative-audio',
    aliases: [],
    category: 'media-ocr',
    handler: runNarrativeAudioCommand,
    summary: 'Turn Kinloom narratives into narrated MP3 audio (Chirp 3: HD or Gemini TTS)',
  },
  {
    kind: 'native',
    command: 'prep-scan',
    aliases: [],
    category: 'media-ocr',
    handler: runPrepScanCommand,
    summary: 'Report scan size, join page images, build previews, crops, strips, and PDF pages',
  },
  {
    kind: 'native',
    command: 'ocr',
    aliases: [],
    category: 'media-ocr',
    handler: runOcrCommand,
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
