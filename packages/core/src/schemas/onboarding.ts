import { z } from 'zod';

export const OnboardingRoleSchema = z.enum(['viewer', 'editor', 'admin']);
export type OnboardingRole = z.infer<typeof OnboardingRoleSchema>;

/**
 * Discriminated visibility state for the inline onboarding checklist.
 */
export const ChecklistVisibilitySchema = z.enum(['open', 'collapsed', 'dismissed']);
export type ChecklistVisibility = z.infer<typeof ChecklistVisibilitySchema>;

export const OnboardingStepIdSchema = z.string().trim().min(1).max(120);

export function isSafeInternalRoute(route: string): boolean {
  const trimmed = route.trim();
  if (!trimmed.startsWith('/') || trimmed.startsWith('//') || trimmed.includes('\\')) {
    return false;
  }
  const lower = trimmed.toLowerCase();
  return !lower.startsWith('/javascript:') && !lower.includes('\u0000');
}

export const KinloomOnboardingStepSchema = z
  .object({
    id: OnboardingStepIdSchema,
    title: z.string().trim().min(1).max(100),
    description: z.string().trim().min(1).max(280),
    minRole: OnboardingRoleSchema.optional(),
    roles: z.array(OnboardingRoleSchema).min(1).optional(),
    order: z.number().finite().optional(),
    targetRoute: z
      .string()
      .trim()
      .min(1)
      .refine(isSafeInternalRoute, 'targetRoute must be a safe internal path starting with "/".')
      .optional(),
    tutorialChapterId: z.string().trim().min(1).max(120).optional(),
  })
  .strict();
export type KinloomOnboardingStepMetadata = z.infer<typeof KinloomOnboardingStepSchema>;

/**
 * Shared persisted progress record unifying onboarding steps (#54) and tutorial chapters (#53).
 */
export const UserOnboardingStateSchema = z.object({
  schema_version: z.number().int().positive().default(1),
  checklist_visibility: ChecklistVisibilitySchema.default('open'),
  completed_step_ids: z.array(OnboardingStepIdSchema).default([]),
  skipped_step_ids: z.array(OnboardingStepIdSchema).default([]),
  completed_chapter_ids: z.array(OnboardingStepIdSchema).default([]),
  tutorial_modal_dismissed_at: z.string().min(1).nullable().default(null),
  checklist_dismissed_at: z.string().min(1).nullable().default(null),
  last_seen_version: z.string().min(1).max(64).nullable().default(null),
  updated_at: z.string().min(1).nullable().default(null),
});
export type UserOnboardingState = z.infer<typeof UserOnboardingStateSchema>;

export const OnboardingSessionResponseSchema = z.object({
  state: UserOnboardingStateSchema,
  is_first_login: z.boolean(),
  should_auto_open_tutorial_modal: z.boolean(),
});
export type OnboardingSessionResponse = z.infer<typeof OnboardingSessionResponseSchema>;

export const UpdateOnboardingStateRequestSchema = z
  .object({
    checklist_visibility: ChecklistVisibilitySchema.optional(),
    complete_step_ids: z.array(OnboardingStepIdSchema).max(50).optional(),
    skip_step_ids: z.array(OnboardingStepIdSchema).max(50).optional(),
    complete_chapter_ids: z.array(OnboardingStepIdSchema).max(50).optional(),
    dismiss_tutorial_modal: z.boolean().optional(),
    dismiss_checklist: z.boolean().optional(),
    reset_progress: z.boolean().optional(),
    last_seen_version: z.string().trim().min(1).max(64).optional(),
  })
  .strict();
export type UpdateOnboardingStateRequest = z.infer<typeof UpdateOnboardingStateRequestSchema>;

export interface OnboardingSessionLike {
  readonly principal_kind?: 'anonymous' | 'invite_viewer' | 'user';
  readonly role?: 'admin' | 'editor' | 'viewer';
}

export interface OnboardingCapabilitiesLike {
  readonly canEdit?: boolean;
  readonly canManageSite?: boolean;
}

export function createDefaultUserOnboardingState(updatedAt: string | null = null): UserOnboardingState {
  return {
    schema_version: 1,
    checklist_visibility: 'open',
    completed_step_ids: [],
    skipped_step_ids: [],
    completed_chapter_ids: [],
    tutorial_modal_dismissed_at: null,
    checklist_dismissed_at: null,
    last_seen_version: null,
    updated_at: updatedAt,
  };
}

export function toOnboardingSessionResponse(record: {
  readonly state: UserOnboardingState;
  readonly first_login_pending: boolean;
}): OnboardingSessionResponse {
  return {
    state: record.state,
    is_first_login: record.first_login_pending,
    should_auto_open_tutorial_modal:
      record.first_login_pending && record.state.tutorial_modal_dismissed_at === null,
  };
}

export function createDefaultOnboardingSessionResponse(): OnboardingSessionResponse {
  return toOnboardingSessionResponse({
    state: createDefaultUserOnboardingState(null),
    first_login_pending: false,
  });
}

export function resolveOnboardingRole(
  session: OnboardingSessionLike | null | undefined,
  capabilities?: OnboardingCapabilitiesLike | null
): OnboardingRole {
  if ((session?.principal_kind === 'user' && session.role === 'admin') || capabilities?.canManageSite) {
    return 'admin';
  }
  if ((session?.principal_kind === 'user' && session.role === 'editor') || capabilities?.canEdit) {
    return 'editor';
  }
  return 'viewer';
}

function mergeUniqueIds(existing: readonly string[], incoming: readonly string[] | undefined): string[] {
  const set = new Set<string>(existing);
  if (incoming) {
    for (const raw of incoming) {
      const trimmed = raw.trim();
      if (trimmed.length > 0) {
        set.add(trimmed);
      }
    }
  }
  return [...set].toSorted((a, b) => a.localeCompare(b));
}

export function applyOnboardingPatch(
  current: {
    readonly state: UserOnboardingState;
    readonly first_login_pending: boolean;
  },
  patch: UpdateOnboardingStateRequest,
  nowIso: string
): {
  readonly state: UserOnboardingState;
  readonly first_login_pending: boolean;
} {
  let firstLoginPending = current.first_login_pending;
  let checklistVisibility: ChecklistVisibility = current.state.checklist_visibility;
  let completedStepIds: string[] = [...current.state.completed_step_ids];
  let skippedStepIds: string[] = [...current.state.skipped_step_ids];
  let completedChapterIds: string[] = [...current.state.completed_chapter_ids];
  let tutorialModalDismissedAt: string | null = current.state.tutorial_modal_dismissed_at;
  let checklistDismissedAt: string | null = current.state.checklist_dismissed_at;
  let lastSeenVersion: string | null = current.state.last_seen_version;

  if (patch.reset_progress) {
    completedStepIds = [];
    skippedStepIds = [];
    completedChapterIds = [];
    checklistDismissedAt = null;
    checklistVisibility = 'open';
  }

  if (patch.complete_step_ids && patch.complete_step_ids.length > 0) {
    completedStepIds = mergeUniqueIds(completedStepIds, patch.complete_step_ids);
    const completedSet = new Set(completedStepIds);
    skippedStepIds = skippedStepIds.filter((id) => !completedSet.has(id));
  }

  if (patch.skip_step_ids && patch.skip_step_ids.length > 0) {
    const completedSet = new Set(completedStepIds);
    const eligibleSkips = patch.skip_step_ids.filter((id) => !completedSet.has(id.trim()));
    skippedStepIds = mergeUniqueIds(skippedStepIds, eligibleSkips);
  }

  if (patch.complete_chapter_ids && patch.complete_chapter_ids.length > 0) {
    completedChapterIds = mergeUniqueIds(completedChapterIds, patch.complete_chapter_ids);
    firstLoginPending = false;
    if (tutorialModalDismissedAt === null) {
      tutorialModalDismissedAt = nowIso;
    }
  }

  if (patch.dismiss_tutorial_modal) {
    firstLoginPending = false;
    tutorialModalDismissedAt = nowIso;
  }

  if (patch.dismiss_checklist) {
    checklistVisibility = 'dismissed';
    checklistDismissedAt = nowIso;
  }

  if (patch.checklist_visibility !== undefined) {
    checklistVisibility = patch.checklist_visibility;
    if (patch.checklist_visibility === 'dismissed') {
      checklistDismissedAt = checklistDismissedAt ?? nowIso;
    } else {
      checklistDismissedAt = null;
    }
  }

  if (patch.last_seen_version !== undefined) {
    lastSeenVersion = patch.last_seen_version;
  }

  return {
    first_login_pending: firstLoginPending,
    state: {
      schema_version: current.state.schema_version,
      checklist_visibility: checklistVisibility,
      completed_step_ids: completedStepIds,
      skipped_step_ids: skippedStepIds,
      completed_chapter_ids: completedChapterIds,
      tutorial_modal_dismissed_at: tutorialModalDismissedAt,
      checklist_dismissed_at: checklistDismissedAt,
      last_seen_version: lastSeenVersion,
      updated_at: nowIso,
    },
  };
}
