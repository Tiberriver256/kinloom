import type { Person, Place } from '@kinloom/core';
import React from 'react';
import { Link } from 'react-router-dom';
import type { ArchivalTreeModel, LineageSpotlight } from '../../lib/archivalTreeModel.js';
import { formatCardLifespan } from '../../lib/archivalTreeModel.js';
import { cx, joinClasses } from '../../lib/cx.js';
import { formatLineageGroupLabel } from '../../lib/treeNodeDisplay.js';
import { formatPhotoDocumentCount, KINLOOM_VOCABULARY } from '../../lib/vocabulary.js';
import controlStyles from '../../styles/Controls.module.css';
import { PersonPortrait, resolveAssetUrl } from '../Atoms.js';
import canvasSurfaceStyles from '../CanvasSurfacePrimitives.module.css';
import treeFocusStyles from './TreeFocusDrawer.module.css';

export interface TreeFocusDrawerProps {
  readonly person: Person;
  readonly model: ArchivalTreeModel;
  readonly spotlight: LineageSpotlight | null;
  readonly placesById: ReadonlyMap<string, Place>;
  readonly thumbUrl: string | null;
  readonly baseUrl: string;
  readonly onSelectPerson: (person: Person) => void;
  readonly onClearFocus: () => void;
  readonly activeAnchorPersonId?: string | null;
  readonly onSetAnchorPerson?: (person: Person) => void;
  readonly onResetAnchor?: () => void;
}

function formatCountLabel(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

export const TreeFocusDrawer: React.FC<TreeFocusDrawerProps> = ({
  person,
  model,
  spotlight,
  placesById,
  thumbUrl,
  baseUrl,
  onSelectPerson,
  onClearFocus,
  activeAnchorPersonId = null,
  onSetAnchorPerson,
  onResetAnchor,
}) => {
  const isCurrentAnchor = activeAnchorPersonId === person.id;
  const gen = model.genByPersonId.get(person.id);
  const isEarlyLoss = model.earlyLossIds.has(person.id);
  const spouseCount = spotlight?.immediateSpouseIds.size ?? 0;
  const parentCount = spotlight?.immediateParentIds.size ?? 0;
  const childCount = spotlight?.immediateChildIds.size ?? 0;

  const kinSummaryParts: string[] = [];
  if (parentCount > 0) {
    kinSummaryParts.push(formatCountLabel(parentCount, 'parent', 'parents'));
  }
  if (spouseCount > 0) {
    kinSummaryParts.push(
      spouseCount > 1 ? `${spouseCount} marriages` : formatCountLabel(spouseCount, 'spouse', 'spouses')
    );
  }
  if (childCount > 0) {
    kinSummaryParts.push(formatCountLabel(childCount, 'child', 'children'));
  }

  const vitalDates = person.is_living
    ? formatCardLifespan(person)
    : `${person.birth_edtf || '?'} — ${person.death_edtf || '?'}`;

  const primaryPlace = person.primary_place_id ? placesById.get(person.primary_place_id) : undefined;
  const primaryPlaceName = primaryPlace?.full_name ?? 'Unrecorded';

  const resolvedThumb = thumbUrl ? resolveAssetUrl(thumbUrl, baseUrl) : null;

  return (
    <aside
      className={cx(canvasSurfaceStyles, 'tree-popover tree-focus-drawer')}
      aria-label={`Lineage focus for ${person.full_name}`}
    >
      <div className={cx(treeFocusStyles, 'tree-focus-header')}>
        <div className={cx(treeFocusStyles, 'tree-focus-eyebrow-row')}>
          {gen !== undefined && <span className={cx(treeFocusStyles, 'tree-focus-gen-tag')}>G{gen + 1}</span>}
          <span
            className={cx(treeFocusStyles, 'tree-focus-role-label')}
            title={isEarlyLoss ? KINLOOM_VOCABULARY.tree.diedYoungTooltip : undefined}
          >
            {isEarlyLoss ? KINLOOM_VOCABULARY.tree.diedYoung : formatLineageGroupLabel(person.lineage_group)}
          </span>
          {person.is_living && (
            <span className={cx(treeFocusStyles, 'tree-focus-living-pill')}>
              {KINLOOM_VOCABULARY.tree.livingBadge}
            </span>
          )}
          {isCurrentAnchor && (
            <span className={cx(treeFocusStyles, 'tree-focus-anchor-pill')}>Spine anchor</span>
          )}
        </div>
        <button
          type="button"
          className={joinClasses(cx(controlStyles, 'pill-btn'), cx(treeFocusStyles, 'tree-focus-close-btn'))}
          aria-label="Clear focus"
          onClick={onClearFocus}
        >
          <kbd className="kl-kbd">Esc</kbd>
        </button>
      </div>

      {spotlight && spotlight.breadcrumb.length > 1 && (
        <nav className={cx(treeFocusStyles, 'tree-focus-breadcrumb')} aria-label="Direct ancestor trail">
          {spotlight.breadcrumb.map((ancestor, idx) => {
            const isCurrent = ancestor.id === person.id;
            return (
              <React.Fragment key={ancestor.id}>
                {idx > 0 && (
                  <span className={cx(treeFocusStyles, 'tree-focus-crumb-sep')} aria-hidden="true">
                    ›
                  </span>
                )}
                {isCurrent ? (
                  <span className={cx(treeFocusStyles, 'tree-focus-crumb-current')}>
                    {ancestor.given_name || ancestor.full_name}
                  </span>
                ) : (
                  <button
                    type="button"
                    className={cx(treeFocusStyles, 'tree-focus-crumb-btn')}
                    onClick={() => {
                      onSelectPerson(ancestor);
                    }}
                  >
                    {ancestor.given_name || ancestor.full_name}
                  </button>
                )}
              </React.Fragment>
            );
          })}
        </nav>
      )}

      <div className={cx(treeFocusStyles, 'tree-focus-identity')}>
        <PersonPortrait
          name={person.full_name}
          src={resolvedThumb}
          alt={person.full_name}
          variant="print"
          size="sm"
          loading="eager"
          decorative={false}
        />
        <div className={cx(treeFocusStyles, 'tree-focus-identity-copy')}>
          <h2 className={cx(treeFocusStyles, 'tree-focus-name')}>{person.full_name}</h2>
          <div className={cx(treeFocusStyles, 'tree-focus-dates')}>{vitalDates}</div>
          {spotlight?.relationshipToPivot && spotlight.pivotName && (
            <div className={cx(treeFocusStyles, 'tree-focus-relation')}>
              {spotlight.relationshipToPivot} {spotlight.pivotName}
            </div>
          )}
        </div>
      </div>

      <div className={cx(treeFocusStyles, 'tree-focus-meta')}>
        <div>
          <span className={cx(treeFocusStyles, 'tree-focus-meta-key')}>
            {KINLOOM_VOCABULARY.tree.primaryPlaceLabel}
          </span>{' '}
          {primaryPlace ? (
            <Link to={`/place/${primaryPlace.slug}`} className={cx(treeFocusStyles, 'tree-focus-place-link')}>
              {primaryPlace.full_name}
            </Link>
          ) : (
            primaryPlaceName
          )}
        </div>
        {kinSummaryParts.length > 0 && (
          <div className={cx(treeFocusStyles, 'tree-focus-kin-summary')}>{kinSummaryParts.join(' · ')}</div>
        )}
        {(person.media_count ?? 0) > 0 && (
          <div className={cx(treeFocusStyles, 'tree-focus-media-count')}>
            {formatPhotoDocumentCount(person.media_count ?? 0)} attached
          </div>
        )}
      </div>

      <div className={cx(treeFocusStyles, 'tree-focus-actions')}>
        <Link
          to={`/person/${person.slug}`}
          className={joinClasses(
            cx(controlStyles, 'pill-btn active'),
            cx(treeFocusStyles, 'tree-focus-timeline-link')
          )}
        >
          {KINLOOM_VOCABULARY.tree.openProfileCta}
        </Link>
        {onSetAnchorPerson && !isCurrentAnchor && (
          <button
            type="button"
            className={joinClasses(
              cx(controlStyles, 'pill-btn'),
              cx(treeFocusStyles, 'tree-focus-anchor-btn')
            )}
            onClick={() => {
              onSetAnchorPerson(person);
            }}
          >
            Trace ancestors from here
          </button>
        )}
        {onResetAnchor && isCurrentAnchor && (
          <button
            type="button"
            className={joinClasses(
              cx(controlStyles, 'pill-btn'),
              cx(treeFocusStyles, 'tree-focus-anchor-btn')
            )}
            onClick={onResetAnchor}
          >
            Reset to default
          </button>
        )}
        <button
          type="button"
          className={joinClasses(cx(controlStyles, 'pill-btn'), cx(treeFocusStyles, 'tree-focus-clear-btn'))}
          onClick={onClearFocus}
        >
          {KINLOOM_VOCABULARY.tree.clearFocus}
        </button>
      </div>
    </aside>
  );
};
