import { describe, expect, it } from 'vitest';
import { RevisionRecordSchema } from '../schemas/revisions.js';
import {
  ALLOWED_AUDIO_VIDEO_MIMES,
  ALLOWED_MEDIA_MIMES,
  canAutoEnrollViaInvite,
  canCompleteAdminAuth,
  canCompleteMediaAttach,
  canCompleteMemberEditorAuth,
  deriveCitationBadge,
  type EntityLifecycleState,
  evaluateInviteStatus,
  hasLivingUploadTarget,
  hasPendingConflict,
  isAllowedMediaMime,
  isEditSummaryValid,
  isInviteActive,
  isMatchingSaveGeneration,
  isMatchingUploadGeneration,
  isWithinMediaSizeLimit,
  MAX_AUDIO_VIDEO_BYTES,
  MAX_IMAGE_BYTES,
  MAX_PDF_BYTES,
  rebaseEntityDraft,
  resolveCapabilities,
  transitionBatchRevertLifecycle,
  transitionEntityLifecycle,
  validateEntityDraft,
  validateMediaSelection,
} from './index.js';

describe('editorGuards (Machine 1)', () => {
  it('enforces minimum trimmed summary length of 3 characters', () => {
    expect(isEditSummaryValid('')).toBe(false);
    expect(isEditSummaryValid('   ')).toBe(false);
    expect(isEditSummaryValid(' ab ')).toBe(false);
    expect(isEditSummaryValid('fix')).toBe(true);
    expect(isEditSummaryValid('  Add 1880 census citation  ')).toBe(true);
  });

  it('catches same-entity ABA stale SAVE_OK counterexample via saveGen check', () => {
    // Generation 1 started on per_1, aborted via nav to per_2, returned to per_1, started generation 2.
    // Late SAVE_OK from generation 1 for per_1 must be rejected.
    expect(
      isMatchingSaveGeneration({
        activeEntityId: 'per_1',
        activeSaveGen: 2,
        responseEntityId: 'per_1',
        responseSaveGen: 1,
      })
    ).toBe(false);

    // Response for wrong entity with same generation is rejected.
    expect(
      isMatchingSaveGeneration({
        activeEntityId: 'per_1',
        activeSaveGen: 2,
        responseEntityId: 'per_2',
        responseSaveGen: 2,
      })
    ).toBe(false);

    // Matching entity and matching generation succeeds.
    expect(
      isMatchingSaveGeneration({
        activeEntityId: 'per_1',
        activeSaveGen: 2,
        responseEntityId: 'per_1',
        responseSaveGen: 2,
      })
    ).toBe(true);

    // Generation 0 (no active save) never matches.
    expect(
      isMatchingSaveGeneration({
        activeEntityId: 'per_1',
        activeSaveGen: 0,
        responseEntityId: 'per_1',
        responseSaveGen: 0,
      })
    ).toBe(false);
  });

  it('preserves pending conflict banner on leave-cancel via hasPendingConflict', () => {
    expect(hasPendingConflict(null)).toBe(false);
    expect(hasPendingConflict(undefined)).toBe(false);
    expect(
      hasPendingConflict({
        latestRevisionId: 44,
        latestSnapshot: { id: 'per_1', full_name: 'Arthur Alder' },
      })
    ).toBe(true);
  });

  it('derives Cited vs Family memory badge accurately', () => {
    expect(deriveCitationBadge({ hasPrimarySource: true })).toBe('Cited');
    expect(deriveCitationBadge({ hasPrimarySource: false, citationMode: 'cited' })).toBe('Cited');
    expect(deriveCitationBadge({ hasPrimarySource: false, sourceIds: ['src_1880'] })).toBe('Cited');
    expect(deriveCitationBadge({ hasPrimarySource: false, sourceIds: ['   '] })).toBe('Family memory');
    expect(deriveCitationBadge({ hasPrimarySource: false, citationMode: 'familyMemory' })).toBe(
      'Family memory'
    );
  });

  it('validates entity drafts with Zod and performs 3-way conflict rebase', () => {
    const valid = validateEntityDraft('source', {
      id: 'src_1',
      citation: '1880 Census',
      source_type: 'census',
    });
    expect(valid.ok).toBe(true);

    const invalid = validateEntityDraft('source', { id: '', citation: 123 });
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) {
      expect(invalid.errors.length).toBeGreaterThan(0);
    }

    const base = { id: 'per_1', full_name: 'Arthur Alder', birth_edtf: '1850', death_edtf: '1922' };
    const server = { id: 'per_1', full_name: 'Arthur Alder', birth_edtf: '1850-03-14', death_edtf: '1922' };
    const local = { id: 'per_1', full_name: 'Arthur W. Alder', birth_edtf: '1850', death_edtf: '1922' };
    expect(rebaseEntityDraft(base, server, local)).toEqual({
      id: 'per_1',
      full_name: 'Arthur W. Alder',
      birth_edtf: '1850-03-14',
      death_edtf: '1922',
    });
  });
});

describe('authGuards (Machine 2)', () => {
  it('blocks privilege escalation counterexample: non-member invite can NEVER complete admin auth', () => {
    expect(canCompleteAdminAuth(false, 'admin')).toBe(false);
    expect(canCompleteAdminAuth(true, 'editor')).toBe(false);
    expect(canCompleteAdminAuth(true, null)).toBe(false);
    expect(canCompleteAdminAuth(true, 'admin')).toBe(true);

    expect(canCompleteMemberEditorAuth(true, 'editor')).toBe(true);
    expect(canCompleteMemberEditorAuth(false, 'editor')).toBe(false);
    expect(canCompleteMemberEditorAuth(true, 'admin')).toBe(false);

    expect(canAutoEnrollViaInvite(false, true)).toBe(true);
    expect(canAutoEnrollViaInvite(false, false)).toBe(false);
    expect(canAutoEnrollViaInvite(true, true)).toBe(false);
  });

  it('classifies invite status for active, revoked, expired, and missing invites', () => {
    const now = '2026-11-24T12:00:00.000Z';
    expect(evaluateInviteStatus(null, now)).toBe('missing');
    expect(isInviteActive(null, now)).toBe(false);

    expect(evaluateInviteStatus({ revoked_at: '2026-11-24T11:00:00.000Z', expires_at: null }, now)).toBe(
      'revoked'
    );
    expect(isInviteActive({ revoked_at: '2026-11-24T11:00:00.000Z', expires_at: null }, now)).toBe(false);

    expect(evaluateInviteStatus({ revoked_at: null, expires_at: '2026-11-24T11:59:59.000Z' }, now)).toBe(
      'expired'
    );
    expect(isInviteActive({ revoked_at: null, expires_at: '2026-11-24T12:00:00.000Z' }, now)).toBe(false);

    expect(evaluateInviteStatus({ revoked_at: null, expires_at: '2026-12-01T00:00:00.000Z' }, now)).toBe(
      'active'
    );
    expect(isInviteActive({ revoked_at: null, expires_at: null }, now)).toBe(true);
  });

  it('resolves capabilities strictly per principal and role', () => {
    expect(resolveCapabilities({ authenticated: false, principal_kind: 'anonymous' })).toEqual({
      canEdit: false,
      canUploadMedia: false,
      hasRevisionHistory: false,
      hasTalk: false,
      canManageSite: false,
    });

    expect(
      resolveCapabilities({ authenticated: false, principal_kind: 'invite_viewer', role: 'viewer' })
    ).toEqual({
      canEdit: false,
      canUploadMedia: false,
      hasRevisionHistory: true,
      hasTalk: true,
      canManageSite: false,
    });

    expect(
      resolveCapabilities(
        { authenticated: true, principal_kind: 'user', role: 'editor' },
        { allowTalk: false }
      )
    ).toEqual({
      canEdit: true,
      canUploadMedia: true,
      hasRevisionHistory: true,
      hasTalk: false,
      canManageSite: false,
    });

    expect(resolveCapabilities({ authenticated: true, principal_kind: 'user', role: 'admin' })).toEqual({
      canEdit: true,
      canUploadMedia: true,
      hasRevisionHistory: true,
      hasTalk: true,
      canManageSite: true,
    });
  });
});

describe('uploadGuards (Machine 3)', () => {
  it('enforces MIME allowlist, size limits, and living-person upload restriction', () => {
    expect(ALLOWED_MEDIA_MIMES).toEqual(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']);
    expect(isAllowedMediaMime('image/jpeg')).toBe(true);
    expect(isAllowedMediaMime('IMAGE/PNG')).toBe(true);
    expect(isAllowedMediaMime('image/webp')).toBe(true);
    expect(isAllowedMediaMime('application/pdf')).toBe(true);
    expect(isAllowedMediaMime('image/svg+xml')).toBe(false);
    expect(isAllowedMediaMime('text/html')).toBe(false);

    expect(isWithinMediaSizeLimit('image/jpeg', MAX_IMAGE_BYTES)).toBe(true);
    expect(isWithinMediaSizeLimit('image/jpeg', MAX_IMAGE_BYTES + 1)).toBe(false);
    expect(isWithinMediaSizeLimit('application/pdf', MAX_PDF_BYTES)).toBe(true);
    expect(isWithinMediaSizeLimit('application/pdf', MAX_PDF_BYTES + 1)).toBe(false);
    expect(isWithinMediaSizeLimit('image/png', 0)).toBe(false);

    expect(
      validateMediaSelection({ mimeType: 'image/svg+xml', sizeBytes: 100, targetHasLiving: false })
    ).toMatchObject({ ok: false, reason: 'unsupported_mime' });
    expect(
      validateMediaSelection({ mimeType: 'image/png', sizeBytes: 0, targetHasLiving: false })
    ).toMatchObject({ ok: false, reason: 'empty_file' });
    expect(
      validateMediaSelection({
        mimeType: 'image/png',
        sizeBytes: MAX_IMAGE_BYTES + 1,
        targetHasLiving: false,
      })
    ).toMatchObject({ ok: false, reason: 'file_too_large' });
    expect(
      validateMediaSelection({ mimeType: 'image/jpeg', sizeBytes: 1024, targetHasLiving: true })
    ).toMatchObject({ ok: false, reason: 'living_person_blocked' });
    expect(
      validateMediaSelection({ mimeType: 'image/jpeg', sizeBytes: 1024, targetHasLiving: false })
    ).toEqual({ ok: true });

    // Video and audio MIME types are rejected by default and accepted when explicitly enabled
    expect(ALLOWED_AUDIO_VIDEO_MIMES).toEqual([
      'video/mp4',
      'video/webm',
      'audio/mpeg',
      'audio/mp4',
      'audio/ogg',
      'audio/wav',
    ]);
    expect(isAllowedMediaMime('video/mp4')).toBe(false);
    expect(isAllowedMediaMime('video/mp4', { allowAudioVideo: true })).toBe(true);
    expect(isAllowedMediaMime('audio/mpeg', { allowAudioVideo: true })).toBe(true);
    expect(isAllowedMediaMime('video/webm', { allowAudioVideo: true })).toBe(true);
    expect(isWithinMediaSizeLimit('video/mp4', MAX_AUDIO_VIDEO_BYTES)).toBe(true);
    expect(isWithinMediaSizeLimit('video/mp4', MAX_AUDIO_VIDEO_BYTES + 1)).toBe(false);
    expect(
      validateMediaSelection({ mimeType: 'video/mp4', sizeBytes: 4096, targetHasLiving: false })
    ).toMatchObject({ ok: false, reason: 'unsupported_mime' });
    expect(
      validateMediaSelection({
        mimeType: 'video/mp4',
        sizeBytes: 4096,
        targetHasLiving: false,
        allowAudioVideo: true,
      })
    ).toEqual({ ok: true });
    expect(
      validateMediaSelection({
        mimeType: 'audio/wav',
        sizeBytes: 4096,
        targetHasLiving: true,
        allowAudioVideo: true,
      })
    ).toMatchObject({ ok: false, reason: 'living_person_blocked' });
  });

  it('catches mid-upload living-person race and post-cancel ABA attach counterexamples', () => {
    const livingIds = new Set(['per_elena']);
    const eventsById = new Map([
      [
        'evt_shared',
        {
          id: 'evt_shared',
          participants: [
            { person_id: 'per_arthur', role: 'subject' },
            { person_id: 'per_elena', role: 'attendee' },
          ],
        },
      ],
    ]);

    expect(hasLivingUploadTarget({ personIds: ['per_elena'] }, livingIds)).toBe(true);
    expect(
      hasLivingUploadTarget({ personIds: ['per_arthur'], eventId: 'evt_shared' }, livingIds, eventsById)
    ).toBe(true);
    expect(hasLivingUploadTarget({ personIds: ['per_arthur'] }, livingIds, eventsById)).toBe(false);

    // Mid-upload race: person became living while file was uploading to R2
    expect(
      canCompleteMediaAttach({
        activeUploadGen: 1,
        eventUploadGen: 1,
        cancelled: false,
        targetHasLiving: false,
        targetBecameLiving: true,
      })
    ).toBe(false);

    // Cancelled upload or stale upload generation cannot complete attach
    expect(isMatchingUploadGeneration({ activeUploadGen: 2, eventUploadGen: 1, cancelled: false })).toBe(
      false
    );
    expect(
      canCompleteMediaAttach({
        activeUploadGen: 2,
        eventUploadGen: 2,
        cancelled: true,
        targetHasLiving: false,
        targetBecameLiving: false,
      })
    ).toBe(false);
    expect(
      canCompleteMediaAttach({
        activeUploadGen: 2,
        eventUploadGen: 2,
        cancelled: false,
        targetHasLiving: false,
        targetBecameLiving: false,
      })
    ).toBe(true);
  });
});

describe('entityLifecycle (Machine 4)', () => {
  const nowIso = '2026-11-24T12:00:00.000Z';

  it('enforces create, update, delete, restore, and rejects create on soft-deleted entity with 409', () => {
    // Non-existent rejects update/delete/restore with 404
    expect(
      transitionEntityLifecycle(
        { kind: 'nonExistent' },
        { type: 'update', expectedParentRevisionId: 1, data: { id: 'p1' }, summary: 'Update missing' },
        1
      )
    ).toEqual({ ok: false, status: 404, code: 'ENTITY_NOT_FOUND', currentRevisionId: null });

    // Create -> active (rev 1)
    const created = transitionEntityLifecycle(
      { kind: 'nonExistent' },
      {
        type: 'create',
        entityType: 'person',
        entityId: 'p1',
        data: { id: 'p1', full_name: 'Arthur Alder' },
        summary: 'Create Arthur',
      },
      1
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.nextState).toEqual({
      kind: 'active',
      currentRevisionId: 1,
      data: { id: 'p1', full_name: 'Arthur Alder' },
    });

    // Duplicate create on active -> 409
    expect(
      transitionEntityLifecycle(
        created.nextState,
        { type: 'create', entityType: 'person', entityId: 'p1', data: { id: 'p1' }, summary: 'Dup' },
        2
      )
    ).toEqual({ ok: false, status: 409, code: 'ENTITY_ALREADY_EXISTS', currentRevisionId: 1 });

    // Stale parent revision on update -> 409 without mutation
    expect(
      transitionEntityLifecycle(
        created.nextState,
        { type: 'update', expectedParentRevisionId: 99, data: { id: 'p1' }, summary: 'Stale' },
        2
      )
    ).toEqual({ ok: false, status: 409, code: 'REVISION_CONFLICT', currentRevisionId: 1 });

    // Valid delete -> softDeleted (rev 2)
    const deleted = transitionEntityLifecycle(
      created.nextState,
      { type: 'delete', expectedParentRevisionId: 1, summary: 'Duplicate record', nowIso },
      2
    );
    expect(deleted.ok).toBe(true);
    if (!deleted.ok) return;
    expect(deleted.nextState.kind).toBe('softDeleted');

    // Soft-deleted create bypass counterexample MUST be rejected with 409
    expect(
      transitionEntityLifecycle(
        deleted.nextState,
        {
          type: 'create',
          entityType: 'person',
          entityId: 'p1',
          data: { id: 'p1', full_name: 'Re-created' },
          summary: 'Bypass attempt',
        },
        3
      )
    ).toEqual({
      ok: false,
      status: 409,
      code: 'ENTITY_SOFT_DELETED_USE_RESTORE',
      currentRevisionId: 2,
    });

    // Restore with matching parent rev -> active (rev 3)
    const restored = transitionEntityLifecycle(
      deleted.nextState,
      { type: 'restore', expectedParentRevisionId: 2, summary: 'Restore Arthur' },
      3
    );
    expect(restored.ok).toBe(true);
    if (!restored.ok) return;
    expect(restored.nextState).toEqual({
      kind: 'active',
      currentRevisionId: 3,
      data: { id: 'p1', full_name: 'Arthur Alder' },
    });
  });

  it('catches forward-order batch revert resurrection counterexample by unwinding strictly in reverse order', () => {
    const createRev = RevisionRecordSchema.parse({
      revision_id: 1,
      batch_id: 'batch_ai_01',
      entity_type: 'person',
      entity_id: 'per_x',
      parent_revision_id: null,
      action: 'create',
      reverted_revision_id: null,
      author_id: 'agent_1',
      author_name: 'Research Agent',
      author_type: 'agent',
      summary: 'Create person_x',
      has_primary_source: true,
      before_json: null,
      after_json: { id: 'per_x', full_name: 'Thomas Alder' },
      created_at: nowIso,
    });

    const updateRev = RevisionRecordSchema.parse({
      revision_id: 2,
      batch_id: 'batch_ai_01',
      entity_type: 'person',
      entity_id: 'per_x',
      parent_revision_id: 1,
      action: 'update',
      reverted_revision_id: null,
      author_id: 'agent_1',
      author_name: 'Research Agent',
      author_type: 'agent',
      summary: 'Add birth year',
      has_primary_source: true,
      before_json: { id: 'per_x', full_name: 'Thomas Alder' },
      after_json: { id: 'per_x', full_name: 'Thomas Alder', birth_edtf: '1865' },
      created_at: nowIso,
    });

    const currentStates = new Map<string, EntityLifecycleState>([
      [
        'person:per_x',
        {
          kind: 'active',
          currentRevisionId: 2,
          data: { id: 'per_x', full_name: 'Thomas Alder', birth_edtf: '1865' },
        },
      ],
    ]);

    // Pass batch revisions in ascending order to prove function forces descending unwind
    const result = transitionBatchRevertLifecycle(currentStates, [createRev, updateRev], 3, {
      nowIso,
      summaryPrefix: 'Revert batch_ai_01',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Must unwind rev 2 first, then rev 1
    expect(result.steps.map((s) => s.revisionInsert.revertedRevisionId)).toEqual([2, 1]);
    expect(result.steps.map((s) => s.assignedRevisionId)).toEqual([3, 4]);
    expect(result.steps[0]?.nextState.kind).toBe('active');
    expect(result.steps[1]?.nextState.kind).toBe('softDeleted');
    expect(result.nextStatesByKey.get('person:per_x')?.kind).toBe('softDeleted');
  });
});
