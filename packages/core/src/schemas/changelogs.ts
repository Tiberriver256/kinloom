import { z } from 'zod';

export const ChangelogCategorySchema = z.enum(['added', 'changed', 'fixed', 'security', 'breaking']);
export type ChangelogCategory = z.infer<typeof ChangelogCategorySchema>;

export const ChangelogChangeSchema = z.object({
  category: ChangelogCategorySchema,
  text: z.string().min(1),
});
export type ChangelogChange = z.infer<typeof ChangelogChangeSchema>;

export const ChangelogEntrySchema = z.object({
  version: z.string().regex(/^\d+\.\d+\.\d+$/, 'Version must follow SemVer x.y.z'),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must follow ISO YYYY-MM-DD'),
  summary: z.string().min(1),
  changes: z.array(ChangelogChangeSchema).min(1),
});
export type ChangelogEntry = z.infer<typeof ChangelogEntrySchema>;

export const ModuleChangelogKindSchema = z.enum(['module', 'server_plugin', 'ui_plugin']);
export type ModuleChangelogKind = z.infer<typeof ModuleChangelogKindSchema>;

export const ModuleChangelogSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  kind: ModuleChangelogKindSchema,
  current_version: z.string().min(1),
  entries: z.array(ChangelogEntrySchema),
});
export type ModuleChangelog = z.infer<typeof ModuleChangelogSchema>;

export const AdminChangelogsResponseSchema = z.object({
  generated_at: z.string().min(1),
  modules: z.array(ModuleChangelogSchema),
  plugins: z.array(ModuleChangelogSchema),
});
export type AdminChangelogsResponse = z.infer<typeof AdminChangelogsResponseSchema>;

export function parseAdminChangelogsResponse(raw: unknown): AdminChangelogsResponse {
  return AdminChangelogsResponseSchema.parse(raw);
}
