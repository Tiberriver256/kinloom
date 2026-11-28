import type { Person } from '@kinloom/core';
import type React from 'react';
import { useMemo } from 'react';
import type {
  ArchivalDiagramLayout,
  LineageSpotlight,
  SemanticZoomLevel,
} from '../../lib/archivalTreeModel.js';
import { formatCardLifespan } from '../../lib/archivalTreeModel.js';
import { cx } from '../../lib/cx.js';
import { fitTreeCardNameToWidth } from '../../lib/treeNodeDisplay.js';
import { KINLOOM_VOCABULARY } from '../../lib/vocabulary.js';
import { initialsOf, resolveAssetUrl } from '../Atoms.js';
import treeCanvasStyles from './TreeCanvas.module.css';
import { GenBandsLayer, HangingRailItem, OrthogonalBusItem, UnionHubItem } from './TreeEdgesLayer.js';
import { DiagramNodeCard, EarlyLossStripLayer, SiblingToggleItem } from './TreeNodesLayer.js';

export interface TreeOrthogonalCanvasProps {
  readonly layout: ArchivalDiagramLayout;
  readonly spotlight: LineageSpotlight | null;
  readonly selectedPersonId: string | null;
  readonly anchorPersonId?: string | null;
  readonly semanticZoom: SemanticZoomLevel;
  readonly activeBranchLabel: string;
  readonly personThumbMap: ReadonlyMap<string, string>;
  readonly baseUrl: string;
  readonly onSelectPerson: (person: Person, fromKeyboard: boolean) => void;
  readonly onToggleUnionSiblings: (unionId: string) => void;
}

export const TreeOrthogonalCanvas: React.FC<TreeOrthogonalCanvasProps> = ({
  layout,
  spotlight,
  selectedPersonId,
  anchorPersonId = null,
  semanticZoom,
  activeBranchLabel,
  personThumbMap,
  baseUrl,
  onSelectPerson,
  onToggleUnionSiblings,
}) => {
  const highlightedIds = spotlight?.highlightedPersonIds ?? null;
  const highlightedUnionIds = spotlight?.highlightedUnionIds ?? null;
  const hasSelection = highlightedIds !== null;

  const preparedNodes = useMemo(
    () =>
      layout.nodes.map((node) => {
        const p = node.person;
        const rawThumb = personThumbMap.get(p.id) || p.portrait_url;
        const detailMaxWidthPx = Math.max(80, node.width - 44 - 10);
        const compactMaxWidthPx = Math.max(96, node.width - 24);
        const overviewMaxWidthPx = Math.max(96, node.width - 20);
        return {
          node,
          displayName: fitTreeCardNameToWidth(p.full_name, detailMaxWidthPx, 11.5),
          compactName: fitTreeCardNameToWidth(p.full_name, compactMaxWidthPx, 11.5),
          surnameOrGiven: fitTreeCardNameToWidth(p.full_name, overviewMaxWidthPx, 12),
          lifespan: formatCardLifespan(p),
          thumbUrl: rawThumb ? resolveAssetUrl(rawThumb, baseUrl) : null,
          initials: initialsOf(p.full_name),
        };
      }),
    [layout.nodes, personThumbMap, baseUrl]
  );

  return (
    <svg
      className={cx(
        treeCanvasStyles,
        `tree-canvas tree-canvas-${semanticZoom}${hasSelection ? ' has-selection' : ''}`
      )}
      width={layout.bounds.maxX}
      height={layout.bounds.maxY}
      viewBox={`${layout.bounds.minX} ${layout.bounds.minY} ${layout.bounds.maxX - layout.bounds.minX} ${layout.bounds.maxY - layout.bounds.minY}`}
      role="group"
      aria-label={`${activeBranchLabel} ${KINLOOM_VOCABULARY.tree.chartCanvasSuffix}`}
    >
      <GenBandsLayer genBands={layout.genBands} maxX={layout.bounds.maxX} />

      <g className={'tree-layer-buses'}>
        {layout.buses.map((bus) => (
          <OrthogonalBusItem
            key={bus.unionId}
            bus={bus}
            highlightedIds={highlightedIds}
            isUnionLit={Boolean(highlightedUnionIds?.has(bus.unionId))}
          />
        ))}
      </g>

      <g className={'tree-layer-hanging-rails'}>
        {layout.hangingRails.map((rail) => (
          <HangingRailItem key={`rail-${rail.unionId}`} rail={rail} highlightedIds={highlightedIds} />
        ))}
      </g>

      <g className={'tree-layer-early-strips'}>
        {layout.earlyLossStrips.map((strip) => (
          <EarlyLossStripLayer
            key={`early-${strip.unionId}`}
            strip={strip}
            selectedPersonId={selectedPersonId}
            highlightedIds={highlightedIds}
            onSelect={onSelectPerson}
          />
        ))}
      </g>

      <g className={'tree-layer-sibling-toggles'}>
        {layout.siblingToggles.map((toggle) => (
          <SiblingToggleItem
            key={`toggle-${toggle.unionId}`}
            toggle={toggle}
            isLit={Boolean(highlightedUnionIds?.has(toggle.unionId))}
            onToggle={onToggleUnionSiblings}
          />
        ))}
      </g>

      <g className={'tree-layer-hubs'}>
        {layout.hubs.map((hub) => (
          <UnionHubItem
            key={`hub-${hub.union.id}`}
            hub={hub}
            isLit={Boolean(
              highlightedUnionIds?.has(hub.union.id) ||
                (highlightedIds && hub.union.partnerIds.some((pid) => highlightedIds.has(pid)))
            )}
          />
        ))}
      </g>

      <g className={'tree-layer-nodes'}>
        {preparedNodes.map((prepared) => {
          const pid = prepared.node.person.id;
          return (
            <DiagramNodeCard
              key={pid}
              node={prepared.node}
              displayName={prepared.displayName}
              compactName={prepared.compactName}
              surnameOrGiven={prepared.surnameOrGiven}
              lifespan={prepared.lifespan}
              thumbUrl={prepared.thumbUrl}
              initials={prepared.initials}
              isSelected={selectedPersonId === pid}
              isLit={Boolean(highlightedIds?.has(pid))}
              isAnchor={anchorPersonId === pid}
              semanticZoom={semanticZoom}
              onSelect={onSelectPerson}
            />
          );
        })}
      </g>
    </svg>
  );
};
