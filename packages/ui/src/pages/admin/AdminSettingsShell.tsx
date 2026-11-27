import type { AdminDiagnosticsReport } from '@kinloom/core';
import type React from 'react';
import { PluginSlot } from '../../plugins/PluginContext.js';
import { SystemDiagnosticsSection } from './SystemDiagnosticsSection.js';

export interface AdminSettingsShellProps {
  readonly diagnostics: AdminDiagnosticsReport | null;
  readonly diagnosticsLoading: boolean;
  readonly diagnosticsError: string | null;
  readonly diagnosticsSupported: boolean;
  readonly onRefreshDiagnostics: () => Promise<void>;
  /** Extensible slot for additional core or plugin settings sections (e.g. plugin settingsSchema forms, observability stats). */
  readonly extraPanels?: React.ReactNode;
}

/**
 * Composable Admin Settings area inside AdminPage.
 * Hosts Core Application Settings & Diagnostics plus plugin-contributed adminSettings panels.
 */
export const AdminSettingsShell: React.FC<AdminSettingsShellProps> = ({
  diagnostics,
  diagnosticsLoading,
  diagnosticsError,
  diagnosticsSupported,
  onRefreshDiagnostics,
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
    <PluginSlot name="adminSettings" />
    {extraPanels}
  </div>
);
