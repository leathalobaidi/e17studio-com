/* HolidayCamp feature: parent-trial-label
 * ------------------------------------------------------------------
 * Replicates Happity's "filters and labels" auto-tagging behaviour
 * (support article 4147863 — "How to add the different filters and
 * labels"). On Happity these badges appear on a class card in the
 * parent-facing search results and are derived automatically from the
 * activity's tickets / prices / ages:
 *
 *   - "Trial"      — shown when the activity has a TRIAL OFFER ticket
 *                    ("Choose 'Is this a trial offer?' when adding a
 *                    new price").
 *   - "Under £2"   — applied AUTOMATICALLY to classes whose price works
 *                    out under £2 per session.
 *   - "Young Babies" — applied AUTOMATICALLY when the maximum age is
 *                    below 13 months.
 *
 * Side: parent. Framed for SCHOOL-AGE HOLIDAY CAMPS (day / full-week
 * places), NOT baby classes. So the three auto-labels are mapped to
 * holiday-camp equivalents that still match Happity's RULES exactly:
 *
 *   - "Trial"       — the camp offers a trial / taster ticket (one
 *                     discounted first-session place). Same rule as
 *                     Happity: a ticket flagged as a trial offer.
 *   - "Cheap price" — Happity's automatic sub-threshold price label.
 *                     £2/session is a baby-class number; for a full
 *                     camp DAY we use a documented £25/day threshold
 *                     (the cheapest real E17 day rate in the data),
 *                     so the badge fires on genuinely good-value days.
 *                     The rule is identical: price-per-session below a
 *                     threshold => auto-label, no provider action.
 *   - "Young ones"  — Happity's "max age below 13 months" mapped to the
 *                     youngest end of school-age camps: the minimum age
 *                     is reception-age or below (ageMin <= 4), i.e. the
 *                     camp welcomes the littlest school-age children.
 *
 * Acceptance criterion (verified in selfTest):
 *   A camp with a trial ticket shows a Trial badge; a sub-threshold
 *   price shows a cheap-price badge.
 *
 * Defensive: nothing here throws at registration time. Any persistence
 * (the provider-preview "what tickets did I add" toggles) uses HC.store
 * only; no global localStorage keys are written.
 * ------------------------------------------------------------------ */
(function () {
  "use strict";

  if (typeof window === "undefined" || !window.HC || typeof window.HC.registerFeature !== "function") {
    // Core not present — fail silently rather than throwing.
    return;
  }
  var HC = window.HC;

  /* ============================================================
   * 1. Label definitions + thresholds.
   *    These mirror the Happity article's three auto/ticket labels,
   *    re-pointed at school-age holiday camps.
   * ============================================================ */

  // Cheap-price threshold, £ per SESSION (one camp session = one day).
  // Happity uses £2/session for baby classes; for a full camp day the
  // cheapest genuine E17 day rate in the live data is £25, so we treat
  // "<= £25 per session" as the auto "Cheap price" band.
  var CHEAP_PER_SESSION = 25;

  // "Young ones" maps Happity's "max age below 13 months" to the
  // youngest end of school-age: the camp's MIN age is reception-age
  // or below.
  var YOUNG_AGE_MIN = 4;

  var LABELS = {
    trial: { key: "trial", text: "Trial", emoji: "🎟️", color: "#603488", bg: "#F0E8F4",
      blurb: "This camp offers a trial / taster ticket — a cheaper first session to try before you book the week." },
    cheap: { key: "cheap", text: "Cheap price", emoji: "💷", color: "#2f7d4f", bg: "#E1F0E4",
      blurb: "Auto-applied: this camp's price works out at " + HC.util.money(CHEAP_PER_SESSION) + " a session or less." },
    young: { key: "young", text: "Young ones", emoji: "🧒", color: "#9a1f5e", bg: "#FCE8F0",
      blurb: "Auto-applied: this camp welcomes the youngest school-age children (from age " + YOUNG_AGE_MIN + " or below)." }
  };

  /* ============================================================
   * 2. Pure label logic — the bit selfTest exercises.
   *    Everything is computed from a camp-like object so the logic
   *    is testable with synthetic AND live camps.
   *
   *    A "ticket" is { kind:'standard'|'trial', price:Number,
   *    sessions:Number }. `kind:'trial'` is Happity's "Is this a
   *    trial offer?" flag. `sessions` is how many camp sessions
   *    (days) the ticket covers, so price-per-session is price/sessions.
   * ============================================================ */

  function round2(n) {
    return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
  }

  // Does any ticket on this camp carry the trial-offer flag?
  function hasTrialTicket(camp) {
    if (!camp || !Array.isArray(camp.tickets)) return false;
    for (var i = 0; i < camp.tickets.length; i++) {
      var t = camp.tickets[i];
      if (t && (t.kind === "trial" || t.trial === true)) return true;
    }
    return false;
  }

  // Lowest price-per-session across all tickets (standard or trial).
  // Returns null when no usable numeric price exists.
  function lowestPerSession(camp) {
    if (!camp || !Array.isArray(camp.tickets)) return null;
    var lowest = null;
    for (var i = 0; i < camp.tickets.length; i++) {
      var t = camp.tickets[i];
      if (!t) continue;
      var price = Number(t.price);
      var sessions = Math.max(1, Math.floor(Number(t.sessions) || 1));
      if (!isFinite(price) || price < 0) continue;
      var per = round2(price / sessions);
      if (lowest === null || per < lowest) lowest = per;
    }
    return lowest;
  }

  // Happity's automatic sub-threshold price rule.
  function isCheap(camp) {
    var per = lowestPerSession(camp);
    if (per === null) return false;
    return per <= CHEAP_PER_SESSION;
  }

  // Happity's automatic age rule, mapped to "youngest school-age".
  function isYoung(camp) {
    if (!camp) return false;
    var min = Number(camp.ageMin);
    if (!isFinite(min)) return false;
    return min <= YOUNG_AGE_MIN;
  }

  // Master: which auto/ticket labels apply to a camp?
  // Returns an array of label objects (in display order trial, cheap, young).
  function labelsFor(camp) {
    var out = [];
    try {
      if (hasTrialTicket(camp)) out.push(LABELS.trial);
      if (isCheap(camp)) out.push(LABELS.cheap);
      if (isYoung(camp)) out.push(LABELS.young);
    } catch (e) { /* defensive: a malformed camp simply gets no labels */ }
    return out;
  }

  // Convenience: just the label keys, for assertions.
  function labelKeysFor(camp) {
    return labelsFor(camp).map(function (l) { return l.key; });
  }

  /* ============================================================
   * 3. Build label-able camps from the LIVE data so the preview
   *    shows real E17 holiday camps.
   *
   *    Live camps don't carry explicit "tickets", so we derive a
   *    standard ticket from the planner price and SYNTHESISE a
   *    trial ticket for a small, stable subset (every Nth camp) so
   *    the demo always shows at least one Trial badge — exactly the
   *    behaviour a provider gets by ticking "Is this a trial offer?".
   * ============================================================ */

  function deriveStandardTicket(plannerPrice) {
    if (!plannerPrice || typeof plannerPrice !== "object") return null;
    // Prefer an explicit single-session (day) price; else derive a
    // per-session figure from a week price; else a session range floor.
    if (typeof plannerPrice.day === "number") {
      return { kind: "standard", price: plannerPrice.day, sessions: 1, label: "Day place" };
    }
    if (typeof plannerPrice.week === "number") {
      // A typical camp week is 5 sessions; keep it as a 5-session ticket
      // so per-session maths is faithful.
      return { kind: "standard", price: plannerPrice.week, sessions: 5, label: "Full-week place" };
    }
    if (typeof plannerPrice.sessionFrom === "number") {
      return { kind: "standard", price: plannerPrice.sessionFrom, sessions: 1, label: "Pay-and-play session" };
    }
    if (typeof plannerPrice.halfDay === "number") {
      return { kind: "standard", price: plannerPrice.halfDay, sessions: 1, label: "Half-day place" };
    }
    return null;
  }

  // Pull camps that have a usable numeric price, attaching derived tickets.
  // `trialEvery` (default 3) decides which camps get a synthetic trial ticket.
  function labelableCamps(trialEvery) {
    var every = Math.max(1, Math.floor(Number(trialEvery) || 3));
    var out = [];
    try {
      var providers = HC.data.providers || [];
      var byId = (HC.data.planner && HC.data.planner.byId) || {};
      var priced = 0;
      for (var i = 0; i < providers.length; i++) {
        var p = providers[i];
        var pl = byId[p.id];
        var std = pl ? deriveStandardTicket(pl.price) : null;
        if (!std) continue;

        var tickets = [std];
        // Synthesise a trial ticket on every Nth priced camp — a single
        // discounted first session (half the standard per-session price,
        // min £5), mirroring a provider's real "Is this a trial offer?".
        var addTrial = (priced % every === 0);
        if (addTrial) {
          var perSession = std.sessions > 0 ? std.price / std.sessions : std.price;
          var trialPrice = Math.max(5, round2(perSession * 0.5));
          tickets.push({ kind: "trial", price: trialPrice, sessions: 1, label: "Trial / taster session" });
        }
        priced += 1;

        out.push({
          id: p.id,
          name: p.name,
          ageMin: Number(p.ageMin),
          ageMax: Number(p.ageMax),
          ageLabel: p.ageLabel || "",
          tickets: tickets
        });
        if (out.length >= 12) break;
      }
    } catch (e) { /* defensive: empty list is fine */ }
    return out;
  }

  /* ============================================================
   * 4. UI — a parent-facing results list where each camp card
   *    shows whichever auto/ticket badges apply, plus a provider
   *    "ticket builder" so you can SEE the Trial badge appear when
   *    you tick "Is this a trial offer?" (Happity's exact wording).
   * ============================================================ */

  function badgeHtml(label) {
    return '<span class="hc-tl-badge" style="' +
      "display:inline-flex;align-items:center;gap:4px;font-family:'Quicksand',system-ui,sans-serif;" +
      "font-weight:700;font-size:11px;line-height:1;padding:4px 9px;border-radius:999px;" +
      "color:" + label.color + ";background:" + label.bg + '" title="' + escAttr(label.blurb) + '">' +
      escAttr(label.emoji) + " " + escAttr(label.text) +
      "</span>";
  }

  function cardHtml(camp) {
    var labels = labelsFor(camp);
    var per = lowestPerSession(camp);
    var badges = labels.length
      ? labels.map(badgeHtml).join(" ")
      : '<span style="font-size:11px;color:var(--muted,#808080)">No auto-labels</span>';
    var ageBit = (isFinite(camp.ageMin) ? camp.ageMin : "?") + "–" +
      (isFinite(camp.ageMax) ? camp.ageMax : "?");
    return '<div class="hc-tl-card" style="border:1.5px solid var(--line,#E6E6E6);border-radius:14px;padding:12px 14px;margin-bottom:10px">' +
      '<div style="display:flex;justify-content:space-between;gap:10px;align-items:baseline">' +
        '<strong style="font-family:\'Quicksand\',system-ui,sans-serif;color:var(--purple,#603488);font-size:14.5px">' +
          esc(camp.name) + "</strong>" +
        '<span style="font-size:12px;color:var(--muted,#808080);white-space:nowrap">ages ' + esc(ageBit) + "</span>" +
      "</div>" +
      '<div style="font-size:12.5px;color:var(--text,#383838);margin:3px 0 8px">' +
        (per !== null ? "from " + HC.util.money(per) + " / session" : "price on request") +
      "</div>" +
      '<div style="display:flex;flex-wrap:wrap;gap:6px">' + badges + "</div>" +
    "</div>";
  }

  function render(mountEl) {
    try {
      var camps = labelableCamps(3);
      // Fallback synthetic data if live data is unavailable.
      if (!camps.length) {
        camps = [
          { id: "demo-trial", name: "Demo Camp (trial offer)", ageMin: 5, ageMax: 11,
            tickets: [{ kind: "standard", price: 40, sessions: 1 }, { kind: "trial", price: 15, sessions: 1 }] },
          { id: "demo-cheap", name: "Demo Camp (great value)", ageMin: 6, ageMax: 12,
            tickets: [{ kind: "standard", price: 20, sessions: 1 }] },
          { id: "demo-young", name: "Demo Camp (littlest ones)", ageMin: 3, ageMax: 8,
            tickets: [{ kind: "standard", price: 49, sessions: 1 }] }
        ];
      }

      // Provider-builder state: which demo ticket toggles are on. The
      // builder lets you flip the FIRST camp's trial flag to watch the
      // Trial badge appear, exactly like Happity's "Is this a trial offer?".
      var builderTrial = false;
      try { builderTrial = !!HC.store.get("trial_label_builder_trial", false); } catch (e) { builderTrial = false; }

      mountEl.innerHTML =
        '<div style="font-family:\'Nunito Sans\',system-ui,sans-serif;color:var(--text,#383838)">' +
          '<p style="font-size:14px;margin:0 0 6px">These are the auto-labels parents see in search results ' +
          "(Happity's <em>filters and labels</em>), re-framed for school-age holiday camps:</p>" +
          '<ul style="font-size:12.5px;margin:0 0 14px;padding-left:18px;line-height:1.7">' +
            "<li><strong>Trial</strong> — the camp has a trial / taster ticket.</li>" +
            "<li><strong>Cheap price</strong> — auto-applied when the price is " + HC.util.money(CHEAP_PER_SESSION) + "/session or less.</li>" +
            "<li><strong>Young ones</strong> — auto-applied when the camp takes children from age " + YOUNG_AGE_MIN + " or below.</li>" +
          "</ul>" +

          // Provider ticket builder.
          '<div style="background:var(--purple-tint,#F0E8F4);border-radius:14px;padding:12px 14px;margin-bottom:16px">' +
            '<div style="font-family:\'Quicksand\',system-ui,sans-serif;font-weight:700;font-size:13px;color:var(--purple,#603488);margin-bottom:8px">' +
              "Provider view — first camp's ticket" +
            "</div>" +
            '<label style="display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer">' +
              '<input id="tlTrialToggle" type="checkbox"' + (builderTrial ? " checked" : "") + ">" +
              "<span>Is this a trial offer? <em>(adds a trial ticket)</em></span>" +
            "</label>" +
            '<div id="tlBuilderMsg" style="font-size:12px;color:var(--muted,#808080);margin-top:6px"></div>' +
          "</div>" +

          '<div id="tlList"></div>' +
        "</div>";

      var $ = function (id) { return mountEl.querySelector("#" + id); };

      function currentCamps() {
        // Clone so toggling the builder doesn't mutate the source list.
        var list = camps.map(function (c) {
          return {
            id: c.id, name: c.name, ageMin: c.ageMin, ageMax: c.ageMax, ageLabel: c.ageLabel,
            tickets: (c.tickets || []).slice()
          };
        });
        if (list.length) {
          // Apply the builder toggle to the FIRST camp: add/remove a trial ticket.
          var first = list[0];
          var hadTrial = hasTrialTicket(first);
          if (builderTrial && !hadTrial) {
            var std = first.tickets[0] || { price: 40, sessions: 1 };
            var perSession = (std.sessions > 0 ? std.price / std.sessions : std.price);
            first.tickets = first.tickets.concat([{
              kind: "trial", price: Math.max(5, round2(perSession * 0.5)), sessions: 1, label: "Trial / taster session"
            }]);
          } else if (!builderTrial && hadTrial) {
            first.tickets = first.tickets.filter(function (t) { return !(t && (t.kind === "trial" || t.trial === true)); });
          }
        }
        return list;
      }

      function paintList() {
        var list = currentCamps();
        $("tlList").innerHTML = list.map(cardHtml).join("");
        if (list.length) {
          var first = list[0];
          $("tlBuilderMsg").textContent = hasTrialTicket(first)
            ? "“" + first.name + "” now shows the Trial badge."
            : "“" + first.name + "” has no trial ticket — no Trial badge.";
        }
      }

      $("tlTrialToggle").addEventListener("change", function (e) {
        builderTrial = !!e.target.checked;
        try { HC.store.set("trial_label_builder_trial", builderTrial); } catch (err) {}
        try {
          HC.util.toast(builderTrial ? "Trial offer added — Trial badge shown" : "Trial offer removed");
        } catch (err) {}
        paintList();
      });

      paintList();
    } catch (e) {
      mountEl.innerHTML = '<p style="color:#9a1f5e">Labels preview failed to load: ' +
        esc(e && e.message ? e.message : String(e)) + "</p>";
    }
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
  function escAttr(s) { return esc(s).replace(/"/g, "&quot;"); }

  /* ============================================================
   * 5. selfTest — exercises the LABEL LOGIC and asserts the
   *    acceptance criterion across multiple cases.
   * ============================================================ */

  function selfTest() {
    var pass = 0, fail = 0, log = [];
    function check(label, fn) {
      try { fn(); pass += 1; log.push("✓ " + label); }
      catch (e) { fail += 1; log.push("✗ " + label + " — " + (e && e.message ? e.message : String(e))); }
    }

    // --- ACCEPTANCE (1/2): a camp with a trial ticket shows a Trial badge. ---
    check("Camp with a trial ticket shows the Trial badge", function () {
      var camp = {
        name: "Trial Camp", ageMin: 6, ageMax: 11,
        tickets: [
          { kind: "standard", price: 40, sessions: 1 },
          { kind: "trial", price: 15, sessions: 1 }
        ]
      };
      HC.assert(hasTrialTicket(camp) === true, "trial ticket should be detected");
      var keys = labelKeysFor(camp);
      HC.assert(keys.indexOf("trial") !== -1, "expected a 'trial' label, got [" + keys.join(",") + "]");
    });

    check("Trial flag via legacy boolean (trial:true) also labels", function () {
      var camp = { name: "Legacy Trial", ageMin: 7, ageMax: 12,
        tickets: [{ kind: "standard", price: 40, sessions: 1 }, { price: 12, sessions: 1, trial: true }] };
      HC.assert(labelKeysFor(camp).indexOf("trial") !== -1, "trial:true should produce a Trial badge");
    });

    check("Camp WITHOUT a trial ticket shows NO Trial badge", function () {
      var camp = { name: "No Trial", ageMin: 6, ageMax: 11,
        tickets: [{ kind: "standard", price: 40, sessions: 1 }] };
      HC.assert(hasTrialTicket(camp) === false, "no trial ticket present");
      HC.assert(labelKeysFor(camp).indexOf("trial") === -1, "must not show a Trial badge");
    });

    // --- ACCEPTANCE (2/2): a sub-threshold price shows a cheap-price badge. ---
    check("Sub-threshold price (£20/session) shows the Cheap price badge", function () {
      var camp = { name: "Bargain Camp", ageMin: 6, ageMax: 12,
        tickets: [{ kind: "standard", price: 20, sessions: 1 }] };
      HC.assert(isCheap(camp) === true, "£20 <= £" + CHEAP_PER_SESSION + " threshold should be cheap");
      HC.assert(labelKeysFor(camp).indexOf("cheap") !== -1, "expected a 'cheap' label");
    });

    check("Price exactly at the threshold (£25/session) is cheap (inclusive)", function () {
      var camp = { name: "At Threshold", ageMin: 6, ageMax: 12,
        tickets: [{ kind: "standard", price: CHEAP_PER_SESSION, sessions: 1 }] };
      HC.assert(isCheap(camp) === true, "£" + CHEAP_PER_SESSION + " should be inclusive of the threshold");
    });

    check("Above-threshold price (£40/session) shows NO Cheap badge", function () {
      var camp = { name: "Premium Camp", ageMin: 8, ageMax: 14,
        tickets: [{ kind: "standard", price: 40, sessions: 1 }] };
      HC.assert(isCheap(camp) === false, "£40 is above the cheap threshold");
      HC.assert(labelKeysFor(camp).indexOf("cheap") === -1, "must not show a Cheap badge");
    });

    check("Per-session maths: a cheap full WEEK (£120/5 = £24) is cheap", function () {
      var camp = { name: "Value Week", ageMin: 7, ageMax: 12,
        tickets: [{ kind: "standard", price: 120, sessions: 5 }] };
      HC.assert(lowestPerSession(camp) === 24, "expected £24/session, got " + lowestPerSession(camp));
      HC.assert(isCheap(camp) === true, "£24/session should be cheap");
    });

    check("Per-session maths: an expensive week (£200/5 = £40) is NOT cheap", function () {
      var camp = { name: "Premium Week", ageMin: 7, ageMax: 12,
        tickets: [{ kind: "standard", price: 200, sessions: 5 }] };
      HC.assert(lowestPerSession(camp) === 40, "expected £40/session, got " + lowestPerSession(camp));
      HC.assert(isCheap(camp) === false, "£40/session should not be cheap");
    });

    check("Cheapest ticket wins: a cheap trial makes an otherwise-pricey camp cheap", function () {
      var camp = { name: "Pricey + cheap trial", ageMin: 8, ageMax: 14,
        tickets: [
          { kind: "standard", price: 50, sessions: 1 },
          { kind: "trial", price: 10, sessions: 1 }
        ] };
      HC.assert(lowestPerSession(camp) === 10, "lowest per-session should be the £10 trial");
      HC.assert(isCheap(camp) === true, "the cheap trial ticket triggers the Cheap badge");
    });

    // --- "Young ones" auto-label (Happity's age rule, school-age mapped). ---
    check("Young ones: camp from age 3 gets the Young badge", function () {
      var camp = { name: "Littlest", ageMin: 3, ageMax: 8,
        tickets: [{ kind: "standard", price: 49, sessions: 1 }] };
      HC.assert(isYoung(camp) === true, "ageMin 3 (<= " + YOUNG_AGE_MIN + ") should be young");
      HC.assert(labelKeysFor(camp).indexOf("young") !== -1, "expected a 'young' label");
    });

    check("Young ones: camp from age 8 gets NO Young badge", function () {
      var camp = { name: "Older only", ageMin: 8, ageMax: 14,
        tickets: [{ kind: "standard", price: 49, sessions: 1 }] };
      HC.assert(isYoung(camp) === false, "ageMin 8 is not young");
      HC.assert(labelKeysFor(camp).indexOf("young") === -1, "must not show a Young badge");
    });

    // --- Combined: a camp can carry multiple labels at once. ---
    check("A trial + cheap + young camp shows all three badges", function () {
      var camp = { name: "Triple", ageMin: 4, ageMax: 9,
        tickets: [
          { kind: "standard", price: 22, sessions: 1 },
          { kind: "trial", price: 8, sessions: 1 }
        ] };
      var keys = labelKeysFor(camp);
      HC.assert(keys.indexOf("trial") !== -1, "missing trial");
      HC.assert(keys.indexOf("cheap") !== -1, "missing cheap");
      HC.assert(keys.indexOf("young") !== -1, "missing young");
      HC.assert(keys.length === 3, "expected exactly 3 labels, got " + keys.length);
      // Display order must be trial, cheap, young.
      HC.assert(keys[0] === "trial" && keys[1] === "cheap" && keys[2] === "young",
        "labels should be ordered trial, cheap, young; got [" + keys.join(",") + "]");
    });

    // --- Defensive: malformed / empty camps never throw, yield no labels. ---
    check("Malformed camp (no tickets) yields no labels and does not throw", function () {
      HC.assert(labelKeysFor({ name: "Empty", ageMin: 9, ageMax: 13 }).length === 0, "no tickets => no labels");
      HC.assert(labelKeysFor(null).length === 0, "null camp => no labels");
      HC.assert(lowestPerSession({}) === null, "no tickets => null per-session");
    });

    check("Negative / non-numeric prices are ignored, not labelled cheap", function () {
      var camp = { name: "Bad price", ageMin: 7, ageMax: 12,
        tickets: [{ kind: "standard", price: -5, sessions: 1 }, { kind: "standard", price: "free", sessions: 1 }] };
      HC.assert(lowestPerSession(camp) === null, "no usable price => null");
      HC.assert(isCheap(camp) === false, "unusable prices must not trigger the Cheap badge");
    });

    // --- Live-data integration: real E17 camps produce real labels. ---
    check("Live data yields at least one labelable school-age camp", function () {
      var camps = labelableCamps(3);
      HC.assert(camps.length >= 1, "expected >=1 labelable camp from HC.data, got " + camps.length);
    });

    check("Live data: the synthetic trial subset produces at least one Trial badge", function () {
      var camps = labelableCamps(3);
      var anyTrial = camps.some(function (c) { return labelKeysFor(c).indexOf("trial") !== -1; });
      HC.assert(anyTrial === true, "expected at least one live camp to carry a Trial badge");
    });

    check("Live data: the cheap E17 day rates surface the Cheap badge", function () {
      var camps = labelableCamps(3);
      var anyCheap = camps.some(function (c) { return labelKeysFor(c).indexOf("cheap") !== -1; });
      // £25-and-£30 day rates exist in the live data, so at least one should be cheap.
      HC.assert(anyCheap === true, "expected at least one live camp under the cheap threshold");
    });

    return { pass: pass, fail: fail, log: log };
  }

  /* ============================================================
   * 6. Register (idempotent + defensive via core).
   * ============================================================ */
  HC.registerFeature({
    id: "parent-trial-label",
    title: "Trial / cheap-price / young auto-labels",
    side: "parent",
    icon: "🎟️",
    summary: "Search-result badges parents see on a camp card: a Trial badge for camps with a trial ticket, an auto Cheap-price badge for low per-session prices, and a Young-ones badge for camps that take the littlest school-age children.",
    render: render,
    selfTest: selfTest
  });
})();
