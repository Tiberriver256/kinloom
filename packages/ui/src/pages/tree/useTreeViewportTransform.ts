import type React from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ArchivalDiagramLayout, SemanticZoomLevel } from '../../lib/archivalTreeModel.js';
import { ARCHIVAL_NODE_H, ARCHIVAL_NODE_W, resolveSemanticZoomLevel } from '../../lib/archivalTreeModel.js';
import type { CanvasTransform } from '../../lib/treeGestures.js';
import { clampPan, computeZoomAroundPoint, stepInertia } from '../../lib/treeGestures.js';
import { INITIAL_TREE_TRANSFORM } from './treePageHelpers.js';

export interface ContainerOffsetRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
  readonly ts: number;
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
  readonly clampTransform: (next: CanvasTransform) => CanvasTransform;
  readonly animateToTransform: (target: CanvasTransform, durationMs?: number) => void;
  readonly startInertia: (initialVx: number, initialVy: number) => void;
  readonly computeFitTransform: () => CanvasTransform;
  readonly fitToViewport: () => void;
  readonly animateFitToViewport: () => void;
  readonly centerDiagramOnPerson: (personId: string, animate: boolean) => boolean;
  readonly scrollRollToPerson: (personId: string) => boolean;
  readonly handleDiagramZoomBy: (factor: number) => void;
  readonly handleDiagramResetZoom: () => void;
}

export function useTreeViewportTransform(params: {
  readonly diagramLayout: ArchivalDiagramLayout;
  readonly containerRef: React.RefObject<HTMLElement | null>;
  readonly stageRef: React.RefObject<HTMLDivElement | null>;
}): TreeViewportTransformEngine {
  const { diagramLayout, containerRef, stageRef } = params;
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
  const containerRectRef = useRef<ContainerOffsetRect>({
    left: 0,
    top: 0,
    width: 1200,
    height: 760,
    ts: 0,
  });

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
        container.dataset.zoom = String(next.zoom);
        container.dataset.panX = String(next.pan.x);
        container.dataset.panY = String(next.pan.y);
      }
      syncSemanticZoom(next.zoom);
      const nextPercent = Math.round(next.zoom * 100);
      if (nextPercent !== zoomPercentRef.current) {
        zoomPercentRef.current = nextPercent;
        setZoomPercent(nextPercent);
      }
    },
    [containerRef, stageRef, syncSemanticZoom]
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
    [containerRef, diagramLayout.bounds]
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
    containerRef,
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
    [
      animateToTransform,
      applyTransformNow,
      clampTransform,
      containerRef,
      diagramLayout.byId,
      diagramLayout.earlyLossStrips,
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
    },
    [containerRef]
  );

  const handleDiagramZoomBy = useCallback(
    (factor: number): void => {
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
          targetZoom: base.zoom * factor,
          focalPoint: focal,
        }),
        180
      );
    },
    [animateToTransform, containerRef]
  );

  const handleDiagramResetZoom = useCallback((): void => {
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
      180
    );
  }, [animateToTransform, containerRef]);

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
    clampTransform,
    animateToTransform,
    startInertia,
    computeFitTransform,
    fitToViewport,
    animateFitToViewport,
    centerDiagramOnPerson,
    scrollRollToPerson,
    handleDiagramZoomBy,
    handleDiagramResetZoom,
  };
}
