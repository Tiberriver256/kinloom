import {
  type ArchiveBundle,
  type OnboardingRole,
  type Person,
  type UserOnboardingState,
  UserOnboardingStateSchema,
} from '@kinloom/core';
import type {
  KinloomOnboardingContext,
  KinloomOnboardingStep,
  KinloomOnboardingStepAction,
} from '../plugins/types.js';

export const MAX_VISIBLE_ONBOARDING_STEPS = 5;
export const ONBOARDING_STORAGE_KEY_PREFIX = 'kinloom.onboarding.v1:';

export type OnboardingStepStatus = 'pending' | 'completed' | 'skipped';

export interface ResolvedOnboardingStep {
  readonly step: KinloomOnboardingStep;
  readonly source: 'core' | 'plugin';
  readonly pluginId?: string;
  readonly status: OnboardingStepStatus;
  readonly isAutoCompleted: boolean;
  readonly resolvedAction: KinloomOnboardingStepAction | null;
}

export interface OnboardingChecklistViewModel {
  readonly role: OnboardingRole;
  readonly items: readonly ResolvedOnboardingStep[];
  readonly primaryItems: readonly ResolvedOnboardingStep[];
  readonly overflowPluginItems: readonly ResolvedOnboardingStep[];
  readonly completedCount: number;
  readonly resolvedCount: number;
  readonly totalCount: number;
  readonly allResolved: boolean;
  readonly percentComplete: number;
  readonly showInviteRetentionNote: boolean;
}

export type OnboardingClientSignal =
  | 'tree_focus'
  | 'person_visit'
  | 'map_or_time_interact'
  | 'tutorial_open'
  | 'entity_saved'
  | 'source_read'
  | 'media_uploaded'
  | 'changes_visit'
  | 'admin_diagnostics_healthy'
  | 'admin_invite_created'
  | 'admin_settings_or_token_saved';

const ROLE_RANK: Readonly<Record<OnboardingRole, number>> = {
  viewer: 0,
  editor: 1,
  admin: 2,
};

const SIGNAL_TO_CORE_STEP_BY_ROLE: Readonly<
  Record<OnboardingRole, Partial<Record<OnboardingClientSignal, string>>>
> = {
  viewer: {
    tree_focus: 'core:viewer:open-tree',
    person_visit: 'core:viewer:read-dossier',
    map_or_time_interact: 'core:viewer:explore-map-time',
    tutorial_open: 'core:viewer:open-tutorials',
  },
  editor: {
    entity_saved: 'core:editor:first-person-or-edit',
    source_read: 'core:editor:cite-source',
    media_uploaded: 'core:editor:upload-scan',
    changes_visit: 'core:editor:review-changes',
  },
  admin: {
    admin_diagnostics_healthy: 'core:admin:verify-diagnostics',
    admin_invite_created: 'core:admin:create-invite',
    admin_settings_or_token_saved: 'core:admin:configure-plugins-backups',
  },
};

export function resolveOnboardingSignalStepId(
  signal: OnboardingClientSignal,
  role: OnboardingRole
): string | null {
  return SIGNAL_TO_CORE_STEP_BY_ROLE[role][signal] ?? null;
}

export function buildOnboardingStorageKey(origin: string): string {
  const normalized = origin.trim() || 'default';
  return `${ONBOARDING_STORAGE_KEY_PREFIX}${normalized}`;
}

export function parseStoredOnboardingState(raw: string | null): UserOnboardingState | null {
  if (!raw) {
    return null;
  }
  try {
    const parsedJson: unknown = JSON.parse(raw);
    const result = UserOnboardingStateSchema.safeParse(parsedJson);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

export function isStepVisibleForRole(
  step: Pick<KinloomOnboardingStep, 'minRole' | 'roles'>,
  role: OnboardingRole
): boolean {
  if (step.roles && step.roles.length > 0) {
    return step.roles.includes(role);
  }
  const minRole = step.minRole ?? 'viewer';
  return ROLE_RANK[role] >= ROLE_RANK[minRole];
}

function isPublicDeceasedPerson(person: Person): boolean {
  return !person.is_living && person.full_name !== 'Living';
}

export function pickFeaturedDossierPerson(bundle: ArchiveBundle | null): Person | null {
  if (!bundle || bundle.people.length === 0) {
    return null;
  }
  const narrativePersonIds = new Set<string>();
  for (const narrative of bundle.narratives ?? []) {
    if (narrative.subject_person_id) {
      narrativePersonIds.add(narrative.subject_person_id);
    }
    for (const pid of narrative.person_ids) {
      narrativePersonIds.add(pid);
    }
  }
  const publicDeceased = bundle.people.filter(isPublicDeceasedPerson);
  if (publicDeceased.length === 0) {
    return null;
  }
  return (
    publicDeceased.toSorted((a, b) => {
      const aRich = ((a.media_count ?? 0) > 0 ? 2 : 0) + (narrativePersonIds.has(a.id) ? 2 : 0);
      const bRich = ((b.media_count ?? 0) > 0 ? 2 : 0) + (narrativePersonIds.has(b.id) ? 2 : 0);
      if (bRich !== aRich) {
        return bRich - aRich;
      }
      if (b.event_count !== a.event_count) {
        return b.event_count - a.event_count;
      }
      return a.full_name.localeCompare(b.full_name);
    })[0] ?? null
  );
}

export function hasGeocodedArchiveStops(bundle: ArchiveBundle | null): boolean {
  if (!bundle || bundle.places.length === 0 || bundle.events.length === 0) {
    return false;
  }
  const geocodedPlaceIds = new Set<string>();
  for (const place of bundle.places) {
    if (Number.isFinite(place.lat) && Number.isFinite(place.lng)) {
      geocodedPlaceIds.add(place.id);
    }
  }
  return bundle.events.some(
    (event) => typeof event.place_id === 'string' && geocodedPlaceIds.has(event.place_id)
  );
}

export function buildCoreOnboardingSteps(ctx: KinloomOnboardingContext): readonly KinloomOnboardingStep[] {
  const featuredPerson = pickFeaturedDossierPerson(ctx.bundle);
  const dossierRoute = featuredPerson ? `/person/${featuredPerson.slug}` : '/';
  const dossierLabel = featuredPerson ? `Open ${featuredPerson.full_name}` : 'Browse People';
  const hasMappedStops = hasGeocodedArchiveStops(ctx.bundle);

  return [
    // Viewer journey
    {
      id: 'core:viewer:open-tree',
      title: 'Explore the family tree',
      description: 'Open the pedigree view and select any relative to trace direct parents and descendants.',
      roles: ['viewer'],
      order: 10,
      action: { kind: 'route', to: '/tree', label: 'Open Family Tree' },
      tutorialChapterId: 'core-tree-pedigree',
    },
    {
      id: 'core:viewer:read-dossier',
      title: 'Open a Person Profile',
      description:
        'Open a Person Profile to read cited milestones, inspect a primary source scan, or play a Pronunciation Guide.',
      roles: ['viewer'],
      order: 20,
      action: { kind: 'route', to: dossierRoute, label: dossierLabel },
      tutorialChapterId: 'core-person-dossier',
    },
    {
      id: 'core:viewer:explore-map-time',
      title: 'Trace places on the map or timeline',
      description:
        'Follow documented migration stops on the map or scrub a historical year on the Time view.',
      roles: ['viewer'],
      order: 30,
      action: hasMappedStops
        ? { kind: 'route', to: '/map', label: 'Open Migration Map' }
        : { kind: 'route', to: '/time', label: 'Open Timeline' },
      tutorialChapterId: 'core-map-timeline',
    },
    {
      id: 'core:viewer:open-tutorials',
      title: 'Explore the interactive archive guide',
      description:
        'Open Interactive Tutorials anytime from the Guide menu in the top bar for step-by-step orientation.',
      roles: ['viewer'],
      order: 40,
      action: { kind: 'tutorial', chapterId: 'core-navigation-search', label: 'Open Archive Guide' },
      tutorialChapterId: 'core-navigation-search',
    },

    // Editor journey
    {
      id: 'core:editor:first-person-or-edit',
      title: 'Add or update an archival record',
      description:
        'Open the edit drawer on any person, event, or place, or add a new relative from the People index.',
      roles: ['editor'],
      order: 10,
      action: {
        kind: 'route',
        to: dossierRoute,
        label: featuredPerson ? 'Open Record' : 'Open People Index',
      },
      tutorialChapterId: 'core-editing-records',
    },
    {
      id: 'core:editor:cite-source',
      title: 'Attach or review a primary source',
      description: 'Inspect the Evidence audit to see uncited milestones and connect records to citations.',
      roles: ['editor'],
      order: 20,
      action: { kind: 'route', to: '/evidence?tab=citations', label: 'Open Evidence Audit' },
      tutorialChapterId: 'core-editing-records',
    },
    {
      id: 'core:editor:upload-scan',
      title: 'Upload a photo or document scan',
      description:
        'Add a portrait, family photograph, headstone, or archival document scan to preserve primary evidence.',
      roles: ['editor'],
      order: 30,
      action: {
        kind: 'route',
        to: featuredPerson ? `/person/${featuredPerson.slug}` : '/evidence?tab=media',
        label: featuredPerson ? 'Open Media on Profile' : 'Open Media Gallery',
      },
    },
    {
      id: 'core:editor:review-changes',
      title: 'Inspect revision history',
      description:
        'Every change is versioned and reversible. Review Recent Changes to inspect human and agent edits.',
      roles: ['editor'],
      order: 40,
      action: { kind: 'route', to: '/changes', label: 'Open Recent Changes' },
    },

    // Admin journey
    {
      id: 'core:admin:verify-diagnostics',
      title: 'Verify archive health and bindings',
      description: 'Check storage backends, active plugins, and health probes in System Diagnostics.',
      roles: ['admin'],
      order: 10,
      action: { kind: 'route', to: '/admin#diagnostics', label: 'Inspect Diagnostics' },
      tutorialChapterId: 'core-admin-settings',
    },
    {
      id: 'core:admin:seed-or-review-records',
      title: 'Confirm initial archive records',
      description:
        'Verify that relatives and primary sources are loaded, or add your first ancestor to start the tree.',
      roles: ['admin'],
      order: 20,
      action: { kind: 'route', to: '/', label: 'Review People Directory' },
      isComplete: (context) => (context.bundle?.people.length ?? 0) > 0,
    },
    {
      id: 'core:admin:create-invite',
      title: 'Create a family invite link',
      description: 'Generate a revocable read-only invite link to share the archive safely with relatives.',
      roles: ['admin'],
      order: 30,
      action: { kind: 'route', to: '/admin#invites', label: 'Create Invite Link' },
      tutorialChapterId: 'core-admin-settings',
    },
    {
      id: 'core:admin:configure-plugins-backups',
      title: 'Review plugin settings and backup tokens',
      description:
        'Configure installed plugin settings or create a read-only backup token for archival exports.',
      roles: ['admin'],
      order: 40,
      action: { kind: 'route', to: '/admin#plugin-settings', label: 'Review Settings & Tokens' },
    },
  ];
}

function resolveStepAction(step: KinloomOnboardingStep): KinloomOnboardingStepAction | null {
  if (step.action) {
    return step.action;
  }
  if (step.targetRoute) {
    return { kind: 'route', to: step.targetRoute, label: 'Open' };
  }
  if (step.tutorialChapterId) {
    return { kind: 'tutorial', chapterId: step.tutorialChapterId, label: 'Open Guide' };
  }
  return null;
}

function safeEvalPredicate(
  predicate: ((ctx: KinloomOnboardingContext) => boolean) | undefined,
  ctx: KinloomOnboardingContext,
  fallback: boolean
): boolean {
  if (typeof predicate !== 'function') {
    return fallback;
  }
  try {
    return Boolean(predicate(ctx));
  } catch {
    return fallback;
  }
}

export function resolveOnboardingChecklistViewModel(params: {
  readonly ctx: KinloomOnboardingContext;
  readonly state: UserOnboardingState;
  readonly coreSteps: readonly KinloomOnboardingStep[];
  readonly pluginSteps: readonly (KinloomOnboardingStep & { readonly pluginId: string })[];
}): OnboardingChecklistViewModel {
  const { ctx, state, coreSteps, pluginSteps } = params;
  const completedSet = new Set(state.completed_step_ids);
  const skippedSet = new Set(state.skipped_step_ids);

  const resolvedCore: ResolvedOnboardingStep[] = [];
  for (const step of coreSteps) {
    if (!isStepVisibleForRole(step, ctx.role)) {
      continue;
    }
    if (!safeEvalPredicate(step.isApplicable, ctx, true)) {
      continue;
    }
    const autoCompleted = safeEvalPredicate(step.isComplete, ctx, false);
    const isCompleted = completedSet.has(step.id) || autoCompleted;
    const status: OnboardingStepStatus = isCompleted
      ? 'completed'
      : skippedSet.has(step.id)
        ? 'skipped'
        : 'pending';
    resolvedCore.push({
      step,
      source: 'core',
      status,
      isAutoCompleted: autoCompleted && !completedSet.has(step.id),
      resolvedAction: resolveStepAction(step),
    });
  }

  const resolvedPlugin: ResolvedOnboardingStep[] = [];
  for (const step of pluginSteps) {
    if (!isStepVisibleForRole(step, ctx.role)) {
      continue;
    }
    if (!safeEvalPredicate(step.isApplicable, ctx, true)) {
      continue;
    }
    const autoCompleted = safeEvalPredicate(step.isComplete, ctx, false);
    const isCompleted = completedSet.has(step.id) || autoCompleted;
    const status: OnboardingStepStatus = isCompleted
      ? 'completed'
      : skippedSet.has(step.id)
        ? 'skipped'
        : 'pending';
    resolvedPlugin.push({
      step,
      source: 'plugin',
      pluginId: step.pluginId,
      status,
      isAutoCompleted: autoCompleted && !completedSet.has(step.id),
      resolvedAction: resolveStepAction(step),
    });
  }

  const sortedCore = resolvedCore.toSorted(
    (a, b) => (a.step.order ?? 100) - (b.step.order ?? 100) || a.step.id.localeCompare(b.step.id)
  );
  const items = [...sortedCore, ...resolvedPlugin];
  const primaryItems = items.slice(0, MAX_VISIBLE_ONBOARDING_STEPS);
  const overflowPluginItems = items.slice(MAX_VISIBLE_ONBOARDING_STEPS);

  const completedCount = items.filter((item) => item.status === 'completed').length;
  const resolvedCount = items.filter(
    (item) => item.status === 'completed' || item.status === 'skipped'
  ).length;
  const totalCount = items.length;
  const allResolved = totalCount > 0 && resolvedCount === totalCount;
  const percentComplete = totalCount === 0 ? 100 : Math.round((resolvedCount / totalCount) * 100);
  const showInviteRetentionNote = ctx.session?.principal_kind === 'invite_viewer' && completedCount >= 2;

  return {
    role: ctx.role,
    items,
    primaryItems,
    overflowPluginItems,
    completedCount,
    resolvedCount,
    totalCount,
    allResolved,
    percentComplete,
    showInviteRetentionNote,
  };
}
