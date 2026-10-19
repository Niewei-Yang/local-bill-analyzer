import assert from 'node:assert/strict';
import { chromium } from 'file:///C:/Users/Niewei/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';
import { showTrendPeriod } from './trend_helpers.mjs';

const base = process.env.BILL_ANALYZER_URL || 'http://127.0.0.1:8765';
const snapshot = page => page.evaluate(() => Object.fromEntries([
  '#periodText', '.stats', '#platformBar', '#monthlyChart', '.trend-detail-stats',
  '#categoryBars', '#heatmap', '#merchantTable', '#topDays', '#recentTable', '#recentHint',
  '#growthDayTable', '#growthDaySummary',
].map(selector => [selector, document.querySelector(selector).innerHTML])));
const waitForDetail = page => page.waitForFunction(() => !document.querySelector('#trendDetail').hidden && document.querySelector('#trendDetailTitle').textContent !== '正在读取…');
const browser = await chromium.launch({ headless: true, executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' });

try {
  for (const width of [1280, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(base, { waitUntil: 'networkidle' });
    assert.equal(await page.locator('.filters #excludeLargeExpenses').count(), 0);
    assert.equal(await page.locator('#dailyGrowthPanel #excludeLargeExpenses').count(), 1);
    assert.equal(await page.locator('#excludeLargeExpenses').isVisible(), false);
    assert.equal(await page.locator('#trendPrev').textContent(), '←');
    assert.equal(await page.locator('#trendNext').textContent(), '→');
    const top = await (await page.request.get(`${base}/api/transactions?direction=expense&sort=amount_desc&size=1`)).json();
    assert.ok(top.items[0].amount >= 1000);
    const day = top.items[0].transaction_time.slice(0, 10);
    const month = day.slice(0, 7);
    const monthStart = `${month}-01`;
    const [year, monthNumber] = month.split('-').map(Number);
    const monthEnd = new Date(Date.UTC(year, monthNumber, 0)).toISOString().slice(0, 10);
    await (await showTrendPeriod(page, month)).press('Enter');
    await waitForDetail(page);
    assert.equal(await page.locator('#excludeLargeExpenses').isVisible(), true);
    const originalPath = await page.locator('.growth-line').getAttribute('d');
    const originalSummary = await page.evaluate(() => state.growthContext.detail.summary);
    const originalIncome = await page.locator('.growth-school-income-point').evaluateAll(nodes => nodes.map(node => node.dataset.total));
    await page.locator(`.growth-point[data-day="${day}"]`).press('Enter');
    await page.waitForFunction(() => !document.querySelector('#growthDaySummary').textContent.includes('正在读取'));
    const outside = await snapshot(page);
    const requests = [];
    const track = request => { if (/\/api\//.test(request.url())) requests.push(new URL(request.url())); };
    page.on('request', track);
    const response = page.waitForResponse(response => response.url().includes('exclude_large_expenses=true'));
    await page.check('#excludeLargeExpenses');
    const filtered = await (await response).json();
    await page.waitForFunction(() => state.growthContext.chartDetail !== state.growthContext.detail);
    assert.ok(filtered.summary.expense_count < originalSummary.expense_count);
    assert.equal(filtered.summary.income, originalSummary.income);
    assert.equal(filtered.summary.refunds, originalSummary.refunds);
    assert.equal(filtered.summary.wechat_income, originalSummary.wechat_income);
    assert.deepEqual(await page.evaluate(() => state.growthContext.detail.summary), originalSummary);
    assert.deepEqual(await snapshot(page), outside);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].pathname, '/api/dashboard');
    assert.equal(requests[0].searchParams.get('granularity'), 'day');
    assert.equal(requests[0].searchParams.get('start'), monthStart);
    assert.equal(requests[0].searchParams.get('end'), monthEnd);
    assert.notEqual(await page.locator('.growth-line').getAttribute('d'), originalPath);
    assert.deepEqual(await page.locator('.growth-school-income-point').evaluateAll(nodes => nodes.map(node => node.dataset.total)), originalIncome);
    assert.equal(await page.evaluate(() => {
      const { chartDetail, bounds } = state.growthContext;
      return cumulativeDailyPoints(chartDetail.trend, bounds).at(-1).total;
    }), filtered.summary.net_spend);
    await page.fill('#monthlyBudget', '6000');
    assert.equal(await page.evaluate(() => state.growthContext.chartDetail.summary.net_spend), filtered.summary.net_spend);
    await page.fill('#monthlyBudget', '4500');
    assert.deepEqual(await snapshot(page), outside);
    await page.locator(`.growth-point[data-day="${day}"]`).press('Enter');
    await page.waitForFunction(() => !document.querySelector('#growthDaySummary').textContent.includes('正在读取'));
    assert.deepEqual(await snapshot(page), outside);
    assert.equal(requests.at(-1).searchParams.has('exclude_large_expenses'), false);
    await page.uncheck('#excludeLargeExpenses');
    assert.equal(await page.locator('.growth-line').getAttribute('d'), originalPath);
    page.off('request', track);

    // A late response from a rapid on/off sequence must not reapply the filter.
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    await page.route('**/api/dashboard?**', async route => {
      if (route.request().url().includes('exclude_large_expenses=true')) await gate;
      await route.continue();
    });
    const pending = page.waitForRequest(request => request.url().includes('exclude_large_expenses=true'));
    await page.check('#excludeLargeExpenses');
    await pending;
    await page.uncheck('#excludeLargeExpenses');
    const finished = page.waitForResponse(response => response.url().includes('exclude_large_expenses=true'));
    release();
    await (await finished).finished();
    await page.waitForFunction(() => state.growthContext.chartDetail === state.growthContext.detail);
    assert.equal(await page.isChecked('#excludeLargeExpenses'), false);
    assert.equal(await page.locator('.growth-line').getAttribute('d'), originalPath);
    await page.unroute('**/api/dashboard?**');

    // The checked preference follows months, while week/day requests stay complete.
    await page.check('#excludeLargeExpenses');
    await page.waitForFunction(() => state.growthContext.chartDetail !== state.growthContext.detail);
    const nextMonth = await page.evaluate(month => {
      const periods = monthlySchoolIncomePeriods(state.dashboard.trend, state.dashboard.school_income_daily);
      return periods[periods.findIndex(row => row.period === month) + 1].period;
    }, month);
    await (await showTrendPeriod(page, nextMonth)).press('Enter');
    await waitForDetail(page);
    await page.waitForFunction(month => state.growthContext.period.period === month && state.growthContext.chartDetail !== state.growthContext.detail, nextMonth);
    assert.equal(await page.isChecked('#excludeLargeExpenses'), true);
    await page.locator('#dailyGrowthPanel').screenshot({ path: `tests/dashboard-expense-filter-${width}.png` });
    for (const granularity of ['week', 'day']) {
      await page.selectOption('#granularity', granularity);
      await page.waitForFunction(unit => state.dashboard.granularity === unit, granularity);
      await page.locator('.trend-period').first().press('Enter');
      await waitForDetail(page);
      assert.equal(await page.locator('#excludeLargeExpenses').isVisible(), false);
      assert.equal(await page.evaluate(() => Boolean(state.filterContext.excludeLargeExpenses || state.recentContext.excludeLargeExpenses)), false);
      if (granularity === 'week') assert.equal(await page.evaluate(() => state.growthContext.chartDetail === state.growthContext.detail), true);
    }
    await page.selectOption('#granularity', 'month');
    await page.waitForFunction(() => state.dashboard.granularity === 'month');
    await page.selectOption('#platformFilter', '微信');
    await page.fill('#startDate', '2026-09-01');
    await page.fill('#endDate', '2026-09-30');
    await page.click('#applyFilters');
    await page.waitForFunction(() => state.filterContext.start === '2026-09-01' && state.filterContext.platform === '微信');
    await page.locator('.trend-period').first().press('Enter');
    await waitForDetail(page);
    await page.waitForFunction(() => state.growthContext.chartDetail !== state.growthContext.detail);
    assert.equal(await page.evaluate(() => Boolean(state.filterContext.excludeLargeExpenses)), false);
    assert.ok(await page.evaluate(() => state.growthContext.chartDetail.summary.expense_count <= state.growthContext.detail.summary.expense_count));
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ width, originalExpenses: originalSummary.expense_count, chartExpenses: filtered.summary.expense_count, result: 'only monthly curve changes; complete statistics, drill-down and weekly view preserved; stale responses ignored' }));
    await page.close();
  }
} finally {
  await browser.close();
}
