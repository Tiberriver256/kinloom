import type { Person, PersonCompletenessSummary, Place, Pronunciation, ResidenceSpan } from '@kinloom/core';
import { resolvePersonPronunciation } from '@kinloom/core';
import type React from 'react';
import { Link } from 'react-router-dom';
import { PersonPortrait } from '../../components/Atoms.js';
import atomStyles from '../../components/Atoms.module.css';
import { PronunciationBadge } from '../../components/PronunciationBadge.js';
import type { RelativeCreateContext } from '../../components/wiki/CreateEntityModal.js';
import { CitationBadge } from '../../components/wiki/WikiBadges.js';
import { cx } from '../../lib/cx.js';
import { isRedactedLivingPlaceholder } from '../../lib/tree/types.js';
import { KINLOOM_VOCABULARY } from '../../lib/vocabulary.js';
import controlStyles from '../../styles/Controls.module.css';
import personStyles from '../PersonPage.module.css';
import { extractBirthYearForLiving, type ImmediateFamilySummary } from './personViewModel.js';

export interface PersonProfileHeaderProps {
  readonly person: Person;
  readonly baseUrl?: string;
  readonly branchLabel: string | null;
  readonly completeness?: PersonCompletenessSummary | null;
  readonly routePlaceCount: number;
  readonly canEdit: boolean;
  readonly pronunciations: Readonly<Record<string, Pronunciation>>;
  readonly immediateFamily: ImmediateFamilySummary;
  readonly residenceSpans: readonly ResidenceSpan[];
  readonly placesById: ReadonlyMap<string, Place>;
  readonly onOpenPortraitLightbox: () => void;
  readonly onEditPronunciation: () => void;
  readonly onExportGedcom: () => void;
  readonly onOpenRelativeModal: (ctx: RelativeCreateContext) => void;
}

export const PersonProfileHeader: React.FC<PersonProfileHeaderProps> = ({
  person,
  baseUrl,
  branchLabel,
  completeness = null,
  routePlaceCount,
  canEdit,
  pronunciations,
  immediateFamily,
  residenceSpans,
  placesById,
  onOpenPortraitLightbox,
  onEditPronunciation,
  onExportGedcom,
  onOpenRelativeModal,
}) => {
  const showFamilyStrip =
    canEdit ||
    immediateFamily.parents.length > 0 ||
    immediateFamily.spouses.length > 0 ||
    immediateFamily.children.length > 0 ||
    (immediateFamily.livingParentCount ?? 0) > 0 ||
    immediateFamily.livingSpouseCount > 0 ||
    immediateFamily.livingChildCount > 0;

  const isRedactedPerson = isRedactedLivingPlaceholder(person);
  const livingBirthYear = person.is_living && !isRedactedPerson ? extractBirthYearForLiving(person) : null;

  const effectivePronunciation =
    !person.is_living && person.full_name !== 'Living'
      ? resolvePersonPronunciation(person, pronunciations)
      : null;
  const showPronunciationRow =
    !person.is_living && person.full_name !== 'Living' && (Boolean(effectivePronunciation) || canEdit);

  return (
    <header className={cx(personStyles, 'person-header')}>
      <div className={cx(personStyles, 'person-header-top')}>
        <div className={cx(personStyles, 'person-header-identity has-portrait')}>
          {person.portrait_url ? (
            <button
              type="button"
              className={cx(personStyles, 'person-portrait-btn')}
              onClick={onOpenPortraitLightbox}
              title="Click to zoom archival portrait"
            >
              <PersonPortrait
                name={person.full_name}
                src={person.portrait_url}
                baseUrl={baseUrl}
                alt={`Archival portrait of ${person.full_name}`}
                variant="print"
                size="lg"
                loading="eager"
                fetchPriority="high"
                decorative={false}
              />
            </button>
          ) : (
            <span className={cx(personStyles, 'person-portrait-slot')}>
              <PersonPortrait name={person.full_name} src={null} variant="print" size="lg" />
            </span>
          )}
          <h1 className={cx(personStyles, 'person-header-title')}>{person.full_name}</h1>
          {showPronunciationRow && (
            <div className={'person-pronunciation-row'}>
              {effectivePronunciation ? (
                <>
                  <PronunciationBadge
                    pronunciation={effectivePronunciation}
                    label={
                      effectivePronunciation.coverage === 'full'
                        ? person.full_name
                        : effectivePronunciation.matchedPart || person.surname || person.full_name
                    }
                    coverage={effectivePronunciation.coverage}
                    matchedPart={effectivePronunciation.matchedPart}
                    baseUrl={baseUrl}
                  />
                  {canEdit && (
                    <button
                      type="button"
                      className={'pronunciation-edit-link print-hide'}
                      onClick={onEditPronunciation}
                      aria-label={`Edit pronunciation for ${person.full_name}`}
                    >
                      {KINLOOM_VOCABULARY.person.editPronunciation}
                    </button>
                  )}
                </>
              ) : (
                <button
                  type="button"
                  className={'pronunciation-edit-link print-hide'}
                  onClick={onEditPronunciation}
                >
                  {KINLOOM_VOCABULARY.person.addPronunciation}
                </button>
              )}
            </div>
          )}
          <div className={cx(personStyles, 'person-header-dates')}>
            {person.is_living ? (
              <span>
                {livingBirthYear !== null ? `b. ${livingBirthYear}` : 'Living'}
                {livingBirthYear !== null && (
                  <span className={cx(personStyles, 'person-living-pill')}>Living</span>
                )}
              </span>
            ) : (
              <span>
                {person.birth_edtf || '?'} — {person.death_edtf || '?'}
              </span>
            )}
            {branchLabel && <span className={cx(personStyles, 'person-branch-badge')}>{branchLabel}</span>}
            {person.has_primary_source !== undefined && (
              <CitationBadge hasPrimarySource={person.has_primary_source} />
            )}
            {completeness && (
              <span
                className={cx(personStyles, `person-completeness-chip tier-${completeness.tier}`)}
                title={completeness.inviteCopy ?? 'Well-documented archival profile'}
              >
                <svg
                  width="24"
                  height="8"
                  viewBox="0 0 24 8"
                  fill="none"
                  aria-hidden="true"
                  className={cx(personStyles, 'person-completeness-pips')}
                >
                  {[0, 1, 2].map((index) => (
                    <circle
                      key={index}
                      cx={4 + index * 8}
                      cy="4"
                      r="2.5"
                      fill={index < completeness.pipCount ? 'currentColor' : 'none'}
                      stroke="currentColor"
                      strokeWidth="1.2"
                    />
                  ))}
                </svg>
                <span className={cx(personStyles, 'visually-hidden')}>
                  {KINLOOM_VOCABULARY.stewardship.completenessPrefix}:{' '}
                </span>
                <span>{completeness.label}</span>
              </span>
            )}
          </div>
          {person.alt_names.length > 0 && (
            <div className={cx(personStyles, 'person-alt-names')}>
              {KINLOOM_VOCABULARY.person.alsoRecordedAs} {person.alt_names.join(', ')}
            </div>
          )}
        </div>
        <div className={cx(personStyles, 'person-header-actions print-hide')}>
          {!isRedactedPerson && (
            <>
              <Link to={`/tree?focus=${person.slug}`} className={cx(atomStyles, 'ink-link-btn')}>
                In Tree
              </Link>
              <Link to={`/kinship?from=${person.slug}`} className={cx(atomStyles, 'ink-link-btn')}>
                Trace Kinship
              </Link>
            </>
          )}
          {routePlaceCount > 1 && (
            <Link to={`/map?person=${person.slug}`} className={cx(atomStyles, 'ink-link-btn')}>
              Their route
            </Link>
          )}
          <button
            type="button"
            className={cx(controlStyles, 'pill-btn print-hide')}
            onClick={onExportGedcom}
            title={`Download family tree file for ${person.full_name}`}
          >
            Export GEDCOM
          </button>
        </div>
      </div>

      {showFamilyStrip && (
        <div
          className={cx(personStyles, 'person-family-strip')}
          role="region"
          aria-label="Immediate family connections"
        >
          {(immediateFamily.parents.length > 0 ||
            (immediateFamily.livingParentCount ?? 0) > 0 ||
            canEdit) && (
            <div className={cx(personStyles, 'person-family-row')}>
              <span className={cx(personStyles, 'person-family-label')}>Parents</span>
              <div className={cx(personStyles, 'person-family-chips')}>
                {immediateFamily.parents.map((rel) => (
                  <Link
                    key={rel.id}
                    to={`/person/${rel.slug}`}
                    className={cx(
                      personStyles,
                      rel.isLiving ? 'person-family-chip is-living' : 'person-family-chip'
                    )}
                  >
                    {rel.name} <span>({rel.years})</span>
                    {rel.isLiving && rel.years !== 'Living' && (
                      <span className={cx(personStyles, 'person-living-pill')}>Living</span>
                    )}
                  </Link>
                ))}
                {(immediateFamily.livingParentCount ?? 0) > 0 && (
                  <span className={cx(personStyles, 'person-family-chip is-redacted')}>
                    {immediateFamily.livingParentCount} living{' '}
                    {immediateFamily.livingParentCount === 1 ? 'parent' : 'parents'} (redacted)
                  </span>
                )}
                {canEdit && (
                  <button
                    type="button"
                    className={cx(personStyles, 'person-family-add-btn print-hide')}
                    onClick={() => {
                      onOpenRelativeModal({
                        anchorPersonId: person.id,
                        anchorPersonName: person.full_name,
                        relation: 'parent',
                      });
                    }}
                  >
                    + Add parent
                  </button>
                )}
              </div>
            </div>
          )}

          {(immediateFamily.spouses.length > 0 || immediateFamily.livingSpouseCount > 0 || canEdit) && (
            <div className={cx(personStyles, 'person-family-row')}>
              <span className={cx(personStyles, 'person-family-label')}>
                {immediateFamily.spouses.length + immediateFamily.livingSpouseCount > 1
                  ? 'Spouses'
                  : 'Spouse'}
              </span>
              <div className={cx(personStyles, 'person-family-chips')}>
                {immediateFamily.spouses.map((rel) => (
                  <Link
                    key={rel.id}
                    to={`/person/${rel.slug}`}
                    className={cx(
                      personStyles,
                      rel.isLiving ? 'person-family-chip is-living' : 'person-family-chip'
                    )}
                  >
                    {rel.name} <span>({rel.years})</span>
                    {rel.isLiving && rel.years !== 'Living' && (
                      <span className={cx(personStyles, 'person-living-pill')}>Living</span>
                    )}
                  </Link>
                ))}
                {immediateFamily.livingSpouseCount > 0 && (
                  <span className={cx(personStyles, 'person-family-chip is-redacted')}>
                    {immediateFamily.livingSpouseCount} living{' '}
                    {immediateFamily.livingSpouseCount === 1 ? 'spouse' : 'spouses'} (redacted)
                  </span>
                )}
                {canEdit && (
                  <button
                    type="button"
                    className={cx(personStyles, 'person-family-add-btn print-hide')}
                    onClick={() => {
                      onOpenRelativeModal({
                        anchorPersonId: person.id,
                        anchorPersonName: person.full_name,
                        relation: 'spouse',
                      });
                    }}
                  >
                    + Add spouse
                  </button>
                )}
              </div>
            </div>
          )}

          {(immediateFamily.children.length > 0 || immediateFamily.livingChildCount > 0 || canEdit) && (
            <div className={cx(personStyles, 'person-family-row')}>
              <span className={cx(personStyles, 'person-family-label')}>Children</span>
              <div className={cx(personStyles, 'person-family-chips')}>
                {immediateFamily.children.map((rel) => (
                  <Link
                    key={rel.id}
                    to={`/person/${rel.slug}`}
                    className={cx(
                      personStyles,
                      rel.isLiving ? 'person-family-chip is-living' : 'person-family-chip'
                    )}
                  >
                    {rel.name} <span>({rel.years})</span>
                    {rel.isLiving && rel.years !== 'Living' && (
                      <span className={cx(personStyles, 'person-living-pill')}>Living</span>
                    )}
                  </Link>
                ))}
                {immediateFamily.livingChildCount > 0 && (
                  <span className={cx(personStyles, 'person-family-chip is-redacted')}>
                    +{immediateFamily.livingChildCount} living{' '}
                    {immediateFamily.livingChildCount === 1 ? 'child' : 'children'} (redacted)
                  </span>
                )}
                {canEdit && (
                  <button
                    type="button"
                    className={cx(personStyles, 'person-family-add-btn print-hide')}
                    onClick={() => {
                      onOpenRelativeModal({
                        anchorPersonId: person.id,
                        anchorPersonName: person.full_name,
                        relation: 'child',
                      });
                    }}
                  >
                    + Add child
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {residenceSpans.length > 0 && (
        <div
          className={cx(personStyles, 'person-family-strip')}
          role="region"
          aria-label="Documented residence spans"
        >
          <div className={cx(personStyles, 'person-family-row')}>
            <span className={cx(personStyles, 'person-family-label')}>Residences</span>
            <div className={cx(personStyles, 'person-family-chips')}>
              {residenceSpans.map((span) => {
                const pl = placesById.get(span.place_id);
                if (!pl) {
                  return null;
                }
                const range =
                  span.start_year && span.end_year
                    ? span.start_year === span.end_year
                      ? String(span.start_year)
                      : `${span.start_year}–${span.end_year}`
                    : 'Undated';
                return (
                  <Link
                    key={span.id}
                    to={`/place/${pl.slug}`}
                    className={cx(personStyles, 'person-family-chip')}
                    title={`${pl.full_name} (${range} · ${span.confidence_tier})`}
                  >
                    {pl.name}{' '}
                    <span>
                      ({range}
                      {span.confidence_tier === 'Possible' ? ' · approx.' : ''})
                    </span>
                  </Link>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </header>
  );
};
