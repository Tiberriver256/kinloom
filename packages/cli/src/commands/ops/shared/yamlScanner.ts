import { parseYaml } from '@kinloom/core';

export type LooseYamlRecord = Record<string, unknown>;

export function isPlainYamlRecord(value: unknown): value is LooseYamlRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function splitTopLevelYamlList(text: string | null): string[] {
  if (!text) {
    return [];
  }
  const normalized = text.includes('\r') ? text.replaceAll('\r\n', '\n') : text;
  const startIdx = normalized.startsWith('- ') ? 0 : normalized.indexOf('\n- ');
  if (startIdx === -1) {
    return [];
  }
  const blocks: string[] = [];
  let blockStart = startIdx === 0 ? 0 : startIdx + 1;
  while (true) {
    const nextSep = normalized.indexOf('\n- ', blockStart);
    if (nextSep === -1) {
      blocks.push(normalized.slice(blockStart));
      break;
    }
    blocks.push(normalized.slice(blockStart, nextSep));
    blockStart = nextSep + 1;
  }
  return blocks;
}

export function extractYamlBlockId(block: string): string | null {
  if (!block.startsWith('- id:')) {
    return null;
  }
  const nl = block.indexOf('\n');
  let raw = (nl === -1 ? block.slice(5) : block.slice(5, nl)).trim();
  if (
    raw.length >= 2 &&
    ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'")))
  ) {
    raw = raw.slice(1, -1).trim();
  }
  return raw.length > 0 ? raw : null;
}

export function parseLooseYamlList(text: string | null): LooseYamlRecord[] {
  if (!text?.trim()) {
    return [];
  }
  const parsed = parseYaml(text);
  if (!Array.isArray(parsed)) {
    return [];
  }
  return parsed.filter(isPlainYamlRecord);
}

export function parseMatchingYamlBlocks(blocks: readonly string[]): LooseYamlRecord[] {
  if (blocks.length === 0) {
    return [];
  }
  const parsed = parseYaml(blocks.join('\n'));
  if (!Array.isArray(parsed)) {
    return [];
  }
  return parsed.filter(isPlainYamlRecord);
}

export function parseBlocksById(
  blocks: readonly string[],
  wantedIds: ReadonlySet<string>
): LooseYamlRecord[] {
  if (wantedIds.size === 0) {
    return [];
  }
  const matched = blocks.filter((block) => {
    const id = extractYamlBlockId(block);
    return id !== null && wantedIds.has(id);
  });
  return parseMatchingYamlBlocks(matched);
}
