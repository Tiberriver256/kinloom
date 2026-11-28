import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  serializeEventsYaml,
  serializeKinshipYaml,
  serializeMediaYaml,
  serializeNarrativesYaml,
  serializePeopleYaml,
  serializePlacesYaml,
  serializeSourcesYaml,
} from '@kinloom/core';
import type { AppliedMultiEntityPatch } from './apply.js';
import type { PatchCommandResult, PatchEntityCounts, PendingPatchYamlWrite } from './types.js';

export function writeFileAtomicUtf8(filePath: string, content: string): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const suffix = randomBytes(6).toString('hex');
  const tmpPath = path.join(dir, `.${path.basename(filePath)}.tmp.${process.pid}.${suffix}`);
  fs.writeFileSync(tmpPath, content, 'utf8');
  fs.renameSync(tmpPath, filePath);
}

function writeFileAtomicBuffer(filePath: string, content: Buffer): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const suffix = randomBytes(6).toString('hex');
  const tmpPath = path.join(dir, `.${path.basename(filePath)}.tmp.${process.pid}.${suffix}`);
  fs.writeFileSync(tmpPath, content);
  fs.renameSync(tmpPath, filePath);
}

function hasEntityDelta(counts: PatchEntityCounts): boolean {
  return counts.added > 0 || counts.updated > 0 || counts.removed > 0;
}

export function buildPendingPatchYamlWrites(
  dataDir: string,
  applied: AppliedMultiEntityPatch
): PendingPatchYamlWrite[] {
  const pending: PendingPatchYamlWrite[] = [];

  if (hasEntityDelta(applied.counts.people)) {
    pending.push({
      fileName: 'people.yaml',
      fullPath: path.join(dataDir, 'people.yaml'),
      content: serializePeopleYaml(applied.people, { sortById: true }),
    });
  }
  if (hasEntityDelta(applied.counts.places)) {
    pending.push({
      fileName: 'places.yaml',
      fullPath: path.join(dataDir, 'places.yaml'),
      content: serializePlacesYaml(applied.places, { sortById: true }),
    });
  }
  if (hasEntityDelta(applied.counts.events)) {
    pending.push({
      fileName: 'events.yaml',
      fullPath: path.join(dataDir, 'events.yaml'),
      content: serializeEventsYaml(applied.events, { sortById: true }),
    });
  }
  if (hasEntityDelta(applied.counts.kinship)) {
    pending.push({
      fileName: 'kinship.yaml',
      fullPath: path.join(dataDir, 'kinship.yaml'),
      content: serializeKinshipYaml(applied.kinship, { sortDeterministic: true }),
    });
  }
  if (hasEntityDelta(applied.counts.sources)) {
    pending.push({
      fileName: 'sources.yaml',
      fullPath: path.join(dataDir, 'sources.yaml'),
      content: serializeSourcesYaml(applied.sources, { sortById: true }),
    });
  }
  if (hasEntityDelta(applied.counts.media)) {
    pending.push({
      fileName: 'media.yaml',
      fullPath: path.join(dataDir, 'media.yaml'),
      content: serializeMediaYaml(applied.media, { sortById: true }),
    });
  }
  if (hasEntityDelta(applied.counts.narratives)) {
    pending.push({
      fileName: 'narratives.yaml',
      fullPath: path.join(dataDir, 'narratives.yaml'),
      content: serializeNarrativesYaml(applied.narratives, { sortById: true }),
    });
  }

  return pending;
}

export function applyPatchYamlWritesWithRollback(
  pendingWrites: readonly PendingPatchYamlWrite[],
  writeFileFn: (filePath: string, content: string) => void
): string[] {
  if (pendingWrites.length === 0) {
    return [];
  }

  const writtenYamlFiles: string[] = [];
  const byteSnapshot = new Map<string, Buffer | null>();
  for (const item of pendingWrites) {
    byteSnapshot.set(item.fullPath, fs.existsSync(item.fullPath) ? fs.readFileSync(item.fullPath) : null);
  }

  try {
    for (const item of pendingWrites) {
      writeFileFn(item.fullPath, item.content);
      writtenYamlFiles.push(item.fullPath);
    }
  } catch (writeErr: unknown) {
    let rollbackNote = '';
    try {
      let restored = 0;
      for (const [filePath, origBytes] of byteSnapshot) {
        if (origBytes === null) {
          if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
            restored += 1;
          }
        } else if (!fs.existsSync(filePath) || !fs.readFileSync(filePath).equals(origBytes)) {
          writeFileAtomicBuffer(filePath, origBytes);
          restored += 1;
        }
      }
      rollbackNote = ` Rollback succeeded: ${restored} YAML file(s) restored byte-for-byte.`;
    } catch (rbErr: unknown) {
      const rbDetail = rbErr instanceof Error ? rbErr.message : String(rbErr);
      rollbackNote = ` Rollback FAILED: ${rbDetail}.`;
    }
    const detail = writeErr instanceof Error ? writeErr.message : String(writeErr);
    throw new Error(`Patch write failed: ${detail}.${rollbackNote}`, { cause: writeErr });
  }

  return writtenYamlFiles.toSorted((a, b) => a.localeCompare(b));
}

function formatCountsToken(label: string, counts: PatchEntityCounts): string {
  const removedPart = counts.removed > 0 ? `/-${counts.removed}` : '';
  return `${label}=+${counts.added}/~${counts.updated}${removedPart}`;
}

export function formatPatchTextReport(result: Omit<PatchCommandResult, 'rendered'>): string {
  const modeLabel = result.dryRun ? 'Patch dry-run OK' : 'Patch OK';
  const parts = [
    formatCountsToken('people', result.counts.people),
    formatCountsToken('places', result.counts.places),
    formatCountsToken('events', result.counts.events),
    formatCountsToken('kinship', result.counts.kinship),
    formatCountsToken('sources', result.counts.sources),
    formatCountsToken('media', result.counts.media),
    formatCountsToken('narratives', result.counts.narratives),
  ];
  const livingPart = result.allowLiving ? `, livingTouched=${result.livingPeopleTouched}` : '';
  const filesPart = result.dryRun
    ? `, wouldWrite=${result.wouldWriteYamlFiles.length}`
    : `, written=${result.writtenYamlFiles.length}`;
  return `${modeLabel}: ${parts.join(', ')}${livingPart}${filesPart}`;
}

export function renderPatchResult(
  base: Omit<PatchCommandResult, 'rendered'>,
  json: boolean
): PatchCommandResult {
  const rendered = json ? `${JSON.stringify(base, null, 2)}\n` : formatPatchTextReport(base);
  return {
    ...base,
    rendered,
  };
}
