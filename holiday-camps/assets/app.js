/* E17 Holiday Camp Planner — app logic.
 * Data: assets/camps.js (verified directory) + assets/planner-data.js (enrichment).
 * All state lives in this browser via localStorage; nothing is sent anywhere.
 */

const D = window.E17_DIRECTORY;
const P = window.E17_PLANNER;

const STORE_KEY = "e17planner.v1";
const CHILD_COLORS = ["var(--child-1)", "var(--child-2)", "var(--child-3)", "var(--child-4)", "var(--child-5)", "var(--child-6)"];

/* ────────────────────────── state ────────────────────────── */

const state = {
  search: "",
  area: "all",
  category: "all",
  funding: "all",
  age: "any",          // "any" | "under5" | "primary" | "teen" | "child:<id>"
  dayLength: "all",
  price: "all",
  confirmedOnly: false,
  sort: "az",
  children: [],         // {id, name, age, color}
  shortlist: [],        // provider ids
  plan: {},             // { [weekId]: { [childId]: {type, campId?, label?} } }
  checks: [],           // checklist item ids
  pickerShowAll: false
};

let pickerCtx = null;   // {mode:"cell", weekId, childId} | {mode:"camp", campId}

/* ────────────────────────── persistence ────────────────────────── */

function saveState() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({
      children: state.children,
      shortlist: state.shortlist,
      plan: state.plan,
      checks: state.checks
    }));
  } catch (e) { /* storage full/blocked — keep going in-memory */ }
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return;
    const data = JSON.parse(raw);
    if (Array.isArray(data.children)) state.children = data.children.filter((c) => c && c.id && Number.isFinite(c.age));
    if (Array.isArray(data.shortlist)) state.shortlist = data.shortlist.filter((id) => providerById(id));
    if (data.plan && typeof data.plan === "object") state.plan = data.plan;
    if (Array.isArray(data.checks)) state.checks = data.checks;
  } catch (e) { /* corrupt store — start fresh */ }
}

/* ────────────────────────── helpers ────────────────────────── */

const normalize = (value) => String(value || "").toLowerCase();

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function uniqueSorted(values) {
  return [...new Set(values.filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

function providerById(id) {
  return D.providers.find((p) => p.id === id) || null;
}

function plannerOf(provider) {
  return (P.byId && P.byId[provider.id]) || {};
}

function money(n) {
  if (n == null || !Number.isFinite(n)) return null;
  const rounded = Math.round(n * 100) / 100;
  return "£" + (Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(2));
}

/* Effective per-day price for sorting/filtering: exact day price first,
 * else a stated week price divided over 5 days (estimate). */
function effectiveDayPrice(provider) {
  const pl = plannerOf(provider);
  const pr = pl.price || {};
  if (Number.isFinite(pr.day)) return { value: pr.day, estimate: false };
  if (pr.weekByWeek) {
    const vals = Object.values(pr.weekByWeek).filter(Number.isFinite);
    if (vals.length) return { value: Math.min(...vals) / 5, estimate: true };
  }
  if (Number.isFinite(pr.week)) return { value: pr.week / 5, estimate: true };
  if (pr.weekBands && pr.weekBands.length) {
    const vals = pr.weekBands.map((b) => b.week).filter(Number.isFinite);
    if (vals.length) return { value: Math.min(...vals) / 5, estimate: true };
  }
  return null;
}

function isHafOnly(provider) {
  return (provider.funding || []).includes("Free/HAF") && !(provider.funding || []).includes("Paid");
}

function hoursSpanMinutes(provider) {
  const h = plannerOf(provider).hours;
  if (!h) return null;
  const toMin = (s) => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(s || "");
    return m ? Number(m[1]) * 60 + Number(m[2]) : null;
  };
  const start = toMin(h.extStart) ?? toMin(h.start);
  const end = toMin(h.extEnd) ?? toMin(h.end);
  if (start == null || end == null) return null;
  return end - start;
}

function hoursLabel(provider) {
  const h = plannerOf(provider).hours;
  if (!h) return provider.hours || "Check hours";
  let label = `${h.start}–${h.end}`;
  if (h.extStart || h.extEnd) label += ` (ext ${h.extStart || h.start}–${h.extEnd || h.end})`;
  return label;
}

function coverageLabel(provider) {
  const c = plannerOf(provider).coverage;
  if (c === "working") return "Working-day friendly";
  if (c === "standard") return "Standard day";
  if (c === "short") return "Short / half day";
  return "Hours vary — check";
}

function mapLink(provider) {
  const addr = `${provider.venue || ""} ${provider.address || ""}`;
  if (/vary|varies|check|borough|multiple|sites|mobile|wide/i.test(addr)) return null;
  const q = encodeURIComponent(`${provider.venue}, ${provider.address}`);
  return `https://www.google.com/maps/search/?api=1&query=${q}`;
}

function weekById(id) {
  return P.weeks.find((w) => w.id === Number(id)) || null;
}

const DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri"];

/* Which weekdays a provider actually runs in a given week (drives the day toggles). */
function allowedDaysFor(provider, weekId) {
  const pl = plannerOf(provider);
  if (pl.fridaysOnly) return [5];
  const n = pl.daysPerWeek && pl.daysPerWeek[String(weekId)];
  if (n) return [1, 2, 3, 4, 5].slice(0, n);
  const wk = weekById(weekId);
  if (wk && wk.stub) return [1, 2, 3, 4, 5].slice(0, wk.days);
  return [1, 2, 3, 4, 5];
}

/* Resolve an entry's selected days: explicit selection, else the full pattern. */
function entryDays(entry, weekId) {
  if (entry.type === "camp") {
    const p = providerById(entry.campId);
    const allowed = p ? allowedDaysFor(p, weekId) : [1, 2, 3, 4, 5];
    const sel = Array.isArray(entry.days) && entry.days.length
      ? entry.days.filter((d) => allowed.includes(d))
      : allowed;
    return { days: sel.length ? sel : allowed, allowed, isDefault: !(Array.isArray(entry.days) && entry.days.length) };
  }
  const allowed = [1, 2, 3, 4, 5];
  const sel = Array.isArray(entry.days) && entry.days.length ? entry.days : allowed;
  return { days: sel, allowed, isDefault: !(Array.isArray(entry.days) && entry.days.length) };
}

/* Cost of one provider for one planner week.
 * Returns {value, estimate, label, basis} or null when unpriced. */
function weekCost(provider, weekId) {
  const pl = plannerOf(provider);
  const wk = weekById(weekId);
  if (!wk) return null;
  if (isHafOnly(provider)) return { value: 0, estimate: false, label: "Free (HAF, if eligible)" };
  const pr = pl.price || {};
  const days = (pl.daysPerWeek && pl.daysPerWeek[String(weekId)]) || (wk.stub ? wk.days : 5);

  if (pr.weekByWeek && Number.isFinite(pr.weekByWeek[String(weekId)])) {
    return { value: pr.weekByWeek[String(weekId)], estimate: false, label: "listed week price" };
  }
  if (pr.weekBands && pr.weekBands.length) {
    const min = Math.min(...pr.weekBands.map((b) => b.week).filter(Number.isFinite));
    if (Number.isFinite(min)) return { value: min, estimate: true, label: "from (per age band)" };
  }
  if (Number.isFinite(pr.week)) {
    return { value: pr.week, estimate: false, label: pl.priceStale ? `week price (${pl.priceStale})` : "listed week price" };
  }
  if (Number.isFinite(pr.day)) {
    const v = pr.day * days;
    return {
      value: v,
      estimate: true,
      label: `${money(pr.day)} × ${days} day${days === 1 ? "" : "s"}${pl.priceStale ? ` (${pl.priceStale})` : ""}`
    };
  }
  return null;
}

function ageFits(provider, age) {
  return Number.isFinite(provider.ageMin) && Number.isFinite(provider.ageMax)
    ? age >= provider.ageMin && age <= provider.ageMax
    : true;
}

function childById(id) {
  return state.children.find((c) => c.id === id) || null;
}

function assignmentLabel(entry) {
  if (!entry) return null;
  if (entry.type === "camp") {
    const p = providerById(entry.campId);
    return p ? p.name : "Unknown camp — tap to fix";
  }
  if (entry.type === "leave") return "Annual leave";
  if (entry.type === "family") return "Family / grandparents";
  if (entry.type === "swap") return "Friend / childcare swap";
  return entry.label || "Other";
}

/* ────────────────────────── element handles ────────────────────────── */

const els = {
  providerGrid: document.querySelector("#providerGrid"),
  hafTable: document.querySelector("#hafTable"),
  sourceGrid: document.querySelector("#sourceGrid"),
  searchInput: document.querySelector("#searchInput"),
  areaFilter: document.querySelector("#areaFilter"),
  categoryFilter: document.querySelector("#categoryFilter"),
  fundingFilter: document.querySelector("#fundingFilter"),
  dayLengthFilter: document.querySelector("#dayLengthFilter"),
  priceFilter: document.querySelector("#priceFilter"),
  sortSelect: document.querySelector("#sortSelect"),
  confirmedOnly: document.querySelector("#confirmedOnly"),
  resultCount: document.querySelector("#resultCount"),
  emptyState: document.querySelector("#emptyState"),
  childForm: document.querySelector("#childForm"),
  childName: document.querySelector("#childName"),
  childAge: document.querySelector("#childAge"),
  childChips: document.querySelector("#childChips"),
  childAgeChips: document.querySelector("#childAgeChips"),
  compareWrap: document.querySelector("#compareWrap"),
  compareTable: document.querySelector("#compareTable"),
  compareCount: document.querySelector("#compareCount"),
  compareHint: document.querySelector("#compareHint"),
  plannerWrap: document.querySelector("#plannerWrap"),
  plannerTable: document.querySelector("#plannerTable"),
  plannerEmpty: document.querySelector("#plannerEmpty"),
  budgetBand: document.querySelector("#budgetBand"),
  budgetCards: document.querySelector("#budgetCards"),
  budgetNotes: document.querySelector("#budgetNotes"),
  checklistList: document.querySelector("#checklistList"),
  checklistCount: document.querySelector("#checklistCount"),
  pickerDialog: document.querySelector("#pickerDialog"),
  pickerTitle: document.querySelector("#pickerTitle"),
  pickerSub: document.querySelector("#pickerSub"),
  pickerBody: document.querySelector("#pickerBody"),
  pickerClose: document.querySelector("#pickerClose"),
  hafProviderCount: document.querySelector("#hafProviderCount"),
  tfcProviderCount: document.querySelector("#tfcProviderCount"),
  siblingProviderCount: document.querySelector("#siblingProviderCount")
};

/* ────────────────────────── filtering ────────────────────────── */

function ageMatches(item) {
  if (state.age === "any") return true;
  if (state.age.startsWith("child:")) {
    const child = childById(state.age.slice(6));
    if (!child) return true;
    return item.ageMin <= child.age && item.ageMax >= child.age;
  }
  if (state.age === "under5") return item.ageMin <= 4;
  if (state.age === "primary") return item.ageMin <= 11 && item.ageMax >= 5;
  if (state.age === "teen") return item.ageMax >= 12;
  return true;
}

function textMatches(item) {
  if (!state.search) return true;
  const haystack = normalize([
    item.name, item.kind, item.area, item.venue, item.address,
    item.ageLabel || item.ages, item.summary, item.goodFor,
    ...(item.categories || []), ...(item.funding || [])
  ].join(" "));
  return haystack.includes(normalize(state.search));
}

function dayLengthMatches(provider) {
  if (state.dayLength === "all") return true;
  return plannerOf(provider).coverage === state.dayLength;
}

function priceMatches(provider) {
  if (state.price === "all") return true;
  if (state.price === "free") return (provider.funding || []).includes("Free/HAF");
  const eff = effectiveDayPrice(provider);
  if (state.price === "unpriced") return !eff && !isHafOnly(provider);
  if (!eff) return false;
  if (state.price === "under40") return eff.value < 40;
  if (state.price === "40to60") return eff.value >= 40 && eff.value <= 60;
  if (state.price === "over60") return eff.value > 60;
  return true;
}

function providerMatches(provider) {
  const areaOk = state.area === "all" || provider.areas.includes(state.area);
  const categoryOk = state.category === "all" || provider.categories.includes(state.category);
  const fundingOk = state.funding === "all" || provider.funding.includes(state.funding);
  const confirmedOk = !state.confirmedOnly || (plannerOf(provider).weeks || []).length > 0;
  return areaOk && categoryOk && fundingOk && confirmedOk &&
    dayLengthMatches(provider) && priceMatches(provider) &&
    ageMatches(provider) && textMatches(provider);
}

function sortProviders(list) {
  const byName = (a, b) => a.name.localeCompare(b.name);
  if (state.sort === "price") {
    return list.sort((a, b) => {
      const ea = effectiveDayPrice(a); const eb = effectiveDayPrice(b);
      const va = isHafOnly(a) ? 0 : (ea ? ea.value : Infinity);
      const vb = isHafOnly(b) ? 0 : (eb ? eb.value : Infinity);
      return va - vb || byName(a, b);
    });
  }
  if (state.sort === "hours") {
    return list.sort((a, b) => (hoursSpanMinutes(b) ?? -1) - (hoursSpanMinutes(a) ?? -1) || byName(a, b));
  }
  if (state.sort === "confirmed") {
    return list.sort((a, b) =>
      ((plannerOf(b).weeks || []).length - (plannerOf(a).weeks || []).length) || byName(a, b));
  }
  return list.sort(byName);
}

/* ────────────────────────── directory cards ────────────────────────── */

function badgeRow(provider) {
  const pl = plannerOf(provider);
  const f = provider.funding || [];
  const badges = [];
  const wk = pl.weeks || [];
  if (wk.length) {
    badges.push(`<span class="badge badge-confirmed">2026 dates ✓ wk ${wk.filter((w) => w <= 6).join("·")}</span>`);
  } else if (pl.sessionBased) {
    badges.push(`<span class="badge badge-tbc">Session-based</span>`);
  } else {
    badges.push(`<span class="badge badge-tbc">Summer dates TBC</span>`);
  }
  if (f.includes("Free/HAF")) badges.push(`<span class="badge badge-haf">HAF free places</span>`);
  if (f.includes("Tax-Free Childcare")) badges.push(`<span class="badge badge-tfc">Tax-Free Childcare</span>`);
  else if (f.includes("Childcare vouchers")) badges.push(`<span class="badge badge-tfc">Vouchers</span>`);
  if (pl.ofsted) badges.push(`<span class="badge badge-ofsted">Ofsted-registered</span>`);
  if (f.includes("Sibling discount")) badges.push(`<span class="badge badge-sibling">Sibling discount</span>`);
  if ((provider.categories || []).includes("SEND aware") || pl.sendAware) badges.push(`<span class="badge badge-send">SEND aware</span>`);
  if (pl.lunch && pl.lunch.policy === "included") badges.push(`<span class="badge badge-food">Meals included</span>`);
  if (pl.fridaysOnly) badges.push(`<span class="badge badge-tbc">Fridays only</span>`);
  return badges.join("");
}

function priceFact(provider) {
  const pl = plannerOf(provider);
  const pr = pl.price || {};
  if (isHafOnly(provider)) return "Free (HAF, if eligible)";
  const bits = [];
  if (Number.isFinite(pr.day)) bits.push(`${money(pr.day)}/day`);
  if (Number.isFinite(pr.dayExtended)) bits.push(`${money(pr.dayExtended)}/ext day`);
  if (Number.isFinite(pr.week)) bits.push(`${money(pr.week)}/wk`);
  if (pr.weekByWeek) {
    const vals = Object.values(pr.weekByWeek).filter(Number.isFinite);
    if (vals.length) bits.push(vals.map(money).join("–") + "/wk");
  }
  if (pr.weekBands) bits.push(pr.weekBands.map((b) => money(b.week)).join("–") + "/wk");
  if (Number.isFinite(pr.sessionFrom)) bits.push(`${money(pr.sessionFrom)}–${money(pr.sessionTo)}/session`);
  if (!bits.length) return "Not published — check";
  return bits.join(" · ") + (pl.priceStale ? " ⚠" : "");
}

function weeksFact(provider) {
  const pl = plannerOf(provider);
  const wk = (pl.weeks || []).filter((w) => w <= 6);
  if (wk.length === 6) return pl.fridaysOnly ? "All 6 weeks (Fridays)" : "All 6 weeks";
  if (wk.length) return "Weeks " + wk.join(", ");
  if (pl.sessionBased) return "Selected dates";
  if (pl.weeksLikely) return "Likely — confirm";
  return "Check provider";
}

function sourceLinks(provider) {
  const sources = [provider.source, ...(provider.secondarySources || [])];
  return sources
    .map((s) => `<a class="source-link" href="${escapeHtml(s.url)}" target="_blank" rel="noreferrer">${escapeHtml(s.label)} ↗</a>`)
    .join("");
}

function renderProviders() {
  const matches = sortProviders(D.providers.filter(providerMatches));
  els.resultCount.textContent = `${matches.length} of ${D.providers.length} shown`;
  els.emptyState.hidden = matches.length > 0;

  els.providerGrid.innerHTML = matches.map((provider, i) => {
    const pl = plannerOf(provider);
    const shortlisted = state.shortlist.includes(provider.id);
    const map = mapLink(provider);
    const stalePrice = pl.priceStale
      ? `<p class="provenance">⚠ Price is from the ${escapeHtml(pl.priceStale)} — use as a guide and confirm the summer rate.</p>`
      : "";
    const reconfirm = pl.reconfirm
      ? `<p class="provenance">⚠ Reconfirm dates with the provider before booking — see basis below.</p>`
      : "";
    return `
      <article class="camp-card ${shortlisted ? "is-shortlisted" : ""}" style="--i:${i}">
        <div class="card-topline">
          <span class="kind">${escapeHtml(provider.kind)}</span>
          <button class="heart-btn ${shortlisted ? "is-on" : ""}" type="button"
            data-shortlist="${escapeHtml(provider.id)}"
            aria-pressed="${shortlisted}"
            aria-label="${shortlisted ? "Remove from" : "Add to"} shortlist: ${escapeHtml(provider.name)}">♥</button>
        </div>
        <h3>${escapeHtml(provider.name)}</h3>
        <p class="venue">${escapeHtml(provider.venue)}${map ? ` · <a href="${map}" target="_blank" rel="noreferrer">map ↗</a>` : ""}</p>
        <div class="badge-row">${badgeRow(provider)}</div>
        <div class="quick-facts">
          <span><strong>Ages</strong>${escapeHtml(provider.ageLabel)}</span>
          <span><strong>Hours</strong>${escapeHtml(hoursLabel(provider))}</span>
          <span class="fact-price"><strong>Cost</strong>${escapeHtml(priceFact(provider))}</span>
          <span><strong>Summer weeks</strong>${escapeHtml(weeksFact(provider))}</span>
        </div>
        <p class="summary">${escapeHtml(provider.summary)}</p>
        <p class="good-for"><strong>Best for:</strong> ${escapeHtml(provider.goodFor)}</p>
        <details class="card-details">
          <summary>Details, dates &amp; where this info comes from</summary>
          <div class="card-details-body">
            <p><strong>Day length:</strong> ${escapeHtml(coverageLabel(provider))} (${escapeHtml(provider.hours)})</p>
            <p><strong>How to book:</strong> ${escapeHtml(provider.booking)}</p>
            ${pl.weeksBasis ? `<p><strong>2026 dates:</strong> ${escapeHtml(pl.weeksBasis)}</p>` : ""}
            ${pl.priceBasis ? `<p><strong>Pricing:</strong> ${escapeHtml(pl.priceBasis)}</p>` : ""}
            ${pl.lunch ? `<p><strong>Food:</strong> ${escapeHtml(pl.lunch.note)}</p>` : ""}
            ${stalePrice}${reconfirm}
            <p class="provenance">Verified against the sources below on ${escapeHtml(D.updated)} (${escapeHtml(provider.confidence)}).</p>
            <div class="source-row">${sourceLinks(provider)}</div>
          </div>
        </details>
        <div class="card-actions">
          <button class="btn btn-add" type="button" data-addplan="${escapeHtml(provider.id)}">+ Add to plan</button>
          <a class="btn btn-book" href="${escapeHtml(provider.source.url)}" target="_blank" rel="noreferrer">Book ↗</a>
        </div>
      </article>
    `;
  }).join("");
}

/* ────────────────────────── compare ────────────────────────── */

const COMPARE_ROWS = [
  { label: "Ages", get: (p) => p.ageLabel },
  { label: "Hours", get: (p) => hoursLabel(p) },
  { label: "Day length", get: (p) => coverageLabel(p) },
  { label: "Cost", get: (p) => priceFact(p) },
  { label: "Summer 2026 weeks", get: (p) => weeksFact(p) },
  { label: "Food", get: (p) => (plannerOf(p).lunch ? plannerOf(p).lunch.note : "Ask provider") },
  { label: "Funding & discounts", get: (p) => (p.funding || []).join(", ") },
  { label: "Venue", get: (p) => p.venue },
  { label: "Area", get: (p) => p.area }
];

function renderCompare() {
  const items = state.shortlist.map(providerById).filter(Boolean);
  els.compareCount.textContent = items.length ? `${items.length} shortlisted` : "";
  els.compareHint.hidden = items.length > 0;
  els.compareWrap.hidden = items.length === 0;
  if (!items.length) { els.compareTable.innerHTML = ""; return; }

  const head = `<thead><tr><th></th>${items.map((p) => `
    <th>
      <span class="compare-name">${escapeHtml(p.name)}</span><br>
      <button class="compare-remove" type="button" data-shortlist="${escapeHtml(p.id)}">remove</button>
    </th>`).join("")}</tr></thead>`;

  const body = `<tbody>${COMPARE_ROWS.map((row) => `
    <tr>
      <th scope="row">${escapeHtml(row.label)}</th>
      ${items.map((p) => `<td>${escapeHtml(row.get(p) || "—")}</td>`).join("")}
    </tr>`).join("")}
    <tr>
      <th scope="row">Book</th>
      ${items.map((p) => `<td><a class="source-link" href="${escapeHtml(p.source.url)}" target="_blank" rel="noreferrer">Open booking ↗</a></td>`).join("")}
    </tr>
  </tbody>`;

  els.compareTable.innerHTML = head + body;
}

/* ────────────────────────── children ────────────────────────── */

function renderChildren() {
  els.childChips.innerHTML = state.children.map((c) => `
    <span class="child-chip">
      <span class="child-dot" style="background:${c.color}"></span>
      ${escapeHtml(c.name)} <small>· age ${c.age}</small>
      <button class="child-remove" type="button" data-removechild="${escapeHtml(c.id)}"
        aria-label="Remove ${escapeHtml(c.name)}">×</button>
    </span>
  `).join("");

  els.childAgeChips.innerHTML = state.children.map((c) => `
    <button class="age-chip is-child ${state.age === "child:" + c.id ? "is-active" : ""}"
      type="button" data-age="child:${escapeHtml(c.id)}">
      Fits ${escapeHtml(c.name)} (${c.age})
    </button>
  `).join("");
  bindAgeChips();
}

function addChild(name, age) {
  const id = "c" + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36);
  const color = CHILD_COLORS[state.children.length % CHILD_COLORS.length];
  state.children.push({ id, name: name || `Child ${state.children.length + 1}`, age, color });
  saveState();
  renderChildren();
  renderPlanner();
}

function removeChild(id) {
  state.children = state.children.filter((c) => c.id !== id);
  Object.values(state.plan).forEach((week) => { delete week[id]; });
  if (state.age === "child:" + id) state.age = "any";
  saveState();
  renderChildren();
  renderPlanner();
  applyFilters();
}

/* ────────────────────────── planner grid ────────────────────────── */

function planEntry(weekId, childId) {
  return (state.plan[weekId] && state.plan[weekId][childId]) || null;
}

function setPlanEntry(weekId, childId, entry) {
  if (!state.plan[weekId]) state.plan[weekId] = {};
  if (entry) state.plan[weekId][childId] = entry;
  else delete state.plan[weekId][childId];
  saveState();
  renderPlanner();
}

function entryCost(entry, weekId) {
  if (!entry) return null;
  if (entry.type !== "camp") {
    const base = Number.isFinite(entry.cost) ? entry.cost : 0;
    if (entry.costBasis === "day") {
      const n = entryDays(entry, weekId).days.length;
      return { value: Math.round(base * n * 100) / 100, estimate: false, label: `${money(base)} × ${n} day${n === 1 ? "" : "s"}` };
    }
    return { value: base, estimate: false, label: base ? "your own figure" : "no camp cost" };
  }
  const p = providerById(entry.campId);
  if (!p) return null;
  // Part-week selection: price by day rate where one is published.
  if (Array.isArray(entry.days) && entry.days.length) {
    const info = entryDays(entry, weekId);
    if (info.days.length < info.allowed.length) {
      if (isHafOnly(p)) return { value: 0, estimate: false, label: "Free (HAF, if eligible)" };
      const pr = plannerOf(p).price || {};
      if (Number.isFinite(pr.day)) {
        const v = pr.day * info.days.length;
        return { value: v, estimate: true, label: `${money(pr.day)} × ${info.days.length} day${info.days.length === 1 ? "" : "s"}` };
      }
      return null; // only a week price is published — part-week cost unknown
    }
  }
  return weekCost(p, weekId);
}

function entryMeta(entry, weekId) {
  if (!entry) return "";
  const bits = [];
  if (entry.type === "camp") {
    const p = providerById(entry.campId);
    if (!p) return "";
    const pl = plannerOf(p);
    const info = entryDays(entry, weekId);
    if (!info.isDefault && info.days.length < info.allowed.length) {
      bits.push(info.days.map((d) => DAY_LABELS[d - 1]).join(" "));
    } else if (pl.fridaysOnly) bits.push("Friday only");
    else if (pl.daysPerWeek && pl.daysPerWeek[String(weekId)]) bits.push(`${pl.daysPerWeek[String(weekId)]} days`);
    if (pl.weeks && !pl.weeks.includes(Number(weekId))) bits.push("⚠ dates unconfirmed");
    else if (pl.weeksLikely && !(pl.weeks || []).length) bits.push("⚠ confirm dates");
  } else if (entry.costBasis === "day" && Array.isArray(entry.days) && entry.days.length < 5) {
    bits.push(entry.days.map((d) => DAY_LABELS[d - 1]).join(" "));
  }
  return bits.join(" · ");
}

function renderPlanner() {
  const hasChildren = state.children.length > 0;
  els.plannerEmpty.hidden = hasChildren;
  els.plannerWrap.hidden = !hasChildren;
  els.budgetBand.hidden = !hasChildren;
  if (!hasChildren) return;

  const head = `<thead><tr>
    <th scope="col">Week</th>
    ${state.children.map((c) => `<th scope="col"><span class="child-dot" style="background:${c.color}"></span>${escapeHtml(c.name)} (${c.age})</th>`).join("")}
    <th scope="col">Week total</th>
  </tr></thead>`;

  const rows = P.weeks.map((wk) => {
    let weekTotal = 0;
    let weekUnknown = 0;
    const cells = state.children.map((c) => {
      const entry = planEntry(wk.id, c.id);
      const cost = entryCost(entry, wk.id);
      if (entry) {
        if (cost && cost.value != null) weekTotal += cost.value;
        else if (entry.type === "camp") weekUnknown += 1;
      }
      const label = assignmentLabel(entry);
      const meta = entryMeta(entry, wk.id);
      const costText = entry
        ? (cost ? `${money(cost.value)}${cost.estimate ? " est." : ""}` : "£? — confirm")
        : "";
      return `<td class="plan-cell">
        <button class="assign-btn ${entry ? "is-set" : ""}" type="button"
          data-week="${wk.id}" data-child="${escapeHtml(c.id)}"
          style="--cc:${c.color}"
          aria-label="Week ${wk.id}, ${escapeHtml(c.name)}: ${entry ? escapeHtml(label) : "choose cover"}">
          ${entry
            ? `<span class="assign-name">${escapeHtml(label)}</span>
               ${meta ? `<span class="assign-meta">${escapeHtml(meta)}</span>` : ""}
               <span class="assign-cost ${cost || entry.type !== "camp" ? "" : "is-unknown"}">${escapeHtml(costText)}</span>`
            : `<span>+ Choose</span>`}
        </button>
      </td>`;
    }).join("");

    const totalText = weekUnknown
      ? `${money(weekTotal)} + ${weekUnknown}×£?`
      : money(weekTotal);
    return `<tr class="${wk.stub ? "stub-row" : ""}">
      <td class="week-cell">
        <span class="week-name">${escapeHtml(wk.label)}</span>
        <span class="week-dates">${escapeHtml(wk.dates)}</span>
        ${wk.note ? `<span class="week-flag" title="${escapeHtml(wk.note)}">${wk.stub ? "ℹ mostly covered" : "ℹ part week for many"}</span>` : ""}
      </td>
      ${cells}
      <td class="row-total">${escapeHtml(totalText || "£0")}</td>
    </tr>`;
  }).join("");

  els.plannerTable.innerHTML = head + `<tbody>${rows}</tbody>`;
  renderBudget();
}

/* ────────────────────────── budget ────────────────────────── */

function renderBudget() {
  const perChild = {};
  let grand = 0;
  let unknownCount = 0;
  let tfcEligibleSpend = 0;
  const staleUsed = new Set();
  const uncovered = {};
  const siblingHints = [];

  state.children.forEach((c) => { perChild[c.id] = 0; uncovered[c.id] = []; });

  P.weeks.forEach((wk) => {
    const sameWeekCamps = {};
    state.children.forEach((c) => {
      const entry = planEntry(wk.id, c.id);
      if (!entry) {
        if (!wk.stub) uncovered[c.id].push(wk.id);
        return;
      }
      if (entry.type !== "camp") {
        const cc = entryCost(entry, wk.id);
        const v = cc && Number.isFinite(cc.value) ? cc.value : 0;
        perChild[c.id] += v;
        grand += v;
        return;
      }
      const p = providerById(entry.campId);
      const cost = entryCost(entry, wk.id);
      if (cost && cost.value != null) {
        perChild[c.id] += cost.value;
        grand += cost.value;
        if (p) {
          const pl = plannerOf(p);
          if (pl.tfc || pl.vouchers) tfcEligibleSpend += cost.value;
          if (pl.priceStale) staleUsed.add(`${p.name} (${pl.priceStale})`);
        }
      } else {
        unknownCount += 1;
      }
      if (p) {
        sameWeekCamps[p.id] = (sameWeekCamps[p.id] || 0) + 1;
      }
    });
    Object.entries(sameWeekCamps).forEach(([pid, n]) => {
      const p = providerById(pid);
      if (n >= 2 && p && (p.funding || []).includes("Sibling discount")) {
        siblingHints.push(`${p.name} (${wk.label})`);
      }
    });
  });

  const cards = [
    ...state.children.map((c) => `
      <div class="budget-card">
        <span class="budget-label"><span class="child-dot" style="background:${c.color};display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:5px"></span>${escapeHtml(c.name)}</span>
        <span class="budget-value">${money(perChild[c.id])}</span>
        <span class="budget-sub">${uncovered[c.id].length ? `${uncovered[c.id].length} week${uncovered[c.id].length === 1 ? "" : "s"} not covered yet` : "all 6 weeks covered ✓"}</span>
      </div>`),
    `<div class="budget-card grand">
      <span class="budget-label">Whole summer</span>
      <span class="budget-value">${money(grand)}${unknownCount ? " +" : ""}</span>
      <span class="budget-sub">${unknownCount ? `${unknownCount} booking${unknownCount === 1 ? "" : "s"} still “£?” — confirm prices` : "all priced bookings included"}</span>
    </div>`
  ];
  els.budgetCards.innerHTML = cards.join("");

  const notes = [];
  const uncoveredMsgs = state.children
    .filter((c) => uncovered[c.id].length)
    .map((c) => `${c.name}: week${uncovered[c.id].length === 1 ? "" : "s"} ${uncovered[c.id].join(", ")}`);
  if (uncoveredMsgs.length) {
    notes.push(`<div class="budget-note warn"><strong>Gaps to fill:</strong> ${escapeHtml(uncoveredMsgs.join(" · "))}. Tap those cells to choose camps, leave or family cover.</div>`);
  }
  if (tfcEligibleSpend > 0) {
    const saving = tfcEligibleSpend * 0.2;
    notes.push(`<div class="budget-note save"><strong>Tax-Free Childcare:</strong> ${money(tfcEligibleSpend)} of your plan is with providers that take TFC or vouchers — paying through a TFC account could be worth roughly ${money(saving)} in government top-up (20p per 80p, caps apply, provider must confirm registration).</div>`);
  }
  if (siblingHints.length) {
    notes.push(`<div class="budget-note save"><strong>Sibling discount:</strong> you've got two children at ${escapeHtml(siblingHints.join("; "))} — ask for the sibling rate when booking.</div>`);
  }
  if (staleUsed.size) {
    notes.push(`<div class="budget-note warn"><strong>Guide prices used:</strong> ${escapeHtml([...staleUsed].join("; "))} — these are from earlier holidays, so confirm the summer rate.</div>`);
  }
  if (!notes.length && grand > 0) {
    notes.push(`<div class="budget-note">Prices are as published on 9 June 2026 — re-check when booking. “est.” totals multiply a day rate by the days in that week.</div>`);
  }
  els.budgetNotes.innerHTML = notes.join("");
}

/* ────────────────────────── picker dialog ────────────────────────── */

function openCellPicker(weekId, childId) {
  pickerCtx = { mode: "cell", weekId: Number(weekId), childId };
  state.pickerShowAll = false;
  renderPicker();
  els.pickerDialog.showModal();
}

function openCampAssign(campId) {
  if (!state.children.length) {
    document.querySelector("#children").scrollIntoView({ behavior: "smooth" });
    els.childName.focus();
    return;
  }
  pickerCtx = { mode: "camp", campId };
  renderPicker();
  els.pickerDialog.showModal();
}

function pickerOptionHtml(provider, weekId, opts = {}) {
  const pl = plannerOf(provider);
  const cost = weekCost(provider, weekId);
  const costText = isHafOnly(provider)
    ? "Free*"
    : cost ? `${money(cost.value)}${cost.estimate ? " est." : ""}` : "£?";
  const warns = [];
  if (opts.unconfirmed) warns.push("Runs in summer — exact weeks unconfirmed, check before relying on it");
  if (pl.reconfirm) warns.push("Reconfirm dates with provider");
  if (pl.fridaysOnly) warns.push("Friday only — covers one day of this week");
  if (pl.priceStale) warns.push(`Price from ${pl.priceStale}`);
  if (opts.ageWarn) warns.push(`Listed ages ${provider.ageLabel} — outside this child's age`);
  return `
    <button class="picker-option ${opts.current ? "is-current" : ""}" type="button"
      data-pick-camp="${escapeHtml(provider.id)}">
      <span class="po-name">${escapeHtml(provider.name)}</span>
      <span class="po-cost">${escapeHtml(costText)}</span>
      <span class="po-meta">${escapeHtml(provider.ageLabel)} · ${escapeHtml(hoursLabel(provider))} · ${escapeHtml(provider.area)}</span>
      ${warns.length ? `<span class="po-warn">⚠ ${escapeHtml(warns.join(" · "))}</span>` : ""}
    </button>`;
}

function renderPicker() {
  if (!pickerCtx) return;

  if (pickerCtx.mode === "camp") {
    const provider = providerById(pickerCtx.campId);
    if (!provider) return;
    const pl = plannerOf(provider);
    els.pickerTitle.textContent = provider.name;
    els.pickerSub.textContent = "Pick the weeks to add — solid buttons are provider-confirmed 2026 weeks.";
    els.pickerBody.innerHTML = state.children.map((c) => {
      const fits = ageFits(provider, c.age);
      return `<div>
        <p class="picker-group-title"><span class="child-dot" style="background:${c.color};display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:5px"></span>${escapeHtml(c.name)} (${c.age})${fits ? "" : " — ⚠ outside listed ages " + escapeHtml(provider.ageLabel)}</p>
        <div class="age-row" style="margin:0 6px 6px">
          ${P.weeks.filter((w) => !w.stub).map((w) => {
            const confirmed = (pl.weeks || []).includes(w.id);
            const current = planEntry(w.id, c.id);
            const isThis = current && current.type === "camp" && current.campId === provider.id;
            return `<button class="age-chip ${isThis ? "is-active" : ""}" type="button"
              ${confirmed ? "" : 'style="border-style:dashed"'}
              data-assign-week="${w.id}" data-assign-child="${escapeHtml(c.id)}"
              title="${escapeHtml(w.dates)}${confirmed ? "" : " — dates unconfirmed for this provider"}">
              ${isThis ? "✓ " : ""}Wk ${w.id}
            </button>`;
          }).join("")}
        </div>
      </div>`;
    }).join("") + `<p class="picker-note">Tap a week to add or remove it. Dashed weeks mean the provider hasn't published dates for that week — confirm before counting on it.</p>`;
    return;
  }

  // cell mode
  const wk = weekById(pickerCtx.weekId);
  const child = childById(pickerCtx.childId);
  if (!wk || !child) return;
  const current = planEntry(wk.id, child.id);

  els.pickerTitle.textContent = `${wk.label} · ${wk.dates}`;
  els.pickerSub.textContent = `Cover for ${child.name} (age ${child.age})${wk.note ? " — " + wk.note : ""}`;

  const fits = (p) => ageFits(p, child.age);
  const confirmed = [];
  const likely = [];
  const sessions = [];
  const hafOnly = [];

  D.providers.forEach((p) => {
    const pl = plannerOf(p);
    if (pl.plannerRole === "route") return;
    const fit = fits(p);
    if (!fit && !state.pickerShowAll) return;
    const target = isHafOnly(p) ? hafOnly
      : (pl.weeks || []).includes(wk.id) ? confirmed
      : pl.sessionBased ? sessions
      : pl.weeksLikely ? likely
      : null;
    if (target) target.push({ p, ageWarn: !fit });
  });

  const sortByCost = (arr) => arr.sort((a, b) => {
    const ca = weekCost(a.p, wk.id); const cb = weekCost(b.p, wk.id);
    return (ca ? ca.value : Infinity) - (cb ? cb.value : Infinity) || a.p.name.localeCompare(b.p.name);
  });

  const group = (title, arr, opts = {}) => arr.length
    ? `<p class="picker-group-title">${escapeHtml(title)}</p>` +
      sortByCost(arr).map(({ p, ageWarn }) => pickerOptionHtml(p, wk.id, {
        ...opts, ageWarn,
        current: current && current.type === "camp" && current.campId === p.id
      })).join("")
    : "";

  const customs = [
    { type: "leave", label: "Annual leave — I'm off that week" },
    { type: "family", label: "Family / grandparents cover" },
    { type: "swap", label: "Friend or childcare swap" }
  ].map((c) => `
    <button class="picker-option is-custom" type="button" data-pick-custom="${c.type}">
      <span class="po-name">${escapeHtml(c.label)}</span>
      <span class="po-cost">£0</span>
    </button>`).join("");

  // Day editor for the current assignment (camps, and custom camps priced per day).
  const dayEditor = (() => {
    if (!current) return "";
    if (current.type !== "camp" && current.costBasis !== "day") return "";
    const info = entryDays(current, wk.id);
    const cost = entryCost(current, wk.id);
    return `<div class="day-editor">
      <span class="day-editor-label">Days:</span>
      ${[1, 2, 3, 4, 5].map((d) => `
        <button type="button" class="day-chip ${info.days.includes(d) ? "is-on" : ""}"
          data-day-toggle="${d}" ${info.allowed.includes(d) ? "" : "disabled"}>${DAY_LABELS[d - 1]}</button>`).join("")}
      <span class="day-editor-cost">${cost ? money(cost.value) + (cost.estimate ? " est." : "") : "£? — no day rate published, ask provider"}</span>
    </div>`;
  })();

  const cur = current && current.type === "other" ? current : null;
  const curDays = cur && Array.isArray(cur.days) && cur.days.length ? cur.days : [1, 2, 3, 4, 5];
  const customCampForm = `
    <p class="picker-group-title">Camp not in this list? Add your own</p>
    <div class="custom-camp-form">
      <label class="field"><span>Camp name</span>
        <input type="text" id="customCampName" maxlength="34"
          placeholder="e.g. Vestry holiday club"
          value="${cur ? escapeHtml(cur.label || "") : ""}"></label>
      <label class="field"><span>Cost (£)</span>
        <input type="number" id="customCampCost" min="0" step="0.01" inputmode="decimal"
          placeholder="0"
          value="${cur && Number.isFinite(cur.cost) && cur.cost ? cur.cost : ""}"></label>
      <label class="field"><span>That's the price…</span>
        <select id="customCampBasis">
          <option value="week" ${cur && cur.costBasis === "day" ? "" : "selected"}>for the week</option>
          <option value="day" ${cur && cur.costBasis === "day" ? "selected" : ""}>per day</option>
        </select></label>
      <button class="btn btn-add" type="button" data-pick-customcamp="1">${cur ? "Save changes" : "Add to this week"}</button>
    </div>
    <div class="custom-days">
      <span class="day-editor-label">Days:</span>
      ${[1, 2, 3, 4, 5].map((d) => `
        <button type="button" class="day-chip ${curDays.includes(d) ? "is-on" : ""}" data-form-day="${d}">${DAY_LABELS[d - 1]}</button>`).join("")}
    </div>
    <p class="picker-note">Goes straight into your totals like any other camp. Pick the days, and if you only know the day rate choose "per day" — it multiplies up for you.</p>`;

  els.pickerBody.innerHTML = [
    current ? `<button class="picker-remove" type="button" data-pick-remove="1">Remove “${escapeHtml(assignmentLabel(current))}” from this week</button>` : "",
    dayEditor,
    wk.stub ? `<p class="picker-note">ℹ ${escapeHtml(wk.note)}</p>` : "",
    group("Confirmed for this week", confirmed),
    group("Runs in summer — confirm exact dates", likely, { unconfirmed: true }),
    group("Workshops & sessions (part-week)", sessions, { unconfirmed: true }),
    group("Free HAF camps (benefits-related FSM)", hafOnly, { unconfirmed: true }),
    hafOnly.length ? `<p class="picker-note">*HAF places are free for eligible children and include food — book via the <a href="https://eequ.org/hafwalthamforest" target="_blank" rel="noreferrer">Eequ feed</a> when summer sessions open.</p>` : "",
    customCampForm,
    `<p class="picker-group-title">Not a camp</p>`,
    customs,
    `<label class="toggle-chip" style="margin:10px 6px 0">
      <input type="checkbox" id="pickerShowAll" ${state.pickerShowAll ? "checked" : ""}>
      <span>Show camps outside ${escapeHtml(child.name)}'s age range</span>
    </label>`
  ].join("");

  const showAll = els.pickerBody.querySelector("#pickerShowAll");
  if (showAll) showAll.addEventListener("change", (e) => {
    state.pickerShowAll = e.target.checked;
    renderPicker();
  });
}

function handlePickerClick(event) {
  const campBtn = event.target.closest("[data-pick-camp]");
  const customBtn = event.target.closest("[data-pick-custom]");
  const customCampBtn = event.target.closest("[data-pick-customcamp]");
  const removeBtn = event.target.closest("[data-pick-remove]");
  const assignWeekBtn = event.target.closest("[data-assign-week]");

  if (pickerCtx && pickerCtx.mode === "camp" && assignWeekBtn) {
    const weekId = Number(assignWeekBtn.dataset.assignWeek);
    const childId = assignWeekBtn.dataset.assignChild;
    const current = planEntry(weekId, childId);
    const isThis = current && current.type === "camp" && current.campId === pickerCtx.campId;
    setPlanEntry(weekId, childId, isThis ? null : { type: "camp", campId: pickerCtx.campId });
    renderPicker();
    return;
  }

  if (!pickerCtx || pickerCtx.mode !== "cell") return;
  const { weekId, childId } = pickerCtx;

  const formDayBtn = event.target.closest("[data-form-day]");
  if (formDayBtn) { formDayBtn.classList.toggle("is-on"); return; }

  const dayBtn = event.target.closest("[data-day-toggle]");
  if (dayBtn) {
    const d = Number(dayBtn.dataset.dayToggle);
    const cur = planEntry(weekId, childId);
    if (!cur) return;
    const info = entryDays(cur, weekId);
    const days = info.days.includes(d)
      ? info.days.filter((x) => x !== d)
      : [...info.days, d].sort((a, b) => a - b);
    if (!days.length) return; // keep at least one day
    setPlanEntry(weekId, childId, { ...cur, days });
    renderPicker();
    return;
  }

  if (campBtn) {
    setPlanEntry(weekId, childId, { type: "camp", campId: campBtn.dataset.pickCamp });
    els.pickerDialog.close();
  } else if (customCampBtn) {
    const nameInput = els.pickerBody.querySelector("#customCampName");
    const costInput = els.pickerBody.querySelector("#customCampCost");
    const basisInput = els.pickerBody.querySelector("#customCampBasis");
    const label = ((nameInput && nameInput.value) || "").trim().slice(0, 34) || "My own camp";
    const raw = parseFloat(costInput && costInput.value);
    const cost = Number.isFinite(raw) && raw >= 0 ? Math.round(raw * 100) / 100 : 0;
    const costBasis = (basisInput && basisInput.value) === "day" ? "day" : "week";
    const days = [...els.pickerBody.querySelectorAll("[data-form-day].is-on")]
      .map((b) => Number(b.dataset.formDay)).sort((a, b) => a - b);
    setPlanEntry(weekId, childId, {
      type: "other", label, cost, costBasis,
      days: days.length && days.length < 5 ? days : undefined
    });
    els.pickerDialog.close();
  } else if (customBtn) {
    setPlanEntry(weekId, childId, { type: customBtn.dataset.pickCustom });
    els.pickerDialog.close();
  } else if (removeBtn) {
    setPlanEntry(weekId, childId, null);
    els.pickerDialog.close();
  }
}

/* ────────────────────────── copy / print / clear ────────────────────────── */

function planSummaryText() {
  const lines = [];
  lines.push("E17 HOLIDAY CAMP PLAN — SUMMER 2026");
  lines.push(`Made with the E17 Holiday Camp Planner (data checked ${D.updated}).`);
  lines.push("");
  state.children.forEach((c) => {
    lines.push(`${c.name} (age ${c.age})`);
    let total = 0; let unknown = 0;
    P.weeks.forEach((wk) => {
      const entry = planEntry(wk.id, c.id);
      if (!entry) {
        if (!wk.stub) lines.push(`  ${wk.label} (${wk.dates}): — not covered yet`);
        return;
      }
      const cost = entryCost(entry, wk.id);
      let costText = "£0";
      if (cost && cost.value != null) { costText = money(cost.value) + (cost.estimate ? " est." : ""); total += cost.value; }
      else if (entry.type === "camp") { costText = "£? confirm"; unknown += 1; }
      const meta = entryMeta(entry, wk.id);
      lines.push(`  ${wk.label} (${wk.dates}): ${assignmentLabel(entry)}${meta ? ` (${meta})` : ""} — ${costText}`);
    });
    lines.push(`  Total: ${money(total)}${unknown ? ` + ${unknown} unpriced` : ""}`);
    lines.push("");
  });
  lines.push("Prices as published 9 June 2026 — always confirm with the provider before booking.");
  return lines.join("\n");
}

function bindPlannerActions() {
  document.querySelector("#copyPlan").addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    try {
      await navigator.clipboard.writeText(planSummaryText());
      btn.textContent = "Copied ✓";
    } catch {
      btn.textContent = "Copy failed";
    }
    setTimeout(() => { btn.textContent = "Copy summary"; }, 1800);
  });

  document.querySelector("#printPlan").addEventListener("click", () => window.print());

  document.querySelector("#clearPlan").addEventListener("click", () => {
    if (!Object.keys(state.plan).length) return;
    if (confirm("Clear every week of the plan? Your children and shortlist stay.")) {
      state.plan = {};
      saveState();
      renderPlanner();
    }
  });
}

/* ────────────────────────── HAF, sources, money meta ────────────────────────── */

function hafMatches(entry) {
  const areaOk = state.area === "all" || normalize(entry.area).includes(normalize(state.area));
  return areaOk && ageMatches(entry) && textMatches(entry);
}

function renderHaf() {
  const matches = D.hafSnapshot.filter(hafMatches);
  els.hafTable.innerHTML = matches.map((entry) => `
    <tr class="${/summer/i.test(entry.name) ? "haf-summer" : ""}">
      <td>${escapeHtml(entry.name)}</td>
      <td>${escapeHtml(entry.venue)}</td>
      <td>${escapeHtml(entry.ages)}</td>
      <td>${escapeHtml(entry.area)}</td>
    </tr>
  `).join("");
}

function renderSources() {
  const allSources = D.providers.flatMap((p) => [p.source, ...(p.secondarySources || [])]);
  const deduped = new Map();
  allSources.forEach((s) => { if (!deduped.has(s.url)) deduped.set(s.url, s); });
  els.sourceGrid.innerHTML = [...deduped.values()]
    .map((s) => `<a href="${escapeHtml(s.url)}" target="_blank" rel="noreferrer">${escapeHtml(s.label)}</a>`)
    .join("");
}

function renderMoneyMeta() {
  const haf = D.providers.filter((p) => (p.funding || []).includes("Free/HAF")).length;
  const tfc = D.providers.filter((p) => (p.funding || []).includes("Tax-Free Childcare") || (p.funding || []).includes("Childcare vouchers"));
  const sib = D.providers.filter((p) => (p.funding || []).includes("Sibling discount"));
  els.hafProviderCount.textContent = `${haf} of the ${D.providers.length} entries in this directory have HAF-funded routes.`;
  els.tfcProviderCount.textContent = `${tfc.length} directory entries advertise Tax-Free Childcare or voucher payment.`;
  els.siblingProviderCount.textContent = sib.length
    ? `Advertising sibling discounts: ${sib.map((p) => p.name.split(" ").slice(0, 2).join(" ")).join(", ")}.`
    : "";
}

/* ────────────────────────── checklist ────────────────────────── */

const CHECKLIST = [
  { id: "dates", title: "Exact dates & current price", why: "Listings change between holidays — get this summer's price and dates in writing." },
  { id: "ofsted", title: "Ofsted registration number", why: "You need it (and the provider signed up) to pay with Tax-Free Childcare or vouchers." },
  { id: "food", title: "Lunch & snack arrangements", why: "Included, a paid add-on, or packed lunch? Ask about the nut/allergy policy too." },
  { id: "times", title: "Drop-off and pick-up windows", why: "Exact times, who signs in/out, and the late-collection policy and fees." },
  { id: "collect", title: "Who's allowed to collect", why: "Named adults and collection passwords — sort this before day one, not at 5:55pm." },
  { id: "kit", title: "First-day kit list", why: "Water bottle, named sunscreen (pre-applied?), hat, trainers, spare clothes, no toys." },
  { id: "send", title: "SEND & medical conversation", why: "1:1 support, medication storage, allergy plans and inhalers — speak to the lead, not the booking form." },
  { id: "groups", title: "Age groups & friends", why: "How groups are split and whether siblings or school friends can be placed together." },
  { id: "cancel", title: "Cancellation & swap policy", why: "Refund or credit if your child is ill or plans change? Any swap fees?" },
  { id: "discount", title: "Sibling / early-bird discounts", why: "Ask explicitly — several local providers offer them and not all advertise it." },
  { id: "phones", title: "Phone & photo policy", why: "What happens to phones during the day, and set your photo-consent preference." },
  { id: "reconfirm", title: "Re-confirm the week before", why: "A 2-minute check of venue and start time the Friday before saves a chaotic Monday." }
];

function renderChecklist() {
  els.checklistList.innerHTML = CHECKLIST.map((item) => {
    const done = state.checks.includes(item.id);
    return `<li>
      <label class="check-item ${done ? "is-done" : ""}">
        <input type="checkbox" data-check="${item.id}" ${done ? "checked" : ""}>
        <span><strong>${escapeHtml(item.title)}</strong><span class="why">${escapeHtml(item.why)}</span></span>
      </label>
    </li>`;
  }).join("");
  els.checklistCount.textContent = `${state.checks.length} of ${CHECKLIST.length} ticked`;
}

/* ────────────────────────── stats + selects ────────────────────────── */

function populateSelect(select, label, values) {
  select.innerHTML = [
    `<option value="all">All ${label}</option>`,
    ...values.map((v) => `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`)
  ].join("");
}

/* ────────────────────────── events & init ────────────────────────── */

function applyFilters() {
  renderProviders();
  renderHaf();
}

function bindAgeChips() {
  document.querySelectorAll(".age-chip[data-age]").forEach((button) => {
    button.onclick = () => {
      state.age = button.dataset.age;
      document.querySelectorAll(".age-chip[data-age]").forEach((chip) => {
        chip.classList.toggle("is-active", chip.dataset.age === state.age);
      });
      applyFilters();
    };
  });
}

function resetFilters() {
  Object.assign(state, { search: "", area: "all", category: "all", funding: "all", age: "any", dayLength: "all", price: "all", confirmedOnly: false, sort: "az" });
  els.searchInput.value = "";
  els.areaFilter.value = "all";
  els.categoryFilter.value = "all";
  els.fundingFilter.value = "all";
  els.dayLengthFilter.value = "all";
  els.priceFilter.value = "all";
  els.sortSelect.value = "az";
  els.confirmedOnly.checked = false;
  document.querySelectorAll(".age-chip[data-age]").forEach((chip) => {
    chip.classList.toggle("is-active", chip.dataset.age === "any");
  });
  applyFilters();
}

function init() {
  loadState();

  // Age select 2–17
  els.childAge.innerHTML = `<option value="" disabled selected>Age…</option>` +
    Array.from({ length: 16 }, (_, i) => i + 2).map((a) => `<option value="${a}">${a}</option>`).join("");

  const areas = uniqueSorted(D.providers.flatMap((p) => p.areas));
  const categories = uniqueSorted(D.providers.flatMap((p) => p.categories));
  const funding = uniqueSorted(D.providers.flatMap((p) => p.funding));
  populateSelect(els.areaFilter, "areas", areas);
  populateSelect(els.categoryFilter, "activities", categories);
  populateSelect(els.fundingFilter, "funding", funding);

  els.searchInput.addEventListener("input", (e) => { state.search = e.target.value.trim(); applyFilters(); });
  els.areaFilter.addEventListener("change", (e) => { state.area = e.target.value; applyFilters(); });
  els.categoryFilter.addEventListener("change", (e) => { state.category = e.target.value; applyFilters(); });
  els.fundingFilter.addEventListener("change", (e) => { state.funding = e.target.value; applyFilters(); });
  els.dayLengthFilter.addEventListener("change", (e) => { state.dayLength = e.target.value; applyFilters(); });
  els.priceFilter.addEventListener("change", (e) => { state.price = e.target.value; applyFilters(); });
  els.sortSelect.addEventListener("change", (e) => { state.sort = e.target.value; applyFilters(); });
  els.confirmedOnly.addEventListener("change", (e) => { state.confirmedOnly = e.target.checked; applyFilters(); });
  document.querySelector("#resetFilters").addEventListener("click", resetFilters);
  bindAgeChips();

  // Children
  els.childForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const age = Number(els.childAge.value);
    if (!Number.isFinite(age) || age < 2) return;
    addChild(els.childName.value.trim(), age);
    els.childName.value = "";
    els.childAge.selectedIndex = 0;
    els.childName.focus();
  });

  // Delegated clicks: shortlist hearts, add-to-plan, child remove, planner cells
  document.body.addEventListener("click", (event) => {
    const heart = event.target.closest("[data-shortlist]");
    if (heart) {
      const id = heart.dataset.shortlist;
      state.shortlist = state.shortlist.includes(id)
        ? state.shortlist.filter((x) => x !== id)
        : [...state.shortlist, id];
      saveState();
      renderProviders();
      renderCompare();
      return;
    }
    const add = event.target.closest("[data-addplan]");
    if (add) { openCampAssign(add.dataset.addplan); return; }

    const removeChildBtn = event.target.closest("[data-removechild]");
    if (removeChildBtn) {
      const child = childById(removeChildBtn.dataset.removechild);
      if (child && confirm(`Remove ${child.name} and their assignments?`)) {
        removeChild(child.id);
      }
      return;
    }
    const cell = event.target.closest(".assign-btn");
    if (cell) { openCellPicker(cell.dataset.week, cell.dataset.child); }
  });

  // Picker
  els.pickerBody.addEventListener("click", handlePickerClick);
  els.pickerClose.addEventListener("click", () => els.pickerDialog.close());
  els.pickerDialog.addEventListener("click", (e) => {
    if (e.target === els.pickerDialog) els.pickerDialog.close();
  });
  els.pickerDialog.addEventListener("close", () => {
    if (pickerCtx && pickerCtx.mode === "camp") renderPlanner();
    // The close event is queued async — if the picker was already reopened
    // for another cell, don't clobber the new context.
    if (!els.pickerDialog.open) pickerCtx = null;
  });

  // Checklist
  els.checklistList.addEventListener("change", (e) => {
    const box = e.target.closest("[data-check]");
    if (!box) return;
    const id = box.dataset.check;
    state.checks = box.checked ? [...new Set([...state.checks, id])] : state.checks.filter((x) => x !== id);
    saveState();
    renderChecklist();
  });

  bindPlannerActions();

  renderChildren();
  renderMoneyMeta();
  renderSources();
  renderChecklist();
  renderCompare();
  renderPlanner();
  applyFilters();
}

init();
