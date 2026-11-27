import type React from 'react';
import { useEffect, useId, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArchivalBanner, ArchivalPageShell } from '../../components/ArchivalLayout.js';
import { ArchivalEmptyState, ArchivalToast } from '../../components/ArchivalPrimitives.js';
import { ExplorerTopBar } from '../../components/ExplorerTopBar.js';
import { KinloomFooter } from '../../components/KinloomFooter.js';
import { cx } from '../../lib/cx.js';
import type { UiRecipeDetailResponse } from '../../lib/recipesModel.js';
import { useKinloomPluginContext } from '../PluginContext.js';
import { RecipeEditorForm } from './RecipeEditorForm.js';
import recipeStyles from './Recipes.module.css';
import { useRecipesPlugin } from './RecipesContext.js';

export interface RecipeEditorPageProps {
  readonly mode: 'create' | 'edit';
}

export const RecipeEditorPage: React.FC<RecipeEditorPageProps> = ({ mode }) => {
  const { slug } = useParams<{ slug: string }>();
  const navigate = useNavigate();
  const headingId = useId();
  const { client, basePath } = useRecipesPlugin();
  const { session, capabilities } = useKinloomPluginContext();

  const [detail, setDetail] = useState<UiRecipeDetailResponse | null>(null);
  const [loading, setLoading] = useState<boolean>(mode === 'edit');
  const [notFound, setNotFound] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (mode === 'create') {
      setLoading(false);
      setNotFound(false);
      setDetail(null);
      return undefined;
    }
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
        setError(err instanceof Error ? err.message : 'Unable to load this recipe for editing.');
        setLoading(false);
      });

    return (): void => {
      cancelled = true;
      controller.abort();
    };
  }, [client, mode, slug]);

  const isSignedInMember = Boolean(
    (session?.principal_kind === 'user' && session.authenticated) || capabilities.canEdit
  );
  const canCreate = mode === 'create' && Boolean(client.createRecipe) && isSignedInMember;
  const canEdit = mode === 'edit' && Boolean(client.updateRecipe) && Boolean(detail?.permissions.can_edit);

  const returnPath =
    mode === 'edit' && detail ? `${basePath}/${encodeURIComponent(detail.recipe.slug)}` : basePath;

  return (
    <div>
      <ExplorerTopBar />
      <ArchivalPageShell variant="wide">
        <div className={cx(recipeStyles, 'recipe-detail-topbar')}>
          <Link to={returnPath} className={cx(recipeStyles, 'recipe-back-link')}>
            {mode === 'edit' && detail ? '← Back to Recipe Card' : '← Back to Recipe Box'}
          </Link>
        </div>

        <ArchivalBanner>
          <div>
            <h1 id={headingId}>
              {mode === 'create'
                ? 'Add Family Recipe'
                : detail
                  ? `Edit ${detail.recipe.title}`
                  : 'Edit Family Recipe'}
            </h1>
            <p>
              {mode === 'create'
                ? 'Record ingredients, preparation steps, provenance notes, and the family story behind an heirloom dish.'
                : 'Update the structured transcription while comparing against uploaded recipe card scans.'}
            </p>
          </div>
        </ArchivalBanner>

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
            Loading recipe editor…
          </output>
        )}

        {!loading && mode === 'edit' && notFound && (
          <ArchivalEmptyState
            title="Recipe not found"
            description="This recipe card does not exist or has been removed from the archive."
            action={
              <Link to={basePath} className={cx(recipeStyles, 'recipe-back-link')}>
                Return to Family Recipe Box
              </Link>
            }
          />
        )}

        {!loading && mode === 'create' && !canCreate && (
          <ArchivalEmptyState
            title="Editor sign-in required"
            description="Only signed-in family archive editors or administrators can add new recipes."
            action={
              <Link to={basePath} className={cx(recipeStyles, 'recipe-back-link')}>
                Return to Family Recipe Box
              </Link>
            }
          />
        )}

        {!loading && mode === 'edit' && !notFound && detail && !canEdit && (
          <ArchivalEmptyState
            title="Editing is not permitted for your account"
            description="Only authorized family archive editors or administrators can edit this recipe."
            action={
              <Link to={returnPath} className={cx(recipeStyles, 'recipe-back-link')}>
                Return to Recipe Card
              </Link>
            }
          />
        )}

        {!loading && mode === 'create' && canCreate && client.createRecipe && (
          <RecipeEditorForm
            mode="create"
            headingId={headingId}
            onSubmitCreate={async (payload) => {
              const res = await client.createRecipe?.(payload);
              if (!res) {
                throw new Error('Recipe creation is unavailable.');
              }
              return res.recipe;
            }}
            onSaved={(created) => {
              void navigate(`${basePath}/${encodeURIComponent(created.slug)}`);
            }}
            onCancel={() => {
              void navigate(basePath);
            }}
          />
        )}

        {!loading && mode === 'edit' && detail && canEdit && client.updateRecipe && (
          <RecipeEditorForm
            mode="edit"
            headingId={headingId}
            initialRecipe={detail.recipe}
            photos={detail.photos}
            onSubmitUpdate={async (payload) => {
              const res = await client.updateRecipe?.(detail.recipe.slug, payload);
              if (!res) {
                throw new Error('Recipe editing is unavailable.');
              }
              return res.recipe;
            }}
            onSaved={(updated) => {
              void navigate(`${basePath}/${encodeURIComponent(updated.slug)}`);
            }}
            onCancel={() => {
              void navigate(returnPath);
            }}
          />
        )}
      </ArchivalPageShell>
      <KinloomFooter />
    </div>
  );
};

export const RecipeCreatePage: React.FC = () => <RecipeEditorPage mode="create" />;
export const RecipeEditPage: React.FC = () => <RecipeEditorPage mode="edit" />;
