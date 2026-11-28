import type { SourceInspectorRequest, SourceReaderRequest } from '@kinloom/core';
import type React from 'react';
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useArchiveData } from './ArchiveDataContext.js';

export interface PivotCrumb {
  slug: string;
  name: string;
  year: number | null;
}

export type LooseOptional<T> = {
  [K in keyof T]: undefined extends T[K] ? T[K] | undefined : T[K];
};

export type SourceReaderRequestInput = {
  [K in keyof SourceReaderRequest]: SourceReaderRequest[K] | undefined;
} & Pick<SourceReaderRequest, 'sourceId'>;

export type SourceInspectorRequestInput = {
  [K in keyof SourceInspectorRequest]: SourceInspectorRequest[K] | undefined;
} & Pick<SourceInspectorRequest, 'sourceId'>;

function stripUndefinedProps<T extends object>(obj: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) {
      out[k] = v;
    }
  }
  return out as T;
}

export interface ArchiveUiContextValue {
  activeYear: number | null;
  setActiveYear: (y: number | null) => void;
  pivotTrail: PivotCrumb[];
  pushPivot: (crumb: PivotCrumb) => void;
  sourceReader: SourceReaderRequest | null;
  openSourceReader: (req: SourceReaderRequestInput) => void;
  closeSourceReader: () => void;
  sourceInspector: SourceInspectorRequest | null;
  openSourceInspector: (req: SourceInspectorRequestInput) => void;
  closeSourceInspector: () => void;
  searchOpen: boolean;
  openSearch: () => void;
  closeSearch: () => void;
}

const ArchiveUiContext = createContext<ArchiveUiContextValue | null>(null);

export const ArchiveUiProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { ensureReadings } = useArchiveData();
  const [activeYear, setActiveYear] = useState<number | null>(null);
  const [pivotTrail, setPivotTrail] = useState<PivotCrumb[]>([]);
  const [sourceReader, setSourceReader] = useState<SourceReaderRequest | null>(null);
  const [sourceInspector, setSourceInspector] = useState<SourceInspectorRequest | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);

  const openSourceReader = useCallback(
    (req: SourceReaderRequestInput) => {
      ensureReadings();
      setSourceInspector(null);
      setSourceReader(stripUndefinedProps(req) as SourceReaderRequest);
    },
    [ensureReadings]
  );

  const closeSourceReader = useCallback(() => {
    setSourceReader(null);
  }, []);

  const openSourceInspector = useCallback((req: SourceInspectorRequestInput) => {
    setSourceInspector(stripUndefinedProps(req) as SourceInspectorRequest);
  }, []);

  const closeSourceInspector = useCallback(() => {
    setSourceInspector(null);
  }, []);

  const openSearch = useCallback(() => {
    ensureReadings();
    setSearchOpen(true);
  }, [ensureReadings]);

  const closeSearch = useCallback(() => {
    setSearchOpen(false);
  }, []);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      const target = e.target instanceof HTMLElement ? e.target : null;
      const inInput =
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable);

      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setSearchOpen((prev) => {
          if (!prev) {
            ensureReadings();
          }
          return !prev;
        });
      } else if (e.key === '/' && !inInput && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        ensureReadings();
        setSearchOpen(true);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return (): void => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [ensureReadings]);

  const pushPivot = useCallback((crumb: PivotCrumb) => {
    setPivotTrail((prev) => {
      const next = prev.filter((c) => c.slug !== crumb.slug);
      return [...next.slice(-3), crumb];
    });
  }, []);

  const value = useMemo<ArchiveUiContextValue>(
    () => ({
      activeYear,
      setActiveYear,
      pivotTrail,
      pushPivot,
      sourceReader,
      openSourceReader,
      closeSourceReader,
      sourceInspector,
      openSourceInspector,
      closeSourceInspector,
      searchOpen,
      openSearch,
      closeSearch,
    }),
    [
      activeYear,
      pivotTrail,
      pushPivot,
      sourceReader,
      openSourceReader,
      closeSourceReader,
      sourceInspector,
      openSourceInspector,
      closeSourceInspector,
      searchOpen,
      openSearch,
      closeSearch,
    ]
  );

  return <ArchiveUiContext.Provider value={value}>{children}</ArchiveUiContext.Provider>;
};

export function useArchiveUi(): ArchiveUiContextValue {
  const ctx = useContext(ArchiveUiContext);
  if (!ctx) {
    throw new Error('useArchiveUi must be used inside ArchiveUiProvider');
  }
  return ctx;
}
