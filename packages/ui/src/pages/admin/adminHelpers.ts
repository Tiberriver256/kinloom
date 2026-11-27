import type { AgentTokenScope } from '@kinloom/core';

export type AdminConfirmState =
  | { readonly kind: 'demote'; readonly email: string }
  | { readonly kind: 'revoke_invite'; readonly token: string }
  | { readonly kind: 'revoke_token'; readonly tokenId: string };

export function formatTokenScopeLabel(scope: AgentTokenScope): string {
  return scope === 'read_backup' ? 'Read-only backup' : 'Research updates';
}

export function buildInviteUrl(token: string): string {
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  return `${origin}/invite/${token}`;
}
