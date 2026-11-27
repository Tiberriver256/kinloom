import {
  isArchiveApiError,
  isSecretPluginSettingField,
  iteratePluginSettingFields,
  type PluginSecretMutation,
  type PluginSettingField,
  type PluginSettingScalarValue,
  type PluginSettingsSnapshot,
  type PluginSettingsUpdateRequest,
  validatePluginSettingFieldValue,
  validatePluginSettingsUpdate,
} from '@kinloom/core';

export type SecretFieldDraftState =
  | { readonly kind: 'unchanged' }
  | { readonly kind: 'replacing'; readonly value: string; readonly revealed: boolean }
  | { readonly kind: 'cleared' };

export interface PluginSettingsFormDraft {
  readonly values: Readonly<Record<string, PluginSettingScalarValue>>;
  readonly secrets: Readonly<Record<string, SecretFieldDraftState>>;
  readonly fieldErrors: Readonly<Record<string, string>>;
}

export function createPluginSettingsDraft(snapshot: PluginSettingsSnapshot): PluginSettingsFormDraft {
  const values: Record<string, PluginSettingScalarValue> = {};
  const secrets: Record<string, SecretFieldDraftState> = {};

  for (const field of iteratePluginSettingFields(snapshot.schema)) {
    if (field.type === 'readonly') {
      continue;
    }
    if (isSecretPluginSettingField(field)) {
      secrets[field.key] = { kind: 'unchanged' };
      continue;
    }
    values[field.key] = snapshot.values[field.key] ?? null;
  }

  return {
    values,
    secrets,
    fieldErrors: {},
  };
}

export function updateDraftFieldValue(
  draft: PluginSettingsFormDraft,
  key: string,
  value: PluginSettingScalarValue
): PluginSettingsFormDraft {
  const nextErrors = { ...draft.fieldErrors };
  delete nextErrors[key];
  return {
    ...draft,
    values: {
      ...draft.values,
      [key]: value,
    },
    fieldErrors: nextErrors,
  };
}

export function updateDraftSecretState(
  draft: PluginSettingsFormDraft,
  key: string,
  nextState: SecretFieldDraftState
): PluginSettingsFormDraft {
  const nextErrors = { ...draft.fieldErrors };
  delete nextErrors[key];
  return {
    ...draft,
    secrets: {
      ...draft.secrets,
      [key]: nextState,
    },
    fieldErrors: nextErrors,
  };
}

export function isPluginSettingsDraftDirty(
  snapshot: PluginSettingsSnapshot,
  draft: PluginSettingsFormDraft
): boolean {
  for (const field of iteratePluginSettingFields(snapshot.schema)) {
    if (field.type === 'readonly') {
      continue;
    }
    if (isSecretPluginSettingField(field)) {
      const secretDraft = draft.secrets[field.key];
      if (secretDraft && secretDraft.kind !== 'unchanged') {
        return true;
      }
      continue;
    }
    const baseValue = snapshot.values[field.key] ?? null;
    const draftValue = draft.values[field.key] ?? null;
    if (baseValue !== draftValue) {
      return true;
    }
  }
  return false;
}

export function validateSingleDraftField(
  draft: PluginSettingsFormDraft,
  field: PluginSettingField
): string | null {
  if (field.type === 'readonly') {
    return null;
  }
  if (isSecretPluginSettingField(field)) {
    const state = draft.secrets[field.key];
    if (!state || state.kind === 'unchanged') {
      return null;
    }
    if (state.kind === 'cleared') {
      return field.required ? `${field.label} is required and cannot be cleared.` : null;
    }
    return validatePluginSettingFieldValue(field, state.value, draft.values);
  }
  return validatePluginSettingFieldValue(field, draft.values[field.key] ?? null, draft.values);
}

export type BuildPluginSettingsDraftSubmitResult =
  | {
      readonly ok: true;
      readonly payload: PluginSettingsUpdateRequest;
    }
  | {
      readonly ok: false;
      readonly fieldErrors: Readonly<Record<string, string>>;
    };

/**
 * Validates the current form draft against the plugin's declared schema and builds
 * a minimal partial update payload. Untouched secrets are never included so existing
 * server-side credentials remain intact.
 */
export function buildPluginSettingsSubmitPayload(
  snapshot: PluginSettingsSnapshot,
  draft: PluginSettingsFormDraft
): BuildPluginSettingsDraftSubmitResult {
  const changedValues: Record<string, PluginSettingScalarValue> = {};
  const secretMutations: Record<string, PluginSecretMutation> = {};

  for (const field of iteratePluginSettingFields(snapshot.schema)) {
    if (field.type === 'readonly') {
      continue;
    }
    if (isSecretPluginSettingField(field)) {
      const secretDraft = draft.secrets[field.key];
      if (!secretDraft || secretDraft.kind === 'unchanged') {
        continue;
      }
      if (secretDraft.kind === 'cleared') {
        secretMutations[field.key] = { action: 'clear' };
      } else {
        secretMutations[field.key] = { action: 'set', value: secretDraft.value };
      }
      continue;
    }

    const baseValue = snapshot.values[field.key] ?? null;
    const draftValue = draft.values[field.key] ?? null;
    if (baseValue !== draftValue) {
      changedValues[field.key] = draftValue;
    }
  }

  const payload: PluginSettingsUpdateRequest = {
    ...(Object.keys(changedValues).length > 0 ? { values: changedValues } : {}),
    ...(Object.keys(secretMutations).length > 0 ? { secrets: secretMutations } : {}),
  };

  const validated = validatePluginSettingsUpdate({
    schema: snapshot.schema,
    currentValues: snapshot.values,
    currentSecrets: snapshot.secrets,
    update: payload,
  });

  if (!validated.ok) {
    return { ok: false, fieldErrors: validated.fieldErrors };
  }

  return { ok: true, payload };
}

export function extractPluginSettingsApiFieldErrors(error: unknown): Readonly<Record<string, string>> {
  if (!isArchiveApiError(error) || typeof error.details !== 'object' || error.details === null) {
    return {};
  }
  const details = error.details as { field_errors?: unknown };
  if (typeof details.field_errors !== 'object' || details.field_errors === null) {
    return {};
  }
  const out: Record<string, string> = {};
  for (const [key, val] of Object.entries(details.field_errors)) {
    if (typeof val === 'string' && val.length > 0) {
      out[key] = val;
    }
  }
  return out;
}

export function formatReadonlySettingValue(value: PluginSettingScalarValue | undefined): string {
  if (value === null || value === undefined || value === '') {
    return '—';
  }
  if (typeof value === 'boolean') {
    return value ? 'enabled' : 'disabled';
  }
  return String(value);
}
