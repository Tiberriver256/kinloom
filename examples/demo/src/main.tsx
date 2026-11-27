// Side-effect CSS import for Kinloom archival styles and design tokens.
import '@kinloom/ui/styles/archival.css';
import type { ArchiveDataSource } from '@kinloom/core';
import type { KinloomUiPlugin } from '@kinloom/ui';
import {
  createNarrativeAudioPlugin,
  createStaticArchiveDataSource,
  installGlobalErrorHandlers,
  KinloomApp,
} from '@kinloom/ui';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { demoSiteConfig } from './generated/siteConfig.js';

function readEnvFlag(name: string): string | undefined {
  const env = import.meta.env as Record<string, string | undefined>;
  return env[name];
}

function resolveTelemetryEndpoint(): string | undefined {
  const meta = document.querySelector<HTMLMetaElement>('meta[name="kinloom-telemetry-endpoint"]');
  const configured = meta?.content?.trim() || readEnvFlag('VITE_KINLOOM_TELEMETRY_ENDPOINT')?.trim();
  return configured || undefined;
}

const telemetryEndpoint = resolveTelemetryEndpoint();
installGlobalErrorHandlers(telemetryEndpoint ? { endpoint: telemetryEndpoint } : undefined);

const rootElement = document.querySelector('#root');
if (!rootElement) {
  throw new Error('Root element #root not found');
}

type BackendMode = 'static' | 'http';

function resolveBackendMode(): BackendMode {
  const meta = document.querySelector<HTMLMetaElement>('meta[name="kinloom-backend"]');
  if (meta?.content === 'http' || readEnvFlag('VITE_KINLOOM_BACKEND') === 'http') {
    return 'http';
  }
  return 'static';
}

function isDemoPluginEnabled(): boolean {
  const meta = document.querySelector<HTMLMetaElement>('meta[name="kinloom-demo-plugin"]');
  return meta?.content === 'true' || readEnvFlag('VITE_KINLOOM_DEMO_PLUGIN') === 'true';
}

function isRecipesPluginEnabled(): boolean {
  const meta = document.querySelector<HTMLMetaElement>('meta[name="kinloom-recipes-plugin"]');
  return meta?.content === 'true' || readEnvFlag('VITE_KINLOOM_RECIPES_PLUGIN') === 'true';
}

async function bootstrap(container: Element): Promise<void> {
  const narrativeAudioPlugin = createNarrativeAudioPlugin();
  const backendMode = resolveBackendMode();

  const dataSource: ArchiveDataSource =
    backendMode === 'http'
      ? (await import('@kinloom/ui/adapters/httpWikiDataSource')).createHttpWikiDataSource({
          apiBaseUrl: '',
          assetBaseUrl: import.meta.env.BASE_URL,
          fetchImpl: (input, init) => globalThis.fetch(input, init),
        })
      : createStaticArchiveDataSource(import.meta.env.BASE_URL, (input, init) =>
          globalThis.fetch(input, init)
        );

  const plugins: KinloomUiPlugin[] = [narrativeAudioPlugin];
  if (isDemoPluginEnabled()) {
    plugins.push((await import('./demoStoryPlugin.js')).demoStoryPlugin);
  }
  if (isRecipesPluginEnabled()) {
    plugins.push((await import('@kinloom/ui/plugins/recipesPlugin')).createRecipesUiPlugin());
  }

  ReactDOM.createRoot(container).render(
    <React.StrictMode>
      <KinloomApp
        siteConfig={demoSiteConfig}
        dataSource={dataSource}
        plugins={plugins}
        baseUrl={import.meta.env.BASE_URL}
      />
    </React.StrictMode>
  );
}

void bootstrap(rootElement);
