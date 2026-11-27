/**
 * Oxlint JS plugin for Kinloom archives.
 *
 * Kept self-contained with erasable TypeScript syntax only so Node.js >= 22.18
 * can load this file directly via Oxlint `jsPlugins` before `tsc` builds `dist/`,
 * while published consumers resolve `@kinloom/core/oxlint-plugin` to `dist/oxlint/plugin.js`.
 */

interface AstNode {
  type: string;
  [key: string]: unknown;
}

interface IdentifierNode extends AstNode {
  type: 'Identifier';
  name: string;
}

interface LiteralNode extends AstNode {
  type: 'Literal';
  value: unknown;
}

interface UnaryExpressionNode extends AstNode {
  type: 'UnaryExpression';
  operator: string;
  argument: AstNode;
}

interface LogicalExpressionNode extends AstNode {
  type: 'LogicalExpression';
  operator: string;
  left: AstNode;
  right: AstNode;
}

interface ArrayExpressionNode extends AstNode {
  type: 'ArrayExpression';
  elements: Array<AstNode | null>;
}

interface MemberExpressionNode extends AstNode {
  type: 'MemberExpression';
  object: AstNode;
  property: AstNode;
  computed: boolean;
  optional?: boolean;
}

interface CallExpressionNode extends AstNode {
  type: 'CallExpression';
  callee: AstNode;
  arguments: AstNode[];
}

interface PropertyNode extends AstNode {
  type: 'Property';
  key: AstNode;
  value: AstNode;
  computed: boolean;
}

interface ObjectExpressionNode extends AstNode {
  type: 'ObjectExpression';
  properties: AstNode[];
}

interface ReportDescriptor {
  node: AstNode;
  messageId: 'hardcodedCollectionCount' | 'hardcodedMetaCount';
  data: {
    target: string;
    count: string;
  };
}

interface RuleContext {
  report(descriptor: ReportDescriptor): void;
}

export interface KinloomOxlintRule {
  meta: {
    type: 'problem';
    docs: {
      description: string;
      recommended: boolean;
    };
    messages: {
      hardcodedCollectionCount: string;
      hardcodedMetaCount: string;
    };
    schema: readonly [];
  };
  create(context: RuleContext): {
    CallExpression(node: AstNode): void;
  };
}

export interface KinloomOxlintPlugin {
  meta: {
    name: string;
  };
  rules: {
    'no-hardcoded-archive-counts': KinloomOxlintRule;
  };
}

const ARCHIVE_COLLECTIONS = new Set([
  'people',
  'events',
  'places',
  'sources',
  'media',
  'narratives',
  'kinship',
  'residence_spans',
  'entities',
]);

const EQUALITY_MATCHERS = new Set(['toBe', 'toEqual', 'toStrictEqual']);
const OBJECT_COUNT_MATCHERS = new Set(['toEqual', 'toStrictEqual', 'toMatchObject']);

const ARCHIVE_HOLDER_NAME_RE =
  /(?:^|_)(?:bundle|archive|snapshot)(?:data|json|result|payload)?$|(?:Bundle|Archive|Snapshot)(?:Data|Json|Result|Payload)?$|^compiled(?:Public|Private|Result|Data)?$/i;

const WRAPPER_NODE_TYPES = new Set([
  'ChainExpression',
  'ParenthesizedExpression',
  'TSAsExpression',
  'TSNonNullExpression',
  'TSSatisfiesExpression',
  'TSTypeAssertion',
]);

type ArchiveCountTarget =
  | { kind: 'collection'; label: string }
  | { kind: 'collectionLength'; label: string }
  | { kind: 'metaCountField'; label: string }
  | { kind: 'metaCountsObject'; label: string }
  | { kind: 'metaObject'; label: string };

function isAstNode(value: unknown): value is AstNode {
  return (
    typeof value === 'object' && value !== null && typeof (value as { type?: unknown }).type === 'string'
  );
}

function unwrapExpression(node: AstNode): AstNode {
  let current = node;
  while (WRAPPER_NODE_TYPES.has(current.type)) {
    const inner = current.expression;
    if (!isAstNode(inner)) {
      break;
    }
    current = inner;
  }
  return current;
}

function isZeroLiteral(node: AstNode): boolean {
  const unwrapped = unwrapExpression(node);
  return unwrapped.type === 'Literal' && (unwrapped as LiteralNode).value === 0;
}

function isEmptyArrayLiteral(node: AstNode): boolean {
  const unwrapped = unwrapExpression(node);
  return unwrapped.type === 'ArrayExpression' && (unwrapped as ArrayExpressionNode).elements.length === 0;
}

function unwrapFallbackExpression(node: AstNode): AstNode {
  let current = unwrapExpression(node);
  while (current.type === 'LogicalExpression') {
    const logical = current as LogicalExpressionNode;
    if (
      (logical.operator === '??' || logical.operator === '||') &&
      (isEmptyArrayLiteral(logical.right) || isZeroLiteral(logical.right))
    ) {
      current = unwrapExpression(logical.left);
      continue;
    }
    break;
  }
  return current;
}

function getMemberPropertyName(member: MemberExpressionNode): string | null {
  if (!member.computed && member.property.type === 'Identifier') {
    return (member.property as IdentifierNode).name;
  }
  if (member.computed && member.property.type === 'Literal') {
    const value = (member.property as LiteralNode).value;
    return typeof value === 'string' ? value : null;
  }
  return null;
}

function getObjectPropertyName(prop: PropertyNode): string | null {
  if (!prop.computed && prop.key.type === 'Identifier') {
    return (prop.key as IdentifierNode).name;
  }
  if (prop.key.type === 'Literal') {
    const value = (prop.key as LiteralNode).value;
    return typeof value === 'string' ? value : null;
  }
  return null;
}

function getPositiveNumericLiteral(node: AstNode): number | null {
  const unwrapped = unwrapExpression(node);
  if (unwrapped.type === 'Literal') {
    const value = (unwrapped as LiteralNode).value;
    if (typeof value === 'number' && Number.isFinite(value) && value >= 1) {
      return value;
    }
    return null;
  }
  if (unwrapped.type === 'UnaryExpression') {
    const unary = unwrapped as UnaryExpressionNode;
    if (unary.operator === '+') {
      return getPositiveNumericLiteral(unary.argument);
    }
  }
  return null;
}

function isArchiveHolderName(name: string): boolean {
  return ARCHIVE_HOLDER_NAME_RE.test(name);
}

function isArchiveHolderExpression(node: AstNode): boolean {
  const unwrapped = unwrapExpression(node);
  if (unwrapped.type === 'Identifier') {
    return isArchiveHolderName((unwrapped as IdentifierNode).name);
  }
  if (unwrapped.type === 'MemberExpression') {
    const propName = getMemberPropertyName(unwrapped as MemberExpressionNode);
    return propName !== null && isArchiveHolderName(propName);
  }
  if (unwrapped.type === 'CallExpression') {
    const callee = unwrapExpression((unwrapped as CallExpressionNode).callee);
    if (callee.type === 'Identifier') {
      return isArchiveHolderName((callee as IdentifierNode).name);
    }
    if (callee.type === 'MemberExpression') {
      const propName = getMemberPropertyName(callee as MemberExpressionNode);
      return propName !== null && isArchiveHolderName(propName);
    }
  }
  return false;
}

function isMetaCountsMember(node: AstNode): boolean {
  const unwrapped = unwrapExpression(node);
  if (unwrapped.type !== 'MemberExpression') {
    return false;
  }
  const countsMember = unwrapped as MemberExpressionNode;
  if (getMemberPropertyName(countsMember) !== 'counts') {
    return false;
  }
  const metaNode = unwrapExpression(countsMember.object);
  if (metaNode.type !== 'MemberExpression') {
    return false;
  }
  const metaMember = metaNode as MemberExpressionNode;
  return getMemberPropertyName(metaMember) === 'meta' && isArchiveHolderExpression(metaMember.object);
}

function matchArchiveCollectionMember(node: AstNode): string | null {
  const unwrapped = unwrapFallbackExpression(node);
  if (unwrapped.type !== 'MemberExpression') {
    return null;
  }
  const member = unwrapped as MemberExpressionNode;
  const propName = getMemberPropertyName(member);
  if (propName === null || !ARCHIVE_COLLECTIONS.has(propName)) {
    return null;
  }
  return isArchiveHolderExpression(member.object) ? propName : null;
}

function classifyExpectSubject(node: AstNode): ArchiveCountTarget | null {
  const unwrapped = unwrapFallbackExpression(node);
  if (unwrapped.type !== 'MemberExpression') {
    return null;
  }
  const member = unwrapped as MemberExpressionNode;
  const propName = getMemberPropertyName(member);
  if (propName === null) {
    return null;
  }

  if (propName === 'length') {
    const collection = matchArchiveCollectionMember(member.object);
    if (collection !== null) {
      return { kind: 'collectionLength', label: `${collection}.length` };
    }
    return null;
  }

  if (ARCHIVE_COLLECTIONS.has(propName) && isArchiveHolderExpression(member.object)) {
    return { kind: 'collection', label: propName };
  }

  if (isMetaCountsMember(member.object)) {
    return { kind: 'metaCountField', label: `meta.counts.${propName}` };
  }

  if (propName === 'counts' && isMetaCountsMember(member)) {
    return { kind: 'metaCountsObject', label: 'meta.counts' };
  }

  if (propName === 'meta' && isArchiveHolderExpression(member.object)) {
    return { kind: 'metaObject', label: 'meta' };
  }

  return null;
}

function isExpectCall(node: AstNode): node is CallExpressionNode {
  const unwrapped = unwrapExpression(node);
  if (unwrapped.type !== 'CallExpression') {
    return false;
  }
  const call = unwrapped as CallExpressionNode;
  if (call.arguments.length === 0) {
    return false;
  }
  const callee = unwrapExpression(call.callee);
  if (callee.type === 'Identifier') {
    return (callee as IdentifierNode).name === 'expect';
  }
  if (callee.type === 'MemberExpression') {
    const member = callee as MemberExpressionNode;
    const obj = unwrapExpression(member.object);
    return (
      obj.type === 'Identifier' &&
      (obj as IdentifierNode).name === 'expect' &&
      getMemberPropertyName(member) === 'soft'
    );
  }
  return false;
}

function collectHardcodedCountObjectViolations(objExpr: ObjectExpressionNode): ReportDescriptor[] {
  const reports: ReportDescriptor[] = [];
  for (const prop of objExpr.properties) {
    if (prop.type !== 'Property') {
      continue;
    }
    const property = prop as PropertyNode;
    const count = getPositiveNumericLiteral(property.value);
    if (count === null) {
      continue;
    }
    const keyName = getObjectPropertyName(property) ?? 'count';
    reports.push({
      node: property,
      messageId: 'hardcodedMetaCount',
      data: {
        target: `meta.counts.${keyName}`,
        count: String(count),
      },
    });
  }
  return reports;
}

function inspectExpectMatcherCall(call: CallExpressionNode): ReportDescriptor[] {
  const callee = unwrapExpression(call.callee);
  if (callee.type !== 'MemberExpression') {
    return [];
  }
  const matcherMember = callee as MemberExpressionNode;
  const matcherName = getMemberPropertyName(matcherMember);
  if (matcherName === null) {
    return [];
  }

  if (!isExpectCall(matcherMember.object)) {
    return [];
  }

  const expectCall = unwrapExpression(matcherMember.object) as CallExpressionNode;
  const expectSubject = expectCall.arguments[0];
  const matcherArg = call.arguments[0];
  if (!expectSubject || !matcherArg) {
    return [];
  }

  const target = classifyExpectSubject(expectSubject);
  if (target === null) {
    return [];
  }

  switch (target.kind) {
    case 'collection': {
      if (matcherName !== 'toHaveLength') {
        return [];
      }
      const count = getPositiveNumericLiteral(matcherArg);
      if (count === null) {
        return [];
      }
      return [
        {
          node: call,
          messageId: 'hardcodedCollectionCount',
          data: { target: target.label, count: String(count) },
        },
      ];
    }
    case 'collectionLength': {
      if (!EQUALITY_MATCHERS.has(matcherName)) {
        return [];
      }
      const count = getPositiveNumericLiteral(matcherArg);
      if (count === null) {
        return [];
      }
      return [
        {
          node: call,
          messageId: 'hardcodedCollectionCount',
          data: { target: target.label, count: String(count) },
        },
      ];
    }
    case 'metaCountField': {
      if (!EQUALITY_MATCHERS.has(matcherName)) {
        return [];
      }
      const count = getPositiveNumericLiteral(matcherArg);
      if (count === null) {
        return [];
      }
      return [
        {
          node: call,
          messageId: 'hardcodedMetaCount',
          data: { target: target.label, count: String(count) },
        },
      ];
    }
    case 'metaCountsObject': {
      if (!OBJECT_COUNT_MATCHERS.has(matcherName)) {
        return [];
      }
      const argExpr = unwrapExpression(matcherArg);
      if (argExpr.type !== 'ObjectExpression') {
        return [];
      }
      return collectHardcodedCountObjectViolations(argExpr as ObjectExpressionNode);
    }
    case 'metaObject': {
      if (!OBJECT_COUNT_MATCHERS.has(matcherName)) {
        return [];
      }
      const argExpr = unwrapExpression(matcherArg);
      if (argExpr.type !== 'ObjectExpression') {
        return [];
      }
      const reports: ReportDescriptor[] = [];
      for (const prop of (argExpr as ObjectExpressionNode).properties) {
        if (prop.type !== 'Property') {
          continue;
        }
        const property = prop as PropertyNode;
        if (getObjectPropertyName(property) !== 'counts') {
          continue;
        }
        const countsExpr = unwrapExpression(property.value);
        if (countsExpr.type === 'ObjectExpression') {
          reports.push(...collectHardcodedCountObjectViolations(countsExpr as ObjectExpressionNode));
        }
      }
      return reports;
    }
  }
}

export const noHardcodedArchiveCountsRule: KinloomOxlintRule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow hardcoded positive numeric literal counts on compiled Kinloom archive collections and meta.counts.',
      recommended: true,
    },
    messages: {
      hardcodedCollectionCount:
        'Avoid asserting a hardcoded archive count ({{target}} === {{count}}). Hardcoded counts create brittle change-detector tests that break on legitimate archive additions. Assert a data-derived count (for example, expectedPublicMedia.length from parsed YAML), a non-empty check (toBeGreaterThan(0)), or a structural invariant instead.',
      hardcodedMetaCount:
        'Avoid asserting a hardcoded archive count ({{target}} === {{count}}). Hardcoded counts create brittle change-detector tests that break on legitimate archive additions. Derive the expected count from source inputs (for example, bundle.people.length or parsed YAML) or assert a structural invariant instead.',
    },
    schema: [],
  },
  create(context) {
    return {
      CallExpression(node) {
        for (const violation of inspectExpectMatcherCall(node as CallExpressionNode)) {
          context.report(violation);
        }
      },
    };
  },
};

export const kinloomOxlintPlugin: KinloomOxlintPlugin = {
  meta: {
    name: 'kinloom',
  },
  rules: {
    'no-hardcoded-archive-counts': noHardcodedArchiveCountsRule,
  },
};

export default kinloomOxlintPlugin;
