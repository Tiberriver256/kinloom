#!/usr/bin/env node
/**
 * Documentation integrity gate for Kinloom:
 * 1. Verifies relative Markdown links and #heading-anchor targets across README.md, CONTRIBUTING.md, and docs/**\/*.md.
 * 2. Enforces synthetic email domains across docs/**\/*.md.
 * 3. With --typecheck-snippets, extracts `ts kinloom-check` / `tsx kinloom-check` fenced code blocks
 *    from docs/developers/*.md and verifies them with `tsc --noEmit` against workspace builds.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const ALLOWED_DOC_EMAIL_DOMAINS = new Set([
  'archive.example',
  'archive.example.test',
  'example.com',
  'example.org',
  'users.noreply.github.com',
]);

const EXTERNAL_SCHEME_RE = /^(?:https?|mailto|tel|data|javascript):/i;
const EMAIL_RE =
  /(?<![A-Za-z0-9._%+-/])([A-Za-z0-9._%+-]+)@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})\b/g;

function normalizePosix(relPath) {
  return relPath.replaceAll(path.sep, '/');
}

function walkMarkdownFiles(rootDir, relDir, out = []) {
  const absDir = path.join(rootDir, relDir);
  if (!fs.existsSync(absDir)) {
    return out;
  }
  for (const entry of fs.readdirSync(absDir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist') {
      continue;
    }
    const nextRel = path.join(relDir, entry.name);
    if (entry.isDirectory()) {
      walkMarkdownFiles(rootDir, nextRel, out);
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      out.push(normalizePosix(nextRel));
    }
  }
  return out;
}

export function collectCheckedDocFiles(rootDir = DEFAULT_ROOT) {
  const files = [];
  for (const topFile of ['README.md', 'CONTRIBUTING.md']) {
    if (fs.existsSync(path.join(rootDir, topFile))) {
      files.push(topFile);
    }
  }
  files.push(...walkMarkdownFiles(rootDir, 'docs').toSorted());
  return files;
}

function parseFenceOpen(line) {
  const match = /^\s*(`{3,}|~{3,})(.*)$/.exec(line);
  if (!match) {
    return null;
  }
  const marker = match[1];
  const info = match[2].trim();
  if (marker[0] === '`' && info.includes('`')) {
    return null;
  }
  return { char: marker[0], length: marker.length, info };
}

function isFenceClose(line, fence) {
  const trimmed = line.trim();
  if (trimmed.length < fence.length) {
    return false;
  }
  for (let i = 0; i < trimmed.length; i += 1) {
    if (trimmed[i] !== fence.char) {
      return false;
    }
  }
  return true;
}

/**
 * Replaces inline backtick code spans with spaces so example Markdown links inside inline code
 * are ignored without shifting line numbers.
 */
function maskInlineCode(line) {
  let out = '';
  let i = 0;
  const n = line.length;
  while (i < n) {
    if (line[i] === '`') {
      let tickLen = 1;
      while (i + tickLen < n && line[i + tickLen] === '`') {
        tickLen += 1;
      }
      const closeIdx = line.indexOf('`'.repeat(tickLen), i + tickLen);
      if (closeIdx !== -1) {
        out += ' '.repeat(closeIdx + tickLen - i);
        i = closeIdx + tickLen;
        continue;
      }
    }
    out += line[i];
    i += 1;
  }
  return out;
}

function stripInlineHtmlTags(input) {
  let out = input;
  for (;;) {
    const openIdx = out.indexOf('<');
    if (openIdx === -1) {
      return out;
    }
    const closeIdx = out.indexOf('>', openIdx + 1);
    if (closeIdx === -1) {
      return out;
    }
    const innerOpen = out.lastIndexOf('<', closeIdx - 1);
    out = out.slice(0, innerOpen) + out.slice(closeIdx + 1);
  }
}

/**
 * GitHub-compatible heading slug generator.
 */
export function slugifyHeading(rawHeading) {
  const text = stripInlineHtmlTags(
    rawHeading
      .trim()
      .replace(/\s+#+\s*$/, '')
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/`([^`]*)`/g, '$1')
  )
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/~~([^~]+)~~/g, '$1')
    .trim()
    .toLowerCase();

  let slug = '';
  for (const ch of text) {
    if (ch === ' ') {
      slug += '-';
    } else if (/[\p{L}\p{M}\p{N}_-]/u.test(ch)) {
      slug += ch;
    }
  }
  return slug;
}

export function extractHeadingSlugs(markdownText) {
  const slugs = new Set();
  const seenCounts = new Map();
  let activeFence = null;

  for (const line of markdownText.split(/\r?\n/)) {
    if (activeFence) {
      if (isFenceClose(line, activeFence)) {
        activeFence = null;
      }
      continue;
    }
    const open = parseFenceOpen(line);
    if (open) {
      activeFence = open;
      continue;
    }

    const headingMatch = /^\s{0,3}#{1,6}\s+(.+?)\s*$/.exec(line);
    if (!headingMatch) {
      continue;
    }
    const base = slugifyHeading(headingMatch[1]);
    if (!base) {
      continue;
    }
    const prevCount = seenCounts.get(base) ?? 0;
    const finalSlug = prevCount === 0 ? base : `${base}-${prevCount}`;
    seenCounts.set(base, prevCount + 1);
    slugs.add(finalSlug);
  }

  return slugs;
}

function parseLinkTarget(rawDestination) {
  const trimmed = rawDestination.trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed.startsWith('<')) {
    const closeAngle = trimmed.indexOf('>');
    if (closeAngle !== -1) {
      return trimmed.slice(1, closeAngle).trim();
    }
  }
  const wsIdx = trimmed.search(/\s/);
  return wsIdx === -1 ? trimmed : trimmed.slice(0, wsIdx);
}

/**
 * Extracts inline and reference-definition Markdown links outside fenced and inline code.
 */
export function extractMarkdownLinks(markdownText) {
  const links = [];
  let activeFence = null;
  const lines = markdownText.split(/\r?\n/);

  for (let idx = 0; idx < lines.length; idx += 1) {
    const line = lines[idx];
    const lineNo = idx + 1;
    if (activeFence) {
      if (isFenceClose(line, activeFence)) {
        activeFence = null;
      }
      continue;
    }
    const open = parseFenceOpen(line);
    if (open) {
      activeFence = open;
      continue;
    }

    const masked = maskInlineCode(line);

    const refDefMatch = /^\s{0,3}\[[^\]]+\]:\s*(\S+)/.exec(masked);
    if (refDefMatch) {
      const target = parseLinkTarget(refDefMatch[1]);
      if (target) {
        links.push({ line: lineNo, target });
      }
      continue;
    }

    // Scan `[label](destination)` including balanced parentheses in destinations.
    let i = 0;
    while (i < masked.length) {
      const openBracket = masked.indexOf('[', i);
      if (openBracket === -1) {
        break;
      }
      const closeBracket = masked.indexOf(']', openBracket + 1);
      if (closeBracket === -1 || masked[closeBracket + 1] !== '(') {
        i = openBracket + 1;
        continue;
      }
      let depth = 1;
      let cursor = closeBracket + 2;
      while (cursor < masked.length && depth > 0) {
        if (masked[cursor] === '\\') {
          cursor += 2;
          continue;
        }
        if (masked[cursor] === '(') {
          depth += 1;
        } else if (masked[cursor] === ')') {
          depth -= 1;
        }
        cursor += 1;
      }
      if (depth === 0) {
        const rawDest = masked.slice(closeBracket + 2, cursor - 1);
        const target = parseLinkTarget(rawDest);
        if (target) {
          links.push({ line: lineNo, target });
        }
        i = cursor;
      } else {
        i = closeBracket + 2;
      }
    }
  }

  return links;
}

function safeDecodeUri(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function checkMarkdownLinks(rootDir = DEFAULT_ROOT, relFiles = collectCheckedDocFiles(rootDir)) {
  const violations = [];
  const headingCache = new Map();

  function getHeadings(absPath) {
    if (!headingCache.has(absPath)) {
      const content = fs.readFileSync(absPath, 'utf8');
      headingCache.set(absPath, extractHeadingSlugs(content));
    }
    return headingCache.get(absPath);
  }

  for (const relFile of relFiles) {
    const absFile = path.join(rootDir, relFile);
    if (!fs.existsSync(absFile)) {
      violations.push({
        rule: 'missing-doc-file',
        file: relFile,
        line: 1,
        message: `Document '${relFile}' does not exist.`,
      });
      continue;
    }

    const content = fs.readFileSync(absFile, 'utf8');
    const links = extractMarkdownLinks(content);

    for (const link of links) {
      const target = link.target;
      if (EXTERNAL_SCHEME_RE.test(target) || target.startsWith('//')) {
        continue;
      }

      const hashIdx = target.indexOf('#');
      const rawPath = hashIdx === -1 ? target : target.slice(0, hashIdx);
      const rawAnchor = hashIdx === -1 ? '' : target.slice(hashIdx + 1);
      const decodedPath = safeDecodeUri(rawPath.split('?')[0]);
      const decodedAnchor = safeDecodeUri(rawAnchor).trim().toLowerCase();

      const resolvedTarget =
        decodedPath.length === 0
          ? absFile
          : decodedPath.startsWith('/')
            ? path.join(rootDir, decodedPath.slice(1))
            : path.resolve(path.dirname(absFile), decodedPath);

      if (!fs.existsSync(resolvedTarget)) {
        violations.push({
          rule: 'broken-relative-link',
          file: relFile,
          line: link.line,
          message: `Broken link target '${target}' (resolved '${normalizePosix(path.relative(rootDir, resolvedTarget))}').`,
        });
        continue;
      }

      if (
        decodedAnchor.length > 0 &&
        fs.statSync(resolvedTarget).isFile() &&
        resolvedTarget.endsWith('.md')
      ) {
        const slugs = getHeadings(resolvedTarget);
        if (!slugs.has(decodedAnchor)) {
          violations.push({
            rule: 'broken-heading-anchor',
            file: relFile,
            line: link.line,
            message: `Missing heading anchor '#${decodedAnchor}' in '${normalizePosix(path.relative(rootDir, resolvedTarget))}'.`,
          });
        }
      }
    }
  }

  return violations;
}

export function checkSyntheticEmailDomains(rootDir = DEFAULT_ROOT, relFiles) {
  const targetFiles = relFiles ?? walkMarkdownFiles(rootDir, 'docs').toSorted();
  const violations = [];

  for (const relFile of targetFiles) {
    const absFile = path.join(rootDir, relFile);
    if (!fs.existsSync(absFile)) {
      continue;
    }
    const lines = fs.readFileSync(absFile, 'utf8').split(/\r?\n/);
    for (let idx = 0; idx < lines.length; idx += 1) {
      const line = lines[idx];
      EMAIL_RE.lastIndex = 0;
      let match;
      while ((match = EMAIL_RE.exec(line)) !== null) {
        const fullEmail = match[0];
        const domain = match[2].toLowerCase();
        if (!ALLOWED_DOC_EMAIL_DOMAINS.has(domain)) {
          violations.push({
            rule: 'non-synthetic-email-domain',
            file: relFile,
            line: idx + 1,
            message: `Email '${fullEmail}' uses disallowed domain '${domain}'. Use one of: ${[...ALLOWED_DOC_EMAIL_DOMAINS].join(', ')}.`,
          });
        }
      }
    }
  }

  return violations;
}

export function extractTypecheckSnippets(markdownText, relFile) {
  const snippets = [];
  const lines = markdownText.split(/\r?\n/);
  let activeFence = null;
  let snippetMeta = null;
  let buffer = [];

  for (let idx = 0; idx < lines.length; idx += 1) {
    const line = lines[idx];
    const lineNo = idx + 1;

    if (activeFence) {
      if (isFenceClose(line, activeFence)) {
        if (snippetMeta) {
          snippets.push({
            file: relFile,
            startLine: snippetMeta.startLine,
            lang: snippetMeta.lang,
            code: buffer.join('\n'),
          });
        }
        activeFence = null;
        snippetMeta = null;
        buffer = [];
      } else if (snippetMeta) {
        buffer.push(line);
      }
      continue;
    }

    const open = parseFenceOpen(line);
    if (open) {
      activeFence = open;
      const infoMatch = /^(tsx?)\s+.*\bkinloom-check\b/i.exec(open.info);
      if (infoMatch) {
        snippetMeta = {
          lang: infoMatch[1].toLowerCase(),
          startLine: lineNo + 1,
        };
        buffer = [];
      }
    }
  }

  return snippets;
}

export function typecheckDocSnippets(rootDir = DEFAULT_ROOT, relFiles) {
  const targetFiles = relFiles ?? walkMarkdownFiles(rootDir, 'docs/developers').toSorted();
  const snippets = [];

  for (const relFile of targetFiles) {
    const absFile = path.join(rootDir, relFile);
    if (!fs.existsSync(absFile)) {
      continue;
    }
    const content = fs.readFileSync(absFile, 'utf8');
    snippets.push(...extractTypecheckSnippets(content, relFile));
  }

  if (snippets.length === 0) {
    return {
      snippetCount: 0,
      violations: [
        {
          rule: 'no-typecheck-snippets',
          file: targetFiles[0] ?? 'docs/developers',
          line: 1,
          message: 'Expected at least one `ts kinloom-check` or `tsx kinloom-check` code block.',
        },
      ],
    };
  }

  const tscBin = path.join(rootDir, 'node_modules', '.bin', process.platform === 'win32' ? 'tsc.cmd' : 'tsc');
  if (!fs.existsSync(tscBin)) {
    return {
      snippetCount: snippets.length,
      violations: [
        {
          rule: 'missing-tsc-binary',
          file: 'package.json',
          line: 1,
          message: `TypeScript compiler binary not found at '${tscBin}'. Run 'npm ci' first.`,
        },
      ],
    };
  }

  const cacheParent = path.join(rootDir, 'node_modules', '.cache');
  fs.mkdirSync(cacheParent, { recursive: true });
  const tempDir = fs.mkdtempSync(path.join(cacheParent, 'kinloom-check-docs-'));

  try {
    const snippetByFileName = new Map();
    for (let idx = 0; idx < snippets.length; idx += 1) {
      const snippet = snippets[idx];
      const ext = snippet.lang === 'tsx' ? 'tsx' : 'ts';
      const fileName = `snippet-${String(idx + 1).padStart(3, '0')}.${ext}`;
      snippetByFileName.set(fileName, snippet);
      fs.writeFileSync(path.join(tempDir, fileName), `${snippet.code}\n`, 'utf8');
    }

    const tsconfigPath = path.join(tempDir, 'tsconfig.json');
    fs.writeFileSync(
      tsconfigPath,
      JSON.stringify(
        {
          compilerOptions: {
            target: 'ES2023',
            module: 'NodeNext',
            moduleResolution: 'NodeNext',
            jsx: 'react-jsx',
            strict: true,
            noEmit: true,
            skipLibCheck: true,
            esModuleInterop: true,
            types: ['node'],
          },
          include: ['./**/*.ts', './**/*.tsx'],
        },
        null,
        2
      ),
      'utf8'
    );

    const run = spawnSync(tscBin, ['--noEmit', '--pretty', 'false', '-p', tsconfigPath], {
      cwd: rootDir,
      encoding: 'utf8',
    });

    if (run.status === 0) {
      return { snippetCount: snippets.length, violations: [] };
    }

    const combined = `${run.stdout ?? ''}\n${run.stderr ?? ''}`.trim();
    const violations = [];
    const diagRe = /^(.*snippet-\d+\.tsx?)\((\d+),(\d+)\):\s+error\s+(TS\d+):\s+(.*)$/;

    for (const rawLine of combined.split(/\r?\n/)) {
      const match = diagRe.exec(rawLine.trim());
      if (match) {
        const baseName = path.basename(match[1]);
        const snippetLine = Number.parseInt(match[2], 10);
        const tsCode = match[4];
        const tsMsg = match[5];
        const snippet = snippetByFileName.get(baseName);
        violations.push({
          rule: 'snippet-typecheck',
          file: snippet ? snippet.file : baseName,
          line: snippet ? snippet.startLine + snippetLine - 1 : snippetLine,
          message: `${tsCode}: ${tsMsg}`,
        });
      }
    }

    if (violations.length === 0) {
      violations.push({
        rule: 'snippet-typecheck',
        file: snippets[0].file,
        line: snippets[0].startLine,
        message: combined || `tsc exited with status ${String(run.status)}.`,
      });
    }

    return { snippetCount: snippets.length, violations };
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

export function runDocsCheck({ rootDir = DEFAULT_ROOT, typecheckSnippets = false } = {}) {
  const checkedFiles = collectCheckedDocFiles(rootDir);
  const docsOnlyFiles = checkedFiles.filter((file) => file.startsWith('docs/'));
  const linkViolations = checkMarkdownLinks(rootDir, checkedFiles);
  const emailViolations = checkSyntheticEmailDomains(rootDir, docsOnlyFiles);
  const snippetResult = typecheckSnippets
    ? typecheckDocSnippets(rootDir)
    : { snippetCount: 0, violations: [] };

  const violations = [...linkViolations, ...emailViolations, ...snippetResult.violations];
  return {
    ok: violations.length === 0,
    checkedFiles,
    docsOnlyFiles,
    snippetCount: snippetResult.snippetCount,
    violations,
  };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename);
if (isMain) {
  const args = new Set(process.argv.slice(2));
  const typecheckSnippets = args.has('--typecheck-snippets');
  const result = runDocsCheck({ rootDir: DEFAULT_ROOT, typecheckSnippets });

  if (!result.ok) {
    console.error(`Docs check FAILED with ${result.violations.length} violation(s):\n`);
    for (const v of result.violations) {
      console.error(`  [${v.rule}] ${v.file}:${v.line}: ${v.message}`);
    }
    process.exit(1);
  }

  const snippetSuffix = typecheckSnippets ? `, ${result.snippetCount} TypeScript snippet(s) compiled` : '';
  console.log(
    `Docs check PASSED (${result.checkedFiles.length} markdown files, 0 broken links or anchors, 0 disallowed email domains${snippetSuffix}).`
  );
}
