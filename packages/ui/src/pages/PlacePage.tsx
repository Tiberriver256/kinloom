import type { ArchiveEvent, Person } from '@kinloom/core';
import { haversineMiles, resolvePlacePronunciation } from '@kinloom/core';
import type React from 'react';
import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { DateStamp, resolveAssetUrl, SourceCitationTag } from '../components/Atoms.js';
import { ExplorerTopBar } from '../components/ExplorerTopBar.js';
import { KinloomFooter } from '../components/KinloomFooter.js';
import { LocalSurveyMap } from '../components/LocalSurveyMap.js';
import { MediaPlayer } from '../components/MediaPlayer.js';
import { PronunciationBadge } from '../components/PronunciationBadge.js';
import { EntityEditDrawer, type EntityEditDrawerSection } from '../components/wiki/EntityEditDrawer.js';
import { RevisionHistoryPanel } from '../components/wiki/RevisionHistoryPanel.js';
import { TalkPanel } from '../components/wiki/TalkPanel.js';
import { WikiActionBar, type WikiEntityTab } from '../components/wiki/WikiActionBar.js';
import { useArchiveData } from '../context/ArchiveDataContext.js';
import { formatReaderLoadError, KINLOOM_VOCABULARY } from '../lib/vocabulary.js';
import { PluginSlot } from '../plugins/PluginContext.js';

type ScopeMode = 'exact' | 'radius15' | 'county';

export const PlacePage: React.FC = () => {
  const { slug } = useParams<{ slug: string }>();
  const {
    bundle,
    baseUrl,
    capabilities,
    placesBySlug,
    placesById,
    peopleById,
    sourcesById,
    pronunciations,
    loading,
    error,
    reloadArchive,
  } = useArchiveData();

  const [scopeMode, setScopeMode] = useState<ScopeMode>('radius15');
  const [decadeFilter, setDecadeFilter] = useState<string>('all');
  const [wikiTab, setWikiTab] = useState<WikiEntityTab>('read');
  const [editInitialSection, setEditInitialSection] = useState<EntityEditDrawerSection | undefined>(
    undefined
  );

  const place = slug ? placesBySlug.get(slug) : undefined;

  const matchingPlaceIds = useMemo(() => {
    if (!bundle || !place) {
      return new Set<string>();
    }
    const set = new Set<string>([place.id]);
    const myAnc = bundle.place_ancestors[place.id] || [];
    const countyAnc = myAnc.find((id) => placesById.get(id)?.place_type === 'county') || place.parent_id;

    for (const other of bundle.places) {
      if (other.id === place.id) {
        continue;
      }
      if (scopeMode === 'exact') {
        if ((bundle.place_ancestors[other.id] || []).includes(place.id)) {
          set.add(other.id);
        }
      } else if (scopeMode === 'radius15') {
        const d = haversineMiles(place.lat, place.lng, other.lat, other.lng);
        if (d <= 15 || (bundle.place_ancestors[other.id] || []).includes(place.id)) {
          set.add(other.id);
        }
      } else if (scopeMode === 'county') {
        const otherAnc = bundle.place_ancestors[other.id] || [];
        if (
          (countyAnc && otherAnc.includes(countyAnc)) ||
          otherAnc.includes(place.id) ||
          myAnc.includes(other.id)
        ) {
          set.add(other.id);
        }
      }
    }
    return set;
  }, [bundle, place, scopeMode, placesById]);

  const ancestorIds = useMemo(() => {
    if (!bundle || !place) {
      return new Set<string>();
    }
    return new Set<string>(bundle.place_ancestors[place.id] || []);
  }, [bundle, place]);

  const occupancyRows = useMemo(() => {
    if (!bundle || !place) {
      return { rows: [], minYear: 1800, maxYear: 2000 };
    }
    const byPerson = new Map<
      string,
      {
        person: Person;
        startYear: number;
        endYear: number;
        firstEventId: string;
        tier: 'Confirmed' | 'Inferred' | 'Possible';
      }
    >();

    for (const ev of bundle.events) {
      if (ev.scope !== 'personal' && ev.scope !== 'family') {
        continue;
      }
      if (!ev.place_id || !matchingPlaceIds.has(ev.place_id) || ev.year === null) {
        continue;
      }
      for (const pt of ev.participants) {
        const person = peopleById.get(pt.person_id);
        if (!person || person.full_name === 'Living') {
          continue;
        }
        const cur = byPerson.get(person.id);
        if (cur) {
          if (ev.year < cur.startYear) {
            cur.startYear = ev.year;
            cur.firstEventId = ev.id;
          }
          if (ev.year > cur.endYear) {
            cur.endYear = ev.year;
          }
        } else {
          byPerson.set(person.id, {
            person,
            startYear: ev.year,
            endYear: ev.year,
            firstEventId: ev.id,
            tier: 'Confirmed',
          });
        }
      }
    }

    for (const span of bundle.residence_spans) {
      if (!matchingPlaceIds.has(span.place_id)) {
        continue;
      }
      if (span.start_year === null || span.end_year === null) {
        continue;
      }
      const person = peopleById.get(span.person_id);
      if (!person || person.full_name === 'Living') {
        continue;
      }
      const cur = byPerson.get(person.id);
      if (cur) {
        if (span.start_year < cur.startYear) {
          cur.startYear = span.start_year;
        }
        if (span.end_year > cur.endYear) {
          cur.endYear = span.end_year;
        }
      } else {
        byPerson.set(person.id, {
          person,
          startYear: span.start_year,
          endYear: span.end_year,
          firstEventId: span.from_event_id,
          tier: span.confidence_tier,
        });
      }
    }

    const rows = [...byPerson.values()].toSorted((a, b) => a.startYear - b.startYear);
    const minYear = rows.length > 0 ? Math.min(...rows.map((r) => r.startYear)) : 1850;
    const maxYear = rows.length > 0 ? Math.max(...rows.map((r) => r.endYear)) : 1960;
    return { rows, minYear, maxYear: Math.max(maxYear, minYear + 10) };
  }, [bundle, place, matchingPlaceIds, peopleById]);

  const scopeLocalRecords = useMemo(() => {
    if (!bundle || !place) {
      return [];
    }
    return bundle.events
      .filter((ev) => {
        if (ev.scope !== 'local' && ev.scope !== 'state') {
          return false;
        }
        if (!ev.place_id) {
          return false;
        }
        return matchingPlaceIds.has(ev.place_id);
      })
      .toSorted((a, b) => (a.year ?? 0) - (b.year ?? 0));
  }, [bundle, place, matchingPlaceIds]);

  const recordDecades = useMemo(() => {
    const set = new Set<number>();
    for (const ev of scopeLocalRecords) {
      if (ev.year !== null) {
        set.add(Math.floor(ev.year / 10) * 10);
      }
    }
    return [...set].toSorted((a, b) => a - b);
  }, [scopeLocalRecords]);

  const effectiveDecadeFilter =
    decadeFilter !== 'all' && recordDecades.some((d) => String(d) === decadeFilter) ? decadeFilter : 'all';

  const localRecords = useMemo(() => {
    if (effectiveDecadeFilter === 'all') {
      return scopeLocalRecords;
    }
    return scopeLocalRecords.filter((ev) => {
      if (ev.year === null) {
        return false;
      }
      return String(Math.floor(ev.year / 10) * 10) === effectiveDecadeFilter;
    });
  }, [scopeLocalRecords, effectiveDecadeFilter]);

  if (loading) {
    return (
      <div>
        <ExplorerTopBar />
        <main id="main-content" className="place-page">
          Loading archive…
        </main>
      </div>
    );
  }
  if (error || !bundle || !place) {
    return (
      <div>
        <ExplorerTopBar />
        <main id="main-content" className="place-page">
          <h1>{KINLOOM_VOCABULARY.place.notFoundHeading}</h1>
          <p>{formatReaderLoadError(error, 'We could not find that place in the archive.')}</p>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center' }}>
            {error && (
              <button
                type="button"
                className="pill-btn"
                onClick={() => {
                  reloadArchive();
                }}
              >
                Try again
              </button>
            )}
            <Link to="/places" className="pill-btn">
              {KINLOOM_VOCABULARY.place.returnToPlaces}
            </Link>
          </div>
        </main>
        <KinloomFooter />
      </div>
    );
  }

  const spanYears = Math.max(1, occupancyRows.maxYear - occupancyRows.minYear);
  const placePhotoSrc = place.photo_url ? resolveAssetUrl(place.photo_url, baseUrl) : '';
  const placePhotoMedia = place.photo_url
    ? {
        id: `place-photo-${place.id}`,
        kind: 'milestone' as const,
        file: place.photo_url,
        caption: place.photo_caption || `Archival view of ${place.full_name}`,
      }
    : null;

  const isReadingProfile = wikiTab !== 'history' && wikiTab !== 'talk';

  return (
    <div>
      <ExplorerTopBar />
      <main id="main-content" className="place-page">
        {occupancyRows.rows.length > 0 && (
          <div
            className="print-hide"
            style={{ marginBottom: 14, display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'center' }}
          >
            <Link to={`/time?year=${occupancyRows.minYear}`} className="ink-link-btn">
              See Family in {occupancyRows.minYear} →
            </Link>
          </div>
        )}

        <section className="place-map-box">
          <div style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
            <div>
              <h1 className="place-dossier-title">{place.full_name}</h1>
              {(() => {
                const effectivePronunciation = resolvePlacePronunciation(place, pronunciations);
                if (!effectivePronunciation && !capabilities.canEdit) {
                  return null;
                }
                return (
                  <div className="place-pronunciation-row">
                    {effectivePronunciation ? (
                      <>
                        <PronunciationBadge
                          pronunciation={effectivePronunciation}
                          label={place.name}
                          baseUrl={baseUrl}
                        />
                        {capabilities.canEdit && (
                          <button
                            type="button"
                            className="pronunciation-edit-link print-hide"
                            onClick={() => {
                              setEditInitialSection('pronunciation');
                              setWikiTab('edit');
                            }}
                            aria-label={`Edit pronunciation for ${place.name}`}
                          >
                            {KINLOOM_VOCABULARY.person.editPronunciation}
                          </button>
                        )}
                      </>
                    ) : (
                      <button
                        type="button"
                        className="pronunciation-edit-link print-hide"
                        onClick={() => {
                          setEditInitialSection('pronunciation');
                          setWikiTab('edit');
                        }}
                      >
                        {KINLOOM_VOCABULARY.person.addPronunciation}
                      </button>
                    )}
                  </div>
                );
              })()}
            </div>

            <div
              className="filter-bar place-scope-bar print-hide"
              style={{ margin: 0 }}
              role="group"
              aria-label="Map area filter"
            >
              <button
                type="button"
                className={`pill-btn ${scopeMode === 'exact' ? 'active' : ''}`}
                onClick={() => {
                  setScopeMode('exact');
                }}
              >
                Exact Place
              </button>
              <button
                type="button"
                className={`pill-btn ${scopeMode === 'radius15' ? 'active' : ''}`}
                onClick={() => {
                  setScopeMode('radius15');
                }}
              >
                15-Mile Radius
              </button>
              <button
                type="button"
                className={`pill-btn ${scopeMode === 'county' ? 'active' : ''}`}
                onClick={() => {
                  setScopeMode('county');
                }}
              >
                Historical County
              </button>
              <Link to={`/map?place=${place.slug}`} className="ink-link-btn">
                Migration Map →
              </Link>
            </div>
          </div>

          <WikiActionBar
            activeTab={wikiTab}
            onSelectTab={(nextTab) => {
              if (nextTab === 'edit') {
                setEditInitialSection(undefined);
              }
              setWikiTab(nextTab);
            }}
            entityLabel={place.full_name}
          />

          <PluginSlot name="placeDetail" place={place} />

          {wikiTab === 'history' && <RevisionHistoryPanel entityType="place" entityId={place.id} />}

          {wikiTab === 'talk' && (
            <TalkPanel entityType="place" entityId={place.id} entityTitle={place.full_name} />
          )}

          {isReadingProfile && (
            <div style={{ marginTop: 14 }}>
              <LocalSurveyMap
                center={place}
                allPlaces={bundle.places}
                scopeMode={scopeMode}
                excludeIds={ancestorIds}
              />
            </div>
          )}
        </section>

        {isReadingProfile &&
          (place.summary ||
            placePhotoSrc ||
            (place.historical_names && place.historical_names.length > 0)) && (
            <section className="place-map-box place-history-section">
              <h2 style={{ fontFamily: 'var(--font-serif)', margin: '0 0 12px' }}>Historical Profile</h2>
              <div className={placePhotoSrc ? 'place-history-grid' : undefined}>
                <div className="place-history-copy">
                  {place.summary && <p className="place-history-summary">{place.summary}</p>}
                  {place.historical_names && place.historical_names.length > 0 && (
                    <div
                      className="place-historical-names"
                      role="region"
                      aria-label="Historical jurisdictions"
                    >
                      <span className="place-historical-names-label">Jurisdictions:</span>
                      <div className="place-historical-names-list">
                        {place.historical_names.map((hn) => {
                          const span =
                            hn.valid_from || hn.valid_to
                              ? ` (${hn.valid_from || '?'}–${hn.valid_to || 'present'})`
                              : '';
                          return (
                            <span
                              key={`${hn.name}-${hn.valid_from || ''}-${hn.valid_to || ''}`}
                              className="place-jurisdiction-chip"
                            >
                              {hn.name}
                              {span}
                            </span>
                          );
                        })}
                      </div>
                    </div>
                  )}
                  {place.sources && place.sources.length > 0 && (
                    <SourceCitationTag sources={place.sources} sourcesById={sourcesById} />
                  )}
                </div>
                {placePhotoSrc && placePhotoMedia && (
                  <figure className="place-history-figure">
                    <MediaPlayer media={placePhotoMedia} baseUrl={baseUrl} variant="full" />
                    {place.photo_caption && <figcaption>{place.photo_caption}</figcaption>}
                  </figure>
                )}
              </div>
            </section>
          )}

        {isReadingProfile && (
          <section className="place-map-box">
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'baseline',
                flexWrap: 'wrap',
                gap: 8,
                marginBottom: 12,
              }}
            >
              <h2 style={{ fontFamily: 'var(--font-serif)', margin: 0 }}>Who Passed Through</h2>
              <span
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: '0.78rem',
                  color: 'var(--text-secondary)',
                }}
              >
                {occupancyRows.minYear} — {occupancyRows.maxYear}
              </span>
            </div>

            {occupancyRows.rows.length === 0 ? (
              <p className="empty-ring-note">No family residency records found in this area.</p>
            ) : (
              <div>
                {occupancyRows.rows.map((row) => {
                  const rawLeftPct = ((row.startYear - occupancyRows.minYear) / spanYears) * 100;
                  const widthPct = Math.max(4, (Math.max(1, row.endYear - row.startYear) / spanYears) * 100);
                  const leftPct = Math.max(0, Math.min(100 - widthPct, rawLeftPct));
                  const yearLabel =
                    row.startYear === row.endYear ? String(row.startYear) : `${row.startYear}–${row.endYear}`;
                  return (
                    <Link
                      key={row.person.id}
                      to={`/person/${row.person.slug}?event=${row.firstEventId}`}
                      className="occupancy-row"
                      aria-label={`Jump to ${row.person.full_name} (${yearLabel})`}
                    >
                      <span className="occupancy-row-header">
                        <span className="occupancy-person-name">{row.person.full_name}</span>
                        <span className="occupancy-year-label">{yearLabel}</span>
                      </span>
                      <span className="occupancy-track" aria-hidden="true">
                        <span
                          className={`occupancy-bar ${row.tier.toLowerCase()}`}
                          style={{ left: `${leftPct}%`, width: `${Math.min(100 - leftPct, widthPct)}%` }}
                        />
                      </span>
                    </Link>
                  );
                })}
              </div>
            )}
          </section>
        )}

        {isReadingProfile && (
          <section className="place-map-box">
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                flexWrap: 'wrap',
                gap: 10,
                marginBottom: 12,
              }}
            >
              <h2 style={{ fontFamily: 'var(--font-serif)', margin: 0 }}>
                {KINLOOM_VOCABULARY.place.localHistoryHeading}
              </h2>
              <div className="filter-bar place-decade-bar print-hide" style={{ margin: 0 }}>
                <button
                  type="button"
                  className={`pill-btn ${effectiveDecadeFilter === 'all' ? 'active' : ''}`}
                  aria-pressed={effectiveDecadeFilter === 'all'}
                  onClick={() => {
                    setDecadeFilter('all');
                  }}
                >
                  All Decades
                </button>
                {recordDecades.map((d) => (
                  <button
                    key={d}
                    type="button"
                    className={`pill-btn ${effectiveDecadeFilter === String(d) ? 'active' : ''}`}
                    aria-pressed={effectiveDecadeFilter === String(d)}
                    onClick={() => {
                      setDecadeFilter(String(d));
                    }}
                  >
                    {d}s
                  </button>
                ))}
              </div>
            </div>

            {localRecords.length === 0 ? (
              <p className="empty-ring-note">{KINLOOM_VOCABULARY.place.localHistoryEmpty}</p>
            ) : (
              <div style={{ display: 'grid', gap: 12 }}>
                {localRecords.map((ev: ArchiveEvent) => (
                  <article key={ev.id} className="story-card" style={{ padding: 14 }}>
                    <div className="story-card-top">
                      <DateStamp displayDate={ev.display_date} edtf={ev.edtf_date} />
                    </div>
                    <h3 style={{ fontFamily: 'var(--font-serif)', margin: '0 0 6px', fontSize: '1.02rem' }}>
                      {ev.title}
                    </h3>
                    <p style={{ margin: 0, fontSize: '0.9rem' }}>{ev.summary}</p>
                    {ev.source_url && (
                      <div className="print-hide" style={{ marginTop: 8 }}>
                        <a
                          href={ev.source_url}
                          target="_blank"
                          rel="noreferrer"
                          className="pill-btn"
                          style={{ textDecoration: 'none' }}
                        >
                          View External Record ↗
                        </a>
                      </div>
                    )}
                    <SourceCitationTag
                      sources={ev.sources}
                      alternateDates={ev.alternate_dates}
                      alternatePlaces={ev.alternate_places}
                      factConflicts={ev.fact_conflicts}
                      sourcesById={sourcesById}
                      eventId={ev.id}
                    />
                  </article>
                ))}
              </div>
            )}
          </section>
        )}
      </main>
      <EntityEditDrawer
        open={wikiTab === 'edit'}
        initialSection={editInitialSection}
        entityType="place"
        entityId={place.id}
        revisionId={bundle.meta.max_revision_id ?? 1}
        initialData={{
          id: place.id,
          slug: place.slug,
          name: place.name,
          full_name: place.full_name,
          place_type: place.place_type,
          parent_id: place.parent_id,
          lat: place.lat,
          lng: place.lng,
          summary: place.summary ?? '',
          photo_url: place.photo_url ?? null,
          photo_caption: place.photo_caption ?? null,
          pronunciation: place.pronunciation ?? null,
          has_primary_source: place.has_primary_source,
        }}
        hasPrimarySource={place.has_primary_source ?? true}
        title={place.full_name}
        onClose={() => {
          setEditInitialSection(undefined);
          setWikiTab('read');
        }}
      />
      <KinloomFooter />
    </div>
  );
};
