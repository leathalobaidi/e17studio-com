/* HolidayCamp feature — platform-account-closure
 *
 * Cancel subscription / close account  (PLATFORM side)
 *
 * Replicates Happity's provider cancellation + account-closure workflow, viewed
 * from the PLATFORM's side: the system of record that a holiday-camp operator
 * uses to cancel its paid services and (optionally) request that its whole
 * account and public profile be removed.
 *
 * Evidence (support articles 5317998 & 15458402):
 *   - 5317998 "To cancel your Happity Membership": cancelling the Membership
 *     "will also cancel your featured listings subscription and deactivate
 *     bookings, where relevant." -> cancelling Membership CASCADES.
 *   - 5317998 "To cancel the featured listings service": email a request; "If
 *     there is an outstanding balance on the account you will be sent a final
 *     invoice for this." -> a Featured-only cancel raises a FINAL INVOICE when a
 *     balance is owed.
 *   - 5317998 "Closing down your account": complete the closure form and "we
 *     will then close your account within five working days." -> closure is a
 *     REQUEST resolved within 5 WORKING DAYS, not instant.
 *   - 15458402 "How do I cancel my Membership or account?": "If you'd like to
 *     close your account completely, there's a section on the form to confirm
 *     this." -> closure is OPTED INTO on the same cancellation request.
 *   - 15458402: "If you don't want to close your account, you'll automatically
 *     move to a free listing — so your classes stay on Happity." -> the default
 *     after a Membership cancel is AUTO-DOWNGRADE to a free listing, NOT removal.
 *   - 15458402 "close my account if I am not on a membership": a free account
 *     can request profile removal directly. -> closure does not require an
 *     active subscription.
 *   - 15458402 refund policy:
 *       Annual: refunded only if cancelled inside the first 30 days; after that,
 *               no refund (annual term).
 *       Monthly: 9-month minimum contract; after that cancel any time, but no
 *               refund on time remaining in the current month.
 *     plus "All memberships come with a 30 day cooling off period."
 *
 * Framed for SCHOOL-AGE HOLIDAY CAMPS: the "providers" are the holiday-camp
 * operators in the E17 directory (sports clubs, drama schools, forest-school
 * runners). The platform runs ONE cancellation desk. An operator can:
 *   1. Cancel their Membership (which cascades: kills Featured Listings,
 *      deactivates bookings) and EITHER close the account OR fall back to a
 *      free listing so their camps stay listed.
 *   2. Cancel only their Featured Listings subscription (final invoice if a
 *      balance is owed).
 *   3. Close a free account (remove the profile) with no subscription at all.
 * Every closure is a REQUEST with a 5-working-day SLA; refund eligibility is
 * computed from the plan and how far into the term the operator is.
 *
 * This is the PLATFORM cancellation desk (the state machine + refund rule +
 * cascade + SLA), distinct from a provider hiding a single camp.
 *
 * ACCEPTANCE CRITERION (exercised by selfTest, multiple cases):
 *   A provider can cancel services AND request account closure.
 *
 * Self-contained, defensive, no imports/exports. Calls HC.registerFeature.
 */
(function () {
  "use strict";

  // Defensive: never throw at module load if HC isn't present.
  if (typeof window === "undefined" || !window.HC || typeof window.HC.registerFeature !== "function") {
    if (typeof console !== "undefined" && console.warn) {
      console.warn("[HC] platform-account-closure: HC core not found; skipping registration.");
    }
    return;
  }

  var HC = window.HC;
  var money = (HC.util && HC.util.money) ? HC.util.money : function (n) { return "£" + n; };
  var STORE_KEY = "platform_account_closure_desk";

  /* ----------------------------- constants ----------------------------- */

  var MS_PER_DAY = 24 * 60 * 60 * 1000;
  var SLA_WORKING_DAYS = 5;          // closures resolve within 5 working days
  var COOLING_OFF_DAYS = 30;         // 30-day cooling-off on all memberships
  var MONTHLY_MIN_MONTHS = 9;        // monthly membership: 9-month minimum term

  // The paid services an operator can hold (priced for the holiday-camp market).
  var SERVICES = {
    membership_annual: { id: "membership_annual", label: "Annual Membership", price: 180, term: "annual" },
    membership_monthly: { id: "membership_monthly", label: "Monthly Membership", price: 20, term: "monthly" },
    featured: { id: "featured", label: "Featured Listings", price: 25, term: "monthly" }
  };

  // What a cancellation request can be about.
  var KIND = {
    MEMBERSHIP: "membership",      // cancel Membership (cascades)
    FEATURED: "featured",          // cancel Featured Listings only
    ACCOUNT: "account"             // close a free account (no subscription)
  };

  // Lifecycle of a request.
  var STATUS = {
    SUBMITTED: "submitted",        // logged, inside the 5-working-day SLA
    PROCESSED: "processed",        // team has actioned it
    CANCELLED_REQUEST: "withdrawn" // operator withdrew before processing
  };

  // What happens to the account after a Membership cancel.
  var OUTCOME = {
    CLOSED: "closed",              // profile removed from HolidayCamp
    FREE_LISTING: "free_listing"   // auto-downgrade; camps stay listed
  };

  /* ===================================================================== *
   *  PURE LOGIC (DOM-free, deterministic, testable)                       *
   *  Mutators return a NEW state; nothing mutates inputs in place, and a   *
   *  `now`/term dates can be passed so selfTest can exercise the refund    *
   *  windows and the SLA deterministically.                               *
   * ===================================================================== *
   *
   * Account shape:
   *   {
   *     id, name,
   *     services: { membership_annual?:true, membership_monthly?:true, featured?:true },
   *     termStart: <ms>,            // when the current paid term began
   *     outstandingBalance: <£>,    // owed on the account (drives final invoice)
   *     bookingsActive: <bool>,     // whether HolidayCamp bookings are live
   *     status: 'active' | 'free' | 'closed',
   *     listed: <bool>              // is the public profile visible
   *   }
   *
   * Desk state shape:
   *   { accounts: { <id>: Account }, requests: [ Request ] }
   *
   * Request shape:
   *   {
   *     id, accountId, kind, status, createdAt, slaDueAt,
   *     closeAccount: <bool>,       // did they tick "close my account"?
   *     outcome,                    // OUTCOME.* once processed (membership/account)
   *     refund: { eligible, amount, reason },
   *     finalInvoice: <£|null>,     // featured-only with a balance
   *     cascade: { featuredCancelled, bookingsDeactivated },
   *     feedback: <string>
   *   }
   */

  function clone(o) {
    // structuredClone-free deep copy of our plain-data state.
    return o == null ? o : JSON.parse(JSON.stringify(o));
  }

  function emptyState() {
    return { accounts: {}, requests: [] };
  }

  // Add 5 working days (skip Sat/Sun) to a timestamp -> the SLA due date.
  function addWorkingDays(fromMs, days) {
    var d = new Date(fromMs);
    var added = 0;
    while (added < days) {
      d = new Date(d.getTime() + MS_PER_DAY);
      var dow = d.getUTCDay(); // 0 Sun ... 6 Sat
      if (dow !== 0 && dow !== 6) added += 1;
    }
    return d.getTime();
  }

  function getAccount(state, accountId) {
    var a = state.accounts[String(accountId)];
    if (!a) throw new Error("Unknown account: " + accountId);
    return a;
  }

  function hasMembership(account) {
    return !!(account.services &&
      (account.services.membership_annual || account.services.membership_monthly));
  }

  function membershipTerm(account) {
    if (!account.services) return null;
    if (account.services.membership_annual) return "annual";
    if (account.services.membership_monthly) return "monthly";
    return null;
  }

  // Register an account into the desk (so requests have something to act on).
  function upsertAccount(state, account) {
    var next = clone(state);
    var id = String(account.id);
    var base = next.accounts[id] || {};
    next.accounts[id] = {
      id: id,
      name: account.name || base.name || id,
      services: account.services || base.services || {},
      termStart: account.termStart != null ? account.termStart : (base.termStart != null ? base.termStart : Date.now()),
      outstandingBalance: account.outstandingBalance != null ? account.outstandingBalance : (base.outstandingBalance || 0),
      bookingsActive: account.bookingsActive != null ? account.bookingsActive : (base.bookingsActive != null ? base.bookingsActive : false),
      status: account.status || base.status || (hasMembership(account) ? "active" : "free"),
      listed: account.listed != null ? account.listed : (base.listed != null ? base.listed : true)
    };
    return next;
  }

  /* --------------------------- refund policy --------------------------- *
   * Computed straight from the evidence:
   *   annual  -> refundable ONLY inside the first 30 days, else no refund.
   *   monthly -> 9-month minimum; after that cancel any time, but NO refund on
   *              time remaining in the current month.
   * Returns { eligible, amount, reason }.
   * ------------------------------------------------------------------- */
  function computeRefund(account, now) {
    var term = membershipTerm(account);
    if (!term) {
      return { eligible: false, amount: 0, reason: "No membership to refund." };
    }
    var t = now != null ? now : Date.now();
    var daysIn = Math.floor((t - account.termStart) / MS_PER_DAY);

    if (term === "annual") {
      var price = SERVICES.membership_annual.price;
      if (daysIn <= COOLING_OFF_DAYS) {
        return {
          eligible: true,
          amount: price,
          reason: "Within the 30-day cooling-off period — full refund of " + money(price) + "."
        };
      }
      return {
        eligible: false,
        amount: 0,
        reason: "Past the 30-day cooling-off period — annual membership is non-refundable."
      };
    }

    // monthly
    var monthsIn = Math.floor(daysIn / 30);
    if (monthsIn < MONTHLY_MIN_MONTHS) {
      return {
        eligible: false,
        amount: 0,
        reason: "Inside the " + MONTHLY_MIN_MONTHS + "-month minimum contract — cannot cancel yet."
      };
    }
    return {
      eligible: false,
      amount: 0,
      reason: "Minimum term met — cancellation allowed, but no refund on the current month."
    };
  }

  // Is a monthly membership even allowed to cancel yet? (9-month minimum.)
  function canCancelNow(account, now) {
    var term = membershipTerm(account);
    if (term !== "monthly") return true; // annual + featured can cancel any time
    var t = now != null ? now : Date.now();
    var monthsIn = Math.floor(Math.floor((t - account.termStart) / MS_PER_DAY) / 30);
    return monthsIn >= MONTHLY_MIN_MONTHS;
  }

  /* ----------------------- submit a cancellation ----------------------- *
   * The single entry point an operator uses. Validates against the rules,
   * then logs a request with an SLA. Processing (the cascade / outcome) is a
   * separate step so the desk can model the "within 5 working days" gap.
   *
   * opts = {
   *   accountId,
   *   kind: KIND.MEMBERSHIP | KIND.FEATURED | KIND.ACCOUNT,
   *   closeAccount: <bool>,   // membership cancels can opt to close
   *   feedback: <string>,
   *   now: <ms>
   * }
   * Returns { state, request }.
   * ------------------------------------------------------------------- */
  function submitCancellation(state, opts) {
    if (!opts || !opts.accountId) throw new Error("submitCancellation: accountId required");
    var kind = opts.kind || KIND.MEMBERSHIP;
    if (kind !== KIND.MEMBERSHIP && kind !== KIND.FEATURED && kind !== KIND.ACCOUNT) {
      throw new Error("submitCancellation: unknown kind '" + kind + "'");
    }
    var next = clone(state);
    var account = getAccount(next, opts.accountId);
    var now = opts.now != null ? opts.now : Date.now();

    // Validate by kind.
    if (kind === KIND.MEMBERSHIP) {
      if (!hasMembership(account)) {
        throw new Error("No active Membership to cancel — use a free-account closure instead.");
      }
      if (!canCancelNow(account, now)) {
        throw new Error("Monthly Membership is inside its " + MONTHLY_MIN_MONTHS + "-month minimum term.");
      }
    } else if (kind === KIND.FEATURED) {
      if (!(account.services && account.services.featured)) {
        throw new Error("No Featured Listings subscription to cancel.");
      }
    } else if (kind === KIND.ACCOUNT) {
      // Closing a free account directly: must NOT be on a membership
      // (members close via the membership form instead).
      if (hasMembership(account)) {
        throw new Error("Account is on a Membership — cancel the Membership (and tick close) instead.");
      }
    }

    var closeAccount = kind === KIND.ACCOUNT ? true : !!opts.closeAccount;

    var request = {
      id: (HC.util && HC.util.uid) ? HC.util.uid() : ("req_" + now + "_" + next.requests.length),
      accountId: String(opts.accountId),
      kind: kind,
      status: STATUS.SUBMITTED,
      createdAt: now,
      slaDueAt: addWorkingDays(now, SLA_WORKING_DAYS),
      closeAccount: closeAccount,
      outcome: null,
      refund: kind === KIND.MEMBERSHIP ? computeRefund(account, now) : { eligible: false, amount: 0, reason: "Not a membership cancellation." },
      finalInvoice: null,
      cascade: { featuredCancelled: false, bookingsDeactivated: false },
      feedback: opts.feedback ? String(opts.feedback) : ""
    };

    next.requests.push(request);
    return { state: next, request: request };
  }

  /* ----------------------- process a cancellation ---------------------- *
   * The team actions the request (inside the SLA). This applies the cascade,
   * raises a final invoice where due, and sets the account outcome.
   * Returns { state, request }.
   * ------------------------------------------------------------------- */
  function processCancellation(state, requestId) {
    var next = clone(state);
    var request = next.requests.filter(function (r) { return r.id === requestId; })[0];
    if (!request) throw new Error("Unknown request: " + requestId);
    if (request.status !== STATUS.SUBMITTED) {
      throw new Error("Request already resolved (" + request.status + ").");
    }
    var account = getAccount(next, request.accountId);

    if (request.kind === KIND.MEMBERSHIP) {
      // Cascade: cancelling Membership also cancels Featured + deactivates bookings.
      var hadFeatured = !!(account.services && account.services.featured);
      var hadBookings = !!account.bookingsActive;
      account.services = account.services || {};
      delete account.services.membership_annual;
      delete account.services.membership_monthly;
      if (account.services.featured) delete account.services.featured;
      account.bookingsActive = false;
      request.cascade = { featuredCancelled: hadFeatured, bookingsDeactivated: hadBookings };

      if (request.closeAccount) {
        account.status = "closed";
        account.listed = false;
        request.outcome = OUTCOME.CLOSED;
      } else {
        // Default: auto-downgrade to a free listing — camps stay on HolidayCamp.
        account.status = "free";
        account.listed = true;
        request.outcome = OUTCOME.FREE_LISTING;
      }
    } else if (request.kind === KIND.FEATURED) {
      // Featured-only: drop the service; raise a final invoice if a balance is owed.
      account.services = account.services || {};
      delete account.services.featured;
      request.cascade = { featuredCancelled: true, bookingsDeactivated: false };
      if (account.outstandingBalance > 0) {
        request.finalInvoice = account.outstandingBalance;
      }
      // Account itself stays (still a member or a free listing). No outcome change.
      request.outcome = OUTCOME.FREE_LISTING;
    } else if (request.kind === KIND.ACCOUNT) {
      // Free-account closure: remove the profile entirely.
      account.status = "closed";
      account.listed = false;
      request.outcome = OUTCOME.CLOSED;
    }

    request.status = STATUS.PROCESSED;
    return { state: next, request: request };
  }

  // An operator can withdraw a request before it's processed (changed their mind).
  function withdrawRequest(state, requestId) {
    var next = clone(state);
    var request = next.requests.filter(function (r) { return r.id === requestId; })[0];
    if (!request) throw new Error("Unknown request: " + requestId);
    if (request.status !== STATUS.SUBMITTED) {
      throw new Error("Only a submitted request can be withdrawn.");
    }
    request.status = STATUS.CANCELLED_REQUEST;
    return { state: next, request: request };
  }

  // Is a submitted request still inside its SLA at `now`?
  function withinSla(request, now) {
    var t = now != null ? now : Date.now();
    return t <= request.slaDueAt;
  }

  /* ----------------------------- persistence --------------------------- */
  function loadState() {
    try {
      var s = HC.store.get(STORE_KEY, null);
      if (s && s.accounts && Array.isArray(s.requests)) return s;
    } catch (e) { /* fall through */ }
    return seedState();
  }
  function saveState(s) {
    try { HC.store.set(STORE_KEY, s); } catch (e) { /* mock store; ignore */ }
  }

  // Seed two real holiday-camp operators from the live directory if available.
  function seedState() {
    var s = emptyState();
    var now = Date.now();
    var names = ["Little Kickers Holiday Camp", "Stagecoach Performing Arts"];
    try {
      var providers = (HC.data && HC.data.providers) || [];
      if (providers.length) {
        names = [
          (providers[0] && (providers[0].name || providers[0].title)) || names[0],
          (providers[1] && (providers[1].name || providers[1].title)) || names[1]
        ];
      }
    } catch (e) { /* use defaults */ }

    // Operator 1: annual member, 90 days in (past cooling-off), featured + bookings on, owes a balance.
    s = upsertAccount(s, {
      id: "acct_1", name: names[0],
      services: { membership_annual: true, featured: true },
      termStart: now - 90 * MS_PER_DAY,
      outstandingBalance: 25, bookingsActive: true, status: "active", listed: true
    });
    // Operator 2: free listing, no subscription — eligible to close directly.
    s = upsertAccount(s, {
      id: "acct_2", name: names[1],
      services: {}, termStart: now - 400 * MS_PER_DAY,
      outstandingBalance: 0, bookingsActive: false, status: "free", listed: true
    });
    return s;
  }

  /* ===================================================================== *
   *  RENDER (DOM UI into mountEl) — defensive, no app.js assumptions       *
   * ===================================================================== */

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function render(mountEl) {
    try {
      mountEl.innerHTML = "";
      var state = loadState();

      var wrap = document.createElement("div");
      wrap.style.cssText = "font-family:'Nunito Sans',system-ui,sans-serif;color:var(--text,#383838);font-size:14px;line-height:1.55";

      wrap.innerHTML =
        '<p style="margin:0 0 14px">The HolidayCamp <strong>cancellation desk</strong>. An operator can cancel their ' +
        'paid services and, on the same request, ask us to <strong>close their account</strong>. Cancelling a ' +
        'Membership also cancels Featured Listings and deactivates bookings; if they don\'t close, they fall back to a ' +
        'free listing so their camps stay live. Closures resolve within <strong>' + SLA_WORKING_DAYS + ' working days</strong>.</p>' +
        '<div id="acwAccounts"></div>' +
        '<div id="acwLog" style="margin-top:18px"></div>';

      mountEl.appendChild(wrap);

      function drawAccounts() {
        var host = wrap.querySelector("#acwAccounts");
        host.innerHTML = "";
        Object.keys(state.accounts).forEach(function (id) {
          var a = state.accounts[id];
          var svc = [];
          if (a.services.membership_annual) svc.push("Annual Membership");
          if (a.services.membership_monthly) svc.push("Monthly Membership");
          if (a.services.featured) svc.push("Featured Listings");
          var statusColour = a.status === "closed" ? "#9a1f5e" : (a.status === "free" ? "#806000" : "#2f7d4f");

          var card = document.createElement("div");
          card.style.cssText = "border:1.5px solid var(--line,#E6E6E6);border-radius:16px;padding:14px 16px;margin-bottom:12px;background:#fff";
          card.innerHTML =
            '<div style="display:flex;justify-content:space-between;align-items:baseline;gap:10px;flex-wrap:wrap">' +
              '<strong style="font-family:Quicksand,system-ui,sans-serif;color:var(--purple,#603488);font-size:16px">' + esc(a.name) + '</strong>' +
              '<span style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.4px;color:' + statusColour + '">' + esc(a.status) + (a.listed ? "" : " · unlisted") + '</span>' +
            '</div>' +
            '<div style="color:var(--muted,#808080);font-size:12.5px;margin:4px 0 10px">' +
              (svc.length ? esc(svc.join(" · ")) : "No paid services") +
              (a.bookingsActive ? " · bookings live" : "") +
              (a.outstandingBalance > 0 ? " · " + esc(money(a.outstandingBalance)) + " outstanding" : "") +
            '</div>' +
            '<div class="acwBtns" style="display:flex;gap:8px;flex-wrap:wrap"></div>';

          var btns = card.querySelector(".acwBtns");

          if (a.status !== "closed") {
            if (hasMembership(a)) {
              btns.appendChild(mkBtn("Cancel & downgrade to free", function () { doMembership(id, false); }));
              btns.appendChild(mkBtn("Cancel & close account", function () { doMembership(id, true); }, true));
            }
            if (a.services.featured && !hasMembership(a)) {
              btns.appendChild(mkBtn("Cancel Featured Listings", function () { doFeatured(id); }));
            }
            if (!hasMembership(a)) {
              btns.appendChild(mkBtn("Close account (free)", function () { doAccount(id); }, true));
            }
          } else {
            var done = document.createElement("span");
            done.style.cssText = "font-size:12.5px;color:var(--muted,#808080)";
            done.textContent = "Account closed — profile removed from HolidayCamp.";
            btns.appendChild(done);
          }
          host.appendChild(card);
        });
      }

      function mkBtn(label, fn, danger) {
        var b = document.createElement("button");
        b.type = "button";
        b.textContent = label;
        b.style.cssText = "border:none;cursor:pointer;font-family:Quicksand,system-ui,sans-serif;font-weight:700;" +
          "font-size:12px;padding:8px 13px;border-radius:999px;" +
          (danger ? "background:var(--pink-tint,#FCE8F0);color:#9a1f5e" : "background:var(--yellow,#FCD400);color:var(--ink,#1A1A1A)");
        b.addEventListener("click", fn);
        return b;
      }

      function resolveNow(out, label) {
        // Submit then immediately process so the preview shows the end state.
        try {
          var processed = processCancellation(out.state, out.request.id);
          state = processed.state;
          saveState(state);
          drawAccounts();
          appendLog(processed.request, label);
          if (HC.util && HC.util.toast) HC.util.toast(label);
        } catch (e) {
          if (HC.util && HC.util.toast) HC.util.toast("Could not process: " + (e && e.message));
        }
      }

      function doMembership(id, close) {
        try {
          var out = submitCancellation(state, { accountId: id, kind: KIND.MEMBERSHIP, closeAccount: close, feedback: "" });
          resolveNow(out, close ? "Membership cancelled — account closed" : "Membership cancelled — moved to free listing");
        } catch (e) {
          if (HC.util && HC.util.toast) HC.util.toast(e && e.message ? e.message : "Cannot cancel");
        }
      }
      function doFeatured(id) {
        try {
          var out = submitCancellation(state, { accountId: id, kind: KIND.FEATURED });
          resolveNow(out, "Featured Listings cancelled");
        } catch (e) {
          if (HC.util && HC.util.toast) HC.util.toast(e && e.message ? e.message : "Cannot cancel");
        }
      }
      function doAccount(id) {
        try {
          var out = submitCancellation(state, { accountId: id, kind: KIND.ACCOUNT });
          resolveNow(out, "Account closure requested");
        } catch (e) {
          if (HC.util && HC.util.toast) HC.util.toast(e && e.message ? e.message : "Cannot close");
        }
      }

      function appendLog(request, label) {
        var log = wrap.querySelector("#acwLog");
        if (!log.dataset.init) {
          log.dataset.init = "1";
          log.innerHTML = '<div style="font-family:Quicksand,system-ui,sans-serif;font-weight:700;color:var(--magenta,#F82488);' +
            'text-transform:uppercase;letter-spacing:.5px;font-size:12px;margin-bottom:8px">Cancellation desk log</div>' +
            '<div id="acwRows"></div>';
        }
        var rows = log.querySelector("#acwRows");
        var bits = [];
        bits.push(esc(label));
        if (request.outcome === OUTCOME.CLOSED) bits.push("profile removed");
        if (request.outcome === OUTCOME.FREE_LISTING && request.kind === KIND.MEMBERSHIP) bits.push("camps stay listed");
        if (request.cascade && request.cascade.featuredCancelled) bits.push("Featured cancelled");
        if (request.cascade && request.cascade.bookingsDeactivated) bits.push("bookings deactivated");
        if (request.finalInvoice) bits.push("final invoice " + money(request.finalInvoice));
        if (request.refund && request.refund.eligible) bits.push("refund " + money(request.refund.amount));
        var sla = new Date(request.slaDueAt);
        var slaTxt = sla.toLocaleDateString("en-GB", { day: "numeric", month: "short" });

        var row = document.createElement("div");
        row.style.cssText = "padding:8px 0;border-bottom:1px solid var(--line,#E6E6E6);font-size:13px";
        row.innerHTML = '<span style="color:var(--purple,#603488);font-weight:700">' + bits.join(" · ") + '</span>' +
          '<span style="color:var(--muted,#808080)"> — resolves by ' + esc(slaTxt) + ' (≤' + SLA_WORKING_DAYS + ' working days)' +
          (request.refund && request.refund.reason ? ". " + esc(request.refund.reason) : "") + '</span>';
        rows.appendChild(row);
      }

      drawAccounts();
    } catch (e) {
      mountEl.innerHTML = '<p style="color:#9a1f5e">Account-closure preview failed: ' + esc(e && e.message ? e.message : String(e)) + '</p>';
    }
  }

  /* ===================================================================== *
   *  SELF-TEST — exercises the LOGIC and asserts the acceptance criterion  *
   *  "A provider can cancel services AND request account closure."         *
   * ===================================================================== */

  function selfTest() {
    var pass = 0, fail = 0, log = [];
    function check(label, fn) {
      try { fn(); pass += 1; log.push("✓ " + label); }
      catch (e) { fail += 1; log.push("✗ " + label + " — " + (e && e.message ? e.message : String(e))); }
    }

    var DAY = MS_PER_DAY;

    // Build a fresh desk with deterministic term-start dates around a fixed "now".
    var NOW = Date.UTC(2026, 0, 15); // fixed reference time

    function deskWith(accounts) {
      var s = emptyState();
      accounts.forEach(function (a) { s = upsertAccount(s, a); });
      return s;
    }

    // ---- ACCEPTANCE CRITERION, primary case ----------------------------
    // A provider with a Membership can cancel services AND request closure.
    check("ACCEPTANCE: a provider can cancel services and request account closure", function () {
      var s = deskWith([{
        id: "p1", name: "Camp Wildwood Forest School",
        services: { membership_annual: true, featured: true },
        termStart: NOW - 10 * DAY,       // inside cooling-off
        outstandingBalance: 0, bookingsActive: true, status: "active", listed: true
      }]);
      var out = submitCancellation(s, { accountId: "p1", kind: KIND.MEMBERSHIP, closeAccount: true, now: NOW });
      HC.assert(out.request.status === STATUS.SUBMITTED, "request should be logged as submitted");
      HC.assert(out.request.closeAccount === true, "closure must be opted in on the request");
      var done = processCancellation(out.state, out.request.id);
      var acc = done.state.accounts.p1;
      HC.assert(done.request.outcome === OUTCOME.CLOSED, "outcome must be a closed account");
      HC.assert(acc.status === "closed" && acc.listed === false, "profile must be removed");
      HC.assert(!hasMembership(acc), "membership must be cancelled");
      // services were cancelled AND closure was honoured -> criterion met.
    });

    // ---- Cascade: membership cancel kills Featured + bookings ----------
    check("Cancelling Membership cascades to Featured Listings and deactivates bookings", function () {
      var s = deskWith([{
        id: "p2", name: "Stagecoach Holiday Workshops",
        services: { membership_annual: true, featured: true },
        termStart: NOW - 200 * DAY, outstandingBalance: 0, bookingsActive: true, status: "active", listed: true
      }]);
      var out = submitCancellation(s, { accountId: "p2", kind: KIND.MEMBERSHIP, closeAccount: false, now: NOW });
      var done = processCancellation(out.state, out.request.id);
      HC.assert(done.request.cascade.featuredCancelled === true, "Featured must be cancelled by the cascade");
      HC.assert(done.request.cascade.bookingsDeactivated === true, "bookings must be deactivated");
      HC.assert(!done.state.accounts.p2.services.featured, "featured service must be gone");
      HC.assert(done.state.accounts.p2.bookingsActive === false, "bookings flag must be off");
    });

    // ---- Default outcome: NOT closing -> auto-downgrade to free listing -
    check("Cancelling without closing auto-downgrades to a free listing (camps stay listed)", function () {
      var s = deskWith([{
        id: "p3", name: "Little Kickers Camp",
        services: { membership_monthly: true },
        termStart: NOW - 300 * DAY,      // well past the 9-month minimum
        outstandingBalance: 0, bookingsActive: true, status: "active", listed: true
      }]);
      var out = submitCancellation(s, { accountId: "p3", kind: KIND.MEMBERSHIP, closeAccount: false, now: NOW });
      var done = processCancellation(out.state, out.request.id);
      HC.assert(done.request.outcome === OUTCOME.FREE_LISTING, "default outcome is a free listing");
      HC.assert(done.state.accounts.p3.status === "free", "account should be on a free listing");
      HC.assert(done.state.accounts.p3.listed === true, "profile must stay listed");
      HC.assert(!hasMembership(done.state.accounts.p3), "membership still cancelled");
    });

    // ---- Free-account closure (no subscription) ------------------------
    check("A free account (no subscription) can request profile removal directly", function () {
      var s = deskWith([{
        id: "p4", name: "Forest Tots Free Listing",
        services: {}, termStart: NOW - 500 * DAY, outstandingBalance: 0, bookingsActive: false, status: "free", listed: true
      }]);
      var out = submitCancellation(s, { accountId: "p4", kind: KIND.ACCOUNT, now: NOW });
      HC.assert(out.request.closeAccount === true, "an account-kind request always closes");
      var done = processCancellation(out.state, out.request.id);
      HC.assert(done.request.outcome === OUTCOME.CLOSED, "free closure must close the account");
      HC.assert(done.state.accounts.p4.status === "closed", "status must be closed");
      HC.assert(done.state.accounts.p4.listed === false, "profile must be removed");
    });

    // ---- Featured-only cancel raises a final invoice when balance owed --
    check("Cancelling Featured Listings only raises a final invoice when a balance is owed", function () {
      var s = deskWith([{
        id: "p5", name: "Encore Drama Holidays",
        services: { membership_annual: true, featured: true },
        termStart: NOW - 100 * DAY, outstandingBalance: 25, bookingsActive: true, status: "active", listed: true
      }]);
      var out = submitCancellation(s, { accountId: "p5", kind: KIND.FEATURED, now: NOW });
      var done = processCancellation(out.state, out.request.id);
      HC.assert(done.request.finalInvoice === 25, "final invoice should equal the outstanding balance");
      HC.assert(!done.state.accounts.p5.services.featured, "featured must be cancelled");
      HC.assert(hasMembership(done.state.accounts.p5), "membership must survive a featured-only cancel");
    });

    check("Cancelling Featured Listings with no balance raises no final invoice", function () {
      var s = deskWith([{
        id: "p5b", name: "Clear-Balance Camp",
        services: { membership_annual: true, featured: true },
        termStart: NOW - 100 * DAY, outstandingBalance: 0, bookingsActive: false, status: "active", listed: true
      }]);
      var out = submitCancellation(s, { accountId: "p5b", kind: KIND.FEATURED, now: NOW });
      var done = processCancellation(out.state, out.request.id);
      HC.assert(done.request.finalInvoice === null, "no balance -> no final invoice");
    });

    // ---- Refund policy: annual inside vs outside the 30-day cooling-off -
    check("Annual membership cancelled inside 30 days is fully refunded", function () {
      var s = deskWith([{
        id: "p6", name: "Cooling-Off Camp",
        services: { membership_annual: true }, termStart: NOW - 10 * DAY,
        outstandingBalance: 0, bookingsActive: false, status: "active", listed: true
      }]);
      var out = submitCancellation(s, { accountId: "p6", kind: KIND.MEMBERSHIP, closeAccount: false, now: NOW });
      HC.assert(out.request.refund.eligible === true, "should be refund-eligible inside 30 days");
      HC.assert(out.request.refund.amount === SERVICES.membership_annual.price, "should refund the annual price");
    });

    check("Annual membership cancelled after 30 days is non-refundable", function () {
      var s = deskWith([{
        id: "p7", name: "Past-Cooling Camp",
        services: { membership_annual: true }, termStart: NOW - 90 * DAY,
        outstandingBalance: 0, bookingsActive: false, status: "active", listed: true
      }]);
      var out = submitCancellation(s, { accountId: "p7", kind: KIND.MEMBERSHIP, closeAccount: true, now: NOW });
      HC.assert(out.request.refund.eligible === false, "annual past cooling-off is non-refundable");
      HC.assert(out.request.refund.amount === 0, "no refund amount");
      // crucially the closure STILL goes through despite no refund
      var done = processCancellation(out.state, out.request.id);
      HC.assert(done.request.outcome === OUTCOME.CLOSED, "closure proceeds even without a refund");
    });

    // ---- Monthly minimum-term gate -------------------------------------
    check("Monthly membership cannot be cancelled inside the 9-month minimum term", function () {
      var s = deskWith([{
        id: "p8", name: "New Monthly Camp",
        services: { membership_monthly: true }, termStart: NOW - 60 * DAY, // ~2 months in
        outstandingBalance: 0, bookingsActive: true, status: "active", listed: true
      }]);
      var threw = false;
      try { submitCancellation(s, { accountId: "p8", kind: KIND.MEMBERSHIP, now: NOW }); }
      catch (e) { threw = true; }
      HC.assert(threw, "cancelling inside the 9-month minimum must be refused");
    });

    check("Monthly membership can be cancelled (no refund) after the minimum term", function () {
      var s = deskWith([{
        id: "p9", name: "Long-Standing Monthly Camp",
        services: { membership_monthly: true }, termStart: NOW - 300 * DAY, // ~10 months in
        outstandingBalance: 0, bookingsActive: true, status: "active", listed: true
      }]);
      var out = submitCancellation(s, { accountId: "p9", kind: KIND.MEMBERSHIP, closeAccount: false, now: NOW });
      HC.assert(out.request.refund.eligible === false, "no refund on a monthly cancel");
      var done = processCancellation(out.state, out.request.id);
      HC.assert(done.request.outcome === OUTCOME.FREE_LISTING, "monthly cancel still resolves");
    });

    // ---- SLA: 5 working days, skipping weekends ------------------------
    check("Closure carries a 5-working-day SLA that skips weekends", function () {
      // Thursday 2026-01-15 -> +5 working days lands on Thursday 2026-01-22.
      var s = deskWith([{
        id: "p10", name: "SLA Camp", services: {}, termStart: NOW - 500 * DAY,
        outstandingBalance: 0, bookingsActive: false, status: "free", listed: true
      }]);
      var out = submitCancellation(s, { accountId: "p10", kind: KIND.ACCOUNT, now: NOW });
      var dueDow = new Date(out.request.slaDueAt).getUTCDay();
      HC.assert(dueDow !== 0 && dueDow !== 6, "SLA due date must not fall on a weekend");
      HC.assert(out.request.slaDueAt === addWorkingDays(NOW, 5), "SLA must be exactly 5 working days out");
      HC.assert(withinSla(out.request, NOW + 3 * DAY) === true, "still within SLA after 3 days");
      HC.assert(withinSla(out.request, NOW + 30 * DAY) === false, "past SLA after a month");
    });

    // ---- Guard rails ---------------------------------------------------
    check("Cannot cancel a Membership that does not exist", function () {
      var s = deskWith([{ id: "p11", name: "No-Member Camp", services: {}, termStart: NOW, status: "free", listed: true }]);
      var threw = false;
      try { submitCancellation(s, { accountId: "p11", kind: KIND.MEMBERSHIP, now: NOW }); }
      catch (e) { threw = true; }
      HC.assert(threw, "membership cancel with no membership must throw");
    });

    check("A member must close via the membership form, not the free-account route", function () {
      var s = deskWith([{
        id: "p12", name: "Member Camp", services: { membership_annual: true },
        termStart: NOW - 90 * DAY, status: "active", listed: true
      }]);
      var threw = false;
      try { submitCancellation(s, { accountId: "p12", kind: KIND.ACCOUNT, now: NOW }); }
      catch (e) { threw = true; }
      HC.assert(threw, "a member cannot use the free-account closure route");
    });

    check("An operator can withdraw a submitted request before it is processed", function () {
      var s = deskWith([{
        id: "p13", name: "Changed-Mind Camp", services: { membership_annual: true },
        termStart: NOW - 10 * DAY, status: "active", listed: true
      }]);
      var out = submitCancellation(s, { accountId: "p13", kind: KIND.MEMBERSHIP, closeAccount: true, now: NOW });
      var w = withdrawRequest(out.state, out.request.id);
      HC.assert(w.request.status === STATUS.CANCELLED_REQUEST, "request should be withdrawn");
      HC.assert(w.state.accounts.p13.status === "active", "account must be untouched after withdrawal");
      var threw = false;
      try { processCancellation(w.state, w.request.id); } catch (e) { threw = true; }
      HC.assert(threw, "a withdrawn request cannot be processed");
    });

    check("A processed request cannot be processed twice", function () {
      var s = deskWith([{
        id: "p14", name: "Idempotent Camp", services: {}, termStart: NOW - 500 * DAY, status: "free", listed: true
      }]);
      var out = submitCancellation(s, { accountId: "p14", kind: KIND.ACCOUNT, now: NOW });
      var done = processCancellation(out.state, out.request.id);
      var threw = false;
      try { processCancellation(done.state, out.request.id); } catch (e) { threw = true; }
      HC.assert(threw, "double-processing must be refused");
    });

    return { pass: pass, fail: fail, log: log };
  }

  /* ------------------------------ register ------------------------------ */
  HC.registerFeature({
    id: "platform-account-closure",
    title: "Cancel services / close account",
    side: "platform",
    icon: "🚪",
    summary: "The cancellation desk: an operator cancels Membership (which cascades to Featured Listings " +
      "and deactivates bookings) and can tick 'close my account' on the same request, or close a free " +
      "account directly. Non-closers auto-downgrade to a free listing; refund eligibility follows the " +
      "30-day cooling-off / 9-month-monthly-minimum rules; closures resolve within " + SLA_WORKING_DAYS + " working days.",
    render: render,
    selfTest: selfTest
  });
})();
