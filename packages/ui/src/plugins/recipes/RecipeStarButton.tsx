import type React from 'react';
import { cx } from '../../lib/cx.js';
import recipeStyles from './Recipes.module.css';

export interface RecipeStarButtonProps {
  readonly recipeTitle: string;
  readonly starCount: number;
  readonly starred: boolean;
  readonly canStar: boolean;
  readonly pending?: boolean;
  readonly variant?: 'card' | 'detail';
  readonly onToggle?: () => void;
}

const StarGlyph: React.FC<{ readonly filled: boolean }> = ({ filled }) => (
  <svg
    width="15"
    height="15"
    viewBox="0 0 20 20"
    fill={filled ? 'currentColor' : 'none'}
    stroke="currentColor"
    strokeWidth="1.7"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    className={cx(recipeStyles, 'recipe-star-icon')}
  >
    <path d="M10 2.3l2.36 4.78 5.28.77-3.82 3.72.9 5.26L10 14.34l-4.72 2.49.9-5.26-3.82-3.72 5.28-.77L10 2.3Z" />
  </svg>
);

export const RecipeStarButton: React.FC<RecipeStarButtonProps> = ({
  recipeTitle,
  starCount,
  starred,
  canStar,
  pending = false,
  variant = 'card',
  onToggle,
}) => {
  const countText = `${starCount} ${starCount === 1 ? 'star' : 'stars'}`;

  if (!canStar || !onToggle) {
    return (
      <span
        className={cx(
          recipeStyles,
          variant === 'detail' ? 'recipe-star-badge recipe-star-badge-detail' : 'recipe-star-badge'
        )}
      >
        <StarGlyph filled={starred} />
        <span className={cx(recipeStyles, 'recipe-star-count')}>{countText}</span>
      </span>
    );
  }

  const label = starred
    ? `Remove star from recipe ${recipeTitle} (${countText})`
    : `Star recipe ${recipeTitle} (${countText})`;

  return (
    <button
      type="button"
      aria-pressed={starred}
      aria-label={label}
      aria-busy={pending || undefined}
      aria-disabled={pending || undefined}
      className={cx(
        recipeStyles,
        variant === 'detail'
          ? starred
            ? 'recipe-star-btn recipe-star-btn-detail recipe-star-btn-active'
            : 'recipe-star-btn recipe-star-btn-detail'
          : starred
            ? 'recipe-star-btn recipe-star-btn-active'
            : 'recipe-star-btn'
      )}
      onClick={() => {
        if (pending) {
          return;
        }
        onToggle();
      }}
    >
      <StarGlyph filled={starred} />
      {variant === 'detail' && <span>{starred ? 'Remove star' : 'Star recipe'}</span>}
      <span className={cx(recipeStyles, 'recipe-star-count')}>{starCount}</span>
    </button>
  );
};
