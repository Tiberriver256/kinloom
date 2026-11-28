import type { EntityPayload, EntityType, KinshipRelation, Person, Place } from '@kinloom/core';
import { buildEntityId } from '@kinloom/core';
import type React from 'react';

export type CreatableKind = 'person' | 'event' | 'place' | 'kinship_edge';
export type RelativeRelation = 'parent' | 'spouse' | 'child';
export type PersonSex = 'M' | 'F' | 'U';
export type PersonLineageGroup = 'ancestor' | 'descendant' | 'descendant_spouse' | 'collateral' | 'extended';
export type RelativeModalTab = 'create_new' | 'link_existing';

export interface RelativeCreateContext {
  anchorPersonId: string;
  anchorPersonName: string;
  relation: RelativeRelation;
}

export interface RelativeRelationSpec {
  readonly headingPrefix: string;
  readonly defaultLineageGroup: PersonLineageGroup;
  readonly buildEdge: (
    anchorPersonId: string,
    relatedPersonId: string
  ) => { from: string; to: string; relation: KinshipRelation };
  readonly linkHint: (anchorPersonName: string) => string;
}

export const RELATIVE_RELATION_SPECS: Readonly<Record<RelativeRelation, RelativeRelationSpec>> = {
  parent: {
    headingPrefix: 'Add parent of',
    defaultLineageGroup: 'ancestor',
    buildEdge: (anchorPersonId, relatedPersonId) => ({
      from: relatedPersonId,
      to: anchorPersonId,
      relation: 'parent',
    }),
    linkHint: (anchorName) => `Choose an existing person who is a parent of ${anchorName}.`,
  },
  spouse: {
    headingPrefix: 'Add spouse of',
    defaultLineageGroup: 'descendant_spouse',
    buildEdge: (anchorPersonId, relatedPersonId) => ({
      from: anchorPersonId,
      to: relatedPersonId,
      relation: 'spouse',
    }),
    linkHint: (anchorName) => `Choose an existing person who is a spouse of ${anchorName}.`,
  },
  child: {
    headingPrefix: 'Add child of',
    defaultLineageGroup: 'descendant',
    buildEdge: (anchorPersonId, relatedPersonId) => ({
      from: anchorPersonId,
      to: relatedPersonId,
      relation: 'parent',
    }),
    linkHint: (anchorName) => `Choose an existing person who is a child of ${anchorName}.`,
  },
};

export const PERSON_SEX_OPTIONS: readonly { readonly value: PersonSex; readonly label: string }[] = [
  { value: 'U', label: 'Unspecified (U)' },
  { value: 'F', label: 'Female (F)' },
  { value: 'M', label: 'Male (M)' },
];

export const PERSON_LINEAGE_OPTIONS: readonly {
  readonly value: PersonLineageGroup;
  readonly label: string;
}[] = [
  { value: 'ancestor', label: 'Ancestor' },
  { value: 'descendant', label: 'Descendant' },
  { value: 'descendant_spouse', label: 'Spouse' },
  { value: 'collateral', label: 'Extended Relative' },
  { value: 'extended', label: 'Extended Relative (Other)' },
];

export function asString(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number') {
    return String(value);
  }
  return '';
}

export function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === 'string');
}

function trimEdgeDashes(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && value.charCodeAt(start) === 45) {
    start += 1;
  }
  while (end > start && value.charCodeAt(end - 1) === 45) {
    end -= 1;
  }
  return value.slice(start, end);
}

export function slugify(value: string): string {
  return trimEdgeDashes(value.toLowerCase().replaceAll(/[^a-z0-9]+/g, '-')) || 'record';
}

export function buildUniquePersonIdentity(
  fullName: string,
  existingPeople: readonly { id: string; slug: string }[]
): { id: string; slug: string } {
  const baseSlug = slugify(fullName);
  const usedIds = new Set(existingPeople.map((p) => p.id));
  const usedSlugs = new Set(existingPeople.map((p) => p.slug));
  let candidateSlug = baseSlug;
  let candidateId = buildEntityId('person', candidateSlug.replaceAll('-', '_'));
  let suffix = 2;
  while (usedIds.has(candidateId) || usedSlugs.has(candidateSlug)) {
    candidateSlug = `${baseSlug}-${suffix}`;
    candidateId = buildEntityId('person', candidateSlug.replaceAll('-', '_'));
    suffix += 1;
  }
  return { id: candidateId, slug: candidateSlug };
}

export function parsePersonSex(value: string): PersonSex {
  if (value === 'M' || value === 'F' || value === 'U') {
    return value;
  }
  return 'U';
}

export function parsePersonLineageGroup(value: string): PersonLineageGroup {
  switch (value) {
    case 'ancestor':
    case 'descendant':
    case 'descendant_spouse':
    case 'collateral':
    case 'extended':
      return value;
    default:
      return 'extended';
  }
}

export function parseKinshipRelation(value: string): KinshipRelation {
  if (value === 'parent' || value === 'spouse' || value === 'child') {
    return value;
  }
  return 'parent';
}

export interface CreateEntityDraft {
  givenName: string;
  surname: string;
  sex: PersonSex;
  lineageGroup: PersonLineageGroup;
  birthEdtf: string;
  deathEdtf: string;
  isLiving: boolean;
  existingQuery: string;
  existingPersonId: string;
  eventTitle: string;
  eventDate: string;
  eventPersonId: string;
  eventPlaceId: string;
  eventSummary: string;
  placeName: string;
  placeFullName: string;
  placeLat: string;
  placeLng: string;
  fromPersonId: string;
  toPersonId: string;
  relation: KinshipRelation;
}

export function createInitialEntityDraft(
  defaultPersonId: string | undefined,
  anchorRelation: RelativeRelation | null
): CreateEntityDraft {
  return {
    givenName: '',
    surname: '',
    sex: 'U',
    lineageGroup: anchorRelation ? RELATIVE_RELATION_SPECS[anchorRelation].defaultLineageGroup : 'extended',
    birthEdtf: '',
    deathEdtf: '',
    isLiving: false,
    existingQuery: '',
    existingPersonId: '',
    eventTitle: '',
    eventDate: '',
    eventPersonId: defaultPersonId ?? '',
    eventPlaceId: '',
    eventSummary: '',
    placeName: '',
    placeFullName: '',
    placeLat: '39.8283',
    placeLng: '-98.5795',
    fromPersonId: defaultPersonId ?? '',
    toPersonId: '',
    relation: 'parent',
  };
}

export type BuildCreatePayloadResult =
  | { readonly ok: true; readonly entityId: string; readonly payload: EntityPayload }
  | { readonly ok: false; readonly error: string };

export interface EntityCreateFieldProps {
  readonly draft: CreateEntityDraft;
  readonly updateDraft: <K extends keyof CreateEntityDraft>(key: K, value: CreateEntityDraft[K]) => void;
  readonly people: readonly Person[];
  readonly places: readonly Place[];
  readonly uiStyles?: Readonly<Record<string, string>>;
}

export interface EntityCreateFormEntry {
  readonly kind: EntityType;
  readonly tabLabel: string;
  readonly Fields: React.FC<EntityCreateFieldProps>;
  readonly validateAndBuild: (
    draft: CreateEntityDraft,
    ctx: { readonly people: readonly Person[]; readonly hasPrimarySource: boolean }
  ) => BuildCreatePayloadResult;
}

export interface EntityEditFieldProps {
  readonly draft: EntityPayload;
  readonly isBusy: boolean;
  readonly uiStyles?: Readonly<Record<string, string>>;
  readonly updateField: (key: string, value: unknown) => void;
  readonly replaceDraft: (nextDraft: EntityPayload) => void;
}

export interface EntityEditFormEntry {
  readonly Fields: React.FC<EntityEditFieldProps>;
  readonly pronunciationEntityType?: Extract<EntityType, 'person' | 'place'>;
  readonly supportsPronunciation?: (draft: EntityPayload) => boolean;
  readonly getPronunciationPreviewLabel?: (
    draft: EntityPayload,
    title: string | undefined,
    entityId: string
  ) => string;
  readonly prepareSubmitDraft?: (draft: EntityPayload) => EntityPayload | null;
}
