import type { ArchiveEvent, CoPresenceItem, MediaItem } from '@kinloom/core';
import {
  buildFilteredGedcom7,
  buildGedcomExportFilename,
  computeRadarForEvent,
  findNearestEventForPerson,
  formatPublicCitation,
  formatPublicProvenance,
  getEventsForPerson,
  getMediaPersonIds,
  orderNarrativeSources,
  partitionPersonNarratives,
} from '@kinloom/core';
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  buildEventQueryUrl,
  pickActiveTimelineEventId,
  shouldRunInitialEventScroll,
} from '../lib/timelineScroll.js';
import { ArchivalMarkdown, formatNarrativeDateSpan } from '../components/ArchivalMarkdown.js';
import { ExplorerTopBar } from '../components/ExplorerTopBar.js';
import { KinloomFooter } from '../components/KinloomFooter.js';
import { MediaPlayer } from '../components/MediaPlayer.js';
import { MilestoneStoryCard } from '../components/MilestoneStoryCard.js';
import { PluginSlot } from '../plugins/PluginContext.js';
import { PronunciationBadge } from '../components/PronunciationBadge.js';
import { resolveAssetUrl } from '../components/Atoms.js';
import { useArchiveData } from '../context/ArchiveDataContext.js';
import { useArchiveUi } from '../context/ArchiveUiContext.js';
import { CitationBadge } from '../components/wiki/WikiBadges.js';
import {
  CreateEntityModal,
  type RelativeCreateContext,
} from '../components/wiki/CreateEntityModal.js';
import { EntityEditDrawer } from '../components/wiki/EntityEditDrawer.js';
import { MediaUploaderModal } from '../components/wiki/MediaUploaderModal.js';
import { RevisionHistoryPanel } from '../components/wiki/RevisionHistoryPanel.js';
import { TalkPanel } from '../components/wiki/TalkPanel.js';
import { WikiActionBar, type WikiEntityTab } from '../components/wiki/WikiActionBar.js';

const MEDIA_KIND_LABELS: Record<string, string> = {
  portrait: 'Portrait',
  family_photo: 'Family Photo',
  headstone: 'Headstone',
  record_scan: 'Primary Record Scan',
  document_scan: 'Document Scan',
  milestone: 'Milestone Photo',
  video_story: 'Video Story',
  audio_oral_history: 'Audio Oral History',
};

type PersonLightboxState =
  | { kind: 'closed' }
  | { kind: 'gallery'; index: number }
  | { kind: 'single'; media: MediaItem };

export const PersonPage: React.FC = () => {
  const { slug } = useParams<{ slug: string }>();
  const location = useLocation();
  const [searchParams] = useSearchParams();
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
  } = useArchiveData();
  const { setActiveYear, pushPivot, openSourceInspector } = useArchiveUi();

  const person = slug ? peopleBySlug.get(slug) : undefined;

  const [activeEventId, setActiveEventId] = useState<string | null>(searchParams.get('event'));
  const [lightbox, setLightbox] = useState<PersonLightboxState>({ kind: 'closed' });
  const [showAllMedia, setShowAllMedia] = useState(false);
  const [showAllNarratives, setShowAllNarratives] = useState(false);
  const [showAllFamilyStories, setShowAllFamilyStories] = useState(false);
  const [expandedNarrativeIds, setExpandedNarrativeIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [expandedSourceNarrativeIds, setExpandedSourceNarrativeIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [wikiTab, setWikiTab] = useState<WikiEntityTab>('read');
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
    setRelativeModal(null);
  }

  const cardRefs = useRef<Map<string, HTMLElement>>(new Map());
  const completedInitialScrollNavKeyRef = useRef<string | null>(null);

  const branchLabelById = useMemo(() => {
    const map = new Map<string, string>();
    for (const branch of siteConfig.branches) {
      map.set(branch.id, branch.label);
    }
    return map;
  }, [siteConfig.branches]);

  const personEvents = useMemo(() => {
    if (!bundle || !person) {
      return [];
    }
    return getEventsForPerson(bundle, person.id);
  }, [bundle, person]);

  const personResidenceSpans = useMemo(() => {
    if (!bundle || !person) {
      return [];
    }
    return bundle.residence_spans
      .filter((span) => span.person_id === person.id)
      .toSorted((a, b) => a.time_min - b.time_min);
  }, [bundle, person]);

  const personMedia: MediaItem[] = useMemo(() => {
    if (!bundle || !person) {
      return [];
    }
    const items = (bundle.media || []).filter((m) => getMediaPersonIds(m).includes(person.id));
    const order: Record<string, number> = {
      portrait: 0,
      family_photo: 1,
      record_scan: 2,
      headstone: 3,
      document_scan: 4,
      milestone: 5,
      video_story: 6,
      audio_oral_history: 7,
    };
    return [...items].toSorted((a, b) => (order[a.kind] ?? 9) - (order[b.kind] ?? 9));
  }, [bundle, person]);

  const { biographies: personBiographies, familyStories } = useMemo(() => {
    if (!bundle || !person) {
      return { biographies: [], familyStories: [] };
    }
    return partitionPersonNarratives(bundle.narratives ?? [], person.id);
  }, [bundle, person]);

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

  const immediateFamily = useMemo(() => {
    if (!bundle || !person) {
      return {
        parents: [] as { id: string; slug: string; name: string; years: string }[],
        spouses: [] as { id: string; slug: string; name: string; years: string }[],
        children: [] as { id: string; slug: string; name: string; years: string }[],
        livingSpouseCount: 0,
        livingChildCount: 0,
      };
    }
    const parentIds = new Set<string>();
    const spouseIds = new Set<string>();
    const childIds = new Set<string>();

    for (const k of bundle.kinship) {
      if (k.relation === 'parent' && k.to === person.id) {
        parentIds.add(k.from);
      } else if (k.relation === 'child' && k.from === person.id) {
        parentIds.add(k.to);
      } else if (k.relation === 'parent' && k.from === person.id) {
        childIds.add(k.to);
      } else if (k.relation === 'child' && k.to === person.id) {
        childIds.add(k.from);
      } else if (k.relation === 'spouse' && k.from === person.id) {
        spouseIds.add(k.to);
      } else if (k.relation === 'spouse' && k.to === person.id) {
        spouseIds.add(k.from);
      }
    }

    const toEntries = (
      ids: Set<string>,
    ): { visible: { id: string; slug: string; name: string; years: string }[]; livingCount: number } => {
      const visible: { id: string; slug: string; name: string; years: string; sortYear: number }[] = [];
      let livingCount = 0;
      for (const id of ids) {
        const rel = peopleById.get(id);
        if (!rel) {
          continue;
        }
        if (rel.is_living || rel.full_name === 'Living') {
          livingCount += 1;
          continue;
        }
        visible.push({
          id: rel.id,
          slug: rel.slug,
          name: rel.full_name,
          years: `${rel.birth_year || '?'}–${rel.death_year || '?'}`,
          sortYear: rel.birth_year ?? 9999,
        });
      }
      visible.sort((a, b) => a.sortYear - b.sortYear || a.name.localeCompare(b.name));
      return {
        visible: visible.map(({ id, slug: entrySlug, name, years }) => ({ id, slug: entrySlug, name, years })),
        livingCount,
      };
    };

    const parents = toEntries(parentIds);
    const spouses = toEntries(spouseIds);
    const children = toEntries(childIds);
    return {
      parents: parents.visible,
      spouses: spouses.visible,
      children: children.visible,
      livingSpouseCount: spouses.livingCount,
      livingChildCount: children.livingCount,
    };
  }, [bundle, person, peopleById]);

  const handleOpenCitationMedia = useCallback(
    (media: MediaItem) => {
      const idx = personMedia.findIndex((item) => item.id === media.id);
      if (idx !== -1) {
        setLightbox({ kind: 'gallery', index: idx });
      } else {
        setLightbox({ kind: 'single', media });
      }
    },
    [personMedia],
  );

  const resolveCitationMediaUrl = useCallback(
    (media: MediaItem): string | null => {
      const resolved = resolveAssetUrl(media.thumb_file || media.file, baseUrl);
      return resolved || null;
    },
    [baseUrl],
  );

  useEffect(() => {
    if (lightbox.kind === 'closed') {
      return undefined;
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        setLightbox({ kind: 'closed' });
      } else if (e.key === 'ArrowRight' && personMedia.length > 0) {
        setLightbox((prev) =>
          prev.kind === 'gallery'
            ? { kind: 'gallery', index: (prev.index + 1) % personMedia.length }
            : prev,
        );
      } else if (e.key === 'ArrowLeft' && personMedia.length > 0) {
        setLightbox((prev) =>
          prev.kind === 'gallery'
            ? {
                kind: 'gallery',
                index: (prev.index - 1 + personMedia.length) % personMedia.length,
              }
            : prev,
        );
      }
    };
    window.addEventListener('keydown', onKey);
    return (): void => {
      window.removeEventListener('keydown', onKey);
    };
  }, [lightbox.kind, personMedia.length]);

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const qEvt = params.get('event');
    if (qEvt && personEvents.some((e) => e.id === qEvt)) {
      setActiveEventId(qEvt);
    } else if (personEvents.length > 0) {
      setActiveEventId(personEvents[0].id);
    } else {
      setActiveEventId(null);
    }
  }, [location.search, personEvents]);

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const qEvt = params.get('event');
    const navKey = `${slug || ''}:${location.key}`;
    const eventIds = personEvents.map((e) => e.id);

    if (
      shouldRunInitialEventScroll({
        navKey,
        completedNavKey: completedInitialScrollNavKeyRef.current,
        targetEventId: qEvt,
        eventIds,
      })
    ) {
      const el = qEvt ? cardRefs.current.get(qEvt) : undefined;
      if (el) {
        completedInitialScrollNavKeyRef.current = navKey;
        el.scrollIntoView({ behavior: 'auto', block: 'start' });
      }
    } else if (personEvents.length > 0 && completedInitialScrollNavKeyRef.current !== navKey) {
      completedInitialScrollNavKeyRef.current = navKey;
    }
  }, [slug, location.key, location.search, personEvents]);

  useEffect(() => {
    if (personEvents.length === 0) {
      return undefined;
    }

    let rafId: number | null = null;

    const syncFromScroll = (): void => {
      rafId = null;
      const metrics: { id: string; top: number; bottom: number }[] = [];
      for (const ev of personEvents) {
        const el = cardRefs.current.get(ev.id);
        if (!el) {
          continue;
        }
        const rect = el.getBoundingClientRect();
        metrics.push({ id: ev.id, top: rect.top, bottom: rect.bottom });
      }
      if (metrics.length === 0) {
        return;
      }

      const viewportHeight = window.innerHeight || 800;
      const isMobile = window.innerWidth < 768;
      const topOffset = isMobile ? 128 : 58;
      const bottomOffset = isMobile ? 52 : 0;
      const usableHeight = Math.max(120, viewportHeight - topOffset - bottomOffset);
      const anchorY = topOffset + usableHeight * 0.28;
      const maxScrollY = Math.max(0, document.documentElement.scrollHeight - viewportHeight);

      const nextId = pickActiveTimelineEventId(metrics, {
        anchorY,
        scrollY: window.scrollY,
        maxScrollY,
      });

      if (nextId) {
        setActiveEventId((prev) => (prev === nextId ? prev : nextId));
      }
    };

    const scheduleSync = (): void => {
      if (rafId !== null) {
        return;
      }
      rafId = window.requestAnimationFrame(syncFromScroll);
    };

    window.addEventListener('scroll', scheduleSync, { passive: true });
    window.addEventListener('resize', scheduleSync, { passive: true });

    return (): void => {
      window.removeEventListener('scroll', scheduleSync);
      window.removeEventListener('resize', scheduleSync);
      if (rafId !== null) {
        window.cancelAnimationFrame(rafId);
      }
    };
  }, [personEvents]);

  const activeEvent: ArchiveEvent | null = useMemo(() => {
    if (!activeEventId) {
      return personEvents[0] || null;
    }
    return personEvents.find((e) => e.id === activeEventId) || personEvents[0] || null;
  }, [activeEventId, personEvents]);

  useEffect(() => {
    if (!activeEvent) {
      setActiveYear(null);
      return;
    }
    setActiveYear(activeEvent.year);
    if (!person || !window.location.pathname.endsWith(`/person/${person.slug}`)) {
      return;
    }
    const nextUrl = buildEventQueryUrl(window.location.href, activeEvent.id);
    if (nextUrl) {
      window.history.replaceState(window.history.state, '', nextUrl);
    }
  }, [activeEvent, person, setActiveYear]);

  useEffect(() => {
    if (person) {
      pushPivot({ slug: person.slug, name: person.full_name, year: activeEvent?.year ?? null });
    }
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- records the visit once per person
  }, [person?.slug]);

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
      const nearest = findNearestEventForPerson(
        bundle,
        item.person.id,
        activeEvent?.time_min ?? null,
      );
      const qs = new URLSearchParams();
      if (nearest) {
        qs.set('event', nearest.id);
      }
      qs.set('from', person.slug);
      void navigate(`/person/${item.person.slug}?${qs.toString()}`);
    },
    [bundle, person, activeEvent, navigate],
  );

  const handleExportPersonGedcom = useCallback(() => {
    if (!bundle || !person) {
      return;
    }
    const gedcomText = buildFilteredGedcom7({
      people: [person],
      bundle,
      placesById,
      sourcesById,
      siteConfig,
      filterDescription: `Individual dossier: ${person.full_name}`,
    });
    const filename = buildGedcomExportFilename({
      familySlug: person.slug,
      lineageFilter: 'all',
      selectedEra: 'all',
      onlyWithMedia: false,
      query: '',
      sortBy: 'featured',
      count: 1,
    });
    const blob = new Blob([gedcomText], { type: 'text/vnd.familysearch.gedcom;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => {
      URL.revokeObjectURL(url);
    }, 1000);
  }, [bundle, person, placesById, sourcesById, siteConfig]);

  const scrubberItems = useMemo(() => {
    const seen = new Set<number>();
    const ticks: { decade: number; eventId: string }[] = [];
    for (const ev of personEvents) {
      if (ev.year === null) {
        continue;
      }
      const dec = Math.floor(ev.year / 10) * 10;
      if (!seen.has(dec)) {
        seen.add(dec);
        ticks.push({ decade: dec, eventId: ev.id });
      }
    }
    return ticks;
  }, [personEvents]);

  if (loading) {
    return (
      <div>
        <ExplorerTopBar />
        <main className="index-page">Loading archive…</main>
      </div>
    );
  }
  if (error || !bundle || !person) {
    return (
      <div>
        <ExplorerTopBar />
        <main className="index-page">
          <h1>Relative Not Found</h1>
          <p>{error || 'We could not find that person in the archive.'}</p>
          <Link to="/" className="pill-btn">
            Return to people
          </Link>
        </main>
        <KinloomFooter />
      </div>
    );
  }

  const routePlaceCount = new Set(
    personEvents.map((ev) => ev.place_id).filter((id): id is string => Boolean(id)),
  ).size;
  const alsoHere = [...radar.coPresenceVisible, ...radar.coPresenceOverflow];
  const branchLabel = person.branch ? (branchLabelById.get(person.branch) ?? person.branch) : null;

  return (
    <div>
      <ExplorerTopBar />

      <div className="explorer-split">
        <main className="narrative-pane">
          <header className="person-header">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 12 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
                {person.portrait_url && (
                  <button
                    type="button"
                    className="person-portrait-btn"
                    onClick={() => {
                      const idx = personMedia.findIndex((m) => m.file === person.portrait_url);
                      setLightbox({ kind: 'gallery', index: idx === -1 ? 0 : idx });
                    }}
                    title="Click to zoom archival portrait"
                  >
                    <img
                      src={resolveAssetUrl(person.portrait_url, baseUrl)}
                      alt={`Archival portrait of ${person.full_name}`}
                      className="person-portrait-img"
                    />
                  </button>
                )}
                <div>
                  <h1>{person.full_name}</h1>
                  {!person.is_living && person.full_name !== 'Living' && person.pronunciation && (
                    <div className="person-pronunciation-row">
                      <PronunciationBadge
                        pronunciation={person.pronunciation}
                        label={person.full_name}
                        baseUrl={baseUrl}
                      />
                    </div>
                  )}
                  <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '4px 8px', fontFamily: 'var(--font-mono)', fontSize: '0.84rem', color: 'var(--text-secondary)' }}>
                    <span>
                      {person.birth_edtf || '?'} — {person.death_edtf || (person.is_living ? 'Living' : '?')}
                    </span>
                    {branchLabel && <span className="person-branch-badge">{branchLabel}</span>}
                    {person.has_primary_source !== undefined && (
                      <CitationBadge hasPrimarySource={person.has_primary_source} />
                    )}
                  </div>
                </div>
              </div>
              <div className="person-header-actions">
                {routePlaceCount > 1 && (
                  <Link to={`/map?person=${person.slug}`} className="ink-link-btn">
                    Their route
                  </Link>
                )}
                <button
                  type="button"
                  className="pill-btn print-hide"
                  onClick={handleExportPersonGedcom}
                  title={`Download family tree file for ${person.full_name}`}
                >
                  Export GEDCOM
                </button>
              </div>
            </div>
            {person.alt_names.length > 0 && (
              <div style={{ fontSize: '0.82rem', color: 'var(--text-secondary)', marginTop: 6 }}>
                Also recorded as: {person.alt_names.join(', ')}
              </div>
            )}
            {(capabilities.canEdit ||
              immediateFamily.parents.length > 0 ||
              immediateFamily.spouses.length > 0 ||
              immediateFamily.children.length > 0 ||
              immediateFamily.livingSpouseCount > 0 ||
              immediateFamily.livingChildCount > 0) && (
              <div className="person-family-strip" aria-label="Immediate family connections">
                {(immediateFamily.parents.length > 0 || capabilities.canEdit) && (
                  <div className="person-family-row">
                    <span className="person-family-label">Parents</span>
                    <div className="person-family-chips">
                      {immediateFamily.parents.map((rel) => (
                        <Link key={rel.id} to={`/person/${rel.slug}`} className="person-family-chip">
                          {rel.name} <span>({rel.years})</span>
                        </Link>
                      ))}
                      {capabilities.canEdit && (
                        <button
                          type="button"
                          className="person-family-add-btn print-hide"
                          onClick={() => {
                            setRelativeModal({
                              anchorPersonId: person.id,
                              anchorPersonName: person.full_name,
                              relation: 'parent',
                            });
                          }}
                        >
                          + Add parent
                        </button>
                      )}
                    </div>
                  </div>
                )}
                {(immediateFamily.spouses.length > 0 ||
                  immediateFamily.livingSpouseCount > 0 ||
                  capabilities.canEdit) && (
                  <div className="person-family-row">
                    <span className="person-family-label">
                      {immediateFamily.spouses.length + immediateFamily.livingSpouseCount > 1 ? 'Spouses' : 'Spouse'}
                    </span>
                    <div className="person-family-chips">
                      {immediateFamily.spouses.map((rel) => (
                        <Link key={rel.id} to={`/person/${rel.slug}`} className="person-family-chip">
                          {rel.name} <span>({rel.years})</span>
                        </Link>
                      ))}
                      {immediateFamily.livingSpouseCount > 0 && (
                        <span className="person-family-chip is-redacted">
                          {immediateFamily.livingSpouseCount} living spouse (redacted)
                        </span>
                      )}
                      {capabilities.canEdit && (
                        <button
                          type="button"
                          className="person-family-add-btn print-hide"
                          onClick={() => {
                            setRelativeModal({
                              anchorPersonId: person.id,
                              anchorPersonName: person.full_name,
                              relation: 'spouse',
                            });
                          }}
                        >
                          + Add spouse
                        </button>
                      )}
                    </div>
                  </div>
                )}
                {(immediateFamily.children.length > 0 ||
                  immediateFamily.livingChildCount > 0 ||
                  capabilities.canEdit) && (
                  <div className="person-family-row">
                    <span className="person-family-label">Children</span>
                    <div className="person-family-chips">
                      {immediateFamily.children.map((rel) => (
                        <Link key={rel.id} to={`/person/${rel.slug}`} className="person-family-chip">
                          {rel.name} <span>({rel.years})</span>
                        </Link>
                      ))}
                      {immediateFamily.livingChildCount > 0 && (
                        <span className="person-family-chip is-redacted">
                          +{immediateFamily.livingChildCount} living {immediateFamily.livingChildCount === 1 ? 'child' : 'children'} (redacted)
                        </span>
                      )}
                      {capabilities.canEdit && (
                        <button
                          type="button"
                          className="person-family-add-btn print-hide"
                          onClick={() => {
                            setRelativeModal({
                              anchorPersonId: person.id,
                              anchorPersonName: person.full_name,
                              relation: 'child',
                            });
                          }}
                        >
                          + Add child
                        </button>
                      )}
                    </div>
                  </div>
                )}
              </div>
            )}

            {personResidenceSpans.length > 0 && (
              <div className="person-family-strip" aria-label="Documented residence spans">
                <div className="person-family-row">
                  <span className="person-family-label">Residences</span>
                  <div className="person-family-chips">
                    {personResidenceSpans.map((span) => {
                      const pl = placesById.get(span.place_id);
                      if (!pl) {
                        return null;
                      }
                      const range =
                        span.start_year && span.end_year
                          ? span.start_year === span.end_year
                            ? String(span.start_year)
                            : `${span.start_year}–${span.end_year}`
                          : 'Undated';
                      return (
                        <Link key={span.id} to={`/place/${pl.slug}`} className="person-family-chip">
                          {pl.name} <span>({range} · {span.confidence_tier})</span>
                        </Link>
                      );
                    })}
                  </div>
                </div>
              </div>
            )}
          </header>

          <WikiActionBar
            activeTab={wikiTab}
            onSelectTab={(nextTab) => {
              setWikiTab(nextTab);
            }}
            onUploadMedia={() => {
              setUploadModalOpen(true);
            }}
            entityLabel={person.full_name}
          />

          <PluginSlot name="personDetail" person={person} />

          {wikiTab === 'history' && (
            <RevisionHistoryPanel entityType="person" entityId={person.id} />
          )}

          {wikiTab === 'talk' && (
            <TalkPanel entityType="person" entityId={person.id} entityTitle={person.full_name} />
          )}

          {wikiTab !== 'history' && wikiTab !== 'talk' && personBiographies.length > 0 && (
            <section className="person-biography-section" aria-label="Biography">
              <div className="person-biography-header">
                <h2>Biography</h2>
                {personBiographies.length > 1 && (
                  <span className="person-biography-count">
                    {personBiographies.length} stories
                  </span>
                )}
              </div>

              <div className="person-biography-list">
                {(showAllNarratives ? personBiographies : personBiographies.slice(0, 1)).map(
                  (narrative) => {
                    const isLong = narrative.body_md.trim().length > 560;
                    const isExpanded = expandedNarrativeIds.has(narrative.id);
                    const sourcesOpen = expandedSourceNarrativeIds.has(narrative.id);
                    const dateLabel = formatNarrativeDateSpan(narrative.date_edtf);
                    const orderedSources = orderNarrativeSources(
                      narrative.body_md,
                      narrative.source_ids ?? [],
                      sourcesById,
                    );

                    return (
                      <article key={narrative.id} className="person-biography-entry">
                        <div className="person-biography-entry-head">
                          <h3>{narrative.title}</h3>
                          {dateLabel && !narrative.title.includes(dateLabel) && (
                            <span className="person-biography-date">{dateLabel}</span>
                          )}
                        </div>

                        {narrative.summary && (
                          <p className="person-biography-summary">{narrative.summary}</p>
                        )}

                        <PluginSlot name="narrativeHeader" person={person} narrative={narrative} />

                        <div
                          className={`person-biography-body ${isLong && !isExpanded ? 'is-collapsed' : ''}`}
                        >
                          <ArchivalMarkdown
                            markdown={narrative.body_md}
                            sourcesById={sourcesById}
                            mediaItems={bundle.media}
                            events={bundle.events}
                            subjectPersonId={person.id}
                            peopleById={peopleById}
                            placesById={placesById}
                            linkedPersonIds={narrative.person_ids}
                            linkedPlaceIds={narrative.place_ids}
                            baseUrl={baseUrl}
                            onInspectSource={(sourceId) => {
                              openSourceInspector({ sourceId });
                            }}
                            onOpenMedia={handleOpenCitationMedia}
                            resolveMediaUrl={resolveCitationMediaUrl}
                          />
                        </div>

                        {(isLong || orderedSources.length > 0) && (
                          <div className="person-biography-actions print-hide">
                            {isLong && (
                              <button
                                type="button"
                                className="ink-inline-btn person-biography-toggle"
                                aria-expanded={isExpanded}
                                onClick={() => {
                                  toggleNarrativeBody(narrative.id);
                                }}
                              >
                                {isExpanded ? 'Show less' : 'Read full biography'}
                              </button>
                            )}

                            {orderedSources.length > 0 && (
                              <button
                                type="button"
                                className="person-biography-sources-toggle"
                                aria-expanded={sourcesOpen}
                                onClick={() => {
                                  toggleNarrativeSources(narrative.id);
                                }}
                              >
                                <span>Sources ({orderedSources.length})</span>
                                <span className="person-biography-chevron" aria-hidden="true">
                                  {sourcesOpen ? '▾' : '▸'}
                                </span>
                              </button>
                            )}
                          </div>
                        )}

                        {sourcesOpen && orderedSources.length > 0 && (
                          <div className="person-biography-sources">
                            <ul className="person-biography-source-list">
                              {orderedSources.map(({ source: src, footnoteNumber }) => (
                                <li key={src.id}>
                                  <button
                                    type="button"
                                    className="person-biography-source-btn"
                                    onClick={() => {
                                      openSourceInspector({ sourceId: src.id });
                                    }}
                                  >
                                    {footnoteNumber !== null && (
                                      <span className="person-biography-source-num">
                                        [{footnoteNumber}]
                                      </span>
                                    )}
                                    <span className="person-biography-source-text">
                                      {formatPublicCitation(src.citation)}
                                    </span>
                                  </button>
                                </li>
                              ))}
                            </ul>
                          </div>
                        )}
                      </article>
                    );
                  },
                )}
              </div>

              {personBiographies.length > 1 && (
                <div className="person-biography-more-wrap print-hide">
                  <button
                    type="button"
                    className="pill-btn"
                    aria-expanded={showAllNarratives}
                    onClick={() => {
                      setShowAllNarratives((v) => !v);
                    }}
                  >
                    {showAllNarratives
                      ? 'Show fewer stories'
                      : `Read ${personBiographies.length - 1} more ${personBiographies.length - 1 === 1 ? 'story' : 'stories'}`}
                  </button>
                </div>
              )}
            </section>
          )}

          {wikiTab !== 'history' && wikiTab !== 'talk' && familyStories.length > 0 && (
            <section
              className="person-biography-section person-family-stories-section"
              aria-label="Family Stories"
            >
              <div className="person-biography-header">
                <h2>Family Stories</h2>
                {familyStories.length > 1 && (
                  <span className="person-biography-count">
                    {familyStories.length} stories
                  </span>
                )}
              </div>

              <div className="person-biography-list">
                {(showAllFamilyStories ? familyStories : familyStories.slice(0, 3)).map((story) => {
                  const isExpanded = expandedNarrativeIds.has(story.id);
                  const sourcesOpen = expandedSourceNarrativeIds.has(story.id);
                  const dateLabel = formatNarrativeDateSpan(story.date_edtf);
                  const orderedSources = orderNarrativeSources(
                    story.body_md,
                    story.source_ids ?? [],
                    sourcesById,
                  );

                  return (
                    <article key={story.id} className="person-biography-entry person-family-story-entry">
                      <div className="person-biography-entry-head">
                        <h3>{story.title}</h3>
                        {dateLabel && !story.title.includes(dateLabel) && (
                          <span className="person-biography-date">{dateLabel}</span>
                        )}
                      </div>

                      {story.summary && (
                        <p className="person-biography-summary">{story.summary}</p>
                      )}

                      <PluginSlot name="narrativeHeader" person={person} narrative={story} />

                      {isExpanded && (
                        <div className="person-biography-body">
                          <ArchivalMarkdown
                            markdown={story.body_md}
                            sourcesById={sourcesById}
                            mediaItems={bundle.media}
                            events={bundle.events}
                            subjectPersonId={person.id}
                            peopleById={peopleById}
                            placesById={placesById}
                            linkedPersonIds={story.person_ids}
                            linkedPlaceIds={story.place_ids}
                            baseUrl={baseUrl}
                            onInspectSource={(sourceId) => {
                              openSourceInspector({ sourceId });
                            }}
                            onOpenMedia={handleOpenCitationMedia}
                            resolveMediaUrl={resolveCitationMediaUrl}
                          />
                        </div>
                      )}

                      <div className="person-biography-actions print-hide">
                        <button
                          type="button"
                          className="ink-inline-btn person-biography-toggle"
                          aria-expanded={isExpanded}
                          onClick={() => {
                            toggleNarrativeBody(story.id);
                          }}
                        >
                          {isExpanded ? 'Hide story' : 'Read story'}
                        </button>

                        {orderedSources.length > 0 && (
                          <button
                            type="button"
                            className="person-biography-sources-toggle"
                            aria-expanded={sourcesOpen}
                            onClick={() => {
                              toggleNarrativeSources(story.id);
                            }}
                          >
                            <span>Sources ({orderedSources.length})</span>
                            <span className="person-biography-chevron" aria-hidden="true">
                              {sourcesOpen ? '▾' : '▸'}
                            </span>
                          </button>
                        )}
                      </div>

                      {sourcesOpen && orderedSources.length > 0 && (
                        <div className="person-biography-sources">
                          <ul className="person-biography-source-list">
                            {orderedSources.map(({ source: src, footnoteNumber }) => (
                              <li key={src.id}>
                                <button
                                  type="button"
                                  className="person-biography-source-btn"
                                  onClick={() => {
                                    openSourceInspector({ sourceId: src.id });
                                  }}
                                >
                                  {footnoteNumber !== null && (
                                    <span className="person-biography-source-num">
                                      [{footnoteNumber}]
                                    </span>
                                  )}
                                  <span className="person-biography-source-text">
                                    {formatPublicCitation(src.citation)}
                                  </span>
                                </button>
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}
                    </article>
                  );
                })}
              </div>

              {familyStories.length > 3 && (
                <div className="person-biography-more-wrap print-hide">
                  <button
                    type="button"
                    className="pill-btn"
                    aria-expanded={showAllFamilyStories}
                    onClick={() => {
                      setShowAllFamilyStories((v) => !v);
                    }}
                  >
                    {showAllFamilyStories
                      ? 'Show fewer family stories'
                      : `Show ${familyStories.length - 3} more family ${familyStories.length - 3 === 1 ? 'story' : 'stories'}`}
                  </button>
                </div>
              )}
            </section>
          )}

          {wikiTab !== 'history' && wikiTab !== 'talk' && personMedia.length > 0 && (
            <section className="person-media-section" aria-label="Archival photos and primary record scans">
              <div className="person-media-header">
                <h2>Photos and scans</h2>
                {personMedia.length > 8 && (
                  <button
                    type="button"
                    className="pill-btn print-hide"
                    onClick={() => {
                      setShowAllMedia((v) => !v);
                    }}
                  >
                    {showAllMedia ? 'Show Fewer' : `Show All ${personMedia.length}`}
                  </button>
                )}
              </div>
              <div className="person-media-grid">
                {(showAllMedia ? personMedia : personMedia.slice(0, 8)).map((item, idx) => (
                  <button
                    key={item.id}
                    type="button"
                    className="person-media-card"
                    onClick={() => {
                      setLightbox({ kind: 'gallery', index: idx });
                    }}
                  >
                    <div className="person-media-thumb-wrap">
                      <MediaPlayer media={item} baseUrl={baseUrl} variant="preview" />
                    </div>
                    <span className="person-media-caption">{item.caption}</span>
                  </button>
                ))}
              </div>
            </section>
          )}

          {wikiTab !== 'history' && wikiTab !== 'talk' && (personEvents.length === 0 ? (
            <div className="story-card">
              <p>No dated events recorded yet for {person.full_name}.</p>
            </div>
          ) : (
            <div className="timeline-layout">
              <nav className="timeline-spine" aria-label="Jump to decade">
                <div className="scrubber-list">
                  {scrubberItems.map((t) => {
                    const isAct =
                      activeEvent?.year !== null &&
                      activeEvent?.year !== undefined &&
                      Math.floor(activeEvent.year / 10) * 10 === t.decade;
                    return (
                      <button
                        key={t.decade}
                        type="button"
                        className={`scrubber-tick ${isAct ? 'active' : ''}`}
                        aria-current={isAct ? 'true' : undefined}
                        onClick={() => {
                          setActiveEventId(t.eventId);
                          cardRefs.current.get(t.eventId)?.scrollIntoView({
                            behavior: 'smooth',
                            block: 'start',
                          });
                        }}
                      >
                        {t.decade}s
                      </button>
                    );
                  })}
                </div>
              </nav>

              <section className="story-stream" aria-label="Biographical timeline">
                {personEvents.map((ev) => (
                  <MilestoneStoryCard
                    key={ev.id}
                    event={ev}
                    place={ev.place_id ? placesById.get(ev.place_id) : undefined}
                    isActive={activeEvent?.id === ev.id}
                    sourcesById={sourcesById}
                    alsoHere={activeEvent?.id === ev.id ? alsoHere : []}
                    onPivotPerson={handlePivotPerson}
                    onSelect={() => {
                      setActiveEventId(ev.id);
                    }}
                    cardRef={(el) => {
                      if (el) {
                        cardRefs.current.set(ev.id, el);
                      } else {
                        cardRefs.current.delete(ev.id);
                      }
                    }}
                  />
                ))}
              </section>
            </div>
          ))}
        </main>
      </div>

      <EntityEditDrawer
        open={wikiTab === 'edit'}
        entityType="person"
        entityId={person.id}
        revisionId={bundle.meta.max_revision_id ?? 1}
        initialData={{
          id: person.id,
          slug: person.slug,
          full_name: person.full_name,
          given_name: person.given_name,
          surname: person.surname,
          alt_names: person.alt_names,
          sex: person.sex,
          is_living: person.is_living,
          lineage_group: person.lineage_group,
          branch: person.branch,
          birth_edtf: person.birth_edtf,
          death_edtf: person.death_edtf,
          portrait_url: person.portrait_url,
          pronunciation: person.pronunciation ?? null,
          has_primary_source: person.has_primary_source,
        }}
        hasPrimarySource={person.has_primary_source ?? true}
        title={person.full_name}
        onClose={() => {
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

      {(() => {
        const activeLightboxMedia =
          lightbox.kind === 'gallery'
            ? (personMedia[lightbox.index] ?? null)
            : lightbox.kind === 'single'
              ? lightbox.media
              : null;
        if (!activeLightboxMedia) {
          return null;
        }
        return (
          <dialog
            open
            className="lightbox-backdrop photo-lightbox-overlay print-hide"
            aria-label="Archival media lightbox"
          >
            <button
              type="button"
              className="lightbox-backdrop-close"
              aria-label="Close lightbox"
              onClick={() => {
                setLightbox({ kind: 'closed' });
              }}
            />
            <div className="scan-lightbox-card">
              <div className="scan-lightbox-header">
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <span
                    className={`media-kind-badge kind-${activeLightboxMedia.kind}`}
                    style={{ position: 'static' }}
                  >
                    {MEDIA_KIND_LABELS[activeLightboxMedia.kind] || activeLightboxMedia.kind}
                  </span>
                  {lightbox.kind === 'gallery' && (
                    <strong style={{ fontFamily: 'var(--font-mono)', fontSize: '0.78rem', color: 'var(--text-inverse)' }}>
                      {lightbox.index + 1} / {personMedia.length}
                    </strong>
                  )}
                </div>
                <div className="media-lightbox-nav">
                  {lightbox.kind === 'gallery' && personMedia.length > 1 && (
                    <>
                      <button
                        type="button"
                        className="pill-btn"
                        onClick={() => {
                          setLightbox({
                            kind: 'gallery',
                            index: (lightbox.index - 1 + personMedia.length) % personMedia.length,
                          });
                        }}
                      >
                        ← Prev
                      </button>
                      <button
                        type="button"
                        className="pill-btn"
                        onClick={() => {
                          setLightbox({
                            kind: 'gallery',
                            index: (lightbox.index + 1) % personMedia.length,
                          });
                        }}
                      >
                        Next →
                      </button>
                    </>
                  )}
                  <button
                    type="button"
                    className="pill-btn"
                    onClick={() => {
                      setLightbox({ kind: 'closed' });
                    }}
                  >
                    Close [Esc]
                  </button>
                </div>
              </div>
              <div className="scan-lightbox-scroll">
                <MediaPlayer media={activeLightboxMedia} baseUrl={baseUrl} variant="full" />
                <div style={{ marginTop: 12, padding: '8px 4px' }}>
                  <div style={{ fontFamily: 'var(--font-serif)', fontSize: '1.05rem', color: 'var(--surface-header)', fontWeight: 600 }}>
                    {activeLightboxMedia.caption}
                  </div>
                  <div style={{ fontFamily: 'var(--font-mono)', fontSize: '0.74rem', color: 'var(--text-secondary)', marginTop: 4 }}>
                    {activeLightboxMedia.date_edtf ? `Date: ${activeLightboxMedia.date_edtf} · ` : ''}
                    {formatPublicProvenance(activeLightboxMedia.provenance)}
                  </div>
                </div>
              </div>
            </div>
          </dialog>
        );
      })()}
      <KinloomFooter />
    </div>
  );
};
