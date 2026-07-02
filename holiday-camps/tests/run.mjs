#!/usr/bin/env node
/* E17 Holiday Camp Planner — verification suite.
 *
 * Zero dependencies. Runs locally (macOS) and in CI (ubuntu).
 *
 *   node holiday-camps/tests/run.mjs [--site-dir <path>] [--skip-ui]
 *                                    [--prepare-only] [--results <dump1> <dump2> <dump3> <dump4>]
 *
 * Part 1: data-layer integrity (no browser) — loads camps.js + planner-data.js
 *         in a VM and validates cross-references, formats and provenance.
 * Part 2: UI end-to-end — builds a temp copy of the page with an injected
 *         autotest and drives it in headless Chrome over four runs sharing one
 *         profile: (1) build a plan (children, custom camp, filters, day
 *         toggles, booked ticks, share link, .ics export), (2) reload to check
 *         persistence, (3) open a #plan= share link and REPLACE the local
 *         plan, (4) open another and MERGE it. Output is asserted against
 *         expectations recomputed independently from the data files.
 *
 * Some Macs wedge on node→Chrome spawns, or Chrome dumps the DOM but never
 * exits (holding the profile lock). There, run --prepare-only to build the
 * temp site and print four shell-direct Chrome commands, run those from a
 * shell (SIGTERM Chrome once the dump contains TESTOUT_END), then re-run with
 * --results <the 4 dumps> to apply the same assertions.
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
const PREPARE_ONLY = args.includes("--prepare-only");
const resultsAt = args.indexOf("--results");
const RESULT_FILES = resultsAt >= 0 ? args.slice(resultsAt + 1, resultsAt + 5) : null;
if (RESULT_FILES && RESULT_FILES.length < 4) {
  console.error("--results needs the 4 DOM dumps from runs 1–4, in order");
  process.exit(2);
}

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

  // Shared-plan link fixtures for the import runs (3: replace, 4: merge).
  const shareFixture = (obj) => "#plan=" + Buffer.from(JSON.stringify(obj), "utf8").toString("base64url");
  const R3_HASH = shareFixture({
    v: 1,
    children: [{ id: "zshare1", name: "Zara", age: 7 }],
    plan: { 2: { zshare1: { type: "camp", campId: "ymca-y-kidz", booked: true } } }
  });
  const R4_HASH = shareFixture({
    v: 1,
    children: [{ id: "oshare2", name: "Omar", age: 10 }],
    plan: { 3: { oshare2: { type: "leave" } } }
  });

  // Build the temp test page (skipped when ingesting --results dumps).
  const TMP = path.join(os.tmpdir(), "e17-ci-test");
  const PROF = path.join(os.tmpdir(), "e17-ci-prof");
  if (!RESULT_FILES) {
    rmSync(TMP, { recursive: true, force: true });
    rmSync(PROF, { recursive: true, force: true });
    mkdirSync(path.join(TMP, "assets"), { recursive: true });
    for (const f of ["camps.js", "planner-data.js", "app.js", "styles.css"]) {
      copyFileSync(path.join(SITE, "assets", f), path.join(TMP, "assets", f));
    }
    let html = readFileSync(path.join(SITE, "index.html"), "utf8");
    html = html.replace(/<link rel="preconnect"[^>]*>\s*/g, "");
    html = html.replace(/<link[^>]*fonts\.googleapis[^>]*>\s*/g, "");
    // Strip the Cloudflare Web Analytics beacon so the UI test runs fully offline.
    html = html.replace(/<script[^>]*cloudflareinsights[^>]*><\/script>\s*/g, "");
    // Site scripts now carry `defer`; match either form and keep the error
    // hook inline (non-defer) so it installs before anything else runs.
    html = html.replace(/<script src="assets\/camps\.js"( defer)?><\/script>/,
      `<script>window.__testErrors=[];window.addEventListener('error',e=>window.__testErrors.push(String(e.message).slice(0,200)));</script>\n<script src="assets/camps.js"$1></script>`);
    // Autotest must execute AFTER the deferred app.js — defer preserves
    // document order (camps → planner-data → app → autotest).
    html = html.replace("</body>", `<script src="autotest.js" defer></script>\n</body>`);
    writeFileSync(path.join(TMP, "index.html"), html);
    writeFileSync(path.join(TMP, "autotest.js"), AUTOTEST_SRC());
  }

  const readOut = (text, stderr = "") => {
    const m = /TESTOUT_START(.*?)TESTOUT_END/s.exec(text || "");
    if (!m) throw new Error("no TESTOUT in DOM dump" + (stderr ? " (stderr: " + String(stderr).slice(-200) + ")" : ""));
    const decoded = m[1].replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
    return JSON.parse(decoded);
  };
  const CHROME_FLAGS = [
    "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
    "--hide-scrollbars", ...(process.env.CI ? ["--no-sandbox"] : []),
    `--user-data-dir=${PROF}`, "--virtual-time-budget=12000", "--dump-dom"
  ];
  const RUN_URLS = ["", "", R3_HASH, "?merge" + R4_HASH].map((s) => "file://" + path.join(TMP, "index.html") + s);
  const chromeRun = (url) => {
    const res = spawnSync(CHROME, [...CHROME_FLAGS, url],
      { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 120000 });
    return readOut(res.stdout, res.stderr);
  };

  if (PREPARE_ONLY) {
    console.log("Prepared " + TMP + ". Run these IN ORDER (they share one profile), then re-run with --results:\n");
    RUN_URLS.forEach((u, i) => {
      console.log(`"${CHROME}" ${CHROME_FLAGS.join(" ")} '${u}' > /tmp/e17-out${i + 1}.html 2>/dev/null`);
    });
    console.log(`\nnode tests/run.mjs --site-dir "${SITE}" --results /tmp/e17-out1.html /tmp/e17-out2.html /tmp/e17-out3.html /tmp/e17-out4.html`);
    process.exit(0);
  }
  const runOut = (n) => RESULT_FILES
    ? readOut(readFileSync(RESULT_FILES[n - 1], "utf8"))
    : chromeRun(RUN_URLS[n - 1]);

  const o = runOut(1); // run 1: build mode
  assert(o.mode === "build", "run 1 started with clean storage");
  assert((o.jsErrors || []).length === 0, "no JS errors (run 1)", (o.jsErrors || []).join("; "));
  assert(o.static.cards === D.providers.length, `all ${D.providers.length} provider cards render`, `got ${o.static.cards}`);
  assert(o.static.resultCount === `${D.providers.length} of ${D.providers.length} shown`, "result count text", o.static.resultCount);
  assert(o.static.hafRows === D.hafSnapshot.length, `HAF table has ${D.hafSnapshot.length} rows`, `got ${o.static.hafRows}`);
  assert(o.static.checklist === 12, "12 checklist items", `got ${o.static.checklist}`);
  assert(o.children.chips.length === 2 && o.children.plannerRows === 7 && o.children.headerCols === 4,
    "two children → 7-week × 2-child grid", JSON.stringify(o.children));
  assert(o.picker.groups.some((g) => g.includes("Add your own")), "custom-camp form group present", o.picker.groups.join(" | "));
  assert(o.picker.weekBtns > 0 && o.picker.dayBtns > 0, "camp options offer whole-week AND pick-days buttons", JSON.stringify({ week: o.picker.weekBtns, days: o.picker.dayBtns }));
  assert(o.pickDaysFlow.dialogStillOpen && o.pickDaysFlow.editorShown, "pick-days path assigns and opens the day editor", JSON.stringify(o.pickDaysFlow));
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
  assert(o.campMode.rowShown, "camp dialog: selecting a week reveals its day row", JSON.stringify(o.campMode));
  assert(o.campMode.fridayOn && o.campMode.disabledCount === 4, "camp dialog: Fridays-only camp enables only Fri", JSON.stringify(o.campMode));
  assert(o.campMode.cost.includes("£60"), "camp dialog: day row carries the week's cost", o.campMode.cost);
  assert(o.campMode.churchHillWk1 === "2,3,4,5", "Church Hill week 1 day pattern is Tue–Fri", o.campMode.churchHillWk1);
  assert(o.campMode.removedAgain, "camp dialog: re-tapping the week removes it", "entry still present");
  assert(o.assignments.mayaTotal === money(expMayaTotal), `Maya total recomputes to ${money(expMayaTotal)}`, o.assignments.mayaTotal);
  assert(o.assignments.leoTotal === money(expLeoTotal), `Leo total recomputes to ${money(expLeoTotal)}`, o.assignments.leoTotal);
  assert(o.assignments.grandText.includes(money(expGrand)), `grand total recomputes to ${money(expGrand)}`, o.assignments.grandText);
  assert(o.filters.afterReset === D.providers.length, "filters reset restores all cards", JSON.stringify(o.filters));
  assert(o.filters.confirmedOnly > 0 && o.filters.confirmedOnly < D.providers.length, "confirmed-only filter narrows", JSON.stringify(o.filters));
  assert(o.store.children === 2 && o.store.planWeeks >= 4, "plan persisted to localStorage", JSON.stringify(o.store));
  assert(o.ics && o.ics.hasCal && o.ics.crlf, "ICS calendar generates (RFC 5545 envelope, CRLF)", JSON.stringify(o.ics));
  assert(o.ics.events === 6, "6 all-day calendar events (one per assignment run)", JSON.stringify(o.ics));
  assert(o.ics.lssWeekStart && o.ics.ymcaMonWedEnd, "event date ranges correct (Mon 27 Jul start; Mon–Wed ends Thu, exclusive)", JSON.stringify(o.ics));
  assert(o.ics.vestryTitle, "event titles are child + camp name", JSON.stringify(o.ics));
  assert(o.booked.toggles === 5, "booked toggles on all 5 bookable cells", `got ${o.booked.toggles}`);
  assert(o.booked.cellText === "booked ✓" && o.booked.pressed === "true", "cell toggle flips to booked ✓", JSON.stringify({ text: o.booked.cellText, pressed: o.booked.pressed }));
  assert(/2 of 5/.test(o.booked.card) && /bookings made/.test(o.booked.card), 'budget band shows "2 of 5 … bookings made"', o.booked.card);
  assert(o.booked.untoggled === "not booked" && /1 of 5/.test(o.booked.cardAfterUntoggle), "booked toggle reverses cleanly", JSON.stringify({ text: o.booked.untoggled, card: o.booked.cardAfterUntoggle }));
  assert(o.booked.stored === true, "booked flags persist to localStorage");
  assert(o.tell.waShown && o.tell.cleanLink && o.tell.noNames, "Tell-other-parents copies a plain link — no #plan=, no names", JSON.stringify(o.tell));
  assert(o.share.waShown && o.share.waTarget, "Share-my-plan reveals a wa.me link (after confirm)", JSON.stringify(o.share));
  assert(o.share.children.join(",") === "Maya,Leo" && o.share.planWeeks === 4, "share payload carries both children + 4 planned weeks", JSON.stringify({ children: o.share.children, weeks: o.share.planWeeks }));
  assert(o.share.bookedCarried === true, "share payload carries booked status");
  assert(o.share.declinedStaysHidden === true, "declining the share confirm copies nothing", JSON.stringify({ declinedStaysHidden: o.share.declinedStaysHidden }));

  const o2 = runOut(2); // run 2: same profile → persistence
  assert(o2.mode === "verify", "run 2 loads saved state");
  assert(o2.persisted.chips === 2 && o2.persisted.setCells === 6, "children + all 6 cells survive reload", JSON.stringify(o2.persisted));
  assert(o2.persisted.grandText.includes(money(expGrand)), "grand total survives reload", o2.persisted.grandText);
  assert(o2.persisted.bookedCells === 2 && /2 of 5/.test(o2.persisted.bookingsCard), "booked ticks survive reload", JSON.stringify({ cells: o2.persisted.bookedCells, card: o2.persisted.bookingsCard }));
  assert((o2.jsErrors || []).length === 0, "no JS errors (run 2)", (o2.jsErrors || []).join("; "));

  const o3 = runOut(3); // run 3: open a shared link → replace local plan
  assert(o3.mode === "import", "run 3 enters import mode from the #plan= hash");
  assert(o3.import.bannerShown && o3.import.title === "Load this shared plan?", 'banner offers "Load this shared plan?"', JSON.stringify({ title: o3.import.title }));
  assert(/Zara \(7\)/.test(o3.import.text) && /1 week/.test(o3.import.text), "banner describes the incoming plan", o3.import.text);
  assert(o3.import.mergeOffered === true, "merge option offered when a local plan exists");
  assert(o3.import.chipsBefore === 2 && o3.import.chips.length === 1 && o3.import.chips[0].startsWith("Zara"), "replace swaps local children for the shared one", JSON.stringify(o3.import.chips));
  assert(o3.import.setCells === 1 && o3.import.bookedCells === 1, "shared assignment lands with its booked tick", JSON.stringify({ set: o3.import.setCells, booked: o3.import.bookedCells }));
  assert(o3.import.bannerGone && o3.import.hashCleared, "banner closes and #plan= hash is dropped");
  assert(o3.import.storeChildren.join(",") === "Zara", "replacement persisted to localStorage", o3.import.storeChildren.join(","));
  assert((o3.jsErrors || []).length === 0, "no JS errors (run 3)", (o3.jsErrors || []).join("; "));

  const o4 = runOut(4); // run 4: second shared link → merge into local plan
  assert(o4.mode === "import" && o4.import.action === "merge", "run 4 takes the merge path");
  assert(o4.import.chipsBefore === 1 && o4.import.storeChildren.join(",") === "Zara,Omar", "merge keeps Zara and adds Omar", o4.import.storeChildren.join(","));
  assert(o4.import.setCells === 2 && o4.import.bookedCells === 1, "merge keeps existing cells and adds the shared one", JSON.stringify({ set: o4.import.setCells, booked: o4.import.bookedCells }));
  assert((o4.jsErrors || []).length === 0, "no JS errors (run 4)", (o4.jsErrors || []).join("; "));

  if (!RESULT_FILES) {
    rmSync(TMP, { recursive: true, force: true });
    rmSync(PROF, { recursive: true, force: true });
  }
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
    const importMode = /^#plan=/.test(location.hash);
    out.mode = importMode ? "import" : verify ? "verify" : "build";
    const grandText = () => { const g = $(".budget-card.grand"); return g ? g.textContent.replace(/\s+/g, " ").trim() : ""; };
    const cardTexts = () => [...$$(".budget-card")].map((c) => c.textContent.replace(/\s+/g, " ").trim());
    const bookingsCard = () => cardTexts().find((t) => t.indexOf("bookings made") >= 0) || "";

    if (out.mode === "build") {
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
      out.picker = {
        groups: [...dlg.querySelectorAll(".picker-group-title")].map((g) => g.textContent.trim()),
        weekBtns: dlg.querySelectorAll(".picker-option [data-pick-camp]").length,
        dayBtns: dlg.querySelectorAll(".picker-option [data-pick-camp-days]").length
      };
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
      // Strings via the "pick days" path: assigns and keeps the day editor open
      await open(6, maya);
      await pick('[data-pick-camp-days="the-strings-club-walthamstow"]');
      out.pickDaysFlow = { dialogStillOpen: dlg.open, editorShown: !!dlg.querySelector(".day-editor") };
      $("#pickerClose").click(); await sleep(120); // keep all 5 days → totals unchanged
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

      // camp-mode dialog: tapping a week reveals its day row (Chillie = Fridays only).
      // Self-contained — assigns Leo wk3 then removes it, so fixture totals are untouched.
      document.querySelector('[data-addplan="chillie-kids-club"]').click();
      await sleep(110);
      dlg.querySelector('[data-assign-week="3"][data-assign-child="' + leo + '"]').click();
      await sleep(110);
      const campDayChips = [...dlg.querySelectorAll('[data-camp-day][data-camp-day-week="3"][data-camp-day-child="' + leo + '"]')];
      out.campMode = {
        rowShown: campDayChips.length === 5,
        fridayOn: campDayChips.some((b) => b.dataset.campDay === "5" && b.classList.contains("is-on")),
        disabledCount: campDayChips.filter((b) => b.disabled).length,
        cost: (dlg.querySelector(".day-editor-cost") || { textContent: "" }).textContent.trim(),
        churchHillWk1: allowedDaysFor(providerById("church-hill-playscheme"), 1).join(",")
      };
      dlg.querySelector('[data-assign-week="3"][data-assign-child="' + leo + '"]').click();
      await sleep(110);
      out.campMode.removedAgain = !planEntry(3, leo);
      $("#pickerClose").click();
      await sleep(120);

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

      // calendar export
      const ics = window.E17_DEBUG && window.E17_DEBUG.planCalendarText();
      out.ics = ics ? {
        hasCal: ics.startsWith("BEGIN:VCALENDAR") && ics.includes("END:VCALENDAR"),
        events: (ics.match(/BEGIN:VEVENT/g) || []).length,
        lssWeekStart: ics.includes("DTSTART;VALUE=DATE:20260727"),
        ymcaMonWedEnd: ics.includes("DTEND;VALUE=DATE:20260730"),
        vestryTitle: ics.includes("SUMMARY:Maya: Vestry holiday club"),
        crlf: ics.includes("\r\n")
      } : { missing: true };

      // booked tracking: tick two bookings, then untick/re-tick one
      const toggleSel = (week, child) => '.booked-toggle[data-booked-week="' + week + '"][data-booked-child="' + child + '"]';
      const clickBooked = async (week, child) => { document.querySelector(toggleSel(week, child)).click(); await sleep(110); };
      out.booked = { toggles: $$(".booked-toggle").length };
      await clickBooked(1, leo);
      await clickBooked(2, maya);
      const leoToggle = document.querySelector(toggleSel(1, leo));
      out.booked.cellText = leoToggle.textContent.trim();
      out.booked.pressed = leoToggle.getAttribute("aria-pressed");
      out.booked.card = bookingsCard();
      await clickBooked(1, leo);
      out.booked.untoggled = document.querySelector(toggleSel(1, leo)).textContent.trim();
      out.booked.cardAfterUntoggle = bookingsCard();
      await clickBooked(1, leo); // back on — run 2 checks it survives reload
      const sb = JSON.parse(localStorage.getItem("e17planner.v1"));
      out.booked.stored = !!(sb.plan["1"][leo].booked && sb.plan["2"][maya].booked);

      // "Tell other parents": copies the plain tool link — NO #plan=, NO names.
      out.tell = { waBefore: !!($("#tellWa") && !$("#tellWa").hidden) };
      $("#tellParents").click();
      await sleep(140);
      const tellHref = ($("#tellWa") || { getAttribute: () => "" }).getAttribute("href") || "";
      out.tell.waShown = !!($("#tellWa") && !$("#tellWa").hidden);
      out.tell.cleanLink = tellHref.indexOf("#plan=") < 0;
      out.tell.noNames = tellHref.indexOf("Maya") < 0 && tellHref.indexOf("Leo") < 0;

      // "Share my plan (private)": guarded by a confirm() — accept it, then the
      // button reveals a wa.me link whose #plan= hash round-trips with the data.
      window.confirm = () => true;
      $("#sharePlan").click();
      await sleep(200);
      const wa = $("#waShare");
      const waHref = wa.getAttribute("href") || "";
      let payload = null;
      try {
        const hashPart = decodeURIComponent(waHref.split("text=")[1] || "").split("#plan=")[1] || "";
        const b64 = hashPart.replace(/-/g, "+").replace(/_/g, "/");
        const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
        payload = JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))));
      } catch (e) { payload = null; }
      out.share = {
        waShown: !wa.hidden,
        waTarget: waHref.indexOf("https://wa.me/?text=") === 0,
        children: payload && Array.isArray(payload.children) ? payload.children.map((c) => c.name) : [],
        planWeeks: payload && payload.plan ? Object.keys(payload.plan).length : 0,
        bookedCarried: !!(payload && payload.plan && payload.plan["1"] && payload.plan["1"][leo] && payload.plan["1"][leo].booked)
      };
      // Guard actually blocks when declined.
      window.confirm = () => false;
      $("#waShare").hidden = true;
      $("#sharePlan").click();
      await sleep(160);
      out.share.declinedStaysHidden = $("#waShare").hidden;
      window.confirm = () => true;
    } else if (out.mode === "import") {
      const banner = $("#shareBanner");
      const useMerge = location.search.indexOf("merge") >= 0;
      out.import = {
        bannerShown: !banner.hidden,
        title: (banner.querySelector(".share-banner-title") || {}).textContent || "",
        text: ($("#shareBannerText") || {}).textContent || "",
        mergeOffered: !$("#shareMerge").hidden,
        chipsBefore: $$(".child-chip").length,
        action: useMerge ? "merge" : "replace"
      };
      (useMerge ? $("#shareMerge") : $("#shareUse")).click();
      await sleep(160);
      const si = JSON.parse(localStorage.getItem("e17planner.v1"));
      out.import.chips = [...$$(".child-chip")].map((c) => c.textContent.trim().slice(0, 10));
      out.import.setCells = $$(".assign-btn.is-set").length;
      out.import.bookedCells = $$(".booked-toggle.is-booked").length;
      out.import.bannerGone = banner.hidden;
      out.import.hashCleared = location.hash.indexOf("plan=") < 0;
      out.import.storeChildren = si.children.map((c) => c.name);
    } else {
      out.persisted = {
        chips: $$(".child-chip").length,
        setCells: $$(".assign-btn.is-set").length,
        grandText: grandText(),
        bookedCells: $$(".booked-toggle.is-booked").length,
        bookingsCard: bookingsCard()
      };
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
