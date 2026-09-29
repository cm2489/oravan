import { voteMemberFileNames, voteMembersForFile } from '@/lib/vote-members';

/*
 * ONE STATIC JSON FILE PER ROLL CALL: `/votes/<rollCallId>.json`, the
 * member-by-member list the bill page's "How members voted" disclosure fetches
 * when a reader opens it (components/VoteMembers.tsx). Before 2026-09-29 that
 * list was printed into the bill page itself, every member of every roll call,
 * and after the 119th Congress back-fill that made the heaviest bill page about
 * 3.95 MB of HTML. The lists are the same; they are simply fetched on demand.
 *
 * STATIC-FIRST (CLAUDE.md rule 2). `force-static` with `dynamicParams = false`:
 * every file is prerendered at build from the committed data/votes.json, and a
 * name the build did not write is a 404, never a per-request render. No
 * per-request code runs here. tests/static-rendering.spec.ts pins that every
 * stored roll call's file is in the build's prerender manifest.
 *
 * NO USER DATA (rule 1). A fetch here carries nothing about the reader: the
 * path is a roll-call id every visitor of the bill page already has, the page
 * sends it without credentials, and the dotted path keeps proxy.ts (locale
 * negotiation and the page-view count) out of it.
 *
 * The folder name holds the file name, extension included (`[file]` =
 * `h-119-1-6.json`), for the reason app/feed/whats-moving.json/route.ts gives
 * for its dotted folder: Next has no partial dynamic segment like `[id].json`.
 */
export const dynamic = 'force-static';
export const dynamicParams = false;

export function generateStaticParams() {
  return voteMemberFileNames().map((file) => ({ file }));
}

export async function GET(_request: Request, { params }: { params: Promise<{ file: string }> }) {
  const { file } = await params;
  const body = voteMembersForFile(file);
  if (!body) return new Response('Not found', { status: 404 });
  return new Response(JSON.stringify(body), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      // The same hour the site's JSON feed allows: the file changes only
      // when data/votes.json does, and that only lands with a redeploy.
      'Cache-Control': 'public, max-age=3600',
    },
  });
}
