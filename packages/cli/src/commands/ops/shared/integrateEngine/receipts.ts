import fs from 'node:fs';
import path from 'node:path';
import { isPlainObject, sha256File, writeFileAtomic } from './primitives.js';
import { INTEGRATION_RECEIPT_FILENAME, type IntegrationReceipt, type PackageFingerprints } from './types.js';

export function computePackageFingerprints(packageDir: string): PackageFingerprints {
  const patchPath = path.join(packageDir, 'patch.json');
  const patch_sha256 = sha256File(patchPath).sha256;
  const scans_sha256: Record<string, string> = {};
  const scansDir = path.join(packageDir, 'scans');
  if (fs.existsSync(scansDir) && fs.statSync(scansDir).isDirectory()) {
    const entries = fs
      .readdirSync(scansDir, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .filter((name) => !name.includes('/') && !name.includes('\\') && name !== '.' && name !== '..')
      .toSorted((a, b) => a.localeCompare(b));
    for (const name of entries) {
      scans_sha256[name] = sha256File(path.join(scansDir, name)).sha256;
    }
  }
  return { patch_sha256, scans_sha256 };
}

export function readIntegrationReceipt(packageDir: string): IntegrationReceipt | null {
  const receiptPath = path.join(packageDir, INTEGRATION_RECEIPT_FILENAME);
  if (!fs.existsSync(receiptPath)) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
    if (!isPlainObject(parsed)) {
      return null;
    }
    if (
      parsed['schema_version'] !== 1 ||
      typeof parsed['person_id'] !== 'string' ||
      typeof parsed['patch_sha256'] !== 'string' ||
      !isPlainObject(parsed['scans_sha256']) ||
      typeof parsed['integrated_at'] !== 'string' ||
      !isPlainObject(parsed['integrated_entity_ids'])
    ) {
      return null;
    }
    const scans: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed['scans_sha256'])) {
      if (typeof v !== 'string') {
        return null;
      }
      scans[k] = v;
    }
    const readIds = (field: unknown): string[] =>
      Array.isArray(field) ? field.filter((item): item is string => typeof item === 'string') : [];
    const ids = parsed['integrated_entity_ids'];
    return {
      schema_version: 1,
      person_id: parsed['person_id'],
      patch_sha256: parsed['patch_sha256'],
      scans_sha256: scans,
      integrated_at: parsed['integrated_at'],
      integrated_entity_ids: {
        people: readIds(ids['people']),
        events: readIds(ids['events']),
        places: readIds(ids['places']),
        sources: readIds(ids['sources']),
        media: readIds(ids['media']),
        narratives: readIds(ids['narratives']),
      },
    };
  } catch {
    return null;
  }
}

export function doesReceiptMatchPackage(
  receipt: IntegrationReceipt,
  fingerprints: PackageFingerprints
): boolean {
  if (receipt.patch_sha256 !== fingerprints.patch_sha256) {
    return false;
  }
  const receiptKeys = Object.keys(receipt.scans_sha256).toSorted((a, b) => a.localeCompare(b));
  const currentKeys = Object.keys(fingerprints.scans_sha256).toSorted((a, b) => a.localeCompare(b));
  if (receiptKeys.length !== currentKeys.length) {
    return false;
  }
  for (let i = 0; i < receiptKeys.length; i += 1) {
    const key = receiptKeys[i];
    if (
      key === undefined ||
      key !== currentKeys[i] ||
      receipt.scans_sha256[key] !== fingerprints.scans_sha256[key]
    ) {
      return false;
    }
  }
  return true;
}

export function writeIntegrationReceipt(packageDir: string, receipt: IntegrationReceipt): string {
  const receiptPath = path.join(packageDir, INTEGRATION_RECEIPT_FILENAME);
  writeFileAtomic(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  return receiptPath;
}

function collectIdsFromRawList(list: readonly unknown[]): string[] {
  const out = new Set<string>();
  for (const item of list) {
    if (isPlainObject(item) && typeof item['id'] === 'string' && item['id'].trim().length > 0) {
      out.add(item['id'].trim());
    }
  }
  return [...out].toSorted((a, b) => a.localeCompare(b));
}

export function buildIntegrationReceiptForPackage(
  packageDir: string,
  personId: string,
  integratedAt = new Date().toISOString()
): IntegrationReceipt {
  const fingerprints = computePackageFingerprints(packageDir);
  const patchPath = path.join(packageDir, 'patch.json');
  const raw: unknown = JSON.parse(fs.readFileSync(patchPath, 'utf8'));
  const obj = isPlainObject(raw) ? raw : {};
  const peopleIds = new Set<string>(collectIdsFromRawList(Array.isArray(obj['people']) ? obj['people'] : []));
  peopleIds.add(personId);
  return {
    schema_version: 1,
    person_id: personId,
    patch_sha256: fingerprints.patch_sha256,
    scans_sha256: fingerprints.scans_sha256,
    integrated_at: integratedAt,
    integrated_entity_ids: {
      people: [...peopleIds].toSorted((a, b) => a.localeCompare(b)),
      events: collectIdsFromRawList(Array.isArray(obj['events']) ? obj['events'] : []),
      places: collectIdsFromRawList(Array.isArray(obj['places']) ? obj['places'] : []),
      sources: collectIdsFromRawList(Array.isArray(obj['sources']) ? obj['sources'] : []),
      media: collectIdsFromRawList(Array.isArray(obj['media']) ? obj['media'] : []),
      narratives: collectIdsFromRawList(Array.isArray(obj['narratives']) ? obj['narratives'] : []),
    },
  };
}
