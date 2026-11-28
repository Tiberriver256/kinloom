import type { KinshipPathResult, KinshipStep, Person } from '@kinloom/core';

export interface KinshipSummaryPresentation {
  readonly kind: 'same_person' | 'unconnected' | 'connected_of' | 'connected_phrase';
  readonly headingPrefix: string;
  readonly highlight: string;
  readonly headingSuffix: string;
  readonly subtitle: string;
  readonly hopsValue: string;
  readonly sharedPlacesEmptyText: string;
}

export type KinshipNodeRole = 'endpoint' | 'ascending' | 'apex' | 'descending' | 'linear';

export interface KinshipTopologyNode {
  readonly personId: string;
  readonly index: number;
  readonly edgeFromPrev: KinshipStep['relation'] | null;
  readonly role: KinshipNodeRole;
}

export type KinshipTopology =
  | {
      readonly topology: 'v';
      readonly ascending: readonly KinshipTopologyNode[];
      readonly apex: KinshipTopologyNode;
      readonly descending: readonly KinshipTopologyNode[];
      readonly orderedNodes: readonly KinshipTopologyNode[];
    }
  | {
      readonly topology: 'linear';
      readonly ascending: readonly [];
      readonly apex: null;
      readonly descending: readonly [];
      readonly orderedNodes: readonly KinshipTopologyNode[];
    };

export interface LifespanBarGeometry {
  readonly startYear: number;
  readonly endYear: number;
  readonly leftPct: number;
  readonly widthPct: number;
}

export interface LifespanOverlapSparkline {
  readonly minYear: number;
  readonly maxYear: number;
  readonly personA: LifespanBarGeometry;
  readonly personB: LifespanBarGeometry;
  readonly overlap: {
    readonly startYear: number;
    readonly endYear: number;
    readonly durationYears: number;
    readonly leftPct: number;
    readonly widthPct: number;
  } | null;
}

/**
 * Formats grammatical, ubiquitous-language summary copy for Kinship Finder results.
 */
export function formatKinshipPresentation(params: {
  readonly fromId: string;
  readonly toId: string;
  readonly personAName: string;
  readonly personBName: string;
  readonly result: KinshipPathResult;
}): KinshipSummaryPresentation {
  const { fromId, toId, personAName, personBName, result } = params;

  if (fromId === toId) {
    return {
      kind: 'same_person',
      headingPrefix: 'Same person selected: ',
      highlight: personAName,
      headingSuffix: '',
      subtitle: 'Choose two different people to trace a documented kinship path.',
      hopsValue: '0 steps',
      sharedPlacesEmptyText: 'No places recorded yet',
    };
  }

  if (!result.connected) {
    return {
      kind: 'unconnected',
      headingPrefix: 'No documented kinship path between ',
      highlight: `${personAName} and ${personBName}`,
      headingSuffix: '',
      subtitle: 'No documented family link connects these two records in this archive.',
      hopsValue: 'No documented link',
      sharedPlacesEmptyText: 'No shared places recorded',
    };
  }

  const label = result.relationshipLabel.trim();
  const hopsValue = `${result.steps.length} step${result.steps.length === 1 ? '' : 's'}`;

  if (/\bof$/i.test(label)) {
    return {
      kind: 'connected_of',
      headingPrefix: `${personAName} is the `,
      highlight: label,
      headingSuffix: ` ${personBName}`,
      subtitle: 'Traced through documented family links',
      hopsValue,
      sharedPlacesEmptyText: 'No shared places recorded',
    };
  }

  return {
    kind: 'connected_phrase',
    headingPrefix: `${personAName} and ${personBName}: `,
    highlight: label,
    headingSuffix: '',
    subtitle: 'Traced through documented family links',
    hopsValue,
    sharedPlacesEmptyText: 'No shared places recorded',
  };
}

/**
 * Partitions a connected kinship path into an ascend -> MRCA apex -> descend V-topology
 * when it climbs via `child` edges and descends via `parent` edges, or a `linear` chain otherwise.
 */
export function partitionKinshipTopology(
  personIds: readonly string[],
  steps: readonly KinshipStep[]
): KinshipTopology {
  if (personIds.length < 3 || steps.length !== personIds.length - 1) {
    const orderedNodes: KinshipTopologyNode[] = personIds.map((personId, index) => ({
      personId,
      index,
      edgeFromPrev: index > 0 ? (steps[index - 1]?.relation ?? null) : null,
      role: index === 0 || index === personIds.length - 1 ? 'endpoint' : 'linear',
    }));
    return { topology: 'linear', ascending: [], apex: null, descending: [], orderedNodes };
  }

  let apexIndex = -1;
  let seenParent = false;
  let validV = true;

  for (let i = 0; i < steps.length; i += 1) {
    const rel = steps[i].relation;
    if (rel === 'child') {
      if (seenParent) {
        validV = false;
        break;
      }
    } else if (rel === 'parent') {
      if (!seenParent) {
        if (i === 0) {
          validV = false;
          break;
        }
        seenParent = true;
        apexIndex = i;
      }
    } else {
      validV = false;
      break;
    }
  }

  if (!validV || apexIndex <= 0 || apexIndex >= personIds.length - 1) {
    const orderedNodes: KinshipTopologyNode[] = personIds.map((personId, index) => ({
      personId,
      index,
      edgeFromPrev: index > 0 ? steps[index - 1].relation : null,
      role: index === 0 || index === personIds.length - 1 ? 'endpoint' : 'linear',
    }));
    return { topology: 'linear', ascending: [], apex: null, descending: [], orderedNodes };
  }

  const orderedNodes: KinshipTopologyNode[] = personIds.map((personId, index) => {
    let role: KinshipNodeRole = 'descending';
    if (index === apexIndex) {
      role = 'apex';
    } else if (index === 0 || index === personIds.length - 1) {
      role = 'endpoint';
    } else if (index < apexIndex) {
      role = 'ascending';
    }
    return {
      personId,
      index,
      edgeFromPrev: index > 0 ? steps[index - 1].relation : null,
      role,
    };
  });

  return {
    topology: 'v',
    ascending: orderedNodes.slice(0, apexIndex),
    apex: orderedNodes[apexIndex],
    descending: orderedNodes.slice(apexIndex + 1),
    orderedNodes,
  };
}

/**
 * Computes normalized dual-bar coordinates for a compact lifespan overlap sparkline.
 */
export function computeLifespanOverlapSparkline(
  personA: Pick<Person, 'birth_year' | 'death_year' | 'is_living'>,
  personB: Pick<Person, 'birth_year' | 'death_year' | 'is_living'>,
  overlapYears: KinshipPathResult['overlapYears'],
  referenceYear = new Date().getUTCFullYear()
): LifespanOverlapSparkline | null {
  if (personA.birth_year === null || personB.birth_year === null) {
    return null;
  }

  const aStart = personA.birth_year;
  const bStart = personB.birth_year;
  const aEnd = Math.max(aStart, personA.death_year ?? (personA.is_living ? referenceYear : aStart + 72));
  const bEnd = Math.max(bStart, personB.death_year ?? (personB.is_living ? referenceYear : bStart + 72));

  const minYear = Math.min(aStart, bStart);
  const maxYear = Math.max(aEnd, bEnd);
  const span = Math.max(1, maxYear - minYear);

  const toBar = (startYear: number, endYear: number): LifespanBarGeometry => ({
    startYear,
    endYear,
    leftPct: Number((((startYear - minYear) / span) * 100).toFixed(2)),
    widthPct: Number(Math.max(2, (Math.max(1, endYear - startYear) / span) * 100).toFixed(2)),
  });

  return {
    minYear,
    maxYear,
    personA: toBar(aStart, aEnd),
    personB: toBar(bStart, bEnd),
    overlap: overlapYears
      ? {
          startYear: overlapYears.start,
          endYear: overlapYears.end,
          durationYears: overlapYears.durationYears,
          leftPct: Number((((overlapYears.start - minYear) / span) * 100).toFixed(2)),
          widthPct: Number(
            Math.max(2, (Math.max(1, overlapYears.end - overlapYears.start) / span) * 100).toFixed(2)
          ),
        }
      : null,
  };
}
