import type { Clock } from './contracts.js';

/**
 * Returns the UTC calendar year from an explicit Clock port (or system UTC clock at runtime boundaries).
 */
export function getCurrentReferenceYear(clock?: Clock): number {
  return clock ? clock.currentYear() : new Date().getUTCFullYear();
}

/**
 * Extracts a 4-digit UTC year from an ISO-8601 timestamp string when valid.
 */
export function parseIsoReferenceYear(iso: string | undefined): number | undefined {
  if (!iso) {
    return undefined;
  }
  const match = /^(\d{4})-/.exec(iso.trim());
  if (!match) {
    return undefined;
  }
  const year = Number(match[1]);
  return Number.isInteger(year) && year >= 1900 && year <= 2200 ? year : undefined;
}
