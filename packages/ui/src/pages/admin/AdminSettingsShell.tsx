import type {
  AdminDiagnosticsReport,
  PluginSettingsSnapshot,
  PluginSettingsUpdateRequest,
} from '@kinloom/core';
import type React from 'react';
import { PluginSlot } from '../../plugins/PluginContext.js';
import { PluginSettingsSection } from './PluginSettingsSection.js';
import { SystemDiagnosticsSection } from './SystemDiagnosticsSection.js';

export interface AdminSettingsShellProps {
  readonly diagnostics: AdminDiagnosticsReport | null;
  readonly diagnosticsLoading: boolean;
  readonly diagnosticsError: string | null;
  readonly diagnosticsSupported: boolean;
  readonly onRefreshDiagnostics: () => Promise<void>;
  readonly pluginSettings?: readonly PluginSettingsSnapshot[];
  readonly pluginSettingsLoading?: boolean;
  readonly pluginSettingsError?: string | null;
  readonly pluginSettingsSupported?: boolean;
  readonly onRefreshPluginSettings?: () => Promise<void>;
  readonly onUpdatePluginSettings?: (
    pluginId: string,
    input: PluginSettingsUpdateRequest
  ) => Promise<PluginSettingsSnapshot>;
  /** Extensible slot for additional core or plugin settings sections (e.g. plugin settingsSchema forms, observability stats). */
  readonly extraPanels?: React.ReactNode;
}

/**
 * Composable Admin Settings area inside AdminPage.
 * Hosts Core Application Settings & Diagnostics, declarative Plugins & Integrations settings,
 * and plugin-contributed adminSettings panels.
 */
export const AdminSettingsShell: React.FC<AdminSettingsShellProps> = ({
  diagnostics,
  diagnosticsLoading,
  diagnosticsError,
  diagnosticsSupported,
  onRefreshDiagnostics,
  pluginSettings = [],
  pluginSettingsLoading = false,
  pluginSettingsError = null,
  pluginSettingsSupported = false,
  onRefreshPluginSettings,
  onUpdatePluginSettings,
  extraPanels,
}) => (
  <div data-testid="admin-settings-shell">
    <SystemDiagnosticsSection
      report={diagnostics}
      loading={diagnosticsLoading}
      error={diagnosticsError}
      supported={diagnosticsSupported}
      onRefresh={onRefreshDiagnostics}
    />
    {pluginSettingsSupported && onRefreshPluginSettings && onUpdatePluginSettings && (
      <PluginSettingsSection
        plugins={pluginSettings}
        loading={pluginSettingsLoading}
        error={pluginSettingsError}
        supported={pluginSettingsSupported}
        onRefresh={onRefreshPluginSettings}
        onUpdatePlugin={onUpdatePluginSettings}
      />
    )}
    <PluginSlot name="adminSettings" />
    {extraPanels}
  </div>
);
