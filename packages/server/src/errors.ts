import { type ApiErrorEnvelope, PrivacyViolationError } from '@kinloom/core';
import { ZodError } from 'zod';

export class KinloomHttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'KinloomHttpError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function toErrorResponseData(error: unknown): {
  status: number;
  body: ApiErrorEnvelope;
  headers?: Record<string, string>;
} {
  if (error instanceof KinloomHttpError) {
    const headers: Record<string, string> | undefined =
      error.status === 416 &&
      error.details !== null &&
      typeof error.details === 'object' &&
      'total' in error.details &&
      typeof (error.details as { total: unknown }).total === 'number'
        ? { 'content-range': `bytes */${(error.details as { total: number }).total}` }
        : undefined;
    return {
      status: error.status,
      body: {
        error: {
          code: error.code,
          message: error.message,
          ...(error.details !== undefined ? { details: error.details } : {}),
        },
      },
      headers,
    };
  }

  if (error instanceof PrivacyViolationError) {
    return {
      status: error.status,
      body: {
        error: {
          code: error.code,
          message: error.message,
          details: { blocked_person_ids: [...error.blockedPersonIds] },
        },
      },
    };
  }

  if (error instanceof ZodError) {
    return {
      status: 400,
      body: {
        error: {
          code: 'VALIDATION_ERROR',
          message: error.issues[0]?.message ?? 'Request validation failed.',
          details: error.issues.map((issue) => ({
            path: issue.path.join('.'),
            message: issue.message,
          })),
        },
      },
    };
  }

  return {
    status: 500,
    body: {
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Internal server error.',
      },
    },
  };
}
