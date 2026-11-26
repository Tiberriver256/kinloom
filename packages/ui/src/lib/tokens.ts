import tokensJson from '@kinloom/tokens/tokens.json' with { type: 'json' };

export const KINLOOM_COLOR_TOKENS = {
  cottonRag: tokensJson.color.primitive['cotton-rag'].$value,
  ragCard: tokensJson.color.primitive['rag-card'].$value,
  warmLinen: tokensJson.color.primitive['warm-linen'].$value,
  mutedRag: tokensJson.color.primitive['muted-rag'].$value,
  archivalIndigo: tokensJson.color.primitive['archival-indigo'].$value,
  ironInk: tokensJson.color.primitive['iron-ink'].$value,
  warmSepia: tokensJson.color.primitive['warm-sepia'].$value,
  loomOchre: tokensJson.color.primitive['loom-ochre'].$value,
  warmBrass: tokensJson.color.primitive['warm-brass'].$value,
  pineMoss: tokensJson.color.primitive['pine-moss'].$value,
  cobaltInk: tokensJson.color.primitive['cobalt-ink'].$value,
  sealCrimson: tokensJson.color.primitive['seal-crimson'].$value,
  slateTaupe: tokensJson.color.primitive['slate-taupe'].$value,
  parchmentHairline: tokensJson.color.primitive['parchment-hairline'].$value,
  amberWash: tokensJson.color.primitive['amber-wash'].$value,
} as const;
