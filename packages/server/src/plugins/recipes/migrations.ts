import type { PluginSqlMigration } from '@kinloom/core';

export const RECIPES_INITIAL_MIGRATION_SQL = `-- Kinloom Family Recipe Sharing Plugin (namespace: recipes, version: 1)

CREATE TABLE IF NOT EXISTS plugin_recipes_items (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  story_md TEXT NOT NULL DEFAULT '',
  ingredients_json TEXT NOT NULL DEFAULT '[]',
  steps_json TEXT NOT NULL DEFAULT '[]',
  prep_minutes INTEGER CHECK (prep_minutes IS NULL OR (prep_minutes >= 0 AND prep_minutes <= 10080)),
  cook_minutes INTEGER CHECK (cook_minutes IS NULL OR (cook_minutes >= 0 AND cook_minutes <= 10080)),
  servings TEXT NOT NULL DEFAULT '',
  course TEXT NOT NULL DEFAULT 'other' CHECK (
    course IN ('breakfast', 'appetizer', 'soup_salad', 'main', 'side', 'bread', 'dessert', 'beverage', 'preserve', 'other')
  ),
  tags_json TEXT NOT NULL DEFAULT '[]',
  provenance_note TEXT NOT NULL DEFAULT '',
  source_era TEXT NOT NULL DEFAULT '',
  attributed_person_id TEXT,
  cover_photo_id TEXT,
  star_count INTEGER NOT NULL DEFAULT 0 CHECK (star_count >= 0),
  comment_count INTEGER NOT NULL DEFAULT 0 CHECK (comment_count >= 0),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by_id TEXT NOT NULL,
  created_by_name TEXT NOT NULL,
  updated_by_id TEXT NOT NULL,
  updated_by_name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE TABLE IF NOT EXISTS plugin_recipes_photos (
  id TEXT PRIMARY KEY,
  recipe_id TEXT NOT NULL REFERENCES plugin_recipes_items(id) ON DELETE CASCADE,
  r2_key TEXT NOT NULL,
  mime_type TEXT NOT NULL CHECK (mime_type IN ('image/jpeg', 'image/png', 'image/webp')),
  size_bytes INTEGER NOT NULL CHECK (size_bytes > 0),
  sha256 TEXT NOT NULL,
  width INTEGER CHECK (width IS NULL OR width > 0),
  height INTEGER CHECK (height IS NULL OR height > 0),
  orientation INTEGER NOT NULL DEFAULT 1 CHECK (orientation BETWEEN 1 AND 8),
  caption TEXT NOT NULL DEFAULT '',
  card_side TEXT NOT NULL DEFAULT 'front' CHECK (card_side IN ('front', 'back', 'page', 'dish', 'other')),
  sort_order INTEGER NOT NULL DEFAULT 0,
  uploaded_by_id TEXT NOT NULL,
  uploaded_by_name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE TABLE IF NOT EXISTS plugin_recipes_stars (
  recipe_id TEXT NOT NULL REFERENCES plugin_recipes_items(id) ON DELETE CASCADE,
  actor_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (recipe_id, actor_key)
);

CREATE TABLE IF NOT EXISTS plugin_recipes_comments (
  id TEXT PRIMARY KEY,
  recipe_id TEXT NOT NULL REFERENCES plugin_recipes_items(id) ON DELETE CASCADE,
  parent_comment_id TEXT REFERENCES plugin_recipes_comments(id) ON DELETE CASCADE,
  depth INTEGER NOT NULL DEFAULT 0 CHECK (depth IN (0, 1)),
  author_id TEXT NOT NULL,
  author_key TEXT NOT NULL,
  author_name TEXT NOT NULL,
  body_md TEXT NOT NULL,
  created_at TEXT NOT NULL,
  edited_at TEXT,
  deleted_at TEXT,
  deleted_by_role TEXT CHECK (deleted_by_role IS NULL OR deleted_by_role IN ('author', 'admin'))
);

-- Active slug uniqueness (allows reusing a slug after soft delete)
CREATE UNIQUE INDEX IF NOT EXISTS idx_plugin_recipes_items_active_slug
  ON plugin_recipes_items (slug)
  WHERE deleted_at IS NULL;

-- Catalog sorting and ancestor lookups (zero full-table scans)
CREATE INDEX IF NOT EXISTS idx_plugin_recipes_items_created
  ON plugin_recipes_items (created_at DESC, id)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_plugin_recipes_items_stars
  ON plugin_recipes_items (star_count DESC, created_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_plugin_recipes_items_course
  ON plugin_recipes_items (course, created_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_plugin_recipes_items_ancestor
  ON plugin_recipes_items (attributed_person_id, created_at DESC)
  WHERE attributed_person_id IS NOT NULL AND deleted_at IS NULL;

-- Ordered active photos per recipe
CREATE INDEX IF NOT EXISTS idx_plugin_recipes_photos_recipe_order
  ON plugin_recipes_photos (recipe_id, sort_order ASC, created_at ASC)
  WHERE deleted_at IS NULL;

-- Fast "My Favorites" lookup by caller actor_key
CREATE INDEX IF NOT EXISTS idx_plugin_recipes_stars_actor
  ON plugin_recipes_stars (actor_key, created_at DESC);

-- Chronological comment thread retrieval per recipe
CREATE INDEX IF NOT EXISTS idx_plugin_recipes_comments_recipe_thread
  ON plugin_recipes_comments (recipe_id, created_at ASC, id ASC);

CREATE INDEX IF NOT EXISTS idx_plugin_recipes_comments_parent
  ON plugin_recipes_comments (parent_comment_id, created_at ASC)
  WHERE parent_comment_id IS NOT NULL;
`;

export const RECIPES_PLUGIN_MIGRATIONS: readonly PluginSqlMigration[] = [
  {
    version: 1,
    id: '0001_recipes_initial',
    description: 'Create Family Recipe Sharing tables and indexes.',
    sql: RECIPES_INITIAL_MIGRATION_SQL,
  },
];
