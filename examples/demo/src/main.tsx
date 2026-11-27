// Side-effect CSS import for Kinloom archival styles and design tokens.
import '@kinloom/ui/styles/archival.css';
import type { ArchiveDataSource } from '@kinloom/core';
import type { KinloomUiPlugin } from '@kinloom/ui';
import {
  createHttpWikiDataSource,
  createNarrativeAudioPlugin,
  createStaticArchiveDataSource,
  installGlobalErrorHandlers,
  KinloomApp,
} from '@kinloom/ui';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { demoStoryPlugin } from './demoStoryPlugin.js';
import { demoSiteConfig } from './generated/siteConfig.js';

installGlobalErrorHandlers();

const rootElement = document.querySelector('#root');
if (!rootElement) {
  throw new Error('Root element #root not found');
}

type BackendMode = 'static' | 'http';

function readEnvFlag(name: string): string | undefined {
  const env = import.meta.env as Record<string, string | undefined>;
  return env[name];
}

function resolveBackendMode(): BackendMode {
  const meta = document.querySelector<HTMLMetaElement>('meta[name="kinloom-backend"]');
  if (meta?.content === 'http' || readEnvFlag('VITE_KINLOOM_BACKEND') === 'http') {
    return 'http';
  }
  return 'static';
}

const narrativeAudioPlugin = createNarrativeAudioPlugin();

function resolveDemoPlugins(): readonly KinloomUiPlugin[] {
  const meta = document.querySelector<HTMLMetaElement>('meta[name="kinloom-demo-plugin"]');
  if (meta?.content === 'true' || readEnvFlag('VITE_KINLOOM_DEMO_PLUGIN') === 'true') {
    return [narrativeAudioPlugin, demoStoryPlugin];
  }
  return [narrativeAudioPlugin];
}

const backendMode = resolveBackendMode();
const dataSource: ArchiveDataSource =
  backendMode === 'http'
    ? createHttpWikiDataSource({
        apiBaseUrl: '',
        assetBaseUrl: import.meta.env.BASE_URL,
        fetchImpl: (input, init) => globalThis.fetch(input, init),
      })
    : createStaticArchiveDataSource(import.meta.env.BASE_URL, (input, init) => globalThis.fetch(input, init));

const plugins = resolveDemoPlugins();

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <KinloomApp
      siteConfig={demoSiteConfig}
      dataSource={dataSource}
      plugins={plugins}
      baseUrl={import.meta.env.BASE_URL}
    />
  </React.StrictMode>
);
