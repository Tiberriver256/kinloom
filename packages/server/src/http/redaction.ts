const CANONICAL_ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]{1,63}$/;
const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const COOKIE_PAIR_PATTERN = /\b(?:__Host-)?kinloom_(?:session|oauth)=[^;\s]+/gi;
const QUERY_SECRET_PATTERN = /([?&](?:token|code|state|secret|email|invite|api_key|key)=)[^&\s#]+/gi;
const AGENT_TOKEN_PATTERN = /\b(?:kin|klm|inv|tok|sess)_[A-Za-z0-9._-]{8,}\b/gi;

/**
 * Redacts emails, bearer tokens, Kinloom session/OAuth cookies, invite/agent tokens,
 * and sensitive query parameters from diagnostic and observability strings.
 */
export function redactObservabilityText(raw: string): string {
  return raw
    .replace(BEARER_PATTERN, 'Bearer [REDACTED]')
    .replace(COOKIE_PAIR_PATTERN, '[REDACTED_COOKIE]')
    .replace(QUERY_SECRET_PATTERN, '$1[REDACTED]')
    .replace(AGENT_TOKEN_PATTERN, '[REDACTED_TOKEN]')
    .replace(EMAIL_PATTERN, '[REDACTED_EMAIL]');
}

export function sanitizeObservabilityErrorCode(code: string | null | undefined): string | null {
  if (!code) {
    return null;
  }
  const trimmed = code.trim();
  if (CANONICAL_ERROR_CODE_PATTERN.test(trimmed)) {
    return trimmed;
  }
  return 'INTERNAL_ERROR';
}

export function sanitizeDiagnosticDetail(raw: string | null | undefined, maxLength = 160): string | null {
  if (!raw) {
    return null;
  }
  const stripped = redactObservabilityText(raw).replace(/\s+/g, ' ').trim();
  if (stripped.length === 0) {
    return null;
  }
  if (stripped.length <= maxLength) {
    return stripped;
  }
  return `${stripped.slice(0, Math.max(1, maxLength - 1))}…`;
}
