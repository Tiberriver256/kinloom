import fs from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { isConfirmedDeceasedRelative, scrubText } from './privacy.js';
import {
  type ContextAncestryFact,
  type ContextAncestrySource,
  type ContextAncestrySummary,
  type ContextRecordImage,
  type ContextRelativeRecordImage,
  type ContextRelativeRelation,
  type LivingPrivacyState,
  type LooseYamlRecord,
  REDACTED_RELATIVE_LABEL,
  type RelativeIdGroups,
} from './types.js';
import { asNonEmptyString, extractNumericXref, isPlainRecord } from './yamlScanner.js';

interface AncestryMatch {
  matchMode: 'gedcom_xref' | 'fullName';
  jsonPath: string;
  data: LooseYamlRecord;
}

async function buildAncestryNameIndex(
  ancestryDir: string,
  blockedPersonDbIds: ReadonlySet<string>
): Promise<Map<string, string>> {
  const index = new Map<string, string>();
  if (!fs.existsSync(ancestryDir)) {
    return index;
  }
  const entries = await readdir(ancestryDir);
  const jsonFiles = entries.filter((name) => {
    if (!name.endsWith('.json')) {
      return false;
    }
    return !blockedPersonDbIds.has(name.slice(0, -'.json'.length));
  });
  const namePattern = /"fullName"\s*:\s*"([^"]+)"/;
  const chunkSize = 32;

  for (let i = 0; i < jsonFiles.length; i += chunkSize) {
    const chunk = jsonFiles.slice(i, i + chunkSize);
    await Promise.all(
      chunk.map(async (fileName) => {
        const fullPath = path.join(ancestryDir, fileName);
        const fh = await fs.promises.open(fullPath, 'r');
        try {
          const buf = Buffer.allocUnsafe(512);
          const { bytesRead } = await fh.read(buf, 0, 512, 0);
          const head = buf.subarray(0, bytesRead).toString('utf8');
          const m = namePattern.exec(head);
          if (m) {
            const key = m[1].trim().toLowerCase();
            if (!index.has(key)) {
              index.set(key, fullPath);
            }
          }
        } finally {
          await fh.close();
        }
      })
    );
  }
  return index;
}

async function findAncestryMatch(
  ancestryDir: string | null,
  person: LooseYamlRecord,
  nameIndexHolder: { index: Map<string, string> | null },
  blockedPersonDbIds: ReadonlySet<string>
): Promise<AncestryMatch | null> {
  if (!ancestryDir || !fs.existsSync(ancestryDir)) {
    return null;
  }

  const numericId = extractNumericXref(person.gedcom_xref);
  if (numericId && !blockedPersonDbIds.has(numericId)) {
    const directPath = path.join(ancestryDir, `${numericId}.json`);
    if (fs.existsSync(directPath)) {
      const parsed: unknown = JSON.parse(await readFile(directPath, 'utf8'));
      if (isPlainRecord(parsed)) {
        return { matchMode: 'gedcom_xref', jsonPath: directPath, data: parsed };
      }
    }
  }

  const altNames = Array.isArray(person.alt_names) ? person.alt_names : [];
  const targetNames = new Set(
    [person.full_name, ...altNames]
      .filter((n): n is string => typeof n === 'string' && n.trim().length > 0)
      .map((n) => n.trim().toLowerCase())
  );
  if (targetNames.size === 0) {
    return null;
  }

  if (!nameIndexHolder.index) {
    nameIndexHolder.index = await buildAncestryNameIndex(ancestryDir, blockedPersonDbIds);
  }
  for (const name of targetNames) {
    const fullPath = nameIndexHolder.index.get(name);
    if (fullPath) {
      const parsed: unknown = JSON.parse(await readFile(fullPath, 'utf8'));
      if (isPlainRecord(parsed)) {
        return { matchMode: 'fullName', jsonPath: fullPath, data: parsed };
      }
    }
  }

  return null;
}

function collectRecordImagesForPerson(
  raw: LooseYamlRecord | null,
  personDbId: string | null,
  recordImagesDir: string | null,
  recordImageFiles: readonly string[],
  sourceTitleByImageId: ReadonlyMap<string, string>
): ContextRecordImage[] {
  const imagesByPath = new Map<string, ContextRecordImage>();
  const rawImages = Array.isArray(raw?.recordImages) ? raw.recordImages : [];
  for (const entry of rawImages) {
    if (!isPlainRecord(entry)) {
      continue;
    }
    const localPath = typeof entry.local === 'string' ? entry.local : null;
    if (!localPath || !fs.existsSync(localPath)) {
      continue;
    }
    const imageId =
      entry.RecordImageId !== undefined && entry.RecordImageId !== null ? String(entry.RecordImageId) : null;
    const bytes =
      typeof entry.bytes === 'number' && Number.isFinite(entry.bytes)
        ? entry.bytes
        : fs.statSync(localPath).size;
    imagesByPath.set(localPath, {
      path: localPath,
      recordImageId: imageId,
      bytes,
      sourceTitle: imageId ? (sourceTitleByImageId.get(imageId) ?? null) : null,
    });
  }

  if (personDbId && recordImagesDir && recordImageFiles.length > 0) {
    const prefix = `${personDbId}_`;
    for (const file of recordImageFiles) {
      if (!file.startsWith(prefix)) {
        continue;
      }
      const fullPath = path.join(recordImagesDir, file);
      if (imagesByPath.has(fullPath)) {
        continue;
      }
      const baseNoExt = file.slice(prefix.length).replace(/\.[^.]+$/, '');
      imagesByPath.set(fullPath, {
        path: fullPath,
        recordImageId: baseNoExt,
        bytes: fs.statSync(fullPath).size,
        sourceTitle: sourceTitleByImageId.get(baseNoExt) ?? null,
      });
    }
  }

  return [...imagesByPath.values()].toSorted((a, b) => a.path.localeCompare(b.path));
}

function buildAncestrySummary(
  match: AncestryMatch | null,
  recordImagesDir: string | null,
  recordImageFiles: readonly string[],
  livingAncestryPids: ReadonlySet<string>,
  livingNamePattern: RegExp | null
): ContextAncestrySummary | null {
  if (!match) {
    return null;
  }

  const raw = match.data;
  const card = isPlainRecord(raw.personCard) ? raw.personCard : {};
  if (raw.isLiving === true || card.IsLiving === true) {
    return {
      matchMode: match.matchMode,
      jsonPath: match.jsonPath,
      redacted: true,
      note: REDACTED_RELATIVE_LABEL,
    };
  }

  const personDbId = String(raw.personDbId ?? path.basename(match.jsonPath, '.json'));
  const facts: ContextAncestryFact[] = [];
  let redactedLivingFactsCount = 0;

  for (const factEntry of Array.isArray(raw.facts) ? raw.facts : []) {
    if (!isPlainRecord(factEntry)) {
      continue;
    }
    const target = isPlainRecord(factEntry.FactTargetPerson) ? factEntry.FactTargetPerson : null;
    const targetPid = target?.Id !== undefined && target?.Id !== null ? String(target.Id) : null;
    if (target?.IsLiving === true || (targetPid && livingAncestryPids.has(targetPid))) {
      redactedLivingFactsCount += 1;
      continue;
    }

    const type =
      (typeof factEntry.TypeString === 'string' && factEntry.TypeString) ||
      (typeof factEntry.Title === 'string' && factEntry.Title) ||
      'Fact';
    const compact: ContextAncestryFact = { type };
    if (typeof factEntry.Date === 'string' && factEntry.Date) {
      compact.date = factEntry.Date;
    }
    if (typeof factEntry.Place === 'string' && factEntry.Place) {
      compact.place = scrubText(factEntry.Place, livingNamePattern);
    }
    if (factEntry.Value !== undefined && factEntry.Value !== null && String(factEntry.Value)) {
      compact.value = scrubText(String(factEntry.Value), livingNamePattern);
    }
    if (
      factEntry.Description !== undefined &&
      factEntry.Description !== null &&
      String(factEntry.Description)
    ) {
      compact.description = scrubText(String(factEntry.Description), livingNamePattern);
    }
    if (typeof target?.FullName === 'string' && target.FullName) {
      compact.targetPerson = {
        name: scrubText(target.FullName, livingNamePattern),
        lifeRange: target.LifeRange ? String(target.LifeRange).replaceAll('&ndash;', '-') : null,
        pid: targetPid,
      };
    }
    if (typeof factEntry.SourceCitationCount === 'number' && factEntry.SourceCitationCount > 0) {
      compact.sourceCount = factEntry.SourceCitationCount;
    }
    facts.push(compact);
  }

  const sourceTitleByImageId = new Map<string, string>();
  const sources: ContextAncestrySource[] = [];
  for (const srcEntry of Array.isArray(raw.sources) ? raw.sources : []) {
    if (!isPlainRecord(srcEntry)) {
      continue;
    }
    const title = typeof srcEntry.Title === 'string' ? srcEntry.Title : '';
    if (srcEntry.RecordImageId && title && !sourceTitleByImageId.has(String(srcEntry.RecordImageId))) {
      sourceTitleByImageId.set(String(srcEntry.RecordImageId), scrubText(title, livingNamePattern));
    }
    const entry: ContextAncestrySource = {
      title: scrubText(title, livingNamePattern),
    };
    if (typeof srcEntry.Detail === 'string' && srcEntry.Detail) {
      entry.detail = scrubText(srcEntry.Detail, livingNamePattern);
    }
    if (srcEntry.CitationId !== undefined && srcEntry.CitationId !== null) {
      entry.citationId = String(srcEntry.CitationId);
    }
    if (srcEntry.DatabaseId !== undefined && srcEntry.DatabaseId !== null) {
      entry.databaseId = String(srcEntry.DatabaseId);
    }
    if (srcEntry.RecordId !== undefined && srcEntry.RecordId !== null) {
      entry.recordId = String(srcEntry.RecordId);
    }
    if (srcEntry.RecordImageId !== undefined && srcEntry.RecordImageId !== null) {
      entry.recordImageId = String(srcEntry.RecordImageId);
    }
    sources.push(entry);
  }

  const recordImages = collectRecordImagesForPerson(
    raw,
    personDbId,
    recordImagesDir,
    recordImageFiles,
    sourceTitleByImageId
  );

  const rawFullName =
    typeof raw.fullName === 'string'
      ? raw.fullName
      : typeof card.FullName === 'string'
        ? card.FullName
        : null;

  return {
    matchMode: match.matchMode,
    jsonPath: match.jsonPath,
    personDbId,
    fullName: rawFullName ? scrubText(rawFullName, livingNamePattern) : null,
    lifeRange: card.LifeRange ? String(card.LifeRange).replaceAll('&ndash;', '-') : null,
    birthDate: typeof card.BirthDate === 'string' ? card.BirthDate : null,
    birthPlace: typeof card.BirthPlace === 'string' ? scrubText(card.BirthPlace, livingNamePattern) : null,
    deathDate: typeof card.DeathDate === 'string' ? card.DeathDate : null,
    deathPlace: typeof card.DeathPlace === 'string' ? scrubText(card.DeathPlace, livingNamePattern) : null,
    factsUrl: typeof raw.factsUrl === 'string' ? raw.factsUrl : null,
    redactedLivingFactsCount,
    facts,
    sources,
    recordImages,
  };
}

async function collectDeceasedRelativeRecordImages(params: {
  parentIds: ReadonlySet<string>;
  spouseIds: ReadonlySet<string>;
  childIds: ReadonlySet<string>;
  siblingIds: ReadonlySet<string>;
  peopleById: ReadonlyMap<string, LooseYamlRecord>;
  privacyState: LivingPrivacyState;
  ancestryDir: string | null;
  recordImagesDir: string | null;
  recordImageFiles: readonly string[];
  subjectRecordImages: readonly ContextRecordImage[];
  nameIndexHolder: { index: Map<string, string> | null };
}): Promise<ContextRelativeRecordImage[]> {
  if (!params.ancestryDir) {
    return [];
  }

  const { livingIds, livingAncestryPids, livingNamePattern, privacy } = params.privacyState;
  const seenPaths = new Set<string>();
  const seenImageIds = new Set<string>();
  for (const img of params.subjectRecordImages) {
    if (img.path) {
      seenPaths.add(img.path);
    }
    if (img.recordImageId) {
      seenImageIds.add(img.recordImageId);
    }
  }

  const candidates: Array<{ id: string; relation: ContextRelativeRelation }> = [
    ...[...params.parentIds].toSorted().map((id) => ({ id, relation: 'parent' as const })),
    ...[...params.spouseIds].toSorted().map((id) => ({ id, relation: 'spouse' as const })),
    ...[...params.childIds].toSorted().map((id) => ({ id, relation: 'child' as const })),
    ...[...params.siblingIds].toSorted().map((id) => ({ id, relation: 'sibling' as const })),
  ];

  const relativeImages: ContextRelativeRecordImage[] = [];
  for (const { id, relation } of candidates) {
    const rel = params.peopleById.get(id);
    if (!isConfirmedDeceasedRelative(rel, livingIds, privacy)) {
      continue;
    }

    const match = await findAncestryMatch(
      params.ancestryDir,
      rel,
      params.nameIndexHolder,
      livingAncestryPids
    );
    const raw = match?.data ?? null;
    const card = isPlainRecord(raw?.personCard) ? raw.personCard : null;
    if (raw && (raw.isLiving === true || card?.IsLiving === true)) {
      continue;
    }

    const personDbId =
      raw && match
        ? String(raw.personDbId ?? path.basename(match.jsonPath, '.json'))
        : extractNumericXref(rel.gedcom_xref);
    if (!personDbId) {
      continue;
    }

    const sourceTitleByImageId = new Map<string, string>();
    const rawSources = Array.isArray(raw?.sources) ? raw.sources : [];
    for (const src of rawSources) {
      if (!isPlainRecord(src)) {
        continue;
      }
      if (
        src.RecordImageId &&
        typeof src.Title === 'string' &&
        !sourceTitleByImageId.has(String(src.RecordImageId))
      ) {
        sourceTitleByImageId.set(String(src.RecordImageId), scrubText(src.Title, livingNamePattern));
      }
    }

    const relImages = collectRecordImagesForPerson(
      raw,
      personDbId,
      params.recordImagesDir,
      params.recordImageFiles,
      sourceTitleByImageId
    );

    for (const img of relImages) {
      if (seenPaths.has(img.path) || (img.recordImageId && seenImageIds.has(img.recordImageId))) {
        continue;
      }
      seenPaths.add(img.path);
      if (img.recordImageId) {
        seenImageIds.add(img.recordImageId);
      }
      relativeImages.push({
        ...img,
        relativeId: String(rel.id),
        relativeName: scrubText(asNonEmptyString(rel.full_name), livingNamePattern),
        relation,
        personDbId,
      });
    }
  }

  return relativeImages;
}

export async function resolveAncestryContext(params: {
  ancestryDir: string | null;
  targetPerson: LooseYamlRecord;
  relativeIds: RelativeIdGroups;
  includeFamily: boolean;
  peopleById: ReadonlyMap<string, LooseYamlRecord>;
  privacyState: LivingPrivacyState;
}): Promise<{
  ancestry: ContextAncestrySummary | null;
  relativeRecordImages: ContextRelativeRecordImage[];
}> {
  const nameIndexHolder: { index: Map<string, string> | null } = { index: null };
  const recordImagesDir = params.ancestryDir ? path.join(params.ancestryDir, 'record_images') : null;
  const recordImageFiles =
    recordImagesDir && fs.existsSync(recordImagesDir) ? await readdir(recordImagesDir) : [];

  const ancestryMatch = await findAncestryMatch(
    params.ancestryDir,
    params.targetPerson,
    nameIndexHolder,
    params.privacyState.livingAncestryPids
  );
  const ancestry = buildAncestrySummary(
    ancestryMatch,
    recordImagesDir,
    recordImageFiles,
    params.privacyState.livingAncestryPids,
    params.privacyState.livingNamePattern
  );
  const subjectRecordImages = ancestry && !ancestry.redacted ? ancestry.recordImages : [];
  const relativeRecordImages = await collectDeceasedRelativeRecordImages({
    parentIds: params.relativeIds.parentIds,
    spouseIds: params.relativeIds.spouseIds,
    childIds: params.includeFamily ? params.relativeIds.childIds : new Set<string>(),
    siblingIds: params.includeFamily ? params.relativeIds.siblingIds : new Set<string>(),
    peopleById: params.peopleById,
    privacyState: params.privacyState,
    ancestryDir: params.ancestryDir,
    recordImagesDir,
    recordImageFiles,
    subjectRecordImages,
    nameIndexHolder,
  });

  return { ancestry, relativeRecordImages };
}
