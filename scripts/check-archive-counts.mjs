#!/usr/bin/env node
/**
 * Enforces `kinloom/no-hardcoded-archive-counts` across all TypeScript/TSX test
 * and source files using TypeScript's AST parser and the canonical rule exported
 * by `@kinloom/core/oxlint-plugin`.
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import ts from 'typescript';
import { noHardcodedArchiveCountsRule } from '../packages/core/dist/oxlint/plugin.js';

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

function toEstree(node, sourceFile) {
  if (!node) return null;

  if (ts.isParenthesizedExpression(node)) {
    return { type: 'ParenthesizedExpression', expression: toEstree(node.expression, sourceFile) };
  }
  if (ts.isAsExpression(node)) {
    return { type: 'TSAsExpression', expression: toEstree(node.expression, sourceFile) };
  }
  if (ts.isTypeAssertionExpression(node)) {
    return { type: 'TSTypeAssertion', expression: toEstree(node.expression, sourceFile) };
  }
  if (ts.isNonNullExpression(node)) {
    return { type: 'TSNonNullExpression', expression: toEstree(node.expression, sourceFile) };
  }
  if (ts.isSatisfiesExpression(node)) {
    return { type: 'TSSatisfiesExpression', expression: toEstree(node.expression, sourceFile) };
  }
  if (ts.isIdentifier(node)) {
    return { type: 'Identifier', name: node.text, _tsNode: node };
  }
  if (ts.isNumericLiteral(node)) {
    return { type: 'Literal', value: Number(node.text), _tsNode: node };
  }
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return { type: 'Literal', value: node.text, _tsNode: node };
  }
  if (node.kind === ts.SyntaxKind.TrueKeyword) {
    return { type: 'Literal', value: true, _tsNode: node };
  }
  if (node.kind === ts.SyntaxKind.FalseKeyword) {
    return { type: 'Literal', value: false, _tsNode: node };
  }
  if (node.kind === ts.SyntaxKind.NullKeyword) {
    return { type: 'Literal', value: null, _tsNode: node };
  }
  if (ts.isPrefixUnaryExpression(node)) {
    const opMap = {
      [ts.SyntaxKind.PlusToken]: '+',
      [ts.SyntaxKind.MinusToken]: '-',
      [ts.SyntaxKind.ExclamationToken]: '!',
      [ts.SyntaxKind.TildeToken]: '~',
    };
    return {
      type: 'UnaryExpression',
      operator: opMap[node.operator] ?? '',
      argument: toEstree(node.operand, sourceFile),
      _tsNode: node,
    };
  }
  if (ts.isBinaryExpression(node)) {
    const opMap = {
      [ts.SyntaxKind.QuestionQuestionToken]: '??',
      [ts.SyntaxKind.BarBarToken]: '||',
      [ts.SyntaxKind.AmpersandAmpersandToken]: '&&',
    };
    const operator = opMap[node.operatorToken.kind];
    if (operator) {
      return {
        type: 'LogicalExpression',
        operator,
        left: toEstree(node.left, sourceFile),
        right: toEstree(node.right, sourceFile),
        _tsNode: node,
      };
    }
    return { type: 'BinaryExpression', _tsNode: node };
  }
  if (ts.isArrayLiteralExpression(node)) {
    return {
      type: 'ArrayExpression',
      elements: node.elements.map((el) => toEstree(el, sourceFile)),
      _tsNode: node,
    };
  }
  if (ts.isPropertyAccessExpression(node)) {
    return {
      type: 'MemberExpression',
      object: toEstree(node.expression, sourceFile),
      property: toEstree(node.name, sourceFile),
      computed: false,
      optional: Boolean(node.questionDotToken),
      _tsNode: node,
    };
  }
  if (ts.isElementAccessExpression(node)) {
    return {
      type: 'MemberExpression',
      object: toEstree(node.expression, sourceFile),
      property: toEstree(node.argumentExpression, sourceFile),
      computed: true,
      optional: Boolean(node.questionDotToken),
      _tsNode: node,
    };
  }
  if (ts.isCallExpression(node)) {
    return {
      type: 'CallExpression',
      callee: toEstree(node.expression, sourceFile),
      arguments: node.arguments.map((arg) => toEstree(arg, sourceFile)),
      _tsNode: node,
    };
  }
  if (ts.isObjectLiteralExpression(node)) {
    return {
      type: 'ObjectExpression',
      properties: node.properties.map((prop) => {
        if (ts.isPropertyAssignment(prop)) {
          const computed = ts.isComputedPropertyName(prop.name);
          const key = computed ? toEstree(prop.name.expression, sourceFile) : toEstree(prop.name, sourceFile);
          return {
            type: 'Property',
            key,
            value: toEstree(prop.initializer, sourceFile),
            computed,
            _tsNode: prop,
          };
        }
        if (ts.isShorthandPropertyAssignment(prop)) {
          const id = toEstree(prop.name, sourceFile);
          return {
            type: 'Property',
            key: id,
            value: id,
            computed: false,
            _tsNode: prop,
          };
        }
        return { type: 'SpreadElement', _tsNode: prop };
      }),
      _tsNode: node,
    };
  }

  return { type: ts.SyntaxKind[node.kind] ?? 'Unknown', _tsNode: node };
}

function formatMessage(messageId, data) {
  let template = noHardcodedArchiveCountsRule.meta.messages[messageId] ?? messageId;
  for (const [k, v] of Object.entries(data ?? {})) {
    template = template.replaceAll(`{{${k}}}`, v);
  }
  return template;
}

export function checkSourceForHardcodedCounts(sourceText, filePath = 'sample.ts') {
  const scriptKind = filePath.endsWith('.tsx') || filePath.endsWith('.jsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true, scriptKind);
  const diagnostics = [];

  const listener = noHardcodedArchiveCountsRule.create({
    report(descriptor) {
      const tsNode = descriptor.node?._tsNode;
      let line = 1;
      let column = 1;
      if (tsNode) {
        const pos = sourceFile.getLineAndCharacterOfPosition(tsNode.getStart(sourceFile));
        line = pos.line + 1;
        column = pos.character + 1;
      }
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

  function visit(node) {
    if (ts.isCallExpression(node)) {
      listener.CallExpression(toEstree(node, sourceFile));
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
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
    // Fast pre-filter: rule only inspects expect(...) calls.
    if (!content.includes('expect')) continue;
    const diags = checkSourceForHardcodedCounts(content, file);
    allDiagnostics.push(...diags);
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
