import { z } from 'zod';
import { OnboardingRoleSchema } from './onboarding.js';

export const TUTORIAL_ID_RE = /^[a-z0-9][a-z0-9:_-]{1,118}$/;
export const SAFE_TUTORIAL_ROUTE_RE = /^\/(?!\/)[^\s<>"]*$/;
export const SAFE_TUTORIAL_MEDIA_URL_RE = /^(?:\/(?!\/)|https:\/\/)[^\s<>"]+$/i;

export function isSafeTutorialRoute(route: string): boolean {
  const trimmed = route.trim();
  if (!SAFE_TUTORIAL_ROUTE_RE.test(trimmed) || trimmed.includes('\\') || trimmed.includes('\u0000')) {
    return false;
  }
  return !trimmed.toLowerCase().startsWith('/javascript:');
}

export function isSafeTutorialMediaUrl(url: string): boolean {
  const trimmed = url.trim();
  if (!SAFE_TUTORIAL_MEDIA_URL_RE.test(trimmed) || trimmed.includes('\\') || trimmed.includes('\u0000')) {
    return false;
  }
  return !trimmed.toLowerCase().startsWith('/javascript:');
}

const SafeTutorialRouteSchema = z
  .string()
  .trim()
  .refine(isSafeTutorialRoute, 'Route must be a safe internal path starting with "/".');

const SafeTutorialMediaUrlSchema = z
  .string()
  .trim()
  .refine(
    isSafeTutorialMediaUrl,
    'Media URL must be a safe relative path starting with "/" or an https:// URL.'
  );

export const TutorialCaptionCueSchema = z
  .object({
    startSeconds: z.number().min(0),
    endSeconds: z.number().positive(),
    text: z.string().trim().min(1).max(600),
  })
  .strict()
  .refine((cue) => cue.endSeconds > cue.startSeconds, {
    message: 'Caption cue endSeconds must be greater than startSeconds.',
  });
export type TutorialCaptionCue = z.infer<typeof TutorialCaptionCueSchema>;

export const TutorialStepMediaSchema = z
  .object({
    /** Compact H.264 MP4 URL (relative to baseUrl/tutorialsBaseUrl or absolute https://). */
    videoMp4Url: SafeTutorialMediaUrlSchema.optional(),
    /** Optional VP9/Opus WebM alternate source. */
    videoWebmUrl: SafeTutorialMediaUrlSchema.optional(),
    /** Poster frame for <video poster="..."> and reduced-motion static slide fallback. */
    posterUrl: SafeTutorialMediaUrlSchema.optional(),
    /** Accessible alt text describing the visual frame when shown as a static slide. */
    posterAlt: z.string().trim().min(1).max(240),
    /** Synchronized WebVTT closed-captions file URL (<track kind="captions">). */
    captionsVttUrl: SafeTutorialMediaUrlSchema.optional(),
    /** Spoken duration in whole seconds (used for chapter runtime badge and progress bar). */
    durationSeconds: z.number().int().positive().max(600).optional(),
  })
  .strict();
export type TutorialStepMedia = z.infer<typeof TutorialStepMediaSchema>;

export const KinloomTutorialStepSchema = z
  .object({
    id: z
      .string()
      .trim()
      .regex(TUTORIAL_ID_RE, 'Tutorial step id must match /^[a-z0-9][a-z0-9:_-]{1,118}$/.'),
    title: z.string().trim().min(1).max(100),
    /** Concise plain-English instructions shown alongside or in place of video. */
    instructions: z.string().trim().min(1).max(500),
    /** Full spoken narration transcript for accessibility and zero-video fallback. */
    transcript: z.string().trim().min(1).max(2000),
    /** Optional interactive route deep-link ("Try it now" button closes modal and navigates). */
    targetRoute: SafeTutorialRouteSchema.optional(),
    targetRouteLabel: z.string().trim().min(1).max(60).optional(),
    /** Optional key highlights rendered as scannable bullet points on the step card. */
    highlights: z.array(z.string().trim().min(1).max(160)).max(5).optional(),
    /** Optional video/poster/captions media descriptors. Omit for card-only chapters. */
    media: TutorialStepMediaSchema.optional(),
  })
  .strict();
export type KinloomTutorialStep = z.infer<typeof KinloomTutorialStepSchema>;

export const KinloomTutorialChapterSchema = z
  .object({
    /** Globally unique stable ID. Core uses `core-*`; plugins MUST namespace `<pluginId>:<slug>`. */
    id: z
      .string()
      .trim()
      .regex(TUTORIAL_ID_RE, 'Tutorial chapter id must match /^[a-z0-9][a-z0-9:_-]{1,118}$/.'),
    title: z.string().trim().min(1).max(100),
    summary: z.string().trim().min(1).max(260),
    /** Minimum hierarchical role ('viewer' < 'editor' < 'admin'). Defaults to 'viewer'. */
    minRole: OnboardingRoleSchema.default('viewer'),
    /** Optional exact role list overriding minRole when restricting strictly (e.g. ['admin']). */
    roles: z.array(OnboardingRoleSchema).min(1).max(3).optional(),
    /** Sort order: core chapters use 10..90; plugin chapters default to 200. */
    order: z.number().int().min(0).max(9999).default(200),
    /** Estimated duration in seconds displayed in the chapter sidebar. */
    estimatedSeconds: z.number().int().positive().max(1800).optional(),
    steps: z.array(KinloomTutorialStepSchema).min(1).max(12),
  })
  .strict()
  .refine((chapter) => new Set(chapter.steps.map((s) => s.id)).size === chapter.steps.length, {
    message: 'Step IDs within a tutorial chapter must be unique.',
  });
export type KinloomTutorialChapter = z.infer<typeof KinloomTutorialChapterSchema>;
export type KinloomTutorialChapterInput = z.input<typeof KinloomTutorialChapterSchema>;

/** Manifest emitted by the Remotion + Gemini TTS pipeline mapping chapter/step IDs to rendered assets. */
export const TutorialMediaManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    generatedAt: z.string().min(1),
    ttsModel: z.string().min(1),
    voice: z.string().min(1),
    chapters: z.record(
      z.string().regex(TUTORIAL_ID_RE),
      z
        .object({
          durationSeconds: z.number().int().positive(),
          steps: z.record(z.string().regex(TUTORIAL_ID_RE), TutorialStepMediaSchema),
        })
        .strict()
    ),
  })
  .strict();
export type TutorialMediaManifest = z.infer<typeof TutorialMediaManifestSchema>;

export const SiteTutorialsConfigSchema = z
  .object({
    /** Optional same-origin or https:// base URL where rendered tutorial video/poster/VTT files are hosted. */
    mediaBaseUrl: SafeTutorialMediaUrlSchema.optional(),
  })
  .strict();
export type SiteTutorialsConfig = z.infer<typeof SiteTutorialsConfigSchema>;
