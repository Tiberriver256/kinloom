import {
  getAppBuildId,
  isChunkLoadError,
  reportClientError,
  safeSessionStorage,
  shouldAttemptChunkReload,
} from '../lib/clientTelemetry.js';
import React from 'react';

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
    const heading = chunkStale
      ? 'A newer archive version is available'
      : 'This page could not be displayed';
    const kicker = (this.props.siteTitle || 'Family Archive').toUpperCase();

    return (
      <main className="archive-recovery-page" data-testid="archive-recovery-card">
        <div className="archive-recovery-card" role="alert">
          <div className="archive-recovery-kicker">{kicker}</div>
          <h1 className="archive-recovery-title">{heading}</h1>
          <p className="archive-recovery-lead">
            {chunkStale
              ? 'This tab held an older page bundle after an archive update. Reload to open the current version.'
              : 'Something interrupted rendering this archive view. Reload the page or return to the family index.'}
          </p>
          <div className="archive-recovery-actions">
            <button type="button" className="archive-recovery-btn primary" onClick={reloadCurrentPage}>
              Reload page
            </button>
            <button type="button" className="archive-recovery-btn" onClick={this.returnToArchiveHome}>
              Return to Archive Home
            </button>
          </div>
          <details className="archive-recovery-details">
            <summary>Technical details</summary>
            <pre className="archive-recovery-tech">
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
