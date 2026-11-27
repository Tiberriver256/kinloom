import { describe, expect, it } from 'vitest';
import { type ArchiveApiErrorShape, isArchiveApiError } from './contractsUi.js';

describe('isArchiveApiError', () => {
  it('accepts Error subclasses and plain objects matching ArchiveApiErrorShape', () => {
    class CustomApiError extends Error implements ArchiveApiErrorShape {
      readonly status: number;
      readonly code: string;
      readonly details?: unknown;

      constructor(status: number, code: string, message: string, details?: unknown) {
        super(message);
        this.status = status;
        this.code = code;
        this.details = details;
      }
    }

    expect(isArchiveApiError(new CustomApiError(403, 'INVITE_REQUIRED', 'Invite required'))).toBe(true);
    expect(isArchiveApiError({ status: 409, code: 'OPTIMISTIC_CONFLICT' })).toBe(true);
    expect(isArchiveApiError({ status: 422, code: 'VALIDATION_ERROR', message: 'Bad field' })).toBe(true);
  });

  it('rejects non-objects, plain Errors, missing codes, and invalid field types', () => {
    expect(isArchiveApiError(null)).toBe(false);
    expect(isArchiveApiError(undefined)).toBe(false);
    expect(isArchiveApiError('error')).toBe(false);
    expect(isArchiveApiError(new Error('plain error'))).toBe(false);
    expect(isArchiveApiError({ status: 500, code: '' })).toBe(false);
    expect(isArchiveApiError({ status: Number.NaN, code: 'FAIL' })).toBe(false);
    expect(isArchiveApiError({ status: 400, code: 'BAD', message: 123 })).toBe(false);
  });
});
