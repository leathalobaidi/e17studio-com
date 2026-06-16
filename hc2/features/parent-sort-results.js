/* HolidayCamp feature module — parent-sort-results
 *
 * Side: PARENT.
 * Replicates Happity's "sort these results by distance or time" behaviour
 * (support article 8255669; 02-ia-ux §4.1), extended for school-age HOLIDAY
 * CAMPS with a price sort too.
 *
 * Acceptance criterion (asserted in selfTest):
 *   A sort control reorders the grid; default = distance, switchable to
 *   time / price.
 *
 * Design notes
 * - Self-contained: all sort logic is pure and lives in this module. render()
 *   draws a working mini results grid + a sort control inside mountEl; it makes
 *   NO assumptions about the live app DOM beyond the mountEl it is handed.
 * - Defensive: every read of provider/planner data is guarded so a missing or
 *   malformed field can never throw at registration time or during a sort.
 * - The chosen sort key persists via HC.store (key "sort.key"), never raw
 *   localStorage.
 *
 * Data realities (live HC.data):
 * - PRICE: planner price.day / dayExtended / week; HAF/Free camps are £0.
 * - TIME:  planner hours.start ("09:00") -> minutes-from-midnight (earliest
 *          opening first). Camps with no published start sort last.
 * - DISTANCE: the dataset has no lat/lng, so distance is modelled
 *          deterministically from each camp's `areas` relative to an E17 home
 *          area, with a stable per-camp jitter. Same input -> same order, so
 *          the control is testable and reproducible.
 */
(function () {
  "use strict";

  if (typeof window === "undefined" || !window.HC || typeof window.HC.registerFeature !== "function") {
    return; // nothing to attach to — fail silent, never throw.
  }
  var HC = window.HC;

  /* ---------------- pure helpers (no DOM) ---------------- */

  // Home reference: E17 / Walthamstow. Lower rank = closer to home.
  var HOME_AREA = "Walthamstow";
  var AREA_RANK = {
    "walthamstow": 0,
    "highams park": 1,
    "leyton": 2,
    "leytonstone": 2,
    "wood street": 1,
    "chingford": 3,
    "woodford": 4,
    "south woodford": 4,
    "loughton": 5,
    "waltham forest": 1,
    "borough-wide": 2
  };

  function safeArr(v) { return Array.isArray(v) ? v : []; }

  // Stable small jitter (0..0.9) from a string id, so equal-rank camps get a
  // deterministic but non-tied distance ordering.
  function hashJitter(id) {
    var s = String(id == null ? "" : id);
    var h = 0;
    for (var i = 0; i < s.length; i++) {
      h = (h * 31 + s.charCodeAt(i)) % 1000;
    }
    return (h % 10) / 10; // 0.0 .. 0.9
  }

  function plannerOf(p) {
    try {
      var pl = HC.data && HC.data.planner;
      if (!pl || !pl.byId || !p) return {};
      return pl.byId[p.id] || {};
    } catch (e) { return {}; }
  }

  function isFree(p) {
    try { return safeArr(p && p.funding).some(function (f) { return /free|haf/i.test(f); }); }
    catch (e) { return false; }
  }

  // --- DISTANCE (km, modelled & deterministic) ---
  function distanceKm(p) {
    if (!p) return 99;
    var areas = safeArr(p.areas);
    if (!areas.length && p.area) areas = [p.area];
    var best = 6; // default "far" if no recognised area
    for (var i = 0; i < areas.length; i++) {
      var key = String(areas[i] || "").toLowerCase().trim();
      // some areas are compound like "Lloyd Park / Higham Hill" — split on /
      var parts = key.split("/");
      for (var j = 0; j < parts.length; j++) {
        var k = parts[j].trim();
        if (Object.prototype.hasOwnProperty.call(AREA_RANK, k) && AREA_RANK[k] < best) {
          best = AREA_RANK[k];
        }
      }
    }
    // base km per rank + stable jitter so equal ranks order consistently
    return best * 1.2 + hashJitter(p.id);
  }

  // --- TIME (opening time -> minutes from midnight; earliest first) ---
  function openMinutes(p) {
    var pl = plannerOf(p);
    var hrs = pl && pl.hours;
    var start = hrs && typeof hrs.start === "string" ? hrs.start : null;
    if (!start) {
      // fall back to parsing the free-text hours on the provider record
      var raw = p && typeof p.hours === "string" ? p.hours : "";
      var m = raw.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
      if (m) {
        var hh = parseInt(m[1], 10) || 0;
        var mm = m[2] ? parseInt(m[2], 10) : 0;
        var ap = (m[3] || "").toLowerCase();
        if (ap === "pm" && hh < 12) hh += 12;
        if (ap === "am" && hh === 12) hh = 0;
        return hh * 60 + mm;
      }
      return 24 * 60 + 1; // unknown -> sort last
    }
    var sm = start.match(/^(\d{1,2}):(\d{2})$/);
    if (!sm) return 24 * 60 + 1;
    return (parseInt(sm[1], 10) || 0) * 60 + (parseInt(sm[2], 10) || 0);
  }

  // --- PRICE (min £/day; Free/HAF = 0; unknown = large so it sorts last) ---
  function minDayPrice(p) {
    if (isFree(p)) return 0;
    var pr = (plannerOf(p) || {}).price || {};
    if (typeof pr.day === "number" && isFinite(pr.day)) return pr.day;
    if (typeof pr.dayExtended === "number" && isFinite(pr.dayExtended)) return pr.dayExtended;
    if (typeof pr.week === "number" && isFinite(pr.week)) return Math.round(pr.week / 5);
    if (pr.weekByWeek && typeof pr.weekByWeek === "object") {
      var vals = Object.keys(pr.weekByWeek)
        .map(function (k) { return pr.weekByWeek[k]; })
        .filter(function (v) { return typeof v === "number" && isFinite(v); });
      if (vals.length) return Math.round(Math.min.apply(null, vals) / 5);
    }
    return Number.POSITIVE_INFINITY; // "Check provider" -> last
  }

  /* ---------------- the sort engine ---------------- */

  var SORTS = {
    distance: {
      label: "Distance",
      hint: "Nearest to E17 first",
      icon: "📍",
      value: distanceKm,
      compare: function (a, b) {
        var d = distanceKm(a) - distanceKm(b);
        if (d !== 0) return d;
        return String(a.id).localeCompare(String(b.id));
      }
    },
    time: {
      label: "Time",
      hint: "Earliest opening first",
      icon: "🕘",
      value: openMinutes,
      compare: function (a, b) {
        var d = openMinutes(a) - openMinutes(b);
        if (d !== 0) return d;
        return String(a.id).localeCompare(String(b.id));
      }
    },
    price: {
      label: "Price",
      hint: "Cheapest day rate first",
      icon: "💷",
      value: minDayPrice,
      compare: function (a, b) {
        var pa = minDayPrice(a), pb = minDayPrice(b);
        if (pa === pb) return String(a.id).localeCompare(String(b.id));
        // Infinity-safe comparison
        if (!isFinite(pa) && !isFinite(pb)) return String(a.id).localeCompare(String(b.id));
        if (!isFinite(pa)) return 1;
        if (!isFinite(pb)) return -1;
        return pa - pb;
      }
    }
  };

  var DEFAULT_KEY = "distance";

  function normaliseKey(k) {
    return (k === "time" || k === "price" || k === "distance") ? k : DEFAULT_KEY;
  }

  // Pure, defensive sort: returns a NEW array; never mutates the input.
  function sortResults(list, key) {
    var arr = safeArr(list).slice();
    var def = SORTS[normaliseKey(key)] || SORTS[DEFAULT_KEY];
    try {
      arr.sort(def.compare);
    } catch (e) {
      // a bad comparator must not break the page — fall back to id order
      arr.sort(function (a, b) { return String(a && a.id).localeCompare(String(b && b.id)); });
    }
    return arr;
  }

  /* ---------------- persistence ---------------- */
  var STORE_KEY = "sort.key";
  function getSavedKey() {
    try { return normaliseKey(HC.store.get(STORE_KEY, DEFAULT_KEY)); }
    catch (e) { return DEFAULT_KEY; }
  }
  function saveKey(k) {
    try { HC.store.set(STORE_KEY, normaliseKey(k)); } catch (e) { /* ignore */ }
  }

  /* ---------------- presentation helpers ---------------- */
  function money(n) {
    try { return HC.util.money(n); } catch (e) { return "£" + n; }
  }
  function badgeFor(p, key) {
    if (key === "price") {
      if (isFree(p)) return "Free / HAF";
      var pr = minDayPrice(p);
      return isFinite(pr) ? money(pr) + "/day" : "Check provider";
    }
    if (key === "time") {
      var mins = openMinutes(p);
      if (mins > 24 * 60) return "Opening time tbc";
      var hh = Math.floor(mins / 60), mm = mins % 60;
      return "Opens " + (hh < 10 ? "0" + hh : hh) + ":" + (mm < 10 ? "0" + mm : mm);
    }
    var km = distanceKm(p);
    return km.toFixed(1) + " km away";
  }

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  /* ---------------- the feature UI ---------------- */
  function render(mountEl) {
    if (!mountEl) return;
    var providers = [];
    try { providers = safeArr(HC.data.providers); } catch (e) { providers = []; }

    if (!providers.length) {
      mountEl.innerHTML = '<p style="color:var(--muted,#808080)">No camps available to sort yet.</p>';
      return;
    }

    var key = getSavedKey();

    mountEl.innerHTML =
      '<p style="font-size:14px;color:var(--text,#383838);margin:0 0 12px">' +
        'Just like Happity, you can reorder the results. Default is <strong>distance</strong> ' +
        '(nearest E17 camps first) — switch to <strong>time</strong> (earliest opening) or ' +
        '<strong>price</strong> (cheapest day rate).' +
      '</p>' +
      '<div class="hcsr-bar" style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:0 0 14px">' +
        '<label for="hcsrSel" style="font-family:Quicksand,system-ui,sans-serif;font-weight:700;' +
          'color:var(--purple,#603488);font-size:13px;text-transform:uppercase;letter-spacing:.4px">Sort by</label>' +
        '<select id="hcsrSel" style="font-family:Nunito Sans,system-ui,sans-serif;font-size:14px;' +
          'padding:8px 12px;border:1.5px solid var(--line,#E6E6E6);border-radius:999px;background:#fff;cursor:pointer">' +
          '<option value="distance">📍 Distance — nearest first</option>' +
          '<option value="time">🕘 Time — earliest opening</option>' +
          '<option value="price">💷 Price — cheapest day rate</option>' +
        '</select>' +
        '<span id="hcsrHint" style="color:var(--muted,#808080);font-size:12.5px"></span>' +
      '</div>' +
      '<ol id="hcsrGrid" style="list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:8px;' +
        'max-height:340px;overflow-y:auto"></ol>';

    var sel = mountEl.querySelector("#hcsrSel");
    var grid = mountEl.querySelector("#hcsrGrid");
    var hint = mountEl.querySelector("#hcsrHint");
    if (sel) sel.value = key;

    function paint(k) {
      k = normaliseKey(k);
      var ordered = sortResults(providers, k);
      var def = SORTS[k];
      if (hint) hint.textContent = def ? def.hint : "";
      var rows = "";
      for (var i = 0; i < ordered.length; i++) {
        var p = ordered[i];
        rows +=
          '<li data-id="' + esc(p.id) + '" style="display:flex;align-items:center;gap:12px;' +
            'padding:10px 12px;border:1px solid var(--line,#E6E6E6);border-radius:14px;background:#fff">' +
            '<span style="flex:0 0 26px;height:26px;width:26px;border-radius:50%;' +
              'background:var(--purple-tint,#F0E8F4);color:var(--purple,#603488);display:grid;place-items:center;' +
              'font-family:Quicksand,system-ui,sans-serif;font-weight:700;font-size:12px">' + (i + 1) + '</span>' +
            '<span style="flex:1;font-size:13.5px;color:var(--text,#383838)">' + esc(p.name) + '</span>' +
            '<span style="flex:0 0 auto;font-family:Quicksand,system-ui,sans-serif;font-weight:700;font-size:12px;' +
              'color:var(--magenta,#F82488);white-space:nowrap">' + esc(badgeFor(p, k)) + '</span>' +
          '</li>';
      }
      if (grid) grid.innerHTML = rows;
    }

    if (sel) {
      sel.addEventListener("change", function () {
        var k = normaliseKey(sel.value);
        saveKey(k);
        paint(k);
        try { HC.util.toast("Sorted by " + (SORTS[k] ? SORTS[k].label.toLowerCase() : k)); } catch (e) {}
      });
    }

    paint(key);
  }

  /* ---------------- enhance(): wire a sort control into the live app grid ---------------- */
  function enhance() {
    try {
      var grid = document.getElementById("grid");
      if (!grid || document.getElementById("hcsrLiveBar")) return;
      var resTitle = document.getElementById("resTitle");
      var anchor = resTitle && resTitle.parentNode ? resTitle.parentNode : grid.parentNode;
      if (!anchor) return;

      var bar = HC.util.el("div", { id: "hcsrLiveBar", style: "display:flex;gap:8px;align-items:center;margin:8px 0 4px" },
        '<span style="font-family:Quicksand,system-ui,sans-serif;font-weight:700;font-size:12px;' +
          'color:var(--purple,#603488);text-transform:uppercase;letter-spacing:.4px">Sort</span>' +
        '<select id="hcsrLiveSel" style="font-size:13px;padding:6px 10px;border:1.5px solid var(--line,#E6E6E6);' +
          'border-radius:999px;background:#fff;cursor:pointer">' +
          '<option value="distance">📍 Distance</option>' +
          '<option value="time">🕘 Time</option>' +
          '<option value="price">💷 Price</option>' +
        '</select>');
      anchor.insertBefore(bar, resTitle ? resTitle.nextSibling : anchor.firstChild);

      var liveSel = bar.querySelector("#hcsrLiveSel");
      if (liveSel) {
        liveSel.value = getSavedKey();
        liveSel.addEventListener("change", function () {
          var k = normaliseKey(liveSel.value);
          saveKey(k);
          reorderLiveGrid(k);
          try { HC.util.toast("Sorted by " + (SORTS[k] ? SORTS[k].label.toLowerCase() : k)); } catch (e) {}
        });
        reorderLiveGrid(getSavedKey());
      }
    } catch (e) { /* enhance is best-effort; never throw */ }
  }

  // Reorder the real app cards in #grid by data-open=id, using the sort engine.
  function reorderLiveGrid(key) {
    try {
      var grid = document.getElementById("grid");
      if (!grid) return;
      var cards = Array.prototype.slice.call(grid.querySelectorAll(".card[data-open]"));
      if (!cards.length) return;
      var byId = {};
      safeArr(HC.data.providers).forEach(function (p) { byId[p.id] = p; });
      var ordered = sortResults(cards.map(function (c) {
        return byId[c.getAttribute("data-open")] || { id: c.getAttribute("data-open") };
      }), key);
      ordered.forEach(function (p) {
        var card = grid.querySelector('.card[data-open="' + (window.CSS && CSS.escape ? CSS.escape(p.id) : p.id) + '"]');
        if (card) grid.appendChild(card); // re-append in sorted order
      });
    } catch (e) { /* never throw from enhance reorder */ }
  }

  /* ---------------- selfTest(): exercise the LOGIC ---------------- */
  function selfTest() {
    var pass = 0, fail = 0, log = [];
    function check(label, fn) {
      try { fn(); pass++; log.push("✓ " + label); }
      catch (e) { fail++; log.push("✗ " + label + " — " + (e && e.message ? e.message : String(e))); }
    }

    // Fixed fixture so the test is independent of the live dataset's exact rows,
    // but we ALSO run against live HC.data.providers below.
    var fixture = [
      { id: "far-cheap-late", name: "Far Cheap Late", areas: ["Loughton"] },           // far, low price, opens late
      { id: "near-mid-early", name: "Near Mid Early", areas: ["Walthamstow"] },         // nearest
      { id: "mid-free-mid",   name: "Mid Free Mid",   areas: ["Leyton"], funding: ["Free/HAF"] } // free
    ];
    // Patch a private planner lookup for the fixture via a temporary shim so the
    // pure helpers read prices/times. We do this by temporarily extending the
    // real planner.byId, then restoring it.
    var planner = (HC.data && HC.data.planner) || {};
    var byId = planner.byId || {};
    var saved = {};
    ["far-cheap-late", "near-mid-early", "mid-free-mid"].forEach(function (k) { saved[k] = byId[k]; });
    var restore = function () {
      ["far-cheap-late", "near-mid-early", "mid-free-mid"].forEach(function (k) {
        if (saved[k] === undefined) { try { delete byId[k]; } catch (e) {} } else { byId[k] = saved[k]; }
      });
    };
    try {
      byId["far-cheap-late"] = { price: { day: 20 }, hours: { start: "10:00" } };
      byId["near-mid-early"] = { price: { day: 45 }, hours: { start: "08:00" } };
      byId["mid-free-mid"]   = { price: {},         hours: { start: "09:00" } };

      // 1. There are exactly three sort keys, default is distance.
      check("Three sort keys exist; default is distance", function () {
        HC.assert(typeof SORTS.distance === "object", "distance sort missing");
        HC.assert(typeof SORTS.time === "object", "time sort missing");
        HC.assert(typeof SORTS.price === "object", "price sort missing");
        HC.assert(DEFAULT_KEY === "distance", "default sort should be distance, got " + DEFAULT_KEY);
      });

      // 2. DEFAULT (distance) puts the nearest E17 camp first.
      check("Default distance sort: nearest (Walthamstow) first", function () {
        var out = sortResults(fixture, undefined); // undefined -> default
        HC.assert(out[0].id === "near-mid-early",
          "expected near-mid-early first, got " + out[0].id);
        HC.assert(out[out.length - 1].id === "far-cheap-late",
          "expected far-cheap-late last, got " + out[out.length - 1].id);
      });

      // 3. SWITCH to time -> earliest opening first (08:00 before 09:00 before 10:00).
      check("Time sort: earliest opening (08:00) first", function () {
        var out = sortResults(fixture, "time");
        HC.assert(out[0].id === "near-mid-early", "expected 08:00 camp first, got " + out[0].id);
        HC.assert(out[1].id === "mid-free-mid", "expected 09:00 camp second, got " + out[1].id);
        HC.assert(out[2].id === "far-cheap-late", "expected 10:00 camp last, got " + out[2].id);
      });

      // 4. SWITCH to price -> cheapest first; Free/HAF (£0) beats £20 beats £45.
      check("Price sort: Free/HAF (£0) first, then £20, then £45", function () {
        var out = sortResults(fixture, "price");
        HC.assert(out[0].id === "mid-free-mid", "expected free camp first, got " + out[0].id);
        HC.assert(out[1].id === "far-cheap-late", "expected £20 camp second, got " + out[1].id);
        HC.assert(out[2].id === "near-mid-early", "expected £45 camp last, got " + out[2].id);
      });

      // 5. The control REORDERS the grid: distance order != price order here.
      check("Switching sort reorders the grid (distance order != price order)", function () {
        var byDist = sortResults(fixture, "distance").map(function (p) { return p.id; }).join(",");
        var byPrice = sortResults(fixture, "price").map(function (p) { return p.id; }).join(",");
        HC.assert(byDist !== byPrice, "distance and price produced the same order: " + byDist);
      });

      // 6. Sort is pure: it does not mutate the input array.
      check("sortResults does not mutate the input array", function () {
        var before = fixture.map(function (p) { return p.id; }).join(",");
        sortResults(fixture, "price");
        var after = fixture.map(function (p) { return p.id; }).join(",");
        HC.assert(before === after, "input array order changed: " + before + " -> " + after);
      });

      // 7. Defensive: unknown key falls back to distance; junk input never throws.
      check("Unknown sort key falls back to distance; junk input is safe", function () {
        var a = sortResults(fixture, "wibble").map(function (p) { return p.id; }).join(",");
        var b = sortResults(fixture, "distance").map(function (p) { return p.id; }).join(",");
        HC.assert(a === b, "unknown key did not fall back to distance");
        HC.assert(sortResults(null, "price").length === 0, "null list should yield []");
        HC.assert(sortResults([{ id: "x" }, { id: "y" }], "time").length === 2, "missing fields should not drop rows");
      });

      // 8. Persistence round-trips through HC.store (mock localStorage).
      check("Chosen sort key persists via HC.store", function () {
        var prev = getSavedKey();
        saveKey("price");
        HC.assert(getSavedKey() === "price", "store did not persist 'price'");
        saveKey("time");
        HC.assert(getSavedKey() === "time", "store did not persist 'time'");
        saveKey(prev); // restore
      });

      // 9. Live-data sanity: every sort produces a full, complete ordering of
      //    the real directory (no rows lost, all rows present once).
      check("Live directory: each sort returns a complete permutation", function () {
        var live = safeArr(HC.data.providers);
        if (!live.length) { HC.assert(true, "no live data in this context — skipped"); return; }
        ["distance", "time", "price"].forEach(function (k) {
          var out = sortResults(live, k);
          HC.assert(out.length === live.length,
            k + " sort changed row count " + live.length + " -> " + out.length);
          var ids = {};
          out.forEach(function (p) { ids[p.id] = (ids[p.id] || 0) + 1; });
          live.forEach(function (p) { HC.assert(ids[p.id] === 1, k + " sort dropped/duped " + p.id); });
        });
      });

      // 10. Live price sort is monotonic non-decreasing on resolvable prices.
      check("Live price sort is non-decreasing on resolvable day rates", function () {
        var live = safeArr(HC.data.providers);
        if (!live.length) { HC.assert(true, "no live data — skipped"); return; }
        var out = sortResults(live, "price");
        var last = -Infinity;
        for (var i = 0; i < out.length; i++) {
          var v = minDayPrice(out[i]);
          if (!isFinite(v)) break; // unknowns are pushed to the end; stop checking
          HC.assert(v >= last, "price order not non-decreasing at index " + i + " (" + v + " < " + last + ")");
          last = v;
        }
      });
    } finally {
      restore();
    }

    return { pass: pass, fail: fail, log: log };
  }

  /* ---------------- register ---------------- */
  HC.registerFeature({
    id: "parent-sort-results",
    title: "Sort results (distance / time / price)",
    side: "parent",
    icon: "↕️",
    summary: "Reorder the camp results like Happity — default nearest first, switch to earliest opening time or cheapest day rate.",
    render: render,
    enhance: enhance,
    selfTest: selfTest
  });
})();
