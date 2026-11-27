import type { ArchiveBundle, KinloomSiteConfig, Person, Place, SourceRecord } from '@kinloom/core';
import { buildFilteredGedcom7, buildGedcomExportFilename } from '@kinloom/core';

export function triggerTextDownload(
  filename: string,
  content: string,
  mimeType = 'text/plain;charset=utf-8'
): void {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 1000);
}

export function triggerPersonGedcomDownload(params: {
  readonly person: Person;
  readonly bundle: ArchiveBundle;
  readonly placesById: ReadonlyMap<string, Place>;
  readonly sourcesById: ReadonlyMap<string, SourceRecord>;
  readonly siteConfig: KinloomSiteConfig;
}): void {
  const gedcomText = buildFilteredGedcom7({
    people: [params.person],
    bundle: params.bundle,
    placesById: params.placesById,
    sourcesById: params.sourcesById,
    siteConfig: params.siteConfig,
    filterDescription: `Person Profile: ${params.person.full_name}`,
  });
  const filename = buildGedcomExportFilename({
    familySlug: params.person.slug,
    lineageFilter: 'all',
    selectedEra: 'all',
    onlyWithMedia: false,
    query: '',
    sortBy: 'featured',
    count: 1,
  });
  triggerTextDownload(filename, gedcomText, 'text/vnd.familysearch.gedcom;charset=utf-8');
}
