import type { Person } from '@kinloom/core';
import {
  buildFilteredGedcom7,
  buildGedcomExportFilename,
  buildPersonThumbMap,
} from '@kinloom/core';
import React, { useMemo, useState } from 'react';
import { initialsOf, resolveAssetUrl } from '../components/Atoms.js';
import { CreateEntityModal } from '../components/wiki/CreateEntityModal.js';
import { ExplorerTopBar } from '../components/ExplorerTopBar.js';
import { KinloomFooter } from '../components/KinloomFooter.js';
import { Link } from 'react-router-dom';
import { PluginSlot } from '../plugins/PluginContext.js';
import { useArchiveData } from '../context/ArchiveDataContext.js';

function byBirthThenName(a: Person, b: Person): number {
  if (a.birth_year === null && b.birth_year === null) {
    return a.full_name.localeCompare(b.full_name);
  }
  if (a.birth_year === null) {
    return 1;
  }
  if (b.birth_year === null) {
    return -1;
  }
  return a.birth_year - b.birth_year || a.full_name.localeCompare(b.full_name);
}

interface ResolvedSection {
  id: string;
  heading: string;
  subtitle?: string;
  people: Person[];
}

export const IndexPage: React.FC = () => {
  const { siteConfig, baseUrl, bundle, placesById, sourcesById, capabilities, loading, error } =
    useArchiveData();
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
    [publicPeople],
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
          const groupMatch =
            sec.lineageGroups.length === 0 || sec.lineageGroups.includes(p.lineage_group);
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

    setExportStatus(`Exported ${filteredPeople.length} relative${filteredPeople.length === 1 ? '' : 's'} to ${filename}`);
    window.setTimeout(() => {
      setExportStatus('');
    }, 4000);
  };

  return (
    <div>
      <ExplorerTopBar />
      <main className="index-page">
        <section className="wire-banner index-banner">
          <div>
            <h1>{siteConfig.site.familyName}</h1>
            <p>
              {siteConfig.site.description ||
                'Primary sources, historical places, and documented lineage woven into one archive.'}
            </p>
          </div>
        </section>

        <PluginSlot name="indexHero" />

        {loading && <p>Loading compiled archive bundle…</p>}
        {error && <p>Error loading archive: {error}</p>}

        {bundle && (
          <>
            <div className="filter-bar index-filter-bar">
              <input
                type="search"
                className="search-input"
                placeholder="Search name or place…"
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                }}
                aria-label={`Search ${siteConfig.site.familyName} relatives by name or place`}
              />
              <div className="index-filter-actions">
                <div className="index-filter-toggles">
                  <button
                    type="button"
                    className={`pill-btn ${onlyWithMedia ? 'active' : ''}`}
                    aria-pressed={onlyWithMedia}
                    onClick={() => {
                      setOnlyWithMedia((v) => !v);
                    }}
                  >
                    Photos &amp; Scans ({withMediaCount})
                  </button>
                  {(query.trim() || onlyWithMedia) && (
                    <button
                      type="button"
                      className="pill-btn"
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
                    className="wiki-btn-secondary wiki-btn-sm"
                    onClick={() => {
                      setCreateOpen(true);
                    }}
                  >
                    + Add Person
                  </button>
                )}
                <button
                  type="button"
                  className="pill-btn index-export-btn"
                  disabled={filteredPeople.length === 0}
                  onClick={handleExportFilteredGedcom}
                  title="Download a GEDCOM 7.0 file of the relatives currently shown"
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
              <p style={{ color: 'var(--text-secondary)', marginBottom: 24 }}>
                No archived relatives match the active filters.
              </p>
            ) : (
              sections.map((section, idx) => (
                <section key={section.id} aria-label={section.heading}>
                  <h2 className={`section-heading index-section-heading ${idx === 0 ? 'is-first' : ''}`}>
                    <span>{section.heading}</span>
                    <span className="section-heading-count">{section.people.length}</span>
                  </h2>
                  <div className="person-grid">
                    {section.people.map((p) => {
                      const primaryPlace = p.primary_place_id ? placesById.get(p.primary_place_id) : undefined;
                      const mediaCount = p.media_count || 0;
                      const thumbUrl = personThumbMap.get(p.id) || p.portrait_url;
                      return (
                        <Link key={p.id} to={`/person/${p.slug}`} className="person-card">
                          <div className="person-card-portrait" aria-hidden="true">
                            {thumbUrl ? (
                              <img
                                src={resolveAssetUrl(thumbUrl, baseUrl)}
                                alt=""
                                loading="lazy"
                                className="person-card-portrait-img"
                              />
                            ) : (
                              <span className="photo-print-monogram">{initialsOf(p.full_name)}</span>
                            )}
                          </div>
                          <div className="person-card-body">
                            <h3>{p.full_name}</h3>
                            <div className="person-card-meta">
                              {p.birth_year || '?'} – {p.death_year || (p.is_living ? 'Living' : '?')}
                            </div>
                            <div style={{ fontSize: '0.88rem', color: 'var(--text-secondary)', marginTop: 3 }}>
                              {primaryPlace ? primaryPlace.full_name : 'Location unrecorded'}
                            </div>
                            <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, marginTop: 5 }}>
                              <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.76rem' }}>
                                {p.event_count} milestone{p.event_count === 1 ? '' : 's'}
                              </span>
                              {mediaCount > 0 && (
                                <span className="person-card-media-badge">
                                  {mediaCount} {mediaCount === 1 ? 'photo / scan' : 'photos & scans'}
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
      <CreateEntityModal
        open={createOpen}
        onClose={() => {
          setCreateOpen(false);
        }}
      />
      <KinloomFooter />
    </div>
  );
};
