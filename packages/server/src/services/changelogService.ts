import {
  type AdminChangelogsResponse,
  AdminChangelogsResponseSchema,
  getBuiltinModuleChangelogs,
  KINLOOM_CORE_VERSION,
  type ModuleChangelog,
} from '@kinloom/core';
import type { KinloomServerPlugin } from '../http/pluginLifecycle.js';
import { KINLOOM_SERVER_VERSION } from '../version.js';

export interface ChangelogServiceDeps {
  readonly plugins: readonly KinloomServerPlugin[];
  readonly workerVersion?: string | null | undefined;
  readonly now?: (() => Date) | undefined;
}

export class ChangelogService {
  private readonly plugins: readonly KinloomServerPlugin[];
  private readonly workerVersion: string | null;
  private readonly now: () => Date;

  constructor(deps: ChangelogServiceDeps) {
    this.plugins = deps.plugins;
    this.workerVersion = deps.workerVersion ?? null;
    this.now = deps.now ?? (() => new Date());
  }

  getChangelogs(): AdminChangelogsResponse {
    const modules = getBuiltinModuleChangelogs({
      coreVersion: KINLOOM_CORE_VERSION,
      serverVersion: KINLOOM_SERVER_VERSION,
      workerVersion: this.workerVersion,
    });

    const plugins: ModuleChangelog[] = this.plugins.map((plugin) => ({
      id: plugin.id,
      name: plugin.name,
      kind: 'server_plugin',
      current_version: plugin.version ?? KINLOOM_SERVER_VERSION,
      entries: plugin.changelog ? [...plugin.changelog] : [],
    }));

    return AdminChangelogsResponseSchema.parse({
      generated_at: this.now().toISOString(),
      modules,
      plugins,
    });
  }
}
