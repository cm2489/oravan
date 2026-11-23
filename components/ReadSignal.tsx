'use client';

import { useEffect } from 'react';
import { routing } from '@/i18n/routing';
import { armReadSignal, sendReadSignal } from '@/lib/read-signal';

/*
 * Mounts the reading signal once per page load (lib/read-signal.ts says what
 * it sends and when). Renders nothing. Mounted only by app/[locale]/layout.tsx,
 * so it runs on main-site pages and never on /embed (hard rule 12).
 */
export function ReadSignal() {
  useEffect(() => armReadSignal({ document, window, send: sendReadSignal }, routing.locales), []);
  return null;
}
