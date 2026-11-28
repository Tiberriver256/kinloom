import {
  type AlternateDate,
  type EventParticipant,
  type EventScope,
  type EventSourceRef,
  type KinshipEdge,
  KinshipEdgeSchema,
  type KinshipRelation,
  type MediaItem,
  MediaItemSchema,
  type Narrative,
  type NarrativeKind,
  NarrativeSchema,
  type Place,
  PlaceSchema,
  type PlaceType,
  type Pronunciation,
  type RawEvent,
  RawEventSchema,
  type RawPerson,
  RawPersonSchema,
  type SourceConfidence,
  type SourceRecord,
  SourceRecordSchema,
} from './entities.js';

const EVENT_SCOPES = new Set<string>(['personal', 'family', 'local', 'state', 'national', 'global']);
const EVENT_KINDS = new Set<string>(['point_event', 'residence_anchor', 'context_span']);
const PLACE_TYPES = new Set<string>(['country', 'state', 'county', 'town', 'homestead']);
const KINSHIP_RELATIONS = new Set<string>(['parent', 'child', 'spouse']);
const SOURCE_CONFIDENCES = new Set<string>(['high', 'medium', 'low']);
const MEDIA_KINDS = new Set<string>([
  'document_scan',
  'portrait',
  'family_photo',
  'headstone',
  'record_scan',
  'milestone',
  'video_story',
  'audio_oral_history',
]);
const NARRATIVE_KINDS = new Set<string>(['biography', 'family_story', 'research_note', 'memoir']);

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function countOwnEnumerableKeys(obj: Record<string, unknown>): number {
  let count = 0;
  for (const _ in obj) {
    count += 1;
  }
  return count;
}

function hasExactOwnedKeys<T extends object>(
  obj: Record<string, unknown>,
  expectedKeys: number
): obj is Record<string, unknown> & T {
  return countOwnEnumerableKeys(obj) === expectedKeys;
}

function coerceEdtf(v: unknown): string | undefined {
  if (v === null || v === undefined) {
    return '';
  }
  if (typeof v === 'string') {
    return v;
  }
  if (typeof v === 'number' && Number.isFinite(v)) {
    return String(v);
  }
  return undefined;
}

const OPT_STR_FAIL = Symbol('OPT_STR_FAIL');
type OptNullableStrResult = string | null | undefined | typeof OPT_STR_FAIL;

function coerceOptNullableStrFast(v: unknown): OptNullableStrResult {
  if (v === undefined || v === null || typeof v === 'string') {
    return v;
  }
  if (typeof v === 'number' && Number.isFinite(v)) {
    return String(v);
  }
  return OPT_STR_FAIL;
}

const PRON_FAIL = Symbol('PRON_FAIL');
type PronResult = Pronunciation | null | undefined | typeof PRON_FAIL;

const PRON_STR_FIELDS = [
  'phonetic',
  'ipa',
  'language',
  'audio_url',
  'note',
  'source_url',
  'source_label',
  'region',
] as const;

function parseSimplePronunciationFast(v: unknown): PronResult {
  if (v === undefined || v === null) {
    return v;
  }
  if (!isObj(v) || v['variants'] !== undefined || v['match_full_name_contains'] !== undefined) {
    return PRON_FAIL;
  }
  const out: Pronunciation = {};
  for (const field of PRON_STR_FIELDS) {
    const fv = v[field];
    if (fv === undefined) {
      continue;
    }
    if (typeof fv !== 'string' || fv.length === 0) {
      return PRON_FAIL;
    }
    out[field] = fv;
  }
  return out;
}

export function tryFastParseRawPerson(raw: unknown, ownsInput = false): RawPerson | null {
  if (!isObj(raw)) {
    return null;
  }
  const { id, slug, full_name, given_name, surname } = raw;
  if (
    typeof id !== 'string' ||
    id.length === 0 ||
    typeof slug !== 'string' ||
    slug.length === 0 ||
    typeof full_name !== 'string' ||
    typeof given_name !== 'string' ||
    typeof surname !== 'string'
  ) {
    return null;
  }

  let altNames: string[];
  if (raw['alt_names'] === undefined) {
    altNames = [];
  } else {
    if (!Array.isArray(raw['alt_names'])) {
      return null;
    }
    if (ownsInput) {
      for (let i = 0; i < raw['alt_names'].length; i += 1) {
        if (typeof raw['alt_names'][i] !== 'string') {
          return null;
        }
      }
      altNames = raw['alt_names'] as string[];
    } else {
      altNames = new Array<string>(raw['alt_names'].length);
      for (let i = 0; i < raw['alt_names'].length; i += 1) {
        const a = raw['alt_names'][i];
        if (typeof a !== 'string') {
          return null;
        }
        altNames[i] = a;
      }
    }
  }

  const sex = raw['sex'] === undefined ? 'U' : raw['sex'];
  if (typeof sex !== 'string') {
    return null;
  }
  const isLiving = raw['is_living'] === undefined ? false : raw['is_living'];
  if (typeof isLiving !== 'boolean') {
    return null;
  }
  const lineageGroup = raw['lineage_group'] === undefined ? 'extended' : raw['lineage_group'];
  if (typeof lineageGroup !== 'string') {
    return null;
  }
  const birthEdtf = coerceEdtf(raw['birth_edtf']);
  const deathEdtf = coerceEdtf(raw['death_edtf']);
  if (birthEdtf === undefined || deathEdtf === undefined) {
    return null;
  }
  const portraitUrl = raw['portrait_url'] === undefined ? null : raw['portrait_url'];
  if (portraitUrl !== null && typeof portraitUrl !== 'string') {
    return null;
  }
  const gedcomXref = raw['gedcom_xref'];
  if (gedcomXref !== undefined && gedcomXref !== null && typeof gedcomXref !== 'string') {
    return null;
  }
  const branch = raw['branch'];
  if (branch !== undefined && typeof branch !== 'string') {
    return null;
  }
  const thumbUrl = raw['thumb_url'];
  if (thumbUrl !== undefined && thumbUrl !== null && typeof thumbUrl !== 'string') {
    return null;
  }
  const hasPrimarySource = raw['has_primary_source'];
  if (hasPrimarySource !== undefined && typeof hasPrimarySource !== 'boolean') {
    return null;
  }
  const extensions = raw['extensions'];
  if (extensions !== undefined && !isObj(extensions)) {
    return null;
  }
  const pron = parseSimplePronunciationFast(raw['pronunciation']);
  if (pron === PRON_FAIL) {
    return null;
  }

  if (
    ownsInput &&
    raw['alt_names'] === altNames &&
    raw['sex'] === sex &&
    raw['is_living'] === isLiving &&
    raw['lineage_group'] === lineageGroup &&
    raw['birth_edtf'] === birthEdtf &&
    raw['death_edtf'] === deathEdtf &&
    raw['portrait_url'] === portraitUrl &&
    raw['pronunciation'] === undefined
  ) {
    let expectedKeys = 12;
    if (gedcomXref !== undefined) expectedKeys += 1;
    if (branch !== undefined) expectedKeys += 1;
    if (thumbUrl !== undefined) expectedKeys += 1;
    if (hasPrimarySource !== undefined) expectedKeys += 1;
    if (extensions !== undefined) expectedKeys += 1;
    if (hasExactOwnedKeys<RawPerson>(raw, expectedKeys)) {
      return raw;
    }
  }

  if (gedcomXref === undefined && branch === undefined) {
    const out: RawPerson = {
      id,
      slug,
      full_name,
      given_name,
      surname,
      alt_names: altNames,
      sex,
      is_living: isLiving,
      lineage_group: lineageGroup,
      birth_edtf: birthEdtf,
      death_edtf: deathEdtf,
      portrait_url: portraitUrl,
    };
    if (thumbUrl !== undefined) {
      out.thumb_url = thumbUrl;
    }
    if (pron !== undefined) {
      out.pronunciation = pron;
    }
    if (hasPrimarySource !== undefined) {
      out.has_primary_source = hasPrimarySource;
    }
    if (extensions !== undefined) {
      out.extensions = ownsInput ? extensions : { ...extensions };
    }
    return out;
  }

  const out = { id, slug } as RawPerson;
  if (gedcomXref !== undefined) {
    out.gedcom_xref = gedcomXref;
  }
  out.full_name = full_name;
  out.given_name = given_name;
  out.surname = surname;
  out.alt_names = altNames;
  out.sex = sex;
  out.is_living = isLiving;
  out.lineage_group = lineageGroup;
  if (branch !== undefined) {
    out.branch = branch;
  }
  out.birth_edtf = birthEdtf;
  out.death_edtf = deathEdtf;
  out.portrait_url = portraitUrl;
  if (thumbUrl !== undefined) {
    out.thumb_url = thumbUrl;
  }
  if (pron !== undefined) {
    out.pronunciation = pron;
  }
  if (hasPrimarySource !== undefined) {
    out.has_primary_source = hasPrimarySource;
  }
  if (extensions !== undefined) {
    out.extensions = ownsInput ? extensions : { ...extensions };
  }
  return out;
}

function tryFastParseEventSourceRefs(raw: unknown, ownsInput = false): EventSourceRef[] | null {
  if (raw === undefined) {
    return [];
  }
  if (!Array.isArray(raw)) {
    return null;
  }
  if (ownsInput) {
    let canReuse = true;
    for (let i = 0; i < raw.length; i += 1) {
      const item = raw[i];
      if (!isObj(item)) {
        return null;
      }
      const { source_id, confidence } = item;
      if (
        typeof source_id !== 'string' ||
        source_id.length === 0 ||
        typeof confidence !== 'string' ||
        !SOURCE_CONFIDENCES.has(confidence)
      ) {
        return null;
      }
      const claimed = coerceOptNullableStrFast(item['claimed_date']);
      if (claimed === OPT_STR_FAIL) {
        return null;
      }
      const citationDetail = item['citation_detail'];
      const scanUrl = item['scan_url'];
      const scanTitle = item['scan_title'];
      if (
        (citationDetail !== undefined && citationDetail !== null && typeof citationDetail !== 'string') ||
        (scanUrl !== undefined && scanUrl !== null && typeof scanUrl !== 'string') ||
        (scanTitle !== undefined && scanTitle !== null && typeof scanTitle !== 'string')
      ) {
        return null;
      }
      let expectedKeys = 2;
      if (claimed !== undefined) expectedKeys += 1;
      if (citationDetail !== undefined) expectedKeys += 1;
      if (scanUrl !== undefined) expectedKeys += 1;
      if (scanTitle !== undefined) expectedKeys += 1;
      if (claimed !== item['claimed_date'] || countOwnEnumerableKeys(item) !== expectedKeys) {
        canReuse = false;
        break;
      }
    }
    if (canReuse) {
      return raw as EventSourceRef[];
    }
  }

  const out = new Array<EventSourceRef>(raw.length);
  for (let i = 0; i < raw.length; i += 1) {
    const item = raw[i];
    if (!isObj(item)) {
      return null;
    }
    const { source_id, confidence } = item;
    if (
      typeof source_id !== 'string' ||
      source_id.length === 0 ||
      typeof confidence !== 'string' ||
      !SOURCE_CONFIDENCES.has(confidence)
    ) {
      return null;
    }
    const claimed = coerceOptNullableStrFast(item['claimed_date']);
    if (claimed === OPT_STR_FAIL) {
      return null;
    }
    const citationDetail = item['citation_detail'];
    const scanUrl = item['scan_url'];
    const scanTitle = item['scan_title'];
    if (
      (citationDetail !== undefined && citationDetail !== null && typeof citationDetail !== 'string') ||
      (scanUrl !== undefined && scanUrl !== null && typeof scanUrl !== 'string') ||
      (scanTitle !== undefined && scanTitle !== null && typeof scanTitle !== 'string')
    ) {
      return null;
    }
    const ref: EventSourceRef = {
      source_id,
      confidence: confidence as SourceConfidence,
    };
    if (claimed !== undefined) {
      ref.claimed_date = claimed;
    }
    if (citationDetail !== undefined) {
      ref.citation_detail = citationDetail;
    }
    if (scanUrl !== undefined) {
      ref.scan_url = scanUrl;
    }
    if (scanTitle !== undefined) {
      ref.scan_title = scanTitle;
    }
    out[i] = ref;
  }
  return out;
}

export function tryFastParseRawEvent(raw: unknown, ownsInput = false): RawEvent | null {
  if (!isObj(raw)) {
    return null;
  }
  const { id, title, scope, event_kind } = raw;
  if (
    typeof id !== 'string' ||
    id.length === 0 ||
    typeof title !== 'string' ||
    typeof scope !== 'string' ||
    !EVENT_SCOPES.has(scope) ||
    typeof event_kind !== 'string' ||
    !EVENT_KINDS.has(event_kind)
  ) {
    return null;
  }
  if (
    raw['alternate_places'] !== undefined ||
    raw['fact_conflicts'] !== undefined ||
    raw['weather_metrics'] !== undefined
  ) {
    return null;
  }
  const edtfDate = coerceEdtf(raw['edtf_date']);
  if (edtfDate === undefined) {
    return null;
  }
  const placeId = raw['place_id'] === undefined ? null : raw['place_id'];
  if (placeId !== null && typeof placeId !== 'string') {
    return null;
  }
  const rawSummary = raw['summary'] === undefined || raw['summary'] === null ? '' : raw['summary'];
  if (typeof rawSummary !== 'string') {
    return null;
  }
  const category = raw['category'];
  if (category !== undefined && category !== null && typeof category !== 'string') {
    return null;
  }
  const placePrecision = raw['place_precision'];
  if (placePrecision !== undefined && placePrecision !== null && typeof placePrecision !== 'string') {
    return null;
  }
  const severityRank = raw['severity_rank'];
  if (
    severityRank !== undefined &&
    severityRank !== null &&
    (typeof severityRank !== 'number' || !Number.isFinite(severityRank))
  ) {
    return null;
  }
  const sourceUrl = raw['source_url'];
  if (sourceUrl !== undefined && sourceUrl !== null && typeof sourceUrl !== 'string') {
    return null;
  }
  const photoUrl = raw['photo_url'];
  if (photoUrl !== undefined && photoUrl !== null && typeof photoUrl !== 'string') {
    return null;
  }
  const photoCaption = raw['photo_placeholder_caption'];
  if (photoCaption !== undefined && photoCaption !== null && typeof photoCaption !== 'string') {
    return null;
  }
  const hasPrimarySource = raw['has_primary_source'];
  if (hasPrimarySource !== undefined && typeof hasPrimarySource !== 'boolean') {
    return null;
  }
  const extensions = raw['extensions'];
  if (extensions !== undefined && !isObj(extensions)) {
    return null;
  }

  let alternateDates: AlternateDate[] | undefined;
  if (raw['alternate_dates'] !== undefined) {
    if (!Array.isArray(raw['alternate_dates'])) {
      return null;
    }
    alternateDates = new Array<AlternateDate>(raw['alternate_dates'].length);
    for (let i = 0; i < raw['alternate_dates'].length; i += 1) {
      const ad = raw['alternate_dates'][i];
      if (!isObj(ad) || typeof ad['source_id'] !== 'string' || ad['source_id'].length === 0) {
        return null;
      }
      const adEdtf = coerceEdtf(ad['edtf_date']);
      if (adEdtf === undefined) {
        return null;
      }
      const note = ad['note'] === undefined || ad['note'] === null ? '' : ad['note'];
      if (typeof note !== 'string') {
        return null;
      }
      alternateDates[i] = { edtf_date: adEdtf, source_id: ad['source_id'], note };
    }
  }

  let participants: EventParticipant[];
  if (raw['participants'] === undefined) {
    participants = [];
  } else {
    if (!Array.isArray(raw['participants'])) {
      return null;
    }
    if (ownsInput) {
      let canReusePts = true;
      for (let i = 0; i < raw['participants'].length; i += 1) {
        const pt = raw['participants'][i];
        if (
          !isObj(pt) ||
          typeof pt['person_id'] !== 'string' ||
          pt['person_id'].length === 0 ||
          typeof pt['role'] !== 'string' ||
          pt['role'].length === 0
        ) {
          return null;
        }
        if (countOwnEnumerableKeys(pt) !== 2) {
          canReusePts = false;
          break;
        }
      }
      if (canReusePts) {
        participants = raw['participants'] as EventParticipant[];
      } else {
        participants = new Array<EventParticipant>(raw['participants'].length);
        for (let i = 0; i < raw['participants'].length; i += 1) {
          const pt = raw['participants'][i];
          if (
            !isObj(pt) ||
            typeof pt['person_id'] !== 'string' ||
            pt['person_id'].length === 0 ||
            typeof pt['role'] !== 'string' ||
            pt['role'].length === 0
          ) {
            return null;
          }
          participants[i] = { person_id: pt['person_id'], role: pt['role'] };
        }
      }
    } else {
      participants = new Array<EventParticipant>(raw['participants'].length);
      for (let i = 0; i < raw['participants'].length; i += 1) {
        const pt = raw['participants'][i];
        if (
          !isObj(pt) ||
          typeof pt['person_id'] !== 'string' ||
          pt['person_id'].length === 0 ||
          typeof pt['role'] !== 'string' ||
          pt['role'].length === 0
        ) {
          return null;
        }
        participants[i] = { person_id: pt['person_id'], role: pt['role'] };
      }
    }
  }

  const sources = tryFastParseEventSourceRefs(raw['sources'], ownsInput);
  if (!sources) {
    return null;
  }

  if (
    ownsInput &&
    raw['edtf_date'] === edtfDate &&
    raw['place_id'] === placeId &&
    raw['summary'] === rawSummary &&
    raw['participants'] === participants &&
    raw['sources'] === sources &&
    raw['alternate_dates'] === undefined
  ) {
    let expectedKeys = 9;
    if (category !== undefined) expectedKeys += 1;
    if (placePrecision !== undefined) expectedKeys += 1;
    if (severityRank !== undefined) expectedKeys += 1;
    if (sourceUrl !== undefined) expectedKeys += 1;
    if (photoUrl !== undefined) expectedKeys += 1;
    if (photoCaption !== undefined) expectedKeys += 1;
    if (hasPrimarySource !== undefined) expectedKeys += 1;
    if (extensions !== undefined) expectedKeys += 1;
    if (hasExactOwnedKeys<RawEvent>(raw, expectedKeys)) {
      return raw;
    }
  }

  const out = {
    id,
    title,
    scope: scope as EventScope,
    event_kind: event_kind as RawEvent['event_kind'],
  } as RawEvent;
  if (category !== undefined) {
    out.category = category;
  }
  out.edtf_date = edtfDate;
  if (alternateDates !== undefined) {
    out.alternate_dates = alternateDates;
  }
  out.place_id = placeId;
  if (placePrecision !== undefined) {
    out.place_precision = placePrecision;
  }
  out.summary = rawSummary;
  if (severityRank !== undefined) {
    out.severity_rank = severityRank;
  }
  if (sourceUrl !== undefined) {
    out.source_url = sourceUrl;
  }
  if (photoUrl !== undefined) {
    out.photo_url = photoUrl;
  }
  if (photoCaption !== undefined) {
    out.photo_placeholder_caption = photoCaption;
  }
  out.participants = participants;
  out.sources = sources;
  if (hasPrimarySource !== undefined) {
    out.has_primary_source = hasPrimarySource;
  }
  if (extensions !== undefined) {
    out.extensions = ownsInput ? extensions : { ...extensions };
  }
  return out;
}

export function tryFastParsePlace(raw: unknown, ownsInput = false): Place | null {
  if (!isObj(raw)) {
    return null;
  }
  const { id, slug, name, full_name, place_type, parent_id, lat, lng } = raw;
  if (
    typeof id !== 'string' ||
    id.length === 0 ||
    typeof slug !== 'string' ||
    slug.length === 0 ||
    typeof name !== 'string' ||
    name.length === 0 ||
    typeof full_name !== 'string' ||
    full_name.length === 0 ||
    typeof place_type !== 'string' ||
    !PLACE_TYPES.has(place_type) ||
    (parent_id !== null && typeof parent_id !== 'string') ||
    typeof lat !== 'number' ||
    !Number.isFinite(lat) ||
    lat < -90 ||
    lat > 90 ||
    typeof lng !== 'number' ||
    !Number.isFinite(lng) ||
    lng < -180 ||
    lng > 180
  ) {
    return null;
  }
  if (
    raw['historical_names'] !== undefined ||
    raw['sources'] !== undefined ||
    raw['ancestor_ids'] !== undefined ||
    raw['min_lat'] !== undefined ||
    raw['max_lat'] !== undefined ||
    raw['min_lng'] !== undefined ||
    raw['max_lng'] !== undefined
  ) {
    return null;
  }
  const summary = raw['summary'];
  if (summary !== undefined && summary !== null && typeof summary !== 'string') {
    return null;
  }
  const photoUrl = raw['photo_url'];
  if (photoUrl !== undefined && photoUrl !== null && typeof photoUrl !== 'string') {
    return null;
  }
  const photoCaption = raw['photo_caption'];
  if (photoCaption !== undefined && photoCaption !== null && typeof photoCaption !== 'string') {
    return null;
  }
  const hasPrimarySource = raw['has_primary_source'];
  if (hasPrimarySource !== undefined && typeof hasPrimarySource !== 'boolean') {
    return null;
  }
  const extensions = raw['extensions'];
  if (extensions !== undefined && !isObj(extensions)) {
    return null;
  }
  const pron = parseSimplePronunciationFast(raw['pronunciation']);
  if (pron === PRON_FAIL) {
    return null;
  }
  if (ownsInput && raw['pronunciation'] === undefined) {
    let expectedKeys = 8;
    if (summary !== undefined) expectedKeys += 1;
    if (photoUrl !== undefined) expectedKeys += 1;
    if (photoCaption !== undefined) expectedKeys += 1;
    if (hasPrimarySource !== undefined) expectedKeys += 1;
    if (extensions !== undefined) expectedKeys += 1;
    if (hasExactOwnedKeys<Place>(raw, expectedKeys)) {
      return raw;
    }
  }
  const out: Place = {
    id,
    slug,
    name,
    full_name,
    place_type: place_type as PlaceType,
    parent_id,
    lat,
    lng,
  };
  if (summary !== undefined) {
    out.summary = summary;
  }
  if (photoUrl !== undefined) {
    out.photo_url = photoUrl;
  }
  if (photoCaption !== undefined) {
    out.photo_caption = photoCaption;
  }
  if (pron !== undefined) {
    out.pronunciation = pron;
  }
  if (hasPrimarySource !== undefined) {
    out.has_primary_source = hasPrimarySource;
  }
  if (extensions !== undefined) {
    out.extensions = ownsInput ? extensions : { ...extensions };
  }
  return out;
}

export function tryFastParseSourceRecord(raw: unknown, ownsInput = false): SourceRecord | null {
  if (!isObj(raw)) {
    return null;
  }
  const { id, citation, source_type } = raw;
  if (
    typeof id !== 'string' ||
    id.length === 0 ||
    typeof citation !== 'string' ||
    typeof source_type !== 'string'
  ) {
    return null;
  }
  const gedcomXref = raw['gedcom_xref'];
  const author = raw['author'];
  const publisher = raw['publisher'];
  const repository = raw['repository'];
  const url = raw['url'];
  const hasPrimarySource = raw['has_primary_source'];
  if (
    (gedcomXref !== undefined && gedcomXref !== null && typeof gedcomXref !== 'string') ||
    (author !== undefined && author !== null && typeof author !== 'string') ||
    (publisher !== undefined && publisher !== null && typeof publisher !== 'string') ||
    (repository !== undefined && repository !== null && typeof repository !== 'string') ||
    (url !== undefined && url !== null && typeof url !== 'string') ||
    (hasPrimarySource !== undefined && typeof hasPrimarySource !== 'boolean')
  ) {
    return null;
  }
  if (ownsInput) {
    let expectedKeys = 3;
    if (gedcomXref !== undefined) expectedKeys += 1;
    if (author !== undefined) expectedKeys += 1;
    if (publisher !== undefined) expectedKeys += 1;
    if (repository !== undefined) expectedKeys += 1;
    if (url !== undefined) expectedKeys += 1;
    if (hasPrimarySource !== undefined) expectedKeys += 1;
    if (hasExactOwnedKeys<SourceRecord>(raw, expectedKeys)) {
      return raw;
    }
  }
  const out = { id } as SourceRecord;
  if (gedcomXref !== undefined) {
    out.gedcom_xref = gedcomXref;
  }
  out.citation = citation;
  if (author !== undefined) {
    out.author = author;
  }
  if (publisher !== undefined) {
    out.publisher = publisher;
  }
  out.source_type = source_type;
  if (repository !== undefined) {
    out.repository = repository;
  }
  if (url !== undefined) {
    out.url = url;
  }
  if (hasPrimarySource !== undefined) {
    out.has_primary_source = hasPrimarySource;
  }
  return out;
}

export function tryFastParseKinshipEdge(raw: unknown, ownsInput = false): KinshipEdge | null {
  if (!isObj(raw)) {
    return null;
  }
  const { from, to, relation } = raw;
  const familyXref = raw['family_xref'];
  if (
    typeof from !== 'string' ||
    from.length === 0 ||
    typeof to !== 'string' ||
    to.length === 0 ||
    typeof relation !== 'string' ||
    !KINSHIP_RELATIONS.has(relation) ||
    (familyXref !== undefined && familyXref !== null && typeof familyXref !== 'string')
  ) {
    return null;
  }
  if (ownsInput && hasExactOwnedKeys<KinshipEdge>(raw, familyXref !== undefined ? 4 : 3)) {
    return raw;
  }
  const out: KinshipEdge = {
    from,
    to,
    relation: relation as KinshipRelation,
  };
  if (familyXref !== undefined) {
    out.family_xref = familyXref;
  }
  return out;
}

export function tryFastParseMediaItem(raw: unknown, ownsInput = false): MediaItem | null {
  if (!isObj(raw)) {
    return null;
  }
  const { id, kind, file, caption } = raw;
  if (
    typeof id !== 'string' ||
    id.length === 0 ||
    typeof kind !== 'string' ||
    !MEDIA_KINDS.has(kind) ||
    typeof file !== 'string' ||
    file.length === 0 ||
    typeof caption !== 'string'
  ) {
    return null;
  }
  const dateEdtf = coerceOptNullableStrFast(raw['date_edtf']);
  if (dateEdtf === OPT_STR_FAIL) {
    return null;
  }
  const sourceId = raw['source_id'];
  const page = raw['page'];
  const personId = raw['person_id'];
  const personSlug = raw['person_slug'];
  const personName = raw['person_name'];
  const eventId = raw['event_id'];
  const thumbFile = raw['thumb_file'];
  const provenance = raw['provenance'];
  const mimeType = raw['mime_type'];
  const durationSeconds = raw['duration_seconds'];
  const posterUrl = raw['poster_url'];
  const transcriptUrl = raw['transcript_url'];
  const hasPrimarySource = raw['has_primary_source'];
  const extensions = raw['extensions'];
  if (
    (sourceId !== undefined && sourceId !== null && typeof sourceId !== 'string') ||
    (page !== undefined && page !== null && (typeof page !== 'number' || !Number.isInteger(page))) ||
    (personId !== undefined && personId !== null && typeof personId !== 'string') ||
    (personSlug !== undefined && personSlug !== null && typeof personSlug !== 'string') ||
    (personName !== undefined && personName !== null && typeof personName !== 'string') ||
    (eventId !== undefined && eventId !== null && typeof eventId !== 'string') ||
    (thumbFile !== undefined && thumbFile !== null && typeof thumbFile !== 'string') ||
    (provenance !== undefined && provenance !== null && typeof provenance !== 'string') ||
    (mimeType !== undefined &&
      mimeType !== null &&
      (typeof mimeType !== 'string' || mimeType.length === 0)) ||
    (durationSeconds !== undefined &&
      durationSeconds !== null &&
      (typeof durationSeconds !== 'number' || !Number.isFinite(durationSeconds) || durationSeconds < 0)) ||
    (posterUrl !== undefined &&
      posterUrl !== null &&
      (typeof posterUrl !== 'string' || posterUrl.length === 0)) ||
    (transcriptUrl !== undefined &&
      transcriptUrl !== null &&
      (typeof transcriptUrl !== 'string' || transcriptUrl.length === 0)) ||
    (hasPrimarySource !== undefined && typeof hasPrimarySource !== 'boolean') ||
    (extensions !== undefined && !isObj(extensions))
  ) {
    return null;
  }

  let personIds: string[] | undefined;
  if (raw['person_ids'] !== undefined) {
    const validatedIds = tryCopyNonEmptyStringArray(raw['person_ids'], ownsInput);
    if (!validatedIds) {
      return null;
    }
    personIds = validatedIds;
  }

  if (
    ownsInput &&
    raw['date_edtf'] === dateEdtf &&
    (personIds === undefined || raw['person_ids'] === personIds)
  ) {
    let expectedKeys = 4;
    if (sourceId !== undefined) expectedKeys += 1;
    if (page !== undefined) expectedKeys += 1;
    if (personId !== undefined) expectedKeys += 1;
    if (personIds !== undefined) expectedKeys += 1;
    if (personSlug !== undefined) expectedKeys += 1;
    if (personName !== undefined) expectedKeys += 1;
    if (eventId !== undefined) expectedKeys += 1;
    if (thumbFile !== undefined) expectedKeys += 1;
    if (dateEdtf !== undefined) expectedKeys += 1;
    if (provenance !== undefined) expectedKeys += 1;
    if (mimeType !== undefined) expectedKeys += 1;
    if (durationSeconds !== undefined) expectedKeys += 1;
    if (posterUrl !== undefined) expectedKeys += 1;
    if (transcriptUrl !== undefined) expectedKeys += 1;
    if (hasPrimarySource !== undefined) expectedKeys += 1;
    if (extensions !== undefined) expectedKeys += 1;
    if (hasExactOwnedKeys<MediaItem>(raw, expectedKeys)) {
      return raw;
    }
  }

  const out = { id, kind: kind as MediaItem['kind'] } as MediaItem;
  if (sourceId !== undefined) {
    out.source_id = sourceId;
  }
  if (page !== undefined) {
    out.page = page;
  }
  if (personId !== undefined) {
    out.person_id = personId;
  }
  if (personIds !== undefined) {
    out.person_ids = personIds;
  }
  if (personSlug !== undefined) {
    out.person_slug = personSlug;
  }
  if (personName !== undefined) {
    out.person_name = personName;
  }
  if (eventId !== undefined) {
    out.event_id = eventId;
  }
  out.file = file;
  if (thumbFile !== undefined) {
    out.thumb_file = thumbFile;
  }
  out.caption = caption;
  if (dateEdtf !== undefined) {
    out.date_edtf = dateEdtf;
  }
  if (provenance !== undefined) {
    out.provenance = provenance;
  }
  if (mimeType !== undefined) {
    out.mime_type = mimeType;
  }
  if (durationSeconds !== undefined) {
    out.duration_seconds = durationSeconds;
  }
  if (posterUrl !== undefined) {
    out.poster_url = posterUrl;
  }
  if (transcriptUrl !== undefined) {
    out.transcript_url = transcriptUrl;
  }
  if (hasPrimarySource !== undefined) {
    out.has_primary_source = hasPrimarySource;
  }
  if (extensions !== undefined) {
    out.extensions = ownsInput ? extensions : { ...extensions };
  }
  return out;
}

function tryCopyNonEmptyStringArray(raw: unknown, ownsInput = false): string[] | null {
  if (raw === undefined) {
    return [];
  }
  if (!Array.isArray(raw)) {
    return null;
  }
  if (ownsInput) {
    for (let i = 0; i < raw.length; i += 1) {
      const v = raw[i];
      if (typeof v !== 'string' || v.length === 0) {
        return null;
      }
    }
    return raw as string[];
  }
  const out = new Array<string>(raw.length);
  for (let i = 0; i < raw.length; i += 1) {
    const v = raw[i];
    if (typeof v !== 'string' || v.length === 0) {
      return null;
    }
    out[i] = v;
  }
  return out;
}

export function tryFastParseNarrative(raw: unknown, ownsInput = false): Narrative | null {
  if (!isObj(raw)) {
    return null;
  }
  const { id, slug, title, body_md } = raw;
  if (
    typeof id !== 'string' ||
    id.length === 0 ||
    typeof slug !== 'string' ||
    slug.length === 0 ||
    typeof title !== 'string' ||
    title.length === 0 ||
    typeof body_md !== 'string'
  ) {
    return null;
  }
  const kind = raw['kind'];
  if (kind !== undefined && (typeof kind !== 'string' || !NARRATIVE_KINDS.has(kind))) {
    return null;
  }
  const subjectPersonId = raw['subject_person_id'];
  if (
    subjectPersonId !== undefined &&
    (typeof subjectPersonId !== 'string' || subjectPersonId.length === 0)
  ) {
    return null;
  }
  const summary = raw['summary'];
  if (summary !== undefined && typeof summary !== 'string') {
    return null;
  }
  const dateEdtf = coerceOptNullableStrFast(raw['date_edtf']);
  if (dateEdtf === OPT_STR_FAIL) {
    return null;
  }
  const updatedAt = raw['updated_at'];
  if (updatedAt !== undefined && typeof updatedAt !== 'string') {
    return null;
  }
  const hasPrimarySource = raw['has_primary_source'];
  if (hasPrimarySource !== undefined && typeof hasPrimarySource !== 'boolean') {
    return null;
  }
  const extensions = raw['extensions'];
  if (extensions !== undefined && !isObj(extensions)) {
    return null;
  }
  const personIds = tryCopyNonEmptyStringArray(raw['person_ids'], ownsInput);
  const placeIds = tryCopyNonEmptyStringArray(raw['place_ids'], ownsInput);
  const eventIds = tryCopyNonEmptyStringArray(raw['event_ids'], ownsInput);
  const sourceIds = tryCopyNonEmptyStringArray(raw['source_ids'], ownsInput);
  if (!personIds || !placeIds || !eventIds || !sourceIds) {
    return null;
  }

  if (
    ownsInput &&
    raw['date_edtf'] === dateEdtf &&
    raw['person_ids'] === personIds &&
    raw['place_ids'] === placeIds &&
    raw['event_ids'] === eventIds &&
    raw['source_ids'] === sourceIds
  ) {
    let expectedKeys = 8;
    if (kind !== undefined) expectedKeys += 1;
    if (subjectPersonId !== undefined) expectedKeys += 1;
    if (summary !== undefined) expectedKeys += 1;
    if (dateEdtf !== undefined) expectedKeys += 1;
    if (updatedAt !== undefined) expectedKeys += 1;
    if (hasPrimarySource !== undefined) expectedKeys += 1;
    if (extensions !== undefined) expectedKeys += 1;
    if (hasExactOwnedKeys<Narrative>(raw, expectedKeys)) {
      return raw;
    }
  }

  const out = { id, slug } as Narrative;
  if (kind !== undefined) {
    out.kind = kind as NarrativeKind;
  }
  if (subjectPersonId !== undefined) {
    out.subject_person_id = subjectPersonId;
  }
  out.title = title;
  if (summary !== undefined) {
    out.summary = summary;
  }
  out.body_md = body_md;
  if (dateEdtf !== undefined) {
    out.date_edtf = dateEdtf;
  }
  out.person_ids = personIds;
  out.place_ids = placeIds;
  out.event_ids = eventIds;
  out.source_ids = sourceIds;
  if (updatedAt !== undefined) {
    out.updated_at = updatedAt;
  }
  if (hasPrimarySource !== undefined) {
    out.has_primary_source = hasPrimarySource;
  }
  if (extensions !== undefined) {
    out.extensions = ownsInput ? extensions : { ...extensions };
  }
  return out;
}

export function parseArrayWithFastPath<T>(
  raw: unknown,
  tryFast: (item: unknown, ownsInput: boolean) => T | null,
  fallbackParseArray: (raw: unknown) => T[],
  ownsInput = false
): T[] {
  if (!Array.isArray(raw)) {
    return fallbackParseArray(raw);
  }
  const out = new Array<T>(raw.length);
  for (let i = 0; i < raw.length; i += 1) {
    const parsed = tryFast(raw[i], ownsInput);
    if (parsed === null) {
      return fallbackParseArray(raw);
    }
    out[i] = parsed;
  }
  return out;
}

const RawPersonArraySchema = RawPersonSchema.array();
const RawEventArraySchema = RawEventSchema.array();
const PlaceArraySchema = PlaceSchema.array();
const SourceRecordArraySchema = SourceRecordSchema.array();
const KinshipEdgeArraySchema = KinshipEdgeSchema.array();
const MediaItemArraySchema = MediaItemSchema.array();
const NarrativeArraySchema = NarrativeSchema.array();

export function parsePeopleArrayFast(raw: unknown, ownsInput = false): RawPerson[] {
  return parseArrayWithFastPath(raw, tryFastParseRawPerson, (v) => RawPersonArraySchema.parse(v), ownsInput);
}

export function parseEventsArrayFast(raw: unknown, ownsInput = false): RawEvent[] {
  return parseArrayWithFastPath(raw, tryFastParseRawEvent, (v) => RawEventArraySchema.parse(v), ownsInput);
}

export function parsePlacesArrayFast(raw: unknown, ownsInput = false): Place[] {
  return parseArrayWithFastPath(raw, tryFastParsePlace, (v) => PlaceArraySchema.parse(v), ownsInput);
}

export function parseSourcesArrayFast(raw: unknown, ownsInput = false): SourceRecord[] {
  return parseArrayWithFastPath(
    raw,
    tryFastParseSourceRecord,
    (v) => SourceRecordArraySchema.parse(v),
    ownsInput
  );
}

export function parseKinshipArrayFast(raw: unknown, ownsInput = false): KinshipEdge[] {
  return parseArrayWithFastPath(
    raw,
    tryFastParseKinshipEdge,
    (v) => KinshipEdgeArraySchema.parse(v),
    ownsInput
  );
}

export function parseMediaArrayFast(raw: unknown, ownsInput = false): MediaItem[] {
  return parseArrayWithFastPath(raw, tryFastParseMediaItem, (v) => MediaItemArraySchema.parse(v), ownsInput);
}

export function parseNarrativesArrayFast(raw: unknown, ownsInput = false): Narrative[] {
  return parseArrayWithFastPath(raw, tryFastParseNarrative, (v) => NarrativeArraySchema.parse(v), ownsInput);
}
