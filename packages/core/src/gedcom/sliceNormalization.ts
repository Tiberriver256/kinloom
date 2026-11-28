import { edtfYear, parseGedcomDateToEdtf } from '../edtf.js';
import { isPersonLivingPublic } from '../privacy.js';
import type { Place, PlaceType } from '../schemas/entities.js';
import type { GedcomFam, GedcomIndi } from './parse.js';
import type { KnownPlaceCoords, NormalizedPersonName } from './sliceTypes.js';

export function slugify(value: string): string {
  const slug = value
    .normalize('NFKD')
    .replaceAll(/[\u0300-\u036F]/g, '')
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '-')
    .replaceAll(/^-+|-+$/g, '');
  return slug || 'unknown';
}

export function makeUniqueSlug(name: string, birthYear: number | null, used: Set<string>): string {
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

export function splitName(fullName: string): { givenName: string; surname: string } {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  if (parts.length <= 1) {
    return { givenName: parts[0] ?? 'Unknown', surname: '' };
  }
  return {
    givenName: parts.slice(0, -1).join(' '),
    surname: parts.at(-1) ?? '',
  };
}

export function inferPlaceType(partsCount: number, indexFromEnd: number, segmentName: string): PlaceType {
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

export function placePrecisionFromType(placeType: PlaceType): string {
  if (placeType === 'homestead') {
    return 'exact';
  }
  if (placeType === 'town' || placeType === 'county' || placeType === 'state') {
    return placeType;
  }
  return 'county';
}

export function normalizeRawPlace(raw: string): string {
  return raw
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)
    .join(', ');
}

export function buildPlacesFromRaw(
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
    const name = segments[0] ?? '';
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
export function normalizePersonNames(
  ind: GedcomIndi,
  indis: ReadonlyMap<string, GedcomIndi>,
  fams: ReadonlyMap<string, GedcomFam>,
  normalizeMaidenNames: boolean
): NormalizedPersonName {
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

  const explicitBirth = ind.nameEntries.find(
    (entry) => entry.nameType === 'birth' || entry.nameType === 'maiden'
  );
  if (explicitBirth?.fullName) {
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

  if (ind.nameEntries.length > 1 && fatherSurnames.size > 0) {
    const maidenEntry = ind.nameEntries.find(
      (entry) => entry.surname && fatherSurnames.has(entry.surname.toLowerCase())
    );
    if (maidenEntry?.fullName) {
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

  const parenMatch = /^(.+?)\s*\(([A-Za-z][A-Za-z'-]+)\)\s+([A-Za-z][A-Za-z'-]+)$/.exec(fallbackName);
  if (parenMatch && parenMatch[1] && parenMatch[2] && parenMatch[3]) {
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

  if (
    fatherSurnames.size === 1 &&
    fallbackSplit.surname &&
    spouseSurnames.has(fallbackSplit.surname.toLowerCase()) &&
    !fatherSurnames.has(fallbackSplit.surname.toLowerCase())
  ) {
    const fatherFam = ind.famc.map((fid) => fams.get(fid)).find((f) => f?.husb && indis.has(f.husb));
    const fatherSurname = fatherFam ? (indis.get(fatherFam.husb)?.surname ?? '') : '';
    if (fatherSurname) {
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

export function detectLivingStatus(
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

  // Fallback heuristics for modern individuals missing a birth date.
  const modernMarriageCutoff = referenceYear - 61;
  const modernSpouseCutoff = referenceYear - 81;
  const modernParentCutoff = referenceYear - livingCutoffYears;

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
