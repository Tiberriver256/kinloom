import type React from 'react';
import { Composition } from 'remotion';
import {
  TutorialChapterComposition,
  type TutorialStepCompositionProps,
} from './TutorialChapter.tsx';

const DEFAULT_PROPS: TutorialStepCompositionProps = {
  chapterId: 'core-navigation-search',
  chapterTitle: 'Navigating the Archive & Global Search',
  stepId: 'nav-top-bar-axes',
  stepTitle: 'Switch across primary archival views',
  stepNumber: 1,
  totalSteps: 2,
  frameUrls: [],
  cues: [],
  durationInFrames: 180,
  fps: 30,
  width: 1280,
  height: 720,
  palette: {
    surfaceCanvas: '#F5EFE2',
    surfaceCard: '#FCF9F2',
    surfaceLinen: '#EAE1CE',
    surfaceHeader: '#1B2A41',
    textPrimary: '#23272E',
    textSecondary: '#4E4A42',
    textInverse: '#FCF9F2',
    accentPrimary: '#7A4612',
    accentSecondary: '#2F5245',
    borderDecorative: '#D6CEBE',
    borderControl: '#827A6A',
    fontSerif: "'Newsreader', Georgia, serif",
    fontMono: "'IBM Plex Mono', ui-monospace, monospace",
  },
};

export const RemotionRoot: React.FC = () => (
  <Composition
    id="TutorialStep"
    component={TutorialChapterComposition}
    durationInFrames={DEFAULT_PROPS.durationInFrames}
    fps={DEFAULT_PROPS.fps}
    width={DEFAULT_PROPS.width}
    height={DEFAULT_PROPS.height}
    defaultProps={DEFAULT_PROPS}
    calculateMetadata={({ props }) => ({
      durationInFrames: Math.max(1, props.durationInFrames),
      fps: props.fps,
      width: props.width,
      height: props.height,
    })}
  />
);
