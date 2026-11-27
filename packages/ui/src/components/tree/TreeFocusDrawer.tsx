import type { Person, Place } from '@kinloom/core';
import React from 'react';
import { Link } from 'react-router-dom';
import type { ArchivalTreeModel, LineageSpotlight } from '../../lib/archivalTreeModel.js';
import { formatCardLifespan } from '../../lib/archivalTreeModel.js';
import { cx } from '../../lib/cx.js';
import { formatLineageGroupLabel } from '../../lib/treeNodeDisplay.js';
import { formatPhotoDocumentCount, KINLOOM_VOCABULARY } from '../../lib/vocabulary.js';
import cssMod0 from '../../pages/IndexPage.module.css';
import { initialsOf, resolveAssetUrl } from '../Atoms.js';
import cssMod2 from '../CanvasSurfacePrimitives.module.css';
import cssMod1 from './TreeFocusDrawer.module.css';

const uiStyles: Readonly<Record<string, string>> = { ...cssMod0, ...cssMod2, ...cssMod1 };

export interface TreeFocusDrawerProps {
  readonly person: Person;
  readonly model: ArchivalTreeModel;
  readonly spotlight: LineageSpotlight | null;
  readonly placesById: ReadonlyMap<string, Place>;
  readonly thumbUrl: string | null;
  readonly baseUrl: string;
  readonly onSelectPerson: (person: Person) => void;
  readonly onClearFocus: () => void;
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
}) => {
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

  const primaryPlaceName = person.primary_place_id
    ? (placesById.get(person.primary_place_id)?.full_name ?? 'Unrecorded')
    : 'Unrecorded';

  const resolvedThumb = thumbUrl ? resolveAssetUrl(thumbUrl, baseUrl) : null;

  return (
    <aside
      className={cx(uiStyles, 'tree-popover tree-focus-drawer')}
      aria-label={`Lineage focus for ${person.full_name}`}
    >
      <div className={cx(uiStyles, 'tree-focus-header')}>
        <div className={cx(uiStyles, 'tree-focus-eyebrow-row')}>
          {gen !== undefined && <span className={cx(uiStyles, 'tree-focus-gen-tag')}>G{gen + 1}</span>}
          <span
            className={cx(uiStyles, 'tree-focus-role-label')}
            title={isEarlyLoss ? KINLOOM_VOCABULARY.tree.diedYoungTooltip : undefined}
          >
            {isEarlyLoss ? KINLOOM_VOCABULARY.tree.diedYoung : formatLineageGroupLabel(person.lineage_group)}
          </span>
          {person.is_living && (
            <span className={cx(uiStyles, 'tree-focus-living-pill')}>
              {KINLOOM_VOCABULARY.tree.livingBadge}
            </span>
          )}
        </div>
        <button
          type="button"
          className={cx(uiStyles, 'pill-btn tree-focus-close-btn')}
          aria-label="Clear focus"
          onClick={onClearFocus}
        >
          ✕
        </button>
      </div>

      {spotlight && spotlight.breadcrumb.length > 1 && (
        <nav className={cx(uiStyles, 'tree-focus-breadcrumb')} aria-label="Direct ancestor trail">
          {spotlight.breadcrumb.map((ancestor, idx) => {
            const isCurrent = ancestor.id === person.id;
            return (
              <React.Fragment key={ancestor.id}>
                {idx > 0 && (
                  <span className={cx(uiStyles, 'tree-focus-crumb-sep')} aria-hidden="true">
                    ›
                  </span>
                )}
                {isCurrent ? (
                  <span className={cx(uiStyles, 'tree-focus-crumb-current')}>
                    {ancestor.given_name || ancestor.full_name}
                  </span>
                ) : (
                  <button
                    type="button"
                    className={cx(uiStyles, 'tree-focus-crumb-btn')}
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

      <div className={cx(uiStyles, 'tree-focus-identity')}>
        {resolvedThumb ? (
          <img src={resolvedThumb} alt={person.full_name} className={cx(uiStyles, 'tree-focus-portrait')} />
        ) : (
          <div className={cx(uiStyles, 'tree-focus-monogram')} aria-hidden="true">
            {initialsOf(person.full_name)}
          </div>
        )}
        <div className={cx(uiStyles, 'tree-focus-identity-copy')}>
          <h2 className={cx(uiStyles, 'tree-focus-name')}>{person.full_name}</h2>
          <div className={cx(uiStyles, 'tree-focus-dates')}>{vitalDates}</div>
          {spotlight?.relationshipToPivot && spotlight.pivotName && (
            <div className={cx(uiStyles, 'tree-focus-relation')}>
              {spotlight.relationshipToPivot} {spotlight.pivotName}
            </div>
          )}
        </div>
      </div>

      <div className={cx(uiStyles, 'tree-focus-meta')}>
        <div>
          <span className={cx(uiStyles, 'tree-focus-meta-key')}>
            {KINLOOM_VOCABULARY.tree.primaryPlaceLabel}
          </span>{' '}
          {primaryPlaceName}
        </div>
        {kinSummaryParts.length > 0 && (
          <div className={cx(uiStyles, 'tree-focus-kin-summary')}>{kinSummaryParts.join(' · ')}</div>
        )}
        {(person.media_count ?? 0) > 0 && (
          <div className={cx(uiStyles, 'tree-focus-media-count')}>
            {formatPhotoDocumentCount(person.media_count ?? 0)} attached
          </div>
        )}
      </div>

      <div className={cx(uiStyles, 'tree-focus-actions')}>
        <Link
          to={`/person/${person.slug}`}
          className={cx(uiStyles, 'pill-btn active tree-focus-timeline-link')}
        >
          {KINLOOM_VOCABULARY.tree.openProfileCta}
        </Link>
        <button
          type="button"
          className={cx(uiStyles, 'pill-btn tree-focus-clear-btn')}
          onClick={onClearFocus}
        >
          {KINLOOM_VOCABULARY.tree.clearFocus}
        </button>
      </div>
    </aside>
  );
};
