/* HolidayCamp feature — provider-dated-events
 *
 * Dated one-off events (vs recurring)  (provider side)
 *
 * Replicates the Happity distinction between a RECURRING timetable slot and a
 * specific DATED one-off event. Evidence:
 *   - 02-ia-ux T7.
 *   - support article 6020405 ("Can I add single tickets to individual
 *     events?"): Happity lets a provider attach things to "individual dates
 *     and events" via "Selected events" (vs "Any event") "without having to set
 *     up a new event" — i.e. specific dated instances are first-class.
 *   - support article 2295666 ("Setting dates and managing your registers"):
 *     "Happity is designed to support classes that take place weekly (e.g.
 *     Mondays at 10am)" — that is the RECURRING slot. "Adding specific dates …
 *     is optional" and each added date "will create a new blank register for
 *     the session" — that is a DATED instance.
 *
 * Framed for SCHOOL-AGE HOLIDAY CAMPS (not baby classes). A provider models
 * their offer as:
 *   - RECURRING slots: a weekday-pattern camp that repeats across the summer
 *     weeks (e.g. "Multi-Activity Camp — Mon–Fri, 09:00–16:00, weeks 1–6").
 *   - DATED one-off events: a single specific date that stands APART from any
 *     recurring slot (e.g. "INSET-Day Coding Special — Fri 4 Sep 2026, 10:00",
 *     or a one-off "Halloween Forest Adventure — Sat 31 Oct"). It does not
 *     repeat and is not part of the weekly series.
 *
 * ACCEPTANCE CRITERION (asserted in selfTest):
 *   A provider can add a specific DATED camp instance separate from a RECURRING
 *   slot. We verify: a dated one-off event is created with kind 'dated', is NOT
 *   attached to any recurring slot, carries a single concrete ISO date, and is
 *   stored/queryable independently of recurring slots.
 *
 * Self-contained, defensive, no imports/exports. Calls HC.registerFeature.
 */
(function () {
  "use strict";

  // Defensive: never throw at module load if HC isn't present.
  if (typeof window === "undefined" || !window.HC || typeof window.HC.registerFeature !== "function") {
    if (typeof console !== "undefined" && console.warn) {
      console.warn("[HC] provider-dated-events: HC core not found; skipping registration.");
    }
    return;
  }

  var HC = window.HC;

  var STORE_KEY = "provider_dated_events"; // persisted events keyed by providerId

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

  // Human-friendly date label, e.g. "Fri 4 Sep 2026". Defensive: falls back to
  // the raw ISO string if anything goes wrong.
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

  // Two event KINDS. This is the whole point of the feature: a provider's
  // offer is either a RECURRING weekly slot or a DATED one-off event.
  var KIND_RECURRING = "recurring";
  var KIND_DATED = "dated";

  var VALID_WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

  // Build a RECURRING slot (a weekday-pattern camp that repeats across weeks).
  //   input: { title, weekdays:[...], start, end, weeks:[...] }
  function makeRecurringSlot(input) {
    var a = (input && typeof input === "object") ? input : {};
    var weekdays = Array.isArray(a.weekdays)
      ? a.weekdays.filter(function (d) { return VALID_WEEKDAYS.indexOf(d) !== -1; })
      : [];
    var weeks = Array.isArray(a.weeks)
      ? a.weeks.map(Number).filter(function (n) { return isFinite(n); })
      : [];
    return {
      id: safeUid("rec"),
      kind: KIND_RECURRING,
      title: asText(a.title) || "Recurring camp slot",
      weekdays: weekdays,
      weeks: weeks,
      start: asText(a.start) || "09:00",
      end: asText(a.end) || "16:00",
      createdAt: Date.now()
    };
  }

  // VALIDATE the inputs for a DATED one-off event BEFORE creating it. Returns
  // { ok:Boolean, errors:[String] }. Pure — no side effects.
  function validateDatedInput(input) {
    var a = (input && typeof input === "object") ? input : {};
    var errors = [];
    if (!asText(a.title).trim()) errors.push("A title is required.");
    if (!isValidISODate(a.date)) {
      errors.push("A valid specific date (YYYY-MM-DD) is required for a one-off event.");
    }
    // capacity, if supplied, must be a positive integer
    if (a.capacity !== undefined && a.capacity !== null && a.capacity !== "") {
      var cap = Number(a.capacity);
      if (!isFinite(cap) || cap <= 0 || Math.floor(cap) !== cap) {
        errors.push("Capacity must be a whole number greater than zero.");
      }
    }
    // price, if supplied, must be a non-negative number
    if (a.price !== undefined && a.price !== null && a.price !== "") {
      var pr = Number(a.price);
      if (!isFinite(pr) || pr < 0) errors.push("Price must be £0 or more.");
    }
    return { ok: errors.length === 0, errors: errors };
  }

  // Create a DATED one-off event object. This is the acceptance-criterion core:
  // a specific dated instance that is SEPARATE from any recurring slot. By
  // construction it carries kind='dated', a single concrete ISO date, and is
  // NOT linked to a recurring slot (recurringId stays null).
  //
  // Returns { ok, event?, errors? }.
  function makeDatedEvent(input) {
    var v = validateDatedInput(input);
    if (!v.ok) return { ok: false, errors: v.errors };
    var a = input;
    var event = {
      id: safeUid("evt"),
      kind: KIND_DATED,            // <-- one-off, NOT recurring
      recurringId: null,           // <-- explicitly NOT attached to a slot
      title: asText(a.title).trim(),
      date: asText(a.date),        // single concrete ISO date
      dateLabel: dateLabel(a.date),
      start: asText(a.start) || "10:00",
      end: asText(a.end) || "15:00",
      venue: asText(a.venue) || "",
      capacity: toPosIntOrNull(a.capacity),
      price: toMoneyOrNull(a.price),
      note: asText(a.note) || "",
      // A one-off event still gets its own blank register (article 2295666:
      // "it will create a new blank register for the session").
      register: [],
      createdAt: Date.now()
    };
    return { ok: true, event: event };
  }

  function toPosIntOrNull(v) {
    if (v === undefined || v === null || v === "") return null;
    var n = Number(v);
    if (!isFinite(n) || n <= 0) return null;
    return Math.floor(n);
  }
  function toMoneyOrNull(v) {
    if (v === undefined || v === null || v === "") return null;
    var n = Number(v);
    if (!isFinite(n) || n < 0) return null;
    return n;
  }

  // Predicates used across UI + tests so the dated/recurring split is explicit.
  function isDated(ev) { return !!ev && ev.kind === KIND_DATED && ev.recurringId == null; }
  function isRecurring(ev) { return !!ev && ev.kind === KIND_RECURRING; }

  function safeUid(prefix) {
    try { return HC.util.uid(); }
    catch (e) { return (prefix || "id") + "_" + Date.now() + "_" + Math.floor(Math.random() * 1e6); }
  }

  /* ===================================================================
     PERSISTENCE (HC.store only — never raw localStorage)

     Shape: { <providerId>: { recurring:[...slots], dated:[...events] } }
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
      map[pid] = { recurring: [], dated: [] };
    }
    if (!Array.isArray(map[pid].recurring)) map[pid].recurring = [];
    if (!Array.isArray(map[pid].dated)) map[pid].dated = [];
    return map[pid];
  }

  // Persist a recurring slot for a provider. Returns the saved slot.
  function addRecurringSlot(providerId, input) {
    var map = readAll();
    var bucket = providerBucket(map, providerId);
    var slot = makeRecurringSlot(input);
    bucket.recurring.push(slot);
    writeAll(map);
    return slot;
  }

  // Persist a DATED one-off event for a provider, SEPARATE from recurring slots.
  // Returns { ok, event?, errors? }.
  function addDatedEvent(providerId, input) {
    var res = makeDatedEvent(input);
    if (!res.ok) return res;
    var map = readAll();
    var bucket = providerBucket(map, providerId);
    // Guard: a dated event must never carry a recurringId — keep them separate.
    res.event.recurringId = null;
    bucket.dated.push(res.event);
    // keep the mock store small
    if (bucket.dated.length > 100) bucket.dated = bucket.dated.slice(-100);
    writeAll(map);
    return res;
  }

  function getRecurring(providerId) {
    var map = readAll();
    return providerBucket(map, providerId).recurring.slice();
  }
  function getDated(providerId) {
    var map = readAll();
    var list = providerBucket(map, providerId).dated.slice();
    // sort by date ascending for a sensible display order
    list.sort(function (a, b) {
      return asText(a.date) < asText(b.date) ? -1 : asText(a.date) > asText(b.date) ? 1 : 0;
    });
    return list;
  }

  function removeDated(providerId, eventId) {
    var map = readAll();
    var bucket = providerBucket(map, providerId);
    var before = bucket.dated.length;
    bucket.dated = bucket.dated.filter(function (e) { return e.id !== eventId; });
    writeAll(map);
    return bucket.dated.length < before;
  }

  // Reset a provider's bucket (used to keep self-test runs deterministic).
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

  function money(n) {
    if (n == null) return "Free / TBC";
    try { return HC.util.money(n); } catch (e) { return "£" + n; }
  }

  // Pick a sensible demo provider + a sensible default date from live data.
  function demoProviderId() {
    try {
      var ps = HC.data.providers;
      if (ps && ps.length && ps[0] && ps[0].id) return ps[0].id;
    } catch (e) {}
    return "_demo_provider";
  }
  function demoDefaultDate() {
    // Use a key date from the live planner if we can — the INSET / back-to-school
    // day is a perfect one-off-event candidate.
    try {
      var kd = HC.data.planner.keyDates || {};
      if (kd.backToSchool && isValidISODate(kd.backToSchool.iso)) return kd.backToSchool.iso;
      if (kd.holidayStart && isValidISODate(kd.holidayStart.iso)) return kd.holidayStart.iso;
    } catch (e) {}
    return "2026-09-04";
  }

  function recurringSummary(slot) {
    var days = (slot.weekdays && slot.weekdays.length) ? slot.weekdays.join(", ") : "—";
    var wks = (slot.weeks && slot.weeks.length) ? ("weeks " + slot.weeks.join(", ")) : "weeks TBC";
    return esc(days) + " · " + esc(slot.start + "–" + slot.end) + " · " + esc(wks);
  }

  function listsHtml(providerId) {
    var rec = getRecurring(providerId);
    var dated = getDated(providerId);

    var recRows = rec.length
      ? rec.map(function (s) {
          return '<li style="margin:0 0 7px"><strong>' + esc(s.title) + "</strong>" +
            '<div style="font-size:12.5px;color:var(--muted,#808080)">🔁 Recurring · ' +
            recurringSummary(s) + "</div></li>";
        }).join("")
      : '<li style="color:var(--muted,#808080);list-style:none;margin-left:-20px">No recurring slots yet.</li>';

    var datedRows = dated.length
      ? dated.map(function (e) {
          return '<li style="margin:0 0 7px" data-evt="' + escAttr(e.id) + '">' +
            '<strong>' + esc(e.title) + "</strong>" +
            '<div style="font-size:12.5px;color:var(--muted,#808080)">📌 One-off · ' +
              esc(e.dateLabel) + " · " + esc(e.start + "–" + e.end) +
              (e.venue ? " · " + esc(e.venue) : "") +
              " · " + esc(money(e.price)) +
              (e.capacity ? " · " + esc(e.capacity) + " places" : "") +
            "</div>" +
            '<button class="hc-btn hc-btn-ghost" type="button" data-del="' + escAttr(e.id) +
              '" style="margin-top:4px;padding:3px 9px;font-size:11px">Remove</button>' +
          "</li>";
        }).join("")
      : '<li style="color:var(--muted,#808080);list-style:none;margin-left:-20px">No one-off dated events yet.</li>';

    return '' +
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-top:14px">' +
        '<div style="border:1.5px solid var(--line,#E6E6E6);border-radius:14px;padding:12px 14px;background:#F7F4FB">' +
          '<div style="font-family:Quicksand,system-ui,sans-serif;font-weight:700;color:var(--purple,#603488)">🔁 Recurring slots</div>' +
          '<ul style="margin:8px 0 0;padding-left:20px;font-size:13.5px;color:var(--text,#383838)">' + recRows + "</ul>" +
        "</div>" +
        '<div style="border:1.5px solid #F4D9C0;border-radius:14px;padding:12px 14px;background:#FFF9F2">' +
          '<div style="font-family:Quicksand,system-ui,sans-serif;font-weight:700;color:#9a5a1f">📌 One-off dated events</div>' +
          '<ul style="margin:8px 0 0;padding-left:20px;font-size:13.5px;color:var(--text,#383838)" id="hcDatedList">' + datedRows + "</ul>" +
        "</div>" +
      "</div>";
  }

  function render(mountEl) {
    try {
      if (!mountEl) return;
      var providerId = demoProviderId();
      mountEl.innerHTML = "";

      var intro = el("div", null,
        '<p style="font-size:14px;color:var(--text,#383838);margin:0 0 4px">' +
          "Holiday camps usually run as a <strong>recurring weekly slot</strong> (e.g. " +
          "Mon–Fri, 09:00–16:00 across the summer weeks). But sometimes you want a " +
          "<strong>one-off dated event</strong> that stands on its own — an INSET-day " +
          "special, a bank-holiday adventure day, or a single open day — " +
          "<em>separate</em> from the recurring camp.</p>" +
        '<p style="font-size:12.5px;color:var(--muted,#808080);margin:0 0 6px">' +
          "Add a specific dated camp instance below; it is stored apart from your " +
          "recurring slots and gets its own register.</p>");
      mountEl.appendChild(intro);

      // Seed one recurring slot for context if the provider has none yet.
      if (!getRecurring(providerId).length) {
        addRecurringSlot(providerId, {
          title: "Multi-Activity Summer Camp",
          weekdays: ["Mon", "Tue", "Wed", "Thu", "Fri"],
          start: "09:00", end: "16:00",
          weeks: [1, 2, 3, 4, 5, 6]
        });
      }

      // The add-a-one-off-event form.
      var form = el("div", {
        style: "border-top:1px solid var(--line,#E6E6E6);margin-top:14px;padding-top:14px"
      });
      form.innerHTML =
        '<div style="font-family:Quicksand,system-ui,sans-serif;font-weight:700;color:var(--purple,#603488);margin-bottom:8px">' +
          "Add a one-off dated event</div>" +
        '<label style="display:block;font-size:13px;margin:0 0 8px">Event title<br>' +
          '<input id="deTitle" type="text" value="INSET-Day Coding Special" ' +
            'style="width:100%;padding:6px 8px;border:1.5px solid var(--line,#E6E6E6);border-radius:8px"></label>' +
        '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">' +
          '<label style="display:block;font-size:13px;margin:0 0 8px">Specific date<br>' +
            '<input id="deDate" type="date" value="' + escAttr(demoDefaultDate()) + '" ' +
              'style="width:100%;padding:6px 8px;border:1.5px solid var(--line,#E6E6E6);border-radius:8px"></label>' +
          '<label style="display:block;font-size:13px;margin:0 0 8px">Venue<br>' +
            '<input id="deVenue" type="text" value="Walthamstow venue" ' +
              'style="width:100%;padding:6px 8px;border:1.5px solid var(--line,#E6E6E6);border-radius:8px"></label>' +
        "</div>" +
        '<div style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:10px">' +
          '<label style="display:block;font-size:13px;margin:0 0 8px">Start<br>' +
            '<input id="deStart" type="time" value="10:00" style="width:100%;padding:6px 8px;border:1.5px solid var(--line,#E6E6E6);border-radius:8px"></label>' +
          '<label style="display:block;font-size:13px;margin:0 0 8px">End<br>' +
            '<input id="deEnd" type="time" value="15:00" style="width:100%;padding:6px 8px;border:1.5px solid var(--line,#E6E6E6);border-radius:8px"></label>' +
          '<label style="display:block;font-size:13px;margin:0 0 8px">Price £<br>' +
            '<input id="dePrice" type="number" min="0" step="1" value="35" style="width:100%;padding:6px 8px;border:1.5px solid var(--line,#E6E6E6);border-radius:8px"></label>' +
          '<label style="display:block;font-size:13px;margin:0 0 8px">Places<br>' +
            '<input id="deCap" type="number" min="1" step="1" value="20" style="width:100%;padding:6px 8px;border:1.5px solid var(--line,#E6E6E6);border-radius:8px"></label>' +
        "</div>" +
        '<button class="hc-btn" id="deAdd" type="button">+ Add one-off event</button>' +
        '<div id="deErr" style="margin-top:8px;color:#9a1f5e;font-size:12.5px"></div>';
      mountEl.appendChild(form);

      var listsHost = el("div", { id: "hcListsHost" }, listsHtml(providerId));
      mountEl.appendChild(listsHost);

      function refresh() { listsHost.innerHTML = listsHtml(providerId); }

      function val(id) { var n = form.querySelector("#" + id); return n ? n.value : ""; }

      function onAdd() {
        var errHost = form.querySelector("#deErr");
        if (errHost) errHost.textContent = "";
        var res = addDatedEvent(providerId, {
          title: val("deTitle"),
          date: val("deDate"),
          start: val("deStart"),
          end: val("deEnd"),
          venue: val("deVenue"),
          price: val("dePrice"),
          capacity: val("deCap")
        });
        if (!res.ok) {
          if (errHost) errHost.textContent = res.errors.join(" ");
          return;
        }
        refresh();
        try { HC.util.toast("One-off event added: " + res.event.title + " (" + res.event.dateLabel + ")"); } catch (e) {}
      }

      var addBtn = form.querySelector("#deAdd");
      if (addBtn) addBtn.addEventListener("click", onAdd);

      // Delegated remove inside this mount only.
      listsHost.addEventListener("click", function (e) {
        var btn = e.target && e.target.closest ? e.target.closest("[data-del]") : null;
        if (!btn) return;
        removeDated(providerId, btn.getAttribute("data-del"));
        refresh();
        try { HC.util.toast("One-off event removed"); } catch (er) {}
      });
    } catch (e) {
      try {
        mountEl.innerHTML = '<p style="color:#9a1f5e">Dated-events feature failed to render: ' +
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

    var TP = "__selftest_provider__";
    clearProvider(TP); // deterministic starting point

    // ===== ACCEPTANCE CRITERION =====
    // A provider can add a specific DATED camp instance SEPARATE from a
    // RECURRING slot.

    check("Provider adds a recurring slot (the baseline weekly camp)", function () {
      var slot = addRecurringSlot(TP, {
        title: "Multi-Activity Summer Camp",
        weekdays: ["Mon", "Tue", "Wed", "Thu", "Fri"],
        start: "09:00", end: "16:00", weeks: [1, 2, 3, 4, 5, 6]
      });
      HC.assert(isRecurring(slot), "slot must be kind 'recurring'");
      HC.assert(slot.weekdays.length === 5, "recurring slot should keep its 5 weekdays");
      HC.assert(getRecurring(TP).length === 1, "one recurring slot should be persisted");
    });

    check("Provider adds a specific DATED one-off event", function () {
      var res = addDatedEvent(TP, {
        title: "INSET-Day Coding Special",
        date: "2026-09-04",
        start: "10:00", end: "15:00",
        venue: "Walthamstow", price: 35, capacity: 20
      });
      HC.assert(res.ok === true, "dated event should be created: " + (res.errors || []).join(" "));
      HC.assert(res.event.kind === KIND_DATED, "event kind must be 'dated'");
      HC.assert(res.event.date === "2026-09-04", "event must carry its single concrete date");
      HC.assert(res.event.dateLabel === "Fri 4 Sep 2026",
        "label should be 'Fri 4 Sep 2026', got " + res.event.dateLabel);
    });

    check("The dated event is SEPARATE from any recurring slot", function () {
      var dated = getDated(TP);
      var rec = getRecurring(TP);
      HC.assert(dated.length === 1, "exactly one dated event expected, got " + dated.length);
      HC.assert(rec.length === 1, "recurring slots unchanged, got " + rec.length);
      var ev = dated[0];
      // The crux: not attached to a slot, and recognised as a one-off.
      HC.assert(ev.recurringId == null, "dated event must NOT reference a recurring slot");
      HC.assert(isDated(ev) === true, "isDated() must be true for the one-off event");
      HC.assert(isRecurring(ev) === false, "a dated event is not a recurring slot");
      // And it is not present in the recurring list, nor a recurring item in dated.
      HC.assert(rec.every(function (s) { return s.id !== ev.id; }),
        "the dated event must not appear among recurring slots");
    });

    // ===== A dated event requires a single concrete date (vs a weekday pattern) =====

    check("A one-off event with NO date is rejected", function () {
      var res = addDatedEvent(TP, { title: "Mystery event" });
      HC.assert(res.ok === false, "an event with no date must be rejected");
      HC.assert(/date/i.test(res.errors.join(" ")), "error should mention the missing date");
    });

    check("A one-off event with an invalid/impossible date is rejected", function () {
      var bad = ["2026-13-01", "2026-02-30", "04/09/2026", "soon", "", "2026-2-4"];
      for (var i = 0; i < bad.length; i++) {
        var res = addDatedEvent(TP, { title: "Bad date", date: bad[i] });
        HC.assert(res.ok === false, "invalid date '" + bad[i] + "' must be rejected");
      }
      // none of those should have been stored
      HC.assert(getDated(TP).length === 1, "no invalid events should persist, got " + getDated(TP).length);
    });

    check("A valid leap-day one-off event is accepted; a non-leap 29-Feb is not", function () {
      var ok = makeDatedEvent({ title: "Leap Day Camp", date: "2028-02-29" });
      HC.assert(ok.ok === true, "2028-02-29 is a real leap day and should be accepted");
      var bad = makeDatedEvent({ title: "Fake Leap Day", date: "2026-02-29" });
      HC.assert(bad.ok === false, "2026-02-29 is not a real date and must be rejected");
    });

    // ===== Multiple distinct dated events live alongside recurring slots =====

    check("Provider can add several distinct dated events", function () {
      addDatedEvent(TP, { title: "Bank-Holiday Forest Adventure", date: "2026-08-31", price: 30 });
      addDatedEvent(TP, { title: "Open Taster Day", date: "2026-07-19", price: 0, capacity: 40 });
      var dated = getDated(TP);
      HC.assert(dated.length === 3, "expected 3 dated events, got " + dated.length);
      // every one is a separate one-off with its own id and concrete date
      var ids = {};
      for (var i = 0; i < dated.length; i++) {
        HC.assert(isDated(dated[i]), "event " + i + " must be a one-off");
        HC.assert(isValidISODate(dated[i].date), "event " + i + " must have a concrete date");
        HC.assert(!ids[dated[i].id], "event ids must be unique");
        ids[dated[i].id] = true;
      }
      // sorted ascending by date
      HC.assert(dated[0].date <= dated[1].date && dated[1].date <= dated[2].date,
        "dated events should be returned in date order");
    });

    check("A free (£0) one-off event keeps price 0, not null", function () {
      var ev = getDated(TP).filter(function (e) { return e.title === "Open Taster Day"; })[0];
      HC.assert(ev, "the free taster event should exist");
      HC.assert(ev.price === 0, "an explicit £0 price must be preserved as 0, got " + ev.price);
      HC.assert(ev.capacity === 40, "capacity should be preserved");
    });

    // ===== Each dated instance gets its own register (article 2295666) =====

    check("Each dated event gets its own blank register", function () {
      var dated = getDated(TP);
      for (var i = 0; i < dated.length; i++) {
        HC.assert(Array.isArray(dated[i].register) && dated[i].register.length === 0,
          "every dated event should start with its own empty register");
      }
    });

    // ===== Capacity / price validation =====

    check("Invalid capacity / price are rejected", function () {
      var r1 = addDatedEvent(TP, { title: "Bad cap", date: "2026-08-10", capacity: -3 });
      HC.assert(r1.ok === false, "negative capacity must be rejected");
      var r2 = addDatedEvent(TP, { title: "Bad cap2", date: "2026-08-10", capacity: 2.5 });
      HC.assert(r2.ok === false, "fractional capacity must be rejected");
      var r3 = addDatedEvent(TP, { title: "Bad price", date: "2026-08-10", price: -5 });
      HC.assert(r3.ok === false, "negative price must be rejected");
    });

    // ===== Removal works and is scoped to dated events =====

    check("Removing a dated event leaves recurring slots intact", function () {
      var dated = getDated(TP);
      var target = dated[0];
      var recBefore = getRecurring(TP).length;
      var removed = removeDated(TP, target.id);
      HC.assert(removed === true, "remove should report success");
      HC.assert(getDated(TP).length === 2, "one dated event should be gone, 2 remain");
      HC.assert(getRecurring(TP).length === recBefore, "recurring slots must be untouched by a dated removal");
    });

    // ===== Persistence via HC.store (not raw localStorage) =====

    check("Dated events persist via HC.store and reload independently", function () {
      var reloaded = getDated(TP);
      HC.assert(reloaded.length === 2, "persisted dated events should survive a reload");
      // and they are still separate from recurring
      HC.assert(getRecurring(TP).length === 1, "recurring slot should still be the only recurring item");
    });

    // ===== Defensive: garbage input never throws and never persists =====

    check("Garbage input is handled and never persists", function () {
      var before = getDated(TP).length;
      var bad = [null, undefined, 42, "", [], {}, { date: 12345 }];
      for (var i = 0; i < bad.length; i++) {
        var res = addDatedEvent(TP, bad[i]);
        HC.assert(res && res.ok === false, "garbage input #" + i + " must be rejected");
      }
      HC.assert(getDated(TP).length === before, "garbage input must not change stored events");
    });

    // cleanup so repeated runs stay stable
    clearProvider(TP);

    return { pass: pass, fail: fail, log: log };
  }

  /* ===================================================================
     register
     =================================================================== */

  HC.registerFeature({
    id: "provider-dated-events",
    title: "Dated one-off events (vs recurring)",
    side: "provider",
    icon: "📌",
    summary: "Add a specific dated camp instance (an INSET-day special, a bank-holiday adventure, a one-off open day) that stands apart from your recurring weekly camp slot — with its own date, price, capacity and register.",
    render: render,
    selfTest: selfTest
  });
})();
