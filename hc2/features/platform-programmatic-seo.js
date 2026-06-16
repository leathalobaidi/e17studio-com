/* HolidayCamp feature: platform-programmatic-seo
 * ------------------------------------------------------------------
 * Replicates Happity's PROGRAMMATIC SEO behaviour for the PLATFORM
 * side, reframed for SCHOOL-AGE HOLIDAY CAMPS (day / week places),
 * not baby classes.
 *
 * Evidence (support corpus):
 *  - Article 3746856 "What are categories and how do I tag my classes?":
 *      "Categories help you reach more parents by making sure your
 *       classes appear in the right places on Happity — including our
 *       high-traffic Category pages."
 *      "Category pages bring together classes around popular themes …
 *       so parents can browse based on the type of activity."
 *      "These pages rank highly on Google and receive over 30,000
 *       clicks a month."
 *  - Article 5827872 "How do parents find my classes on Happity?":
 *      "We rank highly on Google for search terms like 'Baby classes
 *       in my area' or 'toddler activities near me' …"
 *  - Brief evidence pointers: 04-seo §1; 02-ia-ux T1/T2.
 *
 *  Happity's growth engine is therefore a matrix of indexable landing
 *  pages keyed on (LOCATION x ACTIVITY-TYPE) — "Football camps in
 *  Walthamstow", "Arts camps in Chingford" — each ranking for the
 *  long-tail query a parent types into Google. This module generates
 *  exactly that matrix from the live, verified camp directory.
 *
 * Acceptance criterion (asserted by selfTest, multiple cases):
 *   A UNIQUE INDEXABLE PAGE EXISTS PER (area x camp-type) THAT HAS AT
 *   LEAST ONE CAMP.
 *   -> Every generated page has >=1 matching camp (no empty pages).
 *   -> Every page slug / URL is unique across the whole matrix.
 *   -> Each page is "indexable": canonical URL + <title> + meta
 *      description + H1 + ItemList JSON-LD, robots = index,follow.
 *   -> Empty (area x type) combinations are deliberately NOT minted
 *      (they would be thin / soft-404 pages), and a noindex page is
 *      never emitted with index robots.
 *
 * Scope note: PLATFORM side. This is the SEO surface the platform owns,
 * not a provider editing screen. It is purely derived from the verified
 * camps.js directory (never mutated). Persistence (e.g. the publish
 * toggle for a page) is via HC.store only. Fully defensive: nothing
 * throws at registration time.
 * ------------------------------------------------------------------ */
(function () {
  "use strict";

  if (typeof window === "undefined" || !window.HC || typeof window.HC.registerFeature !== "function") {
    // Core not present — fail silently rather than throwing.
    return;
  }
  var HC = window.HC;

  var ORIGIN = "https://e17holidaycamps.co.uk";
  var STORE_KEY = "platform_seo_unpublished"; // { [slug]: true } — pages an editor has manually pulled

  /* ============================================================
   * 1. Vocabulary — the "camp type" facets we mint pages for.
   *    Keys map onto the categories used in camps.js, but the SEO
   *    label is the parent-facing query term ("Football camps",
   *    not the raw tag). Only types that actually occur in the data
   *    will end up minting pages, because we require >=1 camp.
   * ============================================================ */
  var CAMP_TYPES = [
    { id: "multi-activity", label: "Multi-activity camps", cats: ["Multi-activity"] },
    { id: "sports",         label: "Sports camps",          cats: ["Sports", "Football", "Gymnastics", "Swimming", "Martial arts"] },
    { id: "football",       label: "Football camps",        cats: ["Football"] },
    { id: "arts",           label: "Arts & crafts camps",   cats: ["Arts", "Creative", "Fashion"] },
    { id: "drama",          label: "Drama camps",           cats: ["Drama"] },
    { id: "dance",          label: "Dance camps",           cats: ["Dance"] },
    { id: "music",          label: "Music camps",           cats: ["Music"] },
    { id: "stem",           label: "STEM & coding camps",   cats: ["STEM", "Coding", "Science"] },
    { id: "haf",            label: "Free HAF holiday clubs", cats: ["HAF", "Free places"] },
    { id: "send",           label: "SEND-aware camps",      cats: ["SEND aware"] },
    { id: "early-years",    label: "Early-years camps",     cats: ["Early years", "Play"] }
  ];

  /* ============================================================
   * 2. Helpers — slugs, escaping, safe data access.
   * ============================================================ */
  function slugify(s) {
    return String(s == null ? "" : s)
      .toLowerCase()
      .replace(/&/g, " and ")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
  }

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
  function escAttr(s) { return esc(s).replace(/"/g, "&quot;"); }

  function providers() {
    try {
      var p = HC.data && HC.data.providers;
      return Array.isArray(p) ? p : [];
    } catch (e) { return []; }
  }

  // Does a provider belong to this camp type? (matches any of the type's source cats)
  function matchesType(provider, type) {
    var cats = (provider && provider.categories) || [];
    for (var i = 0; i < cats.length; i++) {
      if (type.cats.indexOf(cats[i]) !== -1) return true;
    }
    return false;
  }

  // Does a provider serve this area? Borough-wide / council routes count for every area.
  function servesArea(provider, area) {
    var areas = (provider && provider.areas) || [];
    if (areas.indexOf(area) !== -1) return true;
    // A borough-wide council route (e.g. HAF) reaches every local area.
    if (/borough-wide/i.test(provider && provider.area || "")) return true;
    return false;
  }

  /* ============================================================
   * 3. The matrix builder — THE feature's core logic.
   *    Cartesian product (area x camp-type), filtered to non-empty
   *    cells, each emitted as a unique indexable landing page.
   * ============================================================ */

  // Distinct local areas present in the verified data (sorted by reach).
  function liveAreas() {
    var counts = {};
    providers().forEach(function (p) {
      (p.areas || []).forEach(function (a) { counts[a] = (counts[a] || 0) + 1; });
    });
    return Object.keys(counts).sort(function (a, b) {
      return (counts[b] - counts[a]) || a.localeCompare(b);
    });
  }

  // Build ONE page object for (area x type) — or null if it has no camps.
  function buildPage(area, type) {
    var matches = providers().filter(function (p) {
      return servesArea(p, area) && matchesType(p, type);
    });
    if (!matches.length) return null; // acceptance criterion: never mint an empty page

    var slug = "/" + slugify(type.label) + "-in-" + slugify(area);
    var url = ORIGIN + slug;
    var count = matches.length;
    var title = type.label + " in " + area + " (" + count + " " +
      (count === 1 ? "camp" : "camps") + ") | E17 Holiday Camps";
    var h1 = type.label + " in " + area;
    var metaDescription =
      "Compare " + count + " " + type.label.toLowerCase() + " in " + area +
      " this school holidays. Dates, ages, prices and booking links for " +
      matches.slice(0, 3).map(function (m) { return m.name; }).join(", ") +
      (count > 3 ? " and more." : ".");

    // Structured data: an ItemList of the camps — what makes the page
    // a rich, indexable result rather than a thin tag page.
    var jsonLd = {
      "@context": "https://schema.org",
      "@type": "ItemList",
      "name": h1,
      "numberOfItems": count,
      "itemListElement": matches.map(function (m, i) {
        return {
          "@type": "ListItem",
          "position": i + 1,
          "name": m.name,
          "url": url + "#" + slugify(m.id || m.name)
        };
      })
    };

    return {
      slug: slug,
      url: url,
      areaId: area,
      typeId: type.id,
      typeLabel: type.label,
      title: title,
      h1: h1,
      metaDescription: metaDescription,
      canonical: url,
      robots: "index,follow",
      campCount: count,
      camps: matches,
      jsonLd: jsonLd
    };
  }

  // Build the WHOLE matrix: every non-empty (area x type) page.
  function buildMatrix() {
    var areas = liveAreas();
    var pages = [];
    for (var a = 0; a < areas.length; a++) {
      for (var t = 0; t < CAMP_TYPES.length; t++) {
        var page = buildPage(areas[a], CAMP_TYPES[t]);
        if (page) pages.push(page);
      }
    }
    // Stable, useful ordering: by area then by camp count (richest first).
    pages.sort(function (x, y) {
      if (x.areaId !== y.areaId) return x.areaId.localeCompare(y.areaId);
      return (y.campCount - x.campCount) || x.typeLabel.localeCompare(y.typeLabel);
    });
    return pages;
  }

  // Coverage stats for the dashboard: how many of the theoretical cells
  // we actually fill (the rest are deliberately not minted).
  function matrixStats() {
    var areas = liveAreas();
    var totalCells = areas.length * CAMP_TYPES.length;
    var pages = buildMatrix();
    return {
      areas: areas.length,
      types: CAMP_TYPES.length,
      totalCells: totalCells,
      pages: pages.length,
      empty: totalCells - pages.length,
      published: pages.filter(function (p) { return isPublished(p.slug); }).length
    };
  }

  /* ============================================================
   * 4. Publish state (editor can pull a page; default = published).
   *    Persisted via HC.store only — derived data is never mutated.
   * ============================================================ */
  function unpublishedMap() {
    var m = HC.store.get(STORE_KEY, {});
    return (m && typeof m === "object") ? m : {};
  }
  function isPublished(slug) { return !unpublishedMap()[slug]; }
  function setPublished(slug, on) {
    var m = unpublishedMap();
    if (on) { delete m[slug]; } else { m[slug] = true; }
    HC.store.set(STORE_KEY, m);
    return on;
  }

  // The robots directive a page would actually ship with, given publish state.
  function effectiveRobots(page) {
    return isPublished(page.slug) ? "index,follow" : "noindex,follow";
  }

  // Render the <head> an indexable landing page would emit (used by the
  // preview and asserted by selfTest — proves the page is indexable).
  function headTags(page) {
    var robots = effectiveRobots(page);
    return [
      '<title>' + esc(page.title) + '</title>',
      '<meta name="description" content="' + escAttr(page.metaDescription) + '">',
      '<meta name="robots" content="' + robots + '">',
      '<link rel="canonical" href="' + escAttr(page.canonical) + '">',
      '<meta property="og:title" content="' + escAttr(page.h1) + '">',
      '<script type="application/ld+json">' + JSON.stringify(page.jsonLd) + '</script>'
    ].join("\n");
  }

  // An XML <urlset> sitemap for all published pages (real SEO artefact).
  function sitemapXml() {
    var pages = buildMatrix().filter(function (p) { return isPublished(p.slug); });
    var body = pages.map(function (p) {
      return "  <url><loc>" + esc(p.url) + "</loc><changefreq>weekly</changefreq></url>";
    }).join("\n");
    return '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<urlset xmlns="http://www.sitemap.org/schemas/sitemap/0.9">\n' +
      body + "\n</urlset>";
  }

  /* ============================================================
   * 5. render(mountEl) — the feature UI.
   *    A platform "Landing-page matrix" dashboard: coverage stats,
   *    a browsable list of generated pages, and a live preview of any
   *    single (area x type) landing page incl. its <head> tags.
   * ============================================================ */
  function render(mountEl) {
    try {
      var stats = matrixStats();
      var pages = buildMatrix();

      var wrap = HC.util.el("div", { class: "hc-seo" });
      wrap.innerHTML =
        '<style>' +
        '.hc-seo{font-family:"Nunito Sans",system-ui,sans-serif;color:var(--text,#383838)}' +
        '.hc-seo .seo-stats{display:flex;gap:10px;flex-wrap:wrap;margin:4px 0 16px}' +
        '.hc-seo .seo-stat{background:var(--purple-tint,#F0E8F4);border-radius:14px;padding:10px 14px;min-width:84px}' +
        '.hc-seo .seo-stat b{display:block;font-family:Quicksand,system-ui,sans-serif;font-size:22px;color:var(--purple,#603488)}' +
        '.hc-seo .seo-stat span{font-size:11.5px;color:var(--muted,#808080);text-transform:uppercase;letter-spacing:.3px}' +
        '.hc-seo .seo-controls{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:10px}' +
        '.hc-seo select{font-family:inherit;font-size:13px;padding:7px 9px;border:1.5px solid var(--line,#E6E6E6);border-radius:10px}' +
        '.hc-seo .seo-list{max-height:230px;overflow:auto;border:1.5px solid var(--line,#E6E6E6);border-radius:12px}' +
        '.hc-seo .seo-row{display:flex;align-items:center;gap:8px;padding:8px 11px;border-bottom:1px solid var(--line,#Eee);font-size:13px;cursor:pointer}' +
        '.hc-seo .seo-row:last-child{border-bottom:none}' +
        '.hc-seo .seo-row:hover{background:var(--purple-tint,#F7F2FA)}' +
        '.hc-seo .seo-row.sel{background:var(--purple-tint,#F0E8F4)}' +
        '.hc-seo .seo-url{font-family:ui-monospace,Menlo,monospace;font-size:11.5px;color:var(--purple,#603488);flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
        '.hc-seo .seo-n{font-weight:700;color:var(--magenta,#F82488);font-size:12px}' +
        '.hc-seo .seo-prev{margin-top:14px;border:1.5px solid var(--line,#E6E6E6);border-radius:14px;padding:14px;background:#fff}' +
        '.hc-seo .seo-prev h3{font-family:Quicksand,system-ui,sans-serif;color:var(--purple,#603488);margin:0 0 2px;font-size:19px}' +
        '.hc-seo .seo-serp{background:#fff;border:1px solid var(--line,#E6E6E6);border-radius:10px;padding:10px 12px;margin:8px 0}' +
        '.hc-seo .seo-serp .t{color:#1a0dab;font-size:15px;font-family:Arial,sans-serif}' +
        '.hc-seo .seo-serp .u{color:#006621;font-size:12px;font-family:Arial,sans-serif}' +
        '.hc-seo .seo-serp .d{color:#545454;font-size:12.5px;font-family:Arial,sans-serif}' +
        '.hc-seo pre{background:#2d2540;color:#e8e0f5;border-radius:10px;padding:11px;font-size:11px;overflow:auto;max-height:180px;line-height:1.5}' +
        '.hc-seo .seo-camps{margin:8px 0 0;padding-left:18px;font-size:12.5px;line-height:1.7}' +
        '.hc-seo .seo-toggle{font-size:11.5px;cursor:pointer;border:1.5px solid var(--purple-tint,#F0E8F4);background:transparent;color:var(--purple,#603488);border-radius:999px;padding:4px 10px;font-family:Quicksand,system-ui,sans-serif;font-weight:700}' +
        '</style>' +
        '<p style="font-size:13.5px;margin:0 0 12px">Like Happity, every <b>(area &times; camp&#8209;type)</b> combination that has at least one real camp gets its own indexable landing page — built automatically from the live directory so it ranks for searches like <i>"football camps in Walthamstow"</i>. Empty combinations are skipped so we never publish a thin page.</p>' +
        '<div class="seo-stats">' +
          '<div class="seo-stat"><b>' + stats.areas + '</b><span>Areas</span></div>' +
          '<div class="seo-stat"><b>' + stats.types + '</b><span>Camp types</span></div>' +
          '<div class="seo-stat"><b>' + stats.pages + '</b><span>Pages minted</span></div>' +
          '<div class="seo-stat"><b>' + stats.empty + '</b><span>Cells skipped</span></div>' +
          '<div class="seo-stat"><b>' + stats.published + '</b><span>Indexable</span></div>' +
        '</div>' +
        '<div class="seo-controls">' +
          '<label style="font-size:12px;color:var(--muted)">Filter area</label>' +
          '<select id="seoAreaFilter"><option value="">All areas</option></select>' +
          '<button class="seo-toggle" id="seoSitemap">View sitemap.xml</button>' +
        '</div>' +
        '<div class="seo-list" id="seoList"></div>' +
        '<div class="seo-prev" id="seoPreview"></div>';

      mountEl.innerHTML = "";
      mountEl.appendChild(wrap);

      var areaSel = wrap.querySelector("#seoAreaFilter");
      liveAreas().forEach(function (a) {
        var o = document.createElement("option");
        o.value = a; o.textContent = a;
        areaSel.appendChild(o);
      });

      var listHost = wrap.querySelector("#seoList");
      var previewHost = wrap.querySelector("#seoPreview");
      var selectedSlug = pages.length ? pages[0].slug : null;

      function renderList() {
        var filter = areaSel.value;
        var shown = pages.filter(function (p) { return !filter || p.areaId === filter; });
        listHost.innerHTML = shown.map(function (p) {
          return '<div class="seo-row' + (p.slug === selectedSlug ? " sel" : "") +
            '" data-slug="' + escAttr(p.slug) + '">' +
            '<span class="seo-url">' + esc(p.slug) + '</span>' +
            '<span class="seo-n">' + p.campCount + '&times;</span>' +
            '</div>';
        }).join("") || '<div class="seo-row">No pages for this area.</div>';
      }

      function renderPreview() {
        var page = pages.filter(function (p) { return p.slug === selectedSlug; })[0];
        if (!page) { previewHost.innerHTML = '<p style="color:var(--muted)">Select a page to preview.</p>'; return; }
        var pub = isPublished(page.slug);
        previewHost.innerHTML =
          '<h3>' + esc(page.h1) + '</h3>' +
          '<p style="font-size:12px;color:var(--muted);margin:0 0 4px">How it looks in Google results:</p>' +
          '<div class="seo-serp">' +
            '<div class="t">' + esc(page.title) + '</div>' +
            '<div class="u">' + esc(page.url) + '</div>' +
            '<div class="d">' + esc(page.metaDescription) + '</div>' +
          '</div>' +
          '<p style="font-size:12px;margin:6px 0 2px"><b>' + page.campCount + '</b> camp' +
            (page.campCount === 1 ? "" : "s") + ' on this page:</p>' +
          '<ol class="seo-camps">' +
            page.camps.slice(0, 8).map(function (c) { return "<li>" + esc(c.name) + "</li>"; }).join("") +
          '</ol>' +
          '<div style="display:flex;gap:8px;align-items:center;margin:10px 0 6px">' +
            '<button class="seo-toggle" id="seoPub">' + (pub ? "Unpublish (noindex)" : "Publish (index)") + '</button>' +
            '<button class="seo-toggle" id="seoHead">Show indexable &lt;head&gt;</button>' +
            '<span style="font-size:11.5px;color:' + (pub ? "#2f7d4f" : "#9a1f5e") + '">robots: ' + effectiveRobots(page) + '</span>' +
          '</div>' +
          '<pre id="seoHeadOut" style="display:none">' + esc(headTags(page)) + '</pre>';

        var pubBtn = previewHost.querySelector("#seoPub");
        if (pubBtn) pubBtn.addEventListener("click", function () {
          setPublished(page.slug, !isPublished(page.slug));
          HC.util.toast(isPublished(page.slug) ? "Page published — now indexable" : "Page set to noindex");
          renderPreview();
          // refresh the "Indexable" stat
          var statB = wrap.querySelectorAll(".seo-stat b")[4];
          if (statB) statB.textContent = matrixStats().published;
        });
        var headBtn = previewHost.querySelector("#seoHead");
        if (headBtn) headBtn.addEventListener("click", function () {
          var out = previewHost.querySelector("#seoHeadOut");
          if (out) out.style.display = out.style.display === "none" ? "block" : "none";
        });
      }

      listHost.addEventListener("click", function (e) {
        var row = e.target.closest("[data-slug]");
        if (!row) return;
        selectedSlug = row.getAttribute("data-slug");
        renderList();
        renderPreview();
      });
      areaSel.addEventListener("change", renderList);
      wrap.querySelector("#seoSitemap").addEventListener("click", function () {
        HC.util.modal('<h2>🗺️ sitemap.xml</h2>' +
          '<p style="color:var(--muted);font-size:13px;margin:0 0 10px">Submitted to Google Search Console — one entry per published landing page.</p>' +
          '<pre style="background:#2d2540;color:#e8e0f5;border-radius:10px;padding:12px;font-size:11px;overflow:auto;max-height:50vh;line-height:1.5">' +
          esc(sitemapXml()) + '</pre>');
      });

      renderList();
      renderPreview();
    } catch (e) {
      mountEl.innerHTML = '<p style="color:#9a1f5e">SEO matrix failed to render: ' +
        esc(e && e.message ? e.message : String(e)) + "</p>";
    }
  }

  /* ============================================================
   * 6. selfTest — exercises the LOGIC and asserts the acceptance
   *    criterion across multiple cases.
   * ============================================================ */
  function selfTest() {
    var pass = 0, fail = 0, log = [];
    function check(label, fn) {
      try { fn(); pass += 1; log.push("✓ " + label); }
      catch (e) { fail += 1; log.push("✗ " + label + " — " + (e && e.message ? e.message : String(e))); }
    }

    var pages = buildMatrix();

    // CORE ACCEPTANCE: a unique indexable page exists per (area x type) with >=1 camp.
    check("Matrix mints a non-trivial number of pages", function () {
      HC.assert(pages.length >= 10, "expected >=10 pages, got " + pages.length);
    });

    check("EVERY page has at least one camp (no empty / thin pages)", function () {
      var empties = pages.filter(function (p) { return !p.camps || p.camps.length < 1 || p.campCount < 1; });
      HC.assert(empties.length === 0, empties.length + " pages have zero camps");
    });

    check("campCount equals the actual camp list length on every page", function () {
      pages.forEach(function (p) {
        HC.assert(p.campCount === p.camps.length,
          p.slug + ": campCount " + p.campCount + " != camps " + p.camps.length);
      });
    });

    check("EVERY page slug is unique across the matrix", function () {
      var seen = {};
      pages.forEach(function (p) {
        HC.assert(!seen[p.slug], "duplicate slug: " + p.slug);
        seen[p.slug] = true;
      });
      HC.assert(Object.keys(seen).length === pages.length, "slug set size mismatch");
    });

    check("EVERY page URL (canonical) is unique and absolute", function () {
      var seen = {};
      pages.forEach(function (p) {
        HC.assert(p.url.indexOf(ORIGIN) === 0, "url not absolute: " + p.url);
        HC.assert(p.url === p.canonical, "canonical must equal url for " + p.slug);
        HC.assert(!seen[p.url], "duplicate url: " + p.url);
        seen[p.url] = true;
      });
    });

    check("EVERY page is INDEXABLE: title + meta description + H1 + canonical + robots index", function () {
      pages.forEach(function (p) {
        HC.assert(p.title && p.title.length > 10, "missing title: " + p.slug);
        HC.assert(p.metaDescription && p.metaDescription.length >= 50, "thin meta description: " + p.slug);
        HC.assert(p.h1 && p.h1.length > 3, "missing h1: " + p.slug);
        HC.assert(p.robots === "index,follow", "page not index,follow: " + p.slug);
        HC.assert(/index,follow/.test(headTags(p)), "head tags missing index robots: " + p.slug);
      });
    });

    check("EVERY page carries valid ItemList JSON-LD listing its camps", function () {
      pages.forEach(function (p) {
        var ld = p.jsonLd;
        HC.assert(ld && ld["@type"] === "ItemList", "no ItemList for " + p.slug);
        HC.assert(ld.numberOfItems === p.campCount, "JSON-LD count mismatch on " + p.slug);
        HC.assert(ld.itemListElement.length === p.campCount, "JSON-LD items mismatch on " + p.slug);
        // round-trips as valid JSON
        JSON.parse(JSON.stringify(ld));
      });
    });

    check("Page H1 reflects both the area and the camp type", function () {
      var sample = pages[0];
      HC.assert(sample.h1.indexOf(sample.areaId) !== -1, "h1 missing area: " + sample.h1);
      HC.assert(sample.h1.indexOf(sample.typeLabel) !== -1, "h1 missing type: " + sample.h1);
    });

    // Targeted case: a known rich combination ("Sports camps in Walthamstow").
    check("Walthamstow x Sports mints a page with the right camps", function () {
      var sports = CAMP_TYPES.filter(function (t) { return t.id === "sports"; })[0];
      var page = buildPage("Walthamstow", sports);
      HC.assert(page, "expected a Walthamstow Sports page");
      HC.assert(page.campCount >= 1, "expected >=1 sports camp in Walthamstow");
      HC.assert(page.slug === "/sports-camps-in-walthamstow", "unexpected slug: " + page.slug);
      page.camps.forEach(function (c) {
        HC.assert(servesArea(c, "Walthamstow"), c.name + " should serve Walthamstow");
        HC.assert(matchesType(c, sports), c.name + " should match Sports");
      });
    });

    // Negative case: an (area x type) cell with NO camps must NOT be minted.
    check("An empty (area x type) cell is NOT minted as a page", function () {
      // Find an area+type that yields zero matches, then assert buildPage returns null
      var areas = liveAreas();
      var foundEmpty = false;
      for (var a = 0; a < areas.length && !foundEmpty; a++) {
        for (var t = 0; t < CAMP_TYPES.length; t++) {
          var matches = providers().filter(function (p) {
            return servesArea(p, areas[a]) && matchesType(p, CAMP_TYPES[t]);
          });
          if (matches.length === 0) {
            HC.assert(buildPage(areas[a], CAMP_TYPES[t]) === null,
              "empty cell " + areas[a] + " x " + CAMP_TYPES[t].id + " should be null");
            foundEmpty = true;
            break;
          }
        }
      }
      HC.assert(foundEmpty, "expected at least one empty cell to verify the skip behaviour");
    });

    // Skipped cells + minted pages account for the full cartesian product.
    check("Minted + skipped cells == full (area x type) product", function () {
      var s = matrixStats();
      HC.assert(s.pages + s.empty === s.totalCells,
        s.pages + " + " + s.empty + " != " + s.totalCells);
      HC.assert(s.totalCells === s.areas * s.types, "totalCells != areas*types");
    });

    // Publish toggle drives the robots directive and the sitemap — and restores.
    check("Unpublishing a page flips robots to noindex and drops it from the sitemap", function () {
      var page = pages[0];
      var wasPublished = isPublished(page.slug);
      HC.assert(effectiveRobots(page) === "index,follow" || !wasPublished, "fresh page should index");
      setPublished(page.slug, false);
      HC.assert(effectiveRobots(page) === "noindex,follow", "noindex expected after unpublish");
      HC.assert(sitemapXml().indexOf(page.url) === -1, "unpublished page must leave the sitemap");
      setPublished(page.slug, true); // restore — leave store as found
      HC.assert(isPublished(page.slug), "page should be re-published after restore");
      HC.assert(sitemapXml().indexOf(page.url) !== -1, "republished page must return to the sitemap");
    });

    check("Sitemap is well-formed and lists one <loc> per published page", function () {
      var xml = sitemapXml();
      HC.assert(/<\?xml/.test(xml) && /<urlset/.test(xml), "sitemap missing xml/urlset");
      var locs = (xml.match(/<loc>/g) || []).length;
      var publishedCount = buildMatrix().filter(function (p) { return isPublished(p.slug); }).length;
      HC.assert(locs === publishedCount, "loc count " + locs + " != published " + publishedCount);
    });

    return { pass: pass, fail: fail, log: log };
  }

  /* ============================================================
   * 7. Register (idempotent + defensive via core).
   * ============================================================ */
  HC.registerFeature({
    id: "platform-programmatic-seo",
    title: "Area × camp-type landing pages",
    side: "platform",
    icon: "🔎",
    summary: "Auto-generate an indexable Google landing page for every (area × camp-type) that has at least one real camp — e.g. \"Football camps in Walthamstow\" — so parents searching find the directory. Empty combinations are skipped so no thin pages ship.",
    render: render,
    selfTest: selfTest
  });
})();
