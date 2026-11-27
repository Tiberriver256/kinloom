/** @vitest-environment jsdom */
import type { ArchiveBundle, KinloomSiteConfig, ReadingsBundle, SourceRecord } from '@kinloom/core';
import { compileArchive, parseKinloomConfig } from '@kinloom/core';
import type React from 'react';
import { act, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ArchiveProvider } from '../context/ArchiveProvider.js';
import { useArchiveUi } from '../context/ArchiveUiContext.js';
import { SourceCitationTag } from './atoms/SourceCitationTag.js';
import { SourceInspectorDrawer } from './SourceInspectorDrawer.js';
import { SourceReaderDrawer } from './SourceReaderDrawer.js';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const siteConfig: KinloomSiteConfig = parseKinloomConfig({
  site: {
    title: 'Synthetic Timer Cleanup Archive',
    familyName: 'Alder Family',
    gedcomSourceName: 'COPY_TIMER_TEST',
  },
});

const syntheticSource: SourceRecord = {
  id: 'src_mill_ledger',
  citation: 'Oakridge County Clerk, Mill Ledger, 1875.',
  source_type: 'vital_record',
  repository: 'Oakridge County Archives',
};

const { bundle: testBundle }: { bundle: ArchiveBundle } = compileArchive({
  siteConfig,
  mode: 'private',
  people: [],
  places: [],
  events: [],
  sources: [syntheticSource],
  kinship: [],
});

const readings: ReadingsBundle = {
  version: 1,
  documents: {
    src_mill_ledger: {
      source_id: 'src_mill_ledger',
      title: 'Oakridge Mill Ledger',
      author: 'Oakridge County Clerk',
      provenance: 'Synthetic Archive',
      pages: [{ page: 1, label: 'Page 1', file: 'page1.txt', text: 'Synthetic page transcription.' }],
    },
  },
  event_page_map: {},
};

const OpenReaderOnMount: React.FC = () => {
  const { openSourceReader } = useArchiveUi();
  useEffect(() => {
    openSourceReader({ sourceId: 'src_mill_ledger' });
  }, [openSourceReader]);
  return null;
};

const OpenInspectorOnMount: React.FC = () => {
  const { openSourceInspector } = useArchiveUi();
  useEffect(() => {
    openSourceInspector({ sourceId: 'src_mill_ledger' });
  }, [openSourceInspector]);
  return null;
};

afterEach(() => {
  vi.useRealTimers();
});

describe('Copy feedback setTimeout cleanup on unmount', () => {
  it('clears SourceReaderDrawer copy-feedback timer on re-click and unmount so no post-teardown callback fires', async () => {
    // Only fake setTimeout/clearTimeout so jsdom's internal focus-fixup setInterval and Document setImmediate stay isolated.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <MemoryRouter>
          <ArchiveProvider siteConfig={siteConfig} initialBundle={testBundle} initialReadings={readings}>
            <OpenReaderOnMount />
            <SourceReaderDrawer />
          </ArchiveProvider>
        </MemoryRouter>
      );
      await Promise.resolve();
    });

    const copyBtn = [...container.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === 'Copy All Text'
    );
    expect(copyBtn?.textContent?.trim()).toBe('Copy All Text');

    await act(async () => {
      copyBtn?.click();
      await Promise.resolve();
    });
    expect(copyBtn?.textContent?.trim()).toBe('Copied all pages');
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);

    await act(async () => {
      copyBtn?.click();
      await Promise.resolve();
    });
    expect(writeText).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(1);

    act(() => {
      root.unmount();
    });
    expect(vi.getTimerCount()).toBe(0);
    vi.runAllTimers();
    container.remove();
  });

  it('clears SourceInspectorDrawer and SourceCitationTag copy-feedback timers cleanly on unmount', async () => {
    // Only fake setTimeout/clearTimeout so jsdom's internal focus-fixup setInterval and Document setImmediate stay isolated.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

    const sourcesById = new Map<string, SourceRecord>([[syntheticSource.id, syntheticSource]]);
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <MemoryRouter>
          <ArchiveProvider siteConfig={siteConfig} initialBundle={testBundle} initialReadings={readings}>
            <OpenInspectorOnMount />
            <SourceInspectorDrawer />
            <SourceCitationTag
              sources={[{ source_id: syntheticSource.id, confidence: 'high' }]}
              sourcesById={sourcesById}
            />
          </ArchiveProvider>
        </MemoryRouter>
      );
      await Promise.resolve();
    });

    const inspectorCopyBtn = [...container.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === 'Copy Citation'
    );
    expect(inspectorCopyBtn?.textContent?.trim()).toBe('Copy Citation');
    await act(async () => {
      inspectorCopyBtn?.click();
      await Promise.resolve();
    });
    expect(inspectorCopyBtn?.textContent?.trim()).toBe('Copied');
    expect(vi.getTimerCount()).toBe(1);

    const toggleBtn = container.querySelector<HTMLButtonElement>('button[aria-expanded="false"]');
    expect(toggleBtn?.getAttribute('aria-expanded')).toBe('false');
    await act(async () => {
      toggleBtn?.click();
    });

    const tagCopyBtn = [...container.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === 'Copy'
    );
    expect(tagCopyBtn?.textContent?.trim()).toBe('Copy');
    await act(async () => {
      tagCopyBtn?.click();
      await Promise.resolve();
    });
    expect(tagCopyBtn?.textContent?.trim()).toBe('Copied');
    expect(writeText).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(2);

    act(() => {
      root.unmount();
    });
    expect(vi.getTimerCount()).toBe(0);
    vi.runAllTimers();
    container.remove();
  });
});
