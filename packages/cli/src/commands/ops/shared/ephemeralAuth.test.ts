import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CliValidationError } from '../../../errors.js';
import {
  buildBackupTokenCountSql,
  buildEphemeralAuthCleanupSql,
  buildEphemeralAuthInsertSql,
  cleanupEphemeralD1Auth,
  DEFAULT_BACKUP_TOKEN_LABEL,
  type EphemeralSignalTarget,
  executeD1Sql,
  extractKinloomSessionCookiePair,
  generateEphemeralAgentToken,
  generateEphemeralInvite,
  hasWranglerConfig,
  loadEphemeralWranglerBindings,
  normalizeSiteUrl,
  parseWranglerTomlBindings,
  queryBackupTokenCount,
  redeemEphemeralInviteSession,
  resolveWranglerBin,
  sqlLiteral,
  withEphemeralD1Auth,
} from './ephemeralAuth.js';
import type { WranglerExecutor } from './wrangler.js';

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function createFakeSignalTarget(): {
  target: EphemeralSignalTarget;
  emitter: EventEmitter;
} {
  const emitter = new EventEmitter();
  return {
    emitter,
    target: {
      on: (event, listener) => emitter.on(event, listener),
      off: (event, listener) => emitter.off(event, listener),
    },
  };
}

function makeStandardD1Executor(options?: {
  readonly backupBefore?: number;
  readonly backupAfter?: number;
  readonly remainingTokens?: number;
  readonly remainingInvites?: number;
  readonly onSql?: (sql: string) => void;
}): WranglerExecutor {
  const backupBefore = options?.backupBefore ?? 1;
  const backupAfter = options?.backupAfter ?? 1;
  const remainingTokens = options?.remainingTokens ?? 0;
  const remainingInvites = options?.remainingInvites ?? 0;

  return async (_bin, args) => {
    const sql = args[args.indexOf('--command') + 1] ?? '';
    options?.onSql?.(sql);

    if (sql.startsWith('SELECT COUNT(*) AS count FROM agent_tokens')) {
      return {
        stdout: JSON.stringify([{ success: true, results: [{ count: backupBefore }] }]),
        stderr: '',
      };
    }

    if (sql.includes('DELETE FROM')) {
      const statements: Array<{ success: true; results: Array<Record<string, unknown>> }> = [];
      const tokenDeletes = (sql.match(/DELETE FROM agent_tokens/g) ?? []).length;
      const inviteDeletes = (sql.match(/DELETE FROM invites/g) ?? []).length;
      for (let i = 0; i < tokenDeletes + inviteDeletes; i += 1) {
        statements.push({ success: true, results: [] });
      }
      statements.push({ success: true, results: [{ count: backupAfter }] });
      if (tokenDeletes > 0) {
        statements.push({ success: true, results: [{ count: remainingTokens }] });
      }
      if (inviteDeletes > 0) {
        statements.push({ success: true, results: [{ count: remainingInvites }] });
      }
      return { stdout: JSON.stringify(statements), stderr: '' };
    }

    const insertCount = (sql.match(/INSERT INTO/g) ?? []).length;
    return {
      stdout: JSON.stringify(
        Array.from({ length: Math.max(1, insertCount) }, () => ({ success: true, results: [] }))
      ),
      stderr: '',
    };
  };
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

describe('ephemeralAuth config, SQL builders, and invite redemption', () => {
  it('normalizes site URLs, parses wrangler JSONC/JSON/TOML configs, and resolves wrangler bin', async () => {
    expect(normalizeSiteUrl('archive.example.org/')).toEqual({
      baseUrl: 'https://archive.example.org',
      domain: 'archive.example.org',
    });
    expect(normalizeSiteUrl('http://127.0.0.1:4173///')).toEqual({
      baseUrl: 'http://127.0.0.1:4173',
      domain: '127.0.0.1:4173',
    });
    expect(() => normalizeSiteUrl('http://[bad-url')).toThrow(CliValidationError);
    expect(() => normalizeSiteUrl('ftp://archive.example.org')).toThrow(CliValidationError);

    expect(
      parseWranglerTomlBindings(`
        # comment
        [[d1_databases]]
        database_name = "family-db"
        [[r2_buckets]]
        bucket_name = "family-r2"
        [[routes]]
        pattern = "family.example.org/*"
        [vars]
        MODE = "private"
      `)
    ).toEqual({
      dbName: 'family-db',
      r2Bucket: 'family-r2',
      routePattern: 'family.example.org/*',
    });

    const emptyDir = await makeTempDir('kinloom-ephem-empty-');
    expect(hasWranglerConfig(emptyDir)).toBe(false);
    expect(() => loadEphemeralWranglerBindings(emptyDir)).toThrow(/Missing wrangler/);

    const jsoncDir = await makeTempDir('kinloom-ephem-jsonc-');
    await writeFile(
      path.join(jsoncDir, 'wrangler.jsonc'),
      `{
        // trailing comma + comments
        "d1_databases": [{ "database_name": "alder-d1", },],
        "routes": ["https://alder.example.org/*"],
      }`,
      'utf8'
    );
    expect(hasWranglerConfig(jsoncDir)).toBe(true);
    expect(loadEphemeralWranglerBindings(jsoncDir)).toEqual({
      configPath: path.join(jsoncDir, 'wrangler.jsonc'),
      dbName: 'alder-d1',
      domain: 'alder.example.org',
      baseUrl: 'https://alder.example.org',
    });
    expect(loadEphemeralWranglerBindings(jsoncDir, 'https://override.example.test/')).toMatchObject({
      baseUrl: 'https://override.example.test',
      domain: 'override.example.test',
    });

    const tomlDir = await makeTempDir('kinloom-ephem-toml-');
    await writeFile(
      path.join(tomlDir, 'wrangler.toml'),
      '[[d1_databases]]\ndatabase_name = "toml-db"\n[[r2_buckets]]\nbucket_name = "toml-r2"\n',
      'utf8'
    );
    expect(loadEphemeralWranglerBindings(tomlDir)).toEqual({
      configPath: path.join(tomlDir, 'wrangler.toml'),
      dbName: 'toml-db',
      r2Bucket: 'toml-r2',
    });

    const badJsonDir = await makeTempDir('kinloom-ephem-badjson-');
    await writeFile(path.join(badJsonDir, 'wrangler.json'), '{not-json', 'utf8');
    expect(() => loadEphemeralWranglerBindings(badJsonDir)).toThrow(/Failed to parse/);
    await writeFile(path.join(badJsonDir, 'wrangler.json'), '[]', 'utf8');
    expect(() => loadEphemeralWranglerBindings(badJsonDir)).toThrow(/Expected a JSON object/);
    await writeFile(path.join(badJsonDir, 'wrangler.json'), JSON.stringify({ d1_databases: [] }), 'utf8');
    expect(() => loadEphemeralWranglerBindings(badJsonDir)).toThrow(/database_name/);
    await writeFile(
      path.join(badJsonDir, 'wrangler.json'),
      JSON.stringify({ d1_databases: [{ database_name: 'db' }], routes: [{ pattern: '///' }] }),
      'utf8'
    );
    expect(() => loadEphemeralWranglerBindings(badJsonDir)).toThrow(/Could not derive a site URL/);

    expect(resolveWranglerBin(emptyDir, '  /custom/wrangler  ')).toBe('/custom/wrangler');
    expect(resolveWranglerBin(emptyDir)).toBe('wrangler');
    await mkdir(path.join(emptyDir, 'node_modules', '.bin'), { recursive: true });
    const localWrangler = path.join(emptyDir, 'node_modules', '.bin', 'wrangler');
    await writeFile(localWrangler, '#!/bin/sh\n', 'utf8');
    expect(resolveWranglerBin(emptyDir)).toBe(localWrangler);
  });

  it('builds exact 0001_initial.sql insert/cleanup SQL and enforces tmp_* / tmp_inv_* safety guards', () => {
    expect(sqlLiteral("o'brien")).toBe("'o''brien'");
    expect(buildBackupTokenCountSql()).toBe(
      `SELECT COUNT(*) AS count FROM agent_tokens WHERE label = '${DEFAULT_BACKUP_TOKEN_LABEL}' AND revoked_at IS NULL;`
    );

    const readTok = generateEphemeralAgentToken('read_backup');
    const writeTok = generateEphemeralAgentToken('write_batch');
    const invite = generateEphemeralInvite({
      now: () => new Date('2026-11-28T12:00:00.000Z'),
      ttlMinutes: 10,
      createdBy: 'kinloom verify-live',
      label: 'tmp-verify-invite',
    });

    expect(readTok.tokenId.startsWith('tmp_cli_read_')).toBe(true);
    expect(writeTok.tokenId.startsWith('tmp_cli_')).toBe(true);
    expect(invite.token.startsWith('tmp_inv_')).toBe(true);
    expect(invite.expiresAt).toBe('2026-11-28T12:10:00.000Z');

    const insertSql = buildEphemeralAuthInsertSql({
      agentTokens: [readTok],
      invites: [invite],
      nowIso: '2026-11-28T12:00:00.000Z',
      createdBy: 'kinloom verify-live',
    });
    expect(insertSql).toContain(
      'INSERT INTO agent_tokens (token_id, token_hash, label, scope, created_by, created_at, revoked_at)'
    );
    expect(insertSql).toContain(
      'INSERT INTO invites (token, label, created_by, created_at, expires_at, revoked_at, uses, last_used_at)'
    );
    expect(insertSql).not.toContain(readTok.rawToken);

    const cleanupSql = buildEphemeralAuthCleanupSql({
      tokenIds: [readTok.tokenId],
      inviteTokens: [invite.token],
    });
    expect(cleanupSql).toContain(`DELETE FROM agent_tokens WHERE token_id = '${readTok.tokenId}';`);
    expect(cleanupSql).toContain(`DELETE FROM invites WHERE token = '${invite.token}';`);
    expect(cleanupSql).toContain(`WHERE label = '${DEFAULT_BACKUP_TOKEN_LABEL}' AND revoked_at IS NULL;`);
    expect(cleanupSql).toContain(`SELECT COUNT(*) AS count FROM agent_tokens WHERE token_id IN`);
    expect(cleanupSql).toContain(`SELECT COUNT(*) AS count FROM invites WHERE token IN`);

    expect(() => generateEphemeralAgentToken('read_backup', 'perm_')).toThrow(/SAFETY REFUSAL/);
    expect(() => generateEphemeralInvite({ prefix: 'inv_' })).toThrow(/SAFETY REFUSAL/);
    expect(() => buildEphemeralAuthInsertSql({ nowIso: '2026-11-28T12:00:00.000Z' })).toThrow(
      /at least one agent token or invite/
    );
    expect(() =>
      buildEphemeralAuthInsertSql({
        agentTokens: [{ tokenId: 'bad_id', tokenHash: 'h', scope: 'read_backup' }],
        nowIso: '2026-11-28T12:00:00.000Z',
      })
    ).toThrow(/Refusing to mint temp token/);
    expect(() =>
      buildEphemeralAuthInsertSql({
        invites: [{ ...invite, token: 'perm_invite' }],
        nowIso: '2026-11-28T12:00:00.000Z',
      })
    ).toThrow(/Refusing to mint temp invite/);
    expect(() => buildEphemeralAuthCleanupSql({})).toThrow(/empty tokenIds and inviteTokens/);
    expect(() => buildEphemeralAuthCleanupSql({ tokenIds: ['tok_permanent'] })).toThrow(/SAFETY REFUSAL/);
    expect(() => buildEphemeralAuthCleanupSql({ inviteTokens: ['inv_permanent'] })).toThrow(/SAFETY REFUSAL/);
  });

  it('extracts Kinloom session cookies and redeems ephemeral invites cleanly', async () => {
    expect(
      extractKinloomSessionCookiePair([
        'other=1; Path=/',
        '__Host-kinloom_session=jwt-prod-token; Path=/; HttpOnly; Secure',
      ])
    ).toBe('__Host-kinloom_session=jwt-prod-token');
    expect(extractKinloomSessionCookiePair(['kinloom_session=jwt-dev-token; Path=/'])).toBe(
      'kinloom_session=jwt-dev-token'
    );
    expect(extractKinloomSessionCookiePair(['__Host-kinloom_session=; Max-Age=0'])).toBeNull();

    const okCookie = await redeemEphemeralInviteSession({
      baseUrl: 'https://alder.example.org/',
      inviteToken: 'tmp_inv_abc',
      fetchImpl: async (url) => {
        expect(String(url)).toBe('https://alder.example.org/api/auth/invite/tmp_inv_abc');
        return new Response(null, {
          status: 302,
          headers: {
            location: '/',
            'set-cookie': '__Host-kinloom_session=sess_123; Path=/; HttpOnly; Secure',
          },
        });
      },
    });
    expect(okCookie).toBe('__Host-kinloom_session=sess_123');

    await expect(
      redeemEphemeralInviteSession({
        baseUrl: 'https://alder.example.org',
        inviteToken: 'tmp_inv_bad',
        fetchImpl: async () => new Response('not found', { status: 404 }),
      })
    ).rejects.toThrow(/HTTP 404/);

    await expect(
      redeemEphemeralInviteSession({
        baseUrl: 'https://alder.example.org',
        inviteToken: 'tmp_inv_nocookie',
        fetchImpl: async () => new Response(null, { status: 302 }),
      })
    ).rejects.toThrow(/without a Kinloom session cookie/);
  });
});

describe('withEphemeralD1Auth lifecycle, invariants, and signal safety', () => {
  async function createWranglerRepo(): Promise<string> {
    const repoDir = await makeTempDir('kinloom-ephem-repo-');
    await writeFile(
      path.join(repoDir, 'wrangler.jsonc'),
      JSON.stringify({
        d1_databases: [{ database_name: 'alder-db' }],
        routes: [{ pattern: 'alder.example.org/*' }],
      }),
      'utf8'
    );
    return repoDir;
  }

  it('mints token + invite, verifies backupCount === 1 before and after, and asserts remainingTmpCount === 0', async () => {
    const repoDir = await createWranglerRepo();
    const sqlLog: string[] = [];
    const execWrangler = makeStandardD1Executor({ onSql: (sql) => sqlLog.push(sql) });

    const { value, cleanup } = await withEphemeralD1Auth(
      {
        repoDir,
        agentTokenScopes: ['read_backup'],
        mintInvite: true,
        execWrangler,
      },
      async (session) => {
        expect(session.baseUrl).toBe('https://alder.example.org');
        expect(session.backupCountBefore).toBe(1);
        expect(session.agentTokens.read_backup?.tokenId.startsWith('tmp_cli_read_')).toBe(true);
        expect(session.invite?.token.startsWith('tmp_inv_')).toBe(true);
        return 'ok-result';
      }
    );

    expect(value).toBe('ok-result');
    expect(sqlLog).toHaveLength(3);
    expect(sqlLog[0]).toContain('SELECT COUNT(*) AS count FROM agent_tokens');
    expect(sqlLog[1]).toContain('INSERT INTO agent_tokens');
    expect(sqlLog[1]).toContain('INSERT INTO invites');
    expect(sqlLog[2]).toContain('DELETE FROM agent_tokens');
    expect(sqlLog[2]).toContain('DELETE FROM invites');
    expect(cleanup.backupCountBefore).toBe(1);
    expect(cleanup.backupCountAfter).toBe(1);
    expect(cleanup.remainingTmpTokenCount).toBe(0);
    expect(cleanup.remainingTmpInviteCount).toBe(0);
    expect(cleanup.remainingTmpCount).toBe(0);
    expect(cleanup.deletedTokenIds).toHaveLength(1);
    expect(cleanup.deletedInviteTokens).toHaveLength(1);
  });

  it('runs cleanup in finally when callback fails and fails loudly on backupCount !== 1 or remainingTmpCount !== 0', async () => {
    const repoDir = await createWranglerRepo();

    // 1. Pre-flight backupCount !== 1 aborts BEFORE any INSERT.
    const preFailLog: string[] = [];
    await expect(
      withEphemeralD1Auth(
        {
          repoDir,
          agentTokenScopes: ['read_backup'],
          execWrangler: makeStandardD1Executor({ backupBefore: 0, onSql: (s) => preFailLog.push(s) }),
        },
        async () => 'never-runs'
      )
    ).rejects.toThrow(/pre-flight check failed.*expected 1.*found 0/i);
    expect(preFailLog).toHaveLength(1);

    // 2. Callback throws -> cleanup still runs and primary error propagates.
    const errLog: string[] = [];
    await expect(
      withEphemeralD1Auth(
        {
          repoDir,
          agentTokenScopes: ['read_backup'],
          execWrangler: makeStandardD1Executor({ onSql: (s) => errLog.push(s) }),
        },
        async () => {
          throw new Error('probe exploded');
        }
      )
    ).rejects.toThrow('probe exploded');
    expect(errLog.some((s) => s.includes('DELETE FROM agent_tokens'))).toBe(true);

    // 3. Post-cleanup backupCount !== 1 fails loudly.
    await expect(
      withEphemeralD1Auth(
        {
          repoDir,
          agentTokenScopes: ['read_backup'],
          execWrangler: makeStandardD1Executor({ backupBefore: 1, backupAfter: 2 }),
        },
        async () => 'ok'
      )
    ).rejects.toThrow(/Backup token invariant violated.*expected 1.*found 2/i);

    // 4. Remaining temp credential after cleanup fails loudly.
    await expect(
      withEphemeralD1Auth(
        {
          repoDir,
          agentTokenScopes: ['read_backup'],
          mintInvite: true,
          execWrangler: makeStandardD1Executor({ remainingInvites: 1 }),
        },
        async () => 'ok'
      )
    ).rejects.toThrow(/1 temp credential\(s\) still present/i);

    // 5. Both callback and cleanup fail -> error reports BOTH failures loudly.
    await expect(
      withEphemeralD1Auth(
        {
          repoDir,
          agentTokenScopes: ['read_backup'],
          execWrangler: makeStandardD1Executor({ remainingTokens: 1 }),
        },
        async () => {
          throw new Error('primary failure');
        }
      )
    ).rejects.toThrow(/primary failure.*Additionally, ephemeral D1 cleanup failed/);

    // 6. Rejects empty request (neither scopes nor invite).
    await expect(
      withEphemeralD1Auth({ repoDir, execWrangler: makeStandardD1Executor() }, async () => 'x')
    ).rejects.toThrow(CliValidationError);

    // 7. queryBackupTokenCount rejects missing count cell.
    await expect(
      queryBackupTokenCount({
        repoDir,
        configPath: path.join(repoDir, 'wrangler.jsonc'),
        dbName: 'alder-db',
        wranglerBin: 'wrangler',
        execWrangler: async () => ({
          stdout: JSON.stringify([{ success: true, results: [{}] }]),
          stderr: '',
        }),
      })
    ).rejects.toThrow(/Could not read active/);

    // 8. executeD1Sql and cleanupEphemeralD1Auth malformed output errors.
    await expect(
      executeD1Sql(
        {
          repoDir,
          configPath: path.join(repoDir, 'wrangler.jsonc'),
          dbName: 'alder-db',
          wranglerBin: 'wrangler',
          execWrangler: async () => ({ stdout: 'not-json', stderr: '' }),
        },
        'SELECT 1;'
      )
    ).rejects.toThrow(/Unexpected wrangler D1 output/);

    await expect(
      cleanupEphemeralD1Auth({
        target: {
          repoDir,
          configPath: path.join(repoDir, 'wrangler.jsonc'),
          dbName: 'alder-db',
          wranglerBin: 'wrangler',
          execWrangler: async () => ({
            stdout: JSON.stringify([
              { success: true, results: [] },
              { success: true, results: [{ count: 1 }] },
              { success: true, results: [{}] },
            ]),
            stderr: '',
          }),
        },
        tokenIds: ['tmp_cli_read_1'],
      })
    ).rejects.toThrow(/cleanup verification failed/);
  });

  it('cleans up exactly once on SIGINT and SIGTERM and detaches handlers cleanly', async () => {
    const repoDir = await createWranglerRepo();

    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      let deleteCalls = 0;
      const handledSignals: string[] = [];
      const { target, emitter } = createFakeSignalTarget();
      const execWrangler = makeStandardD1Executor({
        onSql: (sql) => {
          if (sql.includes('DELETE FROM agent_tokens')) {
            deleteCalls += 1;
          }
        },
      });

      let signalDoneResolve: (() => void) | undefined;
      const signalDone = new Promise<void>((resolve) => {
        signalDoneResolve = resolve;
      });

      const res = await withEphemeralD1Auth(
        {
          repoDir,
          agentTokenScopes: ['read_backup'],
          execWrangler,
          signalTarget: target,
          onSignalAfterCleanup: (sig) => {
            handledSignals.push(sig);
            signalDoneResolve?.();
          },
        },
        async () => {
          emitter.emit(signal);
          await signalDone;
          return 'interrupted';
        }
      );

      expect(res.value).toBe('interrupted');
      expect(handledSignals).toEqual([signal]);
      expect(deleteCalls).toBe(1);
      expect(emitter.listenerCount('SIGINT')).toBe(0);
      expect(emitter.listenerCount('SIGTERM')).toBe(0);
    }
  });
});
