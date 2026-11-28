import { collapseWhitespace } from '../../runtime/parse.js';
import { isPlainRecord } from '../../runtime/primitives.js';
import { RecordRuntimeError } from '../../runtime/types.js';
import {
  ARKIS_MANIFEST_RE,
  BILDVISNING_BASE,
  type CanvasInfo,
  type CollectionItem,
  EM_TAG_RE,
  IIIF_BASE,
  IIIF_COLLECTION_BASE,
  type IiifCollectionResult,
  type IiifManifestResult,
  type NormalizedSearchItem,
  normalizeHttps,
  type RegisterDetailResult,
  type SearchEndpointResult,
  type SearchSnippet,
  stripLeadingUnderscores,
} from './domain.js';

export function firstLangText(value: unknown): string {
  if (typeof value === 'string') {
    return collapseWhitespace(value);
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item === 'string' && item.trim()) {
        return collapseWhitespace(item);
      }
    }
    return '';
  }
  if (isPlainRecord(value)) {
    for (const lang of ['sv', 'en', 'none']) {
      const vals = value[lang];
      if (Array.isArray(vals) && vals.length > 0) {
        return collapseWhitespace(String(vals[0]));
      }
      if (typeof vals === 'string' && vals.trim()) {
        return collapseWhitespace(vals);
      }
    }
    for (const vals of Object.values(value)) {
      if (Array.isArray(vals) && vals.length > 0) {
        return collapseWhitespace(String(vals[0]));
      }
    }
  }
  return '';
}

export function allLangTexts(value: unknown): string[] {
  if (typeof value === 'string') {
    const clean = collapseWhitespace(value);
    return clean ? [clean] : [];
  }
  if (isPlainRecord(value)) {
    for (const lang of ['sv', 'en', 'none']) {
      const vals = value[lang];
      if (Array.isArray(vals) && vals.length > 0) {
        return vals.map((v) => collapseWhitespace(String(v))).filter((v) => v.length > 0);
      }
    }
    for (const vals of Object.values(value)) {
      if (Array.isArray(vals) && vals.length > 0) {
        return vals.map((v) => collapseWhitespace(String(v))).filter((v) => v.length > 0);
      }
    }
  }
  return [];
}

function extractCaptionList(items: unknown): string[] {
  if (!Array.isArray(items)) {
    return [];
  }
  const out: string[] = [];
  for (const entry of items) {
    if (isPlainRecord(entry) && typeof entry['caption'] === 'string' && entry['caption'].trim()) {
      out.push(entry['caption'].trim());
    }
  }
  return out;
}

function optionalTrimmed(value: unknown): string | undefined {
  if (!value) {
    return undefined;
  }
  const trimmed = String(value).trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function normalizeSearchItem(raw: Record<string, unknown>): NormalizedSearchItem {
  const itemId = typeof raw['id'] === 'string' ? raw['id'].trim() : '';
  const objType = typeof raw['objectType'] === 'string' ? raw['objectType'].trim() : '';
  const recType = typeof raw['type'] === 'string' ? raw['type'].trim() : '';
  const meta = isPlainRecord(raw['metadata']) ? raw['metadata'] : {};
  const links = isPlainRecord(raw['_links']) ? raw['_links'] : {};

  const hierarchy = extractCaptionList(meta['hierarchy']);
  const institutions = extractCaptionList(meta['archivalInstitution']);
  let caption = typeof raw['caption'] === 'string' ? raw['caption'].trim() : '';
  if (!caption) {
    if (hierarchy.length > 0) {
      caption = hierarchy.join(' / ');
    } else if (meta['parish'] && meta['fathersName']) {
      caption = `${String(meta['fathersName'])} (${String(meta['parish'])})`;
    } else if (meta['referenceCode']) {
      caption = String(meta['referenceCode']);
    }
  }

  const iiifManifests: string[] = [];
  const rawImages = links['image'];
  if (Array.isArray(rawImages)) {
    for (const img of rawImages) {
      if (typeof img === 'string' && img.startsWith('https://lbiiif.riksarkivet.se/')) {
        iiifManifests.push(img);
      }
    }
  } else if (typeof rawImages === 'string' && rawImages.startsWith('https://lbiiif.riksarkivet.se/')) {
    iiifManifests.push(rawImages);
  }

  const snippets: SearchSnippet[] = [];
  const transcribed = raw['transcribedText'];
  if (isPlainRecord(transcribed) && Array.isArray(transcribed['snippets'])) {
    for (const snip of transcribed['snippets'].slice(0, 5)) {
      if (!isPlainRecord(snip)) {
        continue;
      }
      const text = String(snip['text'] ?? '')
        .replace(EM_TAG_RE, '')
        .trim();
      const pages: string[] = [];
      if (Array.isArray(snip['pages'])) {
        for (const pg of snip['pages']) {
          if (isPlainRecord(pg) && pg['id']) {
            pages.push(stripLeadingUnderscores(String(pg['id'])));
          }
        }
      }
      snippets.push({ text, pages });
      for (const pgId of pages) {
        const volId = pgId.split('_', 1)[0];
        const manifestUrl = `${IIIF_BASE}/arkis!${volId}/manifest`;
        if (!iiifManifests.includes(manifestUrl)) {
          iiifManifests.push(manifestUrl);
        }
      }
    }
  }

  const note = optionalTrimmed(meta['note']);
  const childName = optionalTrimmed(meta['childsName']);
  const father = optionalTrimmed(meta['fathersName']);
  const mother = optionalTrimmed(meta['mothersName']);
  const groom = optionalTrimmed(meta['groomsName']);
  const bride = optionalTrimmed(meta['bridesName']);
  const propertyName = optionalTrimmed(meta['propertyName']);
  const taxUnit = optionalTrimmed(meta['taxUnit']);
  const courtSession = optionalTrimmed(meta['districtCourtSessions']);
  const selfUrl = typeof links['self'] === 'string' ? normalizeHttps(links['self']) : undefined;
  const iiifCollectionUrl =
    (objType === 'Record' || objType === 'RecordSet') && itemId
      ? `${IIIF_COLLECTION_BASE}/${itemId}`
      : undefined;

  return {
    id: itemId,
    object_type: objType,
    type: recType,
    caption,
    reference_code: typeof meta['referenceCode'] === 'string' ? meta['referenceCode'].trim() : '',
    date: String(meta['date'] ?? meta['year'] ?? '').trim(),
    parish: typeof meta['parish'] === 'string' ? meta['parish'].trim() : '',
    institution: institutions[0] ?? '',
    digitized: Boolean(meta['onlyDigitisedMaterials']) || iiifManifests.length > 0,
    ...(hierarchy.length > 0 ? { hierarchy } : {}),
    ...(note !== undefined ? { note } : {}),
    ...(childName !== undefined ? { child_name: childName } : {}),
    ...(father !== undefined ? { father } : {}),
    ...(mother !== undefined ? { mother } : {}),
    ...(groom !== undefined ? { groom } : {}),
    ...(bride !== undefined ? { bride } : {}),
    ...(propertyName !== undefined ? { property_name: propertyName } : {}),
    ...(taxUnit !== undefined ? { tax_unit: taxUnit } : {}),
    ...(courtSession !== undefined ? { court_session: courtSession } : {}),
    ...(snippets.length > 0 ? { snippets } : {}),
    ...(iiifManifests.length > 0 ? { iiif_manifests: iiifManifests } : {}),
    ...(selfUrl !== undefined ? { self_url: selfUrl } : {}),
    ...(iiifCollectionUrl !== undefined ? { iiif_collection_url: iiifCollectionUrl } : {}),
  };
}

export function parseIiifCollectionBody(body: unknown, cleanId: string, url: string): IiifCollectionResult {
  if (!isPlainRecord(body) || body['type'] !== 'Collection') {
    throw new RecordRuntimeError(`Unexpected IIIF Collection payload for ${cleanId}`);
  }

  const summaryLines = allLangTexts(body['summary']);
  let referenceCode = '';
  let institution = '';
  let dateText = '';
  for (const line of summaryLines) {
    if (line.startsWith('Referenskod:')) {
      referenceCode = line.slice('Referenskod:'.length).trim();
    } else if (line.startsWith('Arkivinstitution:')) {
      institution = line.slice('Arkivinstitution:'.length).trim();
    } else if (line.startsWith('Datering:')) {
      dateText = line.slice('Datering:'.length).trim();
    }
  }

  const parsedItems: CollectionItem[] = [];
  const rawItems = Array.isArray(body['items']) ? body['items'] : [];
  for (const entry of rawItems) {
    if (!isPlainRecord(entry)) {
      continue;
    }
    const itemUrl = typeof entry['id'] === 'string' ? entry['id'].trim() : '';
    const itemType = typeof entry['type'] === 'string' ? entry['type'].trim() : '';
    const itemLabel = firstLangText(entry['label']);
    let archiveId: string | undefined;
    let bildid: string | undefined;
    if (itemUrl) {
      try {
        const parsedPath = new URL(itemUrl).pathname;
        if (itemType === 'Collection') {
          const parts = parsedPath.split('/').filter((p) => p.length > 0);
          archiveId = parts.at(-1);
        } else if (itemType === 'Manifest') {
          const match = ARKIS_MANIFEST_RE.exec(parsedPath);
          if (match) {
            bildid = stripLeadingUnderscores(match[1] ?? '');
          }
        }
      } catch {
        // Ignore malformed item URL.
      }
    }
    parsedItems.push({
      type: itemType,
      label: itemLabel,
      url: itemUrl,
      ...(archiveId ? { archive_id: archiveId } : {}),
      ...(bildid ? { bildid } : {}),
    });
  }

  return {
    archive_id: cleanId,
    url,
    label: firstLangText(body['label']),
    reference_code: referenceCode,
    institution,
    date: dateText,
    count: parsedItems.length,
    items: parsedItems,
    verified: true,
  };
}

export function extractCanvasInfo(index: number, canvas: Record<string, unknown>): CanvasInfo {
  const canvasId = typeof canvas['id'] === 'string' ? canvas['id'].trim() : '';
  let pageId = '';
  if (canvasId) {
    try {
      const match = ARKIS_MANIFEST_RE.exec(new URL(canvasId).pathname);
      if (match) {
        pageId = stripLeadingUnderscores(match[1] ?? '');
      }
    } catch {
      // Ignore invalid canvas URL.
    }
  }

  let bildvisningUrl = pageId ? `${BILDVISNING_BASE}/${pageId}` : '';
  let sourceRef = '';
  const metaList = Array.isArray(canvas['metadata']) ? canvas['metadata'] : [];
  for (const meta of metaList) {
    if (!isPlainRecord(meta)) {
      continue;
    }
    const label = firstLangText(meta['label']).toLowerCase();
    const val = firstLangText(meta['value']);
    if ((label === 'bildid' || label === 'image id') && val) {
      pageId = stripLeadingUnderscores(val);
    } else if ((label === 'länk' || label === 'link') && val.startsWith('https://')) {
      bildvisningUrl = val;
    } else if ((label === 'källhänvisning' || label === 'source reference') && val) {
      sourceRef = val;
    }
  }

  const imageBase = pageId ? `${IIIF_BASE}/arkis!${pageId}` : '';
  const fullImageUrl = imageBase ? `${imageBase}/full/max/0/default.jpg` : '';
  return {
    index,
    page_id: pageId,
    label: firstLangText(canvas['label']) || `Image ${index}`,
    width: Number(canvas['width'] ?? 0),
    height: Number(canvas['height'] ?? 0),
    bildvisning_url: bildvisningUrl,
    source_reference: sourceRef,
    iiif_image_base: imageBase,
    full_image_url: fullImageUrl,
  };
}

export function parseIiifManifestBody(body: unknown, volumeId: string, url: string): IiifManifestResult {
  if (!isPlainRecord(body) || body['type'] !== 'Manifest') {
    throw new RecordRuntimeError(`Unexpected IIIF Manifest payload from ${url}`);
  }

  const metadata: Record<string, string> = {};
  const rawMeta = Array.isArray(body['metadata']) ? body['metadata'] : [];
  for (const entry of rawMeta) {
    if (!isPlainRecord(entry)) {
      continue;
    }
    const k = firstLangText(entry['label']);
    const v = firstLangText(entry['value']);
    if (k && v) {
      metadata[k] = v;
    }
  }

  const rawCanvases = Array.isArray(body['items']) ? body['items'] : [];
  const canvases: CanvasInfo[] = [];
  rawCanvases.forEach((canvas, idx) => {
    if (isPlainRecord(canvas)) {
      canvases.push(extractCanvasInfo(idx + 1, canvas));
    }
  });

  return {
    bildid: volumeId,
    manifest_url: url,
    bildvisning_url: `${BILDVISNING_BASE}/${volumeId}`,
    label: firstLangText(body['label']),
    metadata,
    canvas_count: canvases.length,
    canvases,
    verified: true,
  };
}

export function formatSearchText(title: string, result: SearchEndpointResult, cacheHit: boolean): string {
  const marker = cacheHit ? ' [cache]' : '';
  const lines: string[] = [
    `${title} | total=${result.total} | offset=${result.offset} | showing ${result.results.length}${marker}`,
  ];
  for (const item of result.results) {
    const parts: string[] = [item.type || item.object_type || 'Record', item.caption || '(untitled)'];
    if (item.date) parts.push(item.date);
    if (item.parish) parts.push(item.parish);
    if (item.reference_code) parts.push(item.reference_code);
    if (item.father) parts.push(`father: ${item.father}`);
    if (item.mother) parts.push(`mother: ${item.mother}`);
    if (item.groom) parts.push(`groom: ${item.groom}`);
    if (item.bride) parts.push(`bride: ${item.bride}`);
    if (item.digitized) parts.push('[digitized]');
    if (item.id) parts.push(`id=${item.id}`);
    lines.push(parts.join(' | '));
    if (item.iiif_manifests && item.iiif_manifests.length > 0) {
      lines.push(`    iiif: ${item.iiif_manifests[0]}`);
    }
    for (const snip of (item.snippets ?? []).slice(0, 2)) {
      const pageStr = snip.pages.length > 0 ? ` [${snip.pages.join(', ')}]` : '';
      const excerpt = snip.text.length > 160 ? `${snip.text.slice(0, 157)}...` : snip.text;
      lines.push(`    text${pageStr}: ${excerpt}`);
    }
  }
  return lines.join('\n');
}

export function formatRegisterDetailText(
  cleanId: string,
  result: RegisterDetailResult,
  cacheHit: boolean
): string {
  const marker = cacheHit ? ' [cache]' : '';
  const lines: string[] = [`Riksarkivet Register Record (${cleanId})${marker}`];
  for (const [key, value] of Object.entries(result.record)) {
    if (value !== null && value !== undefined && value !== '' && value !== '-') {
      lines.push(`  ${key}: ${String(value)}`);
    }
  }
  lines.push(`  url: ${result.url}`);
  return lines.join('\n');
}

export function formatCollectionText(
  cleanId: string,
  result: IiifCollectionResult,
  cacheHit: boolean
): string {
  const marker = cacheHit ? ' [cache]' : '';
  const lines: string[] = [`${result.label || cleanId} | items=${result.count}${marker}`];
  if (result.reference_code) lines.push(`  Reference: ${result.reference_code}`);
  if (result.institution) lines.push(`  Institution: ${result.institution}`);
  if (result.date) lines.push(`  Date: ${result.date}`);
  for (const item of result.items) {
    const ident = item.bildid ?? item.archive_id ?? '';
    lines.push(`  [${item.type}] ${item.label} | id=${ident} | ${item.url}`);
  }
  return lines.join('\n');
}

export function formatManifestText(
  volId: string,
  result: IiifManifestResult,
  limit: number,
  cacheHit: boolean
): string {
  const marker = cacheHit ? ' [cache]' : '';
  const lines: string[] = [
    `${result.label || volId} | canvases=${result.canvas_count}${marker}`,
    `  Manifest: ${result.manifest_url}`,
    `  Viewer: ${result.bildvisning_url}`,
  ];
  for (const [k, v] of Object.entries(result.metadata)) {
    lines.push(`  ${k}: ${v}`);
  }
  for (const canvas of result.canvases.slice(0, limit)) {
    const dims = canvas.width ? `${canvas.width}x${canvas.height}` : '';
    lines.push(`  p.${canvas.index} | ${canvas.page_id} | ${dims} | ${canvas.full_image_url}`);
  }
  if (result.canvas_count > limit) {
    lines.push(`  ... (${result.canvas_count - limit} more pages; pass --limit or --json to view all)`);
  }
  return lines.join('\n');
}
