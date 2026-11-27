import type { KinshipEdge, Person } from '../schemas/entities.js';

export interface PlacedNode {
  person: Person;
  x: number;
  y: number;
  gen: number;
  isDirect: boolean;
}

export interface CoupleLink {
  a: PlacedNode;
  b: PlacedNode;
  midX: number;
  midY: number;
}

export interface ChildEdge {
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  parentIds: string[];
  childId: string;
  isDirect: boolean;
}

export interface GenBand {
  gen: number;
  y: number;
  yearRange: string;
}

export interface TreeBounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

export interface TreeLayout {
  nodes: PlacedNode[];
  byId: Map<string, PlacedNode>;
  couples: CoupleLink[];
  edges: ChildEdge[];
  genBands: GenBand[];
  bounds: TreeBounds;
  parentMap: Map<string, string[]>;
  childMap: Map<string, string[]>;
}

export interface TreeLayoutInput {
  people: readonly Person[];
  kinship: readonly KinshipEdge[];
  branchFilter?: string | null;
  defaultBranchId?: string;
  directModeBranchIds?: readonly string[];
  mode: 'direct' | 'full';
}

interface Unit {
  id: string;
  members: Person[];
  gen: number;
  bary: number;
  width: number;
  x: number;
}

export const TREE_NODE_W = 166;
export const TREE_NODE_H = 48;
const SPOUSE_GAP = 16;
const UNIT_GAP = 28;
const GEN_ROW_H = 124;

function isDirectPerson(p: Person): boolean {
  return (
    p.lineage_group === 'ancestor' || p.lineage_group === 'pivot_ancestor' || p.lineage_group === 'descendant'
  );
}

function memberUnitIndices(
  members: readonly Person[],
  idMap: ReadonlyMap<string, string[]>,
  personToUnit: ReadonlyMap<string, Unit>,
  unitIndexInGen: ReadonlyMap<string, number>
): number[] {
  const indices: number[] = [];
  for (const m of members) {
    for (const id of idMap.get(m.id) ?? []) {
      const u = personToUnit.get(id);
      if (u) {
        indices.push(unitIndexInGen.get(u.id) ?? 0);
      }
    }
  }
  return indices;
}

export function emptyTreeLayout(): TreeLayout {
  return {
    nodes: [],
    byId: new Map<string, PlacedNode>(),
    couples: [],
    edges: [],
    genBands: [],
    bounds: { minX: 0, maxX: 1200, minY: 0, maxY: 800 },
    parentMap: new Map<string, string[]>(),
    childMap: new Map<string, string[]>(),
  };
}

export function computeTreeLayout({
  people,
  kinship,
  branchFilter,
  defaultBranchId = 'primary',
  directModeBranchIds,
  mode,
}: TreeLayoutInput): TreeLayout {
  const visibleAll = people.filter((p) => {
    if (p.is_living && p.full_name === 'Living') {
      return false;
    }
    if (!branchFilter || branchFilter === 'all') {
      return true;
    }
    return (p.branch || defaultBranchId) === branchFilter;
  });

  const appliesDirectFilter =
    mode === 'direct' &&
    (!directModeBranchIds || !branchFilter || directModeBranchIds.includes(branchFilter));

  const visiblePeople = appliesDirectFilter
    ? visibleAll.filter((p) => isDirectPerson(p) || p.lineage_group === 'descendant_spouse')
    : visibleAll;
  const visIds = new Set(visiblePeople.map((p) => p.id));
  const personMap = new Map(visiblePeople.map((p) => [p.id, p]));

  const parentMap = new Map<string, string[]>();
  const childMap = new Map<string, string[]>();
  const spouseMap = new Map<string, string[]>();

  for (const k of kinship) {
    if (!visIds.has(k.from) || !visIds.has(k.to)) {
      continue;
    }
    if (k.relation === 'parent') {
      const ch = childMap.get(k.from) ?? [];
      if (!ch.includes(k.to)) {
        ch.push(k.to);
      }
      childMap.set(k.from, ch);

      const pa = parentMap.get(k.to) ?? [];
      if (!pa.includes(k.from)) {
        pa.push(k.from);
      }
      parentMap.set(k.to, pa);
    } else if (k.relation === 'spouse') {
      const sp = spouseMap.get(k.from) ?? [];
      if (!sp.includes(k.to)) {
        sp.push(k.to);
      }
      spouseMap.set(k.from, sp);
    }
  }

  // 1. Sugiyama Layer Assignment
  const gen = new Map<string, number>();
  const roots = visiblePeople.filter((p) => (parentMap.get(p.id)?.length ?? 0) === 0);
  for (const r of roots) {
    gen.set(r.id, 0);
  }

  for (let iter = 0; iter < 24; iter += 1) {
    let changed = false;
    for (const p of visiblePeople) {
      const ps = parentMap.get(p.id) ?? [];
      if (ps.length > 0) {
        const maxP = Math.max(...ps.map((id) => gen.get(id) ?? 0));
        const target = maxP + 1;
        if ((gen.get(p.id) ?? -1) < target) {
          gen.set(p.id, target);
          changed = true;
        }
      }
    }
    for (const p of visiblePeople) {
      const sps = spouseMap.get(p.id) ?? [];
      for (const spId of sps) {
        const gA = gen.get(p.id) ?? 0;
        const gB = gen.get(spId) ?? 0;
        if (gA !== gB) {
          const m = Math.max(gA, gB);
          gen.set(p.id, m);
          gen.set(spId, m);
          changed = true;
        }
      }
    }
    if (!changed) {
      break;
    }
  }

  for (let iter = 0; iter < 6; iter += 1) {
    for (const p of visiblePeople) {
      const ch = childMap.get(p.id) ?? [];
      if (ch.length > 0 && (parentMap.get(p.id)?.length ?? 0) === 0) {
        const minChildGen = Math.min(...ch.map((cid) => gen.get(cid) ?? 1));
        const target = Math.max(0, minChildGen - 1);
        if ((gen.get(p.id) ?? 0) < target) {
          gen.set(p.id, target);
        }
      }
    }
  }

  const fullParentMap = new Map<string, string[]>();
  const fullSpouseMap = new Map<string, string[]>();
  for (const k of kinship) {
    if (k.relation === 'parent') {
      const pa = fullParentMap.get(k.to) ?? [];
      if (!pa.includes(k.from)) {
        pa.push(k.from);
      }
      fullParentMap.set(k.to, pa);
    } else if (k.relation === 'spouse') {
      const sp = fullSpouseMap.get(k.from) ?? [];
      if (!sp.includes(k.to)) {
        sp.push(k.to);
      }
      fullSpouseMap.set(k.from, sp);
    }
  }

  const connectedGenYears = new Map<number, number[]>();
  for (const p of visiblePeople) {
    const hasVisibleEdge =
      (parentMap.get(p.id)?.length ?? 0) > 0 ||
      (childMap.get(p.id)?.length ?? 0) > 0 ||
      (spouseMap.get(p.id)?.length ?? 0) > 0;
    if (hasVisibleEdge && p.birth_year !== null) {
      const g = gen.get(p.id) ?? 0;
      const arr = connectedGenYears.get(g) ?? [];
      arr.push(p.birth_year);
      connectedGenYears.set(g, arr);
    }
  }

  for (const p of visiblePeople) {
    const hasVisibleEdge =
      (parentMap.get(p.id)?.length ?? 0) > 0 ||
      (childMap.get(p.id)?.length ?? 0) > 0 ||
      (spouseMap.get(p.id)?.length ?? 0) > 0;
    if (hasVisibleEdge) {
      continue;
    }

    let inferredGen: number | null = null;
    for (const hiddenSpId of fullSpouseMap.get(p.id) ?? []) {
      const spParents = (fullParentMap.get(hiddenSpId) ?? []).filter((pid) => visIds.has(pid));
      if (spParents.length > 0) {
        inferredGen = Math.max(...spParents.map((pid) => gen.get(pid) ?? 0)) + 1;
        break;
      }
    }
    if (inferredGen === null && p.birth_year !== null && connectedGenYears.size > 0) {
      let bestG = 0;
      let bestDiff = Infinity;
      for (const [g, yrs] of connectedGenYears.entries()) {
        const sorted = [...yrs].toSorted((a, b) => a - b);
        const med = sorted[Math.floor(sorted.length / 2)];
        const diff = Math.abs(p.birth_year - med);
        if (diff < bestDiff) {
          bestDiff = diff;
          bestG = g;
        }
      }
      inferredGen = bestG;
    }
    if (inferredGen !== null) {
      gen.set(p.id, inferredGen);
    }
  }

  // 2. Group Spouses into Couple Units within each Generation
  const byGen = new Map<number, Person[]>();
  for (const p of visiblePeople) {
    const g = gen.get(p.id) ?? 0;
    const arr = byGen.get(g) ?? [];
    arr.push(p);
    byGen.set(g, arr);
  }

  const genNums = [...byGen.keys()].toSorted((a, b) => a - b);
  const unitsByGen = new Map<number, Unit[]>();
  const personToUnit = new Map<string, Unit>();

  for (const g of genNums) {
    const members = (byGen.get(g) ?? []).toSorted((a, b) => {
      const da = isDirectPerson(a) ? 0 : 1;
      const db = isDirectPerson(b) ? 0 : 1;
      if (da !== db) {
        return da - db;
      }
      return (a.birth_year ?? 1800) - (b.birth_year ?? 1800);
    });
    const used = new Set<string>();
    const units: Unit[] = [];

    for (const p of members) {
      if (used.has(p.id)) {
        continue;
      }
      used.add(p.id);
      const sps = (spouseMap.get(p.id) ?? []).filter((sid) => !used.has(sid) && (gen.get(sid) ?? 0) === g);
      const unitMembers: Person[] = [p];
      if (sps.length > 0) {
        const sp = personMap.get(sps[0]);
        if (sp) {
          used.add(sp.id);
          unitMembers.push(sp);
        }
      }
      const width = unitMembers.length === 2 ? TREE_NODE_W * 2 + SPOUSE_GAP : TREE_NODE_W;
      const unit: Unit = {
        id: unitMembers.map((m) => m.id).join('+'),
        members: unitMembers,
        gen: g,
        bary: units.length,
        width,
        x: 0,
      };
      units.push(unit);
      for (const m of unitMembers) {
        personToUnit.set(m.id, unit);
      }
    }
    unitsByGen.set(g, units);
  }

  // 3. Barycenter Crossing Minimization
  const unitIndexInGen = new Map<string, number>();
  const refreshGenIndices = (g: number): void => {
    for (const [idx, u] of (unitsByGen.get(g) ?? []).entries()) {
      unitIndexInGen.set(u.id, idx);
    }
  };
  for (const g of genNums) {
    refreshGenIndices(g);
  }

  for (let sweep = 0; sweep < 4; sweep += 1) {
    for (let i = 1; i < genNums.length; i += 1) {
      const g = genNums[i];
      const units = unitsByGen.get(g) ?? [];
      for (const u of units) {
        const pIndices = memberUnitIndices(u.members, parentMap, personToUnit, unitIndexInGen);
        u.bary =
          pIndices.length > 0
            ? pIndices.reduce((a, b) => a + b, 0) / pIndices.length
            : (unitIndexInGen.get(u.id) ?? 0);
      }
      units.sort((a, b) => a.bary - b.bary);
      refreshGenIndices(g);
    }
    for (let i = genNums.length - 2; i >= 0; i -= 1) {
      const g = genNums[i];
      const units = unitsByGen.get(g) ?? [];
      for (const u of units) {
        const cIndices = memberUnitIndices(u.members, childMap, personToUnit, unitIndexInGen);
        u.bary =
          cIndices.length > 0
            ? cIndices.reduce((a, b) => a + b, 0) / cIndices.length
            : (unitIndexInGen.get(u.id) ?? 0);
      }
      units.sort((a, b) => a.bary - b.bary);
      refreshGenIndices(g);
    }
  }

  // 4. Coordinate Assignment
  const nodes: PlacedNode[] = [];
  const byId = new Map<string, PlacedNode>();
  const couples: CoupleLink[] = [];
  const genBands: GenBand[] = [];

  let maxRowWidth = 0;
  const rowWidths = new Map<number, number>();
  for (const g of genNums) {
    const units = unitsByGen.get(g) ?? [];
    const w = units.reduce((acc, u) => acc + u.width, 0) + Math.max(0, units.length - 1) * UNIT_GAP;
    rowWidths.set(g, w);
    if (w > maxRowWidth) {
      maxRowWidth = w;
    }
  }

  const leftPad = 140;
  const topPad = 48;

  for (const g of genNums) {
    const units = unitsByGen.get(g) ?? [];
    const rowW = rowWidths.get(g) ?? 0;
    let cursorX = leftPad + (maxRowWidth - rowW) / 2;
    const y = topPad + g * GEN_ROW_H;

    const yrs: number[] = [];
    for (const u of units) {
      u.x = cursorX;
      const placedMembers: PlacedNode[] = [];
      for (const [idx, m] of u.members.entries()) {
        const nx = cursorX + idx * (TREE_NODE_W + SPOUSE_GAP);
        const pn: PlacedNode = {
          person: m,
          x: nx,
          y,
          gen: g,
          isDirect: isDirectPerson(m),
        };
        nodes.push(pn);
        byId.set(m.id, pn);
        placedMembers.push(pn);
        if (m.birth_year) {
          yrs.push(m.birth_year);
        }
      }
      if (placedMembers.length === 2) {
        couples.push({
          a: placedMembers[0],
          b: placedMembers[1],
          midX: placedMembers[0].x + TREE_NODE_W + SPOUSE_GAP / 2,
          midY: y + TREE_NODE_H / 2,
        });
      }
      cursorX += u.width + UNIT_GAP;
    }

    const yearRange = yrs.length > 0 ? `${Math.min(...yrs)}–${Math.max(...yrs)}` : `Gen ${g + 1}`;
    genBands.push({ gen: g, y, yearRange });
  }

  // 5. Couple-to-child edges
  const coupleMidByPair = new Map<string, { x: number; y: number }>();
  for (const c of couples) {
    const key = [c.a.person.id, c.b.person.id].toSorted().join(':');
    coupleMidByPair.set(key, { x: c.midX, y: c.a.y + TREE_NODE_H });
  }

  const edges: ChildEdge[] = [];
  for (const node of nodes) {
    const pids = parentMap.get(node.person.id) ?? [];
    if (pids.length === 0) {
      continue;
    }

    const toX = node.x + TREE_NODE_W / 2;
    const toY = node.y;

    if (pids.length >= 2) {
      const pairKey = [pids[0], pids[1]].toSorted().join(':');
      const cm = coupleMidByPair.get(pairKey);
      if (cm) {
        edges.push({
          fromX: cm.x,
          fromY: cm.y,
          toX,
          toY,
          parentIds: pids,
          childId: node.person.id,
          isDirect: node.isDirect,
        });
        continue;
      }
      for (const pid of pids) {
        const p = byId.get(pid);
        if (!p) {
          continue;
        }
        edges.push({
          fromX: p.x + TREE_NODE_W / 2,
          fromY: p.y + TREE_NODE_H,
          toX,
          toY,
          parentIds: [pid],
          childId: node.person.id,
          isDirect: node.isDirect,
        });
      }
      continue;
    }

    const p0 = byId.get(pids[0]);
    if (!p0) {
      continue;
    }
    edges.push({
      fromX: p0.x + TREE_NODE_W / 2,
      fromY: p0.y + TREE_NODE_H,
      toX,
      toY,
      parentIds: pids,
      childId: node.person.id,
      isDirect: node.isDirect,
    });
  }

  return {
    nodes,
    byId,
    couples,
    edges,
    genBands,
    bounds: {
      minX: 0,
      maxX: leftPad * 2 + maxRowWidth,
      minY: 0,
      maxY: topPad * 2 + Math.max(1, genNums.length) * GEN_ROW_H,
    },
    parentMap,
    childMap,
  };
}
