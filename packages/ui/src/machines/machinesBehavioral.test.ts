import type {
  ArchiveDataSource,
  ArchiveSessionState,
  MediaItem,
  OptimisticConflictError,
  RevisionRecord,
} from '@kinloom/core';
import { asRevisionId } from '@kinloom/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createActor, waitFor } from 'xstate';
import { ApiClientError } from '../adapters/httpWikiDataSource.js';
import { authSessionMachine, deriveSessionFromAuthSnapshot } from './authSessionMachine.js';
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

describe('authSessionMachine behavioral transitions', () => {
  it('hydrates admin, editor, invite_viewer, anonymous, and fetch errors via dataSource and fetch', async () => {
    const cases: Array<{
      session: ArchiveSessionState;
      expectedState: unknown;
      expectedRole: string | undefined;
    }> = [
      {
        session: {
          authenticated: true,
          principal_kind: 'user',
          email: 'admin@example.test',
          displayName: 'Admin Alder',
          role: 'admin',
        },
        expectedState: { authenticated: 'admin' },
        expectedRole: 'admin',
      },
      {
        session: {
          authenticated: true,
          principal_kind: 'user',
          email: 'editor@example.test',
          displayName: 'Editor Alder',
          role: 'editor',
        },
        expectedState: { authenticated: 'editor' },
        expectedRole: 'editor',
      },
      {
        session: {
          authenticated: false,
          principal_kind: 'invite_viewer',
          role: 'viewer',
          inviteLabel: 'Reunion 2026',
        },
        expectedState: 'readOnlyInvite',
        expectedRole: 'viewer',
      },
      {
        session: { authenticated: false, principal_kind: 'anonymous' },
        expectedState: 'anonymous',
        expectedRole: undefined,
      },
    ];

    for (const c of cases) {
      const ds = {
        getSession: async () => ({
          session: c.session,
          capabilities: {
            canEdit: false,
            canUploadMedia: false,
            hasRevisionHistory: false,
            hasTalk: false,
            canManageSite: false,
          },
        }),
      } as unknown as ArchiveDataSource;

      const actor = createActor(authSessionMachine, { input: { dataSource: ds } }).start();
      const snap = await waitFor(actor, (s) => !s.matches('hydrating'));
      expect(snap.matches(c.expectedState as never)).toBe(true);
      const derived = deriveSessionFromAuthSnapshot(snap);
      expect(derived.session.role).toBe(c.expectedRole);
      actor.stop();
    }

    // Fetch-based hydration (no dataSource): non-OK and network failure fall back to anonymous
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(jsonResponse({}, 500));
    const a1 = createActor(authSessionMachine, { input: {} }).start();
    const s1 = await waitFor(a1, (s) => s.matches('anonymous'));
    expect(s1.matches('anonymous')).toBe(true);
    a1.stop();

    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('offline'));
    const a2 = createActor(authSessionMachine, { input: {} }).start();
    const s2 = await waitFor(a2, (s) => s.matches('anonymous'));
    expect(s2.matches('anonymous')).toBe(true);
    a2.stop();

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      jsonResponse({
        session: {
          authenticated: true,
          principal_kind: 'user',
          email: 'fetch@example.test',
          displayName: 'Fetch Admin',
          role: 'admin',
        },
      })
    );
    const a3 = createActor(authSessionMachine, { input: {} }).start();
    const s3 = await waitFor(a3, (s) => s.matches({ authenticated: 'admin' }));
    expect(s3.context.email).toBe('fetch@example.test');
    a3.stop();
  });

  it('handles Google sign-in, magic link request/verify/cancel/resend, invite auto-enroll, revocation, and session expiry', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    // 1. Initial hydrate -> anonymous
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({ session: { authenticated: false, principal_kind: 'anonymous' } })
    );

    const actor = createActor(authSessionMachine, { input: {} }).start();
    await waitFor(actor, (s) => s.matches('anonymous'));

    // Open revoked invite -> inviteRevoked -> dismiss -> anonymous
    actor.send({ type: 'OPEN_INVITE', token: 'tok-bad', label: 'Old', revoked: true });
    expect(actor.getSnapshot().matches('inviteRevoked')).toBe(true);
    actor.send({ type: 'DISMISS_INVITE' });
    expect(actor.getSnapshot().matches('anonymous')).toBe(true);

    // Open valid invite -> readOnlyInvite
    actor.send({ type: 'OPEN_INVITE', token: 'tok-ok', label: 'Cousin Link', revoked: false });
    expect(actor.getSnapshot().matches('readOnlyInvite')).toBe(true);

    // Google sign-in 403 -> returns to readOnlyInvite with error
    fetchSpy.mockResolvedValueOnce(jsonResponse({}, 403));
    actor.send({ type: 'SIGN_IN_GOOGLE' });
    let snap = await waitFor(actor, (s) => s.matches('readOnlyInvite'));
    expect(snap.context.authError).toContain('not enrolled');

    // Google sign-in 500 error -> returns to readOnlyInvite with error
    fetchSpy.mockResolvedValueOnce(jsonResponse({}, 500));
    actor.send({ type: 'SIGN_IN_GOOGLE' });
    snap = await waitFor(actor, (s) => s.matches('readOnlyInvite'));
    expect(snap.context.authError).toContain('500');

    // Google sign-in auto-enrolls via invite -> authenticated.editor
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({
        kind: 'verified',
        isMember: false,
        role: 'editor',
        email: 'cousin@example.test',
        displayName: 'Cousin Mercer',
      })
    );
    actor.send({ type: 'SIGN_IN_GOOGLE' });
    snap = await waitFor(actor, (s) => s.matches({ authenticated: 'editor' }));
    expect(snap.context.autoEnrolledViaInvite).toBe(true);

    // Session expires -> sessionExpired -> sign out -> anonymous
    actor.send({ type: 'SESSION_EXPIRED' });
    expect(actor.getSnapshot().matches('sessionExpired')).toBe(true);
    actor.send({ type: 'SIGN_OUT' });
    expect(actor.getSnapshot().matches('anonymous')).toBe(true);

    // Magic link request failure -> anonymous with error
    fetchSpy.mockResolvedValueOnce(jsonResponse({}, 503));
    actor.send({ type: 'REQUEST_MAGIC_LINK', email: 'henry@example.test' });
    snap = await waitFor(actor, (s) => s.matches('anonymous'));
    expect(snap.context.authError).toContain('503');

    // Magic link request success -> awaitingMagicLinkClick -> resend -> verify invalid -> verify admin
    fetchSpy.mockResolvedValueOnce(jsonResponse({ ok: true }));
    actor.send({ type: 'REQUEST_MAGIC_LINK', email: 'henry@example.test' });
    await waitFor(actor, (s) => s.matches('awaitingMagicLinkClick'));

    fetchSpy.mockResolvedValueOnce(jsonResponse({ ok: true }));
    actor.send({ type: 'RESEND_MAGIC_LINK', email: 'henry@example.test' });
    await waitFor(actor, (s) => s.matches('awaitingMagicLinkClick'));

    // Cancel magic link -> anonymous
    actor.send({ type: 'CANCEL_MAGIC_LINK' });
    expect(actor.getSnapshot().matches('anonymous')).toBe(true);

    // Request again and verify as admin
    fetchSpy.mockResolvedValueOnce(jsonResponse({ ok: true }));
    actor.send({ type: 'REQUEST_MAGIC_LINK', email: 'admin@example.test' });
    await waitFor(actor, (s) => s.matches('awaitingMagicLinkClick'));

    fetchSpy.mockResolvedValueOnce(
      jsonResponse({
        kind: 'verified',
        isMember: true,
        role: 'admin',
        email: 'admin@example.test',
        displayName: 'Admin Alder',
      })
    );
    actor.send({ type: 'OPEN_MAGIC_LINK', token: 'ml-admin' });
    snap = await waitFor(actor, (s) => s.matches({ authenticated: 'admin' }));
    expect(snap.context.role).toBe('admin');

    // Sign out from authenticated
    actor.send({ type: 'SIGN_OUT' });
    expect(actor.getSnapshot().matches('anonymous')).toBe(true);
    actor.stop();
  });

  it('handles magic link invalid/revoked responses and invite leave/revocation', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({ session: { authenticated: false, principal_kind: 'anonymous' } })
    );

    const actor = createActor(authSessionMachine, { input: {} }).start();
    await waitFor(actor, (s) => s.matches('anonymous'));

    // Open invite then leave
    actor.send({ type: 'OPEN_INVITE', token: 'inv-1', label: 'Family', revoked: false });
    actor.send({ type: 'LEAVE_INVITE' });
    expect(actor.getSnapshot().matches('anonymous')).toBe(true);

    // Open invite then server revokes
    actor.send({ type: 'OPEN_INVITE', token: 'inv-2', label: 'Family', revoked: false });
    actor.send({ type: 'INVITE_REVOKED_SERVER' });
    expect(actor.getSnapshot().matches('inviteRevoked')).toBe(true);
    actor.send({ type: 'DISMISS_INVITE' });

    // Magic link verify returns 401 -> invalid -> anonymous
    fetchSpy.mockResolvedValueOnce(jsonResponse({ ok: true }));
    actor.send({ type: 'REQUEST_MAGIC_LINK', email: 'ed@example.test' });
    await waitFor(actor, (s) => s.matches('awaitingMagicLinkClick'));

    fetchSpy.mockResolvedValueOnce(jsonResponse({}, 401));
    actor.send({ type: 'OPEN_MAGIC_LINK', token: 'expired' });
    const snap = await waitFor(actor, (s) => s.matches('anonymous'));
    expect(snap.context.authError).toContain('expired');

    // Magic link verify returns member editor
    fetchSpy.mockResolvedValueOnce(jsonResponse({ ok: true }));
    actor.send({ type: 'REQUEST_MAGIC_LINK', email: 'ed@example.test' });
    await waitFor(actor, (s) => s.matches('awaitingMagicLinkClick'));
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({
        kind: 'verified',
        isMember: true,
        role: 'editor',
        email: 'ed@example.test',
        displayName: 'Ed Alder',
      })
    );
    actor.send({ type: 'OPEN_MAGIC_LINK', token: 'valid-ed' });
    const edSnap = await waitFor(actor, (s) => s.matches({ authenticated: 'editor' }));
    expect(edSnap.context.email).toBe('ed@example.test');
    actor.stop();
  });
});

describe('entityEditorMachine behavioral transitions', () => {
  it('supports validation errors, optimistic 409 conflict rebase/accept, network retry, and dirty leave confirmation', async () => {
    const basePerson = {
      id: 'per_henry',
      slug: 'henry-alder',
      full_name: 'Henry Alder',
      given_name: 'Henry',
      surname: 'Alder',
      sex: 'M',
      is_living: false,
      lineage_group: 'ancestor',
    };

    const conflictPayload: OptimisticConflictError = {
      kind: 'conflict',
      entity_type: 'person',
      entity_id: 'per_henry',
      expected_parent_revision_id: asRevisionId(1),
      server_revision_id: asRevisionId(2),
      server_entity: { ...basePerson, birth_edtf: '1855' },
      server_deleted_at: null,
      last_author_name: 'Clara Alder',
      last_updated_at: '2026-06-01T12:00:00Z',
      diff: { fields: [], addedCount: 0, removedCount: 0, changedCount: 1, hasChanges: true },
    };

    let callCount = 0;
    const ds = {
      updateEntity: async () => {
        callCount += 1;
        if (callCount === 1) {
          return { ok: false as const, conflict: conflictPayload };
        }
        if (callCount === 2) {
          throw new Error('Temporary network outage');
        }
        return {
          ok: true as const,
          entity: { ...basePerson, birth_edtf: '1855', death_edtf: '1932' },
          revision: { revision_id: asRevisionId(3) } as unknown as RevisionRecord,
          etag: '"r3"',
        };
      },
    } as unknown as ArchiveDataSource;

    const actor = createActor(entityEditorMachine, {
      input: {
        entityType: 'person',
        entityId: 'per_henry',
        revisionId: 1,
        snapshot: basePerson,
        hasPrimarySource: true,
        dataSource: ds,
      },
    }).start();

    expect(actor.getSnapshot().matches('viewing')).toBe(true);

    // Start editing -> clean -> cancel -> viewing
    actor.send({ type: 'START_EDIT' });
    expect(actor.getSnapshot().matches({ editing: 'clean' })).toBe(true);
    actor.send({ type: 'CANCEL_EDIT' });
    expect(actor.getSnapshot().matches('viewing')).toBe(true);

    // Start editing -> edit field without summary -> validationError
    actor.send({ type: 'START_EDIT' });
    actor.send({ type: 'EDIT_FIELD', draft: { ...basePerson, death_edtf: '1932' } });
    actor.send({ type: 'SET_CITATION', mode: 'cited', sourceIds: ['src_1'] });
    actor.send({ type: 'SUBMIT' });
    expect(actor.getSnapshot().matches('validationError')).toBe(true);
    expect(actor.getSnapshot().context.validationErrors.length).toBeGreaterThan(0);

    // Provide valid summary -> submit -> 409 conflict
    actor.send({ type: 'SET_SUMMARY', summary: 'Added death year from headstone' });
    actor.send({ type: 'SUBMIT' });
    let snap = await waitFor(actor, (s) => s.matches('conflict409'));
    expect(snap.context.conflict?.latestRevisionId).toBe(2);

    // Entity changed while in conflict -> confirmingLeave -> stay editing returns to conflict
    actor.send({
      type: 'ENTITY_CHANGED',
      entityType: 'person',
      entityId: 'per_other',
      revisionId: 1,
      snapshot: { ...basePerson, id: 'per_other', full_name: 'Other Alder' },
    });
    expect(actor.getSnapshot().matches('confirmingLeave')).toBe(true);
    actor.send({ type: 'STAY_EDITING' });
    expect(actor.getSnapshot().matches({ conflict409: 'resolvingConflict' })).toBe(true);

    // Rebase and retry -> hits simulated network error -> networkErrorRetryable
    actor.send({ type: 'REBASE_AND_RETRY' });
    snap = await waitFor(actor, (s) => s.matches('networkErrorRetryable'));
    expect(snap.context.networkError).toContain('network outage');

    // Retry save -> succeeds -> saved -> dismiss -> viewing
    actor.send({ type: 'RETRY_SAVE' });
    snap = await waitFor(actor, (s) => s.matches('saved'));
    expect(snap.context.baseRevisionId).toBe(3);
    expect(snap.context.lastEtag).toBe('"r3"');
    actor.send({ type: 'DISMISS_SAVED' });
    expect(actor.getSnapshot().matches('viewing')).toBe(true);

    // Dirty edit + ENTITY_CHANGED + CONFIRM_LEAVE switches entity cleanly
    actor.send({ type: 'START_EDIT' });
    actor.send({ type: 'EDIT_FIELD', draft: { ...basePerson, full_name: 'Draft Name' } });
    actor.send({
      type: 'ENTITY_CHANGED',
      entityType: 'person',
      entityId: 'per_next',
      revisionId: 5,
      snapshot: { ...basePerson, id: 'per_next', full_name: 'Next Alder' },
    });
    expect(actor.getSnapshot().matches('confirmingLeave')).toBe(true);
    actor.send({ type: 'CONFIRM_LEAVE' });
    expect(actor.getSnapshot().matches('viewing')).toBe(true);
    expect(actor.getSnapshot().context.entityId).toBe('per_next');
    actor.stop();
  });

  it('exercises fetch-based save path for 200 OK and 409 conflict + ACCEPT_SERVER', async () => {
    const basePerson = {
      id: 'per_clara',
      slug: 'clara-alder',
      full_name: 'Clara Alder',
      given_name: 'Clara',
      surname: 'Alder',
      sex: 'F',
      is_living: false,
      lineage_group: 'ancestor',
    };

    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    fetchSpy.mockResolvedValueOnce(
      jsonResponse(
        {
          error: {
            details: {
              entity_type: 'person',
              entity_id: 'per_clara',
              expected_parent_revision_id: 1,
              server_revision_id: 4,
              server_entity: { ...basePerson, full_name: 'Clara M. Alder' },
              server_deleted_at: null,
              last_author_name: 'Founder',
              last_updated_at: '2026-06-02T00:00:00Z',
              diff: [],
            },
          },
        },
        409
      )
    );

    const actor = createActor(entityEditorMachine, {
      input: {
        entityType: 'person',
        entityId: 'per_clara',
        revisionId: 1,
        snapshot: basePerson,
      },
    }).start();

    actor.send({ type: 'START_EDIT' });
    actor.send({ type: 'EDIT_FIELD', draft: { ...basePerson, full_name: 'Clara Mercer Alder' } });
    actor.send({ type: 'SET_SUMMARY', summary: 'Updated middle name' });
    actor.send({ type: 'SUBMIT' });
    await waitFor(actor, (s) => s.matches('conflict409'));

    // Accept server snapshot -> returns to viewing with server revision
    actor.send({ type: 'ACCEPT_SERVER' });
    expect(actor.getSnapshot().matches('viewing')).toBe(true);
    expect(actor.getSnapshot().context.baseRevisionId).toBe(4);
    expect(actor.getSnapshot().context.baseSnapshot.full_name).toBe('Clara M. Alder');

    // Now test fetch 200 OK save
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({
        entity: { ...basePerson, full_name: 'Clara M. Alder', death_edtf: '1940' },
        revision: { revision_id: 5 },
        etag: '"r5"',
      })
    );
    actor.send({ type: 'START_EDIT' });
    actor.send({ type: 'EDIT_FIELD', draft: { ...basePerson, death_edtf: '1940' } });
    actor.send({ type: 'SET_SUMMARY', summary: 'Added death year' });
    actor.send({ type: 'SUBMIT' });
    const snap = await waitFor(actor, (s) => s.matches('saved'));
    expect(snap.context.baseRevisionId).toBe(5);
    actor.stop();
  });
});

describe('mediaUploadMachine behavioral transitions', () => {
  it('validates client rules, hashes, uploads via dataSource, handles living-privacy 422, retries transient failures, and completes', async () => {
    const pngFile = new File([new Uint8Array([137, 80, 78, 71])], 'cabin.png', { type: 'image/png' });

    let attempt = 0;
    const ds = {
      uploadMedia: async () => {
        attempt += 1;
        if (attempt === 1) {
          throw new Error('502 Bad Gateway');
        }
        if (attempt === 2) {
          throw new ApiClientError(422, 'LIVING_MEDIA_FORBIDDEN', 'Cannot attach photo to living person');
        }
        return {
          media: {
            id: 'med_1',
            kind: 'family_photo',
            caption: 'Cabin',
            url: '/media/cabin.png',
          } as unknown as MediaItem,
          url: '/media/cabin.png',
          revision: { revision_id: asRevisionId(2) } as unknown as RevisionRecord,
          etag: '"r2"',
        };
      },
    } as unknown as ArchiveDataSource;

    const actor = createActor(mediaUploadMachine, { input: { dataSource: ds } }).start();

    // 1. Client-side rejection (living person target)
    actor.send({
      type: 'SELECT_FILE',
      file: pngFile,
      targets: { personIds: ['per_living'] },
      targetHasLiving: true,
    });
    expect(actor.getSnapshot().matches('rejectedInvalid')).toBe(true);
    actor.send({ type: 'RESET' });
    expect(actor.getSnapshot().matches('idle')).toBe(true);

    // 2. Transient upload error -> failedRetryable -> RETRY -> 422 living blocked -> rejectedInvalid
    actor.send({
      type: 'SELECT_FILE',
      file: pngFile,
      targets: { personIds: ['per_henry'] },
      targetHasLiving: false,
      metadata: { caption: 'Cabin 1880' },
    });
    let snap = await waitFor(actor, (s) => s.matches('failedRetryable'));
    expect(snap.context.retryableError).toContain('502');

    actor.send({ type: 'RETRY' });
    snap = await waitFor(actor, (s) => s.matches('rejectedInvalid'));
    expect(snap.context.rejectionReason).toBe('living_person_blocked');

    // 3. New upload succeeds and attaches atomically -> complete
    actor.send({
      type: 'SELECT_FILE',
      file: pngFile,
      targets: { personIds: ['per_henry'] },
      targetHasLiving: false,
      metadata: { caption: 'Cabin 1880' },
    });
    snap = await waitFor(actor, (s) => s.matches('complete'));
    expect(snap.context.mediaId).toBe('med_1');

    actor.send({ type: 'RESET' });
    expect(actor.getSnapshot().matches('idle')).toBe(true);
    actor.stop();
  });

  it('exercises fetch-based upload + attach actors (200 OK and 422 living blocked)', async () => {
    const pngFile = new File([new Uint8Array([1, 2, 3, 4])], 'mill.png', { type: 'image/png' });
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    fetchSpy
      .mockResolvedValueOnce(jsonResponse({ r2Key: 'media/mill.png', url: '/media/mill.png' }))
      .mockResolvedValueOnce(jsonResponse({ media_id: 'med_fetch_1', target_became_living: false }));

    const actor = createActor(mediaUploadMachine, { input: {} }).start();
    actor.send({
      type: 'SELECT_FILE',
      file: pngFile,
      targets: { personIds: ['per_henry'] },
      targetHasLiving: false,
    });
    const snap = await waitFor(actor, (s) => s.matches('complete'));
    expect(snap.context.mediaId).toBe('med_fetch_1');

    // Fetch 422 on upload
    fetchSpy.mockResolvedValueOnce(jsonResponse({ error: { message: 'Living person blocked' } }, 422));
    actor.send({
      type: 'SELECT_FILE',
      file: pngFile,
      targets: { personIds: ['per_henry'] },
      targetHasLiving: false,
    });
    const blocked = await waitFor(actor, (s) => s.matches('rejectedInvalid'));
    expect(blocked.context.rejectionReason).toBe('living_person_blocked');
    actor.stop();
  });
});
