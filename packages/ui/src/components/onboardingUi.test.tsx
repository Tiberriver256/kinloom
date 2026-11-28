/** @vitest-environment jsdom */
import {
  type AdminDataSource,
  type ArchiveBundle,
  type ArchiveDataSource,
  compileArchive,
  createDefaultOnboardingSessionResponse,
  type KinloomSiteConfig,
  type OnboardingSessionResponse,
  parseKinloomConfig,
  type UpdateOnboardingStateRequest,
} from '@kinloom/core';
import type React from 'react';
import { act, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHttpWikiDataSource } from '../adapters/httpWikiDataSource.js';
import { createStaticArchiveDataSource } from '../adapters/staticDemoDataSource.js';
import { ArchiveProvider } from '../context/ArchiveProvider.js';
import { useOnboarding } from '../context/OnboardingContext.js';
import { KinloomApp } from '../KinloomApp.js';
import { AdminPage } from '../pages/AdminPage.js';
import { EvidencePage } from '../pages/EvidencePage.js';
import { IndexPage } from '../pages/IndexPage.js';
import { TimePage } from '../pages/TimePage.js';
import { TreePage } from '../pages/TreePage.js';
import { createNarrativeAudioPlugin } from '../plugins/narrativeAudioPlugin.js';
import type { KinloomOnboardingContext, KinloomUiPlugin } from '../plugins/types.js';
import {
  resolveDynamicPluginOnboardingSteps,
  validateAndCompileUiPlugins,
} from '../plugins/validatePlugins.js';
import { ExplorerTopBar } from './ExplorerTopBar.js';
import { KeyboardShortcutsDialog, QuickArchiveGuideDialog } from './GuideOverlays.js';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
window.scrollTo = () => {};

const SITE_CONFIG: KinloomSiteConfig = parseKinloomConfig({
  site: {
    title: 'Synthetic Heritage Archive',
    familyName: 'Synthetic Family',
    gedcomSourceName: 'ONBOARDING_UI_TEST',
  },
});

const EMPTY_BUNDLE: ArchiveBundle = compileArchive({
  siteConfig: SITE_CONFIG,
  mode: 'public',
  people: [],
  places: [],
  events: [],
  sources: [],
  kinship: [],
}).bundle;

function createSeededBundle(withNarratedAudio = false): ArchiveBundle {
  return compileArchive({
    siteConfig: SITE_CONFIG,
    mode: 'public',
    people: [
      {
        id: 'p_arthur',
        slug: 'arthur-hale',
        full_name: 'Arthur Hale',
        given_name: 'Arthur',
        surname: 'Hale',
        alt_names: [],
        sex: 'M',
        is_living: false,
        lineage_group: 'pivot_ancestor',
        birth_edtf: '1848',
        death_edtf: '1918',
        portrait_url: null,
      },
    ],
    places: [
      {
        id: 'pl_springfield',
        slug: 'springfield',
        name: 'Springfield',
        full_name: 'Springfield, Illinois',
        place_type: 'town',
        parent_id: null,
        lat: 39.78,
        lng: -89.65,
      },
    ],
    events: [
      {
        id: 'ev_1880',
        title: '1880 Residence',
        summary: '1880 Springfield residence',
        scope: 'personal',
        event_kind: 'residence_anchor',
        edtf_date: '1880',
        place_id: 'pl_springfield',
        participants: [{ person_id: 'p_arthur', role: 'primary' }],
        sources: [],
      },
    ],
    sources: [],
    kinship: [],
    narratives: withNarratedAudio
      ? [
          {
            id: 'nar_arthur',
            slug: 'arthur-story',
            title: 'Arthur Hale Biography',
            kind: 'biography',
            subject_person_id: 'p_arthur',
            person_ids: ['p_arthur'],
            place_ids: [],
            event_ids: [],
            source_ids: [],
            body_md: 'A synthetic biography.',
            extensions: {
              narrative_audio: {
                file: 'audio/arthur.mp3',
                duration_seconds: 95,
              },
            },
          },
        ]
      : [],
  }).bundle;
}

const LauncherRegistrar: React.FC<{ readonly onLaunch: (chapterId?: string) => void }> = ({ onLaunch }) => {
  const { registerTutorialLauncher } = useOnboarding();
  useEffect(() => registerTutorialLauncher(onLaunch), [registerTutorialLauncher, onLaunch]);
  return null;
};

async function mountComponent(node: React.ReactElement): Promise<{
  container: HTMLDivElement;
  unmount: () => Promise<void>;
}> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(node);
    await Promise.resolve();
  });
  return {
    container,
    unmount: async () => {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    },
  };
}

function findButtonByText(root: ParentNode, text: string): HTMLButtonElement | undefined {
  return [...root.querySelectorAll('button')].find(
    (btn) => btn.textContent?.trim() === text || btn.getAttribute('aria-label') === text
  );
}

describe('UI plugin onboarding seam validation and Narrative Audio reference step', () => {
  it('validates static onboardingSteps fail-fast with RangeError on invalid shapes, core: spoofing, duplicates, and unsafe routes', () => {
    expect(() =>
      validateAndCompileUiPlugins([
        {
          id: 'bad-prefix',
          name: 'Bad Prefix',
          onboardingSteps: [{ id: 'core:spoof', title: 'Spoof', description: 'Cannot use core:' }],
        },
      ])
    ).toThrow(RangeError);

    expect(() =>
      validateAndCompileUiPlugins([
        {
          id: 'dup-a',
          name: 'Dup A',
          onboardingSteps: [{ id: 'shared:step', title: 'A', description: 'Desc A' }],
        },
        {
          id: 'dup-b',
          name: 'Dup B',
          onboardingSteps: [{ id: 'shared:step', title: 'B', description: 'Desc B' }],
        },
      ])
    ).toThrow(RangeError);

    expect(() =>
      validateAndCompileUiPlugins([
        {
          id: 'bad-route',
          name: 'Bad Route',
          onboardingSteps: [
            {
              id: 'bad-route:step',
              title: 'Unsafe',
              description: 'Unsafe route',
              targetRoute: 'javascript:alert(1)',
            },
          ],
        },
      ])
    ).toThrow(RangeError);

    expect(() =>
      validateAndCompileUiPlugins([
        {
          id: 'bad-action',
          name: 'Bad Action',
          onboardingSteps: [
            {
              id: 'bad-action:step',
              title: 'Unsafe Action',
              description: 'Unsafe route action',
              action: { kind: 'route', to: '//evil.example', label: 'Go' },
            },
          ],
        },
      ])
    ).toThrow(RangeError);

    expect(() =>
      validateAndCompileUiPlugins([
        {
          id: 'bad-empty-roles',
          name: 'Empty Roles',
          onboardingSteps: [
            {
              id: 'bad-empty-roles:step',
              title: 'Empty roles',
              description: 'Roles cannot be empty',
              roles: [],
            },
          ],
        },
      ])
    ).toThrow(RangeError);

    expect(() =>
      validateAndCompileUiPlugins([
        {
          id: 'bad-tutorial',
          name: 'Bad Tutorial',
          onboardingSteps: [
            {
              id: 'bad-tutorial:step',
              title: 'Bad tut',
              description: 'Blank chapter',
              action: { kind: 'tutorial', chapterId: '  ', label: 'Watch' },
            },
          ],
        },
      ])
    ).toThrow(RangeError);

    expect(() =>
      validateAndCompileUiPlugins([
        {
          id: 'bad-label',
          name: 'Bad Label',
          onboardingSteps: [
            {
              id: 'bad-label:step',
              title: 'Bad label',
              description: 'Blank label',
              action: { kind: 'callback', label: ' ', onActivate: () => {} },
            },
          ],
        },
      ])
    ).toThrow(RangeError);

    const compiled = validateAndCompileUiPlugins([
      {
        id: 'plugin-z',
        name: 'Plugin Z',
        onboardingSteps: [
          {
            id: 'plugin-z:second',
            title: 'Second',
            description: 'Order 210',
            order: 210,
            targetRoute: '/z',
          },
        ],
      },
      {
        id: 'plugin-a',
        name: 'Plugin A',
        onboardingSteps: [
          {
            id: 'plugin-a:first',
            title: 'First',
            description: 'Order 150',
            order: 150,
            targetRoute: '/a',
          },
        ],
      },
    ]);
    expect(compiled.onboardingSteps.map((s) => s.id)).toEqual(['plugin-a:first', 'plugin-z:second']);
  });

  it('fault-isolates dynamic getOnboardingSteps and resolves Narrative Audio step only when narrated biographies exist', () => {
    const audioPlugin = createNarrativeAudioPlugin();
    const throwingPlugin: KinloomUiPlugin = {
      id: 'broken-dynamic',
      name: 'Broken Dynamic',
      getOnboardingSteps() {
        throw new Error('dynamic failure');
      },
    };
    const spoofPlugin: KinloomUiPlugin = {
      id: 'spoof-dynamic',
      name: 'Spoof Dynamic',
      getOnboardingSteps() {
        return [{ id: 'core:fake', title: 'Fake', description: 'Blocked' }];
      },
    };

    const baseCtx: KinloomOnboardingContext = {
      bundle: createSeededBundle(false),
      siteConfig: SITE_CONFIG,
      baseUrl: '/',
      session: { authenticated: false, principal_kind: 'anonymous' },
      capabilities: {
        canEdit: false,
        canUploadMedia: false,
        hasRevisionHistory: false,
        hasTalk: false,
        canManageSite: false,
      },
      role: 'viewer',
      completedStepIds: new Set(),
    };

    expect(
      resolveDynamicPluginOnboardingSteps([audioPlugin, throwingPlugin, spoofPlugin], new Set(), baseCtx)
    ).toEqual([]);

    const withAudio = resolveDynamicPluginOnboardingSteps(
      [audioPlugin, throwingPlugin, spoofPlugin],
      new Set(),
      { ...baseCtx, bundle: createSeededBundle(true) }
    );
    expect(withAudio).toHaveLength(1);
    expect(withAudio[0].id).toBe('kinloom-narrative-audio:listen-biography');
    expect(withAudio[0].action).toEqual({
      kind: 'route',
      to: '/person/arthur-hale',
      label: 'Listen on Arthur Hale',
    });
  });
});

describe('OnboardingChecklistCard, Guide menu, persistence, and contextual empty states', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('renders viewer checklist, persists dismissal in localStorage, reopens via Guide menu, opens shortcuts/guide dialogs, and resets progress', async () => {
    const callbackSpy = vi.fn();
    const extraPlugins: KinloomUiPlugin[] = [
      {
        id: 'plugin-extra',
        name: 'Extra Guides',
        onboardingSteps: [
          {
            id: 'plugin-extra:one',
            title: 'Extra Guide 1',
            description: 'First extra step',
            targetRoute: '/places',
          },
          {
            id: 'plugin-extra:two',
            title: 'Extra Guide 2',
            description: 'Overflow extra step',
            action: { kind: 'callback', label: 'Run callback', onActivate: callbackSpy },
          },
        ],
      },
    ];

    const firstMount = await mountComponent(
      <KinloomApp
        siteConfig={SITE_CONFIG}
        initialBundle={createSeededBundle(false)}
        plugins={extraPlugins}
        session={{ authenticated: false, principal_kind: 'anonymous' }}
        initialEntries={['/']}
      />
    );

    const card = firstMount.container.querySelector('[data-testid="onboarding-checklist-card"]');
    expect(card?.textContent).toContain('Explore this family archive');
    expect(card?.textContent).toContain('0 of 6 steps completed');

    // Overflow plugin step is collapsed under "More plugin guides (+1)"
    const moreBtn = findButtonByText(firstMount.container, 'More plugin guides (+1)');
    expect(moreBtn).toBeTruthy();
    await act(async () => {
      moreBtn?.click();
    });
    expect(firstMount.container.textContent).toContain('Extra Guide 2');

    const cbBtn = findButtonByText(firstMount.container, 'Run callback');
    await act(async () => {
      cbBtn?.click();
    });
    expect(callbackSpy).toHaveBeenCalledTimes(1);

    // Mark a step complete
    const checkBtn = findButtonByText(firstMount.container, 'Mark "Explore the family tree" as completed');
    await act(async () => {
      checkBtn?.click();
    });
    expect(firstMount.container.textContent).toContain('1 of 6 steps completed');

    // Collapse then expand
    await act(async () => {
      findButtonByText(firstMount.container, 'Collapse')?.click();
    });
    expect(findButtonByText(firstMount.container, 'Expand checklist')).toBeTruthy();
    await act(async () => {
      findButtonByText(firstMount.container, 'Expand checklist')?.click();
    });

    // Dismiss checklist and verify persistence across remount
    await act(async () => {
      findButtonByText(firstMount.container, 'Dismiss checklist')?.click();
    });
    expect(firstMount.container.querySelector('[data-testid="onboarding-checklist-card"]')).toBeNull();
    await firstMount.unmount();

    const secondMount = await mountComponent(
      <KinloomApp
        siteConfig={SITE_CONFIG}
        initialBundle={createSeededBundle(false)}
        plugins={extraPlugins}
        session={{ authenticated: false, principal_kind: 'anonymous' }}
        initialEntries={['/']}
      />
    );
    expect(secondMount.container.querySelector('[data-testid="onboarding-checklist-card"]')).toBeNull();

    // Open Guide dropdown in ExplorerTopBar and navigate with ArrowDown + Escape
    const guideBtn = findButtonByText(secondMount.container, 'Guide');
    expect(guideBtn).toBeTruthy();
    await act(async () => {
      guideBtn?.click();
    });
    expect(secondMount.container.querySelector('[role="menu"][aria-label="Guide and help"]')).toBeTruthy();

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(secondMount.container.querySelector('[role="menu"][aria-label="Guide and help"]')).toBeNull();
    expect(document.activeElement).toBe(guideBtn);

    // Reopen checklist via Guide menu
    await act(async () => {
      guideBtn?.click();
    });
    await act(async () => {
      findButtonByText(secondMount.container, 'Getting Started Checklist')?.click();
    });
    expect(secondMount.container.querySelector('[data-testid="onboarding-checklist-card"]')).toBeTruthy();

    // Open Keyboard Shortcuts dialog via Guide menu
    await act(async () => {
      guideBtn?.click();
    });
    await act(async () => {
      findButtonByText(secondMount.container, 'Keyboard Shortcuts')?.click();
      await Promise.resolve();
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(secondMount.container.textContent).toContain('Open global archive search');
    await act(async () => {
      findButtonByText(secondMount.container, 'Close')?.click();
    });

    // Open Interactive Tutorials modal via Guide menu and mark chapter complete
    await act(async () => {
      guideBtn?.click();
    });
    await act(async () => {
      findButtonByText(secondMount.container, 'Interactive Tutorials')?.click();
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(secondMount.container.textContent).toContain('Kinloom Archive Guide');
    await act(async () => {
      findButtonByText(secondMount.container, 'Next step')?.click();
    });
    await act(async () => {
      findButtonByText(secondMount.container, 'Mark chapter complete')?.click();
    });
    await act(async () => {
      findButtonByText(secondMount.container, 'Close')?.click();
    });

    // Reset Tutorial & Onboarding Progress clears completed steps
    await act(async () => {
      guideBtn?.click();
    });
    await act(async () => {
      findButtonByText(secondMount.container, 'Reset Tutorial & Onboarding Progress')?.click();
    });
    expect(secondMount.container.textContent).toContain('0 of 6 steps completed');
    await secondMount.unmount();
  });

  it('delegates Guide open to a #53 registered tutorial launcher and syncs authenticated user progress via ArchiveDataSource', async () => {
    const launcherSpy = vi.fn();
    let storedResponse: OnboardingSessionResponse = {
      ...createDefaultOnboardingSessionResponse(),
      is_first_login: true,
      should_auto_open_tutorial_modal: true,
    };

    const updateSpy = vi.fn(async (patch: UpdateOnboardingStateRequest) => {
      storedResponse = {
        ...storedResponse,
        state: {
          ...storedResponse.state,
          completed_step_ids: [
            ...new Set([...storedResponse.state.completed_step_ids, ...(patch.complete_step_ids ?? [])]),
          ],
        },
      };
      return storedResponse;
    });

    const dataSource: ArchiveDataSource = {
      loadArchive: async () => ({ bundle: createSeededBundle(false), etag: '"r1"', notModified: false }),
      loadReadings: async () => null,
      getOnboardingState: async () => storedResponse,
      updateOnboardingState: updateSpy,
    };

    const mounted = await mountComponent(
      <ArchiveProvider
        siteConfig={SITE_CONFIG}
        dataSource={dataSource}
        initialBundle={createSeededBundle(false)}
        session={{
          authenticated: true,
          principal_kind: 'user',
          email: 'editor@archive.example',
          displayName: 'Archive Editor',
          role: 'editor',
        }}
        capabilities={{ canEdit: true, hasRevisionHistory: true }}
      >
        <MemoryRouter initialEntries={['/']}>
          <LauncherRegistrar onLaunch={launcherSpy} />
          <ExplorerTopBar />
          <IndexPage />
          <KeyboardShortcutsDialog />
          <QuickArchiveGuideDialog />
        </MemoryRouter>
      </ArchiveProvider>
    );

    expect(mounted.container.textContent).toContain('Make your first archival contribution');

    await act(async () => {
      findButtonByText(mounted.container, 'Guide')?.click();
    });
    await act(async () => {
      findButtonByText(mounted.container, 'Interactive Tutorials')?.click();
    });
    expect(launcherSpy).toHaveBeenCalledTimes(1);

    await act(async () => {
      findButtonByText(mounted.container, 'Mark "Inspect revision history" as completed')?.click();
      await Promise.resolve();
    });
    expect(updateSpy).toHaveBeenCalledWith({ complete_step_ids: ['core:editor:review-changes'] });
    await mounted.unmount();
  });

  it('renders contextual empty states with role-appropriate CTAs on IndexPage, TreePage, TimePage, EvidencePage, and AdminPage', async () => {
    const adminClient: AdminDataSource = {
      listUsers: async () => [],
      updateUserRole: async (email, input) => ({
        email,
        display_name: 'Admin',
        role: input.role,
        added_by: 'bootstrap',
        added_at: '2026-11-27T00:00:00.000Z',
        last_login_at: '2026-11-27T00:00:00.000Z',
      }),
      listInvites: async () => [],
      createInvite: async ({ label }) => ({
        invite: {
          token: 'inv_1',
          label,
          created_by: 'admin@archive.example',
          created_at: '2026-11-27T00:00:00.000Z',
          expires_at: null,
          revoked_at: null,
          uses: 0,
          last_used_at: null,
        },
        invite_url: 'https://archive.example/invite/inv_1',
      }),
      revokeInvite: async () => {},
      listAgentTokens: async () => [],
      createAgentToken: async ({ label, scope }) => ({
        token_id: 'tok_1',
        label,
        scope,
        plaintext_secret: 'secret_1',
      }),
      revokeAgentToken: async () => {},
    };

    const adminSession = {
      authenticated: true,
      principal_kind: 'user' as const,
      email: 'admin@archive.example',
      displayName: 'Archive Admin',
      role: 'admin' as const,
    };
    const adminCaps = { canEdit: true, canManageSite: true, hasRevisionHistory: true };

    // IndexPage empty archive
    const indexMount = await mountComponent(
      <ArchiveProvider
        siteConfig={SITE_CONFIG}
        initialBundle={EMPTY_BUNDLE}
        session={adminSession}
        capabilities={adminCaps}
      >
        <MemoryRouter initialEntries={['/']}>
          <IndexPage />
        </MemoryRouter>
      </ArchiveProvider>
    );
    expect(indexMount.container.textContent).toContain('Start your family archive');
    expect(findButtonByText(indexMount.container, '+ Add first person')).toBeTruthy();
    expect(indexMount.container.textContent).toContain('Open Admin setup');
    await indexMount.unmount();

    // TreePage empty archive
    const treeMount = await mountComponent(
      <ArchiveProvider
        siteConfig={SITE_CONFIG}
        initialBundle={EMPTY_BUNDLE}
        session={adminSession}
        capabilities={adminCaps}
      >
        <MemoryRouter initialEntries={['/tree']}>
          <TreePage />
        </MemoryRouter>
      </ArchiveProvider>
    );
    expect(treeMount.container.textContent).toContain('Your family tree is ready for its first branch');
    expect(findButtonByText(treeMount.container, '+ Add first person')).toBeTruthy();
    expect(findButtonByText(treeMount.container, 'Watch Tree tutorial')).toBeTruthy();
    await treeMount.unmount();

    // TimePage empty archive
    const timeMount = await mountComponent(
      <ArchiveProvider
        siteConfig={SITE_CONFIG}
        initialBundle={EMPTY_BUNDLE}
        session={adminSession}
        capabilities={adminCaps}
      >
        <MemoryRouter initialEntries={['/time']}>
          <TimePage />
        </MemoryRouter>
      </ArchiveProvider>
    );
    expect(timeMount.container.textContent).toContain('No dated milestones recorded yet');
    expect(timeMount.container.textContent).toContain('Add a person or milestone');
    await timeMount.unmount();

    // EvidencePage empty sources & media tabs
    const evidenceMount = await mountComponent(
      <ArchiveProvider
        siteConfig={SITE_CONFIG}
        initialBundle={EMPTY_BUNDLE}
        session={adminSession}
        capabilities={adminCaps}
      >
        <MemoryRouter initialEntries={['/evidence?tab=citations']}>
          <EvidencePage />
        </MemoryRouter>
      </ArchiveProvider>
    );
    expect(evidenceMount.container.textContent).toContain('No sources have been cataloged yet.');
    expect(evidenceMount.container.textContent).toContain('Add a source on a record');
    const mediaTabBtn = [...evidenceMount.container.querySelectorAll('[role="tab"]')].find((el) =>
      el.textContent?.includes('Photos & Documents')
    ) as HTMLButtonElement | undefined;
    await act(async () => {
      mediaTabBtn?.click();
    });
    expect(evidenceMount.container.textContent).toContain('No archival scans or photographs yet');
    expect(evidenceMount.container.textContent).toContain('Upload scan from a profile');
    await evidenceMount.unmount();

    // AdminPage renders Admin Setup checklist plus contextual empty states for Invites & Tokens
    const adminMount = await mountComponent(
      <ArchiveProvider
        siteConfig={SITE_CONFIG}
        initialBundle={EMPTY_BUNDLE}
        session={adminSession}
        capabilities={adminCaps}
      >
        <MemoryRouter initialEntries={['/admin']}>
          <AdminPage adminClient={adminClient} />
        </MemoryRouter>
      </ArchiveProvider>
    );
    expect(adminMount.container.textContent).toContain('Verify your Kinloom archive');
    expect(adminMount.container.textContent).toContain('No family invite links yet');
    expect(adminMount.container.textContent).toContain('No scoped agent or backup tokens yet');
    await adminMount.unmount();
  });

  it('supports getOnboardingState and updateOnboardingState on HttpWikiDataSource and StaticDemoDataSource', async () => {
    const staticDs = createStaticArchiveDataSource('/');
    const staticResp = await staticDs.getOnboardingState?.();
    expect(staticResp?.is_first_login).toBe(false);

    const expected = createDefaultOnboardingSessionResponse();
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'PUT') {
        return new Response(
          JSON.stringify({
            ...expected,
            state: { ...expected.state, completed_step_ids: ['core:viewer:open-tree'] },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      return new Response(JSON.stringify(expected), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    const httpDs = createHttpWikiDataSource({ fetchImpl: fetchMock as typeof fetch });
    const fetched = await httpDs.getOnboardingState();
    expect(fetched.is_first_login).toBe(false);
    const patched = await httpDs.updateOnboardingState({ complete_step_ids: ['core:viewer:open-tree'] });
    expect(patched.state.completed_step_ids).toEqual(['core:viewer:open-tree']);
  });
});
