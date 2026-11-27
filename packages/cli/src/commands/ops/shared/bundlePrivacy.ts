import {
  type ArchiveBundle,
  ArchiveBundleSchema,
  type BuildMode,
  type CompileArchiveInput,
  type CompileArchiveResult,
  compileArchiveDual,
  tryValidateArchiveBundle,
} from '@kinloom/core';

const YEAR_ONLY_RE = /^\d{4}$/;

export function auditBundlePrivacy(bundle: ArchiveBundle, mode: BuildMode): string[] {
  const livingPeople: ArchiveBundle['people'][number][] = [];
  const livingIds = new Set<string>();
  for (let i = 0; i < bundle.people.length; i += 1) {
    const p = bundle.people[i];
    if (p.is_living) {
      livingPeople.push(p);
      livingIds.add(p.id);
    }
  }
  if (livingPeople.length === 0) {
    return [];
  }
  const leaks: string[] = [];

  for (let i = 0; i < livingPeople.length; i += 1) {
    const person = livingPeople[i];
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
  for (let i = 0; i < bundle.events.length; i += 1) {
    const ev = bundle.events[i];
    let hasLiving = false;
    for (let p = 0; p < ev.participants.length; p += 1) {
      if (livingIds.has(ev.participants[p].person_id)) {
        hasLiving = true;
        break;
      }
    }
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

  for (let i = 0; i < bundle.residence_spans.length; i += 1) {
    const span = bundle.residence_spans[i];
    if (livingIds.has(span.person_id)) {
      leaks.push(`${mode}:residence_span:${span.id}`);
    }
  }

  const mediaList = bundle.media ?? [];
  for (let i = 0; i < mediaList.length; i += 1) {
    const item = mediaList[i];
    let linkedLiving =
      Boolean(item.person_id && livingIds.has(item.person_id)) ||
      Boolean(item.event_id && livingEventIds.has(item.event_id));
    if (!linkedLiving && item.person_ids) {
      for (let p = 0; p < item.person_ids.length; p += 1) {
        if (livingIds.has(item.person_ids[p])) {
          linkedLiving = true;
          break;
        }
      }
    }
    if (linkedLiving) {
      leaks.push(`${mode}:media:${item.id}`);
    }
  }

  const narList = bundle.narratives ?? [];
  for (let i = 0; i < narList.length; i += 1) {
    const nar = narList[i];
    if (nar.subject_person_id && livingIds.has(nar.subject_person_id)) {
      leaks.push(`${mode}:narrative:${nar.id}:subject_person_id`);
    }
    for (let p = 0; p < nar.person_ids.length; p += 1) {
      if (livingIds.has(nar.person_ids[p])) {
        leaks.push(`${mode}:narrative:${nar.id}`);
        break;
      }
    }
  }

  return leaks;
}

export function compileAndAuditMergedArchive(
  compileBase: Omit<CompileArchiveInput, 'mode'>,
  options?: { skipBundleRevalidation?: boolean }
): {
  privateResult: CompileArchiveResult;
  publicResult: CompileArchiveResult;
  livingLeaks: number;
} {
  const { privateResult, publicResult } = compileArchiveDual(compileBase);

  if (!options?.skipBundleRevalidation) {
    if (!tryValidateArchiveBundle(privateResult.bundle)) {
      ArchiveBundleSchema.parse(privateResult.bundle);
    }
    if (!tryValidateArchiveBundle(publicResult.bundle)) {
      ArchiveBundleSchema.parse(publicResult.bundle);
    }
  }

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
