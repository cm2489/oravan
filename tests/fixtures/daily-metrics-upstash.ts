/*
 * Preload for tests/ops-repo.unit.spec.ts: runs inside the CHILD process
 * that executes scripts/daily-metrics.mjs (`node --import tsx --import
 * <this file>`), before the script's own modules evaluate. It swaps the
 * child's fetch for the in-process Upstash mock and seeds yesterday's counters
 * with two figures distinctive enough to grep for — so the spec can prove
 * where the numbers went (the private digest comment and spike issue) and
 * where they did not (the public run log). Any other fetch throws, so the
 * child can never reach a network.
 */
import { COUNTERS_URL, MockUpstash, installUpstashFetch } from '../upstash-mock';
import { pageviewUsageKey, scriptUsageKey } from '../../lib/usage';
import { declineWindowDays } from '../../lib/traffic-metrics.mjs';

export const SEEDED_PAGEVIEWS = '424242';
export const SEEDED_SCRIPT_GENERATIONS = '31337';

const yesterday = declineWindowDays()[0];
const mock = new MockUpstash();
mock.store.set(pageviewUsageKey('home', yesterday), { value: SEEDED_PAGEVIEWS, expiresAt: null });
mock.store.set(scriptUsageKey(yesterday), { value: SEEDED_SCRIPT_GENERATIONS, expiresAt: null });
installUpstashFetch({ [COUNTERS_URL]: mock });
