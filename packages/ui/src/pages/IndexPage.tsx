import type { Person, Place } from '@kinloom/core';
import { buildFilteredGedcom7, buildGedcomExportFilename, buildPersonThumbMap } from '@kinloom/core';
import type React from 'react';
import { lazy, Suspense, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ArchivalImage, EmptyStateNotice, PersonPortrait } from '../components/Atoms.js';
import atomStyles from '../components/Atoms.module.css';
import { DirectoryJumpStrip } from '../components/atoms/DirectoryJumpStrip.js';
import { ExplorerTopBar } from '../components/ExplorerTopBar.js';
import { KinloomFooter } from '../components/KinloomFooter.js';
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
import { formatEventCount, formatPhotoDocumentCount, formatReaderLoadError } from '../lib/vocabulary.js';
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
  readonly canEdit: boolean;
  readonly onAddPerson: () => void;
}

const ArchiveFrontispiece: React.FC<ArchiveFrontispieceProps> = ({
  frontispiece,
  baseUrl,
  canEdit,
  onAddPerson,
}) => {
  const aboutId = useId();
  const [aboutOpen, setAboutOpen] = useState(false);
  const hasCollapsibleAbout =
    frontispiece.intro.length > 0 || frontispiece.featuredLinks.length > 0 || Boolean(frontispiece.image);

  return (
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
        <div className={cx(indexStyles, 'index-banner-head')}>
          <div className={cx(indexStyles, 'index-banner-title-block')}>
            {frontispiece.kicker && (
              <div className={cx(atomStyles, 'folio-kicker')}>{frontispiece.kicker}</div>
            )}
            <h1>{frontispiece.headline}</h1>
          </div>
          {canEdit && (
            <button type="button" className={cx(indexStyles, 'index-add-person-btn')} onClick={onAddPerson}>
              + Add Person
            </button>
          )}
        </div>

        {(frontispiece.metadataLine || hasCollapsibleAbout) && (
          <div className={cx(indexStyles, 'index-banner-meta-row')}>
            {frontispiece.metadataLine && (
              <div className={cx(indexStyles, 'index-banner-meta')}>{frontispiece.metadataLine}</div>
            )}
            {hasCollapsibleAbout && (
              <button
                type="button"
                className={cx(indexStyles, 'index-about-toggle')}
                aria-expanded={aboutOpen}
                aria-controls={aboutId}
                onClick={() => {
                  setAboutOpen((open) => !open);
                }}
              >
                {aboutOpen ? 'Hide info' : 'About this archive'}
              </button>
            )}
          </div>
        )}

        <div id={aboutId} className={cx(indexStyles, `index-banner-about${aboutOpen ? ' is-open' : ''}`)}>
          <p>{frontispiece.intro}</p>
          {frontispiece.featuredLinks.length > 0 && (
            <nav
              aria-label="Featured archive entry points"
              className={cx(indexStyles, 'index-frontispiece-links')}
            >
              {frontispiece.featuredLinks.map((link) => (
                <Link
                  key={`${link.to}:${link.label}`}
                  to={link.to}
                  className={cx(atomStyles, 'ink-link-btn')}
                >
                  {link.label}
                </Link>
              ))}
            </nav>
          )}
        </div>
      </div>

      {frontispiece.image && (
        <figure className={cx(indexStyles, `index-frontispiece-figure${aboutOpen ? ' is-about-open' : ''}`)}>
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
};

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
          <span className={cx(indexStyles, 'index-section-heading-title')}>
            <span>Living relatives</span>
            <span className={cx(indexStyles, 'section-heading-count')}>({people.length})</span>
          </span>
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
                          {formatEventCount(person.event_count)}
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
  const [mobileFiltersOpen, setMobileFiltersOpen] = useState<boolean>(false);
  const [expandedSectionIds, setExpandedSectionIds] = useState<ReadonlySet<string>>(() => new Set());
  const [livingExpanded, setLivingExpanded] = useState<boolean>(false);

  const filtersPanelId = useId();
  const filterShellRef = useRef<HTMLDivElement | null>(null);
  const filtersTriggerRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!mobileFiltersOpen) {
      return undefined;
    }
    const onPointerDown = (e: MouseEvent): void => {
      if (filterShellRef.current && e.target instanceof Node && !filterShellRef.current.contains(e.target)) {
        setMobileFiltersOpen(false);
      }
    };
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        setMobileFiltersOpen(false);
        filtersTriggerRef.current?.focus();
      }
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return (): void => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [mobileFiltersOpen]);

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
  const hasActiveFilters = model.activeFilterCount > 0;
  const showBranchSelector = model.populatedBranches.length > 1;
  const hasVisibleResults = model.sections.length > 0 || model.livingPeople.length > 0;

  const handleViewChange = (nextView: PeopleDirectoryView): void => {
    setMobileFiltersOpen(false);
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
    setMobileFiltersOpen(false);
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
        <ArchiveFrontispiece
          frontispiece={frontispiece}
          baseUrl={baseUrl}
          canEdit={capabilities.canEdit}
          onAddPerson={() => {
            setCreateOpen(true);
          }}
        />

        <PluginSlot name="indexHero" />
        <PluginSlot name="indexWidgets" />

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
              ref={filterShellRef}
              className={joinClasses(
                cx(controlStyles, 'filter-bar'),
                cx(indexStyles, `index-filter-bar${mobileFiltersOpen ? ' is-filters-open' : ''}`)
              )}
            >
              <div className={cx(indexStyles, 'index-filter-actions')}>
                <div className={cx(indexStyles, 'index-toolbar-primary')}>
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

                  <button
                    ref={filtersTriggerRef}
                    type="button"
                    className={joinClasses(
                      cx(controlStyles, 'pill-btn'),
                      cx(
                        indexStyles,
                        `index-filters-toggle-btn${mobileFiltersOpen ? ' active' : ''}${model.activeFilterCount > 0 ? ' has-active' : ''}`
                      )
                    )}
                    aria-expanded={mobileFiltersOpen}
                    aria-controls={filtersPanelId}
                    aria-label={
                      model.activeFilterCount > 0 ? `Filters (${model.activeFilterCount} active)` : 'Filters'
                    }
                    onClick={() => {
                      setMobileFiltersOpen((open) => !open);
                    }}
                  >
                    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
                      <path
                        d="M2.5 4h11M4.5 8h7M6.5 12h3"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.6"
                        strokeLinecap="round"
                      />
                    </svg>
                    <span>Filters</span>
                    {model.activeFilterCount > 0 && (
                      <span
                        className={cx(indexStyles, 'index-filters-badge')}
                        data-active-count={model.activeFilterCount}
                        aria-hidden="true"
                      >
                        {model.activeFilterCount}
                      </span>
                    )}
                  </button>
                </div>

                <div
                  id={filtersPanelId}
                  className={cx(
                    indexStyles,
                    `index-filters-panel${mobileFiltersOpen ? ' is-open' : ''}${showBranchSelector ? ' has-branch-select' : ''}`
                  )}
                  data-filters-open={mobileFiltersOpen ? 'true' : 'false'}
                  data-photo-saturated={model.isPhotoFilterSaturated ? 'true' : 'false'}
                >
                  <div className={cx(indexStyles, 'index-filters-sheet-header')}>
                    <span className={cx(indexStyles, 'index-filters-sheet-title')}>Filter archive</span>
                    <button
                      type="button"
                      className={cx(indexStyles, 'index-filters-sheet-close')}
                      aria-label="Close filters"
                      onClick={() => {
                        setMobileFiltersOpen(false);
                        filtersTriggerRef.current?.focus();
                      }}
                    >
                      Done
                    </button>
                  </div>

                  <input
                    type="search"
                    className={joinClasses(
                      cx(controlStyles, 'search-input'),
                      cx(indexStyles, 'index-search-input')
                    )}
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
                      `index-filter-toggles${showBranchSelector ? ' has-branch-select' : ''}`
                    )}
                  >
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
                        <option value="all">All Branches ({model.branchCounts['all']})</option>
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
                        className={joinClasses(
                          cx(
                            controlStyles,
                            `pill-btn index-media-filter-btn ${onlyWithPhotos ? 'active' : ''}`
                          ),
                          cx(indexStyles, 'index-media-filter-btn')
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
                          className={joinClasses(
                            cx(controlStyles, 'pill-btn index-clear-btn'),
                            cx(indexStyles, 'index-clear-btn')
                          )}
                          onClick={handleClearFilters}
                        >
                          Clear
                        </button>
                      )}
                    </div>
                  </div>
                </div>
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
                          <span className={cx(indexStyles, 'index-section-heading-title')}>
                            <span>{section.heading}</span>
                            <span className={cx(indexStyles, 'section-heading-count')}>
                              ({section.people.length})
                            </span>
                          </span>
                          {section.kind === 'historical' && section.snapshotYear !== null && (
                            <Link
                              to={`/time?year=${section.snapshotYear}`}
                              className={cx(indexStyles, 'index-era-snapshot-link')}
                            >
                              {section.snapshotYear} snapshot →
                            </Link>
                          )}
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
                          const storyHook = model.storyHooks.get(p.id) ?? null;
                          const showMilestones = p.event_count > 0;

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
                                  <span className={cx(indexStyles, 'person-card-lifespan')}>
                                    {formatPersonDirectoryLifespan(p)}
                                  </span>
                                  {primaryPlace && (
                                    <>
                                      {' '}
                                      <span
                                        className={cx(indexStyles, 'person-card-meta-sep')}
                                        aria-hidden="true"
                                      >
                                        ·
                                      </span>{' '}
                                      <span className={cx(indexStyles, 'person-card-place')}>
                                        {primaryPlace.full_name}
                                      </span>
                                    </>
                                  )}
                                </div>
                                {storyHook && (
                                  <p className={cx(indexStyles, 'person-card-hook')}>{storyHook}</p>
                                )}
                                {(showMilestones || mediaCount > 0) && (
                                  <div className={cx(indexStyles, 'person-card-stats')}>
                                    {showMilestones && (
                                      <span className={cx(indexStyles, 'person-card-milestones')}>
                                        {formatEventCount(p.event_count)}
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
