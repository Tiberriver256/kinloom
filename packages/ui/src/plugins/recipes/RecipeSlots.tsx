import type { Person } from '@kinloom/core';
import type React from 'react';
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArchivalSection } from '../../components/ArchivalLayout.js';
import { useOptionalArchiveData } from '../../context/ArchiveDataContext.js';
import { cx } from '../../lib/cx.js';
import {
  formatRecipeCourseLabel,
  formatTotalRecipeDuration,
  type UiRecipeSummary,
} from '../../lib/recipesModel.js';
import { useKinloomPlugins } from '../PluginContext.js';
import recipeStyles from './Recipes.module.css';
import { useRecipesPlugin } from './RecipesContext.js';

const RECIPES_SERVER_PLUGIN_ID = 'kinloom-recipes';

export interface PersonRecipesSlotProps {
  readonly person: Person;
}

/**
 * PersonPage `personRelated` slot panel showing recipes attributed to a deceased ancestor.
 * Renders `null` when the person is living, has zero matching recipes, or the server plugin is inactive.
 */
export const PersonRecipesSlot: React.FC<PersonRecipesSlotProps> = ({ person }) => {
  const { client, basePath } = useRecipesPlugin();
  const archiveData = useOptionalArchiveData();
  const hasSessionLoader = Boolean(archiveData?.dataSource.getSession);
  const session = archiveData?.session ?? null;
  const canReadArchive = archiveData?.capabilities.canReadArchive;
  const sessionKey = session
    ? `${session.principal_kind}:${session.authenticated ? 'auth' : 'anon'}`
    : 'pending';
  const [recipes, setRecipes] = useState<readonly UiRecipeSummary[]>([]);
  const isLiving = person.is_living || person.full_name === 'Living';

  useEffect(() => {
    if (isLiving) {
      setRecipes([]);
      return undefined;
    }
    if (hasSessionLoader && sessionKey === 'pending') {
      return undefined;
    }
    if (hasSessionLoader && session?.principal_kind === 'anonymous' && canReadArchive === false) {
      setRecipes([]);
      return undefined;
    }
    const controller = new AbortController();
    let cancelled = false;
    void client
      .listRecipesByPerson(person.id, { limit: 6, signal: controller.signal })
      .then((res) => {
        if (!cancelled) {
          setRecipes(res?.recipes ?? []);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setRecipes([]);
        }
      });
    return (): void => {
      cancelled = true;
      controller.abort();
    };
  }, [client, person.id, isLiving, hasSessionLoader, sessionKey, session?.principal_kind, canReadArchive]);

  if (isLiving || recipes.length === 0) {
    return null;
  }

  return (
    <ArchivalSection aria-labelledby="person-heirloom-recipes-heading">
      <div className={cx(recipeStyles, 'recipe-slot-header')}>
        <h2 id="person-heirloom-recipes-heading" className={cx(recipeStyles, 'recipe-slot-heading')}>
          Heirloom Recipes
        </h2>
        <Link
          to={`${basePath}?ancestor=${encodeURIComponent(person.id)}`}
          className={cx(recipeStyles, 'recipe-slot-link')}
        >
          View in Recipe Box →
        </Link>
      </div>
      <div className={cx(recipeStyles, 'recipe-slot-grid')}>
        {recipes.map((recipe) => {
          const totalTime = formatTotalRecipeDuration(recipe.prep_minutes, recipe.cook_minutes);
          return (
            <Link
              key={recipe.id}
              to={`${basePath}/${encodeURIComponent(recipe.slug)}`}
              className={cx(recipeStyles, 'recipe-slot-mini-card')}
            >
              <span className={cx(recipeStyles, 'recipe-slot-mini-top')}>
                <span className={cx(recipeStyles, 'recipe-course-badge')}>
                  {formatRecipeCourseLabel(recipe.course)}
                </span>
                <span
                  className={cx(
                    recipeStyles,
                    recipe.viewer_has_starred
                      ? 'recipe-slot-star recipe-slot-star-active'
                      : 'recipe-slot-star'
                  )}
                >
                  <span aria-hidden="true">{recipe.viewer_has_starred ? '★' : '☆'}</span> {recipe.star_count}{' '}
                  {recipe.star_count === 1 ? 'star' : 'stars'}
                </span>
              </span>
              <span className={cx(recipeStyles, 'recipe-slot-mini-title')}>{recipe.title}</span>
              <span className={cx(recipeStyles, 'recipe-slot-mini-meta')}>
                {[totalTime, recipe.source_era].filter(Boolean).join(' · ') || 'Family recipe card'}
              </span>
            </Link>
          );
        })}
      </div>
    </ArchivalSection>
  );
};

/**
 * IndexPage `indexWidgets` shelf showing up to 4 top-starred family recipes.
 * Renders `null` when disabled by plugin option or server setting, or when zero recipes exist.
 */
export const IndexRecipesWidget: React.FC = () => {
  const { client, basePath, showIndexWidget, pageTitle } = useRecipesPlugin();
  const archiveData = useOptionalArchiveData();
  const { subscribePluginSettings } = useKinloomPlugins();
  const hasSessionLoader = Boolean(archiveData?.dataSource.getSession);
  const session = archiveData?.session ?? null;
  const canReadArchive = archiveData?.capabilities.canReadArchive;
  const sessionKey = session
    ? `${session.principal_kind}:${session.authenticated ? 'auth' : 'anon'}`
    : 'pending';
  const [recipes, setRecipes] = useState<readonly UiRecipeSummary[]>([]);
  const [allowedByServer, setAllowedByServer] = useState<boolean>(true);

  const loadWidgetRecipes = useCallback(
    async (signal?: AbortSignal): Promise<void> => {
      if (!showIndexWidget) {
        setRecipes([]);
        return;
      }
      try {
        const res = await client.listRecipes({ sort: 'most_starred', limit: 4 }, { signal });
        if (signal?.aborted) {
          return;
        }
        if (res === null) {
          setRecipes([]);
          return;
        }
        if (res.display?.show_home_widget === false) {
          setAllowedByServer(false);
          setRecipes([]);
          return;
        }
        setAllowedByServer(true);
        setRecipes(res.recipes);
      } catch {
        if (!signal?.aborted) {
          setRecipes([]);
        }
      }
    },
    [client, showIndexWidget]
  );

  useEffect(() => {
    return subscribePluginSettings(RECIPES_SERVER_PLUGIN_ID, (evt) => {
      const nextShow = evt.snapshot?.values.show_home_widget;
      if (typeof nextShow === 'boolean') {
        setAllowedByServer(nextShow);
        if (!nextShow) {
          setRecipes([]);
          return;
        }
      }
      void loadWidgetRecipes();
    });
  }, [subscribePluginSettings, loadWidgetRecipes]);

  useEffect(() => {
    if (!showIndexWidget) {
      setRecipes([]);
      return undefined;
    }
    if (hasSessionLoader && sessionKey === 'pending') {
      return undefined;
    }
    if (hasSessionLoader && session?.principal_kind === 'anonymous' && canReadArchive === false) {
      setRecipes([]);
      return undefined;
    }
    const controller = new AbortController();
    void loadWidgetRecipes(controller.signal);
    return (): void => {
      controller.abort();
    };
  }, [
    loadWidgetRecipes,
    showIndexWidget,
    hasSessionLoader,
    sessionKey,
    session?.principal_kind,
    canReadArchive,
  ]);

  if (!showIndexWidget || !allowedByServer || recipes.length === 0) {
    return null;
  }

  return (
    <section aria-labelledby="index-recipes-widget-heading" className={cx(recipeStyles, 'recipe-slot-shelf')}>
      <div className={cx(recipeStyles, 'recipe-slot-header')}>
        <h2 id="index-recipes-widget-heading" className={cx(recipeStyles, 'recipe-slot-heading')}>
          {pageTitle}
        </h2>
        <Link to={basePath} className={cx(recipeStyles, 'recipe-slot-link')}>
          Browse all recipes →
        </Link>
      </div>
      <div className={cx(recipeStyles, 'recipe-slot-grid')}>
        {recipes.map((recipe) => (
          <Link
            key={recipe.id}
            to={`${basePath}/${encodeURIComponent(recipe.slug)}`}
            className={cx(recipeStyles, 'recipe-slot-mini-card')}
          >
            <span className={cx(recipeStyles, 'recipe-slot-mini-top')}>
              <span className={cx(recipeStyles, 'recipe-course-badge')}>
                {formatRecipeCourseLabel(recipe.course)}
              </span>
              <span
                className={cx(
                  recipeStyles,
                  recipe.viewer_has_starred ? 'recipe-slot-star recipe-slot-star-active' : 'recipe-slot-star'
                )}
              >
                <span aria-hidden="true">{recipe.viewer_has_starred ? '★' : '☆'}</span> {recipe.star_count}{' '}
                {recipe.star_count === 1 ? 'star' : 'stars'}
              </span>
            </span>
            <span className={cx(recipeStyles, 'recipe-slot-mini-title')}>{recipe.title}</span>
            <span className={cx(recipeStyles, 'recipe-slot-mini-meta')}>
              {recipe.attributed_person
                ? `From ${recipe.attributed_person.full_name}`
                : recipe.source_era || 'Family recipe card'}
            </span>
          </Link>
        ))}
      </div>
    </section>
  );
};
