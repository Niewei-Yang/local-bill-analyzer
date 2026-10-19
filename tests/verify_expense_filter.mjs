import assert from 'node:assert/strict';
import { chromium } from 'file:///C:/Users/Niewei/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';

const base = process.env.BILL_ANALYZER_URL || 'http://127.0.0.1:8765';
async function verifyTrend(page) {
  const issues = await page.evaluate(() => {
    const errors = [];
    const zero = Number(document.querySelector('#monthlyChart .chart-axis').getAttribute('y1'));
    document.querySelectorAll('#monthlyChart .trend-period').forEach((group, index) => {
      const period = state.dashboard.trend[index];
      const bars = [...group.querySelectorAll('rect[data-category]')];
      const categories = bars.map(bar => bar.dataset.category);
      if (new Set(categories).size !== categories.length) errors.push(`${period.period}: duplicate category`);
      const totalCents = bars.reduce((sum, bar) => sum + Math.round(Number(bar.dataset.amount) * 100), 0);
      if (totalCents !== Math.round(period.total * 100)) errors.push(`${period.period}: bar sum differs from net`);
      const label = group.querySelector('.trend-net-label');
      if (label && Number(label.dataset.total) !== period.total) errors.push(`${period.period}: wrong net label`);
      bars.forEach(bar => {
        const y = Number(bar.getAttribute('y'));
        const height = Number(bar.getAttribute('height'));
        const amount = Number(bar.dataset.amount);
        if (y < 27.99 || y + height > 282.01 || height < 0) errors.push(`${period.period}: bar outside plot`);
        if (amount < 0 && y < zero - 0.01) errors.push(`${period.period}: deduction above zero`);
        if (amount > 0 && y + height > zero + 0.01) errors.push(`${period.period}: expense below zero`);
      });
    });
    return errors;
  });
  assert.deepEqual(issues, []);
}
const browser = await chromium.launch({ headless: true, executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' });
try {
  for (const width of [1280, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(base, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => state.dashboard !== null);
    const original = await page.evaluate(() => state.dashboard.summary);
    const originalTrend = await page.evaluate(() => state.dashboard.trend);
    await verifyTrend(page);
    const filteredResponse = page.waitForResponse(response => response.url().includes('/api/dashboard?') && response.url().includes('exclude_large_expenses=true'));
    await page.check('#excludeLargeExpenses');
    const filtered = await (await filteredResponse).json();
    await page.waitForFunction(() => state.filterContext?.excludeLargeExpenses === true);
    assert.ok(filtered.summary.expense_count <= original.expense_count);
    assert.equal(filtered.summary.income, original.income);
    assert.equal(filtered.summary.refunds, original.refunds);
    assert.equal(filtered.summary.transfer_income, original.transfer_income);
    assert.ok((await page.textContent('#periodText')).includes('已排除单笔'));
    assert.ok(filtered.recent.every(item => item.direction !== 'expense' || item.amount < 1000));
    const before = new Map(originalTrend.map(item => [item.period, item.total]));
    assert.ok(filtered.trend.every(item => item.total <= (before.get(item.period) ?? 0) + 0.005));
    assert.equal(new Set(filtered.trend_categories).size, filtered.trend_categories.length);
    await verifyTrend(page);
    await page.locator('#monthlyChart').screenshot({ path: `tests/dashboard-net-trend-${width}.png` });

    if (await page.locator('#recentNext').isVisible()) {
      await page.click('#recentNext');
      await page.waitForFunction(() => state.recentPage === 2);
      assert.equal(await page.evaluate(() => state.recentContext.excludeLargeExpenses), true);
      assert.ok(await page.locator('#recentTable tr').count() > 0);
    }

    // Detail, cumulative curve, daily drill-down, and highest single expense.
    for (const granularity of ['month', 'week', 'day']) {
      await page.evaluate(() => { window.previousDashboard = state.dashboard; });
      await page.selectOption('#granularity', granularity);
      await page.waitForFunction(value => state.dashboard !== window.previousDashboard && state.dashboard.granularity === value, granularity);
      await verifyTrend(page);
      const period = page.locator('#monthlyChart .trend-period').first();
      if (!await period.count()) continue;
      const requests = [];
      const track = request => {
        if (/\/api\/(dashboard|transactions)\?/.test(request.url())) requests.push(new URL(request.url()));
      };
      page.on('request', track);
      await period.press('Enter');
      await page.waitForFunction(() => !document.querySelector('#trendDetail').hidden && document.querySelector('#trendDetailTitle').textContent !== '正在读取…');
      assert.equal(await page.evaluate(() => state.recentContext.excludeLargeExpenses), true);
      if (granularity !== 'day') {
        await page.locator('.growth-point').first().press('Enter');
        await page.waitForFunction(() => !document.querySelector('#growthDayDetail').hidden && !document.querySelector('#growthDaySummary').textContent.includes('正在读取'));
        const day = (await page.textContent('#growthDayTitle')).slice(0, 10);
        const data = await (await page.request.get(`${base}/api/transactions?start=${day}&end=${day}&exclude_large_expenses=true&size=200`)).json();
        const relevant = data.items.filter(item => item.direction === 'expense' || item.is_refund || (item.platform === '微信' && item.direction === 'income' && ['转账', '二维码收款'].includes(item.category_raw)));
        assert.equal(await page.locator('#growthDayTable tr').count(), relevant.length);
      } else {
        assert.equal(await page.textContent('#topSpendTitle'), '最高支出单笔');
        const values = await page.locator('#topDays strong').allTextContents();
        assert.ok(values.every(value => Number(value.replace(/[^\d.]/g, '')) < 1000));
      }
      assert.ok(requests.length >= 2);
      assert.ok(requests.every(url => url.searchParams.get('exclude_large_expenses') === 'true'));
      page.off('request', track);
      await page.click('#closeTrendDetail');
    }

    await page.selectOption('#platformFilter', '微信');
    await page.fill('#startDate', '2026-09-01');
    await page.fill('#endDate', '2026-09-30');
    await page.click('#applyFilters');
    await page.waitForFunction(() => state.filterContext.start === '2026-09-01' && state.filterContext.platform === '微信');
    assert.equal(await page.evaluate(() => state.filterContext.excludeLargeExpenses), true);
    assert.ok(await page.evaluate(() => state.dashboard.recent.every(item => item.platform === '微信' && item.transaction_time.startsWith('2026-09') && (item.direction !== 'expense' || item.amount < 1000))));
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
    await page.screenshot({ path: `tests/dashboard-expense-filter-${width}.png` });

    await page.click('#clearFilters');
    await page.waitForFunction(() => !state.filterContext.excludeLargeExpenses && !state.filterContext.start && !state.filterContext.platform && state.dashboard.granularity === 'month');
    assert.equal(await page.isChecked('#excludeLargeExpenses'), false);
    assert.equal(await page.evaluate(() => state.dashboard.summary.expense_count), original.expense_count);
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ width, originalExpenses: original.expense_count, filteredExpenses: filtered.summary.expense_count, result: 'passed' }));
    await page.close();
  }
} finally {
  await browser.close();
}
