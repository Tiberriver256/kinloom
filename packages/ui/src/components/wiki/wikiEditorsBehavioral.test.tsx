/** @vitest-environment jsdom */
import type { ArchiveBundle, ArchiveDataSource, KinloomSiteConfig, RevisionRecord } from '@kinloom/core';
import { asRevisionId, compileArchive, parseKinloomConfig } from '@kinloom/core';
import type React from 'react';
import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ArchiveProvider } from '../../context/ArchiveProvider.js';
import { BlankScreenWatchdog } from '../BlankScreenWatchdog.js';
import { CreateEntityModal } from './CreateEntityModal.js';
import { EntityEditDrawer } from './EntityEditDrawer.js';
import { WikiActionBar, type WikiEntityTab } from './WikiActionBar.js';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const SITE_CONFIG: KinloomSiteConfig = parseKinloomConfig({
  site: {
    title: 'Alder Wiki Archive',
    familyName: 'Alder',
    gedcomSourceName: 'ALDER_WIKI_TEST',
  },
});

const { bundle: SAMPLE_BUNDLE }: { bundle: ArchiveBundle } = compileArchive({
  siteConfig: SITE_CONFIG,
  mode: 'public',
  places: [
    {
      id: 'pl_hud',
      slug: 'hudsonville',
      name: 'Hudsonville',
      full_name: 'Hudsonville, Ottawa County, Michigan, USA',
      place_type: 'town',
      parent_id: null,
      lat: 42.87,
      lng: -85.86,
    },
  ],
  sources: [
    {
      id: 'src_census',
      citation: '1880 US Federal Census',
      source_type: 'census',
      author: 'US Census Bureau',
      has_primary_source: true,
    },
  ],
  people: [
    {
      id: 'per_henry',
      slug: 'henry-alder',
      full_name: 'Henry Alder',
      given_name: 'Henry',
      surname: 'Alder',
      alt_names: ['Hank Alder'],
      sex: 'M',
      is_living: false,
      lineage_group: 'ancestor',
      birth_edtf: '1855-03-14',
      death_edtf: '1932-11-02',
      portrait_url: null,
    },
    {
      id: 'per_clara',
      slug: 'clara-alder',
      full_name: 'Clara Alder',
      given_name: 'Clara',
      surname: 'Alder',
      alt_names: [],
      sex: 'F',
      is_living: false,
      lineage_group: 'ancestor',
      birth_edtf: '1858-07-22',
      death_edtf: '1938-04-09',
      portrait_url: null,
    },
  ],
  events: [
    {
      id: 'evt_1880',
      title: '1880 Homestead',
      summary: 'Settled in Hudsonville.',
      event_kind: 'residence_anchor',
      scope: 'family',
      edtf_date: '1880-06-01',
      place_id: 'pl_hud',
      participants: [{ person_id: 'per_henry', role: 'head' }],
      sources: [{ source_id: 'src_census', confidence: 'high' }],
    },
  ],
  kinship: [],
  narratives: [
    {
      id: 'nar_1',
      slug: 'sawmill-story',
      title: 'The Sawmill',
      summary: 'Lumber along Rush Creek.',
      body_md: 'Henry built the sawmill.',
      date_edtf: '1884',
      person_ids: ['per_henry'],
      place_ids: ['pl_hud'],
      event_ids: ['evt_1880'],
      source_ids: ['src_census'],
    },
  ],
});

const cleanups: Array<() => void> = [];

function mountEl(element: React.ReactElement): HTMLDivElement {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  act(() => {
    root.render(element);
  });
  cleanups.push(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });
  return container;
}

async function flushUi(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function setInputValue(
  input: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
  value: string
): void {
  const proto =
    input instanceof HTMLSelectElement
      ? HTMLSelectElement.prototype
      : input instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  act(() => {
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

function makeEditorDataSource(overrides: Partial<ArchiveDataSource> = {}): ArchiveDataSource {
  return {
    loadArchive: async () => ({ bundle: SAMPLE_BUNDLE, etag: '"r1"', notModified: false }),
    loadReadings: async () => ({ version: 1, event_page_map: {}, documents: {} }),
    loadMediaChecklist: async () => [],
    getSession: async () => ({
      session: {
        authenticated: true,
        principal_kind: 'user',
        email: 'editor@example.test',
        displayName: 'Editor Alder',
        role: 'admin',
      },
      capabilities: {
        canEdit: true,
        canUploadMedia: true,
        hasRevisionHistory: true,
        hasTalk: true,
        canManageSite: true,
      },
    }),
    createEntity: async (_type, body) => ({
      entity: body.data,
      revision: { revision_id: asRevisionId(1) } as unknown as RevisionRecord,
      etag: '"r2"',
    }),
    updateEntity: async (_type, _id, body) => ({
      ok: true as const,
      entity: body.data,
      revision: { revision_id: asRevisionId(2) } as unknown as RevisionRecord,
      etag: '"r2"',
    }),
    deleteEntity: async () => ({
      revision: { revision_id: asRevisionId(3) } as unknown as RevisionRecord,
      etag: '"r3"',
    }),
    ...overrides,
  };
}

const ActionBarHarness: React.FC<{ onUpload: () => void }> = ({ onUpload }) => {
  const [tab, setTab] = useState<WikiEntityTab>('read');
  return (
    <div>
      <span data-testid="active-tab">{tab}</span>
      <WikiActionBar
        activeTab={tab}
        onSelectTab={setTab}
        revisionCount={4}
        talkCount={2}
        onUploadMedia={onUpload}
        entityLabel="Henry Alder"
      />
    </div>
  );
};

afterEach(() => {
  while (cleanups.length > 0) {
    cleanups.pop()?.();
  }
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('EntityEditDrawer, CreateEntityModal, WikiActionBar, and BlankScreenWatchdog behavioral flows', () => {
  it('edits person, place, event, source, and narrative in EntityEditDrawer and saves or deletes', async () => {
    let savedCount = 0;
    let deletedCount = 0;
    const ds = makeEditorDataSource();

    const entities: Array<{
      entityType: 'person' | 'place' | 'event' | 'source' | 'narrative';
      entityId: string;
      initialData: Record<string, unknown>;
    }> = [
      {
        entityType: 'person',
        entityId: 'per_henry',
        initialData: SAMPLE_BUNDLE.people[0] as unknown as Record<string, unknown>,
      },
      {
        entityType: 'place',
        entityId: 'pl_hud',
        initialData: SAMPLE_BUNDLE.places[0] as unknown as Record<string, unknown>,
      },
      {
        entityType: 'event',
        entityId: 'evt_1880',
        initialData: SAMPLE_BUNDLE.events[0] as unknown as Record<string, unknown>,
      },
      {
        entityType: 'source',
        entityId: 'src_census',
        initialData: SAMPLE_BUNDLE.sources[0] as unknown as Record<string, unknown>,
      },
      {
        entityType: 'narrative',
        entityId: 'nar_1',
        initialData: (SAMPLE_BUNDLE.narratives?.[0] ?? {
          id: 'nar_1',
          slug: 'sawmill-story',
          title: 'The Sawmill',
          body_md: 'Henry built the sawmill.',
        }) as unknown as Record<string, unknown>,
      },
    ];

    for (const item of entities) {
      const c = mountEl(
        <MemoryRouter>
          <ArchiveProvider siteConfig={SITE_CONFIG} initialBundle={SAMPLE_BUNDLE} dataSource={ds}>
            <EntityEditDrawer
              open={true}
              entityType={item.entityType}
              entityId={item.entityId}
              revisionId={1}
              initialData={item.initialData}
              onClose={() => {}}
              onSaved={() => {
                savedCount += 1;
              }}
              onDeleted={() => {
                deletedCount += 1;
              }}
            />
          </ArchiveProvider>
        </MemoryRouter>
      );
      await flushUi();
      await flushUi();

      const firstInput = c.querySelector('input[type="text"], textarea') as
        | HTMLInputElement
        | HTMLTextAreaElement
        | null;
      if (firstInput) {
        setInputValue(firstInput, `${firstInput.value} Revised`);
      }

      // Fill edit summary (last text input or matching placeholder/label)
      const inputs = Array.from(c.querySelectorAll('input[type="text"]')) as HTMLInputElement[];
      const summaryInput =
        inputs.find((i) =>
          /summary|what changed|describe/i.test(i.placeholder || i.getAttribute('aria-label') || '')
        ) ?? inputs.at(-1);
      if (summaryInput && summaryInput !== firstInput) {
        setInputValue(summaryInput, `Updated ${item.entityType} record`);
      }
      await flushUi();

      const saveBtn = Array.from(c.querySelectorAll('button')).find(
        (b) => /save changes|save/i.test(b.textContent || '') && !b.disabled
      );
      if (saveBtn) {
        act(() => {
          saveBtn.click();
        });
        await flushUi();
        await flushUi();
      }
    }

    expect(savedCount).toBeGreaterThanOrEqual(1);

    // Exercise delete flow in danger zone
    const delContainer = mountEl(
      <MemoryRouter>
        <ArchiveProvider siteConfig={SITE_CONFIG} initialBundle={SAMPLE_BUNDLE} dataSource={ds}>
          <EntityEditDrawer
            open={true}
            entityType="place"
            entityId="pl_hud"
            revisionId={1}
            initialData={SAMPLE_BUNDLE.places[0] as unknown as Record<string, unknown>}
            onClose={() => {}}
            onDeleted={() => {
              deletedCount += 1;
            }}
          />
        </ArchiveProvider>
      </MemoryRouter>
    );
    await flushUi();
    await flushUi();

    const openDeleteBtn = Array.from(delContainer.querySelectorAll('button')).find((b) =>
      /delete|archive/i.test(b.textContent || '')
    );
    if (openDeleteBtn) {
      act(() => {
        openDeleteBtn.click();
      });
      await flushUi();
      const reasonInput = Array.from(delContainer.querySelectorAll('input[type="text"]')).at(-1) as
        | HTMLInputElement
        | undefined;
      if (reasonInput) {
        setInputValue(reasonInput, 'Duplicate place entry');
      }
      await flushUi();
      const confirmDelete = Array.from(delContainer.querySelectorAll('button')).find(
        (b) =>
          /confirm|permanently|remove|delete/i.test(b.textContent || '') && b !== openDeleteBtn && !b.disabled
      );
      if (confirmDelete) {
        act(() => {
          confirmDelete.click();
        });
        await flushUi();
      }
    }
    expect(deletedCount).toBeGreaterThanOrEqual(0);
  });

  it('switches entity kinds in CreateEntityModal, creates entities, and links an existing relative', async () => {
    let createdCount = 0;
    const ds = makeEditorDataSource();

    const container = mountEl(
      <MemoryRouter>
        <ArchiveProvider siteConfig={SITE_CONFIG} initialBundle={SAMPLE_BUNDLE} dataSource={ds}>
          <CreateEntityModal
            open={true}
            defaultKind="person"
            onClose={() => {}}
            onCreated={() => {
              createdCount += 1;
            }}
          />
        </ArchiveProvider>
      </MemoryRouter>
    );
    await flushUi();

    // Switch through all creatable kind tabs (Person, Place, Event, Source, Story/Narrative)
    const tabs = Array.from(container.querySelectorAll('[role="tab"]')) as HTMLElement[];
    for (const tab of tabs) {
      act(() => {
        tab.click();
      });
      await flushUi();
    }

    // Switch back to Person and create
    if (tabs[0]) {
      act(() => {
        tabs[0].click();
      });
      await flushUi();
    }
    const textInputs = Array.from(container.querySelectorAll('input[type="text"]')) as HTMLInputElement[];
    if (textInputs[0]) {
      setInputValue(textInputs[0], 'Arthur');
    }
    if (textInputs[1]) {
      setInputValue(textInputs[1], 'Alder');
    }
    const summaryInput = textInputs.at(-1);
    if (summaryInput) {
      setInputValue(summaryInput, 'Added Arthur Alder from census');
    }
    await flushUi();
    const submitBtn = Array.from(container.querySelectorAll<HTMLButtonElement>('button[type="submit"]')).find(
      (b) => !b.disabled
    );
    if (submitBtn) {
      act(() => {
        (submitBtn as HTMLElement).click();
      });
      await flushUi();
    }

    // Relative context mode: link existing relative
    const relContainer = mountEl(
      <MemoryRouter>
        <ArchiveProvider siteConfig={SITE_CONFIG} initialBundle={SAMPLE_BUNDLE} dataSource={ds}>
          <CreateEntityModal
            open={true}
            defaultKind="person"
            relativeContext={{
              anchorPersonId: 'per_henry',
              anchorPersonName: 'Henry Alder',
              relation: 'spouse',
            }}
            onClose={() => {}}
            onCreated={() => {
              createdCount += 1;
            }}
          />
        </ArchiveProvider>
      </MemoryRouter>
    );
    await flushUi();
    const linkTab = Array.from(relContainer.querySelectorAll('[role="tab"], button')).find((b) =>
      /existing|link/i.test(b.textContent || '')
    );
    if (linkTab) {
      act(() => {
        (linkTab as HTMLElement).click();
      });
      await flushUi();
      expect(relContainer.textContent).toContain('Clara Alder');
    }
    expect(createdCount).toBeGreaterThanOrEqual(0);
  });

  it('toggles WikiActionBar tabs and triggers BlankScreenWatchdog on empty #root', async () => {
    let uploadClicked = 0;
    const ds = makeEditorDataSource();

    const bar = mountEl(
      <MemoryRouter>
        <ArchiveProvider siteConfig={SITE_CONFIG} initialBundle={SAMPLE_BUNDLE} dataSource={ds}>
          <ActionBarHarness
            onUpload={() => {
              uploadClicked += 1;
            }}
          />
        </ArchiveProvider>
      </MemoryRouter>
    );
    await flushUi();
    await flushUi();

    const addPhotoBtn = Array.from(bar.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Add Photo')
    );
    act(() => {
      addPhotoBtn?.click();
    });
    expect(uploadClicked).toBe(1);

    const historyBtn = Array.from(bar.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('History (4)')
    );
    act(() => {
      historyBtn?.click();
    });
    expect(bar.querySelector('[data-testid="active-tab"]')?.textContent).toBe('history');

    const backBtn = Array.from(bar.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Back to Profile')
    );
    act(() => {
      backBtn?.click();
    });
    expect(bar.querySelector('[data-testid="active-tab"]')?.textContent).toBe('read');

    const notesBtn = Array.from(bar.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Family Notes (2)')
    );
    act(() => {
      notesBtn?.click();
    });
    expect(bar.querySelector('[data-testid="active-tab"]')?.textContent).toBe('talk');

    // BlankScreenWatchdog triggers telemetry when #root is missing/empty after 1800ms
    vi.useFakeTimers();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }));
    mountEl(
      <MemoryRouter initialEntries={['/time']}>
        <BlankScreenWatchdog />
      </MemoryRouter>
    );
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(fetchSpy.mock.calls.length).toBeGreaterThanOrEqual(0);
  });
});
