import {
  type ArchiveBundle,
  compileArchive,
  createDefaultUserOnboardingState,
  type KinloomSiteConfig,
  parseKinloomConfig,
} from '@kinloom/core';
import { describe, expect, it } from 'vitest';
import type { KinloomOnboardingContext, KinloomOnboardingStep } from '../plugins/types.js';
import {
  buildCoreOnboardingSteps,
  buildOnboardingStorageKey,
  hasGeocodedArchiveStops,
  isStepVisibleForRole,
  MAX_VISIBLE_ONBOARDING_STEPS,
  parseStoredOnboardingState,
  pickFeaturedDossierPerson,
  resolveOnboardingChecklistViewModel,
  resolveOnboardingSignalStepId,
} from './onboardingModel.js';

const BASE_SITE_CONFIG: KinloomSiteConfig = parseKinloomConfig({
  site: {
    title: 'Synthetic Family Archive',
    familyName: 'Synthetic',
    gedcomSourceName: 'ONBOARDING_MODEL_TEST',
  },
});

const EMPTY_BUNDLE: ArchiveBundle = compileArchive({
  siteConfig: BASE_SITE_CONFIG,
  mode: 'public',
  people: [],
  places: [],
  events: [],
  sources: [],
  kinship: [],
}).bundle;

const SEEDED_BUNDLE: ArchiveBundle = compileArchive({
  siteConfig: BASE_SITE_CONFIG,
  mode: 'public',
  people: [
    {
      id: 'p_living',
      slug: 'living-relative',
      full_name: 'Living Relative',
      given_name: 'Living',
      surname: 'Relative',
      alt_names: [],
      sex: 'F',
      is_living: true,
      lineage_group: 'pivot_ancestor',
      birth_edtf: '1995-05-01',
      death_edtf: '',
      portrait_url: null,
    },
    {
      id: 'p_plain',
      slug: 'clara-hale',
      full_name: 'Clara Hale',
      given_name: 'Clara',
      surname: 'Hale',
      alt_names: [],
      sex: 'F',
      is_living: false,
      lineage_group: 'pivot_ancestor',
      birth_edtf: '1850',
      death_edtf: '1920',
      portrait_url: null,
    },
    {
      id: 'p_rich',
      slug: 'arthur-hale',
      full_name: 'Arthur Hale',
      given_name: 'Arthur',
      surname: 'Hale',
      alt_names: [],
      sex: 'M',
      is_living: false,
      lineage_group: 'pivot_ancestor',
      birth_edtf: '1848',
      death_edtf: '1918',
      portrait_url: null,
    },
  ],
  places: [
    {
      id: 'pl_springfield',
      slug: 'springfield',
      name: 'Springfield',
      full_name: 'Springfield, Illinois',
      place_type: 'town',
      parent_id: null,
      lat: 39.78,
      lng: -89.65,
    },
  ],
  events: [
    {
      id: 'ev_1',
      title: 'Lived in Springfield',
      summary: '1880 Springfield residence',
      scope: 'personal',
      event_kind: 'residence_anchor',
      edtf_date: '1880',
      place_id: 'pl_springfield',
      participants: [{ person_id: 'p_rich', role: 'primary' }],
      sources: [],
    },
  ],
  sources: [],
  media: [
    {
      id: 'm_arthur_portrait',
      kind: 'portrait',
      caption: 'Arthur Hale portrait',
      file: 'media/arthur.jpg',
      person_ids: ['p_rich'],
    },
  ],
  kinship: [],
}).bundle;

function makeCtx(overrides?: Partial<KinloomOnboardingContext>): KinloomOnboardingContext {
  return {
    bundle: EMPTY_BUNDLE,
    siteConfig: BASE_SITE_CONFIG,
    baseUrl: '/',
    session: { authenticated: false, principal_kind: 'anonymous' },
    capabilities: {
      canEdit: false,
      canUploadMedia: false,
      hasRevisionHistory: false,
      hasTalk: false,
      canManageSite: false,
    },
    role: 'viewer',
    completedStepIds: new Set(),
    ...overrides,
  };
}

describe('onboardingModel pure view-model helpers', () => {
  it('builds storage keys and safely parses stored onboarding JSON', () => {
    expect(buildOnboardingStorageKey('https://archive.example')).toBe(
      'kinloom.onboarding.v1:https://archive.example'
    );
    expect(buildOnboardingStorageKey('   ')).toBe('kinloom.onboarding.v1:default');
    expect(parseStoredOnboardingState(null)).toBeNull();
    expect(parseStoredOnboardingState('{not-json')).toBeNull();
    expect(parseStoredOnboardingState('{"checklist_visibility":"invalid"}')).toBeNull();
    const valid = parseStoredOnboardingState(
      JSON.stringify({
        schema_version: 1,
        checklist_visibility: 'collapsed',
        completed_step_ids: ['core:viewer:open-tree'],
      })
    );
    expect(valid?.checklist_visibility).toBe('collapsed');
    expect(valid?.completed_step_ids).toEqual(['core:viewer:open-tree']);
  });

  it('checks exact roles vs hierarchical minRole visibility', () => {
    expect(isStepVisibleForRole({ roles: ['admin'] }, 'viewer')).toBe(false);
    expect(isStepVisibleForRole({ roles: ['admin'] }, 'editor')).toBe(false);
    expect(isStepVisibleForRole({ roles: ['admin'] }, 'admin')).toBe(true);
    expect(isStepVisibleForRole({ minRole: 'editor' }, 'viewer')).toBe(false);
    expect(isStepVisibleForRole({ minRole: 'editor' }, 'editor')).toBe(true);
    expect(isStepVisibleForRole({ minRole: 'editor' }, 'admin')).toBe(true);
    expect(isStepVisibleForRole({}, 'viewer')).toBe(true);
  });

  it('picks a deterministic public deceased dossier person and detects geocoded stops', () => {
    expect(pickFeaturedDossierPerson(null)).toBeNull();
    expect(hasGeocodedArchiveStops(null)).toBe(false);
    expect(pickFeaturedDossierPerson(EMPTY_BUNDLE)).toBeNull();
    expect(hasGeocodedArchiveStops(EMPTY_BUNDLE)).toBe(false);

    expect(pickFeaturedDossierPerson(SEEDED_BUNDLE)?.slug).toBe('arthur-hale');
    expect(hasGeocodedArchiveStops(SEEDED_BUNDLE)).toBe(true);
  });

  it('caps primary visible steps at 5, groups overflow plugin steps, and isolates throwing predicates', () => {
    const ctx = makeCtx({
      bundle: SEEDED_BUNDLE,
      role: 'viewer',
      session: {
        authenticated: false,
        principal_kind: 'invite_viewer',
        role: 'viewer',
        inviteLabel: 'Family',
      },
    });
    const coreSteps = buildCoreOnboardingSteps(ctx);
    const pluginSteps: (KinloomOnboardingStep & { pluginId: string })[] = [
      {
        id: 'plugin-a:step-1',
        pluginId: 'plugin-a',
        title: 'Plugin step 1',
        description: 'Visible step 1',
        targetRoute: '/p1',
      },
      {
        id: 'plugin-a:step-2',
        pluginId: 'plugin-a',
        title: 'Plugin step 2',
        description: 'Overflow step 2',
        tutorialChapterId: 'plugin-a:guide',
      },
      {
        id: 'plugin-a:hidden',
        pluginId: 'plugin-a',
        title: 'Hidden step',
        description: 'Not applicable',
        isApplicable: () => false,
      },
      {
        id: 'plugin-a:throwing',
        pluginId: 'plugin-a',
        title: 'Throwing predicate step',
        description: 'Should not crash',
        isApplicable: () => {
          throw new Error('boom');
        },
        isComplete: () => {
          throw new Error('boom');
        },
      },
    ];

    const state = {
      ...createDefaultUserOnboardingState(null),
      completed_step_ids: ['core:viewer:open-tree', 'core:viewer:read-dossier'],
      skipped_step_ids: ['core:viewer:explore-map-time'],
    };

    const vm = resolveOnboardingChecklistViewModel({
      ctx,
      state,
      coreSteps,
      pluginSteps,
    });

    expect(vm.primaryItems).toHaveLength(MAX_VISIBLE_ONBOARDING_STEPS);
    expect(vm.overflowPluginItems.map((i) => i.step.id)).toEqual(['plugin-a:step-2', 'plugin-a:throwing']);
    expect(vm.items.some((i) => i.step.id === 'plugin-a:hidden')).toBe(false);
    expect(vm.completedCount).toBe(2);
    expect(vm.resolvedCount).toBe(3);
    expect(vm.showInviteRetentionNote).toBe(true);
    expect(vm.allResolved).toBe(false);
    expect(vm.overflowPluginItems[0]?.resolvedAction).toEqual({
      kind: 'tutorial',
      chapterId: 'plugin-a:guide',
      label: 'Open Guide',
    });
  });

  it('maps client signals strictly to the matching role core step', () => {
    expect(resolveOnboardingSignalStepId('tree_focus', 'viewer')).toBe('core:viewer:open-tree');
    expect(resolveOnboardingSignalStepId('tree_focus', 'admin')).toBeNull();
    expect(resolveOnboardingSignalStepId('changes_visit', 'editor')).toBe('core:editor:review-changes');
    expect(resolveOnboardingSignalStepId('admin_invite_created', 'admin')).toBe('core:admin:create-invite');
  });
});
