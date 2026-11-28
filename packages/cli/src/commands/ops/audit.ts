import fs from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  getCurrentReferenceYear,
  type PrivacyConfig,
  parseKinloomConfigYaml,
  resolveEffectiveLiving,
} from '@kinloom/core';
import { CliValidationError } from '../../errors.js';
import {
  discoverSiteCliPlugins,
  type ExecutedPluginCheckResult,
  type KinloomAuditCheckContext,
  resolvePluginCommands,
  runRegisteredCheck,
} from '../../plugins.js';
import { type LoadedLocalArchiveRepo, loadLocalArchiveRepo } from '../dataFiles.js';
import { computeLifespan, parseAuditEdtf, runChronologyCheck } from './audit/chronology.js';
import { runUncitedSentenceCheck, splitParagraphIntoSentences } from './audit/citations.js';
import { runAuditHygieneRegressionCheck } from './audit/hygiene.js';
import { runPrivacyAndStyleScan } from './audit/privacyStyle.js';
import { formatAuditTextReport } from './audit/report.js';
import { inspectImageBuffer, runScanInventoryCheck } from './audit/scans.js';
import {
  type AuditCommandOptions,
  type AuditCommandResult,
  asString,
  type DryRunCheckResult,
  isPlainRecord,
  type LooseRecord,
} from './audit/types.js';
import { createPronunciationAuditCheck } from './pronunciation-checks.js';
import { runIntegrateCommand } from './shared/integrateEngine/execute.js';
import { collectLiveMediaCollisions, loadLiveMedia, readStagedMediaRefs } from './shared/mediaFiles.js';
import { parseValidDeathEdtf } from './shared/stagedPackages.js';
import { parseLooseYamlList } from './shared/yamlScanner.js';
import { formatAuditHygieneWarningMessage } from './tree-hygiene.js';

const SAFE_PERSON_ID_RE = /^[a-zA-Z0-9_-]+$/;

export type {
  AuditCommandOptions,
  AuditCommandResult,
  AuditedScanFile,
  ChronologyCheckResult,
  CitationsCheckResult,
  DryRunCheckResult,
  InspectedImageHeader,
  LifespanSummary,
  ParsedAuditEdtf,
  PrivacyAndStyleCheckResult,
  PrivacyScanDateContext,
  ScansCheckResult,
  UncitedSentenceItem,
} from './audit/types.js';
export { AUDIT_HELP } from './help.js';
export {
  computeLifespan,
  formatAuditTextReport,
  inspectImageBuffer,
  parseAuditEdtf,
  runAuditHygieneRegressionCheck,
  runChronologyCheck,
  runPrivacyAndStyleScan,
  runScanInventoryCheck,
  runUncitedSentenceCheck,
  splitParagraphIntoSentences,
};

async function readOptionalUtf8(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, 'utf8');
  } catch (err: unknown) {
    if (typeof err === 'object' && err !== null && 'code' in err && err.code === 'ENOENT') {
      return '';
    }
    throw err;
  }
}

function countZeroCoordPlaces(patch: LooseRecord): string[] {
  const bad: string[] = [];
  for (const rawPl of Array.isArray(patch['places']) ? patch['places'] : []) {
    const pl = isPlainRecord(rawPl) ? rawPl : {};
    const lat = Number(pl['lat']);
    const lng = Number(pl['lng'] ?? pl['lon']);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || (Math.abs(lat) < 1e-9 && Math.abs(lng) < 1e-9)) {
      bad.push(typeof pl['id'] === 'string' ? pl['id'] : 'unknown');
    }
  }
  return bad;
}

async function runInProcessIntegrateDryRun(params: {
  repoDir: string;
  personId: string;
  packageDir: string;
  preloadedRepo?: LoadedLocalArchiveRepo | undefined;
  preparsedPatch?: Record<string, unknown>;
}): Promise<DryRunCheckResult> {
  const t0 = performance.now();
  try {
    const res = await runIntegrateCommand({
      repoDir: params.repoDir,
      personId: params.personId,
      packageDir: params.packageDir,
      dryRun: true,
      preloadedRepo: params.preloadedRepo,
      preparsedPatch: params.preparsedPatch,
    });
    return {
      ok: res.ok,
      durationMs: Math.round(performance.now() - t0),
      inlineCitationCount: res.inlineCitationCount,
      reviewFlags: res.validation.privateReviewFlags + res.validation.publicReviewFlags,
      livingLeaks: res.validation.livingLeaks,
      counts: res.counts,
      error: null,
    };
  } catch (err: unknown) {
    return {
      ok: false,
      durationMs: Math.round(performance.now() - t0),
      inlineCitationCount: 0,
      reviewFlags: 0,
      livingLeaks: null,
      counts: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function tryLoadTypedArchiveRepo(repoDir: string): Promise<LoadedLocalArchiveRepo | null> {
  try {
    const loaded = await loadLocalArchiveRepo(repoDir, {
      requireConfig: false,
      requirePeopleFile: true,
      includeEnrichments: true,
    });
    return loaded;
  } catch {
    return null;
  }
}

export async function runAuditCommand(options: AuditCommandOptions): Promise<AuditCommandResult> {
  const t0 = performance.now();
  const repoDir = path.resolve(options.repoDir?.trim() || process.cwd());
  const personId = options.personId.trim();
  if (!personId) {
    throw new CliValidationError('Missing required option `--person <person_id>`.');
  }
  if (!SAFE_PERSON_ID_RE.test(personId)) {
    throw new CliValidationError(`Invalid person_id '${personId}'.`);
  }

  const packageDir = path.resolve(
    options.packageDir?.trim() || path.join(repoDir, 'research', 'people', personId)
  );
  const patchPath = path.join(packageDir, 'patch.json');
  const dossierPath = path.join(packageDir, 'dossier.md');
  if (!fs.existsSync(patchPath)) {
    throw new CliValidationError(`Missing patch.json at ${patchPath}.`);
  }

  const dataDir = path.join(repoDir, 'data');
  const peoplePath = path.join(dataDir, 'people.yaml');
  if (!options.preloadedRepo && !fs.existsSync(peoplePath)) {
    throw new CliValidationError(`Missing data/people.yaml at ${peoplePath}.`);
  }

  const [patchText, dossierText, typedRepo] = await Promise.all([
    readFile(patchPath, 'utf8'),
    readOptionalUtf8(dossierPath),
    options.preloadedRepo ? Promise.resolve(options.preloadedRepo) : tryLoadTypedArchiveRepo(repoDir),
  ]);

  const parsedPatch: unknown = JSON.parse(patchText);
  if (!isPlainRecord(parsedPatch)) {
    throw new CliValidationError(`patch.json at ${patchPath} must contain a JSON object.`);
  }
  const patch = parsedPatch;

  let parsedSiteConfig = typedRepo?.siteConfig ?? null;
  let parsedPeople: LooseRecord[];
  let allLiveEvents: LooseRecord[];
  let allLiveKinship: LooseRecord[];

  if (typedRepo) {
    parsedPeople = typedRepo.people as readonly LooseRecord[] as LooseRecord[];
    allLiveEvents = typedRepo.events as readonly LooseRecord[] as LooseRecord[];
    allLiveKinship = typedRepo.kinship as readonly LooseRecord[] as LooseRecord[];
  } else {
    const [peopleText, eventsText, kinshipText, configText] = await Promise.all([
      readFile(peoplePath, 'utf8'),
      readOptionalUtf8(path.join(dataDir, 'events.yaml')),
      readOptionalUtf8(path.join(dataDir, 'kinship.yaml')),
      readOptionalUtf8(path.join(repoDir, 'kinloom.config.yaml')),
    ]);
    parsedSiteConfig = configText ? parseKinloomConfigYaml(configText) : null;
    parsedPeople = parseLooseYamlList(peopleText);
    allLiveEvents = parseLooseYamlList(eventsText);
    allLiveKinship = parseLooseYamlList(kinshipText);
  }

  const privacyConfig: Partial<PrivacyConfig> = parsedSiteConfig ? parsedSiteConfig.privacy : {};

  const referenceYear = privacyConfig.referenceYear ?? getCurrentReferenceYear();
  const isEffectiveLivingPerson = (person: LooseRecord): boolean => {
    if (person['is_living'] === true || person['living'] === true) {
      return true;
    }
    return resolveEffectiveLiving(
      {
        is_living: false,
        birth_edtf: asString(person['birth_edtf']).trim(),
        death_edtf: asString(person['death_edtf']).trim(),
      },
      privacyConfig,
      referenceYear
    );
  };

  const stagedPeopleById = new Map<string, LooseRecord>();
  for (const rawPerson of Array.isArray(patch['people']) ? patch['people'] : []) {
    if (!isPlainRecord(rawPerson) || typeof rawPerson['id'] !== 'string' || !rawPerson['id'].trim()) {
      continue;
    }
    stagedPeopleById.set(rawPerson['id'].trim(), rawPerson);
  }

  const personUpdates = isPlainRecord(patch['person_updates']) ? patch['person_updates'] : null;
  let targetDeathUpdate: string | null = null;
  if (personUpdates) {
    const hasConflict =
      personUpdates['death_edtf'] !== undefined &&
      personUpdates['death_date'] !== undefined &&
      String(personUpdates['death_edtf']) !== String(personUpdates['death_date']);
    if (!hasConflict) {
      const rawDeath =
        personUpdates['death_edtf'] !== undefined ? personUpdates['death_edtf'] : personUpdates['death_date'];
      targetDeathUpdate = parseValidDeathEdtf(rawDeath);
    }
  }

  const mergedAuditPeople: LooseRecord[] = [];
  const seenAuditPersonIds = new Set<string>();
  let targetPerson: LooseRecord | null = null;
  const livingPeople: LooseRecord[] = [];
  const deceasedPeople: LooseRecord[] = [];

  for (let i = 0; i < parsedPeople.length; i += 1) {
    const person = parsedPeople[i];
    if (person === undefined) continue;
    const id = typeof person['id'] === 'string' ? person['id'] : '';
    if (id) {
      seenAuditPersonIds.add(id);
    }
    const origIsLiving = isEffectiveLivingPerson(person);
    if (id !== personId && origIsLiving) {
      livingPeople.push(person);
    }

    const explicitlyLiving = person['is_living'] === true || person['living'] === true;
    let effectivePerson: LooseRecord = person;
    let effectiveIsLiving = origIsLiving;
    if (id === personId && !explicitlyLiving && targetDeathUpdate !== null) {
      const candidate = { ...person, death_edtf: targetDeathUpdate };
      if (!isEffectiveLivingPerson(candidate)) {
        effectivePerson = candidate;
        effectiveIsLiving = false;
      }
    }
    const staged = id ? stagedPeopleById.get(id) : undefined;
    const finalPerson = staged && !effectiveIsLiving ? { ...effectivePerson, ...staged } : effectivePerson;
    mergedAuditPeople.push(finalPerson);
    if (id === personId) {
      targetPerson = finalPerson;
    }
    const finalIsLiving =
      staged && !effectiveIsLiving ? isEffectiveLivingPerson(finalPerson) : effectiveIsLiving;
    if (!finalIsLiving) {
      deceasedPeople.push(finalPerson);
    }
  }
  for (const [id, stagedPerson] of stagedPeopleById) {
    if (!seenAuditPersonIds.has(id)) {
      mergedAuditPeople.push(stagedPerson);
      if (id === personId) {
        targetPerson = stagedPerson;
      }
      if (!isEffectiveLivingPerson(stagedPerson)) {
        deceasedPeople.push(stagedPerson);
      }
    }
  }

  const existingPersonEvents: LooseRecord[] = [];
  for (let i = 0; i < allLiveEvents.length; i += 1) {
    const ev = allLiveEvents[i];
    if (ev === undefined) continue;
    const pts = ev['participants'];
    if (!Array.isArray(pts)) {
      continue;
    }
    for (let p = 0; p < pts.length; p += 1) {
      const pt = pts[p];
      if (isPlainRecord(pt) && pt['person_id'] === personId) {
        existingPersonEvents.push(ev);
        break;
      }
    }
  }

  const chronology = runChronologyCheck(targetPerson, patch, existingPersonEvents);
  const hygieneWarnings = runAuditHygieneRegressionCheck({
    personId,
    patch,
    livePeople: parsedPeople,
    liveEvents: allLiveEvents,
    liveKinship: allLiveKinship,
    ...(typedRepo
      ? {
          typedLive: {
            people: typedRepo.people,
            events: typedRepo.events,
            kinship: typedRepo.kinship,
          },
        }
      : {}),
  });
  const privacy = runPrivacyAndStyleScan(dossierText, patch, livingPeople, deceasedPeople, {
    targetPerson,
    allPeople: mergedAuditPeople,
    liveEvents: allLiveEvents,
  });
  const citations = runUncitedSentenceCheck(patch);
  const scans = runScanInventoryCheck(repoDir, packageDir, patch);
  const zeroCoordinatePlaces = countZeroCoordPlaces(patch);
  const dryRun = await runInProcessIntegrateDryRun({
    repoDir,
    personId,
    packageDir,
    preloadedRepo: typedRepo?.siteConfig ? typedRepo : undefined,
    preparsedPatch: patch,
  });

  const auditCheckCtx: KinloomAuditCheckContext = {
    repoDir,
    personId,
    packageDir,
    patch,
    dossierText,
    siteConfig: parsedSiteConfig,
    targetPerson,
    livePeople: parsedPeople,
    mergedPeople: mergedAuditPeople,
  };
  const pronunciationCheck = await runRegisteredCheck(
    'builtin',
    createPronunciationAuditCheck(),
    auditCheckCtx
  );

  let pluginDiscoveryWarnings: string[] = [];
  let resolvedPluginAuditChecks = resolvePluginCommands(options.plugins ?? []);
  if (options.plugins === undefined) {
    const discovered = await discoverSiteCliPlugins(repoDir);
    resolvedPluginAuditChecks = resolvePluginCommands(discovered.plugins);
    pluginDiscoveryWarnings = discovered.warnings;
  }
  const pluginChecks: ExecutedPluginCheckResult[] = [];
  for (const reg of resolvedPluginAuditChecks.auditChecks) {
    pluginChecks.push(await runRegisteredCheck(reg.pluginId, reg.check, auditCheckCtx));
  }

  const allErrors: string[] = [
    ...chronology.errors.map((e) => `chronology: ${e}`),
    ...privacy.errors.map((e) => `privacy: ${e}`),
    ...scans.errors.map((e) => `scans: ${e}`),
    ...zeroCoordinatePlaces.map((id) => `places: zero or missing coordinates on '${id}'`),
    ...(dryRun.error ? [`dryRun: ${dryRun.error}`] : []),
    ...pronunciationCheck.errors.map((e) => `pronunciation: ${e}`),
    ...pluginChecks.flatMap((pc) => pc.errors.map((e) => `plugin(${pc.id}): ${e}`)),
  ];
  const stagedMediaRefs = readStagedMediaRefs(patch['media']);
  const liveMediaFileCollisions =
    stagedMediaRefs.length === 0
      ? []
      : collectLiveMediaCollisions(
          [{ personId, media: stagedMediaRefs }],
          typedRepo ? typedRepo.media : loadLiveMedia(repoDir)
        );
  const liveMediaWarnings = liveMediaFileCollisions.flatMap((collision) =>
    collision.staged.map(
      (staged) =>
        `media: file '${collision.file}' already belongs to live media id '${collision.live_media_id}' (staged media id '${staged.media_id}')`
    )
  );
  const hygieneWarningMessages = hygieneWarnings.map(
    (warning) => `hygiene(${warning.category}): ${formatAuditHygieneWarningMessage(warning)}`
  );
  const allWarnings: string[] = [
    ...chronology.warnings.map((w) => `chronology: ${w}`),
    ...hygieneWarningMessages,
    ...privacy.warnings.map((w) => `style: ${w}`),
    ...(citations.uncitedCount > 0
      ? [`citations: ${citations.uncitedCount} uncited prose sentence(s) in body_md`]
      : []),
    ...scans.warnings.map((w) => `scans: ${w}`),
    ...liveMediaWarnings,
    ...pronunciationCheck.warnings.map((w) => `pronunciation: ${w}`),
    ...pluginDiscoveryWarnings.map((w) => `plugin: ${w}`),
    ...pluginChecks.flatMap((pc) => pc.warnings.map((w) => `plugin(${pc.id}): ${w}`)),
  ];

  const durationMs = Math.round(performance.now() - t0);
  const baseReport: Omit<AuditCommandResult, 'rendered'> = {
    ok: allErrors.length === 0,
    strictOk:
      allErrors.length === 0 &&
      citations.uncitedCount === 0 &&
      privacy.emDashCount === 0 &&
      liveMediaFileCollisions.length === 0 &&
      hygieneWarnings.length === 0 &&
      pronunciationCheck.strictOk &&
      pluginChecks.every((pc) => pc.strictOk),
    repo: repoDir,
    person_id: personId,
    package_dir: packageDir,
    duration_ms: durationMs,
    zeroCoordinatePlaces,
    hygieneWarnings,
    checks: {
      chronology,
      privacy,
      citations,
      scans,
      dryRun,
      pronunciation: pronunciationCheck,
    },
    pluginChecks,
    errors: allErrors,
    warnings: allWarnings,
  };

  const rendered = options.json
    ? `${JSON.stringify(baseReport, null, 2)}\n`
    : formatAuditTextReport(baseReport);

  return {
    ...baseReport,
    rendered,
  };
}
