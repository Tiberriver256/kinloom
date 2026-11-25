import type { Clock } from '@kinloom/core';

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }

  nowIso(): string {
    return new Date().toISOString();
  }

  currentYear(): number {
    return new Date().getUTCFullYear();
  }
}

export class FixedClock implements Clock {
  private currentMs: number;

  constructor(initialIso: string | Date = '2026-06-01T12:00:00.000Z') {
    this.currentMs = typeof initialIso === 'string' ? Date.parse(initialIso) : initialIso.getTime();
    if (Number.isNaN(this.currentMs)) {
      throw new RangeError(`Invalid FixedClock timestamp: ${String(initialIso)}`);
    }
  }

  now(): Date {
    return new Date(this.currentMs);
  }

  nowIso(): string {
    return new Date(this.currentMs).toISOString();
  }

  currentYear(): number {
    return new Date(this.currentMs).getUTCFullYear();
  }

  advanceMs(deltaMs: number): void {
    this.currentMs += deltaMs;
  }

  setIso(iso: string): void {
    const parsed = Date.parse(iso);
    if (Number.isNaN(parsed)) {
      throw new RangeError(`Invalid timestamp: ${iso}`);
    }
    this.currentMs = parsed;
  }
}
