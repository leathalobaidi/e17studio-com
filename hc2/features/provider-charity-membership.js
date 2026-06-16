/* HolidayCamp feature — provider-charity-membership
 *
 * Free "Social Good" Membership for charities & CICs  (PROVIDER side)
 *
 * Replicates Happity's Social Good Membership. Evidence (support article 6076060
 * "Are there Membership Discounts for Charities or CICs?"):
 *   - "Registered charities and Community Interest Companies (CICs) can access
 *      the full benefits of a Happity membership for free, saving £60+VAT
 *      annually."
 *   - "How do I register ... 1. Click Register. 2. Select the option for
 *      Charity/CIC during the registration process. 3. Enter your Registered
 *      Charity Number or CIC Number in the provided field. 4. Submit your
 *      registration for our team to verify and activate your Membership."
 *   - "While Happity Membership is free for charities and CICs, COMMISSION and
 *      booking fees STILL APPLY if you are using our booking system. Similarly,
 *      if you choose to activate Featured Listings, you'll pay monthly
 *      subscription charges for this service as usual."
 *   - "Take fast payments online at just 2.5% commission (vat & Stripe fees
 *      apply)."
 *   - "Can I offer free tickets ... you won't be charged any commission or fees
 *      for tickets that are free."
 *   - Companion article 2656616: "Membership costs £60 per year / £8 per month
 *      (+VAT). ... We offer free Membership to all charities and CICs."
 *
 * Framed for SCHOOL-AGE HOLIDAY CAMPS: a not-for-profit holiday-camp provider
 * (a registered children's charity, or a CIC running community holiday clubs)
 * requests the free Social Good Membership instead of paying the £60+VAT annual
 * fee. They pick "Charity" or "CIC", enter their registration number, and submit
 * for verification. Once activated they get every Membership benefit at zero
 * subscription cost — but, crucially, COMMISSION STILL APPLIES on paid camp
 * places taken through the booking system (free places remain commission-free).
 *
 * ACCEPTANCE CRITERION (exercised by selfTest):
 *   Selecting charity/CIC + reg number requests free membership; commission
 *   still applies.
 *
 * Self-contained, defensive, no imports/exports. Calls HC.registerFeature.
 */
(function () {
  "use strict";

  // Defensive: never throw at module load if HC isn't present.
  if (typeof window === "undefined" || !window.HC || typeof window.HC.registerFeature !== "function") {
    if (typeof console !== "undefined" && console.warn) {
      console.warn("[HC] provider-charity-membership: HC core not found; skipping registration.");
    }
    return;
  }

  var HC = window.HC;

  var STORE_KEY = "provider_charity_membership_state";

  /* ---------------- constants (from the evidence) ---------------- */

  // Eligible non-profit organisation types for the Social Good Membership.
  var ORG_TYPES = ["charity", "cic"];

  // Membership application lifecycle (verification state machine).
  var STATUS = {
    NONE: "none",            // standard provider, no application made
    PENDING: "pending",      // applied; HolidayCamp team to verify the reg number
    ACTIVE: "active",        // verified -> free Social Good Membership live
    REJECTED: "rejected"     // reg number could not be verified
  };

  // The paid annual Membership fee this replaces (evidence 2656616 / 6076060):
  // "£60 per year ... (+VAT)", "saving £60+VAT annually".
  var ANNUAL_FEE_EX_VAT = 60;     // £60 / year, ex-VAT
  var VAT_RATE = 0.20;            // UK VAT 20%

  // Commission charged on PAID bookings through the booking system. This is NOT
  // waived for charities/CICs (evidence 6076060: "commission and booking fees
  // still apply"). 2.5% per the article's Membership benefits list.
  var COMMISSION_PCT = 0.025;    // 2.5%

  /* ---------------- pure logic (testable, DOM-free) ----------------
   *
   * State is a single object persisted via HC.store, keyed by provider id:
   *   {
   *     byProvider: {
   *       <providerId>: {
   *         providerId,
   *         status: one of STATUS.*,
   *         application: null | {
   *           orgType: "charity" | "cic",
   *           regNumber: String,        // normalised registration number
   *           orgName: String,
   *           appliedAt: ISO,
   *           verifiedAt: ISO | null,
   *           membershipFree: Boolean,  // true once active
   *           rejectReason: String | null
   *         },
   *         history: [ { orgType, regNumber, appliedAt, decidedAt, outcome } ]
   *       }
   *     }
   *   }
   *
   * Pure functions take a state and return a NEW state — never mutate in place,
   * so tests run against fresh literals without touching storage.
   */

  function emptyState() {
    return { byProvider: {} };
  }

  function cloneState(state) {
    try {
      return JSON.parse(JSON.stringify(state || {}));
    } catch (e) {
      return emptyState();
    }
  }

  function nowIso() {
    try { return new Date().toISOString(); } catch (e) { return "" + Date.now(); }
  }

  function getRecord(state, providerId) {
    return (state && state.byProvider && state.byProvider[providerId]) || null;
  }

  function ensureRecord(next, providerId) {
    if (!next.byProvider) next.byProvider = {};
    if (!next.byProvider[providerId]) {
      next.byProvider[providerId] = {
        providerId: providerId,
        status: STATUS.NONE,
        application: null,
        history: []
      };
    }
    return next.byProvider[providerId];
  }

  /* ---------------- validation ----------------
   *
   * Charity number: England & Wales registered charities are numeric (6-7
   * digits), optionally with a "-N" subsidiary suffix. We accept 6-8 digits with
   * an optional suffix, which also covers Scottish "SCxxxxxx" and NI "NICxxxxxx"
   * forms loosely.
   *
   * CIC number: a CIC is a company, so it carries a Companies House company
   * number — 8 characters, either 8 digits or 2 letters + 6 digits.
   */

  function normaliseRegNumber(raw) {
    return String(raw == null ? "" : raw).toUpperCase().replace(/[\s\-\/]/g, "");
  }

  function isValidCharityNumber(raw) {
    var n = normaliseRegNumber(raw);
    // England & Wales: 6-8 digits. Scotland: SC + 6 digits. NI: NIC + 6 digits.
    return /^[0-9]{6,8}$/.test(n) ||
      /^SC[0-9]{6}$/.test(n) ||
      /^NIC[0-9]{6}$/.test(n);
  }

  function isValidCicNumber(raw) {
    var n = normaliseRegNumber(raw);
    // Companies House company number: 8 digits, or 2 letters + 6 digits.
    return /^[0-9]{8}$/.test(n) || /^[A-Z]{2}[0-9]{6}$/.test(n);
  }

  function isValidRegNumber(orgType, raw) {
    if (orgType === "charity") return isValidCharityNumber(raw);
    if (orgType === "cic") return isValidCicNumber(raw);
    return false;
  }

  function orgTypeLabel(orgType) {
    if (orgType === "charity") return "Registered charity";
    if (orgType === "cic") return "Community Interest Company (CIC)";
    return "Organisation";
  }

  function regFieldLabel(orgType) {
    if (orgType === "charity") return "Registered Charity Number";
    if (orgType === "cic") return "CIC / Company Number";
    return "Registration Number";
  }

  /* ---------------- actions ---------------- */

  // REQUEST free Social Good Membership. Mirrors the article's registration flow:
  // select Charity/CIC, enter the reg number, submit for verification.
  // Returns { state, ok, error }. On success the application is PENDING.
  function requestMembership(state, providerId, opts) {
    var next = cloneState(state);
    if (!providerId) {
      return { state: next, ok: false, error: "A provider is required." };
    }
    opts = opts || {};
    var orgType = String(opts.orgType || "").toLowerCase();
    if (ORG_TYPES.indexOf(orgType) === -1) {
      return { state: next, ok: false, error: "Select Charity or CIC to request free membership." };
    }
    var regNumber = normaliseRegNumber(opts.regNumber);
    if (!regNumber) {
      return { state: next, ok: false, error: "Enter your " + regFieldLabel(orgType) + "." };
    }
    if (!isValidRegNumber(orgType, regNumber)) {
      return {
        state: next, ok: false,
        error: "That doesn't look like a valid " + regFieldLabel(orgType) + "."
      };
    }
    var rec = ensureRecord(next, providerId);
    if (rec.status === STATUS.ACTIVE) {
      return { state: next, ok: false, error: "Free Social Good Membership is already active for this provider." };
    }
    rec.status = STATUS.PENDING;
    rec.application = {
      orgType: orgType,
      regNumber: regNumber,
      orgName: String(opts.orgName || ""),
      appliedAt: nowIso(),
      verifiedAt: null,
      membershipFree: false,
      rejectReason: null
    };
    return { state: next, ok: true, error: null };
  }

  // VERIFY (HolidayCamp team action): approve a pending application, activating
  // the free membership. Only valid from PENDING. Returns { state, ok, error }.
  function approveMembership(state, providerId) {
    var next = cloneState(state);
    var rec = getRecord(next, providerId);
    if (!rec || rec.status !== STATUS.PENDING || !rec.application) {
      return { state: next, ok: false, error: "No pending membership request to approve." };
    }
    rec.status = STATUS.ACTIVE;
    rec.application.verifiedAt = nowIso();
    rec.application.membershipFree = true;
    rec.application.rejectReason = null;
    pushHistory(rec, "approved");
    return { state: next, ok: true, error: null };
  }

  // REJECT (HolidayCamp team action): the reg number could not be verified.
  function rejectMembership(state, providerId, reason) {
    var next = cloneState(state);
    var rec = getRecord(next, providerId);
    if (!rec || rec.status !== STATUS.PENDING || !rec.application) {
      return { state: next, ok: false, error: "No pending membership request to reject." };
    }
    rec.status = STATUS.REJECTED;
    rec.application.membershipFree = false;
    rec.application.rejectReason = String(reason || "Could not verify the registration number.");
    pushHistory(rec, "rejected");
    return { state: next, ok: true, error: null };
  }

  // Convenience: request + auto-approve in one go (the happy path).
  function requestAndApprove(state, providerId, opts) {
    var r = requestMembership(state, providerId, opts);
    if (!r.ok) return r;
    return approveMembership(r.state, providerId);
  }

  function pushHistory(rec, outcome) {
    if (!Array.isArray(rec.history)) rec.history = [];
    var a = rec.application || {};
    rec.history.push({
      orgType: a.orgType,
      regNumber: a.regNumber,
      appliedAt: a.appliedAt,
      decidedAt: nowIso(),
      outcome: outcome
    });
  }

  /* ---------------- derived queries ---------------- */

  function statusOf(state, providerId) {
    var rec = getRecord(state, providerId);
    return rec ? rec.status : STATUS.NONE;
  }

  // Is the free Social Good Membership active for this provider?
  function hasFreeMembership(state, providerId) {
    var rec = getRecord(state, providerId);
    return !!(rec && rec.status === STATUS.ACTIVE && rec.application && rec.application.membershipFree === true);
  }

  // The annual subscription a provider pays. Charities/CICs with an ACTIVE
  // Social Good Membership pay £0; everyone else pays £60+VAT.
  function annualSubscription(state, providerId) {
    if (hasFreeMembership(state, providerId)) {
      return { exVat: 0, vat: 0, total: 0, free: true };
    }
    var vat = round2(ANNUAL_FEE_EX_VAT * VAT_RATE);
    return { exVat: ANNUAL_FEE_EX_VAT, vat: vat, total: round2(ANNUAL_FEE_EX_VAT + vat), free: false };
  }

  // What the provider SAVES per year by holding the free membership.
  function annualSaving(state, providerId) {
    if (!hasFreeMembership(state, providerId)) return 0;
    var vat = round2(ANNUAL_FEE_EX_VAT * VAT_RATE);
    return round2(ANNUAL_FEE_EX_VAT + vat); // the £60+VAT they no longer pay
  }

  // THE ACCEPTANCE GATE — commission STILL APPLIES, even with free membership.
  // Free tickets (£0 places) are commission-free; paid places are charged 2.5%.
  // amountPounds is the place price; isFree forces a free ticket.
  // Returns { commissionable, rate, commission, providerKeeps }.
  function commissionOnBooking(state, providerId, amountPounds, isFree) {
    var gross = Number(amountPounds);
    var free = isFree === true || !(isFinite(gross) && gross > 0);
    if (free) {
      // Free places carry no commission, regardless of membership type.
      return { commissionable: false, rate: 0, commission: 0, providerKeeps: 0 };
    }
    // Paid place: 2.5% commission applies — membership being free does NOT
    // waive it (this is the acceptance criterion).
    var commission = round2(gross * COMMISSION_PCT);
    return {
      commissionable: true,
      rate: COMMISSION_PCT,
      commission: commission,
      providerKeeps: round2(gross - commission)
    };
  }

  // Does commission apply to a PAID booking for this provider? Always true —
  // free membership never zeroes commission on paid places.
  function commissionAppliesToPaidBookings(state, providerId) {
    return commissionOnBooking(state, providerId, 30, false).commissionable === true;
  }

  function round2(n) {
    var x = Number(n);
    if (!isFinite(x)) return 0;
    return Math.round(x * 100) / 100;
  }

  /* ---------------- persistence helpers (HC.store only) ---------------- */

  function loadState() {
    var raw;
    try { raw = HC.store.get(STORE_KEY, null); } catch (e) { raw = null; }
    if (!raw || typeof raw !== "object" || !raw.byProvider || typeof raw.byProvider !== "object") {
      return emptyState();
    }
    return raw;
  }

  function saveState(state) {
    try { HC.store.set(STORE_KEY, state); } catch (e) {}
  }

  /* ---------------- live camp data ---------------- */

  function providers() {
    try { return HC.data.providers || []; } catch (e) { return []; }
  }

  // Prefer a real not-for-profit holiday-camp provider from the live directory
  // (a "charity"/"CIC"/"trust"/"YMCA" in the name) — the natural Social Good user.
  function pickSeedProvider() {
    var ps = providers();
    var firstWithId = null;
    var NONPROFIT = /charity|charit|\bcic\b|c\.i\.c|community interest|\btrust\b|ymca|foundation|not[- ]for[- ]profit/i;
    for (var i = 0; i < ps.length; i++) {
      var p = ps[i];
      if (!p || !p.id || !p.name) continue;
      if (!firstWithId) firstWithId = p;
      if (NONPROFIT.test(String(p.name))) return p;
    }
    return firstWithId || {
      id: "lloyd-park-childrens-charity",
      name: "Lloyd Park Children's Charity Holiday Club",
      area: "Walthamstow"
    };
  }

  // Read an exact GBP figure from a provider's live price string/object, else fall back.
  function readSamplePrice(seed) {
    try {
      if (seed && seed.price && typeof seed.price === "object") {
        var keys = ["day", "dayExtended", "week", "halfDay"];
        for (var k = 0; k < keys.length; k++) {
          var v = Number(seed.price[keys[k]]);
          if (isFinite(v) && v > 0) return v;
        }
      }
      var s = String((seed && seed.price) || "");
      var m = s.match(/(?:£|GBP\s*)\s*(\d+(?:\.\d{1,2})?)/i);
      if (m) {
        var n = parseFloat(m[1]);
        if (isFinite(n) && n > 0) return n;
      }
    } catch (e) {}
    return 36; // representative school-holiday day-camp price
  }

  /* ---------------- UI ---------------- */

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
  function attr(s) { return esc(s).replace(/"/g, "&quot;"); }

  function statusPillStyle(status) {
    var base = "display:inline-block;font-family:'Quicksand',system-ui,sans-serif;font-weight:700;" +
      "font-size:11px;text-transform:uppercase;letter-spacing:.4px;padding:3px 10px;border-radius:999px;";
    if (status === STATUS.ACTIVE) return base + "background:#E1F0E4;color:#2f7d4f";
    if (status === STATUS.PENDING) return base + "background:#FFF4D6;color:#8a6d00";
    if (status === STATUS.REJECTED) return base + "background:var(--pink-tint,#FCE8F0);color:#9a1f5e";
    return base + "background:var(--purple-tint,#F0E8F4);color:var(--purple,#603488)";
  }

  function statusLabel(status) {
    if (status === STATUS.ACTIVE) return "Social Good Membership · active";
    if (status === STATUS.PENDING) return "Verifying";
    if (status === STATUS.REJECTED) return "Not verified";
    return "Standard (paid) plan";
  }

  function render(mountEl) {
    if (!mountEl) return;

    var state = loadState();
    var seed = pickSeedProvider();
    var providerId = seed.id;

    mountEl.innerHTML = "";
    var wrap = HC.util.el("div", {
      style: "font-family:'Nunito Sans',system-ui,sans-serif;color:var(--text,#383838)"
    });

    var feeEx = HC.util.money(ANNUAL_FEE_EX_VAT);
    wrap.appendChild(HC.util.el("p", { style: "font-size:14px;margin:0 0 14px" },
      "Just like Happity's <strong>Social Good Membership</strong>, HolidayCamp Membership is " +
      "<strong>free for registered charities and CICs</strong> — saving <strong>" + feeEx + "+VAT a year</strong>. " +
      "Pick <strong>Charity</strong> or <strong>CIC</strong>, enter your registration number, and submit it for our team " +
      "to verify. Once active you get every Membership benefit at zero subscription cost — but " +
      "<strong>commission still applies</strong> on paid camp places taken through the booking system " +
      "(free places stay commission-free)."));

    // ---------- application/status card ----------
    var card = HC.util.el("div", {
      style: "border:1.5px solid var(--line,#E6E6E6);border-radius:14px;padding:16px 18px;margin:0 0 16px;background:#fff"
    });
    wrap.appendChild(card);

    // ---------- commission-still-applies box ----------
    var commBox = HC.util.el("div", {
      style: "border:1.5px dashed var(--line,#E6E6E6);border-radius:14px;padding:14px 16px;background:#fff"
    });
    wrap.appendChild(commBox);

    mountEl.appendChild(wrap);

    // Local form state for the org-type selector.
    var formOrgType = "charity";

    function paint() {
      var rec = getRecord(state, providerId);
      var status = rec ? rec.status : STATUS.NONE;
      var app = rec && rec.application;
      var sub = annualSubscription(state, providerId);

      var html =
        '<div style="display:flex;justify-content:space-between;align-items:baseline;gap:10px">' +
          '<span style="font-family:Quicksand,system-ui,sans-serif;font-weight:700;color:var(--purple,#603488);font-size:16px">' +
            esc(seed.name) + "</span>" +
          '<span style="' + statusPillStyle(status) + '">' + esc(statusLabel(status)) + "</span>" +
        "</div>";

      if (status === STATUS.ACTIVE && app) {
        html += '<p style="font-size:13px;margin:8px 0 4px;color:#2f7d4f">✓ Free Social Good Membership is live. ' +
          "Annual subscription: <strong>" + esc(HC.util.money(0)) + "</strong> " +
          "(you're saving <strong>" + esc(HC.util.money(annualSaving(state, providerId))) + "/yr</strong>).</p>" +
          '<div style="font-size:12.5px;color:var(--muted,#808080);margin:0 0 10px">' +
            esc(orgTypeLabel(app.orgType)) + " · " + esc(regFieldLabel(app.orgType)) + " <code>" + esc(app.regNumber) + "</code></div>";
      } else if (status === STATUS.PENDING && app) {
        html += '<p style="font-size:13px;margin:8px 0 10px">Your request is <strong>awaiting verification</strong>. ' +
          "We'll check your " + esc(regFieldLabel(app.orgType)) + " <code>" + esc(app.regNumber) + "</code> and activate your free membership.</p>" +
          '<button class="hc-btn" type="button" data-hccm="approve">Simulate verification ✓</button> ' +
          '<button class="hc-btn hc-btn-ghost" type="button" data-hccm="reject">Simulate rejection</button>';
      } else {
        if (status === STATUS.REJECTED && app) {
          html += '<p style="font-size:12.5px;margin:8px 0 4px;color:#9a1f5e">✗ ' + esc(app.rejectReason || "Could not verify.") +
            " You can re-apply with the correct number.</p>";
        }
        html += '<p style="font-size:13px;margin:8px 0 6px">Currently on the standard plan: <strong>' +
          esc(HC.util.money(sub.total)) + "/yr</strong> (" + esc(HC.util.money(sub.exVat)) + "+VAT). " +
          "Apply for free membership below.</p>" +
          '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:0 0 8px">' +
            '<label style="font-size:12.5px;display:flex;align-items:center;gap:5px">' +
              '<input type="radio" name="hccmOrg" value="charity" ' + (formOrgType === "charity" ? "checked" : "") + "> Charity</label>" +
            '<label style="font-size:12.5px;display:flex;align-items:center;gap:5px">' +
              '<input type="radio" name="hccmOrg" value="cic" ' + (formOrgType === "cic" ? "checked" : "") + "> CIC</label>" +
          "</div>" +
          '<div style="display:flex;gap:8px;flex-wrap:wrap">' +
            '<input id="hccmReg" type="text" placeholder="' + attr(regFieldLabel(formOrgType)) + '" ' +
              'style="flex:1;min-width:180px;padding:9px 11px;border:1.5px solid var(--line,#E6E6E6);border-radius:10px;font-size:14px;box-sizing:border-box">' +
            '<button class="hc-btn" type="button" data-hccm="apply">Request free membership</button>' +
          "</div>" +
          '<p style="font-size:11.5px;color:var(--muted,#808080);margin:8px 0 0">' +
            "Charity numbers are 6-8 digits (e.g. 1234567). CIC numbers are an 8-character company number (e.g. 12345678 or AB123456).</p>";
      }
      card.innerHTML = html;

      // --- commission-still-applies illustration (uses live price) ---
      var sample = readSamplePrice(seed);
      var paid = commissionOnBooking(state, providerId, sample, false);
      var freeT = commissionOnBooking(state, providerId, 0, true);
      commBox.innerHTML =
        '<div style="font-family:Quicksand,system-ui,sans-serif;font-weight:700;color:var(--magenta,#F82488);' +
          'text-transform:uppercase;letter-spacing:.5px;font-size:12px;margin:0 0 6px">Commission still applies</div>' +
        '<div style="font-size:13px;margin:0 0 4px">Even with free membership, a <strong>paid ' + esc(HC.util.money(sample)) +
          " place</strong> is charged <strong>2.5% commission</strong> = " + esc(HC.util.money(paid.commission)) +
          ". You keep <strong>" + esc(HC.util.money(paid.providerKeeps)) + "</strong>.</div>" +
        '<div style="font-size:13px;color:var(--muted,#808080)">A <strong>free place</strong> is charged ' +
          (freeT.commissionable ? "commission" : "<strong>no commission</strong>") + " — " +
          esc(HC.util.money(freeT.commission)) + ".</div>";

      // wire controls
      var orgRadios = card.querySelectorAll('input[name="hccmOrg"]');
      Array.prototype.forEach.call(orgRadios, function (r) {
        r.addEventListener("change", function () {
          if (r.checked) { formOrgType = r.value; paint(); }
        });
      });

      var applyBtn = card.querySelector('[data-hccm="apply"]');
      if (applyBtn) applyBtn.addEventListener("click", function () {
        var regField = card.querySelector("#hccmReg");
        var reg = regField ? regField.value : "";
        var res = requestMembership(state, providerId, {
          orgType: formOrgType,
          regNumber: reg,
          orgName: seed.name
        });
        state = res.state; saveState(state);
        try { HC.util.toast(res.ok ? "Request submitted — awaiting verification" : (res.error || "Could not submit")); } catch (e) {}
        paint();
      });

      var approveBtn = card.querySelector('[data-hccm="approve"]');
      if (approveBtn) approveBtn.addEventListener("click", function () {
        var res = approveMembership(state, providerId);
        state = res.state; saveState(state);
        try { HC.util.toast(res.ok ? "Verified — free Social Good Membership is active" : (res.error || "Could not verify")); } catch (e) {}
        paint();
      });

      var rejectBtn = card.querySelector('[data-hccm="reject"]');
      if (rejectBtn) rejectBtn.addEventListener("click", function () {
        var res = rejectMembership(state, providerId, "We couldn't match that registration number.");
        state = res.state; saveState(state);
        try { HC.util.toast(res.ok ? "Request marked not-verified" : (res.error || "Could not reject")); } catch (e) {}
        paint();
      });
    }

    paint();
  }

  /* ---------------- selfTest ---------------- */

  function selfTest() {
    var pass = 0, fail = 0, log = [];
    function check(label, fn) {
      try { fn(); pass += 1; log.push("✓ " + label); }
      catch (e) { fail += 1; log.push("✗ " + label + " — " + (e && e.message ? e.message : String(e))); }
    }

    var PID = "lloyd-park-childrens-charity";
    var CHARITY_NO = "1234567";   // valid England & Wales charity number (7 digits)
    var CIC_NO = "AB123456";      // valid CIC company number (2 letters + 6 digits)

    // BASELINE: a standard provider pays the £60+VAT fee; no free membership.
    check("Before applying, provider is on the paid plan", function () {
      var s = emptyState();
      HC.assert(statusOf(s, PID) === STATUS.NONE, "status starts 'none'");
      HC.assert(hasFreeMembership(s, PID) === false, "no free membership to begin with");
      var sub = annualSubscription(s, PID);
      HC.assert(sub.free === false, "subscription is not free yet");
      HC.assert(sub.exVat === 60, "ex-VAT fee is £60");
      HC.assert(Math.abs(sub.vat - 12) < 0.001, "VAT on £60 is £12, got " + sub.vat);
      HC.assert(Math.abs(sub.total - 72) < 0.001, "total is £72 (£60+VAT), got " + sub.total);
    });

    // ACCEPTANCE CRITERION, part A: selecting charity + reg number REQUESTS free membership.
    check("Selecting Charity + reg number requests free membership", function () {
      var r = requestMembership(emptyState(), PID, { orgType: "charity", regNumber: CHARITY_NO });
      HC.assert(r.ok === true, "charity request succeeds");
      HC.assert(statusOf(r.state, PID) === STATUS.PENDING, "status becomes 'pending' (awaiting verification)");
      var app = getRecord(r.state, PID).application;
      HC.assert(app.orgType === "charity", "org type recorded as charity");
      HC.assert(app.regNumber === CHARITY_NO, "reg number captured, got " + app.regNumber);
      HC.assert(app.membershipFree === false, "not free until verified");
      // Pending is not yet free.
      HC.assert(hasFreeMembership(r.state, PID) === false, "pending != active free membership");
    });

    // ACCEPTANCE CRITERION, part A (CIC variant): selecting CIC + reg number requests free membership.
    check("Selecting CIC + reg number requests free membership", function () {
      var r = requestMembership(emptyState(), PID, { orgType: "cic", regNumber: CIC_NO });
      HC.assert(r.ok === true, "CIC request succeeds");
      HC.assert(statusOf(r.state, PID) === STATUS.PENDING, "status pending after CIC request");
      var app = getRecord(r.state, PID).application;
      HC.assert(app.orgType === "cic", "org type recorded as cic");
      HC.assert(app.regNumber === CIC_NO, "CIC number captured, got " + app.regNumber);
    });

    // Verification activates the FREE membership (subscription drops to £0).
    check("Verification activates free membership and zeroes the subscription", function () {
      var r = requestAndApprove(emptyState(), PID, { orgType: "charity", regNumber: CHARITY_NO });
      HC.assert(r.ok === true, "request + approve succeeds");
      HC.assert(statusOf(r.state, PID) === STATUS.ACTIVE, "status becomes 'active'");
      HC.assert(hasFreeMembership(r.state, PID) === true, "free Social Good Membership is now active");
      var sub = annualSubscription(r.state, PID);
      HC.assert(sub.free === true && sub.total === 0, "annual subscription is now £0");
      HC.assert(Math.abs(annualSaving(r.state, PID) - 72) < 0.001, "saves £72/yr (£60+VAT), got " + annualSaving(r.state, PID));
    });

    // ACCEPTANCE CRITERION, part B: COMMISSION STILL APPLIES on paid bookings,
    // even with free membership.
    check("Commission STILL applies on paid bookings with free membership", function () {
      var r = requestAndApprove(emptyState(), PID, { orgType: "charity", regNumber: CHARITY_NO });
      HC.assert(hasFreeMembership(r.state, PID) === true, "precondition: free membership active");
      // A paid £40 camp place is still charged 2.5% commission.
      var paid = commissionOnBooking(r.state, PID, 40, false);
      HC.assert(paid.commissionable === true, "a paid place IS commissionable despite free membership");
      HC.assert(Math.abs(paid.rate - 0.025) < 1e-9, "commission rate is 2.5%, got " + paid.rate);
      HC.assert(Math.abs(paid.commission - 1) < 0.001, "2.5% of £40 = £1.00 commission, got " + paid.commission);
      HC.assert(Math.abs(paid.providerKeeps - 39) < 0.001, "provider keeps £39 of a £40 place, got " + paid.providerKeeps);
      HC.assert(commissionAppliesToPaidBookings(r.state, PID) === true, "commission applies to paid bookings flag is true");
    });

    // The same commission applies whether or not the provider has free membership
    // — free membership does NOT waive booking commission.
    check("Free membership does not change commission vs a paying provider", function () {
      var free = requestAndApprove(emptyState(), PID, { orgType: "cic", regNumber: CIC_NO }).state;
      var paying = emptyState(); // never applied -> standard paid plan
      var cFree = commissionOnBooking(free, PID, 50, false);
      var cPay = commissionOnBooking(paying, "some-paying-camp", 50, false);
      HC.assert(cFree.commission === cPay.commission, "commission identical for free-member and paying provider");
      HC.assert(cFree.commissionable === true && cPay.commissionable === true, "both pay commission on paid places");
      HC.assert(Math.abs(cFree.commission - 1.25) < 0.001, "2.5% of £50 = £1.25, got " + cFree.commission);
    });

    // FREE tickets carry NO commission (evidence: free tickets are fee-free).
    check("Free places carry no commission", function () {
      var r = requestAndApprove(emptyState(), PID, { orgType: "charity", regNumber: CHARITY_NO });
      var freeByFlag = commissionOnBooking(r.state, PID, 40, true);   // explicit free ticket
      HC.assert(freeByFlag.commissionable === false, "a free-flagged place is not commissionable");
      HC.assert(freeByFlag.commission === 0, "no commission on a free-flagged place");
      var freeByZero = commissionOnBooking(r.state, PID, 0, false);   // £0 price
      HC.assert(freeByZero.commissionable === false, "a £0 place is not commissionable");
      HC.assert(freeByZero.commission === 0, "no commission on a £0 place");
    });

    // Org-type guard: only charity/CIC are eligible.
    check("Only charity or CIC may request free membership", function () {
      var bad = requestMembership(emptyState(), PID, { orgType: "ltd", regNumber: CIC_NO });
      HC.assert(bad.ok === false, "a normal Ltd company cannot request the Social Good Membership");
      HC.assert(/charity or cic/i.test(bad.error || ""), "error names the eligible types, got: " + bad.error);
      var none = requestMembership(emptyState(), PID, { regNumber: CHARITY_NO });
      HC.assert(none.ok === false, "missing org type is rejected");
    });

    // Reg-number validation: a number is REQUIRED and must look valid.
    check("A valid registration number is required", function () {
      var missing = requestMembership(emptyState(), PID, { orgType: "charity", regNumber: "" });
      HC.assert(missing.ok === false, "empty reg number rejected");
      HC.assert(/charity number/i.test(missing.error || ""), "error asks for the charity number, got: " + missing.error);
      var bogusCharity = requestMembership(emptyState(), PID, { orgType: "charity", regNumber: "12" });
      HC.assert(bogusCharity.ok === false, "too-short charity number rejected");
      var bogusCic = requestMembership(emptyState(), PID, { orgType: "cic", regNumber: "12" });
      HC.assert(bogusCic.ok === false, "too-short CIC number rejected");
      // A charity number is NOT a valid CIC number form (digits length differs) and vice versa where applicable.
      HC.assert(isValidCharityNumber("1234567") === true, "7-digit charity number is valid");
      HC.assert(isValidCharityNumber("SC012345") === true, "Scottish SC charity number is valid");
      HC.assert(isValidCicNumber("12345678") === true, "8-digit CIC company number is valid");
      HC.assert(isValidCicNumber("AB123456") === true, "letter-prefixed CIC company number is valid");
      HC.assert(isValidCicNumber("1234567") === false, "7 digits is not a valid CIC company number");
    });

    // Reg numbers are normalised (spaces, slashes, hyphens, case stripped).
    check("Registration numbers are normalised before storage", function () {
      var r = requestMembership(emptyState(), PID, { orgType: "cic", regNumber: " ab 12-34/56 " });
      HC.assert(r.ok === true, "messy but valid CIC number accepted");
      HC.assert(getRecord(r.state, PID).application.regNumber === "AB123456", "normalised to AB123456, got " +
        getRecord(r.state, PID).application.regNumber);
    });

    // Rejection path: an unverifiable number is rejected and can be re-applied.
    check("A rejected application can be re-submitted", function () {
      var r = requestMembership(emptyState(), PID, { orgType: "charity", regNumber: CHARITY_NO });
      var rej = rejectMembership(r.state, PID, "No match at the Charity Commission.");
      HC.assert(rej.ok === true, "rejection succeeds");
      HC.assert(statusOf(rej.state, PID) === STATUS.REJECTED, "status is 'rejected'");
      HC.assert(hasFreeMembership(rej.state, PID) === false, "rejected -> no free membership");
      // Commission obviously still applies for a rejected (paid-plan) provider.
      HC.assert(commissionOnBooking(rej.state, PID, 30, false).commissionable === true, "paid plan still commissionable");
      // Re-apply with a fresh number -> back to pending.
      var again = requestMembership(rej.state, PID, { orgType: "charity", regNumber: "7654321" });
      HC.assert(again.ok === true && statusOf(again.state, PID) === STATUS.PENDING, "can re-apply after rejection");
    });

    // Cannot re-request once membership is already ACTIVE (idempotent guard).
    check("Cannot re-request when membership is already active", function () {
      var r = requestAndApprove(emptyState(), PID, { orgType: "charity", regNumber: CHARITY_NO });
      var again = requestMembership(r.state, PID, { orgType: "cic", regNumber: CIC_NO });
      HC.assert(again.ok === false, "re-requesting while active is blocked");
      HC.assert(/already active/i.test(again.error || ""), "error says it's already active, got: " + again.error);
      HC.assert(hasFreeMembership(again.state, PID) === true, "membership stays active");
    });

    // Approve/reject guards: only a PENDING application can be decided.
    check("Approve/reject require a pending application", function () {
      var s = emptyState();
      HC.assert(approveMembership(s, PID).ok === false, "nothing to approve on empty state");
      HC.assert(rejectMembership(s, PID).ok === false, "nothing to reject on empty state");
      // After approval, a second approval is a no-op (not pending anymore).
      var r = requestAndApprove(emptyState(), PID, { orgType: "charity", regNumber: CHARITY_NO });
      HC.assert(approveMembership(r.state, PID).ok === false, "cannot approve an already-active membership");
    });

    // Provider isolation: one camp's membership does not affect another's commission.
    check("Membership is isolated per provider", function () {
      var s = requestAndApprove(emptyState(), "charity-camp", { orgType: "charity", regNumber: CHARITY_NO }).state;
      HC.assert(hasFreeMembership(s, "charity-camp") === true, "charity-camp has free membership");
      HC.assert(hasFreeMembership(s, "other-camp") === false, "other-camp unaffected");
      // Both still pay commission on paid places.
      HC.assert(commissionOnBooking(s, "charity-camp", 30, false).commissionable === true, "charity-camp paid place commissionable");
      HC.assert(commissionOnBooking(s, "other-camp", 30, false).commissionable === true, "other-camp paid place commissionable");
      HC.assert(annualSubscription(s, "charity-camp").total === 0, "charity-camp pays £0 subscription");
      HC.assert(annualSubscription(s, "other-camp").total === 72, "other-camp still pays £72");
    });

    // History records each decision (audit trail of the verification).
    check("Each verification decision is recorded in history", function () {
      var r = requestMembership(emptyState(), PID, { orgType: "charity", regNumber: CHARITY_NO });
      var ap = approveMembership(r.state, PID);
      var hist = getRecord(ap.state, PID).history;
      HC.assert(Array.isArray(hist) && hist.length === 1, "one history entry after approval, got " + (hist && hist.length));
      HC.assert(hist[0].outcome === "approved", "outcome recorded as approved");
      HC.assert(hist[0].regNumber === CHARITY_NO, "history keeps the reg number applied");
    });

    // Defensive: bad inputs must not throw or corrupt state.
    check("Defensive against missing providers and junk inputs", function () {
      var s = emptyState();
      HC.assert(getRecord(s, "nope") === null, "missing record returns null, not a throw");
      HC.assert(hasFreeMembership(s, "nope") === false, "missing provider -> no free membership");
      HC.assert(requestMembership(s, "", { orgType: "charity", regNumber: CHARITY_NO }).ok === false, "no provider id fails cleanly");
      // Junk booking amounts -> no commission, no throw.
      HC.assert(commissionOnBooking(s, PID, "x", false).commission === 0, "junk amount -> £0 commission");
      HC.assert(commissionOnBooking(s, PID, -5, false).commission === 0, "negative amount -> £0 commission");
      HC.assert(commissionOnBooking(s, PID, NaN, false).commissionable === false, "NaN amount not commissionable");
      // requestMembership with no opts must not throw.
      HC.assert(requestMembership(s, PID).ok === false, "requestMembership with no opts fails cleanly");
    });

    // Persistence round-trips through HC.store (namespaced, not raw localStorage).
    check("Membership state persists via HC.store", function () {
      var r = requestAndApprove(emptyState(), PID, { orgType: "charity", regNumber: CHARITY_NO });
      var ok = HC.store.set(STORE_KEY, r.state);
      HC.assert(ok !== false, "store.set should succeed");
      var got = HC.store.get(STORE_KEY, null);
      HC.assert(got && got.byProvider && got.byProvider[PID], "record survives a store round-trip");
      HC.assert(got.byProvider[PID].status === STATUS.ACTIVE, "status survives persistence");
      HC.assert(hasFreeMembership(got, PID) === true, "free-membership flag survives persistence");
      // Commission still applies after reload.
      HC.assert(commissionOnBooking(got, PID, 30, false).commissionable === true, "commission still applies after reload");
      try { HC.store.remove ? HC.store.remove(STORE_KEY) : HC.store.set(STORE_KEY, null); } catch (e) {}
    });

    // Seed provider is drawn from the LIVE school-age holiday-camp directory.
    check("Seed provider comes from the live holiday-camp directory", function () {
      var seed = pickSeedProvider();
      HC.assert(seed && typeof seed.id === "string" && seed.id.length > 0, "seed has a provider id");
      HC.assert(typeof seed.name === "string" && seed.name.length > 0, "seed has a provider name");
      var ps = providers();
      if (ps.length) {
        var found = ps.some(function (p) { return p && p.id === seed.id; });
        HC.assert(found, "seed should be a real directory provider when data is present");
      }
      HC.assert(readSamplePrice(seed) > 0, "a positive sample price is derived for the commission demo");
    });

    return { pass: pass, fail: fail, log: log };
  }

  /* ---------------- register ---------------- */

  HC.registerFeature({
    id: "provider-charity-membership",
    title: "Free 'Social Good' Membership for charities & CICs",
    side: "provider",
    icon: "💚",
    summary: "Just like Happity's Social Good Membership: registered charities and CICs get free HolidayCamp Membership " +
      "(saving £60+VAT/yr). Pick Charity or CIC, enter your registration number, and submit for verification. " +
      "Commission still applies on paid camp places — free places stay commission-free.",
    render: render,
    selfTest: selfTest
  });
})();
