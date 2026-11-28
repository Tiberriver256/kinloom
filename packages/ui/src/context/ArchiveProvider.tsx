import type React from 'react';
import { KinloomPluginProvider } from '../plugins/PluginContext.js';
import type { KinloomUiPlugin } from '../plugins/types.js';
import type { ArchiveDataProviderProps } from './ArchiveDataContext.js';
import { ArchiveDataProvider } from './ArchiveDataContext.js';
import { ArchiveUiProvider } from './ArchiveUiContext.js';
import { OnboardingProvider } from './OnboardingContext.js';

export interface ArchiveProviderProps extends ArchiveDataProviderProps {
  plugins?: readonly KinloomUiPlugin[];
}

export const ArchiveProvider: React.FC<ArchiveProviderProps> = ({ children, plugins, ...dataProps }) => (
  <ArchiveDataProvider {...dataProps}>
    <KinloomPluginProvider plugins={plugins}>
      <ArchiveUiProvider>
        <OnboardingProvider>{children}</OnboardingProvider>
      </ArchiveUiProvider>
    </KinloomPluginProvider>
  </ArchiveDataProvider>
);
