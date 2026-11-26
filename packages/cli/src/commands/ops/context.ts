import fs from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import {
  collectLivingNames,
  compileLivingNamePattern,
  edtfYear,
  parseKinloomConfigYaml,
  parseYaml,
  resolveEffectiveLiving,
  type PrivacyConfig,
} from '@kinloom/core';
import { CliValidationError } from '../../errors.js';

export const REDACTED_RELATIVE_LABEL = '[Living relative redacted]';
const SAFE_PERSON_ID_RE = /^[a-zA-Z0-9_-]+$/;

export { CONTEXT_HELP } from './help.js';

export interface ContextCommandOptions {
  repoDir?: string;
  personId: string;
  ancestryDir?: string;
  includeFamily?: boolean;
  json?: boolean;
}

export interface ContextRelativeEntry {
  id: string;
  full_name: string;
  lifespan: string;
  gedcom_xref: string | null;
}

export type ContextRelativeListItem = ContextRelativeEntry | typeof REDACTED_RELATIVE_LABEL;

export interface ContextRecordImage {
  path: string;
  recordImageId: string | null;
  bytes: number;
  sourceTitle: string | null;
}

export type ContextRelativeRelation = 'parent' | 'spouse' | 'child' | 'sibling';

export interface ContextRelativeRecordImage extends ContextRecordImage {
  relativeId: string;
  relativeName: string;
  relation: ContextRelativeRelation;
  personDbId: string;
}

export interface ContextAncestryFact {
  type: string;
  date?: string;
  place?: string;
  value?: string;
  description?: string;
  targetPerson?: {
    name: string;
    lifeRange: string | null;
    pid: string | null;
  };
  sourceCount?: number;
}

export interface ContextAncestrySource {
  title: string;
  detail?: string;
  citationId?: string;
  databaseId?: string;
  recordId?: string;
  recordImageId?: string;
}

export type ContextAncestrySummary =
  | {
      matchMode: 'gedcom_xref' | 'fullName';
      jsonPath: string;
      redacted: true;
      note: typeof REDACTED_RELATIVE_LABEL;
    }
  | {
      matchMode: 'gedcom_xref' | 'fullName';
      jsonPath: string;
      redacted?: false;
      personDbId: string;
      fullName: string | null;
      lifeRange: string | null;
      birthDate: string | null;
      birthPlace: string | null;
      deathDate: string | null;
      deathPlace: string | null;
      factsUrl: string | null;
      redactedLivingFactsCount: number;
      facts: ContextAncestryFact[];
      sources: ContextAncestrySource[];
      recordImages: ContextRecordImage[];
    };

export interface PersonContextPayload {
  repoDir: string;
  person: Record<string, unknown>;
  relatives: {
    parents: ContextRelativeListItem[];
    spouses: ContextRelativeListItem[];
    children: ContextRelativeListItem[];
  };
  events: Record<string, unknown>[];
  places: Record<string, unknown>[];
  sources: Record<string, unknown>[];
  media: Record<string, unknown>[];
  narratives: Record<string, unknown>[];
  ancestry: ContextAncestrySummary | null;
  relativeRecordImages: ContextRelativeRecordImage[];
}

export interface ContextCommandResult {
  context: PersonContextPayload;
  rendered: string;
  bytesOut: number;
}

interface LooseYamlRecord {
  [key: string]: unknown;
}

interface AncestryMatch {
  matchMode: 'gedcom_xref' | 'fullName';
  jsonPath: string;
  data: LooseYamlRecord;
}

function isPlainRecord(value: unknown): value is LooseYamlRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function readOptionalUtf8(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, 'utf8');
  } catch (err: unknown) {
    if (typeof err === 'object' && err !== null && 'code' in err && err.code === 'ENOENT') {
      return null;
    }
    throw err;
  }
}

export function splitTopLevelYamlList(text: string | null): string[] {
  if (!text) {
    return [];
  }
  const normalized = text.replaceAll('\r\n', '\n');
  const startIdx = normalized.startsWith('- ') ? 0 : normalized.indexOf('\n- ');
  if (startIdx === -1) {
    return [];
  }
  const body = startIdx === 0 ? normalized : normalized.slice(startIdx + 1);
  return body.split(/\n(?=- )/);
}

export function extractYamlBlockId(block: string): string | null {
  const match = /^- id:\s*["']?([^"'\n\r]+?)["']?\s*(?:\n|$)/.exec(block);
  return match ? match[1].trim() : null;
}

export function parseMatchingYamlBlocks(blocks: readonly string[]): LooseYamlRecord[] {
  if (blocks.length === 0) {
    return [];
  }
  const parsed = parseYaml(blocks.join('\n'));
  if (!Array.isArray(parsed)) {
    return [];
  }
  return parsed.filter(isPlainRecord);
}

function scrubText(value: string, livingNamePattern: RegExp | null): string {
  if (!value || !livingNamePattern) {
    return value;
  }
  return value.replaceAll(livingNamePattern, REDACTED_RELATIVE_LABEL);
}

function scrubDeep<T>(value: T, livingNamePattern: RegExp | null): T {
  if (!livingNamePattern) {
    return value;
  }
  if (typeof value === 'string') {
    return value.replaceAll(livingNamePattern, REDACTED_RELATIVE_LABEL) as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => scrubDeep(item, livingNamePattern)) as T;
  }
  if (isPlainRecord(value)) {
    const out: LooseYamlRecord = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = scrubDeep(v, livingNamePattern);
    }
    return out as T;
  }
  return value;
}

function extractNumericXref(xref: unknown): string | null {
  if (typeof xref !== 'string') {
    return null;
  }
  const match = /(\d{6,})/.exec(xref);
  return match ? match[1] : null;
}

function asNonEmptyString(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  return String(value).trim();
}

function isEffectiveLivingRecord(
  person: LooseYamlRecord,
  personEvents: readonly { edtf_date?: unknown }[],
  privacy: Partial<PrivacyConfig>
): boolean {
  if (person.is_living === true || person.living === true) {
    return true;
  }
  const birthEdtf = asNonEmptyString(person.birth_edtf);
  const deathEdtf = asNonEmptyString(person.death_edtf);
  if (
    resolveEffectiveLiving(
      {
        is_living: Boolean(person.is_living),
        birth_edtf: birthEdtf,
        death_edtf: deathEdtf,
      },
      privacy
    )
  ) {
    return true;
  }
  if (deathEdtf.length > 0) {
    return false;
  }
  const years = personEvents
    .map((ev) => edtfYear(typeof ev.edtf_date === 'string' || typeof ev.edtf_date === 'number' ? ev.edtf_date : null))
    .filter((yr): yr is number => yr !== null);
  if (years.length > 0) {
    const earliest = Math.min(...years);
    const refYear = privacy.referenceYear ?? 2026;
    const cutoffYears = privacy.livingCutoffYears ?? 101;
    if (earliest > refYear - cutoffYears) {
      return true;
    }
  }
  return false;
}

function formatLifespan(person: LooseYamlRecord): string {
  const b = asNonEmptyString(person.birth_edtf) || '?';
  const d = asNonEmptyString(person.death_edtf) || '?';
  return `${b} - ${d}`;
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
      entry.RecordImageId !== undefined && entry.RecordImageId !== null
        ? String(entry.RecordImageId)
        : null;
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

function isConfirmedDeceasedRelative(
  person: LooseYamlRecord | undefined,
  livingIds: ReadonlySet<string>,
  privacy: Partial<PrivacyConfig>
): person is LooseYamlRecord {
  if (!person || typeof person.id !== 'string' || livingIds.has(person.id)) {
    return false;
  }
  if (person.is_living === true || person.living === true) {
    return false;
  }
  const birthEdtf = asNonEmptyString(person.birth_edtf);
  const deathEdtf = asNonEmptyString(person.death_edtf);
  if (
    resolveEffectiveLiving(
      {
        is_living: false,
        birth_edtf: birthEdtf,
        death_edtf: deathEdtf,
      },
      privacy
    )
  ) {
    return false;
  }
  if (deathEdtf.length > 0) {
    return true;
  }
  const birthYear = edtfYear(birthEdtf);
  const refYear = privacy.referenceYear ?? 2026;
  const cutoffYears = privacy.livingCutoffYears ?? 101;
  return birthYear !== null && birthYear <= refYear - cutoffYears;
}

function collectSiblingIds(
  parentIds: ReadonlySet<string>,
  excludedIds: ReadonlySet<string>,
  kinshipBlocks: readonly string[]
): Set<string> {
  const siblingIds = new Set<string>();
  if (parentIds.size === 0) {
    return siblingIds;
  }
  const blocks = kinshipBlocks.filter((block) => {
    for (const parentId of parentIds) {
      if (block.includes(parentId)) {
        return true;
      }
    }
    return false;
  });
  for (const edge of parseMatchingYamlBlocks(blocks)) {
    const from = typeof edge.from === 'string' ? edge.from : '';
    const to = typeof edge.to === 'string' ? edge.to : '';
    let siblingId = '';
    if (edge.relation === 'parent' && parentIds.has(from)) {
      siblingId = to;
    } else if (edge.relation === 'child' && parentIds.has(to)) {
      siblingId = from;
    }
    if (siblingId && !excludedIds.has(siblingId)) {
      siblingIds.add(siblingId);
    }
  }
  return siblingIds;
}

async function collectDeceasedRelativeRecordImages(params: {
  parentIds: ReadonlySet<string>;
  spouseIds: ReadonlySet<string>;
  childIds: ReadonlySet<string>;
  siblingIds: ReadonlySet<string>;
  peopleById: ReadonlyMap<string, LooseYamlRecord>;
  livingIds: ReadonlySet<string>;
  blockedPersonDbIds: ReadonlySet<string>;
  privacy: Partial<PrivacyConfig>;
  ancestryDir: string | null;
  recordImagesDir: string | null;
  recordImageFiles: readonly string[];
  subjectRecordImages: readonly ContextRecordImage[];
  livingNamePattern: RegExp | null;
  nameIndexHolder: { index: Map<string, string> | null };
}): Promise<ContextRelativeRecordImage[]> {
  if (!params.ancestryDir) {
    return [];
  }

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
    if (!isConfirmedDeceasedRelative(rel, params.livingIds, params.privacy)) {
      continue;
    }

    const match = await findAncestryMatch(
      params.ancestryDir,
      rel,
      params.nameIndexHolder,
      params.blockedPersonDbIds
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
      if (src.RecordImageId && typeof src.Title === 'string' && !sourceTitleByImageId.has(String(src.RecordImageId))) {
        sourceTitleByImageId.set(
          String(src.RecordImageId),
          scrubText(src.Title, params.livingNamePattern)
        );
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
        relativeName: scrubText(asNonEmptyString(rel.full_name), params.livingNamePattern),
        relation,
        personDbId,
      });
    }
  }

  return relativeImages;
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
    const targetPid =
      target?.Id !== undefined && target?.Id !== null ? String(target.Id) : null;
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
        lifeRange: target.LifeRange
          ? String(target.LifeRange).replaceAll('&ndash;', '-')
          : null,
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
    birthPlace:
      typeof card.BirthPlace === 'string'
        ? scrubText(card.BirthPlace, livingNamePattern)
        : null,
    deathDate: typeof card.DeathDate === 'string' ? card.DeathDate : null,
    deathPlace:
      typeof card.DeathPlace === 'string'
        ? scrubText(card.DeathPlace, livingNamePattern)
        : null,
    factsUrl: typeof raw.factsUrl === 'string' ? raw.factsUrl : null,
    redactedLivingFactsCount,
    facts,
    sources,
    recordImages,
  };
}

export function formatPersonContextMarkdown(ctx: PersonContextPayload): string {
  const lines: string[] = [];
  const p = ctx.person;

  lines.push(`# Person Context: ${asNonEmptyString(p.full_name)} (\`${asNonEmptyString(p.id)}\`)`);
  lines.push('');
  lines.push(`- Repo: \`${ctx.repoDir}\``);
  lines.push(
    `- Slug: \`${asNonEmptyString(p.slug)}\` | GEDCOM xref: \`${asNonEmptyString(p.gedcom_xref) || 'none'}\` | Lifespan: \`${formatLifespan(p)}\``
  );
  lines.push('');

  lines.push('## 1. People Record (`data/people.yaml`)');
  lines.push('```json');
  lines.push(JSON.stringify(p, null, 2));
  lines.push('```');
  lines.push('');

  lines.push('## 2. Immediate Relatives (`data/kinship.yaml`)');
  const groups: ReadonlyArray<readonly ['parents' | 'spouses' | 'children', string]> = [
    ['parents', 'Parents'],
    ['spouses', 'Spouses'],
    ['children', 'Children'],
  ];
  for (const [key, label] of groups) {
    const items = ctx.relatives[key];
    lines.push(`### ${label} (${items.length})`);
    if (items.length === 0) {
      lines.push('- None');
    } else {
      for (const rel of items) {
        if (rel === REDACTED_RELATIVE_LABEL) {
          lines.push(`- ${REDACTED_RELATIVE_LABEL}`);
        } else {
          lines.push(
            `- \`${rel.id}\` ${rel.full_name} (${rel.lifespan})${rel.gedcom_xref ? ` [xref: \`${rel.gedcom_xref}\`]` : ''}`
          );
        }
      }
    }
  }
  lines.push('');

  lines.push(`## 3. Existing Events (${ctx.events.length})`);
  if (ctx.events.length === 0) {
    lines.push('- None');
  } else {
    lines.push('```json');
    lines.push(JSON.stringify(ctx.events, null, 2));
    lines.push('```');
  }
  lines.push('');

  lines.push(`## 4. Referenced Places (${ctx.places.length})`);
  if (ctx.places.length === 0) {
    lines.push('- None');
  } else {
    lines.push('```json');
    lines.push(JSON.stringify(ctx.places, null, 2));
    lines.push('```');
  }
  lines.push('');

  lines.push(`## 5. Referenced Sources (${ctx.sources.length})`);
  if (ctx.sources.length === 0) {
    lines.push('- None');
  } else {
    lines.push('```json');
    lines.push(JSON.stringify(ctx.sources, null, 2));
    lines.push('```');
  }
  lines.push('');

  lines.push(`## 6. Linked Media (${ctx.media.length})`);
  if (ctx.media.length === 0) {
    lines.push('- None');
  } else {
    lines.push('```json');
    lines.push(JSON.stringify(ctx.media, null, 2));
    lines.push('```');
  }
  lines.push('');

  lines.push(`## 7. Existing Narratives (${ctx.narratives.length})`);
  if (ctx.narratives.length === 0) {
    lines.push('- None');
  } else {
    for (const nar of ctx.narratives) {
      const narId = asNonEmptyString(nar.id);
      const narKind = asNonEmptyString(nar.kind) || 'narrative';
      const narTitle = asNonEmptyString(nar.title);
      const narSources = Array.isArray(nar.source_ids) ? nar.source_ids.length : 0;
      const bodyMd = typeof nar.body_md === 'string' ? nar.body_md : '';
      lines.push(`### \`${narId}\` (${narKind}): ${narTitle}`);
      lines.push(
        `- slug: \`${asNonEmptyString(nar.slug)}\` | subject_person_id: \`${asNonEmptyString(nar.subject_person_id)}\` | sources: ${narSources} | body_chars: ${bodyMd.length}`
      );
      if (typeof nar.summary === 'string' && nar.summary) {
        lines.push(`- summary: ${nar.summary}`);
      }
      if (bodyMd) {
        lines.push('');
        lines.push(bodyMd);
      }
      lines.push('');
    }
  }

  lines.push('## 8. External Facts Export Match');
  if (!ctx.ancestry) {
    lines.push('- No matching external facts JSON found.');
  } else if (ctx.ancestry.redacted) {
    lines.push(`- Match: \`${ctx.ancestry.jsonPath}\` (${ctx.ancestry.note})`);
  } else {
    const a = ctx.ancestry;
    lines.push(
      `- Matched via \`${a.matchMode}\`: \`${a.jsonPath}\` (personDbId=\`${a.personDbId}\`, lifeRange=\`${a.lifeRange ?? ''}\`)`
    );
    if (a.redactedLivingFactsCount > 0) {
      lines.push(`- Redacted living-relative facts omitted: ${a.redactedLivingFactsCount}`);
    }
    lines.push(`- Record images on disk (${a.recordImages.length}):`);
    if (a.recordImages.length === 0) {
      lines.push('  - None');
    } else {
      for (const img of a.recordImages) {
        lines.push(
          `  - \`${img.path}\` (${img.bytes} bytes)${img.sourceTitle ? ` - ${img.sourceTitle}` : ''}`
        );
      }
    }
    lines.push(`- Non-living facts (${a.facts.length}):`);
    lines.push('```json');
    lines.push(JSON.stringify(a.facts, null, 2));
    lines.push('```');
    lines.push(`- External sources (${a.sources.length}):`);
    lines.push('```json');
    lines.push(JSON.stringify(a.sources, null, 2));
    lines.push('```');
  }

  const relImgs = ctx.relativeRecordImages;
  lines.push(
    `- Confirmed-deceased relative record images on disk, deduplicated (${relImgs.length}):`
  );
  if (relImgs.length === 0) {
    lines.push('  - None');
  } else {
    for (const img of relImgs) {
      lines.push(
        `  - \`${img.path}\` (${img.bytes} bytes) [${img.relation}: \`${img.relativeId}\` ${img.relativeName}]${
          img.sourceTitle ? ` - ${img.sourceTitle}` : ''
        }`
      );
    }
  }

  return `${lines.join('\n')}\n`;
}

export async function runContextCommand(
  options: ContextCommandOptions
): Promise<ContextCommandResult> {
  const repoDir = path.resolve(options.repoDir?.trim() || process.cwd());
  const personId = options.personId.trim();
  if (!personId) {
    throw new CliValidationError('Missing required option `--person <person_id>`.');
  }
  if (!SAFE_PERSON_ID_RE.test(personId)) {
    throw new CliValidationError(
      `Invalid person_id '${personId}'. Only ASCII letters, digits, _, and - are allowed.`
    );
  }

  const dataDir = path.join(repoDir, 'data');
  const peopleYamlPath = path.join(dataDir, 'people.yaml');
  if (!fs.existsSync(peopleYamlPath)) {
    throw new CliValidationError(`Archive data/people.yaml not found under ${repoDir}.`);
  }

  const rawAncestryDir =
    options.ancestryDir?.trim() || process.env.KINLOOM_ANCESTRY_FACTS_DIR?.trim() || '';
  const ancestryDir = rawAncestryDir ? path.resolve(rawAncestryDir) : null;

  const [
    configText,
    peopleText,
    kinshipText,
    eventsText,
    placesText,
    sourcesText,
    mediaText,
    narrativesText,
  ] = await Promise.all([
    readOptionalUtf8(path.join(repoDir, 'kinloom.config.yaml')),
    readOptionalUtf8(peopleYamlPath),
    readOptionalUtf8(path.join(dataDir, 'kinship.yaml')),
    readOptionalUtf8(path.join(dataDir, 'events.yaml')),
    readOptionalUtf8(path.join(dataDir, 'places.yaml')),
    readOptionalUtf8(path.join(dataDir, 'sources.yaml')),
    readOptionalUtf8(path.join(dataDir, 'media.yaml')),
    readOptionalUtf8(path.join(dataDir, 'narratives.yaml')),
  ]);

  const privacy: Partial<PrivacyConfig> = configText
    ? parseKinloomConfigYaml(configText).privacy
    : {};

  // Pre-filter top-level YAML blocks so large archives stay sub-second.
  const peopleBlocks = splitTopLevelYamlList(peopleText);
  const kinshipBlocks = splitTopLevelYamlList(kinshipText);
  const eventBlocks = splitTopLevelYamlList(eventsText);
  const placeBlocks = splitTopLevelYamlList(placesText);
  const sourceBlocks = splitTopLevelYamlList(sourcesText);
  const mediaBlocks = splitTopLevelYamlList(mediaText);
  const narrativeBlocks = splitTopLevelYamlList(narrativesText);

  const relevantKinship = parseMatchingYamlBlocks(
    kinshipBlocks.filter((b) => b.includes(personId))
  );

  const includeFamily = options.includeFamily === true;
  const parentIds = new Set<string>();
  const spouseIds = new Set<string>();
  const childIds = new Set<string>();
  for (const edge of relevantKinship) {
    const from = typeof edge.from === 'string' ? edge.from : '';
    const to = typeof edge.to === 'string' ? edge.to : '';
    if (edge.relation === 'parent') {
      if (to === personId && from) {
        parentIds.add(from);
      } else if (from === personId && to) {
        childIds.add(to);
      }
    } else if (edge.relation === 'child') {
      if (from === personId && to) {
        parentIds.add(to);
      } else if (to === personId && from) {
        childIds.add(from);
      }
    } else if (edge.relation === 'spouse') {
      if (from === personId && to) {
        spouseIds.add(to);
      } else if (to === personId && from) {
        spouseIds.add(from);
      }
    }
  }

  const siblingIds = includeFamily
    ? collectSiblingIds(
        parentIds,
        new Set([personId, ...parentIds, ...spouseIds, ...childIds]),
        kinshipBlocks
      )
    : new Set<string>();

  const relativeIdSet = new Set<string>([
    ...parentIds,
    ...spouseIds,
    ...childIds,
    ...siblingIds,
  ]);

  const peopleBlocksToParse = peopleBlocks.filter((block) => {
    const id = extractYamlBlockId(block);
    if (id === personId || (id && relativeIdSet.has(id))) {
      return true;
    }
    if (/\b(?:is_living|living):\s*true\b/.test(block)) {
      return true;
    }
    const deathMatch = /^\s+death_edtf:\s*(.*)$/m.exec(block);
    const deathVal = deathMatch ? deathMatch[1].trim().replaceAll(/^["']|["']$/g, '') : '';
    return deathVal.length === 0 || deathVal === 'null' || deathVal === '~';
  });

  const parsedPeople = parseMatchingYamlBlocks(peopleBlocksToParse);
  const peopleById = new Map<string, LooseYamlRecord>();
  for (const p of parsedPeople) {
    if (typeof p.id === 'string') {
      peopleById.set(p.id, p);
    }
  }

  const targetPerson = peopleById.get(personId);
  if (!targetPerson) {
    throw new CliValidationError(`Person '${personId}' not found in ${peopleYamlPath}.`);
  }

  const needEventYearIds = new Set<string>();
  for (const p of parsedPeople) {
    if (typeof p.id !== 'string') {
      continue;
    }
    const hasDeath = asNonEmptyString(p.death_edtf).length > 0;
    const hasBirth = asNonEmptyString(p.birth_edtf).length > 0;
    if (!p.is_living && !p.living && !hasDeath && !hasBirth) {
      needEventYearIds.add(p.id);
    }
  }

  const targetEventBlocks: string[] = [];
  const unknownYearEventsByPerson = new Map<string, Array<{ edtf_date: string }>>();
  for (const block of eventBlocks) {
    if (block.includes(personId)) {
      targetEventBlocks.push(block);
    }
    if (needEventYearIds.size > 0) {
      for (const uid of needEventYearIds) {
        if (block.includes(uid)) {
          const dateMatch = /^\s+edtf_date:\s*(.*)$/m.exec(block);
          const dateVal = dateMatch ? dateMatch[1].trim().replaceAll(/^["']|["']$/g, '') : '';
          const list = unknownYearEventsByPerson.get(uid);
          if (list) {
            list.push({ edtf_date: dateVal });
          } else {
            unknownYearEventsByPerson.set(uid, [{ edtf_date: dateVal }]);
          }
        }
      }
    }
  }

  const rawPersonEvents = parseMatchingYamlBlocks(targetEventBlocks).filter(
    (ev) =>
      Array.isArray(ev.participants) &&
      ev.participants.some((pt) => isPlainRecord(pt) && pt.person_id === personId)
  );

  const livingIds = new Set<string>();
  const livingAncestryPids = new Set<string>();
  const livingPeopleForNames: Array<{ is_living: boolean; full_name: string; alt_names: string[] }> =
    [];

  for (const p of parsedPeople) {
    if (typeof p.id !== 'string') {
      continue;
    }
    const pEvents = p.id === personId ? rawPersonEvents : (unknownYearEventsByPerson.get(p.id) ?? []);
    if (isEffectiveLivingRecord(p, pEvents, privacy)) {
      livingIds.add(p.id);
      const numId = extractNumericXref(p.gedcom_xref);
      if (numId) {
        livingAncestryPids.add(numId);
      }
      livingPeopleForNames.push({
        is_living: true,
        full_name: asNonEmptyString(p.full_name),
        alt_names: Array.isArray(p.alt_names)
          ? p.alt_names.filter((n): n is string => typeof n === 'string')
          : [],
      });
    }
  }

  if (livingIds.has(personId)) {
    throw new CliValidationError(
      `Privacy fence: person '${personId}' is living and excluded from research context dumps.`
    );
  }

  const livingNamePattern = compileLivingNamePattern(collectLivingNames(livingPeopleForNames));

  const formatRelativeList = (idSet: ReadonlySet<string>): ContextRelativeListItem[] =>
    [...idSet].toSorted().map((id) => {
      if (livingIds.has(id)) {
        return REDACTED_RELATIVE_LABEL;
      }
      const rel = peopleById.get(id);
      if (!rel) {
        return {
          id,
          full_name: '(missing in people.yaml)',
          lifespan: '? - ?',
          gedcom_xref: null,
        };
      }
      return {
        id: String(rel.id),
        full_name: scrubText(asNonEmptyString(rel.full_name), livingNamePattern),
        lifespan: formatLifespan(rel),
        gedcom_xref: typeof rel.gedcom_xref === 'string' ? rel.gedcom_xref : null,
      };
    });

  const relatives = {
    parents: formatRelativeList(parentIds),
    spouses: formatRelativeList(spouseIds),
    children: formatRelativeList(childIds),
  };

  const personEventIds = new Set<string>();
  const referencedPlaceIds = new Set<string>();
  const referencedSourceIds = new Set<string>();

  const personEvents = rawPersonEvents.map((ev) => {
    if (typeof ev.id === 'string') {
      personEventIds.add(ev.id);
    }
    const participants = Array.isArray(ev.participants) ? ev.participants : [];
    const hasLivingParticipant = participants.some(
      (pt) => isPlainRecord(pt) && typeof pt.person_id === 'string' && livingIds.has(pt.person_id)
    );
    let clone = structuredClone(ev);

    if (hasLivingParticipant) {
      clone.participants = participants.map((pt) => {
        if (isPlainRecord(pt) && typeof pt.person_id === 'string' && livingIds.has(pt.person_id)) {
          return { person_id: REDACTED_RELATIVE_LABEL, role: pt.role };
        }
        return pt;
      });
      const yr = edtfYear(
        typeof clone.edtf_date === 'string' || typeof clone.edtf_date === 'number'
          ? clone.edtf_date
          : null
      );
      clone.edtf_date = yr !== null ? String(yr) : '';
      clone.place_id = null;
      clone.summary = 'Event involves a living relative (location and exact date omitted).';
      delete clone.photo_url;
    } else if (typeof clone.place_id === 'string' && clone.place_id) {
      referencedPlaceIds.add(clone.place_id);
    }

    clone = scrubDeep(clone, livingNamePattern);

    for (const sRef of Array.isArray(clone.sources) ? clone.sources : []) {
      if (isPlainRecord(sRef) && typeof sRef.source_id === 'string' && sRef.source_id) {
        referencedSourceIds.add(sRef.source_id);
      }
    }
    return clone;
  });

  const targetExtensions = isPlainRecord(targetPerson.extensions) ? targetPerson.extensions : null;
  for (const extSrc of Array.isArray(targetExtensions?.sources) ? targetExtensions.sources : []) {
    if (typeof extSrc === 'string' && extSrc.trim()) {
      referencedSourceIds.add(extSrc.trim());
    } else if (isPlainRecord(extSrc) && typeof extSrc.source_id === 'string') {
      referencedSourceIds.add(extSrc.source_id);
    }
  }

  const candidateMediaBlocks = mediaBlocks.filter((block) => {
    if (block.includes(personId)) {
      return true;
    }
    for (const eid of personEventIds) {
      if (block.includes(eid)) {
        return true;
      }
    }
    return false;
  });

  const personMedia = parseMatchingYamlBlocks(candidateMediaBlocks)
    .filter((item) => {
      const linkedPeople = new Set<string>();
      if (typeof item.person_id === 'string' && item.person_id) {
        linkedPeople.add(item.person_id);
      }
      if (Array.isArray(item.person_ids)) {
        for (const pid of item.person_ids) {
          if (typeof pid === 'string' && pid) {
            linkedPeople.add(pid);
          }
        }
      }
      for (const pid of linkedPeople) {
        if (livingIds.has(pid)) {
          return false;
        }
      }
      return (
        linkedPeople.has(personId) ||
        (typeof item.event_id === 'string' && personEventIds.has(item.event_id))
      );
    })
    .map((item) => {
      if (typeof item.source_id === 'string' && item.source_id) {
        referencedSourceIds.add(item.source_id);
      }
      return scrubDeep(structuredClone(item), livingNamePattern);
    });

  const personNarratives = parseMatchingYamlBlocks(
    narrativeBlocks.filter((b) => b.includes(personId))
  )
    .filter(
      (nar) =>
        nar.subject_person_id === personId ||
        (Array.isArray(nar.person_ids) && nar.person_ids.includes(personId))
    )
    .map((nar) => {
      for (const sid of Array.isArray(nar.source_ids) ? nar.source_ids : []) {
        if (typeof sid === 'string' && sid) {
          referencedSourceIds.add(sid);
        }
      }
      for (const plid of Array.isArray(nar.place_ids) ? nar.place_ids : []) {
        if (typeof plid === 'string' && plid) {
          referencedPlaceIds.add(plid);
        }
      }
      const clone = structuredClone(nar);
      if (Array.isArray(clone.person_ids)) {
        clone.person_ids = clone.person_ids.map((pid) =>
          typeof pid === 'string' && livingIds.has(pid) ? REDACTED_RELATIVE_LABEL : pid
        );
      }
      return scrubDeep(clone, livingNamePattern);
    });

  const referencedPlaces = parseMatchingYamlBlocks(
    placeBlocks.filter((b) => {
      const id = extractYamlBlockId(b);
      return Boolean(id && referencedPlaceIds.has(id));
    })
  ).toSorted((a, b) => String(a.id ?? '').localeCompare(String(b.id ?? '')));

  const referencedSources = parseMatchingYamlBlocks(
    sourceBlocks.filter((b) => {
      const id = extractYamlBlockId(b);
      return Boolean(id && referencedSourceIds.has(id));
    })
  )
    .map((s) => scrubDeep(structuredClone(s), livingNamePattern))
    .toSorted((a, b) => String(a.id ?? '').localeCompare(String(b.id ?? '')));

  const sanitizedTargetPerson = scrubDeep(structuredClone(targetPerson), livingNamePattern);

  const nameIndexHolder: { index: Map<string, string> | null } = { index: null };
  const recordImagesDir = ancestryDir ? path.join(ancestryDir, 'record_images') : null;
  const recordImageFiles =
    recordImagesDir && fs.existsSync(recordImagesDir) ? await readdir(recordImagesDir) : [];

  const ancestryMatch = await findAncestryMatch(
    ancestryDir,
    targetPerson,
    nameIndexHolder,
    livingAncestryPids
  );
  const ancestrySummary = buildAncestrySummary(
    ancestryMatch,
    recordImagesDir,
    recordImageFiles,
    livingAncestryPids,
    livingNamePattern
  );
  const subjectRecordImages =
    ancestrySummary && !ancestrySummary.redacted ? ancestrySummary.recordImages : [];
  const relativeRecordImages = await collectDeceasedRelativeRecordImages({
    parentIds,
    spouseIds,
    childIds: includeFamily ? childIds : new Set<string>(),
    siblingIds: includeFamily ? siblingIds : new Set<string>(),
    peopleById,
    livingIds,
    blockedPersonDbIds: livingAncestryPids,
    privacy,
    ancestryDir,
    recordImagesDir,
    recordImageFiles,
    subjectRecordImages,
    livingNamePattern,
    nameIndexHolder,
  });

  const context: PersonContextPayload = {
    repoDir,
    person: sanitizedTargetPerson,
    relatives,
    events: personEvents,
    places: referencedPlaces,
    sources: referencedSources,
    media: personMedia,
    narratives: personNarratives,
    ancestry: ancestrySummary,
    relativeRecordImages,
  };

  const rendered = options.json
    ? `${JSON.stringify(context, null, 2)}\n`
    : formatPersonContextMarkdown(context);

  return {
    context,
    rendered,
    bytesOut: Buffer.byteLength(rendered, 'utf8'),
  };
}
