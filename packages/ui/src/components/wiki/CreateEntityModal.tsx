import type { EntityPayload, EntityType, KinshipRelation } from '@kinloom/core';
import { deriveKinshipEdgeId, isEditSummaryValid } from '@kinloom/core';
import React, { useEffect, useMemo, useState } from 'react';
import { CitationBadge } from './WikiBadges.js';
import { useArchiveData } from '../../context/ArchiveDataContext.js';

export type CreatableKind = 'person' | 'event' | 'place' | 'kinship_edge';
export type RelativeRelation = 'parent' | 'spouse' | 'child';
export type PersonSex = 'M' | 'F' | 'U';
export type PersonLineageGroup =
  | 'ancestor'
  | 'descendant'
  | 'descendant_spouse'
  | 'collateral'
  | 'extended';

export interface RelativeCreateContext {
  anchorPersonId: string;
  anchorPersonName: string;
  relation: RelativeRelation;
}

export interface CreateEntityModalProps {
  open: boolean;
  defaultKind?: CreatableKind;
  defaultPersonId?: string;
  relativeContext?: RelativeCreateContext;
  onClose: () => void;
  onCreated?: (entityType: EntityType, entity: EntityPayload) => void;
}

type RelativeModalTab = 'create_new' | 'link_existing';

interface RelativeRelationSpec {
  readonly headingPrefix: string;
  readonly defaultLineageGroup: PersonLineageGroup;
  readonly buildEdge: (
    anchorPersonId: string,
    relatedPersonId: string,
  ) => { from: string; to: string; relation: KinshipRelation };
  readonly linkHint: (anchorPersonName: string) => string;
}

const RELATIVE_RELATION_SPECS: Record<RelativeRelation, RelativeRelationSpec> = {
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

const PERSON_SEX_OPTIONS: readonly { readonly value: PersonSex; readonly label: string }[] = [
  { value: 'U', label: 'Unspecified (U)' },
  { value: 'F', label: 'Female (F)' },
  { value: 'M', label: 'Male (M)' },
];

const PERSON_LINEAGE_OPTIONS: readonly {
  readonly value: PersonLineageGroup;
  readonly label: string;
}[] = [
  { value: 'ancestor', label: 'Ancestor' },
  { value: 'descendant', label: 'Descendant' },
  { value: 'descendant_spouse', label: 'Spouse' },
  { value: 'collateral', label: 'Collateral Relative' },
  { value: 'extended', label: 'Extended Relative' },
];

function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .replaceAll(/[^a-z0-9]+/g, '-')
      .replaceAll(/^-+|-+$/g, '') || 'record'
  );
}

export function buildUniquePersonIdentity(
  fullName: string,
  existingPeople: readonly { id: string; slug: string }[],
): { id: string; slug: string } {
  const baseSlug = slugify(fullName);
  const usedIds = new Set(existingPeople.map((p) => p.id));
  const usedSlugs = new Set(existingPeople.map((p) => p.slug));
  let candidateSlug = baseSlug;
  let candidateId = `per_${candidateSlug.replaceAll('-', '_')}`;
  let suffix = 2;
  while (usedIds.has(candidateId) || usedSlugs.has(candidateSlug)) {
    candidateSlug = `${baseSlug}-${suffix}`;
    candidateId = `per_${candidateSlug.replaceAll('-', '_')}`;
    suffix += 1;
  }
  return { id: candidateId, slug: candidateSlug };
}

function parsePersonSex(value: string): PersonSex {
  if (value === 'M' || value === 'F' || value === 'U') {
    return value;
  }
  return 'U';
}

function parsePersonLineageGroup(value: string): PersonLineageGroup {
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

function parseKinshipRelation(value: string): KinshipRelation {
  if (value === 'parent' || value === 'spouse' || value === 'child') {
    return value;
  }
  return 'parent';
}

export const CreateEntityModal: React.FC<CreateEntityModalProps> = ({
  open,
  defaultKind = 'person',
  defaultPersonId,
  relativeContext,
  onClose,
  onCreated,
}) => {
  const { dataSource, bundle, reloadArchive } = useArchiveData();
  const [kind, setKind] = useState<CreatableKind>(defaultKind);
  const [relativeTab, setRelativeTab] = useState<RelativeModalTab>('create_new');
  const [summary, setSummary] = useState('');
  const [hasPrimarySource, setHasPrimarySource] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Person fields
  const [givenName, setGivenName] = useState('');
  const [surname, setSurname] = useState('');
  const [sex, setSex] = useState<PersonSex>('U');
  const [lineageGroup, setLineageGroup] = useState<PersonLineageGroup>(
    relativeContext
      ? RELATIVE_RELATION_SPECS[relativeContext.relation].defaultLineageGroup
      : 'extended',
  );
  const [birthEdtf, setBirthEdtf] = useState('');
  const [deathEdtf, setDeathEdtf] = useState('');
  const [isLiving, setIsLiving] = useState(false);

  // Link existing relative fields
  const [existingQuery, setExistingQuery] = useState('');
  const [existingPersonId, setExistingPersonId] = useState('');

  // Event fields
  const [eventTitle, setEventTitle] = useState('');
  const [eventDate, setEventDate] = useState('');
  const [eventPersonId, setEventPersonId] = useState(defaultPersonId ?? '');
  const [eventPlaceId, setEventPlaceId] = useState('');
  const [eventSummary, setEventSummary] = useState('');

  // Place fields
  const [placeName, setPlaceName] = useState('');
  const [placeFullName, setPlaceFullName] = useState('');
  const [placeLat, setPlaceLat] = useState('39.8283');
  const [placeLng, setPlaceLng] = useState('-98.5795');

  // Kinship fields (standalone tab)
  const [fromPersonId, setFromPersonId] = useState(defaultPersonId ?? '');
  const [toPersonId, setToPersonId] = useState('');
  const [relation, setRelation] = useState<KinshipRelation>('parent');

  const anchorId = relativeContext?.anchorPersonId ?? null;
  const anchorRelation = relativeContext?.relation ?? null;

  useEffect(() => {
    if (!open) {
      return;
    }
    setKind(defaultKind);
    setRelativeTab('create_new');
    setSummary('');
    setHasPrimarySource(true);
    setError(null);
    setGivenName('');
    setSurname('');
    setSex('U');
    setLineageGroup(
      anchorRelation ? RELATIVE_RELATION_SPECS[anchorRelation].defaultLineageGroup : 'extended',
    );
    setBirthEdtf('');
    setDeathEdtf('');
    setIsLiving(false);
    setExistingQuery('');
    setExistingPersonId('');
    setEventTitle('');
    setEventDate('');
    setEventPersonId(defaultPersonId ?? '');
    setEventPlaceId('');
    setEventSummary('');
    setPlaceName('');
    setPlaceFullName('');
    setPlaceLat('39.8283');
    setPlaceLng('-98.5795');
    setFromPersonId(defaultPersonId ?? '');
    setToPersonId('');
    setRelation('parent');
  }, [open, defaultKind, defaultPersonId, anchorId, anchorRelation]);

  const people = useMemo(() => bundle?.people ?? [], [bundle]);
  const places = useMemo(() => bundle?.places ?? [], [bundle]);

  const filteredExistingCandidates = useMemo(() => {
    if (!relativeContext) {
      return [];
    }
    const q = existingQuery.trim().toLowerCase();
    return people
      .filter((p) => p.id !== relativeContext.anchorPersonId)
      .filter((p) => {
        if (!q) {
          return true;
        }
        const matchFull = p.full_name.toLowerCase().includes(q);
        const matchAlt = (p.alt_names || []).some((alt) => alt.toLowerCase().includes(q));
        return matchFull || matchAlt;
      })
      .toSorted((a, b) => a.full_name.localeCompare(b.full_name));
  }, [people, relativeContext, existingQuery]);

  if (!open) {
    return null;
  }

  const relativeSpec = relativeContext ? RELATIVE_RELATION_SPECS[relativeContext.relation] : null;

  const buildPersonDraft = (): { entityId: string; payload: EntityPayload } | null => {
    const fullName = `${givenName.trim()} ${surname.trim()}`.trim();
    if (!fullName) {
      setError('Enter at least a given name or surname.');
      return null;
    }
    const { id: entityId, slug } = buildUniquePersonIdentity(fullName, people);
    const payload: EntityPayload = {
      id: entityId,
      slug,
      full_name: fullName,
      given_name: givenName.trim() || fullName,
      surname: surname.trim(),
      alt_names: [],
      sex,
      is_living: isLiving,
      lineage_group: lineageGroup,
      birth_edtf: birthEdtf.trim(),
      death_edtf: deathEdtf.trim(),
      portrait_url: null,
      has_primary_source: hasPrimarySource,
    };
    return { entityId, payload };
  };

  const handleSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (!dataSource.createEntity) {
      setError('This archive is in read-only mode.');
      return;
    }
    if (!isEditSummaryValid(summary)) {
      setError('Edit summary must be at least 3 characters.');
      return;
    }

    const trimmedSummary = summary.trim();

    if (relativeContext && relativeSpec) {
      if (relativeTab === 'link_existing') {
        if (!existingPersonId || existingPersonId === relativeContext.anchorPersonId) {
          setError('Choose an existing person to link.');
          return;
        }
        const edge = relativeSpec.buildEdge(relativeContext.anchorPersonId, existingPersonId);
        const edgeId = deriveKinshipEdgeId(edge);
        setSubmitting(true);
        setError(null);
        try {
          const edgeRes = await dataSource.createEntity('kinship_edge', {
            entity_id: edgeId,
            data: edge,
            summary: trimmedSummary,
            has_primary_source: hasPrimarySource,
          });
          reloadArchive();
          onCreated?.('kinship_edge', edgeRes.entity);
          onClose();
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err));
        } finally {
          setSubmitting(false);
        }
        return;
      }

      const personDraft = buildPersonDraft();
      if (!personDraft) {
        return;
      }
      const edge = relativeSpec.buildEdge(relativeContext.anchorPersonId, personDraft.entityId);
      const edgeId = deriveKinshipEdgeId(edge);

      setSubmitting(true);
      setError(null);
      let createdPerson = false;
      try {
        const personRes = await dataSource.createEntity('person', {
          entity_id: personDraft.entityId,
          data: personDraft.payload,
          summary: trimmedSummary,
          has_primary_source: hasPrimarySource,
        });
        createdPerson = true;
        await dataSource.createEntity('kinship_edge', {
          entity_id: edgeId,
          data: edge,
          summary: trimmedSummary,
          has_primary_source: hasPrimarySource,
        });
        reloadArchive();
        onCreated?.('person', personRes.entity);
        onClose();
      } catch (err) {
        if (createdPerson) {
          reloadArchive();
          setError(
            `Person record saved, but linking failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        } else {
          setError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        setSubmitting(false);
      }
      return;
    }

    let entityId: string;
    let payload: EntityPayload;

    if (kind === 'person') {
      const personDraft = buildPersonDraft();
      if (!personDraft) {
        return;
      }
      ({ entityId, payload } = personDraft);
    } else if (kind === 'event') {
      if (!eventTitle.trim()) {
        setError('Enter an event title.');
        return;
      }
      const slug = slugify(eventTitle);
      entityId = `evt_${eventDate.trim().slice(0, 4) || 'undated'}_${slug.replaceAll('-', '_')}`;
      payload = {
        id: entityId,
        title: eventTitle.trim(),
        scope: 'personal',
        event_kind: 'point_event',
        edtf_date: eventDate.trim(),
        place_id: eventPlaceId || null,
        summary: eventSummary.trim(),
        participants: eventPersonId ? [{ person_id: eventPersonId, role: 'principal' }] : [],
        sources: [],
        has_primary_source: hasPrimarySource,
      };
    } else if (kind === 'place') {
      if (!placeName.trim()) {
        setError('Enter a place name.');
        return;
      }
      const slug = slugify(placeFullName.trim() || placeName.trim());
      entityId = `pl_${slug.replaceAll('-', '_')}`;
      payload = {
        id: entityId,
        slug,
        name: placeName.trim(),
        full_name: placeFullName.trim() || placeName.trim(),
        place_type: 'town',
        parent_id: null,
        lat: Number(placeLat) || 0,
        lng: Number(placeLng) || 0,
        has_primary_source: hasPrimarySource,
      };
    } else {
      if (!fromPersonId || !toPersonId || fromPersonId === toPersonId) {
        setError('Choose two distinct people for the kinship link.');
        return;
      }
      const edge = { from: fromPersonId, to: toPersonId, relation };
      entityId = deriveKinshipEdgeId(edge);
      payload = edge;
    }

    setSubmitting(true);
    setError(null);
    try {
      const res = await dataSource.createEntity(kind, {
        entity_id: entityId,
        data: payload,
        summary: trimmedSummary,
        has_primary_source: hasPrimarySource,
      });
      reloadArchive();
      onCreated?.(kind, res.entity);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const renderPersonFields = (): React.ReactNode => (
    <div className="wiki-field-grid">
      <label className="wiki-field">
        <span className="wiki-field-label">Given name</span>
        <input
          type="text"
          className="wiki-input"
          value={givenName}
          onChange={(e) => {
            setGivenName(e.target.value);
          }}
        />
      </label>
      <label className="wiki-field">
        <span className="wiki-field-label">Surname</span>
        <input
          type="text"
          className="wiki-input"
          value={surname}
          onChange={(e) => {
            setSurname(e.target.value);
          }}
        />
      </label>
      <label className="wiki-field">
        <span className="wiki-field-label">Sex</span>
        <select
          className="wiki-input"
          value={sex}
          onChange={(e) => {
            setSex(parsePersonSex(e.target.value));
          }}
        >
          {PERSON_SEX_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </label>
      <label className="wiki-field">
        <span className="wiki-field-label">Lineage group</span>
        <select
          className="wiki-input"
          value={lineageGroup}
          onChange={(e) => {
            setLineageGroup(parsePersonLineageGroup(e.target.value));
          }}
        >
          {PERSON_LINEAGE_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </label>
      <label className="wiki-field">
        <span className="wiki-field-label">Birth date</span>
        <input
          type="text"
          className="wiki-input"
          placeholder="e.g. 1845-06-14 or 1845"
          value={birthEdtf}
          onChange={(e) => {
            setBirthEdtf(e.target.value);
          }}
        />
      </label>
      <label className="wiki-field">
        <span className="wiki-field-label">Death date</span>
        <input
          type="text"
          className="wiki-input"
          placeholder="Leave blank if living"
          value={deathEdtf}
          onChange={(e) => {
            setDeathEdtf(e.target.value);
          }}
        />
      </label>
      <label className="wiki-checkbox-row wiki-field-full">
        <input
          type="checkbox"
          checked={isLiving}
          onChange={(e) => {
            setIsLiving(e.target.checked);
          }}
        />
        <span>Living relative (privacy redaction enforced automatically)</span>
      </label>
    </div>
  );

  const modalTitle =
    relativeContext && relativeSpec
      ? `${relativeSpec.headingPrefix} ${relativeContext.anchorPersonName}`
      : 'Add to the Family Archive';

  const submitLabel = submitting
    ? 'Saving…'
    : relativeContext
      ? relativeTab === 'link_existing'
        ? 'Link Relative'
        : 'Save & Link Relative'
      : 'Save to Archive';

  return (
    <dialog open className="lightbox-backdrop" aria-label={modalTitle}>
      <button
        type="button"
        className="lightbox-backdrop-close"
        aria-label="Close create record modal"
        onClick={onClose}
      />
      <div className="wiki-modal-card">
        <div className="wiki-modal-header">
          <h2>{modalTitle}</h2>
          <button type="button" className="pill-btn" onClick={onClose}>
            Close
          </button>
        </div>

        {relativeContext ? (
          <div className="filter-bar" role="tablist" aria-label="How to add relative">
            {(
              [
                ['create_new', 'Create new person'],
                ['link_existing', 'Link existing person'],
              ] as const
            ).map(([tabId, label]) => (
              <button
                key={tabId}
                type="button"
                role="tab"
                aria-selected={relativeTab === tabId}
                className={`pill-btn ${relativeTab === tabId ? 'active' : ''}`}
                onClick={() => {
                  setRelativeTab(tabId);
                  setError(null);
                }}
              >
                {label}
              </button>
            ))}
          </div>
        ) : (
          <div className="filter-bar" role="tablist" aria-label="Record type to create">
            {(
              [
                ['person', 'Person'],
                ['event', 'Event'],
                ['place', 'Place'],
                ['kinship_edge', 'Family Link'],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={kind === id}
                className={`pill-btn ${kind === id ? 'active' : ''}`}
                onClick={() => {
                  setKind(id);
                  setError(null);
                }}
              >
                {label}
              </button>
            ))}
          </div>
        )}

        {error && (
          <div className="wiki-status-banner is-error" role="alert">
            {error}
          </div>
        )}

        <form
          className="wiki-edit-form"
          onSubmit={(e) => {
            void handleSubmit(e);
          }}
        >
          {relativeContext && relativeSpec ? (
            relativeTab === 'create_new' ? (
              renderPersonFields()
            ) : (
              <div className="wiki-field-grid">
                <p className="wiki-relative-hint wiki-field-full">
                  {relativeSpec.linkHint(relativeContext.anchorPersonName)}
                </p>
                <label className="wiki-field wiki-field-full">
                  <span className="wiki-field-label">Filter people by name</span>
                  <input
                    type="search"
                    className="wiki-input"
                    placeholder="Type a name to narrow the list…"
                    value={existingQuery}
                    onChange={(e) => {
                      setExistingQuery(e.target.value);
                    }}
                  />
                </label>
                <label className="wiki-field wiki-field-full">
                  <span className="wiki-field-label">Existing person</span>
                  <select
                    className="wiki-input"
                    value={existingPersonId}
                    onChange={(e) => {
                      setExistingPersonId(e.target.value);
                    }}
                  >
                    <option value="">Choose person…</option>
                    {filteredExistingCandidates.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.full_name} ({p.birth_year || '?'}–{p.death_year || (p.is_living ? 'Living' : '?')})
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            )
          ) : (
            <>
              {kind === 'person' && renderPersonFields()}

              {kind === 'event' && (
                <div className="wiki-field-grid">
                  <label className="wiki-field wiki-field-full">
                    <span className="wiki-field-label">Event title</span>
                    <input
                      type="text"
                      className="wiki-input"
                      value={eventTitle}
                      onChange={(e) => {
                        setEventTitle(e.target.value);
                      }}
                    />
                  </label>
                  <label className="wiki-field">
                    <span className="wiki-field-label">Date</span>
                    <input
                      type="text"
                      className="wiki-input"
                      placeholder="1880-06"
                      value={eventDate}
                      onChange={(e) => {
                        setEventDate(e.target.value);
                      }}
                    />
                  </label>
                  <label className="wiki-field">
                    <span className="wiki-field-label">Primary person</span>
                    <select
                      className="wiki-input"
                      value={eventPersonId}
                      onChange={(e) => {
                        setEventPersonId(e.target.value);
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
                  <label className="wiki-field wiki-field-full">
                    <span className="wiki-field-label">Place</span>
                    <select
                      className="wiki-input"
                      value={eventPlaceId}
                      onChange={(e) => {
                        setEventPlaceId(e.target.value);
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
                  <label className="wiki-field wiki-field-full">
                    <span className="wiki-field-label">Summary</span>
                    <textarea
                      className="wiki-textarea"
                      rows={3}
                      value={eventSummary}
                      onChange={(e) => {
                        setEventSummary(e.target.value);
                      }}
                    />
                  </label>
                </div>
              )}

              {kind === 'place' && (
                <div className="wiki-field-grid">
                  <label className="wiki-field">
                    <span className="wiki-field-label">Short name</span>
                    <input
                      type="text"
                      className="wiki-input"
                      value={placeName}
                      onChange={(e) => {
                        setPlaceName(e.target.value);
                      }}
                    />
                  </label>
                  <label className="wiki-field">
                    <span className="wiki-field-label">Full hierarchical name</span>
                    <input
                      type="text"
                      className="wiki-input"
                      placeholder="Town, County, State, Country"
                      value={placeFullName}
                      onChange={(e) => {
                        setPlaceFullName(e.target.value);
                      }}
                    />
                  </label>
                  <label className="wiki-field">
                    <span className="wiki-field-label">Latitude</span>
                    <input
                      type="number"
                      step="any"
                      className="wiki-input"
                      value={placeLat}
                      onChange={(e) => {
                        setPlaceLat(e.target.value);
                      }}
                    />
                  </label>
                  <label className="wiki-field">
                    <span className="wiki-field-label">Longitude</span>
                    <input
                      type="number"
                      step="any"
                      className="wiki-input"
                      value={placeLng}
                      onChange={(e) => {
                        setPlaceLng(e.target.value);
                      }}
                    />
                  </label>
                </div>
              )}

              {kind === 'kinship_edge' && (
                <div className="wiki-field-grid">
                  <label className="wiki-field">
                    <span className="wiki-field-label">From person</span>
                    <select
                      className="wiki-input"
                      value={fromPersonId}
                      onChange={(e) => {
                        setFromPersonId(e.target.value);
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
                  <label className="wiki-field">
                    <span className="wiki-field-label">Relationship</span>
                    <select
                      className="wiki-input"
                      value={relation}
                      onChange={(e) => {
                        setRelation(parseKinshipRelation(e.target.value));
                      }}
                    >
                      <option value="parent">is parent of</option>
                      <option value="spouse">is spouse of</option>
                      <option value="child">is child of</option>
                    </select>
                  </label>
                  <label className="wiki-field wiki-field-full">
                    <span className="wiki-field-label">To person</span>
                    <select
                      className="wiki-input"
                      value={toPersonId}
                      onChange={(e) => {
                        setToPersonId(e.target.value);
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
              )}
            </>
          )}

          <label className="wiki-checkbox-row">
            <input
              type="checkbox"
              checked={hasPrimarySource}
              onChange={(e) => {
                setHasPrimarySource(e.target.checked);
              }}
            />
            <CitationBadge hasPrimarySource={hasPrimarySource} />
            <span>
              {hasPrimarySource
                ? 'Backed by a primary archival source'
                : 'Family memory (uncited until verified)'}
            </span>
          </label>

          <label className="wiki-field">
            <span className="wiki-field-label">Note about this addition</span>
            <input
              type="text"
              className="wiki-input"
              required
              minLength={3}
              placeholder="e.g. From family photo album or 1880 census"
              value={summary}
              onChange={(e) => {
                setSummary(e.target.value);
              }}
            />
          </label>

          <div className="wiki-form-actions">
            <button
              type="submit"
              className="wiki-btn-primary wiki-btn-sm"
              disabled={submitting || !isEditSummaryValid(summary)}
            >
              {submitLabel}
            </button>
            <button type="button" className="pill-btn" onClick={onClose}>
              Cancel
            </button>
          </div>
        </form>
      </div>
    </dialog>
  );
};
