export interface Point2D {
  x: number;
  y: number;
}

export interface CanvasTransform {
  pan: Point2D;
  zoom: number;
}

export interface ViewportSize {
  width: number;
  height: number;
}

export interface ContentBounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

export interface InertiaState {
  pan: Point2D;
  vx: number;
  vy: number;
}

export const MIN_CANVAS_ZOOM = 0.22;
export const MAX_CANVAS_ZOOM = 2.2;

function roundCoord(value: number): number {
  return Number(value.toFixed(2));
}

export function clampZoom(zoom: number, min = MIN_CANVAS_ZOOM, max = MAX_CANVAS_ZOOM): number {
  return Number(Math.max(min, Math.min(max, zoom)).toFixed(3));
}

export function distanceBetween(a: Point2D, b: Point2D): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

export function midpointBetween(a: Point2D, b: Point2D): Point2D {
  return {
    x: (a.x + b.x) / 2,
    y: (a.y + b.y) / 2,
  };
}

export function isDragMovement(dx: number, dy: number, thresholdPx = 6): boolean {
  return Math.hypot(dx, dy) > thresholdPx;
}

export function clampPan(
  pan: Point2D,
  zoom: number,
  bounds: ContentBounds,
  viewport: ViewportSize,
  marginPx = 80
): Point2D {
  const safeMarginX = Math.min(marginPx, Math.max(24, viewport.width * 0.25));
  const safeMarginY = Math.min(marginPx, Math.max(24, viewport.height * 0.25));
  const contentW = Math.max(0, bounds.maxX - bounds.minX) * zoom;
  const contentH = Math.max(0, bounds.maxY - bounds.minY) * zoom;

  const minX = safeMarginX - bounds.minX * zoom - contentW;
  const maxX = viewport.width - safeMarginX - bounds.minX * zoom;
  const minY = safeMarginY - bounds.minY * zoom - contentH;
  const maxY = viewport.height - safeMarginY - bounds.minY * zoom;

  return {
    x: roundCoord(Math.max(minX, Math.min(maxX, pan.x))),
    y: roundCoord(Math.max(minY, Math.min(maxY, pan.y))),
  };
}

export function computeZoomAroundPoint(params: {
  currentPan: Point2D;
  currentZoom: number;
  targetZoom: number;
  focalPoint: Point2D;
  minZoom?: number;
  maxZoom?: number;
}): CanvasTransform {
  const { currentPan, currentZoom, targetZoom, focalPoint, minZoom, maxZoom } = params;
  const nextZoom = clampZoom(targetZoom, minZoom, maxZoom);
  if (currentZoom <= 0) {
    return { pan: { ...currentPan }, zoom: nextZoom };
  }
  const scaleRatio = nextZoom / currentZoom;
  return {
    zoom: nextZoom,
    pan: {
      x: roundCoord(focalPoint.x - (focalPoint.x - currentPan.x) * scaleRatio),
      y: roundCoord(focalPoint.y - (focalPoint.y - currentPan.y) * scaleRatio),
    },
  };
}

export function computePinchTransform(params: {
  startDist: number;
  currentDist: number;
  startZoom: number;
  startPan: Point2D;
  startMidpoint: Point2D;
  currentMidpoint: Point2D;
  minZoom?: number;
  maxZoom?: number;
}): CanvasTransform {
  const { startDist, currentDist, startZoom, startPan, startMidpoint, currentMidpoint, minZoom, maxZoom } =
    params;

  const safeStartDist = Math.max(1, startDist);
  const nextZoom = clampZoom(startZoom * (currentDist / safeStartDist), minZoom, maxZoom);
  const ratio = nextZoom / Math.max(0.01, startZoom);

  return {
    zoom: nextZoom,
    pan: {
      x: roundCoord(currentMidpoint.x - (startMidpoint.x - startPan.x) * ratio),
      y: roundCoord(currentMidpoint.y - (startMidpoint.y - startPan.y) * ratio),
    },
  };
}

export function computeWheelTargetZoom(
  currentZoom: number,
  deltaY: number,
  isTrackpadPinch: boolean
): number {
  const clampedDelta = Math.max(-180, Math.min(180, deltaY));
  const sensitivity = isTrackpadPinch ? 0.0085 : 0.0018;
  return clampZoom(currentZoom * Math.exp(-clampedDelta * sensitivity));
}

export function computeDoubleTapZoom(currentZoom: number, fitZoom: number): number {
  const zoomOutThreshold = Math.max(1.05, fitZoom * 1.9);
  if (currentZoom >= zoomOutThreshold) {
    return clampZoom(fitZoom);
  }
  return clampZoom(Math.min(1.45, Math.max(0.95, currentZoom * 1.9)));
}

export function stepInertia(
  state: InertiaState,
  dtMs: number,
  frictionPerFrame = 0.925,
  minSpeedPxPerMs = 0.025
): { next: InertiaState; done: boolean } {
  const safeDt = Math.max(0, Math.min(50, dtMs));
  const decay = frictionPerFrame ** (safeDt / 16.667);
  const nextVx = state.vx * decay;
  const nextVy = state.vy * decay;
  const nextPan: Point2D = {
    x: roundCoord(state.pan.x + state.vx * safeDt),
    y: roundCoord(state.pan.y + state.vy * safeDt),
  };
  const speed = Math.hypot(nextVx, nextVy);
  if (speed < minSpeedPxPerMs) {
    return {
      next: { pan: nextPan, vx: 0, vy: 0 },
      done: true,
    };
  }
  return {
    next: { pan: nextPan, vx: nextVx, vy: nextVy },
    done: false,
  };
}
