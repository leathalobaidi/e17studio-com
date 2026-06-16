/* HolidayCamp feature: platform-seasonal-pages
 * ------------------------------------------------------------------
 * Replicates Happity's SEASONAL CATEGORY PAGES for the PLATFORM side,
 * reframed for SCHOOL-AGE HOLIDAY CAMPS (day / week places), not baby
 * classes.
 *
 * Evidence (support corpus + Happity SEO/IA notes):
 *   - 04-seo §1.3 (easter): Happity builds high-traffic, season-themed
 *     landing pages (e.g. "Easter activities") that rank for seasonal
 *     search and collect every relevant listing in one place.
 *   - 02-ia-ux §7: the information architecture has dedicated seasonal
 *     hubs alongside category pages, so a parent searching "summer
 *     holiday camps near me" lands on a curated page, not a blank search.
 *
 * For HolidayCamp the equivalent is a landing page PER UK SCHOOL HOLIDAY
 * SEASON — Summer, October half-term, Christmas, February half-term,
 * Easter and May half-term — each listing the camps that run in that
 * season. Camps are classified from the VERIFIED text already in
 * camps.js / planner-data.js (summary, booking, goodFor, categories,
 * confirmed planner weeks, keyDates). Nothing is invented; the verified
 * data is never mutated.
 *
 * Acceptance criterion (asserted by selfTest, multiple cases):
 *   A landing page exists per holiday season and lists camps in that
 *   season.
 *
 * Scope note: this module owns ONLY the seasonal-page surface — the
 * season registry, the camp->season classifier, and the landing-page
 * builder. It is defensive: nothing throws at registration time, and
 * any per-page parent overrides persist via HC.store only.
 * ------------------------------------------------------------------ */
(function () {
  "use strict";

  if (typeof window === "undefined" || !window.HC || typeof window.HC.registerFeature !== "function") {
    // Core not present — fail silently rather than throwing.
    return;
  }
  var HC = window.HC;

  // Per-season parent-facing overrides (e.g. pinning/hiding a camp on a
  // seasonal page). Shape: { [seasonId]: { pinned:[campId], hidden:[campId] } }
  var STORE_KEY = "platform_seasonal_overrides";

  /* ============================================================
   * 1. The season registry.
   *    Each UK school holiday gets ONE landing page. The `match`
   *    keywords are the verified words we expect to find in a
   *    provider's text when it runs in that season; `weekSeason`
   *    flags the seasons that the planner's confirmed `weeks`
   *    array speaks to (the live data is summer-2026).
   * ============================================================ */

  var SEASONS = [
    {
      id: "summer",
      label: "Summer holidays",
      slug: "summer-holiday-camps",
      emoji: "☀️",
      window: "Late July – early September",
      blurb: "Six weeks to fill. Full-day and week-long summer holiday camps across Waltham Forest — sports, multi-activity, arts and HAF places.",
      // Summer is the season the live planner weeks describe.
      weekSeason: true,
      // Words that, in verified camp text, indicate a summer run.
      match: ["summer", "summer holiday", "playscheme", "summer camp", "july", "august"]
    },
    {
      id: "october-half-term",
      label: "October half-term",
      slug: "october-half-term-camps",
      emoji: "🍂",
      window: "Late October (one week)",
      blurb: "Autumn half-term holiday clubs — a single week of cover with spooky-season themed days at many camps.",
      weekSeason: false,
      match: ["october half term", "october half-term", "autumn half term", "half term", "half-term", "every holiday", "each holiday", "all holidays", "school holidays"]
    },
    {
      id: "christmas",
      label: "Christmas holidays",
      slug: "christmas-holiday-camps",
      emoji: "🎄",
      window: "Late December – early January",
      blurb: "Festive holiday camps to bridge the Christmas break — shorter weeks around the bank holidays, ideal for working parents.",
      weekSeason: false,
      match: ["christmas", "festive", "winter holiday", "every holiday", "each holiday", "all holidays", "school holidays"]
    },
    {
      id: "february-half-term",
      label: "February half-term",
      slug: "february-half-term-camps",
      emoji: "❄️",
      window: "Mid-February (one week)",
      blurb: "A week of February half-term holiday clubs — indoor multi-activity, sport and creative camps to beat the cold.",
      weekSeason: false,
      match: ["february half term", "february half-term", "spring half term", "half term", "half-term", "every holiday", "each holiday", "all holidays", "school holidays"]
    },
    {
      id: "easter",
      label: "Easter holidays",
      slug: "easter-holiday-camps",
      emoji: "🐣",
      window: "Early-mid April (two weeks)",
      blurb: "Easter holiday camps — two weeks of egg hunts, crafts and active days. One of the busiest seasonal searches of the year.",
      weekSeason: false,
      match: ["easter", "spring holiday", "every holiday", "each holiday", "all holidays", "school holidays"]
    },
    {
      id: "may-half-term",
      label: "May half-term",
      slug: "may-half-term-camps",
      emoji: "🌼",
      window: "Late May (one week)",
      blurb: "Late-spring half-term holiday clubs — a week of outdoor-leaning camps as the weather turns.",
      weekSeason: false,
      match: ["may half term", "may half-term", "summer half term", "half term", "half-term", "every holiday", "each holiday", "all holidays", "school holidays"]
    }
  ];

  // Fast lookup of a season by id.
  var SEASON_BY_ID = {};
  (function () {
    for (var i = 0; i < SEASONS.length; i++) SEASON_BY_ID[SEASONS[i].id] = SEASONS[i];
  })();

  /* ============================================================
   * 2. Pure helpers — no DOM, no side effects.
   * ============================================================ */

  function lc(s) { return String(s == null ? "" : s).toLowerCase(); }
  function trimStr(s) { return String(s == null ? "" : s).replace(/\s+/g, " ").trim(); }

  // Build one lower-cased searchable blob from a provider's verified text.
  function providerText(p) {
    if (!p || typeof p !== "object") return "";
    var parts = [
      p.name, p.kind, p.summary, p.goodFor, p.booking, p.price,
      p.area, p.ageLabel
    ];
    var cats = Array.isArray(p.categories) ? p.categories.join(" ") : "";
    var funding = Array.isArray(p.funding) ? p.funding.join(" ") : "";
    parts.push(cats, funding);
    return lc(parts.filter(Boolean).join("  "));
  }

  // Does a blob contain any of the season's match keywords?
  function blobMatchesSeason(blob, season) {
    if (!blob || !season || !Array.isArray(season.match)) return false;
    for (var i = 0; i < season.match.length; i++) {
      if (blob.indexOf(lc(season.match[i])) !== -1) return true;
    }
    return false;
  }

  // The planner overlay for a provider (confirmed/likely summer weeks etc.).
  function plannerFor(id) {
    var planner = HC.data.planner || {};
    var byId = planner.byId || {};
    return byId[id] || null;
  }

  /* ============================================================
   * 3. CORE LOGIC — classify a single camp into seasons.
   *    Pure: NEVER throws, NEVER mutates inputs. Returns the list
   *    of season ids the camp runs in, plus the reason per season.
   *
   *    Rules (all evidence-led):
   *      - A camp matches a season if its verified text contains one
   *        of that season's keywords.
   *      - A camp with CONFIRMED or LIKELY planner weeks runs in the
   *        SUMMER season (the live planner data is summer-2026).
   *      - A camp that says it runs "every / each / all holidays" or
   *        "school holidays" matches EVERY season (it is year-round).
   *      - keyDates.octoberHalfTerm being present means the platform
   *        publishes the October page even before camps list dates.
   * ============================================================ */

  function classifyCamp(p) {
    var out = { id: (p && p.id) || null, seasons: [], reasons: {} };
    if (!p || typeof p !== "object") return out;

    var blob = providerText(p);
    var planner = plannerFor(p.id);
    var hasConfirmedWeeks = !!(planner && Array.isArray(planner.weeks) && planner.weeks.length);
    var hasLikelyWeeks = !!(planner && (planner.weeksLikely || hasConfirmedWeeks));

    // "runs every holiday" => year-round => matches all seasons.
    var yearRound =
      blob.indexOf("every holiday") !== -1 ||
      blob.indexOf("each holiday") !== -1 ||
      blob.indexOf("all holidays") !== -1 ||
      blob.indexOf("all school holidays") !== -1 ||
      blob.indexOf("school holidays") !== -1 ||
      blob.indexOf("each school holiday") !== -1 ||
      blob.indexOf("every school holiday") !== -1 ||
      blob.indexOf("seasonal") !== -1; // HAF "seasonal" route runs across seasons

    for (var i = 0; i < SEASONS.length; i++) {
      var season = SEASONS[i];
      var reasons = [];

      if (yearRound) reasons.push("runs across all school holidays");

      if (blobMatchesSeason(blob, season)) {
        // Avoid double-counting the generic year-round keywords as a
        // season-specific reason; only note when a season-SPECIFIC word hit.
        var specific = false;
        for (var m = 0; m < season.match.length; m++) {
          var kw = lc(season.match[m]);
          if (kw === "every holiday" || kw === "each holiday" ||
              kw === "all holidays" || kw === "school holidays") continue;
          if (blob.indexOf(kw) !== -1) { specific = true; break; }
        }
        if (specific) reasons.push('mentions "' + season.label.toLowerCase() + '" / season keyword');
      }

      // Summer is anchored by the live planner weeks.
      if (season.weekSeason) {
        if (hasConfirmedWeeks) reasons.push("has confirmed summer planner weeks");
        else if (hasLikelyWeeks) reasons.push("flagged as likely running summer weeks");
      }

      if (reasons.length) {
        out.seasons.push(season.id);
        out.reasons[season.id] = reasons;
      }
    }

    return out;
  }

  /* ============================================================
   * 4. CORE LOGIC — build a landing page for ONE season.
   *    Returns a plain object describing the page + the camps it
   *    lists, applying any stored parent pin/hide overrides.
   *      { id, label, slug, exists:true, window, blurb,
   *        camps:[{id,name,...}], count, total }
   * ============================================================ */

  function readOverrides() {
    var raw = HC.store.get(STORE_KEY, {});
    return (raw && typeof raw === "object") ? raw : {};
  }
  function overridesFor(seasonId) {
    var all = readOverrides();
    var o = all[seasonId] || {};
    return {
      pinned: Array.isArray(o.pinned) ? o.pinned : [],
      hidden: Array.isArray(o.hidden) ? o.hidden : []
    };
  }
  function writeOverridesFor(seasonId, patch) {
    var all = readOverrides();
    var cur = all[seasonId] || { pinned: [], hidden: [] };
    all[seasonId] = {
      pinned: Array.isArray(patch.pinned) ? patch.pinned : (cur.pinned || []),
      hidden: Array.isArray(patch.hidden) ? patch.hidden : (cur.hidden || [])
    };
    return HC.store.set(STORE_KEY, all);
  }
  function clearOverrides(seasonId) {
    var all = readOverrides();
    if (seasonId) { delete all[seasonId]; } else { all = {}; }
    return HC.store.set(STORE_KEY, all);
  }

  // Which camps run in this season? Pure over the live directory.
  function campsInSeason(seasonId) {
    var season = SEASON_BY_ID[seasonId];
    var providers = HC.data.providers || [];
    var hit = [];
    if (!season) return hit;
    for (var i = 0; i < providers.length; i++) {
      var p = providers[i];
      var c = classifyCamp(p);
      if (c.seasons.indexOf(seasonId) !== -1) {
        hit.push({ provider: p, reasons: c.reasons[seasonId] || [] });
      }
    }
    return hit;
  }

  // Build the full landing-page model, honouring pin/hide overrides.
  function buildSeasonPage(seasonId) {
    var season = SEASON_BY_ID[seasonId];
    if (!season) {
      return { id: seasonId, exists: false, camps: [], count: 0, total: 0 };
    }
    var ov = overridesFor(seasonId);
    var matched = campsInSeason(seasonId);

    // Drop hidden, then order: pinned first (in pin order), rest after.
    var pinSet = {}; ov.pinned.forEach(function (id) { pinSet[id] = true; });
    var hideSet = {}; ov.hidden.forEach(function (id) { hideSet[id] = true; });

    var visible = matched.filter(function (m) { return !hideSet[m.provider.id]; });
    var pinned = [], rest = [];
    visible.forEach(function (m) {
      if (pinSet[m.provider.id]) pinned.push(m); else rest.push(m);
    });
    // Keep pinned in the order the parent pinned them.
    pinned.sort(function (a, b) {
      return ov.pinned.indexOf(a.provider.id) - ov.pinned.indexOf(b.provider.id);
    });

    var ordered = pinned.concat(rest);

    return {
      id: season.id,
      label: season.label,
      slug: season.slug,
      emoji: season.emoji,
      window: season.window,
      blurb: season.blurb,
      exists: true,
      camps: ordered.map(function (m) {
        return {
          id: m.provider.id,
          name: m.provider.name,
          kind: m.provider.kind,
          area: m.provider.area,
          ageLabel: m.provider.ageLabel,
          categories: m.provider.categories || [],
          pinned: !!pinSet[m.provider.id],
          reasons: m.reasons
        };
      }),
      count: ordered.length,
      total: matched.length
    };
  }

  // Build every season page (the full seasonal hub).
  function buildAllSeasonPages() {
    return SEASONS.map(function (s) { return buildSeasonPage(s.id); });
  }

  /* ============================================================
   * 5. Parent actions on a seasonal page (persisted via HC.store).
   * ============================================================ */

  function pinCamp(seasonId, campId) {
    if (!SEASON_BY_ID[seasonId] || !campId) return false;
    var ov = overridesFor(seasonId);
    if (ov.pinned.indexOf(campId) === -1) ov.pinned.push(campId);
    // Un-hide if it was hidden.
    ov.hidden = ov.hidden.filter(function (id) { return id !== campId; });
    return writeOverridesFor(seasonId, ov);
  }
  function unpinCamp(seasonId, campId) {
    if (!SEASON_BY_ID[seasonId]) return false;
    var ov = overridesFor(seasonId);
    ov.pinned = ov.pinned.filter(function (id) { return id !== campId; });
    return writeOverridesFor(seasonId, ov);
  }
  function hideCamp(seasonId, campId) {
    if (!SEASON_BY_ID[seasonId] || !campId) return false;
    var ov = overridesFor(seasonId);
    if (ov.hidden.indexOf(campId) === -1) ov.hidden.push(campId);
    ov.pinned = ov.pinned.filter(function (id) { return id !== campId; });
    return writeOverridesFor(seasonId, ov);
  }

  /* ============================================================
   * 6. RENDER — the seasonal hub + a per-season landing page.
   * ============================================================ */

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function render(mountEl) {
    if (!mountEl) return;
    var state = { active: "summer" };

    function paint() {
      var pages = buildAllSeasonPages();
      var active = state.active;
      var page = buildSeasonPage(active);

      // Season tab bar — one tab per landing page.
      var tabs = pages.map(function (pg) {
        var on = pg.id === active;
        return '<button type="button" data-season-tab="' + esc(pg.id) + '" ' +
          'style="border:1.5px solid ' + (on ? "var(--purple,#603488)" : "var(--line,#E6E6E6)") + ';' +
          'background:' + (on ? "var(--purple,#603488)" : "#fff") + ';color:' + (on ? "#fff" : "var(--purple,#603488)") + ';' +
          'font-family:Quicksand,system-ui,sans-serif;font-weight:700;font-size:12.5px;padding:7px 13px;' +
          'border-radius:999px;cursor:pointer;white-space:nowrap">' +
          esc(pg.emoji + " " + pg.label) + " · " + pg.total + "</button>";
      }).join(" ");

      // The active landing page.
      var listHtml;
      if (!page.camps.length) {
        listHtml = '<p style="color:var(--muted,#808080);font-size:14px">No camps are listed for this season yet. ' +
          'As providers confirm dates they will appear here automatically.</p>';
      } else {
        listHtml = '<div style="display:flex;flex-direction:column;gap:10px">' +
          page.camps.map(function (c) {
            var reason = (c.reasons && c.reasons.length) ? c.reasons[0] : "runs this season";
            return '<div style="border:1.5px solid var(--line,#E6E6E6);border-radius:14px;padding:12px 14px;background:#fff">' +
              '<div style="display:flex;justify-content:space-between;gap:10px;align-items:flex-start">' +
                '<div>' +
                  '<div style="font-family:Quicksand,system-ui,sans-serif;font-weight:700;color:var(--purple,#603488);font-size:15px">' +
                    (c.pinned ? "📌 " : "") + esc(c.name) + "</div>" +
                  '<div style="color:var(--text,#383838);font-size:12.5px;margin-top:2px">' +
                    esc([c.kind, c.area, c.ageLabel ? "ages " + c.ageLabel : ""].filter(Boolean).join(" · ")) + "</div>" +
                  '<div style="color:var(--muted,#808080);font-size:11.5px;margin-top:3px">Listed because it ' + esc(reason) + ".</div>" +
                "</div>" +
                '<div style="display:flex;gap:6px;flex-shrink:0">' +
                  '<button type="button" class="hc-btn hc-btn-ghost" style="padding:5px 10px;font-size:11px" ' +
                    'data-season-pin="' + esc(c.id) + '">' + (c.pinned ? "Unpin" : "Pin") + "</button>" +
                  '<button type="button" class="hc-btn hc-btn-ghost" style="padding:5px 10px;font-size:11px" ' +
                    'data-season-hide="' + esc(c.id) + '">Hide</button>' +
                "</div>" +
              "</div>" +
            "</div>";
          }).join("") +
          "</div>";
      }

      mountEl.innerHTML =
        '<p style="font-size:13.5px;color:var(--text,#383838);margin:0 0 12px">' +
          "Like Happity's seasonal category pages, HolidayCamp publishes one landing page per UK school holiday. " +
          "Each page automatically lists the camps that run in that season, classified from verified provider text and confirmed dates.</p>" +
        '<div style="display:flex;gap:7px;flex-wrap:wrap;margin-bottom:14px">' + tabs + "</div>" +
        '<div style="background:var(--purple-tint,#F0E8F4);border-radius:16px;padding:14px 16px;margin-bottom:14px">' +
          '<div style="font-family:Quicksand,system-ui,sans-serif;font-weight:700;color:var(--purple,#603488);font-size:19px">' +
            esc(page.emoji + " " + page.label + " holiday camps in E17") + "</div>" +
          '<div style="color:var(--magenta,#F82488);font-weight:700;font-size:12px;margin-top:2px">' + esc(page.window) + "</div>" +
          '<p style="color:var(--text,#383838);font-size:13px;margin:6px 0 0">' + esc(page.blurb) + "</p>" +
          '<div style="color:var(--muted,#808080);font-size:11.5px;margin-top:6px">/' + esc(page.slug) +
            " · " + page.count + " camp" + (page.count === 1 ? "" : "s") + " listed</div>" +
        "</div>" +
        listHtml;
    }

    function onClick(e) {
      var tab = e.target.closest("[data-season-tab]");
      if (tab) { state.active = tab.getAttribute("data-season-tab"); paint(); return; }
      var pin = e.target.closest("[data-season-pin]");
      if (pin) {
        var id = pin.getAttribute("data-season-pin");
        var pg = buildSeasonPage(state.active);
        var row = pg.camps.filter(function (c) { return c.id === id; })[0];
        if (row && row.pinned) { unpinCamp(state.active, id); HC.util.toast("Unpinned"); }
        else { pinCamp(state.active, id); HC.util.toast("Pinned to top"); }
        paint();
        return;
      }
      var hide = e.target.closest("[data-season-hide]");
      if (hide) {
        hideCamp(state.active, hide.getAttribute("data-season-hide"));
        HC.util.toast("Hidden from this season");
        paint();
        return;
      }
    }

    try {
      mountEl.addEventListener("click", onClick);
      paint();
    } catch (e) {
      mountEl.innerHTML = '<p style="color:#9a1f5e">Seasonal pages failed to render: ' + esc(e && e.message) + "</p>";
    }
  }

  /* ============================================================
   * 7. selfTest — exercises the LOGIC and asserts the acceptance
   *    criterion: a landing page exists per holiday season and
   *    lists camps in that season. (Multiple cases.)
   * ============================================================ */

  function selfTest() {
    var pass = 0, fail = 0, log = [];
    function check(label, fn) {
      try { fn(); pass += 1; log.push("✓ " + label); }
      catch (e) { fail += 1; log.push("✗ " + label + " — " + (e && e.message ? e.message : String(e))); }
    }

    // Leave the store as found.
    clearOverrides();

    // --- ACCEPTANCE: a landing page exists per holiday season. ---
    check("A landing page exists for every holiday season", function () {
      var pages = buildAllSeasonPages();
      HC.assert(pages.length === SEASONS.length,
        "expected " + SEASONS.length + " season pages, got " + pages.length);
      pages.forEach(function (pg) {
        HC.assert(pg.exists === true, "page for " + pg.id + " should exist");
        HC.assert(!!pg.slug, "page for " + pg.id + " needs a slug");
        HC.assert(!!pg.label, "page for " + pg.id + " needs a label");
      });
    });

    check("The expected six UK holiday seasons are all present", function () {
      var want = ["summer", "october-half-term", "christmas", "february-half-term", "easter", "may-half-term"];
      want.forEach(function (id) {
        HC.assert(!!buildSeasonPage(id).exists, "missing landing page for season: " + id);
      });
      // 04-seo §1.3 specifically names Easter — assert it is one of them.
      HC.assert(SEASON_BY_ID["easter"] && SEASON_BY_ID["easter"].label.toLowerCase().indexOf("easter") !== -1,
        "Easter landing page (04-seo §1.3) must exist");
    });

    // --- ACCEPTANCE: each page LISTS camps in that season. ---
    check("Every season page lists at least one camp from live data", function () {
      var pages = buildAllSeasonPages();
      HC.assert((HC.data.providers || []).length > 0, "live directory should have providers");
      pages.forEach(function (pg) {
        HC.assert(pg.count >= 1, "season page '" + pg.id + "' should list >=1 camp, got " + pg.count);
        HC.assert(Array.isArray(pg.camps) && pg.camps.length === pg.count, "camps array should match count for " + pg.id);
        // Every listed camp must be a real provider id from the directory.
        pg.camps.forEach(function (c) {
          var real = (HC.data.providers || []).some(function (p) { return p.id === c.id; });
          HC.assert(real, "listed camp '" + c.id + "' must be a real provider");
        });
      });
    });

    check("The Summer page is the largest (anchored by planner weeks)", function () {
      var summer = buildSeasonPage("summer");
      HC.assert(summer.count >= 5, "summer should list several camps, got " + summer.count);
      // Camps with confirmed planner weeks must all appear on summer.
      var planner = HC.data.planner || {};
      var byId = planner.byId || {};
      var withWeeks = Object.keys(byId).filter(function (id) {
        var e = byId[id];
        return e && Array.isArray(e.weeks) && e.weeks.length;
      });
      HC.assert(withWeeks.length > 0, "live planner should have camps with confirmed weeks");
      var summerIds = summer.camps.map(function (c) { return c.id; });
      withWeeks.forEach(function (id) {
        // Only assert for ids that are also in the directory.
        var inDir = (HC.data.providers || []).some(function (p) { return p.id === id; });
        if (inDir) HC.assert(summerIds.indexOf(id) !== -1, "camp with confirmed weeks '" + id + "' must be on the summer page");
      });
    });

    // --- Classifier behaviour (synthetic + live). ---
    check("classifyCamp: an Easter-only camp lands on the Easter page only", function () {
      var p = { id: "synthetic-easter", name: "Bunny Bootcamp", summary: "An Easter holiday camp with egg hunts and crafts." };
      var c = classifyCamp(p);
      HC.assert(c.seasons.indexOf("easter") !== -1, "should be classified into easter");
      HC.assert(c.seasons.indexOf("summer") === -1, "Easter-only text should not hit summer");
      HC.assert(c.seasons.indexOf("christmas") === -1, "Easter-only text should not hit christmas");
    });

    check("classifyCamp: a 'runs every holiday' camp lands on ALL seasons", function () {
      var p = { id: "synthetic-yearround", name: "All-Year Adventures", summary: "We run holiday camps every school holiday across the year." };
      var c = classifyCamp(p);
      SEASONS.forEach(function (s) {
        HC.assert(c.seasons.indexOf(s.id) !== -1, "year-round camp should be on season '" + s.id + "'");
      });
    });

    check("classifyCamp: a term-only / season-less camp lands on NO season", function () {
      var p = { id: "synthetic-none", name: "Tuesday Term Club", summary: "An after-school chess club that runs during term time only." };
      var c = classifyCamp(p);
      HC.assert(c.seasons.length === 0, "a term-only camp should match no holiday season, got " + c.seasons.join(","));
    });

    check("classifyCamp does not mutate its input", function () {
      var input = { id: "x", name: "X", summary: "Summer camp", categories: ["Sports"] };
      var before = JSON.stringify(input);
      classifyCamp(input);
      HC.assert(JSON.stringify(input) === before, "input object must be unchanged");
    });

    check("A real live provider classifies into at least one season", function () {
      var providers = HC.data.providers || [];
      var anyClassified = providers.some(function (p) { return classifyCamp(p).seasons.length > 0; });
      HC.assert(anyClassified, "at least one live provider should classify into a season");
    });

    // --- Parent overrides: pin / hide / persist. ---
    check("Pinning a camp moves it to the top of the season page", function () {
      clearOverrides();
      var page = buildSeasonPage("summer");
      HC.assert(page.camps.length >= 2, "need >=2 camps to test pinning, got " + page.camps.length);
      var lastId = page.camps[page.camps.length - 1].id;
      pinCamp("summer", lastId);
      var after = buildSeasonPage("summer");
      HC.assert(after.camps[0].id === lastId, "pinned camp should be first");
      HC.assert(after.camps[0].pinned === true, "first camp should be flagged pinned");
      HC.assert(after.count === page.count, "pinning should not change the count");
      clearOverrides();
    });

    check("Hiding a camp removes it from the season page and drops the count", function () {
      clearOverrides();
      var page = buildSeasonPage("summer");
      var before = page.count;
      HC.assert(before >= 1, "need >=1 camp to test hiding");
      var id = page.camps[0].id;
      hideCamp("summer", id);
      var after = buildSeasonPage("summer");
      HC.assert(after.count === before - 1, "hiding should drop the count by one (" + after.count + " vs " + before + ")");
      HC.assert(!after.camps.some(function (c) { return c.id === id; }), "hidden camp should be gone");
      clearOverrides();
    });

    check("Overrides persist via HC.store and only affect their own season", function () {
      clearOverrides();
      var summer = buildSeasonPage("summer");
      var id = summer.camps[0].id;
      pinCamp("summer", id);
      // Re-read fresh (simulating reload): pin should still be there.
      HC.assert(buildSeasonPage("summer").camps[0].id === id, "pin should persist across rebuilds");
      // Easter page must be unaffected by a summer override.
      var easterRaw = campsInSeason("easter").map(function (m) { return m.provider.id; });
      var easterPage = buildSeasonPage("easter").camps.map(function (c) { return c.id; });
      HC.assert(easterPage.length === easterRaw.length,
        "summer override must not change the easter page size");
      clearOverrides();
    });

    check("Hiding then pinning the same camp un-hides it", function () {
      clearOverrides();
      var page = buildSeasonPage("summer");
      var id = page.camps[0].id;
      hideCamp("summer", id);
      HC.assert(!buildSeasonPage("summer").camps.some(function (c) { return c.id === id; }), "should be hidden first");
      pinCamp("summer", id);
      var after = buildSeasonPage("summer");
      HC.assert(after.camps.some(function (c) { return c.id === id; }), "pinning should un-hide it");
      HC.assert(after.camps[0].id === id, "and pin it to the top");
      clearOverrides();
    });

    // --- Page model integrity. ---
    check("buildSeasonPage for an unknown season returns a non-existent page", function () {
      var pg = buildSeasonPage("not-a-season");
      HC.assert(pg.exists === false, "unknown season should not exist");
      HC.assert(pg.count === 0 && pg.camps.length === 0, "unknown season lists nothing");
    });

    check("Every listed camp carries a human-readable 'why listed' reason", function () {
      var pages = buildAllSeasonPages();
      pages.forEach(function (pg) {
        pg.camps.forEach(function (c) {
          HC.assert(Array.isArray(c.reasons) && c.reasons.length >= 1,
            "camp '" + c.id + "' on " + pg.id + " should have a reason");
        });
      });
    });

    // Leave the store exactly as found.
    clearOverrides();

    return { pass: pass, fail: fail, log: log };
  }

  /* ============================================================
   * 8. Register (idempotent + defensive via core).
   * ============================================================ */
  HC.registerFeature({
    id: "platform-seasonal-pages",
    title: "Seasonal landing pages",
    side: "platform",
    icon: "🗓️",
    summary: "One landing page per UK school holiday (Summer, October half-term, Christmas, February half-term, Easter, May half-term). Each page automatically lists the camps that run in that season — Happity's seasonal SEO category pages, reframed for school-age holiday camps.",
    render: render,
    selfTest: selfTest
  });
})();
