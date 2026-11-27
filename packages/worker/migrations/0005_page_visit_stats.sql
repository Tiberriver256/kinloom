-- Privacy-first aggregate page visit counters and bundle cache telemetry (0005_page_visit_stats.sql)
CREATE TABLE IF NOT EXISTS page_visit_daily (
  route_key TEXT NOT NULL,
  entity_kind TEXT NOT NULL,
  entity_slug TEXT,
  day_utc TEXT NOT NULL,
  views INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (route_key, day_utc)
);

CREATE INDEX IF NOT EXISTS idx_page_visit_daily_day_utc
  ON page_visit_daily (day_utc);

CREATE INDEX IF NOT EXISTS idx_page_visit_daily_kind_day
  ON page_visit_daily (entity_kind, day_utc);

CREATE TABLE IF NOT EXISTS observability_cache_daily (
  day_utc TEXT NOT NULL PRIMARY KEY,
  hits INTEGER NOT NULL DEFAULT 0,
  misses INTEGER NOT NULL DEFAULT 0,
  not_modified INTEGER NOT NULL DEFAULT 0
);
