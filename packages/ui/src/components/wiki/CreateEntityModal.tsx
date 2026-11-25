import type { EntityPayload, EntityType, KinshipRelation } from '@kinloom/core';
import { deriveKinshipEdgeId, isEditSummaryValid } from '@kinloom/core';
import React, { useState } from 'react';
import { CitationBadge } from './WikiBadges.js';
import { useArchiveData } from '../../context/ArchiveDataContext.js';

export type CreatableKind = 'person' | 'event' | 'place' | 'kinship_edge';

export interface CreateEntityModalProps {
  open: boolean;
  defaultKind?: CreatableKind;
  defaultPersonId?: string;
  onClose: () => void;
  onCreated?: (entityType: EntityType, entity: EntityPayload) => void;
}

function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .replaceAll(/[^a-z0-9]+/g, '-')
      .replaceAll(/^-+|-+$/g, '') || 'record'
  );
}

export const CreateEntityModal: React.FC<CreateEntityModalProps> = ({
  open,
  defaultKind = 'person',
  defaultPersonId,
  onClose,
  onCreated,
}) => {
  const { dataSource, bundle, reloadArchive } = useArchiveData();
  const [kind, setKind] = useState<CreatableKind>(defaultKind);
  const [summary, setSummary] = useState('');
  const [hasPrimarySource, setHasPrimarySource] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Person fields
  const [givenName, setGivenName] = useState('');
  const [surname, setSurname] = useState('');
  const [birthEdtf, setBirthEdtf] = useState('');
  const [deathEdtf, setDeathEdtf] = useState('');
  const [isLiving, setIsLiving] = useState(false);

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

  // Kinship fields
  const [fromPersonId, setFromPersonId] = useState(defaultPersonId ?? '');
  const [toPersonId, setToPersonId] = useState('');
  const [relation, setRelation] = useState<KinshipRelation>('parent');

  if (!open) {
    return null;
  }

  const people = bundle?.people ?? [];
  const places = bundle?.places ?? [];

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

    let entityId: string;
    let payload: EntityPayload;

    if (kind === 'person') {
      const fullName = `${givenName.trim()} ${surname.trim()}`.trim();
      if (!fullName) {
        setError('Enter at least a given name or surname.');
        return;
      }
      const slug = slugify(fullName);
      entityId = `p_${slug.replaceAll('-', '_')}`;
      payload = {
        id: entityId,
        slug,
        full_name: fullName,
        given_name: givenName.trim() || fullName,
        surname: surname.trim(),
        alt_names: [],
        sex: 'U',
        is_living: isLiving,
        lineage_group: 'extended',
        birth_edtf: birthEdtf.trim(),
        death_edtf: deathEdtf.trim(),
        portrait_url: null,
        has_primary_source: hasPrimarySource,
      };
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
        summary: summary.trim(),
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

  return (
    <dialog open className="lightbox-backdrop" aria-label="Create new archive record">
      <button
        type="button"
        className="lightbox-backdrop-close"
        aria-label="Close create record modal"
        onClick={onClose}
      />
      <div className="wiki-modal-card">
        <div className="wiki-modal-header">
          <h2>Add New Archive Record</h2>
          <button type="button" className="pill-btn" onClick={onClose}>
            Close
          </button>
        </div>

        <div className="filter-bar" role="tablist" aria-label="Record type to create">
          {(
            [
              ['person', 'Person'],
              ['event', 'Event'],
              ['place', 'Place'],
              ['kinship_edge', 'Kinship Link'],
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
          {kind === 'person' && (
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
                <span className="wiki-field-label">Birth (EDTF)</span>
                <input
                  type="text"
                  className="wiki-input"
                  placeholder="1845-06-14"
                  value={birthEdtf}
                  onChange={(e) => {
                    setBirthEdtf(e.target.value);
                  }}
                />
              </label>
              <label className="wiki-field">
                <span className="wiki-field-label">Death (EDTF)</span>
                <input
                  type="text"
                  className="wiki-input"
                  placeholder="1912-03-01"
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
          )}

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
                <span className="wiki-field-label">Date (EDTF)</span>
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
                    setRelation(e.target.value as KinshipRelation);
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
            <span className="wiki-field-label">Edit summary (minimum 3 characters)</span>
            <input
              type="text"
              className="wiki-input"
              required
              minLength={3}
              placeholder="Explain the source or reason for adding this record"
              value={summary}
              onChange={(e) => {
                setSummary(e.target.value);
              }}
            />
          </label>

          <div className="wiki-form-actions">
            <button
              type="submit"
              className="pill-btn active"
              disabled={submitting || !isEditSummaryValid(summary)}
            >
              {submitting ? 'Creating…' : 'Create Record'}
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
