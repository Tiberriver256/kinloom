export const SERVER_SECURITY_EVENT_TYPES = [
  'auth.magic_link.rate_limited',
  'auth.magic_link.invalid_or_expired',
  'auth.oauth.failed',
  'auth.invite.invalid',
  'auth.agent_token.rejected',
  'auth.write.forbidden',
  'media.upload.rejected',
  'csrf.rejected',
] as const;

export type ServerSecurityEventType = (typeof SERVER_SECURITY_EVENT_TYPES)[number];

export type MagicLinkInvalidReason = 'invalid' | 'used' | 'expired' | 'invite_required';

export type OAuthFailureReason =
  | 'cancelled'
  | 'provider_error'
  | 'invalid_state'
  | 'provider_unconfigured'
  | 'email_unverified'
  | 'invite_required'
  | 'exchange_failed';

export type InviteInvalidReason = 'missing' | 'not_found' | 'expired' | 'revoked';

export type AgentTokenRejectedReason = 'empty_token' | 'invalid_or_revoked' | 'insufficient_scope';

export type WriteForbiddenReason =
  | 'unauthenticated'
  | 'invite_read_only'
  | 'insufficient_role'
  | 'not_owner'
  | 'talk_disabled'
  | 'member_required';

export type MediaUploadRejectedReason =
  | 'magic_bytes_mismatch'
  | 'unsupported_media_type'
  | 'file_too_large'
  | 'empty_file';

export type CsrfRejectedReason = 'missing_origin' | 'origin_mismatch';

export type ServerSecurityEventPayload =
  | {
      readonly type: 'auth.magic_link.rate_limited';
      readonly status: number;
      readonly reason: 'rate_limit_exceeded';
    }
  | {
      readonly type: 'auth.magic_link.invalid_or_expired';
      readonly status: number;
      readonly reason: MagicLinkInvalidReason;
    }
  | {
      readonly type: 'auth.oauth.failed';
      readonly status: number;
      readonly reason: OAuthFailureReason;
      readonly provider: 'google';
    }
  | {
      readonly type: 'auth.invite.invalid';
      readonly status: number;
      readonly reason: InviteInvalidReason;
    }
  | {
      readonly type: 'auth.agent_token.rejected';
      readonly status: number;
      readonly reason: AgentTokenRejectedReason;
    }
  | {
      readonly type: 'auth.write.forbidden';
      readonly status: number;
      readonly reason: WriteForbiddenReason;
      readonly requiredRole?: 'editor' | 'admin';
      readonly actorKind?: 'anonymous' | 'invite_viewer' | 'user' | 'agent';
    }
  | {
      readonly type: 'media.upload.rejected';
      readonly status: number;
      readonly reason: MediaUploadRejectedReason;
      readonly contentType: string;
      readonly sizeBytes: number;
      readonly maxBytes?: number;
    }
  | {
      readonly type: 'csrf.rejected';
      readonly status: number;
      readonly reason: CsrfRejectedReason;
      readonly authMethod: 'cookie' | 'none';
    };

export interface ServerSecurityEventBase {
  readonly timestamp: string;
  readonly method: string;
  readonly route: string;
  readonly request: Request;
  readonly metadata: Map<string, unknown>;
  readonly waitUntil?: (promise: Promise<unknown>) => void;
  readonly reportError?: (error: unknown) => void;
}

export type ServerSecurityEvent = ServerSecurityEventBase & ServerSecurityEventPayload;

const SAFE_MEDIA_TYPE_PATTERN = /^[a-z0-9][a-z0-9.+-]{0,63}\/[a-z0-9][a-z0-9.+-]{0,63}$/;

/**
 * Strips MIME parameters and enforces strict RFC media-type characters so untrusted
 * Content-Type headers cannot inject emails, tokens, or arbitrary strings into telemetry.
 */
export function sanitizeMediaContentType(raw: string | null | undefined): string {
  if (!raw) {
    return 'unknown';
  }
  const base = raw.split(';')[0]?.trim().toLowerCase() ?? '';
  return SAFE_MEDIA_TYPE_PATTERN.test(base) ? base : 'unknown';
}
