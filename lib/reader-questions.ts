/**
 * Reader questions — the typed read of data/reader-questions.json for the
 * question page (components/ReaderQuestions.tsx). Server-only: a 'use client'
 * module must never import this (scripts/check-client-imports.mjs).
 * The file's rules live in lib/reader-questions-gate.mjs.
 */
import readerQuestionsJson from '@/data/reader-questions.json';

export type ReaderCite = { src: string; quote: string };
export type ReaderClaim = {
  kind: 'record' | 'analysis' | 'absence';
  en: string;
  es: string;
  cites?: ReaderCite[];
  searched?: string[];
  absent?: string[];
};
export type ReaderPick = {
  bank_id: string;
  q: { en: string; es: string };
  claims: ReaderClaim[];
};
export type ReaderSource = {
  kind: 'record' | 'analysis';
  url: string;
  title: { en: string; es: string };
};
export type ReaderQuestionsEntry = {
  written: string;
  record_as_of: string;
  model: string;
  rewritten_nightly: false;
  sources: Record<string, ReaderSource>;
  picks: ReaderPick[];
};

const FILE = readerQuestionsJson as unknown as { questions: Record<string, ReaderQuestionsEntry> };

/** The entry for one Big Question, or null when it has none. */
export function readerQuestionsFor(id: string): ReaderQuestionsEntry | null {
  return Object.prototype.hasOwnProperty.call(FILE.questions, id) ? FILE.questions[id] : null;
}
