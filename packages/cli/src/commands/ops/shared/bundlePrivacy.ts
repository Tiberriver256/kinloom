import {
  type ArchiveBundle,
  ArchiveBundleSchema,
  type BuildMode,
  type CompileArchiveInput,
  type CompileArchiveResult,
  compileArchive,
} from '@kinloom/core';

const YEAR_ONLY_RE = /^\d{4}$/;

export function auditBundlePrivacy(bundle: ArchiveBundle, mode: BuildMode): string[] {
  const livingPeople = bundle.people.filter((p) => Boolean(p.is_living));
  const livingIds = new Set(livingPeople.map((p) => p.id));
  const leaks: string[] = [];

  for (const person of livingPeople) {
    const birthEdtf = person.birth_edtf.trim();
    if (mode === 'public') {
      if (person.full_name !== 'Living') {
        leaks.push(`public:person:${person.id}:full_name`);
      }
      if (birthEdtf.length > 0) {
        leaks.push(`public:person:${person.id}:birth_edtf`);
      }
      if (person.alt_names.length > 0) {
        leaks.push(`public:person:${person.id}:alt_names`);
      }
    } else if (birthEdtf.length > 0 && !YEAR_ONLY_RE.test(birthEdtf)) {
      leaks.push(`private:person:${person.id}:birth_edtf=${birthEdtf}`);
    }
    if (person.primary_place_id) {
      leaks.push(`${mode}:person:${person.id}:primary_place_id`);
    }
    if (person.portrait_url || person.thumb_url) {
      leaks.push(`${mode}:person:${person.id}:portrait`);
    }
    if (typeof person.media_count === 'number' && person.media_count > 0) {
      leaks.push(`${mode}:person:${person.id}:media_count=${person.media_count}`);
    }
  }

  const livingEventIds = new Set<string>();
  for (const ev of bundle.events) {
    const hasLiving = ev.participants.some((pt) => livingIds.has(pt.person_id));
    if (!hasLiving) {
      continue;
    }
    livingEventIds.add(ev.id);
    const edtfDate = ev.edtf_date.trim();
    if (mode === 'private' && edtfDate.length > 0 && !YEAR_ONLY_RE.test(edtfDate)) {
      leaks.push(`private:event:${ev.id}:edtf_date=${edtfDate}`);
    }
    if (ev.place_id) {
      leaks.push(`${mode}:event:${ev.id}:place_id`);
    }
    if (ev.photo_url) {
      leaks.push(`${mode}:event:${ev.id}:photo_url`);
    }
  }

  for (const span of bundle.residence_spans) {
    if (livingIds.has(span.person_id)) {
      leaks.push(`${mode}:residence_span:${span.id}`);
    }
  }

  for (const item of bundle.media ?? []) {
    const linkedLiving =
      Boolean(item.person_id && livingIds.has(item.person_id)) ||
      Boolean(item.person_ids?.some((pid) => livingIds.has(pid))) ||
      Boolean(item.event_id && livingEventIds.has(item.event_id));
    if (linkedLiving) {
      leaks.push(`${mode}:media:${item.id}`);
    }
  }

  for (const nar of bundle.narratives ?? []) {
    if (nar.subject_person_id && livingIds.has(nar.subject_person_id)) {
      leaks.push(`${mode}:narrative:${nar.id}:subject_person_id`);
    }
    if (nar.person_ids.some((pid) => livingIds.has(pid))) {
      leaks.push(`${mode}:narrative:${nar.id}`);
    }
  }

  return leaks;
}

export function compileAndAuditMergedArchive(compileBase: Omit<CompileArchiveInput, 'mode'>): {
  privateResult: CompileArchiveResult;
  publicResult: CompileArchiveResult;
  livingLeaks: number;
} {
  const privateResult = compileArchive({ ...compileBase, mode: 'private' });
  const publicResult = compileArchive({ ...compileBase, mode: 'public' });

  ArchiveBundleSchema.parse(privateResult.bundle);
  ArchiveBundleSchema.parse(publicResult.bundle);

  const privateLeaks = auditBundlePrivacy(privateResult.bundle, 'private');
  const publicLeaks = auditBundlePrivacy(publicResult.bundle, 'public');
  const allLeaks = [...privateLeaks, ...publicLeaks];

  if (allLeaks.length > 0) {
    throw new Error(`PRIVACY LEAK DETECTED (${allLeaks.length}): ${allLeaks.join('; ')}`);
  }
  if (privateResult.reviewFlags.length > 0 || publicResult.reviewFlags.length > 0) {
    throw new Error(
      `PRIVACY REVIEW FLAGS DETECTED (private=${privateResult.reviewFlags.length}, public=${publicResult.reviewFlags.length}): ${[
        ...privateResult.reviewFlags,
        ...publicResult.reviewFlags,
      ].join('; ')}`
    );
  }

  return {
    privateResult,
    publicResult,
    livingLeaks: allLeaks.length,
  };
}
