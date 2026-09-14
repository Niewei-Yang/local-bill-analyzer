import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../static/app.js', import.meta.url), 'utf8');
const context = vm.createContext({ Intl });
vm.runInContext(source.split('$("#uploadButton").addEventListener')[0], context);
const { periodBudget, cumulativeDailyPoints } = vm.runInContext('({ periodBudget, cumulativeDailyPoints })', context);
assert.equal(periodBudget('2026-04', 'month'), 4500);
assert.equal(periodBudget('2026-04', 'month', 6000), 6000);
assert.equal(periodBudget('2026-04-06', 'week', 6000), 1400);
assert.equal(periodBudget('2026-08-31', 'week', 6000), Math.round((6000 / 31 + 6 * 6000 / 30) * 100) / 100);
assert.equal(periodBudget('2026-04-06', 'week', 0), 0);
assert.equal(periodBudget('2026-04-06', 'week'), 1050);
assert.equal(periodBudget('2026-02-02', 'week'), 1125);
assert.equal(periodBudget('2024-02-05', 'week'), 1086.21);
assert.equal(periodBudget('2026-08-31', 'week'), Math.round((4500 / 31 + 6 * 4500 / 30) * 100) / 100);
const points = cumulativeDailyPoints([
  { period: '2026-01-01', total: 0.1 },
  { period: '2026-01-03', total: 0.2 },
  { period: '2026-01-04', total: -2 },
], { start: '2026-01-01', end: '2026-01-05' });
assert.deepEqual(Array.from(points, point => point.total), [0.1, 0.1, 0.3, -1.7, -1.7]);
assert.equal(cumulativeDailyPoints([], { start: '2024-02-01', end: '2024-02-29' }).length, 29);
console.log('Growth calculations passed: budgets, leap year, cross-month week, missing days, refunds, cents.');
