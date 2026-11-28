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
import { ArchivalImage } from '../../components/Atoms.js';
import { ExplorerTopBar } from '../../components/ExplorerTopBar.js';
import { KinloomFooter } from '../../components/KinloomFooter.js';
import { cx } from '../../lib/cx.js';
import {
  computeOptimisticStarState,
  formatRecipeCourseLabel,
  formatTotalRecipeDuration,
  normalizeCatalogSortMode,
  UI_RECIPE_COURSES,
  type UiCatalogSortOption,
  type UiRecipeCourse,
  UiRecipeCourseSchema,
  type UiRecipeListResponse,
  type UiRecipeSummary,
} from '../../lib/recipesModel.js';
import { useKinloomPluginContext } from '../PluginContext.js';
import { RecipeStarButton } from './RecipeStarButton.js';
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

  const [activeTab, setActiveTab] = useState<'all' | 'favorites'>(() => {
    const favParam = searchParams.get('favorites');
    if (initialTab === 'favorites' || favParam === '1' || favParam === 'true') {
      return 'favorites';
    }
    return 'all';
  });
  const [query, setQuery] = useState<string>(() => searchParams.get('q') ?? '');
  const [course, setCourse] = useState<UiRecipeCourse | ''>(() => {
    const raw = searchParams.get('course');
    const parsed = raw ? UiRecipeCourseSchema.safeParse(raw) : null;
    return parsed?.success ? parsed.data : '';
  });
  const [tag, setTag] = useState<string>(() => searchParams.get('tag')?.trim().toLowerCase() ?? '');
  const [ancestorId, setAncestorId] = useState<string>(() => searchParams.get('ancestor') ?? '');
  const [sort, setSort] = useState<UiCatalogSortOption>(() =>
    normalizeCatalogSortMode(searchParams.get('sort'))
  );
  const [offset, setOffset] = useState<number>(0);
  const [reloadTick, setReloadTick] = useState<number>(0);

  const [data, setData] = useState<UiRecipeListResponse | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [starError, setStarError] = useState<string | null>(null);
  const [pendingStarIds, setPendingStarIds] = useState<ReadonlySet<string>>(() => new Set());
  const [disabledOnServer, setDisabledOnServer] = useState<boolean>(false);

  useEffect(() => {
    if (initialTab === 'favorites') {
      setActiveTab('favorites');
      setOffset(0);
    } else {
      const favParam = searchParams.get('favorites');
      setActiveTab(favParam === '1' || favParam === 'true' ? 'favorites' : 'all');
      setOffset(0);
    }
  }, [initialTab, searchParams]);

  const deceasedPeople = useMemo(() => searchDeceasedPeople('', 100), [searchDeceasedPeople]);

  const syncCatalogParams = useCallback(
    (updates: {
      readonly q?: string;
      readonly course?: string;
      readonly tag?: string;
      readonly ancestor?: string;
      readonly sort?: UiCatalogSortOption;
    }) => {
      const nextParams = new URLSearchParams(searchParams);
      if (updates.q !== undefined) {
        const trimmed = updates.q.trim();
        if (trimmed) {
          nextParams.set('q', trimmed);
        } else {
          nextParams.delete('q');
        }
      }
      if (updates.course !== undefined) {
        if (updates.course) {
          nextParams.set('course', updates.course);
        } else {
          nextParams.delete('course');
        }
      }
      if (updates.tag !== undefined) {
        if (updates.tag) {
          nextParams.set('tag', updates.tag);
        } else {
          nextParams.delete('tag');
        }
      }
      if (updates.ancestor !== undefined) {
        if (updates.ancestor) {
          nextParams.set('ancestor', updates.ancestor);
        } else {
          nextParams.delete('ancestor');
        }
      }
      if (updates.sort !== undefined) {
        if (updates.sort !== 'most_starred') {
          nextParams.set('sort', updates.sort);
        } else {
          nextParams.set('sort', 'most_starred');
        }
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
    syncCatalogParams({ q: '', course: '', tag: '', ancestor: '' });
  };

  const handleSelectTab = (tabId: string): void => {
    const nextTab = tabId === 'favorites' ? 'favorites' : 'all';
    setActiveTab(nextTab);
    setOffset(0);
    const nextParams = new URLSearchParams(searchParams);
    nextParams.delete('favorites');
    const qs = nextParams.toString();
    const targetPath = nextTab === 'favorites' ? `${basePath}/favorites` : basePath;
    void navigate(qs ? `${targetPath}?${qs}` : targetPath, { replace: true });
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
  const canStar = Boolean(data?.permissions?.can_star && client.starRecipe && client.unstarRecipe);
  const showFavoritesTab =
    data === null ||
    data.permissions === undefined ||
    data.permissions.can_star !== false ||
    activeTab === 'favorites';
  const hasPrevious = offset > 0;
  const hasNext = offset + recipes.length < total;

  const handleToggleStar = async (recipe: UiRecipeSummary): Promise<void> => {
    if (!canStar || !client.starRecipe || !client.unstarRecipe || pendingStarIds.has(recipe.id)) {
      return;
    }

    const targetStarred = !recipe.viewer_has_starred;
    const prevStarState = {
      star_count: recipe.star_count,
      viewer_has_starred: recipe.viewer_has_starred,
    };
    const optimistic = computeOptimisticStarState(prevStarState, targetStarred);
    const removingFromFavorites = activeTab === 'favorites' && !targetStarred;
    const originalIndex = recipes.findIndex((item) => item.id === recipe.id);

    setStarError(null);
    setPendingStarIds((prev) => {
      const next = new Set(prev);
      next.add(recipe.id);
      return next;
    });

    setData((prev) => {
      if (!prev) {
        return prev;
      }
      if (removingFromFavorites) {
        return {
          ...prev,
          recipes: prev.recipes.filter((item) => item.id !== recipe.id),
          total: Math.max(0, prev.total - 1),
        };
      }
      return {
        ...prev,
        recipes: prev.recipes.map((item) =>
          item.id === recipe.id
            ? {
                ...item,
                star_count: optimistic.star_count,
                viewer_has_starred: optimistic.viewer_has_starred,
              }
            : item
        ),
      };
    });

    try {
      const result = targetStarred
        ? await client.starRecipe(recipe.slug)
        : await client.unstarRecipe(recipe.slug);
      setData((prev) => {
        if (!prev) {
          return prev;
        }
        return {
          ...prev,
          recipes: prev.recipes.map((item) =>
            item.id === recipe.id
              ? {
                  ...item,
                  star_count: result.star_count,
                  viewer_has_starred: result.viewer_has_starred,
                }
              : item
          ),
        };
      });
    } catch (err: unknown) {
      setData((prev) => {
        if (!prev) {
          return prev;
        }
        if (removingFromFavorites) {
          if (prev.recipes.some((item) => item.id === recipe.id)) {
            return prev;
          }
          const restored = [...prev.recipes];
          const insertAt = originalIndex >= 0 ? Math.min(originalIndex, restored.length) : restored.length;
          restored.splice(insertAt, 0, {
            ...recipe,
            star_count: prevStarState.star_count,
            viewer_has_starred: prevStarState.viewer_has_starred,
          });
          return {
            ...prev,
            recipes: restored,
            total: prev.total + 1,
          };
        }
        return {
          ...prev,
          recipes: prev.recipes.map((item) =>
            item.id === recipe.id
              ? {
                  ...item,
                  star_count: prevStarState.star_count,
                  viewer_has_starred: prevStarState.viewer_has_starred,
                }
              : item
          ),
        };
      });
      setStarError(err instanceof Error ? err.message : 'Unable to update recipe star right now.');
    } finally {
      setPendingStarIds((prev) => {
        const next = new Set(prev);
        next.delete(recipe.id);
        return next;
      });
    }
  };

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

        {showFavoritesTab && (
          <ArchivalTabs
            ariaLabel="Recipe catalog view"
            tabs={[
              { id: 'all', label: 'All Recipes' },
              { id: 'favorites', label: 'My Favorites' },
            ]}
            activeTabId={activeTab}
            onSelectTab={handleSelectTab}
          />
        )}

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
                const next = e.target.value;
                setQuery(next);
                setOffset(0);
                syncCatalogParams({ q: next });
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
                const nextCourse = parsed?.success ? parsed.data : '';
                setCourse(nextCourse);
                setOffset(0);
                syncCatalogParams({ course: nextCourse });
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
                  syncCatalogParams({ tag: next });
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
                  const next = e.target.value;
                  setAncestorId(next);
                  setOffset(0);
                  syncCatalogParams({ ancestor: next });
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
                const nextSort = normalizeCatalogSortMode(e.target.value);
                setSort(nextSort);
                setOffset(0);
                syncCatalogParams({ sort: nextSort });
              }}
            >
              <option value="most_starred">Most Starred</option>
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
                syncCatalogParams({ tag: '' });
              }}
            />
          </div>
        )}

        {starError && (
          <ArchivalToast
            tone="error"
            message={starError}
            onDismiss={() => {
              setStarError(null);
            }}
          />
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
                      <ArchivalImage
                        src={recipe.cover_photo_url}
                        alt={`Recipe card for ${recipe.title}`}
                        loading="lazy"
                        frameStyle={{ width: '100%', height: '100%' }}
                        className={cx(recipeStyles, 'recipe-card-img')}
                        fallback={
                          <div className={cx(recipeStyles, 'recipe-card-emblem')} aria-hidden="true">
                            <span className={cx(recipeStyles, 'recipe-card-emblem-course')}>
                              {formatRecipeCourseLabel(recipe.course)}
                            </span>
                          </div>
                        }
                      />
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
                                syncCatalogParams({ tag: next });
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
                          <RecipeStarButton
                            recipeTitle={recipe.title}
                            starCount={recipe.star_count}
                            starred={recipe.viewer_has_starred}
                            canStar={canStar}
                            pending={pendingStarIds.has(recipe.id)}
                            variant="card"
                            onToggle={() => {
                              void handleToggleStar(recipe);
                            }}
                          />
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
