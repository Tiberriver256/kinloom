import { CliValidationError } from '../../../errors.js';

export type OptionValueKind = 'string' | 'boolean' | 'integer' | 'number';

export interface OptionSpec {
  readonly key: string;
  readonly kind: OptionValueKind;
  readonly flags: readonly [string, ...string[]];
  readonly negatable?: boolean;
  readonly multiple?: boolean;
  readonly choices?: readonly string[];
  readonly min?: number;
  readonly max?: number;
  readonly default?: string | boolean | number | readonly string[];
  readonly required?: boolean;
  readonly metavar?: string;
  readonly help?: string;
}

export interface CommandParseSpec {
  readonly options: readonly OptionSpec[];
  readonly allowPositionals?: boolean;
  readonly minPositionals?: number;
  readonly maxPositionals?: number;
  readonly commaSplitFlags?: readonly string[];
  readonly positionalLabel?: string;
}

export interface ParsedCommandArgs {
  readonly helpRequested: boolean;
  readonly values: Readonly<Record<string, unknown>>;
  readonly provided: ReadonlySet<string>;
  readonly positionals: readonly string[];
}

export interface CommandUsageSpec {
  readonly usage: string;
  readonly summary: string;
  readonly options?: readonly OptionSpec[];
  readonly subcommands?: readonly { readonly name: string; readonly summary: string }[];
  readonly notes?: readonly string[];
}

function normalizeNegatedFlag(flag: string): string | undefined {
  if (!flag.startsWith('--') || flag.startsWith('--no-')) {
    return undefined;
  }
  return `--no-${flag.slice(2)}`;
}

/**
 * Rejoins shell-split comma arguments for listed flags, e.g.
 * `['--box', '10,', '20,', '30,', '40']` -> `['--box', '10,20,30,40']`.
 */
export function normalizeCommaSplitArgs(argv: readonly string[], commaFlags: ReadonlySet<string>): string[] {
  if (commaFlags.size === 0) {
    return [...argv];
  }
  const out: string[] = [];
  let i = 0;
  while (i < argv.length) {
    const token = argv[i];
    if (token === '--') {
      out.push(...argv.slice(i));
      break;
    }
    const eqIdx = token.indexOf('=');
    const flagHead = eqIdx === -1 ? token : token.slice(0, eqIdx);
    if (!commaFlags.has(flagHead)) {
      out.push(token);
      i += 1;
      continue;
    }

    if (eqIdx !== -1) {
      let combined = token.slice(eqIdx + 1);
      i += 1;
      while (i < argv.length && combined.endsWith(',') && !argv[i].startsWith('-')) {
        combined += argv[i];
        i += 1;
      }
      out.push(`${flagHead}=${combined}`);
      continue;
    }

    out.push(token);
    i += 1;
    if (i < argv.length) {
      let combined = argv[i];
      i += 1;
      while (i < argv.length && combined.endsWith(',') && !argv[i].startsWith('-')) {
        combined += argv[i];
        i += 1;
      }
      out.push(combined);
    }
  }
  return out;
}

function coerceOptionValue(spec: OptionSpec, raw: string, flagUsed: string): string | number {
  if (spec.kind === 'string') {
    if (spec.choices && !spec.choices.includes(raw)) {
      throw new CliValidationError(
        `Invalid value '${raw}' for '${flagUsed}'. Expected one of: ${spec.choices.join(', ')}.`
      );
    }
    return raw;
  }

  if (spec.kind === 'integer') {
    const trimmed = raw.trim();
    if (!/^[+-]?\d+$/.test(trimmed)) {
      throw new CliValidationError(`Option '${flagUsed}' requires an integer value, got '${raw}'.`);
    }
    const parsed = Number.parseInt(trimmed, 10);
    if (!Number.isSafeInteger(parsed)) {
      throw new CliValidationError(`Option '${flagUsed}' integer out of range: '${raw}'.`);
    }
    if (spec.min !== undefined && parsed < spec.min) {
      throw new CliValidationError(`Option '${flagUsed}' must be >= ${spec.min}, got ${parsed}.`);
    }
    if (spec.max !== undefined && parsed > spec.max) {
      throw new CliValidationError(`Option '${flagUsed}' must be <= ${spec.max}, got ${parsed}.`);
    }
    return parsed;
  }

  if (spec.kind === 'number') {
    const trimmed = raw.trim();
    if (trimmed.length === 0) {
      throw new CliValidationError(`Option '${flagUsed}' requires a numeric value.`);
    }
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed)) {
      throw new CliValidationError(`Option '${flagUsed}' requires a finite number, got '${raw}'.`);
    }
    if (spec.min !== undefined && parsed < spec.min) {
      throw new CliValidationError(`Option '${flagUsed}' must be >= ${spec.min}, got ${parsed}.`);
    }
    if (spec.max !== undefined && parsed > spec.max) {
      throw new CliValidationError(`Option '${flagUsed}' must be <= ${spec.max}, got ${parsed}.`);
    }
    return parsed;
  }

  return raw;
}

export function parseCommandArgs(rawArgv: readonly string[], spec: CommandParseSpec): ParsedCommandArgs {
  const commaSet = new Set(spec.commaSplitFlags ?? []);
  const argv = normalizeCommaSplitArgs(rawArgv, commaSet);

  const byFlag = new Map<string, { option: OptionSpec; negated: boolean }>();
  const byShort = new Map<string, OptionSpec>();

  for (const option of spec.options) {
    for (const flag of option.flags) {
      byFlag.set(flag, { option, negated: false });
      if (flag.length === 2 && flag.startsWith('-') && !flag.startsWith('--')) {
        byShort.set(flag[1], option);
      }
      if (option.kind === 'boolean' && option.negatable) {
        const neg = normalizeNegatedFlag(flag);
        if (neg) {
          byFlag.set(neg, { option, negated: true });
        }
      }
    }
  }

  const values: Record<string, unknown> = {};
  for (const option of spec.options) {
    if (option.default !== undefined) {
      values[option.key] = Array.isArray(option.default) ? [...option.default] : option.default;
    } else if (option.multiple) {
      values[option.key] = [];
    } else if (option.kind === 'boolean') {
      values[option.key] = false;
    }
  }

  const provided = new Set<string>();
  const positionals: string[] = [];
  let afterDoubleDash = false;

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (afterDoubleDash) {
      positionals.push(token);
      continue;
    }

    if (token === '--') {
      afterDoubleDash = true;
      continue;
    }

    if (token === '--help' || token === '-h') {
      return {
        helpRequested: true,
        values,
        provided,
        positionals,
      };
    }

    if (token.startsWith('--')) {
      const eqIdx = token.indexOf('=');
      const flagName = eqIdx === -1 ? token : token.slice(0, eqIdx);
      const inlineValue = eqIdx === -1 ? undefined : token.slice(eqIdx + 1);
      const entry = byFlag.get(flagName);
      if (!entry) {
        throw new CliValidationError(`Unknown option '${flagName}'.`);
      }

      const { option, negated } = entry;
      if (option.kind === 'boolean') {
        if (inlineValue !== undefined) {
          throw new CliValidationError(`Boolean option '${flagName}' does not accept a value.`);
        }
        values[option.key] = !negated;
        provided.add(option.key);
        continue;
      }

      let rawValue = inlineValue;
      if (rawValue === undefined) {
        if (i + 1 >= argv.length) {
          throw new CliValidationError(`Option '${flagName}' requires a value.`);
        }
        rawValue = argv[i + 1];
        i += 1;
      }

      const coerced = coerceOptionValue(option, rawValue, flagName);
      if (option.multiple) {
        const list = Array.isArray(values[option.key]) ? (values[option.key] as unknown[]) : [];
        list.push(coerced);
        values[option.key] = list;
      } else {
        values[option.key] = coerced;
      }
      provided.add(option.key);
      continue;
    }

    if (token.startsWith('-') && token.length > 1) {
      // Allow negative numbers as positional arguments when not matching a short flag.
      if (/^-\d+(\.\d+)?$/.test(token) && !byShort.has(token[1])) {
        positionals.push(token);
        continue;
      }

      const eqIdx = token.indexOf('=');
      if (eqIdx === 2) {
        const flagName = token.slice(0, 2);
        const inlineValue = token.slice(3);
        const entry = byFlag.get(flagName);
        if (!entry) {
          throw new CliValidationError(`Unknown option '${flagName}'.`);
        }
        if (entry.option.kind === 'boolean') {
          throw new CliValidationError(`Boolean option '${flagName}' does not accept a value.`);
        }
        const coerced = coerceOptionValue(entry.option, inlineValue, flagName);
        if (entry.option.multiple) {
          const list = Array.isArray(values[entry.option.key]) ? (values[entry.option.key] as unknown[]) : [];
          list.push(coerced);
          values[entry.option.key] = list;
        } else {
          values[entry.option.key] = coerced;
        }
        provided.add(entry.option.key);
        continue;
      }

      const chars = token.slice(1);
      for (let c = 0; c < chars.length; c += 1) {
        const ch = chars[c];
        if (ch === 'h') {
          return {
            helpRequested: true,
            values,
            provided,
            positionals,
          };
        }
        const option = byShort.get(ch);
        if (!option) {
          throw new CliValidationError(`Unknown option '-${ch}'.`);
        }
        const flagName = `-${ch}`;
        if (option.kind === 'boolean') {
          values[option.key] = true;
          provided.add(option.key);
          continue;
        }

        const attachedRest = chars.slice(c + 1);
        let rawValue: string;
        if (attachedRest.length > 0) {
          rawValue = attachedRest;
          c = chars.length;
        } else {
          if (i + 1 >= argv.length) {
            throw new CliValidationError(`Option '${flagName}' requires a value.`);
          }
          rawValue = argv[i + 1];
          i += 1;
        }
        const coerced = coerceOptionValue(option, rawValue, flagName);
        if (option.multiple) {
          const list = Array.isArray(values[option.key]) ? (values[option.key] as unknown[]) : [];
          list.push(coerced);
          values[option.key] = list;
        } else {
          values[option.key] = coerced;
        }
        provided.add(option.key);
        break;
      }
      continue;
    }

    positionals.push(token);
  }

  for (const option of spec.options) {
    if (option.required && !provided.has(option.key)) {
      throw new CliValidationError(`Missing required option '${option.flags[0]}'.`);
    }
  }

  const allowPositionals = spec.allowPositionals ?? true;
  if (!allowPositionals && positionals.length > 0) {
    throw new CliValidationError(`Unexpected positional argument '${positionals[0]}'.`);
  }
  if (spec.minPositionals !== undefined && positionals.length < spec.minPositionals) {
    const label = spec.positionalLabel ?? 'argument';
    throw new CliValidationError(
      `Missing required ${label} (expected at least ${spec.minPositionals}, got ${positionals.length}).`
    );
  }
  if (spec.maxPositionals !== undefined && positionals.length > spec.maxPositionals) {
    throw new CliValidationError(
      `Too many arguments (expected at most ${spec.maxPositionals}, got ${positionals.length}).`
    );
  }

  return {
    helpRequested: false,
    values,
    provided,
    positionals,
  };
}

export function getStringOption(parsed: ParsedCommandArgs, key: string): string | undefined {
  const val = parsed.values[key];
  return typeof val === 'string' ? val : undefined;
}

export function getStringListOption(parsed: ParsedCommandArgs, key: string): readonly string[] {
  const val = parsed.values[key];
  if (!Array.isArray(val)) {
    return [];
  }
  return val.filter((item): item is string => typeof item === 'string');
}

export function getBooleanOption(parsed: ParsedCommandArgs, key: string): boolean {
  return parsed.values[key] === true;
}

export function getNumberOption(parsed: ParsedCommandArgs, key: string): number | undefined {
  const val = parsed.values[key];
  return typeof val === 'number' ? val : undefined;
}

export function resolveSubcommandAlias(token: string, aliases: Readonly<Record<string, string>>): string {
  const normalized = token.trim().toLowerCase();
  return aliases[normalized] ?? normalized;
}

export function formatCommandUsage(spec: CommandUsageSpec): string {
  const lines: string[] = [`Usage: ${spec.usage}`, '', spec.summary];

  if (spec.subcommands && spec.subcommands.length > 0) {
    lines.push('', 'Commands:');
    const width = Math.max(...spec.subcommands.map((sub) => sub.name.length)) + 2;
    for (const sub of spec.subcommands) {
      lines.push(`  ${sub.name.padEnd(width)}${sub.summary}`);
    }
  }

  if (spec.options && spec.options.length > 0) {
    lines.push('', 'Options:');
    const rows = spec.options.map((opt) => {
      const flagParts = [...opt.flags];
      if (opt.kind === 'boolean' && opt.negatable) {
        const neg = normalizeNegatedFlag(opt.flags[0]);
        if (neg) {
          flagParts.push(neg);
        }
      }
      const meta =
        opt.kind === 'boolean' ? '' : ` <${opt.metavar ?? (opt.choices ? opt.choices.join('|') : opt.kind)}>`;
      const left = `${flagParts.join(', ')}${meta}`;
      return { left, help: opt.help ?? '' };
    });
    rows.push({ left: '-h, --help', help: 'Show this help message' });
    const width = Math.max(...rows.map((row) => row.left.length)) + 2;
    for (const row of rows) {
      lines.push(`  ${row.left.padEnd(width)}${row.help}`);
    }
  } else {
    lines.push('', 'Options:', '  -h, --help  Show this help message');
  }

  if (spec.notes && spec.notes.length > 0) {
    lines.push('', ...spec.notes);
  }

  return lines.join('\n');
}
