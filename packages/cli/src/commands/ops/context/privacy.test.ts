import { DEFAULT_LIVING_CUTOFF_YEARS } from '@kinloom/core';
import { describe, expect, it } from 'vitest';
import { isConfirmedDeceasedRelative, isEffectiveLivingRecord } from './privacy.js';

describe('context privacy living-cutoff delegation', () => {
  it('respects custom livingCutoffYears for event-year living detection and confirmed-deceased checks', () => {
    const personWithoutBirth = {
      id: 'per_event_only',
      is_living: false,
      birth_edtf: '',
      death_edtf: '',
    };
    const event1920 = [{ edtf_date: '1920-05-01' }];

    expect(
      isEffectiveLivingRecord(personWithoutBirth, event1920, {
        referenceYear: 2026,
        livingCutoffYears: DEFAULT_LIVING_CUTOFF_YEARS,
      })
    ).toBe(false);

    expect(
      isEffectiveLivingRecord(personWithoutBirth, event1920, {
        referenceYear: 2026,
        livingCutoffYears: 120,
      })
    ).toBe(true);

    const personBorn1920 = {
      id: 'per_born_1920',
      is_living: false,
      birth_edtf: '1920',
      death_edtf: '',
    };

    expect(
      isConfirmedDeceasedRelative(personBorn1920, new Set(), {
        referenceYear: 2026,
        livingCutoffYears: DEFAULT_LIVING_CUTOFF_YEARS,
      })
    ).toBe(true);

    expect(
      isConfirmedDeceasedRelative(personBorn1920, new Set(), {
        referenceYear: 2026,
        livingCutoffYears: 120,
      })
    ).toBe(false);

    expect(
      isConfirmedDeceasedRelative(
        { id: 'per_undated', is_living: false, birth_edtf: '', death_edtf: '' },
        new Set(),
        { referenceYear: 2026, livingCutoffYears: 101 }
      )
    ).toBe(false);
  });
});
