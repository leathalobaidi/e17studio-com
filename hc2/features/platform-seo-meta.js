/* HolidayCamp feature module — platform-seo-meta
 *
 * Side: PLATFORM.
 * Replicates Happity's templated SEO behaviour: Happity ranks on Google for
 * search terms like "Baby classes in my area" because every location/type
 * landing page renders a templated <title> and matching <meta name=description>
 * (evidence: support article 5827872 "How do parents find my classes" §Google
 * search; 04-seo §1.5; 02-ia-ux §7.10). Reframed for school-age HOLIDAY CAMPS,
 * the platform mints one landing page per {type} x {area} combination, each with
 * a "{type} camps in {area}" title and a description that names the same type
 * and area plus a live count from HC.data.providers.
 *
 * Acceptance criterion (asserted in selfTest):
 *   Each landing page renders a "{type} camps in {area}" title and a matching
 *   meta description (the description references the same {type} and {area}).
 *
 * Design notes
 * - Self-contained: all SEO templating is pure and lives in this module.
 *   render() draws a working page picker + a Google-style SERP snippet preview
 *   and the raw <title>/<meta> tags inside mountEl. It makes NO assumptions
 *   about the live app DOM beyond the mountEl it is handed.
 * - Defensive: every read of provider data is guarded; a missing/malformed
 *   field can never throw at registration time or while building a page.
 * - The last-previewed page persists via HC.store (key "seo.last"), never raw
 *   localStorage.
 * - Deterministic: the same {type, area} always yields the same title/meta, so
 *   the templating is reproducible and testable.
 */
(function () {
  "use strict";

  if (typeof window === "undefined" || !window.HC || typeof window.HC.registerFeature !== "function") {
    return; // nothing to attach to — fail silent, never throw.
  }
  var HC = window.HC;

  /* ---------------- constants ---------------- */

  var BRAND = "HolidayCamp";
  var STORE_KEY = "seo.last";
  // Google soft limits — used only for the "looks healthy" preview warnings.
  var TITLE_MAX = 60;
  var DESC_MAX = 160;

  // Curated catalogue of camp "types" we want a landing page for. These are the
  // real category strings used across HC.data.providers (Multi-activity, Sports,
  // Arts, ...) plus a couple of evergreen platform pages. Kept lower-case-keyed
  // so we can match data categories case-insensitively.
  var TYPE_SEEDS = [
    "Holiday", "Multi-activity", "Sports", "Football", "Arts", "Drama",
    "Dance", "Music", "STEM", "Coding", "Science", "Swimming",
    "Gymnastics", "Martial arts", "Cooking", "SEND aware", "HAF", "Full day"
  ];

  // Evergreen E17 areas we always publish a page for, even if a particular type
  // currently has zero camps there (the page still needs valid SEO tags).
  var AREA_SEEDS = [
    "Walthamstow", "Leyton", "Leytonstone", "Chingford", "Highams Park",
    "Woodford", "Wanstead", "Loughton", "Waltham Forest"
  ];

  /* ---------------- pure helpers (no DOM) ---------------- */

  function safeArr(v) { return Array.isArray(v) ? v : []; }
  function safeStr(v) { return (v === null || v === undefined) ? "" : String(v); }

  function titleCaseWord(s) {
    s = safeStr(s).trim();
    if (!s) return s;
    // Preserve already-cased acronyms (HAF, STEM, SEND).
    if (s === s.toUpperCase() && s.length <= 4) return s;
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  function norm(s) { return safeStr(s).trim().toLowerCase(); }

  // Build the deterministic page set: every TYPE x AREA pairing plus a borough
  // landing for each type. Returns [{type, area, slug}].
  function buildPageList(types, areas) {
    types = safeArr(types).length ? types : TYPE_SEEDS;
    areas = safeArr(areas).length ? areas : AREA_SEEDS;
    var out = [];
    for (var t = 0; t < types.length; t++) {
      for (var a = 0; a < areas.length; a++) {
        var type = titleCaseWord(types[t]);
        var area = titleCaseWord(areas[a]);
        if (!type || !area) continue;
        out.push({ type: type, area: area, slug: slugify(type) + "-camps-in-" + slugify(area) });
      }
    }
    return out;
  }

  function slugify(s) {
    return norm(s).replace(/&/g, "and").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  }

  // Count live camps that match a type+area from HC.data.providers. A camp
  // matches the area if it lists the area (or its parent borough); it matches
  // the type if any category contains the type token, OR the type is the
  // evergreen "Holiday" page which matches every camp.
  function countMatches(providers, type, area) {
    providers = safeArr(providers);
    var tNorm = norm(type);
    var aNorm = norm(area);
    var evergreen = (tNorm === "holiday");
    var boroughPage = (aNorm === "waltham forest");
    var n = 0;
    for (var i = 0; i < providers.length; i++) {
      var p = providers[i] || {};
      // area match
      var areaOk = boroughPage; // borough page includes every WF camp
      if (!areaOk) {
        var areas = safeArr(p.areas).map(norm);
        if (safeStr(p.area)) areas.push(norm(p.area));
        for (var j = 0; j < areas.length; j++) {
          if (areas[j] === aNorm || areas[j].indexOf(aNorm) !== -1 || aNorm.indexOf(areas[j]) !== -1) { areaOk = true; break; }
          if (areas[j] === "borough-wide" || areas[j] === "borough wide") { areaOk = true; break; }
        }
      }
      if (!areaOk) continue;
      // type match
      if (evergreen) { n += 1; continue; }
      var cats = safeArr(p.categories).map(norm);
      var typeOk = false;
      for (var k = 0; k < cats.length; k++) {
        if (cats[k] === tNorm || cats[k].indexOf(tNorm) !== -1 || tNorm.indexOf(cats[k]) !== -1) { typeOk = true; break; }
      }
      if (typeOk) n += 1;
    }
    return n;
  }

  // THE TEMPLATE. Produces the SEO record for one landing page.
  // title  -> "{type} camps in {area} | HolidayCamp"
  // h1     -> "{type} camps in {area}"
  // meta   -> a sentence that names the SAME {type} and {area} (the acceptance
  //           criterion's "matching meta description").
  function buildPage(type, area, providers) {
    type = titleCaseWord(type);
    area = titleCaseWord(area);
    var safeType = type || "Holiday";
    var safeArea = area || "Waltham Forest";
    var phrase = safeType + " camps in " + safeArea; // <- the core templated phrase

    var count = countMatches(providers, safeType, safeArea);

    var title = phrase + " | " + BRAND;
    var h1 = phrase;

    // Meta description: must contain the EXACT templated phrase ("{type} camps
    // in {area}") so it matches the title, plus a live count and school-age
    // framing. We embed `phrase` verbatim, then trim to the Google limit
    // without ever cutting the phrase.
    // Lower-case the lead-in phrase for prose, but keep acronym types
    // (HAF/STEM/SEND) upper-case: "Sports camps in X" -> "sports camps in X",
    // "HAF camps in X" stays "HAF camps in X".
    var isAcronym = (safeType === safeType.toUpperCase() && safeType.length <= 4);
    var lower = isAcronym ? phrase : (phrase.charAt(0).toLowerCase() + phrase.slice(1));
    var lead = count > 0
      ? ("Compare " + count + " " + lower + " for school-age children")
      : ("Find " + lower + " for school-age children");
    var desc = lead + ". Book dates, prices and ages for the summer and half-term holidays on " + BRAND + ".";
    desc = clampDesc(desc, phrase);

    return {
      type: safeType,
      area: safeArea,
      slug: slugify(safeType) + "-camps-in-" + slugify(safeArea),
      phrase: phrase,
      title: title,
      h1: h1,
      description: desc,
      count: count,
      canonical: "https://holidaycamp.example/camps/" + slugify(safeArea) + "/" + slugify(safeType)
    };
  }

  // Clamp a description to DESC_MAX chars but never lose the templated phrase.
  function clampDesc(desc, phrase) {
    desc = safeStr(desc);
    if (desc.length <= DESC_MAX) return desc;
    // Cut at a word boundary near the limit.
    var cut = desc.slice(0, DESC_MAX);
    var sp = cut.lastIndexOf(" ");
    if (sp > 40) cut = cut.slice(0, sp);
    cut = cut.replace(/[\s,.;:]+$/, "") + "…";
    // Guarantee the phrase survives the clamp (acceptance criterion).
    if (cut.toLowerCase().indexOf(phrase.toLowerCase()) === -1) {
      cut = phrase + " on " + BRAND + ".";
    }
    return cut;
  }

  // Health check for the preview: returns {titleOk, descOk, notes:[]}.
  function lintPage(page) {
    var notes = [];
    var titleOk = page.title.length > 0 && page.title.length <= TITLE_MAX;
    var descOk = page.description.length > 0 && page.description.length <= DESC_MAX;
    if (page.title.length > TITLE_MAX) notes.push("Title is " + page.title.length + " chars (Google shows ~" + TITLE_MAX + ").");
    if (page.description.length > DESC_MAX) notes.push("Description is " + page.description.length + " chars (Google shows ~" + DESC_MAX + ").");
    if (norm(page.description).indexOf(norm(page.phrase)) === -1) notes.push("Description does not echo the page phrase.");
    return { titleOk: titleOk, descOk: descOk, notes: notes };
  }

  /* ---------------- catalogue derived from live data ---------------- */

  // Pull the distinct, real category list out of HC.data so the picker offers
  // genuine types; fall back to seeds if data is unavailable.
  function liveTypes() {
    var providers = safeArr(HC.data && HC.data.providers);
    var seen = {}, out = ["Holiday"];
    for (var i = 0; i < providers.length; i++) {
      var cats = safeArr((providers[i] || {}).categories);
      for (var j = 0; j < cats.length; j++) {
        var c = titleCaseWord(cats[j]);
        if (!c) continue;
        var key = norm(c);
        if (!seen[key]) { seen[key] = true; out.push(c); }
      }
    }
    return out.length > 1 ? out : TYPE_SEEDS.slice();
  }

  function liveAreas() {
    var providers = safeArr(HC.data && HC.data.providers);
    var seen = {}, out = [];
    for (var i = 0; i < providers.length; i++) {
      var areas = safeArr((providers[i] || {}).areas);
      for (var j = 0; j < areas.length; j++) {
        var a = titleCaseWord(areas[j]);
        if (!a || norm(a) === "borough-wide" || norm(a) === "london") continue;
        var key = norm(a);
        if (!seen[key]) { seen[key] = true; out.push(a); }
      }
    }
    // Always include the borough landing.
    if (out.indexOf("Waltham Forest") === -1) out.push("Waltham Forest");
    return out.length ? out : AREA_SEEDS.slice();
  }

  /* ---------------- persistence ---------------- */

  function saveLast(sel) {
    try { HC.store.set(STORE_KEY, sel); } catch (e) { /* defensive */ }
  }
  function loadLast() {
    try {
      var v = HC.store.get(STORE_KEY, null);
      if (v && v.type && v.area) return v;
    } catch (e) { /* defensive */ }
    return null;
  }

  /* ---------------- render (UI) ---------------- */

  function esc(s) {
    return safeStr(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function render(mountEl) {
    if (!mountEl) return;
    try {
      var types = liveTypes();
      var areas = liveAreas();
      var providers = safeArr(HC.data && HC.data.providers);

      var last = loadLast();
      var curType = (last && types.some(function (t) { return norm(t) === norm(last.type); })) ? last.type : (types[1] || types[0]);
      var curArea = (last && areas.some(function (a) { return norm(a) === norm(last.area); })) ? last.area : areas[0];

      mountEl.innerHTML =
        '<p style="font-size:14px;color:var(--text,#383838);margin:0 0 14px">' +
          'Like Happity, every <strong>type × area</strong> landing page is minted from one template so it ranks on ' +
          'Google for searches like “sports camps in Walthamstow”. Pick a page to see its generated ' +
          '<code>&lt;title&gt;</code> and matching meta description.</p>' +
        '<div style="display:flex;gap:10px;flex-wrap:wrap;margin:0 0 16px">' +
          '<label style="font-size:12px;font-weight:700;color:var(--purple,#603488)">Type<br>' +
            '<select id="seoType" style="margin-top:4px;padding:8px 10px;border:1.5px solid var(--line,#E6E6E6);border-radius:10px;font-size:13px;min-width:160px">' +
              types.map(function (t) { return '<option value="' + esc(t) + '"' + (norm(t) === norm(curType) ? " selected" : "") + ">" + esc(t) + "</option>"; }).join("") +
            "</select></label>" +
          '<label style="font-size:12px;font-weight:700;color:var(--purple,#603488)">Area<br>' +
            '<select id="seoArea" style="margin-top:4px;padding:8px 10px;border:1.5px solid var(--line,#E6E6E6);border-radius:10px;font-size:13px;min-width:160px">' +
              areas.map(function (a) { return '<option value="' + esc(a) + '"' + (norm(a) === norm(curArea) ? " selected" : "") + ">" + esc(a) + "</option>"; }).join("") +
            "</select></label>" +
        "</div>" +
        '<div id="seoPreview"></div>' +
        '<p style="font-size:12px;color:var(--muted,#808080);margin:16px 0 0">' +
          'Catalogue: <strong>' + (types.length * areas.length) + '</strong> templated landing pages ' +
          "(" + types.length + " types × " + areas.length + " areas) from " + providers.length + " live camps.</p>";

      var selType = mountEl.querySelector("#seoType");
      var selArea = mountEl.querySelector("#seoArea");
      var preview = mountEl.querySelector("#seoPreview");

      function redraw() {
        var page = buildPage(selType.value, selArea.value, providers);
        saveLast({ type: page.type, area: page.area });
        var lint = lintPage(page);
        preview.innerHTML =
          // Google-style SERP snippet
          '<div style="border:1.5px solid var(--line,#E6E6E6);border-radius:14px;padding:16px 18px;background:#fff">' +
            '<div style="font-size:12px;color:#0b6e0b;word-break:break-all">' + esc(page.canonical) + "</div>" +
            '<div style="font-size:19px;color:#1a0dab;font-family:arial,system-ui,sans-serif;line-height:1.3;margin:2px 0 3px">' + esc(page.title) + "</div>" +
            '<div style="font-size:13.5px;color:#4d5156;font-family:arial,system-ui,sans-serif;line-height:1.5">' + esc(page.description) + "</div>" +
          "</div>" +
          // The rendered page H1
          '<div style="margin:14px 0 4px;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.4px;color:var(--magenta,#F82488)">On-page H1</div>' +
          '<div style="font-family:Quicksand,system-ui,sans-serif;font-weight:700;font-size:22px;color:var(--purple,#603488)">' + esc(page.h1) +
            ' <span style="font-size:13px;font-weight:700;color:var(--muted,#808080)">· ' + page.count + " live " + (page.count === 1 ? "camp" : "camps") + "</span></div>" +
          // Raw tags
          '<div style="margin:14px 0 4px;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.4px;color:var(--magenta,#F82488)">Generated tags</div>' +
          '<pre style="background:#2b2240;color:#f3eefc;border-radius:12px;padding:12px 14px;font-size:12px;overflow-x:auto;white-space:pre-wrap;margin:0">' +
            esc('<title>' + page.title + '</title>') + "\n" +
            esc('<meta name="description" content="' + page.description + '">') + "\n" +
            esc('<link rel="canonical" href="' + page.canonical + '">') +
          "</pre>" +
          // Lint line
          '<p style="font-size:12.5px;margin:10px 0 0;color:' + ((lint.titleOk && lint.descOk && !lint.notes.length) ? "#2f7d4f" : "#9a1f5e") + '">' +
            ((lint.titleOk && lint.descOk && !lint.notes.length)
              ? "✓ Title " + page.title.length + "/" + TITLE_MAX + " · description " + page.description.length + "/" + DESC_MAX + " · phrase echoed in both."
              : "⚠ " + (lint.notes.join(" ") || "Check title/description length.")) +
          "</p>";
      }

      selType.addEventListener("change", redraw);
      selArea.addEventListener("change", redraw);
      redraw();
    } catch (e) {
      mountEl.innerHTML = '<p style="color:#9a1f5e">SEO preview failed: ' + esc(e && e.message ? e.message : String(e)) + "</p>";
    }
  }

  /* ---------------- enhance (optional) ---------------- */

  // If the live app exposes an active type/area context we could rewrite
  // document.title here. We do it conservatively: only when a recognisable
  // search heading exists, and we never clobber an existing branded title.
  function enhance() {
    try {
      if (typeof document === "undefined") return;
      // No-op by default — the platform owns <title>. Left as a safe hook so a
      // future router can call HC into it. We simply ensure a meta description
      // tag EXISTS for the home page so the templating has something to target.
      var head = document.head;
      if (!head) return;
      if (!head.querySelector('meta[name="description"][data-hc-seo]')) {
        var page = buildPage("Holiday", "Waltham Forest", safeArr(HC.data && HC.data.providers));
        var m = document.createElement("meta");
        m.setAttribute("name", "description");
        m.setAttribute("data-hc-seo", "1");
        m.setAttribute("content", page.description);
        // Append rather than replace any author-supplied description.
        if (!document.querySelector('meta[name="description"]:not([data-hc-seo])')) head.appendChild(m);
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

    var providers = safeArr(HC.data && HC.data.providers);

    // 1. ACCEPTANCE CRITERION — a single page renders the "{type} camps in
    //    {area}" title and a matching meta description.
    check("Page renders '{type} camps in {area}' title", function () {
      var page = buildPage("Sports", "Walthamstow", providers);
      HC.assert(page.title.indexOf("Sports camps in Walthamstow") === 0,
        "title should start with the templated phrase, got: " + page.title);
      HC.assert(page.h1 === "Sports camps in Walthamstow",
        "h1 should equal the templated phrase, got: " + page.h1);
    });

    check("Meta description matches the title's {type} and {area}", function () {
      var page = buildPage("Sports", "Walthamstow", providers);
      var d = norm(page.description);
      HC.assert(d.indexOf("sports") !== -1, "description must name the type 'sports': " + page.description);
      HC.assert(d.indexOf("walthamstow") !== -1, "description must name the area 'walthamstow': " + page.description);
      HC.assert(d.indexOf(norm(page.phrase)) !== -1,
        "description must echo the full templated phrase: " + page.description);
    });

    // 2. Multiple cases across types AND areas — every minted page satisfies
    //    the criterion (title is "{type} camps in {area}" and the description
    //    echoes the same type+area).
    check("Every {type}×{area} page satisfies the title+meta criterion", function () {
      var types = ["Multi-activity", "Arts", "Dance", "STEM", "HAF", "Football", "Holiday"];
      var areas = ["Walthamstow", "Leyton", "Chingford", "Highams Park", "Waltham Forest"];
      var n = 0;
      for (var t = 0; t < types.length; t++) {
        for (var a = 0; a < areas.length; a++) {
          var page = buildPage(types[t], areas[a], providers);
          var expectPhrase = titleCaseWord(types[t]) + " camps in " + titleCaseWord(areas[a]);
          HC.assert(page.phrase === expectPhrase,
            "phrase mismatch: expected '" + expectPhrase + "', got '" + page.phrase + "'");
          HC.assert(page.title === expectPhrase + " | " + BRAND,
            "title not '{type} camps in {area} | " + BRAND + "': " + page.title);
          HC.assert(page.h1 === expectPhrase, "h1 mismatch for " + expectPhrase);
          HC.assert(norm(page.description).indexOf(norm(expectPhrase)) !== -1,
            "meta did not echo phrase for " + expectPhrase + ": " + page.description);
          n += 1;
        }
      }
      HC.assert(n === types.length * areas.length, "expected " + (types.length * areas.length) + " pages, built " + n);
    });

    // 3. Acronym types keep their casing (HAF, STEM, SEND) in the phrase.
    check("Acronym types (HAF/STEM) keep casing in the templated phrase", function () {
      var haf = buildPage("HAF", "Leyton", providers);
      HC.assert(haf.phrase === "HAF camps in Leyton", "HAF casing broken: " + haf.phrase);
      var stem = buildPage("STEM", "Chingford", providers);
      HC.assert(stem.phrase === "STEM camps in Chingford", "STEM casing broken: " + stem.phrase);
    });

    // 4. Titles and descriptions are unique per page (no duplicate-content
    //    collisions across the catalogue).
    check("Catalogue produces unique titles and unique descriptions", function () {
      var pages = buildPageList(["Sports", "Arts", "Dance"], ["Walthamstow", "Leyton", "Chingford"]);
      var titles = {}, descs = {};
      pages.forEach(function (s) {
        var page = buildPage(s.type, s.area, providers);
        HC.assert(!titles[page.title], "duplicate title: " + page.title);
        HC.assert(!descs[page.description], "duplicate description: " + page.description);
        titles[page.title] = true; descs[page.description] = true;
      });
      HC.assert(Object.keys(titles).length === pages.length, "expected " + pages.length + " unique titles");
    });

    // 5. Slugs are URL-safe and stable (deterministic templating).
    check("Slug is URL-safe and deterministic", function () {
      var a = buildPage("Multi-activity", "Highams Park", providers);
      HC.assert(a.slug === "multi-activity-camps-in-highams-park", "unexpected slug: " + a.slug);
      HC.assert(/^[a-z0-9-]+$/.test(a.slug), "slug not URL-safe: " + a.slug);
      var b = buildPage("Multi-activity", "Highams Park", providers);
      HC.assert(a.title === b.title && a.slug === b.slug, "templating not deterministic");
    });

    // 6. Live count is accurate and the description reflects presence/absence.
    check("Live count drives 'Compare N camps' vs 'Find ... camps' wording", function () {
      // A type/area we know has camps in the live data → "Compare N".
      var hit = buildPage("Holiday", "Walthamstow", providers);
      if (providers.length) {
        HC.assert(hit.count > 0, "expected Walthamstow Holiday page to match live camps, got " + hit.count);
        HC.assert(hit.description.indexOf("Compare " + hit.count) === 0,
          "populated page should lead with 'Compare N': " + hit.description);
      }
      // A type/area with (almost certainly) no camps → "Find ...".
      var miss = buildPage("Swimming", "Loughton", providers);
      if (miss.count === 0) {
        HC.assert(miss.description.indexOf("Find ") === 0,
          "empty page should lead with 'Find': " + miss.description);
      }
      // Either way the phrase is present (criterion holds even with 0 camps).
      HC.assert(norm(miss.description).indexOf(norm(miss.phrase)) !== -1,
        "empty-page description must still echo the phrase: " + miss.description);
    });

    // 7. Description never exceeds Google's limit, yet always keeps the phrase.
    check("Long descriptions clamp to ≤160 chars but retain the phrase", function () {
      var page = buildPage("Multi-activity", "Walthamstow", providers); // long type word
      HC.assert(page.description.length <= DESC_MAX,
        "description over " + DESC_MAX + " chars: " + page.description.length);
      HC.assert(norm(page.description).indexOf(norm(page.phrase)) !== -1,
        "clamp dropped the phrase: " + page.description);
      // Force-clamp a pathological string and confirm the phrase survives.
      var forced = clampDesc("x ".repeat(200), "Test camps in Nowhere");
      HC.assert(forced.toLowerCase().indexOf("test camps in nowhere") !== -1,
        "forced clamp lost the phrase: " + forced);
    });

    // 8. lintPage flags a healthy default page as OK.
    check("lintPage reports a typical page as healthy", function () {
      var page = buildPage("Arts", "Leyton", providers);
      var lint = lintPage(page);
      HC.assert(lint.descOk, "description should be within limit for Arts/Leyton");
      HC.assert(lint.notes.length === 0, "did not expect lint notes, got: " + lint.notes.join(" | "));
    });

    // 9. Defensive: malformed/empty inputs never throw and still produce a
    //    valid templated phrase.
    check("Malformed inputs fall back to a valid templated phrase", function () {
      var p1 = buildPage("", "", []);
      HC.assert(/ camps in /.test(p1.phrase), "fallback phrase malformed: " + p1.phrase);
      HC.assert(p1.title.indexOf(p1.phrase) === 0, "fallback title malformed: " + p1.title);
      var p2 = buildPage(null, undefined, null);
      HC.assert(typeof p2.description === "string" && p2.description.length > 0, "null inputs produced no description");
    });

    // 10. Live data: building a page for every real category × real area never
    //     throws and always yields the templated title.
    check("Every live category × area builds a valid landing page", function () {
      if (!providers.length) { HC.assert(true, "no live data — skipped"); return; }
      var types = liveTypes(), areas = liveAreas(), built = 0;
      for (var t = 0; t < types.length; t++) {
        for (var a = 0; a < areas.length; a++) {
          var page = buildPage(types[t], areas[a], providers);
          HC.assert(page.title.indexOf(" camps in ") !== -1, "live page missing template: " + page.title);
          HC.assert(page.title.indexOf(" | " + BRAND) !== -1, "live page missing brand: " + page.title);
          built += 1;
        }
      }
      HC.assert(built === types.length * areas.length, "did not build the full live catalogue");
    });

    return { pass: pass, fail: fail, log: log };
  }

  /* ---------------- register ---------------- */
  HC.registerFeature({
    id: "platform-seo-meta",
    title: "Templated SEO titles & meta",
    side: "platform",
    icon: "🔎",
    summary: "Mints one landing page per type × area with a '{type} camps in {area}' title and matching meta description — how the platform ranks on Google, Happity-style.",
    render: render,
    enhance: enhance,
    selfTest: selfTest
  });
})();
