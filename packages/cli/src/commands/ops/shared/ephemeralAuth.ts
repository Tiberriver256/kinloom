import { execFile } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { CliValidationError } from '../../../errors.js';
import { stripJsoncCommentsAndTrailingCommas, type WranglerExecutor } from './wrangler.js';

const execFileAsync = promisify(execFile);

export const DEFAULT_BACKUP_TOKEN_LABEL = 'github-actions-nightly-backup';
export const DEFAULT_EPHEMERAL_TOKEN_ID_PREFIX = 'tmp_cli_';
export const DEFAULT_EPHEMERAL_INVITE_PREFIX = 'tmp_inv_';
export const DEFAULT_EPHEMERAL_TOKEN_LABEL = 'tmp-kinloom-cli';
export const DEFAULT_EPHEMERAL_INVITE_LABEL = 'tmp-kinloom-cli-invite';
export const DEFAULT_EPHEMERAL_CREATED_BY = 'kinloom cli';
export const DEFAULT_EPHEMERAL_INVITE_TTL_MINUTES = 15;
export const DEFAULT_EXPECTED_BACKUP_COUNT = 1;

export type EphemeralAgentTokenScope = 'read_backup' | 'write_batch';

export interface MintedEphemeralAgentToken {
  readonly tokenId: string;
  readonly rawToken: string;
  readonly tokenHash: string;
  readonly scope: EphemeralAgentTokenScope;
}

export interface MintedEphemeralInvite {
  readonly token: string;
  readonly label: string;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly expiresAt: string;
}

export interface EphemeralWranglerBindings {
  readonly configPath: string;
  readonly dbName: string;
  readonly r2Bucket?: string | undefined;
  readonly domain?: string | undefined;
  readonly baseUrl?: string | undefined;
}

export interface D1StatementResult {
  readonly success: true;
  readonly results: ReadonlyArray<Record<string, unknown>>;
}

export interface D1ExecutionTarget {
  readonly repoDir: string;
  readonly configPath: string;
  readonly dbName: string;
  readonly wranglerBin: string;
  readonly execWrangler: WranglerExecutor;
}

export interface EphemeralAuthCleanupSummary {
  readonly deletedTokenIds: readonly string[];
  readonly deletedInviteTokens: readonly string[];
  readonly remainingTmpTokenCount: number;
  readonly remainingTmpInviteCount: number;
  readonly remainingTmpCount: number;
  readonly backupTokenLabel: string;
  readonly backupCountBefore: number | null;
  readonly backupCountAfter: number;
}

export interface EphemeralSignalTarget {
  on(event: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
  off(event: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
}

export interface EphemeralD1AuthSession {
  readonly bindings: EphemeralWranglerBindings;
  readonly baseUrl?: string | undefined;
  readonly agentTokens: Readonly<Partial<Record<EphemeralAgentTokenScope, MintedEphemeralAgentToken>>>;
  readonly invite: MintedEphemeralInvite | null;
  readonly backupCountBefore: number | null;
}

export interface WithEphemeralD1AuthOptions {
  readonly repoDir: string;
  readonly urlOverride?: string | undefined;
  readonly wranglerBin?: string | undefined;
  readonly execWrangler?: WranglerExecutor | undefined;
  readonly agentTokenScopes?: readonly EphemeralAgentTokenScope[] | undefined;
  readonly mintInvite?: boolean | undefined;
  readonly tokenIdPrefix?: string | undefined;
  readonly inviteTokenPrefix?: string | undefined;
  readonly tokenLabel?: string | undefined;
  readonly inviteLabel?: string | undefined;
  readonly createdBy?: string | undefined;
  readonly inviteTtlMinutes?: number | undefined;
  readonly backupTokenLabel?: string | undefined;
  readonly verifyBackupBefore?: boolean | undefined;
  readonly verifyBackupAfter?: boolean | undefined;
  readonly expectedBackupCount?: number | undefined;
  readonly now?: (() => Date) | undefined;
  readonly signalTarget?: EphemeralSignalTarget | undefined;
  readonly onSignalAfterCleanup?: ((signal: 'SIGINT' | 'SIGTERM') => void) | undefined;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertSafeTempPrefix(prefix: string, kind: 'token' | 'invite'): string {
  const trimmed = prefix.trim();
  const requiredRoot = kind === 'invite' ? DEFAULT_EPHEMERAL_INVITE_PREFIX : 'tmp_';
  if (!trimmed.startsWith(requiredRoot) || trimmed.length < requiredRoot.length) {
    throw new Error(
      `SAFETY REFUSAL: Ephemeral ${kind} prefix '${prefix}' must start with '${requiredRoot}'.`
    );
  }
  return trimmed;
}

export function normalizeSiteUrl(rawUrl: string): { readonly baseUrl: string; readonly domain: string } {
  const trimmed = rawUrl.trim();
  const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`;
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

export function parseWranglerTomlBindings(raw: string): {
  readonly dbName: string;
  readonly r2Bucket: string;
  readonly routePattern: string;
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
    const [, key, val = ''] = kv;
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

export function findWranglerConfigPath(repoDir: string): string | null {
  const candidates = [
    path.join(repoDir, 'wrangler.jsonc'),
    path.join(repoDir, 'wrangler.json'),
    path.join(repoDir, 'wrangler.toml'),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
}

export function hasWranglerConfig(repoDir: string): boolean {
  return findWranglerConfigPath(repoDir) !== null;
}

export function loadEphemeralWranglerBindings(
  repoDir: string,
  urlOverride?: string
): EphemeralWranglerBindings {
  const configPath = findWranglerConfigPath(repoDir);
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

    const d1List = Array.isArray(parsed['d1_databases']) ? parsed['d1_databases'] : [];
    const r2List = Array.isArray(parsed['r2_buckets']) ? parsed['r2_buckets'] : [];
    const routesList = Array.isArray(parsed['routes']) ? parsed['routes'] : [];

    const firstD1 = isPlainRecord(d1List[0]) ? d1List[0] : null;
    const firstR2 = isPlainRecord(r2List[0]) ? r2List[0] : null;
    const firstRoute = isPlainRecord(routesList[0]) ? routesList[0] : null;

    dbName = typeof firstD1?.['database_name'] === 'string' ? firstD1['database_name'].trim() : '';
    r2Bucket = typeof firstR2?.['bucket_name'] === 'string' ? firstR2['bucket_name'].trim() : '';
    routePattern =
      typeof firstRoute?.['pattern'] === 'string'
        ? firstRoute['pattern'].trim()
        : typeof routesList[0] === 'string'
          ? routesList[0].trim()
          : '';
  }

  if (!dbName) {
    throw new CliValidationError(`Could not read d1_databases[0].database_name from ${configPath}.`);
  }

  let resolved: { readonly baseUrl: string; readonly domain: string } | undefined;
  if (urlOverride && urlOverride.trim().length > 0) {
    resolved = normalizeSiteUrl(urlOverride);
  } else if (routePattern.length > 0) {
    const cleanedHost = routePattern
      .replace(/^https?:\/\//i, '')
      .replace(/\/.*$/, '')
      .trim();
    if (!cleanedHost) {
      throw new CliValidationError(
        `Could not derive a site URL from routes[0].pattern '${routePattern}' in ${configPath}. Pass --url <url>.`
      );
    }
    resolved = normalizeSiteUrl(`https://${cleanedHost}`);
  }

  return {
    configPath,
    dbName,
    ...(r2Bucket ? { r2Bucket } : {}),
    ...(resolved ? { domain: resolved.domain, baseUrl: resolved.baseUrl } : {}),
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

export function generateEphemeralAgentToken(
  scope: EphemeralAgentTokenScope,
  prefix = DEFAULT_EPHEMERAL_TOKEN_ID_PREFIX
): MintedEphemeralAgentToken {
  const safePrefix = assertSafeTempPrefix(prefix, 'token');
  const scopePrefix = scope === 'write_batch' ? safePrefix : `${safePrefix}read_`;
  const tokenId = `${scopePrefix}${randomUUID()}`;
  const rawToken = randomBytes(32).toString('base64url');
  const tokenHash = createHash('sha256').update(rawToken).digest('hex');
  return { tokenId, rawToken, tokenHash, scope };
}

export function generateEphemeralInvite(options?: {
  readonly prefix?: string | undefined;
  readonly label?: string | undefined;
  readonly createdBy?: string | undefined;
  readonly ttlMinutes?: number | undefined;
  readonly now?: (() => Date) | undefined;
}): MintedEphemeralInvite {
  const safePrefix = assertSafeTempPrefix(options?.prefix ?? DEFAULT_EPHEMERAL_INVITE_PREFIX, 'invite');
  const nowDate = options?.now ? options.now() : new Date();
  const ttlMinutes = options?.ttlMinutes ?? DEFAULT_EPHEMERAL_INVITE_TTL_MINUTES;
  const expiresAt = new Date(nowDate.getTime() + Math.max(1, ttlMinutes) * 60_000).toISOString();
  return {
    token: `${safePrefix}${randomUUID()}`,
    label: options?.label?.trim() || DEFAULT_EPHEMERAL_INVITE_LABEL,
    createdBy: options?.createdBy?.trim() || DEFAULT_EPHEMERAL_CREATED_BY,
    createdAt: nowDate.toISOString(),
    expiresAt,
  };
}

export function buildBackupTokenCountSql(backupTokenLabel = DEFAULT_BACKUP_TOKEN_LABEL): string {
  return `SELECT COUNT(*) AS count FROM agent_tokens WHERE label = ${sqlLiteral(
    backupTokenLabel
  )} AND revoked_at IS NULL;`;
}

export function buildEphemeralAuthInsertSql(input: {
  readonly agentTokens?:
    | readonly Pick<MintedEphemeralAgentToken, 'tokenId' | 'tokenHash' | 'scope'>[]
    | undefined;
  readonly invites?: readonly MintedEphemeralInvite[] | undefined;
  readonly nowIso: string;
  readonly tokenIdPrefix?: string | undefined;
  readonly inviteTokenPrefix?: string | undefined;
  readonly tokenLabel?: string | undefined;
  readonly createdBy?: string | undefined;
}): string {
  const agentTokens = input.agentTokens ?? [];
  const invites = input.invites ?? [];
  if (agentTokens.length === 0 && invites.length === 0) {
    throw new Error('Cannot build ephemeral auth insert SQL without at least one agent token or invite.');
  }

  const safeTokenPrefix = assertSafeTempPrefix(
    input.tokenIdPrefix ?? DEFAULT_EPHEMERAL_TOKEN_ID_PREFIX,
    'token'
  );
  const safeInvitePrefix = assertSafeTempPrefix(
    input.inviteTokenPrefix ?? DEFAULT_EPHEMERAL_INVITE_PREFIX,
    'invite'
  );
  const tokenLabel = input.tokenLabel?.trim() || DEFAULT_EPHEMERAL_TOKEN_LABEL;
  const createdBy = input.createdBy?.trim() || DEFAULT_EPHEMERAL_CREATED_BY;

  const statements: string[] = [];
  for (const token of agentTokens) {
    if (!token.tokenId.startsWith(safeTokenPrefix)) {
      throw new Error(
        `Refusing to mint temp token without required '${safeTokenPrefix}' prefix: ${token.tokenId}`
      );
    }
    statements.push(
      `INSERT INTO agent_tokens (token_id, token_hash, label, scope, created_by, created_at, revoked_at) VALUES (${sqlLiteral(
        token.tokenId
      )}, ${sqlLiteral(token.tokenHash)}, ${sqlLiteral(tokenLabel)}, ${sqlLiteral(token.scope)}, ${sqlLiteral(
        createdBy
      )}, ${sqlLiteral(input.nowIso)}, NULL);`
    );
  }

  for (const invite of invites) {
    if (!invite.token.startsWith(safeInvitePrefix)) {
      throw new Error(
        `Refusing to mint temp invite without required '${safeInvitePrefix}' prefix: ${invite.token}`
      );
    }
    statements.push(
      `INSERT INTO invites (token, label, created_by, created_at, expires_at, revoked_at, uses, last_used_at) VALUES (${sqlLiteral(
        invite.token
      )}, ${sqlLiteral(invite.label)}, ${sqlLiteral(invite.createdBy)}, ${sqlLiteral(
        invite.createdAt
      )}, ${sqlLiteral(invite.expiresAt)}, NULL, 0, NULL);`
    );
  }

  return statements.join(' ');
}

export function buildEphemeralAuthCleanupSql(input: {
  readonly tokenIds?: readonly string[] | undefined;
  readonly inviteTokens?: readonly string[] | undefined;
  readonly tokenIdPrefix?: string | undefined;
  readonly inviteTokenPrefix?: string | undefined;
  readonly backupTokenLabel?: string | undefined;
}): string {
  const tokenIds = input.tokenIds ?? [];
  const inviteTokens = input.inviteTokens ?? [];
  if (tokenIds.length === 0 && inviteTokens.length === 0) {
    throw new Error('Cannot build temp auth cleanup SQL with empty tokenIds and inviteTokens.');
  }

  const safeTokenPrefix = assertSafeTempPrefix(
    input.tokenIdPrefix ?? DEFAULT_EPHEMERAL_TOKEN_ID_PREFIX,
    'token'
  );
  const safeInvitePrefix = assertSafeTempPrefix(
    input.inviteTokenPrefix ?? DEFAULT_EPHEMERAL_INVITE_PREFIX,
    'invite'
  );
  const backupTokenLabel = input.backupTokenLabel?.trim() || DEFAULT_BACKUP_TOKEN_LABEL;

  const statements: string[] = [];
  for (const id of tokenIds) {
    if (!id.startsWith(safeTokenPrefix)) {
      throw new Error(
        `SAFETY REFUSAL: Refusing to delete non-temporary token_id '${id}'. Only '${safeTokenPrefix}*' tokens may be deleted.`
      );
    }
    statements.push(`DELETE FROM agent_tokens WHERE token_id = ${sqlLiteral(id)};`);
  }

  for (const inviteToken of inviteTokens) {
    if (!inviteToken.startsWith(safeInvitePrefix)) {
      throw new Error(
        `SAFETY REFUSAL: Refusing to delete non-temporary invite token '${inviteToken}'. Only '${safeInvitePrefix}*' invites may be deleted.`
      );
    }
    statements.push(`DELETE FROM invites WHERE token = ${sqlLiteral(inviteToken)};`);
  }

  statements.push(buildBackupTokenCountSql(backupTokenLabel));

  if (tokenIds.length > 0) {
    statements.push(
      `SELECT COUNT(*) AS count FROM agent_tokens WHERE token_id IN (${tokenIds.map(sqlLiteral).join(', ')});`
    );
  }
  if (inviteTokens.length > 0) {
    statements.push(
      `SELECT COUNT(*) AS count FROM invites WHERE token IN (${inviteTokens.map(sqlLiteral).join(', ')});`
    );
  }

  return statements.join(' ');
}

export async function executeD1Sql(target: D1ExecutionTarget, sql: string): Promise<D1StatementResult[]> {
  const { stdout } = await target.execWrangler(
    target.wranglerBin,
    ['d1', 'execute', target.dbName, '--remote', '--json', '--config', target.configPath, '--command', sql],
    {
      cwd: target.repoDir,
      maxBufferBytes: 16 * 1024 * 1024,
      timeoutMs: 45_000,
    }
  );

  const jsonStart = stdout.indexOf('[');
  if (jsonStart === -1) {
    throw new Error(`Unexpected wrangler D1 output for ${target.dbName}.`);
  }
  const parsed: unknown = JSON.parse(stdout.slice(jsonStart));
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error(`Empty wrangler D1 response for ${target.dbName}.`);
  }
  const results: D1StatementResult[] = [];
  for (const stmt of parsed) {
    if (!isPlainRecord(stmt) || stmt['success'] !== true) {
      throw new Error(`D1 statement failed on ${target.dbName}.`);
    }
    results.push({
      success: true,
      results: Array.isArray(stmt['results']) ? stmt['results'].filter(isPlainRecord) : [],
    });
  }
  return results;
}

function readCountCell(stmt: D1StatementResult | undefined, fallback: number): number {
  const row = stmt?.results[0];
  if (!row || row['count'] === undefined || row['count'] === null) {
    return fallback;
  }
  const num = Number(row['count']);
  return Number.isFinite(num) ? num : fallback;
}

export async function queryBackupTokenCount(
  target: D1ExecutionTarget,
  backupTokenLabel = DEFAULT_BACKUP_TOKEN_LABEL
): Promise<number> {
  const results = await executeD1Sql(target, buildBackupTokenCountSql(backupTokenLabel));
  const count = readCountCell(results[0], -1);
  if (count < 0) {
    throw new Error(`Could not read active '${backupTokenLabel}' token count from ${target.dbName}.`);
  }
  return count;
}

export async function cleanupEphemeralD1Auth(input: {
  readonly target: D1ExecutionTarget;
  readonly tokenIds?: readonly string[] | undefined;
  readonly inviteTokens?: readonly string[] | undefined;
  readonly tokenIdPrefix?: string | undefined;
  readonly inviteTokenPrefix?: string | undefined;
  readonly backupTokenLabel?: string | undefined;
  readonly backupCountBefore?: number | null | undefined;
  readonly verifyBackupAfter?: boolean | undefined;
  readonly expectedBackupCount?: number | undefined;
}): Promise<EphemeralAuthCleanupSummary> {
  const tokenIds = input.tokenIds ?? [];
  const inviteTokens = input.inviteTokens ?? [];
  const backupTokenLabel = input.backupTokenLabel?.trim() || DEFAULT_BACKUP_TOKEN_LABEL;
  const expectedBackupCount = input.expectedBackupCount ?? DEFAULT_EXPECTED_BACKUP_COUNT;
  const verifyBackupAfter = input.verifyBackupAfter ?? true;

  const sql = buildEphemeralAuthCleanupSql({
    tokenIds,
    inviteTokens,
    tokenIdPrefix: input.tokenIdPrefix,
    inviteTokenPrefix: input.inviteTokenPrefix,
    backupTokenLabel,
  });
  const results = await executeD1Sql(input.target, sql);

  const countStatementsTail = 1 + (tokenIds.length > 0 ? 1 : 0) + (inviteTokens.length > 0 ? 1 : 0);
  const tailStart = results.length - countStatementsTail;
  const backupCountAfter = readCountCell(results[tailStart], -1);

  let cursor = tailStart + 1;
  const remainingTmpTokenCount = tokenIds.length > 0 ? readCountCell(results[cursor++], -1) : 0;
  const remainingTmpInviteCount = inviteTokens.length > 0 ? readCountCell(results[cursor], -1) : 0;
  const remainingTmpCount =
    remainingTmpTokenCount < 0 || remainingTmpInviteCount < 0
      ? -1
      : remainingTmpTokenCount + remainingTmpInviteCount;

  if (remainingTmpCount !== 0) {
    const label = inviteTokens.length === 0 ? 'temp token(s)' : 'temp credential(s)';
    throw new Error(
      `Temporary auth cleanup verification failed: ${remainingTmpCount} ${label} still present (tokens=${remainingTmpTokenCount}, invites=${remainingTmpInviteCount}).`
    );
  }

  if (verifyBackupAfter && backupCountAfter !== expectedBackupCount) {
    throw new Error(
      `Backup token invariant violated after cleanup: expected ${expectedBackupCount} active '${backupTokenLabel}' token(s), found ${backupCountAfter}.`
    );
  }

  return {
    deletedTokenIds: [...tokenIds],
    deletedInviteTokens: [...inviteTokens],
    remainingTmpTokenCount,
    remainingTmpInviteCount,
    remainingTmpCount,
    backupTokenLabel,
    backupCountBefore: input.backupCountBefore ?? null,
    backupCountAfter,
  };
}

function readSetCookieHeaders(headers: Headers): string[] {
  const withGetSetCookie = headers as Headers & { getSetCookie?: () => string[] };
  if (typeof withGetSetCookie.getSetCookie === 'function') {
    const list = withGetSetCookie.getSetCookie();
    if (list.length > 0) {
      return list;
    }
  }
  const single = headers.get('set-cookie');
  return single ? [single] : [];
}

export function extractKinloomSessionCookiePair(setCookieHeaders: readonly string[]): string | null {
  for (const rawHeader of setCookieHeaders) {
    const firstPart = rawHeader.split(';')[0]?.trim() ?? '';
    if (firstPart.startsWith('__Host-kinloom_session=') || firstPart.startsWith('kinloom_session=')) {
      const eqIdx = firstPart.indexOf('=');
      if (firstPart.slice(eqIdx + 1).trim().length > 0) {
        return firstPart;
      }
    }
  }
  return null;
}

export async function redeemEphemeralInviteSession(input: {
  readonly baseUrl: string;
  readonly inviteToken: string;
  readonly fetchImpl?: typeof fetch | undefined;
  readonly timeoutMs?: number | undefined;
}): Promise<string> {
  const fetchImpl = input.fetchImpl ?? globalThis.fetch;
  const cleanBase = input.baseUrl.replace(/\/+$/, '');
  const redeemUrl = `${cleanBase}/api/auth/invite/${encodeURIComponent(input.inviteToken)}`;
  const timeoutMs = input.timeoutMs ?? 15_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();

  try {
    const response = await fetchImpl(redeemUrl, {
      method: 'GET',
      redirect: 'manual',
      signal: controller.signal,
    });
    if (response.status >= 400) {
      throw new Error(
        `Failed to redeem ephemeral viewer invite at ${cleanBase}/api/auth/invite/[redacted] (HTTP ${response.status}).`
      );
    }
    const cookiePair = extractKinloomSessionCookiePair(readSetCookieHeaders(response.headers));
    if (!cookiePair) {
      throw new Error(
        `Invite redemption at ${cleanBase}/api/auth/invite/[redacted] returned HTTP ${response.status} without a Kinloom session cookie.`
      );
    }
    return cookiePair;
  } finally {
    clearTimeout(timer);
  }
}

export async function withEphemeralD1Auth<T>(
  options: WithEphemeralD1AuthOptions,
  run: (session: EphemeralD1AuthSession) => Promise<T>
): Promise<{ readonly value: T; readonly cleanup: EphemeralAuthCleanupSummary }> {
  const repoDir = path.resolve(options.repoDir);
  const scopes = options.agentTokenScopes ?? [];
  const mintInvite = Boolean(options.mintInvite);
  if (scopes.length === 0 && !mintInvite) {
    throw new CliValidationError(
      'withEphemeralD1Auth requires at least one agent token scope or mintInvite: true.'
    );
  }

  const tokenIdPrefix = assertSafeTempPrefix(
    options.tokenIdPrefix ?? DEFAULT_EPHEMERAL_TOKEN_ID_PREFIX,
    'token'
  );
  const inviteTokenPrefix = assertSafeTempPrefix(
    options.inviteTokenPrefix ?? DEFAULT_EPHEMERAL_INVITE_PREFIX,
    'invite'
  );
  const backupTokenLabel = options.backupTokenLabel?.trim() || DEFAULT_BACKUP_TOKEN_LABEL;
  const expectedBackupCount = options.expectedBackupCount ?? DEFAULT_EXPECTED_BACKUP_COUNT;
  const verifyBackupBefore = options.verifyBackupBefore ?? true;
  const verifyBackupAfter = options.verifyBackupAfter ?? true;
  const nowFn = options.now ?? (() => new Date());

  const bindings = loadEphemeralWranglerBindings(repoDir, options.urlOverride);
  const target: D1ExecutionTarget = {
    repoDir,
    configPath: bindings.configPath,
    dbName: bindings.dbName,
    wranglerBin: resolveWranglerBin(repoDir, options.wranglerBin),
    execWrangler: options.execWrangler ?? defaultWranglerExecutor,
  };

  let backupCountBefore: number | null = null;
  if (verifyBackupBefore) {
    backupCountBefore = await queryBackupTokenCount(target, backupTokenLabel);
    if (backupCountBefore !== expectedBackupCount) {
      throw new Error(
        `Backup token pre-flight check failed before minting: expected ${expectedBackupCount} active '${backupTokenLabel}' token(s), found ${backupCountBefore}.`
      );
    }
  }

  const mintedTokenMap: Partial<Record<EphemeralAgentTokenScope, MintedEphemeralAgentToken>> = {};
  const mintedTokensList: MintedEphemeralAgentToken[] = [];
  for (const scope of scopes) {
    if (!mintedTokenMap[scope]) {
      const minted = generateEphemeralAgentToken(scope, tokenIdPrefix);
      mintedTokenMap[scope] = minted;
      mintedTokensList.push(minted);
    }
  }

  const mintedInvite = mintInvite
    ? generateEphemeralInvite({
        prefix: inviteTokenPrefix,
        label: options.inviteLabel,
        createdBy: options.createdBy,
        ttlMinutes: options.inviteTtlMinutes,
        now: nowFn,
      })
    : null;

  const insertSql = buildEphemeralAuthInsertSql({
    agentTokens: mintedTokensList,
    invites: mintedInvite ? [mintedInvite] : [],
    nowIso: nowFn().toISOString(),
    tokenIdPrefix,
    inviteTokenPrefix,
    tokenLabel: options.tokenLabel,
    createdBy: options.createdBy,
  });

  await executeD1Sql(target, insertSql);

  const mintedTokenIds = mintedTokensList.map((t) => t.tokenId);
  const mintedInviteTokens = mintedInvite ? [mintedInvite.token] : [];

  let cleanupPromise: Promise<EphemeralAuthCleanupSummary> | null = null;
  const runCleanupOnce = (): Promise<EphemeralAuthCleanupSummary> => {
    if (!cleanupPromise) {
      cleanupPromise = cleanupEphemeralD1Auth({
        target,
        tokenIds: mintedTokenIds,
        inviteTokens: mintedInviteTokens,
        tokenIdPrefix,
        inviteTokenPrefix,
        backupTokenLabel,
        backupCountBefore,
        verifyBackupAfter,
        expectedBackupCount,
      });
    }
    return cleanupPromise;
  };

  const signalTarget: EphemeralSignalTarget = options.signalTarget ?? process;
  const handleSignal = (signal: 'SIGINT' | 'SIGTERM'): void => {
    detachSignalHandlers();
    void runCleanupOnce()
      .catch(() => undefined)
      .finally(() => {
        if (options.onSignalAfterCleanup) {
          options.onSignalAfterCleanup(signal);
        } else {
          process.exit(signal === 'SIGINT' ? 130 : 143);
        }
      });
  };
  const onSigint = (): void => handleSignal('SIGINT');
  const onSigterm = (): void => handleSignal('SIGTERM');

  const detachSignalHandlers = (): void => {
    signalTarget.off('SIGINT', onSigint);
    signalTarget.off('SIGTERM', onSigterm);
  };

  signalTarget.on('SIGINT', onSigint);
  signalTarget.on('SIGTERM', onSigterm);

  let primaryError: unknown = null;
  let outcome: { readonly ok: true; readonly value: T } | { readonly ok: false } = { ok: false };
  let cleanup: EphemeralAuthCleanupSummary | null = null;
  let cleanupError: unknown = null;

  try {
    const value = await run({
      bindings,
      baseUrl: bindings.baseUrl,
      agentTokens: mintedTokenMap,
      invite: mintedInvite,
      backupCountBefore,
    });
    outcome = { ok: true, value };
  } catch (err: unknown) {
    primaryError = err;
  } finally {
    detachSignalHandlers();
    try {
      cleanup = await runCleanupOnce();
    } catch (err: unknown) {
      cleanupError = err;
    }
  }

  if (primaryError !== null && cleanupError !== null) {
    const primaryMsg = primaryError instanceof Error ? primaryError.message : String(primaryError);
    const cleanupMsg = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
    throw new Error(`${primaryMsg} (Additionally, ephemeral D1 cleanup failed: ${cleanupMsg})`, {
      cause: primaryError,
    });
  }
  if (primaryError !== null) {
    throw primaryError;
  }
  if (cleanupError !== null) {
    throw cleanupError;
  }
  if (!cleanup || !outcome.ok) {
    throw new Error('Ephemeral D1 auth cleanup did not return a verification summary.');
  }

  return {
    value: outcome.value,
    cleanup,
  };
}
