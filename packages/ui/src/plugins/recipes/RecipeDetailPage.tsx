import type React from 'react';
import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArchivalPageShell } from '../../components/ArchivalLayout.js';
import { ArchivalMarkdown } from '../../components/ArchivalMarkdown.js';
import {
  ArchivalEmptyState,
  ArchivalModal,
  ArchivalTagPill,
  ArchivalToast,
} from '../../components/ArchivalPrimitives.js';
import { ExplorerTopBar } from '../../components/ExplorerTopBar.js';
import { KinloomFooter } from '../../components/KinloomFooter.js';
import { cx } from '../../lib/cx.js';
import {
  formatRecipeCourseLabel,
  formatRecipeDuration,
  formatRecipeIngredientLine,
  formatTotalRecipeDuration,
  groupRecipeIngredients,
  UI_RECIPE_CARD_SIDE_LABELS,
  type UiRecipeDetailResponse,
  type UiRecipePhoto,
} from '../../lib/recipesModel.js';
import { useKinloomPluginContext } from '../PluginContext.js';
import recipeStyles from './Recipes.module.css';
import { useRecipesPlugin } from './RecipesContext.js';

export const RecipeDetailPage: React.FC = () => {
  const { slug } = useParams<{ slug: string }>();
  const { client, basePath } = useRecipesPlugin();
  const { bundle, getDeceasedPersonById } = useKinloomPluginContext();

  const [detail, setDetail] = useState<UiRecipeDetailResponse | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [notFound, setNotFound] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [checkedIds, setCheckedIds] = useState<ReadonlySet<string>>(() => new Set());
  const [activePhoto, setActivePhoto] = useState<UiRecipePhoto | null>(null);

  useEffect(() => {
    if (!slug) {
      setNotFound(true);
      setLoading(false);
      return undefined;
    }
    const controller = new AbortController();
    let cancelled = false;
    setLoading(true);
    setNotFound(false);
    setError(null);
    setCheckedIds(new Set());
    setActivePhoto(null);

    void client
      .getRecipe(slug, { signal: controller.signal })
      .then((res) => {
        if (cancelled) {
          return;
        }
        if (res === null) {
          setNotFound(true);
          setDetail(null);
        } else {
          setDetail(res);
        }
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (cancelled) {
          return;
        }
        setError(err instanceof Error ? err.message : 'Unable to load this recipe.');
        setLoading(false);
      });

    return (): void => {
      cancelled = true;
      controller.abort();
    };
  }, [client, slug]);

  const ingredientGroups = useMemo(
    () => (detail ? groupRecipeIngredients(detail.recipe.ingredients) : []),
    [detail]
  );

  const toggleIngredient = (id: string): void => {
    setCheckedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const handlePrint = (): void => {
    if (typeof window !== 'undefined' && typeof window.print === 'function') {
      window.print();
    }
  };

  const resolvedAncestor = useMemo(() => {
    const raw = detail?.recipe.attributed_person ?? null;
    if (!raw) {
      return null;
    }
    if (bundle) {
      const verified = getDeceasedPersonById(raw.id);
      if (!verified) {
        return null;
      }
      return { id: verified.id, slug: verified.slug, full_name: verified.full_name };
    }
    return raw;
  }, [detail, bundle, getDeceasedPersonById]);

  return (
    <div>
      <div className={cx(recipeStyles, 'recipe-print-hide')}>
        <ExplorerTopBar />
      </div>
      <ArchivalPageShell variant="standard">
        <div className={cx(recipeStyles, 'recipe-detail-topbar recipe-print-hide')}>
          <Link to={basePath} className={cx(recipeStyles, 'recipe-back-link')}>
            ← Back to Recipe Box
          </Link>
          {detail && (
            <button type="button" className={cx(recipeStyles, 'recipe-action-btn')} onClick={handlePrint}>
              Print Recipe Card
            </button>
          )}
        </div>

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
            Loading recipe card…
          </output>
        )}

        {!loading && notFound && (
          <ArchivalEmptyState
            title="Recipe not found"
            description="This recipe card does not exist or is no longer available in this archive."
            action={
              <Link to={basePath} className={cx(recipeStyles, 'recipe-back-link')}>
                Return to Family Recipe Box
              </Link>
            }
          />
        )}

        {!loading && detail && (
          <article className={cx(recipeStyles, 'recipe-detail-card')}>
            <header className={cx(recipeStyles, 'recipe-detail-header')}>
              <div className={cx(recipeStyles, 'recipe-detail-kicker')}>
                <span className={cx(recipeStyles, 'recipe-course-badge')}>
                  {formatRecipeCourseLabel(detail.recipe.course)}
                </span>
                {detail.recipe.source_era && (
                  <span className={cx(recipeStyles, 'recipe-era-label')}>{detail.recipe.source_era}</span>
                )}
                {resolvedAncestor && (
                  <Link
                    to={`/person/${encodeURIComponent(resolvedAncestor.slug)}`}
                    className={cx(recipeStyles, 'recipe-ancestor-chip')}
                  >
                    Attributed to {resolvedAncestor.full_name}
                  </Link>
                )}
              </div>

              <h1 className={cx(recipeStyles, 'recipe-detail-title')}>{detail.recipe.title}</h1>

              {detail.recipe.summary && (
                <p className={cx(recipeStyles, 'recipe-detail-summary')}>{detail.recipe.summary}</p>
              )}

              {detail.recipe.provenance_note && (
                <p className={cx(recipeStyles, 'recipe-provenance-box')}>
                  <strong>Provenance:</strong> {detail.recipe.provenance_note}
                </p>
              )}
            </header>

            <div className={cx(recipeStyles, 'recipe-meta-strip')}>
              {detail.recipe.prep_minutes !== null && (
                <div className={cx(recipeStyles, 'recipe-meta-cell')}>
                  <span className={cx(recipeStyles, 'recipe-meta-label')}>Prep</span>
                  <span className={cx(recipeStyles, 'recipe-meta-value')}>
                    {formatRecipeDuration(detail.recipe.prep_minutes)}
                  </span>
                </div>
              )}
              {detail.recipe.cook_minutes !== null && (
                <div className={cx(recipeStyles, 'recipe-meta-cell')}>
                  <span className={cx(recipeStyles, 'recipe-meta-label')}>Cook</span>
                  <span className={cx(recipeStyles, 'recipe-meta-value')}>
                    {formatRecipeDuration(detail.recipe.cook_minutes)}
                  </span>
                </div>
              )}
              {formatTotalRecipeDuration(detail.recipe.prep_minutes, detail.recipe.cook_minutes) && (
                <div className={cx(recipeStyles, 'recipe-meta-cell')}>
                  <span className={cx(recipeStyles, 'recipe-meta-label')}>Total Time</span>
                  <span className={cx(recipeStyles, 'recipe-meta-value')}>
                    {formatTotalRecipeDuration(detail.recipe.prep_minutes, detail.recipe.cook_minutes)}
                  </span>
                </div>
              )}
              {detail.recipe.servings && (
                <div className={cx(recipeStyles, 'recipe-meta-cell')}>
                  <span className={cx(recipeStyles, 'recipe-meta-label')}>Yield</span>
                  <span className={cx(recipeStyles, 'recipe-meta-value')}>{detail.recipe.servings}</span>
                </div>
              )}
              <div className={cx(recipeStyles, 'recipe-meta-cell')}>
                <span className={cx(recipeStyles, 'recipe-meta-label')}>Favorites</span>
                <span className={cx(recipeStyles, 'recipe-meta-value')}>
                  {detail.recipe.star_count} {detail.recipe.star_count === 1 ? 'star' : 'stars'}
                </span>
              </div>
            </div>

            {detail.photos.length > 0 && (
              <section aria-label="Recipe card photographs" className={cx(recipeStyles, 'recipe-gallery')}>
                {detail.photos.map((photo) => (
                  <button
                    key={photo.id}
                    type="button"
                    className={cx(recipeStyles, 'recipe-gallery-btn')}
                    onClick={() => {
                      setActivePhoto(photo);
                    }}
                  >
                    <img
                      src={photo.url}
                      alt={
                        photo.caption ||
                        `${detail.recipe.title} (${UI_RECIPE_CARD_SIDE_LABELS[photo.card_side]})`
                      }
                      loading="lazy"
                      className={cx(recipeStyles, 'recipe-gallery-thumb')}
                    />
                    <span className={cx(recipeStyles, 'recipe-gallery-caption')}>
                      {photo.caption || UI_RECIPE_CARD_SIDE_LABELS[photo.card_side]}
                    </span>
                  </button>
                ))}
              </section>
            )}

            <div className={cx(recipeStyles, 'recipe-detail-columns')}>
              <section aria-labelledby="recipe-ingredients-heading">
                <h2 id="recipe-ingredients-heading" className={cx(recipeStyles, 'recipe-section-heading')}>
                  Ingredients
                </h2>
                {ingredientGroups.length === 0 ? (
                  <p className={cx(recipeStyles, 'recipe-era-label')}>
                    No structured ingredients recorded yet.
                  </p>
                ) : (
                  ingredientGroups.map((group) => (
                    <div
                      key={group.group || 'default'}
                      className={cx(recipeStyles, 'recipe-ingredient-group')}
                    >
                      {group.group && (
                        <h3 className={cx(recipeStyles, 'recipe-ingredient-group-title')}>{group.group}</h3>
                      )}
                      <div className={cx(recipeStyles, 'recipe-checklist')}>
                        {group.items.map((ing) => {
                          const checked = checkedIds.has(ing.id);
                          return (
                            <label key={ing.id} className={cx(recipeStyles, 'recipe-checklist-item')}>
                              <input
                                type="checkbox"
                                className={cx(recipeStyles, 'recipe-checklist-input')}
                                checked={checked}
                                onChange={() => {
                                  toggleIngredient(ing.id);
                                }}
                              />
                              <span
                                className={
                                  checked ? cx(recipeStyles, 'recipe-checklist-text-done') : undefined
                                }
                              >
                                {formatRecipeIngredientLine(ing)}
                              </span>
                            </label>
                          );
                        })}
                      </div>
                    </div>
                  ))
                )}
              </section>

              <section aria-labelledby="recipe-steps-heading">
                <h2 id="recipe-steps-heading" className={cx(recipeStyles, 'recipe-section-heading')}>
                  Preparation Steps
                </h2>
                {detail.recipe.steps.length === 0 ? (
                  <p className={cx(recipeStyles, 'recipe-era-label')}>No preparation steps recorded yet.</p>
                ) : (
                  <ol className={cx(recipeStyles, 'recipe-steps-list')}>
                    {detail.recipe.steps.map((step, index) => (
                      <li key={step.id} className={cx(recipeStyles, 'recipe-step-item')}>
                        <span className={cx(recipeStyles, 'recipe-step-number')} aria-hidden="true">
                          {index + 1}
                        </span>
                        <div>
                          <p className={cx(recipeStyles, 'recipe-step-instruction')}>{step.instruction}</p>
                          {step.note && <p className={cx(recipeStyles, 'recipe-step-note')}>{step.note}</p>}
                        </div>
                      </li>
                    ))}
                  </ol>
                )}
              </section>
            </div>

            {detail.recipe.story_md.trim().length > 0 && (
              <section
                aria-labelledby="recipe-story-heading"
                className={cx(recipeStyles, 'recipe-story-section')}
              >
                <h2 id="recipe-story-heading" className={cx(recipeStyles, 'recipe-section-heading')}>
                  Family Story & Notes
                </h2>
                <ArchivalMarkdown markdown={detail.recipe.story_md} />
              </section>
            )}

            <footer className={cx(recipeStyles, 'recipe-detail-footer')}>
              <div className={cx(recipeStyles, 'recipe-card-tags recipe-print-hide')}>
                {detail.recipe.tags.map((t) => (
                  <Link
                    key={t}
                    to={`${basePath}?tag=${encodeURIComponent(t)}`}
                    style={{ textDecoration: 'none' }}
                  >
                    <ArchivalTagPill label={`#${t}`} />
                  </Link>
                ))}
              </div>
              <span>
                Transcribed by {detail.recipe.created_by_name}
                {detail.recipe.updated_by_name &&
                detail.recipe.updated_by_name !== detail.recipe.created_by_name
                  ? ` · Updated by ${detail.recipe.updated_by_name}`
                  : ''}
              </span>
            </footer>
          </article>
        )}

        <ArchivalModal
          open={activePhoto !== null}
          title={
            activePhoto
              ? activePhoto.caption || UI_RECIPE_CARD_SIDE_LABELS[activePhoto.card_side]
              : 'Recipe photo'
          }
          onClose={() => {
            setActivePhoto(null);
          }}
        >
          {activePhoto && (
            <div>
              <img
                src={activePhoto.url}
                alt={activePhoto.caption || UI_RECIPE_CARD_SIDE_LABELS[activePhoto.card_side]}
                className={cx(recipeStyles, 'recipe-modal-image')}
              />
              <p className={cx(recipeStyles, 'recipe-modal-meta')}>
                {UI_RECIPE_CARD_SIDE_LABELS[activePhoto.card_side]} · Uploaded by{' '}
                {activePhoto.uploaded_by_name}
              </p>
            </div>
          )}
        </ArchivalModal>
      </ArchivalPageShell>
      <div className={cx(recipeStyles, 'recipe-print-hide')}>
        <KinloomFooter />
      </div>
    </div>
  );
};
