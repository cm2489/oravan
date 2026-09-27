/*
 * BILL FIXTURES, DERIVED FROM THE COMMITTED CORPUS — never a slug, a citation
 * or a headline typed into a spec.
 *
 * A spec that needs "a decoded bill still in committee" asks for one here and
 * reads its citation, headline and dates off the record it gets back. Naming a
 * bill instead meant a nightly re-sync that moved that one bill (a new action,
 * a re-decode, a status change) reddened every spec that named it at once, for
 * reasons that had nothing to do with what those specs protect. A derived
 * fixture simply picks the next bill that fits.
 *
 * Plain shape queries over data/bills.json and data/bills-es.json, picked in
 * slug order so a run is deterministic for a given corpus. tests/corpus.ts is
 * the other half: it mirrors the site's docket pools against the clock.
 */
import billsJson from '../data/bills.json';
import billsEsJson from '../data/bills-es.json';
import { formatCitation } from '../lib/format';
import { statusKeyFor } from '../lib/journey';

interface RawBill {
  bill_type: string;
  bill_number: number;
  congress_number: number;
  status: string;
  title: string;
  short_title: string | null;
  ai_headline: string | null;
  last_action_date: string | null;
  last_action_text: string | null;
}

export interface BillFixture {
  slug: string;
  /** What a card prints above the headline, e.g. "H.R. 5582" (lib/format.ts). */
  citation: string;
  /** The English AI headline, or null for an undecoded bill. */
  headline: string | null;
  /** The Spanish AI headline from data/bills-es.json, or null. */
  esHeadline: string | null;
  /** What a card with no decode prints instead: short title, else title. */
  officialTitle: string;
  lastActionDate: string | null;
}

const slugOf = (b: RawBill) => `${b.bill_type}-${b.bill_number}-${b.congress_number}`.toLowerCase();

const BILLS = [...(billsJson as unknown as RawBill[])].sort((a, b) =>
  slugOf(a) < slugOf(b) ? -1 : slugOf(a) > slugOf(b) ? 1 : 0
);
const ES = billsEsJson as unknown as Record<string, { headline?: string | null }>;

function toFixture(b: RawBill): BillFixture {
  const slug = slugOf(b);
  return {
    slug,
    citation: formatCitation(b.bill_type, b.bill_number),
    headline: b.ai_headline,
    esHeadline: ES[slug]?.headline ?? null,
    officialTitle: b.short_title ?? b.title,
    lastActionDate: b.last_action_date,
  };
}

/**
 * True when searching the /embeds configurator for this bill's headline can
 * only return this bill: its filter matches the query as a substring of every
 * bill's citation, title and headline (components/EmbedConfigurator.tsx).
 */
function headlineIsUnique(b: RawBill): boolean {
  const q = (b.ai_headline ?? '').toLowerCase();
  if (!q) return false;
  return (
    BILLS.filter(
      (o) =>
        formatCitation(o.bill_type, o.bill_number).toLowerCase().includes(q) ||
        (o.short_title ?? o.title).toLowerCase().includes(q) ||
        (o.ai_headline ?? '').toLowerCase().includes(q)
    ).length === 1
  );
}

/**
 * A DECODED bill whose card label is plain `committee` — a status with no
 * clock in it, so the label cannot change between the build and the
 * assertion — with a dated last action, and a headline no other bill's text
 * contains (so a search for it finds exactly this bill). The corpus holds
 * well over a thousand of these; finding none means the corpus itself is
 * broken, so this throws rather than skipping.
 */
export function decodedCommitteeBill(): BillFixture {
  const bill = BILLS.find(
    (b) => b.ai_headline && b.status === 'committee' && b.last_action_date && headlineIsUnique(b)
  );
  if (!bill) throw new Error('corpus holds no decoded committee bill with a unique headline');
  return toFixture(bill);
}

/**
 * A bill with NO AI headline, in committee — the card prints its official
 * title and must never print the AI label. Rare (two bills on 2026-09-27), so
 * null when the corpus holds none and the caller skips with a reason.
 */
export function undecodedCommitteeBill(): BillFixture | null {
  const bill = BILLS.find((b) => !b.ai_headline && b.status === 'committee');
  return bill ? toFixture(bill) : null;
}

/**
 * A decoded bill with a Spanish decode whose record is `floor_vote` but whose
 * last action names NO calendar — a rejected motion to proceed, a motion to
 * reconsider tabled — so the label gate (lib/journey.ts's statusKeyFor) must
 * print `floor_activity`, never `floor_vote`. That branch reads no clock.
 * Null when the corpus holds none.
 */
export function esDecodedFloorActivityBill(): BillFixture | null {
  const bill = BILLS.find(
    (b) =>
      b.ai_headline &&
      ES[slugOf(b)]?.headline &&
      b.status === 'floor_vote' &&
      statusKeyFor(b.status as 'floor_vote', b.last_action_text, b.last_action_date) ===
        'floor_activity'
  );
  return bill ? toFixture(bill) : null;
}
