'use client';

import { createContext, useContext, type ReactNode } from 'react';
import type { EmbedDicts } from './embed-dicts';

/*
 * Hands the embed widgets the copy app/embed/layout.tsx picked on the server
 * (components/embed/embed-dicts.ts has the why). Type-only import above: the
 * catalogs themselves never enter a client module.
 */
const EmbedDictsContext = createContext<EmbedDicts | null>(null);

export function EmbedDictsProvider({ dicts, children }: { dicts: EmbedDicts; children: ReactNode }) {
  return <EmbedDictsContext.Provider value={dicts}>{children}</EmbedDictsContext.Provider>;
}

export function useEmbedDicts(): EmbedDicts {
  const dicts = useContext(EmbedDictsContext);
  if (!dicts) throw new Error('useEmbedDicts: render the widget inside app/embed/layout.tsx');
  return dicts;
}
