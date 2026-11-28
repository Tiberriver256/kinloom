import type { ArchiveEvent, Person } from '@kinloom/core';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useSearchParams } from 'react-router-dom';
import { useArchiveUi } from '../../context/ArchiveUiContext.js';
import {
  buildEventQueryUrl,
  pickActiveTimelineEventId,
  shouldRunInitialEventScroll,
} from '../../lib/timelineScroll.js';

export interface PersonTimelineSyncResult {
  readonly activeEvent: ArchiveEvent | null;
  readonly setActiveEventId: React.Dispatch<React.SetStateAction<string | null>>;
  readonly cardRefs: React.RefObject<Map<string, HTMLElement>>;
}

export function usePersonTimelineSync(
  slug: string | undefined,
  person: Person | undefined,
  personEvents: readonly ArchiveEvent[]
): PersonTimelineSyncResult {
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const { setActiveYear, pushPivot } = useArchiveUi();

  const [activeEventId, setActiveEventId] = useState<string | null>(searchParams.get('event'));
  const cardRefs = useRef<Map<string, HTMLElement>>(new Map());
  const completedInitialScrollNavKeyRef = useRef<string | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const qEvt = params.get('event');
    if (qEvt && personEvents.some((e) => e.id === qEvt)) {
      setActiveEventId(qEvt);
    } else if (personEvents.length > 0) {
      if (personEvents[0]) setActiveEventId(personEvents[0].id);
    } else {
      setActiveEventId(null);
    }
  }, [location.search, personEvents]);

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const qEvt = params.get('event');
    const navKey = `${slug || ''}:${location.key}`;
    const eventIds = personEvents.map((e) => e.id);

    if (
      shouldRunInitialEventScroll({
        navKey,
        completedNavKey: completedInitialScrollNavKeyRef.current,
        targetEventId: qEvt,
        eventIds,
      })
    ) {
      const el = qEvt ? cardRefs.current.get(qEvt) : undefined;
      if (el) {
        completedInitialScrollNavKeyRef.current = navKey;
        el.scrollIntoView({ behavior: 'auto', block: 'start' });
      }
    } else if (personEvents.length > 0 && completedInitialScrollNavKeyRef.current !== navKey) {
      completedInitialScrollNavKeyRef.current = navKey;
    }
  }, [slug, location.key, location.search, personEvents]);

  useEffect(() => {
    if (personEvents.length === 0) {
      return undefined;
    }

    let rafId: number | null = null;

    const syncFromScroll = (): void => {
      rafId = null;
      const metrics: { id: string; top: number; bottom: number }[] = [];
      for (const ev of personEvents) {
        const el = cardRefs.current.get(ev.id);
        if (!el) {
          continue;
        }
        const rect = el.getBoundingClientRect();
        metrics.push({ id: ev.id, top: rect.top, bottom: rect.bottom });
      }
      if (metrics.length === 0) {
        return;
      }

      const viewportHeight = window.innerHeight || 800;
      const isMobile = window.innerWidth < 768;
      const topOffset = isMobile ? 128 : 58;
      const bottomOffset = isMobile ? 52 : 0;
      const usableHeight = Math.max(120, viewportHeight - topOffset - bottomOffset);
      const anchorY = topOffset + usableHeight * 0.28;
      const maxScrollY = Math.max(0, document.documentElement.scrollHeight - viewportHeight);

      const nextId = pickActiveTimelineEventId(metrics, {
        anchorY,
        scrollY: window.scrollY,
        maxScrollY,
      });

      if (nextId) {
        setActiveEventId((prev) => (prev === nextId ? prev : nextId));
      }
    };

    const scheduleSync = (): void => {
      if (rafId !== null) {
        return;
      }
      rafId = window.requestAnimationFrame(syncFromScroll);
    };

    window.addEventListener('scroll', scheduleSync, { passive: true });
    window.addEventListener('resize', scheduleSync, { passive: true });

    return (): void => {
      window.removeEventListener('scroll', scheduleSync);
      window.removeEventListener('resize', scheduleSync);
      if (rafId !== null) {
        window.cancelAnimationFrame(rafId);
      }
    };
  }, [personEvents]);

  const activeEvent: ArchiveEvent | null = useMemo(() => {
    if (!activeEventId) {
      return personEvents[0] || null;
    }
    return personEvents.find((e) => e.id === activeEventId) || personEvents[0] || null;
  }, [activeEventId, personEvents]);

  useEffect(() => {
    if (!activeEvent) {
      setActiveYear(null);
      return;
    }
    setActiveYear(activeEvent.year);
    if (!person || !window.location.pathname.endsWith(`/person/${person.slug}`)) {
      return;
    }
    const nextUrl = buildEventQueryUrl(window.location.href, activeEvent.id);
    if (nextUrl) {
      window.history.replaceState(window.history.state, '', nextUrl);
    }
  }, [activeEvent, person, setActiveYear]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: push pivot breadcrumb only when person slug changes
  useEffect(() => {
    if (person) {
      pushPivot({ slug: person.slug, name: person.full_name, year: activeEvent?.year ?? null });
    }
  }, [person?.slug]);

  return { activeEvent, setActiveEventId, cardRefs };
}
