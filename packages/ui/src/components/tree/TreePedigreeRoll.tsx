import type { Person } from '@kinloom/core';
import React from 'react';
import { scrollBehaviorForMotion } from '../../hooks/keyboardNav.js';
import type {
  ArchivalTreeModel,
  LineageSpotlight,
  TreeFamilyUnit,
  TreeUnion,
} from '../../lib/archivalTreeModel.js';
import {
  formatCardLifespan,
  formatEarlyLossAgeLabel,
  formatUnionOtherChildrenLabel,
  toRomanNumeral,
} from '../../lib/archivalTreeModel.js';
import { cx } from '../../lib/cx.js';
import { formatTreeCardName } from '../../lib/treeNodeDisplay.js';
import { KINLOOM_VOCABULARY } from '../../lib/vocabulary.js';
import { initialsOf, resolveAssetUrl } from '../Atoms.js';
import pedigreeRollStyles from './TreePedigreeRoll.module.css';

export interface TreePedigreeRollProps {
  readonly model: ArchivalTreeModel;
  readonly spotlight: LineageSpotlight | null;
  readonly selectedPersonId: string | null;
  readonly personThumbMap: ReadonlyMap<string, string>;
  readonly baseUrl: string;
  readonly familyLabel: string;
  readonly branchLabelsById?: ReadonlyMap<string, string>;
  readonly showBranchLabels?: boolean;
  readonly onSelectPerson: (person: Person) => void;
  readonly onToggleUnionSiblings: (unionId: string) => void;
}

interface RollPersonCardProps {
  readonly person: Person;
  readonly isDirect: boolean;
  readonly isSelected: boolean;
  readonly isLit: boolean;
  readonly hasSelection: boolean;
  readonly thumbUrl: string | null;
  readonly badgeLabel?: string;
  readonly spouseLabel?: string;
  readonly onSelect: (person: Person) => void;
}

const RollPersonCard: React.FC<RollPersonCardProps> = ({
  person,
  isDirect,
  isSelected,
  isLit,
  hasSelection,
  thumbUrl,
  badgeLabel,
  spouseLabel,
  onSelect,
}) => {
  const dimmed = hasSelection && !isLit;
  const classes = [
    'tree-node-card',
    'tree-roll-card',
    isDirect ? 'is-direct' : 'is-collateral',
    isSelected ? 'is-selected' : '',
    isLit ? 'is-lit' : '',
    dimmed ? 'is-dimmed' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <button
      type="button"
      className={cx(pedigreeRollStyles, classes)}
      data-person-id={person.id}
      aria-label={`Inspect ${person.full_name}`}
      aria-pressed={isSelected}
      onClick={() => {
        onSelect(person);
      }}
    >
      <span className={cx(pedigreeRollStyles, 'tree-roll-avatar')} aria-hidden="true">
        {thumbUrl ? (
          <img src={thumbUrl} alt="" className={cx(pedigreeRollStyles, 'tree-roll-avatar-img')} />
        ) : (
          <span className={cx(pedigreeRollStyles, 'tree-roll-avatar-initials')}>
            {initialsOf(person.full_name)}
          </span>
        )}
      </span>
      <span className={cx(pedigreeRollStyles, 'tree-roll-card-copy')}>
        <span className={cx(pedigreeRollStyles, 'tree-roll-card-name')}>{person.full_name}</span>
        <span className={cx(pedigreeRollStyles, 'tree-roll-card-dates')}>
          {formatCardLifespan(person)}
          {badgeLabel ? ` · ${badgeLabel}` : ''}
        </span>
        {spouseLabel && (
          <span className={cx(pedigreeRollStyles, 'tree-roll-card-spouse')}>{spouseLabel}</span>
        )}
      </span>
    </button>
  );
};

interface UnionAttachmentsProps {
  readonly union: TreeUnion;
  readonly isRemarriedUnit: boolean;
  readonly anchorId: string;
  readonly fallbackOrder: number;
  readonly model: ArchivalTreeModel;
  readonly spotlight: LineageSpotlight | null;
  readonly selectedPersonId: string | null;
  readonly personThumbMap: ReadonlyMap<string, string>;
  readonly baseUrl: string;
  readonly onSelectPerson: (person: Person) => void;
  readonly onToggleUnionSiblings: (unionId: string) => void;
}

const UnionAttachments: React.FC<UnionAttachmentsProps> = ({
  union,
  isRemarriedUnit,
  anchorId,
  fallbackOrder,
  model,
  spotlight,
  selectedPersonId,
  personThumbMap,
  baseUrl,
  onSelectPerson,
  onToggleUnionSiblings,
}) => {
  const hasSelection = spotlight !== null;
  const totalCollateral = union.collapsedSiblingIds.length + union.hangingChildIds.length;
  const earlyChildren = union.earlyLossChildIds
    .map((cid) => model.peopleById.get(cid))
    .filter((p): p is Person => p !== undefined);
  const hangingChildren = union.hangingChildIds
    .map((cid) => model.peopleById.get(cid))
    .filter((p): p is Person => p !== undefined);

  if (earlyChildren.length === 0 && totalCollateral === 0) {
    return null;
  }

  const otherPartnerId =
    union.primaryPartnerId === anchorId ? union.secondaryPartnerId : union.primaryPartnerId;
  const otherPartner = otherPartnerId ? model.peopleById.get(otherPartnerId) : undefined;
  const showMarriageCaption = isRemarriedUnit || union.totalMarriagesForPrimary > 1;
  const effectiveOrder = union.totalMarriagesForPrimary > 1 ? union.marriageOrder : fallbackOrder;
  const marriageCaption = showMarriageCaption
    ? otherPartner
      ? `Marriage ${toRomanNumeral(effectiveOrder)} · ${otherPartner.full_name}`
      : `Marriage ${toRomanNumeral(effectiveOrder)}`
    : null;

  return (
    <div className={cx(pedigreeRollStyles, 'tree-roll-attachments')}>
      {marriageCaption && (
        <div className={cx(pedigreeRollStyles, 'tree-roll-union-caption')}>{marriageCaption}</div>
      )}

      {earlyChildren.length > 0 && (
        <div
          className={cx(pedigreeRollStyles, 'tree-early-strip')}
          role="group"
          aria-label={KINLOOM_VOCABULARY.tree.diedYoungTooltip}
          title={KINLOOM_VOCABULARY.tree.diedYoungTooltip}
        >
          <span
            className={cx(pedigreeRollStyles, 'tree-early-strip-heading')}
            title={KINLOOM_VOCABULARY.tree.diedYoungTooltip}
          >
            <svg
              className={cx(pedigreeRollStyles, 'tree-early-sprig')}
              viewBox="0 0 16 16"
              width="13"
              height="13"
              aria-hidden="true"
            >
              <path
                d="M8 14V6M8 9C5.5 9 4 7.5 4 5.5C6 5.5 8 7 8 9ZM8 7C10.5 7 12 5.5 12 3.5C10 3.5 8 5 8 7Z"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.35"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            {KINLOOM_VOCABULARY.tree.diedYoung} ({earlyChildren.length})
          </span>
          <div className={cx(pedigreeRollStyles, 'tree-early-chip-row')}>
            {earlyChildren.map((child) => {
              const isSelected = selectedPersonId === child.id;
              const isLit = Boolean(spotlight?.highlightedPersonIds.has(child.id));
              const dimmed = hasSelection && !isLit;
              return (
                <button
                  key={child.id}
                  type="button"
                  data-person-id={child.id}
                  className={cx(
                    pedigreeRollStyles,
                    `tree-node-card tree-early-chip${isSelected ? ' is-selected' : ''}${isLit ? ' is-lit' : ''}${dimmed ? ' is-dimmed' : ''}`
                  )}
                  aria-label={`Inspect ${child.full_name}`}
                  aria-pressed={isSelected}
                  onClick={() => {
                    onSelectPerson(child);
                  }}
                >
                  <span className={cx(pedigreeRollStyles, 'tree-early-chip-name')}>
                    {child.given_name || child.full_name}
                  </span>
                  <span className={cx(pedigreeRollStyles, 'tree-early-chip-years')}>
                    {formatEarlyLossAgeLabel(child)}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {totalCollateral > 0 &&
        (() => {
          const toggleLabels = formatUnionOtherChildrenLabel({
            hiddenCount: union.collapsedSiblingIds.length,
            totalCollateralCount: totalCollateral,
            visibleChildCount: union.visibleChildIds.length,
            isExpanded: union.isExpanded,
            mode: model.effectiveMode,
          });
          return (
            <div className={cx(pedigreeRollStyles, 'tree-roll-siblings-block')}>
              <button
                type="button"
                className={cx(
                  pedigreeRollStyles,
                  `tree-sibling-pill${union.isExpanded ? ' is-expanded' : ''}`
                )}
                aria-expanded={union.isExpanded}
                aria-label={toggleLabels.ariaLabel}
                onClick={() => {
                  onToggleUnionSiblings(union.id);
                }}
              >
                <span className={'tree-sibling-pill-chevron'} aria-hidden="true">
                  {union.isExpanded ? '▾' : '▸'}
                </span>
                <span>{toggleLabels.buttonLabel}</span>
              </button>

              {union.isExpanded && hangingChildren.length > 0 && (
                <div
                  className={cx(pedigreeRollStyles, 'tree-hanging-grid')}
                  role="list"
                  aria-label={KINLOOM_VOCABULARY.tree.otherSiblingsAria}
                >
                  {hangingChildren.map((sibling) => {
                    const rawThumb = personThumbMap.get(sibling.id) || sibling.portrait_url;
                    const thumbUrl = rawThumb ? resolveAssetUrl(rawThumb, baseUrl) : null;
                    const siblingSpouses = (model.spouseMap.get(sibling.id) ?? [])
                      .map((sid) => model.peopleById.get(sid)?.full_name?.trim())
                      .filter((name): name is string => Boolean(name));
                    const spouseLabel =
                      siblingSpouses.length > 0
                        ? `m. ${formatTreeCardName(siblingSpouses[0], 26)}${siblingSpouses.length > 1 ? ` (+${siblingSpouses.length - 1})` : ''}`
                        : undefined;
                    return (
                      <div
                        key={sibling.id}
                        className={cx(pedigreeRollStyles, 'tree-hanging-grid-item')}
                        role="listitem"
                      >
                        <RollPersonCard
                          person={sibling}
                          isDirect={false}
                          isSelected={selectedPersonId === sibling.id}
                          isLit={Boolean(spotlight?.highlightedPersonIds.has(sibling.id))}
                          hasSelection={hasSelection}
                          thumbUrl={thumbUrl}
                          spouseLabel={spouseLabel}
                          onSelect={onSelectPerson}
                        />
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })()}
    </div>
  );
};

export const TreePedigreeRoll: React.FC<TreePedigreeRollProps> = ({
  model,
  spotlight,
  selectedPersonId,
  personThumbMap,
  baseUrl,
  familyLabel,
  branchLabelsById,
  showBranchLabels = false,
  onSelectPerson,
  onToggleUnionSiblings,
}) => {
  const hasSelection = spotlight !== null;

  const resolveThumb = (person: Person): string | null => {
    const raw = personThumbMap.get(person.id) || person.portrait_url;
    return raw ? resolveAssetUrl(raw, baseUrl) : null;
  };

  const renderUnit = (unit: TreeFamilyUnit, isFirstGeneration: boolean): React.ReactNode => {
    const members = unit.orderedMemberIds
      .map((id) => model.peopleById.get(id))
      .filter((p): p is Person => p !== undefined);
    const unitUnions = unit.unionIds
      .map((uid) => model.unionsById.get(uid))
      .filter((u): u is TreeUnion => u !== undefined);
    const coupleUnions = unitUnions.filter((u) => u.kind === 'couple');
    const isRemarried = coupleUnions.length > 1;
    const isUnitLit =
      !hasSelection ||
      unit.orderedMemberIds.some((id) => spotlight.highlightedPersonIds.has(id)) ||
      unitUnions.some((u) => spotlight.highlightedUnionIds.has(u.id));
    const anchorPerson = model.peopleById.get(unit.anchorId) ?? members[0];
    const branchLabel =
      showBranchLabels && isFirstGeneration && anchorPerson?.branch
        ? (branchLabelsById?.get(anchorPerson.branch) ?? anchorPerson.branch)
        : null;

    return (
      <div
        key={unit.id}
        className={cx(
          pedigreeRollStyles,
          `tree-roll-unit${unit.isDirect ? ' is-direct' : ' is-collateral'}${isRemarried ? ' is-remarried' : ''}${hasSelection && !isUnitLit ? ' is-dimmed' : ''}`
        )}
      >
        {branchLabel && (
          <div className={cx(pedigreeRollStyles, 'tree-roll-branch-caption')}>{branchLabel}</div>
        )}
        <div
          className={cx(
            pedigreeRollStyles,
            `tree-roll-couple-row${members.length === 1 ? ' is-single' : ''}`
          )}
        >
          {members.map((member, idx) => {
            const isAnchor = member.id === unit.anchorId;
            const spouseUnion = !isAnchor
              ? coupleUnions.find(
                  (u) =>
                    (u.primaryPartnerId === unit.anchorId && u.secondaryPartnerId === member.id) ||
                    (u.primaryPartnerId === member.id && u.secondaryPartnerId === unit.anchorId)
                )
              : undefined;
            const anchorIdx = members.findIndex((m) => m.id === unit.anchorId);
            const hubBeforeMember = spouseUnion !== undefined && idx > anchorIdx;
            const hubAfterMember = spouseUnion !== undefined && idx < anchorIdx;

            const renderHub = (connectingUnion: TreeUnion): React.ReactNode => {
              const showNumeral = isRemarried || connectingUnion.totalMarriagesForPrimary > 1;
              const orderNum =
                connectingUnion.totalMarriagesForPrimary > 1
                  ? connectingUnion.marriageOrder
                  : Math.max(1, coupleUnions.indexOf(connectingUnion) + 1);
              return (
                <span
                  className={cx(
                    pedigreeRollStyles,
                    `tree-roll-union-hub${spotlight?.highlightedUnionIds.has(connectingUnion.id) ? ' is-lit' : ''}`
                  )}
                  title={
                    showNumeral
                      ? `${KINLOOM_VOCABULARY.tree.marriageLabel} ${toRomanNumeral(orderNum)}`
                      : KINLOOM_VOCABULARY.tree.marriageLabel
                  }
                  aria-hidden="true"
                >
                  {showNumeral ? toRomanNumeral(orderNum) : '•'}
                </span>
              );
            };

            const card = (
              <RollPersonCard
                person={member}
                isDirect={model.directPersonIds.has(member.id)}
                isSelected={selectedPersonId === member.id}
                isLit={Boolean(spotlight?.highlightedPersonIds.has(member.id))}
                hasSelection={hasSelection}
                thumbUrl={resolveThumb(member)}
                onSelect={onSelectPerson}
              />
            );

            if (spouseUnion && (hubBeforeMember || hubAfterMember)) {
              return (
                <div
                  key={member.id}
                  className={cx(pedigreeRollStyles, 'tree-roll-partner-pair')}
                  data-union-id={spouseUnion.id}
                >
                  {hubBeforeMember && renderHub(spouseUnion)}
                  {card}
                  {hubAfterMember && renderHub(spouseUnion)}
                </div>
              );
            }

            return <React.Fragment key={member.id}>{card}</React.Fragment>;
          })}
        </div>

        {unitUnions.map((union, uIdx) => (
          <UnionAttachments
            key={union.id}
            union={union}
            isRemarriedUnit={isRemarried}
            anchorId={unit.anchorId}
            fallbackOrder={uIdx + 1}
            model={model}
            spotlight={spotlight}
            selectedPersonId={selectedPersonId}
            personThumbMap={personThumbMap}
            baseUrl={baseUrl}
            onSelectPerson={onSelectPerson}
            onToggleUnionSiblings={onToggleUnionSiblings}
          />
        ))}
      </div>
    );
  };

  return (
    <div className={cx(pedigreeRollStyles, 'tree-roll-viewport')}>
      {model.generations.length >= 4 && (
        <nav className={cx(pedigreeRollStyles, 'tree-gen-jump-bar')} aria-label="Jump to generation">
          {model.generations.map((g) => (
            <button
              key={g.gen}
              type="button"
              className={cx(pedigreeRollStyles, 'tree-gen-jump-chip')}
              onClick={() => {
                const target = document.getElementById(`tree-roll-gen-${g.gen}`);
                target?.scrollIntoView({ behavior: scrollBehaviorForMotion(), block: 'start' });
              }}
            >
              {g.label}
            </button>
          ))}
        </nav>
      )}

      <div
        className={cx(pedigreeRollStyles, 'tree-roll-scroll')}
        role="region"
        aria-label={`${familyLabel} ${KINLOOM_VOCABULARY.tree.listRegionSuffix}`}
      >
        <ol className={cx(pedigreeRollStyles, 'tree-roll-generations')}>
          {model.generations.map((genGroup, idx) => (
            <li
              key={genGroup.gen}
              id={`tree-roll-gen-${genGroup.gen}`}
              className={cx(pedigreeRollStyles, 'tree-roll-generation')}
            >
              <header className={cx(pedigreeRollStyles, 'tree-roll-gen-header')}>
                <span className={cx(pedigreeRollStyles, 'tree-roll-gen-badge')}>{genGroup.label}</span>
                <span className={cx(pedigreeRollStyles, 'tree-roll-gen-years')}>{genGroup.yearRange}</span>
              </header>
              <div className={cx(pedigreeRollStyles, 'tree-roll-gen-units')}>
                {genGroup.units.map((unit) => renderUnit(unit, idx === 0))}
              </div>
              {idx < model.generations.length - 1 && (
                <div className={cx(pedigreeRollStyles, 'tree-roll-gen-connector')} aria-hidden="true" />
              )}
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
};
