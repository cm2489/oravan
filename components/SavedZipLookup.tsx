'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter } from '@/i18n/navigation';
import { savedZip, usePrefs } from '@/lib/local';

/*
 * THE REPS TAB OPENS ON YOUR MEMBERS (owner, UX question Q8 answered "a" on
 * 2026-09-28: "Yes. The Reps tab opens on your members, with 'Change ZIP'.
 * The ZIP is kept only on the device and sent only to the stateless lookup,
 * as the bill panel already does.").
 *
 * Bare /reps is rendered on the server, which cannot know the saved ZIP: it
 * lives only in this browser (lib/local.ts). So once the page is running,
 * this reads it and, when there is one, replaces the URL with /reps?zip=<ZIP>
 * — the same request the ZIP form makes, answered by the same page, which
 * matches the ZIP in memory and stores nothing (the trip privacy.p2 already
 * describes). Nothing new is stored anywhere.
 *
 * `replace`, never `push`: Back must leave /reps, not land on bare /reps and
 * bounce forward again. The ZIP is read ONCE, when the page opens, so a ZIP
 * typed into the form below does not trigger a second navigation.
 *
 * Until then the children (the ZIP prompt) render, so the page still works
 * with JavaScript off or with no saved ZIP. While the lookup is on its way the
 * prompt gives way to one status line, so nobody starts typing into a form
 * that is about to be replaced.
 *
 * "Change ZIP code" links to /reps?change=1, and the page renders the prompt
 * without this wrapper there — otherwise the saved ZIP would send the reader
 * straight back to the members they asked to change.
 *
 * THE #HASH RIDES ALONG (2026-09-29). The call panel's "See your record"
 * lands on this page's Your calls (`/reps#your-calls`, components/
 * YourRecord.tsx), and a reader who has logged a call has a saved ZIP, so this
 * swap runs on exactly that arrival. Without the hash the reader would land
 * at the top of the members instead of on the calls they came to see.
 */
export function SavedZipLookup({ children }: { children: ReactNode }) {
  const t = useTranslations('reps');
  const router = useRouter();
  const [zip, setZip] = useState<string | null>(null);

  useEffect(() => {
    const saved = savedZip();
    if (!saved) return;
    router.replace(`/reps?zip=${saved}${window.location.hash}`);
    // The status line is set a tick later: a synchronous state write in the
    // effect body is what react-hooks/set-state-in-effect forbids (the same
    // defer components/ActionPanel.tsx documents for its own lookup).
    const id = setTimeout(() => setZip(saved), 0);
    return () => clearTimeout(id);
  }, [router]);

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
 * reps.html: "ZIP 98103 · kept on this device only"). A /reps?zip= link
 * someone shared saves nothing, so there it would be untrue, and the server
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
