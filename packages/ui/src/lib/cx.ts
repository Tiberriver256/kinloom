/**
 * Composes CSS Module scoped class names with their semantic class hooks so
 * styles remain module-scoped while DOM/E2E selectors and cross-component
 * `:global(...)` hooks stay stable.
 */
export function cx(
  styles: Readonly<Record<string, string>>,
  ...inputs: ReadonlyArray<string | false | null | undefined>
): string {
  const out: string[] = [];
  for (const input of inputs) {
    if (!input) {
      continue;
    }
    for (const token of input.split(/\s+/)) {
      if (!token) {
        continue;
      }
      const scoped = styles[token];
      if (scoped && scoped !== token) {
        out.push(scoped);
      }
      out.push(token);
    }
  }
  return out.join(' ');
}

/**
 * Joins class strings produced by separate CSS Modules without merging or spreading
 * CSS Module objects together.
 */
export function joinClasses(...parts: ReadonlyArray<string | false | null | undefined>): string {
  const out: string[] = [];
  for (const part of parts) {
    if (part) {
      out.push(part);
    }
  }
  return out.join(' ');
}
