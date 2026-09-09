import { chromium } from 'file:///C:/Users/Niewei/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';

const browser = await chromium.launch({
  headless: true,
  executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
});

for (const width of [1280, 390]) {
  const page = await browser.newPage({ viewport: { width, height: 900 }, colorScheme: 'light' });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto('http://127.0.0.1:8765', { waitUntil: 'networkidle' });
  await page.waitForSelector('#monthlyChart rect');
  const monthAxisTop = await page.locator('#monthlyChart .chart-muted').last().textContent();
  const basePagerVisible = await page.locator('#recentPager').isVisible();
  if (basePagerVisible) {
    await Promise.all([
      page.waitForResponse(response => response.url().includes('/api/transactions') && response.url().includes('page=2')),
      page.click('#recentNext'),
    ]);
    await page.waitForFunction(() => document.querySelector('#recentPageInfo').textContent.includes('第 2 /'));
  }
  await Promise.all([
    page.waitForResponse(response => response.url().includes('/api/dashboard') && response.url().includes('granularity=week')),
    page.selectOption('#granularity', 'week'),
  ]);
  await page.waitForFunction(() => document.querySelector('#trendTitle').textContent === '每周支出与构成');
  await page.locator('#monthlyChart .trend-period').nth(1).click();
  await page.waitForFunction(() => !document.querySelector('#trendDetail').hidden && document.querySelector('#trendDetailTitle').textContent !== '正在读取…');
  const weekDetail = await page.evaluate(() => ({
    title: document.querySelector('#trendDetailTitle').textContent,
    meta: document.querySelector('#trendDetailMeta').textContent,
    categoryHint: document.querySelector('#categoryHint').textContent,
    recentHint: document.querySelector('#recentHint').textContent,
    categories: document.querySelectorAll('#categoryBars .category-row').length,
  }));
  await page.locator('#monthlyChart .trend-period.selected').click();
  await page.waitForFunction(() => document.querySelector('#trendDetail').hidden);
  const selectionCancelled = await page.evaluate(() => !document.querySelector('.trend-period.selected') && document.querySelector('#categoryHint').textContent === '净支出金额与占比');
  await Promise.all([
    page.waitForResponse(response => response.url().includes('/api/dashboard') && response.url().includes('granularity=day')),
    page.selectOption('#granularity', 'day'),
  ]);
  await page.waitForFunction(() => document.querySelector('#trendTitle').textContent === '每日支出与构成');
  const dayAxisTop = await page.locator('#monthlyChart .chart-muted').last().textContent();
  await page.locator('#monthlyChart .trend-period').first().click();
  await page.waitForFunction(() => !document.querySelector('#trendDetail').hidden && document.querySelector('#trendDetailTitle').textContent !== '正在读取…');
  const checks = await page.evaluate(() => ({
    title: document.title,
    netSpend: document.querySelector('#netSpend').textContent,
    monthlyMarks: document.querySelectorAll('#monthlyChart rect').length,
    trendTitle: document.querySelector('#trendTitle').textContent,
    granularityOptions: document.querySelectorAll('#granularity option').length,
    detailVisible: !document.querySelector('#trendDetail').hidden,
    detailTitle: document.querySelector('#trendDetailTitle').textContent,
    topSpendTitle: document.querySelector('#topSpendTitle').textContent,
    selectedPagerVisible: !document.querySelector('#recentPager').hidden,
    categoryRows: document.querySelectorAll('#categoryBars .category-row').length,
    heatCells: document.querySelectorAll('#heatmap .heat-cell').length,
    merchantRows: document.querySelectorAll('#merchantTable tr').length,
    recentRows: document.querySelectorAll('#recentTable tr').length,
    horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
  }));
  checks.adaptiveAxis = { month: monthAxisTop, day: dayAxisTop, changed: monthAxisTop !== dayAxisTop };
  checks.basePagerVisible = basePagerVisible;
  checks.selectionCancelled = selectionCancelled;
  checks.weekDetail = weekDetail;
  checks.errors = errors;
  console.log(JSON.stringify({ width, checks }));
  await page.screenshot({ path: `tests/dashboard-${width}.png`, fullPage: true });
  await page.close();
}

await browser.close();
