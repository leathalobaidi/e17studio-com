/* HolidayCamp feature: parent-refund-request
 * ------------------------------------------------------------------
 * Replicates Happity's "Request a refund (via provider)" behaviour
 * for the PARENT side.
 *
 * Evidence (Happity support corpus):
 *  - 8255720 "Parents & Carers FAQs — Support with Bookings",
 *    section "Requesting a refund":
 *      "If you require a refund for a class you have booked or
 *       attended, this should be arranged with the class provider
 *       directly, the class provider contact details can be found on
 *       your confirmation email. As we are a third party booking
 *       service, we are unable to process refunds on behalf of the
 *       class provider unless they give us written permission."
 *      -> The PARENT requests a refund by MESSAGING THE PROVIDER.
 *  - 3818245 "How do I issue a refund?" (provider side):
 *      refunds can be FULL or PARTIAL ("one session refunded from a
 *      block booking"), take 5-10 business days, and the platform
 *      won't refund on the provider's behalf unless asked. This tells
 *      us the parent's request should support full / partial / single
 *      -session scope and a reason the provider can act on.
 *
 * Side: parent. Framed for SCHOOL-AGE HOLIDAY CAMPS (day places and
 * full-week block bookings), not baby classes.
 *
 * ACCEPTANCE CRITERION (asserted in selfTest, multiple cases):
 *   A booking offers a 'request refund' action that MESSAGES THE
 *   PROVIDER. i.e. requestRefund(booking, ...) produces a message
 *   addressed to that booking's provider and records the request
 *   against the booking. The platform never auto-refunds.
 *
 * Defensive: nothing throws at registration time; risky code is
 * wrapped. Persistence is via HC.store only (refund requests +
 * outbound messages keyed by booking), never global localStorage.
 * ------------------------------------------------------------------ */
(function () {
  "use strict";

  if (typeof window === "undefined" || !window.HC || typeof window.HC.registerFeature !== "function") {
    // Core not present — fail silently rather than throwing.
    return;
  }
  var HC = window.HC;

  var STORE_KEY = "refund_requests"; // map: bookingId -> request record
  var REASONS = [
    "Child is unwell / can no longer attend",
    "Camp dates changed and no longer suit us",
    "Booked the wrong week / day by mistake",
    "Found alternative childcare",
    "Other (explained in message)"
  ];

  /* ============================================================
   * 1. Pure helpers (no DOM) — these are what selfTest exercises.
   * ============================================================ */

  function round2(n) {
    return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
  }

  function isObj(x) { return x && typeof x === "object"; }

  // Resolve a provider contact channel the way Happity describes it:
  // "contact details can be found on your confirmation email". We prefer
  // an explicit email, then a booking/source URL, else a synthesized
  // provider mailbox so the message always has a destination.
  function providerContact(provider) {
    var p = isObj(provider) ? provider : {};
    var email = p.email || p.contactEmail || (isObj(p.contact) && p.contact.email) || null;
    var url = (isObj(p.source) && p.source.url) || p.url || p.website || null;
    var channel, address;
    if (email) {
      channel = "email";
      address = String(email);
    } else if (url) {
      channel = "web";
      address = String(url);
    } else {
      channel = "email";
      // Synthesized fallback mailbox from the provider id (clearly a mock).
      var slug = String(p.id || p.name || "provider")
        .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "provider";
      address = "bookings+" + slug + "@holidaycamp.example";
    }
    return {
      providerId: p.id || null,
      providerName: p.name || "the camp provider",
      channel: channel,
      address: address
    };
  }

  // Validate + normalise a refund request against a booking.
  // scope: "full" | "partial" | "session"
  //  - full:    refund the whole paid amount
  //  - partial: refund an explicit amount (must be > 0 and <= paid)
  //  - session: refund one session from a block booking (paid / sessions)
  // Returns a result object — NEVER throws.
  function buildRefundRequest(booking, opts) {
    opts = opts || {};
    if (!isObj(booking)) {
      return { ok: false, reason: "no-booking", message: "No booking to refund." };
    }
    var paid = Number(booking.paid);
    if (!isFinite(paid) || paid <= 0) {
      return { ok: false, reason: "nothing-paid", message: "This booking has no paid amount to refund." };
    }
    if (booking.status === "refunded") {
      return { ok: false, reason: "already-refunded", message: "This booking has already been refunded." };
    }
    if (booking.status === "requested" && !opts.allowResend) {
      return { ok: false, reason: "already-requested", message: "You have already requested a refund for this booking." };
    }

    var scope = opts.scope === "partial" || opts.scope === "session" ? opts.scope : "full";
    var sessions = Math.max(1, Math.floor(Number(booking.sessions) || 1));
    var amount;

    if (scope === "full") {
      amount = paid;
    } else if (scope === "session") {
      if (sessions <= 1) {
        return { ok: false, reason: "not-a-block", message: "This is a single-session booking — request a full refund instead." };
      }
      amount = round2(paid / sessions); // refund one session of a block booking
    } else { // partial
      amount = round2(Number(opts.amount));
      if (!isFinite(amount) || amount <= 0) {
        return { ok: false, reason: "bad-amount", message: "Enter a refund amount greater than £0." };
      }
      if (amount > paid) {
        return { ok: false, reason: "over-paid", message: "Refund cannot exceed the £" + paid + " you paid." };
      }
    }
    amount = round2(amount);

    var reason = String(opts.reason || "").trim();
    if (!reason) {
      return { ok: false, reason: "no-reason", message: "Please give the provider a reason for the refund." };
    }

    return {
      ok: true,
      scope: scope,
      amount: amount,
      paid: paid,
      reasonText: reason
    };
  }

  // Compose the message that is SENT TO THE PROVIDER. This is the heart
  // of the acceptance criterion: the request becomes a provider message.
  function composeProviderMessage(booking, req, contact) {
    var lines = [];
    var when = booking.when || booking.week || "your holiday camp";
    var ref = booking.ref || booking.id || "(no reference)";
    var scopeLine = req.scope === "full"
      ? "I'd like to request a FULL refund of £" + req.amount + "."
      : req.scope === "session"
        ? "I'd like to request a refund for ONE session (£" + req.amount + ") from my block booking."
        : "I'd like to request a PARTIAL refund of £" + req.amount + ".";

    lines.push("Hi " + (contact.providerName || "there") + ",");
    lines.push("");
    lines.push("I booked " + (booking.campName || "a holiday-camp place") + " (" + when + ").");
    lines.push("Booking reference: " + ref + ".");
    lines.push("");
    lines.push(scopeLine);
    lines.push("Reason: " + req.reasonText);
    lines.push("");
    lines.push("I understand Happity is a third-party booking service and refunds are arranged with you directly. Thank you.");

    return {
      to: contact.address,
      channel: contact.channel,
      providerId: contact.providerId,
      providerName: contact.providerName,
      subject: "Refund request — " + (booking.campName || "holiday camp") + " (ref " + ref + ")",
      body: lines.join("\n"),
      amount: req.amount,
      scope: req.scope
    };
  }

  // The full action a booking exposes: "request refund" -> messages provider.
  // Persists the request + the outbound message. Returns the record/result.
  function requestRefund(booking, opts, provider) {
    var req = buildRefundRequest(booking, opts);
    if (!req.ok) return req;

    var prov = provider || lookupProvider(booking && booking.providerId);
    var contact = providerContact(prov || { id: booking && booking.providerId, name: booking && booking.campName });
    var message = composeProviderMessage(booking, req, contact);

    var record = {
      bookingId: booking.id || booking.ref || HC.util.uid(),
      providerId: contact.providerId,
      providerName: contact.providerName,
      scope: req.scope,
      amount: req.amount,
      paid: req.paid,
      reason: req.reasonText,
      status: "requested",          // requested -> (provider) refunded
      messagedProvider: true,       // <-- the action MESSAGES the provider
      message: message,
      requestedAt: nowIso()
    };

    // Persist (defensive — never let storage failure break the flow).
    try {
      var all = HC.store.get(STORE_KEY, {}) || {};
      all[record.bookingId] = record;
      HC.store.set(STORE_KEY, all);
    } catch (e) { /* mock persistence is best-effort */ }

    return {
      ok: true,
      record: record,
      message: message,
      // The note Happity shows parents: provider acts, platform does not.
      note: "Your refund request has been sent to " + contact.providerName +
        ". They arrange refunds directly (typically 5–10 business days once approved)."
    };
  }

  function getRequest(bookingId) {
    try {
      var all = HC.store.get(STORE_KEY, {}) || {};
      return all[bookingId] || null;
    } catch (e) { return null; }
  }

  function clearRequest(bookingId) {
    try {
      var all = HC.store.get(STORE_KEY, {}) || {};
      if (all[bookingId]) { delete all[bookingId]; HC.store.set(STORE_KEY, all); }
    } catch (e) { /* ignore */ }
  }

  function nowIso() {
    try { return new Date().toISOString(); } catch (e) { return "2026-06-15T00:00:00.000Z"; }
  }

  function lookupProvider(providerId) {
    try {
      if (!providerId) return null;
      var list = HC.data.providers || [];
      for (var i = 0; i < list.length; i++) {
        if (list[i] && list[i].id === providerId) return list[i];
      }
    } catch (e) { /* ignore */ }
    return null;
  }

  /* ============================================================
   * 2. Demo bookings built from LIVE camp/planner data so the UI
   *    and tests use real provider names + real prices.
   * ============================================================ */

  function demoBookings() {
    var out = [];
    try {
      var providers = HC.data.providers || [];
      var byId = (HC.data.planner && HC.data.planner.byId) || {};
      for (var i = 0; i < providers.length && out.length < 4; i++) {
        var p = providers[i];
        var pl = byId[p.id];
        var unit = null, unitLabel = null;
        if (pl && pl.price) {
          if (typeof pl.price.day === "number") { unit = pl.price.day; unitLabel = "day place"; }
          else if (typeof pl.price.week === "number") { unit = pl.price.week; unitLabel = "full-week place"; }
        }
        if (!unit || unit <= 0) continue;
        // First priced provider -> a 5-session block booking (one full week).
        // Others -> single day-place bookings.
        var isBlock = out.length === 0;
        var sessions = isBlock ? 5 : 1;
        var paid = round2(unit * sessions);
        out.push({
          id: "bk-" + p.id,
          ref: "HC-" + (1000 + i),
          providerId: p.id,
          campName: p.name,
          when: isBlock ? "Week 2 · Mon 27 – Fri 31 July (5 days)" : "single " + unitLabel,
          sessions: sessions,
          unit: unit,
          unitLabel: unitLabel,
          paid: paid,
          status: "confirmed"
        });
      }
    } catch (e) { /* fall through to synthetic */ }

    if (!out.length) {
      out.push({
        id: "bk-demo", ref: "HC-1000", providerId: "demo",
        campName: "Demo Holiday Camp", when: "Week 2 (5 days)",
        sessions: 5, unit: 36, unitLabel: "day place", paid: 180, status: "confirmed"
      });
    }
    // Re-hydrate any persisted request status so the UI is stateful.
    for (var k = 0; k < out.length; k++) {
      var existing = getRequest(out[k].id);
      if (existing && existing.status) out[k].status = existing.status;
    }
    return out;
  }

  /* ============================================================
   * 3. UI — a "My bookings" list where each booking exposes a
   *    "Request refund" action that messages the provider.
   * ============================================================ */

  function render(mountEl) {
    try {
      var bookings = demoBookings();

      mountEl.innerHTML =
        '<div style="font-family:\'Nunito Sans\',system-ui,sans-serif;color:var(--text,#383838)">' +
          '<p style="font-size:14px;margin:0 0 6px">Your holiday-camp bookings. Happity is a third-party ' +
          'booking service, so refunds are arranged with the <strong>class provider directly</strong> — ' +
          'the <em>Request refund</em> action sends them a message.</p>' +
          '<p style="font-size:12.5px;color:var(--muted,#808080);margin:0 0 16px">Providers can issue a ' +
          'full or partial refund (e.g. one session of a block week) and typically take 5–10 business days.</p>' +
          '<div id="rrList"></div>' +
        "</div>";

      var list = mountEl.querySelector("#rrList");

      function paint() {
        bookings = demoBookings();
        list.innerHTML = "";
        bookings.forEach(function (bk) {
          list.appendChild(bookingCard(bk));
        });
      }

      function bookingCard(bk) {
        var req = getRequest(bk.id);
        var card = HC.util.el("div", {
          style: "border:1.5px solid var(--line,#E6E6E6);border-radius:14px;padding:14px 16px;margin-bottom:12px"
        });
        var statusChip = bk.status === "refunded"
          ? '<span style="background:#E1F0E4;color:#2f7d4f;font-weight:700;font-size:11px;padding:3px 9px;border-radius:999px">Refunded</span>'
          : (req && req.status === "requested")
            ? '<span style="background:#FFF3CC;color:#8a6d00;font-weight:700;font-size:11px;padding:3px 9px;border-radius:999px">Refund requested</span>'
            : '<span style="background:var(--purple-tint,#F0E8F4);color:var(--purple,#603488);font-weight:700;font-size:11px;padding:3px 9px;border-radius:999px">Confirmed</span>';

        card.innerHTML =
          '<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px">' +
            '<div>' +
              '<div style="font-family:\'Quicksand\',system-ui,sans-serif;font-weight:700;color:var(--purple,#603488);font-size:15px">' +
                esc(bk.campName) + "</div>" +
              '<div style="font-size:12.5px;color:var(--muted,#808080)">' + esc(bk.when) +
                " · ref " + esc(bk.ref) + " · paid " + HC.util.money(bk.paid) +
                (bk.sessions > 1 ? " (" + bk.sessions + " sessions)" : "") + "</div>" +
            "</div>" + statusChip +
          "</div>" +
          '<div class="rrActions" style="margin-top:10px"></div>' +
          '<div class="rrPanel" style="margin-top:10px"></div>';

        var actions = card.querySelector(".rrActions");
        var panel = card.querySelector(".rrPanel");

        if (bk.status === "refunded") {
          actions.innerHTML = '<span style="font-size:12.5px;color:#2f7d4f">This booking was refunded.</span>';
          return card;
        }
        if (req && req.status === "requested") {
          panel.innerHTML =
            '<div style="background:#FFFAEB;border-radius:10px;padding:10px 12px;font-size:12.5px;color:#7a5d00">' +
              "Refund request sent to <strong>" + esc(req.providerName) + "</strong> for " +
              HC.util.money(req.amount) + " (" + esc(req.scope) + "). They'll arrange the refund directly." +
            "</div>";
          var undo = HC.util.el("button", { class: "hc-btn hc-btn-ghost", type: "button" }, "Cancel request");
          undo.addEventListener("click", function () { clearRequest(bk.id); paint(); });
          actions.appendChild(undo);
          return card;
        }

        var btn = HC.util.el("button", { class: "hc-btn", type: "button" }, "Request refund");
        btn.addEventListener("click", function () { openForm(bk, panel, btn, paint); });
        actions.appendChild(btn);
        return card;
      }

      function openForm(bk, panel, btn, repaint) {
        btn.disabled = true; btn.style.opacity = "0.5";
        var canSession = (Math.floor(Number(bk.sessions) || 1)) > 1;
        var reasonOpts = REASONS.map(function (r) {
          return '<option value="' + escAttr(r) + '">' + esc(r) + "</option>";
        }).join("");

        panel.innerHTML =
          '<div style="background:var(--purple-tint,#F0E8F4);border-radius:12px;padding:12px 14px">' +
            '<label style="display:block;font-weight:700;font-size:12.5px;margin-bottom:4px">Refund type</label>' +
            '<select class="rrScope" style="width:100%;padding:8px;border:1.5px solid var(--line,#E6E6E6);border-radius:10px;font-size:13.5px;margin-bottom:10px">' +
              '<option value="full">Full refund — ' + HC.util.money(bk.paid) + "</option>" +
              (canSession ? '<option value="session">One session — ' + HC.util.money(round2(bk.paid / bk.sessions)) + "</option>" : "") +
              '<option value="partial">Partial — choose amount</option>' +
            "</select>" +
            '<div class="rrAmtWrap" style="display:none;margin-bottom:10px">' +
              '<label style="display:block;font-weight:700;font-size:12.5px;margin-bottom:4px">Amount (£)</label>' +
              '<input class="rrAmt" type="number" min="0" max="' + bk.paid + '" step="0.01" ' +
                'style="width:100%;padding:8px;border:1.5px solid var(--line,#E6E6E6);border-radius:10px;font-size:13.5px">' +
            "</div>" +
            '<label style="display:block;font-weight:700;font-size:12.5px;margin-bottom:4px">Reason for the provider</label>' +
            '<select class="rrReason" style="width:100%;padding:8px;border:1.5px solid var(--line,#E6E6E6);border-radius:10px;font-size:13.5px;margin-bottom:10px">' +
              reasonOpts +
            "</select>" +
            '<textarea class="rrNote" rows="2" placeholder="Add any detail for the provider (optional)" ' +
              'style="width:100%;padding:8px;border:1.5px solid var(--line,#E6E6E6);border-radius:10px;font-size:13px;margin-bottom:10px"></textarea>' +
            '<div class="rrMsg" style="font-size:12px;min-height:14px;margin-bottom:8px"></div>' +
            '<div style="display:flex;gap:8px">' +
              '<button class="hc-btn rrSend" type="button">Send to provider</button>' +
              '<button class="hc-btn hc-btn-ghost rrCancel" type="button">Cancel</button>' +
            "</div>" +
          "</div>";

        var scopeSel = panel.querySelector(".rrScope");
        var amtWrap = panel.querySelector(".rrAmtWrap");
        var amtInput = panel.querySelector(".rrAmt");
        var reasonSel = panel.querySelector(".rrReason");
        var noteEl = panel.querySelector(".rrNote");
        var msgEl = panel.querySelector(".rrMsg");

        scopeSel.addEventListener("change", function () {
          amtWrap.style.display = scopeSel.value === "partial" ? "block" : "none";
        });

        panel.querySelector(".rrCancel").addEventListener("click", function () {
          panel.innerHTML = ""; btn.disabled = false; btn.style.opacity = "1";
        });

        panel.querySelector(".rrSend").addEventListener("click", function () {
          var note = String(noteEl.value || "").trim();
          var reasonBase = reasonSel.value || "";
          var reason = note ? (reasonBase + " — " + note) : reasonBase;
          var opts = { scope: scopeSel.value, reason: reason };
          if (scopeSel.value === "partial") opts.amount = Number(amtInput.value);

          var provider = lookupProvider(bk.providerId);
          var res = requestRefund(bk, opts, provider);
          if (!res.ok) {
            msgEl.textContent = res.message || "Could not send the request.";
            msgEl.style.color = "#9a1f5e";
            return;
          }
          try { HC.util.toast("Refund request sent to " + res.message.providerName); } catch (e) {}
          repaint();
        });
      }

      paint();
    } catch (e) {
      mountEl.innerHTML = '<p style="color:#9a1f5e">Refund-request preview failed to load: ' +
        esc(e && e.message ? e.message : String(e)) + "</p>";
    }
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
  function escAttr(s) { return esc(s).replace(/"/g, "&quot;"); }

  /* ============================================================
   * 4. selfTest — exercises the LOGIC and asserts the acceptance
   *    criterion (a booking's 'request refund' MESSAGES THE PROVIDER)
   *    across multiple cases.
   * ============================================================ */

  function selfTest() {
    var pass = 0, fail = 0, log = [];
    function check(label, fn) {
      try { fn(); pass += 1; log.push("✓ " + label); }
      catch (e) { fail += 1; log.push("✗ " + label + " — " + (e && e.message ? e.message : String(e))); }
    }

    // Sample provider + bookings (independent of live data for determinism).
    var provider = { id: "sunny-camp", name: "Sunny Holiday Camp", source: { url: "https://sunnycamp.example/book" } };
    function freshBlock() {
      return { id: "bk-1", ref: "HC-2001", providerId: "sunny-camp", campName: "Sunny Holiday Camp",
        when: "Week 2 (5 days)", sessions: 5, unit: 36, paid: 180, status: "confirmed" };
    }
    function freshSingle() {
      return { id: "bk-2", ref: "HC-2002", providerId: "sunny-camp", campName: "Sunny Holiday Camp",
        when: "single day place", sessions: 1, unit: 49, paid: 49, status: "confirmed" };
    }

    // Keep mock storage clean between assertions.
    function reset() { try { HC.store.set(STORE_KEY, {}); } catch (e) {} }
    reset();

    /* ---- ACCEPTANCE: the action MESSAGES THE PROVIDER. ---- */
    check("Request refund produces a message ADDRESSED TO THE PROVIDER", function () {
      reset();
      var res = requestRefund(freshBlock(), { scope: "full", reason: "Child unwell" }, provider);
      HC.assert(res.ok === true, "full refund request should succeed");
      HC.assert(res.message, "a provider message must be produced");
      HC.assert(res.message.providerId === "sunny-camp", "message must target the booking's provider id");
      HC.assert(res.message.providerName === "Sunny Holiday Camp", "message must name the provider");
      HC.assert(res.record.messagedProvider === true, "the request must flag that it messaged the provider");
      HC.assert(/refund/i.test(res.message.subject), "subject should mention the refund");
    });

    check("The provider message has a real destination (email or web channel)", function () {
      reset();
      var res = requestRefund(freshBlock(), { scope: "full", reason: "Wrong week" }, provider);
      HC.assert(res.message.to && res.message.to.length > 0, "message must have a 'to' destination");
      HC.assert(res.message.channel === "web", "with a source URL, channel should be 'web'");
      HC.assert(res.message.to === "https://sunnycamp.example/book", "destination should be the provider's contact URL");
    });

    check("Falls back to a provider mailbox when no contact details exist", function () {
      reset();
      var bareProvider = { id: "no-contact-camp", name: "No-Contact Camp" };
      var bk = freshSingle(); bk.providerId = "no-contact-camp";
      var res = requestRefund(bk, { scope: "full", reason: "Found other childcare" }, bareProvider);
      HC.assert(res.ok === true, "should still send even without explicit contact details");
      HC.assert(res.message.channel === "email", "fallback channel should be email");
      HC.assert(/@/.test(res.message.to), "fallback destination should be a mailbox, got " + res.message.to);
      HC.assert(res.message.to.indexOf("no-contact-camp") !== -1, "mailbox should be derived from provider id");
    });

    check("Prefers an explicit provider email over a URL", function () {
      reset();
      var emailProvider = { id: "email-camp", name: "Email Camp", email: "hello@emailcamp.example" };
      var bk = freshSingle(); bk.providerId = "email-camp";
      var res = requestRefund(bk, { scope: "full", reason: "Dates changed" }, emailProvider);
      HC.assert(res.message.channel === "email", "explicit email should set channel to email");
      HC.assert(res.message.to === "hello@emailcamp.example", "should message the provider's email");
    });

    check("Message body references the booking and states the platform does NOT refund directly", function () {
      reset();
      var res = requestRefund(freshBlock(), { scope: "full", reason: "Child unwell" }, provider);
      var body = res.message.body || "";
      HC.assert(body.indexOf("HC-2001") !== -1, "body should include the booking reference");
      HC.assert(/third-party booking service|directly/i.test(body), "body should reflect provider-handles-refunds wording");
      HC.assert(/5.10 business days|5–10 business days|5-10 business days/.test(res.note), "note should mention 5–10 business days, got: " + res.note);
    });

    /* ---- Scope handling: full / session / partial. ---- */
    check("Full refund equals the full paid amount (£180)", function () {
      reset();
      var res = requestRefund(freshBlock(), { scope: "full", reason: "Cancelled" }, provider);
      HC.assert(res.record.amount === 180, "full refund of a £180 block should be £180, got " + res.record.amount);
      HC.assert(res.record.scope === "full", "scope should be 'full'");
    });

    check("Single-session refund of a 5-session £180 block is £36", function () {
      reset();
      var res = requestRefund(freshBlock(), { scope: "session", reason: "One day clash" }, provider);
      HC.assert(res.ok === true, "session refund of a block booking should succeed");
      HC.assert(res.record.amount === 36, "one of five sessions of £180 should be £36, got " + res.record.amount);
      HC.assert(res.message.body.indexOf("ONE session") !== -1, "message should say it's one session");
    });

    check("Session refund is rejected for a single-session booking", function () {
      reset();
      var res = requestRefund(freshSingle(), { scope: "session", reason: "x" }, provider);
      HC.assert(res.ok === false, "single bookings have no per-session refund");
      HC.assert(res.reason === "not-a-block", "reason should be 'not-a-block', got " + res.reason);
    });

    check("Partial refund accepts a valid amount within the paid total", function () {
      reset();
      var res = requestRefund(freshBlock(), { scope: "partial", amount: 72, reason: "Two days missed" }, provider);
      HC.assert(res.ok === true, "valid partial amount should succeed");
      HC.assert(res.record.amount === 72, "partial amount should be £72, got " + res.record.amount);
      HC.assert(res.record.scope === "partial", "scope should be 'partial'");
    });

    check("Partial refund over the paid amount is rejected", function () {
      reset();
      var res = requestRefund(freshBlock(), { scope: "partial", amount: 999, reason: "x" }, provider);
      HC.assert(res.ok === false, "over-paid partial must be rejected");
      HC.assert(res.reason === "over-paid", "reason should be 'over-paid', got " + res.reason);
    });

    check("Partial refund of £0 / negative is rejected", function () {
      reset();
      var r0 = requestRefund(freshBlock(), { scope: "partial", amount: 0, reason: "x" }, provider);
      var rNeg = requestRefund(freshBlock(), { scope: "partial", amount: -5, reason: "x" }, provider);
      HC.assert(r0.ok === false && r0.reason === "bad-amount", "£0 partial must be rejected");
      HC.assert(rNeg.ok === false && rNeg.reason === "bad-amount", "negative partial must be rejected");
    });

    /* ---- Validation guards. ---- */
    check("A reason is required to message the provider", function () {
      reset();
      var res = requestRefund(freshBlock(), { scope: "full", reason: "   " }, provider);
      HC.assert(res.ok === false, "blank reason must be rejected");
      HC.assert(res.reason === "no-reason", "reason should be 'no-reason', got " + res.reason);
    });

    check("A booking with nothing paid cannot be refunded (free/HAF place)", function () {
      reset();
      var freeBk = { id: "bk-free", ref: "HC-FREE", providerId: "sunny-camp", campName: "HAF Camp",
        sessions: 1, paid: 0, status: "confirmed" };
      var res = requestRefund(freeBk, { scope: "full", reason: "Cannot attend" }, provider);
      HC.assert(res.ok === false, "a £0 booking has nothing to refund");
      HC.assert(res.reason === "nothing-paid", "reason should be 'nothing-paid', got " + res.reason);
    });

    check("Missing booking is handled without throwing", function () {
      reset();
      var res = requestRefund(null, { scope: "full", reason: "x" }, provider);
      HC.assert(res.ok === false && res.reason === "no-booking", "null booking should be rejected gracefully");
    });

    /* ---- Lifecycle + persistence (no double-requests). ---- */
    check("Refund request is persisted against the booking via HC.store", function () {
      reset();
      var bk = freshBlock();
      requestRefund(bk, { scope: "full", reason: "Cancelled" }, provider);
      var saved = getRequest(bk.id);
      HC.assert(saved && saved.status === "requested", "request should be stored with status 'requested'");
      HC.assert(saved.messagedProvider === true, "stored record should show the provider was messaged");
      HC.assert(saved.amount === 180, "stored amount should match");
    });

    check("Re-requesting a refund on an already-requested booking is blocked", function () {
      reset();
      var bk = freshBlock();
      requestRefund(bk, { scope: "full", reason: "Cancelled" }, provider);
      // simulate the booking now reflecting the requested status
      bk.status = "requested";
      var again = requestRefund(bk, { scope: "full", reason: "Cancelled again" }, provider);
      HC.assert(again.ok === false, "second request should be blocked");
      HC.assert(again.reason === "already-requested", "reason should be 'already-requested', got " + again.reason);
    });

    check("An already-refunded booking cannot be refunded again", function () {
      reset();
      var bk = freshSingle(); bk.status = "refunded";
      var res = requestRefund(bk, { scope: "full", reason: "x" }, provider);
      HC.assert(res.ok === false && res.reason === "already-refunded", "refunded bookings reject new requests");
    });

    /* ---- Live-data sanity. ---- */
    check("Demo bookings build from live camp data and each can message its provider", function () {
      reset();
      var bookings = demoBookings();
      HC.assert(bookings.length >= 1, "expected >=1 demo booking, got " + bookings.length);
      var bk = bookings[0];
      HC.assert(bk.paid > 0, "first demo booking should have a paid amount");
      var res = requestRefund(bk, { scope: "full", reason: "Live data check" });
      HC.assert(res.ok === true, "a live-data booking should be refundable");
      HC.assert(res.message.providerId === bk.providerId, "message must target the live booking's provider");
      reset();
    });

    return { pass: pass, fail: fail, log: log };
  }

  /* ============================================================
   * 5. Register (idempotent + defensive via core).
   * ============================================================ */
  HC.registerFeature({
    id: "parent-refund-request",
    title: "Request a refund (via provider)",
    side: "parent",
    icon: "💸",
    summary: "Each booking offers a Request refund action that messages the class provider directly (full, partial or single-session). Happity is a third-party booking service, so the provider arranges the refund — typically 5–10 business days.",
    render: render,
    selfTest: selfTest
  });
})();
