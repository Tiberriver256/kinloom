import type { OptimisticConflictError } from '@kinloom/core';

export const EXIT_OK = 0;
export const EXIT_ERROR = 1;
export const EXIT_USAGE = 2;
export const EXIT_CONFLICT = 3;

export type CliExitCode = typeof EXIT_OK | typeof EXIT_ERROR | typeof EXIT_USAGE | typeof EXIT_CONFLICT;

export type ApiErrorKind =
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'unprocessable'
  | 'http_error';

export function classifyHttpStatus(status: number): ApiErrorKind {
  switch (status) {
    case 401:
      return 'unauthorized';
    case 403:
      return 'forbidden';
    case 404:
      return 'not_found';
    case 409:
      return 'conflict';
    case 422:
      return 'unprocessable';
    default:
      return 'http_error';
  }
}

export class CliValidationError extends Error {
  readonly exitCode = EXIT_USAGE;
  readonly issues: readonly string[];

  constructor(message: string, issues: readonly string[] = []) {
    super(message);
    this.name = 'CliValidationError';
    this.issues = issues;
  }
}

export interface KinloomApiErrorOptions {
  status: number;
  code: string;
  message: string;
  details?: unknown;
  conflict?: OptimisticConflictError | undefined;
}

export class KinloomApiError extends Error {
  readonly kind: ApiErrorKind;
  readonly status: number;
  readonly code: string;
  readonly details: unknown;
  readonly conflict?: OptimisticConflictError | undefined;
  readonly exitCode: typeof EXIT_CONFLICT | typeof EXIT_ERROR;

  constructor(options: KinloomApiErrorOptions) {
    super(options.message);
    this.name = 'KinloomApiError';
    this.status = options.status;
    this.kind = classifyHttpStatus(options.status);
    this.code = options.code;
    this.details = options.details;
    this.conflict = options.conflict;
    this.exitCode = options.status === 409 ? EXIT_CONFLICT : EXIT_ERROR;
  }
}

export function formatConflictDetails(conflict: OptimisticConflictError): string {
  const lines: string[] = [
    `Conflict on ${conflict.entity_type}/${conflict.entity_id}:`,
    `  Expected parent revision: ${conflict.expected_parent_revision_id ?? 'none'}`,
    `  Server revision:          r${conflict.server_revision_id}`,
    `  Last updated by:          ${conflict.last_author_name} (${conflict.last_updated_at})`,
  ];
  if (conflict.server_deleted_at) {
    lines.push(`  Server deleted at:        ${conflict.server_deleted_at}`);
  }
  if (conflict.diff.fields.length > 0) {
    lines.push('  Field differences:');
    for (const field of conflict.diff.fields) {
      if (field.kind === 'added') {
        lines.push(`    + ${field.path}: ${JSON.stringify(field.after)}`);
      } else if (field.kind === 'removed') {
        lines.push(`    - ${field.path}: ${JSON.stringify(field.before)}`);
      } else {
        lines.push(`    ~ ${field.path}: ${JSON.stringify(field.before)} -> ${JSON.stringify(field.after)}`);
      }
    }
  }
  return lines.join('\n');
}
