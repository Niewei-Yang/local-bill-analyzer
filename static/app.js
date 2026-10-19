const state = {
  dashboard: null,
  dashboardRequest: 0,
  filterContext: null,
  detailRequest: 0,
  recentRequest: 0,
  growthDayRequest: 0,
  selectedPeriodId: null,
  recentContext: null,
  recentPage: 1,
  monthlyBudget: 4500,
  growthContext: null,
  trendPage: 0,
  trendData: null,
};
const palette = ["var(--accent)", "var(--accent-2)", "var(--green)", "var(--pink)", "var(--purple)", "var(--teal)", "var(--red)"];
const money = new Intl.NumberFormat("zh-CN", { style: "currency", currency: "CNY" });
const integer = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 0 });
const $ = selector => document.querySelector(selector);

async function api(path, options = {}) {
  const response = await fetch(path, options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `请求失败：${response.status}`);
  return data;
}

function notice(message, error = false) {
  const box = $("#notice");
  box.textContent = message;
  box.classList.toggle("error", error);
  box.hidden = false;
}

function clearNotice() {
  $("#notice").hidden = true;
}

function make(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function svgNode(tag, attrs = {}, text = "") {
  const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
  Object.entries(attrs).forEach(([key, value]) => node.setAttribute(key, value));
  if (text) node.textContent = text;
  return node;
}

function adaptiveAxis(maxValue, targetTicks = 4) {
  const safeMax = Math.max(1, maxValue);
  const roughStep = safeMax / targetTicks;
  const magnitude = 10 ** Math.floor(Math.log10(roughStep));
  const normalized = roughStep / magnitude;
  const niceFactor = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 2.5 ? 2.5 : normalized <= 5 ? 5 : 10;
  const step = niceFactor * magnitude;
  const max = Math.ceil(safeMax / step) * step;
  return { max, step, ticks: Math.round(max / step) };
}

function compactAmount(value) {
  if (value >= 10000) return `${Number((value / 10000).toFixed(1))}万`;
  if (value >= 1000) return `${Number((value / 1000).toFixed(1))}k`;
  return integer.format(value);
}

function addDays(dateText, days) {
  const date = new Date(`${dateText}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function selectedPeriodBounds(period, granularity, dashboard) {
  let start = period;
  let end = period;
  if (granularity === "week") end = addDays(period, 6);
  if (granularity === "month") {
    const [year, month] = period.split("-").map(Number);
    start = `${period}-01`;
    end = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
  }
  if (dashboard.period.start) start = start < dashboard.period.start ? dashboard.period.start : start;
  if (dashboard.period.end) end = end > dashboard.period.end ? dashboard.period.end : end;
  return { start, end };
}

function selectedPeriodTitle(period, granularity) {
  if (granularity === "month") {
    const [year, month] = period.split("-");
    return `${year} 年 ${Number(month)} 月`;
  }
  if (granularity === "week") return `${period} 起始周`;
  return period;
}

function dailyBudget(day, monthlyBudget = state.monthlyBudget) {
  const date = new Date(`${day}T00:00:00Z`);
  const days = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  return monthlyBudget / days;
}

function periodBudget(period, granularity, monthlyBudget = state.monthlyBudget) {
  if (granularity === "month") return monthlyBudget;
  let budget = 0;
  for (let i = 0; i < 7; i += 1) {
    budget += dailyBudget(addDays(period, i), monthlyBudget);
  }
  return Math.round(budget * 100) / 100;
}

function cumulativeDailyPoints(trend, bounds, monthlyBudget = state.monthlyBudget, schoolIncome = []) {
  const amounts = new Map(trend.map(item => [item.period, Math.round(item.total * 100)]));
  const incomeAmounts = new Map(schoolIncome.map(item => [item.day, Math.round(item.amount * 100)]));
  const points = [];
  let cents = 0;
  let incomeCents = 0;
  let planned = 0;
  for (let day = bounds.start; day <= bounds.end; day = addDays(day, 1)) {
    const daily = amounts.get(day) || 0;
    cents += daily;
    const dailyIncome = incomeAmounts.get(day) || 0;
    incomeCents += dailyIncome;
    planned += dailyBudget(day, monthlyBudget);
    points.push({ day, daily: daily / 100, total: cents / 100, planned: Math.round(planned * 100) / 100,
      dailySchoolIncome: dailyIncome / 100, schoolIncome: incomeCents / 100 });
  }
  return points;
}

function clearGrowthDay() {
  state.growthDayRequest += 1;
  $("#growthDayDetail").hidden = true;
  document.querySelectorAll(".growth-point.selected").forEach(dot => {
    dot.classList.remove("selected");
    dot.setAttribute("aria-pressed", "false");
  });
}

async function openGrowthDay(point, dot, context) {
  clearGrowthDay();
  const request = state.growthDayRequest;
  dot.classList.add("selected");
  dot.setAttribute("aria-pressed", "true");
  $("#growthDayDetail").hidden = false;
  setText("#growthDayTitle", `${point.day} 消费明细`);
  setText("#growthDaySummary", "正在读取当天支出和退款…");
  $("#growthDayTable").replaceChildren();
  try {
    const items = [];
    let page = 1;
    let total = 0;
    do {
      const params = contextParams({ ...context, start: point.day, end: point.day }, { page, size: 200 });
      const result = await api(`/api/transactions?${params}`);
      if (request !== state.growthDayRequest) return;
      items.push(...result.items);
      total = result.total;
      page += 1;
      if (!result.items.length) break;
    } while (items.length < total);
    const isWechatIncome = item => item.platform === "微信" && item.direction === "income" && !item.is_refund && ["转账", "二维码收款"].includes(item.category_raw);
    const rows = items.filter(item => item.direction === "expense" || item.is_refund || isWechatIncome(item));
    const expenses = rows.filter(item => item.direction === "expense");
    const refunds = rows.filter(item => item.is_refund);
    const receipts = rows.filter(isWechatIncome);
    const amount = list => list.reduce((sum, item) => sum + item.amount_cents, 0) / 100;
    setText("#growthDaySummary", rows.length
      ? `${expenses.length} 笔支出 ${money.format(amount(expenses))} · ${refunds.length} 笔退款 ${money.format(amount(refunds))} · ${receipts.length} 笔微信收款 ${money.format(amount(receipts))} · 当日净支出 ${money.format(amount(expenses) - amount(refunds) - amount(receipts))}`
      : "当天没有支出、退款或微信收款，累计净支出保持不变。");
    fillTable("#growthDayTable", rows, [
      { value: item => item.transaction_time.slice(11) }, { value: "platform" },
      { value: item => item.is_refund ? "退款" : isWechatIncome(item) ? (item.category_raw === "二维码收款" ? "微信二维码收款" : "微信转账收入") : "支出" },
      { value: "counterparty" }, { value: "description" }, { value: "category" },
      { value: item => `${item.is_refund || isWechatIncome(item) ? "−" : ""}${money.format(item.amount)}`, className: "number" },
    ]);
  } catch (error) {
    if (request === state.growthDayRequest) setText("#growthDaySummary", `读取失败：${error.message}。请再次点击圆点重试。`);
  }
}

function renderDailyGrowth(detail, period, dashboard, bounds, preserveDay = false) {
  const selectedDay = preserveDay ? $(".growth-point.selected")?.dataset.day : null;
  if (!preserveDay) clearGrowthDay();
  state.growthContext = { detail, period, dashboard, bounds };
  const panel = $("#dailyGrowthPanel");
  panel.hidden = !["month", "week"].includes(dashboard.granularity);
  const svg = $("#dailyGrowthChart");
  svg.replaceChildren();
  if (panel.hidden) return;
  const budget = periodBudget(period.period, dashboard.granularity);
  const monthly = dashboard.granularity === "month";
  const displayBounds = { ...bounds };
  if (monthly && period.period === dashboard.trend?.at(-1)?.period) {
    const [year, month] = period.period.split("-").map(Number);
    displayBounds.end = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
  }
  const points = cumulativeDailyPoints(detail.trend, displayBounds, state.monthlyBudget, detail.school_income_daily);
  const actualPoints = points.filter(point => point.day <= bounds.end);
  const latest = actualPoints.at(-1)?.total || 0;
  setText("#dailyGrowthMeta", `${monthly ? "月" : "周"}额度 ${money.format(budget)} · 累计净支出 ${money.format(latest)} · ${latest > budget ? "超出" : "剩余"} ${money.format(Math.abs(budget - latest))} · 校内税后收入累计 ${money.format(actualPoints.at(-1)?.schoolIncome || 0)}${monthly ? "" : `（${money.format(state.monthlyBudget)} ÷ 当月天数，按周一至周日逐日相加）`}`);
  const describe = point => `${point.day} · 当日净支出 ${money.format(point.daily)} · 累计净支出 ${money.format(point.total)} · 计划累计 ${money.format(point.planned)} · ${point.total > point.planned ? "超计划" : "低于计划"} ${money.format(Math.abs(point.total - point.planned))} · 当日校内税后收入 ${money.format(point.dailySchoolIncome)} · 累计校内税后收入 ${money.format(point.schoolIncome)}`;
  const showPoint = (point, income = false) => {
    const readout = $("#dailyGrowthPoint");
    readout.replaceChildren(make("span", point.day, "growth-readout-date"));
    const metrics = income
      ? [["当日税后收入", point.dailySchoolIncome], ["累计校内税后收入", point.schoolIncome]]
      : [["当日净支出", point.daily], ["累计净支出", point.total],
        [point.total > point.planned ? "超计划" : "低于计划", Math.abs(point.total - point.planned)]];
    metrics.forEach(([label, value]) => {
      const item = make("span", undefined, "growth-readout-item");
      item.append(make("span", label), make("strong", money.format(value)));
      readout.append(item);
    });
  };
  const retainedPoint = actualPoints.find(point => point.day === selectedDay);
  if (retainedPoint) showPoint(retainedPoint);
  else setText("#dailyGrowthPoint", actualPoints.length ? "悬停圆点查看金额 · 点击蓝点查看明细" : "暂无数据");
  const width = 900, height = 300;
  const margin = { left: 65, right: 24, top: 36, bottom: 38 };
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  const minimum = Math.min(0, ...actualPoints.map(point => point.total));
  const maximum = Math.max(budget, ...points.map(point => point.planned), ...actualPoints.flatMap(point => [point.total, point.schoolIncome]));
  const axis = adaptiveAxis(maximum - minimum);
  const low = Math.floor(minimum / axis.step) * axis.step;
  const high = Math.max(low + axis.step, Math.ceil(maximum / axis.step) * axis.step);
  const x = index => margin.left + index / Math.max(1, points.length - 1) * (width - margin.left - margin.right);
  const y = value => height - margin.bottom - (value - low) / (high - low) * (height - margin.top - margin.bottom);
  for (let value = low; value <= high; value += axis.step) {
    svg.append(svgNode("line", { x1: margin.left, x2: width - margin.right, y1: y(value), y2: y(value), class: "chart-grid" }));
    svg.append(svgNode("text", { x: margin.left - 10, y: y(value) + 4, "text-anchor": "end", class: "chart-muted" }, compactAmount(value)));
  }
  svg.append(svgNode("line", { x1: margin.left, x2: width - margin.right, y1: y(budget), y2: y(budget), class: "growth-budget" }));
  svg.append(svgNode("text", { x: width - margin.right, y: y(budget) - 9, "text-anchor": "end", class: "growth-budget-label" }, `${monthly ? "月" : "周"}额度 ${money.format(budget)}`));
  svg.append(svgNode("path", { d: points.map((point, index) => `${index ? "L" : "M"}${x(index)},${y(point.planned)}`).join(" "), class: "growth-plan" }));
  svg.append(svgNode("path", { d: actualPoints.map((point, index) => `${index ? "L" : "M"}${x(index)},${y(point.total)}`).join(" "), class: "growth-line" }));
  svg.append(svgNode("path", { d: actualPoints.map((point, index) => `${index ? "L" : "M"}${x(index)},${y(point.schoolIncome)}`).join(" "), class: "growth-school-income" }));
  actualPoints.forEach((point, index) => {
    const dot = svgNode("circle", { cx: x(index), cy: y(point.total), r: 4, class: "growth-point", tabindex: "0", role: "button", "aria-pressed": "false", "aria-label": `${describe(point)}，点击查看消费明细` });
    dot.dataset.day = point.day;
    if (point.day === selectedDay) {
      dot.classList.add("selected");
      dot.setAttribute("aria-pressed", "true");
    }
    dot.append(svgNode("title", {}, describe(point)));
    ["mouseenter", "focus", "click"].forEach(event => dot.addEventListener(event, () => showPoint(point)));
    const context = state.filterContext;
    dot.addEventListener("click", () => openGrowthDay(point, dot, context));
    dot.addEventListener("keydown", event => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        openGrowthDay(point, dot, context);
      }
    });
    svg.append(dot);
  });
  points.forEach((point, index) => {
    if (index % Math.max(1, Math.ceil(points.length / 8)) === 0 || index === points.length - 1) {
      svg.append(svgNode("text", { x: x(index), y: height - 13, "text-anchor": "middle", class: "chart-muted" }, point.day.slice(5)));
    }
  });
  actualPoints.forEach((point, index) => {
    if (point.dailySchoolIncome <= 0) return;
    const description = `${point.day} · 当日校内税后收入 ${money.format(point.dailySchoolIncome)} · 累计校内税后收入 ${money.format(point.schoolIncome)}`;
    const dot = svgNode("circle", { cx: x(index), cy: y(point.schoolIncome), r: 3.5,
      class: "growth-school-income-point", tabindex: "0", "aria-label": description,
      "pointer-events": Math.abs(y(point.schoolIncome) - y(point.total)) < 12 ? "none" : "auto",
      "data-day": point.day, "data-daily": point.dailySchoolIncome, "data-total": point.schoolIncome });
    dot.append(svgNode("title", {}, description));
    ["mouseenter", "focus", "click"].forEach(event => dot.addEventListener(event, () => showPoint(point, true)));
    svg.append(dot);
  });
}

function currentFilterContext() {
  return {
    start: $("#startDate").value,
    end: $("#endDate").value,
    platform: $("#platformFilter").value,
    excludeLargeExpenses: $("#excludeLargeExpenses").checked,
  };
}

function contextParams(context, extra = {}) {
  const params = new URLSearchParams();
  if (context?.start) params.set("start", context.start);
  if (context?.end) params.set("end", context.end);
  if (context?.platform) params.set("platform", context.platform);
  if (context?.excludeLargeExpenses) params.set("exclude_large_expenses", "true");
  Object.entries(extra).forEach(([key, value]) => params.set(key, String(value)));
  return params;
}

function clearSelectedPeriod() {
  state.selectedPeriodId = null;
  document.querySelectorAll(".trend-period.selected").forEach(node => node.classList.remove("selected"));
}

function closeTrendDetail() {
  clearGrowthDay();
  state.detailRequest += 1;
  state.recentRequest += 1;
  $("#trendDetail").hidden = true;
  clearSelectedPeriod();
  if (!state.dashboard) return;
  renderAnalysisSections(state.dashboard, null, null);
  state.recentContext = state.filterContext;
  renderRecentPage(state.dashboard.recent, state.dashboard.summary.row_count, 1, 30);
}

function renderTrendDetail(detail, period, periodIndex, dashboard) {
  const periods = dashboard.trend || [];
  const previous = periodIndex > 0 ? periods[periodIndex - 1] : null;
  const unitNames = { month: "月", week: "周", day: "日" };
  const unit = unitNames[dashboard.granularity] || "期";
  const bounds = selectedPeriodBounds(period.period, dashboard.granularity, dashboard);
  setText("#trendDetailTitle", selectedPeriodTitle(period.period, dashboard.granularity));
  setText("#trendDetailMeta", `${bounds.start} 至 ${bounds.end} · ${integer.format(detail.summary.active_days)} 个消费日 · 下方分析已切换到此时段`);
  setText("#detailNetSpend", money.format(detail.summary.net_spend));
  setText("#detailExpenseCount", `${integer.format(detail.summary.expense_count)} 笔`);
  setText("#detailRefunds", money.format(detail.summary.refunds));
  setText("#detailTransferIncome", money.format(detail.summary.wechat_income));
  renderDailyGrowth(detail, period, dashboard, bounds);
  setText("#detailComparisonLabel", `较上一显示${unit}`);
  if (!previous) {
    setText("#detailComparison", "暂无对比");
  } else {
    const delta = period.total - previous.total;
    const rate = previous.total ? Math.abs(delta / previous.total) : null;
    const direction = delta > 0 ? "增加" : delta < 0 ? "减少" : "持平";
    setText("#detailComparison", rate === null ? `${direction} ${money.format(Math.abs(delta))}` : `${direction} ${(rate * 100).toFixed(1)}%`);
  }

}

async function openTrendDetail(period, periodIndex, dashboard, group) {
  const selectionId = `${dashboard.granularity}:${period.period}`;
  if (state.selectedPeriodId === selectionId) {
    closeTrendDetail();
    return;
  }
  document.querySelectorAll(".trend-period.selected").forEach(node => node.classList.remove("selected"));
  group.classList.add("selected");
  state.selectedPeriodId = selectionId;
  const panel = $("#trendDetail");
  panel.hidden = false;
  clearGrowthDay();
  $("#dailyGrowthPanel").hidden = true;
  setText("#trendDetailTitle", "正在读取…");
  setText("#trendDetailMeta", "正在汇总该时段的消费构成");
  const bounds = selectedPeriodBounds(period.period, dashboard.granularity, dashboard);
  const selectionLabel = selectedPeriodTitle(period.period, dashboard.granularity);
  const context = { ...state.filterContext, ...bounds, label: selectionLabel };
  const params = contextParams(context, { granularity: "day" });
  const recentParams = contextParams(context, { page: 1, size: 30 });
  const topParams = contextParams(context, { page: 1, size: 1, direction: "expense", sort: "amount_desc" });
  const request = ++state.detailRequest;
  state.recentRequest += 1;
  try {
    const [detail, recent, topExpense] = await Promise.all([
      api(`/api/dashboard?${params}`),
      api(`/api/transactions?${recentParams}`),
      dashboard.granularity === "day" ? api(`/api/transactions?${topParams}`) : Promise.resolve(null),
    ]);
    if (request !== state.detailRequest) return;
    renderTrendDetail(detail, period, periodIndex, dashboard);
    renderAnalysisSections(detail, { label: selectionLabel, granularity: dashboard.granularity }, topExpense?.items?.[0] || null);
    state.recentContext = context;
    renderRecentPage(recent.items, recent.total, recent.page, recent.size);
  } catch (error) {
    if (request === state.detailRequest) {
      closeTrendDetail();
      notice(`时段明细读取失败：${error.message}`, true);
    }
  }
}

function queryString(context = currentFilterContext()) {
  const params = contextParams(context, { granularity: $("#granularity").value || "month" });
  const value = params.toString();
  return value ? `?${value}` : "";
}

function setText(selector, text) {
  $(selector).textContent = text;
}

function renderSummary(data) {
  const summary = data.summary;
  setText("#netSpend", money.format(summary.net_spend));
  setText("#income", money.format(summary.income));
  setText("#cashGap", money.format(summary.cash_gap));
  setText("#dailyAverage", money.format(summary.daily_average));
  setText("#expenseMeta", `${integer.format(summary.expense_count)} 笔支出，${integer.format(summary.refund_count)} 笔退款`);
  setText("#medianMeta", `单笔中位数 ${money.format(summary.median_expense)}`);
  const scope = data.period.start ? `${data.period.start} 至 ${data.period.end}（${data.period.days} 天）` : "当前筛选下暂无交易";
  setText("#periodText", scope + (state.filterContext?.excludeLargeExpenses ? " · 已排除单笔 ≥ 1000 元支出" : ""));
}

function renderPlatforms(items) {
  const bar = $("#platformBar");
  const legend = $("#platformLegend");
  bar.replaceChildren();
  legend.replaceChildren();
  const total = items.reduce((sum, item) => sum + Math.max(0, item.amount), 0);
  items.forEach((item, index) => {
    const share = total ? Math.max(0, item.amount) / total : 0;
    const segment = make("div", undefined, "platform-segment");
    segment.style.width = `${share * 100}%`;
    segment.title = `${item.platform} ${money.format(item.amount)}，${(share * 100).toFixed(1)}%`;
    bar.append(segment);
    const label = make("span", undefined, "legend-item");
    const swatch = make("i", undefined, "swatch");
    swatch.style.background = palette[index % palette.length];
    label.append(swatch, document.createTextNode(`${item.platform} ${money.format(item.amount)} · ${(share * 100).toFixed(1)}%`));
    legend.append(label);
  });
}

function monthlySchoolIncomePeriods(periods, dailyIncome = []) {
  const months = new Map(periods.map(period => [period.period || period.month, { ...period, school_income: 0 }]));
  const amounts = new Map();
  dailyIncome.forEach(row => {
    const cents = Math.round(row.amount * 100);
    if (cents <= 0) return;
    const month = row.day.slice(0, 7);
    amounts.set(month, (amounts.get(month) || 0) + cents);
    if (!months.has(month)) months.set(month, { period: month, total: 0, categories: {}, school_income: 0 });
  });
  return [...months.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([month, period]) => ({
    ...period, school_income: (amounts.get(month) || 0) / 100,
  }));
}

function renderTrend(data) {
  state.trendData = data;
  const svg = $("#monthlyChart");
  svg.replaceChildren();
  delete svg.dataset.axisMin;
  delete svg.dataset.axisMax;
  const granularity = data.granularity || "month";
  const sourcePeriods = data.trend || data.monthly || [];
  const allPeriods = granularity === "month" ? monthlySchoolIncomePeriods(sourcePeriods, data.school_income_daily) : sourcePeriods;
  const chartData = { ...data, trend: allPeriods };
  const pageCount = Math.max(1, Math.ceil(allPeriods.length / 7));
  state.trendPage = Math.max(0, Math.min(state.trendPage, pageCount - 1));
  const end = allPeriods.length - state.trendPage * 7;
  const start = Math.max(0, end - 7);
  const periods = allPeriods.slice(start, end);
  $("#trendPrev").disabled = state.trendPage >= pageCount - 1;
  $("#trendNext").disabled = state.trendPage === 0;
  setText("#trendPageInfo", periods.length
    ? `${periods[0].period || periods[0].month} 至 ${periods.at(-1).period || periods.at(-1).month} · 第 ${pageCount - state.trendPage} / ${pageCount} 页`
    : "暂无数据");
  const hasSchoolIncome = periods.some(period => period.school_income > 0);
  const categories = [...new Set(data.trend_categories || data.monthly_categories || [])];
  const labels = {
    month: { title: "月度支出与校内收入", hint: "点击月份查看详情，末月可能不完整", aria: "月度分类支出与校内税后收入堆叠柱状图" },
    week: { title: "每周支出与构成", hint: "点击周次查看详细构成，每周从周一开始", aria: "每周分类支出堆叠柱状图" },
    day: { title: "每日支出与构成", hint: "点击日期查看详细构成", aria: "每日分类支出堆叠柱状图" }
  }[granularity];
  setText("#trendTitle", labels.title);
  setText("#trendHint", hasSchoolIncome
    ? `${labels.hint}；紫色负柱及括号数字为校内税后收入，柱顶首行为净支出（未减校内收入）`
    : `${labels.hint}；柱顶数字为净支出，零线下方为类别净抵扣`);
  svg.setAttribute("aria-label", labels.aria);
  const width = svg.parentElement.clientWidth || 920;
  const height = 330;
  const narrow = width < 520;
  svg.classList.toggle("trend-narrow", narrow);
  const margin = { top: granularity === "month" ? 46 : 28, right: narrow ? 12 : 18, bottom: 48, left: narrow ? 48 : 62 };
  const innerWidth = width - margin.left - margin.right;
  const innerHeight = height - margin.top - margin.bottom;
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.append(svgNode("title", {}, labels.aria));
  const legend = $("#monthlyLegend");
  legend.replaceChildren();
  [...categories, ...(hasSchoolIncome ? ["校内税后收入（负值）"] : [])].forEach((category, index) => {
    const item = make("span", undefined, "legend-item");
    const swatch = make("i", undefined, "swatch");
    swatch.style.background = index < categories.length ? palette[index % palette.length] : "var(--purple)";
    item.append(swatch, document.createTextNode(category));
    legend.append(item);
  });
  if (!periods.length) {
    svg.append(svgNode("text", { x: width / 2, y: height / 2, "text-anchor": "middle", class: "chart-label" }, "暂无数据"));
    return;
  }
  const stacks = periods.map(period => categories.reduce((totals, category) => {
    const amount = period.categories[category] || 0;
    totals[amount >= 0 ? "positive" : "negative"] += amount;
    return totals;
  }, { positive: 0, negative: -(period.school_income || 0) }));
  const minimum = Math.min(0, ...stacks.map(item => item.negative));
  const maximum = Math.max(0, ...stacks.map(item => item.positive));
  const axis = adaptiveAxis(maximum - minimum);
  const low = Math.floor(minimum / axis.step) * axis.step;
  const high = Math.max(low + axis.step, Math.ceil(maximum / axis.step) * axis.step);
  svg.dataset.axisMin = low;
  svg.dataset.axisMax = high;
  const y = value => margin.top + innerHeight - (value - low) / (high - low) * innerHeight;
  const band = innerWidth / periods.length;
  const barWidth = Math.max(8, Math.min(112, band * .62));

  for (let value = low; value <= high; value += axis.step) {
    const yy = y(value);
    svg.append(svgNode("line", { x1: margin.left, y1: yy, x2: width - margin.right, y2: yy, class: "chart-grid" }));
    svg.append(svgNode("text", { x: margin.left - 9, y: yy + 4, "text-anchor": "end", class: "chart-muted" }, compactAmount(value)));
  }

  const periodLabel = value => {
    if (granularity === "month") return narrow ? `${Number(value.slice(5, 7))}月` : value;
    const [, month, day] = value.split("-");
    return granularity === "week" ? `${month}/${day}${narrow ? "" : "周"}` : `${month}-${day}`;
  };

  periods.forEach((period, periodIndex) => {
    const periodKey = period.period || period.month;
    const detailPeriod = { ...period, period: periodKey };
    const bandX = margin.left + band * periodIndex;
    const x = margin.left + band * periodIndex + (band - barWidth) / 2;
    const group = svgNode("g", {
      class: `trend-period${state.selectedPeriodId === `${granularity}:${periodKey}` ? " selected" : ""}`, tabindex: "0", role: "button",
      "data-period": periodKey,
      "aria-label": `${periodKey}，净支出 ${money.format(period.total)}${period.school_income ? `，校内税后收入 ${money.format(period.school_income)}` : ""}，点击查看详细构成`
    });
    group.append(svgNode("rect", {
      x: bandX, y: margin.top, width: band, height: innerHeight + 36, class: "trend-hit"
    }));
    let positive = 0;
    let negative = 0;
    categories.forEach((category, categoryIndex) => {
      const amount = period.categories[category] || 0;
      if (amount === 0) return;
      const cumulative = amount > 0 ? positive : negative;
      const top = cumulative + amount;
      const rect = svgNode("rect", {
        x, y: y(Math.max(cumulative, top)), width: barWidth, height: Math.abs(y(cumulative) - y(top)),
        fill: palette[categoryIndex % palette.length],
        "data-category": category, "data-amount": amount
      });
      rect.append(svgNode("title", {}, `${periodKey} · ${category}：${money.format(amount)}`));
      group.append(rect);
      if (amount > 0) positive = top;
      else negative = top;
    });
    if (period.school_income > 0) {
      const top = negative - period.school_income;
      const rect = svgNode("rect", {
        x, y: y(negative), width: barWidth, height: y(top) - y(negative), fill: "var(--purple)",
        "data-series": "school-income", "data-amount": -period.school_income,
      });
      rect.append(svgNode("title", {}, `${periodKey} · 校内税后收入：${money.format(period.school_income)}（图中记为负值）`));
      group.append(rect);
    }
    const label = svgNode("text", { x: x + barWidth / 2, y: y(positive) - (granularity === "month" ? 25 : 7), "text-anchor": "middle", class: "chart-label trend-net-label", "data-total": period.total }, Math.abs(period.total) >= 1000 ? `${(period.total / 1000).toFixed(2)}k` : period.total.toFixed(0));
    label.append(svgNode("title", {}, `净支出 ${money.format(period.total)}${hasSchoolIncome ? "（未减校内收入）" : ""}`));
    group.append(label);
    if (granularity === "month") {
      const income = period.school_income || 0;
      const incomeLabel = svgNode("text", {
        x: x + barWidth / 2, y: y(positive) - 7, "text-anchor": "middle",
        class: "chart-label trend-income-label", "data-income": income,
      }, `（${income >= 1000 ? `${(income / 1000).toFixed(1)}k` : income.toFixed(0)}）`);
      incomeLabel.append(svgNode("title", {}, `校内税后收入 ${money.format(income)}`));
      group.append(incomeLabel);
    }
    const timeLabel = svgNode("text", { x: x + barWidth / 2, y: height - 20, "text-anchor": "middle", class: "chart-label trend-x-label" }, periodLabel(periodKey));
    if (narrow && granularity === "month") {
      timeLabel.append(svgNode("tspan", { x: x + barWidth / 2, dy: 14, class: "trend-year-label" }, periodKey.slice(0, 4)));
    }
    group.append(timeLabel);
    group.addEventListener("click", () => openTrendDetail(detailPeriod, start + periodIndex, chartData, group));
    group.addEventListener("keydown", event => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        openTrendDetail(detailPeriod, start + periodIndex, chartData, group);
      }
    });
    svg.append(group);
  });
  svg.append(svgNode("line", { x1: margin.left, y1: y(0), x2: width - margin.right, y2: y(0), class: "chart-axis" }));
}

function changeTrendPage(delta) {
  if (!state.trendData) return;
  if (!$("#trendDetail").hidden) closeTrendDetail();
  state.trendPage += delta;
  renderTrend(state.trendData);
}

function renderCategories(items) {
  const host = $("#categoryBars");
  host.replaceChildren();
  const rows = items.slice(0, 10);
  const max = Math.max(...rows.map(item => item.amount), 1);
  rows.forEach(item => {
    const row = make("div", undefined, "category-row");
    const name = make("span", item.category);
    const track = make("div", undefined, "bar-track");
    const fill = make("div", undefined, "bar-fill");
    fill.style.width = `${Math.max(0, item.amount) / max * 100}%`;
    track.append(fill);
    const value = make("span", `${money.format(item.amount)} · ${(item.share * 100).toFixed(1)}%`, "number");
    row.append(name, track, value);
    host.append(row);
  });
}

function renderHeatmap(items) {
  const host = $("#heatmap");
  host.replaceChildren();
  const weekdays = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];
  const periods = ["凌晨", "上午", "午间", "下午", "晚间"];
  const max = Math.max(...items.map(item => item.amount), 1);
  host.append(make("div", ""));
  periods.forEach(period => host.append(make("div", period, "heat-head")));
  weekdays.forEach(weekday => {
    host.append(make("div", weekday, "heat-side"));
    periods.forEach(period => {
      const item = items.find(value => value.weekday === weekday && value.period === period) || { amount: 0 };
      const cell = make("div", item.amount >= 1000 ? `${(item.amount / 1000).toFixed(2)}k` : integer.format(item.amount), "heat-cell");
      cell.style.setProperty("--heat", `${8 + (item.amount / max) * 84}%`);
      cell.title = `${weekday} · ${period}：${money.format(item.amount)}`;
      host.append(cell);
    });
  });
}

function fillTable(selector, items, fields) {
  const body = $(selector);
  body.replaceChildren();
  items.forEach(item => {
    const row = document.createElement("tr");
    fields.forEach(field => {
      const cell = document.createElement("td");
      const value = typeof field.value === "function" ? field.value(item) : item[field.value];
      cell.textContent = value ?? "";
      if (field.className) cell.className = field.className;
      if (field.title) cell.title = item[field.title] || "";
      row.append(cell);
    });
    body.append(row);
  });
}

function renderMerchants(items) {
  fillTable("#merchantTable", items, [
    { value: "merchant" }, { value: "platform" }, { value: "count", className: "number" }, { value: item => money.format(item.amount), className: "number" }
  ]);
}

function renderTopSpend(data, selection, topExpense) {
  const topDays = $("#topDays");
  topDays.replaceChildren();
  if (selection?.granularity === "day") {
    setText("#topSpendTitle", "最高支出单笔");
    setText("#topSpendHint", `${selection.label} · 按单笔支出金额`);
    if (!topExpense) {
      topDays.append(make("li", "该日没有支出记录", "muted"));
      return;
    }
    const li = document.createElement("li");
    const row = make("div", undefined, "rank-row");
    const merchant = topExpense.counterparty || topExpense.description || "未注明交易对方";
    row.append(make("span", `${topExpense.transaction_time.slice(11, 16)} · ${merchant}`), make("strong", money.format(topExpense.amount), "number"));
    li.append(row);
    if (topExpense.description && topExpense.description !== merchant) li.append(make("small", topExpense.description, "rank-note"));
    topDays.append(li);
    return;
  }
  setText("#topSpendTitle", "最高支出日");
  setText("#topSpendHint", selection ? `${selection.label} · 按当日净支出` : "按当日净支出");
  data.top_days.forEach(item => {
    const li = document.createElement("li");
    const row = make("div", undefined, "rank-row");
    row.append(make("span", item.date), make("strong", money.format(item.amount), "number"));
    li.append(row);
    topDays.append(li);
  });
  if (!data.top_days.length) topDays.append(make("li", "该时段没有净支出", "muted"));
}

const directions = { expense: "支出", income: "收入", neutral: "不计收支" };

function renderRecentPage(items, total, page, size) {
  fillTable("#recentTable", items, [
    { value: "transaction_time" }, { value: "platform" }, { value: item => directions[item.direction] || item.direction },
    { value: "category" }, { value: "counterparty" }, { value: "description" },
    { value: item => money.format(item.amount), className: "number" }
  ]);
  const pages = Math.max(1, Math.ceil(total / size));
  state.recentPage = page;
  const scope = state.recentContext?.label ? `${state.recentContext.label} · ` : "";
  setText("#recentHint", `${scope}第 ${page}/${pages} 页，共 ${integer.format(total)} 笔`);
  $("#recentPager").hidden = total <= size;
  $("#recentPrev").disabled = page <= 1;
  $("#recentNext").disabled = page >= pages;
  setText("#recentPageInfo", `第 ${page} / ${pages} 页`);
}

async function loadRecentPage(page) {
  const context = state.recentContext || currentFilterContext();
  const params = contextParams(context, { page, size: 30 });
  const request = ++state.recentRequest;
  try {
    const result = await api(`/api/transactions?${params}`);
    if (request !== state.recentRequest) return;
    renderRecentPage(result.items, result.total, result.page, result.size);
  } catch (error) {
    if (request === state.recentRequest) notice(error.message, true);
  }
}

function renderAnalysisSections(data, selection, topExpense) {
  const scope = selection ? ` · ${selection.label}` : "";
  setText("#categoryHint", `净支出金额与占比${scope}`);
  setText("#heatmapHint", `支出原额，颜色越深金额越高${scope}`);
  setText("#merchantHint", `按支出交易原额${scope}`);
  renderCategories(data.categories);
  renderHeatmap(data.heatmap);
  renderMerchants(data.merchants);
  renderTopSpend(data, selection, topExpense);
}

function renderDashboard(data, context) {
  clearGrowthDay();
  state.detailRequest += 1;
  state.recentRequest += 1;
  $("#trendDetail").hidden = true;
  clearSelectedPeriod();
  state.dashboard = data;
  state.filterContext = context;
  state.recentContext = context;
  renderSummary(data);
  renderPlatforms(data.platforms);
  state.trendPage = 0;
  renderTrend(data);
  renderAnalysisSections(data, null, null);
  renderRecentPage(data.recent, data.summary.row_count, 1, 30);
}

async function loadDashboard() {
  clearNotice();
  const request = ++state.dashboardRequest;
  const context = currentFilterContext();
  clearGrowthDay();
  state.detailRequest += 1;
  state.recentRequest += 1;
  try {
    const data = await api(`/api/dashboard${queryString(context)}`);
    if (request !== state.dashboardRequest) return;
    renderDashboard(data, context);
  } catch (error) {
    if (request === state.dashboardRequest) notice(error.message, true);
  }
}

async function loadMeta() {
  const meta = await api("/api/meta");
  setText("#dbPath", meta.storage === "postgres" ? "" : `账本位置：${meta.database}`);
  setText("#storageNotice", meta.storage === "postgres" ? "账本保存在云端，登录后可跨设备查看。" : "账本保存在运行服务的设备上。");
}

async function loadRules() {
  const result = await api("/api/rules");
  const body = $("#rulesTable");
  body.replaceChildren();
  result.items.forEach(rule => {
    const row = document.createElement("tr");
    [rule.field, rule.pattern, rule.category, rule.priority].forEach((value, index) => {
      const cell = make("td", String(value), index === 3 ? "number" : "");
      row.append(cell);
    });
    const actionCell = document.createElement("td");
    const button = make("button", "删除", "danger-link");
    button.type = "button";
    button.addEventListener("click", async () => {
      try {
        const data = await api(`/api/rules/${rule.id}`, { method: "DELETE" });
        notice(`规则已删除，${data.reclassified} 笔历史交易重新分类。`);
        await Promise.all([loadRules(), loadDashboard()]);
      } catch (error) { notice(error.message, true); }
    });
    actionCell.append(button);
    row.append(actionCell);
    body.append(row);
  });
}

async function loadImports() {
  const result = await api("/api/imports");
  fillTable("#importsTable", result.items, [
    { value: "imported_at" }, { value: "filename" }, { value: "platform" },
    { value: "total_rows", className: "number" }, { value: "inserted_rows", className: "number" },
    { value: "updated_rows", className: "number" }, { value: "unchanged_rows", className: "number" }
  ]);
}

async function uploadFiles(files) {
  if (!files.length) return;
  $("#uploadButton").disabled = true;
  const messages = [];
  try {
    for (const file of files) {
      notice(`正在导入 ${file.name}…`);
      const result = await api("/api/import", {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream", "X-Filename": encodeURIComponent(file.name) },
        body: file
      });
      messages.push(`${file.name}：新增 ${result.inserted}，更新 ${result.updated}，重复 ${result.unchanged}${result.excluded ? `，另有 ${result.excluded} 条早于支出时间窗未导入` : ""}`);
    }
    notice(messages.join("；"));
    await Promise.all([loadDashboard(), loadMeta(), loadImports()]);
  } catch (error) {
    notice(error.message, true);
  } finally {
    $("#uploadButton").disabled = false;
    $("#fileInput").value = "";
  }
}

async function exportDatabase() {
  const button = $("#exportDatabaseButton");
  button.disabled = true;
  try {
    const response = await fetch("/api/database/export");
    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || `导出失败：${response.status}`);
    }
    const blob = await response.blob();
    const disposition = response.headers.get("Content-Disposition") || "";
    const filename = disposition.match(/filename="([^"]+)"/)?.[1] || "bills.db";
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    notice(`账本备份已导出为 ${filename}。`);
  } catch (error) {
    notice(error.message, true);
  } finally {
    button.disabled = false;
  }
}

async function importDatabase(file) {
  if (!file) return;
  const confirmed = window.confirm(
    `确定从“${file.name}”恢复账本吗？这会替换当前账本，原账本将自动备份。请选择本工具导出的完整账本备份文件。`
  );
  if (!confirmed) return;
  const button = $("#importDatabaseButton");
  button.disabled = true;
  try {
    notice(`正在校验并恢复 ${file.name}…`);
    const response = await fetch("/api/database/import", {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream", "X-Filename": encodeURIComponent(file.name) },
      body: file
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || `导入失败：${response.status}`);
    const backup = result.backup ? `原账本已备份为 ${result.backup}` : "原账本为空，无需备份";
    notice(`账本已恢复：${integer.format(result.transactions)} 笔交易、${integer.format(result.rules)} 条分类规则、${integer.format(result.imports)} 条导入记录。${backup}。`);
    await Promise.all([loadDashboard(), loadMeta(), loadRules(), loadImports()]);
  } catch (error) {
    notice(error.message, true);
  } finally {
    button.disabled = false;
    $("#databaseFileInput").value = "";
  }
}

$("#uploadButton").addEventListener("click", () => $("#fileInput").click());
$("#trendPrev").addEventListener("click", () => changeTrendPage(1));
$("#trendNext").addEventListener("click", () => changeTrendPage(-1));
let trendWidth = 0;
new ResizeObserver(entries => {
  const width = entries[0].contentRect.width;
  if (width === trendWidth) return;
  trendWidth = width;
  if (state.trendData) renderTrend(state.trendData);
}).observe($("#monthlyChart").parentElement);
$("#exportDatabaseButton").addEventListener("click", exportDatabase);
$("#importDatabaseButton").addEventListener("click", () => $("#databaseFileInput").click());
$("#databaseFileInput").addEventListener("change", event => {
  const file = event.target.files[0];
  event.target.value = "";
  importDatabase(file);
});
try {
  const saved = localStorage.getItem("billAnalyzer.monthlyBudget");
  const value = Number(saved);
  if (saved !== null && saved.trim() && Number.isFinite(value) && value >= 0 && value <= 1000000000) {
    state.monthlyBudget = Math.round(value * 100) / 100;
  }
} catch { /* The setting remains available when browser storage is disabled. */ }
$("#monthlyBudget").value = state.monthlyBudget;
$("#monthlyBudget").addEventListener("input", event => {
  const input = event.target;
  if (!input.value.trim() || !input.validity.valid || !Number.isFinite(input.valueAsNumber)) {
    setText("#budgetHint", "请输入 0～10亿元之间的金额，最多两位小数；当前额度保持不变。");
    return;
  }
  state.monthlyBudget = Math.round(input.valueAsNumber * 100) / 100;
  try {
    localStorage.setItem("billAnalyzer.monthlyBudget", String(state.monthlyBudget));
    setText("#budgetHint", "已保存，月额度及折算后的周额度已更新。");
  } catch {
    setText("#budgetHint", "额度已更新；当前浏览器无法保存，刷新后将恢复默认值。");
  }
  if (state.growthContext && !$("#trendDetail").hidden && !$("#dailyGrowthPanel").hidden) {
    const { detail, period, dashboard, bounds } = state.growthContext;
    renderDailyGrowth(detail, period, dashboard, bounds, true);
  }
});
$("#closeTrendDetail").addEventListener("click", closeTrendDetail);
$("#recentPrev").addEventListener("click", () => loadRecentPage(state.recentPage - 1));
$("#recentNext").addEventListener("click", () => loadRecentPage(state.recentPage + 1));
$("#fileInput").addEventListener("change", event => uploadFiles([...event.target.files]));
$("#applyFilters").addEventListener("click", loadDashboard);
$("#granularity").addEventListener("change", loadDashboard);
$("#excludeLargeExpenses").addEventListener("change", loadDashboard);
$("#clearFilters").addEventListener("click", () => {
  $("#startDate").value = "";
  $("#endDate").value = "";
  $("#platformFilter").value = "";
  $("#granularity").value = "month";
  $("#excludeLargeExpenses").checked = false;
  loadDashboard();
});

$("#ruleForm").addEventListener("submit", async event => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const payload = {
    field: form.get("field"), pattern: form.get("pattern"), category: form.get("category"),
    priority: Number(form.get("priority")), apply_existing: form.get("apply_existing") === "on"
  };
  try {
    const result = await api("/api/rules", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload)
    });
    notice(`规则已新增，${result.reclassified} 笔历史交易重新分类。`);
    event.currentTarget.reset();
    event.currentTarget.elements.priority.value = 100;
    event.currentTarget.elements.apply_existing.checked = true;
    await Promise.all([loadRules(), loadDashboard(), loadMeta()]);
  } catch (error) {
    notice(error.message, true);
  }
});

Promise.all([loadDashboard(), loadMeta(), loadRules(), loadImports()]).catch(error => notice(error.message, true));
