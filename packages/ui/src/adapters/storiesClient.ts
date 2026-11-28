import {
  buildStorySummary,
  type SpecialtyStory,
  SpecialtyStorySchema,
  type StoryManifestEntry,
  StoryManifestSchema,
} from '@kinloom/core';

export interface StoriesClient {
  listStories(options?: {
    readonly personId?: string | undefined;
    readonly signal?: AbortSignal | undefined;
  }): Promise<readonly StoryManifestEntry[]>;
  getStory(
    slug: string,
    options?: { readonly signal?: AbortSignal | undefined }
  ): Promise<SpecialtyStory | null>;
}

export interface StaticStoriesClientOptions {
  readonly stories: readonly SpecialtyStory[];
}

export function createStaticStoriesClient(options: StaticStoriesClientOptions): StoriesClient {
  const bySlug = new Map<string, SpecialtyStory>(options.stories.map((s) => [s.slug, s]));
  const summaries: readonly StoryManifestEntry[] = options.stories
    .map((story) => buildStorySummary(story, { bundlePath: `${story.slug}.story.json` }))
    .toSorted((a, b) => a.title.localeCompare(b.title));

  return {
    async listStories(opts = {}): Promise<readonly StoryManifestEntry[]> {
      if (opts.personId) {
        return summaries.filter((s) => s.personId === opts.personId);
      }
      return summaries;
    },
    async getStory(slug: string): Promise<SpecialtyStory | null> {
      return bySlug.get(slug) ?? null;
    },
  };
}

export interface HttpStoriesClientOptions {
  readonly baseUrl?: string | undefined;
  readonly manifestPath?: string | undefined;
  readonly fetchImpl?: typeof fetch | undefined;
}

function joinBase(baseUrl: string, rel: string): string {
  const cleanBase = baseUrl.replace(/\/+$/, '');
  const cleanRel = rel.replace(/^\/+/, '');
  return cleanBase ? `${cleanBase}/${cleanRel}` : `/${cleanRel}`;
}

export function createHttpStoriesClient(options: HttpStoriesClientOptions = {}): StoriesClient {
  const baseUrl = options.baseUrl ?? '';
  const manifestRel = options.manifestPath ?? 'stories/stories-manifest.json';
  const fetchFn = options.fetchImpl ?? globalThis.fetch;

  return {
    async listStories(opts = {}): Promise<readonly StoryManifestEntry[]> {
      const url = joinBase(baseUrl, manifestRel);
      const res = await fetchFn(url, opts.signal ? { signal: opts.signal } : undefined);
      if (!res.ok) {
        return [];
      }
      const parsed = StoryManifestSchema.safeParse(await res.json());
      if (!parsed.success) {
        return [];
      }
      const entries = parsed.data.stories;
      return opts.personId ? entries.filter((s) => s.personId === opts.personId) : entries;
    },
    async getStory(slug: string, opts = {}): Promise<SpecialtyStory | null> {
      const url = joinBase(baseUrl, `stories/${encodeURIComponent(slug)}.story.json`);
      const res = await fetchFn(url, opts.signal ? { signal: opts.signal } : undefined);
      if (!res.ok) {
        return null;
      }
      const parsed = SpecialtyStorySchema.safeParse(await res.json());
      return parsed.success ? parsed.data : null;
    },
  };
}
