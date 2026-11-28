import type React from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ArchivalDiagramLayout, SemanticZoomLevel } from '../../lib/archivalTreeModel.js';
import {
  ARCHIVAL_NODE_H,
  ARCHIVAL_NODE_W,
  MOBILE_TREE_BREAKPOINT_PX,
  resolveSemanticZoomLevel,
} from '../../lib/archivalTreeModel.js';
import type { CanvasTransform } from '../../lib/treeGestures.js';
import { clampPan, computeZoomAroundPoint, stepInertia } from '../../lib/treeGestures.js';
import { INITIAL_TREE_TRANSFORM } from './treePageHelpers.js';

export const LARGE_TREE_PEOPLE_THRESHOLD = 40;
export const LARGE_TREE_GENERATION_THRESHOLD = 8;
export const MIN_READABLE_INITIAL_ZOOM = 0.75;
const MIN_FIT_ZOOM = 0.05;

export interface ContainerOffsetRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
  readonly ts: number;
}

export interface SafeViewportInsets {
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly left: number;
  readonly viewportWidth: number;
  readonly viewportHeight: number;
}

export interface ViewportSnapshot {
  readonly pan: { readonly x: number; readonly y: number };
  readonly zoom: number;
  readonly viewportWidth: number;
  readonly viewportHeight: number;
}

export interface InitialViewportRequest {
  readonly pivotPersonId: string | null;
  readonly totalVisibleCount: number;
  readonly generationCount: number;
}

export interface TreeViewportTransformEngine {
  readonly semanticZoom: SemanticZoomLevel;
  readonly zoomPercent: number;
  readonly transformRef: React.RefObject<CanvasTransform>;
  readonly animationTargetRef: React.RefObject<CanvasTransform | null>;
  readonly inertiaSpeedRef: React.RefObject<number>;
  readonly containerRectRef: React.RefObject<ContainerOffsetRect>;
  readonly markZooming: () => void;
  readonly cancelMotion: () => void;
  readonly scheduleTransform: (next: CanvasTransform) => void;
  readonly readContainerOffset: (forceRefresh: boolean) => ContainerOffsetRect;
  readonly measureSafeInsets: () => SafeViewportInsets;
  readonly clampTransform: (next: CanvasTransform) => CanvasTransform;
  readonly animateToTransform: (target: CanvasTransform, durationMs?: number) => void;
  readonly startInertia: (initialVx: number, initialVy: number) => void;
  readonly computeFitTransform: () => CanvasTransform;
  readonly computeInitialTransform: (req: InitialViewportRequest) => CanvasTransform;
  readonly applyInitialViewport: (req: InitialViewportRequest) => void;
  readonly fitToViewport: () => void;
  readonly animateFitToViewport: () => void;
  readonly centerDiagramOnPoint: (graphX: number, graphY: number, animate?: boolean) => void;
  readonly centerDiagramOnPerson: (personId: string, animate: boolean) => boolean;
  readonly scrollRollToPerson: (personId: string) => boolean;
  readonly handleDiagramZoomBy: (factor: number) => void;
  readonly handleDiagramResetZoom: () => void;
  readonly getViewportSnapshot: () => ViewportSnapshot;
  readonly subscribeTransform: (listener: (snapshot: ViewportSnapshot) => void) => () => void;
}

export function useTreeViewportTransform(params: {
  readonly diagramLayout: ArchivalDiagramLayout;
  readonly containerRef: React.RefObject<HTMLElement | null>;
  readonly stageRef: React.RefObject<HTMLDivElement | null>;
  readonly toolbarRef?: React.RefObject<HTMLDivElement | null>;
  readonly controlsRef?: React.RefObject<HTMLDivElement | null>;
}): TreeViewportTransformEngine {
  const { diagramLayout, containerRef, stageRef, toolbarRef, controlsRef } = params;
  const [semanticZoom, setSemanticZoom] = useState<SemanticZoomLevel>(
    resolveSemanticZoomLevel(INITIAL_TREE_TRANSFORM.zoom)
  );
  const [zoomPercent, setZoomPercent] = useState<number>(Math.round(INITIAL_TREE_TRANSFORM.zoom * 100));

  const semanticZoomRef = useRef<SemanticZoomLevel>(semanticZoom);
  const zoomPercentRef = useRef<number>(Math.round(INITIAL_TREE_TRANSFORM.zoom * 100));
  const transformRef = useRef<CanvasTransform>(INITIAL_TREE_TRANSFORM);
  const animationTargetRef = useRef<CanvasTransform | null>(null);
  const pendingTransformRef = useRef<CanvasTransform | null>(null);
  const rafIdRef = useRef<number | null>(null);
  const motionRafRef = useRef<number | null>(null);
  const inertiaSpeedRef = useRef(0);
  const zoomSettleTimerRef = useRef<number | null>(null);
  const listenersRef = useRef<Set<(snapshot: ViewportSnapshot) => void>>(new Set());
  const containerRectRef = useRef<ContainerOffsetRect>({
    left: 0,
    top: 0,
    width: 1200,
    height: 760,
    ts: 0,
  });

  const getViewportSize = useCallback((): { width: number; height: number } => {
    const el = containerRef.current;
    const width =
      el && el.clientWidth > 0
        ? el.clientWidth
        : typeof window !== 'undefined' && window.innerWidth > 0
          ? window.innerWidth
          : 1200;
    const height =
      el && el.clientHeight > 0
        ? el.clientHeight
        : typeof window !== 'undefined' && window.innerHeight > 0
          ? window.innerHeight
          : 760;
    return { width, height };
  }, [containerRef]);

  const getViewportSnapshot = useCallback((): ViewportSnapshot => {
    const { width, height } = getViewportSize();
    const { current } = transformRef;
    return {
      pan: { x: current.pan.x, y: current.pan.y },
      zoom: current.zoom,
      viewportWidth: width,
      viewportHeight: height,
    };
  }, [getViewportSize]);

  const notifySubscribers = useCallback(
    (next: CanvasTransform): void => {
      if (listenersRef.current.size === 0) {
        return;
      }
      const { width, height } = getViewportSize();
      const snapshot: ViewportSnapshot = {
        pan: { x: next.pan.x, y: next.pan.y },
        zoom: next.zoom,
        viewportWidth: width,
        viewportHeight: height,
      };
      for (const listener of listenersRef.current) {
        listener(snapshot);
      }
    },
    [getViewportSize]
  );

  const subscribeTransform = useCallback((listener: (snapshot: ViewportSnapshot) => void): (() => void) => {
    listenersRef.current.add(listener);
    return (): void => {
      listenersRef.current.delete(listener);
    };
  }, []);

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
  }, [stageRef]);

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
        container.dataset['zoom'] = String(next.zoom);
        container.dataset['panX'] = String(next.pan.x);
        container.dataset['panY'] = String(next.pan.y);
      }
      syncSemanticZoom(next.zoom);
      const nextPercent = Math.round(next.zoom * 100);
      if (nextPercent !== zoomPercentRef.current) {
        zoomPercentRef.current = nextPercent;
        setZoomPercent(nextPercent);
      }
      notifySubscribers(next);
    },
    [containerRef, notifySubscribers, stageRef, syncSemanticZoom]
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
    [cancelMotion, writeTransformToDom]
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
    [writeTransformToDom]
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
    []
  );

  const readContainerOffset = useCallback(
    (forceRefresh: boolean): ContainerOffsetRect => {
      const now = performance.now();
      if (!forceRefresh && now - containerRectRef.current.ts < 250) {
        return containerRectRef.current;
      }
      const rect = containerRef.current?.getBoundingClientRect();
      const next: ContainerOffsetRect = {
        left: rect?.left ?? 0,
        top: rect?.top ?? 0,
        width: rect?.width || 1200,
        height: rect?.height || 760,
        ts: now,
      };
      containerRectRef.current = next;
      return next;
    },
    [containerRef]
  );

  const measureSafeInsets = useCallback((): SafeViewportInsets => {
    const container = containerRef.current;
    const { width: vw, height: vh } = getViewportSize();
    const isNarrow = vw < MOBILE_TREE_BREAKPOINT_PX;

    let top = isNarrow ? 116 : 68;
    const toolbarEl =
      toolbarRef?.current ?? container?.querySelector<HTMLElement>('.tree-toolbar-shell') ?? null;
    if (toolbarEl && container) {
      const tbRect = toolbarEl.getBoundingClientRect();
      const cRect = container.getBoundingClientRect();
      const bottomInContainer =
        tbRect.height > 0 ? tbRect.bottom - cRect.top : toolbarEl.offsetTop + toolbarEl.offsetHeight;
      if (bottomInContainer > 0) {
        top = Math.ceil(bottomInContainer + 12);
      }
    }

    let right = isNarrow ? 64 : 84;
    const ctrlEl = controlsRef?.current ?? container?.querySelector<HTMLElement>('.tree-controls') ?? null;
    if (ctrlEl) {
      const ctrlRect = ctrlEl.getBoundingClientRect();
      const measuredCtrlW = ctrlRect.width > 0 ? ctrlRect.width : ctrlEl.offsetWidth;
      if (measuredCtrlW > 0) {
        right = Math.ceil(measuredCtrlW + (isNarrow ? 20 : 28));
      }
    }

    const left = isNarrow ? 12 : 20;
    const bottom = isNarrow ? 18 : 24;
    return { top, right, bottom, left, viewportWidth: vw, viewportHeight: vh };
  }, [containerRef, controlsRef, getViewportSize, toolbarRef]);

  // Keep G1 clear of the toolbar when responsive toolbar wrapping changes its measured height.
  useEffect(() => {
    if (typeof ResizeObserver === 'undefined') {
      return undefined;
    }
    const container = containerRef.current;
    const toolbarEl =
      toolbarRef?.current ?? container?.querySelector<HTMLElement>('.tree-toolbar-shell') ?? null;
    if (!toolbarEl) {
      return undefined;
    }
    const observer = new ResizeObserver(() => {
      const insets = measureSafeInsets();
      const current = transformRef.current;
      const firstBandY = diagramLayout.genBands[0]?.y;
      if (firstBandY !== undefined) {
        const renderedFirstBandTop = firstBandY * current.zoom + current.pan.y;
        if (renderedFirstBandTop < insets.top && current.pan.y >= 0 && current.pan.y < insets.top) {
          const shiftedY = Math.ceil(insets.top - firstBandY * current.zoom);
          if (shiftedY > current.pan.y) {
            applyTransformNow({
              zoom: current.zoom,
              pan: { x: current.pan.x, y: shiftedY },
            });
            return;
          }
        }
      }
      notifySubscribers(current);
    });
    observer.observe(toolbarEl);
    if (container) {
      observer.observe(container);
    }
    return (): void => {
      observer.disconnect();
    };
  }, [
    applyTransformNow,
    containerRef,
    diagramLayout.genBands,
    measureSafeInsets,
    notifySubscribers,
    toolbarRef,
  ]);

  const clampTransform = useCallback(
    (next: CanvasTransform): CanvasTransform => {
      const viewport = getViewportSize();
      return {
        zoom: next.zoom,
        pan: clampPan(next.pan, next.zoom, diagramLayout.bounds, viewport),
      };
    },
    [diagramLayout.bounds, getViewportSize]
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
    [applyTransformNow, cancelMotion, clampTransform, markZooming, writeTransformToDom]
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
    [cancelMotion, clampTransform, writeTransformToDom]
  );

  const computeFitTransform = useCallback((): CanvasTransform => {
    const insets = measureSafeInsets();
    const safeW = Math.max(120, insets.viewportWidth - insets.left - insets.right);
    const safeH = Math.max(120, insets.viewportHeight - insets.top - insets.bottom);
    const gw = Math.max(1, diagramLayout.bounds.maxX - diagramLayout.bounds.minX);
    const gh = Math.max(1, diagramLayout.bounds.maxY - diagramLayout.bounds.minY);
    const rawZoom = Math.min(safeW / gw, safeH / gh);
    const nextZoom = Math.max(MIN_FIT_ZOOM, Math.min(1, Math.floor(rawZoom * 1000) / 1000));
    const nextX = insets.left + (safeW - gw * nextZoom) / 2 - diagramLayout.bounds.minX * nextZoom;
    const nextY = insets.top + (safeH - gh * nextZoom) / 2 - diagramLayout.bounds.minY * nextZoom;
    return {
      zoom: Number(nextZoom.toFixed(3)),
      pan: { x: Math.round(nextX), y: Math.round(nextY) },
    };
  }, [
    diagramLayout.bounds.maxX,
    diagramLayout.bounds.minX,
    diagramLayout.bounds.maxY,
    diagramLayout.bounds.minY,
    measureSafeInsets,
  ]);

  const computeInitialTransform = useCallback(
    (req: InitialViewportRequest): CanvasTransform => {
      const fit = computeFitTransform();
      const needsReadableFocus =
        req.totalVisibleCount > LARGE_TREE_PEOPLE_THRESHOLD ||
        req.generationCount > LARGE_TREE_GENERATION_THRESHOLD ||
        fit.zoom < MIN_READABLE_INITIAL_ZOOM;

      if (!needsReadableFocus) {
        return fit;
      }

      const focalNode =
        (req.pivotPersonId ? diagramLayout.byId.get(req.pivotPersonId) : undefined) ??
        diagramLayout.nodes.find((n) => n.isDirect) ??
        diagramLayout.nodes[0];
      if (!focalNode) {
        return fit;
      }

      const insets = measureSafeInsets();
      const isNarrow = insets.viewportWidth < MOBILE_TREE_BREAKPOINT_PX;
      const targetZoom = isNarrow ? 0.82 : 0.88;
      const safeW = Math.max(120, insets.viewportWidth - insets.left - insets.right);
      const safeH = Math.max(120, insets.viewportHeight - insets.top - insets.bottom);
      const focalX = insets.left + safeW / 2;
      const focalY = insets.top + safeH * 0.42;

      const cx = focalNode.x + focalNode.width / 2;
      const cy = focalNode.y + focalNode.height / 2;
      let panY = Math.round(focalY - cy * targetZoom);
      const firstBandY = diagramLayout.genBands[0]?.y;
      if (firstBandY !== undefined && focalNode.gen === diagramLayout.genBands[0]?.gen) {
        const minPanYForG1 = Math.ceil(insets.top - firstBandY * targetZoom);
        if (panY < minPanYForG1) {
          panY = minPanYForG1;
        }
      } else if (!isNarrow && diagramLayout.genBands.length > 0) {
        // Prevent any partially visible ancestor band from sitting behind the desktop floating toolbar.
        const overlappingBand = diagramLayout.genBands.find((band) => {
          const renderedTop = band.y * targetZoom + panY;
          const renderedBottom = (band.y + ARCHIVAL_NODE_H) * targetZoom + panY;
          return renderedTop < insets.top && renderedBottom > 0;
        });
        if (overlappingBand) {
          const shift = Math.ceil(insets.top - (overlappingBand.y * targetZoom + panY));
          const shiftedFocalBottom = (focalNode.y + focalNode.height) * targetZoom + (panY + shift);
          if (shift > 0 && shiftedFocalBottom <= insets.viewportHeight - insets.bottom) {
            panY += shift;
          }
        }
      }

      return clampTransform({
        zoom: targetZoom,
        pan: {
          x: Math.round(focalX - cx * targetZoom),
          y: panY,
        },
      });
    },
    [
      clampTransform,
      computeFitTransform,
      diagramLayout.byId,
      diagramLayout.genBands,
      diagramLayout.nodes,
      measureSafeInsets,
    ]
  );

  const applyInitialViewport = useCallback(
    (req: InitialViewportRequest) => {
      applyTransformNow(computeInitialTransform(req));
    },
    [applyTransformNow, computeInitialTransform]
  );

  const fitToViewport = useCallback(() => {
    applyTransformNow(computeFitTransform());
  }, [applyTransformNow, computeFitTransform]);

  const animateFitToViewport = useCallback(() => {
    animateToTransform(computeFitTransform(), 210);
  }, [animateToTransform, computeFitTransform]);

  const centerDiagramOnPoint = useCallback(
    (graphX: number, graphY: number, animate = false): void => {
      const insets = measureSafeInsets();
      const safeW = Math.max(120, insets.viewportWidth - insets.left - insets.right);
      const safeH = Math.max(120, insets.viewportHeight - insets.top - insets.bottom);
      const currentZoom = transformRef.current.zoom;
      const target: CanvasTransform = {
        zoom: currentZoom,
        pan: {
          x: Math.round(insets.left + safeW / 2 - graphX * currentZoom),
          y: Math.round(insets.top + safeH / 2 - graphY * currentZoom),
        },
      };
      if (animate) {
        animateToTransform(target, 180);
      } else {
        applyTransformNow(clampTransform(target));
      }
    },
    [animateToTransform, applyTransformNow, clampTransform, measureSafeInsets]
  );

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
      const insets = measureSafeInsets();
      const vw = insets.viewportWidth;
      const vh = insets.viewportHeight;
      const isCompact = vw < MOBILE_TREE_BREAKPOINT_PX;
      const targetZoom = isCompact
        ? 0.88
        : Number(Math.max(0.92, Math.min(1.05, transformRef.current.zoom)).toFixed(2));
      const focalX = isCompact ? vw / 2 : Math.max(vw * 0.36, (vw - 320) / 2);
      const safeH = Math.max(120, vh - insets.top - insets.bottom);
      const focalY = insets.top + safeH * (isCompact ? 0.36 : 0.44);
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
    [
      animateToTransform,
      applyTransformNow,
      clampTransform,
      diagramLayout.byId,
      diagramLayout.earlyLossStrips,
      measureSafeInsets,
    ]
  );

  const scrollRollToPerson = useCallback(
    (personId: string): boolean => {
      const root = containerRef.current;
      if (!root) {
        return false;
      }
      const buttons = root.querySelectorAll<HTMLElement>('[data-person-id]');
      let target: HTMLElement | null = null;
      for (const el of buttons) {
        if (el.dataset['personId'] === personId) {
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
    },
    [containerRef]
  );

  const handleDiagramZoomBy = useCallback(
    (factor: number): void => {
      const { width, height } = getViewportSize();
      const focal = { x: width / 2, y: height / 2 };
      const base = animationTargetRef.current ?? transformRef.current;
      const minZoom = Math.min(0.22, computeFitTransform().zoom);
      animateToTransform(
        computeZoomAroundPoint({
          currentPan: base.pan,
          currentZoom: base.zoom,
          targetZoom: base.zoom * factor,
          focalPoint: focal,
          minZoom,
        }),
        180
      );
    },
    [animateToTransform, computeFitTransform, getViewportSize]
  );

  const handleDiagramResetZoom = useCallback((): void => {
    const { width, height } = getViewportSize();
    const focal = { x: width / 2, y: height / 2 };
    const base = animationTargetRef.current ?? transformRef.current;
    animateToTransform(
      computeZoomAroundPoint({
        currentPan: base.pan,
        currentZoom: base.zoom,
        targetZoom: 1,
        focalPoint: focal,
      }),
      180
    );
  }, [animateToTransform, getViewportSize]);

  return {
    semanticZoom,
    zoomPercent,
    transformRef,
    animationTargetRef,
    inertiaSpeedRef,
    containerRectRef,
    markZooming,
    cancelMotion,
    scheduleTransform,
    readContainerOffset,
    measureSafeInsets,
    clampTransform,
    animateToTransform,
    startInertia,
    computeFitTransform,
    computeInitialTransform,
    applyInitialViewport,
    fitToViewport,
    animateFitToViewport,
    centerDiagramOnPoint,
    centerDiagramOnPerson,
    scrollRollToPerson,
    handleDiagramZoomBy,
    handleDiagramResetZoom,
    getViewportSnapshot,
    subscribeTransform,
  };
}
