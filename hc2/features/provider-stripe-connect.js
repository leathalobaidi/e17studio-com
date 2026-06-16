/* HolidayCamp feature — provider-stripe-connect
 *
 * Connect Stripe (payouts to provider's OWN account, 3-5 days)  (PROVIDER side)
 *
 * Replicates Happity's Stripe Connect onboarding. Evidence (support articles):
 *   - 3563847 "Online Payment Processing - What you need to know":
 *       "Payments made via Happity go directly into your Stripe account. This
 *        means you can access your payments as soon as they've been processed
 *        (within 3-5 days)..." Stripe fee = 1.5% + 20p per transaction.
 *   - 6172201 "When will I receive my money from Stripe?":
 *       "We do not hold on to any money from the bookings ... These go straight
 *        into your account and as soon as Stripe has processed the payment it
 *        will be available for withdrawal to your bank account. This usually
 *        takes around 3 to 5 working days. Your default pay-out schedule is set
 *        to automatically pay out on a daily basis and you can change this ...
 *        to weekly automatic, monthly automatic, or manual pay-outs."
 *   - 5972981 "Can I connect more than one Stripe account to my Happity profile?":
 *       "It is NOT possible to have more than one Stripe account connected ...
 *        However, you can REMOVE one Stripe account and connect an alternative
 *        account at any time."
 *
 * Framed for SCHOOL-AGE HOLIDAY CAMPS: a holiday-camp provider connects their
 * own Stripe account so parents can pay for camp places online. Booking money
 * lands directly in the provider's Stripe (HolidayCamp never holds it), with
 * funds available to withdraw to their bank in 3-5 working days. Exactly ONE
 * Stripe account may be connected per provider; to switch banks they disconnect
 * the old account first, then connect a new one.
 *
 * ACCEPTANCE CRITERION (exercised by selfTest):
 *   Connecting Stripe enables paid bookings; only one Stripe account per provider.
 *
 * Self-contained, defensive, no imports/exports. Calls HC.registerFeature.
 */
(function () {
  "use strict";

  // Defensive: never throw at module load if HC isn't present.
  if (typeof window === "undefined" || !window.HC || typeof window.HC.registerFeature !== "function") {
    if (typeof console !== "undefined" && console.warn) {
      console.warn("[HC] provider-stripe-connect: HC core not found; skipping registration.");
    }
    return;
  }

  var HC = window.HC;

  var STORE_KEY = "provider_stripe_connect_state";

  // Stripe Connect account lifecycle (the connection state machine).
  var STATUS = {
    NONE: "not connected",       // no Stripe account attached -> paid bookings disabled
    PENDING: "pending",          // OAuth started, Stripe still verifying details
    CONNECTED: "connected"       // verified & payouts enabled -> paid bookings on
  };

  // Payout schedules Stripe exposes (evidence 6172201). Default = daily.
  var SCHEDULES = ["daily", "weekly", "monthly", "manual"];
  var DEFAULT_SCHEDULE = "daily";

  // Funds availability window after Stripe processes a payment (evidence 3563847 / 6172201).
  var PAYOUT_MIN_DAYS = 3;
  var PAYOUT_MAX_DAYS = 5;

  // Stripe's per-transaction processing fee quoted by Happity (evidence 3563847).
  var STRIPE_FEE_PCT = 0.015;   // 1.5%
  var STRIPE_FEE_FIXED_P = 20;  // 20p, expressed in pence

  /* ---------------- pure logic (testable, DOM-free) ----------------
   *
   * State is a single object persisted via HC.store, keyed by provider id:
   *   {
   *     byProvider: {
   *       <providerId>: {
   *         providerId,
   *         status: one of STATUS.*,
   *         account: null | {
   *           stripeId: String,     // e.g. "acct_..." (the ONE connected account)
   *           email: String,
   *           bankLast4: String,    // mock destination bank
   *           payoutSchedule: one of SCHEDULES,
   *           connectedAt: ISO,
   *           payoutsEnabled: Boolean
   *         },
   *         history: [ { stripeId, email, connectedAt, disconnectedAt } ]
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

  function safeUid() {
    try { return HC.util.uid(); } catch (e) { return "id_" + Math.random().toString(36).slice(2); }
  }

  // A mock Stripe account id. Real Stripe Connect ids look like "acct_1AbCDe...".
  function makeStripeId() {
    return "acct_" + safeUid().replace(/[^a-z0-9]/gi, "").slice(0, 16);
  }

  function getRecord(state, providerId) {
    return (state && state.byProvider && state.byProvider[providerId]) || null;
  }

  // Ensure a record exists for a provider (returns the live record on `next`).
  function ensureRecord(next, providerId) {
    if (!next.byProvider) next.byProvider = {};
    if (!next.byProvider[providerId]) {
      next.byProvider[providerId] = {
        providerId: providerId,
        status: STATUS.NONE,
        account: null,
        history: []
      };
    }
    return next.byProvider[providerId];
  }

  // STEP 1 — START CONNECT. Kicks off the (mock) Stripe OAuth handshake. The
  // account is created in 'pending' until Stripe confirms verification.
  // GUARD: refuse if an account is already connected — only ONE per provider
  // (evidence 5972981). Returns { state, ok, error, stripeId }.
  function startConnect(state, providerId, details) {
    var next = cloneState(state);
    if (!providerId) return { state: next, ok: false, error: "A provider is required.", stripeId: null };
    var rec = ensureRecord(next, providerId);
    if (rec.status === STATUS.CONNECTED && rec.account) {
      return {
        state: next, ok: false, stripeId: null,
        error: "A Stripe account is already connected. Disconnect it first — only one Stripe account is allowed per provider."
      };
    }
    details = details || {};
    var stripeId = details.stripeId || makeStripeId();
    rec.status = STATUS.PENDING;
    rec.account = {
      stripeId: stripeId,
      email: String(details.email || ""),
      bankLast4: String(details.bankLast4 || "").slice(-4),
      payoutSchedule: DEFAULT_SCHEDULE,
      connectedAt: null,
      payoutsEnabled: false
    };
    return { state: next, ok: true, error: null, stripeId: stripeId };
  }

  // STEP 2 — COMPLETE CONNECT. Stripe finished verifying (mock); payouts are
  // enabled and the account becomes 'connected'. Only valid from 'pending'.
  // Returns { state, ok, error }.
  function completeConnect(state, providerId) {
    var next = cloneState(state);
    var rec = getRecord(next, providerId);
    if (!rec || rec.status !== STATUS.PENDING || !rec.account) {
      return { state: next, ok: false, error: "No pending Stripe connection to complete." };
    }
    rec.status = STATUS.CONNECTED;
    rec.account.payoutsEnabled = true;
    rec.account.connectedAt = nowIso();
    return { state: next, ok: true, error: null };
  }

  // Convenience: do the whole handshake in one go (start + complete).
  function connectStripe(state, providerId, details) {
    var s = startConnect(state, providerId, details);
    if (!s.ok) return { state: s.state, ok: false, error: s.error, stripeId: null };
    var c = completeConnect(s.state, providerId);
    return { state: c.state, ok: c.ok, error: c.error, stripeId: s.stripeId };
  }

  // DISCONNECT. Removes the connected (or pending) account, archives it to
  // history, and turns paid bookings back off (evidence 5972981: you remove one
  // and connect an alternative). Returns { state, ok, error }.
  function disconnectStripe(state, providerId) {
    var next = cloneState(state);
    var rec = getRecord(next, providerId);
    if (!rec || !rec.account) {
      return { state: next, ok: false, error: "No Stripe account is connected." };
    }
    if (!Array.isArray(rec.history)) rec.history = [];
    rec.history.push({
      stripeId: rec.account.stripeId,
      email: rec.account.email,
      connectedAt: rec.account.connectedAt,
      disconnectedAt: nowIso()
    });
    rec.account = null;
    rec.status = STATUS.NONE;
    return { state: next, ok: true, error: null };
  }

  // Change the payout schedule (only meaningful on a connected account).
  function setPayoutSchedule(state, providerId, schedule) {
    var next = cloneState(state);
    var rec = getRecord(next, providerId);
    if (!rec || rec.status !== STATUS.CONNECTED || !rec.account) {
      return { state: next, ok: false, error: "Connect Stripe before choosing a payout schedule." };
    }
    if (SCHEDULES.indexOf(schedule) === -1) {
      return { state: next, ok: false, error: "Unknown payout schedule." };
    }
    rec.account.payoutSchedule = schedule;
    return { state: next, ok: true, error: null };
  }

  /* ---------------- derived queries ---------------- */

  // THE ACCEPTANCE GATE: are paid (online) bookings enabled for this provider?
  // True only when a Stripe account is connected and payouts are enabled.
  function paidBookingsEnabled(state, providerId) {
    var rec = getRecord(state, providerId);
    return !!(rec && rec.status === STATUS.CONNECTED && rec.account && rec.account.payoutsEnabled === true);
  }

  // How many Stripe accounts are currently connected for a provider? (Invariant: 0 or 1.)
  function connectedAccountCount(state, providerId) {
    var rec = getRecord(state, providerId);
    return (rec && rec.account) ? 1 : 0;
  }

  function statusOf(state, providerId) {
    var rec = getRecord(state, providerId);
    return rec ? rec.status : STATUS.NONE;
  }

  // Mock the Stripe processing fee on a booking amount (in pounds). Returns an
  // object of pounds: { gross, fee, net } — money the provider actually keeps.
  function stripeFee(amountPounds) {
    var gross = Number(amountPounds);
    if (!isFinite(gross) || gross <= 0) return { gross: 0, fee: 0, net: 0 };
    var feePence = Math.round(gross * 100 * STRIPE_FEE_PCT) + STRIPE_FEE_FIXED_P;
    var fee = feePence / 100;
    return { gross: gross, fee: fee, net: Math.round((gross - fee) * 100) / 100 };
  }

  function payoutWindowLabel() {
    return PAYOUT_MIN_DAYS + "-" + PAYOUT_MAX_DAYS + " working days";
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

  // Prefer a PAID school-age camp provider for the demo (paid bookings is the point).
  function pickSeedProvider() {
    var ps = providers();
    var firstWithId = null;
    for (var i = 0; i < ps.length; i++) {
      var p = ps[i];
      if (!p || !p.id || !p.name) continue;
      if (!firstWithId) firstWithId = p;
      var funding = (p.funding || []).join(" ").toLowerCase();
      var price = String(p.price || "").toLowerCase();
      if (funding.indexOf("paid") !== -1 || /£|gbp|\bfrom\b/.test(price)) return p;
    }
    return firstWithId || { id: "demo-camp", name: "Lloyd Park Holiday Camp", area: "Walthamstow", ageLabel: "5-12" };
  }

  function seedEmail(seed) {
    var slug = String((seed && seed.id) || "camp").replace(/[^a-z0-9]/gi, "").slice(0, 16);
    return "payments@" + (slug || "camp") + ".example";
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
    if (status === STATUS.CONNECTED) return base + "background:#E1F0E4;color:#2f7d4f";
    if (status === STATUS.PENDING) return base + "background:#FFF4D6;color:#8a6d00";
    return base + "background:var(--pink-tint,#FCE8F0);color:#9a1f5e"; // not connected
  }

  function statusLabel(status) {
    if (status === STATUS.CONNECTED) return "Connected";
    if (status === STATUS.PENDING) return "Verifying with Stripe";
    return "Not connected";
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

    wrap.appendChild(HC.util.el("p", { style: "font-size:14px;margin:0 0 14px" },
      "Just like Happity, HolidayCamp takes online payments through <strong>Stripe</strong>. " +
      "You connect <strong>your own</strong> Stripe account, so booking money goes <strong>straight to you</strong> — " +
      "HolidayCamp never holds it. Funds are available to withdraw to your bank in <strong>" +
      payoutWindowLabel() + "</strong>. You can connect <strong>only one</strong> Stripe account at a time."));

    // ---------- connection status card ----------
    var card = HC.util.el("div", {
      style: "border:1.5px solid var(--line,#E6E6E6);border-radius:14px;padding:16px 18px;margin:0 0 16px;background:#fff"
    });
    wrap.appendChild(card);

    // ---------- paid-bookings indicator ----------
    var gate = HC.util.el("div", {
      style: "border:1.5px solid var(--line,#E6E6E6);border-radius:14px;padding:14px 16px;margin:0 0 16px;background:#fff"
    });
    wrap.appendChild(gate);

    // ---------- fee illustration ----------
    var feeBox = HC.util.el("div", {
      style: "border:1.5px dashed var(--line,#E6E6E6);border-radius:14px;padding:14px 16px;background:#fff"
    });
    wrap.appendChild(feeBox);

    mountEl.appendChild(wrap);

    function paint() {
      var rec = getRecord(state, providerId);
      var status = rec ? rec.status : STATUS.NONE;
      var acc = rec && rec.account;

      // --- status card ---
      var html =
        '<div style="display:flex;justify-content:space-between;align-items:baseline;gap:10px">' +
          '<span style="font-family:Quicksand,system-ui,sans-serif;font-weight:700;color:var(--purple,#603488);font-size:16px">' +
            esc(seed.name) + "</span>" +
          '<span style="' + statusPillStyle(status) + '">' + esc(statusLabel(status)) + "</span>" +
        "</div>";

      if (status === STATUS.NONE) {
        html += '<p style="font-size:13px;margin:8px 0 12px">No Stripe account is connected, so this camp ' +
          "<strong>cannot take online payments</strong> yet. Connect Stripe (it takes about 2 minutes) to switch on paid bookings.</p>" +
          '<div style="display:flex;gap:8px;flex-wrap:wrap">' +
            '<input id="hcscEmail" type="email" placeholder="Stripe account email" value="' + attr(seedEmail(seed)) + '" ' +
              'style="flex:1;min-width:180px;padding:9px 11px;border:1.5px solid var(--line,#E6E6E6);border-radius:10px;font-size:14px;box-sizing:border-box">' +
            '<button class="hc-btn" type="button" data-hcsc="connect">Connect with Stripe</button>' +
          "</div>";
      } else if (status === STATUS.PENDING) {
        html += '<p style="font-size:13px;margin:8px 0 12px">Stripe is <strong>verifying your details</strong>. ' +
          "Paid bookings stay off until verification finishes.</p>" +
          '<button class="hc-btn" type="button" data-hcsc="complete">Finish Stripe verification</button>';
      } else if (status === STATUS.CONNECTED && acc) {
        html += '<p style="font-size:13px;margin:8px 0 4px;color:#2f7d4f">✓ Connected. Booking payments go ' +
          "<strong>directly to your Stripe account</strong> and are available to withdraw in <strong>" +
          payoutWindowLabel() + "</strong>.</p>" +
          '<div style="font-size:12.5px;color:var(--muted,#808080);margin:0 0 10px">' +
            "Account <code>" + esc(acc.stripeId) + "</code>" + (acc.email ? " · " + esc(acc.email) : "") + "</div>" +
          '<label style="display:block;font-size:11.5px;color:var(--muted,#808080);margin:0 0 3px">Payout schedule</label>' +
          '<select id="hcscSched" style="padding:8px 10px;border:1.5px solid var(--line,#E6E6E6);border-radius:10px;font-size:13.5px;margin:0 0 12px">' +
            SCHEDULES.map(function (s) {
              return '<option value="' + attr(s) + '"' + (acc.payoutSchedule === s ? " selected" : "") + ">" +
                esc(s.charAt(0).toUpperCase() + s.slice(1)) + (s === DEFAULT_SCHEDULE ? " (default)" : "") + "</option>";
            }).join("") +
          "</select><br>" +
          '<button class="hc-btn hc-btn-ghost" type="button" data-hcsc="disconnect">Disconnect Stripe</button>' +
          '<p style="font-size:11.5px;color:var(--muted,#808080);margin:10px 0 0">' +
            "Switching banks? Disconnect this account first, then connect the new one — only one Stripe account can be attached at a time.</p>";
      }
      card.innerHTML = html;

      // --- paid-bookings gate ---
      var enabled = paidBookingsEnabled(state, providerId);
      gate.innerHTML =
        '<div style="display:flex;align-items:center;gap:10px">' +
          '<span style="font-size:22px">' + (enabled ? "🟢" : "🔴") + "</span>" +
          "<div>" +
            '<div style="font-family:Quicksand,system-ui,sans-serif;font-weight:700;color:var(--purple,#603488);font-size:14.5px">' +
              "Paid bookings " + (enabled ? "enabled" : "disabled") + "</div>" +
            '<div style="font-size:12.5px;color:var(--muted,#808080)">' +
              (enabled
                ? "Parents can pay for camp places online. " + connectedAccountCount(state, providerId) + " Stripe account connected (max 1)."
                : "Connect a Stripe account to let parents pay online.") +
            "</div>" +
          "</div>" +
        "</div>";

      // --- fee illustration (uses the live-data price where we can read one) ---
      var sample = readSamplePrice(seed);
      var f = stripeFee(sample);
      feeBox.innerHTML =
        '<div style="font-family:Quicksand,system-ui,sans-serif;font-weight:700;color:var(--magenta,#F82488);' +
          'text-transform:uppercase;letter-spacing:.5px;font-size:12px;margin:0 0 6px">Stripe fee on a ' +
          esc(HC.util.money(sample)) + " place</div>" +
        '<div style="font-size:13px">Stripe takes <strong>1.5% + 20p</strong> = ' + esc(HC.util.money(f.fee)) +
          ". You keep <strong>" + esc(HC.util.money(f.net)) + "</strong> of every " + esc(HC.util.money(f.gross)) + " booking.</div>";

      // wire controls
      var connectBtn = card.querySelector('[data-hcsc="connect"]');
      if (connectBtn) connectBtn.addEventListener("click", function () {
        var emailField = card.querySelector("#hcscEmail");
        var email = emailField ? emailField.value : "";
        var res = startConnect(state, providerId, { email: email, bankLast4: "4242" });
        state = res.state; saveState(state);
        if (!res.ok) { try { HC.util.toast(res.error); } catch (e) {} }
        else { try { HC.util.toast("Redirecting to Stripe… details captured"); } catch (e) {} }
        paint();
      });

      var completeBtn = card.querySelector('[data-hcsc="complete"]');
      if (completeBtn) completeBtn.addEventListener("click", function () {
        var res = completeConnect(state, providerId);
        state = res.state; saveState(state);
        try { HC.util.toast(res.ok ? "Stripe connected — paid bookings are now on" : (res.error || "Could not finish")); } catch (e) {}
        paint();
      });

      var disconnectBtn = card.querySelector('[data-hcsc="disconnect"]');
      if (disconnectBtn) disconnectBtn.addEventListener("click", function () {
        var res = disconnectStripe(state, providerId);
        state = res.state; saveState(state);
        try { HC.util.toast(res.ok ? "Stripe disconnected — paid bookings are off" : (res.error || "Nothing to disconnect")); } catch (e) {}
        paint();
      });

      var schedSelect = card.querySelector("#hcscSched");
      if (schedSelect) schedSelect.addEventListener("change", function () {
        var res = setPayoutSchedule(state, providerId, schedSelect.value);
        state = res.state; saveState(state);
        if (res.ok) { try { HC.util.toast("Payout schedule set to " + schedSelect.value); } catch (e) {} }
        paint();
      });
    }

    paint();
  }

  // Read an exact GBP figure from a provider's live price string, else fall back.
  function readSamplePrice(seed) {
    var price = String((seed && seed.price) || "");
    var m = price.match(/(?:£|GBP\s*)\s*(\d+(?:\.\d{1,2})?)/i);
    if (m) {
      var n = parseFloat(m[1]);
      if (isFinite(n) && n > 0) return n;
    }
    return 36; // a representative school-holiday day-camp price
  }

  /* ---------------- selfTest ---------------- */

  function selfTest() {
    var pass = 0, fail = 0, log = [];
    function check(label, fn) {
      try { fn(); pass += 1; log.push("✓ " + label); }
      catch (e) { fail += 1; log.push("✗ " + label + " — " + (e && e.message ? e.message : String(e))); }
    }

    var PID = "lloyd-park-holiday-camp";
    var details = { email: "payments@lloydpark.example", bankLast4: "124242" };

    // BASELINE: with no Stripe account, paid bookings are OFF.
    check("Before connecting, paid bookings are disabled", function () {
      var s = emptyState();
      HC.assert(paidBookingsEnabled(s, PID) === false, "no Stripe -> paid bookings off");
      HC.assert(statusOf(s, PID) === STATUS.NONE, "status starts 'not connected'");
      HC.assert(connectedAccountCount(s, PID) === 0, "zero accounts connected to begin with");
    });

    // ACCEPTANCE CRITERION, part A: CONNECTING Stripe ENABLES paid bookings.
    check("Connecting Stripe enables paid bookings", function () {
      var r = connectStripe(emptyState(), PID, details);
      HC.assert(r.ok === true, "connect handshake succeeds");
      HC.assert(statusOf(r.state, PID) === STATUS.CONNECTED, "status becomes 'connected'");
      HC.assert(paidBookingsEnabled(r.state, PID) === true, "paid bookings are now ENABLED");
      var rec = getRecord(r.state, PID);
      HC.assert(rec.account && rec.account.payoutsEnabled === true, "payouts are enabled on the account");
      HC.assert(typeof r.stripeId === "string" && /^acct_/.test(r.stripeId), "a Stripe acct id is issued");
      HC.assert(rec.account.bankLast4 === "4242", "only the last 4 of the bank are kept");
    });

    // The two-step OAuth handshake: a PENDING account does NOT yet enable paid bookings.
    check("A pending (un-verified) Stripe account does not enable paid bookings", function () {
      var s = startConnect(emptyState(), PID, details);
      HC.assert(s.ok === true, "start succeeds");
      HC.assert(statusOf(s.state, PID) === STATUS.PENDING, "status is 'pending' after start");
      HC.assert(paidBookingsEnabled(s.state, PID) === false, "paid bookings stay OFF until verified");
      var c = completeConnect(s.state, PID);
      HC.assert(c.ok === true, "completing verification succeeds");
      HC.assert(paidBookingsEnabled(c.state, PID) === true, "paid bookings ON once verified");
    });

    // ACCEPTANCE CRITERION, part B: ONLY ONE Stripe account per provider.
    check("Only one Stripe account can be connected per provider", function () {
      var first = connectStripe(emptyState(), PID, details);
      HC.assert(connectedAccountCount(first.state, PID) === 1, "exactly one account after first connect");
      // Attempt to connect a SECOND account without disconnecting the first.
      var second = connectStripe(first.state, PID, { email: "other@bank.example", bankLast4: "9999" });
      HC.assert(second.ok === false, "a second connect is refused");
      HC.assert(/only one|already connected/i.test(second.error || ""), "error explains the one-account rule, got: " + second.error);
      HC.assert(connectedAccountCount(second.state, PID) === 1, "still exactly one account connected");
      var rec = getRecord(second.state, PID);
      HC.assert(rec.account.email === details.email, "the ORIGINAL account is untouched (not overwritten)");
    });

    // startConnect alone is also guarded against a second account.
    check("startConnect refuses a second account while one is connected", function () {
      var first = connectStripe(emptyState(), PID, details);
      var s = startConnect(first.state, PID, { email: "other@bank.example" });
      HC.assert(s.ok === false, "starting a second connection is blocked");
      HC.assert(s.stripeId === null, "no new Stripe id is minted");
      HC.assert(connectedAccountCount(s.state, PID) === 1, "the count never exceeds one");
    });

    // DISCONNECT then connect an alternative (evidence 5972981).
    check("Disconnecting lets a provider connect an alternative account", function () {
      var first = connectStripe(emptyState(), PID, details);
      var d = disconnectStripe(first.state, PID);
      HC.assert(d.ok === true, "disconnect succeeds");
      HC.assert(connectedAccountCount(d.state, PID) === 0, "no account connected after disconnect");
      HC.assert(paidBookingsEnabled(d.state, PID) === false, "paid bookings turn OFF after disconnect");
      HC.assert(statusOf(d.state, PID) === STATUS.NONE, "status back to 'not connected'");
      // Now connect a different account — allowed.
      var alt = connectStripe(d.state, PID, { email: "new@bank.example", bankLast4: "1111" });
      HC.assert(alt.ok === true, "an alternative account can now be connected");
      HC.assert(connectedAccountCount(alt.state, PID) === 1, "exactly one (the new) account connected");
      HC.assert(getRecord(alt.state, PID).account.email === "new@bank.example", "the new account is the one connected");
      // The old account is archived in history (audit of the swap).
      var hist = getRecord(alt.state, PID).history;
      HC.assert(Array.isArray(hist) && hist.length === 1, "the removed account is archived in history");
      HC.assert(hist[0].stripeId === first.stripeId, "history records the previously-connected account");
    });

    // Disconnecting with nothing connected is a safe no-op.
    check("Disconnecting with no account is a safe no-op", function () {
      var d = disconnectStripe(emptyState(), PID);
      HC.assert(d.ok === false, "nothing to disconnect -> ok:false");
      HC.assert(/no stripe account/i.test(d.error || ""), "clear error message, got: " + d.error);
      HC.assert(connectedAccountCount(d.state, PID) === 0, "still zero accounts");
    });

    // Two DIFFERENT providers each keep their own single account — isolation.
    check("Each provider has an independent single Stripe account", function () {
      var s = connectStripe(emptyState(), "camp-a", { email: "a@bank.example" }).state;
      s = connectStripe(s, "camp-b", { email: "b@bank.example" }).state;
      HC.assert(paidBookingsEnabled(s, "camp-a") === true, "camp A has paid bookings on");
      HC.assert(paidBookingsEnabled(s, "camp-b") === true, "camp B has paid bookings on");
      HC.assert(connectedAccountCount(s, "camp-a") === 1 && connectedAccountCount(s, "camp-b") === 1, "one account each");
      HC.assert(getRecord(s, "camp-a").account.email !== getRecord(s, "camp-b").account.email, "accounts are distinct");
      // Disconnecting A leaves B untouched.
      var d = disconnectStripe(s, "camp-a");
      HC.assert(paidBookingsEnabled(d.state, "camp-a") === false, "A off after disconnect");
      HC.assert(paidBookingsEnabled(d.state, "camp-b") === true, "B unaffected");
    });

    // Payout schedule: defaults to daily, configurable to the documented options.
    check("Payout schedule defaults to daily and is configurable", function () {
      var r = connectStripe(emptyState(), PID, details);
      HC.assert(getRecord(r.state, PID).account.payoutSchedule === DEFAULT_SCHEDULE, "defaults to daily");
      var w = setPayoutSchedule(r.state, PID, "weekly");
      HC.assert(w.ok === true && getRecord(w.state, PID).account.payoutSchedule === "weekly", "can switch to weekly");
      var m = setPayoutSchedule(w.state, PID, "monthly");
      HC.assert(m.ok === true && getRecord(m.state, PID).account.payoutSchedule === "monthly", "can switch to monthly");
      var bad = setPayoutSchedule(m.state, PID, "hourly");
      HC.assert(bad.ok === false, "an unknown schedule is rejected");
      // Cannot set a schedule before connecting.
      var pre = setPayoutSchedule(emptyState(), PID, "weekly");
      HC.assert(pre.ok === false, "no schedule until Stripe is connected");
    });

    // Funds-availability window matches the evidence (3-5 working days).
    check("Funds are available to withdraw in 3-5 working days", function () {
      HC.assert(PAYOUT_MIN_DAYS === 3 && PAYOUT_MAX_DAYS === 5, "window is 3-5 days per Happity evidence");
      HC.assert(/3-5 working days/.test(payoutWindowLabel()), "label reads '3-5 working days', got: " + payoutWindowLabel());
    });

    // Stripe fee maths: 1.5% + 20p, money lands net with provider (evidence 3563847).
    check("Stripe fee is 1.5% + 20p and the net goes to the provider", function () {
      // £5 booking -> 1.5% of £5 = 7.5p, +20p = 27.5p -> rounds to 28p? Happity quotes 27p.
      // Use pence-exact rounding: round(7.5)=8 + 20 = 28p in our model; assert structure not their rounding.
      var f10 = stripeFee(10);
      HC.assert(f10.gross === 10, "gross preserved");
      // 1.5% of £10 = 15p + 20p = 35p fee.
      HC.assert(Math.abs(f10.fee - 0.35) < 0.001, "£10 fee is 35p (1.5% + 20p), got " + f10.fee);
      HC.assert(Math.abs(f10.net - 9.65) < 0.001, "provider keeps £9.65 of a £10 booking, got " + f10.net);
      var f50 = stripeFee(50);
      HC.assert(Math.abs(f50.fee - 0.95) < 0.001, "£50 fee is 95p (1.5% + 20p), got " + f50.fee);
      HC.assert(f50.net < f50.gross && f50.net > 0, "net is positive and below gross");
      // Defensive against junk amounts.
      HC.assert(stripeFee(0).fee === 0 && stripeFee(-3).fee === 0 && stripeFee("x").fee === 0, "junk amounts -> zero fee, no throw");
    });

    // Re-connecting after a full disconnect cycle still enforces the single-account rule.
    check("The single-account invariant holds across connect/disconnect cycles", function () {
      var s = connectStripe(emptyState(), PID, details).state;
      s = disconnectStripe(s, PID).state;
      s = connectStripe(s, PID, { email: "second@bank.example" }).state;
      // Now try a third connect on top of the second — must be refused.
      var third = connectStripe(s, PID, { email: "third@bank.example" });
      HC.assert(third.ok === false, "cannot stack a third account on the second");
      HC.assert(connectedAccountCount(third.state, PID) === 1, "count stays at one after the cycle");
      HC.assert(getRecord(third.state, PID).history.length === 1, "exactly one archived account from the single swap");
    });

    // Defensive: bad inputs must not throw or corrupt state.
    check("Defensive against missing providers and empty inputs", function () {
      var s = emptyState();
      HC.assert(getRecord(s, "nope") === null, "missing record returns null, not a throw");
      HC.assert(paidBookingsEnabled(s, "nope") === false, "missing provider -> paid bookings off");
      var noPid = startConnect(s, "", details);
      HC.assert(noPid.ok === false, "connecting without a provider id fails cleanly");
      var c = completeConnect(s, "ghost");
      HC.assert(c.ok === false, "completing a non-existent connection fails cleanly");
      // A connect with no details still works (Stripe id auto-minted).
      var r = connectStripe(s, PID, undefined);
      HC.assert(r.ok === true && /^acct_/.test(r.stripeId), "connect with no details still mints an account");
    });

    // Persistence round-trips through HC.store (namespaced, not raw localStorage).
    check("Stripe-connect state persists via HC.store", function () {
      var r = connectStripe(emptyState(), PID, details);
      var ok = HC.store.set(STORE_KEY, r.state);
      HC.assert(ok !== false, "store.set should succeed");
      var got = HC.store.get(STORE_KEY, null);
      HC.assert(got && got.byProvider && got.byProvider[PID], "record survives a store round-trip");
      HC.assert(got.byProvider[PID].status === STATUS.CONNECTED, "status survives persistence");
      HC.assert(paidBookingsEnabled(got, PID) === true, "paid-bookings gate survives persistence");
      HC.assert(got.byProvider[PID].account.stripeId === r.stripeId, "Stripe id survives persistence");
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
      // The price reader returns a positive number for the fee illustration.
      HC.assert(readSamplePrice(seed) > 0, "a positive sample price is derived for the fee demo");
    });

    return { pass: pass, fail: fail, log: log };
  }

  /* ---------------- register ---------------- */

  HC.registerFeature({
    id: "provider-stripe-connect",
    title: "Connect Stripe (payouts to your own account)",
    side: "provider",
    icon: "💳",
    summary: "Just like Happity: connect your own Stripe account so parents can pay for camp places online. " +
      "Booking money goes straight to you — HolidayCamp never holds it — and is available to withdraw to your bank in " +
      "3-5 working days. Connecting Stripe switches on paid bookings; only one Stripe account can be attached per " +
      "provider (disconnect to swap banks).",
    render: render,
    selfTest: selfTest
  });
})();
