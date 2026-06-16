/* HolidayCamp feature — provider-cutoff
 *
 * No booking cut-off — book up to the last minute  (provider side)
 *
 * Replicates Happity's "no cut-off time" booking behaviour. Evidence:
 *   - support article 5827931 ("When is the cut off for booking my classes?"):
 *       "There is no cut off time for booking a class, meaning that parents
 *        can book right up until the last minute."
 *       "We know that some parents like to be more flexible and spontaneous
 *        with their bookings and this prevents you from missing out on last
 *        minute bookings and helps to fill your classes!"
 *       "We recommend that you check your registers just before a class starts
 *        to ensure you do not miss anyone…"
 *
 * Framed for SCHOOL-AGE HOLIDAY CAMPS (not baby classes). A holiday camp runs
 * on a given DATE with a START TIME (taken live from the planner's
 * hours.start, e.g. "09:00"). By default — exactly like Happity — there is NO
 * booking cut-off: a parent can book right up until the moment the camp starts.
 *
 * Because some camp providers DO need a small lead time (a packed lunch order,
 * a wristband print run, a coach headcount), this module also lets a provider
 * OPT IN to a cut-off measured in minutes before start. The Happity default,
 * and the headline behaviour this feature demonstrates, is cut-off = 0 = none:
 * book up to the last minute.
 *
 * ACCEPTANCE CRITERION (asserted in selfTest):
 *   A camp accepts bookings right up to start time.
 * We verify, with NO cut-off configured (the Happity default):
 *   - a booking one minute before start is ACCEPTED,
 *   - a booking one SECOND before start is ACCEPTED (the literal "last minute"),
 *   - a booking exactly AT start time is closed (the camp has begun),
 *   - a booking after start is closed,
 *   and, with an OPT-IN cut-off configured, that the window closes early by the
 *   configured number of minutes — proving the default really is "no cut-off".
 *
 * Self-contained, defensive, no imports/exports. Calls HC.registerFeature.
 */
(function () {
  "use strict";

  // Defensive: never throw at module load if HC isn't present.
  if (typeof window === "undefined" || !window.HC || typeof window.HC.registerFeature !== "function") {
    if (typeof console !== "undefined" && console.warn) {
      console.warn("[HC] provider-cutoff: HC core not found; skipping registration.");
    }
    return;
  }

  var HC = window.HC;

  // Persisted shape: { <campId>: { cutoffMins:Number } }   (cutoffMins 0 = none)
  var STORE_KEY = "provider_cutoff";

  /* ===================================================================
     PURE LOGIC (testable, DOM-free)
     =================================================================== */

  function asText(v) {
    return typeof v === "string" ? v : (v == null ? "" : String(v));
  }

  // Clamp/normalise a cut-off in minutes. Anything invalid or negative => 0
  // (= no cut-off, the Happity default). Capped so a provider can't lock a
  // camp out for an absurd window.
  var MAX_CUTOFF_MINS = 7 * 24 * 60; // one week
  function normCutoff(v) {
    var n = Number(v);
    if (!isFinite(n) || n <= 0) return 0;
    n = Math.floor(n);
    if (n > MAX_CUTOFF_MINS) return MAX_CUTOFF_MINS;
    return n;
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

  // Strict HH:MM (24h) validation.
  function isValidTime(s) {
    var str = asText(s);
    if (!/^\d{2}:\d{2}$/.test(str)) return false;
    var p = str.split(":");
    var h = Number(p[0]), m = Number(p[1]);
    return h >= 0 && h <= 23 && m >= 0 && m <= 59;
  }

  // Combine an ISO date + HH:MM start time into an epoch-ms instant.
  // Returns null if either part is invalid. We build it in local time so the
  // demo clock and the camp clock agree.
  function startInstant(dateISO, timeHHMM) {
    if (!isValidISODate(dateISO) || !isValidTime(timeHHMM)) return null;
    var dp = dateISO.split("-");
    var tp = timeHHMM.split(":");
    var dt = new Date(
      Number(dp[0]), Number(dp[1]) - 1, Number(dp[2]),
      Number(tp[0]), Number(tp[1]), 0, 0
    );
    var ms = dt.getTime();
    return isFinite(ms) ? ms : null;
  }

  // Coerce "now" to epoch-ms. Accepts a Date, a number (ms), or undefined
  // (=> real clock). Used so tests can pin the clock deterministically.
  function nowMs(now) {
    if (now instanceof Date) {
      var t = now.getTime();
      return isFinite(t) ? t : Date.now();
    }
    if (typeof now === "number" && isFinite(now)) return now;
    return Date.now();
  }

  // THE acceptance check. Given a camp { date, startTime, cutoffMins } and a
  // "now" instant, can a parent still book?
  //
  //   bookingClosesAt = startInstant - cutoffMins*60_000
  //   bookable  <=>  now < bookingClosesAt
  //
  // With the default cutoffMins = 0, bookingClosesAt === startInstant, so a
  // parent can book at any instant STRICTLY BEFORE the camp starts — "right up
  // until the last minute" — and the window closes the moment it begins.
  function bookingStatus(camp, now) {
    var c = (camp && typeof camp === "object") ? camp : {};
    var start = startInstant(c.date, c.startTime);
    if (start === null) {
      return { bookable: false, reason: "no-start-time", closesAt: null, start: null };
    }
    var cutoff = normCutoff(c.cutoffMins);
    var closesAt = start - cutoff * 60000;
    var t = nowMs(now);
    if (t < closesAt) {
      return { bookable: true, reason: cutoff === 0 ? "open-until-start" : "open-until-cutoff", closesAt: closesAt, start: start };
    }
    return {
      bookable: false,
      reason: (t >= start) ? "started" : "cutoff-passed",
      closesAt: closesAt,
      start: start
    };
  }

  // Convenience boolean used by the UI and tests.
  function canBook(camp, now) {
    return bookingStatus(camp, now).bookable === true;
  }

  // Human label for how long is left to book (or why it's closed).
  function windowLabel(camp, now) {
    var st = bookingStatus(camp, now);
    if (st.start === null) return "No start time set";
    if (!st.bookable) {
      return st.reason === "started" ? "Camp has started — bookings closed"
        : "Booking window closed";
    }
    var ms = st.closesAt - nowMs(now);
    var mins = Math.max(0, Math.floor(ms / 60000));
    var cutoff = normCutoff(camp && camp.cutoffMins);
    var tail = cutoff === 0 ? " (no cut-off — book up to the last minute)"
      : " (closes " + cutoff + " min before start)";
    if (mins < 60) return "Bookable — about " + mins + " min left" + tail;
    var hrs = Math.floor(mins / 60);
    if (hrs < 24) return "Bookable — about " + hrs + "h left" + tail;
    return "Bookable — " + Math.floor(hrs / 24) + "d+ left" + tail;
  }

  /* ---- persistence helpers (per-camp cut-off override) ---- */

  function readAll() {
    var all = HC.store.get(STORE_KEY, {});
    return (all && typeof all === "object" && !Array.isArray(all)) ? all : {};
  }
  function getCutoff(campId) {
    var rec = readAll()[asText(campId)];
    return rec ? normCutoff(rec.cutoffMins) : 0;
  }
  function setCutoff(campId, mins) {
    var id = asText(campId);
    if (!id) return 0;
    var all = readAll();
    all[id] = { cutoffMins: normCutoff(mins) };
    HC.store.set(STORE_KEY, all);
    return all[id].cutoffMins;
  }
  function clearCutoff(campId) {
    var all = readAll();
    delete all[asText(campId)];
    HC.store.set(STORE_KEY, all);
  }

  /* ---- pick a real camp from live planner data (best effort) ---- */

  // Returns { id, name, date, startTime } using the planner's hours.start when
  // available, else a sensible holiday-camp default of 09:00.
  function sampleCamp() {
    var fallback = { id: "demo-camp", name: "Multi-Activity Holiday Camp", date: "2026-08-03", startTime: "09:00" };
    try {
      var planner = HC.data.planner || {};
      var byId = planner.byId || {};
      var providers = HC.data.providers || [];
      var ids = Object.keys(byId);
      for (var i = 0; i < ids.length; i++) {
        var rec = byId[ids[i]];
        if (rec && rec.hours && isValidTime(rec.hours.start)) {
          var name = ids[i];
          for (var j = 0; j < providers.length; j++) {
            if (providers[j] && (providers[j].id === ids[i] || providers[j].slug === ids[i])) {
              name = providers[j].name || providers[j].title || name;
              break;
            }
          }
          return { id: ids[i], name: name, date: "2026-08-03", startTime: rec.hours.start };
        }
      }
    } catch (e) { /* fall through */ }
    return fallback;
  }

  /* ===================================================================
     UI
     =================================================================== */

  function el(tag, attrs, html) { return HC.util.el(tag, attrs, html); }

  function fmtClock(ms) {
    try {
      var d = new Date(ms);
      var hh = String(d.getHours()).padStart(2, "0");
      var mm = String(d.getMinutes()).padStart(2, "0");
      return hh + ":" + mm;
    } catch (e) { return "--:--"; }
  }

  function render(mountEl) {
    try {
      var camp = sampleCamp();
      var storedCutoff = getCutoff(camp.id);

      mountEl.innerHTML = "";

      var intro = el("p", { style: "font-size:14px;color:var(--text,#383838);margin:0 0 14px" },
        'Like Happity, this camp has <b>no booking cut-off by default</b> — parents can book right up ' +
        'until it starts. Drag the demo clock toward the start time and watch the window stay open ' +
        'until the very last minute. Providers who need a little lead time can opt in to a cut-off.');
      mountEl.appendChild(intro);

      var campLine = el("p", { style: "font-size:13px;color:var(--muted,#808080);margin:0 0 12px" },
        "Camp: <b>" + escapeHtml(camp.name) + "</b> · starts <b>" + escapeHtml(camp.startTime) +
        "</b> on " + escapeHtml(camp.date));
      mountEl.appendChild(campLine);

      // Cut-off control (provider opt-in).
      var ctrlWrap = el("div", { style: "background:var(--purple-tint,#F0E8F4);border-radius:14px;padding:14px 16px;margin:0 0 16px" });
      ctrlWrap.appendChild(el("div", {
        style: "font-family:Quicksand,system-ui,sans-serif;font-weight:700;color:var(--purple,#603488);font-size:13px;margin-bottom:8px"
      }, "Booking cut-off (provider setting)"));
      var presets = [
        { mins: 0, label: "None — book to last minute" },
        { mins: 30, label: "30 min before" },
        { mins: 60, label: "1 hour before" },
        { mins: 1440, label: "1 day before" }
      ];
      var btnRow = el("div", { style: "display:flex;flex-wrap:wrap;gap:8px" });
      presets.forEach(function (p) {
        var active = normCutoff(storedCutoff) === p.mins;
        var b = el("button", {
          type: "button",
          class: "hc-btn" + (active ? "" : " hc-btn-ghost"),
          "data-cutoff": String(p.mins)
        }, escapeHtml(p.label));
        btnRow.appendChild(b);
      });
      ctrlWrap.appendChild(btnRow);
      mountEl.appendChild(ctrlWrap);

      // Demo clock: a slider of minutes-before-start.
      var sliderWrap = el("div", { style: "margin:0 0 14px" });
      sliderWrap.appendChild(el("label", {
        style: "display:block;font-size:12.5px;color:var(--muted,#808080);margin-bottom:6px"
      }, "Demo clock — how far before start is \"now\"?"));
      var slider = el("input", {
        type: "range", min: "-15", max: "180", value: "1", step: "1",
        style: "width:100%", id: "hcCutoffSlider"
      });
      sliderWrap.appendChild(slider);
      mountEl.appendChild(sliderWrap);

      var statusBox = el("div", {
        id: "hcCutoffStatus",
        style: "border-radius:14px;padding:16px;text-align:center;font-family:Quicksand,system-ui,sans-serif"
      });
      mountEl.appendChild(statusBox);

      function currentCutoff() { return getCutoff(camp.id); }

      function update() {
        var minsBefore = Number(slider.value);
        var start = startInstant(camp.date, camp.startTime);
        var now = start - minsBefore * 60000;
        var liveCamp = { date: camp.date, startTime: camp.startTime, cutoffMins: currentCutoff() };
        var st = bookingStatus(liveCamp, now);
        var ok = st.bookable;
        statusBox.style.background = ok ? "#E1F0E4" : "var(--pink-tint,#FCE8F0)";
        statusBox.style.color = ok ? "#2f7d4f" : "#9a1f5e";
        var nowLabel = minsBefore >= 0
          ? (fmtClock(now) + " — " + minsBefore + " min before start")
          : (fmtClock(now) + " — " + Math.abs(minsBefore) + " min AFTER start");
        statusBox.innerHTML =
          '<div style="font-size:26px">' + (ok ? "🟢" : "🔴") + "</div>" +
          '<div style="font-size:16px;font-weight:700;margin-top:4px">' +
            (ok ? "Bookings OPEN" : "Bookings CLOSED") + "</div>" +
          '<div style="font-size:12.5px;margin-top:6px;font-weight:400">' +
            escapeHtml(nowLabel) + "</div>" +
          '<div style="font-size:12.5px;margin-top:4px;font-weight:400">' +
            escapeHtml(windowLabel(liveCamp, now)) + "</div>";
      }

      slider.addEventListener("input", update);

      btnRow.addEventListener("click", function (e) {
        var b = e.target.closest("[data-cutoff]");
        if (!b) return;
        var mins = normCutoff(b.getAttribute("data-cutoff"));
        setCutoff(camp.id, mins);
        // refresh button styles
        var all = btnRow.querySelectorAll("[data-cutoff]");
        for (var i = 0; i < all.length; i++) {
          var isActive = normCutoff(all[i].getAttribute("data-cutoff")) === mins;
          all[i].className = "hc-btn" + (isActive ? "" : " hc-btn-ghost");
        }
        HC.util.toast(mins === 0 ? "No cut-off — parents can book up to the last minute"
          : "Cut-off set: bookings close " + mins + " min before start");
        update();
      });

      update();
    } catch (e) {
      mountEl.innerHTML = '<p style="color:#9a1f5e">Could not render: ' +
        escapeHtml(e && e.message ? e.message : String(e)) + "</p>";
    }
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  /* ===================================================================
     SELF-TEST
     =================================================================== */

  function selfTest() {
    var pass = 0, fail = 0, log = [];
    function check(label, fn) {
      try {
        fn();
        pass += 1; log.push("✓ " + label);
      } catch (e) {
        fail += 1; log.push("✗ " + label + " — " + (e && e.message ? e.message : String(e)));
      }
    }

    // A concrete camp: starts 09:00 on 3 Aug 2026.
    var DATE = "2026-08-03";
    var START = "09:00";
    var startMs = startInstant(DATE, START);

    // No cut-off configured (the Happity default).
    var openCamp = { date: DATE, startTime: START, cutoffMins: 0 };

    /* ===== ACCEPTANCE CRITERION: accepts bookings right up to start ===== */

    check("ACCEPTANCE: a booking 1 minute before start is accepted (no cut-off)", function () {
      var now = startMs - 60 * 1000; // 08:59
      HC.assert(canBook(openCamp, now) === true,
        "should still be bookable one minute before start");
    });

    check("ACCEPTANCE: a booking 1 SECOND before start is accepted (last minute)", function () {
      var now = startMs - 1000; // 08:59:59
      var st = bookingStatus(openCamp, now);
      HC.assert(st.bookable === true, "should be bookable one second before start");
      HC.assert(st.reason === "open-until-start", "reason should be open-until-start, got " + st.reason);
    });

    check("ACCEPTANCE: a booking even 1ms before start is accepted", function () {
      var now = startMs - 1; // the literal last instant
      HC.assert(canBook(openCamp, now) === true, "the very last instant before start must accept");
    });

    check("Booking exactly AT start time is closed (camp has begun)", function () {
      var st = bookingStatus(openCamp, startMs);
      HC.assert(st.bookable === false, "at start time the window is closed");
      HC.assert(st.reason === "started", "reason should be 'started', got " + st.reason);
    });

    check("Booking after start is closed", function () {
      HC.assert(canBook(openCamp, startMs + 60 * 1000) === false,
        "one minute after start must be closed");
    });

    check("Well before start is open (e.g. 3 hours out)", function () {
      HC.assert(canBook(openCamp, startMs - 180 * 60 * 1000) === true,
        "three hours before start must be open");
    });

    /* ===== Opt-in cut-off proves the default really is "no cut-off" ===== */

    check("With a 60-min opt-in cut-off the window closes an hour earlier", function () {
      var camp = { date: DATE, startTime: START, cutoffMins: 60 };
      // 90 min before start -> still open
      HC.assert(canBook(camp, startMs - 90 * 60 * 1000) === true, "90 min before should be open");
      // 61 min before start -> still open (cut-off is 60)
      HC.assert(canBook(camp, startMs - 61 * 60 * 1000) === true, "61 min before should be open");
      // exactly 60 min before -> closed (now >= closesAt)
      HC.assert(canBook(camp, startMs - 60 * 60 * 1000) === false, "at the 60-min cut-off it closes");
      // 30 min before -> closed
      HC.assert(canBook(camp, startMs - 30 * 60 * 1000) === false, "30 min before should be closed by the cut-off");
    });

    check("The no-cut-off default keeps the window open later than any cut-off", function () {
      var t = startMs - 5 * 60 * 1000; // 5 min before start
      var noCut = { date: DATE, startTime: START, cutoffMins: 0 };
      var withCut = { date: DATE, startTime: START, cutoffMins: 30 };
      HC.assert(canBook(noCut, t) === true, "no cut-off: open 5 min before");
      HC.assert(canBook(withCut, t) === false, "30-min cut-off: closed 5 min before");
    });

    /* ===== normCutoff sanitisation ===== */

    check("Cut-off normalisation: invalid/negative => 0 (no cut-off)", function () {
      HC.assert(normCutoff(undefined) === 0, "undefined => 0");
      HC.assert(normCutoff(null) === 0, "null => 0");
      HC.assert(normCutoff(-15) === 0, "negative => 0");
      HC.assert(normCutoff("abc") === 0, "non-numeric => 0");
      HC.assert(normCutoff(45.7) === 45, "floors to 45");
      HC.assert(normCutoff(99999999) === MAX_CUTOFF_MINS, "caps at one week");
    });

    /* ===== persistence round-trip ===== */

    check("Per-camp cut-off persists and clears via HC.store", function () {
      var id = "__test_camp_" + HC.util.uid();
      HC.assert(getCutoff(id) === 0, "unknown camp defaults to no cut-off");
      setCutoff(id, 30);
      HC.assert(getCutoff(id) === 30, "30-min cut-off should persist");
      setCutoff(id, 0);
      HC.assert(getCutoff(id) === 0, "resetting to 0 should persist as no cut-off");
      setCutoff(id, -5);
      HC.assert(getCutoff(id) === 0, "negative is stored as 0");
      clearCutoff(id);
      HC.assert(getCutoff(id) === 0, "cleared camp reads as no cut-off");
    });

    /* ===== live planner integration ===== */

    check("A live planner camp is bookable right up to its real start time", function () {
      var camp = sampleCamp();
      HC.assert(isValidTime(camp.startTime), "sample camp must have a valid HH:MM start, got " + camp.startTime);
      var s = startInstant(camp.date, camp.startTime);
      HC.assert(s !== null, "sample camp start instant must resolve");
      var live = { date: camp.date, startTime: camp.startTime, cutoffMins: 0 };
      HC.assert(canBook(live, s - 60 * 1000) === true, "live camp must accept a booking 1 min before start");
      HC.assert(canBook(live, s - 1000) === true, "live camp must accept a booking 1 sec before start");
      HC.assert(canBook(live, s) === false, "live camp must close once it starts");
    });

    /* ===== Defensive: garbage never throws ===== */

    check("Garbage inputs are handled without throwing (closed, never crash)", function () {
      var bad = [null, undefined, 42, "", [], {}, { date: "nope", startTime: "25:99" }, { date: DATE }];
      for (var i = 0; i < bad.length; i++) {
        var st = bookingStatus(bad[i], startMs);
        HC.assert(st && st.bookable === false, "garbage #" + i + " must be not-bookable");
        HC.assert(canBook(bad[i], startMs) === false, "garbage #" + i + " canBook must be false");
        // windowLabel must not throw either
        windowLabel(bad[i], startMs);
      }
    });

    check("Invalid 'now' falls back to the real clock without throwing", function () {
      // A far-future camp with a junk 'now' should resolve via Date.now() and
      // still be bookable (it hasn't started yet).
      var far = { date: "2099-12-31", startTime: "09:00", cutoffMins: 0 };
      HC.assert(canBook(far, "not-a-number") === true, "junk now => real clock; far-future camp is bookable");
      HC.assert(canBook(far, NaN) === true, "NaN now => real clock");
    });

    return { pass: pass, fail: fail, log: log };
  }

  /* ===================================================================
     register
     =================================================================== */

  HC.registerFeature({
    id: "provider-cutoff",
    title: "No booking cut-off",
    side: "provider",
    icon: "⏱️",
    summary: "Like Happity, camps take bookings right up to the last minute — there is no cut-off by default, so you never miss a spontaneous last-minute booking. Providers who need lead time can opt in to a cut-off (30 min, 1 hour, 1 day) per camp.",
    render: render,
    selfTest: selfTest
  });
})();
