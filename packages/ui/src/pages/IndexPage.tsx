import type { Person, Place } from '@kinloom/core';
import { buildFilteredGedcom7, buildGedcomExportFilename, buildPersonThumbMap } from '@kinloom/core';
import type React from 'react';
import { lazy, Suspense, useId, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ArchivalImage, EmptyStateNotice, PersonPortrait } from '../components/Atoms.js';
import atomStyles from '../components/Atoms.module.css';
import { DirectoryJumpStrip } from '../components/atoms/DirectoryJumpStrip.js';
import { ExplorerTopBar } from '../components/ExplorerTopBar.js';
import { KinloomFooter } from '../components/KinloomFooter.js';
import { OnboardingChecklistCard } from '../components/OnboardingChecklistCard.js';
import wikiChromeStyles from '../components/wiki/WikiChrome.module.css';
import { useArchiveData } from '../context/ArchiveDataContext.js';
import { useOptionalOnboarding } from '../context/OnboardingContext.js';
import { cx, joinClasses } from '../lib/cx.js';
import type { PeopleDirectoryView, ResolvedArchiveFrontispiece } from '../lib/peopleDirectoryModel.js';
import {
  buildDirectoryJumpTargetId,
  buildDirectoryUrlParams,
  buildPeopleDirectoryModel,
  computeVisibleSectionPeople,
  formatLivingLifespan,
  formatPersonDirectoryLifespan,
  parseDirectoryUrlParams,
  resolveArchiveFrontispiece,
} from '../lib/peopleDirectoryModel.js';
import { formatPhotoDocumentCount, formatReaderLoadError } from '../lib/vocabulary.js';
import { PluginSlot } from '../plugins/PluginContext.js';
import controlStyles from '../styles/Controls.module.css';
import layoutStyles from '../styles/Layout.module.css';
import indexStyles from './IndexPage.module.css';

const LazyCreateEntityModal = lazy(async () => {
  const module = await import('../components/wiki/CreateEntityModal.js');
  return { default: module.CreateEntityModal };
});

interface ArchiveFrontispieceProps {
  readonly frontispiece: ResolvedArchiveFrontispiece;
  readonly baseUrl: string;
}

const ArchiveFrontispiece: React.FC<ArchiveFrontispieceProps> = ({ frontispiece, baseUrl }) => (
  <section
    className={joinClasses(
      cx(layoutStyles, 'wire-banner'),
      cx(
        indexStyles,
        frontispiece.isEditorialFrontispiece ? 'index-banner index-frontispiece' : 'index-banner'
      )
    )}
  >
    <div className={cx(indexStyles, 'index-frontispiece-copy')}>
      {frontispiece.kicker && <div className={cx(atomStyles, 'folio-kicker')}>{frontispiece.kicker}</div>}
      <h1>{frontispiece.headline}</h1>
      <p>{frontispiece.intro}</p>
      {frontispiece.metadataLine && (
        <div className={cx(indexStyles, 'index-banner-meta')}>{frontispiece.metadataLine}</div>
      )}
      {frontispiece.featuredLinks.length > 0 && (
        <nav
          aria-label="Featured archive entry points"
          className={cx(indexStyles, 'index-frontispiece-links')}
        >
          {frontispiece.featuredLinks.map((link) => (
            <Link key={`${link.to}:${link.label}`} to={link.to} className={cx(atomStyles, 'ink-link-btn')}>
              {link.label}
            </Link>
          ))}
        </nav>
      )}
    </div>
    {frontispiece.image && (
      <figure className={cx(indexStyles, 'index-frontispiece-figure')}>
        <ArchivalImage
          src={frontispiece.image}
          alt={frontispiece.imageAlt}
          baseUrl={baseUrl}
          loading="eager"
          fetchPriority="high"
          frameClassName={cx(indexStyles, 'index-frontispiece-frame')}
          className={cx(indexStyles, 'index-frontispiece-img')}
          fallbackCaption="Archive frontispiece image unavailable"
        />
        {frontispiece.imageCaption && (
          <figcaption className={cx(indexStyles, 'index-frontispiece-caption')}>
            {frontispiece.imageCaption}
          </figcaption>
        )}
      </figure>
    )}
  </section>
);

interface LivingRelativesSectionProps {
  readonly people: readonly Person[];
  readonly autoCollapse: boolean;
  readonly expanded: boolean;
  readonly onToggleExpanded: () => void;
  readonly placesById: ReadonlyMap<string, Place>;
  readonly personThumbMap: ReadonlyMap<string, string>;
  readonly baseUrl: string;
}

const LivingRelativesSection: React.FC<LivingRelativesSectionProps> = ({
  people,
  autoCollapse,
  expanded,
  onToggleExpanded,
  placesById,
  personThumbMap,
  baseUrl,
}) => {
  const listId = useId();
  const isCollapsed = autoCollapse && !expanded;

  return (
    <section
      id={buildDirectoryJumpTargetId('living')}
      aria-label="Living relatives"
      className={cx(indexStyles, 'index-directory-section index-living-section')}
    >
      <div className={cx(indexStyles, 'index-section-header')}>
        <h2
          className={joinClasses(
            cx(controlStyles, 'section-heading'),
            cx(indexStyles, 'index-section-heading')
          )}
        >
          <span>Living relatives</span>
          <span className={cx(indexStyles, 'section-heading-count')}>{people.length}</span>
        </h2>
      </div>
      {autoCollapse && (
        <div className={cx(indexStyles, 'living-collapse-bar')}>
          <button
            type="button"
            className={joinClasses(cx(controlStyles, 'pill-btn'), cx(indexStyles, 'living-toggle-btn'))}
            aria-expanded={!isCollapsed}
            aria-controls={listId}
            onClick={onToggleExpanded}
          >
            {isCollapsed ? `Show ${people.length} living relatives` : 'Hide living relatives'}
          </button>
        </div>
      )}
      {!isCollapsed && (
        <ul id={listId} className={cx(indexStyles, 'living-row-list')}>
          {people.map((person) => {
            const primaryPlace = person.primary_place_id
              ? placesById.get(person.primary_place_id)
              : undefined;
            const mediaCount = person.media_count || 0;
            const thumbUrl = personThumbMap.get(person.id) || person.portrait_url;
            return (
              <li key={person.id} className={cx(indexStyles, 'living-row-item')}>
                <Link to={`/person/${person.slug}`} className={cx(indexStyles, 'living-row-link')}>
                  <PersonPortrait
                    name={person.full_name}
                    src={thumbUrl}
                    baseUrl={baseUrl}
                    variant="circle"
                    size="sm"
                    loading="lazy"
                  />
                  <span className={cx(indexStyles, 'living-row-main')}>
                    <span className={cx(indexStyles, 'living-row-name')}>{person.full_name}</span>
                    <span className={cx(indexStyles, 'living-row-meta')}>
                      <span>{formatLivingLifespan(person)}</span>
                      {primaryPlace && (
                        <span className={cx(indexStyles, 'living-row-place')}>{primaryPlace.full_name}</span>
                      )}
                      {person.event_count > 0 && (
                        <span className={cx(indexStyles, 'living-row-milestones')}>
                          {person.event_count} milestone{person.event_count === 1 ? '' : 's'}
                        </span>
                      )}
                      {mediaCount > 0 && (
                        <span className={cx(atomStyles, 'person-card-media-badge')}>
                          {formatPhotoDocumentCount(mediaCount)}
                        </span>
                      )}
                    </span>
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
};

export const IndexPage: React.FC = () => {
  const {
    siteConfig,
    baseUrl,
    bundle,
    placesById,
    sourcesById,
    capabilities,
    loading,
    error,
    reloadArchive,
  } = useArchiveData();
  const onboarding = useOptionalOnboarding();
  const [searchParams, setSearchParams] = useSearchParams();
  const [onlyWithPhotos, setOnlyWithPhotos] = useState<boolean>(false);
  const [query, setQuery] = useState<string>('');
  const [exportStatus, setExportStatus] = useState<string>('');
  const [createOpen, setCreateOpen] = useState<boolean>(false);
  const [expandedSectionIds, setExpandedSectionIds] = useState<ReadonlySet<string>>(() => new Set());
  const [livingExpanded, setLivingExpanded] = useState<boolean>(false);

  const personThumbMap = useMemo(() => {
    if (!bundle) {
      return new Map<string, string>();
    }
    return buildPersonThumbMap(bundle);
  }, [bundle]);

  const frontispiece = useMemo(() => resolveArchiveFrontispiece(siteConfig, bundle), [siteConfig, bundle]);

  const rawView: PeopleDirectoryView = searchParams.get('view') === 'az' ? 'az' : 'era';
  const rawBranch = searchParams.get('branch') ?? 'all';

  const model = useMemo(
    () =>
      buildPeopleDirectoryModel({
        bundle,
        siteConfig,
        placesById,
        filter: {
          view: rawView,
          branch: rawBranch,
          onlyWithPhotos,
          query,
        },
      }),
    [bundle, siteConfig, placesById, rawView, rawBranch, onlyWithPhotos, query]
  );

  const { view, branch } = useMemo(
    () => parseDirectoryUrlParams(searchParams, model.populatedBranches),
    [searchParams, model.populatedBranches]
  );

  const activeBranchConfig = useMemo(
    () => (branch !== 'all' ? model.populatedBranches.find((b) => b.id === branch) : undefined),
    [branch, model.populatedBranches]
  );

  const hasActiveQuery = query.trim().length > 0;
  const hasActiveFilters = hasActiveQuery || onlyWithPhotos || branch !== 'all';
  const showBranchSelector = model.populatedBranches.length > 1;
  const hasVisibleResults = model.sections.length > 0 || model.livingPeople.length > 0;

  const handleViewChange = (nextView: PeopleDirectoryView): void => {
    if (nextView === view) {
      return;
    }
    setExpandedSectionIds(new Set());
    setLivingExpanded(false);
    setSearchParams(buildDirectoryUrlParams(searchParams, { view: nextView }), { replace: false });
  };

  const handleBranchChange = (nextBranch: string): void => {
    if (nextBranch === branch) {
      return;
    }
    setExpandedSectionIds(new Set());
    setLivingExpanded(false);
    setSearchParams(buildDirectoryUrlParams(searchParams, { branch: nextBranch }), { replace: false });
  };

  const handleClearFilters = (): void => {
    setQuery('');
    setOnlyWithPhotos(false);
    setExpandedSectionIds(new Set());
    setLivingExpanded(false);
    if (branch !== 'all') {
      setSearchParams(buildDirectoryUrlParams(searchParams, { branch: 'all' }), { replace: false });
    }
  };

  const handleExpandSection = (sectionId: string): void => {
    setExpandedSectionIds((prev) => {
      const next = new Set(prev);
      next.add(sectionId);
      return next;
    });
  };

  const handleExportFilteredGedcom = (): void => {
    if (!bundle || model.filteredPeople.length === 0) {
      return;
    }
    const filterParts: string[] = [
      activeBranchConfig
        ? `${activeBranchConfig.label} Branch`
        : `All ${siteConfig.site.familyName} Relatives`,
    ];
    if (onlyWithPhotos) {
      filterParts.push('With Photos');
    }
    if (query.trim()) {
      filterParts.push(`Search: "${query.trim()}"`);
    }

    const gedcomText = buildFilteredGedcom7({
      people: [...model.filteredPeople],
      bundle,
      placesById,
      sourcesById,
      siteConfig,
      filterDescription: filterParts.join(' · '),
    });
    const filename = buildGedcomExportFilename({
      familySlug: siteConfig.site.familyName,
      lineageFilter: branch,
      selectedEra: 'all',
      onlyWithMedia: onlyWithPhotos,
      query,
      sortBy: view === 'az' ? 'name_asc' : 'birth_asc',
      count: model.filteredPeople.length,
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

    setExportStatus(
      `Exported ${model.filteredPeople.length} relative${model.filteredPeople.length === 1 ? '' : 's'} to ${filename}`
    );
    window.setTimeout(() => {
      setExportStatus('');
    }, 4000);
  };

  return (
    <div>
      <ExplorerTopBar />
      <main id="main-content" className={cx(layoutStyles, 'index-page')}>
        <ArchiveFrontispiece frontispiece={frontispiece} baseUrl={baseUrl} />

        <PluginSlot name="indexHero" />
        <PluginSlot name="indexWidgets" />
        <OnboardingChecklistCard surface="index" />

        {loading && <p>Loading family archive…</p>}
        {error && (
          <div style={{ marginBottom: 18 }}>
            <p>{formatReaderLoadError(error, 'Unable to load archive records right now.')}</p>
            <button
              type="button"
              className={cx(controlStyles, 'pill-btn')}
              onClick={() => {
                reloadArchive();
              }}
            >
              Try again
            </button>
          </div>
        )}

        {bundle && (
          <>
            <div
              className={joinClasses(cx(controlStyles, 'filter-bar'), cx(indexStyles, 'index-filter-bar'))}
            >
              <input
                type="search"
                className={cx(controlStyles, 'search-input')}
                placeholder="Filter people by name or place…"
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                }}
                aria-label={`Filter ${siteConfig.site.familyName} people by name or place`}
              />
              <div
                className={cx(
                  indexStyles,
                  `index-filter-actions${capabilities.canEdit ? ' has-editor-actions' : ''}`
                )}
              >
                <div
                  className={cx(
                    indexStyles,
                    `index-filter-toggles${showBranchSelector ? ' has-branch-select' : ''}`
                  )}
                >
                  <div
                    role="group"
                    aria-label="Directory view"
                    className={cx(indexStyles, 'index-view-segmented')}
                  >
                    <button
                      type="button"
                      className={cx(
                        indexStyles,
                        view === 'era' ? 'index-view-btn is-active' : 'index-view-btn'
                      )}
                      aria-pressed={view === 'era'}
                      onClick={() => {
                        handleViewChange('era');
                      }}
                    >
                      By Era
                    </button>
                    <button
                      type="button"
                      className={cx(
                        indexStyles,
                        view === 'az' ? 'index-view-btn is-active' : 'index-view-btn'
                      )}
                      aria-pressed={view === 'az'}
                      onClick={() => {
                        handleViewChange('az');
                      }}
                    >
                      A–Z
                    </button>
                  </div>

                  {showBranchSelector && (
                    <select
                      aria-label="Filter by family branch"
                      className={joinClasses(
                        cx(controlStyles, 'pill-btn'),
                        cx(indexStyles, 'index-branch-select')
                      )}
                      value={branch}
                      onChange={(e) => {
                        handleBranchChange(e.target.value);
                      }}
                    >
                      <option value="all">All Branches ({model.branchCounts.all})</option>
                      {model.populatedBranches.map((branchOption) => (
                        <option key={branchOption.id} value={branchOption.id}>
                          {branchOption.label} ({model.branchCounts[branchOption.id] || 0})
                        </option>
                      ))}
                    </select>
                  )}

                  <div className={cx(indexStyles, 'index-filter-secondary-row')}>
                    <button
                      type="button"
                      className={cx(
                        controlStyles,
                        `pill-btn index-media-filter-btn ${onlyWithPhotos ? 'active' : ''}`
                      )}
                      aria-pressed={onlyWithPhotos}
                      onClick={() => {
                        setOnlyWithPhotos((v) => !v);
                      }}
                    >
                      With photos ({model.withPhotosCount})
                    </button>

                    {hasActiveFilters && (
                      <button
                        type="button"
                        className={cx(controlStyles, 'pill-btn index-clear-btn')}
                        onClick={handleClearFilters}
                      >
                        Clear
                      </button>
                    )}
                  </div>
                </div>

                {capabilities.canEdit && (
                  <button
                    type="button"
                    className={cx(wikiChromeStyles, 'wiki-btn-secondary wiki-btn-sm index-add-person-btn')}
                    onClick={() => {
                      setCreateOpen(true);
                    }}
                  >
                    + Add Person
                  </button>
                )}
              </div>
            </div>

            {activeBranchConfig && (
              <div className={cx(indexStyles, 'index-branch-context')}>
                <span className={cx(indexStyles, 'index-branch-description')}>
                  {activeBranchConfig.description || `Showing the ${activeBranchConfig.label} branch.`}
                </span>
                <Link
                  to={`/tree?branch=${encodeURIComponent(activeBranchConfig.id)}`}
                  className={cx(atomStyles, 'ink-link-btn')}
                >
                  View branch in Family Tree →
                </Link>
              </div>
            )}

            {!hasVisibleResults ? (
              bundle.people.length === 0 ? (
                <EmptyStateNotice
                  eyebrow={capabilities.canEdit ? 'Archive Setup' : 'Archive Preview'}
                  title={
                    capabilities.canEdit ? 'Start your family archive' : 'This archive is being prepared'
                  }
                  body="No people have been added to this archive yet. People cards link biographies, places, primary citations, and archival scans."
                  action={
                    capabilities.canEdit ? (
                      <button
                        type="button"
                        className={cx(wikiChromeStyles, 'wiki-btn-secondary wiki-btn-sm')}
                        onClick={() => {
                          setCreateOpen(true);
                        }}
                      >
                        + Add first person
                      </button>
                    ) : onboarding ? (
                      <button
                        type="button"
                        className={cx(controlStyles, 'pill-btn')}
                        onClick={() => {
                          onboarding.openGuide('core-navigation-search');
                        }}
                      >
                        Open Archive Guide
                      </button>
                    ) : undefined
                  }
                  secondaryAction={
                    capabilities.canManageSite ? (
                      <Link to="/admin" className={cx(controlStyles, 'pill-btn')}>
                        Open Admin setup
                      </Link>
                    ) : capabilities.canEdit && onboarding ? (
                      <button
                        type="button"
                        className={cx(controlStyles, 'pill-btn')}
                        onClick={() => {
                          onboarding.openGuide('core-navigation-search');
                        }}
                      >
                        Open Archive Guide
                      </button>
                    ) : undefined
                  }
                />
              ) : (
                <EmptyStateNotice
                  title="No people match the active filters."
                  body={
                    hasActiveQuery && onlyWithPhotos
                      ? `No relatives with photos matched "${query.trim()}".`
                      : hasActiveQuery
                        ? `No relatives matched "${query.trim()}".`
                        : onlyWithPhotos
                          ? 'No relatives in this selection have attached photos yet.'
                          : 'Try clearing the active branch filter to view all relatives.'
                  }
                  action={
                    hasActiveFilters ? (
                      <button
                        type="button"
                        className={cx(controlStyles, 'pill-btn')}
                        onClick={handleClearFilters}
                      >
                        Clear filters
                      </button>
                    ) : undefined
                  }
                />
              )
            ) : (
              <div className={cx(indexStyles, 'index-directory-shell')}>
                {model.showJumpStrip && (
                  <DirectoryJumpStrip
                    ariaLabel={view === 'era' ? 'Jump to era' : 'Jump to surname letter'}
                    compact={view === 'az'}
                    showCounts={view === 'era'}
                    items={model.jumpItems.map((item) => ({
                      id: item.id,
                      label: item.label,
                      count: item.count,
                      title: `${item.label} (${item.count})`,
                      ...(item.isLiving
                        ? {
                            onSelect: () => {
                              setLivingExpanded(true);
                            },
                          }
                        : {}),
                    }))}
                  />
                )}

                {model.sections.map((section, idx) => {
                  const { visible, hiddenCount } = computeVisibleSectionPeople({
                    people: section.people,
                    isExpanded: expandedSectionIds.has(section.id),
                    hasActiveQuery,
                  });

                  return (
                    <section
                      key={section.id}
                      id={buildDirectoryJumpTargetId(section.id)}
                      aria-label={section.heading}
                      className={cx(indexStyles, 'index-directory-section')}
                    >
                      <div className={cx(indexStyles, `index-section-header${idx === 0 ? ' is-first' : ''}`)}>
                        <h2
                          className={joinClasses(
                            cx(controlStyles, 'section-heading'),
                            cx(indexStyles, 'index-section-heading'),
                            idx === 0 ? 'is-first' : ''
                          )}
                        >
                          <span>{section.heading}</span>
                          <span className={cx(indexStyles, 'index-section-heading-meta')}>
                            {section.kind === 'historical' && section.snapshotYear !== null && (
                              <>
                                <Link
                                  to={`/time?year=${section.snapshotYear}`}
                                  className={cx(indexStyles, 'index-era-snapshot-link')}
                                >
                                  See {section.snapshotYear} snapshot →
                                </Link>
                                <span
                                  className={cx(indexStyles, 'index-section-meta-sep')}
                                  aria-hidden="true"
                                >
                                  ·
                                </span>
                              </>
                            )}
                            <span className={cx(indexStyles, 'section-heading-count')}>
                              {section.people.length}
                            </span>
                          </span>
                        </h2>
                        {section.kind === 'historical' && section.subtitle && (
                          <p className={cx(indexStyles, 'index-section-subtitle')}>{section.subtitle}</p>
                        )}
                      </div>

                      <div className={cx(indexStyles, 'person-grid')}>
                        {visible.map((p, personIdx) => {
                          const primaryPlace = p.primary_place_id
                            ? placesById.get(p.primary_place_id)
                            : undefined;
                          const mediaCount = p.media_count || 0;
                          const thumbUrl = personThumbMap.get(p.id) || p.portrait_url;
                          const eagerPortrait = idx === 0 && personIdx < 6;
                          const suppressSparseLivingMeta = p.is_living;
                          const showPlaceLine = !suppressSparseLivingMeta || Boolean(primaryPlace);
                          const showMilestones = !suppressSparseLivingMeta || p.event_count > 0;

                          return (
                            <Link
                              key={p.id}
                              to={`/person/${p.slug}`}
                              className={cx(indexStyles, 'person-card')}
                            >
                              <PersonPortrait
                                name={p.full_name}
                                src={thumbUrl}
                                baseUrl={baseUrl}
                                variant="print"
                                size="card"
                                loading={eagerPortrait ? 'eager' : 'lazy'}
                                className={cx(indexStyles, 'person-card-portrait')}
                              />
                              <div className={cx(indexStyles, 'person-card-body')}>
                                <h3>{p.full_name}</h3>
                                <div className={cx(indexStyles, 'person-card-meta')}>
                                  {formatPersonDirectoryLifespan(p)}
                                </div>
                                {showPlaceLine && (
                                  <div className={cx(indexStyles, 'person-card-place')}>
                                    {primaryPlace ? primaryPlace.full_name : 'Location unrecorded'}
                                  </div>
                                )}
                                {(showMilestones || mediaCount > 0) && (
                                  <div className={cx(indexStyles, 'person-card-stats')}>
                                    {showMilestones && (
                                      <span className={cx(indexStyles, 'person-card-milestones')}>
                                        {p.event_count} milestone{p.event_count === 1 ? '' : 's'}
                                      </span>
                                    )}
                                    {mediaCount > 0 && (
                                      <span className={cx(atomStyles, 'person-card-media-badge')}>
                                        {formatPhotoDocumentCount(mediaCount)}
                                      </span>
                                    )}
                                  </div>
                                )}
                              </div>
                            </Link>
                          );
                        })}
                      </div>

                      {hiddenCount > 0 && (
                        <div className={cx(indexStyles, 'index-section-expand-row')}>
                          <button
                            type="button"
                            className={joinClasses(
                              cx(controlStyles, 'pill-btn'),
                              cx(indexStyles, 'index-section-expand-btn')
                            )}
                            onClick={() => {
                              handleExpandSection(section.id);
                            }}
                          >
                            Show all {section.people.length}
                          </button>
                        </div>
                      )}
                    </section>
                  );
                })}

                {view === 'era' && model.livingPeople.length > 0 && (
                  <LivingRelativesSection
                    people={model.livingPeople}
                    autoCollapse={model.autoCollapseLiving}
                    expanded={livingExpanded}
                    onToggleExpanded={() => {
                      setLivingExpanded((v) => !v);
                    }}
                    placesById={placesById}
                    personThumbMap={personThumbMap}
                    baseUrl={baseUrl}
                  />
                )}
              </div>
            )}

            <div className={cx(indexStyles, 'index-archive-utility-bar')}>
              <span className={cx(indexStyles, 'index-archive-utility-summary')}>
                Showing {model.filteredPeople.length} of {model.publicPeople.length}{' '}
                {model.publicPeople.length === 1 ? 'person' : 'people'}
              </span>
              <button
                type="button"
                className={joinClasses(cx(atomStyles, 'ink-link-btn'), cx(indexStyles, 'index-export-link'))}
                disabled={model.filteredPeople.length === 0}
                onClick={handleExportFilteredGedcom}
                title="Download a family tree file of the relatives currently shown"
              >
                Export GEDCOM ({model.filteredPeople.length})
              </button>
            </div>
            {exportStatus && (
              <output aria-live="polite" className={cx(indexStyles, 'index-export-status')}>
                {exportStatus}
              </output>
            )}
          </>
        )}
      </main>
      {capabilities.canEdit && createOpen && (
        <Suspense fallback={null}>
          <LazyCreateEntityModal
            open={createOpen}
            onClose={() => {
              setCreateOpen(false);
            }}
          />
        </Suspense>
      )}
      <KinloomFooter />
    </div>
  );
};
