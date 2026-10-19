import assert from 'node:assert/strict';
import { chromium } from 'file:///C:/Users/Niewei/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';

const base = process.env.BILL_ANALYZER_URL || 'http://127.0.0.1:8765';
const browser = await chromium.launch({ headless: true, executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' });
const keys = page => page.locator('#monthlyChart .trend-period').evaluateAll(groups => groups.map(group => group.dataset.period));
const axis = page => page.locator('#monthlyChart').evaluate(svg => [Number(svg.dataset.axisMin), Number(svg.dataset.axisMax)]);

async function checkLayout(page) {
  const issues = await page.evaluate(() => {
    const svg = document.querySelector('#monthlyChart');
    const container = svg.parentElement;
    const errors = [];
    if (container.scrollWidth > container.clientWidth + 1) errors.push('chart scrolls horizontally');
    if (document.documentElement.scrollWidth > innerWidth + 1) errors.push('page scrolls horizontally');
    const low = Number(svg.dataset.axisMin), high = Number(svg.dataset.axisMax);
    const groups = [...svg.querySelectorAll('.trend-period')];
    if (groups.length > 7) errors.push('more than seven periods');
    for (const group of groups) {
      let positive = 0, negative = 0;
      for (const rect of group.querySelectorAll('rect[data-amount]')) {
        const amount = Number(rect.dataset.amount);
        if (amount >= 0) positive += amount; else negative += amount;
        const y = Number(rect.getAttribute('y')), height = Number(rect.getAttribute('height'));
        if (!Number.isFinite(y + height) || height < 0 || y < 27.99 || y + height > 282.01) errors.push('bar outside plot');
      }
      if (low > negative + .001 || high < positive - .001) errors.push('axis clips data');
      const net = group.querySelector('.trend-net-label').getBBox();
      const income = group.querySelector('.trend-income-label');
      if (net.y < 0) errors.push('label clipped');
      if (income && income.getBBox().y < net.y + net.height) errors.push('labels overlap');
    }
    return errors;
  });
  assert.deepEqual(issues, []);
}

try {
  for (const width of [1280, 390, 320]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(base, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => state.dashboard !== null);
    for (const granularity of ['month', 'week', 'day']) {
      await page.evaluate(() => { window.previousPagingDashboard = state.dashboard; });
      await page.selectOption('#granularity', granularity);
      await page.waitForFunction(unit => state.dashboard !== window.previousPagingDashboard && state.dashboard.granularity === unit, granularity);
      const all = await page.evaluate(() => (state.dashboard.granularity === 'month'
        ? monthlySchoolIncomePeriods(state.dashboard.trend, state.dashboard.school_income_daily)
        : state.dashboard.trend).map(row => row.period));
      assert.deepEqual(await keys(page), all.slice(-7));
      assert.equal(await page.locator('#trendNext').isDisabled(), true);
      const traversed = [];
      while (true) {
        await checkLayout(page);
        const visible = await keys(page);
        traversed.unshift(...visible);
        if (await page.locator('#trendPrev').isDisabled()) break;
        await page.click('#trendPrev');
      }
      assert.deepEqual(traversed, all, `${granularity}: every period appears exactly once`);
      while (await page.locator('#trendNext').isEnabled()) await page.click('#trendNext');
      assert.deepEqual(await keys(page), all.slice(-7));
      await page.locator('#monthlyChart .trend-period').first().press('Enter');
      await page.waitForFunction(() => !document.querySelector('#trendDetail').hidden && document.querySelector('#trendDetailTitle').textContent !== '正在读取…');
      const comparison = await page.evaluate(() => {
        const rows = state.trendData.granularity === 'month'
          ? monthlySchoolIncomePeriods(state.dashboard.trend, state.dashboard.school_income_daily) : state.dashboard.trend;
        const current = rows.length - Math.min(7, rows.length);
        const previous = rows[current - 1];
        if (!previous) return '暂无对比';
        const delta = rows[current].total - previous.total;
        const direction = delta > 0 ? '增加' : delta < 0 ? '减少' : '持平';
        return previous.total ? `${direction} ${(Math.abs(delta / previous.total) * 100).toFixed(1)}%` : `${direction} ${money.format(Math.abs(delta))}`;
      });
      assert.equal(await page.locator('#detailComparison').textContent(), comparison);
      if (await page.locator('#trendPrev').isEnabled()) {
        await page.click('#trendPrev');
        assert.equal(await page.locator('#trendDetail').isHidden(), true);
        assert.equal(await page.locator('.trend-period.selected').count(), 0);
        await page.click('#applyFilters');
        await page.waitForFunction(() => state.trendPage === 0);
        assert.deepEqual(await keys(page), all.slice(-7));
      }
      await page.locator('#monthlyChart').screenshot({ path: `tests/dashboard-trend-paging-${granularity}-${width}.png` });
    }

    // A large historical outlier must affect only the page that contains it.
    await page.evaluate(() => {
      const trend = Array.from({ length: 17 }, (_, i) => {
        const period = new Date(Date.UTC(2025, i, 1)).toISOString().slice(0, 7);
        const expense = i === 0 ? 100000 : 700 + i * 10;
        return { period, total: expense - 50, categories: { 支出: expense, 抵扣: -50 } };
      });
      state.trendPage = 0;
      renderTrend({ granularity: 'month', trend, trend_categories: ['支出', '抵扣'], school_income_daily: [
        { day: '2025-01-02', amount: 50000 }, { day: '2026-06-01', amount: 4500 },
      ] });
    });
    const latestAxis = await axis(page);
    assert.ok(latestAxis[0] <= -4500 && latestAxis[1] < 100000);
    assert.equal((await keys(page)).at(-1), '2026-06');
    assert.equal(await page.locator('.trend-income-label').last().evaluate(el => el.firstChild.textContent), '（4.5k）');
    await checkLayout(page);
    await page.click('#trendPrev');
    await page.click('#trendPrev');
    const earliestAxis = await axis(page);
    assert.ok(earliestAxis[0] <= -50050 && earliestAxis[1] >= 100000);
    await checkLayout(page);
    await page.click('#trendNext');
    await page.click('#trendNext');
    assert.deepEqual(await axis(page), latestAxis);

    await page.evaluate(() => {
      state.trendPage = 99;
      renderTrend({ granularity: 'day', trend: [{ period: '2026-01-01', total: 0, categories: {} }], trend_categories: [] });
    });
    assert.equal(await page.locator('#trendPrev').isDisabled(), true);
    assert.equal(await page.locator('#trendNext').isDisabled(), true);
    await checkLayout(page);
    await page.evaluate(() => renderTrend({ granularity: 'day', trend: [], trend_categories: [] }));
    assert.equal(await page.locator('.trend-period').count(), 0);
    assert.equal(await page.locator('#trendPageInfo').textContent(), '暂无数据');
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ width, verified: 'all granularities, complete paging, detail comparison, filter reset, responsive layout, page-specific positive/negative axes, income-only month, zero and empty data' }));
    await page.close();
  }
} finally {
  await browser.close();
}
