import { isArchiveApiError } from '@kinloom/core';
import type React from 'react';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { ArchivalLightbox, type ArchivalLightboxItem } from '../../components/ArchivalLightbox.js';
import { ArchivalMarkdown } from '../../components/ArchivalMarkdown.js';
import {
  ArchivalModal,
  ArchivalTabs,
  ArchivalTagPill,
  ArchivalToast,
} from '../../components/ArchivalPrimitives.js';
import { ArchivalImage } from '../../components/Atoms.js';
import { cx } from '../../lib/cx.js';
import { formatArchivalTimestamp } from '../../lib/formatTimestamp.js';
import {
  addDraftTag,
  createEmptyIngredientDraft,
  createEmptyRecipeDraft,
  createEmptyStepDraft,
  extractRecipeApiFieldErrors,
  formatRecipeCourseLabel,
  isRecipeDraftDirty,
  moveDraftListItem,
  parseUiRecipeVersionConflict,
  type RecipeEditorDraft,
  recipeDetailToEditorDraft,
  removeDraftTag,
  UI_RECIPE_CARD_SIDE_LABELS,
  UI_RECIPE_COURSES,
  type UiCreateRecipePayload,
  type UiRecipeCourse,
  UiRecipeCourseSchema,
  type UiRecipeDetail,
  type UiRecipePhoto,
  type UiRecipeVersionConflictDetails,
  type UiUpdateRecipePayload,
  validateRecipeDraft,
} from '../../lib/recipesModel.js';
import { useKinloomPluginContext } from '../PluginContext.js';
import recipeStyles from './Recipes.module.css';

export interface RecipeEditorFormProps {
  readonly mode: 'create' | 'edit';
  readonly headingId: string;
  readonly initialRecipe?: UiRecipeDetail | null;
  readonly photos?: readonly UiRecipePhoto[];
  readonly onSubmitCreate?: (payload: UiCreateRecipePayload) => Promise<UiRecipeDetail>;
  readonly onSubmitUpdate?: (payload: UiUpdateRecipePayload) => Promise<UiRecipeDetail>;
  readonly onSaved: (recipe: UiRecipeDetail) => void;
  readonly onCancel: () => void;
}

export const RecipeEditorForm: React.FC<RecipeEditorFormProps> = ({
  mode,
  headingId,
  initialRecipe = null,
  photos = [],
  onSubmitCreate,
  onSubmitUpdate,
  onSaved,
  onCancel,
}) => {
  const { getDeceasedPersonById, searchDeceasedPeople } = useKinloomPluginContext();

  const titleInputId = useId();
  const slugInputId = useId();
  const courseSelectId = useId();
  const summaryInputId = useId();
  const prepInputId = useId();
  const cookInputId = useId();
  const servingsInputId = useId();
  const eraInputId = useId();
  const provenanceInputId = useId();
  const ancestorInputId = useId();
  const tagInputId = useId();
  const storyTextareaId = useId();

  const initialDraft = useMemo(
    () => (initialRecipe ? recipeDetailToEditorDraft(initialRecipe) : createEmptyRecipeDraft()),
    [initialRecipe]
  );

  const [baseline, setBaseline] = useState<RecipeEditorDraft>(initialDraft);
  const [draft, setDraft] = useState<RecipeEditorDraft>(initialDraft);
  const [expectedVersion, setExpectedVersion] = useState<number>(initialRecipe?.version ?? 1);
  const [fieldErrors, setFieldErrors] = useState<Readonly<Record<string, string>>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<UiRecipeVersionConflictDetails | null>(null);
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [storyTab, setStoryTab] = useState<'write' | 'preview'>('write');
  const [tagInput, setTagInput] = useState<string>('');
  const [tagError, setTagError] = useState<string | null>(null);
  const [ancestorQuery, setAncestorQuery] = useState<string>('');
  const [confirmDiscardOpen, setConfirmDiscardOpen] = useState<boolean>(false);
  const [selectedRefPhotoIdx, setSelectedRefPhotoIdx] = useState<number>(0);
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);

  const nextRowSeqRef = useRef<number>(100);
  const pendingFocusRef = useRef<string | null>(null);
  const titleInputRef = useRef<HTMLInputElement | null>(null);
  const slugInputRef = useRef<HTMLInputElement | null>(null);
  const prepInputRef = useRef<HTMLInputElement | null>(null);
  const cookInputRef = useRef<HTMLInputElement | null>(null);
  const ingredientItemRefs = useRef<Map<string, HTMLInputElement | null>>(new Map());
  const stepTextareaRefs = useRef<Map<string, HTMLTextAreaElement | null>>(new Map());

  useEffect(() => {
    setBaseline(initialDraft);
    setDraft(initialDraft);
    setExpectedVersion(initialRecipe?.version ?? 1);
    setFieldErrors({});
    setFormError(null);
    setConflict(null);
  }, [initialDraft, initialRecipe]);

  const isDirty = useMemo(() => isRecipeDraftDirty(draft, baseline), [draft, baseline]);

  useEffect(() => {
    if (!isDirty || typeof window === 'undefined') {
      return undefined;
    }
    const handleBeforeUnload = (event: BeforeUnloadEvent): void => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return (): void => {
      window.removeEventListener('beforeunload', handleBeforeUnload);
    };
  }, [isDirty]);

  useEffect(() => {
    const targetId = pendingFocusRef.current;
    if (!targetId) {
      return;
    }
    pendingFocusRef.current = null;
    const ingInput = ingredientItemRefs.current.get(targetId);
    if (ingInput) {
      ingInput.focus();
      return;
    }
    const stepInput = stepTextareaRefs.current.get(targetId);
    stepInput?.focus();
  });

  const selectedAncestor = useMemo(() => {
    if (!draft.attributed_person_id) {
      return null;
    }
    const fromBundle = getDeceasedPersonById(draft.attributed_person_id);
    if (fromBundle) {
      return { id: fromBundle.id, full_name: fromBundle.full_name };
    }
    if (
      initialRecipe?.attributed_person &&
      initialRecipe.attributed_person.id === draft.attributed_person_id
    ) {
      return {
        id: initialRecipe.attributed_person.id,
        full_name: initialRecipe.attributed_person.full_name,
      };
    }
    return null;
  }, [draft.attributed_person_id, getDeceasedPersonById, initialRecipe]);

  const ancestorMatches = useMemo(
    () => searchDeceasedPeople(ancestorQuery, 12),
    [ancestorQuery, searchDeceasedPeople]
  );

  const lightboxItems = useMemo<readonly ArchivalLightboxItem[]>(
    () =>
      photos.map((photo) => {
        const sideLabel = UI_RECIPE_CARD_SIDE_LABELS[photo.card_side];
        const dimensions =
          photo.width !== null && photo.height !== null ? ` · ${photo.width}×${photo.height}` : '';
        return {
          id: photo.id,
          url: photo.url,
          alt: photo.caption || `${draft.title || 'Recipe card'} (${sideLabel})`,
          caption: photo.caption || sideLabel,
          meta: `${sideLabel}${dimensions} · Uploaded by ${photo.uploaded_by_name}`,
        };
      }),
    [photos, draft.title]
  );

  const safeRefPhotoIdx = photos.length > 0 ? Math.min(selectedRefPhotoIdx, photos.length - 1) : 0;
  const activeRefPhoto = photos[safeRefPhotoIdx] ?? null;

  const clearFieldError = (key: string): void => {
    setFieldErrors((prev) => {
      if (!(key in prev)) {
        return prev;
      }
      const next = { ...prev };
      delete next[key];
      return next;
    });
  };

  const validateSingleFieldOnBlur = (key: string): void => {
    const check = validateRecipeDraft(draft);
    if (check.ok) {
      clearFieldError(key);
      return;
    }
    const err = check.fieldErrors[key];
    if (err) {
      setFieldErrors((prev) => ({ ...prev, [key]: err }));
    } else {
      clearFieldError(key);
    }
  };

  const focusFirstInvalidField = (errors: Readonly<Record<string, string>>): void => {
    if (errors['title']) {
      titleInputRef.current?.focus();
      return;
    }
    if (errors['slug']) {
      slugInputRef.current?.focus();
      return;
    }
    if (errors['prep_minutes']) {
      prepInputRef.current?.focus();
      return;
    }
    if (errors['cook_minutes']) {
      cookInputRef.current?.focus();
      return;
    }
    const firstKey = Object.keys(errors)[0];
    if (!firstKey) {
      return;
    }
    const ingMatch = /^ingredients\.(\d+)\.item$/.exec(firstKey);
    if (ingMatch) {
      const row = draft.ingredients[Number(ingMatch[1])];
      if (row) {
        ingredientItemRefs.current.get(row.id)?.focus();
      }
      return;
    }
    const stepMatch = /^steps\.(\d+)\.instruction$/.exec(firstKey);
    if (stepMatch) {
      const row = draft.steps[Number(stepMatch[1])];
      if (row) {
        stepTextareaRefs.current.get(row.id)?.focus();
      }
    }
  };

  const handleAddTag = (): void => {
    const next = addDraftTag(draft.tags, tagInput);
    if (next.error) {
      setTagError(next.error);
      return;
    }
    setDraft((prev) => ({ ...prev, tags: next.tags }));
    setTagInput('');
    setTagError(null);
    clearFieldError('tags');
  };

  const handleAddIngredient = (): void => {
    nextRowSeqRef.current += 1;
    const id = `ing_${nextRowSeqRef.current}`;
    pendingFocusRef.current = id;
    setDraft((prev) => ({
      ...prev,
      ingredients: [...prev.ingredients, createEmptyIngredientDraft(id)],
    }));
  };

  const handleAddStep = (): void => {
    nextRowSeqRef.current += 1;
    const id = `stp_${nextRowSeqRef.current}`;
    pendingFocusRef.current = id;
    setDraft((prev) => ({
      ...prev,
      steps: [...prev.steps, createEmptyStepDraft(id)],
    }));
  };

  const handleRequestCancel = (): void => {
    if (isDirty) {
      setConfirmDiscardOpen(true);
      return;
    }
    onCancel();
  };

  const handleReloadLatestFromConflict = (): void => {
    if (!conflict) {
      return;
    }
    const latestDraft = recipeDetailToEditorDraft(conflict.server_recipe);
    setBaseline(latestDraft);
    setDraft(latestDraft);
    setExpectedVersion(conflict.server_version);
    setConflict(null);
    setFormError(null);
    setFieldErrors({});
  };

  const handleKeepDraftOverLatest = (): void => {
    if (!conflict) {
      return;
    }
    setExpectedVersion(conflict.server_version);
    setConflict(null);
    setFormError(null);
  };

  const handleSubmit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (submitting) {
      return;
    }

    const validation = validateRecipeDraft(draft);
    if (!validation.ok) {
      setFieldErrors(validation.fieldErrors);
      setFormError(validation.summary);
      focusFirstInvalidField(validation.fieldErrors);
      return;
    }

    setSubmitting(true);
    setFormError(null);
    setFieldErrors({});
    setConflict(null);

    try {
      let saved: UiRecipeDetail;
      if (mode === 'create') {
        if (!onSubmitCreate) {
          throw new Error('Recipe creation is unavailable in this archive.');
        }
        saved = await onSubmitCreate(validation.payload);
      } else {
        if (!onSubmitUpdate) {
          throw new Error('Recipe editing is unavailable in this archive.');
        }
        saved = await onSubmitUpdate({
          ...validation.payload,
          expected_version: expectedVersion,
        });
      }
      const savedDraft = recipeDetailToEditorDraft(saved);
      setBaseline(savedDraft);
      setDraft(savedDraft);
      setExpectedVersion(saved.version);
      onSaved(saved);
    } catch (err: unknown) {
      if (isArchiveApiError(err)) {
        const apiMessage = err.message ?? 'Unable to save this recipe right now.';
        if (err.status === 409 && err.code === 'RECIPE_VERSION_CONFLICT') {
          const parsedConflict = parseUiRecipeVersionConflict(err.details);
          if (parsedConflict) {
            setConflict(parsedConflict);
            setFormError(null);
            return;
          }
        }
        if (err.status === 409 && err.code === 'RECIPE_SLUG_CONFLICT') {
          setFieldErrors({ slug: apiMessage });
          setFormError(apiMessage);
          slugInputRef.current?.focus();
          return;
        }
        if (err.status === 400) {
          const apiFields = extractRecipeApiFieldErrors(err.details);
          if (Object.keys(apiFields).length > 0) {
            setFieldErrors(apiFields);
          }
        }
        setFormError(apiMessage);
      } else {
        setFormError(err instanceof Error ? err.message : 'Unable to save this recipe right now.');
      }
    } finally {
      setSubmitting(false);
    }
  };

  const renderPhotoReferenceContent = (): React.ReactNode => {
    if (!activeRefPhoto) {
      return null;
    }
    const sideLabel = UI_RECIPE_CARD_SIDE_LABELS[activeRefPhoto.card_side];
    return (
      <div className={cx(recipeStyles, 'recipe-ref-card')}>
        <button
          type="button"
          className={cx(recipeStyles, 'recipe-ref-preview-btn')}
          onClick={() => {
            setLightboxIndex(safeRefPhotoIdx);
          }}
        >
          <ArchivalImage
            src={activeRefPhoto.url}
            alt={activeRefPhoto.caption || `${draft.title || 'Recipe card'} (${sideLabel})`}
            loading="eager"
            frameStyle={{ width: '100%' }}
            className={cx(recipeStyles, 'recipe-ref-image')}
            fallbackCaption={activeRefPhoto.caption || sideLabel}
          />
        </button>

        <div className={cx(recipeStyles, 'recipe-ref-meta')}>
          <span className={cx(recipeStyles, 'recipe-photo-side-badge')}>{sideLabel}</span>
          <span>{activeRefPhoto.caption || sideLabel}</span>
        </div>

        {photos.length > 1 && (
          <div
            className={cx(recipeStyles, 'recipe-ref-switcher')}
            role="group"
            aria-label="Switch reference card photo"
          >
            {photos.map((photo, idx) => (
              <button
                key={photo.id}
                type="button"
                aria-pressed={idx === safeRefPhotoIdx}
                className={cx(
                  recipeStyles,
                  idx === safeRefPhotoIdx
                    ? 'recipe-photo-mini-btn recipe-ref-tab-active'
                    : 'recipe-photo-mini-btn'
                )}
                onClick={() => {
                  setSelectedRefPhotoIdx(idx);
                }}
              >
                {idx + 1}. {UI_RECIPE_CARD_SIDE_LABELS[photo.card_side]}
              </button>
            ))}
          </div>
        )}

        <button
          type="button"
          className={cx(recipeStyles, 'recipe-clear-btn')}
          onClick={() => {
            setLightboxIndex(safeRefPhotoIdx);
          }}
        >
          Inspect full size (zoom & pan)
        </button>
      </div>
    );
  };

  return (
    <>
      <div
        className={cx(
          recipeStyles,
          photos.length > 0 ? 'recipe-editor-layout recipe-editor-layout-split' : 'recipe-editor-layout'
        )}
      >
        {photos.length > 0 && (
          <>
            <details className={cx(recipeStyles, 'recipe-ref-mobile-drawer')}>
              <summary className={cx(recipeStyles, 'recipe-ref-mobile-summary')}>
                Reference Card Photos ({photos.length}) — tap to view while transcribing
              </summary>
              <div className={cx(recipeStyles, 'recipe-ref-mobile-body')}>
                {renderPhotoReferenceContent()}
              </div>
            </details>

            <aside
              aria-label="Reference recipe card photographs"
              className={cx(recipeStyles, 'recipe-ref-sidebar')}
            >
              <h2 className={cx(recipeStyles, 'recipe-section-heading')}>Reference Card</h2>
              <p className={cx(recipeStyles, 'recipe-editor-hint')}>
                Transcribe directly beside the original scan. Click the image to zoom and pan.
              </p>
              {renderPhotoReferenceContent()}
            </aside>
          </>
        )}

        <form
          className={cx(recipeStyles, 'recipe-editor-form')}
          aria-labelledby={headingId}
          noValidate
          onSubmit={(e) => {
            void handleSubmit(e);
          }}
        >
          {conflict && (
            <div role="alert" className={cx(recipeStyles, 'recipe-conflict-banner')}>
              <h2 className={cx(recipeStyles, 'recipe-conflict-title')}>
                Newer version saved by {conflict.server_updated_by_name}
              </h2>
              <p className={cx(recipeStyles, 'recipe-conflict-body')}>
                Version {conflict.server_version} was saved on{' '}
                {formatArchivalTimestamp(conflict.server_updated_at)}. Your unsaved edits are still in the
                form below so nothing was lost.
              </p>
              <div className={cx(recipeStyles, 'recipe-conflict-actions')}>
                <button
                  type="button"
                  className={cx(recipeStyles, 'recipe-action-btn')}
                  onClick={handleReloadLatestFromConflict}
                >
                  Reload Latest Version
                </button>
                <button
                  type="button"
                  className={cx(recipeStyles, 'recipe-clear-btn')}
                  onClick={handleKeepDraftOverLatest}
                >
                  Keep My Edits & Save Over v{conflict.server_version}
                </button>
              </div>
            </div>
          )}

          {formError && (
            <ArchivalToast
              tone="error"
              message={formError}
              onDismiss={() => {
                setFormError(null);
              }}
            />
          )}

          <fieldset className={cx(recipeStyles, 'recipe-editor-fieldset')}>
            <legend className={cx(recipeStyles, 'recipe-editor-legend')}>Recipe Details</legend>

            <div className={cx(recipeStyles, 'recipe-editor-field')}>
              <label htmlFor={titleInputId} className={cx(recipeStyles, 'recipe-filter-label')}>
                Title <span aria-hidden="true">*</span>
              </label>
              <input
                ref={titleInputRef}
                id={titleInputId}
                name="title"
                type="text"
                required
                minLength={2}
                maxLength={140}
                value={draft.title}
                aria-invalid={fieldErrors['title'] ? 'true' : 'false'}
                aria-describedby={fieldErrors['title'] ? `${titleInputId}-error` : undefined}
                placeholder="e.g. Oatmeal Honey Biscuits"
                className={cx(recipeStyles, 'recipe-filter-input')}
                onChange={(e) => {
                  setDraft((prev) => ({ ...prev, title: e.target.value }));
                  clearFieldError('title');
                }}
                onBlur={() => {
                  validateSingleFieldOnBlur('title');
                }}
              />
              {fieldErrors['title'] && (
                <p id={`${titleInputId}-error`} className={cx(recipeStyles, 'recipe-field-error')}>
                  Error: {fieldErrors['title']}
                </p>
              )}
            </div>

            <div className={cx(recipeStyles, 'recipe-editor-row-2')}>
              <div className={cx(recipeStyles, 'recipe-editor-field')}>
                <label htmlFor={courseSelectId} className={cx(recipeStyles, 'recipe-filter-label')}>
                  Course
                </label>
                <select
                  id={courseSelectId}
                  name="course"
                  value={draft.course}
                  className={cx(recipeStyles, 'recipe-filter-select')}
                  onChange={(e) => {
                    const parsed = UiRecipeCourseSchema.safeParse(e.target.value);
                    if (parsed.success) {
                      setDraft((prev) => ({ ...prev, course: parsed.data as UiRecipeCourse }));
                    }
                  }}
                >
                  {UI_RECIPE_COURSES.map((c) => (
                    <option key={c} value={c}>
                      {formatRecipeCourseLabel(c)}
                    </option>
                  ))}
                </select>
              </div>

              <div className={cx(recipeStyles, 'recipe-editor-field')}>
                <label htmlFor={slugInputId} className={cx(recipeStyles, 'recipe-filter-label')}>
                  URL Slug (Optional)
                </label>
                <span id={`${slugInputId}-hint`} className={cx(recipeStyles, 'recipe-editor-hint')}>
                  Leave blank to generate automatically from the title.
                </span>
                <input
                  ref={slugInputRef}
                  id={slugInputId}
                  name="slug"
                  type="text"
                  maxLength={96}
                  autoCorrect="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  value={draft.slug}
                  aria-invalid={fieldErrors['slug'] ? 'true' : 'false'}
                  aria-describedby={
                    fieldErrors['slug'] ? `${slugInputId}-hint ${slugInputId}-error` : `${slugInputId}-hint`
                  }
                  placeholder="oatmeal-honey-biscuits"
                  className={cx(recipeStyles, 'recipe-filter-input')}
                  onChange={(e) => {
                    setDraft((prev) => ({ ...prev, slug: e.target.value }));
                    clearFieldError('slug');
                  }}
                  onBlur={() => {
                    validateSingleFieldOnBlur('slug');
                  }}
                />
                {fieldErrors['slug'] && (
                  <p id={`${slugInputId}-error`} className={cx(recipeStyles, 'recipe-field-error')}>
                    Error: {fieldErrors['slug']}
                  </p>
                )}
              </div>
            </div>

            <div className={cx(recipeStyles, 'recipe-editor-field')}>
              <label htmlFor={summaryInputId} className={cx(recipeStyles, 'recipe-filter-label')}>
                Short Summary
              </label>
              <textarea
                id={summaryInputId}
                name="summary"
                rows={2}
                maxLength={400}
                value={draft.summary}
                aria-invalid={fieldErrors['summary'] ? 'true' : 'false'}
                aria-describedby={fieldErrors['summary'] ? `${summaryInputId}-error` : undefined}
                placeholder="One-line description displayed on catalog cards."
                className={cx(recipeStyles, 'recipe-editor-textarea')}
                onChange={(e) => {
                  setDraft((prev) => ({ ...prev, summary: e.target.value }));
                  clearFieldError('summary');
                }}
              />
              {fieldErrors['summary'] && (
                <p id={`${summaryInputId}-error`} className={cx(recipeStyles, 'recipe-field-error')}>
                  Error: {fieldErrors['summary']}
                </p>
              )}
            </div>
          </fieldset>

          <fieldset className={cx(recipeStyles, 'recipe-editor-fieldset')}>
            <legend className={cx(recipeStyles, 'recipe-editor-legend')}>Timing, Yield & Provenance</legend>

            <div className={cx(recipeStyles, 'recipe-editor-row-3')}>
              <div className={cx(recipeStyles, 'recipe-editor-field')}>
                <label htmlFor={prepInputId} className={cx(recipeStyles, 'recipe-filter-label')}>
                  Prep Minutes
                </label>
                <input
                  ref={prepInputRef}
                  id={prepInputId}
                  name="prep_minutes"
                  type="text"
                  inputMode="numeric"
                  value={draft.prep_minutes}
                  aria-invalid={fieldErrors['prep_minutes'] ? 'true' : 'false'}
                  aria-describedby={fieldErrors['prep_minutes'] ? `${prepInputId}-error` : undefined}
                  placeholder="15"
                  className={cx(recipeStyles, 'recipe-filter-input')}
                  onChange={(e) => {
                    setDraft((prev) => ({ ...prev, prep_minutes: e.target.value }));
                    clearFieldError('prep_minutes');
                  }}
                  onBlur={() => {
                    validateSingleFieldOnBlur('prep_minutes');
                  }}
                />
                {fieldErrors['prep_minutes'] && (
                  <p id={`${prepInputId}-error`} className={cx(recipeStyles, 'recipe-field-error')}>
                    Error: {fieldErrors['prep_minutes']}
                  </p>
                )}
              </div>

              <div className={cx(recipeStyles, 'recipe-editor-field')}>
                <label htmlFor={cookInputId} className={cx(recipeStyles, 'recipe-filter-label')}>
                  Cook Minutes
                </label>
                <input
                  ref={cookInputRef}
                  id={cookInputId}
                  name="cook_minutes"
                  type="text"
                  inputMode="numeric"
                  value={draft.cook_minutes}
                  aria-invalid={fieldErrors['cook_minutes'] ? 'true' : 'false'}
                  aria-describedby={fieldErrors['cook_minutes'] ? `${cookInputId}-error` : undefined}
                  placeholder="25"
                  className={cx(recipeStyles, 'recipe-filter-input')}
                  onChange={(e) => {
                    setDraft((prev) => ({ ...prev, cook_minutes: e.target.value }));
                    clearFieldError('cook_minutes');
                  }}
                  onBlur={() => {
                    validateSingleFieldOnBlur('cook_minutes');
                  }}
                />
                {fieldErrors['cook_minutes'] && (
                  <p id={`${cookInputId}-error`} className={cx(recipeStyles, 'recipe-field-error')}>
                    Error: {fieldErrors['cook_minutes']}
                  </p>
                )}
              </div>

              <div className={cx(recipeStyles, 'recipe-editor-field')}>
                <label htmlFor={servingsInputId} className={cx(recipeStyles, 'recipe-filter-label')}>
                  Servings / Yield
                </label>
                <input
                  id={servingsInputId}
                  name="servings"
                  type="text"
                  maxLength={60}
                  value={draft.servings}
                  placeholder="12 biscuits"
                  className={cx(recipeStyles, 'recipe-filter-input')}
                  onChange={(e) => {
                    setDraft((prev) => ({ ...prev, servings: e.target.value }));
                  }}
                />
              </div>
            </div>

            <div className={cx(recipeStyles, 'recipe-editor-row-2')}>
              <div className={cx(recipeStyles, 'recipe-editor-field')}>
                <label htmlFor={eraInputId} className={cx(recipeStyles, 'recipe-filter-label')}>
                  Source Era
                </label>
                <input
                  id={eraInputId}
                  name="source_era"
                  type="text"
                  maxLength={60}
                  value={draft.source_era}
                  placeholder="e.g. c. 1940s"
                  className={cx(recipeStyles, 'recipe-filter-input')}
                  onChange={(e) => {
                    setDraft((prev) => ({ ...prev, source_era: e.target.value }));
                  }}
                />
              </div>

              <div className={cx(recipeStyles, 'recipe-editor-field')}>
                <label htmlFor={provenanceInputId} className={cx(recipeStyles, 'recipe-filter-label')}>
                  Family Origin / Provenance Note
                </label>
                <input
                  id={provenanceInputId}
                  name="provenance_note"
                  type="text"
                  maxLength={400}
                  value={draft.provenance_note}
                  placeholder="e.g. Copied from the 1948 cedar recipe box"
                  className={cx(recipeStyles, 'recipe-filter-input')}
                  onChange={(e) => {
                    setDraft((prev) => ({ ...prev, provenance_note: e.target.value }));
                  }}
                />
              </div>
            </div>

            <div className={cx(recipeStyles, 'recipe-editor-field')}>
              <label htmlFor={ancestorInputId} className={cx(recipeStyles, 'recipe-filter-label')}>
                Attributed Ancestor (Deceased Only)
              </label>
              <span id={`${ancestorInputId}-hint`} className={cx(recipeStyles, 'recipe-editor-hint')}>
                Living relatives are never shown or linked for archive privacy.
              </span>
              {selectedAncestor ? (
                <div className={cx(recipeStyles, 'recipe-ancestor-selected')}>
                  <span className={cx(recipeStyles, 'recipe-ancestor-chip')}>
                    {selectedAncestor.full_name}
                  </span>
                  <button
                    type="button"
                    className={cx(recipeStyles, 'recipe-photo-mini-btn')}
                    onClick={() => {
                      setDraft((prev) => ({ ...prev, attributed_person_id: null }));
                      setAncestorQuery('');
                    }}
                  >
                    Clear ancestor
                  </button>
                </div>
              ) : (
                <>
                  <input
                    id={ancestorInputId}
                    type="search"
                    value={ancestorQuery}
                    aria-describedby={`${ancestorInputId}-hint`}
                    placeholder="Search deceased ancestors by name…"
                    className={cx(recipeStyles, 'recipe-filter-input')}
                    onChange={(e) => {
                      setAncestorQuery(e.target.value);
                    }}
                  />
                  {ancestorMatches.length > 0 && (
                    <ul
                      className={cx(recipeStyles, 'recipe-ancestor-results')}
                      aria-label="Matching deceased ancestors"
                    >
                      {ancestorMatches.map((person) => (
                        <li key={person.id}>
                          <button
                            type="button"
                            className={cx(recipeStyles, 'recipe-ancestor-option')}
                            onClick={() => {
                              setDraft((prev) => ({ ...prev, attributed_person_id: person.id }));
                              setAncestorQuery('');
                            }}
                          >
                            <span>{person.full_name}</span>
                            {(person.birth_edtf || person.death_edtf) && (
                              <span className={cx(recipeStyles, 'recipe-era-label')}>
                                {[person.birth_edtf, person.death_edtf].filter(Boolean).join(' – ')}
                              </span>
                            )}
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </>
              )}
            </div>
          </fieldset>

          <fieldset className={cx(recipeStyles, 'recipe-editor-fieldset')}>
            <legend className={cx(recipeStyles, 'recipe-editor-legend')}>Tags</legend>
            <div className={cx(recipeStyles, 'recipe-tag-input-row')}>
              <div className={cx(recipeStyles, 'recipe-editor-field recipe-tag-input-grow')}>
                <label htmlFor={tagInputId} className={cx(recipeStyles, 'recipe-filter-label')}>
                  Add Tag
                </label>
                <input
                  id={tagInputId}
                  type="text"
                  maxLength={40}
                  value={tagInput}
                  aria-invalid={tagError || fieldErrors['tags'] ? 'true' : 'false'}
                  aria-describedby={tagError || fieldErrors['tags'] ? `${tagInputId}-error` : undefined}
                  placeholder="e.g. holiday, heirloom, winter"
                  className={cx(recipeStyles, 'recipe-filter-input')}
                  onChange={(e) => {
                    setTagInput(e.target.value);
                    setTagError(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                      e.preventDefault();
                      handleAddTag();
                    }
                  }}
                />
              </div>
              <button type="button" className={cx(recipeStyles, 'recipe-clear-btn')} onClick={handleAddTag}>
                Add Tag
              </button>
            </div>
            {(tagError || fieldErrors['tags']) && (
              <p id={`${tagInputId}-error`} className={cx(recipeStyles, 'recipe-field-error')}>
                Error: {tagError ?? fieldErrors['tags']}
              </p>
            )}
            {draft.tags.length > 0 && (
              <div className={cx(recipeStyles, 'recipe-card-tags')}>
                {draft.tags.map((tag) => (
                  <ArchivalTagPill
                    key={tag}
                    label={`#${tag}`}
                    onRemove={() => {
                      setDraft((prev) => ({ ...prev, tags: removeDraftTag(prev.tags, tag) }));
                    }}
                  />
                ))}
              </div>
            )}
          </fieldset>

          <fieldset className={cx(recipeStyles, 'recipe-editor-fieldset')}>
            <legend className={cx(recipeStyles, 'recipe-editor-legend')}>Ingredients</legend>
            <div className={cx(recipeStyles, 'recipe-editor-rows')}>
              {draft.ingredients.map((ing, idx) => {
                const errKey = `ingredients.${idx}.item`;
                const rowError = fieldErrors[errKey];
                return (
                  <div key={ing.id} className={cx(recipeStyles, 'recipe-editor-row-card')}>
                    <div className={cx(recipeStyles, 'recipe-editor-row-header')}>
                      <span className={cx(recipeStyles, 'recipe-filter-label')}>Ingredient {idx + 1}</span>
                      <div className={cx(recipeStyles, 'recipe-photo-action-row')}>
                        <button
                          type="button"
                          disabled={idx === 0}
                          aria-label={`Move ingredient ${idx + 1} up`}
                          className={cx(recipeStyles, 'recipe-photo-mini-btn')}
                          onClick={() => {
                            setDraft((prev) => ({
                              ...prev,
                              ingredients: moveDraftListItem(prev.ingredients, idx, -1),
                            }));
                          }}
                        >
                          Move Up
                        </button>
                        <button
                          type="button"
                          disabled={idx === draft.ingredients.length - 1}
                          aria-label={`Move ingredient ${idx + 1} down`}
                          className={cx(recipeStyles, 'recipe-photo-mini-btn')}
                          onClick={() => {
                            setDraft((prev) => ({
                              ...prev,
                              ingredients: moveDraftListItem(prev.ingredients, idx, 1),
                            }));
                          }}
                        >
                          Move Down
                        </button>
                        <button
                          type="button"
                          aria-label={`Remove ingredient ${idx + 1}`}
                          className={cx(recipeStyles, 'recipe-photo-mini-btn recipe-photo-mini-btn-danger')}
                          onClick={() => {
                            setDraft((prev) => {
                              const next = prev.ingredients.filter((row) => row.id !== ing.id);
                              return {
                                ...prev,
                                ingredients:
                                  next.length > 0
                                    ? next
                                    : [createEmptyIngredientDraft(`ing_${nextRowSeqRef.current + 1}`)],
                              };
                            });
                            clearFieldError(errKey);
                          }}
                        >
                          Remove
                        </button>
                      </div>
                    </div>

                    <div className={cx(recipeStyles, 'recipe-ingredient-grid')}>
                      <div className={cx(recipeStyles, 'recipe-editor-field')}>
                        <label htmlFor={`${ing.id}-qty`} className={cx(recipeStyles, 'recipe-filter-label')}>
                          Amount
                        </label>
                        <input
                          id={`${ing.id}-qty`}
                          type="text"
                          maxLength={40}
                          value={ing.quantity}
                          placeholder="2"
                          className={cx(recipeStyles, 'recipe-filter-input')}
                          onChange={(e) => {
                            const val = e.target.value;
                            setDraft((prev) => ({
                              ...prev,
                              ingredients: prev.ingredients.map((row) =>
                                row.id === ing.id ? { ...row, quantity: val } : row
                              ),
                            }));
                          }}
                        />
                      </div>

                      <div className={cx(recipeStyles, 'recipe-editor-field')}>
                        <label htmlFor={`${ing.id}-unit`} className={cx(recipeStyles, 'recipe-filter-label')}>
                          Unit
                        </label>
                        <input
                          id={`${ing.id}-unit`}
                          type="text"
                          maxLength={40}
                          value={ing.unit}
                          placeholder="cups"
                          className={cx(recipeStyles, 'recipe-filter-input')}
                          onChange={(e) => {
                            const val = e.target.value;
                            setDraft((prev) => ({
                              ...prev,
                              ingredients: prev.ingredients.map((row) =>
                                row.id === ing.id ? { ...row, unit: val } : row
                              ),
                            }));
                          }}
                        />
                      </div>

                      <div className={cx(recipeStyles, 'recipe-editor-field recipe-ingredient-item-col')}>
                        <label htmlFor={`${ing.id}-item`} className={cx(recipeStyles, 'recipe-filter-label')}>
                          Ingredient
                        </label>
                        <input
                          ref={(el) => {
                            ingredientItemRefs.current.set(ing.id, el);
                          }}
                          id={`${ing.id}-item`}
                          type="text"
                          maxLength={160}
                          value={ing.item}
                          aria-invalid={rowError ? 'true' : 'false'}
                          aria-describedby={rowError ? `${ing.id}-item-error` : undefined}
                          placeholder="rolled oats"
                          className={cx(recipeStyles, 'recipe-filter-input')}
                          onChange={(e) => {
                            const val = e.target.value;
                            setDraft((prev) => ({
                              ...prev,
                              ingredients: prev.ingredients.map((row) =>
                                row.id === ing.id ? { ...row, item: val } : row
                              ),
                            }));
                            clearFieldError(errKey);
                          }}
                        />
                      </div>

                      <div className={cx(recipeStyles, 'recipe-editor-field')}>
                        <label htmlFor={`${ing.id}-note`} className={cx(recipeStyles, 'recipe-filter-label')}>
                          Prep Note
                        </label>
                        <input
                          id={`${ing.id}-note`}
                          type="text"
                          maxLength={160}
                          value={ing.note}
                          placeholder="sifted"
                          className={cx(recipeStyles, 'recipe-filter-input')}
                          onChange={(e) => {
                            const val = e.target.value;
                            setDraft((prev) => ({
                              ...prev,
                              ingredients: prev.ingredients.map((row) =>
                                row.id === ing.id ? { ...row, note: val } : row
                              ),
                            }));
                          }}
                        />
                      </div>

                      <div className={cx(recipeStyles, 'recipe-editor-field')}>
                        <label
                          htmlFor={`${ing.id}-group`}
                          className={cx(recipeStyles, 'recipe-filter-label')}
                        >
                          Group
                        </label>
                        <input
                          id={`${ing.id}-group`}
                          type="text"
                          maxLength={80}
                          value={ing.group}
                          placeholder="Dry / Glaze"
                          className={cx(recipeStyles, 'recipe-filter-input')}
                          onChange={(e) => {
                            const val = e.target.value;
                            setDraft((prev) => ({
                              ...prev,
                              ingredients: prev.ingredients.map((row) =>
                                row.id === ing.id ? { ...row, group: val } : row
                              ),
                            }));
                          }}
                        />
                      </div>
                    </div>

                    {rowError && (
                      <p id={`${ing.id}-item-error`} className={cx(recipeStyles, 'recipe-field-error')}>
                        Error: {rowError}
                      </p>
                    )}
                  </div>
                );
              })}
            </div>

            <button
              type="button"
              className={cx(recipeStyles, 'recipe-clear-btn')}
              onClick={handleAddIngredient}
            >
              + Add Ingredient
            </button>
          </fieldset>

          <fieldset className={cx(recipeStyles, 'recipe-editor-fieldset')}>
            <legend className={cx(recipeStyles, 'recipe-editor-legend')}>Preparation Steps</legend>
            <div className={cx(recipeStyles, 'recipe-editor-rows')}>
              {draft.steps.map((step, idx) => {
                const errKey = `steps.${idx}.instruction`;
                const rowError = fieldErrors[errKey];
                return (
                  <div key={step.id} className={cx(recipeStyles, 'recipe-editor-row-card')}>
                    <div className={cx(recipeStyles, 'recipe-editor-row-header')}>
                      <span className={cx(recipeStyles, 'recipe-filter-label')}>Step {idx + 1}</span>
                      <div className={cx(recipeStyles, 'recipe-photo-action-row')}>
                        <button
                          type="button"
                          disabled={idx === 0}
                          aria-label={`Move step ${idx + 1} up`}
                          className={cx(recipeStyles, 'recipe-photo-mini-btn')}
                          onClick={() => {
                            setDraft((prev) => ({
                              ...prev,
                              steps: moveDraftListItem(prev.steps, idx, -1),
                            }));
                          }}
                        >
                          Move Up
                        </button>
                        <button
                          type="button"
                          disabled={idx === draft.steps.length - 1}
                          aria-label={`Move step ${idx + 1} down`}
                          className={cx(recipeStyles, 'recipe-photo-mini-btn')}
                          onClick={() => {
                            setDraft((prev) => ({
                              ...prev,
                              steps: moveDraftListItem(prev.steps, idx, 1),
                            }));
                          }}
                        >
                          Move Down
                        </button>
                        <button
                          type="button"
                          aria-label={`Remove step ${idx + 1}`}
                          className={cx(recipeStyles, 'recipe-photo-mini-btn recipe-photo-mini-btn-danger')}
                          onClick={() => {
                            setDraft((prev) => {
                              const next = prev.steps.filter((row) => row.id !== step.id);
                              return {
                                ...prev,
                                steps:
                                  next.length > 0
                                    ? next
                                    : [createEmptyStepDraft(`stp_${nextRowSeqRef.current + 1}`)],
                              };
                            });
                            clearFieldError(errKey);
                          }}
                        >
                          Remove
                        </button>
                      </div>
                    </div>

                    <div className={cx(recipeStyles, 'recipe-editor-field')}>
                      <label htmlFor={`${step.id}-inst`} className={cx(recipeStyles, 'recipe-filter-label')}>
                        Directions
                      </label>
                      <textarea
                        ref={(el) => {
                          stepTextareaRefs.current.set(step.id, el);
                        }}
                        id={`${step.id}-inst`}
                        rows={2}
                        maxLength={1200}
                        value={step.instruction}
                        aria-invalid={rowError ? 'true' : 'false'}
                        aria-describedby={rowError ? `${step.id}-inst-error` : undefined}
                        placeholder="Describe this preparation step…"
                        className={cx(recipeStyles, 'recipe-editor-textarea')}
                        onChange={(e) => {
                          const val = e.target.value;
                          setDraft((prev) => ({
                            ...prev,
                            steps: prev.steps.map((row) =>
                              row.id === step.id ? { ...row, instruction: val } : row
                            ),
                          }));
                          clearFieldError(errKey);
                        }}
                      />
                      {rowError && (
                        <p id={`${step.id}-inst-error`} className={cx(recipeStyles, 'recipe-field-error')}>
                          Error: {rowError}
                        </p>
                      )}
                    </div>

                    <div className={cx(recipeStyles, 'recipe-editor-field')}>
                      <label htmlFor={`${step.id}-note`} className={cx(recipeStyles, 'recipe-filter-label')}>
                        Tip / Margin Note (Optional)
                      </label>
                      <input
                        id={`${step.id}-note`}
                        type="text"
                        maxLength={300}
                        value={step.note}
                        placeholder="e.g. Use the middle rack"
                        className={cx(recipeStyles, 'recipe-filter-input')}
                        onChange={(e) => {
                          const val = e.target.value;
                          setDraft((prev) => ({
                            ...prev,
                            steps: prev.steps.map((row) =>
                              row.id === step.id ? { ...row, note: val } : row
                            ),
                          }));
                        }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>

            <button type="button" className={cx(recipeStyles, 'recipe-clear-btn')} onClick={handleAddStep}>
              + Add Step
            </button>
          </fieldset>

          <fieldset className={cx(recipeStyles, 'recipe-editor-fieldset')}>
            <legend className={cx(recipeStyles, 'recipe-editor-legend')}>
              Family Story & Archival Notes (Markdown)
            </legend>

            <ArchivalTabs
              ariaLabel="Family story editor mode"
              tabs={[
                { id: 'write', label: 'Write' },
                { id: 'preview', label: 'Preview' },
              ]}
              activeTabId={storyTab}
              onSelectTab={(id) => {
                setStoryTab(id === 'preview' ? 'preview' : 'write');
              }}
            />

            {storyTab === 'write' ? (
              <div className={cx(recipeStyles, 'recipe-editor-field')}>
                <label htmlFor={storyTextareaId} className={cx(recipeStyles, 'recipe-filter-label')}>
                  Story Markdown
                </label>
                <span id={`${storyTextareaId}-hint`} className={cx(recipeStyles, 'recipe-editor-hint')}>
                  Supports headings, bold, italics, lists, blockquotes, and safe links. Raw HTML is never
                  executed.
                </span>
                <textarea
                  id={storyTextareaId}
                  name="story_md"
                  rows={6}
                  maxLength={16000}
                  value={draft.story_md}
                  aria-invalid={fieldErrors['story_md'] ? 'true' : 'false'}
                  aria-describedby={
                    fieldErrors['story_md']
                      ? `${storyTextareaId}-hint ${storyTextareaId}-error`
                      : `${storyTextareaId}-hint`
                  }
                  placeholder="Share memories about who cooked this dish, when it was served, or how the recipe card was found…"
                  className={cx(recipeStyles, 'recipe-editor-textarea')}
                  onChange={(e) => {
                    setDraft((prev) => ({ ...prev, story_md: e.target.value }));
                    clearFieldError('story_md');
                  }}
                />
                {fieldErrors['story_md'] && (
                  <p id={`${storyTextareaId}-error`} className={cx(recipeStyles, 'recipe-field-error')}>
                    Error: {fieldErrors['story_md']}
                  </p>
                )}
              </div>
            ) : (
              <div className={cx(recipeStyles, 'recipe-markdown-preview')}>
                {draft.story_md.trim().length > 0 ? (
                  <ArchivalMarkdown markdown={draft.story_md} />
                ) : (
                  <p className={cx(recipeStyles, 'recipe-editor-hint')}>
                    Nothing written yet. Switch to Write to add family notes.
                  </p>
                )}
              </div>
            )}
          </fieldset>

          <div className={cx(recipeStyles, 'recipe-editor-actions')}>
            <button type="submit" disabled={submitting} className={cx(recipeStyles, 'recipe-primary-btn')}>
              {submitting
                ? 'Saving…'
                : mode === 'create'
                  ? 'Save New Recipe'
                  : `Save Changes (v${expectedVersion})`}
            </button>
            <button
              type="button"
              disabled={submitting}
              className={cx(recipeStyles, 'recipe-clear-btn')}
              onClick={handleRequestCancel}
            >
              Cancel
            </button>
            {isDirty && (
              <span className={cx(recipeStyles, 'recipe-dirty-indicator')} role="status" aria-live="polite">
                Unsaved changes
              </span>
            )}
          </div>
        </form>
      </div>

      <ArchivalModal
        open={confirmDiscardOpen}
        title="Discard unsaved changes?"
        onClose={() => {
          setConfirmDiscardOpen(false);
        }}
      >
        <p className={cx(recipeStyles, 'recipe-detail-summary')}>
          You have unsaved edits to this recipe. Leaving now will discard them.
        </p>
        <div className={cx(recipeStyles, 'recipe-conflict-actions')}>
          <button
            type="button"
            className={cx(recipeStyles, 'recipe-photo-mini-btn recipe-photo-mini-btn-danger')}
            onClick={() => {
              setConfirmDiscardOpen(false);
              onCancel();
            }}
          >
            Discard Changes
          </button>
          <button
            type="button"
            className={cx(recipeStyles, 'recipe-clear-btn')}
            onClick={() => {
              setConfirmDiscardOpen(false);
            }}
          >
            Keep Editing
          </button>
        </div>
      </ArchivalModal>

      <ArchivalLightbox
        items={lightboxItems}
        activeIndex={lightboxIndex}
        onClose={() => {
          setLightboxIndex(null);
        }}
        onChangeIndex={(nextIdx) => {
          setLightboxIndex(nextIdx);
          setSelectedRefPhotoIdx(nextIdx);
        }}
      />
    </>
  );
};
