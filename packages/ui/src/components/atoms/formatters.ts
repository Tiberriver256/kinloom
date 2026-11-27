const HONORIFIC_PREFIXES = new Set([
  'capt',
  'col',
  'dr',
  'gen',
  'hon',
  'lt',
  'maj',
  'mr',
  'mrs',
  'ms',
  'prof',
  'rev',
  'sen',
  'senator',
  'sgt',
  'sir',
]);

const NAME_SUFFIXES = new Set(['jr', 'sr', 'ii', 'iii', 'iv', 'v', 'vi', 'esq', 'md', 'phd']);

export function initialsOf(name: string): string {
  const withoutParens = name.replaceAll(/\([^)]*\)/g, ' ');
  const rawTokens = withoutParens
    .trim()
    .split(/\s+/)
    .map((token) => token.replaceAll(/^[^A-Za-zÀ-ÖØ-öø-ÿ]+|[^A-Za-zÀ-ÖØ-öø-ÿ]+$/g, ''))
    .filter(Boolean);

  if (rawTokens.length === 0) {
    return '?';
  }

  const tokens = [...rawTokens];
  while (tokens.length > 1 && HONORIFIC_PREFIXES.has(tokens[0].toLowerCase())) {
    tokens.shift();
  }
  while (tokens.length > 1 && NAME_SUFFIXES.has((tokens.at(-1) ?? '').toLowerCase())) {
    tokens.pop();
  }

  if (tokens.length === 1) {
    return tokens[0].slice(0, 2).toUpperCase();
  }
  return (tokens[0][0] + (tokens.at(-1) ?? '')[0]).toUpperCase();
}

export function resolveAssetUrl(rel?: string | null, baseUrl?: string): string {
  if (!rel) {
    return '';
  }
  if (rel.startsWith('http://') || rel.startsWith('https://') || rel.startsWith('data:')) {
    return rel;
  }
  const base = baseUrl ?? ((typeof import.meta !== 'undefined' && import.meta.env?.BASE_URL) || '/');
  const cleanBase = base.endsWith('/') ? base.slice(0, -1) : base;
  return `${cleanBase}${rel.startsWith('/') ? rel : `/${rel}`}`;
}
