import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import path from 'node:path';
import type {
  AtomicMutationOp,
  EntityPayload,
  KinloomSiteConfig,
  Narrative,
  RevisionAuthor,
  Sha256Hex,
} from '@kinloom/core';
import {
  deriveKinshipEdgeId,
  parseEventsYaml,
  parseKinloomConfigYaml,
  parseKinshipYaml,
  parseMediaYaml,
  parseNarrativesYaml,
  parsePeopleYaml,
  parsePlacesYaml,
  parseSourcesYaml,
  resolveEffectiveLiving,
  sanitizeEventForWrite,
  sanitizePersonForWrite,
} from '@kinloom/core';
import {
  createBookPublishingServerPlugin,
  createOpenFinancePlugin,
  createPageVisitStatsPlugin,
  createPronunciationPlugin,
  createRecipesServerPlugin,
  createWorkersObservabilityPlugin,
  FixedClock,
  getSessionCookieName,
  type SecurityTelemetryLogRecord,
  sha256Hex,
  signSessionToken,
  type WorkersObservabilityLogRecord,
} from '@kinloom/server';
import {
  createCloudflareWorker,
  createD1ArchiveRepository,
  type D1Database,
  type ExecutionContext,
  type ExportedHandler,
  type Fetcher,
  type KinloomWorkerEnv,
  type R2Bucket,
  R2IncrementalPatchBundleCache,
  R2MediaStore,
  runD1PluginMigrations,
} from '@kinloom/worker';
import type { Page } from '@playwright/test';
import { Miniflare } from 'miniflare';

const REPO_ROOT = path.resolve(import.meta.dirname, '../..');
const DEMO_ROOT = path.join(REPO_ROOT, 'examples', 'demo');
const DEMO_DATA_DIR = path.join(DEMO_ROOT, 'data');
const DEMO_DIST_DIR = path.join(DEMO_ROOT, 'dist');
const DEMO_PUBLIC_MEDIA_DIR = path.join(DEMO_ROOT, 'public', 'media');
const WORKER_MIGRATIONS_DIR = path.join(REPO_ROOT, 'packages', 'worker', 'migrations');

function listCoreMigrationFiles(): readonly string[] {
  return fs
    .readdirSync(WORKER_MIGRATIONS_DIR)
    .filter((filename) => filename.endsWith('.sql'))
    .sort();
}

export const MINIFLARE_E2E_SESSION_SECRET = 'kinloom-miniflare-e2e-session-secret-0123456789abcdef';
export const MINIFLARE_E2E_WEB_ANALYTICS_TOKEN = '0123456789abcdef0123456789abcdef';
const DEFAULT_INVITE_TOKEN = 'reunion-2026-invite';
const DEFAULT_READ_BACKUP_TOKEN = 'kl_agent_e2e_read_backup_token_74';
const DEFAULT_WRITE_BATCH_TOKEN = 'kl_agent_e2e_write_batch_token_74';
const DEFAULT_ADMIN_EMAIL = 'admin@archive.example.test';
const DEFAULT_EDITOR_EMAIL = 'editor@archive.example.test';

const MIME_BY_EXT: Readonly<Record<string, string>> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.wav': 'audio/wav',
  '.webm': 'video/webm',
  '.webp': 'image/webp',
};

function readDemoYaml(filename: string): string {
  return fs.readFileSync(path.join(DEMO_DATA_DIR, filename), 'utf8');
}

function contentTypeForPath(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_BY_EXT[ext] ?? 'application/octet-stream';
}

function injectAllPluginsMeta(html: string): string {
  const tags = [
    '<meta name="kinloom-backend" content="http" />',
    '<meta name="kinloom-all-plugins" content="true" />',
  ].join('\n    ');
  return html.replace('</head>', `    ${tags}\n  </head>`);
}

function createDemoAssetsFetcher(distDir: string): Fetcher {
  const resolvedDist = path.resolve(distDir);
  const indexHtmlPath = path.join(resolvedDist, 'index.html');
  if (!fs.existsSync(indexHtmlPath)) {
    throw new Error(
      `Missing built demo SPA at ${indexHtmlPath}. Run "npm run build --workspace=@kinloom/demo" first.`
    );
  }
  const indexHtml = injectAllPluginsMeta(fs.readFileSync(indexHtmlPath, 'utf8'));
  const fileCache = new Map<string, { readonly bytes: Uint8Array; readonly contentType: string }>();

  return {
    async fetch(input: RequestInfo | URL): Promise<Response> {
      const urlStr = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const url = new URL(urlStr);
      let decodedPath = '/';
      try {
        decodedPath = decodeURIComponent(url.pathname);
      } catch {
        return new Response('Bad Request', { status: 400 });
      }

      if (decodedPath === '/' || decodedPath === '/index.html') {
        return new Response(indexHtml, {
          status: 200,
          headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
        });
      }

      const relPath = decodedPath.replace(/^\/+/, '');
      if (relPath && !relPath.includes('..')) {
        const candidate = path.resolve(resolvedDist, relPath);
        const cacheHeader = relPath.startsWith('assets/')
          ? 'public, max-age=31536000, immutable'
          : 'no-cache';
        const cached = fileCache.get(candidate);
        if (cached) {
          return new Response(Buffer.from(cached.bytes), {
            status: 200,
            headers: { 'content-type': cached.contentType, 'cache-control': cacheHeader },
          });
        }
        if (
          candidate.startsWith(`${resolvedDist}${path.sep}`) &&
          fs.existsSync(candidate) &&
          fs.statSync(candidate).isFile()
        ) {
          const bytes = new Uint8Array(fs.readFileSync(candidate));
          const contentType = contentTypeForPath(candidate);
          fileCache.set(candidate, { bytes, contentType });
          return new Response(Buffer.from(bytes), {
            status: 200,
            headers: { 'content-type': contentType, 'cache-control': cacheHeader },
          });
        }
      }

      return new Response('Not Found', { status: 404 });
    },
  };
}

interface CachedDemoSeed {
  readonly siteConfig: KinloomSiteConfig;
  readonly ops: readonly AtomicMutationOp[];
  readonly mediaFiles: ReadonlyArray<{
    readonly key: string;
    readonly bytes: Uint8Array;
    readonly contentType: string;
    readonly sha256: Sha256Hex;
  }>;
  readonly readBackupHash: Sha256Hex;
  readonly writeBatchHash: Sha256Hex;
}

let cachedSeedPromise: Promise<CachedDemoSeed> | null = null;

async function getCachedDemoSeed(): Promise<CachedDemoSeed> {
  if (!cachedSeedPromise) {
    cachedSeedPromise = (async () => {
      const siteConfig = parseKinloomConfigYaml(readDemoYaml('kinloom.config.yaml'));
      const people = parsePeopleYaml(readDemoYaml('people.yaml'));
      const places = parsePlacesYaml(readDemoYaml('places.yaml'));
      const sources = parseSourcesYaml(readDemoYaml('sources.yaml'));
      const kinship = parseKinshipYaml(readDemoYaml('kinship.yaml'));
      const events = parseEventsYaml(readDemoYaml('events.yaml'));
      const media = parseMediaYaml(readDemoYaml('media.yaml'));
      const narratives = parseNarrativesYaml(readDemoYaml('narratives.yaml'));

      const syntheticAudioNarratives: Narrative[] = [
        {
          id: 'nar_e2e_family_story',
          slug: 'springfield-parlor-story',
          kind: 'family_story',
          title: 'Evening on Eighth Street',
          summary: 'Synthetic public-domain family story testing narrative audio story labeling.',
          date_edtf: '1855',
          person_ids: ['p_abraham_lincoln_1809'],
          event_ids: [],
          place_ids: ['pl_springfield_il'],
          source_ids: ['src_census_1850_springfield'],
          body_md: 'A synthetic archival parlor recollection from Springfield.',
          extensions: {
            narrative_audio: {
              file: 'media/audio-abraham-lincoln-bio.mp3',
              duration_seconds: 42,
              story_voice: 'Puck',
            },
          },
        },
        {
          id: 'nar_e2e_research_note',
          slug: 'sangamon-deed-proof-note',
          kind: 'research_note',
          title: 'Sangamon County Deed Proof Note',
          summary: 'Synthetic research note verifying kind-specific audio labels and missing-audio fallback.',
          date_edtf: '1844',
          person_ids: ['p_abraham_lincoln_1809'],
          event_ids: [],
          place_ids: ['pl_springfield_il'],
          source_ids: ['src_sangamon_marriage_1842'],
          body_md: 'Synthetic proof summary correlating Springfield county deed entries.',
          extensions: {
            narrative_audio: {
              file: 'media/missing-narrative-audio.mp3',
              duration_seconds: 30,
              story_voice: 'Aoede',
            },
          },
        },
      ];

      const livingIds = new Set<string>();
      const ops: AtomicMutationOp[] = [];

      for (const person of people) {
        const sanitized = sanitizePersonForWrite(person, siteConfig.privacy);
        if (resolveEffectiveLiving(sanitized, siteConfig.privacy)) {
          livingIds.add(sanitized.id);
        }
        ops.push({
          entity_type: 'person',
          entity_id: sanitized.id,
          slug: sanitized.slug,
          action: 'create',
          expected_parent_revision_id: null,
          summary: 'Seed demo person',
          has_primary_source: true,
          before_json: null,
          after_json: sanitized as unknown as EntityPayload,
        });
      }

      for (const place of places) {
        ops.push({
          entity_type: 'place',
          entity_id: place.id,
          slug: place.slug,
          action: 'create',
          expected_parent_revision_id: null,
          summary: 'Seed demo place',
          has_primary_source: true,
          before_json: null,
          after_json: place as unknown as EntityPayload,
        });
      }

      for (const source of sources) {
        ops.push({
          entity_type: 'source',
          entity_id: source.id,
          slug: null,
          action: 'create',
          expected_parent_revision_id: null,
          summary: 'Seed demo source',
          has_primary_source: true,
          before_json: null,
          after_json: source as unknown as EntityPayload,
        });
      }

      for (const ev of events) {
        const sanitized = sanitizeEventForWrite(ev, livingIds, siteConfig.privacy);
        ops.push({
          entity_type: 'event',
          entity_id: sanitized.id,
          slug: null,
          action: 'create',
          expected_parent_revision_id: null,
          summary: 'Seed demo event',
          has_primary_source: true,
          before_json: null,
          after_json: sanitized as unknown as EntityPayload,
        });
      }

      for (const item of media) {
        ops.push({
          entity_type: 'media',
          entity_id: item.id,
          slug: null,
          action: 'create',
          expected_parent_revision_id: null,
          summary: 'Seed demo media',
          has_primary_source: true,
          before_json: null,
          after_json: item as unknown as EntityPayload,
        });
      }

      for (const narrative of [...narratives, ...syntheticAudioNarratives]) {
        ops.push({
          entity_type: 'narrative',
          entity_id: narrative.id,
          slug: null,
          action: 'create',
          expected_parent_revision_id: null,
          summary: 'Seed demo narrative',
          has_primary_source: true,
          before_json: null,
          after_json: narrative as unknown as EntityPayload,
        });
      }

      for (const edge of kinship) {
        ops.push({
          entity_type: 'kinship_edge',
          entity_id: deriveKinshipEdgeId(edge),
          slug: null,
          action: 'create',
          expected_parent_revision_id: null,
          summary: 'Seed demo kinship edge',
          has_primary_source: true,
          before_json: null,
          after_json: edge as unknown as EntityPayload,
        });
      }

      const mediaFiles: Array<{
        key: string;
        bytes: Uint8Array;
        contentType: string;
        sha256: Sha256Hex;
      }> = [];
      if (fs.existsSync(DEMO_PUBLIC_MEDIA_DIR)) {
        for (const filename of fs.readdirSync(DEMO_PUBLIC_MEDIA_DIR)) {
          const fullPath = path.join(DEMO_PUBLIC_MEDIA_DIR, filename);
          if (!fs.statSync(fullPath).isFile()) {
            continue;
          }
          const bytes = new Uint8Array(fs.readFileSync(fullPath));
          const digest = await sha256Hex(bytes);
          mediaFiles.push({
            key: `media/${filename}`,
            bytes,
            contentType: contentTypeForPath(fullPath),
            sha256: digest,
          });
        }
      }

      const [readBackupHash, writeBatchHash] = await Promise.all([
        sha256Hex(new TextEncoder().encode(DEFAULT_READ_BACKUP_TOKEN)),
        sha256Hex(new TextEncoder().encode(DEFAULT_WRITE_BATCH_TOKEN)),
      ]);

      return { siteConfig, ops, mediaFiles, readBackupHash, writeBatchHash };
    })();
  }
  return cachedSeedPromise;
}

async function applySqlScript(db: D1Database, sqlScript: string): Promise<void> {
  const withoutComments = sqlScript
    .split('\n')
    .map((line) => (line.trimStart().startsWith('--') ? '' : line))
    .join('\n');
  const statements = withoutComments
    .split(';')
    .map((stmt) => stmt.trim())
    .filter((stmt) => stmt.length > 0);
  if (statements.length > 0) {
    await db.batch(statements.map((stmt) => db.prepare(stmt)));
  }
}

function makeFakePcmBase64(): string {
  const bytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
  return Buffer.from(bytes).toString('base64');
}

async function readNodeRequestBody(req: http.IncomingMessage): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer));
  }
  return new Uint8Array(Buffer.concat(chunks));
}

export interface RecordedTtsCall {
  readonly url: string;
  readonly apiKey: string | null;
  readonly body: string;
}

export interface StartMiniflarePluginHarnessOptions {
  readonly mode: 'private' | 'public';
  readonly includeWebAnalytics?: boolean;
}

export interface MiniflarePluginHarness {
  readonly baseUrl: string;
  readonly mode: 'private' | 'public';
  readonly db: D1Database;
  readonly bucket: R2Bucket;
  readonly clock: FixedClock;
  readonly adminEmail: string;
  readonly editorEmail: string;
  readonly inviteToken: string;
  readonly readBackupToken: string;
  readonly writeBatchToken: string;
  readonly webAnalyticsToken: string;
  readonly ttsCalls: RecordedTtsCall[];
  readonly observabilityLogs: WorkersObservabilityLogRecord[];
  readonly securityEvents: SecurityTelemetryLogRecord[];
  getIsolateGeneration(): number;
  rotateIsolate(): void;
  flushWaitUntil(): Promise<void>;
  signInAs(page: Page, role: 'admin' | 'editor'): Promise<void>;
  signOut(page: Page): Promise<void>;
  close(): Promise<void>;
}

let harnessSeq = 0;

/**
 * Starts a full-stack Miniflare D1 + R2 + Cloudflare Worker test harness serving the built
 * demo SPA with all built-in server & UI plugins enabled and cold-isolate rotation support.
 */
export async function startMiniflarePluginHarness(
  options: StartMiniflarePluginHarnessOptions
): Promise<MiniflarePluginHarness> {
  const seed = await getCachedDemoSeed();
  const siteConfig = structuredClone(seed.siteConfig);
  const clock = new FixedClock('2026-11-27T12:00:00.000Z');
  const instanceId = ++harnessSeq;

  const mf = new Miniflare({
    modules: true,
    compatibilityDate: '2026-08-06',
    script: 'export default { fetch() { return new Response("ok"); } };',
    d1Databases: {
      DB: `e2e-plugins-${options.mode}-${instanceId}-db`,
    },
    r2Buckets: {
      MEDIA_BUCKET: `e2e-plugins-${options.mode}-${instanceId}-r2`,
    },
  });

  const db = (await mf.getD1Database('DB')) as unknown as D1Database;
  const bucket = (await mf.getR2Bucket('MEDIA_BUCKET')) as unknown as R2Bucket;

  for (const filename of listCoreMigrationFiles()) {
    const sql = fs.readFileSync(path.join(WORKER_MIGRATIONS_DIR, filename), 'utf8');
    await applySqlScript(db, sql);
  }
  await runD1PluginMigrations(db, [createRecipesServerPlugin(), createBookPublishingServerPlugin()], clock);

  // Seed demo archive directly into Miniflare D1 + R2.
  const repo = createD1ArchiveRepository(db, { privacyConfig: siteConfig.privacy, clock });
  const seedAuthor: RevisionAuthor = {
    author_id: 'system:seed',
    author_name: 'Initial seed',
    author_type: 'system_seed',
  };
  const committed = await repo.commitAtomicMutations({
    batch_id: null,
    author: seedAuthor,
    nowIso: clock.nowIso(),
    operations: structuredClone(seed.ops) as AtomicMutationOp[],
  });
  if (committed.kind !== 'committed') {
    await mf.dispose();
    throw new Error(`Failed seeding Miniflare D1 demo archive: conflict on ${committed.entity_id}`);
  }

  const snapshot = await repo.loadActiveSnapshot();
  const bundleCache = new R2IncrementalPatchBundleCache({
    bucket,
    siteConfig,
    clock,
    mode: options.mode,
  });
  await bundleCache.rebuildAndStore(snapshot);

  const mediaStore = new R2MediaStore(bucket);
  await Promise.all(
    seed.mediaFiles.map((mediaFile) =>
      mediaStore.put({
        key: mediaFile.key,
        body: mediaFile.bytes.slice().buffer,
        contentType: mediaFile.contentType,
        sha256: mediaFile.sha256,
      })
    )
  );

  await repo.upsertUser({
    email: DEFAULT_ADMIN_EMAIL,
    display_name: 'Archive Admin',
    role: 'admin',
    added_by: 'bootstrap',
    added_at: clock.nowIso(),
    last_login_at: null,
  });
  await repo.upsertUser({
    email: DEFAULT_EDITOR_EMAIL,
    display_name: 'Archive Editor',
    role: 'editor',
    added_by: DEFAULT_ADMIN_EMAIL,
    added_at: clock.nowIso(),
    last_login_at: null,
  });
  await repo.createInvite({
    token: DEFAULT_INVITE_TOKEN,
    label: 'Reunion Cousins',
    created_by: DEFAULT_ADMIN_EMAIL,
    created_at: clock.nowIso(),
    expires_at: '2027-11-27T12:00:00.000Z',
    revoked_at: null,
    uses: 0,
    last_used_at: null,
  });
  await repo.createAgentToken({
    token_id: 'tok_e2e_read_backup',
    token_hash: seed.readBackupHash,
    label: 'E2E Probe Read Backup',
    scope: 'read_backup',
    created_by: DEFAULT_ADMIN_EMAIL,
    created_at: clock.nowIso(),
    revoked_at: null,
  });
  await repo.createAgentToken({
    token_id: 'tok_e2e_write_batch',
    token_hash: seed.writeBatchHash,
    label: 'E2E Agent Write Batch',
    scope: 'write_batch',
    created_by: DEFAULT_ADMIN_EMAIL,
    created_at: clock.nowIso(),
    revoked_at: null,
  });

  const assets = createDemoAssetsFetcher(DEMO_DIST_DIR);
  const workerEnv: KinloomWorkerEnv = {
    DB: db,
    MEDIA_BUCKET: bucket,
    ASSETS: assets,
    SESSION_SECRET: MINIFLARE_E2E_SESSION_SECRET,
    BOOTSTRAP_ADMIN_EMAIL: DEFAULT_ADMIN_EMAIL,
    ARCHIVE_MODE: options.mode,
    // Deliberately omit GEMINI_API_KEY so Pronunciation & TTS must hydrate from D1 secrets!
  };

  const ttsCalls: RecordedTtsCall[] = [];
  const observabilityLogs: WorkersObservabilityLogRecord[] = [];
  const securityEvents: SecurityTelemetryLogRecord[] = [];

  const mockTtsFetch: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const headers = new Headers(init?.headers);
    const body = String(init?.body ?? '');
    ttsCalls.push({ url, apiKey: headers.get('x-goog-api-key'), body });
    return new Response(
      JSON.stringify({
        candidates: [
          {
            content: {
              parts: [
                {
                  inlineData: {
                    mimeType: 'audio/L16;codec=pcm;rate=24000',
                    data: makeFakePcmBase64(),
                  },
                },
              ],
            },
          },
        ],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    );
  };

  const mockLuluFetch: typeof fetch = async () =>
    new Response(JSON.stringify({ error: 'Deterministic offline Lulu mock' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });

  const buildWorkerIsolate = (): ExportedHandler<KinloomWorkerEnv> =>
    createCloudflareWorker({
      siteConfig,
      clock,
      pronunciationFetch: mockTtsFetch,
      plugins: [
        createWorkersObservabilityPlugin({
          clock,
          sink: (record) => {
            observabilityLogs.push(record);
          },
          securityTelemetry: {
            enabled: true,
            sink: (record) => {
              securityEvents.push(record);
            },
          },
          ...(options.includeWebAnalytics !== false
            ? { webAnalytics: { enabled: true, token: MINIFLARE_E2E_WEB_ANALYTICS_TOKEN } }
            : {}),
        }),
        createPageVisitStatsPlugin(),
        createOpenFinancePlugin({
          config: {
            visibility: {
              show_support_page: false,
              show_in_nav: false,
              show_in_footer: false,
            },
          },
        }),
        createRecipesServerPlugin(),
        createBookPublishingServerPlugin({ fetchImpl: mockLuluFetch }),
        createPronunciationPlugin(),
      ],
    });

  let isolateGeneration = 1;
  let activeWorker = buildWorkerIsolate();
  const pendingWaitUntil = new Set<Promise<unknown>>();

  const executionCtx: ExecutionContext = {
    waitUntil(promise: Promise<unknown>): void {
      const tracked = Promise.resolve(promise)
        .catch(() => {
          // Background tasks surface errors through plugin hooks; never crash harness.
        })
        .finally(() => {
          pendingWaitUntil.delete(tracked);
        });
      pendingWaitUntil.add(tracked);
    },
    passThroughOnException(): void {
      // No-op in local bridge.
    },
  };

  const httpServer = http.createServer((req, res) => {
    void (async () => {
      try {
        const address = httpServer.address() as AddressInfo;
        const origin = `http://127.0.0.1:${address.port}`;
        const method = req.method ?? 'GET';
        const headers = new Headers();
        for (const [key, value] of Object.entries(req.headers)) {
          if (value === undefined) continue;
          if (Array.isArray(value)) {
            for (const entry of value) headers.append(key, entry);
          } else {
            headers.set(key, value);
          }
        }
        const hasBody = method !== 'GET' && method !== 'HEAD';
        const bodyBytes = hasBody ? await readNodeRequestBody(req) : undefined;
        const reqUrl = `${origin}${req.url ?? '/'}`;
        const webReq = new Request(reqUrl, {
          method,
          headers,
          body: bodyBytes && bodyBytes.byteLength > 0 ? Buffer.from(bodyBytes) : undefined,
        });

        // Mirror Cloudflare Workers Static Assets (run_worker_first: false): serve hashed /assets/* directly.
        const reqPathname = new URL(reqUrl).pathname;
        const webRes =
          (method === 'GET' || method === 'HEAD') && reqPathname.startsWith('/assets/')
            ? await assets.fetch(webReq)
            : await activeWorker.fetch(webReq, workerEnv, executionCtx);
        res.statusCode = webRes.status;

        const setCookies =
          typeof webRes.headers.getSetCookie === 'function' ? webRes.headers.getSetCookie() : [];
        webRes.headers.forEach((value, key) => {
          if (key.toLowerCase() === 'set-cookie') return;
          res.setHeader(key, value);
        });
        if (setCookies.length > 0) {
          res.setHeader('set-cookie', setCookies);
        }

        const responseBuffer = Buffer.from(await webRes.arrayBuffer());
        res.end(responseBuffer);
      } catch (error) {
        res.statusCode = 500;
        res.setHeader('content-type', 'text/plain; charset=utf-8');
        res.end(error instanceof Error ? error.message : String(error));
      }
    })();
  });

  const openSockets = new Set<Socket>();
  httpServer.keepAliveTimeout = 1000;
  httpServer.on('connection', (socket) => {
    openSockets.add(socket);
    socket.once('close', () => {
      openSockets.delete(socket);
    });
  });

  await new Promise<void>((resolve) => {
    httpServer.listen(0, '127.0.0.1', () => resolve());
  });
  const address = httpServer.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  async function flushWaitUntil(): Promise<void> {
    while (pendingWaitUntil.size > 0) {
      await Promise.all([...pendingWaitUntil]);
    }
  }

  async function signInAs(page: Page, role: 'admin' | 'editor'): Promise<void> {
    const email = role === 'admin' ? DEFAULT_ADMIN_EMAIL : DEFAULT_EDITOR_EMAIL;
    const displayName = role === 'admin' ? 'Archive Admin' : 'Archive Editor';
    const token = await signSessionToken({
      secret: MINIFLARE_E2E_SESSION_SECRET,
      clock,
      ttlSeconds: 3600,
      payload: {
        kind: 'user',
        email,
        display_name: displayName,
        role,
      },
    });
    const url = new URL(baseUrl);
    await page.context().addCookies([
      {
        name: getSessionCookieName(false),
        value: token,
        domain: url.hostname,
        path: '/',
        httpOnly: true,
        sameSite: 'Lax',
      },
    ]);
  }

  async function signOut(page: Page): Promise<void> {
    await page.context().clearCookies();
  }

  let closePromise: Promise<void> | null = null;

  return {
    baseUrl,
    mode: options.mode,
    db,
    bucket,
    clock,
    adminEmail: DEFAULT_ADMIN_EMAIL,
    editorEmail: DEFAULT_EDITOR_EMAIL,
    inviteToken: DEFAULT_INVITE_TOKEN,
    readBackupToken: DEFAULT_READ_BACKUP_TOKEN,
    writeBatchToken: DEFAULT_WRITE_BATCH_TOKEN,
    webAnalyticsToken: MINIFLARE_E2E_WEB_ANALYTICS_TOKEN,
    ttsCalls,
    observabilityLogs,
    securityEvents,
    getIsolateGeneration: () => isolateGeneration,
    rotateIsolate(): void {
      isolateGeneration += 1;
      activeWorker = buildWorkerIsolate();
    },
    flushWaitUntil,
    signInAs,
    signOut,
    close: async () => {
      if (closePromise) return closePromise;
      closePromise = (async () => {
        await flushWaitUntil();
        await new Promise<void>((resolve) => {
          let settled = false;
          const finish = (): void => {
            if (settled) return;
            settled = true;
            clearTimeout(forceTimer);
            resolve();
          };
          const forceTimer = setTimeout(() => {
            for (const socket of openSockets) socket.destroy();
            openSockets.clear();
            httpServer.closeAllConnections?.();
            finish();
          }, 2500);
          forceTimer.unref();

          httpServer.close(() => finish());
          httpServer.closeIdleConnections?.();
          for (const socket of openSockets) socket.destroy();
          openSockets.clear();
          httpServer.closeAllConnections?.();
        });
        await mf.dispose();
      })();
      return closePromise;
    },
  };
}
