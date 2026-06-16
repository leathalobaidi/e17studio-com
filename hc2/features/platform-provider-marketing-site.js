/* HolidayCamp feature module — platform-provider-marketing-site
 *
 * Side: PLATFORM.
 * Replicates Happity's separate provider sales/marketing surface. On Happity the
 * parent-facing app lives on www.happity.co.uk, but the *provider pitch* —
 * "do I need a booking system?", the pricing/commission breakdown, the feature
 * list and the "upgrade to membership" call — lives on a DISTINCT marketing
 * subdomain, providers.happity.co.uk, while the actual sign-up/register and the
 * logged-in dashboard live back on www.happity.co.uk/providers/…
 * (evidence: 02-ia-ux §1; 04-seo §5.3; support article 2381444
 * "Pricing, commission and fees" links to providers.happity.co.uk/upgrade-to-
 * membership/ and providers.happity.co.uk/do-i-need-a-booking-system/; support
 * article 2656616 "How do I become a Member" — membership pitch on the provider
 * site, register on www.happity.co.uk/providers/membership/new).
 *
 * Reframed for school-age HOLIDAY CAMPS, this module models a small, self-
 * contained "provider marketing site" mounted on its own host
 * (providers.holidaycamp.example) with a home / pricing / features / register
 * route map, plus a tiny router. The whole point of the feature — and its
 * acceptance criterion — is that the provider pitch (pricing, features, AND the
 * register call-to-action) resolves on this OWN marketing host, separate from
 * the parent app host (www.holidaycamp.example) and the logged-in dashboard
 * host (dashboard.holidaycamp.example).
 *
 * Acceptance criterion (asserted in selfTest):
 *   The provider pitch (pricing, features, register) lives on its own marketing
 *   surface — i.e. the pricing page, the features page and the register CTA all
 *   resolve to the provider-marketing host, and NOT to the parent app host.
 *
 * Design notes
 * - Self-contained: the site map, router and pricing maths are pure and live in
 *   this module. render() draws a working browser-chrome mock (address bar +
 *   nav) and lets you click between the marketing pages inside mountEl. It makes
 *   no assumptions about the live app DOM beyond the mountEl it is handed.
 * - Defensive: every read of live data is guarded; nothing here can throw at
 *   registration time. A broken page render degrades to an inline error.
 * - The last-viewed marketing page persists via HC.store (key
 *   "provmkt.lastPage"), never raw localStorage.
 * - Live data: the home/features pages quote a live count of camps and
 *   providers from HC.data.providers so the pitch reflects the real directory.
 * - Deterministic: the same route always resolves to the same host + page, so
 *   the routing is reproducible and testable.
 */
(function () {
  "use strict";

  if (typeof window === "undefined" || !window.HC || typeof window.HC.registerFeature !== "function") {
    return; // nothing to attach to — fail silent, never throw.
  }
  var HC = window.HC;

  /* ---------------- constants ---------------- */

  var BRAND = "HolidayCamp";
  var STORE_KEY = "provmkt.lastPage";

  // The three hosts in the platform's surface model. The whole feature hinges on
  // these being DIFFERENT origins.
  var HOST = {
    parent: "www.holidaycamp.example",        // parent-facing app (find/book camps)
    provider: "providers.holidaycamp.example", // provider SALES / MARKETING site
    dashboard: "dashboard.holidaycamp.example" // logged-in provider dashboard / app
  };

  // Live pricing (school-age holiday-camp reframing of Happity's published fees:
  // 2.5%+VAT commission, 1.5%+20p Stripe, £60/yr or £8/mo +VAT membership).
  var PRICING = {
    commissionPct: 2.5,          // % of booking value, + VAT
    vatPct: 20,                  // VAT applied to commission
    stripePct: 1.5,              // Stripe processing %
    stripeFixedPence: 20,        // Stripe fixed fee, in pence (20p)
    membershipYear: 60,          // £/year + VAT
    membershipMonth: 8,          // £/month + VAT
    minTermMonths: 9             // monthly-plan minimum term
  };

  // The marketing site map. Each page declares the host it lives on. Pricing,
  // features and the marketing home all live on HOST.provider. The register and
  // dashboard "destinations" deliberately point at OTHER hosts to model the
  // hand-off: you pitch on the marketing site, you sign up / work on the app.
  //
  // NOTE on `register`: Happity's pitch ("upgrade to membership", "register and
  // add your first class") lives on the provider marketing site, but the actual
  // sign-up FORM is served by the app. We model BOTH:
  //   - register      : the register/sign-up CTA *on the marketing site* (its
  //                      pitch + button) — host = provider. THIS is the
  //                      acceptance-criterion "register".
  //   - registerForm  : where that button sends you to complete sign-up — the
  //                      app host. Kept separate so we can prove the pitch and
  //                      the form are on different surfaces, Happity-style.
  var PAGES = [
    {
      id: "home", host: "provider", path: "/", nav: true,
      title: "Grow your holiday camp with " + BRAND,
      kind: "pitch"
    },
    {
      id: "why-list", host: "provider", path: "/why-list-your-camp/", nav: true,
      title: "Why list your holiday camp on " + BRAND + "?",
      kind: "pitch"
    },
    {
      id: "features", host: "provider", path: "/features/", nav: true,
      title: "Features for holiday camp providers",
      kind: "features"
    },
    {
      id: "pricing", host: "provider", path: "/pricing/", nav: true,
      title: "Pricing, commission & fees",
      kind: "pricing"
    },
    {
      id: "register", host: "provider", path: "/register/", nav: true,
      title: "List your camp — get started",
      kind: "register",
      // The CTA on the marketing register page hands off to the app's form.
      cta: { label: "Create your provider account", to: "registerForm" }
    },
    {
      id: "webinars", host: "provider", path: "/webinars/", nav: false,
      title: "Free webinars for camp providers",
      kind: "pitch"
    },
    // ---- destinations on OTHER hosts (not part of the marketing nav) ----
    {
      id: "registerForm", host: "dashboard", path: "/providers/register/new", nav: false,
      title: "Create your account", kind: "app"
    },
    {
      id: "login", host: "dashboard", path: "/providers/login", nav: false,
      title: "Provider login", kind: "app"
    },
    {
      id: "parentHome", host: "parent", path: "/", nav: false,
      title: "Find & book holiday camps", kind: "app"
    }
  ];

  // The pages that constitute "the provider pitch" for the acceptance criterion.
  var PITCH_PAGE_IDS = ["pricing", "features", "register"];

  /* ---------------- pure helpers (no DOM) ---------------- */

  function safeArr(v) { return Array.isArray(v) ? v : []; }
  function safeStr(v) { return (v === null || v === undefined) ? "" : String(v); }

  function getPage(id) {
    id = safeStr(id);
    for (var i = 0; i < PAGES.length; i++) {
      if (PAGES[i].id === id) return PAGES[i];
    }
    return null;
  }

  // Resolve a page id to a full absolute URL on its declared host. This is the
  // routing function the whole acceptance test exercises: it proves which SURFACE
  // (host) a given marketing destination lives on.
  function resolveUrl(id) {
    var page = getPage(id);
    if (!page) return null;
    var host = HOST[page.host] || HOST.provider;
    return {
      id: page.id,
      host: host,
      hostKey: page.host,
      path: page.path,
      url: "https://" + host + page.path,
      title: page.title,
      kind: page.kind
    };
  }

  // Is a given destination served by the provider MARKETING surface?
  function isOnMarketingSurface(id) {
    var r = resolveUrl(id);
    return !!r && r.hostKey === "provider";
  }

  // Is a given destination served by the parent-facing app surface?
  function isOnParentSurface(id) {
    var r = resolveUrl(id);
    return !!r && r.hostKey === "parent";
  }

  // The marketing nav: the ordered, user-visible pages of the provider site.
  function navPages() {
    return PAGES.filter(function (p) { return p.host === "provider" && p.nav; });
  }

  /* ---------------- pricing maths (pure) ---------------- */

  // Round to pennies.
  function p2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

  // Break a single booking down into the fees a provider pays, mirroring
  // Happity's published worked examples. `price` is what the customer pays (£).
  function feeBreakdown(price) {
    price = Number(price);
    if (!isFinite(price) || price < 0) price = 0;
    // A zero (or invalid, clamped-to-zero) booking incurs no fees at all — we
    // don't levy the Stripe fixed 20p on a £0 transaction.
    if (price === 0) {
      return { price: 0, commission: 0, vat: 0, stripe: 0, totalFees: 0, net: 0 };
    }
    var commission = p2(price * (PRICING.commissionPct / 100));
    var vat = p2(commission * (PRICING.vatPct / 100));
    var stripe = p2(price * (PRICING.stripePct / 100) + PRICING.stripeFixedPence / 100);
    var totalFees = p2(commission + vat + stripe);
    var net = p2(price - totalFees);
    return {
      price: p2(price),
      commission: commission,
      vat: vat,
      stripe: stripe,
      totalFees: totalFees,
      net: net
    };
  }

  // The three worked examples shown on the pricing page (single day, a week
  // block, a full summer of camp), reframed for school-age holiday camps.
  function pricingExamples() {
    return [
      { label: "Single camp day", price: 35 },
      { label: "Week block (5 days)", price: 160 },
      { label: "Full summer (6 weeks)", price: 480 }
    ].map(function (ex) {
      var b = feeBreakdown(ex.price);
      b.label = ex.label;
      return b;
    });
  }

  /* ---------------- live data for the pitch ---------------- */

  function liveStats() {
    var providers = safeArr(HC.data && HC.data.providers);
    var areas = {};
    var cats = {};
    for (var i = 0; i < providers.length; i++) {
      var p = providers[i] || {};
      var pa = safeArr(p.areas);
      for (var j = 0; j < pa.length; j++) { areas[safeStr(pa[j]).toLowerCase()] = true; }
      var pc = safeArr(p.categories);
      for (var k = 0; k < pc.length; k++) { cats[safeStr(pc[k]).toLowerCase()] = true; }
    }
    return {
      camps: providers.length,
      areas: Object.keys(areas).length,
      categories: Object.keys(cats).length
    };
  }

  /* ---------------- the marketing feature list ---------------- */

  // The provider feature list pitched on the marketing /features/ page (school-
  // age holiday-camp framing of Happity's membership benefits).
  function featureList() {
    return [
      { icon: "📅", title: "Term & week scheduling", body: "Publish a whole summer or half-term timetable in minutes — single days, week blocks or full-holiday tickets." },
      { icon: "💳", title: "Online bookings & payments", body: "Take card payments via Stripe, paid out in 3–5 days, with automatic registers built for you." },
      { icon: "🔎", title: "Found by local parents", body: "Rank for searches like \"summer camps in Walthamstow\" and appear in the weekly What's On newsletter." },
      { icon: "⭐", title: "Featured listings", body: "Promote your camp to the top of search results in the weeks that matter most for filling places." },
      { icon: "👪", title: "Followers & re-marketing", body: "Email parents who followed you the moment you open new dates — zero-effort marketing." },
      { icon: "🛡️", title: "Safeguarding-ready", body: "Photo-consent registers, eligibility gates and HAF/funded-place support for school-age provision." }
    ];
  }

  /* ---------------- persistence ---------------- */

  function saveLastPage(id) {
    try { HC.store.set(STORE_KEY, safeStr(id)); } catch (e) { /* defensive */ }
  }
  function loadLastPage() {
    try {
      var v = HC.store.get(STORE_KEY, null);
      if (v && getPage(v) && getPage(v).host === "provider") return v;
    } catch (e) { /* defensive */ }
    return "home";
  }

  /* ---------------- render (UI) ---------------- */

  function esc(s) {
    return safeStr(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function money(n) {
    try { return HC.util.money(n); } catch (e) { return "£" + (Number(n) || 0); }
  }

  function render(mountEl) {
    if (!mountEl) return;
    try {
      var stats = liveStats();
      var nav = navPages();
      var cur = loadLastPage();

      mountEl.innerHTML =
        '<p style="font-size:14px;color:var(--text,#383838);margin:0 0 14px">' +
          'Like Happity, the <strong>provider pitch lives on its own marketing site</strong> ' +
          '(<code>' + esc(HOST.provider) + '</code>) — separate from the parent app ' +
          '(<code>' + esc(HOST.parent) + '</code>) and the logged-in dashboard ' +
          '(<code>' + esc(HOST.dashboard) + '</code>). Pricing, features and the register ' +
          'call-to-action all live here, not buried inside the booking app.</p>' +
        // browser chrome mock
        '<div style="border:1.5px solid var(--line,#E6E6E6);border-radius:16px;overflow:hidden;background:#fff;box-shadow:0 6px 18px rgba(96,52,136,.08)">' +
          '<div style="display:flex;align-items:center;gap:8px;background:#f4f1f8;padding:8px 12px;border-bottom:1px solid var(--line,#E6E6E6)">' +
            '<span style="width:10px;height:10px;border-radius:50%;background:#ff5f57;display:inline-block"></span>' +
            '<span style="width:10px;height:10px;border-radius:50%;background:#febc2e;display:inline-block"></span>' +
            '<span style="width:10px;height:10px;border-radius:50%;background:#28c840;display:inline-block"></span>' +
            '<span id="pmAddr" style="flex:1;margin-left:8px;background:#fff;border:1px solid var(--line,#E6E6E6);border-radius:999px;' +
              'padding:5px 12px;font-size:12px;color:#4d5156;font-family:ui-monospace,monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis"></span>' +
          '</div>' +
          // marketing site top nav
          '<div style="display:flex;align-items:center;gap:4px;flex-wrap:wrap;padding:10px 14px;border-bottom:1px solid var(--line,#E6E6E6)">' +
            '<strong style="font-family:Quicksand,system-ui,sans-serif;color:var(--purple,#603488);margin-right:8px">' + esc(BRAND) + ' for Providers</strong>' +
            nav.map(function (p) {
              return '<button class="pm-nav" data-page="' + esc(p.id) + '" style="border:none;background:none;cursor:pointer;font-size:13px;' +
                'font-weight:700;color:var(--purple,#603488);padding:5px 9px;border-radius:8px">' + esc(navLabel(p.id)) + '</button>';
            }).join("") +
          '</div>' +
          '<div id="pmBody" style="padding:20px 22px;min-height:220px"></div>' +
        '</div>' +
        '<p style="font-size:12px;color:var(--muted,#808080);margin:14px 0 0">' +
          'Live pitch data: <strong>' + stats.camps + '</strong> camps · ' + stats.categories +
          ' activity types · ' + stats.areas + ' areas across Waltham Forest.</p>';

      var addr = mountEl.querySelector("#pmAddr");
      var body = mountEl.querySelector("#pmBody");

      function go(id) {
        var page = getPage(id) || getPage("home");
        var loc = resolveUrl(page.id);
        saveLastPage(page.id);
        addr.textContent = loc.url;
        // highlight active nav
        var btns = mountEl.querySelectorAll(".pm-nav");
        for (var i = 0; i < btns.length; i++) {
          var active = btns[i].getAttribute("data-page") === page.id;
          btns[i].style.background = active ? "var(--purple,#603488)" : "none";
          btns[i].style.color = active ? "#fff" : "var(--purple,#603488)";
        }
        body.innerHTML = renderPage(page.id, stats);
        wirePageButtons(body, go);
      }

      var navBtns = mountEl.querySelectorAll(".pm-nav");
      for (var i = 0; i < navBtns.length; i++) {
        (function (b) {
          b.addEventListener("click", function () { go(b.getAttribute("data-page")); });
        })(navBtns[i]);
      }

      go(cur);
    } catch (e) {
      mountEl.innerHTML = '<p style="color:#9a1f5e">Provider marketing site preview failed: ' +
        esc(e && e.message ? e.message : String(e)) + "</p>";
    }
  }

  function navLabel(id) {
    switch (id) {
      case "home": return "Home";
      case "why-list": return "Why list?";
      case "features": return "Features";
      case "pricing": return "Pricing";
      case "register": return "List your camp";
      default: { var p = getPage(id); return p ? p.title : id; }
    }
  }

  // Buttons inside a rendered page can navigate to other ids (incl. cross-host
  // hand-offs). We mark them with data-goto and wire them here.
  function wirePageButtons(scope, go) {
    var btns = scope.querySelectorAll("[data-goto]");
    for (var i = 0; i < btns.length; i++) {
      (function (b) {
        b.addEventListener("click", function () {
          var to = b.getAttribute("data-goto");
          var loc = resolveUrl(to);
          if (!loc) return;
          if (loc.hostKey === "provider") {
            go(to);
          } else {
            // cross-host hand-off — show where it would send you.
            try { HC.util.toast("Leaving the marketing site → " + loc.url); } catch (e) {}
          }
        });
      })(btns[i]);
    }
  }

  function renderPage(id, stats) {
    var page = getPage(id);
    if (!page) return "";
    if (page.kind === "pricing") return renderPricing(page);
    if (page.kind === "features") return renderFeatures(page, stats);
    if (page.kind === "register") return renderRegister(page);
    return renderPitch(page, stats);
  }

  function pageHeading(page) {
    return '<h2 style="font-family:Quicksand,system-ui,sans-serif;color:var(--purple,#603488);margin:0 0 10px;font-size:24px">' +
      esc(page.title) + "</h2>";
  }

  function renderPitch(page, stats) {
    return pageHeading(page) +
      '<p style="font-size:14px;color:var(--text,#383838);line-height:1.6;margin:0 0 14px">' +
        'Reach <strong>local parents searching for school-holiday childcare</strong> across Waltham Forest. ' +
        'Join the directory of <strong>' + stats.camps + '</strong> camps and fill your summer and half-term places.' +
      '</p>' +
      '<div style="display:flex;gap:10px;flex-wrap:wrap">' +
        ctaBtn("Pricing", "pricing", true) +
        ctaBtn("See features", "features", false) +
        ctaBtn("List your camp", "register", false) +
      '</div>';
  }

  function renderFeatures(page, stats) {
    var items = featureList();
    return pageHeading(page) +
      '<p style="font-size:14px;color:var(--text,#383838);margin:0 0 16px">Everything you need to run school-age holiday camps on ' + esc(BRAND) + '.</p>' +
      '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px">' +
        items.map(function (f) {
          return '<div style="border:1px solid var(--line,#E6E6E6);border-radius:14px;padding:14px 16px">' +
            '<div style="font-size:22px">' + esc(f.icon) + '</div>' +
            '<div style="font-family:Quicksand,system-ui,sans-serif;font-weight:700;color:var(--purple,#603488);margin:4px 0 4px">' + esc(f.title) + '</div>' +
            '<div style="font-size:13px;color:var(--text,#383838);line-height:1.5">' + esc(f.body) + '</div>' +
          '</div>';
        }).join("") +
      '</div>' +
      '<div style="margin-top:16px">' + ctaBtn("List your camp", "register", true) + '</div>';
  }

  function renderPricing(page) {
    var ex = pricingExamples();
    var rows = ex.map(function (b) {
      return '<tr>' +
        '<td style="padding:8px 10px;border-bottom:1px solid var(--line,#E6E6E6)">' + esc(b.label) + '</td>' +
        '<td style="padding:8px 10px;border-bottom:1px solid var(--line,#E6E6E6);text-align:right">' + money(b.price) + '</td>' +
        '<td style="padding:8px 10px;border-bottom:1px solid var(--line,#E6E6E6);text-align:right">' + money(b.commission) + '</td>' +
        '<td style="padding:8px 10px;border-bottom:1px solid var(--line,#E6E6E6);text-align:right">' + money(b.vat) + '</td>' +
        '<td style="padding:8px 10px;border-bottom:1px solid var(--line,#E6E6E6);text-align:right">' + money(b.stripe) + '</td>' +
        '<td style="padding:8px 10px;border-bottom:1px solid var(--line,#E6E6E6);text-align:right;font-weight:700">' + money(b.totalFees) + '</td>' +
      '</tr>';
    }).join("");
    return pageHeading(page) +
      '<p style="font-size:14px;color:var(--text,#383838);margin:0 0 14px">' +
        'Membership is <strong>' + money(PRICING.membershipYear) + '/year</strong> or <strong>' + money(PRICING.membershipMonth) +
        '/month</strong> (+VAT). Then on each booking you pay just <strong>' + PRICING.commissionPct + '% commission</strong> (+VAT) plus Stripe processing (' +
        PRICING.stripePct + '% + ' + PRICING.stripeFixedPence + 'p).</p>' +
      '<div style="overflow-x:auto">' +
        '<table style="width:100%;border-collapse:collapse;font-size:13px">' +
          '<thead><tr style="text-align:left;color:var(--purple,#603488)">' +
            '<th style="padding:8px 10px">Example</th>' +
            '<th style="padding:8px 10px;text-align:right">Parent pays</th>' +
            '<th style="padding:8px 10px;text-align:right">Commission</th>' +
            '<th style="padding:8px 10px;text-align:right">VAT</th>' +
            '<th style="padding:8px 10px;text-align:right">Stripe</th>' +
            '<th style="padding:8px 10px;text-align:right">Total fees</th>' +
          '</tr></thead><tbody>' + rows + '</tbody>' +
        '</table>' +
      '</div>' +
      '<p style="font-size:12px;color:var(--muted,#808080);margin:10px 0 0">Monthly plans have a ' + PRICING.minTermMonths +
        '-month minimum term, then cancel any time.</p>' +
      '<div style="margin-top:16px">' + ctaBtn("List your camp", "register", true) + '</div>';
  }

  function renderRegister(page) {
    var formLoc = resolveUrl((page.cta && page.cta.to) || "registerForm");
    return pageHeading(page) +
      '<p style="font-size:14px;color:var(--text,#383838);line-height:1.6;margin:0 0 14px">' +
        'Ready to fill your camps? Create your provider account, add your first camp and start taking bookings. ' +
        'It is free to list; you only pay when parents book.</p>' +
      '<ol style="font-size:13px;color:var(--text,#383838);line-height:1.7;margin:0 0 16px;padding-left:20px">' +
        '<li>Create your provider account</li>' +
        '<li>Add your first holiday camp and dates</li>' +
        '<li>Connect Stripe and switch bookings on</li>' +
      '</ol>' +
      '<button data-goto="' + esc((page.cta && page.cta.to) || "registerForm") + '" ' +
        'style="background:var(--magenta,#F82488);color:#fff;border:none;border-radius:999px;padding:11px 22px;font-family:Quicksand,system-ui,sans-serif;' +
        'font-weight:700;font-size:15px;cursor:pointer">' + esc((page.cta && page.cta.label) || "Create your provider account") + ' →</button>' +
      '<p style="font-size:12px;color:var(--muted,#808080);margin:10px 0 0">' +
        'Sign-up form is served by the app: <code>' + esc(formLoc ? formLoc.url : "") + '</code></p>';
  }

  function ctaBtn(label, gotoId, primary) {
    var bg = primary ? "var(--magenta,#F82488)" : "#fff";
    var col = primary ? "#fff" : "var(--purple,#603488)";
    var border = primary ? "none" : "1.5px solid var(--purple,#603488)";
    return '<button data-goto="' + esc(gotoId) + '" style="background:' + bg + ';color:' + col + ';border:' + border +
      ';border-radius:999px;padding:9px 18px;font-family:Quicksand,system-ui,sans-serif;font-weight:700;font-size:14px;cursor:pointer">' +
      esc(label) + '</button>';
  }

  /* ---------------- enhance (optional) ---------------- */

  // No-op by default: the live app owns its own routing. Left as a safe hook so a
  // future router could expose the provider-marketing host map. Must never throw.
  function enhance() {
    try {
      if (typeof window === "undefined") return;
      // Expose the resolver for any future integration without touching the DOM.
      if (!window.HC_PROVIDER_MARKETING) {
        window.HC_PROVIDER_MARKETING = {
          hosts: HOST,
          resolve: resolveUrl,
          isOnMarketingSurface: isOnMarketingSurface
        };
      }
    } catch (e) { /* defensive: enhance must never throw */ }
  }

  /* ---------------- selfTest ---------------- */

  function selfTest() {
    var pass = 0, fail = 0, log = [];
    function check(label, fn) {
      try { fn(); pass += 1; log.push("✓ " + label); }
      catch (e) { fail += 1; log.push("✗ " + label + " — " + (e && e.message ? e.message : String(e))); }
    }

    // 1. ACCEPTANCE CRITERION — the provider pitch (pricing, features, register)
    //    lives on its OWN marketing surface, separate from the parent app.
    check("ACCEPTANCE: pricing, features & register all live on the provider marketing host", function () {
      for (var i = 0; i < PITCH_PAGE_IDS.length; i++) {
        var id = PITCH_PAGE_IDS[i];
        var loc = resolveUrl(id);
        HC.assert(loc !== null, "pitch page '" + id + "' must resolve");
        HC.assert(loc.hostKey === "provider",
          "pitch page '" + id + "' must live on the provider marketing surface, got host '" + loc.hostKey + "'");
        HC.assert(loc.host === HOST.provider,
          "pitch page '" + id + "' host should be " + HOST.provider + ", got " + loc.host);
        HC.assert(loc.url.indexOf("https://" + HOST.provider) === 0,
          "pitch page '" + id + "' URL should be on the marketing host: " + loc.url);
        HC.assert(isOnMarketingSurface(id) === true, "isOnMarketingSurface('" + id + "') should be true");
      }
    });

    // 2. ...and NOT on the parent-facing app host (the surfaces are separate).
    check("ACCEPTANCE: the pitch pages do NOT live on the parent app host", function () {
      var parentLoc = resolveUrl("parentHome");
      HC.assert(parentLoc.hostKey === "parent", "parentHome should be on the parent host");
      HC.assert(HOST.provider !== HOST.parent, "provider and parent hosts must differ");
      for (var i = 0; i < PITCH_PAGE_IDS.length; i++) {
        var id = PITCH_PAGE_IDS[i];
        HC.assert(isOnParentSurface(id) === false,
          "pitch page '" + id + "' must NOT be on the parent app surface");
        var loc = resolveUrl(id);
        HC.assert(loc.host !== HOST.parent,
          "pitch page '" + id + "' must not resolve to the parent host");
        HC.assert(loc.host !== parentLoc.host, "pitch page '" + id + "' shares host with parent app");
      }
    });

    // 3. The three platform surfaces are genuinely distinct origins.
    check("Provider, parent and dashboard are three distinct hosts", function () {
      HC.assert(HOST.provider && HOST.parent && HOST.dashboard, "all three hosts defined");
      HC.assert(HOST.provider !== HOST.parent, "provider != parent");
      HC.assert(HOST.provider !== HOST.dashboard, "provider != dashboard");
      HC.assert(HOST.parent !== HOST.dashboard, "parent != dashboard");
      // The marketing host is a 'providers.' subdomain (Happity-style separation).
      HC.assert(/^providers\./.test(HOST.provider), "marketing host should be a providers.* subdomain: " + HOST.provider);
    });

    // 4. Every page declared as part of the marketing NAV is on the provider host.
    check("Every marketing nav page resolves to the provider host", function () {
      var nav = navPages();
      HC.assert(nav.length >= 4, "expected at least 4 marketing nav pages, got " + nav.length);
      for (var i = 0; i < nav.length; i++) {
        var loc = resolveUrl(nav[i].id);
        HC.assert(loc.hostKey === "provider",
          "nav page '" + nav[i].id + "' must be on provider host, got '" + loc.hostKey + "'");
      }
      // The three pitch pages must all be present in the marketing nav.
      var navIds = nav.map(function (p) { return p.id; });
      for (var k = 0; k < PITCH_PAGE_IDS.length; k++) {
        HC.assert(navIds.indexOf(PITCH_PAGE_IDS[k]) !== -1,
          "marketing nav is missing pitch page '" + PITCH_PAGE_IDS[k] + "'");
      }
    });

    // 5. The register CTA pitches on the marketing site but hands off the actual
    //    sign-up FORM to a DIFFERENT host (pitch vs form separation, Happity-style).
    check("Register pitch is on the marketing site; the sign-up form hands off to the app", function () {
      var reg = getPage("register");
      HC.assert(reg && reg.host === "provider", "register pitch must live on the marketing site");
      HC.assert(reg.cta && reg.cta.to, "register page must declare a hand-off CTA");
      var formLoc = resolveUrl(reg.cta.to);
      HC.assert(formLoc !== null, "register CTA target must resolve");
      HC.assert(formLoc.hostKey !== "provider",
        "the sign-up FORM should be off the marketing site (on the app), got host '" + formLoc.hostKey + "'");
      HC.assert(formLoc.host !== HOST.provider, "form host should differ from marketing host");
    });

    // 6. Routing is deterministic — same id always resolves to the same URL.
    check("Routing is deterministic", function () {
      var a = resolveUrl("pricing");
      var b = resolveUrl("pricing");
      HC.assert(a.url === b.url, "pricing URL not deterministic: " + a.url + " vs " + b.url);
      HC.assert(/^https:\/\/[a-z0-9.\-]+\/[a-z0-9/\-]*$/i.test(a.url), "pricing URL malformed: " + a.url);
    });

    // 7. Unknown routes resolve to null (no accidental fallthrough to a surface).
    check("Unknown route resolves to null", function () {
      HC.assert(resolveUrl("does-not-exist") === null, "unknown id should resolve to null");
      HC.assert(getPage("nope") === null, "unknown page should be null");
      HC.assert(isOnMarketingSurface("nope") === false, "unknown id is not on the marketing surface");
    });

    // 8. Pricing maths matches Happity's published worked-example structure.
    check("Fee breakdown computes commission + VAT + Stripe correctly", function () {
      // £35 single day: commission 2.5% = £0.875 -> £0.88 (rounded), VAT 20% of
      // commission, Stripe 1.5% + 20p.
      var b = feeBreakdown(35);
      HC.assert(b.commission === p2(35 * 0.025), "commission wrong: " + b.commission);
      HC.assert(b.vat === p2(b.commission * 0.2), "VAT wrong: " + b.vat);
      HC.assert(b.stripe === p2(35 * 0.015 + 0.20), "stripe wrong: " + b.stripe);
      HC.assert(b.totalFees === p2(b.commission + b.vat + b.stripe), "totalFees wrong: " + b.totalFees);
      HC.assert(b.net === p2(b.price - b.totalFees), "net wrong: " + b.net);
      // Fees are a small slice of the booking — sanity bound (<10% on a £35 day).
      HC.assert(b.totalFees < b.price * 0.1, "fees unexpectedly high for a £35 booking: " + b.totalFees);
    });

    // 9. Pricing examples are all well-formed and live on the pricing page only.
    check("Pricing examples are well-formed", function () {
      var ex = pricingExamples();
      HC.assert(ex.length === 3, "expected 3 worked examples, got " + ex.length);
      for (var i = 0; i < ex.length; i++) {
        HC.assert(ex[i].price > 0, "example price must be positive");
        HC.assert(ex[i].totalFees >= 0, "example fees must be >= 0");
        HC.assert(typeof ex[i].label === "string" && ex[i].label.length > 0, "example needs a label");
      }
      // Fees scale monotonically with booking value.
      HC.assert(ex[0].totalFees < ex[1].totalFees && ex[1].totalFees < ex[2].totalFees,
        "fees should increase with booking size");
    });

    // 10. Defensive: malformed/negative prices never throw and clamp to zero.
    check("Defensive: malformed prices clamp to a zero-fee breakdown", function () {
      var b1 = feeBreakdown(-50);
      HC.assert(b1.price === 0 && b1.totalFees === 0, "negative price should clamp to zero");
      var b2 = feeBreakdown("not-a-number");
      HC.assert(b2.price === 0 && b2.totalFees === 0, "non-numeric price should clamp to zero");
      var b3 = feeBreakdown(null);
      HC.assert(typeof b3.totalFees === "number", "null price should still return a number");
    });

    // 11. The pitch reflects the LIVE directory (count comes from HC.data).
    check("Live stats are read from HC.data.providers", function () {
      var stats = liveStats();
      var providers = safeArr(HC.data && HC.data.providers);
      HC.assert(stats.camps === providers.length,
        "live camp count should equal providers.length (" + providers.length + "), got " + stats.camps);
      HC.assert(stats.categories >= 0 && stats.areas >= 0, "category/area counts must be non-negative");
      if (providers.length) {
        HC.assert(stats.categories > 0, "expected at least one category from live data");
        HC.assert(stats.areas > 0, "expected at least one area from live data");
      }
    });

    // 12. The feature list is a non-empty, well-formed marketing pitch.
    check("Marketing feature list is well-formed", function () {
      var fl = featureList();
      HC.assert(fl.length >= 4, "expected at least 4 pitched features, got " + fl.length);
      for (var i = 0; i < fl.length; i++) {
        HC.assert(fl[i].title && fl[i].body, "each feature needs a title and body");
      }
    });

    // 13. Persistence round-trip via HC.store (never raw localStorage), and the
    //     restored page is always a marketing-surface page.
    check("Last-page persists via HC.store and restores to a marketing page", function () {
      var before;
      try { before = HC.store.get(STORE_KEY, null); } catch (e) { before = null; }
      saveLastPage("pricing");
      var got = loadLastPage();
      HC.assert(got === "pricing", "expected restored page 'pricing', got '" + got + "'");
      HC.assert(getPage(got).host === "provider", "restored page must be a marketing page");
      // A persisted NON-marketing page must not be restored as the landing page.
      saveLastPage("parentHome");
      var safe = loadLastPage();
      HC.assert(getPage(safe).host === "provider",
        "restore must never land on a non-marketing page, got '" + safe + "'");
      // restore prior value
      try { if (before === null) HC.store.remove ? HC.store.remove(STORE_KEY) : HC.store.set(STORE_KEY, "home"); else HC.store.set(STORE_KEY, before); } catch (e) {}
    });

    // 14. render() into a detached node never throws and draws the address bar.
    check("render() draws into a detached node without throwing", function () {
      if (typeof document === "undefined") { HC.assert(true, "no DOM — skipped"); return; }
      var host = document.createElement("div");
      render(host);
      HC.assert(host.querySelector("#pmAddr") !== null, "render should draw the address bar");
      HC.assert(host.querySelectorAll(".pm-nav").length >= 4, "render should draw the marketing nav");
    });

    return { pass: pass, fail: fail, log: log };
  }

  /* ---------------- register ---------------- */
  HC.registerFeature({
    id: "platform-provider-marketing-site",
    title: "Separate provider marketing site",
    side: "platform",
    icon: "📣",
    summary: "The provider pitch — pricing, features and the register CTA — lives on its own marketing surface (providers.holidaycamp.example), separate from the parent app and the dashboard, exactly like Happity's providers.* site.",
    render: render,
    enhance: enhance,
    selfTest: selfTest
  });
})();
