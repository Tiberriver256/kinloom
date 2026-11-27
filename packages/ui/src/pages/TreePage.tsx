import type { Person } from '@kinloom/core';
import { buildPersonThumbMap, resolveDefaultBranchId } from '@kinloom/core';
import type React from 'react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import statusShellStyles from '../components/ArchiveStatusShell.module.css';
import { EmptyStateNotice } from '../components/Atoms.js';
import canvasSurfaceStyles from '../components/CanvasSurfacePrimitives.module.css';
import { ExplorerTopBar } from '../components/ExplorerTopBar.js';
import { TreeFocusDrawer } from '../components/tree/TreeFocusDrawer.js';
import { TreeOrthogonalCanvas } from '../components/tree/TreeOrthogonalCanvas.js';
import { TreePedigreeRoll } from '../components/tree/TreePedigreeRoll.js';
import { TreeToolbar } from '../components/tree/TreeToolbar.js';
import { CreateEntityModal } from '../components/wiki/CreateEntityModal.js';
import { useArchiveData } from '../context/ArchiveDataContext.js';
import type { TreeLineageMode, TreeViewSurface } from '../lib/archivalTreeModel.js';
import {
  buildArchivalTreeModel,
  computeArchivalDiagramLayout,
  computeLineageSpotlight,
  findCollapsedUnionForPerson,
  isRedactedLivingPlaceholder,
  resolveTreeFocusPlan,
  searchTreePeople,
} from '../lib/archivalTreeModel.js';
import { cx } from '../lib/cx.js';
import { KINLOOM_VOCABULARY } from '../lib/vocabulary.js';
import controlStyles from '../styles/Controls.module.css';
import layoutStyles from '../styles/Layout.module.css';
import treePageStyles from './TreePage.module.css';
import { TreeZoomControls } from './tree/TreeZoomControls.js';
import { computeTreeBranchCounts, readInitialTreePreferences } from './tree/treePageHelpers.js';
import { useTreeCanvasInteractions } from './tree/useTreeCanvasInteractions.js';
import { useTreeViewportTransform } from './tree/useTreeViewportTransform.js';

export const TreePage: React.FC = () => {
  const { siteConfig, baseUrl, bundle, placesById, capabilities, loading } = useArchiveData();
  const [searchParams] = useSearchParams();

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
  const [mobileSearchOpen, setMobileSearchOpen] = useState<boolean>(false);
  const [focusRequestSeq, setFocusRequestSeq] = useState<number>(0);

  const containerRef = useRef<HTMLElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const appliedFocusSlugRef = useRef<string | null>(null);
  const pendingFocusPersonIdRef = useRef<string | null>(null);
  const lastFitKeyRef = useRef<string | null>(null);
  const lastFocusedNodeRef = useRef<Element | null>(null);

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

  const showDirectToggle = branchFilter === 'all' || (activeBranchConfig?.supportsDirectMode ?? true);

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
    });
  }, [bundle, branchFilter, defaultBranchId, directModeBranchIds, mode, expandedUnionIds]);

  const diagramLayout = useMemo(() => computeArchivalDiagramLayout(model), [model]);

  const isReady = !loading && Boolean(bundle);
  const viewport = useTreeViewportTransform({
    diagramLayout,
    containerRef,
    stageRef,
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

  useEffect(() => {
    if (surface === 'diagram') {
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
      setLiveAnnouncement(`Focused ${person.full_name} and traced direct lineage.`);
    },
    [surface, canvas.didDragMoveRef]
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

  // biome-ignore lint/correctness/useExhaustiveDependencies: focusRequestSeq is an intentional re-centering trigger
  useLayoutEffect(() => {
    if (!bundle) {
      return;
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

    const fitKey = `${branchFilter}|${model.effectiveMode}|${surface}`;
    const pendingId = pendingFocusPersonIdRef.current;
    if (pendingId) {
      const collapsedUnion = findCollapsedUnionForPerson(pendingId, model);
      if (collapsedUnion && !expandedUnionIds.has(collapsedUnion.id)) {
        setExpandedUnionIds((prev) => new Set([...prev, collapsedUnion.id]));
        return;
      }
      const centered =
        surface === 'diagram'
          ? canvas.centerDiagramOnPerson(pendingId, lastFitKeyRef.current === fitKey)
          : canvas.scrollRollToPerson(pendingId);
      if (centered) {
        pendingFocusPersonIdRef.current = null;
        lastFitKeyRef.current = fitKey;
        return;
      }
    }

    if (surface === 'diagram' && diagramLayout.nodes.length > 0 && lastFitKeyRef.current !== fitKey) {
      lastFitKeyRef.current = fitKey;
      canvas.fitToViewport();
    } else if (surface === 'roll') {
      lastFitKeyRef.current = fitKey;
    }
  }, [
    bundle,
    searchParams,
    branchFilter,
    model,
    surface,
    expandedUnionIds,
    focusRequestSeq,
    diagramLayout.nodes.length,
    canvas.centerDiagramOnPerson,
    canvas.scrollRollToPerson,
    handleFocusAndCenterPerson,
    canvas.fitToViewport,
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
      <div>
        <ExplorerTopBar />
        <main id="main-content" className={cx(layoutStyles, 'index-page')}>
          <output className={cx(statusShellStyles, 'archive-loading-shell')} aria-live="polite">
            <span className={cx(statusShellStyles, 'archive-loading-spinner')} aria-hidden="true" />
            <span>{KINLOOM_VOCABULARY.tree.loading}</span>
          </output>
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
        className={cx(canvasSurfaceStyles, `tree-page tree-page-${surface}`)}
        data-surface={surface}
        data-mode={model.effectiveMode}
        onPointerDown={canvas.handlePointerDown}
        onClick={(e) => {
          if (surface !== 'diagram') {
            return;
          }
          if (
            e.target instanceof Element &&
            e.target.closest(
              'button, a, select, input, .tree-toolbar, .tree-toolbar-shell, .tree-search-popover, .tree-popover, .tree-controls, .tree-node-card, .tree-diagram-sibling-btn'
            )
          ) {
            return;
          }
          if (!canvas.didDragMoveRef.current) {
            setSelectedPersonId(null);
          }
        }}
      >
        <h1 className={'visually-hidden'}>{activeBranchLabel} Family Tree</h1>

        <TreeToolbar
          populatedBranches={populatedBranches}
          branchCounts={branchCounts}
          branchFilter={branchFilter}
          onBranchFilterChange={(nextBranch) => {
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
        />

        {model.totalVisibleCount === 0 ? (
          <div className={cx(treePageStyles, 'tree-empty-wrap')}>
            <EmptyStateNotice
              title={
                bundle.people.length === 0
                  ? 'No people have been added to this archive yet.'
                  : 'No people appear in this branch or lineage view.'
              }
              body={
                bundle.people.length > 0
                  ? 'Switch to All Branches or Full Tree to view the documented family lines.'
                  : undefined
              }
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
          </div>
        ) : surface === 'roll' ? (
          <TreePedigreeRoll
            model={model}
            spotlight={spotlight}
            selectedPersonId={selectedPerson?.id ?? null}
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
        ) : (
          <>
            <div ref={stageRef} className={cx(treePageStyles, 'tree-stage')} style={stageStyle}>
              <TreeOrthogonalCanvas
                layout={diagramLayout}
                spotlight={spotlight}
                selectedPersonId={selectedPerson?.id ?? null}
                semanticZoom={canvas.semanticZoom}
                activeBranchLabel={activeBranchLabel}
                personThumbMap={personThumbMap}
                baseUrl={baseUrl}
                onSelectPerson={handleSelectPerson}
                onToggleUnionSiblings={handleToggleUnionSiblings}
              />
            </div>

            <TreeZoomControls
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
            thumbUrl={personThumbMap.get(selectedPerson.id) || selectedPerson.portrait_url || null}
            baseUrl={baseUrl}
            onSelectPerson={handleFocusAndCenterPerson}
            onClearFocus={handleClearFocus}
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
