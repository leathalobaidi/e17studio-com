/* HolidayCamp feature — provider-transfer-customer
 *
 * Transfer a customer to a different class  (provider side)
 *
 * Replicates the Happity "Transferring your customer to a different class" flow.
 * Evidence:
 *   - support article 3812911 ("Transferring your customer to a different
 *     class"): "How to move your customer to a different class from an existing
 *     register." Two halves —
 *       (a) REMOVE the booking from the source register: open the customer's
 *           booking, click 'cancel'; "Their name will appear crossed through in
 *           your register and their space will be released for resale." (NOTE:
 *           "This will not issue a refund.")
 *       (b) ADD into the new class: "Find the register for the class you'd like
 *           to transfer into … Click 'Add manual booking' … add the customer's
 *           details to this register."
 *   - support article 6056178 ("How to reschedule or cancel an individual class
 *     with bookings"): to move bookings off a date you "select the tick boxes
 *     next to the customer's name and then select 'Reschedule'", i.e. a booking
 *     is lifted off one date's register and re-seated on another.
 *
 * Net effect (the acceptance criterion): a single TRANSFER is the atomic pair
 * "release the space on the source register" + "seat the booking on the
 * destination register", so BOTH registers update in one action.
 *
 * Framed for SCHOOL-AGE HOLIDAY CAMPS (not baby classes). A camp runs across the
 * Summer-2026 Waltham Forest weeks; each running DATE owns its own register.
 * Parents often need to switch their child from (say) the week-1 multi-sports
 * camp to the week-3 one. The provider transfers the child: the source date
 * frees a space for resale, the destination date gains the child — carrying the
 * child's age and any SEN / allergy / medical notes across so the new leader has
 * what they need on the day. No refund is issued (a transfer is not a refund).
 *
 * ACCEPTANCE CRITERION (asserted in selfTest):
 *   A booked customer can be moved to another class/date, updating BOTH
 *   registers. We verify: after a transfer the source register no longer counts
 *   the child as attending (the seat is released for resale) while the
 *   destination register now lists the child (with age + SEN/allergy notes
 *   carried across); the global booking count is conserved (a transfer moves,
 *   it does not duplicate or destroy); a transfer audit-trail row is recorded on
 *   each side; and impossible transfers (full destination, same date, unknown
 *   booking, no refund side-effect) are handled defensively.
 *
 * Self-contained, defensive, no imports/exports. Calls HC.registerFeature.
 */
(function () {
  "use strict";

  // Defensive: never throw at module load if HC isn't present.
  if (typeof window === "undefined" || !window.HC || typeof window.HC.registerFeature !== "function") {
    if (typeof console !== "undefined" && console.warn) {
      console.warn("[HC] provider-transfer-customer: HC core not found; skipping registration.");
    }
    return;
  }

  var HC = window.HC;

  // Own store key — this module keeps its own register model so its selfTest is
  // fully self-contained and never depends on provider-registers having run.
  // Shape: { <providerId>: { dates: [ {id,date,dateLabel,capacity,attendees:[...],transfers:[...]} ] } }
  var STORE_KEY = "provider_transfer_registers";

  var TODAY_ISO = "2026-06-15"; // anchor for past/upcoming, pinned to the live app date

  /* ===================================================================
     PURE LOGIC (testable, DOM-free)
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

  function classifyDate(iso, todayIso) {
    var t = isValidISODate(todayIso) ? todayIso : TODAY_ISO;
    if (!isValidISODate(iso)) return "unknown";
    return asText(iso) < t ? "past" : "upcoming";
  }

  function safeUid(prefix) {
    try { return HC.util.uid(); }
    catch (e) { return (prefix || "id") + "_" + Date.now() + "_" + Math.floor(Math.random() * 1e6); }
  }

  function normaliseNotes(input) {
    var a = (input && typeof input === "object") ? input : {};
    return {
      sen: asText(a.sen).trim(),
      allergy: asText(a.allergy).trim(),
      medical: asText(a.medical).trim(),
      other: asText(a.other).trim()
    };
  }

  function hasFlaggedNotes(att) {
    if (!att || typeof att !== "object") return false;
    var n = att.notes || {};
    return !!(asText(n.sen).trim() || asText(n.allergy).trim() || asText(n.medical).trim());
  }

  // One ATTENDEE (a booking). Carries child + age + booked-by + SEN/allergy
  // notes, plus a "status" so a cancelled booking can be shown CROSSED THROUGH
  // (article 3812911 step v) without losing the audit trail.
  function makeAttendee(input) {
    var a = (input && typeof input === "object") ? input : {};
    var ageNum = Number(a.age);
    var age = (isFinite(ageNum) && ageNum >= 0 && ageNum <= 25) ? Math.floor(ageNum) : null;
    return {
      id: asText(a.id).trim() || safeUid("att"),
      child: asText(a.child).trim() || "Unnamed child",
      age: age,
      parent: asText(a.parent).trim() || "—",
      parentEmail: asText(a.parentEmail).trim(),
      parentPhone: asText(a.parentPhone).trim(),
      notes: normaliseNotes(a),
      status: (a.status === "transferred-out") ? "transferred-out" : "booked",
      manual: a.manual === true,
      transferredFrom: asText(a.transferredFrom).trim() || null, // source date, if seated by a transfer
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
      attendees: [],
      transfers: [] // audit rows: {bookingId, child, direction:'in'|'out', otherDate, at}
    };
  }

  /* ===================================================================
     PERSISTENCE (HC.store only — never raw localStorage)
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
  function clearProvider(providerId) {
    var map = readAll();
    delete map[asText(providerId) || "_default"];
    writeAll(map);
  }

  function findRegRaw(bucket, iso) {
    return bucket.dates.filter(function (r) { return r.date === asText(iso); })[0] || null;
  }

  function ensureRegister(providerId, iso, capacity) {
    var map = readAll();
    var bucket = providerBucket(map, providerId);
    var reg = findRegRaw(bucket, iso);
    if (!reg) { reg = makeRegister(iso, capacity); bucket.dates.push(reg); writeAll(map); }
    return reg;
  }

  // Add a booking to a date's register. Returns { ok, attendee?, errors? }.
  function addAttendee(providerId, iso, input) {
    if (!isValidISODate(iso)) return { ok: false, errors: ["A valid session date (YYYY-MM-DD) is required."] };
    if (!asText(input && input.child).trim()) return { ok: false, errors: ["A child name is required for the register."] };
    var map = readAll();
    var bucket = providerBucket(map, providerId);
    var reg = findRegRaw(bucket, iso);
    if (!reg) { reg = makeRegister(iso, (input && input.capacity)); bucket.dates.push(reg); }
    var att = makeAttendee(input);
    reg.attendees.push(att);
    if (reg.attendees.length > 200) reg.attendees = reg.attendees.slice(-200);
    writeAll(map);
    return { ok: true, attendee: att };
  }

  /* ===================================================================
     REGISTER READ MODEL — "active" attendees are those still booked
     (a transferred-out booking is crossed through, not counted).
     =================================================================== */

  function activeAttendees(reg) {
    var atts = (reg && Array.isArray(reg.attendees)) ? reg.attendees : [];
    return atts.filter(function (a) { return a && a.status !== "transferred-out"; });
  }

  function registerStats(reg) {
    var active = activeAttendees(reg);
    var cap = (reg && isFinite(Number(reg.capacity))) ? Number(reg.capacity) : 0;
    return {
      booked: active.length,
      capacity: cap,
      spacesLeft: Math.max(0, cap - active.length),
      isFull: active.length >= cap,
      flagged: active.filter(hasFlaggedNotes).length,
      released: ((reg && reg.attendees) || []).filter(function (a) { return a.status === "transferred-out"; }).length
    };
  }

  // A view-friendly register snapshot for a single date.
  function viewRegister(reg, todayIso) {
    if (!reg) return null;
    return {
      id: reg.id,
      date: reg.date,
      dateLabel: reg.dateLabel || dateLabel(reg.date),
      capacity: reg.capacity,
      status: classifyDate(reg.date, todayIso),
      attendees: (Array.isArray(reg.attendees) ? reg.attendees.slice() : []),
      active: activeAttendees(reg),
      transfers: (Array.isArray(reg.transfers) ? reg.transfers.slice() : []),
      stats: registerStats(reg)
    };
  }

  function getRegisters(providerId, todayIso) {
    var map = readAll();
    var dates = providerBucket(map, providerId).dates.slice();
    dates.sort(function (a, b) {
      return asText(a.date) < asText(b.date) ? -1 : asText(a.date) > asText(b.date) ? 1 : 0;
    });
    return dates.map(function (r) { return viewRegister(r, todayIso); });
  }

  function openRegister(providerId, iso, todayIso) {
    var map = readAll();
    var reg = findRegRaw(providerBucket(map, providerId), iso);
    return viewRegister(reg, todayIso);
  }

  // Find a booking (by id) anywhere in a provider's registers; returns
  // { reg, attendee } against the RAW (mutable) store objects, or null.
  function locateBookingRaw(bucket, bookingId) {
    var id = asText(bookingId);
    for (var i = 0; i < bucket.dates.length; i++) {
      var reg = bucket.dates[i];
      var atts = Array.isArray(reg.attendees) ? reg.attendees : [];
      for (var j = 0; j < atts.length; j++) {
        if (atts[j] && atts[j].id === id) return { reg: reg, attendee: atts[j] };
      }
    }
    return null;
  }

  /* ===================================================================
     THE TRANSFER (the feature itself)

     transferBooking(providerId, bookingId, toIso[, opts]) performs the atomic
     pair that BOTH evidence articles describe:
       (1) release the seat on the SOURCE register  — the booking is marked
           'transferred-out' (crossed through), so its space frees for resale and
           it stops counting toward "booked". No refund is issued (3812911 NOTE).
       (2) seat the booking on the DESTINATION register — a fresh active booking
           is created carrying the child's age + SEN/allergy/medical notes.
     Both sides record an audit row, so each register shows the transfer.

     Returns { ok, fromDate?, toDate?, newBooking?, errors? }.
     =================================================================== */
  function transferBooking(providerId, bookingId, toIso, opts) {
    opts = (opts && typeof opts === "object") ? opts : {};
    var errors = [];

    if (!asText(bookingId).trim()) errors.push("A booking to transfer is required.");
    if (!isValidISODate(toIso)) errors.push("A valid destination date (YYYY-MM-DD) is required.");
    if (errors.length) return { ok: false, errors: errors };

    var map = readAll();
    var bucket = providerBucket(map, providerId);

    var found = locateBookingRaw(bucket, bookingId);
    if (!found) return { ok: false, errors: ["That booking could not be found in any register."] };

    var srcReg = found.reg;
    var booking = found.attendee;

    if (booking.status === "transferred-out") {
      return { ok: false, errors: ["That booking has already been transferred out and cannot be moved again."] };
    }
    if (srcReg.date === asText(toIso)) {
      return { ok: false, errors: ["The customer is already booked onto that date — nothing to transfer."] };
    }

    var destReg = findRegRaw(bucket, toIso);
    if (!destReg) {
      // Only allow auto-creating the destination register if explicitly asked.
      if (opts.createDestination === true) {
        destReg = makeRegister(toIso, opts.destinationCapacity);
        bucket.dates.push(destReg);
      } else {
        return { ok: false, errors: ["No register exists for the destination date. Create the class date first."] };
      }
    }

    // Capacity guard on the destination (cannot transfer into a full class).
    var destStats = registerStats(destReg);
    if (destStats.isFull) {
      return { ok: false, errors: ["The destination class is full (" + destStats.booked + "/" + destStats.capacity + "). Free a space or pick another date."] };
    }

    var now = Date.now();

    // (1) RELEASE on the source register — cross through, free the seat.
    booking.status = "transferred-out";
    booking.transferredTo = destReg.date;
    booking.transferredAt = now;

    // (2) SEAT on the destination register — carry the child + age + notes over.
    var seated = makeAttendee({
      child: booking.child,
      age: booking.age,
      parent: booking.parent,
      parentEmail: booking.parentEmail,
      parentPhone: booking.parentPhone,
      sen: booking.notes && booking.notes.sen,
      allergy: booking.notes && booking.notes.allergy,
      medical: booking.notes && booking.notes.medical,
      other: booking.notes && booking.notes.other,
      manual: true, // mirrors Happity's "Add manual booking" into the new class
      transferredFrom: srcReg.date
    });
    destReg.attendees.push(seated);

    // Audit rows on BOTH registers, so each side visibly shows the transfer.
    if (!Array.isArray(srcReg.transfers)) srcReg.transfers = [];
    if (!Array.isArray(destReg.transfers)) destReg.transfers = [];
    srcReg.transfers.push({
      bookingId: booking.id, newBookingId: seated.id, child: booking.child,
      direction: "out", otherDate: destReg.date, otherDateLabel: destReg.dateLabel, at: now
    });
    destReg.transfers.push({
      bookingId: seated.id, fromBookingId: booking.id, child: seated.child,
      direction: "in", otherDate: srcReg.date, otherDateLabel: srcReg.dateLabel, at: now
    });

    writeAll(map);

    return {
      ok: true,
      fromDate: srcReg.date,
      toDate: destReg.date,
      newBooking: seated,
      releasedBookingId: booking.id,
      refundIssued: false // a transfer never issues a refund (article 3812911 NOTE)
    };
  }

  /* ===================================================================
     SEED DATA — realistic holiday-camp registers across WF Summer-2026 weeks.
     =================================================================== */

  function plannerWeekDates() {
    var out = [];
    try {
      var weeks = (HC.data.planner && HC.data.planner.weeks) || [];
      weeks.forEach(function (w) { if (w && isValidISODate(w.mon)) out.push(w.mon); });
    } catch (e) {}
    if (out.length < 3) out = ["2026-07-20", "2026-07-27", "2026-08-03"];
    return out;
  }

  function shiftIso(iso, days) {
    try {
      if (!isValidISODate(iso)) return iso;
      var p = iso.split("-");
      var dt = new Date(Date.UTC(Number(p[0]), Number(p[1]) - 1, Number(p[2])));
      dt.setUTCDate(dt.getUTCDate() + (Number(days) || 0));
      var y = dt.getUTCFullYear(), m = String(dt.getUTCMonth() + 1), d = String(dt.getUTCDate());
      if (m.length < 2) m = "0" + m;
      if (d.length < 2) d = "0" + d;
      return y + "-" + m + "-" + d;
    } catch (e) { return iso; }
  }

  function seedCast() {
    return [
      { child: "Amelia Brooks", age: 8, parent: "Hannah Brooks", parentEmail: "hannah.brooks@example.com", parentPhone: "07700 900111",
        allergy: "Severe nut allergy — carries an EpiPen in her bag", other: "Vegetarian packed lunch" },
      { child: "Zane Okafor", age: 10, parent: "Tunde Okafor", parentEmail: "tunde.okafor@example.com", parentPhone: "07700 900222",
        sen: "EHCP — autism; needs warning before transitions and a quiet space" },
      { child: "Felix Nguyen", age: 6, parent: "Mai Nguyen", parentEmail: "mai.nguyen@example.com", parentPhone: "07700 900333",
        allergy: "Dairy intolerance", sen: "Speech and language support — give extra time to respond" },
      { child: "Sofia Rossi", age: 9, parent: "Elena Rossi", parentEmail: "elena.rossi@example.com", parentPhone: "07700 900444",
        other: "Confident swimmer; happy in any group" },
      { child: "Otis Clarke", age: 5, parent: "Dan Clarke", parentEmail: "dan.clarke@example.com", parentPhone: "07700 900555",
        medical: "Eczema — apply cream after water play (in named tube)" }
    ];
  }

  // Build a demo provider with 3 upcoming week registers. Week 1 is busy (so we
  // can transfer a child off it), Week 2 has room, Week 3 is deliberately near-
  // full so the "destination full" guard is demonstrable.
  function seedRegisters(providerId, todayIso) {
    clearProvider(providerId);
    var cast = seedCast();
    var weeks = plannerWeekDates();
    var w1 = weeks[0], w2 = weeks[1] || shiftIso(w1, 7), w3 = weeks[2] || shiftIso(w1, 14);

    ensureRegister(providerId, w1, 12);
    cast.forEach(function (c) { addAttendee(providerId, w1, c); }); // 5 booked on week 1

    ensureRegister(providerId, w2, 12); // plenty of room on week 2

    ensureRegister(providerId, w3, 2);  // tiny class, fill it so it's full
    addAttendee(providerId, w3, { child: "Iris Hall", age: 7, parent: "Kate Hall", parentEmail: "kate.hall@example.com" });
    addAttendee(providerId, w3, { child: "Leo Hall", age: 9, parent: "Kate Hall", parentEmail: "kate.hall@example.com" });

    return { w1: w1, w2: w2, w3: w3 };
  }

  /* ===================================================================
     UI
     =================================================================== */

  function esc(s) {
    return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
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
  function ageText(age) { return (age == null) ? "age —" : ("age " + age); }
  function toast(msg) { try { HC.util.toast(msg); } catch (e) {} }

  function demoProviderId() {
    try {
      var ps = HC.data.providers || [];
      var pref = ps.filter(function (p) {
        return p && /holiday|playscheme|club|camp/i.test(asText(p.kind) + " " + asText(p.name));
      })[0];
      if (pref && pref.id) return "transfer__" + pref.id;
      if (ps[0] && ps[0].id) return "transfer__" + ps[0].id;
    } catch (e) {}
    return "transfer___demo_provider";
  }

  function noteChipsHtml(att) {
    var n = att.notes || {};
    var chips = [];
    function chip(label, text, fg, bg) {
      return '<span title="' + escAttr(text) + '" style="display:inline-block;font-size:11px;font-weight:700;' +
        'padding:2px 8px;border-radius:999px;background:' + bg + ';color:' + fg + ';margin:1px 2px 1px 0">' +
        esc(label) + "</span>";
    }
    if (asText(n.sen).trim()) chips.push(chip("SEN", n.sen, "#5b3a8c", "#F0E8F4"));
    if (asText(n.allergy).trim()) chips.push(chip("Allergy", n.allergy, "#9a1f5e", "#FCE8F0"));
    if (asText(n.medical).trim()) chips.push(chip("Medical", n.medical, "#9a5a1f", "#FFF3E2"));
    if (!chips.length) return '<span style="color:var(--muted,#808080);font-size:11px">no notes</span>';
    return chips.join("");
  }

  function render(mountEl) {
    try {
      if (!mountEl) return;
      var providerId = demoProviderId();
      var today = TODAY_ISO;
      mountEl.innerHTML = "";

      var seeded = seedRegisters(providerId, today);

      var intro = el("div", null,
        '<p style="font-size:14px;color:var(--text,#383838);margin:0 0 4px">' +
          "Move a booked child from one camp date to another. The child is " +
          "<strong>released</strong> on the source date (their seat frees for resale and shows " +
          "crossed through) and <strong>seated</strong> on the destination date — carrying their " +
          "age and any SEN / allergy / medical notes across. <strong>No refund is issued</strong> " +
          "(a transfer is not a refund).</p>" +
        '<p style="font-size:12.5px;color:var(--muted,#808080);margin:0 0 10px">' +
          "Dates are real Summer-2026 Waltham Forest camp weeks. (Mock data — no real bookings.)</p>");
      mountEl.appendChild(intro);

      var controls = el("div", { style: "display:flex;flex-wrap:wrap;gap:8px;align-items:flex-end;margin:0 0 12px" });
      controls.innerHTML =
        '<label style="font-size:12px;color:var(--muted,#808080)">Child to transfer<br>' +
          '<select id="hcTxChild" style="margin-top:3px;padding:8px;border-radius:10px;border:1.5px solid var(--line,#E6E6E6);min-width:200px"></select></label>' +
        '<label style="font-size:12px;color:var(--muted,#808080)">Move to date<br>' +
          '<select id="hcTxDest" style="margin-top:3px;padding:8px;border-radius:10px;border:1.5px solid var(--line,#E6E6E6);min-width:200px"></select></label>' +
        '<button id="hcTxGo" class="hc-btn" type="button">Transfer →</button>' +
        '<button id="hcTxReset" class="hc-btn hc-btn-ghost" type="button">Reset demo</button>';
      mountEl.appendChild(controls);

      var msg = el("div", { id: "hcTxMsg", style: "min-height:18px;font-size:12.5px;margin:0 0 6px" });
      mountEl.appendChild(msg);

      var board = el("div", { id: "hcTxBoard", style: "display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:12px" });
      mountEl.appendChild(board);

      function regCardHtml(reg) {
        var s = reg.stats;
        var rows = reg.attendees.map(function (att) {
          var out = att.status === "transferred-out";
          var nameStyle = out
            ? "text-decoration:line-through;color:var(--muted,#808080)"
            : "color:var(--text,#383838)";
          var tag = out
            ? ' <span style="font-size:10px;color:#9a1f5e;font-weight:700">released →</span>'
            : (att.transferredFrom ? ' <span style="font-size:10px;color:#2f7d4f;font-weight:700">← transferred in</span>' : "");
          return '<div style="padding:6px 0;border-top:1px solid var(--line,#E6E6E6)">' +
            '<div style="font-weight:700;font-size:13px;' + nameStyle + '">' + esc(att.child) +
              ' <span style="font-weight:400;font-size:11px;color:var(--muted,#808080)">' + esc(ageText(att.age)) + "</span>" + tag + "</div>" +
            (out ? "" : '<div style="margin-top:2px">' + noteChipsHtml(att) + "</div>") +
          "</div>";
        }).join("");

        return '<div style="border:1.5px solid ' + (s.isFull ? "#9a1f5e" : "var(--line,#E6E6E6)") +
            ';border-radius:14px;padding:12px 14px;background:#fff">' +
          '<div style="font-family:Quicksand,system-ui,sans-serif;font-weight:700;color:var(--purple,#603488);font-size:14px">' +
            esc(reg.dateLabel) + "</div>" +
          '<div style="font-size:11.5px;color:' + (s.isFull ? "#9a1f5e" : "var(--muted,#808080)") + ';margin:2px 0 4px">' +
            s.booked + " / " + s.capacity + " booked · " + s.spacesLeft + " space" + (s.spacesLeft === 1 ? "" : "s") + " left" +
            (s.isFull ? " · FULL" : "") +
            (s.released ? " · " + s.released + " released" : "") + "</div>" +
          (rows || '<div style="font-size:12px;color:var(--muted,#808080);padding-top:4px">Blank register.</div>') +
        "</div>";
      }

      function refreshBoard() {
        var regs = getRegisters(providerId, today);
        board.innerHTML = regs.map(regCardHtml).join("");
      }

      function refreshControls() {
        var regs = getRegisters(providerId, today);
        // Child options: every currently-active booking, labelled with its date.
        var childSel = document.getElementById("hcTxChild");
        var destSel = document.getElementById("hcTxDest");
        if (!childSel || !destSel) return;
        var childOpts = [];
        regs.forEach(function (r) {
          r.active.forEach(function (a) {
            childOpts.push('<option value="' + escAttr(a.id) + '" data-from="' + escAttr(r.date) + '">' +
              esc(a.child) + " — " + esc(r.dateLabel) + "</option>");
          });
        });
        childSel.innerHTML = childOpts.join("") || '<option value="">(no active bookings)</option>';
        destSel.innerHTML = regs.map(function (r) {
          return '<option value="' + escAttr(r.date) + '">' + esc(r.dateLabel) +
            " (" + r.stats.booked + "/" + r.stats.capacity + ")" + (r.stats.isFull ? " — full" : "") + "</option>";
        }).join("");
      }

      function setMsg(text, ok) {
        msg.innerHTML = '<span style="color:' + (ok ? "#2f7d4f" : "#9a1f5e") + ';font-weight:700">' + esc(text) + "</span>";
      }

      controls.addEventListener("click", function (e) {
        var t = e.target;
        if (t && t.id === "hcTxReset") {
          seedRegisters(providerId, today);
          refreshControls(); refreshBoard(); setMsg("Demo reset.", true); return;
        }
        if (t && t.id === "hcTxGo") {
          var childSel = document.getElementById("hcTxChild");
          var destSel = document.getElementById("hcTxDest");
          var bookingId = childSel && childSel.value;
          var toIso = destSel && destSel.value;
          if (!bookingId) { setMsg("Pick a child to transfer.", false); return; }
          var res = transferBooking(providerId, bookingId, toIso);
          if (res.ok) {
            setMsg("Transferred to " + dateLabel(res.toDate) + ". Source seat released for resale; no refund issued.", true);
            toast("Customer transferred — both registers updated");
          } else {
            setMsg((res.errors || ["Transfer failed."]).join(" "), false);
          }
          refreshControls(); refreshBoard();
        }
      });

      refreshControls();
      refreshBoard();
    } catch (e) {
      try {
        mountEl.innerHTML = '<p style="color:#9a1f5e">Transfer feature failed to render: ' +
          esc(e && e.message ? e.message : String(e)) + "</p>";
      } catch (e2) {}
    }
  }

  /* ===================================================================
     selfTest — exercises the TRANSFER logic and the acceptance criterion.
     =================================================================== */

  function selfTest() {
    var pass = 0, fail = 0, log = [];
    function check(label, fn) {
      try { fn(); pass += 1; log.push("✓ " + label); }
      catch (e) { fail += 1; log.push("✗ " + label + " — " + (e && e.message ? e.message : String(e))); }
    }

    var TP = "__selftest_transfer__";
    var TODAY = "2026-06-15";

    var dates = seedRegisters(TP, TODAY);
    var W1 = dates.w1, W2 = dates.w2, W3 = dates.w3;

    // Helper: count active bookings of a named child across all registers.
    function activeCountFor(child) {
      var n = 0;
      getRegisters(TP, TODAY).forEach(function (r) {
        r.active.forEach(function (a) { if (a.child === child) n += 1; });
      });
      return n;
    }
    function totalActive() {
      var n = 0;
      getRegisters(TP, TODAY).forEach(function (r) { n += r.active.length; });
      return n;
    }

    check("Seed builds the source (W1) and destination (W2) registers with bookings", function () {
      var w1 = openRegister(TP, W1, TODAY);
      var w2 = openRegister(TP, W2, TODAY);
      HC.assert(w1 && w1.stats.booked === 5, "W1 should have 5 booked, got " + (w1 && w1.stats.booked));
      HC.assert(w2 && w2.stats.booked === 0, "W2 should start empty, got " + (w2 && w2.stats.booked));
    });

    // ===== ACCEPTANCE CRITERION =====
    // A booked customer can be moved to another class/date, updating BOTH
    // registers.
    check("ACCEPTANCE: transferring a child updates BOTH registers (released on source, seated on destination)", function () {
      var w1Before = openRegister(TP, W1, TODAY);
      var w2Before = openRegister(TP, W2, TODAY);
      var zane = w1Before.active.filter(function (a) { return a.child === "Zane Okafor"; })[0];
      HC.assert(zane, "Zane should be on the W1 register before transfer");

      var srcBookedBefore = w1Before.stats.booked;
      var destBookedBefore = w2Before.stats.booked;

      var res = transferBooking(TP, zane.id, W2);
      HC.assert(res.ok === true, "transfer should succeed: " + ((res.errors || []).join(" ")));
      HC.assert(res.fromDate === W1 && res.toDate === W2, "transfer should report the from/to dates");

      var w1After = openRegister(TP, W1, TODAY);
      var w2After = openRegister(TP, W2, TODAY);

      // SOURCE updated: one fewer active booking; the seat is released.
      HC.assert(w1After.stats.booked === srcBookedBefore - 1,
        "source register must lose one active booking (" + w1After.stats.booked + " vs " + (srcBookedBefore - 1) + ")");
      HC.assert(w1After.active.filter(function (a) { return a.child === "Zane Okafor"; }).length === 0,
        "Zane must no longer be ACTIVE on the source register");
      HC.assert(w1After.stats.released >= 1, "source register must show the released (crossed-through) seat");
      HC.assert(w1After.stats.spacesLeft === w1Before.stats.spacesLeft + 1,
        "the source seat must be freed for resale (one more space left)");

      // DESTINATION updated: one more active booking; the child is now listed.
      HC.assert(w2After.stats.booked === destBookedBefore + 1,
        "destination register must gain one active booking");
      HC.assert(w2After.active.filter(function (a) { return a.child === "Zane Okafor"; }).length === 1,
        "Zane must now be ACTIVE on the destination register");
    });

    check("ACCEPTANCE: child's age and SEN/allergy notes are carried across to the new register", function () {
      var w2 = openRegister(TP, W2, TODAY);
      var zane = w2.active.filter(function (a) { return a.child === "Zane Okafor"; })[0];
      HC.assert(zane, "Zane should be seated on the destination register");
      HC.assert(zane.age === 10, "Zane's age (10) must be carried across, got " + zane.age);
      HC.assert(/EHCP|autism/i.test(zane.notes.sen), "Zane's SEN note must carry across: " + zane.notes.sen);
      HC.assert(zane.transferredFrom === W1, "the seated booking should record where it came from");
      HC.assert(hasFlaggedNotes(zane), "the transferred child must still be flagged as having notes");
    });

    check("A transfer MOVES the booking — the global active count is conserved (no duplicate, no loss)", function () {
      // Reset to a clean state and measure conservation across one transfer.
      seedRegisters(TP, TODAY);
      var totalBefore = totalActive();
      var w1 = openRegister(TP, W1, TODAY);
      var amelia = w1.active.filter(function (a) { return a.child === "Amelia Brooks"; })[0];
      HC.assert(amelia, "Amelia should be bookable on W1");
      HC.assert(activeCountFor("Amelia Brooks") === 1, "Amelia should be active exactly once before");

      var res = transferBooking(TP, amelia.id, W2);
      HC.assert(res.ok === true, "Amelia's transfer should succeed");

      HC.assert(totalActive() === totalBefore,
        "total active bookings must be unchanged by a transfer (" + totalActive() + " vs " + totalBefore + ")");
      HC.assert(activeCountFor("Amelia Brooks") === 1,
        "Amelia must be active exactly ONCE after a transfer (moved, not duplicated)");
    });

    check("Each side records a transfer audit row (out on source, in on destination)", function () {
      var w1 = openRegister(TP, W1, TODAY);
      var w2 = openRegister(TP, W2, TODAY);
      var outRow = (w1.transfers || []).filter(function (t) { return t.direction === "out" && t.child === "Amelia Brooks"; })[0];
      var inRow = (w2.transfers || []).filter(function (t) { return t.direction === "in" && t.child === "Amelia Brooks"; })[0];
      HC.assert(outRow, "the source register must record an 'out' transfer for Amelia");
      HC.assert(outRow.otherDate === W2, "the 'out' row should point at the destination date");
      HC.assert(inRow, "the destination register must record an 'in' transfer for Amelia");
      HC.assert(inRow.otherDate === W1, "the 'in' row should point back at the source date");
    });

    check("A transfer does NOT issue a refund (article 3812911 NOTE)", function () {
      seedRegisters(TP, TODAY);
      var w1 = openRegister(TP, W1, TODAY);
      var sofia = w1.active.filter(function (a) { return a.child === "Sofia Rossi"; })[0];
      var res = transferBooking(TP, sofia.id, W2);
      HC.assert(res.ok === true, "Sofia's transfer should succeed");
      HC.assert(res.refundIssued === false, "a transfer must explicitly NOT issue a refund");
    });

    check("Transferring into a FULL destination class is rejected", function () {
      seedRegisters(TP, TODAY); // W3 is full (2/2)
      var w1 = openRegister(TP, W1, TODAY);
      var w3 = openRegister(TP, W3, TODAY);
      HC.assert(w3.stats.isFull, "W3 should be seeded as full");
      var felix = w1.active.filter(function (a) { return a.child === "Felix Nguyen"; })[0];
      var res = transferBooking(TP, felix.id, W3);
      HC.assert(res.ok === false, "transfer into a full class must be rejected");
      HC.assert(/full/i.test((res.errors || []).join(" ")), "the error should mention the class is full");
      // and nothing should have changed
      HC.assert(openRegister(TP, W1, TODAY).active.filter(function (a) { return a.child === "Felix Nguyen"; }).length === 1,
        "Felix must remain on W1 after a rejected transfer");
    });

    check("Transferring a child onto the date they are already on is rejected (no-op)", function () {
      seedRegisters(TP, TODAY);
      var w1 = openRegister(TP, W1, TODAY);
      var otis = w1.active.filter(function (a) { return a.child === "Otis Clarke"; })[0];
      var res = transferBooking(TP, otis.id, W1);
      HC.assert(res.ok === false, "transferring to the same date must be rejected");
      HC.assert(openRegister(TP, W1, TODAY).active.length === w1.active.length,
        "a same-date transfer must not change the register");
    });

    check("Transferring an unknown / already-transferred booking is rejected", function () {
      seedRegisters(TP, TODAY);
      var bogus = transferBooking(TP, "no_such_booking_id", W2);
      HC.assert(bogus.ok === false, "an unknown booking id must be rejected");

      var w1 = openRegister(TP, W1, TODAY);
      var zane = w1.active.filter(function (a) { return a.child === "Zane Okafor"; })[0];
      var first = transferBooking(TP, zane.id, W2);
      HC.assert(first.ok === true, "first transfer should succeed");
      var again = transferBooking(TP, zane.id, W2); // same (now released) source booking id
      HC.assert(again.ok === false, "re-transferring an already-released booking must be rejected");
    });

    check("Transferring to an invalid / non-existent date is rejected", function () {
      seedRegisters(TP, TODAY);
      var w1 = openRegister(TP, W1, TODAY);
      var felix = w1.active.filter(function (a) { return a.child === "Felix Nguyen"; })[0];
      var bad = transferBooking(TP, felix.id, "2026-13-40"); // impossible date
      HC.assert(bad.ok === false, "an impossible destination date must be rejected");
      var noReg = transferBooking(TP, felix.id, "2026-12-25"); // valid date, no register
      HC.assert(noReg.ok === false, "a destination with no register must be rejected by default");
      HC.assert(/register/i.test((noReg.errors || []).join(" ")), "the error should mention the missing register");
    });

    check("Garbage transfer input never throws and never mutates the registers", function () {
      seedRegisters(TP, TODAY);
      var before = totalActive();
      var bad = [
        function () { return transferBooking(TP, null, W2); },
        function () { return transferBooking(TP, undefined, null); },
        function () { return transferBooking(TP, "", ""); },
        function () { return transferBooking(TP, 42, {}); },
        function () { return transferBooking(TP, {}, []); }
      ];
      for (var i = 0; i < bad.length; i++) {
        var res = bad[i]();
        HC.assert(res && res.ok === false, "garbage transfer #" + i + " must be rejected, not crash");
      }
      HC.assert(totalActive() === before, "garbage transfers must not change any register");
    });

    check("A multi-hop transfer (W1 → W2 → W3-with-room) keeps the child active exactly once", function () {
      seedRegisters(TP, TODAY);
      // Give W3 room for this case by transferring into W2 first then on to W3
      // is not possible (W3 full), so instead chain W1 -> W2 -> back to a fresh
      // empty date created via opts to prove the seated booking can move again.
      var w1 = openRegister(TP, W1, TODAY);
      var felix = w1.active.filter(function (a) { return a.child === "Felix Nguyen"; })[0];
      var hop1 = transferBooking(TP, felix.id, W2);
      HC.assert(hop1.ok === true, "first hop W1->W2 should succeed");
      var newBookingId = hop1.newBooking.id;
      var hop2 = transferBooking(TP, newBookingId, "2026-08-31", { createDestination: true, destinationCapacity: 10 });
      HC.assert(hop2.ok === true, "second hop W2->new date should succeed: " + ((hop2.errors || []).join(" ")));
      HC.assert(activeCountFor("Felix Nguyen") === 1,
        "after two hops Felix must be active exactly once, got " + activeCountFor("Felix Nguyen"));
    });

    check("Transfers persist via HC.store and survive a reload", function () {
      seedRegisters(TP, TODAY);
      var w1 = openRegister(TP, W1, TODAY);
      var sofia = w1.active.filter(function (a) { return a.child === "Sofia Rossi"; })[0];
      transferBooking(TP, sofia.id, W2);
      // Re-read fresh from the store (getRegisters always reads HC.store).
      var reloaded = openRegister(TP, W2, TODAY);
      HC.assert(reloaded.active.some(function (a) { return a.child === "Sofia Rossi"; }),
        "a transferred booking must survive a reload on the destination register");
      var src = openRegister(TP, W1, TODAY);
      HC.assert(src.active.every(function (a) { return a.child !== "Sofia Rossi"; }),
        "the released booking must stay released after a reload");
    });

    // cleanup
    clearProvider(TP);

    return { pass: pass, fail: fail, log: log };
  }

  /* ===================================================================
     register
     =================================================================== */

  HC.registerFeature({
    id: "provider-transfer-customer",
    title: "Transfer a customer to a different class",
    side: "provider",
    icon: "🔁",
    summary: "Move a booked child from one camp date to another. The source seat is released for resale (crossed through, no refund) and the child is re-seated on the destination date — carrying their age and SEN/allergy/medical notes across. Both registers update in one action.",
    render: render,
    selfTest: selfTest
  });
})();
