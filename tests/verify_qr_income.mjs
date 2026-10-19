import assert from 'node:assert/strict';
import { showTrendPeriod } from './trend_helpers.mjs';
import { chromium } from 'file:///C:/Users/Niewei/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';

const base = process.env.BILL_ANALYZER_URL || 'http://127.0.0.1:8765';
const browser = await chromium.launch({ headless: true, executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' });
try {
  for (const width of [1280, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(base, { waitUntil: 'networkidle' });
    const dayResult = await (await page.request.get(`${base}/api/dashboard?start=2026-01-28&end=2026-01-28&granularity=day`)).json();
    assert.equal(dayResult.summary.qr_income, 2994);
    assert.equal(dayResult.summary.transfer_income, 38);
    assert.equal(dayResult.summary.wechat_income, 3032);
    assert.equal(dayResult.summary.net_spend, 81.8);
    assert.equal(dayResult.trend[0].total, 81.8);
    const filtered = await (await page.request.get(`${base}/api/dashboard?start=2026-01-28&end=2026-01-28&exclude_large_expenses=true`)).json();
    assert.equal(filtered.summary.qr_income, 2994);
    assert.equal(filtered.summary.wechat_income, 3032);

    await (await showTrendPeriod(page, '2026-01')).press('Enter');
    const dot = page.locator('.growth-point[data-day="2026-01-28"]');
    await dot.waitFor();
    await dot.press('Enter');
    await page.waitForFunction(() => !document.querySelector('#growthDaySummary').textContent.includes('正在读取'));
    const receipt = page.locator('#growthDayTable tr').filter({ hasText: '微信二维码收款' });
    assert.equal(await receipt.count(), 1);
    assert.ok((await receipt.textContent()).includes('−¥2,994.00'));
    assert.ok((await page.locator('#growthDaySummary').textContent()).includes('当日净支出 ¥81.80'));
    assert.ok((await dot.getAttribute('aria-label')).includes('当日净支出 ¥81.80'));
    await dot.focus();
    assert.ok((await page.locator('#dailyGrowthPoint').textContent()).includes('¥81.80'));
    const curve = await page.evaluate(() => {
      const { detail, bounds } = state.growthContext;
      const points = cumulativeDailyPoints(detail.trend, bounds);
      const index = points.findIndex(point => point.day === '2026-01-28');
      return { delta: Math.round((points[index].total - points[index - 1].total) * 100) / 100,
        final: points.at(-1).total, net: detail.summary.net_spend };
    });
    assert.equal(curve.delta, 81.8);
    assert.equal(curve.final, curve.net);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
    await page.locator('#dailyGrowthPanel').screenshot({ path: `tests/dashboard-qr-income-${width}.png` });
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ width, qrIncome: dayResult.summary.qr_income, dailyNet: curve.delta }));
    await page.close();
  }
} finally {
  await browser.close();
}
