import { CliValidationError } from '../../../../errors.js';
import { isPlainRecord } from '../../runtime/primitives.js';
import { ScanImage } from './scans.js';

export {
  ALLOWED_API_HOSTS,
  buildDirectScanCandidates,
  deriveIiifJpegUrl,
  deriveProxyDownloadUrl,
  isViewerUrl,
  ScanImage,
  scanFilename,
  validateApiUrl,
  validateScanUrl,
} from './scans.js';

export const WEB_BASE = 'https://www.openarchieven.nl';

const ARCHIVE_CODE_RE = /^[A-Za-z0-9_-]{1,32}$/;
const RECORD_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const OPENARCH_URL_RE = /openarchieven\.nl\/([a-z0-9_-]+):([A-Za-z0-9_-]+)/i;

const KNOWN_SOURCE_TYPES: ReadonlySet<string> = new Set([
  'bevolkingsregister',
  'passagiersregisters',
  'notariële archieven',
  'militieregisters',
  'bidprentjes',
  'familienamen',
  'gezinskaarten',
  'persoonskaarten',
  'woningkaarten',
  'memorie van successie',
]);

export const VALID_LANGS = ['nl', 'en', 'de', 'fr'] as const;

export function asList(val: unknown): unknown[] {
  if (val === null || val === undefined) {
    return [];
  }
  return Array.isArray(val) ? val : [val];
}

export function a2aText(node: unknown): string {
  if (node === null || node === undefined) {
    return '';
  }
  if (typeof node === 'string') {
    return node.trim();
  }
  if (typeof node === 'number') {
    return String(node);
  }
  if (isPlainRecord(node)) {
    for (const [key, val] of Object.entries(node)) {
      if (typeof val === 'string' || typeof val === 'number') {
        return String(val).trim();
      }
      if (isPlainRecord(val) && key in val) {
        return a2aText(val[key]);
      }
    }
    for (const val of Object.values(node)) {
      const found = a2aText(val);
      if (found) {
        return found;
      }
    }
  }
  return '';
}

function scanValue(scan: Record<string, unknown>, names: readonly string[]): string {
  const lowered = new Map<string, unknown>();
  for (const [key, value] of Object.entries(scan)) {
    lowered.set(key.toLowerCase(), value);
  }
  for (const name of names) {
    if (name in scan) {
      const text = a2aText(scan[name]);
      if (text) {
        return text;
      }
    }
    const text = a2aText(lowered.get(name.toLowerCase()));
    if (text) {
      return text;
    }
  }
  return '';
}

function scanOrder(scan: Record<string, unknown>): number | null {
  const raw = scanValue(scan, ['a2a_OrderSequenceNumber', 'a2a_Order', 'order', 'Order']);
  if (!raw || !/^[+-]?\d+$/.test(raw)) {
    return null;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function asShowRecords(data: unknown): Record<string, unknown>[] {
  if (isPlainRecord(data)) {
    return [data];
  }
  if (Array.isArray(data)) {
    return data.filter((item): item is Record<string, unknown> => isPlainRecord(item));
  }
  return [];
}

export function extractScans(record: Record<string, unknown>): ScanImage[] {
  const source = record['a2a_Source'];
  if (!isPlainRecord(source)) {
    return [];
  }
  const block = source['a2a_SourceAvailableScans'];
  let rawScans: unknown[];
  if (isPlainRecord(block)) {
    const raw = block['a2a_Scan'];
    if (raw === undefined || raw === null) {
      rawScans = scanValue(block, ['a2a_Uri', 'uri', 'Uri']) ? [block] : [];
    } else {
      rawScans = asList(raw);
    }
  } else if (Array.isArray(block)) {
    rawScans = block;
  } else {
    return [];
  }

  const found: Array<{
    readonly pos: number;
    readonly order: number | null;
    readonly label: string;
    readonly uri: string;
    readonly preview: string;
  }> = [];

  for (const scan of rawScans) {
    if (!isPlainRecord(scan)) {
      continue;
    }
    const uri = scanValue(scan, ['a2a_Uri', 'uri', 'Uri']);
    const preview = scanValue(scan, ['a2a_UriPreview', 'uri_preview', 'UriPreview']);
    if (!uri && !preview) {
      continue;
    }
    const label = scanValue(scan, [
      'a2a_Label',
      'a2a_Caption',
      'a2a_Title',
      'a2a_Description',
      'label',
      'caption',
      'title',
    ]);
    found.push({ pos: found.length, order: scanOrder(scan), label, uri, preview });
  }

  found.sort((a, b) => {
    const aMissing = a.order === null ? 1 : 0;
    const bMissing = b.order === null ? 1 : 0;
    if (aMissing !== bMissing) {
      return aMissing - bMissing;
    }
    const aOrder = a.order ?? 0;
    const bOrder = b.order ?? 0;
    return aOrder !== bOrder ? aOrder - bOrder : a.pos - b.pos;
  });

  return found.map((item, idx) => new ScanImage(idx + 1, item.order, item.label, item.uri, item.preview));
}

export function extractScansFromShow(data: unknown): ScanImage[] {
  const scans: ScanImage[] = [];
  for (const record of asShowRecords(data)) {
    scans.push(...extractScans(record));
  }
  return scans.map((scan, idx) => new ScanImage(idx + 1, scan.order, scan.label, scan.uri, scan.uriPreview));
}

export function isSourceType(value: string): boolean {
  const low = value.trim().toLowerCase();
  return low.startsWith('bs ') || low.startsWith('dtb ') || KNOWN_SOURCE_TYPES.has(low);
}

function padInt(value: number, width: number): string {
  return String(Math.trunc(value)).padStart(width, '0');
}

export function fmtEventdate(dateObj: unknown): string {
  if (!isPlainRecord(dateObj)) {
    return '';
  }
  const { year, month, day } = dateObj;
  if (year === undefined || year === null) {
    return '';
  }
  const y = Number(year);
  if (!Number.isFinite(y)) {
    return '';
  }
  const m = month !== undefined && month !== null && month !== '' ? Number(month) : 0;
  const d = day !== undefined && day !== null && day !== '' ? Number(day) : 0;
  if (Number.isFinite(m) && m > 0 && Number.isFinite(d) && d > 0) {
    return `${padInt(y, 4)}-${padInt(m, 2)}-${padInt(d, 2)}`;
  }
  if (Number.isFinite(m) && m > 0) {
    return `${padInt(y, 4)}-${padInt(m, 2)}`;
  }
  return padInt(y, 4);
}

function fmtA2aDate(dateNode: unknown): string {
  if (!isPlainRecord(dateNode)) {
    return a2aText(dateNode);
  }
  const year = a2aText(dateNode['a2a_Year']);
  const month = a2aText(dateNode['a2a_Month']);
  const day = a2aText(dateNode['a2a_Day']);
  if (year && month && day && /^\d+$/.test(year) && /^\d+$/.test(month) && /^\d+$/.test(day)) {
    return `${padInt(Number.parseInt(year, 10), 4)}-${padInt(Number.parseInt(month, 10), 2)}-${padInt(Number.parseInt(day, 10), 2)}`;
  }
  if (year && month && /^\d+$/.test(year) && /^\d+$/.test(month)) {
    return `${padInt(Number.parseInt(year, 10), 4)}-${padInt(Number.parseInt(month, 10), 2)}`;
  }
  return year || a2aText(dateNode['a2a_LiteralDate']);
}

function fmtA2aPersonName(nameNode: unknown): string {
  if (!isPlainRecord(nameNode)) {
    return a2aText(nameNode);
  }
  return [
    a2aText(nameNode['a2a_PersonNameFirstName']),
    a2aText(nameNode['a2a_PersonNamePatronym']),
    a2aText(nameNode['a2a_PersonNamePrefixLastName']),
    a2aText(nameNode['a2a_PersonNameLastName']),
  ]
    .filter(Boolean)
    .join(' ');
}

function validateRecordRef(code: string, ident: string): readonly [string, string] {
  const cleanedCode = code.trim();
  const cleanedIdent = ident.trim();
  if (!ARCHIVE_CODE_RE.test(cleanedCode) || !RECORD_ID_RE.test(cleanedIdent)) {
    throw new CliValidationError(
      `Invalid archive or record identifier ('${cleanedCode}', '${cleanedIdent}').`
    );
  }
  return [cleanedCode, cleanedIdent];
}

export function parseRecordRef(archive: string, identifier: string | undefined): readonly [string, string] {
  if (identifier) {
    return validateRecordRef(archive, identifier);
  }
  const match = OPENARCH_URL_RE.exec(archive);
  if (match) {
    return validateRecordRef(match[1] ?? '', match[2] ?? '');
  }
  const colonIdx = archive.indexOf(':');
  if (colonIdx !== -1) {
    const code = archive.slice(0, colonIdx);
    const rest = archive.slice(colonIdx + 1);
    const ident = (rest.split('/', 1)[0] ?? '').split('?', 1)[0] ?? '';
    if (code.trim() && ident.trim()) {
      return validateRecordRef(code, ident);
    }
  }
  throw new CliValidationError(
    "Pass ARCHIVE and IDENTIFIER, an 'archive:uuid' token, or an openarchieven.nl record URL."
  );
}

export function isDirectScanUrl(value: string): boolean {
  const cleaned = value.trim();
  const lower = cleaned.toLowerCase();
  if (!lower.startsWith('http://') && !lower.startsWith('https://')) {
    return false;
  }
  return !OPENARCH_URL_RE.test(cleaned);
}

export function isCompleteRecordRef(value: string): boolean {
  const cleaned = value.trim();
  return isDirectScanUrl(cleaned) || OPENARCH_URL_RE.test(cleaned) || cleaned.includes(':');
}

export function formatA2aRecord(
  archive: string,
  identifier: string,
  record: Record<string, unknown>
): string {
  const lines: string[] = [`Record: ${archive}:${identifier}`, `  URL: ${WEB_BASE}/${archive}:${identifier}`];
  const source = isPlainRecord(record['a2a_Source']) ? record['a2a_Source'] : {};
  const sourceType = a2aText(source['a2a_SourceType']);
  const sourcePlaceNode = isPlainRecord(source['a2a_SourcePlace']) ? source['a2a_SourcePlace'] : {};
  const sourcePlace = a2aText(sourcePlaceNode['a2a_Place']);
  const ref = isPlainRecord(source['a2a_SourceReference']) ? source['a2a_SourceReference'] : {};
  const inst = a2aText(ref['a2a_InstitutionName']);
  const book = a2aText(ref['a2a_Book']);
  const collection = a2aText(ref['a2a_Collection']);
  const docNum = a2aText(ref['a2a_DocumentNumber']);
  const archiveNum = a2aText(ref['a2a_Archive']);
  const regNum = a2aText(ref['a2a_RegistryNumber']);

  if (sourceType) {
    lines.push(`  Source type: ${sourceType}`);
  }
  if (inst) {
    lines.push(`  Institution: ${inst}`);
  }
  if (sourcePlace) {
    lines.push(`  Source place: ${sourcePlace}`);
  }
  const refParts = [
    archiveNum ? `Archive ${archiveNum}` : '',
    regNum ? `Registry ${regNum}` : '',
    book,
    collection,
    docNum ? `Document ${docNum}` : '',
  ].filter(Boolean);
  if (refParts.length > 0) {
    lines.push(`  Reference: ${refParts.join(' | ')}`);
  }

  for (const ev of asList(record['a2a_Event'])) {
    if (!isPlainRecord(ev)) {
      continue;
    }
    const evPlaceNode = isPlainRecord(ev['a2a_EventPlace']) ? ev['a2a_EventPlace'] : {};
    const summary = [
      a2aText(ev['a2a_EventType']),
      fmtA2aDate(ev['a2a_EventDate']),
      a2aText(evPlaceNode['a2a_Place']),
    ]
      .filter(Boolean)
      .join(' | ');
    if (summary) {
      lines.push(`  Event: ${summary}`);
    }
  }

  const rolesByPid = new Map<string, string[]>();
  for (const rel of asList(record['a2a_RelationEP'])) {
    if (!isPlainRecord(rel)) {
      continue;
    }
    const pid = a2aText(rel['a2a_PersonKeyRef']);
    const role = a2aText(rel['a2a_RelationType']);
    if (pid && role) {
      const existing = rolesByPid.get(pid);
      if (existing) {
        existing.push(role);
      } else {
        rolesByPid.set(pid, [role]);
      }
    }
  }

  const persons = asList(record['a2a_Person']);
  if (persons.length > 0) {
    lines.push('  Persons:');
    for (const person of persons) {
      if (!isPlainRecord(person)) {
        continue;
      }
      const pid = person['pid'] !== undefined && person['pid'] !== null ? String(person['pid']) : '';
      const name = fmtA2aPersonName(person['a2a_PersonName']) || '(unnamed)';
      const roleStr = (rolesByPid.get(pid) ?? []).join(', ');
      const bdate = fmtA2aDate(person['a2a_BirthDate']);
      const bplaceNode = isPlainRecord(person['a2a_BirthPlace']) ? person['a2a_BirthPlace'] : {};
      const bplace = a2aText(bplaceNode['a2a_Place']);
      const resNode = isPlainRecord(person['a2a_Residence']) ? person['a2a_Residence'] : {};
      const res = a2aText(resNode['a2a_Place']);
      const occ = a2aText(person['a2a_Profession']);
      const details: string[] = [];
      if (roleStr) {
        details.push(roleStr);
      }
      if (bdate || bplace) {
        details.push(`b. ${[bdate, bplace].filter(Boolean).join(', ')}`);
      }
      if (res) {
        details.push(`res. ${res}`);
      }
      if (occ) {
        details.push(`occ. ${occ}`);
      }
      const suffix = details.length > 0 ? ` (${details.join('; ')})` : '';
      lines.push(`    - ${name}${suffix}`);
    }
  }

  const scans = extractScans(record);
  if (scans.length > 0) {
    lines.push('  Scans:');
    for (const scan of scans.slice(0, 5)) {
      lines.push(`    - ${scan.chosenUrl(false)}`);
    }
    if (scans.length > 5) {
      lines.push(`    - (+${scans.length - 5} more)`);
    }
  }

  const orig = a2aText(source['a2a_SourceDigitalOriginal']);
  if (orig) {
    lines.push(`  Original: ${orig}`);
  }

  return lines.join('\n');
}
