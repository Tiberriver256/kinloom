import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { KinshipEdge } from '@kinloom/core';
import { CliValidationError } from '../../../errors.js';
import { inspectImageBuffer } from '../audit.js';
import { expandRemoveKinshipTargets, type RemoveKinshipEntry } from '../integrate.js';
import { readStagedMediaRefs } from '../live-media-collisions.js';
import {
  isPlainRecord,
  nullableText,
  type ParsedPackage,
  SAFE_PERSON_ID_RE,
  type ScanCollisionPackage,
  type StagedEventRow,
  type StagedKinshipAdd,
  type StagedPersonRow,
  type StagedScanFileEntry,
  type StagedSourceRef,
} from './types.js';

export function listStagedAuditPersonIds(repoDir: string): string[] {
  const root = path.join(repoDir, 'research', 'people');
  if (!fs.existsSync(root)) {
    return [];
  }
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && SAFE_PERSON_ID_RE.test(entry.name))
    .map((entry) => entry.name)
    .filter((personId) => fs.existsSync(path.join(root, personId, 'patch.json')))
    .sort((a, b) => a.localeCompare(b));
}

function readPatchObject(patchPath: string): Record<string, unknown> {
  if (!fs.existsSync(patchPath)) {
    throw new CliValidationError(`Missing person patch file: ${patchPath}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(patchPath, 'utf8'));
  } catch (err: unknown) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new CliValidationError(`patch.json at ${patchPath} is not valid JSON (${detail}).`);
  }
  if (!isPlainRecord(parsed)) {
    throw new CliValidationError(`patch.json at ${patchPath} must contain a JSON object.`);
  }
  return parsed;
}

function isKinshipRelation(value: unknown): value is KinshipEdge['relation'] {
  return value === 'parent' || value === 'child' || value === 'spouse';
}

export function loadStagedPackage(personId: string, packageDir: string): ParsedPackage {
  const patch = readPatchObject(path.join(packageDir, 'patch.json'));
  const media = readStagedMediaRefs(patch.media);

  const sources: StagedSourceRef[] = [];
  for (const rawItem of Array.isArray(patch.sources) ? patch.sources : []) {
    if (!isPlainRecord(rawItem) || typeof rawItem.id !== 'string') {
      continue;
    }
    const id = rawItem.id.trim();
    if (id) {
      sources.push({ id });
    }
  }

  const eventRows: StagedEventRow[] = [];
  for (const rawItem of Array.isArray(patch.events) ? patch.events : []) {
    if (!isPlainRecord(rawItem) || typeof rawItem.id !== 'string') {
      continue;
    }
    const id = rawItem.id.trim();
    if (!id) {
      continue;
    }
    eventRows.push({
      id,
      person_id: personId,
      edtf_date: nullableText(rawItem.edtf_date),
      place_id: nullableText(rawItem.place_id),
      place_precision: nullableText(rawItem.place_precision),
      title: nullableText(rawItem.title),
    });
  }

  const stagedPeople: StagedPersonRow[] = [];
  for (const rawItem of Array.isArray(patch.people) ? patch.people : []) {
    if (!isPlainRecord(rawItem) || typeof rawItem.id !== 'string') {
      continue;
    }
    const id = rawItem.id.trim();
    if (!id) {
      continue;
    }
    stagedPeople.push({
      id,
      person_id: personId,
      slug: nullableText(rawItem.slug),
      full_name: nullableText(rawItem.full_name),
      given_name: nullableText(rawItem.given_name),
      surname: nullableText(rawItem.surname),
      sex: nullableText(rawItem.sex),
      birth_edtf: nullableText(rawItem.birth_edtf),
      death_edtf: nullableText(rawItem.death_edtf),
      lineage_group: nullableText(rawItem.lineage_group),
      branch: nullableText(rawItem.branch),
    });
  }

  const kinshipAdds: StagedKinshipAdd[] = [];
  for (const rawItem of Array.isArray(patch.kinship) ? patch.kinship : []) {
    if (!isPlainRecord(rawItem)) {
      continue;
    }
    const from = nullableText(rawItem.from);
    const to = nullableText(rawItem.to);
    if (!from || !to || !isKinshipRelation(rawItem.relation)) {
      continue;
    }
    kinshipAdds.push({
      from,
      to,
      relation: rawItem.relation,
      family_xref: nullableText(rawItem.family_xref),
    });
  }

  const removeKinshipEntries: RemoveKinshipEntry[] = [];
  for (const rawItem of Array.isArray(patch.remove_kinship) ? patch.remove_kinship : []) {
    if (!isPlainRecord(rawItem)) {
      continue;
    }
    const from = nullableText(rawItem.from);
    const to = nullableText(rawItem.to);
    if (!from || !to || !isKinshipRelation(rawItem.relation)) {
      continue;
    }
    const familyXref = nullableText(rawItem.family_xref);
    removeKinshipEntries.push({
      from,
      to,
      relation: rawItem.relation,
      ...(familyXref !== null ? { family_xref: familyXref } : {}),
      symmetric: typeof rawItem.symmetric === 'boolean' ? rawItem.symmetric : true,
    });
  }
  const kinshipRemoves = expandRemoveKinshipTargets(removeKinshipEntries);

  return {
    personId,
    packageDir,
    media,
    sources,
    eventRows,
    stagedPeople,
    kinshipAdds,
    kinshipRemoves,
  };
}

function hashAndMeasure(diskPath: string): Omit<ScanCollisionPackage, 'person_id'> {
  const stat = fs.statSync(diskPath);
  const hash = crypto.createHash('sha256');
  const headerLen = Math.min(stat.size, 65_536);
  const header = Buffer.allocUnsafe(headerLen);
  const fd = fs.openSync(diskPath, 'r');
  try {
    let offset = 0;
    const buf = Buffer.allocUnsafe(1024 * 1024);
    while (offset < stat.size) {
      const read = fs.readSync(fd, buf, 0, Math.min(buf.length, stat.size - offset), offset);
      if (read <= 0) {
        break;
      }
      hash.update(buf.subarray(0, read));
      if (offset < headerLen) {
        buf.copy(header, offset, 0, Math.min(read, headerLen - offset));
      }
      offset += read;
    }
  } finally {
    fs.closeSync(fd);
  }
  const info =
    headerLen === 0 ? { width: null, height: null } : inspectImageBuffer(header.subarray(0, headerLen));
  return {
    bytes: stat.size,
    width: info.width,
    height: info.height,
    sha256: hash.digest('hex'),
  };
}

export function loadStagedScanEntries(packages: readonly ParsedPackage[]): StagedScanFileEntry[] {
  const entries: StagedScanFileEntry[] = [];
  for (const staged of packages) {
    const scansDir = path.join(staged.packageDir, 'scans');
    if (!fs.existsSync(scansDir)) {
      continue;
    }
    const names = fs
      .readdirSync(scansDir, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b));
    for (const name of names) {
      const measured = hashAndMeasure(path.join(scansDir, name));
      entries.push({
        basename: name,
        person_id: staged.personId,
        bytes: measured.bytes,
        width: measured.width,
        height: measured.height,
        sha256: measured.sha256,
      });
    }
  }
  return entries;
}
