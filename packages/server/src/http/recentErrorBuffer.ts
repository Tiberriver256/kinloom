import type { DiagnosticErrorSummary } from '@kinloom/core';
import { redactObservabilityText, sanitizeObservabilityErrorCode } from './redaction.js';

export const DEFAULT_RECENT_ERROR_CAPACITY = 20;
const MAX_RECENT_ERROR_CAPACITY = 100;

function clampCapacity(raw: number | undefined): number {
  if (raw === undefined || !Number.isFinite(raw)) {
    return DEFAULT_RECENT_ERROR_CAPACITY;
  }
  return Math.max(0, Math.min(MAX_RECENT_ERROR_CAPACITY, Math.trunc(raw)));
}

function sanitizeRouteTemplate(route: string): string {
  const withoutQuery = route.split(/[?#]/)[0] ?? '/';
  const redacted = redactObservabilityText(withoutQuery).trim();
  if (!redacted) {
    return '/';
  }
  return redacted.startsWith('/') ? redacted : `/${redacted}`;
}

/**
 * Bounded in-memory ring buffer storing only redacted error metadata
 * (timestamp, normalized route template, HTTP status, canonical error_code).
 */
export class RecentErrorRingBuffer {
  private readonly capacity: number;
  private readonly entries: DiagnosticErrorSummary[] = [];

  constructor(capacity: number = DEFAULT_RECENT_ERROR_CAPACITY) {
    this.capacity = clampCapacity(capacity);
  }

  record(input: {
    readonly timestamp: string;
    readonly route: string;
    readonly status: number;
    readonly errorCode: string | null | undefined;
  }): void {
    if (this.capacity === 0) {
      return;
    }
    const statusInt = Number.isFinite(input.status) ? Math.trunc(input.status) : 500;
    if (statusInt < 400 || statusInt > 599) {
      return;
    }

    const summary: DiagnosticErrorSummary = {
      timestamp: input.timestamp.trim() || 'unknown',
      route: sanitizeRouteTemplate(input.route),
      status: statusInt,
      error_code: sanitizeObservabilityErrorCode(input.errorCode) ?? 'INTERNAL_ERROR',
    };

    if (this.entries.length >= this.capacity) {
      this.entries.shift();
    }
    this.entries.push(summary);
  }

  snapshot(): readonly DiagnosticErrorSummary[] {
    return [...this.entries].reverse();
  }

  clear(): void {
    this.entries.length = 0;
  }
}
