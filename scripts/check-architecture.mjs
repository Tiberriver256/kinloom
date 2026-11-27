#!/usr/bin/env node
/**
 * Automated CI architecture-invariants gate for Kinloom.
 * Exits non-zero with file:line diagnostics on any architectural violation.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function walkSourceFiles(rootRel, out = []) {
  const abs = path.join(ROOT_DIR, rootRel);
  if (!fs.existsSync(abs)) {
    return out;
  }
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.git') {
      continue;
    }
    const nextRel = path.join(rootRel, entry.name);
    if (entry.isDirectory()) {
      walkSourceFiles(nextRel, out);
    } else if (
      /\.(ts|tsx)$/.test(entry.name) &&
      !/\.(test|spec)\.(ts|tsx)$/.test(entry.name) &&
      !entry.name.endsWith('.d.ts')
    ) {
      out.push(nextRel.replaceAll(path.sep, '/'));
    }
  }
  return out;
}

/**
 * Replace comments with spaces (preserving newlines) and optionally blank string/template contents
 * so regex checks inspect executable code rather than prose comments or string literals.
 */
function maskSource(source, { blankStrings = false } = {}) {
  let out = '';
  let i = 0;
  const n = source.length;
  while (i < n) {
    const ch = source[i];
    const next = source[i + 1];
    if (ch === '/' && next === '/') {
      while (i < n && source[i] !== '\n') {
        out += ' ';
        i += 1;
      }
      continue;
    }
    if (ch === '/' && next === '*') {
      out += '  ';
      i += 2;
      while (i < n && !(source[i] === '*' && source[i + 1] === '/')) {
        out += source[i] === '\n' ? '\n' : ' ';
        i += 1;
      }
      if (i < n) {
        out += '  ';
        i += 2;
      }
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      out += quote;
      i += 1;
      while (i < n) {
        if (source[i] === '\\') {
          out += blankStrings ? '  ' : source[i] + (source[i + 1] ?? '');
          i += 2;
          continue;
        }
        if (source[i] === quote) {
          out += quote;
          i += 1;
          break;
        }
        out += blankStrings ? (source[i] === '\n' ? '\n' : ' ') : source[i];
        i += 1;
      }
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

function lineNumberAt(text, index) {
  let line = 1;
  for (let i = 0; i < index; i += 1) {
    if (text[i] === '\n') {
      line += 1;
    }
  }
  return line;
}

/**
 * Parse static `import` and `export ... from` specifiers with type-only distinction.
 */
function parseStaticModuleSpecifiers(rawSource) {
  const code = maskSource(rawSource, { blankStrings: false });
  const results = [];
  const stmtRe = /(?:^|[\n;{}])\s*(import|export)\s+(type\s+)?(?:[\s\S]*?\s+from\s+)?(['"])([^'"\n]+)\3/g;
  let match;
  while ((match = stmtRe.exec(code)) !== null) {
    const fullMatch = match[0];
    const kind = match[1];
    const isTypeStmt = Boolean(match[2]);
    const spec = match[4];
    const line = lineNumberAt(code, match.index + fullMatch.search(/\S/));
    // Also detect `import { type Foo, type Bar } from '...'` where every named binding is `type`.
    let isAllTypeNamed = isTypeStmt;
    if (!isAllTypeNamed) {
      const braceMatch = /\{([^}]*)\}/.exec(fullMatch);
      if (
        braceMatch &&
        !/\*\s+as\b/.test(fullMatch) &&
        !/^\s*(?:import|export)\s+[A-Za-z_$]/.test(fullMatch.trim())
      ) {
        const items = braceMatch[1]
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
        if (items.length > 0 && items.every((item) => /^type\s+/.test(item))) {
          isAllTypeNamed = true;
        }
      }
    }
    results.push({ kind, spec, isTypeOnly: isAllTypeNamed, line });
  }
  return results;
}

/**
 * Parse dynamic `import('...')` specifiers with string-literal arguments.
 */
function parseDynamicModuleSpecifiers(rawSource) {
  const code = maskSource(rawSource, { blankStrings: false });
  const results = [];
  const dynRe = /\bimport\s*\(\s*(['"])([^'"\n]+)\1\s*\)/g;
  let match;
  while ((match = dynRe.exec(code)) !== null) {
    const spec = match[2];
    const line = lineNumberAt(code, match.index);
    results.push({ kind: 'dynamic-import', spec, isTypeOnly: false, line });
  }
  return results;
}

function resolveRelativeTsFile(fromRel, spec, fileSet) {
  if (!spec.startsWith('.')) {
    return null;
  }
  const fromDir = path.dirname(path.join(ROOT_DIR, fromRel));
  const rawAbs = path.resolve(fromDir, spec);
  const stripped = rawAbs.replace(/\.(?:js|jsx|mjs|cjs)$/, '');
  const candidates = [
    rawAbs,
    `${stripped}.ts`,
    `${stripped}.tsx`,
    path.join(stripped, 'index.ts'),
    path.join(stripped, 'index.tsx'),
  ];
  for (const cand of candidates) {
    const rel = path.relative(ROOT_DIR, cand).replaceAll(path.sep, '/');
    if (fileSet.has(rel)) {
      return rel;
    }
  }
  return null;
}

function findTarjanSccs(nodes, adj) {
  let index = 0;
  const indices = new Map();
  const lowlink = new Map();
  const onStack = new Set();
  const stack = [];
  const sccs = [];

  function strongConnect(v) {
    indices.set(v, index);
    lowlink.set(v, index);
    index += 1;
    stack.push(v);
    onStack.add(v);

    for (const w of adj.get(v) ?? []) {
      if (!indices.has(w)) {
        strongConnect(w);
        lowlink.set(v, Math.min(lowlink.get(v), lowlink.get(w)));
      } else if (onStack.has(w)) {
        lowlink.set(v, Math.min(lowlink.get(v), indices.get(w)));
      }
    }

    if (lowlink.get(v) === indices.get(v)) {
      const comp = [];
      while (true) {
        const w = stack.pop();
        onStack.delete(w);
        comp.push(w);
        if (w === v) {
          break;
        }
      }
      if (comp.length > 1) {
        sccs.push(comp.toSorted());
      }
    }
  }

  for (const v of nodes) {
    if (!indices.has(v)) {
      strongConnect(v);
    }
  }
  return sccs;
}

const packageFiles = walkSourceFiles('packages');
const demoFiles = walkSourceFiles('examples/demo/src');
const allCheckedFiles = [...packageFiles, ...demoFiles];
const packageFileSet = new Set(packageFiles);

const sourceCache = new Map();
const importsCache = new Map();
const dynamicImportsCache = new Map();

for (const file of allCheckedFiles) {
  const raw = fs.readFileSync(path.join(ROOT_DIR, file), 'utf8');
  sourceCache.set(file, raw);
  importsCache.set(file, parseStaticModuleSpecifiers(raw));
  dynamicImportsCache.set(file, parseDynamicModuleSpecifiers(raw));
}

const violations = [];
function addViolation(rule, file, line, message) {
  violations.push({ rule, file, line, message });
}

// ---------------------------------------------------------------------------
// Invariant 1: 0 runtime, 0 type-inclusive, AND 0 dynamic-import circular imports (Tarjan SCC)
// ---------------------------------------------------------------------------
const typeInclusiveAdj = new Map();
const runtimeOnlyAdj = new Map();
const dynamicInclusiveAdj = new Map();
for (const file of packageFiles) {
  const allTargets = new Set();
  const runtimeTargets = new Set();
  const dynamicTargets = new Set();
  for (const imp of importsCache.get(file)) {
    const resolved = resolveRelativeTsFile(file, imp.spec, packageFileSet);
    if (!resolved || resolved === file) {
      continue;
    }
    allTargets.add(resolved);
    dynamicTargets.add(resolved);
    if (!imp.isTypeOnly) {
      runtimeTargets.add(resolved);
    }
  }
  for (const dyn of dynamicImportsCache.get(file)) {
    const resolved = resolveRelativeTsFile(file, dyn.spec, packageFileSet);
    if (!resolved || resolved === file) {
      continue;
    }
    dynamicTargets.add(resolved);
  }
  typeInclusiveAdj.set(file, [...allTargets]);
  runtimeOnlyAdj.set(file, [...runtimeTargets]);
  dynamicInclusiveAdj.set(file, [...dynamicTargets]);
}

const runtimeSccs = findTarjanSccs(packageFiles, runtimeOnlyAdj);
for (const scc of runtimeSccs) {
  addViolation(
    'no-circular-imports-runtime',
    scc[0],
    1,
    `Runtime circular import SCC (${scc.length} files): ${scc.join(' <-> ')}`
  );
}

const typeSccs = findTarjanSccs(packageFiles, typeInclusiveAdj);
for (const scc of typeSccs) {
  addViolation(
    'no-circular-imports-type-inclusive',
    scc[0],
    1,
    `Type-inclusive circular import SCC (${scc.length} files): ${scc.join(' <-> ')}`
  );
}

const dynamicSccs = findTarjanSccs(packageFiles, dynamicInclusiveAdj);
for (const scc of dynamicSccs) {
  addViolation(
    'no-circular-imports-dynamic',
    scc[0],
    1,
    `Dynamic-import circular import SCC (${scc.length} files): ${scc.join(' <-> ')}`
  );
}

// ---------------------------------------------------------------------------
// Invariant 2: 0 reverse-layer imports
// ---------------------------------------------------------------------------
const SHARED_OPS_OWNERS = new Set([
  'index',
  'help',
  'telemetry',
  'shared',
  'livingnamematcher',
  'pronunciationchecks',
  'treehygiene',
]);

function normalizeOpsCommandOwner(relUnderOps) {
  const seg = relUnderOps.split('/')[0].replace(/\.ts$/, '');
  const norm = seg.replaceAll('-', '').toLowerCase();
  if (norm === 'auditoverlaps') return 'audit';
  if (norm === 'integratebatch') return 'integrate';
  if (norm === 'mediadedupe') return 'mediadedupe';
  return norm;
}

for (const file of packageFiles) {
  const imports = importsCache.get(file);

  // 2a. packages/server/src/services/** -> adapters/**
  if (file.startsWith('packages/server/src/services/')) {
    for (const imp of imports) {
      if (/(?:^|\/)adapters(?:\/|$)/.test(imp.spec)) {
        addViolation(
          'no-reverse-layer-server',
          file,
          imp.line,
          `Server service must not import adapter '${imp.spec}'.`
        );
      }
    }
  }

  // 2b. packages/ui/src/components/** -> pages/*.module.css
  if (file.startsWith('packages/ui/src/components/')) {
    for (const imp of imports) {
      if (/(?:^|\/)pages\/.*\.module\.css$/.test(imp.spec)) {
        addViolation(
          'no-reverse-layer-ui-css',
          file,
          imp.line,
          `UI component must not import page CSS module '${imp.spec}'.`
        );
      }
    }
  }

  // 2c. packages/cli/src/commands/ops/** peer-command & shared-layer directionality
  if (
    file.startsWith('packages/cli/src/commands/ops/') &&
    file !== 'packages/cli/src/commands/ops/index.ts'
  ) {
    const relFromOps = file.slice('packages/cli/src/commands/ops/'.length);
    const ownerFrom = normalizeOpsCommandOwner(relFromOps);
    const isFromSharedDir = file.startsWith('packages/cli/src/commands/ops/shared/');
    const allOpsImports = [...imports, ...dynamicImportsCache.get(file)];
    for (const imp of allOpsImports) {
      const resolved = resolveRelativeTsFile(file, imp.spec, packageFileSet);
      if (!resolved?.startsWith('packages/cli/src/commands/ops/')) {
        continue;
      }
      const relToOps = resolved.slice('packages/cli/src/commands/ops/'.length);
      const ownerTo = normalizeOpsCommandOwner(relToOps);
      if (isFromSharedDir) {
        if (ownerTo !== 'shared') {
          addViolation(
            'no-peer-ops-imports',
            file,
            imp.line,
            `CLI shared ops module must not import peer ops command '${ownerTo}' via '${imp.spec}'; keep dependencies inside commands/ops/shared/.`
          );
        }
        continue;
      }
      if (ownerTo !== ownerFrom && !SHARED_OPS_OWNERS.has(ownerTo)) {
        addViolation(
          'no-peer-ops-imports',
          file,
          imp.line,
          `CLI ops command '${ownerFrom}' must not import peer ops command '${ownerTo}' via '${imp.spec}'; extract shared logic to commands/ops/shared/.`
        );
      }
    }
  }

  // 2d. packages/core/src/** -> server / worker / ui / cli / oxlint
  if (file.startsWith('packages/core/src/')) {
    for (const imp of imports) {
      if (
        /^@kinloom\/(?:server|worker|ui|cli)(?:\/|$)/.test(imp.spec) ||
        /\boxlint\b/.test(imp.spec) ||
        /(?:^|\/)packages\/(?:server|worker|ui|cli)(?:\/|$)/.test(imp.spec)
      ) {
        addViolation(
          'no-reverse-layer-core',
          file,
          imp.line,
          `@kinloom/core must not depend on '${imp.spec}'.`
        );
      }
    }
  }

  // 2e. packages/server/src/** -> worker / ui / cli
  if (file.startsWith('packages/server/src/')) {
    for (const imp of imports) {
      if (
        /^@kinloom\/(?:worker|ui|cli)(?:\/|$)/.test(imp.spec) ||
        /(?:^|\/)packages\/(?:worker|ui|cli)(?:\/|$)/.test(imp.spec)
      ) {
        addViolation(
          'no-reverse-layer-server-pkg',
          file,
          imp.line,
          `@kinloom/server must not depend on '${imp.spec}'.`
        );
      }
    }
  }

  // 2f. packages/ui/src/(machines|components|pages)/** -> adapters/**
  if (/^packages\/ui\/src\/(?:machines|components|pages)\//.test(file)) {
    for (const imp of imports) {
      if (/(?:^|\/)adapters(?:\/|$)/.test(imp.spec)) {
        addViolation(
          'no-ui-adapter-leak',
          file,
          imp.line,
          `UI layer '${file}' must depend on @kinloom/core ports rather than importing adapter '${imp.spec}'.`
        );
      }
    }
  }

  // 2g. Zero cross-page *.module.css imports (pages/* or KinloomApp.tsx -> BarPage.module.css)
  if (file === 'packages/ui/src/KinloomApp.tsx' || file.startsWith('packages/ui/src/pages/')) {
    const pageOwnerStem = (() => {
      if (file === 'packages/ui/src/KinloomApp.tsx') {
        return null;
      }
      const rel = file.slice('packages/ui/src/pages/'.length);
      if (!rel.includes('/')) {
        return rel.replace(/\.(ts|tsx)$/, '').toLowerCase();
      }
      return `${rel.split('/')[0].toLowerCase()}page`;
    })();
    for (const imp of imports) {
      if (!imp.spec.endsWith('.module.css')) {
        continue;
      }
      const cssAbs = path.resolve(path.dirname(path.join(ROOT_DIR, file)), imp.spec);
      const cssRel = path.relative(ROOT_DIR, cssAbs).replaceAll(path.sep, '/');
      if (!cssRel.startsWith('packages/ui/src/pages/')) {
        continue;
      }
      const cssSubRel = cssRel.slice('packages/ui/src/pages/'.length);
      const cssBaseStem = path.basename(cssSubRel, '.module.css').toLowerCase();
      if (file === 'packages/ui/src/KinloomApp.tsx') {
        addViolation(
          'no-cross-page-css-import',
          file,
          imp.line,
          `KinloomApp must not import page CSS module '${imp.spec}'; use styles/Layout.module.css.`
        );
        continue;
      }
      if (!cssSubRel.includes('/') && cssBaseStem.endsWith('page') && cssBaseStem !== pageOwnerStem) {
        addViolation(
          'no-cross-page-css-import',
          file,
          imp.line,
          `Page module '${file}' must not import another page CSS module '${imp.spec}'; extract shared styles to styles/.`
        );
      }
    }
  }

  // 2h. packages/ui/src/components/atoms/** -> *Drawer.module.css
  if (file.startsWith('packages/ui/src/components/atoms/')) {
    for (const imp of imports) {
      if (/Drawer\.module\.css$/.test(imp.spec)) {
        addViolation(
          'no-atom-drawer-css-import',
          file,
          imp.line,
          `UI atom '${file}' must not import drawer CSS module '${imp.spec}'; extract shared styles to styles/.`
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Invariant 3: Pure packages/ui/src/lib/** and *ViewModel.ts boundaries
// ---------------------------------------------------------------------------
const FORBIDDEN_UI_PURE_IMPORTS = /^(?:react|react-dom|maplibre-gl)(?:\/|$)/;
const FORBIDDEN_BROWSER_GLOBALS_RE = /\b(?:window|document|navigator|fetch)\b/g;

for (const file of packageFiles) {
  if (
    !file.startsWith('packages/ui/src/lib/') &&
    !(file.startsWith('packages/ui/src/') && file.endsWith('ViewModel.ts'))
  ) {
    continue;
  }
  for (const imp of importsCache.get(file)) {
    if (FORBIDDEN_UI_PURE_IMPORTS.test(imp.spec)) {
      addViolation(
        'pure-ui-model-imports',
        file,
        imp.line,
        `Pure UI lib/view-model must not import '${imp.spec}'.`
      );
    }
  }
  const masked = maskSource(sourceCache.get(file), { blankStrings: true });
  let m;
  FORBIDDEN_BROWSER_GLOBALS_RE.lastIndex = 0;
  while ((m = FORBIDDEN_BROWSER_GLOBALS_RE.exec(masked)) !== null) {
    // Ignore property access like `foo.document` or object property keys like `document: ...`.
    const before = masked.slice(Math.max(0, m.index - 2), m.index);
    const after = masked.slice(m.index + m[0].length, m.index + m[0].length + 2);
    if (before.endsWith('.') || /^\s*:/.test(after)) {
      continue;
    }
    addViolation(
      'pure-ui-model-globals',
      file,
      lineNumberAt(masked, m.index),
      `Pure UI lib/view-model must not reference browser global '${m[0]}'.`
    );
  }
}

// ---------------------------------------------------------------------------
// Invariant 4: 0 instanceof HttpWikiDataSource & 0 multi-CSS-module spreads in packages/ui/src/**
// ---------------------------------------------------------------------------
for (const file of packageFiles) {
  if (!file.startsWith('packages/ui/src/')) {
    continue;
  }
  const masked = maskSource(sourceCache.get(file), { blankStrings: true });
  const instRe = /\binstanceof\s+HttpWikiDataSource\b/g;
  let m;
  while ((m = instRe.exec(masked)) !== null) {
    addViolation(
      'no-instanceof-http-datasource',
      file,
      lineNumberAt(masked, m.index),
      'UI must depend on ArchiveDataSource / AdminDataSource ports rather than `instanceof HttpWikiDataSource`.'
    );
  }

  const spreadRe = /\{\s*\.\.\.[A-Za-z0-9_$]*[Ss]tyles\s*,\s*\.\.\.[A-Za-z0-9_$]*[Ss]tyles\b/g;
  while ((m = spreadRe.exec(masked)) !== null) {
    addViolation(
      'no-css-module-spread',
      file,
      lineNumberAt(masked, m.index),
      'Do not merge multiple CSS modules with `{ ...aStyles, ...bStyles }`; reference owning CSS module classes directly.'
    );
  }

  // 4c. Zero raw fetch/sendBeacon targeting api/ URLs outside packages/ui/src/adapters/**
  if (!file.startsWith('packages/ui/src/adapters/')) {
    const codeWithStrings = maskSource(sourceCache.get(file), { blankStrings: false });
    const rawApiTransportRe = /\b(?:fetch|sendBeacon)\s*\(\s*(['"`])(?:[^'"`\n]*?\/)?api\//g;
    while ((m = rawApiTransportRe.exec(codeWithStrings)) !== null) {
      addViolation(
        'no-raw-ui-api-fetch',
        file,
        lineNumberAt(codeWithStrings, m.index),
        'UI modules outside adapters/ must not call raw `fetch` or `navigator.sendBeacon` against `api/` URLs; route HTTP I/O through ArchiveDataSource or injectable transport.'
      );
    }
    if (/\b(?:fetch|sendBeacon)\s*\(/.test(masked)) {
      const apiUrlBuilderRe = /(['"`])(?:[^'"`\n]*?(?:\/|\$\{[^}]+\}))?api\/[A-Za-z0-9_-]+/g;
      while ((m = apiUrlBuilderRe.exec(codeWithStrings)) !== null) {
        addViolation(
          'no-raw-ui-api-fetch',
          file,
          lineNumberAt(codeWithStrings, m.index),
          'UI modules outside adapters/ calling `fetch` or `sendBeacon` must not construct hardcoded `api/` URLs; inject endpoint/transport or route through ArchiveDataSource.'
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Invariant 5: 0 any, @ts-ignore, @ts-expect-error, as unknown as, eslint-disable
// ---------------------------------------------------------------------------
const CODE_ESCAPE_RULES = [
  [
    'no-as-unknown-as',
    /\bas\s+unknown\s+as\b/g,
    'Disallowed `as unknown as` cast; parse at the boundary instead.',
  ],
  [
    'no-explicit-any',
    /(?::\s*any\b|\bas\s+any\b|<any>|Array<any>|\bany\[\])/g,
    'Disallowed explicit `any` type; use `unknown` or a concrete type.',
  ],
];
const COMMENT_ESCAPE_RULES = [
  ['no-ts-ignore', /@ts-ignore\b/g, 'Disallowed `@ts-ignore` directive.'],
  ['no-ts-expect-error', /@ts-expect-error\b/g, 'Disallowed `@ts-expect-error` directive.'],
  ['no-ts-nocheck', /@ts-nocheck\b/g, 'Disallowed `@ts-nocheck` directive.'],
  ['no-eslint-disable', /eslint-disable/g, 'Disallowed `eslint-disable` directive.'],
];

for (const file of allCheckedFiles) {
  const raw = sourceCache.get(file);
  const masked = maskSource(raw, { blankStrings: true });
  for (const [rule, re, msg] of CODE_ESCAPE_RULES) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(masked)) !== null) {
      addViolation(rule, file, lineNumberAt(masked, m.index), msg);
    }
  }
  for (const [rule, re, msg] of COMMENT_ESCAPE_RULES) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(raw)) !== null) {
      addViolation(rule, file, lineNumberAt(raw, m.index), msg);
    }
  }
}

// ---------------------------------------------------------------------------
// Invariant 6: 0 static imports of record clients inside records/registry.ts
// ---------------------------------------------------------------------------
const REGISTRY_FILE = 'packages/cli/src/commands/records/registry.ts';
if (importsCache.has(REGISTRY_FILE)) {
  for (const imp of importsCache.get(REGISTRY_FILE)) {
    if (!imp.isTypeOnly && imp.spec.startsWith('./') && imp.spec.endsWith('.js')) {
      addViolation(
        'lazy-record-registry',
        REGISTRY_FILE,
        imp.line,
        `Record registry must lazy-load clients via dynamic import(); found static import '${imp.spec}'.`
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Invariant 7: 0 ambient new Date() in packages/core/src/privacy.ts & privacy/**
// ---------------------------------------------------------------------------
for (const file of packageFiles) {
  if (file !== 'packages/core/src/privacy.ts' && !file.startsWith('packages/core/src/privacy/')) {
    continue;
  }
  const masked = maskSource(sourceCache.get(file), { blankStrings: true });
  const dateRe = /\bnew\s+Date\s*\(/g;
  let m;
  while ((m = dateRe.exec(masked)) !== null) {
    addViolation(
      'no-ambient-date-in-privacy',
      file,
      lineNumberAt(masked, m.index),
      'Privacy module must not call `new Date()`; accept an explicit `referenceYear` instead.'
    );
  }
}

if (violations.length > 0) {
  console.error(`Architecture check FAILED with ${violations.length} violation(s):\n`);
  for (const v of violations) {
    console.error(`  [${v.rule}] ${v.file}:${v.line}: ${v.message}`);
  }
  process.exit(1);
}

console.log(
  `Architecture check PASSED (0 violations across ${allCheckedFiles.length} non-test TS/TSX files: ` +
    `0 runtime cycles, 0 type cycles, 0 dynamic-import cycles, 0 reverse-layer/adapter/cross-page-CSS/atom-drawer-CSS imports, ` +
    `0 raw UI /api/ fetch or sendBeacon calls, 0 pure-UI leaks, 0 escape hatches, 0 eager record-client imports, 0 ambient Date in privacy).`
);
