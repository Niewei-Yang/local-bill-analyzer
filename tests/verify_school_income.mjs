import assert from 'node:assert/strict';
import { chromium } from 'file:///C:/Users/Niewei/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';

const base = process.env.BILL_ANALYZER_URL || 'http://127.0.0.1:8765';
async function verifyMonthlyIncome(page) {
  const issues = await page.evaluate(() => {
    const errors = [];
    const expected = new Map();
    state.dashboard.school_income_daily.forEach(row => {
      const month = row.day.slice(0, 7);
      expected.set(month, (expected.get(month) || 0) + Math.round(row.amount * 100));
    });
    const zero = Number(document.querySelector('#monthlyChart .chart-axis').getAttribute('y1'));
    document.querySelectorAll('#monthlyChart .trend-period').forEach(group => {
      const month = group.dataset.period;
      const bar = group.querySelector('[data-series="school-income"]');
      const income = expected.get(month) || 0;
      if (income > 0) {
        if (!bar || Math.round(Number(bar.dataset.amount) * 100) !== -income) errors.push(`${month}: wrong income`);
        if (bar) {
          const y = Number(bar.getAttribute('y'));
          const height = Number(bar.getAttribute('height'));
          if (y < zero - 0.01 || height <= 0 || y + height > 282.01) errors.push(`${month}: income outside negative plot`);
          const deductions = [...group.querySelectorAll('rect[data-category]')].filter(rect => Number(rect.dataset.amount) < 0);
          if (deductions.some(rect => Number(rect.getAttribute('y')) + Number(rect.getAttribute('height')) > y + 0.01)) errors.push(`${month}: overlapping deductions`);
        }
      } else if (bar) errors.push(`${month}: unexpected income bar`);
      const total = state.dashboard.trend.find(row => row.period === month)?.total || 0;
      if (Number(group.querySelector('.trend-net-label').dataset.total) !== total) errors.push(`${month}: net spend changed`);
      expected.delete(month);
    });
    if ([...expected.values()].some(value => value > 0)) errors.push('income-only month missing');
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
    await page.waitForFunction(() => state.dashboard?.school_income_daily);
    await verifyMonthlyIncome(page);
    assert.ok((await page.locator('#monthlyLegend').textContent()).includes('校内税后收入（负值）'));
    await page.locator('#monthlyChart').screenshot({ path: `tests/dashboard-school-income-bars-${width}.png` });
    const month = await page.evaluate(() => {
      const amounts = new Map();
      for (const row of state.dashboard.school_income_daily) {
        const month = row.day.slice(0, 7);
        amounts.set(month, (amounts.get(month) || 0) + row.amount);
      }
      return state.dashboard.trend.reduce((best, row) =>
        (amounts.get(row.period) || 0) > (amounts.get(best) || 0) ? row.period : best,
        state.dashboard.trend[0].period);
    });
    const group = page.locator('#monthlyChart .trend-period').filter({ hasText: month });
    await group.focus();
    await group.press('Enter');
    await page.waitForSelector('.growth-school-income-point');
    assert.equal(await page.locator('.growth-school-income').count(), 1);
    const verification = await page.evaluate(() => {
      const { detail, bounds } = state.growthContext;
      const points = [...document.querySelectorAll('.growth-school-income-point')];
      let cents = 0;
      const problems = [];
      for (const dot of points) {
        const daily = detail.school_income_daily.filter(row => row.day === dot.dataset.day)
          .reduce((sum, row) => sum + Math.round(row.amount * 100), 0);
        if (daily <= 0) problems.push('marker without income');
        cents += daily;
        if (Math.round(Number(dot.dataset.total) * 100) !== cents) problems.push(dot.dataset.day);
        if (Number(dot.getAttribute('cy')) < 36 || Number(dot.getAttribute('cy')) > 262) problems.push('outside plot');
      }
      const expectedDays = detail.school_income_daily.filter(row => row.amount > 0 && row.day >= bounds.start && row.day <= bounds.end).map(row => row.day);
      if (JSON.stringify(points.map(dot => dot.dataset.day)) !== JSON.stringify(expectedDays)) problems.push('income dates differ');
      const lineDays = document.querySelector('.growth-school-income').getAttribute('d').match(/[ML]/g)?.length || 0;
      if (lineDays !== document.querySelectorAll('.growth-point').length) problems.push('income line lost days');
      return { problems, total: cents / 100, days: points.length, bounds,
        net: detail.summary.net_spend,
        netLine: cumulativeDailyPoints(detail.trend, bounds).at(-1).total };
    });
    assert.deepEqual(verification.problems, []);
    assert.ok(verification.total > 0);
    assert.equal(verification.net, verification.netLine);
    const incomePoint = page.locator('.growth-school-income-point').last();
    await incomePoint.focus();
    assert.ok((await page.locator('#dailyGrowthPoint').textContent()).includes('累计校内税后收入'));
    const expectedTotal = await incomePoint.getAttribute('data-total');
    await page.fill('#monthlyBudget', '6000');
    assert.equal(await incomePoint.getAttribute('data-total'), expectedTotal);
    await page.fill('#monthlyBudget', '4500');
    await page.locator('.growth-point').first().click();
    await page.waitForFunction(() => !document.querySelector('#growthDaySummary').textContent.includes('正在读取'));
    assert.equal(await page.locator('#growthDayDetail').isVisible(), true);
    await page.locator('#dailyGrowthPanel').screenshot({ path: `tests/dashboard-school-income-${width}.png` });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
    console.log(JSON.stringify({ width, month, ...verification }));

    await page.click('#closeTrendDetail');
    await page.locator('#monthlyChart .trend-period').last().press('Enter');
    await page.waitForSelector('.growth-point');
    const latestMonth = await page.evaluate(() => {
      const { period, bounds, detail } = state.growthContext;
      const [year, month] = period.period.split('-').map(Number);
      const monthDays = new Date(Date.UTC(year, month, 0)).getUTCDate();
      const startDay = Number(bounds.start.slice(-2));
      const actualDays = Number(bounds.end.slice(-2)) - startDay + 1;
      const displayDays = monthDays - startDay + 1;
      const pathDays = selector => document.querySelector(selector).getAttribute('d').match(/[ML]/g)?.length || 0;
      const dots = [...document.querySelectorAll('.growth-point')];
      return { period: period.period, bounds, actualDays, displayDays,
        planDays: pathDays('.growth-plan'), expenseDays: pathDays('.growth-line'), incomeDays: pathDays('.growth-school-income'),
        lastActualDay: dots.at(-1).dataset.day, lastActualX: Number(dots.at(-1).getAttribute('cx')),
        expectedActualX: 65 + (actualDays - 1) / Math.max(1, displayDays - 1) * 811,
        monthEndLabel: `${String(month).padStart(2, '0')}-${monthDays}`,
        labels: [...document.querySelectorAll('#dailyGrowthChart text')].map(node => node.textContent),
        shownNet: cumulativeDailyPoints(detail.trend, bounds).at(-1).total,
        net: detail.summary.net_spend,
        budgetEndX: Number(document.querySelector('.growth-budget').getAttribute('x2')) };
    });
    assert.equal(latestMonth.planDays, latestMonth.displayDays);
    assert.equal(latestMonth.expenseDays, latestMonth.actualDays);
    assert.equal(latestMonth.incomeDays, latestMonth.actualDays);
    assert.equal(latestMonth.lastActualDay, latestMonth.bounds.end);
    assert.ok(Math.abs(latestMonth.lastActualX - latestMonth.expectedActualX) < 0.001);
    assert.ok(latestMonth.labels.includes(latestMonth.monthEndLabel));
    assert.equal(latestMonth.net, latestMonth.shownNet);
    assert.equal(latestMonth.budgetEndX, 876);
    await page.locator('#dailyGrowthPanel').screenshot({ path: `tests/dashboard-month-end-${width}.png` });
    console.log(JSON.stringify({ width, latestMonth }));

    await page.selectOption('#granularity', 'week');
    await page.waitForFunction(() => state.dashboard?.granularity === 'week');
    await page.locator('#monthlyChart .trend-period').first().press('Enter');
    await page.waitForFunction(() => !document.querySelector('#dailyGrowthPanel').hidden && state.growthContext?.dashboard.granularity === 'week');
    const incomeDays = await page.evaluate(() => state.growthContext.detail.school_income_daily.filter(row => row.amount > 0).length);
    assert.equal(await page.locator('.growth-school-income-point').count(), incomeDays);
    await page.selectOption('#platformFilter', '微信');
    await page.click('#applyFilters');
    await page.waitForFunction(() => state.filterContext?.platform === '微信' && state.dashboard?.school_income_daily?.length === 0);
    await page.locator('#monthlyChart .trend-period').first().press('Enter');
    await page.waitForSelector('.growth-point');
    assert.equal(await page.locator('.growth-school-income-point').count(), 0);
    assert.equal(await page.locator('.growth-school-income').count(), 1);
    await page.selectOption('#granularity', 'month');
    await page.waitForFunction(() => state.dashboard?.granularity === 'month');
    assert.equal(await page.locator('#monthlyChart [data-series="school-income"]').count(), 0);
    await page.selectOption('#platformFilter', '校内收入');
    await page.click('#applyFilters');
    await page.waitForFunction(() => state.filterContext?.platform === '校内收入' && state.dashboard.school_income_daily.length > 0);
    await verifyMonthlyIncome(page);
    assert.equal(await page.locator('#monthlyChart rect[data-category]').count(), 0);
    assert.ok(await page.locator('#monthlyChart [data-series="school-income"]').count() > 0);
    await page.locator('#monthlyChart .trend-period').first().press('Enter');
    await page.waitForSelector('.growth-school-income-point');
    assert.ok((await page.locator('#dailyGrowthMeta').textContent()).includes('校内税后收入累计'));
    assert.deepEqual(errors, []);
    await page.close();
  }
} finally {
  await browser.close();
}
