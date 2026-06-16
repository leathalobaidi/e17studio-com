/* HolidayCamp feature module — platform-featured-result-template
 *
 * Side: PLATFORM.
 * Replicates Happity's search RESULT TEMPLATE: "1 Featured + N by distance,
 * Members prioritised". This is the layout/ranking rule that every result set
 * (postcode search, city x category page, venue page) is rendered through.
 *
 * Evidence:
 *   - Article 2278351 ("Featured Listings: Promoting Your Classes at the Top of
 *     Happity Search Results"):
 *       • Sub-title: "Advertise your classes in the top 3 search results …".
 *       • "Featured Listings is a paid advertising tool available to Happity
 *          MEMBERS … places your classes at the top of relevant search results
 *          and category pages."  -> Featured is a MEMBERS-ONLY service.
 *       • "No more than 3 classes are featured in any one set of search
 *          results, so there's very little competition for that top spot."
 *       • "Your class still appears in its normal position in the results as
 *          well" -> a featured camp also exists in the by-distance tail.
 *   - Article 3746856 ("What are categories…") + 5827872 ("How do parents find
 *     my classes"): "Search results are listed by time as a default and then
 *     parents can filter … by distance"; featured activities sit on top.
 *   - 02-ia-ux §4.1: "Featured activities appear at top (max 3 per result set;
 *     purple banner + yellow star) — paid placement."
 *   - 02-ia-ux §6 / replication note 6: "Copy the 'Featured + N-by-distance'
 *     result template (1 promoted + 9 by distance, Members prioritised). It is
 *     simultaneously the SEO page body and the monetisation surface."
 *
 * The model (framed for school-age HOLIDAY CAMPS):
 *   1. Start from the candidate set of camps matching a search.
 *   2. Compute each camp's distance from the E17 home area (same deterministic
 *      model as parent-sort-results: rank by `areas`, + stable per-id jitter —
 *      no lat/lng in the dataset).
 *   3. A camp can be a MEMBER (paid plan) and may have Featured ON.
 *      Featured eligibility REQUIRES membership (per article 2278351), so only
 *      Members can ever take a top slot.
 *   4. FEATURED BLOCK: take up to FEATURED_CAP (3) camps for the top.
 *        - Only Members with featured=on qualify.
 *        - When MORE qualify than the cap AND the field is crowded
 *          (> MEMBER_PRIORITY_THRESHOLD = 10 qualifiers), MEMBERS ARE
 *          PRIORITISED: rank qualifiers Member-first, then by distance.
 *          (Mirrors Happity randomly rotating Members through the scarce slots
 *          while non-Members can never feature.) Below the threshold, qualifier
 *          order is simply by distance.
 *   5. TAIL: every remaining camp, strictly by distance (nearest first). A
 *      featured camp ALSO appears in the tail in its natural distance position
 *      (evidence: "still appears in its normal position"), so the visible set
 *      is featured-block ++ full-distance-list.
 *
 * Acceptance criterion (asserted in selfTest, multiple cases):
 *   A result set shows up to 3 featured at top then others by distance;
 *   Members prioritised when more than 10 qualify.
 *
 * Defensive throughout: every data read is guarded; a malformed field can never
 * throw at registration time or while building a result set. Persistence (which
 * demo camps are toggled Member / Featured) is via HC.store, never raw
 * localStorage.
 */
(function () {
  "use strict";

  /* ---------------- constants ---------------- */
  var FEATURED_CAP = 3;                 // "No more than 3 classes are featured"
  var MEMBER_PRIORITY_THRESHOLD = 10;   // Members prioritised when > 10 qualify
  var STORE_KEY = "featuredTemplate.config";

  // Home reference: E17 / Walthamstow (same model as parent-sort-results).
  var AREA_RANK = {
    "walthamstow": 0,
    "highams park": 1,
    "wood street": 1,
    "waltham forest": 1,
    "leyton": 2,
    "leytonstone": 2,
    "borough-wide": 2,
    "chingford": 3,
    "woodford": 4,
    "south woodford": 4,
    "loughton": 5
  };

  /* ---------------- small guards ---------------- */
  function safeArr(v) { return Array.isArray(v) ? v : []; }

  function hashJitter(id) {
    // Stable 0.0..0.9 from an id so equal-rank camps order deterministically.
    var s = String(id == null ? "" : id);
    var h = 0;
    for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 1000;
    return (h % 10) / 10;
  }

  function distanceKm(p) {
    if (!p) return 99;
    var areas = safeArr(p.areas);
    if (!areas.length && p && p.area) areas = [p.area];
    var best = 6; // default "far" if no recognised area
    for (var i = 0; i < areas.length; i++) {
      var key = String(areas[i] || "").toLowerCase().trim();
      var parts = key.split("/");
      for (var j = 0; j < parts.length; j++) {
        var k = parts[j].trim();
        if (Object.prototype.hasOwnProperty.call(AREA_RANK, k) && AREA_RANK[k] < best) {
          best = AREA_RANK[k];
        }
      }
    }
    return best * 1.2 + hashJitter(p && p.id);
  }

  function providers() {
    try { return safeArr(HC.data && HC.data.providers); } catch (e) { return []; }
  }

  /* ---------------- config (which demo camps are Member / Featured) ----------
   * Stored as { member: {id:true}, featured: {id:true} }. Featured is gated on
   * membership at READ time, so a stale "featured but not member" entry can
   * never sneak into a top slot.
   */
  function loadConfig() {
    var def = { member: {}, featured: {} };
    try {
      var raw = HC.store.get(STORE_KEY, null);
      if (!raw || typeof raw !== "object") return def;
      return {
        member: (raw.member && typeof raw.member === "object") ? raw.member : {},
        featured: (raw.featured && typeof raw.featured === "object") ? raw.featured : {}
      };
    } catch (e) { return def; }
  }
  function saveConfig(cfg) {
    try { HC.store.set(STORE_KEY, cfg || { member: {}, featured: {} }); } catch (e) { /* defensive */ }
  }

  function isMember(p, cfg) {
    if (!p) return false;
    try { return !!(cfg && cfg.member && cfg.member[p.id]); } catch (e) { return false; }
  }
  // Featured REQUIRES membership (article 2278351: Members-only service).
  function isFeatured(p, cfg) {
    if (!p) return false;
    try { return !!(cfg && cfg.featured && cfg.featured[p.id]) && isMember(p, cfg); }
    catch (e) { return false; }
  }

  /* ---------------- the ranking core (pure & testable) -----------------------
   * Input: an array of candidate camps + a config describing member/featured
   * state. Output: { featured:[…], tail:[…by distance], rows:[…composed] }.
   *
   * rows = featured-block (≤ cap) then the full candidate list by distance.
   * Each row is { provider, km, member, featured, slot } where slot is
   * "featured" for the top block and "distance" for the tail.
   */
  function buildResultSet(candidates, cfg) {
    var list = safeArr(candidates).filter(Boolean);
    cfg = cfg || loadConfig();

    // Decorate once.
    var decorated = list.map(function (p) {
      return {
        provider: p,
        id: p && p.id,
        km: distanceKm(p),
        member: isMember(p, cfg),
        featured: isFeatured(p, cfg)
      };
    });

    // Qualifiers for a top slot = Members with featured ON.
    var qualifiers = decorated.filter(function (d) { return d.featured; });

    // Sort qualifiers for slot allocation.
    var crowded = qualifiers.length > MEMBER_PRIORITY_THRESHOLD;
    var byDistance = function (a, b) {
      if (a.km !== b.km) return a.km - b.km;
      return String(a.id).localeCompare(String(b.id));
    };
    var ordered = qualifiers.slice();
    if (crowded) {
      // MEMBERS PRIORITISED: Member-first (all qualifiers are Members here, but
      // this keeps the rule explicit and correct if the qualifier definition is
      // ever widened), then nearest first.
      ordered.sort(function (a, b) {
        if (a.member !== b.member) return a.member ? -1 : 1;
        return byDistance(a, b);
      });
    } else {
      ordered.sort(byDistance);
    }

    // Featured block: hard cap at FEATURED_CAP.
    var featured = ordered.slice(0, FEATURED_CAP);

    // Tail: ALL candidates by distance (a featured camp also appears here in
    // its natural position — "still appears in its normal position").
    var tail = decorated.slice().sort(byDistance);

    var featuredIds = {};
    featured.forEach(function (d) { featuredIds[d.id] = true; });

    var rows = [];
    featured.forEach(function (d) {
      rows.push({ provider: d.provider, km: d.km, member: d.member, featured: true, slot: "featured" });
    });
    tail.forEach(function (d) {
      rows.push({
        provider: d.provider, km: d.km, member: d.member,
        featured: !!featuredIds[d.id], slot: "distance"
      });
    });

    return {
      featured: featured,
      tail: tail,
      rows: rows,
      crowded: crowded,
      qualifierCount: qualifiers.length,
      cap: FEATURED_CAP,
      threshold: MEMBER_PRIORITY_THRESHOLD
    };
  }

  /* ---------------- demo-config seeding --------------------------------------
   * For the live preview only: ensure there is a sensible default mix of
   * Members/Featured among real camps so the template renders something. Never
   * mutates if the user has already configured a mix.
   */
  function ensureSeed() {
    var cfg = loadConfig();
    var hasAny = Object.keys(cfg.member).length || Object.keys(cfg.featured).length;
    if (hasAny) return cfg;
    var ps = providers();
    // Pick a deterministic spread: every 3rd camp is a Member; of those, the
    // first 5 are Featured ON.
    var members = [];
    for (var i = 0; i < ps.length; i++) {
      if (i % 3 === 0) { cfg.member[ps[i].id] = true; members.push(ps[i]); }
    }
    members.slice(0, 5).forEach(function (p) { cfg.featured[p.id] = true; });
    saveConfig(cfg);
    return cfg;
  }

  /* ---------------- render ---------------------------------------------------- */
  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function render(mountEl) {
    try {
      if (!mountEl) return;
      var cfg = ensureSeed();
      var ps = providers();
      var result = buildResultSet(ps, cfg);

      var head =
        '<div style="font-size:14px;color:var(--text,#383838);line-height:1.6">' +
          '<p>Every HolidayCamp result set is rendered through Happity’s template: ' +
          'up to <strong>' + FEATURED_CAP + ' Featured camps</strong> at the top ' +
          '(<span style="color:#7a3cc4;font-weight:700">★ Featured</span>, a Members-only ' +
          'paid placement), then <strong>every camp by distance</strong> (nearest E17 first). ' +
          'When more than <strong>' + MEMBER_PRIORITY_THRESHOLD + '</strong> camps qualify for the ' +
          'top, <strong>Members are prioritised</strong> for the scarce slots.</p>' +
          '<p style="color:var(--muted,#6b6b6b)">Live set: <strong>' + ps.length + '</strong> camps · ' +
            '<strong>' + result.qualifierCount + '</strong> qualify for Featured · ' +
            (result.crowded
              ? '<span style="color:#9a1f5e;font-weight:700">crowded → Members prioritised</span>'
              : 'not crowded → nearest qualifiers win') +
          '.</p>' +
        '</div>';

      var rowsHtml = result.rows.slice(0, 16).map(function (r, idx) {
        var p = r.provider || {};
        var badge = r.slot === "featured"
          ? '<span style="background:#f3e9ff;color:#7a3cc4;border:1px solid #d9bcff;' +
            'border-radius:999px;padding:1px 8px;font-size:11px;font-weight:700">★ Featured</span>'
          : '<span style="color:var(--muted,#8a8a8a);font-size:11px">#' + (idx - result.featured.length + 1) + ' by distance</span>';
        var member = r.member
          ? '<span style="color:#2f7d4f;font-size:11px;font-weight:700">Member</span>'
          : '<span style="color:var(--muted,#9a9a9a);font-size:11px">Free listing</span>';
        var topRule = (idx === result.featured.length && result.featured.length)
          ? 'border-top:2px dashed #d9bcff;margin-top:4px;padding-top:8px;'
          : '';
        return '<div style="display:flex;align-items:center;gap:10px;padding:8px 10px;' +
          'border-radius:10px;background:' + (r.slot === "featured" ? "#faf5ff" : "var(--card,#fff)") + ';' +
          'border:1px solid var(--line,#eee);' + topRule + '">' +
            '<div style="flex:1;min-width:0">' +
              '<div style="font-weight:700;font-size:13.5px;color:var(--text,#383838);' +
                'white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + esc(p.name || p.id || "Camp") + '</div>' +
              '<div style="font-size:11.5px;color:var(--muted,#7a7a7a)">' +
                esc(safeArr(p.areas)[0] || p.area || "—") + ' · ' + r.km.toFixed(1) + ' km</div>' +
            '</div>' +
            '<div style="text-align:right;display:flex;flex-direction:column;gap:2px;align-items:flex-end">' +
              badge + member +
            '</div>' +
          '</div>';
      }).join("");

      mountEl.innerHTML =
        head +
        '<div style="display:flex;flex-direction:column;gap:6px;margin-top:12px">' + rowsHtml + '</div>' +
        '<p style="font-size:11.5px;color:var(--muted,#9a9a9a);margin-top:10px">' +
          'Showing first 16 rows. Note a Featured camp also appears lower down in its natural ' +
          'distance position — visibility in two places, exactly as Happity describes.</p>' +
        '<div style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap">' +
          '<button data-ftpl-recrowd style="font:inherit;font-size:12px;cursor:pointer;' +
            'border:1px solid #d9bcff;background:#f3e9ff;color:#7a3cc4;border-radius:999px;padding:6px 12px">' +
            'Simulate a crowded result set (12 qualifiers)</button>' +
          '<button data-ftpl-reset style="font:inherit;font-size:12px;cursor:pointer;' +
            'border:1px solid var(--line,#ddd);background:var(--card,#fff);border-radius:999px;padding:6px 12px">' +
            'Reset demo mix</button>' +
        '</div>';

      // Wire the two demo buttons (scoped to this mountEl).
      var recrowd = mountEl.querySelector("[data-ftpl-recrowd]");
      if (recrowd) recrowd.addEventListener("click", function () {
        var c = loadConfig();
        var all = providers();
        // Make the 12 nearest camps Members + Featured ON to force a crowded set.
        var nearest = all.slice().sort(function (a, b) { return distanceKm(a) - distanceKm(b); }).slice(0, 12);
        nearest.forEach(function (p) { c.member[p.id] = true; c.featured[p.id] = true; });
        saveConfig(c);
        try { HC.util.toast("Crowded set: 12 camps now qualify → Members prioritised for 3 slots"); } catch (e) {}
        render(mountEl);
      });
      var reset = mountEl.querySelector("[data-ftpl-reset]");
      if (reset) reset.addEventListener("click", function () {
        try { HC.store.set(STORE_KEY, { member: {}, featured: {} }); } catch (e) {}
        ensureSeed();
        try { HC.util.toast("Demo mix reset"); } catch (e) {}
        render(mountEl);
      });
    } catch (e) {
      try {
        mountEl.innerHTML = '<p style="color:#9a1f5e">Preview unavailable: ' + esc(e && e.message) + '</p>';
      } catch (_) { /* never throw from render */ }
    }
  }

  /* ---------------- selfTest -------------------------------------------------- */
  function selfTest() {
    var pass = 0, fail = 0, log = [];
    function check(label, fn) {
      try { fn(); pass += 1; log.push("✓ " + label); }
      catch (e) { fail += 1; log.push("✗ " + label + " — " + (e && e.message ? e.message : String(e))); }
    }

    // Synthetic candidates so the test is independent of live data volume.
    // km is controlled purely via the `areas` field + the deterministic model.
    function camp(id, area) { return { id: id, name: id, areas: [area] }; }
    // Areas in ascending distance: walthamstow(0) < highams park(1) < leyton(2)
    //  < chingford(3) < woodford(4) < loughton(5). Plus per-id jitter.
    var AREAS = ["walthamstow", "highams park", "leyton", "chingford", "woodford", "loughton"];
    function makeCandidates(n) {
      var out = [];
      for (var i = 0; i < n; i++) out.push(camp("c" + i, AREAS[i % AREAS.length]));
      return out;
    }
    function cfgFrom(members, featured) {
      var c = { member: {}, featured: {} };
      (members || []).forEach(function (id) { c.member[id] = true; });
      (featured || []).forEach(function (id) { c.featured[id] = true; });
      return c;
    }
    function nonDecreasing(rows) {
      var last = -Infinity;
      for (var i = 0; i < rows.length; i++) {
        if (rows[i].km < last - 1e-9) return false;
        last = rows[i].km;
      }
      return true;
    }

    // --- CASE A: small set, 2 featured qualifiers -> both feature, capped, tail by distance.
    check("CASE A: featured block holds the qualifiers (≤ cap) at the top", function () {
      var cands = makeCandidates(8); // c0..c7
      var cfg = cfgFrom(["c5", "c6"], ["c5", "c6"]); // 2 Members, both Featured ON
      var rs = buildResultSet(cands, cfg);
      HC.assert(rs.featured.length === 2, "expected 2 featured, got " + rs.featured.length);
      HC.assert(rs.featured.length <= rs.cap, "featured must never exceed cap " + rs.cap);
      // The two top rows are the featured slots.
      HC.assert(rs.rows[0].slot === "featured" && rs.rows[1].slot === "featured",
        "first rows should be the featured block");
      var topIds = rs.rows.slice(0, 2).map(function (r) { return r.provider.id; }).sort().join(",");
      HC.assert(topIds === "c5,c6", "featured slots should be c5,c6, got " + topIds);
    });

    // --- CASE B: tail is strictly nearest-first (non-decreasing km).
    check("CASE B: the by-distance tail is ordered nearest-first", function () {
      var cands = makeCandidates(8);
      var cfg = cfgFrom(["c2"], ["c2"]);
      var rs = buildResultSet(cands, cfg);
      var tailRows = rs.rows.filter(function (r) { return r.slot === "distance"; });
      HC.assert(tailRows.length === cands.length,
        "tail should list every candidate (" + cands.length + "), got " + tailRows.length);
      HC.assert(nonDecreasing(tailRows), "tail km must be non-decreasing (nearest first)");
    });

    // --- CASE C: more qualifiers than the cap -> only 3 feature (hard cap).
    check("CASE C: >3 qualifiers → only 3 featured (hard cap of " + FEATURED_CAP + ")", function () {
      var cands = makeCandidates(8);
      var ids = ["c0", "c1", "c2", "c3", "c4"]; // 5 qualify
      var cfg = cfgFrom(ids, ids);
      var rs = buildResultSet(cands, cfg);
      HC.assert(rs.qualifierCount === 5, "expected 5 qualifiers, got " + rs.qualifierCount);
      HC.assert(rs.featured.length === FEATURED_CAP,
        "featured must be capped at " + FEATURED_CAP + ", got " + rs.featured.length);
      var featuredRows = rs.rows.filter(function (r) { return r.slot === "featured"; });
      HC.assert(featuredRows.length === FEATURED_CAP, "exactly " + FEATURED_CAP + " featured rows expected");
    });

    // --- CASE D (ACCEPTANCE): >10 qualifiers -> Members prioritised, 3 featured, tail by distance.
    check("CASE D: >10 qualifiers → crowded → Members prioritised for the 3 slots", function () {
      // 12 candidates. Make a FAR non-member-but-featured impossible (featured
      // requires membership), so build a crowded set: 12 Members all Featured.
      var cands = makeCandidates(12); // c0..c11
      var ids = cands.map(function (c) { return c.id; });
      var cfg = cfgFrom(ids, ids); // all 12 are Members + Featured ON
      var rs = buildResultSet(cands, cfg);
      HC.assert(rs.qualifierCount === 12, "expected 12 qualifiers, got " + rs.qualifierCount);
      HC.assert(rs.qualifierCount > MEMBER_PRIORITY_THRESHOLD,
        "12 should exceed the priority threshold of " + MEMBER_PRIORITY_THRESHOLD);
      HC.assert(rs.crowded === true, "set should be flagged crowded");
      HC.assert(rs.featured.length === FEATURED_CAP,
        "still only " + FEATURED_CAP + " featured when crowded, got " + rs.featured.length);
      // All featured slots must be Members (prioritisation invariant).
      HC.assert(rs.featured.every(function (d) { return d.member; }),
        "every featured slot must be a Member when crowded");
      // The top block, among Members, is the nearest Members (Member-first then distance).
      HC.assert(nonDecreasing(rs.featured), "crowded featured block should be nearest-Members-first");
    });

    // --- CASE E (ACCEPTANCE, prioritisation bites): Members beat a NON-qualifying
    //     nearer camp for the top, and a non-Member can never take a slot.
    check("CASE E: a non-Member never features; Members take the scarce slots", function () {
      var cands = makeCandidates(12);
      // c0 is the very nearest camp but is NOT a member -> can't feature.
      // 11 OTHER camps (c1..c11) are Members + Featured ON -> 11 qualifiers (>10).
      var memberIds = [];
      for (var i = 1; i <= 11; i++) memberIds.push("c" + i);
      var cfg = cfgFrom(memberIds, memberIds);
      var rs = buildResultSet(cands, cfg);
      HC.assert(rs.qualifierCount === 11, "expected 11 qualifiers, got " + rs.qualifierCount);
      HC.assert(rs.crowded === true, "11 qualifiers should be crowded");
      var topIds = rs.featured.map(function (d) { return d.id; });
      HC.assert(topIds.indexOf("c0") === -1, "non-Member c0 must never take a featured slot");
      HC.assert(rs.featured.every(function (d) { return d.member; }),
        "all featured slots are Members");
      // c0 (nearest) must still be present, but only in the by-distance tail.
      var c0Tail = rs.rows.filter(function (r) { return r.provider.id === "c0"; });
      HC.assert(c0Tail.length === 1 && c0Tail[0].slot === "distance",
        "c0 should appear once, in the distance tail");
    });

    // --- CASE F: NOT crowded (<=10 qualifiers) -> qualifier slots by distance, no member bias needed.
    check("CASE F: ≤10 qualifiers → not crowded → nearest qualifiers take the slots", function () {
      var cands = makeCandidates(8);
      var ids = ["c3", "c0", "c2"]; // 3 qualify (c0 nearest, c2 next, c3 furthest of these)
      var cfg = cfgFrom(ids, ids);
      var rs = buildResultSet(cands, cfg);
      HC.assert(rs.crowded === false, "3 qualifiers must not be crowded");
      HC.assert(rs.featured.length === 3, "all 3 qualifiers feature (within cap)");
      HC.assert(nonDecreasing(rs.featured), "non-crowded featured block ordered by distance");
      HC.assert(rs.featured[0].id === "c0", "nearest qualifier c0 should be the first featured");
    });

    // --- CASE G: a featured camp ALSO appears in the tail (visibility in two places).
    check("CASE G: a featured camp also appears in its natural distance position", function () {
      var cands = makeCandidates(8);
      var cfg = cfgFrom(["c4"], ["c4"]);
      var rs = buildResultSet(cands, cfg);
      var featuredRows = rs.rows.filter(function (r) { return r.slot === "featured" && r.provider.id === "c4"; });
      var tailRows = rs.rows.filter(function (r) { return r.slot === "distance" && r.provider.id === "c4"; });
      HC.assert(featuredRows.length === 1, "c4 should hold a featured slot");
      HC.assert(tailRows.length === 1, "c4 should ALSO be in the distance tail");
    });

    // --- CASE H: zero featured -> pure distance list, no empty top block.
    check("CASE H: no Featured camps → results are purely by distance", function () {
      var cands = makeCandidates(6);
      var rs = buildResultSet(cands, cfgFrom([], []));
      HC.assert(rs.featured.length === 0, "no featured expected");
      HC.assert(rs.rows.every(function (r) { return r.slot === "distance"; }),
        "all rows should be distance rows");
      HC.assert(nonDecreasing(rs.rows), "rows must be nearest-first");
    });

    // --- CASE I: robustness against malformed candidates (defensive).
    check("CASE I: malformed/empty candidates never throw", function () {
      var rs1 = buildResultSet(null, cfgFrom([], []));
      HC.assert(rs1.rows.length === 0, "null candidates -> empty result");
      var rs2 = buildResultSet([null, undefined, {}, { id: "x" }], loadConfig());
      HC.assert(rs2.rows.length >= 1, "garbage candidates should be filtered, valid ones kept");
    });

    // --- CASE J: featured gate honours membership (featured flag without membership is inert).
    check("CASE J: featured flag without membership is ignored (Members-only service)", function () {
      var cands = makeCandidates(6);
      // c2 is flagged featured but is NOT a member.
      var cfg = { member: {}, featured: { "c2": true } };
      var rs = buildResultSet(cands, cfg);
      HC.assert(rs.qualifierCount === 0, "non-member cannot be a featured qualifier");
      HC.assert(rs.featured.length === 0, "no featured slots when the only flagged camp isn't a Member");
    });

    return { pass: pass, fail: fail, log: log };
  }

  /* ---------------- register -------------------------------------------------- */
  HC.registerFeature({
    id: "platform-featured-result-template",
    title: "Featured + by-distance result template",
    side: "platform",
    icon: "⭐",
    summary: "How every result set is laid out: up to 3 Featured camps on top (Members-only paid placement), then all camps by distance — Members prioritised for the slots when more than 10 qualify.",
    render: render,
    selfTest: selfTest
  });
})();
