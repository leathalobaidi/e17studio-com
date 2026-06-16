/* HolidayCamp feature — provider-insights
 *
 * Insights reporting (views, search appearances, clicks, enquiries)  (provider side)
 *
 * Replicates Happity's "Insights" reporting tool. Evidence: support article
 * 8637826 ("Introducing Insights!"):
 *   - "Shows you how many times you have appeared in the search results and how
 *      many people have viewed your pages."
 *   - "Lets you know how many people have clicked on your website link"
 *   - "Reminds you how many customer enquiries you have received via Happity"
 *   - "Data displayed on this page can be adjusted to view a specific period of
 *      time, as seen in the drop down next to 'period'."
 *
 * Framed for SCHOOL-AGE HOLIDAY CAMPS (not baby classes). A camp provider's
 * Happity-style page accrues, day by day:
 *   - searchAppearances : times the camp showed up in parents' search results.
 *   - views             : times a parent opened the camp's page.
 *   - websiteClicks     : times a parent clicked the camp's website link.
 *   - enquiries         : customer enquiries received via HolidayCamp.
 *
 * The dashboard reports these four counts aggregated over a chosen PERIOD
 * (e.g. last 7 / 30 / 90 days), and the period dropdown changes the totals —
 * exactly like Happity's "period" selector.
 *
 * ACCEPTANCE CRITERION (asserted in selfTest):
 *   A dashboard reports listing views, search appearances, website clicks and
 *   enquiry counts over a period. i.e. report(providerId, period) returns those
 *   four counts summed across the selected window, and changing the period
 *   changes the totals (a longer window includes more days, never fewer events).
 *
 * Self-contained, defensive, no imports/exports. Calls HC.registerFeature.
 */
(function () {
  "use strict";

  // Defensive: never throw at module load if HC isn't present.
  if (typeof window === "undefined" || !window.HC || typeof window.HC.registerFeature !== "function") {
    if (typeof console !== "undefined" && console.warn) {
      console.warn("[HC] provider-insights: HC core not found; skipping registration.");
    }
    return;
  }

  var HC = window.HC;

  // Persisted MANUAL adjustments (e.g. a recorded enquiry) live here. The base
  // daily series is generated deterministically so the dashboard is stable
  // across reloads without us writing thousands of rows to the mock store.
  var STORE_KEY = "provider_insights_events"; // { <providerId>: [ {dateOffset, metric, n} ] }

  /* ===================================================================
     METRICS + PERIODS (the vocabulary of the report)
     =================================================================== */

  // The four headline metrics, in the order Happity lists them.
  var METRICS = [
    { key: "searchAppearances", label: "Search appearances", icon: "🔍",
      help: "Times your camp appeared in parents' search results." },
    { key: "views", label: "Page views", icon: "👀",
      help: "Times a parent opened your camp page." },
    { key: "websiteClicks", label: "Website clicks", icon: "🔗",
      help: "Times a parent clicked your website link." },
    { key: "enquiries", label: "Enquiries", icon: "✉️",
      help: "Customer enquiries received via HolidayCamp." }
  ];
  var METRIC_KEYS = METRICS.map(function (m) { return m.key; });

  // Selectable reporting windows (the "period" dropdown). days === null means
  // "all time" (every day on record).
  var PERIODS = [
    { key: "7d", label: "Last 7 days", days: 7 },
    { key: "30d", label: "Last 30 days", days: 30 },
    { key: "90d", label: "Last 90 days", days: 90 },
    { key: "all", label: "All time", days: null }
  ];
  var DEFAULT_PERIOD = "30d";
  // Total length of the synthetic history we model (days back from "today").
  var HISTORY_DAYS = 120;

  function asText(v) {
    return typeof v === "string" ? v : (v == null ? "" : String(v));
  }
  function toCount(v) {
    var n = Number(v);
    if (!isFinite(n) || n < 0) return 0;
    return Math.floor(n);
  }
  function isMetricKey(k) {
    return METRIC_KEYS.indexOf(asText(k)) !== -1;
  }
  function periodByKey(key) {
    for (var i = 0; i < PERIODS.length; i++) {
      if (PERIODS[i].key === key) return PERIODS[i];
    }
    return null;
  }
  // Resolve a period to its day-count window. Unknown -> default. null -> all.
  function periodDays(period) {
    var p = periodByKey(asText(period)) || periodByKey(DEFAULT_PERIOD);
    return p ? p.days : 30;
  }

  /* ===================================================================
     DETERMINISTIC BASE SERIES (DOM-free, pure)

     For a given provider we synthesise a stable, plausible daily count for
     each metric, keyed off a hash of the provider id + metric + day offset.
     Same inputs -> same numbers, every time (so the dashboard doesn't jump
     around between reloads, and tests are deterministic).
     =================================================================== */

  // Small, fast string hash -> unsigned 32-bit int.
  function hash32(str) {
    var s = asText(str);
    var h = 2166136261; // FNV-ish
    for (var i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = (h * 16777619) >>> 0;
    }
    return h >>> 0;
  }

  // Rough relative "weight" of each metric — a funnel: lots of search
  // appearances, fewer views, fewer clicks, fewest enquiries.
  var METRIC_BASE = {
    searchAppearances: 26,
    views: 9,
    websiteClicks: 3,
    enquiries: 1
  };

  // The base (generated) count for ONE metric on ONE day for ONE provider.
  // dayOffset 0 === today, 1 === yesterday, ... up to HISTORY_DAYS-1.
  function baseCount(providerId, metric, dayOffset) {
    if (!isMetricKey(metric)) return 0;
    var off = toCount(dayOffset);
    if (off >= HISTORY_DAYS) return 0; // outside the modelled history
    var seed = hash32(asText(providerId) + "|" + metric + "|" + off);
    var base = METRIC_BASE[metric] || 1;
    // Spread around the base by 0..base-1, so totals scale with the metric.
    var jitter = seed % (base || 1);
    var n = base + jitter;
    // Light weekly seasonality: school-age camps spike at weekends/holidays.
    // dayOffset alone can't know weekday without a clock; use seed parity for a
    // stable pseudo-weekly bump instead (deterministic, no Date dependency).
    if ((seed >> 8) % 7 === 0) n += Math.ceil(base / 2);
    return toCount(n);
  }

  /* ===================================================================
     PERSISTENCE (HC.store only — manual adjustments)

     Shape: { <providerId>: [ { dayOffset:Number, metric:String, n:Number } ] }
     These ADD to the base series (used when a provider/test records an enquiry).
     =================================================================== */

  function readAll() {
    try {
      var s = HC.store.get(STORE_KEY, {});
      return (s && typeof s === "object" && !Array.isArray(s)) ? s : {};
    } catch (e) { return {}; }
  }
  function writeAll(map) {
    try { return HC.store.set(STORE_KEY, (map && typeof map === "object") ? map : {}); }
    catch (e) { return false; }
  }
  function providerAdjustments(providerId) {
    var map = readAll();
    var pid = asText(providerId) || "_default";
    var arr = map[pid];
    return Array.isArray(arr) ? arr : [];
  }

  // Record a manual event (default: one enquiry today). dayOffset 0 = today.
  // Returns the saved adjustment row.
  function recordEvent(providerId, metric, n, dayOffset) {
    var map = readAll();
    var pid = asText(providerId) || "_default";
    if (!Array.isArray(map[pid])) map[pid] = [];
    var row = {
      dayOffset: toCount(dayOffset),
      metric: isMetricKey(metric) ? asText(metric) : "enquiries",
      n: Math.max(1, toCount(n) || 1)
    };
    map[pid].push(row);
    writeAll(map);
    return row;
  }

  function clearProvider(providerId) {
    var map = readAll();
    var pid = asText(providerId) || "_default";
    delete map[pid];
    writeAll(map);
  }

  // The count for ONE metric on ONE day = base + any manual adjustments.
  function dayCount(providerId, metric, dayOffset) {
    var total = baseCount(providerId, metric, dayOffset);
    var adj = providerAdjustments(providerId);
    for (var i = 0; i < adj.length; i++) {
      var a = adj[i];
      if (a && a.metric === metric && toCount(a.dayOffset) === toCount(dayOffset)) {
        total += toCount(a.n);
      }
    }
    return total;
  }

  /* ===================================================================
     THE REPORT (acceptance-criterion entry point) — pure, DOM-free

     report(providerId, period) ->
       {
         period, periodLabel, days,           // window in effect
         metrics: { searchAppearances, views, websiteClicks, enquiries },
         series: [ { dayOffset, searchAppearances, views, websiteClicks, enquiries } ],
         total                                // sum of all four headline metrics
       }
     Sums each metric across the selected window. A null window === all history.
     =================================================================== */

  function windowSize(period) {
    var d = periodDays(period);
    if (d === null || d === undefined) return HISTORY_DAYS; // all time
    // Clamp the window to the history we actually model.
    return Math.min(Math.max(1, toCount(d)), HISTORY_DAYS);
  }

  function report(providerId, period) {
    var pid = asText(providerId) || "_default";
    var p = periodByKey(asText(period)) || periodByKey(DEFAULT_PERIOD);
    var n = windowSize(period);

    var totals = {};
    for (var mi = 0; mi < METRIC_KEYS.length; mi++) totals[METRIC_KEYS[mi]] = 0;

    var series = [];
    // dayOffset 0 = today, going back (n-1). Inclusive window of n days.
    for (var off = 0; off < n; off++) {
      var row = { dayOffset: off };
      for (var k = 0; k < METRIC_KEYS.length; k++) {
        var key = METRIC_KEYS[k];
        var c = dayCount(pid, key, off);
        row[key] = c;
        totals[key] += c;
      }
      series.push(row);
    }

    var grand = 0;
    for (var g = 0; g < METRIC_KEYS.length; g++) grand += totals[METRIC_KEYS[g]];

    return {
      providerId: pid,
      period: p ? p.key : DEFAULT_PERIOD,
      periodLabel: p ? p.label : "Last 30 days",
      days: n,
      metrics: totals,
      series: series,
      total: grand
    };
  }

  // A downloadable-style summary line for each metric (used by the "Report"
  // button, mirroring Happity's "Click 'Report' to download this data!").
  function reportLines(rep) {
    var out = [];
    out.push("HolidayCamp Insights — " + rep.periodLabel + " (" + rep.days + " days)");
    for (var i = 0; i < METRICS.length; i++) {
      var m = METRICS[i];
      out.push(m.label + ": " + toCount(rep.metrics[m.key]));
    }
    return out;
  }

  /* ===================================================================
     UI
     =================================================================== */

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
  function escAttr(s) { return esc(s).replace(/"/g, "&quot;"); }

  function el(tag, attrs, html) {
    try { return HC.util.el(tag, attrs, html); }
    catch (e) {
      var n = document.createElement(tag || "div");
      if (html != null) n.innerHTML = html;
      return n;
    }
  }

  function demoProviderId() {
    try {
      var ps = HC.data.providers;
      if (ps && ps.length && ps[0] && ps[0].id) return ps[0].id;
    } catch (e) {}
    return "_demo_provider";
  }
  function demoProviderName(providerId) {
    try {
      var ps = HC.data.providers || [];
      for (var i = 0; i < ps.length; i++) {
        if (ps[i] && ps[i].id === providerId) return ps[i].name || providerId;
      }
    } catch (e) {}
    return "Your camp";
  }

  function metricCardHtml(m, value) {
    return '' +
      '<div class="hc-ins-card" data-metric="' + escAttr(m.key) + '" ' +
        'style="border:1.5px solid var(--line,#E6E6E6);border-radius:16px;padding:15px 16px;background:#fff;' +
        'box-shadow:var(--shadow,0 6px 22px rgba(96,52,136,.10))">' +
        '<div style="font-size:24px;line-height:1">' + esc(m.icon) + '</div>' +
        '<div data-metric-value="' + escAttr(m.key) + '" ' +
          'style="font-family:Quicksand,system-ui,sans-serif;font-weight:700;font-size:30px;' +
          'color:var(--purple,#603488);margin-top:4px">' + esc(toCount(value)) + '</div>' +
        '<div style="font-family:Quicksand,system-ui,sans-serif;font-weight:700;font-size:13.5px;' +
          'color:var(--text,#383838)">' + esc(m.label) + '</div>' +
        '<div style="font-size:11.5px;color:var(--muted,#808080);margin-top:3px">' + esc(m.help) + '</div>' +
      '</div>';
  }

  function dashHtml(rep) {
    var cards = "";
    for (var i = 0; i < METRICS.length; i++) {
      cards += metricCardHtml(METRICS[i], rep.metrics[METRICS[i].key]);
    }
    return '' +
      '<div class="hc-ins-grid" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px">' +
        cards +
      '</div>' +
      '<p data-ins-foot style="font-size:12px;color:var(--muted,#808080);margin:12px 0 0">' +
        'Showing <strong>' + esc(rep.periodLabel) + '</strong> · ' + esc(rep.days) +
        ' days on record · ' + esc(rep.total) + ' total signals.</p>';
  }

  function periodOptionsHtml(selectedKey) {
    var opts = "";
    for (var i = 0; i < PERIODS.length; i++) {
      var p = PERIODS[i];
      opts += '<option value="' + escAttr(p.key) + '"' +
        (p.key === selectedKey ? ' selected' : '') + '>' + esc(p.label) + '</option>';
    }
    return opts;
  }

  function render(mountEl) {
    try {
      if (!mountEl) return;
      var providerId = demoProviderId();
      var state = { period: DEFAULT_PERIOD };
      mountEl.innerHTML = "";

      var intro = el("div", null,
        '<p style="font-size:14px;color:var(--text,#383838);margin:0 0 4px">' +
          'Your <strong>Insights</strong> dashboard for <strong>' + esc(demoProviderName(providerId)) +
          '</strong>. It reports how many times your camp <strong>appeared in search</strong>, ' +
          'how many parents <strong>viewed your page</strong>, how many <strong>clicked your website</strong>, ' +
          'and how many <strong>enquiries</strong> you received — over the period you choose.</p>' +
        '<p style="font-size:12.5px;color:var(--muted,#808080);margin:0 0 10px">' +
          'Change the <strong>period</strong> dropdown and every count re-totals across that window — ' +
          'following the same marketplace pattern Insights.</p>');
      mountEl.appendChild(intro);

      // Period selector row.
      var controls = el("div", { style: "display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:0 0 14px" });
      controls.innerHTML =
        '<label for="hcInsPeriod" style="font-family:Quicksand,system-ui,sans-serif;font-weight:700;' +
          'font-size:13px;color:var(--purple,#603488)">Period</label>' +
        '<select id="hcInsPeriod" data-ins-period ' +
          'style="padding:8px 10px;border:1.5px solid var(--line,#E6E6E6);border-radius:10px;' +
          'font-family:inherit;font-size:13.5px">' + periodOptionsHtml(state.period) + '</select>' +
        '<button class="hc-btn hc-btn-ghost" type="button" data-ins-record ' +
          'style="padding:7px 12px;font-size:11.5px">Log an enquiry</button>' +
        '<button class="hc-btn" type="button" data-ins-report ' +
          'style="padding:7px 12px;font-size:11.5px">Report ⬇</button>';
      mountEl.appendChild(controls);

      var dashHost = el("div", { id: "hcInsDash" }, dashHtml(report(providerId, state.period)));
      mountEl.appendChild(dashHost);

      function refresh() {
        dashHost.innerHTML = dashHtml(report(providerId, state.period));
      }

      controls.addEventListener("change", function (e) {
        var sel = e.target && e.target.closest ? e.target.closest("[data-ins-period]") : null;
        if (!sel) return;
        state.period = sel.value;
        refresh();
      });

      controls.addEventListener("click", function (e) {
        var t = e.target;
        if (!t || !t.closest) return;

        if (t.closest("[data-ins-record]")) {
          recordEvent(providerId, "enquiries", 1, 0); // one enquiry today
          refresh();
          try { HC.util.toast("Logged 1 enquiry — totals updated"); } catch (er) {}
          return;
        }

        if (t.closest("[data-ins-report]")) {
          var rep = report(providerId, state.period);
          var lines = reportLines(rep);
          try {
            HC.util.modal('<h2>📊 Insights report</h2>' +
              '<p style="color:var(--muted,#808080);font-size:13px;margin:0 0 10px">' +
                'Snapshot you could download — ' + esc(rep.periodLabel) + '.</p>' +
              '<pre style="white-space:pre-wrap;font-family:ui-monospace,Menlo,monospace;font-size:13px;' +
                'background:var(--purple-tint,#F0E8F4);border-radius:12px;padding:14px;color:var(--text,#383838)">' +
                esc(lines.join("\n")) + '</pre>');
          } catch (er) {
            try { HC.util.toast(lines.join(" · ")); } catch (er2) {}
          }
          return;
        }
      });
    } catch (e) {
      try {
        mountEl.innerHTML = '<p style="color:#9a1f5e">Insights feature failed to render: ' +
          esc(e && e.message ? e.message : String(e)) + "</p>";
      } catch (e2) { /* give up quietly */ }
    }
  }

  /* ===================================================================
     selfTest
     =================================================================== */

  function selfTest() {
    var pass = 0, fail = 0, log = [];
    function check(label, fn) {
      try { fn(); pass += 1; log.push("✓ " + label); }
      catch (e) { fail += 1; log.push("✗ " + label + " — " + (e && e.message ? e.message : String(e))); }
    }

    var TP = "__selftest_insights_provider__";
    clearProvider(TP); // deterministic starting point (no manual adjustments)

    // ----- the four metrics exist and are ordered as Happity lists them -----
    check("Reports the four headline metrics: search appearances, views, clicks, enquiries", function () {
      HC.assert(METRIC_KEYS.length === 4, "expected 4 metrics, got " + METRIC_KEYS.length);
      HC.assert(METRIC_KEYS.indexOf("searchAppearances") !== -1, "search appearances metric present");
      HC.assert(METRIC_KEYS.indexOf("views") !== -1, "views metric present");
      HC.assert(METRIC_KEYS.indexOf("websiteClicks") !== -1, "website clicks metric present");
      HC.assert(METRIC_KEYS.indexOf("enquiries") !== -1, "enquiries metric present");
    });

    // ===== ACCEPTANCE CRITERION =====
    // A dashboard reports listing views, search appearances, website clicks and
    // enquiry counts over a period.

    var r30;
    check("report() returns all four counts over a period", function () {
      r30 = report(TP, "30d");
      HC.assert(r30 && typeof r30 === "object", "report should return an object");
      HC.assert(r30.metrics && typeof r30.metrics === "object", "report.metrics should be an object");
      // every metric present and a non-negative integer
      for (var i = 0; i < METRIC_KEYS.length; i++) {
        var k = METRIC_KEYS[i];
        var v = r30.metrics[k];
        HC.assert(typeof v === "number" && isFinite(v) && v >= 0 && Math.floor(v) === v,
          k + " should be a non-negative integer, got " + v);
      }
      HC.assert(r30.periodLabel === "Last 30 days", "30d period label should be 'Last 30 days'");
      HC.assert(r30.days === 30, "30d window should span 30 days, got " + r30.days);
    });

    check("Over a busy 30-day period the camp has real activity (counts > 0)", function () {
      HC.assert(r30.metrics.searchAppearances > 0, "should have search appearances");
      HC.assert(r30.metrics.views > 0, "should have page views");
      HC.assert(r30.metrics.websiteClicks > 0, "should have website clicks");
      HC.assert(r30.total ===
        r30.metrics.searchAppearances + r30.metrics.views +
        r30.metrics.websiteClicks + r30.metrics.enquiries,
        "total should equal the sum of the four metrics");
    });

    check("The daily series has one row per day in the window, each with all four metrics", function () {
      HC.assert(Array.isArray(r30.series), "series should be an array");
      HC.assert(r30.series.length === 30, "30d series should have 30 daily rows, got " + r30.series.length);
      // each row carries every metric, and the column sum equals the headline total
      var colSum = { searchAppearances: 0, views: 0, websiteClicks: 0, enquiries: 0 };
      for (var i = 0; i < r30.series.length; i++) {
        var row = r30.series[i];
        for (var k = 0; k < METRIC_KEYS.length; k++) {
          var key = METRIC_KEYS[k];
          HC.assert(typeof row[key] === "number", "row " + i + " missing metric " + key);
          colSum[key] += row[key];
        }
      }
      for (var m = 0; m < METRIC_KEYS.length; m++) {
        var key2 = METRIC_KEYS[m];
        HC.assert(colSum[key2] === r30.metrics[key2],
          key2 + " series sum (" + colSum[key2] + ") should equal headline total (" + r30.metrics[key2] + ")");
      }
    });

    // ===== Changing the PERIOD changes the totals =====

    check("Changing the period changes the window length", function () {
      var r7 = report(TP, "7d");
      var r90 = report(TP, "90d");
      HC.assert(r7.days === 7, "7d window should be 7 days");
      HC.assert(r90.days === 90, "90d window should be 90 days");
      HC.assert(r7.days < r30.days && r30.days < r90.days, "windows should grow 7 < 30 < 90");
    });

    check("A longer period includes more days and never fewer signals (monotonic)", function () {
      var r7 = report(TP, "7d");
      var r30b = report(TP, "30d");
      var r90 = report(TP, "90d");
      // The window is nested (always counts back from today), so totals are
      // monotonically non-decreasing as the window grows.
      for (var i = 0; i < METRIC_KEYS.length; i++) {
        var k = METRIC_KEYS[i];
        HC.assert(r7.metrics[k] <= r30b.metrics[k],
          k + ": 7d (" + r7.metrics[k] + ") should be <= 30d (" + r30b.metrics[k] + ")");
        HC.assert(r30b.metrics[k] <= r90.metrics[k],
          k + ": 30d (" + r30b.metrics[k] + ") should be <= 90d (" + r90.metrics[k] + ")");
      }
      // and strictly more activity over the whole 90d window than just 7d
      HC.assert(r90.total > r7.total,
        "90d total (" + r90.total + ") should exceed 7d total (" + r7.total + ")");
    });

    check("'All time' period reports the full modelled history", function () {
      var rAll = report(TP, "all");
      var r90 = report(TP, "90d");
      HC.assert(rAll.days === HISTORY_DAYS, "all-time window should span the full history (" + HISTORY_DAYS + ")");
      HC.assert(rAll.total >= r90.total, "all-time total should be >= 90d total");
    });

    // ===== Determinism (the dashboard doesn't jump between reloads) =====

    check("The report is deterministic for the same provider + period", function () {
      var a = report(TP, "30d");
      var b = report(TP, "30d");
      for (var i = 0; i < METRIC_KEYS.length; i++) {
        var k = METRIC_KEYS[i];
        HC.assert(a.metrics[k] === b.metrics[k], k + " should be identical across calls");
      }
      HC.assert(a.total === b.total, "total should be identical across calls");
    });

    check("Different providers get different insight numbers", function () {
      var x = report("camp-alpha-xyz", "30d");
      var y = report("camp-beta-uvw", "30d");
      // Extremely unlikely all four headline totals collide for two ids.
      var allEqual =
        x.metrics.searchAppearances === y.metrics.searchAppearances &&
        x.metrics.views === y.metrics.views &&
        x.metrics.websiteClicks === y.metrics.websiteClicks &&
        x.metrics.enquiries === y.metrics.enquiries;
      HC.assert(!allEqual, "two distinct providers should not have identical insight totals");
    });

    // ===== Recording an enquiry updates the reported count =====

    check("Logging an enquiry increases the enquiry count in the period", function () {
      var before = report(TP, "30d").metrics.enquiries;
      recordEvent(TP, "enquiries", 1, 0); // one enquiry today
      var after = report(TP, "30d").metrics.enquiries;
      HC.assert(after === before + 1, "enquiries should rise by 1 (" + before + " -> " + after + ")");
    });

    check("A logged enquiry only counts inside windows that include its day", function () {
      // record an enquiry 50 days ago — inside 90d/all, outside 7d/30d.
      var e7before = report(TP, "7d").metrics.enquiries;
      var e30before = report(TP, "30d").metrics.enquiries;
      var e90before = report(TP, "90d").metrics.enquiries;
      recordEvent(TP, "enquiries", 1, 50);
      HC.assert(report(TP, "7d").metrics.enquiries === e7before, "7d window should be unchanged (event is 50d old)");
      HC.assert(report(TP, "30d").metrics.enquiries === e30before, "30d window should be unchanged");
      HC.assert(report(TP, "90d").metrics.enquiries === e90before + 1, "90d window should include the 50d-old enquiry");
    });

    // ===== reportLines (the downloadable summary) =====

    check("reportLines produces one labelled line per metric plus a header", function () {
      var rep = report(TP, "30d");
      var lines = reportLines(rep);
      HC.assert(lines.length === METRICS.length + 1, "expected header + 4 metric lines, got " + lines.length);
      HC.assert(/Insights/.test(lines[0]), "first line should be the report header");
      HC.assert(/Search appearances:/.test(lines.join("\n")), "should list Search appearances");
      HC.assert(/Page views:/.test(lines.join("\n")), "should list Page views");
      HC.assert(/Website clicks:/.test(lines.join("\n")), "should list Website clicks");
      HC.assert(/Enquiries:/.test(lines.join("\n")), "should list Enquiries");
    });

    // ===== Defensive: garbage never throws =====

    check("Unknown period falls back to the default window", function () {
      var rep = report(TP, "not-a-period");
      HC.assert(rep.days === 30, "unknown period should default to 30 days, got " + rep.days);
    });

    check("Garbage provider ids and metrics are handled without throwing", function () {
      var bad = [null, undefined, 42, "", [], {}];
      for (var i = 0; i < bad.length; i++) {
        var rep = report(bad[i], bad[i]);
        HC.assert(rep && typeof rep.total === "number", "report should always return a numeric total");
      }
      HC.assert(baseCount(null, "not-a-metric", 0) === 0, "unknown metric base should be 0");
      HC.assert(baseCount("p", "views", -5) >= 0, "negative dayOffset should not throw or go negative");
    });

    // cleanup so repeated runs stay stable
    clearProvider(TP);

    return { pass: pass, fail: fail, log: log };
  }

  /* ===================================================================
     register
     =================================================================== */

  HC.registerFeature({
    id: "provider-insights",
    title: "Insights reporting",
    side: "provider",
    icon: "📊",
    summary: "A reporting dashboard for your camp's Happity-style page: how many times you appeared in search, how many parents viewed your page, clicked your website, and enquired — totalled over a period you choose (7 / 30 / 90 days or all time).",
    render: render,
    selfTest: selfTest
  });
})();
