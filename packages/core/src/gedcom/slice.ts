import { getCurrentReferenceYear } from '../clock.js';
import { DEFAULT_LIVING_CUTOFF_YEARS } from '../privacy/policy.js';
import { parseGedcomText } from './parse.js';
import {
  buildSliceEventsAndSources,
  buildSliceKinship,
  buildSlicePeople,
  collectRawSlicePlaces,
} from './sliceBuilders.js';
import { buildPlacesFromRaw } from './sliceNormalization.js';
import { selectGedcomLineage } from './sliceTraversal.js';
import type { SliceGedcomOptions, SliceGedcomResult } from './sliceTypes.js';

export type { KnownPlaceCoords, SliceGedcomOptions, SliceGedcomResult } from './sliceTypes.js';

/**
 * Generic GEDCOM slice seeder: extracts a lineage slice from a combined GEDCOM export,
 * normalizes maiden/birth names as primary, respects spine + complete siblings + spouse pairing
 * without upstream spouse-parent subtrees unless configured, and emits raw Kinloom entities.
 */
export function sliceGedcom(gedcomText: string, options: SliceGedcomOptions): SliceGedcomResult {
  const { indis, fams, sours, repos } = parseGedcomText(gedcomText);

  const normalizeMaidenNames = options.normalizeMaidenNames ?? true;
  const branchId = options.branchId ?? 'primary';
  const referenceYear = options.referenceYear ?? getCurrentReferenceYear();
  const livingCutoffYears = options.livingCutoffYears ?? DEFAULT_LIVING_CUTOFF_YEARS;

  const selection = selectGedcomLineage(indis, fams, options);
  const rawPlaces = collectRawSlicePlaces(indis, fams, selection);
  const { placesById, rawToPlaceId } = buildPlacesFromRaw(rawPlaces, options.knownPlaces);

  const { people, xrefToPid, normalizedNamesByXref } = buildSlicePeople({
    indis,
    fams,
    selection,
    normalizeMaidenNames,
    branchId,
    referenceYear,
    livingCutoffYears,
  });

  const kinship = buildSliceKinship(fams, selection.allFamilyIds, xrefToPid);

  const { events, sources, anomalies } = buildSliceEventsAndSources({
    indis,
    fams,
    sours,
    repos,
    selection,
    xrefToPid,
    normalizedNamesByXref,
    placesById,
    rawToPlaceId,
  });

  return {
    rootXref: selection.rootXref,
    people,
    events,
    places: [...placesById.values()],
    sources,
    kinship,
    anomalies,
    stats: {
      totalGedcomIndividuals: indis.size,
      ancestors: selection.ancestors.length,
      ancestorSiblings: selection.ancestorSiblings.length,
      descendants: selection.descendants.length,
      descendantSpouses: selection.descendantSpouses.length,
      totalPeople: people.length,
      totalEvents: events.length,
      totalPlaces: placesById.size,
      totalSources: sources.length,
      totalKinshipEdges: kinship.length,
    },
  };
}
