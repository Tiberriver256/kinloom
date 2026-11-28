import { type PersonContextPayload, REDACTED_RELATIVE_LABEL } from './types.js';
import { asNonEmptyString, formatLifespan } from './yamlScanner.js';

export function formatPersonContextMarkdown(ctx: PersonContextPayload): string {
  const lines: string[] = [];
  const p = ctx.person;

  lines.push(`# Person Context: ${asNonEmptyString(p['full_name'])} (\`${asNonEmptyString(p['id'])}\`)`);
  lines.push('');
  lines.push(`- Repo: \`${ctx.repoDir}\``);
  lines.push(
    `- Slug: \`${asNonEmptyString(p['slug'])}\` | GEDCOM xref: \`${asNonEmptyString(p['gedcom_xref']) || 'none'}\` | Lifespan: \`${formatLifespan(p)}\``
  );
  lines.push('');

  lines.push('## 1. People Record (`data/people.yaml`)');
  lines.push('```json');
  lines.push(JSON.stringify(p, null, 2));
  lines.push('```');
  lines.push('');

  lines.push('## 2. Immediate Relatives (`data/kinship.yaml`)');
  const groups: ReadonlyArray<readonly ['parents' | 'spouses' | 'children', string]> = [
    ['parents', 'Parents'],
    ['spouses', 'Spouses'],
    ['children', 'Children'],
  ];
  for (const [key, label] of groups) {
    const items = ctx.relatives[key];
    lines.push(`### ${label} (${items.length})`);
    if (items.length === 0) {
      lines.push('- None');
    } else {
      for (const rel of items) {
        if (rel === REDACTED_RELATIVE_LABEL) {
          lines.push(`- ${REDACTED_RELATIVE_LABEL}`);
        } else {
          lines.push(
            `- \`${rel.id}\` ${rel.full_name} (${rel.lifespan})${rel.gedcom_xref ? ` [xref: \`${rel.gedcom_xref}\`]` : ''}`
          );
        }
      }
    }
  }
  lines.push('');

  lines.push(`## 3. Existing Events (${ctx.events.length})`);
  if (ctx.events.length === 0) {
    lines.push('- None');
  } else {
    lines.push('```json');
    lines.push(JSON.stringify(ctx.events, null, 2));
    lines.push('```');
  }
  lines.push('');

  lines.push(`## 4. Referenced Places (${ctx.places.length})`);
  if (ctx.places.length === 0) {
    lines.push('- None');
  } else {
    lines.push('```json');
    lines.push(JSON.stringify(ctx.places, null, 2));
    lines.push('```');
  }
  lines.push('');

  lines.push(`## 5. Referenced Sources (${ctx.sources.length})`);
  if (ctx.sources.length === 0) {
    lines.push('- None');
  } else {
    lines.push('```json');
    lines.push(JSON.stringify(ctx.sources, null, 2));
    lines.push('```');
  }
  lines.push('');

  lines.push(`## 6. Linked Media (${ctx.media.length})`);
  if (ctx.media.length === 0) {
    lines.push('- None');
  } else {
    lines.push('```json');
    lines.push(JSON.stringify(ctx.media, null, 2));
    lines.push('```');
  }
  if (ctx.relativeArchiveMedia.length > 0) {
    lines.push('');
    lines.push('### Existing live archive media on confirmed-deceased relatives (reusable IDs)');
    for (const item of ctx.relativeArchiveMedia) {
      lines.push(
        `- \`${item.id}\` file=\`${item.file}\` caption=${item.caption} [${item.relation}: \`${item.relativeId}\`]`
      );
    }
  }
  lines.push('');

  lines.push(`## 7. Existing Narratives (${ctx.narratives.length})`);
  if (ctx.narratives.length === 0) {
    lines.push('- None');
  } else {
    for (const nar of ctx.narratives) {
      const narId = asNonEmptyString(nar['id']);
      const narKind = asNonEmptyString(nar['kind']) || 'narrative';
      const narTitle = asNonEmptyString(nar['title']);
      const narSources = Array.isArray(nar['source_ids']) ? nar['source_ids'].length : 0;
      const bodyMd = typeof nar['body_md'] === 'string' ? nar['body_md'] : '';
      lines.push(`### \`${narId}\` (${narKind}): ${narTitle}`);
      lines.push(
        `- slug: \`${asNonEmptyString(nar['slug'])}\` | subject_person_id: \`${asNonEmptyString(nar['subject_person_id'])}\` | sources: ${narSources} | body_chars: ${bodyMd.length}`
      );
      if (typeof nar['summary'] === 'string' && nar['summary']) {
        lines.push(`- summary: ${nar['summary']}`);
      }
      if (bodyMd) {
        lines.push('');
        lines.push(bodyMd);
      }
      lines.push('');
    }
  }

  lines.push('## 8. External Facts Export Match');
  if (!ctx.ancestry) {
    lines.push('- No matching external facts JSON found.');
  } else if (ctx.ancestry.redacted) {
    lines.push(`- Match: \`${ctx.ancestry.jsonPath}\` (${ctx.ancestry.note})`);
  } else {
    const a = ctx.ancestry;
    lines.push(
      `- Matched via \`${a.matchMode}\`: \`${a.jsonPath}\` (personDbId=\`${a.personDbId}\`, lifeRange=\`${a.lifeRange ?? ''}\`)`
    );
    if (a.redactedLivingFactsCount > 0) {
      lines.push(`- Redacted living-relative facts omitted: ${a.redactedLivingFactsCount}`);
    }
    lines.push(`- Record images on disk (${a.recordImages.length}):`);
    if (a.recordImages.length === 0) {
      lines.push('  - None');
    } else {
      for (const img of a.recordImages) {
        lines.push(
          `  - \`${img.path}\` (${img.bytes} bytes)${img.sourceTitle ? ` - ${img.sourceTitle}` : ''}`
        );
      }
    }
    lines.push(`- Non-living facts (${a.facts.length}):`);
    lines.push('```json');
    lines.push(JSON.stringify(a.facts, null, 2));
    lines.push('```');
    lines.push(`- External sources (${a.sources.length}):`);
    lines.push('```json');
    lines.push(JSON.stringify(a.sources, null, 2));
    lines.push('```');
  }

  const relImgs = ctx.relativeRecordImages;
  lines.push(`- Confirmed-deceased relative record images on disk, deduplicated (${relImgs.length}):`);
  if (relImgs.length === 0) {
    lines.push('  - None');
  } else {
    for (const img of relImgs) {
      lines.push(
        `  - \`${img.path}\` (${img.bytes} bytes) [${img.relation}: \`${img.relativeId}\` ${img.relativeName}]${
          img.sourceTitle ? ` - ${img.sourceTitle}` : ''
        }`
      );
    }
  }

  return `${lines.join('\n')}\n`;
}

export function renderPersonContext(ctx: PersonContextPayload, json: boolean): string {
  return json ? `${JSON.stringify(ctx, null, 2)}\n` : formatPersonContextMarkdown(ctx);
}
