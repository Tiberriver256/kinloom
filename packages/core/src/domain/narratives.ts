import type { Narrative } from '../schemas/entities.js';

export interface PersonNarrativeGroups {
  biographies: Narrative[];
  familyStories: Narrative[];
}

/**
 * Partition narratives referencing `personId` into personal biographies and shared family stories.
 * Uses explicit `kind` and `subject_person_id` fields without relying on ID prefixes.
 */
export function partitionPersonNarratives(
  narratives: readonly Narrative[],
  personId: string
): PersonNarrativeGroups {
  const biographies: Narrative[] = [];
  const familyStories: Narrative[] = [];

  for (const narrative of narratives) {
    const isExplicitBiography = narrative.subject_person_id === personId;
    const isLegacySinglePersonBio =
      narrative.subject_person_id === undefined &&
      narrative.kind === undefined &&
      narrative.person_ids.length === 1 &&
      narrative.person_ids[0] === personId;

    if (isExplicitBiography || isLegacySinglePersonBio) {
      biographies.push(narrative);
      continue;
    }

    if (
      narrative.kind !== 'biography' &&
      !narrative.subject_person_id &&
      narrative.person_ids.includes(personId)
    ) {
      familyStories.push(narrative);
    }
  }

  return { biographies, familyStories };
}
