export interface TokenAudioPlaybackOptions {
  readonly gapMs?: number;
}

interface WindowWithWebkitAudio extends Window {
  readonly webkitAudioContext: typeof AudioContext;
}

const DEFAULT_TOKEN_GAP_MS = 70;
const DEFAULT_SEQUENTIAL_GAP_MS = 60;

let activeStopHandler: (() => void) | null = null;
let activeOwnerCallback: (() => void) | null = null;

function hasWebkitAudioContext(win: Window): win is WindowWithWebkitAudio {
  return 'webkitAudioContext' in win && typeof Reflect.get(win, 'webkitAudioContext') === 'function';
}

function getAudioContextConstructor(): typeof AudioContext | null {
  if (typeof AudioContext === 'function') {
    return AudioContext;
  }
  if (typeof window !== 'undefined' && hasWebkitAudioContext(window)) {
    return window.webkitAudioContext;
  }
  return null;
}

export function isSameOriginAudioUrl(url: string): boolean {
  if (typeof window === 'undefined' || !window.location?.href || window.location.origin === 'null') {
    return !/^(?:https?:)?\/\//i.test(url);
  }
  try {
    return new URL(url, window.location.href).origin === window.location.origin;
  } catch {
    return false;
  }
}

export function stopActivePronunciation(): void {
  if (activeStopHandler) {
    const stop = activeStopHandler;
    activeStopHandler = null;
    activeOwnerCallback = null;
    stop();
  }
  if (typeof window !== 'undefined' && 'speechSynthesis' in window && window.speechSynthesis) {
    try {
      window.speechSynthesis.cancel();
    } catch {
      // Ignore speechSynthesis cancellation errors in headless environments.
    }
  }
}

export function stopPronunciationIfOwner(owner: (() => void) | null): void {
  if (owner && activeOwnerCallback === owner) {
    stopActivePronunciation();
  }
}

export function playSingleAudioUrl(url: string, onStopped: () => void): boolean {
  if (typeof Audio === 'undefined') {
    return false;
  }
  const audio = new Audio(url);
  let stopped = false;

  const stop = (): void => {
    if (stopped) {
      return;
    }
    stopped = true;
    audio.pause();
    try {
      audio.currentTime = 0;
    } catch {
      // Ignore if media element is not seekable yet.
    }
    if (activeStopHandler === stop) {
      activeStopHandler = null;
    }
    if (activeOwnerCallback === onStopped) {
      activeOwnerCallback = null;
    }
    onStopped();
  };

  activeStopHandler = stop;
  activeOwnerCallback = onStopped;
  audio.addEventListener('ended', stop, { once: true });
  audio.addEventListener('error', stop, { once: true });

  try {
    const playPromise = audio.play();
    if (playPromise && typeof playPromise.catch === 'function') {
      void playPromise.catch(() => {
        stop();
      });
    }
  } catch {
    stop();
  }
  return true;
}

export function playSequentialAudioUrls(
  urls: readonly string[],
  onStopped: () => void,
  options?: TokenAudioPlaybackOptions
): boolean {
  if (urls.length === 0 || typeof Audio === 'undefined') {
    return false;
  }
  const gapMs = options?.gapMs ?? DEFAULT_SEQUENTIAL_GAP_MS;
  let stopped = false;
  let index = 0;
  let currentAudio: HTMLAudioElement | null = null;
  let gapTimer: ReturnType<typeof setTimeout> | null = null;

  const stop = (): void => {
    if (stopped) {
      return;
    }
    stopped = true;
    if (gapTimer !== null) {
      clearTimeout(gapTimer);
      gapTimer = null;
    }
    if (currentAudio) {
      currentAudio.pause();
      try {
        currentAudio.currentTime = 0;
      } catch {
        // Ignore if media element is not seekable yet.
      }
      currentAudio = null;
    }
    if (activeStopHandler === stop) {
      activeStopHandler = null;
    }
    if (activeOwnerCallback === onStopped) {
      activeOwnerCallback = null;
    }
    onStopped();
  };

  const playNext = (): void => {
    if (stopped) {
      return;
    }
    if (index >= urls.length) {
      stop();
      return;
    }
    const audio = new Audio(urls[index]);
    index += 1;
    currentAudio = audio;

    const handleEnded = (): void => {
      if (stopped) {
        return;
      }
      currentAudio = null;
      if (index >= urls.length) {
        stop();
        return;
      }
      if (gapMs > 0) {
        gapTimer = setTimeout(() => {
          gapTimer = null;
          playNext();
        }, gapMs);
      } else {
        playNext();
      }
    };

    audio.addEventListener('ended', handleEnded, { once: true });
    audio.addEventListener('error', stop, { once: true });

    try {
      const playPromise = audio.play();
      if (playPromise && typeof playPromise.catch === 'function') {
        void playPromise.catch(() => {
          stop();
        });
      }
    } catch {
      stop();
    }
  };

  activeStopHandler = stop;
  activeOwnerCallback = onStopped;
  playNext();
  return true;
}

export function playTokenAudioUrls(
  urls: readonly string[],
  onStopped: () => void,
  options?: TokenAudioPlaybackOptions
): boolean {
  if (urls.length === 0) {
    return false;
  }
  if (urls.length === 1) {
    return playSingleAudioUrl(urls[0], onStopped);
  }

  const AudioCtx = getAudioContextConstructor();
  const canUseWebAudio =
    AudioCtx !== null && typeof fetch === 'function' && urls.every((url) => isSameOriginAudioUrl(url));

  if (!canUseWebAudio) {
    return playSequentialAudioUrls(urls, onStopped, options);
  }

  let stopped = false;
  let ctx: AudioContext | null = null;
  let source: AudioBufferSourceNode | null = null;
  const abortController = typeof AbortController === 'function' ? new AbortController() : null;

  const closeContext = (): void => {
    if (ctx) {
      const target = ctx;
      ctx = null;
      void target.close?.().catch(() => undefined);
    }
  };

  const stop = (): void => {
    if (stopped) {
      return;
    }
    stopped = true;
    abortController?.abort();
    if (source) {
      try {
        source.onended = null;
        source.stop();
      } catch {
        // Ignore stop errors if the buffer source already finished.
      }
      source = null;
    }
    closeContext();
    if (activeStopHandler === stop) {
      activeStopHandler = null;
    }
    if (activeOwnerCallback === onStopped) {
      activeOwnerCallback = null;
    }
    onStopped();
  };

  activeStopHandler = stop;
  activeOwnerCallback = onStopped;

  void (async () => {
    try {
      ctx = new AudioCtx();
      if (ctx.state === 'suspended' && typeof ctx.resume === 'function') {
        await ctx.resume();
      }
      const responses = await Promise.all(
        urls.map((url) => fetch(url, abortController ? { signal: abortController.signal } : undefined))
      );
      if (stopped || !ctx) {
        closeContext();
        return;
      }
      if (responses.some((response) => !response.ok)) {
        throw new Error('Failed to fetch token audio clip');
      }
      const arrayBuffers = await Promise.all(responses.map((response) => response.arrayBuffer()));
      if (stopped || !ctx) {
        closeContext();
        return;
      }
      const decoded: AudioBuffer[] = [];
      for (const buffer of arrayBuffers) {
        decoded.push(await ctx.decodeAudioData(buffer));
      }
      if (stopped || !ctx) {
        closeContext();
        return;
      }

      const sampleRate = ctx.sampleRate || decoded[0].sampleRate || 24000;
      const gapSeconds = (options?.gapMs ?? DEFAULT_TOKEN_GAP_MS) / 1000;
      const gapSamples = Math.max(0, Math.round(sampleRate * gapSeconds));
      const channels = Math.max(1, ...decoded.map((buf) => buf.numberOfChannels));
      const totalLength =
        decoded.reduce((sum, buf) => sum + buf.length, 0) + gapSamples * Math.max(0, decoded.length - 1);
      const combined = ctx.createBuffer(channels, totalLength, sampleRate);

      let offset = 0;
      for (const buf of decoded) {
        for (let ch = 0; ch < channels; ch += 1) {
          const channelData = buf.getChannelData(Math.min(ch, buf.numberOfChannels - 1));
          combined.getChannelData(ch).set(channelData, offset);
        }
        offset += buf.length + gapSamples;
      }

      source = ctx.createBufferSource();
      source.buffer = combined;
      source.connect(ctx.destination);
      source.onended = () => {
        source = null;
        stop();
      };
      source.start(0);
    } catch {
      if (stopped) {
        return;
      }
      closeContext();
      if (activeStopHandler === stop) {
        activeStopHandler = null;
      }
      const fallbackStarted = playSequentialAudioUrls(urls, onStopped, options);
      if (!fallbackStarted) {
        stopped = true;
        if (activeOwnerCallback === onStopped) {
          activeOwnerCallback = null;
        }
        onStopped();
      }
    }
  })();

  return true;
}

export function playSpeechSynthesisFallback(
  text: string,
  language: string | undefined,
  onStopped: () => void
): boolean {
  if (
    typeof window === 'undefined' ||
    !('speechSynthesis' in window) ||
    !window.speechSynthesis ||
    typeof SpeechSynthesisUtterance === 'undefined'
  ) {
    return false;
  }

  const utterance = new SpeechSynthesisUtterance(text);
  if (language?.trim()) {
    utterance.lang = language.trim();
  }

  let stopped = false;
  const stop = (): void => {
    if (stopped) {
      return;
    }
    stopped = true;
    if (activeStopHandler === stop) {
      activeStopHandler = null;
    }
    if (activeOwnerCallback === onStopped) {
      activeOwnerCallback = null;
    }
    onStopped();
  };

  activeStopHandler = stop;
  activeOwnerCallback = onStopped;
  utterance.onend = stop;
  utterance.onerror = stop;

  try {
    window.speechSynthesis.speak(utterance);
  } catch {
    stop();
  }
  return true;
}
