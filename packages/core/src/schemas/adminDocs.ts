import { z } from 'zod';

const SafeExternalUrlSchema = z
  .string()
  .trim()
  .url()
  .refine((value) => /^https?:\/\//i.test(value), {
    message: 'External documentation URL must use http:// or https://.',
  });

export const PluginDocumentationSectionSchema = z.object({
  id: z.string().trim().min(1),
  heading: z.string().trim().min(1),
  markdown: z.string().trim().min(1),
});

export interface PluginDocumentationSection {
  readonly id: string;
  readonly heading: string;
  readonly markdown: string;
}

export const PluginDocumentationSchema = z
  .object({
    id: z.string().trim().min(1),
    title: z.string().trim().min(1),
    summary: z.string().trim().min(1),
    sections: z.array(PluginDocumentationSectionSchema).min(1),
    externalUrl: SafeExternalUrlSchema.optional(),
  })
  .superRefine((doc, ctx) => {
    const seenSectionIds = new Set<string>();
    for (let i = 0; i < doc.sections.length; i += 1) {
      const section = doc.sections[i];
      if (!section) {
        continue;
      }
      if (seenSectionIds.has(section.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['sections', i, 'id'],
          message: `Duplicate documentation section id '${section.id}'.`,
        });
      }
      seenSectionIds.add(section.id);
    }
  });

export interface PluginDocumentation {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  readonly sections: readonly PluginDocumentationSection[];
  readonly externalUrl?: string | undefined;
}

export const AdminDocKindSchema = z.enum(['core', 'server_plugin', 'ui_plugin']);
export type AdminDocKind = z.infer<typeof AdminDocKindSchema>;

export const AdminDocEntrySchema = z.object({
  id: z.string().trim().min(1),
  title: z.string().trim().min(1),
  summary: z.string().trim().min(1),
  kind: AdminDocKindSchema,
  source_id: z.string().trim().min(1),
  source_name: z.string().trim().min(1),
  sections: z.array(PluginDocumentationSectionSchema).min(1),
  external_url: SafeExternalUrlSchema.optional(),
});

export interface AdminDocEntry {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  readonly kind: AdminDocKind;
  readonly source_id: string;
  readonly source_name: string;
  readonly sections: readonly PluginDocumentationSection[];
  readonly external_url?: string | undefined;
}

export const AdminDocsResponseSchema = z.object({
  generated_at: z.string().min(1),
  core_docs: z.array(AdminDocEntrySchema),
  plugin_docs: z.array(AdminDocEntrySchema),
});

export interface AdminDocsResponse {
  readonly generated_at: string;
  readonly core_docs: readonly AdminDocEntry[];
  readonly plugin_docs: readonly AdminDocEntry[];
}

/**
 * Validate a plugin's documentation contract at registration or test time.
 * Throws RangeError with a descriptive message if invalid.
 */
export function validatePluginDocumentation(raw: unknown, ownerLabel: string): PluginDocumentation {
  const result = PluginDocumentationSchema.safeParse(raw);
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `${issue.path.join('.') || 'documentation'}: ${issue.message}`)
      .join('; ');
    throw new RangeError(`${ownerLabel} has invalid documentation: ${detail}`);
  }
  return result.data;
}

export function parseAdminDocsResponse(raw: unknown): AdminDocsResponse {
  return AdminDocsResponseSchema.parse(raw);
}
