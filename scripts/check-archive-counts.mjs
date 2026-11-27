#!/usr/bin/env node
/**
 * Enforces `kinloom/no-hardcoded-archive-counts` across all TypeScript/TSX/JS
 * files using Rolldown's native ESTree parser (`parseSync`) and the canonical
 * rule in `scripts/archive-count-rule.ts`.
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { parseSync } from 'rolldown/experimental';
import { noHardcodedArchiveCountsRule } from './archive-count-rule.ts';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const DEFAULT_TARGETS = [
  'packages/core/src',
  'packages/server/src',
  'packages/worker/src',
  'packages/cli/src',
  'packages/ui/src',
  'examples/demo/src',
  'e2e',
];

function formatMessage(messageId, data) {
  let template = noHardcodedArchiveCountsRule.meta.messages[messageId] ?? messageId;
  for (const [k, v] of Object.entries(data ?? {})) {
    template = template.replaceAll(`{{${k}}}`, v);
  }
  return template;
}

function offsetToLineCol(sourceText, offset) {
  let line = 1;
  let lastNewline = -1;
  for (let i = 0; i < offset && i < sourceText.length; i += 1) {
    if (sourceText.charCodeAt(i) === 10) {
      line += 1;
      lastNewline = i;
    }
  }
  return { line, column: offset - lastNewline };
}

function walkEstree(node, onCallExpression) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) {
      walkEstree(item, onCallExpression);
    }
    return;
  }
  if (node.type === 'CallExpression') {
    onCallExpression(node);
  }
  for (const value of Object.values(node)) {
    if (value && typeof value === 'object') {
      walkEstree(value, onCallExpression);
    }
  }
}

export function checkSourceForHardcodedCounts(sourceText, filePath = 'sample.ts') {
  const parsed = parseSync(filePath, sourceText);
  const diagnostics = [];

  const listener = noHardcodedArchiveCountsRule.create({
    report(descriptor) {
      const start = typeof descriptor.node?.start === 'number' ? descriptor.node.start : 0;
      const { line, column } = offsetToLineCol(sourceText, start);
      diagnostics.push({
        file: filePath,
        line,
        column,
        code: 'kinloom(no-hardcoded-archive-counts)',
        messageId: descriptor.messageId,
        message: formatMessage(descriptor.messageId, descriptor.data),
      });
    },
  });

  walkEstree(parsed.program, (callNode) => {
    listener.CallExpression(callNode);
  });

  return diagnostics;
}

function collectFiles(targetPath, out) {
  if (!fs.existsSync(targetPath)) return;
  const stat = fs.statSync(targetPath);
  if (stat.isFile()) {
    if (/\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(targetPath)) {
      out.push(targetPath);
    }
    return;
  }
  for (const entry of fs.readdirSync(targetPath, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'generated') {
      continue;
    }
    collectFiles(path.join(targetPath, entry.name), out);
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename);
if (isMain) {
  const args = process.argv.slice(2);
  const jsonMode = args.includes('--json');
  const rawTargets = args.filter((a) => a !== '--json');
  const targets = (rawTargets.length > 0 ? rawTargets : DEFAULT_TARGETS).map((t) =>
    path.isAbsolute(t) ? t : path.resolve(REPO_ROOT, t)
  );

  const files = [];
  for (const t of targets) {
    collectFiles(t, files);
  }

  const allDiagnostics = [];
  for (const file of files) {
    const content = fs.readFileSync(file, 'utf8');
    if (!content.includes('expect')) continue;
    allDiagnostics.push(...checkSourceForHardcodedCounts(content, file));
  }

  if (jsonMode) {
    console.log(JSON.stringify({ diagnostics: allDiagnostics }, null, 2));
  } else if (allDiagnostics.length > 0) {
    for (const d of allDiagnostics) {
      const rel = path.relative(REPO_ROOT, d.file);
      console.error(`${rel}:${d.line}:${d.column} error ${d.code}: ${d.message}`);
    }
    console.error(`\nFound ${allDiagnostics.length} hardcoded archive count violation(s).`);
  } else {
    console.log(`Archive count check passed (scanned ${files.length} files, 0 violations).`);
  }

  process.exit(allDiagnostics.length > 0 ? 1 : 0);
}
