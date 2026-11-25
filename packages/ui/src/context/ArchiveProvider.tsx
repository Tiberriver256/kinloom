import { ArchiveDataProvider } from './ArchiveDataContext.js';
import type { ArchiveDataProviderProps } from './ArchiveDataContext.js';
import { ArchiveUiProvider } from './ArchiveUiContext.js';
import React from 'react';

export const ArchiveProvider: React.FC<ArchiveDataProviderProps> = ({ children, ...dataProps }) => (
  <ArchiveDataProvider {...dataProps}>
    <ArchiveUiProvider>{children}</ArchiveUiProvider>
  </ArchiveDataProvider>
);
