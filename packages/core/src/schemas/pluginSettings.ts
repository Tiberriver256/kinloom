import { z } from 'zod';
import { PluginRuntimeStatusSchema } from './diagnostics.js';

export const PluginSettingScalarValueSchema = z.union([
  z.string(),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);
export type PluginSettingScalarValue = z.infer<typeof PluginSettingScalarValueSchema>;

export const PluginSettingSelectOptionSchema = z.object({
  value: z.string().min(1),
  label: z.string().min(1),
  description: z.string().optional(),
});
export type PluginSettingSelectOption = z.infer<typeof PluginSettingSelectOptionSchema>;

export const PluginSettingAllowedProtocolSchema = z.enum(['https:', 'http:']);
export type PluginSettingAllowedProtocol = z.infer<typeof PluginSettingAllowedProtocolSchema>;

const PluginSettingFieldBaseShape = {
  key: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .regex(/^[a-zA-Z][a-zA-Z0-9_.-]*$/, 'Field key must start with a letter and use [a-zA-Z0-9_.-].'),
  label: z.string().trim().min(1).max(120),
  description: z.string().max(400).optional(),
  helpText: z.string().max(500).optional(),
  placeholder: z.string().max(200).optional(),
  required: z.boolean().optional(),
};

export const SerializableStringPluginSettingFieldSchema = z.object({
  ...PluginSettingFieldBaseShape,
  type: z.literal('string'),
  secret: z.boolean().optional(),
  defaultValue: z.string().optional(),
  minLength: z.number().int().nonnegative().optional(),
  maxLength: z.number().int().positive().optional(),
  pattern: z.string().min(1).optional(),
  patternMessage: z.string().max(200).optional(),
  allowlist: z.array(z.string().min(1)).min(1).optional(),
});

export const SerializableTextPluginSettingFieldSchema = z.object({
  ...PluginSettingFieldBaseShape,
  type: z.literal('text'),
  secret: z.boolean().optional(),
  defaultValue: z.string().optional(),
  minLength: z.number().int().nonnegative().optional(),
  maxLength: z.number().int().positive().optional(),
  pattern: z.string().min(1).optional(),
  patternMessage: z.string().max(200).optional(),
  allowlist: z.array(z.string().min(1)).min(1).optional(),
});

export const SerializableUrlPluginSettingFieldSchema = z.object({
  ...PluginSettingFieldBaseShape,
  type: z.literal('url'),
  defaultValue: z.string().optional(),
  allowedProtocols: z.array(PluginSettingAllowedProtocolSchema).min(1).optional(),
  pattern: z.string().min(1).optional(),
  patternMessage: z.string().max(200).optional(),
  allowlist: z.array(z.string().min(1)).min(1).optional(),
});

export const SerializableNumberPluginSettingFieldSchema = z.object({
  ...PluginSettingFieldBaseShape,
  type: z.literal('number'),
  defaultValue: z.number().finite().optional(),
  min: z.number().finite().optional(),
  max: z.number().finite().optional(),
  integer: z.boolean().optional(),
  step: z.number().positive().optional(),
});

export const SerializableBooleanPluginSettingFieldSchema = z.object({
  ...PluginSettingFieldBaseShape,
  type: z.literal('boolean'),
  defaultValue: z.boolean().optional(),
});

export const SerializableSelectPluginSettingFieldSchema = z.object({
  ...PluginSettingFieldBaseShape,
  type: z.literal('select'),
  defaultValue: z.string().optional(),
  options: z.array(PluginSettingSelectOptionSchema).min(1),
});

export const SerializableSecretPluginSettingFieldSchema = z.object({
  ...PluginSettingFieldBaseShape,
  type: z.literal('secret'),
  minLength: z.number().int().nonnegative().optional(),
  maxLength: z.number().int().positive().optional(),
  pattern: z.string().min(1).optional(),
  patternMessage: z.string().max(200).optional(),
});

export const SerializableReadonlyPluginSettingFieldSchema = z.object({
  key: PluginSettingFieldBaseShape.key,
  label: PluginSettingFieldBaseShape.label,
  description: PluginSettingFieldBaseShape.description,
  helpText: PluginSettingFieldBaseShape.helpText,
  type: z.literal('readonly'),
  defaultValue: PluginSettingScalarValueSchema.optional(),
});

export const SerializablePluginSettingFieldSchema = z.discriminatedUnion('type', [
  SerializableStringPluginSettingFieldSchema,
  SerializableTextPluginSettingFieldSchema,
  SerializableUrlPluginSettingFieldSchema,
  SerializableNumberPluginSettingFieldSchema,
  SerializableBooleanPluginSettingFieldSchema,
  SerializableSelectPluginSettingFieldSchema,
  SerializableSecretPluginSettingFieldSchema,
  SerializableReadonlyPluginSettingFieldSchema,
]);
export type SerializablePluginSettingField = z.infer<typeof SerializablePluginSettingFieldSchema>;

export const SerializablePluginSettingsSectionSchema = z.object({
  id: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .regex(/^[a-zA-Z][a-zA-Z0-9_.-]*$/, 'Section id must start with a letter and use [a-zA-Z0-9_.-].'),
  title: z.string().trim().min(1).max(120),
  description: z.string().max(500).optional(),
  fields: z.array(SerializablePluginSettingFieldSchema).min(1),
});
export type SerializablePluginSettingsSection = z.infer<typeof SerializablePluginSettingsSectionSchema>;

export const SerializablePluginSettingsSchema = z.object({
  title: z.string().trim().min(1).max(120).optional(),
  description: z.string().max(500).optional(),
  sections: z.array(SerializablePluginSettingsSectionSchema).min(1),
});
export type SerializablePluginSettings = z.infer<typeof SerializablePluginSettingsSchema>;

export type PluginSettingFieldValidator = (
  value: PluginSettingScalarValue,
  allValues: Readonly<Record<string, PluginSettingScalarValue>>
) => string | null | undefined;

export type PluginSettingField =
  | (z.infer<typeof SerializableStringPluginSettingFieldSchema> & {
      readonly validate?: PluginSettingFieldValidator;
    })
  | (z.infer<typeof SerializableTextPluginSettingFieldSchema> & {
      readonly validate?: PluginSettingFieldValidator;
    })
  | (z.infer<typeof SerializableUrlPluginSettingFieldSchema> & {
      readonly validate?: PluginSettingFieldValidator;
    })
  | (z.infer<typeof SerializableNumberPluginSettingFieldSchema> & {
      readonly validate?: PluginSettingFieldValidator;
    })
  | (z.infer<typeof SerializableBooleanPluginSettingFieldSchema> & {
      readonly validate?: PluginSettingFieldValidator;
    })
  | (z.infer<typeof SerializableSelectPluginSettingFieldSchema> & {
      readonly validate?: PluginSettingFieldValidator;
    })
  | (z.infer<typeof SerializableSecretPluginSettingFieldSchema> & {
      readonly validate?: PluginSettingFieldValidator;
    })
  | z.infer<typeof SerializableReadonlyPluginSettingFieldSchema>;

export interface PluginSettingsSection {
  readonly id: string;
  readonly title: string;
  readonly description?: string;
  readonly fields: readonly PluginSettingField[];
}

export interface PluginSettingsSchema {
  readonly title?: string;
  readonly description?: string;
  readonly sections: readonly PluginSettingsSection[];
  /**
   * Optional auxiliary non-secret keys persisted in plugin_settings.values_json by a dedicated
   * plugin admin endpoint that must be carried forward untouched during declarative settings saves.
   */
  readonly preserveKeys?: readonly string[];
}

export const PluginSecretFieldStateSchema = z.object({
  configured: z.boolean(),
  updated_at: z.string().min(1).nullable().default(null),
});
export type PluginSecretFieldState = z.infer<typeof PluginSecretFieldStateSchema>;

export const PluginSecretMutationSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('keep') }),
  z.object({ action: z.literal('clear') }),
  z.object({ action: z.literal('set'), value: z.string() }),
]);
export type PluginSecretMutation = z.infer<typeof PluginSecretMutationSchema>;

export const PluginSettingsUpdateRequestSchema = z
  .object({
    values: z.record(z.string(), PluginSettingScalarValueSchema).optional(),
    secrets: z.record(z.string(), PluginSecretMutationSchema).optional(),
  })
  .strict();
export type PluginSettingsUpdateRequest = z.infer<typeof PluginSettingsUpdateRequestSchema>;

export const PluginSettingsSnapshotSchema = z.object({
  plugin_id: z.string().min(1),
  plugin_name: z.string().min(1),
  plugin_version: z.string().min(1),
  status: PluginRuntimeStatusSchema,
  schema: SerializablePluginSettingsSchema,
  values: z.record(z.string(), PluginSettingScalarValueSchema),
  secrets: z.record(z.string(), PluginSecretFieldStateSchema),
  readonly_values: z.record(z.string(), PluginSettingScalarValueSchema),
  updated_at: z.string().min(1).nullable().default(null),
  updated_by: z.string().min(1).nullable().default(null),
});
export type PluginSettingsSnapshot = z.infer<typeof PluginSettingsSnapshotSchema>;

export const AdminPluginSettingsListResponseSchema = z.object({
  plugins: z.array(PluginSettingsSnapshotSchema),
});
export type AdminPluginSettingsListResponse = z.infer<typeof AdminPluginSettingsListResponseSchema>;

export const AdminPluginSettingsUpdateResponseSchema = z.object({
  plugin: PluginSettingsSnapshotSchema,
});
export type AdminPluginSettingsUpdateResponse = z.infer<typeof AdminPluginSettingsUpdateResponseSchema>;

export interface PluginSettingsSecretWriteOp {
  readonly key: string;
  readonly action: 'set' | 'clear';
  readonly value?: string;
}

export function isSecretPluginSettingField(
  field: Pick<PluginSettingField, 'type'> & { readonly secret?: boolean }
): boolean {
  return (
    field.type === 'secret' || ((field.type === 'string' || field.type === 'text') && field.secret === true)
  );
}

export function iteratePluginSettingFields(schema: PluginSettingsSchema): PluginSettingField[] {
  const fields: PluginSettingField[] = [];
  for (const section of schema.sections) {
    for (const field of section.fields) {
      fields.push(field);
    }
  }
  return fields;
}

function stripValidator(field: PluginSettingField): SerializablePluginSettingField {
  if (field.type === 'readonly') {
    return { ...field };
  }
  const { validate: _ignored, ...rest } = field;
  if (isSecretPluginSettingField(rest) && 'defaultValue' in rest) {
    const { defaultValue: _neverEmitSecretDefault, ...withoutDefault } = rest;
    return withoutDefault as SerializablePluginSettingField;
  }
  return rest as SerializablePluginSettingField;
}

/**
 * Validates structural invariants of a declarative PluginSettingsSchema at plugin registration time
 * so duplicate keys, invalid regex patterns, contradictory bounds, or secret default values fail fast.
 */
export function validatePluginSettingsSchemaDefinition(
  schema: PluginSettingsSchema,
  pluginId: string
): SerializablePluginSettings {
  const serializable: SerializablePluginSettings = {
    ...(schema.title !== undefined ? { title: schema.title } : {}),
    ...(schema.description !== undefined ? { description: schema.description } : {}),
    sections: schema.sections.map((section) => ({
      id: section.id,
      title: section.title,
      ...(section.description !== undefined ? { description: section.description } : {}),
      fields: section.fields.map((field) => {
        if (
          isSecretPluginSettingField(field) &&
          'defaultValue' in field &&
          field.defaultValue !== undefined
        ) {
          throw new RangeError(
            `Plugin '${pluginId}' secret setting field '${field.key}' must not declare a defaultValue.`
          );
        }
        return stripValidator(field);
      }),
    })),
  };

  const parsed = SerializablePluginSettingsSchema.parse(serializable);
  const seenSections = new Set<string>();
  const seenFields = new Set<string>();

  for (const section of parsed.sections) {
    if (seenSections.has(section.id)) {
      throw new RangeError(`Plugin '${pluginId}' declares duplicate settings section id '${section.id}'.`);
    }
    seenSections.add(section.id);

    for (const field of section.fields) {
      if (seenFields.has(field.key)) {
        throw new RangeError(`Plugin '${pluginId}' declares duplicate setting field key '${field.key}'.`);
      }
      seenFields.add(field.key);

      if (
        (field.type === 'string' || field.type === 'text' || field.type === 'secret') &&
        field.minLength !== undefined &&
        field.maxLength !== undefined &&
        field.minLength > field.maxLength
      ) {
        throw new RangeError(
          `Plugin '${pluginId}' field '${field.key}' has minLength (${field.minLength}) greater than maxLength (${field.maxLength}).`
        );
      }

      if (
        (field.type === 'string' ||
          field.type === 'text' ||
          field.type === 'url' ||
          field.type === 'secret') &&
        field.pattern !== undefined
      ) {
        try {
          // Validate regular expression syntax eagerly.
          new RegExp(field.pattern);
        } catch {
          throw new RangeError(
            `Plugin '${pluginId}' field '${field.key}' has an invalid regular expression pattern.`
          );
        }
      }

      if (
        field.type === 'number' &&
        field.min !== undefined &&
        field.max !== undefined &&
        field.min > field.max
      ) {
        throw new RangeError(
          `Plugin '${pluginId}' field '${field.key}' has min (${field.min}) greater than max (${field.max}).`
        );
      }

      if (field.type === 'select') {
        const optionValues = new Set<string>();
        for (const opt of field.options) {
          if (optionValues.has(opt.value)) {
            throw new RangeError(
              `Plugin '${pluginId}' select field '${field.key}' has duplicate option value '${opt.value}'.`
            );
          }
          optionValues.add(opt.value);
        }
        if (field.defaultValue !== undefined && !optionValues.has(field.defaultValue)) {
          throw new RangeError(
            `Plugin '${pluginId}' select field '${field.key}' defaultValue '${field.defaultValue}' is not in options.`
          );
        }
      }
    }
  }

  if (schema.preserveKeys !== undefined) {
    const secretKeys = new Set<string>();
    for (const section of parsed.sections) {
      for (const field of section.fields) {
        if (isSecretPluginSettingField(field)) {
          secretKeys.add(field.key);
        }
      }
    }
    const seenPreserveKeys = new Set<string>();
    for (const rawKey of schema.preserveKeys) {
      const keyResult = PluginSettingFieldBaseShape.key.safeParse(rawKey);
      if (!keyResult.success) {
        throw new RangeError(
          `Plugin '${pluginId}' preserveKeys entry '${rawKey}' is not a valid setting key.`
        );
      }
      const key = keyResult.data;
      if (seenPreserveKeys.has(key)) {
        throw new RangeError(`Plugin '${pluginId}' declares duplicate preserveKeys entry '${key}'.`);
      }
      if (secretKeys.has(key)) {
        throw new RangeError(
          `Plugin '${pluginId}' preserveKeys entry '${key}' collides with a write-only secret field.`
        );
      }
      seenPreserveKeys.add(key);
    }
  }

  return parsed;
}

export function extractPluginSettingsDefaults(schema: PluginSettingsSchema): {
  readonly values: Record<string, PluginSettingScalarValue>;
  readonly readonlyValues: Record<string, PluginSettingScalarValue>;
  readonly secretKeys: readonly string[];
} {
  const values: Record<string, PluginSettingScalarValue> = {};
  const readonlyValues: Record<string, PluginSettingScalarValue> = {};
  const secretKeys: string[] = [];

  for (const field of iteratePluginSettingFields(schema)) {
    if (field.type === 'readonly') {
      readonlyValues[field.key] = field.defaultValue ?? null;
      continue;
    }
    if (field.type === 'secret' || isSecretPluginSettingField(field)) {
      secretKeys.push(field.key);
      continue;
    }
    switch (field.type) {
      case 'boolean':
        values[field.key] = field.defaultValue ?? false;
        break;
      case 'number':
        values[field.key] = field.defaultValue ?? null;
        break;
      case 'select':
        values[field.key] = field.defaultValue ?? field.options[0]?.value ?? null;
        break;
      case 'string':
      case 'text':
      case 'url':
        values[field.key] = field.defaultValue ?? '';
        break;
      default: {
        const _exhaustive: never = field;
        throw new Error(`Unhandled field type: ${String(_exhaustive)}`);
      }
    }
  }

  return { values, readonlyValues, secretKeys };
}

function validateStringConstraints(
  field: {
    readonly label: string;
    readonly minLength?: number;
    readonly maxLength?: number;
    readonly pattern?: string;
    readonly patternMessage?: string;
    readonly allowlist?: readonly string[];
  },
  value: string,
  isSecret: boolean
): string | null {
  if (field.minLength !== undefined && value.length < field.minLength) {
    return `${field.label} must be at least ${field.minLength} characters.`;
  }
  if (field.maxLength !== undefined && value.length > field.maxLength) {
    return `${field.label} must be at most ${field.maxLength} characters.`;
  }
  if (field.pattern !== undefined) {
    const regex = new RegExp(field.pattern);
    if (!regex.test(value)) {
      return field.patternMessage ?? `${field.label} does not match the required format.`;
    }
  }
  if (!isSecret && field.allowlist && !field.allowlist.includes(value)) {
    return `${field.label} must be one of the allowed values (${field.allowlist.join(', ')}).`;
  }
  return null;
}

export function validatePluginSettingFieldValue(
  field: PluginSettingField,
  value: PluginSettingScalarValue,
  allValues: Readonly<Record<string, PluginSettingScalarValue>>
): string | null {
  if (field.type === 'readonly') {
    return `${field.label} is read-only and cannot be modified.`;
  }

  if (field.type === 'secret' || isSecretPluginSettingField(field)) {
    if (typeof value !== 'string' || value.trim().length === 0) {
      return `${field.label} cannot be empty. Use Clear to remove an existing secret.`;
    }
    const trimmed = value.trim();
    const constraintErr = validateStringConstraints(field, trimmed, true);
    if (constraintErr) {
      return constraintErr;
    }
    const customErr = field.validate?.(trimmed, allValues);
    return customErr ? customErr : null;
  }

  switch (field.type) {
    case 'boolean': {
      if (typeof value !== 'boolean') {
        return `${field.label} must be true or false.`;
      }
      const customErr = field.validate?.(value, allValues);
      return customErr ? customErr : null;
    }
    case 'number': {
      if (value === null || value === '') {
        if (field.required) {
          return `${field.label} is required.`;
        }
        const customErr = field.validate?.(null, allValues);
        return customErr ? customErr : null;
      }
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        return `${field.label} must be a valid number.`;
      }
      if (field.integer && !Number.isInteger(value)) {
        return `${field.label} must be a whole number.`;
      }
      if (field.min !== undefined && value < field.min) {
        return `${field.label} must be at least ${field.min}.`;
      }
      if (field.max !== undefined && value > field.max) {
        return `${field.label} must be at most ${field.max}.`;
      }
      const customErr = field.validate?.(value, allValues);
      return customErr ? customErr : null;
    }
    case 'select': {
      if (value === null || value === '') {
        if (field.required) {
          return `${field.label} is required.`;
        }
        const customErr = field.validate?.(value, allValues);
        return customErr ? customErr : null;
      }
      if (typeof value !== 'string') {
        return `${field.label} must be a valid option.`;
      }
      const valid = field.options.some((opt) => opt.value === value);
      if (!valid) {
        return `${field.label} must be one of the supported options.`;
      }
      const customErr = field.validate?.(value, allValues);
      return customErr ? customErr : null;
    }
    case 'url': {
      if (value === null || (typeof value === 'string' && value.trim().length === 0)) {
        if (field.required) {
          return `${field.label} is required.`;
        }
        const customErr = field.validate?.(typeof value === 'string' ? '' : null, allValues);
        return customErr ? customErr : null;
      }
      if (typeof value !== 'string') {
        return `${field.label} must be a valid URL string.`;
      }
      const trimmed = value.trim();
      let parsedUrl: URL;
      try {
        parsedUrl = new URL(trimmed);
      } catch {
        return `${field.label} must be a valid absolute URL.`;
      }
      const allowedProtocols = field.allowedProtocols ?? ['https:', 'http:'];
      if (!allowedProtocols.includes(parsedUrl.protocol as PluginSettingAllowedProtocol)) {
        return `${field.label} must use an allowed protocol (${allowedProtocols.join(', ')}).`;
      }
      const constraintErr = validateStringConstraints(field, trimmed, false);
      if (constraintErr) {
        return constraintErr;
      }
      const customErr = field.validate?.(trimmed, allValues);
      return customErr ? customErr : null;
    }
    case 'string':
    case 'text': {
      if (value === null || (typeof value === 'string' && value.trim().length === 0)) {
        if (field.required) {
          return `${field.label} is required.`;
        }
        const customErr = field.validate?.(typeof value === 'string' ? '' : null, allValues);
        return customErr ? customErr : null;
      }
      if (typeof value !== 'string') {
        return `${field.label} must be a string.`;
      }
      const trimmed = value.trim();
      const constraintErr = validateStringConstraints(field, trimmed, false);
      if (constraintErr) {
        return constraintErr;
      }
      const customErr = field.validate?.(trimmed, allValues);
      return customErr ? customErr : null;
    }
    default: {
      const _exhaustive: never = field;
      throw new Error(`Unhandled field type: ${String(_exhaustive)}`);
    }
  }
}

export type ValidatePluginSettingsUpdateResult =
  | {
      readonly ok: true;
      readonly nextValues: Record<string, PluginSettingScalarValue>;
      readonly secretMutations: readonly PluginSettingsSecretWriteOp[];
    }
  | {
      readonly ok: false;
      readonly fieldErrors: Readonly<Record<string, string>>;
    };

/**
 * Validates an incoming partial or full plugin settings update against a plugin's schema.
 * Strictly separates non-secret values from write-only secret mutations and preserves
 * any secret field omitted or marked `keep`.
 */
export function validatePluginSettingsUpdate(params: {
  readonly schema: PluginSettingsSchema;
  readonly currentValues: Readonly<Record<string, PluginSettingScalarValue>>;
  readonly currentSecrets: Readonly<Record<string, PluginSecretFieldState>>;
  readonly update: PluginSettingsUpdateRequest;
}): ValidatePluginSettingsUpdateResult {
  const { schema, currentValues, update } = params;
  const fieldsByKey = new Map<string, PluginSettingField>();
  for (const field of iteratePluginSettingFields(schema)) {
    fieldsByKey.set(field.key, field);
  }

  const fieldErrors: Record<string, string> = {};
  const { values: defaults } = extractPluginSettingsDefaults(schema);
  const nextValues: Record<string, PluginSettingScalarValue> = { ...defaults };

  const preservedKeys = new Set<string>(schema.preserveKeys ?? []);

  for (const [key, storedVal] of Object.entries(currentValues)) {
    const field = fieldsByKey.get(key);
    if (field && field.type !== 'readonly' && !isSecretPluginSettingField(field)) {
      nextValues[key] = storedVal;
    } else if (!field && preservedKeys.has(key)) {
      nextValues[key] = storedVal;
    }
  }

  if (update.values) {
    for (const [key, rawValue] of Object.entries(update.values)) {
      const field = fieldsByKey.get(key);
      if (!field) {
        fieldErrors[key] = `Unknown setting field '${key}'.`;
        continue;
      }
      if (field.type === 'readonly') {
        fieldErrors[key] = `Field '${key}' is read-only and cannot be modified.`;
        continue;
      }
      if (isSecretPluginSettingField(field)) {
        fieldErrors[key] = `Secret field '${key}' is write-only and must be updated via 'secrets'.`;
        continue;
      }
      if (
        (field.type === 'string' || field.type === 'text' || field.type === 'url') &&
        typeof rawValue === 'string'
      ) {
        nextValues[key] = rawValue.trim();
      } else {
        nextValues[key] = rawValue;
      }
    }
  }

  const secretMutations: PluginSettingsSecretWriteOp[] = [];
  if (update.secrets) {
    for (const [key, mutation] of Object.entries(update.secrets)) {
      const field = fieldsByKey.get(key);
      if (!field) {
        fieldErrors[key] = `Unknown secret field '${key}'.`;
        continue;
      }
      if (field.type === 'readonly') {
        fieldErrors[key] = `Field '${key}' is read-only and cannot be modified.`;
        continue;
      }
      if (!isSecretPluginSettingField(field)) {
        fieldErrors[key] = `Field '${key}' is not a secret field.`;
        continue;
      }

      if (mutation.action === 'keep') {
        continue;
      }
      if (mutation.action === 'clear') {
        if (field.required) {
          fieldErrors[key] = `${field.label} is required and cannot be cleared.`;
          continue;
        }
        secretMutations.push({ key, action: 'clear' });
        continue;
      }

      const secretError = validatePluginSettingFieldValue(field, mutation.value, nextValues);
      if (secretError) {
        fieldErrors[key] = secretError;
        continue;
      }
      secretMutations.push({ key, action: 'set', value: mutation.value.trim() });
    }
  }

  for (const field of fieldsByKey.values()) {
    if (field.type === 'readonly' || isSecretPluginSettingField(field) || fieldErrors[field.key]) {
      continue;
    }
    const err = validatePluginSettingFieldValue(field, nextValues[field.key] ?? null, nextValues);
    if (err) {
      fieldErrors[field.key] = err;
    }
  }

  if (Object.keys(fieldErrors).length > 0) {
    return { ok: false, fieldErrors };
  }

  return {
    ok: true,
    nextValues,
    secretMutations,
  };
}
