import React from 'react';
import {
  getAppBuildId,
  isChunkLoadError,
  reportClientError,
  safeSessionStorage,
  shouldAttemptChunkReload,
} from '../lib/clientTelemetry.js';
import { cx } from '../lib/cx.js';
import cssMod0 from '../pages/TreeAndMapPage.module.css';

const uiStyles = cssMod0;

interface BoundaryState {
  hasError: boolean;
  error: Error | null;
  chunkStale: boolean;
}

export interface AppErrorBoundaryProps {
  siteTitle?: string;
  baseUrl?: string;
  children: React.ReactNode;
}

function reloadCurrentPage(): void {
  window.location.reload();
}

export class AppErrorBoundary extends React.Component<AppErrorBoundaryProps, BoundaryState> {
  public constructor(props: AppErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null, chunkStale: false };
  }

  public static getDerivedStateFromError(error: Error): BoundaryState {
    return {
      hasError: true,
      error,
      chunkStale: isChunkLoadError(error),
    };
  }

  public override componentDidCatch(error: Error, info: React.ErrorInfo): void {
    const route = `${window.location.pathname}${window.location.search}`;
    if (isChunkLoadError(error) && shouldAttemptChunkReload(safeSessionStorage())) {
      reportClientError({
        kind: 'chunk_preload',
        message: error.message,
        stack: error.stack ?? undefined,
        componentStack: info.componentStack ?? undefined,
        route,
        buildId: getAppBuildId(),
      });
      reloadCurrentPage();
      return;
    }
    reportClientError({
      kind: 'react_boundary',
      message: error.message,
      stack: error.stack ?? undefined,
      componentStack: info.componentStack ?? undefined,
      route,
      buildId: getAppBuildId(),
    });
  }

  private readonly returnToArchiveHome = (): void => {
    const envBase = typeof import.meta !== 'undefined' ? import.meta.env?.BASE_URL : undefined;
    const home = this.props.baseUrl || envBase || '/';
    window.location.assign(home);
  };

  public override render(): React.ReactNode {
    if (!this.state.hasError || !this.state.error) {
      return this.props.children;
    }

    const { error, chunkStale } = this.state;
    const heading = chunkStale ? 'A newer archive version is available' : 'This page could not be displayed';
    const kicker = (this.props.siteTitle || 'Family Archive').toUpperCase();

    return (
      <main className={cx(uiStyles, 'archive-recovery-page')} data-testid="archive-recovery-card">
        <div className={cx(uiStyles, 'archive-recovery-card')} role="alert">
          <div className={cx(uiStyles, 'archive-recovery-kicker')}>{kicker}</div>
          <h1 className={cx(uiStyles, 'archive-recovery-title')}>{heading}</h1>
          <p className={cx(uiStyles, 'archive-recovery-lead')}>
            {chunkStale
              ? 'This page was updated since you opened it. Reload to view the latest version.'
              : 'Something interrupted loading this page. Reload the page or return to the family index.'}
          </p>
          <div className={cx(uiStyles, 'archive-recovery-actions')}>
            <button
              type="button"
              className={cx(uiStyles, 'archive-recovery-btn primary')}
              onClick={reloadCurrentPage}
            >
              Reload page
            </button>
            <button
              type="button"
              className={cx(uiStyles, 'archive-recovery-btn')}
              onClick={this.returnToArchiveHome}
            >
              Return to Archive Home
            </button>
          </div>
          <details className={cx(uiStyles, 'archive-recovery-details')}>
            <summary>Technical details</summary>
            <pre className={cx(uiStyles, 'archive-recovery-tech')}>
              {error.message}
              {'\n'}
              build: {getAppBuildId()}
            </pre>
          </details>
        </div>
      </main>
    );
  }
}
