export interface PolarCoord {
  x: number;
  y: number;
  angle: number;
}

function exclusionHalfAngleForRadius(r: number): number {
  if (r <= 60) {
    return 0.62;
  }
  if (r <= 105) {
    return 0.44;
  }
  return 0.34;
}

export function polarPointAvoidingTopLabel(
  cx: number,
  cy: number,
  r: number,
  idx: number,
  total: number,
  ringIndex: 0 | 1 | 2 = 0
): PolarCoord {
  const count = Math.max(1, total);
  const exclusionHalfAngle = exclusionHalfAngleForRadius(r);
  const startAngle = -Math.PI / 2 + exclusionHalfAngle;
  const usableArc = Math.PI * 2 - exclusionHalfAngle * 2;
  const singleOffsets = [0.22, 0.48, 0.78] as const;
  const step = usableArc / count;
  const angle =
    count === 1 ? startAngle + usableArc * singleOffsets[ringIndex] : startAngle + step * (idx + 0.5);

  return {
    x: cx + r * Math.cos(angle),
    y: cy + r * Math.sin(angle),
    angle,
  };
}
