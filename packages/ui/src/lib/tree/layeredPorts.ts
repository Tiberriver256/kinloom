import {
  ARCHIVAL_NODE_W,
  ARCHIVAL_SPOUSE_GAP,
  type ArchivalTreeModel,
  type TreeFamilyUnit,
} from './types.js';

export interface UnionPortSlot {
  readonly unionId: string;
  readonly slotIndex: number;
  readonly totalSlots: number;
  readonly relativeX: number;
  readonly normalizedOffset: number;
  readonly isCouple: boolean;
  readonly leftPartnerId: string;
  readonly rightPartnerId: string | null;
  readonly leftRelX: number;
  readonly rightRelX: number;
}

const PORT_COLLISION_STEP_PX = 16;

interface RawPortEntry {
  readonly unionId: string;
  readonly marriageOrder: number;
  relativeX: number;
  readonly isCouple: boolean;
  readonly leftPartnerId: string;
  readonly rightPartnerId: string | null;
  readonly leftRelX: number;
  readonly rightRelX: number;
}

/**
 * Computes deterministic left-to-right FIXED_ORDER marriage port slots for a family unit.
 * Adjacent couples sit at their shared midpoint; 3+ marriage hubs place each additional union
 * in the inter-card gap immediately beside that spouse so outgoing stems never pass through
 * an intermediate spouse card and never cross immediately below a shared parent.
 */
export function resolveUnitUnionPorts(
  model: ArchivalTreeModel,
  unit: TreeFamilyUnit
): readonly UnionPortSlot[] {
  if (unit.unionIds.length === 0) {
    return [];
  }

  const rawEntries: RawPortEntry[] = [];
  const cardStride = ARCHIVAL_NODE_W + ARCHIVAL_SPOUSE_GAP;

  for (let i = 0; i < unit.unionIds.length; i += 1) {
    const union = model.unionsById.get(unit.unionIds[i]);
    if (!union) {
      continue;
    }
    const primaryIdx = unit.orderedMemberIds.indexOf(union.primaryPartnerId);
    if (primaryIdx < 0) {
      continue;
    }
    const primaryX = primaryIdx * cardStride;
    const secondaryIdx = union.secondaryPartnerId
      ? unit.orderedMemberIds.indexOf(union.secondaryPartnerId)
      : -1;

    if (union.secondaryPartnerId && secondaryIdx >= 0 && secondaryIdx !== primaryIdx) {
      const secondaryX = secondaryIdx * cardStride;
      const isPrimaryLeft = primaryIdx < secondaryIdx;
      const leftPartnerId = isPrimaryLeft ? union.primaryPartnerId : union.secondaryPartnerId;
      const rightPartnerId = isPrimaryLeft ? union.secondaryPartnerId : union.primaryPartnerId;
      const leftRelX = Math.min(primaryX, secondaryX) + ARCHIVAL_NODE_W;
      const rightRelX = Math.max(primaryX, secondaryX);

      let relativeX: number;
      if (Math.abs(secondaryIdx - primaryIdx) === 1) {
        relativeX = Math.round((leftRelX + rightRelX) / 2);
      } else if (secondaryIdx > primaryIdx) {
        relativeX = Math.round(secondaryX - ARCHIVAL_SPOUSE_GAP / 2);
      } else {
        relativeX = Math.round(secondaryX + ARCHIVAL_NODE_W + ARCHIVAL_SPOUSE_GAP / 2);
      }

      rawEntries.push({
        unionId: union.id,
        marriageOrder: union.marriageOrder,
        relativeX,
        isCouple: true,
        leftPartnerId,
        rightPartnerId,
        leftRelX,
        rightRelX,
      });
    } else {
      const centerX = Math.round(primaryX + ARCHIVAL_NODE_W / 2);
      rawEntries.push({
        unionId: union.id,
        marriageOrder: union.marriageOrder,
        relativeX: centerX,
        isCouple: false,
        leftPartnerId: union.primaryPartnerId,
        rightPartnerId: null,
        leftRelX: centerX,
        rightRelX: centerX,
      });
    }
  }

  rawEntries.sort((a, b) => {
    if (a.relativeX !== b.relativeX) {
      return a.relativeX - b.relativeX;
    }
    if (a.marriageOrder !== b.marriageOrder) {
      return a.marriageOrder - b.marriageOrder;
    }
    return a.unionId.localeCompare(b.unionId);
  });

  // Separate any coincident port X positions symmetrically so stems stay distinct.
  let runStart = 0;
  while (runStart < rawEntries.length) {
    let runEnd = runStart + 1;
    while (runEnd < rawEntries.length && rawEntries[runEnd].relativeX === rawEntries[runStart].relativeX) {
      runEnd += 1;
    }
    const runLen = runEnd - runStart;
    if (runLen > 1) {
      const baseCenter = rawEntries[runStart].relativeX;
      const halfSpan = ((runLen - 1) * PORT_COLLISION_STEP_PX) / 2;
      for (let k = 0; k < runLen; k += 1) {
        rawEntries[runStart + k].relativeX = Math.round(baseCenter - halfSpan + k * PORT_COLLISION_STEP_PX);
      }
    }
    runStart = runEnd;
  }

  const totalSlots = rawEntries.length;
  const slots: UnionPortSlot[] = new Array(totalSlots);
  for (let i = 0; i < totalSlots; i += 1) {
    const entry = rawEntries[i];
    const normalizedOffset = totalSlots <= 1 ? 0 : (i / (totalSlots - 1) - 0.5) * 0.8;
    slots[i] = {
      unionId: entry.unionId,
      slotIndex: i,
      totalSlots,
      relativeX: entry.relativeX,
      normalizedOffset,
      isCouple: entry.isCouple,
      leftPartnerId: entry.leftPartnerId,
      rightPartnerId: entry.rightPartnerId,
      leftRelX: entry.leftRelX,
      rightRelX: entry.rightRelX,
    };
  }
  return slots;
}
