/**
 * Standard SemVer conventional commits, including on 0.x.
 * BREAKING CHANGE or type!: major, so 0.2.0 becomes 1.0.0.
 * feat: minor, so 0.2.0 becomes 0.3.0.
 * fix, perf, and revert: patch, so 0.2.0 becomes 0.2.1.
 * chore, docs, test, ci, refactor, style, and any other type: no release.
 * --bump patch|minor|major and --force-version replace that calculation.
 *
 * https://www.conventionalcommits.org/en/v1.0.0/
 * https://semver.org/
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const GIT_FORMAT = '%H%x1f%h%x1f%an%x1f%ae%x1f%s%x1f%b%x1e';
const DEP_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];
const BUMPS = new Set(['auto', 'patch', 'minor', 'major']);
const LEVEL_RANK = { none: 0, patch: 1, minor: 2, major: 3 };

const SOURCE_RULES = [
  {
    path: 'packages/server/src/index.ts',
    pattern: /export const KINLOOM_SERVER_VERSION = '(\d+\.\d+\.\d+)';/g,
    replace(version) {
      return `export const KINLOOM_SERVER_VERSION = '${version}';`;
    },
  },
  {
    path: 'packages/worker/src/index.ts',
    pattern: /export const KINLOOM_WORKER_VERSION = '(\d+\.\d+\.\d+)';/g,
    replace(version) {
      return `export const KINLOOM_WORKER_VERSION = '${version}';`;
    },
  },
  {
    path: 'packages/cli/src/client.ts',
    pattern: /kinloom-cli\/(\d+\.\d+\.\d+)/g,
    replace(version) {
      return `kinloom-cli/${version}`;
    },
  },
];

const CATEGORY_TITLES = [
  ['breaking', 'Breaking Changes'],
  ['features', 'Features'],
  ['fixes', 'Bug Fixes'],
  ['performance', 'Performance'],
  ['other', 'Other'],
];

function assertSemver(version) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`Version must be x.y.z, received ${version}`);
  }
}

function normalizeVersion(input) {
  const version = input.startsWith('v') ? input.slice(1) : input;
  assertSemver(version);
  return version;
}

function compareSemver(left, right) {
  const a = left.split('.').map(Number);
  const b = right.split('.').map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  }
  return 0;
}

export function nextVersion(current, level) {
  assertSemver(current);
  const [major, minor, patch] = current.split('.').map(Number);
  if (level === 'major') return `${major + 1}.0.0`;
  if (level === 'minor') return `${major}.${minor + 1}.0`;
  if (level === 'patch') return `${major}.${minor}.${patch + 1}`;
  throw new Error(`Cannot bump level ${level}`);
}

export function parseCommitMessage(subject, body = '') {
  const match = /^(?<type>[A-Za-z]+)(?:\((?<scope>[^)]*)\))?(?<bang>!)?: (?<description>.+)$/.exec(
    subject.trim()
  );
  const breakingFooter = /^BREAKING[ -]CHANGE:/im.test(body);
  if (!match) {
    return {
      type: null,
      scope: null,
      subject: subject.trim(),
      breaking: breakingFooter,
      level: breakingFooter ? 'major' : 'none',
    };
  }
  const type = match.groups.type.toLowerCase();
  const breaking = Boolean(match.groups.bang) || breakingFooter;
  let level = 'none';
  if (breaking) level = 'major';
  else if (type === 'feat') level = 'minor';
  else if (type === 'fix' || type === 'perf' || type === 'revert') level = 'patch';
  return {
    type,
    scope: match.groups.scope ?? null,
    subject: match.groups.description.trim(),
    breaking,
    level,
  };
}

function categoryFor(parsed) {
  if (parsed.breaking) return 'breaking';
  if (parsed.type === 'feat') return 'features';
  if (parsed.type === 'fix' || parsed.type === 'revert') return 'fixes';
  if (parsed.type === 'perf') return 'performance';
  return 'other';
}

export function classifyCommit(commit) {
  const parsed = parseCommitMessage(commit.subject, commit.body ?? '');
  return {
    sha: commit.sha,
    shortSha: commit.shortSha,
    authorName: commit.authorName,
    type: parsed.type,
    scope: parsed.scope,
    subject: parsed.subject,
    breaking: parsed.breaking,
    level: parsed.level,
    category: categoryFor(parsed),
  };
}

export function parseGitLog(raw) {
  const commits = [];
  for (const record of raw.split('\x1e')) {
    const trimmed = record.trim();
    if (!trimmed) continue;
    const [sha, shortSha, authorName, , subject, body = ''] = trimmed.split('\x1f');
    if (!sha || !subject || subject.startsWith('Merge ')) continue;
    commits.push(classifyCommit({ sha, shortSha, authorName, subject, body }));
  }
  return commits;
}

export function renderNotes(commits) {
  const sections = [];
  for (const [key, title] of CATEGORY_TITLES) {
    const rows = commits.filter((commit) => commit.category === key);
    if (rows.length === 0) continue;
    const lines = [`## ${title}`, ''];
    for (const commit of rows) {
      const scope = commit.scope ? `**${commit.scope}:** ` : '';
      lines.push(`* ${scope}${commit.subject} (${commit.shortSha}) by ${commit.authorName}`);
    }
    sections.push(lines.join('\n'));
  }
  return sections.join('\n\n');
}

export function planRelease({ current, commits, bump = 'auto', forceVersion = null }) {
  assertSemver(current);
  if (!BUMPS.has(bump)) throw new Error(`Unknown bump ${bump}`);
  if (forceVersion) {
    const version = normalizeVersion(forceVersion);
    const order = compareSemver(version, current);
    if (order < 0) throw new Error(`force-version ${version} is not newer than ${current}`);
    if (order === 0) {
      return {
        shouldRelease: false,
        version: null,
        tag: null,
        bump: null,
        reason: 'force-version matches current',
      };
    }
    return { shouldRelease: true, version, tag: `v${version}`, bump: null, reason: 'force-version' };
  }
  if (bump !== 'auto') {
    const version = nextVersion(current, bump);
    return { shouldRelease: true, version, tag: `v${version}`, bump, reason: `explicit ${bump}` };
  }
  const level = commits.reduce((highest, commit) => {
    return LEVEL_RANK[commit.level] > LEVEL_RANK[highest] ? commit.level : highest;
  }, 'none');
  if (level === 'none') {
    return {
      shouldRelease: false,
      version: null,
      tag: null,
      bump: null,
      reason: 'no releasable commits',
    };
  }
  const version = nextVersion(current, level);
  return {
    shouldRelease: true,
    version,
    tag: `v${version}`,
    bump: level,
    reason: `conventional ${level}`,
  };
}

export function buildReleaseNotes({ notesMarkdown, logins = [], compareUrl = '', generatedBody = '' }) {
  const parts = [];
  if (notesMarkdown.trim()) parts.push(notesMarkdown.trim());
  const safeLogins = [
    ...new Set(logins.filter((login) => /^[A-Za-z0-9][A-Za-z0-9-]*(\[bot\])?$/.test(login))),
  ].sort();
  if (safeLogins.length > 0) {
    parts.push(['## GitHub contributors', '', ...safeLogins.map((login) => `* @${login}`)].join('\n'));
  }
  if (compareUrl) parts.push(`**Full Changelog**: ${compareUrl}`);
  if (generatedBody.trim()) parts.push(generatedBody.trim());
  return parts.length === 0 ? '' : `${parts.join('\n\n')}\n`;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function rewriteKinloomRange(range, version) {
  const match = /^([\^~])?(\d+\.\d+\.\d+)$/.exec(range);
  if (!match) return range;
  return `${match[1] ?? ''}${version}`;
}

export function rewritePackageJson(text, version) {
  assertSemver(version);
  const data = JSON.parse(text);
  const versionPattern = /("version"\s*:\s*")\d+\.\d+\.\d+(")/;
  if (!versionPattern.test(text)) throw new Error('package.json is missing a version');
  let next = text.replace(versionPattern, `$1${version}$2`);
  for (const field of DEP_FIELDS) {
    const deps = data[field];
    if (!deps) continue;
    for (const [name, range] of Object.entries(deps)) {
      if (!name.startsWith('@kinloom/')) continue;
      const updated = rewriteKinloomRange(range, version);
      if (updated === range) continue;
      const pattern = new RegExp(
        `(${escapeRegExp(JSON.stringify(name))}\\s*:\\s*")${escapeRegExp(range)}(")`
      );
      if (!pattern.test(next)) throw new Error(`missing dependency ${name}`);
      next = next.replace(pattern, `$1${updated}$2`);
    }
  }
  return next;
}

function sourceMatches(text, rule) {
  return [...text.matchAll(new RegExp(rule.pattern.source, 'g'))];
}

export function rewriteSource(text, rule, version) {
  assertSemver(version);
  const matches = sourceMatches(text, rule);
  if (matches.length !== 1) {
    throw new Error(`${rule.path} contains ${matches.length} version markers`);
  }
  return text.replace(new RegExp(rule.pattern.source), rule.replace(version));
}

export function readSourceVersion(text, rule) {
  const matches = sourceMatches(text, rule);
  if (matches.length !== 1) return null;
  return matches[0][1];
}

export function listPackageJsons(root) {
  const packagesDir = path.join(root, 'packages');
  const rels = fs
    .readdirSync(packagesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => `packages/${entry.name}/package.json`)
    .filter((rel) => fs.existsSync(path.join(root, rel)))
    .sort();
  const demo = 'examples/demo/package.json';
  if (!fs.existsSync(path.join(root, demo))) throw new Error(`missing ${demo}`);
  return [...rels, demo];
}

export const SOURCE_PATHS = SOURCE_RULES.map((rule) => rule.path);

function kinloomBareVersion(range) {
  const match = /^([\^~])?(\d+\.\d+\.\d+)$/.exec(range);
  return match ? match[2] : null;
}

export function verifyRelease(root, version) {
  assertSemver(version);
  const mismatches = [];
  for (const rel of listPackageJsons(root)) {
    const json = JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8'));
    if (json.version !== version) mismatches.push(`${rel} version is ${json.version}`);
    for (const field of DEP_FIELDS) {
      for (const [name, range] of Object.entries(json[field] ?? {})) {
        if (!name.startsWith('@kinloom/')) continue;
        const bare = kinloomBareVersion(range);
        if (bare !== version) mismatches.push(`${rel} ${name} is ${range}`);
      }
    }
  }
  for (const rule of SOURCE_RULES) {
    const text = fs.readFileSync(path.join(root, rule.path), 'utf8');
    const found = readSourceVersion(text, rule);
    if (found !== version) mismatches.push(`${rule.path} version is ${found ?? 'missing'}`);
  }
  return mismatches;
}

export function applyVersionFiles(root, version) {
  assertSemver(version);
  for (const rel of listPackageJsons(root)) {
    const full = path.join(root, rel);
    const next = rewritePackageJson(fs.readFileSync(full, 'utf8'), version);
    fs.writeFileSync(full, next);
  }
  for (const rule of SOURCE_RULES) {
    const full = path.join(root, rule.path);
    const next = rewriteSource(fs.readFileSync(full, 'utf8'), rule, version);
    fs.writeFileSync(full, next);
  }
}

function discoverTag(cwd) {
  try {
    return execFileSync('git', ['describe', '--tags', '--abbrev=0', '--match', 'v*'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

function versionFromTag(tag) {
  const match = /^v(\d+\.\d+\.\d+)$/.exec(tag);
  return match ? match[1] : null;
}

function loadCommits(cwd, fromTag) {
  const raw = execFileSync('git', ['log', `${fromTag}..HEAD`, '--reverse', `--format=${GIT_FORMAT}`], {
    cwd,
    encoding: 'utf8',
  });
  return parseGitLog(raw);
}

function releasePayload(cwd, flags) {
  const fromTag = flags['from-tag'] || discoverTag(cwd);
  if (!fromTag) throw new Error('No v* tag found. Pass --from-tag.');
  const current = versionFromTag(fromTag);
  if (!current) throw new Error(`Tag ${fromTag} is not vX.Y.Z`);
  const commits = loadCommits(cwd, fromTag);
  const plan = planRelease({
    current,
    commits,
    bump: flags.bump ?? 'auto',
    forceVersion: flags['force-version'] ?? null,
  });
  return {
    should_release: plan.shouldRelease,
    version: plan.version,
    tag: plan.tag,
    previous_tag: fromTag,
    previous_version: current,
    bump: plan.bump,
    reason: plan.reason,
    policy: 'standard-semver',
    notes_markdown: renderNotes(commits),
    commits: commits.map((commit) => ({
      sha: commit.sha,
      short_sha: commit.shortSha,
      author_name: commit.authorName,
      type: commit.type,
      scope: commit.scope,
      subject: commit.subject,
      breaking: commit.breaking,
      category: commit.category,
    })),
  };
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (!command) throw new Error('Usage: release-version.mjs <next|bump|verify|notes> [options]');
  const flags = {};
  const positionals = [];
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === '--json') {
      flags.json = true;
      continue;
    }
    if (arg.startsWith('--')) {
      const value = rest[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`Missing value for ${arg}`);
      flags[arg.slice(2)] = value;
      index += 1;
      continue;
    }
    positionals.push(arg);
  }
  return { command, flags, positionals };
}

function commandNotes(flags) {
  if (!flags.plan || !flags.out) throw new Error('notes requires --plan and --out');
  const plan = JSON.parse(fs.readFileSync(flags.plan, 'utf8'));
  const logins = flags['logins-file'] ? fs.readFileSync(flags['logins-file'], 'utf8').split(/\r?\n/) : [];
  const generatedBody =
    flags['generated-file'] && fs.existsSync(flags['generated-file'])
      ? fs.readFileSync(flags['generated-file'], 'utf8')
      : '';
  const body = buildReleaseNotes({
    notesMarkdown: plan.notes_markdown ?? '',
    logins,
    compareUrl: flags['compare-url'] ?? '',
    generatedBody,
  });
  fs.writeFileSync(flags.out, body);
}

function main() {
  const { command, flags, positionals } = parseArgs(process.argv.slice(2));
  const cwd = process.cwd();
  if (command === 'next') {
    const payload = releasePayload(cwd, flags);
    if (flags.json) console.log(JSON.stringify(payload, null, 2));
    else {
      console.log(`should_release: ${payload.should_release}`);
      console.log(`version: ${payload.version ?? ''}`);
      console.log(`tag: ${payload.tag ?? ''}`);
      console.log(`reason: ${payload.reason}`);
      if (payload.notes_markdown) console.log(`\n${payload.notes_markdown}`);
    }
    return;
  }
  if (command === 'bump') {
    const version = normalizeVersion(positionals[0] ?? '');
    applyVersionFiles(cwd, version);
    const result = spawnSync('npm', ['install', '--package-lock-only', '--ignore-scripts'], {
      cwd,
      stdio: 'inherit',
    });
    if (result.status !== 0) process.exit(result.status ?? 1);
    console.log(`bumped version files to ${version}`);
    return;
  }
  if (command === 'verify') {
    const version = normalizeVersion(positionals[0] ?? '');
    const mismatches = verifyRelease(cwd, version);
    if (mismatches.length > 0) {
      for (const line of mismatches) console.error(line);
      process.exit(1);
    }
    console.log(`versions match ${version}`);
    return;
  }
  if (command === 'notes') {
    commandNotes(flags);
    return;
  }
  throw new Error(`Unknown command ${command}`);
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
