import type React from 'react';
import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { ArchivalBanner, ArchivalPageShell } from '../../components/ArchivalLayout.js';
import {
  ArchivalCardGrid,
  ArchivalEmptyState,
  ArchivalFilterBar,
  ArchivalTabs,
  ArchivalTagPill,
  ArchivalToast,
} from '../../components/ArchivalPrimitives.js';
import { ExplorerTopBar } from '../../components/ExplorerTopBar.js';
import { KinloomFooter } from '../../components/KinloomFooter.js';
import { cx } from '../../lib/cx.js';
import {
  formatRecipeCourseLabel,
  formatTotalRecipeDuration,
  UI_RECIPE_COURSES,
  type UiRecipeCourse,
  UiRecipeCourseSchema,
  type UiRecipeListResponse,
  type UiRecipeSortMode,
  UiRecipeSortModeSchema,
} from '../../lib/recipesModel.js';
import { useKinloomPluginContext } from '../PluginContext.js';
import recipeStyles from './Recipes.module.css';
import { useRecipesPlugin } from './RecipesContext.js';

const PAGE_SIZE = 24;

export interface RecipeCatalogPageProps {
  readonly initialTab?: 'all' | 'favorites';
}

export const RecipeCatalogPage: React.FC<RecipeCatalogPageProps> = ({ initialTab = 'all' }) => {
  const { client, basePath, pageTitle, pageDescription } = useRecipesPlugin();
  const { searchDeceasedPeople } = useKinloomPluginContext();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  const searchInputId = useId();
  const courseSelectId = useId();
  const tagSelectId = useId();
  const ancestorSelectId = useId();
  const sortSelectId = useId();

  const [activeTab, setActiveTab] = useState<'all' | 'favorites'>(initialTab);
  const [query, setQuery] = useState<string>(() => searchParams.get('q') ?? '');
  const [course, setCourse] = useState<UiRecipeCourse | ''>(() => {
    const raw = searchParams.get('course');
    const parsed = raw ? UiRecipeCourseSchema.safeParse(raw) : null;
    return parsed?.success ? parsed.data : '';
  });
  const [tag, setTag] = useState<string>(() => searchParams.get('tag')?.trim().toLowerCase() ?? '');
  const [ancestorId, setAncestorId] = useState<string>(() => searchParams.get('ancestor') ?? '');
  const [sort, setSort] = useState<UiRecipeSortMode>(() => {
    const raw = searchParams.get('sort');
    const parsed = raw ? UiRecipeSortModeSchema.safeParse(raw) : null;
    return parsed?.success ? parsed.data : 'stars';
  });
  const [offset, setOffset] = useState<number>(0);
  const [reloadTick, setReloadTick] = useState<number>(0);

  const [data, setData] = useState<UiRecipeListResponse | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [disabledOnServer, setDisabledOnServer] = useState<boolean>(false);

  useEffect(() => {
    setActiveTab(initialTab);
    setOffset(0);
  }, [initialTab]);

  const deceasedPeople = useMemo(() => searchDeceasedPeople('', 100), [searchDeceasedPeople]);

  const syncUrlTag = useCallback(
    (nextTag: string) => {
      const nextParams = new URLSearchParams(searchParams);
      if (nextTag) {
        nextParams.set('tag', nextTag);
      } else {
        nextParams.delete('tag');
      }
      setSearchParams(nextParams, { replace: true });
    },
    [searchParams, setSearchParams]
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: reloadTick triggers explicit retry
  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;
    setLoading(true);
    setError(null);

    void client
      .listRecipes(
        {
          q: query.trim() || undefined,
          course: course || undefined,
          tag: tag || undefined,
          attributed_person_id: ancestorId || undefined,
          favorites: activeTab === 'favorites',
          sort,
          limit: PAGE_SIZE,
          offset,
        },
        { signal: controller.signal }
      )
      .then((res) => {
        if (cancelled) {
          return;
        }
        if (res === null) {
          setDisabledOnServer(true);
          setData(null);
        } else {
          setDisabledOnServer(false);
          setData(res);
        }
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (cancelled) {
          return;
        }
        setError(err instanceof Error ? err.message : 'Unable to load recipes right now.');
        setLoading(false);
      });

    return (): void => {
      cancelled = true;
      controller.abort();
    };
  }, [client, query, course, tag, ancestorId, activeTab, sort, offset, reloadTick]);

  const hasActiveFilters = Boolean(query.trim() || course || tag || ancestorId);

  const handleClearFilters = (): void => {
    setQuery('');
    setCourse('');
    setTag('');
    setAncestorId('');
    setOffset(0);
    syncUrlTag('');
  };

  const handleSelectTab = (tabId: string): void => {
    const nextTab = tabId === 'favorites' ? 'favorites' : 'all';
    setActiveTab(nextTab);
    setOffset(0);
    const targetPath = nextTab === 'favorites' ? `${basePath}/favorites` : basePath;
    void navigate(targetPath, { replace: true });
  };

  const courseOptions = useMemo<readonly UiRecipeCourse[]>(() => {
    if (data && data.facets.courses.length > 0) {
      return data.facets.courses;
    }
    return UI_RECIPE_COURSES;
  }, [data]);

  const tagOptions = data?.facets.tags ?? [];
  const recipes = data?.recipes ?? [];
  const total = data?.total ?? 0;
  const canCreate = Boolean(data?.permissions?.can_create && client.createRecipe);
  const hasPrevious = offset > 0;
  const hasNext = offset + recipes.length < total;

  return (
    <div>
      <ExplorerTopBar />
      <ArchivalPageShell variant="wide">
        <ArchivalBanner>
          <div>
            <h1>{pageTitle}</h1>
            <p>{pageDescription}</p>
          </div>
          <div className={cx(recipeStyles, 'recipe-banner-actions')}>
            {!loading && data && (
              <div className={cx(recipeStyles, 'recipe-banner-meta')}>
                <span>
                  {total} {total === 1 ? 'recipe' : 'recipes'}
                </span>
                {activeTab === 'favorites' && <span>Filtered: My Favorites</span>}
              </div>
            )}
            {canCreate && (
              <Link to={`${basePath}/new`} className={cx(recipeStyles, 'recipe-primary-btn')}>
                + Add Recipe
              </Link>
            )}
          </div>
        </ArchivalBanner>

        <ArchivalTabs
          ariaLabel="Recipe catalog view"
          tabs={[
            { id: 'all', label: 'All Recipes' },
            { id: 'favorites', label: 'My Favorites' },
          ]}
          activeTabId={activeTab}
          onSelectTab={handleSelectTab}
        />

        <ArchivalFilterBar
          actions={
            hasActiveFilters ? (
              <button
                type="button"
                className={cx(recipeStyles, 'recipe-clear-btn')}
                onClick={handleClearFilters}
              >
                Clear filters
              </button>
            ) : undefined
          }
        >
          <div className={cx(recipeStyles, 'recipe-filter-field recipe-filter-field-search')}>
            <label htmlFor={searchInputId} className={cx(recipeStyles, 'recipe-filter-label')}>
              Search
            </label>
            <input
              id={searchInputId}
              type="search"
              className={cx(recipeStyles, 'recipe-filter-input')}
              placeholder="Title, provenance, or tag…"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setOffset(0);
              }}
            />
          </div>

          <div className={cx(recipeStyles, 'recipe-filter-field')}>
            <label htmlFor={courseSelectId} className={cx(recipeStyles, 'recipe-filter-label')}>
              Course
            </label>
            <select
              id={courseSelectId}
              className={cx(recipeStyles, 'recipe-filter-select')}
              value={course}
              onChange={(e) => {
                const raw = e.target.value;
                const parsed = raw ? UiRecipeCourseSchema.safeParse(raw) : null;
                setCourse(parsed?.success ? parsed.data : '');
                setOffset(0);
              }}
            >
              <option value="">All courses</option>
              {courseOptions.map((c) => (
                <option key={c} value={c}>
                  {formatRecipeCourseLabel(c)}
                </option>
              ))}
            </select>
          </div>

          {tagOptions.length > 0 && (
            <div className={cx(recipeStyles, 'recipe-filter-field')}>
              <label htmlFor={tagSelectId} className={cx(recipeStyles, 'recipe-filter-label')}>
                Tag
              </label>
              <select
                id={tagSelectId}
                className={cx(recipeStyles, 'recipe-filter-select')}
                value={tag}
                onChange={(e) => {
                  const next = e.target.value;
                  setTag(next);
                  setOffset(0);
                  syncUrlTag(next);
                }}
              >
                <option value="">All tags</option>
                {tagOptions.map((t) => (
                  <option key={t} value={t}>
                    #{t}
                  </option>
                ))}
              </select>
            </div>
          )}

          {deceasedPeople.length > 0 && (
            <div className={cx(recipeStyles, 'recipe-filter-field')}>
              <label htmlFor={ancestorSelectId} className={cx(recipeStyles, 'recipe-filter-label')}>
                Ancestor
              </label>
              <select
                id={ancestorSelectId}
                className={cx(recipeStyles, 'recipe-filter-select')}
                value={ancestorId}
                onChange={(e) => {
                  setAncestorId(e.target.value);
                  setOffset(0);
                }}
              >
                <option value="">All ancestors</option>
                {deceasedPeople.map((person) => (
                  <option key={person.id} value={person.id}>
                    {person.full_name}
                  </option>
                ))}
              </select>
            </div>
          )}

          <div className={cx(recipeStyles, 'recipe-filter-field')}>
            <label htmlFor={sortSelectId} className={cx(recipeStyles, 'recipe-filter-label')}>
              Sort by
            </label>
            <select
              id={sortSelectId}
              className={cx(recipeStyles, 'recipe-filter-select')}
              value={sort}
              onChange={(e) => {
                const parsed = UiRecipeSortModeSchema.safeParse(e.target.value);
                if (parsed.success) {
                  setSort(parsed.data);
                  setOffset(0);
                }
              }}
            >
              <option value="stars">Most Starred</option>
              <option value="newest">Newest</option>
              <option value="alpha">Alphabetical</option>
            </select>
          </div>
        </ArchivalFilterBar>

        {tag && (
          <div className={cx(recipeStyles, 'recipe-active-filters')}>
            <ArchivalTagPill
              label={`#${tag}`}
              onRemove={() => {
                setTag('');
                setOffset(0);
                syncUrlTag('');
              }}
            />
          </div>
        )}

        {error && (
          <ArchivalToast
            tone="error"
            message={error}
            onDismiss={() => {
              setError(null);
            }}
          />
        )}

        {loading && (
          <output aria-live="polite" className={cx(recipeStyles, 'recipe-banner-meta')}>
            Loading family recipes…
          </output>
        )}

        {!loading && disabledOnServer && (
          <ArchivalEmptyState
            title="Family Recipe Box is not enabled on this server"
            description="An archive administrator can enable the opt-in recipes plugin to share family recipe cards here."
          />
        )}

        {!loading && !disabledOnServer && error && (
          <ArchivalEmptyState
            title="Unable to load recipes"
            description="Check your connection or try loading the recipe box again."
            action={
              <button
                type="button"
                className={cx(recipeStyles, 'recipe-clear-btn')}
                onClick={() => {
                  setReloadTick((t) => t + 1);
                }}
              >
                Try again
              </button>
            }
          />
        )}

        {!loading && !disabledOnServer && !error && recipes.length === 0 && (
          <ArchivalEmptyState
            title={
              activeTab === 'favorites'
                ? 'No favorite recipes yet'
                : hasActiveFilters
                  ? 'No recipes match the active filters'
                  : 'No family recipes have been recorded yet'
            }
            description={
              activeTab === 'favorites'
                ? 'Star recipes you want to keep close at hand and they will appear in this collection.'
                : hasActiveFilters
                  ? 'Try clearing a filter or broadening your search term.'
                  : 'Once family members transcribe heirloom cards, they will appear in this recipe box.'
            }
            action={
              hasActiveFilters ? (
                <button
                  type="button"
                  className={cx(recipeStyles, 'recipe-clear-btn')}
                  onClick={handleClearFilters}
                >
                  Clear filters
                </button>
              ) : canCreate && activeTab === 'all' ? (
                <Link to={`${basePath}/new`} className={cx(recipeStyles, 'recipe-primary-btn')}>
                  + Add First Recipe
                </Link>
              ) : undefined
            }
          />
        )}

        {!loading && !disabledOnServer && !error && recipes.length > 0 && (
          <>
            <ArchivalCardGrid>
              {recipes.map((recipe) => {
                const totalTime = formatTotalRecipeDuration(recipe.prep_minutes, recipe.cook_minutes);
                const recipeHref = `${basePath}/${encodeURIComponent(recipe.slug)}`;
                return (
                  <article key={recipe.id} className={cx(recipeStyles, 'recipe-card')}>
                    <Link to={recipeHref} className={cx(recipeStyles, 'recipe-card-media')}>
                      {recipe.cover_photo_url ? (
                        <img
                          src={recipe.cover_photo_url}
                          alt={`Recipe card for ${recipe.title}`}
                          loading="lazy"
                          className={cx(recipeStyles, 'recipe-card-img')}
                        />
                      ) : (
                        <div className={cx(recipeStyles, 'recipe-card-emblem')} aria-hidden="true">
                          <span className={cx(recipeStyles, 'recipe-card-emblem-course')}>
                            {formatRecipeCourseLabel(recipe.course)}
                          </span>
                        </div>
                      )}
                    </Link>

                    <div className={cx(recipeStyles, 'recipe-card-body')}>
                      <div className={cx(recipeStyles, 'recipe-card-top')}>
                        <span className={cx(recipeStyles, 'recipe-course-badge')}>
                          {formatRecipeCourseLabel(recipe.course)}
                        </span>
                        {recipe.source_era && (
                          <span className={cx(recipeStyles, 'recipe-era-label')}>{recipe.source_era}</span>
                        )}
                      </div>

                      <h2 className={cx(recipeStyles, 'recipe-card-title')}>
                        <Link to={recipeHref} className={cx(recipeStyles, 'recipe-card-title-link')}>
                          {recipe.title}
                        </Link>
                      </h2>

                      {recipe.summary && (
                        <p className={cx(recipeStyles, 'recipe-card-summary')}>{recipe.summary}</p>
                      )}

                      {recipe.attributed_person && (
                        <Link
                          to={`/person/${encodeURIComponent(recipe.attributed_person.slug)}`}
                          className={cx(recipeStyles, 'recipe-ancestor-chip')}
                        >
                          From {recipe.attributed_person.full_name}
                        </Link>
                      )}

                      {recipe.tags.length > 0 && (
                        <div className={cx(recipeStyles, 'recipe-card-tags')}>
                          {recipe.tags.slice(0, 4).map((t) => (
                            <ArchivalTagPill
                              key={t}
                              label={`#${t}`}
                              active={tag === t}
                              onClick={() => {
                                const next = tag === t ? '' : t;
                                setTag(next);
                                setOffset(0);
                                syncUrlTag(next);
                              }}
                            />
                          ))}
                        </div>
                      )}

                      <div className={cx(recipeStyles, 'recipe-card-footer')}>
                        <span>
                          {[totalTime, recipe.servings].filter(Boolean).join(' · ') || 'Heirloom card'}
                        </span>
                        <span className={cx(recipeStyles, 'recipe-card-stats')}>
                          <span>
                            {recipe.star_count} {recipe.star_count === 1 ? 'star' : 'stars'}
                          </span>
                          <span>
                            {recipe.comment_count} {recipe.comment_count === 1 ? 'note' : 'notes'}
                          </span>
                        </span>
                      </div>
                    </div>
                  </article>
                );
              })}
            </ArchivalCardGrid>

            {(hasPrevious || hasNext) && (
              <nav className={cx(recipeStyles, 'recipe-pagination')} aria-label="Recipe pagination">
                <span>
                  Showing {offset + 1}–{offset + recipes.length} of {total}
                </span>
                <div className={cx(recipeStyles, 'recipe-pagination-actions')}>
                  <button
                    type="button"
                    className={cx(recipeStyles, 'recipe-clear-btn')}
                    disabled={!hasPrevious}
                    onClick={() => {
                      setOffset((prev) => Math.max(0, prev - PAGE_SIZE));
                    }}
                  >
                    Previous
                  </button>
                  <button
                    type="button"
                    className={cx(recipeStyles, 'recipe-clear-btn')}
                    disabled={!hasNext}
                    onClick={() => {
                      setOffset((prev) => prev + PAGE_SIZE);
                    }}
                  >
                    Next
                  </button>
                </div>
              </nav>
            )}
          </>
        )}
      </ArchivalPageShell>
      <KinloomFooter />
    </div>
  );
};

export const RecipeFavoritesPage: React.FC = () => <RecipeCatalogPage initialTab="favorites" />;
