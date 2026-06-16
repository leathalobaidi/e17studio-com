/* HolidayCamp feature — provider-term-scheduling
 *
 * Term / holiday-period scheduling — start/end + dates  (provider side)
 *
 * Replicates Happity's "Smart Term Tickets" set-up flow (support articles
 * 5837263 + 5837300). Evidence, verbatim from article 5837263:
 *   - "If you run your classes in terms, you can specify a start and end date
 *      for each new term".
 *   - "Start date and end date of term (dates are the Monday for the week, so
 *      that you can change the weekday later if you need to)".
 *   - "Select the individual dates or click 'select all'."   <-- ACCEPTANCE
 *   - "NB. If there is only one date left in the term, then parents will not be
 *      able to buy a term ticket and will need to buy a single ticket instead."
 * Article 5837300 ("Can I set up separate terms on Happity?") confirms a
 * provider can create MULTIPLE separate terms.
 *
 * Framed for SCHOOL-AGE HOLIDAY CAMPS (not baby classes): instead of a weekly
 * "term" of toddler classes, a provider here defines a HOLIDAY PERIOD (e.g.
 * "Summer 2026") with a start and end date, and the system enumerates the
 * candidate camp dates inside that window (by default each weekday Mon–Fri,
 * since camps run across the school holidays). The provider then ticks the
 * individual dates their camp actually runs, or hits "Select all" to take the
 * whole period in one click. A multi-date selection unlocks a "whole-period
 * pass" (the camp equivalent of a term ticket); a single date can only be sold
 * as a day ticket — exactly the Happity NB rule above.
 *
 * ACCEPTANCE CRITERION (asserted in selfTest, multiple cases):
 *   Setting a term lets the provider pick individual dates OR 'select all'
 *   within it. We verify enumerateDates() builds the in-range candidate set,
 *   that toggling individual dates works, that selectAll() selects every date,
 *   and that the whole-period-pass rule (need >1 selected date) holds.
 *
 * Self-contained, defensive, plain browser JS. No imports/exports. Persists
 * only via HC.store. Calls HC.registerFeature at top level.
 */
(function () {
  "use strict";

  // Defensive: never throw at module load if HC isn't present.
  if (typeof window === "undefined" || !window.HC ||
      typeof window.HC.registerFeature !== "function") {
    if (typeof console !== "undefined" && console.warn) {
      console.warn("[HC] provider-term-scheduling: HC core not found; skipping registration.");
    }
    return;
  }

  var HC = window.HC;
  var STORE_KEY = "provider_terms"; // persisted holiday-period terms

  // Schedule patterns. A holiday camp typically runs weekdays; some run a
  // single weekday "term-time-style" club. This mirrors Happity letting the
  // provider pick the weekday, but defaults to the full Mon–Fri camp week.
  // 0=Sun … 6=Sat (JS getUTCDay()).
  var PATTERNS = {
    weekdays: { id: "weekdays", label: "Every weekday (Mon–Fri)", days: [1, 2, 3, 4, 5] },
    mon:      { id: "mon", label: "Mondays only",    days: [1] },
    tue:      { id: "tue", label: "Tuesdays only",   days: [2] },
    wed:      { id: "wed", label: "Wednesdays only", days: [3] },
    thu:      { id: "thu", label: "Thursdays only",  days: [4] },
    fri:      { id: "fri", label: "Fridays only",    days: [5] },
    daily:    { id: "daily", label: "Every day (incl. weekends)", days: [0, 1, 2, 3, 4, 5, 6] }
  };

  var DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  var MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
             "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  /* ===================== pure date helpers (DOM-free) ===================== */

  // Parse an ISO "YYYY-MM-DD" into a UTC Date (no time-zone drift). Returns
  // null on anything that doesn't look like a calendar date.
  function parseISO(iso) {
    if (typeof iso !== "string") return null;
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso.trim());
    if (!m) return null;
    var y = +m[1], mo = +m[2], d = +m[3];
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    var dt = new Date(Date.UTC(y, mo - 1, d));
    // reject overflow (e.g. 2026-02-31 -> Mar 3)
    if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) {
      return null;
    }
    return dt;
  }

  function toISO(dt) {
    if (!(dt instanceof Date) || isNaN(dt.getTime())) return null;
    var y = dt.getUTCFullYear();
    var mo = String(dt.getUTCMonth() + 1).padStart(2, "0");
    var d = String(dt.getUTCDate()).padStart(2, "0");
    return y + "-" + mo + "-" + d;
  }

  function addDays(dt, n) {
    return new Date(dt.getTime() + n * 86400000);
  }

  // Pretty label, e.g. "Mon 20 Jul" (used in the date grid).
  function prettyDate(iso) {
    var dt = parseISO(iso);
    if (!dt) return iso;
    return DOW[dt.getUTCDay()] + " " + dt.getUTCDate() + " " + MON[dt.getUTCMonth()];
  }

  function patternFor(id) {
    return PATTERNS[id] || PATTERNS.weekdays;
  }

  /* ===================== core scheduling logic ===================== */

  // Enumerate every candidate camp date in [startISO, endISO] (inclusive) that
  // falls on a day-of-week in the chosen pattern. This is the "dates within the
  // term" set the provider then ticks. Returns an array of ISO strings.
  //
  // Defensive: bad / reversed / missing dates yield an empty list rather than
  // throwing, and we cap the window so a fat-fingered far-future end date can't
  // spin forever.
  function enumerateDates(startISO, endISO, patternId) {
    var start = parseISO(startISO);
    var end = parseISO(endISO);
    if (!start || !end) return [];
    if (end.getTime() < start.getTime()) return []; // end before start -> nothing
    var allowed = patternFor(patternId).days;
    var out = [];
    var cur = start;
    var guard = 0;
    while (cur.getTime() <= end.getTime()) {
      if (allowed.indexOf(cur.getUTCDay()) !== -1) out.push(toISO(cur));
      cur = addDays(cur, 1);
      guard += 1;
      if (guard > 800) break; // ~2 years of days — a holiday period is never this long
    }
    return out;
  }

  // A Term object is the unit Happity calls a "term"; here a holiday PERIOD.
  //   { id, name, start, end, pattern, candidates:[iso], selected:[iso],
  //     capacity:Number }
  // selected is always a SUBSET of candidates (we enforce that on every op).
  function makeTerm(opts) {
    var o = (opts && typeof opts === "object") ? opts : {};
    var start = parseISO(o.start) ? o.start : null;
    var end = parseISO(o.end) ? o.end : null;
    var pattern = PATTERNS[o.pattern] ? o.pattern : "weekdays";
    var candidates = enumerateDates(start, end, pattern);
    // selected: keep only those that are real candidates; default = none picked.
    var selected = sanitiseSelection(o.selected, candidates);
    return {
      id: o.id || safeUid("term"),
      name: asText(o.name) || "Untitled holiday period",
      start: start,
      end: end,
      pattern: pattern,
      candidates: candidates,
      selected: selected,
      capacity: clampInt(o.capacity, 0, 999, 0) // 0 = "not using bookings" (the article's "just put 0")
    };
  }

  // Keep a selection honest: dedupe, drop anything not in candidates, preserve
  // candidate order.
  function sanitiseSelection(selected, candidates) {
    var set = {};
    if (Array.isArray(selected)) {
      for (var i = 0; i < selected.length; i++) set[selected[i]] = true;
    }
    var out = [];
    for (var j = 0; j < candidates.length; j++) {
      if (set[candidates[j]]) out.push(candidates[j]);
    }
    return out;
  }

  // Toggle a single date in/out of the selection. No-op (returns unchanged
  // selection) if the date isn't a candidate. Returns the new selected array.
  function toggleDate(term, iso) {
    if (!term || term.candidates.indexOf(iso) === -1) {
      return term ? term.selected.slice() : [];
    }
    var has = term.selected.indexOf(iso) !== -1;
    var next;
    if (has) {
      next = term.selected.filter(function (d) { return d !== iso; });
    } else {
      next = term.selected.concat([iso]);
    }
    term.selected = sanitiseSelection(next, term.candidates); // keep order + valid
    return term.selected;
  }

  // "Select all" — the article's one-click action. Picks every candidate date.
  function selectAll(term) {
    if (!term) return [];
    term.selected = term.candidates.slice();
    return term.selected;
  }

  // "Clear" — the natural inverse, handy in the UI.
  function selectNone(term) {
    if (!term) return [];
    term.selected = [];
    return term.selected;
  }

  // Are all candidates selected? (drives the Select-all / Clear toggle label)
  function allSelected(term) {
    return !!term && term.candidates.length > 0 &&
      term.selected.length === term.candidates.length;
  }

  // The Happity NB rule, framed for camps: a WHOLE-PERIOD PASS (term ticket) is
  // only offered when MORE THAN ONE date is selected. With 0–1 dates the
  // provider can only sell single day tickets.
  function ticketPolicy(term) {
    var n = term ? term.selected.length : 0;
    if (n === 0) {
      return {
        wholePeriodPass: false, dayTicketOnly: true, selectedCount: 0,
        note: "No dates selected yet — pick the dates this camp runs, or hit 'Select all'."
      };
    }
    if (n === 1) {
      return {
        wholePeriodPass: false, dayTicketOnly: true, selectedCount: 1,
        note: "Only one date selected, so families can only buy a single day ticket — " +
              "a whole-period pass needs at least two dates."
      };
    }
    return {
      wholePeriodPass: true, dayTicketOnly: false, selectedCount: n,
      note: n + " dates selected — families can buy a whole-period pass (pro-rated) " +
            "or a single day ticket."
    };
  }

  // Validate the start/end pair before a term is created. Mirrors the bits the
  // Happity form enforces: both dates present, end not before start.
  function validateRange(startISO, endISO) {
    var errors = [];
    var start = parseISO(startISO);
    var end = parseISO(endISO);
    if (!start) errors.push("Add a valid start date for the holiday period.");
    if (!end) errors.push("Add a valid end date for the holiday period.");
    if (start && end && end.getTime() < start.getTime()) {
      errors.push("The end date can't be before the start date.");
    }
    return { ok: errors.length === 0, errors: errors };
  }

  /* ===================== misc helpers ===================== */

  function asText(v) { return typeof v === "string" ? v : (v == null ? "" : String(v)); }

  function clampInt(v, lo, hi, def) {
    var n = parseInt(v, 10);
    if (!isFinite(n)) return def;
    if (n < lo) return lo;
    if (n > hi) return hi;
    return n;
  }

  function safeUid(prefix) {
    try { return HC.util.uid(); }
    catch (e) { return (prefix || "id") + "_" + Date.now() + "_" + Math.floor(Math.random() * 1e6); }
  }

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function el(tag, attrs, html) {
    try { return HC.util.el(tag, attrs, html); }
    catch (e) {
      var n = document.createElement(tag || "div");
      if (html != null) n.innerHTML = html;
      return n;
    }
  }

  /* ===================== persistence (HC.store only) ===================== */

  function readTerms() {
    try {
      var s = HC.store.get(STORE_KEY, []);
      return Array.isArray(s) ? s : [];
    } catch (e) { return []; }
  }
  function writeTerms(list) {
    try { return HC.store.set(STORE_KEY, Array.isArray(list) ? list : []); }
    catch (e) { return false; }
  }

  // Persist a term. We store the primitive fields (start/end as ISO, selected
  // ISO list) so a reload re-derives candidates deterministically.
  function saveTerm(term) {
    if (!term) return null;
    var rec = {
      id: term.id,
      name: term.name,
      start: term.start,
      end: term.end,
      pattern: term.pattern,
      selected: term.selected.slice(),
      capacity: term.capacity,
      at: Date.now()
    };
    var list = readTerms().filter(function (t) { return t && t.id !== rec.id; });
    list.unshift(rec);
    if (list.length > 30) list = list.slice(0, 30);
    writeTerms(list);
    return rec;
  }

  // Rehydrate a stored record back into a live term (re-enumerating candidates).
  function hydrate(rec) {
    return makeTerm({
      id: rec && rec.id, name: rec && rec.name,
      start: rec && rec.start, end: rec && rec.end,
      pattern: rec && rec.pattern, selected: rec && rec.selected,
      capacity: rec && rec.capacity
    });
  }

  /* ===================== seed from live planner data ===================== */

  // A sensible default term lifted from the live planner's summer window, so the
  // demo opens on real Waltham Forest 2026 dates rather than placeholders.
  function defaultRange() {
    try {
      var kd = HC.data.planner && HC.data.planner.keyDates;
      var weeks = (HC.data.planner && HC.data.planner.weeks) || [];
      var startISO = kd && kd.holidayStart && kd.holidayStart.iso;
      // end = the Friday of the last full (non-stub) week, else the bank holiday.
      var lastFull = null;
      for (var i = 0; i < weeks.length; i++) {
        if (!weeks[i].stub && weeks[i].mon) lastFull = weeks[i];
      }
      var endISO = null;
      if (lastFull) {
        var mon = parseISO(lastFull.mon);
        if (mon) endISO = toISO(addDays(mon, 4)); // Mon + 4 = Fri
      }
      if (!startISO) startISO = "2026-07-21";
      if (!endISO) endISO = "2026-08-28";
      return { start: startISO, end: endISO };
    } catch (e) {
      return { start: "2026-07-21", end: "2026-08-28" };
    }
  }

  /* ===================== UI ===================== */

  function render(mountEl) {
    try {
      if (!mountEl) return;
      mountEl.innerHTML = "";

      // Working term, seeded from live planner dates.
      var seed = defaultRange();
      var term = makeTerm({
        name: "Summer 2026",
        start: seed.start,
        end: seed.end,
        pattern: "weekdays",
        capacity: 24
      });
      // default to all dates selected (the common "we run the whole holiday" case)
      selectAll(term);

      var intro = el("div", null,
        '<p style="font-size:14px;color:var(--text,#383838);margin:0 0 10px;line-height:1.5">' +
          "Run your camp in <strong>holiday periods (terms)</strong>? Set a " +
          "<strong>start and end date</strong> for the period and HolidayCamp lists every " +
          "camp date inside it. Then <strong>tick the individual dates</strong> your camp runs, or hit " +
          "<strong>‘Select all’</strong> to take the whole period in one click — and families can book ahead " +
          "for the period with a pro-rated whole-period pass.</p>");
      mountEl.appendChild(intro);

      // --- term set-up controls (start / end / pattern / name) ---
      var controls = el("div", {
        style: "display:grid;grid-template-columns:1fr 1fr;gap:10px 14px;" +
               "border:1.5px solid var(--line,#E6E6E6);border-radius:14px;padding:14px;background:#fff;margin:0 0 14px"
      });
      var patOpts = Object.keys(PATTERNS).map(function (k) {
        return '<option value="' + esc(k) + '"' + (k === term.pattern ? " selected" : "") + ">" +
          esc(PATTERNS[k].label) + "</option>";
      }).join("");
      controls.innerHTML =
        '<label style="grid-column:1 / -1;font-size:13px;font-weight:700;color:var(--purple,#603488)">' +
          "Holiday period name<br>" +
          '<input id="tsName" type="text" value="' + esc(term.name) + '" ' +
            'style="width:100%;margin-top:4px;padding:7px 9px;border:1px solid var(--line,#E6E6E6);border-radius:9px;font-size:13.5px"></label>' +
        '<label style="font-size:13px;font-weight:700;color:var(--purple,#603488)">Start date<br>' +
          '<input id="tsStart" type="date" value="' + esc(term.start || "") + '" ' +
            'style="margin-top:4px;padding:6px 8px;border:1px solid var(--line,#E6E6E6);border-radius:9px;font-size:13.5px"></label>' +
        '<label style="font-size:13px;font-weight:700;color:var(--purple,#603488)">End date<br>' +
          '<input id="tsEnd" type="date" value="' + esc(term.end || "") + '" ' +
            'style="margin-top:4px;padding:6px 8px;border:1px solid var(--line,#E6E6E6);border-radius:9px;font-size:13.5px"></label>' +
        '<label style="font-size:13px;font-weight:700;color:var(--purple,#603488)">Camp runs<br>' +
          '<select id="tsPattern" style="margin-top:4px;padding:6px 8px;border:1px solid var(--line,#E6E6E6);border-radius:9px;font-size:13.5px">' +
            patOpts + "</select></label>" +
        '<label style="font-size:13px;font-weight:700;color:var(--purple,#603488)">Places per date<br>' +
          '<input id="tsCap" type="number" min="0" max="999" value="' + esc(String(term.capacity)) + '" ' +
            'style="width:90px;margin-top:4px;padding:6px 8px;border:1px solid var(--line,#E6E6E6);border-radius:9px;font-size:13.5px"></label>';
      mountEl.appendChild(controls);

      // --- select all / clear bar ---
      var bar = el("div", {
        style: "display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:0 0 10px"
      });
      bar.innerHTML =
        '<button class="hc-btn" id="tsSelectAll" type="button">Select all</button>' +
        '<button class="hc-btn hc-btn-ghost" id="tsClear" type="button">Clear</button>' +
        '<span id="tsCount" style="font-size:13px;color:var(--muted,#808080);font-weight:700"></span>';
      mountEl.appendChild(bar);

      // --- date grid (the candidate dates within the term) ---
      var grid = el("div", { id: "tsGrid",
        style: "display:grid;grid-template-columns:repeat(auto-fill,minmax(116px,1fr));gap:8px;margin:0 0 12px" });
      mountEl.appendChild(grid);

      // --- ticket policy / NB note ---
      var policyBox = el("div", { id: "tsPolicy",
        style: "border-radius:12px;padding:11px 13px;font-size:13px;line-height:1.5" });
      mountEl.appendChild(policyBox);

      // --- save + validation ---
      var saveRow = el("div", { style: "margin-top:14px;display:flex;align-items:center;gap:12px;flex-wrap:wrap" });
      saveRow.innerHTML =
        '<button class="hc-btn" id="tsSave" type="button">Save holiday period</button>' +
        '<span id="tsMsg" style="font-size:12.5px;color:var(--magenta,#F82488);font-weight:700"></span>';
      mountEl.appendChild(saveRow);

      /* ---- render helpers bound to this mount ---- */

      function rebuildTermFromControls(keepSelection) {
        var prevSelected = keepSelection ? term.selected.slice() : [];
        term = makeTerm({
          id: term.id,
          name: (mountEl.querySelector("#tsName") || {}).value,
          start: (mountEl.querySelector("#tsStart") || {}).value,
          end: (mountEl.querySelector("#tsEnd") || {}).value,
          pattern: (mountEl.querySelector("#tsPattern") || {}).value,
          capacity: (mountEl.querySelector("#tsCap") || {}).value,
          selected: prevSelected
        });
      }

      function paintGrid() {
        if (!term.candidates.length) {
          grid.innerHTML =
            '<p style="grid-column:1/-1;color:var(--muted,#808080);font-size:13px;margin:0">' +
            "No camp dates fall inside this period yet — check the start/end dates and the days the camp runs.</p>";
          return;
        }
        var cells = "";
        for (var i = 0; i < term.candidates.length; i++) {
          var iso = term.candidates[i];
          var on = term.selected.indexOf(iso) !== -1;
          cells +=
            '<button type="button" class="ts-cell" data-iso="' + esc(iso) + '" ' +
              'aria-pressed="' + (on ? "true" : "false") + '" ' +
              'style="text-align:left;cursor:pointer;border-radius:10px;padding:8px 10px;font-size:12.5px;' +
                "font-family:Quicksand,system-ui,sans-serif;font-weight:700;border:1.5px solid " +
                (on ? "var(--purple,#603488)" : "var(--line,#E6E6E6)") + ";" +
                "background:" + (on ? "var(--purple-tint,#F0E8F4)" : "#fff") + ";" +
                "color:" + (on ? "var(--purple,#603488)" : "var(--text,#383838)") + '">' +
              (on ? "☑ " : "☐ ") + esc(prettyDate(iso)) +
            "</button>";
        }
        grid.innerHTML = cells;
      }

      function paintPolicy() {
        var pol = ticketPolicy(term);
        var bg = pol.wholePeriodPass ? "#E1F0E4" : "#FFF4D6";
        var fg = pol.wholePeriodPass ? "#2f7d4f" : "#8a6d00";
        policyBox.setAttribute("style",
          "border-radius:12px;padding:11px 13px;font-size:13px;line-height:1.5;background:" +
          bg + ";color:" + fg);
        policyBox.innerHTML =
          '<strong>' + (pol.wholePeriodPass ? "✓ Whole-period pass available" : "Single day tickets only") +
          "</strong><br>" + esc(pol.note);
      }

      function paintCount() {
        var c = mountEl.querySelector("#tsCount");
        if (c) {
          c.textContent = term.selected.length + " of " + term.candidates.length + " dates selected";
        }
        var sa = mountEl.querySelector("#tsSelectAll");
        if (sa) sa.textContent = allSelected(term) ? "All selected" : "Select all";
      }

      function repaint() { paintGrid(); paintPolicy(); paintCount(); }

      // Date toggling (delegated on the grid).
      grid.addEventListener("click", function (e) {
        var cell = e.target.closest ? e.target.closest(".ts-cell") : null;
        if (!cell) return;
        toggleDate(term, cell.getAttribute("data-iso"));
        repaint();
      });

      // Controls -> rebuild candidates, keep what's still valid.
      ["#tsStart", "#tsEnd", "#tsPattern", "#tsCap", "#tsName"].forEach(function (sel) {
        var n = mountEl.querySelector(sel);
        if (n) n.addEventListener("change", function () {
          rebuildTermFromControls(true);
          repaint();
        });
      });

      var saBtn = mountEl.querySelector("#tsSelectAll");
      if (saBtn) saBtn.addEventListener("click", function () { selectAll(term); repaint(); });
      var clBtn = mountEl.querySelector("#tsClear");
      if (clBtn) clBtn.addEventListener("click", function () { selectNone(term); repaint(); });

      var saveBtn = mountEl.querySelector("#tsSave");
      if (saveBtn) saveBtn.addEventListener("click", function () {
        rebuildTermFromControls(true);
        var msg = mountEl.querySelector("#tsMsg");
        var v = validateRange(term.start, term.end);
        if (!v.ok) {
          if (msg) { msg.style.color = "var(--magenta,#F82488)"; msg.textContent = v.errors[0]; }
          repaint();
          return;
        }
        saveTerm(term);
        if (msg) {
          msg.style.color = "#2f7d4f";
          msg.textContent = "Saved “" + term.name + "” — " + term.selected.length + " camp date(s).";
        }
        try { HC.util.toast("Holiday period saved"); } catch (e2) {}
      });

      repaint();
    } catch (e) {
      try {
        mountEl.innerHTML = '<p style="color:#9a1f5e">Term scheduling failed to render: ' +
          esc(e && e.message ? e.message : String(e)) + "</p>";
      } catch (e2) { /* give up quietly */ }
    }
  }

  /* ===================== selfTest ===================== */

  function selfTest() {
    var pass = 0, fail = 0, log = [];
    function check(label, fn) {
      try { fn(); pass += 1; log.push("✓ " + label); }
      catch (e) { fail += 1; log.push("✗ " + label + " — " + (e && e.message ? e.message : String(e))); }
    }

    /* ---- date plumbing ---- */

    check("parseISO/toISO round-trips a UTC date without drift", function () {
      HC.assert(toISO(parseISO("2026-07-20")) === "2026-07-20", "round-trip failed");
      HC.assert(parseISO("2026-13-01") === null, "month 13 should be rejected");
      HC.assert(parseISO("2026-02-30") === null, "Feb 30 should be rejected");
      HC.assert(parseISO("not-a-date") === null, "garbage should be rejected");
    });

    check("enumerateDates lists the weekdays inside a one-week window", function () {
      // Mon 20 Jul 2026 → Fri 24 Jul 2026, weekdays pattern = 5 dates.
      var dates = enumerateDates("2026-07-20", "2026-07-24", "weekdays");
      HC.assert(dates.length === 5, "expected 5 weekday dates, got " + dates.length);
      HC.assert(dates[0] === "2026-07-20", "first date should be Mon 20 Jul");
      HC.assert(dates[4] === "2026-07-24", "last date should be Fri 24 Jul");
    });

    check("enumerateDates respects a single-weekday pattern", function () {
      // Whole of Aug 2026, Mondays only → 31 Aug,24,17,10,3 = 5 Mondays.
      var mondays = enumerateDates("2026-08-01", "2026-08-31", "mon");
      HC.assert(mondays.length === 5, "expected 5 Mondays in Aug 2026, got " + mondays.length);
      // every returned date must be a Monday
      for (var i = 0; i < mondays.length; i++) {
        HC.assert(parseISO(mondays[i]).getUTCDay() === 1, mondays[i] + " is not a Monday");
      }
    });

    check("enumerateDates is defensive: bad / reversed ranges give []", function () {
      HC.assert(enumerateDates("2026-07-24", "2026-07-20", "weekdays").length === 0,
        "end-before-start must yield no dates");
      HC.assert(enumerateDates(null, "2026-07-24", "weekdays").length === 0, "null start -> []");
      HC.assert(enumerateDates("bad", "also-bad", "weekdays").length === 0, "garbage -> []");
    });

    /* ===== ACCEPTANCE CRITERION =====
       "Setting a term lets the provider pick individual dates or 'select all'." */

    check("ACCEPTANCE: setting a term builds the candidate dates within it", function () {
      var term = makeTerm({ name: "Summer", start: "2026-07-20", end: "2026-07-31", pattern: "weekdays" });
      // Mon 20–Fri 31 Jul 2026 weekdays = 10 dates (two full weeks).
      HC.assert(term.candidates.length === 10,
        "expected 10 candidate dates in the term, got " + term.candidates.length);
      // a fresh term starts with NOTHING auto-selected — the provider chooses.
      HC.assert(term.selected.length === 0, "a new term should start with no dates picked");
    });

    check("ACCEPTANCE: provider can pick INDIVIDUAL dates within the term", function () {
      var term = makeTerm({ start: "2026-07-20", end: "2026-07-31", pattern: "weekdays" });
      toggleDate(term, "2026-07-20");
      toggleDate(term, "2026-07-22");
      HC.assert(term.selected.length === 2, "two individual dates should be selected");
      HC.assert(term.selected.indexOf("2026-07-20") !== -1, "Mon 20 should be selected");
      HC.assert(term.selected.indexOf("2026-07-22") !== -1, "Wed 22 should be selected");
      // selection preserves candidate ORDER, not click order
      HC.assert(term.selected[0] === "2026-07-20" && term.selected[1] === "2026-07-22",
        "selection should be in calendar order");
      // toggling Mon 20 off removes just that date
      toggleDate(term, "2026-07-20");
      HC.assert(term.selected.length === 1 && term.selected[0] === "2026-07-22",
        "toggling a date off should remove only that date");
    });

    check("ACCEPTANCE: 'select all' picks EVERY date in the term", function () {
      var term = makeTerm({ start: "2026-07-20", end: "2026-07-31", pattern: "weekdays" });
      selectAll(term);
      HC.assert(term.selected.length === term.candidates.length,
        "select all should select every candidate (" + term.selected.length + "/" + term.candidates.length + ")");
      HC.assert(allSelected(term) === true, "allSelected() should report true after select all");
      // and the inverse clears them
      selectNone(term);
      HC.assert(term.selected.length === 0, "clear should deselect everything");
      HC.assert(allSelected(term) === false, "allSelected() should be false after clear");
    });

    check("ACCEPTANCE: toggling a non-candidate date is ignored (can't pick outside the term)", function () {
      var term = makeTerm({ start: "2026-07-20", end: "2026-07-24", pattern: "weekdays" });
      toggleDate(term, "2026-12-25"); // outside the term window entirely
      HC.assert(term.selected.length === 0, "a date outside the term must not be selectable");
    });

    /* ===== Happity NB rule: whole-period pass needs > 1 date ===== */

    check("Whole-period pass requires MORE THAN ONE selected date", function () {
      var term = makeTerm({ start: "2026-07-20", end: "2026-07-31", pattern: "weekdays" });
      // 0 selected -> day ticket only
      HC.assert(ticketPolicy(term).wholePeriodPass === false, "0 dates -> no whole-period pass");
      // 1 selected -> still day ticket only (the article's NB)
      toggleDate(term, "2026-07-20");
      var p1 = ticketPolicy(term);
      HC.assert(p1.wholePeriodPass === false, "1 date -> no whole-period pass");
      HC.assert(p1.dayTicketOnly === true, "1 date -> day ticket only");
      // 2 selected -> pass unlocks
      toggleDate(term, "2026-07-21");
      var p2 = ticketPolicy(term);
      HC.assert(p2.wholePeriodPass === true, "2 dates -> whole-period pass available");
      HC.assert(p2.selectedCount === 2, "policy should report the selected count");
    });

    check("Select-all on a multi-date term unlocks the whole-period pass", function () {
      var term = makeTerm({ start: "2026-07-20", end: "2026-08-28", pattern: "weekdays" });
      HC.assert(term.candidates.length > 1, "this window should have many candidate dates");
      selectAll(term);
      HC.assert(ticketPolicy(term).wholePeriodPass === true,
        "selecting all dates of a multi-date period should offer a whole-period pass");
    });

    /* ===== multiple separate terms (article 5837300) ===== */

    check("Provider can create MULTIPLE separate holiday periods", function () {
      var summer = makeTerm({ name: "Summer 2026", start: "2026-07-20", end: "2026-08-28", pattern: "weekdays" });
      var october = makeTerm({ name: "October half-term 2026", start: "2026-10-26", end: "2026-10-30", pattern: "weekdays" });
      HC.assert(summer.id !== october.id, "separate terms must have distinct ids");
      HC.assert(october.candidates.length === 5, "Oct half-term Mon–Fri should be 5 dates, got " + october.candidates.length);
      HC.assert(summer.candidates.length > october.candidates.length,
        "summer should span more dates than a half-term");
    });

    /* ===== validation ===== */

    check("validateRange rejects missing and reversed dates", function () {
      HC.assert(validateRange("2026-07-20", "2026-07-24").ok === true, "valid range should pass");
      HC.assert(validateRange("", "2026-07-24").ok === false, "missing start should fail");
      HC.assert(validateRange("2026-07-24", "2026-07-20").ok === false, "end-before-start should fail");
      var v = validateRange("2026-07-24", "2026-07-20");
      HC.assert(v.errors.length >= 1 && /before/i.test(v.errors.join(" ")),
        "reversed range error should mention 'before'");
    });

    /* ===== selection stays a subset of candidates after a range change ===== */

    check("Changing the range drops now-invalid selected dates (subset invariant)", function () {
      // Start wide, select two dates, then shrink the window so one falls out.
      var wide = makeTerm({ start: "2026-07-20", end: "2026-07-31", pattern: "weekdays", selected: ["2026-07-20", "2026-07-31"] });
      HC.assert(wide.selected.length === 2, "both seeded dates should be valid in the wide window");
      var narrow = makeTerm({ start: "2026-07-20", end: "2026-07-24", pattern: "weekdays", selected: wide.selected });
      HC.assert(narrow.selected.indexOf("2026-07-31") === -1, "Fri 31 must drop out of the narrowed window");
      HC.assert(narrow.selected.indexOf("2026-07-20") !== -1, "Mon 20 should survive the narrowing");
      HC.assert(narrow.selected.length === 1, "exactly one seeded date should remain");
    });

    /* ===== persistence via HC.store (never raw localStorage) ===== */

    check("saveTerm persists a holiday period and hydrate() re-derives it", function () {
      var before = readTerms().length;
      var term = makeTerm({ name: "QA Summer", start: "2026-07-20", end: "2026-07-24", pattern: "weekdays" });
      selectAll(term);
      var rec = saveTerm(term);
      HC.assert(rec && rec.name === "QA Summer", "saved record should carry the name");
      var after = readTerms();
      HC.assert(after.length === before + 1, "term should be persisted (len " + after.length + ")");
      HC.assert(after[0].id === term.id, "most recent term should be first");
      // hydrate re-enumerates candidates and restores the selection
      var live = hydrate(after[0]);
      HC.assert(live.candidates.length === 5, "hydrated term should re-derive 5 candidate dates");
      HC.assert(live.selected.length === 5, "hydrated term should restore the saved selection");
      // saving the same id again should UPDATE not duplicate
      selectNone(live);
      saveTerm(live);
      var after2 = readTerms();
      HC.assert(after2.length === after.length, "re-saving same id must not duplicate");
      HC.assert(after2[0].selected.length === 0, "re-save should overwrite the selection");
      // clean up so repeated runs stay stable
      writeTerms(after2.filter(function (t) { return t.id !== term.id; }));
    });

    /* ===== live planner seed ===== */

    check("defaultRange() seeds from live planner data and yields a usable term", function () {
      var seed = defaultRange();
      HC.assert(parseISO(seed.start) && parseISO(seed.end), "seed dates should be valid ISO dates");
      var term = makeTerm({ start: seed.start, end: seed.end, pattern: "weekdays" });
      HC.assert(term.candidates.length > 1, "seeded summer window should have multiple camp dates");
      selectAll(term);
      HC.assert(ticketPolicy(term).wholePeriodPass === true,
        "the seeded summer period should support a whole-period pass when fully selected");
    });

    /* ===== defensive: garbage never throws ===== */

    check("makeTerm tolerates garbage input without throwing", function () {
      var bad = [null, undefined, {}, 42, "", [], { start: "??", end: "??" }];
      for (var i = 0; i < bad.length; i++) {
        var t = makeTerm(bad[i]);
        HC.assert(t && Array.isArray(t.candidates), "must return a term with a candidates array for input #" + i);
        HC.assert(t.selected.length === 0, "garbage term should have no selected dates (#" + i + ")");
        HC.assert(ticketPolicy(t).wholePeriodPass === false, "garbage term offers no whole-period pass (#" + i + ")");
      }
    });

    return { pass: pass, fail: fail, log: log };
  }

  /* ===================== register ===================== */

  HC.registerFeature({
    id: "provider-term-scheduling",
    title: "Term / holiday-period scheduling",
    side: "provider",
    icon: "🗓️",
    summary: "Set a holiday period with a start and end date, then pick the individual camp dates inside it — or hit ‘Select all’. Multi-date periods unlock a pro-rated whole-period pass (single dates sell as day tickets).",
    render: render,
    selfTest: selfTest
  });
})();
