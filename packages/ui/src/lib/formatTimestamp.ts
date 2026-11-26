const MONTH_SHORT = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;

export function formatArchivalTimestamp(iso: string, includeTime = true): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  const month = MONTH_SHORT[date.getUTCMonth()];
  const day = date.getUTCDate();
  const year = date.getUTCFullYear();
  if (!includeTime) {
    return `${month} ${day}, ${year}`;
  }
  const hh = String(date.getUTCHours()).padStart(2, '0');
  const mm = String(date.getUTCMinutes()).padStart(2, '0');
  return `${month} ${day}, ${year} · ${hh}:${mm} UTC`;
}
