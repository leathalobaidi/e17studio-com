/* HolidayCamp feature — provider-cancel-class
 *
 * Cancel / hide / disable / archive a class or date  (provider side)
 *
 * Replicates Happity's "How to cancel, hide or disable bookings for a class or
 * event date" behaviour. Evidence:
 *   - support article 3719394 ("How to cancel, hide or disable bookings for a
 *     class or event date"):
 *       • "There is a bin icon next to every date that hasn't taken any bookings
 *          yet (bin icon will not show on classes with bookings). This will
 *          delete the blank register for that date and it will no longer be on
 *          sale."  →  a DATE can only be deleted when it has NO bookings.
 *       • "You won't be able to remove a class date if there are customers
 *          currently booked into it. These are greyed out … Please cancel any
 *          active bookings first."  →  booked dates are blocked / greyed.
 *       • "Classes that do not have any forthcoming event dates will have a
 *          little … 'archive' icon … Archiving will remove the class from
 *          public display, but the information will stay in your account so that
 *          you can view your historical transactions."  →  a SLOT can be
 *          archived only when it has NO forthcoming (future) dates; archiving is
 *          reversible and keeps history.
 *       • "If you've made a mistake and want to delete this slot permanently …
 *          choose the Delete button … This option will only be available if the
 *          class has never taken any bookings before."  →  permanent slot delete
 *          requires the slot has NEVER taken a booking (across all dates ever).
 *       • "Temporarily disabling sales … Your classes and dates will still be
 *          displayed on Happity … but parents will not be able to book a space.
 *          Simply … select no for booking enabled."  →  disable sales = visible
 *          but unbookable; always allowed.
 *       • "Unpublishing a class from public view … hides your 'weekly slot' …
 *          this class would no longer appear in search results … However you can
 *          still send out your booking links by email … choose 'hidden' … When
 *          you are ready to publish the listing again, just choose 'published'."
 *          →  unpublish/hidden (secret mode) hides from search but booking links
 *          still work; fully reversible.
 *   - support article 6056178 ("How to reschedule or cancel an individual class
 *     with bookings"): to cancel a DATE that has bookings you must first remove
 *     (cancel/reschedule) the bookings from the register; "Once all the bookings
 *     from that register have been removed, you will then be able to cancel the
 *     event."  →  cancelling the last booking on a date unblocks its deletion.
 *
 * Framed for SCHOOL-AGE HOLIDAY CAMPS (not baby classes). A provider runs camp
 * SLOTS (recurring listings, e.g. "Multi-Activity Camp — Mon–Fri 09:00–16:00").
 * Each slot has a publish state, a sales toggle, and a list of dated camp days
 * (event dates), each with a booked count.
 *
 * ACCEPTANCE CRITERION (asserted in selfTest):
 *   A bookings-free date can be deleted; a slot with no future dates can be
 *   archived; classes can be unpublished.
 * We additionally verify the surrounding rules: booked dates can't be deleted
 * (until their bookings are cancelled), permanent slot delete needs zero
 * lifetime bookings, archive needs no forthcoming dates, and unpublish / disable
 * sales are reversible.
 *
 * Self-contained, defensive, no imports/exports. Calls HC.registerFeature.
 */
(function () {
  "use strict";

  // Defensive: never throw at module load if HC isn't present.
  if (typeof window === "undefined" || !window.HC || typeof window.HC.registerFeature !== "function") {
    if (typeof console !== "undefined" && console.warn) {
      console.warn("[HC] provider-cancel-class: HC core not found; skipping registration.");
    }
    return;
  }

  var HC = window.HC;

  // Persisted shape: { <providerId>: { slots: { <slotId>: {...} } } }
  var STORE_KEY = "provider_cancel_class";

  // Publish states (mirror Happity's published / hidden / archived).
  var PUBLISHED = "published"; // live and searchable
  var HIDDEN = "hidden";       // unpublished / secret mode — booking links still work
  var ARCHIVED = "archived";   // removed from public display, kept for history

  /* ===================================================================
     PURE LOGIC (testable, DOM-free)
     =================================================================== */

  function asText(v) {
    return typeof v === "string" ? v : (v == null ? "" : String(v));
  }
  function toInt(v) {
    var n = Number(v);
    if (!isFinite(n)) return 0;
    return Math.floor(n);
  }

  // Strict YYYY-MM-DD validation that also rejects impossible calendar dates.
  function isValidISODate(s) {
    var str = asText(s);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(str)) return false;
    var p = str.split("-");
    var y = Number(p[0]), m = Number(p[1]), d = Number(p[2]);
    if (m < 1 || m > 12 || d < 1 || d > 31) return false;
    var dt = new Date(Date.UTC(y, m - 1, d));
    return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
  }

  // "Today" as an ISO string. A fixed reference can be passed in for
  // deterministic tests; otherwise we use the real clock.
  function todayISO(refISO) {
    if (isValidISODate(refISO)) return refISO;
    try {
      var d = new Date();
      var m = String(d.getMonth() + 1).padStart(2, "0");
      var day = String(d.getDate()).padStart(2, "0");
      return d.getFullYear() + "-" + m + "-" + day;
    } catch (e) {
      return "1970-01-01";
    }
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

  /* ---- Date-level predicates (article 3719394 / 6056178) ---- */

  // A camp date is "forthcoming" if it falls today or later.
  function isForthcoming(date, refISO) {
    return isValidISODate(date) && date >= todayISO(refISO);
  }
  // A date is deletable ONLY when it has zero current bookings (the bin icon).
  function dateBooked(date) {
    return toInt(date && date.booked) > 0;
  }
  function canDeleteDate(date) {
    return !!date && !dateBooked(date);
  }

  /* ---- Slot-level predicates ---- */

  function slotDates(slot) {
    var s = (slot && typeof slot === "object") ? slot : {};
    return Array.isArray(s.dates) ? s.dates : [];
  }
  // Forthcoming dates = future-or-today event dates still on the slot.
  function forthcomingDates(slot, refISO) {
    return slotDates(slot).filter(function (d) { return isForthcoming(d && d.date, refISO); });
  }
  // Lifetime bookings = sum of bookings across EVERY date the slot has ever had,
  // PLUS any historic bookings the slot recorded for dates already cleared.
  // (Happity's "never taken any bookings before" is a lifetime test.)
  function lifetimeBookings(slot) {
    var s = (slot && typeof slot === "object") ? slot : {};
    var fromDates = slotDates(slot).reduce(function (sum, d) { return sum + toInt(d && d.booked); }, 0);
    var historic = toInt(s.historicBookings);
    return fromDates + historic;
  }
  // A genuine slot record is a plain object (not null, not an array, not a
  // primitive). Arrays/garbage are never treatable as a slot.
  function isSlotRecord(slot) {
    return !!slot && typeof slot === "object" && !Array.isArray(slot);
  }
  // Archive is allowed only when the slot has NO forthcoming event dates.
  function canArchiveSlot(slot, refISO) {
    if (!isSlotRecord(slot)) return false;
    if (slot.state === ARCHIVED) return false; // already archived
    return forthcomingDates(slot, refISO).length === 0;
  }
  // Permanent delete is allowed only if the slot has NEVER taken a booking.
  function canDeleteSlot(slot) {
    if (!isSlotRecord(slot)) return false;
    return lifetimeBookings(slot) === 0;
  }

  /* ---- Mutations (each returns { ok, reason?, ... }; never throws) ---- */

  // Delete a single bookings-free date from a slot.
  function deleteDate(slot, dateId, refISO) {
    var s = (slot && typeof slot === "object") ? slot : null;
    if (!s) return { ok: false, reason: "no_slot" };
    var dates = slotDates(s);
    var idx = -1;
    for (var i = 0; i < dates.length; i++) {
      if (dates[i] && asText(dates[i].id) === asText(dateId)) { idx = i; break; }
    }
    if (idx === -1) return { ok: false, reason: "no_such_date" };
    if (!canDeleteDate(dates[idx])) {
      return { ok: false, reason: "has_bookings", booked: toInt(dates[idx].booked) };
    }
    var removed = dates.splice(idx, 1)[0];
    return { ok: true, removed: removed, remaining: dates.length };
  }

  // Cancel ONE booking on a date (mirrors removing a customer from the register).
  // When the last booking is cancelled the date becomes deletable again.
  function cancelBookingOnDate(slot, dateId, n) {
    var dates = slotDates(slot);
    for (var i = 0; i < dates.length; i++) {
      var d = dates[i];
      if (d && asText(d.id) === asText(dateId)) {
        var cur = toInt(d.booked);
        var take = (n == null) ? 1 : toInt(n);
        if (take < 1) take = 1;
        var next = Math.max(0, cur - take);
        // Cancelled bookings still count toward the slot's lifetime history,
        // so a slot that has EVER had a booking can never be permanently deleted.
        if (slot && typeof slot === "object") {
          slot.historicBookings = toInt(slot.historicBookings) + (cur - next);
        }
        d.booked = next;
        return { ok: true, booked: d.booked, deletable: canDeleteDate(d) };
      }
    }
    return { ok: false, reason: "no_such_date" };
  }

  // Archive a slot (only when it has no forthcoming dates). Reversible.
  function archiveSlot(slot, refISO) {
    if (!isSlotRecord(slot)) return { ok: false, reason: "no_slot" };
    if (!canArchiveSlot(slot, refISO)) {
      return { ok: false, reason: "has_forthcoming_dates", forthcoming: forthcomingDates(slot, refISO).length };
    }
    slot.state = ARCHIVED;
    return { ok: true, state: slot.state };
  }
  // Restore an archived slot back to its previous public state (default hidden,
  // so a restored slot isn't accidentally re-listed before the provider checks).
  function unarchiveSlot(slot, toState) {
    if (!slot || typeof slot !== "object") return { ok: false, reason: "no_slot" };
    if (slot.state !== ARCHIVED) return { ok: false, reason: "not_archived" };
    slot.state = (toState === PUBLISHED) ? PUBLISHED : HIDDEN;
    return { ok: true, state: slot.state };
  }

  // Permanently delete a slot (only if it has never taken any bookings).
  function deleteSlot(slot) {
    if (!isSlotRecord(slot)) return { ok: false, reason: "no_slot" };
    if (!canDeleteSlot(slot)) {
      return { ok: false, reason: "has_history", lifetime: lifetimeBookings(slot) };
    }
    return { ok: true, deletedId: asText(slot.id) };
  }

  // Unpublish (hide / secret mode): hide from public search; booking links still
  // work. Reversible via publishSlot. Always allowed (never gated).
  function unpublishSlot(slot) {
    if (!isSlotRecord(slot)) return { ok: false, reason: "no_slot" };
    if (slot.state === ARCHIVED) return { ok: false, reason: "archived" };
    slot.state = HIDDEN;
    return { ok: true, state: slot.state, searchable: false, bookingLinkWorks: true };
  }
  function publishSlot(slot) {
    if (!isSlotRecord(slot)) return { ok: false, reason: "no_slot" };
    if (slot.state === ARCHIVED) return { ok: false, reason: "archived" };
    slot.state = PUBLISHED;
    return { ok: true, state: slot.state, searchable: true };
  }

  // Temporarily disable / enable sales: slot + dates stay visible, but no new
  // bookings can be taken. Always allowed (independent of publish state).
  function setSalesEnabled(slot, enabled) {
    if (!slot || typeof slot !== "object") return { ok: false, reason: "no_slot" };
    slot.salesEnabled = !!enabled;
    return { ok: true, salesEnabled: slot.salesEnabled };
  }

  // Can a parent book this slot right now? (used by the UI/preview only)
  function isBookable(slot, refISO) {
    if (!isSlotRecord(slot)) return false;
    if (slot.state === ARCHIVED) return false;
    if (slot.salesEnabled === false) return false;
    return forthcomingDates(slot, refISO).some(function (d) {
      var cap = toInt(d.capacity);
      return cap === 0 ? true : toInt(d.booked) < cap; // 0 capacity = unspecified, treat as open
    });
  }

  // Is the slot visible in PUBLIC search? Hidden + archived are not.
  function isSearchable(slot) {
    return isSlotRecord(slot) && slot.state === PUBLISHED;
  }

  function safeUid(prefix) {
    try { return HC.util.uid(); }
    catch (e) { return (prefix || "id") + "_" + Date.now() + "_" + Math.floor(Math.random() * 1e6); }
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
    if (!map[pid] || typeof map[pid] !== "object") map[pid] = { slots: {} };
    if (!map[pid].slots || typeof map[pid].slots !== "object") map[pid].slots = {};
    return map[pid];
  }

  function normaliseDate(d) {
    var a = (d && typeof d === "object") ? d : {};
    return {
      id: asText(a.id) || safeUid("date"),
      date: asText(a.date),
      capacity: toInt(a.capacity),
      booked: toInt(a.booked)
    };
  }
  function normaliseSlot(input) {
    var a = (input && typeof input === "object") ? input : {};
    var state = (a.state === HIDDEN || a.state === ARCHIVED) ? a.state : PUBLISHED;
    return {
      id: asText(a.id) || safeUid("slot"),
      title: asText(a.title) || "Untitled camp",
      venue: asText(a.venue) || "",
      pattern: asText(a.pattern) || "",
      state: state,
      salesEnabled: a.salesEnabled === false ? false : true,
      historicBookings: toInt(a.historicBookings),
      dates: Array.isArray(a.dates) ? a.dates.map(normaliseDate) : []
    };
  }

  function upsertSlot(providerId, input) {
    var map = readAll();
    var b = providerBucket(map, providerId);
    var slot = normaliseSlot(input);
    b.slots[slot.id] = slot;
    writeAll(map);
    return slot;
  }
  function getSlot(providerId, slotId) {
    var b = providerBucket(readAll(), providerId);
    var s = b.slots[asText(slotId)];
    return s ? normaliseSlot(s) : null;
  }
  function getAllSlots(providerId) {
    var b = providerBucket(readAll(), providerId);
    return Object.keys(b.slots).map(function (k) { return normaliseSlot(b.slots[k]); });
  }
  function saveSlot(providerId, slot) {
    var map = readAll();
    var b = providerBucket(map, providerId);
    var s = normaliseSlot(slot);
    b.slots[s.id] = s;
    writeAll(map);
    return s;
  }
  function removeSlot(providerId, slotId) {
    var map = readAll();
    var b = providerBucket(map, providerId);
    delete b.slots[asText(slotId)];
    writeAll(map);
  }
  function clearProvider(providerId) {
    var map = readAll();
    delete map[asText(providerId) || "_default"];
    writeAll(map);
  }

  /* ---- Persisted wrappers around the pure mutations ---- */

  function persistedDeleteDate(providerId, slotId, dateId, refISO) {
    var slot = getSlot(providerId, slotId);
    if (!slot) return { ok: false, reason: "no_slot" };
    var res = deleteDate(slot, dateId, refISO);
    if (res.ok) saveSlot(providerId, slot);
    return res;
  }
  function persistedCancelBooking(providerId, slotId, dateId, n) {
    var slot = getSlot(providerId, slotId);
    if (!slot) return { ok: false, reason: "no_slot" };
    var res = cancelBookingOnDate(slot, dateId, n);
    if (res.ok) saveSlot(providerId, slot);
    return res;
  }
  function persistedArchive(providerId, slotId, refISO) {
    var slot = getSlot(providerId, slotId);
    if (!slot) return { ok: false, reason: "no_slot" };
    var res = archiveSlot(slot, refISO);
    if (res.ok) saveSlot(providerId, slot);
    return res;
  }
  function persistedSetState(providerId, slotId, op) {
    var slot = getSlot(providerId, slotId);
    if (!slot) return { ok: false, reason: "no_slot" };
    var res;
    if (op === "publish") res = publishSlot(slot);
    else if (op === "unpublish") res = unpublishSlot(slot);
    else if (op === "unarchive") res = unarchiveSlot(slot);
    else return { ok: false, reason: "bad_op" };
    if (res.ok) saveSlot(providerId, slot);
    return res;
  }
  function persistedSetSales(providerId, slotId, enabled) {
    var slot = getSlot(providerId, slotId);
    if (!slot) return { ok: false, reason: "no_slot" };
    var res = setSalesEnabled(slot, enabled);
    if (res.ok) saveSlot(providerId, slot);
    return res;
  }
  function persistedDeleteSlot(providerId, slotId) {
    var slot = getSlot(providerId, slotId);
    if (!slot) return { ok: false, reason: "no_slot" };
    var res = deleteSlot(slot);
    if (res.ok) removeSlot(providerId, slotId);
    return res;
  }

  /* ===================================================================
     DEMO SEEDING (uses live planner dates where available)
     =================================================================== */

  function demoProviderId() {
    try {
      var ps = HC.data.providers;
      if (ps && ps.length && ps[0] && ps[0].id) return "cancel_demo__" + ps[0].id;
    } catch (e) {}
    return "cancel_demo__provider";
  }

  // Pull two real summer-holiday Mondays from the live planner where possible so
  // the demo dates line up with the actual E17 holiday weeks.
  function plannerMondays() {
    var out = [];
    try {
      var weeks = (HC.data.planner && HC.data.planner.weeks) || [];
      for (var i = 0; i < weeks.length && out.length < 3; i++) {
        if (weeks[i] && isValidISODate(weeks[i].mon)) out.push(weeks[i].mon);
      }
    } catch (e) {}
    while (out.length < 3) out.push("2099-08-0" + (out.length + 1)); // far-future fallback
    return out;
  }

  function seedDemo(providerId) {
    var mons = plannerMondays();
    // Slot 1: live, has a future bookings-free date AND a future booked date.
    upsertSlot(providerId, {
      id: "slot-multi",
      title: "Multi-Activity Summer Camp",
      venue: "St Mary's Hall, Walthamstow",
      pattern: "Mon–Fri · 09:00–16:00",
      state: PUBLISHED,
      salesEnabled: true,
      dates: [
        { id: "d-free", date: mons[0], capacity: 24, booked: 0 },   // deletable (bin icon)
        { id: "d-booked", date: mons[1], capacity: 24, booked: 7 }  // greyed — has bookings
      ]
    });
    // Slot 2: a finished slot with no forthcoming dates but past bookings →
    // archivable, NOT permanently deletable.
    upsertSlot(providerId, {
      id: "slot-easter",
      title: "Easter Sports Camp (finished)",
      venue: "Leyton Sports Ground",
      pattern: "Mon–Fri · 10:00–15:00",
      state: PUBLISHED,
      salesEnabled: true,
      dates: [
        { id: "d-past", date: "2026-04-07", capacity: 20, booked: 12 } // past + booked
      ]
    });
    // Slot 3: a brand-new slot that has never taken a booking → permanently
    // deletable. No forthcoming dates either, so also archivable.
    upsertSlot(providerId, {
      id: "slot-draft",
      title: "Coding Camp (draft — never sold)",
      venue: "Online / Walthamstow Library",
      pattern: "Tue–Thu · 13:00–16:00",
      state: HIDDEN,
      salesEnabled: true,
      dates: []
    });
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

  function stateBadge(slot) {
    var state = slot.state;
    var map = {
      published: { bg: "#E1F0E4", fg: "#2f7d4f", icon: "🟢", label: "Published" },
      hidden: { bg: "#FCEFD9", fg: "#9a5a1f", icon: "🙈", label: "Hidden (secret)" },
      archived: { bg: "#EDEDED", fg: "#666", icon: "📦", label: "Archived" }
    };
    var m = map[state] || map.published;
    return '<span style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.3px;' +
      'padding:2px 8px;border-radius:999px;background:' + m.bg + ';color:' + m.fg + '">' +
      m.icon + " " + m.label + "</span>";
  }

  function dateRowHtml(providerId, slot, d, refISO) {
    var booked = toInt(d.booked);
    var deletable = canDeleteDate(d);
    var forth = isForthcoming(d.date, refISO);
    var lbl = dateLabel(d.date) || esc(d.date) || "(no date)";
    return '<div style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--line,#E6E6E6);font-size:13px' +
        (deletable ? "" : ";opacity:.6") + '">' +
      '<span style="flex:1">' + esc(lbl) + (forth ? "" : ' <span style="color:var(--muted,#808080)">(past)</span>') + "</span>" +
      '<span style="color:' + (booked ? "#9a1f5e" : "var(--muted,#808080)") + '">' +
        booked + " booked</span>" +
      (deletable
        ? '<button class="hc-btn hc-btn-ghost" type="button" data-del-date="' + escAttr(d.id) +
            '" data-slot="' + escAttr(slot.id) + '" title="Delete this bookings-free date">🗑️ Delete</button>'
        : '<button class="hc-btn hc-btn-ghost" type="button" data-cancel-book="' + escAttr(d.id) +
            '" data-slot="' + escAttr(slot.id) + '" title="Cancel a booking to unlock deletion">Cancel a booking</button>') +
      "</div>";
  }

  function slotCardHtml(providerId, slot, refISO) {
    var forth = forthcomingDates(slot, refISO).length;
    var archivable = canArchiveSlot(slot, refISO);
    var deletable = canDeleteSlot(slot);
    var lifetime = lifetimeBookings(slot);
    var isArch = slot.state === ARCHIVED;
    var datesHtml = slot.dates.length
      ? slot.dates.map(function (d) { return dateRowHtml(providerId, slot, d, refISO); }).join("")
      : '<div style="font-size:12.5px;color:var(--muted,#808080);padding:6px 0">No dates on this slot.</div>';

    var actions = [];
    // Publish / unpublish (not for archived).
    if (!isArch) {
      if (slot.state === PUBLISHED) {
        actions.push('<button class="hc-btn hc-btn-ghost" type="button" data-unpublish="' + escAttr(slot.id) +
          '" title="Hide from public search; booking links still work">🙈 Unpublish</button>');
      } else {
        actions.push('<button class="hc-btn" type="button" data-publish="' + escAttr(slot.id) +
          '" title="Show in public search again">🟢 Publish</button>');
      }
      // Disable / enable sales.
      actions.push('<button class="hc-btn hc-btn-ghost" type="button" data-sales="' + escAttr(slot.id) +
        '">' + (slot.salesEnabled === false ? "Enable sales" : "Disable sales") + "</button>");
      // Archive (gated on no forthcoming dates).
      actions.push('<button class="hc-btn hc-btn-ghost" type="button" data-archive="' + escAttr(slot.id) + '"' +
        (archivable ? "" : ' disabled style="opacity:.5;cursor:not-allowed"') +
        ' title="' + (archivable ? "Archive: hide but keep history" : "Has forthcoming dates — cancel/clear them first") + '">📦 Archive</button>');
    } else {
      actions.push('<button class="hc-btn" type="button" data-unarchive="' + escAttr(slot.id) +
        '" title="Restore from archive (as hidden)">↩️ Restore</button>');
    }
    // Permanent delete (gated on zero lifetime bookings).
    actions.push('<button class="hc-btn hc-btn-ghost" type="button" data-del-slot="' + escAttr(slot.id) + '"' +
      (deletable ? "" : ' disabled style="opacity:.5;cursor:not-allowed"') +
      ' title="' + (deletable ? "Delete permanently (never sold)" : "Can't delete — slot has taken " + lifetime + " booking(s) in its history") + '">🗑️ Delete slot</button>');

    return '<div class="hc-fcard" data-slot-card="' + escAttr(slot.id) + '" style="gap:8px">' +
      '<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap">' +
        '<div>' +
          '<div style="font-family:Quicksand,system-ui,sans-serif;font-weight:700;color:var(--purple,#603488);font-size:16px">' +
            esc(slot.title) + "</div>" +
          '<div style="font-size:12px;color:var(--muted,#808080)">' +
            esc(slot.pattern || "") + (slot.venue ? " · " + esc(slot.venue) : "") + "</div>" +
        "</div>" +
        stateBadge(slot) +
      "</div>" +
      '<div style="font-size:11.5px;color:var(--muted,#808080)">' +
        forth + " forthcoming date" + (forth === 1 ? "" : "s") + " · " +
        lifetime + " lifetime booking" + (lifetime === 1 ? "" : "s") + " · " +
        "sales " + (slot.salesEnabled === false ? "OFF" : "ON") + "</div>" +
      '<div style="margin:2px 0">' + datesHtml + "</div>" +
      '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:4px">' + actions.join("") + "</div>" +
    "</div>";
  }

  function render(mountEl) {
    try {
      if (!mountEl) return;
      var providerId = demoProviderId();
      var refISO = todayISO(); // live "today" for the preview
      clearProvider(providerId);
      seedDemo(providerId);
      mountEl.innerHTML = "";

      var intro = el("div", null,
        '<p style="font-size:14px;color:var(--text,#383838);margin:0 0 4px">' +
          "Take a camp down the Happity way. A <strong>bookings-free date</strong> can be deleted (🗑️); a " +
          "<strong>booked date</strong> is locked until you cancel its bookings; a slot with " +
          "<strong>no forthcoming dates</strong> can be <strong>archived</strong> (hidden but kept for your records); " +
          "and any live slot can be <strong>unpublished</strong> (secret mode — booking links still work).</p>" +
        '<p style="font-size:12.5px;color:var(--muted,#808080);margin:0 0 10px">' +
          "Permanent slot deletion is only offered when a slot has <em>never</em> taken a booking. " +
          "Disabling sales keeps the listing visible but stops new bookings.</p>");
      mountEl.appendChild(intro);

      var listHost = el("div", { id: "ccListHost", class: "hc-cards" });
      mountEl.appendChild(listHost);

      function refresh() {
        var slots = getAllSlots(providerId);
        listHost.innerHTML = slots.map(function (s) { return slotCardHtml(providerId, s, refISO); }).join("");
        if (!slots.length) listHost.innerHTML = '<p style="color:var(--muted,#808080)">No camp slots — they may all have been deleted.</p>';
      }
      refresh();

      function toast(msg) { try { HC.util.toast(msg); } catch (e) {} }

      listHost.addEventListener("click", function (e) {
        var t = e.target && e.target.closest ? e.target : null;
        if (!t || !t.closest) return;
        var b;

        if ((b = t.closest("[data-del-date]"))) {
          var res = persistedDeleteDate(providerId, b.getAttribute("data-slot"), b.getAttribute("data-del-date"), refISO);
          toast(res.ok ? "Date deleted — no longer on sale" : "Can't delete: that date has bookings");
          refresh(); return;
        }
        if ((b = t.closest("[data-cancel-book]"))) {
          var r2 = persistedCancelBooking(providerId, b.getAttribute("data-slot"), b.getAttribute("data-cancel-book"), 1);
          toast(r2.ok ? (r2.deletable ? "Last booking cancelled — date can now be deleted" : "Booking cancelled") : "Couldn't cancel booking");
          refresh(); return;
        }
        if ((b = t.closest("[data-archive]"))) {
          if (b.disabled) return;
          var r3 = persistedArchive(providerId, b.getAttribute("data-archive"), refISO);
          toast(r3.ok ? "Slot archived — hidden but kept for your records" : "Can't archive: it still has forthcoming dates");
          refresh(); return;
        }
        if ((b = t.closest("[data-unarchive]"))) {
          var r4 = persistedSetState(providerId, b.getAttribute("data-unarchive"), "unarchive");
          toast(r4.ok ? "Restored from archive (now hidden)" : "Couldn't restore");
          refresh(); return;
        }
        if ((b = t.closest("[data-unpublish]"))) {
          var r5 = persistedSetState(providerId, b.getAttribute("data-unpublish"), "unpublish");
          toast(r5.ok ? "Unpublished — hidden from search; booking links still work" : "Couldn't unpublish");
          refresh(); return;
        }
        if ((b = t.closest("[data-publish]"))) {
          var r6 = persistedSetState(providerId, b.getAttribute("data-publish"), "publish");
          toast(r6.ok ? "Published — now visible in search" : "Couldn't publish");
          refresh(); return;
        }
        if ((b = t.closest("[data-sales]"))) {
          var cur = getSlot(providerId, b.getAttribute("data-sales"));
          var want = !(cur && cur.salesEnabled === false) ? false : true; // toggle
          var r7 = persistedSetSales(providerId, b.getAttribute("data-sales"), want);
          toast(r7.ok ? (r7.salesEnabled ? "Sales enabled" : "Sales disabled — still visible, no new bookings") : "Couldn't change sales");
          refresh(); return;
        }
        if ((b = t.closest("[data-del-slot]"))) {
          if (b.disabled) return;
          var r8 = persistedDeleteSlot(providerId, b.getAttribute("data-del-slot"));
          toast(r8.ok ? "Slot permanently deleted" : "Can't delete: slot has booking history — archive it instead");
          refresh(); return;
        }
      });
    } catch (e) {
      try {
        mountEl.innerHTML = '<p style="color:#9a1f5e">Cancel-class feature failed to render: ' +
          esc(e && e.message ? e.message : String(e)) + "</p>";
      } catch (e2) { /* give up quietly */ }
    }
  }

  /* ===================================================================
     selfTest — exercises the LOGIC and asserts the acceptance criterion
     =================================================================== */

  function selfTest() {
    var pass = 0, fail = 0, log = [];
    function check(label, fn) {
      try { fn(); pass += 1; log.push("✓ " + label); }
      catch (e) { fail += 1; log.push("✗ " + label + " — " + (e && e.message ? e.message : String(e))); }
    }

    var REF = "2026-07-01";    // fixed "today"
    var FUTURE = "2026-08-10"; // forthcoming relative to REF
    var PAST = "2026-04-07";   // already gone relative to REF

    function freshSlot(overrides) {
      var base = {
        id: "s1",
        title: "Multi-Activity Camp",
        state: PUBLISHED,
        salesEnabled: true,
        dates: [
          { id: "d-free", date: FUTURE, capacity: 24, booked: 0 },
          { id: "d-booked", date: FUTURE, capacity: 24, booked: 7 }
        ]
      };
      if (overrides) for (var k in overrides) if (Object.prototype.hasOwnProperty.call(overrides, k)) base[k] = overrides[k];
      return normaliseSlot(base);
    }

    /* ===== ACCEPTANCE CRITERION 1 — a bookings-free date CAN be deleted ===== */

    check("ACCEPTANCE: a bookings-free date can be deleted", function () {
      var s = freshSlot();
      HC.assert(canDeleteDate(s.dates[0]) === true, "the 0-booking date should be deletable");
      var res = deleteDate(s, "d-free", REF);
      HC.assert(res.ok === true, "delete should succeed for a bookings-free date");
      HC.assert(s.dates.length === 1, "the free date should be removed (1 left)");
      HC.assert(!s.dates.some(function (d) { return d.id === "d-free"; }), "d-free should be gone");
    });

    check("A date WITH bookings cannot be deleted (greyed-out / bin hidden)", function () {
      var s = freshSlot();
      HC.assert(canDeleteDate(s.dates[1]) === false, "a booked date must not be deletable");
      var res = deleteDate(s, "d-booked", REF);
      HC.assert(res.ok === false, "delete must be refused for a booked date");
      HC.assert(res.reason === "has_bookings", "reason should be has_bookings");
      HC.assert(s.dates.length === 2, "no date should have been removed");
    });

    check("Cancelling the last booking unlocks deletion of that date", function () {
      // mirrors article 6056178: remove bookings from the register, THEN delete
      var s = freshSlot({ dates: [{ id: "d1", date: FUTURE, capacity: 10, booked: 2 }] });
      HC.assert(deleteDate(s, "d1", REF).ok === false, "blocked while 2 booked");
      cancelBookingOnDate(s, "d1", 1);
      HC.assert(deleteDate(s, "d1", REF).ok === false, "still blocked while 1 booked");
      cancelBookingOnDate(s, "d1", 1);
      HC.assert(canDeleteDate(s.dates[0]) === true, "now zero booked — deletable");
      var res = deleteDate(s, "d1", REF);
      HC.assert(res.ok === true, "delete succeeds once all bookings cancelled");
      HC.assert(s.dates.length === 0, "date removed");
    });

    /* ===== ACCEPTANCE CRITERION 2 — a slot with no future dates CAN be archived ===== */

    check("ACCEPTANCE: a slot with no forthcoming dates can be archived", function () {
      // only past dates remain -> archivable
      var s = freshSlot({ dates: [{ id: "p1", date: PAST, capacity: 20, booked: 12 }] });
      HC.assert(forthcomingDates(s, REF).length === 0, "no forthcoming dates");
      HC.assert(canArchiveSlot(s, REF) === true, "slot should be archivable");
      var res = archiveSlot(s, REF);
      HC.assert(res.ok === true, "archive should succeed");
      HC.assert(s.state === ARCHIVED, "slot state should be archived");
    });

    check("A slot WITH a forthcoming date cannot be archived", function () {
      var s = freshSlot(); // has FUTURE dates
      HC.assert(forthcomingDates(s, REF).length > 0, "has forthcoming dates");
      HC.assert(canArchiveSlot(s, REF) === false, "must not be archivable");
      var res = archiveSlot(s, REF);
      HC.assert(res.ok === false, "archive must be refused");
      HC.assert(res.reason === "has_forthcoming_dates", "reason should explain why");
      HC.assert(s.state === PUBLISHED, "state unchanged");
    });

    check("Archiving keeps history and is reversible", function () {
      var s = freshSlot({ dates: [{ id: "p1", date: PAST, capacity: 20, booked: 8 }] });
      archiveSlot(s, REF);
      HC.assert(s.state === ARCHIVED, "archived");
      // history preserved: lifetime bookings still counted
      HC.assert(lifetimeBookings(s) === 8, "archived slot keeps its booking history");
      var un = unarchiveSlot(s);
      HC.assert(un.ok === true, "restore should work");
      HC.assert(s.state === HIDDEN, "restores as hidden (not auto-relisted)");
    });

    /* ===== ACCEPTANCE CRITERION 3 — classes can be unpublished ===== */

    check("ACCEPTANCE: a class can be unpublished (hidden / secret mode)", function () {
      var s = freshSlot();
      HC.assert(isSearchable(s) === true, "published slot is searchable");
      var res = unpublishSlot(s);
      HC.assert(res.ok === true, "unpublish should succeed");
      HC.assert(s.state === HIDDEN, "state should be hidden");
      HC.assert(isSearchable(s) === false, "hidden slot is NOT in public search");
      HC.assert(res.bookingLinkWorks === true, "booking links still work when hidden");
    });

    check("Unpublish is reversible — publish brings it back to search", function () {
      var s = freshSlot();
      unpublishSlot(s);
      HC.assert(isSearchable(s) === false, "hidden");
      var res = publishSlot(s);
      HC.assert(res.ok === true, "publish should succeed");
      HC.assert(s.state === PUBLISHED, "back to published");
      HC.assert(isSearchable(s) === true, "searchable again");
    });

    check("Unpublish does not change whether a date has bookings", function () {
      var s = freshSlot();
      var bookedBefore = s.dates[1].booked;
      unpublishSlot(s);
      HC.assert(s.dates[1].booked === bookedBefore, "bookings untouched by unpublish");
    });

    /* ===== Permanent slot delete (only if never sold) ===== */

    check("Permanent delete is allowed only when never sold", function () {
      var neverSold = freshSlot({ dates: [{ id: "d1", date: FUTURE, capacity: 10, booked: 0 }] });
      HC.assert(canDeleteSlot(neverSold) === true, "a never-sold slot is permanently deletable");
      HC.assert(deleteSlot(neverSold).ok === true, "delete should succeed");

      var hasSold = freshSlot(); // d-booked has 7
      HC.assert(canDeleteSlot(hasSold) === false, "a slot with bookings must not be deletable");
      var res = deleteSlot(hasSold);
      HC.assert(res.ok === false, "delete must be refused");
      HC.assert(res.reason === "has_history", "reason should be has_history");
    });

    check("Cancelled bookings still count as lifetime history (no permanent delete)", function () {
      // a slot that sold then refunded everyone must STILL be non-deletable
      var s = freshSlot({ dates: [{ id: "d1", date: FUTURE, capacity: 10, booked: 3 }] });
      cancelBookingOnDate(s, "d1", 3); // refund all three
      HC.assert(s.dates[0].booked === 0, "no live bookings");
      HC.assert(lifetimeBookings(s) === 3, "but lifetime history records the 3");
      HC.assert(canDeleteSlot(s) === false, "still not permanently deletable");
      // it can, however, be archived (no forthcoming-with-bookings constraint;
      // a future empty date still blocks archive though)
      var past = freshSlot({ dates: [{ id: "d1", date: PAST, capacity: 10, booked: 3 }] });
      cancelBookingOnDate(past, "d1", 3);
      HC.assert(canArchiveSlot(past, REF) === true, "no forthcoming dates -> archivable");
    });

    /* ===== Temporarily disable sales (visible but unbookable) ===== */

    check("Disabling sales keeps the slot visible but unbookable", function () {
      var s = freshSlot();
      HC.assert(isBookable(s, REF) === true, "bookable to start");
      HC.assert(isSearchable(s) === true, "and visible to start");
      var res = setSalesEnabled(s, false);
      HC.assert(res.ok === true && s.salesEnabled === false, "sales now off");
      HC.assert(isBookable(s, REF) === false, "no longer bookable");
      HC.assert(isSearchable(s) === true, "STILL visible in search (sales-off, not hidden)");
      setSalesEnabled(s, true);
      HC.assert(isBookable(s, REF) === true, "re-enabling sales makes it bookable again");
    });

    /* ===== Persisted end-to-end path (store-backed) ===== */

    var TP = "__selftest_cancel__";
    clearProvider(TP);

    check("End-to-end via the persisted store", function () {
      upsertSlot(TP, {
        id: "X", title: "Camp X", state: PUBLISHED, salesEnabled: true,
        dates: [
          { id: "xf", date: FUTURE, capacity: 20, booked: 0 },   // deletable
          { id: "xb", date: FUTURE, capacity: 20, booked: 4 }    // booked
        ]
      });
      // delete the free date
      var d1 = persistedDeleteDate(TP, "X", "xf", REF);
      HC.assert(d1.ok === true, "free date deleted via store");
      HC.assert(getSlot(TP, "X").dates.length === 1, "one date left in store");
      // can't archive yet — still has a forthcoming booked date
      HC.assert(persistedArchive(TP, "X", REF).ok === false, "archive blocked while forthcoming date remains");
      // unpublish works regardless
      HC.assert(persistedSetState(TP, "X", "unpublish").ok === true, "unpublish via store");
      HC.assert(getSlot(TP, "X").state === HIDDEN, "persisted as hidden");
      // cancel the remaining bookings, delete that date, THEN archive
      persistedCancelBooking(TP, "X", "xb", 4);
      HC.assert(persistedDeleteDate(TP, "X", "xb", REF).ok === true, "booked date deletable after cancelling");
      HC.assert(getSlot(TP, "X").dates.length === 0, "no dates left");
      var a = persistedArchive(TP, "X", REF);
      HC.assert(a.ok === true, "now archivable — no forthcoming dates");
      HC.assert(getSlot(TP, "X").state === ARCHIVED, "persisted as archived");
      // permanent delete still blocked (it sold before)
      HC.assert(getSlot(TP, "X").historicBookings === 4, "store kept lifetime history");
    });

    check("Persisted permanent delete removes a never-sold slot", function () {
      upsertSlot(TP, {
        id: "Y", title: "Camp Y (never sold)", state: HIDDEN, salesEnabled: true,
        dates: [{ id: "y1", date: FUTURE, capacity: 10, booked: 0 }]
      });
      HC.assert(getSlot(TP, "Y") !== null, "Y exists");
      var res = persistedDeleteSlot(TP, "Y");
      HC.assert(res.ok === true, "never-sold slot deletes from store");
      HC.assert(getSlot(TP, "Y") === null, "Y removed from store");
    });

    /* ===== Defensive: garbage never throws ===== */

    check("Non-slot garbage is rejected by every gate without throwing", function () {
      // These are NOT slot records (null/undefined/primitives/arrays): every
      // gate and mutation must refuse them and none may throw.
      var notSlots = [null, undefined, 42, "", true, [], [null, 7]];
      for (var i = 0; i < notSlots.length; i++) {
        HC.assert(canArchiveSlot(notSlots[i], REF) === false, "non-slot #" + i + " not archivable");
        HC.assert(canDeleteSlot(notSlots[i]) === false, "non-slot #" + i + " not permanently deletable");
        HC.assert(deleteSlot(notSlots[i]).ok === false, "non-slot #" + i + " deleteSlot refused");
        HC.assert(deleteDate(notSlots[i], "z", REF).ok === false, "non-slot #" + i + " deleteDate refused");
        HC.assert(archiveSlot(notSlots[i], REF).ok === false, "non-slot #" + i + " archive refused");
        HC.assert(unpublishSlot(notSlots[i]).ok === false, "non-slot #" + i + " unpublish refused");
        HC.assert(isBookable(notSlots[i], REF) === false, "non-slot #" + i + " not bookable");
        HC.assert(isSearchable(notSlots[i]) === false, "non-slot #" + i + " not searchable");
      }
    });

    check("Malformed-but-object slots are coerced safely (never throw)", function () {
      // These ARE objects, so they count as (empty/degenerate) slot records.
      // The logic must not throw and must treat missing fields as empty.
      var weird = [{}, { dates: "x" }, { dates: [null, 7] }, { state: "bogus", dates: null }];
      for (var i = 0; i < weird.length; i++) {
        // no forthcoming dates on any of these -> archivable, and never sold -> deletable
        HC.assert(forthcomingDates(weird[i], REF).length === 0, "weird #" + i + " has no forthcoming dates");
        HC.assert(lifetimeBookings(weird[i]) === 0, "weird #" + i + " has no lifetime bookings");
        HC.assert(canArchiveSlot(weird[i], REF) === true, "weird #" + i + " (empty) is archivable");
        HC.assert(deleteDate(weird[i], "nope", REF).ok === false, "weird #" + i + " unknown date refused");
        HC.assert(isBookable(weird[i], REF) === false, "weird #" + i + " not bookable (no dates)");
      }
    });

    // cleanup so repeated runs stay stable
    clearProvider(TP);

    return { pass: pass, fail: fail, log: log };
  }

  /* ===================================================================
     register
     =================================================================== */

  HC.registerFeature({
    id: "provider-cancel-class",
    title: "Cancel / hide / archive a class or date",
    side: "provider",
    icon: "🗑️",
    summary: "Take a camp down the Happity way: delete a bookings-free date (a booked date is locked until you cancel its bookings), archive a slot that has no forthcoming dates (hidden but kept for your records), unpublish a class into secret mode (booking links still work), or temporarily disable sales. Permanent deletion only when a slot has never sold.",
    render: render,
    selfTest: selfTest
  });
})();
