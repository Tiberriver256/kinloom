import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { KinloomApiClient, resolveAuthToken } from '../client.js';
import { CliValidationError, KinloomApiError } from '../errors.js';
import { serializeSnapshotToYamlFiles } from './dataFiles.js';

export interface ExportYamlCommandOptions {
  siteUrl: string;
  outDir: string;
  token?: string | undefined;
  stateFile?: string | undefined;
  fetchImpl?: typeof fetch | undefined;
}

export type ExportYamlCommandResult =
  | {
      status: 'not_modified';
      revisionId: number | null;
      etag: string | null;
      writtenFiles: [];
    }
  | {
      status: 'exported';
      revisionId: number;
      etag: string | null;
      source: 'yaml_endpoint' | 'snapshot_fallback';
      writtenFiles: string[];
      stateFile: string;
    };

async function readLastRevision(stateFile: string): Promise<number | null> {
  try {
    const raw = (await readFile(stateFile, 'utf8')).trim();
    if (!raw) {
      return null;
    }
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isInteger(parsed) || parsed < 0 || String(parsed) !== raw) {
      throw new CliValidationError(
        `Invalid revision state in '${stateFile}': expected a non-negative integer, found '${raw}'.`
      );
    }
    return parsed;
  } catch (err: unknown) {
    if (typeof err === 'object' && err !== null && 'code' in err && err.code === 'ENOENT') {
      return null;
    }
    throw err;
  }
}

function assertSafeFilename(filename: string): void {
  if (
    !filename ||
    filename === '.' ||
    filename === '..' ||
    path.basename(filename) !== filename ||
    filename.includes('/') ||
    filename.includes('\\')
  ) {
    throw new CliValidationError(`Unsafe export filename returned by server: '${filename}'.`);
  }
}

export async function runExportYamlCommand(
  options: ExportYamlCommandOptions
): Promise<ExportYamlCommandResult> {
  const outDir = options.outDir.trim();
  if (!outDir) {
    throw new CliValidationError('`--out` data directory is required for `kinloom export-yaml`.');
  }

  const resolvedOutDir = path.resolve(outDir);
  const stateFile = path.resolve(
    options.stateFile?.trim() || path.join(resolvedOutDir, '.last-backup-revision')
  );
  const lastRevision = await readLastRevision(stateFile);
  const ifNoneMatch = lastRevision !== null ? `"r${lastRevision}"` : undefined;

  const client = new KinloomApiClient({
    baseUrl: options.siteUrl,
    token: resolveAuthToken(options.token),
    fetchImpl: options.fetchImpl,
  });

  let files: Record<string, string>;
  let headRevisionId: number;
  let etag: string | null;
  let source: 'yaml_endpoint' | 'snapshot_fallback';

  try {
    const yamlResult = await client.exportYaml({ ifNoneMatch });
    if (yamlResult.status === 'not_modified') {
      return {
        status: 'not_modified',
        revisionId: lastRevision,
        etag: yamlResult.etag,
        writtenFiles: [],
      };
    }
    files = yamlResult.files;
    headRevisionId = yamlResult.head_revision_id;
    etag = yamlResult.etag;
    source = 'yaml_endpoint';
  } catch (err: unknown) {
    if (!(err instanceof KinloomApiError && err.kind === 'not_found')) {
      throw err;
    }
    const snapshotResult = await client.exportSnapshot({ ifNoneMatch });
    if (snapshotResult.status === 'not_modified') {
      return {
        status: 'not_modified',
        revisionId: lastRevision,
        etag: snapshotResult.etag,
        writtenFiles: [],
      };
    }
    files = serializeSnapshotToYamlFiles(snapshotResult.snapshot);
    headRevisionId = snapshotResult.snapshot.head_revision_id;
    etag = snapshotResult.etag;
    source = 'snapshot_fallback';
  }

  await mkdir(resolvedOutDir, { recursive: true });
  const sortedNames = Object.keys(files).toSorted((a, b) => a.localeCompare(b));
  const writtenFiles: string[] = [];

  for (const name of sortedNames) {
    assertSafeFilename(name);
    const fullPath = path.join(resolvedOutDir, name);
    const fileContent = files[name];
    if (fileContent === undefined) continue;
    await writeFile(fullPath, fileContent, 'utf8');
    writtenFiles.push(fullPath);
  }

  await mkdir(path.dirname(stateFile), { recursive: true });
  await writeFile(stateFile, `${headRevisionId}\n`, 'utf8');

  return {
    status: 'exported',
    revisionId: headRevisionId,
    etag,
    source,
    writtenFiles,
    stateFile,
  };
}
