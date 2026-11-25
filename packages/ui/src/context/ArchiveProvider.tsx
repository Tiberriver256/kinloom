import type { ArchiveDataProviderProps } from './ArchiveDataContext.js';
import type { KinloomUiPlugin } from '../plugins/types.js';
import { ArchiveDataProvider } from './ArchiveDataContext.js';
import { ArchiveUiProvider } from './ArchiveUiContext.js';
import { KinloomPluginProvider } from '../plugins/PluginContext.js';
import React from 'react';

export interface ArchiveProviderProps extends ArchiveDataProviderProps {
  plugins?: readonly KinloomUiPlugin[];
}

export const ArchiveProvider: React.FC<ArchiveProviderProps> = ({
  children,
  plugins,
  ...dataProps
}) => (
  <ArchiveDataProvider {...dataProps}>
    <KinloomPluginProvider plugins={plugins}>
      <ArchiveUiProvider>{children}</ArchiveUiProvider>
    </KinloomPluginProvider>
  </ArchiveDataProvider>
);
