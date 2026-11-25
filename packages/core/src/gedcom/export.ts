import type { KinloomSiteConfig } from '../schemas/config.js';
import type {
  ArchiveBundle,
  ArchiveEvent,
  Person,
  Place,
  SourceRecord,
} from '../schemas/entities.js';
import { UNVERIFIED_TREE_SOURCE_ID } from './citations.js';

const GEDCOM_MONTHS = [
  'JAN',
  'FEB',
  'MAR',
  'APR',
  'MAY',
  'JUN',
  'JUL',
  'AUG',
  'SEP',
  'OCT',
  'NOV',
  'DEC',
] as const;

export interface GedcomExportOptions {
  people: readonly Person[];
  bundle: ArchiveBundle;
  placesById: ReadonlyMap<string, Place>;
  sourcesById: ReadonlyMap<string, SourceRecord>;
  siteConfig?: Pick<KinloomSiteConfig, 'site' | 'privacy'>;
  filterDescription?: string;
  exportDate?: Date;
  includeRedactedLiving?: boolean;
}

function mustGet<K, V>(map: Map<K, V>, key: K, label: string): V {
  const value = map.get(key);
  if (value === undefined) {
    throw new Error(`Missing ${label} for ${String(key)}`);
  }
  return value;
}

export function escapeGedcomValue(raw: string): string {
  const cleaned = raw.replaceAll(/\r\n?/g, '\n').trim();
  return cleaned.startsWith('@') ? `@${cleaned}` : cleaned;
}

function pushTag(lines: string[], level: number, tag: string, value?: string): void {
  if (value === undefined || value === '') {
    lines.push(`${level} ${tag}`);
    return;
  }
  const normalized = value.replaceAll(/\r\n?/g, '\n').trim();
  if (!normalized) {
    return;
  }
  const parts = normalized.split('\n');
  for (const [idx, part] of parts.entries()) {
    const escaped = part.startsWith('@') ? `@${part}` : part;
    if (idx === 0) {
      lines.push(`${level} ${tag} ${escaped}`);
    } else {
      lines.push(`${level + 1} CONT ${escaped}`);
    }
  }
}

function formatSingleEdtfDate(cleaned: string): string {
  const decMatch = /^(\d{3})X$/.exec(cleaned);
  if (decMatch) {
    const y0 = Number(decMatch[1]) * 10;
    return `BET ${y0} AND ${y0 + 9}`;
  }

  const fullMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(cleaned);
  if (fullMatch) {
    const [, year, month, dayStr] = fullMatch;
    const monthIdx = Number(month) - 1;
    const day = Number(dayStr);
    const mon = GEDCOM_MONTHS[monthIdx];
    if (mon && day >= 1 && day <= 31) {
      return `${day} ${mon} ${year}`;
    }
  }

  const ymMatch = /^(\d{4})-(\d{2})$/.exec(cleaned);
  if (ymMatch) {
    const [, year, month] = ymMatch;
    const monthIdx = Number(month) - 1;
    const mon = GEDCOM_MONTHS[monthIdx];
    if (mon) {
      return `${mon} ${year}`;
    }
  }

  const yMatch = /^(\d{4})$/.exec(cleaned);
  if (yMatch) {
    return yMatch[1];
  }

  return '';
}

function formatIntervalSideDate(side: string, isLeft: boolean): string {
  const decMatch = /^(\d{3})X$/.exec(side);
  if (decMatch) {
    const y0 = Number(decMatch[1]) * 10;
    return String(isLeft ? y0 : y0 + 9);
  }
  return formatSingleEdtfDate(side);
}

/**
 * Convert EDTF dates into valid GEDCOM 7.0 date values.
 */
export function formatEdtfToGedcomDate(edtf?: string | number | null): string {
  if (edtf === null || edtf === undefined || edtf === '') {
    return '';
  }
  const raw = String(edtf).trim();
  if (!raw) {
    return '';
  }

  if (raw.includes('/')) {
    const idx = raw.indexOf('/');
    const left = raw.slice(0, idx).replace(/[~?%]+$/, '').trim();
    const right = raw.slice(idx + 1).replace(/[~?%]+$/, '').trim();
    const a = left ? formatIntervalSideDate(left, true) : '';
    const b = right ? formatIntervalSideDate(right, false) : '';
    if (a && b) {
      return `BET ${a} AND ${b}`;
    }
    if (a) {
      return `AFT ${a}`;
    }
    if (b) {
      return `BEF ${b}`;
    }
    return '';
  }

  const approx =
    raw.endsWith('~') || raw.endsWith('?') || raw.endsWith('%') || /^abt\.?\s/i.test(raw);
  const cleaned = raw
    .replaceAll(/[~?%]+$/g, '')
    .replace(/^abt\.?\s+/i, '')
    .trim();

  const single = formatSingleEdtfDate(cleaned);
  if (!single) {
    return '';
  }
  if (single.startsWith('BET ')) {
    return single;
  }
  return `${approx ? 'ABT ' : ''}${single}`;
}

export function formatGedcomName(
  person: Pick<Person, 'full_name' | 'given_name' | 'surname'>
): string {
  const given = (person.given_name || '').trim();
  const surname = (person.surname || '').trim();
  if (given && surname) {
    return `${given} /${surname}/`;
  }
  if (surname) {
    return `/${surname}/`;
  }
  const parts = (person.full_name || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    const last = parts.at(-1);
    const rest = parts.slice(0, -1).join(' ');
    return `${rest} /${last}/`;
  }
  return parts[0] || 'Unknown';
}

function classifyPersonalEventTag(ev: ArchiveEvent): { tag: string; eventType?: string } | null {
  const titleLow = (ev.title || '').toLowerCase();
  const cat = (ev.category || '').toLowerCase();
  if (titleLow.startsWith('birth')) {
    return { tag: 'BIRT' };
  }
  if (titleLow.startsWith('death')) {
    return { tag: 'DEAT' };
  }
  if (titleLow.startsWith('burial') || titleLow.includes('buried')) {
    return { tag: 'BURI' };
  }
  if (titleLow.includes('marriage') || titleLow.includes('married') || titleLow.includes('divorce')) {
    return null;
  }
  if (titleLow.includes('census')) {
    return { tag: 'CENS' };
  }
  if (
    ev.event_kind === 'residence_anchor' ||
    cat === 'homestead' ||
    titleLow.includes('residence') ||
    titleLow.includes('lived')
  ) {
    return { tag: 'RESI' };
  }
  if (titleLow.includes('immigration') || titleLow.includes('arrival')) {
    return { tag: 'IMMI' };
  }
  if (titleLow.includes('military') || titleLow.includes('draft')) {
    return { tag: 'EVEN', eventType: 'Military / Service' };
  }
  return { tag: 'EVEN', eventType: ev.title || 'Historical Event' };
}

function formatHeaderDate(date: Date): string {
  const day = date.getUTCDate();
  const mon = GEDCOM_MONTHS[date.getUTCMonth()];
  const year = date.getUTCFullYear();
  return `${day} ${mon} ${year}`;
}

/**
 * Parameterized GEDCOM 7.0 exporter for a filtered subset of people.
 * Emits `1 RESN CONFIDENTIAL` for living records and uses `siteConfig.site.gedcomSourceName` in `HEAD.SOUR`.
 */
export function buildFilteredGedcom7(options: GedcomExportOptions): string {
  const {
    people,
    bundle,
    placesById,
    sourcesById,
    siteConfig,
    filterDescription,
    exportDate = new Date(),
    includeRedactedLiving = false,
  } = options;

  const gedcomSourceId = siteConfig?.site.gedcomSourceName ?? 'KINLOOM_ARCHIVE';
  const siteTitle = siteConfig?.site.title ?? 'Kinloom Family Archive';
  const markConfidential = siteConfig?.privacy.markGedcomLivingConfidential ?? true;

  const orderedPeople: Person[] = [];
  const seenIds = new Set<string>();
  for (const p of people) {
    if (!includeRedactedLiving && p.is_living && p.full_name === 'Living') {
      continue;
    }
    if (seenIds.has(p.id)) {
      continue;
    }
    seenIds.add(p.id);
    orderedPeople.push(p);
  }

  const indiXrefById = new Map<string, string>();
  const personById = new Map<string, Person>();
  for (const [idx, p] of orderedPeople.entries()) {
    indiXrefById.set(p.id, `@I${idx + 1}@`);
    personById.set(p.id, p);
  }

  interface FamGroup {
    xref: string;
    spouses: string[];
    children: string[];
    events: ArchiveEvent[];
  }

  const famByKey = new Map<string, FamGroup>();
  const spousePairs = new Set<string>();
  const parentsOfChild = new Map<string, Set<string>>();

  for (const edge of bundle.kinship) {
    if (!seenIds.has(edge.from) || !seenIds.has(edge.to)) {
      continue;
    }
    if (edge.relation === 'spouse') {
      const pairKey = [edge.from, edge.to].toSorted().join('|');
      spousePairs.add(pairKey);
    } else if (edge.relation === 'parent') {
      const set = parentsOfChild.get(edge.to) ?? new Set<string>();
      set.add(edge.from);
      parentsOfChild.set(edge.to, set);
    } else if (edge.relation === 'child') {
      const set = parentsOfChild.get(edge.from) ?? new Set<string>();
      set.add(edge.to);
      parentsOfChild.set(edge.from, set);
    }
  }

  let famCounter = 0;
  const ensureFam = (spouseIds: string[]): FamGroup => {
    const key = [...spouseIds].toSorted().join('|');
    const existing = famByKey.get(key);
    if (existing) {
      return existing;
    }
    famCounter += 1;
    const created: FamGroup = {
      xref: `@F${famCounter}@`,
      spouses: [...spouseIds],
      children: [],
      events: [],
    };
    famByKey.set(key, created);
    return created;
  };

  for (const pairKey of [...spousePairs].toSorted()) {
    const [a, b] = pairKey.split('|');
    ensureFam([a, b]);
  }

  for (const child of orderedPeople) {
    const parentSet = parentsOfChild.get(child.id);
    if (!parentSet || parentSet.size === 0) {
      continue;
    }
    const parentIds = [...parentSet].toSorted();
    const fam = ensureFam(parentIds.slice(0, 2));
    if (!fam.children.includes(child.id)) {
      fam.children.push(child.id);
    }
  }

  for (const ev of bundle.events) {
    if (ev.scope !== 'personal' && ev.scope !== 'family') {
      continue;
    }
    const tLow = (ev.title || '').toLowerCase();
    if (!tLow.includes('marriage') && !tLow.includes('married') && !tLow.includes('divorce')) {
      continue;
    }
    const pIds = ev.participants.map((pt) => pt.person_id).filter((id) => seenIds.has(id));
    if (pIds.length >= 2) {
      const key = [pIds[0], pIds[1]].toSorted().join('|');
      const fam = famByKey.get(key) ?? ensureFam([pIds[0], pIds[1]]);
      fam.events.push(ev);
    }
  }

  const famsByPerson = new Map<string, string[]>();
  const famcByPerson = new Map<string, string[]>();
  for (const fam of famByKey.values()) {
    for (const spId of fam.spouses) {
      const list = famsByPerson.get(spId) ?? [];
      if (!list.includes(fam.xref)) {
        list.push(fam.xref);
      }
      famsByPerson.set(spId, list);
    }
    for (const chId of fam.children) {
      const list = famcByPerson.get(chId) ?? [];
      if (!list.includes(fam.xref)) {
        list.push(fam.xref);
      }
      famcByPerson.set(chId, list);
    }
  }

  const eventsByPerson = new Map<string, ArchiveEvent[]>();
  for (const ev of bundle.events) {
    if (ev.scope !== 'personal' && ev.scope !== 'family') {
      continue;
    }
    for (const pt of ev.participants) {
      if (!seenIds.has(pt.person_id)) {
        continue;
      }
      const list = eventsByPerson.get(pt.person_id) ?? [];
      list.push(ev);
      eventsByPerson.set(pt.person_id, list);
    }
  }

  const sourceXrefById = new Map<string, string>();
  const orderedSources: SourceRecord[] = [];
  const registerSource = (sourceId: string): string | null => {
    if (!sourceId || sourceId === UNVERIFIED_TREE_SOURCE_ID || sourceId === 'src_ancestry_gedcom_2026') {
      return null;
    }
    const existing = sourceXrefById.get(sourceId);
    if (existing) {
      return existing;
    }
    const rec = sourcesById.get(sourceId);
    if (!rec) {
      return null;
    }
    const xref = `@S${orderedSources.length + 1}@`;
    sourceXrefById.set(sourceId, xref);
    orderedSources.push(rec);
    return xref;
  };

  const lines: string[] = [
    '0 HEAD',
    '1 GEDC',
    '2 VERS 7.0',
    `1 SOUR ${gedcomSourceId}`,
    `2 NAME ${siteTitle}`,
    `1 DATE ${formatHeaderDate(exportDate)}`,
  ];
  const headerNote = filterDescription
    ? `Filtered export (${orderedPeople.length} relatives): ${filterDescription}`
    : `${siteTitle} export (${orderedPeople.length} relatives)`;
  pushTag(lines, 1, 'NOTE', headerNote);

  for (const p of orderedPeople) {
    const xref = mustGet(indiXrefById, p.id, 'person xref');
    lines.push(`0 ${xref} INDI`);
    if (p.is_living && markConfidential) {
      lines.push('1 RESN CONFIDENTIAL');
    }
    pushTag(lines, 1, 'NAME', formatGedcomName(p));
    if (p.given_name.trim()) {
      pushTag(lines, 2, 'GIVN', p.given_name.trim());
    }
    if (p.surname.trim()) {
      pushTag(lines, 2, 'SURN', p.surname.trim());
    }

    for (const alt of p.alt_names) {
      if (alt.trim()) {
        pushTag(lines, 1, 'NAME', alt.trim());
      }
    }

    const sex = (p.sex || '').toUpperCase();
    if (sex === 'M' || sex === 'F' || sex === 'X' || sex === 'U') {
      lines.push(`1 SEX ${sex}`);
    }

    const pEvents = [...(eventsByPerson.get(p.id) ?? [])].toSorted(
      (a, b) => (a.time_min ?? 99_999_999) - (b.time_min ?? 99_999_999)
    );

    let hasBirt = false;
    let hasDeat = false;

    for (const ev of pEvents) {
      const classified = classifyPersonalEventTag(ev);
      if (!classified) {
        continue;
      }
      if (classified.tag === 'BIRT') {
        hasBirt = true;
      }
      if (classified.tag === 'DEAT') {
        hasDeat = true;
      }

      lines.push(`1 ${classified.tag}`);
      if (classified.eventType) {
        pushTag(lines, 2, 'TYPE', classified.eventType);
      }
      const gedDate = formatEdtfToGedcomDate(ev.edtf_date) || (ev.year ? String(ev.year) : '');
      if (gedDate) {
        pushTag(lines, 2, 'DATE', gedDate);
      }
      const place = ev.place_id ? placesById.get(ev.place_id) : undefined;
      if (place?.full_name && !p.is_living) {
        pushTag(lines, 2, 'PLAC', place.full_name);
      }
      if (ev.summary.trim() && classified.tag !== 'BIRT' && classified.tag !== 'DEAT' && !p.is_living) {
        pushTag(lines, 2, 'NOTE', ev.summary.trim());
      }
      for (const sRef of ev.sources) {
        const sXref = registerSource(sRef.source_id);
        if (!sXref) {
          continue;
        }
        lines.push(`2 SOUR ${sXref}`);
        if (sRef.citation_detail?.trim()) {
          pushTag(lines, 3, 'PAGE', sRef.citation_detail.trim());
        }
      }
    }

    if (!hasBirt && (p.birth_edtf || p.birth_year)) {
      const d = p.is_living
        ? p.birth_year
          ? String(p.birth_year)
          : ''
        : formatEdtfToGedcomDate(p.birth_edtf) || (p.birth_year ? String(p.birth_year) : '');
      if (d) {
        lines.push('1 BIRT');
        pushTag(lines, 2, 'DATE', d);
      }
    }
    if (!hasDeat && !p.is_living && (p.death_edtf || p.death_year)) {
      const d = formatEdtfToGedcomDate(p.death_edtf) || (p.death_year ? String(p.death_year) : '');
      if (d) {
        lines.push('1 DEAT');
        pushTag(lines, 2, 'DATE', d);
      }
    }

    for (const famXref of famsByPerson.get(p.id) ?? []) {
      lines.push(`1 FAMS ${famXref}`);
    }
    for (const famXref of famcByPerson.get(p.id) ?? []) {
      lines.push(`1 FAMC ${famXref}`);
    }
  }

  for (const fam of famByKey.values()) {
    lines.push(`0 ${fam.xref} FAM`);
    const assigned = new Set<string>();
    const male = fam.spouses.find((id) => (personById.get(id)?.sex || '').toUpperCase() === 'M');
    if (male) {
      lines.push(`1 HUSB ${mustGet(indiXrefById, male, 'person xref')}`);
      assigned.add(male);
    }
    const female = fam.spouses.find(
      (id) => !assigned.has(id) && (personById.get(id)?.sex || '').toUpperCase() === 'F'
    );
    if (female) {
      lines.push(`1 WIFE ${mustGet(indiXrefById, female, 'person xref')}`);
      assigned.add(female);
    }
    for (const restId of fam.spouses) {
      if (assigned.has(restId)) {
        continue;
      }
      lines.push(`1 ${male ? 'WIFE' : 'HUSB'} ${mustGet(indiXrefById, restId, 'person xref')}`);
      assigned.add(restId);
    }
    for (const chId of fam.children) {
      lines.push(`1 CHIL ${mustGet(indiXrefById, chId, 'person xref')}`);
    }
    for (const ev of fam.events) {
      const isDiv = (ev.title || '').toLowerCase().includes('divorce');
      lines.push(`1 ${isDiv ? 'DIV' : 'MARR'}`);
      const gedDate = formatEdtfToGedcomDate(ev.edtf_date) || (ev.year ? String(ev.year) : '');
      if (gedDate) {
        pushTag(lines, 2, 'DATE', gedDate);
      }
      const place = ev.place_id ? placesById.get(ev.place_id) : undefined;
      if (place?.full_name) {
        pushTag(lines, 2, 'PLAC', place.full_name);
      }
      for (const sRef of ev.sources) {
        const sXref = registerSource(sRef.source_id);
        if (!sXref) {
          continue;
        }
        lines.push(`2 SOUR ${sXref}`);
        if (sRef.citation_detail?.trim()) {
          pushTag(lines, 3, 'PAGE', sRef.citation_detail.trim());
        }
      }
    }
  }

  for (const src of orderedSources) {
    const xref = mustGet(sourceXrefById, src.id, 'source xref');
    lines.push(`0 ${xref} SOUR`);
    pushTag(lines, 1, 'TITL', src.citation || src.id);
    if (src.author?.trim()) {
      pushTag(lines, 1, 'AUTH', src.author.trim());
    }
    if (src.publisher?.trim()) {
      pushTag(lines, 1, 'PUBL', src.publisher.trim());
    }
    if (src.repository?.trim()) {
      pushTag(lines, 1, 'NOTE', `Repository: ${src.repository.trim()}`);
    }
  }

  lines.push('0 TRLR');
  return `${lines.join('\n')}\n`;
}

/**
 * Convenience full-bundle GEDCOM 7.0 export parameterized by `KinloomSiteConfig`.
 */
export function exportGedcom7(
  bundle: ArchiveBundle,
  siteConfig: Pick<KinloomSiteConfig, 'site' | 'privacy'>,
  options?: {
    people?: readonly Person[];
    filterDescription?: string;
    exportDate?: Date;
    includeRedactedLiving?: boolean;
  }
): string {
  const placesById = new Map(bundle.places.map((p) => [p.id, p]));
  const sourcesById = new Map(bundle.sources.map((s) => [s.id, s]));
  return buildFilteredGedcom7({
    people: options?.people ?? bundle.people,
    bundle,
    placesById,
    sourcesById,
    siteConfig,
    filterDescription: options?.filterDescription,
    exportDate: options?.exportDate,
    includeRedactedLiving:
      options?.includeRedactedLiving ?? bundle.meta.build_mode === 'private',
  });
}

export interface GedcomFilenameParams {
  familySlug?: string;
  lineageFilter: string;
  selectedEra: string;
  onlyWithMedia: boolean;
  query: string;
  sortBy: string;
  count: number;
}

export function buildGedcomExportFilename(params: GedcomFilenameParams): string {
  const baseSlug = (params.familySlug || 'family-archive')
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '-')
    .replaceAll(/^-+|-+$/g, '');
  const parts: string[] = [baseSlug || 'family-archive'];
  if (params.lineageFilter && params.lineageFilter !== 'all') {
    parts.push(params.lineageFilter.replaceAll(/[^a-z0-9]+/gi, '-').toLowerCase());
  }
  if (params.selectedEra && params.selectedEra !== 'all') {
    parts.push(params.selectedEra.replaceAll(/[^a-z0-9]+/gi, '-').toLowerCase());
  }
  if (params.onlyWithMedia) {
    parts.push('with-media');
  }
  const cleanQ = params.query
    .trim()
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '-')
    .replaceAll(/^-+|-+$/g, '')
    .slice(0, 24);
  if (cleanQ) {
    parts.push(cleanQ);
  }
  if (params.sortBy && params.sortBy !== 'featured') {
    parts.push(`sorted-${params.sortBy.replaceAll(/[^a-z0-9]+/gi, '-').toLowerCase()}`);
  }
  parts.push(`${params.count}-relatives`);
  return `${parts.join('-')}.ged`;
}
