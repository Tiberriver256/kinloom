import type React from 'react';
import { useLayoutEffect } from 'react';
import { useLocation, useNavigationType } from 'react-router-dom';
import { scrollTargetForNavigation } from '../lib/scrollMemory.js';

const scrollYByLocationKey = new Map<string, number>();

export const ScrollMemory: React.FC = () => {
  const location = useLocation();
  const navType = useNavigationType();
  const { key } = location;

  useLayoutEffect(() => {
    history.scrollRestoration = 'manual';
  }, []);

  useLayoutEffect(() => {
    const onScroll = (): void => {
      scrollYByLocationKey.set(key, window.scrollY);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    window.scrollTo(0, scrollTargetForNavigation(navType, scrollYByLocationKey.get(key)));
    return (): void => {
      scrollYByLocationKey.set(key, window.scrollY);
      window.removeEventListener('scroll', onScroll);
    };
  }, [key, navType]);

  return null;
};
