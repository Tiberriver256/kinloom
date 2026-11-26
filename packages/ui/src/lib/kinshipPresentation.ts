import type { KinshipPathResult } from '@kinloom/core';

export interface KinshipSummaryPresentation {
  readonly kind: 'same_person' | 'unconnected' | 'connected_of' | 'connected_phrase';
  readonly headingPrefix: string;
  readonly highlight: string;
  readonly headingSuffix: string;
  readonly subtitle: string;
  readonly hopsValue: string;
  readonly sharedPlacesEmptyText: string;
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
