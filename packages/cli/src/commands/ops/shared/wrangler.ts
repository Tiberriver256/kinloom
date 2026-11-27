export interface WranglerExecOptions {
  cwd: string;
  timeoutMs: number;
  maxBufferBytes: number;
}

export type WranglerExecutor = (
  wranglerBin: string,
  args: readonly string[],
  options: WranglerExecOptions
) => Promise<{ stdout: string; stderr: string }>;

export function stripJsoncCommentsAndTrailingCommas(text: string): string {
  let out = '';
  let inString = false;
  let escapeNext = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    const next = text[i + 1];

    if (inString) {
      out += ch;
      if (escapeNext) {
        escapeNext = false;
      } else if (ch === '\\') {
        escapeNext = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') {
        i += 1;
      }
      if (i < text.length) {
        out += '\n';
      }
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) {
        i += 1;
      }
      i += 1;
      continue;
    }
    out += ch;
  }

  return out.replaceAll(/,\s*([}\]])/g, '$1');
}
