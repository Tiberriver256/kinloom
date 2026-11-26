import type { Person } from '@kinloom/core';
import type {
  ArchivalTreeModel,
  LineageSpotlight,
  TreeFamilyUnit,
  TreeUnion,
} from '../../lib/archivalTreeModel.js';
import React from 'react';
import {
  formatCardLifespan,
  formatEarlyLossAgeLabel,
  toRomanNumeral,
} from '../../lib/archivalTreeModel.js';
import { KINLOOM_VOCABULARY } from '../../lib/vocabulary.js';
import { initialsOf, resolveAssetUrl } from '../Atoms.js';

export interface TreePedigreeRollProps {
  readonly model: ArchivalTreeModel;
  readonly spotlight: LineageSpotlight | null;
  readonly selectedPersonId: string | null;
  readonly personThumbMap: ReadonlyMap<string, string>;
  readonly baseUrl: string;
  readonly familyLabel: string;
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
      className={classes}
      data-person-id={person.id}
      aria-label={`Inspect ${person.full_name}`}
      aria-pressed={isSelected}
      onClick={() => {
        onSelect(person);
      }}
    >
      <span className="tree-roll-avatar" aria-hidden="true">
        {thumbUrl ? (
          <img src={thumbUrl} alt="" className="tree-roll-avatar-img" />
        ) : (
          <span className="tree-roll-avatar-initials">{initialsOf(person.full_name)}</span>
        )}
      </span>
      <span className="tree-roll-card-copy">
        <span className="tree-roll-card-name">{person.full_name}</span>
        <span className="tree-roll-card-dates">
          {formatCardLifespan(person)}
          {badgeLabel ? ` · ${badgeLabel}` : ''}
        </span>
      </span>
    </button>
  );
};

interface UnionAttachmentsProps {
  readonly union: TreeUnion;
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

  const secondaryPartner = union.secondaryPartnerId
    ? model.peopleById.get(union.secondaryPartnerId)
    : undefined;
  const marriageCaption =
    union.totalMarriagesForPrimary > 1 && secondaryPartner
      ? `Marriage ${toRomanNumeral(union.marriageOrder)} · ${secondaryPartner.full_name}`
      : null;

  return (
    <div className="tree-roll-attachments">
      {marriageCaption && <div className="tree-roll-union-caption">{marriageCaption}</div>}

      {earlyChildren.length > 0 && (
        <div
          className="tree-early-strip"
          role="group"
          aria-label={KINLOOM_VOCABULARY.tree.diedYoungTooltip}
          title={KINLOOM_VOCABULARY.tree.diedYoungTooltip}
        >
          <span
            className="tree-early-strip-heading"
            title={KINLOOM_VOCABULARY.tree.diedYoungTooltip}
          >
            <svg
              className="tree-early-sprig"
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
          <div className="tree-early-chip-row">
            {earlyChildren.map((child) => {
              const isSelected = selectedPersonId === child.id;
              const isLit = Boolean(spotlight?.highlightedPersonIds.has(child.id));
              const dimmed = hasSelection && !isLit;
              return (
                <button
                  key={child.id}
                  type="button"
                  data-person-id={child.id}
                  className={`tree-node-card tree-early-chip${isSelected ? ' is-selected' : ''}${isLit ? ' is-lit' : ''}${dimmed ? ' is-dimmed' : ''}`}
                  aria-label={`Inspect ${child.full_name}`}
                  aria-pressed={isSelected}
                  onClick={() => {
                    onSelectPerson(child);
                  }}
                >
                  <span className="tree-early-chip-name">{child.given_name || child.full_name}</span>
                  <span className="tree-early-chip-years">{formatEarlyLossAgeLabel(child)}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {totalCollateral > 0 && (
        <div className="tree-roll-siblings-block">
          <button
            type="button"
            className={`tree-sibling-pill${union.isExpanded ? ' is-expanded' : ''}`}
            aria-expanded={union.isExpanded}
            onClick={() => {
              onToggleUnionSiblings(union.id);
            }}
          >
            <span className="tree-sibling-pill-chevron" aria-hidden="true">
              {union.isExpanded ? '▾' : '▸'}
            </span>
            {union.isExpanded
              ? `Hide ${totalCollateral} ${totalCollateral === 1 ? 'sibling' : 'siblings'}`
              : `+${union.collapsedSiblingIds.length} ${union.collapsedSiblingIds.length === 1 ? 'sibling' : 'siblings'}`}
          </button>

          {union.isExpanded && hangingChildren.length > 0 && (
            <div
              className="tree-hanging-grid"
              role="list"
              aria-label={KINLOOM_VOCABULARY.tree.otherSiblingsAria}
            >
              {hangingChildren.map((sibling) => {
                const rawThumb = personThumbMap.get(sibling.id) || sibling.portrait_url;
                const thumbUrl = rawThumb ? resolveAssetUrl(rawThumb, baseUrl) : null;
                const siblingSpouses = (model.spouseMap.get(sibling.id) ?? [])
                  .map((sid) => model.peopleById.get(sid)?.given_name)
                  .filter((name): name is string => Boolean(name));
                return (
                  <div key={sibling.id} className="tree-hanging-grid-item" role="listitem">
                    <RollPersonCard
                      person={sibling}
                      isDirect={false}
                      isSelected={selectedPersonId === sibling.id}
                      isLit={Boolean(spotlight?.highlightedPersonIds.has(sibling.id))}
                      hasSelection={hasSelection}
                      thumbUrl={thumbUrl}
                      badgeLabel={siblingSpouses.length > 0 ? `m. ${siblingSpouses[0]}` : undefined}
                      onSelect={onSelectPerson}
                    />
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
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
  onSelectPerson,
  onToggleUnionSiblings,
}) => {
  const hasSelection = spotlight !== null;

  const resolveThumb = (person: Person): string | null => {
    const raw = personThumbMap.get(person.id) || person.portrait_url;
    return raw ? resolveAssetUrl(raw, baseUrl) : null;
  };

  const renderUnit = (unit: TreeFamilyUnit): React.ReactNode => {
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

    return (
      <div
        key={unit.id}
        className={`tree-roll-unit${unit.isDirect ? ' is-direct' : ' is-collateral'}${isRemarried ? ' is-remarried' : ''}${hasSelection && !isUnitLit ? ' is-dimmed' : ''}`}
      >
        <div className={`tree-roll-couple-row${members.length === 1 ? ' is-single' : ''}`}>
          {members.map((member, idx) => {
            const prevMember = idx > 0 ? members[idx - 1] : null;
            const connectingUnion = prevMember
              ? coupleUnions.find(
                  (u) =>
                    (u.primaryPartnerId === prevMember.id && u.secondaryPartnerId === member.id) ||
                    (u.primaryPartnerId === member.id && u.secondaryPartnerId === prevMember.id),
                )
              : undefined;

            return (
              <React.Fragment key={member.id}>
                {connectingUnion && (
                  <span
                    className={`tree-roll-union-hub${spotlight?.highlightedUnionIds.has(connectingUnion.id) ? ' is-lit' : ''}`}
                    title={
                      connectingUnion.totalMarriagesForPrimary > 1
                        ? `${KINLOOM_VOCABULARY.tree.marriageLabel} ${toRomanNumeral(connectingUnion.marriageOrder)}`
                        : KINLOOM_VOCABULARY.tree.marriageLabel
                    }
                    aria-hidden="true"
                  >
                    {connectingUnion.totalMarriagesForPrimary > 1
                      ? toRomanNumeral(connectingUnion.marriageOrder)
                      : '•'}
                  </span>
                )}
                <RollPersonCard
                  person={member}
                  isDirect={model.directPersonIds.has(member.id)}
                  isSelected={selectedPersonId === member.id}
                  isLit={Boolean(spotlight?.highlightedPersonIds.has(member.id))}
                  hasSelection={hasSelection}
                  thumbUrl={resolveThumb(member)}
                  onSelect={onSelectPerson}
                />
              </React.Fragment>
            );
          })}
        </div>

        {unitUnions.map((union) => (
          <UnionAttachments
            key={union.id}
            union={union}
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
    <div className="tree-roll-viewport">
      {model.generations.length >= 4 && (
        <nav className="tree-gen-jump-bar" aria-label="Jump to generation">
          {model.generations.map((g) => (
            <button
              key={g.gen}
              type="button"
              className="tree-gen-jump-chip"
              onClick={() => {
                const target = document.getElementById(`tree-roll-gen-${g.gen}`);
                target?.scrollIntoView({ behavior: 'smooth', block: 'start' });
              }}
            >
              {g.label}
            </button>
          ))}
        </nav>
      )}

      <div
        className="tree-roll-scroll"
        role="region"
        aria-label={`${familyLabel} ${KINLOOM_VOCABULARY.tree.listRegionSuffix}`}
      >
        <div className="tree-roll-spine-rail" aria-hidden="true" />
        <ol className="tree-roll-generations">
          {model.generations.map((genGroup, idx) => (
            <li
              key={genGroup.gen}
              id={`tree-roll-gen-${genGroup.gen}`}
              className="tree-roll-generation"
            >
              <header className="tree-roll-gen-header">
                <span className="tree-roll-gen-badge">{genGroup.label}</span>
                <span className="tree-roll-gen-years">{genGroup.yearRange}</span>
              </header>
              <div className="tree-roll-gen-units">
                {genGroup.units.map((unit) => renderUnit(unit))}
              </div>
              {idx < model.generations.length - 1 && (
                <div className="tree-roll-gen-connector" aria-hidden="true" />
              )}
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
};
