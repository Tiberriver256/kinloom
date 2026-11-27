import { execFile } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { CliValidationError } from '../../../errors.js';
import { stripJsoncCommentsAndTrailingCommas } from '../shared/wrangler.js';
import {
  isPlainRecord,
  type MintedTempToken,
  type SyncCleanupSummary,
  type SyncExecutionContext,
  type WranglerBindings,
  type WranglerExecutor,
} from './types.js';

const execFileAsync = promisify(execFile);

export const DEFAULT_BACKUP_TOKEN_LABEL = 'github-actions-nightly-backup';
const TEMP_TOKEN_LABEL = 'tmp-kinloom-sync';
const TEMP_TOKEN_ID_PREFIX = 'tmp_sync_';

export { stripJsoncCommentsAndTrailingCommas };

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

export function resolveWranglerBin(repoDir: string, explicitBin?: string): string {
  if (explicitBin && explicitBin.trim().length > 0) {
    return explicitBin.trim();
  }
  const localBin = path.join(repoDir, 'node_modules', '.bin', 'wrangler');
  if (fs.existsSync(localBin)) {
    return localBin;
  }
  return 'wrangler';
}

export const defaultWranglerExecutor: WranglerExecutor = async (wranglerBin, args, options) => {
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

export async function mintTempTokens(
  ctx: SyncExecutionContext
): Promise<{ read_backup: MintedTempToken; write_batch: MintedTempToken }> {
  const readToken = generateTempToken('read_backup');
  const writeToken = generateTempToken('write_batch');
  const sql = buildTempTokenInsertSql([readToken, writeToken], new Date().toISOString());
  await executeD1(ctx, sql);
  return { read_backup: readToken, write_batch: writeToken };
}

export async function cleanupTempTokens(
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
