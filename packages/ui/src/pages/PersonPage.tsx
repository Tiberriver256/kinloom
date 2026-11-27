import type { CoPresenceItem, MediaItem } from '@kinloom/core';
import {
  computeRadarForEvent,
  findNearestEventForPerson,
  getEventsForPerson,
  partitionPersonNarratives,
} from '@kinloom/core';
import type React from 'react';
import { useCallback, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { resolveAssetUrl } from '../components/Atoms.js';
import cssMod0 from '../components/Atoms.module.css';
import { ExplorerTopBar } from '../components/ExplorerTopBar.js';
import { KinloomFooter } from '../components/KinloomFooter.js';
import cssMod1 from '../components/SourceReaderDrawer.module.css';
import { CreateEntityModal, type RelativeCreateContext } from '../components/wiki/CreateEntityModal.js';
import { EntityEditDrawer, type EntityEditDrawerSection } from '../components/wiki/EntityEditDrawer.js';
import { MediaUploaderModal } from '../components/wiki/MediaUploaderModal.js';
import { RevisionHistoryPanel } from '../components/wiki/RevisionHistoryPanel.js';
import { TalkPanel } from '../components/wiki/TalkPanel.js';
import { WikiActionBar, type WikiEntityTab } from '../components/wiki/WikiActionBar.js';
import { useArchiveData } from '../context/ArchiveDataContext.js';
import { useArchiveUi } from '../context/ArchiveUiContext.js';
import { cx } from '../lib/cx.js';
import { formatReaderLoadError, KINLOOM_VOCABULARY } from '../lib/vocabulary.js';
import { PluginSlot } from '../plugins/PluginContext.js';
import cssMod3 from './IndexPage.module.css';
import cssMod4 from './NotFoundPage.module.css';
import cssMod5 from './PersonPage.module.css';
import { PersonLifeTimelineSection } from './person/PersonLifeTimelineSection.js';
import { PersonMediaLightbox, PersonMediaSection } from './person/PersonMediaSection.js';
import { PersonNarrativesSection } from './person/PersonNarrativesSection.js';
import { PersonProfileHeader } from './person/PersonProfileHeader.js';
import {
  buildImmediateFamily,
  buildPersonEditInitialData,
  buildPersonSectionJumpItems,
  buildTimelineScrubberTicks,
  collectPersonMedia,
  collectPersonResidenceSpans,
  countUniqueEventPlaces,
  type PersonLightboxState,
  resolvePortraitLightboxState,
  triggerPersonGedcomDownload,
} from './person/personViewModel.js';
import { usePersonTimelineSync } from './person/usePersonTimelineSync.js';

const uiStyles: Readonly<Record<string, string>> = {
  ...cssMod0,
  ...cssMod1,
  ...cssMod3,
  ...cssMod4,
  ...cssMod5,
};

export const PersonPage: React.FC = () => {
  const { slug } = useParams<{ slug: string }>();
  const navigate = useNavigate();

  const {
    siteConfig,
    baseUrl,
    bundle,
    capabilities,
    loading,
    error,
    peopleById,
    peopleBySlug,
    placesById,
    sourcesById,
    pronunciations,
    reloadArchive,
  } = useArchiveData();
  const { openSourceInspector } = useArchiveUi();

  const person = slug ? peopleBySlug.get(slug) : undefined;

  const [lightbox, setLightbox] = useState<PersonLightboxState>({ kind: 'closed' });
  const [showAllMedia, setShowAllMedia] = useState(false);
  const [showAllNarratives, setShowAllNarratives] = useState(false);
  const [showAllFamilyStories, setShowAllFamilyStories] = useState(false);
  const [expandedNarrativeIds, setExpandedNarrativeIds] = useState<ReadonlySet<string>>(() => new Set());
  const [expandedSourceNarrativeIds, setExpandedSourceNarrativeIds] = useState<ReadonlySet<string>>(
    () => new Set()
  );
  const [wikiTab, setWikiTab] = useState<WikiEntityTab>('read');
  const [editInitialSection, setEditInitialSection] = useState<EntityEditDrawerSection | undefined>(
    undefined
  );
  const [uploadModalOpen, setUploadModalOpen] = useState(false);
  const [relativeModal, setRelativeModal] = useState<RelativeCreateContext | null>(null);

  const [prevSlug, setPrevSlug] = useState(slug);
  if (slug !== prevSlug) {
    setPrevSlug(slug);
    setLightbox({ kind: 'closed' });
    setShowAllMedia(false);
    setShowAllNarratives(false);
    setShowAllFamilyStories(false);
    setExpandedNarrativeIds(new Set());
    setExpandedSourceNarrativeIds(new Set());
    setWikiTab('read');
    setEditInitialSection(undefined);
    setRelativeModal(null);
  }

  const branchLabelById = useMemo(
    () => new Map(siteConfig.branches.map((branch) => [branch.id, branch.label])),
    [siteConfig.branches]
  );

  const personEvents = useMemo(
    () => (bundle && person ? getEventsForPerson(bundle, person.id) : []),
    [bundle, person]
  );

  const personResidenceSpans = useMemo(
    () => (bundle && person ? collectPersonResidenceSpans(bundle, person.id) : []),
    [bundle, person]
  );

  const personMedia = useMemo(
    () => (bundle && person ? collectPersonMedia(bundle, person.id) : []),
    [bundle, person]
  );

  const { biographies: personBiographies, familyStories } = useMemo(
    () =>
      bundle && person
        ? partitionPersonNarratives(bundle.narratives ?? [], person.id)
        : { biographies: [], familyStories: [] },
    [bundle, person]
  );

  const immediateFamily = useMemo(
    () =>
      bundle && person
        ? buildImmediateFamily(bundle, person.id, peopleById)
        : { parents: [], spouses: [], children: [], livingSpouseCount: 0, livingChildCount: 0 },
    [bundle, person, peopleById]
  );

  const { activeEvent, setActiveEventId, cardRefs } = usePersonTimelineSync(slug, person, personEvents);

  const toggleNarrativeBody = useCallback((narrativeId: string) => {
    setExpandedNarrativeIds((prev) => {
      const next = new Set(prev);
      if (next.has(narrativeId)) {
        next.delete(narrativeId);
      } else {
        next.add(narrativeId);
      }
      return next;
    });
  }, []);

  const toggleNarrativeSources = useCallback((narrativeId: string) => {
    setExpandedSourceNarrativeIds((prev) => {
      const next = new Set(prev);
      if (next.has(narrativeId)) {
        next.delete(narrativeId);
      } else {
        next.add(narrativeId);
      }
      return next;
    });
  }, []);

  const handleOpenCitationMedia = useCallback(
    (media: MediaItem) => {
      const idx = personMedia.findIndex((item) => item.id === media.id);
      setLightbox(idx !== -1 ? { kind: 'gallery', index: idx } : { kind: 'single', media });
    },
    [personMedia]
  );

  const resolveCitationMediaUrl = useCallback(
    (media: MediaItem): string | null => resolveAssetUrl(media.thumb_file || media.file, baseUrl) || null,
    [baseUrl]
  );

  const radar = useMemo(() => {
    if (!bundle || !person) {
      return {
        coPresenceVisible: [],
        coPresenceOverflow: [],
        localVisible: [],
        localOverflow: [],
        macroVisible: [],
        macroOverflow: [],
      };
    }
    return computeRadarForEvent(bundle, activeEvent, person.id, peopleById, placesById);
  }, [bundle, activeEvent, person, peopleById, placesById]);

  const handlePivotPerson = useCallback(
    (item: CoPresenceItem) => {
      if (!bundle || !person) {
        return;
      }
      const nearest = findNearestEventForPerson(bundle, item.person.id, activeEvent?.time_min ?? null);
      const qs = new URLSearchParams();
      if (nearest) {
        qs.set('event', nearest.id);
      }
      qs.set('from', person.slug);
      void navigate(`/person/${item.person.slug}?${qs.toString()}`);
    },
    [bundle, person, activeEvent, navigate]
  );

  const handleExportPersonGedcom = useCallback(() => {
    if (!bundle || !person) {
      return;
    }
    triggerPersonGedcomDownload({ person, bundle, placesById, sourcesById, siteConfig });
  }, [bundle, person, placesById, sourcesById, siteConfig]);

  const scrubberItems = useMemo(() => buildTimelineScrubberTicks(personEvents), [personEvents]);

  if (loading) {
    return (
      <div>
        <ExplorerTopBar />
        <main id="main-content" className={cx(uiStyles, 'index-page')}>
          Loading archive…
        </main>
      </div>
    );
  }

  if (error || !bundle || !person) {
    return (
      <div>
        <ExplorerTopBar />
        <main id="main-content" className={cx(uiStyles, 'index-page')}>
          <h1>{KINLOOM_VOCABULARY.person.notFoundHeading}</h1>
          <p>{formatReaderLoadError(error, 'We could not find that person in the archive.')}</p>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center' }}>
            {error && (
              <button
                type="button"
                className={cx(uiStyles, 'pill-btn')}
                onClick={() => {
                  reloadArchive();
                }}
              >
                Try again
              </button>
            )}
            <Link to="/" className={cx(uiStyles, 'pill-btn')}>
              {KINLOOM_VOCABULARY.person.returnToPeople}
            </Link>
          </div>
        </main>
        <KinloomFooter />
      </div>
    );
  }

  const routePlaceCount = countUniqueEventPlaces(personEvents);
  const alsoHere = [...radar.coPresenceVisible, ...radar.coPresenceOverflow];
  const branchLabel = person.branch ? (branchLabelById.get(person.branch) ?? person.branch) : null;
  const isReadingView = wikiTab !== 'history' && wikiTab !== 'talk';
  const sectionJumpItems = buildPersonSectionJumpItems({
    biographyCount: personBiographies.length,
    familyStoryCount: familyStories.length,
    mediaCount: personMedia.length,
    eventCount: personEvents.length,
  });

  return (
    <div>
      <ExplorerTopBar />

      <div className={cx(uiStyles, 'explorer-split')}>
        <main id="main-content" className={cx(uiStyles, 'narrative-pane')}>
          <PersonProfileHeader
            person={person}
            baseUrl={baseUrl}
            branchLabel={branchLabel}
            routePlaceCount={routePlaceCount}
            canEdit={capabilities.canEdit}
            pronunciations={pronunciations}
            immediateFamily={immediateFamily}
            residenceSpans={personResidenceSpans}
            placesById={placesById}
            uiStyles={uiStyles}
            onOpenPortraitLightbox={() => {
              const next = resolvePortraitLightboxState(person, personMedia);
              if (next) {
                setLightbox(next);
              }
            }}
            onEditPronunciation={() => {
              setEditInitialSection('pronunciation');
              setWikiTab('edit');
            }}
            onExportGedcom={handleExportPersonGedcom}
            onOpenRelativeModal={setRelativeModal}
          />

          <WikiActionBar
            activeTab={wikiTab}
            onSelectTab={(nextTab) => {
              if (nextTab === 'edit') {
                setEditInitialSection(undefined);
              }
              setWikiTab(nextTab);
            }}
            onUploadMedia={() => {
              setUploadModalOpen(true);
            }}
            entityLabel={person.full_name}
          />

          <PluginSlot name="personDetail" person={person} />

          {wikiTab === 'history' && <RevisionHistoryPanel entityType="person" entityId={person.id} />}

          {wikiTab === 'talk' && (
            <TalkPanel entityType="person" entityId={person.id} entityTitle={person.full_name} />
          )}

          {isReadingView && sectionJumpItems.length >= 2 && (
            <nav
              className={cx(uiStyles, 'person-section-jump-bar print-hide')}
              aria-label="Jump to profile section"
            >
              {sectionJumpItems.map((item) => (
                <a key={item.id} href={`#${item.id}`} className={cx(uiStyles, 'person-section-jump-link')}>
                  {item.label}
                </a>
              ))}
            </nav>
          )}

          {isReadingView && (
            <>
              <PersonNarrativesSection
                variant="biography"
                sectionId="person-biography"
                heading={KINLOOM_VOCABULARY.person.biographyHeading}
                narratives={personBiographies}
                showAll={showAllNarratives}
                onToggleShowAll={() => {
                  setShowAllNarratives((v) => !v);
                }}
                expandedNarrativeIds={expandedNarrativeIds}
                expandedSourceNarrativeIds={expandedSourceNarrativeIds}
                onToggleNarrativeBody={toggleNarrativeBody}
                onToggleNarrativeSources={toggleNarrativeSources}
                person={person}
                bundle={bundle}
                peopleById={peopleById}
                placesById={placesById}
                sourcesById={sourcesById}
                baseUrl={baseUrl}
                uiStyles={uiStyles}
                onInspectSource={(sourceId) => {
                  openSourceInspector({ sourceId });
                }}
                onOpenMedia={handleOpenCitationMedia}
                resolveMediaUrl={resolveCitationMediaUrl}
              />

              <PersonNarrativesSection
                variant="familyStories"
                sectionId="person-family-stories"
                heading="Family Stories"
                narratives={familyStories}
                showAll={showAllFamilyStories}
                onToggleShowAll={() => {
                  setShowAllFamilyStories((v) => !v);
                }}
                expandedNarrativeIds={expandedNarrativeIds}
                expandedSourceNarrativeIds={expandedSourceNarrativeIds}
                onToggleNarrativeBody={toggleNarrativeBody}
                onToggleNarrativeSources={toggleNarrativeSources}
                person={person}
                bundle={bundle}
                peopleById={peopleById}
                placesById={placesById}
                sourcesById={sourcesById}
                baseUrl={baseUrl}
                uiStyles={uiStyles}
                onInspectSource={(sourceId) => {
                  openSourceInspector({ sourceId });
                }}
                onOpenMedia={handleOpenCitationMedia}
                resolveMediaUrl={resolveCitationMediaUrl}
              />

              <PersonMediaSection
                personMedia={personMedia}
                baseUrl={baseUrl}
                showAllMedia={showAllMedia}
                uiStyles={uiStyles}
                onToggleShowAll={() => {
                  setShowAllMedia((v) => !v);
                }}
                onOpenGalleryIndex={(index) => {
                  setLightbox({ kind: 'gallery', index });
                }}
              />

              <PersonLifeTimelineSection
                person={person}
                personEvents={personEvents}
                activeEvent={activeEvent}
                scrubberItems={scrubberItems}
                placesById={placesById}
                sourcesById={sourcesById}
                alsoHere={alsoHere}
                canEdit={capabilities.canEdit}
                cardRefs={cardRefs}
                uiStyles={uiStyles}
                onSelectEventId={setActiveEventId}
                onPivotPerson={handlePivotPerson}
                onOpenEdit={() => {
                  setEditInitialSection(undefined);
                  setWikiTab('edit');
                }}
              />
            </>
          )}
        </main>
      </div>

      <EntityEditDrawer
        open={wikiTab === 'edit'}
        initialSection={editInitialSection}
        entityType="person"
        entityId={person.id}
        revisionId={bundle.meta.max_revision_id ?? 1}
        initialData={buildPersonEditInitialData(person)}
        hasPrimarySource={person.has_primary_source ?? true}
        title={person.full_name}
        onClose={() => {
          setEditInitialSection(undefined);
          setWikiTab('read');
        }}
      />

      <MediaUploaderModal
        open={uploadModalOpen}
        defaultPersonId={person.id}
        onClose={() => {
          setUploadModalOpen(false);
        }}
      />

      <CreateEntityModal
        open={relativeModal !== null}
        relativeContext={relativeModal ?? undefined}
        onClose={() => {
          setRelativeModal(null);
        }}
      />

      <PersonMediaLightbox
        lightbox={lightbox}
        personMedia={personMedia}
        baseUrl={baseUrl}
        uiStyles={uiStyles}
        onSetLightbox={setLightbox}
      />
      <KinloomFooter />
    </div>
  );
};
