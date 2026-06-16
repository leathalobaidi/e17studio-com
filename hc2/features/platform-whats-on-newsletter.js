/* HolidayCamp feature: platform-whats-on-newsletter
 * ------------------------------------------------------------------
 * Replicates Happity's "What's On" newsletter ENGINE for the PLATFORM
 * side, reframed for SCHOOL-AGE HOLIDAY CAMPS (day / week places), not
 * baby classes.
 *
 * Evidence (support corpus):
 *  - Article 6081998 "What is the What's On newsletter, and how can my
 *    classes be included?":
 *      "Every Sunday, we send out our much loved What's On newsletter
 *       to over 140k parents ... showing recommended classes and
 *       activities for the week ahead."
 *      "The newsletter chooses relevant classes for each
 *       mum/dad/caregiver, completely tailored to their preferences
 *       (e.g. location, age of their little one, days of the week they
 *       are free, etc)"
 *      "Classes must be recently verified, with dates listed, to
 *       appear."
 *      "The What's On is available to all Happity Members."
 *      Eligibility = Member + upcoming dates on listings + verified at
 *       least every 12 weeks (Verify All) + (optional) bookings on,
 *       which increases the number of newsletters you appear in.
 *  - Brief evidence pointers: 6081998; 04-seo §4.1.
 *
 *  The PARENT side (preferences capture / unsubscribe) lives in
 *  parent-whats-on-newsletter.js. THIS module is the platform-owned
 *  assembly ENGINE: given a roster of subscribers, it builds the weekly
 *  digest for each one, applying both the personalisation rules
 *  (area x age x free days) AND the supply-side eligibility gate
 *  (verified <= 12wk + dated + Member). It is purely derived from the
 *  live, verified camps.js directory (never mutated).
 *
 * Acceptance criterion (asserted by selfTest, multiple cases):
 *   A WEEKLY DIGEST IS ASSEMBLED PER SUBSCRIBER BY AREA + AGE + FREE
 *   DAYS; ONLY VERIFIED, DATED, MEMBER CAMPS APPEAR.
 *   -> Every camp in any digest passes the eligibility gate
 *      (isMember === true && verifiedWithin12wk === true && dated === true).
 *   -> A non-Member / stale / undated camp NEVER appears, even if it is
 *      a perfect area+age+day match.
 *   -> The digest only contains camps in the subscriber's area, within
 *      the child's age band, on at least one free day.
 *   -> Two subscribers with different preferences get different digests.
 *
 * Scope note: PLATFORM side. No real email is sent and no real backend
 * exists. Eligibility signals (Member status, last-verified date) are
 * not present in the verified camps.js, so they are synthesised
 * DETERMINISTICALLY from the camp id (stable across runs) — this models
 * the platform fields a provider would set, without inventing facts
 * about real businesses. The "dated" signal is taken from the real
 * planner (confirmed week dates). Persistence (the editable weekly send
 * config) is via HC.store only. Fully defensive: nothing throws at
 * registration time.
 * ------------------------------------------------------------------ */
(function () {
  "use strict";

  if (typeof window === "undefined" || !window.HC || typeof window.HC.registerFeature !== "function") {
    // Core not present — fail silently rather than throwing.
    return;
  }
  var HC = window.HC;

  var STORE_KEY = "platform_whatson_config"; // editable send config (cap per digest, require bookings, etc.)
  var VERIFY_WINDOW_WEEKS = 12;              // Happity rule: verify at least every 12 weeks
  var MS_PER_WEEK = 7 * 24 * 60 * 60 * 1000;

  /* ============================================================
   * 0. Defensive data access
   * ========================================================== */
  function providers() {
    try {
      var p = HC.data && HC.data.providers;
      return Array.isArray(p) ? p : [];
    } catch (e) { return []; }
  }
  function plannerById() {
    try {
      var pl = HC.data && HC.data.planner;
      return (pl && pl.byId) ? pl.byId : {};
    } catch (e) { return {}; }
  }

  /* ============================================================
   * 1. Deterministic synthetic enrichment.
   *    camps.js has no Member / last-verified fields (it is a verified
   *    directory of real businesses), so we derive them from the camp
   *    id with a small stable hash. Same id -> same values every run,
   *    which keeps selfTest deterministic. This models the platform
   *    columns a provider controls, NOT a claim about any real camp.
   * ========================================================== */
  function hashStr(s) {
    var h = 2166136261;
    s = String(s == null ? "" : s);
    for (var i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = (h * 16777619) >>> 0;
    }
    return h >>> 0;
  }

  // Synthetic Member status: ~75% of the directory are Members.
  function isMember(p) {
    if (!p || !p.id) return false;
    return (hashStr("member:" + p.id) % 100) < 75;
  }

  // Synthetic last-verified age, in weeks (0..23). Anything <= 12 weeks
  // counts as "recently verified" per the 12-week rule.
  function verifiedWeeksAgo(p) {
    if (!p || !p.id) return 99;
    return hashStr("verify:" + p.id) % 24; // 0..23 weeks
  }
  function verifiedWithinWindow(p, nowMs) {
    var wk = verifiedWeeksAgo(p);
    if (wk > VERIFY_WINDOW_WEEKS) return false;
    // Cross-check via a real timestamp so the rule is exercised as a date,
    // not just an integer compare.
    var verifiedAt = (nowMs || Date.now()) - wk * MS_PER_WEEK;
    var ageWeeks = ((nowMs || Date.now()) - verifiedAt) / MS_PER_WEEK;
    return ageWeeks <= VERIFY_WINDOW_WEEKS + 1e-9;
  }

  // "Dates listed": the real planner has CONFIRMED week dates for this
  // camp. weeksLikely (summer runs, weeks unconfirmed) is NOT enough —
  // Happity requires actual dates on the listing.
  function datedWeeks(p) {
    if (!p || !p.id) return [];
    var entry = plannerById()[p.id];
    if (entry && Array.isArray(entry.weeks) && entry.weeks.length) {
      return entry.weeks.slice();
    }
    return [];
  }
  function isDated(p) {
    return datedWeeks(p).length > 0;
  }

  // Optional "bookings on" — increases how many newsletters you appear
  // in. ~55% of Members have it on. Used only for ranking + the optional
  // requireBookings config; never relaxes the core gate.
  function bookingsOn(p) {
    if (!p || !p.id) return false;
    return (hashStr("book:" + p.id) % 100) < 55;
  }

  /* ============================================================
   * 2. The eligibility GATE (supply side).
   *    A camp is eligible for the What's On iff it is a Member, was
   *    verified within the last 12 weeks, and has dates listed.
   *    (requireBookings is an optional config that further narrows it.)
   * ========================================================== */
  function gateReasons(p, cfg, nowMs) {
    var reasons = [];
    if (!isMember(p)) reasons.push("not a Member");
    if (!verifiedWithinWindow(p, nowMs)) reasons.push("not verified in last 12 weeks");
    if (!isDated(p)) reasons.push("no dates listed");
    if (cfg && cfg.requireBookings && !bookingsOn(p)) reasons.push("bookings off");
    return reasons;
  }
  function isEligible(p, cfg, nowMs) {
    return gateReasons(p, cfg, nowMs).length === 0;
  }
  function eligibleCamps(cfg, nowMs) {
    return providers().filter(function (p) { return isEligible(p, cfg, nowMs); });
  }

  /* ============================================================
   * 3. Personalisation match (demand side): area + age + free days.
   * ========================================================== */
  // Days a camp runs. We don't have per-camp weekday data, so a camp on
  // a confirmed planner week is treated as running the standard Mon–Fri
  // holiday-camp week. (Holiday camps are weekday daytime by nature.)
  var WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri"];
  function campRunDays(p) {
    return isDated(p) ? WEEKDAYS.slice() : [];
  }

  function areaMatch(p, area) {
    if (!area) return true; // subscriber with no area set = whole borough
    var list = (p && Array.isArray(p.areas)) ? p.areas : [];
    if (p && p.area && list.indexOf(p.area) === -1) {
      // include the headline area string too
    }
    var hay = list.slice();
    if (p && p.area) hay.push(p.area);
    area = String(area).toLowerCase();
    // Borough-wide / council routes match any area.
    for (var i = 0; i < hay.length; i++) {
      var a = String(hay[i]).toLowerCase();
      if (a === area) return true;
      if (a.indexOf("borough") !== -1) return true;
    }
    return false;
  }

  function ageMatch(p, childAge) {
    if (childAge == null) return true;
    var lo = Number(p && p.ageMin);
    var hi = Number(p && p.ageMax);
    if (!isFinite(lo)) lo = 0;
    if (!isFinite(hi)) hi = 99;
    return childAge >= lo && childAge <= hi;
  }

  function dayMatch(p, freeDays) {
    if (!Array.isArray(freeDays) || !freeDays.length) return true; // no constraint
    var runs = campRunDays(p);
    for (var i = 0; i < freeDays.length; i++) {
      if (runs.indexOf(freeDays[i]) !== -1) return true;
    }
    return false;
  }

  function matchesSubscriber(p, sub) {
    return areaMatch(p, sub && sub.area) &&
           ageMatch(p, sub && sub.childAge) &&
           dayMatch(p, sub && sub.freeDays);
  }

  /* ============================================================
   * 4. Assemble one subscriber's weekly digest.
   *    GATE FIRST (only verified+dated+Member), THEN personalise,
   *    THEN rank + cap. Returns a structured digest object.
   * ========================================================== */
  function defaultConfig() {
    return {
      cap: 6,               // max camps per digest (a tidy email)
      requireBookings: false,
      sendDay: "Sunday"     // Happity sends Sunday nights
    };
  }
  function getConfig() {
    var cfg = HC.store ? HC.store.get(STORE_KEY, null) : null;
    var d = defaultConfig();
    if (!cfg || typeof cfg !== "object") return d;
    return {
      cap: (isFinite(Number(cfg.cap)) && Number(cfg.cap) > 0) ? Math.floor(Number(cfg.cap)) : d.cap,
      requireBookings: !!cfg.requireBookings,
      sendDay: cfg.sendDay || d.sendDay
    };
  }
  function setConfig(patch) {
    var next = getConfig();
    if (patch && typeof patch === "object") {
      for (var k in patch) {
        if (Object.prototype.hasOwnProperty.call(patch, k)) next[k] = patch[k];
      }
    }
    if (HC.store) HC.store.set(STORE_KEY, next);
    return next;
  }

  // Rank: bookings-on first (Happity: bookings increase appearances),
  // then more confirmed weeks, then most recently verified, then name.
  function rankScore(p) {
    var s = 0;
    if (bookingsOn(p)) s += 1000;
    s += datedWeeks(p).length * 50;
    s += (VERIFY_WINDOW_WEEKS - verifiedWeeksAgo(p)) * 5;
    return s;
  }

  function assembleDigest(sub, cfg, nowMs) {
    cfg = cfg || getConfig();
    nowMs = nowMs || Date.now();

    var gated = eligibleCamps(cfg, nowMs);                 // verified + dated + Member
    var matched = gated.filter(function (p) { return matchesSubscriber(p, sub); });

    matched.sort(function (a, b) {
      var d = rankScore(b) - rankScore(a);
      if (d !== 0) return d;
      return String(a.name).localeCompare(String(b.name));
    });

    var picks = matched.slice(0, cfg.cap);
    return {
      subscriber: sub,
      sendDay: cfg.sendDay,
      eligiblePool: gated.length,
      matchedCount: matched.length,
      camps: picks.map(function (p) {
        return {
          id: p.id,
          name: p.name,
          area: p.area,
          ageLabel: p.ageLabel,
          weeks: datedWeeks(p),
          bookings: bookingsOn(p),
          verifiedWeeksAgo: verifiedWeeksAgo(p)
        };
      })
    };
  }

  function assembleAll(roster, cfg, nowMs) {
    cfg = cfg || getConfig();
    nowMs = nowMs || Date.now();
    return (Array.isArray(roster) ? roster : []).map(function (sub) {
      return assembleDigest(sub, cfg, nowMs);
    });
  }

  /* ============================================================
   * 5. Demo roster (subscribers). Frame: parents of school-age kids.
   * ========================================================== */
  function demoRoster() {
    return [
      { id: "sub-a", name: "Aisha (Walthamstow)", area: "Walthamstow", childAge: 7, freeDays: ["Mon", "Tue", "Wed", "Thu", "Fri"] },
      { id: "sub-b", name: "Ben (Chingford)",     area: "Chingford",   childAge: 9, freeDays: ["Mon", "Wed", "Fri"] },
      { id: "sub-c", name: "Priya (Leyton)",      area: "Leyton",      childAge: 5, freeDays: ["Tue", "Thu"] },
      { id: "sub-d", name: "Tom (Leytonstone)",   area: "Leytonstone", childAge: 12, freeDays: ["Mon", "Tue", "Wed", "Thu", "Fri"] }
    ];
  }

  /* ============================================================
   * 6. UI — render(mountEl): a platform operator view of the engine.
   * ========================================================== */
  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function render(mountEl) {
    if (!mountEl) return;
    try {
      var cfg = getConfig();
      var roster = demoRoster();
      var nowMs = Date.now();

      var all = providers().length;
      var gated = eligibleCamps(cfg, nowMs);

      var wrap = HC.util.el("div", { class: "hc-whatson" });

      var intro =
        '<p style="font-size:14px;color:var(--text,#383838);line-height:1.6;margin:0 0 14px">' +
        "The <strong>What's On engine</strong> builds a personalised weekly digest for every subscriber " +
        "(sent " + esc(cfg.sendDay) + " night), tailored by <strong>area + age + free days</strong>. " +
        "Only camps that pass the supply gate appear: <strong>Member</strong>, " +
        "<strong>verified within " + VERIFY_WINDOW_WEEKS + " weeks</strong>, and with <strong>dates listed</strong>." +
        "</p>";

      var poolBar =
        '<div style="display:flex;gap:10px;flex-wrap:wrap;margin:0 0 16px">' +
          pill("Directory", all) +
          pill("Eligible (gated)", gated.length, true) +
          pill("Filtered out", all - gated.length) +
        "</div>";

      // Config controls
      var controls =
        '<div style="background:var(--purple-tint,#F0E8F4);border-radius:14px;padding:12px 14px;margin:0 0 18px;font-size:13px">' +
          '<label style="display:inline-flex;align-items:center;gap:7px;margin-right:18px;cursor:pointer">' +
            '<input type="checkbox" data-whatson-bookings ' + (cfg.requireBookings ? "checked" : "") + '> ' +
            "Only camps with bookings switched on" +
          "</label>" +
          '<label style="display:inline-flex;align-items:center;gap:7px">Camps per digest ' +
            '<input type="number" min="1" max="12" value="' + cfg.cap + '" data-whatson-cap ' +
            'style="width:54px;padding:3px 6px;border:1px solid var(--line,#E6E6E6);border-radius:8px"></label>' +
        "</div>";

      wrap.innerHTML = intro + poolBar + controls;

      var digests = HC.util.el("div", { "data-whatson-digests": "1" });
      digests.innerHTML = renderDigests(roster, cfg, nowMs);
      wrap.appendChild(digests);

      mountEl.innerHTML = "";
      mountEl.appendChild(wrap);

      // Wire controls (defensive)
      var bk = wrap.querySelector("[data-whatson-bookings]");
      var cap = wrap.querySelector("[data-whatson-cap]");
      function refresh() {
        var nc = setConfig({
          requireBookings: bk ? !!bk.checked : cfg.requireBookings,
          cap: cap ? Number(cap.value) : cfg.cap
        });
        var pool = eligibleCamps(nc, Date.now());
        var bars = wrap.querySelectorAll("[data-whatson-pillval]");
        if (bars[1]) bars[1].textContent = String(pool.length);
        if (bars[2]) bars[2].textContent = String(all - pool.length);
        digests.innerHTML = renderDigests(roster, nc, Date.now());
        if (HC.util.toast) HC.util.toast("Rebuilt " + roster.length + " digests");
      }
      if (bk) bk.addEventListener("change", refresh);
      if (cap) cap.addEventListener("change", refresh);
    } catch (e) {
      mountEl.innerHTML = '<p style="color:#9a1f5e">What\'s On engine failed to render: ' +
        esc(e && e.message ? e.message : String(e)) + "</p>";
    }
  }

  function pill(label, n, hot) {
    return '<span style="font-family:Quicksand,system-ui,sans-serif;font-weight:700;font-size:13px;' +
      "padding:7px 13px;border-radius:12px;background:" +
      (hot ? "#E1F0E4;color:#2f7d4f" : "var(--purple-tint,#F0E8F4);color:var(--purple,#603488)") + '">' +
      esc(label) + ": <span data-whatson-pillval>" + esc(n) + "</span></span>";
  }

  function renderDigests(roster, cfg, nowMs) {
    var out = "";
    for (var i = 0; i < roster.length; i++) {
      var d = assembleDigest(roster[i], cfg, nowMs);
      var days = (roster[i].freeDays || []).join(", ") || "any day";
      out +=
        '<div style="border:1.5px solid var(--line,#E6E6E6);border-radius:16px;padding:14px 16px;margin:0 0 14px">' +
          '<div style="font-family:Quicksand,system-ui,sans-serif;font-weight:700;color:var(--purple,#603488);font-size:16px">' +
            esc(roster[i].name) + "</div>" +
          '<div style="font-size:12px;color:var(--muted,#808080);margin:2px 0 10px">' +
            "Age " + esc(roster[i].childAge) + " · free " + esc(days) + " · " +
            esc(d.matchedCount) + " match" + (d.matchedCount === 1 ? "" : "es") +
            " from " + esc(d.eligiblePool) + " eligible camps" +
          "</div>";
      if (!d.camps.length) {
        out += '<div style="font-size:13px;color:var(--muted,#808080);font-style:italic">' +
          "No eligible camps this week — nothing sent (we never send an empty digest)." + "</div>";
      } else {
        out += '<ul style="list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:8px">';
        for (var c = 0; c < d.camps.length; c++) {
          var cp = d.camps[c];
          out += '<li style="display:flex;align-items:center;gap:10px;font-size:13.5px">' +
            '<span style="flex:1"><strong>' + esc(cp.name) + "</strong>" +
              '<span style="color:var(--muted,#808080)"> · ' + esc(cp.area || "") +
              " · ages " + esc(cp.ageLabel || "") + " · " + cp.weeks.length + " wk" +
              (cp.weeks.length === 1 ? "" : "s") + " dated</span></span>" +
            (cp.bookings
              ? '<span style="font-size:10.5px;font-weight:700;background:#FCD400;color:#1A1A1A;padding:2px 8px;border-radius:999px">BOOK NOW</span>'
              : "") +
            "</li>";
        }
        out += "</ul>";
      }
      out += "</div>";
    }
    return out;
  }

  /* ============================================================
   * 7. selfTest — exercises the ENGINE logic and asserts the
   *    acceptance criterion across multiple cases.
   * ========================================================== */
  function selfTest() {
    var pass = 0, fail = 0, log = [];
    function check(label, fn) {
      try { fn(); pass += 1; log.push("✓ " + label); }
      catch (e) { fail += 1; log.push("✗ " + label + " — " + (e && e.message ? e.message : String(e))); }
    }

    var nowMs = Date.now();
    var baseCfg = defaultConfig();
    var roster = demoRoster();

    // --- Gate primitives ---
    check("Eligible pool is non-empty and a strict subset of the directory", function () {
      var all = providers();
      var pool = eligibleCamps(baseCfg, nowMs);
      HC.assert(all.length > 0, "directory should have providers");
      HC.assert(pool.length > 0, "expected at least one eligible camp, got 0");
      HC.assert(pool.length < all.length, "gate should filter SOMETHING out (pool " + pool.length + " of " + all.length + ")");
    });

    check("Every eligible camp is Member + verified<=12wk + dated", function () {
      var pool = eligibleCamps(baseCfg, nowMs);
      for (var i = 0; i < pool.length; i++) {
        var p = pool[i];
        HC.assert(isMember(p), p.id + " in pool but not a Member");
        HC.assert(verifiedWithinWindow(p, nowMs), p.id + " in pool but verified > 12 weeks ago");
        HC.assert(isDated(p), p.id + " in pool but has no dates listed");
      }
    });

    check("A non-Member camp is excluded even when it would otherwise qualify", function () {
      // Find a camp that is verified+dated but NOT a member.
      var victim = providers().filter(function (p) {
        return !isMember(p) && verifiedWithinWindow(p, nowMs) && isDated(p);
      })[0];
      HC.assert(victim, "test needs a verified+dated non-Member camp in the data");
      var reasons = gateReasons(victim, baseCfg, nowMs);
      HC.assert(reasons.indexOf("not a Member") !== -1, "expected 'not a Member' gate reason");
      HC.assert(!isEligible(victim, baseCfg, nowMs), victim.id + " should be ineligible (non-Member)");
      // And it must not appear in ANY subscriber's digest.
      var all = assembleAll(roster, baseCfg, nowMs);
      var appeared = all.some(function (d) { return d.camps.some(function (c) { return c.id === victim.id; }); });
      HC.assert(!appeared, "non-Member " + victim.id + " leaked into a digest");
    });

    check("A stale (verified >12wk) camp is excluded", function () {
      var victim = providers().filter(function (p) {
        return isMember(p) && !verifiedWithinWindow(p, nowMs) && isDated(p);
      })[0];
      HC.assert(victim, "test needs a Member+dated but stale camp in the data");
      HC.assert(!isEligible(victim, baseCfg, nowMs), victim.id + " should be ineligible (stale)");
      var all = assembleAll(roster, baseCfg, nowMs);
      var appeared = all.some(function (d) { return d.camps.some(function (c) { return c.id === victim.id; }); });
      HC.assert(!appeared, "stale " + victim.id + " leaked into a digest");
    });

    check("An undated camp (weeksLikely only / no weeks) is excluded", function () {
      var victim = providers().filter(function (p) {
        return isMember(p) && verifiedWithinWindow(p, nowMs) && !isDated(p);
      })[0];
      HC.assert(victim, "test needs a Member+verified but undated camp in the data");
      HC.assert(!isEligible(victim, baseCfg, nowMs), victim.id + " should be ineligible (undated)");
      var all = assembleAll(roster, baseCfg, nowMs);
      var appeared = all.some(function (d) { return d.camps.some(function (c) { return c.id === victim.id; }); });
      HC.assert(!appeared, "undated " + victim.id + " leaked into a digest");
    });

    // --- ACCEPTANCE CRITERION: per-subscriber digest by area+age+free days;
    //     only verified, dated, Member camps appear. ---
    check("ACCEPTANCE: per-subscriber digest, only verified+dated+Member camps", function () {
      var all = assembleAll(roster, baseCfg, nowMs);
      HC.assert(all.length === roster.length, "one digest per subscriber");
      var byId = {};
      providers().forEach(function (p) { byId[p.id] = p; });
      for (var i = 0; i < all.length; i++) {
        var d = all[i];
        var sub = roster[i];
        HC.assert(d.subscriber && d.subscriber.id === sub.id, "digest must name its subscriber");
        HC.assert(d.camps.length <= baseCfg.cap, "digest must respect the cap");
        for (var c = 0; c < d.camps.length; c++) {
          var p = byId[d.camps[c].id];
          HC.assert(p, "digest camp must exist in directory");
          // Supply gate
          HC.assert(isMember(p), sub.id + ": non-Member camp " + p.id + " appeared");
          HC.assert(verifiedWithinWindow(p, nowMs), sub.id + ": stale camp " + p.id + " appeared");
          HC.assert(isDated(p), sub.id + ": undated camp " + p.id + " appeared");
          // Demand match
          HC.assert(areaMatch(p, sub.area), sub.id + ": out-of-area camp " + p.id + " appeared");
          HC.assert(ageMatch(p, sub.childAge), sub.id + ": out-of-age camp " + p.id + " appeared");
          HC.assert(dayMatch(p, sub.freeDays), sub.id + ": no-free-day camp " + p.id + " appeared");
        }
      }
    });

    check("Age band is respected: a too-young/too-old child drops mismatched camps", function () {
      // Priya, age 5, vs a hypothetical age-16 teen in the same area.
      var area = "Walthamstow";
      var young = assembleDigest({ id: "t-young", area: area, childAge: 5, freeDays: WEEKDAYS.slice() }, baseCfg, nowMs);
      var teen = assembleDigest({ id: "t-teen", area: area, childAge: 16, freeDays: WEEKDAYS.slice() }, baseCfg, nowMs);
      // Every camp in each digest must actually cover that age.
      var byId = {}; providers().forEach(function (p) { byId[p.id] = p; });
      young.camps.forEach(function (c) { HC.assert(ageMatch(byId[c.id], 5), "age-5 digest has out-of-band " + c.id); });
      teen.camps.forEach(function (c) { HC.assert(ageMatch(byId[c.id], 16), "age-16 digest has out-of-band " + c.id); });
      // The two age bands should not be identical sets (different demand).
      var ys = young.camps.map(function (c) { return c.id; }).sort().join(",");
      var ts = teen.camps.map(function (c) { return c.id; }).sort().join(",");
      HC.assert(ys !== ts || young.camps.length === 0, "age 5 and age 16 produced identical digests — age not applied");
    });

    check("Free-day filter is respected", function () {
      var area = "Walthamstow";
      // A subscriber free on NO weekday should get nothing day-matchable.
      var noDays = assembleDigest({ id: "t-noday", area: area, childAge: 8, freeDays: ["Sat", "Sun"] }, baseCfg, nowMs);
      HC.assert(noDays.camps.length === 0, "weekend-only parent should match no weekday holiday camps, got " + noDays.camps.length);
      // A subscriber free Mon–Fri should match at least as many as a single-day one.
      var allWeek = assembleDigest({ id: "t-all", area: area, childAge: 8, freeDays: WEEKDAYS.slice() }, baseCfg, nowMs);
      var oneDay = assembleDigest({ id: "t-one", area: area, childAge: 8, freeDays: ["Wed"] }, baseCfg, nowMs);
      HC.assert(allWeek.matchedCount >= oneDay.matchedCount, "more free days should never match fewer camps");
    });

    check("Two different subscribers get different digests", function () {
      var a = assembleDigest({ id: "x", area: "Walthamstow", childAge: 6, freeDays: WEEKDAYS.slice() }, baseCfg, nowMs);
      var b = assembleDigest({ id: "y", area: "Chingford", childAge: 13, freeDays: ["Mon"] }, baseCfg, nowMs);
      var sa = a.camps.map(function (c) { return c.id; }).sort().join(",");
      var sb = b.camps.map(function (c) { return c.id; }).sort().join(",");
      HC.assert(sa !== sb, "different area/age/day prefs produced identical digests");
    });

    check("requireBookings config narrows the eligible pool to bookings-on camps", function () {
      var base = eligibleCamps(baseCfg, nowMs);
      var strictCfg = { cap: baseCfg.cap, requireBookings: true, sendDay: "Sunday" };
      var strict = eligibleCamps(strictCfg, nowMs);
      HC.assert(strict.length <= base.length, "requireBookings should not grow the pool");
      strict.forEach(function (p) { HC.assert(bookingsOn(p), p.id + " in strict pool but bookings off"); });
    });

    check("Ranking puts bookings-on camps before bookings-off within a digest", function () {
      var d = assembleDigest({ id: "r", area: "Walthamstow", childAge: 7, freeDays: WEEKDAYS.slice() }, { cap: 12, requireBookings: false, sendDay: "Sunday" }, nowMs);
      var seenOff = false;
      for (var i = 0; i < d.camps.length; i++) {
        if (!d.camps[i].bookings) seenOff = true;
        else HC.assert(!seenOff, "a bookings-on camp ranked below a bookings-off camp");
      }
    });

    check("Config persists through HC.store (cap round-trips)", function () {
      var saved = HC.store.get(STORE_KEY, null);
      try {
        setConfig({ cap: 3 });
        HC.assert(getConfig().cap === 3, "cap should persist as 3");
        var d = assembleDigest({ id: "p", area: "Walthamstow", childAge: 7, freeDays: WEEKDAYS.slice() }, getConfig(), nowMs);
        HC.assert(d.camps.length <= 3, "cap=3 should bound digest length");
      } finally {
        // restore prior store state so the test is side-effect free
        if (saved === null) { if (HC.store.remove) HC.store.remove(STORE_KEY); }
        else HC.store.set(STORE_KEY, saved);
      }
    });

    return { pass: pass, fail: fail, log: log };
  }

  /* ============================================================
   * 8. Register
   * ========================================================== */
  HC.registerFeature({
    id: "platform-whats-on-newsletter",
    title: "Weekly What's On newsletter engine",
    side: "platform",
    icon: "📬",
    summary: "Assembles a personalised weekly digest per subscriber by area + age + free days. Only verified (<=12wk), dated, Member camps are eligible to appear.",
    render: render,
    selfTest: selfTest
  });
})();
