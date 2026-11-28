import type { KinshipEdge, Person } from '@kinloom/core';
import { describe, expect, it } from 'vitest';
import { buildArchivalTreeModel, computeArchivalDiagramLayout } from '../archivalTreeModel.js';
import { assignBrandesKopfX, minItemSeparation } from './brandesKopf.js';
import {
  assignBusTracksWithConstraintGraph,
  BUS_LANE_SPACING,
  type BusConstraintInput,
  countBusOrderCrossings,
} from './busConstraintRouting.js';
import {
  buildLayeredGraphWithDummyChannels,
  DUMMY_CHANNEL_WIDTH,
  DUMMY_TO_DUMMY_GAP,
  DUMMY_TO_UNIT_GAP,
  type LayeredGraph,
  type LayerItem,
  minimizeLayeredCrossings,
} from './layeredChannels.js';
import { resolveUnitUnionPorts } from './layeredPorts.js';
import { ARCHIVAL_UNIT_GAP, type TreeFamilyUnit } from './types.js';

function makePerson(
  id: string,
  fullName: string,
  birthYear: number,
  lineageGroup: Person['lineage_group'] = 'collateral'
): Person {
  const parts = fullName.split(' ');
  return {
    id,
    slug: id.replaceAll('_', '-'),
    full_name: fullName,
    given_name: parts[0] ?? fullName,
    surname: parts.at(-1) ?? '',
    alt_names: [],
    sex: 'U',
    is_living: false,
    lineage_group: lineageGroup,
    branch: 'alder_line',
    birth_edtf: String(birthYear),
    death_edtf: String(birthYear + 68),
    birth_year: birthYear,
    death_year: birthYear + 68,
    portrait_url: null,
    event_count: 1,
    primary_place_id: null,
  };
}

describe('elk.layered pure TypeScript port helpers (#83)', () => {
  it('assigns deterministic strictly ordered left-to-right ports on 2-marriage, 3-marriage, and coincident single-parent hubs', () => {
    const people: Person[] = [
      makePerson('p_anchor', 'Arthur Alder', 1780, 'pivot_ancestor'),
      makePerson('p_sp1', 'Clara Mercer', 1782, 'ancestor'),
      makePerson('p_sp2', 'Beatrice Vance', 1790, 'descendant_spouse'),
      makePerson('p_sp3', 'Dorothea Hale', 1798, 'descendant_spouse'),
      makePerson('p_c1', 'ChildOne Alder', 1805, 'descendant'),
      makePerson('p_c2', 'ChildTwo Alder', 1814, 'collateral'),
      makePerson('p_c3', 'ChildThree Alder', 1822, 'collateral'),
    ];
    const kinship: KinshipEdge[] = [
      { from: 'p_anchor', to: 'p_sp1', relation: 'spouse' },
      { from: 'p_anchor', to: 'p_sp2', relation: 'spouse' },
      { from: 'p_anchor', to: 'p_sp3', relation: 'spouse' },
      { from: 'p_anchor', to: 'p_c1', relation: 'parent' },
      { from: 'p_sp1', to: 'p_c1', relation: 'parent' },
      { from: 'p_anchor', to: 'p_c2', relation: 'parent' },
      { from: 'p_sp2', to: 'p_c2', relation: 'parent' },
      { from: 'p_anchor', to: 'p_c3', relation: 'parent' },
      { from: 'p_sp3', to: 'p_c3', relation: 'parent' },
    ];
    const model = buildArchivalTreeModel({ people, kinship, mode: 'full' });
    const unit = model.generations[0].units[0];
    const ports = resolveUnitUnionPorts(model, unit);
    expect(ports).toHaveLength(3);
    expect(ports[0].relativeX).toBeLessThan(ports[1].relativeX);
    expect(ports[1].relativeX).toBeLessThan(ports[2].relativeX);
    expect(ports[0].normalizedOffset).toBeLessThan(ports[1].normalizedOffset);
    expect(ports[1].normalizedOffset).toBeLessThan(ports[2].normalizedOffset);

    const layout = computeArchivalDiagramLayout(model);
    const hubs = layout.hubs.toSorted((a, b) => a.x - b.x);
    expect(hubs).toHaveLength(3);
    expect(hubs[0].x).toBeLessThan(hubs[1].x);
    expect(hubs[1].x).toBeLessThan(hubs[2].x);

    // Child subtrees align left-to-right matching marriage port order (zero immediate stem crossings).
    const c1 = layout.byId.get('p_c1')!;
    const c2 = layout.byId.get('p_c2')!;
    const c3 = layout.byId.get('p_c3')!;
    expect(c1.x).toBeLessThan(c2.x);
    expect(c2.x).toBeLessThan(c3.x);

    // Non-adjacent spouse positioned to the left of primary (secondaryIdx < primaryIdx - 1) and empty union unit.
    const reversedUnit: TreeFamilyUnit = {
      id: 'rev',
      gen: 0,
      anchorId: 'p_anchor',
      orderedMemberIds: ['p_sp3', 'p_sp2', 'p_sp1', 'p_anchor'],
      unionIds: unit.unionIds,
      isDirect: true,
    };
    const revPorts = resolveUnitUnionPorts(model, reversedUnit);
    expect(revPorts).toHaveLength(3);
    expect(revPorts[0].relativeX).toBeLessThan(revPorts[1].relativeX);
    expect(revPorts[1].relativeX).toBeLessThan(revPorts[2].relativeX);

    const emptyUnit: TreeFamilyUnit = {
      id: 'empty',
      gen: 0,
      anchorId: 'p_anchor',
      orderedMemberIds: ['p_anchor'],
      unionIds: [],
      isDirect: false,
    };
    expect(resolveUnitUnionPorts(model, emptyUnit)).toEqual([]);

    // Coincident ports on a single member (including equal marriageOrder unionId tie-break) get symmetrically separated.
    const syntheticSingleUnionsModel = {
      ...model,
      unionsById: new Map([
        ['u2', { ...model.unions[0], id: 'u2', secondaryPartnerId: null, marriageOrder: 1 }],
        ['u1', { ...model.unions[0], id: 'u1', secondaryPartnerId: null, marriageOrder: 1 }],
        ['u3', { ...model.unions[0], id: 'u3', secondaryPartnerId: null, marriageOrder: 2 }],
      ]),
    };
    const coincidentPorts = resolveUnitUnionPorts(syntheticSingleUnionsModel, {
      id: 'coinc',
      gen: 0,
      anchorId: 'p_anchor',
      orderedMemberIds: ['p_anchor'],
      unionIds: ['u2', 'u1', 'u3'],
      isDirect: false,
    });
    expect(coincidentPorts).toHaveLength(3);
    expect(coincidentPorts.map((p) => p.unionId)).toEqual(['u1', 'u2', 'u3']);
    expect(coincidentPorts[1].relativeX - coincidentPorts[0].relativeX).toBe(16);
    expect(coincidentPorts[2].relativeX - coincidentPorts[1].relativeX).toBe(16);
  });

  it('inserts multi-generation dummy channels and resolves Type-1 conflicts cleanly in Brandes-Kopf', () => {
    const unitStub: TreeFamilyUnit = {
      id: 'u',
      gen: 0,
      anchorId: 'a',
      orderedMemberIds: ['a'],
      unionIds: [],
      isDirect: false,
    };
    const mkUnit = (id: string, layerIndex: number): LayerItem => ({
      kind: 'unit',
      id,
      layerIndex,
      unit: { ...unitStub, id, gen: layerIndex },
      width: 196,
      memberOffsetX: 0,
    });
    const mkDummy = (id: string, layerIndex: number): LayerItem => ({
      kind: 'dummy',
      id,
      layerIndex,
      width: DUMMY_CHANNEL_WIDTH,
      unionId: 'u_long',
      childId: 'c_long',
      sourceUnitId: 'u0a',
      targetUnitId: 'u3b',
    });

    expect(minItemSeparation(mkDummy('d1', 1), mkDummy('d2', 1))).toBe(DUMMY_TO_DUMMY_GAP);
    expect(minItemSeparation(mkDummy('d1', 1), mkUnit('u1', 1))).toBe(DUMMY_TO_UNIT_GAP);
    expect(minItemSeparation(mkUnit('u1', 1), mkUnit('u2', 1))).toBe(ARCHIVAL_UNIT_GAP);

    // Graph with inner dummy segment (d1 -> d2) crossed by a non-inner edge (u1b -> u2a), exercising Type-1 conflict marking.
    const graph: LayeredGraph = {
      layers: [
        [mkUnit('u0a', 0), mkUnit('u0b', 0)],
        [mkDummy('d1', 1), mkUnit('u1a', 1), mkUnit('u1b', 1)],
        [mkUnit('u2a', 2), mkDummy('d2', 2), mkUnit('u2b', 2)],
        [mkUnit('u3a', 3), mkUnit('u3b', 3)],
      ],
      edges: [
        {
          sourceId: 'u0a',
          targetId: 'd1',
          sourceLayer: 0,
          targetLayer: 1,
          sourcePortOffsetX: 98,
          targetPortOffsetX: 12,
          sourcePortNorm: 0,
          targetPortNorm: 0,
          isInnerSegment: false,
          isDirect: true,
        },
        {
          sourceId: 'd1',
          targetId: 'd2',
          sourceLayer: 1,
          targetLayer: 2,
          sourcePortOffsetX: 12,
          targetPortOffsetX: 12,
          sourcePortNorm: 0,
          targetPortNorm: 0,
          isInnerSegment: true,
          isDirect: true,
        },
        {
          sourceId: 'u1b',
          targetId: 'u2a',
          sourceLayer: 1,
          targetLayer: 2,
          sourcePortOffsetX: 98,
          targetPortOffsetX: 98,
          sourcePortNorm: 0,
          targetPortNorm: 0,
          isInnerSegment: false,
          isDirect: false,
        },
        {
          sourceId: 'd2',
          targetId: 'u3b',
          sourceLayer: 2,
          targetLayer: 3,
          sourcePortOffsetX: 12,
          targetPortOffsetX: 98,
          sourcePortNorm: 0,
          targetPortNorm: 0,
          isInnerSegment: false,
          isDirect: true,
        },
        {
          sourceId: 'u0b',
          targetId: 'u1a',
          sourceLayer: 0,
          targetLayer: 1,
          sourcePortOffsetX: 98,
          targetPortOffsetX: 98,
          sourcePortNorm: 0,
          targetPortNorm: 0,
          isInnerSegment: false,
          isDirect: false,
        },
        {
          sourceId: 'u1a',
          targetId: 'u2b',
          sourceLayer: 1,
          targetLayer: 2,
          sourcePortOffsetX: 98,
          targetPortOffsetX: 98,
          sourcePortNorm: 0,
          targetPortNorm: 0,
          isInnerSegment: false,
          isDirect: false,
        },
        {
          sourceId: 'u2a',
          targetId: 'u3a',
          sourceLayer: 2,
          targetLayer: 3,
          sourcePortOffsetX: 98,
          targetPortOffsetX: 98,
          sourcePortNorm: 0,
          targetPortNorm: 0,
          isInnerSegment: false,
          isDirect: false,
        },
      ],
      dummyChainsByEdgeKey: new Map(),
      portsByUnitId: new Map(),
    };

    const rawCoords = assignBrandesKopfX(graph, 148);
    expect(rawCoords.size).toBe(10);
    // Inner segment d1 -> d2 aligns vertically with zero horizontal drift.
    expect(rawCoords.get('d1')).toBe(rawCoords.get('d2'));

    const minimized = minimizeLayeredCrossings(graph);
    const minCoords = assignBrandesKopfX(minimized, 148);
    for (const layer of minimized.layers) {
      for (let i = 1; i < layer.length; i += 1) {
        const prev = layer[i - 1];
        const cur = layer[i];
        expect(minCoords.get(cur.id)!).toBeGreaterThanOrEqual(
          minCoords.get(prev.id)! + prev.width + minItemSeparation(prev, cur)
        );
      }
    }

    // Empty graph edge cases
    const emptyGraph: LayeredGraph = {
      layers: [],
      edges: [],
      dummyChainsByEdgeKey: new Map(),
      portsByUnitId: new Map(),
    };
    expect(minimizeLayeredCrossings(emptyGraph)).toBe(emptyGraph);
    expect(assignBrandesKopfX(emptyGraph, 148).size).toBe(0);

    // End-to-end multi-gen dummy channel build check (G0 -> G3)
    const spanPeople: Person[] = [
      makePerson('s0', 'Root Alder', 1750, 'pivot_ancestor'),
      makePerson('s1', 'GenOne Alder', 1780, 'collateral'),
      makePerson('s2', 'GenTwo Alder', 1810, 'collateral'),
      makePerson('s3', 'GenThree Alder', 1840, 'descendant'),
    ];
    const spanKinship: KinshipEdge[] = [
      { from: 's0', to: 's1', relation: 'parent' },
      { from: 's1', to: 's2', relation: 'parent' },
      { from: 's0', to: 's3', relation: 'parent' },
      { from: 's2', to: 's3', relation: 'parent' },
    ];
    const spanModel = buildArchivalTreeModel({ people: spanPeople, kinship: spanKinship, mode: 'full' });
    const layered = buildLayeredGraphWithDummyChannels(spanModel, () => ({ width: 196, memberOffsetX: 0 }));
    expect(layered.dummyChainsByEdgeKey.size).toBe(1);
    const [chain] = layered.dummyChainsByEdgeKey.values();
    expect(chain).toHaveLength(2);
    expect(chain.map((e) => e.layerIndex)).toEqual([1, 2]);
  });

  it('breaks cycles cleanly in the vertical constraint graph and preserves >= 14px bus spacing', () => {
    expect(assignBusTracksWithConstraintGraph([])).toEqual([]);
    expect(
      assignBusTracksWithConstraintGraph([
        { id: 'only', hubX: 100, dropXs: [100], railMinX: 100, railMaxX: 100 },
      ])
    ).toEqual([{ id: 'only', trackIndex: 0 }]);

    // Directed 3-cycle in the vertical constraint graph: B -> A (w=3), C -> B (w=2), A -> C (w=1)
    const cyclicBuses: BusConstraintInput[] = [
      { id: 'bus_a', hubX: 100, dropXs: [250, 260], railMinX: 100, railMaxX: 260 },
      { id: 'bus_b', hubX: 200, dropXs: [450, 460], railMinX: 200, railMaxX: 460 },
      { id: 'bus_c', hubX: 550, dropXs: [150, 160, 170], railMinX: 150, railMaxX: 550 },
    ];
    expect(countBusOrderCrossings(cyclicBuses[1], cyclicBuses[0])).toBeLessThan(
      countBusOrderCrossings(cyclicBuses[0], cyclicBuses[1])
    );
    expect(countBusOrderCrossings(cyclicBuses[2], cyclicBuses[1])).toBeLessThan(
      countBusOrderCrossings(cyclicBuses[1], cyclicBuses[2])
    );
    expect(countBusOrderCrossings(cyclicBuses[0], cyclicBuses[2])).toBeLessThan(
      countBusOrderCrossings(cyclicBuses[2], cyclicBuses[0])
    );

    const assigned = assignBusTracksWithConstraintGraph(cyclicBuses);
    expect(assigned).toHaveLength(3);
    expect(assigned.map((a) => a.trackIndex)).toEqual([0, 1, 2]);
    expect(new Set(assigned.map((a) => a.id)).size).toBe(3);
    expect(BUS_LANE_SPACING).toBe(14);

    // Tied inWeight 3-cycle exercises net-weight and span/hub tie-breakers cleanly.
    const symmetricCycle: BusConstraintInput[] = [
      { id: 'sym_a', hubX: 100, dropXs: [250, 260], railMinX: 100, railMaxX: 260 },
      { id: 'sym_b', hubX: 200, dropXs: [450, 460], railMinX: 200, railMaxX: 460 },
      { id: 'sym_c', hubX: 550, dropXs: [150, 160, 170, 180], railMinX: 150, railMaxX: 550 },
      { id: 'sym_d', hubX: 200, dropXs: [450, 460], railMinX: 200, railMaxX: 460 },
    ];
    const symAssigned = assignBusTracksWithConstraintGraph(symmetricCycle);
    expect(symAssigned).toHaveLength(4);
    expect(symAssigned.map((a) => a.trackIndex)).toEqual([0, 1, 2, 3]);

    // Equal-inWeight cycles exercising net-weight selection, tie-breaker selection, and post-cycle adjacent swap polish.
    const netWeightAndPolishCycle: BusConstraintInput[] = [
      { id: 'b0', hubX: 20, dropXs: [70, 70, 40], railMinX: 20, railMaxX: 70 },
      { id: 'b1', hubX: 30, dropXs: [40, 80, 70], railMinX: 30, railMaxX: 80 },
      { id: 'b2', hubX: 100, dropXs: [40], railMinX: 40, railMaxX: 100 },
      { id: 'b3', hubX: 70, dropXs: [40], railMinX: 40, railMaxX: 70 },
    ];
    const netAssigned = assignBusTracksWithConstraintGraph(netWeightAndPolishCycle);
    expect(netAssigned).toHaveLength(4);
    expect(netAssigned.map((a) => a.trackIndex)).toEqual([0, 1, 2, 3]);

    const tieBreakCycle: BusConstraintInput[] = [
      { id: 'tb0', hubX: 20, dropXs: [40], railMinX: 20, railMaxX: 40 },
      { id: 'tb1', hubX: 30, dropXs: [0, 50, 70], railMinX: 0, railMaxX: 70 },
      { id: 'tb2', hubX: 10, dropXs: [100, 80, 30], railMinX: 10, railMaxX: 100 },
      { id: 'tb3', hubX: 100, dropXs: [60, 30, 80], railMinX: 30, railMaxX: 100 },
    ];
    const tbAssigned = assignBusTracksWithConstraintGraph(tieBreakCycle);
    expect(tbAssigned).toHaveLength(4);
    expect(tbAssigned.map((a) => a.trackIndex)).toEqual([0, 1, 2, 3]);
  });

  it('handles dangling edges, empty middle layers, wide >64-item sifting layers, and multi-gen obstacle-avoiding child drops', () => {
    const unitStub: TreeFamilyUnit = {
      id: 'u',
      gen: 0,
      anchorId: 'a',
      orderedMemberIds: ['a'],
      unionIds: [],
      isDirect: false,
    };
    const mkUnit = (id: string, layerIndex: number): LayerItem => ({
      kind: 'unit',
      id,
      layerIndex,
      unit: { ...unitStub, id, gen: layerIndex },
      width: 196,
      memberOffsetX: 0,
    });

    // Dangling edges and an empty intermediate layer are safely ignored in crossing minimization & Brandes-Kopf.
    const sparseGraph: LayeredGraph = {
      layers: [[mkUnit('top_0', 0)], [], [mkUnit('bot_0', 2)]],
      edges: [
        {
          sourceId: 'missing_src',
          targetId: 'bot_0',
          sourceLayer: 0,
          targetLayer: 2,
          sourcePortOffsetX: 98,
          targetPortOffsetX: 98,
          sourcePortNorm: 0,
          targetPortNorm: 0,
          isInnerSegment: false,
          isDirect: false,
        },
      ],
      dummyChainsByEdgeKey: new Map(),
      portsByUnitId: new Map(),
    };
    const sparseMin = minimizeLayeredCrossings(sparseGraph);
    expect(sparseMin.layers).toHaveLength(3);
    expect(assignBrandesKopfX(sparseMin, 148).size).toBe(2);

    // Wide layer (> 64 items) with crossing edges exercises incremental sifting buffer expansion & non-adjacent moves.
    const wideTop: LayerItem[] = [];
    const wideMid: LayerItem[] = [];
    const wideBot: LayerItem[] = [];
    const wideEdges: LayeredGraph['edges'][number][] = [];
    for (let i = 0; i < 66; i += 1) {
      wideTop.push(mkUnit(`wt_${i}`, 0));
      wideMid.push(mkUnit(`wm_${i}`, 1));
      wideBot.push(mkUnit(`wb_${i}`, 2));
    }
    // Reverse connections on a subset so sifting must relocate nodes across multiple slots to reduce crossings.
    for (let i = 0; i < 12; i += 1) {
      const targetIdx = 11 - i;
      wideEdges.push(
        {
          sourceId: `wt_${i}`,
          targetId: `wm_${targetIdx}`,
          sourceLayer: 0,
          targetLayer: 1,
          sourcePortOffsetX: 98,
          targetPortOffsetX: 98,
          sourcePortNorm: 0,
          targetPortNorm: 0,
          isInnerSegment: false,
          isDirect: false,
        },
        {
          sourceId: `wm_${targetIdx}`,
          targetId: `wb_${i}`,
          sourceLayer: 1,
          targetLayer: 2,
          sourcePortOffsetX: 98,
          targetPortOffsetX: 98,
          sourcePortNorm: 0,
          targetPortNorm: 0,
          isInnerSegment: false,
          isDirect: false,
        }
      );
    }
    const wideGraph: LayeredGraph = {
      layers: [wideTop, wideMid, wideBot],
      edges: wideEdges,
      dummyChainsByEdgeKey: new Map(),
      portsByUnitId: new Map(),
    };
    const wideMin = minimizeLayeredCrossings(wideGraph);
    expect(wideMin.layers[1]).toHaveLength(66);
    const wideCoords = assignBrandesKopfX(wideMin, 148);
    expect(wideCoords.size).toBe(198);

    // Multi-generation family with several children in G1 and G2 where G0->G2 skips G1, routing drops cleanly around cards.
    const multiGenPeople: Person[] = [
      makePerson('mg_root', 'Root Alder', 1740, 'pivot_ancestor'),
      makePerson('mg_sp', 'Spouse Mercer', 1744, 'ancestor'),
      makePerson('mg_g1a', 'First Child', 1768, 'collateral'),
      makePerson('mg_g1b', 'Second Child', 1770, 'collateral'),
      makePerson('mg_g1c', 'Third Child', 1772, 'collateral'),
      makePerson('mg_g2a', 'Grandchild A', 1796, 'descendant'),
      makePerson('mg_g2b', 'Grandchild B', 1799, 'descendant'),
      makePerson('mg_g3a', 'GreatGrandchild', 1826, 'descendant'),
    ];
    const multiGenKinship: KinshipEdge[] = [
      { from: 'mg_root', to: 'mg_sp', relation: 'spouse' },
      { from: 'mg_root', to: 'mg_g1a', relation: 'parent' },
      { from: 'mg_sp', to: 'mg_g1a', relation: 'parent' },
      { from: 'mg_root', to: 'mg_g1b', relation: 'parent' },
      { from: 'mg_sp', to: 'mg_g1b', relation: 'parent' },
      { from: 'mg_root', to: 'mg_g1c', relation: 'parent' },
      { from: 'mg_sp', to: 'mg_g1c', relation: 'parent' },
      { from: 'mg_g1a', to: 'mg_g2a', relation: 'parent' },
      { from: 'mg_g1b', to: 'mg_g2b', relation: 'parent' },
      { from: 'mg_g2b', to: 'mg_g3a', relation: 'parent' },
      // Cross-generation link from root union directly to G3 descendant.
      { from: 'mg_root', to: 'mg_g3a', relation: 'parent' },
    ];
    const multiGenModel = buildArchivalTreeModel({
      people: multiGenPeople,
      kinship: multiGenKinship,
      mode: 'full',
    });
    const multiGenLayout = computeArchivalDiagramLayout(multiGenModel);
    expect(multiGenLayout.nodes).toHaveLength(multiGenPeople.length);
    expect(multiGenLayout.buses.length).toBeGreaterThanOrEqual(2);
    for (const bus of multiGenLayout.buses) {
      for (const drop of bus.childDrops) {
        expect(drop.points.length).toBeGreaterThanOrEqual(2);
        for (const pt of drop.points) {
          expect(Number.isFinite(pt.x)).toBe(true);
          expect(Number.isFinite(pt.y)).toBe(true);
        }
      }
    }
  });
});
