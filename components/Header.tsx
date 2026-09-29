'use client';

import { useSyncExternalStore, type ReactNode } from 'react';
import { Home, ScrollText, Users, Phone, Newspaper } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { Link, usePathname } from '@/i18n/navigation';
import {
  CALL_HUB_PATH,
  callTabServerSnapshot,
  callTabSnapshot,
  isInPageTarget,
  subscribeCallTab,
} from '@/lib/call-tab';
import { CALL_BUTTON, CALL_BUTTON_CURRENT } from './call-button';
import { OravanLockup } from './brand/OravanLockup';
import { LocaleSwitcher } from './LocaleSwitcher';

/*
 * THE SITE BAR — the most-seen surface in the product, so it is held to a
 * budget: at 390px it is ONE row, 56px tall, and it is the only thing between
 * the top of the screen and the page's own headline.
 *
 * GROUND: paper, closed by a `line` rule. `line` (1.37:1) is legal here
 * because it SEPARATES two paper areas — it is not a component edge, and it is
 * not the only thing making a control findable.
 *
 * "YOU ARE HERE" IS AN INK FILL, and nothing else. That is the language
 * switch's own convention in the reference, so the nav borrows it and one mark
 * means one thing across the whole bar. The action green is spent on actions;
 * navigating is not an action, and the go-mark (the 6px bar) never underlines
 * a link.
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
 * ONE ORDER, BOTH NAVS (owner, 2026-09-29, "nav 1"; wireframes v2, "The same
 * on every page"): the thumb bar is Home · Bills · Call · Questions · Reps,
 * and the row nav is the same order with the lockup as Home and the language
 * switch last. Today stays OFF the bar — it is one tap from Home, and the
 * owner looks at /today visits after about 30 days (reminder around
 * 2026-10-29). "My record" left the bar in the same ruling: the Reps page
 * links it ("See your record") until the Reps rebuild folds the record in
 * (wireframe Q4 b+c), and the call panel's own "See your record" still lands
 * there. "Why call?" left the row nav; it is a footer link on every page.
 *
 * THE CALL ITEM IS THE ONE CALL CONTROL IN THE BAR, so it wears the shared
 * call-button style (components/call-button.ts) rather than a nav item's, in
 * both navs. Where it GOES is the page's to say (lib/call-tab.ts): an open
 * bill's own panel, a Big Question's open bills, or — with nothing declared,
 * and always on the server render — the Call hub at /call.
 */

/** The thumb bar (phones): five destinations, home included. Five cells at
 *  the 5xl max width is ≥64px each at 320px — comfortably over the 44px
 *  floor (verified in e2e). Moments joined 2026-07-25 (v2 slice S5): the
 *  discovery layer is a flagship surface now, not an experiment. Call joined
 *  2026-09-29 in "My record"'s place (owner, "nav 1"). */
const TABS = [
  { href: '/', key: 'home', icon: Home },
  { href: '/bills', key: 'bills', icon: ScrollText },
  { href: CALL_HUB_PATH, key: 'call', icon: Phone },
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
 * it 8px worse.) So BELOW 64rem the row prints the thumb bar's short labels
 * ("Proyectos", "Preguntas", "Mis reps"; 337px), in both languages for one
 * rule, and the full labels from 64rem, where /es measures 853px of 992.
 * tests/call-hub.spec.ts pins the 768px row: one line, no overflow, and the
 * switch at its full width.
 */
const LINKS = [
  { href: '/bills', key: 'bills' },
  { href: CALL_HUB_PATH, key: 'call' },
  // Moments joined 2026-07-25 (v2 slice S5) — flagship surface, never held
  // back.
  { href: '/questions', key: 'moments' },
  { href: '/reps', key: 'reps' },
] as const;

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

/**
 * The Call item's link: an in-page anchor is a plain <a> (the browser scrolls
 * to it, and `scroll-behavior: smooth` glides there); a route is the
 * locale-aware Link, so /es pages stay in Spanish.
 */
function CallLink({
  href,
  current,
  className,
  children,
}: {
  href: string;
  current: boolean;
  className: string;
  children: ReactNode;
}) {
  if (isInPageTarget(href)) {
    return (
      <a href={href} data-call-tab={href} className={className}>
        {children}
      </a>
    );
  }
  return (
    <Link
      href={href}
      data-call-tab={href}
      aria-current={current ? 'page' : undefined}
      className={className}
    >
      {children}
    </Link>
  );
}

export function Header() {
  const t = useTranslations('common');
  const locale = useLocale();
  const pathname = usePathname();
  // What this page declared for the Call item, or null → the Call hub.
  const callTarget = useSyncExternalStore(subscribeCallTab, callTabSnapshot, callTabServerSnapshot);
  const callHref = callTarget ?? CALL_HUB_PATH;
  const onHub = isActive(pathname, CALL_HUB_PATH);

  return (
    <>
      <header className="border-b border-line bg-paper">
        <div className="mx-auto flex min-h-14 max-w-5xl items-center gap-3 px-4 md:min-h-16">
          <Link href="/" className="inline-flex min-h-11 items-center text-ink">
            {/* Sized AGAINST the language switch, not by eye: the switch box
                measures 46px tall, and the lockup's art height is the mark
                times RAVAN_SCALE (1.0657). 2.5rem puts the art at ~42.6px, so
                the two objects read as a matched pair inside both the 56px
                mobile bar and the 64px desktop one. */}
            <OravanLockup markRem={2.5} markClassName="text-go" />
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
            <p className="hidden border-l-[1.5px] border-line pl-3 text-xs leading-tight text-ink-2 lg:block">
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
              if (key === 'call') {
                return (
                  <CallLink
                    key={key}
                    href={callHref}
                    current={onHub}
                    className={`mx-1 inline-flex min-h-11 items-center gap-1.5 px-2 text-sm whitespace-nowrap lg:px-3 ${
                      onHub ? CALL_BUTTON_CURRENT : CALL_BUTTON
                    }`}
                  >
                    <Phone className="h-4 w-4 flex-none" aria-hidden />
                    <RowLabel short={t('navShort.call')} full={t('nav.call')} />
                  </CallLink>
                );
              }
              return (
                <Link
                  key={key}
                  href={href}
                  aria-current={active ? 'page' : undefined}
                  className={`inline-flex min-h-11 items-center rounded-control px-2 text-sm font-semibold whitespace-nowrap transition-colors lg:px-3 ${
                    active ? 'bg-ink text-paper' : 'text-ink hover:bg-wash active:bg-wash'
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
          <div className="hidden border-t border-line bg-wash lg:block">
            <p className="mx-auto max-w-5xl px-4 py-1 text-center text-2xs font-semibold tracking-[0.06em] text-ink-2">
              {t('trustLine1')} {t('trustLine2')}
            </p>
          </div>
        )}
      </header>

      {/* The thumb bar. Paper, not ink: the footer is the page's only dark
          mass, and a permanent dark band across the bottom of every phone
          screen would take that meaning away from it. Its top rule is
          `line-strong` (3.24:1 on paper) because THAT rule is a real
          boundary — the only thing separating a fixed bar from the content
          scrolling underneath it — and `line` would not clear 1.4.11.
          `data-thumb-bar` is how an in-place glossary box finds the bar's
          top edge and keeps its last line (the AI label) above it
          (components/GlossaryPopover.tsx). */}
      <nav
        data-thumb-bar
        aria-label={t('nav.primaryLabel')}
        className="fixed inset-x-0 bottom-0 z-40 border-t border-line-strong bg-paper pb-[env(safe-area-inset-bottom)] md:hidden"
      >
        <ul className="mx-auto grid max-w-5xl grid-cols-5">
          {TABS.map(({ href, key, icon: Icon }) => {
            const active = isActive(pathname, href);
            if (key === 'call') {
              /* The call cell: the shared call style, inset 2px from the
                 cell so its edge never meets the bar's top rule. 44px tall
                 inside the 48px row (the touch floor), and the full cell
                 wide less 4px. Current on /call only: the ink fill every
                 current nav item uses, since a filled box already says
                 "here" and the other tabs' 3px top rule would sit inside
                 the edge. */
              return (
                <li key={key} className="flex">
                  <CallLink
                    href={callHref}
                    current={onHub}
                    className={`mx-0.5 my-0.5 flex min-h-11 flex-1 flex-col items-center justify-center gap-0.5 px-1 text-2xs leading-tight ${
                      onHub ? CALL_BUTTON_CURRENT : CALL_BUTTON
                    }`}
                  >
                    <Icon className="h-5 w-5" aria-hidden />
                    {t(`navShort.${key}`)}
                  </CallLink>
                </li>
              );
            }
            return (
              <li key={key}>
                <Link
                  href={href}
                  aria-current={active ? 'page' : undefined}
                  // `tracking-tight` below 22.5rem, full tracking above it.
                  // Five cells at 320px are 64px each, and Spanish is the
                  // long language here: "Momentos" measures 61.6px of glyphs
                  // in that cell — 1.2px of slack per side, so adjacent
                  // labels very nearly touch (pre-launch audit, 2026-07-25;
                  // English never showed it, which is exactly the
                  // measure-the-longer-language lesson). Nothing was clipped,
                  // so this buys breathing room rather than fixing a break —
                  // and it buys it ONLY where the pressure is real.
                  className={`relative flex min-h-12 flex-col items-center justify-center gap-0.5 px-1 text-2xs leading-tight tracking-tight min-[22.5rem]:px-2 min-[22.5rem]:tracking-normal ${
                    active
                      ? 'font-bold text-ink after:absolute after:inset-x-0 after:top-0 after:h-[3px] after:bg-ink'
                      : 'font-semibold text-ink-2'
                  }`}
                >
                  <Icon className="h-5 w-5" aria-hidden />
                  {t(`navShort.${key}`)}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
    </>
  );
}
