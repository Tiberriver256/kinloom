import { isPlainRecord } from '../../runtime/primitives.js';

export const WEBSITE_BASE = 'https://www.findagrave.com';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

export type JsonRecord = Record<string, unknown>;

export function coordsPair(obj: unknown): readonly [number | null, number | null] {
  if (!isPlainRecord(obj)) {
    return [null, null];
  }
  const lat = obj['lat'];
  const lon = obj['lon'] !== undefined && obj['lon'] !== null ? obj['lon'] : obj['lng'];
  if (typeof lat === 'number' && Number.isFinite(lat) && typeof lon === 'number' && Number.isFinite(lon)) {
    return [lat, lon];
  }
  return [null, null];
}

export function enrichCemetery(cemetery: unknown): unknown {
  if (!isPlainRecord(cemetery)) {
    return cemetery;
  }
  const [lat, lon] = coordsPair(cemetery['coordinates']);
  if (lat !== null && lon !== null) {
    return { ...cemetery, lat, lng: lon };
  }
  return { ...cemetery };
}

export function enrichMemorial(memorial: JsonRecord): JsonRecord {
  const cem = memorial['cemetery'];
  if (isPlainRecord(cem)) {
    const enrichedCem = enrichCemetery(cem) as JsonRecord;
    const [cemLat, cemLon] = coordsPair(enrichedCem['coordinates']);
    return {
      ...memorial,
      cemetery: enrichedCem,
      cemetery_lat: cemLat,
      cemetery_lng: cemLon,
    };
  }
  return {
    ...memorial,
    cemetery_lat: null,
    cemetery_lng: null,
  };
}

export function memorialUrl(memorialId: string): string {
  return `${WEBSITE_BASE}/memorial/${memorialId}`;
}

export function cemeteryUrl(cemeteryId: string): string {
  return `${WEBSITE_BASE}/cemetery/${cemeteryId}`;
}

export function primaryName(memorial: JsonRecord): string {
  const names = Array.isArray(memorial['name']) ? memorial['name'] : [];
  if (names.length === 0) {
    return '';
  }
  const firstEntry = isPlainRecord(names[0]) ? names[0] : {};
  const parts = [firstEntry['first'], firstEntry['last']].filter(
    (p): p is string => typeof p === 'string' && p.length > 0
  );
  let text = parts.join(' ');
  const maiden = firstEntry['maiden'];
  if (typeof maiden === 'string' && maiden.length > 0) {
    text += ` (nee ${maiden})`;
  }
  return text;
}

export function firstPlaceName(place: unknown): string {
  if (!isPlainRecord(place)) {
    return '';
  }
  const names = Array.isArray(place['names']) ? place['names'] : [];
  if (names.length === 0 || !isPlainRecord(names[0])) {
    return '';
  }
  return typeof names[0]['name'] === 'string' ? names[0]['name'] : '';
}

export function fmtDate(date: unknown): string {
  if (!isPlainRecord(date)) {
    return '';
  }
  const year = date['year'];
  if (year === null || year === undefined) {
    return '';
  }
  let text = String(year);
  const month = typeof date['month'] === 'number' ? date['month'] : undefined;
  const day = typeof date['day'] === 'number' ? date['day'] : undefined;
  if (month) {
    text = month >= 1 && month <= 12 ? `${MONTHS[month - 1]} ${text}` : text;
    if (day) {
      text = `${day} ${text}`;
    }
  }
  if (date['circa']) {
    text = `c. ${text}`;
  }
  return text;
}

export function fmtEvent(event: unknown): string {
  if (!isPlainRecord(event)) {
    return '';
  }
  const dateStr = fmtDate(event['date']);
  const placeStr = firstPlaceName(event['place']);
  return [dateStr, placeStr].filter((p) => p.length > 0).join(', ');
}

export function fmtCemetery(cemetery: unknown): string {
  if (!isPlainRecord(cemetery)) {
    return '';
  }
  const names = Array.isArray(cemetery['names']) ? cemetery['names'] : [];
  if (names.length === 0 || !isPlainRecord(names[0])) {
    return '';
  }
  return typeof names[0]['name'] === 'string' ? names[0]['name'] : '';
}

export function formatSearchText(total: unknown, memorials: readonly JsonRecord[]): string {
  const lines: string[] = [`${String(total ?? '')} memorials`];
  for (const mem of memorials) {
    const born = fmtEvent(mem['birth']);
    const died = fmtEvent(mem['death']);
    const cem = fmtCemetery(mem['cemetery']);
    const photo = mem['hasGravePhoto'] ? 'yes' : 'no';
    const vet = mem['isVeteran'] ? ' veteran' : '';
    const plot = typeof mem['plot'] === 'string' ? mem['plot'] : '';
    const id = String(mem['id'] ?? '');
    lines.push(
      `${id} | ${primaryName(mem)} | b. ${born} | d. ${died} | ${cem} | plot: ${plot} | grave photo: ${photo}${vet} | ${memorialUrl(id)}`
    );
  }
  return lines.join('\n');
}

export function formatMemorialsLines(
  memorials: readonly JsonRecord[],
  options: { readonly full: boolean; readonly photos: boolean }
): string[] {
  const lines: string[] = [];
  for (const mem of memorials) {
    const mid = String(mem['id'] ?? '');
    lines.push(`Memorial ${mid}: ${primaryName(mem)}`);
    lines.push(`  URL: ${memorialUrl(mid)}`);
    const born = fmtEvent(mem['birth']);
    const died = fmtEvent(mem['death']);
    if (born) {
      lines.push(`  Born: ${born}`);
    }
    if (died) {
      lines.push(`  Died: ${died}`);
    }
    const cem = isPlainRecord(mem['cemetery']) ? mem['cemetery'] : {};
    const cemName = fmtCemetery(cem);
    if (cemName) {
      lines.push(`  Cemetery: ${cemName} (${String(cem['id'] ?? '')})`);
    }
    const [cemLat, cemLon] = coordsPair(cem['coordinates']);
    if (cemLat !== null && cemLon !== null) {
      lines.push(`  Cemetery GPS: ${cemLat}, ${cemLon}`);
    }
    const [graveLat, graveLon] = coordsPair(mem['coordinates']);
    if (graveLat !== null && graveLon !== null) {
      lines.push(`  Grave GPS: ${graveLat}, ${graveLon}`);
    }
    if (typeof mem['plot'] === 'string' && mem['plot'].length > 0) {
      lines.push(`  Plot: ${mem['plot']}`);
    }
    const photosObj = isPlainRecord(mem['photos']) ? mem['photos'] : {};
    lines.push(
      `  Veteran: ${mem['isVeteran'] ? 'yes' : 'no'} | Grave photo: ${mem['hasGravePhoto'] ? 'yes' : 'no'} | Photos: ${String(photosObj['total'] ?? '')}`
    );
    const inscriptionObj = isPlainRecord(mem['inscription']) ? mem['inscription'] : {};
    const bioObj = isPlainRecord(mem['bio']) ? mem['bio'] : {};
    const inscription = typeof inscriptionObj['value'] === 'string' ? inscriptionObj['value'] : '';
    const bio = typeof bioObj['value'] === 'string' ? bioObj['value'] : '';
    if (inscription) {
      lines.push(`  Inscription: ${options.full ? inscription : inscription.slice(0, 500)}`);
    }
    if (bio) {
      lines.push(`  Bio: ${options.full ? bio : bio.slice(0, 500)}`);
    }
    const relations = Array.isArray(mem['relationships']) ? mem['relationships'] : [];
    if (relations.length > 0) {
      lines.push('  Relationships:');
      for (const rel of relations) {
        if (!isPlainRecord(rel)) {
          continue;
        }
        const target = isPlainRecord(rel['memorial']) ? rel['memorial'] : {};
        lines.push(
          `    ${String(rel['type'] ?? '')}: ${primaryName(target)} (${String(target['id'] ?? '')})`
        );
      }
    }
    if (options.photos) {
      const photoList = Array.isArray(photosObj['photos']) ? photosObj['photos'] : [];
      if (photoList.length > 0) {
        lines.push('  Photos:');
        for (const photoItem of photoList) {
          if (!isPlainRecord(photoItem)) {
            continue;
          }
          lines.push(
            `    ${String(photoItem['id'] ?? '')} | ${String(photoItem['type'] ?? '')} | ${String(photoItem['path'] ?? '')}`
          );
        }
      }
    }
    if (typeof mem['dateCreated'] === 'string' && mem['dateCreated'].length > 0) {
      lines.push(`  Created: ${mem['dateCreated']} | Modified: ${String(mem['dateModified'] ?? '')}`);
    }
  }
  return lines;
}

export function formatCemeteriesText(total: unknown, cemeteries: readonly JsonRecord[]): string {
  const lines: string[] = [`${String(total ?? '')} cemeteries`];
  for (const cem of cemeteries) {
    const names = Array.isArray(cem['names']) ? cem['names'] : [];
    const shown =
      names.length > 0 && isPlainRecord(names[0]) && typeof names[0]['name'] === 'string'
        ? names[0]['name']
        : '';
    let extra = '';
    if (names.length > 1) {
      const altNames = names
        .slice(1)
        .map((n) => (isPlainRecord(n) && typeof n['name'] === 'string' ? n['name'] : ''))
        .filter((s) => s.length > 0);
      if (altNames.length > 0) {
        extra = ` (also: ${altNames.join(', ')})`;
      }
    }
    const [lat, lon] = coordsPair(cem['coordinates']);
    const gps = lat !== null && lon !== null ? ` | GPS: ${lat}, ${lon}` : '';
    const id = String(cem['id'] ?? '');
    lines.push(
      `${id} | ${shown}${extra} | ${String(cem['memorialCount'] ?? '')} memorials${gps} | ${cemeteryUrl(id)}`
    );
  }
  return lines.join('\n');
}

export function formatPlacesText(result: JsonRecord): string {
  const lines: string[] = [`${String(result['total'] ?? '')} places`];
  const locations = Array.isArray(result['locations']) ? result['locations'] : [];
  for (const loc of locations) {
    if (!isPlainRecord(loc)) {
      continue;
    }
    const names = Array.isArray(loc['names']) ? loc['names'] : [];
    const shown =
      names.length > 0 && isPlainRecord(names[0]) && typeof names[0]['name'] === 'string'
        ? names[0]['name']
        : '';
    const kind = String(loc['__typename'] ?? '');
    const count = loc['memorialCount'];
    const suffix = count !== null && count !== undefined ? ` | ${String(count)} memorials` : '';
    lines.push(`${String(loc['id'] ?? '')} | ${kind} | ${shown}${suffix}`);
  }
  return lines.join('\n');
}
