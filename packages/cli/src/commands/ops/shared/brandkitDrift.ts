import fs from 'node:fs';
import path from 'node:path';
import { type KinloomSiteConfig, parseKinloomConfigYaml, resolveBrandSpec } from '@kinloom/core';

export interface ExpectedBrandkitProfile {
  readonly siteTitle: string;
  readonly expectedTitle: string;
  readonly expectedAccent: string;
}

export interface WebManifestDriftResult {
  readonly parseError: string | null;
  readonly manifestName: string | null;
  readonly manifestShortName: string | null;
  readonly hasIcons: boolean;
  readonly driftMessage: string | null;
}

export interface AccentDriftResult {
  readonly actualAccent: string | null;
  readonly driftMessage: string | null;
}

const FAVICON_LIGHT_ACCENT_RE = /\.kl-accent\s*\{[^}]*\bstroke\s*:\s*(#[0-9a-fA-F]{6})\b/i;
const SW_OFFLINE_ACCENT_RE = /:root\{[^}]*--accent\s*:\s*(#[0-9a-fA-F]{6})\b/i;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function resolveExpectedBrandkitProfile(siteConfig: KinloomSiteConfig): ExpectedBrandkitProfile {
  const spec = resolveBrandSpec(siteConfig);
  return {
    siteTitle: siteConfig.site.title.trim(),
    expectedTitle: spec.title,
    expectedAccent: spec.accent,
  };
}

export function tryLoadExpectedBrandkitProfile(repoDir: string): ExpectedBrandkitProfile | null {
  const configPath = path.join(repoDir, 'kinloom.config.yaml');
  let rawYaml: string;
  try {
    rawYaml = fs.readFileSync(configPath, 'utf8');
  } catch {
    return null;
  }
  try {
    return resolveExpectedBrandkitProfile(parseKinloomConfigYaml(rawYaml));
  } catch {
    return null;
  }
}

export function checkWebManifestDrift(
  rawBody: string,
  expected?: ExpectedBrandkitProfile | null
): WebManifestDriftResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return {
      parseError: 'invalid JSON manifest',
      manifestName: null,
      manifestShortName: null,
      hasIcons: false,
      driftMessage: null,
    };
  }
  if (!isPlainObject(parsed)) {
    return {
      parseError: 'manifest must be a JSON object',
      manifestName: null,
      manifestShortName: null,
      hasIcons: false,
      driftMessage: null,
    };
  }

  const rawName = typeof parsed['name'] === 'string' ? parsed['name'].trim() : '';
  const rawShortName = typeof parsed['short_name'] === 'string' ? parsed['short_name'].trim() : '';
  const manifestName = rawName.length > 0 ? rawName : null;
  const manifestShortName = rawShortName.length > 0 ? rawShortName : null;
  const hasIcons = Array.isArray(parsed['icons']) && parsed['icons'].length > 0;

  let driftMessage: string | null = null;
  if (expected) {
    const isGenericName = manifestName === 'Kinloom';
    const isGenericShortName = manifestShortName === 'Kinloom';
    if (expected.expectedTitle !== 'Kinloom' && (isGenericName || isGenericShortName)) {
      const matchedFields: string[] = [];
      if (isGenericName) {
        matchedFields.push('name="Kinloom"');
      }
      if (isGenericShortName) {
        matchedFields.push('short_name="Kinloom"');
      }
      driftMessage = `site.webmanifest still uses generic default (${matchedFields.join(', ')}) while kinloom.config.yaml defines site.title="${expected.siteTitle}". Run \`kinloom brandkit --out public\` to regenerate brandkit assets.`;
    } else if (manifestName && manifestName !== expected.expectedTitle) {
      driftMessage = `site.webmanifest name="${manifestName}" does not match expected title "${expected.expectedTitle}" from kinloom.config.yaml. Run \`kinloom brandkit --out public\` to regenerate brandkit assets.`;
    }
  }

  return {
    parseError: null,
    manifestName,
    manifestShortName,
    hasIcons,
    driftMessage,
  };
}

export function checkFaviconLightAccentDrift(
  svgBody: string,
  expected: ExpectedBrandkitProfile
): AccentDriftResult {
  const match = FAVICON_LIGHT_ACCENT_RE.exec(svgBody);
  const actualAccent = match?.[1]?.toUpperCase() ?? null;
  if (actualAccent && actualAccent !== expected.expectedAccent) {
    return {
      actualAccent,
      driftMessage: `favicon-light.svg uses accent ${actualAccent} while kinloom.config.yaml expects ${expected.expectedAccent}. Run \`kinloom brandkit --out public\` to regenerate brandkit assets.`,
    };
  }
  return { actualAccent, driftMessage: null };
}

export function checkServiceWorkerAccentDrift(
  swBody: string,
  expected: ExpectedBrandkitProfile
): AccentDriftResult {
  const match = SW_OFFLINE_ACCENT_RE.exec(swBody);
  const actualAccent = match?.[1]?.toUpperCase() ?? null;
  if (actualAccent && actualAccent !== expected.expectedAccent) {
    return {
      actualAccent,
      driftMessage: `sw.js offline notice uses accent ${actualAccent} while kinloom.config.yaml expects ${expected.expectedAccent}. Run \`kinloom brandkit --out public\` to regenerate brandkit assets.`,
    };
  }
  return { actualAccent, driftMessage: null };
}
