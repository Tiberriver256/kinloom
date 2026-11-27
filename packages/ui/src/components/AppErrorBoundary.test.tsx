/** @vitest-environment jsdom */

import assert from 'node:assert/strict';
import type React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { test } from 'vitest';
import { AppErrorBoundary } from './AppErrorBoundary.js';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function BrokenChild(): React.ReactElement {
  throw new Error('render exploded');
}

const HealthyChild = (): React.ReactElement => <div data-testid="healthy">Recovered view</div>;

test('AppErrorBoundary shows site-branded recovery card and resets when key changes', () => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);

  const origError = console.error;
  console.error = (): void => {};
  try {
    act(() => {
      root.render(
        <AppErrorBoundary key="/broken" siteTitle="Barton Historical Archive">
          <BrokenChild />
        </AppErrorBoundary>
      );
    });
  } finally {
    console.error = origError;
  }

  const alert = container.querySelector('[role="alert"]');
  assert.ok(alert);
  assert.match(alert?.textContent ?? '', /BARTON HISTORICAL ARCHIVE/);
  assert.match(alert?.textContent ?? '', /This page could not be displayed/);
  assert.ok(container.querySelector('.archive-recovery-btn.primary'));

  act(() => {
    root.render(
      <AppErrorBoundary key="/recovered" siteTitle="Barton Historical Archive">
        <HealthyChild />
      </AppErrorBoundary>
    );
  });
  assert.equal(container.querySelector('[role="alert"]'), null);
  assert.equal(container.querySelector('[data-testid="healthy"]')?.textContent, 'Recovered view');

  act(() => {
    root.unmount();
  });
  container.remove();
});
