export type ArchiveStatus = 'loading' | 'ready' | 'error';

export function deriveArchiveStatus(input: {
  loading: boolean;
  error: string | null;
  bundle: unknown;
}): ArchiveStatus {
  if (input.loading) {
    return 'loading';
  }
  if (input.error || !input.bundle) {
    return 'error';
  }
  return 'ready';
}
