import {
  applyOnboardingPatch,
  type ChecklistVisibility,
  createDefaultUserOnboardingState,
  type OnboardingRole,
  resolveOnboardingRole,
  type UpdateOnboardingStateRequest,
  type UserOnboardingState,
} from '@kinloom/core';
import type React from 'react';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { buildCoreTutorialChapters } from '../lib/coreTutorialChapters.js';
import {
  buildCoreOnboardingSteps,
  buildOnboardingStorageKey,
  type OnboardingChecklistViewModel,
  type OnboardingClientSignal,
  parseStoredOnboardingState,
  resolveOnboardingChecklistViewModel,
  resolveOnboardingSignalStepId,
} from '../lib/onboardingModel.js';
import {
  type ResolvedTutorialCatalog,
  resolveInitialTutorialChapterId,
  resolveTutorialCatalog,
} from '../lib/tutorialModel.js';
import {
  resolveDynamicPluginOnboardingSteps,
  resolveDynamicPluginTutorialChapters,
  useKinloomPlugins,
} from '../plugins/PluginContext.js';
import type { KinloomOnboardingContext, KinloomTutorialContext } from '../plugins/types.js';
import { KINLOOM_UI_VERSION } from '../version.js';
import { useArchiveData } from './ArchiveDataContext.js';
import { useArchiveUi } from './ArchiveUiContext.js';

export type TutorialLauncher = (chapterId?: string) => void;

export interface OpenTutorialOptions {
  readonly chapterId?: string | undefined;
  readonly autoOpened?: boolean | undefined;
}

export interface CloseTutorialOptions {
  readonly suppressAutoOpen?: boolean;
}

export interface OnboardingContextValue {
  readonly role: OnboardingRole;
  readonly state: UserOnboardingState;
  readonly hydrated: boolean;
  readonly isFirstLogin: boolean;
  readonly shouldAutoOpenTutorialModal: boolean;
  readonly checklist: OnboardingChecklistViewModel;
  readonly tutorialCatalog: ResolvedTutorialCatalog;
  readonly onboardingContext: KinloomOnboardingContext;
  readonly lastAnnouncement: string;
  readonly shortcutsDialogOpen: boolean;
  readonly guideDialogChapter: string | null;
  readonly tutorialModalOpen: boolean;
  readonly activeTutorialChapterId: string | null;
  readonly tutorialAutoOpened: boolean;
  readonly hasTutorialLauncher: boolean;
  readonly completeStep: (stepId: string) => void;
  readonly skipStep: (stepId: string) => void;
  readonly completeChapter: (chapterId: string) => void;
  readonly recordSignal: (signal: OnboardingClientSignal) => void;
  readonly setChecklistVisibility: (visibility: ChecklistVisibility) => void;
  readonly dismissChecklist: () => void;
  readonly reopenChecklist: () => void;
  readonly dismissTutorialModal: () => void;
  readonly resetProgress: () => void;
  readonly openShortcutsDialog: () => void;
  readonly closeShortcutsDialog: () => void;
  readonly openTutorial: (options?: OpenTutorialOptions) => void;
  readonly closeTutorial: (options?: CloseTutorialOptions) => void;
  readonly openGuide: (chapterId?: string) => void;
  readonly closeGuideDialog: () => void;
  readonly registerTutorialLauncher: (launcher: TutorialLauncher) => () => void;
}

const OnboardingContext = createContext<OnboardingContextValue | null>(null);

function readBrowserStorageOrigin(): string {
  if (typeof window === 'undefined') {
    return 'ssr';
  }
  return window.location?.origin || 'default';
}

function readLocalOnboardingState(storageKey: string): UserOnboardingState | null {
  if (typeof window === 'undefined') {
    return null;
  }
  try {
    return parseStoredOnboardingState(window.localStorage.getItem(storageKey));
  } catch {
    return null;
  }
}

function writeLocalOnboardingState(storageKey: string, state: UserOnboardingState): void {
  if (typeof window === 'undefined') {
    return;
  }
  try {
    window.localStorage.setItem(storageKey, JSON.stringify(state));
  } catch {
    // Ignore storage quota or private browsing errors so onboarding never crashes the UI.
  }
}

export const OnboardingProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { bundle, siteConfig, baseUrl, session, capabilities, dataSource } = useArchiveData();
  const {
    plugins,
    onboardingSteps: staticPluginSteps,
    tutorialChapters: staticPluginChapters,
  } = useKinloomPlugins();
  const { sourceReader } = useArchiveUi();

  const role = useMemo(() => resolveOnboardingRole(session, capabilities), [session, capabilities]);
  const isAuthenticatedUser = session?.principal_kind === 'user';
  const storageKey = useMemo(() => buildOnboardingStorageKey(readBrowserStorageOrigin()), []);

  const [state, setState] = useState<UserOnboardingState>(() => {
    const local = readLocalOnboardingState(storageKey);
    return local ?? createDefaultUserOnboardingState(null);
  });
  const [firstLoginPending, setFirstLoginPending] = useState<boolean>(false);
  const [hydrated, setHydrated] = useState<boolean>(!isAuthenticatedUser);
  const [lastAnnouncement, setLastAnnouncement] = useState<string>('');
  const [shortcutsDialogOpen, setShortcutsDialogOpen] = useState<boolean>(false);
  const [guideDialogChapter, setGuideDialogChapter] = useState<string | null>(null);
  const [tutorialModalOpen, setTutorialModalOpen] = useState<boolean>(false);
  const [activeTutorialChapterId, setActiveTutorialChapterId] = useState<string | null>(null);
  const [tutorialAutoOpened, setTutorialAutoOpened] = useState<boolean>(false);
  const [hasTutorialLauncher, setHasTutorialLauncher] = useState<boolean>(false);

  const tutorialLauncherRef = useRef<TutorialLauncher | null>(null);
  const stateRef = useRef<UserOnboardingState>(state);
  const firstLoginPendingRef = useRef<boolean>(firstLoginPending);
  const tutorialAutoOpenedRef = useRef<boolean>(tutorialAutoOpened);

  stateRef.current = state;
  firstLoginPendingRef.current = firstLoginPending;
  tutorialAutoOpenedRef.current = tutorialAutoOpened;

  // Sync persisted onboarding state when session principal or account email changes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-hydrate when switching authenticated email accounts
  useEffect(() => {
    if (isAuthenticatedUser && dataSource.getOnboardingState) {
      const controller = new AbortController();
      let cancelled = false;
      setHydrated(false);
      void dataSource
        .getOnboardingState({ signal: controller.signal })
        .then((response) => {
          if (cancelled) {
            return;
          }
          setState(response.state);
          setFirstLoginPending(response.is_first_login);
          setHydrated(true);
        })
        .catch(() => {
          if (cancelled) {
            return;
          }
          const fallback = readLocalOnboardingState(storageKey) ?? createDefaultUserOnboardingState(null);
          setState(fallback);
          setFirstLoginPending(false);
          setHydrated(true);
        });
      return (): void => {
        cancelled = true;
        controller.abort();
      };
    }

    const local = readLocalOnboardingState(storageKey) ?? createDefaultUserOnboardingState(null);
    setState(local);
    setFirstLoginPending(false);
    setHydrated(true);
    return undefined;
  }, [isAuthenticatedUser, session?.email, dataSource, storageKey]);

  const applyPatch = useCallback(
    (patch: UpdateOnboardingStateRequest, announcement?: string): void => {
      const nowIso = new Date().toISOString();
      const next = applyOnboardingPatch(
        {
          state: stateRef.current,
          first_login_pending: firstLoginPendingRef.current,
        },
        patch,
        nowIso
      );
      stateRef.current = next.state;
      firstLoginPendingRef.current = next.first_login_pending;
      setState(next.state);
      setFirstLoginPending(next.first_login_pending);
      if (announcement) {
        setLastAnnouncement(announcement);
      }

      if (isAuthenticatedUser && dataSource.updateOnboardingState) {
        void dataSource
          .updateOnboardingState(patch)
          .then((serverResponse) => {
            stateRef.current = serverResponse.state;
            firstLoginPendingRef.current = serverResponse.is_first_login;
            setState(serverResponse.state);
            setFirstLoginPending(serverResponse.is_first_login);
          })
          .catch(() => {
            // Keep optimistic local state if the network request fails.
          });
      } else {
        writeLocalOnboardingState(storageKey, next.state);
      }
    },
    [isAuthenticatedUser, dataSource, storageKey]
  );

  const completeStep = useCallback(
    (stepId: string): void => {
      const trimmed = stepId.trim();
      if (!trimmed || stateRef.current.completed_step_ids.includes(trimmed)) {
        return;
      }
      applyPatch({ complete_step_ids: [trimmed] }, 'Onboarding step marked complete.');
    },
    [applyPatch]
  );

  const skipStep = useCallback(
    (stepId: string): void => {
      const trimmed = stepId.trim();
      if (
        !trimmed ||
        stateRef.current.completed_step_ids.includes(trimmed) ||
        stateRef.current.skipped_step_ids.includes(trimmed)
      ) {
        return;
      }
      applyPatch({ skip_step_ids: [trimmed] }, 'Onboarding step skipped.');
    },
    [applyPatch]
  );

  const completeChapter = useCallback(
    (chapterId: string): void => {
      const trimmed = chapterId.trim();
      if (!trimmed || stateRef.current.completed_chapter_ids.includes(trimmed)) {
        return;
      }
      applyPatch(
        { complete_chapter_ids: [trimmed], last_seen_version: KINLOOM_UI_VERSION },
        'Tutorial chapter marked complete.'
      );
    },
    [applyPatch]
  );

  const recordSignal = useCallback(
    (signal: OnboardingClientSignal): void => {
      const stepId = resolveOnboardingSignalStepId(signal, role);
      if (stepId) {
        completeStep(stepId);
      }
    },
    [role, completeStep]
  );

  // Auto-complete source inspection signal when an editor opens SourceReaderDrawer.
  useEffect(() => {
    if (sourceReader !== null) {
      recordSignal('source_read');
    }
  }, [sourceReader, recordSignal]);

  const setChecklistVisibility = useCallback(
    (visibility: ChecklistVisibility): void => {
      if (stateRef.current.checklist_visibility === visibility) {
        return;
      }
      const label =
        visibility === 'open'
          ? 'Getting Started checklist expanded.'
          : visibility === 'collapsed'
            ? 'Getting Started checklist collapsed.'
            : 'Getting Started checklist dismissed.';
      applyPatch({ checklist_visibility: visibility }, label);
    },
    [applyPatch]
  );

  const dismissChecklist = useCallback((): void => {
    applyPatch({ dismiss_checklist: true }, 'Getting Started checklist dismissed.');
  }, [applyPatch]);

  const reopenChecklist = useCallback((): void => {
    applyPatch({ checklist_visibility: 'open' }, 'Getting Started checklist opened.');
  }, [applyPatch]);

  const dismissTutorialModal = useCallback((): void => {
    applyPatch({ dismiss_tutorial_modal: true, last_seen_version: KINLOOM_UI_VERSION });
  }, [applyPatch]);

  const resetProgress = useCallback((): void => {
    applyPatch({ reset_progress: true }, 'Onboarding progress reset.');
  }, [applyPatch]);

  const completedStepIdsSet = useMemo(
    () => new Set<string>(state.completed_step_ids),
    [state.completed_step_ids]
  );

  const onboardingContext = useMemo<KinloomOnboardingContext>(
    () => ({
      bundle,
      siteConfig,
      baseUrl,
      session,
      capabilities,
      role,
      completedStepIds: completedStepIdsSet,
    }),
    [bundle, siteConfig, baseUrl, session, capabilities, role, completedStepIdsSet]
  );

  const tutorialContext = useMemo<KinloomTutorialContext>(
    () => ({
      bundle,
      siteConfig,
      baseUrl,
      session,
      capabilities,
      role,
    }),
    [bundle, siteConfig, baseUrl, session, capabilities, role]
  );

  const checklist = useMemo<OnboardingChecklistViewModel>(() => {
    const coreSteps = buildCoreOnboardingSteps(onboardingContext);
    const staticIds = new Set(staticPluginSteps.map((s) => s.id));
    const dynamicPluginSteps = resolveDynamicPluginOnboardingSteps(plugins, staticIds, onboardingContext);
    return resolveOnboardingChecklistViewModel({
      ctx: onboardingContext,
      state,
      coreSteps,
      pluginSteps: [...staticPluginSteps, ...dynamicPluginSteps],
    });
  }, [onboardingContext, state, staticPluginSteps, plugins]);

  const tutorialCatalog = useMemo<ResolvedTutorialCatalog>(() => {
    const coreChapters = buildCoreTutorialChapters(bundle);
    const staticIds = new Set(staticPluginChapters.map((c) => c.id));
    const dynamicPluginChapters = resolveDynamicPluginTutorialChapters(plugins, staticIds, tutorialContext);
    return resolveTutorialCatalog({
      role,
      coreChapters,
      pluginChapters: [...staticPluginChapters, ...dynamicPluginChapters],
      completedChapterIds: state.completed_chapter_ids,
    });
  }, [bundle, role, staticPluginChapters, plugins, tutorialContext, state.completed_chapter_ids]);

  const openShortcutsDialog = useCallback((): void => {
    setTutorialModalOpen(false);
    setGuideDialogChapter(null);
    setShortcutsDialogOpen(true);
  }, []);

  const closeShortcutsDialog = useCallback((): void => {
    setShortcutsDialogOpen(false);
  }, []);

  const registerTutorialLauncher = useCallback((launcher: TutorialLauncher): (() => void) => {
    tutorialLauncherRef.current = launcher;
    setHasTutorialLauncher(true);
    return () => {
      if (tutorialLauncherRef.current === launcher) {
        tutorialLauncherRef.current = null;
        setHasTutorialLauncher(false);
      }
    };
  }, []);

  const openTutorial = useCallback(
    (options?: OpenTutorialOptions): void => {
      const autoOpened = Boolean(options?.autoOpened);
      if (!autoOpened) {
        recordSignal('tutorial_open');
      }
      setShortcutsDialogOpen(false);
      setGuideDialogChapter(null);
      const resolvedId = resolveInitialTutorialChapterId(tutorialCatalog, options?.chapterId);
      setActiveTutorialChapterId(resolvedId);
      setTutorialAutoOpened(autoOpened);
      setTutorialModalOpen(true);
    },
    [recordSignal, tutorialCatalog]
  );

  const closeTutorial = useCallback(
    (options?: CloseTutorialOptions): void => {
      setTutorialModalOpen(false);
      const shouldSuppress =
        Boolean(options?.suppressAutoOpen) ||
        tutorialAutoOpenedRef.current ||
        (firstLoginPendingRef.current && stateRef.current.tutorial_modal_dismissed_at === null);
      setTutorialAutoOpened(false);
      if (
        shouldSuppress &&
        (firstLoginPendingRef.current || stateRef.current.tutorial_modal_dismissed_at === null)
      ) {
        dismissTutorialModal();
      }
    },
    [dismissTutorialModal]
  );

  const openGuide = useCallback(
    (chapterId?: string): void => {
      recordSignal('tutorial_open');
      if (tutorialLauncherRef.current) {
        tutorialLauncherRef.current(chapterId);
        return;
      }
      openTutorial({ chapterId, autoOpened: false });
    },
    [recordSignal, openTutorial]
  );

  const closeGuideDialog = useCallback((): void => {
    setGuideDialogChapter(null);
  }, []);

  const shouldAutoOpenTutorialModal = firstLoginPending && state.tutorial_modal_dismissed_at === null;

  const value = useMemo<OnboardingContextValue>(
    () => ({
      role,
      state,
      hydrated,
      isFirstLogin: firstLoginPending,
      shouldAutoOpenTutorialModal,
      checklist,
      tutorialCatalog,
      onboardingContext,
      lastAnnouncement,
      shortcutsDialogOpen,
      guideDialogChapter,
      tutorialModalOpen,
      activeTutorialChapterId,
      tutorialAutoOpened,
      hasTutorialLauncher,
      completeStep,
      skipStep,
      completeChapter,
      recordSignal,
      setChecklistVisibility,
      dismissChecklist,
      reopenChecklist,
      dismissTutorialModal,
      resetProgress,
      openShortcutsDialog,
      closeShortcutsDialog,
      openTutorial,
      closeTutorial,
      openGuide,
      closeGuideDialog,
      registerTutorialLauncher,
    }),
    [
      role,
      state,
      hydrated,
      firstLoginPending,
      shouldAutoOpenTutorialModal,
      checklist,
      tutorialCatalog,
      onboardingContext,
      lastAnnouncement,
      shortcutsDialogOpen,
      guideDialogChapter,
      tutorialModalOpen,
      activeTutorialChapterId,
      tutorialAutoOpened,
      hasTutorialLauncher,
      completeStep,
      skipStep,
      completeChapter,
      recordSignal,
      setChecklistVisibility,
      dismissChecklist,
      reopenChecklist,
      dismissTutorialModal,
      resetProgress,
      openShortcutsDialog,
      closeShortcutsDialog,
      openTutorial,
      closeTutorial,
      openGuide,
      closeGuideDialog,
      registerTutorialLauncher,
    ]
  );

  return <OnboardingContext.Provider value={value}>{children}</OnboardingContext.Provider>;
};

export function useOptionalOnboarding(): OnboardingContextValue | null {
  return useContext(OnboardingContext);
}

export function useOnboarding(): OnboardingContextValue {
  const ctx = useContext(OnboardingContext);
  if (!ctx) {
    throw new Error('useOnboarding must be used inside OnboardingProvider');
  }
  return ctx;
}
