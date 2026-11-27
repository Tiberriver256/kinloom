import type { PronounceAuditResult } from './types.js';

export function formatAuditText(result: Omit<PronounceAuditResult, 'rendered'>): string {
  const s = result.summary;
  const lines: string[] = [
    `Pronunciation Audit (${result.repo})`,
    `  Pronunciation Lexicon entries: ${s.lexicon_entries} | Living excluded: ${s.living_people_excluded}`,
    `  Deceased Full-Name Pronunciation coverage: ${s.deceasedFullCoverage}/${s.deceasedTotal} (Surname/Partial: ${s.deceasedPartialOnly}, missing: ${s.deceasedMissing})`,
    `  Places coverage: ${s.placesCovered}/${s.placesTotal} (missing: ${s.placesMissing})`,
    `  Living pronunciation leaks: ${s.livingLeaks}`,
    `  Homonymous bare place collisions: ${s.homonymous_place_collisions}`,
    `  Unsourced entries: ${s.unsourced_entries} | IPA / quality warnings: ${s.ipa_quality_warnings} | Redundant person overrides: ${s.redundant_person_overrides}`,
  ];

  if (result.living_leaks.length > 0) {
    lines.push('', `LIVING PRONUNCIATION LEAKS (${result.living_leaks.length}) [FAIL]:`);
    for (const leak of result.living_leaks) {
      lines.push(`  - [${leak.scope}] ${leak.location}: ${leak.reason}`);
    }
  }

  if (result.coverage_gaps.people_missing.length > 0) {
    lines.push('', `Deceased people missing pronunciation (${result.coverage_gaps.people_missing.length}):`);
    for (const p of result.coverage_gaps.people_missing.slice(0, 25)) {
      lines.push(`  - ${p.id}: ${p.full_name}`);
    }
    if (result.coverage_gaps.people_missing.length > 25) {
      lines.push(`  ... and ${result.coverage_gaps.people_missing.length - 25} more.`);
    }
  }

  if (result.coverage_gaps.people_partial.length > 0) {
    lines.push(
      '',
      `Deceased people with Surname Pronunciation or Partial Pronunciation (${result.coverage_gaps.people_partial.length}):`
    );
    for (const p of result.coverage_gaps.people_partial.slice(0, 25)) {
      const missingStr = p.missing_parts.length > 0 ? ` (missing: ${p.missing_parts.join(', ')})` : '';
      lines.push(`  - ${p.id}: ${p.full_name} [${p.coverage}]${missingStr}`);
    }
    if (result.coverage_gaps.people_partial.length > 25) {
      lines.push(`  ... and ${result.coverage_gaps.people_partial.length - 25} more.`);
    }
  }

  if (result.coverage_gaps.places.length > 0) {
    lines.push('', `Places missing pronunciation (${result.coverage_gaps.places.length}):`);
    for (const p of result.coverage_gaps.places.slice(0, 25)) {
      lines.push(`  - ${p.id}: ${p.full_name} (${p.reason})`);
    }
    if (result.coverage_gaps.places.length > 25) {
      lines.push(`  ... and ${result.coverage_gaps.places.length - 25} more.`);
    }
  }

  if (result.homonymous_place_collisions.length > 0) {
    lines.push('', 'Homonymous bare place collisions:');
    for (const c of result.homonymous_place_collisions) {
      const list = c.places.map((p) => `${p.id} (${p.full_name})`).join('; ');
      lines.push(`  - "${c.lexicon_key}" matches multiple places: ${list}`);
      lines.push(`    -> ${c.recommendation}`);
    }
  }

  if (result.ipa_quality_warnings.length > 0) {
    lines.push('', 'IPA / quality warnings:');
    for (const w of result.ipa_quality_warnings) {
      lines.push(`  - [${w.scope}:${w.key}] (${w.code}) ${w.message}`);
    }
  }

  if (result.redundant_person_overrides.length > 0) {
    lines.push(
      '',
      `Redundant per-person overrides (${result.redundant_person_overrides.length} — run \`kinloom pronounce deduplicate\`):`
    );
    for (const r of result.redundant_person_overrides.slice(0, 25)) {
      lines.push(`  - ${r.id}: ${r.full_name} (matches shared "${r.composed_phonetic ?? ''}")`);
    }
    if (result.redundant_person_overrides.length > 25) {
      lines.push(`  ... and ${result.redundant_person_overrides.length - 25} more.`);
    }
  }

  if (result.unsourced_entries.length > 0) {
    lines.push('', `Unsourced entries (${result.unsourced_entries.length}):`);
    for (const u of result.unsourced_entries.slice(0, 25)) {
      lines.push(
        `  - [${u.scope}] ${u.label}${u.missing_note ? ' (missing source and note)' : ' (missing source_url/source_label)'}`
      );
    }
    if (result.unsourced_entries.length > 25) {
      lines.push(`  ... and ${result.unsourced_entries.length - 25} more.`);
    }
  }

  if (result.coverage_gaps.surnames.length > 0) {
    lines.push('', `Missing deceased surnames (${result.coverage_gaps.surnames.length}):`);
    for (const g of result.coverage_gaps.surnames.slice(0, 20)) {
      lines.push(`  - ${g.surname} (${g.deceased_count} deceased)`);
    }
    if (result.coverage_gaps.surnames.length > 20) {
      lines.push(`  ... and ${result.coverage_gaps.surnames.length - 20} more.`);
    }
  }

  return lines.join('\n');
}
