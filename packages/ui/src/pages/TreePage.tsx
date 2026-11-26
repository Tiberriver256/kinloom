import type { Person } from '@kinloom/core';
import { buildPersonThumbMap, resolveDefaultBranchId } from '@kinloom/core';
import type {
  SemanticZoomLevel,
  TreeLineageMode,
  TreeViewSurface,
} from '../lib/archivalTreeModel.js';
import {
  ARCHIVAL_NODE_H,
  ARCHIVAL_NODE_W,
  buildArchivalTreeModel,
  computeArchivalDiagramLayout,
  computeLineageSpotlight,
  findCollapsedUnionForPerson,
  isRedactedLivingPlaceholder,
  resolveInitialTreePreferences,
  resolveSemanticZoomLevel,
  resolveTreeFocusPlan,
  searchTreePeople,
} from '../lib/archivalTreeModel.js';
import type { CanvasTransform, Point2D } from '../lib/treeGestures.js';
import {
  clampPan,
  computeDoubleTapZoom,
  computePinchTransform,
  computeWheelTargetZoom,
  computeZoomAroundPoint,
  distanceBetween,
  isDragMovement,
  midpointBetween,
  stepInertia,
} from '../lib/treeGestures.js';
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ExplorerTopBar } from '../components/ExplorerTopBar.js';
import { TreeFocusDrawer } from '../components/tree/TreeFocusDrawer.js';
import { TreeOrthogonalCanvas } from '../components/tree/TreeOrthogonalCanvas.js';
import { TreePedigreeRoll } from '../components/tree/TreePedigreeRoll.js';
import { TreeToolbar } from '../components/tree/TreeToolbar.js';
import { CreateEntityModal } from '../components/wiki/CreateEntityModal.js';
import { KINLOOM_VOCABULARY } from '../lib/vocabulary.js';
import { useArchiveData } from '../context/ArchiveDataContext.js';

const INITIAL_TRANSFORM: CanvasTransform = {
  pan: { x: 40, y: 40 },
  zoom: 0.85,
};

function readInitialPreferences(searchParams: URLSearchParams): {
  readonly surface: TreeViewSurface;
  readonly mode: TreeLineageMode;
} {
  const width = typeof window !== 'undefined' ? window.innerWidth : 1200;
  const fallback = resolveInitialTreePreferences(width);
  const surfaceParam = searchParams.get('surface');
  const modeParam = searchParams.get('mode');
  const surface: TreeViewSurface =
    surfaceParam === 'diagram' || surfaceParam === 'roll' ? surfaceParam : fallback.surface;
  const mode: TreeLineageMode =
    modeParam === 'spine' || modeParam === 'full' ? modeParam : fallback.mode;
  return { surface, mode };
}

export const TreePage: React.FC = () => {
  const { siteConfig, baseUrl, bundle, placesById, capabilities, loading } = useArchiveData();
  const [searchParams] = useSearchParams();

  const personThumbMap = useMemo(
    () => (bundle ? buildPersonThumbMap(bundle) : new Map<string, string>()),
    [bundle],
  );

  const initialPrefs = useMemo(() => readInitialPreferences(searchParams), [searchParams]);
  const defaultBranchId = useMemo(() => resolveDefaultBranchId(siteConfig), [siteConfig]);

  const [surface, setSurface] = useState<TreeViewSurface>(initialPrefs.surface);
  const [mode, setMode] = useState<TreeLineageMode>(initialPrefs.mode);
  const [branchFilter, setBranchFilter] = useState<string>('all');
  const [selectedPersonId, setSelectedPersonId] = useState<string | null>(null);
  const [expandedUnionIds, setExpandedUnionIds] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );
  const [semanticZoom, setSemanticZoom] = useState<SemanticZoomLevel>(
    resolveSemanticZoomLevel(INITIAL_TRANSFORM.zoom),
  );
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
  const semanticZoomRef = useRef<SemanticZoomLevel>(semanticZoom);

  const transformRef = useRef<CanvasTransform>(INITIAL_TRANSFORM);
  const animationTargetRef = useRef<CanvasTransform | null>(null);
  const pendingTransformRef = useRef<CanvasTransform | null>(null);
  const rafIdRef = useRef<number | null>(null);
  const motionRafRef = useRef<number | null>(null);
  const inertiaSpeedRef = useRef(0);
  const zoomSettleTimerRef = useRef<number | null>(null);
  const containerRectRef = useRef<{
    left: number;
    top: number;
    width: number;
    height: number;
    ts: number;
  }>({
    left: 0,
    top: 0,
    width: 1200,
    height: 760,
    ts: 0,
  });

  const activePointersRef = useRef<Map<number, Point2D>>(new Map());
  const dragStartRef = useRef<{
    x: number;
    y: number;
    panX: number;
    panY: number;
    pointerType: string;
  } | null>(null);
  const pinchStartRef = useRef<{
    startDist: number;
    startZoom: number;
    startPan: Point2D;
    startMidpoint: Point2D;
  } | null>(null);
  const velocitySamplesRef = useRef<{ x: number; y: number; t: number }[]>([]);
  const pinchReleaseAtRef = useRef(0);
  const lastCanvasTapRef = useRef<{ x: number; y: number; t: number } | null>(null);
  const didDragMoveRef = useRef(false);

  const branchCounts = useMemo(() => {
    const counts: Record<string, number> = { all: 0 };
    if (!bundle) {
      return counts;
    }
    for (const p of bundle.people) {
      if (isRedactedLivingPlaceholder(p)) {
        continue;
      }
      counts.all += 1;
      const b = p.branch || defaultBranchId;
      counts[b] = (counts[b] || 0) + 1;
    }
    return counts;
  }, [bundle, defaultBranchId]);

  const populatedBranches = useMemo(
    () => siteConfig.branches.filter((b) => (branchCounts[b.id] || 0) > 0),
    [siteConfig.branches, branchCounts],
  );

  const branchLabelsById = useMemo(
    () => new Map(siteConfig.branches.map((b) => [b.id, b.label])),
    [siteConfig.branches],
  );

  const directModeBranchIds = useMemo(
    () => siteConfig.branches.filter((b) => b.supportsDirectMode).map((b) => b.id),
    [siteConfig.branches],
  );

  const activeBranchConfig = useMemo(
    () => siteConfig.branches.find((b) => b.id === branchFilter),
    [siteConfig.branches, branchFilter],
  );

  const activeBranchLabel =
    branchFilter === 'all'
      ? siteConfig.site.familyName
      : (activeBranchConfig?.label ?? branchFilter);

  const showDirectToggle =
    branchFilter === 'all' || (activeBranchConfig?.supportsDirectMode ?? true);

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

  const diagramLayout = useMemo(
    () => computeArchivalDiagramLayout(model),
    [model],
  );

  const selectedPerson = useMemo(
    () => (selectedPersonId ? (model.peopleById.get(selectedPersonId) ?? null) : null),
    [selectedPersonId, model.peopleById],
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
    [selectedPerson, model, bundle, placesById],
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

  const syncSemanticZoom = useCallback((zoom: number): void => {
    const nextLevel = resolveSemanticZoomLevel(zoom);
    if (nextLevel !== semanticZoomRef.current) {
      semanticZoomRef.current = nextLevel;
      setSemanticZoom(nextLevel);
    }
  }, []);

  const markZooming = useCallback((): void => {
    stageRef.current?.classList.add('is-zooming');
    if (zoomSettleTimerRef.current !== null) {
      window.clearTimeout(zoomSettleTimerRef.current);
    }
    zoomSettleTimerRef.current = window.setTimeout(() => {
      zoomSettleTimerRef.current = null;
      stageRef.current?.classList.remove('is-zooming');
    }, 150);
  }, []);

  const cancelMotion = useCallback((): void => {
    if (motionRafRef.current !== null) {
      window.cancelAnimationFrame(motionRafRef.current);
      motionRafRef.current = null;
    }
    animationTargetRef.current = null;
    inertiaSpeedRef.current = 0;
  }, []);

  const writeTransformToDom = useCallback(
    (next: CanvasTransform): void => {
      const stage = stageRef.current;
      if (stage) {
        stage.style.transform = `translate3d(${next.pan.x}px, ${next.pan.y}px, 0) scale(${next.zoom})`;
      }
      const container = containerRef.current;
      if (container) {
        container.dataset.zoom = String(next.zoom);
        container.dataset.panX = String(next.pan.x);
        container.dataset.panY = String(next.pan.y);
      }
      syncSemanticZoom(next.zoom);
    },
    [syncSemanticZoom],
  );

  const applyTransformNow = useCallback(
    (next: CanvasTransform): void => {
      cancelMotion();
      if (rafIdRef.current !== null) {
        window.cancelAnimationFrame(rafIdRef.current);
        rafIdRef.current = null;
      }
      pendingTransformRef.current = null;
      transformRef.current = next;
      writeTransformToDom(next);
    },
    [cancelMotion, writeTransformToDom],
  );

  const scheduleTransform = useCallback(
    (next: CanvasTransform): void => {
      transformRef.current = next;
      pendingTransformRef.current = next;
      if (rafIdRef.current !== null) {
        return;
      }
      rafIdRef.current = window.requestAnimationFrame(() => {
        rafIdRef.current = null;
        const latest = pendingTransformRef.current;
        if (latest) {
          pendingTransformRef.current = null;
          writeTransformToDom(latest);
        }
      });
    },
    [writeTransformToDom],
  );

  useEffect(
    () => (): void => {
      if (rafIdRef.current !== null) {
        window.cancelAnimationFrame(rafIdRef.current);
        rafIdRef.current = null;
      }
      if (motionRafRef.current !== null) {
        window.cancelAnimationFrame(motionRafRef.current);
        motionRafRef.current = null;
      }
      if (zoomSettleTimerRef.current !== null) {
        window.clearTimeout(zoomSettleTimerRef.current);
        zoomSettleTimerRef.current = null;
      }
    },
    [],
  );

  // Only lock viewport scrolling when in 2D Diagram surface so Portrait Roll uses native vertical scroll
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

  // Escape key clears active lineage focus
  useEffect(() => {
    if (!selectedPersonId || createPersonOpen) {
      return undefined;
    }
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        setSelectedPersonId(null);
        setLiveAnnouncement('Lineage focus cleared.');
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return (): void => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [selectedPersonId, createPersonOpen]);

  const readContainerOffset = useCallback((forceRefresh: boolean) => {
    const now = performance.now();
    if (!forceRefresh && now - containerRectRef.current.ts < 250) {
      return containerRectRef.current;
    }
    const rect = containerRef.current?.getBoundingClientRect();
    const next = {
      left: rect?.left ?? 0,
      top: rect?.top ?? 0,
      width: rect?.width || 1200,
      height: rect?.height || 760,
      ts: now,
    };
    containerRectRef.current = next;
    return next;
  }, []);

  const clampTransform = useCallback(
    (next: CanvasTransform): CanvasTransform => {
      const el = containerRef.current;
      const viewport = {
        width: el ? el.clientWidth : containerRectRef.current.width,
        height: el ? el.clientHeight : containerRectRef.current.height,
      };
      return {
        zoom: next.zoom,
        pan: clampPan(next.pan, next.zoom, diagramLayout.bounds, viewport),
      };
    },
    [diagramLayout.bounds],
  );

  const animateToTransform = useCallback(
    (target: CanvasTransform, durationMs = 200): void => {
      const clampedTarget = clampTransform(target);
      if (
        durationMs <= 0 ||
        (typeof window !== 'undefined' &&
          typeof window.matchMedia === 'function' &&
          window.matchMedia('(prefers-reduced-motion: reduce)').matches)
      ) {
        applyTransformNow(clampedTarget);
        return;
      }
      cancelMotion();
      if (rafIdRef.current !== null) {
        window.cancelAnimationFrame(rafIdRef.current);
        rafIdRef.current = null;
      }
      pendingTransformRef.current = null;

      const { current: start } = transformRef;
      animationTargetRef.current = clampedTarget;
      const startTime = performance.now();
      const isScaleChanging = Math.abs(clampedTarget.zoom - start.zoom) > 0.001;
      if (isScaleChanging) {
        markZooming();
      }

      const tick = (now: number): void => {
        const progress = Math.min(1, (now - startTime) / durationMs);
        const eased = 1 - (1 - progress) ** 3;
        const frame: CanvasTransform = {
          zoom: Number((start.zoom + (clampedTarget.zoom - start.zoom) * eased).toFixed(3)),
          pan: {
            x: Number((start.pan.x + (clampedTarget.pan.x - start.pan.x) * eased).toFixed(2)),
            y: Number((start.pan.y + (clampedTarget.pan.y - start.pan.y) * eased).toFixed(2)),
          },
        };
        transformRef.current = frame;
        writeTransformToDom(frame);
        if (isScaleChanging) {
          markZooming();
        }
        if (progress < 1) {
          motionRafRef.current = window.requestAnimationFrame(tick);
        } else {
          motionRafRef.current = null;
          animationTargetRef.current = null;
          transformRef.current = clampedTarget;
          writeTransformToDom(clampedTarget);
        }
      };
      motionRafRef.current = window.requestAnimationFrame(tick);
    },
    [applyTransformNow, cancelMotion, clampTransform, markZooming, writeTransformToDom],
  );

  const startInertia = useCallback(
    (initialVx: number, initialVy: number): void => {
      cancelMotion();
      let vx = initialVx;
      let vy = initialVy;
      let lastTime = performance.now();
      inertiaSpeedRef.current = Math.hypot(vx, vy);

      const tick = (now: number): void => {
        const dt = now - lastTime;
        lastTime = now;
        const { current } = transformRef;
        const { next, done } = stepInertia({ pan: current.pan, vx, vy }, dt);
        const clamped = clampTransform({ zoom: current.zoom, pan: next.pan });

        vx = Math.abs(clamped.pan.x - next.pan.x) > 0.5 ? 0 : next.vx;
        vy = Math.abs(clamped.pan.y - next.pan.y) > 0.5 ? 0 : next.vy;
        const speed = Math.hypot(vx, vy);
        inertiaSpeedRef.current = speed;

        transformRef.current = clamped;
        writeTransformToDom(clamped);

        if (done || speed < 0.025) {
          motionRafRef.current = null;
          inertiaSpeedRef.current = 0;
        } else {
          motionRafRef.current = window.requestAnimationFrame(tick);
        }
      };
      motionRafRef.current = window.requestAnimationFrame(tick);
    },
    [cancelMotion, clampTransform, writeTransformToDom],
  );

  const computeFitTransform = useCallback((): CanvasTransform => {
    const el = containerRef.current;
    const vw = el ? el.clientWidth : 1200;
    const vh = el ? el.clientHeight : 760;
    const gw = Math.max(400, diagramLayout.bounds.maxX - diagramLayout.bounds.minX);
    const gh = Math.max(400, diagramLayout.bounds.maxY - diagramLayout.bounds.minY);
    const padX = vw < 640 ? 24 : 56;
    const padY = vw < 640 ? 92 : 108;
    const nextZoom = Math.max(0.28, Math.min(1, Math.min((vw - padX) / gw, (vh - padY) / gh)));
    const nextX = (vw - gw * nextZoom) / 2 - diagramLayout.bounds.minX * nextZoom;
    const nextY = Math.max(vw < 640 ? 60 : 66, (vh - gh * nextZoom) / 2);
    return {
      zoom: Number(nextZoom.toFixed(2)),
      pan: { x: Math.round(nextX), y: Math.round(nextY) },
    };
  }, [
    diagramLayout.bounds.maxX,
    diagramLayout.bounds.minX,
    diagramLayout.bounds.maxY,
    diagramLayout.bounds.minY,
  ]);

  const fitToViewport = useCallback(() => {
    applyTransformNow(computeFitTransform());
  }, [applyTransformNow, computeFitTransform]);

  const animateFitToViewport = useCallback(() => {
    animateToTransform(computeFitTransform(), 210);
  }, [animateToTransform, computeFitTransform]);

  const handleToggleUnionSiblings = useCallback(
    (unionId: string): void => {
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
    },
    [],
  );

  const handleSelectPerson = useCallback(
    (person: Person, fromKeyboard = false): void => {
      if (surface === 'diagram' && !fromKeyboard && didDragMoveRef.current) {
        return;
      }
      setSelectedPersonId(person.id);
      setLiveAnnouncement(`Focused ${person.full_name} and traced direct lineage.`);
    },
    [surface],
  );

  const handleClearFocus = useCallback((): void => {
    setSelectedPersonId(null);
    setLiveAnnouncement('Lineage focus cleared.');
  }, []);

  const centerDiagramOnPerson = useCallback(
    (personId: string, animate: boolean): boolean => {
      let cx: number | null = null;
      let cy: number | null = null;
      const targetNode = diagramLayout.byId.get(personId);
      if (targetNode) {
        cx = targetNode.x + ARCHIVAL_NODE_W / 2;
        cy = targetNode.y + ARCHIVAL_NODE_H / 2;
      } else {
        for (const strip of diagramLayout.earlyLossStrips) {
          const chip = strip.chips.find((c) => c.person.id === personId);
          if (chip) {
            cx = chip.x + chip.width / 2;
            cy = chip.y + chip.height / 2;
            break;
          }
        }
      }
      if (cx === null || cy === null) {
        return false;
      }
      const el = containerRef.current;
      const vw = el?.clientWidth || (typeof window !== 'undefined' ? window.innerWidth : 1200);
      const vh = el?.clientHeight || (typeof window !== 'undefined' ? window.innerHeight : 760);
      const isCompact = vw < 768;
      const targetZoom = isCompact
        ? 0.88
        : Number(Math.max(0.92, Math.min(1.05, transformRef.current.zoom)).toFixed(2));
      const focalX = isCompact ? vw / 2 : Math.max(vw * 0.36, (vw - 320) / 2);
      const focalY = isCompact ? vh * 0.36 : vh * 0.46;
      const targetTransform: CanvasTransform = {
        zoom: targetZoom,
        pan: {
          x: Math.round(focalX - cx * targetZoom),
          y: Math.round(focalY - cy * targetZoom),
        },
      };
      if (animate) {
        animateToTransform(targetTransform, 240);
      } else {
        applyTransformNow(clampTransform(targetTransform));
      }
      return true;
    },
    [animateToTransform, applyTransformNow, clampTransform, diagramLayout.byId, diagramLayout.earlyLossStrips],
  );

  const scrollRollToPerson = useCallback((personId: string): boolean => {
    const root = containerRef.current;
    if (!root) {
      return false;
    }
    const buttons = root.querySelectorAll<HTMLElement>('[data-person-id]');
    let target: HTMLElement | null = null;
    for (const el of buttons) {
      if (el.dataset.personId === personId) {
        target = el;
        break;
      }
    }
    if (!target) {
      return false;
    }
    const prefersReduced =
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (typeof target.scrollIntoView === 'function') {
      target.scrollIntoView({
        behavior: prefersReduced ? 'auto' : 'smooth',
        block: 'center',
      });
    }
    return true;
  }, []);

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
    [branchFilter, defaultBranchId, mode, model],
  );

  // Handle ?focus=<slug> deep link, search-to-focus centering, and fit-to-viewport when layout/surface changes
  useLayoutEffect(() => {
    if (!bundle) {
      return;
    }
    const focusSlug = searchParams.get('focus');
    if (focusSlug && appliedFocusSlugRef.current !== focusSlug) {
      const targetPerson = bundle.people.find(
        (p) => p.slug === focusSlug && !isRedactedLivingPlaceholder(p),
      );
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
          ? centerDiagramOnPerson(pendingId, lastFitKeyRef.current === fitKey)
          : scrollRollToPerson(pendingId);
      if (centered) {
        pendingFocusPersonIdRef.current = null;
        lastFitKeyRef.current = fitKey;
        return;
      }
    }

    if (surface === 'diagram' && diagramLayout.nodes.length > 0 && lastFitKeyRef.current !== fitKey) {
      lastFitKeyRef.current = fitKey;
      fitToViewport();
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
    centerDiagramOnPerson,
    scrollRollToPerson,
    handleFocusAndCenterPerson,
    fitToViewport,
  ]);

  const isReady = !loading && Boolean(bundle);

  useEffect(() => {
    const el = containerRef.current;
    if (!isReady || surface !== 'diagram' || !el) {
      return undefined;
    }
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault();
      cancelMotion();
      const offset = readContainerOffset(false);
      const focalPoint = { x: e.clientX - offset.left, y: e.clientY - offset.top };
      const { current } = transformRef;
      const targetZoom = computeWheelTargetZoom(current.zoom, e.deltaY, e.ctrlKey);
      const next = clampTransform(
        computeZoomAroundPoint({
          currentPan: current.pan,
          currentZoom: current.zoom,
          targetZoom,
          focalPoint,
        }),
      );
      markZooming();
      scheduleTransform(next);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return (): void => {
      el.removeEventListener('wheel', onWheel);
    };
  }, [
    isReady,
    surface,
    cancelMotion,
    clampTransform,
    markZooming,
    readContainerOffset,
    scheduleTransform,
  ]);

  const setDraggingClass = useCallback((active: boolean): void => {
    containerRef.current?.classList.toggle('is-dragging', active);
  }, []);

  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLElement>): void => {
      if (surface !== 'diagram') {
        return;
      }
      if (
        e.target instanceof Element &&
        e.target.closest(
          'button, a, select, input, .tree-toolbar, .tree-toolbar-shell, .tree-search-popover, .tree-popover, .tree-controls, .tree-diagram-sibling-btn',
        )
      ) {
        return;
      }
      const wasFastCoasting = inertiaSpeedRef.current > 0.15;
      cancelMotion();

      const offset = readContainerOffset(true);
      const localPt = {
        x: e.clientX - offset.left,
        y: e.clientY - offset.top,
      };
      activePointersRef.current.set(e.pointerId, localPt);

      const { current } = transformRef;
      if (activePointersRef.current.size === 1) {
        didDragMoveRef.current = wasFastCoasting;
        velocitySamplesRef.current = [{ x: localPt.x, y: localPt.y, t: performance.now() }];
        setDraggingClass(true);
        dragStartRef.current = {
          x: localPt.x,
          y: localPt.y,
          panX: current.pan.x,
          panY: current.pan.y,
          pointerType: e.pointerType,
        };
        pinchStartRef.current = null;
      } else if (activePointersRef.current.size === 2) {
        didDragMoveRef.current = true;
        lastCanvasTapRef.current = null;
        velocitySamplesRef.current = [];
        const [p1, p2] = [...activePointersRef.current.values()];
        setDraggingClass(false);
        dragStartRef.current = null;
        pinchStartRef.current = {
          startDist: distanceBetween(p1, p2),
          startZoom: current.zoom,
          startPan: { ...current.pan },
          startMidpoint: midpointBetween(p1, p2),
        };
        markZooming();
      }
    },
    [surface, cancelMotion, markZooming, readContainerOffset, setDraggingClass],
  );

  const handlePointerMoveNative = useCallback(
    (e: PointerEvent): void => {
      if (surface !== 'diagram' || !activePointersRef.current.has(e.pointerId)) {
        return;
      }
      const offset = containerRectRef.current;
      const localPt = {
        x: e.clientX - offset.left,
        y: e.clientY - offset.top,
      };
      activePointersRef.current.set(e.pointerId, localPt);

      if (activePointersRef.current.size === 2 && pinchStartRef.current) {
        const [p1, p2] = [...activePointersRef.current.values()];
        didDragMoveRef.current = true;
        const next = clampTransform(
          computePinchTransform({
            startDist: pinchStartRef.current.startDist,
            currentDist: distanceBetween(p1, p2),
            startZoom: pinchStartRef.current.startZoom,
            startPan: pinchStartRef.current.startPan,
            startMidpoint: pinchStartRef.current.startMidpoint,
            currentMidpoint: midpointBetween(p1, p2),
          }),
        );
        markZooming();
        scheduleTransform(next);
      } else if (activePointersRef.current.size === 1 && dragStartRef.current) {
        const now = performance.now();
        if (now - pinchReleaseAtRef.current < 80) {
          const { current } = transformRef;
          dragStartRef.current = {
            ...dragStartRef.current,
            x: localPt.x,
            y: localPt.y,
            panX: current.pan.x,
            panY: current.pan.y,
          };
          return;
        }

        const dx = localPt.x - dragStartRef.current.x;
        const dy = localPt.y - dragStartRef.current.y;
        const threshold = dragStartRef.current.pointerType === 'touch' ? 8 : 6;
        if (!didDragMoveRef.current && isDragMovement(dx, dy, threshold)) {
          didDragMoveRef.current = true;
        }

        const samples = velocitySamplesRef.current;
        samples.push({ x: localPt.x, y: localPt.y, t: now });
        while (samples.length > 8 || (samples.length > 2 && now - samples[0].t > 95)) {
          samples.shift();
        }

        const next = clampTransform({
          zoom: transformRef.current.zoom,
          pan: {
            x: Number((dragStartRef.current.panX + dx).toFixed(2)),
            y: Number((dragStartRef.current.panY + dy).toFixed(2)),
          },
        });
        scheduleTransform(next);
      }
    },
    [surface, clampTransform, markZooming, scheduleTransform],
  );

  const handlePointerUpNative = useCallback(
    (e: PointerEvent): void => {
      if (!activePointersRef.current.has(e.pointerId)) {
        return;
      }
      const wasPinch = activePointersRef.current.size >= 2;
      const releasePt = activePointersRef.current.get(e.pointerId);
      const isCancel = e.type === 'pointercancel';
      activePointersRef.current.delete(e.pointerId);

      if (activePointersRef.current.size < 2) {
        pinchStartRef.current = null;
      }
      if (activePointersRef.current.size === 1) {
        if (wasPinch) {
          pinchReleaseAtRef.current = performance.now();
        }
        const [remaining] = [...activePointersRef.current.values()];
        const { current } = transformRef;
        velocitySamplesRef.current = [{ x: remaining.x, y: remaining.y, t: performance.now() }];
        dragStartRef.current = {
          x: remaining.x,
          y: remaining.y,
          panX: current.pan.x,
          panY: current.pan.y,
          pointerType: e.pointerType,
        };
        setDraggingClass(true);
      } else {
        const moved = didDragMoveRef.current;
        const samples = velocitySamplesRef.current;
        const now = performance.now();
        dragStartRef.current = null;
        velocitySamplesRef.current = [];
        setDraggingClass(false);

        if (!isCancel && moved && now - pinchReleaseAtRef.current > 140 && samples.length >= 2) {
          const newest = samples.at(-1);
          const [oldest] = samples;
          const dt = newest ? newest.t - oldest.t : 0;
          if (newest && now - newest.t < 65 && dt >= 8) {
            const rawVx = (newest.x - oldest.x) / dt;
            const rawVy = (newest.y - oldest.y) / dt;
            const speed = Math.hypot(rawVx, rawVy);
            if (speed > 0.12) {
              const maxSpeed = 2.6;
              const scale = speed > maxSpeed ? maxSpeed / speed : 1;
              startInertia(rawVx * scale, rawVy * scale);
            }
          }
        } else if (!isCancel && !moved && e.pointerType === 'touch' && releasePt) {
          const isOnNode =
            e.target instanceof Element &&
            Boolean(e.target.closest('.tree-node-card, .tree-diagram-sibling-btn'));
          const prevTap = lastCanvasTapRef.current;
          if (!isOnNode && prevTap && now - prevTap.t < 300 && distanceBetween(prevTap, releasePt) < 34) {
            lastCanvasTapRef.current = null;
            didDragMoveRef.current = true;
            const { current } = transformRef;
            const fit = computeFitTransform();
            const targetZoom = computeDoubleTapZoom(current.zoom, fit.zoom);
            if (Math.abs(targetZoom - fit.zoom) < 0.01) {
              animateToTransform(fit, 210);
            } else {
              animateToTransform(
                computeZoomAroundPoint({
                  currentPan: current.pan,
                  currentZoom: current.zoom,
                  targetZoom,
                  focalPoint: releasePt,
                }),
                210,
              );
            }
          } else if (isOnNode) {
            lastCanvasTapRef.current = null;
          } else {
            lastCanvasTapRef.current = { x: releasePt.x, y: releasePt.y, t: now };
          }
        }

        window.setTimeout(() => {
          didDragMoveRef.current = false;
        }, 0);
      }
    },
    [animateToTransform, computeFitTransform, setDraggingClass, startInertia],
  );

  useEffect(() => {
    if (surface !== 'diagram') {
      return undefined;
    }
    const onWindowBlur = (): void => {
      activePointersRef.current.clear();
      dragStartRef.current = null;
      pinchStartRef.current = null;
      velocitySamplesRef.current = [];
      setDraggingClass(false);
    };
    window.addEventListener('pointermove', handlePointerMoveNative);
    window.addEventListener('pointerup', handlePointerUpNative);
    window.addEventListener('pointercancel', handlePointerUpNative);
    window.addEventListener('blur', onWindowBlur);
    return (): void => {
      window.removeEventListener('pointermove', handlePointerMoveNative);
      window.removeEventListener('pointerup', handlePointerUpNative);
      window.removeEventListener('pointercancel', handlePointerUpNative);
      window.removeEventListener('blur', onWindowBlur);
    };
  }, [surface, handlePointerMoveNative, handlePointerUpNative, setDraggingClass]);

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
    ],
  );

  if (loading || !bundle) {
    return (
      <div>
        <ExplorerTopBar />
        <main className="index-page">
          <output className="archive-loading-shell" aria-live="polite">
            <span className="archive-loading-spinner" aria-hidden="true" />
            <span>{KINLOOM_VOCABULARY.tree.loading}</span>
          </output>
        </main>
      </div>
    );
  }

  const activeCount = branchCounts[branchFilter] ?? model.totalVisibleCount;

  return (
    <div className={`tree-shell tree-shell-${surface}`}>
      <ExplorerTopBar />
      {/* oxlint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-noninteractive-element-interactions -- interactive pan/zoom container clears selection on background click */}
      <main
        ref={containerRef}
        className={`tree-page tree-page-${surface}`}
        data-surface={surface}
        data-mode={model.effectiveMode}
        onPointerDown={handlePointerDown}
        onClick={(e) => {
          if (surface !== 'diagram') {
            return;
          }
          if (
            e.target instanceof Element &&
            e.target.closest(
              'button, a, select, input, .tree-toolbar, .tree-toolbar-shell, .tree-search-popover, .tree-popover, .tree-controls, .tree-node-card, .tree-diagram-sibling-btn',
            )
          ) {
            return;
          }
          if (!didDragMoveRef.current) {
            setSelectedPersonId(null);
          }
        }}
      >
        <h1 className="visually-hidden">{activeBranchLabel} Family Tree</h1>

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

        {surface === 'roll' ? (
          <TreePedigreeRoll
            model={model}
            spotlight={spotlight}
            selectedPersonId={selectedPerson?.id ?? null}
            personThumbMap={personThumbMap}
            baseUrl={baseUrl}
            familyLabel={activeBranchLabel}
            onSelectPerson={(person) => {
              handleSelectPerson(person, true);
            }}
            onToggleUnionSiblings={handleToggleUnionSiblings}
          />
        ) : (
          <>
            <div ref={stageRef} className="tree-stage" style={stageStyle}>
              <TreeOrthogonalCanvas
                layout={diagramLayout}
                spotlight={spotlight}
                selectedPersonId={selectedPerson?.id ?? null}
                semanticZoom={semanticZoom}
                activeBranchLabel={activeBranchLabel}
                personThumbMap={personThumbMap}
                baseUrl={baseUrl}
                onSelectPerson={handleSelectPerson}
                onToggleUnionSiblings={handleToggleUnionSiblings}
              />
            </div>

            <div
              className="tree-controls"
              role="group"
              aria-label={KINLOOM_VOCABULARY.tree.zoomControlsAria}
            >
              <button
                type="button"
                className="pill-btn"
                aria-label="Zoom in"
                onClick={() => {
                  const el = containerRef.current;
                  const focal = {
                    x: (el?.clientWidth ?? 800) / 2,
                    y: (el?.clientHeight ?? 600) / 2,
                  };
                  const base = animationTargetRef.current ?? transformRef.current;
                  const next = computeZoomAroundPoint({
                    currentPan: base.pan,
                    currentZoom: base.zoom,
                    targetZoom: base.zoom * 1.28,
                    focalPoint: focal,
                  });
                  animateToTransform(next, 180);
                }}
              >
                +
              </button>
              <button
                type="button"
                className="pill-btn"
                aria-label="Zoom out"
                onClick={() => {
                  const el = containerRef.current;
                  const focal = {
                    x: (el?.clientWidth ?? 800) / 2,
                    y: (el?.clientHeight ?? 600) / 2,
                  };
                  const base = animationTargetRef.current ?? transformRef.current;
                  const next = computeZoomAroundPoint({
                    currentPan: base.pan,
                    currentZoom: base.zoom,
                    targetZoom: base.zoom / 1.28,
                    focalPoint: focal,
                  });
                  animateToTransform(next, 180);
                }}
              >
                −
              </button>
              <button type="button" className="pill-btn" onClick={animateFitToViewport}>
                Fit
              </button>
              <button
                type="button"
                className="pill-btn"
                aria-label="Reset zoom to 100%"
                onClick={() => {
                  const el = containerRef.current;
                  const focal = {
                    x: (el?.clientWidth ?? 800) / 2,
                    y: (el?.clientHeight ?? 600) / 2,
                  };
                  const base = animationTargetRef.current ?? transformRef.current;
                  animateToTransform(
                    computeZoomAroundPoint({
                      currentPan: base.pan,
                      currentZoom: base.zoom,
                      targetZoom: 1,
                      focalPoint: focal,
                    }),
                    180,
                  );
                }}
              >
                1:1
              </button>
            </div>
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

        <output className="visually-hidden" aria-live="polite">
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
