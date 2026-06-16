/* HolidayCamp feature — provider-print-register
 *
 * Print register  (provider side)
 *
 * Replicates Happity's "Print register" view. Evidence:
 *   - support article 4147796 ("Sharing a register with an external teacher"):
 *       "Teachers can only see the 'Print register' view - they can see the
 *        names of the adults and children attending the class, and the age of
 *        the children - as well as any important notes on SEN or allergies."
 *   - support article 2295666 ("Setting dates and managing your registers"):
 *        registers are managed per dated session.
 *
 * Framed for SCHOOL-AGE HOLIDAY CAMPS (not baby classes). A provider runs a
 * camp SESSION on a given date (e.g. "Multi-Activity Summer Camp — Mon 21 Jul,
 * 09:00–16:00, St Mary's Hall"). Each BOOKING on that session puts a CHILD on
 * the register, with the booking ADULT (parent/carer), the child's AGE, and any
 * important SEN / allergy / medical notes. The provider — or an external coach
 * covering the session — can render that register as a PRINTABLE ATTENDEE LIST
 * (names, ages, notes, a tick column, and a headcount), then send it to print.
 *
 * ACCEPTANCE CRITERION (asserted in selfTest):
 *   "A register can be rendered as a printable attendee list."
 * We verify:
 *   - buildRegister() turns a session's bookings into ordered attendee rows
 *     (sorted, child name + age + adult + SEN/allergy notes), with a headcount.
 *   - renderRegisterHTML() produces a self-contained printable document string:
 *     a header (camp/date/venue/time), one <tr> per attending child, an
 *     allergy/SEN flag, a signature/tick column, and a present-count footer.
 *   - Cancelled bookings are excluded from the printable list; waiting-list
 *     bookings are excluded from the headcount but optionally shown.
 *   - The printable output is deterministic and escapes user content.
 *
 * Self-contained, defensive, no imports/exports. Calls HC.registerFeature.
 */
(function () {
  "use strict";

  // Defensive: never throw at module load if HC isn't present.
  if (typeof window === "undefined" || !window.HC || typeof window.HC.registerFeature !== "function") {
    if (typeof console !== "undefined" && console.warn) {
      console.warn("[HC] provider-print-register: HC core not found; skipping registration.");
    }
    return;
  }

  var HC = window.HC;

  // Persisted shape: { <providerId>: { sessions:{ <sessionId>:{...} } } }
  var STORE_KEY = "provider_print_register";

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

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
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

  var DOW = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  var MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  function dateLabel(iso) {
    try {
      if (!isValidISODate(iso)) return asText(iso);
      var p = iso.split("-");
      var dt = new Date(Date.UTC(Number(p[0]), Number(p[1]) - 1, Number(p[2])));
      return DOW[dt.getUTCDay()] + " " + Number(p[2]) + " " + MON[Number(p[1]) - 1] + " " + p[0];
    } catch (e) { return asText(iso); }
  }

  // A booking's status. Only "booked" attendees count toward the headcount.
  // "cancelled" never appears on the printable list; "waitlist" can be shown
  // (greyed) but is excluded from the present-count.
  var STATUS = { BOOKED: "booked", WAITLIST: "waitlist", CANCELLED: "cancelled" };
  function normStatus(s) {
    var v = asText(s).toLowerCase();
    if (v === STATUS.CANCELLED || v === "canceled") return STATUS.CANCELLED;
    if (v === STATUS.WAITLIST || v === "waiting" || v === "waiting-list") return STATUS.WAITLIST;
    return STATUS.BOOKED;
  }

  // Normalise one booking into a register row. A booking carries the child, the
  // booking adult, the child's age, and any SEN / allergy / medical notes.
  function normaliseBooking(b) {
    var a = (b && typeof b === "object") ? b : {};
    var ageRaw = a.childAge;
    var ageNum = (ageRaw === 0 || ageRaw) && isFinite(Number(ageRaw)) ? toInt(ageRaw) : null;
    return {
      id: asText(a.id) || safeUid("bk"),
      childName: asText(a.childName).trim(),
      childAge: ageNum,                            // years, or null if unknown
      adultName: asText(a.adultName).trim(),       // booking parent / carer
      adultPhone: asText(a.adultPhone).trim(),
      // important notes — SEN and allergies are surfaced separately so the
      // printable list can FLAG them, per the Happity register view.
      sen: asText(a.sen).trim(),
      allergies: asText(a.allergies).trim(),
      notes: asText(a.notes).trim(),
      status: normStatus(a.status)
    };
  }

  // Does this attendee have anything safety-critical to flag (SEN/allergy)?
  function hasFlag(row) {
    return !!(row && (row.allergies || row.sen));
  }

  // Build the register for one session: ordered, filtered attendee rows plus
  // a headcount. This is the data behind the "printable attendee list".
  //
  //   opts.includeWaitlist  — include waitlist rows in the list (default false)
  //   opts.sort             — "name" (default) | "age" | "booking" (insertion)
  function buildRegister(session, opts) {
    var s = (session && typeof session === "object") ? session : {};
    var o = (opts && typeof opts === "object") ? opts : {};
    var bookingsIn = Array.isArray(s.bookings) ? s.bookings : [];

    var rows = [];
    for (var i = 0; i < bookingsIn.length; i++) {
      var r = normaliseBooking(bookingsIn[i]);
      r._order = i; // stable insertion order
      // Cancelled bookings NEVER appear on the printable register.
      if (r.status === STATUS.CANCELLED) continue;
      if (r.status === STATUS.WAITLIST && !o.includeWaitlist) continue;
      rows.push(r);
    }

    var sortMode = o.sort === "age" ? "age" : (o.sort === "booking" ? "booking" : "name");
    rows.sort(function (a, b) {
      // Booked attendees always sort above waitlisted ones.
      if (a.status !== b.status) {
        if (a.status === STATUS.BOOKED) return -1;
        if (b.status === STATUS.BOOKED) return 1;
      }
      if (sortMode === "booking") return a._order - b._order;
      if (sortMode === "age") {
        var aa = a.childAge == null ? Infinity : a.childAge;
        var bb = b.childAge == null ? Infinity : b.childAge;
        if (aa !== bb) return aa - bb;
      }
      // name (default) and age tie-break: case-insensitive child name.
      var an = a.childName.toLowerCase(), bn = b.childName.toLowerCase();
      if (an < bn) return -1;
      if (an > bn) return 1;
      return a._order - b._order;
    });

    var booked = rows.filter(function (r) { return r.status === STATUS.BOOKED; });
    var waiting = rows.filter(function (r) { return r.status === STATUS.WAITLIST; });
    var flagged = booked.filter(hasFlag);

    return {
      session: {
        id: asText(s.id) || "",
        campName: asText(s.campName) || "Holiday camp",
        venue: asText(s.venue) || "",
        date: asText(s.date) || "",
        dateLabel: dateLabel(s.date),
        time: asText(s.time) || ""
      },
      rows: rows,                 // everything that will be printed (in order)
      attendees: booked,          // booked children only
      waiting: waiting,           // waitlist rows (only present if includeWaitlist)
      presentCount: booked.length,// THE headcount on the printable list
      flaggedCount: flagged.length,
      generatedLabel: nowLabel()
    };
  }

  function nowLabel() {
    try {
      var d = new Date();
      var hh = String(d.getHours()).padStart(2, "0");
      var mm = String(d.getMinutes()).padStart(2, "0");
      return dateLabel(
        d.getFullYear() + "-" +
        String(d.getMonth() + 1).padStart(2, "0") + "-" +
        String(d.getDate()).padStart(2, "0")
      ) + " " + hh + ":" + mm;
    } catch (e) { return ""; }
  }

  function ageCell(row) {
    if (row.childAge == null) return "—";
    return row.childAge + (row.childAge === 1 ? " yr" : " yrs");
  }

  // Combine SEN + allergy + general notes into one printable notes cell, with
  // safety-critical items clearly marked. Returns escaped HTML.
  function notesCellHTML(row) {
    var bits = [];
    if (row.allergies) {
      bits.push('<strong style="color:#9a1f5e">⚠ Allergy:</strong> ' + esc(row.allergies));
    }
    if (row.sen) {
      bits.push('<strong style="color:#9a5a1f">SEN:</strong> ' + esc(row.sen));
    }
    if (row.notes) {
      bits.push(esc(row.notes));
    }
    return bits.length ? bits.join("<br>") : '<span style="color:#aaa">—</span>';
  }

  /* ---- THE acceptance criterion: render the register as a printable list ----
     Returns a self-contained HTML document string. It includes a print-only
     stylesheet, a header block (camp / date / venue / time), a table with one
     row per attending child (name, age, adult/carer, allergy & SEN notes, and a
     blank signature/tick column), and a footer headcount. Deterministic given
     a fixed `generatedLabel` (the UI passes the live one). */
  function renderRegisterHTML(reg, opts) {
    var r = (reg && typeof reg === "object") ? reg : buildRegister(null);
    var o = (opts && typeof opts === "object") ? opts : {};
    var sess = r.session || {};
    var rows = Array.isArray(r.rows) ? r.rows : [];
    var generated = o.generatedLabel != null ? asText(o.generatedLabel) : asText(r.generatedLabel);

    var head = '' +
      '<div class="reg-head">' +
        '<h1>' + esc(sess.campName) + '</h1>' +
        '<div class="reg-meta">' +
          (sess.dateLabel ? '<span><strong>Date:</strong> ' + esc(sess.dateLabel) + '</span>' : '') +
          (sess.time ? '<span><strong>Time:</strong> ' + esc(sess.time) + '</span>' : '') +
          (sess.venue ? '<span><strong>Venue:</strong> ' + esc(sess.venue) + '</span>' : '') +
        '</div>' +
        '<div class="reg-count"><strong>' + toInt(r.presentCount) + '</strong> child' +
          (toInt(r.presentCount) === 1 ? '' : 'ren') + ' booked' +
          (toInt(r.flaggedCount) > 0 ? ' · <span class="reg-flag">' + toInt(r.flaggedCount) + ' with allergy / SEN notes</span>' : '') +
        '</div>' +
      '</div>';

    var bodyRows = "";
    if (!rows.length) {
      bodyRows = '<tr><td colspan="6" class="reg-empty">No children are booked on this session yet.</td></tr>';
    } else {
      for (var i = 0; i < rows.length; i++) {
        var row = rows[i];
        var waiting = row.status === STATUS.WAITLIST;
        bodyRows += '<tr' + (waiting ? ' class="reg-wait"' : '') + (hasFlag(row) && !waiting ? ' class="reg-flagged"' : '') + '>' +
          '<td class="reg-n">' + (i + 1) + '</td>' +
          '<td class="reg-child">' + esc(row.childName || "—") +
            (waiting ? ' <span class="reg-wait-tag">waiting list</span>' : '') + '</td>' +
          '<td class="reg-age">' + esc(ageCell(row)) + '</td>' +
          '<td class="reg-adult">' + esc(row.adultName || "—") +
            (row.adultPhone ? '<br><span class="reg-phone">' + esc(row.adultPhone) + '</span>' : '') + '</td>' +
          '<td class="reg-notes">' + notesCellHTML(row) + '</td>' +
          '<td class="reg-sign"></td>' +
        '</tr>';
      }
    }

    var css =
      '@media print{.reg-noprint{display:none !important}@page{margin:14mm}}' +
      '.reg-doc{font-family:Arial,Helvetica,system-ui,sans-serif;color:#1a1a1a;font-size:13px;line-height:1.4}' +
      '.reg-head h1{font-size:20px;margin:0 0 6px}' +
      '.reg-meta{display:flex;flex-wrap:wrap;gap:14px;color:#444;font-size:13px;margin:0 0 6px}' +
      '.reg-count{font-size:13px;color:#222;margin:0 0 12px}' +
      '.reg-flag{color:#9a1f5e}' +
      'table.reg-table{width:100%;border-collapse:collapse}' +
      'table.reg-table th,table.reg-table td{border:1px solid #999;padding:6px 8px;text-align:left;vertical-align:top}' +
      'table.reg-table th{background:#f0ecf6;font-size:12px;text-transform:uppercase;letter-spacing:.3px}' +
      'table.reg-table td.reg-n{width:28px;text-align:center;color:#666}' +
      'table.reg-table td.reg-sign{width:120px}' +
      'table.reg-table td.reg-age{white-space:nowrap}' +
      'tr.reg-flagged td{background:#fff6fa}' +
      'tr.reg-wait td{color:#888;background:#fafafa}' +
      '.reg-wait-tag{font-size:10px;text-transform:uppercase;color:#9a5a1f;border:1px solid #d9c2a3;border-radius:6px;padding:1px 5px;margin-left:4px}' +
      '.reg-phone{color:#666;font-size:11px}' +
      '.reg-empty{text-align:center;color:#888;padding:18px}' +
      '.reg-footer{margin-top:14px;color:#666;font-size:11px;display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap}';

    return '' +
      '<style>' + css + '</style>' +
      '<div class="reg-doc">' +
        head +
        '<table class="reg-table">' +
          '<thead><tr>' +
            '<th>#</th><th>Child</th><th>Age</th><th>Parent / carer</th>' +
            '<th>Allergies / SEN / notes</th><th>Present ✓ / signature</th>' +
          '</tr></thead>' +
          '<tbody>' + bodyRows + '</tbody>' +
        '</table>' +
        '<div class="reg-footer">' +
          '<span>Register for ' + esc(sess.campName) + (sess.dateLabel ? ' · ' + esc(sess.dateLabel) : '') + '</span>' +
          (generated ? '<span>Generated ' + esc(generated) + '</span>' : '') +
        '</div>' +
      '</div>';
  }

  function safeUid(prefix) {
    try { return HC.util.uid(); }
    catch (e) { return (prefix || "id") + "_" + Date.now() + "_" + Math.floor(Math.random() * 1e6); }
  }

  /* ===================================================================
     PERSISTENCE (HC.store only — never raw localStorage)
     Shape: { <providerId>: { sessions:{ <sessionId>:{...} } } }
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
    if (!map[pid] || typeof map[pid] !== "object") map[pid] = { sessions: {} };
    if (!map[pid].sessions || typeof map[pid].sessions !== "object") map[pid].sessions = {};
    return map[pid];
  }
  function normaliseSession(input) {
    var a = (input && typeof input === "object") ? input : {};
    return {
      id: asText(a.id) || safeUid("sess"),
      campName: asText(a.campName) || "Holiday camp",
      venue: asText(a.venue) || "",
      date: asText(a.date) || "",
      time: asText(a.time) || "",
      bookings: Array.isArray(a.bookings) ? a.bookings.map(normaliseBooking) : []
    };
  }
  function upsertSession(providerId, input) {
    var map = readAll();
    var b = providerBucket(map, providerId);
    var sess = normaliseSession(input);
    b.sessions[sess.id] = sess;
    writeAll(map);
    return sess;
  }
  function getSession(providerId, sessionId) {
    var b = providerBucket(readAll(), providerId);
    var s = b.sessions[asText(sessionId)];
    return s ? normaliseSession(s) : null;
  }
  function getAllSessions(providerId) {
    var b = providerBucket(readAll(), providerId);
    return Object.keys(b.sessions).map(function (k) { return normaliseSession(b.sessions[k]); });
  }
  function clearProvider(providerId) {
    var map = readAll();
    delete map[asText(providerId) || "_default"];
    writeAll(map);
  }

  /* ===================================================================
     DEMO SEEDING (uses live data where available)
     =================================================================== */

  function demoProviderId() {
    try {
      var ps = HC.data.providers;
      if (ps && ps.length && ps[0] && ps[0].id) return "printreg_demo__" + ps[0].id;
    } catch (e) {}
    return "printreg_demo__provider";
  }

  function demoCampName() {
    try {
      var ps = HC.data.providers;
      if (ps && ps.length) {
        // pick a paid, full-day, multi-activity camp if we can find one
        for (var i = 0; i < ps.length; i++) {
          var c = (ps[i].categories || []).join(" ").toLowerCase();
          if (c.indexOf("multi") >= 0 || c.indexOf("full day") >= 0) return ps[i].name;
        }
        return ps[0].name;
      }
    } catch (e) {}
    return "Multi-Activity Summer Camp";
  }
  function demoVenue() {
    try {
      var ps = HC.data.providers;
      if (ps && ps.length && ps[0].venue) return ps[0].venue;
    } catch (e) {}
    return "St Mary's Hall, Walthamstow";
  }
  function soonISO() {
    try {
      var kd = HC.data.planner.keyDates || {};
      if (kd.holidayStart && isValidISODate(kd.holidayStart.iso)) return kd.holidayStart.iso;
    } catch (e) {}
    return "2026-07-21";
  }

  function seedDemo(providerId) {
    upsertSession(providerId, {
      id: "sess-demo",
      campName: demoCampName(),
      venue: demoVenue(),
      date: soonISO(),
      time: "09:00–16:00",
      bookings: [
        { id: "b1", childName: "Amara Okafor", childAge: 7, adultName: "Joy Okafor", adultPhone: "07700 900111",
          allergies: "Peanuts (carries EpiPen)", sen: "", notes: "", status: "booked" },
        { id: "b2", childName: "Ben Carter", childAge: 9, adultName: "Tom Carter", adultPhone: "07700 900222",
          allergies: "", sen: "ASD — needs quiet space at lunch", notes: "", status: "booked" },
        { id: "b3", childName: "Chloe Davies", childAge: 6, adultName: "Sara Davies", adultPhone: "07700 900333",
          allergies: "", sen: "", notes: "Collected by grandmother on Thursday", status: "booked" },
        { id: "b4", childName: "Dev Patel", childAge: 8, adultName: "Anil Patel", adultPhone: "07700 900444",
          allergies: "", sen: "", notes: "", status: "booked" },
        { id: "b5", childName: "Esme Wright", childAge: 10, adultName: "Kate Wright", adultPhone: "07700 900555",
          allergies: "Dairy", sen: "", notes: "", status: "waitlist" },
        { id: "b6", childName: "Freddie Long", childAge: 7, adultName: "Mark Long", adultPhone: "07700 900666",
          allergies: "", sen: "", notes: "Cancelled — refunded", status: "cancelled" }
      ]
    });
  }

  /* ===================================================================
     UI
     =================================================================== */

  function el(tag, attrs, html) {
    try { return HC.util.el(tag, attrs, html); }
    catch (e) {
      var n = document.createElement(tag || "div");
      if (html != null) n.innerHTML = html;
      return n;
    }
  }

  // Open a printable register in a popup window and trigger the print dialog.
  // Defensive: if popups are blocked, fall back to an inline preview + toast.
  function openPrintWindow(html, title) {
    try {
      var w = window.open("", "_blank", "width=820,height=680");
      if (!w || !w.document) throw new Error("popup blocked");
      w.document.open();
      w.document.write(
        '<!doctype html><html><head><meta charset="utf-8"><title>' +
        esc(title || "Register") + '</title></head><body style="margin:18px">' +
        html +
        '<div class="reg-noprint" style="margin-top:18px"><button onclick="window.print()" ' +
        'style="font:600 13px Arial;padding:9px 16px;border:none;border-radius:8px;background:#603488;color:#fff;cursor:pointer">' +
        '🖨 Print this register</button></div>' +
        '</body></html>'
      );
      w.document.close();
      try { w.focus(); } catch (e2) {}
      return true;
    } catch (e) {
      try { HC.util.toast("Pop-up blocked — showing a preview instead"); } catch (e3) {}
      return false;
    }
  }

  function render(mountEl) {
    try {
      if (!mountEl) return;
      var providerId = demoProviderId();
      clearProvider(providerId);
      seedDemo(providerId);
      mountEl.innerHTML = "";

      var intro = el("div", null,
        '<p style="font-size:14px;color:var(--text,#383838);margin:0 0 4px">' +
          "Render any camp session as a <strong>printable attendee list</strong> — exactly the Happity " +
          "&lsquo;Print register&rsquo; view a coach or covering teacher can use on the day. It shows each " +
          "child&rsquo;s name and age, the booking parent / carer, and any <strong>allergy or SEN</strong> notes.</p>" +
        '<p style="font-size:12.5px;color:var(--muted,#808080);margin:0 0 12px">' +
          "Cancelled bookings are left off the register; waiting-list children can be shown but don&rsquo;t " +
          "count in the headcount.</p>");
      mountEl.appendChild(intro);

      var controls = el("div", { style: "display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:0 0 12px" },
        '<label style="font-size:13px;color:var(--text,#383838)">Sort by ' +
          '<select id="prSort" style="margin-left:4px;padding:5px 8px;border-radius:8px;border:1.5px solid var(--line,#E6E6E6)">' +
            '<option value="name">Child name</option>' +
            '<option value="age">Age</option>' +
            '<option value="booking">Booking order</option>' +
          '</select></label>' +
        '<label style="font-size:13px;color:var(--text,#383838)">' +
          '<input type="checkbox" id="prWait"> Include waiting list</label>' +
        '<button class="hc-btn" type="button" id="prPrint">🖨 Print register</button>');
      mountEl.appendChild(controls);

      var previewHost = el("div", {
        id: "prPreview",
        style: "border:1.5px solid var(--line,#E6E6E6);border-radius:14px;padding:14px;background:#fff;overflow:auto;max-height:46vh"
      });
      mountEl.appendChild(previewHost);

      function currentReg() {
        var sortSel = mountEl.querySelector("#prSort");
        var waitChk = mountEl.querySelector("#prWait");
        var sess = getSession(providerId, "sess-demo");
        return buildRegister(sess, {
          sort: sortSel ? sortSel.value : "name",
          includeWaitlist: !!(waitChk && waitChk.checked)
        });
      }
      function refresh() {
        var reg = currentReg();
        previewHost.innerHTML = renderRegisterHTML(reg);
      }
      refresh();

      controls.addEventListener("change", function (e) {
        if (e.target && (e.target.id === "prSort" || e.target.id === "prWait")) refresh();
      });
      controls.addEventListener("click", function (e) {
        var btn = e.target && e.target.closest ? e.target.closest("#prPrint") : null;
        if (!btn) return;
        var reg = currentReg();
        var html = renderRegisterHTML(reg);
        var ok = openPrintWindow(html, "Register — " + reg.session.campName);
        if (!ok) previewHost.innerHTML = html;       // fallback: show inline
        else { try { HC.util.toast("Opened printable register"); } catch (er) {} }
      });
    } catch (e) {
      try {
        mountEl.innerHTML = '<p style="color:#9a1f5e">Print-register feature failed to render: ' +
          esc(e && e.message ? e.message : String(e)) + "</p>";
      } catch (e2) { /* give up quietly */ }
    }
  }

  /* ===================================================================
     selfTest — exercises the LOGIC and asserts the acceptance criterion
     "A register can be rendered as a printable attendee list."
     =================================================================== */

  function selfTest() {
    var pass = 0, fail = 0, log = [];
    function check(label, fn) {
      try { fn(); pass += 1; log.push("✓ " + label); }
      catch (e) { fail += 1; log.push("✗ " + label + " — " + (e && e.message ? e.message : String(e))); }
    }

    function sampleSession(overrides) {
      var base = {
        id: "s-test",
        campName: "Multi-Activity Camp",
        venue: "St Mary's Hall",
        date: "2026-07-21",
        time: "09:00–16:00",
        bookings: [
          { id: "b1", childName: "Beth", childAge: 8, adultName: "Paula", allergies: "Nuts", status: "booked" },
          { id: "b2", childName: "Aaron", childAge: 10, adultName: "Sam", sen: "ASD", status: "booked" },
          { id: "b3", childName: "Cara", childAge: 6, adultName: "Nina", status: "booked" },
          { id: "b4", childName: "Zoe", childAge: 7, adultName: "Liz", status: "cancelled" },
          { id: "b5", childName: "Yusuf", childAge: 9, adultName: "Hana", status: "waitlist" }
        ]
      };
      if (overrides) for (var k in overrides) if (Object.prototype.hasOwnProperty.call(overrides, k)) base[k] = overrides[k];
      return base;
    }

    /* ===== buildRegister: attendee list construction ===== */

    check("buildRegister returns ordered attendee rows with a headcount", function () {
      var reg = buildRegister(sampleSession());
      HC.assert(reg && Array.isArray(reg.rows), "register must expose rows[]");
      HC.assert(reg.presentCount === 3, "3 booked children expected, got " + reg.presentCount);
      HC.assert(reg.attendees.length === 3, "attendees should be the 3 booked children");
    });

    check("Cancelled bookings are excluded from the printable list", function () {
      var reg = buildRegister(sampleSession());
      var names = reg.rows.map(function (r) { return r.childName; });
      HC.assert(names.indexOf("Zoe") === -1, "cancelled child must not appear");
    });

    check("Waiting-list bookings are excluded by default and don't count", function () {
      var reg = buildRegister(sampleSession());
      var names = reg.rows.map(function (r) { return r.childName; });
      HC.assert(names.indexOf("Yusuf") === -1, "waitlist child hidden by default");
      HC.assert(reg.presentCount === 3, "waitlist must not inflate the headcount");
    });

    check("Waiting list can be opted in but stays out of the headcount", function () {
      var reg = buildRegister(sampleSession(), { includeWaitlist: true });
      var names = reg.rows.map(function (r) { return r.childName; });
      HC.assert(names.indexOf("Yusuf") !== -1, "waitlist child shown when opted in");
      HC.assert(reg.presentCount === 3, "headcount still counts only booked children");
      HC.assert(reg.waiting.length === 1, "one waiting child tracked separately");
      // booked rows must sort above the waitlisted one
      HC.assert(reg.rows[reg.rows.length - 1].childName === "Yusuf", "waitlist sorts last");
    });

    check("Default sort is by child name (case-insensitive, A→Z)", function () {
      var reg = buildRegister(sampleSession());
      var names = reg.rows.map(function (r) { return r.childName; });
      HC.assert(names.join(",") === "Aaron,Beth,Cara", "expected Aaron,Beth,Cara — got " + names.join(","));
    });

    check("Sort by age orders youngest→oldest", function () {
      var reg = buildRegister(sampleSession(), { sort: "age" });
      var ages = reg.attendees.map(function (r) { return r.childAge; });
      HC.assert(ages.join(",") === "6,8,10", "expected 6,8,10 — got " + ages.join(","));
    });

    check("Sort by booking preserves insertion order", function () {
      var reg = buildRegister(sampleSession(), { sort: "booking" });
      var names = reg.attendees.map(function (r) { return r.childName; });
      HC.assert(names.join(",") === "Beth,Aaron,Cara", "expected Beth,Aaron,Cara — got " + names.join(","));
    });

    check("Allergy / SEN attendees are flagged and counted", function () {
      var reg = buildRegister(sampleSession());
      HC.assert(reg.flaggedCount === 2, "Beth (allergy) + Aaron (SEN) should flag, got " + reg.flaggedCount);
      var beth = reg.attendees.filter(function (r) { return r.childName === "Beth"; })[0];
      HC.assert(hasFlag(beth) === true, "Beth has an allergy note → flagged");
    });

    /* ===== ACCEPTANCE CRITERION: render as a PRINTABLE attendee list ===== */

    check("renderRegisterHTML returns a non-empty printable document string", function () {
      var html = renderRegisterHTML(buildRegister(sampleSession()), { generatedLabel: "FIXED" });
      HC.assert(typeof html === "string" && html.length > 200, "must return a substantial HTML string");
      HC.assert(/<table[^>]*class="reg-table"/.test(html), "must contain the register table");
      HC.assert(/@media print/.test(html), "must include print-specific styling");
      HC.assert(/<th>Child<\/th>/.test(html), "must label a Child column");
      HC.assert(/Present\s*✓\s*\/\s*signature/.test(html), "must include a tick / signature column");
    });

    check("The printable list has one row per booked child plus header/footer", function () {
      var reg = buildRegister(sampleSession());
      var html = renderRegisterHTML(reg, { generatedLabel: "FIXED" });
      var rowCount = (html.match(/<tr/g) || []).length;       // header row + 3 body rows
      HC.assert(rowCount === 4, "expected 1 head + 3 body <tr>, got " + rowCount);
      HC.assert(html.indexOf("Beth") !== -1 && html.indexOf("Aaron") !== -1 && html.indexOf("Cara") !== -1,
        "all three attendees must be listed");
      HC.assert(html.indexOf("Zoe") === -1, "cancelled child must not be printed");
    });

    check("Printable header shows camp, date, venue, time and headcount", function () {
      var html = renderRegisterHTML(buildRegister(sampleSession()), { generatedLabel: "FIXED" });
      HC.assert(html.indexOf("Multi-Activity Camp") !== -1, "camp name in the print header");
      HC.assert(html.indexOf("Tuesday 21 Jul 2026") !== -1, "human date label in the header");
      HC.assert(html.indexOf("St Mary's Hall") !== -1 || html.indexOf("St Mary&#39;s Hall") !== -1, "venue in the header");
      HC.assert(html.indexOf("09:00–16:00") !== -1, "session time in the header");
      HC.assert(/<strong>3<\/strong>\s*children booked/.test(html), "headcount of 3 children booked");
    });

    check("Allergy and SEN notes are surfaced and marked on the printable list", function () {
      var html = renderRegisterHTML(buildRegister(sampleSession()), { generatedLabel: "FIXED" });
      HC.assert(html.indexOf("Allergy:") !== -1 && html.indexOf("Nuts") !== -1, "allergy note printed");
      HC.assert(html.indexOf("SEN:") !== -1 && html.indexOf("ASD") !== -1, "SEN note printed");
    });

    check("User-supplied content is HTML-escaped in the printable output", function () {
      var s = sampleSession({
        campName: "Camp <script>x</script>",
        bookings: [{ id: "x", childName: 'Eve "Hacker" <b>', childAge: 8, adultName: "A & B", allergies: "<img>", status: "booked" }]
      });
      var html = renderRegisterHTML(buildRegister(s), { generatedLabel: "FIXED" });
      HC.assert(html.indexOf("<script>x</script>") === -1, "raw script tag must be escaped");
      HC.assert(html.indexOf("&lt;script&gt;") !== -1, "script tag escaped to entities");
      HC.assert(html.indexOf('Eve &quot;Hacker&quot;') !== -1, "quotes in child name escaped");
      HC.assert(html.indexOf("A &amp; B") !== -1, "ampersand in adult name escaped");
    });

    check("An empty session still renders a valid printable list (count 0)", function () {
      var html = renderRegisterHTML(buildRegister(sampleSession({ bookings: [] })), { generatedLabel: "FIXED" });
      HC.assert(/<strong>0<\/strong>\s*children booked/.test(html), "zero headcount shown");
      HC.assert(html.indexOf("No children are booked") !== -1, "empty-state message present");
      HC.assert(/<table[^>]*class="reg-table"/.test(html), "table still rendered when empty");
    });

    check("Singular wording when exactly one child is booked", function () {
      var s = sampleSession({ bookings: [{ id: "o", childName: "Solo", childAge: 7, adultName: "P", status: "booked" }] });
      var html = renderRegisterHTML(buildRegister(s), { generatedLabel: "FIXED" });
      HC.assert(/<strong>1<\/strong>\s*child booked/.test(html), "should read '1 child booked' (singular)");
    });

    check("Render is deterministic for a fixed generated label", function () {
      var reg = buildRegister(sampleSession());
      var h1 = renderRegisterHTML(reg, { generatedLabel: "FIXED" });
      var h2 = renderRegisterHTML(reg, { generatedLabel: "FIXED" });
      HC.assert(h1 === h2, "identical input must produce identical output");
    });

    /* ===== Persistence round-trip ===== */

    var TP = "__selftest_printreg__";
    clearProvider(TP);
    check("A persisted session can be loaded and rendered to a printable list", function () {
      upsertSession(TP, sampleSession({ id: "persist-1" }));
      var loaded = getSession(TP, "persist-1");
      HC.assert(loaded && loaded.bookings.length === 5, "session persisted with all bookings");
      var html = renderRegisterHTML(buildRegister(loaded), { generatedLabel: "FIXED" });
      HC.assert(/<table[^>]*class="reg-table"/.test(html), "persisted session renders a register table");
      HC.assert((html.match(/<tr/g) || []).length === 4, "1 head + 3 booked rows from the store");
    });
    clearProvider(TP);

    /* ===== Defensive: garbage never throws ===== */

    check("Garbage inputs never throw and still yield a printable list", function () {
      var bad = [null, undefined, 42, "", [], {}, { bookings: "nope" }, { bookings: [null, 7, {}] }];
      for (var i = 0; i < bad.length; i++) {
        var reg = buildRegister(bad[i]);
        HC.assert(reg && typeof reg.presentCount === "number", "garbage #" + i + " yields a register");
        var html = renderRegisterHTML(reg, { generatedLabel: "FIXED" });
        HC.assert(typeof html === "string" && /reg-table/.test(html), "garbage #" + i + " still prints a table");
      }
      // renderRegisterHTML called with no register at all must not throw
      var html2 = renderRegisterHTML(null);
      HC.assert(typeof html2 === "string" && /reg-table/.test(html2), "null register still renders a table");
    });

    return { pass: pass, fail: fail, log: log };
  }

  /* ===================================================================
     register
     =================================================================== */

  HC.registerFeature({
    id: "provider-print-register",
    title: "Print register",
    side: "provider",
    icon: "🖨",
    summary: "Render any camp session as a printable attendee list — the Happity ‘Print register’ view. Lists each child's name and age, the booking parent / carer, and any allergy or SEN notes, with a tick / signature column and a headcount. Cancelled bookings are dropped; waiting-list children can be shown but don't count.",
    render: render,
    selfTest: selfTest
  });
})();
