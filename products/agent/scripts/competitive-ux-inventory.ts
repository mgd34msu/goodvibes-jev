#!/usr/bin/env bun
import {
  COMPETITIVE_FEATURE_INVENTORY,
  competitiveInventoryStatusCounts,
} from '../src/agent/competitive-feature-inventory.ts';

const args = process.argv.slice(2);
const counts = competitiveInventoryStatusCounts();

if (args.includes('--json')) {
  console.log(JSON.stringify({
    generatedAt: new Date().toISOString(),
    counts,
    items: COMPETITIVE_FEATURE_INVENTORY,
  }, null, 2));
  process.exit(0);
}

console.log('# Competitive UX Inventory');
console.log('');
console.log(`Items: ${COMPETITIVE_FEATURE_INVENTORY.length}`);
console.log(`Leading: ${counts.leading}  Parity: ${counts.parity}  Partial: ${counts.partial}  Gap: ${counts.gap}`);
console.log('');
console.log('| Feature | Status | Target | User Outcome |');
console.log('|---|---|---|---|');
for (const item of COMPETITIVE_FEATURE_INVENTORY) {
  console.log(`| ${item.id} | ${item.goodVibesStatus} | ${item.targetStandard} | ${item.userOutcome} |`);
}

