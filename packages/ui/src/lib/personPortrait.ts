import type { Person } from '@kinloom/core';

/**
 * Unified portrait/thumbnail URL resolver shared across /tree, TreeFocusDrawer,
 * and /person/<slug> so the same person never shows a photo in one surface and
 * monogram initials in another.
 */
export function resolvePersonPortraitUrl(
  person: Pick<Person, 'id' | 'portrait_url' | 'thumb_url' | 'is_living' | 'full_name'>,
  personThumbMap?: ReadonlyMap<string, string> | null,
  options?: { readonly preferFullResolution?: boolean }
): string | null {
  if (person.is_living && person.full_name.trim() === 'Living') {
    return null;
  }
  const mapped = personThumbMap?.get(person.id)?.trim() || null;
  const thumb = person.thumb_url?.trim() || null;
  const full = person.portrait_url?.trim() || null;
  if (options?.preferFullResolution) {
    return full || mapped || thumb || null;
  }
  return mapped || thumb || full || null;
}
