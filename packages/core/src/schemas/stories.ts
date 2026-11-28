import { z } from 'zod';

export const StoryFormatSchema = z.enum(['documentary', 'scroll', 'map']);
export type StoryFormat = z.infer<typeof StoryFormatSchema>;

export const StoryAspectRatioSchema = z.enum(['16:9', '9:16']);
export type StoryAspectRatio = z.infer<typeof StoryAspectRatioSchema>;

export const StoryCitationSchema = z.object({
  id: z.string().trim().min(1),
  label: z.string().trim().min(1),
  sourceId: z.string().trim().min(1).optional(),
  url: z.string().url().optional(),
  detail: z.string().trim().min(1).optional(),
});
export type StoryCitation = z.infer<typeof StoryCitationSchema>;

export const StoryWordTimestampSchema = z.object({
  word: z.string().trim().min(1),
  startMs: z.number().finite().min(0),
  endMs: z.number().finite().min(0),
});
export type StoryWordTimestamp = z.infer<typeof StoryWordTimestampSchema>;

export const StoryMediaKindSchema = z.enum(['image', 'illustration', 'document', 'map']);
export type StoryMediaKind = z.infer<typeof StoryMediaKindSchema>;

export const StoryMediaRefSchema = z.object({
  asset: z.string().trim().min(1),
  alt: z.string().trim().min(1),
  caption: z.string().trim().min(1).optional(),
  kind: StoryMediaKindSchema.optional(),
});
export type StoryMediaRef = z.infer<typeof StoryMediaRefSchema>;

export const StoryAudioTrackSchema = z.object({
  asset: z.string().trim().min(1),
  durationMs: z.number().finite().positive().optional(),
  wordTimestamps: z.array(StoryWordTimestampSchema).optional(),
});
export type StoryAudioTrack = z.infer<typeof StoryAudioTrackSchema>;

export const StoryStyleSchema = z.object({
  palette: z.enum(['parchment', 'archival-navy', 'sepia']).optional(),
  accentToken: z.enum(['accent-primary', 'accent-secondary']).optional(),
  motion: z.enum(['standard', 'reduced']).optional(),
  captionPosition: z.enum(['bottom', 'overlay']).optional(),
});
export type StoryStyle = z.infer<typeof StoryStyleSchema>;

const StorySlugSchema = z
  .string()
  .trim()
  .min(1)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Story slug must be lowercase kebab-case');

const BaseStorySchema = z.object({
  schemaVersion: z.literal(1).default(1),
  id: z.string().trim().min(1),
  slug: StorySlugSchema,
  personId: z.string().trim().min(1),
  personName: z.string().trim().min(1).optional(),
  title: z.string().trim().min(1),
  subtitle: z.string().trim().min(1).optional(),
  summary: z.string().trim().min(1),
  publishedAt: z.string().trim().min(1).optional(),
  author: z.string().trim().min(1).optional(),
  citations: z.array(StoryCitationSchema),
  style: StoryStyleSchema.optional(),
});

export const DocumentaryBeatSchema = z.object({
  id: z.string().trim().min(1),
  title: z.string().trim().min(1),
  startMs: z.number().finite().min(0),
  durationMs: z.number().finite().positive(),
  narration: z.string(),
  caption: z.string(),
  dateLabel: z.string().trim().min(1).optional(),
  placeLabel: z.string().trim().min(1).optional(),
  media: StoryMediaRefSchema.optional(),
  citationIds: z.array(z.string().trim().min(1)),
  wordTimestamps: z.array(StoryWordTimestampSchema).optional(),
});
export type DocumentaryBeat = z.infer<typeof DocumentaryBeatSchema>;

export const DocumentaryStorySchema = BaseStorySchema.extend({
  format: z.literal('documentary'),
  aspectRatio: StoryAspectRatioSchema.default('16:9'),
  audio: StoryAudioTrackSchema.optional(),
  beats: z.array(DocumentaryBeatSchema).min(1),
});
export type DocumentaryStory = z.infer<typeof DocumentaryStorySchema>;

export const ScrollBeatSchema = z.object({
  id: z.string().trim().min(1),
  key: z.string().trim().min(1),
  title: z.string().trim().min(1),
  body: z.string(),
  caption: z.string(),
  dateLabel: z.string().trim().min(1).optional(),
  placeLabel: z.string().trim().min(1).optional(),
  pullQuote: z.string().trim().min(1).optional(),
  media: StoryMediaRefSchema.optional(),
  citationIds: z.array(z.string().trim().min(1)),
});
export type ScrollBeat = z.infer<typeof ScrollBeatSchema>;

export const ScrollStorySchema = BaseStorySchema.extend({
  format: z.literal('scroll'),
  beats: z.array(ScrollBeatSchema).min(1),
});
export type ScrollStory = z.infer<typeof ScrollStorySchema>;

export const MapCoordinatesSchema = z.object({
  lat: z.number().finite().min(-90).max(90),
  lng: z.number().finite().min(-180).max(180),
});
export type MapCoordinates = z.infer<typeof MapCoordinatesSchema>;

export const MapStopSchema = z.object({
  id: z.string().trim().min(1),
  title: z.string().trim().min(1),
  date: z.string().trim().min(1),
  year: z.number().int().min(1).max(3000),
  placeLabel: z.string().trim().min(1),
  coordinates: MapCoordinatesSchema,
  narrative: z.string(),
  caption: z.string(),
  media: StoryMediaRefSchema.optional(),
  citationIds: z.array(z.string().trim().min(1)),
});
export type MapStop = z.infer<typeof MapStopSchema>;

export const MapStorySchema = BaseStorySchema.extend({
  format: z.literal('map'),
  beats: z.array(MapStopSchema).min(1),
});
export type MapStory = z.infer<typeof MapStorySchema>;

export const SpecialtyStorySchema = z.discriminatedUnion('format', [
  DocumentaryStorySchema,
  ScrollStorySchema,
  MapStorySchema,
]);
export type SpecialtyStory = z.infer<typeof SpecialtyStorySchema>;

export const StoryManifestEntrySchema = z.object({
  id: z.string().trim().min(1),
  slug: StorySlugSchema,
  personId: z.string().trim().min(1),
  personName: z.string().trim().min(1).optional(),
  title: z.string().trim().min(1),
  subtitle: z.string().trim().min(1).optional(),
  summary: z.string().trim().min(1),
  format: StoryFormatSchema,
  beatCount: z.number().int().positive(),
  durationMs: z.number().finite().nonnegative().optional(),
  citationCount: z.number().int().nonnegative(),
  publishedAt: z.string().trim().min(1),
  bundlePath: z.string().trim().min(1).optional(),
});
export type StoryManifestEntry = z.infer<typeof StoryManifestEntrySchema>;

export const StoryManifestSchema = z.object({
  version: z.literal(1),
  updatedAt: z.string().trim().min(1),
  stories: z.array(StoryManifestEntrySchema),
});
export type StoryManifest = z.infer<typeof StoryManifestSchema>;
