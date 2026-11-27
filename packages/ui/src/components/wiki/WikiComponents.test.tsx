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
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { StaticDemoDataSource } from '../../adapters/staticDemoDataSource.js';
import { ArchiveProvider } from '../../context/ArchiveProvider.js';
import {
  formatLineageGroupLabel,
  formatTreeCardName,
  formatTreeCardPlace,
} from '../../lib/treeNodeDisplay.js';
import { RecentChangesPage } from '../../pages/RecentChangesPage.js';
import { initialsOf } from '../Atoms.js';
import { AuthStatusBanner, getInviteStripDismissKey } from './AuthStatusBanner.js';
import { buildUniquePersonIdentity, CreateEntityModal } from './CreateEntityModal.js';
import { EntityEditDrawer } from './EntityEditDrawer.js';
import { PrivateArchiveGate } from './PrivateArchiveGate.js';
import { RevisionDiffView } from './RevisionDiffView.js';
import { TalkPanel } from './TalkPanel.js';
import { AuthorPill, CitationBadge, ConflictBadge } from './WikiBadges.js';

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
      </div>
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
      />
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
      <ArchiveProvider siteConfig={siteConfig} initialBundle={testBundle} dataSource={mockDataSource}>
        <EntityEditDrawer
          open
          entityType="person"
          entityId="p_clara"
          revisionId={1}
          initialData={testBundle.people[0]}
          title="Clara Barton"
          onClose={() => {}}
        />
      </ArchiveProvider>
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
      b.textContent?.includes('Rebase & Save Again')
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
      </MemoryRouter>
    );

    expect(container.textContent).toContain('Batch wave_census_1880');
    expect(container.textContent).toContain('Add family note');

    const agentTab = [...container.querySelectorAll<HTMLButtonElement>('button[role="tab"]')].find((b) =>
      b.textContent?.includes('Research Agents')
    );
    act(() => {
      agentTab?.click();
    });
    expect(container.textContent).toContain('Batch wave_census_1880');
    expect(container.textContent).not.toContain('Add family note');

    const revertBatchBtn = [...container.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Revert Entire Batch')
    );
    await act(async () => {
      revertBatchBtn?.click();
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(revertedBatches).toEqual([]);
    const confirmBatchBtn = [...container.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Confirm Batch Revert')
    );
    expect(confirmBatchBtn).toBeDefined();
    await act(async () => {
      confirmBatchBtn?.click();
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
      </MemoryRouter>
    );

    expect(container.textContent).toContain('Verify baptismal date in parish roll.');
    const textarea = container.querySelector('textarea')!;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    act(() => {
      setter?.call(textarea, 'Confirmed in town register p. 4.');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      container
        .querySelector('form')
        ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(posted).toEqual(['Confirmed in town register p. 4.']);
    expect(container.textContent).toContain('Confirmed in town register p. 4.');

    const deleteButtons = [...container.querySelectorAll<HTMLButtonElement>('button')].filter(
      (b) => b.textContent === 'Delete'
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

    // Invite strip check (compact copy + sessionStorage dismissal)
    window.sessionStorage.clear();
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
      </MemoryRouter>
    );
    expect(inviteRender.container.textContent).toContain('Family invite (Holiday Reunion)');
    expect(inviteRender.container.textContent).toContain('Sign in to edit');
    const signInBtn = [...inviteRender.container.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Sign in to edit')
    );
    act(() => {
      signInBtn?.click();
    });
    expect(
      inviteRender.container.querySelector('dialog[aria-label="Sign in to family archive"]')
    ).not.toBeNull();
    const closeSignInBtn = [...inviteRender.container.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === 'Close'
    );
    act(() => {
      closeSignInBtn?.click();
    });
    const dismissBtn = inviteRender.container.querySelector<HTMLButtonElement>(
      'button[aria-label="Dismiss family invite notice"]'
    );
    expect(dismissBtn).not.toBeNull();
    act(() => {
      dismissBtn?.click();
    });
    expect(inviteRender.container.querySelector('.wiki-auth-banner')).toBeNull();
    expect(window.sessionStorage.getItem(getInviteStripDismissKey('Holiday Reunion'))).toBe('1');
    inviteRender.unmount();

    // Remounting with same invite label stays dismissed; different invite label renders again
    const remountSame = renderIntoDom(
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
      </MemoryRouter>
    );
    expect(remountSame.container.querySelector('.wiki-auth-banner')).toBeNull();
    remountSame.unmount();

    const remountOther = renderIntoDom(
      <MemoryRouter>
        <ArchiveProvider
          siteConfig={siteConfig}
          initialBundle={testBundle}
          session={{
            authenticated: false,
            principal_kind: 'invite_viewer',
            role: 'viewer',
            inviteLabel: 'Spring Gathering',
          }}
        >
          <AuthStatusBanner />
        </ArchiveProvider>
      </MemoryRouter>
    );
    expect(remountOther.container.textContent).toContain('Family invite (Spring Gathering)');
    remountOther.unmount();
    window.sessionStorage.clear();
  });

  it('creates new relative with sex, lineage_group, collision-checked per_ ID, and kinship edge in one submit', async () => {
    const { bundle: twoPersonBundle } = compileArchive({
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
        {
          id: 'per_stephen_barton',
          slug: 'stephen-barton',
          full_name: 'Stephen Barton',
          given_name: 'Stephen',
          surname: 'Barton',
          alt_names: ['Capt. Barton'],
          sex: 'M',
          is_living: false,
          lineage_group: 'ancestor',
          birth_edtf: '1774-08-18',
          death_edtf: '1862-03-21',
          portrait_url: null,
        },
      ],
      places: [],
      events: [],
      sources: [],
      kinship: [],
    });

    // Collision check helper produces per_<slug>_2 when per_<slug> exists
    expect(buildUniquePersonIdentity('Stephen Barton', twoPersonBundle.people)).toEqual({
      id: 'per_stephen_barton_2',
      slug: 'stephen-barton-2',
    });

    const createdCalls: { entityType: string; entityId: string; data: Record<string, unknown> }[] = [];
    let closedCount = 0;
    const mockDataSource: ArchiveDataSource = {
      loadArchive: async () => ({ bundle: twoPersonBundle, etag: '"r2"', notModified: false }),
      loadReadings: async () => null,
      createEntity: async (entityType, input) => {
        const resolvedEntityId = input.entity_id ?? '';
        createdCalls.push({
          entityType,
          entityId: resolvedEntityId,
          data: input.data,
        });
        return {
          entity: input.data,
          revision: {
            revision_id: createdCalls.length + 1,
            batch_id: null,
            entity_type: entityType,
            entity_id: resolvedEntityId,
            parent_revision_id: null,
            action: 'create',
            reverted_revision_id: null,
            author_id: 'editor@example.com',
            author_name: 'Editor',
            author_type: 'human',
            summary: input.summary,
            has_primary_source: input.has_primary_source,
            before_json: null,
            after_json: input.data,
            created_at: '2026-11-25T10:00:00Z',
          },
          etag: `"r${createdCalls.length + 1}"`,
        };
      },
    };

    const setInput = (el: HTMLInputElement, value: string): void => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter?.call(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    };
    const setSelect = (el: HTMLSelectElement, value: string): void => {
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
      setter?.call(el, value);
      el.dispatchEvent(new Event('change', { bubbles: true }));
    };

    const { container, unmount } = renderIntoDom(
      <ArchiveProvider siteConfig={siteConfig} initialBundle={twoPersonBundle} dataSource={mockDataSource}>
        <CreateEntityModal
          open
          relativeContext={{
            anchorPersonId: 'p_clara',
            anchorPersonName: 'Clara Barton',
            relation: 'parent',
          }}
          onClose={() => {
            closedCount += 1;
          }}
        />
      </ArchiveProvider>
    );

    expect(container.querySelector('h2')?.textContent).toBe('Add parent of Clara Barton');
    const selects = [...container.querySelectorAll<HTMLSelectElement>('select')];
    const sexSelect = selects[0];
    const lineageSelect = selects[1];
    expect(lineageSelect.value).toBe('ancestor');

    const textInputs = [...container.querySelectorAll<HTMLInputElement>('input[type="text"]')];
    const givenInput = textInputs[0];
    const surnameInput = textInputs[1];
    const birthInput = textInputs[2];
    const summaryInput = textInputs[textInputs.length - 1];

    act(() => {
      setInput(givenInput, 'Sarah');
      setInput(surnameInput, 'Stone');
      setSelect(sexSelect, 'F');
      setInput(birthInput, '1783-06-14');
      setInput(summaryInput, 'Added mother from town register');
    });

    await act(async () => {
      container
        .querySelector('form')
        ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await new Promise((r) => setTimeout(r, 20));
    });

    expect(closedCount).toBe(1);
    expect(createdCalls).toHaveLength(2);
    expect(createdCalls[0]).toEqual({
      entityType: 'person',
      entityId: 'per_sarah_stone',
      data: expect.objectContaining({
        id: 'per_sarah_stone',
        slug: 'sarah-stone',
        full_name: 'Sarah Stone',
        sex: 'F',
        lineage_group: 'ancestor',
        birth_edtf: '1783-06-14',
      }),
    });
    expect(createdCalls[1]).toEqual({
      entityType: 'kinship_edge',
      entityId: 'per_sarah_stone:parent:p_clara',
      data: {
        from: 'per_sarah_stone',
        to: 'p_clara',
        relation: 'parent',
      },
    });
    unmount();

    // Link existing person mode filters candidates, excludes anchor, and creates only the kinship edge
    createdCalls.length = 0;
    const linkRender = renderIntoDom(
      <ArchiveProvider siteConfig={siteConfig} initialBundle={twoPersonBundle} dataSource={mockDataSource}>
        <CreateEntityModal
          open
          relativeContext={{
            anchorPersonId: 'p_clara',
            anchorPersonName: 'Clara Barton',
            relation: 'parent',
          }}
          onClose={() => {}}
        />
      </ArchiveProvider>
    );

    const linkTab = [...linkRender.container.querySelectorAll<HTMLButtonElement>('button[role="tab"]')].find(
      (b) => b.textContent?.includes('Link existing person')
    );
    act(() => {
      linkTab?.click();
    });

    const candidateSelect = linkRender.container.querySelector<HTMLSelectElement>('select')!;
    const optionValues = [...candidateSelect.options].map((o) => o.value);
    expect(optionValues).toContain('per_stephen_barton');
    expect(optionValues).not.toContain('p_clara');

    const filterInput = linkRender.container.querySelector<HTMLInputElement>('input[type="search"]')!;
    const linkSummaryInput = linkRender.container.querySelector<HTMLInputElement>('input[type="text"]')!;
    act(() => {
      setInput(filterInput, 'Stephen');
      setSelect(candidateSelect, 'per_stephen_barton');
      setInput(linkSummaryInput, 'Linked father from vital records');
    });

    await act(async () => {
      linkRender.container
        .querySelector('form')
        ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await new Promise((r) => setTimeout(r, 20));
    });

    expect(createdCalls).toEqual([
      {
        entityType: 'kinship_edge',
        entityId: 'per_stephen_barton:parent:p_clara',
        data: {
          from: 'per_stephen_barton',
          to: 'p_clara',
          relation: 'parent',
        },
      },
    ]);
    linkRender.unmount();

    // Child relative mode defaults lineage_group to 'descendant' and links anchor -> newChild as 'parent'
    createdCalls.length = 0;
    const childRender = renderIntoDom(
      <ArchiveProvider siteConfig={siteConfig} initialBundle={twoPersonBundle} dataSource={mockDataSource}>
        <CreateEntityModal
          open
          relativeContext={{
            anchorPersonId: 'per_stephen_barton',
            anchorPersonName: 'Stephen Barton',
            relation: 'child',
          }}
          onClose={() => {}}
        />
      </ArchiveProvider>
    );
    const childSelects = [...childRender.container.querySelectorAll<HTMLSelectElement>('select')];
    expect(childSelects[1].value).toBe('descendant');
    const childInputs = [...childRender.container.querySelectorAll<HTMLInputElement>('input[type="text"]')];
    act(() => {
      setInput(childInputs[0], 'Sally');
      setInput(childInputs[1], 'Barton');
      setSelect(childSelects[0], 'F');
      setInput(childInputs[childInputs.length - 1], 'Added child from family register');
    });
    await act(async () => {
      childRender.container
        .querySelector('form')
        ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(createdCalls[1]).toEqual({
      entityType: 'kinship_edge',
      entityId: 'per_stephen_barton:parent:per_sally_barton',
      data: {
        from: 'per_stephen_barton',
        to: 'per_sally_barton',
        relation: 'parent',
      },
    });
    childRender.unmount();

    // Standalone + Add Person exposes Sex and Lineage group selects
    createdCalls.length = 0;
    const standaloneRender = renderIntoDom(
      <ArchiveProvider siteConfig={siteConfig} initialBundle={twoPersonBundle} dataSource={mockDataSource}>
        <CreateEntityModal open defaultKind="person" onClose={() => {}} />
      </ArchiveProvider>
    );
    const standaloneSelects = [...standaloneRender.container.querySelectorAll<HTMLSelectElement>('select')];
    const standaloneTextInputs = [
      ...standaloneRender.container.querySelectorAll<HTMLInputElement>('input[type="text"]'),
    ];
    act(() => {
      setInput(standaloneTextInputs[0], 'David');
      setInput(standaloneTextInputs[1], 'Barton');
      setSelect(standaloneSelects[0], 'M');
      setSelect(standaloneSelects[1], 'collateral');
      setInput(standaloneTextInputs[standaloneTextInputs.length - 1], 'Added sibling from census');
    });
    await act(async () => {
      standaloneRender.container
        .querySelector('form')
        ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(createdCalls).toHaveLength(1);
    expect(createdCalls[0].entityId).toBe('per_david_barton');
    expect(createdCalls[0].data).toMatchObject({
      sex: 'M',
      lineage_group: 'collateral',
    });
    standaloneRender.unmount();
  });

  it('formats tree node labels, names, and generic census subdivisions without private strings', () => {
    expect(formatLineageGroupLabel('pivot_ancestor')).toBe('Focus Ancestor');
    expect(formatLineageGroupLabel('descendant')).toBe('Descendant');
    expect(formatTreeCardName('Jonathan William Prescott Jr.', 22)).toBe('Jonathan W. Prescott Jr.');

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

  it('computes clean monograms in initialsOf without punctuation, years, titles, or suffixes', () => {
    expect(initialsOf('Abraham Lincoln (1744)')).toBe('AL');
    expect(initialsOf('Nancy Hanks (Sr.)')).toBe('NH');
    expect(initialsOf('Samuel Lincoln Jr.')).toBe('SL');
    expect(initialsOf('Mordecai Lincoln III')).toBe('ML');
    expect(initialsOf('Col. Robert Todd')).toBe('RT');
    expect(initialsOf('Senator James Harlan')).toBe('JH');
    expect(initialsOf('Clara')).toBe('CL');
  });

  it('hides Continue with Google in PrivateArchiveGate when google OAuth is unconfigured and shows it when enabled', async () => {
    const makeSource = (googleEnabled: boolean): ArchiveDataSource => ({
      loadArchive: async () => ({ bundle: testBundle, etag: null, notModified: false }),
      loadReadings: async () => null,
      requestMagicLink: async () => ({ sent: true }),
      getSession: async () => ({
        session: { authenticated: false, principal_kind: 'anonymous' },
        capabilities: {
          canEdit: false,
          canUploadMedia: false,
          hasRevisionHistory: false,
          hasTalk: false,
          canManageSite: false,
        },
        authProviders: { google: googleEnabled, magicLink: true },
      }),
    });

    const withoutGoogle = renderIntoDom(
      <ArchiveProvider siteConfig={siteConfig} dataSource={makeSource(false)} initialBundle={testBundle}>
        <PrivateArchiveGate />
      </ArchiveProvider>
    );
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(withoutGoogle.container.textContent).toContain('Email Magic Link');
    expect(withoutGoogle.container.textContent).not.toContain('Continue with Google');
    withoutGoogle.unmount();

    const withGoogle = renderIntoDom(
      <ArchiveProvider siteConfig={siteConfig} dataSource={makeSource(true)} initialBundle={testBundle}>
        <PrivateArchiveGate />
      </ArchiveProvider>
    );
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(withGoogle.container.textContent).toContain('Email Magic Link');
    expect(withGoogle.container.textContent).toContain('Continue with Google');
    withGoogle.unmount();
  });
});
