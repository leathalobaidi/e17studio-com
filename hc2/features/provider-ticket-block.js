/* HolidayCamp feature — provider-ticket-block
 *
 * Block tickets — book N consecutive sessions from a chosen start  (provider side)
 *
 * Replicates Happity's BLOCK ticket type. Evidence (article 10248958,
 * "Creating and Managing Tickets, Prices, and Term Bookings on Happity"):
 *   - "Block Tickets: Block tickets book a customer in for a set number of
 *      consecutive sessions, starting from the date they select. This ticket
 *      type is designed for courses where attendees must complete sessions in
 *      order (e.g., a 6-week Baby First Aid course). You can alter the number
 *      of classes included in the ticket..."
 *   - "Note: Customers can only purchase block tickets if there are enough
 *      remaining consecutive dates in your schedule."
 *   - FAQ "Why do I get an error saying there are not enough tickets left for
 *      my block booking?": "Block booking tickets require a specific number of
 *      consecutive dates to function. If your block ticket requires 6 sessions
 *      but only 4 dates remain on your schedule, the system cannot process the
 *      booking. To resolve this, you'd simply just add more dates to your class
 *      schedule."
 *
 * Framed for SCHOOL-AGE HOLIDAY CAMPS (not baby classes). A holiday camp runs a
 * SCHEDULE of dated sessions (e.g. the daily sessions of a week-long
 * multi-activity camp, or a weekly coding course across the summer). A BLOCK
 * ticket of size N books the child into N CONSECUTIVE sessions counting forward
 * from the start date the parent picks — useful for a structured progression
 * camp ("Learn to Skateboard — must attend all 5 days in order") or a 6-session
 * coding course.
 *
 * ACCEPTANCE CRITERION (asserted in selfTest):
 *   A block ticket books N consecutive dates from the chosen start; blocked if
 *   not enough dates remain.
 *   We verify: from a chosen start index, a block of size N reserves exactly the
 *   N consecutive schedule dates starting there; and if fewer than N dates
 *   remain from that start, the booking is REFUSED with a "not enough
 *   consecutive dates" reason (no partial booking, nothing persisted).
 *
 * Self-contained, defensive, no imports/exports. Calls HC.registerFeature.
 */
(function () {
  "use strict";

  // Defensive: never throw at module load if HC isn't present.
  if (typeof window === "undefined" || !window.HC || typeof window.HC.registerFeature !== "function") {
    if (typeof console !== "undefined" && console.warn) {
      console.warn("[HC] provider-ticket-block: HC core not found; skipping registration.");
    }
    return;
  }

  var HC = window.HC;

  // Persisted shape, keyed by providerId:
  //   { <providerId>: { schedule:[...ISO dates], blockSize:Number, bookings:[...] } }
  var STORE_KEY = "provider_ticket_block";

  /* ===================================================================
     SMALL HELPERS
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

  function safeUid(prefix) {
    try { return HC.util.uid(); }
    catch (e) { return (prefix || "id") + "_" + Date.now() + "_" + Math.floor(Math.random() * 1e6); }
  }

  function toPosInt(v) {
    var n = Number(v);
    if (!isFinite(n) || n <= 0 || Math.floor(n) !== n) return null;
    return n;
  }

  /* ===================================================================
     PURE LOGIC (testable, DOM-free) — the heart of the feature
     =================================================================== */

  // Normalise an arbitrary date list into a clean, de-duplicated, ascending
  // array of valid ISO dates. This is the camp's bookable SCHEDULE. A camp's
  // "consecutive sessions" are consecutive POSITIONS in this ordered schedule
  // (Happity treats the published dates as the run; gaps between e.g. weekly
  // sessions are expected and still count as consecutive sessions).
  function normaliseSchedule(dates) {
    var arr = Array.isArray(dates) ? dates : [];
    var seen = {};
    var clean = [];
    for (var i = 0; i < arr.length; i++) {
      var d = asText(arr[i]);
      if (isValidISODate(d) && !seen[d]) { seen[d] = true; clean.push(d); }
    }
    clean.sort(); // ISO strings sort chronologically
    return clean;
  }

  // How many sessions remain from a given start INDEX (inclusive) to the end of
  // the schedule. This is what "enough remaining consecutive dates" measures.
  function remainingFrom(schedule, startIndex) {
    var sched = Array.isArray(schedule) ? schedule : [];
    var i = toPosIntOrZero(startIndex);
    if (i < 0 || i >= sched.length) return 0;
    return sched.length - i;
  }
  function toPosIntOrZero(v) {
    var n = Number(v);
    if (!isFinite(n) || n < 0 || Math.floor(n) !== n) return -1;
    return n;
  }

  // CORE: try to build a block booking of `blockSize` consecutive sessions
  // starting at schedule index `startIndex`.
  //
  // Returns either:
  //   { ok:true, booking:{ id, startDate, dates:[...N ISO], count } }
  //   { ok:false, reason:String, code:String, remaining:Number, needed:Number }
  //
  // The acceptance criterion lives here:
  //   - on success, `dates` is EXACTLY the N consecutive schedule entries from
  //     the start (in order);
  //   - on failure because fewer than N remain, code==='not_enough_dates' and
  //     nothing is booked.
  function computeBlock(schedule, startIndex, blockSize) {
    var sched = normaliseSchedule(schedule);
    var n = toPosInt(blockSize);
    if (n === null) {
      return { ok: false, code: "bad_size", reason: "Block size must be a whole number of 1 or more.", remaining: 0, needed: 0 };
    }
    var i = toPosIntOrZero(startIndex);
    if (i < 0 || i >= sched.length) {
      return { ok: false, code: "bad_start", reason: "The chosen start date is not in the schedule.", remaining: 0, needed: n };
    }
    var remaining = sched.length - i; // sessions available from the start onward
    if (remaining < n) {
      // Happity: "not enough remaining consecutive dates in your schedule".
      return {
        ok: false,
        code: "not_enough_dates",
        reason: "Not enough consecutive dates remain: this block needs " + n +
          " session" + (n === 1 ? "" : "s") + " but only " + remaining +
          " remain from the chosen start.",
        remaining: remaining,
        needed: n
      };
    }
    // Take exactly the N consecutive sessions from the start (inclusive).
    var dates = sched.slice(i, i + n);
    return {
      ok: true,
      booking: {
        startIndex: i,
        startDate: dates[0],
        endDate: dates[dates.length - 1],
        dates: dates,
        count: dates.length
      }
    };
  }

  // Convenience: find the index of an ISO date within a (normalised) schedule.
  function indexOfDate(schedule, iso) {
    var sched = normaliseSchedule(schedule);
    var d = asText(iso);
    return sched.indexOf(d);
  }

  // Compute a block booking by START DATE rather than index (what a parent
  // actually picks). Defers all the consecutiveness logic to computeBlock.
  function computeBlockByDate(schedule, startISO, blockSize) {
    var idx = indexOfDate(schedule, startISO);
    if (idx === -1) {
      var n = toPosInt(blockSize) || 0;
      return { ok: false, code: "bad_start", reason: "The chosen start date is not one of the camp's sessions.", remaining: 0, needed: n };
    }
    return computeBlock(schedule, idx, blockSize);
  }

  // Which start dates in the schedule CAN seat a full block of size N? Used by
  // the UI to disable starts that don't have enough run left (mirrors Happity
  // greying-out / refusing those starts).
  function bookableStartIndexes(schedule, blockSize) {
    var sched = normaliseSchedule(schedule);
    var n = toPosInt(blockSize);
    var out = [];
    if (n === null) return out;
    for (var i = 0; i < sched.length; i++) {
      if (sched.length - i >= n) out.push(i);
    }
    return out;
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
    if (!map[pid] || typeof map[pid] !== "object") {
      map[pid] = { schedule: [], blockSize: 5, bookings: [] };
    }
    if (!Array.isArray(map[pid].schedule)) map[pid].schedule = [];
    if (!Array.isArray(map[pid].bookings)) map[pid].bookings = [];
    if (toPosInt(map[pid].blockSize) === null) map[pid].blockSize = 5;
    return map[pid];
  }

  function setSchedule(providerId, dates) {
    var map = readAll();
    var bucket = providerBucket(map, providerId);
    bucket.schedule = normaliseSchedule(dates);
    writeAll(map);
    return bucket.schedule.slice();
  }
  function getSchedule(providerId) {
    var map = readAll();
    return providerBucket(map, providerId).schedule.slice();
  }
  function setBlockSize(providerId, size) {
    var map = readAll();
    var bucket = providerBucket(map, providerId);
    var n = toPosInt(size);
    bucket.blockSize = n === null ? bucket.blockSize : n;
    writeAll(map);
    return bucket.blockSize;
  }
  function getBlockSize(providerId) {
    var map = readAll();
    return providerBucket(map, providerId).blockSize;
  }

  // Attempt to PERSIST a block booking by start date. Returns the same shape as
  // computeBlock, plus on success the stored booking carries an id + child name.
  // On failure nothing is written (no partial booking).
  function bookBlock(providerId, startISO, childName) {
    var map = readAll();
    var bucket = providerBucket(map, providerId);
    var res = computeBlockByDate(bucket.schedule, startISO, bucket.blockSize);
    if (!res.ok) return res; // refused — do not persist anything
    var booking = {
      id: safeUid("blk"),
      child: asText(childName).trim() || "Camper",
      blockSize: bucket.blockSize,
      startDate: res.booking.startDate,
      endDate: res.booking.endDate,
      dates: res.booking.dates.slice(),
      count: res.booking.count,
      createdAt: Date.now()
    };
    bucket.bookings.push(booking);
    if (bucket.bookings.length > 200) bucket.bookings = bucket.bookings.slice(-200);
    writeAll(map);
    return { ok: true, booking: booking };
  }

  function getBookings(providerId) {
    var map = readAll();
    return providerBucket(map, providerId).bookings.slice();
  }
  function removeBooking(providerId, bookingId) {
    var map = readAll();
    var bucket = providerBucket(map, providerId);
    var before = bucket.bookings.length;
    bucket.bookings = bucket.bookings.filter(function (b) { return b.id !== bookingId; });
    writeAll(map);
    return bucket.bookings.length < before;
  }
  function clearProvider(providerId) {
    var map = readAll();
    var pid = asText(providerId) || "_default";
    delete map[pid];
    writeAll(map);
  }

  /* ===================================================================
     LIVE-DATA HELPERS (sensible demo defaults from camp data)
     =================================================================== */

  function demoProviderId() {
    try {
      var ps = HC.data.providers;
      if (ps && ps.length && ps[0] && ps[0].id) return ps[0].id;
    } catch (e) {}
    return "_demo_provider";
  }

  // Build a demo schedule from the live planner's summer weeks: the Monday of
  // each confirmed week makes a sensible "weekly course session" list. Falls
  // back to a fixed run of consecutive days for a single-week camp.
  function demoSchedule() {
    var out = [];
    try {
      var weeks = (HC.data.planner && HC.data.planner.weeks) || [];
      for (var i = 0; i < weeks.length; i++) {
        var mon = weeks[i] && weeks[i].mon;
        if (isValidISODate(mon)) out.push(mon);
      }
    } catch (e) {}
    if (out.length >= 4) return normaliseSchedule(out);
    // Fallback: the five daily sessions of a single week-long camp (Mon–Fri).
    return ["2026-07-27", "2026-07-28", "2026-07-29", "2026-07-30", "2026-07-31"];
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

  function scheduleChipsHtml(providerId) {
    var sched = getSchedule(providerId);
    var size = getBlockSize(providerId);
    var startable = {};
    bookableStartIndexes(sched, size).forEach(function (i) { startable[i] = true; });

    if (!sched.length) {
      return '<p style="color:var(--muted,#808080);font-size:13px;margin:6px 0 0">No camp sessions in the schedule yet.</p>';
    }
    var chips = sched.map(function (iso, i) {
      var ok = !!startable[i];
      var bg = ok ? "#EAF6EE" : "#F4F4F4";
      var bd = ok ? "#8FCBA3" : "#E0E0E0";
      var fg = ok ? "#2f7d4f" : "#9a9a9a";
      var tip = ok
        ? "A " + size + "-session block can start here"
        : "Not enough consecutive sessions remain to start a " + size + "-block here";
      return '<span title="' + escAttr(tip) + '" ' +
        'style="display:inline-block;font-size:12px;padding:4px 9px;border-radius:999px;margin:0 6px 6px 0;' +
        'background:' + bg + ';border:1px solid ' + bd + ';color:' + fg + '">' +
        '#' + (i + 1) + " · " + esc(dateLabel(iso)) + (ok ? "" : " 🚫") + "</span>";
    }).join("");
    return '<div style="margin-top:6px">' + chips + "</div>";
  }

  function bookingsHtml(providerId) {
    var bookings = getBookings(providerId);
    if (!bookings.length) {
      return '<li style="color:var(--muted,#808080);list-style:none;margin-left:-20px">No block bookings yet.</li>';
    }
    return bookings.map(function (b) {
      return '<li style="margin:0 0 8px" data-bk="' + escAttr(b.id) + '">' +
        '<strong>' + esc(b.child) + "</strong> — block of " + esc(b.count) +
        '<div style="font-size:12.5px;color:var(--muted,#808080)">📚 ' +
          esc(dateLabel(b.startDate)) + " → " + esc(dateLabel(b.endDate)) +
          " · " + esc(b.count) + " consecutive sessions</div>" +
        '<button class="hc-btn hc-btn-ghost" type="button" data-del="' + escAttr(b.id) +
          '" style="margin-top:4px;padding:3px 9px;font-size:11px">Cancel block</button>' +
      "</li>";
    }).join("");
  }

  function startOptionsHtml(providerId) {
    var sched = getSchedule(providerId);
    var size = getBlockSize(providerId);
    var startable = {};
    bookableStartIndexes(sched, size).forEach(function (i) { startable[i] = true; });
    if (!sched.length) return '<option value="">— no sessions —</option>';
    return sched.map(function (iso, i) {
      var ok = !!startable[i];
      return '<option value="' + escAttr(iso) + '"' + (ok ? "" : " disabled") + '>' +
        esc(dateLabel(iso)) + (ok ? "" : "  (not enough dates remain)") + "</option>";
    }).join("");
  }

  function render(mountEl) {
    try {
      if (!mountEl) return;
      var providerId = demoProviderId();

      // Seed a demo schedule + block size the first time, so the preview is live.
      if (!getSchedule(providerId).length) {
        setSchedule(providerId, demoSchedule());
        setBlockSize(providerId, 5);
      }

      mountEl.innerHTML = "";

      var intro = el("div", null,
        '<p style="font-size:14px;color:var(--text,#383838);margin:0 0 4px">' +
          "A <strong>block ticket</strong> books a camper into a set number of " +
          "<strong>consecutive sessions</strong>, counting forward from the date the " +
          "parent picks — perfect for a structured progression camp where children " +
          "must attend in order (e.g. a 5-day Learn-to-Skateboard week, or a 6-session " +
          "coding course across the summer).</p>" +
        '<p style="font-size:12.5px;color:var(--muted,#808080);margin:0 0 6px">' +
          "A block can only start where <strong>enough consecutive dates remain</strong>. " +
          "Starts without a full run left are blocked.</p>");
      mountEl.appendChild(intro);

      var controls = el("div", {
        style: "border-top:1px solid var(--line,#E6E6E6);margin-top:12px;padding-top:12px"
      });
      controls.innerHTML =
        '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;align-items:end">' +
          '<label style="display:block;font-size:13px">Block size (consecutive sessions)<br>' +
            '<input id="tbSize" type="number" min="1" step="1" value="' + escAttr(getBlockSize(providerId)) + '" ' +
              'style="width:100%;padding:6px 8px;border:1.5px solid var(--line,#E6E6E6);border-radius:8px"></label>' +
          '<label style="display:block;font-size:13px">Start session (date parent picks)<br>' +
            '<select id="tbStart" style="width:100%;padding:6px 8px;border:1.5px solid var(--line,#E6E6E6);border-radius:8px">' +
              startOptionsHtml(providerId) + "</select></label>" +
        "</div>" +
        '<label style="display:block;font-size:13px;margin-top:10px">Child name<br>' +
          '<input id="tbChild" type="text" value="Ada" ' +
            'style="width:100%;padding:6px 8px;border:1.5px solid var(--line,#E6E6E6);border-radius:8px"></label>' +
        '<button class="hc-btn" id="tbBook" type="button" style="margin-top:10px">📚 Book block</button>' +
        '<div id="tbMsg" style="margin-top:8px;font-size:12.5px"></div>';
      mountEl.appendChild(controls);

      var schedHost = el("div", { id: "tbSchedHost" },
        '<div class="hc-sidehead" style="margin-top:14px">Camp schedule · valid block starts</div>' +
        scheduleChipsHtml(providerId));
      mountEl.appendChild(schedHost);

      var listWrap = el("div", {
        style: "border:1.5px solid var(--line,#E6E6E6);border-radius:14px;padding:12px 14px;background:#F7F4FB;margin-top:12px"
      });
      listWrap.innerHTML =
        '<div style="font-family:Quicksand,system-ui,sans-serif;font-weight:700;color:var(--purple,#603488)">📚 Block bookings</div>' +
        '<ul id="tbList" style="margin:8px 0 0;padding-left:20px;font-size:13.5px;color:var(--text,#383838)">' +
          bookingsHtml(providerId) + "</ul>";
      mountEl.appendChild(listWrap);

      function refresh() {
        schedHost.innerHTML =
          '<div class="hc-sidehead" style="margin-top:14px">Camp schedule · valid block starts</div>' +
          scheduleChipsHtml(providerId);
        var sel = controls.querySelector("#tbStart");
        if (sel) {
          var prev = sel.value;
          sel.innerHTML = startOptionsHtml(providerId);
          // keep selection if still valid+enabled
          var opt = sel.querySelector('option[value="' + (prev || "").replace(/"/g, '\\"') + '"]');
          if (opt && !opt.disabled) sel.value = prev;
        }
        var list = listWrap.querySelector("#tbList");
        if (list) list.innerHTML = bookingsHtml(providerId);
      }

      function val(id) { var n = controls.querySelector("#" + id); return n ? n.value : ""; }
      function msg(html, good) {
        var m = controls.querySelector("#tbMsg");
        if (m) { m.innerHTML = html; m.style.color = good ? "#2f7d4f" : "#9a1f5e"; }
      }

      var sizeInput = controls.querySelector("#tbSize");
      if (sizeInput) {
        sizeInput.addEventListener("change", function () {
          setBlockSize(providerId, sizeInput.value);
          sizeInput.value = getBlockSize(providerId); // reflect normalisation
          refresh();
          msg("Block size set to " + getBlockSize(providerId) + " session(s).", true);
        });
      }

      var bookBtn = controls.querySelector("#tbBook");
      if (bookBtn) {
        bookBtn.addEventListener("click", function () {
          var start = val("tbStart");
          if (!start) { msg("Pick a start session first.", false); return; }
          var res = bookBlock(providerId, start, val("tbChild"));
          if (!res.ok) {
            msg("🚫 " + esc(res.reason), false);
            return;
          }
          refresh();
          msg("✓ Booked a block of " + res.booking.count + " sessions: " +
            esc(dateLabel(res.booking.startDate)) + " → " + esc(dateLabel(res.booking.endDate)) + ".", true);
          try {
            HC.util.toast("Block booked: " + res.booking.count + " consecutive sessions for " + res.booking.child);
          } catch (e) {}
        });
      }

      listWrap.addEventListener("click", function (e) {
        var btn = e.target && e.target.closest ? e.target.closest("[data-del]") : null;
        if (!btn) return;
        removeBooking(providerId, btn.getAttribute("data-del"));
        refresh();
        try { HC.util.toast("Block cancelled"); } catch (er) {}
      });
    } catch (e) {
      try {
        mountEl.innerHTML = '<p style="color:#9a1f5e">Block-ticket feature failed to render: ' +
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

    // A 6-session schedule (e.g. a coding course, one session per summer week).
    var SCHED6 = ["2026-07-20", "2026-07-27", "2026-08-03", "2026-08-10", "2026-08-17", "2026-08-24"];

    // ===== ACCEPTANCE CRITERION (core) =====
    // A block ticket books N consecutive dates from the chosen start.

    check("A block of N books exactly the N consecutive dates from the start", function () {
      var res = computeBlock(SCHED6, 0, 3); // start at index 0, block of 3
      HC.assert(res.ok === true, "block should succeed: " + (res.reason || ""));
      HC.assert(res.booking.count === 3, "should book 3 sessions, got " + res.booking.count);
      HC.assert(res.booking.dates.length === 3, "dates array should hold 3 entries");
      // exactly the consecutive run from the start, in order
      HC.assert(res.booking.dates[0] === "2026-07-20", "first date wrong: " + res.booking.dates[0]);
      HC.assert(res.booking.dates[1] === "2026-07-27", "second date wrong: " + res.booking.dates[1]);
      HC.assert(res.booking.dates[2] === "2026-08-03", "third date wrong: " + res.booking.dates[2]);
      HC.assert(res.booking.startDate === "2026-07-20", "startDate wrong");
      HC.assert(res.booking.endDate === "2026-08-03", "endDate wrong");
    });

    check("A block starting mid-schedule takes the consecutive run forward", function () {
      var res = computeBlock(SCHED6, 2, 3); // start at index 2 (3 Aug), block of 3
      HC.assert(res.ok === true, "mid-start block should succeed");
      HC.assert(res.booking.dates.join(",") === "2026-08-03,2026-08-10,2026-08-17",
        "consecutive run from index 2 wrong: " + res.booking.dates.join(","));
    });

    check("A full-length block consumes the whole schedule exactly", function () {
      var res = computeBlock(SCHED6, 0, 6);
      HC.assert(res.ok === true, "block of 6 over 6 dates should succeed");
      HC.assert(res.booking.count === 6, "should book all 6 sessions");
      HC.assert(res.booking.dates[5] === "2026-08-24", "last session should be the final schedule date");
    });

    // ===== ACCEPTANCE CRITERION (the block) =====
    // Blocked if not enough dates remain.

    check("A block is REFUSED when not enough consecutive dates remain", function () {
      // Start at index 4 (only 2 dates remain: idx 4,5) but ask for a block of 5.
      var res = computeBlock(SCHED6, 4, 5);
      HC.assert(res.ok === false, "block must be refused when too few dates remain");
      HC.assert(res.code === "not_enough_dates", "code should be 'not_enough_dates', got " + res.code);
      HC.assert(res.remaining === 2, "should report 2 dates remaining, got " + res.remaining);
      HC.assert(res.needed === 5, "should report 5 needed, got " + res.needed);
      HC.assert(/consecutive/i.test(res.reason), "reason should mention consecutive dates");
    });

    check("The Happity 6-needs-but-4-remain case is refused (article 10248958)", function () {
      var four = SCHED6.slice(2); // 4 dates remain on the schedule
      var res = computeBlock(four, 0, 6); // ticket needs 6
      HC.assert(res.ok === false, "6-session block on a 4-date schedule must fail");
      HC.assert(res.code === "not_enough_dates", "should be a not_enough_dates failure");
      HC.assert(res.remaining === 4 && res.needed === 6, "should report 4 remaining / 6 needed");
    });

    check("Boundary: a block needing exactly the remaining count succeeds; one more fails", function () {
      var okRes = computeBlock(SCHED6, 4, 2);   // exactly 2 remain, need 2
      HC.assert(okRes.ok === true, "exact-fit block should succeed");
      HC.assert(okRes.booking.dates.join(",") === "2026-08-17,2026-08-24", "exact-fit run wrong");
      var badRes = computeBlock(SCHED6, 4, 3);  // 2 remain, need 3
      HC.assert(badRes.ok === false, "one-over-the-edge block must fail");
      HC.assert(badRes.code === "not_enough_dates", "over-edge failure should be not_enough_dates");
    });

    // ===== Booking by START DATE (what a parent actually picks) =====

    check("Booking by start DATE resolves the right consecutive run", function () {
      var res = computeBlockByDate(SCHED6, "2026-08-10", 3); // index 3 -> 3 remain
      HC.assert(res.ok === true, "date-based block should succeed");
      HC.assert(res.booking.dates.join(",") === "2026-08-10,2026-08-17,2026-08-24",
        "date-based consecutive run wrong: " + res.booking.dates.join(","));
    });

    check("Booking from a start date with too few remaining is refused", function () {
      var res = computeBlockByDate(SCHED6, "2026-08-17", 3); // only 2 remain from here
      HC.assert(res.ok === false, "should refuse: not enough remain from 17 Aug");
      HC.assert(res.code === "not_enough_dates", "should be not_enough_dates");
    });

    check("A start date that is not in the schedule is rejected", function () {
      var res = computeBlockByDate(SCHED6, "2026-12-25", 2);
      HC.assert(res.ok === false, "off-schedule start must be rejected");
      HC.assert(res.code === "bad_start", "should be a bad_start failure, got " + res.code);
    });

    // ===== bookableStartIndexes: which starts can seat a full block =====

    check("bookableStartIndexes lists only starts with a full run remaining", function () {
      // For a block of 3 over 6 dates, valid starts are indexes 0..3 (4 starts).
      var starts = bookableStartIndexes(SCHED6, 3);
      HC.assert(starts.join(",") === "0,1,2,3", "valid block-of-3 starts wrong: " + starts.join(","));
      // For a block of 6, only index 0 works.
      HC.assert(bookableStartIndexes(SCHED6, 6).join(",") === "0", "only index 0 should seat a block of 6");
      // For a block larger than the schedule, no starts work.
      HC.assert(bookableStartIndexes(SCHED6, 7).length === 0, "block of 7 over 6 dates: no valid starts");
    });

    // ===== Schedule normalisation: dedupe, sort, drop invalid, gaps OK =====

    check("Schedule is normalised: invalid dropped, duplicates removed, sorted", function () {
      var messy = ["2026-08-03", "2026-07-20", "2026-08-03", "not-a-date", "2026-13-40", "2026-07-27"];
      var clean = normaliseSchedule(messy);
      HC.assert(clean.join(",") === "2026-07-20,2026-07-27,2026-08-03",
        "normalised schedule wrong: " + clean.join(","));
    });

    check("Consecutive means consecutive POSITIONS, so weekly gaps still count", function () {
      // Sessions a week apart are 'consecutive sessions' in Happity's sense.
      var weekly = ["2026-07-20", "2026-07-27", "2026-08-03"];
      var res = computeBlock(weekly, 0, 3);
      HC.assert(res.ok === true, "3 weekly sessions form a valid block of 3");
      HC.assert(res.booking.count === 3, "all 3 weekly sessions should be in the block");
    });

    // ===== PERSISTENCE path (bookBlock) — full round-trip via HC.store =====

    var TP = "__selftest_block_provider__";
    clearProvider(TP);

    check("Provider sets a schedule and block size, then a parent books a block", function () {
      setSchedule(TP, SCHED6);
      setBlockSize(TP, 4);
      HC.assert(getSchedule(TP).length === 6, "schedule should persist 6 dates");
      HC.assert(getBlockSize(TP) === 4, "block size should persist as 4");
      var res = bookBlock(TP, "2026-07-20", "Ada");
      HC.assert(res.ok === true, "booking a block of 4 from the start should succeed");
      HC.assert(res.booking.count === 4, "stored booking should hold 4 sessions");
      HC.assert(res.booking.dates.join(",") === "2026-07-20,2026-07-27,2026-08-03,2026-08-10",
        "persisted consecutive run wrong: " + res.booking.dates.join(","));
      HC.assert(getBookings(TP).length === 1, "one block booking should be persisted");
    });

    check("A refused block persists NOTHING (no partial booking)", function () {
      var before = getBookings(TP).length;
      // Block of 4 starting at 17 Aug — only 2 remain — must be refused.
      var res = bookBlock(TP, "2026-08-17", "Ben");
      HC.assert(res.ok === false, "this block should be refused");
      HC.assert(res.code === "not_enough_dates", "refusal should be not_enough_dates");
      HC.assert(getBookings(TP).length === before, "a refused block must not be stored");
    });

    check("Block bookings persist via HC.store and reload", function () {
      var reloaded = getBookings(TP);
      HC.assert(reloaded.length === 1, "the one valid booking should survive a reload");
      HC.assert(reloaded[0].count === 4, "reloaded booking should still hold 4 sessions");
    });

    check("Cancelling a block removes it; schedule + block size untouched", function () {
      var bk = getBookings(TP)[0];
      var removed = removeBooking(TP, bk.id);
      HC.assert(removed === true, "cancel should report success");
      HC.assert(getBookings(TP).length === 0, "no bookings should remain");
      HC.assert(getSchedule(TP).length === 6, "schedule must be untouched by a cancel");
      HC.assert(getBlockSize(TP) === 4, "block size must be untouched by a cancel");
    });

    // ===== Bad block sizes =====

    check("A non-positive / fractional block size is rejected", function () {
      var bad = [0, -2, 2.5, "abc", null, undefined];
      for (var i = 0; i < bad.length; i++) {
        var res = computeBlock(SCHED6, 0, bad[i]);
        HC.assert(res.ok === false, "block size '" + bad[i] + "' must be rejected");
        HC.assert(res.code === "bad_size", "bad size should yield code 'bad_size', got " + res.code);
      }
    });

    // ===== Defensive: garbage never throws and never persists =====

    check("Garbage input is handled and never persists a booking", function () {
      var GP = "__selftest_block_garbage__";
      clearProvider(GP);
      setSchedule(GP, SCHED6);
      setBlockSize(GP, 3);
      var before = getBookings(GP).length;
      var bad = [null, undefined, 42, "", [], {}, "not-a-date"];
      for (var i = 0; i < bad.length; i++) {
        var res = bookBlock(GP, bad[i], "X");
        HC.assert(res && res.ok === false, "garbage start #" + i + " must be refused");
      }
      HC.assert(getBookings(GP).length === before, "garbage starts must not store a booking");
      clearProvider(GP);
    });

    check("computeBlock never throws on wholly garbage arguments", function () {
      var inputs = [
        [null, null, null], [undefined, 0, 0], [42, "x", {}],
        [[], -1, -1], [{}, 99, 99]
      ];
      for (var i = 0; i < inputs.length; i++) {
        var res = computeBlock(inputs[i][0], inputs[i][1], inputs[i][2]);
        HC.assert(res && res.ok === false, "garbage args #" + i + " should fail cleanly, not throw");
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
    id: "provider-ticket-block",
    title: "Block tickets (N consecutive sessions)",
    side: "provider",
    icon: "📚",
    summary: "Sell a block ticket that books a camper into N consecutive sessions counting forward from the start date the parent picks — ideal for a structured progression camp. A start is blocked when too few consecutive dates remain.",
    render: render,
    selfTest: selfTest
  });
})();
