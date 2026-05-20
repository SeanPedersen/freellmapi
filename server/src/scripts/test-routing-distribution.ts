/**
 * Walk the live routing chain 100 steps and report which models are selected.
 * Uses the real database and real analytics history — no synthetic data.
 *
 * Each step adds the chosen model+key to skipKeys so the next call must
 * pick a different one, revealing the full sorted priority order.
 *
 * Usage: npx tsx src/scripts/test-routing-distribution.ts
 */

import '../env.js';
import { initDb } from '../db/index.js';
import { routeRequest } from '../services/router.js';

initDb();

const order: string[] = [];
const skipKeys = new Set<string>();

for (let i = 0; i < 100; i++) {
  let route;
  try {
    route = routeRequest(1000, skipKeys.size > 0 ? skipKeys : undefined);
  } catch {
    break;
  }
  order.push(`${route.platform}/${route.modelId}`);
  skipKeys.add(`${route.platform}:${route.modelId}:${route.keyId}`);
}

console.log('\n=== Routing order (each step forced to pick next-best) ===\n');

const providerCounts = new Map<string, number>();
for (const [idx, label] of order.entries()) {
  const provider = label.split('/')[0];
  providerCounts.set(provider, (providerCounts.get(provider) ?? 0) + 1);
  console.log(`${String(idx + 1).padStart(3)}. ${label}`);
}

console.log('\n=== Provider distribution ===\n');
const sorted = [...providerCounts.entries()].sort((a, b) => b[1] - a[1]);
for (const [provider, count] of sorted) {
  const bar = '█'.repeat(count);
  const pct = ((count / order.length) * 100).toFixed(0).padStart(3);
  console.log(`  ${provider.padEnd(14)} ${String(count).padStart(3)} (${pct}%)  ${bar}`);
}

const topProvider = order[0]?.split('/')[0];
const streak = order.findIndex(l => !l.startsWith(topProvider + '/'));
console.log(`\nTotal slots visited:      ${order.length}`);
console.log(`Unique providers reached: ${providerCounts.size}`);
console.log(`Top provider streak:      ${streak === -1 ? order.length : streak} before another provider appears`);
