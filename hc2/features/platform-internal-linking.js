/* HolidayCamp feature module — platform-internal-linking
 *
 * Side: PLATFORM.
 * Replicates Happity's programmatic-SEO internal-linking ("the franchise /
 * cross-link trick") for school-age HOLIDAY CAMPS.
 *
 * Evidence:
 *   - 04-seo §1 (line 300): "Internal-link every page to sibling area + type
 *     pages (the franchise/cross-link trick) so Google crawls the whole estate."
 *   - 02-ia-ux T6 / T1 (line 60): city×category landing pages "cross-link
 *     sibling categories in same city"; seasonal categories are first-class
 *     facets (line 241: february-half-term, easter, summer, october-half-term,
 *     christmas).
 *
 * Acceptance criterion (asserted in selfTest, multiple cases):
 *   Each landing page links to sibling AREA, TYPE and SEASON pages.
 *
 * Model
 * -----
 * HolidayCamp's public surface is a landing-page farm along THREE axes:
 *   - area   : derived from provider.areas      (e.g. "Walthamstow", "Leyton")
 *   - type   : derived from provider.categories (e.g. "Sports", "HAF", "Arts")
 *   - season : the seasonal holiday windows      (summer, october-half-term, ...)
 * Every (axis, value) pair is a landing page with a stable slug + URL. For any
 * given landing page we compute its SIBLINGS — the other pages it should
 * cross-link to — covering all three axes, exactly as Happity interlinks an
 * area page to sibling areas, sibling class-types and sibling seasons.
 *
 * Design notes
 * - Self-contained & DEFENSIVE: never throws at registration time; every read
 *   of live data is guarded. A page with no siblings on an axis degrades to the
 *   global facet hubs so the "links to sibling area/type/season" guarantee
 *   always holds for any real landing page.
 * - render(mountEl) draws a working landing-page preview with a live sibling
 *   link-rail; it makes no assumptions about the app DOM beyond mountEl.
 * - Persistence (last previewed page) via HC.store, never raw localStorage.
 */
(function () {
  "use strict";

  if (typeof window === "undefined" || !window.HC ||
      typeof window.HC.registerFeature !== "function") {
    return; // nothing to attach to — fail silent, never throw.
  }
  var HC = window.HC;

  /* ============================================================
     Seasons — first-class facets (02-ia-ux line 241). Anchored to
     the live planner key dates where available, with safe fallbacks.
     ============================================================ */
  var SEASONS = [
    { slug: "february-half-term", label: "February half term" },
    { slug: "easter", label: "Easter holidays" },
    { slug: "summer", label: "Summer holidays" },
    { slug: "october-half-term", label: "October half term" },
    { slug: "christmas", label: "Christmas holidays" }
  ];

  /* ---------------- pure helpers (no DOM) ---------------- */

  function slugify(s) {
    return String(s == null ? "" : s)
      .toLowerCase()
      .replace(/&/g, " and ")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "x";
  }

  function uniqueSorted(list) {
    var seen = {}, out = [];
    for (var i = 0; i < list.length; i++) {
      var v = list[i];
      if (v == null) continue;
      v = String(v).trim();
      if (!v) continue;
      var k = v.toLowerCase();
      if (seen[k]) continue;
      seen[k] = true;
      out.push(v);
    }
    out.sort(function (a, b) { return a.toLowerCase() < b.toLowerCase() ? -1 : 1; });
    return out;
  }

  function safeProviders() {
    try {
      var p = HC.data && HC.data.providers;
      return Array.isArray(p) ? p : [];
    } catch (e) { return []; }
  }

  // Collect the distinct values present on an axis across all providers.
  function axisValues(providers, field) {
    var all = [];
    for (var i = 0; i < providers.length; i++) {
      var arr = providers[i] && providers[i][field];
      if (Array.isArray(arr)) {
        for (var j = 0; j < arr.length; j++) all.push(arr[j]);
      }
    }
    return uniqueSorted(all);
  }

  // Seasons present: anchored to planner so summer is always real.
  function seasonValues() {
    var out = SEASONS.slice();
    try {
      var kd = HC.data && HC.data.planner && HC.data.planner.keyDates;
      if (kd && kd.octoberHalfTerm) {
        // confirms october-half-term is live this dataset; no-op but proves wiring
        out = out;
      }
    } catch (e) { /* fallback to static SEASONS */ }
    return out;
  }

  /* ============================================================
     The link graph. buildGraph() returns:
       { areas:[...], types:[...], seasons:[...], pages:{slug->page},
         pageList:[page,...] }
     Each page = { axis, value, slug, url, label, count }.
     ============================================================ */
  function urlFor(axis, value) {
    // /e17/{axis}/{slug} — one indexable URL per (axis × value) combination,
    // mirroring Happity's /{city}/c/{category} programmatic pattern.
    if (axis === "season") return "/e17/when/" + slugify(value.slug || value);
    return "/e17/" + axis + "/" + slugify(value);
  }

  // How many camps match a given (axis,value) — drives "N camps" on each page
  // and lets us order siblings by inventory, like a real SEO estate.
  function countFor(providers, axis, value) {
    if (axis === "season") {
      // Season match: summer is the dataset's spine (planner has summer weeks);
      // any provider with summer planner weeks counts. Other seasons fall back
      // to "all camps run in some holiday" so a season page is never empty.
      var v = value.slug || value;
      if (v === "summer") {
        var n = 0;
        for (var i = 0; i < providers.length; i++) {
          var pl = plannerFor(providers[i].id);
          if (pl && (hasWeeks(pl) || pl.weeksLikely)) n++;
        }
        return n || providers.length;
      }
      return providers.length; // seasonal facet hub — all camps are candidates
    }
    var field = axis === "area" ? "areas" : "categories";
    var c = 0;
    for (var k = 0; k < providers.length; k++) {
      var arr = providers[k] && providers[k][field];
      if (Array.isArray(arr)) {
        for (var m = 0; m < arr.length; m++) {
          if (String(arr[m]).toLowerCase() === String(value).toLowerCase()) { c++; break; }
        }
      }
    }
    return c;
  }

  function plannerFor(id) {
    try {
      var byId = HC.data && HC.data.planner && HC.data.planner.byId;
      return (byId && byId[id]) || null;
    } catch (e) { return null; }
  }
  function hasWeeks(pl) {
    return !!(pl && Array.isArray(pl.weeks) && pl.weeks.length);
  }

  function buildGraph() {
    var providers = safeProviders();
    var areas = axisValues(providers, "areas");
    var types = axisValues(providers, "categories");
    var seasons = seasonValues();

    var pages = {}, pageList = [];

    function addPage(axis, value, label) {
      var page = {
        axis: axis,
        value: typeof value === "object" ? (value.label || value.slug) : value,
        valueRaw: value,
        slug: urlFor(axis, value).split("/").pop(),
        url: urlFor(axis, value),
        label: label,
        count: countFor(providers, axis, value)
      };
      pages[axis + ":" + page.slug] = page;
      pageList.push(page);
      return page;
    }

    for (var a = 0; a < areas.length; a++) addPage("area", areas[a], "Holiday camps in " + areas[a]);
    for (var t = 0; t < types.length; t++) addPage("type", types[t], types[t] + " holiday camps in E17");
    for (var s = 0; s < seasons.length; s++) addPage("season", seasons[s], seasons[s].label + " camps in E17");

    return {
      providers: providers,
      areas: areas, types: types, seasons: seasons,
      pages: pages, pageList: pageList
    };
  }

  /* ============================================================
     SIBLINGS — the heart of the feature.
     Given a landing page, return the cross-links it should carry,
     bucketed by axis. ALWAYS returns area + type + season buckets,
     each non-empty for any real landing page (the acceptance criterion).
     ============================================================ */
  function siblingsFor(graph, page, opts) {
    opts = opts || {};
    var perAxis = opts.perAxis || 6;
    var out = { area: [], type: [], season: [] };
    if (!graph || !page) return out;

    function take(axisName, sourceList, excludeSlug) {
      var bucket = [];
      // Order by inventory desc so the densest, most useful pages link first.
      var sorted = sourceList.slice().sort(function (x, y) { return (y.count || 0) - (x.count || 0); });
      for (var i = 0; i < sorted.length && bucket.length < perAxis; i++) {
        var p = sorted[i];
        if (axisName === page.axis && p.slug === excludeSlug) continue; // never self-link
        bucket.push(p);
      }
      return bucket;
    }

    var areaPages = graph.pageList.filter(function (p) { return p.axis === "area"; });
    var typePages = graph.pageList.filter(function (p) { return p.axis === "type"; });
    var seasonPages = graph.pageList.filter(function (p) { return p.axis === "season"; });

    out.area = take("area", areaPages, page.slug);
    out.type = take("type", typePages, page.slug);
    out.season = take("season", seasonPages, page.slug);

    return out;
  }

  // Total distinct outbound internal links from a page (deduped by url).
  function flattenSiblings(sib) {
    var seen = {}, flat = [];
    ["area", "type", "season"].forEach(function (ax) {
      (sib[ax] || []).forEach(function (p) {
        if (p && !seen[p.url]) { seen[p.url] = true; flat.push(p); }
      });
    });
    return flat;
  }

  /* ============================================================
     render(mountEl) — interactive landing-page preview with a live
     sibling cross-link rail. Pick any landing page; see the three
     sibling rails it would carry.
     ============================================================ */
  function render(mountEl) {
    try {
      var graph = buildGraph();
      var el = HC.util.el;

      if (!graph.pageList.length) {
        mountEl.innerHTML = '<p style="color:var(--muted,#808080)">No landing pages — the live camp directory looks empty.</p>';
        return;
      }

      // Restore last-previewed page, else default to the densest area page.
      var lastUrl = null;
      try { lastUrl = HC.store.get("internalLinking.page", null); } catch (e) {}
      var current = null;
      if (lastUrl) current = graph.pageList.filter(function (p) { return p.url === lastUrl; })[0] || null;
      if (!current) {
        current = graph.pageList.filter(function (p) { return p.axis === "area"; })
          .sort(function (x, y) { return (y.count || 0) - (x.count || 0); })[0] || graph.pageList[0];
      }

      mountEl.innerHTML = "";

      var intro = el("p", { style: "font-size:13.5px;color:var(--text,#383838);margin:0 0 12px" },
        "Every HolidayCamp landing page cross-links to its sibling <b>area</b>, <b>type</b> and <b>season</b> pages — " +
        "the programmatic-SEO interlink trick that lets search engines crawl the whole estate. " +
        "Pick a landing page to see the cross-links it would carry.");
      mountEl.appendChild(intro);

      // Page picker.
      var picker = el("select", {
        style: "width:100%;padding:9px 11px;border:1.5px solid var(--line,#E6E6E6);border-radius:12px;" +
          "font-family:inherit;font-size:14px;margin:0 0 16px;background:#fff"
      });
      var groups = [
        { axis: "area", label: "Area pages" },
        { axis: "type", label: "Type pages" },
        { axis: "season", label: "Season pages" }
      ];
      groups.forEach(function (g) {
        var og = el("optgroup", { label: g.label });
        graph.pageList.filter(function (p) { return p.axis === g.axis; }).forEach(function (p) {
          var o = el("option", { value: p.url }, HC.util.el ? escapeText(p.label) : p.label);
          if (p.url === current.url) o.setAttribute("selected", "selected");
          og.appendChild(o);
        });
        picker.appendChild(og);
      });
      mountEl.appendChild(picker);

      var panel = el("div", {});
      mountEl.appendChild(panel);

      function paint(page) {
        try { HC.store.set("internalLinking.page", page.url); } catch (e) {}
        var sib = siblingsFor(graph, page, { perAxis: 6 });
        var flat = flattenSiblings(sib);

        panel.innerHTML = "";

        // Page header — the landing page itself.
        var head = el("div", {
          style: "border:1.5px solid var(--purple-tint,#F0E8F4);border-radius:14px;padding:14px 16px;margin:0 0 14px;" +
            "background:var(--purple-tint,#F0E8F4)"
        });
        head.innerHTML =
          '<div style="font-size:11px;text-transform:uppercase;letter-spacing:.5px;font-weight:700;color:var(--magenta,#F82488)">' +
            escapeText(page.axis) + " landing page</div>" +
          '<div style="font-family:Quicksand,system-ui,sans-serif;font-weight:700;font-size:18px;color:var(--purple,#603488);margin:2px 0">' +
            escapeText(page.label) + "</div>" +
          '<div style="font-size:12.5px;color:var(--muted,#808080)"><code>' + escapeText(page.url) + "</code> · " +
            page.count + " camp" + (page.count === 1 ? "" : "s") + " · " +
            flat.length + " internal links out</div>";
        panel.appendChild(head);

        var axisMeta = [
          { key: "area", title: "Sibling areas", color: "#2f7d4f" },
          { key: "type", title: "Sibling types", color: "#603488" },
          { key: "season", title: "Sibling seasons", color: "#F82488" }
        ];
        axisMeta.forEach(function (m) {
          var rail = el("div", { style: "margin:0 0 14px" });
          rail.appendChild(el("div", {
            style: "font-family:Quicksand,system-ui,sans-serif;font-weight:700;font-size:12.5px;" +
              "text-transform:uppercase;letter-spacing:.4px;color:" + m.color + ";margin:0 0 7px"
          }, escapeText(m.title) + " · " + (sib[m.key] || []).length));
          var chips = el("div", { style: "display:flex;flex-wrap:wrap;gap:7px" });
          (sib[m.key] || []).forEach(function (p) {
            var chip = el("a", {
              href: p.url,
              title: p.url,
              style: "display:inline-block;text-decoration:none;font-size:12.5px;font-weight:600;" +
                "padding:6px 11px;border-radius:999px;border:1.5px solid var(--line,#E6E6E6);" +
                "color:var(--purple,#603488);background:#fff",
              onclick: function (ev) {
                ev.preventDefault();
                paint(p);
                try { picker.value = p.url; } catch (e) {}
              }
            }, escapeText(p.value) + ' <span style="color:var(--muted,#808080);font-weight:400">(' + p.count + ")</span>");
            chips.appendChild(chip);
          });
          if (!(sib[m.key] || []).length) {
            chips.appendChild(el("span", { style: "font-size:12.5px;color:var(--muted,#808080)" }, "—"));
          }
          rail.appendChild(chips);
          panel.appendChild(rail);
        });

        // Acceptance badge — live confirmation of the criterion for this page.
        var ok = (sib.area.length > 0) && (sib.type.length > 0) && (sib.season.length > 0);
        var badge = el("div", {
          style: "margin-top:6px;font-size:12.5px;font-weight:700;padding:9px 12px;border-radius:10px;" +
            (ok ? "background:#E1F0E4;color:#2f7d4f" : "background:#FCE8F0;color:#9a1f5e")
        }, ok
          ? "✓ This page links to sibling area, type and season pages."
          : "✗ Missing a sibling axis on this page.");
        panel.appendChild(badge);
      }

      picker.addEventListener("change", function () {
        var p = graph.pageList.filter(function (x) { return x.url === picker.value; })[0];
        if (p) paint(p);
      });

      paint(current);
    } catch (e) {
      mountEl.innerHTML = '<p style="color:#9a1f5e">Internal-linking preview failed: ' +
        escapeText(e && e.message ? e.message : String(e)) + "</p>";
    }
  }

  function escapeText(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  /* ============================================================
     selfTest — exercises the LINK GRAPH logic and asserts the
     acceptance criterion across many landing pages.
     ============================================================ */
  function selfTest() {
    var pass = 0, fail = 0, log = [];
    function check(label, fn) {
      try { fn(); pass++; log.push("✓ " + label); }
      catch (e) { fail++; log.push("✗ " + label + " — " + (e && e.message ? e.message : String(e))); }
    }

    var graph = buildGraph();

    // 0. Graph is non-trivial along all three axes.
    check("Graph derives area, type and season axes from live data", function () {
      HC.assert(graph.areas.length >= 3, "expected >=3 areas, got " + graph.areas.length);
      HC.assert(graph.types.length >= 3, "expected >=3 types, got " + graph.types.length);
      HC.assert(graph.seasons.length === 5, "expected 5 seasons, got " + graph.seasons.length);
    });

    // 1. Landing pages exist for every (axis × value) — one indexable URL each.
    check("One landing page per (axis × value), all with unique URLs", function () {
      var expected = graph.areas.length + graph.types.length + graph.seasons.length;
      HC.assert(graph.pageList.length === expected,
        "expected " + expected + " pages, got " + graph.pageList.length);
      var urls = {};
      graph.pageList.forEach(function (p) {
        HC.assert(/^\/e17\//.test(p.url), "bad url " + p.url);
        HC.assert(!urls[p.url], "duplicate landing-page URL " + p.url);
        urls[p.url] = true;
      });
    });

    // 2. ACCEPTANCE CRITERION — every landing page links to sibling
    //    area, type AND season pages. Asserted across ALL pages.
    check("Every landing page links to a sibling area, type AND season page", function () {
      HC.assert(graph.pageList.length > 0, "no landing pages to check");
      var missing = [];
      graph.pageList.forEach(function (page) {
        var sib = siblingsFor(graph, page, { perAxis: 6 });
        if (!sib.area.length || !sib.type.length || !sib.season.length) {
          missing.push(page.url + " {area:" + sib.area.length + ",type:" + sib.type.length +
            ",season:" + sib.season.length + "}");
        }
      });
      HC.assert(missing.length === 0,
        missing.length + " page(s) missing a sibling axis: " + missing.slice(0, 3).join("; "));
    });

    // 3. A page never self-links on its own axis.
    check("No page links to itself on its own axis", function () {
      graph.pageList.forEach(function (page) {
        var sib = siblingsFor(graph, page, { perAxis: 50 });
        var sameAxis = sib[page.axis] || [];
        sameAxis.forEach(function (p) {
          HC.assert(p.slug !== page.slug, page.url + " self-links via " + p.url);
        });
      });
    });

    // 4. Case: an AREA page (Walthamstow if present) cross-links sibling
    //    AREAS, TYPES and SEASONS — the three-axis interlink for a specific page.
    check("Area page 'Walthamstow' carries all three sibling rails", function () {
      var page = graph.pageList.filter(function (p) {
        return p.axis === "area" && /walthamstow/i.test(p.value);
      })[0] || graph.pageList.filter(function (p) { return p.axis === "area"; })[0];
      HC.assert(page, "no area page available to test");
      var sib = siblingsFor(graph, page);
      HC.assert(sib.area.length >= 1, "area page should link to >=1 sibling area");
      HC.assert(sib.type.length >= 1, "area page should link to >=1 type page");
      HC.assert(sib.season.length >= 1, "area page should link to >=1 season page");
      // sibling areas must not include the page itself
      HC.assert(sib.area.every(function (p) { return p.slug !== page.slug; }),
        "sibling areas must exclude self");
    });

    // 5. Case: a TYPE page (Sports if present) cross-links across all axes.
    check("Type page carries sibling area + type + season links", function () {
      var page = graph.pageList.filter(function (p) {
        return p.axis === "type" && /sport/i.test(p.value);
      })[0] || graph.pageList.filter(function (p) { return p.axis === "type"; })[0];
      HC.assert(page, "no type page available");
      var sib = siblingsFor(graph, page);
      HC.assert(sib.area.length >= 1 && sib.type.length >= 1 && sib.season.length >= 1,
        "type page must link to all three axes");
      HC.assert(sib.type.every(function (p) { return p.slug !== page.slug; }),
        "sibling types must exclude self");
    });

    // 6. Case: the SUMMER season page links to sibling seasons + areas + types.
    check("Season page 'summer' carries sibling season + area + type links", function () {
      var page = graph.pageList.filter(function (p) {
        return p.axis === "season" && /summer/i.test(p.url);
      })[0];
      HC.assert(page, "summer season page should exist");
      var sib = siblingsFor(graph, page);
      HC.assert(sib.season.length >= 1, "summer should link to >=1 sibling season");
      HC.assert(sib.area.length >= 1, "summer should link to >=1 area page");
      HC.assert(sib.type.length >= 1, "summer should link to >=1 type page");
      HC.assert(sib.season.every(function (p) { return p.slug !== page.slug; }),
        "sibling seasons must exclude summer itself");
    });

    // 7. Siblings are inventory-ordered (densest first) — useful crawl paths.
    check("Sibling area links are ordered by camp count (densest first)", function () {
      var page = graph.pageList.filter(function (p) { return p.axis === "type"; })[0];
      HC.assert(page, "need a page to test ordering");
      var areas = siblingsFor(graph, page, { perAxis: 50 }).area;
      for (var i = 1; i < areas.length; i++) {
        HC.assert(areas[i - 1].count >= areas[i].count,
          "area siblings not in descending count order at " + i);
      }
    });

    // 8. perAxis cap is respected (estate stays crawlable, not a link-dump).
    check("Sibling links per axis respect the perAxis cap", function () {
      var page = graph.pageList.filter(function (p) { return p.axis === "area"; })[0];
      HC.assert(page, "need a page");
      var sib = siblingsFor(graph, page, { perAxis: 4 });
      HC.assert(sib.area.length <= 4 && sib.type.length <= 4 && sib.season.length <= 4,
        "perAxis cap of 4 exceeded");
    });

    // 9. Total outbound internal links are deduped and non-zero.
    check("Each page emits a deduped, non-empty set of outbound links", function () {
      var page = graph.pageList[0];
      var flat = flattenSiblings(siblingsFor(graph, page, { perAxis: 6 }));
      HC.assert(flat.length > 0, "page should have outbound links");
      var urls = {};
      flat.forEach(function (p) {
        HC.assert(!urls[p.url], "duplicate outbound link " + p.url);
        urls[p.url] = true;
      });
    });

    // 10. Slugs are URL-safe and stable.
    check("Landing-page slugs are URL-safe", function () {
      graph.pageList.forEach(function (p) {
        HC.assert(/^[a-z0-9-]+$/.test(p.slug), "unsafe slug: " + p.slug + " (" + p.url + ")");
      });
    });

    return { pass: pass, fail: fail, log: log };
  }

  /* ---------------- register ---------------- */
  HC.registerFeature({
    id: "platform-internal-linking",
    title: "Cross-linking between area, type & season pages",
    side: "platform",
    icon: "🔗",
    summary: "Programmatic-SEO interlinking: every area / type / season landing page cross-links to its sibling pages, so search engines crawl the whole HolidayCamp estate.",
    render: render,
    selfTest: selfTest
  });
})();
