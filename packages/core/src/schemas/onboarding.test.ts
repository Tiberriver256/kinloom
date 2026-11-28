import { describe, expect, it } from 'vitest';
import {
  applyOnboardingPatch,
  createDefaultOnboardingSessionResponse,
  createDefaultUserOnboardingState,
  isSafeInternalRoute,
  KinloomOnboardingStepSchema,
  OnboardingSessionResponseSchema,
  resolveOnboardingRole,
  toOnboardingSessionResponse,
  UpdateOnboardingStateRequestSchema,
  UserOnboardingStateSchema,
} from './onboarding.js';

describe('@kinloom/core onboarding schemas and domain reducers', () => {
  it('validates safe internal routes and rejects protocol or scheme injections', () => {
    expect(isSafeInternalRoute('/')).toBe(true);
    expect(isSafeInternalRoute('/tree')).toBe(true);
    expect(isSafeInternalRoute('/admin#invites')).toBe(true);
    expect(isSafeInternalRoute('/evidence?tab=citations')).toBe(true);

    expect(isSafeInternalRoute('//evil.example/path')).toBe(false);
    expect(isSafeInternalRoute('https://evil.example')).toBe(false);
    expect(isSafeInternalRoute('javascript:alert(1)')).toBe(false);
    expect(isSafeInternalRoute('/javascript:alert(1)')).toBe(false);
    expect(isSafeInternalRoute('/bad\\path')).toBe(false);
    expect(isSafeInternalRoute('tree')).toBe(false);
  });

  it('parses declarative step metadata and rejects unsafe routes or blank fields', () => {
    const valid = KinloomOnboardingStepSchema.parse({
      id: 'kinloom-recipes:add-card',
      title: 'Add a family recipe',
      description: 'Upload your first handwritten recipe card.',
      minRole: 'editor',
      order: 200,
      targetRoute: '/recipes/new',
      tutorialChapterId: 'kinloom-recipes:overview',
    });
    expect(valid.id).toBe('kinloom-recipes:add-card');

    expect(() =>
      KinloomOnboardingStepSchema.parse({
        id: 'kinloom-recipes:bad',
        title: '',
        description: 'desc',
      })
    ).toThrow();
    expect(() =>
      KinloomOnboardingStepSchema.parse({
        id: 'kinloom-recipes:bad-route',
        title: 'Title',
        description: 'desc',
        targetRoute: '//external.example',
      })
    ).toThrow();
  });

  it('maps session principals and capabilities to canonical onboarding roles', () => {
    expect(resolveOnboardingRole(null)).toBe('viewer');
    expect(resolveOnboardingRole({ principal_kind: 'anonymous' })).toBe('viewer');
    expect(resolveOnboardingRole({ principal_kind: 'invite_viewer', role: 'viewer' })).toBe('viewer');
    expect(resolveOnboardingRole({ principal_kind: 'user', role: 'editor' })).toBe('editor');
    expect(resolveOnboardingRole({ principal_kind: 'user', role: 'admin' })).toBe('admin');
    expect(resolveOnboardingRole({ principal_kind: 'anonymous' }, { canEdit: true })).toBe('editor');
    expect(resolveOnboardingRole({ principal_kind: 'anonymous' }, { canManageSite: true })).toBe('admin');
  });

  it('applies idempotent step/chapter unions, dismissals, visibility changes, and progress resets', () => {
    const t1 = '2026-11-27T10:00:00.000Z';
    const t2 = '2026-11-27T10:05:00.000Z';
    const t3 = '2026-11-27T10:10:00.000Z';
    const t4 = '2026-11-27T10:15:00.000Z';

    const initial = {
      state: createDefaultUserOnboardingState(null),
      first_login_pending: true,
    };
    expect(initial.state.checklist_visibility).toBe('collapsed');
    expect(toOnboardingSessionResponse(initial)).toEqual({
      state: initial.state,
      is_first_login: true,
      should_auto_open_tutorial_modal: true,
    });

    // Skip step A, complete step B
    const step1 = applyOnboardingPatch(
      initial,
      UpdateOnboardingStateRequestSchema.parse({
        skip_step_ids: ['core:viewer:open-tree'],
        complete_step_ids: ['core:viewer:read-dossier'],
        last_seen_version: '0.64.0',
      }),
      t1
    );
    expect(step1.state.completed_step_ids).toEqual(['core:viewer:read-dossier']);
    expect(step1.state.skipped_step_ids).toEqual(['core:viewer:open-tree']);
    expect(step1.state.last_seen_version).toBe('0.64.0');
    expect(step1.state.updated_at).toBe(t1);

    // Completing a previously skipped step moves it out of skipped; skipping a completed step is ignored
    const step2 = applyOnboardingPatch(
      step1,
      {
        complete_step_ids: ['core:viewer:open-tree', 'core:viewer:read-dossier'],
        skip_step_ids: ['core:viewer:read-dossier'],
        complete_chapter_ids: ['core-tree-pedigree'],
      },
      t2
    );
    expect(step2.state.completed_step_ids).toEqual(['core:viewer:open-tree', 'core:viewer:read-dossier']);
    expect(step2.state.skipped_step_ids).toEqual([]);
    expect(step2.state.completed_chapter_ids).toEqual(['core-tree-pedigree']);
    expect(step2.first_login_pending).toBe(false);
    expect(step2.state.tutorial_modal_dismissed_at).toBe(t2);
    expect(toOnboardingSessionResponse(step2).should_auto_open_tutorial_modal).toBe(false);

    // Dismiss checklist, then collapse, then dismiss via visibility
    const step3 = applyOnboardingPatch(step2, { dismiss_checklist: true }, t3);
    expect(step3.state.checklist_visibility).toBe('dismissed');
    expect(step3.state.checklist_dismissed_at).toBe(t3);

    const reopened = applyOnboardingPatch(step3, { checklist_visibility: 'collapsed' }, t3);
    expect(reopened.state.checklist_visibility).toBe('collapsed');
    expect(reopened.state.checklist_dismissed_at).toBeNull();

    const dismissedViaVis = applyOnboardingPatch(reopened, { checklist_visibility: 'dismissed' }, t3);
    expect(dismissedViaVis.state.checklist_visibility).toBe('dismissed');
    expect(dismissedViaVis.state.checklist_dismissed_at).toBe(t3);

    // Reset progress clears steps/chapters and reopens checklist, preserving tutorial_modal_dismissed_at
    const reset = applyOnboardingPatch(dismissedViaVis, { reset_progress: true }, t4);
    expect(reset.state.completed_step_ids).toEqual([]);
    expect(reset.state.skipped_step_ids).toEqual([]);
    expect(reset.state.completed_chapter_ids).toEqual([]);
    expect(reset.state.checklist_visibility).toBe('open');
    expect(reset.state.checklist_dismissed_at).toBeNull();
    expect(reset.state.tutorial_modal_dismissed_at).toBe(t2);

    // Explicit dismiss_tutorial_modal updates timestamp
    const explicitModalDismiss = applyOnboardingPatch(initial, { dismiss_tutorial_modal: true }, t4);
    expect(explicitModalDismiss.first_login_pending).toBe(false);
    expect(explicitModalDismiss.state.tutorial_modal_dismissed_at).toBe(t4);

    // Validate response schemas
    expect(OnboardingSessionResponseSchema.parse(createDefaultOnboardingSessionResponse())).toEqual(
      createDefaultOnboardingSessionResponse()
    );
    expect(UserOnboardingStateSchema.parse({}).checklist_visibility).toBe('collapsed');
  });
});
