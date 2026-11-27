import type React from 'react';
import { useCallback, useEffect, useRef } from 'react';
import type { TreeViewSurface } from '../../lib/archivalTreeModel.js';
import type { Point2D } from '../../lib/treeGestures.js';
import {
  computeDoubleTapZoom,
  computePinchTransform,
  computeWheelTargetZoom,
  computeZoomAroundPoint,
  distanceBetween,
  isDragMovement,
  midpointBetween,
} from '../../lib/treeGestures.js';
import type { TreeViewportTransformEngine } from './useTreeViewportTransform.js';

export interface UseTreeCanvasInteractionsParams {
  readonly isReady: boolean;
  readonly surface: TreeViewSurface;
  readonly createPersonOpen: boolean;
  readonly containerRef: React.RefObject<HTMLElement | null>;
  readonly viewport: TreeViewportTransformEngine;
}

export interface TreeCanvasInteractions {
  readonly didDragMoveRef: React.RefObject<boolean>;
  readonly handlePointerDown: (e: React.PointerEvent<HTMLElement>) => void;
}

export function useTreeCanvasInteractions({
  isReady,
  surface,
  createPersonOpen,
  containerRef,
  viewport,
}: UseTreeCanvasInteractionsParams): TreeCanvasInteractions {
  const {
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
    animateFitToViewport,
    handleDiagramZoomBy,
    handleDiagramResetZoom,
  } = viewport;

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

  const setDraggingClass = useCallback(
    (active: boolean): void => {
      containerRef.current?.classList.toggle('is-dragging', active);
    },
    [containerRef]
  );

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
        })
      );
      markZooming();
      scheduleTransform(next);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return (): void => {
      el.removeEventListener('wheel', onWheel);
    };
  }, [
    containerRef,
    isReady,
    surface,
    transformRef,
    cancelMotion,
    clampTransform,
    markZooming,
    readContainerOffset,
    scheduleTransform,
  ]);

  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLElement>): void => {
      if (surface !== 'diagram') {
        return;
      }
      if (
        e.target instanceof Element &&
        e.target.closest(
          'button, a, select, input, .tree-toolbar, .tree-toolbar-shell, .tree-search-popover, .tree-popover, .tree-controls, .tree-minimap, .tree-diagram-sibling-btn'
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
    [surface, inertiaSpeedRef, transformRef, cancelMotion, markZooming, readContainerOffset, setDraggingClass]
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
          })
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
    [surface, containerRectRef, transformRef, clampTransform, markZooming, scheduleTransform]
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
                210
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
    [transformRef, animateToTransform, computeFitTransform, setDraggingClass, startInertia]
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

  useEffect(() => {
    if (surface !== 'diagram' || createPersonOpen) {
      return undefined;
    }
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.metaKey || e.ctrlKey || e.altKey) {
        return;
      }
      const targetEl = e.target instanceof Element ? e.target : null;
      const tag = targetEl?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
        return;
      }
      if (targetEl?.closest('dialog')) {
        return;
      }
      if (e.key === '+' || e.key === '=') {
        e.preventDefault();
        handleDiagramZoomBy(1.28);
      } else if (e.key === '-' || e.key === '_') {
        e.preventDefault();
        handleDiagramZoomBy(1 / 1.28);
      } else if (e.key === '0') {
        e.preventDefault();
        animateFitToViewport();
      } else if (e.key === '1') {
        e.preventDefault();
        handleDiagramResetZoom();
      } else if (
        (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'ArrowUp' || e.key === 'ArrowDown') &&
        !targetEl?.closest('.tree-toolbar, .tree-toolbar-shell, .tree-popover, .topbar')
      ) {
        e.preventDefault();
        const step = 80;
        const base = animationTargetRef.current ?? transformRef.current;
        const dx = e.key === 'ArrowLeft' ? step : e.key === 'ArrowRight' ? -step : 0;
        const dy = e.key === 'ArrowUp' ? step : e.key === 'ArrowDown' ? -step : 0;
        animateToTransform(
          {
            zoom: base.zoom,
            pan: { x: base.pan.x + dx, y: base.pan.y + dy },
          },
          120
        );
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return (): void => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [
    surface,
    createPersonOpen,
    animationTargetRef,
    transformRef,
    handleDiagramZoomBy,
    handleDiagramResetZoom,
    animateFitToViewport,
    animateToTransform,
  ]);

  return { didDragMoveRef, handlePointerDown };
}
