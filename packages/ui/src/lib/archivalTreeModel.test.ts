import type { ArchiveBundle, KinshipEdge, Person, Place } from '@kinloom/core';
import {
  ARCHIVAL_NODE_W,
  buildArchivalTreeModel,
  computeArchivalDiagramLayout,
  computeLineageSpotlight,
  formatCardLifespan,
  isEarlyChildhoodLoss,
  resolveInitialTreePreferences,
  resolveSemanticZoomLevel,
} from './archivalTreeModel.js';
import { describe, expect, it } from 'vitest';

function makePerson(
  overrides: Partial<Person> & Pick<Person, 'id' | 'slug' | 'full_name'>,
): Person {
  const parts = overrides.full_name.split(' ');
  return {
    given_name: parts[0] ?? overrides.full_name,
    surname: parts.at(-1) ?? '',
    alt_names: [],
    sex: 'U',
    is_living: false,
    lineage_group: 'collateral',
    branch: 'hale_line',
    birth_edtf: '',
    death_edtf: '',
    birth_year: null,
    death_year: null,
    portrait_url: null,
    event_count: 1,
    primary_place_id: 'plc_harbor',
    ...overrides,
  };
}

function buildSyntheticFamilyFixture(): {
  people: Person[];
  kinship: KinshipEdge[];
  placesById: Map<string, Place>;
  bundle: ArchiveBundle;
} {
  const people: Person[] = [
    // Gen 1: Founders
    makePerson({
      id: 'p_thomas',
      slug: 'thomas-hale',
      full_name: 'Thomas Hale',
      lineage_group: 'ancestor',
      birth_year: 1790,
      death_year: 1862,
      birth_edtf: '1790',
      death_edtf: '1862',
    }),
    makePerson({
      id: 'p_eliza',
      slug: 'eliza-brent',
      full_name: 'Eliza Brent',
      lineage_group: 'ancestor',
      birth_year: 1794,
      death_year: 1870,
      birth_edtf: '1794',
      death_edtf: '1870',
    }),
    // Gen 2: Remarried pivot ancestor + 2 spouses
    makePerson({
      id: 'p_arthur',
      slug: 'arthur-hale',
      full_name: 'Arthur Hale',
      lineage_group: 'pivot_ancestor',
      birth_year: 1820,
      death_year: 1898,
      birth_edtf: '1820',
      death_edtf: '1898',
    }),
    makePerson({
      id: 'p_clara',
      slug: 'clara-finch',
      full_name: 'Clara Finch',
      lineage_group: 'ancestor',
      birth_year: 1824,
      death_year: 1858,
      birth_edtf: '1824',
      death_edtf: '1858',
    }),
    makePerson({
      id: 'p_nora',
      slug: 'nora-vance',
      full_name: 'Nora Vance',
      lineage_group: 'descendant_spouse',
      birth_year: 1835,
      death_year: 1912,
      birth_edtf: '1835',
      death_edtf: '1912',
    }),
    // Gen 3 from Marriage I (Arthur + Clara): 1 direct descendant, 4 collateral leaf siblings, 2 early losses
    makePerson({
      id: 'p_henry',
      slug: 'henry-hale',
      full_name: 'Henry Hale',
      lineage_group: 'descendant',
      birth_year: 1846,
      death_year: 1922,
      birth_edtf: '1846',
      death_edtf: '1922',
    }),
    makePerson({
      id: 'p_sib_1',
      slug: 'martha-hale',
      full_name: 'Martha Hale',
      lineage_group: 'collateral',
      birth_year: 1848,
      death_year: 1910,
    }),
    makePerson({
      id: 'p_sib_2',
      slug: 'samuel-hale',
      full_name: 'Samuel Hale',
      lineage_group: 'collateral',
      birth_year: 1850,
      death_year: 1918,
    }),
    makePerson({
      id: 'p_sib_3',
      slug: 'grace-hale',
      full_name: 'Grace Hale',
      lineage_group: 'collateral',
      birth_year: 1852,
      death_year: 1924,
    }),
    makePerson({
      id: 'p_sib_4',
      slug: 'walter-hale',
      full_name: 'Walter Hale',
      lineage_group: 'collateral',
      birth_year: 1854,
      death_year: 1930,
    }),
    makePerson({
      id: 'p_infant_1',
      slug: 'peter-hale',
      full_name: 'Peter Hale',
      lineage_group: 'collateral',
      birth_year: 1855,
      death_year: 1855,
      birth_edtf: '1855',
      death_edtf: '1855',
    }),
    makePerson({
      id: 'p_infant_2',
      slug: 'lydia-hale',
      full_name: 'Lydia Hale',
      lineage_group: 'collateral',
      birth_year: 1856,
      death_year: 1859,
      birth_edtf: '1856',
      death_edtf: '1859',
    }),
    // Gen 3 from Marriage II (Arthur + Nora): half-sibling child
    makePerson({
      id: 'p_half_1',
      slug: 'beatrice-hale',
      full_name: 'Beatrice Hale',
      lineage_group: 'collateral',
      birth_year: 1862,
      death_year: 1940,
    }),
    // Gen 4: Named living descendant + redacted living placeholder
    makePerson({
      id: 'p_living_named',
      slug: 'rowan-hale',
      full_name: 'Rowan Hale',
      lineage_group: 'descendant',
      is_living: true,
      birth_year: 1992,
      death_year: null,
      birth_edtf: '1992',
    }),
    makePerson({
      id: 'p_living_redacted',
      slug: 'living-person',
      full_name: 'Living',
      lineage_group: 'descendant',
      is_living: true,
      birth_year: null,
      death_year: null,
    }),
    // Secondary branch member
    makePerson({
      id: 'p_vance_elder',
      slug: 'owen-vance',
      full_name: 'Owen Vance',
      lineage_group: 'ancestor',
      branch: 'vance_line',
      birth_year: 1805,
      death_year: 1879,
    }),
  ];

  const kinship: KinshipEdge[] = [
    { from: 'p_thomas', to: 'p_eliza', relation: 'spouse' },
    { from: 'p_eliza', to: 'p_thomas', relation: 'spouse' },
    { from: 'p_thomas', to: 'p_arthur', relation: 'parent' },
    { from: 'p_eliza', to: 'p_arthur', relation: 'parent' },
    { from: 'p_arthur', to: 'p_clara', relation: 'spouse' },
    { from: 'p_clara', to: 'p_arthur', relation: 'spouse' },
    { from: 'p_arthur', to: 'p_nora', relation: 'spouse' },
    { from: 'p_nora', to: 'p_arthur', relation: 'spouse' },
    // Marriage I children
    ...['p_henry', 'p_sib_1', 'p_sib_2', 'p_sib_3', 'p_sib_4', 'p_infant_1', 'p_infant_2'].flatMap(
      (cid): KinshipEdge[] => [
        { from: 'p_arthur', to: cid, relation: 'parent' },
        { from: 'p_clara', to: cid, relation: 'parent' },
      ],
    ),
    // Marriage II child
    { from: 'p_arthur', to: 'p_half_1', relation: 'parent' },
    { from: 'p_nora', to: 'p_half_1', relation: 'parent' },
    // Gen 4 children of Henry
    { from: 'p_henry', to: 'p_living_named', relation: 'parent' },
    { from: 'p_henry', to: 'p_living_redacted', relation: 'parent' },
  ];

  const placesById = new Map<string, Place>([
    [
      'plc_harbor',
      {
        id: 'plc_harbor',
        slug: 'harbor-town',
        name: 'Harbor Town',
        full_name: 'Harbor Town, Maine, USA',
        place_type: 'town',
        parent_id: null,
        lat: 43.65,
        lng: -70.25,
      },
    ],
  ]);

  const bundle: ArchiveBundle = {
    meta: {
      build_mode: 'public',
      generated_at: '2026-01-01T00:00:00Z',
      counts: {
        people: people.length,
        living_redacted: 1,
        events: 0,
        residence_spans: 0,
        places: 1,
        sources: 0,
      },
    },
    people,
    events: [],
    residence_spans: [],
    places: [...placesById.values()],
    place_ancestors: {},
    kinship,
    sources: [],
  };

  return { people, kinship, placesById, bundle };
}

describe('archivalTreeModel', () => {
  it('redacts Living placeholders, preserves named living formatting, and resolves viewport defaults', () => {
    const { people, kinship } = buildSyntheticFamilyFixture();
    const model = buildArchivalTreeModel({ people, kinship, mode: 'full' });

    expect(model.peopleById.has('p_living_redacted')).toBe(false);
    expect(model.peopleById.has('p_living_named')).toBe(true);
    expect(formatCardLifespan(model.peopleById.get('p_living_named')!)).toBe('b. 1992 · Living');

    expect(resolveInitialTreePreferences(390)).toEqual({ surface: 'roll', mode: 'spine' });
    expect(resolveInitialTreePreferences(1280)).toEqual({ surface: 'diagram', mode: 'full' });

    expect(resolveSemanticZoomLevel(0.35)).toBe('overview');
    expect(resolveSemanticZoomLevel(0.6)).toBe('compact');
    expect(resolveSemanticZoomLevel(0.95)).toBe('detail');
  });

  it('groups remarriages around a central anchor with ordered discrete union hubs and staggered orthogonal buses', () => {
    const { people, kinship } = buildSyntheticFamilyFixture();
    const model = buildArchivalTreeModel({
      people,
      kinship,
      branchFilter: 'hale_line',
      defaultBranchId: 'hale_line',
      mode: 'full',
    });

    const arthurUnit = model.generations
      .flatMap((g) => g.units)
      .find((u) => u.orderedMemberIds.includes('p_arthur'));
    expect(arthurUnit?.orderedMemberIds).toEqual(['p_clara', 'p_arthur', 'p_nora']);

    const arthurUnions = model.unions
      .filter((u) => u.primaryPartnerId === 'p_arthur')
      .toSorted((a, b) => a.marriageOrder - b.marriageOrder);
    expect(arthurUnions).toHaveLength(2);
    expect(arthurUnions[0].secondaryPartnerId).toBe('p_clara');
    expect(arthurUnions[0].marriageOrder).toBe(1);
    expect(arthurUnions[0].totalMarriagesForPrimary).toBe(2);
    expect(arthurUnions[1].secondaryPartnerId).toBe('p_nora');
    expect(arthurUnions[1].marriageOrder).toBe(2);

    const layout = computeArchivalDiagramLayout(model);
    const arthurHubs = layout.hubs.filter((h) => h.union.primaryPartnerId === 'p_arthur');
    expect(arthurHubs).toHaveLength(2);
    expect(arthurHubs[0].x).toBeLessThan(arthurHubs[1].x);

    // Distinct unions in the same generation get staggered busY tracks so rails never fuse
    const arthurBuses = layout.buses.filter((b) => b.parentIds.includes('p_arthur'));
    expect(arthurBuses).toHaveLength(2);
    expect(arthurBuses[0].busY).not.toBe(arthurBuses[1].busY);

    // Same-generation rank nodes never overlap horizontally
    const byGen = new Map<number, typeof layout.nodes[number][]>();
    for (const node of layout.nodes) {
      if (node.placement !== 'rank') {
        continue;
      }
      const list = byGen.get(node.gen) ?? [];
      list.push(node);
      byGen.set(node.gen, list);
    }
    for (const row of byGen.values()) {
      const sorted = row.toSorted((a, b) => a.x - b.x);
      for (let i = 1; i < sorted.length; i += 1) {
        expect(sorted[i].x - sorted[i - 1].x).toBeGreaterThanOrEqual(ARCHIVAL_NODE_W);
      }
    }
  });

  it('classifies non-branching early childhood losses into memorial strips instead of rank boxes', () => {
    const { people, kinship } = buildSyntheticFamilyFixture();
    const model = buildArchivalTreeModel({
      people,
      kinship,
      branchFilter: 'hale_line',
      defaultBranchId: 'hale_line',
      mode: 'full',
    });

    expect(model.earlyLossIds.has('p_infant_1')).toBe(true);
    expect(model.earlyLossIds.has('p_infant_2')).toBe(true);
    expect(model.earlyLossIds.has('p_henry')).toBe(false);
    expect(
      isEarlyChildhoodLoss(
        model.peopleById.get('p_living_named')!,
        model.parentMap,
        model.childMap,
        model.spouseMap,
      ),
    ).toBe(false);

    const layout = computeArchivalDiagramLayout(model);
    expect(layout.byId.has('p_infant_1')).toBe(false);
    expect(layout.earlyLossStrips).toHaveLength(1);
    expect(layout.earlyLossStrips[0].chips.map((c) => c.person.id)).toEqual([
      'p_infant_1',
      'p_infant_2',
    ]);
  });

  it('collapses large collateral sibling sets behind progressive disclosure and expands into a 2-column hanging grid', () => {
    const { people, kinship } = buildSyntheticFamilyFixture();
    const collapsedModel = buildArchivalTreeModel({
      people,
      kinship,
      branchFilter: 'hale_line',
      defaultBranchId: 'hale_line',
      mode: 'full',
    });

    const marriageOne = collapsedModel.unions.find(
      (u) => u.primaryPartnerId === 'p_arthur' && u.secondaryPartnerId === 'p_clara',
    )!;
    expect(marriageOne.visibleChildIds).toEqual(['p_henry']);
    expect(marriageOne.collapsedSiblingIds).toEqual([
      'p_sib_1',
      'p_sib_2',
      'p_sib_3',
      'p_sib_4',
    ]);

    const collapsedLayout = computeArchivalDiagramLayout(collapsedModel);
    expect(collapsedLayout.siblingToggles).toHaveLength(1);
    expect(collapsedLayout.siblingToggles[0].hiddenCount).toBe(4);
    expect(collapsedLayout.hangingRails).toHaveLength(0);

    // Expanding the union unfolds the 4 siblings into a 2-column hanging grid
    const expandedModel = buildArchivalTreeModel({
      people,
      kinship,
      branchFilter: 'hale_line',
      defaultBranchId: 'hale_line',
      mode: 'full',
      expandedUnionIds: new Set([marriageOne.id]),
    });
    const expandedLayout = computeArchivalDiagramLayout(expandedModel);
    expect(expandedLayout.hangingRails).toHaveLength(1);
    expect(expandedLayout.hangingRails[0].ticks).toHaveLength(4);

    const hangingNodes = expandedLayout.nodes.filter((n) => n.placement === 'hanging');
    expect(hangingNodes).toHaveLength(4);
    const distinctColumns = new Set(hangingNodes.map((n) => n.x));
    const distinctRows = new Set(hangingNodes.map((n) => n.y));
    expect(distinctColumns.size).toBe(2);
    expect(distinctRows.size).toBe(2);
  });

  it('computes tap-to-trace lineage spotlight, ancestor breadcrumb, and relationship to pivot', () => {
    const { people, kinship, placesById, bundle } = buildSyntheticFamilyFixture();
    const model = buildArchivalTreeModel({ people, kinship, mode: 'full' });

    const spotlight = computeLineageSpotlight({
      selectedPersonId: 'p_henry',
      model,
      bundle,
      placesById,
    });
    expect(spotlight).not.toBeNull();
    expect(spotlight!.ancestorIds.has('p_arthur')).toBe(true);
    expect(spotlight!.ancestorIds.has('p_clara')).toBe(true);
    expect(spotlight!.ancestorIds.has('p_thomas')).toBe(true);
    expect(spotlight!.descendantIds.has('p_living_named')).toBe(true);
    expect(spotlight!.highlightedPersonIds.has('p_half_1')).toBe(false);
    expect(spotlight!.breadcrumb.map((p) => p.id)).toEqual(['p_thomas', 'p_arthur', 'p_henry']);
    expect(spotlight!.relationshipToPivot).toBe('Child of');
    expect(spotlight!.pivotName).toBe('Arthur Hale');
  });
});
