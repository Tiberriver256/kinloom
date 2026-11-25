import { Link, useSearchParams } from 'react-router-dom';
import React, { useMemo, useState } from 'react';
import { findKinshipPath } from '@kinloom/core';
import { ExplorerTopBar } from '../components/ExplorerTopBar.js';
import { KinloomFooter } from '../components/KinloomFooter.js';
import { initialsOf } from '../components/Atoms.js';
import { useArchiveData } from '../context/ArchiveDataContext.js';

export const KinshipPage: React.FC = () => {
  const { siteConfig, bundle, peopleById, peopleBySlug, placesById, loading } = useArchiveData();
  const [searchParams] = useSearchParams();

  const selectablePeople = useMemo(() => {
    if (!bundle) {
      return [];
    }
    return bundle.people
      .filter((p) => !p.is_living || p.full_name !== 'Living')
      .toSorted((a, b) => (a.birth_year ?? 9999) - (b.birth_year ?? 9999) || a.full_name.localeCompare(b.full_name));
  }, [bundle]);

  const resolvedPresets = useMemo(() => {
    const items: { label: string; fromId: string; toId: string; note?: string }[] = [];
    for (const pair of siteConfig.featuredKinshipPairs) {
      const pA = peopleById.get(pair.fromId) ?? peopleBySlug.get(pair.fromId);
      const pB = peopleById.get(pair.toId) ?? peopleBySlug.get(pair.toId);
      if (pA && pB) {
        items.push({ label: pair.label, fromId: pA.id, toId: pB.id, note: pair.note });
      }
    }
    return items;
  }, [siteConfig.featuredKinshipPairs, peopleById, peopleBySlug]);

  const paramFrom = searchParams.get('from');
  const paramTo = searchParams.get('to');
  const fromParamPerson = paramFrom ? (peopleBySlug.get(paramFrom) ?? peopleById.get(paramFrom)) : undefined;
  const toParamPerson = paramTo ? (peopleBySlug.get(paramTo) ?? peopleById.get(paramTo)) : undefined;

  const defaultFrom =
    (fromParamPerson && (!fromParamPerson.is_living || fromParamPerson.full_name !== 'Living')
      ? fromParamPerson.id
      : undefined) ||
    resolvedPresets[0]?.fromId ||
    selectablePeople[0]?.id ||
    '';

  const defaultTo =
    (toParamPerson && (!toParamPerson.is_living || toParamPerson.full_name !== 'Living')
      ? toParamPerson.id
      : undefined) ||
    (resolvedPresets[0]?.toId && resolvedPresets[0].toId !== defaultFrom ? resolvedPresets[0].toId : undefined) ||
    selectablePeople.find((p) => p.id !== defaultFrom)?.id ||
    selectablePeople[0]?.id ||
    '';

  const [fromId, setFromId] = useState<string>('');
  const [toId, setToId] = useState<string>('');

  const effectiveFromId = fromId || defaultFrom;
  const effectiveToId = toId || defaultTo;

  const result = useMemo(() => {
    if (!bundle || !effectiveFromId || !effectiveToId) {
      return null;
    }
    return findKinshipPath({
      fromId: effectiveFromId,
      toId: effectiveToId,
      bundle,
      placesById,
    });
  }, [bundle, effectiveFromId, effectiveToId, placesById]);

  const personA = peopleById.get(effectiveFromId);
  const personB = peopleById.get(effectiveToId);

  if (loading || !bundle) {
    return (
      <div>
        <ExplorerTopBar />
        <main className="index-page">Loading kinship archive…</main>
      </div>
    );
  }

  return (
    <div>
      <ExplorerTopBar />
      <main className="place-page">
        <section className="wire-banner" style={{ marginBottom: 18 }}>
          <div>
            <h1>Kinship &amp; Life-Overlap Finder</h1>
            <p>
              Select any two relatives in the archive to trace their shortest documented kinship path,
              overlapping years alive, and shared homestead communities.
            </p>
          </div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <Link to="/tree" className="pill-btn" style={{ textDecoration: 'none' }}>
              2D Family Tree →
            </Link>
            <Link to="/map" className="pill-btn" style={{ textDecoration: 'none' }}>
              Migration Map →
            </Link>
          </div>
        </section>

        {resolvedPresets.length > 0 && (
          <div className="filter-bar" style={{ marginBottom: 14 }}>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
              Examples:
            </span>
            {resolvedPresets.map((preset) => (
              <button
                key={preset.label}
                type="button"
                className="pill-btn"
                title={preset.note}
                onClick={() => {
                  setFromId(preset.fromId);
                  setToId(preset.toId);
                }}
              >
                {preset.label}
              </button>
            ))}
          </div>
        )}

        <section className="kinship-selector-card">
          <div className="kinship-selector-grid">
            <label className="kinship-field">
              <span>Person A</span>
              <select
                className="pill-btn"
                value={effectiveFromId}
                onChange={(e) => {
                  setFromId(e.target.value);
                }}
                aria-label="Select first relative"
              >
                {selectablePeople.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.full_name} ({p.birth_year || '?'}–{p.death_year || '?'})
                  </option>
                ))}
              </select>
            </label>

            <button
              type="button"
              className="pill-btn"
              onClick={() => {
                setFromId(effectiveToId);
                setToId(effectiveFromId);
              }}
              aria-label="Swap relatives"
              title="Swap Person A and Person B"
            >
              ⇄ Swap
            </button>

            <label className="kinship-field">
              <span>Person B</span>
              <select
                className="pill-btn"
                value={effectiveToId}
                onChange={(e) => {
                  setToId(e.target.value);
                }}
                aria-label="Select second relative"
              >
                {selectablePeople.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.full_name} ({p.birth_year || '?'}–{p.death_year || '?'})
                  </option>
                ))}
              </select>
            </label>
          </div>
        </section>

        {result && personA && personB && (
          <section className="place-map-box" style={{ marginTop: 18 }}>
            <h2 style={{ fontFamily: 'var(--font-serif)', fontSize: '1.5rem', margin: '0 0 4px', color: 'var(--surface-header)' }}>
              {personA.full_name} is the <span style={{ color: 'var(--radar-copresence)' }}>{result.relationshipLabel}</span> {personB.full_name}
            </h2>
            <p style={{ margin: '0 0 12px', fontFamily: 'var(--font-mono)', fontSize: '0.78rem', color: 'var(--text-secondary)' }}>
              Documented relationship computed across compiled kinship links
            </p>

            <div className="kinship-stats-row">
              <div className="kinship-stat-box">
                <div className="kinship-stat-label">GENERATIONAL / KINSHIP HOPS</div>
                <div className="kinship-stat-value">
                  {result.connected ? `${result.steps.length} step${result.steps.length === 1 ? '' : 's'}` : 'Unlinked'}
                </div>
              </div>
              <div className="kinship-stat-box">
                <div className="kinship-stat-label">OVERLAPPING YEARS ALIVE</div>
                <div className="kinship-stat-value">
                  {result.overlapYears
                    ? `${result.overlapYears.start}–${result.overlapYears.end} (${result.overlapYears.durationYears} yrs)`
                    : 'No lifespan overlap'}
                </div>
              </div>
              <div className="kinship-stat-box">
                <div className="kinship-stat-label">SHARED ARCHIVED PLACES</div>
                <div className="kinship-stat-value">
                  {result.sharedPlaces.length > 0
                    ? `${result.sharedPlaces.length} community match${result.sharedPlaces.length === 1 ? '' : 'es'}`
                    : 'Distinct migration eras'}
                </div>
              </div>
            </div>

            {result.connected && result.personIds.length > 0 && (
              <div style={{ marginTop: 18 }}>
                <div style={{ fontFamily: 'var(--font-mono)', fontSize: '0.78rem', color: 'var(--text-secondary)', marginBottom: 10 }}>
                  SHORTEST LINEAGE CHAIN (CLICK ANY RELATIVE TO OPEN TIMELINE):
                </div>
                <div className="kinship-chain">
                  {result.personIds.map((pid, idx) => {
                    const p = peopleById.get(pid);
                    const step = idx > 0 ? result.steps[idx - 1] : null;
                    if (!p) {
                      return null;
                    }
                    let edgeLabel = '';
                    if (step?.relation === 'parent') {
                      edgeLabel = 'parent of →';
                    } else if (step?.relation === 'child') {
                      edgeLabel = 'child of →';
                    } else if (step?.relation === 'spouse') {
                      edgeLabel = 'married to ↔';
                    }
                    return (
                      <React.Fragment key={pid}>
                        {step && <span className="kinship-edge-badge">{edgeLabel}</span>}
                        <Link to={`/person/${p.slug}`} className="kinship-node-pill">
                          <span className="avatar-circle" style={{ width: 28, height: 28, fontSize: '0.75rem' }}>
                            {initialsOf(p.full_name)}
                          </span>
                          <span>
                            <strong>{p.full_name}</strong>
                            <span style={{ display: 'block', fontFamily: 'var(--font-mono)', fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                              {p.birth_year || '?'}–{p.death_year || '?'}
                            </span>
                          </span>
                        </Link>
                      </React.Fragment>
                    );
                  })}
                </div>
              </div>
            )}

            {result.sharedPlaces.length > 0 && (
              <div style={{ marginTop: 18, paddingTop: 14, borderTop: '1px solid var(--border-decorative)' }}>
                <div style={{ fontFamily: 'var(--font-mono)', fontSize: '0.78rem', color: 'var(--text-secondary)', marginBottom: 8 }}>
                  SHARED COMMUNITIES:
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {result.sharedPlaces.map(({ place }) => (
                    <Link
                      key={place.id}
                      to={`/place/${place.slug}`}
                      className="pill-btn"
                      style={{ textDecoration: 'none' }}
                    >
                      {place.full_name} →
                    </Link>
                  ))}
                </div>
              </div>
            )}
          </section>
        )}
      </main>
      <KinloomFooter />
    </div>
  );
};
