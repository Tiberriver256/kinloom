import { describe, expect, it } from 'vitest';
import {
  extractPluginSettingsDefaults,
  isSecretPluginSettingField,
  type PluginSettingsSchema,
  validatePluginSettingFieldValue,
  validatePluginSettingsSchemaDefinition,
  validatePluginSettingsUpdate,
} from './pluginSettings.js';

const FULL_SCHEMA: PluginSettingsSchema = {
  title: 'Synthetic Integration',
  description: 'Exercises every declarative plugin setting field type.',
  sections: [
    {
      id: 'status',
      title: 'Runtime Status',
      fields: [
        {
          key: 'adapter_kind',
          label: 'Adapter Kind',
          type: 'readonly',
          defaultValue: 'in-memory',
        },
      ],
    },
    {
      id: 'config',
      title: 'Configuration',
      fields: [
        {
          key: 'display_label',
          label: 'Display Label',
          type: 'string',
          defaultValue: 'Default Label',
          required: true,
          minLength: 3,
          maxLength: 40,
          pattern: '^[A-Za-z0-9 _-]+$',
          patternMessage: 'Use letters, digits, spaces, hyphens, or underscores.',
        },
        {
          key: 'region_code',
          label: 'Region Code',
          type: 'text',
          defaultValue: 'us-east',
          allowlist: ['us-east', 'eu-west'],
        },
        {
          key: 'endpoint_url',
          label: 'Endpoint URL',
          type: 'url',
          allowedProtocols: ['https:'],
          helpText: 'HTTPS endpoint for synthesis requests.',
        },
        {
          key: 'max_retries',
          label: 'Max Retries',
          type: 'number',
          defaultValue: 2,
          required: true,
          integer: true,
          min: 0,
          max: 5,
        },
        {
          key: 'enabled_flag',
          label: 'Enabled',
          type: 'boolean',
          defaultValue: true,
        },
        {
          key: 'mode',
          label: 'Mode',
          type: 'select',
          defaultValue: 'standard',
          required: true,
          options: [
            { value: 'standard', label: 'Standard' },
            { value: 'strict', label: 'Strict' },
          ],
          validate: (val, all) =>
            val === 'strict' && all.max_retries === 0 ? 'Strict mode requires at least 1 retry.' : null,
        },
      ],
    },
    {
      id: 'credentials',
      title: 'Credentials',
      fields: [
        {
          key: 'primary_api_key',
          label: 'Primary API Key',
          type: 'string',
          secret: true,
          minLength: 8,
          maxLength: 128,
          pattern: '^sk-[A-Za-z0-9_-]+$',
          patternMessage: 'API key must start with sk-.',
        },
        {
          key: 'webhook_signing_secret',
          label: 'Webhook Signing Secret',
          type: 'secret',
          required: true,
          minLength: 6,
        },
        {
          key: 'legacy_text_secret',
          label: 'Legacy Text Secret',
          type: 'text',
          secret: true,
          validate: (val) => (val === 'forbidden-val' ? 'Secret value is not allowed.' : null),
        },
      ],
    },
  ],
};

describe('Declarative PluginSettingsSchema contract & validation', () => {
  it('treats { type: "string", secret: true }, { type: "text", secret: true }, and { type: "secret" } identically as write-only secrets', () => {
    expect(isSecretPluginSettingField({ type: 'string', secret: true })).toBe(true);
    expect(isSecretPluginSettingField({ type: 'string', secret: false })).toBe(false);
    expect(isSecretPluginSettingField({ type: 'string' })).toBe(false);
    expect(isSecretPluginSettingField({ type: 'text', secret: true })).toBe(true);
    expect(isSecretPluginSettingField({ type: 'secret' })).toBe(true);
    expect(isSecretPluginSettingField({ type: 'url' })).toBe(false);
    expect(isSecretPluginSettingField({ type: 'readonly' })).toBe(false);

    const serialized = validatePluginSettingsSchemaDefinition(FULL_SCHEMA, 'synthetic-plugin');
    expect(serialized.sections).toHaveLength(3);
    const modeField = serialized.sections[1]?.fields.find((f) => f.key === 'mode');
    expect(modeField).toBeDefined();
    expect('validate' in (modeField ?? {})).toBe(false);

    const defaults = extractPluginSettingsDefaults(FULL_SCHEMA);
    expect(defaults.values).toEqual({
      display_label: 'Default Label',
      region_code: 'us-east',
      endpoint_url: '',
      max_retries: 2,
      enabled_flag: true,
      mode: 'standard',
    });
    expect(defaults.readonlyValues).toEqual({ adapter_kind: 'in-memory' });
    expect(defaults.secretKeys).toEqual(['primary_api_key', 'webhook_signing_secret', 'legacy_text_secret']);
    expect('primary_api_key' in defaults.values).toBe(false);
    expect('webhook_signing_secret' in defaults.values).toBe(false);
  });

  it('rejects malformed schema definitions eagerly (duplicate sections/keys, invalid regex, contradictory bounds, secret defaultValue)', () => {
    expect(() =>
      validatePluginSettingsSchemaDefinition(
        {
          sections: [
            { id: 'dup', title: 'A', fields: [{ key: 'a', label: 'A', type: 'boolean' }] },
            { id: 'dup', title: 'B', fields: [{ key: 'b', label: 'B', type: 'boolean' }] },
          ],
        },
        'p'
      )
    ).toThrow(/duplicate settings section id/i);

    expect(() =>
      validatePluginSettingsSchemaDefinition(
        {
          sections: [
            {
              id: 's1',
              title: 'A',
              fields: [
                { key: 'dupKey', label: 'A', type: 'string' },
                { key: 'dupKey', label: 'B', type: 'string' },
              ],
            },
          ],
        },
        'p'
      )
    ).toThrow(/duplicate setting field key/i);

    expect(() =>
      validatePluginSettingsSchemaDefinition(
        {
          sections: [
            {
              id: 's1',
              title: 'A',
              fields: [{ key: 'k', label: 'K', type: 'string', secret: true, defaultValue: 'never-allow' }],
            },
          ],
        },
        'p'
      )
    ).toThrow(/must not declare a defaultValue/i);

    expect(() =>
      validatePluginSettingsSchemaDefinition(
        {
          sections: [
            {
              id: 's1',
              title: 'A',
              fields: [{ key: 'k', label: 'K', type: 'string', minLength: 10, maxLength: 5 }],
            },
          ],
        },
        'p'
      )
    ).toThrow(/minLength/);

    expect(() =>
      validatePluginSettingsSchemaDefinition(
        {
          sections: [
            {
              id: 's1',
              title: 'A',
              fields: [{ key: 'k', label: 'K', type: 'string', pattern: '[unclosed' }],
            },
          ],
        },
        'p'
      )
    ).toThrow(/invalid regular expression/i);

    expect(() =>
      validatePluginSettingsSchemaDefinition(
        {
          sections: [
            {
              id: 's1',
              title: 'A',
              fields: [{ key: 'k', label: 'K', type: 'number', min: 10, max: 2 }],
            },
          ],
        },
        'p'
      )
    ).toThrow(/min \(10\) greater than max/);

    expect(() =>
      validatePluginSettingsSchemaDefinition(
        {
          sections: [
            {
              id: 's1',
              title: 'A',
              fields: [
                {
                  key: 'k',
                  label: 'K',
                  type: 'select',
                  options: [
                    { value: 'a', label: 'A' },
                    { value: 'a', label: 'A2' },
                  ],
                },
              ],
            },
          ],
        },
        'p'
      )
    ).toThrow(/duplicate option value/i);

    expect(() =>
      validatePluginSettingsSchemaDefinition(
        {
          sections: [
            {
              id: 's1',
              title: 'A',
              fields: [
                {
                  key: 'k',
                  label: 'K',
                  type: 'select',
                  defaultValue: 'missing',
                  options: [{ value: 'a', label: 'A' }],
                },
              ],
            },
          ],
        },
        'p'
      )
    ).toThrow(/defaultValue 'missing' is not in options/);
  });

  it('validates updates, preserves untouched secrets, enforces secret isolation, and runs custom validators', () => {
    const valid = validatePluginSettingsUpdate({
      schema: FULL_SCHEMA,
      currentValues: { max_retries: 2 },
      currentSecrets: {
        primary_api_key: { configured: true, updated_at: '2026-11-27T10:00:00Z' },
        webhook_signing_secret: { configured: true, updated_at: '2026-11-27T10:00:00Z' },
      },
      update: {
        values: {
          display_label: '  Custom Voice  ',
          endpoint_url: 'https://tts.example.test/v1',
          enabled_flag: false,
        },
        secrets: {
          primary_api_key: { action: 'keep' },
          legacy_text_secret: { action: 'set', value: 'valid-secret-123' },
        },
      },
    });
    expect(valid.ok).toBe(true);
    if (valid.ok) {
      expect(valid.nextValues.display_label).toBe('Custom Voice');
      expect(valid.nextValues.endpoint_url).toBe('https://tts.example.test/v1');
      expect(valid.nextValues.enabled_flag).toBe(false);
      expect(valid.secretMutations).toEqual([
        { key: 'legacy_text_secret', action: 'set', value: 'valid-secret-123' },
      ]);
    }

    // Rejects unknown fields, readonly writes, secret-in-values, non-secret-in-secrets, and clearing required secret.
    const invalidRouting = validatePluginSettingsUpdate({
      schema: FULL_SCHEMA,
      currentValues: {},
      currentSecrets: {},
      update: {
        values: {
          unknown_key: 'x',
          adapter_kind: 'mutated',
          primary_api_key: 'sk-leaked-in-values',
        },
        secrets: {
          unknown_secret: { action: 'set', value: 'abc' },
          adapter_kind: { action: 'clear' },
          display_label: { action: 'clear' },
          webhook_signing_secret: { action: 'clear' },
          primary_api_key: { action: 'set', value: 'badprefix' },
          legacy_text_secret: { action: 'set', value: 'forbidden-val' },
        },
      },
    });
    expect(invalidRouting.ok).toBe(false);
    if (!invalidRouting.ok) {
      expect(invalidRouting.fieldErrors.unknown_key).toMatch(/Unknown setting field/);
      expect(invalidRouting.fieldErrors.adapter_kind).toMatch(/read-only/);
      expect(invalidRouting.fieldErrors.primary_api_key).toMatch(/API key must start with sk-/);
      expect(invalidRouting.fieldErrors.unknown_secret).toMatch(/Unknown secret field/);
      expect(invalidRouting.fieldErrors.display_label).toMatch(/not a secret field/);
      expect(invalidRouting.fieldErrors.webhook_signing_secret).toMatch(/required and cannot be cleared/);
      expect(invalidRouting.fieldErrors.legacy_text_secret).toBe('Secret value is not allowed.');
      // Never echo secret values in error messages.
      expect(JSON.stringify(invalidRouting.fieldErrors)).not.toContain('sk-leaked-in-values');
      expect(JSON.stringify(invalidRouting.fieldErrors)).not.toContain('forbidden-val');
    }
  });

  it('validates all field types, constraints, and cross-field rules accurately', () => {
    const crossFieldInvalid = validatePluginSettingsUpdate({
      schema: FULL_SCHEMA,
      currentValues: {},
      currentSecrets: {},
      update: {
        values: {
          display_label: 'ab',
          region_code: 'ap-south',
          endpoint_url: 'http://insecure.example.test',
          max_retries: 0,
          mode: 'strict',
        },
      },
    });
    expect(crossFieldInvalid.ok).toBe(false);
    if (!crossFieldInvalid.ok) {
      expect(crossFieldInvalid.fieldErrors.display_label).toMatch(/at least 3/);
      expect(crossFieldInvalid.fieldErrors.region_code).toMatch(/allowed values/);
      expect(crossFieldInvalid.fieldErrors.endpoint_url).toMatch(/allowed protocol/);
      expect(crossFieldInvalid.fieldErrors.mode).toBe('Strict mode requires at least 1 retry.');
    }

    // Exercise edge cases on validatePluginSettingFieldValue directly
    expect(validatePluginSettingFieldValue({ key: 'r', label: 'R', type: 'readonly' }, 'x', {})).toMatch(
      /read-only/
    );
    expect(
      validatePluginSettingFieldValue({ key: 'b', label: 'Flag', type: 'boolean' }, 'not-bool', {})
    ).toMatch(/true or false/);
    expect(
      validatePluginSettingFieldValue(
        { key: 'n', label: 'Count', type: 'number', required: true, integer: true, min: 1, max: 10 },
        null,
        {}
      )
    ).toMatch(/required/);
    expect(
      validatePluginSettingFieldValue(
        { key: 'n', label: 'Count', type: 'number', integer: true, min: 1, max: 10 },
        1.5,
        {}
      )
    ).toMatch(/whole number/);
    expect(
      validatePluginSettingFieldValue({ key: 'n', label: 'Count', type: 'number', min: 1, max: 10 }, 25, {})
    ).toMatch(/at most 10/);
    expect(
      validatePluginSettingFieldValue({ key: 'n', label: 'Count', type: 'number', min: 1, max: 10 }, 0, {})
    ).toMatch(/at least 1/);
    expect(validatePluginSettingFieldValue({ key: 'n', label: 'Count', type: 'number' }, 'bad', {})).toMatch(
      /valid number/
    );
    expect(
      validatePluginSettingFieldValue({ key: 'u', label: 'URL', type: 'url', required: true }, '', {})
    ).toMatch(/required/);
    expect(validatePluginSettingFieldValue({ key: 'u', label: 'URL', type: 'url' }, 'not-a-url', {})).toMatch(
      /valid absolute URL/
    );
    expect(validatePluginSettingFieldValue({ key: 'u', label: 'URL', type: 'url' }, 123, {})).toMatch(
      /valid URL string/
    );
    expect(
      validatePluginSettingFieldValue(
        { key: 's', label: 'Choice', type: 'select', required: true, options: [{ value: 'a', label: 'A' }] },
        '',
        {}
      )
    ).toMatch(/required/);
    expect(
      validatePluginSettingFieldValue(
        { key: 's', label: 'Choice', type: 'select', options: [{ value: 'a', label: 'A' }] },
        'z',
        {}
      )
    ).toMatch(/supported options/);
    expect(
      validatePluginSettingFieldValue(
        { key: 's', label: 'Choice', type: 'select', options: [{ value: 'a', label: 'A' }] },
        99,
        {}
      )
    ).toMatch(/valid option/);
    expect(
      validatePluginSettingFieldValue({ key: 't', label: 'Title', type: 'string', required: true }, '', {})
    ).toMatch(/required/);
    expect(
      validatePluginSettingFieldValue({ key: 't', label: 'Title', type: 'string', maxLength: 3 }, 'abcd', {})
    ).toMatch(/at most 3/);
    expect(validatePluginSettingFieldValue({ key: 't', label: 'Title', type: 'string' }, 42, {})).toMatch(
      /must be a string/
    );
    expect(
      validatePluginSettingFieldValue({ key: 'sec', label: 'Key', type: 'string', secret: true }, '   ', {})
    ).toMatch(/cannot be empty/);
  });

  it('validates preserveKeys and carries auxiliary keys forward untouched during declarative updates', () => {
    const schemaWithPreserve: PluginSettingsSchema = {
      title: 'Hybrid Plugin',
      preserveKeys: ['platform_order_json', 'funding_goal_json'],
      sections: [
        {
          id: 'main',
          title: 'Main',
          fields: [
            { key: 'show_in_footer', label: 'Show in Footer', type: 'boolean', defaultValue: false },
            { key: 'api_secret', label: 'API Secret', type: 'secret' },
          ],
        },
      ],
    };

    const serialized = validatePluginSettingsSchemaDefinition(schemaWithPreserve, 'hybrid-plugin');
    expect(serialized.sections).toHaveLength(1);
    expect('preserveKeys' in serialized).toBe(false);

    // Rejects invalid key, duplicate key, and secret collision in preserveKeys
    expect(() =>
      validatePluginSettingsSchemaDefinition(
        { ...schemaWithPreserve, preserveKeys: ['123-invalid'] },
        'hybrid-plugin'
      )
    ).toThrow(/not a valid setting key/);
    expect(() =>
      validatePluginSettingsSchemaDefinition(
        { ...schemaWithPreserve, preserveKeys: ['dup_key', 'dup_key'] },
        'hybrid-plugin'
      )
    ).toThrow(/duplicate preserveKeys/);
    expect(() =>
      validatePluginSettingsSchemaDefinition(
        { ...schemaWithPreserve, preserveKeys: ['api_secret'] },
        'hybrid-plugin'
      )
    ).toThrow(/collides with a write-only secret/);

    // Preserves declared auxiliary keys while still dropping unknown unpreserved keys
    const result = validatePluginSettingsUpdate({
      schema: schemaWithPreserve,
      currentValues: {
        show_in_footer: false,
        platform_order_json: '[{"platform":"ko_fi","label":"Custom CTA"}]',
        funding_goal_json: '{"enabled":true,"target_cents":5000}',
        stray_unpreserved: 'drop-me',
      },
      currentSecrets: { api_secret: { configured: false, updated_at: null } },
      update: { values: { show_in_footer: true } },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.nextValues).toEqual({
        show_in_footer: true,
        platform_order_json: '[{"platform":"ko_fi","label":"Custom CTA"}]',
        funding_goal_json: '{"enabled":true,"target_cents":5000}',
      });
      expect('stray_unpreserved' in result.nextValues).toBe(false);
    }
  });
});
