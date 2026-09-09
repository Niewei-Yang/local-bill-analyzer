const state = { dashboard: null, detailRequest: 0 };
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

function closeTrendDetail() {
  state.detailRequest += 1;
  $("#trendDetail").hidden = true;
  document.querySelectorAll(".trend-period.selected").forEach(node => node.classList.remove("selected"));
}

function renderTrendDetail(detail, period, periodIndex, dashboard) {
  const periods = dashboard.trend || [];
  const previous = periodIndex > 0 ? periods[periodIndex - 1] : null;
  const unitNames = { month: "月", week: "周", day: "日" };
  const unit = unitNames[dashboard.granularity] || "期";
  const bounds = selectedPeriodBounds(period.period, dashboard.granularity, dashboard);
  setText("#trendDetailTitle", selectedPeriodTitle(period.period, dashboard.granularity));
  setText("#trendDetailMeta", `${bounds.start} 至 ${bounds.end} · ${integer.format(detail.summary.active_days)} 个消费日`);
  setText("#detailNetSpend", money.format(detail.summary.net_spend));
  setText("#detailExpenseCount", `${integer.format(detail.summary.expense_count)} 笔`);
  setText("#detailRefunds", money.format(detail.summary.refunds));
  setText("#detailComparisonLabel", `较上一显示${unit}`);
  if (!previous) {
    setText("#detailComparison", "暂无对比");
  } else {
    const delta = period.total - previous.total;
    const rate = previous.total ? Math.abs(delta / previous.total) : null;
    const direction = delta > 0 ? "增加" : delta < 0 ? "减少" : "持平";
    setText("#detailComparison", rate === null ? `${direction} ${money.format(Math.abs(delta))}` : `${direction} ${(rate * 100).toFixed(1)}%`);
  }

  const categoryHost = $("#detailCategories");
  categoryHost.replaceChildren();
  const categoryRows = detail.categories.filter(item => item.amount > 0).slice(0, 10);
  const categoryMax = Math.max(...categoryRows.map(item => item.amount), 1);
  categoryRows.forEach(item => {
    const row = make("div", undefined, "detail-category-row");
    const track = make("div", undefined, "bar-track");
    const fill = make("div", undefined, "bar-fill");
    fill.style.width = `${item.amount / categoryMax * 100}%`;
    track.append(fill);
    row.append(make("span", item.category), track, make("span", `${money.format(item.amount)} · ${(item.share * 100).toFixed(1)}%`, "number"));
    categoryHost.append(row);
  });
  if (!categoryRows.length) categoryHost.append(make("p", "该时段没有净支出分类", "muted"));

  const merchantHost = $("#detailMerchants");
  merchantHost.replaceChildren();
  detail.merchants.slice(0, 8).forEach(item => {
    const row = make("div", undefined, "rank-row");
    row.append(make("span", item.merchant), make("strong", money.format(item.amount), "number"));
    const li = document.createElement("li");
    li.append(row);
    merchantHost.append(li);
  });
  if (!detail.merchants.length) merchantHost.append(make("li", "该时段没有商户支出", "muted"));
}

async function openTrendDetail(period, periodIndex, dashboard, group) {
  document.querySelectorAll(".trend-period.selected").forEach(node => node.classList.remove("selected"));
  group.classList.add("selected");
  const panel = $("#trendDetail");
  panel.hidden = false;
  setText("#trendDetailTitle", "正在读取…");
  setText("#trendDetailMeta", "正在汇总该时段的消费构成");
  const bounds = selectedPeriodBounds(period.period, dashboard.granularity, dashboard);
  const params = new URLSearchParams({ start: bounds.start, end: bounds.end, granularity: "day" });
  const platform = $("#platformFilter").value;
  if (platform) params.set("platform", platform);
  const request = ++state.detailRequest;
  try {
    const detail = await api(`/api/dashboard?${params}`);
    if (request !== state.detailRequest) return;
    renderTrendDetail(detail, period, periodIndex, dashboard);
  } catch (error) {
    if (request === state.detailRequest) {
      setText("#trendDetailTitle", "明细读取失败");
      setText("#trendDetailMeta", error.message);
    }
  }
}

function queryString() {
  const params = new URLSearchParams();
  const start = $("#startDate").value;
  const end = $("#endDate").value;
  const platform = $("#platformFilter").value;
  const granularity = $("#granularity").value;
  if (start) params.set("start", start);
  if (end) params.set("end", end);
  if (platform) params.set("platform", platform);
  params.set("granularity", granularity || "month");
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
  setText("#periodText", data.period.start ? `${data.period.start} 至 ${data.period.end}（${data.period.days} 天）` : "数据库暂无交易");
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

function renderTrend(data) {
  const svg = $("#monthlyChart");
  svg.replaceChildren();
  const granularity = data.granularity || "month";
  const periods = data.trend || data.monthly || [];
  const categories = data.trend_categories || data.monthly_categories || [];
  const labels = {
    month: { title: "月度支出与构成", hint: "点击月份查看详细构成，末月可能是不完整月份", aria: "月度分类支出堆叠柱状图" },
    week: { title: "每周支出与构成", hint: "点击周次查看详细构成，每周从周一开始", aria: "每周分类支出堆叠柱状图" },
    day: { title: "每日支出与构成", hint: "点击日期查看详细构成，可横向滚动", aria: "每日分类支出堆叠柱状图" }
  }[granularity];
  setText("#trendTitle", labels.title);
  setText("#trendHint", labels.hint);
  svg.setAttribute("aria-label", labels.aria);
  const width = granularity === "day" ? Math.max(920, periods.length * 32 + 90)
    : granularity === "week" ? Math.max(920, periods.length * 62 + 90) : 920;
  const height = 330;
  const margin = { top: 28, right: 18, bottom: 48, left: 62 };
  const innerWidth = width - margin.left - margin.right;
  const innerHeight = height - margin.top - margin.bottom;
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.style.minWidth = `${width}px`;
  svg.append(svgNode("title", {}, labels.aria));
  if (!periods.length) {
    svg.append(svgNode("text", { x: width / 2, y: height / 2, "text-anchor": "middle", class: "chart-label" }, "暂无数据"));
    return;
  }
  const axis = adaptiveAxis(Math.max(...periods.map(item => Math.max(0, item.total)), 1));
  const y = value => margin.top + innerHeight - (value / axis.max) * innerHeight;
  const band = innerWidth / periods.length;
  const barWidth = Math.max(8, Math.min(112, band * .62));

  for (let tick = 0; tick <= axis.ticks; tick += 1) {
    const value = axis.step * tick;
    const yy = y(value);
    svg.append(svgNode("line", { x1: margin.left, y1: yy, x2: width - margin.right, y2: yy, class: "chart-grid" }));
    svg.append(svgNode("text", { x: margin.left - 9, y: yy + 4, "text-anchor": "end", class: "chart-muted" }, compactAmount(value)));
  }

  const periodLabel = value => {
    if (granularity === "month") return value;
    const [, month, day] = value.split("-");
    return granularity === "week" ? `${month}/${day}周` : `${month}-${day}`;
  };
  const labelEvery = granularity === "day" ? 7 : 1;

  periods.forEach((period, periodIndex) => {
    const periodKey = period.period || period.month;
    const detailPeriod = { ...period, period: periodKey };
    const bandX = margin.left + band * periodIndex;
    const x = margin.left + band * periodIndex + (band - barWidth) / 2;
    const group = svgNode("g", {
      class: "trend-period", tabindex: "0", role: "button",
      "aria-label": `${periodLabel(periodKey)}，净支出 ${money.format(period.total)}，点击查看详细构成`
    });
    group.append(svgNode("rect", {
      x: bandX, y: margin.top, width: band, height: innerHeight + 36, class: "trend-hit"
    }));
    let cumulative = 0;
    categories.forEach((category, categoryIndex) => {
      const amount = period.categories[category] || 0;
      if (amount <= 0) return;
      const top = cumulative + amount;
      const rect = svgNode("rect", {
        x, y: y(top), width: barWidth, height: Math.max(0, y(cumulative) - y(top)),
        fill: palette[categoryIndex % palette.length]
      });
      rect.append(svgNode("title", {}, `${periodKey} · ${category}：${money.format(amount)}`));
      group.append(rect);
      cumulative = top;
    });
    if (granularity !== "day" || periods.length <= 35 || periodIndex % labelEvery === 0 || periodIndex === periods.length - 1) {
      group.append(svgNode("text", { x: x + barWidth / 2, y: y(cumulative) - 7, "text-anchor": "middle", class: "chart-label" }, cumulative >= 1000 ? `${(cumulative / 1000).toFixed(2)}k` : cumulative.toFixed(0)));
    }
    if (periodIndex % labelEvery === 0 || periodIndex === periods.length - 1) {
      group.append(svgNode("text", { x: x + barWidth / 2, y: height - 20, "text-anchor": "middle", class: "chart-label trend-x-label" }, periodLabel(periodKey)));
    }
    group.addEventListener("click", () => openTrendDetail(detailPeriod, periodIndex, data, group));
    group.addEventListener("keydown", event => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        openTrendDetail(detailPeriod, periodIndex, data, group);
      }
    });
    svg.append(group);
  });
  svg.append(svgNode("line", { x1: margin.left, y1: margin.top + innerHeight, x2: width - margin.right, y2: margin.top + innerHeight, class: "chart-axis" }));
  const legend = $("#monthlyLegend");
  legend.replaceChildren();
  categories.forEach((category, index) => {
    const item = make("span", undefined, "legend-item");
    const swatch = make("i", undefined, "swatch");
    swatch.style.background = palette[index % palette.length];
    item.append(swatch, document.createTextNode(category));
    legend.append(item);
  });
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

function renderTables(data) {
  fillTable("#merchantTable", data.merchants, [
    { value: "merchant" }, { value: "platform" }, { value: "count", className: "number" }, { value: item => money.format(item.amount), className: "number" }
  ]);
  const topDays = $("#topDays");
  topDays.replaceChildren();
  data.top_days.forEach(item => {
    const li = document.createElement("li");
    const row = make("div", undefined, "rank-row");
    row.append(make("span", item.date), make("strong", money.format(item.amount), "number"));
    li.append(row);
    topDays.append(li);
  });
  const directions = { expense: "支出", income: "收入", neutral: "不计收支" };
  fillTable("#recentTable", data.recent, [
    { value: "transaction_time" }, { value: "platform" }, { value: item => directions[item.direction] || item.direction },
    { value: "category" }, { value: "counterparty" }, { value: "description" },
    { value: item => money.format(item.amount), className: "number" }
  ]);
}

function renderDashboard(data) {
  state.detailRequest += 1;
  $("#trendDetail").hidden = true;
  state.dashboard = data;
  renderSummary(data);
  renderPlatforms(data.platforms);
  renderTrend(data);
  renderCategories(data.categories);
  renderHeatmap(data.heatmap);
  renderTables(data);
}

async function loadDashboard() {
  clearNotice();
  try {
    renderDashboard(await api(`/api/dashboard${queryString()}`));
  } catch (error) {
    notice(error.message, true);
  }
}

async function loadMeta() {
  const meta = await api("/api/meta");
  setText("#dbPath", `数据库：${meta.database}`);
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
      messages.push(`${file.name}：新增 ${result.inserted}，更新 ${result.updated}，重复 ${result.unchanged}`);
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

$("#uploadButton").addEventListener("click", () => $("#fileInput").click());
$("#closeTrendDetail").addEventListener("click", closeTrendDetail);
$("#fileInput").addEventListener("change", event => uploadFiles([...event.target.files]));
$("#applyFilters").addEventListener("click", loadDashboard);
$("#granularity").addEventListener("change", loadDashboard);
$("#clearFilters").addEventListener("click", () => {
  $("#startDate").value = "";
  $("#endDate").value = "";
  $("#platformFilter").value = "";
  $("#granularity").value = "month";
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
