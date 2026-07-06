import { NextRequest, NextResponse } from 'next/server';
import { districtsForZip, repsForDistrict } from '@/lib/core';

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
  return NextResponse.json({ reps, multiDistrict: districts.length > 1 });
}
