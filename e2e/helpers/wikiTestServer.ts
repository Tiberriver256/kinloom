import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import path from 'node:path';
import type { AtomicMutationOp, EntityPayload, KinloomSiteConfig, RevisionAuthor } from '@kinloom/core';
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
  createInMemoryServerPorts,
  createKinloomServer,
  type InMemoryServerPortsBundle,
  type KinloomServer,
  sha256Hex,
} from '@kinloom/server';

const REPO_ROOT = path.resolve(import.meta.dirname, '../..');
const DEMO_ROOT = path.join(REPO_ROOT, 'examples', 'demo');
const DEMO_DATA_DIR = path.join(DEMO_ROOT, 'data');
const DEMO_DIST_DIR = path.join(DEMO_ROOT, 'dist');
const DEMO_PUBLIC_MEDIA_DIR = path.join(DEMO_ROOT, 'public', 'media');

const SESSION_SECRET = 'kinloom-e2e-test-session-secret-0123456789abcdef';
const DEFAULT_INVITE_TOKEN = 'reunion-2026-invite';
const DEFAULT_AGENT_TOKEN_SECRET = 'kl_agent_e2e_write_batch_secret_2026';

const MIME_BY_EXT: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.mp4': 'video/mp4',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
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

function injectLiveWikiMeta(html: string): string {
  const tags = [
    '<meta name="kinloom-backend" content="http" />',
    '<meta name="kinloom-demo-plugin" content="true" />',
  ].join('\n    ');
  return html.replace('</head>', `    ${tags}\n  </head>`);
}

let sharedAssetHandler: { fetch(request: Request): Promise<Response> } | null = null;

function createDemoDistAssetHandler(distDir: string): {
  fetch(request: Request): Promise<Response>;
} {
  if (sharedAssetHandler) {
    return sharedAssetHandler;
  }
  const resolvedDist = path.resolve(distDir);
  const indexHtmlPath = path.join(resolvedDist, 'index.html');
  if (!fs.existsSync(indexHtmlPath)) {
    throw new Error(
      `Missing built demo SPA at ${indexHtmlPath}. Run "npm run build --workspace=@kinloom/demo" first.`
    );
  }
  const indexHtml = injectLiveWikiMeta(fs.readFileSync(indexHtmlPath, 'utf8'));
  const fileCache = new Map<string, { bytes: Uint8Array; contentType: string }>();

  sharedAssetHandler = {
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);
      let decodedPath = '/';
      try {
        decodedPath = decodeURIComponent(url.pathname);
      } catch {
        return new Response('Bad Request', { status: 400 });
      }

      const relPath = decodedPath.replace(/^\/+/, '');
      if (relPath && !relPath.includes('..')) {
        const candidate = path.resolve(resolvedDist, relPath);
        if (candidate === indexHtmlPath) {
          return new Response(indexHtml, {
            status: 200,
            headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
          });
        }
        const cached = fileCache.get(candidate);
        if (cached) {
          return new Response(cached.bytes, {
            status: 200,
            headers: {
              'content-type': cached.contentType,
              'cache-control': 'no-cache',
            },
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
          return new Response(bytes, {
            status: 200,
            headers: {
              'content-type': contentType,
              'cache-control': 'no-cache',
            },
          });
        }
      }

      return new Response(indexHtml, {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
      });
    },
  };
  return sharedAssetHandler;
}

interface CachedDemoSeed {
  readonly siteConfig: KinloomSiteConfig;
  readonly ops: AtomicMutationOp[];
  readonly mediaFiles: ReadonlyArray<{
    readonly key: string;
    readonly bytes: Uint8Array;
    readonly contentType: string;
    readonly sha256: string;
  }>;
  readonly agentHash: string;
}

let cachedDemoSeedPromise: Promise<CachedDemoSeed> | null = null;

async function getCachedDemoSeed(): Promise<CachedDemoSeed> {
  if (!cachedDemoSeedPromise) {
    cachedDemoSeedPromise = (async () => {
      const siteConfig = parseKinloomConfigYaml(readDemoYaml('kinloom.config.yaml'));
      const people = parsePeopleYaml(readDemoYaml('people.yaml'));
      const places = parsePlacesYaml(readDemoYaml('places.yaml'));
      const sources = parseSourcesYaml(readDemoYaml('sources.yaml'));
      const kinship = parseKinshipYaml(readDemoYaml('kinship.yaml'));
      const events = parseEventsYaml(readDemoYaml('events.yaml'));
      const media = parseMediaYaml(readDemoYaml('media.yaml'));
      const narratives = parseNarrativesYaml(readDemoYaml('narratives.yaml'));

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

      for (const narrative of narratives) {
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
        sha256: string;
      }> = [];
      if (fs.existsSync(DEMO_PUBLIC_MEDIA_DIR)) {
        const files = fs.readdirSync(DEMO_PUBLIC_MEDIA_DIR);
        for (const filename of files) {
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

      const agentHash = await sha256Hex(new TextEncoder().encode(DEFAULT_AGENT_TOKEN_SECRET));
      return { siteConfig, ops, mediaFiles, agentHash };
    })();
  }
  return cachedDemoSeedPromise;
}

async function seedDemoRepository(seed: CachedDemoSeed, ports: InMemoryServerPortsBundle): Promise<void> {
  const seedAuthor: RevisionAuthor = {
    author_id: 'system:seed',
    author_name: 'Initial seed',
    author_type: 'system_seed',
  };

  const committed = await ports.repository.commitAtomicMutations({
    batch_id: null,
    author: seedAuthor,
    nowIso: ports.clock.nowIso(),
    operations: structuredClone(seed.ops),
  });

  if (committed.kind !== 'committed') {
    throw new Error(`Failed seeding demo repository: conflict on ${committed.entity_id}`);
  }

  const snapshot = await ports.repository.loadActiveSnapshot();
  await ports.bundleCache.rebuildAndStore(snapshot);

  for (const mediaFile of seed.mediaFiles) {
    await ports.mediaStore.put({
      key: mediaFile.key,
      body: mediaFile.bytes.slice().buffer,
      contentType: mediaFile.contentType,
      sha256: mediaFile.sha256,
    });
  }
}

async function readNodeRequestBody(req: http.IncomingMessage): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer));
  }
  return new Uint8Array(Buffer.concat(chunks));
}

export interface LiveWikiTestHarness {
  readonly baseUrl: string;
  readonly inviteToken: string;
  readonly agentWriteToken: string;
  readonly adminEmail: string;
  readonly siteConfig: KinloomSiteConfig;
  readonly ports: InMemoryServerPortsBundle;
  readonly server: KinloomServer;
  close(): Promise<void>;
}

export async function startLiveWikiTestServer(): Promise<LiveWikiTestHarness> {
  const seed = await getCachedDemoSeed();
  const siteConfig = structuredClone(seed.siteConfig);
  const ports = createInMemoryServerPorts(siteConfig, {
    initialIso: '2026-11-24T12:00:00.000Z',
  });
  ports.assetHandler = createDemoDistAssetHandler(DEMO_DIST_DIR);

  await seedDemoRepository(seed, ports);

  const adminEmail = 'steward@archive.example';
  await ports.repository.upsertUser({
    email: adminEmail,
    display_name: 'Archive Steward',
    role: 'admin',
    added_by: 'bootstrap',
    added_at: ports.clock.nowIso(),
    last_login_at: null,
  });

  await ports.repository.createInvite({
    token: DEFAULT_INVITE_TOKEN,
    label: 'Reunion Cousins',
    created_by: adminEmail,
    created_at: ports.clock.nowIso(),
    expires_at: '2027-11-24T12:00:00.000Z',
    revoked_at: null,
    uses: 0,
    last_used_at: null,
  });

  await ports.repository.createAgentToken({
    token_id: 'tok_demo_research_agent',
    token_hash: seed.agentHash,
    label: 'Demo Research Agent',
    scope: 'write_batch',
    created_by: adminEmail,
    created_at: ports.clock.nowIso(),
    revoked_at: null,
  });

  const server = createKinloomServer({
    siteConfig,
    ports,
    sessionSecret: SESSION_SECRET,
    bootstrapAdminEmail: adminEmail,
  });

  const httpServer = http.createServer((req, res) => {
    void (async () => {
      try {
        const address = httpServer.address() as AddressInfo;
        const origin = `http://127.0.0.1:${address.port}`;
        const method = req.method ?? 'GET';
        const headers = new Headers();
        for (const [key, value] of Object.entries(req.headers)) {
          if (value === undefined) {
            continue;
          }
          if (Array.isArray(value)) {
            for (const entry of value) {
              headers.append(key, entry);
            }
          } else {
            headers.set(key, value);
          }
        }

        const hasBody = method !== 'GET' && method !== 'HEAD';
        const bodyBytes = hasBody ? await readNodeRequestBody(req) : undefined;
        const webReq = new Request(`${origin}${req.url ?? '/'}`, {
          method,
          headers,
          body: bodyBytes && bodyBytes.byteLength > 0 ? Buffer.from(bodyBytes) : undefined,
        });

        const webRes = await server.fetch(webReq);
        res.statusCode = webRes.status;

        const setCookies =
          typeof webRes.headers.getSetCookie === 'function' ? webRes.headers.getSetCookie() : [];
        webRes.headers.forEach((value, key) => {
          if (key.toLowerCase() === 'set-cookie') {
            return;
          }
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
    httpServer.listen(0, '127.0.0.1', () => {
      resolve();
    });
  });

  const address = httpServer.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;
  let closePromise: Promise<void> | null = null;

  return {
    baseUrl,
    inviteToken: DEFAULT_INVITE_TOKEN,
    agentWriteToken: DEFAULT_AGENT_TOKEN_SECRET,
    adminEmail,
    siteConfig,
    ports,
    server,
    close: async () => {
      if (closePromise) {
        return closePromise;
      }
      closePromise = new Promise<void>((resolve) => {
        let settled = false;
        const finish = (): void => {
          if (settled) {
            return;
          }
          settled = true;
          clearTimeout(forceTimer);
          resolve();
        };

        const forceTimer = setTimeout(() => {
          for (const socket of openSockets) {
            socket.destroy();
          }
          openSockets.clear();
          httpServer.closeAllConnections?.();
          finish();
        }, 2500);
        forceTimer.unref();

        httpServer.close(() => {
          finish();
        });
        httpServer.closeIdleConnections?.();
        for (const socket of openSockets) {
          socket.destroy();
        }
        openSockets.clear();
        httpServer.closeAllConnections?.();
      });
      return closePromise;
    },
  };
}
