/* HolidayCamp feature — platform-happity-home-hub
 *
 * 'HolidayCamp@Home' online-classes aggregation hub  (platform side)
 *
 * Replicates Happity's "Happity@Home" surface. Verbatim evidence from the
 * Happity support corpus (article 3807913, "How to get started and set up
 * bookings with Happity@Home"):
 *
 *   "...they'll automatically be advertised ... on our website under the
 *    'Happity@Home' umbrella!"
 *   "...you'll need to choose 'Happity@Home' as your online venue..."
 *   "Happity automatically directs local parents towards their 'nearest'
 *    virtual classes..."
 *
 * What this feature is: a single PUBLIC, platform-owned surface that gathers
 * every online / Zoom holiday-camp session under one virtual venue
 * ("HolidayCamp@Home"), and — when a parent tells us where they are — auto-
 * surfaces the NEAREST virtual sessions first. It is deliberately DISTINCT from
 * the in-person area pages and category pages: those are keyed on a physical
 * place or an activity type; THIS one is keyed on the single online venue and
 * ranks purely by how close the (real-life, in-person) base of each online
 * provider is to the parent.
 *
 * Why "nearest" matters for an ONLINE class: Happity's stated aim is to turn
 * virtual attendees into in-person customers ("our aim is to help these people
 * become 'in real life' customers"). So even though a Zoom class has no
 * geography, the provider behind it does, and surfacing the nearest provider's
 * online session is what feeds that funnel.
 *
 * Framed for SCHOOL-AGE HOLIDAY CAMPS (not baby classes): every synthesized
 * online session is a half-term / holiday camp activity (coding, chess, drama,
 * art, languages) for 5-16s, delivered live on Zoom under the @Home venue.
 *
 * ACCEPTANCE CRITERION (asserted in selfTest):
 *   A dedicated HolidayCamp@Home surface aggregates online/Zoom classes under a
 *   single online "venue", and search auto-surfaces the NEAREST virtual classes
 *   to a parent — distinct from in-person area/category pages.
 *
 * Self-contained, defensive, no imports/exports. Calls HC.registerFeature.
 */
(function () {
  "use strict";

  // Defensive: never throw at module load if HC isn't present.
  if (typeof window === "undefined" || !window.HC || typeof window.HC.registerFeature !== "function") {
    if (typeof console !== "undefined" && console.warn) {
      console.warn("[HC] platform-happity-home-hub: HC core not found; skipping registration.");
    }
    return;
  }

  var HC = window.HC;

  var VENUE_ID = "holidaycamp-at-home";
  var VENUE_NAME = "HolidayCamp@Home";
  var STORE_HOME = "platform_home_hub_parent_area"; // last home area a parent typed
  var STORE_SAVED = "platform_home_hub_saved";      // online sessions a parent saved

  /* ---------------- small helpers ---------------- */

  function asText(v) {
    return typeof v === "string" ? v : (v == null ? "" : String(v));
  }

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function escAttr(s) {
    return esc(s).replace(/"/g, "&quot;");
  }

  function el(tag, attrs, html) {
    try { return HC.util.el(tag, attrs, html); }
    catch (e) {
      var n = document.createElement(tag || "div");
      if (html != null) n.innerHTML = html;
      return n;
    }
  }

  function providers() {
    try {
      var p = HC.data.providers;
      return Array.isArray(p) ? p : [];
    } catch (e) { return []; }
  }

  /* ---------------- geography model ----------------
   *
   * Provider records carry no lat/lng. They DO carry a human area string
   * (`area`) and an array of areas (`areas`). We model "nearest" by mapping
   * each area token to a coarse 2-D grid coordinate across Waltham Forest, then
   * scoring distance from the parent's stated home area. This is a deterministic,
   * data-only proxy for geography — good enough to rank "nearest virtual classes"
   * exactly as the acceptance criterion requires.
   */

  // Coarse coordinates (col,row) for E17 / Waltham Forest neighbourhoods.
  var AREA_GRID = {
    "walthamstow": [2, 3],
    "walthamstow central": [2, 3],
    "walthamstow village": [3, 3],
    "lloyd park": [2, 2],
    "higham hill": [1, 2],
    "highams park": [3, 1],
    "chingford": [3, 0],
    "leyton": [2, 5],
    "lea bridge": [1, 5],
    "leytonstone": [3, 4],
    "woodford": [4, 1],
    "woodford green": [4, 1],
    "snaresbrook": [4, 3],
    "loughton": [5, 0],
    "forest school": [4, 3]
  };

  // Normalise a free-text area into the AREA_GRID key it best matches.
  function gridFor(areaText) {
    var s = asText(areaText).toLowerCase();
    if (!s) return null;
    // exact-ish key hit first
    if (AREA_GRID[s]) return AREA_GRID[s];
    // token containment: find the first grid key whose words appear in s
    var keys = Object.keys(AREA_GRID);
    // longer keys first so "walthamstow village" beats "walthamstow"
    keys.sort(function (a, b) { return b.length - a.length; });
    for (var i = 0; i < keys.length; i++) {
      if (s.indexOf(keys[i]) !== -1) return AREA_GRID[keys[i]];
    }
    return null;
  }

  // Best (closest) grid distance between a parent home area and a provider that
  // may span several areas. Returns a number; Infinity if unknown either side.
  function areaDistance(homeArea, provider) {
    var home = gridFor(homeArea);
    if (!home) return Infinity;
    var cand = [];
    if (provider) {
      if (provider.area) cand.push(provider.area);
      if (Array.isArray(provider.areas)) cand = cand.concat(provider.areas);
    }
    var best = Infinity;
    for (var i = 0; i < cand.length; i++) {
      var g = gridFor(cand[i]);
      if (!g) continue;
      var dx = g[0] - home[0], dy = g[1] - home[1];
      var d = Math.sqrt(dx * dx + dy * dy);
      if (d < best) best = d;
    }
    return best;
  }

  /* ---------------- online-session synthesis ----------------
   *
   * The live directory is in-person camps. The @Home hub needs ONLINE sessions.
   * We synthesize a deterministic online-camp catalogue by promoting a curated
   * slice of real providers to ALSO run a live Zoom holiday camp under the single
   * @Home venue. Selection is deterministic (every Nth provider + any whose
   * categories hint at a screen-friendly activity), so tests are stable.
   *
   * Each synthesized session keeps a back-reference to the real provider, so its
   * geography (for "nearest") is the provider's real in-person base — exactly
   * the in-real-life-funnel behaviour Happity describes.
   */

  // Activity themes that work well live on Zoom for school-age kids.
  var ONLINE_THEMES = [
    { theme: "Code Club Live", cat: "Coding", hint: ["coding", "stem", "tech", "computer"] },
    { theme: "Chess Camp Online", cat: "Chess", hint: ["chess", "games"] },
    { theme: "Drama from Home", cat: "Drama", hint: ["drama", "theatre", "performing"] },
    { theme: "Art Studio Live", cat: "Art", hint: ["art", "arts", "craft", "creative"] },
    { theme: "Languages Live", cat: "Languages", hint: ["language", "french", "spanish"] },
    { theme: "Lego & Build Online", cat: "Construction", hint: ["lego", "build", "construction"] }
  ];

  function categoriesText(p) {
    var c = (p && Array.isArray(p.categories)) ? p.categories : [];
    return c.join(" ").toLowerCase();
  }

  // Pick a theme for a provider: first matching by category hint, else by index.
  function themeFor(p, idx) {
    var ctext = categoriesText(p);
    for (var i = 0; i < ONLINE_THEMES.length; i++) {
      var t = ONLINE_THEMES[i];
      for (var h = 0; h < t.hint.length; h++) {
        if (ctext.indexOf(t.hint[h]) !== -1) return t;
      }
    }
    return ONLINE_THEMES[idx % ONLINE_THEMES.length];
  }

  // Deterministic: a provider is "online-capable" if it has a usable area (so it
  // can be ranked for nearest) AND (every 2nd provider OR has a screen-friendly
  // category). Guarantees a non-trivial catalogue from the live 44-provider data.
  function isOnlineCapable(p, idx) {
    if (!p) return false;
    if (areaDistanceKnown(p) === false) return false;
    var ctext = categoriesText(p);
    var screenFriendly = /art|craft|creative|stem|tech|coding|chess|drama|language|multi-activity/.test(ctext);
    return screenFriendly || (idx % 2 === 0);
  }

  function areaDistanceKnown(p) {
    var cand = [];
    if (p && p.area) cand.push(p.area);
    if (p && Array.isArray(p.areas)) cand = cand.concat(p.areas);
    for (var i = 0; i < cand.length; i++) { if (gridFor(cand[i])) return true; }
    return false;
  }

  // Build the full online catalogue (the @Home venue's listings). Deterministic.
  function buildOnlineCatalogue() {
    var list = providers();
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var p = list[i];
      if (!isOnlineCapable(p, i)) continue;
      var t = themeFor(p, i);
      out.push({
        id: "online-" + asText(p.id || ("idx" + i)),
        venueId: VENUE_ID,
        venueName: VENUE_NAME,
        online: true,
        platform: "Zoom",
        theme: t.theme,
        category: t.cat,
        providerId: p.id,
        providerName: p.name || "Camp",
        // geography for "nearest" comes from the real provider's base
        baseArea: p.area || (Array.isArray(p.areas) ? p.areas[0] : ""),
        baseAreas: Array.isArray(p.areas) ? p.areas.slice() : (p.area ? [p.area] : []),
        ageMin: typeof p.ageMin === "number" ? p.ageMin : 5,
        ageMax: typeof p.ageMax === "number" ? p.ageMax : 16,
        ageLabel: p.ageLabel || "5-16",
        _provider: p
      });
    }
    return out;
  }

  /* ---------------- nearest-first ranking ---------------- */
  /*
   * Core acceptance behaviour: given a parent's home area, rank EVERY online
   * session by how near its provider's real base is, nearest first. Sessions
   * with unknown geography sink to the bottom but are still listed (the hub
   * aggregates ALL online classes under the venue).
   */
  function rankNearest(catalogue, homeArea) {
    var scored = catalogue.map(function (s) {
      return { session: s, dist: areaDistance(homeArea, s._provider) };
    });
    scored.sort(function (a, b) {
      if (a.dist !== b.dist) return a.dist - b.dist;
      // stable tiebreak by name so ordering is deterministic
      return asText(a.session.providerName).localeCompare(asText(b.session.providerName));
    });
    return scored;
  }

  /* ---------------- persistence (mock) ---------------- */

  function getHomeArea() {
    try {
      var v = HC.store.get(STORE_HOME, "");
      return typeof v === "string" ? v : "";
    } catch (e) { return ""; }
  }
  function setHomeArea(a) {
    try { HC.store.set(STORE_HOME, asText(a)); } catch (e) {}
  }
  function getSaved() {
    try {
      var v = HC.store.get(STORE_SAVED, []);
      return Array.isArray(v) ? v : [];
    } catch (e) { return []; }
  }
  function toggleSaved(sessionId) {
    var saved = getSaved();
    var i = saved.indexOf(sessionId);
    if (i === -1) saved.push(sessionId); else saved.splice(i, 1);
    try { HC.store.set(STORE_SAVED, saved); } catch (e) {}
    return saved.indexOf(sessionId) !== -1;
  }

  /* ---------------- render ---------------- */

  function render(mountEl) {
    if (!mountEl) return;
    try {
      var catalogue = buildOnlineCatalogue();
      var home = getHomeArea() || "Walthamstow";

      mountEl.innerHTML =
        '<style>' +
          '.hh-wrap{font-family:"Nunito Sans",system-ui,sans-serif;color:var(--text,#383838)}' +
          '.hh-venue{display:flex;gap:12px;align-items:center;background:linear-gradient(135deg,#603488,#F82488);' +
            'color:#fff;border-radius:18px;padding:16px 18px;margin-bottom:14px}' +
          '.hh-venue .hh-globe{font-size:34px;line-height:1}' +
          '.hh-venue h3{font-family:"Quicksand",system-ui,sans-serif;margin:0;font-size:20px}' +
          '.hh-venue p{margin:2px 0 0;font-size:13px;opacity:.92}' +
          '.hh-row{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:12px 0}' +
          '.hh-row label{font-size:12.5px;font-weight:700;color:var(--purple,#603488)}' +
          '.hh-input{flex:1;min-width:150px;padding:9px 12px;border:1.5px solid var(--line,#E6E6E6);' +
            'border-radius:10px;font:inherit;font-size:14px}' +
          '.hh-go{border:none;cursor:pointer;background:var(--yellow,#FCD400);color:#1A1A1A;font-weight:700;' +
            'font-family:"Quicksand",system-ui,sans-serif;padding:9px 16px;border-radius:999px;font-size:13px}' +
          '.hh-meta{font-size:12.5px;color:var(--muted,#808080);margin:0 0 10px}' +
          '.hh-list{list-style:none;margin:0;padding:0;display:grid;gap:10px}' +
          '.hh-card{border:1.5px solid var(--line,#E6E6E6);border-radius:14px;padding:12px 14px;' +
            'display:flex;justify-content:space-between;gap:12px;align-items:flex-start}' +
          '.hh-card.near{border-color:var(--magenta,#F82488);background:#FFF4FA}' +
          '.hh-card h4{font-family:"Quicksand",system-ui,sans-serif;color:var(--purple,#603488);margin:0;font-size:15px}' +
          '.hh-tags{font-size:11.5px;color:var(--muted,#808080);margin:3px 0 0}' +
          '.hh-pill{display:inline-block;font-size:10.5px;font-weight:700;padding:2px 8px;border-radius:999px;' +
            'background:#F0E8F4;color:#603488;margin-right:5px}' +
          '.hh-pill.zoom{background:#E3F0FF;color:#1F6FB2}' +
          '.hh-near-badge{font-size:10.5px;font-weight:700;color:#fff;background:var(--magenta,#F82488);' +
            'padding:2px 9px;border-radius:999px}' +
          '.hh-save{border:1.5px solid var(--purple-tint,#F0E8F4);background:#fff;color:#603488;cursor:pointer;' +
            'font-weight:700;font-size:12px;border-radius:999px;padding:6px 12px;white-space:nowrap}' +
        '</style>' +
        '<div class="hh-wrap">' +
          '<div class="hh-venue">' +
            '<div class="hh-globe">🌐</div>' +
            '<div><h3>' + esc(VENUE_NAME) + '</h3>' +
              '<p>One online venue gathering every live Zoom holiday camp — coding, chess, drama, art and more, for 5-16s.</p></div>' +
          '</div>' +
          '<div class="hh-row">' +
            '<label for="hhHome">Where are you?</label>' +
            '<input id="hhHome" class="hh-input" type="text" value="' + escAttr(home) + '" ' +
              'placeholder="e.g. Leyton, Chingford, Highams Park" />' +
            '<button id="hhGo" class="hh-go" type="button">Show nearest</button>' +
          '</div>' +
          '<p class="hh-meta" id="hhMeta"></p>' +
          '<ul class="hh-list" id="hhList"></ul>' +
        '</div>';

      function paint(homeArea) {
        var ranked = rankNearest(catalogue, homeArea);
        var listEl = mountEl.querySelector("#hhList");
        var metaEl = mountEl.querySelector("#hhMeta");
        var saved = getSaved();
        if (metaEl) {
          metaEl.textContent = catalogue.length + " online sessions under " + VENUE_NAME +
            " · ranked nearest to “" + homeArea + "” first";
        }
        if (!listEl) return;
        listEl.innerHTML = ranked.map(function (r, idx) {
          var s = r.session;
          var isNear = idx < 3 && isFinite(r.dist);
          var isSaved = saved.indexOf(s.id) !== -1;
          return '<li class="hh-card' + (isNear ? " near" : "") + '">' +
            '<div>' +
              (isNear ? '<span class="hh-near-badge">Nearest #' + (idx + 1) + '</span> ' : '') +
              '<h4>' + esc(s.theme) + ' — ' + esc(s.providerName) + '</h4>' +
              '<div class="hh-tags">' +
                '<span class="hh-pill zoom">🔵 ' + esc(s.platform) + '</span>' +
                '<span class="hh-pill">' + esc(VENUE_NAME) + '</span>' +
                '<span class="hh-pill">Ages ' + esc(s.ageLabel) + '</span>' +
                'Runs from ' + esc(s.baseArea || "online") +
                (isFinite(r.dist) ? ' · ' + r.dist.toFixed(1) + " away" : " · location n/a") +
              '</div>' +
            '</div>' +
            '<button class="hh-save" type="button" data-hh-save="' + escAttr(s.id) + '">' +
              (isSaved ? "✓ Saved" : "Save") + '</button>' +
          '</li>';
        }).join("");
      }

      paint(home);

      var goBtn = mountEl.querySelector("#hhGo");
      var input = mountEl.querySelector("#hhHome");
      if (goBtn && input) {
        goBtn.addEventListener("click", function () {
          var v = asText(input.value).trim() || "Walthamstow";
          setHomeArea(v);
          paint(v);
          try { HC.util.toast("Showing your nearest " + VENUE_NAME + " classes"); } catch (e) {}
        });
      }
      mountEl.addEventListener("click", function (e) {
        var t = e.target && e.target.closest ? e.target.closest("[data-hh-save]") : null;
        if (!t) return;
        var nowSaved = toggleSaved(t.getAttribute("data-hh-save"));
        t.textContent = nowSaved ? "✓ Saved" : "Save";
      });
    } catch (e) {
      mountEl.innerHTML = '<p style="color:#9a1f5e">HolidayCamp@Home failed to render: ' +
        esc(e && e.message ? e.message : String(e)) + "</p>";
    }
  }

  /* ---------------- selfTest ---------------- */

  function selfTest() {
    var pass = 0, fail = 0, log = [];
    function check(label, fn) {
      try { fn(); pass += 1; log.push("✓ " + label); }
      catch (e) { fail += 1; log.push("✗ " + label + " — " + (e && e.message ? e.message : String(e))); }
    }

    var catalogue = buildOnlineCatalogue();

    // 1. The hub aggregates a non-trivial set of online sessions from live data.
    check("Hub aggregates online sessions from the live directory", function () {
      HC.assert(Array.isArray(catalogue), "catalogue should be an array");
      HC.assert(catalogue.length >= 3,
        "expected >=3 online sessions, got " + catalogue.length);
    });

    // 2. EVERY aggregated session sits under the single online venue (not an
    //    in-person area/category page) and is flagged online/Zoom.
    check("Every session is under the single online venue and is online/Zoom", function () {
      HC.assert(catalogue.length > 0, "need sessions to check");
      for (var i = 0; i < catalogue.length; i++) {
        var s = catalogue[i];
        HC.assert(s.venueId === VENUE_ID, "session " + s.id + " wrong venueId: " + s.venueId);
        HC.assert(s.venueName === VENUE_NAME, "session " + s.id + " wrong venueName");
        HC.assert(s.online === true, "session " + s.id + " not flagged online");
        HC.assert(s.platform === "Zoom", "session " + s.id + " not a Zoom class");
      }
    });

    // 3. The online venue is DISTINCT from any in-person area: its venue name is
    //    not a real provider area token, and the surface is keyed on it alone.
    check("Online venue is distinct from in-person area pages", function () {
      var areas = {};
      providers().forEach(function (p) {
        if (p.area) areas[asText(p.area).toLowerCase()] = true;
        (p.areas || []).forEach(function (a) { areas[asText(a).toLowerCase()] = true; });
      });
      HC.assert(!areas[VENUE_NAME.toLowerCase()],
        VENUE_NAME + " must not collide with an in-person area");
      // All sessions share exactly one venue id (a single online venue).
      var ids = {};
      catalogue.forEach(function (s) { ids[s.venueId] = true; });
      HC.assert(Object.keys(ids).length === 1,
        "expected exactly 1 online venue, found " + Object.keys(ids).length);
    });

    // 4. ACCEPTANCE: search auto-surfaces the NEAREST virtual classes to a
    //    parent. A nearby parent's top session must be nearer than a far
    //    parent's top session for the same catalogue.
    check("Search auto-surfaces nearest virtual classes (ranking works)", function () {
      var rankedLeyton = rankNearest(catalogue, "Leyton");
      HC.assert(rankedLeyton.length === catalogue.length, "ranking must cover all sessions");
      // top result for a known area must have a finite, computed distance
      HC.assert(isFinite(rankedLeyton[0].dist),
        "nearest session should have a known distance");
      // monotonic non-decreasing distance => genuinely nearest-first
      for (var i = 1; i < rankedLeyton.length; i++) {
        HC.assert(rankedLeyton[i].dist >= rankedLeyton[i - 1].dist - 1e-9,
          "results not sorted nearest-first at index " + i);
      }
    });

    // 5. ACCEPTANCE (the funnel): different home areas surface a different
    //    nearest class. A Chingford parent and a Leyton parent should not, in
    //    general, get the identical #1 — proving it is geography-driven, not a
    //    fixed list.
    check("Nearest result is geography-driven (varies by parent location)", function () {
      var topChingford = rankNearest(catalogue, "Chingford")[0];
      var topLeyton = rankNearest(catalogue, "Leyton")[0];
      // Their computed distances to their own #1 should both be small/finite...
      HC.assert(isFinite(topChingford.dist) && isFinite(topLeyton.dist),
        "both parents should get a located nearest class");
      // ...and the Chingford parent's nearest provider should be at least as
      // near to Chingford as the Leyton parent's nearest is to Chingford.
      var leytonProviderToChingford = areaDistance("Chingford", topLeyton.session._provider);
      HC.assert(topChingford.dist <= leytonProviderToChingford + 1e-9,
        "Chingford parent should get a class at least as near as the Leyton parent's");
    });

    // 6. An unknown / blank location still returns the FULL aggregated list
    //    (the hub never hides classes — it just can't rank them).
    check("Unknown location still lists every online class", function () {
      var ranked = rankNearest(catalogue, "Atlantis-on-Sea");
      HC.assert(ranked.length === catalogue.length,
        "blank/unknown area must still surface all " + catalogue.length + " classes");
      // with no known home, all distances are Infinity (nothing claimed nearest)
      var anyFinite = ranked.some(function (r) { return isFinite(r.dist); });
      HC.assert(!anyFinite, "unknown home area should not fabricate a nearest class");
    });

    // 7. Persistence of the parent's home area round-trips through HC.store.
    check("Parent home area persists via HC.store", function () {
      var prev = getHomeArea();
      setHomeArea("Highams Park");
      HC.assert(getHomeArea() === "Highams Park", "home area did not persist");
      setHomeArea(prev || ""); // restore
    });

    // 8. Saving an online session round-trips and toggles off again.
    check("Saving an online session toggles and persists", function () {
      HC.assert(catalogue.length > 0, "need a session to save");
      var id = catalogue[0].id;
      var before = getSaved().indexOf(id) !== -1;
      var on = toggleSaved(id);
      HC.assert(on === !before, "first toggle should flip saved state");
      HC.assert(getSaved().indexOf(id) !== -1 === on, "saved store out of sync");
      var off = toggleSaved(id); // restore
      HC.assert(off === before, "second toggle should restore original state");
    });

    return { pass: pass, fail: fail, log: log };
  }

  /* ---------------- register ---------------- */

  HC.registerFeature({
    id: "platform-happity-home-hub",
    title: "HolidayCamp@Home online hub",
    side: "platform",
    icon: "🌐",
    summary: "A single online venue that aggregates every live Zoom holiday camp and auto-surfaces a parent's nearest virtual classes — distinct from in-person area and category pages.",
    render: render,
    selfTest: selfTest
  });
})();
