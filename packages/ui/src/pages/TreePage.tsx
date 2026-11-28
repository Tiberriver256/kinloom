import type { Person } from '@kinloom/core';
import { buildPersonThumbMap, resolveDefaultBranchId } from '@kinloom/core';
import type React from 'react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { EmptyStateNotice } from '../components/Atoms.js';
import canvasSurfaceStyles from '../components/CanvasSurfacePrimitives.module.css';
import { ExplorerTopBar } from '../components/ExplorerTopBar.js';
import { TreeFocusDrawer } from '../components/tree/TreeFocusDrawer.js';
import { TreeKinshipLoom } from '../components/tree/TreeKinshipLoom.js';
import { TreeOrthogonalCanvas } from '../components/tree/TreeOrthogonalCanvas.js';
import { TreePedigreeRoll } from '../components/tree/TreePedigreeRoll.js';
import { TreeToolbar } from '../components/tree/TreeToolbar.js';
import { CreateEntityModal } from '../components/wiki/CreateEntityModal.js';
import { useArchiveData } from '../context/ArchiveDataContext.js';
import { useOptionalOnboarding } from '../context/OnboardingContext.js';
import type { TreeLineageMode, TreeViewSurface } from '../lib/archivalTreeModel.js';
import {
  buildArchivalTreeModel,
  computeArchivalDiagramLayout,
  computeLineageSpotlight,
  findCollapsedUnionForPerson,
  isRedactedLivingPlaceholder,
  isTreeSearchEligible,
  resolveAnchorBranchFilter,
  resolveTreeFocusPlan,
  searchTreePeople,
} from '../lib/archivalTreeModel.js';
import { cx, joinClasses } from '../lib/cx.js';
import { resolvePersonPortraitUrl } from '../lib/personPortrait.js';
import { KINSHIP_LOOM_ZOOM_THRESHOLD } from '../lib/tree/kinshipLoomModel.js';
import { KINLOOM_VOCABULARY } from '../lib/vocabulary.js';
import controlStyles from '../styles/Controls.module.css';
import treePageStyles from './TreePage.module.css';
import { TreeMinimap } from './tree/TreeMinimap.js';
import { TreeZoomControls } from './tree/TreeZoomControls.js';
import { computeTreeBranchCounts, readInitialTreePreferences } from './tree/treePageHelpers.js';
import { useTreeCanvasInteractions } from './tree/useTreeCanvasInteractions.js';
import { useTreeViewportTransform } from './tree/useTreeViewportTransform.js';

export const TreePage: React.FC = () => {
  const { siteConfig, baseUrl, bundle, placesById, capabilities, loading } = useArchiveData();
  const onboarding = useOptionalOnboarding();
  const [searchParams, setSearchParams] = useSearchParams();

  const personThumbMap = useMemo(
    () => (bundle ? buildPersonThumbMap(bundle) : new Map<string, string>()),
    [bundle]
  );

  const initialPrefs = useMemo(() => readInitialTreePreferences(searchParams), [searchParams]);
  const defaultBranchId = useMemo(() => resolveDefaultBranchId(siteConfig), [siteConfig]);

  const [surface, setSurface] = useState<TreeViewSurface>(initialPrefs.surface);
  const [mode, setMode] = useState<TreeLineageMode>(initialPrefs.mode);
  const [branchFilter, setBranchFilter] = useState<string>('all');
  const [selectedPersonId, setSelectedPersonId] = useState<string | null>(null);
  const [expandedUnionIds, setExpandedUnionIds] = useState<ReadonlySet<string>>(() => new Set<string>());
  const [liveAnnouncement, setLiveAnnouncement] = useState<string>('');
  const [createPersonOpen, setCreatePersonOpen] = useState<boolean>(false);
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [anchorQuery, setAnchorQuery] = useState<string>('');
  const [mobileSearchOpen, setMobileSearchOpen] = useState<boolean>(false);
  const [focusRequestSeq, setFocusRequestSeq] = useState<number>(0);

  const containerRef = useRef<HTMLElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const toolbarRef = useRef<HTMLDivElement | null>(null);
  const controlsRef = useRef<HTMLDivElement | null>(null);
  const minimapRef = useRef<HTMLElement | null>(null);
  const appliedFocusSlugRef = useRef<string | null>(null);
  const pendingFocusPersonIdRef = useRef<string | null>(null);
  const pendingAnimateRef = useRef<boolean>(false);
  const prevAnchorIdRef = useRef<string | null>(null);
  const lastFitKeyRef = useRef<string | null>(null);
  const lastFocusedNodeRef = useRef<Element | null>(null);

  const fullPeopleById = useMemo(
    () => (bundle ? new Map(bundle.people.map((p) => [p.id, p])) : new Map<string, Person>()),
    [bundle]
  );

  const anchorSlugParam = searchParams.get('anchor')?.trim() || null;
  const activeAnchorPerson = useMemo(() => {
    if (!bundle || !anchorSlugParam) {
      return null;
    }
    return (
      bundle.people.find(
        (p) => p.slug === anchorSlugParam && isTreeSearchEligible(p, bundle.meta.build_mode)
      ) ?? null
    );
  }, [bundle, anchorSlugParam]);

  const branchCounts = useMemo(
    () => computeTreeBranchCounts(bundle, defaultBranchId),
    [bundle, defaultBranchId]
  );

  const populatedBranches = useMemo(
    () => siteConfig.branches.filter((b) => (branchCounts[b.id] || 0) > 0),
    [siteConfig.branches, branchCounts]
  );

  const branchLabelsById = useMemo(
    () => new Map(siteConfig.branches.map((b) => [b.id, b.label])),
    [siteConfig.branches]
  );

  const directModeBranchIds = useMemo(
    () => siteConfig.branches.filter((b) => b.supportsDirectMode).map((b) => b.id),
    [siteConfig.branches]
  );

  const activeBranchConfig = useMemo(
    () => siteConfig.branches.find((b) => b.id === branchFilter),
    [siteConfig.branches, branchFilter]
  );

  const activeBranchLabel =
    branchFilter === 'all' ? siteConfig.site.familyName : (activeBranchConfig?.label ?? branchFilter);

  const showDirectToggle =
    surface !== 'loom' &&
    (activeAnchorPerson !== null ||
      branchFilter === 'all' ||
      (activeBranchConfig?.supportsDirectMode ?? true));

  const model = useMemo(() => {
    if (!bundle) {
      return buildArchivalTreeModel({
        people: [],
        kinship: [],
        mode,
        expandedUnionIds,
      });
    }
    return buildArchivalTreeModel({
      people: bundle.people,
      kinship: bundle.kinship,
      branchFilter: branchFilter === 'all' ? null : branchFilter,
      defaultBranchId,
      directModeBranchIds: directModeBranchIds.length > 0 ? directModeBranchIds : undefined,
      mode,
      expandedUnionIds,
      anchorPersonId: activeAnchorPerson?.id ?? null,
    });
  }, [
    bundle,
    branchFilter,
    defaultBranchId,
    directModeBranchIds,
    mode,
    expandedUnionIds,
    activeAnchorPerson,
  ]);

  const diagramLayout = useMemo(() => computeArchivalDiagramLayout(model), [model]);

  const isReady = !loading && Boolean(bundle);
  const viewport = useTreeViewportTransform({
    diagramLayout,
    containerRef,
    stageRef,
    toolbarRef,
    controlsRef,
    minimapRef,
  });
  const interactions = useTreeCanvasInteractions({
    isReady,
    surface,
    createPersonOpen,
    containerRef,
    viewport,
  });
  const canvas = { ...viewport, ...interactions };

  const selectedPerson = useMemo(
    () => (selectedPersonId ? (model.peopleById.get(selectedPersonId) ?? null) : null),
    [selectedPersonId, model.peopleById]
  );

  const spotlight = useMemo(
    () =>
      selectedPerson
        ? computeLineageSpotlight({
            selectedPersonId: selectedPerson.id,
            model,
            bundle,
            placesById,
          })
        : null,
    [selectedPerson, model, bundle, placesById]
  );

  const searchCandidates = useMemo(() => {
    if (!bundle) {
      return [];
    }
    return searchTreePeople({
      query: searchQuery,
      people: bundle.people,
      buildMode: bundle.meta.build_mode,
      model,
      branchFilter,
      defaultBranchId,
      branchLabelsById,
      limit: 10,
    });
  }, [bundle, searchQuery, model, branchFilter, defaultBranchId, branchLabelsById]);

  const anchorCandidates = useMemo(() => {
    if (!bundle) {
      return [];
    }
    return searchTreePeople({
      query: anchorQuery,
      people: bundle.people,
      buildMode: bundle.meta.build_mode,
      model,
      branchFilter,
      defaultBranchId,
      branchLabelsById,
      limit: 12,
      rankingMode: 'anchor',
    });
  }, [bundle, anchorQuery, model, branchFilter, defaultBranchId, branchLabelsById]);

  useEffect(() => {
    if (surface === 'diagram' || surface === 'loom') {
      document.documentElement.classList.add('tree-viewport-lock');
    } else {
      document.documentElement.classList.remove('tree-viewport-lock');
    }
    return (): void => {
      document.documentElement.classList.remove('tree-viewport-lock');
    };
  }, [surface]);

  const restoreFocusedNode = useCallback((): void => {
    const prev = lastFocusedNodeRef.current;
    if (prev?.isConnected && typeof (prev as HTMLElement).focus === 'function') {
      (prev as HTMLElement).focus();
    }
    lastFocusedNodeRef.current = null;
  }, []);

  useEffect(() => {
    if (!selectedPersonId || createPersonOpen) {
      return undefined;
    }
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        setSelectedPersonId(null);
        setLiveAnnouncement('Lineage focus cleared.');
        restoreFocusedNode();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return (): void => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [selectedPersonId, createPersonOpen, restoreFocusedNode]);

  const handleToggleUnionSiblings = useCallback((unionId: string): void => {
    setExpandedUnionIds((prev) => {
      const next = new Set(prev);
      if (next.has(unionId)) {
        next.delete(unionId);
        setLiveAnnouncement('Collapsed sibling group.');
      } else {
        next.add(unionId);
        setLiveAnnouncement('Expanded sibling group.');
      }
      return next;
    });
  }, []);

  const handleSelectPerson = useCallback(
    (person: Person, fromKeyboard = false): void => {
      if (surface === 'diagram' && !fromKeyboard && canvas.didDragMoveRef.current) {
        return;
      }
      if (typeof document !== 'undefined' && document.activeElement) {
        lastFocusedNodeRef.current = document.activeElement;
      }
      setSelectedPersonId(person.id);
      onboarding?.recordSignal('tree_focus');
      setLiveAnnouncement(`Focused ${person.full_name} and traced direct lineage.`);
    },
    [surface, canvas.didDragMoveRef, onboarding]
  );

  const handleClearFocus = useCallback((): void => {
    setSelectedPersonId(null);
    setLiveAnnouncement('Lineage focus cleared.');
    restoreFocusedNode();
  }, [restoreFocusedNode]);

  const handleFocusAndCenterPerson = useCallback(
    (person: Person): void => {
      const plan = resolveTreeFocusPlan({
        person,
        model,
        currentBranchFilter: branchFilter,
        defaultBranchId,
        currentMode: model.effectiveMode,
      });
      if (plan.nextBranchFilter !== branchFilter) {
        setBranchFilter(plan.nextBranchFilter);
      }
      if (plan.nextMode !== mode) {
        setMode(plan.nextMode);
      }
      if (plan.expandUnionIds.length > 0) {
        setExpandedUnionIds((prev) => new Set([...prev, ...plan.expandUnionIds]));
      }
      pendingFocusPersonIdRef.current = person.id;
      setSelectedPersonId(person.id);
      setFocusRequestSeq((seq) => seq + 1);
      setLiveAnnouncement(`Focused ${person.full_name} and centered them in the tree.`);
    },
    [branchFilter, defaultBranchId, mode, model]
  );

  const handleSelectAnchorPerson = useCallback(
    (person: Person): void => {
      if (!bundle) {
        return;
      }
      const { nextBranchFilter, clearedBranch } = resolveAnchorBranchFilter({
        anchorPerson: person,
        currentBranchFilter: branchFilter,
        defaultBranchId,
        peopleById: fullPeopleById,
        kinship: bundle.kinship,
      });
      if (clearedBranch) {
        setBranchFilter(nextBranchFilter);
      }
      setMode('spine');
      setExpandedUnionIds(new Set());
      setMobileSearchOpen(false);
      const nextParams = new URLSearchParams(searchParams);
      nextParams.set('anchor', person.slug);
      nextParams.delete('mode');
      setSearchParams(nextParams);
      pendingFocusPersonIdRef.current = person.id;
      pendingAnimateRef.current = true;
      setFocusRequestSeq((seq) => seq + 1);
      setLiveAnnouncement(
        clearedBranch
          ? `Switched to All Branches and traced ancestors from ${person.full_name}.`
          : `Tracing direct ancestors from ${person.full_name}.`
      );
    },
    [branchFilter, bundle, defaultBranchId, fullPeopleById, searchParams, setSearchParams]
  );

  const handleResetAnchor = useCallback((): void => {
    const nextParams = new URLSearchParams(searchParams);
    nextParams.delete('anchor');
    setSearchParams(nextParams);
    setExpandedUnionIds(new Set());
    setLiveAnnouncement('Reset direct line anchor to archive default.');
  }, [searchParams, setSearchParams]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: focusRequestSeq is an intentional re-centering trigger
  useLayoutEffect(() => {
    if (!bundle) {
      return;
    }
    if (activeAnchorPerson && branchFilter !== 'all') {
      const { nextBranchFilter, clearedBranch } = resolveAnchorBranchFilter({
        anchorPerson: activeAnchorPerson,
        currentBranchFilter: branchFilter,
        defaultBranchId,
        peopleById: fullPeopleById,
        kinship: bundle.kinship,
      });
      if (clearedBranch) {
        setBranchFilter(nextBranchFilter);
        return;
      }
    }

    const focusSlug = searchParams.get('focus');
    if (focusSlug && appliedFocusSlugRef.current !== focusSlug) {
      const targetPerson = bundle.people.find((p) => p.slug === focusSlug && !isRedactedLivingPlaceholder(p));
      if (targetPerson) {
        appliedFocusSlugRef.current = focusSlug;
        handleFocusAndCenterPerson(targetPerson);
        return;
      }
    }

    const fitKey = `${branchFilter}|${model.effectiveMode}|${surface}|${model.anchorPersonId ?? 'default'}`;
    if (prevAnchorIdRef.current !== model.anchorPersonId) {
      prevAnchorIdRef.current = model.anchorPersonId;
      if (model.anchorPersonId !== null) {
        if (mode !== 'spine' && searchParams.get('mode') !== 'full') {
          setMode('spine');
          return;
        }
        if (!pendingFocusPersonIdRef.current) {
          pendingFocusPersonIdRef.current = model.anchorPersonId;
        }
      }
    }

    const pendingId = pendingFocusPersonIdRef.current;
    if (pendingId) {
      const collapsedUnion = findCollapsedUnionForPerson(pendingId, model);
      if (collapsedUnion && !expandedUnionIds.has(collapsedUnion.id)) {
        setExpandedUnionIds((prev) => new Set([...prev, collapsedUnion.id]));
        return;
      }
      const shouldAnimate = pendingAnimateRef.current || lastFitKeyRef.current === fitKey;
      const centered =
        surface === 'diagram'
          ? canvas.centerDiagramOnPerson(pendingId, shouldAnimate)
          : surface === 'roll'
            ? canvas.scrollRollToPerson(pendingId)
            : true;
      if (centered) {
        pendingFocusPersonIdRef.current = null;
        pendingAnimateRef.current = false;
        lastFitKeyRef.current = fitKey;
        return;
      }
    }

    if (surface === 'diagram' && diagramLayout.nodes.length > 0 && lastFitKeyRef.current !== fitKey) {
      lastFitKeyRef.current = fitKey;
      canvas.applyInitialViewport({
        pivotPersonId: model.pivotPersonId,
        totalVisibleCount: model.totalVisibleCount,
        generationCount: model.generations.length,
      });
    } else if (surface === 'roll' || surface === 'loom') {
      lastFitKeyRef.current = fitKey;
    }
  }, [
    bundle,
    activeAnchorPerson,
    defaultBranchId,
    fullPeopleById,
    searchParams,
    branchFilter,
    mode,
    model,
    surface,
    expandedUnionIds,
    focusRequestSeq,
    diagramLayout.nodes.length,
    canvas.centerDiagramOnPerson,
    canvas.scrollRollToPerson,
    handleFocusAndCenterPerson,
    canvas.applyInitialViewport,
  ]);

  const stageStyle = useMemo(
    () => ({
      width: diagramLayout.bounds.maxX - diagramLayout.bounds.minX,
      height: diagramLayout.bounds.maxY - diagramLayout.bounds.minY,
    }),
    [
      diagramLayout.bounds.maxX,
      diagramLayout.bounds.minX,
      diagramLayout.bounds.maxY,
      diagramLayout.bounds.minY,
    ]
  );

  if (loading || !bundle) {
    return (
      <div className={cx(treePageStyles, `tree-shell tree-shell-${surface}`)}>
        <ExplorerTopBar />
        <main
          id="main-content"
          className={joinClasses(
            cx(canvasSurfaceStyles, 'tree-page'),
            cx(treePageStyles, `tree-page-${surface} tree-loading-main`)
          )}
          data-surface={surface}
          aria-busy="true"
        >
          <h1 className={cx(canvasSurfaceStyles, 'canvas-sr-heading')}>
            {activeBranchLabel} {KINLOOM_VOCABULARY.tree.pageTitleSuffix}
          </h1>
          <output className={cx(canvasSurfaceStyles, 'canvas-sr-heading')} aria-live="polite">
            {KINLOOM_VOCABULARY.tree.loading}
          </output>
          <div className={cx(treePageStyles, 'tree-loading-skeleton')} aria-hidden="true">
            <div className={cx(treePageStyles, 'tree-skeleton-toolbar')}>
              <div className={cx(treePageStyles, 'tree-skeleton-toolbar-group')}>
                <span className={cx(treePageStyles, 'tree-skeleton-pill')} />
                <span className={cx(treePageStyles, 'tree-skeleton-pill')} />
              </div>
              <span className={cx(treePageStyles, 'tree-skeleton-pill tree-skeleton-pill-wide')} />
            </div>

            <div className={cx(treePageStyles, 'tree-skeleton-stage')}>
              <div className={cx(treePageStyles, 'tree-skeleton-tier')}>
                {[0, 1].map((idx) => (
                  <div key={`g1-${idx}`} className={cx(treePageStyles, 'tree-skeleton-card')}>
                    <span className={cx(treePageStyles, 'tree-skeleton-avatar')} />
                    <span className={cx(treePageStyles, 'tree-skeleton-lines')}>
                      <span className={cx(treePageStyles, 'tree-skeleton-line')} />
                      <span className={cx(treePageStyles, 'tree-skeleton-line tree-skeleton-line-short')} />
                    </span>
                  </div>
                ))}
              </div>
              <div className={cx(treePageStyles, 'tree-skeleton-connector')} />
              <div className={cx(treePageStyles, 'tree-skeleton-tier')}>
                {[0, 1, 2].map((idx) => (
                  <div key={`g2-${idx}`} className={cx(treePageStyles, 'tree-skeleton-card')}>
                    <span className={cx(treePageStyles, 'tree-skeleton-avatar')} />
                    <span className={cx(treePageStyles, 'tree-skeleton-lines')}>
                      <span className={cx(treePageStyles, 'tree-skeleton-line')} />
                      <span className={cx(treePageStyles, 'tree-skeleton-line tree-skeleton-line-short')} />
                    </span>
                  </div>
                ))}
              </div>
              <div className={cx(treePageStyles, 'tree-skeleton-connector')} />
              <div className={cx(treePageStyles, 'tree-skeleton-tier')}>
                {[0, 1].map((idx) => (
                  <div key={`g3-${idx}`} className={cx(treePageStyles, 'tree-skeleton-card')}>
                    <span className={cx(treePageStyles, 'tree-skeleton-avatar')} />
                    <span className={cx(treePageStyles, 'tree-skeleton-lines')}>
                      <span className={cx(treePageStyles, 'tree-skeleton-line')} />
                      <span className={cx(treePageStyles, 'tree-skeleton-line tree-skeleton-line-short')} />
                    </span>
                  </div>
                ))}
              </div>
            </div>

            {surface === 'diagram' && (
              <>
                <div className={cx(treePageStyles, 'tree-skeleton-minimap')}>
                  <span className={cx(treePageStyles, 'tree-skeleton-line tree-skeleton-line-short')} />
                  <span className={cx(treePageStyles, 'tree-skeleton-minimap-body')} />
                </div>
                <div className={cx(treePageStyles, 'tree-skeleton-controls')}>
                  {[0, 1, 2, 3].map((idx) => (
                    <span key={`ctrl-${idx}`} className={cx(treePageStyles, 'tree-skeleton-control-btn')} />
                  ))}
                </div>
              </>
            )}
          </div>
        </main>
      </div>
    );
  }

  const activeCount = branchCounts[branchFilter] ?? model.totalVisibleCount;

  return (
    <div className={cx(treePageStyles, `tree-shell tree-shell-${surface}`)}>
      <ExplorerTopBar />
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: interactive pan/zoom container clears selection on background click */}
      <main
        id="main-content"
        ref={containerRef}
        className={joinClasses(
          cx(canvasSurfaceStyles, 'tree-page'),
          cx(treePageStyles, `tree-page-${surface}`)
        )}
        data-surface={surface}
        data-mode={model.effectiveMode}
        data-has-selection={selectedPerson ? 'true' : undefined}
        onPointerDown={canvas.handlePointerDown}
        onClick={(e) => {
          if (surface !== 'diagram') {
            return;
          }
          if (
            e.target instanceof Element &&
            e.target.closest(
              'button, a, select, input, .tree-toolbar, .tree-toolbar-shell, .tree-search-popover, .tree-anchor-picker, .tree-anchor-popover, .tree-popover, .tree-controls, .tree-minimap, .tree-node-card, .tree-diagram-sibling-btn'
            )
          ) {
            return;
          }
          if (!canvas.didDragMoveRef.current) {
            setSelectedPersonId(null);
          }
        }}
      >
        <h1 className={cx(canvasSurfaceStyles, 'canvas-sr-heading')}>
          {activeBranchLabel} {KINLOOM_VOCABULARY.tree.pageTitleSuffix}
        </h1>

        <TreeToolbar
          shellRef={toolbarRef}
          populatedBranches={populatedBranches}
          branchCounts={branchCounts}
          branchFilter={branchFilter}
          onBranchFilterChange={(nextBranch) => {
            if (nextBranch !== 'all' && activeAnchorPerson) {
              const { clearedBranch } = resolveAnchorBranchFilter({
                anchorPerson: activeAnchorPerson,
                currentBranchFilter: nextBranch,
                defaultBranchId,
                peopleById: fullPeopleById,
                kinship: bundle.kinship,
              });
              if (clearedBranch) {
                const nextParams = new URLSearchParams(searchParams);
                nextParams.delete('anchor');
                setSearchParams(nextParams);
                setLiveAnnouncement(
                  `Cleared custom anchor ${activeAnchorPerson.full_name} because their lineage spans another branch.`
                );
              }
            }
            setBranchFilter(nextBranch);
            setSelectedPersonId(null);
            setExpandedUnionIds(new Set());
            setMobileSearchOpen(false);
          }}
          showDirectToggle={showDirectToggle}
          mode={model.effectiveMode}
          activeCount={activeCount}
          onModeChange={(nextMode) => {
            setMode(nextMode);
            setExpandedUnionIds(new Set());
            setMobileSearchOpen(false);
          }}
          surface={surface}
          onSurfaceChange={(nextSurface) => {
            setSurface(nextSurface);
            if (nextSurface === 'diagram' && canvas.zoomPercent < KINSHIP_LOOM_ZOOM_THRESHOLD) {
              canvas.handleDiagramResetZoom();
            }
            setMobileSearchOpen(false);
          }}
          searchQuery={searchQuery}
          onSearchQueryChange={setSearchQuery}
          searchCandidates={searchCandidates}
          onSelectSearchPerson={handleFocusAndCenterPerson}
          mobileSearchOpen={mobileSearchOpen}
          onMobileSearchOpenChange={setMobileSearchOpen}
          canEdit={capabilities.canEdit}
          onAddPerson={() => {
            setCreatePersonOpen(true);
          }}
          activeAnchor={activeAnchorPerson}
          anchorQuery={anchorQuery}
          onAnchorQueryChange={setAnchorQuery}
          anchorCandidates={anchorCandidates}
          onSelectAnchor={handleSelectAnchorPerson}
          onResetAnchor={handleResetAnchor}
        />

        {model.totalVisibleCount === 0 ? (
          <div className={cx(treePageStyles, 'tree-empty-wrap')}>
            {bundle.people.length === 0 ? (
              <EmptyStateNotice
                eyebrow="Family Tree"
                title="Your family tree is ready for its first branch"
                body="No people have been added to this archive yet. Adding connected relatives builds the interactive pedigree diagram and printable roll."
                action={
                  capabilities.canEdit ? (
                    <button
                      type="button"
                      className={cx(controlStyles, 'pill-btn active')}
                      onClick={() => {
                        setCreatePersonOpen(true);
                      }}
                    >
                      + Add first person
                    </button>
                  ) : undefined
                }
                secondaryAction={
                  onboarding ? (
                    <button
                      type="button"
                      className={cx(controlStyles, 'pill-btn')}
                      onClick={() => {
                        onboarding.openGuide('core-tree-pedigree');
                      }}
                    >
                      Watch Tree tutorial
                    </button>
                  ) : undefined
                }
              />
            ) : (
              <EmptyStateNotice
                title="No people appear in this branch or lineage view."
                body="Switch to All Branches or Full Tree to view the documented family lines."
                action={
                  branchFilter !== 'all' || mode !== 'full' ? (
                    <button
                      type="button"
                      className={cx(controlStyles, 'pill-btn')}
                      onClick={() => {
                        setBranchFilter('all');
                        setMode('full');
                      }}
                    >
                      Show Full Tree
                    </button>
                  ) : undefined
                }
              />
            )}
          </div>
        ) : surface === 'roll' ? (
          <TreePedigreeRoll
            model={model}
            spotlight={spotlight}
            selectedPersonId={selectedPerson?.id ?? null}
            anchorPersonId={model.anchorPersonId}
            personThumbMap={personThumbMap}
            baseUrl={baseUrl}
            familyLabel={activeBranchLabel}
            branchLabelsById={branchLabelsById}
            showBranchLabels={branchFilter === 'all' && populatedBranches.length > 1}
            onSelectPerson={(person) => {
              handleSelectPerson(person, true);
            }}
            onToggleUnionSiblings={handleToggleUnionSiblings}
          />
        ) : surface === 'loom' ? (
          <TreeKinshipLoom
            model={model}
            selectedPersonId={selectedPerson?.id ?? null}
            familyLabel={activeBranchLabel}
            onSelectPerson={handleSelectPerson}
          />
        ) : (
          <>
            <div ref={stageRef} className={cx(treePageStyles, 'tree-stage')} style={stageStyle}>
              <TreeOrthogonalCanvas
                layout={diagramLayout}
                spotlight={spotlight}
                selectedPersonId={selectedPerson?.id ?? null}
                anchorPersonId={model.anchorPersonId}
                semanticZoom={canvas.semanticZoom}
                activeBranchLabel={activeBranchLabel}
                personThumbMap={personThumbMap}
                baseUrl={baseUrl}
                onSelectPerson={handleSelectPerson}
                onToggleUnionSiblings={handleToggleUnionSiblings}
              />
            </div>

            {diagramLayout.nodes.length > 0 && (
              <TreeMinimap
                minimapRef={minimapRef}
                layout={diagramLayout}
                spotlight={spotlight}
                selectedPersonId={selectedPerson?.id ?? null}
                anchorPersonId={model.anchorPersonId}
                getViewportSnapshot={canvas.getViewportSnapshot}
                subscribeTransform={canvas.subscribeTransform}
                onNavigateToPoint={(gx, gy) => {
                  canvas.centerDiagramOnPoint(gx, gy, false);
                }}
                onPanBy={(dx, dy) => {
                  const base = canvas.animationTargetRef.current ?? canvas.transformRef.current;
                  canvas.animateToTransform(
                    { zoom: base.zoom, pan: { x: base.pan.x + dx, y: base.pan.y + dy } },
                    120
                  );
                }}
                onFit={canvas.animateFitToViewport}
              />
            )}

            <TreeZoomControls
              controlsRef={controlsRef}
              zoomPercent={canvas.zoomPercent}
              onZoomIn={() => {
                canvas.handleDiagramZoomBy(1.28);
              }}
              onZoomOut={() => {
                canvas.handleDiagramZoomBy(1 / 1.28);
              }}
              onFit={canvas.animateFitToViewport}
              onResetZoom={canvas.handleDiagramResetZoom}
            />
          </>
        )}

        {selectedPerson && (
          <TreeFocusDrawer
            person={selectedPerson}
            model={model}
            spotlight={spotlight}
            placesById={placesById}
            thumbUrl={resolvePersonPortraitUrl(selectedPerson, personThumbMap)}
            baseUrl={baseUrl}
            surface={surface}
            onSelectPerson={handleFocusAndCenterPerson}
            onClearFocus={handleClearFocus}
            activeAnchorPersonId={model.anchorPersonId}
            onSetAnchorPerson={handleSelectAnchorPerson}
            onResetAnchor={handleResetAnchor}
          />
        )}

        <output className={'visually-hidden'} aria-live="polite">
          {liveAnnouncement}
        </output>
      </main>
      <CreateEntityModal
        open={createPersonOpen}
        defaultKind="person"
        onClose={() => {
          setCreatePersonOpen(false);
        }}
      />
    </div>
  );
};
