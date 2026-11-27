export const LIGHTBOX_MIN_ZOOM = 1;
export const LIGHTBOX_MAX_ZOOM = 4;
export const LIGHTBOX_ZOOM_STEP = 0.5;
export const LIGHTBOX_PAN_KEY_STEP_PX = 48;

export interface LightboxPanOffset {
  readonly x: number;
  readonly y: number;
}

export function clampLightboxZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) {
    return LIGHTBOX_MIN_ZOOM;
  }
  const rounded = Math.round(zoom * 100) / 100;
  return Math.max(LIGHTBOX_MIN_ZOOM, Math.min(LIGHTBOX_MAX_ZOOM, rounded));
}

export function stepLightboxZoom(currentZoom: number, direction: 'in' | 'out'): number {
  const delta = direction === 'in' ? LIGHTBOX_ZOOM_STEP : -LIGHTBOX_ZOOM_STEP;
  return clampLightboxZoom(currentZoom + delta);
}

/**
 * Clamps pan offsets proportionally to the active zoom scale so an archival card
 * cannot be dragged completely off-screen.
 */
export function clampLightboxPan(
  pan: LightboxPanOffset,
  zoom: number,
  viewportSpanPx = 420
): LightboxPanOffset {
  const safeZoom = clampLightboxZoom(zoom);
  if (safeZoom <= LIGHTBOX_MIN_ZOOM) {
    return { x: 0, y: 0 };
  }
  const maxOffset = Math.round(((safeZoom - 1) * Math.max(120, viewportSpanPx)) / 2);
  return {
    x: Math.max(-maxOffset, Math.min(maxOffset, Math.round(pan.x))),
    y: Math.max(-maxOffset, Math.min(maxOffset, Math.round(pan.y))),
  };
}

export function stepLightboxIndex(
  currentIndex: number,
  totalItems: number,
  direction: 'prev' | 'next'
): number {
  if (totalItems <= 0) {
    return 0;
  }
  const normalized = ((Math.trunc(currentIndex) % totalItems) + totalItems) % totalItems;
  if (direction === 'next') {
    return (normalized + 1) % totalItems;
  }
  return (normalized - 1 + totalItems) % totalItems;
}

export function formatLightboxZoomPercent(zoom: number): string {
  return `${Math.round(clampLightboxZoom(zoom) * 100)}%`;
}

export interface FileSelectionCandidate {
  readonly name: string;
  readonly type: string;
  readonly size: number;
}

export interface FileValidationOutcome<TFile extends FileSelectionCandidate> {
  readonly accepted: readonly TFile[];
  readonly errors: readonly string[];
}

export const DEFAULT_IMAGE_UPLOAD_MIMES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export const DEFAULT_IMAGE_UPLOAD_MAX_BYTES = 10 * 1024 * 1024;

export function validateImageUploadCandidates<TFile extends FileSelectionCandidate>(
  files: readonly TFile[],
  options: {
    readonly allowedMimes?: readonly string[];
    readonly maxBytes?: number;
  } = {}
): FileValidationOutcome<TFile> {
  const allowedSet = new Set(
    (options.allowedMimes ?? DEFAULT_IMAGE_UPLOAD_MIMES).map((mime) => mime.trim().toLowerCase())
  );
  const maxBytes = options.maxBytes ?? DEFAULT_IMAGE_UPLOAD_MAX_BYTES;
  const maxMbLabel = Math.max(1, Math.round((maxBytes / (1024 * 1024)) * 10) / 10);

  const accepted: TFile[] = [];
  const errors: string[] = [];

  for (const file of files) {
    const label = file.name.trim() || 'Selected file';
    const normalizedType = file.type.split(';')[0]?.trim().toLowerCase() ?? '';
    if (file.size <= 0) {
      errors.push(`${label}: file is empty.`);
      continue;
    }
    if (file.size > maxBytes) {
      errors.push(`${label}: exceeds the ${maxMbLabel} MB limit.`);
      continue;
    }
    if (!allowedSet.has(normalizedType)) {
      errors.push(
        `${label}: unsupported image type (${normalizedType || 'unknown'}). Use JPEG, PNG, or WebP.`
      );
      continue;
    }
    accepted.push(file);
  }

  return { accepted, errors };
}
