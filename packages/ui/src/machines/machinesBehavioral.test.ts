import type {
  ArchiveDataSource,
  ArchiveSessionState,
  MediaItem,
  OptimisticConflictError,
  RevisionRecord,
} from '@kinloom/core';
import { asRevisionId } from '@kinloom/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createActor, fromPromise, waitFor } from 'xstate';
import { ApiClientError } from '../adapters/httpWikiDataSource.js';
import {
  authSessionMachine,
  deriveSessionFromAuthSnapshot,
  type VerifyOutcome,
} from './authSessionMachine.js';
import { entityEditorMachine } from './entityEditorMachine.js';
import { mediaUploadMachine } from './mediaUploadMachine.js';

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

    // Missing or failing dataSource hydration falls back cleanly to anonymous
    const failingDs = {
      getSession: async () => {
        throw new Error('offline');
      },
    } as unknown as ArchiveDataSource;

    const a1 = createActor(authSessionMachine, { input: {} }).start();
    const s1 = await waitFor(a1, (s) => s.matches('anonymous'));
    expect(s1.matches('anonymous')).toBe(true);
    a1.stop();

    const a2 = createActor(authSessionMachine, { input: { dataSource: failingDs } }).start();
    const s2 = await waitFor(a2, (s) => s.matches('anonymous'));
    expect(s2.matches('anonymous')).toBe(true);
    a2.stop();

    // Synchronous initialSession hydration skips async invoke
    const a3 = createActor(authSessionMachine, {
      input: {
        initialSession: {
          authenticated: true,
          principal_kind: 'user',
          email: 'initial@example.test',
          displayName: 'Initial Admin',
          role: 'admin',
        },
      },
    }).start();
    expect(a3.getSnapshot().matches({ authenticated: 'admin' })).toBe(true);
    expect(a3.getSnapshot().context.email).toBe('initial@example.test');
    a3.stop();
  });

  it('handles Google sign-in, magic link request/verify/cancel/resend, invite auto-enroll, revocation, and session expiry', async () => {
    const googleQueue: Array<() => Promise<VerifyOutcome>> = [
      async () => ({ kind: 'invalid', message: 'This email is not enrolled in this family archive.' }),
      async () => {
        throw new Error('HTTP 500 verifying Google sign-in');
      },
      async () => ({
        kind: 'verified',
        isMember: false,
        role: 'editor',
        email: 'cousin@example.test',
        displayName: 'Cousin Mercer',
      }),
    ];
    let magicLinkFailsOnce = true;
    const ds = {
      getSession: async () => ({
        session: { authenticated: false, principal_kind: 'anonymous' as const },
        capabilities: {
          canEdit: false,
          canUploadMedia: false,
          hasRevisionHistory: false,
          hasTalk: false,
          canManageSite: false,
        },
      }),
      requestMagicLink: async () => {
        if (magicLinkFailsOnce) {
          magicLinkFailsOnce = false;
          throw new Error('HTTP 503 requesting magic link');
        }
        return { sent: true };
      },
    } as unknown as ArchiveDataSource;

    const testMachine = authSessionMachine.provide({
      actors: {
        signInWithGoogle: fromPromise<VerifyOutcome, { inviteToken: string | null }>(async () => {
          const next = googleQueue.shift();
          return next ? next() : { kind: 'invalid', message: 'Unexpected call' };
        }),
        verifyMagicLink: fromPromise<VerifyOutcome, { token: string; inviteToken: string | null }>(
          async () => ({
            kind: 'verified',
            isMember: true,
            role: 'admin',
            email: 'admin@example.test',
            displayName: 'Admin Alder',
          })
        ),
      },
    });

    const actor = createActor(testMachine, { input: { dataSource: ds } }).start();
    await waitFor(actor, (s) => s.matches('anonymous'));

    // Open revoked invite -> inviteRevoked -> dismiss -> anonymous
    actor.send({ type: 'OPEN_INVITE', token: 'tok-bad', label: 'Old', revoked: true });
    expect(actor.getSnapshot().matches('inviteRevoked')).toBe(true);
    actor.send({ type: 'DISMISS_INVITE' });
    expect(actor.getSnapshot().matches('anonymous')).toBe(true);

    // Open valid invite -> readOnlyInvite
    actor.send({ type: 'OPEN_INVITE', token: 'tok-ok', label: 'Cousin Link', revoked: false });
    expect(actor.getSnapshot().matches('readOnlyInvite')).toBe(true);

    // Google sign-in invalid -> returns to readOnlyInvite with error
    actor.send({ type: 'SIGN_IN_GOOGLE' });
    let snap = await waitFor(actor, (s) => s.matches('readOnlyInvite'));
    expect(snap.context.authError).toContain('not enrolled');

    // Google sign-in 500 error -> returns to readOnlyInvite with error
    actor.send({ type: 'SIGN_IN_GOOGLE' });
    snap = await waitFor(actor, (s) => s.matches('readOnlyInvite'));
    expect(snap.context.authError).toContain('500');

    // Google sign-in auto-enrolls via invite -> authenticated.editor
    actor.send({ type: 'SIGN_IN_GOOGLE' });
    snap = await waitFor(actor, (s) => s.matches({ authenticated: 'editor' }));
    expect(snap.context.autoEnrolledViaInvite).toBe(true);

    // Session expires -> sessionExpired -> sign out -> anonymous
    actor.send({ type: 'SESSION_EXPIRED' });
    expect(actor.getSnapshot().matches('sessionExpired')).toBe(true);
    actor.send({ type: 'SIGN_OUT' });
    expect(actor.getSnapshot().matches('anonymous')).toBe(true);

    // Magic link request failure -> anonymous with error
    actor.send({ type: 'REQUEST_MAGIC_LINK', email: 'henry@example.test' });
    snap = await waitFor(actor, (s) => s.matches('anonymous'));
    expect(snap.context.authError).toContain('503');

    // Magic link request success -> awaitingMagicLinkClick -> resend -> cancel -> verify admin
    actor.send({ type: 'REQUEST_MAGIC_LINK', email: 'henry@example.test' });
    await waitFor(actor, (s) => s.matches('awaitingMagicLinkClick'));

    actor.send({ type: 'RESEND_MAGIC_LINK', email: 'henry@example.test' });
    await waitFor(actor, (s) => s.matches('awaitingMagicLinkClick'));

    // Cancel magic link -> anonymous
    actor.send({ type: 'CANCEL_MAGIC_LINK' });
    expect(actor.getSnapshot().matches('anonymous')).toBe(true);

    // Request again and verify as admin
    actor.send({ type: 'REQUEST_MAGIC_LINK', email: 'admin@example.test' });
    await waitFor(actor, (s) => s.matches('awaitingMagicLinkClick'));

    actor.send({ type: 'OPEN_MAGIC_LINK', token: 'ml-admin' });
    snap = await waitFor(actor, (s) => s.matches({ authenticated: 'admin' }));
    expect(snap.context.role).toBe('admin');

    // Sign out from authenticated
    actor.send({ type: 'SIGN_OUT' });
    expect(actor.getSnapshot().matches('anonymous')).toBe(true);
    actor.stop();
  });

  it('handles magic link invalid/revoked responses and invite leave/revocation', async () => {
    const ds = {
      getSession: async () => ({
        session: { authenticated: false, principal_kind: 'anonymous' as const },
        capabilities: {
          canEdit: false,
          canUploadMedia: false,
          hasRevisionHistory: false,
          hasTalk: false,
          canManageSite: false,
        },
      }),
      requestMagicLink: async () => ({ sent: true }),
    } as unknown as ArchiveDataSource;

    const testMachine = authSessionMachine.provide({
      actors: {
        verifyMagicLink: fromPromise<VerifyOutcome, { token: string; inviteToken: string | null }>(
          async ({ input }) => {
            if (input.token === 'expired') {
              return { kind: 'invalid', message: 'Magic link is invalid or expired.' };
            }
            return {
              kind: 'verified',
              isMember: true,
              role: 'editor',
              email: 'ed@example.test',
              displayName: 'Ed Alder',
            };
          }
        ),
      },
    });

    const actor = createActor(testMachine, { input: { dataSource: ds } }).start();
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

    // Magic link verify returns invalid -> anonymous
    actor.send({ type: 'REQUEST_MAGIC_LINK', email: 'ed@example.test' });
    await waitFor(actor, (s) => s.matches('awaitingMagicLinkClick'));

    actor.send({ type: 'OPEN_MAGIC_LINK', token: 'expired' });
    const snap = await waitFor(actor, (s) => s.matches('anonymous'));
    expect(snap.context.authError).toContain('expired');

    // Magic link verify returns member editor
    actor.send({ type: 'REQUEST_MAGIC_LINK', email: 'ed@example.test' });
    await waitFor(actor, (s) => s.matches('awaitingMagicLinkClick'));
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

  it('exercises ArchiveDataSource save path for 409 conflict + ACCEPT_SERVER and 200 OK', async () => {
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

    let saveAttempt = 0;
    const ds = {
      updateEntity: async () => {
        saveAttempt += 1;
        if (saveAttempt === 1) {
          return {
            ok: false as const,
            conflict: {
              kind: 'conflict' as const,
              entity_type: 'person' as const,
              entity_id: 'per_clara',
              expected_parent_revision_id: asRevisionId(1),
              server_revision_id: asRevisionId(4),
              server_entity: { ...basePerson, full_name: 'Clara M. Alder' },
              server_deleted_at: null,
              last_author_name: 'Founder',
              last_updated_at: '2026-06-02T00:00:00Z',
              diff: { fields: [], addedCount: 0, removedCount: 0, changedCount: 1, hasChanges: true },
            },
          };
        }
        return {
          ok: true as const,
          entity: { ...basePerson, full_name: 'Clara M. Alder', death_edtf: '1940' },
          revision: { revision_id: asRevisionId(5) } as unknown as RevisionRecord,
          etag: '"r5"',
        };
      },
    } as unknown as ArchiveDataSource;

    const actor = createActor(entityEditorMachine, {
      input: {
        entityType: 'person',
        entityId: 'per_clara',
        revisionId: 1,
        snapshot: basePerson,
        dataSource: ds,
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

  it('exercises structural ArchiveApiErrorShape 422 living-block and missing-dataSource rejection in mediaUploadMachine', async () => {
    const pngFile = new File([new Uint8Array([1, 2, 3, 4])], 'mill.png', { type: 'image/png' });
    let call = 0;
    const ds = {
      uploadMedia: async () => {
        call += 1;
        if (call === 1) {
          return {
            media: {
              id: 'med_port_1',
              kind: 'family_photo',
              file: '/media/mill.png',
              caption: 'Mill',
            } as unknown as MediaItem,
            url: '/media/mill.png',
            revision: { revision_id: asRevisionId(3) } as unknown as RevisionRecord,
            etag: '"r3"',
          };
        }
        throw {
          status: 422,
          code: 'PRIVACY_VIOLATION',
          message: 'Living person blocked',
        };
      },
    } as unknown as ArchiveDataSource;

    const actor = createActor(mediaUploadMachine, { input: { dataSource: ds } }).start();
    actor.send({
      type: 'SELECT_FILE',
      file: pngFile,
      targets: { personIds: ['per_henry'] },
      targetHasLiving: false,
    });
    const snap = await waitFor(actor, (s) => s.matches('complete'));
    expect(snap.context.mediaId).toBe('med_port_1');

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
