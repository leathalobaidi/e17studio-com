/* HolidayCamp feature — provider-verify-classes
 *
 * 'Verify All' / per-class verify with a 12-week freshness window  (PROVIDER side)
 *
 * Replicates Happity's "verify your classes" behaviour. Evidence (support articles):
 *   - 5827947 "Why am I being asked to verify my classes?":
 *       "To keep all the information on Happity up to date, we will ask you to
 *        VERIFY your class information if you have not updated it in for a while...
 *        If all your information is up to date, then you can VERIFY ALL your
 *        classes with ONE CLICK on your 'Weekly timetable' page... You can also
 *        verify each class INDIVIDUALLY... In the actions column is a 'Verify'
 *        function, clicking this will verify that class schedule."
 *   - 6081998 "What is the What's On newsletter...":
 *       "Classes must be RECENTLY VERIFIED, with dates listed, to appear...
 *        VERIFY your listings AT LEAST EVERY 12 WEEKS by using the VERIFY ALL
 *        button on your Weekly Timetable."
 *   - 12638539 "How do I become a member...": subscription context in which an
 *        up-to-date, verified Weekly Timetable is part of the membership offer.
 *
 * Framed for SCHOOL-AGE HOLIDAY CAMPS: each provider in the live directory owns a
 * camp "listing" (its school-holiday timetable). A listing is FRESH for 12 weeks
 * (84 days) from its last verification. Once that window lapses it is STALE and
 * gets flagged for verification. The provider can re-verify one listing from its
 * actions column ('Verify'), or stamp ALL their listings fresh in one click
 * ('Verify all'). Only listings with upcoming camp dates are eligible to be
 * featured in the What's On round-up, mirroring Happity's "recently verified,
 * with dates listed" rule.
 *
 * ACCEPTANCE CRITERION (exercised by selfTest):
 *   A 'Verify all' action stamps listings as fresh; stale ones are flagged for
 *   verification.
 *
 * Self-contained, defensive, no imports/exports. Calls HC.registerFeature.
 */
(function () {
  "use strict";

  // Defensive: never throw at module load if HC isn't present.
  if (typeof window === "undefined" || !window.HC || typeof window.HC.registerFeature !== "function") {
    if (typeof console !== "undefined" && console.warn) {
      console.warn("[HC] provider-verify-classes: HC core not found; skipping registration.");
    }
    return;
  }

  var HC = window.HC;

  var STORE_KEY = "provider_verify_classes_state";

  // The freshness window, straight from evidence 6081998: "at least every 12 weeks".
  var FRESH_WEEKS = 12;
  var DAY_MS = 24 * 60 * 60 * 1000;
  var FRESH_MS = FRESH_WEEKS * 7 * DAY_MS; // 84 days

  /* ---------------- time helpers ---------------- */

  function now() { try { return Date.now(); } catch (e) { return 0; } }
  function nowIso() { try { return new Date().toISOString(); } catch (e) { return "" + now(); }
  }
  function toMs(iso) {
    if (typeof iso === "number") return iso;
    var t = Date.parse(iso);
    return isFinite(t) ? t : NaN;
  }
  function daysAgoIso(days) {
    return new Date(now() - (Number(days) || 0) * DAY_MS).toISOString();
  }

  function safeUid() {
    try { return HC.util.uid(); } catch (e) { return "id_" + Math.random().toString(36).slice(2); }
  }

  /* ---------------- pure freshness logic (DOM-free, testable) ----------------
   *
   * A listing is one record:
   *   {
   *     id,                // listing id (defaults to provider id)
   *     providerId,        // owning directory provider
   *     name,              // listing / camp name
   *     verifiedAt,        // ISO string of last verification (or null = never)
   *     hasDates,          // Boolean: upcoming camp dates listed?
   *     verifyCount        // how many times it has been verified
   *   }
   *
   * Pure functions take (listing|state[, refMs]) and never mutate in place, so
   * tests run against fresh literals. `refMs` lets tests pin "now".
   */

  // Age of a listing's verification in whole days, relative to refMs.
  function ageDays(listing, refMs) {
    if (!listing || listing.verifiedAt == null) return Infinity; // never verified
    var ref = (typeof refMs === "number") ? refMs : now();
    var ms = toMs(listing.verifiedAt);
    if (!isFinite(ms)) return Infinity;
    var d = (ref - ms) / DAY_MS;
    return d < 0 ? 0 : d; // a future timestamp is treated as just-verified
  }

  // FRESH = verified within the last 12 weeks (84 days).
  function isFresh(listing, refMs) {
    return ageDays(listing, refMs) <= FRESH_WEEKS * 7;
  }

  // STALE = the opposite of fresh — this is what gets "flagged for verification".
  function isStale(listing, refMs) {
    return !isFresh(listing, refMs);
  }

  // Days remaining before this listing goes stale (0 if already stale).
  function daysUntilStale(listing, refMs) {
    var remaining = (FRESH_WEEKS * 7) - ageDays(listing, refMs);
    if (!isFinite(remaining)) return 0;
    return remaining > 0 ? Math.floor(remaining) : 0;
  }

  function status(listing, refMs) {
    if (!listing || listing.verifiedAt == null) return "unverified";
    return isFresh(listing, refMs) ? "fresh" : "stale";
  }

  // Eligible for the What's On round-up: recently verified AND has upcoming dates.
  // (Evidence 6081998: "recently verified, with dates listed".)
  function isFeaturable(listing, refMs) {
    return isFresh(listing, refMs) && !!(listing && listing.hasDates);
  }

  /* ---------------- state transitions (pure) ---------------- */

  function cloneState(state) {
    try { return JSON.parse(JSON.stringify(state || {})); } catch (e) { return emptyState(); }
  }
  function emptyState() { return { listings: {} }; }

  function listingsArr(state) {
    if (!state || !state.listings) return [];
    return Object.keys(state.listings).map(function (id) { return state.listings[id]; });
  }

  // VERIFY ONE — the per-class 'Verify' in the actions column. Stamps a single
  // listing fresh by setting verifiedAt = stampIso (defaults to now). Returns a
  // NEW state. A missing listing is a safe no-op.
  function verifyOne(state, listingId, stampIso) {
    var next = cloneState(state);
    var l = next.listings && next.listings[listingId];
    if (!l) return next;
    l.verifiedAt = stampIso || nowIso();
    l.verifyCount = (Number(l.verifyCount) || 0) + 1;
    return next;
  }

  // VERIFY ALL — the one-click button on the Weekly Timetable. Stamps EVERY
  // listing fresh. Returns { state, verified:[ids], staleBefore:[ids] } so the
  // caller (and tests) can see exactly which listings were flagged stale and
  // then refreshed. By default it only needs to touch the stale/unverified ones,
  // but Happity's button stamps them all — so we stamp all and report which were
  // stale beforehand.
  function verifyAll(state, stampIso, refMs) {
    var next = cloneState(state);
    var stamp = stampIso || nowIso();
    var ref = (typeof refMs === "number") ? refMs : now();
    var verified = [];
    var staleBefore = [];
    var ids = next.listings ? Object.keys(next.listings) : [];
    for (var i = 0; i < ids.length; i++) {
      var l = next.listings[ids[i]];
      if (isStale(l, ref)) staleBefore.push(ids[i]);
      l.verifiedAt = stamp;
      l.verifyCount = (Number(l.verifyCount) || 0) + 1;
      verified.push(ids[i]);
    }
    return { state: next, verified: verified, staleBefore: staleBefore };
  }

  // The set of listings currently flagged for verification (stale or never-verified).
  function flaggedForVerification(state, refMs) {
    return listingsArr(state).filter(function (l) { return isStale(l, refMs); });
  }

  function countByStatus(state, refMs) {
    var out = { fresh: 0, stale: 0, unverified: 0, total: 0 };
    listingsArr(state).forEach(function (l) {
      out.total += 1;
      out[status(l, refMs)] += 1;
    });
    return out;
  }

  /* ---------------- persistence (HC.store only) ---------------- */

  function loadState() {
    var raw;
    try { raw = HC.store.get(STORE_KEY, null); } catch (e) { raw = null; }
    if (!raw || typeof raw !== "object" || !raw.listings || typeof raw.listings !== "object") {
      return null;
    }
    return raw;
  }
  function saveState(state) {
    try { HC.store.set(STORE_KEY, state); } catch (e) {}
  }
  function clearState() {
    try { HC.store.remove ? HC.store.remove(STORE_KEY) : HC.store.set(STORE_KEY, null); } catch (e) {}
  }

  /* ---------------- live camp data ---------------- */

  function providers() {
    try { return HC.data.providers || []; } catch (e) { return []; }
  }

  // Build a fresh demo state from the live directory. We deliberately seed a MIX
  // of fresh and stale listings so the "Verify all" demo and its self-test have
  // something to flag. Verification ages are spread across / past the 12-week
  // window. `hasDates` is read from the live data when available.
  function seedFromProviders(refMs) {
    var ref = (typeof refMs === "number") ? refMs : now();
    var ps = providers();
    var seed = ps.slice(0, 8);
    if (!seed.length) {
      // Fallback demo data if the live directory hasn't loaded.
      seed = [
        { id: "lloyd-park", name: "Lloyd Park Holiday Camp" },
        { id: "active-london", name: "Active London Multi-Sports Camp" },
        { id: "ymca-y-kidz", name: "YMCA Y Kidz Playscheme" },
        { id: "kelmscott-sports", name: "Kelmscott Sports Camp" }
      ];
    }
    // Ages chosen so roughly half land beyond the 84-day window.
    var ages = [10, 35, 70, 90, 130, 6, 84, 200];
    var datesPattern = [true, true, true, true, false, true, true, false];
    var listings = {};
    for (var i = 0; i < seed.length; i++) {
      var p = seed[i] || {};
      var id = String(p.id || ("camp-" + i));
      var ageD = ages[i % ages.length];
      listings[id] = {
        id: id,
        providerId: id,
        name: String(p.name || ("Holiday Camp " + (i + 1))),
        // Pin verifiedAt relative to ref so the seeded fresh/stale split is stable.
        verifiedAt: new Date(ref - ageD * DAY_MS).toISOString(),
        hasDates: typeof p.hasDates === "boolean" ? p.hasDates : datesPattern[i % datesPattern.length],
        verifyCount: 1
      };
    }
    return { listings: listings };
  }

  /* ---------------- UI ---------------- */

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function statusPillStyle(st) {
    var base = "display:inline-block;font-family:'Quicksand',system-ui,sans-serif;font-weight:700;" +
      "font-size:11px;text-transform:uppercase;letter-spacing:.4px;padding:3px 10px;border-radius:999px;";
    if (st === "fresh") return base + "background:#E1F0E4;color:#2f7d4f";
    if (st === "stale") return base + "background:var(--pink-tint,#FCE8F0);color:#9a1f5e";
    return base + "background:#FFF4D6;color:#8a6d00"; // unverified
  }
  function statusLabel(st) {
    if (st === "fresh") return "Verified";
    if (st === "stale") return "Needs verifying";
    return "Never verified";
  }

  function render(mountEl) {
    if (!mountEl) return;

    // Working state: persisted, or seeded from live providers on first open.
    var state = loadState() || seedFromProviders();

    mountEl.innerHTML = "";
    var wrap = HC.util.el("div", {
      style: "font-family:'Nunito Sans',system-ui,sans-serif;color:var(--text,#383838)"
    });

    wrap.appendChild(HC.util.el("p", { style: "font-size:14px;margin:0 0 12px" },
      "Just like Happity's Weekly Timetable: we ask you to <strong>verify your camp listings " +
      "at least every 12 weeks</strong> so parents only see up-to-date school-holiday camps. " +
      "Anything not verified in the last " + FRESH_WEEKS + " weeks is <strong>flagged for verification</strong>. " +
      "Re-verify a single listing from its actions, or stamp them all fresh with <strong>Verify all</strong>."));

    // Summary + Verify-all bar.
    var bar = HC.util.el("div", {
      style: "display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;" +
        "border:1.5px solid var(--line,#E6E6E6);border-radius:14px;padding:12px 16px;margin:0 0 14px;background:#fff"
    });
    var summary = HC.util.el("div", { style: "font-size:13px" });
    var verifyAllBtn = HC.util.el("button", { class: "hc-btn", type: "button" }, "✓ Verify all");
    bar.appendChild(summary);
    bar.appendChild(verifyAllBtn);
    wrap.appendChild(bar);

    var listBox = HC.util.el("div", {});
    wrap.appendChild(listBox);

    // A small footer to demonstrate "needs verifying" reasons + a reset.
    var foot = HC.util.el("div", { style: "margin-top:14px;display:flex;gap:8px;flex-wrap:wrap" });
    var ageBtn = HC.util.el("button", { class: "hc-btn hc-btn-ghost", type: "button" },
      "⏪ Simulate 12 weeks passing");
    var resetBtn = HC.util.el("button", { class: "hc-btn hc-btn-ghost", type: "button" }, "Reset demo");
    foot.appendChild(ageBtn);
    foot.appendChild(resetBtn);
    wrap.appendChild(foot);

    mountEl.appendChild(wrap);

    function paint() {
      var counts = countByStatus(state);
      var needs = counts.stale + counts.unverified;
      summary.innerHTML =
        '<span style="font-family:Quicksand,system-ui,sans-serif;font-weight:700;color:var(--purple,#603488);font-size:15px">' +
          counts.total + " camp listing" + (counts.total === 1 ? "" : "s") + "</span> · " +
        '<span style="color:#2f7d4f;font-weight:700">' + counts.fresh + " verified</span> · " +
        '<span style="color:#9a1f5e;font-weight:700">' + needs + " need" + (needs === 1 ? "s" : "") +
          " verifying</span>";

      var rows = listingsArr(state).sort(function (a, b) {
        // Stale/unverified first so the work to do is at the top.
        return ageDays(b) - ageDays(a);
      });

      listBox.innerHTML = "";
      if (!rows.length) {
        listBox.innerHTML = '<p style="font-size:13px;color:var(--muted,#808080)">No listings yet.</p>';
        return;
      }

      rows.forEach(function (l) {
        var st = status(l);
        var stale = (st !== "fresh");
        var row = HC.util.el("div", {
          style: "border:1.5px solid " + (stale ? "var(--magenta,#F82488)" : "var(--line,#E6E6E6)") +
            ";border-radius:12px;padding:11px 13px;margin:0 0 10px;background:#fff"
        });

        var meta;
        if (st === "unverified") {
          meta = "Never verified — flagged for verification.";
        } else if (st === "stale") {
          meta = "Last verified " + Math.round(ageDays(l)) + " days ago (over " + FRESH_WEEKS +
            " weeks) — flagged for verification.";
        } else {
          meta = "Verified " + Math.round(ageDays(l)) + " days ago · fresh for " +
            daysUntilStale(l) + " more day" + (daysUntilStale(l) === 1 ? "" : "s") + ".";
        }
        var dateFlag = l.hasDates
          ? '<span style="font-size:11px;color:#2f7d4f">● dates listed</span>'
          : '<span style="font-size:11px;color:#8a6d00">● no upcoming dates</span>';

        row.innerHTML =
          '<div style="display:flex;justify-content:space-between;align-items:baseline;gap:10px">' +
            '<span style="font-family:Quicksand,system-ui,sans-serif;font-weight:700;color:var(--purple,#603488);font-size:14.5px">' +
              esc(l.name) + "</span>" +
            '<span style="' + statusPillStyle(st) + '">' + esc(statusLabel(st)) + "</span>" +
          "</div>" +
          '<div style="font-size:12px;color:var(--muted,#808080);margin:3px 0 0">' + esc(meta) + "</div>" +
          '<div style="margin:4px 0 0">' + dateFlag +
            (isFeaturable(l)
              ? ' &nbsp;·&nbsp; <span style="font-size:11px;color:var(--purple,#603488)">eligible for What’s On</span>'
              : "") +
          "</div>";

        // Actions column: per-class 'Verify' (evidence 5827947).
        var btn = HC.util.el("button", {
          class: stale ? "hc-btn" : "hc-btn hc-btn-ghost", type: "button"
        }, stale ? "✓ Verify" : "✓ Re-verify");
        btn.style.marginTop = "9px";
        btn.addEventListener("click", function () {
          state = verifyOne(state, l.id);
          saveState(state);
          try { HC.util.toast("Verified “" + l.name + "” — fresh for another " + FRESH_WEEKS + " weeks"); } catch (e) {}
          paint();
        });
        row.appendChild(btn);
        listBox.appendChild(row);
      });
    }

    verifyAllBtn.addEventListener("click", function () {
      var res = verifyAll(state);
      state = res.state;
      saveState(state);
      try {
        HC.util.toast(res.staleBefore.length
          ? "Verify all: " + res.staleBefore.length + " stale listing" +
              (res.staleBefore.length === 1 ? "" : "s") + " re-verified, all now fresh"
          : "Verify all: every listing was already fresh — re-stamped");
      } catch (e) {}
      paint();
    });

    // Demo control: push every verifiedAt back by 12 weeks + a day so they all go stale.
    ageBtn.addEventListener("click", function () {
      var ids = state.listings ? Object.keys(state.listings) : [];
      ids.forEach(function (id) {
        var l = state.listings[id];
        var ms = toMs(l.verifiedAt);
        if (isFinite(ms)) l.verifiedAt = new Date(ms - (FRESH_MS + DAY_MS)).toISOString();
      });
      saveState(state);
      try { HC.util.toast("Clock advanced — listings are now over 12 weeks old and need verifying"); } catch (e) {}
      paint();
    });

    resetBtn.addEventListener("click", function () {
      clearState();
      state = seedFromProviders();
      saveState(state);
      try { HC.util.toast("Demo reset"); } catch (e) {}
      paint();
    });

    paint();
  }

  /* ---------------- selfTest ---------------- */

  function selfTest() {
    var pass = 0, fail = 0, log = [];
    function check(label, fn) {
      try { fn(); pass += 1; log.push("✓ " + label); }
      catch (e) { fail += 1; log.push("✗ " + label + " — " + (e && e.message ? e.message : String(e))); }
    }

    // A fixed "now" so age maths is deterministic regardless of wall-clock.
    var NOW = Date.UTC(2026, 5, 15); // 2026-06-15
    function isoDaysBack(d) { return new Date(NOW - d * DAY_MS).toISOString(); }

    // Build a small, hand-pinned state: a fresh one, a borderline one, two stale,
    // and one never-verified.
    function fixtureState() {
      return {
        listings: {
          a: { id: "a", providerId: "a", name: "Lloyd Park Camp", verifiedAt: isoDaysBack(10), hasDates: true, verifyCount: 1 },
          b: { id: "b", providerId: "b", name: "Active London Camp", verifiedAt: isoDaysBack(83), hasDates: true, verifyCount: 1 },
          c: { id: "c", providerId: "c", name: "YMCA Y Kidz", verifiedAt: isoDaysBack(90), hasDates: true, verifyCount: 1 },
          d: { id: "d", providerId: "d", name: "Kelmscott Sports", verifiedAt: isoDaysBack(200), hasDates: false, verifyCount: 1 },
          e: { id: "e", providerId: "e", name: "New Camp (never verified)", verifiedAt: null, hasDates: true, verifyCount: 0 }
        }
      };
    }

    // ----- freshness boundary: 12 weeks = 84 days -----
    check("Freshness window is exactly 12 weeks (84 days)", function () {
      HC.assert(FRESH_WEEKS === 12, "freshness is 12 weeks");
      HC.assert(FRESH_MS === 84 * DAY_MS, "12 weeks resolves to 84 days in ms");
    });

    check("A listing verified 10 days ago is FRESH; 90 days ago is STALE", function () {
      var s = fixtureState();
      HC.assert(isFresh(s.listings.a, NOW) === true, "10-day-old listing is fresh");
      HC.assert(isStale(s.listings.a, NOW) === false, "...and not stale");
      HC.assert(isStale(s.listings.c, NOW) === true, "90-day-old listing is stale");
      HC.assert(isFresh(s.listings.c, NOW) === false, "...and not fresh");
    });

    check("The 84-day boundary is inclusive (83 days fresh, 85 days stale)", function () {
      var at83 = { verifiedAt: isoDaysBack(83) };
      var at84 = { verifiedAt: isoDaysBack(84) };
      var at85 = { verifiedAt: isoDaysBack(85) };
      HC.assert(isFresh(at83, NOW) === true, "83 days is still fresh");
      HC.assert(isFresh(at84, NOW) === true, "exactly 84 days (12 wks) is still fresh");
      HC.assert(isStale(at85, NOW) === true, "85 days has lapsed — stale");
    });

    check("A never-verified listing is treated as stale/unverified and flagged", function () {
      var s = fixtureState();
      HC.assert(status(s.listings.e, NOW) === "unverified", "null verifiedAt -> 'unverified'");
      HC.assert(isStale(s.listings.e, NOW) === true, "never-verified counts as stale (needs verifying)");
      HC.assert(ageDays(s.listings.e, NOW) === Infinity, "age of a never-verified listing is Infinity");
    });

    // ----- which listings are flagged -----
    check("Stale and never-verified listings are flagged for verification", function () {
      var s = fixtureState();
      var flagged = flaggedForVerification(s, NOW).map(function (l) { return l.id; }).sort();
      // a(10d) fresh, b(83d) fresh, c(90d) stale, d(200d) stale, e(never) unverified
      HC.assert(flagged.join(",") === "c,d,e", "exactly c, d, e are flagged, got: " + flagged.join(","));
      var counts = countByStatus(s, NOW);
      HC.assert(counts.fresh === 2, "2 fresh (a,b), got " + counts.fresh);
      HC.assert(counts.stale === 2, "2 stale (c,d), got " + counts.stale);
      HC.assert(counts.unverified === 1, "1 unverified (e), got " + counts.unverified);
      HC.assert(counts.total === 5, "5 total");
    });

    // ===== ACCEPTANCE CRITERION =====
    // "A 'Verify all' action stamps listings as fresh; stale ones are flagged for
    //  verification."
    check("ACCEPTANCE: before Verify all, stale listings are flagged", function () {
      var s = fixtureState();
      var flaggedBefore = flaggedForVerification(s, NOW);
      HC.assert(flaggedBefore.length === 3, "3 listings flagged for verification before Verify all (c,d,e)");
    });

    check("ACCEPTANCE: 'Verify all' stamps EVERY listing fresh, clearing all flags", function () {
      var s = fixtureState();
      var res = verifyAll(s, new Date(NOW).toISOString(), NOW);
      // Report: which were stale beforehand?
      HC.assert(res.staleBefore.sort().join(",") === "c,d,e",
        "Verify all reports the stale-before set (c,d,e), got: " + res.staleBefore.join(","));
      HC.assert(res.verified.length === 5, "Verify all touched all 5 listings");
      // After: nothing is flagged, everything is fresh.
      var flaggedAfter = flaggedForVerification(res.state, NOW);
      HC.assert(flaggedAfter.length === 0, "after Verify all, NOTHING is flagged for verification");
      var counts = countByStatus(res.state, NOW);
      HC.assert(counts.fresh === 5, "all 5 listings are fresh after Verify all, got " + counts.fresh);
      HC.assert(counts.stale === 0 && counts.unverified === 0, "no stale or unverified left");
      // Every listing now carries a verification stamp + bumped count.
      listingsArr(res.state).forEach(function (l) {
        HC.assert(isFresh(l, NOW) === true, l.name + " is fresh after Verify all");
        HC.assert(l.verifyCount >= 1, l.name + " verifyCount was incremented");
      });
    });

    // ----- per-class verify (the actions-column 'Verify') -----
    check("Per-class 'Verify' stamps ONE stale listing fresh and leaves others alone", function () {
      var s = fixtureState();
      HC.assert(isStale(s.listings.c, NOW) === true, "c starts stale");
      var s2 = verifyOne(s, "c", new Date(NOW).toISOString());
      HC.assert(isFresh(s2.listings.c, NOW) === true, "c is fresh after per-class verify");
      HC.assert(s2.listings.c.verifyCount === 2, "c verifyCount bumped to 2");
      // d was stale and must STAY flagged — verifying c didn't touch it.
      HC.assert(isStale(s2.listings.d, NOW) === true, "d remains stale (untouched)");
      HC.assert(flaggedForVerification(s2, NOW).map(function (l) { return l.id; }).sort().join(",") === "d,e",
        "only d and e remain flagged after verifying c");
      // Original state is not mutated (pure function).
      HC.assert(isStale(s.listings.c, NOW) === true, "original state untouched — verifyOne is pure");
    });

    // ----- featurability: recently verified AND has dates (evidence 6081998) -----
    check("What's On eligibility needs BOTH freshness and upcoming dates", function () {
      var s = fixtureState();
      HC.assert(isFeaturable(s.listings.a, NOW) === true, "fresh + has dates -> featurable");
      HC.assert(isFeaturable(s.listings.c, NOW) === false, "stale (even with dates) -> not featurable");
      // A fresh listing with NO dates is not featurable.
      var noDates = { verifiedAt: isoDaysBack(5), hasDates: false };
      HC.assert(isFresh(noDates, NOW) === true, "the no-dates listing is fresh");
      HC.assert(isFeaturable(noDates, NOW) === false, "fresh but no dates -> not featurable");
      // After Verify all, a dated listing that was stale becomes featurable.
      var res = verifyAll(s, new Date(NOW).toISOString(), NOW);
      HC.assert(isFeaturable(res.state.listings.c, NOW) === true,
        "c (has dates) becomes featurable once Verify all refreshes it");
      HC.assert(isFeaturable(res.state.listings.d, NOW) === false,
        "d has no dates, so stays out of What's On even when verified");
    });

    // ----- daysUntilStale countdown -----
    check("daysUntilStale counts down within the window and floors at 0 when stale", function () {
      var s = fixtureState();
      HC.assert(daysUntilStale(s.listings.a, NOW) === 74, "10 days in -> 74 days left (84-10)");
      HC.assert(daysUntilStale(s.listings.b, NOW) === 1, "83 days in -> 1 day left");
      HC.assert(daysUntilStale(s.listings.c, NOW) === 0, "already stale -> 0 days left");
      HC.assert(daysUntilStale(s.listings.e, NOW) === 0, "never verified -> 0 days left");
    });

    // ----- defensive -----
    check("Defensive: bad inputs do not throw or corrupt state", function () {
      HC.assert(verifyOne(emptyState(), "nope") && typeof verifyOne(emptyState(), "nope") === "object",
        "verifying a missing listing is a safe no-op");
      var r = verifyAll(emptyState(), new Date(NOW).toISOString(), NOW);
      HC.assert(r.verified.length === 0 && r.staleBefore.length === 0, "Verify all on an empty state is safe");
      HC.assert(flaggedForVerification(null, NOW).length === 0, "null state -> no flags, no throw");
      HC.assert(status({ verifiedAt: "not-a-date" }, NOW) === "stale", "an unparseable date is treated as stale");
      HC.assert(ageDays({ verifiedAt: new Date(NOW + 5 * DAY_MS).toISOString() }, NOW) === 0,
        "a future verifiedAt is clamped to age 0 (just-verified), not negative");
    });

    // ----- persistence round-trip through HC.store -----
    check("Verify state persists via HC.store (namespaced)", function () {
      var s = fixtureState();
      var res = verifyAll(s, new Date(NOW).toISOString(), NOW);
      var ok = HC.store.set(STORE_KEY, res.state);
      HC.assert(ok !== false, "store.set should succeed");
      var got = HC.store.get(STORE_KEY, null);
      HC.assert(got && got.listings && got.listings.c, "listing survives a store round-trip");
      HC.assert(isFresh(got.listings.c, NOW) === true, "freshness survives persistence");
      try { HC.store.remove ? HC.store.remove(STORE_KEY) : HC.store.set(STORE_KEY, null); } catch (e) {}
    });

    // ----- seed comes from the LIVE holiday-camp directory when present -----
    check("Seed listings are drawn from the live directory and include a stale one", function () {
      var seeded = seedFromProviders(NOW);
      var arr = listingsArr(seeded);
      HC.assert(arr.length > 0, "seed produces at least one listing");
      var ps = providers();
      if (ps.length) {
        var first = arr[0];
        var found = ps.some(function (p) { return p && p.id === first.providerId; });
        HC.assert(found, "a seeded listing maps to a real directory provider");
      }
      // The seed must include BOTH fresh and flagged listings so the demo is meaningful.
      var counts = countByStatus(seeded, NOW);
      HC.assert(counts.fresh > 0, "seed includes at least one fresh listing");
      HC.assert((counts.stale + counts.unverified) > 0, "seed includes at least one listing flagged for verification");
      // And Verify all clears them.
      var res = verifyAll(seeded, new Date(NOW).toISOString(), NOW);
      HC.assert(flaggedForVerification(res.state, NOW).length === 0,
        "Verify all clears every flag on the seeded directory listings too");
    });

    return { pass: pass, fail: fail, log: log };
  }

  /* ---------------- register ---------------- */

  HC.registerFeature({
    id: "provider-verify-classes",
    title: "Verify camp listings (12-week freshness)",
    side: "provider",
    icon: "🔄",
    summary: "Just like Happity: we ask you to verify your camp listings at least every 12 weeks so parents " +
      "see only up-to-date school-holiday camps. Listings not verified in 12 weeks are flagged for verification. " +
      "Re-verify one from its actions column, or stamp them all fresh with one-click 'Verify all'.",
    render: render,
    selfTest: selfTest
  });
})();
