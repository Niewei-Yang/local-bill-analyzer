import assert from 'node:assert/strict';

export async function showTrendPeriod(page, period) {
  const target = page.locator(`#monthlyChart .trend-period[data-period="${period}"]`);
  while (await target.count() === 0) {
    const first = await page.locator('#monthlyChart .trend-period').first().getAttribute('data-period');
    const button = page.locator(period < first ? '#trendPrev' : '#trendNext');
    assert.equal(await button.isEnabled(), true, `Period ${period} missing from chart pages`);
    await button.click();
  }
  return target;
}
