import type { Person } from '@kinloom/core';
import {
  buildFilteredGedcom7,
  buildGedcomExportFilename,
  buildPersonThumbMap,
  fastLocaleCompare,
} from '@kinloom/core';
import type React from 'react';
import { lazy, Suspense, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { EmptyStateNotice, PersonPortrait } from '../components/Atoms.js';
import atomStyles from '../components/Atoms.module.css';
import { ExplorerTopBar } from '../components/ExplorerTopBar.js';
import { KinloomFooter } from '../components/KinloomFooter.js';
import wikiChromeStyles from '../components/wiki/WikiChrome.module.css';
import { useArchiveData } from '../context/ArchiveDataContext.js';
import { cx, joinClasses } from '../lib/cx.js';
import { formatPhotoDocumentCount, formatReaderLoadError, KINLOOM_VOCABULARY } from '../lib/vocabulary.js';
import { PluginSlot } from '../plugins/PluginContext.js';
import controlStyles from '../styles/Controls.module.css';
import layoutStyles from '../styles/Layout.module.css';
import indexStyles from './IndexPage.module.css';

const LazyCreateEntityModal = lazy(async () => {
  const module = await import('../components/wiki/CreateEntityModal.js');
  return { default: module.CreateEntityModal };
});

function byBirthThenName(a: Person, b: Person): number {
  if (a.birth_year === null && b.birth_year === null) {
    return fastLocaleCompare(a.full_name, b.full_name);
  }
  if (a.birth_year === null) {
    return 1;
  }
  if (b.birth_year === null) {
    return -1;
  }
  return a.birth_year - b.birth_year || fastLocaleCompare(a.full_name, b.full_name);
}

interface ResolvedSection {
  id: string;
  heading: string;
  subtitle?: string;
  people: Person[];
}

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
  const [onlyWithMedia, setOnlyWithMedia] = useState<boolean>(false);
  const [query, setQuery] = useState<string>('');
  const [exportStatus, setExportStatus] = useState<string>('');
  const [createOpen, setCreateOpen] = useState<boolean>(false);

  const publicPeople = useMemo(() => {
    if (!bundle) {
      return [];
    }
    return bundle.people.filter((p) => !(p.is_living && p.full_name === 'Living'));
  }, [bundle]);

  const personThumbMap = useMemo(() => {
    if (!bundle) {
      return new Map<string, string>();
    }
    return buildPersonThumbMap(bundle);
  }, [bundle]);

  const withMediaCount = useMemo(
    () => publicPeople.filter((p) => (p.media_count || 0) > 0 || Boolean(p.portrait_url)).length,
    [publicPeople]
  );

  const filteredPeople = useMemo(() => {
    const q = query.trim().toLowerCase();
    return publicPeople.filter((p) => {
      if (onlyWithMedia && (p.media_count || 0) === 0 && !p.portrait_url) {
        return false;
      }
      if (q) {
        const placeName = p.primary_place_id ? placesById.get(p.primary_place_id)?.full_name || '' : '';
        const matchName = p.full_name.toLowerCase().includes(q);
        const matchAlt = (p.alt_names || []).some((a) => a.toLowerCase().includes(q));
        const matchPlace = placeName.toLowerCase().includes(q);
        if (!matchName && !matchAlt && !matchPlace) {
          return false;
        }
      }
      return true;
    });
  }, [publicPeople, placesById, onlyWithMedia, query]);

  const sections = useMemo<ResolvedSection[]>(() => {
    const configured = siteConfig.lineageSections;
    if (configured.length === 0) {
      return filteredPeople.length > 0
        ? [
            {
              id: 'all',
              heading: `${siteConfig.site.familyName} Relatives`,
              people: [...filteredPeople].toSorted(byBirthThenName),
            },
          ]
        : [];
    }

    const assignedIds = new Set<string>();
    const grouped: ResolvedSection[] = [];

    for (const sec of configured) {
      const matched = filteredPeople
        .filter((p) => {
          if (assignedIds.has(p.id)) {
            return false;
          }
          const groupMatch = sec.lineageGroups.length === 0 || sec.lineageGroups.includes(p.lineage_group);
          const branchMatch = !sec.branchId || p.branch === sec.branchId;
          return groupMatch && branchMatch;
        })
        .toSorted(byBirthThenName);

      if (matched.length > 0) {
        for (const p of matched) {
          assignedIds.add(p.id);
        }
        grouped.push({
          id: sec.id,
          heading: sec.title,
          subtitle: sec.subtitle,
          people: matched,
        });
      }
    }

    const others = filteredPeople.filter((p) => !assignedIds.has(p.id)).toSorted(byBirthThenName);
    if (others.length > 0) {
      grouped.push({ id: 'other', heading: 'Other relatives', people: others });
    }
    return grouped;
  }, [filteredPeople, siteConfig.lineageSections, siteConfig.site.familyName]);

  const handleExportFilteredGedcom = (): void => {
    if (!bundle || filteredPeople.length === 0) {
      return;
    }
    const filterParts: string[] = [`All ${siteConfig.site.familyName} Relatives`];
    if (onlyWithMedia) {
      filterParts.push('Has Photos/Scans');
    }
    if (query.trim()) {
      filterParts.push(`Search: "${query.trim()}"`);
    }

    const gedcomText = buildFilteredGedcom7({
      people: filteredPeople,
      bundle,
      placesById,
      sourcesById,
      siteConfig,
      filterDescription: filterParts.join(' · '),
    });
    const filename = buildGedcomExportFilename({
      familySlug: siteConfig.site.familyName,
      lineageFilter: 'all',
      selectedEra: 'all',
      onlyWithMedia,
      query,
      sortBy: 'birth_asc',
      count: filteredPeople.length,
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
      `Exported ${filteredPeople.length} relative${filteredPeople.length === 1 ? '' : 's'} to ${filename}`
    );
    window.setTimeout(() => {
      setExportStatus('');
    }, 4000);
  };

  return (
    <div>
      <ExplorerTopBar />
      <main id="main-content" className={cx(layoutStyles, 'index-page')}>
        <section className={joinClasses(cx(layoutStyles, 'wire-banner'), cx(indexStyles, 'index-banner'))}>
          <div>
            <h1>{siteConfig.site.familyName}</h1>
            <p>
              {siteConfig.site.description ||
                'Primary sources, historical places, and documented lineage woven into one archive.'}
            </p>
          </div>
        </section>

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
              className={joinClasses(cx(controlStyles, 'filter-bar'), cx(indexStyles, 'index-filter-bar'))}
            >
              <input
                type="search"
                className={cx(controlStyles, 'search-input')}
                placeholder="Search name or place…"
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                }}
                aria-label={`Search ${siteConfig.site.familyName} relatives by name or place`}
              />
              <div
                className={cx(
                  indexStyles,
                  `index-filter-actions${capabilities.canEdit ? ' has-editor-actions' : ''}`
                )}
              >
                <div className={cx(indexStyles, 'index-filter-toggles')}>
                  <button
                    type="button"
                    className={cx(
                      controlStyles,
                      `pill-btn index-media-filter-btn ${onlyWithMedia ? 'active' : ''}`
                    )}
                    aria-pressed={onlyWithMedia}
                    onClick={() => {
                      setOnlyWithMedia((v) => !v);
                    }}
                  >
                    {KINLOOM_VOCABULARY.person.photosAndDocumentsHeading} ({withMediaCount})
                  </button>
                  {(query.trim() || onlyWithMedia) && (
                    <button
                      type="button"
                      className={cx(controlStyles, 'pill-btn index-clear-btn')}
                      onClick={() => {
                        setQuery('');
                        setOnlyWithMedia(false);
                      }}
                    >
                      Clear
                    </button>
                  )}
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
                <button
                  type="button"
                  className={joinClasses(cx(controlStyles, 'pill-btn'), cx(indexStyles, 'index-export-btn'))}
                  disabled={filteredPeople.length === 0}
                  onClick={handleExportFilteredGedcom}
                  title="Download a family tree file of the relatives currently shown"
                >
                  Export GEDCOM ({filteredPeople.length})
                </button>
              </div>
            </div>
            {exportStatus && (
              <output
                aria-live="polite"
                style={{
                  display: 'block',
                  fontFamily: 'var(--font-mono)',
                  fontSize: '0.78rem',
                  color: 'var(--radar-local)',
                  marginBottom: 10,
                }}
              >
                {exportStatus}
              </output>
            )}

            {sections.length === 0 ? (
              <EmptyStateNotice
                title={
                  bundle.people.length === 0
                    ? 'No people have been added to this archive yet.'
                    : 'No people match the active filters.'
                }
                action={
                  query.trim() || onlyWithMedia ? (
                    <button
                      type="button"
                      className={cx(controlStyles, 'pill-btn')}
                      onClick={() => {
                        setQuery('');
                        setOnlyWithMedia(false);
                      }}
                    >
                      Clear filters
                    </button>
                  ) : undefined
                }
              />
            ) : (
              sections.map((section, idx) => (
                <section key={section.id} aria-label={section.heading}>
                  <h2
                    className={joinClasses(
                      cx(controlStyles, 'section-heading'),
                      cx(indexStyles, 'index-section-heading'),
                      idx === 0 ? 'is-first' : ''
                    )}
                  >
                    <span>{section.heading}</span>
                    <span className={cx(indexStyles, 'section-heading-count')}>{section.people.length}</span>
                  </h2>
                  <div className={cx(indexStyles, 'person-grid')}>
                    {section.people.map((p, personIdx) => {
                      const primaryPlace = p.primary_place_id
                        ? placesById.get(p.primary_place_id)
                        : undefined;
                      const mediaCount = p.media_count || 0;
                      const thumbUrl = personThumbMap.get(p.id) || p.portrait_url;
                      const eagerPortrait = idx === 0 && personIdx < 6;
                      return (
                        <Link key={p.id} to={`/person/${p.slug}`} className={cx(indexStyles, 'person-card')}>
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
                              {p.birth_year || '?'} – {p.death_year || (p.is_living ? 'Living' : '?')}
                            </div>
                            <div
                              style={{ fontSize: '0.88rem', color: 'var(--text-secondary)', marginTop: 3 }}
                            >
                              {primaryPlace ? primaryPlace.full_name : 'Location unrecorded'}
                            </div>
                            <div
                              style={{
                                display: 'flex',
                                flexWrap: 'wrap',
                                alignItems: 'center',
                                gap: 8,
                                marginTop: 5,
                              }}
                            >
                              <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.76rem' }}>
                                {p.event_count} milestone{p.event_count === 1 ? '' : 's'}
                              </span>
                              {mediaCount > 0 && (
                                <span className={cx(atomStyles, 'person-card-media-badge')}>
                                  {formatPhotoDocumentCount(mediaCount)}
                                </span>
                              )}
                            </div>
                          </div>
                        </Link>
                      );
                    })}
                  </div>
                </section>
              ))
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
