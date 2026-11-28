import type { ArchiveBundle, KinshipEdge, Person, Place } from '@kinloom/core';
import { describe, expect, it } from 'vitest';
import {
  ARCHIVAL_NODE_W,
  buildArchivalTreeModel,
  computeArchivalDiagramLayout,
  type DiagramPoint,
  resolveAnchorBranchFilter,
  searchTreePeople,
} from '../archivalTreeModel.js';
import { estimateTreeLabelWidthPx, fitTreeCardNameToWidth } from '../treeNodeDisplay.js';

interface BoxRect {
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
  readonly id: string;
}

function makeSyntheticPerson(
  id: string,
  fullName: string,
  opts: {
    readonly lineageGroup: Person['lineage_group'];
    readonly branch: string;
    readonly birthYear: number | null;
    readonly deathYear: number | null;
    readonly sex?: 'M' | 'F' | 'U';
    readonly isLiving?: boolean;
    readonly eventCount?: number;
  }
): Person {
  const parts = fullName.split(' ');
  return {
    id,
    slug: id.replaceAll('_', '-'),
    full_name: fullName,
    given_name: parts[0] ?? fullName,
    surname: parts.at(-1) ?? '',
    alt_names: [],
    sex: opts.sex ?? 'U',
    is_living: opts.isLiving ?? false,
    lineage_group: opts.lineageGroup,
    branch: opts.branch,
    birth_edtf: opts.birthYear !== null ? String(opts.birthYear) : '',
    death_edtf: opts.deathYear !== null ? String(opts.deathYear) : '',
    birth_year: opts.birthYear,
    death_year: opts.deathYear,
    portrait_url: null,
    event_count: opts.eventCount ?? 1,
    primary_place_id: 'plc_synth_harbor',
  };
}

/**
 * Purely synthetic 145-person, 12-generation, 4-branch asymmetric archive fixture:
 * - Branch 1 (alder_line): 8-gen ancestral trunk (G0..G7) + remarried pivot at G7 + 4-gen wide descendant fan (G8..G11)
 * - Branch 2 (mercer_line): 3-gen shallow ancestor branch marrying into G7 of alder_line
 * - Branch 3 (bramwell_line): 4-gen shallow branch marrying into G8
 * - Branch 4 (kestrel_line): disconnected 3-gen chronological branch (1838..1900)
 * Includes multi-marriages, early childhood losses ("Died young"), wide descendant fan-out, and long names.
 */
export function buildSynthetic145PersonArchive(): {
  readonly people: Person[];
  readonly kinship: KinshipEdge[];
  readonly bundle: ArchiveBundle;
} {
  const people: Person[] = [];
  const kinship: KinshipEdge[] = [];

  const addPerson = (p: Person): string => {
    people.push(p);
    return p.id;
  };
  const addSpouse = (a: string, b: string): void => {
    kinship.push({ from: a, to: b, relation: 'spouse' }, { from: b, to: a, relation: 'spouse' });
  };
  const addParents = (child: string, p1: string, p2?: string): void => {
    kinship.push({ from: p1, to: child, relation: 'parent' });
    if (p2) {
      kinship.push({ from: p2, to: child, relation: 'parent' });
    }
  };

  // Branch 1: 8-generation main ancestral line G0..G7 (16 people: 8 couples, with pivot at G7)
  const mainLineHusbands: string[] = [];
  const mainLineWives: string[] = [];
  for (let g = 0; g < 8; g += 1) {
    const birthYear = 1690 + g * 28;
    const isPivot = g === 7;
    const hName =
      g === 3
        ? 'Bartholomew Maximilian Alder-Waverly III'
        : isPivot
          ? 'Nathaniel Hawthorne Alder'
          : `Thomas${g} Alder`;
    const wName = g === 5 ? 'Wilhelmina Clementine Holloway-Quarry' : `Eleanor${g} Holloway`;
    const hId = addPerson(
      makeSyntheticPerson(`b1_g${g}_h`, hName, {
        lineageGroup: isPivot ? 'pivot_ancestor' : 'ancestor',
        branch: 'alder_line',
        birthYear,
        deathYear: birthYear + 68,
        sex: 'M',
        eventCount: isPivot ? 12 : 3,
      })
    );
    mainLineHusbands.push(hId);
    if (g < 7) {
      const wId = addPerson(
        makeSyntheticPerson(`b1_g${g}_w`, wName, {
          lineageGroup: 'ancestor',
          branch: 'alder_line',
          birthYear: birthYear + 3,
          deathYear: birthYear + 71,
          sex: 'F',
        })
      );
      mainLineWives.push(wId);
      addSpouse(hId, wId);
    }
    if (g > 0) {
      addParents(hId, mainLineHusbands[g - 1], mainLineWives[g - 1]);
    }
  }
  // 15 people so far (b1_g0..6 pairs = 14, plus b1_g7_h pivot = 15)

  // Branch 2 (mercer_line): Shallow 3-generation branch (G5 -> G6 -> G7) marrying into Pivot at G7!
  const b2g5h = addPerson(
    makeSyntheticPerson('b2_g5_h', 'Gideon Mercer', {
      lineageGroup: 'ancestor',
      branch: 'mercer_line',
      birthYear: 1830,
      deathYear: 1898,
      sex: 'M',
    })
  );
  const b2g5w = addPerson(
    makeSyntheticPerson('b2_g5_w', 'Patience Mercer', {
      lineageGroup: 'ancestor',
      branch: 'mercer_line',
      birthYear: 1833,
      deathYear: 1904,
      sex: 'F',
    })
  );
  addSpouse(b2g5h, b2g5w);

  const b2g6h = addPerson(
    makeSyntheticPerson('b2_g6_h', 'Caleb Mercer', {
      lineageGroup: 'ancestor',
      branch: 'mercer_line',
      birthYear: 1858,
      deathYear: 1928,
      sex: 'M',
    })
  );
  const b2g6w = addPerson(
    makeSyntheticPerson('b2_g6_w', 'Abigail Mercer', {
      lineageGroup: 'ancestor',
      branch: 'mercer_line',
      birthYear: 1861,
      deathYear: 1934,
      sex: 'F',
    })
  );
  addSpouse(b2g6h, b2g6w);
  addParents(b2g6h, b2g5h, b2g5w);

  // Collateral sibling of Caleb in G6 + cousin in G7 to test full subtree shift
  const b2g6sib = addPerson(
    makeSyntheticPerson('b2_g6_sib', 'Hannah Mercer', {
      lineageGroup: 'collateral',
      branch: 'mercer_line',
      birthYear: 1863,
      deathYear: 1931,
      sex: 'F',
    })
  );
  addParents(b2g6sib, b2g5h, b2g5w);
  const b2g7cousin = addPerson(
    makeSyntheticPerson('b2_g7_cousin', 'Lester Mercer', {
      lineageGroup: 'collateral',
      branch: 'mercer_line',
      birthYear: 1889,
      deathYear: 1962,
      sex: 'M',
    })
  );
  addParents(b2g7cousin, b2g6sib);

  // Marriage I wife of Pivot (b1_g7_h) comes from Branch 2 G7
  const b2g7bride = addPerson(
    makeSyntheticPerson('b2_g7_bride', 'Evangeline Constance Mercer', {
      lineageGroup: 'ancestor',
      branch: 'mercer_line',
      birthYear: 1888,
      deathYear: 1930,
      sex: 'F',
    })
  );
  addParents(b2g7bride, b2g6h, b2g6w);
  const pivotId = mainLineHusbands[7];
  addSpouse(pivotId, b2g7bride);

  // Marriage II wife of Pivot (remarriage with collapsed children + early loss)
  const pivotWife2 = addPerson(
    makeSyntheticPerson('b1_g7_w2', 'Beatrice Margaret Waverly', {
      lineageGroup: 'descendant_spouse',
      branch: 'alder_line',
      birthYear: 1898,
      deathYear: 1978,
      sex: 'F',
    })
  );
  addSpouse(pivotId, pivotWife2);
  // 23 people so far

  // Early childhood losses ("Died young") under Pivot Marriage I (2 infants) + Marriage II (1 infant)
  const infant1 = addPerson(
    makeSyntheticPerson('b1_g8_inf1', 'Samuel Alder', {
      lineageGroup: 'collateral',
      branch: 'alder_line',
      birthYear: 1912,
      deathYear: 1913,
      sex: 'M',
    })
  );
  const infant2 = addPerson(
    makeSyntheticPerson('b1_g8_inf2', 'Miriam Alder', {
      lineageGroup: 'collateral',
      branch: 'alder_line',
      birthYear: 1914,
      deathYear: 1916,
      sex: 'F',
    })
  );
  addParents(infant1, pivotId, b2g7bride);
  addParents(infant2, pivotId, b2g7bride);

  const infant3 = addPerson(
    makeSyntheticPerson('b1_g8_inf3', 'Ezra Alder', {
      lineageGroup: 'collateral',
      branch: 'alder_line',
      birthYear: 1933,
      deathYear: 1933,
      sex: 'M',
    })
  );
  addParents(infant3, pivotId, pivotWife2);

  // 4 collapsed collateral children under Pivot Marriage II (so Marriage II has collapsed siblings + Died young)
  for (let k = 0; k < 4; k += 1) {
    const halfId = addPerson(
      makeSyntheticPerson(`b1_g8_m2_c${k}`, `HalfChild${k} Alder`, {
        lineageGroup: 'collateral',
        branch: 'alder_line',
        birthYear: 1934 + k * 2,
        deathYear: 2005 + k,
      })
    );
    addParents(halfId, pivotId, pivotWife2);
  }
  // 30 people so far

  // Branch 3 (bramwell_line): 4-generation shallow branch (G5 -> G6 -> G7 -> G8) marrying into G8 focal child
  const b3Chain: string[] = [];
  for (let idx = 0; idx < 4; idx += 1) {
    const genYear = 1832 + idx * 28;
    const pId = addPerson(
      makeSyntheticPerson(`b3_n${idx}`, `BramwellAncestor${idx} Bramwell`, {
        lineageGroup: idx === 3 ? 'descendant_spouse' : 'collateral',
        branch: 'bramwell_line',
        birthYear: genYear,
        deathYear: genYear + 67,
      })
    );
    b3Chain.push(pId);
    if (idx > 0) {
      addParents(pId, b3Chain[idx - 1]);
    }
  }
  // 34 people so far (note b3_n0..n2 are collateral parents of descendant_spouse b3_n3, testing ghost-gen prevention!)

  // Branch 4 (kestrel_line): Disconnected 3-generation chronological branch (born 1834, 1862, 1890 -> aligns with G5..G7)
  const b4a = addPerson(
    makeSyntheticPerson('b4_g5', 'Rowan Kestrel', {
      lineageGroup: 'collateral',
      branch: 'kestrel_line',
      birthYear: 1834,
      deathYear: 1902,
      sex: 'M',
    })
  );
  const b4b = addPerson(
    makeSyntheticPerson('b4_g6', 'Nolan Kestrel', {
      lineageGroup: 'collateral',
      branch: 'kestrel_line',
      birthYear: 1862,
      deathYear: 1930,
      sex: 'M',
    })
  );
  const b4c = addPerson(
    makeSyntheticPerson('b4_g7', 'Clara Kestrel', {
      lineageGroup: 'collateral',
      branch: 'kestrel_line',
      birthYear: 1890,
      deathYear: 1966,
      sex: 'F',
    })
  );
  addParents(b4b, b4a);
  addParents(b4c, b4b);
  // 37 people so far

  // Wide modern descendant fan-out under Pivot Marriage I across G8 -> G9 -> G10 -> G11 (108 people -> total 145!)
  // G8: 6 surviving descendant children + 6 spouses (first marries b3_n3, other 5 get new spouses) = 11 new people (48 total)
  const g8Couples: { parent: string; spouse: string }[] = [];
  for (let i = 0; i < 6; i += 1) {
    const childId = addPerson(
      makeSyntheticPerson(
        `b1_g8_d${i}`,
        i === 0 ? 'Christopher Alexander Alder' : `DescendantG8N${i} Alder`,
        {
          lineageGroup: 'descendant',
          branch: 'alder_line',
          birthYear: 1915 + i * 2,
          deathYear: 1992 + i,
          eventCount: i === 0 ? 8 : 2,
        }
      )
    );
    addParents(childId, pivotId, b2g7bride);
    const spId =
      i === 0
        ? b3Chain[3]
        : addPerson(
            makeSyntheticPerson(`b1_g8_sp${i}`, `SpouseG8N${i} Quarry`, {
              lineageGroup: 'descendant_spouse',
              branch: 'alder_line',
              birthYear: 1917 + i * 2,
              deathYear: 1995 + i,
            })
          );
    addSpouse(childId, spId);
    g8Couples.push({ parent: childId, spouse: spId });
  }
  // 48 people so far

  // G9: 3 descendant children per G8 couple (18 children) + 12 spouses = 30 new people (78 total)
  const g9Couples: { parent: string; spouse: string }[] = [];
  for (let i = 0; i < g8Couples.length; i += 1) {
    for (let j = 0; j < 3; j += 1) {
      const idx = i * 3 + j;
      const cId = addPerson(
        makeSyntheticPerson(`b1_g9_d${idx}`, `DescendantG9N${idx} Alder`, {
          lineageGroup: 'descendant',
          branch: 'alder_line',
          birthYear: 1942 + j * 2,
          deathYear: 2018,
          eventCount: idx === 0 ? 6 : 1,
        })
      );
      addParents(cId, g8Couples[i].parent, g8Couples[i].spouse);
      if (j < 2) {
        const spId = addPerson(
          makeSyntheticPerson(`b1_g9_sp${idx}`, `SpouseG9N${idx} Finch`, {
            lineageGroup: 'descendant_spouse',
            branch: 'alder_line',
            birthYear: 1944 + j * 2,
            deathYear: 2020,
          })
        );
        addSpouse(cId, spId);
        g9Couples.push({ parent: cId, spouse: spId });
      }
    }
  }
  // 78 people so far

  // G10: 3 descendant children per G9 couple (36 children) + 12 spouses (1 per G9 couple's first child) = 48 new people (126 total)
  const g10Couples: { parent: string; spouse: string }[] = [];
  for (let i = 0; i < g9Couples.length; i += 1) {
    for (let j = 0; j < 3; j += 1) {
      const idx = i * 3 + j;
      const cId = addPerson(
        makeSyntheticPerson(`b1_g10_d${idx}`, `DescendantG10N${idx} Alder`, {
          lineageGroup: 'descendant',
          branch: 'alder_line',
          birthYear: 1969 + j * 2,
          deathYear: null,
          isLiving: false,
          eventCount: idx === 0 ? 5 : 1,
        })
      );
      addParents(cId, g9Couples[i].parent, g9Couples[i].spouse);
      if (j === 0) {
        const spId = addPerson(
          makeSyntheticPerson(`b1_g10_sp${idx}`, `SpouseG10N${idx} Brent`, {
            lineageGroup: 'descendant_spouse',
            branch: 'alder_line',
            birthYear: 1971,
            deathYear: null,
          })
        );
        addSpouse(cId, spId);
        g10Couples.push({ parent: cId, spouse: spId });
      }
    }
  }
  // 126 people so far

  // G11 (12th generation): 19 descendant children distributed across G10 couples -> 145 people total!
  for (let k = 0; k < 19; k += 1) {
    const couple = g10Couples[k % g10Couples.length];
    const cId = addPerson(
      makeSyntheticPerson(`b1_g11_d${k}`, `DescendantG11N${k} Alder`, {
        lineageGroup: 'descendant',
        branch: 'alder_line',
        birthYear: 1996 + (k % 6),
        deathYear: null,
      })
    );
    addParents(cId, couple.parent, couple.spouse);
  }

  const place: Place = {
    id: 'plc_synth_harbor',
    slug: 'synth-harbor',
    name: 'Harbor Point',
    full_name: 'Harbor Point, Maine, USA',
    place_type: 'town',
    parent_id: null,
    lat: 43.7,
    lng: -70.2,
  };

  const bundle: ArchiveBundle = {
    meta: {
      build_mode: 'public',
      generated_at: '2026-11-27T00:00:00Z',
      counts: {
        people: people.length,
        living_redacted: 0,
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

  return { people, kinship, bundle };
}

function polylineIntersectsRect(points: readonly DiagramPoint[], rect: BoxRect): boolean {
  for (let i = 0; i < points.length - 1; i += 1) {
    const a = points[i];
    const b = points[i + 1];
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
}

describe('Large 145-person 12-generation 4-branch asymmetric archive invariants', () => {
  it('aligns shallow branches chronologically to their marriage generation with 0 empty generation bands', () => {
    const { people, kinship } = buildSynthetic145PersonArchive();
    expect(people).toHaveLength(145);

    const fullModel = buildArchivalTreeModel({ people, kinship, mode: 'full' });
    expect(fullModel.generations).toHaveLength(12);
    expect(fullModel.generations.every((g) => g.units.length > 0 && g.personIds.length > 0)).toBe(true);

    // 8-gen main line: G0..G7
    expect(fullModel.genByPersonId.get('b1_g0_h')).toBe(0);
    expect(fullModel.genByPersonId.get('b1_g7_h')).toBe(7);

    // 3-gen mercer_line marrying into G7 shifts down coherently to G5, G6, G7 (never pinned at G0!)
    expect(fullModel.genByPersonId.get('b2_g5_h')).toBe(5);
    expect(fullModel.genByPersonId.get('b2_g6_h')).toBe(6);
    expect(fullModel.genByPersonId.get('b2_g6_sib')).toBe(6);
    expect(fullModel.genByPersonId.get('b2_g7_cousin')).toBe(7);
    expect(fullModel.genByPersonId.get('b2_g7_bride')).toBe(7);

    // 4-gen bramwell_line marrying into G8 shifts down coherently to G5..G8
    expect(fullModel.genByPersonId.get('b3_n0')).toBe(5);
    expect(fullModel.genByPersonId.get('b3_n1')).toBe(6);
    expect(fullModel.genByPersonId.get('b3_n2')).toBe(7);
    expect(fullModel.genByPersonId.get('b3_n3')).toBe(8);

    // Disconnected kestrel_line (born 1834..1890) aligns chronologically near G5..G7 instead of G0..G2
    expect(fullModel.genByPersonId.get('b4_g5')).toBe(5);
    expect(fullModel.genByPersonId.get('b4_g6')).toBe(6);
    expect(fullModel.genByPersonId.get('b4_g7')).toBe(7);
  });

  it('produces 0 drop-through-node collisions and 0 stem intersections with Died young strips or sibling pills', () => {
    const { people, kinship } = buildSynthetic145PersonArchive();
    for (const mode of ['full', 'spine'] as const) {
      const model = buildArchivalTreeModel({ people, kinship, mode });
      const layout = computeArchivalDiagramLayout(model);

      const nodeRects: BoxRect[] = layout.nodes.map((n) => ({
        id: n.person.id,
        left: n.x,
        right: n.x + n.width,
        top: n.y,
        bottom: n.y + n.height,
      }));
      const attachmentRects: BoxRect[] = [
        ...layout.earlyLossStrips.map((s) => ({
          id: `early:${s.unionId}`,
          left: s.x,
          right: s.x + s.width,
          top: s.y,
          bottom: s.y + s.height,
        })),
        ...layout.siblingToggles.map((t) => ({
          id: `toggle:${t.unionId}`,
          left: t.x,
          right: t.x + t.width,
          top: t.y,
          bottom: t.y + t.height,
        })),
      ];

      let dropsPassingThroughNodes = 0;
      let stemsHittingAttachments = 0;

      for (const bus of layout.buses) {
        const parentSet = new Set(bus.parentIds);
        for (const rect of attachmentRects) {
          if (polylineIntersectsRect(bus.stemPoints, rect)) {
            stemsHittingAttachments += 1;
          }
        }
        for (const rect of nodeRects) {
          if (!parentSet.has(rect.id) && polylineIntersectsRect(bus.stemPoints, rect)) {
            dropsPassingThroughNodes += 1;
          }
        }
        for (const drop of bus.childDrops) {
          for (const rect of nodeRects) {
            if (rect.id !== drop.childId && polylineIntersectsRect(drop.points, rect)) {
              dropsPassingThroughNodes += 1;
            }
          }
          for (const rect of attachmentRects) {
            if (polylineIntersectsRect(drop.points, rect)) {
              stemsHittingAttachments += 1;
            }
          }
        }
      }

      expect(dropsPassingThroughNodes).toBe(0);
      expect(stemsHittingAttachments).toBe(0);
    }
  });

  it('routes cross-generation jumps cleanly around intermediate rank cards with 0 collisions', () => {
    // Explicit cross-generation edge skipping 2 intermediate rows (e.g., documented pedigree anomaly)
    const people: Person[] = [
      makeSyntheticPerson('r0', 'Root Alder', {
        lineageGroup: 'ancestor',
        branch: 'alder_line',
        birthYear: 1750,
        deathYear: 1820,
      }),
      makeSyntheticPerson('r1', 'GenOne Alder', {
        lineageGroup: 'ancestor',
        branch: 'alder_line',
        birthYear: 1780,
        deathYear: 1850,
      }),
      makeSyntheticPerson('r2', 'GenTwo Alder', {
        lineageGroup: 'ancestor',
        branch: 'alder_line',
        birthYear: 1810,
        deathYear: 1880,
      }),
      makeSyntheticPerson('r3', 'GenThree Alder', {
        lineageGroup: 'descendant',
        branch: 'alder_line',
        birthYear: 1840,
        deathYear: 1910,
      }),
    ];
    const kinship: KinshipEdge[] = [
      { from: 'r0', to: 'r1', relation: 'parent' },
      { from: 'r1', to: 'r2', relation: 'parent' },
      { from: 'r2', to: 'r3', relation: 'parent' },
      { from: 'r0', to: 'r3', relation: 'parent' },
    ];
    const model = buildArchivalTreeModel({ people, kinship, mode: 'full' });
    const layout = computeArchivalDiagramLayout(model);

    const nodeRects: BoxRect[] = layout.nodes.map((n) => ({
      id: n.person.id,
      left: n.x,
      right: n.x + n.width,
      top: n.y,
      bottom: n.y + n.height,
    }));

    let hits = 0;
    for (const bus of layout.buses) {
      for (const drop of bus.childDrops) {
        for (const rect of nodeRects) {
          if (rect.id !== drop.childId && polylineIntersectsRect(drop.points, rect)) {
            hits += 1;
          }
        }
      }
    }
    expect(hits).toBe(0);
  });

  it('keeps Direct Line (spine) mode bounded with 0 empty generations and collapsible descendant pills', () => {
    const { people, kinship } = buildSynthetic145PersonArchive();
    const fullModel = buildArchivalTreeModel({ people, kinship, mode: 'full' });
    const spineModel = buildArchivalTreeModel({ people, kinship, mode: 'spine' });

    expect(spineModel.effectiveMode).toBe('spine');
    expect(spineModel.generations.length).toBeGreaterThanOrEqual(8);
    expect(spineModel.generations.every((g) => g.units.length > 0 && g.personIds.length > 0)).toBe(true);

    const fullLayout = computeArchivalDiagramLayout(fullModel);
    const spineLayout = computeArchivalDiagramLayout(spineModel);

    const fullWidth = fullLayout.bounds.maxX - fullLayout.bounds.minX;
    const spineWidth = spineLayout.bounds.maxX - spineLayout.bounds.minX;
    expect(spineWidth).toBeLessThan(fullWidth * 0.45);
    expect(spineLayout.siblingToggles.length).toBeGreaterThanOrEqual(2);
  });

  it('fits long bold serif card names strictly within detail card text width', () => {
    const detailTextBudget = ARCHIVAL_NODE_W - 44 - 10;
    const longNames = [
      'Bartholomew Maximilian Alder-Waverly III',
      'Wilhelmina Clementine Holloway-Quarry',
      'Evangeline Constance Mercer',
      'Christopher Alexander Alder',
      'WWWWWWWWWWWWWWWWWWWW',
    ];
    for (const name of longNames) {
      const fitted = fitTreeCardNameToWidth(name, detailTextBudget, 11.5);
      expect(estimateTreeLabelWidthPx(fitted, 11.5)).toBeLessThanOrEqual(detailTextBudget);
      expect(fitted.length).toBeGreaterThan(0);
    }
  });

  it('dynamically computes upward ancestor spine for any anchorPersonId with zero empty generations or drop collisions', () => {
    const { people, kinship } = buildSynthetic145PersonArchive();
    const baseline = buildArchivalTreeModel({ people, kinship, mode: 'spine' });
    const explicitNull = buildArchivalTreeModel({ people, kinship, mode: 'spine', anchorPersonId: null });
    expect(explicitNull.anchorPersonId).toBeNull();
    expect([...explicitNull.directPersonIds]).toEqual([...baseline.directPersonIds]);

    const parentMap = new Map<string, string[]>();
    const childMap = new Map<string, string[]>();
    for (const edge of kinship) {
      if (edge.relation === 'parent') {
        const parents = parentMap.get(edge.to) ?? [];
        parents.push(edge.from);
        parentMap.set(edge.to, parents);
        const children = childMap.get(edge.from) ?? [];
        children.push(edge.to);
        childMap.set(edge.from, children);
      }
    }

    const computeExpectedAncestors = (startId: string): Set<string> => {
      const expected = new Set<string>([startId]);
      const queue = [startId];
      while (queue.length > 0) {
        const cur = queue.shift();
        if (!cur) continue;
        for (const pid of parentMap.get(cur) ?? []) {
          if (!expected.has(pid)) {
            expected.add(pid);
            queue.push(pid);
          }
        }
      }
      return expected;
    };

    const anchorIds = ['b1_g11_d5', 'b2_g7_cousin', 'b3_n3', 'b1_g5_h', 'b1_g0_h', 'b1_g8_inf1'];
    for (const anchorId of anchorIds) {
      const expectedAncestors = computeExpectedAncestors(anchorId);
      const directChildrenOfAnchor = childMap.get(anchorId) ?? [];

      for (const mode of ['spine', 'full'] as const) {
        const model = buildArchivalTreeModel({
          people,
          kinship,
          mode,
          anchorPersonId: anchorId,
        });
        expect(model.anchorPersonId).toBe(anchorId);
        expect(model.pivotPersonId).toBe(anchorId);
        expect(model.effectiveMode).toBe(mode);
        expect([...model.directPersonIds].toSorted()).toEqual([...expectedAncestors].toSorted());

        for (const childId of directChildrenOfAnchor) {
          expect(model.directPersonIds.has(childId)).toBe(false);
        }

        expect(model.generations.every((g) => g.units.length > 0 && g.personIds.length > 0)).toBe(true);

        const layout = computeArchivalDiagramLayout(model);
        expect(layout.byId.has(anchorId)).toBe(true);

        // Pairwise non-overlapping nodes
        for (let i = 0; i < layout.nodes.length; i += 1) {
          const a = layout.nodes[i];
          for (let j = i + 1; j < layout.nodes.length; j += 1) {
            const b = layout.nodes[j];
            const overlaps =
              a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
            expect(overlaps).toBe(false);
          }
        }

        // Zero drop-through-node collisions
        const nodeRects: BoxRect[] = layout.nodes.map((n) => ({
          id: n.person.id,
          left: n.x,
          right: n.x + n.width,
          top: n.y,
          bottom: n.y + n.height,
        }));
        let hits = 0;
        for (const bus of layout.buses) {
          const parentSet = new Set(bus.parentIds);
          for (const rect of nodeRects) {
            if (!parentSet.has(rect.id) && polylineIntersectsRect(bus.stemPoints, rect)) {
              hits += 1;
            }
          }
          for (const drop of bus.childDrops) {
            for (const rect of nodeRects) {
              if (rect.id !== drop.childId && polylineIntersectsRect(drop.points, rect)) {
                hits += 1;
              }
            }
          }
        }
        expect(hits).toBe(0);
      }
    }

    // Early-loss person promoted out of earlyLossIds when explicitly anchored
    const infantModel = buildArchivalTreeModel({
      people,
      kinship,
      mode: 'spine',
      anchorPersonId: 'b1_g8_inf1',
    });
    expect(infantModel.earlyLossIds.has('b1_g8_inf1')).toBe(false);
    expect(computeArchivalDiagramLayout(infantModel).byId.has('b1_g8_inf1')).toBe(true);

    // Redacted living placeholder safely falls back to anchorPersonId: null
    const redactedLiving: Person = makeSyntheticPerson('per_redacted_living', 'Living', {
      lineageGroup: 'descendant',
      branch: 'alder_line',
      birthYear: null,
      deathYear: null,
      isLiving: true,
    });
    const fallbackModel = buildArchivalTreeModel({
      people: [...people, redactedLiving],
      kinship: [...kinship, { from: 'b1_g10_d0', to: 'per_redacted_living', relation: 'parent' }],
      mode: 'spine',
      anchorPersonId: 'per_redacted_living',
    });
    expect(fallbackModel.anchorPersonId).toBeNull();
    expect(fallbackModel.peopleById.has('per_redacted_living')).toBe(false);

    // Cross-branch anchor clears conflicting branch filter (maternal mercer_line ancestor of alder_line descendant)
    const peopleById = new Map(people.map((p) => [p.id, p]));
    const g11Person = peopleById.get('b1_g11_d0');
    const g0Person = peopleById.get('b1_g0_h');
    const cousinPerson = peopleById.get('b2_g7_cousin');
    if (!g11Person || !g0Person || !cousinPerson) throw new Error('missing fixture people');

    expect(
      resolveAnchorBranchFilter({
        anchorPerson: g11Person,
        currentBranchFilter: 'alder_line',
        defaultBranchId: 'alder_line',
        peopleById,
        kinship,
      })
    ).toEqual({ nextBranchFilter: 'all', clearedBranch: true });

    expect(
      resolveAnchorBranchFilter({
        anchorPerson: g0Person,
        currentBranchFilter: 'alder_line',
        defaultBranchId: 'alder_line',
        peopleById,
        kinship,
      })
    ).toEqual({ nextBranchFilter: 'alder_line', clearedBranch: false });

    expect(
      resolveAnchorBranchFilter({
        anchorPerson: cousinPerson,
        currentBranchFilter: 'alder_line',
        defaultBranchId: 'alder_line',
        peopleById,
        kinship,
      })
    ).toEqual({ nextBranchFilter: 'all', clearedBranch: true });

    // Anchor candidate ranking favors deeper generations and active anchor first
    const anchoredModel = buildArchivalTreeModel({
      people,
      kinship,
      mode: 'spine',
      anchorPersonId: 'b1_g11_d5',
    });
    const ranked = searchTreePeople({
      query: '',
      people,
      buildMode: 'public',
      model: anchoredModel,
      branchFilter: 'all',
      defaultBranchId: 'alder_line',
      branchLabelsById: new Map([['alder_line', 'Alder Line']]),
      limit: 5,
      rankingMode: 'anchor',
    });
    expect(ranked[0]?.person.id).toBe('b1_g11_d5');
    expect(ranked[1]?.genLabel).toBe('G12');
  });
});
