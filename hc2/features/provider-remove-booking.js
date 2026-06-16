/* HolidayCamp feature — provider-remove-booking
 *
 * Remove / cancel a customer booking  (provider side)
 *
 * Replicates the Happity "remove customer bookings" flow. Evidence:
 *   - support article 6211551 ("How do I remove customer bookings?"):
 *       "There will be times that you will need to remove or cancel a booking.
 *        This can be done quickly and easily from your registers."
 *       "Before removing a booking, it is important to ensure that you have
 *        REFUNDED this payment first."
 *       Flow: My Classes -> Registers -> find the register date -> eye icon ->
 *       "Select the eye symbol next to the customers booking and you will then
 *        see a button to cancel the class."
 *   - support article 3719394 ("How to cancel, hide or disable bookings…"):
 *       "To cancel a booking … Click the customer's name and then press the
 *        cancel button on their booking page."
 *       "You won't be able to remove a class date if there are customers
 *        currently booked into it … Please cancel any active bookings first.
 *        Once the bookings have been cancelled, you will then be able to delete
 *        the event date."
 *
 * Framed for SCHOOL-AGE HOLIDAY CAMPS (not baby classes). A camp runs across the
 * Summer-2026 Waltham Forest weeks. Each running DATE owns a register listing the
 * children booked onto it. From that register a provider can CANCEL one specific
 * customer's booking: the row leaves the active register, a space is freed, and
 * the cancellation is logged (with reason + whether the parent was refunded). A
 * date with zero remaining active bookings then becomes deletable — matching the
 * Happity rule that you must clear bookings before you can delete the date.
 *
 * ACCEPTANCE CRITERION (asserted in selfTest):
 *   Provider can cancel a SPECIFIC customer's booking from the register.
 *   We verify: a register lists its booked customers; cancelling one named
 *   booking removes exactly that booking (others untouched); the freed space is
 *   returned to availability; the cancellation is recorded with reason/refund
 *   flag/timestamp; the refund-first guard fires for a paid, unrefunded booking;
 *   cancelling the same booking twice is rejected; and an emptied register
 *   becomes deletable while a populated one does not.
 *
 * Self-contained, defensive, no imports/exports. Calls HC.registerFeature.
 */
(function () {
  "use strict";

  // Defensive: never throw at module load if HC isn't present.
  if (typeof window === "undefined" || !window.HC || typeof window.HC.registerFeature !== "function") {
    if (typeof console !== "undefined" && console.warn) {
      console.warn("[HC] provider-remove-booking: HC core not found; skipping registration.");
    }
    return;
  }

  var HC = window.HC;

  // Own store key — independent of the read-only registers feature so tests do
  // not interfere with each other.
  var STORE_KEY = "provider_remove_booking";
  var TODAY_ISO = "2026-06-15";

  /* ===================================================================
     SMALL HELPERS
     =================================================================== */

  function asText(v) { return typeof v === "string" ? v : (v == null ? "" : String(v)); }

  function isValidISODate(s) {
    var str = asText(s);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(str)) return false;
    var p = str.split("-");
    var y = Number(p[0]), m = Number(p[1]), d = Number(p[2]);
    if (m < 1 || m > 12 || d < 1 || d > 31) return false;
    var dt = new Date(Date.UTC(y, m - 1, d));
    return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
  }

  var DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  var MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  function dateLabel(iso) {
    try {
      if (!isValidISODate(iso)) return asText(iso);
      var p = iso.split("-");
      var dt = new Date(Date.UTC(Number(p[0]), Number(p[1]) - 1, Number(p[2])));
      return DOW[dt.getUTCDay()] + " " + Number(p[2]) + " " + MON[Number(p[1]) - 1] + " " + p[0];
    } catch (e) { return asText(iso); }
  }

  function safeUid(prefix) {
    try { return HC.util.uid(); }
    catch (e) { return (prefix || "id") + "_" + Date.now() + "_" + Math.floor(Math.random() * 1e6); }
  }

  function money(n) {
    try { return HC.util.money(n); }
    catch (e) {
      var num = Number(n);
      if (!isFinite(num)) return "£0";
      return "£" + (Number.isInteger(num) ? num : num.toFixed(2));
    }
  }

  /* ===================================================================
     PURE LOGIC (testable, DOM-free)

     A BOOKING is one customer's place on one date's register:
       { id, child, parent, parentPhone, amount, paid, refunded,
         status:'booked'|'cancelled', cancelReason, refundedOnCancel,
         cancelledAt }
     A REGISTER is { id, date, dateLabel, capacity, bookings:[...] }.
     =================================================================== */

  function makeBooking(input) {
    var a = (input && typeof input === "object") ? input : {};
    var amt = Number(a.amount);
    return {
      id: safeUid("bk"),
      child: asText(a.child).trim() || "Unnamed child",
      parent: asText(a.parent).trim() || "—",
      parentPhone: asText(a.parentPhone).trim(),
      amount: (isFinite(amt) && amt >= 0) ? amt : 0,     // what they paid (0 = free/HAF place)
      paid: a.paid === true,                              // a real online payment was taken
      refunded: a.refunded === true,                      // payment already refunded (article 6211551)
      status: "booked",                                   // 'booked' | 'cancelled'
      cancelReason: "",
      refundedOnCancel: null,                             // did the provider tick "refunded" at cancel time
      cancelledAt: null,
      createdAt: Date.now()
    };
  }

  function makeRegister(iso, capacity) {
    var cap = Number(capacity);
    return {
      id: safeUid("reg"),
      date: asText(iso),
      dateLabel: dateLabel(iso),
      capacity: (isFinite(cap) && cap > 0) ? Math.floor(cap) : 20,
      bookings: []
    };
  }

  // Active (still-booked) customers on a register.
  function activeBookings(reg) {
    if (!reg || !Array.isArray(reg.bookings)) return [];
    return reg.bookings.filter(function (b) { return b && b.status === "booked"; });
  }
  function cancelledBookings(reg) {
    if (!reg || !Array.isArray(reg.bookings)) return [];
    return reg.bookings.filter(function (b) { return b && b.status === "cancelled"; });
  }

  // Overview numbers a provider needs while deciding what to cancel.
  function registerStats(reg) {
    var active = activeBookings(reg).length;
    var cap = (reg && isFinite(Number(reg.capacity))) ? Number(reg.capacity) : 0;
    return {
      booked: active,
      cancelled: cancelledBookings(reg).length,
      capacity: cap,
      spacesLeft: Math.max(0, cap - active)
    };
  }

  // A register can only be DELETED once it holds no active bookings — the exact
  // Happity rule from article 3719394 ("cancel any active bookings first").
  function isDeletable(reg) {
    return activeBookings(reg).length === 0;
  }

  // Is a refund required before we cancel? Per article 6211551 you must refund a
  // paid booking first. A free/HAF place (amount 0, not paid) needs no refund;
  // an already-refunded paid booking is fine too.
  function refundRequired(booking) {
    if (!booking || typeof booking !== "object") return false;
    return booking.paid === true && booking.amount > 0 && booking.refunded !== true;
  }

  /* ===================================================================
     PERSISTENCE (HC.store only — never raw localStorage)
     Shape: { <providerId>: { dates: [ register, … ] } }
     =================================================================== */

  function readAll() {
    try {
      var s = HC.store.get(STORE_KEY, {});
      return (s && typeof s === "object" && !Array.isArray(s)) ? s : {};
    } catch (e) { return {}; }
  }
  function writeAll(map) {
    try { return HC.store.set(STORE_KEY, (map && typeof map === "object") ? map : {}); }
    catch (e) { return false; }
  }
  function providerBucket(map, providerId) {
    var pid = asText(providerId) || "_default";
    if (!map[pid] || typeof map[pid] !== "object") map[pid] = { dates: [] };
    if (!Array.isArray(map[pid].dates)) map[pid].dates = [];
    return map[pid];
  }
  function findReg(bucket, iso) {
    return bucket.dates.filter(function (r) { return r.date === asText(iso); })[0] || null;
  }

  function ensureRegister(providerId, iso, capacity) {
    var map = readAll();
    var bucket = providerBucket(map, providerId);
    var reg = findReg(bucket, iso);
    if (!reg) { reg = makeRegister(iso, capacity); bucket.dates.push(reg); writeAll(map); }
    return reg;
  }

  function addBooking(providerId, iso, input) {
    if (!isValidISODate(iso)) {
      return { ok: false, errors: ["A valid session date (YYYY-MM-DD) is required."] };
    }
    var bk = makeBooking(input);
    if (bk.child === "Unnamed child" && !asText(input && input.child).trim()) {
      return { ok: false, errors: ["A child name is required for the register."] };
    }
    var map = readAll();
    var bucket = providerBucket(map, providerId);
    var reg = findReg(bucket, iso);
    if (!reg) { reg = makeRegister(iso, (input && input.capacity)); bucket.dates.push(reg); }
    reg.bookings.push(bk);
    if (reg.bookings.length > 300) reg.bookings = reg.bookings.slice(-300);
    writeAll(map);
    return { ok: true, booking: bk };
  }

  // Return registers (deep-read) for a provider, ascending by date, each with
  // computed stats + deletable flag. Bookings are returned as-stored.
  function getRegisters(providerId) {
    var map = readAll();
    var dates = providerBucket(map, providerId).dates.slice();
    dates.sort(function (a, b) {
      return asText(a.date) < asText(b.date) ? -1 : asText(a.date) > asText(b.date) ? 1 : 0;
    });
    return dates.map(function (r) {
      var clone = {
        id: r.id, date: r.date, dateLabel: r.dateLabel || dateLabel(r.date),
        capacity: r.capacity,
        bookings: Array.isArray(r.bookings) ? r.bookings.map(function (b) {
          var c = {}; for (var k in b) { if (Object.prototype.hasOwnProperty.call(b, k)) c[k] = b[k]; } return c;
        }) : []
      };
      clone.stats = registerStats(clone);
      clone.deletable = isDeletable(clone);
      return clone;
    });
  }

  function openRegister(providerId, iso) {
    return getRegisters(providerId).filter(function (r) { return r.date === asText(iso); })[0] || null;
  }

  /* -------------------------------------------------------------------
     THE CORE OPERATION: cancel one specific customer's booking.

     opts = { reason?:String, refunded?:Boolean, force?:Boolean }
       - refunded: the provider confirms the payment has been refunded (this is
         the "ensure you have refunded first" step from article 6211551).
       - force: override the refund-first guard (kept for the rare case where a
         refund is handled out-of-band). Default false.
     Returns { ok, booking?, register?, errors? }.
     ------------------------------------------------------------------- */
  function cancelBooking(providerId, iso, bookingId, opts) {
    var o = (opts && typeof opts === "object") ? opts : {};
    if (!isValidISODate(iso)) {
      return { ok: false, errors: ["A valid session date is required."] };
    }
    if (!asText(bookingId)) {
      return { ok: false, errors: ["Select a customer's booking to cancel."] };
    }

    var map = readAll();
    var bucket = providerBucket(map, providerId);
    var reg = findReg(bucket, iso);
    if (!reg) return { ok: false, errors: ["No register found for that date."] };

    var booking = (reg.bookings || []).filter(function (b) { return b && b.id === bookingId; })[0];
    if (!booking) return { ok: false, errors: ["That booking is not on this register."] };
    if (booking.status === "cancelled") {
      return { ok: false, errors: ["That booking has already been cancelled."] };
    }

    // Refund-first guard (article 6211551). A paid, unrefunded booking must be
    // refunded before removal unless explicitly overridden or marked refunded.
    var didRefund = o.refunded === true || booking.refunded === true;
    if (refundRequired(booking) && !didRefund && o.force !== true) {
      return {
        ok: false,
        needsRefund: true,
        errors: ["Refund this customer's " + money(booking.amount) +
          " payment before removing the booking. (Tick 'I've refunded this' or issue the refund first.)"]
      };
    }

    booking.status = "cancelled";
    booking.cancelReason = asText(o.reason).trim();
    booking.refundedOnCancel = !!didRefund;
    if (didRefund) booking.refunded = true;
    booking.cancelledAt = Date.now();
    writeAll(map);

    return { ok: true, booking: booking, register: openRegister(providerId, iso) };
  }

  // Delete an event date — only permitted once no active bookings remain
  // (article 3719394). Returns { ok, errors? }.
  function deleteRegister(providerId, iso) {
    var map = readAll();
    var bucket = providerBucket(map, providerId);
    var reg = findReg(bucket, iso);
    if (!reg) return { ok: false, errors: ["No register found for that date."] };
    if (!isDeletable(reg)) {
      return {
        ok: false,
        errors: ["You can't delete this date while customers are still booked in. " +
          "Cancel the remaining bookings first."]
      };
    }
    var pid = asText(providerId) || "_default";
    map[pid].dates = bucket.dates.filter(function (r) { return r.date !== asText(iso); });
    writeAll(map);
    return { ok: true };
  }

  function clearProvider(providerId) {
    var map = readAll();
    var pid = asText(providerId) || "_default";
    delete map[pid];
    writeAll(map);
  }

  /* ===================================================================
     SEED DATA — realistic holiday-camp bookings on a real WF Summer-2026 week.
     =================================================================== */

  function plannerWeekDates() {
    var out = [];
    try {
      var weeks = (HC.data.planner && HC.data.planner.weeks) || [];
      weeks.forEach(function (w) { if (w && isValidISODate(w.mon)) out.push(w.mon); });
    } catch (e) {}
    if (!out.length) out = ["2026-07-20", "2026-07-27", "2026-08-03"];
    return out;
  }

  function seedCast() {
    return [
      { child: "Amelia Brooks", parent: "Hannah Brooks", parentPhone: "07700 900111", amount: 32, paid: true },
      { child: "Zane Okafor", parent: "Tunde Okafor", parentPhone: "07700 900222", amount: 32, paid: true },
      { child: "Felix Nguyen", parent: "Mai Nguyen", parentPhone: "07700 900333", amount: 0, paid: false }, // HAF place
      { child: "Sofia Rossi", parent: "Elena Rossi", parentPhone: "07700 900444", amount: 32, paid: true },
      { child: "Otis Clarke", parent: "Dan Clarke", parentPhone: "07700 900555", amount: 32, paid: true }
    ];
  }

  function seedRegisters(providerId) {
    clearProvider(providerId);
    var weeks = plannerWeekDates();
    var cast = seedCast();
    // Two upcoming dates so the demo has more than one register to choose from.
    var plan = [
      { date: weeks[0], take: cast.slice(0, 5), cap: 24 },
      { date: weeks[1] || "2026-07-27", take: cast.slice(0, 3), cap: 16 }
    ];
    plan.forEach(function (p) {
      if (!isValidISODate(p.date)) return;
      ensureRegister(providerId, p.date, p.cap);
      p.take.forEach(function (c) { addBooking(providerId, p.date, c); });
    });
    return getRegisters(providerId);
  }

  /* ===================================================================
     UI
     =================================================================== */

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
  function escAttr(s) { return esc(s).replace(/"/g, "&quot;"); }

  function el(tag, attrs, html) {
    try { return HC.util.el(tag, attrs, html); }
    catch (e) {
      var n = document.createElement(tag || "div");
      if (html != null) n.innerHTML = html;
      return n;
    }
  }
  function toast(msg) { try { HC.util.toast(msg); } catch (e) {} }

  function demoProviderId() {
    try {
      var ps = HC.data.providers || [];
      var pref = ps.filter(function (p) {
        return p && /holiday|playscheme|club|camp/i.test(asText(p.kind) + " " + asText(p.name));
      })[0];
      if (pref && pref.id) return pref.id;
      if (ps[0] && ps[0].id) return ps[0].id;
    } catch (e) {}
    return "_demo_provider";
  }

  function bookingRowHtml(b) {
    var paidTag = b.paid && b.amount > 0
      ? '<span style="font-size:11px;color:#2f7d4f;font-weight:700">' + esc(money(b.amount)) + " paid" +
        (b.refunded ? " · refunded" : "") + "</span>"
      : '<span style="font-size:11px;color:var(--muted,#808080)">Free / HAF place</span>';
    return '<tr data-bk="' + escAttr(b.id) + '" style="border-top:1px solid var(--line,#E6E6E6)">' +
      '<td style="padding:7px 8px;vertical-align:top"><strong>' + esc(b.child) + "</strong>" +
        '<div style="font-size:11px;color:var(--muted,#808080)">' + esc(b.parent) +
          (b.parentPhone ? " · " + esc(b.parentPhone) : "") + "</div></td>" +
      '<td style="padding:7px 8px;vertical-align:top">' + paidTag + "</td>" +
      '<td style="padding:7px 8px;vertical-align:top;text-align:right">' +
        '<button type="button" class="hc-btn hc-btn-ghost" data-cancel="' + escAttr(b.id) + '" ' +
          'style="padding:5px 11px;font-size:11px">Cancel booking</button></td>' +
      "</tr>";
  }

  function render(mountEl) {
    try {
      if (!mountEl) return;
      var providerId = demoProviderId();
      mountEl.innerHTML = "";

      mountEl.appendChild(el("div", null,
        '<p style="font-size:14px;color:var(--text,#383838);margin:0 0 4px">' +
          "Open a camp date's <strong>register</strong> and cancel a <strong>specific customer's booking</strong> " +
          "— for example a family who can no longer attend. The place is freed for the waiting list, and the " +
          "cancellation is logged.</p>" +
        '<p style="font-size:12.5px;color:var(--muted,#808080);margin:0 0 6px">' +
          "As on Happity, please <strong>refund a paid booking first</strong>; you can only delete a whole date once " +
          "every booking on it has been cancelled. (Mock data — no real bookings or payments.)</p>"));

      // (Re)seed so the preview is always populated + deterministic.
      seedRegisters(providerId);

      var listHost = el("div", { id: "hcRbList", style: "margin-top:8px" });
      var detailHost = el("div", { id: "hcRbDetail", style: "margin-top:12px" });
      mountEl.appendChild(listHost);
      mountEl.appendChild(detailHost);

      var openIso = null;

      function renderList() {
        var regs = getRegisters(providerId);
        if (!openIso && regs[0]) openIso = regs[0].date;
        listHost.innerHTML = regs.map(function (r) {
          var open = r.date === openIso;
          var s = r.stats;
          return '<button type="button" data-date="' + escAttr(r.date) + '" ' +
            'style="display:block;width:100%;text-align:left;cursor:pointer;border:1.5px solid ' +
              (open ? "var(--purple,#603488)" : "var(--line,#E6E6E6)") + ';border-radius:12px;background:' +
              (open ? "#F7F4FB" : "#fff") + ';padding:9px 12px;margin:0 0 8px">' +
            '<span style="font-family:Quicksand,system-ui,sans-serif;font-weight:700;color:var(--purple,#603488)">' +
              esc(r.dateLabel) + "</span>" +
            '<span style="float:right;font-size:12px;color:var(--muted,#808080)">' +
              s.booked + " booked · " + s.spacesLeft + " space" + (s.spacesLeft === 1 ? "" : "s") + " left" +
              (s.cancelled ? " · " + s.cancelled + " cancelled" : "") + "</span></button>";
        }).join("") || '<p style="color:var(--muted,#808080)">No registers.</p>';
      }

      function renderDetail() {
        var reg = openRegister(providerId, openIso);
        if (!reg) { detailHost.innerHTML = ""; return; }
        var s = reg.stats;
        var active = reg.bookings.filter(function (b) { return b.status === "booked"; });
        var cancelled = reg.bookings.filter(function (b) { return b.status === "cancelled"; });

        var table = active.length
          ? '<table style="width:100%;border-collapse:collapse;font-size:13px">' +
              '<thead><tr style="text-align:left;color:var(--muted,#808080);font-size:11px;text-transform:uppercase;letter-spacing:.4px">' +
                '<th style="padding:4px 8px">Customer</th><th style="padding:4px 8px">Payment</th>' +
                '<th style="padding:4px 8px;text-align:right">Action</th></tr></thead><tbody>' +
              active.map(bookingRowHtml).join("") + "</tbody></table>"
          : '<p style="color:var(--muted,#808080);font-size:13px">No active bookings — this date can now be deleted.</p>';

        var cancelledHtml = cancelled.length
          ? '<div style="margin-top:10px;border-top:1px dashed var(--line,#E6E6E6);padding-top:8px">' +
              '<div style="font-size:12px;color:var(--muted,#808080);font-weight:700;margin-bottom:4px">Cancelled</div>' +
              cancelled.map(function (b) {
                return '<div style="font-size:12px;color:var(--muted,#808080)">— <s>' + esc(b.child) + "</s> (" +
                  esc(b.parent) + ")" + (b.refundedOnCancel ? " · refunded" : "") +
                  (b.cancelReason ? " · " + esc(b.cancelReason) : "") + "</div>";
              }).join("") + "</div>"
          : "";

        detailHost.innerHTML =
          '<div style="border:1.5px solid var(--line,#E6E6E6);border-radius:14px;padding:14px 16px;background:#fff">' +
            '<div style="display:flex;justify-content:space-between;align-items:baseline;flex-wrap:wrap;gap:6px">' +
              '<div style="font-family:Quicksand,system-ui,sans-serif;font-weight:700;color:var(--purple,#603488);font-size:16px">' +
                esc(reg.dateLabel) + "</div>" +
              '<div style="font-size:12.5px;color:var(--muted,#808080)">' +
                s.booked + " / " + s.capacity + " booked · " + s.spacesLeft + " spaces available</div></div>" +
            '<div style="margin-top:10px">' + table + cancelledHtml + "</div>" +
            '<div style="margin-top:12px">' +
              '<button type="button" class="hc-btn" data-delete="' + escAttr(reg.date) + '" ' +
                (reg.deletable ? "" : 'disabled style="opacity:.5;cursor:not-allowed" ') +
                '>Delete this date</button>' +
              '<span style="font-size:11.5px;color:var(--muted,#808080);margin-left:10px">' +
                (reg.deletable ? "No bookings left — safe to delete." : "Cancel all bookings before deleting.") +
              "</span></div>" +
          "</div>";
      }

      function refresh() { renderList(); renderDetail(); }
      refresh();

      // Cancel flow: confirm refund for paid bookings, capture an optional reason.
      function doCancel(bookingId) {
        var reg = openRegister(providerId, openIso);
        if (!reg) return;
        var bk = reg.bookings.filter(function (b) { return b.id === bookingId; })[0];
        if (!bk) return;

        var needRefund = refundRequired(bk);
        var reason = "";
        var refunded = false;
        try {
          reason = window.prompt(
            "Cancel " + bk.child + "'s booking (" + bk.parent + ")?\n" +
            (needRefund ? "This is a " + money(bk.amount) + " PAID booking — refund it first.\n" : "") +
            "Optional reason for the register log:", "") || "";
          // If a reason box was dismissed, treat as abort.
          if (reason === null) return;
          if (needRefund) {
            refunded = window.confirm(
              "Confirm you've REFUNDED " + bk.parent + "'s " + money(bk.amount) +
              " payment.\nOK = refunded, Cancel = not yet (booking will not be cancelled).");
            if (!refunded) { toast("Refund the payment first, then cancel."); return; }
          }
        } catch (e) {
          // No prompt/confirm available (non-interactive): fall back to refunding.
          refunded = true;
        }

        var res = cancelBooking(providerId, openIso, bookingId, { reason: reason, refunded: refunded });
        if (res.ok) {
          toast("Cancelled " + bk.child + "'s booking — space freed.");
          refresh();
        } else {
          toast((res.errors && res.errors[0]) || "Could not cancel that booking.");
        }
      }

      function doDelete(iso) {
        var res = deleteRegister(providerId, iso);
        if (res.ok) {
          toast("Date deleted.");
          if (openIso === iso) openIso = null;
          refresh();
        } else {
          toast((res.errors && res.errors[0]) || "Could not delete that date.");
        }
      }

      mountEl.addEventListener("click", function (e) {
        var t = e.target;
        if (!t || !t.closest) return;
        var dateBtn = t.closest("[data-date]");
        if (dateBtn) { openIso = dateBtn.getAttribute("data-date"); refresh(); return; }
        var cancelBtn = t.closest("[data-cancel]");
        if (cancelBtn) { doCancel(cancelBtn.getAttribute("data-cancel")); return; }
        var delBtn = t.closest("[data-delete]");
        if (delBtn && !delBtn.disabled) { doDelete(delBtn.getAttribute("data-delete")); return; }
      });
    } catch (e) {
      try {
        mountEl.innerHTML = '<p style="color:#9a1f5e">Remove-booking feature failed to render: ' +
          esc(e && e.message ? e.message : String(e)) + "</p>";
      } catch (e2) {}
    }
  }

  /* ===================================================================
     selfTest — exercises the LOGIC and asserts the acceptance criterion.
     =================================================================== */

  function selfTest() {
    var pass = 0, fail = 0, log = [];
    function check(label, fn) {
      try { fn(); pass += 1; log.push("✓ " + label); }
      catch (e) { fail += 1; log.push("✗ " + label + " — " + (e && e.message ? e.message : String(e))); }
    }

    var TP = "__selftest_remove_booking__";
    clearProvider(TP);

    // ---- seed builds registers that list booked customers ----
    var regs;
    check("Seed builds registers that list booked customers", function () {
      regs = seedRegisters(TP);
      HC.assert(regs.length >= 1, "expected at least one register, got " + regs.length);
      HC.assert(regs[0].bookings.length >= 3, "first register should list several bookings");
      HC.assert(regs[0].stats.booked === regs[0].bookings.filter(function (b) { return b.status === "booked"; }).length,
        "stats.booked must equal the active booking count");
    });

    var iso, before, target, otherIds;
    check("A register exposes a SPECIFIC customer's booking to cancel", function () {
      iso = regs[0].date;
      var reg = openRegister(TP, iso);
      before = reg.stats.booked;
      target = reg.bookings.filter(function (b) { return b.child === "Sofia Rossi"; })[0];
      HC.assert(target, "Sofia Rossi should be a booked customer on the register");
      HC.assert(target.status === "booked", "target starts as an active booking");
      otherIds = reg.bookings.filter(function (b) { return b.id !== target.id; }).map(function (b) { return b.id; });
      HC.assert(otherIds.length >= 2, "there should be other bookings to leave untouched");
    });

    // ===== ACCEPTANCE CRITERION =====
    // Provider can cancel a SPECIFIC customer's booking from the register.
    check("ACCEPTANCE: cancelling one named booking removes exactly that booking", function () {
      // Sofia's £32 is a paid booking; confirm the refund at cancel time.
      var res = cancelBooking(TP, iso, target.id, { reason: "Family away that week", refunded: true });
      HC.assert(res.ok === true, "cancel should succeed: " + ((res.errors || []).join(" ")));
      HC.assert(res.booking && res.booking.id === target.id, "the returned booking must be the one we targeted");
      HC.assert(res.booking.status === "cancelled", "the targeted booking must now be cancelled");

      var reg = openRegister(TP, iso);
      var sofia = reg.bookings.filter(function (b) { return b.id === target.id; })[0];
      HC.assert(sofia && sofia.status === "cancelled", "Sofia must be cancelled on the stored register");
      // Every OTHER booking must still be active and untouched.
      otherIds.forEach(function (id) {
        var b = reg.bookings.filter(function (x) { return x.id === id; })[0];
        HC.assert(b && b.status === "booked", "another customer's booking must remain booked (id " + id + ")");
      });
      // Active count dropped by exactly one.
      HC.assert(reg.stats.booked === before - 1,
        "active bookings should drop by exactly one (" + reg.stats.booked + " vs " + (before - 1) + ")");
    });

    check("ACCEPTANCE: the cancelled customer's place is freed (spaces +1)", function () {
      var reg = openRegister(TP, iso);
      var expectedFree = reg.capacity - (before - 1);
      HC.assert(reg.stats.spacesLeft === expectedFree,
        "a freed place must return to availability (" + reg.stats.spacesLeft + " vs " + expectedFree + ")");
    });

    check("ACCEPTANCE: the cancellation is recorded with reason, refund flag and timestamp", function () {
      var reg = openRegister(TP, iso);
      var sofia = reg.bookings.filter(function (b) { return b.child === "Sofia Rossi"; })[0];
      HC.assert(sofia.cancelReason === "Family away that week", "the reason must be logged: " + sofia.cancelReason);
      HC.assert(sofia.refundedOnCancel === true, "the refund-at-cancel flag must be recorded");
      HC.assert(sofia.refunded === true, "the booking must be marked refunded");
      HC.assert(typeof sofia.cancelledAt === "number" && sofia.cancelledAt > 0, "a cancel timestamp must be set");
    });

    // ---- refund-first guard (article 6211551) ----
    check("Refund-first guard blocks cancelling a PAID, unrefunded booking", function () {
      var reg = openRegister(TP, iso);
      var amelia = reg.bookings.filter(function (b) { return b.child === "Amelia Brooks"; })[0];
      HC.assert(amelia && amelia.paid && !amelia.refunded, "Amelia is a paid, unrefunded booking");
      var res = cancelBooking(TP, iso, amelia.id, { reason: "no refund yet" });
      HC.assert(res.ok === false, "cancelling before refunding must be blocked");
      HC.assert(res.needsRefund === true, "the block must flag that a refund is needed");
      // It must NOT have cancelled the booking.
      var still = openRegister(TP, iso).bookings.filter(function (b) { return b.id === amelia.id; })[0];
      HC.assert(still.status === "booked", "a blocked cancel must leave the booking active");
    });

    check("Once refunded, the same paid booking cancels cleanly", function () {
      var reg = openRegister(TP, iso);
      var amelia = reg.bookings.filter(function (b) { return b.child === "Amelia Brooks"; })[0];
      var res = cancelBooking(TP, iso, amelia.id, { reason: "refunded by bank transfer", refunded: true });
      HC.assert(res.ok === true, "after refunding, cancel should succeed");
      HC.assert(openRegister(TP, iso).bookings.filter(function (b) { return b.id === amelia.id; })[0].status === "cancelled",
        "Amelia must now be cancelled");
    });

    check("A free / HAF place needs no refund and cancels directly", function () {
      var reg = openRegister(TP, iso);
      var felix = reg.bookings.filter(function (b) { return b.child === "Felix Nguyen"; })[0];
      HC.assert(felix && felix.amount === 0 && !felix.paid, "Felix is a free/HAF place");
      HC.assert(refundRequired(felix) === false, "a free place should not require a refund");
      var res = cancelBooking(TP, iso, felix.id, {});
      HC.assert(res.ok === true, "a free place should cancel without a refund step");
    });

    // ---- double-cancel + bad targets are rejected ----
    check("Cancelling the same booking twice is rejected", function () {
      var reg = openRegister(TP, iso);
      var sofia = reg.bookings.filter(function (b) { return b.child === "Sofia Rossi"; })[0];
      var res = cancelBooking(TP, iso, sofia.id, { refunded: true });
      HC.assert(res.ok === false, "a second cancel must be rejected");
      HC.assert(/already/i.test((res.errors || []).join(" ")), "the error should say it was already cancelled");
    });

    check("Cancelling an unknown booking id is rejected, register unchanged", function () {
      var beforeCount = openRegister(TP, iso).bookings.length;
      var res = cancelBooking(TP, iso, "does-not-exist", { refunded: true });
      HC.assert(res.ok === false, "an unknown booking id must be rejected");
      HC.assert(openRegister(TP, iso).bookings.length === beforeCount, "register length must be unchanged");
    });

    check("Cancelling on a non-existent / invalid date is rejected", function () {
      var r1 = cancelBooking(TP, "2026-13-40", "anything", { refunded: true });
      HC.assert(r1.ok === false, "an impossible date must be rejected");
      var r2 = cancelBooking(TP, "2026-09-09", "anything", { refunded: true });
      HC.assert(r2.ok === false, "a date with no register must be rejected");
    });

    // ---- delete-date gating (article 3719394) ----
    check("A date with active bookings cannot be deleted", function () {
      var reg = openRegister(TP, iso);
      HC.assert(reg.stats.booked > 0, "this register should still have active bookings");
      HC.assert(reg.deletable === false, "a populated register must not be deletable");
      var res = deleteRegister(TP, iso);
      HC.assert(res.ok === false, "deleting a populated date must be blocked");
      HC.assert(/cancel/i.test((res.errors || []).join(" ")), "the error should point at cancelling first");
    });

    check("Once every booking is cancelled, the date becomes deletable", function () {
      var reg = openRegister(TP, iso);
      // Cancel whatever active bookings remain (refunding paid ones).
      reg.bookings.filter(function (b) { return b.status === "booked"; }).forEach(function (b) {
        var res = cancelBooking(TP, iso, b.id, { refunded: true });
        HC.assert(res.ok === true, "remaining booking " + b.child + " should cancel: " + ((res.errors || []).join(" ")));
      });
      var emptied = openRegister(TP, iso);
      HC.assert(emptied.stats.booked === 0, "no active bookings should remain");
      HC.assert(emptied.deletable === true, "an emptied register must be deletable");
      var del = deleteRegister(TP, iso);
      HC.assert(del.ok === true, "deleting an emptied date should succeed");
      HC.assert(openRegister(TP, iso) === null, "the date should be gone after deletion");
    });

    // ---- persistence via HC.store ----
    check("Cancellations persist via HC.store across a reload", function () {
      // The second seeded date still exists and is independent.
      var all = getRegisters(TP);
      HC.assert(all.length >= 1, "the second date should survive (we only deleted the first)");
      var other = all[0];
      var b = other.bookings[0];
      var res = cancelBooking(TP, other.date, b.id, { refunded: true });
      HC.assert(res.ok === true, "cancel on the second date should work");
      var reloaded = openRegister(TP, other.date);
      var same = reloaded.bookings.filter(function (x) { return x.id === b.id; })[0];
      HC.assert(same && same.status === "cancelled", "the cancellation must be readable after a fresh store read");
    });

    // ---- defensive: garbage input never throws ----
    check("Garbage cancel input is rejected and never throws", function () {
      var bad = [
        [null, null, null], [TP, null, "x"], [TP, "2026-07-20", null], [TP, "2026-07-20", 123], [TP, 42, {}]
      ];
      for (var i = 0; i < bad.length; i++) {
        var res = cancelBooking(bad[i][0], bad[i][1], bad[i][2], bad[i][3]);
        HC.assert(res && res.ok === false, "garbage cancel #" + i + " must return ok:false (not throw)");
      }
    });

    // cleanup
    clearProvider(TP);

    return { pass: pass, fail: fail, log: log };
  }

  /* ===================================================================
     register
     =================================================================== */

  HC.registerFeature({
    id: "provider-remove-booking",
    title: "Remove / cancel a customer booking",
    side: "provider",
    icon: "🗑️",
    summary: "Open a camp date's register and cancel a specific customer's booking. Refund a paid place first, the freed space returns to availability, and a date can only be deleted once every booking on it is cancelled.",
    render: render,
    selfTest: selfTest
  });
})();
