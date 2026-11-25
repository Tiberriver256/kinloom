export function scrollTargetForNavigation(
  navType: 'POP' | 'PUSH' | 'REPLACE',
  savedY?: number,
): number {
  if (navType === 'POP' && typeof savedY === 'number') {
    return savedY;
  }
  return 0;
}
