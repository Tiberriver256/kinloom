import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { detectMediaLayout } from '../shared/integrateEngine/media.js';
import { INTEGRATE_YAML_FILES, INTEGRATION_RECEIPT_FILENAME } from '../shared/integrateEngine/types.js';
import type { BatchSnapshot, RollbackStats } from './types.js';

function writeFileAtomicBuffer(filePath: string, content: Buffer): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const suffix = randomBytes(6).toString('hex');
  const tmpPath = path.join(dir, `.${path.basename(filePath)}.tmp.${process.pid}.${suffix}`);
  fs.writeFileSync(tmpPath, content);
  fs.renameSync(tmpPath, filePath);
}

export function captureBatchSnapshot(repoDir: string, personIds: readonly string[]): BatchSnapshot {
  const dataDir = path.join(repoDir, 'data');
  const yamlFiles = new Map<string, Buffer | null>();
  for (const fileName of INTEGRATE_YAML_FILES) {
    const fullPath = path.join(dataDir, fileName);
    yamlFiles.set(fullPath, fs.existsSync(fullPath) ? fs.readFileSync(fullPath) : null);
  }

  const mediaLayout = detectMediaLayout(repoDir);
  const mediaFiles = new Map<string, Buffer | null>();
  const receiptFiles = new Map<string, Buffer | null>();
  for (const personId of personIds) {
    const receiptPath = path.join(repoDir, 'research', 'people', personId, INTEGRATION_RECEIPT_FILENAME);
    receiptFiles.set(receiptPath, fs.existsSync(receiptPath) ? fs.readFileSync(receiptPath) : null);

    const scansDir = path.join(repoDir, 'research', 'people', personId, 'scans');
    if (!fs.existsSync(scansDir)) {
      continue;
    }
    const entries = fs.readdirSync(scansDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) {
        continue;
      }
      if (
        entry.name.includes('/') ||
        entry.name.includes('\\') ||
        entry.name === '.' ||
        entry.name === '..'
      ) {
        continue;
      }
      const destPath = path.resolve(mediaLayout.scanDestDir, entry.name);
      if (mediaFiles.has(destPath)) {
        continue;
      }
      mediaFiles.set(destPath, fs.existsSync(destPath) ? fs.readFileSync(destPath) : null);
    }
  }

  return { yamlFiles, mediaFiles, receiptFiles };
}

export function restoreBatchSnapshot(snapshot: BatchSnapshot): RollbackStats {
  let restoredYamlFiles = 0;
  let removedMediaFiles = 0;
  let restoredMediaFiles = 0;
  let restoredReceiptFiles = 0;

  for (const [filePath, originalBytes] of snapshot.yamlFiles) {
    if (originalBytes === null) {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        restoredYamlFiles += 1;
      }
      continue;
    }
    if (!fs.existsSync(filePath) || !fs.readFileSync(filePath).equals(originalBytes)) {
      writeFileAtomicBuffer(filePath, originalBytes);
      restoredYamlFiles += 1;
    }
  }

  for (const [destPath, originalBytes] of snapshot.mediaFiles) {
    if (originalBytes === null) {
      if (fs.existsSync(destPath)) {
        fs.unlinkSync(destPath);
        removedMediaFiles += 1;
      }
      continue;
    }
    if (!fs.existsSync(destPath) || !fs.readFileSync(destPath).equals(originalBytes)) {
      writeFileAtomicBuffer(destPath, originalBytes);
      restoredMediaFiles += 1;
    }
  }

  for (const [receiptPath, originalBytes] of snapshot.receiptFiles) {
    if (originalBytes === null) {
      if (fs.existsSync(receiptPath)) {
        fs.unlinkSync(receiptPath);
        restoredReceiptFiles += 1;
      }
      continue;
    }
    if (!fs.existsSync(receiptPath) || !fs.readFileSync(receiptPath).equals(originalBytes)) {
      writeFileAtomicBuffer(receiptPath, originalBytes);
      restoredReceiptFiles += 1;
    }
  }

  return { restoredYamlFiles, removedMediaFiles, restoredMediaFiles, restoredReceiptFiles };
}

export function createDryRunDataDirCopy(repoDir: string): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kinloom-integrate-dryrun-'));
  const sourceDataDir = path.join(repoDir, 'data');
  if (fs.existsSync(sourceDataDir) && fs.statSync(sourceDataDir).isDirectory()) {
    const entries = fs.readdirSync(sourceDataDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith('.yaml')) {
        fs.copyFileSync(path.join(sourceDataDir, entry.name), path.join(tmpDir, entry.name));
      }
    }
  }
  return tmpDir;
}
