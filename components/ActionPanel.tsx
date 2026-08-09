'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { BookOpen, Check, Copy, Ear, Moon, Phone, RotateCcw, Sparkles, X } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { liveCallKey, type LiveCallTarget } from '@/lib/journey';
// TYPE-ONLY, and it must stay type-only: lib/moments.ts imports
// data/moments.json and the whole bill corpus behind it, and this is a CLIENT
// component. `import type` is erased at compile time, so naming the
// discriminator here costs the bundle nothing — the same reason lib/journey.ts
// takes VehicleKind this way rather than restating the union.
import type { VehicleKind } from '@/lib/moments';
// Type-only for the same reason: lib/nomination-script.ts's runtime exports
// pull the prompt builder and its constants, and a client bundle has no use for
// either. The panel only needs to name which of the two audiences it is asking
// /api/script for, and that name must be the route's own union rather than a
// string literal restated here — the route rejects an unrecognized audience
// with a 400 rather than defaulting it, so a typo would be a dead control.
import type { NominationAudience } from '@/lib/nomination-script';
import { upsertCall, useCalls, usePrefs } from '@/lib/local';
import type { CallOutcome, Legislator, Stance } from '@/lib/types';
import { OfficeHoursNote } from './OfficeHoursNote';
import { VacantSeatCard } from './VacantSeatCard';
import { ZipForm } from './ZipForm';

/*
 * THE CALL RAIL — a control panel, not a card.
 *
 * On the desk it is a sticky panel that holds the height of the window: an
 * ink title bar, a body that scrolls on its own, and a FOOT that sits
 * OUTSIDE that scroll area. The foot is where the call lives, so the call
 * can never be scrolled away from. Below the desk breakpoint the same
 * markup is simply in flow, in the read -> pick -> edit -> call order.
 *
 * COLOR LAW inside this panel:
 *   go     the dial, and only the dial (plus the stance card's chosen edge,
 *          which IS an action control).
 *   tint   YOURS — the stance you picked, the outcome you logged. Never a
 *          status, never decoration.
 *   ink    everything else, including every ground and every edge.
 *   alert  failure only, and never the sole carrier: every failure here
 *          also has a 3px rule, a bold label and role="alert".
 *
 * The `#act` id and `data-call-cta` are load-bearing: FloatingCallButton
 * links to the first and stands down whenever the second is on screen.
 */

interface Props {
  slug: string;
  identifier: string;
  title: string;
  /** Both locales' record labels, computed by the bill page at render time
   *  so a call logged here can print in whichever language the civic record
   *  is later read in — see lib/local.ts's CallRecord comment. */
  recordLabels: { en: string; es: string };
  /** Chamber-aware call routing (lib/journey.ts liveCallTarget /
   *  liveCallTargetForNomination): which chamber holds the live decision,
   *  when the record says. null = no routing, the list renders as it always
   *  has. The shape is imported rather than restated so the panel can never
   *  fall behind a field the derivation grows — `soleChamber` was added on
   *  2026-08-06 and this prop said nothing about it until it did. */
  liveTarget: LiveCallTarget | null;
  /**
   * WHAT KIND OF THING IS BEING CALLED ABOUT — and it is a prop rather than
   * something derived from `liveTarget`, deliberately.
   *
   * `liveTarget.soleChamber` already says "nomination" everywhere it is
   * non-null, and reading the kind off it would have been free. It is also
   * exactly wrong: liveCallTargetForNomination returns NULL for a nomination
   * that is confirmed, returned, withdrawn or unclassified — so the derived
   * kind would silently flip to "bill" on precisely the records where the
   * panel's copy is most likely to be read and most obviously false. A
   * confirmed nomination is still a nomination.
   *
   * Absent means 'bill', the same default lib/moments.ts's `vehicleKind`
   * states for the wire format, so every existing bill call site is unchanged.
   */
  kind?: VehicleKind;
}

const STANCES: Stance[] = ['support', 'oppose', 'undecided'];
const OUTCOMES: CallOutcome[] = ['contact', 'voicemail', 'unavailable'];

/** The panel's own inner radius: an 8px box with a 2px edge. Geometry, not a third radius. */
const INNER_RADIUS = 'calc(var(--radius-control)-2px)';

/** Quiet, hand-sized control on paper. `line-strong` edges need paper on one side. */
const GHOST =
  'inline-flex min-h-11 items-center gap-1.5 rounded-control border-[1.5px] border-line-strong px-3 py-2 text-sm font-semibold text-ink hover:border-ink';

function telHref(phone: string) {
  return `tel:+1${phone.replace(/\D/g, '')}`;
}

type Translate = ReturnType<typeof useTranslations>;

/**
 * The rate-limit fallback: a static template with [bracket] slots, honestly
 * labeled as NOT AI-drafted. Built from messages so both locales carry it,
 * with the vehicle's citation interpolated — the one fact it needs.
 *
 * KIND-AWARE, and it was not until 2026-08-06. `bill.fallbackScript.*` says
 * "I support this bill" / "Apoyo este proyecto de ley" in so many words, and
 * this function handed that template to every nomination whose script request
 * failed — 685 terminal records among them. Two lies in one textarea: a
 * nomination called a bill, in words written for the reader to say out loud to
 * a Senate office.
 *
 * The nomination template is worded for the SENATE, which is the chamber this
 * slot is about: it names the confirmation vote as the ask, exactly as
 * lib/nomination-script.ts's AUDIENCE_LINES.senator instructs the model to, and
 * for the same reason — advice and consent is the Senate's alone, so a
 * chamber-neutral nomination script cannot say the one true thing about the
 * call. The panel asks /api/script for `audience: 'senator'` here, so the AI
 * draft and this template address the same office. The House member's own words
 * are houseFallbackFor() below, reached from his own row.
 */
function fallbackFor(t: Translate, s: Stance, citation: string, kind: VehicleKind) {
  const key = kind === 'nomination' ? 'fallbackScriptNomination' : 'fallbackScript';
  return t(`${key}.${s}`, { citation });
}

/**
 * The same static template for the OTHER audience a nomination has — the House
 * member, who holds no vote on it.
 *
 * It is a separate family of strings rather than a parameterization of the one
 * above, for the reason lib/nomination-script.ts gives for forking the prompt
 * rather than flagging it: the ask is a different ask. The senator template
 * asks for a vote; this one says out loud that the House has no vote here and
 * asks the representative to press the two senators he shares a state with —
 * the owner's 2026-08-06 ruling, in the same words `bill.nominationHousePress`
 * gives the reader a paragraph earlier. A caller who reads the senator template
 * to a House office is asking for something that office cannot do, which is the
 * defect this whole slot exists to close.
 */
function houseFallbackFor(t: Translate, s: Stance, citation: string) {
  return t(`fallbackScriptNominationHouse.${s}`, { citation });
}

/**
 * The THIRD nomination template, for a reader whose jurisdiction elects no
 * senators — DC, PR, VI, GU, AS, MP (2026-08-09).
 *
 * Neither of the two above can be handed to this reader. fallbackFor's
 * nomination template asks a SENATOR for a confirmation vote, and they have no
 * senator to read it to. houseFallbackFor asks their representative to press
 * "our state's senators", who do not exist either — the same sentence that
 * makes `bill.nominationHousePress` false here.
 *
 * WHY A TEMPLATE AT ALL, rather than the empty script slot a 422 leaves. The
 * empty slot is deliberate for a refusal and correct there: it un-mounts every
 * `script &&` gate, dials included, because "offering a dial with nothing to
 * say is the thing that makes a first-time caller hang up." But this reader is
 * not in that case. The nomination is LIVE, their House office is real and
 * reachable, and `bill.nominationNoSenator` tells them in so many words to call
 * it and ask that the nomination be raised. Leaving them the sentence and
 * taking away the phone number would be the panel contradicting its own copy —
 * and it would bury the one office they have, on the one vehicle where burying
 * it is easiest to justify and worst to do.
 *
 * So the ask is the honest one that remains: say it publicly. No vote is
 * requested of anyone, because none is available to this reader — which is the
 * standing rule that House-pressure copy must never imply a House member votes
 * on or decides a confirmation.
 */
function noSenatorFallbackFor(t: Translate, s: Stance, citation: string) {
  return t(`fallbackScriptNominationNoSenator.${s}`, { citation });
}

/** m:ss for the rate-limit countdown line. */
function formatRetryTime(totalSec: number) {
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/**
 * The rep lookup as a status model, not two loose variables: idle (no ZIP —
 * also SSR/first paint, so a saved-but-unmatched ZIP never flashes
 * "not found"), loading, error, or ready with whatever the lookup returned.
 */
type RepLookup =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error' }
  | {
      status: 'ready';
      reps: Legislator[];
      vacancies: { state: string; district: number }[];
      /** ZIP spans >1 House district — /api/reps has always disclosed this;
       *  the panel ignored it until the 2026-08-04 walkthrough P1. */
      multiDistrict: boolean;
    };

/** Failure, expressed three ways: a 3px rule, a bold label, and role="alert". */
function Failure({ children }: { children: React.ReactNode }) {
  return (
    <div
      role="alert"
      className="flex flex-wrap items-center gap-3 rounded-control border-l-[3px] border-alert bg-wash px-4 py-3 text-sm"
    >
      {children}
    </div>
  );
}

/**
 * THE HOUSE MEMBER'S OWN WORDS, IN THE HOUSE MEMBER'S OWN ROW.
 *
 * lib/nomination-script.ts shipped a `house` audience on 2026-08-06 and
 * app/api/script validated it and rode it inside the cache version — and the
 * panel asked for no audience at all, so the branch was dead code from the hour
 * it landed. The reader was told, in `bill.nominationHousePress`, that their
 * representative can press their senators, and then handed a script that says
 * "the senator" to read to that representative's office. The WHY had shipped
 * and the HOW had not.
 *
 * WHY IT LIVES IN THE ROW rather than as a control above the stance question:
 * the owner's ruling is "the focus should be on the senator as a default", and
 * a chooser in front of the stance control would turn the default into a
 * decision the reader has to make before they can act. Here the Senate script
 * is simply what you get; the House words are one press away AT THE MOMENT the
 * reader is looking at that office's number and deciding whether to dial it.
 * The rail's `rank()` already puts this row second, so the ordering carries the
 * hierarchy and the copy does not have to.
 *
 * It is the panel's own script vocabulary at row scale — the label above the
 * words every time (AI on an AI draft, the honest not-AI line on the static
 * template), an editable textarea because every script on this site is the
 * reader's to edit before they read it aloud (README design principle 5), a
 * copy button, and the same three-outcome error model the main slot uses. What
 * it deliberately does NOT carry is the rate-limit countdown: one ticker per
 * panel is enough, and the main slot owns it.
 */
function HouseScriptSlot({
  t,
  script,
  isFallback,
  loading,
  error,
  copied,
  onGenerate,
  onChange,
  onCopy,
}: {
  t: Translate;
  script: string;
  isFallback: boolean;
  loading: boolean;
  error: 'generic' | 'rate' | 'refused' | null;
  copied: boolean;
  onGenerate: () => void;
  onChange: (text: string) => void;
  onCopy: () => void;
}) {
  return (
    <div className="mt-3 border-t-[1.5px] border-line pt-3">
      {!script && !loading && !error && (
        <button type="button" onClick={onGenerate} className={GHOST}>
          <Sparkles className="h-4 w-4 flex-none" aria-hidden />
          {t('nominationHouseScriptCta')}
        </button>
      )}
      {loading && (
        <p role="status" className="flex items-center gap-2 text-sm text-ink-2">
          <Sparkles className="h-4 w-4 flex-none animate-pulse" aria-hidden />
          {/* The main slot's line 2, reused rather than restated: it describes
              the drafting itself, which is the same act here, and a second
              sentence saying the same thing in different words is how two
              copies of one idea start to drift. No rotation — this wait sits
              inside a row, not on the whole panel. */}
          {t('generating2')}
        </p>
      )}
      {/* The route's deliberate refusal keeps its own register here too — no
          alert vocabulary, no retry, no template. See the main slot's note. */}
      {error === 'refused' && (
        <p role="status" className="max-w-note text-sm text-ink">
          {t('scriptNotCallable')}
        </p>
      )}
      {(error === 'rate' || error === 'generic') && (
        <Failure>
          <span className="font-bold text-alert">
            {error === 'rate' ? t('rateLimited') : t('scriptError')}
          </span>
          {error === 'generic' && (
            <button type="button" onClick={onGenerate} className={GHOST}>
              <RotateCcw className="h-4 w-4 flex-none" aria-hidden />
              {t('retry')}
            </button>
          )}
        </Failure>
      )}
      {script && (
        <div className={error ? 'mt-3' : undefined}>
          <p className="text-sm font-bold text-ink">
            {isFallback ? t('nominationHouseFallbackTitle') : t('nominationHouseScriptTitle')}
          </p>
          <p className="mt-0.5 text-sm font-semibold text-ink-2">
            {isFallback ? t('fallbackDisclaimer') : t('scriptDisclaimer')}
          </p>
          <textarea
            value={script}
            onChange={(e) => onChange(e.target.value)}
            rows={6}
            aria-label={
              isFallback ? t('nominationHouseFallbackTitle') : t('nominationHouseScriptTitle')
            }
            className="mt-2 w-full rounded-control border-2 border-ink bg-paper p-3 font-reading text-md text-ink"
          />
          <div className="mt-2">
            <button type="button" onClick={onCopy} className={GHOST}>
              {copied ? (
                <Check className="h-4 w-4 flex-none" aria-hidden />
              ) : (
                <Copy className="h-4 w-4 flex-none" aria-hidden />
              )}
              {copied ? t('scriptCopied') : t('copyScript')}
            </button>
          </div>
          <span role="status" aria-live="polite" className="sr-only">
            {copied ? t('scriptCopied') : ''}
          </span>
        </div>
      )}
    </div>
  );
}

export function ActionPanel({
  slug,
  identifier,
  title,
  recordLabels,
  liveTarget,
  kind = 'bill',
}: Props) {
  const t = useTranslations('bill');
  // The not-found register reuses /reps's own strings verbatim (ZipForm
  // already crosses into 'home' the same way) — the two surfaces can't drift.
  const tReps = useTranslations('reps');
  const locale = useLocale();

  const [stance, setStance] = useState<Stance | null>(null);
  // One draft per stance: switching stances never destroys the user's edits.
  const [drafts, setDrafts] = useState<Partial<Record<Stance, string>>>({});
  // Rate-limit fallbacks live in their OWN map, never in `drafts`: writing
  // one into drafts would (a) permanently suppress AI regeneration via
  // generate()'s draft-exists early return and (b) put the AI-drafted label
  // on non-AI text — the labeling hard rule cuts both ways.
  const [fallbacks, setFallbacks] = useState<Partial<Record<Stance, string>>>({});
  // When the API disclosed seconds-to-reset on a 429: the epoch-ms moment a
  // fresh AI draft becomes worth asking for again. null = no reset known.
  const [retryAt, setRetryAt] = useState<number | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [loading, setLoading] = useState(false);
  /*
   * THREE OUTCOMES, NOT TWO — and the third one is not a failure.
   *
   *   rate     the limiter tripped. Transient; a countdown and a template.
   *   generic  something broke. Transient; retry and a template.
   *   refused  the ROUTE DECIDED there is no call to make (422 not_callable).
   *
   * `refused` landed 2026-08-06. Until then a 422 fell into the `!res.ok`
   * branch below and rendered `scriptError` — "Couldn't draft a script right
   * now. The ready-made template below works in the meantime." Nothing had
   * gone wrong, nothing would change on a retry, and the template it pointed
   * at was a call script for a decision the Senate had already made. A
   * deliberate refusal reported as a hiccup is the same class of untruth as
   * manufactured urgency, just pointed the other way.
   */
  const [error, setError] = useState<'generic' | 'rate' | 'refused' | null>(null);
  /*
   * THE HOUSE MEMBER'S SLOT — its own draft, its own template, its own error,
   * kept beside the senator's rather than replacing them. That separation IS
   * the owner's "Senate as the default" ruling expressed in state: asking for
   * the House words can never cost the reader the Senate script they already
   * have in front of them, and switching between the two is not a mode.
   *
   * Keyed by stance like the maps above, so switching stance re-offers the
   * control rather than showing yesterday's words under today's position. NOT
   * keyed by legislator: the script addresses "Representative" / "your office"
   * and names no one (lib/nomination-script.ts AUDIENCE_LINES.house), so in a
   * split ZIP every House row shows the same drafted words, which is correct —
   * two different scripts for two offices being asked for the identical thing
   * would be two chances to get one of them wrong.
   */
  const [houseDrafts, setHouseDrafts] = useState<Partial<Record<Stance, string>>>({});
  const [houseFallbacks, setHouseFallbacks] = useState<Partial<Record<Stance, string>>>({});
  const [houseLoading, setHouseLoading] = useState(false);
  const [houseError, setHouseError] = useState<'generic' | 'rate' | 'refused' | null>(null);
  const [houseCopied, setHouseCopied] = useState(false);
  const [lookup, setLookup] = useState<RepLookup>({ status: 'idle' });
  const prefs = usePrefs();
  const zip = prefs.zip ?? null;
  const [copied, setCopied] = useState<string | null>(null);
  const [scriptCopied, setScriptCopied] = useState(false);
  const [loggedOutcomes, setLoggedOutcomes] = useState<Record<string, CallOutcome>>({});
  // Call modal: native <dialog> (focus trap, background inert, and Escape
  // come from the platform - same idiom as FeedbackDialog). startCallRef is
  // the trigger focus returns to when the dialog closes.
  const dialogRef = useRef<HTMLDialogElement>(null);
  const startCallRef = useRef<HTMLButtonElement>(null);
  const callTitleRef = useRef<HTMLHeadingElement>(null);
  const stanceRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const repsHeadingRef = useRef<HTMLParagraphElement>(null);
  // Set by the in-panel ZipForms' onSaved: the submit that just happened
  // unmounts its own form, so the focus-continuity effect below has to move
  // focus somewhere sensible once the lookup settles — but ONLY then, never
  // on an ordinary page load with a saved ZIP.
  const zipJustSaved = useRef(false);
  // E1 (2026-08 pick): the rail's scroll-fade hint. Shown while the body
  // genuinely overflows AND the visitor has never scrolled it; the first
  // real scroll retires it for the rest of the visit.
  const scrollBodyRef = useRef<HTMLDivElement>(null);
  const [showScrollHint, setShowScrollHint] = useState(false);
  const scrolledOnce = useRef(false);
  // The dialog is mounted ONLY while open (see render below). Mounting it
  // whenever a script exists would put a second copy of the script, the
  // office-hours note, and the rep dial buttons in the (hidden) DOM, so a
  // getByText for any of those matches twice — the call-action/flow e2e specs
  // caught exactly that. openCallModal flips this; an effect drives showModal()
  // once the element is in the tree, and onClose unmounts it again.
  const [callOpen, setCallOpen] = useState(false);
  const callCount = useCalls().length;

  // The drafting wait gets product-specific rotating lines, not a frozen spinner.
  const [genLine, setGenLine] = useState<1 | 2 | 3>(1);
  useEffect(() => {
    if (!loading) return;
    const id = setInterval(() => setGenLine((g) => (g === 3 ? 1 : ((g + 1) as 1 | 2 | 3))), 3200);
    return () => clearInterval(id);
  }, [loading]);

  // The AI draft wins whenever it exists; the fallback template fills the
  // slot on rate limit so every `script &&` gate below — the review step,
  // the call section with the rep tel: links, the foot, the modal — stays
  // mounted. The phones never leave the DOM over a script-slot FAILURE.
  //
  // They do leave on a `refused` (422), and that is the intended difference:
  // no fallback is seeded there, so `script` stays empty and the dial does not
  // render. The foot's own comment states the rule this follows — "offering a
  // dial with nothing to say is the thing that makes a first-time caller hang
  // up" — and on a refusal there is, by the route's own decision, nothing to
  // say. An outage is the opposite case and keeps its phones.
  const aiDraft = stance ? drafts[stance] : undefined;
  const isFallback = !aiDraft && !!stance && !!fallbacks[stance];
  const script = aiDraft ?? (stance ? (fallbacks[stance] ?? '') : '');
  const setScript = (text: string) => {
    if (!stance) return;
    if (isFallback) setFallbacks((f) => ({ ...f, [stance]: text }));
    else setDrafts((d) => ({ ...d, [stance]: text }));
  };
  // An untouched fallback still earns retry guidance; once the user edits
  // it, their edited script IS the script — offer nothing extra (the same
  // philosophy as generate()'s draft-exists early return).
  const fallbackPristine =
    !!stance && !!fallbacks[stance] && fallbacks[stance] === fallbackFor(t, stance, identifier, kind);
  // The same three derivations for the House slot. Its script never feeds the
  // `script &&` gates below — the rail, the foot and the modal all belong to
  // the Senate default, and an addition must not be able to unlock them.
  const houseAiDraft = stance ? houseDrafts[stance] : undefined;
  const houseIsFallback = !houseAiDraft && !!stance && !!houseFallbacks[stance];
  const houseScript = houseAiDraft ?? (stance ? (houseFallbacks[stance] ?? '') : '');
  const setHouseScript = (text: string) => {
    if (!stance) return;
    if (houseIsFallback) setHouseFallbacks((f) => ({ ...f, [stance]: text }));
    else setHouseDrafts((d) => ({ ...d, [stance]: text }));
  };
  const retryRemainingSec =
    retryAt === null ? null : Math.max(0, Math.ceil((retryAt - nowMs) / 1000));

  // Tick the countdown once a second while a known reset time is pending —
  // same interval idiom as the genLine rotation above. State is only set
  // inside the interval callback, never synchronously in the effect.
  useEffect(() => {
    if (error !== 'rate' || retryAt === null) return;
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, [error, retryAt]);

  const multiDistrict = lookup.status === 'ready' && lookup.multiDistrict;
  // ORDERING, two rules composed (demote, never bury — nobody loses a dial):
  //  1. In a split ZIP the senators are the two certainly-yours rows, so
  //     they lead — the walkthrough's call modal led with a House member who
  //     may not be the caller's own, exactly the nervous caller's fear.
  //  2. Chamber routing: the chamber holding the live decision leads
  //     (lib/journey.ts liveCallTarget).
  //  Certainty outranks routing: in a split ZIP the senators stay first even
  //  when the House holds the bill, because "which House member is mine?" is
  //  unresolved and the refinement CTA sits right below.
  //
  //  A NOMINATION CHANGES THE COPY AND NOTHING ELSE. `rank` below is
  //  deliberately untouched by `soleChamber`: it still returns only 0 or 1
  //  and still filters nothing, so on a nomination the senators sort first
  //  and the House member keeps his row, his dial, and his outcome buttons.
  //  "Demote, never bury" then holds by construction rather than by promise —
  //  the owner ruling of 2026-08-04, and the reason a nomination needed a
  //  third boolean instead of a fifth branch.
  const liveChamber = liveTarget?.chamber ?? null;
  const rank = (r: Legislator) => {
    if (multiDistrict) return r.type === 'sen' ? 0 : 1;
    if (liveChamber) return (r.type === 'sen' ? 'senate' : 'house') === liveChamber ? 0 : 1;
    return 0;
  };
  const reps =
    lookup.status === 'ready' ? [...lookup.reps].sort((a, b) => rank(a) - rank(b)) : [];
  const vacancies = lookup.status === 'ready' ? lookup.vacancies : [];
  const notFound = lookup.status === 'ready' && reps.length === 0 && vacancies.length === 0;
  // Which offices this reader actually has. Both feed copy that NAMES an
  // office, so both are read off the resolved list rather than assumed: a
  // delegate jurisdiction has no senator at all, and four House seats are
  // vacant today (data/vacancies.json). liveCallKey holds the senator half of
  // that rule for every routing sentence; the House-pressure note below holds
  // its own half, because it is the only copy that speaks TO the House row.
  const hasSenator = reps.some((r) => r.type === 'sen');
  const liveTargetKey = liveCallKey(liveTarget, { hasSenator });
  /*
   * The nomination annex: the extra sentences a nomination needs and a bill
   * does not — how confirmation works at all, and what the offices this
   * reader actually has can honestly do about one.
   *
   * THE NO-SENATOR JURISDICTIONS ARE THE REASON THIS IS THREE FLAGS AND NOT
   * TWO (2026-08-09). DC, Puerto Rico, the Virgin Islands, Guam, American
   * Samoa and the Northern Mariana Islands elect a delegate or a resident
   * commissioner and NO senators at all — so `hasSenator` is false, and
   * liveCallKey (lib/journey.ts) correctly returns null rather than print a
   * sentence naming an office the reader does not have.
   *
   * Gating the explainer on that null was the bug: a reader in ZIP 20001 lost
   * BOTH nomination notes — the one explaining that only the Senate votes on
   * confirmations, and the one about what a House office can do — and was
   * left with a bare stance control and a dial, no explanation of any kind,
   * while generate() went on requesting a SENATOR-audience script. The single
   * reader who most needs the procedure spelled out got the least of it, and
   * then got a script addressed to a Senate office beside a House delegate's
   * phone number.
   *
   * `nominationHow` is now gated only on the routing and on there being some
   * office to speak about — it is TRUE for every reader ("The House has no
   * vote on nominations at all"), and it is most true for these ones.
   */
  const showNominationNote = !!liveTarget?.soleChamber && reps.length > 0;
  /* The House-pressure note keeps BOTH of its old conditions and gains the
     senator one explicitly. It tells the reader their representative "shares
     a state with your two senators, and they can press them" — false in a
     jurisdiction that elects none, which is precisely what showNoSenatorNote
     below exists to say instead. Still gated on the House row EXISTING, never
     on the routing alone: telling a reader in a vacant district what to ask
     their representative would name an office that is not there. */
  const showHousePressNote =
    showNominationNote && hasSenator && reps.some((r) => r.type === 'rep');
  /*
   * "WE KNOW THIS READER HAS NO SENATORS" — as distinct from "we have not
   * looked yet", which is what a bare `!hasSenator` means for the first
   * moments of every page load.
   *
   * `reps` is `[]` until the /api/reps lookup RESOLVES, so `hasSenator` is
   * false for every reader in every jurisdiction while it is in flight. A
   * non-empty `reps` is therefore the proof that the question was actually
   * asked and answered — `reps.length > 0` implies `lookup.status === 'ready'`
   * by construction (see `reps` above).
   *
   * This distinction is load-bearing twice over, and one of them is a refusal
   * that cannot be retried: `generate()` reads this to decide whether to skip
   * the senator-audience request, and a stance chosen before the lookup landed
   * would otherwise refuse the script for a reader who has two senators. Both
   * the refusal and the note that explains it read this ONE boolean, so a
   * reader can never be refused a script without the explanation on screen.
   */
  const knownNoSenator = reps.length > 0 && !hasSenator;
  /* …and its counterpart for a reader with no senators to press. Strictly
     exclusive with the House-pressure note above, so the two can never both
     render. */
  const showNoSenatorNote = showNominationNote && knownNoSenator;
  /*
   * …and the words to go with that note, offered in the row itself. Gated on
   * `kind` as well as on the routing, even though `soleChamber` is only ever
   * true for a nomination today: the House audience exists ONLY in the
   * nomination branch of app/api/script, and the bill branch would silently
   * ignore the field and hand back a chamber-neutral bill script under a label
   * promising House-specific words. The kind is the thing that makes the
   * request meaningful, so the kind is what gates the control.
   *
   * `hasSenator` joins the conjunction for the same reason it gates the
   * House-pressure note above, and it is the stronger case here: the House
   * audience's whole ask, in the prompt (lib/nomination-script.ts's
   * AUDIENCE_LINES) and in the offline template alike, is that the
   * representative "press the two U.S. Senators from the caller's own state".
   * A reader in DC or Puerto Rico has none, so that script would be asking
   * their delegate to lean on senators who do not exist.
   */
  const showHouseScript = kind === 'nomination' && showNominationNote && hasSenator;

  const fetchReps = useCallback(() => {
    if (!zip) {
      setLookup({ status: 'idle' });
      return;
    }
    setLookup({ status: 'loading' });
    fetch(`/api/reps?zip=${zip}`)
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((d) =>
        setLookup({
          status: 'ready',
          reps: d.reps,
          vacancies: d.vacancies ?? [],
          multiDistrict: d.multiDistrict ?? false,
        })
      )
      .catch(() => setLookup({ status: 'error' }));
  }, [zip]);

  // Deferred a tick: fetchReps sets 'loading' synchronously, which the
  // react-hooks/set-state-in-effect rule forbids inside the effect's own
  // commit — same defer the embed's RepLookupWidget documents. The retry
  // buttons keep calling fetchReps directly (event handlers are fine).
  useEffect(() => {
    const id = setTimeout(fetchReps, 0);
    return () => clearTimeout(id);
  }, [fetchReps]);

  const onZipSaved = useCallback(() => {
    zipJustSaved.current = true;
  }, []);

  // Focus continuity after an in-panel ZIP submit: the submit unmounts its
  // own form, so once the lookup settles, move focus to the outcome — the
  // first dial link (in the dialog) / the call-who line (in the rail) on
  // success, or the failure block otherwise. focus() in an effect is fine —
  // it is not a state write. On ordinary loads nothing moves.
  useEffect(() => {
    if (!zipJustSaved.current) return;
    if (lookup.status === 'idle' || lookup.status === 'loading') return;
    zipJustSaved.current = false;
    const scope = callOpen ? dialogRef.current : null;
    let el: HTMLElement | null = null;
    if (lookup.status === 'ready' && lookup.reps.length > 0) {
      el = scope ? scope.querySelector<HTMLElement>('a[href^="tel:"]') : repsHeadingRef.current;
    } else {
      el = (scope ?? document).querySelector<HTMLElement>('[data-reps-alert]');
    }
    el?.focus();
  }, [lookup, callOpen]);

  // Re-measure the hint whenever the panel's content changes shape (a
  // script arriving, reps loading). Deferred a frame so the measurement
  // never writes state mid-commit (the FloatingCallButton idiom); the
  // scroll listener retires it on the first genuine scroll.
  useEffect(() => {
    const el = scrollBodyRef.current;
    if (!el) return;
    const frame = requestAnimationFrame(() => {
      if (scrolledOnce.current) return;
      setShowScrollHint(el.scrollHeight - el.clientHeight > 40 && el.scrollTop < 8);
    });
    return () => cancelAnimationFrame(frame);
    // houseScript/houseError are in here for the same reason the rest are: the
    // House slot opening inside a row changes the body's height, and a hint
    // measured before it opened is a hint about a different panel.
  }, [script, loading, lookup, stance, error, houseScript, houseError, houseLoading]);

  useEffect(() => {
    const el = scrollBodyRef.current;
    if (!el) return;
    const onScroll = () => {
      if (el.scrollTop > 8 && !scrolledOnce.current) {
        scrolledOnce.current = true;
        setShowScrollHint(false);
      }
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

  /*
   * ONE REQUEST, ONE CLASSIFICATION, TWO CALLERS.
   *
   * Extracted 2026-08-06 when the House slot landed, and extracted rather than
   * copied for the same reason app/api/script extracted serveScript(): this is
   * the block that decides what a response MEANS, and two copies of it would be
   * two places for the 422-is-not-an-outage distinction to drift. Each caller
   * keeps its own state handling, which genuinely differs — only the senator
   * slot owns the countdown clock, and only it drives the panel's `script &&`
   * gates.
   *
   * Total by construction: every failure, including a thrown fetch, comes back
   * as an outcome rather than an exception, so neither caller can leave its
   * loading flag stuck.
   *
   * `audience` is sent ONLY for a nomination. The bill path of that route reads
   * no audience at all, so a bill request stays byte-for-byte the one this
   * panel has always sent; and 'senator' is stated rather than left to the
   * route's default, so the request says out loud which of the two scripts it
   * is asking for.
   */
  type ScriptOutcome =
    | { kind: 'draft'; script: string }
    | { kind: 'rate'; retryAfterSec: number | null }
    | { kind: 'refused' }
    | { kind: 'generic' };

  async function requestScript(
    s: Stance,
    audience: NominationAudience | null
  ): Promise<ScriptOutcome> {
    try {
      const res = await fetch('/api/script', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug, stance: s, locale, ...(audience ? { audience } : {}) }),
      });
      if (res.status === 429) {
        // The citizen 429 may disclose seconds-to-reset; older mocks and the
        // token path send a bare body — tolerate both (null = no countdown).
        let sec: number | null = null;
        try {
          const b = (await res.json()) as { retryAfterSec?: unknown };
          if (
            typeof b.retryAfterSec === 'number' &&
            Number.isFinite(b.retryAfterSec) &&
            b.retryAfterSec > 0
          ) {
            sec = Math.ceil(b.retryAfterSec);
          }
        } catch {
          /* bare 429 body — no reset info to show */
        }
        return { kind: 'rate', retryAfterSec: sec };
      }
      /*
       * THE ROUTE'S ONE DELIBERATE REFUSAL, and it must not be read as an
       * outage. app/api/script answers 422 `not_callable` — and 422 for
       * nothing else — when it has decided there is no call to make: a
       * nomination past advice and consent, one whose stage the record does
       * not state, or one of the 14 records carrying no description sentence
       * to ground a script in. Status alone is the check because that route
       * is the only thing that answers this fetch and it has exactly one 422.
       */
      if (res.status === 422) return { kind: 'refused' };
      if (!res.ok) return { kind: 'generic' };
      const data = await res.json();
      return { kind: 'draft', script: data.script };
    } catch {
      return { kind: 'generic' };
    }
  }

  async function generate(s: Stance) {
    // Clock read up front (event-handler time): a 429 below anchors its
    // countdown to the moment the request went out — conservative by at
    // most the round-trip. The purity lint flags ANY handler clock read in
    // this component (probed: main's own copyNumber + Date.now() trips it
    // identically — a whole-component compiler bailout, not this line);
    // generate() only ever runs from click/key handlers, never render.
    // eslint-disable-next-line react-hooks/purity -- event-handler clock read; never runs during render
    const calledAt = Date.now();
    setStance(s);
    setError(null);
    // The House slot's error belonged to the stance being left behind — its
    // draft is keyed by stance and survives, but a failure message that
    // outlived its request would be reported about words nobody asked for yet.
    setHouseError(null);
    if (drafts[s]) return; // a draft (possibly user-edited) already exists - restore, don't regenerate
    /*
     * NO SENATORS, NO SENATOR-AUDIENCE REQUEST (2026-08-09).
     *
     * On a nomination this used to send `audience: 'senator'` unconditionally,
     * including for the six jurisdictions that elect none — DC, PR, VI, GU,
     * AS, MP. The model dutifully wrote a script addressed to a Senate office
     * ("I'm asking the senator to vote to confirm"), and the panel rendered it
     * above a delegate's phone number, the only number that reader has. It
     * would have been read to an office that cannot act on it, by someone told
     * to expect it to work.
     *
     * This skips the request BEFORE the fetch rather than after: the request
     * is the thing that is wrong, so no Anthropic call is made, no cache entry
     * is written, and no rate-limit budget is spent on a script nobody can use.
     *
     * IT IS NOT AN ERROR, AND NOT THE 422 `refused` PATH — that one leaves the
     * script slot empty on purpose, which un-mounts every `script &&` gate and
     * takes the dials with it, because on a refusal there is by definition
     * nothing to say. This reader is the opposite case: the nomination is
     * LIVE, their House office is real and reachable, and `nominationNoSenator`
     * tells them in so many words to call it and ask that the nomination be
     * raised. Leaving them that sentence and taking away the phone number
     * would be the panel contradicting its own copy, and would bury the one
     * office they have on the one vehicle where burying it is worst.
     *
     * So the honest template is seeded instead (noSenatorFallbackFor —
     * labelled as not AI-drafted, asking only that the office speak up, never
     * that it vote), the dials stay mounted, and the rail's explanation is
     * gated on this SAME boolean so the words and the script can never
     * disagree about what this reader can do.
     *
     * `knownNoSenator`, NOT `!hasSenator` — see that constant. A bare
     * `!hasSenator` is also true while the /api/reps lookup is still in
     * flight, so a reader who picked a stance quickly would have been refused
     * a script they were fully entitled to, with no way to retry: the refusal
     * returns before `drafts[s]` is ever populated, so pressing the same
     * stance again short-circuits on nothing and the panel stays empty.
     *
     * KNOWN RESIDUAL, not closed here. The mirror of that race is still open:
     * a reader who picks a stance BEFORE the lookup resolves gets the senator
     * request, and if the lookup then reveals a delegate jurisdiction the
     * already-rendered script stays on screen. That is the pre-existing
     * behaviour, not a new one, and closing it means either blocking the
     * stance control on a network round-trip or tearing down a draft the
     * reader may already have edited — both worse than the narrow window they
     * fix. The window is small in practice (/api/reps is a same-origin pure
     * lookup, resolved long before a human can read the page and choose a
     * position), but it is a window, and it is written down here rather than
     * left for someone to rediscover.
     */
    if (kind === 'nomination' && knownNoSenator) {
      setFallbacks((f) => (f[s] ? f : { ...f, [s]: noSenatorFallbackFor(t, s, identifier) }));
      return;
    }
    setGenLine(1); // restart the rotating lines for this generation
    setLoading(true);
    const outcome = await requestScript(s, kind === 'nomination' ? 'senator' : null);
    // Seed the honest fallback template for this stance — never overwriting one
    // the user may already have edited. On a rate limit AND on a generic
    // failure (Phase-1 P1): a failure previously left `script` empty, and every
    // call affordance on the page is gated behind it, so an outage took the
    // phone numbers down with it, against funnel invariant I2. The template is
    // static and labeled not-AI-generated.
    const seedFallback = () =>
      setFallbacks((f) => (f[s] ? f : { ...f, [s]: fallbackFor(t, s, identifier, kind) }));
    switch (outcome.kind) {
      case 'draft':
        setDrafts((d) => ({ ...d, [s]: outcome.script }));
        break;
      case 'rate':
        setNowMs(calledAt);
        setRetryAt(outcome.retryAfterSec ? calledAt + outcome.retryAfterSec * 1000 : null);
        seedFallback();
        setError('rate');
        break;
      case 'refused':
        // No fallback seeded here, on purpose. Every other branch hands over a
        // template because the reader still has a call to make and only our
        // machinery failed; here the machinery worked and the answer is that
        // there is nothing to say.
        setError('refused');
        break;
      case 'generic':
        seedFallback();
        setError('generic');
        break;
    }
    setLoading(false);
  }

  /**
   * The same act for the House audience, asked for from the House member's own
   * row. Deliberately does NOT touch `stance`, `error`, `retryAt` or the
   * countdown: the senator script is the page's action and this must never be
   * able to disturb it — the reader pressed a button inside one row, not a mode
   * switch. It cannot run before a stance exists, because the row it lives in
   * only renders once there is a script.
   */
  async function generateHouseScript(s: Stance) {
    setHouseError(null);
    if (houseDrafts[s]) return; // already drafted (possibly edited) — restore, don't regenerate
    setHouseLoading(true);
    const outcome = await requestScript(s, 'house');
    const seedFallback = () =>
      setHouseFallbacks((f) => (f[s] ? f : { ...f, [s]: houseFallbackFor(t, s, identifier) }));
    switch (outcome.kind) {
      case 'draft':
        setHouseDrafts((d) => ({ ...d, [s]: outcome.script }));
        break;
      case 'rate':
        seedFallback();
        setHouseError('rate');
        break;
      case 'refused':
        setHouseError('refused');
        break;
      case 'generic':
        seedFallback();
        setHouseError('generic');
        break;
    }
    setHouseLoading(false);
  }

  function copyHouseScript() {
    navigator.clipboard?.writeText(houseScript).then(() => {
      setHouseCopied(true);
      setTimeout(() => setHouseCopied(false), 2000);
    });
  }

  function copyNumber(phone: string) {
    navigator.clipboard?.writeText(phone).then(() => {
      setCopied(phone);
      setTimeout(() => setCopied(null), 2000);
    });
  }

  function copyScript() {
    navigator.clipboard?.writeText(script).then(() => {
      setScriptCopied(true);
      setTimeout(() => setScriptCopied(false), 2000);
    });
  }

  function logOutcome(rep: Legislator, outcome: CallOutcome) {
    if (!stance) return;
    // Headlines often already name the bill; don't repeat the citation.
    const norm = (x: string) => x.toLowerCase().replace(/[.\s]/g, '');
    const billLabel = norm(title).includes(norm(identifier)) ? title : `${identifier} · ${title}`;
    upsertCall({
      // On a nomination page this is that nomination's `pn-…` slug, not a bill
      // slug — the field name is historical (see CallRecord in lib/local.ts).
      // /record must route it with recordHref(), never by prefixing `/bills/`,
      // which is what sent every logged nomination call to a 404.
      billSlug: slug,
      billLabel,
      labelEn: recordLabels.en,
      labelEs: recordLabels.es,
      repBioguide: rep.bioguide,
      repName: rep.name,
      stance,
      outcome,
      at: new Date().toISOString(),
    });
    setLoggedOutcomes((prev) => ({ ...prev, [rep.bioguide]: outcome }));
  }

  function openCallModal() {
    setCallOpen(true);
  }

  function closeCallModal() {
    dialogRef.current?.close();
  }

  // Once callOpen mounts the <dialog>, open it modally (focus trap + inert come
  // from showModal). Every close path — the ✕/edit/backdrop handlers call
  // .close(), Escape closes it natively — fires onClose, which unmounts it.
  useEffect(() => {
    const dlg = dialogRef.current;
    if (callOpen && dlg && !dlg.open) {
      dlg.showModal();
      // First focus lands on the dialog's title, not the Close button: a
      // screen reader at the highest-anxiety moment should hear "Make the
      // call" and then the reassurance, never "Close" first (2026-07 a11y
      // critique).
      callTitleRef.current?.focus();
    }
  }, [callOpen]);

  return (
    <section
      aria-labelledby="act"
      data-call-cta
      className="flex min-h-0 w-full flex-col rounded-control border-2 border-ink bg-paper min-[62rem]:max-h-full"
    >
      {/* A real h2, not a styled <p>: the panel's own name has to be in the
          outline, or "Place your call" reads as a subsection of the decoded
          column's heading — a heading in the other column, about another
          thing. */}
      <h2
        id="act"
        className="flex-none bg-ink-deep px-5 py-3 text-xs font-bold tracking-[0.06em] text-paper uppercase leading-tight"
        style={{ borderRadius: `${INNER_RADIUS} ${INNER_RADIUS} 0 0` }}
      >
        {t('actTitle')}
      </h2>

      {/* The body scrolls; the foot below does not. The alpha ramp on the
          last 28px says "this continues" — it is a mask on real content, not
          a painted band — and it lifts while anything inside is focused so a
          focus ring is never dimmed. The relative wrapper exists for the E1
          scroll hint below, which must sit OVER the fade without scrolling
          with the content. */}
      <div className="relative flex min-h-0 flex-col">
        <div
          ref={scrollBodyRef}
          className="grid min-h-0 content-start gap-6 p-4 md:p-6 min-[62rem]:overflow-y-auto min-[62rem]:[mask-image:linear-gradient(to_bottom,#000_calc(100%-28px),transparent_100%)] min-[62rem]:[scrollbar-gutter:stable] min-[62rem]:has-[:focus-visible]:[mask-image:none]">
        <div>
          <p className="max-w-note text-sm text-ink-2">{t('actSub')}</p>
        </div>

        {/* Step 1 - stance. A real radio group, not three independent toggles:
            exactly one stance can be active, and 2026-07's a11y critique found
            aria-pressed here misdescribes that contract to screen readers.
            Roving tabindex + arrow keys per the WAI-ARIA radio pattern; arrows
            select as they move, same as clicking. */}
        <fieldset>
          <legend className="text-lg font-bold text-ink">{t('stanceQ')}</legend>
          <div role="radiogroup" aria-label={t('stanceQ')} className="mt-3 grid gap-2">
            {STANCES.map((s, i) => (
              <button
                key={s}
                ref={(el) => {
                  stanceRefs.current[i] = el;
                }}
                type="button"
                role="radio"
                aria-checked={stance === s}
                tabIndex={(stance ?? STANCES[0]) === s ? 0 : -1}
                onClick={() => generate(s)}
                onKeyDown={(e) => {
                  let next: number | null = null;
                  if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (i + 1) % STANCES.length;
                  else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = (i - 1 + STANCES.length) % STANCES.length;
                  if (next != null) {
                    e.preventDefault();
                    stanceRefs.current[next]?.focus();
                    generate(STANCES[next]);
                  }
                }}
                disabled={loading}
                className={`flex min-h-12 items-center gap-2 rounded-control border-2 px-4 py-3 text-left text-md font-bold transition-colors disabled:cursor-not-allowed disabled:border-line-strong disabled:bg-wash disabled:text-ink-2 ${
                  stance === s
                    ? 'border-go bg-tint text-go-deep'
                    : 'border-line-strong bg-paper text-ink hover:border-ink'
                }`}
              >
                {/* Never colour alone: the chosen card also carries a check
                    and aria-checked. */}
                {stance === s && <Check className="h-4 w-4 flex-none" aria-hidden />}
                {t(`stance.${s}`)}
              </button>
            ))}
          </div>
          {/* Honest expectations: a concern is logged, not debated - keeps the
              "no debate, no quiz" promise true for this stance too. */}
          {stance === 'undecided' && (
            <p className="mt-3 max-w-note text-sm text-ink-2" role="status">
              {t('concernNote')}
            </p>
          )}
        </fieldset>

        {/* Step 2 - script */}
        {loading && (
          <div role="status">
            <p className="flex items-center gap-2 text-ink-2">
              <Sparkles className="h-4 w-4 flex-none animate-pulse" aria-hidden />
              {/* Line 1 names what is being read, so it is the one line of
                  the three that a nomination has to say differently: there
                  is no bill here, and no decode either — the model is given
                  the Senate's own description sentence (see
                  lib/nomination-script.ts). Lines 2 and 3 describe the
                  drafting itself and are true of both kinds. */}
              {t(kind === 'nomination' && genLine === 1 ? 'generatingNomination1' : `generating${genLine}`)}
            </p>
            <p className="mt-0.5 text-sm text-ink-2">{t('generatingHint')}</p>
            <div className="mt-2 h-[6px] max-w-note overflow-hidden rounded-stamp bg-line">
              <div className="shimmer h-full w-1/3 rounded-stamp bg-go" />
            </div>
          </div>
        )}
        {/* THE REFUSAL, IN ITS OWN REGISTER. Not `Failure`: that component is
            the panel's failure vocabulary — the alert rule, the bold alert
            label, role="alert" — and the color law above says alert is
            "failure only". Nothing failed here, so this is an ink note with
            role="status", the same voice `concernNote` and the office-hours
            note speak in. No retry button and no template ride with it,
            because both would contradict the sentence itself. */}
        {error === 'refused' && (
          <div
            role="status"
            className="rounded-control border-l-[3px] border-ink bg-wash px-4 py-3"
          >
            <p className="max-w-note text-sm text-ink">{t('scriptNotCallable')}</p>
          </div>
        )}
        {(error === 'rate' || error === 'generic') && (
          <div>
            <Failure>
              <span className="font-bold text-alert">
                {error === 'rate' ? t('rateLimited') : t('scriptError')}
              </span>
              {error !== 'rate' && stance && (
                <button type="button" onClick={() => generate(stance)} className={GHOST}>
                  <RotateCcw className="h-4 w-4 flex-none" aria-hidden />
                  {t('retry')}
                </button>
              )}
            </Failure>
            {/* Retry guidance sits BELOW the alert, never inside it: a 1-s
                ticker in a live region would re-announce every second. Ink
                only — no amber (no printed date), no green (not an action
                destination; the dial links stay the only green). Shown only
                while the fallback is untouched: an edited fallback IS the
                user's script. */}
            {error === 'rate' &&
              stance &&
              fallbackPristine &&
              (retryAt !== null && retryRemainingSec !== null ? (
                retryRemainingSec > 0 ? (
                  <p className="mt-2 text-sm text-ink-2 tabular-nums">
                    {/* The template pointer rides WITH the countdown (2026-08-04
                        walkthrough P1): both personas read the ticking clock as
                        "nothing works for 8 minutes" because the works-right-now
                        sentence only existed in the no-countdown hint. */}
                    {t('rateRetryIn', { time: formatRetryTime(retryRemainingSec) })}{' '}
                    {t('rateTemplateNow')}
                  </p>
                ) : (
                  <div className="mt-2">
                    <button type="button" onClick={() => generate(stance)} className={GHOST}>
                      <RotateCcw className="h-4 w-4 flex-none" aria-hidden />
                      {t('retry')}
                    </button>
                  </div>
                )
              ) : (
                <p className="mt-2 text-sm text-ink-2">{t('rateRetryHint')}</p>
              ))}
          </div>
        )}
        {script && (
          <div>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-lg font-bold text-ink">
                {isFallback ? t('fallbackTitle') : t('scriptTitle')}
              </h3>
            </div>
            {/* The label rides with the words, above them, every time: the
                AI line on an AI draft, the honest not-AI line on the static
                fallback template. Never the AI label on non-AI text. */}
            <p className="mt-1 text-sm font-semibold text-ink-2">
              {isFallback ? t('fallbackDisclaimer') : t('scriptDisclaimer')}
            </p>
            <p className="mt-1 max-w-note text-sm text-ink-2">{t('scriptHint')}</p>
            {/* The words a caller says aloud take the reading voice, in both
                languages — and `tint` because the draft is now YOURS. */}
            <textarea
              value={script}
              onChange={(e) => setScript(e.target.value)}
              rows={8}
              aria-label={isFallback ? t('fallbackTitle') : t('scriptTitle')}
              className="mt-3 w-full rounded-control border-2 border-ink bg-paper p-4 font-reading text-lg text-ink"
            />
            <div className="mt-2 flex flex-wrap gap-2">
              <button type="button" onClick={copyScript} className={GHOST}>
                {scriptCopied ? (
                  <Check className="h-4 w-4 flex-none" aria-hidden />
                ) : (
                  <Copy className="h-4 w-4 flex-none" aria-hidden />
                )}
                {scriptCopied ? t('scriptCopied') : t('copyScript')}
              </button>
            </div>
            {/* Announce the copy confirmation without moving focus - same idiom
                as SharePanel's copy-link status region. Covers the modal's own
                copy button too, since both share this scriptCopied state. */}
            <span role="status" aria-live="polite" className="sr-only">
              {scriptCopied ? t('scriptCopied') : ''}
            </span>

            {/* BOTH-SIDES GHOSTS (2026-08 design pick D1): every stance's
                template is rendered unconditionally, so the UI itself
                certifies no house position. The unselected stances' STATIC templates sit
                collapsed beneath the chosen draft: rendered every time,
                never AI (so no AI label rides them), and expanding one
                never switches the stance — the radio group above stays the
                only stance control. */}
            {stance && (
              <div className="mt-3 grid max-w-note gap-1.5">
                {STANCES.filter((s) => s !== stance).map((s) => (
                  <details
                    key={s}
                    className="rounded-control border-[1.5px] border-line bg-wash px-4 py-1"
                  >
                    <summary className="flex min-h-11 cursor-pointer items-center text-sm font-semibold text-ink-2 hover:text-ink">
                      {t('ghostSummary', { stance: t(`stance.${s}`) })}
                    </summary>
                    <p className="pb-3 font-reading text-sm whitespace-pre-wrap text-ink-2">
                      {fallbackFor(t, s, identifier, kind)}
                    </p>
                  </details>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Step 3 - call */}
        {script && (
          <div className="border-t-[1.5px] border-line pt-4">
            <h3 className="text-lg font-bold text-ink">{t('callTitle')}</h3>

            <div className="mt-3 grid gap-3">
              <div className="flex gap-2 border-t-[1.5px] border-line pt-3 text-sm">
                <Ear className="h-5 w-5 shrink-0 text-ink-2" aria-hidden />
                <div className="max-w-note">
                  <p className="font-bold text-ink">{t('hearFirstTitle')}</p>
                  <p className="mt-0.5 text-ink-2">{t('hearFirstBody')}</p>
                </div>
              </div>
              {/* Voicemail is a black enamel sign, never green: saturated
                  green is reserved for going somewhere, and a panel that only
                  reassures is not going anywhere. */}
              <div className="on-dark flex gap-2 rounded-control bg-ink-deep p-4 text-sm">
                <Moon className="h-5 w-5 shrink-0 text-ink-pale" aria-hidden />
                <div className="max-w-note">
                  <p className="font-bold text-paper">{t('afterHoursTitle')}</p>
                  <p className="mt-0.5 leading-dark tracking-dark text-ink-pale">
                    {t('afterHoursBody')}
                  </p>
                </div>
              </div>
              <OfficeHoursNote />
            </div>
            <p className="mt-3 max-w-note text-sm text-ink-2">{t('staffNote')}</p>
            <Link
              href="/why-call"
              className="mt-2 inline-flex min-h-11 items-center gap-1.5 text-sm font-semibold text-go underline visited:text-go-deep hover:text-go-deep"
            >
              <BookOpen className="h-4 w-4 flex-none" aria-hidden />
              {t('whyLink')}
            </Link>

            {lookup.status === 'error' && (
              <div data-reps-alert tabIndex={-1} className="mt-4">
                <Failure>
                  <span className="font-bold text-alert">{t('repsError')}</span>
                  <button type="button" onClick={fetchReps} className={GHOST}>
                    <RotateCcw className="h-4 w-4 flex-none" aria-hidden />
                    {t('retry')}
                  </button>
                </Failure>
              </div>
            )}

            {/* Plain ink, no shimmer: the drafting shimmer idiom is reserved
                for the AI wait. */}
            {lookup.status === 'loading' && (
              <p role="status" className="mt-4 text-sm text-ink-2">
                {t('repsLoading')}
              </p>
            )}

            {!zip && (
              <div className="mt-4 rounded-control border-[1.5px] border-line-strong bg-paper p-4">
                <p className="mb-3 text-sm font-semibold text-ink">{t('needZip')}</p>
                <ZipForm onSaved={onZipSaved} />
              </div>
            )}

            {/* A saved-but-unmatched ZIP (a PO box, a typo) used to render a
                silently empty rail. The /reps failure register, verbatim:
                3px ink rule + bold uppercase label + role=alert — the alert
                color never the sole carrier — and the form re-shown so the
                correction happens right here. */}
            {notFound && (
              <div
                data-reps-alert
                tabIndex={-1}
                role="alert"
                className="mt-4 border-t-[3px] border-ink bg-wash p-4"
              >
                <p className="text-2xs font-extrabold tracking-[0.1em] text-alert uppercase">
                  {tReps('errorLabel')}
                </p>
                <p className="mt-1 text-sm font-semibold text-ink">{tReps('zipNotFound')}</p>
                <div className="mt-3">
                  <ZipForm onSaved={onZipSaved} />
                </div>
              </div>
            )}

            {/* The routing fact, when the record supplies one: who holds the
                live decision. A procedural statement from the stored record
                (liveCallTarget) — never a guess, and never a removal: every
                office below keeps its dial.

                ON A NOMINATION this becomes three beats, in the order a
                reader who has never met one needs them: how confirmation
                works (quiet, ink-2 — it is context, not the action), then the
                Senate call in the same bold voice every other routing
                sentence uses, then the honest account of what a House call
                can and cannot do. The Senate line stays the loudest thing
                here, which is the "Senate by default" half of the owner's
                2026-08-06 ruling; the House note is quiet and below it, which
                is the "demote, never bury" half. */}
            {showNominationNote && (
              <p className="mt-4 max-w-note text-sm text-ink-2">{t('nominationHow')}</p>
            )}
            {liveTargetKey && reps.length > 0 && (
              <p className="mt-4 max-w-note text-sm font-semibold text-ink">
                {t(liveTargetKey)}
              </p>
            )}
            {showHousePressNote && (
              <p className="mt-2 max-w-note text-sm text-ink-2">{t('nominationHousePress')}</p>
            )}
            {/* The same beat for a reader whose jurisdiction elects no
                senators. It takes the place of BOTH the routing sentence
                above (liveCallKey returns null for them, correctly — every
                one of its strings names a senator) and the House-pressure
                note (whose ask is that a representative lean on senators the
                reader does not have). Influence framing only: it must never
                read as though a House vote on a confirmation exists, because
                none does, for anyone. */}
            {showNoSenatorNote && (
              <p className="mt-4 max-w-note text-sm text-ink-2">{t('nominationNoSenator')}</p>
            )}
            {reps.length > 0 && (
              <p
                ref={repsHeadingRef}
                tabIndex={-1}
                className="mt-4 max-w-note font-semibold text-ink outline-none"
              >
                {/* A split ZIP never says "your three" over four names: the
                    multi-district line owns the count question and hands the
                    existing /reps refinement flow in (2026-08-04 walkthrough
                    P1 — the disambiguation existed one surface away and this
                    panel never offered it). */}
                {multiDistrict
                  ? t('callWhoMulti')
                  : reps.some((r) => r.type === 'sen')
                    ? t('callWho')
                    : t('callWhoOne')}
              </p>
            )}
            {multiDistrict && reps.length > 0 && zip && (
              <p className="mt-2 max-w-note text-sm">
                <Link
                  href={`/reps?zip=${zip}`}
                  className="inline-flex min-h-11 items-center gap-1.5 font-semibold text-go underline visited:text-go-deep hover:text-go-deep"
                >
                  {t('refineDistrictCta')}
                </Link>
              </p>
            )}
            <ul className="mt-3 grid list-none gap-3">
              {reps.map((rep) => {
                const logged = loggedOutcomes[rep.bioguide];
                return (
                  <li
                    key={rep.bioguide}
                    className="rounded-control border-[1.5px] border-line-strong p-4"
                  >
                    <p className="font-bold text-ink">{rep.name}</p>
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      {rep.phone && (
                        <>
                          {/* THE NUMBER IS THE CTA (2026-08 design pick
                              B1): the number is the physical next action,
                              so it renders at display scale — it was
                              body-size, equal-weight with guidance text. */}
                          <a
                            href={telHref(rep.phone)}
                            className="ring-gap inline-flex min-h-14 items-center gap-3 rounded-control border-2 border-go bg-go px-5 py-3 font-bold text-paper no-underline hover:border-go-deep hover:bg-go-deep"
                          >
                            <Phone className="h-5 w-5 flex-none" aria-hidden />
                            <span className="text-h3 leading-none font-extrabold tabular-nums">
                              {rep.phone}
                            </span>
                          </a>
                          <button
                            type="button"
                            onClick={() => copyNumber(rep.phone!)}
                            className={GHOST}
                          >
                            {copied === rep.phone ? (
                              <Check className="h-4 w-4 flex-none" aria-hidden />
                            ) : (
                              <Copy className="h-4 w-4 flex-none" aria-hidden />
                            )}
                            {copied === rep.phone ? t('copied') : t('copy')}
                          </button>
                        </>
                      )}
                      {rep.offices.slice(0, 2).map((o, i) => (
                        <a key={i} href={telHref(o.phone!)} className={`${GHOST} tabular-nums`}>
                          <Phone className="h-3.5 w-3.5 flex-none" aria-hidden />
                          {o.city} · {o.phone}
                        </a>
                      ))}
                    </div>

                    {/* The number, then what to say into it, then how it went —
                        the row's own read → act → log order, matching the
                        panel's. Only on a nomination, and only on the office
                        that has no vote on one. */}
                    {showHouseScript && rep.type === 'rep' && stance && (
                      <HouseScriptSlot
                        t={t}
                        script={houseScript}
                        isFallback={houseIsFallback}
                        loading={houseLoading}
                        error={houseError}
                        copied={houseCopied}
                        onGenerate={() => generateHouseScript(stance)}
                        onChange={setHouseScript}
                        onCopy={copyHouseScript}
                      />
                    )}

                    {/* Step 4 - outcome (one record per rep; re-tap changes it) */}
                    <div className="mt-3">
                      <p className="text-sm font-semibold text-ink-2">
                        {t('outcomeQ')}
                        {logged && <span className="ml-1 font-normal">{t('outcomeChange')}</span>}
                      </p>
                      <div className="mt-2 flex flex-wrap gap-2">
                        {OUTCOMES.map((o) => (
                          <button
                            key={o}
                            type="button"
                            onClick={() => logOutcome(rep, o)}
                            aria-pressed={logged === o}
                            className={`inline-flex min-h-11 items-center gap-1.5 rounded-stamp border px-3 py-2 text-sm font-semibold ${
                              logged === o
                                ? 'pop border-ink bg-tint text-ink'
                                : 'border-line-strong text-ink-2 hover:border-ink hover:text-ink'
                            }`}
                          >
                            {logged === o && <Check className="h-4 w-4 flex-none" aria-hidden />}
                            {t(`outcome.${o}`)}
                          </button>
                        ))}
                      </div>

                      {/* The payoff lands where the tap happened, not below the
                          fold — and on `tint`, because the record is yours. */}
                      {logged && (
                        <div
                          className="mt-3 flex items-start gap-3 rounded-control bg-tint px-4 py-3"
                          role="status"
                        >
                          <svg
                            aria-hidden
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            className="draw-check mt-0.5 h-6 w-6 flex-none text-ink"
                          >
                            <circle cx="12" cy="12" r="9" />
                            <path d="m8.5 12.5 2.5 2.5 5-6" />
                          </svg>
                          <div className="max-w-note">
                            <p className="font-semibold text-ink">
                              {callCount === 1
                                ? t('loggedFirst')
                                : callCount === 5
                                  ? t('loggedFifth')
                                  : callCount === 10
                                    ? t('loggedTenth')
                                    : t('outcomeLogged')}{' '}
                              <Link
                                href="/record"
                                className="font-semibold text-go-deep underline"
                              >
                                {t('viewImpact')}
                              </Link>
                            </p>
                            {/* PERSISTENT on-device reassurance: it must NOT vanish on
                                the 1st/5th/10th call, when a first-timer — the moment
                                the milestone fires — is most anxious about where the
                                position they just logged actually went. Kept as its own
                                always-rendered line, never folded into a milestone. */}
                            <p className="mt-1 text-sm text-ink-2">{t('savedOnDevice')}</p>
                          </div>
                        </div>
                      )}
                    </div>
                  </li>
                );
              })}
              {/* A vacant House seat is a fact about the district, not a
                  failure: the same ink-only card /reps shows, in the same
                  list silhouette. Senators still render above it, so the
                  dial is never lost to a House vacancy. */}
              {vacancies.length > 0 && (
                <li>
                  <VacantSeatCard />
                </li>
              )}
            </ul>
          </div>
        )}
        </div>

        {/* E1 (2026-08 pick): the fade said "this continues" only to eyes
            that already knew panels can scroll — both walkthrough personas
            had to discover it. One quiet mark over the fade until the first
            scroll; decorative (aria-hidden), because the content below the
            fold was never hidden from assistive tech to begin with. */}
        {showScrollHint && (
          <p
            aria-hidden
            className="pointer-events-none absolute inset-x-0 bottom-1 hidden text-center text-2xs font-extrabold tracking-[0.14em] text-ink-2 uppercase min-[62rem]:block"
          >
            ↓ {t('railMoreHint')}
          </p>
        )}
      </div>

      {/* THE FOOT — outside the scrolling body, so the call can never be
          scrolled away from. It appears the moment there is a script to read
          from, and never before: offering a dial with nothing to say is the
          thing that makes a first-time caller hang up. */}
      {script && (
        <div
          className="flex-none border-t-2 border-ink bg-paper p-3"
          style={{ borderRadius: `0 0 ${INNER_RADIUS} ${INNER_RADIUS}` }}
        >
          <p className="mb-2 hidden text-2xs font-bold tracking-[0.08em] text-ink-2 uppercase min-[62rem]:block">
            {t('footNote')}
          </p>
          <button
            ref={startCallRef}
            type="button"
            onClick={openCallModal}
            className="ring-gap flex min-h-12 w-full items-center justify-center gap-2 rounded-control border-2 border-go bg-go px-6 py-3 font-bold text-paper hover:border-go-deep hover:bg-go-deep"
          >
            <Phone className="h-4 w-4 flex-none" aria-hidden />
            {t('startCall')}
          </button>
        </div>
      )}

      {/* Call mode: the V2 composition in a focused overlay. A deliberate
          modal - the call is a mode in real life too; nothing else matters
          while the phone is ringing. */}
      {script && callOpen && (
        <dialog
          ref={dialogRef}
          aria-label={t('callTitle')}
          onClose={() => {
            setCallOpen(false);
            startCallRef.current?.focus();
          }}
          onClick={(e) => e.target === dialogRef.current && closeCallModal()}
          className="m-auto max-h-[85dvh] w-[min(92vw,42rem)] overflow-y-auto rounded-control border-2 border-ink bg-paper p-5 backdrop:bg-ink/70 md:p-6"
        >
          <div className="flex items-start justify-between gap-3">
            <h3 ref={callTitleRef} tabIndex={-1} className="text-h3 font-extrabold text-ink outline-none">
              {t('callTitle')}
            </h3>
            <button type="button" onClick={closeCallModal} className={GHOST}>
              <X className="h-4 w-4 flex-none" aria-hidden />
              {t('closeBig')}
            </button>
          </div>

          {/* Pre-dial beat: a calm moment between "script ready" and
              dialing - never a gate in front of the tel: links below, just
              what a first-time caller most needs to hear, or a lighter
              reminder for everyone after that. Voicemail is framed as a
              fully legitimate first choice, not an apologetic fallback -
              offices tally it exactly like a live call (S7 / docs/ideation
              §5). */}
          <div className="on-dark mt-4 flex gap-2 rounded-control bg-ink-deep p-4 text-sm">
            <Moon className="h-5 w-5 shrink-0 text-ink-pale" aria-hidden />
            <div className="max-w-note">
              <p className="font-bold text-paper">
                {callCount === 0 ? t('firstCallTitle') : t('preDialTitle')}
              </p>
              <p className="mt-0.5 leading-dark tracking-dark text-ink-pale">
                {callCount === 0 ? t('firstCallBody') : t('preDialBody')}
              </p>
              {/* The core persuasion, one tap from the highest-anxiety moment
                  (2026-07 critique round 2): every pre-call surface links
                  /why-call in-flow. Navigating away closes the mode - that is
                  the reader's own call to make. */}
              <Link
                href="/why-call"
                className="mt-2 inline-flex min-h-11 items-center gap-1.5 font-semibold text-go-bright underline"
              >
                <BookOpen className="h-4 w-4 flex-none" aria-hidden />
                {t('whyLink')}
              </Link>
            </div>
          </div>
          <div className="mt-3">
            <OfficeHoursNote />
          </div>

          {/* The words said aloud: reading voice, on `tint`, because this is
              yours to read from. */}
          <p className="mt-5 rounded-control bg-tint p-4 font-reading text-lg whitespace-pre-wrap text-ink">
            {script}
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={closeCallModal}
              className="inline-flex min-h-11 items-center text-sm font-semibold text-ink underline"
            >
              {t('editScript')}
            </button>
            <button type="button" onClick={copyScript} className={GHOST}>
              {scriptCopied ? (
                <Check className="h-4 w-4 flex-none" aria-hidden />
              ) : (
                <Copy className="h-4 w-4 flex-none" aria-hidden />
              )}
              {scriptCopied ? t('scriptCopied') : t('copyScript')}
            </button>
          </div>

          {/* The routing fact at the dial moment: same line the rail carries.
              The nomination's House-pressure note rides along, because THIS is
              where the second dial is about to be pressed and "what do I even
              say to a House office about a nomination?" is a question the
              rail's copy may already have scrolled past. The how-it-works
              explainer does NOT ride along: the mode is for dialing, and the
              procedure is context the reader has by now. */}
          {liveTargetKey && reps.length > 0 && (
            <p className="mt-5 max-w-note text-sm font-semibold text-ink">{t(liveTargetKey)}</p>
          )}
          {showHousePressNote && (
            <p className="mt-2 max-w-note text-sm text-ink-2">{t('nominationHousePress')}</p>
          )}
          {/* Rides along at the dial moment for the same reason the
              House-pressure note does: this is where the number is about to
              be pressed, and "what do I even say?" is the question the rail's
              copy may already have scrolled past. */}
          {showNoSenatorNote && (
            <p className="mt-2 max-w-note text-sm text-ink-2">{t('nominationNoSenator')}</p>
          )}
          {/* The same split-ZIP disambiguation the rail carries, at the dial
              moment itself: senators already lead the list (sorted above);
              this line answers "which House member is mine?" before a wrong
              office can be dialed. */}
          {multiDistrict && reps.length > 0 && zip && (
            <p className="mt-5 max-w-note text-sm text-ink-2">
              {t('callWhoMulti')}{' '}
              <Link
                href={`/reps?zip=${zip}`}
                className="font-semibold text-go underline visited:text-go-deep hover:text-go-deep"
              >
                {t('refineDistrictCta')}
              </Link>
            </p>
          )}
          {reps.length > 0 && (
            <div className="mt-5 grid gap-2">
              {reps.map(
                (rep) =>
                  rep.phone && (
                    <div key={rep.bioguide}>
                      <a
                        href={telHref(rep.phone)}
                        className="ring-gap flex min-h-14 flex-wrap items-center justify-between gap-x-3 gap-y-1 rounded-control border-2 border-go bg-go px-4 py-3 font-bold text-paper no-underline hover:border-go-deep hover:bg-go-deep"
                      >
                        <span className="inline-flex items-center gap-2">
                          <Phone className="h-4 w-4 flex-none" aria-hidden />
                          {rep.name}
                        </span>
                        {/* B1: the number at display scale — see the rail note. */}
                        <span className="text-h3 leading-none font-extrabold tabular-nums">
                          {rep.phone}
                        </span>
                      </a>
                      {/* The House words ride HERE too, for the reason the
                          House-pressure note above rides into this mode: this
                          is where the second dial is about to be pressed, and
                          the script in the tint block above it is the SENATOR's
                          — read to a House office it asks for a vote that
                          office does not have. Same state as the rail's copy,
                          so a draft made in one place is already made in the
                          other. */}
                      {showHouseScript && rep.type === 'rep' && stance && (
                        <HouseScriptSlot
                          t={t}
                          script={houseScript}
                          isFallback={houseIsFallback}
                          loading={houseLoading}
                          error={houseError}
                          copied={houseCopied}
                          onGenerate={() => generateHouseScript(stance)}
                          onChange={setHouseScript}
                          onCopy={copyHouseScript}
                        />
                      )}
                    </div>
                  )
              )}
            </div>
          )}

          {/* Never a dead end (2026-07 critique, top consensus P0): with no
              saved ZIP the modal used to show a script and zero numbers. The
              ZIP mini-form lives IN the mode now, and the Capitol switchboard
              is the universal fallback that needs no ZIP at all. */}
          {reps.length === 0 && (
            <div className="mt-5 grid gap-3">
              {lookup.status === 'error' && (
                <div data-reps-alert tabIndex={-1}>
                  <Failure>
                    <span className="font-bold text-alert">{t('repsError')}</span>
                    <button type="button" onClick={fetchReps} className={GHOST}>
                      <RotateCcw className="h-4 w-4 flex-none" aria-hidden />
                      {t('retry')}
                    </button>
                  </Failure>
                </div>
              )}
              {lookup.status === 'loading' && (
                <p role="status" className="text-sm text-ink-2">
                  {t('repsLoading')}
                </p>
              )}
              {!zip && (
                <div className="rounded-control border-[1.5px] border-line-strong bg-paper p-4">
                  <p className="mb-3 text-sm font-semibold text-ink">{t('needZip')}</p>
                  <ZipForm onSaved={onZipSaved} />
                </div>
              )}
              {/* Same not-found register as the rail: correct the ZIP
                  without leaving the mode. */}
              {notFound && (
                <div
                  data-reps-alert
                  tabIndex={-1}
                  role="alert"
                  className="border-t-[3px] border-ink bg-wash p-4"
                >
                  <p className="text-2xs font-extrabold tracking-[0.1em] text-alert uppercase">
                    {tReps('errorLabel')}
                  </p>
                  <p className="mt-1 text-sm font-semibold text-ink">{tReps('zipNotFound')}</p>
                  <div className="mt-3">
                    <ZipForm onSaved={onZipSaved} />
                  </div>
                </div>
              )}
              <div className="rounded-control border-[1.5px] border-line-strong p-4">
                <p className="max-w-note text-sm text-ink-2">{t('switchboardNote')}</p>
                <a
                  href="tel:+12022243121"
                  className="ring-gap mt-2 inline-flex min-h-14 flex-wrap items-center gap-x-3 gap-y-1 rounded-control border-2 border-go bg-go px-4 py-3 font-bold text-paper no-underline hover:border-go-deep hover:bg-go-deep"
                >
                  <Phone className="h-5 w-5 flex-none" aria-hidden />
                  {t('switchboard')}
                  {/* B1: the number at display scale — see the rail note. */}
                  <span className="text-h3 leading-none font-extrabold tabular-nums">
                    (202) 224-3121
                  </span>
                </a>
              </div>
            </div>
          )}
        </dialog>
      )}
    </section>
  );
}
