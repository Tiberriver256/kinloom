import type React from 'react';
import { useEffect, useId, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArchivalFileDropzone } from '../../components/ArchivalFileDropzone.js';
import { ArchivalPageShell } from '../../components/ArchivalLayout.js';
import { ArchivalLightbox, type ArchivalLightboxItem } from '../../components/ArchivalLightbox.js';
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
  computeOptimisticStarState,
  formatRecipeCourseLabel,
  formatRecipeDuration,
  formatRecipeIngredientLine,
  formatTotalRecipeDuration,
  groupRecipeIngredients,
  UI_RECIPE_CARD_SIDE_LABELS,
  UI_RECIPE_CARD_SIDES,
  type UiRecipeCardSide,
  type UiRecipeDetailResponse,
  type UiRecipePhoto,
} from '../../lib/recipesModel.js';
import { useKinloomPluginContext } from '../PluginContext.js';
import { RecipeStarButton } from './RecipeStarButton.js';
import recipeStyles from './Recipes.module.css';
import { useRecipesPlugin } from './RecipesContext.js';

type PhotoCardActionState =
  | { readonly kind: 'idle' }
  | {
      readonly kind: 'editing';
      readonly photoId: string;
      readonly caption: string;
      readonly cardSide: UiRecipeCardSide;
    }
  | { readonly kind: 'confirm_delete'; readonly photoId: string };

interface PhotoFeedbackBanner {
  readonly tone: 'success' | 'error';
  readonly message: string;
}

export const RecipeDetailPage: React.FC = () => {
  const { slug } = useParams<{ slug: string }>();
  const navigate = useNavigate();
  const { client, basePath } = useRecipesPlugin();
  const { bundle, getDeceasedPersonById } = useKinloomPluginContext();

  const captionInputId = useId();
  const cardSideSelectId = useId();

  const [detail, setDetail] = useState<UiRecipeDetailResponse | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [notFound, setNotFound] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [checkedIds, setCheckedIds] = useState<ReadonlySet<string>>(() => new Set());
  const [activePhotoIndex, setActivePhotoIndex] = useState<number | null>(null);
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState<boolean>(false);
  const [deletingRecipe, setDeletingRecipe] = useState<boolean>(false);
  const [starPending, setStarPending] = useState<boolean>(false);
  const [starError, setStarError] = useState<string | null>(null);

  const [uploadCaption, setUploadCaption] = useState<string>('');
  const [uploadCardSide, setUploadCardSide] = useState<UiRecipeCardSide>('front');
  const [uploadSetCover, setUploadSetCover] = useState<boolean>(false);
  const [uploading, setUploading] = useState<boolean>(false);
  const [uploadProgress, setUploadProgress] = useState<string | null>(null);
  const [photoBusyId, setPhotoBusyId] = useState<string | null>(null);
  const [photoAction, setPhotoAction] = useState<PhotoCardActionState>({ kind: 'idle' });
  const [photoFeedback, setPhotoFeedback] = useState<PhotoFeedbackBanner | null>(null);

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
    setActivePhotoIndex(null);
    setPhotoAction({ kind: 'idle' });
    setPhotoFeedback(null);
    setStarPending(false);
    setStarError(null);

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

  const lightboxItems = useMemo<readonly ArchivalLightboxItem[]>(() => {
    if (!detail) {
      return [];
    }
    return detail.photos.map((photo) => {
      const sideLabel = UI_RECIPE_CARD_SIDE_LABELS[photo.card_side];
      const dimensions =
        photo.width !== null && photo.height !== null ? ` · ${photo.width}×${photo.height}` : '';
      return {
        id: photo.id,
        url: photo.url,
        alt: photo.caption || `${detail.recipe.title} (${sideLabel})`,
        caption: photo.caption || sideLabel,
        meta: `${sideLabel}${dimensions} · Uploaded by ${photo.uploaded_by_name}`,
      };
    });
  }, [detail]);

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

  const canEditRecipe = Boolean(detail?.permissions.can_edit && client.updateRecipe);
  const canDeleteRecipe = Boolean(detail?.permissions.can_delete && client.deleteRecipe);
  const canManagePhotos = Boolean(detail?.permissions.can_upload && client.uploadRecipePhoto);
  const canStarRecipe = Boolean(detail?.permissions.can_star && client.starRecipe && client.unstarRecipe);

  const handleToggleStar = async (): Promise<void> => {
    if (!detail || !canStarRecipe || !client.starRecipe || !client.unstarRecipe || starPending) {
      return;
    }
    const prevStarred = detail.viewer_has_starred;
    const prevCount = detail.recipe.star_count;
    const targetStarred = !prevStarred;
    const optimistic = computeOptimisticStarState(
      { star_count: prevCount, viewer_has_starred: prevStarred },
      targetStarred
    );

    setStarPending(true);
    setStarError(null);
    setDetail((prev) =>
      prev
        ? {
            ...prev,
            viewer_has_starred: optimistic.viewer_has_starred,
            recipe: {
              ...prev.recipe,
              star_count: optimistic.star_count,
              viewer_has_starred: optimistic.viewer_has_starred,
            },
          }
        : prev
    );

    try {
      const result = targetStarred
        ? await client.starRecipe(detail.recipe.slug)
        : await client.unstarRecipe(detail.recipe.slug);
      setDetail((prev) =>
        prev
          ? {
              ...prev,
              viewer_has_starred: result.viewer_has_starred,
              recipe: {
                ...prev.recipe,
                star_count: result.star_count,
                viewer_has_starred: result.viewer_has_starred,
              },
            }
          : prev
      );
    } catch (err: unknown) {
      setDetail((prev) =>
        prev
          ? {
              ...prev,
              viewer_has_starred: prevStarred,
              recipe: {
                ...prev.recipe,
                star_count: prevCount,
                viewer_has_starred: prevStarred,
              },
            }
          : prev
      );
      setStarError(err instanceof Error ? err.message : 'Unable to update recipe star right now.');
    } finally {
      setStarPending(false);
    }
  };

  const handleConfirmDeleteRecipe = async (): Promise<void> => {
    if (!detail || !client.deleteRecipe || deletingRecipe) {
      return;
    }
    setDeletingRecipe(true);
    setError(null);
    try {
      await client.deleteRecipe(detail.recipe.slug);
      setConfirmDeleteOpen(false);
      void navigate(basePath);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Unable to delete this recipe.');
      setConfirmDeleteOpen(false);
    } finally {
      setDeletingRecipe(false);
    }
  };
  const maxPhotoMb = detail?.media_limits?.max_photo_mb ?? 10;
  const maxPhotosPerRecipe = detail?.media_limits?.max_photos_per_recipe ?? 12;
  const remainingPhotoSlots = detail ? Math.max(0, maxPhotosPerRecipe - detail.photos.length) : 0;

  const handleUploadFiles = async (files: readonly File[]): Promise<void> => {
    if (!detail || !client.uploadRecipePhoto || files.length === 0) {
      return;
    }
    const targetSlug = detail.recipe.slug;
    const filesToUpload = files.slice(0, Math.max(1, remainingPhotoSlots));
    setUploading(true);
    setPhotoFeedback(null);

    let uploadedCount = 0;
    const failureMessages: string[] = [];

    for (let i = 0; i < filesToUpload.length; i += 1) {
      const file = filesToUpload[i];
      setUploadProgress(
        filesToUpload.length > 1
          ? `Uploading photo ${i + 1} of ${filesToUpload.length} (${file.name})…`
          : `Uploading ${file.name}…`
      );
      try {
        const res = await client.uploadRecipePhoto(targetSlug, {
          file,
          caption: uploadCaption.trim(),
          card_side: uploadCardSide,
          set_cover: i === 0 && uploadSetCover,
        });
        uploadedCount += 1;
        setDetail((prev) => {
          if (!prev) {
            return prev;
          }
          return {
            ...prev,
            recipe: {
              ...prev.recipe,
              cover_photo_id: res.cover_photo_id,
              cover_photo_url: res.cover_photo_url ?? prev.recipe.cover_photo_url,
            },
            photos: [...prev.photos, res.photo],
          };
        });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'Upload failed.';
        failureMessages.push(`${file.name}: ${msg}`);
      }
    }

    setUploading(false);
    setUploadProgress(null);

    if (uploadedCount > 0) {
      setUploadCaption('');
      setUploadSetCover(false);
    }

    if (failureMessages.length > 0) {
      setPhotoFeedback({
        tone: 'error',
        message:
          uploadedCount > 0
            ? `Uploaded ${uploadedCount} photo(s), but failed on: ${failureMessages.join(' ')}`
            : failureMessages.join(' '),
      });
    } else if (uploadedCount > 0) {
      setPhotoFeedback({
        tone: 'success',
        message:
          uploadedCount === 1
            ? 'Recipe card photo uploaded.'
            : `Uploaded ${uploadedCount} recipe card photos.`,
      });
    }
  };

  const handleSetCover = async (photo: UiRecipePhoto): Promise<void> => {
    if (!detail || !client.updateRecipePhoto) {
      return;
    }
    setPhotoBusyId(photo.id);
    setPhotoFeedback(null);
    try {
      const res = await client.updateRecipePhoto(detail.recipe.slug, photo.id, { set_cover: true });
      setDetail((prev) =>
        prev
          ? {
              ...prev,
              recipe: {
                ...prev.recipe,
                cover_photo_id: res.cover_photo_id,
                cover_photo_url: res.cover_photo_url ?? res.photo.url,
              },
              photos: prev.photos.map((p) => (p.id === res.photo.id ? res.photo : p)),
            }
          : prev
      );
      setPhotoFeedback({ tone: 'success', message: 'Primary cover photo updated.' });
    } catch (err: unknown) {
      setPhotoFeedback({
        tone: 'error',
        message: err instanceof Error ? err.message : 'Unable to set cover photo.',
      });
    } finally {
      setPhotoBusyId(null);
    }
  };

  const handleSavePhotoEdit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (!detail || !client.updateRecipePhoto || photoAction.kind !== 'editing') {
      return;
    }
    const { photoId, caption, cardSide } = photoAction;
    setPhotoBusyId(photoId);
    setPhotoFeedback(null);
    try {
      const res = await client.updateRecipePhoto(detail.recipe.slug, photoId, {
        caption: caption.trim(),
        card_side: cardSide,
      });
      setDetail((prev) =>
        prev
          ? {
              ...prev,
              photos: prev.photos.map((p) => (p.id === res.photo.id ? res.photo : p)),
            }
          : prev
      );
      setPhotoAction({ kind: 'idle' });
      setPhotoFeedback({ tone: 'success', message: 'Photo details saved.' });
    } catch (err: unknown) {
      setPhotoFeedback({
        tone: 'error',
        message: err instanceof Error ? err.message : 'Unable to save photo details.',
      });
    } finally {
      setPhotoBusyId(null);
    }
  };

  const handleMovePhoto = async (index: number, delta: -1 | 1): Promise<void> => {
    if (!detail || !client.reorderRecipePhotos) {
      return;
    }
    const nextIndex = index + delta;
    if (nextIndex < 0 || nextIndex >= detail.photos.length) {
      return;
    }
    const reorderedIds = detail.photos.map((p) => p.id);
    const [moved] = reorderedIds.splice(index, 1);
    if (!moved) {
      return;
    }
    reorderedIds.splice(nextIndex, 0, moved);

    setPhotoBusyId(moved);
    setPhotoFeedback(null);
    try {
      const res = await client.reorderRecipePhotos(detail.recipe.slug, reorderedIds);
      setDetail((prev) => (prev ? { ...prev, photos: [...res.photos] } : prev));
    } catch (err: unknown) {
      setPhotoFeedback({
        tone: 'error',
        message: err instanceof Error ? err.message : 'Unable to reorder recipe photos.',
      });
    } finally {
      setPhotoBusyId(null);
    }
  };

  const handleConfirmDeletePhoto = async (photoId: string): Promise<void> => {
    if (!detail || !client.deleteRecipePhoto) {
      return;
    }
    setPhotoBusyId(photoId);
    setPhotoFeedback(null);
    try {
      await client.deleteRecipePhoto(detail.recipe.slug, photoId);
      setDetail((prev) => {
        if (!prev) {
          return prev;
        }
        const remaining = prev.photos.filter((p) => p.id !== photoId);
        const nextCover =
          prev.recipe.cover_photo_id === photoId ? (remaining[0]?.id ?? null) : prev.recipe.cover_photo_id;
        const nextCoverPhoto = nextCover ? (remaining.find((p) => p.id === nextCover) ?? null) : null;
        return {
          ...prev,
          recipe: {
            ...prev.recipe,
            cover_photo_id: nextCover,
            cover_photo_url: nextCoverPhoto?.url ?? null,
          },
          photos: remaining,
        };
      });
      setActivePhotoIndex(null);
      setPhotoAction({ kind: 'idle' });
      setPhotoFeedback({ tone: 'success', message: 'Recipe card photo deleted.' });
    } catch (err: unknown) {
      setPhotoFeedback({
        tone: 'error',
        message: err instanceof Error ? err.message : 'Unable to delete photo.',
      });
    } finally {
      setPhotoBusyId(null);
    }
  };

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
            <div className={cx(recipeStyles, 'recipe-detail-actions')}>
              <RecipeStarButton
                recipeTitle={detail.recipe.title}
                starCount={detail.recipe.star_count}
                starred={detail.viewer_has_starred}
                canStar={canStarRecipe}
                pending={starPending}
                variant="detail"
                onToggle={() => {
                  void handleToggleStar();
                }}
              />
              {canEditRecipe && (
                <Link
                  to={`${basePath}/${encodeURIComponent(detail.recipe.slug)}/edit`}
                  className={cx(recipeStyles, 'recipe-primary-btn')}
                >
                  Edit Recipe
                </Link>
              )}
              {canDeleteRecipe && (
                <button
                  type="button"
                  className={cx(recipeStyles, 'recipe-action-btn recipe-action-btn-danger')}
                  onClick={() => {
                    setConfirmDeleteOpen(true);
                  }}
                >
                  Delete Recipe
                </button>
              )}
              <button type="button" className={cx(recipeStyles, 'recipe-action-btn')} onClick={handlePrint}>
                Print Recipe Card
              </button>
            </div>
          )}
        </div>

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

            {(detail.photos.length > 0 || canManagePhotos) && (
              <section
                aria-label="Recipe card photographs"
                className={cx(recipeStyles, 'recipe-photos-section')}
              >
                {photoFeedback && (
                  <ArchivalToast
                    tone={photoFeedback.tone}
                    message={photoFeedback.message}
                    onDismiss={() => {
                      setPhotoFeedback(null);
                    }}
                  />
                )}

                {detail.photos.length > 0 && (
                  <div className={cx(recipeStyles, 'recipe-gallery')}>
                    {detail.photos.map((photo, index) => {
                      const isCover = detail.recipe.cover_photo_id === photo.id;
                      const isBusy = photoBusyId === photo.id;
                      const isEditing = photoAction.kind === 'editing' && photoAction.photoId === photo.id;
                      const isConfirmingDelete =
                        photoAction.kind === 'confirm_delete' && photoAction.photoId === photo.id;

                      return (
                        <figure key={photo.id} className={cx(recipeStyles, 'recipe-gallery-card')}>
                          <button
                            type="button"
                            className={cx(recipeStyles, 'recipe-gallery-btn')}
                            onClick={() => {
                              setActivePhotoIndex(index);
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
                            <figcaption className={cx(recipeStyles, 'recipe-gallery-caption')}>
                              <span className={cx(recipeStyles, 'recipe-gallery-badges')}>
                                <span className={cx(recipeStyles, 'recipe-photo-side-badge')}>
                                  {UI_RECIPE_CARD_SIDE_LABELS[photo.card_side]}
                                </span>
                                {isCover && (
                                  <span className={cx(recipeStyles, 'recipe-photo-cover-badge')}>Cover</span>
                                )}
                              </span>
                              <span>{photo.caption || UI_RECIPE_CARD_SIDE_LABELS[photo.card_side]}</span>
                            </figcaption>
                          </button>

                          {canManagePhotos && (
                            <div className={cx(recipeStyles, 'recipe-photo-controls recipe-print-hide')}>
                              {isEditing ? (
                                <form
                                  className={cx(recipeStyles, 'recipe-photo-edit-form')}
                                  onSubmit={(e) => {
                                    void handleSavePhotoEdit(e);
                                  }}
                                >
                                  <input
                                    type="text"
                                    aria-label="Photo caption"
                                    maxLength={240}
                                    value={photoAction.caption}
                                    placeholder="Caption (e.g. Front of handwritten card)"
                                    className={cx(recipeStyles, 'recipe-filter-input')}
                                    onChange={(e) => {
                                      setPhotoAction({
                                        kind: 'editing',
                                        photoId: photo.id,
                                        caption: e.target.value,
                                        cardSide: photoAction.cardSide,
                                      });
                                    }}
                                  />
                                  <select
                                    aria-label="Card side"
                                    value={photoAction.cardSide}
                                    className={cx(recipeStyles, 'recipe-filter-select')}
                                    onChange={(e) => {
                                      setPhotoAction({
                                        kind: 'editing',
                                        photoId: photo.id,
                                        caption: photoAction.caption,
                                        cardSide: e.target.value as UiRecipeCardSide,
                                      });
                                    }}
                                  >
                                    {UI_RECIPE_CARD_SIDES.map((side) => (
                                      <option key={side} value={side}>
                                        {UI_RECIPE_CARD_SIDE_LABELS[side]}
                                      </option>
                                    ))}
                                  </select>
                                  <div className={cx(recipeStyles, 'recipe-photo-action-row')}>
                                    <button
                                      type="submit"
                                      disabled={isBusy}
                                      className={cx(recipeStyles, 'recipe-photo-mini-btn')}
                                    >
                                      Save
                                    </button>
                                    <button
                                      type="button"
                                      disabled={isBusy}
                                      className={cx(recipeStyles, 'recipe-photo-mini-btn')}
                                      onClick={() => {
                                        setPhotoAction({ kind: 'idle' });
                                      }}
                                    >
                                      Cancel
                                    </button>
                                  </div>
                                </form>
                              ) : isConfirmingDelete ? (
                                <div className={cx(recipeStyles, 'recipe-photo-action-row')}>
                                  <button
                                    type="button"
                                    disabled={isBusy}
                                    className={cx(
                                      recipeStyles,
                                      'recipe-photo-mini-btn recipe-photo-mini-btn-danger'
                                    )}
                                    onClick={() => {
                                      void handleConfirmDeletePhoto(photo.id);
                                    }}
                                  >
                                    Confirm Delete
                                  </button>
                                  <button
                                    type="button"
                                    disabled={isBusy}
                                    className={cx(recipeStyles, 'recipe-photo-mini-btn')}
                                    onClick={() => {
                                      setPhotoAction({ kind: 'idle' });
                                    }}
                                  >
                                    Cancel
                                  </button>
                                </div>
                              ) : (
                                <div className={cx(recipeStyles, 'recipe-photo-action-row')}>
                                  {!isCover && (
                                    <button
                                      type="button"
                                      disabled={isBusy}
                                      className={cx(recipeStyles, 'recipe-photo-mini-btn')}
                                      onClick={() => {
                                        void handleSetCover(photo);
                                      }}
                                    >
                                      Set Cover
                                    </button>
                                  )}
                                  {detail.photos.length > 1 && (
                                    <>
                                      <button
                                        type="button"
                                        disabled={isBusy || index === 0}
                                        aria-label={`Move photo ${index + 1} earlier`}
                                        className={cx(recipeStyles, 'recipe-photo-mini-btn')}
                                        onClick={() => {
                                          void handleMovePhoto(index, -1);
                                        }}
                                      >
                                        ←
                                      </button>
                                      <button
                                        type="button"
                                        disabled={isBusy || index === detail.photos.length - 1}
                                        aria-label={`Move photo ${index + 1} later`}
                                        className={cx(recipeStyles, 'recipe-photo-mini-btn')}
                                        onClick={() => {
                                          void handleMovePhoto(index, 1);
                                        }}
                                      >
                                        →
                                      </button>
                                    </>
                                  )}
                                  <button
                                    type="button"
                                    disabled={isBusy}
                                    className={cx(recipeStyles, 'recipe-photo-mini-btn')}
                                    onClick={() => {
                                      setPhotoAction({
                                        kind: 'editing',
                                        photoId: photo.id,
                                        caption: photo.caption,
                                        cardSide: photo.card_side,
                                      });
                                    }}
                                  >
                                    Edit
                                  </button>
                                  <button
                                    type="button"
                                    disabled={isBusy}
                                    className={cx(
                                      recipeStyles,
                                      'recipe-photo-mini-btn recipe-photo-mini-btn-danger'
                                    )}
                                    onClick={() => {
                                      setPhotoAction({ kind: 'confirm_delete', photoId: photo.id });
                                    }}
                                  >
                                    Delete
                                  </button>
                                </div>
                              )}
                            </div>
                          )}
                        </figure>
                      );
                    })}
                  </div>
                )}

                {canManagePhotos && (
                  <div className={cx(recipeStyles, 'recipe-upload-panel recipe-print-hide')}>
                    <div className={cx(recipeStyles, 'recipe-upload-fields')}>
                      <div className={cx(recipeStyles, 'recipe-filter-field')}>
                        <label htmlFor={captionInputId} className={cx(recipeStyles, 'recipe-filter-label')}>
                          Photo Caption (Optional)
                        </label>
                        <input
                          id={captionInputId}
                          type="text"
                          maxLength={240}
                          value={uploadCaption}
                          placeholder="e.g. Front of handwritten card"
                          className={cx(recipeStyles, 'recipe-filter-input')}
                          disabled={uploading || remainingPhotoSlots === 0}
                          onChange={(e) => {
                            setUploadCaption(e.target.value);
                          }}
                        />
                      </div>

                      <div className={cx(recipeStyles, 'recipe-filter-field')}>
                        <label htmlFor={cardSideSelectId} className={cx(recipeStyles, 'recipe-filter-label')}>
                          Card Side
                        </label>
                        <select
                          id={cardSideSelectId}
                          value={uploadCardSide}
                          className={cx(recipeStyles, 'recipe-filter-select')}
                          disabled={uploading || remainingPhotoSlots === 0}
                          onChange={(e) => {
                            setUploadCardSide(e.target.value as UiRecipeCardSide);
                          }}
                        >
                          {UI_RECIPE_CARD_SIDES.map((side) => (
                            <option key={side} value={side}>
                              {UI_RECIPE_CARD_SIDE_LABELS[side]}
                            </option>
                          ))}
                        </select>
                      </div>

                      <label className={cx(recipeStyles, 'recipe-upload-cover-check')}>
                        <input
                          type="checkbox"
                          checked={uploadSetCover}
                          disabled={uploading || remainingPhotoSlots === 0}
                          onChange={(e) => {
                            setUploadSetCover(e.target.checked);
                          }}
                        />
                        <span>Set as cover photo</span>
                      </label>
                    </div>

                    <ArchivalFileDropzone
                      label="Add recipe card photos"
                      hint={
                        remainingPhotoSlots === 0
                          ? `Maximum of ${maxPhotosPerRecipe} photos reached for this recipe.`
                          : `JPEG, PNG, or WebP up to ${maxPhotoMb} MB each (${detail.photos.length}/${maxPhotosPerRecipe} used). Camera EXIF/GPS metadata is stripped automatically.`
                      }
                      maxBytes={maxPhotoMb * 1024 * 1024}
                      disabled={remainingPhotoSlots === 0}
                      busy={uploading}
                      progressLabel={uploadProgress}
                      onFilesAccepted={(accepted) => {
                        void handleUploadFiles(accepted);
                      }}
                      onFilesRejected={(errors) => {
                        setPhotoFeedback({ tone: 'error', message: errors.join(' ') });
                      }}
                    />
                  </div>
                )}
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

        <ArchivalLightbox
          items={lightboxItems}
          activeIndex={activePhotoIndex}
          onClose={() => {
            setActivePhotoIndex(null);
          }}
          onChangeIndex={(nextIdx) => {
            setActivePhotoIndex(nextIdx);
          }}
        />

        <ArchivalModal
          open={confirmDeleteOpen}
          title="Delete this recipe?"
          onClose={() => {
            if (!deletingRecipe) {
              setConfirmDeleteOpen(false);
            }
          }}
        >
          <p className={cx(recipeStyles, 'recipe-detail-summary')}>
            Remove <strong>{detail?.recipe.title ?? 'this recipe'}</strong> from the Family Recipe Box? This
            hides the recipe from the catalog.
          </p>
          <div className={cx(recipeStyles, 'recipe-conflict-actions')}>
            <button
              type="button"
              disabled={deletingRecipe}
              className={cx(recipeStyles, 'recipe-photo-mini-btn recipe-photo-mini-btn-danger')}
              onClick={() => {
                void handleConfirmDeleteRecipe();
              }}
            >
              {deletingRecipe ? 'Deleting…' : 'Confirm Delete'}
            </button>
            <button
              type="button"
              disabled={deletingRecipe}
              className={cx(recipeStyles, 'recipe-clear-btn')}
              onClick={() => {
                setConfirmDeleteOpen(false);
              }}
            >
              Cancel
            </button>
          </div>
        </ArchivalModal>
      </ArchivalPageShell>
      <div className={cx(recipeStyles, 'recipe-print-hide')}>
        <KinloomFooter />
      </div>
    </div>
  );
};
