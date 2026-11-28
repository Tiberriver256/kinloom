import { z } from 'zod';

const SCRIPT_ID_RE = /^[a-z0-9][a-z0-9:_-]{1,118}$/;
const SAFE_ROUTE_RE = /^\/(?!\/)[^\s<>"]*$/;

export const TutorialCaptureActionSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('waitForSelector'),
      selector: z.string().trim().min(1).max(200),
    })
    .strict(),
  z
    .object({
      kind: z.literal('click'),
      selector: z.string().trim().min(1).max(200),
    })
    .strict(),
  z
    .object({
      kind: z.literal('screenshot'),
      name: z.string().trim().regex(SCRIPT_ID_RE),
    })
    .strict(),
]);
export type TutorialCaptureAction = z.infer<typeof TutorialCaptureActionSchema>;

export const TutorialCalloutSchema = z
  .object({
    x: z.number().nonnegative(),
    y: z.number().nonnegative(),
    width: z.number().positive(),
    height: z.number().positive(),
    label: z.string().trim().min(1).max(120),
  })
  .strict();
export type TutorialCallout = z.infer<typeof TutorialCalloutSchema>;

export const TutorialScriptCueSchema = z
  .object({
    text: z.string().trim().min(1).max(600),
    pauseAfterSeconds: z.number().min(0).max(5).default(0.4),
    voice: z.string().trim().min(1).max(64).optional(),
  })
  .strict();
export type TutorialScriptCue = z.infer<typeof TutorialScriptCueSchema>;

export const TutorialScriptStepSchema = z
  .object({
    stepId: z.string().trim().regex(SCRIPT_ID_RE),
    title: z.string().trim().min(1).max(120),
    demoRoute: z.string().trim().regex(SAFE_ROUTE_RE),
    authRole: z.enum(['viewer', 'editor', 'admin']).optional(),
    viewport: z
      .object({
        width: z.number().int().min(320).max(3840),
        height: z.number().int().min(240).max(2160),
      })
      .strict()
      .default({ width: 1280, height: 720 }),
    theme: z.enum(['light', 'dark']).default('light'),
    captureActions: z.array(TutorialCaptureActionSchema).min(1).max(20),
    callout: TutorialCalloutSchema.optional(),
    posterAlt: z.string().trim().min(1).max(240),
    cues: z.array(TutorialScriptCueSchema).min(1).max(20),
  })
  .strict();
export type TutorialScriptStep = z.infer<typeof TutorialScriptStepSchema>;

export const TutorialScriptSchema = z
  .object({
    schemaVersion: z.literal(1),
    chapterId: z.string().trim().regex(SCRIPT_ID_RE),
    title: z.string().trim().min(1).max(120),
    voice: z.string().trim().min(1).max(64).default('Charon'),
    style: z.string().trim().min(1).max(300),
    fps: z.number().int().min(15).max(60).default(30),
    width: z.number().int().min(640).max(3840).default(1280),
    height: z.number().int().min(360).max(2160).default(720),
    steps: z.array(TutorialScriptStepSchema).min(1).max(12),
  })
  .strict()
  .refine((script) => new Set(script.steps.map((s) => s.stepId)).size === script.steps.length, {
    message: 'Step IDs within a tutorial script must be unique.',
  });
export type TutorialScript = z.infer<typeof TutorialScriptSchema>;

const FORBIDDEN_SCRIPT_TEXT_PATTERNS: readonly RegExp[] = [
  new RegExp(`${'[a-z0-9._%+-]+@'}${'gmail\\.com'}`, 'i'),
  new RegExp(['ancestry', 'export'].join('-'), 'i'),
  /\.ged\b/i,
];

export function checkScriptLeakHygiene(rawJsonText: string, fileLabel: string): readonly string[] {
  const findings: string[] = [];
  for (const pattern of FORBIDDEN_SCRIPT_TEXT_PATTERNS) {
    if (pattern.test(rawJsonText)) {
      findings.push(`${fileLabel} matched forbidden pattern ${pattern.toString()}`);
    }
  }
  return findings;
}
