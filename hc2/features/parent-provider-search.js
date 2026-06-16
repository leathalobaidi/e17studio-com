/* HolidayCamp feature module — parent-provider-search
 *
 * Side: PARENT.
 * Replicates Happity's "search by Company name -> their page" behaviour.
 *   Evidence: support article 8255669, line 31 —
 *   "If you know the Company name you want to book with, then you can also
 *    search for them directly."  (also 02-ia-ux T5)
 * Reframed for school-age HOLIDAY CAMPS: typing a provider/company name routes
 * the parent to that provider's page, which lists ALL of that provider's camps
 * grouped BY VENUE (with the planner weeks each venue runs).
 *
 * Acceptance criterion (asserted in selfTest):
 *   Typing a provider name routes to that provider's page listing all their
 *   camps by venue.
 *
 * Design notes
 * - Self-contained: every bit of search + routing + grouping logic is pure and
 *   lives in this module. render() draws a working search box + provider page
 *   inside the mountEl it is handed; it makes NO assumptions about the live app
 *   DOM beyond that mountEl.
 * - Defensive: every read of provider/planner data is guarded so a missing or
 *   malformed field can never throw at registration time, during a search, or
 *   during a render.
 * - "Routing" is modelled as a hash route "#/provider/<id>" — matching how a
 *   real SPA would route to a provider page — and the last viewed provider is
 *   persisted via HC.store (key "providerSearch.last"), never raw localStorage.
 *
 * Data realities (live HC.data):
 * - A provider IS a company. provider.name = company name; provider.venue =
 *   one or more venues (free text, separated by " and " / "," / ";" / " / ").
 * - provider.areas / area give neighbourhoods; planner.byId[id].weeks gives the
 *   confirmed planner week numbers for that provider's camps.
 * - We split multi-venue providers into one "camp listing" per venue so the
 *   provider page genuinely lists their camps BY VENUE.
 */
(function () {
  "use strict";

  if (typeof window === "undefined" || !window.HC || typeof window.HC.registerFeature !== "function") {
    return; // nothing to attach to — fail silent, never throw.
  }
  var HC = window.HC;

  var ROUTE_PREFIX = "#/provider/";
  var STORE_LAST = "providerSearch.last";

  /* ---------------- pure helpers (no DOM) ---------------- */

  function safeArr(v) { return Array.isArray(v) ? v : []; }
  function str(v) { return (v === null || v === undefined) ? "" : String(v); }

  // Normalise for matching: lower-case, strip punctuation, collapse whitespace.
  function norm(s) {
    return str(s)
      .toLowerCase()
      .replace(/&/g, " and ")
      .replace(/[^a-z0-9]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  // The live directory, defensively.
  function allProviders() {
    try { return safeArr(HC.data && HC.data.providers); } catch (e) { return []; }
  }

  function plannerFor(id) {
    try {
      var p = HC.data && HC.data.planner;
      var byId = p && p.byId;
      var rec = byId && byId[id];
      return (rec && typeof rec === "object") ? rec : null;
    } catch (e) { return null; }
  }

  // Confirmed planner week numbers for a provider's camps (e.g. [2,3,4,5]).
  function weeksFor(id) {
    var rec = plannerFor(id);
    if (!rec) return [];
    var w = safeArr(rec.weeks).filter(function (n) { return typeof n === "number"; });
    return w;
  }

  // Split a free-text venue string into individual venue names.
  // Handles " and ", ";", "," and " / " as separators while keeping short
  // fragments (e.g. "SCORE") attached when splitting would shred a name.
  function splitVenues(venueText) {
    var t = str(venueText).trim();
    if (!t) return [];
    // Normalise separators to a single pipe, then split.
    var parts = t
      .replace(/\s*;\s*/g, "|")
      .replace(/\s+\/\s+/g, "|")
      .replace(/\s+and\s+/gi, "|")
      .replace(/\s*,\s*/g, "|")
      .split("|")
      .map(function (s) { return s.trim(); })
      .filter(function (s) { return s.length > 0; });
    // De-dupe while preserving order.
    var seen = {}, out = [];
    for (var i = 0; i < parts.length; i++) {
      var key = norm(parts[i]);
      if (!key || seen[key]) continue;
      seen[key] = true;
      out.push(parts[i]);
    }
    return out;
  }

  /* ----- search: company-name -> provider ----- */

  // Generic words that, on their own, must NOT route a parent to a provider —
  // almost every camp's name contains one, so a lone "camp"/"holiday" match is
  // not a real company-name hit.
  var STOPWORDS = {
    camp: 1, camps: 1, holiday: 1, holidays: 1, club: 1, clubs: 1, kids: 1,
    kid: 1, children: 1, childrens: 1, the: 1, and: 1, of: 1, for: 1, at: 1,
    school: 1, schools: 1, summer: 1, scheme: 1, playscheme: 1, activity: 1,
    activities: 1, sports: 1, sport: 1, centre: 1, center: 1, academy: 1
  };
  function meaningfulTokens(tokens) {
    return tokens.filter(function (t) { return t && !STOPWORDS[t]; });
  }

  // Score a provider against a query. Higher = better. 0 = no match.
  // Exact name > name starts-with > query is a substring of the name > all
  // query tokens present in the name > a *meaningful* partial overlap. The
  // last tier deliberately ignores generic words ("camp", "holiday", "kids")
  // so a made-up name sharing only a stopword does NOT route anywhere.
  function scoreProvider(provider, query) {
    var q = norm(query);
    if (!q) return 0;
    var name = norm(provider && provider.name);
    if (!name) return 0;

    if (name === q) return 1000;
    if (name.indexOf(q) === 0) return 800;                 // starts-with
    if (name.indexOf(q) !== -1) return 600;                // query is a substring of the name

    var qTokens = q.split(" ").filter(Boolean);
    var nameTokens = name.split(" ");
    var nameSet = {};
    nameTokens.forEach(function (t) { nameSet[t] = true; });

    var inName = 0;
    qTokens.forEach(function (t) { if (nameSet[t]) inName += 1; });
    if (qTokens.length && inName === qTokens.length) return 400; // all query tokens in name

    // Meaningful partial: only count non-stopword query tokens that appear in
    // the name, and require a real overlap (not one shared generic word).
    var qMeaningful = meaningfulTokens(qTokens);
    var partial = 0;
    qMeaningful.forEach(function (t) { if (name.indexOf(t) !== -1) partial += 1; });

    if (qMeaningful.length === 0) return 0; // query was all generic words
    // Need either >=2 meaningful tokens hit, or the query is short and its sole
    // meaningful token genuinely identifies this provider.
    if (partial >= 2) return 100 + partial * 10;
    if (partial === 1 && qMeaningful.length === 1) return 110;
    return 0;
  }

  // Search the directory by company name. Returns providers sorted best-first.
  function searchProviders(query, list) {
    var providers = safeArr(list && list.length ? list : allProviders());
    var scored = [];
    for (var i = 0; i < providers.length; i++) {
      var s = scoreProvider(providers[i], query);
      if (s > 0) scored.push({ p: providers[i], s: s, i: i });
    }
    scored.sort(function (a, b) {
      if (b.s !== a.s) return b.s - a.s;
      return a.i - b.i; // stable: directory order on ties
    });
    return scored.map(function (x) { return x.p; });
  }

  // The single best provider match for a typed name (the one we route to).
  function bestMatch(query, list) {
    var r = searchProviders(query, list);
    return r.length ? r[0] : null;
  }

  /* ----- routing ----- */

  function routeForProvider(provider) {
    return ROUTE_PREFIX + encodeURIComponent(str(provider && provider.id));
  }

  function providerIdFromRoute(route) {
    var r = str(route);
    if (r.indexOf(ROUTE_PREFIX) !== 0) return null;
    try { return decodeURIComponent(r.slice(ROUTE_PREFIX.length)); }
    catch (e) { return r.slice(ROUTE_PREFIX.length); }
  }

  function providerById(id) {
    var providers = allProviders();
    for (var i = 0; i < providers.length; i++) {
      if (str(providers[i] && providers[i].id) === str(id)) return providers[i];
    }
    return null;
  }

  /* ----- build the provider page model: camps grouped BY VENUE ----- */

  // Returns { provider, route, venues:[{ venue, weeks, ageLabel, price, areas }], camps:Number }
  // One "camp listing" entry per venue the provider runs at. This is the data
  // the provider page renders — the acceptance criterion's "all their camps by
  // venue".
  function providerPageModel(provider) {
    if (!provider || typeof provider !== "object") return null;
    var id = str(provider.id);
    var venuesText = splitVenues(provider.venue);
    if (!venuesText.length) {
      // Fall back to area as a single "venue" so the page never lists zero.
      venuesText = [str(provider.area) || "Venue to be confirmed"];
    }
    var weeks = weeksFor(id);
    var areas = safeArr(provider.areas);
    var venues = venuesText.map(function (v) {
      return {
        venue: v,
        weeks: weeks.slice(),
        ageLabel: str(provider.ageLabel || ((provider.ageMin || "?") + "-" + (provider.ageMax || "?"))),
        price: str(provider.price),
        areas: areas.slice()
      };
    });
    return {
      provider: provider,
      route: routeForProvider(provider),
      venues: venues,
      camps: venues.length
    };
  }

  /* ---------------- DOM render ---------------- */

  function elx(tag, attrs, html) {
    try { return HC.util.el(tag, attrs, html); }
    catch (e) { var n = document.createElement(tag || "div"); if (html != null) n.innerHTML = html; return n; }
  }
  function esc(s) {
    return str(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
  function escAttr(s) { return esc(s).replace(/"/g, "&quot;"); }

  function weeksLabel(weeks) {
    var w = safeArr(weeks);
    if (!w.length) return "Dates to confirm with provider";
    return "Weeks " + w.join(", ");
  }

  // Render the provider page (all camps by venue) into a container element.
  function renderProviderPage(container, provider) {
    var model = providerPageModel(provider);
    if (!model) {
      container.innerHTML = '<p style="color:#9a1f5e">Provider not found.</p>';
      return;
    }
    var p = model.provider;
    var html = '' +
      '<div class="pps-page" data-pps-route="' + escAttr(model.route) + '" data-pps-id="' + escAttr(p.id) + '">' +
        '<div class="pps-crumb"><a href="#" data-pps-back>&larr; Back to search</a></div>' +
        '<h3 class="pps-name">' + esc(p.name) + '</h3>' +
        '<p class="pps-kind">' + esc(str(p.kind)) + (p.area ? ' · ' + esc(p.area) : '') + '</p>' +
        (p.summary ? '<p class="pps-summary">' + esc(p.summary) + '</p>' : '') +
        '<div class="pps-vhead">Their camps · ' + model.venues.length +
          (model.venues.length === 1 ? ' venue' : ' venues') + '</div>' +
        '<ul class="pps-venues" data-pps-venues>';

    for (var i = 0; i < model.venues.length; i++) {
      var v = model.venues[i];
      html += '' +
        '<li class="pps-venue" data-pps-venue>' +
          '<div class="pps-venue-name">📍 ' + esc(v.venue) + '</div>' +
          '<div class="pps-venue-meta">' +
            '<span class="pps-chip">' + esc(weeksLabel(v.weeks)) + '</span>' +
            (v.ageLabel ? '<span class="pps-chip">Ages ' + esc(v.ageLabel) + '</span>' : '') +
            (v.price ? '<span class="pps-chip">' + esc(v.price) + '</span>' : '') +
          '</div>' +
        '</li>';
    }
    html += '</ul></div>';
    container.innerHTML = html;
  }

  function render(mountEl) {
    try { injectStyles(); } catch (e) {}
    try {
      var providers = allProviders();
      var wrap = elx("div", { class: "pps-wrap" });
      wrap.innerHTML = '' +
        '<p class="pps-lead">Know the company you want to book with? Type their name to go ' +
          'straight to their page — every camp they run, grouped by venue. ' +
          '(' + providers.length + ' providers in this directory.)</p>' +
        '<div class="pps-search">' +
          '<input type="text" class="pps-input" placeholder="e.g. YMCA, Lloyd Park, Kings Camps…" ' +
            'aria-label="Search by provider or company name" data-pps-input>' +
          '<button type="button" class="hc-btn pps-go" data-pps-submit>Go to page</button>' +
        '</div>' +
        '<div class="pps-suggest" data-pps-suggest></div>' +
        '<div class="pps-result" data-pps-result></div>';
      mountEl.innerHTML = "";
      mountEl.appendChild(wrap);

      var input = wrap.querySelector("[data-pps-input]");
      var suggest = wrap.querySelector("[data-pps-suggest]");
      var result = wrap.querySelector("[data-pps-result]");

      function showProvider(provider) {
        if (!provider) return;
        try { HC.store.set(STORE_LAST, str(provider.id)); } catch (e) {}
        suggest.innerHTML = "";
        renderProviderPage(result, provider);
        try {
          var card = result.querySelector("[data-pps-route]");
          if (card) card.scrollIntoView({ block: "nearest" });
        } catch (e) {}
      }

      function refreshSuggest() {
        var q = input ? input.value : "";
        if (!norm(q)) { suggest.innerHTML = ""; return; }
        var matches = searchProviders(q, providers).slice(0, 6);
        if (!matches.length) {
          suggest.innerHTML = '<div class="pps-empty">No company matches “' + esc(q) + '”. Try fewer letters.</div>';
          return;
        }
        var rows = matches.map(function (p) {
          return '<button type="button" class="pps-srow" data-pps-pick="' + escAttr(p.id) + '">' +
            '<span class="pps-sname">' + esc(p.name) + '</span>' +
            '<span class="pps-sarea">' + esc(str(p.area)) + '</span>' +
          '</button>';
        }).join("");
        suggest.innerHTML = '<div class="pps-slist">' + rows + '</div>';
      }

      function submit() {
        var q = input ? input.value : "";
        var p = bestMatch(q, providers);
        if (!p) {
          suggest.innerHTML = '<div class="pps-empty">No company matches “' + esc(q) + '”.</div>';
          result.innerHTML = "";
          return;
        }
        showProvider(p);
      }

      if (input) {
        input.addEventListener("input", refreshSuggest);
        input.addEventListener("keydown", function (e) {
          if (e.key === "Enter") { e.preventDefault(); submit(); }
        });
      }

      wrap.addEventListener("click", function (e) {
        var pick = e.target.closest("[data-pps-pick]");
        if (pick) { e.preventDefault(); showProvider(providerById(pick.getAttribute("data-pps-pick"))); return; }
        var submitBtn = e.target.closest("[data-pps-submit]");
        if (submitBtn) { e.preventDefault(); submit(); return; }
        var back = e.target.closest("[data-pps-back]");
        if (back) { e.preventDefault(); result.innerHTML = ""; if (input) { input.focus(); } refreshSuggest(); return; }
      });

      // Restore the last viewed provider if there is one, else preview the first.
      var lastId = null;
      try { lastId = HC.store.get(STORE_LAST, null); } catch (e) {}
      var initial = lastId ? providerById(lastId) : null;
      if (initial) {
        if (input) input.value = str(initial.name);
        showProvider(initial);
      }
    } catch (e) {
      mountEl.innerHTML = '<p style="color:#9a1f5e">Provider search failed to render: ' + esc(e && e.message) + '</p>';
    }
  }

  /* ---------------- enhance(): wire up real hash routing if the app exposes a host ---------------- */

  function enhance() {
    // Optional: if a real provider-page host exists in the app, route to it on
    // hashchange. Purely additive and fully guarded.
    try {
      if (typeof window === "undefined" || !window.addEventListener) return;
      window.addEventListener("hashchange", function () {
        try {
          var id = providerIdFromRoute(window.location.hash);
          if (!id) return;
          var host = document.querySelector("[data-pps-host]");
          if (!host) return;
          var p = providerById(id);
          if (p) renderProviderPage(host, p);
        } catch (e) {}
      });
    } catch (e) {}
  }

  /* ---------------- styles ---------------- */
  function injectStyles() {
    if (document.getElementById("pps-styles")) return;
    var css = "" +
      ".pps-wrap{font-family:'Nunito Sans',system-ui,sans-serif;color:var(--text,#383838)}" +
      ".pps-lead{font-size:14px;margin:0 0 14px}" +
      ".pps-search{display:flex;gap:8px;margin-bottom:6px}" +
      ".pps-input{flex:1;padding:11px 14px;border:1.5px solid var(--line,#E6E6E6);border-radius:12px;font-size:15px;" +
        "font-family:inherit}" +
      ".pps-input:focus{outline:none;border-color:var(--purple,#603488)}" +
      ".pps-suggest{margin:4px 0 10px}" +
      ".pps-slist{border:1px solid var(--line,#E6E6E6);border-radius:12px;overflow:hidden}" +
      ".pps-srow{display:flex;justify-content:space-between;align-items:center;gap:10px;width:100%;text-align:left;" +
        "background:#fff;border:none;border-bottom:1px solid var(--line,#E6E6E6);padding:10px 13px;cursor:pointer;" +
        "font-family:inherit;font-size:14px}" +
      ".pps-srow:last-child{border-bottom:none}" +
      ".pps-srow:hover{background:var(--purple-tint,#F0E8F4)}" +
      ".pps-sname{font-family:'Quicksand',system-ui,sans-serif;font-weight:700;color:var(--purple,#603488)}" +
      ".pps-sarea{color:var(--muted,#808080);font-size:12.5px}" +
      ".pps-empty{color:var(--muted,#808080);font-size:13.5px;padding:6px 2px}" +
      ".pps-page{border:1.5px solid var(--line,#E6E6E6);border-radius:16px;padding:16px 18px;background:#fff;margin-top:6px}" +
      ".pps-crumb a{color:var(--purple,#603488);font-size:12.5px;text-decoration:none;font-weight:700}" +
      ".pps-name{font-family:'Quicksand',system-ui,sans-serif;color:var(--purple,#603488);font-size:20px;margin:8px 0 2px}" +
      ".pps-kind{color:var(--muted,#808080);font-size:13px;margin:0 0 8px}" +
      ".pps-summary{font-size:13.5px;margin:0 0 12px}" +
      ".pps-vhead{font-family:'Quicksand',system-ui,sans-serif;color:var(--magenta,#F82488);text-transform:uppercase;" +
        "letter-spacing:.5px;font-size:12px;font-weight:700;margin:10px 0 8px}" +
      ".pps-venues{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:10px}" +
      ".pps-venue{border:1px solid var(--line,#E6E6E6);border-radius:12px;padding:11px 13px}" +
      ".pps-venue-name{font-family:'Quicksand',system-ui,sans-serif;font-weight:700;color:var(--text,#383838);font-size:14.5px;margin-bottom:6px}" +
      ".pps-venue-meta{display:flex;flex-wrap:wrap;gap:6px}" +
      ".pps-chip{font-size:12px;background:var(--purple-tint,#F0E8F4);color:var(--purple,#603488);padding:4px 10px;border-radius:999px;font-weight:700}";
    var s = elx("style", { id: "pps-styles" }, css);
    document.head.appendChild(s);
  }

  /* ---------------- selfTest ---------------- */
  function selfTest() {
    var pass = 0, fail = 0, log = [];
    function check(label, fn) {
      try { fn(); pass += 1; log.push("✓ " + label); }
      catch (e) { fail += 1; log.push("✗ " + label + " — " + (e && e.message ? e.message : String(e))); }
    }

    // A small deterministic fixture so the LOGIC is tested even with no live data.
    var fixture = [
      { id: "kings-camps", name: "Kings Camps Walthamstow", kind: "Multi-sport camp", area: "Walthamstow",
        areas: ["Walthamstow"], ageLabel: "5-14", price: "From £35/day",
        venue: "Walthamstow School for Girls and Frederick Bremer School" },
      { id: "ymca-y-kidz", name: "YMCA Y Kidz Holiday Playscheme", kind: "Playscheme", area: "Highams Park",
        areas: ["Highams Park"], ageLabel: "4-11", price: "From £36/day",
        venue: "Whittingham Primary Academy and Handsworth Primary School" },
      { id: "lloyd-park", name: "Lloyd Park Children's Charity Holiday Club", kind: "Charity club", area: "Walthamstow",
        areas: ["Walthamstow"], ageLabel: "5-12", price: "£40/day",
        venue: "Lloyd Park Centre" }
    ];

    // ACCEPTANCE CRITERION, part 1: typing a provider name routes to THAT provider.
    check("Typing a full provider name routes to that exact provider", function () {
      var p = bestMatch("Kings Camps Walthamstow", fixture);
      HC.assert(p, "no match for full name");
      HC.assert(p.id === "kings-camps", "routed to wrong provider: " + (p && p.id));
    });

    check("Typing a partial/leading name routes to the right provider", function () {
      var p = bestMatch("kings", fixture);
      HC.assert(p && p.id === "kings-camps", "‘kings’ should route to Kings Camps, got " + (p && p.id));
    });

    check("Case/punctuation-insensitive matching (YMCA / ymca)", function () {
      var p = bestMatch("ymca y kidz", fixture);
      HC.assert(p && p.id === "ymca-y-kidz", "lower-case ymca should match, got " + (p && p.id));
    });

    check("An apostrophe in the company name still matches", function () {
      var p = bestMatch("Lloyd Park Children's", fixture);
      HC.assert(p && p.id === "lloyd-park", "apostrophe name should match, got " + (p && p.id));
    });

    check("A non-existent company yields no match (no false route)", function () {
      var p = bestMatch("Totally Made Up Camp Co", fixture);
      HC.assert(!p, "should not route to anything, got " + (p && p.id));
    });

    check("Empty query routes nowhere", function () {
      HC.assert(!bestMatch("", fixture), "empty query must not match");
      HC.assert(!bestMatch("   ", fixture), "whitespace query must not match");
    });

    // Routing helpers round-trip.
    check("Route encodes and decodes a provider id", function () {
      var route = routeForProvider({ id: "kings-camps" });
      HC.assert(route === "#/provider/kings-camps", "unexpected route: " + route);
      HC.assert(providerIdFromRoute(route) === "kings-camps", "route did not decode back");
      HC.assert(providerIdFromRoute("#/other/x") === null, "non-provider route should be null");
    });

    // ACCEPTANCE CRITERION, part 2: the routed page lists ALL their camps BY VENUE.
    check("Provider page lists all their camps grouped BY VENUE", function () {
      var p = bestMatch("Kings Camps", fixture);
      var model = providerPageModel(p);
      HC.assert(model, "no page model");
      // Kings Camps fixture has two venues joined by " and ".
      HC.assert(model.venues.length === 2, "expected 2 venues, got " + model.venues.length);
      var names = model.venues.map(function (v) { return v.venue; });
      HC.assert(names.indexOf("Walthamstow School for Girls") !== -1, "missing first venue: " + names.join(" | "));
      HC.assert(names.indexOf("Frederick Bremer School") !== -1, "missing second venue: " + names.join(" | "));
      HC.assert(model.camps === model.venues.length, "camps count should equal venue count");
    });

    check("Single-venue provider lists exactly one venue", function () {
      var model = providerPageModel(bestMatch("Lloyd Park", fixture));
      HC.assert(model && model.venues.length === 1, "expected 1 venue for Lloyd Park");
      HC.assert(model.venues[0].venue === "Lloyd Park Centre", "wrong venue: " + model.venues[0].venue);
    });

    check("Each listed venue carries the provider's age + price detail", function () {
      var model = providerPageModel(bestMatch("YMCA", fixture));
      HC.assert(model && model.venues.length === 2, "expected 2 YMCA venues");
      model.venues.forEach(function (v) {
        HC.assert(v.ageLabel === "4-11", "venue lost ageLabel: " + v.ageLabel);
        HC.assert(/£36/.test(v.price), "venue lost price: " + v.price);
      });
    });

    check("splitVenues handles ' and ' / ',' / ';' / ' / ' and de-dupes", function () {
      HC.assert(splitVenues("A and B").length === 2, "and-split failed");
      HC.assert(splitVenues("A, B, C").length === 3, "comma-split failed");
      HC.assert(splitVenues("A; B").length === 2, "semicolon-split failed");
      HC.assert(splitVenues("A / B").length === 2, "slash-split failed");
      HC.assert(splitVenues("Lloyd Park and Lloyd Park").length === 1, "should de-dupe identical venues");
      HC.assert(splitVenues("").length === 0, "empty venue -> empty list");
    });

    check("Search ranks exact match above partial; results sorted best-first", function () {
      var two = [
        { id: "a", name: "Camp Energy", area: "X", venue: "V1" },
        { id: "b", name: "Energy Kids Holiday Camp", area: "Y", venue: "V2" }
      ];
      var res = searchProviders("Camp Energy", two);
      HC.assert(res.length >= 1, "expected matches");
      HC.assert(res[0].id === "a", "exact name should rank first, got " + res[0].id);
    });

    // LIVE DATA: exercise the acceptance criterion end-to-end on the real directory.
    check("Live: typing each real provider's name routes back to itself", function () {
      var live = allProviders();
      if (!live.length) { HC.assert(true, "no live data in this context — skipped"); return; }
      var checked = 0;
      for (var i = 0; i < live.length; i++) {
        var name = str(live[i] && live[i].name);
        if (!name) continue;
        var p = bestMatch(name, live);
        HC.assert(p, "no route for live provider “" + name + "”");
        HC.assert(p.id === live[i].id,
          "typing “" + name + "” routed to " + (p && p.id) + " not " + live[i].id);
        checked += 1;
      }
      HC.assert(checked > 0, "expected to check at least one live provider");
    });

    check("Live: every routed provider page lists at least one venue", function () {
      var live = allProviders();
      if (!live.length) { HC.assert(true, "no live data — skipped"); return; }
      for (var i = 0; i < live.length; i++) {
        var model = providerPageModel(live[i]);
        HC.assert(model, "no model for " + live[i].id);
        HC.assert(model.venues.length >= 1,
          "provider " + live[i].id + " listed zero venues");
        // every venue must have a non-empty name
        model.venues.forEach(function (v) {
          HC.assert(str(v.venue).trim().length > 0, "empty venue name on " + live[i].id);
        });
      }
    });

    check("Live: provider page weeks come from the planner (when present)", function () {
      var live = allProviders();
      if (!live.length) { HC.assert(true, "no live data — skipped"); return; }
      // Find a provider that has planner weeks, then assert the model surfaces them.
      var withWeeks = null;
      for (var i = 0; i < live.length; i++) {
        if (weeksFor(live[i].id).length) { withWeeks = live[i]; break; }
      }
      if (!withWeeks) { HC.assert(true, "no provider has planner weeks — skipped"); return; }
      var model = providerPageModel(withWeeks);
      var expected = weeksFor(withWeeks.id);
      model.venues.forEach(function (v) {
        HC.assert(v.weeks.length === expected.length,
          "venue weeks did not match planner for " + withWeeks.id);
      });
    });

    return { pass: pass, fail: fail, log: log };
  }

  /* ---------------- register ---------------- */
  HC.registerFeature({
    id: "parent-provider-search",
    title: "Search by provider name",
    side: "parent",
    icon: "🔎",
    summary: "Know the company you want? Type their name to jump straight to their page — every camp they run, listed by venue.",
    render: render,
    enhance: enhance,
    selfTest: selfTest
  });
})();
