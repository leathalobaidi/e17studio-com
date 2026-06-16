/* HolidayCamp feature: provider-weekly-timetable
 * ------------------------------------------------------------------
 * Replicates Happity's provider "Weekly Timetable" — the place where
 * all of a provider's classes live, each shown with its forthcoming
 * dates. Reframed for SCHOOL-AGE HOLIDAY CAMPS: a "slot" is a camp's
 * run at a venue, and its "forthcoming dates" are the specific
 * summer-holiday weeks it is scheduled for (real Monday-anchored
 * date ranges from the live planner).
 *
 * Evidence (Happity support corpus):
 *  - 10225786 "How to add a class to your timetable":
 *      "Your timetable is where all your Happity classes live."
 *      "Click My Classes ... and select Weekly Timetable."
 *      Step 4 (Schedule type, date and time): Weekly class / Course /
 *      Event, with a running period and specific dates ("Click Edit
 *      to select specific dates").
 *  - 2893525 "Add classes to your timetable" (referenced in brief).
 *
 * Acceptance criterion (asserted in selfTest):
 *   A timetable view lists each camp slot with its forthcoming dates.
 *
 * Faithful behaviours modelled:
 *  - The timetable is seeded from the live planner (each scheduled
 *    camp week becomes a dated session under a slot for that camp).
 *  - Each SLOT carries a schedule type (Weekly / Course / Event) and
 *    a list of forthcoming dated sessions; only future sessions are
 *    "forthcoming" relative to a reference date.
 *  - A provider can ADD a new slot (the scheduling wizard's end state)
 *    and remove a slot; changes persist via HC.store only.
 *  - Sessions already in the past are filtered out of the forthcoming
 *    view (a real timetable shows what's coming up).
 *  - Slots with no confirmed dates still appear, flagged "dates to be
 *    confirmed" (mirrors planner weeksLikely / session-based camps).
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

  var STORE_KEY = "provider_timetable_v1"; // { slots: [ {id, campId, title, venue, type, ageLabel, sessions:[...], custom:true} ] }

  // Schedule types mirror Happity step 4 (Weekly class / Course / Event),
  // reframed for camps.
  var SCHEDULE_TYPES = ["Weekly camp", "Course", "Event"];

  /* ============================================================
   * Date helpers — pure, no DOM. A "session" is one dated block:
   *   { weekId, label, dates, iso (Monday), days }
   * ============================================================ */

  // Parse an ISO yyyy-mm-dd into a UTC-midnight ms value. Returns NaN
  // for anything unparseable so callers can defend.
  function isoToMs(iso) {
    if (!iso || typeof iso !== "string") return NaN;
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
    if (!m) return NaN;
    return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  }

  // End-of-week ms (Monday + days). Used so a session counts as
  // "forthcoming" until the LAST day it runs has passed.
  function sessionEndMs(session) {
    var start = isoToMs(session && session.iso);
    if (isNaN(start)) return NaN;
    var days = Number(session && session.days);
    if (!isFinite(days) || days < 1) days = 5;
    // last day = monday + (days-1) full days; keep it inclusive to end of that day
    return start + (days - 1) * 86400000 + 86399000;
  }

  // Reference "today" as ms. Tests pass an explicit value for stability;
  // the live UI uses the real clock.
  function nowMs(ref) {
    if (ref != null) {
      var asMs = (typeof ref === "number") ? ref : isoToMs(ref);
      if (!isNaN(asMs)) return asMs;
    }
    return Date.now();
  }

  /* Given a slot, return only its forthcoming (not-yet-finished)
   * sessions, sorted earliest-first. Sessions with no parseable date
   * are treated as forthcoming-but-unconfirmed and kept at the end. */
  function forthcomingSessions(slot, refMs) {
    var out = [];
    var sessions = (slot && Array.isArray(slot.sessions)) ? slot.sessions : [];
    for (var i = 0; i < sessions.length; i++) {
      var s = sessions[i];
      if (!s) continue;
      var end = sessionEndMs(s);
      if (isNaN(end)) {
        // unconfirmed date — still "forthcoming" so the slot isn't empty
        out.push({ s: s, end: Infinity, dated: false });
      } else if (end >= refMs) {
        out.push({ s: s, end: end, dated: true });
      }
    }
    out.sort(function (a, b) { return a.end - b.end; });
    return out.map(function (x) { return x.s; });
  }

  /* ============================================================
   * Seeding — turn the live planner into a default timetable.
   *
   * For each camp in the planner, build ONE slot whose sessions are
   * its scheduled weeks (real dates from HC.data.planner.weeks).
   * ============================================================ */

  function plannerWeeks() {
    try {
      var w = HC.data.planner && HC.data.planner.weeks;
      return Array.isArray(w) ? w : [];
    } catch (e) { return []; }
  }

  function providerById(campId) {
    try {
      var ps = HC.data.providers || [];
      for (var i = 0; i < ps.length; i++) {
        if (ps[i] && ps[i].id === campId) return ps[i];
      }
    } catch (e) { /* ignore */ }
    return null;
  }

  // How many days a camp runs in a given planner week (defaults to the
  // week's own day count). Mirrors planner daysPerWeek overrides.
  function daysForWeek(entry, week) {
    var fallback = (week && Number(week.days)) || 5;
    if (!entry) return fallback;
    var dpw = entry.daysPerWeek;
    if (dpw == null) return fallback;
    if (typeof dpw === "number" && isFinite(dpw)) return dpw;
    if (typeof dpw === "object") {
      var v = dpw[String(week.id)];
      if (v != null && isFinite(Number(v))) return Number(v);
    }
    return fallback;
  }

  // Build the list of dated sessions for one planner camp entry.
  function sessionsFromPlannerEntry(entry, weeks) {
    var sessions = [];
    if (!entry) return sessions;
    var ids = Array.isArray(entry.weeks) ? entry.weeks : [];
    var byWeekId = {};
    for (var i = 0; i < weeks.length; i++) { byWeekId[String(weeks[i].id)] = weeks[i]; }
    for (var j = 0; j < ids.length; j++) {
      var wk = byWeekId[String(ids[j])];
      if (!wk) continue;
      sessions.push({
        weekId: wk.id,
        label: wk.label,
        dates: wk.dates,
        iso: wk.mon,
        days: daysForWeek(entry, wk)
      });
    }
    return sessions;
  }

  // Build the full seeded timetable (array of slots) from live data.
  function seedTimetable() {
    var weeks = plannerWeeks();
    var planner = (HC.data.planner && HC.data.planner.byId) || {};
    var slots = [];
    for (var campId in planner) {
      if (!Object.prototype.hasOwnProperty.call(planner, campId)) continue;
      var entry = planner[campId] || {};
      var prov = providerById(campId);
      var sessions = sessionsFromPlannerEntry(entry, weeks);
      // Skip camps that are clearly not week-based AND have no dates at
      // all only if there's also no provider record — otherwise keep
      // them, flagged unconfirmed, so the timetable is complete.
      slots.push({
        id: "seed::" + campId,
        campId: campId,
        title: (prov && prov.name) || campId,
        venue: (prov && prov.venue) || "",
        ageLabel: (prov && prov.ageLabel) || "",
        type: entry.sessionBased ? "Event" : "Weekly camp",
        unconfirmed: !!(entry.weeksLikely || entry.sessionBased) && sessions.length === 0,
        sessions: sessions,
        custom: false
      });
    }
    // Stable order: most forthcoming dates first, then alphabetical.
    slots.sort(function (a, b) {
      var d = (b.sessions.length) - (a.sessions.length);
      if (d !== 0) return d;
      return String(a.title).localeCompare(String(b.title));
    });
    return slots;
  }

  /* ============================================================
   * Persistence — custom (provider-added / removed) slots only.
   *
   * We store custom slots + a list of suppressed seed ids, then merge
   * with the live seed at read time. This keeps the timetable in sync
   * with the underlying data while honouring provider edits.
   * ============================================================ */

  function readState() {
    var st = {};
    try { st = HC.store.get(STORE_KEY, {}) || {}; } catch (e) { st = {}; }
    if (!st || typeof st !== "object") st = {};
    if (!Array.isArray(st.custom)) st.custom = [];
    if (!Array.isArray(st.removed)) st.removed = [];
    return st;
  }

  function writeState(st) {
    try { HC.store.set(STORE_KEY, st); return true; } catch (e) { return false; }
  }

  // The merged, live timetable a provider sees: seeded slots (minus
  // removed) plus their own custom slots.
  function getTimetable() {
    var st = readState();
    var removed = {};
    for (var i = 0; i < st.removed.length; i++) removed[st.removed[i]] = true;
    var seed = seedTimetable().filter(function (s) { return !removed[s.id]; });
    var custom = st.custom.filter(function (s) { return s && s.id; });
    return seed.concat(custom);
  }

  // Add a provider slot. Validates minimally and persists. Returns the
  // created slot or throws (callers in the UI catch).
  function addSlot(input) {
    input = input || {};
    var title = String(input.title || "").trim();
    if (!title) throw new Error("A slot needs a title");
    var type = SCHEDULE_TYPES.indexOf(input.type) >= 0 ? input.type : "Weekly camp";
    var sessions = Array.isArray(input.sessions) ? input.sessions.slice() : [];
    var slot = {
      id: "custom::" + HC.util.uid(),
      campId: input.campId || null,
      title: title,
      venue: String(input.venue || ""),
      ageLabel: String(input.ageLabel || ""),
      type: type,
      unconfirmed: sessions.length === 0,
      sessions: sessions,
      custom: true
    };
    var st = readState();
    st.custom.push(slot);
    writeState(st);
    return slot;
  }

  // Remove a slot by id. Seed slots are suppressed; custom slots are
  // dropped. Returns true if something was removed.
  function removeSlot(id) {
    if (!id) return false;
    var st = readState();
    var before = st.custom.length;
    st.custom = st.custom.filter(function (s) { return s.id !== id; });
    var removedCustom = st.custom.length !== before;
    if (!removedCustom) {
      if (st.removed.indexOf(id) === -1) st.removed.push(id);
    }
    writeState(st);
    return true;
  }

  function resetTimetable() {
    writeState({ custom: [], removed: [] });
  }

  /* Build a session object from a planner week id (used by the add form). */
  function sessionForWeekId(weekId) {
    var weeks = plannerWeeks();
    for (var i = 0; i < weeks.length; i++) {
      if (String(weeks[i].id) === String(weekId)) {
        var wk = weeks[i];
        return { weekId: wk.id, label: wk.label, dates: wk.dates, iso: wk.mon, days: Number(wk.days) || 5 };
      }
    }
    return null;
  }

  /* ============================================================
   * Rendering
   * ============================================================ */

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function styleOnce() {
    if (document.getElementById("hc-timetable-styles")) return;
    var css =
      ".hc-tt-bar{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:6px 0 14px}" +
      ".hc-tt-bar .hc-tt-count{font-family:'Quicksand',system-ui,sans-serif;font-weight:700;color:var(--purple,#603488);font-size:14px;margin-right:auto}" +
      ".hc-slot{border:1.5px solid var(--line,#E6E6E6);border-radius:14px;padding:14px 16px;margin-bottom:12px;background:#fff}" +
      ".hc-slot-head{display:flex;align-items:flex-start;gap:10px;flex-wrap:wrap}" +
      ".hc-slot-title{font-family:'Quicksand',system-ui,sans-serif;font-weight:700;color:var(--purple,#603488);font-size:16px;margin:0;flex:1 1 auto}" +
      ".hc-slot-sub{color:var(--muted,#808080);font-size:12.5px;margin:2px 0 0}" +
      ".hc-tt-tag{font-size:10.5px;font-weight:700;padding:3px 9px;border-radius:999px;text-transform:uppercase;letter-spacing:.3px;" +
        "background:var(--purple-tint,#F0E8F4);color:var(--purple,#603488);white-space:nowrap}" +
      ".hc-tt-tag.evt{background:#FCE8F0;color:#9a1f5e}" +
      ".hc-tt-tag.course{background:#E1F0E4;color:#2f7d4f}" +
      ".hc-dates{list-style:none;margin:10px 0 0;padding:0;display:flex;flex-direction:column;gap:6px}" +
      ".hc-date{display:flex;align-items:baseline;gap:10px;font-size:13.5px;color:var(--text,#383838)}" +
      ".hc-date .hc-d-when{font-family:'Quicksand',system-ui,sans-serif;font-weight:700;color:var(--magenta,#F82488);min-width:130px}" +
      ".hc-date .hc-d-range{color:var(--text,#383838)}" +
      ".hc-date .hc-d-days{color:var(--muted,#808080);font-size:12px}" +
      ".hc-tt-empty{color:var(--muted,#808080);font-size:13px;font-style:italic;margin:10px 0 0}" +
      ".hc-tt-form{border:1.5px dashed var(--purple-tint,#F0E8F4);border-radius:14px;padding:14px 16px;margin-top:8px}" +
      ".hc-tt-form label{display:block;font-size:12px;font-weight:700;color:var(--purple,#603488);margin:8px 0 3px;font-family:'Quicksand',system-ui,sans-serif}" +
      ".hc-tt-form input,.hc-tt-form select{width:100%;box-sizing:border-box;padding:8px 10px;border:1.5px solid var(--line,#E6E6E6);border-radius:10px;font:inherit}" +
      ".hc-tt-wkgrid{display:flex;flex-wrap:wrap;gap:6px;margin-top:4px}" +
      ".hc-tt-wk{font-size:12px;border:1.5px solid var(--line,#E6E6E6);border-radius:999px;padding:5px 10px;cursor:pointer;user-select:none}" +
      ".hc-tt-wk.on{background:var(--purple,#603488);color:#fff;border-color:var(--purple,#603488)}" +
      ".hc-link{background:none;border:none;color:var(--magenta,#F82488);cursor:pointer;font-weight:700;font-size:12.5px;font-family:'Quicksand',system-ui,sans-serif;padding:0}";
    var tag = document.createElement("style");
    tag.id = "hc-timetable-styles";
    tag.textContent = css;
    document.head.appendChild(tag);
  }

  function renderSlot(slot, refMs) {
    var up = forthcomingSessions(slot, refMs);
    var typeClass = slot.type === "Event" ? "evt" : (slot.type === "Course" ? "course" : "");
    var sub = [];
    if (slot.venue) sub.push(esc(slot.venue));
    if (slot.ageLabel) sub.push("ages " + esc(slot.ageLabel));
    var html =
      '<div class="hc-slot" data-slot-id="' + esc(slot.id) + '">' +
        '<div class="hc-slot-head">' +
          '<div style="flex:1 1 auto">' +
            '<p class="hc-slot-title">' + esc(slot.title) + "</p>" +
            (sub.length ? '<p class="hc-slot-sub">' + sub.join(" · ") + "</p>" : "") +
          "</div>" +
          '<span class="hc-tt-tag ' + typeClass + '">' + esc(slot.type) + "</span>" +
          '<button class="hc-link" data-tt-remove="' + esc(slot.id) + '">Remove</button>' +
        "</div>";

    if (up.length) {
      html += '<ul class="hc-dates">';
      for (var i = 0; i < up.length; i++) {
        var s = up[i];
        var dayTxt = (Number(s.days) === 1) ? "1 day" : (Number(s.days) || 5) + " days";
        html +=
          '<li class="hc-date">' +
            '<span class="hc-d-when">' + esc(s.label || "Date") + "</span>" +
            '<span class="hc-d-range">' + esc(s.dates || "dates to confirm") + "</span>" +
            '<span class="hc-d-days">' + dayTxt + "</span>" +
          "</li>";
      }
      html += "</ul>";
    } else {
      html += '<p class="hc-tt-empty">No forthcoming dates yet — dates to be confirmed.</p>';
    }
    html += "</div>";
    return html;
  }

  function renderInto(mountEl) {
    styleOnce();
    var refMs = nowMs(); // live clock for the UI
    var slots = getTimetable();

    var html =
      '<p style="font-size:14px;color:var(--text,#383838);margin:0 0 6px">' +
        "Your timetable is where all your holiday-camp slots live. Each slot lists its " +
        "<strong>forthcoming dates</strong> — the summer-holiday weeks it runs.</p>";

    html += '<div class="hc-tt-bar">' +
      '<span class="hc-tt-count">' + slots.length + " slot" + (slots.length === 1 ? "" : "s") + " on your timetable</span>" +
      '<button class="hc-btn" data-tt-add>Add new slot</button>' +
      '<button class="hc-btn hc-btn-ghost" data-tt-reset>Reset to live data</button>' +
      "</div>";

    html += '<div id="hcTtList">';
    if (!slots.length) {
      html += '<p class="hc-tt-empty">No slots yet — add your first camp slot.</p>';
    } else {
      for (var i = 0; i < slots.length; i++) html += renderSlot(slots[i], refMs);
    }
    html += "</div>";

    html += '<div id="hcTtFormHost"></div>';

    mountEl.innerHTML = html;
    wire(mountEl);
  }

  function renderAddForm(host) {
    var weeks = plannerWeeks();
    var wkChips = weeks.map(function (w) {
      return '<span class="hc-tt-wk" data-week="' + esc(w.id) + '">' + esc(w.label) + " · " + esc(w.dates) + "</span>";
    }).join("");
    var typeOpts = SCHEDULE_TYPES.map(function (t) {
      return '<option value="' + esc(t) + '">' + esc(t) + "</option>";
    }).join("");
    host.innerHTML =
      '<div class="hc-tt-form">' +
        "<label>Slot title</label>" +
        '<input type="text" id="ttTitle" placeholder="e.g. Multi-Sports Camp — Walthamstow" />' +
        "<label>Venue</label>" +
        '<input type="text" id="ttVenue" placeholder="e.g. Henry Maynard Primary, E17" />' +
        "<label>Schedule type</label>" +
        '<select id="ttType">' + typeOpts + "</select>" +
        "<label>Forthcoming dates (tap the weeks it runs)</label>" +
        '<div class="hc-tt-wkgrid" id="ttWeeks">' + wkChips + "</div>" +
        '<div style="margin-top:12px;display:flex;gap:8px">' +
          '<button class="hc-btn" id="ttSave">Publish slot</button>' +
          '<button class="hc-btn hc-btn-ghost" id="ttCancel">Cancel</button>' +
        "</div>" +
      "</div>";

    var picked = {};
    host.querySelectorAll(".hc-tt-wk").forEach(function (chip) {
      chip.addEventListener("click", function () {
        var id = chip.getAttribute("data-week");
        if (picked[id]) { delete picked[id]; chip.classList.remove("on"); }
        else { picked[id] = true; chip.classList.add("on"); }
      });
    });

    var saveBtn = host.querySelector("#ttSave");
    if (saveBtn) saveBtn.addEventListener("click", function () {
      try {
        var title = (host.querySelector("#ttTitle") || {}).value || "";
        var venue = (host.querySelector("#ttVenue") || {}).value || "";
        var type = (host.querySelector("#ttType") || {}).value || "Weekly camp";
        var sessions = [];
        for (var id in picked) {
          if (!Object.prototype.hasOwnProperty.call(picked, id)) continue;
          var s = sessionForWeekId(id);
          if (s) sessions.push(s);
        }
        addSlot({ title: title, venue: venue, type: type, sessions: sessions });
        HC.util.toast("Slot published to your timetable");
        // re-render the whole feature view
        var mount = host.closest("#hcFeatureMount") || host.parentNode;
        if (mount) renderInto(mount);
      } catch (e) {
        HC.util.toast(e && e.message ? e.message : "Could not add slot");
      }
    });
    var cancelBtn = host.querySelector("#ttCancel");
    if (cancelBtn) cancelBtn.addEventListener("click", function () { host.innerHTML = ""; });
  }

  function wire(mountEl) {
    var addBtn = mountEl.querySelector("[data-tt-add]");
    if (addBtn) addBtn.addEventListener("click", function () {
      var host = mountEl.querySelector("#hcTtFormHost");
      if (host) renderAddForm(host);
    });
    var resetBtn = mountEl.querySelector("[data-tt-reset]");
    if (resetBtn) resetBtn.addEventListener("click", function () {
      resetTimetable();
      HC.util.toast("Timetable reset to live data");
      renderInto(mountEl);
    });
    mountEl.querySelectorAll("[data-tt-remove]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        removeSlot(btn.getAttribute("data-tt-remove"));
        HC.util.toast("Slot removed from your timetable");
        renderInto(mountEl);
      });
    });
  }

  /* ============================================================
   * selfTest — exercises the LOGIC and asserts the acceptance
   * criterion: a timetable view lists each camp slot with its
   * forthcoming dates.
   * ============================================================ */

  function selfTest() {
    var pass = 0, fail = 0, log = [];
    function check(label, fn) {
      try { fn(); pass += 1; log.push("✓ " + label); }
      catch (e) { fail += 1; log.push("✗ " + label + " — " + (e && e.message ? e.message : String(e))); }
    }

    // Work on a clean state so the test is deterministic.
    var saved = null;
    try { saved = HC.store.get(STORE_KEY, null); } catch (e) { saved = null; }
    resetTimetable();

    var REF = "2026-06-15"; // before any summer week — everything is forthcoming
    var refMs = nowMs(REF);

    check("Timetable seeds at least one slot from live planner data", function () {
      var tt = getTimetable();
      HC.assert(Array.isArray(tt), "getTimetable must return an array");
      HC.assert(tt.length >= 1, "expected >=1 seeded slot, got " + tt.length);
    });

    // ACCEPTANCE CRITERION: the view lists each camp slot WITH its
    // forthcoming dates. Assert that every slot that has scheduled
    // weeks exposes at least one forthcoming dated session, and that
    // each session carries a human date range.
    check("Each scheduled slot lists its forthcoming dates", function () {
      var tt = getTimetable();
      var scheduled = tt.filter(function (s) { return s.sessions && s.sessions.length; });
      HC.assert(scheduled.length >= 1, "expected at least one scheduled slot");
      for (var i = 0; i < scheduled.length; i++) {
        var slot = scheduled[i];
        var up = forthcomingSessions(slot, refMs);
        HC.assert(up.length >= 1, slot.title + " should list >=1 forthcoming date");
        for (var j = 0; j < up.length; j++) {
          HC.assert(up[j].dates && /\w/.test(up[j].dates), slot.title + " session must carry a date range");
          HC.assert(up[j].label, slot.title + " session must carry a week label");
        }
      }
    });

    // Verify a KNOWN camp from planner-data maps to its real dates.
    check("A known camp's slot carries its real planner dates", function () {
      var tt = getTimetable();
      var picked = null;
      for (var i = 0; i < tt.length; i++) {
        if (tt[i].campId === "petite-productions") { picked = tt[i]; break; }
      }
      HC.assert(picked, "expected a slot for petite-productions");
      // planner-data: petite-productions runs weeks [2,3,4,5,6]
      var up = forthcomingSessions(picked, refMs);
      HC.assert(up.length === 5, "petite-productions should have 5 forthcoming weeks, got " + up.length);
      // Week 2 is "Mon 27 - Fri 31 July"
      var hasWk2 = up.some(function (s) { return /27/.test(s.dates) && /July/.test(s.dates); });
      HC.assert(hasWk2, "expected the 27-31 July week in the forthcoming dates");
    });

    // Forthcoming filter: past sessions drop off when the reference
    // date moves to mid-August.
    check("Past dates drop out of the forthcoming view", function () {
      var slot = {
        id: "t", title: "Test camp", type: "Weekly camp",
        sessions: [
          { weekId: 1, label: "Week 1", dates: "Mon 20 - Fri 24 July", iso: "2026-07-20", days: 5 },
          { weekId: 6, label: "Week 6", dates: "Mon 24 - Fri 28 August", iso: "2026-08-24", days: 5 }
        ]
      };
      var early = forthcomingSessions(slot, nowMs("2026-06-15"));
      HC.assert(early.length === 2, "before summer both weeks are forthcoming, got " + early.length);
      var mid = forthcomingSessions(slot, nowMs("2026-08-01"));
      HC.assert(mid.length === 1, "after week 1 only week 6 is forthcoming, got " + mid.length);
      HC.assert(mid[0].weekId === 6, "the remaining session should be week 6");
      var afterAll = forthcomingSessions(slot, nowMs("2026-09-10"));
      HC.assert(afterAll.length === 0, "after all weeks nothing is forthcoming, got " + afterAll.length);
    });

    // Forthcoming sessions come back sorted earliest-first.
    check("Forthcoming dates are sorted earliest-first", function () {
      var slot = {
        id: "t2", title: "Sort camp", type: "Weekly camp",
        sessions: [
          { weekId: 4, label: "Week 4", dates: "Mon 10 - Fri 14 August", iso: "2026-08-10", days: 5 },
          { weekId: 1, label: "Week 1", dates: "Mon 20 - Fri 24 July", iso: "2026-07-20", days: 5 },
          { weekId: 3, label: "Week 3", dates: "Mon 3 - Fri 7 August", iso: "2026-08-03", days: 5 }
        ]
      };
      var up = forthcomingSessions(slot, refMs);
      HC.assert(up.length === 3, "expected 3 sessions");
      HC.assert(up[0].weekId === 1 && up[1].weekId === 3 && up[2].weekId === 4,
        "expected order 1,3,4 — got " + up.map(function (s) { return s.weekId; }).join(","));
    });

    // Provider can ADD a slot (wizard end-state) and it appears with
    // its forthcoming dates.
    check("Adding a slot puts it on the timetable with its dates", function () {
      var before = getTimetable().length;
      var slot = addSlot({
        title: "Robotics & Coding Camp",
        venue: "Test Venue E17",
        type: "Course",
        sessions: [sessionForWeekId(2), sessionForWeekId(3)].filter(Boolean)
      });
      HC.assert(slot && slot.id, "addSlot should return the created slot");
      var tt = getTimetable();
      HC.assert(tt.length === before + 1, "timetable should grow by one");
      var found = tt.filter(function (s) { return s.id === slot.id; })[0];
      HC.assert(found, "added slot should be retrievable");
      var up = forthcomingSessions(found, refMs);
      HC.assert(up.length === 2, "added slot should list its 2 forthcoming dates, got " + up.length);
      HC.assert(found.type === "Course", "schedule type should persist as Course");
    });

    // Adding requires a title (validation).
    check("A slot without a title is rejected", function () {
      var threw = false;
      try { addSlot({ title: "   ", sessions: [] }); } catch (e) { threw = true; }
      HC.assert(threw, "addSlot should throw on an empty title");
    });

    // Removing a slot drops it from the timetable and persists.
    check("Removing a slot persists across reads", function () {
      var slot = addSlot({ title: "Temp Camp", type: "Event", sessions: [] });
      HC.assert(getTimetable().some(function (s) { return s.id === slot.id; }), "slot should be present after add");
      removeSlot(slot.id);
      HC.assert(!getTimetable().some(function (s) { return s.id === slot.id; }), "slot should be gone after remove");
    });

    // A seeded (live-data) slot can be suppressed too.
    check("A seeded slot can be removed and stays removed", function () {
      var tt = getTimetable();
      var seed = tt.filter(function (s) { return !s.custom; })[0];
      HC.assert(seed, "expected at least one seeded slot");
      removeSlot(seed.id);
      var after = getTimetable();
      HC.assert(!after.some(function (s) { return s.id === seed.id; }), "seeded slot should stay removed");
    });

    // Unconfirmed slots (no dates) still surface, flagged.
    check("Slots with no dates still appear, flagged unconfirmed", function () {
      var slot = { id: "u", title: "Unconfirmed", type: "Weekly camp", sessions: [] };
      var up = forthcomingSessions(slot, refMs);
      HC.assert(up.length === 0, "no dates means no forthcoming sessions");
      // render path should produce the 'dates to be confirmed' copy
      var html = renderSlot(slot, refMs);
      HC.assert(/dates to be confirmed/i.test(html), "empty slot should show 'dates to be confirmed'");
    });

    // Reset returns to the live seed.
    check("Reset clears custom edits", function () {
      addSlot({ title: "Will be wiped", sessions: [] });
      resetTimetable();
      var tt = getTimetable();
      HC.assert(!tt.some(function (s) { return s.title === "Will be wiped"; }), "reset should drop custom slots");
    });

    // Restore the user's real state.
    try { if (saved === null) HC.store.remove(STORE_KEY); else HC.store.set(STORE_KEY, saved); } catch (e) { /* ignore */ }

    return { pass: pass, fail: fail, log: log };
  }

  /* ============================================================
   * Registration
   * ============================================================ */

  HC.registerFeature({
    id: "provider-weekly-timetable",
    title: "Weekly timetable",
    side: "provider",
    icon: "📅",
    summary: "Your timetable is where all your camp slots live — each one listed with its forthcoming summer-holiday dates. Add, schedule and remove slots like Happity's scheduling wizard.",
    render: function (mountEl) {
      try {
        renderInto(mountEl);
      } catch (e) {
        mountEl.innerHTML = '<p style="color:#9a1f5e">Timetable failed to render: ' +
          esc(e && e.message ? e.message : String(e)) + "</p>";
      }
    },
    selfTest: selfTest
  });
})();
