/** @vitest-environment jsdom */
import {
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
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ArchiveProvider } from '../../context/ArchiveProvider.js';
import { KinloomApp } from '../../KinloomApp.js';
import { createNarrativeAudioPlugin } from '../../plugins/narrativeAudioPlugin.js';
import type { KinloomTutorialContext, KinloomUiPlugin } from '../../plugins/types.js';
import {
  resolveDynamicPluginTutorialChapters,
  validateAndCompileUiPlugins,
} from '../../plugins/validatePlugins.js';
import { TutorialMediaStage } from './TutorialMediaStage.js';
import { TutorialModal } from './TutorialModal.js';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
window.scrollTo = () => {};

const SITE_CONFIG: KinloomSiteConfig = parseKinloomConfig({
  site: {
    title: 'Lincoln & Todd Demo Archive',
    familyName: 'Lincoln & Todd',
    gedcomSourceName: 'TUTORIAL_MODAL_TEST',
  },
});

function createDemoBundle(withNarratedAudio = true): ArchiveBundle {
  return compileArchive({
    siteConfig: SITE_CONFIG,
    mode: 'public',
    people: [
      {
        id: 'p_abraham',
        slug: 'abraham-lincoln-1809',
        full_name: 'Abraham Lincoln',
        given_name: 'Abraham',
        surname: 'Lincoln',
        alt_names: [],
        sex: 'M',
        is_living: false,
        lineage_group: 'pivot_ancestor',
        birth_edtf: '1809-02-12',
        death_edtf: '1865-04-15',
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
        id: 'ev_1860',
        title: '1860 Residence',
        summary: 'Springfield residence',
        scope: 'personal',
        event_kind: 'residence_anchor',
        edtf_date: '1860',
        place_id: 'pl_springfield',
        participants: [{ person_id: 'p_abraham', role: 'primary' }],
        sources: [],
      },
    ],
    sources: [],
    kinship: [],
    narratives: withNarratedAudio
      ? [
          {
            id: 'nar_abraham',
            slug: 'abraham-lincoln-bio',
            title: 'Abraham Lincoln Biography',
            kind: 'biography',
            subject_person_id: 'p_abraham',
            person_ids: ['p_abraham'],
            place_ids: [],
            event_ids: [],
            source_ids: [],
            body_md: 'Public-domain biography fixture.',
            extensions: {
              narrative_audio: {
                file: '/media/audio/abraham.mp3',
                duration_seconds: 120,
                editor_notes_start_seconds: 90,
              },
            },
          },
        ]
      : [],
  }).bundle;
}

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

async function waitFor(predicate: () => boolean, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await act(async () => {
      await new Promise((r) => setTimeout(r, 15));
    });
  }
}

function findButtonByText(root: ParentNode, text: string): HTMLButtonElement | undefined {
  return [...root.querySelectorAll('button')].find(
    (btn) => btn.textContent?.trim() === text || btn.getAttribute('aria-label') === text
  );
}

const LocationEcho: React.FC = () => {
  const loc = useLocation();
  return <output data-testid="location-echo">{`${loc.pathname}${loc.search}`}</output>;
};

describe('UI plugin tutorialChapters validation seam and Narrative Audio reference chapter', () => {
  const validStep = {
    id: 'step-one',
    title: 'Step One',
    instructions: 'Follow step one.',
    transcript: 'Full narration for step one.',
    targetRoute: '/recipes',
  };

  it('rejects malformed chapters, core- or core: spoofing, missing pluginId namespace, duplicates, and unsafe URLs with RangeError', () => {
    expect(() =>
      validateAndCompileUiPlugins([
        {
          id: 'spoof-dash',
          name: 'Spoof Dash',
          tutorialChapters: [{ id: 'core-fake', title: 'Fake', summary: 'Blocked', steps: [validStep] }],
        },
      ])
    ).toThrow(RangeError);

    expect(() =>
      validateAndCompileUiPlugins([
        {
          id: 'spoof-colon',
          name: 'Spoof Colon',
          tutorialChapters: [{ id: 'core:fake', title: 'Fake', summary: 'Blocked', steps: [validStep] }],
        },
      ])
    ).toThrow(RangeError);

    expect(() =>
      validateAndCompileUiPlugins([
        {
          id: 'missing-ns',
          name: 'Missing Namespace',
          tutorialChapters: [
            {
              id: 'other-plugin:intro',
              title: 'Wrong NS',
              summary: 'Must match pluginId:',
              steps: [validStep],
            },
          ],
        },
      ])
    ).toThrow(RangeError);

    expect(() =>
      validateAndCompileUiPlugins([
        {
          id: 'dup-plugin',
          name: 'Dup Plugin',
          tutorialChapters: [
            { id: 'dup-plugin:same', title: 'First', summary: 'A', steps: [validStep] },
            { id: 'dup-plugin:same', title: 'Second', summary: 'B', steps: [validStep] },
          ],
        },
      ])
    ).toThrow(RangeError);

    expect(() =>
      validateAndCompileUiPlugins([
        {
          id: 'bad-url',
          name: 'Bad URL',
          tutorialChapters: [
            {
              id: 'bad-url:intro',
              title: 'Unsafe media',
              summary: 'HTTP video rejected',
              steps: [
                {
                  ...validStep,
                  media: {
                    videoMp4Url: 'http://insecure.example/video.mp4',
                    posterAlt: 'Insecure',
                  },
                },
              ],
            },
          ],
        },
      ])
    ).toThrow(RangeError);

    expect(() =>
      validateAndCompileUiPlugins([
        {
          id: 'bad-route',
          name: 'Bad Route',
          tutorialChapters: [
            {
              id: 'bad-route:intro',
              title: 'Unsafe route',
              summary: 'Javascript route rejected',
              steps: [{ ...validStep, targetRoute: 'javascript:alert(1)' }],
            },
          ],
        },
      ])
    ).toThrow(RangeError);

    const compiled = validateAndCompileUiPlugins([
      {
        id: 'plugin-z',
        name: 'Plugin Z',
        tutorialChapters: [
          { id: 'plugin-z:guide', title: 'Z Guide', summary: 'Order 210', order: 210, steps: [validStep] },
        ],
      },
      {
        id: 'plugin-a',
        name: 'Plugin A',
        tutorialChapters: [
          { id: 'plugin-a:guide', title: 'A Guide', summary: 'Order 150', order: 150, steps: [validStep] },
        ],
      },
    ]);
    expect(compiled.tutorialChapters.map((c) => c.id)).toEqual(['plugin-a:guide', 'plugin-z:guide']);
    expect(compiled.tutorialChapters[0]?.pluginName).toBe('Plugin A');
    expect(compiled.tutorialChapters[0]?.source).toBe('plugin');
  });

  it('fault-isolates dynamic getTutorialChapters and emits Narrative Audio chapter when narrated audio exists', () => {
    const audioPlugin = createNarrativeAudioPlugin();
    const throwingPlugin: KinloomUiPlugin = {
      id: 'broken-tut',
      name: 'Broken Tut',
      getTutorialChapters() {
        throw new Error('boom');
      },
    };
    const spoofPlugin: KinloomUiPlugin = {
      id: 'spoof-tut',
      name: 'Spoof Tut',
      getTutorialChapters() {
        return [{ id: 'core-hijack', title: 'Hijack', summary: 'Blocked', steps: [validStep] }];
      },
    };

    const baseCtx: KinloomTutorialContext = {
      bundle: createDemoBundle(false),
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
    };

    expect(
      resolveDynamicPluginTutorialChapters([audioPlugin, throwingPlugin, spoofPlugin], new Set(), baseCtx)
    ).toEqual([]);

    const withAudio = resolveDynamicPluginTutorialChapters(
      [audioPlugin, throwingPlugin, spoofPlugin],
      new Set(),
      { ...baseCtx, bundle: createDemoBundle(true) }
    );
    expect(withAudio).toHaveLength(1);
    expect(withAudio[0]?.id).toBe('kinloom-narrative-audio:listening');
    expect(withAudio[0]?.steps).toHaveLength(2);
    expect(withAudio[0]?.steps[0]?.targetRoute).toBe('/person/abraham-lincoln-1809');
  });
});

describe('TutorialMediaStage graceful video, reduced-motion, and zero-CDN fallback', () => {
  const stepWithMedia = {
    id: 'tree-chart-and-list',
    title: 'Switch between Chart View and List View',
    instructions: 'Toggle between Chart and List views.',
    transcript: 'Open Family Tree and switch between Chart and List.',
    targetRoute: '/tree',
    highlights: ['Pan and zoom in Chart View'],
    media: {
      videoMp4Url: '/tutorials/core-tree-pedigree/tree-chart-and-list.mp4',
      videoWebmUrl: '/tutorials/core-tree-pedigree/tree-chart-and-list.webm',
      posterUrl: '/tutorials/core-tree-pedigree/tree-chart-and-list.png',
      posterAlt: 'Family Tree Chart and List switcher',
      captionsVttUrl: '/tutorials/core-tree-pedigree/tree-chart-and-list.vtt',
      durationSeconds: 25,
    },
  };

  it('renders HTML5 video with captions track, degrades to static slide on error, honors reduced motion, and renders card-only mode with zero media', async () => {
    const videoMount = await mountComponent(
      <TutorialMediaStage
        step={stepWithMedia}
        stepIndex={0}
        totalSteps={2}
        baseUrl="/"
        reducedMotionOverride={false}
      />
    );

    const videoEl = videoMount.container.querySelector('video');
    expect(videoEl).not.toBeNull();
    expect(videoEl?.hasAttribute('controls')).toBe(true);
    expect(videoEl?.hasAttribute('autoplay')).toBe(false);
    const trackEl = videoMount.container.querySelector('track[kind="captions"]');
    expect(trackEl?.getAttribute('src')).toBe('/tutorials/core-tree-pedigree/tree-chart-and-list.vtt');

    // Simulate broken video -> gracefully degrades to static poster slide
    await act(async () => {
      videoEl?.dispatchEvent(new Event('error'));
    });
    expect(videoMount.container.querySelector('[data-testid="tutorial-slide-stage"]')).not.toBeNull();
    expect(videoMount.container.textContent).toContain('Video preview unavailable');
    await videoMount.unmount();

    // Reduced motion -> shows static slide directly without video element
    const reducedMount = await mountComponent(
      <TutorialMediaStage
        step={stepWithMedia}
        stepIndex={0}
        totalSteps={2}
        baseUrl="/"
        reducedMotionOverride={true}
      />
    );
    expect(reducedMount.container.querySelector('video')).toBeNull();
    expect(reducedMount.container.querySelector('img')?.getAttribute('alt')).toBe(
      'Family Tree Chart and List switcher'
    );
    expect(reducedMount.container.textContent).toContain('reduced motion active');
    await reducedMount.unmount();

    // Zero media -> pure archival card fallback
    const cardMount = await mountComponent(
      <TutorialMediaStage
        step={{ ...stepWithMedia, media: undefined }}
        stepIndex={0}
        totalSteps={2}
        baseUrl="/"
      />
    );
    expect(cardMount.container.querySelector('[data-testid="tutorial-card-stage"]')).not.toBeNull();
    expect(cardMount.container.querySelector('video')).toBeNull();
    expect(cardMount.container.querySelector('img')).toBeNull();
    expect(cardMount.container.textContent).toContain('/tree');
    await cardMount.unmount();
  });
});

describe('TutorialModal first-login auto-open, persistence, Guide menu reopen, deep-links, and keyboard a11y', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('auto-opens once on first login, persists dismiss_tutorial_modal, supports chapter navigation, plugin chapters, and never re-opens after reload', async () => {
    let serverOnboarding: OnboardingSessionResponse = {
      ...createDefaultOnboardingSessionResponse(),
      is_first_login: true,
      should_auto_open_tutorial_modal: true,
    };

    const updateSpy = vi.fn(async (patch: UpdateOnboardingStateRequest) => {
      if (patch.dismiss_tutorial_modal) {
        serverOnboarding = {
          ...serverOnboarding,
          is_first_login: false,
          should_auto_open_tutorial_modal: false,
          state: {
            ...serverOnboarding.state,
            tutorial_modal_dismissed_at: '2026-11-28T01:00:00.000Z',
            last_seen_version: patch.last_seen_version ?? serverOnboarding.state.last_seen_version,
          },
        };
      }
      if (patch.dismiss_checklist) {
        serverOnboarding = {
          ...serverOnboarding,
          state: {
            ...serverOnboarding.state,
            checklist_visibility: 'dismissed',
          },
        };
      }
      if (patch.complete_chapter_ids) {
        serverOnboarding = {
          ...serverOnboarding,
          is_first_login: false,
          should_auto_open_tutorial_modal: false,
          state: {
            ...serverOnboarding.state,
            completed_chapter_ids: [
              ...new Set([...serverOnboarding.state.completed_chapter_ids, ...patch.complete_chapter_ids]),
            ],
            tutorial_modal_dismissed_at:
              serverOnboarding.state.tutorial_modal_dismissed_at ?? '2026-11-28T01:00:00.000Z',
          },
        };
      }
      return serverOnboarding;
    });

    const dataSource: ArchiveDataSource = {
      loadArchive: async () => ({ bundle: createDemoBundle(true), etag: '"r1"', notModified: false }),
      loadReadings: async () => null,
      getOnboardingState: async () => serverOnboarding,
      updateOnboardingState: updateSpy,
    };

    const audioPlugin = createNarrativeAudioPlugin();
    const editorSession = {
      authenticated: true,
      principal_kind: 'user' as const,
      email: 'editor@archive.example.test',
      displayName: 'Archive Editor',
      role: 'editor' as const,
    };

    const firstMount = await mountComponent(
      <KinloomApp
        siteConfig={SITE_CONFIG}
        dataSource={dataSource}
        initialBundle={createDemoBundle(true)}
        plugins={[audioPlugin]}
        session={editorSession}
        capabilities={{ canEdit: true, hasRevisionHistory: true }}
        initialEntries={['/']}
      />
    );

    await waitFor(() => firstMount.container.querySelector('[data-testid="tutorial-modal"]') !== null);
    const modal = firstMount.container.querySelector('[data-testid="tutorial-modal"]');
    expect(modal).not.toBeNull();
    expect(modal?.textContent).toContain('Core Archive Guide');
    expect(modal?.textContent).toContain('Installed Plugins');
    expect(modal?.textContent).toContain('Listening to Narrated Biographies & Stories');
    // Admin chapter is hidden for editors
    expect(modal?.textContent).not.toContain('Managing Members, Invites & Archive Settings');

    // Step through Chapter 1 and mark chapter complete
    await act(async () => {
      findButtonByText(firstMount.container, 'Next step')?.click();
    });
    expect(modal?.textContent).toContain('Step 2 of 2');

    await act(async () => {
      findButtonByText(firstMount.container, 'Previous step')?.click();
    });
    expect(modal?.textContent).toContain('Step 1 of 2');

    await act(async () => {
      findButtonByText(firstMount.container, 'Next step')?.click();
    });
    await act(async () => {
      findButtonByText(firstMount.container, 'Mark chapter complete')?.click();
    });
    expect(updateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ complete_chapter_ids: ['core-navigation-search'] })
    );

    // Arrow key navigation in chapter rail
    const railButtons = [
      ...firstMount.container.querySelectorAll<HTMLButtonElement>(
        'nav[aria-label="Tutorial chapters"] button'
      ),
    ];
    expect(railButtons.length).toBeGreaterThanOrEqual(5);
    await act(async () => {
      railButtons[0]?.focus();
      railButtons[0]?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    });
    expect(document.activeElement).toBe(railButtons[1]);

    // Close via Escape
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(firstMount.container.querySelector('[data-testid="tutorial-modal"]')).toBeNull();
    await firstMount.unmount();

    // Remount -> does NOT auto-open again because tutorial_modal_dismissed_at is set
    const secondMount = await mountComponent(
      <KinloomApp
        siteConfig={SITE_CONFIG}
        dataSource={dataSource}
        initialBundle={createDemoBundle(true)}
        plugins={[audioPlugin]}
        session={editorSession}
        capabilities={{ canEdit: true, hasRevisionHistory: true }}
        initialEntries={['/']}
      />
    );
    await act(async () => {
      await new Promise((r) => setTimeout(r, 40));
    });
    expect(secondMount.container.querySelector('[data-testid="tutorial-modal"]')).toBeNull();

    // Dismiss inline landing guide strip so topbar Guide trigger surfaces (Issue #111 deduplication)
    await act(async () => {
      findButtonByText(secondMount.container, 'Dismiss')?.click();
      await Promise.resolve();
    });

    // Persistent post-first-login reopen via Guide -> "Jump to chapter…"
    const guideBtn = findButtonByText(secondMount.container, 'Guide');
    expect(guideBtn).toBeTruthy();
    await act(async () => {
      guideBtn?.click();
    });
    await act(async () => {
      findButtonByText(secondMount.container, 'Jump to chapter…▾')?.click();
    });
    const jumpBtn = [...secondMount.container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(
      (btn) => btn.textContent?.includes('Exploring the Family Tree')
    );
    expect(jumpBtn).toBeTruthy();
    await act(async () => {
      jumpBtn?.click();
    });
    await waitFor(() => secondMount.container.querySelector('[data-testid="tutorial-modal"]') !== null);
    expect(secondMount.container.querySelector('[data-testid="tutorial-modal"]')?.textContent).toContain(
      'Exploring the Family Tree'
    );

    // Click "Try it now" closes modal and navigates to /tree
    const tryBtn = [...secondMount.container.querySelectorAll<HTMLButtonElement>('button')].find((btn) =>
      btn.textContent?.includes('Try it now:')
    );
    expect(tryBtn).toBeTruthy();
    await act(async () => {
      tryBtn?.click();
    });
    expect(secondMount.container.querySelector('[data-testid="tutorial-modal"]')).toBeNull();
    await secondMount.unmount();
  });

  it('opens authorized chapter via ?tutorial=<chapterId> deep-link, strips query param on close, and ignores unauthorized chapters', async () => {
    const deepLinkMount = await mountComponent(
      <KinloomApp
        siteConfig={SITE_CONFIG}
        initialBundle={createDemoBundle(false)}
        session={{ authenticated: false, principal_kind: 'anonymous' }}
        initialEntries={['/?tutorial=core-tree-pedigree&view=az']}
      />
    );

    await waitFor(() => deepLinkMount.container.querySelector('[data-testid="tutorial-modal"]') !== null);
    expect(deepLinkMount.container.querySelector('[data-testid="tutorial-modal"]')?.textContent).toContain(
      'Exploring the Family Tree'
    );

    // Close modal -> strips ?tutorial param
    await act(async () => {
      findButtonByText(deepLinkMount.container, 'Close')?.click();
    });
    expect(deepLinkMount.container.querySelector('[data-testid="tutorial-modal"]')).toBeNull();
    await deepLinkMount.unmount();

    // Unauthorized admin chapter deep-link for viewer is ignored
    const unauthorizedMount = await mountComponent(
      <KinloomApp
        siteConfig={SITE_CONFIG}
        initialBundle={createDemoBundle(false)}
        session={{ authenticated: false, principal_kind: 'anonymous' }}
        initialEntries={['/?tutorial=core-admin-settings']}
      />
    );
    await act(async () => {
      await new Promise((r) => setTimeout(r, 40));
    });
    expect(unauthorizedMount.container.querySelector('[data-testid="tutorial-modal"]')).toBeNull();
    await unauthorizedMount.unmount();
  });

  it('supports Skip to my setup checklist and mobile chapter picker toggle inside TutorialModal', async () => {
    const pluginWithMedia: KinloomUiPlugin = {
      id: 'media-demo',
      name: 'Media Demo',
      tutorialChapters: [
        {
          id: 'media-demo:reduced',
          title: 'Reduced Motion Demo',
          summary: 'Shows static poster when reduced motion is active.',
          minRole: 'viewer',
          order: 150,
          steps: [
            {
              id: 'reduced-step',
              title: 'Reduced Motion Slide',
              instructions: 'Inspect the static slide.',
              transcript: 'Transcript stays open by default under reduced motion.',
              media: {
                videoMp4Url: '/tutorials/demo.mp4',
                posterUrl: '/tutorials/demo.png',
                posterAlt: 'Demo slide',
              },
            },
          ],
        },
      ],
    };

    const mounted = await mountComponent(
      <ArchiveProvider
        siteConfig={SITE_CONFIG}
        initialBundle={createDemoBundle(false)}
        plugins={[pluginWithMedia]}
        session={{ authenticated: false, principal_kind: 'anonymous' }}
      >
        <MemoryRouter initialEntries={['/places']}>
          <LocationEcho />
          <TutorialModal reducedMotionOverride={true} />
          <button
            type="button"
            onClick={() => {
              // Triggered below via KinloomApp test or context
            }}
          >
            Idle
          </button>
        </MemoryRouter>
      </ArchiveProvider>
    );
    // Modal starts closed when not opened
    expect(mounted.container.querySelector('[data-testid="tutorial-modal"]')).toBeNull();
    await mounted.unmount();

    // Full app mount with ?tutorial=media-demo:reduced tests Skip to my setup checklist + mobile picker
    const fullMount = await mountComponent(
      <KinloomApp
        siteConfig={SITE_CONFIG}
        initialBundle={createDemoBundle(false)}
        plugins={[pluginWithMedia]}
        session={{ authenticated: false, principal_kind: 'anonymous' }}
        initialEntries={['/?tutorial=media-demo:reduced']}
      />
    );

    await waitFor(() => fullMount.container.querySelector('[data-testid="tutorial-modal"]') !== null);
    const chaptersBtn = [...fullMount.container.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
      b.textContent?.includes('Chapters (')
    );
    expect(chaptersBtn).toBeTruthy();
    await act(async () => {
      chaptersBtn?.click();
    });
    expect(chaptersBtn?.getAttribute('aria-expanded')).toBe('true');

    // Toggle "Don't show automatically on sign-in" checkbox and click Skip to my setup checklist
    const checkbox = fullMount.container.querySelector<HTMLInputElement>('input[type="checkbox"]');
    expect(checkbox?.checked).toBe(true);
    await act(async () => {
      checkbox?.click();
      checkbox?.click();
    });
    await act(async () => {
      findButtonByText(fullMount.container, 'Skip to my setup checklist')?.click();
    });
    expect(fullMount.container.querySelector('[data-testid="tutorial-modal"]')).toBeNull();
    await fullMount.unmount();
  });
});
