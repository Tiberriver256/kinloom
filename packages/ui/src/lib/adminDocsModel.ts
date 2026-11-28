import { type AdminDocEntry, type AdminDocsResponse, validatePluginDocumentation } from '@kinloom/core';
import type { KinloomUiPlugin } from '../plugins/types.js';

export type AdminDocsKindFilter = 'all' | 'core' | 'plugin';

export interface MergeAdminDocsInput {
  readonly serverDocs: AdminDocsResponse | null;
  readonly uiPlugins: readonly KinloomUiPlugin[];
}

export function mergeAdminDocs(input: MergeAdminDocsInput): readonly AdminDocEntry[] {
  const merged: AdminDocEntry[] = [];
  const seenIds = new Set<string>();

  if (input.serverDocs) {
    for (const doc of input.serverDocs.core_docs) {
      if (!seenIds.has(doc.id)) {
        seenIds.add(doc.id);
        merged.push(doc);
      }
    }
    for (const doc of input.serverDocs.plugin_docs) {
      if (!seenIds.has(doc.id)) {
        seenIds.add(doc.id);
        merged.push(doc);
      }
    }
  }

  for (const plugin of input.uiPlugins) {
    if (!plugin.documentation) {
      continue;
    }
    const validated = validatePluginDocumentation(plugin.documentation, `UI plugin '${plugin.id}'`);
    if (seenIds.has(validated.id)) {
      continue;
    }
    seenIds.add(validated.id);
    merged.push({
      id: validated.id,
      title: validated.title,
      summary: validated.summary,
      kind: 'ui_plugin',
      source_id: plugin.id,
      source_name: plugin.name,
      sections: validated.sections,
      ...(validated.externalUrl ? { external_url: validated.externalUrl } : {}),
    });
  }

  return merged;
}

export interface FilterAdminDocsInput {
  readonly docs: readonly AdminDocEntry[];
  readonly kindFilter: AdminDocsKindFilter;
  readonly query: string;
}

export function filterAdminDocs(input: FilterAdminDocsInput): readonly AdminDocEntry[] {
  const needle = input.query.trim().toLowerCase();

  return input.docs.filter((doc) => {
    if (input.kindFilter === 'core' && doc.kind !== 'core') {
      return false;
    }
    if (input.kindFilter === 'plugin' && doc.kind === 'core') {
      return false;
    }
    if (!needle) {
      return true;
    }
    if (
      doc.title.toLowerCase().includes(needle) ||
      doc.summary.toLowerCase().includes(needle) ||
      doc.source_name.toLowerCase().includes(needle) ||
      doc.source_id.toLowerCase().includes(needle)
    ) {
      return true;
    }
    return doc.sections.some(
      (section) =>
        section.heading.toLowerCase().includes(needle) || section.markdown.toLowerCase().includes(needle)
    );
  });
}

export function getAdminDocKindLabel(kind: AdminDocEntry['kind']): string {
  switch (kind) {
    case 'core':
      return 'Core Guide';
    case 'server_plugin':
      return 'Server Plugin';
    case 'ui_plugin':
      return 'UI Plugin';
  }
}
