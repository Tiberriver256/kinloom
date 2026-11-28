/** @vitest-environment jsdom */
import type { ArchiveBundle, ArchiveDataSource, Person, Place, Pronunciation } from '@kinloom/core';
import { compileArchive, parseKinloomConfig } from '@kinloom/core';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  parseAgentTokensListResponse,
  parseCreatedAgentTokenResponse,
  parseEntityGetResponse,
  parseEntityWriteResponse,
  parseInvitesListResponse,
  parseMagicLinkResponse,
  parseRevisionListResponse,
  parseRevisionOnlyResponse,
  parseSessionResponse,
  parseTalkCommentListResponse,
  parseUsersListResponse,
} from '../adapters/httpWiki/responseParsers.js';
import { PronunciationEditorSection } from '../components/wiki/PronunciationEditorSection.js';
import {
  generatePronunciationAudio,
  saveSharedTokenPronunciation,
} from '../components/wiki/pronunciation/pronunciationDraft.js';
import {
  buildPlaceOccupancySummary,
  collectPlaceLocalRecords,
  filterLocalRecordsByDecade,
} from '../pages/place/placeViewModel.js';
import { CHUNK_RELOAD_STORAGE_KEY } from './clientTelemetry.js';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

describe('clientTelemetry browser lifecycle, sanitization, and transport fallbacks', () => {
  it('handles missing window, throwing sessionStorage, non-Error chunk reasons, and malformed URL sanitization', async () => {
    vi.resetModules();
    const telemetry = await import('./clientTelemetry.js');

    // Throwing storage getter inside safeSessionStorage
    const originalStorageDesc = Object.getOwnPropertyDescriptor(window, 'sessionStorage');
    Object.defineProperty(window, 'sessionStorage', {
      configurable: true,
      get() {
        throw new Error('SecurityError');
      },
    });
    expect(telemetry.safeSessionStorage()).toBeNull();
    if (originalStorageDesc) {
      Object.defineProperty(window, 'sessionStorage', originalStorageDesc);
    }

    // Throwing storage inside shouldAttemptChunkReload
    const brokenStorage: Pick<Storage, 'getItem' | 'setItem'> = {
      getItem: () => {
        throw new Error('QuotaExceeded');
      },
      setItem: () => undefined,
    };
    expect(telemetry.shouldAttemptChunkReload(brokenStorage, 10_000)).toBe(false);

    // ChunkLoadError identified via error.name and JSON-stringified/circular non-Error reasons
    const namedChunkErr = new Error('Unexpected module failure');
    namedChunkErr.name = 'ChunkLoadError';
    expect(telemetry.isChunkLoadError(namedChunkErr)).toBe(true);
    expect(telemetry.isChunkLoadError({ detail: 'Unable to preload CSS chunk' })).toBe(true);

    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    expect(telemetry.isChunkLoadError(circular)).toBe(false);

    // Malformed URL fallback in sanitizeRoute and stripSensitiveUrl
    expect(telemetry.sanitizeRoute('http://[::1/invite/secret-tok?token=dropme')).toBe(
      'http://[::1/invite/secret-tok'
    );
    const sanitizedMalformed = telemetry.sanitizeReport({
      route: '/invite/secret-tok?person=per_1&secret=hidden',
      assetUrl: 'http://[::1/assets/chunk.js?token=abc#hash',
      timestamp: '2026-11-27T08:00:00.000Z',
    });
    expect(sanitizedMalformed.route).toBe('/invite/[redacted]?person=per_1');
    expect(sanitizedMalformed.assetUrl).toBe('http://[::1/assets/chunk.js');

    // SSR / undefined window fallback
    vi.stubGlobal('window', undefined);
    expect(telemetry.safeSessionStorage()).toBeNull();
    const noopCleanup = telemetry.installGlobalErrorHandlers();
    expect(() => noopCleanup()).not.toThrow();
  });

  it('enforces session report cap, falls back from sendBeacon to fetch (catching rejections), and routes chunk errors from global listeners', async () => {
    vi.resetModules();
    const telemetry = await import('./clientTelemetry.js');

    // Keep reload in cooldown so jsdom never attempts window.location.reload()
    window.sessionStorage.setItem(CHUNK_RELOAD_STORAGE_KEY, String(Date.now()));

    const sendBeaconMock = vi.fn(() => false);
    Object.defineProperty(window.navigator, 'sendBeacon', {
      configurable: true,
      value: sendBeaconMock,
    });
    const fetchMock = vi.fn(() => Promise.reject(new Error('offline')));
    vi.stubGlobal('fetch', fetchMock);

    // Trigger endpoint fallback to rejecting fetch
    telemetry.reportClientError(
      { message: 'Endpoint fallback failure', route: '/people/jane-doe' },
      { endpoint: 'https://archive.example.test/api/telemetry' }
    );
    expect(sendBeaconMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await Promise.resolve();

    // Global handlers: non-ErrorEvent ignored, chunk ErrorEvent, chunk rejection, and malformed vite:preloadError
    const captured: string[] = [];
    const cleanup = telemetry.installGlobalErrorHandlers({
      transport: (payload) => {
        captured.push(payload);
      },
    });

    // Non-ErrorEvent on 'error' is ignored
    window.dispatchEvent(new Event('error'));
    expect(captured).toHaveLength(0);

    // Chunk load ErrorEvent triggers chunk_preload report
    window.dispatchEvent(
      new ErrorEvent('error', {
        message: 'Failed to fetch dynamically imported module: /assets/tree.js',
        filename: 'https://archive.example.test/assets/tree.js?v=1',
      })
    );
    expect(captured).toHaveLength(1);
    expect(JSON.parse(captured[0] ?? '')).toMatchObject({
      kind: 'chunk_preload',
      assetUrl: '/assets/tree.js',
    });

    // Unhandled rejection with chunk error triggers chunk_preload report
    const rejectionEvent = new Event('unhandledrejection');
    Object.defineProperty(rejectionEvent, 'reason', {
      value: new Error('Loading chunk 7 failed'),
    });
    window.dispatchEvent(rejectionEvent);
    expect(captured).toHaveLength(2);
    expect(JSON.parse(captured[1] ?? '')).toMatchObject({
      kind: 'chunk_preload',
      message: 'Loading chunk 7 failed',
    });

    // vite:preloadError without preventDefault method is ignored safely
    const badPreloadEvent = new Event('vite:preloadError');
    Object.defineProperty(badPreloadEvent, 'preventDefault', { value: undefined });
    window.dispatchEvent(badPreloadEvent);
    expect(captured).toHaveLength(2);

    // Fill up remaining session budget (1 via endpoint + 2 via handlers = 3 so far; max is 8)
    for (let i = 0; i < 10; i += 1) {
      telemetry.reportClientError(
        { message: `Distinct client failure ${i}`, route: '/index' },
        {
          transport: (payload) => {
            captured.push(payload);
          },
        }
      );
    }
    // Only 5 more reports fit before hitting MAX_REPORTS_PER_SESSION = 8
    expect(captured).toHaveLength(7);

    cleanup();
  });
});

describe('httpWiki responseParsers validation and collection mapping behaviors', () => {
  const validPlace = {
    id: 'pl_oakville',
    slug: 'oakville',
    name: 'Oakville',
    full_name: 'Oakville, Pine County, Michigan, USA',
    place_type: 'town',
    parent_id: null,
    lat: 42.87,
    lng: -85.86,
  };

  const baseRevision = {
    revision_id: 4,
    batch_id: null,
    entity_type: 'place',
    entity_id: 'pl_oakville',
    parent_revision_id: 3,
    action: 'update',
    reverted_revision_id: null,
    author_id: 'jane@archive.example.test',
    author_name: 'Jane Doe',
    author_type: 'human',
    summary: 'Updated Oakville coordinates',
    has_primary_source: 1,
    before_json: null,
    after_json: validPlace,
    created_at: '2026-11-27T08:00:00.000Z',
  };

  it('rejects malformed primitive, array, entity payload, bitflag, and principal_kind fields with explicit errors', () => {
    expect(() => parseEntityWriteResponse({ entity: validPlace, revision: baseRevision, etag: 42 })).toThrow(
      'Expected string for etag'
    );

    expect(() =>
      parseCreatedAgentTokenResponse({
        token_id: '',
        label: 'Indexer',
        scope: 'read_backup',
        plaintext_secret: 'tok_secret_123',
      })
    ).toThrow('Expected non-empty string for token_id');

    expect(() => parseMagicLinkResponse({ sent: 'true' })).toThrow('Expected boolean for sent');

    expect(() =>
      parseEntityGetResponse({
        entity: validPlace,
        current_revision_id: Number.POSITIVE_INFINITY,
        has_primary_source: true,
        deleted_at: null,
        updated_at: '2026-11-27T08:00:00.000Z',
      })
    ).toThrow('Expected finite number for current_revision_id');

    expect(() => parseRevisionListResponse({ items: 'not-an-array', next_cursor: null })).toThrow(
      'Expected array for items'
    );

    expect(() =>
      parseEntityGetResponse({
        entity: 'not-an-object',
        current_revision_id: 1,
        has_primary_source: true,
        deleted_at: null,
        updated_at: '2026-11-27T08:00:00.000Z',
      })
    ).toThrow('Invalid entity payload for entity');

    expect(
      parseRevisionOnlyResponse({
        revision: { ...baseRevision, has_primary_source: 0 },
        etag: '"r4"',
      }).revision.has_primary_source
    ).toBe(false);
    expect(
      parseRevisionOnlyResponse({
        revision: { ...baseRevision, has_primary_source: 1 },
        etag: '"r4"',
      }).revision.has_primary_source
    ).toBe(true);

    expect(() =>
      parseRevisionOnlyResponse({
        revision: { ...baseRevision, has_primary_source: 'yes' },
        etag: '"r4"',
      })
    ).toThrow('Expected boolean (or 0/1) for revision.has_primary_source');

    expect(() =>
      parseSessionResponse({
        session: { authenticated: true, principal_kind: 'superuser' },
        capabilities: {
          canEdit: true,
          canUploadMedia: true,
          hasRevisionHistory: true,
          hasTalk: true,
          canManageSite: true,
        },
      })
    ).toThrow("Unexpected principal_kind 'superuser'");
  });

  it('parses session authProviders, talk comment author fallbacks, users, invites, and public agent tokens', () => {
    const sessionParsed = parseSessionResponse({
      session: {
        authenticated: true,
        principal_kind: 'user',
        email: 'jane@archive.example.test',
        displayName: 'Jane Doe',
        role: 'admin',
      },
      capabilities: {
        canEdit: true,
        canUploadMedia: true,
        hasRevisionHistory: true,
        hasTalk: true,
        canManageSite: true,
      },
      authProviders: {
        google: true,
        magicLink: false,
      },
    });
    expect(sessionParsed.authProviders).toEqual({ google: true, magicLink: false });
    expect(sessionParsed.session.role).toBe('admin');

    const comments = parseTalkCommentListResponse({
      comments: [
        {
          comment_id: 1,
          entity_type: 'place',
          entity_id: 'pl_oakville',
          author_id: 'jane@archive.example.test',
          author_name: 'Jane Doe',
          body_md: 'Verified plat map.',
          created_at: '2026-11-27T08:00:00.000Z',
          edited_at: null,
          deleted_at: null,
        },
        {
          comment_id: 2,
          entity_type: 'place',
          entity_id: 'pl_oakville',
          author_email: 'editor@archive.example.test',
          author_name: 'Editor Oak',
          body_md: 'Cross-checked census.',
          created_at: '2026-11-27T08:01:00.000Z',
          edited_at: null,
          deleted_at: null,
        },
        {
          comment_id: 3,
          entity_type: 'place',
          entity_id: 'pl_oakville',
          author_name: 'Guest Archivist',
          body_md: 'Legacy comment.',
          created_at: '2026-11-27T08:02:00.000Z',
          edited_at: null,
          deleted_at: null,
        },
      ],
    });
    expect(comments.map((c) => c.author_id)).toEqual([
      'jane@archive.example.test',
      'editor@archive.example.test',
      'unknown',
    ]);

    const users = parseUsersListResponse({
      users: [
        {
          email: 'jane@archive.example.test',
          display_name: 'Jane Doe',
          role: 'admin',
          added_by: 'bootstrap',
          added_at: '2026-11-01T00:00:00.000Z',
          last_login_at: '2026-11-27T08:00:00.000Z',
        },
      ],
    });
    expect(users).toEqual([
      {
        email: 'jane@archive.example.test',
        display_name: 'Jane Doe',
        role: 'admin',
        added_by: 'bootstrap',
        added_at: '2026-11-01T00:00:00.000Z',
        last_login_at: '2026-11-27T08:00:00.000Z',
      },
    ]);

    const invites = parseInvitesListResponse({
      invites: [
        {
          token: 'inv_oak_1',
          label: 'Oakville Family',
          created_by: 'jane@archive.example.test',
          created_at: '2026-11-01T00:00:00.000Z',
          expires_at: null,
          revoked_at: null,
          uses: 2,
          last_used_at: '2026-11-25T10:00:00.000Z',
        },
      ],
    });
    expect(invites[0]?.token).toBe('inv_oak_1');
    expect(invites[0]?.uses).toBe(2);

    const tokens = parseAgentTokensListResponse({
      tokens: [
        {
          token_id: 'tok_oak_1',
          label: 'Census Bot',
          scope: 'write_batch',
          created_by: 'jane@archive.example.test',
          created_at: '2026-11-10T00:00:00.000Z',
          revoked_at: null,
        },
      ],
    });
    expect(tokens).toEqual([
      {
        token_id: 'tok_oak_1',
        label: 'Census Bot',
        scope: 'write_batch',
        created_by: 'jane@archive.example.test',
        created_at: '2026-11-10T00:00:00.000Z',
        revoked_at: null,
      },
    ]);
  });
});

describe('PronunciationEditorSection and pronunciationDraft error, toggle, and audio-generation flows', () => {
  function createMinimalDataSource(overrides: Partial<ArchiveDataSource> = {}): ArchiveDataSource {
    return {
      async loadArchive() {
        throw new Error('unused');
      },
      async loadReadings() {
        return null;
      },
      async loadMediaChecklist() {
        return [];
      },
      ...overrides,
    };
  }

  it('covers pronunciationDraft unsupported-port, full-field serialization, missing audio_url, and error formatting paths', async () => {
    const unsupportedSave = await saveSharedTokenPronunciation(
      {
        term: 'Oakville',
        displayText: 'Oakville',
        phonetic: 'OHK-vil',
        ipa: '',
        language: '',
        note: '',
        source_label: '',
        source_url: '',
        region: '',
      },
      createMinimalDataSource()
    );
    expect(unsupportedSave).toEqual({
      ok: false,
      message: 'Saving shared pronunciations is not supported by this archive.',
    });

    const upsertSpy = vi.fn(async (_term: string, entry: Pronunciation) => ({
      term: 'Oakville',
      pronunciation: entry,
      pronunciations: { Oakville: entry },
    }));
    const fullSave = await saveSharedTokenPronunciation(
      {
        term: 'Oakville',
        displayText: 'Oakville',
        existingShared: {
          variants: [{ label: 'Midwest', region: 'Midwest', phonetic: 'OHK-vil' }],
        },
        phonetic: 'OHK-vil',
        ipa: '/ˈoʊk.vɪl/',
        language: 'en-US',
        note: 'Stress on first syllable',
        source_label: 'County Gazetteer',
        source_url: 'https://archive.example.test/gazetteer',
        region: 'Michigan',
      },
      createMinimalDataSource({ upsertPronunciationTerm: upsertSpy })
    );
    expect(fullSave.ok).toBe(true);
    expect(upsertSpy).toHaveBeenCalledWith('Oakville', {
      phonetic: 'OHK-vil',
      ipa: '/ˈoʊk.vɪl/',
      language: 'en-US',
      note: 'Stress on first syllable',
      source_label: 'County Gazetteer',
      source_url: 'https://archive.example.test/gazetteer',
      region: 'Michigan',
      variants: [{ label: 'Midwest', region: 'Midwest', phonetic: 'OHK-vil' }],
    });

    const errorSave = await saveSharedTokenPronunciation(
      {
        term: 'Oakville',
        displayText: 'Oakville',
        phonetic: 'OHK-vil',
        ipa: '',
        language: '',
        note: '',
        source_label: '',
        source_url: '',
        region: '',
      },
      createMinimalDataSource({
        upsertPronunciationTerm: async () => {
          throw new Error('Lexicon locked');
        },
      })
    );
    expect(errorSave).toEqual({ ok: false, message: 'Lexicon locked' });

    const nonErrorSave = await saveSharedTokenPronunciation(
      {
        term: 'Oakville',
        displayText: 'Oakville',
        phonetic: 'OHK-vil',
        ipa: '',
        language: '',
        note: '',
        source_label: '',
        source_url: '',
        region: '',
      },
      createMinimalDataSource({
        upsertPronunciationTerm: async () => {
          throw 'opaque-failure';
        },
      })
    );
    expect(nonErrorSave).toEqual({ ok: false, message: 'Failed to save shared pronunciation.' });

    const unsupportedAudio = await generatePronunciationAudio({
      entityType: 'place',
      entityId: 'pl_oakville',
      text: 'Oakville',
      draftPronunciation: null,
      dataSource: createMinimalDataSource(),
    });
    expect(unsupportedAudio).toEqual({
      ok: false,
      message: 'Audio generation is not supported by this archive.',
    });

    const missingAudioUrl = await generatePronunciationAudio({
      entityType: 'place',
      entityId: 'pl_oakville',
      text: 'Oakville',
      draftPronunciation: null,
      dataSource: createMinimalDataSource({
        generatePronunciationAudio: async () => ({
          audio_url: '',
          content_type: 'audio/mpeg',
          size_bytes: 0,
        }),
      }),
    });
    expect(missingAudioUrl).toEqual({
      ok: false,
      message: 'Server response did not include an audio_url.',
    });
  });

  it('toggles token chips, shows shared-save errors and clears them on Cancel, and guards empty/failed audio generation', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    const onUpdatePronunciation = vi.fn();
    const onSetPronunciations = vi.fn();

    await act(async () => {
      root.render(
        <PronunciationEditorSection
          entityType="person"
          entityId="per_jane"
          fullName="Jane Doe"
          givenName="Jane"
          surname="Doe"
          placeName=""
          previewLabel="Jane Doe"
          draftPronunciation={null}
          pronunciations={{ Jane: { phonetic: 'JAYN' } }}
          dataSource={createMinimalDataSource()}
          isBusy={false}
          onUpdatePronunciation={onUpdatePronunciation}
          onSetPronunciations={onSetPronunciations}
        />
      );
    });

    // Click token chip to open editor, click again to toggle closed
    const janeChip = container.querySelector<HTMLButtonElement>('button[data-pronunciation-token="Jane"]');
    expect(janeChip).not.toBeNull();
    await act(async () => {
      janeChip?.click();
    });
    expect(container.querySelector('.wiki-pronunciation-shared-editor')).not.toBeNull();

    await act(async () => {
      janeChip?.click();
    });
    expect(container.querySelector('.wiki-pronunciation-shared-editor')).toBeNull();

    // Re-open and attempt save on unsupported dataSource -> error alert, then Cancel clears it
    await act(async () => {
      janeChip?.click();
    });
    const saveBtn = container.querySelector<HTMLButtonElement>('.wiki-pronunciation-shared-save-btn');
    await act(async () => {
      saveBtn?.click();
    });
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      'Saving shared pronunciations is not supported by this archive.'
    );

    const cancelBtn = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Cancel');
    await act(async () => {
      cancelBtn?.click();
    });
    expect(container.querySelector('.wiki-pronunciation-shared-editor')).toBeNull();
    expect(container.querySelector('[role="alert"]')).toBeNull();

    // Generate Audio with unsupported dataSource -> shows error alert
    const genBtn = container.querySelector<HTMLButtonElement>('.wiki-pronunciation-gen-btn');
    await act(async () => {
      genBtn?.click();
    });
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      'Audio generation is not supported by this archive.'
    );

    // Re-render place with blank name -> Generate Audio rejects empty name
    await act(async () => {
      root.render(
        <PronunciationEditorSection
          entityType="place"
          entityId="pl_blank"
          fullName=""
          givenName=""
          surname=""
          placeName="   "
          previewLabel="Blank Place"
          draftPronunciation={null}
          pronunciations={{}}
          dataSource={createMinimalDataSource()}
          isBusy={false}
          onUpdatePronunciation={onUpdatePronunciation}
          onSetPronunciations={onSetPronunciations}
        />
      );
    });
    const blankGenBtn = container.querySelector<HTMLButtonElement>('.wiki-pronunciation-gen-btn');
    await act(async () => {
      blankGenBtn?.click();
    });
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      'Enter a name before generating pronunciation audio.'
    );

    await act(async () => {
      root.unmount();
    });
  });
});

describe('placeViewModel occupancy spans, living-person filtering, and undated record edges', () => {
  const siteConfig = parseKinloomConfig({
    site: {
      title: 'Oakville Archive',
      familyName: 'Doe',
      gedcomSourceName: 'OAKVILLE_ARCHIVE',
    },
    branches: [{ id: 'doe', label: 'Doe Line' }],
    lineageSections: [
      {
        id: 'direct',
        title: 'Direct Line',
        subtitle: 'Documented ancestors',
        lineageGroups: ['ancestor', 'pivot_ancestor'],
        branchId: 'doe',
      },
    ],
  });

  const { bundle: baseBundle }: { bundle: ArchiveBundle } = compileArchive({
    siteConfig,
    mode: 'public',
    places: [
      {
        id: 'pl_oakville',
        slug: 'oakville',
        name: 'Oakville',
        full_name: 'Oakville, Pine County, Michigan, USA',
        place_type: 'town',
        parent_id: null,
        lat: 42.87,
        lng: -85.86,
      },
      {
        id: 'pl_other',
        slug: 'riverbend',
        name: 'Riverbend',
        full_name: 'Riverbend, Pine County, Michigan, USA',
        place_type: 'town',
        parent_id: null,
        lat: 43.1,
        lng: -86.1,
      },
    ],
    sources: [
      {
        id: 'src_census',
        citation: '1880 Census, Oakville',
        source_type: 'census',
        has_primary_source: true,
      },
    ],
    people: [
      {
        id: 'per_jane',
        slug: 'jane-doe',
        full_name: 'Jane Doe',
        given_name: 'Jane',
        surname: 'Doe',
        alt_names: [],
        sex: 'F',
        is_living: false,
        birth_edtf: '1860',
        death_edtf: '1930',
        lineage_group: 'ancestor',
        branch: 'doe',
        portrait_url: null,
      },
      {
        id: 'per_span_only',
        slug: 'john-doe',
        full_name: 'John Doe',
        given_name: 'John',
        surname: 'Doe',
        alt_names: [],
        sex: 'M',
        is_living: false,
        birth_edtf: '1858',
        death_edtf: '1925',
        lineage_group: 'ancestor',
        branch: 'doe',
        portrait_url: null,
      },
      {
        id: 'per_living',
        slug: 'living-relative',
        full_name: 'Living Relative',
        given_name: 'Living',
        surname: 'Relative',
        alt_names: [],
        sex: 'U',
        is_living: true,
        birth_edtf: '1990',
        death_edtf: '',
        lineage_group: 'collateral',
        branch: 'doe',
        portrait_url: null,
      },
    ],
    events: [
      {
        id: 'ev_later',
        scope: 'personal',
        event_kind: 'residence_anchor',
        title: 'Oakville 1890 Census',
        summary: 'Enumerated in Oakville in 1890.',
        edtf_date: '1890',
        place_id: 'pl_oakville',
        participants: [
          { person_id: 'per_jane', role: 'primary' },
          { person_id: 'per_living', role: 'witness' },
        ],
        sources: [{ source_id: 'src_census', confidence: 'high' }],
      },
      {
        id: 'ev_earlier',
        scope: 'personal',
        event_kind: 'point_event',
        title: 'Oakville 1875 School Record',
        summary: 'Attended Oakville school.',
        edtf_date: '1875',
        place_id: 'pl_oakville',
        participants: [{ person_id: 'per_jane', role: 'primary' }],
        sources: [{ source_id: 'src_census', confidence: 'high' }],
      },
      {
        id: 'ev_local_no_place',
        scope: 'local',
        event_kind: 'point_event',
        title: 'Undated Regional Note',
        summary: 'Regional note without place.',
        edtf_date: '1880',
        place_id: null,
        participants: [],
        sources: [{ source_id: 'src_census', confidence: 'high' }],
      },
      {
        id: 'ev_local_undated',
        scope: 'local',
        event_kind: 'point_event',
        title: 'Oakville Bridge Dedication',
        summary: 'Undated bridge opening.',
        edtf_date: '',
        place_id: 'pl_oakville',
        participants: [],
        sources: [{ source_id: 'src_census', confidence: 'high' }],
      },
      {
        id: 'ev_local_1882',
        scope: 'local',
        event_kind: 'point_event',
        title: 'Oakville Post Office Opening',
        summary: 'Post office opened in 1882.',
        edtf_date: '1882',
        place_id: 'pl_oakville',
        participants: [],
        sources: [{ source_id: 'src_census', confidence: 'high' }],
      },
    ],
    kinship: [],
    media: [],
  });

  it('merges earlier events and residence spans while excluding living people, null spans, placeless records, and undated decade matches', () => {
    const evLater = baseBundle.events.find((e) => e.id === 'ev_later');
    const evEarlier = baseBundle.events.find((e) => e.id === 'ev_earlier');
    const restEvents = baseBundle.events.filter((e) => e.id !== 'ev_later' && e.id !== 'ev_earlier');

    const augmentedBundle: ArchiveBundle = {
      ...baseBundle,
      // Place later event before earlier event to verify startYear/firstEventId rollback
      events: [...(evLater ? [evLater] : []), ...(evEarlier ? [evEarlier] : []), ...restEvents],
      residence_spans: [
        // Non-matching place -> ignored
        {
          id: 'span_1',
          person_id: 'per_jane',
          place_id: 'pl_other',
          time_min: 1850,
          time_max: 1860,
          start_year: 1850,
          end_year: 1860,
          from_event_id: 'ev_earlier',
          to_event_id: 'ev_later',
          confidence_tier: 'Confirmed',
        },
        // Null start_year -> ignored
        {
          id: 'span_2',
          person_id: 'per_jane',
          place_id: 'pl_oakville',
          time_min: 1875,
          time_max: 1900,
          start_year: null,
          end_year: 1900,
          from_event_id: 'ev_earlier',
          to_event_id: 'ev_later',
          confidence_tier: 'Inferred',
        },
        // Living person -> ignored
        {
          id: 'span_3',
          person_id: 'per_living',
          place_id: 'pl_oakville',
          time_min: 1995,
          time_max: 2010,
          start_year: 1995,
          end_year: 2010,
          from_event_id: 'ev_later',
          to_event_id: 'ev_later',
          confidence_tier: 'Confirmed',
        },
        // Extends Jane's startYear earlier (1870) and endYear later (1905)
        {
          id: 'span_4',
          person_id: 'per_jane',
          place_id: 'pl_oakville',
          time_min: 1870,
          time_max: 1905,
          start_year: 1870,
          end_year: 1905,
          from_event_id: 'ev_earlier',
          to_event_id: 'ev_later',
          confidence_tier: 'Inferred',
        },
        // Adds span-only person (John Doe)
        {
          id: 'span_5',
          person_id: 'per_span_only',
          place_id: 'pl_oakville',
          time_min: 1880,
          time_max: 1898,
          start_year: 1880,
          end_year: 1898,
          from_event_id: 'ev_earlier',
          to_event_id: 'ev_later',
          confidence_tier: 'Possible',
        },
      ],
    };

    const peopleById = new Map<string, Person>(
      augmentedBundle.people.map((p) => [p.id, p.id === 'per_living' ? { ...p, full_name: 'Living' } : p])
    );
    const matchingIds = new Set<string>(['pl_oakville']);
    const placesById = new Map<string, Place>(augmentedBundle.places.map((p) => [p.id, p]));
    expect(placesById.has('pl_oakville')).toBe(true);

    const occupancy = buildPlaceOccupancySummary(augmentedBundle, matchingIds, peopleById);
    expect(occupancy.rows).toHaveLength(2);
    expect(occupancy.rows[0]).toMatchObject({
      startYear: 1870,
      endYear: 1905,
      firstEventId: 'ev_earlier',
      tier: 'Confirmed',
    });
    expect(occupancy.rows[1]).toMatchObject({
      startYear: 1880,
      endYear: 1898,
      tier: 'Possible',
    });
    expect(occupancy.minYear).toBe(1870);
    expect(occupancy.maxYear).toBe(1905);

    const localRecords = collectPlaceLocalRecords(augmentedBundle, matchingIds);
    expect(localRecords.map((ev) => ev.id)).toEqual(['ev_local_undated', 'ev_local_1882']);

    const filtered1880s = filterLocalRecordsByDecade(localRecords, '1880');
    expect(filtered1880s.map((ev) => ev.id)).toEqual(['ev_local_1882']);
  });
});
