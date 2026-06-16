/* HolidayCamp feature — provider-capacity
 *
 * Set / change capacity per event date  (provider side)
 *
 * Replicates Happity's "manage the number of tickets or capacity available"
 * flow. Evidence: support article 4414899
 * ("How to manage the number of tickets or capacity available in a class"):
 *   - "You can change the number of spaces available for sale on any of your
 *     events at any time, provided they haven't been sold yet."
 *   - "On the left hand side of the profile, there is a list of class dates and
 *     the number of spaces currently available in each event. Click on
 *     'capacity' to make changes."
 *   - On the register: "a status at the top … showing the number of 'Places
 *     available'. Click on this card to change the number of tickets available."
 *
 * Framed for SCHOOL-AGE HOLIDAY CAMPS (not baby classes). Each holiday-camp
 * EVENT DATE (e.g. "Multi-Activity Camp — Mon 27 Jul 2026") has:
 *   - capacity : the total spaces the provider has put on sale for that date.
 *   - sold     : spaces already booked for that date (cannot un-sell).
 * The number of BOOKABLE spaces on a date = max(0, capacity − sold).
 *
 * ACCEPTANCE CRITERION (asserted in selfTest):
 *   Editing capacity changes the number of bookable spaces on that date.
 *   i.e. setEventCapacity(date, n) makes bookableSpaces(date) reflect the new
 *   capacity (less anything already sold), and never below the sold count.
 *
 * Self-contained, defensive, no imports/exports. Calls HC.registerFeature.
 */
(function () {
  "use strict";

  // Defensive: never throw at module load if HC isn't present.
  if (typeof window === "undefined" || !window.HC || typeof window.HC.registerFeature !== "function") {
    if (typeof console !== "undefined" && console.warn) {
      console.warn("[HC] provider-capacity: HC core not found; skipping registration.");
    }
    return;
  }

  var HC = window.HC;

  var STORE_KEY = "provider_event_capacity"; // { <providerId>: { <eventId>: {capacity, sold, ...} } }

  /* ===================================================================
     PURE LOGIC (testable, DOM-free)
     =================================================================== */

  function asText(v) {
    return typeof v === "string" ? v : (v == null ? "" : String(v));
  }

  // Strict YYYY-MM-DD validation that also rejects impossible calendar dates.
  function isValidISODate(s) {
    var str = asText(s);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(str)) return false;
    var parts = str.split("-");
    var y = Number(parts[0]), m = Number(parts[1]), d = Number(parts[2]);
    if (m < 1 || m > 12 || d < 1 || d > 31) return false;
    var dt = new Date(Date.UTC(y, m - 1, d));
    return dt.getUTCFullYear() === y &&
      dt.getUTCMonth() === m - 1 &&
      dt.getUTCDate() === d;
  }

  var DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  var MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  function dateLabel(iso) {
    try {
      if (!isValidISODate(iso)) return asText(iso);
      var p = iso.split("-");
      var dt = new Date(Date.UTC(Number(p[0]), Number(p[1]) - 1, Number(p[2])));
      return DOW[dt.getUTCDay()] + " " + Number(p[2]) + " " + MON[Number(p[1]) - 1] + " " + p[0];
    } catch (e) {
      return asText(iso);
    }
  }

  // A capacity must be a whole number >= 0. Returns the integer or null.
  // Note: a whitespace-only string is treated as blank/invalid (Number("  ")
  // would otherwise coerce to 0, silently passing as a valid capacity).
  function toCapacityOrNull(v) {
    if (v === undefined || v === null) return null;
    if (typeof v === "string" && v.trim() === "") return null;
    var n = Number(v);
    if (!isFinite(n) || n < 0 || Math.floor(n) !== n) return null;
    return n;
  }

  // A sold count clamps to a sensible non-negative integer (defensive).
  function toSold(v) {
    var n = Number(v);
    if (!isFinite(n) || n < 0) return 0;
    return Math.floor(n);
  }

  // THE CORE FORMULA. Bookable spaces on an event date = capacity − sold,
  // never below zero. This is the number a parent sees as "spaces left".
  function bookableFor(rec) {
    if (!rec || typeof rec !== "object") return 0;
    var cap = toSold(rec.capacity);
    var sold = toSold(rec.sold);
    var left = cap - sold;
    return left > 0 ? left : 0;
  }

  function isSoldOut(rec) {
    return bookableFor(rec) === 0;
  }

  // Build a fresh event-date capacity record from input.
  //   input: { eventId?, date, title?, capacity, sold? }
  function makeEventRecord(input) {
    var a = (input && typeof input === "object") ? input : {};
    var cap = toCapacityOrNull(a.capacity);
    return {
      eventId: asText(a.eventId) || safeUid("evt"),
      date: asText(a.date),
      dateLabel: dateLabel(a.date),
      title: asText(a.title) || "Holiday camp day",
      capacity: cap == null ? 0 : cap,
      sold: toSold(a.sold),
      updatedAt: Date.now()
    };
  }

  /* ----- validation for an edit ----- */

  // Validate a proposed NEW capacity for an event that already has `sold`
  // bookings. Mirrors article 4414899's rule: you can change spaces "provided
  // they haven't been sold yet" — so the new capacity cannot drop below what is
  // already sold (that would make booked children un-bookable).
  //   Returns { ok:Boolean, errors:[String] }.
  function validateCapacityChange(newCapacity, sold) {
    var errors = [];
    var cap = toCapacityOrNull(newCapacity);
    if (cap === null) {
      errors.push("Capacity must be a whole number of 0 or more.");
      return { ok: false, errors: errors };
    }
    var s = toSold(sold);
    if (cap < s) {
      errors.push("You can't set capacity below the " + s +
        " space" + (s === 1 ? "" : "s") + " already booked for this date.");
    }
    return { ok: errors.length === 0, errors: errors };
  }

  function safeUid(prefix) {
    try { return HC.util.uid(); }
    catch (e) { return (prefix || "id") + "_" + Date.now() + "_" + Math.floor(Math.random() * 1e6); }
  }

  /* ===================================================================
     PERSISTENCE (HC.store only — never raw localStorage)

     Shape: { <providerId>: { <eventId>: { eventId, date, title, capacity, sold } } }
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
    if (!map[pid] || typeof map[pid] !== "object" || Array.isArray(map[pid])) {
      map[pid] = {};
    }
    return map[pid];
  }

  // Add or replace an event-date record for a provider. Returns the saved rec.
  function upsertEvent(providerId, input) {
    var map = readAll();
    var bucket = providerBucket(map, providerId);
    var rec = makeEventRecord(input);
    // Preserve sold across a re-add if a record for this id already exists.
    var existing = bucket[rec.eventId];
    if (existing && typeof existing === "object") {
      rec.sold = toSold(existing.sold);
    }
    bucket[rec.eventId] = rec;
    writeAll(map);
    return rec;
  }

  function getEvent(providerId, eventId) {
    var map = readAll();
    var bucket = providerBucket(map, providerId);
    var rec = bucket[asText(eventId)];
    return (rec && typeof rec === "object") ? rec : null;
  }

  function listEvents(providerId) {
    var map = readAll();
    var bucket = providerBucket(map, providerId);
    var out = [];
    for (var k in bucket) {
      if (Object.prototype.hasOwnProperty.call(bucket, k) && bucket[k] && typeof bucket[k] === "object") {
        out.push(bucket[k]);
      }
    }
    out.sort(function (a, b) {
      return asText(a.date) < asText(b.date) ? -1 : asText(a.date) > asText(b.date) ? 1 : 0;
    });
    return out;
  }

  // THE ACCEPTANCE-CRITERION ENTRY POINT.
  // Set / change capacity for a specific event date. On success the number of
  // bookable spaces (capacity − sold) reflects the new capacity.
  //   Returns { ok, rec?, bookable?, errors? }.
  function setEventCapacity(providerId, eventId, newCapacity) {
    var rec = getEvent(providerId, eventId);
    if (!rec) return { ok: false, errors: ["No such event date."] };
    var v = validateCapacityChange(newCapacity, rec.sold);
    if (!v.ok) return { ok: false, errors: v.errors };
    var map = readAll();
    var bucket = providerBucket(map, providerId);
    var stored = bucket[rec.eventId];
    stored.capacity = toCapacityOrNull(newCapacity);
    stored.updatedAt = Date.now();
    writeAll(map);
    return { ok: true, rec: stored, bookable: bookableFor(stored) };
  }

  // Record a booking against a date (used by the demo + to test the sold floor).
  // Cannot book beyond capacity. Returns { ok, rec?, errors? }.
  function bookOne(providerId, eventId) {
    var rec = getEvent(providerId, eventId);
    if (!rec) return { ok: false, errors: ["No such event date."] };
    if (bookableFor(rec) <= 0) return { ok: false, errors: ["This date is sold out."] };
    var map = readAll();
    var bucket = providerBucket(map, providerId);
    bucket[rec.eventId].sold = toSold(bucket[rec.eventId].sold) + 1;
    writeAll(map);
    return { ok: true, rec: bucket[rec.eventId] };
  }

  function clearProvider(providerId) {
    var map = readAll();
    var pid = asText(providerId) || "_default";
    delete map[pid];
    writeAll(map);
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

  function demoProviderId() {
    try {
      var ps = HC.data.providers;
      if (ps && ps.length && ps[0] && ps[0].id) return ps[0].id;
    } catch (e) {}
    return "_demo_provider";
  }

  // Seed one event-date row per live planner week (using its Monday date) so the
  // preview shows real holiday-camp dates. Defensive against missing data.
  function demoSeedDates() {
    var seeds = [];
    try {
      var weeks = (HC.data.planner && HC.data.planner.weeks) || [];
      for (var i = 0; i < weeks.length && seeds.length < 4; i++) {
        var w = weeks[i];
        if (w && isValidISODate(w.mon)) {
          seeds.push({ date: w.mon, title: "Multi-Activity Camp — " + (w.label || ("Week " + w.id)) });
        }
      }
    } catch (e) {}
    if (!seeds.length) {
      seeds = [
        { date: "2026-07-20", title: "Multi-Activity Camp — Week 1" },
        { date: "2026-07-27", title: "Multi-Activity Camp — Week 2" },
        { date: "2026-08-03", title: "Multi-Activity Camp — Week 3" }
      ];
    }
    return seeds;
  }

  function rowHtml(rec) {
    var bookable = bookableFor(rec);
    var soldOut = bookable === 0;
    var statusColour = soldOut ? "#9a1f5e" : (bookable <= 3 ? "#9a5a1f" : "#2f7d4f");
    var statusBg = soldOut ? "var(--pink-tint,#FCE8F0)" : (bookable <= 3 ? "#FFF3E2" : "#E1F0E4");
    var statusText = soldOut
      ? "Sold out"
      : (bookable + " place" + (bookable === 1 ? "" : "s") + " available");
    return '' +
      '<div class="hc-cap-row" data-evt="' + escAttr(rec.eventId) + '" ' +
        'style="display:grid;grid-template-columns:1fr auto;gap:10px;align-items:center;' +
        'border:1.5px solid var(--line,#E6E6E6);border-radius:14px;padding:11px 13px;margin:0 0 9px;background:#fff">' +
        '<div>' +
          '<div style="font-family:Quicksand,system-ui,sans-serif;font-weight:700;color:var(--purple,#603488)">' +
            esc(rec.title) + '</div>' +
          '<div style="font-size:12.5px;color:var(--muted,#808080)">📅 ' + esc(rec.dateLabel) +
            ' · capacity ' + esc(rec.capacity) + ' · ' + esc(rec.sold) + ' booked</div>' +
          '<div style="margin-top:5px"><span style="font-size:11.5px;font-weight:700;padding:3px 9px;' +
            'border-radius:999px;color:' + statusColour + ';background:' + statusBg + '" ' +
            'data-bookable="' + escAttr(bookable) + '">' + esc(statusText) + '</span></div>' +
        '</div>' +
        '<div style="display:flex;align-items:center;gap:7px">' +
          '<input type="number" min="' + escAttr(rec.sold) + '" step="1" value="' + escAttr(rec.capacity) + '" ' +
            'data-cap-input="' + escAttr(rec.eventId) + '" ' +
            'style="width:74px;padding:6px 8px;border:1.5px solid var(--line,#E6E6E6);border-radius:8px;text-align:center">' +
          '<button class="hc-btn" type="button" data-cap-save="' + escAttr(rec.eventId) + '" ' +
            'style="padding:7px 12px;font-size:11.5px">Save capacity</button>' +
          '<button class="hc-btn hc-btn-ghost" type="button" data-book="' + escAttr(rec.eventId) + '" ' +
            'style="padding:7px 11px;font-size:11.5px"' + (soldOut ? ' disabled' : '') + '>+1 booking</button>' +
        '</div>' +
      '</div>';
  }

  function listHtml(providerId) {
    var rows = listEvents(providerId);
    if (!rows.length) {
      return '<p style="color:var(--muted,#808080)">No event dates yet.</p>';
    }
    return rows.map(rowHtml).join("");
  }

  function render(mountEl) {
    try {
      if (!mountEl) return;
      var providerId = demoProviderId();
      mountEl.innerHTML = "";

      var intro = el("div", null,
        '<p style="font-size:14px;color:var(--text,#383838);margin:0 0 4px">' +
          "Each <strong>camp date</strong> has its own number of spaces on sale. Change the " +
          "<strong>capacity</strong> for any date below and the number of <strong>bookable " +
          "spaces</strong> updates instantly — exactly like editing the 'Places available' " +
          "on a Happity register.</p>" +
        '<p style="font-size:12.5px;color:var(--muted,#808080);margin:0 0 8px">' +
          "Bookable spaces = capacity − spaces already booked. You can't set capacity below " +
          "what's already booked.</p>");
      mountEl.appendChild(intro);

      // Seed demo dates once per provider if empty.
      if (!listEvents(providerId).length) {
        var seeds = demoSeedDates();
        for (var i = 0; i < seeds.length; i++) {
          var rec = upsertEvent(providerId, { date: seeds[i].date, title: seeds[i].title, capacity: 20 });
          // give the second date a couple of demo bookings so the floor is visible
          if (i === 1) { bookOne(providerId, rec.eventId); bookOne(providerId, rec.eventId); bookOne(providerId, rec.eventId); }
        }
      }

      var listHost = el("div", { id: "hcCapList" }, listHtml(providerId));
      mountEl.appendChild(listHost);

      var errHost = el("div", { id: "hcCapErr", style: "margin-top:6px;color:#9a1f5e;font-size:12.5px" }, "");
      mountEl.appendChild(errHost);

      function refresh() { listHost.innerHTML = listHtml(providerId); }

      listHost.addEventListener("click", function (e) {
        var t = e.target;
        if (!t || !t.closest) return;

        var saveBtn = t.closest("[data-cap-save]");
        if (saveBtn) {
          errHost.textContent = "";
          var id = saveBtn.getAttribute("data-cap-save");
          var input = listHost.querySelector('[data-cap-input="' + cssEsc(id) + '"]');
          var res = setEventCapacity(providerId, id, input ? input.value : "");
          if (!res.ok) { errHost.textContent = res.errors.join(" "); return; }
          refresh();
          try {
            HC.util.toast("Capacity saved — " + res.bookable + " place" +
              (res.bookable === 1 ? "" : "s") + " bookable");
          } catch (er) {}
          return;
        }

        var bookBtn = t.closest("[data-book]");
        if (bookBtn) {
          errHost.textContent = "";
          var bres = bookOne(providerId, bookBtn.getAttribute("data-book"));
          if (!bres.ok) { errHost.textContent = bres.errors.join(" "); return; }
          refresh();
          try { HC.util.toast("Booked one place"); } catch (er) {}
          return;
        }
      });
    } catch (e) {
      try {
        mountEl.innerHTML = '<p style="color:#9a1f5e">Capacity feature failed to render: ' +
          esc(e && e.message ? e.message : String(e)) + "</p>";
      } catch (e2) { /* give up quietly */ }
    }
  }

  // Minimal CSS.escape fallback for our generated ids.
  function cssEsc(s) {
    return asText(s).replace(/["\\\]\[\(\)\.#:>~+*^$=|]/g, "\\$&");
  }

  /* ===================================================================
     selfTest
     =================================================================== */

  function selfTest() {
    var pass = 0, fail = 0, log = [];
    function check(label, fn) {
      try { fn(); pass += 1; log.push("✓ " + label); }
      catch (e) { fail += 1; log.push("✗ " + label + " — " + (e && e.message ? e.message : String(e))); }
    }

    var TP = "__selftest_capacity_provider__";
    clearProvider(TP); // deterministic starting point

    // ----- the bookable formula in isolation -----
    check("Bookable spaces = capacity − sold, floored at 0", function () {
      HC.assert(bookableFor({ capacity: 20, sold: 0 }) === 20, "20 cap, 0 sold => 20");
      HC.assert(bookableFor({ capacity: 20, sold: 7 }) === 13, "20 cap, 7 sold => 13");
      HC.assert(bookableFor({ capacity: 5, sold: 5 }) === 0, "fully sold => 0");
      HC.assert(bookableFor({ capacity: 3, sold: 9 }) === 0, "oversold never goes negative");
    });

    // ===== ACCEPTANCE CRITERION =====
    // Editing capacity changes the number of bookable spaces on that date.

    var evtId;
    check("Provider creates an event date with capacity 20", function () {
      var rec = upsertEvent(TP, { date: "2026-07-27", title: "Multi-Activity Camp — Week 2", capacity: 20 });
      evtId = rec.eventId;
      HC.assert(rec.capacity === 20, "capacity should be 20");
      HC.assert(bookableFor(rec) === 20, "20 bookable spaces on a brand-new date");
    });

    check("Editing capacity UP increases bookable spaces on that date", function () {
      var before = bookableFor(getEvent(TP, evtId));
      HC.assert(before === 20, "baseline bookable should be 20, got " + before);
      var res = setEventCapacity(TP, evtId, 30);
      HC.assert(res.ok === true, "raising capacity should succeed: " + (res.errors || []).join(" "));
      HC.assert(res.bookable === 30, "bookable should now be 30, got " + res.bookable);
      // and it persisted
      HC.assert(bookableFor(getEvent(TP, evtId)) === 30, "persisted bookable should be 30");
      HC.assert(res.bookable > before, "editing capacity up must increase bookable spaces");
    });

    check("Editing capacity DOWN decreases bookable spaces on that date", function () {
      var res = setEventCapacity(TP, evtId, 12);
      HC.assert(res.ok === true, "lowering capacity should succeed");
      HC.assert(res.bookable === 12, "bookable should now be 12, got " + res.bookable);
      HC.assert(bookableFor(getEvent(TP, evtId)) === 12, "persisted bookable should be 12");
    });

    check("Capacity change is scoped to ONE date and doesn't touch others", function () {
      var other = upsertEvent(TP, { date: "2026-08-03", title: "Multi-Activity Camp — Week 3", capacity: 15 });
      var res = setEventCapacity(TP, evtId, 25);
      HC.assert(res.ok === true, "edit should succeed");
      HC.assert(bookableFor(getEvent(TP, evtId)) === 25, "edited date should be 25");
      HC.assert(bookableFor(getEvent(TP, other.eventId)) === 15, "the other date must stay at 15");
    });

    // ===== Interaction with already-sold places (article 4414899's rule) =====

    check("Bookable reflects sold places after bookings", function () {
      // capacity is 25 on evtId; book 5
      for (var i = 0; i < 5; i++) {
        var b = bookOne(TP, evtId);
        HC.assert(b.ok === true, "booking " + i + " should succeed");
      }
      HC.assert(bookableFor(getEvent(TP, evtId)) === 20, "25 cap − 5 sold => 20 bookable");
    });

    check("Editing capacity changes bookable while honouring the sold count", function () {
      // raise to 40 with 5 sold -> 35 bookable
      var up = setEventCapacity(TP, evtId, 40);
      HC.assert(up.ok === true, "raise should succeed");
      HC.assert(up.bookable === 35, "40 cap − 5 sold => 35 bookable, got " + up.bookable);
      // lower to 8 with 5 sold -> 3 bookable
      var down = setEventCapacity(TP, evtId, 8);
      HC.assert(down.ok === true, "lower (still >= sold) should succeed");
      HC.assert(down.bookable === 3, "8 cap − 5 sold => 3 bookable, got " + down.bookable);
    });

    check("Capacity cannot be set below spaces already booked", function () {
      // 5 sold on evtId; try to set capacity to 2
      var res = setEventCapacity(TP, evtId, 2);
      HC.assert(res.ok === false, "setting capacity below sold must be rejected");
      HC.assert(/booked/i.test(res.errors.join(" ")), "error should mention already-booked places");
      // unchanged: still 8 cap, 5 sold => 3 bookable
      HC.assert(bookableFor(getEvent(TP, evtId)) === 3, "rejected edit must not change bookable");
    });

    check("Setting capacity exactly to sold count yields 0 bookable (sold out)", function () {
      var res = setEventCapacity(TP, evtId, 5); // 5 sold
      HC.assert(res.ok === true, "capacity == sold is allowed");
      HC.assert(res.bookable === 0, "0 bookable when capacity equals sold");
      HC.assert(isSoldOut(getEvent(TP, evtId)) === true, "date should read as sold out");
    });

    check("A sold-out date cannot take a further booking", function () {
      var b = bookOne(TP, evtId);
      HC.assert(b.ok === false, "booking a sold-out date must fail");
      // re-open by raising capacity, then a booking succeeds again
      var up = setEventCapacity(TP, evtId, 6);
      HC.assert(up.ok === true && up.bookable === 1, "raising to 6 reopens 1 space");
      var b2 = bookOne(TP, evtId);
      HC.assert(b2.ok === true, "with a space reopened, a booking should succeed");
      HC.assert(bookableFor(getEvent(TP, evtId)) === 0, "now full again (6 cap, 6 sold)");
    });

    // ===== Validation of the capacity value itself =====

    check("Invalid capacity values are rejected", function () {
      var other = upsertEvent(TP, { date: "2026-08-10", title: "Week 4", capacity: 10 });
      var bad = ["", null, undefined, -1, 2.5, "lots", NaN, "  "];
      for (var i = 0; i < bad.length; i++) {
        var res = setEventCapacity(TP, other.eventId, bad[i]);
        HC.assert(res.ok === false, "invalid capacity '" + bad[i] + "' must be rejected");
      }
      // capacity unchanged at 10
      HC.assert(getEvent(TP, other.eventId).capacity === 10, "rejected edits must not change stored capacity");
    });

    check("Capacity of 0 is allowed (closes the date to new bookings)", function () {
      var rec = upsertEvent(TP, { date: "2026-08-17", title: "Week 5", capacity: 12, sold: 0 });
      var res = setEventCapacity(TP, rec.eventId, 0);
      HC.assert(res.ok === true, "capacity 0 with 0 sold should be allowed");
      HC.assert(res.bookable === 0, "0 capacity => 0 bookable");
    });

    // ===== Persistence via HC.store (not raw localStorage) =====

    check("Capacity edits persist via HC.store and reload", function () {
      var rec = upsertEvent(TP, { date: "2026-08-24", title: "Week 6", capacity: 18 });
      setEventCapacity(TP, rec.eventId, 22);
      // re-read from a fresh listEvents() call (goes back to the store)
      var reloaded = listEvents(TP).filter(function (r) { return r.eventId === rec.eventId; })[0];
      HC.assert(reloaded, "the edited date should still be present after reload");
      HC.assert(reloaded.capacity === 22, "persisted capacity should be 22, got " + reloaded.capacity);
      HC.assert(bookableFor(reloaded) === 22, "persisted bookable should be 22");
    });

    // ===== Defensive: garbage never throws =====

    check("Editing a non-existent date fails cleanly", function () {
      var res = setEventCapacity(TP, "no-such-id", 10);
      HC.assert(res && res.ok === false, "editing a missing date should fail, not throw");
    });

    check("Garbage upsert input is handled and never throws", function () {
      var bad = [null, undefined, 42, "", [], {}, { date: 12345 }];
      for (var i = 0; i < bad.length; i++) {
        var rec = upsertEvent(TP, bad[i]);
        HC.assert(rec && typeof rec === "object", "upsert should always return a record object");
        HC.assert(typeof bookableFor(rec) === "number", "bookable should be a number for any record");
      }
    });

    check("ISO date labels render for real holiday-camp dates", function () {
      HC.assert(dateLabel("2026-07-27") === "Mon 27 Jul 2026",
        "expected 'Mon 27 Jul 2026', got " + dateLabel("2026-07-27"));
    });

    // cleanup so repeated runs stay stable
    clearProvider(TP);

    return { pass: pass, fail: fail, log: log };
  }

  /* ===================================================================
     register
     =================================================================== */

  HC.registerFeature({
    id: "provider-capacity",
    title: "Set / change capacity per event date",
    side: "provider",
    icon: "🎟️",
    summary: "Set or change the number of spaces on sale for any camp date at any time. Editing a date's capacity instantly changes how many bookable spaces parents see — and you can't drop it below what's already booked.",
    render: render,
    selfTest: selfTest
  });
})();
