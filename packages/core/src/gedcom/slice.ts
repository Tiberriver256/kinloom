import { edtfYear, parseGedcomDateToEdtf } from '../edtf.js';
import { getCurrentReferenceYear, isPersonLivingPublic } from '../privacy.js';
import type {
  AlternateDate,
  EventSourceRef,
  KinshipEdge,
  Place,
  PlaceType,
  RawEvent,
  RawPerson,
  SourceRecord,
} from '../schemas/entities.js';
import { cleanSourceCitationTitle, inferSourceRepository, UNVERIFIED_TREE_SOURCE_ID } from './citations.js';
import { type GedcomFam, type GedcomIndi, parseGedcomText } from './parse.js';

export interface KnownPlaceCoords {
  lat: number;
  lng: number;
  place_type?: PlaceType;
}

export interface SliceGedcomOptions {
  /** Exact GEDCOM xref of the pivot/root individual (e.g. '@I10@'). */
  rootXref?: string;
  /** Case-insensitive full-name match used when rootXref is omitted. */
  rootName?: string;
  /**
   * Surnames that continue expanding upward along the direct ancestral line.
   * Married-in spouses whose surname is not in this list stay paired without
   * pulling in their upstream spouse-parent subtrees (unless expandSpouseAncestors is true).
   */
  ancestorSurnames?: readonly string[];
  /** Include complete sibling sets of direct ancestors (default true). */
  includeAncestorSiblings?: boolean;
  /** Include spouses of descendants (default true). */
  includeDescendantSpouses?: boolean;
  /** Expand parents of married-in spouses (default false). */
  expandSpouseAncestors?: boolean;
  /** Stop descending past these xrefs (the person is kept, their children are skipped). */
  stopDescendantXrefs?: readonly string[];
  /** Optional cap on ancestor generations walked above root. */
  maxAncestorDepth?: number;
  /** Optional cap on descendant generations walked below root. */
  maxDescendantDepth?: number;
  /** Branch identifier stamped onto output people (default 'primary'). */
  branchId?: string;
  /** Normalize maiden/birth surnames as primary and move married names to alt_names (default true). */
  normalizeMaidenNames?: boolean;
  /** Reference year for 100-year living-person detection (default 2026). */
  referenceYear?: number;
  /** Living cutoff age in years (default 101). */
  livingCutoffYears?: number;
  /** Optional known place coordinates lookup (lowercased full place name -> lat/lng). */
  knownPlaces?: Readonly<Record<string, KnownPlaceCoords>>;
}

export interface SliceGedcomResult {
  rootXref: string;
  people: RawPerson[];
  events: RawEvent[];
  places: Place[];
  sources: SourceRecord[];
  kinship: KinshipEdge[];
  anomalies: string[];
  stats: {
    totalGedcomIndividuals: number;
    ancestors: number;
    ancestorSiblings: number;
    descendants: number;
    descendantSpouses: number;
    totalPeople: number;
    totalEvents: number;
    totalPlaces: number;
    totalSources: number;
    totalKinshipEdges: number;
  };
}

function slugify(value: string): string {
  const slug = value
    .normalize('NFKD')
    .replaceAll(/[\u0300-\u036F]/g, '')
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '-')
    .replaceAll(/^-+|-+$/g, '');
  return slug || 'unknown';
}

function makeUniqueSlug(name: string, birthYear: number | null, used: Set<string>): string {
  const base = slugify(name);
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  if (birthYear !== null) {
    const withYear = `${base}-${birthYear}`;
    if (!used.has(withYear)) {
      used.add(withYear);
      return withYear;
    }
  }
  let idx = 2;
  while (used.has(`${base}-${idx}`)) {
    idx += 1;
  }
  const cand = `${base}-${idx}`;
  used.add(cand);
  return cand;
}

function splitName(fullName: string): { givenName: string; surname: string } {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  if (parts.length <= 1) {
    return { givenName: parts[0] ?? 'Unknown', surname: '' };
  }
  return {
    givenName: parts.slice(0, -1).join(' '),
    surname: parts.at(-1) ?? '',
  };
}

function inferPlaceType(partsCount: number, indexFromEnd: number, segmentName: string): PlaceType {
  if (indexFromEnd === 0) {
    return 'country';
  }
  if (indexFromEnd === 1) {
    return 'state';
  }
  if (indexFromEnd === 2) {
    return 'county';
  }
  if (/\b(homestead|ranch|farm|cemetery|church)\b/i.test(segmentName)) {
    return 'homestead';
  }
  return partsCount >= 4 ? 'town' : 'county';
}

function placePrecisionFromType(placeType: PlaceType): string {
  if (placeType === 'homestead') {
    return 'exact';
  }
  if (placeType === 'town' || placeType === 'county' || placeType === 'state') {
    return placeType;
  }
  return 'county';
}

function normalizeRawPlace(raw: string): string {
  return raw
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)
    .join(', ');
}

function buildPlacesFromRaw(
  rawPlaces: readonly string[],
  knownPlaces?: Readonly<Record<string, KnownPlaceCoords>>
): { placesById: Map<string, Place>; rawToPlaceId: Map<string, string> } {
  const placesById = new Map<string, Place>();
  const rawToPlaceId = new Map<string, string>();
  const fullNameToId = new Map<string, string>();

  const ensurePlace = (segments: string[]): string => {
    const fullName = segments.join(', ');
    const key = fullName.toLowerCase();
    const existing = fullNameToId.get(key);
    if (existing) {
      return existing;
    }

    const parentId = segments.length > 1 ? ensurePlace(segments.slice(1)) : null;
    const name = segments[0];
    const slug = slugify(fullName);
    const id = `plc_${slug}`;
    const known = knownPlaces?.[key];
    const placeType = known?.place_type ?? inferPlaceType(segments.length, segments.length - 1, name);

    const place: Place = {
      id,
      slug,
      name,
      full_name: fullName,
      place_type: placeType,
      parent_id: parentId,
      lat: known?.lat ?? 0,
      lng: known?.lng ?? 0,
      historical_names: [],
    };
    placesById.set(id, place);
    fullNameToId.set(key, id);
    return id;
  };

  for (const raw of rawPlaces) {
    const cleaned = normalizeRawPlace(raw);
    if (!cleaned) {
      continue;
    }
    const segments = cleaned
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (segments.length === 0) {
      continue;
    }
    const pid = ensurePlace(segments);
    rawToPlaceId.set(raw, pid);
  }

  return { placesById, rawToPlaceId };
}

/**
 * Resolve birth/maiden name as primary and keep married names in alt_names.
 */
function normalizePersonNames(
  ind: GedcomIndi,
  indis: ReadonlyMap<string, GedcomIndi>,
  fams: ReadonlyMap<string, GedcomFam>,
  normalizeMaidenNames: boolean
): { fullName: string; givenName: string; surname: string; altNames: string[] } {
  const fallbackName = ind.fullName || 'Unknown';
  const fallbackSplit =
    ind.givenName && ind.surname
      ? { givenName: ind.givenName, surname: ind.surname }
      : splitName(fallbackName);

  if (!normalizeMaidenNames) {
    return {
      fullName: fallbackName,
      givenName: fallbackSplit.givenName,
      surname: fallbackSplit.surname,
      altNames: [...ind.altNames],
    };
  }

  // Gather father's surname (when known) and spouse surnames (to detect married names).
  const fatherSurnames = new Set<string>();
  for (const fid of ind.famc) {
    const fam = fams.get(fid);
    if (fam?.husb) {
      const father = indis.get(fam.husb);
      if (father?.surname) {
        fatherSurnames.add(father.surname.toLowerCase());
      }
    }
  }

  const spouseSurnames = new Set<string>();
  for (const fid of ind.fams) {
    const fam = fams.get(fid);
    if (!fam) {
      continue;
    }
    const spXref = fam.husb === ind.xref ? fam.wife : fam.husb;
    if (spXref) {
      const sp = indis.get(spXref);
      if (sp?.surname) {
        spouseSurnames.add(sp.surname.toLowerCase());
      }
    }
  }

  // 1. Explicit GEDCOM 2 TYPE birth / maiden name entry wins.
  const explicitBirth = ind.nameEntries.find(
    (entry) => entry.nameType === 'birth' || entry.nameType === 'maiden'
  );
  if (explicitBirth && explicitBirth.fullName) {
    const alts = new Set<string>();
    for (const entry of ind.nameEntries) {
      if (entry.fullName && entry.fullName !== explicitBirth.fullName) {
        alts.add(entry.fullName);
      }
    }
    return {
      fullName: explicitBirth.fullName,
      givenName: explicitBirth.givenName,
      surname: explicitBirth.surname,
      altNames: [...alts],
    };
  }

  // 2. If multiple NAME entries exist and one matches father's surname while primary matches a spouse's surname, promote maiden name.
  if (ind.nameEntries.length > 1 && fatherSurnames.size > 0) {
    const maidenEntry = ind.nameEntries.find(
      (entry) => entry.surname && fatherSurnames.has(entry.surname.toLowerCase())
    );
    if (maidenEntry && maidenEntry.fullName) {
      const alts = new Set<string>();
      for (const entry of ind.nameEntries) {
        if (entry.fullName && entry.fullName !== maidenEntry.fullName) {
          alts.add(entry.fullName);
        }
      }
      return {
        fullName: maidenEntry.fullName,
        givenName: maidenEntry.givenName,
        surname: maidenEntry.surname,
        altNames: [...alts],
      };
    }
  }

  // 3. Parenthetical maiden name pattern like "Jane (Smith) Doe" -> primary "Jane Smith", alt "Jane Doe".
  const parenMatch = /^(.+?)\s*\(([A-Za-z][A-Za-z'-]+)\)\s+([A-Za-z][A-Za-z'-]+)$/.exec(fallbackName);
  if (parenMatch) {
    const given = parenMatch[1].trim();
    const maiden = parenMatch[2].trim();
    const married = parenMatch[3].trim();
    const primaryFull = `${given} ${maiden}`;
    const marriedFull = `${given} ${married}`;
    const alts = new Set<string>([marriedFull, ...ind.altNames]);
    alts.delete(primaryFull);
    return {
      fullName: primaryFull,
      givenName: given,
      surname: maiden,
      altNames: [...alts],
    };
  }

  // 4. Single NAME entry whose surname matches a spouse's surname, while father's surname is known and differs.
  if (
    fatherSurnames.size === 1 &&
    fallbackSplit.surname &&
    spouseSurnames.has(fallbackSplit.surname.toLowerCase()) &&
    !fatherSurnames.has(fallbackSplit.surname.toLowerCase())
  ) {
    const fatherFam = ind.famc.map((fid) => fams.get(fid)).find((f) => f?.husb && indis.has(f.husb));
    const fatherSurname = fatherFam ? (indis.get(fatherFam.husb)?.surname ?? '') : '';
    if (fatherSurname) {
      // Remove duplicate maiden surname from end of given name if present (e.g. "Mary Smith" + "Doe")
      const givenTokens = fallbackSplit.givenName.split(/\s+/).filter(Boolean);
      const lastGiven = givenTokens.at(-1);
      const cleanedGiven =
        lastGiven && lastGiven.toLowerCase() === fatherSurname.toLowerCase() && givenTokens.length > 1
          ? givenTokens.slice(0, -1).join(' ')
          : fallbackSplit.givenName;
      const primaryFull = `${cleanedGiven} ${fatherSurname}`.trim();
      const alts = new Set<string>([fallbackName, ...ind.altNames]);
      alts.delete(primaryFull);
      return {
        fullName: primaryFull,
        givenName: cleanedGiven,
        surname: fatherSurname,
        altNames: [...alts],
      };
    }
  }

  return {
    fullName: fallbackName,
    givenName: fallbackSplit.givenName,
    surname: fallbackSplit.surname,
    altNames: [...ind.altNames],
  };
}

function detectLivingStatus(
  ind: GedcomIndi,
  indis: ReadonlyMap<string, GedcomIndi>,
  fams: ReadonlyMap<string, GedcomFam>,
  referenceYear: number,
  livingCutoffYears: number
): boolean {
  if (ind.resn && /confidential|privacy/i.test(ind.resn)) {
    return true;
  }
  const hasDeathOrBurial = ind.events.some((e) => e.tag === 'DEAT' || e.tag === 'BURI');
  if (hasDeathOrBurial) {
    return false;
  }

  const birthEv = ind.events.find((e) => e.tag === 'BIRT');
  const birthYear = birthEv ? edtfYear(parseGedcomDateToEdtf(birthEv.date)) : null;
  if (birthYear !== null) {
    return isPersonLivingPublic({
      hasDeathOrBurial: false,
      birthYear,
      earliestEventYear: birthYear,
      referenceYear,
      livingCutoffYears,
    });
  }

  // Fallback heuristics for modern individuals missing a birth date: check marriage, spouse, and parent birth years.
  const modernMarriageCutoff = referenceYear - 61;
  const modernSpouseCutoff = referenceYear - 81;
  const modernParentCutoff = referenceYear - 101;

  for (const fid of ind.fams) {
    const fam = fams.get(fid);
    if (!fam) {
      continue;
    }
    const marrYr = fam.marr ? edtfYear(parseGedcomDateToEdtf(fam.marr.date)) : null;
    if (marrYr !== null && marrYr >= modernMarriageCutoff) {
      return true;
    }
    const spXref = fam.husb === ind.xref ? fam.wife : fam.husb;
    if (spXref) {
      const sp = indis.get(spXref);
      const spBirt = sp?.events.find((e) => e.tag === 'BIRT');
      const spYr = spBirt ? edtfYear(parseGedcomDateToEdtf(spBirt.date)) : null;
      if (spYr !== null && spYr >= modernSpouseCutoff) {
        return true;
      }
    }
  }

  for (const fid of ind.famc) {
    const fam = fams.get(fid);
    if (!fam) {
      continue;
    }
    for (const parentXref of [fam.husb, fam.wife]) {
      if (!parentXref) {
        continue;
      }
      const parent = indis.get(parentXref);
      const pBirt = parent?.events.find((e) => e.tag === 'BIRT');
      const pYr = pBirt ? edtfYear(parseGedcomDateToEdtf(pBirt.date)) : null;
      if (pYr !== null && pYr >= modernParentCutoff) {
        return true;
      }
    }
  }

  const allYears = ind.events
    .map((e) => edtfYear(parseGedcomDateToEdtf(e.date)))
    .filter((y): y is number => y !== null);
  if (allYears.length > 0) {
    const earliest = Math.min(...allYears);
    return isPersonLivingPublic({
      hasDeathOrBurial: false,
      birthYear: null,
      earliestEventYear: earliest,
      referenceYear,
      livingCutoffYears,
    });
  }

  return false;
}

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

/**
 * Generic GEDCOM slice seeder: extracts a lineage slice from a combined GEDCOM export,
 * normalizes maiden/birth names as primary, respects spine + complete siblings + spouse pairing
 * without upstream spouse-parent subtrees unless configured, and emits raw Kinloom entities.
 */
export function sliceGedcom(gedcomText: string, options: SliceGedcomOptions): SliceGedcomResult {
  const parsed = parseGedcomText(gedcomText);
  const { indis, fams, sours, repos } = parsed;

  const includeAncestorSiblings = options.includeAncestorSiblings ?? true;
  const includeDescendantSpouses = options.includeDescendantSpouses ?? true;
  const expandSpouseAncestors = options.expandSpouseAncestors ?? false;
  const normalizeMaidenNames = options.normalizeMaidenNames ?? true;
  const branchId = options.branchId ?? 'primary';
  const referenceYear = options.referenceYear ?? getCurrentReferenceYear();
  const livingCutoffYears = options.livingCutoffYears ?? 101;
  const stopDescendants = new Set(options.stopDescendantXrefs ?? []);
  const ancestorSurnamesLower = (options.ancestorSurnames ?? [])
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  // Resolve root individual
  let rootXref = options.rootXref ?? '';
  if (!rootXref && options.rootName) {
    const needle = options.rootName.trim().toLowerCase();
    for (const ind of indis.values()) {
      if (ind.fullName.toLowerCase() === needle || ind.altNames.some((alt) => alt.toLowerCase() === needle)) {
        rootXref = ind.xref;
        break;
      }
    }
  }
  if (!rootXref || !indis.has(rootXref)) {
    throw new Error(
      `Root individual not found in GEDCOM (rootXref=${options.rootXref ?? ''}, rootName=${options.rootName ?? ''})`
    );
  }

  // 1. Walk ancestors from rootXref
  const ancestors: string[] = [];
  const visitedAnc = new Set<string>();
  const ancestorFamilies: string[] = [];

  const matchesAncestorSurname = (ind: GedcomIndi): boolean => {
    if (ancestorSurnamesLower.length === 0) {
      return expandSpouseAncestors;
    }
    const lowerFull = ind.fullName.toLowerCase();
    const lowerSur = ind.surname.toLowerCase();
    return ancestorSurnamesLower.some((target) => lowerSur === target || lowerFull.includes(target));
  };

  const walkAncestors = (xref: string, expandParents: boolean, depth: number): void => {
    if (!xref || !indis.has(xref) || visitedAnc.has(xref)) {
      return;
    }
    visitedAnc.add(xref);
    ancestors.push(xref);
    if (!expandParents) {
      return;
    }
    if (options.maxAncestorDepth !== undefined && depth >= options.maxAncestorDepth) {
      return;
    }
    const ind = indis.get(xref);
    if (!ind) {
      return;
    }
    for (const fid of ind.famc) {
      const fam = fams.get(fid);
      if (!fam) {
        continue;
      }
      if (!ancestorFamilies.includes(fid)) {
        ancestorFamilies.push(fid);
      }
      for (const parentXref of [fam.husb, fam.wife]) {
        if (!parentXref || !indis.has(parentXref)) {
          continue;
        }
        const parentInd = indis.get(parentXref);
        if (!parentInd) {
          continue;
        }
        const keepWalking =
          expandSpouseAncestors ||
          (ancestorSurnamesLower.length > 0 ? matchesAncestorSurname(parentInd) : parentXref === fam.husb);
        walkAncestors(parentXref, keepWalking, depth + 1);
      }
    }
  };

  walkAncestors(rootXref, true, 0);

  // 2. Collect complete sibling sets for ancestor families
  const ancestorSiblings: string[] = [];
  if (includeAncestorSiblings) {
    for (const fid of ancestorFamilies) {
      const fam = fams.get(fid);
      if (!fam) {
        continue;
      }
      for (const cid of fam.children) {
        if (indis.has(cid) && !visitedAnc.has(cid) && !ancestorSiblings.includes(cid)) {
          ancestorSiblings.push(cid);
        }
      }
    }
  }

  // 3. Walk descendants from rootXref
  const descendants: string[] = [];
  const descendantSpouses: string[] = [];
  const descendantFamilies: string[] = [];
  const visitedDesc = new Set<string>();

  const walkDescendants = (xref: string, depth: number): void => {
    if (!xref || !indis.has(xref) || visitedDesc.has(xref)) {
      return;
    }
    visitedDesc.add(xref);
    descendants.push(xref);
    const ind = indis.get(xref);
    if (!ind) {
      return;
    }
    for (const fid of ind.fams) {
      const fam = fams.get(fid);
      if (!fam) {
        continue;
      }
      if (!descendantFamilies.includes(fid)) {
        descendantFamilies.push(fid);
      }
      if (includeDescendantSpouses) {
        const sp = fam.husb === xref ? fam.wife : fam.husb;
        if (sp && indis.has(sp) && !descendantSpouses.includes(sp) && !visitedDesc.has(sp)) {
          descendantSpouses.push(sp);
        }
      }
      if (stopDescendants.has(xref)) {
        continue;
      }
      if (options.maxDescendantDepth !== undefined && depth >= options.maxDescendantDepth) {
        continue;
      }
      for (const cid of fam.children) {
        walkDescendants(cid, depth + 1);
      }
    }
  };

  walkDescendants(rootXref, 0);

  // Preserve deterministic order across slice buckets
  const orderedXrefs = [
    ...new Set([...descendants, ...ancestors, ...ancestorSiblings, ...descendantSpouses]),
  ];
  const allFamilyIds = [...new Set([...ancestorFamilies, ...descendantFamilies])];

  const bucketByXref = new Map<string, string>();
  for (const x of ancestors) {
    bucketByXref.set(x, 'ancestor');
  }
  for (const x of ancestorSiblings) {
    if (!bucketByXref.has(x)) {
      bucketByXref.set(x, 'colonial_sibling');
    }
  }
  for (const x of descendants) {
    bucketByXref.set(x, 'descendant');
  }
  for (const x of descendantSpouses) {
    if (!bucketByXref.has(x)) {
      bucketByXref.set(x, 'descendant_spouse');
    }
  }
  bucketByXref.set(rootXref, 'pivot_ancestor');

  // Collect all raw places across slice individuals and families
  const rawPlaces: string[] = [];
  for (const xref of orderedXrefs) {
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
  for (const fid of allFamilyIds) {
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

  const { placesById, rawToPlaceId } = buildPlacesFromRaw(rawPlaces, options.knownPlaces);

  // Build RawPerson list
  const usedSlugs = new Set<string>();
  const people: RawPerson[] = [];
  const xrefToPid = new Map<string, string>();
  const normalizedNamesByXref = new Map<
    string,
    { fullName: string; givenName: string; surname: string; altNames: string[] }
  >();

  for (const xref of orderedXrefs) {
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
      lineage_group: bucketByXref.get(xref) ?? 'extended',
      branch: branchId,
      birth_edtf: birthEdtf,
      death_edtf: deathEdtf,
      portrait_url: null,
    });
  }

  // Build Sources map
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

  // Build Kinship edges
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

  // Build Events and detect anomalies
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

  for (const xref of orderedXrefs) {
    const ind = indis.get(xref);
    const pid = xrefToPid.get(xref);
    const norm = normalizedNamesByXref.get(xref);
    if (!ind || !pid || !norm) {
      continue;
    }
    const pname = norm.fullName;

    // Singleton BIRT and DEAT events with alternate_dates capture
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

    // Other individual events
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

  // Family marriage / divorce events
  for (const fid of allFamilyIds) {
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
    rootXref,
    people,
    events,
    places: [...placesById.values()],
    sources: [...sourcesById.values()],
    kinship,
    anomalies,
    stats: {
      totalGedcomIndividuals: indis.size,
      ancestors: ancestors.length,
      ancestorSiblings: ancestorSiblings.length,
      descendants: descendants.length,
      descendantSpouses: descendantSpouses.length,
      totalPeople: people.length,
      totalEvents: events.length,
      totalPlaces: placesById.size,
      totalSources: sourcesById.size,
      totalKinshipEdges: kinship.length,
    },
  };
}
