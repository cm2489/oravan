import { NextRequest, NextResponse } from 'next/server';
import { districtsForZip, repsForDistrict, vacancyForDistrict } from '@/lib/core';

/** ZIP -> representatives. Pure lookup over static data; nothing logged, nothing stored. */
export async function GET(req: NextRequest) {
  const zip = req.nextUrl.searchParams.get('zip') ?? '';
  if (!/^\d{5}$/.test(zip)) {
    return NextResponse.json({ error: 'bad_zip' }, { status: 400 });
  }
  const districts = districtsForZip(zip);
  const seen = new Set<string>();
  const reps = districts
    .flatMap((d) => repsForDistrict(d))
    .filter((r) => (seen.has(r.bioguide) ? false : (seen.add(r.bioguide), true)));
  // Fact only (state + district) - `since` is pipeline bookkeeping for
  // de-duplicating alerts across weekly runs, not surfaced as an
  // authoritative event date to API consumers.
  const vacancies = districts
    .map((d) => vacancyForDistrict(d))
    .filter((v): v is NonNullable<typeof v> => Boolean(v))
    .map((v) => ({ state: v.state, district: v.district }));
  return NextResponse.json({ reps, multiDistrict: districts.length > 1, vacancies });
}
