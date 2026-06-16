/* HolidayCamp feature — provider-reschedule
 *
 * Reschedule a session / move date  (PROVIDER side)
 *
 * Replicates Happity's "Reschedule" button for a dated class with bookings.
 * Evidence:
 *   - support article 4764733 ("Rescheduling sessions"):
 *       "If you've already taken bookings and need to postpone a class, you can
 *        use the reschedule button to change it to a later date." You "choose the
 *        new date and save it"; "some dates will be crossed out; this will be the
 *        case where there are already classes in place" (no double-booking a date).
 *        Crucially: "Automatic notifications will NOT be sent however. Please
 *        click the 'Resend confirmation email' icon after rescheduling if you
 *        wish to send out new booking emails; and / or contact the attendees
 *        directly … using the 'Contact attendees' action button."
 *   - support article 6056178 ("How to reschedule or cancel an individual class
 *     with bookings"): you "select the tick boxes next to the customer's name and
 *     then select 'Reschedule'" — i.e. the BOOKINGS on the old register are the
 *     thing that moves to the new date.
 *
 * Framed for SCHOOL-AGE HOLIDAY CAMPS (not baby classes). A provider runs a
 * dated camp day (e.g. "Multi-Activity Camp — Mon 27 Jul 2026") with a register
 * of booked children. Rain, a venue clash or low numbers forces a postponement;
 * the provider reschedules the whole dated session to a later date. The children
 * already booked MOVE with it (their bookings now sit on the new date's register)
 * and — matching Happity — the provider then triggers a notification to the
 * affected families (Happity does this as a deliberate step, not silently).
 *
 * ACCEPTANCE CRITERION (asserted in selfTest):
 *   Rescheduling a dated class MOVES BOOKINGS and NOTIFIES CUSTOMERS.
 *   We verify, on a real reschedule:
 *     1) the session's date changes to the chosen new date,
 *     2) every booking on the old register is carried onto the NEW date's
 *        register (none left behind, none lost, count preserved),
 *     3) a notification is produced for each affected customer (with old→new
 *        date), and the session records that customers were notified.
 *   Plus guards Happity calls out: you cannot reschedule to a date that already
 *   has a session (crossed-out dates), nor to a date in the past, nor to the
 *   same date.
 *
 * Self-contained, defensive, no imports/exports. Calls HC.registerFeature.
 */
(function () {
  "use strict";

  // Defensive: never throw at module load if HC isn't present.
  if (typeof window === "undefined" || !window.HC || typeof window.HC.registerFeature !== "function") {
    if (typeof console !== "undefined" && console.warn) {
      console.warn("[HC] provider-reschedule: HC core not found; skipping registration.");
    }
    return;
  }

  var HC = window.HC;

  var STORE_KEY = "provider_reschedule"; // { <providerId>: { sessions:[...] } }

  /* ===================================================================
     PURE LOGIC (testable, DOM-free)
     =================================================================== */

  function asText(v) {
    return typeof v === "string" ? v : (v == null ? "" : String(v));
  }

  // Strict YYYY-MM-DD validation that also rejects impossible calendar dates
  // (e.g. 2026-02-30). Returns true only for a real Gregorian date.
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

  function safeUid(prefix) {
    try { return HC.util.uid(); }
    catch (e) { return (prefix || "id") + "_" + Date.now() + "_" + Math.floor(Math.random() * 1e6); }
  }

  // A booking is one child/customer on a dated session's register.
  function makeBooking(input) {
    var a = (input && typeof input === "object") ? input : {};
    return {
      id: safeUid("bk"),
      child: asText(a.child).trim() || "Child",
      customer: asText(a.customer).trim() || "Parent",
      email: asText(a.email).trim() || "",
      createdAt: Date.now()
    };
  }

  // A dated session: a single concrete date with its own register of bookings.
  // history records each move so we can show an audit trail (old → new).
  function makeSession(input) {
    var a = (input && typeof input === "object") ? input : {};
    var register = Array.isArray(a.register)
      ? a.register.map(makeBooking)
      : [];
    return {
      id: safeUid("ses"),
      title: asText(a.title).trim() || "Holiday camp day",
      date: isValidISODate(a.date) ? a.date : "",
      dateLabel: isValidISODate(a.date) ? dateLabel(a.date) : "",
      start: asText(a.start) || "09:00",
      end: asText(a.end) || "16:00",
      venue: asText(a.venue) || "",
      register: register,
      // Notification + audit state — mirrors Happity's deliberate notify step.
      notifiedAt: null,        // when customers were last notified about a move
      pendingNotify: false,    // a move happened but customers not yet told
      history: [],             // [{ from, to, movedBookings, at }]
      notifications: [],       // [{ bookingId, customer, email, from, to, at, sent }]
      createdAt: Date.now()
    };
  }

  // VALIDATE a proposed reschedule against the provider's other sessions.
  // Pure: no mutation. Returns { ok, errors:[...] }.
  //   newDate   : YYYY-MM-DD chosen by the provider
  //   session   : the session being moved
  //   others    : the provider's OTHER sessions (to detect crossed-out dates)
  //   today     : optional YYYY-MM-DD "today" for past-date checks (test-friendly)
  function validateReschedule(session, newDate, others, today) {
    var errors = [];
    if (!session || typeof session !== "object" || Array.isArray(session)) {
      return { ok: false, errors: ["No session to reschedule."] };
    }
    if (!isValidISODate(newDate)) {
      errors.push("Choose a valid new date (YYYY-MM-DD).");
      return { ok: false, errors: errors };
    }
    // Same date is a no-op, not a reschedule.
    if (isValidISODate(session.date) && newDate === session.date) {
      errors.push("That is already the session's date — pick a different date to reschedule.");
    }
    // Happity: dates with an existing class are "crossed out" — you can't move
    // onto a date that already has a session.
    var clash = (Array.isArray(others) ? others : []).some(function (s) {
      return s && s.id !== session.id && s.date === newDate;
    });
    if (clash) {
      errors.push("There is already a session on " + dateLabel(newDate) + " — pick a free date.");
    }
    // Can't postpone into the past.
    if (today && isValidISODate(today) && newDate < today) {
      errors.push("The new date is in the past — reschedule forwards to a future date.");
    }
    return { ok: errors.length === 0, errors: errors };
  }

  // THE CORE: reschedule a session to newDate, MOVING its bookings and PRODUCING
  // customer notifications. Pure transformation on the session object passed in
  // (it mutates the session in place and returns a result summary). The register
  // (bookings) is carried intact onto the new date — Happity's "the bookings will
  // have to be removed from the register first and then … rescheduled" is modelled
  // here as: the register travels WITH the session to the new date.
  //
  // notify: if true (default), build a notification per affected booking and mark
  //         the session notified now; if false, leave a pendingNotify flag so the
  //         UI can prompt the provider to send (matching Happity, where automatic
  //         emails are NOT sent and the provider must trigger them).
  //
  // Returns { ok, errors?, from?, to?, movedBookings?, notifications?, notified? }.
  function applyReschedule(session, newDate, others, opts) {
    var options = (opts && typeof opts === "object") ? opts : {};
    var notify = options.notify !== false; // default: notify
    var today = options.today;

    var v = validateReschedule(session, newDate, others, today);
    if (!v.ok) return { ok: false, errors: v.errors };

    var from = session.date;
    var to = newDate;
    var register = Array.isArray(session.register) ? session.register : [];
    var movedCount = register.length;
    var at = Date.now();

    // 1) Move the date. The register (bookings) is NOT touched — it rides along,
    //    which is exactly "bookings move with the session to the new date".
    session.date = to;
    session.dateLabel = dateLabel(to);

    // 2) Record the move on the audit trail.
    if (!Array.isArray(session.history)) session.history = [];
    session.history.push({ from: from, to: to, movedBookings: movedCount, at: at });

    // 3) Produce a notification for every affected customer (old → new date).
    var notes = register.map(function (b) {
      return {
        id: safeUid("ntf"),
        bookingId: b.id,
        customer: b.customer,
        child: b.child,
        email: b.email,
        from: from,
        fromLabel: dateLabel(from),
        to: to,
        toLabel: dateLabel(to),
        sessionTitle: session.title,
        at: at,
        sent: notify === true
      };
    });
    if (!Array.isArray(session.notifications)) session.notifications = [];
    session.notifications = session.notifications.concat(notes);

    if (notify) {
      session.notifiedAt = at;
      session.pendingNotify = false;
    } else {
      // Happity default: no automatic email — flag that a notify is owed.
      session.pendingNotify = movedCount > 0;
    }

    return {
      ok: true,
      from: from,
      fromLabel: dateLabel(from),
      to: to,
      toLabel: dateLabel(to),
      movedBookings: movedCount,
      notifications: notes,
      notified: notify === true
    };
  }

  // Explicitly send the pending notifications for a session (the "Resend
  // confirmation / Contact attendees" action). Marks the most-recent unsent
  // notifications as sent and clears pendingNotify.
  function sendPendingNotifications(session) {
    if (!session || typeof session !== "object") return { ok: false, sent: 0 };
    var at = Date.now();
    var sent = 0;
    (Array.isArray(session.notifications) ? session.notifications : []).forEach(function (n) {
      if (n && !n.sent) { n.sent = true; n.at = at; sent += 1; }
    });
    session.notifiedAt = at;
    session.pendingNotify = false;
    return { ok: true, sent: sent };
  }

  /* ===================================================================
     PERSISTENCE (HC.store only — never raw localStorage)

     Shape: { <providerId>: { sessions:[...session] } }
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
    if (!map[pid] || typeof map[pid] !== "object") map[pid] = { sessions: [] };
    if (!Array.isArray(map[pid].sessions)) map[pid].sessions = [];
    return map[pid];
  }

  function getSessions(providerId) {
    var map = readAll();
    var list = providerBucket(map, providerId).sessions.slice();
    list.sort(function (a, b) {
      return asText(a.date) < asText(b.date) ? -1 : asText(a.date) > asText(b.date) ? 1 : 0;
    });
    return list;
  }

  function addSession(providerId, input) {
    var map = readAll();
    var bucket = providerBucket(map, providerId);
    var session = makeSession(input);
    bucket.sessions.push(session);
    writeAll(map);
    return session;
  }

  // Reschedule a PERSISTED session by id and save the result. Returns the same
  // result shape as applyReschedule, with the saved session attached.
  function rescheduleStored(providerId, sessionId, newDate, opts) {
    var map = readAll();
    var bucket = providerBucket(map, providerId);
    var session = bucket.sessions.filter(function (s) { return s.id === sessionId; })[0];
    if (!session) return { ok: false, errors: ["Session not found."] };
    var others = bucket.sessions.filter(function (s) { return s.id !== sessionId; });
    var res = applyReschedule(session, newDate, others, opts);
    if (res.ok) { writeAll(map); res.session = session; }
    return res;
  }

  function sendStoredNotifications(providerId, sessionId) {
    var map = readAll();
    var bucket = providerBucket(map, providerId);
    var session = bucket.sessions.filter(function (s) { return s.id === sessionId; })[0];
    if (!session) return { ok: false, sent: 0 };
    var res = sendPendingNotifications(session);
    writeAll(map);
    return res;
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

  // Pull a couple of real summer week Mondays from the live planner for the
  // date pickers, so the demo feels grounded in the actual E17 camp calendar.
  function plannerMondays() {
    try {
      var weeks = HC.data.planner.weeks || [];
      var mons = weeks.map(function (w) { return w && w.mon; })
        .filter(function (m) { return isValidISODate(m); });
      if (mons.length >= 2) return mons;
    } catch (e) {}
    return ["2026-07-27", "2026-08-03", "2026-08-10"];
  }

  function sessionCardHtml(s) {
    var booked = (s.register || []).length;
    var notifyLine = "";
    if (s.pendingNotify) {
      notifyLine = '<div style="font-size:12px;color:#9a5a1f;margin-top:4px">' +
        "⚠️ Moved — customers not yet notified. " +
        '<button class="hc-btn" type="button" data-send="' + escAttr(s.id) + '" ' +
        'style="padding:3px 9px;font-size:11px">Notify ' + booked + ' famil' + (booked === 1 ? "y" : "ies") + "</button></div>";
    } else if (s.notifiedAt) {
      notifyLine = '<div style="font-size:12px;color:#2f7d4f;margin-top:4px">✓ ' +
        booked + " famil" + (booked === 1 ? "y" : "ies") + " notified of the new date.</div>";
    }
    var hist = (s.history || []).length
      ? '<div style="font-size:11.5px;color:var(--muted,#808080);margin-top:4px">Moved: ' +
          s.history.map(function (h) { return esc(dateLabel(h.from)) + " → " + esc(dateLabel(h.to)); }).join("; ") +
        "</div>"
      : "";
    return '<div class="hc-fcard" data-ses="' + escAttr(s.id) + '" style="gap:4px">' +
      "<strong>" + esc(s.title) + "</strong>" +
      '<div style="font-size:13px;color:var(--text,#383838)">📅 ' + esc(s.dateLabel || s.date || "Date TBC") +
        " · " + esc(s.start + "–" + s.end) + (s.venue ? " · " + esc(s.venue) : "") + "</div>" +
      '<div style="font-size:12.5px;color:var(--muted,#808080)">👧 ' + booked +
        " booked child" + (booked === 1 ? "" : "ren") + "</div>" +
      hist + notifyLine +
      '<div class="hc-frow"><button class="hc-btn hc-btn-ghost" type="button" data-resched="' + escAttr(s.id) +
        '" style="padding:5px 11px;font-size:12px">Reschedule…</button></div>' +
    "</div>";
  }

  function render(mountEl) {
    try {
      if (!mountEl) return;
      var providerId = demoProviderId();
      mountEl.innerHTML = "";

      // Always start the demo from a clean, deterministic seed.
      clearProvider(providerId);
      var mons = plannerMondays();
      addSession(providerId, {
        title: "Multi-Activity Camp Day",
        date: mons[0],
        start: "09:00", end: "16:00", venue: "Walthamstow venue",
        register: [
          { child: "Amir", customer: "Sana Khan", email: "sana@example.com" },
          { child: "Olu", customer: "Tope Adeyemi", email: "tope@example.com" },
          { child: "Mia", customer: "Jess Reed", email: "jess@example.com" }
        ]
      });
      // A second dated session, so one of the future dates is "crossed out".
      addSession(providerId, {
        title: "Forest & Sports Day",
        date: mons[1],
        start: "09:00", end: "16:00", venue: "Lloyd Park",
        register: [{ child: "Theo", customer: "Dan Hill", email: "dan@example.com" }]
      });

      var intro = el("div", null,
        '<p style="font-size:14px;color:var(--text,#383838);margin:0 0 4px">' +
          "Need to postpone a camp day you've already taken bookings for? " +
          "<strong>Reschedule</strong> it to a later date. The children already booked " +
          "<strong>move with it</strong> to the new date, and you then " +
          "<strong>notify the affected families</strong>.</p>" +
        '<p style="font-size:12.5px;color:var(--muted,#808080);margin:0 0 8px">' +
          "Like Happity, dates that already have a camp are blocked, and notifications " +
          "are sent as a deliberate step — never silently.</p>");
      mountEl.appendChild(intro);

      var listHost = el("div", { id: "hcReschedList", style: "display:grid;gap:12px;margin-top:8px" });
      mountEl.appendChild(listHost);

      var errHost = el("div", { id: "hcReschedErr", style: "margin-top:8px;color:#9a1f5e;font-size:12.5px" });
      mountEl.appendChild(errHost);

      function refresh() {
        listHost.innerHTML = getSessions(providerId).map(sessionCardHtml).join("");
      }
      refresh();

      function openRescheduleForm(sessionId) {
        errHost.textContent = "";
        var sessions = getSessions(providerId);
        var session = sessions.filter(function (s) { return s.id === sessionId; })[0];
        if (!session) return;
        var taken = sessions.filter(function (s) { return s.id !== sessionId && s.date; })
          .map(function (s) { return s.date; });

        var html = '<h2>Reschedule: ' + esc(session.title) + "</h2>" +
          '<p style="font-size:13px;color:var(--muted,#808080);margin:0 0 10px">' +
            "Current date: <strong>" + esc(session.dateLabel || session.date) + "</strong> · " +
            (session.register || []).length + " booked child" +
            ((session.register || []).length === 1 ? "" : "ren") + " will move with it." +
            (taken.length ? " Dates already in use: " + taken.map(function (d) { return esc(dateLabel(d)); }).join(", ") + "." : "") +
          "</p>" +
          '<label style="display:block;font-size:13px;margin:0 0 10px">New date<br>' +
            '<input id="rsNewDate" type="date" value="' + escAttr(session.date) + '" ' +
              'style="width:100%;padding:7px 9px;border:1.5px solid var(--line,#E6E6E6);border-radius:8px"></label>' +
          '<label style="display:flex;align-items:center;gap:8px;font-size:13px;margin:0 0 12px">' +
            '<input id="rsNotify" type="checkbox" checked> Notify affected families now (old → new date)</label>' +
          '<button class="hc-btn" id="rsGo" type="button">Reschedule & move bookings</button>' +
          '<div id="rsErr" style="margin-top:10px;color:#9a1f5e;font-size:12.5px"></div>';
        HC.util.modal(html);

        var root = document.getElementById("hcModalRoot");
        if (!root) return;
        var goBtn = root.querySelector("#rsGo");
        if (goBtn) goBtn.addEventListener("click", function () {
          var dInput = root.querySelector("#rsNewDate");
          var nInput = root.querySelector("#rsNotify");
          var localErr = root.querySelector("#rsErr");
          if (localErr) localErr.textContent = "";
          var res = rescheduleStored(providerId, sessionId, dInput ? dInput.value : "", {
            notify: nInput ? nInput.checked : true
          });
          if (!res.ok) {
            if (localErr) localErr.textContent = res.errors.join(" ");
            return;
          }
          try { HC.util.closeModal(); } catch (e) {}
          refresh();
          try {
            HC.util.toast("Moved " + res.movedBookings + " booking" +
              (res.movedBookings === 1 ? "" : "s") + " to " + res.toLabel +
              (res.notified ? " · families notified" : " · notify families when ready"));
          } catch (e) {}
        });
      }

      listHost.addEventListener("click", function (e) {
        var resched = e.target && e.target.closest ? e.target.closest("[data-resched]") : null;
        if (resched) { openRescheduleForm(resched.getAttribute("data-resched")); return; }
        var send = e.target && e.target.closest ? e.target.closest("[data-send]") : null;
        if (send) {
          var r = sendStoredNotifications(providerId, send.getAttribute("data-send"));
          refresh();
          try { HC.util.toast("Notified " + r.sent + " famil" + (r.sent === 1 ? "y" : "ies")); } catch (er) {}
        }
      });
    } catch (e) {
      try {
        mountEl.innerHTML = '<p style="color:#9a1f5e">Reschedule feature failed to render: ' +
          esc(e && e.message ? e.message : String(e)) + "</p>";
      } catch (e2) { /* give up quietly */ }
    }
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

    var TP = "__selftest_provider_reschedule__";
    clearProvider(TP); // deterministic starting point

    // ===== ACCEPTANCE CRITERION =====
    // Rescheduling a dated class MOVES BOOKINGS and NOTIFIES CUSTOMERS.

    check("Seed: a dated session with a register of 3 booked children", function () {
      var s = addSession(TP, {
        title: "Multi-Activity Camp Day",
        date: "2026-07-27", start: "09:00", end: "16:00", venue: "Walthamstow",
        register: [
          { child: "Amir", customer: "Sana Khan", email: "sana@example.com" },
          { child: "Olu", customer: "Tope Adeyemi", email: "tope@example.com" },
          { child: "Mia", customer: "Jess Reed", email: "jess@example.com" }
        ]
      });
      HC.assert(s.date === "2026-07-27", "session should start on the seeded date");
      HC.assert(s.register.length === 3, "register should hold 3 bookings, got " + s.register.length);
      HC.assert(s.notifiedAt === null, "a fresh session has not notified anyone");
      HC.assert(getSessions(TP).length === 1, "one session should be persisted");
    });

    check("ACCEPTANCE — reschedule MOVES the date and carries ALL bookings", function () {
      var s = getSessions(TP)[0];
      var beforeIds = s.register.map(function (b) { return b.id; }).sort();
      var res = rescheduleStored(TP, s.id, "2026-08-10", { notify: true });
      HC.assert(res.ok === true, "reschedule should succeed: " + (res.errors || []).join(" "));
      HC.assert(res.from === "2026-07-27", "result should record the old date");
      HC.assert(res.to === "2026-08-10", "result should record the new date");

      var moved = getSessions(TP)[0];
      // 1) date changed
      HC.assert(moved.date === "2026-08-10", "session date must change to the new date, got " + moved.date);
      HC.assert(moved.dateLabel === "Mon 10 Aug 2026", "date label should update, got " + moved.dateLabel);
      // 2) bookings moved — none lost, none left behind, same identities
      HC.assert(moved.register.length === 3, "all 3 bookings must move, got " + moved.register.length);
      HC.assert(res.movedBookings === 3, "result should report 3 moved bookings, got " + res.movedBookings);
      var afterIds = moved.register.map(function (b) { return b.id; }).sort();
      HC.assert(JSON.stringify(afterIds) === JSON.stringify(beforeIds),
        "the SAME bookings must be on the new date (identities preserved)");
    });

    check("ACCEPTANCE — every affected customer is NOTIFIED with old → new date", function () {
      var s = getSessions(TP)[0];
      HC.assert(s.notifiedAt !== null, "session must record that customers were notified");
      HC.assert(s.pendingNotify === false, "no notification should be pending after notify:true");
      HC.assert(Array.isArray(s.notifications) && s.notifications.length === 3,
        "one notification per affected customer (3), got " + (s.notifications || []).length);
      // each notification carries the move and is marked sent
      var byCustomer = {};
      s.notifications.forEach(function (n) {
        byCustomer[n.customer] = n;
        HC.assert(n.from === "2026-07-27", "notification should carry the OLD date");
        HC.assert(n.to === "2026-08-10", "notification should carry the NEW date");
        HC.assert(n.sent === true, "notification should be marked sent when notify:true");
        HC.assert(/Aug/.test(n.toLabel), "notification should have a human new-date label");
      });
      HC.assert(byCustomer["Sana Khan"] && byCustomer["Tope Adeyemi"] && byCustomer["Jess Reed"],
        "all three named customers must receive a notification");
    });

    // ===== Happity nuance: notification can be deferred, then explicitly sent =====

    check("Reschedule with notify:false leaves a PENDING notify (Happity default)", function () {
      var s2 = addSession(TP, {
        title: "Forest Skills Day",
        date: "2026-08-17",
        register: [
          { child: "Theo", customer: "Dan Hill", email: "dan@example.com" },
          { child: "Eve", customer: "Pria Shah", email: "pria@example.com" }
        ]
      });
      var res = rescheduleStored(TP, s2.id, "2026-08-24", { notify: false });
      HC.assert(res.ok === true, "deferred-notify reschedule should still succeed");
      HC.assert(res.notified === false, "result should report it did not notify");
      var moved = getSessions(TP).filter(function (x) { return x.id === s2.id; })[0];
      HC.assert(moved.date === "2026-08-24", "bookings still MOVE even when notify is deferred");
      HC.assert(moved.register.length === 2, "both bookings should have moved");
      HC.assert(moved.pendingNotify === true, "a notify should be owed (pending) when deferred");
      HC.assert(moved.notifiedAt === null, "customers not yet notified when deferred");
      // notifications exist but are unsent
      HC.assert(moved.notifications.length === 2, "2 unsent notifications should be queued");
      HC.assert(moved.notifications.every(function (n) { return n.sent === false; }),
        "queued notifications must be unsent until the provider sends them");
    });

    check("Explicitly sending pending notifications notifies the families", function () {
      var s2 = getSessions(TP).filter(function (x) { return x.title === "Forest Skills Day"; })[0];
      var r = sendStoredNotifications(TP, s2.id);
      HC.assert(r.ok === true, "send should succeed");
      HC.assert(r.sent === 2, "two pending notifications should be sent, got " + r.sent);
      var after = getSessions(TP).filter(function (x) { return x.id === s2.id; })[0];
      HC.assert(after.pendingNotify === false, "no notify should be pending after sending");
      HC.assert(after.notifiedAt !== null, "session should record the notify time");
      HC.assert(after.notifications.every(function (n) { return n.sent === true; }),
        "all notifications should now be sent");
    });

    // ===== Guards Happity calls out =====

    check("Cannot reschedule onto a date that already has a session (crossed-out)", function () {
      // Forest Skills Day now sits on 2026-08-24; the Multi-Activity day is on
      // 2026-08-10. Try to move Multi-Activity onto 2026-08-24 — should clash.
      var multi = getSessions(TP).filter(function (x) { return x.title === "Multi-Activity Camp Day"; })[0];
      var res = rescheduleStored(TP, multi.id, "2026-08-24", { notify: true });
      HC.assert(res.ok === false, "moving onto an occupied date must be rejected");
      HC.assert(/already a session/i.test((res.errors || []).join(" ")),
        "error should explain the date is taken");
      // unchanged
      var still = getSessions(TP).filter(function (x) { return x.id === multi.id; })[0];
      HC.assert(still.date === "2026-08-10", "the session must not move on a failed reschedule");
    });

    check("Cannot reschedule to the SAME date (no-op rejected)", function () {
      var multi = getSessions(TP).filter(function (x) { return x.title === "Multi-Activity Camp Day"; })[0];
      var res = rescheduleStored(TP, multi.id, "2026-08-10", { notify: true });
      HC.assert(res.ok === false, "rescheduling to the same date must be rejected");
      HC.assert(/already.*date/i.test((res.errors || []).join(" ")), "error should mention it's the same date");
    });

    check("Cannot reschedule into the PAST", function () {
      var multi = getSessions(TP).filter(function (x) { return x.title === "Multi-Activity Camp Day"; })[0];
      var res = rescheduleStored(TP, multi.id, "2026-07-01", { notify: true, today: "2026-07-15" });
      HC.assert(res.ok === false, "a past new-date must be rejected");
      HC.assert(/past/i.test((res.errors || []).join(" ")), "error should mention the past");
    });

    check("An invalid new date is rejected and nothing moves", function () {
      var multi = getSessions(TP).filter(function (x) { return x.title === "Multi-Activity Camp Day"; })[0];
      var bad = ["2026-13-01", "2026-02-30", "10/08/2026", "soon", "", "2026-8-1"];
      for (var i = 0; i < bad.length; i++) {
        var res = rescheduleStored(TP, multi.id, bad[i], { notify: true });
        HC.assert(res.ok === false, "invalid date '" + bad[i] + "' must be rejected");
      }
      var still = getSessions(TP).filter(function (x) { return x.id === multi.id; })[0];
      HC.assert(still.date === "2026-08-10", "session date must be unchanged after invalid attempts");
    });

    // ===== A session with no bookings still reschedules; just no one to notify ====

    check("Rescheduling an empty register moves the date but notifies no one", function () {
      var empty = addSession(TP, { title: "Open Taster Day", date: "2026-07-20", register: [] });
      var res = rescheduleStored(TP, empty.id, "2026-07-21", { notify: true });
      HC.assert(res.ok === true, "an empty session should still reschedule");
      HC.assert(res.movedBookings === 0, "no bookings to move on an empty register");
      var moved = getSessions(TP).filter(function (x) { return x.id === empty.id; })[0];
      HC.assert(moved.date === "2026-07-21", "the date should still move");
      HC.assert(moved.notifications.length === 0, "no notifications when there are no bookings");
      HC.assert(moved.pendingNotify === false, "nothing pending when there's no one to tell");
    });

    // ===== Audit trail: a repeated reschedule keeps history of each move =====

    check("Repeated reschedules accumulate a move-history (audit trail)", function () {
      var multi = getSessions(TP).filter(function (x) { return x.title === "Multi-Activity Camp Day"; })[0];
      // currently on 2026-08-10 → move to a free future date, then again
      var r1 = rescheduleStored(TP, multi.id, "2026-08-31", { notify: true });
      HC.assert(r1.ok === true, "first further move should succeed: " + (r1.errors || []).join(" "));
      var r2 = rescheduleStored(TP, multi.id, "2026-09-07", { notify: true });
      HC.assert(r2.ok === true, "second further move should succeed: " + (r2.errors || []).join(" "));
      var s = getSessions(TP).filter(function (x) { return x.id === multi.id; })[0];
      HC.assert(s.history.length >= 2, "history should record each move, got " + s.history.length);
      // bookings survive multiple moves
      HC.assert(s.register.length === 3, "all 3 bookings should survive repeated moves, got " + s.register.length);
      // a notification was produced on each move (3 bookings × ≥2 captured moves)
      HC.assert(s.notifications.length >= 6, "each move should notify all 3 again, got " + s.notifications.length);
    });

    // ===== Persistence via HC.store, not raw localStorage =====

    check("Rescheduled state persists via HC.store and reloads", function () {
      var reloaded = getSessions(TP);
      HC.assert(reloaded.length >= 3, "all seeded sessions should persist");
      var multi = reloaded.filter(function (x) { return x.title === "Multi-Activity Camp Day"; })[0];
      HC.assert(multi.date === "2026-09-07", "the latest moved date should persist, got " + multi.date);
      HC.assert(multi.register.length === 3, "moved bookings should persist with the session");
    });

    // ===== Defensive: garbage input never throws and never corrupts state =====

    check("Garbage reschedule input is handled and never moves a session", function () {
      var multi = getSessions(TP).filter(function (x) { return x.title === "Multi-Activity Camp Day"; })[0];
      var dateBefore = multi.date;
      var bad = [null, undefined, 42, "", [], {}, NaN];
      for (var i = 0; i < bad.length; i++) {
        var res = rescheduleStored(TP, multi.id, bad[i], { notify: true });
        HC.assert(res && res.ok === false, "garbage date #" + i + " must be rejected");
      }
      // unknown session id is handled too
      var r = rescheduleStored(TP, "no-such-session", "2026-08-19", { notify: true });
      HC.assert(r && r.ok === false, "an unknown session id must be rejected");
      var still = getSessions(TP).filter(function (x) { return x.id === multi.id; })[0];
      HC.assert(still.date === dateBefore, "no garbage attempt may move the session");
    });

    check("applyReschedule on null/garbage sessions never throws", function () {
      var junk = [null, undefined, 42, "x", []];
      for (var i = 0; i < junk.length; i++) {
        var res = applyReschedule(junk[i], "2026-08-19", []);
        HC.assert(res && res.ok === false, "garbage session #" + i + " must be rejected, not thrown");
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
    id: "provider-reschedule",
    title: "Reschedule a session / move date",
    side: "provider",
    icon: "🗓️",
    summary: "Postpone a dated camp day you've already taken bookings for. The booked children move with it to the new date, occupied dates are blocked, and you notify the affected families of the change (old → new date) — sent as a deliberate step, never silently.",
    render: render,
    selfTest: selfTest
  });
})();
