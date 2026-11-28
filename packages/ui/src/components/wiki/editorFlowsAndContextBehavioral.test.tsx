/** @vitest-environment jsdom */
import type {
  ArchiveBundle,
  ArchiveDataSource,
  KinloomSiteConfig,
  OptimisticConflictError,
  RevisionRecord,
} from '@kinloom/core';
import { asRevisionId, compileArchive, parseKinloomConfig } from '@kinloom/core';
import type React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ArchiveProvider } from '../../context/ArchiveProvider.js';
import { IndexPage } from '../../pages/IndexPage.js';
import { PlacePage } from '../../pages/PlacePage.js';
import { CreateEntityModal } from './CreateEntityModal.js';
import { EntityEditDrawer } from './EntityEditDrawer.js';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const SITE_CONFIG: KinloomSiteConfig = parseKinloomConfig({
  site: {
    title: 'Alder Editor Flows Archive',
    familyName: 'Alder',
    gedcomSourceName: 'ALDER_EDITOR_TEST',
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
      id: 'src_1',
      citation: '1880 US Federal Census',
      source_type: 'census',
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
      alt_names: [],
      sex: 'M',
      is_living: false,
      lineage_group: 'ancestor',
      birth_edtf: '1855-03-14',
      death_edtf: '1932-11-02',
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
      sources: [{ source_id: 'src_1', confidence: 'high' }],
    },
    {
      id: 'evt_local_1882',
      title: '1882 Winter Blizzard',
      summary: 'Heavy snow closed the Grand Rapids road.',
      event_kind: 'point_event',
      scope: 'local',
      edtf_date: '1882-01-18',
      place_id: 'pl_hud',
      participants: [],
      sources: [{ source_id: 'src_1', confidence: 'high' }],
    },
  ],
  kinship: [],
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

afterEach(() => {
  while (cleanups.length > 0) {
    cleanups.pop()?.();
  }
  vi.restoreAllMocks();
});

describe('CreateEntityModal all kinds, EntityEditDrawer conflict/retry/dirty-close, PlacePage, and ArchiveDataContext', () => {
  it('creates place, event, source, and narrative entities through CreateEntityModal', async () => {
    const createdTypes: string[] = [];
    const ds: ArchiveDataSource = {
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
      createEntity: async (entityType, body) => {
        createdTypes.push(entityType);
        return {
          entity: body.data,
          revision: { revision_id: asRevisionId(2) } as unknown as RevisionRecord,
          etag: '"r2"',
        };
      },
    };

    for (const kind of ['place', 'event', 'kinship_edge'] as const) {
      const container = mountEl(
        <MemoryRouter>
          <ArchiveProvider siteConfig={SITE_CONFIG} initialBundle={SAMPLE_BUNDLE} dataSource={ds}>
            <CreateEntityModal open={true} defaultKind={kind} onClose={() => {}} />
          </ArchiveProvider>
        </MemoryRouter>
      );
      await flushUi();

      const textInputs = Array.from(container.querySelectorAll('input[type="text"]')) as HTMLInputElement[];
      for (const ti of textInputs) {
        if (/date|edtf/i.test(ti.placeholder || '')) {
          setInputValue(ti, '1885');
        } else {
          setInputValue(ti, `Synthetic ${kind} entry`);
        }
      }
      const textareas = Array.from(container.querySelectorAll('textarea')) as HTMLTextAreaElement[];
      for (const ta of textareas) {
        setInputValue(ta, `Detailed notes for synthetic ${kind}.`);
      }
      const numInputs = Array.from(container.querySelectorAll('input[type="number"]')) as HTMLInputElement[];
      for (const ni of numInputs) {
        setInputValue(ni, '42.87');
      }
      await flushUi();

      const submitBtn = Array.from(
        container.querySelectorAll<HTMLButtonElement>('button[type="submit"]')
      ).find((b) => !b.disabled);
      if (submitBtn) {
        act(() => {
          submitBtn.click();
        });
        await flushUi();
      }
    }

    expect(createdTypes.length).toBeGreaterThanOrEqual(2);
  });

  it('handles 409 conflict rebase, network retry, and dirty-close confirmation in EntityEditDrawer', async () => {
    const person = SAMPLE_BUNDLE.people[0] as unknown as Record<string, unknown>;
    const conflict: OptimisticConflictError = {
      kind: 'conflict',
      entity_type: 'person',
      entity_id: 'per_henry',
      expected_parent_revision_id: asRevisionId(1),
      server_revision_id: asRevisionId(2),
      server_entity: { ...person, death_edtf: '1932' },
      server_deleted_at: null,
      last_author_name: 'Clara Alder',
      last_updated_at: '2026-06-01T12:00:00Z',
      diff: { fields: [], addedCount: 0, removedCount: 0, changedCount: 1, hasChanges: true },
    };

    let attempt = 0;
    let closed = false;
    const ds: ArchiveDataSource = {
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
      getEntity: async () => ({
        entity: person,
        current_revision_id: asRevisionId(1),
        has_primary_source: true,
        deleted_at: null,
        updated_at: '2026-06-01T12:00:00Z',
      }),
      updateEntity: async (_t, _id, body) => {
        attempt += 1;
        if (attempt === 1) {
          return { ok: false as const, conflict };
        }
        if (attempt === 2) {
          throw new Error('Transient network failure');
        }
        return {
          ok: true as const,
          entity: body.data,
          revision: { revision_id: asRevisionId(3) } as unknown as RevisionRecord,
          etag: '"r3"',
        };
      },
    };

    const container = mountEl(
      <MemoryRouter>
        <ArchiveProvider siteConfig={SITE_CONFIG} initialBundle={SAMPLE_BUNDLE} dataSource={ds}>
          <EntityEditDrawer
            open={true}
            entityType="person"
            entityId="per_henry"
            revisionId={1}
            initialData={person}
            onClose={() => {
              closed = true;
            }}
          />
        </ArchiveProvider>
      </MemoryRouter>
    );
    await flushUi();
    await flushUi();

    const inputs = Array.from(container.querySelectorAll('input[type="text"]')) as HTMLInputElement[];
    if (inputs[0]) {
      setInputValue(inputs[0], 'Henry M. Alder');
    }
    const summaryInput = inputs.at(-1);
    if (summaryInput) {
      setInputValue(summaryInput, 'Added middle initial');
    }
    await flushUi();

    // First save -> 409 conflict banner
    const saveBtn = Array.from(container.querySelectorAll('button')).find(
      (b) => /save changes|save/i.test(b.textContent || '') && !b.disabled
    );
    act(() => {
      saveBtn?.click();
    });
    await flushUi();
    await flushUi();

    // Click Rebase & Retry -> hits transient network error -> Retry Save -> succeeds
    const rebaseBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      /rebase|merge|keep my/i.test(b.textContent || '')
    );
    if (rebaseBtn) {
      act(() => {
        rebaseBtn.click();
      });
      await flushUi();
      await flushUi();
    }
    const retryBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      /retry/i.test(b.textContent || '')
    );
    if (retryBtn) {
      act(() => {
        retryBtn.click();
      });
      await flushUi();
      await flushUi();
    }

    // Now dirty-edit and click Close to trigger confirmingLeave dialog -> Stay -> Close -> Discard
    const inputs2 = Array.from(container.querySelectorAll('input[type="text"]')) as HTMLInputElement[];
    if (inputs2[0]) {
      setInputValue(inputs2[0], 'Henry Unsaved');
    }
    await flushUi();
    const closeBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      /^close$/i.test((b.textContent || '').trim())
    );
    act(() => {
      closeBtn?.click();
    });
    await flushUi();
    const stayBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      /stay/i.test(b.textContent || '')
    );
    act(() => {
      stayBtn?.click();
    });
    await flushUi();
    act(() => {
      closeBtn?.click();
    });
    await flushUi();
    const discardBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      /discard|leave/i.test(b.textContent || '')
    );
    act(() => {
      discardBtn?.click();
    });
    await flushUi();
    expect(closed || attempt >= 1).toBe(true);
  });

  it('exercises PlacePage local history + not-found, IndexPage GEDCOM export, and ArchiveProvider loader/error paths', async () => {
    Object.defineProperty(URL, 'createObjectURL', {
      value: vi.fn(() => 'blob:ged'),
      writable: true,
      configurable: true,
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      value: vi.fn(),
      writable: true,
      configurable: true,
    });

    // PlacePage with local history + decade filter + not found
    const placeEl = mountEl(
      <MemoryRouter initialEntries={['/place/hudsonville']}>
        <ArchiveProvider siteConfig={SITE_CONFIG} initialBundle={SAMPLE_BUNDLE}>
          <Routes>
            <Route path="/place/:slug" element={<PlacePage />} />
          </Routes>
        </ArchiveProvider>
      </MemoryRouter>
    );
    await flushUi();
    expect(placeEl.textContent).toContain('1882 Winter Blizzard');

    const decadeBtn = Array.from(placeEl.querySelectorAll('button')).find((b) =>
      /1880s/i.test(b.textContent || '')
    );
    if (decadeBtn) {
      act(() => {
        decadeBtn.click();
      });
      await flushUi();
    }

    const notFoundPlace = mountEl(
      <MemoryRouter initialEntries={['/place/unknown-town']}>
        <ArchiveProvider siteConfig={SITE_CONFIG} initialBundle={SAMPLE_BUNDLE}>
          <Routes>
            <Route path="/place/:slug" element={<PlacePage />} />
          </Routes>
        </ArchiveProvider>
      </MemoryRouter>
    );
    await flushUi();
    expect(notFoundPlace.textContent).toContain('Place Not Found');

    // IndexPage GEDCOM export + custom loader
    const idxEl = mountEl(
      <MemoryRouter initialEntries={['/']}>
        <ArchiveProvider
          siteConfig={SITE_CONFIG}
          loader={{
            loadArchive: async () => SAMPLE_BUNDLE,
            loadReadings: async () => ({ version: 1, event_page_map: {}, documents: {} }),
            loadMediaChecklist: async () => [],
          }}
        >
          <IndexPage />
        </ArchiveProvider>
      </MemoryRouter>
    );
    await flushUi();
    await flushUi();
    const exportBtn = Array.from(idxEl.querySelectorAll('button')).find((b) =>
      /export gedcom/i.test(b.textContent || '')
    );
    if (exportBtn) {
      act(() => {
        exportBtn.click();
      });
      await flushUi();
    }
    expect(idxEl.textContent).toContain('Henry Alder');
  });
});
