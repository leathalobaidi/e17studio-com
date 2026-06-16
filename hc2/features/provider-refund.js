/* HolidayCamp feature — provider-refund
 *
 * Issue a full or partial refund on a booking — via the dashboard or Stripe.
 * (PROVIDER side)
 *
 * Replicates Happity's "How do I issue a refund?" (support article 3818245).
 * Evidence, drawn verbatim from the article:
 *   - "this can be done quickly and easily through Stripe or through your
 *      dashboard." (two methods: 'dashboard' and 'stripe')
 *   - Dashboard flow: Customers > Bookings > find the customer > eye icon to
 *      VIEW their booking > click the "Refund" button > "Choose whether to
 *      issue a full or partial refund, adjust the amount if needed, and confirm."
 *   - "Both methods let you issue full or partial refunds, so if someone only
 *      needs one session refunded from a block booking, you can do that too."
 *   - "When you click Refund, you can edit the amount before confirming."
 *   - 📝 NOTE (the load-bearing rule): "Cancelling a class in your Happity
 *      dashboard does NOT automatically issue a refund. Cancellation and refund
 *      are two separate steps ... This is intentional, as a class transfer is
 *      often more appropriate than a refund."
 *   - FAQ: refunds take 5–10 business days to appear; status is viewable.
 *
 * Framed for SCHOOL-AGE HOLIDAY CAMPS: a camp provider needs to refund a parent
 * — maybe the whole half-term week, or just one rained-off Wednesday from a
 * 5-day block. The provider opens the paid booking and clicks Refund, picks
 * FULL or PARTIAL, adjusts the amount, and confirms. If the provider instead
 * CANCELS a camp day, the bookings are marked cancelled but NO money moves until
 * a refund is issued separately — exactly as Happity documents.
 *
 * ACCEPTANCE CRITERION (exercised by selfTest, multiple cases):
 *   A booking offers Refund with a full/partial amount; cancelling a class does
 *   NOT auto-refund.
 *
 * Self-contained, defensive, no imports/exports. Calls HC.registerFeature.
 */
(function () {
  "use strict";

  // Defensive: never throw at module load if HC isn't present.
  if (typeof window === "undefined" || !window.HC || typeof window.HC.registerFeature !== "function") {
    if (typeof console !== "undefined" && console.warn) {
      console.warn("[HC] provider-refund: HC core not found; skipping registration.");
    }
    return;
  }

  var HC = window.HC;

  // Distinct from parent-refund-request's "refund_requests" store: this is the
  // PROVIDER ledger of bookings + refunds it has actually issued.
  var STORE_KEY = "provider_refund_state";
  var DEMO_STORE_KEY = "provider_refund_demo";

  /* ---------------- tiny helpers ---------------- */
  function nowIso() {
    try { return new Date().toISOString(); } catch (e) { return "" + Date.now(); }
  }
  function safeUid() {
    try { return HC.util.uid(); } catch (e) { return "id_" + Math.random().toString(36).slice(2); }
  }
  function str(v) { return v === null || v === undefined ? "" : String(v); }
  function trimmed(v) { return str(v).trim(); }

  // Round to whole pence to avoid floating-point drift on money maths.
  function pence(n) {
    var num = Number(n);
    if (!isFinite(num)) return 0;
    return Math.round(num * 100);
  }
  function fromPence(p) { return Math.round(Number(p) || 0) / 100; }

  function money(n) {
    try { return HC.util.money(n); } catch (e) { return "£" + (Number(n) || 0).toFixed(2); }
  }

  function esc(s) {
    return str(s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  /* ================================================================
   * Data model (mock, all under one namespaced HC.store key):
   *
   *   state = {
   *     bookings: { <bookingId>: {
   *        id, providerId, classId, className, dateLabel,
   *        parentName, parentEmail, childName,
   *        // money is held in PENCE to keep arithmetic exact
   *        amountPence,           // gross paid for this booking
   *        refundedPence,         // running total already refunded
   *        sessions: [ { id, label, pricePence, refundedPence } ],  // block lines
   *        status,                // 'paid' | 'cancelled' (class state, NOT money)
   *        refunds: [ refundId... ],
   *        paidAt
   *     }},
   *     refunds: { <refundId>: {
   *        id, bookingId, providerId, method ('dashboard'|'stripe'),
   *        kind ('full'|'partial'), amountPence, reason,
   *        sessionIds:[...]|null, createdAt, etaDays:'5–10 business days'
   *     }}
   *   }
   *
   * Crucial invariant: a refund only ever exists if issueRefund() was called.
   * cancelClass() touches `status` and NEVER writes a refund. That is the
   * acceptance criterion encoded in the data model itself.
   * ================================================================ */

  function blankState() { return { bookings: {}, refunds: {} }; }

  function loadState() {
    var s = HC.store.get(STORE_KEY, null);
    if (!s || typeof s !== "object") s = blankState();
    if (!s.bookings || typeof s.bookings !== "object") s.bookings = {};
    if (!s.refunds || typeof s.refunds !== "object") s.refunds = {};
    return s;
  }
  function saveState(s) {
    try { HC.store.set(STORE_KEY, s); return true; } catch (e) { return false; }
  }

  /* ---------------- create / read a booking ---------------- */

  // Normalise a booking record, computing amountPence from either an explicit
  // amount or the sum of its session lines (block booking).
  function makeBooking(b) {
    b = b || {};
    var sessions = [];
    var sumPence = 0;
    if (Array.isArray(b.sessions) && b.sessions.length) {
      for (var i = 0; i < b.sessions.length; i++) {
        var ss = b.sessions[i] || {};
        var pp = ss.pricePence != null ? Math.round(Number(ss.pricePence) || 0) : pence(ss.price);
        var sess = {
          id: str(ss.id) || safeUid(),
          label: str(ss.label) || ("Session " + (i + 1)),
          pricePence: pp,
          refundedPence: Math.max(0, Math.min(pp, Math.round(Number(ss.refundedPence) || 0)))
        };
        sessions.push(sess);
        sumPence += sess.pricePence;
      }
    }
    var amountPence = b.amountPence != null ? Math.round(Number(b.amountPence) || 0)
      : (sessions.length ? sumPence : pence(b.amount));
    var refundedPence = Math.max(0, Math.min(amountPence, Math.round(Number(b.refundedPence) || 0)));

    return {
      id: str(b.id) || safeUid(),
      providerId: str(b.providerId) || "provider-0",
      classId: str(b.classId) || "",
      className: str(b.className) || "Holiday camp",
      dateLabel: str(b.dateLabel) || "",
      parentName: str(b.parentName) || "",
      parentEmail: str(b.parentEmail) || "",
      childName: str(b.childName) || "",
      amountPence: amountPence,
      refundedPence: refundedPence,
      sessions: sessions,
      status: (b.status === "cancelled" ? "cancelled" : "paid"),
      refunds: Array.isArray(b.refunds) ? b.refunds.slice() : [],
      paidAt: str(b.paidAt) || nowIso()
    };
  }

  function upsertBooking(state, b) {
    var rec = makeBooking(b);
    state.bookings[rec.id] = rec;
    return rec;
  }
  function getBooking(state, id) { return state.bookings[str(id)] || null; }

  // How much is still refundable on a booking (gross minus already refunded).
  function remainingPence(booking) {
    if (!booking) return 0;
    return Math.max(0, booking.amountPence - booking.refundedPence);
  }

  /* ---------------- the refundable-amount preview ----------------
   *
   * Mirrors the Refund dialog: it offers a FULL amount by default (the whole
   * remaining balance) and lets the provider switch to PARTIAL and edit the
   * figure, or pick specific sessions from a block booking. This pure function
   * is what the UI and the tests both call.
   *
   * Returns { fullPence, remainingPence, alreadyRefundedPence, sessions:[...] }.
   */
  function refundOptions(booking) {
    if (!booking) return { fullPence: 0, remainingPence: 0, alreadyRefundedPence: 0, sessions: [] };
    var rem = remainingPence(booking);
    var sess = (booking.sessions || []).map(function (s) {
      return {
        id: s.id, label: s.label,
        pricePence: s.pricePence,
        refundedPence: s.refundedPence,
        remainingPence: Math.max(0, s.pricePence - s.refundedPence)
      };
    });
    return {
      fullPence: rem,                 // "full" == the whole remaining balance
      remainingPence: rem,
      alreadyRefundedPence: booking.refundedPence,
      sessions: sess
    };
  }

  /* ---------------- issue a refund (the acceptance action) ----------------
   *
   * opts = {
   *   method: 'dashboard' | 'stripe',   // both supported per the article
   *   kind:   'full' | 'partial',
   *   amount:  Number (£) | amountPence: Number,   // for partial / explicit
   *   sessionIds: [..],                 // optional: refund specific block lines
   *   reason:  String
   * }
   *
   * Rules enforced (all from the evidence + sane money guards):
   *   - method must be 'dashboard' or 'stripe'
   *   - 'full'  => refunds the entire REMAINING balance
   *   - 'partial' with sessionIds => refunds the remaining value of those lines
   *   - 'partial' with an amount  => refunds exactly that amount
   *   - cannot refund 0 or a negative amount
   *   - cannot refund more than remains (no over-refund)
   *   - a fully-refunded booking can't be refunded again
   * Returns { ok, refund|null, booking, error|null }. Never throws.
   */
  function issueRefund(state, bookingId, opts) {
    try {
      var booking = getBooking(state, bookingId);
      if (!booking) return { ok: false, refund: null, booking: null, error: "booking not found" };

      opts = opts || {};
      var method = (opts.method === "stripe") ? "stripe" : (opts.method === "dashboard" ? "dashboard" : null);
      if (!method) {
        return { ok: false, refund: null, booking: booking, error: "choose a refund method (dashboard or Stripe)" };
      }

      var rem = remainingPence(booking);
      if (rem <= 0) {
        return { ok: false, refund: null, booking: booking, error: "nothing left to refund — already fully refunded" };
      }

      var kind = (opts.kind === "partial") ? "partial" : (opts.kind === "full" ? "full" : null);
      var sessionIds = Array.isArray(opts.sessionIds) ? opts.sessionIds.map(str).filter(Boolean) : null;
      var amountPence = 0;
      var touchedSessions = [];

      if (sessionIds && sessionIds.length) {
        // Refund specific sessions from a block booking (the article's example:
        // "if someone only needs one session refunded from a block booking").
        kind = "partial";
        for (var i = 0; i < booking.sessions.length; i++) {
          var s = booking.sessions[i];
          if (sessionIds.indexOf(s.id) === -1) continue;
          var leftOnLine = Math.max(0, s.pricePence - s.refundedPence);
          if (leftOnLine <= 0) continue; // already refunded this line
          amountPence += leftOnLine;
          touchedSessions.push(s);
        }
        if (amountPence <= 0) {
          return { ok: false, refund: null, booking: booking, error: "those sessions are already refunded" };
        }
      } else if (kind === "full") {
        amountPence = rem; // whole remaining balance
      } else {
        // Partial by explicit amount — the provider edited the figure.
        kind = "partial";
        amountPence = (opts.amountPence != null)
          ? Math.round(Number(opts.amountPence) || 0)
          : pence(opts.amount);
        if (!isFinite(amountPence) || amountPence <= 0) {
          return { ok: false, refund: null, booking: booking, error: "enter a refund amount greater than £0" };
        }
      }

      if (amountPence > rem) {
        return {
          ok: false, refund: null, booking: booking,
          error: "refund of " + money(fromPence(amountPence)) + " exceeds the " +
            money(fromPence(rem)) + " still refundable"
        };
      }

      // Commit: write the refund record and update the running totals.
      var refund = {
        id: safeUid(),
        bookingId: booking.id,
        providerId: booking.providerId,
        method: method,
        kind: kind,
        amountPence: amountPence,
        reason: trimmed(opts.reason),
        sessionIds: touchedSessions.length ? touchedSessions.map(function (x) { return x.id; }) : null,
        createdAt: nowIso(),
        etaDays: "5–10 business days"
      };

      booking.refundedPence += amountPence;
      for (var j = 0; j < touchedSessions.length; j++) {
        touchedSessions[j].refundedPence = touchedSessions[j].pricePence;
      }
      booking.refunds.push(refund.id);
      state.refunds[refund.id] = refund;

      saveState(state);
      return { ok: true, refund: refund, booking: booking, error: null };
    } catch (e) {
      return { ok: false, refund: null, booking: null, error: e && e.message ? e.message : String(e) };
    }
  }

  /* ---------------- cancel a class (the NON-refunding action) ----------------
   *
   * This is the load-bearing acceptance behaviour. Cancelling marks the booking
   * (and its sessions) as cancelled but DELIBERATELY issues no refund. Money is
   * only moved by a SEPARATE issueRefund() call. A class transfer is often more
   * appropriate, per the evidence.
   *
   * Returns { ok, booking, refundIssued:false, note }. Never auto-refunds.
   */
  function cancelClass(state, bookingId) {
    try {
      var booking = getBooking(state, bookingId);
      if (!booking) return { ok: false, booking: null, refundIssued: false, note: "booking not found" };
      booking.status = "cancelled";
      saveState(state);
      return {
        ok: true,
        booking: booking,
        // The whole point: cancellation NEVER moves money.
        refundIssued: false,
        note: "Class cancelled. No refund was issued — that's a separate step."
      };
    } catch (e) {
      return { ok: false, booking: null, refundIssued: false, note: e && e.message ? e.message : String(e) };
    }
  }

  function refundsForBooking(state, bookingId) {
    var b = getBooking(state, bookingId);
    if (!b) return [];
    var out = [];
    for (var i = 0; i < b.refunds.length; i++) {
      var r = state.refunds[b.refunds[i]];
      if (r) out.push(r);
    }
    return out;
  }
  function isFullyRefunded(booking) {
    return !!booking && remainingPence(booking) <= 0 && booking.amountPence > 0;
  }

  /* ---------------- a sensible default provider from live data ---------------- */
  function defaultProvider() {
    try {
      var ps = HC.data.providers;
      if (ps && ps.length) {
        var p = ps[0];
        return { id: str(p.id || p.slug || p.name || "provider-0"), name: str(p.name || "Holiday camp") };
      }
    } catch (e) { /* ignore */ }
    return { id: "provider-0", name: "Holiday camp" };
  }

  /* ================================================================
   * UI — render(mountEl). A working Refund panel:
   *   - shows a paid block booking (5-day half-term week)
   *   - "Refund" opens a chooser: Full / Partial (edit amount) / pick sessions
   *   - method toggle: Dashboard or Stripe
   *   - a "Cancel this class day" button that proves NO money moves
   *
   * Uses its OWN demo store slot so it never collides with selfTest fixtures.
   * ================================================================ */

  function loadDemo() {
    var s = HC.store.get(DEMO_STORE_KEY, null);
    if (!s || typeof s !== "object") s = blankState();
    if (!s.bookings || typeof s.bookings !== "object") s.bookings = {};
    if (!s.refunds || typeof s.refunds !== "object") s.refunds = {};
    return s;
  }
  function saveDemo(s) { try { HC.store.set(DEMO_STORE_KEY, s); } catch (e) {} }

  function seedDemo() {
    var s = loadDemo();
    var prov = defaultProvider();
    if (!s.bookings["demo-booking"]) {
      upsertBooking(s, {
        id: "demo-booking",
        providerId: prov.id,
        className: (prov.name || "Summer Multi-Sports Camp"),
        dateLabel: "Summer half-term · 28 Jul – 1 Aug",
        parentName: "Sam Okafor",
        parentEmail: "sam.okafor@example.com",
        childName: "Ada Okafor",
        sessions: [
          { id: "mon", label: "Mon 28 Jul", price: 36 },
          { id: "tue", label: "Tue 29 Jul", price: 36 },
          { id: "wed", label: "Wed 30 Jul", price: 36 },
          { id: "thu", label: "Thu 31 Jul", price: 36 },
          { id: "fri", label: "Fri 1 Aug", price: 36 }
        ]
      });
      saveDemo(s);
    }
    return { state: s, providerId: prov.id };
  }

  function render(mountEl) {
    try {
      seedDemo();
      var BID = "demo-booking";

      function paint() {
        var s = loadDemo();
        var b = getBooking(s, BID);
        var opts = refundOptions(b);
        var refunds = refundsForBooking(s, BID);

        var sessHtml = "";
        for (var i = 0; i < opts.sessions.length; i++) {
          var ss = opts.sessions[i];
          var done = ss.remainingPence <= 0;
          sessHtml +=
            '<label style="display:flex;align-items:center;gap:8px;padding:5px 0;font-size:13.5px' +
              (done ? ';opacity:.5' : '') + '">' +
              '<input type="checkbox" class="hcrfSess" value="' + esc(ss.id) + '"' + (done ? ' disabled' : '') + ' />' +
              '<span style="flex:1">' + esc(ss.label) + '</span>' +
              '<span>' + money(fromPence(ss.pricePence)) +
                (done ? ' <span style="color:#2f7d4f">· refunded</span>' : '') + '</span>' +
            '</label>';
        }

        var refundsHtml = "";
        if (refunds.length) {
          refundsHtml = '<div style="margin-top:14px"><div style="font-family:Quicksand,system-ui,sans-serif;font-weight:700;color:#603488;font-size:13px;margin-bottom:4px">Refunds issued</div>';
          for (var r = 0; r < refunds.length; r++) {
            var rf = refunds[r];
            refundsHtml +=
              '<div style="font-size:12.5px;color:#383838;border-left:3px solid #2f7d4f;padding:2px 0 2px 8px;margin:3px 0">' +
                '<strong>' + money(fromPence(rf.amountPence)) + '</strong> · ' + esc(rf.kind) +
                ' via ' + esc(rf.method === "stripe" ? "Stripe" : "dashboard") +
                ' <span style="color:#808080">(' + esc(rf.etaDays) + ')</span>' +
                (rf.reason ? ' — ' + esc(rf.reason) : '') +
              '</div>';
          }
          refundsHtml += '</div>';
        }

        var statusBadge = b.status === "cancelled"
          ? '<span style="background:#FCE8F0;color:#9a1f5e;font-size:11px;font-weight:700;padding:2px 8px;border-radius:999px">Class cancelled</span>'
          : '<span style="background:#E1F0E4;color:#2f7d4f;font-size:11px;font-weight:700;padding:2px 8px;border-radius:999px">Paid</span>';

        var fully = isFullyRefunded(b);

        mountEl.innerHTML =
          '<div style="font-family:Nunito Sans,system-ui,sans-serif;color:#383838;font-size:14px;line-height:1.55">' +
            '<p style="margin:0 0 12px">Need to refund a parent? Open their paid booking and click <strong>Refund</strong>. ' +
            'You can issue the <strong>full</strong> amount or a <strong>partial</strong> one — handy if only one rained-off day needs refunding from a block.</p>' +

            '<div style="background:#F0E8F4;border-radius:14px;padding:14px 16px;margin:0 0 16px">' +
              '<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px">' +
                '<div>' +
                  '<div style="font-family:Quicksand,system-ui,sans-serif;font-weight:700;color:#603488;font-size:15px">👁 ' + esc(b.className) + '</div>' +
                  '<div style="font-size:12.5px;color:#603488;margin:2px 0">' + esc(b.dateLabel) + '</div>' +
                  '<div style="font-size:12.5px;color:#603488">' + esc(b.childName) + ' · ' + esc(b.parentName) + '</div>' +
                '</div>' + statusBadge +
              '</div>' +
              '<div style="margin-top:8px;font-size:13px;color:#603488">' +
                'Paid <strong>' + money(fromPence(b.amountPence)) + '</strong> · ' +
                'refunded <strong>' + money(fromPence(opts.alreadyRefundedPence)) + '</strong> · ' +
                'refundable <strong>' + money(fromPence(opts.remainingPence)) + '</strong>' +
              '</div>' +
            '</div>' +

            (fully
              ? '<p style="color:#2f7d4f;font-weight:700">This booking is fully refunded.</p>'
              : (
              '<div style="border:1.5px solid #E6E6E6;border-radius:14px;padding:14px 16px">' +
                '<div style="font-family:Quicksand,system-ui,sans-serif;font-weight:700;color:#603488;margin-bottom:8px">Refund</div>' +

                '<div style="display:flex;gap:14px;flex-wrap:wrap;margin-bottom:10px">' +
                  '<label style="font-size:13.5px;display:flex;align-items:center;gap:6px"><input type="radio" name="hcrfKind" value="full" checked /> Full (' + money(fromPence(opts.fullPence)) + ')</label>' +
                  '<label style="font-size:13.5px;display:flex;align-items:center;gap:6px"><input type="radio" name="hcrfKind" value="partial" /> Partial</label>' +
                '</div>' +

                '<div id="hcrfPartialWrap" style="display:none;margin-bottom:10px">' +
                  '<div style="font-size:12.5px;color:#808080;margin-bottom:6px">Tick whole sessions, or enter an amount to refund.</div>' +
                  sessHtml +
                  '<div style="margin-top:6px">' +
                    '<label style="font-size:12.5px;color:#603488;font-weight:700;font-family:Quicksand,system-ui,sans-serif">Or amount £</label> ' +
                    '<input id="hcrfAmount" type="number" min="0" step="0.01" placeholder="e.g. 36.00" ' +
                      'style="width:120px;padding:6px 8px;border:1.5px solid #E6E6E6;border-radius:8px;font-size:13.5px" />' +
                  '</div>' +
                '</div>' +

                '<div style="margin-bottom:10px">' +
                  '<span style="font-size:12.5px;color:#603488;font-weight:700;font-family:Quicksand,system-ui,sans-serif">Method</span> ' +
                  '<label style="font-size:13.5px;margin-left:8px"><input type="radio" name="hcrfMethod" value="dashboard" checked /> Dashboard</label> ' +
                  '<label style="font-size:13.5px;margin-left:8px"><input type="radio" name="hcrfMethod" value="stripe" /> Stripe</label>' +
                '</div>' +

                '<input id="hcrfReason" type="text" placeholder="Reason (optional) — e.g. Wednesday rained off" ' +
                  'style="width:100%;padding:8px 10px;border:1.5px solid #E6E6E6;border-radius:10px;font-size:13.5px;margin-bottom:10px" />' +

                '<div style="display:flex;gap:8px;flex-wrap:wrap">' +
                  '<button id="hcrfDo" type="button" class="hc-btn">Confirm refund</button>' +
                  '<button id="hcrfCancelClass" type="button" class="hc-btn hc-btn-ghost">Cancel this class (no refund)</button>' +
                '</div>' +
              '</div>'
              )) +

            '<div id="hcrfMsg" style="margin-top:10px;font-size:13px"></div>' +
            refundsHtml +
            '<p style="margin-top:14px;font-size:11.5px;color:#808080">📝 Cancelling a class does <strong>not</strong> issue a refund — cancellation and refund are two separate steps, following the same marketplace pattern. Refunds take 5–10 business days to reach the parent.</p>' +
          '</div>';

        wire();
      }

      function wire() {
        var q = function (sel) { return mountEl.querySelector(sel); };
        var msg = q("#hcrfMsg");
        var partialWrap = q("#hcrfPartialWrap");

        mountEl.querySelectorAll('input[name="hcrfKind"]').forEach(function (radio) {
          radio.addEventListener("change", function () {
            var partial = mountEl.querySelector('input[name="hcrfKind"][value="partial"]');
            if (partialWrap) partialWrap.style.display = (partial && partial.checked) ? "block" : "none";
          });
        });

        var doBtn = q("#hcrfDo");
        if (doBtn) doBtn.addEventListener("click", function () {
          var s = loadDemo();
          var kindEl = mountEl.querySelector('input[name="hcrfKind"]:checked');
          var methodEl = mountEl.querySelector('input[name="hcrfMethod"]:checked');
          var kind = kindEl ? kindEl.value : "full";
          var method = methodEl ? methodEl.value : "dashboard";
          var reason = q("#hcrfReason") ? q("#hcrfReason").value : "";

          var opts = { method: method, kind: kind, reason: reason };
          if (kind === "partial") {
            var ticked = [];
            mountEl.querySelectorAll(".hcrfSess:checked").forEach(function (c) { ticked.push(c.value); });
            var amtRaw = q("#hcrfAmount") ? q("#hcrfAmount").value : "";
            if (ticked.length) opts.sessionIds = ticked;
            else if (trimmed(amtRaw)) opts.amount = Number(amtRaw);
            else {
              if (msg) msg.innerHTML = '<span style="color:#9a1f5e">Tick a session or enter an amount for a partial refund.</span>';
              return;
            }
          }

          var res = issueRefund(s, BID, opts);
          if (!res.ok) {
            if (msg) msg.innerHTML = '<span style="color:#9a1f5e">Could not refund: ' + esc(res.error) + '</span>';
            return;
          }
          try { HC.util.toast("Refunded " + money(fromPence(res.refund.amountPence))); } catch (e) {}
          paint();
          var m2 = mountEl.querySelector("#hcrfMsg");
          if (m2) m2.innerHTML = '<span style="color:#2f7d4f;font-weight:700">✓ ' +
            esc(money(fromPence(res.refund.amountPence))) + ' ' + esc(res.refund.kind) +
            ' refund issued via ' + esc(res.refund.method === "stripe" ? "Stripe" : "dashboard") +
            ' (' + esc(res.refund.etaDays) + ').</span>';
        });

        var cancelBtn = q("#hcrfCancelClass");
        if (cancelBtn) cancelBtn.addEventListener("click", function () {
          var s = loadDemo();
          var before = getBooking(s, BID);
          var refundsBefore = before ? before.refunds.length : 0;
          var res = cancelClass(s, BID);
          paint();
          var after = getBooking(loadDemo(), BID);
          var refundsAfter = after ? after.refunds.length : 0;
          var m2 = mountEl.querySelector("#hcrfMsg");
          if (m2) {
            m2.innerHTML = '<span style="color:#9a1f5e">Class cancelled — but <strong>no refund was issued</strong> ' +
              '(refunds before: ' + refundsBefore + ', after: ' + refundsAfter + '). ' +
              'Issue a refund separately if appropriate.</span>';
          }
          try { HC.util.toast("Class cancelled — no money moved"); } catch (e) {}
        });
      }

      paint();

      // A small reset so the demo doesn't accumulate refunds across opens.
      var resetWrap = HC.util.el("div", { style: "margin-top:14px" });
      var resetBtn = HC.util.el("button",
        { type: "button", class: "hc-btn hc-btn-ghost", style: "font-size:11px" },
        "Reset demo booking");
      resetBtn.addEventListener("click", function () {
        if (HC.store.remove) HC.store.remove(DEMO_STORE_KEY); else HC.store.set(DEMO_STORE_KEY, null);
        seedDemo();
        paint();
        mountEl.appendChild(resetWrap);
      });
      resetWrap.appendChild(resetBtn);
      mountEl.appendChild(resetWrap);
    } catch (e) {
      mountEl.innerHTML = '<p style="color:#9a1f5e">Preview unavailable: ' +
        (e && e.message ? e.message : String(e)) + "</p>";
    }
  }

  /* ================================================================
   * selfTest — exercises the LOGIC and asserts the acceptance criterion:
   *   "A booking offers Refund with a full/partial amount; cancelling a class
   *    does NOT auto-refund."   (multiple cases)
   * ================================================================ */
  function selfTest() {
    var pass = 0, fail = 0, log = [];
    function check(label, fn) {
      try { fn(); pass += 1; log.push("✓ " + label); }
      catch (e) { fail += 1; log.push("✗ " + label + " — " + (e && e.message ? e.message : String(e))); }
    }
    var A = HC.assert;

    // Fresh isolated state with one £180 five-day block booking (5 × £36).
    function freshState() {
      var s = blankState();
      upsertBooking(s, {
        id: "bk-1", providerId: "prov-A",
        className: "Summer Camp", dateLabel: "half-term",
        parentName: "Sam Okafor", parentEmail: "sam@example.com", childName: "Ada",
        sessions: [
          { id: "mon", label: "Mon", price: 36 },
          { id: "tue", label: "Tue", price: 36 },
          { id: "wed", label: "Wed", price: 36 },
          { id: "thu", label: "Thu", price: 36 },
          { id: "fri", label: "Fri", price: 36 }
        ]
      });
      return s;
    }

    // --- ACCEPTANCE part 1a: a booking OFFERS a refund with a FULL amount ---
    check("ACCEPTANCE: booking offers a FULL refund of the whole balance", function () {
      var s = freshState();
      var b = getBooking(s, "bk-1");
      A(b.amountPence === 18000, "block totals £180, got " + b.amountPence + "p");
      var opts = refundOptions(b);
      A(opts.fullPence === 18000, "full option = whole balance £180, got " + opts.fullPence + "p");
      var res = issueRefund(s, "bk-1", { method: "dashboard", kind: "full" });
      A(res.ok === true, "full refund issued: " + res.error);
      A(res.refund.kind === "full", "recorded as full");
      A(res.refund.amountPence === 18000, "refunded £180, got " + res.refund.amountPence + "p");
      A(remainingPence(res.booking) === 0, "nothing left to refund");
      A(isFullyRefunded(res.booking), "booking marked fully refunded");
    });

    // --- ACCEPTANCE part 1b: a booking OFFERS a PARTIAL refund by amount ---
    check("ACCEPTANCE: booking offers a PARTIAL refund (edited amount)", function () {
      var s = freshState();
      var res = issueRefund(s, "bk-1", { method: "dashboard", kind: "partial", amount: 36 });
      A(res.ok === true, "partial refund issued: " + res.error);
      A(res.refund.kind === "partial", "recorded as partial");
      A(res.refund.amountPence === 3600, "refunded £36, got " + res.refund.amountPence + "p");
      A(remainingPence(res.booking) === 14400, "£144 still refundable, got " + remainingPence(res.booking) + "p");
    });

    // --- ACCEPTANCE part 1c: partial by SESSION (one day from a block) ---
    check("ACCEPTANCE: partial refund of ONE session from a block booking", function () {
      var s = freshState();
      var res = issueRefund(s, "bk-1", { method: "stripe", sessionIds: ["wed"] });
      A(res.ok === true, "session refund issued: " + res.error);
      A(res.refund.kind === "partial", "session refund is partial");
      A(res.refund.method === "stripe", "via Stripe");
      A(res.refund.amountPence === 3600, "one day = £36, got " + res.refund.amountPence + "p");
      A(remainingPence(res.booking) === 14400, "£144 remains after one day, got " + remainingPence(res.booking) + "p");
      // That session is now flagged refunded and can't be double-refunded.
      var again = issueRefund(s, "bk-1", { method: "stripe", sessionIds: ["wed"] });
      A(again.ok === false, "the same session cannot be refunded twice");
    });

    // --- ACCEPTANCE part 2: cancelling a class does NOT auto-refund ---
    check("ACCEPTANCE: cancelling a class does NOT auto-refund", function () {
      var s = freshState();
      var b0 = getBooking(s, "bk-1");
      A(b0.refunds.length === 0, "no refunds before cancel");
      A(b0.refundedPence === 0, "£0 refunded before cancel");

      var res = cancelClass(s, "bk-1");
      A(res.ok === true, "cancel succeeded");
      A(res.refundIssued === false, "cancel explicitly reports NO refund issued");

      var b1 = getBooking(s, "bk-1");
      A(b1.status === "cancelled", "booking status is cancelled");
      A(b1.refunds.length === 0, "STILL no refund records after cancel, got " + b1.refunds.length);
      A(b1.refundedPence === 0, "STILL £0 refunded after cancel, got " + b1.refundedPence + "p");
      A(remainingPence(b1) === 18000, "full £180 still refundable — money untouched by cancel");
      A(Object.keys(s.refunds).length === 0, "no refund objects created anywhere by cancel");
    });

    // --- and refund + cancel are independent: you can refund AFTER cancelling ---
    check("Refund is a SEPARATE step you can still take after cancelling", function () {
      var s = freshState();
      cancelClass(s, "bk-1");
      var res = issueRefund(s, "bk-1", { method: "stripe", kind: "full" });
      A(res.ok === true, "can still refund a cancelled class as a separate action: " + res.error);
      A(res.refund.amountPence === 18000, "full £180 refunded post-cancel");
    });

    // --- both methods are supported (dashboard AND Stripe) ---
    check("Both refund methods are accepted: dashboard and Stripe", function () {
      var s = freshState();
      var d = issueRefund(s, "bk-1", { method: "dashboard", kind: "partial", amount: 36 });
      A(d.ok && d.refund.method === "dashboard", "dashboard refund ok");
      var st = issueRefund(s, "bk-1", { method: "stripe", kind: "partial", amount: 36 });
      A(st.ok && st.refund.method === "stripe", "stripe refund ok");
      A(getBooking(s, "bk-1").refundedPence === 7200, "two £36 refunds total £72, got " + getBooking(s, "bk-1").refundedPence + "p");
    });

    // --- guard: a refund method MUST be chosen ---
    check("Validation: a method (dashboard/Stripe) is required", function () {
      var s = freshState();
      var res = issueRefund(s, "bk-1", { kind: "full" });
      A(res.ok === false, "rejected with no method");
      A(/method/i.test(res.error || ""), "error mentions method, got " + res.error);
    });

    // --- guard: cannot over-refund beyond the remaining balance ---
    check("Validation: cannot refund more than the remaining balance", function () {
      var s = freshState();
      var res = issueRefund(s, "bk-1", { method: "dashboard", kind: "partial", amount: 200 });
      A(res.ok === false, "over-refund rejected");
      A(/exceed/i.test(res.error || ""), "error explains the over-refund, got " + res.error);
      A(getBooking(s, "bk-1").refundedPence === 0, "nothing was refunded on a rejected attempt");
    });

    // --- guard: a fully-refunded booking can't be refunded again ---
    check("Validation: a fully-refunded booking cannot be refunded again", function () {
      var s = freshState();
      A(issueRefund(s, "bk-1", { method: "dashboard", kind: "full" }).ok, "first full refund ok");
      var again = issueRefund(s, "bk-1", { method: "dashboard", kind: "full" });
      A(again.ok === false, "second refund rejected");
      A(/already|nothing/i.test(again.error || ""), "error explains it's already refunded, got " + again.error);
    });

    // --- guard: zero / negative partial amounts are rejected ---
    check("Validation: a £0 or negative partial amount is rejected", function () {
      var s = freshState();
      A(issueRefund(s, "bk-1", { method: "stripe", kind: "partial", amount: 0 }).ok === false, "£0 rejected");
      A(issueRefund(s, "bk-1", { method: "stripe", kind: "partial", amount: -5 }).ok === false, "negative rejected");
      A(getBooking(s, "bk-1").refundedPence === 0, "no money moved on rejected amounts");
    });

    // --- guard: unknown booking ---
    check("Validation: refunding an unknown booking fails cleanly", function () {
      var s = freshState();
      var res = issueRefund(s, "no-such-booking", { method: "stripe", kind: "full" });
      A(res.ok === false, "rejected");
      A(/not found/i.test(res.error || ""), "error mentions not found, got " + res.error);
    });

    // --- money maths: partial refunds accumulate to the full amount exactly ---
    check("Partial refunds accumulate exactly up to the full amount", function () {
      var s = freshState();
      issueRefund(s, "bk-1", { method: "stripe", sessionIds: ["mon"] });
      issueRefund(s, "bk-1", { method: "stripe", sessionIds: ["tue", "wed"] });
      issueRefund(s, "bk-1", { method: "dashboard", kind: "partial", amount: 72 }); // thu+fri
      var b = getBooking(s, "bk-1");
      A(b.refundedPence === 18000, "sum of partials = £180 exactly, got " + b.refundedPence + "p");
      A(isFullyRefunded(b), "now fully refunded via partials");
      A(refundsForBooking(s, "bk-1").length === 3, "three separate refund records, got " + refundsForBooking(s, "bk-1").length);
    });

    // --- persistence round-trips through HC.store (mock, hc_ namespaced) ---
    check("A refund round-trips via HC.store", function () {
      var s = loadState();
      var bid = "rt-bk-" + safeUid();
      upsertBooking(s, { id: bid, providerId: "rt", className: "RT", amount: 50 });
      var res = issueRefund(s, bid, { method: "dashboard", kind: "partial", amount: 20 });
      A(res.ok, "saved refund");
      var back = loadState();
      var b = getBooking(back, bid);
      A(b && b.refundedPence === 2000, "refund persisted (£20), got " + (b ? b.refundedPence : "null") + "p");
      A(refundsForBooking(back, bid).length === 1, "refund record persisted");
      // Clean up so we don't leak test state into the live store.
      try {
        var c = loadState();
        var rec = getBooking(c, bid);
        if (rec) { for (var i = 0; i < rec.refunds.length; i++) delete c.refunds[rec.refunds[i]]; }
        delete c.bookings[bid];
        saveState(c);
      } catch (e) { /* ignore */ }
    });

    return { pass: pass, fail: fail, log: log };
  }

  /* ---------------- register ---------------- */
  HC.registerFeature({
    id: "provider-refund",
    title: "Issue a refund",
    side: "provider",
    icon: "💸",
    summary: "Refund a parent in full or part — via the dashboard or Stripe. Refund one rained-off day from a 5-day block, or the whole week. Cancelling a class never auto-refunds; it's a separate step.",
    render: render,
    selfTest: selfTest
  });
})();
