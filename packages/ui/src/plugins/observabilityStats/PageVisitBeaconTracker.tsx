import type React from 'react';
import { useEffect, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import { useOptionalArchiveData } from '../../context/ArchiveDataContext.js';
import { useObservabilityStatsContext } from './ObservabilityStatsContext.js';

/**
 * Router-aware SPA visit beacon mounted inside `slots.appShell` (inside the active Router).
 * Sends cookie-free, privacy-first beacons on client-side route transitions without double-counting
 * the initial server-rendered HTML document load or unauthenticated private-archive gates.
 */
export const PageVisitBeaconTracker: React.FC = () => {
  const location = useLocation();
  const archiveData = useOptionalArchiveData();
  const { client, recordSpaBeacons, initialLoadWasUnauthenticated } = useObservabilityStatsContext();

  const initialDocPathRef = useRef<string | null>(
    typeof window !== 'undefined' ? window.location.pathname : null
  );
  const initialHandledRef = useRef<boolean>(false);
  const lastRecordedPathRef = useRef<string | null>(null);

  const hasBundle = archiveData !== null ? archiveData.bundle !== null : true;
  const waitingForSession = Boolean(archiveData?.dataSource.getSession && archiveData.session === null);

  useEffect(() => {
    if (!recordSpaBeacons || typeof client.recordPageVisit !== 'function') {
      return;
    }
    if (!hasBundle || waitingForSession) {
      return;
    }
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
      return;
    }

    const currentPath = location.pathname || '/';

    if (!initialHandledRef.current) {
      initialHandledRef.current = true;
      if (
        !initialLoadWasUnauthenticated &&
        initialDocPathRef.current !== null &&
        initialDocPathRef.current === currentPath
      ) {
        lastRecordedPathRef.current = currentPath;
        return;
      }
    }

    if (lastRecordedPathRef.current === currentPath) {
      return;
    }

    lastRecordedPathRef.current = currentPath;
    void client.recordPageVisit(currentPath);
  }, [
    location.pathname,
    hasBundle,
    waitingForSession,
    recordSpaBeacons,
    initialLoadWasUnauthenticated,
    client,
  ]);

  return null;
};
