/* HolidayCamp feature: parent-add-ticket-existing-booking
 * ------------------------------------------------------------------
 * Replicates Happity's "add another ticket onto an existing booking"
 * behaviour, reframed for SCHOOL-AGE HOLIDAY CAMPS (a place on a
 * specific summer-holiday camp week / date).
 *
 * Evidence (Happity support corpus):
 *  - Article 8255720 "Parents/Carers FAQs — Support with Bookings":
 *      "Can I add another ticket onto an existing booking?
 *       If you have booked a class already and would like to add an
 *       additional booking for this class this can be done for an ADULT
 *       ticket in the usual way on the Happity website (providing they
 *       have the capacity). SIBLING tickets can only be purchased
 *       alongside a full price ticket and so in that instance you will
 *       need to CONTACT THE CLASS PROVIDER DIRECTLY to arrange this."
 *
 * Acceptance criterion (asserted in selfTest):
 *   A parent with an existing booking can add a further eligible (ADULT)
 *   ticket to that same camp/date subject to REMAINING CAPACITY, without
 *   contacting the provider. SIBLING tickets remain PROVIDER-ONLY.
 *
 * Faithful behaviours modelled:
 *  - "Add a ticket" is only offered against an EXISTING booking for that
 *    camp + week (you cannot add onto a booking you do not hold).
 *  - ADULT tickets are self-serve: added immediately, in the usual way,
 *    ONLY while spaces remain. When the camp+week is full, the adult
 *    add is BLOCKED (capacity gate) and the parent is pointed at the
 *    waiting list / provider — never silently overbooked.
 *  - SIBLING tickets are never self-serve here: any attempt returns a
 *    provider-only outcome ("contact the provider directly"), regardless
 *    of capacity, because a sibling ticket must sit alongside a full
 *    price ticket the provider links up manually.
 *  - A child (full-price) ticket can be self-added if the camp sells one
 *    and there is capacity — but the headline rule the FAQ calls out is
 *    the adult ticket, so the demo and tests centre on that.
 *  - Adding a ticket increments the booked count (consumes a space) and
 *    appends a line to the booking, recomputing the order total.
 *
 * Defensive: nothing throws at registration time. Persistence is via
 * HC.store only (namespaced under "hc_"); no global localStorage keys.
 * ------------------------------------------------------------------ */
(function () {
  "use strict";

  if (typeof window === "undefined" || !window.HC || typeof window.HC.registerFeature !== "function") {
    // Core not present — fail silently rather than throwing.
    return;
  }
  var HC = window.HC;

  var STORE_KEY = "add_ticket_bookings_v1"; // { "<bookingRef>": { ...booking } }

  /* ============================================================
   * 1. Deterministic capacity model.
   *
   * The live planner data has no per-week capacity field, so we
   * derive a stable capacity + booked count per camp+week (same
   * inputs always give the same answer — tests are repeatable).
   * Provider/booking actions then mutate "booked" in the store.
   * ============================================================ */

  function hash(str) {
    var h = 2166136261;
    var s = String(str == null ? "" : str);
    for (var i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = (h * 16777619) >>> 0;
    }
    return h >>> 0;
  }

  function keyOf(campId, weekId) {
    return String(campId) + "::" + String(weekId);
  }

  // Base capacity + a baseline booked count derived purely from the key.
  function baseCapacity(campId, weekId) {
    var h = hash(keyOf(campId, weekId));
    var capacity = 14 + (h % 11);       // 14..24 places
    var booked = capacity - (1 + (h % 5)); // baseline leaves 1..5 spaces
    if (booked < 0) booked = 0;
    if (booked > capacity) booked = capacity;
    return { capacity: capacity, booked: booked };
  }

  /* ============================================================
   * 2. Ticket-type model.
   *
   * Happity classes offer different ticket types. We model three:
   *   - "child"   : a full-price place (the camper). Self-serve.
   *   - "adult"   : an accompanying-adult place. Self-serve subject
   *                 to capacity — the FAQ's headline "add in the usual
   *                 way" ticket.
   *   - "sibling" : a discounted second-child place. PROVIDER-ONLY
   *                 when added to an existing booking (must sit
   *                 alongside a full-price ticket the provider links).
   *
   * Whether a camp sells adult / sibling tickets is derived from the
   * camp's planner record where possible (siblingDiscount flag), else
   * deterministically, so the demo always has examples of each.
   * ============================================================ */

  function plannerRecord(campId) {
    try {
      var byId = (HC.data.planner && HC.data.planner.byId) || {};
      return byId[campId] || {};
    } catch (e) {
      return {};
    }
  }

  // The set of ticket types a camp offers.
  function ticketTypesFor(campId) {
    var rec = plannerRecord(campId);
    var h = hash("tickets::" + campId);
    var types = { child: true }; // every camp sells the full-price place
    // Adult tickets: the FAQ's headline "add in the usual way" ticket. We treat
    // an accompanying-adult ticket as universally available so the self-serve
    // add path is always reachable; capacity (not the menu) is the real gate.
    types.adult = true;
    // Sibling tickets: the data sometimes states a sibling discount.
    types.sibling = !!rec.siblingDiscount || (h % 2) === 0;
    return types;
  }

  // Per-ticket price for a camp+ticketType (best-effort from planner price).
  function priceFor(campId, weekId, ticketType) {
    var rec = plannerRecord(campId);
    var price = (rec && rec.price) || {};
    // Prefer an explicit week price, else a day price, else a sensible default.
    var weekPrice = null;
    if (typeof price.week === "number") weekPrice = price.week;
    else if (price.weekByWeek && typeof price.weekByWeek[String(weekId)] === "number") weekPrice = price.weekByWeek[String(weekId)];
    else if (typeof price.day === "number") weekPrice = price.day * 5;

    var base = (typeof weekPrice === "number" && isFinite(weekPrice)) ? weekPrice : 140;

    if (ticketType === "adult") {
      // Accompanying-adult tickets are typically a modest flat fee.
      return Math.max(0, Math.round(base * 0.25));
    }
    if (ticketType === "sibling") {
      // Sibling = discounted second-child place (here: 10% off full price).
      return Math.max(0, Math.round(base * 0.9));
    }
    return base; // child / full price
  }

  /* ============================================================
   * 3. Booking store.
   *
   * A booking is { ref, campId, weekId, parentEmail, tickets:[...],
   * createdAt }. tickets are { type, name, price }. The booked count
   * for a camp+week starts at baseline and increases by 1 per ticket
   * a booking holds against that camp+week.
   * ============================================================ */

  function allBookings() {
    var all = {};
    try { all = HC.store.get(STORE_KEY, {}) || {}; } catch (e) { all = {}; }
    if (!all || typeof all !== "object") all = {};
    return all;
  }

  function saveBookings(all) {
    try { HC.store.set(STORE_KEY, all || {}); } catch (e) { /* defensive */ }
  }

  function getBooking(ref) {
    var b = allBookings()[String(ref)];
    return b && typeof b === "object" ? b : null;
  }

  // How many places this booking already consumes on its camp+week.
  function ticketsConsumed(booking) {
    if (!booking || !Array.isArray(booking.tickets)) return 0;
    return booking.tickets.length;
  }

  // Spaces left on a camp+week = capacity − (baseline booked + any extra
  // places consumed by demo bookings beyond the baseline holder's place).
  // We keep it simple and faithful: capacity minus everything booked.
  function spacesLeft(campId, weekId, extraBooked) {
    var cap = baseCapacity(campId, weekId);
    var booked = cap.booked + (Number(extraBooked) || 0);
    var left = cap.capacity - booked;
    return left < 0 ? 0 : left;
  }

  // Create (or replace) a booking with a single full-price child ticket.
  function createBooking(opts) {
    opts = opts || {};
    var ref = opts.ref || ("HC-" + HC.util.uid().slice(-6).toUpperCase());
    var campId = opts.campId;
    var weekId = opts.weekId;
    var booking = {
      ref: ref,
      campId: campId,
      weekId: weekId,
      parentEmail: opts.parentEmail || "parent@example.com",
      camperName: opts.camperName || "Your child",
      tickets: [
        { type: "child", name: opts.camperName || "Your child", price: priceFor(campId, weekId, "child") }
      ],
      // extraBooked tracks how many places beyond this booking's own first
      // place are already taken on the camp+week (so capacity can be forced
      // to zero for the "full" demo/test path).
      extraBooked: Number(opts.extraBooked) || 0,
      createdAt: Date.now()
    };
    var all = allBookings();
    all[ref] = booking;
    saveBookings(all);
    return booking;
  }

  /* ============================================================
   * 4. THE FEATURE: add a ticket to an existing booking.
   *
   * Returns a result object so both the UI and the tests can assert
   * on the same logic.
   *
   * result = {
   *   ok: Boolean,                // was a ticket actually added?
   *   reason: String,             // machine reason code
   *   message: String,            // human message
   *   providerOnly: Boolean,      // must contact provider instead?
   *   capacityBlocked: Boolean,   // blocked purely by capacity?
   *   ticket: {type,name,price}|null,
   *   booking: <booking>|null
   * }
   * ============================================================ */

  var REASONS = {
    NO_BOOKING: "no_existing_booking",
    NOT_SOLD: "ticket_type_not_sold",
    SIBLING_PROVIDER_ONLY: "sibling_provider_only",
    FULL: "no_capacity",
    ADDED: "added"
  };

  function addTicket(ref, ticketType, attendeeName) {
    var booking = getBooking(ref);
    if (!booking) {
      return {
        ok: false, reason: REASONS.NO_BOOKING, providerOnly: false, capacityBlocked: false,
        ticket: null, booking: null,
        message: "We couldn’t find that booking. You can only add a ticket onto a booking you already hold."
      };
    }

    var campId = booking.campId, weekId = booking.weekId;
    var type = String(ticketType || "adult").toLowerCase();
    var sold = ticketTypesFor(campId);

    // FAQ rule: sibling tickets are provider-only on an existing booking.
    if (type === "sibling") {
      return {
        ok: false, reason: REASONS.SIBLING_PROVIDER_ONLY, providerOnly: true, capacityBlocked: false,
        ticket: null, booking: booking,
        message: "Sibling tickets can only be purchased alongside a full-price ticket, so to add one to this booking you’ll need to contact the camp provider directly."
      };
    }

    // The camp must actually sell this ticket type.
    if (!sold[type]) {
      return {
        ok: false, reason: REASONS.NOT_SOLD, providerOnly: false, capacityBlocked: false,
        ticket: null, booking: booking,
        message: "This camp doesn’t offer a " + type + " ticket for this week."
      };
    }

    // Capacity gate: adult/child self-serve adds only while spaces remain.
    var left = spacesLeft(campId, weekId, booking.extraBooked || 0);
    if (left <= 0) {
      return {
        ok: false, reason: REASONS.FULL, providerOnly: false, capacityBlocked: true,
        ticket: null, booking: booking,
        message: "This camp week is now full, so we can’t add another ticket. Join the waiting list or ask the provider about extra capacity."
      };
    }

    // Add it — "in the usual way".
    var ticket = {
      type: type,
      name: attendeeName || (type === "adult" ? "Accompanying adult" : "Additional child"),
      price: priceFor(campId, weekId, type)
    };
    booking.tickets.push(ticket);
    // Consuming a space: bump the camp+week's booked count via extraBooked.
    booking.extraBooked = (Number(booking.extraBooked) || 0) + 1;

    var all = allBookings();
    all[booking.ref] = booking;
    saveBookings(all);

    return {
      ok: true, reason: REASONS.ADDED, providerOnly: false, capacityBlocked: false,
      ticket: ticket, booking: booking,
      message: (type === "adult" ? "Adult" : "Full-price") + " ticket added to booking " + booking.ref + " — no need to contact the provider."
    };
  }

  function orderTotal(booking) {
    if (!booking || !Array.isArray(booking.tickets)) return 0;
    var t = 0;
    for (var i = 0; i < booking.tickets.length; i++) {
      var p = Number(booking.tickets[i].price);
      if (isFinite(p)) t += p;
    }
    return t;
  }

  /* Pick a demo camp that has a weeks list (so the date is concrete). */
  function pickDemoCamp() {
    try {
      var byId = (HC.data.planner && HC.data.planner.byId) || {};
      for (var id in byId) {
        if (!Object.prototype.hasOwnProperty.call(byId, id)) continue;
        var rec = byId[id];
        if (rec && Array.isArray(rec.weeks) && rec.weeks.length) {
          return { campId: id, weekId: rec.weeks[0] };
        }
      }
    } catch (e) { /* fall through */ }
    return { campId: "ymca-y-kidz", weekId: 2 };
  }

  function campName(campId) {
    try {
      var providers = HC.data.providers || [];
      for (var i = 0; i < providers.length; i++) {
        if (providers[i] && (providers[i].id === campId)) return providers[i].name || campId;
      }
    } catch (e) { /* ignore */ }
    return campId;
  }

  function weekLabel(weekId) {
    try {
      var weeks = (HC.data.planner && HC.data.planner.weeks) || [];
      for (var i = 0; i < weeks.length; i++) {
        if (weeks[i] && weeks[i].id === weekId) {
          return weeks[i].label + (weeks[i].dates ? " · " + weeks[i].dates : "");
        }
      }
    } catch (e) { /* ignore */ }
    return "Week " + weekId;
  }

  /* ============================================================
   * 5. render(mountEl) — interactive demo UI.
   * ============================================================ */

  function render(mountEl) {
    try {
      var demo = pickDemoCamp();
      // Use a stable demo booking ref so re-opening the panel is idempotent.
      var demoRef = "HC-DEMO1";
      var booking = getBooking(demoRef);
      if (!booking || booking.campId !== demo.campId || booking.weekId !== demo.weekId) {
        booking = createBooking({
          ref: demoRef, campId: demo.campId, weekId: demo.weekId,
          camperName: "Your child", parentEmail: "you@example.com"
        });
      }

      var sold = ticketTypesFor(demo.campId);

      function paint() {
        var b = getBooking(demoRef);
        var left = spacesLeft(b.campId, b.weekId, b.extraBooked || 0);
        var rows = b.tickets.map(function (t) {
          return '<li>' +
            '<strong>' + esc(cap(t.type)) + '</strong> — ' + esc(t.name) +
            ' <span style="color:var(--muted,#808080)">' + HC.util.money(t.price) + '</span></li>';
        }).join("");

        mountEl.innerHTML =
          '<p style="font-size:14px;color:var(--text,#383838);margin:0 0 12px">' +
            'You’ve already booked <strong>' + esc(campName(b.campId)) + '</strong> for ' +
            '<strong>' + esc(weekLabel(b.weekId)) + '</strong>. ' +
            'You can add an <strong>adult</strong> ticket to this booking yourself — in the usual way — ' +
            'as long as there’s space. Sibling tickets must be arranged with the provider.' +
          '</p>' +
          '<div style="background:var(--purple-tint,#F0E8F4);border-radius:14px;padding:12px 14px;margin:0 0 14px">' +
            '<div style="font-family:Quicksand,system-ui,sans-serif;font-weight:700;color:var(--purple,#603488)">Booking ' + esc(b.ref) + '</div>' +
            '<ul style="margin:8px 0 6px;padding-left:18px;font-size:13.5px;line-height:1.7">' + rows + '</ul>' +
            '<div style="font-size:13px;color:var(--text,#383838)">Total: <strong>' + HC.util.money(orderTotal(b)) + '</strong>' +
              ' &nbsp;·&nbsp; Spaces left this week: <strong>' + left + '</strong></div>' +
          '</div>' +
          '<div style="display:flex;gap:8px;flex-wrap:wrap">' +
            '<button class="hc-btn" data-add="adult"' + (sold.adult ? '' : ' disabled style="opacity:.5"') + '>+ Add adult ticket</button>' +
            '<button class="hc-btn hc-btn-ghost" data-add="sibling">+ Add sibling ticket</button>' +
            '<button class="hc-btn hc-btn-ghost" data-fill>Simulate week selling out</button>' +
          '</div>' +
          '<p style="font-size:12px;color:var(--muted,#808080);margin:12px 0 0">' +
            'Adult tickets: self-serve while spaces remain. Sibling tickets: provider-only (must sit alongside a full-price ticket).' +
          '</p>';

        var addBtns = mountEl.querySelectorAll("[data-add]");
        for (var i = 0; i < addBtns.length; i++) {
          addBtns[i].addEventListener("click", function (e) {
            var type = e.currentTarget.getAttribute("data-add");
            var res = addTicket(demoRef, type, null);
            HC.util.toast((res.ok ? "✓ " : (res.providerOnly ? "ℹ️ " : "✗ ")) + res.message);
            paint();
          });
        }
        var fill = mountEl.querySelector("[data-fill]");
        if (fill) {
          fill.addEventListener("click", function () {
            var b2 = getBooking(demoRef);
            var cap = baseCapacity(b2.campId, b2.weekId);
            // Force the week full: extraBooked consumes all remaining spaces.
            b2.extraBooked = Math.max(0, cap.capacity - cap.booked);
            var all = allBookings(); all[demoRef] = b2; saveBookings(all);
            HC.util.toast("This camp week is now full — try adding an adult ticket.");
            paint();
          });
        }
      }

      paint();
    } catch (e) {
      mountEl.innerHTML = '<p style="color:#9a1f5e">Demo failed to load: ' + esc(e && e.message ? e.message : String(e)) + '</p>';
    }
  }

  function cap(s) { s = String(s || ""); return s.charAt(0).toUpperCase() + s.slice(1); }
  function esc(s) {
    return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  /* ============================================================
   * 6. selfTest() — exercises the LOGIC and asserts the criterion.
   * ============================================================ */

  function selfTest() {
    var pass = 0, fail = 0, log = [];
    function check(label, fn) {
      try { fn(); pass += 1; log.push("✓ " + label); }
      catch (e) { fail += 1; log.push("✗ " + label + " — " + (e && e.message ? e.message : String(e))); }
    }

    // Isolate test state from any demo state.
    var savedAll = allBookings();

    try {
      // Find a camp that DOES sell adult tickets (deterministic search).
      var byId = (HC.data.planner && HC.data.planner.byId) || {};
      var adultCamp = null, weekId = null;
      for (var id in byId) {
        if (!Object.prototype.hasOwnProperty.call(byId, id)) continue;
        var rec = byId[id];
        var w = (rec && Array.isArray(rec.weeks) && rec.weeks.length) ? rec.weeks[0] : 1;
        if (ticketTypesFor(id).adult) { adultCamp = id; weekId = w; break; }
      }
      if (!adultCamp) { adultCamp = "ymca-y-kidz"; weekId = 2; }

      // -- Case 1: ACCEPTANCE CRITERION --
      // A parent WITH an existing booking adds an adult ticket, self-serve,
      // with capacity available — no provider contact required.
      check("Adult ticket adds to an existing booking with capacity (self-serve)", function () {
        var b = createBooking({ ref: "TST-1", campId: adultCamp, weekId: weekId, extraBooked: 0 });
        HC.assert(b && b.tickets.length === 1, "booking should start with 1 ticket");
        var before = b.tickets.length;
        var res = addTicket("TST-1", "adult", "Grandma");
        HC.assert(res.ok === true, "adult add should succeed, got reason=" + res.reason);
        HC.assert(res.providerOnly === false, "adult add must NOT require provider contact");
        HC.assert(res.ticket && res.ticket.type === "adult", "added ticket should be adult");
        var after = getBooking("TST-1").tickets.length;
        HC.assert(after === before + 1, "ticket count should increase by 1 (" + before + "->" + after + ")");
      });

      // -- Case 2: capacity gate --
      // Same add, but the week is FULL -> blocked by capacity, no overbooking.
      check("Adult ticket is BLOCKED when the camp week is full (capacity gate)", function () {
        var capa = baseCapacity(adultCamp, weekId);
        var fullExtra = Math.max(0, capa.capacity - capa.booked); // consume all remaining
        var b = createBooking({ ref: "TST-2", campId: adultCamp, weekId: weekId, extraBooked: fullExtra });
        HC.assert(spacesLeft(b.campId, b.weekId, b.extraBooked) === 0, "week should be full (0 spaces)");
        var res = addTicket("TST-2", "adult", "Grandpa");
        HC.assert(res.ok === false, "adult add should be blocked when full");
        HC.assert(res.capacityBlocked === true, "block reason should be capacity");
        HC.assert(res.providerOnly === false, "a full week is not a provider-only case");
        HC.assert(getBooking("TST-2").tickets.length === 1, "no ticket should be added when full");
      });

      // -- Case 3: sibling tickets remain PROVIDER-ONLY --
      // Even with plenty of capacity, a sibling ticket cannot be self-added.
      check("Sibling ticket is provider-only (never self-serve), even with capacity", function () {
        var b = createBooking({ ref: "TST-3", campId: adultCamp, weekId: weekId, extraBooked: 0 });
        HC.assert(spacesLeft(b.campId, b.weekId, 0) > 0, "precondition: capacity available");
        var res = addTicket("TST-3", "sibling", "Little sibling");
        HC.assert(res.ok === false, "sibling self-add must fail");
        HC.assert(res.providerOnly === true, "sibling add must be flagged provider-only");
        HC.assert(res.reason === REASONS.SIBLING_PROVIDER_ONLY, "reason should be sibling_provider_only");
        HC.assert(/contact the camp provider/i.test(res.message), "message should direct to the provider");
        HC.assert(getBooking("TST-3").tickets.length === 1, "no sibling ticket should be self-added");
      });

      // -- Case 4: cannot add onto a booking you do not hold --
      check("Cannot add a ticket without an existing booking", function () {
        var res = addTicket("DOES-NOT-EXIST", "adult", "Nobody");
        HC.assert(res.ok === false, "should fail with no booking");
        HC.assert(res.reason === REASONS.NO_BOOKING, "reason should be no_existing_booking");
      });

      // -- Case 5: the order total recomputes when a ticket is added --
      check("Order total increases by the adult ticket price when added", function () {
        var b = createBooking({ ref: "TST-5", campId: adultCamp, weekId: weekId, extraBooked: 0 });
        var totalBefore = orderTotal(getBooking("TST-5"));
        var adultPrice = priceFor(adultCamp, weekId, "adult");
        var res = addTicket("TST-5", "adult", "Auntie");
        HC.assert(res.ok === true, "adult add should succeed");
        var totalAfter = orderTotal(getBooking("TST-5"));
        HC.assert(totalAfter === totalBefore + adultPrice,
          "total should rise by adult price (" + totalBefore + "+" + adultPrice + " != " + totalAfter + ")");
      });

      // -- Case 6: adding consumes a space (capacity is not infinite) --
      check("Adding an adult ticket consumes one space on the camp week", function () {
        var b = createBooking({ ref: "TST-6", campId: adultCamp, weekId: weekId, extraBooked: 0 });
        var leftBefore = spacesLeft(b.campId, b.weekId, getBooking("TST-6").extraBooked || 0);
        addTicket("TST-6", "adult", "Uncle");
        var leftAfter = spacesLeft(b.campId, b.weekId, getBooking("TST-6").extraBooked || 0);
        HC.assert(leftAfter === leftBefore - 1, "spaces should drop by 1 (" + leftBefore + "->" + leftAfter + ")");
      });

      // -- Case 7: capacity model is deterministic (stable tests) --
      check("Capacity model is deterministic for a camp+week", function () {
        var a = baseCapacity(adultCamp, weekId);
        var b = baseCapacity(adultCamp, weekId);
        HC.assert(a.capacity === b.capacity && a.booked === b.booked, "same key must give same capacity");
      });

    } finally {
      // Clean up our test bookings; restore whatever was there before.
      try { saveBookings(savedAll); } catch (e) { /* ignore */ }
    }

    return { pass: pass, fail: fail, log: log };
  }

  /* ============================================================
   * 7. Register.
   * ============================================================ */

  HC.registerFeature({
    id: "parent-add-ticket-existing-booking",
    title: "Add a ticket to an existing booking",
    side: "parent",
    icon: "🎟️",
    summary: "Add an extra adult ticket to a camp week you’ve already booked — self-serve, subject to spaces. Sibling tickets stay provider-only.",
    render: render,
    selfTest: selfTest
  });
})();
