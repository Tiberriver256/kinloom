import { renderEmbeddedGuide } from '../../guides/index.js';
import {
  RECORD_COMMAND_CATEGORIES,
  RECORD_COMMAND_SPECS,
  type RecordCommandSpec,
  resolveRecordCommand,
} from './registry.js';

export type RecordCommandIntent =
  | { readonly mode: 'render-guide' }
  | { readonly mode: 'exec-script'; readonly scriptArgs: readonly string[] };

export function classifyRecordCommandIntent(
  spec: RecordCommandSpec,
  args: readonly string[]
): RecordCommandIntent {
  if (spec.kind === 'guide-only') {
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

export function renderRecordCommandHelp(commandOrSpec: string | RecordCommandSpec): string {
  const spec = typeof commandOrSpec === 'string' ? resolveRecordCommand(commandOrSpec) : commandOrSpec;
  if (!spec) {
    throw new Error(`Unknown record command: '${String(commandOrSpec)}'`);
  }

  return renderEmbeddedGuide(spec.command, {
    includeFooter: true,
    isGuideOnly: spec.kind === 'guide-only',
  });
}

export function formatRecordCommandsHelp(): string {
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
      const summary = spec.summary.trim() || spec.command;
      const tags: string[] = [];
      if (spec.aliases.length > 0) {
        tags.push(`alias: ${spec.aliases.join(', ')}`);
      }
      if (spec.kind === 'guide-only') {
        tags.push('guide');
      }
      const suffix = tags.length > 0 ? ` (${tags.join(', ')})` : '';
      lines.push(`  ${padded}${summary}${suffix}`);
    }
    sections.push(lines.join('\n'));
  }

  return sections.join('\n\n');
}
