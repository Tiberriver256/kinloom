import { edtfYear, parseGedcomDateToEdtf } from '../edtf.js';
import type {
  AlternateDate,
  EventSourceRef,
  KinshipEdge,
  Place,
  RawEvent,
  RawPerson,
  SourceRecord,
} from '../schemas/entities.js';
import { cleanSourceCitationTitle, inferSourceRepository, UNVERIFIED_TREE_SOURCE_ID } from './citations.js';
import type { GedcomFam, GedcomIndi, GedcomSourMeta } from './parse.js';
import {
  detectLivingStatus,
  makeUniqueSlug,
  normalizePersonNames,
  normalizeRawPlace,
  placePrecisionFromType,
} from './sliceNormalization.js';
import type { GedcomLineageSelection, NormalizedPersonName } from './sliceTypes.js';

const TAG_METADATA: Readonly<
  Record<string, { titleTpl: string; kind: 'point_event' | 'residence_anchor'; role: string }>
> = {
  BIRT: { titleTpl: 'Birth of {name}', kind: 'point_event', role: 'birth_subject' },
  DEAT: { titleTpl: 'Death of {name}', kind: 'point_event', role: 'death_subject' },
  BURI: { titleTpl: 'Burial of {name}', kind: 'point_event', role: 'death_subject' },
  RESI: { titleTpl: 'Residence of {name}', kind: 'residence_anchor', role: 'resident' },
  CENS: { titleTpl: 'Census record for {name}', kind: 'residence_anchor', role: 'resident' },
  OCCU: { titleTpl: 'Occupation of {name}', kind: 'point_event', role: 'resident' },
  MILI: { titleTpl: 'Military record for {name}', kind: 'point_event', role: 'resident' },
  IMMI: { titleTpl: 'Immigration of {name}', kind: 'point_event', role: 'resident' },
  EMIG: { titleTpl: 'Emigration of {name}', kind: 'point_event', role: 'resident' },
  BAPM: { titleTpl: 'Baptism of {name}', kind: 'point_event', role: 'birth_subject' },
  CHR: { titleTpl: 'Christening of {name}', kind: 'point_event', role: 'birth_subject' },
  EVEN: { titleTpl: 'Recorded event for {name}', kind: 'point_event', role: 'resident' },
};

export function collectRawSlicePlaces(
  indis: ReadonlyMap<string, GedcomIndi>,
  fams: ReadonlyMap<string, GedcomFam>,
  selection: GedcomLineageSelection
): string[] {
  const rawPlaces: string[] = [];
  for (const xref of selection.orderedXrefs) {
    const ind = indis.get(xref);
    if (!ind) {
      continue;
    }
    for (const ev of ind.events) {
      if (ev.place) {
        rawPlaces.push(ev.place);
      }
    }
  }
  for (const fid of selection.allFamilyIds) {
    const fam = fams.get(fid);
    if (!fam) {
      continue;
    }
    for (const ev of fam.events) {
      if (ev.place) {
        rawPlaces.push(ev.place);
      }
    }
  }
  return rawPlaces;
}

export function buildSlicePeople(params: {
  indis: ReadonlyMap<string, GedcomIndi>;
  fams: ReadonlyMap<string, GedcomFam>;
  selection: GedcomLineageSelection;
  normalizeMaidenNames: boolean;
  branchId: string;
  referenceYear: number;
  livingCutoffYears: number;
}): {
  people: RawPerson[];
  xrefToPid: Map<string, string>;
  normalizedNamesByXref: Map<string, NormalizedPersonName>;
} {
  const { indis, fams, selection, normalizeMaidenNames, branchId, referenceYear, livingCutoffYears } = params;
  const usedSlugs = new Set<string>();
  const people: RawPerson[] = [];
  const xrefToPid = new Map<string, string>();
  const normalizedNamesByXref = new Map<string, NormalizedPersonName>();

  for (const xref of selection.orderedXrefs) {
    const ind = indis.get(xref);
    if (!ind) {
      continue;
    }
    const normNames = normalizePersonNames(ind, indis, fams, normalizeMaidenNames);
    normalizedNamesByXref.set(xref, normNames);

    const birt = ind.events.find((e) => e.tag === 'BIRT');
    const deat = ind.events.find((e) => e.tag === 'DEAT');
    const birthEdtf = birt?.date ? parseGedcomDateToEdtf(birt.date) : '';
    const deathEdtf = deat?.date ? parseGedcomDateToEdtf(deat.date) : '';
    const birthYear = edtfYear(birthEdtf);
    const isLiving = detectLivingStatus(ind, indis, fams, referenceYear, livingCutoffYears);

    const slug = makeUniqueSlug(normNames.fullName || xref, birthYear, usedSlugs);
    const pid = `per_${slug.replaceAll('-', '_')}`;
    xrefToPid.set(xref, pid);

    people.push({
      id: pid,
      slug,
      gedcom_xref: xref,
      full_name: normNames.fullName,
      given_name: normNames.givenName,
      surname: normNames.surname,
      alt_names: normNames.altNames,
      sex: ind.sex || 'U',
      is_living: isLiving,
      lineage_group: selection.bucketByXref.get(xref) ?? 'extended',
      branch: branchId,
      birth_edtf: birthEdtf,
      death_edtf: deathEdtf,
      portrait_url: null,
    });
  }

  return { people, xrefToPid, normalizedNamesByXref };
}

export function buildSliceKinship(
  fams: ReadonlyMap<string, GedcomFam>,
  allFamilyIds: readonly string[],
  xrefToPid: ReadonlyMap<string, string>
): KinshipEdge[] {
  const kinship: KinshipEdge[] = [];
  const seenKin = new Set<string>();
  const addKin = (
    from: string,
    to: string,
    relation: 'parent' | 'child' | 'spouse',
    familyXref: string
  ): void => {
    if (from === to) {
      return;
    }
    const key = `${from}|${to}|${relation}`;
    if (seenKin.has(key)) {
      return;
    }
    seenKin.add(key);
    kinship.push({ from, to, relation, family_xref: familyXref });
  };

  for (const fid of allFamilyIds) {
    const fam = fams.get(fid);
    if (!fam) {
      continue;
    }
    const h = xrefToPid.get(fam.husb);
    const w = xrefToPid.get(fam.wife);
    if (h && w) {
      addKin(h, w, 'spouse', fid);
      addKin(w, h, 'spouse', fid);
    }
    for (const cid of fam.children) {
      const c = xrefToPid.get(cid);
      if (!c) {
        continue;
      }
      if (h) {
        addKin(h, c, 'parent', fid);
        addKin(c, h, 'child', fid);
      }
      if (w) {
        addKin(w, c, 'parent', fid);
        addKin(c, w, 'child', fid);
      }
    }
  }

  return kinship;
}

export function buildSliceEventsAndSources(params: {
  indis: ReadonlyMap<string, GedcomIndi>;
  fams: ReadonlyMap<string, GedcomFam>;
  sours: ReadonlyMap<string, GedcomSourMeta>;
  repos: ReadonlyMap<string, string>;
  selection: GedcomLineageSelection;
  xrefToPid: ReadonlyMap<string, string>;
  normalizedNamesByXref: ReadonlyMap<string, NormalizedPersonName>;
  placesById: ReadonlyMap<string, Place>;
  rawToPlaceId: ReadonlyMap<string, string>;
}): {
  events: RawEvent[];
  sources: SourceRecord[];
  anomalies: string[];
} {
  const { indis, fams, sours, repos, selection, xrefToPid, normalizedNamesByXref, placesById, rawToPlaceId } =
    params;

  const sourcesById = new Map<string, SourceRecord>();
  sourcesById.set(UNVERIFIED_TREE_SOURCE_ID, {
    id: UNVERIFIED_TREE_SOURCE_ID,
    citation: 'Citation needed — unverified family tree entry (imported without an attached primary record)',
    source_type: 'unverified_tree_entry',
    repository: 'Needs primary verification',
  });

  const registerGedcomSource = (sref: string): string => {
    const cleanId = `src_ged_${sref.toLowerCase().replaceAll(/[^a-z0-9]+/g, '')}`;
    if (!sourcesById.has(cleanId)) {
      const meta = sours.get(sref);
      const rawTitle = meta?.title || sref;
      const cleanTitle = cleanSourceCitationTitle(rawTitle);
      const repoName = meta?.repoXref ? repos.get(meta.repoXref) : undefined;
      sourcesById.set(cleanId, {
        id: cleanId,
        gedcom_xref: sref,
        citation: cleanTitle,
        ...(meta?.author ? { author: meta.author } : {}),
        ...(meta?.publisher ? { publisher: meta.publisher } : {}),
        source_type: /census|index/i.test(cleanTitle) ? 'archival_index' : 'compiled_record',
        repository: inferSourceRepository(cleanTitle, repoName, meta?.publisher),
      });
    }
    return cleanId;
  };

  const events: RawEvent[] = [];
  const anomalies: string[] = [];
  let evtCounter = 0;

  const nextEvtId = (prefix: string, yr: number | null): string => {
    evtCounter += 1;
    const y = yr !== null ? String(yr) : 'undated';
    return `evt_${y}_${prefix}_${String(evtCounter).padStart(4, '0')}`;
  };

  const toEventSources = (
    refs: readonly { sourXref: string; page: string }[],
    defaultConfidence: 'high' | 'medium' | 'low'
  ): EventSourceRef[] => {
    if (refs.length === 0) {
      return [{ source_id: UNVERIFIED_TREE_SOURCE_ID, confidence: 'low' }];
    }
    return refs.map((ref) => ({
      source_id: registerGedcomSource(ref.sourXref),
      confidence: defaultConfidence,
      ...(ref.page ? { citation_detail: ref.page } : {}),
    }));
  };

  for (const xref of selection.orderedXrefs) {
    const ind = indis.get(xref);
    const pid = xrefToPid.get(xref);
    const norm = normalizedNamesByXref.get(xref);
    if (!ind || !pid || !norm) {
      continue;
    }
    const pname = norm.fullName;

    for (const tag of ['BIRT', 'DEAT'] as const) {
      const matching = ind.events.filter((e) => e.tag === tag);
      if (matching.length === 0) {
        continue;
      }
      if (matching.length > 1) {
        const desc = matching.map((m) => `${m.date || '?'} (${m.place || '?'})`).join(', ');
        anomalies.push(`${pname} (${xref}) has ${matching.length} ${tag} entries: ${desc}`);
      }
      const primary = matching[0];
      const edtf = parseGedcomDateToEdtf(primary.date);
      const yr = edtfYear(edtf);
      const plId = primary.place ? (rawToPlaceId.get(primary.place) ?? null) : null;
      const pl = plId ? placesById.get(plId) : undefined;
      const plPrec = pl ? placePrecisionFromType(pl.place_type) : 'county';

      const altDates: AlternateDate[] = [];
      for (const extra of matching.slice(1)) {
        const extraEdtf = parseGedcomDateToEdtf(extra.date);
        const extraSid =
          extra.sources.length > 0
            ? registerGedcomSource(extra.sources[0].sourXref)
            : UNVERIFIED_TREE_SOURCE_ID;
        const noteParts: string[] = [];
        if (extra.date && extra.date !== primary.date) {
          noteParts.push(`Alternate date: ${extra.date}`);
        }
        if (extra.place && extra.place !== primary.place) {
          noteParts.push(`Alternate place: ${extra.place}`);
        }
        if (noteParts.length > 0) {
          altDates.push({
            edtf_date: extraEdtf || edtf || '',
            source_id: extraSid,
            note: noteParts.join('; '),
          });
        }
      }

      const meta = TAG_METADATA[tag];
      const verb = tag === 'BIRT' ? 'was born' : 'died';
      const datePhrase = primary.date ? ` on ${primary.date}` : '';
      const placePhrase = primary.place ? ` in ${normalizeRawPlace(primary.place)}` : '';
      let summary = `${pname} ${verb}${datePhrase}${placePhrase}.`;
      if (altDates.length === 1) {
        summary += ' Note: 1 alternate record entry preserved.';
      } else if (altDates.length > 1) {
        summary += ` Note: ${altDates.length} alternate record entries preserved.`;
      }

      events.push({
        id: nextEvtId(tag.toLowerCase(), yr),
        title: meta.titleTpl.replace('{name}', pname),
        scope: 'personal',
        event_kind: meta.kind,
        category: 'life_milestone',
        edtf_date: edtf,
        alternate_dates: altDates,
        place_id: plId,
        place_precision: plPrec,
        summary,
        severity_rank: 5,
        participants: [{ person_id: pid, role: meta.role }],
        sources: toEventSources(primary.sources, 'medium'),
      });
    }

    const seenResi = new Set<string>();
    for (const ev of ind.events) {
      if (ev.tag === 'BIRT' || ev.tag === 'DEAT') {
        continue;
      }
      const edtf = parseGedcomDateToEdtf(ev.date);
      const plId = ev.place ? (rawToPlaceId.get(ev.place) ?? null) : null;
      if (!edtf && !plId) {
        continue;
      }
      if (ev.tag === 'RESI') {
        const dedupKey = `${edtf}|${plId ?? ''}`;
        if (seenResi.has(dedupKey)) {
          continue;
        }
        seenResi.add(dedupKey);
      }

      const yr = edtfYear(edtf);
      const meta = TAG_METADATA[ev.tag] ?? TAG_METADATA.EVEN;
      const pl = plId ? placesById.get(plId) : undefined;
      const plPrec = pl ? placePrecisionFromType(pl.place_type) : 'county';
      const placePhrase = ev.place ? normalizeRawPlace(ev.place) : 'recorded location';

      let title = meta.titleTpl.replace('{name}', pname);
      let summary = `Recorded ${ev.tag} fact for ${pname}${ev.place ? ` in ${placePhrase}` : ''}${ev.date ? ` (${ev.date})` : ''}.`;
      if (ev.tag === 'RESI') {
        title = pl ? `${pname} resided in ${pl.name}` : `Residence of ${pname}`;
        summary = `Archival residence record places ${pname} in ${placePhrase}${ev.date ? ` (${ev.date}).` : '.'}`;
      } else if (ev.tag === 'BURI') {
        title = `Burial of ${pname}`;
        summary = `${pname} was buried at ${placePhrase}.`;
      }

      events.push({
        id: nextEvtId(ev.tag.toLowerCase(), yr),
        title,
        scope: 'personal',
        event_kind: meta.kind,
        category: ev.tag === 'RESI' ? 'homestead' : 'life_milestone',
        edtf_date: edtf,
        alternate_dates: [],
        place_id: plId,
        place_precision: plPrec,
        summary,
        severity_rank: ev.tag === 'RESI' ? 4 : 3,
        participants: [{ person_id: pid, role: meta.role }],
        sources: toEventSources(ev.sources, ev.tag === 'RESI' ? 'high' : 'medium'),
      });
    }
  }

  for (const fid of selection.allFamilyIds) {
    const fam = fams.get(fid);
    if (!fam) {
      continue;
    }
    const hPid = xrefToPid.get(fam.husb);
    const wPid = xrefToPid.get(fam.wife);
    if (!hPid && !wPid) {
      continue;
    }
    const hName = normalizedNamesByXref.get(fam.husb)?.fullName ?? 'Spouse';
    const wName = normalizedNamesByXref.get(fam.wife)?.fullName ?? 'Spouse';

    for (const ev of fam.events) {
      if (ev.tag !== 'MARR' && ev.tag !== 'DIV') {
        continue;
      }
      const edtf = parseGedcomDateToEdtf(ev.date);
      const plId = ev.place ? (rawToPlaceId.get(ev.place) ?? null) : null;
      if (!edtf && !plId) {
        continue;
      }
      const yr = edtfYear(edtf);
      const participants: { person_id: string; role: string }[] = [];
      if (hPid) {
        participants.push({ person_id: hPid, role: 'spouse' });
      }
      if (wPid) {
        participants.push({ person_id: wPid, role: 'spouse' });
      }
      const pl = plId ? placesById.get(plId) : undefined;
      const plPrec = pl ? placePrecisionFromType(pl.place_type) : 'county';

      const verb = ev.tag === 'MARR' ? 'Marriage' : 'Divorce';
      const pastVerb = ev.tag === 'MARR' ? 'married' : 'divorced';
      const datePhrase = ev.date ? ` on ${ev.date}` : '';
      const placePhrase = ev.place ? ` in ${normalizeRawPlace(ev.place)}` : '';

      const famRefs =
        ev.sources.length > 0 ? ev.sources : fam.sources.map((s) => ({ sourXref: s, page: '' }));

      events.push({
        id: nextEvtId(ev.tag.toLowerCase(), yr),
        title: `${verb} of ${hName} and ${wName}`,
        scope: 'family',
        event_kind: 'point_event',
        category: 'family_milestone',
        edtf_date: edtf,
        alternate_dates: [],
        place_id: plId,
        place_precision: plPrec,
        summary: `${hName} and ${wName} ${pastVerb}${datePhrase}${placePhrase}.`,
        severity_rank: 6,
        participants,
        sources: toEventSources(famRefs, 'medium'),
      });
    }
  }

  return {
    events,
    sources: [...sourcesById.values()],
    anomalies,
  };
}
