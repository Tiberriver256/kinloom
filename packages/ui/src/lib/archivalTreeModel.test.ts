import type { ArchiveBundle, KinshipEdge, Person, Place } from '@kinloom/core';
import { describe, expect, it } from 'vitest';
import {
  ARCHIVAL_NODE_W,
  buildArchivalTreeModel,
  computeArchivalDiagramLayout,
  computeLineageSpotlight,
  formatCardLifespan,
  isEarlyChildhoodLoss,
  isTreeSearchEligible,
  resolveInitialTreePreferences,
  resolveSemanticZoomLevel,
  resolveTreeFocusPlan,
  searchTreePeople,
} from './archivalTreeModel.js';

function makePerson(overrides: Partial<Person> & Pick<Person, 'id' | 'slug' | 'full_name'>): Person {
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
      ]
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
    const byGen = new Map<number, (typeof layout.nodes)[number][]>();
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
        model.spouseMap
      )
    ).toBe(false);

    const layout = computeArchivalDiagramLayout(model);
    expect(layout.byId.has('p_infant_1')).toBe(false);
    expect(layout.earlyLossStrips).toHaveLength(1);
    expect(layout.earlyLossStrips[0].chips.map((c) => c.person.id)).toEqual(['p_infant_1', 'p_infant_2']);
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
      (u) => u.primaryPartnerId === 'p_arthur' && u.secondaryPartnerId === 'p_clara'
    )!;
    expect(marriageOne.visibleChildIds).toEqual(['p_henry']);
    expect(marriageOne.collapsedSiblingIds).toEqual(['p_sib_1', 'p_sib_2', 'p_sib_3', 'p_sib_4']);

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

  it('filters living people out of public search, ranks matches, and resolves focus plans for collapsed siblings', () => {
    const { people, kinship } = buildSyntheticFamilyFixture();
    const model = buildArchivalTreeModel({
      people,
      kinship,
      branchFilter: 'hale_line',
      defaultBranchId: 'hale_line',
      mode: 'full',
    });
    const branchLabelsById = new Map([
      ['hale_line', 'Hale Line'],
      ['vance_line', 'Vance Line'],
    ]);

    // Public mode strictly excludes both redacted Living placeholders and any is_living record
    expect(isTreeSearchEligible(people.find((p) => p.id === 'p_living_redacted')!, 'public')).toBe(false);
    expect(isTreeSearchEligible(people.find((p) => p.id === 'p_living_named')!, 'public')).toBe(false);
    expect(isTreeSearchEligible(people.find((p) => p.id === 'p_living_redacted')!, 'private')).toBe(false);
    expect(isTreeSearchEligible(people.find((p) => p.id === 'p_living_named')!, 'private')).toBe(true);

    const livingQueryPublic = searchTreePeople({
      query: 'Rowan',
      people,
      buildMode: 'public',
      model,
      branchFilter: 'hale_line',
      defaultBranchId: 'hale_line',
      branchLabelsById,
    });
    expect(livingQueryPublic).toHaveLength(0);

    const livingPlaceholderQuery = searchTreePeople({
      query: 'Living',
      people,
      buildMode: 'private',
      model,
      branchFilter: 'hale_line',
      defaultBranchId: 'hale_line',
      branchLabelsById,
    });
    expect(livingPlaceholderQuery).toHaveLength(0);

    // Collapsed sibling Martha Hale is discoverable and flagged as collapsed
    const marthaResults = searchTreePeople({
      query: 'Martha',
      people,
      buildMode: 'public',
      model,
      branchFilter: 'hale_line',
      defaultBranchId: 'hale_line',
      branchLabelsById,
    });
    expect(marthaResults).toHaveLength(1);
    expect(marthaResults[0].person.id).toBe('p_sib_1');
    expect(marthaResults[0].isCollapsed).toBe(true);

    const marthaPlan = resolveTreeFocusPlan({
      person: marthaResults[0].person,
      model,
      currentBranchFilter: 'hale_line',
      defaultBranchId: 'hale_line',
      currentMode: 'full',
    });
    expect(marthaPlan.expandUnionIds).toHaveLength(1);
    expect(marthaPlan.nextBranchFilter).toBe('hale_line');
    expect(marthaPlan.nextMode).toBe('full');

    // Cross-branch match resets branch filter to 'all'
    const vanceResults = searchTreePeople({
      query: 'Owen Vance',
      people,
      buildMode: 'public',
      model,
      branchFilter: 'hale_line',
      defaultBranchId: 'hale_line',
      branchLabelsById,
    });
    expect(vanceResults).toHaveLength(1);
    expect(vanceResults[0].isOutsideCurrentBranch).toBe(true);
    const vancePlan = resolveTreeFocusPlan({
      person: vanceResults[0].person,
      model,
      currentBranchFilter: 'hale_line',
      defaultBranchId: 'hale_line',
      currentMode: 'full',
    });
    expect(vancePlan.nextBranchFilter).toBe('all');
  });
});

describe('Multi-component generation alignment and orthogonal obstacle detour routing', () => {
  it('aligns disconnected components, isolated relatives, and empty models deterministically', () => {
    const emptyModel = buildArchivalTreeModel({
      people: [],
      kinship: [],
      branchFilter: 'all',
      mode: 'full',
    });
    const emptyLayout = computeArchivalDiagramLayout(emptyModel);
    expect(emptyLayout.nodes).toEqual([]);
    expect(emptyLayout.buses).toEqual([]);

    const people: Person[] = [
      // Component 1: 3 generations (1820 -> 1850 -> 1880)
      makePerson({
        id: 'p_c1_g0_a',
        slug: 'arthur-alder-1820',
        full_name: 'Arthur Alder',
        birth_year: 1820,
        death_year: 1890,
        lineage_group: 'ancestor',
      }),
      makePerson({
        id: 'p_c1_g0_b',
        slug: 'clara-mercer-1824',
        full_name: 'Clara Mercer',
        birth_year: 1824,
        death_year: 1894,
        lineage_group: 'ancestor',
      }),
      makePerson({
        id: 'p_c1_g1_a',
        slug: 'henry-alder-1850',
        full_name: 'Henry Alder',
        birth_year: 1850,
        death_year: 1922,
        lineage_group: 'pivot_ancestor',
      }),
      makePerson({
        id: 'p_c1_g2_a',
        slug: 'edith-alder-1880',
        full_name: 'Edith Alder',
        birth_year: 1880,
        death_year: 1955,
        lineage_group: 'descendant',
      }),
      // Component 2: disconnected older couple (1790 -> 1820) forcing negative shift normalization
      makePerson({
        id: 'p_c2_g0',
        slug: 'thomas-bramwell-1790',
        full_name: 'Thomas Bramwell',
        birth_year: 1790,
        death_year: 1860,
        lineage_group: 'collateral',
      }),
      makePerson({
        id: 'p_c2_g1',
        slug: 'martha-bramwell-1820',
        full_name: 'Martha Bramwell',
        birth_year: 1820,
        death_year: 1888,
        lineage_group: 'collateral',
      }),
      // Isolated person aligned via birth year (1852)
      makePerson({
        id: 'p_iso_dated',
        slug: 'owen-hale-1852',
        full_name: 'Owen Hale',
        birth_year: 1852,
        death_year: 1920,
        lineage_group: 'collateral',
      }),
      // Isolated person aligned via hidden spouse whose parent is visible
      makePerson({
        id: 'p_iso_via_hidden',
        slug: 'nora-linden',
        full_name: 'Nora Linden',
        birth_year: null,
        death_year: 1930,
        lineage_group: 'collateral',
      }),
      // Hidden living spouse (filtered out of branchPeople because redacted placeholder)
      makePerson({
        id: 'p_hidden_spouse',
        slug: 'living-alder',
        full_name: 'Living',
        given_name: 'Living',
        surname: '',
        is_living: true,
        birth_year: null,
        death_year: null,
        lineage_group: 'descendant',
      }),
    ];

    const kinship: KinshipEdge[] = [
      { from: 'p_c1_g0_a', to: 'p_c1_g0_b', relation: 'spouse' },
      { from: 'p_c1_g0_a', to: 'p_c1_g1_a', relation: 'parent' },
      { from: 'p_c1_g0_b', to: 'p_c1_g1_a', relation: 'parent' },
      { from: 'p_c1_g1_a', to: 'p_c1_g2_a', relation: 'parent' },
      { from: 'p_c2_g0', to: 'p_c2_g1', relation: 'parent' },
      { from: 'p_c1_g1_a', to: 'p_hidden_spouse', relation: 'parent' },
      { from: 'p_hidden_spouse', to: 'p_iso_via_hidden', relation: 'spouse' },
    ];

    const model = buildArchivalTreeModel({
      people,
      kinship,
      branchFilter: 'all',
      mode: 'full',
    });

    // Older disconnected ancestor shifts before component 1, then min normalizes to 0
    expect(model.genByPersonId.get('p_c2_g0')).toBe(0);
    expect(model.genByPersonId.get('p_c1_g0_a')).toBe(1);
    expect(model.genByPersonId.get('p_c1_g1_a')).toBe(2);
    expect(model.genByPersonId.get('p_iso_dated')).toBe(2);
    expect(model.genByPersonId.get('p_iso_via_hidden')).toBe(3);

    const layout = computeArchivalDiagramLayout(model);
    expect(layout.nodes.length).toBeGreaterThanOrEqual(8);
    expect(layout.bounds.maxX).toBeGreaterThanOrEqual(640);
    expect(layout.bounds.maxY).toBeGreaterThanOrEqual(420);
  });

  it('routes orthogonal stems and child drops around early-loss strips, sibling toggles, and expanded hanging grids', () => {
    const people: Person[] = [
      makePerson({
        id: 'p_dad',
        slug: 'arthur-alder-1840',
        full_name: 'Arthur Alder',
        birth_year: 1840,
        death_year: 1910,
        lineage_group: 'ancestor',
      }),
      makePerson({
        id: 'p_mom',
        slug: 'clara-mercer-1844',
        full_name: 'Clara Mercer',
        birth_year: 1844,
        death_year: 1912,
        lineage_group: 'ancestor',
      }),
      // Early-loss child (died age 2)
      makePerson({
        id: 'p_early_1',
        slug: 'infant-alder-1865',
        full_name: 'Infant Alder',
        birth_year: 1865,
        death_year: 1867,
        lineage_group: 'collateral',
      }),
      // Direct visible child continuing to next generation
      makePerson({
        id: 'p_heir',
        slug: 'william-alder-1868',
        full_name: 'William Alder',
        birth_year: 1868,
        death_year: 1940,
        lineage_group: 'pivot_ancestor',
      }),
      // 4 collateral leaves so union triggers sibling toggle + hanging grid when expanded
      ...Array.from({ length: 4 }, (_, idx) =>
        makePerson({
          id: `p_leaf_${idx}`,
          slug: `sibling-alder-${1870 + idx}`,
          full_name: `Sibling ${idx} Alder`,
          birth_year: 1870 + idx,
          death_year: 1945 + idx,
          lineage_group: 'collateral',
        })
      ),
      // Grandchild under p_heir
      makePerson({
        id: 'p_grandchild',
        slug: 'edward-alder-1896',
        full_name: 'Edward Alder',
        birth_year: 1896,
        death_year: 1970,
        lineage_group: 'descendant',
      }),
    ];

    const kinship: KinshipEdge[] = [
      { from: 'p_dad', to: 'p_mom', relation: 'spouse' },
      { from: 'p_dad', to: 'p_early_1', relation: 'parent' },
      { from: 'p_mom', to: 'p_early_1', relation: 'parent' },
      { from: 'p_dad', to: 'p_heir', relation: 'parent' },
      { from: 'p_mom', to: 'p_heir', relation: 'parent' },
      ...Array.from({ length: 4 }, (_, idx) => [
        { from: 'p_dad', to: `p_leaf_${idx}`, relation: 'parent' as const },
        { from: 'p_mom', to: `p_leaf_${idx}`, relation: 'parent' as const },
      ]).flat(),
      { from: 'p_heir', to: 'p_grandchild', relation: 'parent' },
    ];

    const collapsedModel = buildArchivalTreeModel({
      people,
      kinship,
      branchFilter: 'all',
      mode: 'full',
    });
    const coupleUnion = collapsedModel.unions.find((u) => u.kind === 'couple');
    expect(coupleUnion).toBeDefined();

    const expandedModel = buildArchivalTreeModel({
      people,
      kinship,
      branchFilter: 'all',
      mode: 'full',
      expandedUnionIds: new Set(coupleUnion ? [coupleUnion.id] : []),
    });
    const layout = computeArchivalDiagramLayout(expandedModel);

    expect(layout.earlyLossStrips).toHaveLength(1);
    expect(layout.siblingToggles).toHaveLength(1);
    expect(layout.hangingRails).toHaveLength(1);
    expect(layout.buses.length).toBeGreaterThanOrEqual(2);
    // Stem from couple union detours cleanly around the early-loss strip / sibling toggle / hanging grid
    const coupleBus = layout.buses.find((b) => b.unionId === coupleUnion?.id);
    expect(coupleBus?.stemPoints.length).toBeGreaterThanOrEqual(2);
  });

  it('separates parallel inter-generation bus lanes by >= 12px, places Died-young strips laterally with zero U-bend stems, and sizes chips to fill the strip width (#79)', () => {
    const people: Person[] = [
      makePerson({
        id: 'p_a1',
        slug: 'a1',
        full_name: 'Arthur Alder',
        lineage_group: 'ancestor',
        birth_year: 1810,
        death_year: 1882,
      }),
      makePerson({
        id: 'p_a2',
        slug: 'a2',
        full_name: 'Beatrice Finch',
        lineage_group: 'ancestor',
        birth_year: 1814,
        death_year: 1886,
      }),
      makePerson({
        id: 'p_b1',
        slug: 'b1',
        full_name: 'Charles Brent',
        lineage_group: 'collateral',
        birth_year: 1812,
        death_year: 1884,
      }),
      makePerson({
        id: 'p_b2',
        slug: 'b2',
        full_name: 'Dora Mercer',
        lineage_group: 'collateral',
        birth_year: 1816,
        death_year: 1890,
      }),
      makePerson({
        id: 'p_c1',
        slug: 'c1',
        full_name: 'Edmund Vance',
        lineage_group: 'collateral',
        birth_year: 1815,
        death_year: 1885,
      }),
      makePerson({
        id: 'p_c2',
        slug: 'c2',
        full_name: 'Flora Hale',
        lineage_group: 'collateral',
        birth_year: 1818,
        death_year: 1892,
      }),
      // Early-loss child with long given name + lifespan on union A
      makePerson({
        id: 'p_early_edward',
        slug: 'edward-benjamin-alder',
        full_name: 'Edward Benjamin Alder',
        given_name: 'Edward Benjamin',
        lineage_group: 'collateral',
        birth_year: 1846,
        death_year: 1848,
      }),
      // Generation 2 children across all 3 parallel unions
      makePerson({
        id: 'p_ch_a1',
        slug: 'ch-a1',
        full_name: 'Henry Alder',
        lineage_group: 'pivot_ancestor',
        birth_year: 1842,
        death_year: 1918,
      }),
      makePerson({
        id: 'p_ch_a2',
        slug: 'ch-a2',
        full_name: 'Clara Alder',
        lineage_group: 'collateral',
        birth_year: 1844,
        death_year: 1910,
      }),
      makePerson({
        id: 'p_ch_b1',
        slug: 'ch-b1',
        full_name: 'Samuel Brent',
        lineage_group: 'collateral',
        birth_year: 1843,
        death_year: 1912,
      }),
      makePerson({
        id: 'p_ch_b2',
        slug: 'ch-b2',
        full_name: 'Martha Brent',
        lineage_group: 'collateral',
        birth_year: 1845,
        death_year: 1915,
      }),
      makePerson({
        id: 'p_ch_c1',
        slug: 'ch-c1',
        full_name: 'Walter Vance',
        lineage_group: 'collateral',
        birth_year: 1847,
        death_year: 1920,
      }),
    ];
    const kinship: KinshipEdge[] = [
      { from: 'p_a1', to: 'p_a2', relation: 'spouse' },
      { from: 'p_b1', to: 'p_b2', relation: 'spouse' },
      { from: 'p_c1', to: 'p_c2', relation: 'spouse' },
      { from: 'p_a1', to: 'p_early_edward', relation: 'parent' },
      { from: 'p_a2', to: 'p_early_edward', relation: 'parent' },
      { from: 'p_a1', to: 'p_ch_a1', relation: 'parent' },
      { from: 'p_a2', to: 'p_ch_a1', relation: 'parent' },
      { from: 'p_a1', to: 'p_ch_a2', relation: 'parent' },
      { from: 'p_a2', to: 'p_ch_a2', relation: 'parent' },
      { from: 'p_b1', to: 'p_ch_b1', relation: 'parent' },
      { from: 'p_b2', to: 'p_ch_b1', relation: 'parent' },
      { from: 'p_b1', to: 'p_ch_b2', relation: 'parent' },
      { from: 'p_b2', to: 'p_ch_b2', relation: 'parent' },
      { from: 'p_c1', to: 'p_ch_c1', relation: 'parent' },
      { from: 'p_c2', to: 'p_ch_c1', relation: 'parent' },
    ];

    const model = buildArchivalTreeModel({ people, kinship, branchFilter: 'all', mode: 'full' });
    const layout = computeArchivalDiagramLayout(model);

    // 1. All 3 sibling buses in generation 0 have strictly distinct lanes >= 12px apart
    const gen0Buses = layout.buses
      .filter((b) => model.unionsById.get(b.unionId)?.gen === 0)
      .toSorted((a, b) => a.busY - b.busY);
    expect(gen0Buses).toHaveLength(3);
    for (let i = 1; i < gen0Buses.length; i += 1) {
      expect(gen0Buses[i].busY - gen0Buses[i - 1].busY).toBeGreaterThanOrEqual(12);
    }

    // 2. Died-young strip sits laterally clear of union A's vertical stem -> straight 2-point stem (0 U-bends)
    expect(layout.earlyLossStrips).toHaveLength(1);
    const strip = layout.earlyLossStrips[0];
    const unionABus = layout.buses.find((b) => b.unionId === strip.unionId);
    expect(unionABus).toBeDefined();
    expect(strip.x).toBeGreaterThanOrEqual((unionABus?.hubX ?? 0) + 12);
    expect(unionABus?.stemPoints).toHaveLength(2);
    expect(unionABus?.stemPoints[0].x).toBe(unionABus?.stemPoints[1].x);

    // 3. Single chip inside Died-young strip spans full inner box width (170px inside 194px strip)
    expect(strip.chips).toHaveLength(1);
    const chip = strip.chips[0];
    expect(chip.width).toBe(strip.width - 24);
    expect(chip.width).toBeGreaterThanOrEqual(170);
  });
});
