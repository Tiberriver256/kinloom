import type { PluginSettingsSnapshot } from '@kinloom/core';
import { describe, expect, it } from 'vitest';
import {
  buildPluginSettingsSubmitPayload,
  createPluginSettingsDraft,
  extractPluginSettingsApiFieldErrors,
  formatReadonlySettingValue,
  isPluginSettingsDraftDirty,
  updateDraftFieldValue,
  updateDraftSecretState,
  validateSingleDraftField,
} from './pluginSettingsForm.js';

function must<T>(val: T | undefined, label = 'value'): T {
  if (val === undefined) throw new Error(`Expected ${label}`);
  return val;
}

const SAMPLE_SNAPSHOT: PluginSettingsSnapshot = {
  plugin_id: 'kinloom-pronunciation',
  plugin_name: 'Pronunciation & TTS',
  plugin_version: '0.43.0',
  status: 'active',
  schema: {
    title: 'Pronunciation & TTS Settings',
    sections: [
      {
        id: 'status',
        title: 'Runtime Status',
        fields: [{ key: 'active_generator', label: 'Active Generator', type: 'readonly' }],
      },
      {
        id: 'config',
        title: 'Config',
        fields: [
          {
            key: 'default_voice',
            label: 'Default Voice',
            type: 'string',
            required: true,
            defaultValue: 'Charon',
          },
          {
            key: 'retries',
            label: 'Retries',
            type: 'number',
            integer: true,
            min: 0,
            max: 5,
            defaultValue: 1,
          },
          { key: 'auto_gen', label: 'Auto Generate', type: 'boolean', defaultValue: true },
          {
            key: 'gemini_api_key',
            label: 'Gemini API Key',
            type: 'string',
            secret: true,
            minLength: 8,
          },
          {
            key: 'required_secret',
            label: 'Required Secret',
            type: 'secret',
            required: true,
            minLength: 6,
          },
        ],
      },
    ],
  },
  values: {
    default_voice: 'Charon',
    retries: 1,
    auto_gen: true,
  },
  secrets: {
    gemini_api_key: { configured: true, updated_at: '2026-11-27T12:00:00.000Z' },
    required_secret: { configured: true, updated_at: '2026-11-27T12:00:00.000Z' },
  },
  readonly_values: {
    active_generator: 'gemini-tts',
  },
  updated_at: '2026-11-27T12:00:00.000Z',
  updated_by: 'admin@archive.example',
};

describe('pluginSettingsForm pure view-model helpers', () => {
  it('tracks dirty state accurately and omits untouched secrets from partial submit payloads', () => {
    const initial = createPluginSettingsDraft(SAMPLE_SNAPSHOT);
    expect(isPluginSettingsDraftDirty(SAMPLE_SNAPSHOT, initial)).toBe(false);

    const editedVoice = updateDraftFieldValue(initial, 'default_voice', 'Kore');
    expect(isPluginSettingsDraftDirty(SAMPLE_SNAPSHOT, editedVoice)).toBe(true);

    const submit = buildPluginSettingsSubmitPayload(SAMPLE_SNAPSHOT, editedVoice);
    expect(submit).toEqual({
      ok: true,
      payload: {
        values: { default_voice: 'Kore' },
      },
    });

    // Replacing and clearing secrets produces explicit secret mutations
    const withSecretActions = updateDraftSecretState(
      updateDraftSecretState(editedVoice, 'gemini_api_key', { kind: 'cleared' }),
      'required_secret',
      { kind: 'replacing', value: 'new-secret-9999', revealed: false }
    );
    const submitWithSecrets = buildPluginSettingsSubmitPayload(SAMPLE_SNAPSHOT, withSecretActions);
    expect(submitWithSecrets).toEqual({
      ok: true,
      payload: {
        values: { default_voice: 'Kore' },
        secrets: {
          gemini_api_key: { action: 'clear' },
          required_secret: { action: 'set', value: 'new-secret-9999' },
        },
      },
    });
  });

  it('validates single fields on blur, blocks invalid submits, and extracts structured 422 field errors', () => {
    const initial = createPluginSettingsDraft(SAMPLE_SNAPSHOT);
    const readonlyField = must(SAMPLE_SNAPSHOT.schema.sections[0]?.fields[0]);
    const secretField = must(SAMPLE_SNAPSHOT.schema.sections[1]?.fields[3]);
    const reqSecretField = must(SAMPLE_SNAPSHOT.schema.sections[1]?.fields[4]);

    expect(validateSingleDraftField(initial, readonlyField)).toBeNull();
    expect(validateSingleDraftField(initial, secretField)).toBeNull();

    const shortSecret = updateDraftSecretState(initial, 'gemini_api_key', {
      kind: 'replacing',
      value: 'abc',
      revealed: false,
    });
    expect(validateSingleDraftField(shortSecret, secretField)).toMatch(/at least 8/);
    const invalidSubmit = buildPluginSettingsSubmitPayload(SAMPLE_SNAPSHOT, shortSecret);
    expect(invalidSubmit.ok).toBe(false);

    const clearedReqSecret = updateDraftSecretState(initial, 'required_secret', { kind: 'cleared' });
    expect(validateSingleDraftField(clearedReqSecret, reqSecretField)).toMatch(
      /required and cannot be cleared/
    );

    expect(
      extractPluginSettingsApiFieldErrors({
        status: 422,
        code: 'VALIDATION_ERROR',
        details: { field_errors: { default_voice: 'Required', ignored: 42 } },
      })
    ).toEqual({ default_voice: 'Required' });
    expect(extractPluginSettingsApiFieldErrors(new Error('network'))).toEqual({});

    expect(formatReadonlySettingValue(true)).toBe('enabled');
    expect(formatReadonlySettingValue(false)).toBe('disabled');
    expect(formatReadonlySettingValue(null)).toBe('—');
    expect(formatReadonlySettingValue('gemini-tts')).toBe('gemini-tts');
  });
});
