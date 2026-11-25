/** @vitest-environment jsdom */
import type {
  ArchiveBundle,
  ArchiveDataSource,
  KinloomSiteConfig,
  Place,
  RevisionRecord,
  TalkComment,
} from '@kinloom/core';
import { asRevisionId, compileArchive, parseKinloomConfig } from '@kinloom/core';
import {
  formatLineageGroupLabel,
  formatTreeCardName,
  formatTreeCardPlace,
} from '../../lib/treeNodeDisplay.js';
import { AuthorPill, CitationBadge, ConflictBadge } from './WikiBadges.js';
import { ArchiveProvider } from '../../context/ArchiveProvider.js';
import { AuthStatusBanner } from './AuthStatusBanner.js';
import { EntityEditDrawer } from './EntityEditDrawer.js';
import { MemoryRouter } from 'react-router-dom';
import { RecentChangesPage } from '../../pages/RecentChangesPage.js';
import { RevisionDiffView } from './RevisionDiffView.js';
import { StaticDemoDataSource } from '../../adapters/staticDemoDataSource.js';
import { TalkPanel } from './TalkPanel.js';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const siteConfig: KinloomSiteConfig = parseKinloomConfig({
  site: {
    title: 'Barton Archive',
    familyName: 'Barton Family',
    gedcomSourceName: 'BARTON_WIKI_TEST',
  },
});

const { bundle: testBundle }: { bundle: ArchiveBundle } = compileArchive({
  siteConfig,
  mode: 'private',
  people: [
    {
      id: 'p_clara',
      slug: 'clara-barton',
      full_name: 'Clara Barton',
      given_name: 'Clara',
      surname: 'Barton',
      alt_names: [],
      sex: 'F',
      is_living: false,
      lineage_group: 'pivot_ancestor',
      birth_edtf: '1821-12-25',
      death_edtf: '1912-04-12',
      portrait_url: null,
    },
  ],
  places: [],
  events: [],
  sources: [
    {
      id: 'src_1821',
      citation: 'Oxford Vital Register (1821)',
      source_type: 'vital_record',
    },
  ],
  kinship: [],
});

function renderIntoDom(element: React.ReactElement): {
  container: HTMLDivElement;
  unmount: () => void;
} {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  act(() => {
    root.render(element);
  });
  return {
    container,
    unmount: () => {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

describe('Wiki UI components and tree display polish helpers', () => {
  it('renders WCAG 1.4.1 WikiBadges (Cited, Family memory, Conflict, AuthorPill)', () => {
    const { container, unmount } = renderIntoDom(
      <div>
        <CitationBadge hasPrimarySource />
        <CitationBadge hasPrimarySource={false} />
        <ConflictBadge />
        <AuthorPill authorType="agent" authorName="Archivist Bot" />
        <AuthorPill authorType="system_seed" authorName="seed" />
      </div>,
    );

    expect(container.textContent).toContain('Cited');
    expect(container.textContent).toContain('Family memory');
    expect(container.textContent).toContain('Conflict');
    expect(container.textContent).toContain('Research agent · Archivist Bot');
    expect(container.textContent).toContain('Initial seed');
    expect(container.querySelectorAll('svg').length).toBe(3);
    unmount();
  });

  it('renders visual field diff table with +/-/~ indicators in RevisionDiffView', () => {
    const { container, unmount } = renderIntoDom(
      <RevisionDiffView
        before={{ full_name: 'Clara Barton', birth_edtf: '1821' }}
        after={{ full_name: 'Clarissa Harlowe Barton', birth_edtf: '1821-12-25', note: 'Verified' }}
      />,
    );

    expect(container.textContent).toContain('+1 added');
    expect(container.textContent).toContain('~2 changed');
    expect(container.textContent).toContain('Clarissa Harlowe Barton');
    expect(container.textContent).toContain('Verified');
    unmount();
  });

  it('renders EntityEditDrawer, triggers 409 ConflictMergeDialog, and rebases cleanly', async () => {
    let updateCalls = 0;
    const mockDataSource: ArchiveDataSource = {
      loadArchive: async () => ({ bundle: testBundle, etag: '"r1"', notModified: false }),
      loadReadings: async () => null,
      updateEntity: async (_type, _id, input) => {
        updateCalls += 1;
        if (updateCalls === 1) {
          return {
            ok: false,
            conflict: {
              kind: 'conflict',
              entity_type: 'person',
              entity_id: 'p_clara',
              expected_parent_revision_id: asRevisionId(1),
              server_revision_id: asRevisionId(2),
              server_entity: { ...testBundle.people[0], alt_names: ['Clarissa'] },
              server_deleted_at: null,
              last_author_name: 'Peer Editor',
              last_updated_at: '2026-11-24T10:00:00Z',
              diff: {
                fields: [],
                addedCount: 0,
                removedCount: 0,
                changedCount: 0,
                hasChanges: false,
              },
            },
          };
        }
        return {
          ok: true,
          entity: input.data,
          revision: {
            revision_id: 3,
            batch_id: null,
            entity_type: 'person',
            entity_id: 'p_clara',
            parent_revision_id: 2,
            action: 'update',
            reverted_revision_id: null,
            author_id: 'editor@example.com',
            author_name: 'Editor',
            author_type: 'human',
            summary: input.summary,
            has_primary_source: input.has_primary_source,
            before_json: null,
            after_json: input.data,
            created_at: '2026-11-24T10:05:00Z',
          },
          etag: '"r3"',
        };
      },
    };

    const { container, unmount } = renderIntoDom(
      <ArchiveProvider
        siteConfig={siteConfig}
        initialBundle={testBundle}
        dataSource={mockDataSource}
      >
        <EntityEditDrawer
          open
          entityType="person"
          entityId="p_clara"
          revisionId={1}
          initialData={testBundle.people[0]}
          title="Clara Barton"
          onClose={() => {}}
        />
      </ArchiveProvider>,
    );

    const inputs = container.querySelectorAll<HTMLInputElement>('input[type="text"]');
    const fullNameInput = inputs[0];
    const summaryInput = inputs[inputs.length - 1];

    const setReactInput = (el: HTMLInputElement, value: string): void => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter?.call(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    };

    act(() => {
      setReactInput(fullNameInput, 'Clara H. Barton');
      setReactInput(summaryInput, 'Add middle initial from vital register');
    });

    const form = container.querySelector('form');
    await act(async () => {
      form?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await new Promise((r) => setTimeout(r, 20));
    });

    expect(container.textContent).toContain('Edit Conflict · Server at r2');
    expect(container.textContent).toContain('Peer Editor');

    const rebaseBtn = [...container.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Rebase & Save Again'),
    );
    await act(async () => {
      rebaseBtn?.click();
      await new Promise((r) => setTimeout(r, 20));
    });

    expect(updateCalls).toBe(2);
    expect(container.textContent).toContain('Saved revision');
    unmount();
  });

  it('filters RecentChangesPage by author_type and triggers one-click Batch Revert', async () => {
    const revertedBatches: string[] = [];
    const revisions: RevisionRecord[] = [
      {
        revision_id: 11,
        batch_id: 'wave_census_1880',
        entity_type: 'person',
        entity_id: 'p_clara',
        parent_revision_id: 10,
        action: 'update',
        reverted_revision_id: null,
        author_id: 'agent:tok_1',
        author_name: 'Census Research Agent',
        author_type: 'agent',
        summary: 'Add 1880 census occupation',
        has_primary_source: true,
        before_json: { occupation: '' },
        after_json: { occupation: 'Nurse' },
        created_at: '2026-11-24T11:00:00Z',
      },
      {
        revision_id: 9,
        batch_id: null,
        entity_type: 'person',
        entity_id: 'p_clara',
        parent_revision_id: 8,
        action: 'update',
        reverted_revision_id: null,
        author_id: 'editor@example.com',
        author_name: 'Family Editor',
        author_type: 'human',
        summary: 'Add family note',
        has_primary_source: false,
        before_json: {},
        after_json: { note: 'Kindred memory' },
        created_at: '2026-11-24T09:00:00Z',
      },
    ];

    const mockDataSource: ArchiveDataSource = {
      loadArchive: async () => ({ bundle: testBundle, etag: '"r11"', notModified: false }),
      loadReadings: async () => null,
      revertBatch: async (batchId) => {
        revertedBatches.push(batchId);
        return { revisions: [], etag: '"r12"' };
      },
    };

    const { container, unmount } = renderIntoDom(
      <MemoryRouter initialEntries={['/changes']}>
        <ArchiveProvider
          siteConfig={siteConfig}
          initialBundle={testBundle}
          dataSource={mockDataSource}
          session={{ authenticated: true, principal_kind: 'user', role: 'editor', displayName: 'Editor' }}
        >
          <RecentChangesPage initialRevisions={revisions} />
        </ArchiveProvider>
      </MemoryRouter>,
    );

    expect(container.textContent).toContain('Batch wave_census_1880');
    expect(container.textContent).toContain('Add family note');

    const agentTab = [...container.querySelectorAll<HTMLButtonElement>('button[role="tab"]')].find(
      (b) => b.textContent?.includes('Research Agents'),
    );
    act(() => {
      agentTab?.click();
    });
    expect(container.textContent).toContain('Batch wave_census_1880');
    expect(container.textContent).not.toContain('Add family note');

    const revertBatchBtn = [...container.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Revert Entire Batch'),
    );
    await act(async () => {
      revertBatchBtn?.click();
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(revertedBatches).toEqual(['wave_census_1880']);
    unmount();
  });

  it('renders TalkPanel comments, posts and soft-deletes a note, and displays invite AuthStatusBanner', async () => {
    const posted: string[] = [];
    const deleted: number[] = [];
    const initialComments: TalkComment[] = [
      {
        comment_id: 1,
        entity_type: 'person',
        entity_id: 'p_clara',
        author_id: 'editor@example.com',
        author_name: 'Jane Archivist',
        body_md: 'Verify baptismal date in parish roll.',
        created_at: '2026-11-24T08:00:00Z',
        edited_at: null,
        deleted_at: null,
      },
    ];

    const mockDataSource: ArchiveDataSource = {
      loadArchive: async () => ({ bundle: testBundle, etag: '"r1"', notModified: false }),
      loadReadings: async () => null,
      postTalkComment: async (_t, _id, bodyMd) => {
        posted.push(bodyMd);
        return {
          comment_id: 2,
          entity_type: 'person',
          entity_id: 'p_clara',
          author_id: 'editor@example.com',
          author_name: 'Editor',
          body_md: bodyMd,
          created_at: '2026-11-24T08:05:00Z',
          edited_at: null,
          deleted_at: null,
        };
      },
      deleteTalkComment: async (_t, _id, commentId) => {
        deleted.push(commentId);
      },
    };

    const { container, unmount } = renderIntoDom(
      <MemoryRouter>
        <ArchiveProvider
          siteConfig={siteConfig}
          initialBundle={testBundle}
          dataSource={mockDataSource}
          session={{
            authenticated: true,
            principal_kind: 'user',
            role: 'editor',
            email: 'editor@example.com',
            displayName: 'Editor',
          }}
        >
          <TalkPanel
            entityType="person"
            entityId="p_clara"
            entityTitle="Clara Barton"
            initialComments={initialComments}
          />
        </ArchiveProvider>
      </MemoryRouter>,
    );

    expect(container.textContent).toContain('Verify baptismal date in parish roll.');
    const textarea = container.querySelector('textarea')!;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    act(() => {
      setter?.call(textarea, 'Confirmed in town register p. 4.');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      container.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(posted).toEqual(['Confirmed in town register p. 4.']);
    expect(container.textContent).toContain('Confirmed in town register p. 4.');

    const deleteButtons = [...container.querySelectorAll<HTMLButtonElement>('button')].filter(
      (b) => b.textContent === 'Delete',
    );
    expect(deleteButtons.length).toBe(2);
    await act(async () => {
      deleteButtons[1]?.click();
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(deleted).toEqual([2]);
    expect(container.textContent).not.toContain('Confirmed in town register p. 4.');
    unmount();

    // StaticDemoDataSource explicitly reports anonymous session and disabled write capabilities
    const staticSource = new StaticDemoDataSource('/');
    const staticSession = await staticSource.getSession();
    expect(staticSession).toEqual({
      session: { authenticated: false, principal_kind: 'anonymous' },
      capabilities: {
        canEdit: false,
        canUploadMedia: false,
        hasRevisionHistory: false,
        hasTalk: false,
        canManageSite: false,
      },
    });

    // Invite banner check
    const inviteRender = renderIntoDom(
      <MemoryRouter>
        <ArchiveProvider
          siteConfig={siteConfig}
          initialBundle={testBundle}
          session={{
            authenticated: false,
            principal_kind: 'invite_viewer',
            role: 'viewer',
            inviteLabel: 'Holiday Reunion',
          }}
        >
          <AuthStatusBanner />
        </ArchiveProvider>
      </MemoryRouter>,
    );
    expect(inviteRender.container.textContent).toContain('Read-only family invite');
    expect(inviteRender.container.textContent).toContain('Holiday Reunion');
    inviteRender.unmount();
  });

  it('formats tree node labels, names, and generic census subdivisions without private strings', () => {
    expect(formatLineageGroupLabel('pivot_ancestor')).toBe('Pivot Ancestor');
    expect(formatLineageGroupLabel('descendant')).toBe('Descendant');
    expect(formatTreeCardName('Jonathan William Prescott Jr.', 22)).toBe(
      'Jonathan W. Prescott Jr.',
    );

    const county: Place = {
      id: 'pl_county',
      slug: 'worcester-county',
      name: 'Worcester County',
      full_name: 'Worcester County, Massachusetts',
      place_type: 'county',
      parent_id: null,
      lat: 42.26,
      lng: -71.8,
    };
    const precinct: Place = {
      id: 'pl_pct',
      slug: 'precinct-4',
      name: 'Precinct 4',
      full_name: 'Precinct 4, Worcester County, Massachusetts',
      place_type: 'town',
      parent_id: 'pl_county',
      lat: 42.26,
      lng: -71.8,
    };
    const map = new Map<string, Place>([
      [county.id, county],
      [precinct.id, precinct],
    ]);
    expect(formatTreeCardPlace(precinct, map)).toBe('Worcester Co.');
  });
});
