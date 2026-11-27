import { resolvePlacePronunciation } from '@kinloom/core';
import type React from 'react';
import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { resolveAssetUrl } from '../components/Atoms.js';
import atomStyles from '../components/Atoms.module.css';
import { ExplorerTopBar } from '../components/ExplorerTopBar.js';
import { KinloomFooter } from '../components/KinloomFooter.js';
import { LocalSurveyMap } from '../components/LocalSurveyMap.js';
import { PronunciationBadge } from '../components/PronunciationBadge.js';
import { EntityEditDrawer, type EntityEditDrawerSection } from '../components/wiki/EntityEditDrawer.js';
import { RevisionHistoryPanel } from '../components/wiki/RevisionHistoryPanel.js';
import { TalkPanel } from '../components/wiki/TalkPanel.js';
import { WikiActionBar, type WikiEntityTab } from '../components/wiki/WikiActionBar.js';
import { useArchiveData } from '../context/ArchiveDataContext.js';
import { cx } from '../lib/cx.js';
import { formatReaderLoadError, KINLOOM_VOCABULARY } from '../lib/vocabulary.js';
import { PluginSlot } from '../plugins/PluginContext.js';
import controlStyles from '../styles/Controls.module.css';
import placeStyles from './PlacePage.module.css';
import {
  PlaceHistoricalProfileSection,
  PlaceLocalHistorySection,
  PlaceOccupancySection,
} from './place/PlaceSections.js';
import {
  buildPlaceEditInitialData,
  buildPlaceOccupancySummary,
  buildPlacePhotoMedia,
  collectPlaceLocalRecords,
  collectRecordDecades,
  filterLocalRecordsByDecade,
  type PlaceScopeMode,
  resolveMatchingPlaceIds,
} from './place/placeViewModel.js';

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

  const [scopeMode, setScopeMode] = useState<PlaceScopeMode>('radius15');
  const [decadeFilter, setDecadeFilter] = useState<string>('all');
  const [wikiTab, setWikiTab] = useState<WikiEntityTab>('read');
  const [editInitialSection, setEditInitialSection] = useState<EntityEditDrawerSection | undefined>(
    undefined
  );

  const place = slug ? placesBySlug.get(slug) : undefined;

  const matchingPlaceIds = useMemo(
    () =>
      bundle && place ? resolveMatchingPlaceIds(bundle, place, scopeMode, placesById) : new Set<string>(),
    [bundle, place, scopeMode, placesById]
  );

  const ancestorIds = useMemo(
    () => (bundle && place ? new Set<string>(bundle.place_ancestors[place.id] || []) : new Set<string>()),
    [bundle, place]
  );

  const occupancyRows = useMemo(
    () =>
      bundle && place
        ? buildPlaceOccupancySummary(bundle, matchingPlaceIds, peopleById)
        : { rows: [], minYear: 1800, maxYear: 2000 },
    [bundle, place, matchingPlaceIds, peopleById]
  );

  const scopeLocalRecords = useMemo(
    () => (bundle && place ? collectPlaceLocalRecords(bundle, matchingPlaceIds) : []),
    [bundle, place, matchingPlaceIds]
  );

  const recordDecades = useMemo(() => collectRecordDecades(scopeLocalRecords), [scopeLocalRecords]);

  const effectiveDecadeFilter =
    decadeFilter !== 'all' && recordDecades.some((d) => String(d) === decadeFilter) ? decadeFilter : 'all';

  const localRecords = useMemo(
    () => filterLocalRecordsByDecade(scopeLocalRecords, effectiveDecadeFilter),
    [scopeLocalRecords, effectiveDecadeFilter]
  );

  if (loading) {
    return (
      <div>
        <ExplorerTopBar />
        <main id="main-content" className={cx(controlStyles, 'place-page')}>
          Loading archive…
        </main>
      </div>
    );
  }
  if (error || !bundle || !place) {
    return (
      <div>
        <ExplorerTopBar />
        <main id="main-content" className={cx(controlStyles, 'place-page')}>
          <h1>{KINLOOM_VOCABULARY.place.notFoundHeading}</h1>
          <p>{formatReaderLoadError(error, 'We could not find that place in the archive.')}</p>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center' }}>
            {error && (
              <button
                type="button"
                className={cx(controlStyles, 'pill-btn')}
                onClick={() => {
                  reloadArchive();
                }}
              >
                Try again
              </button>
            )}
            <Link to="/places" className={cx(controlStyles, 'pill-btn')}>
              {KINLOOM_VOCABULARY.place.returnToPlaces}
            </Link>
          </div>
        </main>
        <KinloomFooter />
      </div>
    );
  }

  const placePhotoSrc = place.photo_url ? resolveAssetUrl(place.photo_url, baseUrl) : '';
  const placePhotoMedia = buildPlacePhotoMedia(place);
  const effectivePronunciation = resolvePlacePronunciation(place, pronunciations);
  const isReadingProfile = wikiTab !== 'history' && wikiTab !== 'talk';

  return (
    <div>
      <ExplorerTopBar />
      <main id="main-content" className={cx(controlStyles, 'place-page')}>
        {occupancyRows.rows.length > 0 && (
          <div
            className={'print-hide'}
            style={{ marginBottom: 14, display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'center' }}
          >
            <Link to={`/time?year=${occupancyRows.minYear}`} className={cx(atomStyles, 'ink-link-btn')}>
              See Family in {occupancyRows.minYear} →
            </Link>
          </div>
        )}

        <section className={cx(controlStyles, 'place-map-box')}>
          <div style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
            <div>
              <h1 className={cx(placeStyles, 'place-dossier-title')}>{place.full_name}</h1>
              {(effectivePronunciation || capabilities.canEdit) && (
                <div className={'place-pronunciation-row'}>
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
                          className={'pronunciation-edit-link print-hide'}
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
                      className={'pronunciation-edit-link print-hide'}
                      onClick={() => {
                        setEditInitialSection('pronunciation');
                        setWikiTab('edit');
                      }}
                    >
                      {KINLOOM_VOCABULARY.person.addPronunciation}
                    </button>
                  )}
                </div>
              )}
            </div>

            <div
              className={cx(controlStyles, 'filter-bar place-scope-bar print-hide')}
              style={{ margin: 0 }}
              role="group"
              aria-label="Map area filter"
            >
              {(
                [
                  ['exact', 'Exact Place'],
                  ['radius15', '15-Mile Radius'],
                  ['county', 'Historical County'],
                ] as const
              ).map(([mode, label]) => (
                <button
                  key={mode}
                  type="button"
                  className={cx(controlStyles, `pill-btn ${scopeMode === mode ? 'active' : ''}`)}
                  onClick={() => {
                    setScopeMode(mode);
                  }}
                >
                  {label}
                </button>
              ))}
              <Link to={`/map?place=${place.slug}`} className={cx(atomStyles, 'ink-link-btn')}>
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

        {isReadingProfile && (
          <>
            <PlaceHistoricalProfileSection
              place={place}
              placePhotoSrc={placePhotoSrc}
              placePhotoMedia={placePhotoMedia}
              sourcesById={sourcesById}
              baseUrl={baseUrl}
            />
            <PlaceOccupancySection occupancyRows={occupancyRows} />
            <PlaceLocalHistorySection
              localRecords={localRecords}
              recordDecades={recordDecades}
              effectiveDecadeFilter={effectiveDecadeFilter}
              sourcesById={sourcesById}
              onSelectDecade={setDecadeFilter}
            />
          </>
        )}
      </main>
      <EntityEditDrawer
        open={wikiTab === 'edit'}
        initialSection={editInitialSection}
        entityType="place"
        entityId={place.id}
        revisionId={bundle.meta.max_revision_id ?? 1}
        initialData={buildPlaceEditInitialData(place)}
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
