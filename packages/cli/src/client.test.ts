import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { KinloomApiClient } from './client.js';
import { CliValidationError, EXIT_CONFLICT, EXIT_ERROR, EXIT_USAGE, KinloomApiError } from './errors.js';

interface RecordedRequest {
  method: string;
  url: string;
  headers: IncomingMessage['headers'];
  body: string;
}

describe('KinloomApiClient', () => {
  let baseUrl = '';
  let lastRequest: RecordedRequest | null = null;
  let server: ReturnType<typeof createServer>;
  let responder: (req: IncomingMessage, body: string, res: ServerResponse) => void = (
    _req,
    _body,
    res
  ) => {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'Not found' } }));
  };

  beforeAll(async () => {
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        lastRequest = {
          method: req.method ?? '',
          url: req.url ?? '',
          headers: req.headers,
          body,
        };
        responder(req, body, res);
      });
    });

    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  it('rejects malformed or non-HTTP site URLs with CliValidationError', () => {
    expect(() => new KinloomApiClient({ baseUrl: 'not-a-url' })).toThrow(CliValidationError);
    try {
      new KinloomApiClient({ baseUrl: 'ftp://archive.example.test' });
      expect.unreachable('Expected ftp URL to throw');
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(CliValidationError);
      expect((err as CliValidationError).exitCode).toBe(EXIT_USAGE);
    }
  });

  it('sends Bearer auth and If-None-Match headers and handles 304 Not Modified', async () => {
    responder = (req, _body, res) => {
      if (req.headers['if-none-match'] === '"r12"') {
        res.writeHead(304, { etag: '"r12"' });
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json', etag: '"r13"' });
      res.end(
        JSON.stringify({
          head_revision_id: 13,
          exported_at: '2026-01-01T00:00:00.000Z',
          files: { 'people.yaml': '[]\n' },
        })
      );
    };

    const client = new KinloomApiClient({ baseUrl: `${baseUrl}/`, token: 'secret-tok-123' });

    const skipped = await client.exportYaml({ ifNoneMatch: '"r12"' });
    expect(skipped).toEqual({ status: 'not_modified', etag: '"r12"' });
    expect(lastRequest?.headers.authorization).toBe('Bearer secret-tok-123');
    expect(lastRequest?.headers['if-none-match']).toBe('"r12"');

    const fresh = await client.exportYaml({ ifNoneMatch: '"r11"' });
    expect(fresh).toEqual({
      status: 'ok',
      head_revision_id: 13,
      exported_at: '2026-01-01T00:00:00.000Z',
      etag: '"r13"',
      files: { 'people.yaml': '[]\n' },
    });
  });

  it('maps 401, 403, 422, and 409 Conflict envelopes to typed KinloomApiError instances', async () => {
    const client = new KinloomApiClient({ baseUrl, token: 'tok' });

    const cases: Array<{
      status: number;
      code: string;
      expectedKind: KinloomApiError['kind'];
      expectedExitCode: number;
    }> = [
      { status: 401, code: 'UNAUTHORIZED', expectedKind: 'unauthorized', expectedExitCode: EXIT_ERROR },
      { status: 403, code: 'FORBIDDEN', expectedKind: 'forbidden', expectedExitCode: EXIT_ERROR },
      { status: 422, code: 'PRIVACY_VIOLATION', expectedKind: 'unprocessable', expectedExitCode: EXIT_ERROR },
    ];

    for (const c of cases) {
      responder = (_req, _body, res) => {
        res.writeHead(c.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { code: c.code, message: `Denied: ${c.code}` } }));
      };

      await expect(client.exportYaml()).rejects.toMatchObject({
        name: 'KinloomApiError',
        status: c.status,
        kind: c.expectedKind,
        code: c.code,
        exitCode: c.expectedExitCode,
      });
    }

    responder = (_req, _body, res) => {
      res.writeHead(409, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          error: {
            code: 'OPTIMISTIC_CONFLICT',
            message: 'Entity person/per_arthur_alder changed concurrently.',
            details: {
              kind: 'conflict',
              entity_type: 'person',
              entity_id: 'per_arthur_alder',
              expected_parent_revision_id: 4,
              server_revision_id: 5,
              server_entity: { id: 'per_arthur_alder', full_name: 'Arthur Alder Jr.' },
              server_deleted_at: null,
              last_author_name: 'Archivist',
              last_updated_at: '2026-01-02T12:00:00.000Z',
              diff: {
                fields: [
                  {
                    path: 'full_name',
                    kind: 'changed',
                    before: 'Arthur Alder Jr.',
                    after: 'Arthur Alder',
                  },
                ],
                addedCount: 0,
                removedCount: 0,
                changedCount: 1,
                hasChanges: true,
              },
            },
          },
        })
      );
    };

    try {
      await client.submitBatch({
        batch_id: 'b_conflict',
        author_type: 'agent',
        summary: 'Update Arthur Alder',
        has_primary_source: true,
        patches: [
          {
            action: 'update',
            entity_type: 'person',
            entity_id: 'per_arthur_alder',
            parent_revision_id: 4,
            data: { full_name: 'Arthur Alder' },
            merge: true,
          },
        ],
      });
      expect.unreachable('Expected 409 Conflict error');
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(KinloomApiError);
      const apiErr = err as KinloomApiError;
      expect(apiErr.kind).toBe('conflict');
      expect(apiErr.exitCode).toBe(EXIT_CONFLICT);
      expect(apiErr.conflict?.server_revision_id).toBe(5);
      expect(apiErr.conflict?.diff.fields).toEqual([
        {
          path: 'full_name',
          kind: 'changed',
          before: 'Arthur Alder Jr.',
          after: 'Arthur Alder',
        },
      ]);
    }
  });

  it('unwraps wrapped { snapshot } responses and preserves root-level snapshot compatibility in exportSnapshot', async () => {
    const client = new KinloomApiClient({ baseUrl, token: 'snap-tok' });
    const sampleEntity = {
      entity_type: 'place',
      entity_id: 'plc_oak_county_ohio',
      slug: 'oak-county-ohio',
      data: {
        id: 'plc_oak_county_ohio',
        slug: 'oak-county-ohio',
        name: 'Oak County',
        full_name: 'Oak County, Ohio, USA',
        place_type: 'county',
        parent_id: null,
        lat: 40.25,
        lng: -82.85,
        historical_names: [],
      },
      current_revision_id: 7,
      has_primary_source: true,
      deleted_at: null,
      updated_at: '2026-01-05T00:00:00.000Z',
    };

    // 1. Wrapped server response ({ head_revision_id, exported_at, snapshot: { ... } }).
    responder = (_req, _body, res) => {
      res.writeHead(200, { 'content-type': 'application/json', etag: '"r7"' });
      res.end(
        JSON.stringify({
          head_revision_id: 7,
          exported_at: '2026-01-05T00:00:00.000Z',
          snapshot: {
            head_revision_id: 7,
            entities: [sampleEntity],
            kinship: [],
          },
        })
      );
    };
    const wrapped = await client.exportSnapshot();
    expect(wrapped.status).toBe('ok');
    if (wrapped.status === 'ok') {
      expect(wrapped.etag).toBe('"r7"');
      expect(wrapped.snapshot.head_revision_id).toBe(7);
      expect(wrapped.snapshot.entities).toHaveLength(1);
      expect(wrapped.snapshot.entities[0].entity_id).toBe('plc_oak_county_ohio');
      expect(wrapped.snapshot.kinship).toEqual([]);
    }

    // 2. Wrapped response where head_revision_id is only on the outer envelope.
    responder = (_req, _body, res) => {
      res.writeHead(200, { 'content-type': 'application/json', etag: '"r8"' });
      res.end(
        JSON.stringify({
          head_revision_id: 8,
          exported_at: '2026-01-06T00:00:00.000Z',
          snapshot: {
            entities: [sampleEntity],
            kinship: [],
          },
        })
      );
    };
    const outerRevWrapped = await client.exportSnapshot();
    expect(outerRevWrapped.status).toBe('ok');
    if (outerRevWrapped.status === 'ok') {
      expect(outerRevWrapped.snapshot.head_revision_id).toBe(8);
    }

    // 3. Unwrapped root-level snapshot payload remains backward-compatible.
    responder = (_req, _body, res) => {
      res.writeHead(200, { 'content-type': 'application/json', etag: '"r9"' });
      res.end(
        JSON.stringify({
          head_revision_id: 9,
          entities: [sampleEntity],
          kinship: [],
        })
      );
    };
    const unwrapped = await client.exportSnapshot();
    expect(unwrapped.status).toBe('ok');
    if (unwrapped.status === 'ok') {
      expect(unwrapped.snapshot.head_revision_id).toBe(9);
      expect(unwrapped.snapshot.entities).toHaveLength(1);
    }

    // 4. Invalid shape still fails with INVALID_RESPONSE_SCHEMA.
    responder = (_req, _body, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ snapshot: { entities: [] } }));
    };
    await expect(client.exportSnapshot()).rejects.toMatchObject({
      name: 'KinloomApiError',
      status: 200,
      code: 'INVALID_RESPONSE_SCHEMA',
    });
  });
});
