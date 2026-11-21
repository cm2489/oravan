'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { erasureCount, savedZip, useErasures, usePrefs } from '@/lib/local';
import { pendingSavedZip, type MembersEntry } from '@/lib/members-entry';

/*
 * THE REPS TAB OPENS ON YOUR MEMBERS (owner, UX question Q8 answered "a" on
 * 2026-09-28: "Yes. The Reps tab opens on your members, with 'Change ZIP'.
 * The ZIP is kept only on the device and sent only to the stateless lookup,
 * as the bill panel already does.").
 *
 * Bare /reps is rendered on the server, which cannot know the saved ZIP: it
 * lives only in this browser (lib/local.ts). So once the page is running,
 * this reads it and, when there is one, hands it to `onLookup`
 * (components/RepsLookup.tsx), which sends it in a POST body to the members
 * lookup, matched in memory and stored nowhere. The address stays /reps:
 * until 2026-11-12 this swapped in /reps?zip=<ZIP>, which put the ZIP in the
 * host's request log and the browser's history (owner, 2026-11-12). Nothing
 * new is stored anywhere.
 *
 * WHAT THIS TAB LAST SHOWED COMES FIRST (2026-11-12). `arrival` reads this
 * tab's own history entry (lib/members-entry.ts): on Reload, or on Back to
 * this page, it holds the ZIP and the refined district the page last showed,
 * and those are looked up instead of the saved ZIP, the way an address with
 * ?zip=…&district=… did before 2026-11-12. A fresh arrival's entry holds
 * nothing, so the saved ZIP answers.
 *
 * The ZIP is read when the page opens, so a ZIP typed into the form below
 * does not trigger a second lookup; and read again after every erase or
 * change of ZIP made elsewhere (the erase count, lib/local.ts), because the
 * lookup that was running then is dropped (components/RepsLookup.tsx). Its
 * status line goes with it: after "erase, then the same ZIP saved again" it
 * used to come back and wait for an answer that never came (check 6,
 * 2026-11-20). Now the page starts again: the saved ZIP, if there is one, is
 * looked up afresh; otherwise the prompt stays.
 *
 * Until then the children (the ZIP prompt) render, so the page still works
 * with JavaScript off or with no saved ZIP. While the lookup is on its way the
 * prompt gives way to one status line, so nobody starts typing into a form
 * that is about to be replaced; if the lookup cannot be made (offline), the
 * prompt comes back.
 *
 * "Change ZIP code" links to /reps?change=1, and the page renders the prompt
 * without this wrapper there — otherwise the saved ZIP would send the reader
 * straight back to the members they asked to change.
 *
 * THE #HASH IS KEPT (2026-09-29). The call panel's "See your record" lands
 * on this page's Your calls (`/reps#your-calls`, components/YourRecord.tsx),
 * and a reader who has logged a call has a saved ZIP, so this lookup runs on
 * exactly that arrival. RepsLookup scrolls back to the hash once the members
 * are in, so the reader lands on the calls they came to see.
 */
export function SavedZipLookup({
  children,
  arrival,
  onLookup,
}: {
  children: ReactNode;
  /** What this tab's history entry remembers, read once (see above). */
  arrival: () => MembersEntry | null;
  /** Look the members up; resolves false when the lookup could not be made. */
  onLookup: (entry: MembersEntry) => Promise<boolean>;
}) {
  const t = useTranslations('reps');
  const [pending, setPending] = useState<{ zip: string; erasures: number } | null>(null);
  const prefs = usePrefs();
  const erasures = useErasures();

  useEffect(() => {
    const saved = savedZip();
    const entry = arrival() ?? (saved ? { zip: saved } : null);
    if (!entry) return;
    const asked = erasureCount();
    let live = true;
    void onLookup(entry).then((ok) => {
      if (live && !ok) setPending(null);
    });
    // The status line says the ZIP is the one "saved on this device", so it
    // shows only when that is the ZIP being looked up; a history entry's
    // other ZIP (an old link's, on Reload) keeps the prompt up meanwhile.
    if (entry.zip !== saved) {
      return () => {
        live = false;
      };
    }
    // The status line is set a tick later: a synchronous state write in the
    // effect body is what react-hooks/set-state-in-effect forbids (the same
    // defer components/ActionPanel.tsx documents for its own lookup).
    const id = setTimeout(() => setPending({ zip: entry.zip, erasures: asked }), 0);
    return () => {
      live = false;
      clearTimeout(id);
    };
    // When the page opens, and again after each erase or change elsewhere
    // (see above), never on anything else: arrival and onLookup are new
    // functions on every render of the page, and a re-run would look the ZIP
    // up again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [erasures]);

  // The line names the ZIP "saved on this device", so it stands only while
  // that is still true and its lookup is still the one running: an erase on
  // this page (components/YourRecord.tsx) brings the prompt back at once,
  // even with the lookup still on its way.
  const zip = pendingSavedZip(pending, prefs.zip, erasures);
  if (!zip) return <>{children}</>;
  return (
    <p role="status" data-saved-zip-lookup="" className="max-w-xl text-lg font-bold">
      {t('savedZipLoading', { zip })}
    </p>
  );
}

/**
 * " · kept on this device only", beside the ZIP line on /reps — printed only
 * when this browser's saved ZIP IS the one on the page (wireframes v2,
 * reps.html: "ZIP 98103 · kept on this device only"). An old /reps?zip=
 * link someone shared saves nothing, so there it would be untrue, and the server
 * render, which cannot see this browser's storage, prints nothing.
 */
export function ZipKeptNote({ zip }: { zip: string }) {
  const t = useTranslations('reps');
  const prefs = usePrefs();
  if (prefs.zip !== zip) return null;
  // No-break space before the "·", so a wrapped line never starts with it.
  return (
    <span data-zip-kept="">
      {' · '}
      {t('zipKept')}
    </span>
  );
}
