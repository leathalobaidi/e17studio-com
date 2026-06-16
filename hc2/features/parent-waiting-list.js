/* HolidayCamp feature: parent-waiting-list
 * ------------------------------------------------------------------
 * Replicates Happity's "join the waiting list for a full class"
 * behaviour, reframed for SCHOOL-AGE HOLIDAY CAMPS (a full-week or
 * day place on a specific summer-holiday week).
 *
 * Evidence (Happity support corpus):
 *  - 15445271 "How to use the waiting list feature":
 *      "When a class is full, parents can add themselves to the
 *       waiting list. The moment a space opens up — whether you've
 *       added capacity or a booking has been cancelled — everyone on
 *       the waitlist gets an email at the same time and it's first
 *       come, first served."
 *      - A parent joins the waitlist -> the PROVIDER gets a notification.
 *      - When a space opens, EVERYONE waiting is emailed simultaneously.
 *      - Parents can remove themselves at any time via the email link.
 *  - 8255720 (parent FAQ): the parent-facing question "Can I join a
 *      waiting list for a class?" — this module is the parent side.
 *
 * Acceptance criterion (asserted in selfTest):
 *   When a camp week is FULL a 'Join waitlist' option appears; the
 *   parent is ADDED to the list and is EMAILED when a space opens.
 *
 * Faithful behaviours modelled:
 *  - Waitlist option only appears when the week has 0 spaces left.
 *  - Joining records the parent (position in queue, contact, child).
 *  - Joining notifies the provider (a queued provider notification).
 *  - A duplicate join (same email + week) does NOT create a second
 *    entry — it returns the existing position.
 *  - When a space opens (cancellation OR added capacity) EVERY waiting
 *    parent is emailed at once ("notified" flag set, sent timestamp),
 *    first-come-first-served (queue order preserved).
 *  - A parent can remove themselves at any time.
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

  var STORE_KEY = "waitlist_v1"; // { "<campId>::<weekId>": { entries:[...], notices:[...] } }

  /* ============================================================
   * 1. Capacity model.
   *
   * The live planner data has no per-week capacity field, so we
   * derive a deterministic capacity + booked count per camp+week
   * (same inputs always give the same answer — tests are stable).
   * A camp+week is FULL when spacesLeft === 0. Providers can also
   * mark a week full / open it up; that override lives in the store.
   * ============================================================ */

  // Small deterministic hash so derived numbers are stable per key.
  function hash(str) {
    var h = 2166136261;
    var s = String(str == null ? "" : str);
    for (var i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = (h * 16777619) >>> 0;
    }
    return h >>> 0;
  }

  // Base capacity + booked derived from the key. Roughly 1 in 3 weeks
  // come out full so the "Join waitlist" path is reachable in the demo.
  function baseCapacity(key) {
    var h = hash(key);
    var capacity = 12 + (h % 13);          // 12..24 places
    var booked = capacity - (h % 4);       // 0..3 spaces left, often 0
    if (booked > capacity) booked = capacity;
    if (booked < 0) booked = 0;
    return { capacity: capacity, booked: booked };
  }

  function keyOf(campId, weekId) {
    return String(campId) + "::" + String(weekId);
  }

  /* Read the persisted record for a camp+week (entries + provider notices). */
  function readRecord(campId, weekId) {
    var all = {};
    try { all = HC.store.get(STORE_KEY, {}) || {}; } catch (e) { all = {}; }
    var rec = all[keyOf(campId, weekId)] || {};
    return {
      entries: Array.isArray(rec.entries) ? rec.entries : [],
      notices: Array.isArray(rec.notices) ? rec.notices : [],
      capacityAdjust: Number(rec.capacityAdjust) || 0, // provider-added places
      cancellations: Number(rec.cancellations) || 0    // booked places freed
    };
  }

  function writeRecord(campId, weekId, rec) {
    var all = {};
    try { all = HC.store.get(STORE_KEY, {}) || {}; } catch (e) { all = {}; }
    all[keyOf(campId, weekId)] = rec;
    try { return HC.store.set(STORE_KEY, all); } catch (e) { return false; }
  }

  /* Live spaces-left, factoring provider adjustments + cancellations. */
  function spacesLeft(campId, weekId) {
    var base = baseCapacity(keyOf(campId, weekId));
    var rec = readRecord(campId, weekId);
    var capacity = base.capacity + rec.capacityAdjust;
    var booked = base.booked - rec.cancellations;
    if (booked < 0) booked = 0;
    var left = capacity - booked;
    return left < 0 ? 0 : left;
  }

  function isFull(campId, weekId) {
    return spacesLeft(campId, weekId) <= 0;
  }

  /* ============================================================
   * 2. Waitlist logic (the heart of the feature; selfTest hits this).
   * ============================================================ */

  function normEmail(raw) {
    return String(raw == null ? "" : raw).trim().toLowerCase();
  }
  function validEmail(email) {
    var e = normEmail(email);
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
  }

  /* Join the waiting list for a FULL camp+week.
   * Returns a result object — never throws.
   *   ok:true  -> { ok, position, total, alreadyOn, entry, providerNotified, message }
   *   ok:false -> { ok, reason, message }
   */
  function joinWaitlist(campId, weekId, parent) {
    parent = parent || {};
    if (campId == null || weekId == null) {
      return { ok: false, reason: "no-camp", message: "Pick a camp and week first." };
    }
    if (!validEmail(parent.email)) {
      return { ok: false, reason: "bad-email", message: "Enter a valid email so we can let you know when a space opens." };
    }
    // The 'Join waitlist' option only exists when the week is FULL.
    if (!isFull(campId, weekId)) {
      return { ok: false, reason: "not-full", message: "This week still has spaces — you can book it now." };
    }

    var rec = readRecord(campId, weekId);
    var email = normEmail(parent.email);

    // Duplicate join: same email + week returns the existing position.
    for (var i = 0; i < rec.entries.length; i++) {
      if (normEmail(rec.entries[i].email) === email) {
        return {
          ok: true,
          alreadyOn: true,
          position: i + 1,
          total: rec.entries.length,
          entry: rec.entries[i],
          providerNotified: false,
          message: "You're already on the waitlist — position " + (i + 1) + " of " + rec.entries.length + "."
        };
      }
    }

    var entry = {
      id: HC.util.uid(),
      email: email,
      parentName: String(parent.parentName || "").trim(),
      childName: String(parent.childName || "").trim(),
      joinedAt: Date.now(),
      notified: false,     // set true when a space opens and we email them
      notifiedAt: null
    };
    rec.entries.push(entry);

    // Joining notifies the PROVIDER (queued provider notification).
    rec.notices.push({
      id: HC.util.uid(),
      type: "join",
      to: "provider",
      email: email,
      at: Date.now()
    });

    writeRecord(campId, weekId, rec);

    return {
      ok: true,
      alreadyOn: false,
      position: rec.entries.length,           // first come, first served order
      total: rec.entries.length,
      entry: entry,
      providerNotified: true,
      message: "Added to the waitlist — you're position " + rec.entries.length + ". We'll email " + email + " the moment a space opens."
    };
  }

  /* Open up N spaces (provider added capacity, or a booking cancelled).
   * Per the evidence: EVERYONE on the waitlist is emailed at the same
   * time — first come, first served. Returns who was emailed.
   *   { ok, spaces, emailed:[...], firstComeFirstServed:true }
   */
  function openSpaces(campId, weekId, count, reason) {
    var n = Math.max(1, Math.floor(Number(count) || 1));
    var rec = readRecord(campId, weekId);

    // Reflect the freed places in the live capacity model.
    if (reason === "capacity") rec.capacityAdjust += n;
    else rec.cancellations += n; // default: a cancellation freed a place

    var sentAt = Date.now();
    var emailed = [];
    // Email EVERY waiting parent simultaneously (not just the first N).
    for (var i = 0; i < rec.entries.length; i++) {
      var e = rec.entries[i];
      e.notified = true;
      e.notifiedAt = sentAt;
      rec.notices.push({
        id: HC.util.uid(),
        type: "space-open",
        to: "parent",
        email: e.email,
        position: i + 1,
        at: sentAt
      });
      emailed.push({ email: e.email, position: i + 1 });
    }

    writeRecord(campId, weekId, rec);
    return {
      ok: true,
      spaces: n,
      emailed: emailed,
      firstComeFirstServed: true,
      message: emailed.length
        ? "A space opened — emailed all " + emailed.length + " waiting parent(s). First come, first served."
        : "A space opened, but nobody is on the waitlist."
    };
  }

  /* Remove yourself (or be removed) from the waitlist. */
  function leaveWaitlist(campId, weekId, email) {
    var rec = readRecord(campId, weekId);
    var target = normEmail(email);
    var before = rec.entries.length;
    rec.entries = rec.entries.filter(function (e) { return normEmail(e.email) !== target; });
    var removed = before - rec.entries.length;
    if (removed > 0) {
      rec.notices.push({ id: HC.util.uid(), type: "leave", to: "provider", email: target, at: Date.now() });
      writeRecord(campId, weekId, rec);
    }
    return {
      ok: removed > 0,
      removed: removed,
      total: rec.entries.length,
      message: removed > 0 ? "Removed from the waitlist." : "You weren't on this waitlist."
    };
  }

  function getEntries(campId, weekId) {
    return readRecord(campId, weekId).entries.slice();
  }
  function positionOf(campId, weekId, email) {
    var entries = getEntries(campId, weekId);
    var target = normEmail(email);
    for (var i = 0; i < entries.length; i++) {
      if (normEmail(entries[i].email) === target) return i + 1;
    }
    return 0; // not on the list
  }

  /* ============================================================
   * 3. Demo data — find a real camp + a week it runs, and force a
   *    deterministic "full" state so the demo always shows the
   *    'Join waitlist' path. Reset wipes any earlier demo state.
   * ============================================================ */

  function demoCampAndWeek() {
    var camp = null, weekId = 1;
    try {
      var providers = HC.data.providers || [];
      var byId = (HC.data.planner && HC.data.planner.byId) || {};
      for (var i = 0; i < providers.length; i++) {
        var p = providers[i];
        var pl = byId[p.id];
        if (pl && Array.isArray(pl.weeks) && pl.weeks.length) {
          camp = { id: p.id, name: p.name };
          weekId = pl.weeks[0];
          break;
        }
      }
    } catch (e) { /* fall through to synthetic */ }
    if (!camp) camp = { id: "demo-camp", name: "Demo Holiday Camp" };
    return { camp: camp, weekId: weekId };
  }

  // Force a given camp+week FULL for the demo (idempotent).
  function forceFullForDemo(campId, weekId) {
    var base = baseCapacity(keyOf(campId, weekId));
    var rec = readRecord(campId, weekId);
    // Cancel out any earlier provider adjustments and book to capacity.
    rec.capacityAdjust = 0;
    rec.cancellations = -(base.capacity - base.booked); // pushes booked up to capacity
    writeRecord(campId, weekId, rec);
  }

  function weekLabel(weekId) {
    try {
      var weeks = (HC.data.planner && HC.data.planner.weeks) || [];
      for (var i = 0; i < weeks.length; i++) {
        if (String(weeks[i].id) === String(weekId)) {
          return weeks[i].label + (weeks[i].dates ? " (" + weeks[i].dates + ")" : "");
        }
      }
    } catch (e) {}
    return "Week " + weekId;
  }

  /* ============================================================
   * 4. UI — a mock camp-week booking panel. When the week is full,
   *    the 'Join waitlist' option appears (faithful to the article).
   * ============================================================ */

  function esc(s) {
    return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
  function escAttr(s) { return esc(s).replace(/"/g, "&quot;"); }

  function render(mountEl) {
    try {
      var demo = demoCampAndWeek();
      var camp = demo.camp, weekId = demo.weekId;
      forceFullForDemo(camp.id, weekId); // make sure the full path is visible

      mountEl.innerHTML =
        '<div id="wlRoot" style="font-family:\'Nunito Sans\',system-ui,sans-serif;color:var(--text,#383838)">' +
          '<p style="font-size:14px;margin:0 0 12px">This camp week is <strong>fully booked</strong>. ' +
          'On Happity, when a place is full the <em>Join waitlist</em> option appears so you don\'t lose your spot in the queue. ' +
          'Everyone on the list is emailed the moment a space opens — first come, first served.</p>' +

          '<div style="border:1.5px solid var(--line,#E6E6E6);border-radius:16px;padding:16px;margin-bottom:14px">' +
            '<div style="font-family:\'Quicksand\',system-ui,sans-serif;font-weight:700;color:var(--purple,#603488);font-size:17px">' +
              esc(camp.name) + '</div>' +
            '<div style="font-size:13px;color:var(--muted,#808080);margin:2px 0 10px">' + esc(weekLabel(weekId)) + '</div>' +
            '<div id="wlStatus"></div>' +
            '<div id="wlBookingArea"></div>' +
          '</div>' +

          '<div id="wlProviderPanel" style="background:var(--purple-tint,#F0E8F4);border-radius:14px;padding:12px 14px;font-size:13px">' +
            '<div style="font-weight:700;color:var(--purple,#603488);margin-bottom:6px">Provider view (for the demo)</div>' +
            '<div id="wlProviderBody"></div>' +
            '<div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap">' +
              '<button id="wlCancelBtn" type="button" class="hc-btn hc-btn-ghost">A booking cancels (free 1 space)</button>' +
              '<button id="wlAddCapBtn" type="button" class="hc-btn hc-btn-ghost">Add 1 place</button>' +
            '</div>' +
          '</div>' +
        '</div>';

      var $ = function (id) { return mountEl.querySelector("#" + id); };

      function paint() {
        var full = isFull(camp.id, weekId);
        var left = spacesLeft(camp.id, weekId);
        var entries = getEntries(camp.id, weekId);

        // Status line.
        $("wlStatus").innerHTML = full
          ? '<span style="display:inline-block;background:var(--pink-tint,#FCE8F0);color:#9a1f5e;font-weight:700;' +
            'font-size:12px;padding:4px 10px;border-radius:999px">FULLY BOOKED</span>'
          : '<span style="display:inline-block;background:#E1F0E4;color:#2f7d4f;font-weight:700;' +
            'font-size:12px;padding:4px 10px;border-radius:999px">' + left + ' space' + (left === 1 ? '' : 's') + ' left</span>';

        // Booking / waitlist area.
        var area = $("wlBookingArea");
        if (!full) {
          area.innerHTML =
            '<p style="font-size:13.5px;margin:12px 0 0;color:#2f7d4f">A space is available — you can book this week now.</p>';
        } else {
          // FULL: the 'Join waitlist' option appears.
          area.innerHTML =
            '<div style="margin-top:12px">' +
              '<label style="display:block;font-weight:700;font-size:12.5px;margin:8px 0 3px">Your email</label>' +
              '<input id="wlEmail" type="email" placeholder="you@example.com" autocomplete="off" ' +
                'style="width:100%;padding:9px;border:1.5px solid var(--line,#E6E6E6);border-radius:12px;font-size:14px">' +
              '<label style="display:block;font-weight:700;font-size:12.5px;margin:10px 0 3px">Child\'s name (optional)</label>' +
              '<input id="wlChild" type="text" placeholder="e.g. Amira" ' +
                'style="width:100%;padding:9px;border:1.5px solid var(--line,#E6E6E6);border-radius:12px;font-size:14px">' +
              '<button id="wlJoinBtn" type="button" class="hc-btn" style="margin-top:12px">Join waitlist</button>' +
              '<div id="wlJoinMsg" style="font-size:12.5px;min-height:16px;margin-top:8px"></div>' +
            '</div>';
        }

        // Provider panel: who's waiting + notification log.
        var body = $("wlProviderBody");
        if (body) {
          var notified = entries.filter(function (e) { return e.notified; }).length;
          var rows = entries.length
            ? entries.map(function (e, i) {
                return '<div style="display:flex;justify-content:space-between;gap:8px;padding:3px 0">' +
                  '<span>' + (i + 1) + '. ' + esc(e.email) + (e.childName ? ' — ' + esc(e.childName) : '') + '</span>' +
                  '<span style="color:' + (e.notified ? '#2f7d4f' : 'var(--muted,#808080)') + '">' +
                    (e.notified ? 'emailed ✓' : 'waiting') + '</span>' +
                '</div>';
              }).join("")
            : '<div style="color:var(--muted,#808080)">No one waiting yet.</div>';
          body.innerHTML =
            '<div style="margin-bottom:6px">On waiting list: <strong>' + entries.length + '</strong>' +
              (notified ? ' · emailed: <strong>' + notified + '</strong>' : '') + '</div>' + rows;
        }

        // Wire the freshly-rendered controls.
        var joinBtn = $("wlJoinBtn");
        if (joinBtn) {
          joinBtn.addEventListener("click", function () {
            var res = joinWaitlist(camp.id, weekId, {
              email: $("wlEmail") ? $("wlEmail").value : "",
              childName: $("wlChild") ? $("wlChild").value : ""
            });
            var msg = $("wlJoinMsg");
            if (msg) {
              msg.textContent = res.message;
              msg.style.color = res.ok ? "#2f7d4f" : "#9a1f5e";
            }
            if (res.ok) { try { HC.util.toast(res.message); } catch (e) {} }
            paint();
          });
        }
      }

      $("wlCancelBtn").addEventListener("click", function () {
        var res = openSpaces(camp.id, weekId, 1, "cancellation");
        try { HC.util.toast(res.message); } catch (e) {}
        // After a cancellation a space exists; re-fill it for the demo so the
        // waitlist path stays visible, but keep the 'everyone emailed' record.
        forceFullForDemo(camp.id, weekId);
        paint();
      });
      $("wlAddCapBtn").addEventListener("click", function () {
        var res = openSpaces(camp.id, weekId, 1, "capacity");
        try { HC.util.toast(res.message); } catch (e) {}
        forceFullForDemo(camp.id, weekId);
        paint();
      });

      paint();
    } catch (e) {
      mountEl.innerHTML = '<p style="color:#9a1f5e">Waitlist preview failed to load: ' +
        esc(e && e.message ? e.message : String(e)) + "</p>";
    }
  }

  /* ============================================================
   * 5. selfTest — exercises the LOGIC and asserts the acceptance
   *    criterion across multiple cases. Uses a throwaway camp+week
   *    so it never disturbs real demo/user state.
   * ============================================================ */

  function selfTest() {
    var pass = 0, fail = 0, log = [];
    function check(label, fn) {
      try { fn(); pass += 1; log.push("✓ " + label); }
      catch (e) { fail += 1; log.push("✗ " + label + " — " + (e && e.message ? e.message : String(e))); }
    }

    // Isolated test fixture: a fresh camp+week id, wiped before we start.
    var CAMP = "selftest-camp-" + HC.util.uid();
    var WEEK = 3;
    // Ensure a clean slate for this key.
    (function () {
      var rec = readRecord(CAMP, WEEK);
      rec.entries = []; rec.notices = []; rec.capacityAdjust = 0; rec.cancellations = 0;
      writeRecord(CAMP, WEEK, rec);
    })();

    // Helper: force the test week full.
    function makeFull() { forceFullForDemo(CAMP, WEEK); }
    // Helper: force the test week to have spaces.
    function makeOpen() {
      var base = baseCapacity(keyOf(CAMP, WEEK));
      var rec = readRecord(CAMP, WEEK);
      rec.capacityAdjust = 0;
      rec.cancellations = base.booked; // free every booked place -> spaces exist
      writeRecord(CAMP, WEEK, rec);
    }

    // --- The 'Join waitlist' option is gated on FULL. ---
    check("A full camp week reports isFull() true (the 'Join waitlist' trigger)", function () {
      makeFull();
      HC.assert(isFull(CAMP, WEEK) === true, "forced-full week should be full");
      HC.assert(spacesLeft(CAMP, WEEK) === 0, "a full week has 0 spaces left");
    });

    check("Joining is BLOCKED while spaces remain (option does not apply)", function () {
      makeOpen();
      HC.assert(isFull(CAMP, WEEK) === false, "opened week should not be full");
      var r = joinWaitlist(CAMP, WEEK, { email: "early@example.com" });
      HC.assert(r.ok === false, "cannot waitlist a week that has spaces");
      HC.assert(r.reason === "not-full", "reason should be 'not-full', got " + r.reason);
    });

    // --- ACCEPTANCE: full week -> parent is ADDED to the waitlist. ---
    check("ACCEPTANCE: on a full week a parent JOINS the waitlist at position 1", function () {
      makeFull();
      var r = joinWaitlist(CAMP, WEEK, { email: "Anna@Example.com", childName: "Amira" });
      HC.assert(r.ok === true, "join should succeed on a full week");
      HC.assert(r.position === 1, "first joiner should be position 1, got " + r.position);
      HC.assert(r.alreadyOn === false, "first join is not a duplicate");
      HC.assert(positionOf(CAMP, WEEK, "anna@example.com") === 1, "parent should now be on the list (email normalised)");
    });

    check("Joining the waitlist NOTIFIES the provider", function () {
      var rec = readRecord(CAMP, WEEK);
      var joinNotices = rec.notices.filter(function (n) { return n.type === "join" && n.to === "provider"; });
      HC.assert(joinNotices.length >= 1, "provider should get a join notification, got " + joinNotices.length);
    });

    check("A second parent joins at position 2 (first come, first served order)", function () {
      var r = joinWaitlist(CAMP, WEEK, { email: "ben@example.com", childName: "Bo" });
      HC.assert(r.ok === true && r.position === 2, "second joiner should be position 2, got " + r.position);
      HC.assert(getEntries(CAMP, WEEK).length === 2, "two parents should be waiting");
    });

    check("Duplicate join (same email) does NOT add a second entry", function () {
      var before = getEntries(CAMP, WEEK).length;
      var r = joinWaitlist(CAMP, WEEK, { email: "ANNA@example.com" });
      HC.assert(r.ok === true, "re-join is not an error");
      HC.assert(r.alreadyOn === true, "should report alreadyOn");
      HC.assert(r.position === 1, "duplicate should return existing position 1, got " + r.position);
      HC.assert(getEntries(CAMP, WEEK).length === before, "no extra entry should be created");
    });

    check("Invalid email is rejected (we must be able to email them)", function () {
      var r = joinWaitlist(CAMP, WEEK, { email: "not-an-email" });
      HC.assert(r.ok === false && r.reason === "bad-email", "bad email should be rejected, got " + r.reason);
    });

    // --- ACCEPTANCE: a space opens -> EVERYONE waiting is EMAILED. ---
    check("ACCEPTANCE: when a space opens EVERY waiting parent is EMAILED at once", function () {
      var entriesBefore = getEntries(CAMP, WEEK);
      HC.assert(entriesBefore.length === 2, "expected 2 waiting before a space opens, got " + entriesBefore.length);
      var res = openSpaces(CAMP, WEEK, 1, "cancellation");
      HC.assert(res.ok === true, "openSpaces should succeed");
      HC.assert(res.emailed.length === 2, "BOTH waiting parents should be emailed, got " + res.emailed.length);
      HC.assert(res.firstComeFirstServed === true, "should be first come, first served");

      var entriesAfter = getEntries(CAMP, WEEK);
      var allNotified = entriesAfter.every(function (e) { return e.notified === true && e.notifiedAt; });
      HC.assert(allNotified, "every entry should be flagged notified with a timestamp");

      var rec = readRecord(CAMP, WEEK);
      var emailNotices = rec.notices.filter(function (n) { return n.type === "space-open" && n.to === "parent"; });
      HC.assert(emailNotices.length === 2, "one parent email per waiting parent, got " + emailNotices.length);
    });

    check("Emails are sent simultaneously (same timestamp for all)", function () {
      var entries = getEntries(CAMP, WEEK);
      var stamps = {};
      entries.forEach(function (e) { stamps[e.notifiedAt] = true; });
      HC.assert(Object.keys(stamps).length === 1, "all parents should share one send timestamp");
    });

    check("Adding capacity (not just cancellation) also emails the waitlist", function () {
      // Fresh waiting parent on a separately-forced-full key behaviour.
      var c2 = "selftest-cap-" + HC.util.uid();
      forceFullForDemo(c2, WEEK);
      joinWaitlist(c2, WEEK, { email: "cara@example.com" });
      var res = openSpaces(c2, WEEK, 2, "capacity");
      HC.assert(res.emailed.length === 1, "the one waiting parent should be emailed when capacity is added");
    });

    // --- Parent can remove themselves at any time (per the article). ---
    check("Parent can remove themselves from the waitlist", function () {
      var c3 = "selftest-leave-" + HC.util.uid();
      forceFullForDemo(c3, WEEK);
      joinWaitlist(c3, WEEK, { email: "dee@example.com" });
      joinWaitlist(c3, WEEK, { email: "evan@example.com" });
      HC.assert(getEntries(c3, WEEK).length === 2, "two should be waiting");
      var r = leaveWaitlist(c3, WEEK, "dee@example.com");
      HC.assert(r.ok === true && r.removed === 1, "one entry should be removed");
      HC.assert(positionOf(c3, WEEK, "dee@example.com") === 0, "removed parent is no longer on the list");
      // Remaining parent shuffles to position 1.
      HC.assert(positionOf(c3, WEEK, "evan@example.com") === 1, "remaining parent should now be position 1");
    });

    check("Removing someone not on the list is a no-op", function () {
      var c4 = "selftest-noop-" + HC.util.uid();
      forceFullForDemo(c4, WEEK);
      var r = leaveWaitlist(c4, WEEK, "ghost@example.com");
      HC.assert(r.ok === false && r.removed === 0, "removing a non-member should be a no-op");
    });

    // --- Persistence sanity: it round-trips through HC.store. ---
    check("Waitlist state persists via HC.store (namespaced, not global)", function () {
      var c5 = "selftest-persist-" + HC.util.uid();
      forceFullForDemo(c5, WEEK);
      joinWaitlist(c5, WEEK, { email: "faye@example.com" });
      // Re-read fresh from the store.
      var again = positionOf(c5, WEEK, "faye@example.com");
      HC.assert(again === 1, "join should be readable back from the store");
      var all = HC.store.get(STORE_KEY, null);
      HC.assert(all && typeof all === "object", "store key should hold the waitlist map");
    });

    // --- Live-data sanity: a real camp+week can be driven full + joined. ---
    check("A real camp week can be forced full and joined (live data path)", function () {
      var demo = demoCampAndWeek();
      // Use a copy id so we never clobber any real demo state.
      var liveKeyCamp = "live-probe-" + demo.camp.id;
      forceFullForDemo(liveKeyCamp, demo.weekId);
      HC.assert(isFull(liveKeyCamp, demo.weekId) === true, "probe week should be full");
      var r = joinWaitlist(liveKeyCamp, demo.weekId, { email: "live@example.com" });
      HC.assert(r.ok === true && r.position === 1, "should join the live-derived full week");
    });

    return { pass: pass, fail: fail, log: log };
  }

  /* ============================================================
   * 6. Register (idempotent + defensive via core).
   * ============================================================ */
  HC.registerFeature({
    id: "parent-waiting-list",
    title: "Join a waiting list for a full camp",
    side: "parent",
    icon: "⏳",
    summary: "When a holiday-camp week is fully booked, join the waiting list. You're added to the queue and emailed the moment a space opens — first come, first served. Remove yourself any time.",
    render: render,
    selfTest: selfTest
  });
})();
