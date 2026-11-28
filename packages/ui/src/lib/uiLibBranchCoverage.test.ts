import type {
  ArchiveAuthProviders,
  ArchiveCapabilities,
  ArchiveEvent,
  KinshipEdge,
  MediaItem,
  Person,
  Place,
} from '@kinloom/core';
import { asBatchId, asRevisionId, compileArchive, parseKinloomConfig } from '@kinloom/core';
import type { StyleSpecification } from 'maplibre-gl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createActor, fromPromise } from 'xstate';
import {
  parseEntityGetResponse,
  parseGeneratedPronunciationAudioResponse,
  parseRevisionListResponse,
  parseSessionResponse,
  parseUpsertPronunciationTermResponse,
} from '../adapters/httpWiki/responseParsers.js';
import { createHttpWikiDataSource } from '../adapters/httpWikiDataSource.js';
import {
  buildArchivalOhmStyle,
  loadArchivalOhmStyle,
  OHM_STYLE_URL,
  OVERVIEW_REFERENCE_YEAR,
  PAPER_LAND_LAYER_ID,
  resetCachedOhmStyle,
} from '../browser/ohmStyle.js';
import { formatDurationSeconds, isAudioMedia, isPdfMedia, isVideoMedia } from '../components/MediaPlayer.js';
import { hasPronunciationContent, isEnglishPronunciationLanguage } from '../components/PronunciationBadge.js';
import {
  type AuthErrorCode,
  normalizeAuthErrorCode,
  normalizeAuthProvider,
  resolveAuthFeedback,
} from '../components/wiki/authError/feedbackCatalog.js';
import {
  buildPersonCreatePayload,
  ENTITY_CREATE_FORM_REGISTRY,
  resolveCreateFormRegistry,
} from '../components/wiki/entityForms/createRegistry.js';
import {
  asString,
  asStringArray,
  createInitialEntityDraft,
  parseKinshipRelation,
  parsePersonLineageGroup,
  parsePersonSex,
  slugify,
} from '../components/wiki/entityForms/fieldTypes.js';
import {
  createStaticArchiveLoader,
  DEFAULT_ARCHIVE_CAPABILITIES,
  normalizeBaseUrl,
  normalizeCapabilities,
  normalizeSessionProp,
  wrapLegacyLoader,
} from '../context/archiveDataHelpers.js';
import {
  type AuthSessionSnapshotLike,
  buildHydratedPatch,
  deriveSessionFromAuthSnapshot,
  formatAuthErrorMessage,
} from '../machines/authSession/reducers.js';
import type { AuthSessionContext } from '../machines/authSession/types.js';
import {
  buildEntityTargetPatch,
  buildOpenEditPatch,
  buildPendingLeavePatch,
  buildRebasePatch,
  collectValidationErrors,
  createInitialEntityEditorContext,
} from '../machines/entityEditor/reducers.js';
import {
  defaultAttachMediaActor,
  defaultUploadMediaActor,
  readAttachOutput,
  readUploadOutput,
} from '../machines/mediaUpload/actors.js';
import { mediaUploadMachine } from '../machines/mediaUploadMachine.js';
import {
  buildImmediateFamily,
  buildTimelineScrubberTicks,
  collectPersonMedia,
  resolvePortraitLightboxState,
} from '../pages/person/personViewModel.js';
import {
  buildPlaceOccupancySummary,
  buildPlacePhotoMedia,
  collectPlaceLocalRecords,
  collectRecordDecades,
  resolveMatchingPlaceIds,
} from '../pages/place/placeViewModel.js';
import { computeArchivalDiagramLayout } from './tree/diagramLayout.js';
import { addUnique, inferGenerations } from './tree/generationInference.js';
import {
  computeLineageSpotlight,
  findCollapsedUnionForPerson,
  isPersonVisibleOnCurrentSurface,
  isTreeSearchEligible,
  resolveTreeFocusPlan,
  searchTreePeople,
} from './tree/treeProjections.js';
import {
  type ArchivalTreeModel,
  formatUnionOtherChildrenLabel,
  type TreeFamilyUnit,
  type TreeGenerationGroup,
  type TreeUnion,
  toRomanNumeral,
} from './tree/types.js';
import {
  buildGenerationGroups,
  buildUnionDrafts,
  computeMarriageOrderByUnionId,
  pickUnionPairKey,
  type UnionDraft,
} from './tree/unionAssembly.js';
import { formatLineageGroupLabel, formatTreeCardName, formatTreeCardPlace } from './treeNodeDisplay.js';

function makePerson(overrides: Partial<Person> & { id: string; full_name: string }): Person {
  const parts = overrides.full_name.trim().split(/\s+/);
  return {
    slug: overrides.id.replaceAll('_', '-'),
    given_name: parts[0] ?? overrides.full_name,
    surname: parts.slice(1).join(' '),
    alt_names: [],
    sex: 'U',
    is_living: false,
    lineage_group: 'collateral',
    branch: 'alder',
    birth_edtf: '',
    death_edtf: '',
    birth_year: null,
    death_year: null,
    primary_place_id: null,
    portrait_url: null,
    event_count: 0,
    media_count: 0,
    ...overrides,
  };
}

function makeMedia(overrides: Partial<MediaItem> = {}): MediaItem {
  return {
    id: 'med_sample',
    kind: 'family_photo',
    file: '/media/sample.jpg',
    caption: 'Sample Harbor Photo',
    date_edtf: '1890',
    person_ids: [],
    source_id: null,
    ...overrides,
  };
}

afterEach(() => {
  resetCachedOhmStyle();
  vi.restoreAllMocks();
});

describe('unionAssembly branch coverage', () => {
  it('orders couple keys and handles single-parent keys', () => {
    expect(pickUnionPairKey('per_b', null)).toBe('single:per_b');
    expect(pickUnionPairKey('per_a', 'per_b')).toBe('couple:per_a+per_b');
    expect(pickUnionPairKey('per_z', 'per_a')).toBe('couple:per_a+per_z');
  });

  it('builds union drafts across cross-gen spouses, direct-line swaps, spouse counts, and parent fallbacks', () => {
    const pA = makePerson({ id: 'per_a', full_name: 'Arthur Alder', birth_year: 1850 });
    const pB = makePerson({ id: 'per_b', full_name: 'Beatrice Birch', birth_year: 1852 });
    const pC = makePerson({ id: 'per_c', full_name: 'Caleb Cedar', birth_year: 1854 });
    const pD = makePerson({ id: 'per_d', full_name: 'Dora Mercer', birth_year: 1856 });
    const pE = makePerson({ id: 'per_e', full_name: 'Ezra Harbor', birth_year: 1880 });
    const pF = makePerson({ id: 'per_f', full_name: 'Flora Alder', birth_year: 1882 });
    const pG = makePerson({ id: 'per_g', full_name: 'Gideon Alder', birth_year: 1884 });
    const pH = makePerson({ id: 'per_h', full_name: 'Hannah Alder', birth_year: 1886 });
    const pUnmapped = makePerson({ id: 'per_unmapped', full_name: 'Ulysses Alder', birth_year: null });
    const pChildUnmapped = makePerson({
      id: 'per_child_unmapped',
      full_name: 'Vera Alder',
      birth_year: null,
    });

    const genByPersonId = new Map<string, number>([
      ['per_a', 0],
      ['per_b', 0],
      ['per_c', 0],
      ['per_d', 0],
      ['per_e', 1],
      ['per_f', 1],
      ['per_g', 1],
      ['per_h', 1],
    ]);

    const spouseMap = new Map<string, string[]>([
      // pA (non-direct) married to pB (direct) -> triggers !aDirect && bDirect
      ['per_a', ['per_b', 'per_e']], // per_e is gen 1 (cross-gen skip!)
      ['per_b', ['per_a']],
      // pC and pD both non-direct, pD has 2 spouses while pC has 1 -> spCountB > spCountA
      ['per_c', ['per_d']],
      ['per_d', ['per_c', 'per_unmapped']],
      // per_unmapped has no gen entry (falls back to 0) and spouse per_d
      ['per_unmapped', ['per_d']],
    ]);

    const parentMap = new Map<string, string[]>([
      // pE has parents (per_a, per_b) whose couple union already exists
      ['per_e', ['per_a', 'per_b']],
      // pF has parents (per_c, per_b) NOT spouses, same gen, p1 (per_b) is direct and p0 is not -> !p0Direct && p1Direct
      ['per_f', ['per_c', 'per_b']],
      // pG has parents (per_a, per_e) in DIFFERENT generations -> falls back to single_parent using first non-direct pids[0]
      ['per_g', ['per_a', 'per_e']],
      // pH has 2 parents (per_a, per_e) where neither is in unionDrafts; second child reuses existing single_parent draft
      ['per_h', ['per_a', 'per_e']],
      // pChildUnmapped has unmapped parents (per_unmapped, per_child_unmapped) with no gen entries -> gen fallback 0
      ['per_child_unmapped', ['per_unmapped']],
    ]);

    const directPersonIds = new Set<string>(['per_b']);

    const drafts = buildUnionDrafts({
      branchPeople: [pA, pB, pC, pD, pE, pF, pG, pH, pUnmapped, pChildUnmapped],
      genByPersonId,
      parentMap,
      spouseMap,
      directPersonIds,
    });

    expect(drafts.get('couple:per_a+per_b')?.aId).toBe('per_b');
    expect(drafts.get('couple:per_a+per_b')?.childIds).toEqual(['per_e']);
    expect(drafts.get('couple:per_c+per_d')?.aId).toBe('per_d');
    expect(drafts.get('couple:per_b+per_c')?.aId).toBe('per_b');
    expect(drafts.get('couple:per_b+per_c')?.bId).toBe('per_c');
    expect(drafts.get('single:per_a')?.childIds).toEqual(['per_g', 'per_h']);
    expect(drafts.get('single:per_unmapped')?.gen).toBe(0);
    expect(drafts.has('couple:per_a+per_e')).toBe(false);
  });

  it('orders multiple marriages by earliest child year and falls back to spouse birth year', () => {
    const primary = makePerson({ id: 'per_m', full_name: 'Martin Alder', birth_year: 1840 });
    const sp1 = makePerson({ id: 'per_s1', full_name: 'Nora Mercer', birth_year: 1848 });
    const sp2 = makePerson({ id: 'per_s2', full_name: 'Olive Birch', birth_year: 1842 });
    const sp3 = makePerson({ id: 'per_s3', full_name: 'Pearl Cedar', birth_year: null });
    const childEarly = makePerson({ id: 'per_c1', full_name: 'Quinn Alder', birth_year: 1868 });
    const childLate = makePerson({ id: 'per_c2', full_name: 'Rosa Alder', birth_year: 1875 });

    const peopleById = new Map<string, Person>([
      [primary.id, primary],
      [sp1.id, sp1],
      [sp2.id, sp2],
      [sp3.id, sp3],
      [childEarly.id, childEarly],
      [childLate.id, childLate],
    ]);

    const drafts = new Map<string, UnionDraft>([
      ['u_late', { id: 'u_late', kind: 'couple', aId: 'per_m', bId: 'per_s1', gen: 0, childIds: ['per_c2'] }],
      [
        'u_early',
        { id: 'u_early', kind: 'couple', aId: 'per_m', bId: 'per_s2', gen: 0, childIds: ['per_c1'] },
      ],
      [
        'u_nochild_a',
        { id: 'u_nochild_a', kind: 'couple', aId: 'per_m', bId: 'per_s3', gen: 0, childIds: [] },
      ],
      ['u_nochild_b', { id: 'u_nochild_b', kind: 'couple', aId: 'per_m', bId: null, gen: 0, childIds: [] }],
      ['u_single', { id: 'u_single', kind: 'single_parent', aId: 'per_m', bId: null, gen: 0, childIds: [] }],
    ]);

    const order = computeMarriageOrderByUnionId(drafts, peopleById);
    expect(order.get('u_early')).toEqual({ order: 1, total: 4 });
    expect(order.get('u_late')).toEqual({ order: 2, total: 4 });
    expect(order.get('u_nochild_a')?.total).toBe(4);
    expect(order.has('u_single')).toBe(false);
  });

  it('builds generation groups with 2-spouse center anchor, missing birth years, and empty gen ranks', () => {
    const anchor = makePerson({ id: 'per_anchor', full_name: 'Arthur Alder', birth_year: null });
    const sp1 = makePerson({ id: 'per_sp1', full_name: 'Clara Birch', birth_year: null });
    const sp2 = makePerson({ id: 'per_sp2', full_name: 'Dora Cedar', birth_year: null });
    const coll = makePerson({ id: 'per_coll', full_name: 'Owen Mercer', birth_year: null });

    const unions: TreeUnion[] = [
      {
        id: 'u1',
        kind: 'couple',
        primaryPartnerId: 'per_anchor',
        secondaryPartnerId: 'per_sp1',
        partnerIds: ['per_anchor', 'per_sp1'],
        marriageOrder: 1,
        totalMarriagesForPrimary: 2,
        gen: 0,
        isDirect: true,
        allChildIds: [],
        visibleChildIds: [],
        hangingChildIds: [],
        collapsedSiblingIds: [],
        earlyLossChildIds: [],
        isExpanded: false,
      },
      {
        id: 'u2',
        kind: 'couple',
        primaryPartnerId: 'per_sp2',
        secondaryPartnerId: 'per_anchor',
        partnerIds: ['per_sp2', 'per_anchor'],
        marriageOrder: 2,
        totalMarriagesForPrimary: 2,
        gen: 0,
        isDirect: true,
        allChildIds: [],
        visibleChildIds: [],
        hangingChildIds: [],
        collapsedSiblingIds: [],
        earlyLossChildIds: [],
        isExpanded: false,
      },
      // Union in gen 1 with no rankPeople in gen 1 (tests rankByGen.get(g) ?? [])
      {
        id: 'u_empty_gen',
        kind: 'single_parent',
        primaryPartnerId: 'per_ghost',
        secondaryPartnerId: null,
        partnerIds: ['per_ghost'],
        marriageOrder: 1,
        totalMarriagesForPrimary: 1,
        gen: 1,
        isDirect: false,
        allChildIds: [],
        visibleChildIds: [],
        hangingChildIds: [],
        collapsedSiblingIds: [],
        earlyLossChildIds: [],
        isExpanded: false,
      },
    ];

    const { generations, unitsById } = buildGenerationGroups({
      rankPeople: [coll, sp1, anchor, sp2],
      unions,
      genByPersonId: new Map([
        ['per_anchor', 0],
        ['per_sp1', 0],
        ['per_sp2', 0],
        // per_coll omitted -> falls back to 0
      ]),
      spouseMap: new Map([
        ['per_anchor', ['per_sp1', 'per_sp2']],
        ['per_sp1', ['per_anchor']],
        ['per_sp2', ['per_anchor']],
      ]),
      directPersonIds: new Set(['per_anchor']),
    });

    expect(generations).toHaveLength(1);
    expect(generations[0].yearRange).toBe('Gen 1');
    expect(generations.every((g) => g.units.length > 0 && g.personIds.length > 0)).toBe(true);
    const anchorUnit = unitsById.get('per_sp1+per_anchor+per_sp2');
    expect(anchorUnit?.orderedMemberIds).toEqual(['per_sp1', 'per_anchor', 'per_sp2']);
  });
});

describe('diagramLayout branch coverage', () => {
  it('returns empty default layout when generations are empty', () => {
    const emptyModel: ArchivalTreeModel = {
      mode: 'full',
      effectiveMode: 'full',
      peopleById: new Map(),
      visiblePeople: [],
      totalVisibleCount: 0,
      directSpineCount: 0,
      generations: [],
      unions: [],
      unionsById: new Map(),
      unitsById: new Map(),
      genByPersonId: new Map(),
      parentMap: new Map(),
      childMap: new Map(),
      spouseMap: new Map(),
      earlyLossIds: new Set(),
      directPersonIds: new Set(),
      pivotPersonId: null,
      anchorPersonId: null,
    };
    const layout = computeArchivalDiagramLayout(emptyModel);
    expect(layout.nodes).toHaveLength(0);
    expect(layout.bounds.maxX).toBe(960);
  });

  it('handles crossing sweeps, 1-col & 2-col hanging grids, stacked unions, early loss chips, and defensive missing ids', () => {
    const p1 = makePerson({ id: 'p1', full_name: 'Arthur Alder', birth_year: 1840 });
    const p2 = makePerson({ id: 'p2', full_name: 'Beatrice Alder', birth_year: 1842 });
    const p3 = makePerson({ id: 'p3', full_name: 'Clara Birch', birth_year: 1845 });
    const c1 = makePerson({ id: 'c1', full_name: 'Daniel Alder', birth_year: 1870 });
    const c2 = makePerson({ id: 'c2', full_name: 'Eleanor Alder', birth_year: 1872 });
    const h1 = makePerson({ id: 'h1', full_name: 'Frank Alder', birth_year: 1874 });
    const h2 = makePerson({ id: 'h2', full_name: 'Grace Alder', birth_year: 1876 });
    const h3 = makePerson({ id: 'h3', full_name: 'Helen Alder', birth_year: 1878 });
    const early1 = makePerson({ id: 'e1', full_name: 'Infant Alder', birth_year: 1871, death_year: 1872 });

    const people = [p1, p2, p3, c1, c2, h1, h2, h3, early1];
    const peopleById = new Map(people.map((p) => [p.id, p]));

    // Union 1: couple p2+p1 (primary p2 is to the right of secondary p1), 1 hanging child + early loss (with a missing child id) + visible child (with a missing child id)
    const u1: TreeUnion = {
      id: 'u1',
      kind: 'couple',
      primaryPartnerId: 'p2',
      secondaryPartnerId: 'p1',
      partnerIds: ['p2', 'p1'],
      marriageOrder: 1,
      totalMarriagesForPrimary: 2,
      gen: 0,
      isDirect: true,
      allChildIds: ['c1', 'h1', 'e1'],
      visibleChildIds: ['c1', 'missing_child'],
      hangingChildIds: ['h1'],
      collapsedSiblingIds: [],
      earlyLossChildIds: ['e1', 'missing_early'],
      isExpanded: true,
    };
    // Union 2: same unit, 2+ hanging children (triggers priorHangingBottomY + 2-column grid + missing hanging id)
    const u2: TreeUnion = {
      id: 'u2',
      kind: 'couple',
      primaryPartnerId: 'p2',
      secondaryPartnerId: 'p3',
      partnerIds: ['p2', 'p3'],
      marriageOrder: 2,
      totalMarriagesForPrimary: 2,
      gen: 0,
      isDirect: false,
      allChildIds: ['h2', 'h3'],
      visibleChildIds: [],
      hangingChildIds: ['h2', 'h3', 'missing_hang'],
      collapsedSiblingIds: ['c2'],
      earlyLossChildIds: [],
      isExpanded: false,
    };
    // Union 3: single parent with missing primaryPartnerId
    const uMissingPrimary: TreeUnion = {
      id: 'u_missing_primary',
      kind: 'single_parent',
      primaryPartnerId: 'no_such_person',
      secondaryPartnerId: null,
      partnerIds: ['no_such_person'],
      marriageOrder: 1,
      totalMarriagesForPrimary: 1,
      gen: 0,
      isDirect: false,
      allChildIds: ['c2'],
      visibleChildIds: ['c2'],
      hangingChildIds: [],
      collapsedSiblingIds: [],
      earlyLossChildIds: [],
      isExpanded: false,
    };
    // Union 4: single parent valid, with visibleChildIds all missing (triggers childDrops.length === 0)
    const uAllMissingDrops: TreeUnion = {
      id: 'u_all_missing_drops',
      kind: 'single_parent',
      primaryPartnerId: 'c2',
      secondaryPartnerId: null,
      partnerIds: ['c2'],
      marriageOrder: 1,
      totalMarriagesForPrimary: 1,
      gen: 1,
      isDirect: false,
      allChildIds: ['ghost_1'],
      visibleChildIds: ['ghost_1'],
      hangingChildIds: [],
      collapsedSiblingIds: [],
      earlyLossChildIds: [],
      isExpanded: false,
    };

    const unitG0: TreeFamilyUnit = {
      id: 'unit_g0',
      gen: 0,
      anchorId: 'p2',
      orderedMemberIds: ['p1', 'p2', 'p3', 'missing_member'],
      unionIds: ['u1', 'u2', 'u_missing_primary', 'u_not_in_map'],
      isDirect: true,
    };
    const unitG1A: TreeFamilyUnit = {
      id: 'unit_g1_a',
      gen: 1,
      anchorId: 'c1',
      orderedMemberIds: ['c1'],
      unionIds: [],
      isDirect: true,
    };
    const unitG1B: TreeFamilyUnit = {
      id: 'unit_g1_b',
      gen: 1,
      anchorId: 'c2',
      orderedMemberIds: ['c2'],
      unionIds: ['u_all_missing_drops'],
      isDirect: false,
    };

    const gen0: TreeGenerationGroup = {
      gen: 0,
      label: 'G1',
      yearRange: '1840–1845',
      units: [unitG0],
      unions: [u1, u2, uMissingPrimary],
      personIds: ['p1', 'p2', 'p3'],
    };
    const gen1: TreeGenerationGroup = {
      gen: 1,
      label: 'G2',
      yearRange: '1870–1872',
      units: [unitG1B, unitG1A],
      unions: [uAllMissingDrops],
      personIds: ['c1', 'c2'],
    };

    const unions = [u1, u2, uMissingPrimary, uAllMissingDrops];
    const model: ArchivalTreeModel = {
      mode: 'spine',
      effectiveMode: 'spine',
      peopleById,
      visiblePeople: people,
      totalVisibleCount: people.length,
      directSpineCount: 3,
      generations: [gen0, gen1],
      unions,
      unionsById: new Map(unions.map((u) => [u.id, u])),
      unitsById: new Map([
        [unitG0.id, unitG0],
        [unitG1A.id, unitG1A],
        [unitG1B.id, unitG1B],
      ]),
      genByPersonId: new Map([
        ['p1', 0],
        ['p2', 0],
        ['p3', 0],
        ['c1', 1],
        ['c2', 1],
      ]),
      parentMap: new Map([
        ['c1', ['p1', 'p2', 'nonexistent_parent']],
        ['c2', []],
      ]),
      childMap: new Map([
        ['p1', ['c1', 'nonexistent_child']],
        ['p2', ['c1']],
      ]),
      spouseMap: new Map([
        ['p1', ['p2']],
        ['p2', ['p1', 'p3']],
        ['p3', ['p2']],
      ]),
      earlyLossIds: new Set(['e1']),
      directPersonIds: new Set(['p1', 'p2', 'c1']),
      pivotPersonId: 'c1',
      anchorPersonId: null,
    };

    const layout = computeArchivalDiagramLayout(model);
    expect(layout.hubs.length).toBe(3);
    expect(layout.buses.length).toBe(1);
    expect(layout.hangingRails.length).toBe(2);
    expect(layout.hangingRails[0].ticks).toHaveLength(0);
    expect(layout.hangingRails[1].ticks).toHaveLength(2);
    expect(layout.earlyLossStrips).toHaveLength(1);
    expect(layout.earlyLossStrips[0].chips).toHaveLength(1);
    expect(layout.siblingToggles).toHaveLength(2);
    expect(
      formatUnionOtherChildrenLabel({
        hiddenCount: 1,
        totalCollateralCount: 1,
        visibleChildCount: 0,
        isExpanded: false,
        mode: 'full',
      }).buttonLabel
    ).toBe('+1 child');
    expect(
      formatUnionOtherChildrenLabel({
        hiddenCount: 0,
        totalCollateralCount: 2,
        visibleChildCount: 0,
        isExpanded: true,
        mode: 'full',
      }).buttonLabel
    ).toBe('Hide 2 children');
    expect(toRomanNumeral(1)).toBe('I');
    expect(toRomanNumeral(9)).toBe('9');
  });
});

describe('treeProjections branch coverage', () => {
  it('covers lineage spotlight, eligibility, visibility, focus plan, and search scoring branches', () => {
    const siteConfig = parseKinloomConfig({
      site: { title: 'Alder Archive', familyName: 'Alder', gedcomSourceName: 'ALDER' },
      branches: [
        { id: 'alder', label: 'Alder Line' },
        { id: 'birch', label: 'Birch Line' },
      ],
    });
    const { bundle } = compileArchive({
      siteConfig,
      mode: 'public',
      places: [
        {
          id: 'pl_harbor',
          slug: 'harbor',
          name: 'Harbor',
          full_name: 'Harbor, Cedar County',
          place_type: 'town',
          parent_id: null,
          lat: 42.5,
          lng: -85.5,
        },
      ],
      sources: [],
      people: [
        {
          id: 'p_gp',
          slug: 'arthur-alder',
          full_name: 'Arthur Alder',
          given_name: 'Arthur',
          surname: 'Alder',
          alt_names: ['Artie'],
          sex: 'M',
          is_living: false,
          lineage_group: 'pivot_ancestor',
          branch: 'alder',
          birth_edtf: '1830',
          death_edtf: '1900',
          portrait_url: null,
        },
        {
          id: 'p_pa',
          slug: 'clara-alder',
          full_name: 'Clara Alder',
          given_name: 'Clara',
          surname: 'Alder',
          alt_names: ['Clarie Mercer'],
          sex: 'F',
          is_living: false,
          lineage_group: 'ancestor',
          branch: 'alder',
          birth_edtf: '1860',
          death_edtf: '1930',
          portrait_url: null,
        },
        {
          id: 'p_sp',
          slug: 'david-birch',
          full_name: 'David Birch',
          given_name: 'David',
          surname: 'Birch',
          alt_names: ['Davey'],
          sex: 'M',
          is_living: false,
          lineage_group: 'collateral',
          branch: 'birch',
          birth_edtf: '1858',
          death_edtf: '1928',
          portrait_url: null,
        },
        {
          id: 'p_ch',
          slug: 'ellen-alder',
          full_name: 'Ellen Alder',
          given_name: 'Ellen',
          surname: 'Alder',
          alt_names: [],
          sex: 'F',
          is_living: false,
          lineage_group: 'collateral',
          branch: 'alder',
          birth_edtf: '1888',
          death_edtf: '1965',
          portrait_url: null,
        },
        {
          id: 'p_early',
          slug: 'infant-alder',
          full_name: 'Infant Alder',
          given_name: 'Infant',
          surname: 'Alder',
          alt_names: [],
          sex: 'U',
          is_living: false,
          lineage_group: 'collateral',
          branch: 'alder',
          birth_edtf: '1890',
          death_edtf: '1891',
          portrait_url: null,
        },
        {
          id: 'p_hanging',
          slug: 'felix-alder',
          full_name: 'Felix Alder',
          given_name: 'Felix',
          surname: 'Alder',
          alt_names: ['F. Alder'],
          sex: 'M',
          is_living: false,
          lineage_group: 'collateral',
          branch: 'alder',
          birth_edtf: '1892',
          death_edtf: '1950',
          portrait_url: null,
        },
        {
          id: 'p_hidden',
          slug: 'greta-alder',
          full_name: 'Greta Alder',
          given_name: 'Greta',
          surname: 'Alder',
          alt_names: [],
          sex: 'F',
          is_living: false,
          lineage_group: 'collateral',
          branch: 'alder',
          birth_edtf: '1894',
          death_edtf: '1970',
          portrait_url: null,
        },
      ],
      events: [],
      kinship: [
        { from: 'p_gp', to: 'p_pa', relation: 'parent' },
        { from: 'p_pa', to: 'p_sp', relation: 'spouse' },
        { from: 'p_ch', to: 'p_pa', relation: 'child' },
      ],
      media: [],
      narratives: [],
    });

    const peopleById = new Map(bundle.people.map((p) => [p.id, p]));
    const placesById = new Map(bundle.places.map((pl) => [pl.id, pl]));
    const unionMain: TreeUnion = {
      id: 'couple:p_pa+p_sp',
      kind: 'couple',
      primaryPartnerId: 'p_pa',
      secondaryPartnerId: 'p_sp',
      partnerIds: ['p_pa', 'p_sp'],
      marriageOrder: 1,
      totalMarriagesForPrimary: 1,
      gen: 1,
      isDirect: true,
      allChildIds: ['p_ch', 'p_early', 'p_hanging'],
      visibleChildIds: [],
      hangingChildIds: ['p_hanging'],
      collapsedSiblingIds: ['p_ch'],
      earlyLossChildIds: ['p_early'],
      isExpanded: false,
    };

    const model: ArchivalTreeModel = {
      mode: 'spine',
      effectiveMode: 'spine',
      peopleById,
      visiblePeople: bundle.people,
      totalVisibleCount: bundle.people.length,
      directSpineCount: 2,
      generations: [
        { gen: 0, label: 'G1', yearRange: '1830–1830', units: [], unions: [], personIds: ['p_gp'] },
        {
          gen: 1,
          label: 'G2',
          yearRange: '1858–1860',
          units: [],
          unions: [unionMain],
          personIds: ['p_pa', 'p_sp'],
        },
      ],
      unions: [unionMain],
      unionsById: new Map([[unionMain.id, unionMain]]),
      unitsById: new Map(),
      genByPersonId: new Map([
        ['p_gp', 0],
        ['p_pa', 1],
        ['p_sp', 1],
        ['p_ch', 2],
      ]),
      parentMap: new Map([
        ['p_pa', ['p_gp']],
        ['p_ch', ['p_sp', 'p_pa']], // non-direct first, direct second
        ['p_hanging', ['p_sp']], // only non-direct parent
      ]),
      childMap: new Map([
        ['p_gp', ['p_pa']],
        ['p_pa', ['p_ch', 'p_hanging']],
        ['p_sp', ['p_ch']],
      ]),
      spouseMap: new Map([
        ['p_pa', ['p_sp']],
        ['p_sp', ['p_pa']],
      ]),
      earlyLossIds: new Set(['p_early']),
      directPersonIds: new Set(['p_gp', 'p_pa']),
      pivotPersonId: 'p_gp',
      anchorPersonId: null,
    };

    expect(computeLineageSpotlight({ selectedPersonId: 'unknown', model })).toBeNull();

    const spotChild = computeLineageSpotlight({
      selectedPersonId: 'p_ch',
      model,
      bundle,
      placesById,
    });
    expect(spotChild?.breadcrumb.map((p) => p.id)).toEqual(['p_gp', 'p_pa', 'p_ch']);
    expect(spotChild?.relationshipToPivot).toBeTruthy();
    expect(spotChild?.pivotName).toBe('Arthur Alder');

    const spotHang = computeLineageSpotlight({ selectedPersonId: 'p_hanging', model });
    expect(spotHang?.breadcrumb.map((p) => p.id)).toEqual(['p_sp', 'p_hanging']);

    // Eligibility checks
    expect(isTreeSearchEligible({ is_living: false, full_name: '   ' })).toBe(false);
    expect(isTreeSearchEligible({ is_living: true, full_name: 'Living' })).toBe(false);
    expect(isTreeSearchEligible({ is_living: true, full_name: 'Sam Alder' }, 'public')).toBe(false);
    expect(isTreeSearchEligible({ is_living: true, full_name: 'Sam Alder' }, 'private')).toBe(true);

    // Surface visibility checks
    expect(isPersonVisibleOnCurrentSurface('unknown', model)).toBe(false);
    expect(isPersonVisibleOnCurrentSurface('p_early', model)).toBe(true);
    expect(isPersonVisibleOnCurrentSurface('p_gp', model)).toBe(true);
    expect(isPersonVisibleOnCurrentSurface('p_hanging', model)).toBe(true);
    expect(isPersonVisibleOnCurrentSurface('p_hidden', model)).toBe(false);

    // Collapsed union + focus plans
    expect(findCollapsedUnionForPerson('p_ch', model)?.id).toBe('couple:p_pa+p_sp');
    const collapsedPerson = peopleById.get('p_ch');
    const hiddenPerson = peopleById.get('p_hidden');
    const birchPerson = peopleById.get('p_sp');
    const directPerson = peopleById.get('p_gp');
    expect(collapsedPerson && hiddenPerson && birchPerson && directPerson).toBeTruthy();
    if (collapsedPerson && hiddenPerson && birchPerson && directPerson) {
      expect(
        resolveTreeFocusPlan({
          person: collapsedPerson,
          model,
          currentBranchFilter: 'all',
          defaultBranchId: 'alder',
          currentMode: 'spine',
        })
      ).toEqual({ nextBranchFilter: 'all', nextMode: 'spine', expandUnionIds: ['couple:p_pa+p_sp'] });

      expect(
        resolveTreeFocusPlan({
          person: directPerson,
          model,
          currentBranchFilter: 'all',
          defaultBranchId: 'alder',
          currentMode: 'spine',
        })
      ).toEqual({ nextBranchFilter: 'all', nextMode: 'spine', expandUnionIds: [] });

      expect(
        resolveTreeFocusPlan({
          person: hiddenPerson,
          model,
          currentBranchFilter: 'all',
          defaultBranchId: 'alder',
          currentMode: 'spine',
        })
      ).toEqual({ nextBranchFilter: 'all', nextMode: 'full', expandUnionIds: [] });

      expect(
        resolveTreeFocusPlan({
          person: collapsedPerson,
          model,
          currentBranchFilter: 'birch',
          defaultBranchId: 'alder',
          currentMode: 'full',
        })
      ).toEqual({ nextBranchFilter: 'all', nextMode: 'full', expandUnionIds: ['couple:p_pa+p_sp'] });
    }

    // Search scoring across all branches (empty, exact, prefix, surname prefix, substring, alt name, year match)
    const branchLabels = new Map([['alder', 'Alder Line']]);
    const extraNoBranch = makePerson({
      id: 'p_nobranch',
      full_name: 'Nora Harbor',
      given_name: 'Nora',
      surname: 'Harbor',
      branch: '',
      alt_names: ['Nellie'],
      birth_year: null,
      death_year: null,
    });
    const livingPerson = makePerson({ id: 'p_living', full_name: 'Living', is_living: true });
    const allSearchPeople = [...bundle.people, extraNoBranch, livingPerson];

    const defaultRanked = searchTreePeople({
      query: '',
      people: allSearchPeople,
      buildMode: 'public',
      model,
      branchFilter: 'alder',
      defaultBranchId: 'alder',
      branchLabelsById: branchLabels,
    });
    expect(defaultRanked[0].person.id).toBe('p_gp');

    expect(
      searchTreePeople({
        query: 'Clara Alder',
        people: allSearchPeople,
        buildMode: 'public',
        model,
        branchFilter: 'all',
        defaultBranchId: 'alder',
        branchLabelsById: branchLabels,
      })[0].person.id
    ).toBe('p_pa');

    expect(
      searchTreePeople({
        query: 'Birch',
        people: allSearchPeople,
        buildMode: 'public',
        model,
        branchFilter: 'alder',
        defaultBranchId: 'alder',
        branchLabelsById: branchLabels,
      })[0].isOutsideCurrentBranch
    ).toBe(true);

    expect(
      searchTreePeople({
        query: 'ra Ald',
        people: allSearchPeople,
        buildMode: 'public',
        model,
        branchFilter: 'all',
        defaultBranchId: 'alder',
        branchLabelsById: branchLabels,
      })[0].person.id
    ).toBe('p_pa');

    expect(
      searchTreePeople({
        query: 'Nellie',
        people: allSearchPeople,
        buildMode: 'public',
        model,
        branchFilter: 'all',
        defaultBranchId: 'alder',
        branchLabelsById: branchLabels,
      })[0].person.id
    ).toBe('p_nobranch');

    expect(
      searchTreePeople({
        query: '1892',
        people: allSearchPeople,
        buildMode: 'public',
        model,
        branchFilter: 'all',
        defaultBranchId: 'alder',
        branchLabelsById: branchLabels,
      })[0].person.id
    ).toBe('p_hanging');
  });
});

describe('generationInference branch coverage', () => {
  it('infers generations across root pushdown, spouse sync, hidden-spouse parents, and birth-year median', () => {
    const map = new Map<string, string[]>();
    addUnique(map, 'k', 'v1');
    addUnique(map, 'k', 'v1');
    addUnique(map, 'k', 'v2');
    expect(map.get('k')).toEqual(['v1', 'v2']);

    const gp = makePerson({ id: 'gp', full_name: 'Grandparent Alder', birth_year: 1820 });
    const p1 = makePerson({ id: 'p1', full_name: 'Parent One', birth_year: 1850 });
    const p2 = makePerson({ id: 'p2', full_name: 'Parent Two', birth_year: 1852 });
    const p2Spouse = makePerson({ id: 'p2sp', full_name: 'Parent Two Spouse', birth_year: 1854 });
    const child = makePerson({ id: 'ch', full_name: 'Child Alder', birth_year: 1880 });
    const hiddenLinked = makePerson({ id: 'hl', full_name: 'Hidden Spouse Link', birth_year: null });
    const medianLinked = makePerson({ id: 'ml', full_name: 'Median Year Link', birth_year: 1879 });
    const unlinkedNoBirth = makePerson({ id: 'ul', full_name: 'Unlinked Unknown', birth_year: null });

    const people = [gp, p1, p2, p2Spouse, child, hiddenLinked, medianLinked, unlinkedNoBirth];
    const parentMap = new Map<string, string[]>([
      ['p1', ['gp']],
      ['ch', ['p1', 'p2']],
    ]);
    const childMap = new Map<string, string[]>([
      ['gp', ['p1']],
      ['p1', ['ch']],
      ['p2', ['ch']],
    ]);
    const spouseMap = new Map<string, string[]>([
      ['p2', ['p2sp']],
      ['p2sp', ['p2']],
    ]);
    const fullKinship: KinshipEdge[] = [
      { from: 'gp', to: 'hidden_mid', relation: 'parent' },
      { from: 'hl', to: 'hidden_mid', relation: 'spouse' },
      { from: 'p1', to: 'ch', relation: 'parent' },
    ];

    const gens = inferGenerations(people, fullKinship, parentMap, childMap, spouseMap);
    expect(gens.get('gp')).toBe(0);
    expect(gens.get('p1')).toBe(1);
    expect(gens.get('p2')).toBe(1);
    expect(gens.get('p2sp')).toBe(1);
    expect(gens.get('ch')).toBe(2);
    expect(gens.get('hl')).toBe(1);
    expect(gens.get('ml')).toBe(2);
    expect(gens.get('ul')).toBe(0);
  });
});

describe('archiveDataHelpers branch coverage', () => {
  it('normalizes base URLs, session props, capabilities, and legacy/static loaders', async () => {
    expect(normalizeBaseUrl('/archive')).toBe('/archive/');
    expect(normalizeBaseUrl('/archive/')).toBe('/archive/');
    expect(normalizeBaseUrl(undefined)).toMatch(/\/$/);

    expect(normalizeSessionProp(null)).toBeNull();
    expect(normalizeSessionProp(undefined)).toBeNull();
    expect(normalizeSessionProp({ authenticated: true, email: 'a@example.com' })?.principal_kind).toBe(
      'user'
    );
    expect(normalizeSessionProp({ authenticated: false, role: 'viewer' })?.principal_kind).toBe(
      'invite_viewer'
    );
    expect(normalizeSessionProp({ authenticated: false })?.principal_kind).toBe('anonymous');
    expect(
      normalizeSessionProp({ authenticated: false, principal_kind: 'invite_viewer', inviteLabel: 'Alder' })
        ?.inviteLabel
    ).toBe('Alder');

    expect(normalizeCapabilities(undefined, null)).toEqual(DEFAULT_ARCHIVE_CAPABILITIES);
    const adminCaps = normalizeCapabilities(undefined, {
      authenticated: true,
      principal_kind: 'user',
      role: 'admin',
    });
    expect(adminCaps.canManageSite).toBe(true);
    expect(normalizeCapabilities({ canEdit: true }, null)).toEqual({
      canEdit: true,
      canUploadMedia: false,
      hasRevisionHistory: false,
      hasTalk: false,
      canManageSite: false,
    });
    expect(
      normalizeCapabilities(
        {
          canEdit: false,
          canUploadMedia: true,
          hasRevisionHistory: true,
          hasTalk: true,
          canManageSite: true,
        },
        null
      )
    ).toEqual({
      canEdit: false,
      canUploadMedia: true,
      hasRevisionHistory: true,
      hasTalk: true,
      canManageSite: true,
    });

    const siteConfig = parseKinloomConfig({
      site: { title: 'Alder Archive', familyName: 'Alder', gedcomSourceName: 'ALDER' },
    });
    const { bundle } = compileArchive({
      siteConfig,
      mode: 'public',
      places: [],
      sources: [],
      people: [],
      events: [],
      kinship: [],
      media: [],
      narratives: [],
    });

    const wrappedNoChecklist = wrapLegacyLoader({
      loadArchive: async () => bundle,
      loadReadings: async () => null,
    });
    expect(wrappedNoChecklist.loadMediaChecklist).toBeUndefined();
    expect((await wrappedNoChecklist.loadArchive()).bundle).toBe(bundle);
    expect(await wrappedNoChecklist.loadReadings()).toBeNull();

    const wrappedWithChecklist = wrapLegacyLoader({
      loadArchive: async () => bundle,
      loadReadings: async () => null,
      loadMediaChecklist: async () => [],
    });
    expect(await wrappedWithChecklist.loadMediaChecklist?.()).toEqual([]);

    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.endsWith('archive.json')) {
        return new Response(JSON.stringify(bundle), { status: 200 });
      }
      if (url.endsWith('readings.json')) {
        return new Response(JSON.stringify({ version: 1, documents: {}, event_page_map: {} }), {
          status: 200,
        });
      }
      return new Response(JSON.stringify({ items: [] }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const staticLoader = createStaticArchiveLoader('/demo');
    expect((await staticLoader.loadArchive()).meta.build_mode).toBe('public');
    expect(await staticLoader.loadReadings()).toEqual({ version: 1, documents: {}, event_page_map: {} });
    expect(await staticLoader.loadMediaChecklist?.()).toEqual([]);
  });
});

describe('authError feedbackCatalog branch coverage', () => {
  it('normalizes providers, error codes, and resolves every AuthErrorCode variant', () => {
    expect(normalizeAuthProvider(null)).toBeNull();
    expect(normalizeAuthProvider('  GOOGLE ')).toBe('google');
    expect(normalizeAuthProvider('magic_link')).toBe('magic_link');
    expect(normalizeAuthProvider('invite')).toBe('invite');
    expect(normalizeAuthProvider('unknown')).toBeNull();

    expect(normalizeAuthErrorCode(undefined)).toBe('AUTH_ERROR');
    expect(normalizeAuthErrorCode('  rate_limited ')).toBe('RATE_LIMITED');
    expect(normalizeAuthErrorCode('UNKNOWN_CODE')).toBe('AUTH_ERROR');

    const allCodes: AuthErrorCode[] = [
      'INVITE_REQUIRED',
      'GOOGLE_CANCELLED',
      'GOOGLE_AUTH_FAILED',
      'INVALID_OAUTH_STATE',
      'AUTH_PROVIDER_UNCONFIGURED',
      'MAGIC_LINK_EXPIRED',
      'MAGIC_LINK_USED',
      'MAGIC_LINK_INVALID',
      'TOKEN_INVALID_OR_EXPIRED',
      'INVITE_EXPIRED',
      'INVITE_REVOKED',
      'INVITE_INVALID',
      'INVITE_INVALID_OR_REVOKED',
      'RATE_LIMITED',
      'EMAIL_SENDER_UNCONFIGURED',
      'EMAIL_RECIPIENT_NOT_ALLOWED',
      'EMAIL_DELIVERY_FAILED',
      'VALIDATION_ERROR',
      'CSRF_ORIGIN_MISMATCH',
      'NETWORK_ERROR',
      'AUTH_ERROR',
    ];

    for (const code of allCodes) {
      const fbDefault = resolveAuthFeedback({ code });
      expect(fbDefault.code).toBe(code);
      expect(fbDefault.title.length).toBeGreaterThan(0);

      const fbWithGoogle = resolveAuthFeedback({
        code,
        provider: 'google',
        hasGoogleProvider: true,
      });
      expect(fbWithGoogle.code).toBe(code);
    }

    expect(
      resolveAuthFeedback({ code: 'INVITE_REQUIRED', provider: 'google', hasGoogleProvider: true })
        .showSwitchGoogleAccount
    ).toBe(true);
    expect(
      resolveAuthFeedback({ code: 'INVITE_REQUIRED', provider: 'magic_link', hasGoogleProvider: false })
        .focusEmailInput
    ).toBe(true);
    expect(resolveAuthFeedback({ code: 'MAGIC_LINK_USED', hasGoogleProvider: true }).hint).toContain(
      'Google'
    );
    expect(resolveAuthFeedback({ code: 'MAGIC_LINK_USED', hasGoogleProvider: false }).hint).toContain(
      'browser'
    );
    expect(
      resolveAuthFeedback({ code: 'EMAIL_SENDER_UNCONFIGURED', hasGoogleProvider: true }).detail
    ).toContain('Google');
    expect(
      resolveAuthFeedback({ code: 'EMAIL_RECIPIENT_NOT_ALLOWED', hasGoogleProvider: true }).detail
    ).toContain('Google');
    expect(resolveAuthFeedback({ code: 'EMAIL_DELIVERY_FAILED', hasGoogleProvider: true }).detail).toContain(
      'Google'
    );
  });
});

describe('ohmStyle branch coverage', () => {
  it('prunes layers, rewrites labels/fonts/date ranges, and caches/recovers loadArchivalOhmStyle', async () => {
    const rawStyle: StyleSpecification = {
      version: 8,
      sources: {
        ohm: { type: 'vector', tiles: ['https://example.com/{z}/{x}/{y}.pbf'] },
        ohm_landcover_hillshade: { type: 'raster', tiles: ['https://example.com/h/{z}/{x}/{y}.png'] },
        other: { type: 'vector', tiles: ['https://example.com/o/{z}/{x}/{y}.pbf'] },
      },
      layers: [
        { id: 'bg', type: 'background', paint: { 'background-color': '#fff' } },
        { id: 'ohm_landcover_hillshade', type: 'raster', source: 'ohm_landcover_hillshade' },
        { id: 'too_zoomed', type: 'fill', source: 'ohm', 'source-layer': 'land', minzoom: 14 },
        { id: 'no_source_layer', type: 'fill', source: 'ohm' },
        { id: 'non_archival', type: 'fill', source: 'ohm', 'source-layer': 'buildings' },
        { id: 'land', type: 'fill', source: 'ohm', 'source-layer': 'land' },
        {
          id: 'place_labels',
          type: 'symbol',
          source: 'ohm',
          'source-layer': 'populated_places',
          layout: {
            'text-field': ['get', 'name'],
            'text-font': ['OpenHistorical Italic'],
          },
        },
        {
          id: 'place_labels_plain',
          type: 'symbol',
          source: 'other',
          'source-layer': 'populated_places',
          layout: {
            'text-field': '{name}',
            'text-font': ['OpenHistorical'],
          },
        },
      ],
    };

    const built = buildArchivalOhmStyle(rawStyle, '1880');
    expect(Object.keys(built.sources)).toEqual(['ohm', 'other']);
    expect(built.layers.some((l) => l.id === PAPER_LAND_LAYER_ID)).toBe(true);
    expect(built.layers.some((l) => l.id === 'bg')).toBe(true);
    expect(built.layers.some((l) => l.id === 'too_zoomed')).toBe(false);
    expect(built.layers.some((l) => l.id === 'non_archival')).toBe(false);
    expect(built.state).toBeDefined();

    // Invalid date year produces empty date state while preserving rawStyle.state
    const withState: StyleSpecification & { state: Record<string, { default: string }> } = {
      ...rawStyle,
      state: { customKey: { default: 'keep' } },
    };
    const builtInvalidDate = buildArchivalOhmStyle(withState, 'not-a-year');
    expect(builtInvalidDate.state).toEqual({ customKey: { default: 'keep' } });

    // Error paths reset cache cleanly
    resetCachedOhmStyle();
    await expect(
      loadArchivalOhmStyle('1900', async () => new Response('fail', { status: 503 }))
    ).rejects.toThrow(`HTTP 503 loading ${OHM_STYLE_URL}`);

    await expect(
      loadArchivalOhmStyle('1900', async () => new Response(JSON.stringify({ version: 7 }), { status: 200 }))
    ).rejects.toThrow('Invalid MapLibre style JSON');

    await expect(
      loadArchivalOhmStyle('1900', async () => new Response(JSON.stringify('not-an-object'), { status: 200 }))
    ).rejects.toThrow('Invalid MapLibre style JSON');

    // Successful load caches baseStyle and updates state for custom year
    const fetchOk = vi.fn(async () => new Response(JSON.stringify(rawStyle), { status: 200 }));
    const first = await loadArchivalOhmStyle(OVERVIEW_REFERENCE_YEAR, fetchOk);
    const second = await loadArchivalOhmStyle(OVERVIEW_REFERENCE_YEAR, fetchOk);
    const third = await loadArchivalOhmStyle('1865', fetchOk);
    expect(fetchOk).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
    expect(third).not.toBe(first);
    expect(third.state).toBeDefined();
  });
});

describe('authSession reducers branch coverage', () => {
  const defaultProviders: ArchiveAuthProviders = {
    magicLink: true,
    google: false,
  };

  function makeContext(overrides: Partial<AuthSessionContext> = {}): AuthSessionContext {
    return {
      pendingInviteToken: null,
      inviteLabel: null,
      email: null,
      displayName: null,
      role: null,
      magicLinkResendCount: 0,
      authError: null,
      authErrorDetail: null,
      urlError: null,
      serverCapabilities: null,
      capabilitiesOverride: undefined,
      authProviders: defaultProviders,
      hasServerAuthProviders: false,
      hasExplicitSession: false,
      initialSession: undefined,
      dataSource: undefined,
      ...overrides,
    };
  }

  function makeSnapshot(ctx: AuthSessionContext, activeState: string): AuthSessionSnapshotLike {
    return {
      context: ctx,
      matches(value) {
        if (typeof value === 'string') {
          return value === activeState;
        }
        return `authenticated.${value.authenticated}` === activeState;
      },
    };
  }

  it('builds hydrated patches for authenticated, invite_valid, and anonymous outcomes', () => {
    const serverCaps: ArchiveCapabilities = {
      canEdit: true,
      canUploadMedia: true,
      hasRevisionHistory: true,
      hasTalk: true,
      canManageSite: false,
    };
    const p1 = buildHydratedPatch(
      {
        kind: 'authenticated',
        email: 'ed@example.com',
        displayName: 'Ed Alder',
        role: 'editor',
        capabilities: serverCaps,
        authProviders: { magicLink: true, google: true },
      },
      defaultProviders,
      false
    );
    expect(p1.role).toBe('editor');
    expect(p1.hasServerAuthProviders).toBe(true);

    const p2 = buildHydratedPatch(
      { kind: 'invite_valid', token: 'tok_1', label: 'Harbor Guests' },
      defaultProviders,
      false
    );
    expect(p2.pendingInviteToken).toBe('tok_1');
    expect(p2.serverCapabilities).toBeNull();

    const p3 = buildHydratedPatch({ kind: 'anonymous' }, defaultProviders, true);
    expect(p3.email).toBeNull();
    expect(p3.hasServerAuthProviders).toBe(true);
  });

  it('formats Error, object-with-message, and primitive errors', () => {
    expect(formatAuthErrorMessage(new Error('boom'))).toBe('boom');
    expect(formatAuthErrorMessage({ message: 'structured error' })).toBe('structured error');
    expect(formatAuthErrorMessage({ message: 42 })).toBe('[object Object]');
    expect(formatAuthErrorMessage(null)).toBe('null');
    expect(formatAuthErrorMessage('plain')).toBe('plain');
  });

  it('derives session and capabilities for every machine state and override mode', () => {
    const admin = deriveSessionFromAuthSnapshot(
      makeSnapshot(makeContext({ email: null, displayName: null, role: 'admin' }), 'authenticated.admin'),
      { allowTalk: true, hasRevisionHistory: true }
    );
    expect(admin.session.role).toBe('admin');
    expect(admin.session.email).toBeUndefined();
    expect(admin.capabilities.canManageSite).toBe(true);

    const editor = deriveSessionFromAuthSnapshot(
      makeSnapshot(
        makeContext({
          email: 'ed@example.com',
          displayName: 'Ed Alder',
          role: 'editor',
          capabilitiesOverride: { canEdit: true },
        }),
        'authenticated.editor'
      )
    );
    expect(editor.session.role).toBe('editor');
    expect(editor.capabilities.canEdit).toBe(true);
    expect(editor.capabilities.canUploadMedia).toBe(false);

    const signingOutWithRole = deriveSessionFromAuthSnapshot(
      makeSnapshot(
        makeContext({
          email: null,
          displayName: null,
          role: 'editor',
          serverCapabilities: {
            canEdit: true,
            canUploadMedia: false,
            hasRevisionHistory: false,
            hasTalk: false,
            canManageSite: false,
          },
        }),
        'signingOut'
      )
    );
    expect(signingOutWithRole.session.authenticated).toBe(true);
    expect(signingOutWithRole.capabilities.canEdit).toBe(true);

    const inviteViewer = deriveSessionFromAuthSnapshot(
      makeSnapshot(makeContext({ pendingInviteToken: 'tok', inviteLabel: null }), 'requestingMagicLink')
    );
    expect(inviteViewer.session.principal_kind).toBe('invite_viewer');
    expect(inviteViewer.session.inviteLabel).toBeUndefined();

    const awaitingWithInvite = deriveSessionFromAuthSnapshot(
      makeSnapshot(
        makeContext({ pendingInviteToken: 'tok', inviteLabel: 'Alder Link' }),
        'awaitingMagicLinkClick'
      )
    );
    expect(awaitingWithInvite.session.inviteLabel).toBe('Alder Link');

    const anon = deriveSessionFromAuthSnapshot(makeSnapshot(makeContext(), 'anonymous'));
    expect(anon.session.principal_kind).toBe('anonymous');
  });
});

describe('createRegistry, MediaPlayer, and PronunciationBadge pure helpers', () => {
  it('validates and builds create payloads and merges custom registry entries', () => {
    const baseDraft = createInitialEntityDraft(undefined, null);
    expect(buildPersonCreatePayload(baseDraft, [], true).ok).toBe(false);
    const surnameOnly = buildPersonCreatePayload({ ...baseDraft, surname: 'Alder' }, [], false);
    expect(surnameOnly.ok).toBe(true);
    if (surnameOnly.ok) {
      expect(surnameOnly.payload.given_name).toBe('Alder');
    }

    expect(
      ENTITY_CREATE_FORM_REGISTRY.event.validateAndBuild(baseDraft, { people: [], hasPrimarySource: true }).ok
    ).toBe(false);
    const undatedEvt = ENTITY_CREATE_FORM_REGISTRY.event.validateAndBuild(
      { ...baseDraft, eventTitle: 'Harbor Storm', eventDate: '', eventPersonId: 'per_a', eventPlaceId: '' },
      { people: [], hasPrimarySource: true }
    );
    expect(undatedEvt.ok).toBe(true);

    expect(
      ENTITY_CREATE_FORM_REGISTRY.place.validateAndBuild(baseDraft, { people: [], hasPrimarySource: false })
        .ok
    ).toBe(false);
    const placeRes = ENTITY_CREATE_FORM_REGISTRY.place.validateAndBuild(
      { ...baseDraft, placeName: 'Harbor', placeFullName: '', placeLat: 'bad', placeLng: '-85.5' },
      { people: [], hasPrimarySource: true }
    );
    expect(placeRes.ok).toBe(true);
    if (placeRes.ok) {
      expect(placeRes.payload.lat).toBe(0);
      expect(placeRes.payload.lng).toBe(-85.5);
    }

    expect(
      ENTITY_CREATE_FORM_REGISTRY.kinship_edge.validateAndBuild(
        { ...baseDraft, fromPersonId: 'p1', toPersonId: 'p1' },
        { people: [], hasPrimarySource: true }
      ).ok
    ).toBe(false);
    expect(
      ENTITY_CREATE_FORM_REGISTRY.kinship_edge.validateAndBuild(
        { ...baseDraft, fromPersonId: 'p1', toPersonId: 'p2', relation: 'spouse' },
        { people: [], hasPrimarySource: true }
      ).ok
    ).toBe(true);

    expect(resolveCreateFormRegistry(undefined).order).toEqual(['person', 'event', 'place', 'kinship_edge']);
    expect(resolveCreateFormRegistry({}).order).toEqual(['person', 'event', 'place', 'kinship_edge']);
    const extended = resolveCreateFormRegistry({
      narrative: {
        kind: 'narrative',
        tabLabel: 'Story',
        Fields: ENTITY_CREATE_FORM_REGISTRY.person.Fields,
        validateAndBuild: ENTITY_CREATE_FORM_REGISTRY.person.validateAndBuild,
      },
    });
    expect(extended.order).toContain('narrative');
  });

  it('classifies media types, formats durations, and checks pronunciation helpers', () => {
    expect(isVideoMedia(makeMedia({ kind: 'video_story' }))).toBe(true);
    expect(isVideoMedia(makeMedia({ mime_type: 'video/mp4' }))).toBe(true);
    expect(isVideoMedia(makeMedia({ file: '/media/clip.webm?v=1' }))).toBe(true);
    expect(isVideoMedia(makeMedia({ file: '/media/photo.jpg' }))).toBe(false);

    expect(isAudioMedia(makeMedia({ kind: 'audio_oral_history' }))).toBe(true);
    expect(isAudioMedia(makeMedia({ mime_type: 'audio/mpeg' }))).toBe(true);
    expect(isAudioMedia(makeMedia({ file: '/media/talk.ogg' }))).toBe(true);
    expect(isAudioMedia(makeMedia({ file: '/media/photo.jpg' }))).toBe(false);

    expect(isPdfMedia(makeMedia({ mime_type: 'application/pdf' }))).toBe(true);
    expect(isPdfMedia(makeMedia({ file: '/media/deed.pdf?p=1' }))).toBe(true);
    expect(isPdfMedia(makeMedia({ file: '/media/photo.jpg' }))).toBe(false);

    expect(formatDurationSeconds(null)).toBeNull();
    expect(formatDurationSeconds(-5)).toBeNull();
    expect(formatDurationSeconds(Number.NaN)).toBeNull();
    expect(formatDurationSeconds(65)).toBe('1:05');

    expect(isEnglishPronunciationLanguage(undefined)).toBe(true);
    expect(isEnglishPronunciationLanguage('   ')).toBe(true);
    expect(isEnglishPronunciationLanguage('en-US')).toBe(true);
    expect(isEnglishPronunciationLanguage('nl-NL')).toBe(false);

    expect(hasPronunciationContent(null)).toBe(false);
    expect(hasPronunciationContent({ phonetic: '  ' })).toBe(false);
    expect(hasPronunciationContent({ note: 'Regional stress' })).toBe(true);
    expect(hasPronunciationContent({ variants: [{ label: 'Dutch', ipa: '/ɑl.dər/' }] })).toBe(true);
  });
});

describe('httpWiki responseParsers and httpWikiDataSource branch coverage', () => {
  it('parses session, entity get, revision list, pronunciation upsert, and audio responses across edge fields', () => {
    const caps = {
      canEdit: false,
      canUploadMedia: false,
      hasRevisionHistory: false,
      hasTalk: false,
      canManageSite: false,
    };
    const editorSess = parseSessionResponse({
      session: { authenticated: true, principal_kind: 'user', role: 'editor', inviteLabel: 'Alder Link' },
      capabilities: caps,
    });
    expect(editorSess.session.role).toBe('editor');
    expect(editorSess.session.email).toBeUndefined();
    expect(editorSess.session.inviteLabel).toBe('Alder Link');

    const viewerSess = parseSessionResponse({
      session: { authenticated: false, principal_kind: 'invite_viewer', role: 'viewer' },
      capabilities: caps,
    });
    expect(viewerSess.session.role).toBe('viewer');

    const unknownRoleSess = parseSessionResponse({
      session: { authenticated: false, principal_kind: 'anonymous', role: 'guest' },
      capabilities: caps,
    });
    expect(unknownRoleSess.session.role).toBeUndefined();

    const deletedEntity = parseEntityGetResponse({
      entity: { id: 'per_a' },
      current_revision_id: 5,
      has_primary_source: true,
      deleted_at: '2025-01-01T00:00:00Z',
      updated_at: '2025-01-02T00:00:00Z',
    });
    expect(deletedEntity.deleted_at).toBe('2025-01-01T00:00:00Z');

    expect(parseRevisionListResponse({ items: [], next_cursor: null }).next_cursor).toBeNull();
    expect(parseRevisionListResponse({ items: [] }).next_cursor).toBeNull();

    const upsertNull = parseUpsertPronunciationTermResponse({
      term: 123,
      pronunciation: null,
      pronunciations: {},
    });
    expect(upsertNull.term).toBe('');
    expect(upsertNull.pronunciation).toBeNull();

    const upsertVal = parseUpsertPronunciationTermResponse({
      term: 'Alder',
      pronunciation: { phonetic: 'AHL-der' },
      pronunciations: { Alder: { phonetic: 'AHL-der' } },
    });
    expect(upsertVal.pronunciation?.phonetic).toBe('AHL-der');

    const genNoDedup = parseGeneratedPronunciationAudioResponse({
      audio_url: '/audio/alder.mp3',
      content_type: 'audio/mpeg',
      size_bytes: 1024,
    });
    expect(genNoDedup.deduplicated).toBeUndefined();

    const genDedup = parseGeneratedPronunciationAudioResponse({
      audio_url: '/audio/alder.mp3',
      deduplicated: true,
    });
    expect(genDedup.deduplicated).toBe(true);
  });

  it('exercises httpWikiDataSource invalid payload, 304 fallback etag, optional summaries, and error status paths', async () => {
    const siteConfig = parseKinloomConfig({
      site: { title: 'Alder Archive', familyName: 'Alder', gedcomSourceName: 'ALDER' },
    });
    const { bundle } = compileArchive({
      siteConfig,
      mode: 'public',
      places: [],
      sources: [],
      people: [],
      events: [],
      kinship: [],
      media: [],
      narratives: [],
    });

    let archiveCalls = 0;
    const stubFetch: typeof fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('/api/bundle')) {
        archiveCalls += 1;
        if (archiveCalls === 1) {
          return new Response(JSON.stringify(bundle), { status: 200, headers: { etag: '"e1"' } });
        }
        if (archiveCalls === 2) {
          return new Response(null, { status: 304 });
        }
        return new Response(JSON.stringify({ invalid: true }), { status: 200 });
      }
      if (url.includes('/api/media/checklist')) {
        return new Response(JSON.stringify('not-an-object'), { status: 200 });
      }
      if (url.includes('/api/entities/person/per_bad')) {
        return new Response(JSON.stringify({ bad: true }), { status: 200 });
      }
      if (url.includes('/api/media/upload')) {
        return new Response(JSON.stringify({ bad: true }), { status: 200 });
      }
      if (url.includes('/api/revisions/1/revert')) {
        return new Response(
          JSON.stringify({
            revision: {
              revision_id: 2,
              batch_id: null,
              entity_type: 'person',
              entity_id: 'per_a',
              parent_revision_id: 1,
              reverted_revision_id: 1,
              action: 'revert',
              author_type: 'human',
              author_id: 'ed@example.com',
              author_name: 'Ed Alder',
              summary: 'Revert',
              has_primary_source: true,
              before_json: null,
              after_json: null,
              created_at: '2025-01-01T00:00:00Z',
            },
            etag: '"e2"',
          }),
          { status: 200 }
        );
      }
      if (url.includes('/api/batches/b1/revert')) {
        return new Response(JSON.stringify({ revisions: [], etag: '"e3"' }), { status: 200 });
      }
      if (url.includes('/api/auth/magic-link/request')) {
        return new Response(JSON.stringify({ sent: true }), { status: 200 });
      }
      if (url.includes('/api/pronunciations')) {
        return new Response(JSON.stringify({ error: { code: 'SERVER_ERROR', message: 'down' } }), {
          status: 500,
        });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    const ds = createHttpWikiDataSource({ apiBaseUrl: 'https://alder.example.com', fetchImpl: stubFetch });
    const first = await ds.loadArchive();
    expect(first.etag).toBe('"e1"');
    const cached = await ds.loadArchive({ ifNoneMatch: '"e1"' });
    expect(cached.notModified).toBe(true);
    expect(cached.etag).toBe('"e1"');

    const dsInvalid = createHttpWikiDataSource({
      apiBaseUrl: 'https://alder.example.com',
      fetchImpl: stubFetch,
    });
    await expect(dsInvalid.loadArchive()).rejects.toThrow('Invalid archive bundle payload');
    await expect(ds.loadMediaChecklist?.()).rejects.toThrow('Invalid media checklist payload');
    await expect(
      ds.updateEntity?.('person', 'per_bad', {
        expected_parent_revision_id: asRevisionId(1),
        data: {},
        summary: 'Update',
        has_primary_source: true,
      })
    ).rejects.toThrow('Invalid response payload');
    await expect(ds.uploadMedia?.(new FormData())).rejects.toThrow('Invalid response payload');

    expect((await ds.revertRevision?.(asRevisionId(1)))?.etag).toBe('"e2"');
    expect((await ds.revertBatch?.(asBatchId('b1')))?.etag).toBe('"e3"');
    expect((await ds.requestMagicLink?.('ed@example.com'))?.sent).toBe(true);
    expect((await ds.requestMagicLink?.('ed@example.com', { next: '/tree' }))?.sent).toBe(true);
    await expect(ds.loadPronunciations?.()).rejects.toThrow();

    // Default fetchImpl fallback
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ sent: true }), { status: 200 }))
    );
    const defaultDs = createHttpWikiDataSource({ apiBaseUrl: 'https://alder.example.com' });
    expect((await defaultDs.requestMagicLink?.('ed@example.com'))?.sent).toBe(true);
  });
});

describe('entityEditor reducers and mediaUpload actors/machine branch coverage', () => {
  it('exercises entityEditor reducer patches and validation error paths', () => {
    const ctx = createInitialEntityEditorContext({
      entityType: 'person',
      entityId: 'per_a',
      revisionId: asRevisionId(1),
      snapshot: { id: 'per_a', slug: 'arthur-alder', full_name: 'Arthur Alder' },
      hasPrimarySource: true,
    });

    expect(buildOpenEditPatch(ctx, { type: 'CANCEL_EDIT' })).toEqual({});
    const openSame = buildOpenEditPatch(ctx, { type: 'OPEN_EDIT', hasPrimarySource: false });
    expect(openSame.entityId).toBe('per_a');
    expect(openSame.baseRevisionId).toBe(asRevisionId(1));

    expect(buildEntityTargetPatch({ type: 'CANCEL_EDIT' })).toEqual({});
    const targetPatch = buildEntityTargetPatch({
      type: 'ENTITY_CHANGED',
      entityType: 'place',
      entityId: 'pl_harbor',
      revisionId: asRevisionId(2),
      snapshot: { id: 'pl_harbor', name: 'Harbor' },
      hasPrimarySource: false,
    });
    expect(targetPatch.entityId).toBe('pl_harbor');

    const leaveNull = buildPendingLeavePatch(ctx);
    expect(leaveNull.dirty).toBe(false);
    const leaveTarget = buildPendingLeavePatch({
      ...ctx,
      pendingEntityChange: {
        entityType: 'place',
        entityId: 'pl_harbor',
        revisionId: asRevisionId(3),
        snapshot: { id: 'pl_harbor', name: 'Harbor' },
        hasPrimarySource: true,
      },
    });
    expect(leaveTarget.entityId).toBe('pl_harbor');

    const errs = collectValidationErrors({
      ...ctx,
      dirty: false,
      summary: 'x',
      draft: { id: 'per_a', full_name: '' },
    });
    expect(errs.length).toBeGreaterThanOrEqual(2);

    expect(buildRebasePatch(ctx)).toEqual({});
    const rebased = buildRebasePatch({
      ...ctx,
      conflict: {
        latestRevisionId: asRevisionId(4),
        latestSnapshot: { id: 'per_a', slug: 'arthur-alder', full_name: 'Arthur Alder Sr.' },
        lastUpdatedAt: '2025-01-01T00:00:00Z',
      },
    });
    expect(rebased.baseRevisionId).toBe(asRevisionId(4));
  });

  it('exercises mediaUpload actors, guards, and machine error/living-blocked/retry branches', async () => {
    expect(readUploadOutput(null)).toBeNull();
    expect(readUploadOutput({})).toBeNull();
    expect(readUploadOutput({ output: null })).toBeNull();
    expect(readUploadOutput({ output: { kind: 'other' } })).toBeNull();
    expect(readUploadOutput({ output: { kind: 'uploaded', uploadGen: 1, r2Key: 'k' } })?.kind).toBe(
      'uploaded'
    );
    expect(readUploadOutput({ output: { kind: 'living_blocked', uploadGen: 1, message: 'no' } })?.kind).toBe(
      'living_blocked'
    );

    expect(readAttachOutput(null)).toBeNull();
    expect(readAttachOutput({})).toBeNull();
    expect(readAttachOutput({ output: null })).toBeNull();
    expect(readAttachOutput({ output: { kind: 'other' } })).toBeNull();
    expect(
      readAttachOutput({
        output: { kind: 'attached', uploadGen: 1, mediaId: 'm1', targetBecameLiving: false },
      })?.kind
    ).toBe('attached');
    expect(readAttachOutput({ output: { kind: 'living_blocked', uploadGen: 1, message: 'no' } })?.kind).toBe(
      'living_blocked'
    );

    const file = new File(['abc'], 'harbor.jpg', { type: 'image/jpeg' });
    const waitSettled = async (
      actor: ReturnType<typeof createActor<typeof mediaUploadMachine>>,
      predicate: (stateVal: unknown) => boolean
    ): Promise<void> => {
      for (let i = 0; i < 40; i += 1) {
        if (predicate(actor.getSnapshot().value)) {
          return;
        }
        await new Promise((r) => setTimeout(r, 5));
      }
    };

    // 1. Default uploadMedia without uploadMedia capability -> failedRetryable
    const noCapActor = createActor(
      mediaUploadMachine.provide({
        actors: {
          hashFileSha256: fromPromise(async () => 'deadbeef'),
        },
      }),
      { input: {} }
    ).start();
    noCapActor.send({
      type: 'SELECT_FILE',
      file,
      targets: { personIds: [] },
      targetHasLiving: false,
      metadata: { kind: 'family_photo', caption: '', summary: '   ' },
    });
    await waitSettled(noCapActor, (v) => v === 'failedRetryable');
    expect(noCapActor.getSnapshot().context.retryableError).toContain('not supported');

    // 2. Hash fails with non-Error -> rejectedInvalid
    const hashFailActor = createActor(
      mediaUploadMachine.provide({
        actors: {
          hashFileSha256: fromPromise<string, { file: File }>(async () => {
            throw 'hash boom';
          }),
        },
      }),
      { input: {} }
    ).start();
    hashFailActor.send({
      type: 'SELECT_FILE',
      file,
      targets: { personIds: ['per_a'] },
      targetHasLiving: false,
    });
    await waitSettled(hashFailActor, (v) => v === 'rejectedInvalid');
    expect(hashFailActor.getSnapshot().context.rejectionMessage).toContain('Failed to hash');

    // 3. Upload returns LIVING_MEDIA_FORBIDDEN ArchiveApiError via defaultUploadMediaActor -> rejectedInvalid
    const livingUploadActor = createActor(
      mediaUploadMachine.provide({
        actors: {
          hashFileSha256: fromPromise(async () => 'abc123'),
          uploadMedia: defaultUploadMediaActor,
        },
      }),
      {
        input: {
          dataSource: {
            loadArchive: async () => {
              throw new Error('unused');
            },
            loadReadings: async () => null,
            uploadMedia: async () => {
              throw { status: 422, code: 'LIVING_MEDIA_FORBIDDEN' };
            },
          },
        },
      }
    ).start();
    livingUploadActor.send({
      type: 'SELECT_FILE',
      file: new File(['x'], 'no-type.jpg', { type: 'image/jpeg' }),
      targets: { personIds: [] },
      targetHasLiving: false,
      metadata: { kind: 'family_photo', caption: '', summary: '' },
    });
    await waitSettled(livingUploadActor, (v) => v === 'rejectedInvalid');
    expect(livingUploadActor.getSnapshot().context.rejectionReason).toBe('living_person_blocked');

    // 4. Attach returns targetBecameLiving -> rejectedInvalid; then attach error with string -> failedRetryable -> RETRY
    const attachLivingActor = createActor(
      mediaUploadMachine.provide({
        actors: {
          hashFileSha256: fromPromise(async () => 'abc123'),
          uploadMedia: fromPromise(async ({ input }) => ({
            kind: 'uploaded' as const,
            uploadGen: input.uploadGen,
            r2Key: 'r2/key',
            url: '/media/key.jpg',
          })),
          attachMedia: fromPromise(async ({ input }) => ({
            kind: 'attached' as const,
            uploadGen: input.uploadGen,
            mediaId: 'med_1',
            targetBecameLiving: true,
          })),
        },
      }),
      { input: {} }
    ).start();
    attachLivingActor.send({
      type: 'SELECT_FILE',
      file,
      targets: { personIds: ['per_a'] },
      targetHasLiving: false,
    });
    await waitSettled(attachLivingActor, (v) => v === 'rejectedInvalid');
    expect(attachLivingActor.getSnapshot().context.rejectionMessage).toContain(
      'Target person is marked living'
    );

    let attachAttempts = 0;
    const attachRetryActor = createActor(
      mediaUploadMachine.provide({
        actors: {
          hashFileSha256: fromPromise(async () => 'abc123'),
          uploadMedia: fromPromise(async ({ input }) => ({
            kind: 'uploaded' as const,
            uploadGen: input.uploadGen,
            r2Key: 'r2/key',
          })),
          attachMedia: fromPromise(async ({ input }) => {
            attachAttempts += 1;
            if (attachAttempts === 1) {
              throw 'attach temporary failure';
            }
            return {
              kind: 'attached' as const,
              uploadGen: input.uploadGen,
              mediaId: 'med_ok',
              targetBecameLiving: false,
            };
          }),
        },
      }),
      { input: {} }
    ).start();
    attachRetryActor.send({
      type: 'SELECT_FILE',
      file,
      targets: { personIds: ['per_a'] },
      targetHasLiving: false,
    });
    await waitSettled(attachRetryActor, (v) => v === 'failedRetryable');
    expect(attachRetryActor.getSnapshot().context.retryableError).toBe('attach temporary failure');
    attachRetryActor.send({ type: 'RETRY' });
    await waitSettled(attachRetryActor, (v) => v === 'complete');
    expect(attachRetryActor.getSnapshot().context.mediaId).toBe('med_ok');

    // defaultAttachMediaActor without uploadedMedia rejects
    const attachMissingActor = createActor(
      mediaUploadMachine.provide({
        actors: {
          hashFileSha256: fromPromise(async () => 'abc123'),
          uploadMedia: fromPromise(async ({ input }) => ({
            kind: 'uploaded' as const,
            uploadGen: input.uploadGen,
            r2Key: 'r2/key',
          })),
          attachMedia: defaultAttachMediaActor,
        },
      }),
      { input: {} }
    ).start();
    attachMissingActor.send({
      type: 'SELECT_FILE',
      file,
      targets: { personIds: ['per_a'] },
      targetHasLiving: false,
    });
    await waitSettled(attachMissingActor, (v) => v === 'failedRetryable');
    expect(attachMissingActor.getSnapshot().context.retryableError).toContain(
      'did not return an attached media'
    );
  });
});

describe('fieldTypes, treeNodeDisplay, personViewModel, and placeViewModel branch coverage', () => {
  it('covers fieldTypes parsing and treeNodeDisplay formatting branches', () => {
    expect(asString('hi')).toBe('hi');
    expect(asString(42)).toBe('42');
    expect(asString(null)).toBe('');
    expect(asStringArray('not-array')).toEqual([]);
    expect(asStringArray(['a', 1, 'b'])).toEqual(['a', 'b']);
    expect(slugify('!!!')).toBe('record');

    expect(parsePersonSex('M')).toBe('M');
    expect(parsePersonSex('F')).toBe('F');
    expect(parsePersonSex('U')).toBe('U');
    expect(parsePersonSex('X')).toBe('U');

    expect(parsePersonLineageGroup('ancestor')).toBe('ancestor');
    expect(parsePersonLineageGroup('descendant')).toBe('descendant');
    expect(parsePersonLineageGroup('descendant_spouse')).toBe('descendant_spouse');
    expect(parsePersonLineageGroup('collateral')).toBe('collateral');
    expect(parsePersonLineageGroup('extended')).toBe('extended');
    expect(parsePersonLineageGroup('unknown')).toBe('extended');

    expect(parseKinshipRelation('parent')).toBe('parent');
    expect(parseKinshipRelation('spouse')).toBe('spouse');
    expect(parseKinshipRelation('child')).toBe('child');
    expect(parseKinshipRelation('cousin')).toBe('parent');

    expect(formatLineageGroupLabel('ancestor')).toBeTruthy();
    expect(formatLineageGroupLabel('custom_harbor_line')).toBe('Custom Harbor Line');

    expect(formatTreeCardName('Henry Alder', 20)).toBe('Henry Alder');
    expect(formatTreeCardName('Hendrik Johannes Alder Jr.', 20)).toBe('Hendrik J. Alder Jr.');
    expect(formatTreeCardName('Hendrik Johannes Alder', 18)).toBe('Hendrik J. Alder');
    expect(formatTreeCardName('Bartholomew Maximilian Alder-Mercer', 14)).toMatch(/…$/);

    const county: Place = {
      id: 'pl_county',
      slug: 'cedar-county',
      name: 'Cedar County',
      full_name: 'Cedar County, Michigan',
      place_type: 'county',
      parent_id: null,
      lat: 42.8,
      lng: -85.8,
    };
    const twp: Place = {
      id: 'pl_twp',
      slug: 'township-4',
      name: 'Township 4',
      full_name: 'Township 4, Cedar County',
      place_type: 'town',
      parent_id: 'pl_county',
      lat: 42.8,
      lng: -85.8,
    };
    const longPlace: Place = {
      ...twp,
      id: 'pl_long',
      name: 'Very Long Harbor Settlement Name',
      parent_id: null,
    };
    const placesMap = new Map<string, Place>([
      [county.id, county],
      [twp.id, twp],
      [longPlace.id, longPlace],
    ]);
    expect(formatTreeCardPlace(undefined, placesMap)).toBe('');
    expect(formatTreeCardPlace(twp, placesMap)).toBe('Cedar Co.');
    expect(formatTreeCardPlace(longPlace, placesMap, 10)).toMatch(/…$/);
  });

  it('covers personViewModel and placeViewModel edge branches', () => {
    const siteConfig = parseKinloomConfig({
      site: { title: 'Alder Archive', familyName: 'Alder', gedcomSourceName: 'ALDER' },
    });
    const { bundle } = compileArchive({
      siteConfig,
      mode: 'public',
      places: [
        {
          id: 'pl_county',
          slug: 'cedar-county',
          name: 'Cedar County',
          full_name: 'Cedar County, Michigan',
          place_type: 'county',
          parent_id: null,
          lat: 42.8,
          lng: -85.8,
        },
        {
          id: 'pl_harbor',
          slug: 'harbor',
          name: 'Harbor',
          full_name: 'Harbor, Cedar County, Michigan',
          place_type: 'town',
          parent_id: 'pl_county',
          lat: 42.87,
          lng: -85.86,
          photo_url: '/media/harbor.jpg',
        },
        {
          id: 'pl_far',
          slug: 'far-ridge',
          name: 'Far Ridge',
          full_name: 'Far Ridge, Cedar County, Michigan',
          place_type: 'town',
          parent_id: 'pl_county',
          lat: 43.4,
          lng: -85.2,
        },
      ],
      sources: [],
      people: [
        {
          id: 'p1',
          slug: 'arthur-alder',
          full_name: 'Arthur Alder',
          given_name: 'Arthur',
          surname: 'Alder',
          alt_names: [],
          sex: 'M',
          is_living: false,
          lineage_group: 'ancestor',
          branch: 'alder',
          birth_edtf: '',
          death_edtf: '',
          portrait_url: '/media/p1.jpg',
        },
        {
          id: 'p2',
          slug: 'clara-alder',
          full_name: 'Clara Alder',
          given_name: 'Clara',
          surname: 'Alder',
          alt_names: [],
          sex: 'F',
          is_living: false,
          lineage_group: 'ancestor',
          branch: 'alder',
          birth_edtf: '',
          death_edtf: '',
          portrait_url: null,
        },
        {
          id: 'p3',
          slug: 'living-person',
          full_name: 'Living',
          given_name: 'Living',
          surname: '',
          alt_names: [],
          sex: 'U',
          is_living: true,
          lineage_group: 'descendant',
          branch: 'alder',
          birth_edtf: '',
          death_edtf: '',
          portrait_url: null,
        },
      ],
      events: [
        {
          id: 'ev_late',
          title: '1895 Harbor Mill',
          summary: 'Later event',
          event_kind: 'point_event',
          scope: 'family',
          edtf_date: '1895',
          place_id: 'pl_harbor',
          participants: [
            { person_id: 'p1', role: 'head' },
            { person_id: 'p3', role: 'child' },
            { person_id: 'missing_p', role: 'witness' },
          ],
          sources: [],
        },
        {
          id: 'ev_early',
          title: '1875 Harbor Settlement',
          summary: 'Earlier event',
          event_kind: 'point_event',
          scope: 'family',
          edtf_date: '1875',
          place_id: 'pl_harbor',
          participants: [{ person_id: 'p1', role: 'head' }],
          sources: [],
        },
        {
          id: 'ev_local_undated',
          title: 'Harbor Charter',
          summary: 'Undated local event',
          event_kind: 'point_event',
          scope: 'local',
          edtf_date: '',
          place_id: 'pl_harbor',
          participants: [],
          sources: [],
        },
        {
          id: 'ev_local_1880',
          title: 'Harbor Bridge',
          summary: 'Dated local event',
          event_kind: 'point_event',
          scope: 'local',
          edtf_date: '1880',
          place_id: 'pl_harbor',
          participants: [],
          sources: [],
        },
      ],
      kinship: [
        { from: 'p1', to: 'p2', relation: 'child' },
        { from: 'p1', to: 'missing_rel', relation: 'spouse' },
        { from: 'p2', to: 'p1', relation: 'child' },
      ],
      media: [
        {
          id: 'm1',
          kind: 'document_scan',
          file: '/media/other.jpg',
          caption: 'Scan',
          date_edtf: '1880',
          person_ids: ['p1'],
          source_id: null,
        },
      ],
      narratives: [],
    });

    const peopleById = new Map(bundle.people.map((p) => [p.id, p]));
    const placesById = new Map(bundle.places.map((pl) => [pl.id, pl]));
    const p1 = bundle.people[0];
    const p2 = bundle.people[1];

    expect(collectPersonMedia(bundle, 'p1')).toHaveLength(1);
    const fam = buildImmediateFamily(bundle, 'p1', peopleById);
    expect(fam.parents).toHaveLength(1);
    expect(fam.children).toHaveLength(1);

    const undatedEv: ArchiveEvent = { ...bundle.events[2], year: null };
    expect(buildTimelineScrubberTicks([undatedEv, bundle.events[0]])).toHaveLength(1);

    expect(resolvePortraitLightboxState(p2, [])).toBeNull();
    expect(resolvePortraitLightboxState(p1, bundle.media ?? [])).toEqual({ kind: 'gallery', index: 0 });
    expect(resolvePortraitLightboxState(p1, [])?.kind).toBe('single');

    const harbor = bundle.places[1];
    expect(resolveMatchingPlaceIds(bundle, harbor, 'exact', placesById).has('pl_harbor')).toBe(true);
    expect(resolveMatchingPlaceIds(bundle, harbor, 'radius15', placesById).has('pl_harbor')).toBe(true);
    expect(resolveMatchingPlaceIds(bundle, harbor, 'county', placesById).has('pl_far')).toBe(true);

    const evLate: ArchiveEvent = {
      ...bundle.events[0],
      id: 'ev_late_manual',
      year: 1895,
      place_id: 'pl_harbor',
      scope: 'family',
      participants: [
        { person_id: 'p1', role: 'head' },
        { person_id: 'p3', role: 'child' },
        { person_id: 'missing_p', role: 'witness' },
      ],
    };
    const evEarly: ArchiveEvent = {
      ...bundle.events[0],
      id: 'ev_early_manual',
      year: 1875,
      place_id: 'pl_harbor',
      scope: 'family',
      participants: [{ person_id: 'p1', role: 'head' }],
    };
    const occ = buildPlaceOccupancySummary(
      { ...bundle, events: [evLate, evEarly] },
      new Set(['pl_harbor']),
      peopleById
    );
    expect(occ.rows[0].startYear).toBe(1875);
    expect(occ.rows[0].endYear).toBe(1895);

    const localRecs = collectPlaceLocalRecords(bundle, new Set(['pl_harbor']));
    expect(localRecs).toHaveLength(2);
    expect(collectRecordDecades(localRecs)).toEqual([1880]);
    expect(buildPlacePhotoMedia(harbor)?.caption).toContain('Archival view of');
  });
});
