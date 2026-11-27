import fs from 'node:fs';
import path from 'node:path';
import { edtfToBounds } from '@kinloom/core';

export const SAFE_PERSON_ID_RE = /^[a-zA-Z0-9_-]+$/;

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

export function parseValidDeathEdtf(raw: unknown): string | null {
  if (raw === undefined || raw === null) {
    return null;
  }
  const trimmed = String(raw).trim();
  const slashIdx = trimmed.indexOf('/');
  if (!trimmed || (slashIdx !== -1 && trimmed.indexOf('/', slashIdx + 1) !== -1)) {
    return null;
  }
  return edtfToBounds(trimmed) !== null ? trimmed : null;
}
