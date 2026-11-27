import { parseYaml } from '@kinloom/core';

export type LooseYamlRecord = Record<string, unknown>;

export function isPlainYamlRecord(value: unknown): value is LooseYamlRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function splitTopLevelYamlList(text: string | null): string[] {
  if (!text) {
    return [];
  }
  const normalized = text.replaceAll('\r\n', '\n');
  const startIdx = normalized.startsWith('- ') ? 0 : normalized.indexOf('\n- ');
  if (startIdx === -1) {
    return [];
  }
  const body = startIdx === 0 ? normalized : normalized.slice(startIdx + 1);
  return body.split(/\n(?=- )/);
}

export function extractYamlBlockId(block: string): string | null {
  const match = /^- id:\s*["']?([^"'\n\r]+?)["']?\s*(?:\n|$)/.exec(block);
  return match ? match[1].trim() : null;
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
