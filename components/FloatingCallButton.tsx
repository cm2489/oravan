'use client';

import { useEffect, useState } from 'react';
import { Phone } from 'lucide-react';
import { useTranslations } from 'next-intl';

/**
 * A floating "Make the call" button that keeps the primary action reachable
 * anywhere on a long bill page — but stands down whenever another call CTA (the
 * inline prompt, or the action panel) is on screen, so two identical buttons are
 * never visible at once. It defers to every element marked [data-call-cta].
 *
 * While hidden it's inert: not clickable and out of the tab order. The fade is
 * neutralized under prefers-reduced-motion by the global rule in globals.css.
 */
export function FloatingCallButton({ href = '#act' }: { href?: string }) {
  const t = useTranslations('bill');
  const label = t('actTitle');
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    const targets = Array.from(document.querySelectorAll('[data-call-cta]'));
    if (targets.length === 0) return;
    const onScreen = new Set<Element>();
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (e.isIntersecting) onScreen.add(e.target);
        else onScreen.delete(e.target);
      }
      setHidden(onScreen.size > 0);
    });
    targets.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, []);

  return (
    <a
      href={href}
      data-floating-call
      aria-label={label}
      aria-hidden={hidden}
      tabIndex={hidden ? -1 : 0}
      className={`fixed bottom-[calc(4.5rem+env(safe-area-inset-bottom))] right-4 z-30 inline-flex items-center gap-2 rounded-full border-2 border-ink bg-booth px-5 py-4 font-semibold text-night shadow-lift transition-all duration-300 md:bottom-6 ${
        hidden ? 'pointer-events-none translate-y-3 opacity-0' : 'opacity-100'
      }`}
    >
      <Phone className="h-5 w-5 flex-none" aria-hidden />
      <span className="hidden sm:inline">{label}</span>
    </a>
  );
}
