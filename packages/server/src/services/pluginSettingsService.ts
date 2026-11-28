import {
  extractPluginSettingsDefaults,
  isSecretPluginSettingField,
  iteratePluginSettingFields,
  type KinloomSiteConfig,
  type PluginRuntimeStatus,
  PluginRuntimeStatusSchema,
  type PluginSecretFieldState,
  type PluginSettingScalarValue,
  type PluginSettingsSchema,
  type PluginSettingsSnapshot,
  PluginSettingsSnapshotSchema,
  type PluginSettingsStore,
  PluginSettingsUpdateRequestSchema,
  type SerializablePluginSettings,
  validatePluginSettingsSchemaDefinition,
  validatePluginSettingsUpdate,
} from '@kinloom/core';
import { KinloomHttpError } from '../errors.js';
import type { KinloomServerPlugin, KinloomServerPorts } from '../http/pluginLifecycle.js';
import { sanitizeDiagnosticDetail } from '../http/redaction.js';

export interface PluginSettingsServiceDeps {
  readonly siteConfig: KinloomSiteConfig;
  readonly mode: 'private' | 'public';
  readonly ports: KinloomServerPorts;
  readonly plugins: readonly KinloomServerPlugin[];
  readonly store?: PluginSettingsStore;
  readonly onPluginError?: (pluginId: string, error: unknown) => void;
}

interface CompiledConfigurablePlugin {
  readonly plugin: KinloomServerPlugin;
  readonly schema: PluginSettingsSchema;
  readonly serializedSchema: SerializablePluginSettings;
}

function sanitizeReadonlyValue(value: PluginSettingScalarValue | undefined): PluginSettingScalarValue {
  if (typeof value === 'string') {
    return sanitizeDiagnosticDetail(value, 240) ?? '';
  }
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
    return value;
  }
  return null;
}

export class PluginSettingsService {
  private readonly configurablePlugins: readonly CompiledConfigurablePlugin[];
  private readonly configurableById: ReadonlyMap<string, CompiledConfigurablePlugin>;

  constructor(private readonly deps: PluginSettingsServiceDeps) {
    const compiled: CompiledConfigurablePlugin[] = [];
    const byId = new Map<string, CompiledConfigurablePlugin>();

    for (const plugin of deps.plugins) {
      if (!plugin.settingsSchema) {
        continue;
      }
      const serializedSchema = validatePluginSettingsSchemaDefinition(plugin.settingsSchema, plugin.id);
      const entry: CompiledConfigurablePlugin = {
        plugin,
        schema: plugin.settingsSchema,
        serializedSchema,
      };
      compiled.push(entry);
      byId.set(plugin.id, entry);
    }

    this.configurablePlugins = compiled;
    this.configurableById = byId;
  }

  async listPluginSettings(): Promise<readonly PluginSettingsSnapshot[]> {
    return Promise.all(this.configurablePlugins.map((entry) => this.buildSnapshot(entry)));
  }

  async updatePluginSettings(params: {
    readonly pluginId: string;
    readonly rawPayload: unknown;
    readonly updatedBy: string;
  }): Promise<PluginSettingsSnapshot> {
    const entry = this.configurableById.get(params.pluginId);
    if (!entry) {
      throw new KinloomHttpError(
        400,
        'UNKNOWN_PLUGIN',
        `Plugin '${params.pluginId}' is not registered or does not declare a settings schema.`
      );
    }

    if (!this.deps.store) {
      throw new KinloomHttpError(
        503,
        'PLUGIN_SETTINGS_STORE_UNAVAILABLE',
        'Plugin settings persistence is not configured on this server.'
      );
    }

    const parsedBody = PluginSettingsUpdateRequestSchema.safeParse(params.rawPayload);
    if (!parsedBody.success) {
      throw new KinloomHttpError(
        400,
        'VALIDATION_ERROR',
        parsedBody.error.issues[0]?.message ?? 'Invalid plugin settings request payload.',
        {
          issues: parsedBody.error.issues.map((issue) => ({
            path: issue.path.join('.'),
            message: issue.message,
          })),
        }
      );
    }

    const [storedSettings, storedSecretMetadata] = await Promise.all([
      this.deps.store.getSettings(entry.plugin.id),
      this.deps.store.getSecretMetadata(entry.plugin.id),
    ]);

    const currentSecrets = this.buildSecretStateMap(entry.schema, storedSecretMetadata);
    const validation = validatePluginSettingsUpdate({
      schema: entry.schema,
      currentValues: storedSettings?.values ?? {},
      currentSecrets,
      update: parsedBody.data,
    });

    if (!validation.ok) {
      const firstMessage = Object.values(validation.fieldErrors)[0] ?? 'Plugin settings validation failed.';
      throw new KinloomHttpError(422, 'VALIDATION_ERROR', firstMessage, {
        field_errors: validation.fieldErrors,
      });
    }

    const nowIso = this.deps.ports.clock.nowIso();
    const saved = await this.deps.store.savePluginSettings({
      pluginId: entry.plugin.id,
      values: validation.nextValues,
      secretMutations: validation.secretMutations,
      updatedBy: params.updatedBy,
      updatedAt: nowIso,
    });

    const nextSecrets = this.buildSecretStateMap(entry.schema, saved.secretMetadata);
    const configuredSecrets = this.toConfiguredMap(nextSecrets);

    if (typeof entry.plugin.onSettingsUpdated === 'function') {
      try {
        await entry.plugin.onSettingsUpdated({
          values: { ...saved.settings.values },
          configuredSecrets,
        });
      } catch (error) {
        this.reportPluginError(entry.plugin.id, error);
      }
    }

    return this.buildSnapshotFromState(
      entry,
      saved.settings.values,
      nextSecrets,
      saved.settings.updated_at,
      saved.settings.updated_by
    );
  }

  private buildSecretStateMap(
    schema: PluginSettingsSchema,
    storedMetadata: Readonly<
      Record<string, { readonly configured: boolean; readonly updated_at: string | null }>
    >
  ): Record<string, PluginSecretFieldState> {
    const out: Record<string, PluginSecretFieldState> = {};
    for (const field of iteratePluginSettingFields(schema)) {
      if (!isSecretPluginSettingField(field)) {
        continue;
      }
      const meta = storedMetadata[field.key];
      out[field.key] = {
        configured: meta?.configured === true,
        updated_at: meta?.configured === true ? (meta.updated_at ?? null) : null,
      };
    }
    return out;
  }

  private toConfiguredMap(
    secrets: Readonly<Record<string, PluginSecretFieldState>>
  ): Readonly<Record<string, boolean>> {
    const out: Record<string, boolean> = {};
    for (const [key, state] of Object.entries(secrets)) {
      out[key] = state.configured;
    }
    return out;
  }

  private async buildSnapshot(entry: CompiledConfigurablePlugin): Promise<PluginSettingsSnapshot> {
    const [storedSettings, storedSecretMetadata] = this.deps.store
      ? await Promise.all([
          this.deps.store.getSettings(entry.plugin.id),
          this.deps.store.getSecretMetadata(entry.plugin.id),
        ])
      : [null, {}];

    const secrets = this.buildSecretStateMap(entry.schema, storedSecretMetadata);
    return this.buildSnapshotFromState(
      entry,
      storedSettings?.values ?? {},
      secrets,
      storedSettings?.updated_at ?? null,
      storedSettings?.updated_by ?? null
    );
  }

  private async buildSnapshotFromState(
    entry: CompiledConfigurablePlugin,
    storedValues: Readonly<Record<string, PluginSettingScalarValue>>,
    secrets: Readonly<Record<string, PluginSecretFieldState>>,
    updatedAt: string | null,
    updatedBy: string | null
  ): Promise<PluginSettingsSnapshot> {
    const { values: defaults, readonlyValues } = extractPluginSettingsDefaults(entry.schema);
    const mergedValues: Record<string, PluginSettingScalarValue> = { ...defaults };

    for (const field of iteratePluginSettingFields(entry.schema)) {
      if (field.type === 'readonly' || isSecretPluginSettingField(field)) {
        continue;
      }
      if (Object.hasOwn(storedValues, field.key)) {
        mergedValues[field.key] = storedValues[field.key] ?? null;
      }
    }

    const configuredSecrets = this.toConfiguredMap(secrets);
    const resolvedReadonly: Record<string, PluginSettingScalarValue> = { ...readonlyValues };

    if (typeof entry.plugin.getReadonlySettings === 'function') {
      const readonlyCtxValues: Record<string, PluginSettingScalarValue> = { ...mergedValues };
      for (const preserveKey of entry.schema.preserveKeys ?? []) {
        if (!Object.hasOwn(readonlyCtxValues, preserveKey) && Object.hasOwn(storedValues, preserveKey)) {
          readonlyCtxValues[preserveKey] = storedValues[preserveKey] ?? null;
        }
      }
      try {
        const dynamicReadonly = await entry.plugin.getReadonlySettings({
          siteConfig: this.deps.siteConfig,
          ports: this.deps.ports,
          mode: this.deps.mode,
          values: readonlyCtxValues,
          configuredSecrets,
        });
        for (const key of Object.keys(readonlyValues)) {
          if (Object.hasOwn(dynamicReadonly, key)) {
            resolvedReadonly[key] = sanitizeReadonlyValue(dynamicReadonly[key]);
          }
        }
      } catch (error) {
        this.reportPluginError(entry.plugin.id, error);
      }
    }

    let status: PluginRuntimeStatus = entry.plugin.status ?? 'active';
    if (typeof entry.plugin.getStatus === 'function') {
      try {
        const probe = await entry.plugin.getStatus({
          siteConfig: this.deps.siteConfig,
          ports: this.deps.ports,
          mode: this.deps.mode,
        });
        const parsedStatus = PluginRuntimeStatusSchema.safeParse(probe.status);
        if (parsedStatus.success) {
          status = parsedStatus.data;
        }
      } catch (error) {
        this.reportPluginError(entry.plugin.id, error);
      }
    }
    const version = entry.plugin.version?.trim() ? entry.plugin.version.trim() : 'unversioned';

    return PluginSettingsSnapshotSchema.parse({
      plugin_id: entry.plugin.id,
      plugin_name: entry.plugin.name,
      plugin_version: version,
      status,
      schema: entry.serializedSchema,
      values: mergedValues,
      secrets,
      readonly_values: resolvedReadonly,
      updated_at: updatedAt,
      updated_by: updatedBy,
    });
  }

  private reportPluginError(pluginId: string, error: unknown): void {
    try {
      this.deps.onPluginError?.(pluginId, error);
    } catch {
      // Isolate error reporter failures so settings administration remains available.
    }
  }
}
