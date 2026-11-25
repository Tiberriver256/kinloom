import type { EventSourceRef, SourceRecord } from '../schemas/entities.js';
import { redactSensitiveCitationDetail } from './citations.js';

export interface GedcomSourMeta {
  xref: string;
  title: string;
  author: string;
  publisher: string;
  repoXref: string;
}

export interface GedcomObje {
  xref: string;
  title: string;
  form: string;
  mtype: string;
  width: number | null;
  height: number | null;
  date: string;
}

export interface GedcomEvent {
  tag: string;
  date: string;
  place: string;
  notes: string[];
  sources: { sourXref: string; page: string }[];
}

export interface GedcomNameEntry {
  raw: string;
  fullName: string;
  givenName: string;
  surname: string;
  nameType?: string;
}

export interface GedcomIndi {
  xref: string;
  fullName: string;
  givenName: string;
  surname: string;
  altNames: string[];
  nameEntries: GedcomNameEntry[];
  sex: string;
  famc: string[];
  fams: string[];
  events: GedcomEvent[];
  sources: string[];
  objes: string[];
  resn?: string;
}

export interface GedcomFam {
  xref: string;
  husb: string;
  wife: string;
  children: string[];
  marr?: GedcomEvent;
  events: GedcomEvent[];
  sources: string[];
}

export interface GedcomParseResult {
  repos: Map<string, string>;
  sours: Map<string, GedcomSourMeta>;
  objes: Map<string, GedcomObje>;
  indis: Map<string, GedcomIndi>;
  fams: Map<string, GedcomFam>;
  eventPages: Map<string, string[]>;
  indiObjes: Map<string, Set<string>>;
}

export function unescapeGedcomValue(value: string): string {
  return value.replaceAll('@@', '@');
}

export function parseGedcomNameValue(rawVal: string): GedcomNameEntry {
  const unescaped = unescapeGedcomValue(rawVal);
  const cleanName = unescaped.replaceAll('/', '').replaceAll(/\s+/g, ' ').trim();
  const surMatch = /\/([^/]+)\//.exec(unescaped);
  const surname = surMatch ? surMatch[1].trim() : '';
  const givenName = unescaped.replace(/\/[^/]*\//, '').replaceAll(/\s+/g, ' ').trim();
  return {
    raw: unescaped,
    fullName: cleanName,
    givenName: givenName || cleanName,
    surname,
  };
}

export function applyIndiName(ind: GedcomIndi, val: string): GedcomNameEntry {
  const entry = parseGedcomNameValue(val);
  ind.nameEntries.push(entry);
  if (!ind.fullName) {
    ind.fullName = entry.fullName;
    ind.givenName = entry.givenName;
    ind.surname = entry.surname;
  } else if (
    entry.fullName &&
    entry.fullName !== ind.fullName &&
    !ind.altNames.includes(entry.fullName)
  ) {
    ind.altNames.push(entry.fullName);
  }
  return entry;
}

export function attachPageToLastSource(
  curEvent: GedcomEvent,
  curSourRef: string,
  cleanPage: string
): void {
  if (curEvent.sources.length === 0) {
    return;
  }
  const last = curEvent.sources.at(-1);
  if (!last) {
    return;
  }
  if (last.sourXref === curSourRef && !last.page) {
    last.page = cleanPage;
  }
}

export function recordIndiPage(
  curXref: string,
  curSubTag: string,
  curSourRef: string,
  val: string,
  eventPages: Map<string, string[]>,
  curEvent: GedcomEvent | null
): void {
  const cleanPage = redactSensitiveCitationDetail(val);
  if (!cleanPage) {
    return;
  }
  const key = `${curXref}|${curSubTag}|${curSourRef}`;
  const arr = eventPages.get(key) ?? [];
  if (!arr.includes(cleanPage)) {
    arr.push(cleanPage);
  }
  eventPages.set(key, arr);
  if (curEvent) {
    attachPageToLastSource(curEvent, curSourRef, cleanPage);
  }
}

export interface PhotoAttachableEvent {
  photo_url?: string;
  photo_placeholder_caption?: string;
}

export function attachPhotoToEvent(
  ev: PhotoAttachableEvent | null | undefined,
  publicUrl: string,
  caption: string
): number {
  if (!ev) {
    return 0;
  }
  ev.photo_url = publicUrl;
  ev.photo_placeholder_caption = caption;
  return 1;
}

const normalizeCitationTokens = (s: string): string =>
  s
    .toLowerCase()
    .replaceAll(/\bu\.?\s*s\.?\s*a?\.?\b/g, ' ')
    .replaceAll(/[^a-z0-9]+/g, ' ')
    .replaceAll(/\s+/g, ' ')
    .trim();

export function recordScanMatchesSourceCitation(
  scanTitle: string,
  sourceCitation: string
): boolean {
  const a = normalizeCitationTokens(scanTitle);
  const b = normalizeCitationTokens(sourceCitation);
  if (!a || !b) {
    return false;
  }
  if (a === b || b.includes(a) || a.includes(b)) {
    return true;
  }
  const ca = /\b(18\d0|19\d0)\b.*census/.exec(a);
  const cb = /\b(18\d0|19\d0)\b.*census/.exec(b);
  if (ca && cb && ca[1] === cb[1]) {
    return true;
  }
  return false;
}

export function sourceMatchesRecordScan(
  sr: EventSourceRef,
  recTitle: string,
  allSourcesById: ReadonlyMap<string, SourceRecord>
): boolean {
  const sObj = allSourcesById.get(sr.source_id);
  return sObj !== undefined && recordScanMatchesSourceCitation(recTitle, sObj.citation || '');
}

export interface GedcomLinkedEvent {
  id: string;
  sources?: EventSourceRef[];
}

export function linkRecordScans(
  personEvts: readonly GedcomLinkedEvent[],
  recTitle: string,
  publicUrl: string,
  allSourcesById: ReadonlyMap<string, SourceRecord>
): { matchedEvId: string | undefined; linkedCount: number } {
  const matchedEvId = personEvts.find((ev) =>
    (ev.sources ?? []).some((sr) => sourceMatchesRecordScan(sr, recTitle, allSourcesById))
  )?.id;
  let linkedCount = 0;
  for (const ev of personEvts) {
    for (const sr of ev.sources ?? []) {
      if (!sourceMatchesRecordScan(sr, recTitle, allSourcesById)) {
        continue;
      }
      sr.scan_url = publicUrl;
      sr.scan_title = recTitle;
      linkedCount += 1;
    }
  }
  return { matchedEvId, linkedCount };
}

const INDI_EVENT_TAGS = new Set([
  'BIRT',
  'DEAT',
  'BURI',
  'RESI',
  'CHR',
  'BAPM',
  'IMMI',
  'EMIG',
  'OCCU',
  'MILI',
  'EVEN',
  'CENS',
]);

const FAM_EVENT_TAGS = new Set(['MARR', 'DIV', 'EVEN']);

export function parseGedcomText(text: string): GedcomParseResult {
  const cleanedText = text.startsWith('\uFEFF') ? text.slice(1) : text;
  const lines = cleanedText.split(/\r?\n/);

  const repos = new Map<string, string>();
  const sours = new Map<string, GedcomSourMeta>();
  const objes = new Map<string, GedcomObje>();
  const indis = new Map<string, GedcomIndi>();
  const fams = new Map<string, GedcomFam>();
  const eventPages = new Map<string, string[]>();
  const indiObjes = new Map<string, Set<string>>();

  let curType = '';
  let curXref = '';
  let curSubTag = '';
  let curEvent: GedcomEvent | null = null;
  let curNameEntry: GedcomNameEntry | null = null;
  let curSourRef = '';

  for (const line of lines) {
    const m = /^(\d+)\s+(?:(@[^@]+@)\s+)?([A-Z0-9_]+)(?:\s+(.*))?$/.exec(line);
    if (!m) {
      continue;
    }
    const [, levelStr, xrefRaw, tag, valRaw] = m;
    const level = Number(levelStr);
    const xref = xrefRaw || '';
    const val = (valRaw || '').trim();

    if (level === 0) {
      curType = tag;
      curXref = xref;
      curSubTag = '';
      curEvent = null;
      curNameEntry = null;
      curSourRef = '';
      if (tag === 'SOUR' && xref) {
        sours.set(xref, { xref, title: '', author: '', publisher: '', repoXref: '' });
      } else if (tag === 'OBJE' && xref) {
        objes.set(xref, {
          xref,
          title: '',
          form: '',
          mtype: '',
          width: null,
          height: null,
          date: '',
        });
      } else if (tag === 'INDI' && xref) {
        indis.set(xref, {
          xref,
          fullName: '',
          givenName: '',
          surname: '',
          altNames: [],
          nameEntries: [],
          sex: 'U',
          famc: [],
          fams: [],
          events: [],
          sources: [],
          objes: [],
        });
      } else if (tag === 'FAM' && xref) {
        fams.set(xref, { xref, husb: '', wife: '', children: [], events: [], sources: [] });
      }
      continue;
    }

    if (curType === 'REPO' && level === 1 && tag === 'NAME') {
      repos.set(curXref, unescapeGedcomValue(val));
    } else if (curType === 'SOUR') {
      const s = sours.get(curXref);
      if (!s) {
        continue;
      }
      if (level === 1 && tag === 'TITL') {
        s.title = unescapeGedcomValue(val);
      } else if (level === 1 && tag === 'AUTH') {
        s.author = unescapeGedcomValue(val);
      } else if (level === 1 && tag === 'PUBL') {
        s.publisher = unescapeGedcomValue(val);
      } else if (level === 1 && tag === 'REPO') {
        s.repoXref = val;
      } else if (level === 2 && tag === 'CONT' && curSubTag === 'PUBL') {
        s.publisher += ` ${unescapeGedcomValue(val)}`;
      }
      if (level === 1) {
        curSubTag = tag;
      }
    } else if (curType === 'OBJE') {
      const o = objes.get(curXref);
      if (!o) {
        continue;
      }
      if (tag === 'TITL' && !o.title) {
        o.title = unescapeGedcomValue(val);
      } else if (tag === 'FORM' && !o.form) {
        o.form = val;
      } else if (tag === '_MTYPE') {
        o.mtype = val;
      } else if (tag === '_WDTH') {
        o.width = Number(val) || null;
      } else if (tag === '_HGHT') {
        o.height = Number(val) || null;
      } else if (tag === 'DATE' && !o.date) {
        o.date = val;
      }
    } else if (curType === 'INDI') {
      const ind = indis.get(curXref);
      if (!ind) {
        continue;
      }
      if (level === 1) {
        curSubTag = tag;
        curEvent = null;
        curNameEntry = null;
        curSourRef = '';
        if (tag === 'NAME') {
          curNameEntry = applyIndiName(ind, val);
        } else if (tag === 'SEX') {
          ind.sex = val || 'U';
        } else if (tag === 'RESN') {
          ind.resn = val;
        } else if (tag === 'FAMC' && val) {
          if (!ind.famc.includes(val)) {
            ind.famc.push(val);
          }
        } else if (tag === 'FAMS' && val) {
          if (!ind.fams.includes(val)) {
            ind.fams.push(val);
          }
        } else if (tag === 'SOUR' && val.startsWith('@')) {
          if (!ind.sources.includes(val)) {
            ind.sources.push(val);
          }
        } else if (INDI_EVENT_TAGS.has(tag)) {
          curEvent = { tag, date: '', place: '', notes: [], sources: [] };
          ind.events.push(curEvent);
        } else if (tag === 'OBJE' && val.startsWith('@')) {
          ind.objes.push(val);
          const set = indiObjes.get(curXref) ?? new Set<string>();
          set.add(val);
          indiObjes.set(curXref, set);
        }
      } else if (level === 2) {
        if (curNameEntry && tag === 'TYPE') {
          curNameEntry.nameType = val.toLowerCase();
        } else if (curNameEntry && tag === 'GIVN' && val) {
          curNameEntry.givenName = unescapeGedcomValue(val);
        } else if (curNameEntry && tag === 'SURN' && val) {
          curNameEntry.surname = unescapeGedcomValue(val);
        } else if (curEvent && tag === 'DATE' && !curEvent.date) {
          curEvent.date = unescapeGedcomValue(val);
        } else if (curEvent && tag === 'PLAC' && !curEvent.place) {
          curEvent.place = unescapeGedcomValue(val);
        } else if (curEvent && tag === 'NOTE' && val) {
          curEvent.notes.push(unescapeGedcomValue(val));
        } else if (tag === 'SOUR' && val.startsWith('@')) {
          curSourRef = val;
          curEvent?.sources.push({ sourXref: val, page: '' });
          if (!ind.sources.includes(val)) {
            ind.sources.push(val);
          }
        } else if (tag === 'OBJE' && val.startsWith('@')) {
          ind.objes.push(val);
          const set = indiObjes.get(curXref) ?? new Set<string>();
          set.add(val);
          indiObjes.set(curXref, set);
        }
      } else if (level === 3 && tag === 'PAGE' && curSourRef) {
        recordIndiPage(curXref, curSubTag, curSourRef, val, eventPages, curEvent);
      }
    } else if (curType === 'FAM') {
      const fam = fams.get(curXref);
      if (!fam) {
        continue;
      }
      if (level === 1) {
        curSubTag = tag;
        curEvent = null;
        curSourRef = '';
        if (tag === 'HUSB') {
          fam.husb = val;
        } else if (tag === 'WIFE') {
          fam.wife = val;
        } else if (tag === 'CHIL') {
          fam.children.push(val);
        } else if (tag === 'SOUR' && val.startsWith('@')) {
          if (!fam.sources.includes(val)) {
            fam.sources.push(val);
          }
        } else if (FAM_EVENT_TAGS.has(tag)) {
          curEvent = { tag, date: '', place: '', notes: [], sources: [] };
          fam.events.push(curEvent);
          if (tag === 'MARR' && !fam.marr) {
            fam.marr = curEvent;
          }
        }
      } else if (level === 2 && curEvent) {
        if (tag === 'DATE' && !curEvent.date) {
          curEvent.date = unescapeGedcomValue(val);
        } else if (tag === 'PLAC' && !curEvent.place) {
          curEvent.place = unescapeGedcomValue(val);
        } else if (tag === 'NOTE' && val) {
          curEvent.notes.push(unescapeGedcomValue(val));
        } else if (tag === 'SOUR' && val.startsWith('@')) {
          curSourRef = val;
          curEvent.sources.push({ sourXref: val, page: '' });
          if (!fam.sources.includes(val)) {
            fam.sources.push(val);
          }
        }
      } else if (level === 3 && curEvent && tag === 'PAGE' && curSourRef) {
        const cleanPage = redactSensitiveCitationDetail(val);
        if (cleanPage) {
          attachPageToLastSource(curEvent, curSourRef, cleanPage);
        }
      }
    }
  }

  return { repos, sours, objes, indis, fams, eventPages, indiObjes };
}
