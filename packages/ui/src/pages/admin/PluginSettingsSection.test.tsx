/** @vitest-environment jsdom */
import type {
  AdminDataSource,
  ArchiveBundle,
  ArchiveDataSource,
  KinloomSiteConfig,
  PluginSettingsSnapshot,
  PluginSettingsUpdateRequest,
} from '@kinloom/core';
import { compileArchive, parseKinloomConfig } from '@kinloom/core';
import type React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiClientError, createHttpWikiDataSource } from '../../adapters/httpWikiDataSource.js';
import { ArchiveProvider } from '../../context/ArchiveProvider.js';
import { AdminPage } from '../AdminPage.js';
import { PluginSettingsSection } from './PluginSettingsSection.js';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const SITE_CONFIG: KinloomSiteConfig = parseKinloomConfig({
  site: {
    title: 'Synthetic Plugin Settings Archive',
    familyName: 'Vance Family',
    gedcomSourceName: 'PLUGIN_SETTINGS_UI_TEST',
  },
});

const { bundle: SAMPLE_BUNDLE }: { bundle: ArchiveBundle } = compileArchive({
  siteConfig: SITE_CONFIG,
  mode: 'private',
  people: [],
  places: [],
  events: [],
  sources: [],
  kinship: [],
});

const OBSERVABILITY_SNAPSHOT: PluginSettingsSnapshot = {
  plugin_id: 'kinloom-workers-observability',
  plugin_name: 'Cloudflare Workers Observability',
  plugin_version: '0.43.0',
  status: 'active',
  schema: {
    title: 'Cloudflare Backend & Observability',
    description: 'Inspect runtime bindings and configure safe telemetry toggles.',
    sections: [
      {
        id: 'runtime_status',
        title: 'Runtime & Backend Status',
        fields: [
          { key: 'runtime_platform', label: 'Runtime Platform', type: 'readonly' },
          { key: 'storage_bindings', label: 'Active Storage & Email Bindings', type: 'readonly' },
        ],
      },
      {
        id: 'telemetry_controls',
        title: 'Safe Telemetry Controls',
        fields: [
          {
            key: 'emit_server_timing',
            label: 'Emit Server-Timing headers',
            type: 'boolean',
            defaultValue: true,
            helpText: 'Include W3C Server-Timing spans on API responses.',
          },
          {
            key: 'log_level_threshold',
            label: 'Minimum Structured Log Level',
            type: 'select',
            required: true,
            defaultValue: 'info',
            options: [
              { value: 'info', label: 'Info (all requests)' },
              { value: 'warn', label: 'Warn (4xx and 5xx only)' },
              { value: 'error', label: 'Error (5xx only)' },
            ],
          },
        ],
      },
    ],
  },
  values: {
    emit_server_timing: true,
    log_level_threshold: 'info',
  },
  secrets: {},
  readonly_values: {
    runtime_platform: 'cloudflare-workers',
    storage_bindings: 'repository=d1, bundle_cache=r2, media_store=r2',
  },
  updated_at: null,
  updated_by: null,
};

const PRONUNCIATION_SNAPSHOT: PluginSettingsSnapshot = {
  plugin_id: 'kinloom-pronunciation',
  plugin_name: 'Pronunciation & TTS',
  plugin_version: '0.43.0',
  status: 'active',
  schema: {
    title: 'Pronunciation & TTS Settings',
    description: 'Configure TTS backends and write-only masked API keys.',
    sections: [
      {
        id: 'runtime_status',
        title: 'Active TTS Runtime',
        fields: [{ key: 'active_generator', label: 'Active TTS Generator', type: 'readonly' }],
      },
      {
        id: 'tts_routing',
        title: 'TTS Backend & Phonetics',
        fields: [
          {
            key: 'primary_backend',
            label: 'Primary TTS Backend',
            type: 'select',
            required: true,
            defaultValue: 'gemini',
            options: [
              { value: 'gemini', label: 'Google Gemini TTS' },
              { value: 'openai-speech', label: 'OpenAI-Compatible Speech API' },
            ],
          },
          {
            key: 'openai_base_url',
            label: 'OpenAI-Compatible Endpoint URL',
            type: 'url',
            placeholder: 'https://api.openai.com/v1',
          },
          {
            key: 'default_voice',
            label: 'Default Voice',
            type: 'string',
            required: true,
            defaultValue: 'Charon',
          },
          {
            key: 'max_retries',
            label: 'Max Retries',
            type: 'number',
            integer: true,
            min: 0,
            max: 5,
            defaultValue: 2,
          },
        ],
      },
      {
        id: 'provider_credentials',
        title: 'Provider API Keys (Write-Only)',
        fields: [
          {
            key: 'gemini_api_key',
            label: 'Gemini API Key',
            type: 'string',
            secret: true,
            minLength: 8,
            helpText: 'Write-only API key for Google Gemini TTS.',
          },
        ],
      },
    ],
  },
  values: {
    primary_backend: 'gemini',
    openai_base_url: '',
    default_voice: 'Charon',
    max_retries: 2,
  },
  secrets: {
    gemini_api_key: { configured: true, updated_at: '2026-11-27T11:00:00.000Z' },
  },
  readonly_values: {
    active_generator: 'gemini-tts',
  },
  updated_at: '2026-11-27T11:00:00.000Z',
  updated_by: 'steward@archive.example',
};

const cleanups: Array<() => void> = [];

function mountEl(element: React.ReactElement): HTMLDivElement {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  act(() => {
    root.render(element);
  });
  cleanups.push(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });
  return container;
}

async function flushUi(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 15));
  });
}

function setNativeInputValue(input: HTMLInputElement | HTMLSelectElement, value: string): void {
  const proto = input instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

afterEach(() => {
  while (cleanups.length > 0) {
    cleanups.pop()?.();
  }
  vi.restoreAllMocks();
});

describe('Schema-driven Admin Plugin Settings UI & HttpWikiDataSource client', () => {
  it('parses GET and PUT /api/admin/plugin-settings via HttpWikiDataSource and rejects malformed payloads', async () => {
    const validDs = createHttpWikiDataSource({
      fetchImpl: async (input) => {
        const url = String(input);
        if (url.endsWith('/api/admin/plugin-settings')) {
          return new Response(JSON.stringify({ plugins: [OBSERVABILITY_SNAPSHOT, PRONUNCIATION_SNAPSHOT] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        return new Response(JSON.stringify({ plugin: PRONUNCIATION_SNAPSHOT }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    });
    const list = await validDs.admin.getPluginSettings?.();
    expect(list).toHaveLength(2);
    const updated = await validDs.admin.updatePluginSettings?.('kinloom-pronunciation', {
      values: { default_voice: 'Kore' },
    });
    expect(updated?.plugin_id).toBe('kinloom-pronunciation');

    const invalidDs = createHttpWikiDataSource({
      fetchImpl: async () =>
        new Response(JSON.stringify({ plugins: [{ bad: true }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    });
    await expect(invalidDs.admin.getPluginSettings?.()).rejects.toMatchObject({
      code: 'INVALID_API_RESPONSE',
    });
  });

  it('renders both reference plugins in AdminPage, masks secrets, preserves untouched secrets on partial save, and supports replace/clear/validation', async () => {
    let currentPlugins: readonly PluginSettingsSnapshot[] = [OBSERVABILITY_SNAPSHOT, PRONUNCIATION_SNAPSHOT];
    const submittedUpdates: Array<{ pluginId: string; input: PluginSettingsUpdateRequest }> = [];

    const adminClient: AdminDataSource = {
      listUsers: async () => [],
      updateUserRole: async () => {
        throw new Error('not used');
      },
      listInvites: async () => [],
      createInvite: async () => {
        throw new Error('not used');
      },
      revokeInvite: async () => {},
      listAgentTokens: async () => [],
      createAgentToken: async () => {
        throw new Error('not used');
      },
      revokeAgentToken: async () => {},
      getPluginSettings: async () => currentPlugins,
      updatePluginSettings: async (pluginId, input) => {
        submittedUpdates.push({ pluginId, input });
        const target = currentPlugins.find((p) => p.plugin_id === pluginId);
        if (!target) {
          throw new Error('not found');
        }
        const nextSecrets = { ...target.secrets };
        for (const [key, mut] of Object.entries(input.secrets ?? {})) {
          if (mut.action === 'clear') {
            nextSecrets[key] = { configured: false, updated_at: null };
          } else if (mut.action === 'set') {
            nextSecrets[key] = { configured: true, updated_at: '2026-11-27T12:30:00.000Z' };
          }
        }
        const updated: PluginSettingsSnapshot = {
          ...target,
          values: { ...target.values, ...(input.values ?? {}) },
          secrets: nextSecrets,
          updated_at: '2026-11-27T12:30:00.000Z',
        };
        currentPlugins = currentPlugins.map((p) => (p.plugin_id === pluginId ? updated : p));
        return updated;
      },
    };

    const dataSource: ArchiveDataSource = {
      loadArchive: async () => ({ bundle: SAMPLE_BUNDLE, etag: '"r1"', notModified: false }),
      loadReadings: async () => null,
      admin: adminClient,
    };

    const container = mountEl(
      <MemoryRouter initialEntries={['/admin']}>
        <ArchiveProvider
          siteConfig={SITE_CONFIG}
          initialBundle={SAMPLE_BUNDLE}
          dataSource={dataSource}
          session={{
            authenticated: true,
            principal_kind: 'user',
            email: 'steward@archive.example',
            displayName: 'Archive Steward',
            role: 'admin',
          }}
          capabilities={{ canEdit: true, canManageSite: true, canUploadMedia: true }}
        >
          <AdminPage />
        </ArchiveProvider>
      </MemoryRouter>
    );
    await flushUi();
    await flushUi();

    const section = container.querySelector('[data-testid="admin-plugin-settings"]');
    expect(section).not.toBeNull();
    expect(section?.textContent).toContain('Cloudflare Backend & Observability');
    expect(section?.textContent).toContain('repository=d1, bundle_cache=r2, media_store=r2');
    expect(section?.textContent).toContain('Pronunciation & TTS Settings');
    expect(section?.textContent).toContain('Configured');

    // 1. Save an unrelated field (Default Voice) on Pronunciation without touching Gemini API Key
    const pronCard = container.querySelector('[data-testid="plugin-settings-card-kinloom-pronunciation"]');
    expect(pronCard).not.toBeNull();
    const voiceInput = pronCard?.querySelector<HTMLInputElement>('input[name="default_voice"]');
    expect(voiceInput?.value).toBe('Charon');

    await act(async () => {
      if (voiceInput) {
        setNativeInputValue(voiceInput, 'Kore');
      }
    });
    expect(pronCard?.textContent).toContain('Unsaved Changes');

    const savePronBtn = [...(pronCard?.querySelectorAll('button') ?? [])].find((b) =>
      b.textContent?.includes('Save Pronunciation & TTS Settings')
    );
    await act(async () => {
      savePronBtn?.click();
      await Promise.resolve();
    });
    await flushUi();

    // Verify secret was NOT sent (preserved untouched!)
    expect(submittedUpdates[0]).toEqual({
      pluginId: 'kinloom-pronunciation',
      input: { values: { default_voice: 'Kore' } },
    });
    expect(pronCard?.textContent).toContain('Settings saved.');

    // 2. Replace masked secret with Show/Hide toggle, verify password input & zero plaintext after save
    const replaceBtn = [...(pronCard?.querySelectorAll('button') ?? [])].find((b) =>
      b.textContent?.includes('Replace Gemini API Key')
    );
    await act(async () => {
      replaceBtn?.click();
    });
    const secretInput = pronCard?.querySelector<HTMLInputElement>('input[name="gemini_api_key"]');
    expect(secretInput?.type).toBe('password');

    const showBtn = [...(pronCard?.querySelectorAll('button') ?? [])].find(
      (b) => b.textContent?.trim() === 'Show'
    );
    await act(async () => {
      showBtn?.click();
    });
    expect(secretInput?.type).toBe('text');
    expect(showBtn?.getAttribute('aria-pressed')).toBe('true');

    const newSecretValue = 'AIzaSyMaskedUiSecret_555666777';
    await act(async () => {
      if (secretInput) {
        setNativeInputValue(secretInput, newSecretValue);
      }
    });

    await act(async () => {
      savePronBtn?.click();
      await Promise.resolve();
    });
    await flushUi();

    expect(submittedUpdates[1]).toEqual({
      pluginId: 'kinloom-pronunciation',
      input: { secrets: { gemini_api_key: { action: 'set', value: newSecretValue } } },
    });
    // Plaintext secret MUST be gone from the DOM immediately after saving
    expect(container.innerHTML).not.toContain(newSecretValue);
    expect(pronCard?.querySelector('input[name="gemini_api_key"]')).toBeNull();

    // 3. Clear secret flow (and Keep Existing undo before clearing for real)
    const clearBtn = [...(pronCard?.querySelectorAll('button') ?? [])].find((b) =>
      b.textContent?.includes('Clear Gemini API Key')
    );
    await act(async () => {
      clearBtn?.click();
    });
    expect(pronCard?.textContent).toContain('Pending Clear');

    const keepBtn = [...(pronCard?.querySelectorAll('button') ?? [])].find((b) =>
      b.textContent?.includes('Keep Existing')
    );
    await act(async () => {
      keepBtn?.click();
    });
    expect(pronCard?.textContent).not.toContain('Pending Clear');

    // Clear and save
    const clearBtnAgain = [...(pronCard?.querySelectorAll('button') ?? [])].find((b) =>
      b.textContent?.includes('Clear Gemini API Key')
    );
    await act(async () => {
      clearBtnAgain?.click();
    });
    await act(async () => {
      savePronBtn?.click();
      await Promise.resolve();
    });
    await flushUi();
    expect(submittedUpdates[2]).toEqual({
      pluginId: 'kinloom-pronunciation',
      input: { secrets: { gemini_api_key: { action: 'clear' } } },
    });
    expect(pronCard?.textContent).toContain('Not Configured');

    // 4. Toggle switch + select + reset on Cloudflare Observability card
    const obsCard = container.querySelector(
      '[data-testid="plugin-settings-card-kinloom-workers-observability"]'
    );
    const toggle = obsCard?.querySelector<HTMLInputElement>(
      'input[type="checkbox"][name="emit_server_timing"]'
    );
    expect(toggle?.getAttribute('role')).toBe('switch');
    expect(toggle?.checked).toBe(true);
    await act(async () => {
      toggle?.click();
    });
    expect(toggle?.checked).toBe(false);
    const resetBtn = [...(obsCard?.querySelectorAll('button') ?? [])].find((b) =>
      b.textContent?.includes('Reset Changes')
    );
    await act(async () => {
      resetBtn?.click();
    });
    expect(toggle?.checked).toBe(true);
  });

  it('surfaces inline validation errors, server 422 field errors, empty, unsupported, and load-error states cleanly', async () => {
    const serverError = new ApiClientError(422, 'VALIDATION_ERROR', 'Endpoint rejected by policy.', {
      field_errors: { openai_base_url: 'Endpoint rejected by policy.' },
    });

    const container = mountEl(
      <PluginSettingsSection
        plugins={[PRONUNCIATION_SNAPSHOT]}
        loading={false}
        error={null}
        supported={true}
        onRefresh={async () => {}}
        onUpdatePlugin={async () => {
          throw serverError;
        }}
      />
    );
    await flushUi();

    // Client-side validation blocks invalid URL before hitting server
    const urlInput = container.querySelector<HTMLInputElement>('input[name="openai_base_url"]');
    await act(async () => {
      if (urlInput) {
        urlInput.focus();
        setNativeInputValue(urlInput, 'not-a-valid-url');
        urlInput.blur();
      }
    });
    expect(urlInput?.getAttribute('aria-invalid')).toBe('true');
    expect(container.textContent).toContain('must be a valid absolute URL');

    // Valid URL hits server and renders structured 422 field error
    await act(async () => {
      if (urlInput) {
        setNativeInputValue(urlInput, 'https://rejected.example.test/v1');
      }
    });
    const saveBtn = [...container.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Save Pronunciation & TTS Settings')
    );
    await act(async () => {
      saveBtn?.click();
      await Promise.resolve();
    });
    await flushUi();
    expect(container.textContent).toContain('Endpoint rejected by policy.');

    // Render unsupported, error, and empty states
    const emptyContainer = mountEl(
      <PluginSettingsSection
        plugins={[]}
        loading={false}
        error="Timeout loading plugin settings"
        supported={false}
        onRefresh={async () => {}}
        onUpdatePlugin={async () => PRONUNCIATION_SNAPSHOT}
      />
    );
    expect(emptyContainer.textContent).toContain('Plugin settings endpoint is not provided');
    expect(emptyContainer.textContent).toContain(
      'Could not load plugin settings: Timeout loading plugin settings'
    );
  });
});
