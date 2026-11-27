import React from 'react';
import { useLocation } from 'react-router-dom';
import { getAppBuildId, reportClientError } from '../browser/clientTelemetry.js';

const BLANK_WATCH_DELAY_MS = 1800;
const MIN_ROOT_HEIGHT_PX = 40;

function rootLooksBlank(): { blank: boolean; detail: string } {
  const root = document.querySelector('#root');
  if (!root) {
    return { blank: true, detail: 'root missing' };
  }
  const childCount = root.children.length;
  const { height } = root.getBoundingClientRect();
  const rootText = (root.textContent ?? '').trim();
  const hasLoadingOrError = Boolean(
    root.querySelector('.archive-loading-shell, .archive-recovery-card, .archive-error-box')
  );
  const hasVisibleContent =
    childCount > 0 && height > MIN_ROOT_HEIGHT_PX && (rootText.length > 0 || hasLoadingOrError);
  if (hasVisibleContent) {
    return { blank: false, detail: '' };
  }
  return {
    blank: true,
    detail: `rootChildren=${childCount} rootHeight=${Math.round(height)} rootTextLen=${rootText.length}`,
  };
}

export const BlankScreenWatchdog: React.FC = () => {
  const location = useLocation();

  React.useEffect(() => {
    const route = `${location.pathname}${location.search}`;
    const timer = window.setTimeout(() => {
      const { blank, detail } = rootLooksBlank();
      if (!blank) {
        return;
      }
      reportClientError({
        kind: 'blank_screen',
        message: `Blank #root after navigation (${detail})`,
        route,
        buildId: getAppBuildId(),
      });
    }, BLANK_WATCH_DELAY_MS);
    return (): void => {
      window.clearTimeout(timer);
    };
  }, [location.pathname, location.search]);

  return null;
};
