/* HolidayCamp — HC plugin core.
 *
 * Loads BEFORE app.js. Provides window.HC: a small, framework-free feature
 * registry + test harness for HOLIDAY CAMPS (school-age). Feature modules live
 * in features/<id>.js, each calling HC.registerFeature({...}) at top level.
 *
 * This file injects its own DOM (a "⚙️ Features" hub + a floating "Run all
 * tests" panel) and never touches app.js's existing logic. It coexists with
 * app.js routing by hiding its hub whenever a [data-view] nav item is clicked.
 *
 * Nothing here is a real backend: persistence is mock localStorage under "hc_".
 */
(function () {
  "use strict";

  /* ---------- assert ---------- */
  function assert(cond, msg) {
    if (!cond) throw new Error(msg || "Assertion failed");
    return true;
  }

  /* ---------- namespaced mock store (hc_ prefix) ---------- */
  var STORE_PREFIX = "hc_";
  var store = {
    _key: function (k) { return STORE_PREFIX + k; },
    get: function (k, def) {
      try {
        var raw = localStorage.getItem(STORE_PREFIX + k);
        if (raw === null || raw === undefined) return def === undefined ? null : def;
        return JSON.parse(raw);
      } catch (e) {
        return def === undefined ? null : def;
      }
    },
    set: function (k, v) {
      try {
        localStorage.setItem(STORE_PREFIX + k, JSON.stringify(v));
        return true;
      } catch (e) {
        return false;
      }
    },
    remove: function (k) {
      try { localStorage.removeItem(STORE_PREFIX + k); return true; } catch (e) { return false; }
    }
  };

  /* ---------- util ---------- */
  function money(n) {
    var num = Number(n);
    if (!isFinite(num)) return "£0";
    return "£" + (Number.isInteger(num) ? num : num.toFixed(2));
  }

  function el(tag, attrs, html) {
    var node = document.createElement(tag || "div");
    if (attrs) {
      for (var k in attrs) {
        if (!Object.prototype.hasOwnProperty.call(attrs, k)) continue;
        var v = attrs[k];
        if (v === null || v === undefined || v === false) continue;
        if (k === "class" || k === "className") node.className = v;
        else if (k === "style") node.setAttribute("style", v);
        else if (k === "dataset" && typeof v === "object") {
          for (var d in v) { if (Object.prototype.hasOwnProperty.call(v, d)) node.dataset[d] = v[d]; }
        } else if (k.indexOf("on") === 0 && typeof v === "function") {
          node.addEventListener(k.slice(2).toLowerCase(), v);
        } else {
          node.setAttribute(k, v);
        }
      }
    }
    if (html !== undefined && html !== null) node.innerHTML = html;
    return node;
  }

  function toast(msg) {
    try {
      var t = el("div", { class: "hc-toast", role: "status" }, String(msg));
      document.body.appendChild(t);
      // force reflow then animate in
      void t.offsetWidth;
      t.classList.add("hc-toast-in");
      setTimeout(function () {
        t.classList.remove("hc-toast-in");
        setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 320);
      }, 2400);
    } catch (e) { /* defensive: never throw from a toast */ }
  }

  var _modalHost = null;
  function modal(html) {
    // Own modal host so we never collide with app.js's #modalRoot.
    if (!_modalHost) {
      _modalHost = el("div", { id: "hcModalRoot" });
      document.body.appendChild(_modalHost);
    }
    _modalHost.innerHTML =
      '<div class="hc-overlay" data-hc-overlay>' +
        '<div class="hc-dialog" role="dialog" aria-modal="true">' +
          '<button class="hc-x" data-hc-close aria-label="Close">×</button>' +
          '<div class="hc-dialog-body">' + (html || "") + "</div>" +
        "</div>" +
      "</div>";
    return _modalHost;
  }
  function closeModal() { if (_modalHost) _modalHost.innerHTML = ""; }

  var _uidSeq = 0;
  function uid() {
    _uidSeq += 1;
    return "hc_" + Date.now().toString(36) + "_" + (_uidSeq).toString(36) +
      "_" + Math.floor(Math.random() * 1e6).toString(36);
  }

  /* ---------- live data (reads app.js's globals) ---------- */
  var data = {
    get providers() {
      return (window.E17_DIRECTORY && window.E17_DIRECTORY.providers) || [];
    },
    get planner() {
      return window.E17_PLANNER || { byId: {}, weeks: [], keyDates: {} };
    }
  };

  /* ---------- registry ---------- */
  var features = [];

  function registerFeature(def) {
    try {
      if (!def || typeof def !== "object") throw new Error("registerFeature: def required");
      if (!def.id) throw new Error("registerFeature: def.id required");
      if (features.some(function (f) { return f.id === def.id; })) {
        // Idempotent: a double-included module should not blow up.
        return null;
      }
      var feature = {
        id: String(def.id),
        title: def.title || def.id,
        side: (def.side === "parent" || def.side === "provider" || def.side === "platform") ? def.side : "platform",
        icon: def.icon || "✨",
        summary: def.summary || "",
        render: typeof def.render === "function" ? def.render : function (mountEl) {
          mountEl.innerHTML = '<p style="color:var(--muted)">No preview for this feature yet.</p>';
        },
        enhance: typeof def.enhance === "function" ? def.enhance : null,
        selfTest: typeof def.selfTest === "function" ? def.selfTest : null
      };
      features.push(feature);
      return feature;
    } catch (e) {
      // A broken feature must never throw at registration time.
      if (window.console && console.warn) console.warn("[HC] registerFeature failed:", e && e.message);
      return null;
    }
  }

  /* ---------- test runner ---------- */
  function runTests() {
    var results = [];
    var pass = 0, fail = 0;
    for (var i = 0; i < features.length; i++) {
      var f = features[i];
      if (typeof f.selfTest !== "function") continue;
      var ok = false, error = null, sub = null;
      try {
        var out = f.selfTest();
        // selfTest returns { pass:Number, fail:Number, log:[String] }
        if (out && typeof out === "object") {
          sub = {
            pass: Number(out.pass) || 0,
            fail: Number(out.fail) || 0,
            log: Array.isArray(out.log) ? out.log : []
          };
          ok = sub.fail === 0 && sub.pass > 0;
          if (!ok && sub.fail === 0 && sub.pass === 0) {
            // produced no assertions — treat as a soft fail with a hint
            error = "selfTest ran but asserted nothing";
          } else if (!ok) {
            error = sub.fail + " of " + (sub.pass + sub.fail) + " checks failed";
          }
        } else {
          ok = false;
          error = "selfTest did not return {pass,fail,log}";
        }
      } catch (e) {
        ok = false;
        error = (e && e.message) ? e.message : String(e);
      }
      if (ok) pass += 1; else fail += 1;
      results.push({ id: f.id, name: f.title, ok: ok, error: error, detail: sub });
    }
    return { total: results.length, pass: pass, fail: fail, results: results };
  }

  /* ---------- public API ---------- */
  var HC = {
    features: features,
    registerFeature: registerFeature,
    assert: assert,
    data: data,
    store: store,
    util: {
      money: money,
      el: el,
      toast: toast,
      modal: modal,
      closeModal: closeModal,
      uid: uid
    },
    runTests: runTests
  };
  window.HC = HC;

  /* ================================================================
     UI layer — injected DOM. Runs after DOM is ready and after the
     feature modules + app.js have had a chance to register/boot.
     ================================================================ */

  function injectStyles() {
    if (document.getElementById("hc-core-styles")) return;
    var css =
      ".hc-toast{position:fixed;left:50%;bottom:96px;transform:translate(-50%,12px);background:var(--purple,#603488);color:#fff;" +
        "font-family:'Quicksand',system-ui,sans-serif;font-weight:700;font-size:14px;padding:11px 18px;border-radius:999px;" +
        "box-shadow:0 8px 24px rgba(96,52,136,.3);z-index:120;opacity:0;transition:opacity .25s,transform .25s;pointer-events:none;max-width:80vw;text-align:center}" +
      ".hc-toast-in{opacity:1;transform:translate(-50%,0)}" +
      ".hc-overlay{position:fixed;inset:0;background:rgba(40,20,60,.45);z-index:130;display:grid;place-items:center;padding:20px}" +
      ".hc-dialog{background:#fff;border-radius:22px;max-width:640px;width:100%;max-height:88vh;overflow-y:auto;" +
        "box-shadow:0 24px 60px rgba(0,0,0,.3);position:relative}" +
      ".hc-x{position:absolute;top:12px;right:14px;background:none;border:none;font-size:24px;color:var(--muted,#808080);cursor:pointer;line-height:1;z-index:2}" +
      ".hc-dialog-body{padding:24px 26px 28px}" +
      ".hc-dialog-body h2{font-family:'Quicksand',system-ui,sans-serif;color:var(--purple,#603488);margin:0 0 4px;font-size:23px}" +
      ".hc-hub{padding:30px 0 60px}" +
      ".hc-hub h2{font-family:'Quicksand',system-ui,sans-serif;font-size:30px;color:var(--purple,#603488);margin:0 0 6px}" +
      ".hc-hub .hc-lead{font-size:17px;color:var(--text,#383838);max-width:680px;margin:0 0 8px}" +
      ".hc-sidehead{font-family:'Quicksand',system-ui,sans-serif;color:var(--magenta,#F82488);text-transform:uppercase;letter-spacing:.6px;" +
        "font-size:13px;font-weight:700;margin:26px 0 10px}" +
      ".hc-cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:18px}" +
      ".hc-fcard{border:1.5px solid var(--line,#E6E6E6);border-radius:var(--radius,18px);padding:18px;background:#fff;" +
        "box-shadow:var(--shadow,0 6px 22px rgba(96,52,136,.10));display:flex;flex-direction:column;gap:8px}" +
      ".hc-fcard .hc-fic{font-size:30px}" +
      ".hc-fcard h3{font-family:'Quicksand',system-ui,sans-serif;color:var(--purple,#603488);font-size:17px;margin:2px 0 0}" +
      ".hc-fcard p{font-size:13.5px;color:var(--text,#383838);margin:0;flex:1}" +
      ".hc-fcard .hc-frow{display:flex;gap:8px;margin-top:6px}" +
      ".hc-badge-side{align-self:flex-start;font-size:10.5px;font-weight:700;padding:3px 9px;border-radius:999px;" +
        "background:var(--purple-tint,#F0E8F4);color:var(--purple,#603488);text-transform:uppercase;letter-spacing:.3px}" +
      ".hc-btn{display:inline-block;border:none;cursor:pointer;font-family:'Quicksand',system-ui,sans-serif;font-weight:700;" +
        "text-transform:uppercase;letter-spacing:.5px;background:var(--yellow,#FCD400);color:var(--ink,#1A1A1A);padding:9px 15px;" +
        "border-radius:999px;font-size:12.5px}" +
      ".hc-btn:hover{background:#ffdf2e}" +
      ".hc-btn-ghost{background:transparent;color:var(--purple,#603488);border:1.5px solid var(--purple-tint,#F0E8F4)}" +
      ".hc-btn-ghost:hover{background:var(--purple-tint,#F0E8F4)}" +
      ".hc-fab{position:fixed;right:20px;bottom:20px;z-index:110;background:var(--magenta,#F82488);color:#fff;border:none;cursor:pointer;" +
        "font-family:'Quicksand',system-ui,sans-serif;font-weight:700;font-size:14px;padding:13px 18px;border-radius:999px;" +
        "box-shadow:0 8px 24px rgba(248,36,136,.35);display:flex;align-items:center;gap:8px}" +
      ".hc-fab:hover{background:#ff3d97}" +
      ".hc-report{font-family:'Nunito Sans',system-ui,sans-serif}" +
      ".hc-report .hc-summary{display:flex;gap:14px;flex-wrap:wrap;margin:10px 0 18px}" +
      ".hc-pill{font-family:'Quicksand',system-ui,sans-serif;font-weight:700;border-radius:14px;padding:10px 16px;font-size:15px}" +
      ".hc-pill-pass{background:#E1F0E4;color:#2f7d4f}" +
      ".hc-pill-fail{background:var(--pink-tint,#FCE8F0);color:#9a1f5e}" +
      ".hc-pill-total{background:var(--purple-tint,#F0E8F4);color:var(--purple,#603488)}" +
      ".hc-rrow{display:flex;align-items:flex-start;gap:10px;padding:10px 0;border-bottom:1px solid var(--line,#E6E6E6);font-size:14px}" +
      ".hc-rdot{flex:0 0 22px;height:22px;width:22px;border-radius:50%;display:grid;place-items:center;color:#fff;font-size:13px;font-weight:700}" +
      ".hc-rdot.ok{background:#2f7d4f}.hc-rdot.bad{background:var(--magenta,#F82488)}" +
      ".hc-rname{font-family:'Quicksand',system-ui,sans-serif;font-weight:700;color:var(--purple,#603488)}" +
      ".hc-rerr{color:#9a1f5e;font-size:12.5px;margin-top:2px}" +
      ".hc-rmeta{color:var(--muted,#808080);font-size:12px;margin-top:2px}";
    var styleEl = el("style", { id: "hc-core-styles" }, css);
    document.head.appendChild(styleEl);
  }

  function featureMount() {
    var host = document.getElementById("hcFeatureView");
    if (!host) {
      host = el("main", { id: "hcFeatureView", class: "wrap hc-hub hidden" });
      // Insert after the last app view section if possible, else append to body.
      var anchor = document.getElementById("dashView") ||
        document.querySelector("footer.site") || document.body;
      if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(host, anchor.nextSibling);
      else document.body.appendChild(host);
    }
    return host;
  }

  function sideLabel(side) {
    if (side === "parent") return "Parent side";
    if (side === "provider") return "Provider side";
    return "Platform";
  }

  function renderHub() {
    var host = featureMount();
    var order = ["parent", "provider", "platform"];
    var html = '<h2>⚙️ Features</h2>' +
      '<p class="hc-lead">Every HolidayCamp plugin feature, grouped by side. ' +
      "Open a feature to preview it, or run its self-test. These are school-age holiday-camp features — not baby classes.</p>";

    if (!features.length) {
      html += '<p style="color:var(--muted)">No feature modules registered yet.</p>';
    }

    for (var s = 0; s < order.length; s++) {
      var side = order[s];
      var group = features.filter(function (f) { return f.side === side; });
      if (!group.length) continue;
      html += '<div class="hc-sidehead">' + sideLabel(side) + " · " + group.length + "</div>";
      html += '<div class="hc-cards">';
      for (var i = 0; i < group.length; i++) {
        var f = group[i];
        html += '<div class="hc-fcard">' +
          '<span class="hc-badge-side">' + sideLabel(f.side) + "</span>" +
          '<div class="hc-fic">' + (f.icon || "✨") + "</div>" +
          "<h3>" + escapeHtml(f.title) + "</h3>" +
          "<p>" + escapeHtml(f.summary || "") + "</p>" +
          '<div class="hc-frow">' +
            '<button class="hc-btn" data-hc-open="' + escapeAttr(f.id) + '">Open</button>' +
            (f.selfTest ? '<button class="hc-btn hc-btn-ghost" data-hc-test="' + escapeAttr(f.id) + '">Test</button>' : "") +
          "</div>" +
        "</div>";
      }
      html += "</div>";
    }
    host.innerHTML = html;
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
  function escapeAttr(s) {
    return escapeHtml(s).replace(/"/g, "&quot;");
  }

  function showHub() {
    renderHub();
    var host = featureMount();
    // Hide app.js views so the hub stands alone.
    ["browse", "providersView", "savedView", "dashView"].forEach(function (id) {
      var n = document.getElementById(id);
      if (n) n.classList.add("hidden");
    });
    host.classList.remove("hidden");
    document.querySelectorAll("#nav a").forEach(function (a) { a.classList.remove("active"); });
    var link = document.getElementById("hcFeaturesLink");
    if (link) link.classList.add("active");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function hideHub() {
    var host = document.getElementById("hcFeatureView");
    if (host) host.classList.add("hidden");
    var link = document.getElementById("hcFeaturesLink");
    if (link) link.classList.remove("active");
  }

  function openFeature(id) {
    var f = features.filter(function (x) { return x.id === id; })[0];
    if (!f) return;
    modal('<h2>' + escapeHtml(f.icon + " " + f.title) + "</h2>" +
      '<p style="color:var(--muted,#808080);font-size:13.5px;margin:0 0 14px">' +
        sideLabel(f.side) + (f.summary ? " · " + escapeHtml(f.summary) : "") + "</p>" +
      '<div id="hcFeatureMount"></div>');
    var mountEl = document.getElementById("hcFeatureMount");
    try {
      f.render(mountEl);
    } catch (e) {
      mountEl.innerHTML = '<p style="color:#9a1f5e">This feature failed to render: ' +
        escapeHtml(e && e.message ? e.message : String(e)) + "</p>";
    }
  }

  function testOne(id) {
    var f = features.filter(function (x) { return x.id === id; })[0];
    if (!f || typeof f.selfTest !== "function") { toast("No self-test for this feature"); return; }
    var ok, line;
    try {
      var out = f.selfTest();
      var p = (out && Number(out.pass)) || 0, fl = (out && Number(out.fail)) || 0;
      ok = fl === 0 && p > 0;
      line = f.title + ": " + p + " passed, " + fl + " failed";
    } catch (e) {
      ok = false;
      line = f.title + ": threw — " + (e && e.message ? e.message : String(e));
    }
    toast((ok ? "✓ " : "✗ ") + line);
  }

  function showReport() {
    var r = runTests();
    var rows = "";
    for (var i = 0; i < r.results.length; i++) {
      var res = r.results[i];
      var meta = res.detail
        ? (res.detail.pass + " passed · " + res.detail.fail + " failed")
        : "";
      rows += '<div class="hc-rrow">' +
        '<span class="hc-rdot ' + (res.ok ? "ok" : "bad") + '">' + (res.ok ? "✓" : "✗") + "</span>" +
        "<div>" +
          '<div class="hc-rname">' + escapeHtml(res.name) + "</div>" +
          (meta ? '<div class="hc-rmeta">' + escapeHtml(meta) + "</div>" : "") +
          (res.error ? '<div class="hc-rerr">' + escapeHtml(res.error) + "</div>" : "") +
        "</div>" +
      "</div>";
    }
    if (!r.results.length) rows = '<p style="color:var(--muted)">No features expose a self-test yet.</p>';

    modal('<div class="hc-report">' +
      '<h2>✓ Test results</h2>' +
      '<p style="color:var(--muted,#808080);font-size:13.5px;margin:0">' +
        "Ran every registered feature's selfTest()." + "</p>" +
      '<div class="hc-summary">' +
        '<span class="hc-pill hc-pill-total">' + r.total + " features</span>" +
        '<span class="hc-pill hc-pill-pass">' + r.pass + " passed</span>" +
        '<span class="hc-pill hc-pill-fail">' + r.fail + " failed</span>" +
      "</div>" +
      rows +
    "</div>");
  }

  function injectNavAndFab() {
    var nav = document.getElementById("nav");
    if (nav && !document.getElementById("hcFeaturesLink")) {
      var link = el("a", { id: "hcFeaturesLink" }, "⚙️ Features");
      link.style.cursor = "pointer";
      link.addEventListener("click", function (e) { e.preventDefault(); showHub(); });
      nav.appendChild(link);
    }
    // Hide the hub whenever an existing app view is selected (coexist with app.js).
    document.querySelectorAll("#nav a[data-view], [data-view]").forEach(function (a) {
      a.addEventListener("click", function () { hideHub(); });
    });

    if (!document.getElementById("hcRunTestsFab")) {
      var fab = el("button", { id: "hcRunTestsFab", class: "hc-fab", type: "button" },
        "✓ Run all tests");
      fab.addEventListener("click", showReport);
      document.body.appendChild(fab);
    }
  }

  // Delegated handlers for hub + modal controls (scoped to HC data-attrs).
  function wireDelegation() {
    document.addEventListener("click", function (e) {
      var open = e.target.closest("[data-hc-open]");
      if (open) { e.preventDefault(); openFeature(open.getAttribute("data-hc-open")); return; }
      var test = e.target.closest("[data-hc-test]");
      if (test) { e.preventDefault(); testOne(test.getAttribute("data-hc-test")); return; }
      var close = e.target.closest("[data-hc-close]");
      if (close) { e.preventDefault(); closeModal(); return; }
      var overlay = e.target.closest("[data-hc-overlay]");
      if (overlay && e.target === overlay) { closeModal(); return; }
    });
  }

  /* ---------- built-in smoke feature: exercises the live app DOM ---------- */
  registerFeature({
    id: "core-smoke",
    title: "Core smoke tests",
    side: "platform",
    icon: "🧪",
    summary: "End-to-end smoke checks against the already-built app: card count, planner columns, and the Free/HAF filter.",
    render: function (mountEl) {
      // Run live and show the outcome inline.
      var out = smokeRun();
      mountEl.innerHTML =
        '<p style="font-size:14px;color:var(--text,#383838)">These checks run against the live page that app.js rendered.</p>' +
        '<ul style="font-size:13.5px;color:var(--text,#383838);line-height:1.8">' +
        out.log.map(function (l) { return "<li>" + escapeHtml(l) + "</li>"; }).join("") +
        "</ul>" +
        '<p style="font-family:Quicksand,system-ui,sans-serif;font-weight:700;color:' +
          (out.fail === 0 ? "#2f7d4f" : "#9a1f5e") + '">' +
          out.pass + " passed · " + out.fail + " failed</p>";
    },
    selfTest: smokeRun
  });

  function smokeRun() {
    var pass = 0, fail = 0, log = [];
    function check(label, fn) {
      try {
        fn();
        pass += 1; log.push("✓ " + label);
      } catch (e) {
        fail += 1; log.push("✗ " + label + " — " + (e && e.message ? e.message : String(e)));
      }
    }

    var providers = HC.data.providers;
    var weeks = (HC.data.planner.weeks) || [];

    // 1. Directory renders one card per provider (44 expected from live data).
    check("Directory renders a card per provider", function () {
      var cards = document.querySelectorAll("#grid .card");
      HC.assert(cards.length === providers.length,
        "expected " + providers.length + " cards, found " + cards.length);
    });

    // 2. Provider count is the expected non-trivial directory size.
    check("Directory has 44 holiday-camp providers", function () {
      HC.assert(providers.length === 44, "expected 44 providers, got " + providers.length);
    });

    // 3. Planner thead has one column per week plus the Camp column (8 total).
    check("Planner thead has " + (weeks.length + 1) + " columns (Camp + weeks)", function () {
      // Activate planner via app.js's own tab button so we test the real render.
      var tabBtn = document.querySelector('.tab[data-tab="planner"]');
      if (tabBtn) tabBtn.click();
      var ths = document.querySelectorAll("#plannerView table.planner thead th");
      HC.assert(ths.length === weeks.length + 1,
        "expected " + (weeks.length + 1) + " th, found " + ths.length);
      var hasCamp = !!document.querySelector("#plannerView table.planner thead th.camp");
      HC.assert(hasCamp, "first column should be the sticky .camp header");
      // restore directory tab so the page is left as found
      var findBtn = document.querySelector('.tab[data-tab="find"]');
      if (findBtn) findBtn.click();
    });

    // 4. Applying the Free/HAF flag reduces the visible count.
    check("Free/HAF flag reduces directory count", function () {
      var before = document.querySelectorAll("#grid .card").length;
      var chip = document.querySelector('.chip[data-flag="free"]');
      HC.assert(chip, "free/HAF chip should exist");
      chip.click(); // turn on
      var after = document.querySelectorAll("#grid .card").length;
      chip.click(); // turn off — leave page as found
      var restored = document.querySelectorAll("#grid .card").length;
      HC.assert(after < before, "expected fewer cards with Free/HAF on (" + after + " < " + before + ")");
      HC.assert(after > 0, "Free/HAF should still match some camps, got " + after);
      HC.assert(restored === before, "count should restore after toggling off (" + restored + " vs " + before + ")");
    });

    // 5. Feature-flag chips exist for the documented attributes.
    check("Seven feature-flag chips are present", function () {
      var chips = document.querySelectorAll("#flagChips .chip[data-flag]");
      HC.assert(chips.length >= 5, "expected at least 5 flag chips, found " + chips.length);
    });

    return { pass: pass, fail: fail, log: log };
  }

  /* ---------- boot the UI (after app.js has rendered) ---------- */
  function boot() {
    injectStyles();
    injectNavAndFab();
    wireDelegation();
  }

  function deferBoot() {
    // app.js runs its boot at the bottom of the same parse; defer to next tick
    // so its DOM (#grid cards, chips, tabs) exists before our nav/fab attach.
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", function () { setTimeout(boot, 0); });
    } else {
      setTimeout(boot, 0);
    }
  }
  deferBoot();
})();
