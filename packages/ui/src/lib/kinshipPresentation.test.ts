import type { KinshipPathResult } from '@kinloom/core';
import { describe, expect, it } from 'vitest';
import { formatKinshipPresentation } from './kinshipPresentation.js';

function makeResult(overrides: Partial<KinshipPathResult>): KinshipPathResult {
  return {
    connected: true,
    steps: [],
    personIds: [],
    relationshipLabel: 'Same person',
    overlapYears: null,
    sharedPlaces: [],
    ...overrides,
  };
}

describe('formatKinshipPresentation', () => {
  it('formats identical person selection without broken grammar', () => {
    const out = formatKinshipPresentation({
      fromId: 'per_alice',
      toId: 'per_alice',
      personAName: 'Alice Mercer',
      personBName: 'Alice Mercer',
      result: makeResult({
        connected: true,
        personIds: ['per_alice'],
        relationshipLabel: 'Same person',
      }),
    });

    const fullHeading = `${out.headingPrefix}${out.highlight}${out.headingSuffix}`;
    expect(out.kind).toBe('same_person');
    expect(fullHeading).toBe('Same person selected: Alice Mercer');
    expect(fullHeading).not.toContain('is the Same person');
    expect(out.hopsValue).toBe('0 steps');
  });

  it('formats unconnected pair without broken grammar', () => {
    const out = formatKinshipPresentation({
      fromId: 'per_alice',
      toId: 'per_bob',
      personAName: 'Alice Mercer',
      personBName: 'Bob Vance',
      result: makeResult({
        connected: false,
        relationshipLabel: 'No documented kinship path in this archive slice',
      }),
    });

    const fullHeading = `${out.headingPrefix}${out.highlight}${out.headingSuffix}`;
    expect(out.kind).toBe('unconnected');
    expect(fullHeading).toBe('No documented kinship path between Alice Mercer and Bob Vance');
    expect(fullHeading).not.toContain('is the No documented');
    expect(out.hopsValue).toBe('No documented link');
    expect(out.sharedPlacesEmptyText).toBe('No shared places recorded');
  });

  it('formats direct ancestor/descendant relationships grammatically', () => {
    const out = formatKinshipPresentation({
      fromId: 'per_thomas',
      toId: 'per_abraham',
      personAName: 'Thomas Mercer',
      personBName: 'Abraham Mercer',
      result: makeResult({
        connected: true,
        steps: [{ fromId: 'per_thomas', toId: 'per_abraham', relation: 'parent' }],
        personIds: ['per_thomas', 'per_abraham'],
        relationshipLabel: 'Parent of',
      }),
    });

    const fullHeading = `${out.headingPrefix}${out.highlight}${out.headingSuffix}`;
    expect(out.kind).toBe('connected_of');
    expect(fullHeading).toBe('Thomas Mercer is the Parent of Abraham Mercer');
    expect(out.hopsValue).toBe('1 step');
    expect(out.subtitle).toBe('Traced through documented family links');
  });

  it('formats collateral and marriage-step relationships cleanly', () => {
    const cousin = formatKinshipPresentation({
      fromId: 'per_a',
      toId: 'per_b',
      personAName: 'Clara Mercer',
      personBName: 'Henry Mercer',
      result: makeResult({
        connected: true,
        steps: [
          { fromId: 'per_a', toId: 'per_p1', relation: 'child' },
          { fromId: 'per_p1', toId: 'per_gp', relation: 'child' },
          { fromId: 'per_gp', toId: 'per_p2', relation: 'parent' },
          { fromId: 'per_p2', toId: 'per_b', relation: 'parent' },
        ],
        personIds: ['per_a', 'per_p1', 'per_gp', 'per_p2', 'per_b'],
        relationshipLabel: '1st Cousin of',
      }),
    });
    expect(`${cousin.headingPrefix}${cousin.highlight}${cousin.headingSuffix}`).toBe(
      'Clara Mercer is the 1st Cousin of Henry Mercer'
    );
    expect(cousin.hopsValue).toBe('4 steps');

    const byMarriage = formatKinshipPresentation({
      fromId: 'per_a',
      toId: 'per_c',
      personAName: 'Clara Mercer',
      personBName: 'Owen Vance',
      result: makeResult({
        connected: true,
        steps: [
          { fromId: 'per_a', toId: 'per_m1', relation: 'spouse' },
          { fromId: 'per_m1', toId: 'per_m2', relation: 'parent' },
          { fromId: 'per_m2', toId: 'per_c', relation: 'spouse' },
        ],
        personIds: ['per_a', 'per_m1', 'per_m2', 'per_c'],
        relationshipLabel: 'Related by marriage (3 steps)',
      }),
    });
    expect(byMarriage.kind).toBe('connected_phrase');
    expect(`${byMarriage.headingPrefix}${byMarriage.highlight}${byMarriage.headingSuffix}`).toBe(
      'Clara Mercer and Owen Vance: Related by marriage (3 steps)'
    );
  });
});
