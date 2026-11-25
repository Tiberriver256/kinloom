import type { ArchiveBundle, Place, ReadingsBundle } from '../schemas/entities.js';

export type SearchResultKind = 'person' | 'place' | 'event' | 'reading';

export interface ArchiveSearchResult {
  id: string;
  kind: SearchResultKind;
  title: string;
  subtitle: string;
  snippet?: string;
  score: number;
  route?: string;
  sourceReaderTarget?: {
    sourceId: string;
    page: number;
    query: string;
  };
}

export function buildExcerpt(text: string, query: string, radius = 64): string {
  const lower = text.toLowerCase();
  const q = query.trim().toLowerCase();
  if (!q) {
    return text.slice(0, radius * 2).replaceAll(/\s+/g, ' ').trim();
  }
  const idx = lower.indexOf(q);
  if (idx === -1) {
    return text.slice(0, radius * 2).replaceAll(/\s+/g, ' ').trim();
  }
  const start = Math.max(0, idx - radius);
  const end = Math.min(text.length, idx + q.length + radius);
  const raw = text.slice(start, end).replaceAll(/\s+/g, ' ').trim();
  return `${start > 0 ? '…' : ''}${raw}${end < text.length ? '…' : ''}`;
}

export function searchArchive(params: {
  query: string;
  bundle: ArchiveBundle | null;
  placesById: ReadonlyMap<string, Place>;
  readings?: ReadingsBundle | null;
  limitPerKind?: number;
}): ArchiveSearchResult[] {
  const { query, bundle, placesById, readings, limitPerKind = 6 } = params;
  const q = query.trim().toLowerCase();
  if (!bundle || q.length < 2) {
    return [];
  }

  const tokens = q.split(/\s+/).filter((t) => t.length >= 2);
  const matchesAllTokens = (haystack: string): boolean => tokens.every((t) => haystack.includes(t));

  // 1. People
  const peopleResults: ArchiveSearchResult[] = [];
  for (const p of bundle.people) {
    if (p.is_living && p.full_name === 'Living') {
      continue;
    }
    const pl = p.primary_place_id ? placesById.get(p.primary_place_id) : undefined;
    const hay =
      `${p.full_name} ${p.alt_names.join(' ')} ${p.birth_year ?? ''} ${p.death_year ?? ''} ${pl?.full_name ?? ''}`.toLowerCase();
    if (!matchesAllTokens(hay)) {
      continue;
    }
    const nameLower = p.full_name.toLowerCase();
    let score = 70;
    if (nameLower === q) {
      score = 120;
    } else if (nameLower.startsWith(q)) {
      score = 105;
    } else if (nameLower.includes(q)) {
      score = 92;
    }
    peopleResults.push({
      id: `person:${p.id}`,
      kind: 'person',
      title: p.full_name,
      subtitle: `${p.birth_year || '?'}–${p.death_year || (p.is_living ? 'Living' : '?')}${pl ? ` · ${pl.full_name}` : ''}`,
      score,
      route: `/person/${p.slug}`,
    });
  }
  peopleResults.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));

  // 2. Places
  const placeResults: ArchiveSearchResult[] = [];
  for (const pl of bundle.places) {
    const hay = `${pl.name} ${pl.full_name} ${pl.place_type}`.toLowerCase();
    if (!matchesAllTokens(hay)) {
      continue;
    }
    const nameLower = pl.name.toLowerCase();
    let score = 82;
    if (nameLower === q) {
      score = 110;
    } else if (nameLower.startsWith(q)) {
      score = 98;
    }
    placeResults.push({
      id: `place:${pl.id}`,
      kind: 'place',
      title: pl.full_name,
      subtitle: `${pl.place_type.toUpperCase()} · ${pl.lat.toFixed(2)}°N, ${Math.abs(pl.lng).toFixed(2)}°${pl.lng >= 0 ? 'E' : 'W'}`,
      score,
      route: `/place/${pl.slug}`,
    });
  }
  placeResults.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));

  // 3. Events
  const peopleById = new Map(bundle.people.map((p) => [p.id, p]));
  const eventResults: ArchiveSearchResult[] = [];
  for (const ev of bundle.events) {
    if (
      ev.scope !== 'personal' &&
      ev.scope !== 'family' &&
      ev.scope !== 'local' &&
      ev.scope !== 'state'
    ) {
      continue;
    }
    const pl = ev.place_id ? placesById.get(ev.place_id) : undefined;
    const conflictText = [
      ...(ev.alternate_dates ?? []).map((a) => `${a.edtf_date} ${a.note}`),
      ...(ev.alternate_places ?? []).map((a) => `${a.place_name} ${a.note}`),
      ...(ev.fact_conflicts ?? []).map((a) => `${a.claim} ${a.note}`),
    ].join(' ');
    const hay =
      `${ev.title} ${ev.summary} ${ev.display_date} ${ev.edtf_date} ${pl?.full_name ?? ''} ${conflictText}`.toLowerCase();
    if (!matchesAllTokens(hay)) {
      continue;
    }

    const firstPerson = ev.participants
      .map((pt) => peopleById.get(pt.person_id))
      .find((p) => p && (!p.is_living || p.full_name !== 'Living'));

    let route = '/';
    if (firstPerson) {
      route = `/person/${firstPerson.slug}?event=${ev.id}`;
    } else if (pl) {
      route = `/place/${pl.slug}`;
    }

    const titleHit = ev.title.toLowerCase().includes(q);
    eventResults.push({
      id: `event:${ev.id}`,
      kind: 'event',
      title: ev.title,
      subtitle: `${ev.display_date}${pl ? ` · ${pl.name}` : ''}${firstPerson ? ` · ${firstPerson.full_name}` : ''}`,
      snippet: buildExcerpt(ev.summary, query, 58),
      score: (titleHit ? 94 : 76) + Math.min(10, ev.severity_rank || 0),
      route,
    });
  }
  eventResults.sort((a, b) => b.score - a.score);

  // 4. Primary Source Transcriptions
  const readingResults: ArchiveSearchResult[] = [];
  if (readings) {
    for (const doc of Object.values(readings.documents)) {
      for (const page of doc.pages) {
        const hay = `${doc.title} ${page.label} ${page.text}`.toLowerCase();
        if (!matchesAllTokens(hay)) {
          continue;
        }
        const exactCount = page.text.toLowerCase().split(q).length - 1;
        readingResults.push({
          id: `reading:${doc.source_id}:${page.page}`,
          kind: 'reading',
          title: `${doc.title} — ${page.label}`,
          subtitle: doc.author,
          snippet: buildExcerpt(page.text, query, 66),
          score: 74 + Math.min(20, exactCount * 4),
          sourceReaderTarget: {
            sourceId: doc.source_id,
            page: page.page,
            query: query.trim(),
          },
        });
      }
    }
    readingResults.sort((a, b) => b.score - a.score);
  }

  return [
    ...peopleResults.slice(0, limitPerKind),
    ...placeResults.slice(0, limitPerKind),
    ...eventResults.slice(0, limitPerKind),
    ...readingResults.slice(0, limitPerKind),
  ];
}
