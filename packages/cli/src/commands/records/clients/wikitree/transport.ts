import { cachedJsonCall, resolveCacheDir } from '../../runtime/cache.js';
import { httpGetJson } from '../../runtime/http.js';
import { type RecordCommandContext, RecordRuntimeError } from '../../runtime/types.js';
import {
  checkStatus,
  isWrappedWikiTreeData,
  type WikiTreeRecord,
  type WrappedWikiTreeData,
} from './domain.js';

const API_BASE = 'https://api.wikitree.com/api.php';
const DEFAULT_APP_ID = 'Kinloom';
const WIKITREE_ALLOWED_HOSTS = ['api.wikitree.com'] as const;

export async function apiCall(
  ctx: RecordCommandContext,
  params: Readonly<Record<string, string | number>>
): Promise<unknown[]> {
  const appId = ctx.env.WIKITREE_APP_ID?.trim() || DEFAULT_APP_ID;
  const search = new URLSearchParams();
  search.set('appId', appId);
  for (const [k, v] of Object.entries(params)) {
    search.set(k, String(v));
  }
  const url = `${API_BASE}?${search.toString()}`;
  const { data } = await httpGetJson<unknown>(url, {
    fetchImpl: ctx.fetchImpl,
    sleepFn: ctx.sleepFn,
    nowMs: ctx.nowMs,
    maxAttempts: 1,
    urlPolicy: { allowedSchemes: ['https:'], allowedHosts: WIKITREE_ALLOWED_HOSTS },
  });
  if (!Array.isArray(data)) {
    throw new RecordRuntimeError(`Unexpected API response: ${JSON.stringify(data)}`);
  }
  return data;
}

export async function cachedApi(options: {
  readonly ctx: RecordCommandContext;
  readonly kind: string;
  readonly params: Readonly<Record<string, string | number>>;
  readonly label: string;
  readonly refresh: boolean;
  readonly ttlHours: number;
  readonly cacheable: (data: readonly unknown[]) => boolean;
}): Promise<{ readonly data: unknown[]; readonly first: WikiTreeRecord; readonly cacheHit: boolean }> {
  const cacheDir = resolveCacheDir({
    env: options.ctx.env,
    envVars: ['KINLOOM_WIKITREE_CACHE_DIR'],
    defaultSubdir: 'kinloom-wikitree',
  });

  const { value: wrapped, cacheHit } = await cachedJsonCall<WrappedWikiTreeData>({
    cacheDir,
    kind: options.kind,
    payload: options.params,
    ttlHours: options.ttlHours,
    refresh: options.refresh,
    fetch: async () => {
      const data = await apiCall(options.ctx, options.params);
      checkStatus(data, options.label);
      return { data };
    },
    cacheable: (r) => options.cacheable(r.data),
    validateCached: isWrappedWikiTreeData,
    nowMs: options.ctx.nowMs,
    sleepFn: options.ctx.sleepFn,
  });

  const first = checkStatus(wrapped.data, options.label);
  return { data: wrapped.data, first, cacheHit };
}
