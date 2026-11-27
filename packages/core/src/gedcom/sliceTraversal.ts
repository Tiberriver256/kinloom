import type { GedcomFam, GedcomIndi } from './parse.js';
import type { GedcomLineageSelection, SliceGedcomOptions } from './sliceTypes.js';

export function resolveRootXref(indis: ReadonlyMap<string, GedcomIndi>, options: SliceGedcomOptions): string {
  let rootXref = options.rootXref ?? '';
  if (!rootXref && options.rootName) {
    const needle = options.rootName.trim().toLowerCase();
    for (const ind of indis.values()) {
      if (ind.fullName.toLowerCase() === needle || ind.altNames.some((alt) => alt.toLowerCase() === needle)) {
        rootXref = ind.xref;
        break;
      }
    }
  }
  if (!rootXref || !indis.has(rootXref)) {
    throw new Error(
      `Root individual not found in GEDCOM (rootXref=${options.rootXref ?? ''}, rootName=${options.rootName ?? ''})`
    );
  }
  return rootXref;
}

export function selectGedcomLineage(
  indis: ReadonlyMap<string, GedcomIndi>,
  fams: ReadonlyMap<string, GedcomFam>,
  options: SliceGedcomOptions
): GedcomLineageSelection {
  const includeAncestorSiblings = options.includeAncestorSiblings ?? true;
  const includeDescendantSpouses = options.includeDescendantSpouses ?? true;
  const expandSpouseAncestors = options.expandSpouseAncestors ?? false;
  const stopDescendants = new Set(options.stopDescendantXrefs ?? []);
  const ancestorSurnamesLower = (options.ancestorSurnames ?? [])
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  const rootXref = resolveRootXref(indis, options);

  const ancestors: string[] = [];
  const visitedAnc = new Set<string>();
  const ancestorFamilies: string[] = [];

  const matchesAncestorSurname = (ind: GedcomIndi): boolean => {
    if (ancestorSurnamesLower.length === 0) {
      return expandSpouseAncestors;
    }
    const lowerFull = ind.fullName.toLowerCase();
    const lowerSur = ind.surname.toLowerCase();
    return ancestorSurnamesLower.some((target) => lowerSur === target || lowerFull.includes(target));
  };

  const walkAncestors = (xref: string, expandParents: boolean, depth: number): void => {
    if (!xref || !indis.has(xref) || visitedAnc.has(xref)) {
      return;
    }
    visitedAnc.add(xref);
    ancestors.push(xref);
    if (!expandParents) {
      return;
    }
    if (options.maxAncestorDepth !== undefined && depth >= options.maxAncestorDepth) {
      return;
    }
    const ind = indis.get(xref);
    if (!ind) {
      return;
    }
    for (const fid of ind.famc) {
      const fam = fams.get(fid);
      if (!fam) {
        continue;
      }
      if (!ancestorFamilies.includes(fid)) {
        ancestorFamilies.push(fid);
      }
      for (const parentXref of [fam.husb, fam.wife]) {
        if (!parentXref || !indis.has(parentXref)) {
          continue;
        }
        const parentInd = indis.get(parentXref);
        if (!parentInd) {
          continue;
        }
        const keepWalking =
          expandSpouseAncestors ||
          (ancestorSurnamesLower.length > 0 ? matchesAncestorSurname(parentInd) : parentXref === fam.husb);
        walkAncestors(parentXref, keepWalking, depth + 1);
      }
    }
  };

  walkAncestors(rootXref, true, 0);

  const ancestorSiblings: string[] = [];
  if (includeAncestorSiblings) {
    for (const fid of ancestorFamilies) {
      const fam = fams.get(fid);
      if (!fam) {
        continue;
      }
      for (const cid of fam.children) {
        if (indis.has(cid) && !visitedAnc.has(cid) && !ancestorSiblings.includes(cid)) {
          ancestorSiblings.push(cid);
        }
      }
    }
  }

  const descendants: string[] = [];
  const descendantSpouses: string[] = [];
  const descendantFamilies: string[] = [];
  const visitedDesc = new Set<string>();

  const walkDescendants = (xref: string, depth: number): void => {
    if (!xref || !indis.has(xref) || visitedDesc.has(xref)) {
      return;
    }
    visitedDesc.add(xref);
    descendants.push(xref);
    const ind = indis.get(xref);
    if (!ind) {
      return;
    }
    for (const fid of ind.fams) {
      const fam = fams.get(fid);
      if (!fam) {
        continue;
      }
      if (!descendantFamilies.includes(fid)) {
        descendantFamilies.push(fid);
      }
      if (includeDescendantSpouses) {
        const sp = fam.husb === xref ? fam.wife : fam.husb;
        if (sp && indis.has(sp) && !descendantSpouses.includes(sp) && !visitedDesc.has(sp)) {
          descendantSpouses.push(sp);
        }
      }
      if (stopDescendants.has(xref)) {
        continue;
      }
      if (options.maxDescendantDepth !== undefined && depth >= options.maxDescendantDepth) {
        continue;
      }
      for (const cid of fam.children) {
        walkDescendants(cid, depth + 1);
      }
    }
  };

  walkDescendants(rootXref, 0);

  const orderedXrefs = [
    ...new Set([...descendants, ...ancestors, ...ancestorSiblings, ...descendantSpouses]),
  ];
  const allFamilyIds = [...new Set([...ancestorFamilies, ...descendantFamilies])];

  const bucketByXref = new Map<string, string>();
  for (const x of ancestors) {
    bucketByXref.set(x, 'ancestor');
  }
  for (const x of ancestorSiblings) {
    if (!bucketByXref.has(x)) {
      bucketByXref.set(x, 'colonial_sibling');
    }
  }
  for (const x of descendants) {
    bucketByXref.set(x, 'descendant');
  }
  for (const x of descendantSpouses) {
    if (!bucketByXref.has(x)) {
      bucketByXref.set(x, 'descendant_spouse');
    }
  }
  bucketByXref.set(rootXref, 'pivot_ancestor');

  return {
    rootXref,
    ancestors,
    ancestorSiblings,
    descendants,
    descendantSpouses,
    orderedXrefs,
    allFamilyIds,
    bucketByXref,
  };
}
