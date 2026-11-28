import { buildPersonThumbMap, findKinshipPath } from '@kinloom/core';
import type React from 'react';
import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { EmptyStateNotice, PersonPortrait } from '../components/Atoms.js';
import { ExplorerTopBar } from '../components/ExplorerTopBar.js';
import { KinloomFooter } from '../components/KinloomFooter.js';
import { useArchiveData } from '../context/ArchiveDataContext.js';
import { cx, joinClasses } from '../lib/cx.js';
import {
  computeLifespanOverlapSparkline,
  formatKinshipPresentation,
  type LifespanOverlapSparkline,
  partitionKinshipTopology,
} from '../lib/kinshipPresentation.js';
import { KINLOOM_VOCABULARY } from '../lib/vocabulary.js';
import controlStyles from '../styles/Controls.module.css';
import layoutStyles from '../styles/Layout.module.css';
import kinshipStyles from './KinshipPage.module.css';

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

const KinshipOverlapSparklineSvg: React.FC<{
  readonly sparkline: LifespanOverlapSparkline;
  readonly personAName: string;
  readonly personBName: string;
}> = ({ sparkline, personAName, personBName }) => {
  const viewW = 240;
  const viewH = 34;
  const toX = (pct: number): number => Number(((pct / 100) * viewW).toFixed(2));
  const aX = toX(sparkline.personA.leftPct);
  const aW = Math.max(4, toX(sparkline.personA.widthPct));
  const bX = toX(sparkline.personB.leftPct);
  const bW = Math.max(4, toX(sparkline.personB.widthPct));
  const overlapX = sparkline.overlap ? toX(sparkline.overlap.leftPct) : 0;
  const overlapW = sparkline.overlap ? Math.max(3, toX(sparkline.overlap.widthPct)) : 0;

  return (
    <div className={cx(kinshipStyles, 'kinship-overlap-timeline')}>
      <div className={cx(kinshipStyles, 'kinship-overlap-legend')}>
        <span className={cx(kinshipStyles, 'kinship-overlap-legend-item')}>
          <span className={cx(kinshipStyles, 'kinship-overlap-swatch is-a')} aria-hidden="true" />
          <span className={cx(kinshipStyles, 'kinship-overlap-legend-name')}>{personAName}</span>
          <span className={cx(kinshipStyles, 'kinship-overlap-legend-years')}>
            {sparkline.personA.startYear}–{sparkline.personA.endYear}
          </span>
        </span>
        <span className={cx(kinshipStyles, 'kinship-overlap-legend-item')}>
          <span className={cx(kinshipStyles, 'kinship-overlap-swatch is-b')} aria-hidden="true" />
          <span className={cx(kinshipStyles, 'kinship-overlap-legend-name')}>{personBName}</span>
          <span className={cx(kinshipStyles, 'kinship-overlap-legend-years')}>
            {sparkline.personB.startYear}–{sparkline.personB.endYear}
          </span>
        </span>
      </div>
      <svg
        className={cx(kinshipStyles, 'kinship-overlap-sparkline')}
        viewBox={`0 0 ${viewW} ${viewH}`}
        role="img"
        aria-label={
          sparkline.overlap
            ? `Lifespan bars for ${personAName} (${sparkline.personA.startYear}–${sparkline.personA.endYear}) and ${personBName} (${sparkline.personB.startYear}–${sparkline.personB.endYear}), overlapping ${sparkline.overlap.startYear}–${sparkline.overlap.endYear}`
            : `Lifespan bars for ${personAName} (${sparkline.personA.startYear}–${sparkline.personA.endYear}) and ${personBName} (${sparkline.personB.startYear}–${sparkline.personB.endYear}) with no overlap`
        }
      >
        <line x1={0} y1={17} x2={viewW} y2={17} stroke="var(--border-decorative)" strokeWidth="1" />
        {sparkline.overlap && (
          <g>
            <rect
              x={overlapX}
              y={2}
              width={overlapW}
              height={viewH - 4}
              fill="var(--accent-primary)"
              fillOpacity="0.28"
            />
            <line
              x1={overlapX}
              y1={2}
              x2={overlapX}
              y2={viewH - 2}
              stroke="var(--accent-primary)"
              strokeWidth="1.2"
            />
            <line
              x1={overlapX + overlapW}
              y1={2}
              x2={overlapX + overlapW}
              y2={viewH - 2}
              stroke="var(--accent-primary)"
              strokeWidth="1.2"
            />
          </g>
        )}
        <rect x={aX} y={6} width={aW} height={7} rx={2} fill="var(--surface-header)" fillOpacity="0.7" />
        <rect x={bX} y={21} width={bW} height={7} rx={2} fill="var(--accent-secondary)" fillOpacity="0.7" />
      </svg>
      <div className={cx(kinshipStyles, 'kinship-overlap-axis')} aria-hidden="true">
        <span>{sparkline.minYear}</span>
        {sparkline.overlap && (
          <span className={cx(kinshipStyles, 'kinship-overlap-axis-shared')}>
            Overlap {sparkline.overlap.startYear}–{sparkline.overlap.endYear}
          </span>
        )}
        <span>{sparkline.maxYear}</span>
      </div>
    </div>
  );
};

export const KinshipPage: React.FC = () => {
  const { siteConfig, baseUrl, bundle, peopleById, peopleBySlug, placesById, loading } = useArchiveData();
  const [searchParams] = useSearchParams();

  const personThumbMap = useMemo(
    () => (bundle ? buildPersonThumbMap(bundle) : new Map<string, string>()),
    [bundle]
  );

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
        items.push({
          label: pair.label.replace(/\s*<->\s*/g, ' ↔ '),
          fromId: pA.id,
          toId: pB.id,
          ...(pair.note !== undefined ? { note: pair.note } : {}),
        });
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
        <main id="main-content" className={cx(layoutStyles, 'index-page')}>
          <div
            className={cx(kinshipStyles, 'kinship-loading-skeleton')}
            role="status"
            aria-label="Loading kinship archive"
          >
            <span className={cx(kinshipStyles, 'visually-hidden')}>Loading kinship archive…</span>
            <div className={cx(kinshipStyles, 'kinship-skeleton-line kinship-skeleton-line-lg')} />
            <div className={cx(kinshipStyles, 'kinship-skeleton-card')} />
            <div className={cx(kinshipStyles, 'kinship-skeleton-card kinship-skeleton-card-tall')} />
          </div>
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

  const topology =
    result?.connected && result.personIds.length > 0
      ? partitionKinshipTopology(result.personIds, result.steps)
      : null;

  const sparkline =
    result && personA && personB
      ? computeLifespanOverlapSparkline(personA, personB, result.overlapYears)
      : null;

  const treePathUrl =
    result?.connected && result.personIds.length > 1 && personA
      ? `/tree?mode=full&focus=${encodeURIComponent(personA.slug)}&path=${encodeURIComponent(
          result.personIds.map((id) => peopleById.get(id)?.slug || id).join(',')
        )}`
      : null;

  return (
    <div>
      <ExplorerTopBar />
      <main id="main-content" className={cx(layoutStyles, 'place-page')}>
        <section
          className={joinClasses(cx(layoutStyles, 'wire-banner'), cx(kinshipStyles, 'kinship-banner'))}
        >
          <div>
            <h1>{KINLOOM_VOCABULARY.kinship.heading}</h1>
            <p>{KINLOOM_VOCABULARY.kinship.lead}</p>
          </div>
          <div className={cx(kinshipStyles, 'kinship-banner-links print-hide')}>
            <Link to="/tree" className={cx(controlStyles, 'pill-btn')} style={{ textDecoration: 'none' }}>
              {KINLOOM_VOCABULARY.kinship.familyTreeCta}
            </Link>
            <Link to="/map" className={cx(controlStyles, 'pill-btn')} style={{ textDecoration: 'none' }}>
              {KINLOOM_VOCABULARY.kinship.migrationMapCta}
            </Link>
          </div>
        </section>

        {selectablePeople.length < 2 ? (
          <EmptyStateNotice
            title="At least two people are needed to compare kinship."
            body="Add more family records to trace relationships, lifespan overlap, and shared places."
            action={
              <Link to="/" className={cx(controlStyles, 'pill-btn')} style={{ textDecoration: 'none' }}>
                Return to People
              </Link>
            }
          />
        ) : (
          <>
            <section className={cx(kinshipStyles, 'kinship-selector-card print-hide')}>
              <div className={cx(kinshipStyles, 'kinship-selector-grid')}>
                <label className={cx(kinshipStyles, 'kinship-field kinship-field-a')}>
                  <span>Person A</span>
                  <select
                    className={cx(controlStyles, 'pill-btn')}
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
                  className={joinClasses(
                    cx(controlStyles, 'cta-btn-secondary'),
                    cx(kinshipStyles, 'kinship-swap-btn')
                  )}
                  onClick={() => {
                    setFromId(effectiveToId);
                    setToId(effectiveFromId);
                  }}
                  aria-label="Swap relatives"
                  title="Swap Person A and Person B"
                >
                  <span aria-hidden="true">⇄</span>
                  <span className={cx(kinshipStyles, 'kinship-swap-text')}> Swap</span>
                </button>

                <label className={cx(kinshipStyles, 'kinship-field kinship-field-b')}>
                  <span>Person B</span>
                  <select
                    className={cx(controlStyles, 'pill-btn')}
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

            <div className={cx(kinshipStyles, 'kinship-results-flow')}>
              {resolvedPresets.length > 0 && (
                <div
                  className={joinClasses(
                    cx(controlStyles, 'filter-bar print-hide'),
                    cx(kinshipStyles, 'kinship-examples-bar')
                  )}
                >
                  <span className={cx(kinshipStyles, 'kinship-examples-label')}>Examples:</span>
                  {resolvedPresets.map((preset) => (
                    <button
                      key={preset.label}
                      type="button"
                      className={cx(controlStyles, 'pill-btn kinship-example-chip')}
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
                <section
                  className={joinClasses(
                    cx(layoutStyles, 'place-map-box'),
                    cx(kinshipStyles, 'kinship-result-section')
                  )}
                >
                  <h2 className={cx(kinshipStyles, 'kinship-result-heading')}>
                    {presentation.headingPrefix}
                    <span style={{ color: 'var(--radar-copresence)' }}>{presentation.highlight}</span>
                    {presentation.headingSuffix}
                  </h2>
                  <p
                    style={{
                      margin: '0 0 12px',
                      fontFamily: 'var(--font-ui)',
                      fontSize: '0.78rem',
                      color: 'var(--text-secondary)',
                    }}
                  >
                    {presentation.subtitle}
                  </p>

                  <div className={cx(kinshipStyles, 'kinship-stats-row')}>
                    <div className={cx(kinshipStyles, 'kinship-stat-box')}>
                      <div className={cx(kinshipStyles, 'kinship-stat-label')}>Kinship distance</div>
                      <div className={cx(kinshipStyles, 'kinship-stat-value')}>{presentation.hopsValue}</div>
                    </div>
                    <div className={cx(kinshipStyles, 'kinship-stat-box')}>
                      <div className={cx(kinshipStyles, 'kinship-stat-label')}>OVERLAPPING YEARS ALIVE</div>
                      {result.overlapYears ? (
                        <Link
                          to={`/time?year=${result.overlapYears.start}`}
                          className={cx(kinshipStyles, 'kinship-overlap-link')}
                          aria-label={`Inspect family snapshot in ${result.overlapYears.start}`}
                        >
                          <div className={cx(kinshipStyles, 'kinship-stat-value')}>
                            {result.overlapYears.start}–{result.overlapYears.end} (
                            {result.overlapYears.durationYears} yrs) →
                          </div>
                          {sparkline && (
                            <KinshipOverlapSparklineSvg
                              sparkline={sparkline}
                              personAName={personA.full_name}
                              personBName={personB.full_name}
                            />
                          )}
                        </Link>
                      ) : (
                        <>
                          <div className={cx(kinshipStyles, 'kinship-stat-value')}>No lifespan overlap</div>
                          {sparkline && (
                            <KinshipOverlapSparklineSvg
                              sparkline={sparkline}
                              personAName={personA.full_name}
                              personBName={personB.full_name}
                            />
                          )}
                        </>
                      )}
                    </div>
                    <div className={cx(kinshipStyles, 'kinship-stat-box')}>
                      <div className={cx(kinshipStyles, 'kinship-stat-label')}>SHARED PLACES</div>
                      <div className={cx(kinshipStyles, 'kinship-stat-value')}>
                        {result.sharedPlaces.length > 0
                          ? `${result.sharedPlaces.length} shared place${result.sharedPlaces.length === 1 ? '' : 's'}`
                          : presentation.sharedPlacesEmptyText}
                      </div>
                    </div>
                  </div>

                  {result.connected && result.steps.length > 0 && topology && (
                    <div style={{ marginTop: 18 }}>
                      <div className={cx(kinshipStyles, 'kinship-path-header')}>
                        <div className={cx(kinshipStyles, 'kinship-path-hint')}>
                          {KINLOOM_VOCABULARY.kinship.shortestPathHint}
                        </div>
                        {treePathUrl && (
                          <Link
                            to={treePathUrl}
                            className={joinClasses(
                              cx(controlStyles, 'pill-btn print-hide'),
                              cx(kinshipStyles, 'kinship-tree-highlight-link')
                            )}
                          >
                            Highlight Path in Tree →
                          </Link>
                        )}
                      </div>

                      <ol
                        className={cx(
                          kinshipStyles,
                          topology.topology === 'v'
                            ? 'kinship-chain kinship-chain--v'
                            : 'kinship-chain kinship-chain--linear'
                        )}
                        aria-label="Kinship lineage path"
                      >
                        {topology.orderedNodes.map((node) => {
                          const p = peopleById.get(node.personId);
                          if (!p) {
                            return null;
                          }
                          const isV = topology.topology === 'v';
                          let relText = '';
                          let desktopArrow = '→';
                          let mobileArrow = '↓';
                          if (node.edgeFromPrev === 'parent') {
                            relText = 'parent of';
                            desktopArrow = isV ? '↓' : '→';
                            mobileArrow = '↓';
                          } else if (node.edgeFromPrev === 'child') {
                            relText = 'child of';
                            desktopArrow = isV ? '↑' : '→';
                            mobileArrow = '↓';
                          } else if (node.edgeFromPrev === 'spouse') {
                            relText = 'married to';
                            desktopArrow = '↔';
                            mobileArrow = '↕';
                          }

                          let itemRoleClass = 'kinship-step-item';
                          let gridStyle: React.CSSProperties | undefined;
                          if (isV) {
                            const ascendCount = topology.ascending.length;
                            if (node.role === 'apex') {
                              itemRoleClass = 'kinship-step-item is-apex';
                              gridStyle = { gridColumn: 2, gridRow: 1 };
                            } else if (node.index < ascendCount) {
                              itemRoleClass = 'kinship-step-item is-ascending';
                              gridStyle = { gridColumn: 1, gridRow: ascendCount + 1 - node.index };
                            } else {
                              const descOffset = node.index - ascendCount;
                              itemRoleClass = 'kinship-step-item is-descending';
                              gridStyle = { gridColumn: 3, gridRow: descOffset + 1 };
                            }
                          }

                          const isEndpoint =
                            node.index === 0 || node.index === topology.orderedNodes.length - 1;
                          const pillClass =
                            node.role === 'apex'
                              ? 'kinship-node-pill is-apex'
                              : isEndpoint
                                ? 'kinship-node-pill endpoint'
                                : 'kinship-node-pill';

                          return (
                            <li
                              key={node.personId}
                              className={cx(kinshipStyles, itemRoleClass)}
                              style={gridStyle}
                            >
                              {node.edgeFromPrev && (
                                <span className={cx(kinshipStyles, 'kinship-edge-badge')}>
                                  <span>{relText}</span>{' '}
                                  <span
                                    className={cx(kinshipStyles, 'kinship-arrow-desktop')}
                                    aria-hidden="true"
                                  >
                                    {desktopArrow}
                                  </span>
                                  <span
                                    className={cx(kinshipStyles, 'kinship-arrow-mobile')}
                                    aria-hidden="true"
                                  >
                                    {mobileArrow}
                                  </span>
                                </span>
                              )}
                              <Link to={`/person/${p.slug}`} className={cx(kinshipStyles, pillClass)}>
                                <PersonPortrait
                                  name={p.full_name}
                                  src={personThumbMap.get(p.id) || p.portrait_url}
                                  baseUrl={baseUrl}
                                  variant="circle"
                                  size="sm"
                                  loading="eager"
                                />
                                <span className={cx(kinshipStyles, 'kinship-node-body')}>
                                  {node.role === 'apex' && (
                                    <span className={cx(kinshipStyles, 'kinship-mrca-badge')}>
                                      Most Recent Common Ancestor
                                    </span>
                                  )}
                                  <strong>{p.full_name}</strong>
                                  <span className={cx(kinshipStyles, 'kinship-node-years')}>
                                    {p.birth_year || '?'}–{p.death_year || '?'}
                                  </span>
                                </span>
                              </Link>
                            </li>
                          );
                        })}
                      </ol>
                    </div>
                  )}

                  {result.sharedPlaces.length > 0 && (
                    <div
                      style={{
                        marginTop: 18,
                        paddingTop: 14,
                        borderTop: '1px solid var(--border-decorative)',
                      }}
                    >
                      <div
                        style={{
                          fontFamily: 'var(--font-ui)',
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
                            className={cx(controlStyles, 'pill-btn')}
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
            </div>
          </>
        )}
      </main>
      <KinloomFooter />
    </div>
  );
};
