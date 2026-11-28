export function formatPublicProvenance(provenance?: string | null): string {
  const trimmed = provenance?.trim() ?? '';
  if (!trimmed) {
    return 'Family Archive';
  }
  if (trimmed.startsWith('sources/') && /\bancestry\b/i.test(trimmed)) {
    return 'Ancestry Family Archive';
  }
  if (trimmed.startsWith('sources/') || trimmed.includes('/media/')) {
    return 'Family Archive';
  }
  return trimmed;
}

function stripSourcesParentheticals(input: string): string {
  if (!input.includes('(sources/')) {
    return input;
  }
  let out = '';
  let cursor = 0;
  while (cursor < input.length) {
    const openIdx = input.indexOf('(sources/', cursor);
    if (openIdx === -1) {
      out += input.slice(cursor);
      break;
    }
    const closeIdx = input.indexOf(')', openIdx + 9);
    if (closeIdx === -1) {
      out += input.slice(cursor);
      break;
    }
    let trimStart = openIdx;
    while (trimStart > cursor && /\s/.test(input.charAt(trimStart - 1))) {
      trimStart -= 1;
    }
    out += input.slice(cursor, trimStart);
    cursor = closeIdx + 1;
  }
  return out;
}

export function formatPublicCitation(citation: string): string {
  return stripSourcesParentheticals(citation.replaceAll(/,\s*sources\/[^\s,)]+/g, ''))
    .replaceAll(/\s{2,}/g, ' ')
    .trim();
}

export function formatPublicRepository(repository?: string | null): string {
  const trimmed = repository?.trim() ?? '';
  if (!trimmed) {
    return '';
  }
  if (trimmed === 'Repository archive (sources/)') {
    return 'Family Archive';
  }
  return stripSourcesParentheticals(trimmed).trim();
}
