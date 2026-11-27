import type { EntityPayload, Person } from '@kinloom/core';
import { deriveKinshipEdgeId } from '@kinloom/core';
import type React from 'react';
import { cx } from '../../../lib/cx.js';
import type {
  BuildCreatePayloadResult,
  CreatableKind,
  CreateEntityDraft,
  EntityCreateFieldProps,
  EntityCreateFormEntry,
} from './fieldTypes.js';
import {
  buildUniquePersonIdentity,
  PERSON_LINEAGE_OPTIONS,
  PERSON_SEX_OPTIONS,
  parseKinshipRelation,
  parsePersonLineageGroup,
  parsePersonSex,
  slugify,
} from './fieldTypes.js';

export function buildPersonCreatePayload(
  draft: CreateEntityDraft,
  people: readonly Person[],
  hasPrimarySource: boolean
): BuildCreatePayloadResult {
  const fullName = `${draft.givenName.trim()} ${draft.surname.trim()}`.trim();
  if (!fullName) {
    return { ok: false, error: 'Enter at least a given name or surname.' };
  }
  const { id: entityId, slug } = buildUniquePersonIdentity(fullName, people);
  const payload: EntityPayload = {
    id: entityId,
    slug,
    full_name: fullName,
    given_name: draft.givenName.trim() || fullName,
    surname: draft.surname.trim(),
    alt_names: [],
    sex: draft.sex,
    is_living: draft.isLiving,
    lineage_group: draft.lineageGroup,
    birth_edtf: draft.birthEdtf.trim(),
    death_edtf: draft.deathEdtf.trim(),
    portrait_url: null,
    has_primary_source: hasPrimarySource,
  };
  return { ok: true, entityId, payload };
}

export const PersonCreateFields: React.FC<EntityCreateFieldProps> = ({ draft, updateDraft, uiStyles }) => (
  <div className={cx(uiStyles, 'wiki-field-grid')}>
    <label className={cx(uiStyles, 'wiki-field')}>
      <span className={cx(uiStyles, 'wiki-field-label')}>Given name</span>
      <input
        type="text"
        className={cx(uiStyles, 'wiki-input')}
        value={draft.givenName}
        onChange={(e) => {
          updateDraft('givenName', e.target.value);
        }}
      />
    </label>
    <label className={cx(uiStyles, 'wiki-field')}>
      <span className={cx(uiStyles, 'wiki-field-label')}>Surname</span>
      <input
        type="text"
        className={cx(uiStyles, 'wiki-input')}
        value={draft.surname}
        onChange={(e) => {
          updateDraft('surname', e.target.value);
        }}
      />
    </label>
    <label className={cx(uiStyles, 'wiki-field')}>
      <span className={cx(uiStyles, 'wiki-field-label')}>Sex</span>
      <select
        className={cx(uiStyles, 'wiki-input')}
        value={draft.sex}
        onChange={(e) => {
          updateDraft('sex', parsePersonSex(e.target.value));
        }}
      >
        {PERSON_SEX_OPTIONS.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
    </label>
    <label className={cx(uiStyles, 'wiki-field')}>
      <span className={cx(uiStyles, 'wiki-field-label')}>Lineage group</span>
      <select
        className={cx(uiStyles, 'wiki-input')}
        value={draft.lineageGroup}
        onChange={(e) => {
          updateDraft('lineageGroup', parsePersonLineageGroup(e.target.value));
        }}
      >
        {PERSON_LINEAGE_OPTIONS.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
    </label>
    <label className={cx(uiStyles, 'wiki-field')}>
      <span className={cx(uiStyles, 'wiki-field-label')}>Birth date</span>
      <input
        type="text"
        className={cx(uiStyles, 'wiki-input')}
        placeholder="e.g. 1845-06-14 or 1845"
        value={draft.birthEdtf}
        onChange={(e) => {
          updateDraft('birthEdtf', e.target.value);
        }}
      />
    </label>
    <label className={cx(uiStyles, 'wiki-field')}>
      <span className={cx(uiStyles, 'wiki-field-label')}>Death date</span>
      <input
        type="text"
        className={cx(uiStyles, 'wiki-input')}
        placeholder="Leave blank if living"
        value={draft.deathEdtf}
        onChange={(e) => {
          updateDraft('deathEdtf', e.target.value);
        }}
      />
    </label>
    <label className={cx(uiStyles, 'wiki-checkbox-row wiki-field-full')}>
      <input
        type="checkbox"
        checked={draft.isLiving}
        onChange={(e) => {
          updateDraft('isLiving', e.target.checked);
        }}
      />
      <span>Living relative (privacy redaction enforced automatically)</span>
    </label>
  </div>
);

const EventCreateFields: React.FC<EntityCreateFieldProps> = ({
  draft,
  updateDraft,
  people,
  places,
  uiStyles,
}) => (
  <div className={cx(uiStyles, 'wiki-field-grid')}>
    <label className={cx(uiStyles, 'wiki-field wiki-field-full')}>
      <span className={cx(uiStyles, 'wiki-field-label')}>Event title</span>
      <input
        type="text"
        className={cx(uiStyles, 'wiki-input')}
        value={draft.eventTitle}
        onChange={(e) => {
          updateDraft('eventTitle', e.target.value);
        }}
      />
    </label>
    <label className={cx(uiStyles, 'wiki-field')}>
      <span className={cx(uiStyles, 'wiki-field-label')}>Date</span>
      <input
        type="text"
        className={cx(uiStyles, 'wiki-input')}
        placeholder="1880-06"
        value={draft.eventDate}
        onChange={(e) => {
          updateDraft('eventDate', e.target.value);
        }}
      />
    </label>
    <label className={cx(uiStyles, 'wiki-field')}>
      <span className={cx(uiStyles, 'wiki-field-label')}>Primary person</span>
      <select
        className={cx(uiStyles, 'wiki-input')}
        value={draft.eventPersonId}
        onChange={(e) => {
          updateDraft('eventPersonId', e.target.value);
        }}
      >
        <option value="">None selected</option>
        {people.map((p) => (
          <option key={p.id} value={p.id}>
            {p.full_name}
          </option>
        ))}
      </select>
    </label>
    <label className={cx(uiStyles, 'wiki-field wiki-field-full')}>
      <span className={cx(uiStyles, 'wiki-field-label')}>Place</span>
      <select
        className={cx(uiStyles, 'wiki-input')}
        value={draft.eventPlaceId}
        onChange={(e) => {
          updateDraft('eventPlaceId', e.target.value);
        }}
      >
        <option value="">Unrecorded place</option>
        {places.map((pl) => (
          <option key={pl.id} value={pl.id}>
            {pl.full_name}
          </option>
        ))}
      </select>
    </label>
    <label className={cx(uiStyles, 'wiki-field wiki-field-full')}>
      <span className={cx(uiStyles, 'wiki-field-label')}>Summary</span>
      <textarea
        className={cx(uiStyles, 'wiki-textarea')}
        rows={3}
        value={draft.eventSummary}
        onChange={(e) => {
          updateDraft('eventSummary', e.target.value);
        }}
      />
    </label>
  </div>
);

const PlaceCreateFields: React.FC<EntityCreateFieldProps> = ({ draft, updateDraft, uiStyles }) => (
  <div className={cx(uiStyles, 'wiki-field-grid')}>
    <label className={cx(uiStyles, 'wiki-field')}>
      <span className={cx(uiStyles, 'wiki-field-label')}>Short name</span>
      <input
        type="text"
        className={cx(uiStyles, 'wiki-input')}
        value={draft.placeName}
        onChange={(e) => {
          updateDraft('placeName', e.target.value);
        }}
      />
    </label>
    <label className={cx(uiStyles, 'wiki-field')}>
      <span className={cx(uiStyles, 'wiki-field-label')}>Full hierarchical name</span>
      <input
        type="text"
        className={cx(uiStyles, 'wiki-input')}
        placeholder="Town, County, State, Country"
        value={draft.placeFullName}
        onChange={(e) => {
          updateDraft('placeFullName', e.target.value);
        }}
      />
    </label>
    <label className={cx(uiStyles, 'wiki-field')}>
      <span className={cx(uiStyles, 'wiki-field-label')}>Latitude</span>
      <input
        type="number"
        step="any"
        className={cx(uiStyles, 'wiki-input')}
        value={draft.placeLat}
        onChange={(e) => {
          updateDraft('placeLat', e.target.value);
        }}
      />
    </label>
    <label className={cx(uiStyles, 'wiki-field')}>
      <span className={cx(uiStyles, 'wiki-field-label')}>Longitude</span>
      <input
        type="number"
        step="any"
        className={cx(uiStyles, 'wiki-input')}
        value={draft.placeLng}
        onChange={(e) => {
          updateDraft('placeLng', e.target.value);
        }}
      />
    </label>
  </div>
);

const KinshipCreateFields: React.FC<EntityCreateFieldProps> = ({ draft, updateDraft, people, uiStyles }) => (
  <div className={cx(uiStyles, 'wiki-field-grid')}>
    <label className={cx(uiStyles, 'wiki-field')}>
      <span className={cx(uiStyles, 'wiki-field-label')}>From person</span>
      <select
        className={cx(uiStyles, 'wiki-input')}
        value={draft.fromPersonId}
        onChange={(e) => {
          updateDraft('fromPersonId', e.target.value);
        }}
      >
        <option value="">Choose person…</option>
        {people.map((p) => (
          <option key={p.id} value={p.id}>
            {p.full_name}
          </option>
        ))}
      </select>
    </label>
    <label className={cx(uiStyles, 'wiki-field')}>
      <span className={cx(uiStyles, 'wiki-field-label')}>Relationship</span>
      <select
        className={cx(uiStyles, 'wiki-input')}
        value={draft.relation}
        onChange={(e) => {
          updateDraft('relation', parseKinshipRelation(e.target.value));
        }}
      >
        <option value="parent">is parent of</option>
        <option value="spouse">is spouse of</option>
        <option value="child">is child of</option>
      </select>
    </label>
    <label className={cx(uiStyles, 'wiki-field wiki-field-full')}>
      <span className={cx(uiStyles, 'wiki-field-label')}>To person</span>
      <select
        className={cx(uiStyles, 'wiki-input')}
        value={draft.toPersonId}
        onChange={(e) => {
          updateDraft('toPersonId', e.target.value);
        }}
      >
        <option value="">Choose person…</option>
        {people.map((p) => (
          <option key={p.id} value={p.id}>
            {p.full_name}
          </option>
        ))}
      </select>
    </label>
  </div>
);

export const LinkExistingRelativeFields: React.FC<{
  readonly linkHint: string;
  readonly existingQuery: string;
  readonly existingPersonId: string;
  readonly candidates: readonly Person[];
  readonly uiStyles: Readonly<Record<string, string>>;
  readonly onQueryChange: (value: string) => void;
  readonly onPersonIdChange: (value: string) => void;
}> = ({
  linkHint,
  existingQuery,
  existingPersonId,
  candidates,
  uiStyles,
  onQueryChange,
  onPersonIdChange,
}) => (
  <div className={cx(uiStyles, 'wiki-field-grid')}>
    <p className={cx(uiStyles, 'wiki-relative-hint wiki-field-full')}>{linkHint}</p>
    <label className={cx(uiStyles, 'wiki-field wiki-field-full')}>
      <span className={cx(uiStyles, 'wiki-field-label')}>Filter people by name</span>
      <input
        type="search"
        className={cx(uiStyles, 'wiki-input')}
        placeholder="Type a name to narrow the list…"
        value={existingQuery}
        onChange={(e) => {
          onQueryChange(e.target.value);
        }}
      />
    </label>
    <label className={cx(uiStyles, 'wiki-field wiki-field-full')}>
      <span className={cx(uiStyles, 'wiki-field-label')}>Existing person</span>
      <select
        className={cx(uiStyles, 'wiki-input')}
        value={existingPersonId}
        onChange={(e) => {
          onPersonIdChange(e.target.value);
        }}
      >
        <option value="">Choose person…</option>
        {candidates.map((p) => (
          <option key={p.id} value={p.id}>
            {p.full_name} ({p.birth_year || '?'}–{p.death_year || (p.is_living ? 'Living' : '?')})
          </option>
        ))}
      </select>
    </label>
  </div>
);

export const CREATABLE_KIND_ORDER: readonly CreatableKind[] = ['person', 'event', 'place', 'kinship_edge'];

export const ENTITY_CREATE_FORM_REGISTRY: Readonly<Record<CreatableKind, EntityCreateFormEntry>> = {
  person: {
    kind: 'person',
    tabLabel: 'Person',
    Fields: PersonCreateFields,
    validateAndBuild: (draft, ctx) => buildPersonCreatePayload(draft, ctx.people, ctx.hasPrimarySource),
  },
  event: {
    kind: 'event',
    tabLabel: 'Event',
    Fields: EventCreateFields,
    validateAndBuild: (draft, ctx) => {
      if (!draft.eventTitle.trim()) {
        return { ok: false, error: 'Enter an event title.' };
      }
      const slug = slugify(draft.eventTitle);
      const entityId = `evt_${draft.eventDate.trim().slice(0, 4) || 'undated'}_${slug.replaceAll('-', '_')}`;
      const payload: EntityPayload = {
        id: entityId,
        title: draft.eventTitle.trim(),
        scope: 'personal',
        event_kind: 'point_event',
        edtf_date: draft.eventDate.trim(),
        place_id: draft.eventPlaceId || null,
        summary: draft.eventSummary.trim(),
        participants: draft.eventPersonId ? [{ person_id: draft.eventPersonId, role: 'principal' }] : [],
        sources: [],
        has_primary_source: ctx.hasPrimarySource,
      };
      return { ok: true, entityId, payload };
    },
  },
  place: {
    kind: 'place',
    tabLabel: 'Place',
    Fields: PlaceCreateFields,
    validateAndBuild: (draft, ctx) => {
      if (!draft.placeName.trim()) {
        return { ok: false, error: 'Enter a place name.' };
      }
      const slug = slugify(draft.placeFullName.trim() || draft.placeName.trim());
      const entityId = `pl_${slug.replaceAll('-', '_')}`;
      const payload: EntityPayload = {
        id: entityId,
        slug,
        name: draft.placeName.trim(),
        full_name: draft.placeFullName.trim() || draft.placeName.trim(),
        place_type: 'town',
        parent_id: null,
        lat: Number(draft.placeLat) || 0,
        lng: Number(draft.placeLng) || 0,
        has_primary_source: ctx.hasPrimarySource,
      };
      return { ok: true, entityId, payload };
    },
  },
  kinship_edge: {
    kind: 'kinship_edge',
    tabLabel: 'Family Link',
    Fields: KinshipCreateFields,
    validateAndBuild: (draft) => {
      if (!draft.fromPersonId || !draft.toPersonId || draft.fromPersonId === draft.toPersonId) {
        return { ok: false, error: 'Choose two distinct people for the kinship link.' };
      }
      const edge = { from: draft.fromPersonId, to: draft.toPersonId, relation: draft.relation };
      return { ok: true, entityId: deriveKinshipEdgeId(edge), payload: edge };
    },
  },
};
