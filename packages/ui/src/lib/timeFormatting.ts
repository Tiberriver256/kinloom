import type { ArchiveBundle, ArchiveEvent } from '@kinloom/core';
import { isPersonAliveInYear, TIME_MAX_YEAR, TIME_MIN_YEAR } from '@kinloom/core';

export interface ArchiveYearDensityPoint {
  readonly year: number;
  readonly aliveCount: number;
  readonly eventCount: number;
}

export interface RidgelineGeometry {
  readonly areaPath: string;
  readonly linePath: string;
  readonly activeX: number;
  readonly hasData: boolean;
}

export function ensureTerminalPunctuation(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) {
    return '';
  }
  if (/\.{2}$/.test(trimmed) && !/\.{3}$/.test(trimmed)) {
    return trimmed.slice(0, -1);
  }
  return /[.!?…]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

export function truncateAtWordBoundary(text: string, maxLength = 130): string {
  const cleaned = text.trim();
  if (cleaned.length <= maxLength) {
    return cleaned;
  }
  const slice = cleaned.slice(0, maxLength - 1);
  const lastSpace = slice.lastIndexOf(' ');
  const boundary = lastSpace > Math.floor(maxLength * 0.55) ? slice.slice(0, lastSpace) : slice;
  const stripped = boundary.replace(/[\s,;:\-—–(]+$/u, '').replace(/\.{1,3}$/, '');
  return `${stripped}…`;
}

export function cleanTimeActivityNote(
  note: string,
  sourceEvent?: ArchiveEvent | null,
  maxLength = 130
): string {
  const trimmed = note.trim();
  if (!trimmed) {
    return '';
  }

  // Re-derive cleanly at a word boundary when upstream clipped a long event summary mid-word.
  if (trimmed.endsWith('…') && sourceEvent?.summary) {
    const rawSummary = sourceEvent.summary.trim();
    const firstSentence = rawSummary.split(/(?<=[.!?])\s+/)[0] || rawSummary;
    if (firstSentence.length > maxLength && firstSentence.startsWith(trimmed.slice(0, 24))) {
      return truncateAtWordBoundary(firstSentence, maxLength);
    }
  }

  // Normalize accidental double periods (e.g. "Washington, D.C..") and punctuation-before-ellipsis.
  const withoutDoublePeriods = trimmed
    .replaceAll(/([A-Za-z]\.)\.(?=\s|$)/g, '$1')
    .replace(/([^.])\.\.$/, '$1.');
  const cleanEllipsis = withoutDoublePeriods.replace(/[\s,;:\-—–(]+…$/u, '…').replace(/\.{2,}…$/, '…');
  return cleanEllipsis.length > maxLength ? truncateAtWordBoundary(cleanEllipsis, maxLength) : cleanEllipsis;
}

export function computeArchiveYearDensity(
  bundle: ArchiveBundle,
  minYear = TIME_MIN_YEAR,
  maxYear = TIME_MAX_YEAR
): readonly ArchiveYearDensityPoint[] {
  const start = Math.min(minYear, maxYear);
  const end = Math.max(minYear, maxYear);

  const eventYearsByPerson = new Map<string, number[]>();
  const eventsByYear = new Map<number, number>();

  for (const ev of bundle.events) {
    if (ev.year === null || (ev.scope !== 'personal' && ev.scope !== 'family')) {
      continue;
    }
    if (ev.year >= start && ev.year <= end) {
      eventsByYear.set(ev.year, (eventsByYear.get(ev.year) ?? 0) + 1);
    }
    for (const pt of ev.participants) {
      const list = eventYearsByPerson.get(pt.person_id);
      if (list) {
        list.push(ev.year);
      } else {
        eventYearsByPerson.set(pt.person_id, [ev.year]);
      }
    }
  }

  const eligiblePeople = bundle.people.filter((p) => !(p.is_living && p.full_name === 'Living'));
  const points: ArchiveYearDensityPoint[] = [];

  for (let year = start; year <= end; year += 1) {
    let aliveCount = 0;
    for (const person of eligiblePeople) {
      if (isPersonAliveInYear(person, year, eventYearsByPerson.get(person.id))) {
        aliveCount += 1;
      }
    }
    points.push({
      year,
      aliveCount,
      eventCount: eventsByYear.get(year) ?? 0,
    });
  }

  return points;
}

export function buildRidgelineGeometry(
  density: readonly ArchiveYearDensityPoint[],
  activeYear: number,
  width = 400,
  height = 28
): RidgelineGeometry {
  if (density.length < 2) {
    return { areaPath: '', linePath: '', activeX: 0, hasData: false };
  }

  const minYear = density[0]?.year ?? 0;
  const maxYear = density.at(-1)?.year ?? minYear + 1;
  const span = Math.max(1, maxYear - minYear);
  const clampedActive = Math.max(minYear, Math.min(maxYear, activeYear));
  const activeX = Number((((clampedActive - minYear) / span) * width).toFixed(2));

  let maxWeight = 0;
  const weights = density.map((pt) => {
    const w = pt.aliveCount + pt.eventCount * 0.5;
    if (w > maxWeight) {
      maxWeight = w;
    }
    return w;
  });

  if (maxWeight <= 0) {
    return { areaPath: '', linePath: '', activeX, hasData: false };
  }

  // Downsample to at most 80 evenly spaced buckets for a crisp, lightweight SVG path.
  const bucketCount = Math.min(80, density.length);
  const coords: { readonly x: number; readonly y: number }[] = [];
  const topPad = 3;
  const baseline = height - 1;
  const usableH = baseline - topPad;

  for (let i = 0; i < bucketCount; i += 1) {
    const startIdx = Math.floor((i * density.length) / bucketCount);
    const endIdx = Math.max(startIdx + 1, Math.floor(((i + 1) * density.length) / bucketCount));
    let peak = 0;
    for (let j = startIdx; j < endIdx && j < weights.length; j += 1) {
      const w = weights[j] ?? 0;
      if (w > peak) {
        peak = w;
      }
    }
    const x = bucketCount === 1 ? 0 : (i / (bucketCount - 1)) * width;
    const y = baseline - (peak / maxWeight) * usableH;
    coords.push({ x: Number(x.toFixed(2)), y: Number(y.toFixed(2)) });
  }

  const lineParts = coords.map((pt, idx) => `${idx === 0 ? 'M' : 'L'}${pt.x},${pt.y}`);
  const linePath = lineParts.join(' ');
  const areaPath = `${linePath} L${width},${baseline} L0,${baseline} Z`;

  return { areaPath, linePath, activeX, hasData: true };
}
