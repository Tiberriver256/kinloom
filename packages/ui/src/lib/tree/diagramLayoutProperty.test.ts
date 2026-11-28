import type { ArchiveBundle, KinshipEdge, Person, Place } from '@kinloom/core';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  ARCHIVAL_NODE_H,
  ARCHIVAL_NODE_W,
  buildArchivalTreeModel,
  computeArchivalDiagramLayout,
  computeLineageSpotlight,
  type DiagramPlacedNode,
  formatCardLifespan,
  formatEarlyLossAgeLabel,
  formatUnionOtherChildrenLabel,
  resolveTreeFocusPlan,
  searchTreePeople,
  type TreeLineageMode,
  toRomanNumeral,
} from '../archivalTreeModel.js';

const TREE_PROP_SEED = 20261130;

interface SyntheticDagSpec {
  readonly founders: number;
  readonly gen1Couples: number;
  readonly gen2ChildrenPerCouple: readonly number[];
  readonly earlyLossesPerCouple: readonly number[];
  readonly remarryFirstFounder: boolean;
  readonly includeSingleParent: boolean;
  readonly includeDisconnected: boolean;
  readonly includeRedactedLiving: boolean;
  readonly useChildEdgeVariant: boolean;
  readonly mode: TreeLineageMode;
  readonly expandAll: boolean;
}

const dagSpecArb: fc.Arbitrary<SyntheticDagSpec> = fc.record({
  founders: fc.integer({ min: 1, max: 3 }),
  gen1Couples: fc.integer({ min: 1, max: 3 }),
  gen2ChildrenPerCouple: fc.array(fc.integer({ min: 0, max: 6 }), { minLength: 1, maxLength: 3 }),
  earlyLossesPerCouple: fc.array(fc.integer({ min: 0, max: 3 }), { minLength: 1, maxLength: 3 }),
  remarryFirstFounder: fc.boolean(),
  includeSingleParent: fc.boolean(),
  includeDisconnected: fc.boolean(),
  includeRedactedLiving: fc.boolean(),
  useChildEdgeVariant: fc.boolean(),
  mode: fc.constantFrom<TreeLineageMode>('full', 'spine'),
  expandAll: fc.boolean(),
});

function makePerson(
  id: string,
  fullName: string,
  opts: {
    readonly lineageGroup?: Person['lineage_group'];
    readonly branch?: string;
    readonly birthYear?: number | null;
    readonly deathYear?: number | null;
    readonly isLiving?: boolean;
    readonly altNames?: readonly string[];
  } = {}
): Person {
  const parts = fullName.split(' ');
  const birthYear = opts.birthYear === undefined ? 1850 : opts.birthYear;
  const deathYear = opts.deathYear === undefined ? 1920 : opts.deathYear;
  return {
    id,
    slug: id.replaceAll('_', '-'),
    full_name: fullName,
    given_name: parts[0] ?? fullName,
    surname: parts.at(-1) ?? '',
    alt_names: [...(opts.altNames ?? [])],
    sex: 'U',
    is_living: opts.isLiving ?? false,
    lineage_group: opts.lineageGroup ?? 'collateral',
    branch: opts.branch ?? 'alder_line',
    birth_edtf: birthYear !== null ? String(birthYear) : '',
    death_edtf: deathYear !== null ? String(deathYear) : '',
    birth_year: birthYear,
    death_year: deathYear,
    portrait_url: null,
    event_count: 1,
    primary_place_id: 'plc_cedar',
  };
}

function buildSyntheticDag(spec: SyntheticDagSpec): {
  readonly people: Person[];
  readonly kinship: KinshipEdge[];
  readonly placesById: Map<string, Place>;
  readonly bundle: ArchiveBundle;
} {
  const people: Person[] = [];
  const kinship: KinshipEdge[] = [];
  let seq = 0;
  const nextId = (prefix: string): string => {
    seq += 1;
    return `${prefix}_${seq}`;
  };

  // Generation 0 founders
  const founderPairs: { readonly a: string; readonly b: string }[] = [];
  for (let f = 0; f < spec.founders; f += 1) {
    const aId = nextId('g0a');
    const bId = nextId('g0b');
    const baseYear = 1790 + f * 6;
    people.push(
      makePerson(aId, `FounderA${f} Alder`, {
        lineageGroup: f === 0 ? 'pivot_ancestor' : 'ancestor',
        birthYear: baseYear,
        deathYear: baseYear + 70,
      }),
      makePerson(bId, `FounderB${f} Mercer`, {
        lineageGroup: f === 0 ? 'ancestor' : 'descendant_spouse',
        birthYear: baseYear + 3,
        deathYear: baseYear + 72,
      })
    );
    kinship.push({ from: aId, to: bId, relation: 'spouse' });
    founderPairs.push({ a: aId, b: bId });
  }

  // Optional remarriage on first founder
  const firstFounder = founderPairs[0];
  if (spec.remarryFirstFounder && firstFounder) {
    const sp2Id = nextId('g0sp2');
    people.push(
      makePerson(sp2Id, 'SecondSpouse Vance', {
        lineageGroup: 'descendant_spouse',
        birthYear: 1802,
        deathYear: 1875,
      })
    );
    kinship.push({ from: firstFounder.a, to: sp2Id, relation: 'spouse' });
    const halfChildId = nextId('g1half');
    people.push(
      makePerson(halfChildId, 'HalfChild Alder', {
        lineageGroup: 'collateral',
        birthYear: 1832,
        deathYear: 1901,
      })
    );
    kinship.push(
      { from: firstFounder.a, to: halfChildId, relation: 'parent' },
      { from: sp2Id, to: halfChildId, relation: 'parent' }
    );
  }

  // Generation 1 couples
  const g1Couples: { readonly a: string; readonly b: string | null }[] = [];
  for (let c = 0; c < spec.gen1Couples; c += 1) {
    const parentPair = founderPairs[c % founderPairs.length];
    const childId = nextId('g1a');
    const spouseId = nextId('g1b');
    const birthYear = 1825 + c * 5;
    people.push(
      makePerson(childId, `GenOne${c} Alder`, {
        lineageGroup: c === 0 ? 'descendant' : 'collateral',
        birthYear,
        deathYear: birthYear + 68,
        altNames: [`G1Alt${c}`],
      }),
      makePerson(spouseId, `SpouseOne${c} Birch`, {
        lineageGroup: c === 0 ? 'descendant_spouse' : 'collateral',
        birthYear: birthYear + 2,
        deathYear: birthYear + 66,
      })
    );
    if (parentPair) {
      if (spec.useChildEdgeVariant && c === 0) {
        kinship.push(
          { from: childId, to: parentPair.a, relation: 'child' },
          { from: childId, to: parentPair.b, relation: 'child' }
        );
      } else {
        kinship.push(
          { from: parentPair.a, to: childId, relation: 'parent' },
          { from: parentPair.b, to: childId, relation: 'parent' }
        );
      }
    }
    kinship.push({ from: childId, to: spouseId, relation: 'spouse' });
    g1Couples.push({ a: childId, b: spouseId });
  }

  if (spec.includeSingleParent && firstFounder) {
    const soloId = nextId('g1solo');
    people.push(
      makePerson(soloId, 'SoloParent Alder', {
        lineageGroup: 'descendant',
        birthYear: 1838,
        deathYear: 1910,
      })
    );
    kinship.push({ from: firstFounder.a, to: soloId, relation: 'parent' });
    g1Couples.push({ a: soloId, b: null });
  }

  // Generation 2 children + early childhood losses
  for (const [idx, couple] of g1Couples.entries()) {
    const childCount = spec.gen2ChildrenPerCouple[idx % spec.gen2ChildrenPerCouple.length] ?? 1;
    for (let k = 0; k < childCount; k += 1) {
      const cid = nextId('g2c');
      const by = 1855 + idx * 4 + k * 2;
      people.push(
        makePerson(cid, `Child${idx}K${k} Alder`, {
          lineageGroup: idx === 0 && k === 0 ? 'descendant' : 'collateral',
          birthYear: by,
          deathYear: by + 65,
        })
      );
      kinship.push({ from: couple.a, to: cid, relation: 'parent' });
      if (couple.b) {
        kinship.push({ from: couple.b, to: cid, relation: 'parent' });
      }
    }

    const earlyCount = spec.earlyLossesPerCouple[idx % spec.earlyLossesPerCouple.length] ?? 0;
    for (let e = 0; e < earlyCount; e += 1) {
      const eid = nextId('g2e');
      const by = 1858 + idx * 4 + e * 2;
      people.push(
        makePerson(eid, `Infant${idx}E${e} Alder`, {
          lineageGroup: 'collateral',
          birthYear: by,
          deathYear: by + (e % 3),
        })
      );
      kinship.push({ from: couple.a, to: eid, relation: 'parent' });
      if (couple.b) {
        kinship.push({ from: couple.b, to: eid, relation: 'parent' });
      }
    }
  }

  if (spec.includeDisconnected) {
    people.push(
      makePerson(nextId('iso'), 'Isolated Cousin', {
        lineageGroup: 'collateral',
        birthYear: 1856,
        deathYear: 1924,
      }),
      makePerson(nextId('iso_undated'), 'Undated Relative', {
        lineageGroup: 'collateral',
        birthYear: null,
        deathYear: null,
      })
    );
  }

  if (spec.includeRedactedLiving) {
    const livingId = nextId('living');
    people.push(
      makePerson(livingId, 'Living', {
        lineageGroup: 'descendant',
        isLiving: true,
        birthYear: null,
        deathYear: null,
      })
    );
    const parent = g1Couples[0];
    if (parent) {
      kinship.push({ from: parent.a, to: livingId, relation: 'parent' });
    }
  }

  const place: Place = {
    id: 'plc_cedar',
    slug: 'cedar-valley',
    name: 'Cedar Valley',
    full_name: 'Cedar Valley, Ohio, USA',
    place_type: 'town',
    parent_id: null,
    lat: 40.2,
    lng: -83.1,
  };
  const placesById = new Map<string, Place>([[place.id, place]]);
  const bundle: ArchiveBundle = {
    meta: {
      build_mode: 'public',
      generated_at: '2026-11-27T00:00:00.000Z',
      counts: {
        people: people.length,
        living_redacted: spec.includeRedactedLiving ? 1 : 0,
        events: 0,
        residence_spans: 0,
        places: 1,
        sources: 0,
      },
    },
    people,
    events: [],
    residence_spans: [],
    places: [place],
    place_ancestors: {},
    kinship,
    sources: [],
  };

  return { people, kinship, placesById, bundle };
}

function boxesOverlap(a: DiagramPlacedNode, b: DiagramPlacedNode): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

describe('Tree layout property-based invariants (deterministic seed)', () => {
  it('produces deterministic, finite, non-overlapping boxes and valid buses across generated family DAGs', () => {
    fc.assert(
      fc.property(dagSpecArb, (spec) => {
        const { people, kinship } = buildSyntheticDag(spec);

        const baseModel = buildArchivalTreeModel({
          people,
          kinship,
          branchFilter: 'alder_line',
          defaultBranchId: 'alder_line',
          mode: spec.mode,
        });

        const expandedUnionIds = spec.expandAll
          ? new Set(baseModel.unions.map((u) => u.id))
          : new Set<string>();

        const model1 = buildArchivalTreeModel({
          people,
          kinship,
          branchFilter: 'alder_line',
          defaultBranchId: 'alder_line',
          mode: spec.mode,
          expandedUnionIds,
        });
        const layout1 = computeArchivalDiagramLayout(model1);

        const model2 = buildArchivalTreeModel({
          people,
          kinship,
          branchFilter: 'alder_line',
          defaultBranchId: 'alder_line',
          mode: spec.mode,
          expandedUnionIds,
        });
        const layout2 = computeArchivalDiagramLayout(model2);

        // 1. Strict determinism
        expect(layout1.nodes.map((n) => [n.person.id, n.x, n.y, n.placement])).toEqual(
          layout2.nodes.map((n) => [n.person.id, n.x, n.y, n.placement])
        );
        expect(layout1.bounds).toEqual(layout2.bounds);
        expect(layout1.buses).toEqual(layout2.buses);
        expect(layout1.genBands).toEqual(layout2.genBands);

        // 2. Valid finite bounds & positive canvas
        expect(Number.isFinite(layout1.bounds.minX)).toBe(true);
        expect(Number.isFinite(layout1.bounds.maxX)).toBe(true);
        expect(Number.isFinite(layout1.bounds.minY)).toBe(true);
        expect(Number.isFinite(layout1.bounds.maxY)).toBe(true);
        expect(layout1.bounds.maxX).toBeGreaterThan(layout1.bounds.minX);
        expect(layout1.bounds.maxY).toBeGreaterThan(layout1.bounds.minY);

        // 3. Every placed node has valid finite coordinates, lies within bounds, is non-redacted, and maps cleanly in byId
        const seenNodeIds = new Set<string>();
        for (const node of layout1.nodes) {
          expect(Number.isFinite(node.x)).toBe(true);
          expect(Number.isFinite(node.y)).toBe(true);
          expect(node.width).toBe(ARCHIVAL_NODE_W);
          expect(node.height).toBe(ARCHIVAL_NODE_H);
          expect(node.x).toBeGreaterThanOrEqual(layout1.bounds.minX);
          expect(node.x + node.width).toBeLessThanOrEqual(layout1.bounds.maxX);
          expect(node.y).toBeGreaterThanOrEqual(layout1.bounds.minY);
          expect(node.y + node.height).toBeLessThanOrEqual(layout1.bounds.maxY);
          expect(node.person.full_name.trim()).not.toBe('Living');
          expect(seenNodeIds.has(node.person.id)).toBe(false);
          seenNodeIds.add(node.person.id);
          expect(layout1.byId.get(node.person.id)).toBe(node);
        }

        // 4. Pairwise non-overlapping node boxes across every rank and hanging node
        for (let i = 0; i < layout1.nodes.length; i += 1) {
          for (let j = i + 1; j < layout1.nodes.length; j += 1) {
            expect(boxesOverlap(layout1.nodes[i], layout1.nodes[j])).toBe(false);
          }
        }

        // 5. Generation bands are strictly increasing vertically with finite heights
        for (let i = 0; i < layout1.genBands.length; i += 1) {
          const band = layout1.genBands[i];
          expect(Number.isFinite(band.y)).toBe(true);
          expect(Number.isFinite(band.height)).toBe(true);
          expect(band.height).toBeGreaterThanOrEqual(ARCHIVAL_NODE_H);
          if (i > 0) {
            const prev = layout1.genBands[i - 1];
            expect(band.y).toBeGreaterThan(prev.y + prev.height);
          }
        }

        // 6. Hubs, buses, early-loss strips, and hanging rails all have valid finite geometry
        for (const hub of layout1.hubs) {
          expect(Number.isFinite(hub.x)).toBe(true);
          expect(Number.isFinite(hub.y)).toBe(true);
          expect(hub.leftX).toBeLessThanOrEqual(hub.rightX);
        }
        for (const bus of layout1.buses) {
          expect(Number.isFinite(bus.hubX)).toBe(true);
          expect(Number.isFinite(bus.hubY)).toBe(true);
          expect(Number.isFinite(bus.busY)).toBe(true);
          expect(bus.railMinX).toBeLessThanOrEqual(bus.hubX);
          expect(bus.hubX).toBeLessThanOrEqual(bus.railMaxX);
          for (const drop of bus.childDrops) {
            expect(layout1.byId.has(drop.childId)).toBe(true);
            expect(bus.railMinX).toBeLessThanOrEqual(drop.x);
            expect(drop.x).toBeLessThanOrEqual(bus.railMaxX);
          }
        }
        for (const strip of layout1.earlyLossStrips) {
          expect(Number.isFinite(strip.x)).toBe(true);
          expect(Number.isFinite(strip.y)).toBe(true);
          expect(strip.width).toBeGreaterThan(0);
          expect(strip.height).toBeGreaterThan(0);
          expect(strip.chips.length).toBeGreaterThan(0);
          // Every chip lies strictly within strip inner padding and fills available row width
          const chipsPerRow = Math.min(3, strip.chips.length);
          const expectedChipW = Math.floor((strip.width - 24 - (chipsPerRow - 1) * 8) / chipsPerRow);
          for (const chip of strip.chips) {
            expect(chip.x).toBeGreaterThanOrEqual(strip.x + 12);
            expect(chip.x + chip.width).toBeLessThanOrEqual(strip.x + strip.width - 12);
            expect(chip.width).toBe(expectedChipW);
          }
        }
        // 7. Sibling horizontal buses in the same generation band maintain >= 12px vertical lane separation
        const busesByGen = new Map<number, number[]>();
        for (const bus of layout1.buses) {
          const union = model1.unionsById.get(bus.unionId);
          if (!union) continue;
          const list = busesByGen.get(union.gen) ?? [];
          list.push(bus.busY);
          busesByGen.set(union.gen, list);
        }
        for (const laneYs of busesByGen.values()) {
          const sorted = [...laneYs].sort((a, b) => a - b);
          for (let i = 1; i < sorted.length; i += 1) {
            expect(sorted[i] - sorted[i - 1]).toBeGreaterThanOrEqual(12);
          }
        }
        for (const rail of layout1.hangingRails) {
          expect(Number.isFinite(rail.spineX)).toBe(true);
          expect(rail.bottomY).toBeGreaterThanOrEqual(rail.topY);
        }
      }),
      { seed: TREE_PROP_SEED, numRuns: 80 }
    );
  });

  it('keeps lineage spotlight, search ranking, focus plans, and empty models internally consistent', () => {
    const emptyModel = buildArchivalTreeModel({ people: [], kinship: [], mode: 'full' });
    const emptyLayout = computeArchivalDiagramLayout(emptyModel);
    expect(emptyLayout.nodes).toEqual([]);
    expect(emptyLayout.bounds).toEqual({ minX: 0, maxX: 960, minY: 0, maxY: 600 });
    expect(computeLineageSpotlight({ selectedPersonId: 'per_missing', model: emptyModel })).toBeNull();

    fc.assert(
      fc.property(dagSpecArb, (spec) => {
        const { people, kinship, placesById, bundle } = buildSyntheticDag(spec);
        const model = buildArchivalTreeModel({
          people,
          kinship,
          branchFilter: 'alder_line',
          defaultBranchId: 'alder_line',
          mode: spec.mode,
        });

        const visible = model.visiblePeople;
        if (visible.length > 0) {
          const target = visible[visible.length - 1];
          const spotlight = computeLineageSpotlight({
            selectedPersonId: target.id,
            model,
            bundle,
            placesById,
          });
          expect(spotlight).not.toBeNull();
          expect(spotlight?.highlightedPersonIds.has(target.id)).toBe(true);
          expect(spotlight?.breadcrumb.at(-1)?.id).toBe(target.id);

          const plan = resolveTreeFocusPlan({
            person: target,
            model,
            currentBranchFilter: 'alder_line',
            defaultBranchId: 'alder_line',
            currentMode: spec.mode,
          });
          expect(plan.nextBranchFilter).toBe('alder_line');
        }

        const results = searchTreePeople({
          query: '',
          people,
          buildMode: 'public',
          model,
          branchFilter: 'alder_line',
          defaultBranchId: 'alder_line',
          branchLabelsById: new Map([['alder_line', 'Alder Line']]),
          limit: 20,
        });
        for (const r of results) {
          expect(r.person.is_living).toBe(false);
          expect(r.person.full_name.trim()).not.toBe('Living');
        }
      }),
      { seed: TREE_PROP_SEED + 1, numRuns: 40 }
    );

    expect(toRomanNumeral(1)).toBe('I');
    expect(toRomanNumeral(6)).toBe('VI');
    expect(toRomanNumeral(7)).toBe('7');
    expect(formatEarlyLossAgeLabel({ birth_year: null, death_year: 1890 })).toBe('');
    expect(formatEarlyLossAgeLabel({ birth_year: 1890, death_year: 1890 })).toBe('1890');
    expect(formatEarlyLossAgeLabel({ birth_year: 1890, death_year: 1892 })).toBe('1890–1892');
    expect(formatCardLifespan({ birth_year: null, death_year: null, is_living: true })).toBe('Living');
    expect(formatCardLifespan({ birth_year: null, death_year: null, is_living: false })).toBe(
      'Dates unrecorded'
    );
    expect(
      formatUnionOtherChildrenLabel({
        hiddenCount: 1,
        totalCollateralCount: 1,
        visibleChildCount: 0,
        isExpanded: false,
        mode: 'full',
      }).compactLabel
    ).toBe('▸ +1 child');
    expect(
      formatUnionOtherChildrenLabel({
        hiddenCount: 0,
        totalCollateralCount: 3,
        visibleChildCount: 0,
        isExpanded: true,
        mode: 'spine',
      }).compactLabel
    ).toBe('▾ Hide 3 children');
    expect(
      formatUnionOtherChildrenLabel({
        hiddenCount: 0,
        totalCollateralCount: 2,
        visibleChildCount: 1,
        isExpanded: true,
        mode: 'spine',
      }).buttonLabel
    ).toBe('Hide 2 other children (1 in direct line below)');
  });

  it('maintains zero empty generations and non-overlapping layout for arbitrary anchorPersonId across generated DAGs', () => {
    fc.assert(
      fc.property(dagSpecArb, fc.nat({ max: 100 }), (spec, anchorSeed) => {
        const { people, kinship } = buildSyntheticDag(spec);
        const visibleCandidates = people.filter((p) => p.full_name.trim() !== 'Living');
        if (visibleCandidates.length === 0) {
          return;
        }
        const chosenAnchor = visibleCandidates[anchorSeed % visibleCandidates.length];
        const model = buildArchivalTreeModel({
          people,
          kinship,
          branchFilter: 'alder_line',
          defaultBranchId: 'alder_line',
          mode: spec.mode,
          anchorPersonId: chosenAnchor.id,
        });
        const layout = computeArchivalDiagramLayout(model);

        expect(model.anchorPersonId).toBe(chosenAnchor.id);
        expect(model.pivotPersonId).toBe(chosenAnchor.id);
        expect(model.directPersonIds.has(chosenAnchor.id)).toBe(true);
        expect(model.earlyLossIds.has(chosenAnchor.id)).toBe(false);
        expect(model.generations.every((g) => g.personIds.length > 0 && g.units.length > 0)).toBe(true);
        expect(layout.byId.has(chosenAnchor.id)).toBe(true);

        for (let i = 0; i < layout.nodes.length; i += 1) {
          for (let j = i + 1; j < layout.nodes.length; j += 1) {
            expect(boxesOverlap(layout.nodes[i], layout.nodes[j])).toBe(false);
          }
        }
      }),
      { seed: TREE_PROP_SEED + 76, numRuns: 60 }
    );
  });
});
