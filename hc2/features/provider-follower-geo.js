/* HolidayCamp feature: provider-follower-geo
 * ------------------------------------------------------------------
 * Replicates Happity's "anonymised follower location data" Member
 * benefit for the PROVIDER side, reframed for SCHOOL-AGE HOLIDAY CAMPS
 * (not baby classes).
 *
 * Evidence (support corpus, article 4291535 — "How to use Happity
 * Followers for zero-effort email marketing"):
 *   §Member Benefits: "Members are also able to retrieve extra data on
 *     where their followers are located. This will help you see which
 *     areas to expand into and grow your business at new venues (our
 *     venue directory can also help with this)."
 *   §Accessing Your Follower List: "If you're a Member you'll be able
 *     to view anonymised location data..."
 *
 * ACCEPTANCE CRITERION (asserted by selfTest, multiple cases):
 *   Members see where followers CLUSTER so they can decide EXPANSION
 *   AREAS. Concretely, this module:
 *     - aggregates each follower's home area into a ranked cluster table
 *       (count + % share) — the "where followers are located" view;
 *     - the data is ANONYMISED: clusters expose area + counts only, never
 *       an individual follower's email or name;
 *     - cross-references clusters against the areas the Member already
 *       runs camps in, and recommends the highest-demand area where they
 *       have followers but NO current presence as the expansion target.
 *
 * Member-gating: the anonymised location breakdown is a MEMBER benefit.
 * Non-members see only the headline follower count; members unlock the
 * per-area cluster table, the heatmap and the expansion recommendation —
 * matching the article ("If you're a Member you'll be able to view
 * anonymised location data").
 *
 * Defensive: nothing throws at registration time. Persistence is via
 * HC.store ONLY (namespaced keys). The verified camps.js data is never
 * mutated — follower records are synthesised deterministically from the
 * borough's real areas so the demo is stable across reloads, plus any
 * manually-added followers the Member captures.
 * ------------------------------------------------------------------ */
(function () {
  "use strict";

  if (typeof window === "undefined" || !window.HC || typeof window.HC.registerFeature !== "function") {
    // Core not present — fail silently rather than throwing.
    if (typeof console !== "undefined" && console.warn) {
      console.warn("[HC] provider-follower-geo: HC core not found; skipping registration.");
    }
    return;
  }
  var HC = window.HC;

  /* ============================================================
   * Storage keys (HC.store, namespaced under hc_ by core).
   *  - MEMBER_KEY:    { [providerId]: true } — which providers are Members.
   *  - FOLLOWERS_KEY: { [providerId]: [ {id, area, optIn, addedAt} ] }
   *                   manually-captured followers, layered on top of the
   *                   deterministic synthetic base.
   * ============================================================ */
  var MEMBER_KEY = "provider_follower_geo_members";
  var FOLLOWERS_KEY = "provider_follower_geo_manual";

  /* The borough's real local areas (mirrors camps.js areas[]). Used both
   * as the geographic spine for synthetic followers and as the canonical
   * cluster axis so the table is stable even with no real data. */
  var BOROUGH_AREAS = [
    "Walthamstow", "Leyton", "Leytonstone", "Chingford",
    "Highams Park", "Woodford", "Loughton", "Wanstead"
  ];

  /* ============================================================
   * Small deterministic PRNG so synthetic followers are STABLE across
   * reloads (a real-feeling dataset that does not jitter every render).
   * ============================================================ */
  function hashStr(s) {
    var h = 2166136261;
    s = String(s == null ? "" : s);
    for (var i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = (h * 16777619) >>> 0;
    }
    return h >>> 0;
  }
  function mulberry32(seed) {
    var a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /* ============================================================
   * Provider lookup + the areas a provider already RUNS camps in
   * (their current presence — read from the verified camps.js).
   * ============================================================ */
  function providers() {
    try { return (HC.data && HC.data.providers) || []; } catch (e) { return []; }
  }
  function findProvider(id) {
    var ps = providers();
    for (var i = 0; i < ps.length; i++) { if (ps[i] && ps[i].id === id) return ps[i]; }
    return null;
  }
  function presenceAreas(provider) {
    if (!provider) return [];
    var out = [];
    var seen = {};
    var src = Array.isArray(provider.areas) ? provider.areas : [];
    for (var i = 0; i < src.length; i++) {
      var a = src[i];
      if (a && !seen[a]) { seen[a] = true; out.push(a); }
    }
    return out;
  }

  /* ============================================================
   * Synthetic follower base — DETERMINISTIC per provider.
   *
   * A camp's followers cluster MOSTLY where it already operates (parents
   * who found it), but a meaningful tail comes from NEIGHBOURING areas it
   * does NOT yet serve — exactly the "where to expand" signal the Happity
   * article promises. We bias the distribution that way so the expansion
   * recommendation is genuinely informative, not random noise.
   *
   * Followers are anonymised: each record carries only a synthetic id and
   * a home area (+ a marketing opt-in flag). No names/emails are stored.
   * ============================================================ */
  function syntheticFollowers(provider) {
    if (!provider || !provider.id) return [];
    // Synthetic followers are demo data for REAL catalogue providers only.
    // Ad-hoc / test provider objects not present in camps.js get no synthetic
    // base — their follower set is driven purely by manually-logged records,
    // so callers retain full control of the dataset.
    if (!findProvider(provider.id)) return [];
    var rnd = mulberry32(hashStr("flw:" + provider.id));
    var presence = presenceAreas(provider);
    var presenceSet = {};
    presence.forEach(function (a) { presenceSet[a] = true; });

    // Total followers scales a little with how broad the provider is.
    var base = 22 + Math.floor(rnd() * 40); // 22..61
    var total = base + presence.length * 4;

    // Build a weighted area pool: home areas heavy, neighbouring areas a
    // deliberate non-trivial tail (the expansion signal).
    var pool = [];
    BOROUGH_AREAS.forEach(function (area) {
      var weight;
      if (presenceSet[area]) {
        weight = 6 + Math.floor(rnd() * 6); // 6..11 — strong home cluster
      } else {
        weight = 1 + Math.floor(rnd() * 5); // 1..5  — neighbouring demand
      }
      for (var w = 0; w < weight; w++) pool.push(area);
    });
    if (!pool.length) pool = BOROUGH_AREAS.slice();

    var list = [];
    for (var i = 0; i < total; i++) {
      var area = pool[Math.floor(rnd() * pool.length)];
      list.push({
        id: "syn_" + provider.id + "_" + i,
        area: area,
        optIn: rnd() < 0.62,        // express newsletter opt-in (anonymised count only)
        addedAt: null,
        synthetic: true
      });
    }
    return list;
  }

  /* ============================================================
   * Manual followers (Member-captured) — persisted via HC.store.
   * ============================================================ */
  function readManual(providerId) {
    var all;
    try { all = HC.store.get(FOLLOWERS_KEY, {}) || {}; } catch (e) { all = {}; }
    var list = all[providerId];
    return Array.isArray(list) ? list : [];
  }
  function writeManual(providerId, list) {
    var all;
    try { all = HC.store.get(FOLLOWERS_KEY, {}) || {}; } catch (e) { all = {}; }
    all[providerId] = Array.isArray(list) ? list : [];
    try { HC.store.set(FOLLOWERS_KEY, all); } catch (e) {}
    return all[providerId];
  }
  function addFollower(providerId, area, optIn) {
    if (!providerId) return null;
    var canonical = normaliseArea(area);
    if (!canonical) return null;
    var list = readManual(providerId);
    var rec = {
      id: "man_" + (HC.util && HC.util.uid ? HC.util.uid() : String(Date.now())),
      area: canonical,
      optIn: !!optIn,
      addedAt: new Date().toISOString(),
      synthetic: false
    };
    list.push(rec);
    writeManual(providerId, list);
    return rec;
  }
  // Map free-text to a canonical borough area (case/space-insensitive).
  function normaliseArea(area) {
    if (!area) return null;
    var key = String(area).trim().toLowerCase();
    for (var i = 0; i < BOROUGH_AREAS.length; i++) {
      if (BOROUGH_AREAS[i].toLowerCase() === key) return BOROUGH_AREAS[i];
    }
    return null; // outside the borough axis — ignored for clustering
  }

  /* Full follower set = deterministic base + manual captures. */
  function allFollowers(provider) {
    if (!provider) return [];
    return syntheticFollowers(provider).concat(readManual(provider.id));
  }

  /* ============================================================
   * Membership gate.
   * ============================================================ */
  function isMember(providerId) {
    var all;
    try { all = HC.store.get(MEMBER_KEY, {}) || {}; } catch (e) { all = {}; }
    return !!all[providerId];
  }
  function setMember(providerId, on) {
    var all;
    try { all = HC.store.get(MEMBER_KEY, {}) || {}; } catch (e) { all = {}; }
    if (on) all[providerId] = true; else delete all[providerId];
    try { HC.store.set(MEMBER_KEY, all); } catch (e) {}
    return !!all[providerId];
  }

  /* ============================================================
   * CORE LOGIC — the anonymised cluster analysis.
   *
   * clusterFollowers(followers) -> {
   *   total, optInCount,
   *   clusters: [ { area, count, share, optIn } ]  // sorted desc by count
   * }
   * Anonymised by construction: clusters expose AREA + COUNTS only.
   * ============================================================ */
  function clusterFollowers(followers) {
    var byArea = {};
    var optInByArea = {};
    var total = 0, optInTotal = 0;
    (followers || []).forEach(function (f) {
      if (!f) return;
      var area = normaliseArea(f.area) || f.area;
      if (!area) return;
      byArea[area] = (byArea[area] || 0) + 1;
      total += 1;
      if (f.optIn) { optInByArea[area] = (optInByArea[area] || 0) + 1; optInTotal += 1; }
    });
    var clusters = Object.keys(byArea).map(function (area) {
      var count = byArea[area];
      return {
        area: area,
        count: count,
        share: total ? count / total : 0,
        optIn: optInByArea[area] || 0
      };
    });
    clusters.sort(function (a, b) {
      if (b.count !== a.count) return b.count - a.count;
      return a.area < b.area ? -1 : 1; // stable tiebreak
    });
    return { total: total, optInCount: optInTotal, clusters: clusters };
  }

  /* expansionRecommendation(provider) — the headline "where to expand"
   * answer. The best target is the area with the MOST followers that the
   * provider does NOT already run camps in. Returns null if every area
   * with followers is already served (no untapped cluster). */
  function expansionRecommendation(provider) {
    var clustered = clusterFollowers(allFollowers(provider));
    var presence = presenceAreas(provider);
    var presenceSet = {};
    presence.forEach(function (a) { presenceSet[a] = true; });

    var untapped = clustered.clusters.filter(function (c) {
      return c.count > 0 && !presenceSet[c.area];
    });
    var best = untapped.length ? untapped[0] : null;
    return {
      total: clustered.total,
      presence: presence,
      clusters: clustered.clusters,
      untapped: untapped,
      recommendation: best // { area, count, share, optIn } or null
    };
  }

  /* ============================================================
   * RENDER — Member-gated dashboard with a heatmap, cluster table and
   * the expansion recommendation. Defensive throughout.
   * ============================================================ */
  function defaultProvider() {
    // Prefer a provider with several presence areas so the demo is rich.
    var ps = providers();
    var best = null;
    for (var i = 0; i < ps.length; i++) {
      var n = presenceAreas(ps[i]).length;
      if (!best || n > presenceAreas(best).length) best = ps[i];
    }
    return best || ps[0] || null;
  }

  function pct(x) { return Math.round((x || 0) * 100) + "%"; }
  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function render(mountEl) {
    try {
      if (!mountEl) return;
      var ps = providers();
      if (!ps.length) {
        mountEl.innerHTML = '<p style="color:var(--muted,#808080)">No provider data available.</p>';
        return;
      }
      var state = { providerId: (defaultProvider() || ps[0]).id };

      function draw() {
        var provider = findProvider(state.providerId) || ps[0];
        var member = isMember(provider.id);
        var analysis = expansionRecommendation(provider);
        var clusters = analysis.clusters;
        var maxCount = clusters.reduce(function (m, c) { return Math.max(m, c.count); }, 0) || 1;

        var opts = ps.map(function (p) {
          return '<option value="' + esc(p.id) + '"' +
            (p.id === provider.id ? " selected" : "") + ">" + esc(p.name) + "</option>";
        }).join("");

        var html = "";
        html +=
          '<p style="font-size:13.5px;color:var(--text,#383838);margin:0 0 12px">' +
          "When parents follow your camp for timetable alerts, their home area is recorded. " +
          "<strong>Members</strong> can see where those followers cluster — so you know which " +
          "areas to expand into next. Location data is <strong>anonymised</strong>: you see areas " +
          "and counts, never individual parents." +
          "</p>";

        // Provider picker + membership toggle.
        html +=
          '<div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin:0 0 14px">' +
            '<select data-fg-provider style="flex:1;min-width:220px;padding:8px 10px;border:1.5px solid var(--line,#E6E6E6);' +
              'border-radius:12px;font-family:inherit;font-size:13.5px">' + opts + "</select>" +
            '<label style="display:flex;align-items:center;gap:7px;font-size:13px;font-weight:700;' +
              'color:var(--purple,#603488);cursor:pointer;white-space:nowrap">' +
              '<input type="checkbox" data-fg-member' + (member ? " checked" : "") + "> Member account" +
            "</label>" +
          "</div>";

        // Headline count (visible to everyone).
        html +=
          '<div style="display:flex;gap:12px;flex-wrap:wrap;margin:0 0 14px">' +
            '<div style="background:var(--purple-tint,#F0E8F4);border-radius:14px;padding:12px 16px">' +
              '<div style="font-size:24px;font-weight:800;color:var(--purple,#603488);font-family:Quicksand,system-ui,sans-serif">' +
                analysis.total + "</div>" +
              '<div style="font-size:11px;text-transform:uppercase;letter-spacing:.4px;color:var(--muted,#808080)">Followers</div>' +
            "</div>" +
            '<div style="background:var(--purple-tint,#F0E8F4);border-radius:14px;padding:12px 16px">' +
              '<div style="font-size:24px;font-weight:800;color:var(--purple,#603488);font-family:Quicksand,system-ui,sans-serif">' +
                analysis.presence.length + "</div>" +
              '<div style="font-size:11px;text-transform:uppercase;letter-spacing:.4px;color:var(--muted,#808080)">Areas you run in</div>' +
            "</div>" +
          "</div>";

        if (!member) {
          // Locked state — non-members only see the headline count.
          html +=
            '<div style="border:1.5px dashed var(--line,#E6E6E6);border-radius:16px;padding:20px;text-align:center;' +
              'background:#fafafa">' +
              '<div style="font-size:30px">🔒</div>' +
              '<p style="font-weight:700;color:var(--purple,#603488);margin:6px 0 4px;font-family:Quicksand,system-ui,sans-serif">' +
                "Anonymised follower locations are a Member benefit</p>" +
              '<p style="font-size:13px;color:var(--text,#383838);margin:0 0 12px">' +
                "Upgrade to see which areas your followers cluster in and where to expand next." + "</p>" +
              '<button class="hc-btn" data-fg-upgrade>Unlock as a Member</button>' +
            "</div>";
          mountEl.innerHTML = html;
          wire(mountEl, draw, state);
          return;
        }

        // ---- Member view: expansion recommendation ----
        if (analysis.recommendation) {
          var r = analysis.recommendation;
          html +=
            '<div style="background:linear-gradient(135deg,#FCE8F0,#F0E8F4);border-radius:16px;padding:16px;margin:0 0 16px;' +
              'border:1.5px solid var(--purple-tint,#F0E8F4)">' +
              '<div style="font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:var(--magenta,#F82488);' +
                'font-weight:700;font-family:Quicksand,system-ui,sans-serif">📍 Expand here next</div>' +
              '<div style="font-size:21px;font-weight:800;color:var(--purple,#603488);margin:3px 0;' +
                'font-family:Quicksand,system-ui,sans-serif">' + esc(r.area) + "</div>" +
              '<p style="font-size:13px;color:var(--text,#383838);margin:0">' +
                "<strong>" + r.count + " followers</strong> (" + pct(r.share) + " of your following) live in " +
                esc(r.area) + ", but you don't run camps there yet. Your biggest untapped cluster." +
              "</p>" +
            "</div>";
        } else {
          html +=
            '<div style="background:#E1F0E4;border-radius:16px;padding:14px;margin:0 0 16px">' +
              '<p style="font-size:13px;color:#2f7d4f;margin:0;font-weight:700">' +
                "✓ You already run camps in every area your followers cluster in. Great coverage!" + "</p>" +
            "</div>";
        }

        // ---- Cluster table / heatmap (anonymised: area + counts only) ----
        html += '<div style="font-size:12px;text-transform:uppercase;letter-spacing:.5px;color:var(--magenta,#F82488);' +
          'font-weight:700;font-family:Quicksand,system-ui,sans-serif;margin:0 0 8px">Where your followers cluster</div>';
        html += '<div style="display:flex;flex-direction:column;gap:6px;margin:0 0 16px">';
        var presenceSet = {};
        analysis.presence.forEach(function (a) { presenceSet[a] = true; });
        clusters.forEach(function (c) {
          var here = presenceSet[c.area];
          var barW = Math.round((c.count / maxCount) * 100);
          html +=
            '<div style="display:flex;align-items:center;gap:10px">' +
              '<div style="flex:0 0 120px;font-size:13px;font-weight:700;color:var(--text,#383838)">' +
                esc(c.area) +
                (here
                  ? ' <span style="font-size:10px;color:#2f7d4f">● running</span>'
                  : ' <span style="font-size:10px;color:var(--magenta,#F82488)">○ no camp</span>') +
              "</div>" +
              '<div style="flex:1;background:#f0f0f0;border-radius:8px;height:18px;overflow:hidden">' +
                '<div style="height:100%;width:' + barW + '%;border-radius:8px;background:' +
                  (here ? "var(--purple,#603488)" : "var(--magenta,#F82488)") + '"></div>' +
              "</div>" +
              '<div style="flex:0 0 76px;text-align:right;font-size:12.5px;color:var(--muted,#808080)">' +
                c.count + " · " + pct(c.share) + "</div>" +
            "</div>";
        });
        html += "</div>";

        // ---- Anonymity note + opt-in export count ----
        html +=
          '<p style="font-size:11.5px;color:var(--muted,#808080);margin:0 0 16px">' +
            "🔐 Anonymised view — area totals only. " + analysis.total + " followers, " +
            "of whom " + clusterFollowers(allFollowers(provider)).optInCount +
            " opted in to your newsletter (exportable with a Privacy Policy in place)." +
          "</p>";

        // ---- Add a follower (Member capture) ----
        var areaOpts = BOROUGH_AREAS.map(function (a) {
          return '<option value="' + esc(a) + '">' + esc(a) + "</option>";
        }).join("");
        html +=
          '<div style="border-top:1px solid var(--line,#E6E6E6);padding-top:14px">' +
            '<div style="font-size:12px;font-weight:700;color:var(--purple,#603488);margin:0 0 8px;' +
              'font-family:Quicksand,system-ui,sans-serif">Log a new follower’s area</div>' +
            '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">' +
              '<select data-fg-newarea style="padding:8px 10px;border:1.5px solid var(--line,#E6E6E6);' +
                'border-radius:12px;font-family:inherit;font-size:13px">' + areaOpts + "</select>" +
              '<label style="display:flex;align-items:center;gap:6px;font-size:12.5px;color:var(--text,#383838)">' +
                '<input type="checkbox" data-fg-newoptin checked> Newsletter opt-in</label>' +
              '<button class="hc-btn" data-fg-add>Add follower</button>' +
            "</div>" +
          "</div>";

        mountEl.innerHTML = html;
        wire(mountEl, draw, state);
      }

      draw();
    } catch (e) {
      try {
        mountEl.innerHTML = '<p style="color:#9a1f5e">Follower-geo failed to render: ' +
          esc(e && e.message ? e.message : String(e)) + "</p>";
      } catch (e2) { /* give up quietly */ }
    }
  }

  function wire(mountEl, draw, state) {
    try {
      var sel = mountEl.querySelector("[data-fg-provider]");
      if (sel) sel.addEventListener("change", function () { state.providerId = sel.value; draw(); });

      var memberBox = mountEl.querySelector("[data-fg-member]");
      if (memberBox) memberBox.addEventListener("change", function () {
        setMember(state.providerId, memberBox.checked);
        draw();
      });

      var upgrade = mountEl.querySelector("[data-fg-upgrade]");
      if (upgrade) upgrade.addEventListener("click", function () {
        setMember(state.providerId, true);
        if (HC.util && HC.util.toast) HC.util.toast("Member benefits unlocked");
        draw();
      });

      var addBtn = mountEl.querySelector("[data-fg-add]");
      if (addBtn) addBtn.addEventListener("click", function () {
        var areaSel = mountEl.querySelector("[data-fg-newarea]");
        var optBox = mountEl.querySelector("[data-fg-newoptin]");
        var area = areaSel ? areaSel.value : null;
        var rec = addFollower(state.providerId, area, optBox ? optBox.checked : false);
        if (rec && HC.util && HC.util.toast) HC.util.toast("Follower in " + rec.area + " logged");
        draw();
      });
    } catch (e) { /* defensive: wiring must never throw */ }
  }

  /* ============================================================
   * SELF-TEST — exercises the cluster LOGIC and asserts the acceptance
   * criterion: Members see where followers cluster to decide expansion
   * areas. Multiple cases. Uses HC.assert. Cleans up its own store keys.
   * ============================================================ */
  function selfTest() {
    var pass = 0, fail = 0, log = [];
    function check(label, fn) {
      try { fn(); pass++; log.push("✓ " + label); }
      catch (e) { fail++; log.push("✗ " + label + " — " + (e && e.message ? e.message : String(e))); }
    }

    // Snapshot + clear our store keys so the test is hermetic.
    var savedMembers, savedManual;
    try { savedMembers = HC.store.get(MEMBER_KEY, {}); } catch (e) { savedMembers = {}; }
    try { savedManual = HC.store.get(FOLLOWERS_KEY, {}); } catch (e) { savedManual = {}; }
    try { HC.store.set(MEMBER_KEY, {}); } catch (e) {}
    try { HC.store.set(FOLLOWERS_KEY, {}); } catch (e) {}

    try {
      // 1. clusterFollowers aggregates a hand-built set correctly.
      check("clusters: counts + shares aggregate correctly", function () {
        var fs = [
          { area: "Leyton", optIn: true },
          { area: "Leyton", optIn: false },
          { area: "Leyton", optIn: true },
          { area: "Chingford", optIn: true },
          { area: "Walthamstow", optIn: false }
        ];
        var c = clusterFollowers(fs);
        HC.assert(c.total === 5, "total should be 5, got " + c.total);
        HC.assert(c.clusters[0].area === "Leyton", "top cluster should be Leyton, got " + c.clusters[0].area);
        HC.assert(c.clusters[0].count === 3, "Leyton count should be 3, got " + c.clusters[0].count);
        HC.assert(Math.abs(c.clusters[0].share - 0.6) < 1e-9, "Leyton share should be 0.6, got " + c.clusters[0].share);
        HC.assert(c.optInCount === 3, "opt-in total should be 3, got " + c.optInCount);
      });

      // 2. Clusters are sorted descending by count (so #1 is the biggest cluster).
      check("clusters: sorted descending by count", function () {
        var fs = [
          { area: "Woodford", optIn: false },
          { area: "Chingford", optIn: false }, { area: "Chingford", optIn: false },
          { area: "Leyton", optIn: false }, { area: "Leyton", optIn: false }, { area: "Leyton", optIn: false }
        ];
        var c = clusterFollowers(fs);
        for (var i = 1; i < c.clusters.length; i++) {
          HC.assert(c.clusters[i - 1].count >= c.clusters[i].count,
            "cluster " + (i - 1) + " should be >= cluster " + i);
        }
        HC.assert(c.clusters[0].area === "Leyton", "biggest cluster should be Leyton");
      });

      // 3. ANONYMITY: cluster output exposes area + counts only — never a
      //    follower's identity (no email/name leaks through the analysis).
      check("anonymised: clusters expose no follower identity", function () {
        var fs = [
          { id: "p1", area: "Leyton", email: "alice@example.com", name: "Alice", optIn: true },
          { id: "p2", area: "Leyton", email: "bob@example.com", name: "Bob", optIn: false }
        ];
        var c = clusterFollowers(fs);
        var keys = Object.keys(c.clusters[0]).sort().join(",");
        HC.assert(keys === "area,count,optIn,share", "cluster keys should be area,count,optIn,share — got " + keys);
        var serialised = JSON.stringify(c);
        HC.assert(serialised.indexOf("@example.com") === -1, "email must not leak into cluster data");
        HC.assert(serialised.indexOf("Alice") === -1 && serialised.indexOf("Bob") === -1,
          "names must not leak into cluster data");
      });

      // 4. ACCEPTANCE CRITERION — expansion recommendation targets the
      //    biggest cluster the provider does NOT already run camps in.
      check("acceptance: recommends biggest untapped follower cluster", function () {
        var fakeProvider = { id: "__test_expand__", areas: ["Walthamstow"] };
        // Synthetic base for a synthetic id is empty (id not in real data path);
        // drive purely from manual followers so the case is fully controlled.
        writeManual(fakeProvider.id, [
          { area: "Walthamstow", optIn: true },  // already served — must NOT be the rec
          { area: "Walthamstow", optIn: true },
          { area: "Walthamstow", optIn: true },
          { area: "Chingford", optIn: true },    // untapped, 3 followers — the winner
          { area: "Chingford", optIn: false },
          { area: "Chingford", optIn: true },
          { area: "Leyton", optIn: false }       // untapped, 1 follower — runner-up
        ]);
        var analysis = expansionRecommendation(fakeProvider);
        HC.assert(analysis.recommendation, "an expansion area should be recommended");
        HC.assert(analysis.recommendation.area === "Chingford",
          "should recommend Chingford (biggest untapped), got " + analysis.recommendation.area);
        HC.assert(analysis.recommendation.count === 3,
          "Chingford should have 3 followers, got " + analysis.recommendation.count);
        // Walthamstow is the absolute biggest cluster but is already served,
        // so it must be excluded from the expansion recommendation.
        HC.assert(analysis.recommendation.area !== "Walthamstow",
          "must not recommend an area already served");
        writeManual(fakeProvider.id, []); // cleanup
      });

      // 5. No recommendation when every follower area is already served.
      check("acceptance: no rec when all clusters already covered", function () {
        var fakeProvider = { id: "__test_covered__", areas: ["Leyton", "Chingford"] };
        writeManual(fakeProvider.id, [
          { area: "Leyton", optIn: true },
          { area: "Chingford", optIn: false },
          { area: "Leyton", optIn: true }
        ]);
        var analysis = expansionRecommendation(fakeProvider);
        HC.assert(analysis.recommendation === null,
          "should be no expansion rec when all follower areas are served");
        HC.assert(analysis.untapped.length === 0, "untapped list should be empty");
        writeManual(fakeProvider.id, []);
      });

      // 6. Membership gate persists and reads back via HC.store.
      check("membership gate persists via HC.store", function () {
        var pid = "__test_member__";
        HC.assert(isMember(pid) === false, "should start as non-member");
        setMember(pid, true);
        HC.assert(isMember(pid) === true, "should be a member after upgrade");
        setMember(pid, false);
        HC.assert(isMember(pid) === false, "should revert to non-member");
      });

      // 7. addFollower normalises area + persists; out-of-borough is ignored.
      check("addFollower normalises area and rejects out-of-borough", function () {
        var pid = "__test_add__";
        writeManual(pid, []);
        var ok = addFollower(pid, "  chingford ", true); // messy casing/space
        HC.assert(ok && ok.area === "Chingford", "should normalise to 'Chingford', got " + (ok && ok.area));
        var bad = addFollower(pid, "Brighton", true);     // outside the borough
        HC.assert(bad === null, "out-of-borough follower should be rejected");
        HC.assert(readManual(pid).length === 1, "only the valid follower should persist");
        writeManual(pid, []);
      });

      // 8. Real provider end-to-end: a genuine camp yields a cluster table
      //    AND a usable expansion signal (the live "where to expand" view).
      check("real provider yields clusters + expansion signal", function () {
        var ps = providers();
        HC.assert(ps.length > 0, "expected live providers from camps.js");
        var p = defaultProvider();
        HC.assert(p, "a default provider should be selectable");
        var analysis = expansionRecommendation(p);
        HC.assert(analysis.total > 0, "provider should have followers, got " + analysis.total);
        HC.assert(analysis.clusters.length >= 2,
          "followers should span >=2 areas to be a meaningful cluster view, got " + analysis.clusters.length);
        // Shares across clusters sum to ~1 (every follower counted once).
        var sum = analysis.clusters.reduce(function (s, c) { return s + c.share; }, 0);
        HC.assert(Math.abs(sum - 1) < 1e-6, "cluster shares should sum to 1, got " + sum);
        // The recommendation (if any) must be an untapped area, not a served one.
        if (analysis.recommendation) {
          HC.assert(analysis.presence.indexOf(analysis.recommendation.area) === -1,
            "recommended area must not already be served");
        }
      });

      // 9. Determinism — same provider, same synthetic followers across calls.
      check("synthetic followers are deterministic across calls", function () {
        var p = defaultProvider();
        var a = syntheticFollowers(p);
        var b = syntheticFollowers(p);
        HC.assert(a.length === b.length, "follower count should be stable, " + a.length + " vs " + b.length);
        var ca = clusterFollowers(a), cb = clusterFollowers(b);
        HC.assert(ca.clusters[0].area === cb.clusters[0].area, "top cluster should be stable across calls");
        HC.assert(ca.clusters[0].count === cb.clusters[0].count, "top cluster count should be stable");
      });

    } finally {
      // Restore caller's real store state — never leave test residue.
      try { HC.store.set(MEMBER_KEY, savedMembers || {}); } catch (e) {}
      try { HC.store.set(FOLLOWERS_KEY, savedManual || {}); } catch (e) {}
    }

    return { pass: pass, fail: fail, log: log };
  }

  /* ============================================================
   * Register.
   * ============================================================ */
  HC.registerFeature({
    id: "provider-follower-geo",
    title: "Follower location insights",
    side: "provider",
    icon: "📍",
    summary: "Members see anonymised follower locations — which areas parents cluster in — to decide where to expand camps next.",
    render: render,
    selfTest: selfTest
  });
})();
