import type { Person } from '@kinloom/core';
import { fastLocaleCompare } from '@kinloom/core';
import { computeLineageSpotlight } from './treeProjections.js';
import type { ArchivalTreeModel } from './types.js';

export const KINSHIP_LOOM_ZOOM_THRESHOLD = 45;

export interface KinshipLoomNode {
  readonly person: Person;
  readonly x: number;
  readonly y: number;
  readonly effectiveYear: number;
  readonly isEstimatedYear: boolean;
  readonly branchKey: string;
  readonly generation: number;
  readonly isAnchor: boolean;
}

export interface KinshipLoomThread {
  readonly id: string;
  readonly kind: 'lineage' | 'union';
  readonly fromPersonId: string;
  readonly toPersonId: string;
  readonly path: string;
  readonly isCrossBranch: boolean;
}

export interface KinshipLoomDecadeTick {
  readonly year: number;
  readonly y: number;
}

export interface KinshipLoomLayout {
  readonly width: number;
  readonly height: number;
  readonly minYear: number;
  readonly maxYear: number;
  readonly nodes: readonly KinshipLoomNode[];
  readonly threads: readonly KinshipLoomThread[];
  readonly decadeTicks: readonly KinshipLoomDecadeTick[];
  readonly branchOrder: readonly string[];
}

export interface KinshipLoomSpotlight {
  readonly focusPersonId: string;
  readonly highlightedPersonIds: ReadonlySet<string>;
  readonly ancestorCount: number;
  readonly descendantCount: number;
}

export interface KinshipLoomLabelPlacement {
  readonly personId: string;
  readonly x: number;
  readonly y: number;
  readonly textAnchor: 'start' | 'end';
  readonly width: number;
  readonly height: number;
  readonly boxX: number;
  readonly boxY: number;
  readonly hasLeader: boolean;
}

interface LabelBox {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
}

const LABEL_HEIGHT = 16;
const LABEL_PAD_X = 6;
const LABEL_GAP_X = 10;
const LABEL_MIN_LEFT_X = 68;
const LABEL_VERTICAL_STEP = 17;
const LABEL_CHAR_WIDTH = 6.6;

function estimateLabelWidth(name: string): number {
  return Math.round(Math.max(44, Math.min(200, name.length * LABEL_CHAR_WIDTH + LABEL_PAD_X * 2)));
}

function boxesOverlap(a: LabelBox, b: LabelBox): boolean {
  return a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;
}

/**
 * Computes collision-free SVG label coordinates for visible Kinship Loom nodes.
 * Tries right/left sides first, then staggers vertically so closely spaced
 * relatives never collide into an unreadable tangle.
 */
export function computeKinshipLoomLabelPlacements(params: {
  readonly nodes: readonly KinshipLoomNode[];
  readonly visiblePersonIds: ReadonlySet<string>;
  readonly width: number;
  readonly height: number;
  readonly priorityPersonId?: string | null;
}): ReadonlyMap<string, KinshipLoomLabelPlacement> {
  const { nodes, visiblePersonIds, width, height, priorityPersonId = null } = params;
  const result = new Map<string, KinshipLoomLabelPlacement>();
  if (visiblePersonIds.size === 0 || nodes.length === 0) {
    return result;
  }

  const visibleNodes = nodes
    .filter((n) => visiblePersonIds.has(n.person.id))
    .toSorted((a, b) => {
      if (a.person.id === priorityPersonId) {
        return -1;
      }
      if (b.person.id === priorityPersonId) {
        return 1;
      }
      return a.y - b.y || a.x - b.x || fastLocaleCompare(a.person.full_name, b.person.full_name);
    });

  const placedBoxes: LabelBox[] = [];
  const minCenterY = 14;
  const maxCenterY = Math.max(minCenterY, height - 12);
  const maxRightX = Math.max(LABEL_MIN_LEFT_X + 60, width - 12);

  // Build candidate vertical offsets: 0, -17, +17, -34, +34, ...
  const dyOffsets: number[] = [0];
  for (let step = 1; step <= 14; step += 1) {
    dyOffsets.push(-step * LABEL_VERTICAL_STEP, step * LABEL_VERTICAL_STEP);
  }

  for (const node of visibleNodes) {
    const labelW = estimateLabelWidth(node.person.full_name);
    const preferLeft = node.x + LABEL_GAP_X + labelW > maxRightX;
    const sides: readonly ('start' | 'end')[] = preferLeft ? ['end', 'start'] : ['start', 'end'];

    let chosen: {
      readonly x: number;
      readonly y: number;
      readonly textAnchor: 'start' | 'end';
      readonly box: LabelBox;
    } | null = null;

    outer: for (const dy of dyOffsets) {
      const candidateY = Math.round(Math.max(minCenterY, Math.min(maxCenterY, node.y + dy)) * 10) / 10;
      for (const side of sides) {
        const anchorX = side === 'start' ? node.x + LABEL_GAP_X : node.x - LABEL_GAP_X;
        const boxX = side === 'start' ? anchorX - LABEL_PAD_X / 2 : anchorX - labelW + LABEL_PAD_X / 2;
        if (side === 'end' && boxX < LABEL_MIN_LEFT_X) {
          continue;
        }
        if (side === 'start' && boxX + labelW > maxRightX) {
          continue;
        }
        const boxY = candidateY - LABEL_HEIGHT / 2;
        const box: LabelBox = {
          x0: boxX,
          y0: boxY,
          x1: boxX + labelW,
          y1: boxY + LABEL_HEIGHT,
        };
        if (!placedBoxes.some((existing) => boxesOverlap(existing, box))) {
          chosen = { x: anchorX, y: candidateY, textAnchor: side, box };
          break outer;
        }
      }
    }

    if (!chosen) {
      // Fallback: place below the lowest overlapping box on the preferred side
      const side: 'start' | 'end' =
        preferLeft && node.x - LABEL_GAP_X - labelW >= LABEL_MIN_LEFT_X ? 'end' : 'start';
      const anchorX = side === 'start' ? node.x + LABEL_GAP_X : node.x - LABEL_GAP_X;
      const boxX = side === 'start' ? anchorX - LABEL_PAD_X / 2 : anchorX - labelW + LABEL_PAD_X / 2;
      let fallbackY = Math.max(minCenterY, Math.min(maxCenterY, node.y));
      for (let attempt = 0; attempt < 24; attempt += 1) {
        const box: LabelBox = {
          x0: boxX,
          y0: fallbackY - LABEL_HEIGHT / 2,
          x1: boxX + labelW,
          y1: fallbackY + LABEL_HEIGHT / 2,
        };
        if (!placedBoxes.some((existing) => boxesOverlap(existing, box))) {
          chosen = { x: anchorX, y: fallbackY, textAnchor: side, box };
          break;
        }
        fallbackY = Math.min(maxCenterY, fallbackY + LABEL_VERTICAL_STEP);
      }
      if (!chosen) {
        const boxY = fallbackY - LABEL_HEIGHT / 2;
        chosen = {
          x: anchorX,
          y: fallbackY,
          textAnchor: side,
          box: { x0: boxX, y0: boxY, x1: boxX + labelW, y1: boxY + LABEL_HEIGHT },
        };
      }
    }

    placedBoxes.push(chosen.box);
    result.set(node.person.id, {
      personId: node.person.id,
      x: chosen.x,
      y: chosen.y,
      textAnchor: chosen.textAnchor,
      width: labelW,
      height: LABEL_HEIGHT,
      boxX: chosen.box.x0,
      boxY: chosen.box.y0,
      hasLeader: Math.abs(chosen.y - node.y) > 4,
    });
  }

  return result;
}

function collectVisiblePeople(model: ArchivalTreeModel): readonly Person[] {
  return model.visiblePeople;
}

function resolveBranchKey(person: Person): string {
  const branch = person.branch?.trim();
  if (branch) {
    return branch;
  }
  const surname = person.surname?.trim();
  return surname || 'Archive';
}

function buildDecadeTicks(
  minYear: number,
  maxYear: number,
  topPad: number,
  usableHeight: number
): KinshipLoomDecadeTick[] {
  const span = Math.max(1, maxYear - minYear);
  const step = span > 260 ? 50 : span > 120 ? 25 : span > 50 ? 20 : 10;
  const firstTick = Math.ceil(minYear / step) * step;
  const ticks: KinshipLoomDecadeTick[] = [];
  for (let year = firstTick; year <= maxYear; year += step) {
    const ratio = (year - minYear) / span;
    ticks.push({
      year,
      y: Math.round((topPad + ratio * usableHeight) * 10) / 10,
    });
  }
  if (ticks.length === 0) {
    ticks.push({ year: minYear, y: topPad });
  }
  return ticks;
}

function buildCubicBezierPath(x1: number, y1: number, x2: number, y2: number): string {
  const dy = y2 - y1;
  const c1y = Math.round((y1 + dy * 0.45) * 10) / 10;
  const c2y = Math.round((y2 - dy * 0.45) * 10) / 10;
  return `M ${x1} ${y1} C ${x1} ${c1y}, ${x2} ${c2y}, ${x2} ${y2}`;
}

function buildUnionArcPath(x1: number, y1: number, x2: number, y2: number): string {
  const midX = Math.round(((x1 + x2) / 2) * 10) / 10;
  const midY = Math.round((Math.min(y1, y2) - Math.min(26, Math.abs(x2 - x1) * 0.14 + 8)) * 10) / 10;
  return `M ${x1} ${y1} Q ${midX} ${midY}, ${x2} ${y2}`;
}

export function computeKinshipLoomLayout(params: {
  readonly model: ArchivalTreeModel;
  readonly width?: number;
  readonly height?: number;
}): KinshipLoomLayout {
  const { model, width = 960, height = 640 } = params;
  const people = collectVisiblePeople(model);

  if (people.length === 0) {
    return {
      width,
      height,
      minYear: 1800,
      maxYear: 1900,
      nodes: [],
      threads: [],
      decadeTicks: [],
      branchOrder: [],
    };
  }

  const knownYears = people
    .map((p) => p.birth_year)
    .filter((y): y is number => typeof y === 'number' && Number.isFinite(y) && y > 0);

  const rawMin = knownYears.length > 0 ? Math.min(...knownYears) : 1800;
  const rawMax = knownYears.length > 0 ? Math.max(...knownYears) : 1950;
  const minYear = rawMin;
  const maxYear = rawMax === rawMin ? rawMin + 40 : rawMax;
  const yearSpan = Math.max(1, maxYear - minYear);

  const genCount = Math.max(1, model.generations.length);
  const genIndexByPerson = model.genByPersonId;

  // Deterministic branch ordering by earliest birth year then name
  const branchEarliest = new Map<string, number>();
  for (const p of people) {
    const bk = resolveBranchKey(p);
    const y = p.birth_year ?? maxYear;
    const prev = branchEarliest.get(bk);
    if (prev === undefined || y < prev) {
      branchEarliest.set(bk, y);
    }
  }
  const branchOrder = [...branchEarliest.keys()].toSorted(
    (a, b) =>
      (branchEarliest.get(a) ?? maxYear) - (branchEarliest.get(b) ?? maxYear) || fastLocaleCompare(a, b)
  );
  const branchIndex = new Map(branchOrder.map((bk, idx) => [bk, idx]));

  const leftPad = 88;
  const rightPad = 48;
  const topPad = 40;
  const bottomPad = 44;
  const usableWidth = Math.max(200, width - leftPad - rightPad);
  const usableHeight = Math.max(200, height - topPad - bottomPad);

  // Group people by branch + approximate vertical bucket to fan out overlapping coordinates cleanly
  const bucketCounts = new Map<string, number>();
  const bucketSeen = new Map<string, number>();

  const preliminary = people
    .map((person) => {
      const gi = genIndexByPerson.get(person.id) ?? 0;
      const isEstimatedYear = !(typeof person.birth_year === 'number' && person.birth_year > 0);
      const effectiveYear = isEstimatedYear
        ? Math.round(minYear + (genCount > 1 ? gi / (genCount - 1) : 0.5) * yearSpan)
        : (person.birth_year as number);
      const branchKey = resolveBranchKey(person);
      const yRatio = Math.max(0, Math.min(1, (effectiveYear - minYear) / yearSpan));
      const y = Math.round((topPad + yRatio * usableHeight) * 10) / 10;
      const bucketKey = `${branchKey}:${Math.round(y / 22)}`;
      bucketCounts.set(bucketKey, (bucketCounts.get(bucketKey) ?? 0) + 1);
      return { person, gi, effectiveYear, isEstimatedYear, branchKey, y, bucketKey };
    })
    .toSorted(
      (a, b) => a.effectiveYear - b.effectiveYear || fastLocaleCompare(a.person.full_name, b.person.full_name)
    );

  const laneCount = Math.max(1, branchOrder.length);
  const laneWidth = usableWidth / laneCount;

  const nodes: KinshipLoomNode[] = preliminary.map((item) => {
    const bIdx = branchIndex.get(item.branchKey) ?? 0;
    const laneCenter = leftPad + (bIdx + 0.5) * laneWidth;
    const totalInBucket = bucketCounts.get(item.bucketKey) ?? 1;
    const slotInBucket = bucketSeen.get(item.bucketKey) ?? 0;
    bucketSeen.set(item.bucketKey, slotInBucket + 1);

    const spreadStep = Math.min(34, (laneWidth * 0.72) / Math.max(1, totalInBucket));
    const offset = totalInBucket > 1 ? (slotInBucket - (totalInBucket - 1) / 2) * spreadStep : 0;
    const x = Math.round(Math.max(leftPad, Math.min(width - rightPad, laneCenter + offset)) * 10) / 10;

    return {
      person: item.person,
      x,
      y: item.y,
      effectiveYear: item.effectiveYear,
      isEstimatedYear: item.isEstimatedYear,
      branchKey: item.branchKey,
      generation: item.gi,
      isAnchor: model.anchorPersonId === item.person.id,
    };
  });

  const nodeById = new Map(nodes.map((n) => [n.person.id, n]));
  const threads: KinshipLoomThread[] = [];
  const seenThreads = new Set<string>();

  for (const union of model.unions) {
    const visiblePartners = union.partnerIds
      .map((pid) => nodeById.get(pid))
      .filter((n): n is KinshipLoomNode => n !== undefined);

    if (visiblePartners.length === 2) {
      const [p1, p2] = visiblePartners;
      if (p1 && p2) {
        const unionKey = `u:${p1.person.id}:${p2.person.id}`;
        if (!seenThreads.has(unionKey)) {
          seenThreads.add(unionKey);
          threads.push({
            id: unionKey,
            kind: 'union',
            fromPersonId: p1.person.id,
            toPersonId: p2.person.id,
            path: buildUnionArcPath(p1.x, p1.y, p2.x, p2.y),
            isCrossBranch: p1.branchKey !== p2.branchKey,
          });
        }
      }
    }

    for (const childId of union.allChildIds) {
      const childNode = nodeById.get(childId);
      if (!childNode) {
        continue;
      }
      for (const parentNode of visiblePartners) {
        const edgeKey = `l:${parentNode.person.id}:${childNode.person.id}`;
        if (seenThreads.has(edgeKey)) {
          continue;
        }
        seenThreads.add(edgeKey);
        threads.push({
          id: edgeKey,
          kind: 'lineage',
          fromPersonId: parentNode.person.id,
          toPersonId: childNode.person.id,
          path: buildCubicBezierPath(parentNode.x, parentNode.y, childNode.x, childNode.y),
          isCrossBranch: parentNode.branchKey !== childNode.branchKey,
        });
      }
    }
  }

  return {
    width,
    height,
    minYear,
    maxYear,
    nodes,
    threads,
    decadeTicks: buildDecadeTicks(minYear, maxYear, topPad, usableHeight),
    branchOrder,
  };
}

export function computeKinshipLoomSpotlight(
  model: ArchivalTreeModel,
  focusPersonId: string | null
): KinshipLoomSpotlight | null {
  if (!focusPersonId) {
    return null;
  }
  const base = computeLineageSpotlight({ selectedPersonId: focusPersonId, model });
  if (!base) {
    return null;
  }
  const highlightedPersonIds = new Set<string>([focusPersonId, ...base.ancestorIds, ...base.descendantIds]);
  return {
    focusPersonId,
    highlightedPersonIds,
    ancestorCount: base.ancestorIds.size,
    descendantCount: base.descendantIds.size,
  };
}
