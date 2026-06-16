/* HolidayCamp feature: provider-membership-manage
 * ------------------------------------------------------------------
 * Replicates Happity's "Manage / cancel Membership & payment details"
 * for the PROVIDER side, reframed for SCHOOL-AGE HOLIDAY CAMPS.
 *
 * Evidence (support corpus):
 *  - 5256855 "How do I update my payment details for my Membership or
 *    Featured Listings?":
 *      "To change your payment card details ... Login to your Provider
 *       dashboard and navigate to settings. Click on 'membership'. Choose
 *       'Update card'. Enter your new details and save them. The new
 *       details will appear as below."
 *    -> Modelled: Settings › Membership › Update card. We validate a card
 *       (number/expiry/CVC/name), store ONLY the safe display fields
 *       (brand + last-4 + expiry), never the PAN/CVC, and surface the
 *       masked card after saving — exactly the "new details appear" step.
 *  - 5317998 / 15458402 "How do I cancel my subscriptions / How to cancel
 *    your Happity services":
 *      "Cancelling your Membership will also cancel your Featured Listings
 *       subscription and deactivate bookings (where relevant). ... If you
 *       don't want to close your account, you'll automatically move to a
 *       free listing — so your classes stay on Happity. ... the team will
 *       cancel your membership within five working days."
 *      Refund policy: "Annual membership: refund if not happy in the
 *       first 30 days. After this ... no refund. Monthly membership: 9
 *       month minimum contract period. After this you can cancel at any
 *       time however you will not receive a refund on any time remaining."
 *      "All memberships come with a 30 day cooling off period."
 *  - 2656616 "How do I become a Member ...": Membership is £60/year or
 *    £8/month (+VAT); 9-month minimum term on monthly plans; Featured
 *    Listings is a separate subscription bundled with Membership.
 *
 * Acceptance criterion (asserted by selfTest, multiple cases):
 *   "Provider can update card details and cancel the subscription."
 *   -> Update card: a valid card is saved and the masked card (brand +
 *      last-4 + expiry) is what the dashboard now shows; the raw PAN/CVC
 *      are never persisted; invalid cards are rejected and leave the old
 *      card in place.
 *   -> Cancel: requesting cancellation moves the membership to a
 *      'cancellation_requested' state, cancels the Featured Listings
 *      add-on, and (unless the provider chose to close the account) drops
 *      the listing to the FREE tier so camps stay live. Refund eligibility
 *      is computed from plan + cooling-off window + 9-month monthly term.
 *
 * Defensive: nothing throws at registration time. Persistence is via
 * HC.store ONLY (one namespaced key, keyed by provider id). The verified
 * camps.js data is never mutated. School-age holiday-camp framing
 * throughout (not baby classes).
 * ------------------------------------------------------------------ */
(function () {
  "use strict";

  if (typeof window === "undefined" || !window.HC || typeof window.HC.registerFeature !== "function") {
    // Core not present — fail silently rather than throwing.
    return;
  }
  var HC = window.HC;

  var STORE_KEY = "provider_membership"; // { [providerId]: MembershipRecord }

  // Plan economics mirror evidence 2656616 (school-age camp framing keeps
  // the same headline prices Happity charges providers).
  var PLANS = {
    annual: {
      id: "annual",
      label: "Annual membership",
      priceText: "£60/year (+VAT)",
      amount: 60,
      interval: "year",
      minTermMonths: 0          // annual has no separate minimum term
    },
    monthly: {
      id: "monthly",
      label: "Monthly membership",
      priceText: "£8/month (+VAT)",
      amount: 8,
      interval: "month",
      minTermMonths: 9          // evidence: 9-month minimum on monthly
    }
  };

  var COOLING_OFF_DAYS = 30;    // evidence: 30-day cooling-off on all memberships
  var PROCESS_WORKING_DAYS = 5; // evidence: cancelled within five working days
  var DAY_MS = 24 * 60 * 60 * 1000;

  // Membership lifecycle states.
  //   active                  -> a paying member (Membership + Featured Listings)
  //   cancellation_requested  -> cancellation submitted, processing window open
  //   free                    -> dropped to a free listing (classes stay live)
  //   closed                  -> account closed, profile removed
  var STATES = ["active", "cancellation_requested", "free", "closed"];

  var CARD_BRANDS = {
    visa: { test: /^4/, label: "Visa" },
    mastercard: { test: /^(5[1-5]|2[2-7])/, label: "Mastercard" },
    amex: { test: /^3[47]/, label: "American Express" }
  };

  /* ============================================================
   * 1. Pure helpers + card validation. We never persist the PAN or
   *    CVC — only the safe display triplet (brand, last4, expiry).
   * ============================================================ */

  function trimStr(s) { return String(s == null ? "" : s).trim(); }
  function digitsOnly(s) { return String(s == null ? "" : s).replace(/\D+/g, ""); }

  function detectBrand(pan) {
    var d = digitsOnly(pan);
    for (var k in CARD_BRANDS) {
      if (!Object.prototype.hasOwnProperty.call(CARD_BRANDS, k)) continue;
      if (CARD_BRANDS[k].test.test(d)) return { id: k, label: CARD_BRANDS[k].label };
    }
    return { id: "card", label: "Card" };
  }

  // Luhn check — a real "valid card number" rather than just length.
  function luhnValid(pan) {
    var d = digitsOnly(pan);
    if (d.length < 12 || d.length > 19) return false;
    var sum = 0, dbl = false;
    for (var i = d.length - 1; i >= 0; i--) {
      var n = parseInt(d.charAt(i), 10);
      if (dbl) { n *= 2; if (n > 9) n -= 9; }
      sum += n;
      dbl = !dbl;
    }
    return sum % 10 === 0;
  }

  // Expiry must be a real MM/YY in the future. now is injectable for tests.
  function expiryValid(mm, yy, now) {
    var m = parseInt(digitsOnly(mm), 10);
    var y = parseInt(digitsOnly(yy), 10);
    if (!(m >= 1 && m <= 12)) return false;
    if (!(y >= 0 && y <= 99)) return false;
    var ref = now ? new Date(now) : new Date();
    var fullYear = 2000 + y;
    // Card is valid through the last day of its expiry month.
    var endOfMonth = new Date(fullYear, m, 0, 23, 59, 59, 999);
    return endOfMonth.getTime() >= ref.getTime();
  }

  function cvcValid(cvc, brandId) {
    var d = digitsOnly(cvc);
    if (brandId === "amex") return d.length === 4;
    return d.length === 3;
  }

  // Validate a raw card form. Returns { ok, errors:{field}, display? }.
  // display is the ONLY thing we ever persist.
  function validateCard(input, now) {
    var errors = {};
    var src = input || {};
    var name = trimStr(src.name);
    var pan = digitsOnly(src.number);
    var mm = trimStr(src.expMonth);
    var yy = trimStr(src.expYear);
    var cvc = digitsOnly(src.cvc);

    var brand = detectBrand(pan);

    if (!name) errors.name = "Enter the name on the card.";

    if (!pan) errors.number = "Enter your card number.";
    else if (!luhnValid(pan)) errors.number = "That card number doesn't look right.";

    if (!mm || !yy) errors.expiry = "Enter the card's expiry date.";
    else if (!expiryValid(mm, yy, now)) errors.expiry = "That expiry date has passed.";

    if (!cvc) errors.cvc = "Enter the security code (CVC).";
    else if (!cvcValid(cvc, brand.id)) {
      errors.cvc = brand.id === "amex"
        ? "Amex security codes are 4 digits."
        : "Security codes are 3 digits.";
    }

    var ok = Object.keys(errors).length === 0;
    var display = null;
    if (ok) {
      display = {
        brand: brand.id,
        brandLabel: brand.label,
        last4: pan.slice(-4),
        expMonth: ("0" + parseInt(digitsOnly(mm), 10)).slice(-2),
        expYear: ("0" + parseInt(digitsOnly(yy), 10)).slice(-2),
        nameOnCard: name,
        updatedAt: now || Date.now()
      };
    }
    return { ok: ok, errors: errors, display: display };
  }

  function maskedCardText(card) {
    if (!card) return "No card on file";
    return card.brandLabel + " •••• " + card.last4 + "  ·  exp " + card.expMonth + "/" + card.expYear;
  }

  /* ============================================================
   * 2. Store access — overlay keyed by provider id. Never touches
   *    camps.js. A provider with no record is seeded as an active
   *    member so the "manage / cancel" flows always have something
   *    to act on (mirrors a provider who has upgraded).
   * ============================================================ */

  function defaultRecord(planId, now) {
    var plan = PLANS[planId] ? planId : "annual";
    var ts = now || Date.now();
    return {
      planId: plan,
      state: "active",
      startedAt: ts,                 // when membership began (drives cooling-off + min term)
      featuredListings: true,        // bundled add-on; cancelled with the membership
      bookingsActive: true,          // deactivated on cancellation (where relevant)
      card: null,                    // safe display triplet only
      cancellation: null             // set when a cancellation is requested
    };
  }

  function readAll() {
    var all = HC.store.get(STORE_KEY, {});
    return (all && typeof all === "object") ? all : {};
  }

  function getRecord(providerId, seedPlanId, now) {
    var rec = readAll()[String(providerId)];
    if (rec && typeof rec === "object") return rec;
    return defaultRecord(seedPlanId, now);
  }

  function setRecord(providerId, rec) {
    var all = readAll();
    all[String(providerId)] = rec;
    HC.store.set(STORE_KEY, all);
    return rec;
  }

  /* ============================================================
   * 3. Core actions.
   * ============================================================ */

  // Update the payment card. Mirrors Settings › Membership › Update card.
  // On success the dashboard now shows the masked NEW card; invalid input
  // is rejected and the OLD card is left untouched.
  function updateCard(providerId, input, now) {
    var rec = getRecord(providerId, "annual", now);
    if (rec.state === "closed") {
      return { ok: false, error: "This account is closed — there is no membership to update." };
    }
    var v = validateCard(input, now);
    if (!v.ok) return { ok: false, errors: v.errors };
    rec.card = v.display; // ONLY the safe triplet is stored
    setRecord(providerId, rec);
    return { ok: true, card: v.display, masked: maskedCardText(v.display) };
  }

  // Days since the membership started (whole days).
  function daysSinceStart(rec, now) {
    var ref = now || Date.now();
    return Math.floor((ref - (rec.startedAt || ref)) / DAY_MS);
  }

  // Months since the membership started (approx, 30-day months for the mock).
  function monthsSinceStart(rec, now) {
    return Math.floor(daysSinceStart(rec, now) / 30);
  }

  // Refund eligibility per evidence:
  //  - Annual: refundable only within the first 30 cooling-off days.
  //  - Monthly: 9-month minimum term; never a refund on remaining time.
  function refundAssessment(rec, now) {
    var plan = PLANS[rec.planId] || PLANS.annual;
    var withinCoolingOff = daysSinceStart(rec, now) <= COOLING_OFF_DAYS;
    if (plan.id === "annual") {
      return {
        refundEligible: withinCoolingOff,
        withinCoolingOff: withinCoolingOff,
        reason: withinCoolingOff
          ? "Within the 30-day cooling-off period — you're eligible for a full refund."
          : "Past the 30-day cooling-off period — annual membership is non-refundable for the rest of the year."
      };
    }
    // monthly
    var months = monthsSinceStart(rec, now);
    var pastMinTerm = months >= plan.minTermMonths;
    return {
      refundEligible: false, // monthly never refunds remaining time
      withinCoolingOff: withinCoolingOff,
      pastMinTerm: pastMinTerm,
      minTermMonths: plan.minTermMonths,
      reason: pastMinTerm
        ? "You're past the 9-month minimum term — you can cancel anytime, but there's no refund on the remaining part of the current month."
        : "You're still inside the 9-month minimum term (month " + (months + 1) + " of " + plan.minTermMonths + ")."
    };
  }

  // Can a monthly member cancel right now? (Annual can always request.)
  function canRequestCancellation(rec, now) {
    var plan = PLANS[rec.planId] || PLANS.annual;
    if (rec.state === "closed") return { ok: false, reason: "The account is already closed." };
    if (rec.state === "cancellation_requested") return { ok: false, reason: "A cancellation is already being processed." };
    if (rec.state === "free") return { ok: false, reason: "You're already on a free listing — there's no paid membership to cancel." };
    if (plan.id === "monthly" && monthsSinceStart(rec, now) < plan.minTermMonths) {
      return { ok: false, reason: refundAssessment(rec, now).reason };
    }
    return { ok: true };
  }

  // Add PROCESS_WORKING_DAYS working days (Mon–Fri) to a timestamp.
  function addWorkingDays(ts, workingDays) {
    var d = new Date(ts);
    var added = 0;
    while (added < workingDays) {
      d = new Date(d.getTime() + DAY_MS);
      var dow = d.getDay(); // 0 Sun .. 6 Sat
      if (dow !== 0 && dow !== 6) added += 1;
    }
    return d.getTime();
  }

  // Request cancellation. opts.closeAccount === true closes the account
  // entirely; otherwise the listing drops to FREE so camps stay live.
  // Always cancels the Featured Listings add-on and deactivates bookings.
  function requestCancellation(providerId, opts, now) {
    var rec = getRecord(providerId, "annual", now);
    var ref = now || Date.now();
    var gate = canRequestCancellation(rec, now);
    if (!gate.ok) return { ok: false, error: gate.reason };

    var options = opts || {};
    var refund = refundAssessment(rec, now);

    rec.state = "cancellation_requested";
    rec.featuredListings = false;        // evidence: also cancels Featured Listings
    rec.bookingsActive = false;          // evidence: deactivates bookings (where relevant)
    rec.cancellation = {
      requestedAt: ref,
      closeAccount: !!options.closeAccount,
      // where the account lands once processed
      outcome: options.closeAccount ? "closed" : "free",
      reason: trimStr(options.reason),   // optional feedback (evidence invites feedback)
      refundEligible: refund.refundEligible,
      refundReason: refund.reason,
      processByWorkingDays: PROCESS_WORKING_DAYS,
      processByTs: addWorkingDays(ref, PROCESS_WORKING_DAYS)
    };
    setRecord(providerId, rec);
    return { ok: true, record: rec, refund: refund };
  }

  // Simulate Happity's team processing the cancellation after the window.
  // Lands the account on FREE (camps stay live) or CLOSED.
  function processCancellation(providerId, now) {
    var rec = getRecord(providerId, "annual", now);
    if (rec.state !== "cancellation_requested" || !rec.cancellation) {
      return { ok: false, error: "There's no cancellation to process." };
    }
    var outcome = rec.cancellation.outcome === "closed" ? "closed" : "free";
    rec.state = outcome;
    rec.featuredListings = false;
    rec.bookingsActive = false;
    if (outcome === "free") {
      // Dropped to a free listing: keep the (masked) card on file off, but
      // classes stay live. Plan no longer bills.
      rec.listingLive = true;
    } else {
      rec.listingLive = false; // profile removed
    }
    setRecord(providerId, rec);
    return { ok: true, record: rec, outcome: outcome };
  }

  // Re-activate a cancellation that's still in the processing window
  // ("changed my mind"). Restores the membership + add-ons.
  function reactivate(providerId, now) {
    var rec = getRecord(providerId, "annual", now);
    if (rec.state !== "cancellation_requested") {
      return { ok: false, error: "There's no pending cancellation to undo." };
    }
    rec.state = "active";
    rec.featuredListings = true;
    rec.bookingsActive = true;
    rec.cancellation = null;
    setRecord(providerId, rec);
    return { ok: true, record: rec };
  }

  // Switch the demo plan (annual <-> monthly). Used by the UI to show how
  // refund/min-term rules differ. Resets the start date so the demo is
  // legible. (No bearing on the camps.js data.)
  function setPlan(providerId, planId, now) {
    if (!PLANS[planId]) return { ok: false, error: "Unknown plan." };
    var rec = getRecord(providerId, planId, now);
    rec.planId = planId;
    setRecord(providerId, rec);
    return { ok: true, record: rec };
  }

  /* ============================================================
   * 4. Render — Settings › Membership panel.
   * ============================================================ */

  function firstProvider() {
    var list = HC.data.providers || [];
    return list.length ? list[0] : null;
  }

  function escAttr(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function stateBadge(state) {
    if (state === "active") return '<span class="pmm-badge pmm-active">Active member</span>';
    if (state === "cancellation_requested") return '<span class="pmm-badge pmm-pending">Cancellation requested</span>';
    if (state === "free") return '<span class="pmm-badge pmm-free">Free listing</span>';
    if (state === "closed") return '<span class="pmm-badge pmm-closed">Account closed</span>';
    return '<span class="pmm-badge">' + escAttr(state) + '</span>';
  }

  function fmtDate(ts) {
    try {
      var d = new Date(ts);
      return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
    } catch (e) { return String(ts); }
  }

  function render(mountEl) {
    try {
      var provider = firstProvider() || { id: "demo-provider", name: "Your holiday camp" };
      var providerId = provider.id != null ? String(provider.id) : "demo-provider";
      var providerName = provider.name || providerId;

      mountEl.innerHTML =
        '<style>' +
          '.pmm-wrap{font-family:"Nunito Sans",system-ui,sans-serif;color:var(--text,#383838)}' +
          '.pmm-crumb{font-size:13.5px;margin:0 0 12px}' +
          '.pmm-card{border:1.5px solid var(--line,#E6E6E6);border-radius:14px;padding:14px 15px;background:#FBF8FD;margin:0 0 16px}' +
          '.pmm-card h4{font-family:"Quicksand",system-ui,sans-serif;color:var(--purple,#603488);margin:0 0 4px;font-size:14.5px}' +
          '.pmm-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:0 0 6px}' +
          '.pmm-plan{font-size:13px;color:var(--text,#383838);margin:2px 0 0}' +
          '.pmm-masked{font-family:"Quicksand",system-ui,sans-serif;font-weight:700;color:var(--purple,#603488);font-size:15px;margin:6px 0 2px}' +
          '.pmm-sub{font-size:12px;color:var(--muted,#808080)}' +
          '.pmm-field{margin:0 0 10px}' +
          '.pmm-field label{display:block;font-family:"Quicksand",system-ui,sans-serif;font-weight:700;font-size:12.5px;color:var(--purple,#603488);margin:0 0 4px}' +
          '.pmm-field input,.pmm-field select,.pmm-field textarea{width:100%;box-sizing:border-box;border:1.5px solid var(--line,#E6E6E6);border-radius:12px;padding:9px 12px;font-size:14px;font-family:inherit;background:#fff}' +
          '.pmm-field input:focus,.pmm-field select:focus,.pmm-field textarea:focus{outline:none;border-color:var(--purple,#603488)}' +
          '.pmm-two{display:grid;grid-template-columns:1fr 1fr;gap:10px}' +
          '.pmm-three{display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px}' +
          '.pmm-err{color:#9a1f5e;font-size:12px;margin-top:3px}' +
          '.pmm-hint{color:var(--muted,#808080);font-size:11.5px;margin:2px 0 0}' +
          '.pmm-badge{font-family:"Quicksand",system-ui,sans-serif;font-weight:700;font-size:10.5px;padding:3px 9px;border-radius:999px;text-transform:uppercase;letter-spacing:.3px}' +
          '.pmm-active{background:#E1F0E4;color:#2f7d4f}' +
          '.pmm-pending{background:#FFF3D6;color:#8a6d00}' +
          '.pmm-free{background:var(--purple-tint,#F0E8F4);color:var(--purple,#603488)}' +
          '.pmm-closed{background:#FCE8F0;color:#9a1f5e}' +
          '.pmm-row{display:flex;gap:8px;flex-wrap:wrap;margin-top:8px}' +
          '.pmm-danger{border:1.5px solid #F3C9DD;background:#FFF6FA}' +
          '.pmm-checkrow{display:flex;align-items:flex-start;gap:8px;font-size:13px;margin:8px 0}' +
          '.pmm-checkrow input{width:auto;margin-top:2px}' +
          '.pmm-warn{font-size:12px;color:#8a6d00;background:#FFF3D6;border-radius:10px;padding:8px 10px;margin:8px 0}' +
          '.pmm-note{font-size:11.5px;color:var(--muted,#808080);margin:14px 0 0;border-top:1px dashed var(--line,#E6E6E6);padding-top:10px}' +
          '.pmm-btn-danger{background:#F82488;color:#fff}' +
          '.pmm-btn-danger:hover{background:#ff3d97}' +
          '@media(max-width:520px){.pmm-two,.pmm-three{grid-template-columns:1fr}}' +
        '</style>' +
        '<div class="pmm-wrap">' +
          '<p class="pmm-crumb">Settings &rsaquo; <strong>Membership</strong> — manage <strong>' + escAttr(providerName) + '</strong>’s holiday-camp membership, update the card we bill, or cancel.</p>' +
          '<div class="pmm-card" id="pmmStatus"></div>' +
          '<div class="pmm-card">' +
            '<h4>Update card</h4>' +
            '<p class="pmm-sub" style="margin:0 0 10px">Enter your new card details and save. We only ever store the card brand, last 4 digits and expiry.</p>' +
            '<div class="pmm-field">' +
              '<label for="pmmName">Name on card</label>' +
              '<input id="pmmName" type="text" placeholder="e.g. Adventure Camps Ltd">' +
              '<div class="pmm-err" data-err="name"></div>' +
            '</div>' +
            '<div class="pmm-field">' +
              '<label for="pmmNumber">Card number</label>' +
              '<input id="pmmNumber" type="text" inputmode="numeric" placeholder="4242 4242 4242 4242" autocomplete="off">' +
              '<div class="pmm-err" data-err="number"></div>' +
            '</div>' +
            '<div class="pmm-three">' +
              '<div class="pmm-field">' +
                '<label for="pmmMonth">Expiry month</label>' +
                '<input id="pmmMonth" type="text" inputmode="numeric" placeholder="MM" maxlength="2">' +
              '</div>' +
              '<div class="pmm-field">' +
                '<label for="pmmYear">Expiry year</label>' +
                '<input id="pmmYear" type="text" inputmode="numeric" placeholder="YY" maxlength="2">' +
              '</div>' +
              '<div class="pmm-field">' +
                '<label for="pmmCvc">CVC</label>' +
                '<input id="pmmCvc" type="text" inputmode="numeric" placeholder="123" maxlength="4" autocomplete="off">' +
              '</div>' +
            '</div>' +
            '<div class="pmm-err" data-err="expiry"></div>' +
            '<div class="pmm-err" data-err="cvc"></div>' +
            '<div class="pmm-row"><button type="button" class="hc-btn" id="pmmSaveCard">Save card</button></div>' +
          '</div>' +
          '<div class="pmm-card pmm-danger" id="pmmCancelCard">' +
            '<h4>Cancel membership</h4>' +
            '<p class="pmm-sub" style="margin:0 0 6px">Cancelling also ends your Featured Listings and deactivates bookings. ' +
              'Unless you close your account, your camps stay live on a free listing.</p>' +
            '<div class="pmm-warn" id="pmmRefund"></div>' +
            '<label class="pmm-checkrow"><input type="checkbox" id="pmmClose"> Also close my account and remove my profile entirely</label>' +
            '<div class="pmm-field">' +
              '<label for="pmmReason">Feedback (optional)</label>' +
              '<textarea id="pmmReason" rows="2" placeholder="Tell us why you’re leaving — we read everything."></textarea>' +
            '</div>' +
            '<div class="pmm-row" id="pmmCancelRow"></div>' +
          '</div>' +
          '<p class="pmm-note">Demo plan: ' +
            '<button type="button" class="hc-btn hc-btn-ghost" data-plan="annual">Annual</button> ' +
            '<button type="button" class="hc-btn hc-btn-ghost" data-plan="monthly">Monthly</button> ' +
            '— switch to see how the 30-day cooling-off and 9-month monthly minimum change the refund rules. ' +
            'The team confirms cancellations within ' + PROCESS_WORKING_DAYS + ' working days.</p>' +
        '</div>';

      var statusEl = mountEl.querySelector("#pmmStatus");
      var refundEl = mountEl.querySelector("#pmmRefund");
      var cancelRow = mountEl.querySelector("#pmmCancelRow");

      function clearErrors() {
        mountEl.querySelectorAll("[data-err]").forEach(function (n) { n.textContent = ""; });
      }
      function showErrors(errors) {
        clearErrors();
        for (var f in errors) {
          if (!Object.prototype.hasOwnProperty.call(errors, f)) continue;
          var n = mountEl.querySelector('[data-err="' + f + '"]');
          if (n) n.textContent = errors[f];
        }
      }

      function renderStatus() {
        var rec = getRecord(providerId, "annual");
        var plan = PLANS[rec.planId] || PLANS.annual;
        var cardLine = rec.card ? maskedCardText(rec.card) : "No card on file yet — add one below.";
        var bits =
          '<div class="pmm-head">' + stateBadge(rec.state) + '</div>' +
          '<div class="pmm-plan"><strong>' + escAttr(plan.label) + '</strong> · ' + escAttr(plan.priceText) +
            ' · started ' + escAttr(fmtDate(rec.startedAt)) + '</div>' +
          '<div class="pmm-plan">Featured Listings: ' + (rec.featuredListings ? "on" : "off") +
            ' · Bookings: ' + (rec.bookingsActive ? "active" : "deactivated") + '</div>' +
          '<div class="pmm-masked">' + escAttr(cardLine) + '</div>';
        if (rec.state === "cancellation_requested" && rec.cancellation) {
          bits += '<div class="pmm-warn">Cancellation requested on ' + escAttr(fmtDate(rec.cancellation.requestedAt)) +
            '. We’ll process it by ' + escAttr(fmtDate(rec.cancellation.processByTs)) + ' (' + PROCESS_WORKING_DAYS + ' working days). ' +
            (rec.cancellation.outcome === "closed"
              ? "Your account will then be closed."
              : "Your camps will then move to a free listing and stay live.") +
            ' ' + (rec.cancellation.refundEligible ? "You’re eligible for a refund." : "No refund applies.") + '</div>';
        }
        statusEl.innerHTML = bits;
      }

      function renderRefundAndButtons() {
        var rec = getRecord(providerId, "annual");
        var assess = refundAssessment(rec);
        refundEl.textContent = assess.reason;
        var gate = canRequestCancellation(rec);
        cancelRow.innerHTML = "";
        if (rec.state === "cancellation_requested") {
          cancelRow.innerHTML =
            '<button type="button" class="hc-btn hc-btn-ghost" id="pmmUndo">Changed my mind — keep my membership</button>' +
            '<button type="button" class="hc-btn" id="pmmProcess">Simulate processing</button>';
        } else if (rec.state === "free" || rec.state === "closed") {
          cancelRow.innerHTML = '<span class="pmm-sub">No active membership to cancel.</span>';
        } else if (!gate.ok) {
          cancelRow.innerHTML = '<button type="button" class="hc-btn pmm-btn-danger" disabled style="opacity:.5;cursor:not-allowed">Cancel membership</button>' +
            '<span class="pmm-sub" style="align-self:center">' + escAttr(gate.reason) + '</span>';
        } else {
          cancelRow.innerHTML = '<button type="button" class="hc-btn pmm-btn-danger" id="pmmCancel">Cancel membership</button>';
        }
      }

      function refreshAll() { renderStatus(); renderRefundAndButtons(); }

      mountEl.querySelector("#pmmSaveCard").addEventListener("click", function () {
        var res = updateCard(providerId, {
          name: mountEl.querySelector("#pmmName").value,
          number: mountEl.querySelector("#pmmNumber").value,
          expMonth: mountEl.querySelector("#pmmMonth").value,
          expYear: mountEl.querySelector("#pmmYear").value,
          cvc: mountEl.querySelector("#pmmCvc").value
        });
        if (!res.ok) {
          if (res.errors) showErrors(res.errors);
          HC.util.toast(res.error || "Please fix the highlighted fields");
          return;
        }
        clearErrors();
        mountEl.querySelector("#pmmNumber").value = "";
        mountEl.querySelector("#pmmCvc").value = "";
        renderStatus();
        HC.util.toast("Card updated — now billing " + res.masked);
      });

      mountEl.addEventListener("click", function (e) {
        var planBtn = e.target.closest("[data-plan]");
        if (planBtn) { setPlan(providerId, planBtn.getAttribute("data-plan")); refreshAll(); HC.util.toast("Switched demo plan"); return; }
        if (e.target.closest("#pmmCancel")) {
          var close = !!mountEl.querySelector("#pmmClose").checked;
          var reason = mountEl.querySelector("#pmmReason").value;
          var r = requestCancellation(providerId, { closeAccount: close, reason: reason });
          refreshAll();
          HC.util.toast(r.ok ? "Cancellation requested — confirmed within " + PROCESS_WORKING_DAYS + " working days" : (r.error || "Could not cancel"));
          return;
        }
        if (e.target.closest("#pmmUndo")) {
          reactivate(providerId); refreshAll(); HC.util.toast("Welcome back — your membership is active again"); return;
        }
        if (e.target.closest("#pmmProcess")) {
          var pr = processCancellation(providerId); refreshAll();
          HC.util.toast(pr.ok ? (pr.outcome === "closed" ? "Account closed" : "Moved to a free listing — camps stay live") : (pr.error || "Nothing to process"));
          return;
        }
      });

      refreshAll();
    } catch (e) {
      mountEl.innerHTML = '<p style="color:#9a1f5e">Membership panel failed to render: ' +
        escAttr(e && e.message ? e.message : String(e)) + "</p>";
    }
  }

  /* ============================================================
   * 5. selfTest — exercises the LOGIC and asserts the acceptance
   *    criterion: "Provider can update card details and cancel the
   *    subscription." Multiple cases. Restores the store after.
   * ============================================================ */

  function selfTest() {
    var pass = 0, fail = 0, log = [];
    function check(label, fn) {
      try { fn(); pass += 1; log.push("✓ " + label); }
      catch (e) { fail += 1; log.push("✗ " + label + " — " + (e && e.message ? e.message : String(e))); }
    }

    // Fixed clock so cooling-off / min-term maths is deterministic.
    var NOW = Date.UTC(2026, 5, 16, 12, 0, 0); // 2026-06-16

    // Snapshot + sandbox the real store so the test never leaks state.
    var BACKUP = HC.store.get(STORE_KEY, null);
    HC.store.set(STORE_KEY, {});

    try {
      var provider = firstProvider() || { id: "test-provider", name: "Test Camp Co" };
      var pid = provider.id != null ? String(provider.id) : "test-provider";

      // Helper to seed a fresh record with a chosen plan + start date.
      function seed(planId, startedAt) {
        var all = readAll();
        var rec = defaultRecord(planId, startedAt);
        rec.startedAt = startedAt;
        all[pid] = rec;
        HC.store.set(STORE_KEY, all);
        return rec;
      }

      var VALID_VISA = "4242 4242 4242 4242";
      var VALID_MC = "5555 5555 5555 4444";
      var VALID_AMEX = "378282246310005";

      // --- Card validation logic ---
      check("Card validation rejects bad cards (Luhn, expiry, CVC, name)", function () {
        HC.assert(!validateCard({ name: "", number: VALID_VISA, expMonth: "12", expYear: "30", cvc: "123" }, NOW).ok, "blank name should fail");
        HC.assert(!validateCard({ name: "X", number: "4242 4242 4242 4241", expMonth: "12", expYear: "30", cvc: "123" }, NOW).ok, "Luhn-invalid number should fail");
        HC.assert(!validateCard({ name: "X", number: VALID_VISA, expMonth: "01", expYear: "20", cvc: "123" }, NOW).ok, "past expiry should fail");
        HC.assert(!validateCard({ name: "X", number: VALID_VISA, expMonth: "13", expYear: "30", cvc: "123" }, NOW).ok, "month 13 should fail");
        HC.assert(!validateCard({ name: "X", number: VALID_VISA, expMonth: "12", expYear: "30", cvc: "12" }, NOW).ok, "2-digit CVC should fail");
        HC.assert(!validateCard({ name: "X", number: VALID_AMEX, expMonth: "12", expYear: "30", cvc: "123" }, NOW).ok, "Amex needs a 4-digit CVC");
        HC.assert(validateCard({ name: "X", number: VALID_AMEX, expMonth: "12", expYear: "30", cvc: "1234" }, NOW).ok, "Amex with 4-digit CVC should pass");
      });

      check("Card brand is detected from the number", function () {
        HC.assert(detectBrand(VALID_VISA).id === "visa", "4xxx is Visa");
        HC.assert(detectBrand(VALID_MC).id === "mastercard", "55xx is Mastercard");
        HC.assert(detectBrand(VALID_AMEX).id === "amex", "37xx is Amex");
      });

      // === ACCEPTANCE CRITERION (part 1): update card details ===
      check("ACCEPTANCE: provider updates the card; dashboard shows the NEW masked card; PAN/CVC never stored", function () {
        seed("annual", NOW - 2 * DAY_MS);
        var res = updateCard(pid, { name: "Adventure Camps Ltd", number: VALID_VISA, expMonth: "11", expYear: "30", cvc: "123" }, NOW);
        HC.assert(res.ok, "a valid card must save: " + JSON.stringify(res.errors || {}));
        HC.assert(res.card.last4 === "4242", "stored last4 should be 4242, got " + res.card.last4);
        HC.assert(res.card.brandLabel === "Visa", "brand should be Visa");
        HC.assert(res.masked.indexOf("4242") !== -1 && res.masked.indexOf("11/30") !== -1, "masked text should show last4 + expiry");

        // What's persisted must be ONLY the safe triplet — no PAN, no CVC.
        var stored = getRecord(pid, "annual");
        var serialized = JSON.stringify(stored);
        HC.assert(serialized.indexOf("4242 4242") === -1, "raw PAN must never be persisted");
        HC.assert(serialized.indexOf("424242424242") === -1, "raw PAN digits must never be persisted");
        HC.assert(!("cvc" in stored.card) && serialized.indexOf("\"cvc\"") === -1, "CVC must never be persisted");
        HC.assert(stored.card.last4 === "4242" && stored.card.expMonth === "11", "dashboard now shows the new card");
      });

      check("A rejected card update leaves the OLD card in place", function () {
        seed("annual", NOW - 2 * DAY_MS);
        updateCard(pid, { name: "Camp Co", number: VALID_VISA, expMonth: "11", expYear: "30", cvc: "123" }, NOW);
        var before = getRecord(pid, "annual").card.last4;
        var bad = updateCard(pid, { name: "Camp Co", number: "1234 5678 9012 3456", expMonth: "11", expYear: "30", cvc: "123" }, NOW);
        HC.assert(!bad.ok, "an invalid card must be rejected");
        var after = getRecord(pid, "annual").card.last4;
        HC.assert(after === before, "the old card must survive a rejected update (" + before + ")");
      });

      // === ACCEPTANCE CRITERION (part 2): cancel the subscription ===
      check("ACCEPTANCE: cancelling moves to 'cancellation_requested', ends Featured Listings + bookings, drops to FREE", function () {
        seed("annual", NOW - 2 * DAY_MS); // within cooling-off
        var r = requestCancellation(pid, { closeAccount: false }, NOW);
        HC.assert(r.ok, "cancellation request should succeed: " + (r.error || ""));
        var rec = getRecord(pid, "annual");
        HC.assert(rec.state === "cancellation_requested", "state must be cancellation_requested, got " + rec.state);
        HC.assert(rec.featuredListings === false, "Featured Listings must be cancelled with the membership");
        HC.assert(rec.bookingsActive === false, "bookings must be deactivated on cancellation");
        HC.assert(rec.cancellation.outcome === "free", "default outcome is a free listing (camps stay live)");
        HC.assert(rec.cancellation.processByTs > NOW, "a 5-working-day processing date should be set in the future");

        // Process it -> lands on FREE, camps stay live.
        var pr = processCancellation(pid, NOW);
        HC.assert(pr.ok && pr.outcome === "free", "processing a non-close cancellation lands on FREE");
        HC.assert(getRecord(pid, "annual").state === "free", "final state should be free");
        HC.assert(getRecord(pid, "annual").listingLive === true, "free listing keeps camps live");
      });

      check("Closing the account on cancellation lands on CLOSED with the profile removed", function () {
        seed("annual", NOW - 2 * DAY_MS);
        var r = requestCancellation(pid, { closeAccount: true }, NOW);
        HC.assert(r.ok, "cancellation+close should succeed");
        HC.assert(getRecord(pid, "annual").cancellation.outcome === "closed", "outcome should be closed");
        var pr = processCancellation(pid, NOW);
        HC.assert(pr.ok && pr.outcome === "closed", "processing should close the account");
        HC.assert(getRecord(pid, "annual").listingLive === false, "a closed account removes the listing");
      });

      // --- Refund rules (evidence 15458402) ---
      check("Annual: refundable inside the 30-day cooling-off, not after", function () {
        seed("annual", NOW - 5 * DAY_MS);
        HC.assert(refundAssessment(getRecord(pid, "annual"), NOW).refundEligible === true, "day 5 should be refundable");
        seed("annual", NOW - 45 * DAY_MS);
        HC.assert(refundAssessment(getRecord(pid, "annual"), NOW).refundEligible === false, "day 45 should NOT be refundable");
      });

      check("Annual cancellation carries the right refund flag onto the request", function () {
        seed("annual", NOW - 3 * DAY_MS);
        var rIn = requestCancellation(pid, {}, NOW);
        HC.assert(rIn.ok && rIn.record.cancellation.refundEligible === true, "in cooling-off -> refund eligible");
        seed("annual", NOW - 60 * DAY_MS);
        var rOut = requestCancellation(pid, {}, NOW);
        HC.assert(rOut.ok && rOut.record.cancellation.refundEligible === false, "out of cooling-off -> not eligible");
      });

      // --- Monthly 9-month minimum term (evidence 2656616 / 15458402) ---
      check("Monthly: cannot cancel inside the 9-month minimum term", function () {
        seed("monthly", NOW - 3 * 30 * DAY_MS); // ~3 months in
        var gate = canRequestCancellation(getRecord(pid, "monthly"), NOW);
        HC.assert(!gate.ok, "month 3 of a monthly plan must be blocked from cancelling");
        var r = requestCancellation(pid, {}, NOW);
        HC.assert(!r.ok, "the cancel action must be refused inside the min term");
        HC.assert(getRecord(pid, "monthly").state === "active", "membership stays active when cancel is refused");
      });

      check("Monthly: can cancel after the 9-month minimum term, with no refund on remaining time", function () {
        seed("monthly", NOW - 10 * 30 * DAY_MS); // ~10 months in
        var gate = canRequestCancellation(getRecord(pid, "monthly"), NOW);
        HC.assert(gate.ok, "month 10 should be allowed to cancel");
        var r = requestCancellation(pid, {}, NOW);
        HC.assert(r.ok, "monthly cancel after min term should succeed");
        HC.assert(r.record.cancellation.refundEligible === false, "monthly never refunds remaining time");
        HC.assert(getRecord(pid, "monthly").state === "cancellation_requested", "monthly cancel moves to requested");
      });

      // --- "Changed my mind" within the processing window ---
      check("A pending cancellation can be undone, restoring the membership and add-ons", function () {
        seed("annual", NOW - 2 * DAY_MS);
        requestCancellation(pid, { closeAccount: false }, NOW);
        var un = reactivate(pid, NOW);
        HC.assert(un.ok, "reactivation should succeed");
        var rec = getRecord(pid, "annual");
        HC.assert(rec.state === "active", "membership should be active again");
        HC.assert(rec.featuredListings === true && rec.bookingsActive === true, "add-ons restored on reactivation");
        HC.assert(rec.cancellation === null, "the pending cancellation is cleared");
      });

      // --- Guards / idempotence ---
      check("Cannot double-cancel, and cannot cancel a free/closed account", function () {
        seed("annual", NOW - 2 * DAY_MS);
        HC.assert(requestCancellation(pid, {}, NOW).ok, "first cancel succeeds");
        HC.assert(!requestCancellation(pid, {}, NOW).ok, "second cancel while pending must be refused");
        processCancellation(pid, NOW); // -> free
        HC.assert(!requestCancellation(pid, {}, NOW).ok, "cannot cancel a free account");
        HC.assert(!updateCard(pid, { name: "X", number: VALID_VISA, expMonth: "12", expYear: "30", cvc: "123" }, NOW).ok === false,
          "updating a card on a free (non-closed) account is still allowed");
      });

      check("Cannot update a card on a CLOSED account", function () {
        seed("annual", NOW - 2 * DAY_MS);
        requestCancellation(pid, { closeAccount: true }, NOW);
        processCancellation(pid, NOW); // -> closed
        var res = updateCard(pid, { name: "X", number: VALID_VISA, expMonth: "12", expYear: "30", cvc: "123" }, NOW);
        HC.assert(!res.ok, "a closed account has no membership to bill");
      });

      // --- Persistence + isolation ---
      check("Card + cancellation persist across a fresh read (round-trip)", function () {
        seed("annual", NOW - 2 * DAY_MS);
        updateCard(pid, { name: "Persist Co", number: VALID_MC, expMonth: "09", expYear: "29", cvc: "321" }, NOW);
        requestCancellation(pid, { closeAccount: false }, NOW);
        var rec = getRecord(pid, "annual");
        HC.assert(rec.card && rec.card.last4 === "4444", "card persists after re-read");
        HC.assert(rec.state === "cancellation_requested", "cancellation persists after re-read");
      });

      check("Records are isolated per provider; camps.js data is untouched", function () {
        var otherId = "another-camp-co-xyz";
        var liveName = provider.name;
        seed("annual", NOW);
        requestCancellation(pid, { closeAccount: true }, NOW);
        // A different provider is unaffected and starts active.
        var other = getRecord(otherId, "annual", NOW);
        HC.assert(other.state === "active", "a different provider is independent and active");
        HC.assert(provider.name === liveName, "the live camps.js provider object must be untouched");
      });

    } finally {
      // Restore the real store exactly as found.
      if (BACKUP === null) HC.store.remove(STORE_KEY);
      else HC.store.set(STORE_KEY, BACKUP);
    }

    return { pass: pass, fail: fail, log: log };
  }

  /* ============================================================
   * 6. Register.
   * ============================================================ */

  HC.registerFeature({
    id: "provider-membership-manage",
    title: "Manage / cancel membership",
    side: "provider",
    icon: "💳",
    summary: "Settings › Membership — update the card we bill and cancel your holiday-camp membership. Cancelling ends Featured Listings and bookings; unless you close the account your camps drop to a free listing and stay live. Annual refunds inside the 30-day cooling-off; monthly has a 9-month minimum term.",
    render: render,
    selfTest: selfTest
  });
})();
