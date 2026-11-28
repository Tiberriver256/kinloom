import type { KinshipEdge, Person } from '@kinloom/core';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  ARCHIVAL_NODE_W,
  buildArchivalTreeModel,
  computeArchivalDiagramLayout,
  type DiagramPoint,
  resolveInitialTreePreferences,
  resolveSemanticZoomLevel,
  searchTreePeople,
} from './archivalTreeModel.js';

const FIXED_SEED = 20261127;

function makeSyntheticPerson(idx: number, overrides: Partial<Person> = {}): Person {
  const surnames = ['Alder', 'Mercer', 'Bramwell', 'Vance', 'Hale'] as const;
  const given = `Ancestor${idx}`;
  const surname = surnames[idx % surnames.length] ?? 'Stout';
  const birthYear = 1780 + idx * 6;
  return {
    id: `per_ui_${idx}`,
    slug: `ancestor-${idx}-${surname.toLowerCase()}`,
    full_name: `${given} ${surname}`,
    given_name: given,
    surname,
    alt_names: [],
    sex: idx % 2 === 0 ? 'M' : 'F',
    is_living: false,
    lineage_group: idx === 0 ? 'pivot_ancestor' : idx % 3 === 0 ? 'collateral' : 'ancestor',
    branch: 'alder_main',
    birth_edtf: String(birthYear),
    death_edtf: String(birthYear + 68),
    birth_year: birthYear,
    death_year: birthYear + 68,
    portrait_url: null,
    event_count: 1,
    primary_place_id: null,
    ...overrides,
  };
}

const dagFamilyArb = fc.integer({ min: 2, max: 14 }).chain((count) =>
  fc.record({
    count: fc.constant(count),
    redactedCount: fc.integer({ min: 0, max: 3 }),
    parentPairs: fc.array(
      fc
        .tuple(
          fc.integer({ min: 0, max: Math.max(0, count - 2) }),
          fc.integer({ min: 1, max: Math.max(1, count - 1) })
        )
        .filter(([p, c]) => p < c),
      { minLength: 1, maxLength: count * 2 }
    ),
    spousePairs: fc.array(
      fc
        .tuple(
          fc.integer({ min: 0, max: Math.max(0, count - 2) }),
          fc.integer({ min: 1, max: Math.max(1, count - 1) })
        )
        .filter(([a, b]) => a < b),
      { minLength: 0, maxLength: Math.floor(count / 2) }
    ),
  })
);

describe('UI archival tree model & diagram layout property invariants', () => {
  it('excludes redacted Living placeholders, produces finite non-overlapping coordinates, and stays deterministic across input order', () => {
    fc.assert(
      fc.property(dagFamilyArb, ({ count, redactedCount, parentPairs, spousePairs }) => {
        const historicalPeople = Array.from({ length: count }, (_, idx) => makeSyntheticPerson(idx));
        const redactedPeople = Array.from({ length: redactedCount }, (_, idx) =>
          makeSyntheticPerson(count + idx, {
            id: `per_redacted_${idx}`,
            slug: `living-${idx}`,
            full_name: 'Living',
            given_name: 'Living',
            surname: '',
            is_living: true,
            death_edtf: '',
            death_year: null,
            birth_edtf: '',
            birth_year: null,
          })
        );
        const peopleList = [...historicalPeople, ...redactedPeople];

        const edgesList: KinshipEdge[] = [];
        const seen = new Set<string>();
        const parentsPerChild = new Map<number, number>();

        for (const [pIdx, cIdx] of parentPairs) {
          if ((parentsPerChild.get(cIdx) ?? 0) >= 2) continue;
          const key = `parent:${pIdx}:${cIdx}`;
          if (seen.has(key)) continue;
          seen.add(key);
          parentsPerChild.set(cIdx, (parentsPerChild.get(cIdx) ?? 0) + 1);
          edgesList.push({ from: `per_ui_${pIdx}`, to: `per_ui_${cIdx}`, relation: 'parent' });
        }
        for (let r = 0; r < redactedCount; r += 1) {
          edgesList.push({ from: 'per_ui_0', to: `per_redacted_${r}`, relation: 'parent' });
        }

        const married = new Set<number>();
        for (const [a, b] of spousePairs) {
          if (married.has(a) || married.has(b) || seen.has(`parent:${a}:${b}`)) continue;
          married.add(a);
          married.add(b);
          edgesList.push({ from: `per_ui_${a}`, to: `per_ui_${b}`, relation: 'spouse' });
          edgesList.push({ from: `per_ui_${b}`, to: `per_ui_${a}`, relation: 'spouse' });
        }

        const model = buildArchivalTreeModel({
          people: peopleList,
          kinship: edgesList,
          mode: 'full',
        });

        // 1. Redacted 'Living' placeholders never enter the interactive model or search index
        for (let r = 0; r < redactedCount; r += 1) {
          expect(model.peopleById.has(`per_redacted_${r}`)).toBe(false);
        }
        expect(
          searchTreePeople({
            query: 'Living',
            people: peopleList,
            buildMode: 'private',
            model,
            branchFilter: 'all',
            defaultBranchId: 'alder_main',
            branchLabelsById: new Map([['alder_main', 'Alder']]),
          }).every((hit) => !hit.person.id.startsWith('per_redacted_'))
        ).toBe(true);

        // 2. Diagram layout produces finite bounds, zero box overlaps (cards + strips + toggles),
        //    zero orthogonal edge-through-card intersections, and >= 14px horizontal bus lane spacing
        const diagram = computeArchivalDiagramLayout(model);
        expect(Number.isFinite(diagram.bounds.minX)).toBe(true);
        expect(Number.isFinite(diagram.bounds.maxX)).toBe(true);
        expect(Number.isFinite(diagram.bounds.minY)).toBe(true);
        expect(Number.isFinite(diagram.bounds.maxY)).toBe(true);

        const allBoxes = [
          ...diagram.nodes.map((n) => ({
            id: n.person.id,
            kind: 'node' as const,
            left: n.x,
            right: n.x + n.width,
            top: n.y,
            bottom: n.y + n.height,
          })),
          ...diagram.earlyLossStrips.map((s) => ({
            id: `strip:${s.unionId}`,
            kind: 'strip' as const,
            left: s.x,
            right: s.x + s.width,
            top: s.y,
            bottom: s.y + s.height,
          })),
          ...diagram.siblingToggles.map((t) => ({
            id: `toggle:${t.unionId}`,
            kind: 'toggle' as const,
            left: t.x,
            right: t.x + t.width,
            top: t.y,
            bottom: t.y + t.height,
          })),
        ];
        for (let i = 0; i < allBoxes.length; i += 1) {
          for (let j = i + 1; j < allBoxes.length; j += 1) {
            const a = allBoxes[i];
            const b = allBoxes[j];
            if (!a || !b) continue;
            const overlaps = a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
            expect(overlaps).toBe(false);
          }
        }

        const polylineHitsRect = (
          pts: readonly DiagramPoint[],
          rect: { left: number; right: number; top: number; bottom: number }
        ): boolean => {
          for (let i = 0; i < pts.length - 1; i += 1) {
            const a = pts[i];
            const b = pts[i + 1];
            if (!a || !b) continue;
            if (a.x === b.x) {
              const minY = Math.min(a.y, b.y);
              const maxY = Math.max(a.y, b.y);
              if (a.x > rect.left && a.x < rect.right && maxY > rect.top && minY < rect.bottom) {
                return true;
              }
            } else if (a.y === b.y) {
              const minX = Math.min(a.x, b.x);
              const maxX = Math.max(a.x, b.x);
              if (a.y > rect.top && a.y < rect.bottom && maxX > rect.left && minX < rect.right) {
                return true;
              }
            }
          }
          return false;
        };

        const nodeBoxes = allBoxes.filter((b) => b.kind === 'node');
        const busYsByGen = new Map<number, number[]>();
        for (const bus of diagram.buses) {
          const union = model.unionsById.get(bus.unionId);
          if (union) {
            const list = busYsByGen.get(union.gen) ?? [];
            list.push(bus.busY);
            busYsByGen.set(union.gen, list);
          }
          const parentSet = new Set(bus.parentIds);
          for (const rect of nodeBoxes) {
            if (!parentSet.has(rect.id)) {
              expect(polylineHitsRect(bus.stemPoints, rect)).toBe(false);
            }
          }
          for (const drop of bus.childDrops) {
            for (const rect of nodeBoxes) {
              if (rect.id !== drop.childId) {
                expect(polylineHitsRect(drop.points, rect)).toBe(false);
              }
            }
          }
        }
        for (const ys of busYsByGen.values()) {
          const sorted = [...ys].sort((a, b) => a - b);
          for (let i = 1; i < sorted.length; i += 1) {
            expect((sorted[i] ?? 0) - (sorted[i - 1] ?? 0)).toBeGreaterThanOrEqual(14);
          }
        }

        const rowXs = new Map<string, number[]>();
        for (const node of diagram.nodes) {
          expect(Number.isFinite(node.x)).toBe(true);
          expect(Number.isFinite(node.y)).toBe(true);
          expect(node.width).toBe(ARCHIVAL_NODE_W);
          expect(node.x).toBeGreaterThanOrEqual(diagram.bounds.minX - 0.5);
          expect(node.x + node.width).toBeLessThanOrEqual(diagram.bounds.maxX + 0.5);
          if (node.placement !== 'rank') continue;
          const rowKey = `${node.gen}:${Math.round(node.y)}`;
          const xs = rowXs.get(rowKey) ?? [];
          xs.push(node.x);
          rowXs.set(rowKey, xs);
        }

        for (const xs of rowXs.values()) {
          xs.sort((a, b) => a - b);
          for (let i = 1; i < xs.length; i += 1) {
            expect((xs[i] ?? 0) - (xs[i - 1] ?? 0)).toBeGreaterThanOrEqual(ARCHIVAL_NODE_W - 0.5);
          }
        }

        // 3. Reversing input arrays preserves the exact visible person set
        const reversedModel = buildArchivalTreeModel({
          people: [...peopleList].reverse(),
          kinship: [...edgesList].reverse(),
          mode: 'full',
        });
        expect([...reversedModel.peopleById.keys()].toSorted()).toEqual(
          [...model.peopleById.keys()].toSorted()
        );
      }),
      { seed: FIXED_SEED, numRuns: 60 }
    );
  });

  it('maintains monotonic semantic zoom thresholds and responsive surface preferences across viewport widths', () => {
    const rank: Record<ReturnType<typeof resolveSemanticZoomLevel>, number> = {
      overview: 0,
      compact: 1,
      detail: 2,
    };
    fc.assert(
      fc.property(
        fc.double({ min: 0.1, max: 2.5, noNaN: true }),
        fc.double({ min: 0.1, max: 2.5, noNaN: true }),
        fc.integer({ min: 280, max: 2560 }),
        (z1, z2, viewportW) => {
          const [lo, hi] = z1 <= z2 ? [z1, z2] : [z2, z1];
          expect(rank[resolveSemanticZoomLevel(lo)]).toBeLessThanOrEqual(rank[resolveSemanticZoomLevel(hi)]);
          const prefs = resolveInitialTreePreferences(viewportW);
          expect(['roll', 'diagram']).toContain(prefs.surface);
          expect(['spine', 'full']).toContain(prefs.mode);
        }
      ),
      { seed: FIXED_SEED + 1, numRuns: 100 }
    );
  });
});
