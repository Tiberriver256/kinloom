import fs from 'node:fs';
import { renderEmbeddedGuide, resolveEmbeddedGuide } from '../../guides/index.js';
import {
  RECORD_COMMAND_CATEGORIES,
  RECORD_COMMAND_SPECS,
  type RecordCommandSpec,
  resolveRecordCommand,
} from './registry.js';
import { type ResolveRootsOptions, resolveRecordGuidePath } from './resolve.js';

export interface ParsedSkillDocument {
  readonly frontmatter: Readonly<Record<string, string>>;
  readonly body: string;
}

export type RecordCommandIntent =
  | { readonly mode: 'render-guide' }
  | { readonly mode: 'exec-script'; readonly scriptArgs: readonly string[] };

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function unquoteScalar(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replace(/\\(["\\])/g, '$1');
  }
  if (trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replace(/''/g, "'");
  }
  return trimmed;
}

function parseSimpleFrontmatter(raw: string): Record<string, string> {
  const result: Record<string, string> = {};
  const lines = raw.split(/\r?\n/);
  let currentKey: string | null = null;
  let blockStyle: '>' | '|' | null = null;
  let blockLines: string[] = [];

  const flushBlock = (): void => {
    if (currentKey !== null) {
      result[currentKey] =
        blockStyle === '|'
          ? blockLines.join('\n').trim()
          : blockLines
              .map((line) => line.trim())
              .filter(Boolean)
              .join(' ')
              .trim();
      currentKey = null;
      blockStyle = null;
      blockLines = [];
    }
  };

  for (const line of lines) {
    if (currentKey !== null && (/^\s+/.test(line) || line.trim().length === 0)) {
      blockLines.push(line.replace(/^\s+/, ''));
      continue;
    }
    flushBlock();
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }
    const colonIdx = trimmed.indexOf(':');
    if (colonIdx <= 0) {
      continue;
    }
    const key = trimmed.slice(0, colonIdx).trim();
    const rest = trimmed.slice(colonIdx + 1).trim();
    if (rest === '>' || rest === '|') {
      currentKey = key;
      blockStyle = rest;
      blockLines = [];
    } else {
      result[key] = unquoteScalar(rest);
    }
  }
  flushBlock();
  return result;
}

export function parseSkillDocument(markdown: string): ParsedSkillDocument {
  const match = FRONTMATTER_RE.exec(markdown);
  if (!match) {
    return { frontmatter: {}, body: markdown.trim() };
  }

  const rawFrontmatter = match[1];
  const body = markdown.slice(match[0].length).trim();
  const frontmatter = parseSimpleFrontmatter(rawFrontmatter);

  return { frontmatter, body };
}

export function rewriteSkillCommandExamples(body: string, spec: RecordCommandSpec): string {
  const replacement = `kinloom ${spec.command}`;
  let rewritten = body;

  const skillDir = spec.kind === 'skill-script' || spec.kind === 'native' ? spec.skillDir : undefined;
  const scriptName = spec.kind === 'skill-script' || spec.kind === 'native' ? spec.scriptName : undefined;
  const assetScript = spec.kind === 'asset-script' || spec.kind === 'native' ? spec.assetScript : undefined;

  if (skillDir && scriptName) {
    const skillDirEsc = escapeRegExp(skillDir);
    const scriptEsc = escapeRegExp(scriptName);

    // Handle shell variable assignments like CLI=skills/narrative-audio/scripts/narrative-audio
    const assignPattern = new RegExp(
      `([A-Z_][A-Z0-9_]*=)(?:\\./)?skills/${skillDirEsc}/scripts/${scriptEsc}\\b`,
      'g'
    );
    rewritten = rewritten.replace(assignPattern, `$1"${replacement}"`);

    // Rewrite legacy runner prefixes + full/relative script paths into `kinloom <cmd>`
    const fullPathPattern = new RegExp(
      `(?:(?:uv\\s+run(?:\\s+--script)?|python3(?:\\s+-S)?)\\s+)?(?:\\./)?skills/${skillDirEsc}/scripts/${scriptEsc}\\b`,
      'g'
    );
    rewritten = rewritten.replace(fullPathPattern, replacement);

    const shortPathPattern = new RegExp(
      `(?:(?:uv\\s+run(?:\\s+--script)?|python3(?:\\s+-S)?)\\s+)?(?:\\./)?scripts/${scriptEsc}\\b`,
      'g'
    );
    rewritten = rewritten.replace(shortPathPattern, replacement);
  } else if (assetScript) {
    const assetEsc = escapeRegExp(assetScript);
    const assetPattern = new RegExp(
      `(?:(?:uv\\s+run(?:\\s+--script)?|python3(?:\\s+-S)?)\\s+)?(?:\\./)?(?:packages/cli/assets/|scripts/)${assetEsc}\\b`,
      'g'
    );
    rewritten = rewritten.replace(assetPattern, replacement);
  }

  return rewritten;
}

export function classifyRecordCommandIntent(
  spec: RecordCommandSpec,
  args: readonly string[]
): RecordCommandIntent {
  if (spec.kind === 'skill-guide') {
    return { mode: 'render-guide' };
  }

  if (args.length === 0) {
    return { mode: 'exec-script', scriptArgs: [] };
  }

  const first = args[0];
  if (first === '--help' || first === '-h' || first === '--guide') {
    return { mode: 'render-guide' };
  }

  if (first === '--script-help') {
    return { mode: 'exec-script', scriptArgs: ['--help', ...args.slice(1)] };
  }

  return { mode: 'exec-script', scriptArgs: [...args] };
}

export function renderRecordCommandHelp(
  commandOrSpec: string | RecordCommandSpec,
  options?: ResolveRootsOptions
): string {
  const spec = typeof commandOrSpec === 'string' ? resolveRecordCommand(commandOrSpec) : commandOrSpec;
  if (!spec) {
    throw new Error(`Unknown record command: '${String(commandOrSpec)}'`);
  }

  const hasExplicitFsOverride = Boolean(
    options?.bundledSkillsDir || options?.monorepoSkillsDir || options?.assetsDir
  );
  if (!hasExplicitFsOverride && resolveEmbeddedGuide(spec.command)) {
    return renderEmbeddedGuide(spec.command, {
      includeFooter: true,
      isGuideOnly: spec.kind === 'skill-guide',
    });
  }

  const guidePath = resolveRecordGuidePath(spec, options);
  const rawMarkdown = fs.readFileSync(guidePath, 'utf8');
  const { body } = parseSkillDocument(rawMarkdown);
  const rewritten = rewriteSkillCommandExamples(body, spec);

  const footerLines: string[] = [];
  if (spec.aliases.length > 0) {
    const aliasList = spec.aliases.map((a) => `kinloom ${a}`).join(', ');
    footerLines.push(`Aliases: ${aliasList}`);
  }
  if (spec.kind !== 'skill-guide') {
    footerLines.push(
      `CLI flags: run \`kinloom ${spec.command} --script-help\` for raw flag usage, or \`kinloom ${spec.command} <subcommand> --help\` for subcommand options.`
    );
  }

  if (footerLines.length === 0) {
    return rewritten;
  }

  return `${rewritten}\n\n---\n${footerLines.join('\n')}`;
}

function summarizeFromFrontmatterOrRegistry(spec: RecordCommandSpec, options?: ResolveRootsOptions): string {
  if (spec.summary.trim().length > 0) {
    return spec.summary.trim();
  }
  try {
    const guidePath = resolveRecordGuidePath(spec, options);
    const { frontmatter } = parseSkillDocument(fs.readFileSync(guidePath, 'utf8'));
    const desc = frontmatter.description ?? '';
    const firstSentence = desc.split(/\.\s+/)[0]?.trim();
    return firstSentence || spec.command;
  } catch {
    return spec.command;
  }
}

export function formatRecordCommandsHelp(options?: ResolveRootsOptions): string {
  const maxNameWidth = Math.max(...RECORD_COMMAND_SPECS.map((s) => s.command.length)) + 2;
  const sections: string[] = [];

  for (const category of RECORD_COMMAND_CATEGORIES) {
    const specs = RECORD_COMMAND_SPECS.filter((s) => s.category === category.id);
    if (specs.length === 0) {
      continue;
    }

    const lines: string[] = [`${category.heading}:`];
    for (const spec of specs) {
      const padded = spec.command.padEnd(maxNameWidth);
      const summary = summarizeFromFrontmatterOrRegistry(spec, options);
      const tags: string[] = [];
      if (spec.aliases.length > 0) {
        tags.push(`alias: ${spec.aliases.join(', ')}`);
      }
      if (spec.kind === 'skill-guide') {
        tags.push('guide');
      }
      const suffix = tags.length > 0 ? ` (${tags.join(', ')})` : '';
      lines.push(`  ${padded}${summary}${suffix}`);
    }
    sections.push(lines.join('\n'));
  }

  return sections.join('\n\n');
}
