export const TIME_MIN_YEAR = 1600;
export const TIME_MAX_YEAR = 1995;

export function parseTimeYearParam(
  raw: string | null,
  minYear = TIME_MIN_YEAR,
  maxYear = TIME_MAX_YEAR
): number | null {
  if (raw === null) {
    return null;
  }
  const parsed = Math.trunc(Number(raw));
  if (!Number.isFinite(parsed)) {
    return null;
  }
  if (parsed < minYear || parsed > maxYear) {
    return null;
  }
  return parsed;
}

export function resolveTimeYear(
  raw: string | null,
  defaultYear: number,
  minYear = TIME_MIN_YEAR,
  maxYear = TIME_MAX_YEAR
): number {
  return parseTimeYearParam(raw, minYear, maxYear) ?? defaultYear;
}
