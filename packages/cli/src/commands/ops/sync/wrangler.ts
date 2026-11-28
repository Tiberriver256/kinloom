import { CliValidationError } from '../../../errors.js';
import {
  buildEphemeralAuthCleanupSql,
  buildEphemeralAuthInsertSql,
  cleanupEphemeralD1Auth,
  DEFAULT_BACKUP_TOKEN_LABEL,
  defaultWranglerExecutor,
  executeD1Sql,
  generateEphemeralAgentToken,
  loadEphemeralWranglerBindings,
  resolveWranglerBin,
  sqlLiteral,
} from '../shared/ephemeralAuth.js';
import { stripJsoncCommentsAndTrailingCommas } from '../shared/wrangler.js';
import type { MintedTempToken, SyncCleanupSummary, SyncExecutionContext, WranglerBindings } from './types.js';

export const SYNC_TEMP_TOKEN_LABEL = 'tmp-kinloom-sync';
export const SYNC_TEMP_TOKEN_ID_PREFIX = 'tmp_sync_';

export {
  DEFAULT_BACKUP_TOKEN_LABEL,
  defaultWranglerExecutor,
  resolveWranglerBin,
  sqlLiteral,
  stripJsoncCommentsAndTrailingCommas,
};

export function loadWranglerBindings(repoDir: string, siteUrlOverride?: string): WranglerBindings {
  const bindings = loadEphemeralWranglerBindings(repoDir, siteUrlOverride);
  if (!bindings.r2Bucket) {
    throw new CliValidationError(`Could not read r2_buckets[0].bucket_name from ${bindings.configPath}.`);
  }
  if (!bindings.baseUrl || !bindings.domain) {
    throw new CliValidationError(
      `No --site-url provided and no routes[0].pattern found in ${bindings.configPath}. Pass --site-url <url>.`
    );
  }
  return {
    configPath: bindings.configPath,
    dbName: bindings.dbName,
    r2Bucket: bindings.r2Bucket,
    domain: bindings.domain,
    baseUrl: bindings.baseUrl,
  };
}

export function generateTempToken(scope: 'read_backup' | 'write_batch'): MintedTempToken {
  return generateEphemeralAgentToken(scope, SYNC_TEMP_TOKEN_ID_PREFIX);
}

export function buildTempTokenInsertSql(
  tokens: readonly Pick<MintedTempToken, 'tokenId' | 'tokenHash' | 'scope'>[],
  nowIso: string
): string {
  return buildEphemeralAuthInsertSql({
    agentTokens: tokens,
    nowIso,
    tokenIdPrefix: SYNC_TEMP_TOKEN_ID_PREFIX,
    tokenLabel: SYNC_TEMP_TOKEN_LABEL,
    createdBy: 'kinloom sync',
  });
}

export function buildTempTokenCleanupSql(
  tokenIds: readonly string[],
  backupTokenLabel = DEFAULT_BACKUP_TOKEN_LABEL
): string {
  if (tokenIds.length === 0) {
    throw new Error('Cannot build temp token cleanup SQL with empty tokenIds list.');
  }
  return buildEphemeralAuthCleanupSql({
    tokenIds,
    tokenIdPrefix: SYNC_TEMP_TOKEN_ID_PREFIX,
    backupTokenLabel,
  });
}

export async function mintTempTokens(
  ctx: SyncExecutionContext
): Promise<{ read_backup: MintedTempToken; write_batch: MintedTempToken }> {
  const readToken = generateTempToken('read_backup');
  const writeToken = generateTempToken('write_batch');
  const sql = buildTempTokenInsertSql([readToken, writeToken], new Date().toISOString());
  await executeD1Sql(
    {
      repoDir: ctx.repoDir,
      configPath: ctx.bindings.configPath,
      dbName: ctx.bindings.dbName,
      wranglerBin: ctx.wranglerBin,
      execWrangler: ctx.execWrangler,
    },
    sql
  );
  return { read_backup: readToken, write_batch: writeToken };
}

export async function cleanupTempTokens(
  ctx: SyncExecutionContext,
  tokenIds: readonly string[]
): Promise<SyncCleanupSummary> {
  if (tokenIds.length === 0) {
    throw new Error('Cannot build temp token cleanup SQL with empty tokenIds list.');
  }
  const summary = await cleanupEphemeralD1Auth({
    target: {
      repoDir: ctx.repoDir,
      configPath: ctx.bindings.configPath,
      dbName: ctx.bindings.dbName,
      wranglerBin: ctx.wranglerBin,
      execWrangler: ctx.execWrangler,
    },
    tokenIds,
    tokenIdPrefix: SYNC_TEMP_TOKEN_ID_PREFIX,
    backupTokenLabel: ctx.backupTokenLabel,
    verifyBackupAfter: false,
  });

  return {
    deletedTokenIds: [...summary.deletedTokenIds],
    remainingTmpCount: summary.remainingTmpCount,
    backupTokenLabel: summary.backupTokenLabel,
    backupCount: summary.backupCountAfter,
  };
}
