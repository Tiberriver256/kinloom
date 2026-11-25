import type { ArchiveDataSource, EntityPayload } from '@kinloom/core';
import {
  type AttachActorOutcome,
  type AttachMediaActorInput,
  type HydrateOutcome,
  type SaveEntityInput,
  type SaveEntityResult,
  type UploadActorOutcome,
  type UploadMediaActorInput,
  type VerifyOutcome,
  authSessionMachine,
  deriveSessionFromAuthSnapshot,
  entityEditorMachine,
  mediaUploadMachine,
} from './index.js';
import { createActor, fromPromise, waitFor } from 'xstate';
import { describe, expect, it } from 'vitest';

const BASE_PERSON: EntityPayload = {
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
};

describe('entityEditorMachine', () => {
  it('blocks short summaries with validationError and saves valid edits', async () => {
    const machine = entityEditorMachine.provide({
      actors: {
        saveEntity: fromPromise<SaveEntityResult, SaveEntityInput>(async ({ input }) => ({
          kind: 'ok',
          entityId: input.entityId,
          revisionId: input.expectedParentRevisionId + 1,
          snapshot: input.draft,
          etag: `r${input.expectedParentRevisionId + 1}`,
          reqGen: input.reqGen,
        })),
      },
    });

    const actor = createActor(machine, {
      input: {
        entityType: 'person',
        entityId: 'p_clara',
        revisionId: 4,
        snapshot: BASE_PERSON,
      },
    });
    actor.start();

    actor.send({ type: 'START_EDIT' });
    actor.send({
      type: 'EDIT_FIELD',
      draft: { ...BASE_PERSON, full_name: 'Clarissa Harlowe Barton' },
    });
    actor.send({ type: 'SET_SUMMARY', summary: 'ok' });
    actor.send({ type: 'SUBMIT' });

    expect(actor.getSnapshot().value).toBe('validationError');
    expect(actor.getSnapshot().context.validationErrors[0]).toContain('at least 3 characters');

    actor.send({ type: 'SET_SUMMARY', summary: 'Add full given name from register' });
    actor.send({ type: 'SUBMIT' });

    const saved = await waitFor(actor, (s) => s.matches('saved'));
    expect(saved.context.baseRevisionId).toBe(5);
    expect(saved.context.baseSnapshot.full_name).toBe('Clarissa Harlowe Barton');
    expect(saved.context.dirty).toBe(false);
    actor.stop();
  });

  it('rejects ABA stale saveGen responses and aborts prior in-flight save signals', async () => {
    const signals: AbortSignal[] = [];
    let callCount = 0;

    const machine = entityEditorMachine.provide({
      actors: {
        saveEntity: fromPromise<SaveEntityResult, SaveEntityInput>(async ({ input, signal }) => {
          signals.push(signal);
          callCount += 1;
          if (callCount === 1) {
            return new Promise<SaveEntityResult>((resolve) => {
              // Simulate a slow network response that arrives after cancellation.
              setTimeout(() => {
                resolve({
                  kind: 'ok',
                  entityId: input.entityId,
                  revisionId: 99,
                  snapshot: { ...input.draft, full_name: 'STALE GEN 1' },
                  etag: 'r99',
                  reqGen: input.reqGen,
                });
              }, 30);
            });
          }
          // Return a deliberately mismatched stale reqGen to prove guard rejects it.
          return {
            kind: 'ok',
            entityId: input.entityId,
            revisionId: 77,
            snapshot: { ...input.draft, full_name: 'MISMATCHED GEN' },
            etag: 'r77',
            reqGen: input.reqGen - 1,
          };
        }),
      },
    });

    const actor = createActor(machine, {
      input: {
        entityType: 'person',
        entityId: 'p_clara',
        revisionId: 10,
        snapshot: BASE_PERSON,
      },
    });
    actor.start();

    actor.send({ type: 'START_EDIT' });
    actor.send({ type: 'EDIT_FIELD', draft: { ...BASE_PERSON, birth_edtf: '1821-12-25' } });
    actor.send({ type: 'SET_SUMMARY', summary: 'First save attempt' });
    actor.send({ type: 'SUBMIT' });
    expect(actor.getSnapshot().matches('saving')).toBe(true);
    expect(actor.getSnapshot().context.saveGen).toBe(1);

    // Cancel save 1 — XState aborts signal[0]
    actor.send({ type: 'CANCEL_SAVE' });
    expect(signals[0]?.aborted).toBe(true);
    expect(actor.getSnapshot().matches({ editing: 'dirty' })).toBe(true);

    // Trigger save 2 which receives a mismatched reqGen response -> must NOT enter saved
    actor.send({ type: 'SUBMIT' });
    const settled = await waitFor(actor, (s) => !s.matches('saving'));
    expect(settled.matches('saved')).toBe(false);
    expect(settled.matches({ editing: 'dirty' })).toBe(true);
    expect(settled.context.baseRevisionId).toBe(10);
    actor.stop();
  });

  it('handles 409 Conflict rebase-and-retry, accept-server, and preserves conflict on leave-cancel', async () => {
    let attempt = 0;
    const serverSnapshot: EntityPayload = {
      ...BASE_PERSON,
      alt_names: ['Angel of the Battlefield'],
    };

    const machine = entityEditorMachine.provide({
      actors: {
        saveEntity: fromPromise<SaveEntityResult, SaveEntityInput>(async ({ input }) => {
          attempt += 1;
          if (attempt === 1) {
            return {
              kind: 'conflict409',
              entityId: input.entityId,
              reqGen: input.reqGen,
              conflict: {
                latestRevisionId: 12,
                latestSnapshot: serverSnapshot,
                lastAuthorName: 'Archive Reviewer',
                lastUpdatedAt: '2026-11-24T12:00:00Z',
              },
            };
          }
          return {
            kind: 'ok',
            entityId: input.entityId,
            revisionId: 13,
            snapshot: input.draft,
            etag: 'r13',
            reqGen: input.reqGen,
          };
        }),
      },
    });

    const actor = createActor(machine, {
      input: {
        entityType: 'person',
        entityId: 'p_clara',
        revisionId: 10,
        snapshot: BASE_PERSON,
      },
    });
    actor.start();

    actor.send({ type: 'START_EDIT' });
    actor.send({
      type: 'EDIT_FIELD',
      draft: { ...BASE_PERSON, death_edtf: '1912-04-12' },
    });
    actor.send({ type: 'SET_SUMMARY', summary: 'Confirm exact death date' });
    actor.send({ type: 'SUBMIT' });

    const conflicted = await waitFor(actor, (s) =>
      s.matches({ conflict409: 'resolvingConflict' }),
    );
    expect(conflicted.context.dirty).toBe(true);
    expect(conflicted.context.conflict?.latestRevisionId).toBe(12);

    // Leave attempt during conflict -> STAY_EDITING must return to conflict409.resolvingConflict
    actor.send({
      type: 'ENTITY_CHANGED',
      entityType: 'person',
      entityId: 'p_other',
      revisionId: 1,
      snapshot: BASE_PERSON,
    });
    expect(actor.getSnapshot().matches('confirmingLeave')).toBe(true);

    actor.send({ type: 'STAY_EDITING' });
    expect(actor.getSnapshot().matches({ conflict409: 'resolvingConflict' })).toBe(true);

    // Rebase and retry merges server alt_names + local death_edtf and commits r13
    actor.send({ type: 'REBASE_AND_RETRY' });
    const saved = await waitFor(actor, (s) => s.matches('saved'));
    expect(saved.context.baseRevisionId).toBe(13);
    expect(saved.context.baseSnapshot.alt_names).toEqual(['Angel of the Battlefield']);
    expect(saved.context.baseSnapshot.death_edtf).toBe('1912-04-12');
    actor.stop();
  });
});

describe('authSessionMachine', () => {
  it('auto-enrolls invited non-member strictly as editor and never escalates to admin', async () => {
    const machine = authSessionMachine.provide({
      actors: {
        hydrateSession: fromPromise<HydrateOutcome, { inviteToken: string | null }>(async () => ({
          kind: 'invite_valid',
          token: 'inv_reunion_2026',
          label: 'Reunion invite',
        })),
        signInWithGoogle: fromPromise<VerifyOutcome, { inviteToken: string | null }>(async () => ({
          kind: 'verified',
          // Even if payload claims role: 'admin', non-member invite enrollment MUST stay editor!
          isMember: false,
          role: 'admin',
          email: 'cousin@example.com',
          displayName: 'Cousin Alex',
        })),
      },
    });

    const actor = createActor(machine, { input: { initialInviteToken: 'inv_reunion_2026' } });
    actor.start();

    const invited = await waitFor(actor, (s) => s.matches('readOnlyInvite'));
    expect(invited.context.pendingInviteToken).toBe('inv_reunion_2026');
    expect(deriveSessionFromAuthSnapshot(invited).capabilities.canEdit).toBe(false);

    actor.send({ type: 'SIGN_IN_GOOGLE' });
    const enrolled = await waitFor(actor, (s) => s.matches('authenticated'));
    expect(enrolled.matches({ authenticated: 'editor' })).toBe(true);
    expect(enrolled.matches({ authenticated: 'admin' })).toBe(false);
    expect(enrolled.context.pendingInviteToken).toBeNull();
    expect(enrolled.context.autoEnrolledViaInvite).toBe(true);
    expect(deriveSessionFromAuthSnapshot(enrolled).capabilities.canEdit).toBe(true);
    expect(deriveSessionFromAuthSnapshot(enrolled).capabilities.canManageSite).toBe(false);
    actor.stop();
  });

  it('transitions to inviteRevoked when invite is revoked mid-flight', async () => {
    const machine = authSessionMachine.provide({
      actors: {
        hydrateSession: fromPromise<HydrateOutcome, { inviteToken: string | null }>(async () => ({
          kind: 'invite_valid',
          token: 'inv_old',
          label: 'Old invite',
        })),
        requestMagicLink: fromPromise<
          void,
          { email: string; inviteToken: string | null; dataSource?: ArchiveDataSource }
        >(async () => {}),
        verifyMagicLink: fromPromise<VerifyOutcome, { token: string; inviteToken: string | null }>(
          async () => ({ kind: 'invite_revoked' }),
        ),
      },
    });

    const actor = createActor(machine, { input: { initialInviteToken: 'inv_old' } });
    actor.start();
    await waitFor(actor, (s) => s.matches('readOnlyInvite'));

    actor.send({ type: 'REQUEST_MAGIC_LINK', email: 'relative@example.com' });
    await waitFor(actor, (s) => s.matches('awaitingMagicLinkClick'));

    actor.send({ type: 'OPEN_MAGIC_LINK', token: 'ml_token' });
    const revoked = await waitFor(actor, (s) => s.matches('inviteRevoked'));
    expect(revoked.context.pendingInviteToken).toBeNull();
    expect(deriveSessionFromAuthSnapshot(revoked).capabilities.canEdit).toBe(false);
    actor.stop();
  });
});

describe('mediaUploadMachine', () => {
  it('blocks living-person media on client validation without hitting network', async () => {
    let networkCalled = false;
    const machine = mediaUploadMachine.provide({
      actors: {
        hashFileSha256: fromPromise(async () => 'a'.repeat(64)),
        uploadMedia: fromPromise<UploadActorOutcome, UploadMediaActorInput>(async ({ input }) => {
          networkCalled = true;
          return { kind: 'uploaded', uploadGen: input.uploadGen, r2Key: 'media/a.jpg' };
        }),
      },
    });

    const actor = createActor(machine, { input: {} });
    actor.start();

    const file = new File(['abc'], 'portrait.jpg', { type: 'image/jpeg' });
    actor.send({
      type: 'SELECT_FILE',
      file,
      targets: { personIds: ['p_living'] },
      targetHasLiving: true,
    });

    const rejected = actor.getSnapshot();
    expect(rejected.matches('rejectedInvalid')).toBe(true);
    expect(rejected.context.rejectionReason).toBe('living_person_blocked');
    expect(networkCalled).toBe(false);
    actor.stop();
  });

  it('rejects HTTP 422 LIVING_MEDIA_FORBIDDEN returned by server during upload or mid-upload attach', async () => {
    const machine = mediaUploadMachine.provide({
      actors: {
        hashFileSha256: fromPromise(async () => 'b'.repeat(64)),
        uploadMedia: fromPromise<UploadActorOutcome, UploadMediaActorInput>(async ({ input }) => ({
          kind: 'living_blocked',
          uploadGen: input.uploadGen,
          message: 'HTTP 422 LIVING_MEDIA_FORBIDDEN',
        })),
      },
    });

    const actor = createActor(machine, { input: {} });
    actor.start();

    const file = new File(['abc'], 'scan.png', { type: 'image/png' });
    actor.send({
      type: 'SELECT_FILE',
      file,
      targets: { personIds: ['p_became_living'] },
      targetHasLiving: false,
    });

    const rejected = await waitFor(actor, (s) => s.matches('rejectedInvalid'));
    expect(rejected.context.rejectionReason).toBe('living_person_blocked');
    expect(rejected.context.rejectionMessage).toContain('LIVING_MEDIA_FORBIDDEN');
    actor.stop();
  });

  it('retries attaching idempotently without re-uploading to R2 and aborts on CANCEL', async () => {
    let uploadCalls = 0;
    let attachCalls = 0;
    const machine = mediaUploadMachine.provide({
      actors: {
        hashFileSha256: fromPromise(async () => 'c'.repeat(64)),
        uploadMedia: fromPromise<UploadActorOutcome, UploadMediaActorInput>(async ({ input }) => {
          uploadCalls += 1;
          return { kind: 'uploaded', uploadGen: input.uploadGen, r2Key: 'media/ccc.mp4' };
        }),
        attachMedia: fromPromise<AttachActorOutcome, AttachMediaActorInput>(async ({ input }) => {
          attachCalls += 1;
          if (attachCalls === 1) {
            throw new Error('Temporary D1 timeout');
          }
          return {
            kind: 'attached',
            uploadGen: input.uploadGen,
            mediaId: 'med_video_1',
            targetBecameLiving: false,
          };
        }),
      },
    });

    const actor = createActor(machine, { input: { allowAudioVideo: true } });
    actor.start();

    const file = new File(['video-bytes'], 'oral-story.mp4', { type: 'video/mp4' });
    actor.send({
      type: 'SELECT_FILE',
      file,
      targets: { personIds: ['p_clara'] },
      targetHasLiving: false,
    });

    const failed = await waitFor(actor, (s) => s.matches('failedRetryable'));
    expect(failed.context.r2Key).toBe('media/ccc.mp4');
    expect(uploadCalls).toBe(1);
    expect(attachCalls).toBe(1);

    actor.send({ type: 'RETRY' });
    const done = await waitFor(actor, (s) => s.matches('complete'));
    expect(done.context.mediaId).toBe('med_video_1');
    expect(uploadCalls).toBe(1);
    expect(attachCalls).toBe(2);
    actor.stop();
  });
});
