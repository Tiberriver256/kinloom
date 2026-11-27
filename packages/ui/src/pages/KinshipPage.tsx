import { findKinshipPath } from '@kinloom/core';
import React, { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { EmptyStateNotice, initialsOf } from '../components/Atoms.js';
import cssMod0 from '../components/Atoms.module.css';
import { ExplorerTopBar } from '../components/ExplorerTopBar.js';
import { KinloomFooter } from '../components/KinloomFooter.js';
import { useArchiveData } from '../context/ArchiveDataContext.js';
import { cx } from '../lib/cx.js';
import { formatKinshipPresentation } from '../lib/kinshipPresentation.js';
import { KINLOOM_VOCABULARY } from '../lib/vocabulary.js';
import cssMod2 from './IndexPage.module.css';
import cssMod3 from './KinshipPage.module.css';
import cssMod4 from './NotFoundPage.module.css';
import cssMod5 from './PlacePage.module.css';

const uiStyles: Readonly<Record<string, string>> = {
  ...cssMod0,
  ...cssMod2,
  ...cssMod3,
  ...cssMod4,
  ...cssMod5,
};

function formatKinshipPersonOption(person: {
  full_name: string;
  birth_year: number | null;
  death_year: number | null;
}): string {
  const trimmed = person.full_name.trim();
  const years = `${person.birth_year || '?'}–${person.death_year || '?'}`;
  if (/\(\d{4}(?:[–-]\d{4})?\)$/.test(trimmed)) {
    return trimmed.replace(/\(\d{4}(?:[–-]\d{4})?\)$/, `(${years})`);
  }
  return `${trimmed} (${years})`;
}

export const KinshipPage: React.FC = () => {
  const { siteConfig, bundle, peopleById, peopleBySlug, placesById, loading } = useArchiveData();
  const [searchParams] = useSearchParams();

  const selectablePeople = useMemo(() => {
    if (!bundle) {
      return [];
    }
    return bundle.people
      .filter((p) => !p.is_living || p.full_name !== 'Living')
      .toSorted(
        (a, b) => (a.birth_year ?? 9999) - (b.birth_year ?? 9999) || a.full_name.localeCompare(b.full_name)
      );
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
    (resolvedPresets[0]?.toId && resolvedPresets[0].toId !== defaultFrom
      ? resolvedPresets[0].toId
      : undefined) ||
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
        <main id="main-content" className={cx(uiStyles, 'index-page')}>
          Loading kinship archive…
        </main>
      </div>
    );
  }

  const presentation =
    result && personA && personB
      ? formatKinshipPresentation({
          fromId: effectiveFromId,
          toId: effectiveToId,
          personAName: personA.full_name,
          personBName: personB.full_name,
          result,
        })
      : null;

  return (
    <div>
      <ExplorerTopBar />
      <main id="main-content" className={cx(uiStyles, 'place-page')}>
        <section className={cx(uiStyles, 'wire-banner')} style={{ marginBottom: 18 }}>
          <div>
            <h1>{KINLOOM_VOCABULARY.kinship.heading}</h1>
            <p>{KINLOOM_VOCABULARY.kinship.lead}</p>
          </div>
          <div className={cx(uiStyles, 'print-hide')} style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <Link to="/tree" className={cx(uiStyles, 'pill-btn')} style={{ textDecoration: 'none' }}>
              {KINLOOM_VOCABULARY.kinship.familyTreeCta}
            </Link>
            <Link to="/map" className={cx(uiStyles, 'pill-btn')} style={{ textDecoration: 'none' }}>
              {KINLOOM_VOCABULARY.kinship.migrationMapCta}
            </Link>
          </div>
        </section>

        {selectablePeople.length < 2 ? (
          <EmptyStateNotice
            title="At least two people are needed to compare kinship."
            body="Add more family records to trace relationships, lifespan overlap, and shared places."
            action={
              <Link to="/" className={cx(uiStyles, 'pill-btn')} style={{ textDecoration: 'none' }}>
                Return to People
              </Link>
            }
          />
        ) : (
          <>
            <section className={cx(uiStyles, 'kinship-selector-card print-hide')}>
              <div className={cx(uiStyles, 'kinship-selector-grid')}>
                <label className={cx(uiStyles, 'kinship-field')}>
                  <span>Person A</span>
                  <select
                    className={cx(uiStyles, 'pill-btn')}
                    value={effectiveFromId}
                    onChange={(e) => {
                      setFromId(e.target.value);
                    }}
                    aria-label="Select first relative"
                  >
                    {selectablePeople.map((p) => (
                      <option key={p.id} value={p.id}>
                        {formatKinshipPersonOption(p)}
                      </option>
                    ))}
                  </select>
                </label>

                <button
                  type="button"
                  className={cx(uiStyles, 'pill-btn')}
                  onClick={() => {
                    setFromId(effectiveToId);
                    setToId(effectiveFromId);
                  }}
                  aria-label="Swap relatives"
                  title="Swap Person A and Person B"
                >
                  ⇄ Swap
                </button>

                <label className={cx(uiStyles, 'kinship-field')}>
                  <span>Person B</span>
                  <select
                    className={cx(uiStyles, 'pill-btn')}
                    value={effectiveToId}
                    onChange={(e) => {
                      setToId(e.target.value);
                    }}
                    aria-label="Select second relative"
                  >
                    {selectablePeople.map((p) => (
                      <option key={p.id} value={p.id}>
                        {formatKinshipPersonOption(p)}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            </section>

            {resolvedPresets.length > 0 && (
              <div
                className={cx(uiStyles, 'filter-bar kinship-examples-bar print-hide')}
                style={{ marginTop: 12, marginBottom: 14 }}
              >
                <span className={cx(uiStyles, 'kinship-examples-label')}>Examples:</span>
                {resolvedPresets.map((preset) => (
                  <button
                    key={preset.label}
                    type="button"
                    className={cx(uiStyles, 'pill-btn kinship-example-chip')}
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

            {result && personA && personB && presentation && (
              <section className={cx(uiStyles, 'place-map-box')} style={{ marginTop: 18 }}>
                <h2 className={cx(uiStyles, 'kinship-result-heading')}>
                  {presentation.headingPrefix}
                  <span style={{ color: 'var(--radar-copresence)' }}>{presentation.highlight}</span>
                  {presentation.headingSuffix}
                </h2>
                <p
                  style={{
                    margin: '0 0 12px',
                    fontFamily: 'var(--font-mono)',
                    fontSize: '0.78rem',
                    color: 'var(--text-secondary)',
                  }}
                >
                  {presentation.subtitle}
                </p>

                <div className={cx(uiStyles, 'kinship-stats-row')}>
                  <div className={cx(uiStyles, 'kinship-stat-box')}>
                    <div className={cx(uiStyles, 'kinship-stat-label')}>GENERATIONAL / KINSHIP HOPS</div>
                    <div className={cx(uiStyles, 'kinship-stat-value')}>{presentation.hopsValue}</div>
                  </div>
                  <div className={cx(uiStyles, 'kinship-stat-box')}>
                    <div className={cx(uiStyles, 'kinship-stat-label')}>OVERLAPPING YEARS ALIVE</div>
                    <div className={cx(uiStyles, 'kinship-stat-value')}>
                      {result.overlapYears
                        ? `${result.overlapYears.start}–${result.overlapYears.end} (${result.overlapYears.durationYears} yrs)`
                        : 'No lifespan overlap'}
                    </div>
                  </div>
                  <div className={cx(uiStyles, 'kinship-stat-box')}>
                    <div className={cx(uiStyles, 'kinship-stat-label')}>SHARED PLACES</div>
                    <div className={cx(uiStyles, 'kinship-stat-value')}>
                      {result.sharedPlaces.length > 0
                        ? `${result.sharedPlaces.length} shared place${result.sharedPlaces.length === 1 ? '' : 's'}`
                        : presentation.sharedPlacesEmptyText}
                    </div>
                  </div>
                </div>

                {result.connected && result.steps.length > 0 && result.personIds.length > 0 && (
                  <div style={{ marginTop: 18 }}>
                    <div
                      style={{
                        fontFamily: 'var(--font-mono)',
                        fontSize: '0.78rem',
                        color: 'var(--text-secondary)',
                        marginBottom: 10,
                      }}
                    >
                      {KINLOOM_VOCABULARY.kinship.shortestPathHint}
                    </div>
                    <div className={cx(uiStyles, 'kinship-chain')}>
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
                            {step && <span className={cx(uiStyles, 'kinship-edge-badge')}>{edgeLabel}</span>}
                            <Link to={`/person/${p.slug}`} className={cx(uiStyles, 'kinship-node-pill')}>
                              <span
                                className={cx(uiStyles, 'avatar-circle')}
                                style={{ width: 28, height: 28, fontSize: '0.75rem' }}
                              >
                                {initialsOf(p.full_name)}
                              </span>
                              <span>
                                <strong>{p.full_name}</strong>
                                <span
                                  style={{
                                    display: 'block',
                                    fontFamily: 'var(--font-mono)',
                                    fontSize: '0.75rem',
                                    color: 'var(--text-secondary)',
                                  }}
                                >
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
                  <div
                    style={{ marginTop: 18, paddingTop: 14, borderTop: '1px solid var(--border-decorative)' }}
                  >
                    <div
                      style={{
                        fontFamily: 'var(--font-mono)',
                        fontSize: '0.78rem',
                        color: 'var(--text-secondary)',
                        marginBottom: 8,
                      }}
                    >
                      {KINLOOM_VOCABULARY.kinship.sharedPlacesHeading}
                    </div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                      {result.sharedPlaces.map(({ place }) => (
                        <Link
                          key={place.id}
                          to={`/place/${place.slug}`}
                          className={cx(uiStyles, 'pill-btn')}
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
          </>
        )}
      </main>
      <KinloomFooter />
    </div>
  );
};
