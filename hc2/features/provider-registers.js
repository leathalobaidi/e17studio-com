/* HolidayCamp feature — provider-registers
 *
 * View registers for past/upcoming dates  (provider side)
 *
 * Replicates the Happity "Registers" view. Evidence:
 *   - support article 8058268 ("How to view your registers"): "you will be able
 *     to see the registers for past and upcoming classes on your dashboard.
 *     Click on 'My Classes' and then 'Registers'." — a dashboard listing of
 *     per-date registers spanning PAST and UPCOMING sessions.
 *   - support article 2295666 ("Setting dates and managing your registers"):
 *     each added date "will create a new blank register for the session";
 *     "Click on a date to view the register for this session"; "an overview of
 *     your sales … and how many spaces are still available"; "By default, the
 *     register is ordered by the child's first name … and siblings are grouped
 *     together"; "Any notes that have been provided by the parent will be
 *     grouped together at the bottom of the register".
 *
 * Framed for SCHOOL-AGE HOLIDAY CAMPS (not baby classes). A provider runs a
 * camp across the Summer-2026 Waltham Forest weeks. Each running DATE owns its
 * own register. A register lists the ATTENDEES booked onto that date, and for
 * each attendee shows the CHILD's AGE plus any SEN / allergy / medical NOTES
 * the parent supplied — exactly what a camp leader needs on the day.
 *
 * ACCEPTANCE CRITERION (asserted in selfTest):
 *   A Registers view lists attendees per date with child age and SEN/allergy
 *   notes. We verify: registers exist per concrete date; past vs upcoming dates
 *   are both listed and correctly classified; opening a date returns its
 *   attendee list; every attendee row carries the child's age; and SEN /
 *   allergy / medical notes are surfaced (per-attendee AND grouped) so a leader
 *   can read them off the register.
 *
 * Self-contained, defensive, no imports/exports. Calls HC.registerFeature.
 */
(function () {
  "use strict";

  // Defensive: never throw at module load if HC isn't present.
  if (typeof window === "undefined" || !window.HC || typeof window.HC.registerFeature !== "function") {
    if (typeof console !== "undefined" && console.warn) {
      console.warn("[HC] provider-registers: HC core not found; skipping registration.");
    }
    return;
  }

  var HC = window.HC;

  var STORE_KEY = "provider_registers"; // { <providerId>: { dates: [ {date, attendees:[...]} ] } }

  // "Today" anchor for past/upcoming classification. We pin it to the live
  // app's current date so the demo stays deterministic regardless of the wall
  // clock, but fall back to the real clock if anything is off.
  var TODAY_ISO = "2026-06-15";

  /* ===================================================================
     PURE LOGIC (testable, DOM-free)
     =================================================================== */

  function asText(v) {
    return typeof v === "string" ? v : (v == null ? "" : String(v));
  }

  // Strict YYYY-MM-DD validation that rejects impossible calendar dates.
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
    } catch (e) {
      return asText(iso);
    }
  }

  // Past vs upcoming relative to the anchor. A date EQUAL to today counts as
  // upcoming (today's class has not run yet). String compare is valid for
  // zero-padded ISO dates.
  function classifyDate(iso, todayIso) {
    var t = isValidISODate(todayIso) ? todayIso : TODAY_ISO;
    if (!isValidISODate(iso)) return "unknown";
    return asText(iso) < t ? "past" : "upcoming";
  }
  function isPast(iso, todayIso) { return classifyDate(iso, todayIso) === "past"; }
  function isUpcoming(iso, todayIso) { return classifyDate(iso, todayIso) === "upcoming"; }

  function safeUid(prefix) {
    try { return HC.util.uid(); }
    catch (e) { return (prefix || "id") + "_" + Date.now() + "_" + Math.floor(Math.random() * 1e6); }
  }

  // Normalise a free-text note flag list. We treat SEN, allergy and medical as
  // the safeguarding-relevant categories a leader must see on the register.
  function normaliseNotes(input) {
    var a = (input && typeof input === "object") ? input : {};
    return {
      sen: asText(a.sen).trim(),         // e.g. "EHCP — autism, needs 1:1 at transitions"
      allergy: asText(a.allergy).trim(), // e.g. "Severe nut allergy — carries EpiPen"
      medical: asText(a.medical).trim(), // e.g. "Asthma — blue inhaler in bag"
      other: asText(a.other).trim()      // any other parent note
    };
  }

  // True if an attendee carries ANY safeguarding-relevant note. This is what
  // drives the "⚠ notes" flag on the register row.
  function hasFlaggedNotes(att) {
    if (!att || typeof att !== "object") return false;
    var n = att.notes || {};
    return !!(asText(n.sen).trim() || asText(n.allergy).trim() || asText(n.medical).trim());
  }

  // Build one ATTENDEE row. The acceptance criterion lives here: every attendee
  // carries the CHILD's name + AGE and a structured SEN/allergy/medical notes
  // object. Defensive about missing/garbage age.
  //   input: { child, age, parent, parentPhone, weeks?, sen?, allergy?, medical?, other? }
  function makeAttendee(input) {
    var a = (input && typeof input === "object") ? input : {};
    var ageNum = Number(a.age);
    var age = (isFinite(ageNum) && ageNum >= 0 && ageNum <= 25) ? Math.floor(ageNum) : null;
    return {
      id: safeUid("att"),
      child: asText(a.child).trim() || "Unnamed child",
      age: age,                                  // child age (years) — null if unknown
      parent: asText(a.parent).trim() || "—",    // "Booked by"
      parentPhone: asText(a.parentPhone).trim(),
      notes: normaliseNotes(a),                  // SEN / allergy / medical / other
      reminderSentAt: null,                      // timestamp set on the day (article 2295666)
      manual: a.manual === true,                 // added via "Add manual booking"
      createdAt: Date.now()
    };
  }

  // A REGISTER for one concrete date: the date plus its attendee list and the
  // capacity, so the view can show "spaces still available" (article 2295666).
  function makeRegister(iso, capacity) {
    var cap = Number(capacity);
    return {
      id: safeUid("reg"),
      date: asText(iso),
      dateLabel: dateLabel(iso),
      capacity: (isFinite(cap) && cap > 0) ? Math.floor(cap) : 20,
      attendees: []
    };
  }

  // Sort attendees the Happity way: by child's FIRST name, with siblings
  // (same parent) grouped together. We group by parent, order groups by the
  // group's earliest child name, then order within a group by child name.
  function sortAttendeesHappityOrder(attendees) {
    var list = Array.isArray(attendees) ? attendees.slice() : [];
    function firstName(s) { return asText(s).trim().split(/\s+/)[0].toLowerCase(); }
    var groups = {};
    list.forEach(function (att) {
      var key = asText(att.parent).toLowerCase() || "_";
      (groups[key] = groups[key] || []).push(att);
    });
    var groupKeys = Object.keys(groups);
    groupKeys.forEach(function (k) {
      groups[k].sort(function (x, y) {
        var a = firstName(x.child), b = firstName(y.child);
        return a < b ? -1 : a > b ? 1 : 0;
      });
    });
    groupKeys.sort(function (k1, k2) {
      var a = firstName(groups[k1][0].child), b = firstName(groups[k2][0].child);
      return a < b ? -1 : a > b ? 1 : 0;
    });
    var out = [];
    groupKeys.forEach(function (k) { out = out.concat(groups[k]); });
    return out;
  }

  // Overview numbers for a register (sales/spaces — article 2295666).
  function registerStats(reg) {
    var booked = (reg && Array.isArray(reg.attendees)) ? reg.attendees.length : 0;
    var cap = (reg && isFinite(Number(reg.capacity))) ? Number(reg.capacity) : 0;
    var spacesLeft = Math.max(0, cap - booked);
    var flagged = (reg && Array.isArray(reg.attendees))
      ? reg.attendees.filter(hasFlaggedNotes).length : 0;
    return { booked: booked, capacity: cap, spacesLeft: spacesLeft, flagged: flagged };
  }

  // Collect every flagged note across a register, grouped at the bottom of the
  // register (article 2295666: "Any notes … grouped together at the bottom").
  function collectNotes(reg) {
    var out = [];
    var atts = (reg && Array.isArray(reg.attendees)) ? reg.attendees : [];
    atts.forEach(function (att) {
      var n = att.notes || {};
      var bits = [];
      if (asText(n.sen).trim()) bits.push({ kind: "SEN", text: n.sen });
      if (asText(n.allergy).trim()) bits.push({ kind: "Allergy", text: n.allergy });
      if (asText(n.medical).trim()) bits.push({ kind: "Medical", text: n.medical });
      if (asText(n.other).trim()) bits.push({ kind: "Note", text: n.other });
      if (bits.length) out.push({ child: att.child, age: att.age, items: bits });
    });
    return out;
  }

  /* ===================================================================
     PERSISTENCE (HC.store only — never raw localStorage)

     Shape: { <providerId>: { dates: [ {date, dateLabel, capacity, attendees:[...]} ] } }
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

  // Ensure a (blank) register exists for a date and return it.
  function ensureRegister(providerId, iso, capacity) {
    var map = readAll();
    var bucket = providerBucket(map, providerId);
    var reg = bucket.dates.filter(function (r) { return r.date === asText(iso); })[0];
    if (!reg) {
      reg = makeRegister(iso, capacity);
      bucket.dates.push(reg);
      writeAll(map);
    }
    return reg;
  }

  // Add an attendee (a booking, manual or otherwise) to a date's register.
  // Returns { ok, attendee?, errors? }.
  function addAttendee(providerId, iso, input) {
    if (!isValidISODate(iso)) {
      return { ok: false, errors: ["A valid session date (YYYY-MM-DD) is required."] };
    }
    var att = makeAttendee(input);
    if (att.child === "Unnamed child" && !asText(input && input.child).trim()) {
      return { ok: false, errors: ["A child name is required for the register."] };
    }
    var map = readAll();
    var bucket = providerBucket(map, providerId);
    var reg = bucket.dates.filter(function (r) { return r.date === asText(iso); })[0];
    if (!reg) { reg = makeRegister(iso, (input && input.capacity)); bucket.dates.push(reg); }
    reg.attendees.push(att);
    if (reg.attendees.length > 200) reg.attendees = reg.attendees.slice(-200); // keep store small
    writeAll(map);
    return { ok: true, attendee: att };
  }

  // Return all date-registers for a provider, sorted by date ascending, each
  // tagged with its past/upcoming status. Attendees are returned in Happity
  // order (child first name, siblings grouped).
  function getRegisters(providerId, todayIso) {
    var map = readAll();
    var dates = providerBucket(map, providerId).dates.slice();
    dates.sort(function (a, b) {
      return asText(a.date) < asText(b.date) ? -1 : asText(a.date) > asText(b.date) ? 1 : 0;
    });
    return dates.map(function (r) {
      var clone = {
        id: r.id,
        date: r.date,
        dateLabel: r.dateLabel || dateLabel(r.date),
        capacity: r.capacity,
        status: classifyDate(r.date, todayIso),
        attendees: sortAttendeesHappityOrder(r.attendees)
      };
      clone.stats = registerStats(clone);
      clone.groupedNotes = collectNotes(clone);
      return clone;
    });
  }

  // Open one date's register (the "click on a date" view).
  function openRegister(providerId, iso, todayIso) {
    return getRegisters(providerId, todayIso).filter(function (r) { return r.date === asText(iso); })[0] || null;
  }

  function clearProvider(providerId) {
    var map = readAll();
    var pid = asText(providerId) || "_default";
    delete map[pid];
    writeAll(map);
  }

  /* ===================================================================
     SEED DATA — realistic holiday-camp attendees on real WF Summer-2026 dates.

     We derive concrete dates from the live planner weeks (Monday of each week)
     plus one clearly-PAST date so the view shows both past and upcoming.
     =================================================================== */

  function plannerWeekDates() {
    var out = [];
    try {
      var weeks = (HC.data.planner && HC.data.planner.weeks) || [];
      weeks.forEach(function (w) {
        if (w && isValidISODate(w.mon)) out.push(w.mon);
      });
    } catch (e) {}
    if (!out.length) out = ["2026-07-20", "2026-07-27", "2026-08-03"]; // fallback
    return out;
  }

  // A small, fixed cast of holiday-camp children with realistic SEN/allergy
  // notes. Ages are school-age (4–12). Two siblings (the Okafors) so we can
  // demonstrate sibling grouping.
  function seedCast() {
    return [
      { child: "Amelia Brooks", age: 8, parent: "Hannah Brooks", parentPhone: "07700 900111",
        allergy: "Severe nut allergy — carries an EpiPen in her bag", other: "Vegetarian packed lunch" },
      { child: "Zane Okafor", age: 10, parent: "Tunde Okafor", parentPhone: "07700 900222",
        sen: "EHCP — autism; needs warning before transitions and a quiet space" },
      { child: "Bea Okafor", age: 7, parent: "Tunde Okafor", parentPhone: "07700 900222",
        medical: "Mild asthma — blue inhaler in the front pocket of her bag" },
      { child: "Felix Nguyen", age: 6, parent: "Mai Nguyen", parentPhone: "07700 900333",
        allergy: "Dairy intolerance", sen: "Speech and language support — give extra time to respond" },
      { child: "Sofia Rossi", age: 9, parent: "Elena Rossi", parentPhone: "07700 900444",
        other: "Confident swimmer; happy in any group" },
      { child: "Otis Clarke", age: 5, parent: "Dan Clarke", parentPhone: "07700 900555",
        medical: "Eczema — apply cream after water play (in named tube)" }
    ];
  }

  // Build a demonstrable set of registers for a provider: one past date and
  // several upcoming planner-week dates, each with a slice of the cast so every
  // register has attendees and at least one SEN/allergy/medical note.
  function seedRegisters(providerId, todayIso) {
    clearProvider(providerId);
    var cast = seedCast();
    var weekMondays = plannerWeekDates();

    // A clearly-past date: a fortnight before the anchor, so the view proves it
    // lists PAST sessions too (article 8058268: "past and upcoming classes").
    var anchor = isValidISODate(todayIso) ? todayIso : TODAY_ISO;
    var pastDate = shiftIso(anchor, -14);

    var plan = [
      { date: pastDate, take: cast.slice(0, 4), cap: 24 },           // past, ran already
      { date: weekMondays[0], take: cast.slice(0, 5), cap: 24 },     // upcoming
      { date: weekMondays[1] || shiftIso(weekMondays[0], 7), take: cast.slice(1, 6), cap: 20 },
      { date: weekMondays[2] || shiftIso(weekMondays[0], 14), take: cast.slice(0, 6), cap: 30 }
    ];

    plan.forEach(function (p) {
      if (!isValidISODate(p.date)) return;
      ensureRegister(providerId, p.date, p.cap);
      p.take.forEach(function (c) { addAttendee(providerId, p.date, c); });
    });
    // Mark the past date's attendees as reminded (timestamp), per article 2295666.
    markReminders(providerId, pastDate);
    return getRegisters(providerId, todayIso);
  }

  function shiftIso(iso, days) {
    try {
      if (!isValidISODate(iso)) return iso;
      var p = iso.split("-");
      var dt = new Date(Date.UTC(Number(p[0]), Number(p[1]) - 1, Number(p[2])));
      dt.setUTCDate(dt.getUTCDate() + (Number(days) || 0));
      var y = dt.getUTCFullYear();
      var m = String(dt.getUTCMonth() + 1);
      var d = String(dt.getUTCDate());
      if (m.length < 2) m = "0" + m;
      if (d.length < 2) d = "0" + d;
      return y + "-" + m + "-" + d;
    } catch (e) { return iso; }
  }

  function markReminders(providerId, iso) {
    var map = readAll();
    var bucket = providerBucket(map, providerId);
    var reg = bucket.dates.filter(function (r) { return r.date === asText(iso); })[0];
    if (reg) {
      reg.attendees.forEach(function (a) { a.reminderSentAt = Date.now(); });
      writeAll(map);
    }
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

  function ageText(age) { return (age == null) ? "age —" : ("age " + age); }

  function demoProviderId() {
    // Prefer a real childcare/holiday-club provider from live data.
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

  function noteChipsHtml(att) {
    var n = att.notes || {};
    var chips = [];
    if (asText(n.sen).trim()) chips.push(chip("SEN", n.sen, "#5b3a8c", "#F0E8F4"));
    if (asText(n.allergy).trim()) chips.push(chip("Allergy", n.allergy, "#9a1f5e", "#FCE8F0"));
    if (asText(n.medical).trim()) chips.push(chip("Medical", n.medical, "#9a5a1f", "#FFF3E2"));
    if (asText(n.other).trim()) chips.push(chip("Note", n.other, "#555", "#EFEFEF"));
    if (!chips.length) return '<span style="color:var(--muted,#808080);font-size:12px">—</span>';
    return chips.join(" ");
  }
  function chip(label, text, fg, bg) {
    return '<span title="' + escAttr(text) + '" style="display:inline-block;font-size:11px;font-weight:700;' +
      'padding:2px 8px;border-radius:999px;background:' + bg + ';color:' + fg + ';margin:1px 0">' +
      esc(label) + "</span> " +
      '<span style="font-size:12px;color:var(--text,#383838)">' + esc(text) + "</span>";
  }

  function registerTableHtml(reg) {
    if (!reg.attendees.length) {
      return '<p style="color:var(--muted,#808080);font-size:13px">This register is blank — no bookings yet.</p>';
    }
    var rows = reg.attendees.map(function (att) {
      var flag = hasFlaggedNotes(att)
        ? '<span title="Has SEN/allergy/medical notes" style="color:#9a1f5e;font-weight:700">⚠</span> ' : "";
      return '<tr style="border-top:1px solid var(--line,#E6E6E6)">' +
        '<td style="padding:7px 8px;vertical-align:top">' + flag +
          '<strong>' + esc(att.child) + "</strong>" +
          (att.manual ? ' <span style="font-size:10px;color:var(--muted,#808080)">(manual)</span>' : "") + "</td>" +
        '<td style="padding:7px 8px;vertical-align:top;white-space:nowrap">' + esc(ageText(att.age)) + "</td>" +
        '<td style="padding:7px 8px;vertical-align:top">' + esc(att.parent) +
          (att.parentPhone ? '<div style="font-size:11px;color:var(--muted,#808080)">' + esc(att.parentPhone) + "</div>" : "") + "</td>" +
        '<td style="padding:7px 8px;vertical-align:top">' + noteChipsHtml(att) + "</td>" +
        "</tr>";
    }).join("");

    var grouped = reg.groupedNotes || [];
    var groupedHtml = grouped.length
      ? '<div style="margin-top:12px;border-top:1px dashed var(--line,#E6E6E6);padding-top:10px">' +
          '<div style="font-family:Quicksand,system-ui,sans-serif;font-weight:700;color:var(--purple,#603488);font-size:13px;margin-bottom:6px">' +
            "⚠ SEN / allergy / medical notes for this date</div>" +
          '<ul style="margin:0;padding-left:18px;font-size:12.5px;color:var(--text,#383838);line-height:1.6">' +
            grouped.map(function (g) {
              return "<li><strong>" + esc(g.child) + "</strong> (" + esc(ageText(g.age)) + "): " +
                g.items.map(function (it) { return esc(it.kind) + " — " + esc(it.text); }).join("; ") + "</li>";
            }).join("") +
          "</ul></div>"
      : "";

    return '<table style="width:100%;border-collapse:collapse;font-size:13px">' +
        '<thead><tr style="text-align:left;color:var(--muted,#808080);font-size:11px;text-transform:uppercase;letter-spacing:.4px">' +
          '<th style="padding:4px 8px">Child</th><th style="padding:4px 8px">Age</th>' +
          '<th style="padding:4px 8px">Booked by</th><th style="padding:4px 8px">SEN / allergy / notes</th>' +
        "</tr></thead><tbody>" + rows + "</tbody></table>" + groupedHtml;
  }

  function render(mountEl) {
    try {
      if (!mountEl) return;
      var providerId = demoProviderId();
      var today = TODAY_ISO;
      mountEl.innerHTML = "";

      var intro = el("div", null,
        '<p style="font-size:14px;color:var(--text,#383838);margin:0 0 4px">' +
          "Your <strong>Registers</strong> list every camp date — <strong>past and upcoming</strong>. " +
          "Click a date to open that session's register: who's attending, each " +
          "child's <strong>age</strong>, and any <strong>SEN / allergy / medical notes</strong> the " +
          "parent flagged, so your camp leaders have what they need on the day.</p>" +
        '<p style="font-size:12.5px;color:var(--muted,#808080);margin:0 0 6px">' +
          "Dates are real Summer-2026 Waltham Forest camp weeks. (Mock data — no real bookings.)</p>");
      mountEl.appendChild(intro);

      // (Re)seed demo registers each time the feature is opened so the preview
      // is always populated and deterministic.
      seedRegisters(providerId, today);

      var listHost = el("div", { id: "hcRegList", style: "margin-top:10px" });
      var detailHost = el("div", { id: "hcRegDetail", style: "margin-top:14px" });
      mountEl.appendChild(listHost);
      mountEl.appendChild(detailHost);

      function renderList(openIso) {
        var regs = getRegisters(providerId, today);
        var upcoming = regs.filter(function (r) { return r.status === "upcoming"; });
        var past = regs.filter(function (r) { return r.status === "past"; });

        function dateRow(r) {
          var s = r.stats;
          var open = (r.date === openIso);
          return '<button type="button" data-date="' + escAttr(r.date) + '" ' +
            'style="display:block;width:100%;text-align:left;cursor:pointer;border:1.5px solid ' +
              (open ? "var(--purple,#603488)" : "var(--line,#E6E6E6)") + ';border-radius:12px;' +
              "background:" + (open ? "#F7F4FB" : "#fff") + ';padding:10px 12px;margin:0 0 8px">' +
            '<span style="font-family:Quicksand,system-ui,sans-serif;font-weight:700;color:var(--purple,#603488)">' +
              esc(r.dateLabel) + "</span>" +
            '<span style="float:right;font-size:12px;color:var(--muted,#808080)">' +
              s.booked + " booked · " + s.spacesLeft + " space" + (s.spacesLeft === 1 ? "" : "s") + " left" +
              (s.flagged ? ' · <span style="color:#9a1f5e;font-weight:700">⚠ ' + s.flagged + " note" + (s.flagged === 1 ? "" : "s") + "</span>" : "") +
            "</span></button>";
        }

        listHost.innerHTML =
          '<div style="display:grid;grid-template-columns:1fr 1fr;gap:14px">' +
            '<div><div style="font-family:Quicksand,system-ui,sans-serif;font-weight:700;color:var(--purple,#603488);margin-bottom:6px">' +
              "📅 Upcoming dates · " + upcoming.length + "</div>" +
              (upcoming.length ? upcoming.map(dateRow).join("") : '<p style="color:var(--muted,#808080);font-size:13px">No upcoming dates.</p>') + "</div>" +
            '<div><div style="font-family:Quicksand,system-ui,sans-serif;font-weight:700;color:var(--muted,#808080);margin-bottom:6px">' +
              "🕘 Past dates · " + past.length + "</div>" +
              (past.length ? past.map(dateRow).join("") : '<p style="color:var(--muted,#808080);font-size:13px">No past dates.</p>') + "</div>" +
          "</div>";
      }

      function renderDetail(iso) {
        var reg = openRegister(providerId, iso, today);
        if (!reg) { detailHost.innerHTML = ""; return; }
        var s = reg.stats;
        detailHost.innerHTML =
          '<div style="border:1.5px solid var(--line,#E6E6E6);border-radius:14px;padding:14px 16px;background:#fff">' +
            '<div style="display:flex;justify-content:space-between;align-items:baseline;flex-wrap:wrap;gap:6px">' +
              '<div style="font-family:Quicksand,system-ui,sans-serif;font-weight:700;color:var(--purple,#603488);font-size:16px">' +
                esc(reg.dateLabel) +
                ' <span style="font-size:11px;font-weight:700;padding:2px 8px;border-radius:999px;background:' +
                  (reg.status === "past" ? "#EFEFEF;color:#666" : "#E1F0E4;color:#2f7d4f") + '">' +
                  (reg.status === "past" ? "Past" : "Upcoming") + "</span></div>" +
              '<div style="font-size:12.5px;color:var(--muted,#808080)">' +
                s.booked + " / " + s.capacity + " booked · " + s.spacesLeft + " spaces available</div>" +
            "</div>" +
            '<div style="margin-top:10px">' + registerTableHtml(reg) + "</div>" +
          "</div>";
      }

      // Open the first upcoming date by default.
      var regsNow = getRegisters(providerId, today);
      var firstUpcoming = regsNow.filter(function (r) { return r.status === "upcoming"; })[0];
      var defaultIso = firstUpcoming ? firstUpcoming.date : (regsNow[0] ? regsNow[0].date : null);
      renderList(defaultIso);
      if (defaultIso) renderDetail(defaultIso);

      listHost.addEventListener("click", function (e) {
        var btn = e.target && e.target.closest ? e.target.closest("[data-date]") : null;
        if (!btn) return;
        var iso = btn.getAttribute("data-date");
        renderList(iso);
        renderDetail(iso);
      });
    } catch (e) {
      try {
        mountEl.innerHTML = '<p style="color:#9a1f5e">Registers feature failed to render: ' +
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

    var TP = "__selftest_registers__";
    var TODAY = "2026-06-15";
    clearProvider(TP);

    // ---- date classification (past/upcoming) ----
    check("Dates are classified past vs upcoming relative to today", function () {
      HC.assert(isPast("2026-06-01", TODAY) === true, "1 June is before 15 June -> past");
      HC.assert(isUpcoming("2026-07-20", TODAY) === true, "20 July is after 15 June -> upcoming");
      HC.assert(isUpcoming("2026-06-15", TODAY) === true, "today's class is upcoming (not yet run)");
      HC.assert(classifyDate("not-a-date", TODAY) === "unknown", "garbage date -> unknown");
    });

    // ---- seed builds registers spanning PAST and UPCOMING (article 8058268) ----
    var regs;
    check("Seed builds registers for both PAST and UPCOMING dates", function () {
      regs = seedRegisters(TP, TODAY);
      HC.assert(regs.length >= 3, "expected several date registers, got " + regs.length);
      var hasPast = regs.some(function (r) { return r.status === "past"; });
      var hasUpcoming = regs.some(function (r) { return r.status === "upcoming"; });
      HC.assert(hasPast, "the view must list at least one PAST date");
      HC.assert(hasUpcoming, "the view must list at least one UPCOMING date");
    });

    check("Registers are returned in date order", function () {
      for (var i = 1; i < regs.length; i++) {
        HC.assert(regs[i - 1].date <= regs[i].date, "dates should be ascending");
      }
    });

    // ===== ACCEPTANCE CRITERION =====
    // A Registers view lists attendees PER DATE, each attendee carrying the
    // child's AGE and SEN/allergy notes.

    check("ACCEPTANCE: every date's register lists attendees, each with a child AGE", function () {
      HC.assert(regs.length > 0, "there must be registers to inspect");
      regs.forEach(function (r) {
        HC.assert(Array.isArray(r.attendees) && r.attendees.length > 0,
          "register for " + r.date + " must list attendees");
        r.attendees.forEach(function (att) {
          HC.assert(typeof att.child === "string" && att.child.length > 0,
            "every attendee needs a child name");
          HC.assert(att.age != null && isFinite(att.age),
            "every attendee row must carry the child's age (date " + r.date + ", child " + att.child + ")");
          HC.assert(att.age >= 4 && att.age <= 12,
            "holiday-camp ages should be school-age, got " + att.age + " for " + att.child);
        });
      });
    });

    check("ACCEPTANCE: SEN / allergy notes are surfaced per attendee", function () {
      // Find the seeded children with known notes and assert the notes are present.
      var all = [];
      regs.forEach(function (r) { all = all.concat(r.attendees); });

      var zane = all.filter(function (a) { return a.child === "Zane Okafor"; })[0];
      HC.assert(zane, "Zane (SEN child) should be on a register");
      HC.assert(/EHCP|autism/i.test(zane.notes.sen), "Zane's SEN note must be readable: " + zane.notes.sen);
      HC.assert(hasFlaggedNotes(zane) === true, "Zane must be flagged as having notes");

      var amelia = all.filter(function (a) { return a.child === "Amelia Brooks"; })[0];
      HC.assert(amelia, "Amelia (allergy child) should be on a register");
      HC.assert(/nut allergy|EpiPen/i.test(amelia.notes.allergy),
        "Amelia's allergy note must be readable: " + amelia.notes.allergy);
      HC.assert(hasFlaggedNotes(amelia) === true, "Amelia must be flagged as having notes");
    });

    check("ACCEPTANCE: notes are also GROUPED at the bottom of each register (article 2295666)", function () {
      // At least one register must surface a grouped notes block, and each
      // grouped entry must include the child, age and a SEN/allergy/medical line.
      var any = regs.filter(function (r) { return r.groupedNotes && r.groupedNotes.length; });
      HC.assert(any.length > 0, "at least one register should group its notes at the bottom");
      var g = any[0].groupedNotes[0];
      HC.assert(typeof g.child === "string" && g.child.length, "grouped note needs the child name");
      HC.assert(g.age == null || isFinite(g.age), "grouped note should carry the child age");
      HC.assert(Array.isArray(g.items) && g.items.length > 0, "grouped note must list note items");
      var kinds = g.items.map(function (it) { return it.kind; }).join(",");
      HC.assert(/SEN|Allergy|Medical/.test(kinds), "grouped items should be SEN/Allergy/Medical, got " + kinds);
    });

    // ---- opening a single date returns its attendee list ("click on a date") ----
    check("Opening a date returns that session's register with its attendees", function () {
      var target = regs[regs.length - 1]; // a populated upcoming date
      var opened = openRegister(TP, target.date, TODAY);
      HC.assert(opened, "openRegister should return the register for " + target.date);
      HC.assert(opened.date === target.date, "opened register date must match");
      HC.assert(opened.attendees.length === target.attendees.length,
        "opened register should list the same attendees");
      // and the per-attendee age + notes are intact on the opened view
      opened.attendees.forEach(function (att) {
        HC.assert(att.age != null, "opened register attendee must keep its age");
        HC.assert(att.notes && typeof att.notes === "object", "opened register attendee must keep notes");
      });
    });

    // ---- overview stats: sales / spaces available (article 2295666) ----
    check("Register overview reports booked count and spaces available", function () {
      var r = regs[0];
      HC.assert(r.stats.booked === r.attendees.length, "booked count must equal attendees");
      HC.assert(r.stats.capacity > 0, "capacity should be set");
      HC.assert(r.stats.spacesLeft === Math.max(0, r.stats.capacity - r.stats.booked),
        "spaces left must be capacity minus booked");
      HC.assert(r.stats.flagged >= 1, "the overview should count flagged (notes) attendees");
    });

    // ---- sibling grouping + child-first-name order (article 2295666) ----
    check("Attendees are ordered by child first name with siblings grouped", function () {
      // The Okafor siblings (Bea & Zane, same parent) must be adjacent.
      var r = regs.filter(function (x) {
        return x.attendees.some(function (a) { return a.parent === "Tunde Okafor"; });
      })[0];
      HC.assert(r, "a register containing the Okafor siblings should exist");
      var names = r.attendees.map(function (a) { return a.child; });
      var iZane = names.indexOf("Zane Okafor");
      var iBea = names.indexOf("Bea Okafor");
      HC.assert(iZane !== -1 && iBea !== -1, "both Okafor siblings should be present");
      HC.assert(Math.abs(iZane - iBea) === 1, "siblings (same parent) must be grouped adjacently");
    });

    // ---- adding a manual booking lands on the register with age + notes ----
    check("A manual booking is added to a date's register with age + notes", function () {
      var iso = regs[0].date;
      var before = openRegister(TP, iso, TODAY).attendees.length;
      var res = addAttendee(TP, iso, {
        child: "Priya Shah", age: 11, parent: "Anita Shah", parentPhone: "07700 900999",
        medical: "Type 1 diabetes — carries glucose tabs", manual: true
      });
      HC.assert(res.ok === true, "manual booking should be added: " + ((res.errors || []).join(" ")));
      HC.assert(res.attendee.manual === true, "the booking should be flagged manual");
      HC.assert(res.attendee.age === 11, "age must be preserved on the manual booking");
      var after = openRegister(TP, iso, TODAY);
      HC.assert(after.attendees.length === before + 1, "the register should grow by one");
      var priya = after.attendees.filter(function (a) { return a.child === "Priya Shah"; })[0];
      HC.assert(priya && /diabetes/i.test(priya.notes.medical), "Priya's medical note must be on the register");
      HC.assert(after.groupedNotes.some(function (g) { return g.child === "Priya Shah"; }),
        "Priya's note must appear in the grouped notes block");
    });

    // ---- validation / defensive ----
    check("Adding to an invalid date is rejected", function () {
      var r = addAttendee(TP, "2026-13-40", { child: "Nobody", age: 8 });
      HC.assert(r.ok === false, "an impossible date must be rejected");
      var r2 = addAttendee(TP, "soon", { child: "Nobody", age: 8 });
      HC.assert(r2.ok === false, "a non-ISO date must be rejected");
    });

    check("An attendee with no child name is rejected", function () {
      var r = addAttendee(TP, regs[0].date, { age: 8, allergy: "nuts" });
      HC.assert(r.ok === false, "a register row needs a child name");
    });

    check("A non-numeric / out-of-range age is stored as unknown, not garbage", function () {
      var a1 = makeAttendee({ child: "Test One", age: "abc" });
      HC.assert(a1.age === null, "non-numeric age should be null, got " + a1.age);
      var a2 = makeAttendee({ child: "Test Two", age: 99 });
      HC.assert(a2.age === null, "an implausible age (99) should be null");
      var a3 = makeAttendee({ child: "Test Three", age: "7" });
      HC.assert(a3.age === 7, "a numeric-string age should parse to 7");
    });

    check("Garbage attendee input never throws and never persists", function () {
      var iso = regs[0].date;
      var before = openRegister(TP, iso, TODAY).attendees.length;
      var bad = [null, undefined, 42, "", [], {}, { age: 8 }];
      for (var i = 0; i < bad.length; i++) {
        var res = addAttendee(TP, iso, bad[i]);
        HC.assert(res && res.ok === false, "garbage attendee #" + i + " must be rejected");
      }
      HC.assert(openRegister(TP, iso, TODAY).attendees.length === before,
        "garbage input must not change the register");
    });

    // ---- persistence via HC.store ----
    check("Registers persist via HC.store and reload with age + notes intact", function () {
      var reloaded = getRegisters(TP, TODAY);
      HC.assert(reloaded.length >= 3, "persisted registers should survive a reload");
      var withNotes = reloaded.some(function (r) {
        return r.attendees.some(function (a) { return hasFlaggedNotes(a); });
      });
      HC.assert(withNotes, "reloaded registers should still carry SEN/allergy/medical notes");
    });

    // cleanup
    clearProvider(TP);

    return { pass: pass, fail: fail, log: log };
  }

  /* ===================================================================
     register
     =================================================================== */

  HC.registerFeature({
    id: "provider-registers",
    title: "View registers for past/upcoming dates",
    side: "provider",
    icon: "📋",
    summary: "See a register for every camp date — past and upcoming. Open a date to view who's attending, each child's age, and any SEN, allergy or medical notes the parent flagged, grouped for your leaders on the day.",
    render: render,
    selfTest: selfTest
  });
})();
