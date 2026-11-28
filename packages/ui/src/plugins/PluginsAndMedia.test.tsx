/** @vitest-environment jsdom */
import type { ArchiveBundle, KinloomSiteConfig, MediaItem } from '@kinloom/core';
import { compileArchive, parseKinloomConfig } from '@kinloom/core';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import { MediaPlayer } from '../components/MediaPlayer.js';
import { CreateEntityModal } from '../components/wiki/CreateEntityModal.js';
import { EntityEditDrawer } from '../components/wiki/EntityEditDrawer.js';
import type {
  EntityCreateFieldProps,
  EntityEditFieldProps,
} from '../components/wiki/entityForms/fieldTypes.js';
import { ArchiveProvider } from '../context/ArchiveProvider.js';
import { KinloomApp } from '../KinloomApp.js';
import { validateAndCompileUiPlugins } from './PluginContext.js';
import type { KinloomUiPlugin } from './types.js';

const PluginSourceEditFields: React.FC<EntityEditFieldProps> = ({ draft, updateField }) => (
  <label>
    <span>Plugin Source Citation</span>
    <input
      data-testid="plugin-edit-source-input"
      type="text"
      value={typeof draft['citation'] === 'string' ? draft['citation'] : ''}
      onChange={(e) => {
        updateField('citation', e.target.value);
      }}
    />
  </label>
);

const PluginPlaceCreateFields: React.FC<EntityCreateFieldProps> = () => (
  <div data-testid="plugin-create-place-fields">Plugin place form</div>
);

const PluginDummyRoutePage: React.FC = () => <div>Custom</div>;

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
window.scrollTo = () => {};

const siteConfig: KinloomSiteConfig = parseKinloomConfig({
  site: {
    title: 'Synthetic Plugin Test Archive',
    familyName: 'Test Family',
    gedcomSourceName: 'PLUGIN_TEST',
  },
});

const { bundle: testBundle }: { bundle: ArchiveBundle } = compileArchive({
  siteConfig,
  mode: 'public',
  people: [
    {
      id: 'p_ada',
      slug: 'ada-lovelace',
      full_name: 'Ada Lovelace',
      given_name: 'Ada',
      surname: 'Lovelace',
      alt_names: [],
      sex: 'F',
      is_living: false,
      lineage_group: 'pivot_ancestor',
      birth_edtf: '1815-12-10',
      death_edtf: '1852-11-27',
      portrait_url: null,
    },
  ],
  places: [],
  events: [],
  sources: [],
  kinship: [],
});

describe('KinloomUiPlugin seam and MediaPlayer', () => {
  it('mounts custom plugin routes, nav links, and indexHero slot cleanly', async () => {
    // biome-ignore lint/correctness/noComponentHookFactories: isolated test page component
    const CustomStoryPage = () => <main data-testid="custom-story">Interactive Video Essay</main>;
    const storyPlugin: KinloomUiPlugin = {
      id: 'story-plugin',
      name: 'Story Plugin',
      routes: [
        {
          path: '/stories/essay',
          navLabel: 'Stories',
          component: CustomStoryPage,
        },
      ],
      slots: {
        indexHero: ({ siteConfig: cfg }) => (
          <section data-testid="hero-slot">Featured Story for {cfg.site.familyName}</section>
        ),
      },
    };

    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);

    // 1. Index renders plugin nav link + indexHero slot
    await act(async () => {
      root.render(
        <KinloomApp
          siteConfig={siteConfig}
          initialBundle={testBundle}
          initialReadings={{ version: 1, documents: {}, event_page_map: {} }}
          plugins={[storyPlugin]}
          initialEntries={['/']}
        />
      );
      await new Promise((r) => setTimeout(r, 20));
    });

    expect(container.querySelector('[data-testid="hero-slot"]')?.textContent).toBe(
      'Featured Story for Test Family'
    );
    const navLinks = [...container.querySelectorAll('.nav-links a')].map((a) => a.textContent);
    expect(navLinks).toContain('Stories');

    // 2. Navigating directly to custom plugin route renders CustomStoryPage
    await act(async () => {
      root.render(
        <KinloomApp
          key="story-route"
          siteConfig={siteConfig}
          initialBundle={testBundle}
          initialReadings={{ version: 1, documents: {}, event_page_map: {} }}
          plugins={[storyPlugin]}
          initialEntries={['/stories/essay']}
        />
      );
      await new Promise((r) => setTimeout(r, 20));
    });

    expect(container.querySelector('[data-testid="custom-story"]')?.textContent).toBe(
      'Interactive Video Essay'
    );

    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('renders native HTML5 video with poster & captions, audio, and allows plugin mediaRenderer override', async () => {
    const videoMedia: MediaItem = {
      id: 'med_vid_1',
      kind: 'video_story',
      file: '/media/story.mp4',
      caption: 'Homestead Oral Story',
      mime_type: 'video/mp4',
      duration_seconds: 125,
      poster_url: '/media/story-poster.jpg',
      transcript_url: '/media/story.vtt',
    };
    const audioMedia: MediaItem = {
      id: 'med_aud_1',
      kind: 'audio_oral_history',
      file: '/media/interview.mp3',
      caption: 'Oral History Recording',
      mime_type: 'audio/mpeg',
    };

    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <ArchiveProvider siteConfig={siteConfig} initialBundle={testBundle}>
          <MediaPlayer media={videoMedia} variant="full" />
          <MediaPlayer media={audioMedia} variant="full" />
        </ArchiveProvider>
      );
    });

    const videoEl = container.querySelector('video');
    expect(videoEl).not.toBeNull();
    expect(videoEl?.getAttribute('poster')).toBe('/media/story-poster.jpg');
    expect(videoEl?.querySelector('track[kind="captions"]')?.getAttribute('src')).toBe('/media/story.vtt');
    expect(container.querySelector('audio')).not.toBeNull();

    // Custom plugin mediaRenderer takes precedence over native video player
    const customPlayerPlugin: KinloomUiPlugin = {
      id: 'custom-player',
      name: 'Custom Video Player',
      mediaRenderers: [
        {
          match: (m) => m.kind === 'video_story',
          render: ({ media, src }) => (
            <div data-testid="custom-video-player">
              Custom Player: {media.caption} ({src})
            </div>
          ),
        },
      ],
    };

    await act(async () => {
      root.render(
        <ArchiveProvider siteConfig={siteConfig} initialBundle={testBundle} plugins={[customPlayerPlugin]}>
          <MediaPlayer media={videoMedia} variant="full" />
        </ArchiveProvider>
      );
    });

    expect(container.querySelector('[data-testid="custom-video-player"]')?.textContent).toBe(
      'Custom Player: Homestead Oral Story (/media/story.mp4)'
    );
    expect(container.querySelector('video')).toBeNull();

    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('allows a plugin to register custom entityEditForms and entityCreateForms', async () => {
    const customFormPlugin: KinloomUiPlugin = {
      id: 'custom-entity-forms',
      name: 'Custom Entity Forms',
      entityEditForms: {
        source: {
          Fields: PluginSourceEditFields,
        },
      },
      entityCreateForms: {
        place: {
          kind: 'place',
          tabLabel: 'Custom Place',
          Fields: PluginPlaceCreateFields,
          validateAndBuild: () => ({
            ok: true,
            entityId: 'plc_plugin_custom',
            payload: { id: 'plc_plugin_custom', name: 'Plugin Place' },
          }),
        },
      },
    };

    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <ArchiveProvider siteConfig={siteConfig} initialBundle={testBundle} plugins={[customFormPlugin]}>
          <EntityEditDrawer
            open
            entityType="source"
            entityId="src_custom"
            revisionId={1}
            initialData={{ id: 'src_custom', citation: 'Parish Roll 1840' }}
            title="Parish Roll"
            onClose={() => {}}
          />
          <CreateEntityModal open defaultKind="place" onClose={() => {}} />
        </ArchiveProvider>
      );
      await new Promise((r) => setTimeout(r, 20));
    });

    const editInput = container.querySelector<HTMLInputElement>('[data-testid="plugin-edit-source-input"]');
    expect(editInput?.value).toBe('Parish Roll 1840');
    expect(container.querySelector('[data-testid="plugin-create-place-fields"]')?.textContent).toBe(
      'Plugin place form'
    );
    expect(container.textContent).toContain('Custom Place');

    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('rejects invalid JSON primitives and arrays in JsonFallbackEditFields without mutating draft', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <ArchiveProvider siteConfig={siteConfig} initialBundle={testBundle}>
          <EntityEditDrawer
            open
            entityType="source"
            entityId="src_fallback"
            revisionId={1}
            initialData={{ id: 'src_fallback', citation: 'Original Register' }}
            title="Fallback Source"
            onClose={() => {}}
          />
        </ArchiveProvider>
      );
      await new Promise((r) => setTimeout(r, 20));
    });

    const textarea = container.querySelector<HTMLTextAreaElement>('textarea.wiki-mono');
    expect(textarea).not.toBeNull();
    const setTextareaValue = (val: string): void => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
      setter?.call(textarea, val);
      textarea?.dispatchEvent(new Event('input', { bubbles: true }));
    };

    for (const invalidJson of ['123', '"abc"', '[]']) {
      act(() => {
        setTextareaValue(invalidJson);
      });
      expect(textarea?.getAttribute('aria-invalid')).toBe('true');
      const alert = container.querySelector('[role="alert"]');
      expect(alert?.textContent).toContain('JSON object');
    }

    // Valid object JSON clears validation error cleanly
    act(() => {
      setTextareaValue('{"id":"src_fallback","citation":"Updated Register"}');
    });
    expect(textarea?.getAttribute('aria-invalid')).toBe('false');
    expect(container.querySelector('[role="alert"]')).toBeNull();

    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('throws RangeError on empty/duplicate UI plugin IDs, duplicate or reserved routes, and duplicate form overrides', () => {
    const basePlaceCreateForm = {
      kind: 'place' as const,
      tabLabel: 'Custom Place',
      Fields: PluginPlaceCreateFields,
      validateAndBuild: () => ({
        ok: true as const,
        entityId: 'plc_1',
        payload: { id: 'plc_1', name: 'One' },
      }),
    };

    expect(() => validateAndCompileUiPlugins([{ id: '   ', name: 'Blank' }])).toThrow(RangeError);
    expect(() =>
      validateAndCompileUiPlugins([
        { id: 'dup-ui', name: 'First' },
        { id: ' dup-ui ', name: 'Second' },
      ])
    ).toThrow(RangeError);

    // Reserved built-in routes (exact & parameterized structural collision)
    for (const reservedPath of ['/', '/people', '/person/:slug', '/person/:id', '/places', '/admin']) {
      expect(() =>
        validateAndCompileUiPlugins([
          {
            id: `reserved-${reservedPath}`,
            name: 'Reserved',
            routes: [{ path: reservedPath, component: PluginDummyRoutePage }],
          },
        ])
      ).toThrow(RangeError);
    }

    // Duplicate plugin route path across two plugins
    expect(() =>
      validateAndCompileUiPlugins([
        { id: 'route-a', name: 'A', routes: [{ path: '/stories/', component: PluginDummyRoutePage }] },
        { id: 'route-b', name: 'B', routes: [{ path: '/stories', component: PluginDummyRoutePage }] },
      ])
    ).toThrow(RangeError);

    // Duplicate entityEditForms override for same EntityType
    expect(() =>
      validateAndCompileUiPlugins([
        { id: 'edit-a', name: 'A', entityEditForms: { source: { Fields: PluginSourceEditFields } } },
        { id: 'edit-b', name: 'B', entityEditForms: { source: { Fields: PluginSourceEditFields } } },
      ])
    ).toThrow(RangeError);

    // Duplicate entityCreateForms override for same EntityType
    expect(() =>
      validateAndCompileUiPlugins([
        { id: 'create-a', name: 'A', entityCreateForms: { place: basePlaceCreateForm } },
        { id: 'create-b', name: 'B', entityCreateForms: { place: basePlaceCreateForm } },
      ])
    ).toThrow(RangeError);
  });
});
