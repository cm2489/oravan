import { notFound } from 'next/navigation';

/*
 * The locale catch-all (Phase-1 P1, 2026-08-04). Before this file existed,
 * app/[locale]/not-found.tsx was dead code: an unmatched path under a locale
 * (/es/nonexistent) fell through to the ROOT boundary and rendered the bare
 * English fallback — no header, no footer, lang="en". Any path no real route
 * claims lands here, and notFound() renders the locale-scoped 404 inside the
 * locale layout with a true 404 status. This file renders nothing itself and
 * never will; it exists to make the boundary fire in the right place.
 *
 * Registered in tests/frame-posture.spec.ts's LOCALE_ROUTES (the regression
 * guard demands a frame-ancestors decision for every top-level segment):
 * a 404 response carries the site-wide lock like every non-embed route.
 */
export default function CatchAll(): never {
  notFound();
}
