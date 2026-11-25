// Side-effect CSS import for Kinloom archival styles and design tokens.
// oxlint-disable-next-line import/no-unassigned-import
import '@kinloom/ui/styles/archival.css';
import { KinloomApp, createStaticArchiveDataSource, installGlobalErrorHandlers } from '@kinloom/ui';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { demoSiteConfig } from './generated/siteConfig.js';

installGlobalErrorHandlers();

const rootElement = document.querySelector('#root');
if (!rootElement) {
  throw new Error('Root element #root not found');
}

const demoDataSource = createStaticArchiveDataSource(
  import.meta.env.BASE_URL,
  (input, init) => globalThis.fetch(input, init),
);

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <KinloomApp
      siteConfig={demoSiteConfig}
      dataSource={demoDataSource}
      baseUrl={import.meta.env.BASE_URL}
    />
  </React.StrictMode>,
);
