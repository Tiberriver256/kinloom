import {
  type AdminDocEntry,
  type AdminDocsResponse,
  AdminDocsResponseSchema,
  getBuiltinAdminDocs,
  validatePluginDocumentation,
} from '@kinloom/core';
import type { KinloomServerPlugin } from '../http/pluginLifecycle.js';

export interface AdminDocsServiceDeps {
  readonly plugins: readonly KinloomServerPlugin[];
  readonly now?: () => Date;
}

export class AdminDocsService {
  private readonly plugins: readonly KinloomServerPlugin[];
  private readonly now: () => Date;

  constructor(deps: AdminDocsServiceDeps) {
    this.plugins = deps.plugins;
    this.now = deps.now ?? (() => new Date());
  }

  getDocs(): AdminDocsResponse {
    const coreDocs = getBuiltinAdminDocs();
    const pluginDocs: AdminDocEntry[] = [];

    for (const plugin of this.plugins) {
      if (!plugin.documentation) {
        continue;
      }
      const validated = validatePluginDocumentation(plugin.documentation, `Server plugin '${plugin.id}'`);
      pluginDocs.push({
        id: validated.id,
        title: validated.title,
        summary: validated.summary,
        kind: 'server_plugin',
        source_id: plugin.id,
        source_name: plugin.name,
        sections: validated.sections,
        ...(validated.externalUrl ? { external_url: validated.externalUrl } : {}),
      });
    }

    return AdminDocsResponseSchema.parse({
      generated_at: this.now().toISOString(),
      core_docs: coreDocs,
      plugin_docs: pluginDocs,
    });
  }
}
