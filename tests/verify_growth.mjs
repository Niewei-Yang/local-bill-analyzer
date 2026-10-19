import assert from 'node:assert/strict';
import { chromium } from 'file:///C:/Users/Niewei/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';

const browser = await chromium.launch({ headless: true, executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' });
try {
  for (const width of [1280, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('http://127.0.0.1:8765', { waitUntil: 'networkidle' });
    for (const granularity of ['month', 'week', 'day']) {
      await page.evaluate(() => { window.previousGrowthDashboard = state.dashboard; });
      await page.selectOption('#granularity', granularity);
      await page.waitForFunction(value => state.dashboard !== window.previousGrowthDashboard && state.dashboard?.granularity === value, granularity);
      const period = page.locator('#monthlyChart .trend-period').nth(1);
      await period.focus();
      await period.press('Enter');
      await page.waitForFunction(() => document.querySelector('#trendDetailTitle').textContent !== '正在读取…' && !document.querySelector('#trendDetail').hidden);
      if (granularity === 'day') {
        assert.equal(await page.locator('#dailyGrowthPanel').isVisible(), false);
      } else {
        assert.equal(await page.locator('#dailyGrowthPanel').isVisible(), true);
        assert.equal(await page.locator('.growth-budget').count(), 1);
        assert.equal(await page.locator('.growth-plan').count(), 1);
        const dots = page.locator('.growth-point');
        assert.ok(await dots.count() > 1);
        const meta = await page.locator('#dailyGrowthMeta').textContent();
        if (granularity === 'month') assert.ok(meta.includes('4,500.00'));
        await dots.first().focus();
        assert.ok((await page.locator('#dailyGrowthPoint').textContent()).includes('当日消费'));
        const expectedHint = await page.evaluate(() => {
          const { chartDetail, bounds } = state.growthContext;
          const point = cumulativeDailyPoints(chartDetail.trend, bounds)[0];
          const delta = Math.round((point.daily - dailyBudget(point.day)) * 100) / 100;
          return `当日消费 ${point.daily.toFixed(2)} 元，${delta > 0 ? '超出计划' : delta < 0 ? '小于计划' : '与计划持平'} ${Math.abs(delta).toFixed(2)} 元`;
        });
        assert.equal(await page.locator('#dailyGrowthPoint').textContent(), expectedHint);
        assert.equal(await dots.first().locator('title').textContent(), expectedHint);
        assert.ok(!(await dots.first().getAttribute('aria-label')).includes('累计'));
        await dots.first().click();
        await page.waitForFunction(() => !document.querySelector('#growthDaySummary').textContent.includes('正在读取'));
        assert.equal(await page.locator('#growthDayDetail').isVisible(), true);
        assert.equal(await dots.first().getAttribute('aria-pressed'), 'true');
        const day = (await page.locator('#growthDayTitle').textContent()).slice(0, 10);
        const response = await page.request.get(`http://127.0.0.1:8765/api/transactions?start=${day}&end=${day}&size=200`);
        const daily = await response.json();
        assert.equal(await page.locator('#growthDayTable tr').count(), daily.items.filter(item => item.direction === 'expense' || item.is_refund || (item.platform === '微信' && item.direction === 'income' && ['转账', '二维码收款'].includes(item.category_raw))).length);
        assert.ok(!(await page.locator('#growthDaySummary').textContent()).includes('读取失败'));
        const oldRows = await page.locator('#growthDayTable').textContent();
        const oldPlan = await page.locator('.growth-plan').getAttribute('d');
        await page.fill('#monthlyBudget', '6000');
        assert.notEqual(await page.locator('.growth-plan').getAttribute('d'), oldPlan);
        assert.equal(await page.locator('#growthDayTable').textContent(), oldRows);
        assert.equal(await page.locator('.growth-point.selected').count(), 1);
        const newBudget = await page.evaluate(() => periodBudget(state.growthContext.period.period, state.growthContext.dashboard.granularity));
        assert.ok((await page.locator('.growth-budget-label').textContent()).includes(new Intl.NumberFormat('zh-CN', { style: 'currency', currency: 'CNY' }).format(newBudget)));
        await page.fill('#monthlyBudget', '4500');
        await page.locator('#dailyGrowthPanel').screenshot({ path: `tests/dashboard-growth-${granularity}-${width}.png` });
        console.log(JSON.stringify({ width, granularity, points: await dots.count(), meta }));
      }
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
      await page.click('#closeTrendDetail');
      assert.equal(await page.locator('#trendDetail').isVisible(), false);
    }
    await page.fill('#monthlyBudget', '6000.25');
    await page.reload({ waitUntil: 'networkidle' });
    assert.equal(await page.inputValue('#monthlyBudget'), '6000.25');
    const first = page.locator('#monthlyChart .trend-period').first();
    await first.focus();
    await first.press('Enter');
    await page.waitForSelector('.growth-budget-label');
    assert.ok((await page.locator('.growth-budget-label').textContent()).includes('6,000.25'));
    for (const invalid of ['', '-1', '1.001']) {
      await page.fill('#monthlyBudget', invalid);
      assert.equal(await page.evaluate(() => state.monthlyBudget), 6000.25);
    }
    await page.fill('#monthlyBudget', '0');
    assert.ok((await page.locator('.growth-budget-label').textContent()).includes('0.00'));
    assert.equal(await page.evaluate(() => /NaN|Infinity/.test(document.querySelector('#dailyGrowthChart').innerHTML)), false);
    await page.screenshot({ path: `tests/dashboard-budget-${width}.png`, fullPage: true });
    await page.reload({ waitUntil: 'networkidle' });
    assert.equal(await page.inputValue('#monthlyBudget'), '0');
    assert.deepEqual(errors, []);
    await page.close();
  }
} finally {
  await browser.close();
}
