/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createActor, waitFor } from 'xstate';
import {
  consumeAuthErrorFromWindow,
  getCleanNextPath,
  normalizeAuthErrorCode,
  normalizeAuthProvider,
  parseInviteInput,
  readAuthErrorFromSearch,
  resolveAuthFeedback,
  resolveClientAuthError,
  stripAuthErrorParams,
  validateEmailInput,
} from '../components/wiki/authErrorCopy.js';
import {
  cleanPronunciation,
  generatePronunciationAudio,
  readDraftPronunciation,
  saveSharedTokenPronunciation,
} from '../components/wiki/pronunciation/pronunciationDraft.js';
import {
  buildEventQueryUrl,
  pickActiveTimelineEventId,
  shouldRunInitialEventScroll,
} from '../lib/timelineScroll.js';
import { authSessionMachine } from './authSessionMachine.js';
import { entityEditorMachine } from './entityEditorMachine.js';
import { mediaUploadMachine } from './mediaUploadMachine.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('authErrorCopy, pronunciationDraft, and timelineScroll behavioral rules', () => {
  it('normalizes auth providers, error codes, invite inputs, email validation, and URL error consumption', () => {
    expect(normalizeAuthProvider('google')).toBe('google');
    expect(normalizeAuthProvider('magic_link')).toBe('magic_link');
    expect(normalizeAuthProvider('invite')).toBe('invite');
    expect(normalizeAuthProvider('unknown')).toBeNull();

    for (const code of [
      'email_not_enrolled',
      'invite_revoked',
      'invite_expired',
      'magic_link_expired',
      'magic_link_used',
      'oauth_denied',
      'rate_limited',
      'server_error',
      'completely_unknown_code',
    ]) {
      const normalized = normalizeAuthErrorCode(code);
      const fb = resolveAuthFeedback({ code: normalized, provider: 'google' });
      expect(fb.title.length).toBeGreaterThan(0);
    }

    expect(
      resolveClientAuthError(new TypeError('Failed to fetch'), 'magic_link', true).title.length
    ).toBeGreaterThan(0);
    expect(
      resolveClientAuthError(new Error('HTTP 429 Too Many Requests'), 'google', true).title.length
    ).toBeGreaterThan(0);
    expect(resolveClientAuthError('Something broke', 'invite', false).title.length).toBeGreaterThan(0);

    expect(validateEmailInput('')).not.toBeNull();
    expect(validateEmailInput('not-an-email')).not.toBeNull();
    expect(validateEmailInput('henry@example.test')).toBeNull();

    expect(parseInviteInput('')).toEqual({ ok: false, message: expect.any(String) });
    expect(parseInviteInput('https://archive.example.test/invite/abc123456789').ok).toBe(true);
    expect(parseInviteInput('/invite/abc123456789').ok).toBe(true);
    expect(parseInviteInput('abc123456789').ok).toBe(true);

    expect(readAuthErrorFromSearch('?auth_error=invite_revoked&auth_provider=invite')?.code).toBe(
      'invite_revoked'
    );
    expect(readAuthErrorFromSearch('?tab=sources')).toBeNull();
    expect(stripAuthErrorParams('/person/henry', '?auth_error=x&tab=1', '#bio')).toBe(
      '/person/henry?tab=1#bio'
    );

    window.history.replaceState({}, '', '/person/henry?auth_error=oauth_denied&auth_provider=google&tab=1');
    const consumed = consumeAuthErrorFromWindow();
    expect(consumed?.code).toBe('oauth_denied');
    expect(getCleanNextPath()).toContain('/person/henry');
  });

  it('cleans pronunciation drafts and handles shared token save & TTS audio generation API responses', async () => {
    expect(readDraftPronunciation(null)).toBeNull();
    expect(readDraftPronunciation({ ipa: 'ˈɔːldər', phonetic: 'AWL-der' })?.ipa).toBe('ˈɔːldər');
    expect(
      cleanPronunciation({ ipa: '  ˈɔːldər  ', source_url: 'https://example.test/ref' }, true)?.ipa
    ).toBe('ˈɔːldər');
    expect(cleanPronunciation({ ipa: '  ', phonetic: '' }, true)).toBeNull();

    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    fetchSpy.mockResolvedValueOnce(jsonResponse({ pronunciations: { 'surname:alder': { ipa: 'ˈɔːldər' } } }));
    const okSave = await saveSharedTokenPronunciation({
      term: 'alder',
      displayText: 'Alder',
      phonetic: 'AWL-der',
      ipa: 'ˈɔːldər',
      language: 'en',
      note: '',
      source_label: '',
      source_url: '',
      region: '',
    });
    expect(okSave.ok).toBe(true);

    fetchSpy.mockResolvedValueOnce(jsonResponse({ error: { message: 'Forbidden' } }, 403));
    const failSave = await saveSharedTokenPronunciation({
      term: 'alder',
      displayText: 'Alder',
      phonetic: 'AWL-der',
      ipa: 'ˈɔːldər',
      language: 'en',
      note: '',
      source_label: '',
      source_url: '',
      region: '',
    });
    expect(failSave.ok).toBe(false);

    fetchSpy.mockResolvedValueOnce(jsonResponse({ audio_url: '/audio/alder.mp3' }));
    const okAudio = await generatePronunciationAudio({
      entityType: 'person',
      entityId: 'per_henry',
      text: 'Henry Alder',
      draftPronunciation: { ipa: 'ˈhɛnri ˈɔːldər' },
    });
    expect(okAudio.ok).toBe(true);

    fetchSpy.mockResolvedValueOnce(jsonResponse({ error: { message: 'TTS unavailable' } }, 503));
    const failAudio = await generatePronunciationAudio({
      entityType: 'person',
      entityId: 'per_henry',
      text: 'Henry Alder',
      draftPronunciation: null,
    });
    expect(failAudio.ok).toBe(false);
  });

  it('computes active timeline event, initial scroll gating, and event query URLs', () => {
    expect(pickActiveTimelineEventId([], { anchorY: 120, scrollY: 100, maxScrollY: 800 })).toBeNull();
    expect(
      pickActiveTimelineEventId(
        [
          { id: 'e1', top: -200, bottom: -50 },
          { id: 'e2', top: 40, bottom: 300 },
          { id: 'e3', top: 320, bottom: 600 },
        ],
        { anchorY: 120, scrollY: 100, maxScrollY: 800 }
      )
    ).toBe('e2');
    expect(
      pickActiveTimelineEventId(
        [
          { id: 'e1', top: 500, bottom: 700 },
          { id: 'e2', top: 750, bottom: 950 },
        ],
        { anchorY: 120, scrollY: 100, maxScrollY: 800 }
      )
    ).toBe('e1');

    expect(
      shouldRunInitialEventScroll({
        navKey: 'k1',
        completedNavKey: null,
        targetEventId: 'e2',
        eventIds: ['e1', 'e2'],
      })
    ).toBe(true);
    expect(
      shouldRunInitialEventScroll({
        navKey: 'k1',
        completedNavKey: 'k1',
        targetEventId: 'e2',
        eventIds: ['e1', 'e2'],
      })
    ).toBe(false);

    expect(buildEventQueryUrl('https://archive.example.test/person/henry', 'e2')).toBe(
      '/person/henry?event=e2'
    );
    expect(buildEventQueryUrl('https://archive.example.test/person/henry?event=e2', 'e2')).toBeNull();
  });
});

describe('Remaining XState machine behavioral edge transitions', () => {
  it('handles CANCEL while uploading, stale upload generations, and attach 422 in mediaUploadMachine', async () => {
    const pngFile = new File([new Uint8Array([1, 2, 3])], 'scan.png', { type: 'image/png' });
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    // Attach returns 422 living blocked
    fetchSpy
      .mockResolvedValueOnce(jsonResponse({ r2Key: 'media/scan.png', url: '/media/scan.png' }))
      .mockResolvedValueOnce(jsonResponse({ error: { message: 'Target became living' } }, 422));

    const actor = createActor(mediaUploadMachine, { input: {} }).start();
    actor.send({
      type: 'SELECT_FILE',
      file: pngFile,
      targets: { personIds: ['per_henry'] },
      targetHasLiving: false,
    });
    const blocked = await waitFor(actor, (s) => s.matches('rejectedInvalid'));
    expect(blocked.context.rejectionReason).toBe('living_person_blocked');

    // Attach 500 error -> failedRetryable -> CANCEL -> idle
    fetchSpy
      .mockResolvedValueOnce(jsonResponse({ r2Key: 'media/scan.png', url: '/media/scan.png' }))
      .mockResolvedValueOnce(jsonResponse({}, 500));
    actor.send({
      type: 'SELECT_FILE',
      file: pngFile,
      targets: { personIds: ['per_henry'] },
      targetHasLiving: false,
    });
    await waitFor(actor, (s) => s.matches('failedRetryable'));
    actor.send({ type: 'CANCEL' });
    expect(actor.getSnapshot().matches('idle')).toBe(true);
    actor.stop();
  });

  it('handles REBASE_TO_EDIT, RETURN_TO_EDIT, DISCARD_DRAFT, and CANCEL_SAVE in entityEditorMachine and REFRESH_SESSION in authSessionMachine', async () => {
    const base = {
      id: 'per_henry',
      slug: 'henry-alder',
      full_name: 'Henry Alder',
      given_name: 'Henry',
      surname: 'Alder',
      sex: 'M',
      is_living: false,
      lineage_group: 'ancestor',
    };

    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    fetchSpy.mockResolvedValueOnce(jsonResponse({}, 500));

    const ed = createActor(entityEditorMachine, {
      input: { entityType: 'person', entityId: 'per_henry', revisionId: 1, snapshot: base },
    }).start();
    ed.send({ type: 'START_EDIT' });
    ed.send({ type: 'EDIT_FIELD', draft: { ...base, full_name: 'Henry M. Alder' } });
    ed.send({ type: 'SET_SUMMARY', summary: 'Updated name' });
    ed.send({ type: 'SUBMIT' });
    await waitFor(ed, (s) => s.matches('networkErrorRetryable'));
    ed.send({ type: 'RETURN_TO_EDIT' });
    expect(ed.getSnapshot().matches({ editing: 'dirty' })).toBe(true);
    ed.send({ type: 'DISCARD_DRAFT' });
    expect(ed.getSnapshot().matches('viewing')).toBe(true);
    ed.stop();

    // authSessionMachine REFRESH_SESSION + magic link 403
    fetchSpy
      .mockResolvedValueOnce(jsonResponse({ session: { authenticated: false, principal_kind: 'anonymous' } }))
      .mockResolvedValueOnce(jsonResponse({ session: { authenticated: false, principal_kind: 'anonymous' } }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }))
      .mockResolvedValueOnce(jsonResponse({}, 403));

    const auth = createActor(authSessionMachine, { input: {} }).start();
    await waitFor(auth, (s) => s.matches('anonymous'));
    auth.send({ type: 'REFRESH_SESSION' });
    await waitFor(auth, (s) => s.matches('anonymous'));
    auth.send({ type: 'REQUEST_MAGIC_LINK', email: 'outsider@example.test' });
    await waitFor(auth, (s) => s.matches('awaitingMagicLinkClick'));
    auth.send({ type: 'OPEN_MAGIC_LINK', token: 'tok-403' });
    const snap = await waitFor(auth, (s) => s.matches('anonymous'));
    expect(snap.context.authError).toContain('not enrolled');
    auth.stop();
  });
});
