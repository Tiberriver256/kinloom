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

export function formatPublicCitation(citation: string): string {
  return citation
    .replaceAll(/,\s*sources\/[^\s,)]+/g, '')
    .replaceAll(/\s*\(sources\/[^)]*\)/g, '')
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
  return trimmed.replaceAll(/\s*\(sources\/[^)]*\)/g, '').trim();
}
