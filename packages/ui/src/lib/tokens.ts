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

export const KINLOOM_DARK_COLOR_TOKENS = {
  charcoalFolio: tokensJson.color.primitiveDark['charcoal-folio'].$value,
  slateCard: tokensJson.color.primitiveDark['slate-card'].$value,
  smokedLinen: tokensJson.color.primitiveDark['smoked-linen'].$value,
  mutedSlate: tokensJson.color.primitiveDark['muted-slate'].$value,
  parchmentHeading: tokensJson.color.primitiveDark['parchment-heading'].$value,
  obsidianBar: tokensJson.color.primitiveDark['obsidian-bar'].$value,
  parchmentInk: tokensJson.color.primitiveDark['parchment-ink'].$value,
  warmStone: tokensJson.color.primitiveDark['warm-stone'].$value,
  warmBrass: tokensJson.color.primitiveDark['warm-brass'].$value,
  verdigrisSage: tokensJson.color.primitiveDark['verdigris-sage'].$value,
  archivalSky: tokensJson.color.primitiveDark['archival-sky'].$value,
  vermilionTint: tokensJson.color.primitiveDark['vermilion-tint'].$value,
  pewterTaupe: tokensJson.color.primitiveDark['pewter-taupe'].$value,
  umberHairline: tokensJson.color.primitiveDark['umber-hairline'].$value,
  amberUmberWash: tokensJson.color.primitiveDark['amber-umber-wash'].$value,
  nightWater: tokensJson.color.primitiveDark['night-water'].$value,
} as const;

export interface ResolvedThemeColorTokens {
  readonly isDark: boolean;
  readonly land: string;
  readonly water: string;
  readonly route: string;
  readonly routeLatest: string;
  readonly futureStop: string;
  readonly futureStopStroke: string;
  readonly haloFill: string;
  readonly haloStroke: string;
  readonly stopDefault: string;
  readonly stopStroke: string;
  readonly labelColor: string;
  readonly labelHalo: string;
  readonly eraPalette: readonly string[];
}

const LIGHT_RESOLVED_TOKENS: ResolvedThemeColorTokens = {
  isDark: false,
  land: KINLOOM_COLOR_TOKENS.warmLinen,
  water: '#D4E1E8',
  route: KINLOOM_COLOR_TOKENS.loomOchre,
  routeLatest: KINLOOM_COLOR_TOKENS.sealCrimson,
  futureStop: KINLOOM_COLOR_TOKENS.slateTaupe,
  futureStopStroke: KINLOOM_COLOR_TOKENS.warmSepia,
  haloFill: KINLOOM_COLOR_TOKENS.loomOchre,
  haloStroke: KINLOOM_COLOR_TOKENS.amberWash,
  stopDefault: KINLOOM_COLOR_TOKENS.archivalIndigo,
  stopStroke: KINLOOM_COLOR_TOKENS.ragCard,
  labelColor: KINLOOM_COLOR_TOKENS.archivalIndigo,
  labelHalo: KINLOOM_COLOR_TOKENS.ragCard,
  eraPalette: [
    KINLOOM_COLOR_TOKENS.archivalIndigo,
    KINLOOM_COLOR_TOKENS.pineMoss,
    KINLOOM_COLOR_TOKENS.loomOchre,
    KINLOOM_COLOR_TOKENS.sealCrimson,
    KINLOOM_COLOR_TOKENS.cobaltInk,
    KINLOOM_COLOR_TOKENS.warmSepia,
  ],
};

const DARK_RESOLVED_TOKENS: ResolvedThemeColorTokens = {
  isDark: true,
  land: KINLOOM_DARK_COLOR_TOKENS.smokedLinen,
  water: KINLOOM_DARK_COLOR_TOKENS.nightWater,
  route: KINLOOM_DARK_COLOR_TOKENS.warmBrass,
  routeLatest: KINLOOM_DARK_COLOR_TOKENS.vermilionTint,
  futureStop: KINLOOM_DARK_COLOR_TOKENS.pewterTaupe,
  futureStopStroke: KINLOOM_DARK_COLOR_TOKENS.warmStone,
  haloFill: KINLOOM_DARK_COLOR_TOKENS.warmBrass,
  haloStroke: KINLOOM_DARK_COLOR_TOKENS.amberUmberWash,
  stopDefault: KINLOOM_DARK_COLOR_TOKENS.parchmentHeading,
  stopStroke: KINLOOM_DARK_COLOR_TOKENS.slateCard,
  labelColor: KINLOOM_DARK_COLOR_TOKENS.parchmentHeading,
  labelHalo: KINLOOM_DARK_COLOR_TOKENS.charcoalFolio,
  eraPalette: [
    KINLOOM_DARK_COLOR_TOKENS.parchmentHeading,
    KINLOOM_DARK_COLOR_TOKENS.verdigrisSage,
    KINLOOM_DARK_COLOR_TOKENS.warmBrass,
    KINLOOM_DARK_COLOR_TOKENS.vermilionTint,
    KINLOOM_DARK_COLOR_TOKENS.archivalSky,
    KINLOOM_DARK_COLOR_TOKENS.warmStone,
  ],
};

export function getResolvedThemeColorTokens(isDark: boolean): ResolvedThemeColorTokens {
  return isDark ? DARK_RESOLVED_TOKENS : LIGHT_RESOLVED_TOKENS;
}
