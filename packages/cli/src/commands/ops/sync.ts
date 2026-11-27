import { execFile } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  type ArchiveBundle,
  computeEntityDiff,
  deriveKinshipEdgeId,
  type EntityPatch,
  type EntityPayload,
  type EntityType,
  filterMediaForPrivacy,
  type KinloomSiteConfig,
  type KinshipEdge,
  type MediaItem,
  type Narrative,
  type Place,
  parseEntityPayload,
  parseEventsYaml,
  parseKinloomConfigYaml,
  parseKinshipYaml,
  parseMediaYaml,
  parseNarrativesYaml,
  parsePeopleYaml,
  parsePlacesYaml,
  parseSourcesYaml,
  type RawEvent,
  type RawPerson,
  resolveEffectiveLiving,
  type SourceRecord,
  sanitizeEventForWrite,
  sanitizePersonForWrite,
} from '@kinloom/core';
import { CliValidationError } from '../../errors.js';

const execFileAsync = promisify(execFile);

export const SYNC_DEPENDENCY_ORDER: readonly EntityType[] = [
  'place',
  'source',
  'person',
  'event',
  'kinship_edge',
  'media',
  'narrative',
];

const ENTITY_TYPE_ALIASES: Readonly<Record<string, EntityType>> = {
  place: 'place',
  places: 'place',
  source: 'source',
  sources: 'source',
  person: 'person',
  people: 'person',
  event: 'event',
  events: 'event',
  kinship: 'kinship_edge',
  kinship_edge: 'kinship_edge',
  kinship_edges: 'kinship_edge',
  media: 'media',
  narrative: 'narrative',
  narratives: 'narrative',
};

const MIME_BY_EXT: Readonly<Record<string, string>> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.wav': 'audio/wav',
  '.txt': 'text/plain; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

const DEFAULT_CHUNK_SIZE = 25;
const DEFAULT_UPLOAD_CONCURRENCY = 6;
const MEDIA_PROBE_CONCURRENCY = 12;
const LIVE_VERIFY_CONCURRENCY = 6;
const LIVE_VERIFY_TIMEOUT_MS = 15_000;
const DEFAULT_BACKUP_TOKEN_LABEL = 'github-actions-nightly-backup';
const TEMP_TOKEN_LABEL = 'tmp-kinloom-sync';
const TEMP_TOKEN_ID_PREFIX = 'tmp_sync_';

export { SYNC_HELP } from './help.js';

export interface SyncDeleteTarget {
  entity_type: EntityType;
  entity_id: string;
}

export interface WranglerBindings {
  configPath: string;
  dbName: string;
  r2Bucket: string;
  domain: string;
  baseUrl: string;
}

export interface WranglerExecOptions {
  cwd: string;
  timeoutMs: number;
  maxBufferBytes: number;
}

export type WranglerExecutor = (
  wranglerBin: string,
  args: readonly string[],
  options: WranglerExecOptions
) => Promise<{ stdout: string; stderr: string }>;

export interface SyncCommandOptions {
  repoDir?: string;
  siteUrl?: string;
  types?: readonly EntityType[];
  syncMissingMedia?: boolean;
  uploadMediaPaths?: readonly string[];
  concurrency?: number;
  chunkSize?: number;
  summary?: string;
  allowDeletes?: boolean;
  explicitDeletes?: readonly SyncDeleteTarget[];
  includeLiving?: boolean;
  verifyLive?: boolean;
  dryRun?: boolean;
  json?: boolean;
  backupTokenLabel?: string;
  wranglerBin?: string;
  fetchImpl?: typeof fetch;
  execWrangler?: WranglerExecutor;
}

export interface SanitizedLocalEntry {
  entity_type: EntityType;
  entity_id: string;
  data: EntityPayload;
  has_primary_source: boolean;
  isLiving: boolean;
}

export interface RemoteEntityEntry {
  revisionId: number;
  data: EntityPayload;
  has_primary_source: boolean;
}

export interface SyncTypeCounts {
  local: number;
  remote: number;
  create: number;
  update: number;
  delete: number;
  unchanged: number;
  skippedLiving: number;
}

export interface SyncChangedSample {
  action: 'create' | 'update' | 'delete';
  entity_type: EntityType;
  entity_id: string;
  changedFields?: string[];
}

export interface SyncPlan {
  patches: EntityPatch[];
  countsByType: Partial<Record<EntityType, SyncTypeCounts>>;
  changedSamples: SyncChangedSample[];
}

export interface SyncSubmittedBatch {
  batch_id: string;
  patchCount: number;
  head_revision_id: number;
  etag: string;
}

export interface SyncRecompileSummary {
  httpStatus: number;
  etag: string | null;
  maxRevisionId: number | null;
  counts: ArchiveBundle['meta']['counts'] | null;
}

export interface SyncCleanupSummary {
  deletedTokenIds: string[];
  remainingTmpCount: number;
  backupTokenLabel: string;
  backupCount: number;
}

export interface SyncLiveVerificationFailure {
  target: string;
  url: string;
  status: number | null;
  reason: string;
}

export interface SyncLiveVerificationSummary {
  ok: boolean;
  bundleStatus: number | null;
  bundleRevision: number | null;
  expectedRevision: number | null;
  mediaChecked: number;
  mediaFailed: number;
  failures: SyncLiveVerificationFailure[];
}

export interface SyncCommandResult {
  repoDir: string;
  baseUrl: string;
  dbName: string;
  r2Bucket: string;
  dryRun: boolean;
  selectedTypes: EntityType[];
  remoteHeadBefore: number;
  remoteEtagBefore: string | null;
  countsByType: Partial<Record<EntityType, SyncTypeCounts>>;
  totalPatches: number;
  chunkSize: number;
  plannedBatches: number;
  changedSamples: SyncChangedSample[];
  filteredOutLivingMedia: number;
  media: {
    checkedRemoteCount: number;
    plannedUploads: string[];
    uploadedKeys: string[];
    concurrency: number;
  };
  batchesSubmitted: SyncSubmittedBatch[];
  recompile: SyncRecompileSummary | null;
  liveVerification: SyncLiveVerificationSummary | null;
  cleanup: SyncCleanupSummary | null;
  rendered: string;
}

interface MintedTempToken {
  tokenId: string;
  rawToken: string;
  tokenHash: string;
  scope: 'read_backup' | 'write_batch';
}

interface LocalArchiveFiles {
  siteConfig: KinloomSiteConfig;
  places: Place[];
  sources: SourceRecord[];
  people: RawPerson[];
  events: RawEvent[];
  kinship: KinshipEdge[];
  media: MediaItem[];
  narratives: Narrative[];
}

interface RemoteSnapshotResponse {
  head_revision_id?: number;
  entities: Array<{
    entity_type: Exclude<EntityType, 'kinship_edge'>;
    entity_id: string;
    data: EntityPayload;
    current_revision_id: number;
    has_primary_source?: boolean;
    deleted_at?: string | null;
  }>;
  kinship: Array<{
    edge_id: string;
    edge: KinshipEdge;
    current_revision_id: number;
    deleted_at?: string | null;
  }>;
}

interface MediaUploadTarget {
  localPath: string;
  r2Key: string;
  contentType: string;
}

interface SyncExecutionContext {
  repoDir: string;
  mediaLayout: 'archive-media' | 'media';
  bindings: WranglerBindings;
  wranglerBin: string;
  fetchImpl: typeof fetch;
  execWrangler: WranglerExecutor;
  backupTokenLabel: string;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function normalizeSyncEntityType(raw: string): EntityType {
  const key = raw.trim().toLowerCase();
  const mapped = ENTITY_TYPE_ALIASES[key];
  if (!mapped) {
    throw new CliValidationError(
      `Unknown entity type '${raw}'. Valid types: ${SYNC_DEPENDENCY_ORDER.join(', ')}.`
    );
  }
  return mapped;
}

export function parseEntityTypeList(csv: string): EntityType[] {
  const requested = new Set(
    csv
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean)
      .map(normalizeSyncEntityType)
  );
  if (requested.size === 0) {
    throw new CliValidationError('Option `--types` must include at least one entity type.');
  }
  return SYNC_DEPENDENCY_ORDER.filter((t) => requested.has(t));
}

export function parseDeleteTargets(csv: string): SyncDeleteTarget[] {
  const targets: SyncDeleteTarget[] = [];
  for (const token of csv
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)) {
    const sep = token.indexOf(':');
    if (sep <= 0 || sep === token.length - 1) {
      throw new CliValidationError(
        `Invalid \`--delete\` entry '${token}'. Expected <entity_type>:<entity_id>.`
      );
    }
    const entityType = normalizeSyncEntityType(token.slice(0, sep));
    const entityId = token.slice(sep + 1).trim();
    targets.push({ entity_type: entityType, entity_id: entityId });
  }
  return targets;
}

export function stripJsoncCommentsAndTrailingCommas(text: string): string {
  let out = '';
  let inString = false;
  let escapeNext = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    const next = text[i + 1];

    if (inString) {
      out += ch;
      if (escapeNext) {
        escapeNext = false;
      } else if (ch === '\\') {
        escapeNext = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') {
        i += 1;
      }
      if (i < text.length) {
        out += '\n';
      }
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) {
        i += 1;
      }
      i += 1;
      continue;
    }
    out += ch;
  }

  return out.replaceAll(/,\s*([}\]])/g, '$1');
}

function normalizeSiteUrl(rawUrl: string): { baseUrl: string; domain: string } {
  const trimmed = rawUrl.trim();
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    throw new CliValidationError(`Invalid site URL '${rawUrl}'. Expected an http:// or https:// URL.`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new CliValidationError(
      `Unsupported site URL protocol '${parsed.protocol}'. Expected http: or https:.`
    );
  }
  return {
    baseUrl: `${parsed.origin}${parsed.pathname}`.replace(/\/+$/, ''),
    domain: parsed.host,
  };
}

function parseWranglerTomlBindings(raw: string): {
  dbName: string;
  r2Bucket: string;
  routePattern: string;
} {
  let section: 'none' | 'd1' | 'r2' | 'routes' = 'none';
  let dbName = '';
  let r2Bucket = '';
  let routePattern = '';
  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) {
      continue;
    }
    if (line.startsWith('[')) {
      if (line === '[[d1_databases]]') {
        section = 'd1';
      } else if (line === '[[r2_buckets]]') {
        section = 'r2';
      } else if (line === '[[routes]]') {
        section = 'routes';
      } else {
        section = 'none';
      }
      continue;
    }
    const kv = /^([A-Za-z0-9_]+)\s*=\s*"([^"]*)"/.exec(line);
    if (!kv) {
      continue;
    }
    const [, key, val] = kv;
    if (section === 'd1' && key === 'database_name' && !dbName) {
      dbName = val.trim();
    } else if (section === 'r2' && key === 'bucket_name' && !r2Bucket) {
      r2Bucket = val.trim();
    } else if (section === 'routes' && key === 'pattern' && !routePattern) {
      routePattern = val.trim();
    }
  }
  return { dbName, r2Bucket, routePattern };
}

export function loadWranglerBindings(repoDir: string, siteUrlOverride?: string): WranglerBindings {
  const candidates = [
    path.join(repoDir, 'wrangler.jsonc'),
    path.join(repoDir, 'wrangler.json'),
    path.join(repoDir, 'wrangler.toml'),
  ];
  const configPath = candidates.find((candidate) => fs.existsSync(candidate));

  if (!configPath) {
    throw new CliValidationError(`Missing wrangler.jsonc, wrangler.json, or wrangler.toml under ${repoDir}.`);
  }

  const raw = fs.readFileSync(configPath, 'utf8');
  let dbName = '';
  let r2Bucket = '';
  let routePattern = '';

  if (configPath.endsWith('.toml')) {
    const parsedToml = parseWranglerTomlBindings(raw);
    dbName = parsedToml.dbName;
    r2Bucket = parsedToml.r2Bucket;
    routePattern = parsedToml.routePattern;
  } else {
    let parsed: unknown;
    try {
      parsed = JSON.parse(stripJsoncCommentsAndTrailingCommas(raw));
    } catch (err: unknown) {
      throw new CliValidationError(
        `Failed to parse ${configPath}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    if (!isPlainRecord(parsed)) {
      throw new CliValidationError(`Expected a JSON object in ${configPath}.`);
    }

    const d1List = Array.isArray(parsed.d1_databases) ? parsed.d1_databases : [];
    const r2List = Array.isArray(parsed.r2_buckets) ? parsed.r2_buckets : [];
    const routesList = Array.isArray(parsed.routes) ? parsed.routes : [];

    const firstD1 = isPlainRecord(d1List[0]) ? d1List[0] : null;
    const firstR2 = isPlainRecord(r2List[0]) ? r2List[0] : null;
    const firstRoute = isPlainRecord(routesList[0]) ? routesList[0] : null;

    dbName = typeof firstD1?.database_name === 'string' ? firstD1.database_name.trim() : '';
    r2Bucket = typeof firstR2?.bucket_name === 'string' ? firstR2.bucket_name.trim() : '';
    routePattern =
      typeof firstRoute?.pattern === 'string'
        ? firstRoute.pattern.trim()
        : typeof routesList[0] === 'string'
          ? routesList[0].trim()
          : '';
  }

  if (!dbName) {
    throw new CliValidationError(`Could not read d1_databases[0].database_name from ${configPath}.`);
  }
  if (!r2Bucket) {
    throw new CliValidationError(`Could not read r2_buckets[0].bucket_name from ${configPath}.`);
  }

  let resolved: { baseUrl: string; domain: string };
  if (siteUrlOverride && siteUrlOverride.trim().length > 0) {
    resolved = normalizeSiteUrl(siteUrlOverride);
  } else if (routePattern.length > 0) {
    const cleanedHost = routePattern
      .replace(/^https?:\/\//i, '')
      .replace(/\/.*$/, '')
      .trim();
    if (!cleanedHost) {
      throw new CliValidationError(
        `Could not derive a site URL from routes[0].pattern '${routePattern}' in ${configPath}. Pass --site-url <url>.`
      );
    }
    resolved = normalizeSiteUrl(`https://${cleanedHost}`);
  } else {
    throw new CliValidationError(
      `No --site-url provided and no routes[0].pattern found in ${configPath}. Pass --site-url <url>.`
    );
  }

  return {
    configPath,
    dbName,
    r2Bucket,
    domain: resolved.domain,
    baseUrl: resolved.baseUrl,
  };
}

function resolveWranglerBin(repoDir: string, explicitBin?: string): string {
  if (explicitBin && explicitBin.trim().length > 0) {
    return explicitBin.trim();
  }
  const localBin = path.join(repoDir, 'node_modules', '.bin', 'wrangler');
  if (fs.existsSync(localBin)) {
    return localBin;
  }
  return 'wrangler';
}

const defaultWranglerExecutor: WranglerExecutor = async (wranglerBin, args, options) => {
  const { stdout, stderr } = await execFileAsync(wranglerBin, [...args], {
    cwd: options.cwd,
    encoding: 'utf8',
    maxBuffer: options.maxBufferBytes,
    timeout: options.timeoutMs,
  });
  return { stdout, stderr };
};

export function sqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export function generateTempToken(scope: 'read_backup' | 'write_batch'): MintedTempToken {
  const prefix = scope === 'write_batch' ? TEMP_TOKEN_ID_PREFIX : `${TEMP_TOKEN_ID_PREFIX}read_`;
  const tokenId = `${prefix}${randomUUID()}`;
  const rawToken = randomBytes(32).toString('base64url');
  const tokenHash = createHash('sha256').update(rawToken).digest('hex');
  return { tokenId, rawToken, tokenHash, scope };
}

export function buildTempTokenInsertSql(
  tokens: readonly Pick<MintedTempToken, 'tokenId' | 'tokenHash' | 'scope'>[],
  nowIso: string
): string {
  const statements: string[] = [];
  for (const token of tokens) {
    if (!token.tokenId.startsWith(TEMP_TOKEN_ID_PREFIX)) {
      throw new Error(
        `Refusing to mint temp token without required '${TEMP_TOKEN_ID_PREFIX}' prefix: ${token.tokenId}`
      );
    }
    statements.push(
      `INSERT INTO agent_tokens (token_id, token_hash, label, scope, created_by, created_at, revoked_at) VALUES (${sqlLiteral(
        token.tokenId
      )}, ${sqlLiteral(token.tokenHash)}, ${sqlLiteral(TEMP_TOKEN_LABEL)}, ${sqlLiteral(
        token.scope
      )}, ${sqlLiteral('kinloom sync')}, ${sqlLiteral(nowIso)}, NULL);`
    );
  }
  return statements.join(' ');
}

export function buildTempTokenCleanupSql(
  tokenIds: readonly string[],
  backupTokenLabel = DEFAULT_BACKUP_TOKEN_LABEL
): string {
  if (tokenIds.length === 0) {
    throw new Error('Cannot build temp token cleanup SQL with empty tokenIds list.');
  }
  const statements: string[] = [];
  for (const id of tokenIds) {
    if (!id.startsWith(TEMP_TOKEN_ID_PREFIX)) {
      throw new Error(
        `SAFETY REFUSAL: Refusing to delete non-temporary token_id '${id}'. Only '${TEMP_TOKEN_ID_PREFIX}*' tokens may be deleted.`
      );
    }
    statements.push(`DELETE FROM agent_tokens WHERE token_id = ${sqlLiteral(id)};`);
  }
  statements.push(
    `SELECT COUNT(*) AS count FROM agent_tokens WHERE label = ${sqlLiteral(
      backupTokenLabel
    )} AND revoked_at IS NULL;`
  );
  statements.push(
    `SELECT COUNT(*) AS count FROM agent_tokens WHERE token_id IN (${tokenIds.map(sqlLiteral).join(', ')});`
  );
  return statements.join(' ');
}

interface D1StatementResult {
  success?: boolean;
  results?: Array<Record<string, unknown>>;
}

async function executeD1(ctx: SyncExecutionContext, sql: string): Promise<D1StatementResult[]> {
  const { stdout } = await ctx.execWrangler(
    ctx.wranglerBin,
    [
      'd1',
      'execute',
      ctx.bindings.dbName,
      '--remote',
      '--json',
      '--config',
      ctx.bindings.configPath,
      '--command',
      sql,
    ],
    {
      cwd: ctx.repoDir,
      maxBufferBytes: 16 * 1024 * 1024,
      timeoutMs: 45_000,
    }
  );

  const jsonStart = stdout.indexOf('[');
  if (jsonStart === -1) {
    throw new Error(`Unexpected wrangler D1 output for ${ctx.bindings.dbName}.`);
  }
  const parsed: unknown = JSON.parse(stdout.slice(jsonStart));
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error(`Empty wrangler D1 response for ${ctx.bindings.dbName}.`);
  }
  const results: D1StatementResult[] = [];
  for (const stmt of parsed) {
    if (!isPlainRecord(stmt) || stmt.success !== true) {
      throw new Error(`D1 statement failed on ${ctx.bindings.dbName}.`);
    }
    results.push({
      success: true,
      results: Array.isArray(stmt.results) ? stmt.results.filter(isPlainRecord) : [],
    });
  }
  return results;
}

async function mintTempTokens(
  ctx: SyncExecutionContext
): Promise<{ read_backup: MintedTempToken; write_batch: MintedTempToken }> {
  const readToken = generateTempToken('read_backup');
  const writeToken = generateTempToken('write_batch');
  const sql = buildTempTokenInsertSql([readToken, writeToken], new Date().toISOString());
  await executeD1(ctx, sql);
  return { read_backup: readToken, write_batch: writeToken };
}

async function cleanupTempTokens(
  ctx: SyncExecutionContext,
  tokenIds: readonly string[]
): Promise<SyncCleanupSummary> {
  const sql = buildTempTokenCleanupSql(tokenIds, ctx.backupTokenLabel);
  const results = await executeD1(ctx, sql);

  const backupRow = results[results.length - 2]?.results?.[0];
  const remainingTmpRow = results[results.length - 1]?.results?.[0];
  const backupCount = Number(backupRow?.count ?? 0);
  const remainingTmpCount = Number(remainingTmpRow?.count ?? -1);

  if (remainingTmpCount !== 0) {
    throw new Error(
      `Temporary token cleanup verification failed: ${remainingTmpCount} temp token(s) still present.`
    );
  }

  return {
    deletedTokenIds: [...tokenIds],
    remainingTmpCount,
    backupTokenLabel: ctx.backupTokenLabel,
    backupCount,
  };
}

async function readOptionalUtf8(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, 'utf8');
  } catch (err: unknown) {
    if (typeof err === 'object' && err !== null && 'code' in err && err.code === 'ENOENT') {
      return null;
    }
    throw err;
  }
}

async function loadLocalArchive(repoDir: string): Promise<LocalArchiveFiles> {
  const dataDir = path.join(repoDir, 'data');
  const configPath = path.join(repoDir, 'kinloom.config.yaml');

  const [
    configText,
    placesText,
    sourcesText,
    peopleText,
    eventsText,
    kinshipText,
    mediaText,
    narrativesText,
  ] = await Promise.all([
    readOptionalUtf8(configPath),
    readOptionalUtf8(path.join(dataDir, 'places.yaml')),
    readOptionalUtf8(path.join(dataDir, 'sources.yaml')),
    readOptionalUtf8(path.join(dataDir, 'people.yaml')),
    readOptionalUtf8(path.join(dataDir, 'events.yaml')),
    readOptionalUtf8(path.join(dataDir, 'kinship.yaml')),
    readOptionalUtf8(path.join(dataDir, 'media.yaml')),
    readOptionalUtf8(path.join(dataDir, 'narratives.yaml')),
  ]);

  if (!configText) {
    throw new CliValidationError(`Missing kinloom.config.yaml at ${configPath}.`);
  }

  const siteConfig = parseKinloomConfigYaml(configText);
  return {
    siteConfig,
    places: placesText ? parsePlacesYaml(placesText) : [],
    sources: sourcesText ? parseSourcesYaml(sourcesText) : [],
    people: peopleText ? parsePeopleYaml(peopleText) : [],
    events: eventsText ? parseEventsYaml(eventsText) : [],
    kinship: kinshipText ? parseKinshipYaml(kinshipText) : [],
    media: mediaText ? parseMediaYaml(mediaText) : [],
    narratives: narrativesText ? parseNarrativesYaml(narrativesText) : [],
  };
}

function normalizeForDiff(entityType: EntityType, data: EntityPayload): EntityPayload {
  if (entityType === 'kinship_edge') {
    return data;
  }
  return {
    ...data,
    has_primary_source: data.has_primary_source ?? true,
  };
}

export function buildSanitizedLocalEntries(local: LocalArchiveFiles): {
  byType: Record<EntityType, SanitizedLocalEntry[]>;
  livingIds: Set<string>;
  filteredOutMediaCount: number;
} {
  const privacy = local.siteConfig.privacy;
  const livingIds = new Set<string>();

  const sanitizedPeople: SanitizedLocalEntry[] = local.people.map((person) => {
    const isLiving = resolveEffectiveLiving(person, privacy);
    if (isLiving) {
      livingIds.add(person.id);
    }
    const sanitized = sanitizePersonForWrite(person, privacy);
    return {
      entity_type: 'person',
      entity_id: sanitized.id,
      data: parseEntityPayload('person', sanitized),
      has_primary_source: sanitized.has_primary_source ?? true,
      isLiving,
    };
  });

  const sanitizedEvents: SanitizedLocalEntry[] = local.events.map((event) => {
    const sanitized = sanitizeEventForWrite(event, livingIds, privacy);
    return {
      entity_type: 'event',
      entity_id: sanitized.id,
      data: parseEntityPayload('event', sanitized),
      has_primary_source: sanitized.has_primary_source ?? true,
      isLiving: false,
    };
  });

  const peopleById = new Map<string, RawPerson>(
    sanitizedPeople.map((p) => [p.entity_id, parseEntityPayload('person', p.data)])
  );
  const eventsById = new Map<string, Pick<RawEvent, 'id' | 'participants'>>(
    sanitizedEvents.map((e) => {
      const parsed = parseEntityPayload('event', e.data);
      return [e.entity_id, { id: e.entity_id, participants: parsed.participants }];
    })
  );

  const allowedMedia = filterMediaForPrivacy(local.media, peopleById, eventsById, {
    stripLivingPortraits: privacy.stripLivingPortraits,
  });

  const byType: Record<EntityType, SanitizedLocalEntry[]> = {
    place: local.places.map((item) => ({
      entity_type: 'place',
      entity_id: item.id,
      data: parseEntityPayload('place', item),
      has_primary_source: item.has_primary_source ?? true,
      isLiving: false,
    })),
    source: local.sources.map((item) => ({
      entity_type: 'source',
      entity_id: item.id,
      data: parseEntityPayload('source', item),
      has_primary_source: item.has_primary_source ?? true,
      isLiving: false,
    })),
    person: sanitizedPeople,
    event: sanitizedEvents,
    kinship_edge: local.kinship.map((edge) => ({
      entity_type: 'kinship_edge',
      entity_id: deriveKinshipEdgeId(edge),
      data: parseEntityPayload('kinship_edge', edge),
      has_primary_source: true,
      isLiving: false,
    })),
    media: allowedMedia.map((item) => ({
      entity_type: 'media',
      entity_id: item.id,
      data: parseEntityPayload('media', item),
      has_primary_source: item.has_primary_source ?? true,
      isLiving: false,
    })),
    narrative: local.narratives.map((item) => ({
      entity_type: 'narrative',
      entity_id: item.id,
      data: parseEntityPayload('narrative', item),
      has_primary_source: item.has_primary_source ?? true,
      isLiving: false,
    })),
  };

  return {
    byType,
    livingIds,
    filteredOutMediaCount: local.media.length - allowedMedia.length,
  };
}

async function fetchRemoteSnapshot(
  ctx: SyncExecutionContext,
  readToken: string
): Promise<{ etag: string | null; headRevisionId: number; snapshot: RemoteSnapshotResponse }> {
  const response = await ctx.fetchImpl(`${ctx.bindings.baseUrl}/api/export/snapshot`, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${readToken}`,
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`GET /api/export/snapshot failed with HTTP ${response.status}: ${text.slice(0, 300)}`);
  }

  const body: unknown = await response.json();
  const snapshotRaw = isPlainRecord(body) && isPlainRecord(body.snapshot) ? body.snapshot : body;
  if (
    !isPlainRecord(snapshotRaw) ||
    !Array.isArray(snapshotRaw.entities) ||
    !Array.isArray(snapshotRaw.kinship)
  ) {
    throw new Error('Unexpected response shape from GET /api/export/snapshot.');
  }

  const headRaw = snapshotRaw.head_revision_id ?? (isPlainRecord(body) ? body.head_revision_id : 0) ?? 0;

  return {
    etag: response.headers.get('etag'),
    headRevisionId: Number(headRaw),
    snapshot: snapshotRaw as unknown as RemoteSnapshotResponse,
  };
}

export function indexRemoteSnapshot(
  snapshot: RemoteSnapshotResponse
): Record<EntityType, Map<string, RemoteEntityEntry>> {
  const byType: Record<EntityType, Map<string, RemoteEntityEntry>> = {
    place: new Map(),
    source: new Map(),
    person: new Map(),
    event: new Map(),
    kinship_edge: new Map(),
    media: new Map(),
    narrative: new Map(),
  };

  for (const row of snapshot.entities) {
    if (row.deleted_at !== null && row.deleted_at !== undefined) {
      continue;
    }
    const rawData: EntityPayload =
      row.data.has_primary_source === undefined && row.has_primary_source === false
        ? { ...row.data, has_primary_source: false }
        : row.data;
    const normalized = parseEntityPayload(row.entity_type, rawData);
    byType[row.entity_type].set(row.entity_id, {
      revisionId: Number(row.current_revision_id),
      data: normalized,
      has_primary_source: row.has_primary_source !== false,
    });
  }

  for (const row of snapshot.kinship) {
    if (row.deleted_at !== null && row.deleted_at !== undefined) {
      continue;
    }
    const normalized = parseEntityPayload('kinship_edge', row.edge);
    byType.kinship_edge.set(row.edge_id, {
      revisionId: Number(row.current_revision_id),
      data: normalized,
      has_primary_source: true,
    });
  }

  return byType;
}

export function computeSyncPlan(params: {
  selectedTypes: readonly EntityType[];
  localByType: Readonly<Record<EntityType, readonly SanitizedLocalEntry[]>>;
  remoteByType: Readonly<Record<EntityType, ReadonlyMap<string, RemoteEntityEntry>>>;
  includeLiving: boolean;
  allowDeletes: boolean;
  explicitDeletes: readonly SyncDeleteTarget[];
}): SyncPlan {
  const patches: EntityPatch[] = [];
  const countsByType: Partial<Record<EntityType, SyncTypeCounts>> = {};
  const changedSamples: SyncChangedSample[] = [];
  const plannedDeleteKeys = new Set<string>();

  for (const entityType of params.selectedTypes) {
    const localEntries = params.localByType[entityType] ?? [];
    const remoteMap = params.remoteByType[entityType] ?? new Map<string, RemoteEntityEntry>();
    const localIds = new Set<string>();

    let created = 0;
    let updated = 0;
    let unchanged = 0;
    let deleted = 0;
    let skippedLiving = 0;

    for (const entry of localEntries) {
      localIds.add(entry.entity_id);
      if (entityType === 'person' && entry.isLiving && !params.includeLiving) {
        skippedLiving += 1;
        continue;
      }

      const remote = remoteMap.get(entry.entity_id);
      if (!remote) {
        patches.push({
          action: 'create',
          entity_type: entityType,
          entity_id: entry.entity_id,
          data: entry.data,
          has_primary_source: entry.has_primary_source,
        });
        created += 1;
        if (changedSamples.length < 25) {
          changedSamples.push({
            action: 'create',
            entity_type: entityType,
            entity_id: entry.entity_id,
          });
        }
        continue;
      }

      const diff = computeEntityDiff(
        normalizeForDiff(entityType, remote.data),
        normalizeForDiff(entityType, entry.data)
      );
      if (!diff.hasChanges) {
        unchanged += 1;
        continue;
      }

      patches.push({
        action: 'update',
        entity_type: entityType,
        entity_id: entry.entity_id,
        ...(remote.revisionId > 0 ? { parent_revision_id: remote.revisionId } : {}),
        data: entry.data,
        merge: false,
        has_primary_source: entry.has_primary_source,
      });
      updated += 1;
      if (changedSamples.length < 25) {
        changedSamples.push({
          action: 'update',
          entity_type: entityType,
          entity_id: entry.entity_id,
          changedFields: diff.fields.slice(0, 6).map((f) => f.path),
        });
      }
    }

    if (params.allowDeletes) {
      for (const [remoteId, remote] of remoteMap.entries()) {
        if (localIds.has(remoteId)) {
          continue;
        }
        const key = `${entityType}:${remoteId}`;
        plannedDeleteKeys.add(key);
        patches.push({
          action: 'delete',
          entity_type: entityType,
          entity_id: remoteId,
          ...(remote.revisionId > 0 ? { parent_revision_id: remote.revisionId } : {}),
        });
        deleted += 1;
        if (changedSamples.length < 25) {
          changedSamples.push({
            action: 'delete',
            entity_type: entityType,
            entity_id: remoteId,
          });
        }
      }
    }

    countsByType[entityType] = {
      local: localEntries.length,
      remote: remoteMap.size,
      create: created,
      update: updated,
      delete: deleted,
      unchanged,
      skippedLiving,
    };
  }

  for (const target of params.explicitDeletes) {
    const key = `${target.entity_type}:${target.entity_id}`;
    if (plannedDeleteKeys.has(key)) {
      continue;
    }
    const remoteMap = params.remoteByType[target.entity_type];
    const remote = remoteMap.get(target.entity_id);
    if (!remote) {
      continue;
    }
    plannedDeleteKeys.add(key);
    patches.push({
      action: 'delete',
      entity_type: target.entity_type,
      entity_id: target.entity_id,
      ...(remote.revisionId > 0 ? { parent_revision_id: remote.revisionId } : {}),
    });
    const existingCounts = countsByType[target.entity_type];
    if (existingCounts) {
      existingCounts.delete += 1;
    } else {
      countsByType[target.entity_type] = {
        local: params.localByType[target.entity_type].length,
        remote: remoteMap.size,
        create: 0,
        update: 0,
        delete: 1,
        unchanged: 0,
        skippedLiving: 0,
      };
    }
    if (changedSamples.length < 25) {
      changedSamples.push({
        action: 'delete',
        entity_type: target.entity_type,
        entity_id: target.entity_id,
      });
    }
  }

  return { patches, countsByType, changedSamples };
}

function guessMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_BY_EXT[ext] ?? 'application/octet-stream';
}

function detectSyncMediaLayout(repoDir: string): 'archive-media' | 'media' {
  const archiveMediaDir = path.join(repoDir, 'archive-media');
  if (fs.existsSync(archiveMediaDir) && fs.statSync(archiveMediaDir).isDirectory()) {
    return 'archive-media';
  }
  return 'media';
}

function resolveMediaUploadTarget(
  repoDir: string,
  mediaLayout: 'archive-media' | 'media',
  rawInput: string
): MediaUploadTarget {
  const mediaRoot = mediaLayout === 'archive-media' ? path.join(repoDir, 'archive-media') : repoDir;

  let localPath: string;
  let r2Key: string;

  if (rawInput.startsWith('/media/') || rawInput.startsWith('media/')) {
    const cleanRel = rawInput.replace(/^\/+/, '');
    localPath = path.join(mediaRoot, cleanRel);
    r2Key = cleanRel;
  } else {
    localPath = path.isAbsolute(rawInput) ? path.resolve(rawInput) : path.resolve(repoDir, rawInput);
    const relFromArchiveMedia = path.relative(path.join(repoDir, 'archive-media'), localPath);
    const relFromRepo = path.relative(repoDir, localPath);

    if (mediaLayout === 'archive-media' && !relFromArchiveMedia.startsWith('..')) {
      r2Key = relFromArchiveMedia.split(path.sep).join('/');
    } else if (!relFromRepo.startsWith('..') && relFromRepo.startsWith(`media${path.sep}`)) {
      r2Key = relFromRepo.split(path.sep).join('/');
    } else {
      const base = path.basename(localPath);
      r2Key = mediaLayout === 'archive-media' ? `media/scans/${base}` : `media/${base}`;
    }
  }

  if (!fs.existsSync(localPath)) {
    throw new CliValidationError(`Media file not found on disk: ${localPath} (from '${rawInput}').`);
  }

  return {
    localPath,
    r2Key,
    contentType: guessMimeType(localPath),
  };
}

async function runWithConcurrency<TItem, TOut>(
  items: readonly TItem[],
  limit: number,
  worker: (item: TItem, idx: number) => Promise<TOut>
): Promise<TOut[]> {
  const results: TOut[] = Array.from({ length: items.length });
  let nextIndex = 0;
  const workerCount = Math.min(limit, items.length);

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (true) {
        const idx = nextIndex;
        nextIndex += 1;
        if (idx >= items.length) {
          return;
        }
        results[idx] = await worker(items[idx], idx);
      }
    })
  );

  return results;
}

async function findMissingRemoteMedia(
  ctx: SyncExecutionContext,
  writeToken: string,
  mediaEntries: readonly SanitizedLocalEntry[]
): Promise<{ checkedCount: number; missing: MediaUploadTarget[] }> {
  const mediaRoot =
    ctx.mediaLayout === 'archive-media' ? path.join(ctx.repoDir, 'archive-media') : ctx.repoDir;

  const candidates: Array<MediaUploadTarget & { url: string }> = [];
  const seenKeys = new Set<string>();
  for (const entry of mediaEntries) {
    const fileUrl = typeof entry.data.file === 'string' ? entry.data.file.trim() : '';
    if (!fileUrl.startsWith('/media/')) {
      continue;
    }
    const r2Key = fileUrl.replace(/^\/+/, '');
    if (seenKeys.has(r2Key)) {
      continue;
    }
    seenKeys.add(r2Key);
    const localPath = path.join(mediaRoot, r2Key);
    if (!fs.existsSync(localPath)) {
      continue;
    }
    const mime =
      typeof entry.data.mime_type === 'string' && entry.data.mime_type.trim()
        ? entry.data.mime_type.trim()
        : guessMimeType(localPath);
    candidates.push({
      localPath,
      r2Key,
      contentType: mime,
      url: `${ctx.bindings.baseUrl}/${r2Key}`,
    });
  }

  const probeResults = await runWithConcurrency(candidates, MEDIA_PROBE_CONCURRENCY, async (cand) => {
    const resp = await ctx.fetchImpl(cand.url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${writeToken}`,
        Range: 'bytes=0-0',
      },
    });
    await resp.body?.cancel().catch(() => undefined);
    return {
      localPath: cand.localPath,
      r2Key: cand.r2Key,
      contentType: cand.contentType,
      existsRemote: resp.status === 200 || resp.status === 206,
    };
  });

  return {
    checkedCount: candidates.length,
    missing: probeResults
      .filter((r) => !r.existsRemote)
      .map(({ localPath, r2Key, contentType }) => ({ localPath, r2Key, contentType })),
  };
}

async function uploadMediaTargets(
  ctx: SyncExecutionContext,
  targets: readonly MediaUploadTarget[],
  concurrency: number
): Promise<string[]> {
  if (targets.length === 0) {
    return [];
  }
  return runWithConcurrency(targets, concurrency, async (target) => {
    await ctx.execWrangler(
      ctx.wranglerBin,
      [
        'r2',
        'object',
        'put',
        `${ctx.bindings.r2Bucket}/${target.r2Key}`,
        '--file',
        target.localPath,
        '--content-type',
        target.contentType,
        '--remote',
        '--config',
        ctx.bindings.configPath,
      ],
      {
        cwd: ctx.repoDir,
        maxBufferBytes: 8 * 1024 * 1024,
        timeoutMs: 60_000,
      }
    );
    return target.r2Key;
  });
}

async function submitPatchChunks(params: {
  ctx: SyncExecutionContext;
  writeToken: string;
  batchLabel: string;
  summary: string;
  patches: readonly EntityPatch[];
  chunkSize: number;
}): Promise<SyncSubmittedBatch[]> {
  const totalChunks = Math.ceil(params.patches.length / params.chunkSize);
  const padWidth = String(totalChunks).length;
  const runStamp = new Date()
    .toISOString()
    .replaceAll(/[^0-9]/g, '')
    .slice(0, 14);
  const safeLabel =
    params.batchLabel
      .toLowerCase()
      .replaceAll(/[^a-z0-9-]+/g, '-')
      .replaceAll(/^-|-$/g, '') || 'archive';
  const baseBatchId = `sync-${safeLabel}-${runStamp}-${randomBytes(3).toString('hex')}`;

  const responses: SyncSubmittedBatch[] = [];
  for (let i = 0; i < totalChunks; i += 1) {
    const slice = params.patches.slice(i * params.chunkSize, (i + 1) * params.chunkSize);
    const batchId =
      totalChunks === 1 ? baseBatchId : `${baseBatchId}-p${String(i + 1).padStart(padWidth, '0')}`;
    const chunkSummary =
      totalChunks === 1 ? params.summary : `${params.summary} (part ${i + 1}/${totalChunks})`;

    const payload = {
      batch_id: batchId,
      author_type: 'agent',
      summary: chunkSummary,
      has_primary_source: true,
      patches: slice,
    };

    const response = await params.ctx.fetchImpl(`${params.ctx.bindings.baseUrl}/api/batches`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: `Bearer ${params.writeToken}`,
      },
      body: JSON.stringify(payload),
    });

    const text = await response.text();
    if (!response.ok) {
      throw new Error(
        `POST /api/batches (${batchId}, ${slice.length} patches) failed with HTTP ${response.status}: ${text.slice(0, 500)}`
      );
    }

    const parsed: unknown = JSON.parse(text);
    const parsedRec = isPlainRecord(parsed) ? parsed : {};
    responses.push({
      batch_id: typeof parsedRec.batch_id === 'string' ? parsedRec.batch_id : batchId,
      patchCount: slice.length,
      head_revision_id: Number(parsedRec.head_revision_id ?? 0),
      etag: typeof parsedRec.etag === 'string' ? parsedRec.etag : '',
    });
  }

  return responses;
}

async function purgeCompiledBundleAndRecompile(
  ctx: SyncExecutionContext,
  bearerToken: string
): Promise<SyncRecompileSummary> {
  await ctx.execWrangler(
    ctx.wranglerBin,
    [
      'r2',
      'object',
      'delete',
      `${ctx.bindings.r2Bucket}/compiled/archive.json`,
      '--remote',
      '--config',
      ctx.bindings.configPath,
    ],
    {
      cwd: ctx.repoDir,
      maxBufferBytes: 4 * 1024 * 1024,
      timeoutMs: 45_000,
    }
  );

  const response = await ctx.fetchImpl(`${ctx.bindings.baseUrl}/api/bundle`, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${bearerToken}`,
      'Cache-Control': 'no-cache',
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Post-purge GET /api/bundle failed with HTTP ${response.status}: ${text.slice(0, 300)}`);
  }

  const bundle: unknown = await response.json();
  const meta = isPlainRecord(bundle) && isPlainRecord(bundle.meta) ? bundle.meta : null;
  const maxRevisionId = typeof meta?.max_revision_id === 'number' ? meta.max_revision_id : null;
  const counts = isPlainRecord(meta?.counts) ? (meta.counts as ArchiveBundle['meta']['counts']) : null;

  return {
    httpStatus: response.status,
    etag: response.headers.get('etag'),
    maxRevisionId,
    counts,
  };
}

async function verifyLiveEndpoints(params: {
  ctx: SyncExecutionContext;
  writeToken: string;
  expectedRevision: number | null;
  uploadedKeys: readonly string[];
  concurrency: number;
}): Promise<SyncLiveVerificationSummary> {
  const failures: SyncLiveVerificationFailure[] = [];
  let bundleStatus: number | null = null;
  let bundleRevision: number | null = null;

  const bundleUrl = `${params.ctx.bindings.baseUrl}/api/bundle`;
  try {
    const response = await params.ctx.fetchImpl(bundleUrl, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${params.writeToken}`,
        'Cache-Control': 'no-cache',
      },
      signal: AbortSignal.timeout(LIVE_VERIFY_TIMEOUT_MS),
    });
    bundleStatus = response.status;
    if (response.status !== 200) {
      const text = await response.text().catch(() => '');
      failures.push({
        target: 'bundle',
        url: bundleUrl,
        status: response.status,
        reason: `Expected HTTP 200 from /api/bundle, got HTTP ${response.status}${text.trim() ? `: ${text.trim().slice(0, 160)}` : ''}`,
      });
    } else {
      let body: unknown;
      try {
        body = await response.json();
      } catch (err: unknown) {
        failures.push({
          target: 'bundle',
          url: bundleUrl,
          status: response.status,
          reason: `Invalid JSON from /api/bundle: ${err instanceof Error ? err.message : String(err)}`,
        });
        body = null;
      }
      if (body !== null) {
        const meta = isPlainRecord(body) && isPlainRecord(body.meta) ? body.meta : null;
        bundleRevision = typeof meta?.max_revision_id === 'number' ? meta.max_revision_id : null;
        if (params.expectedRevision !== null && bundleRevision !== params.expectedRevision) {
          failures.push({
            target: 'bundle',
            url: bundleUrl,
            status: response.status,
            reason: `Bundle revision mismatch: expected r${params.expectedRevision}, got ${bundleRevision !== null ? `r${bundleRevision}` : 'none'}`,
          });
        }
      }
    }
  } catch (err: unknown) {
    failures.push({
      target: 'bundle',
      url: bundleUrl,
      status: null,
      reason: err instanceof Error ? err.message : String(err),
    });
  }

  let mediaFailed = 0;
  const probeConcurrency = Math.max(1, Math.min(params.concurrency, LIVE_VERIFY_CONCURRENCY));
  const mediaProbeFailures = await runWithConcurrency(
    params.uploadedKeys,
    probeConcurrency,
    async (r2Key): Promise<SyncLiveVerificationFailure | null> => {
      const mediaUrl = `${params.ctx.bindings.baseUrl}/${r2Key}`;
      try {
        const response = await params.ctx.fetchImpl(mediaUrl, {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${params.writeToken}`,
            'Cache-Control': 'no-cache',
          },
          signal: AbortSignal.timeout(LIVE_VERIFY_TIMEOUT_MS),
        });
        if (response.status !== 200) {
          await response.body?.cancel().catch(() => undefined);
          return {
            target: r2Key,
            url: mediaUrl,
            status: response.status,
            reason: `Expected HTTP 200, got HTTP ${response.status}`,
          };
        }

        const contentLengthHeader = response.headers.get('content-length');
        if (contentLengthHeader !== null && Number(contentLengthHeader) === 0) {
          await response.body?.cancel().catch(() => undefined);
          return {
            target: r2Key,
            url: mediaUrl,
            status: response.status,
            reason: 'Empty response (content-length: 0)',
          };
        }

        let firstChunkBytes = 0;
        const reader = response.body?.getReader();
        if (reader) {
          try {
            while (firstChunkBytes === 0) {
              const chunk = await reader.read();
              if (chunk.done) {
                break;
              }
              firstChunkBytes = chunk.value ? chunk.value.byteLength : 0;
            }
          } finally {
            await reader.cancel().catch(() => undefined);
          }
        } else {
          const buf = await response.arrayBuffer();
          firstChunkBytes = buf.byteLength;
        }

        if (firstChunkBytes === 0) {
          return {
            target: r2Key,
            url: mediaUrl,
            status: response.status,
            reason: 'Empty response body (0 bytes)',
          };
        }

        return null;
      } catch (err: unknown) {
        return {
          target: r2Key,
          url: mediaUrl,
          status: null,
          reason: err instanceof Error ? err.message : String(err),
        };
      }
    }
  );

  for (const failure of mediaProbeFailures) {
    if (failure) {
      mediaFailed += 1;
      failures.push(failure);
    }
  }

  return {
    ok: failures.length === 0,
    bundleStatus,
    bundleRevision,
    expectedRevision: params.expectedRevision,
    mediaChecked: params.uploadedKeys.length,
    mediaFailed,
    failures,
  };
}

export function formatSyncReport(report: Omit<SyncCommandResult, 'rendered'>): string {
  const lines: string[] = [
    `Archive: ${report.baseUrl}`,
    `Mode: ${report.dryRun ? 'DRY RUN (no remote D1/R2 mutations)' : 'LIVE SYNC'}`,
    `Bindings: D1=${report.dbName}, R2=${report.r2Bucket}`,
    `Remote head before sync: r${report.remoteHeadBefore} (etag=${report.remoteEtagBefore ?? 'none'})`,
    `Entity diff by type (${report.selectedTypes.join(', ')}):`,
  ];

  for (const type of SYNC_DEPENDENCY_ORDER) {
    const c = report.countsByType[type];
    if (!c) {
      continue;
    }
    const parts = [
      `local=${c.local}`,
      `remote=${c.remote}`,
      `create=${c.create}`,
      `update=${c.update}`,
      `delete=${c.delete}`,
      `unchanged=${c.unchanged}`,
    ];
    if (c.skippedLiving > 0) {
      parts.push(`skipped_living=${c.skippedLiving}`);
    }
    lines.push(`  - ${type}: ${parts.join(', ')}`);
  }

  lines.push(
    `Planned patches: ${report.totalPatches} (chunk_size=${report.chunkSize}, planned_batches=${report.plannedBatches})`
  );

  if (report.changedSamples.length > 0) {
    lines.push('Sample planned changes:');
    for (const sample of report.changedSamples) {
      const fields = sample.changedFields?.length ? ` [${sample.changedFields.join(', ')}]` : '';
      lines.push(`  - ${sample.action} ${sample.entity_type}:${sample.entity_id}${fields}`);
    }
  }

  if (report.media.checkedRemoteCount > 0 || report.media.plannedUploads.length > 0) {
    lines.push(
      `Media R2 sync: checked=${report.media.checkedRemoteCount}, planned_uploads=${report.media.plannedUploads.length}, uploaded=${report.media.uploadedKeys.length}, concurrency=${report.media.concurrency}`
    );
  }

  if (report.batchesSubmitted.length > 0) {
    lines.push(`Batches submitted: ${report.batchesSubmitted.length}`);
    const last = report.batchesSubmitted[report.batchesSubmitted.length - 1];
    lines.push(`Last batch: ${last.batch_id} -> r${last.head_revision_id} (${last.etag})`);
  }

  if (report.recompile) {
    lines.push(
      `Recompiled live /api/bundle: HTTP ${report.recompile.httpStatus}, ETag=${report.recompile.etag ?? 'none'}, max_revision_id=${report.recompile.maxRevisionId}`
    );
  }

  if (report.liveVerification) {
    const lv = report.liveVerification;
    lines.push(
      `Live verification [${lv.ok ? 'PASS' : 'FAIL'}]: bundle=HTTP ${lv.bundleStatus ?? 'error'} (rev=${lv.bundleRevision ?? 'none'}, expected=${lv.expectedRevision ?? 'none'}), media=${lv.mediaChecked - lv.mediaFailed}/${lv.mediaChecked} ok`
    );
    for (const failure of lv.failures) {
      lines.push(`  VERIFY FAIL [${failure.target}] ${failure.url}: ${failure.reason}`);
    }
  }

  if (report.cleanup) {
    lines.push(
      `Token cleanup: deleted ${report.cleanup.deletedTokenIds.length} temp token(s), verified ${report.cleanup.remainingTmpCount} remaining; active '${report.cleanup.backupTokenLabel}' count=${report.cleanup.backupCount}`
    );
  }

  return `${lines.join('\n')}\n`;
}

export async function runSyncCommand(options: SyncCommandOptions = {}): Promise<SyncCommandResult> {
  const repoDir = path.resolve(options.repoDir?.trim() || process.cwd());
  const selectedTypes: EntityType[] =
    options.types && options.types.length > 0
      ? SYNC_DEPENDENCY_ORDER.filter((t) => options.types?.includes(t))
      : [...SYNC_DEPENDENCY_ORDER];
  const concurrency = options.concurrency ?? DEFAULT_UPLOAD_CONCURRENCY;
  const chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE;
  const dryRun = Boolean(options.dryRun);
  const verifyLive = Boolean(options.verifyLive);
  const includeLiving = Boolean(options.includeLiving);
  const allowDeletes = Boolean(options.allowDeletes);
  const syncMissingMedia = Boolean(options.syncMissingMedia);
  const uploadMediaPaths = options.uploadMediaPaths ?? [];
  const explicitDeletes = options.explicitDeletes ?? [];
  const backupTokenLabel = options.backupTokenLabel?.trim() || DEFAULT_BACKUP_TOKEN_LABEL;

  if (!Number.isInteger(concurrency) || concurrency <= 0) {
    throw new CliValidationError('Option `--concurrency` must be a positive integer.');
  }
  if (!Number.isInteger(chunkSize) || chunkSize <= 0) {
    throw new CliValidationError('Option `--chunk-size` must be a positive integer.');
  }
  if (options.summary !== undefined && options.summary.trim().length < 3) {
    throw new CliValidationError('Option `--summary` requires text of at least 3 characters.');
  }

  const bindings = loadWranglerBindings(repoDir, options.siteUrl);
  const wranglerBin = resolveWranglerBin(repoDir, options.wranglerBin);
  const mediaLayout = detectSyncMediaLayout(repoDir);
  const ctx: SyncExecutionContext = {
    repoDir,
    mediaLayout,
    bindings,
    wranglerBin,
    fetchImpl: options.fetchImpl ?? globalThis.fetch,
    execWrangler: options.execWrangler ?? defaultWranglerExecutor,
    backupTokenLabel,
  };

  const local = await loadLocalArchive(repoDir);
  const sanitizedLocal = buildSanitizedLocalEntries(local);
  const summary =
    options.summary?.trim() || `Sync ${local.siteConfig.site.familyName} archive from local YAML`;

  const minted = await mintTempTokens(ctx);
  const mintedIds = [minted.read_backup.tokenId, minted.write_batch.tokenId];

  let cleanupResult: SyncCleanupSummary | null = null;
  let primaryError: unknown = null;
  let baseReport: Omit<SyncCommandResult, 'rendered'> | null = null;

  try {
    const remoteSnap = await fetchRemoteSnapshot(ctx, minted.read_backup.rawToken);
    const remoteByType = indexRemoteSnapshot(remoteSnap.snapshot);

    const plan = computeSyncPlan({
      selectedTypes,
      localByType: sanitizedLocal.byType,
      remoteByType,
      includeLiving,
      allowDeletes,
      explicitDeletes,
    });

    const mediaUploadTargetsMap = new Map<string, MediaUploadTarget>();
    for (const rawMediaPath of uploadMediaPaths) {
      const target = resolveMediaUploadTarget(repoDir, mediaLayout, rawMediaPath);
      mediaUploadTargetsMap.set(target.r2Key, target);
    }

    let checkedRemoteMediaCount = 0;
    if (syncMissingMedia) {
      const missingRes = await findMissingRemoteMedia(
        ctx,
        minted.write_batch.rawToken,
        sanitizedLocal.byType.media
      );
      checkedRemoteMediaCount = missingRes.checkedCount;
      for (const item of missingRes.missing) {
        mediaUploadTargetsMap.set(item.r2Key, item);
      }
    }

    const mediaUploadTargets = [...mediaUploadTargetsMap.values()];
    let uploadedKeys: string[] = [];
    let batchesSubmitted: SyncSubmittedBatch[] = [];
    let recompile: SyncRecompileSummary | null = null;
    let liveVerification: SyncLiveVerificationSummary | null = null;

    if (!dryRun) {
      if (mediaUploadTargets.length > 0) {
        uploadedKeys = await uploadMediaTargets(ctx, mediaUploadTargets, concurrency);
      }
      if (plan.patches.length > 0) {
        batchesSubmitted = await submitPatchChunks({
          ctx,
          writeToken: minted.write_batch.rawToken,
          batchLabel: local.siteConfig.site.familyName,
          summary,
          patches: plan.patches,
          chunkSize,
        });
        recompile = await purgeCompiledBundleAndRecompile(ctx, minted.write_batch.rawToken);
      }
      if (verifyLive) {
        const expectedRevision =
          batchesSubmitted.length > 0
            ? batchesSubmitted[batchesSubmitted.length - 1].head_revision_id
            : remoteSnap.headRevisionId;
        liveVerification = await verifyLiveEndpoints({
          ctx,
          writeToken: minted.write_batch.rawToken,
          expectedRevision,
          uploadedKeys,
          concurrency,
        });
      }
    }

    baseReport = {
      repoDir,
      baseUrl: bindings.baseUrl,
      dbName: bindings.dbName,
      r2Bucket: bindings.r2Bucket,
      dryRun,
      selectedTypes,
      remoteHeadBefore: remoteSnap.headRevisionId,
      remoteEtagBefore: remoteSnap.etag,
      countsByType: plan.countsByType,
      totalPatches: plan.patches.length,
      chunkSize,
      plannedBatches: Math.ceil(plan.patches.length / chunkSize),
      changedSamples: plan.changedSamples,
      filteredOutLivingMedia: sanitizedLocal.filteredOutMediaCount,
      media: {
        checkedRemoteCount: checkedRemoteMediaCount,
        plannedUploads: mediaUploadTargets.map((t) => t.r2Key),
        uploadedKeys,
        concurrency,
      },
      batchesSubmitted,
      recompile,
      liveVerification,
      cleanup: null,
    };
  } catch (err: unknown) {
    primaryError = err;
  } finally {
    try {
      cleanupResult = await cleanupTempTokens(ctx, mintedIds);
    } catch (cleanupErr: unknown) {
      if (!primaryError) {
        primaryError = cleanupErr;
      }
    }
  }

  if (primaryError !== null) {
    throw primaryError;
  }
  if (!baseReport) {
    throw new Error('Sync completed without producing a report.');
  }

  baseReport.cleanup = cleanupResult;

  const rendered = options.json ? `${JSON.stringify(baseReport, null, 2)}\n` : formatSyncReport(baseReport);

  return {
    ...baseReport,
    rendered,
  };
}
