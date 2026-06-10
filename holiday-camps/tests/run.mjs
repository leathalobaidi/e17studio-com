#!/usr/bin/env node
/* E17 Holiday Camp Planner — verification suite.
 *
 * Zero dependencies. Runs locally (macOS) and in CI (ubuntu).
 *
 *   node holiday-camps/tests/run.mjs [--site-dir <path>] [--skip-ui]
 *
 * Part 1: data-layer integrity (no browser) — loads camps.js + planner-data.js
 *         in a VM and validates cross-references, formats and provenance.
 * Part 2: UI end-to-end — builds a temp copy of the page with an injected
 *         autotest, drives it in headless Chrome (add children, build a plan,
 *         add a custom camp with a cost, filters, persistence across runs)
 *         and asserts the rendered output against expectations recomputed
 *         independently from the data files.
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync, copyFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import vm from "node:vm";
import os from "node:os";

const args = process.argv.slice(2);
const argVal = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null; };
const SITE = path.resolve(argVal("--site-dir") || path.join(path.dirname(fileURLToPath(import.meta.url)), ".."));
const SKIP_UI = args.includes("--skip-ui");

let failures = 0;
let checks = 0;
const fail = (msg) => { failures++; console.log("  ✗ " + msg); };
const ok = (msg) => { console.log("  ✓ " + msg); };
function assert(cond, label, detail = "") {
  checks++;
  if (cond) ok(label);
  else fail(label + (detail ? ` — ${detail}` : ""));
}

console.log(`E17 Holiday Camp Planner test suite\nSite dir: ${SITE}\n`);

/* ───────────────── Part 1: data integrity ───────────────── */
console.log("── Data integrity ──");
const window = {};
const ctx = vm.createContext({ window });
vm.runInContext(readFileSync(path.join(SITE, "assets/camps.js"), "utf8"), ctx);
vm.runInContext(readFileSync(path.join(SITE, "assets/planner-data.js"), "utf8"), ctx);
const D = window.E17_DIRECTORY;
const P = window.E17_PLANNER;

const ids = new Set(D.providers.map((p) => p.id));
const orphans = Object.keys(P.byId).filter((k) => !ids.has(k));
assert(orphans.length === 0, "no orphan planner ids", orphans.join(", "));
assert(P.weeks.length === 7, "7 planner weeks defined", `got ${P.weeks.length}`);
assert(new Set(D.providers.map((p) => p.id)).size === D.providers.length, "provider ids unique");

const problems = [];
Object.entries(P.byId).forEach(([k, v]) => {
  (v.weeks || []).forEach((w) => { if (![1, 2, 3, 4, 5, 6, 7].includes(w)) problems.push(`bad week ${w} on ${k}`); });
  if (v.price) {
    Object.entries(v.price).forEach(([pk, pv]) => {
      if (pk === "weekByWeek") Object.values(pv).forEach((x) => { if (!Number.isFinite(x)) problems.push(`bad weekByWeek on ${k}`); });
      else if (pk === "weekBands") pv.forEach((b) => { if (!Number.isFinite(b.week)) problems.push(`bad weekBand on ${k}`); });
      else if (pk !== "weekAltLabel" && !Number.isFinite(pv)) problems.push(`non-numeric price.${pk} on ${k}`);
    });
    if (!v.priceBasis && !Number.isFinite(v.price.sessionFrom)) problems.push(`price without priceBasis on ${k}`);
  }
  if (v.hours) ["start", "end", "extStart", "extEnd"].forEach((hk) => {
    if (v.hours[hk] && !/^\d{1,2}:\d{2}$/.test(v.hours[hk])) problems.push(`bad hours.${hk} on ${k}`);
  });
  if (v.daysPerWeek) Object.values(v.daysPerWeek).forEach((d) => { if (!(d >= 1 && d <= 5)) problems.push(`bad daysPerWeek on ${k}`); });
  if ((v.weeks || []).length && !v.weeksBasis) problems.push(`weeks without weeksBasis on ${k}`);
});
D.providers.forEach((p) => {
  if (!(Number.isFinite(p.ageMin) && Number.isFinite(p.ageMax) && p.ageMin <= p.ageMax)) problems.push(`bad age range on ${p.id}`);
  if (!p.source || !/^https?:\/\//.test(p.source.url || "")) problems.push(`missing/invalid source on ${p.id}`);
  ["name", "venue", "summary", "booking", "confidence", "ageLabel", "hours", "price"].forEach((f) => {
    if (!p[f]) problems.push(`missing ${f} on ${p.id}`);
  });
});
assert(problems.length === 0, "field-level validation clean", problems.slice(0, 6).join("; ") + (problems.length > 6 ? ` (+${problems.length - 6} more)` : ""));

// Local asset references must resolve (CSS url() files and the og:image).
const css = readFileSync(path.join(SITE, "assets/styles.css"), "utf8");
const idx = readFileSync(path.join(SITE, "index.html"), "utf8");
const missingAssets = [];
[...css.matchAll(/url\("\.\/([^"]+)"\)/g)].forEach((m) => {
  if (!existsSync(path.join(SITE, "assets", m[1]))) missingAssets.push("css → assets/" + m[1]);
});
const og = /og:image" content="[^"]*\/assets\/([^"]+)"/.exec(idx);
if (og && !existsSync(path.join(SITE, "assets", og[1]))) missingAssets.push("og:image → assets/" + og[1]);
assert(missingAssets.length === 0, "all referenced local assets exist", missingAssets.join("; "));
console.log(`  providers: ${D.providers.length}, enriched: ${Object.keys(P.byId).length}, haf snapshot: ${D.hafSnapshot.length}`);

/* ───────────────── Part 2: UI end-to-end ───────────────── */
if (!SKIP_UI) {
  console.log("\n── UI end-to-end (headless Chrome) ──");

  const CHROME = process.env.CHROME_PATH
    || ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium-browser"]
      .find((p) => existsSync(p));
  if (!CHROME) { fail("no Chrome binary found (set CHROME_PATH)"); report(); }

  // Independently recompute expected money figures from the data.
  const price = (id) => (P.byId[id] || {}).price || {};
  const expVestryEdited = 90;                                                // ends as £30/day × Mon–Wed
  const expLss = price("little-soccer-stars-walthamstow").day * 5;          // wk2, est
  const expGravity = price("gravity-performing-arts").week;                  // wk1
  const expYmca3 = price("ymca-y-kidz").day * 3;                             // wk2, toggled to Mon–Wed
  const expStrings = price("the-strings-club-walthamstow").day * 5;          // wk6, est
  const expMayaTotal = expVestryEdited + expLss + 0 /*leave wk3*/ + expStrings;
  const expLeoTotal = expGravity + expYmca3;
  const expGrand = expMayaTotal + expLeoTotal;
  const money = (n) => "£" + (Number.isInteger(n) ? String(n) : n.toFixed(2));

  // Build the temp test page.
  const TMP = path.join(os.tmpdir(), "e17-ci-test");
  const PROF = path.join(os.tmpdir(), "e17-ci-prof");
  rmSync(TMP, { recursive: true, force: true });
  rmSync(PROF, { recursive: true, force: true });
  mkdirSync(path.join(TMP, "assets"), { recursive: true });
  for (const f of ["camps.js", "planner-data.js", "app.js", "styles.css"]) {
    copyFileSync(path.join(SITE, "assets", f), path.join(TMP, "assets", f));
  }
  let html = readFileSync(path.join(SITE, "index.html"), "utf8");
  html = html.replace(/<link rel="preconnect"[^>]*>\s*/g, "");
  html = html.replace(/<link[^>]*fonts\.googleapis[^>]*>\s*/g, "");
  html = html.replace('<script src="assets/camps.js"></script>',
    `<script>window.__testErrors=[];window.addEventListener('error',e=>window.__testErrors.push(String(e.message).slice(0,200)));</script>\n<script src="assets/camps.js"></script>`);
  html = html.replace("</body>", `<script src="autotest.js"></script>\n</body>`);
  writeFileSync(path.join(TMP, "index.html"), html);
  writeFileSync(path.join(TMP, "autotest.js"), AUTOTEST_SRC());

  const chromeRun = () => {
    const res = spawnSync(CHROME, [
      "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
      "--hide-scrollbars", ...(process.env.CI ? ["--no-sandbox"] : []),
      `--user-data-dir=${PROF}`, "--virtual-time-budget=9000", "--dump-dom",
      "file://" + path.join(TMP, "index.html")
    ], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 120000 });
    const m = /TESTOUT_START(.*?)TESTOUT_END/s.exec(res.stdout || "");
    if (!m) throw new Error("no TESTOUT in DOM dump (stderr: " + String(res.stderr).slice(-200) + ")");
    const decoded = m[1].replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
    return JSON.parse(decoded);
  };

  const o = chromeRun(); // run 1: build mode
  assert(o.mode === "build", "run 1 started with clean storage");
  assert((o.jsErrors || []).length === 0, "no JS errors (run 1)", (o.jsErrors || []).join("; "));
  assert(o.static.cards === D.providers.length, `all ${D.providers.length} provider cards render`, `got ${o.static.cards}`);
  assert(o.static.resultCount === `${D.providers.length} of ${D.providers.length} shown`, "result count text", o.static.resultCount);
  assert(o.static.hafRows === D.hafSnapshot.length, `HAF table has ${D.hafSnapshot.length} rows`, `got ${o.static.hafRows}`);
  assert(o.static.checklist === 12, "12 checklist items", `got ${o.static.checklist}`);
  assert(o.children.chips.length === 2 && o.children.plannerRows === 7 && o.children.headerCols === 4,
    "two children → 7-week × 2-child grid", JSON.stringify(o.children));
  assert(o.picker.groups.some((g) => g.includes("Add your own")), "custom-camp form group present", o.picker.groups.join(" | "));
  assert(o.customCamp.added.label === "Vestry holiday club" && o.customCamp.added.cost === money(85.5),
    "custom camp added with cost £85.50", JSON.stringify(o.customCamp.added));
  assert(o.customCamp.prefill.name === "Vestry holiday club" && o.customCamp.prefill.btn === "Save changes",
    "custom camp prefills for editing", JSON.stringify(o.customCamp.prefill));
  assert(o.customCamp.edited === money(expVestryEdited), "custom camp cost editable → £90", o.customCamp.edited);
  assert(o.assignments.setCells === 6, "all 6 assigned cells stick", `got ${o.assignments.setCells}`);
  assert(o.dayEditor.present && o.dayEditor.chips === 5, "day editor renders with 5 day chips", JSON.stringify(o.dayEditor));
  assert(o.dayEditor.cellCost === money(expYmca3) + " est.", `part-week pricing: YMCA Mon–Wed = ${money(expYmca3)} est.`, o.dayEditor.cellCost);
  assert(o.dayEditor.cellMeta.includes("Mon Tue Wed"), "cell meta shows chosen days", o.dayEditor.cellMeta);
  assert(o.customDay.cost === money(expVestryEdited), `per-day custom camp: £30 × 3 days = ${money(expVestryEdited)}`, o.customDay.cost);
  assert(o.customDay.meta.includes("Mon Tue Wed"), "custom camp meta shows chosen days", o.customDay.meta);
  assert(o.assignments.mayaTotal === money(expMayaTotal), `Maya total recomputes to ${money(expMayaTotal)}`, o.assignments.mayaTotal);
  assert(o.assignments.leoTotal === money(expLeoTotal), `Leo total recomputes to ${money(expLeoTotal)}`, o.assignments.leoTotal);
  assert(o.assignments.grandText.includes(money(expGrand)), `grand total recomputes to ${money(expGrand)}`, o.assignments.grandText);
  assert(o.filters.afterReset === D.providers.length, "filters reset restores all cards", JSON.stringify(o.filters));
  assert(o.filters.confirmedOnly > 0 && o.filters.confirmedOnly < D.providers.length, "confirmed-only filter narrows", JSON.stringify(o.filters));
  assert(o.store.children === 2 && o.store.planWeeks >= 4, "plan persisted to localStorage", JSON.stringify(o.store));

  const o2 = chromeRun(); // run 2: same profile → persistence
  assert(o2.mode === "verify", "run 2 loads saved state");
  assert(o2.persisted.chips === 2 && o2.persisted.setCells === 6, "children + all 6 cells survive reload", JSON.stringify(o2.persisted));
  assert(o2.persisted.grandText.includes(money(expGrand)), "grand total survives reload", o2.persisted.grandText);
  assert((o2.jsErrors || []).length === 0, "no JS errors (run 2)", (o2.jsErrors || []).join("; "));

  rmSync(TMP, { recursive: true, force: true });
  rmSync(PROF, { recursive: true, force: true });
}

report();

function report() {
  console.log(`\n${checks} checks, ${failures} failed`);
  process.exit(failures ? 1 : 0);
}

/* ───────────────── in-page autotest (injected) ───────────────── */
function AUTOTEST_SRC() { return String.raw`
(async function () {
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => document.querySelectorAll(s);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = {};
  try {
    let verify = false;
    try { verify = (JSON.parse(localStorage.getItem("e17planner.v1") || "{}").children || []).length >= 2; } catch {}
    out.mode = verify ? "verify" : "build";
    const grandText = () => { const g = $(".budget-card.grand"); return g ? g.textContent.replace(/\s+/g, " ").trim() : ""; };

    if (!verify) {
      out.static = {
        cards: $$(".camp-card").length,
        resultCount: ($("#resultCount") || {}).textContent || "",
        hafRows: $$("#hafTable tr").length,
        checklist: $$(".check-item").length
      };
      // children
      $("#childName").value = "Maya"; $("#childAge").value = "6"; $("#childForm").requestSubmit();
      $("#childName").value = "Leo"; $("#childAge").value = "9"; $("#childForm").requestSubmit();
      await sleep(120);
      out.children = {
        chips: [...$$(".child-chip")].map((c) => c.textContent.trim().slice(0, 16)),
        plannerRows: $$("#plannerTable tbody tr").length,
        headerCols: $$("#plannerTable thead th").length
      };
      const kids = JSON.parse(localStorage.getItem("e17planner.v1")).children;
      const maya = kids[0].id, leo = kids[1].id;
      const dlg = $("#pickerDialog");
      const open = async (week, child) => {
        document.querySelector('.assign-btn[data-week="' + week + '"][data-child="' + child + '"]').click();
        await sleep(90);
      };
      const pick = async (sel) => { dlg.querySelector(sel).click(); await sleep(110); };

      // picker inspection + custom camp on wk1/maya
      await open(1, maya);
      out.picker = { groups: [...dlg.querySelectorAll(".picker-group-title")].map((g) => g.textContent.trim()) };
      out.customCamp = {};
      $("#customCampName").value = "Vestry holiday club";
      $("#customCampCost").value = "85.50";
      await pick("[data-pick-customcamp]");
      const cell1 = $('.assign-btn[data-week="1"][data-child="' + maya + '"].is-set');
      out.customCamp.added = {
        label: cell1.querySelector(".assign-name").textContent.trim(),
        cost: cell1.querySelector(".assign-cost").textContent.trim()
      };
      cell1.click(); await sleep(90);
      out.customCamp.prefill = { name: $("#customCampName").value, btn: dlg.querySelector("[data-pick-customcamp]").textContent.trim() };
      $("#customCampCost").value = "90";
      await pick("[data-pick-customcamp]");
      out.customCamp.edited = $('.assign-btn[data-week="1"][data-child="' + maya + '"].is-set .assign-cost').textContent.trim();

      // rest of the plan
      await open(2, maya); await pick('[data-pick-camp="little-soccer-stars-walthamstow"]');
      await open(3, maya); await pick('[data-pick-custom="leave"]');
      await open(6, maya); await pick('[data-pick-camp="the-strings-club-walthamstow"]');
      await open(1, leo); await pick('[data-pick-camp="gravity-performing-arts"]');
      await open(2, leo); await pick('[data-pick-camp="ymca-y-kidz"]');
      await sleep(150);

      // day toggles: Leo's YMCA week → Mon–Wed only
      await open(2, leo);
      out.dayEditor = { present: !!dlg.querySelector(".day-editor"), chips: dlg.querySelectorAll("[data-day-toggle]").length };
      dlg.querySelector('[data-day-toggle="5"]').click(); await sleep(90);
      dlg.querySelector('[data-day-toggle="4"]').click(); await sleep(90);
      $("#pickerClose").click(); await sleep(120);
      const leoCell2 = document.querySelector('.assign-btn[data-week="2"][data-child="' + leo + '"].is-set');
      out.dayEditor.cellCost = leoCell2.querySelector(".assign-cost").textContent.trim();
      out.dayEditor.cellMeta = (leoCell2.querySelector(".assign-meta") || { textContent: "" }).textContent.trim();

      // custom camp priced per day: Vestry → £30/day × Mon–Wed (still £90)
      document.querySelector('.assign-btn[data-week="1"][data-child="' + maya + '"].is-set').click();
      await sleep(90);
      $("#customCampCost").value = "30";
      $("#customCampBasis").value = "day";
      dlg.querySelector('[data-form-day="4"]').click();
      dlg.querySelector('[data-form-day="5"]').click();
      await pick("[data-pick-customcamp]");
      const mayaCell1 = document.querySelector('.assign-btn[data-week="1"][data-child="' + maya + '"].is-set');
      out.customDay = {
        cost: mayaCell1.querySelector(".assign-cost").textContent.trim(),
        meta: (mayaCell1.querySelector(".assign-meta") || { textContent: "" }).textContent.trim()
      };
      await sleep(100);
      const cards = [...$$(".budget-card")].map((c) => c.textContent.replace(/\s+/g, " ").trim());
      const moneyOf = (t) => { const m = /£[\d.]+/.exec(t); return m ? m[0] : ""; };
      out.assignments = {
        setCells: $$(".assign-btn.is-set").length,
        mayaTotal: moneyOf(cards.find((c) => c.startsWith("Maya")) || ""),
        leoTotal: moneyOf(cards.find((c) => c.startsWith("Leo")) || ""),
        grandText: grandText()
      };

      // filters
      const set = (sel, val) => { const el = $(sel); el.value = val; el.dispatchEvent(new Event("change")); };
      const conf = $("#confirmedOnly");
      conf.checked = true; conf.dispatchEvent(new Event("change")); await sleep(60);
      const confirmedOnly = $$(".camp-card").length;
      $("#resetFilters").click(); await sleep(60);
      out.filters = { confirmedOnly, afterReset: $$(".camp-card").length };

      const s = JSON.parse(localStorage.getItem("e17planner.v1"));
      out.store = { children: s.children.length, planWeeks: Object.keys(s.plan).length };
    } else {
      out.persisted = { chips: $$(".child-chip").length, setCells: $$(".assign-btn.is-set").length, grandText: grandText() };
    }
  } catch (e) {
    out.fatal = String(e && e.stack ? e.stack : e).slice(0, 400);
  }
  out.jsErrors = window.__testErrors || [];
  const pre = document.createElement("pre");
  pre.id = "testout"; pre.style.display = "none";
  pre.textContent = "TESTOUT_START" + JSON.stringify(out) + "TESTOUT_END";
  document.body.appendChild(pre);
})();
`;
}
