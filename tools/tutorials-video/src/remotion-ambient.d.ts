declare module 'remotion' {
  import type React from 'react';

  export interface CompositionProps<TProps extends object = Record<string, unknown>> {
    readonly id: string;
    readonly component: React.FC<TProps>;
    readonly durationInFrames: number;
    readonly fps: number;
    readonly width: number;
    readonly height: number;
    readonly defaultProps?: TProps;
    readonly calculateMetadata?: (options: {
      readonly props: TProps;
      readonly defaultProps: TProps;
    }) =>
      | {
          readonly durationInFrames?: number;
          readonly fps?: number;
          readonly width?: number;
          readonly height?: number;
        }
      | Promise<{
          readonly durationInFrames?: number;
          readonly fps?: number;
          readonly width?: number;
          readonly height?: number;
        }>;
  }

  export function Composition<TProps extends object>(props: CompositionProps<TProps>): React.ReactElement | null;
  export const AbsoluteFill: React.FC<{
    readonly style?: React.CSSProperties;
    readonly children?: React.ReactNode;
  }>;
  export const Audio: React.FC<{ readonly src: string }>;
  export const Img: React.FC<{ readonly src: string; readonly style?: React.CSSProperties }>;
  export function useCurrentFrame(): number;
  export function useVideoConfig(): {
    readonly durationInFrames: number;
    readonly fps: number;
    readonly width: number;
    readonly height: number;
  };
  export function interpolate(
    input: number,
    inputRange: readonly number[],
    outputRange: readonly number[],
    options?: {
      readonly extrapolateLeft?: 'extend' | 'clamp' | 'identity' | 'wrap';
      readonly extrapolateRight?: 'extend' | 'clamp' | 'identity' | 'wrap';
    }
  ): number;
}

declare module '@remotion/bundler' {
  export function bundle(options: { readonly entryPoint: string }): Promise<string>;
}

declare module '@remotion/renderer' {
  export interface VideoConfig {
    readonly id: string;
    readonly durationInFrames: number;
    readonly fps: number;
    readonly width: number;
    readonly height: number;
  }

  export function selectComposition(options: {
    readonly serveUrl: string;
    readonly id: string;
    readonly inputProps?: Record<string, unknown>;
  }): Promise<VideoConfig>;

  export function renderMedia(options: {
    readonly composition: VideoConfig;
    readonly serveUrl: string;
    readonly codec: string;
    readonly crf?: number;
    readonly pixelFormat?: string;
    readonly audioCodec?: string;
    readonly audioBitrate?: string;
    readonly outputLocation: string;
    readonly inputProps?: Record<string, unknown>;
    readonly ffmpegOverride?: (options: { readonly args: readonly string[] }) => string[];
  }): Promise<void>;

  export function renderStill(options: {
    readonly composition: VideoConfig;
    readonly serveUrl: string;
    readonly output: string;
    readonly imageFormat?: 'png' | 'jpeg';
    readonly frame?: number;
    readonly inputProps?: Record<string, unknown>;
  }): Promise<void>;
}
