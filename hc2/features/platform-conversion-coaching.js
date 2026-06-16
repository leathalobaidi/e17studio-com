/* HolidayCamp feature: platform-conversion-coaching
 * ------------------------------------------------------------------
 * Replicates Happity's "Keep getting found" RETENTION-COACHING surface
 * for the PLATFORM side, reframed for SCHOOL-AGE HOLIDAY CAMPS (not
 * baby classes).
 *
 * Evidence (support corpus, article 12638539
 *   "Keep getting found on Happity: Our top 5 tips for Members"):
 *     "Stay visible and keep getting bookings with some account
 *      maintenance ... top 5 quick wins to help you stay visible, grow
 *      your audience, and make the most of your Membership."
 *   The five tips, verbatim in spirit:
 *     1) Add upcoming dates — "You can't take bookings without upcoming
 *        dates ... adding them also means your classes can appear in our
 *        weekly What's On newsletter."
 *     2) Keep your bookings switched on / Use Featured Listings —
 *        "Classes that can be booked directly ... get 4x more views ...
 *        make sure you have active dates, spaces, and prices ... Featured
 *        Listings push your classes to the top of search results ... from
 *        as little as £5 a month."
 *     3) Check for enquiries — "Parents can message you directly ... Check
 *        your inbox regularly so you can respond quickly ... Quick replies
 *        help you convert interest into bookings."
 *     4) Get social media shoutouts — "Every Monday, Thursday, and Sunday,
 *        we re-share providers' Instagram stories ... Add your booking
 *        link ... Tag us @happityapp."
 *     5) Nurture your audience — "export your data to stay in touch and
 *        keep parents coming back ... Only contact parents who have opted
 *        in to marketing ... Send newsletters ... new term dates and
 *        special offers ... thank-you's or follow-up surveys."
 *
 * For HolidayCamp the platform runs the SAME retention-coaching tips
 * surface: each holiday-camp provider gets a personalised "Keep getting
 * found" checklist. The platform scores the camp's account against the
 * five quick-wins, surfaces the gaps as nudges, and tracks which the
 * provider has actioned/dismissed.
 *
 * Acceptance criterion (asserted by selfTest, multiple cases):
 *   A tips surface nudges fresh dates, bookings-on, enquiry response,
 *   social and re-marketing.
 *
 * Scope: this module owns ONLY the coaching surface — the five tip
 * definitions, a scoring engine that reads each camp's directory +
 * planner signals, and the per-camp action state. It is defensive
 * (nothing throws at registration time) and persists action state via
 * HC.store. The verified camp data is read, never mutated.
 * ------------------------------------------------------------------ */
(function () {
  "use strict";

  if (typeof window === "undefined" || !window.HC || typeof window.HC.registerFeature !== "function") {
    // Core not present — fail silently rather than throwing.
    return;
  }
  var HC = window.HC;

  /* ============================================================
   * 1. The five tips (lifted from the evidence), each with a stable
   *    key matching the acceptance criterion's five nudge areas:
   *      freshDates | bookingsOn | enquiryResponse | social | remarketing
   * ============================================================ */

  var BRAND_HANDLE = "@holidaycampuk";
  var FEATURED_FROM_GBP = 5;       // Featured Listings "from £5 a month".
  var BOOKABLE_VIEW_MULTIPLIER = 4; // bookable camps get "4x more views".
  var STORE_KEY = "platform_coaching_state"; // per-camp action state.

  // Canonical, ordered tip catalogue. `area` is the acceptance-criterion
  // bucket; `weight` lets the score emphasise the highest-impact wins.
  var TIPS = [
    {
      key: "freshDates",
      n: 1,
      icon: "📅",
      title: "Add upcoming dates",
      blurb: "Listings with upcoming dates stay current, can take bookings, and can appear in the weekly What's On newsletter.",
      weight: 3
    },
    {
      key: "bookingsOn",
      n: 2,
      icon: "🟢",
      title: "Keep bookings switched on (or go Featured)",
      blurb: "Camps booked directly on HolidayCamp get " + BOOKABLE_VIEW_MULTIPLIER +
        "x more views. No bookings? Featured Listings push you to the top of search from £" +
        FEATURED_FROM_GBP + " a month.",
      weight: 3
    },
    {
      key: "enquiryResponse",
      n: 3,
      icon: "✉️",
      title: "Check for enquiries",
      blurb: "Parents message you from your listing. Reply quickly to convert interest into bookings and build trust.",
      weight: 2
    },
    {
      key: "social",
      n: 4,
      icon: "📸",
      title: "Get a social shout-out",
      blurb: "Tag " + BRAND_HANDLE + " in an Instagram Story with your booking link and we re-share you to our followers on fixed days.",
      weight: 1
    },
    {
      key: "remarketing",
      n: 5,
      icon: "💌",
      title: "Nurture your audience",
      blurb: "Export your opted-in bookers and stay in touch — new term dates, special offers and end-of-camp thank-yous keep families coming back.",
      weight: 1
    }
  ];

  var TIP_KEYS = TIPS.map(function (t) { return t.key; });
  var TIP_BY_KEY = {};
  TIPS.forEach(function (t) { TIP_BY_KEY[t.key] = t; });
  var MAX_WEIGHT = TIPS.reduce(function (s, t) { return s + t.weight; }, 0);

  /* ============================================================
   * 2. Data helpers — read the live directory + planner safely.
   * ============================================================ */

  function safeProviders() {
    try {
      var p = HC.data && HC.data.providers;
      return Array.isArray(p) ? p : [];
    } catch (e) { return []; }
  }

  function safePlanner() {
    try {
      var pl = HC.data && HC.data.planner;
      return (pl && typeof pl === "object") ? pl : { byId: {}, weeks: [], keyDates: {} };
    } catch (e) { return { byId: {}, weeks: [], keyDates: {} }; }
  }

  function providerById(id) {
    var list = safeProviders();
    for (var i = 0; i < list.length; i++) {
      if (list[i] && list[i].id === id) return list[i];
    }
    return null;
  }

  function plannerEntry(id) {
    var pl = safePlanner();
    var byId = (pl && pl.byId && typeof pl.byId === "object") ? pl.byId : {};
    var e = byId[id];
    return (e && typeof e === "object") ? e : null;
  }

  /* ---- per-tip SIGNAL detectors (from real account data) ---- */

  // Tip 1 — does the camp have CONCRETE upcoming dates? The planner stores
  // a `weeks:[...]` array when specific weeks are confirmed; `weeksLikely`
  // (without a `weeks` array) means "runs but no dates published yet" — the
  // exact gap this tip nudges. A camp with no planner role at all also
  // lacks fresh dates.
  function hasFreshDates(provider) {
    if (!provider) return false;
    var e = plannerEntry(provider.id);
    if (!e) return false;
    if (Array.isArray(e.weeks) && e.weeks.length > 0) return true;
    return false; // weeksLikely / route-only => no concrete dates published
  }

  // Tip 2 — is the camp bookable on the platform right now? Mirrors the
  // re-share module's definition: a live booking route or a canonical
  // source URL parents can book through.
  function isBookingsOn(provider) {
    if (!provider || typeof provider !== "object") return false;
    var booking = typeof provider.booking === "string" ? provider.booking.trim() : "";
    var hasSourceUrl = !!(provider.source && typeof provider.source.url === "string" &&
      /^https?:\/\//i.test(provider.source.url));
    return booking.length > 0 || hasSourceUrl;
  }

  // The above are facts about the LISTING. The remaining three tips are
  // BEHAVIOURS the provider performs (replied to enquiries this week, got a
  // social shout-out, exported/contacted their audience). We can't read
  // those from the static directory, so they live in the per-camp action
  // state (HC.store) and default to "not done" — which is precisely why the
  // surface nudges them.

  /* ============================================================
   * 3. Per-camp action state (persisted via HC.store).
   *    Shape: { [campId]: { freshDates, bookingsOn, enquiryResponse,
   *                          social, remarketing } } where each value is
   *    true (provider marked it done) | false | undefined.
   * ============================================================ */

  function loadState() {
    var s = HC.store.get(STORE_KEY, {});
    return (s && typeof s === "object" && !Array.isArray(s)) ? s : {};
  }
  function saveState(s) {
    HC.store.set(STORE_KEY, (s && typeof s === "object" && !Array.isArray(s)) ? s : {});
  }
  function campState(campId) {
    var s = loadState();
    var c = s[campId];
    return (c && typeof c === "object") ? c : {};
  }
  function markAction(campId, tipKey, done) {
    if (!campId || TIP_KEYS.indexOf(tipKey) === -1) return campState(campId);
    var s = loadState();
    if (!s[campId] || typeof s[campId] !== "object") s[campId] = {};
    s[campId][tipKey] = !!done;
    saveState(s);
    return s[campId];
  }
  function resetCamp(campId) {
    var s = loadState();
    if (s[campId]) { delete s[campId]; saveState(s); }
  }

  /* ============================================================
   * 4. THE COACHING ENGINE (core logic).
   *    For a camp, decide for each of the five tips whether it is
   *    SATISFIED (no nudge needed) or OPEN (nudge the provider).
   *
   *    Satisfaction rules:
   *      - freshDates / bookingsOn: satisfied if the live LISTING signal
   *        is present, OR the provider has explicitly marked it done.
   *      - enquiryResponse / social / remarketing: behaviours — satisfied
   *        only when the provider has marked them done this cycle.
   *
   *    Output drives the surface's nudges and a 0–100 health score.
   * ============================================================ */

  // Which tips are auto-satisfiable from listing signals alone.
  var LISTING_TIPS = { freshDates: hasFreshDates, bookingsOn: isBookingsOn };

  function evaluateCamp(campOrId) {
    var provider = (typeof campOrId === "string") ? providerById(campOrId)
      : (campOrId && typeof campOrId === "object" ? campOrId : null);

    var result = {
      campId: provider ? provider.id : (typeof campOrId === "string" ? campOrId : null),
      campName: provider ? (provider.name || provider.id) : null,
      known: !!provider,
      tips: [],          // per-tip detail, in catalogue order
      nudges: [],        // OPEN tips, in catalogue order (what to surface)
      satisfiedKeys: [],
      areas: {},         // area-key -> { satisfied:Boolean, source:String }
      score: 0,          // 0..100 weighted health score
      allDone: false
    };

    // Read marked-action state by the resolved id, whether or not the camp
    // is a known directory provider (synthetic ids carry state too).
    var state = result.campId ? campState(result.campId) : {};

    var earned = 0;
    for (var i = 0; i < TIPS.length; i++) {
      var tip = TIPS[i];
      var listingFn = LISTING_TIPS[tip.key];
      var listingSatisfied = false;
      if (listingFn && provider) {
        try { listingSatisfied = !!listingFn(provider); } catch (e) { listingSatisfied = false; }
      }
      var markedDone = state[tip.key] === true;
      var satisfied = listingSatisfied || markedDone;
      var source = listingSatisfied ? "listing" : (markedDone ? "marked" : "open");

      var detail = {
        key: tip.key,
        n: tip.n,
        icon: tip.icon,
        title: tip.title,
        blurb: tip.blurb,
        weight: tip.weight,
        satisfied: satisfied,
        source: source,          // listing | marked | open
        canMark: !satisfied      // an OPEN tip can be marked done
      };
      result.tips.push(detail);
      result.areas[tip.key] = { satisfied: satisfied, source: source };

      if (satisfied) {
        earned += tip.weight;
        result.satisfiedKeys.push(tip.key);
      } else {
        result.nudges.push(detail);
      }
    }

    result.score = MAX_WEIGHT > 0 ? Math.round((earned / MAX_WEIGHT) * 100) : 0;
    result.allDone = result.nudges.length === 0;
    return result;
  }

  // Roll the whole directory up into a coaching leaderboard (lowest score
  // first — the camps that most need to act).
  function evaluateAll() {
    return safeProviders().map(function (p) { return evaluateCamp(p); })
      .sort(function (a, b) { return a.score - b.score; });
  }

  /* ============================================================
   * 5. render(mountEl) — the tips surface UI.
   * ============================================================ */

  function scoreColour(score) {
    if (score >= 80) return "#2f7d4f";
    if (score >= 50) return "#b8860b";
    return "#9a1f5e";
  }

  function render(mountEl) {
    try {
      var el = HC.util.el;
      var providers = safeProviders();
      mountEl.innerHTML = "";

      mountEl.appendChild(el("div", {
        style: "font-size:14px;color:var(--text,#383838);line-height:1.55;margin-bottom:8px"
      },
        "<p style='margin:0 0 8px'><strong>Keep getting found.</strong> Pick a camp to see its personalised " +
        "checklist of quick wins. We score the account against five tips — " +
        "<strong>fresh dates, bookings on, enquiry replies, social shout-outs and re-marketing</strong> — " +
        "and nudge whatever's still open.</p>"));

      // ---- camp picker ----
      var bar = el("div", { style: "display:flex;gap:8px;align-items:center;margin-bottom:14px;flex-wrap:wrap" });
      var sel = el("select", {
        id: "coachCamp",
        style: "flex:1;min-width:200px;padding:8px;border:1.5px solid var(--line,#E6E6E6);border-radius:10px;font-size:13.5px"
      });
      sel.appendChild(el("option", { value: "" }, "— choose a camp —"));
      providers.slice().sort(function (a, b) {
        return String(a.name || "").localeCompare(String(b.name || ""));
      }).forEach(function (p) {
        sel.appendChild(el("option", { value: p.id }, p.name || p.id));
      });
      bar.appendChild(sel);
      mountEl.appendChild(bar);

      var panel = el("div", { id: "coachPanel" });
      mountEl.appendChild(panel);

      function paint(campId) {
        panel.innerHTML = "";
        if (!campId) {
          panel.appendChild(renderLeaderboard(el));
          return;
        }
        panel.appendChild(renderCampChecklist(el, campId, function () { paint(campId); }));
      }

      sel.addEventListener("change", function () { paint(sel.value); });
      paint(""); // default: the directory-wide leaderboard
    } catch (e) {
      mountEl.innerHTML = "<p style='color:#9a1f5e'>This feature failed to render: " +
        (e && e.message ? e.message : String(e)) + "</p>";
    }
  }

  function renderLeaderboard(el) {
    var wrap = el("div", {});
    wrap.appendChild(el("div", {
      style: "font-family:Quicksand,system-ui,sans-serif;font-weight:700;color:var(--purple,#603488);font-size:15px;margin-bottom:8px"
    }, "Camps that most need a refresh"));
    var rows = evaluateAll().slice(0, 8);
    var list = el("div", {});
    rows.forEach(function (r) {
      var row = el("div", {
        style: "display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--line,#E6E6E6);font-size:13.5px"
      });
      row.appendChild(el("span", {
        style: "flex:0 0 44px;font-family:Quicksand,system-ui,sans-serif;font-weight:700;color:" + scoreColour(r.score)
      }, r.score + "%"));
      row.appendChild(el("span", { style: "flex:1;color:var(--text,#383838)" },
        (r.campName || r.campId || "—")));
      row.appendChild(el("span", { style: "flex:0 0 auto;color:var(--muted,#808080);font-size:12px" },
        r.nudges.length + " open"));
      list.appendChild(row);
    });
    wrap.appendChild(list);
    return wrap;
  }

  function renderCampChecklist(el, campId, repaint) {
    var ev = evaluateCamp(campId);
    var wrap = el("div", {});

    // header + score ring
    var head = el("div", { style: "display:flex;align-items:center;gap:12px;margin-bottom:12px" });
    head.appendChild(el("div", {
      style: "flex:0 0 auto;width:54px;height:54px;border-radius:50%;display:grid;place-items:center;" +
        "font-family:Quicksand,system-ui,sans-serif;font-weight:700;font-size:15px;color:#fff;background:" + scoreColour(ev.score)
    }, ev.score + "%"));
    var ht = el("div", {});
    ht.appendChild(el("div", {
      style: "font-family:Quicksand,system-ui,sans-serif;font-weight:700;color:var(--purple,#603488);font-size:16px"
    }, ev.campName || campId));
    ht.appendChild(el("div", { style: "font-size:12.5px;color:var(--muted,#808080)" },
      ev.allDone ? "All five quick-wins done — nice work!" : (ev.nudges.length + " of 5 tips still open")));
    head.appendChild(ht);
    wrap.appendChild(head);

    // the five tips, satisfied first-glance ✓ vs open nudge
    var listEl = el("div", {});
    ev.tips.forEach(function (t) {
      var card = el("div", {
        style: "border:1.5px solid " + (t.satisfied ? "var(--line,#E6E6E6)" : "#F8C6DE") + ";border-radius:12px;" +
          "padding:11px 13px;margin-bottom:8px;background:" + (t.satisfied ? "#F6FBF7" : "#FFF7FB")
      });
      var top = el("div", { style: "display:flex;align-items:center;gap:8px" });
      top.appendChild(el("span", { style: "font-size:18px" }, t.icon));
      top.appendChild(el("span", {
        style: "flex:1;font-family:Quicksand,system-ui,sans-serif;font-weight:700;font-size:13.5px;color:var(--purple,#603488)"
      }, t.n + ") " + t.title));
      top.appendChild(el("span", {
        style: "font-size:12px;font-weight:700;color:" + (t.satisfied ? "#2f7d4f" : "#9a1f5e")
      }, t.satisfied ? "✓ done" : "● to do"));
      card.appendChild(top);
      card.appendChild(el("p", { style: "margin:6px 0 0;font-size:12.5px;color:var(--text,#383838);line-height:1.5" }, t.blurb));

      if (t.source === "listing") {
        card.appendChild(el("p", { style: "margin:4px 0 0;font-size:11.5px;color:var(--muted,#808080)" },
          "Auto-detected from your live listing."));
      }

      if (t.canMark) {
        var btn = el("button", { class: "hc-btn hc-btn-ghost", type: "button", style: "margin-top:8px" },
          "Mark as done");
        btn.addEventListener("click", function () {
          markAction(campId, t.key, true);
          HC.util.toast("✓ Marked '" + t.title + "' done");
          if (typeof repaint === "function") repaint();
        });
        card.appendChild(btn);
      } else if (t.source === "marked") {
        var undo = el("button", { class: "hc-btn hc-btn-ghost", type: "button", style: "margin-top:8px" },
          "Undo");
        undo.addEventListener("click", function () {
          markAction(campId, t.key, false);
          if (typeof repaint === "function") repaint();
        });
        card.appendChild(undo);
      }

      listEl.appendChild(card);
    });
    wrap.appendChild(listEl);

    var reset = el("button", { class: "hc-btn hc-btn-ghost", type: "button", style: "margin-top:4px" }, "Reset this camp");
    reset.addEventListener("click", function () {
      resetCamp(campId);
      if (typeof repaint === "function") repaint();
    });
    wrap.appendChild(reset);

    return wrap;
  }

  /* ============================================================
   * 6. selfTest — exercises the LOGIC and asserts the acceptance
   *    criterion across multiple cases.
   *    Acceptance: a tips surface nudges fresh dates, bookings-on,
   *    enquiry response, social and re-marketing.
   * ============================================================ */

  function selfTest() {
    var pass = 0, fail = 0, log = [];
    function check(label, fn) {
      try { fn(); pass++; log.push("✓ " + label); }
      catch (e) { fail++; log.push("✗ " + label + " — " + (e && e.message ? e.message : String(e))); }
    }

    var providers = safeProviders();

    // ---- ACCEPTANCE CRITERION (primary) ----
    // The catalogue must cover EXACTLY the five required nudge areas.
    check("ACCEPTANCE: surface covers all five tip areas (fresh dates, bookings-on, enquiry response, social, re-marketing)", function () {
      var want = ["freshDates", "bookingsOn", "enquiryResponse", "social", "remarketing"];
      HC.assert(TIP_KEYS.length === 5, "expected 5 tips, got " + TIP_KEYS.length);
      want.forEach(function (k) {
        HC.assert(TIP_KEYS.indexOf(k) !== -1, "missing tip area: " + k);
        HC.assert(!!TIP_BY_KEY[k] && typeof TIP_BY_KEY[k].title === "string" && TIP_BY_KEY[k].title.length > 0,
          "tip " + k + " must have a title");
        HC.assert(typeof TIP_BY_KEY[k].blurb === "string" && TIP_BY_KEY[k].blurb.length > 0,
          "tip " + k + " must have nudge copy");
      });
    });

    // ---- ACCEPTANCE CRITERION (behavioural) ----
    // A fresh/empty camp must produce a NUDGE in every one of the five areas.
    check("ACCEPTANCE: a camp with no actions taken is nudged across ALL five areas", function () {
      // Use a synthetic camp with no listing signals and no marked actions,
      // so every tip is open. campId not in directory => known:false but the
      // five tips still evaluate (all open).
      var fresh = "__coaching_fresh__";
      resetCamp(fresh);
      var ev = evaluateCamp(fresh);
      HC.assert(ev.nudges.length === 5, "fresh camp should have all 5 nudges, got " + ev.nudges.length);
      var keys = ev.nudges.map(function (n) { return n.key; }).sort();
      HC.assert(keys.join(",") === ["bookingsOn", "enquiryResponse", "freshDates", "remarketing", "social"].sort().join(","),
        "nudges must span all five areas, got " + keys.join(","));
      HC.assert(ev.score === 0, "a fully-open camp should score 0, got " + ev.score);
    });

    // ---- Each area, individually, is nudged when its signal/behaviour is absent ----
    check("NUDGE: fresh dates is surfaced when no concrete dates are published", function () {
      var fresh = "__coaching_t1__"; resetCamp(fresh);
      var ev = evaluateCamp(fresh);
      HC.assert(ev.areas.freshDates.satisfied === false, "freshDates should be open");
      HC.assert(ev.nudges.some(function (n) { return n.key === "freshDates"; }), "freshDates must appear as a nudge");
    });
    check("NUDGE: bookings-on is surfaced when the camp is not bookable", function () {
      var fresh = "__coaching_t2__"; resetCamp(fresh);
      var ev = evaluateCamp(fresh);
      HC.assert(ev.areas.bookingsOn.satisfied === false, "bookingsOn should be open");
      HC.assert(ev.nudges.some(function (n) { return n.key === "bookingsOn"; }), "bookingsOn must appear as a nudge");
    });
    check("NUDGE: enquiry response is surfaced until the provider marks it done", function () {
      var fresh = "__coaching_t3__"; resetCamp(fresh);
      HC.assert(evaluateCamp(fresh).nudges.some(function (n) { return n.key === "enquiryResponse"; }),
        "enquiryResponse must appear as a nudge");
    });
    check("NUDGE: social shout-out is surfaced until the provider marks it done", function () {
      var fresh = "__coaching_t4__"; resetCamp(fresh);
      HC.assert(evaluateCamp(fresh).nudges.some(function (n) { return n.key === "social"; }),
        "social must appear as a nudge");
    });
    check("NUDGE: re-marketing is surfaced until the provider marks it done", function () {
      var fresh = "__coaching_t5__"; resetCamp(fresh);
      HC.assert(evaluateCamp(fresh).nudges.some(function (n) { return n.key === "remarketing"; }),
        "remarketing must appear as a nudge");
    });

    // ---- LISTING SIGNAL: a camp with concrete planner weeks auto-satisfies freshDates ----
    check("Listing signal: a camp with published weeks does NOT get the fresh-dates nudge", function () {
      // ymca-y-kidz has weeks:[2,3,4,5] in the planner; pick any camp with weeks.
      var withDates = providers.filter(function (p) { return hasFreshDates(p); });
      HC.assert(withDates.length > 0, "expected at least one camp with concrete planner weeks");
      var ev = evaluateCamp(withDates[0]);
      HC.assert(ev.areas.freshDates.satisfied === true, "freshDates should be auto-satisfied from the listing");
      HC.assert(ev.areas.freshDates.source === "listing", "freshDates source should be 'listing'");
      HC.assert(!ev.nudges.some(function (n) { return n.key === "freshDates"; }), "no fresh-dates nudge for a dated camp");
    });

    // ---- LISTING SIGNAL: a "weeksLikely but no dates" camp IS nudged for fresh dates ----
    check("Listing signal: a 'runs but no dates published' camp IS nudged to add dates", function () {
      var noDates = providers.filter(function (p) {
        var e = plannerEntry(p.id);
        return e && e.weeksLikely === true && !(Array.isArray(e.weeks) && e.weeks.length);
      });
      // This is the exact Happity scenario; assert it when present in live data.
      if (noDates.length === 0) { HC.assert(true, "no 'weeksLikely-only' camps in current data — skip"); return; }
      var ev = evaluateCamp(noDates[0]);
      HC.assert(ev.areas.freshDates.satisfied === false, "weeksLikely-only camp should be nudged to add dates");
      HC.assert(ev.nudges.some(function (n) { return n.key === "freshDates"; }), "fresh-dates nudge expected");
    });

    // ---- LISTING SIGNAL: a bookable camp auto-satisfies bookings-on ----
    check("Listing signal: a bookable camp does NOT get the bookings-on nudge", function () {
      var bookable = providers.filter(isBookingsOn);
      HC.assert(bookable.length > 0, "expected at least one bookable camp in live data");
      var ev = evaluateCamp(bookable[0]);
      HC.assert(ev.areas.bookingsOn.satisfied === true, "bookings-on should be auto-satisfied");
      HC.assert(!ev.nudges.some(function (n) { return n.key === "bookingsOn"; }), "no bookings-on nudge for a bookable camp");
    });

    // ---- ACTION + PERSISTENCE: marking a behaviour clears its nudge and raises the score ----
    check("Marking a tip done removes its nudge, raises the score, and persists", function () {
      var camp = "__coaching_action__"; resetCamp(camp);
      var before = evaluateCamp(camp);
      HC.assert(before.nudges.some(function (n) { return n.key === "social"; }), "social should start open");
      var beforeScore = before.score;
      markAction(camp, "social", true);
      var after = evaluateCamp(camp);
      HC.assert(!after.nudges.some(function (n) { return n.key === "social"; }), "social nudge should be cleared after marking");
      HC.assert(after.areas.social.satisfied === true && after.areas.social.source === "marked",
        "social should now be satisfied via 'marked'");
      HC.assert(after.score > beforeScore, "score should rise after an action (" + after.score + " > " + beforeScore + ")");
      // persistence: re-read fresh state
      HC.assert(campState(camp).social === true, "marked action should persist in the HC store");
    });

    // ---- ACTION: marking all five reaches a complete (allDone, 100%) account ----
    check("Marking all five tips reaches an all-done 100% account", function () {
      var camp = "__coaching_full__"; resetCamp(camp);
      TIP_KEYS.forEach(function (k) { markAction(camp, k, true); });
      var ev = evaluateCamp(camp);
      HC.assert(ev.allDone === true, "camp should be all-done");
      HC.assert(ev.nudges.length === 0, "no nudges should remain");
      HC.assert(ev.score === 100, "all five done should score 100, got " + ev.score);
      resetCamp(camp);
    });

    // ---- UNDO: clearing an action re-opens the nudge ----
    check("Undoing an action re-opens its nudge and lowers the score", function () {
      var camp = "__coaching_undo__"; resetCamp(camp);
      markAction(camp, "remarketing", true);
      var hi = evaluateCamp(camp).score;
      markAction(camp, "remarketing", false);
      var ev = evaluateCamp(camp);
      HC.assert(ev.nudges.some(function (n) { return n.key === "remarketing"; }), "remarketing nudge should return");
      HC.assert(ev.score < hi, "score should drop after undo");
      resetCamp(camp);
    });

    // ---- SCORE: weighting makes high-impact wins move the needle more ----
    check("Score weighting: a high-weight tip moves the score more than a low-weight tip", function () {
      var a = "__coaching_wa__", b = "__coaching_wb__";
      resetCamp(a); resetCamp(b);
      markAction(a, "freshDates", true);   // weight 3
      markAction(b, "social", true);        // weight 1
      var sa = evaluateCamp(a).score, sb = evaluateCamp(b).score;
      HC.assert(sa > sb, "fresh-dates (w3) should outscore social (w1): " + sa + " > " + sb);
      resetCamp(a); resetCamp(b);
    });

    // ---- LEADERBOARD: directory roll-up is sorted lowest-score-first ----
    check("Leaderboard ranks the directory lowest-score-first", function () {
      var all = evaluateAll();
      HC.assert(all.length === providers.length, "should evaluate every provider");
      for (var i = 1; i < all.length; i++) {
        HC.assert(all[i - 1].score <= all[i].score, "leaderboard must be ascending by score");
      }
    });

    // ---- REAL DATA: every live camp is nudged on at least the behavioural tips ----
    check("Every live camp is nudged on the three behavioural tips by default", function () {
      HC.assert(providers.length > 0, "directory should have providers");
      var behavioural = ["enquiryResponse", "social", "remarketing"];
      providers.forEach(function (p) {
        resetCamp(p.id); // ensure no leftover marked state from prior runs
        var ev = evaluateCamp(p);
        behavioural.forEach(function (k) {
          HC.assert(ev.areas[k].satisfied === false,
            p.id + " should be nudged on " + k + " by default");
        });
      });
    });

    // ---- DEFENSIVE: garbage input never throws ----
    check("Evaluating garbage input does not throw and stays defensive", function () {
      var r1 = evaluateCamp(null);
      var r2 = evaluateCamp({});
      var r3 = evaluateCamp(12345);
      HC.assert(r1 && Array.isArray(r1.tips) && r1.tips.length === 5, "null camp still yields five tips");
      HC.assert(r2 && r2.nudges.length === 5, "empty-object camp yields five nudges");
      HC.assert(r3 && r3.tips.length === 5, "numeric input handled without throwing");
      HC.assert(markAction(null, "bogusKey", true) && true, "bad markAction is a no-op, not a throw");
    });

    // ---- evaluateCamp must not mutate the provider it reads ----
    check("evaluateCamp does not mutate the provider object", function () {
      if (!providers.length) { HC.assert(true, "no providers — skip"); return; }
      var p = providers[0];
      var snap = JSON.stringify(p);
      evaluateCamp(p);
      HC.assert(JSON.stringify(p) === snap, "provider object must be unchanged");
    });

    return { pass: pass, fail: fail, log: log };
  }

  /* ============================================================
   * 7. Register.
   * ============================================================ */

  HC.registerFeature({
    id: "platform-conversion-coaching",
    title: "Keep getting found",
    side: "platform",
    icon: "🧭",
    summary: "Personalised retention coaching: scores each camp against five quick-wins and nudges fresh dates, bookings-on, enquiry replies, social shout-outs and re-marketing.",
    render: render,
    selfTest: selfTest
  });
})();
