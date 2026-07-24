import { Phone } from 'lucide-react';

/**
 * The call, surfaced in the reading flow (right after Decoded) so the primary
 * action isn't stranded at the bottom of a long page. An ink enamel card that
 * jumps to the full action panel (#act). Reuses the panel's own copy — no new
 * strings. Marked [data-call-cta] so the floating button stands down when it's
 * on screen (see FloatingCallButton).
 *
 * NOTE (design-refresh reconcile, 2026-07-24): this component is currently
 * imported by nothing — the bill page reaches the action panel directly. Its
 * tokens were migrated to variant B so the tree carries no retired names, but
 * it is dead code and is a candidate for deletion.
 */
export function CallPrompt({
  label,
  sub,
  href = '#act',
}: {
  label: string;
  sub?: string;
  href?: string;
}) {
  return (
    <div
      data-call-cta
      className="on-dark mt-8 flex flex-wrap items-center justify-between gap-4 rounded-control bg-ink-deep p-6 text-paper"
    >
      {sub && <p className="min-w-0 font-medium text-ink-pale">{sub}</p>}
      <a
        href={href}
        className="ring-gap inline-flex min-h-12 items-center gap-2 rounded-control border-2 border-go bg-go px-5 py-3 font-bold text-paper no-underline hover:border-go-deep hover:bg-go-deep active:translate-y-px"
      >
        <Phone className="h-4 w-4" aria-hidden />
        {label}
      </a>
    </div>
  );
}
