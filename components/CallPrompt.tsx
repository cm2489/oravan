import { Phone } from 'lucide-react';

/**
 * The call, surfaced in the reading flow (right after Decoded) so the primary
 * action isn't stranded at the bottom of a long page. A quiet dark card that
 * jumps to the full action panel (#act). Reuses the panel's own copy — no new
 * strings. Marked [data-call-cta] so the floating button stands down when it's
 * on screen (see FloatingCallButton).
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
      className="mt-8 flex flex-wrap items-center justify-between gap-4 rounded-card bg-night p-6 text-paper"
    >
      {sub && <p className="min-w-0 font-medium text-paper/85">{sub}</p>}
      <a
        href={href}
        className="inline-flex items-center gap-2 rounded-control bg-brass px-5 py-3 font-semibold text-paper transition-transform hover:bg-brass-deep active:translate-y-px"
      >
        <Phone className="h-4 w-4" aria-hidden />
        {label}
      </a>
    </div>
  );
}
