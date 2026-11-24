'use client';

import { Home, ScrollText, Users, Newspaper } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { Link, usePathname } from '@/i18n/navigation';
import { OravanLockup } from './brand/OravanLockup';
import { LocaleSwitcher } from './LocaleSwitcher';

/*
 * THE SITE BAR — the most-seen surface in the product, so it is held to a
 * budget: at 390px it is ONE row, 56px tall, and it is the only thing between
 * the top of the screen and the page's own headline.
 *
 * GROUND: the masthead band — bottle green (`go-deep`, #133f2d) with the
 * wordmark and nav in cream (`paper`, 11.32:1) and the trust line in
 * `go-pale` (8.26:1). Page 2 (docs/current-direction.md, Colour): "green is
 * the brand — the masthead band and the wordmark"; built for the owner's
 * pick of colour direction c, 2026-09-30. `.on-band` (app/globals.css)
 * turns the focus ring to paper, 11.32:1 on the band, where the default ink
 * ring would be 1.46:1. The band closes on its own colour, so the old 1px
 * `line` rule keeps its pixel and changes no height.
 *
 * "YOU ARE HERE" IS AN INVERTED FILL, and nothing else: a paper cell with
 * band-green type (11.32:1), the language switch's own convention, so one
 * mark means one thing across the whole bar. Navigating is not an action,
 * and the go-mark (the 6px bar) never underlines a link.
 *
 * SHAPE: nav items are hand-sized, so 8px (`rounded-control`). The language
 * switch is a small mark, so 3px. That is the shape law — radius by scale.
 *
 * TWO NAVS, ONE AT A TIME: the row nav is display:none below 48rem and the
 * thumb bar is display:none above it, so exactly one "Primary" navigation
 * landmark is ever in the accessibility tree. Home is dropped from the row nav
 * because the lockup already is the home link; the thumb bar keeps it, because
 * a lockup is not thumb-reachable.
 *
 * THE TWO NAVS DO NOT SHARE ONE ORDER (owner, 2026-09-29, typed: "The
 * 'Call' button in the header needs to be removed and 'Today in Congress'
 * needs to come first on the header"; his picker answer on scope: "Desktop
 * only"). The row nav is Today in Congress · Bills · Big Questions · My reps,
 * with the lockup as Home and the language switch last.
 *
 * THE PHONE BAR IS FOUR TABS: Home · Bills · Big Questions · Reps. The owner,
 * 2026-11-23, on the review card for this bar: "I don't think the "Call"
 * button or the "Home" button really matter and can be removed, at the very
 * least the "call" button because every page has a "call" button close by.
 * What do you think? Does that give it more room for the full text in the
 * bar? Mock up what you are thinking before building." His pick on the
 * mock-up card, 2026-11-24: "Four tabs: Home · Bills · Big Questions · Reps".
 * So the Call tab, and the per-page target it read, are gone; the Big
 * Questions tab says "Big Questions" / "Grandes preguntas" in full, on one
 * line (`nav.moments`, the row nav's own full label). The Call hub stays at
 * /call, the footer's first Site link ("Make a call") on every screen. Today
 * stays off the thumb bar — one tap from Home. "My record" is on neither bar:
 * the Reps page links it ("See your record"). "Why call?" is a footer link on
 * every page.
 */

/** The thumb bar (phones, the island): four destinations, Home included.
 *  Labels come from `tabLabel`. Each tab is sized by its own label (see the
 *  bar below for the measured widths), at least 44px each way. Moments joined
 *  2026-07-25 (v2 slice S5): the discovery layer is a flagship surface. */
const TABS = [
  { href: '/', key: 'home', icon: Home },
  { href: '/bills', key: 'bills', icon: ScrollText },
  { href: '/questions', key: 'moments', icon: Newspaper },
  { href: '/reps', key: 'reps', icon: Users },
] as const;

/**
 * The row nav (48rem and up): no Home — the lockup carries it.
 *
 * Spanish runs ~40% longer than English here ("Proyectos de ley", "Grandes
 * preguntas", "Mis representantes"), and the bar is sized for the LONGER
 * language. MEASURED 2026-09-29 on the production build, WebKit, /es at
 * 768px: the lockup (119px), the four full labels (517px) and the language
 * switch (153px) need 813px of a 736px row, so flex squeezed the switch to
 * 76px and its two labels printed over each other. (main already squeezed it
 * to about 84px with "Mi historial" in this slot; the Call item's icon made
 * it 8px worse.) So BELOW 64rem the row prints the short `navShort` labels
 * ("Proyectos", "Preguntas", "Mis reps"; 337px), in both languages for one
 * rule, and the full labels from 64rem.
 *
 * TODAY FIRST, NO CALL ITEM (2026-09-29). MEASURED in WebKit at 1024px, the
 * narrowest full-label width, where English also carries the trust line:
 * English needs 926px of the 992px row (lockup 119, trust line 211, the four
 * links 404, the switch 156, three 12px gaps); Spanish needs 901px (lockup
 * 119, links 602, switch 156, two gaps). Both fit on one row with nothing
 * squeezed, so "Today in Congress" / "Hoy en el Congreso" print in full from
 * 64rem like the other three, and "Today" / "Hoy" below it.
 *
 * tests/call-hub.spec.ts pins the 768px row (one line, no overflow, the switch
 * at its full width) and the 1024px row in both languages.
 */
const LINKS = [
  // First (owner, 2026-09-29, typed): "'Today in Congress' needs to come
  // first on the header".
  { href: '/today', key: 'today' },
  { href: '/bills', key: 'bills' },
  // Moments joined 2026-07-25 (v2 slice S5) — flagship surface, never held
  // back.
  { href: '/questions', key: 'moments' },
  { href: '/reps', key: 'reps' },
] as const;

/** A thumb-bar tab's label: `navShort`, except the Big Questions tab, which
 *  reads the full `nav.moments` ("Big Questions" / "Grandes preguntas", one
 *  line): the owner's 2026-11-24 pick, "Four tabs: Home · Bills · Big
 *  Questions · Reps", made the room for it. */
const TAB_FULL_LABEL: ReadonlySet<string> = new Set(['moments']);

/** Segment-exact for everything but Home: '/reps' is current on a member page
 *  ('/reps/<id>'), and no path merely sharing a prefix ('/callx') counts. */
function isActive(pathname: string, href: string) {
  if (href === '/') return pathname === '/';
  return pathname === href || pathname.startsWith(`${href}/`);
}

/** A row-nav label: the bar's short word below 64rem, the full one from 64rem
 *  (see LINKS for the measurement). `display: none` takes the other one out
 *  of the accessibility tree, so the link's name is always the visible word. */
function RowLabel({ short, full }: { short: string; full: string }) {
  if (short === full) return <>{full}</>;
  return (
    <>
      <span className="lg:hidden">{short}</span>
      <span className="hidden lg:inline">{full}</span>
    </>
  );
}

export function Header() {
  const t = useTranslations('common');
  const locale = useLocale();
  const pathname = usePathname();
  const tabLabel = (key: (typeof TABS)[number]['key']) =>
    TAB_FULL_LABEL.has(key) ? t(`nav.${key}`) : t(`navShort.${key}`);

  return (
    <>
      <header className="on-band border-b border-go-deep bg-go-deep">
        <div className="mx-auto flex min-h-14 max-w-5xl items-center gap-3 px-4 md:min-h-16">
          <Link href="/" className="inline-flex min-h-11 items-center text-paper">
            {/* Sized AGAINST the language switch, not by eye: the switch box
                measures 46px tall, and the lockup's art height is the mark
                times RAVAN_SCALE (1.0657). 2.5rem puts the art at ~42.6px, so
                the two objects read as a matched pair inside both the 56px
                mobile bar and the 64px desktop one. */}
            <OravanLockup markRem={2.5} />
          </Link>

          {/* THE TRUST LINE (2026-08 design pick A1): the product's
              posture stated in the chrome itself, on every page.
              Wide bars only: the 390px bar keeps its one-row, 56px budget
              untouched, and the phone already carries the promise in the
              hero. EN ONLY in this inline slot — measured on the production
              build at the 1024 content rail: EN bar totals 963px of 992
              usable, but the Spanish nav alone is 686px, so the inline
              variant can never fit /es (the squeeze crushed the language
              switcher to 25px cells and swallowed its clicks). Spanish
              carries the SAME two sentences in the sub-bar below. */}
          {locale === 'en' && (
            <p className="hidden border-l-[1.5px] border-go-pale pl-3 text-xs leading-tight text-go-pale lg:block">
              {t('trustLine1')}
              <br />
              {t('trustLine2')}
            </p>
          )}

          <nav
            aria-label={t('nav.primaryLabel')}
            className="ml-auto hidden items-center gap-0.5 md:flex lg:gap-1"
          >
            {LINKS.map(({ href, key }) => {
              const active = isActive(pathname, href);
              return (
                <Link
                  key={key}
                  href={href}
                  aria-current={active ? 'page' : undefined}
                  className={`inline-flex min-h-11 items-center rounded-control px-2 text-sm font-semibold whitespace-nowrap transition-colors lg:px-3 ${
                    active ? 'bg-paper text-go-deep' : 'text-paper hover:bg-go active:bg-go'
                  }`}
                >
                  <RowLabel short={t(`navShort.${key}`)} full={t(`nav.${key}`)} />
                </Link>
              );
            })}
          </nav>

          <div className="ml-auto md:ml-0">
            <LocaleSwitcher />
          </div>
        </div>
        {/* The Spanish trust line — same sentences, the sub-bar placement
            (see the EN inline note above for the measured 686px-nav reason).
            Wide screens only, matching the EN variant's scope. */}
        {locale === 'es' && (
          <div className="hidden border-t border-go-pale bg-go-deep lg:block">
            <p className="mx-auto max-w-5xl px-4 py-1 text-center text-2xs font-semibold tracking-[0.06em] text-go-pale">
              {t('trustLine1')} {t('trustLine2')}
            </p>
          </div>
        )}
      </header>

      {/* THE ISLAND BAR (phones). A floating, rounded bar inset from the
          screen's edges, the owner's pick of 2026-09-27 ("the floating island
          tab bar", docs/current-direction.md, Shape), built 2026-11-22 on his
          card answer "Also build the floating tab bar before launch".

          GLASS, COMPUTED: `.island-bar` (app/globals.css) is paper at 72%
          over a 16px blur where the browser has backdrop-filter, solid paper
          where it does not, under `prefers-reduced-transparency: reduce` and
          under `prefers-contrast: more` (a 2px ink edge there). Every label is
          ink, never ink-2: ink on the glass is 8.30:1 over pure black, the
          floor nothing scrolling beneath can go below (the dark Big Questions
          band and the footer are ink, 9.05:1). tests/island-bar.unit.spec.ts
          recomputes it from the CSS.

          SIZE: 4px off the bottom, or the safe area where that is larger;
          6px off each side below 22.5rem (the 320px screen, where Spanish
          needs the width), then at most 21rem wide, centred. 44px tabs and a
          4px padding top and bottom make it 52px tall.

          FOUR TABS, EACH SIZED BY ITS LABEL (owner, 2026-11-24: "Four tabs:
          Home · Bills · Big Questions · Reps"). Not four equal columns: each
          tab starts at its label's width plus 6px a side (at least 44px) and
          the bar's spare width is shared out evenly, so "Big Questions" gets
          the room it needs. Labels MEASURED at 12px bold Libre Franklin (the
          widest a label gets, on its own page): Home 34, Bills 25, Big
          Questions 81, Reps 29; Inicio 31, Proyectos 59, Grandes preguntas
          110, Mis reps 49 (px). At 320px the bar is 308px and its row 304px;
          Spanish needs 249 + 4 × 12 = 297px before `tracking-tight` takes
          about 12px back, English 227px with Bills and Reps held at 44. Every
          label stays one line (`whitespace-nowrap`), and a flex item never
          shrinks below its label, so nothing wraps or clips.
          tests/header-phone-label.spec.ts measures it at 320px and 390px in
          both languages.

          THE BAR TAKES 56px OF THE SCREEN, AND NO MORE (2026-11-22): its top
          edge is at 788 on a 390×844 phone and 608 on 390×664. The first
          build (56px tall, 8px off) put it at 780, over the last 2px of the
          hero's "View in English" with ZIP 10001 saved (738–782,
          tests/home-fold.spec.ts). 788 leaves that link 6px clear.

          `data-thumb-bar` is how an in-place glossary box finds the bar's
          top edge and keeps its last line (the AI label) above it
          (components/GlossaryPopover.tsx). The footer carries the clearance
          that lets the last of every page scroll clear of the bar
          (components/Footer.tsx), and the floating call button parks 12px
          above it (components/FloatingCallButton.tsx). */}
      <nav
        data-thumb-bar
        aria-label={t('nav.primaryLabel')}
        className="island-bar fixed inset-x-0 bottom-[max(0.25rem,env(safe-area-inset-bottom))] z-40 mx-auto w-[calc(100%-0.75rem)] rounded-full md:hidden min-[22.5rem]:w-[min(calc(100%-1rem),21rem)]"
      >
        <ul className="flex px-0.5 py-1">
          {TABS.map(({ href, key, icon: Icon }) => {
            const active = isActive(pathname, href);
            return (
              <li key={key} className="flex flex-auto">
                <Link
                  href={href}
                  aria-current={active ? 'page' : undefined}
                  data-island-tab
                  // `tracking-tight` below 22.5rem: at 320px Spanish is the
                  // long language ("Grandes preguntas"). The current tab is
                  // marked by a wash lozenge with a line-strong edge AND a
                  // bold label (`.island-bar` in app/globals.css), never by
                  // colour alone.
                  className={`flex min-h-11 min-w-11 flex-1 flex-col items-center justify-center gap-0.5 rounded-control px-1.5 text-2xs leading-tight tracking-tight text-ink min-[22.5rem]:tracking-normal ${
                    active ? 'font-bold' : 'font-semibold'
                  }`}
                >
                  <Icon className="h-5 w-5" aria-hidden />
                  <span data-tab-label className="whitespace-nowrap">
                    {tabLabel(key)}
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
    </>
  );
}
