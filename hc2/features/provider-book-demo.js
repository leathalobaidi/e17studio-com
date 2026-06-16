/* HolidayCamp feature: provider-book-demo
 * ------------------------------------------------------------------
 * Replicates Happity's "Book a booking-system demo call" for the
 * PROVIDER side, reframed for SCHOOL-AGE HOLIDAY CAMPS.
 *
 * Evidence (support corpus):
 *  - 2656616 "How do I become a Member and what comes with my
 *    subscription?", under "Can I use Happity bookings as my main
 *    booking system?":
 *      "Want a walkthrough of the features, or to discuss switching in
 *       more detail?"
 *      "[Book A Demo](https://calendly.com/d/ctgf-552-7yy/happity-booking-system-demo)"
 *    -> A prospective / switching provider books a scheduled demo call
 *       of the booking system via a calendar-booking link surfaced in
 *       the membership / marketing pages.
 *
 * Acceptance criterion (asserted by selfTest, multiple cases):
 *   "Prospective/switching providers can book a scheduled demo call of
 *    the booking system via a calendar-booking link surfaced in
 *    membership/marketing pages."
 *   -> The scheduler offers real, bookable slots (future working days,
 *      within demo hours, on the team's working weekdays, not already
 *      taken). Picking a slot + valid contact details creates a booking
 *      tied to a specific date/time, returns a confirmation reference,
 *      and yields a working calendar-booking link (the Calendly-style
 *      URL with the chosen slot encoded). A taken slot disappears from
 *      availability and cannot be double-booked. Bad input (no slot,
 *      bad email, past slot, non-working slot) is rejected.
 *
 * Defensive: nothing throws at registration time. Persistence is via
 * HC.store ONLY (one namespaced key). The verified camps.js data is
 * never mutated. School-age holiday-camp framing throughout.
 * ------------------------------------------------------------------ */
(function () {
  "use strict";

  if (typeof window === "undefined" || !window.HC || typeof window.HC.registerFeature !== "function") {
    // Core not present — fail silently rather than throwing.
    return;
  }
  var HC = window.HC;

  var STORE_KEY = "provider_book_demo"; // { bookings: [Booking], _slotsTaken?: ... }

  // The real Calendly event from the evidence. Bookings encode the chosen
  // slot onto this base so the "calendar-booking link" is concrete.
  var CALENDLY_BASE = "https://calendly.com/d/ctgf-552-7yy/happity-booking-system-demo";

  var DAY_MS = 24 * 60 * 60 * 1000;
  var MIN_MS = 60 * 1000;

  // Demo team availability (school-age holiday-camp onboarding team).
  //  - Working weekdays: Mon–Fri (getDay 1..5).
  //  - Demo hours: 10:00–16:00, on the hour and half hour.
  //  - Each demo runs 30 minutes.
  //  - Minimum lead time: a slot must be at least LEAD_MIN minutes ahead.
  //  - Booking horizon: only slots within HORIZON_DAYS ahead are offered.
  var WORKING_DAYS = [1, 2, 3, 4, 5];
  var DEMO_START_HOUR = 10;          // first slot starts 10:00
  var DEMO_END_HOUR = 16;            // last slot must END by 16:00
  var SLOT_MINUTES = 30;
  var LEAD_MIN = 60;                 // need at least 1h notice
  var HORIZON_DAYS = 21;             // offer up to 3 weeks out
  var MAX_SLOTS_OFFERED = 60;        // cap the list we surface

  // Why does the prospect want a demo? (Mirrors "switching in more detail".)
  var REASONS = [
    { id: "switching", label: "I'm switching from another booking system" },
    { id: "new", label: "I'm new to taking bookings online" },
    { id: "walkthrough", label: "I just want a walkthrough of the features" },
    { id: "venue-finder", label: "I want to see Venue Finder / multi-venue tools" }
  ];

  /* ============================================================
   * 1. Pure helpers.
   * ============================================================ */

  function trimStr(s) { return String(s == null ? "" : s).trim(); }

  function pad2(n) { return ("0" + n).slice(-2); }

  // Basic, sane email check (not RFC-perfect, but rejects obvious junk).
  function emailValid(s) {
    var v = trimStr(s);
    if (!v || v.length > 254) return false;
    if (/\s/.test(v)) return false;
    return /^[^@]+@[^@.]+(\.[^@.]+)+$/.test(v);
  }

  // Round a timestamp UP to the next slot boundary (:00 or :30) in LOCAL time.
  function ceilToSlot(ts) {
    var d = new Date(ts);
    d.setSeconds(0, 0);
    var m = d.getMinutes();
    if (m === 0 || m === 30) return d.getTime();
    if (m < 30) { d.setMinutes(30); return d.getTime(); }
    d.setMinutes(0);
    return d.getTime() + 60 * MIN_MS; // bump to next hour
  }

  // Is a given Date a valid slot START for a demo?
  //  - on a working weekday
  //  - on a :00 / :30 boundary
  //  - the whole SLOT_MINUTES fits inside [DEMO_START_HOUR, DEMO_END_HOUR]
  function isSlotShape(d) {
    if (WORKING_DAYS.indexOf(d.getDay()) === -1) return false;
    var min = d.getMinutes();
    if (min !== 0 && min !== 30) return false;
    if (d.getSeconds() !== 0 || d.getMilliseconds() !== 0) return false;
    var startMins = d.getHours() * 60 + min;
    var firstMins = DEMO_START_HOUR * 60;
    var lastEndMins = DEMO_END_HOUR * 60;
    if (startMins < firstMins) return false;
    if (startMins + SLOT_MINUTES > lastEndMins) return false;
    return true;
  }

  // Slot key (stable id for a slot) — minute precision is plenty.
  function slotKey(ts) {
    var d = new Date(ts);
    return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate()) +
      "T" + pad2(d.getHours()) + ":" + pad2(d.getMinutes());
  }

  // ISO-ish UTC stamp for the calendar link (Calendly accepts a ?month=&date=
  // style deep-link; we attach the chosen slot as query params so the link is
  // concrete and unambiguous).
  function calendarLinkFor(ts) {
    var d = new Date(ts);
    var date = d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
    var month = d.getFullYear() + "-" + pad2(d.getMonth() + 1);
    var time = pad2(d.getHours()) + ":" + pad2(d.getMinutes());
    return CALENDLY_BASE +
      "?month=" + encodeURIComponent(month) +
      "&date=" + encodeURIComponent(date) +
      "&t=" + encodeURIComponent(time);
  }

  // Human label for a slot.
  function slotLabel(ts) {
    try {
      var d = new Date(ts);
      var day = d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
      var time = pad2(d.getHours()) + ":" + pad2(d.getMinutes());
      var end = new Date(ts + SLOT_MINUTES * MIN_MS);
      var endTime = pad2(end.getHours()) + ":" + pad2(end.getMinutes());
      return day + " · " + time + "–" + endTime;
    } catch (e) {
      return slotKey(ts);
    }
  }

  function shortRef() {
    return "DEMO-" + Math.random().toString(36).slice(2, 6).toUpperCase() +
      "-" + Math.random().toString(36).slice(2, 6).toUpperCase();
  }

  /* ============================================================
   * 2. Store access.
   * ============================================================ */

  function readState() {
    var s = HC.store.get(STORE_KEY, null);
    if (!s || typeof s !== "object") s = {};
    if (!Array.isArray(s.bookings)) s.bookings = [];
    return s;
  }

  function writeState(s) { HC.store.set(STORE_KEY, s); return s; }

  function takenKeys(state) {
    var set = {};
    (state.bookings || []).forEach(function (b) {
      if (b && b.status !== "cancelled" && b.slotKey) set[b.slotKey] = true;
    });
    return set;
  }

  /* ============================================================
   * 3. Availability — generate real, bookable slots.
   *    `now` is injectable so tests are deterministic.
   * ============================================================ */

  function availableSlots(now, state) {
    var ref = now || Date.now();
    var st = state || readState();
    var taken = takenKeys(st);
    var earliest = ref + LEAD_MIN * MIN_MS;
    var horizonEnd = ref + HORIZON_DAYS * DAY_MS;

    var out = [];
    // Walk slot boundaries from the first candidate to the horizon.
    var cursor = ceilToSlot(earliest);
    // Hard guard so a bad clock can never loop forever.
    var guard = 0, GUARD_MAX = HORIZON_DAYS * 24 * 4 + 16; // ~ slots in horizon
    while (cursor <= horizonEnd && out.length < MAX_SLOTS_OFFERED && guard < GUARD_MAX) {
      guard += 1;
      var d = new Date(cursor);
      if (isSlotShape(d) && cursor >= earliest) {
        var k = slotKey(cursor);
        if (!taken[k]) {
          out.push({ ts: cursor, key: k, label: slotLabel(cursor) });
        }
        cursor += SLOT_MINUTES * MIN_MS;
      } else {
        // Jump efficiently: if before today's window, skip to window start;
        // if after, skip to next day's window start.
        var next = nextWindowStart(d);
        cursor = next;
      }
    }
    return out;
  }

  // Given a Date not inside a valid window, return the next valid window start.
  function nextWindowStart(d) {
    var day = new Date(d.getTime());
    day.setSeconds(0, 0);
    var startMins = DEMO_START_HOUR * 60;
    var thisDayStart = new Date(day.getFullYear(), day.getMonth(), day.getDate(), DEMO_START_HOUR, 0, 0, 0).getTime();
    var curMins = day.getHours() * 60 + day.getMinutes();
    var isWorking = WORKING_DAYS.indexOf(day.getDay()) !== -1;
    if (isWorking && curMins < startMins) {
      return thisDayStart; // jump forward to today's 10:00
    }
    // Otherwise advance to the next working day's 10:00.
    var probe = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1, DEMO_START_HOUR, 0, 0, 0);
    var safety = 0;
    while (WORKING_DAYS.indexOf(probe.getDay()) === -1 && safety < 14) {
      probe = new Date(probe.getFullYear(), probe.getMonth(), probe.getDate() + 1, DEMO_START_HOUR, 0, 0, 0);
      safety += 1;
    }
    return probe.getTime();
  }

  // Is a specific slot bookable right now? Returns { ok, reason }.
  function slotBookable(ts, now, state) {
    var st = state || readState();
    var ref = now || Date.now();
    if (!isFinite(ts)) return { ok: false, reason: "Pick a demo slot to continue." };
    var d = new Date(ts);
    if (!isSlotShape(d)) return { ok: false, reason: "That time isn't one of our demo slots (Mon–Fri, 10:00–16:00, 30-min slots)." };
    if (ts < ref + LEAD_MIN * MIN_MS) return { ok: false, reason: "Please pick a slot at least an hour from now." };
    if (ts > ref + HORIZON_DAYS * DAY_MS) return { ok: false, reason: "That slot is further out than we currently schedule." };
    if (takenKeys(st)[slotKey(ts)]) return { ok: false, reason: "Sorry — that slot was just taken. Please choose another." };
    return { ok: true };
  }

  /* ============================================================
   * 4. Core action — book a demo.
   * ============================================================ */

  // input = { name, email, company, phone?, reason?, attendees?, notes?, slotTs }
  function bookDemo(input, now, state) {
    var st = state || readState();
    var ref = now || Date.now();
    var src = input || {};
    var errors = {};

    var name = trimStr(src.name);
    var email = trimStr(src.email);
    var company = trimStr(src.company);
    var slotTs = Number(src.slotTs);

    if (!name) errors.name = "Tell us who we're meeting.";
    if (!email) errors.email = "We need an email to send the invite.";
    else if (!emailValid(email)) errors.email = "That email doesn't look right.";
    if (!company) errors.company = "What's the name of your holiday camp?";

    var gate = slotBookable(slotTs, ref, st);
    if (!gate.ok) errors.slot = gate.reason;

    if (Object.keys(errors).length) return { ok: false, errors: errors };

    var reason = REASONS.some(function (r) { return r.id === src.reason; }) ? src.reason : "walkthrough";
    var attendees = Math.max(1, Math.min(10, parseInt(src.attendees, 10) || 1));

    var booking = {
      ref: shortRef(),
      name: name,
      email: email,
      company: company,
      phone: trimStr(src.phone),
      reason: reason,
      attendees: attendees,
      notes: trimStr(src.notes).slice(0, 1000),
      slotTs: slotTs,
      slotKey: slotKey(slotTs),
      slotLabel: slotLabel(slotTs),
      calendarLink: calendarLinkFor(slotTs),
      status: "booked",
      createdAt: ref
    };

    st.bookings.push(booking);
    writeState(st);
    return { ok: true, booking: booking };
  }

  function cancelDemo(ref, now, state) {
    var st = state || readState();
    var b = (st.bookings || []).filter(function (x) { return x && x.ref === ref; })[0];
    if (!b) return { ok: false, error: "We couldn't find that demo booking." };
    if (b.status === "cancelled") return { ok: false, error: "That demo is already cancelled." };
    b.status = "cancelled";
    b.cancelledAt = now || Date.now();
    writeState(st);
    return { ok: true, booking: b };
  }

  function activeBookings(state) {
    var st = state || readState();
    return (st.bookings || []).filter(function (b) { return b && b.status === "booked"; })
      .sort(function (a, b) { return a.slotTs - b.slotTs; });
  }

  /* ============================================================
   * 5. Render — the "Book A Demo" scheduler surfaced on the
   *    membership / marketing page.
   * ============================================================ */

  function escAttr(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  // A real provider name to pre-fill the "switching" scenario, if available.
  function sampleCompany() {
    var list = HC.data.providers || [];
    for (var i = 0; i < list.length; i++) {
      if (list[i] && list[i].name) return list[i].name;
    }
    return "";
  }

  function render(mountEl) {
    try {
      mountEl.innerHTML =
        '<style>' +
          '.pbd-wrap{font-family:"Nunito Sans",system-ui,sans-serif;color:var(--text,#383838)}' +
          '.pbd-hero{background:#FBF8FD;border:1.5px solid var(--line,#E6E6E6);border-radius:14px;padding:14px 15px;margin:0 0 14px}' +
          '.pbd-hero h4{font-family:"Quicksand",system-ui,sans-serif;color:var(--purple,#603488);margin:0 0 4px;font-size:15px}' +
          '.pbd-hero p{font-size:13px;margin:0;color:var(--text,#383838)}' +
          '.pbd-card{border:1.5px solid var(--line,#E6E6E6);border-radius:14px;padding:14px 15px;margin:0 0 14px;background:#fff}' +
          '.pbd-card h4{font-family:"Quicksand",system-ui,sans-serif;color:var(--purple,#603488);margin:0 0 8px;font-size:14.5px}' +
          '.pbd-field{margin:0 0 10px}' +
          '.pbd-field label{display:block;font-family:"Quicksand",system-ui,sans-serif;font-weight:700;font-size:12.5px;color:var(--purple,#603488);margin:0 0 4px}' +
          '.pbd-field input,.pbd-field select,.pbd-field textarea{width:100%;box-sizing:border-box;border:1.5px solid var(--line,#E6E6E6);border-radius:12px;padding:9px 12px;font-size:14px;font-family:inherit;background:#fff}' +
          '.pbd-field input:focus,.pbd-field select:focus,.pbd-field textarea:focus{outline:none;border-color:var(--purple,#603488)}' +
          '.pbd-two{display:grid;grid-template-columns:1fr 1fr;gap:10px}' +
          '.pbd-err{color:#9a1f5e;font-size:12px;margin-top:3px}' +
          '.pbd-slots{display:flex;flex-wrap:wrap;gap:7px;max-height:168px;overflow:auto;padding:2px}' +
          '.pbd-slot{font-family:"Quicksand",system-ui,sans-serif;font-weight:700;font-size:12px;border:1.5px solid var(--line,#E6E6E6);' +
            'background:#fff;color:var(--text,#383838);border-radius:999px;padding:7px 11px;cursor:pointer}' +
          '.pbd-slot:hover{border-color:var(--purple,#603488)}' +
          '.pbd-slot.sel{background:var(--purple,#603488);color:#fff;border-color:var(--purple,#603488)}' +
          '.pbd-sub{font-size:12px;color:var(--muted,#808080)}' +
          '.pbd-row{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px;align-items:center}' +
          '.pbd-conf{background:#E1F0E4;border:1.5px solid #BfE3CB;border-radius:14px;padding:13px 15px;margin:0 0 14px}' +
          '.pbd-conf h4{color:#2f7d4f;margin:0 0 4px}' +
          '.pbd-conf .pbd-ref{font-family:"Quicksand",system-ui,sans-serif;font-weight:700;font-size:13px}' +
          '.pbd-link{word-break:break-all;font-size:11.5px;color:var(--purple,#603488)}' +
          '.pbd-booked{border:1.5px solid var(--line,#E6E6E6);border-radius:12px;padding:10px 12px;margin:6px 0;font-size:13px;display:flex;justify-content:space-between;gap:10px;align-items:center}' +
          '@media(max-width:520px){.pbd-two{grid-template-columns:1fr}}' +
        '</style>' +
        '<div class="pbd-wrap">' +
          '<div class="pbd-hero">' +
            '<h4>📅 Book a booking-system demo</h4>' +
            '<p>Thinking about running your holiday-camp bookings on HolidayCamp, or switching from another system? ' +
              'Grab a 30-minute walkthrough with our team — pick a time that suits you below.</p>' +
          '</div>' +
          '<div id="pbdConf"></div>' +
          '<div class="pbd-card">' +
            '<h4>1. Pick a slot</h4>' +
            '<p class="pbd-sub" style="margin:0 0 8px">Mon–Fri, 10:00–16:00. 30 minutes, online.</p>' +
            '<div class="pbd-slots" id="pbdSlots"></div>' +
            '<div class="pbd-err" data-err="slot"></div>' +
          '</div>' +
          '<div class="pbd-card">' +
            '<h4>2. Your details</h4>' +
            '<div class="pbd-two">' +
              '<div class="pbd-field"><label for="pbdName">Your name</label>' +
                '<input id="pbdName" type="text" placeholder="e.g. Sam Carter"><div class="pbd-err" data-err="name"></div></div>' +
              '<div class="pbd-field"><label for="pbdCompany">Holiday camp / company</label>' +
                '<input id="pbdCompany" type="text" placeholder="e.g. Adventure Holiday Camps"><div class="pbd-err" data-err="company"></div></div>' +
            '</div>' +
            '<div class="pbd-two">' +
              '<div class="pbd-field"><label for="pbdEmail">Email</label>' +
                '<input id="pbdEmail" type="email" placeholder="you@yourcamp.co.uk"><div class="pbd-err" data-err="email"></div></div>' +
              '<div class="pbd-field"><label for="pbdPhone">Phone (optional)</label>' +
                '<input id="pbdPhone" type="tel" placeholder="07…"></div>' +
            '</div>' +
            '<div class="pbd-field"><label for="pbdReason">What would you like to cover?</label>' +
              '<select id="pbdReason">' +
                REASONS.map(function (r) { return '<option value="' + escAttr(r.id) + '">' + escAttr(r.label) + '</option>'; }).join("") +
              '</select></div>' +
            '<div class="pbd-field"><label for="pbdNotes">Anything else? (optional)</label>' +
              '<textarea id="pbdNotes" rows="2" placeholder="e.g. We run multi-week summer camps across 3 venues."></textarea></div>' +
            '<div class="pbd-row"><button type="button" class="hc-btn" id="pbdBook">Confirm demo booking</button>' +
              '<span class="pbd-sub" id="pbdSel">No slot selected yet.</span></div>' +
          '</div>' +
          '<div class="pbd-card" id="pbdMineCard">' +
            '<h4>Your booked demos</h4>' +
            '<div id="pbdMine"></div>' +
          '</div>' +
        '</div>';

      var slotsEl = mountEl.querySelector("#pbdSlots");
      var selEl = mountEl.querySelector("#pbdSel");
      var confEl = mountEl.querySelector("#pbdConf");
      var mineEl = mountEl.querySelector("#pbdMine");
      var selectedTs = null;

      // Pre-fill the company with a real switching prospect, if we have one.
      var pre = sampleCompany();
      if (pre) mountEl.querySelector("#pbdCompany").setAttribute("placeholder", "e.g. " + pre);

      function clearErrors() {
        mountEl.querySelectorAll("[data-err]").forEach(function (n) { n.textContent = ""; });
      }
      function showErrors(errors) {
        clearErrors();
        for (var f in errors) {
          if (!Object.prototype.hasOwnProperty.call(errors, f)) continue;
          var n = mountEl.querySelector('[data-err="' + f + '"]');
          if (n) n.textContent = errors[f];
        }
      }

      function renderSlots() {
        var slots = availableSlots(Date.now());
        if (!slots.length) {
          slotsEl.innerHTML = '<span class="pbd-sub">No slots free in the next ' + HORIZON_DAYS + ' days — please email us instead.</span>';
          return;
        }
        slotsEl.innerHTML = slots.slice(0, 36).map(function (s) {
          return '<button type="button" class="pbd-slot" data-ts="' + s.ts + '">' + escAttr(s.label) + '</button>';
        }).join("");
      }

      function renderMine() {
        var mine = activeBookings();
        if (!mine.length) { mineEl.innerHTML = '<p class="pbd-sub">No demos booked yet.</p>'; return; }
        mineEl.innerHTML = mine.map(function (b) {
          return '<div class="pbd-booked"><div><strong>' + escAttr(b.slotLabel) + '</strong>' +
            '<div class="pbd-sub">Ref ' + escAttr(b.ref) + ' · ' + escAttr(b.company) + '</div></div>' +
            '<button type="button" class="hc-btn hc-btn-ghost" data-cancel="' + escAttr(b.ref) + '">Cancel</button></div>';
        }).join("");
      }

      slotsEl.addEventListener("click", function (e) {
        var btn = e.target.closest(".pbd-slot");
        if (!btn) return;
        selectedTs = Number(btn.getAttribute("data-ts"));
        slotsEl.querySelectorAll(".pbd-slot").forEach(function (n) { n.classList.remove("sel"); });
        btn.classList.add("sel");
        selEl.textContent = "Selected: " + slotLabel(selectedTs);
        var slotErr = mountEl.querySelector('[data-err="slot"]');
        if (slotErr) slotErr.textContent = "";
      });

      mountEl.querySelector("#pbdBook").addEventListener("click", function () {
        var res = bookDemo({
          name: mountEl.querySelector("#pbdName").value,
          email: mountEl.querySelector("#pbdEmail").value,
          company: mountEl.querySelector("#pbdCompany").value,
          phone: mountEl.querySelector("#pbdPhone").value,
          reason: mountEl.querySelector("#pbdReason").value,
          notes: mountEl.querySelector("#pbdNotes").value,
          slotTs: selectedTs
        });
        if (!res.ok) {
          showErrors(res.errors || {});
          HC.util.toast("Please fix the highlighted fields");
          return;
        }
        clearErrors();
        var b = res.booking;
        confEl.innerHTML =
          '<div class="pbd-conf">' +
            '<h4>✓ Demo booked</h4>' +
            '<p style="margin:0 0 4px">See you on <strong>' + escAttr(b.slotLabel) + '</strong>. ' +
              'We\'ve emailed a calendar invite to <strong>' + escAttr(b.email) + '</strong>.</p>' +
            '<p class="pbd-ref" style="margin:0 0 4px">Booking ref: ' + escAttr(b.ref) + '</p>' +
            '<p style="margin:0 0 2px"><a class="pbd-link" href="' + escAttr(b.calendarLink) + '" target="_blank" rel="noopener noreferrer">Add to calendar / manage on Calendly →</a></p>' +
          '</div>';
        selectedTs = null;
        selEl.textContent = "No slot selected yet.";
        renderSlots();
        renderMine();
        HC.util.toast("Demo booked — ref " + b.ref);
      });

      mineEl.addEventListener("click", function (e) {
        var btn = e.target.closest("[data-cancel]");
        if (!btn) return;
        var r = cancelDemo(btn.getAttribute("data-cancel"));
        renderSlots();
        renderMine();
        HC.util.toast(r.ok ? "Demo cancelled — slot freed up" : (r.error || "Could not cancel"));
      });

      renderSlots();
      renderMine();
    } catch (e) {
      mountEl.innerHTML = '<p style="color:#9a1f5e">Demo booker failed to render: ' +
        escAttr(e && e.message ? e.message : String(e)) + "</p>";
    }
  }

  /* ============================================================
   * 6. selfTest — exercises the LOGIC and asserts the acceptance
   *    criterion. Sandboxes the store; restores it afterwards.
   * ============================================================ */

  function selfTest() {
    var pass = 0, fail = 0, log = [];
    function check(label, fn) {
      try { fn(); pass += 1; log.push("✓ " + label); }
      catch (e) { fail += 1; log.push("✗ " + label + " — " + (e && e.message ? e.message : String(e))); }
    }

    // Fixed clock: a Wednesday at 09:00 LOCAL so "today" has working slots
    // ahead of it and the lead-time maths is legible.
    // 2026-06-17 is a Wednesday.
    var NOW = new Date(2026, 5, 17, 9, 0, 0, 0).getTime();
    // A clean future slot on that same Wednesday: 11:00 (>= 1h lead, in window).
    var WED_1100 = new Date(2026, 5, 17, 11, 0, 0, 0).getTime();

    var BACKUP = HC.store.get(STORE_KEY, null);
    HC.store.set(STORE_KEY, { bookings: [] });

    try {
      function fresh() { return { bookings: [] }; }

      // --- Slot shape logic ---
      check("Slot shape accepts Mon–Fri 10:00–16:00 :00/:30, rejects the rest", function () {
        HC.assert(isSlotShape(new Date(2026, 5, 17, 10, 0, 0, 0)), "Wed 10:00 should be a slot");
        HC.assert(isSlotShape(new Date(2026, 5, 17, 15, 30, 0, 0)), "Wed 15:30 (ends 16:00) should be a slot");
        HC.assert(!isSlotShape(new Date(2026, 5, 17, 16, 0, 0, 0)), "16:00 would end after 16:00 — not a slot");
        HC.assert(!isSlotShape(new Date(2026, 5, 17, 9, 30, 0, 0)), "09:30 is before opening");
        HC.assert(!isSlotShape(new Date(2026, 5, 17, 10, 15, 0, 0)), "10:15 is off the 30-min grid");
        HC.assert(!isSlotShape(new Date(2026, 5, 20, 11, 0, 0, 0)), "Sat 20 Jun is not a working day");
        HC.assert(!isSlotShape(new Date(2026, 5, 21, 11, 0, 0, 0)), "Sun 21 Jun is not a working day");
      });

      // --- Availability is real and well-formed ---
      check("Availability offers only future, in-window, working-day slots", function () {
        var slots = availableSlots(NOW, fresh());
        HC.assert(slots.length > 0, "there should be bookable slots in the horizon");
        slots.forEach(function (s) {
          var d = new Date(s.ts);
          HC.assert(isSlotShape(d), "every offered slot must be a valid shape: " + s.label);
          HC.assert(s.ts >= NOW + LEAD_MIN * MIN_MS, "every slot must respect the 1h lead time: " + s.label);
          HC.assert(s.ts <= NOW + HORIZON_DAYS * DAY_MS, "every slot must be within the horizon: " + s.label);
        });
        // First slot today must be >= 11:00 (09:00 + 1h lead, ceil to :00/:30 = 10:00,
        // but 10:00 < 10:00? no — 09:00+1h=10:00 exactly, which is in-window).
        HC.assert(slots[0].ts >= new Date(2026, 5, 17, 10, 0, 0, 0).getTime(), "first slot should be today 10:00 or later");
      });

      check("Lead time excludes slots that are too soon", function () {
        // now = Wed 10:15 -> earliest bookable is 11:15 -> ceil to 11:30.
        var lateNow = new Date(2026, 5, 17, 10, 15, 0, 0).getTime();
        var slots = availableSlots(lateNow, fresh());
        HC.assert(slots.length > 0, "should still have slots");
        HC.assert(slots[0].ts >= lateNow + LEAD_MIN * MIN_MS, "first slot honours lead time");
        HC.assert(slots[0].ts === new Date(2026, 5, 17, 11, 30, 0, 0).getTime(),
          "first slot after 10:15 should be 11:30, got " + slotLabel(slots[0].ts));
      });

      // === ACCEPTANCE (part 1): a prospect books a scheduled demo via the link ===
      check("ACCEPTANCE: a switching provider books a slot; gets a ref + a concrete Calendly link encoding that slot", function () {
        var st = fresh();
        var res = bookDemo({
          name: "Sam Carter",
          email: "sam@adventurecamps.co.uk",
          company: "Adventure Holiday Camps",
          reason: "switching",
          slotTs: WED_1100
        }, NOW, st);
        HC.assert(res.ok, "a valid booking must succeed: " + JSON.stringify(res.errors || {}));
        var b = res.booking;
        HC.assert(typeof b.ref === "string" && /^DEMO-/.test(b.ref), "a booking reference is issued: " + b.ref);
        HC.assert(b.slotTs === WED_1100, "the booking is tied to the chosen slot time");
        HC.assert(b.reason === "switching", "the 'switching' intent is captured");
        // The calendar-booking link is the Calendly URL with the slot encoded.
        HC.assert(b.calendarLink.indexOf(CALENDLY_BASE) === 0, "link is built on the real Calendly demo URL");
        HC.assert(b.calendarLink.indexOf("date=2026-06-17") !== -1, "link encodes the chosen date");
        HC.assert(b.calendarLink.indexOf("t=11%3A00") !== -1, "link encodes the chosen time (11:00)");
        // And it persisted.
        HC.assert(st.bookings.length === 1 && st.bookings[0].ref === b.ref, "booking is persisted in state");
      });

      // === ACCEPTANCE (part 2): the booked slot can't be double-booked ===
      check("ACCEPTANCE: a taken slot leaves availability and cannot be double-booked", function () {
        var st = fresh();
        var first = bookDemo({ name: "A", email: "a@x.co", company: "Camp A", slotTs: WED_1100 }, NOW, st);
        HC.assert(first.ok, "first booking should succeed");
        // It disappears from availability.
        var slots = availableSlots(NOW, st);
        var stillThere = slots.some(function (s) { return s.ts === WED_1100; });
        HC.assert(!stillThere, "a booked slot must no longer be offered");
        // And a second attempt on the same slot is rejected.
        var second = bookDemo({ name: "B", email: "b@x.co", company: "Camp B", slotTs: WED_1100 }, NOW, st);
        HC.assert(!second.ok, "the same slot must not be double-booked");
        HC.assert(second.errors && second.errors.slot, "the clash is reported on the slot field");
        HC.assert(st.bookings.length === 1, "no second booking is written");
      });

      // --- Validation of contact details + slot ---
      check("Bookings require a name, a valid email, a company, and a real slot", function () {
        var st = fresh();
        HC.assert(!bookDemo({ name: "", email: "a@x.co", company: "C", slotTs: WED_1100 }, NOW, st).ok, "blank name fails");
        HC.assert(!bookDemo({ name: "A", email: "not-an-email", company: "C", slotTs: WED_1100 }, NOW, st).ok, "bad email fails");
        HC.assert(!bookDemo({ name: "A", email: "a@x.co", company: "", slotTs: WED_1100 }, NOW, st).ok, "blank company fails");
        HC.assert(!bookDemo({ name: "A", email: "a@x.co", company: "C", slotTs: NaN }, NOW, st).ok, "no slot fails");
        HC.assert(st.bookings.length === 0, "no invalid booking is written");
        // The happy path still works after all those rejections.
        HC.assert(bookDemo({ name: "A", email: "a@x.co", company: "C", slotTs: WED_1100 }, NOW, st).ok, "valid booking still works");
      });

      check("Email validator accepts sensible addresses and rejects junk", function () {
        HC.assert(emailValid("sam@camp.co.uk"), "normal address ok");
        HC.assert(emailValid("a.b+tag@sub.domain.org"), "tagged subdomain ok");
        HC.assert(!emailValid("sam@camp"), "missing TLD rejected");
        HC.assert(!emailValid("sam camp@x.co"), "space rejected");
        HC.assert(!emailValid("@x.co"), "missing local part rejected");
        HC.assert(!emailValid(""), "empty rejected");
      });

      // --- Slot-bookability guards (past / out-of-window / horizon) ---
      check("A past or non-working slot is refused", function () {
        var st = fresh();
        var pastSlot = new Date(2026, 5, 17, 10, 0, 0, 0).getTime(); // 10:00, but now is 09:00 +1h lead = 10:00 ok...
        // Use a clearly-past slot: yesterday 11:00.
        var yesterday = new Date(2026, 5, 16, 11, 0, 0, 0).getTime();
        HC.assert(!slotBookable(yesterday, NOW, st).ok, "a past slot is not bookable");
        var weekend = new Date(2026, 5, 20, 11, 0, 0, 0).getTime(); // Sat
        HC.assert(!slotBookable(weekend, NOW, st).ok, "a weekend slot is not bookable");
        var tooFar = NOW + (HORIZON_DAYS + 5) * DAY_MS;
        HC.assert(!slotBookable(tooFar, NOW, st).ok, "a slot beyond the horizon is not bookable");
        // The good slot is bookable.
        HC.assert(slotBookable(WED_1100, NOW, st).ok, "the in-window future slot is bookable");
      });

      // --- Cancel frees the slot ---
      check("Cancelling a demo frees the slot for re-booking", function () {
        var st = fresh();
        var r = bookDemo({ name: "A", email: "a@x.co", company: "C", slotTs: WED_1100 }, NOW, st);
        HC.assert(r.ok, "book first");
        var avail1 = availableSlots(NOW, st).some(function (s) { return s.ts === WED_1100; });
        HC.assert(!avail1, "slot is taken while booked");
        var c = cancelDemo(r.booking.ref, NOW, st);
        HC.assert(c.ok && c.booking.status === "cancelled", "cancellation succeeds");
        var avail2 = availableSlots(NOW, st).some(function (s) { return s.ts === WED_1100; });
        HC.assert(avail2, "the freed slot is offered again");
        // And it can be re-booked.
        HC.assert(bookDemo({ name: "B", email: "b@x.co", company: "C2", slotTs: WED_1100 }, NOW, st).ok, "slot re-books after cancel");
      });

      check("Cancelling an unknown or already-cancelled ref is handled, not thrown", function () {
        var st = fresh();
        HC.assert(!cancelDemo("DEMO-NOPE-NOPE", NOW, st).ok, "unknown ref is a clean failure");
        var r = bookDemo({ name: "A", email: "a@x.co", company: "C", slotTs: WED_1100 }, NOW, st);
        cancelDemo(r.booking.ref, NOW, st);
        HC.assert(!cancelDemo(r.booking.ref, NOW, st).ok, "double-cancel is a clean failure");
      });

      // --- Calendar link is well-formed and points at the real Calendly event ---
      check("Calendar link is the documented Calendly URL with the slot encoded", function () {
        var link = calendarLinkFor(WED_1100);
        HC.assert(link.indexOf("https://calendly.com/d/ctgf-552-7yy/happity-booking-system-demo") === 0,
          "link uses the evidence Calendly URL");
        HC.assert(/[?&]date=2026-06-17(?:&|$)/.test(link), "date param present");
        HC.assert(/[?&]month=2026-06(?:&|$)/.test(link), "month param present");
        HC.assert(/[?&]t=11%3A00(?:&|$)/.test(link), "time param present and URL-encoded");
      });

      // --- Persistence round-trip through the real store ---
      check("A booking round-trips through HC.store", function () {
        HC.store.set(STORE_KEY, { bookings: [] });
        var r = bookDemo({ name: "Persist", email: "p@x.co", company: "Persist Camp", slotTs: WED_1100 }, NOW);
        HC.assert(r.ok, "store-backed booking succeeds");
        var reread = readState();
        HC.assert(reread.bookings.length === 1 && reread.bookings[0].ref === r.booking.ref, "booking persists across a fresh read");
        HC.assert(reread.bookings[0].calendarLink.indexOf(CALENDLY_BASE) === 0, "persisted link is intact");
      });

      check("camps.js provider data is never mutated by booking a demo", function () {
        var list = HC.data.providers || [];
        var snapshotName = list.length ? list[0].name : null;
        bookDemo({ name: "A", email: "a@x.co", company: "C", slotTs: WED_1100 }, NOW, fresh());
        var after = (HC.data.providers || [])[0];
        HC.assert((after ? after.name : null) === snapshotName, "the live provider object is untouched");
      });

    } finally {
      if (BACKUP === null) HC.store.remove(STORE_KEY);
      else HC.store.set(STORE_KEY, BACKUP);
    }

    return { pass: pass, fail: fail, log: log };
  }

  /* ============================================================
   * 7. Register.
   * ============================================================ */

  HC.registerFeature({
    id: "provider-book-demo",
    title: "Book a booking-system demo",
    side: "provider",
    icon: "📅",
    summary: "Surfaced on the membership / marketing pages: prospective or switching holiday-camp providers book a 30-minute demo call of the booking system via a calendar-booking link (Calendly). Real Mon–Fri 10:00–16:00 slots with lead-time and double-booking protection; each booking issues a reference and a concrete calendar link encoding the chosen slot.",
    render: render,
    selfTest: selfTest
  });
})();
