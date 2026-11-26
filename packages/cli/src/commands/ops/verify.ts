import fs from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  ArchiveBundleSchema,
  compileArchive,
  parseEventsYaml,
  parseKinloomConfigYaml,
  parseKinshipYaml,
  parseMediaYaml,
  parseNarrativeEnrichmentsYaml,
  parseNarrativesYaml,
  parsePeopleYaml,
  parsePlacesYaml,
  parseSourcesYaml,
  validateNarrativeCitations,
  type ArchiveBundle,
  type MediaItem,
  type Place,
} from '@kinloom/core';
import { CliValidationError } from '../../errors.js';
import { auditBundlePrivacy } from './integrate.js';

export { VERIFY_HELP } from './help.js';

const URL_RE = /https?:\/\/\S+/g;
const SSN_LINE_RE = /(?<![A-Za-z0-9_/-])\d{3}-\d{2}-\d{4}(?![A-Za-z0-9_/-])/g;
const IGNORED_SSN_YAML_KEY_RE =
  /^\s*(?:-\s*)?(?:id|slug|gedcom_xref|url|file|thumb_file|portrait_url|thumb_url|source_url|photo_url)\s*:/;

export interface VerifyCommandOptions {
  repoDir?: string;
  json?: boolean;
}

export interface VerifyCitationsResult {
  ok: boolean;
  narrativesChecked: number;
  errors: string[];
}

export interface VerifyInvalidPlace {
  id: string;
  reason: string;
}

export interface VerifyPlacesResult {
  ok: boolean;
  placesChecked: number;
  invalidPlaces: VerifyInvalidPlace[];
}

export interface VerifySsnHit {
  file: string;
  line: number;
  match: string;
}

export interface VerifySsnResult {
  ok: boolean;
  filesScanned: number;
  hits: VerifySsnHit[];
}

export interface VerifyCompileResult {
  ok: boolean;
  privateCounts: ArchiveBundle['meta']['counts'];
  publicCounts: ArchiveBundle['meta']['counts'];
  privateReviewFlags: string[];
  publicReviewFlags: string[];
  privateLivingLeaks: string[];
  publicLivingLeaks: string[];
  duplicateResidenceSpans: string[];
}

export interface VerifyMissingMediaFile {
  id: string;
  file: string;
  expectedPath: string;
  reason: string;
}

export interface VerifyMediaResult {
  ok: boolean;
  mediaLayout: 'archive-media' | 'media';
  checkedCount: number;
  missingFiles: VerifyMissingMediaFile[];
}

export interface VerifyCommandResult {
  ok: boolean;
  repo: string;
  duration_ms: number;
  checks: {
    citations: VerifyCitationsResult;
    places: VerifyPlacesResult;
    ssn: VerifySsnResult;
    compile: VerifyCompileResult;
    media: VerifyMediaResult;
  };
  errors: string[];
  rendered: string;
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

export function validatePlaceCoordinates(places: readonly Place[]): VerifyPlacesResult {
  const invalidPlaces: VerifyInvalidPlace[] = [];
  for (const place of places) {
    const { lat, lng } = place;
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      invalidPlaces.push({ id: place.id, reason: `non-finite coordinates (${String(lat)}, ${String(lng)})` });
      continue;
    }
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      invalidPlaces.push({ id: place.id, reason: `coordinates out of range (${lat}, ${lng})` });
      continue;
    }
    if (Math.abs(lat) < 1e-9 && Math.abs(lng) < 1e-9) {
      invalidPlaces.push({ id: place.id, reason: 'forbidden (0, 0) coordinates' });
    }
  }
  return {
    ok: invalidPlaces.length === 0,
    placesChecked: places.length,
    invalidPlaces,
  };
}

export function scanYamlFilesForSsns(
  files: ReadonlyArray<{ name: string; content: string }>
): VerifySsnResult {
  const hits: VerifySsnHit[] = [];

  for (const file of files) {
    const lines = file.content.replaceAll('\r\n', '\n').split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      const rawLine = lines[i];
      if (!rawLine || IGNORED_SSN_YAML_KEY_RE.test(rawLine)) {
        continue;
      }
      const withoutUrls = rawLine.replaceAll(URL_RE, ' ');
      for (const match of withoutUrls.matchAll(SSN_LINE_RE)) {
        if (hits.length < 50) {
          hits.push({
            file: file.name,
            line: i + 1,
            match: match[0],
          });
        }
      }
    }
  }

  return {
    ok: hits.length === 0,
    filesScanned: files.length,
    hits,
  };
}

export function findDuplicateResidenceSpans(
  bundle: ArchiveBundle,
  mode: 'private' | 'public'
): string[] {
  const duplicates: string[] = [];
  const seenIds = new Set<string>();
  const seenTuples = new Set<string>();

  for (const span of bundle.residence_spans) {
    if (seenIds.has(span.id)) {
      duplicates.push(`${mode}:id:${span.id}`);
    } else {
      seenIds.add(span.id);
    }

    const tupleKey = `${span.person_id}|${span.place_id}|${span.time_min}|${span.time_max}|${span.from_event_id}|${span.to_event_id}`;
    if (seenTuples.has(tupleKey)) {
      duplicates.push(`${mode}:span:${span.id}(${span.person_id}@${span.place_id})`);
    } else {
      seenTuples.add(tupleKey);
    }
  }

  return duplicates;
}

export function verifyMediaFilesOnDisk(
  repoDir: string,
  mediaItems: readonly MediaItem[]
): VerifyMediaResult {
  const archiveMediaRoot = path.join(repoDir, 'archive-media');
  const hasArchiveMedia =
    fs.existsSync(archiveMediaRoot) && fs.statSync(archiveMediaRoot).isDirectory();
  const mediaLayout: 'archive-media' | 'media' = hasArchiveMedia ? 'archive-media' : 'media';
  const mediaRoot = hasArchiveMedia ? archiveMediaRoot : repoDir;
  const publicMediaDir = path.resolve(repoDir, 'public', 'media');
  const rootPrefix = `${path.resolve(mediaRoot)}${path.sep}`;

  const missingFiles: VerifyMissingMediaFile[] = [];
  let checkedCount = 0;

  for (const item of mediaItems) {
    const fileUrl = item.file.trim();
    if (/^https?:\/\//i.test(fileUrl)) {
      continue;
    }
    checkedCount += 1;

    if (!fileUrl.startsWith('/media/')) {
      missingFiles.push({
        id: item.id,
        file: fileUrl,
        expectedPath: fileUrl,
        reason: "media file path must start with '/media/'",
      });
      continue;
    }

    const parts = fileUrl.slice(1).split('/');
    if (parts.some((seg) => !seg || seg === '.' || seg === '..')) {
      missingFiles.push({
        id: item.id,
        file: fileUrl,
        expectedPath: fileUrl,
        reason: 'unsafe path traversal segment',
      });
      continue;
    }

    const expectedPath = path.resolve(mediaRoot, ...parts);
    if (expectedPath === publicMediaDir || expectedPath.startsWith(`${publicMediaDir}${path.sep}`)) {
      missingFiles.push({
        id: item.id,
        file: fileUrl,
        expectedPath,
        reason: 'resolves inside forbidden public/media/',
      });
      continue;
    }
    if (!expectedPath.startsWith(rootPrefix)) {
      missingFiles.push({
        id: item.id,
        file: fileUrl,
        expectedPath,
        reason: 'escapes media root',
      });
      continue;
    }
    if (!fs.existsSync(expectedPath)) {
      missingFiles.push({
        id: item.id,
        file: fileUrl,
        expectedPath,
        reason: 'file not found on disk',
      });
      continue;
    }
    const stat = fs.statSync(expectedPath);
    if (!stat.isFile()) {
      missingFiles.push({
        id: item.id,
        file: fileUrl,
        expectedPath,
        reason: 'path is not a regular file',
      });
      continue;
    }
    if (stat.size === 0) {
      missingFiles.push({
        id: item.id,
        file: fileUrl,
        expectedPath,
        reason: 'file is empty (0 bytes)',
      });
    }
  }

  return {
    ok: missingFiles.length === 0,
    mediaLayout,
    checkedCount,
    missingFiles,
  };
}

export function formatVerifyTextReport(report: Omit<VerifyCommandResult, 'rendered'>): string {
  const status = report.ok ? 'PASS' : 'FAIL';
  const lines: string[] = [
    `Verify [${status}] ${report.repo} (${report.duration_ms} ms)`,
    `  1. Citations: ${report.checks.citations.ok ? 'PASS' : 'FAIL'} | narratives=${report.checks.citations.narrativesChecked} errors=${report.checks.citations.errors.length}`,
    `  2. Places: ${report.checks.places.ok ? 'PASS' : 'FAIL'} | checked=${report.checks.places.placesChecked} invalid=${report.checks.places.invalidPlaces.length}`,
    `  3. SSN scan: ${report.checks.ssn.ok ? 'PASS' : 'FAIL'} | files=${report.checks.ssn.filesScanned} hits=${report.checks.ssn.hits.length}`,
    `  4. Dual compile: ${report.checks.compile.ok ? 'PASS' : 'FAIL'} | private(people=${report.checks.compile.privateCounts.people}, events=${report.checks.compile.privateCounts.events}, spans=${report.checks.compile.privateCounts.residence_spans}, flags=${report.checks.compile.privateReviewFlags.length}, leaks=${report.checks.compile.privateLivingLeaks.length}) public(people=${report.checks.compile.publicCounts.people}, living_redacted=${report.checks.compile.publicCounts.living_redacted}, flags=${report.checks.compile.publicReviewFlags.length}, leaks=${report.checks.compile.publicLivingLeaks.length}) dupSpans=${report.checks.compile.duplicateResidenceSpans.length}`,
    `  5. Media disk: ${report.checks.media.ok ? 'PASS' : 'FAIL'} | layout=${report.checks.media.mediaLayout} checked=${report.checks.media.checkedCount} missing=${report.checks.media.missingFiles.length}`,
  ];

  for (const err of report.errors.slice(0, 30)) {
    lines.push(`  ERROR: ${err}`);
  }
  if (report.errors.length > 30) {
    lines.push(`  ... and ${report.errors.length - 30} more error(s).`);
  }

  return `${lines.join('\n')}\n`;
}

export async function runVerifyCommand(
  options: VerifyCommandOptions = {}
): Promise<VerifyCommandResult> {
  const t0 = performance.now();
  const repoDir = path.resolve(options.repoDir?.trim() || process.cwd());
  if (!fs.existsSync(repoDir) || !fs.statSync(repoDir).isDirectory()) {
    throw new CliValidationError(`Repository directory does not exist: ${repoDir}`);
  }

  const dataDir = path.join(repoDir, 'data');
  const configPath = path.join(repoDir, 'kinloom.config.yaml');
  if (!fs.existsSync(dataDir) || !fs.statSync(dataDir).isDirectory()) {
    throw new CliValidationError(`Missing data/ directory at ${dataDir}.`);
  }
  if (!fs.existsSync(configPath)) {
    throw new CliValidationError(`Missing kinloom.config.yaml at ${configPath}.`);
  }

  const [
    configText,
    peopleText,
    eventsText,
    placesText,
    sourcesText,
    kinshipText,
    mediaText,
    narrativesText,
    enrichmentsText,
  ] = await Promise.all([
    readFile(configPath, 'utf8'),
    readOptionalUtf8(path.join(dataDir, 'people.yaml')),
    readOptionalUtf8(path.join(dataDir, 'events.yaml')),
    readOptionalUtf8(path.join(dataDir, 'places.yaml')),
    readOptionalUtf8(path.join(dataDir, 'sources.yaml')),
    readOptionalUtf8(path.join(dataDir, 'kinship.yaml')),
    readOptionalUtf8(path.join(dataDir, 'media.yaml')),
    readOptionalUtf8(path.join(dataDir, 'narratives.yaml')),
    readOptionalUtf8(path.join(dataDir, 'narrative_enrichments.yaml')),
  ]);

  const siteConfig = parseKinloomConfigYaml(configText);
  const people = peopleText ? parsePeopleYaml(peopleText) : [];
  const events = eventsText ? parseEventsYaml(eventsText) : [];
  const places = placesText ? parsePlacesYaml(placesText) : [];
  const sources = sourcesText ? parseSourcesYaml(sourcesText) : [];
  const kinship = kinshipText ? parseKinshipYaml(kinshipText) : [];
  const media = mediaText ? parseMediaYaml(mediaText) : [];
  const narratives = narrativesText ? parseNarrativesYaml(narrativesText) : [];
  const enrichments = enrichmentsText ? parseNarrativeEnrichmentsYaml(enrichmentsText) : [];

  // 1. Validate narrative inline citations against known source and media IDs.
  const sourceIds = new Set(sources.map((s) => s.id));
  const mediaIds = new Set(media.map((m) => m.id));
  const citationErrors = validateNarrativeCitations(narratives, sourceIds, mediaIds);
  const citations: VerifyCitationsResult = {
    ok: citationErrors.length === 0,
    narrativesChecked: narratives.length,
    errors: citationErrors,
  };

  // 2. Validate place coordinates.
  const placesCheck = validatePlaceCoordinates(places);

  // 3. Scan every data/*.yaml file for SSN patterns.
  const yamlEntries = fs
    .readdirSync(dataDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && (entry.name.endsWith('.yaml') || entry.name.endsWith('.yml')))
    .toSorted((a, b) => a.name.localeCompare(b.name));

  const yamlTexts = await Promise.all(
    yamlEntries.map(async (entry) => ({
      name: `data/${entry.name}`,
      content: await readFile(path.join(dataDir, entry.name), 'utf8'),
    }))
  );
  const ssnCheck = scanYamlFilesForSsns(yamlTexts);

  // 4. Run dual-mode compilation (private and public) via @kinloom/core.
  const compileBase = {
    people,
    events,
    places,
    sources,
    kinship,
    media,
    narratives,
    ...(enrichments.length > 0 ? { enrichments } : {}),
    siteConfig,
  };

  const privateResult = compileArchive({ ...compileBase, mode: 'private' });
  const publicResult = compileArchive({ ...compileBase, mode: 'public' });

  ArchiveBundleSchema.parse(privateResult.bundle);
  ArchiveBundleSchema.parse(publicResult.bundle);

  const privateLivingLeaks = auditBundlePrivacy(privateResult.bundle, 'private');
  const publicLivingLeaks = auditBundlePrivacy(publicResult.bundle, 'public');
  const duplicateResidenceSpans = [
    ...findDuplicateResidenceSpans(privateResult.bundle, 'private'),
    ...findDuplicateResidenceSpans(publicResult.bundle, 'public'),
  ];

  const compileCheck: VerifyCompileResult = {
    ok:
      privateResult.reviewFlags.length === 0 &&
      publicResult.reviewFlags.length === 0 &&
      privateLivingLeaks.length === 0 &&
      publicLivingLeaks.length === 0 &&
      duplicateResidenceSpans.length === 0,
    privateCounts: privateResult.bundle.meta.counts,
    publicCounts: publicResult.bundle.meta.counts,
    privateReviewFlags: privateResult.reviewFlags,
    publicReviewFlags: publicResult.reviewFlags,
    privateLivingLeaks,
    publicLivingLeaks,
    duplicateResidenceSpans,
  };

  // 5. Verify every media.yaml file path exists on disk under archive-media/ or media/.
  const mediaCheck = verifyMediaFilesOnDisk(repoDir, media);

  const errors: string[] = [
    ...citations.errors.map((e) => `citations: ${e}`),
    ...placesCheck.invalidPlaces.map((p) => `places: '${p.id}' ${p.reason}`),
    ...ssnCheck.hits.map((h) => `ssn: ${h.file}:${h.line} matched '${h.match}'`),
    ...compileCheck.privateReviewFlags.map((f) => `compile(private): review flag: ${f}`),
    ...compileCheck.publicReviewFlags.map((f) => `compile(public): review flag: ${f}`),
    ...compileCheck.privateLivingLeaks.map((l) => `compile(private): living leak: ${l}`),
    ...compileCheck.publicLivingLeaks.map((l) => `compile(public): living leak: ${l}`),
    ...compileCheck.duplicateResidenceSpans.map((d) => `compile: duplicate residence_span: ${d}`),
    ...mediaCheck.missingFiles.map(
      (m) => `media: '${m.id}' (${m.file}) ${m.reason} at ${m.expectedPath}`
    ),
  ];

  const durationMs = Math.round(performance.now() - t0);
  const baseReport: Omit<VerifyCommandResult, 'rendered'> = {
    ok: errors.length === 0,
    repo: repoDir,
    duration_ms: durationMs,
    checks: {
      citations,
      places: placesCheck,
      ssn: ssnCheck,
      compile: compileCheck,
      media: mediaCheck,
    },
    errors,
  };

  const rendered = options.json
    ? `${JSON.stringify(baseReport, null, 2)}\n`
    : formatVerifyTextReport(baseReport);

  return {
    ...baseReport,
    rendered,
  };
}
