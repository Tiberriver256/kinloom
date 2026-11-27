export interface MapJourneyState {
  stepIndex: number;
  playing: boolean;
  selectedStopId: string | null;
}

export const MAP_JOURNEY_INITIAL: MapJourneyState = {
  stepIndex: -1,
  playing: false,
  selectedStopId: null,
};

function select(state: MapJourneyState, stepIndex: number, stopIds: readonly string[]): MapJourneyState {
  return {
    ...state,
    stepIndex,
    selectedStopId: stepIndex >= 0 && stepIndex < stopIds.length ? stopIds[stepIndex] : null,
  };
}

export function journeyNext(state: MapJourneyState, stopIds: readonly string[]): MapJourneyState {
  if (stopIds.length === 0) {
    return { ...state, playing: false };
  }
  const next = state.stepIndex < 0 ? 0 : Math.min(state.stepIndex + 1, stopIds.length - 1);
  return { ...select(state, next, stopIds), playing: false };
}

export function journeyPrev(state: MapJourneyState, stopIds: readonly string[]): MapJourneyState {
  if (stopIds.length === 0) {
    return { ...state, playing: false };
  }
  const next = state.stepIndex < 0 ? stopIds.length - 1 : Math.max(0, state.stepIndex - 1);
  return { ...select(state, next, stopIds), playing: false };
}

export function journeyPlayToggle(state: MapJourneyState, stopIds: readonly string[]): MapJourneyState {
  if (state.playing) {
    return { ...state, playing: false };
  }
  if (stopIds.length === 0) {
    return state;
  }
  if (state.stepIndex < 0 || state.stepIndex >= stopIds.length - 1) {
    return { ...select(state, 0, stopIds), playing: true };
  }
  return { ...state, playing: true };
}

export function journeyTick(state: MapJourneyState, stopIds: readonly string[]): MapJourneyState {
  if (stopIds.length === 0) {
    return { ...state, playing: false };
  }
  if (state.stepIndex < 0) {
    return { ...select(state, 0, stopIds), playing: true };
  }
  if (state.stepIndex >= stopIds.length - 1) {
    return { ...state, playing: false };
  }
  return select(state, state.stepIndex + 1, stopIds);
}

export function journeyScrub(
  state: MapJourneyState,
  index: number,
  stopIds: readonly string[]
): MapJourneyState {
  if (stopIds.length === 0) {
    return { ...state, playing: false };
  }
  const clamped = Math.max(0, Math.min(index, stopIds.length - 1));
  return { ...select(state, clamped, stopIds), playing: false };
}

export function journeyReset(state: MapJourneyState): MapJourneyState {
  return { ...state, stepIndex: -1, playing: false, selectedStopId: null };
}

export function journeySelectStop(
  state: MapJourneyState,
  stopId: string,
  stopIds: readonly string[]
): MapJourneyState {
  const index = stopIds.indexOf(stopId);
  if (index === -1) {
    return state;
  }
  return select(state, index, stopIds);
}
