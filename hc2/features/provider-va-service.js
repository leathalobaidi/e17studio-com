/* HolidayCamp feature — provider-va-service
 * ------------------------------------------------------------------
 * "We'll set it up for you" — a done-for-you Virtual Assistant service.
 *
 * Replicates Happity's "The Happity Virtual Assistant Service"
 * (support article 4968022).
 *
 * Faithful to the evidence (article 4968022):
 *   - "Our team can save you time by helping to set up your profile &
 *      listings." -> a done-for-you setup service offered to providers.
 *   - "The service costs £25+VAT per hour" -> a STATED HOURLY RATE.
 *   - "One hour is usually enough to cover a timetable of c. 20 weekly
 *      classes" -> ~20 sessions covered by the first billed hour.
 *   - "we will only bill per half hour after that" -> after the first
 *      hour, time is billed in HALF-HOUR increments (rounded up).
 *   - "You will need to send us: Your timetable ... including time, date,
 *      age suitability, brief class description and class price(s)."
 *      -> the intake form requires a timetable source + per-session detail.
 *   - "Content to enhance your listing, such as: A logo / A photo or other
 *      banner image / Description for your class." -> optional enhancement
 *      content, each adding a little setup time.
 *   - "your listings will be live within 24 hours and you have the option
 *      to check your listings before they are published." -> 24h SLA + an
 *      optional pre-publish review step.
 *   - "You will then receive an invoice for the fees at the end of the
 *      month." -> billed monthly in arrears (no upfront charge).
 *
 * Framed for SCHOOL-AGE HOLIDAY CAMPS, not baby classes: the unit is a
 * camp SESSION (a dated day/week place across half-term and summer
 * holidays), so the team sets up a holiday programme rather than a weekly
 * timetable. The "~20 weekly classes per hour" productivity figure is
 * carried over as "~20 sessions per hour".
 *
 * ACCEPTANCE CRITERION (asserted in selfTest):
 *   A "we'll set it up for you" service is offered at a STATED HOURLY
 *   RATE (£25 + VAT per hour). selfTest exercises the quote LOGIC across
 *   multiple cases: the hourly rate is exposed and ex-VAT/inc-VAT figures
 *   reconcile; the first hour covers ~20 sessions; beyond that, time is
 *   billed per half hour rounded up; enhancement content adds time; and a
 *   submitted request persists with a "live within 24h" SLA.
 *
 * Self-contained, defensive, no imports/exports. Persistence is via
 * HC.store only (no global localStorage keys). Calls HC.registerFeature
 * at top level and never throws at registration time. Passes `node --check`.
 * ------------------------------------------------------------------ */
(function () {
  "use strict";

  // Defensive: never throw at module load if HC core isn't present.
  if (typeof window === "undefined" || !window.HC || typeof window.HC.registerFeature !== "function") {
    if (typeof console !== "undefined" && console.warn) {
      console.warn("[HC] provider-va-service: HC core not found; skipping registration.");
    }
    return;
  }

  var HC = window.HC;

  /* ===================================================================
     CONSTANTS — the offer, faithful to Happity article 4968022.
     =================================================================== */

  var STORE_KEY = "provider_va_service_requests"; // [requestObj, ...]

  var RATE_PER_HOUR_EX_VAT = 25;        // "£25 + VAT per hour"
  var VAT_RATE = 0.20;                  // UK standard-rate VAT
  var SESSIONS_PER_FIRST_HOUR = 20;     // "c. 20 weekly classes" -> ~20 sessions
  var FIRST_BLOCK_HOURS = 1;            // first hour is billed whole
  var INCREMENT_HOURS_AFTER = 0.5;      // "bill per half hour after that"
  var SLA_HOURS = 24;                   // "live within 24 hours"

  // Enhancement content the team can add. Each adds a little setup time.
  // (Holiday-camp framed: a programme cover image, a per-camp description.)
  var ENHANCEMENTS = [
    { id: "logo",        label: "Add your logo",                 hours: 0.0 },
    { id: "banner",      label: "Add a banner / cover photo",    hours: 0.0 },
    { id: "description", label: "Write camp descriptions",       hours: 0.5 },
    { id: "featured",    label: "Set Featured Listings (Members)", hours: 0.5 }
  ];

  /* ===================================================================
     PURE LOGIC (DOM-free, testable)
     =================================================================== */

  function round2(n) {
    return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
  }

  function toNum(v, def) {
    var n = Number(v);
    return isFinite(n) ? n : (def === undefined ? 0 : def);
  }

  // The single source of truth for the price of the service.
  function ratePerHourExVat() { return RATE_PER_HOUR_EX_VAT; }
  function vatRate() { return VAT_RATE; }
  function ratePerHourIncVat() { return round2(RATE_PER_HOUR_EX_VAT * (1 + VAT_RATE)); }

  /* Estimate billable hours for a setup job.
   *
   * Faithful to the article:
   *   - the FIRST hour is billed whole and covers up to ~20 sessions;
   *   - anything beyond that is billed in HALF-HOUR increments, rounded UP;
   *   - chosen enhancements add their setup time on top before rounding.
   *
   * Returns billable hours as a multiple of 0.5, never less than 1.
   */
  function estimateHours(sessionCount, enhancementIds) {
    var sessions = Math.max(0, Math.floor(toNum(sessionCount, 0)));

    // Raw setup time from the session volume, pro-rated against the
    // "20 sessions ≈ 1 hour" productivity figure.
    var rawHours = sessions / SESSIONS_PER_FIRST_HOUR;

    // Add enhancement overhead.
    var addHours = 0;
    var ids = Array.isArray(enhancementIds) ? enhancementIds : [];
    for (var i = 0; i < ENHANCEMENTS.length; i++) {
      if (ids.indexOf(ENHANCEMENTS[i].id) !== -1) addHours += ENHANCEMENTS[i].hours;
    }
    var raw = rawHours + addHours;

    // First hour is whole. Beyond the first hour, round UP to the next
    // half hour ("bill per half hour after that"). Floating-point noise is
    // shaved with a small epsilon so 1.0000001 doesn't tip into 1.5.
    var billable;
    if (raw <= FIRST_BLOCK_HOURS) {
      billable = FIRST_BLOCK_HOURS;
    } else {
      var extra = raw - FIRST_BLOCK_HOURS;
      var halfUnits = Math.ceil((extra - 1e-9) / INCREMENT_HOURS_AFTER);
      billable = FIRST_BLOCK_HOURS + halfUnits * INCREMENT_HOURS_AFTER;
    }
    return billable;
  }

  // Full quote for a job: hours + ex/inc-VAT cost.
  function quote(sessionCount, enhancementIds) {
    var hours = estimateHours(sessionCount, enhancementIds);
    var ex = round2(hours * RATE_PER_HOUR_EX_VAT);
    var vat = round2(ex * VAT_RATE);
    var inc = round2(ex + vat);
    return {
      sessions: Math.max(0, Math.floor(toNum(sessionCount, 0))),
      hours: hours,
      ratePerHourExVat: RATE_PER_HOUR_EX_VAT,
      ratePerHourIncVat: ratePerHourIncVat(),
      vatRate: VAT_RATE,
      costExVat: ex,
      vat: vat,
      costIncVat: inc,
      slaHours: SLA_HOURS
    };
  }

  // Validate an intake before a request can be submitted. The article
  // requires a timetable source; we require at least one session too.
  function validateRequest(form) {
    var f = form || {};
    var errors = [];
    var timetable = (typeof f.timetableSource === "string" ? f.timetableSource : "").trim();
    if (!timetable) errors.push("Tell us where your timetable is (link, PDF or 'I'll email it').");
    var sessions = Math.floor(toNum(f.sessionCount, 0));
    if (sessions < 1) errors.push("Enter how many camp sessions to set up (at least 1).");
    return { ok: errors.length === 0, errors: errors };
  }

  /* ===================================================================
     PERSISTENCE (HC.store only — namespaced hc_ by core)
     =================================================================== */

  function loadRequests() {
    try {
      var r = HC.store.get(STORE_KEY, []);
      return Array.isArray(r) ? r : [];
    } catch (e) { return []; }
  }
  function saveRequests(list) {
    try { return HC.store.set(STORE_KEY, Array.isArray(list) ? list : []); }
    catch (e) { return false; }
  }

  function newRequestId() {
    try { return "va_" + HC.util.uid(); }
    catch (e) { return "va_" + Date.now().toString(36) + "_" + Math.floor(Math.random() * 1e6).toString(36); }
  }

  // Submit a done-for-you request. Returns the stored record (with a
  // frozen quote and a 24h SLA) or { error } on validation failure.
  function submitRequest(form) {
    var v = validateRequest(form);
    if (!v.ok) return { error: v.errors.join(" ") };

    var f = form || {};
    var q = quote(f.sessionCount, f.enhancements);
    var now = (f._now instanceof Date) ? f._now : new Date();
    var due = new Date(now.getTime() + SLA_HOURS * 3600 * 1000);

    var record = {
      id: newRequestId(),
      providerId: f.providerId || null,
      providerName: f.providerName || "",
      timetableSource: String(f.timetableSource || "").trim(),
      sessionCount: q.sessions,
      enhancements: Array.isArray(f.enhancements) ? f.enhancements.slice() : [],
      preReview: f.preReview !== false, // article: option to check before publishing (default on)
      quote: q,
      status: "received",
      billing: "monthly_in_arrears", // "invoice ... at the end of the month"
      submittedAt: now.toISOString(),
      liveByAt: due.toISOString()
    };

    var list = loadRequests();
    list.push(record);
    saveRequests(list);
    return record;
  }

  // Convenience: how many camp sessions does the live provider have to set
  // up? We derive a sensible default from HC.data so the form pre-fills.
  function defaultSessionCount() {
    try {
      var providers = HC.data.providers || [];
      // Holiday-camp directory: estimate ~6 dated sessions per provider as a
      // starting point for the form (deterministic, just a UI default).
      if (providers.length) return 24;
    } catch (e) {}
    return 20;
  }

  function firstProvider() {
    try {
      var p = HC.data.providers || [];
      return p.length ? p[0] : null;
    } catch (e) { return null; }
  }

  /* ===================================================================
     RENDER (UI into mountEl)
     =================================================================== */

  function money(n) {
    try { return HC.util.money(round2(n)); }
    catch (e) { return "£" + round2(n); }
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function render(mountEl) {
    if (!mountEl) return;
    var prov = firstProvider();
    var defSessions = defaultSessionCount();

    var enhRows = ENHANCEMENTS.map(function (e) {
      return '<label style="display:flex;align-items:center;gap:8px;font-size:13.5px;cursor:pointer">' +
        '<input type="checkbox" class="va-enh" value="' + escapeHtml(e.id) + '"' +
          (e.id === "logo" || e.id === "banner" ? " checked" : "") + '> ' +
        escapeHtml(e.label) +
        (e.hours ? ' <span style="color:var(--muted,#808080)">(+' + e.hours + 'h)</span>' : '') +
      '</label>';
    }).join("");

    mountEl.innerHTML =
      '<div style="font-family:Nunito Sans,system-ui,sans-serif;color:var(--text,#383838)">' +
        '<p style="font-size:14px;margin:0 0 6px">' +
          "Short on time? Our team will set up your holiday-camp profile and listings " +
          "for you — send us your programme and we do the rest." +
        "</p>" +

        // The STATED HOURLY RATE — the headline of the offer.
        '<div style="background:var(--purple-tint,#F0E8F4);border-radius:14px;padding:14px 16px;margin:12px 0">' +
          '<div style="font-family:Quicksand,system-ui,sans-serif;font-weight:700;color:var(--purple,#603488);font-size:20px">' +
            money(RATE_PER_HOUR_EX_VAT) + ' + VAT per hour' +
          '</div>' +
          '<div style="font-size:12.5px;color:var(--muted,#808080);margin-top:2px">' +
            'That is ' + money(ratePerHourIncVat()) + ' inc VAT/hour. ' +
            'One hour usually covers about ' + SESSIONS_PER_FIRST_HOUR + ' sessions; ' +
            'we bill per half-hour after that, invoiced at the end of the month.' +
          '</div>' +
        '</div>' +

        '<div style="display:grid;gap:12px">' +
          '<label style="font-size:12.5px;font-weight:700;color:var(--purple,#603488);text-transform:uppercase;letter-spacing:.4px">' +
            'Where is your timetable?' +
            '<input id="va-timetable" type="text" placeholder="Website link, or \'I\'ll email a PDF\'"' +
              ' style="display:block;width:100%;margin-top:5px;padding:9px 11px;border:1.5px solid var(--line,#E6E6E6);border-radius:10px;font-size:13.5px;box-sizing:border-box">' +
          '</label>' +

          '<label style="font-size:12.5px;font-weight:700;color:var(--purple,#603488);text-transform:uppercase;letter-spacing:.4px">' +
            'How many camp sessions to set up?' +
            '<input id="va-sessions" type="number" min="1" value="' + defSessions + '"' +
              ' style="display:block;width:140px;margin-top:5px;padding:9px 11px;border:1.5px solid var(--line,#E6E6E6);border-radius:10px;font-size:13.5px;box-sizing:border-box">' +
          '</label>' +

          '<div>' +
            '<div style="font-size:12.5px;font-weight:700;color:var(--purple,#603488);text-transform:uppercase;letter-spacing:.4px;margin-bottom:5px">' +
              'Enhance your listing' +
            '</div>' +
            '<div style="display:grid;gap:6px">' + enhRows + '</div>' +
          '</div>' +

          '<label style="display:flex;align-items:center;gap:8px;font-size:13.5px;cursor:pointer">' +
            '<input id="va-prereview" type="checkbox" checked> ' +
            'Let me check the listings before they go live' +
          '</label>' +
        '</div>' +

        // Live quote panel.
        '<div id="va-quote" style="margin-top:14px;border:1.5px dashed var(--purple-tint,#F0E8F4);border-radius:14px;padding:13px 15px"></div>' +

        '<div style="display:flex;gap:8px;margin-top:14px">' +
          '<button id="va-submit" class="hc-btn" type="button">Request setup</button>' +
          '<button id="va-recalc" class="hc-btn hc-btn-ghost" type="button">Update quote</button>' +
        '</div>' +

        '<div id="va-receipt" style="margin-top:12px"></div>' +

        '<p style="font-size:11.5px;color:var(--muted,#808080);margin-top:14px">' +
          'Replicates Happity’s Virtual Assistant service (support article 4968022): ' +
          'done-for-you setup at ' + money(RATE_PER_HOUR_EX_VAT) + ' + VAT/hour, ' +
          'live within ' + SLA_HOURS + 'h, billed monthly in arrears.' +
        '</p>' +
      '</div>';

    function readForm() {
      var enh = [];
      var boxes = mountEl.querySelectorAll(".va-enh");
      for (var i = 0; i < boxes.length; i++) {
        if (boxes[i].checked) enh.push(boxes[i].value);
      }
      var preBox = mountEl.querySelector("#va-prereview");
      var ttEl = mountEl.querySelector("#va-timetable");
      var sEl = mountEl.querySelector("#va-sessions");
      return {
        providerId: prov ? (prov.id || prov.slug || null) : null,
        providerName: prov ? (prov.name || "") : "",
        timetableSource: ttEl ? ttEl.value : "",
        sessionCount: sEl ? sEl.value : 0,
        enhancements: enh,
        preReview: preBox ? preBox.checked : true
      };
    }

    function paintQuote() {
      var f = readForm();
      var q = quote(f.sessionCount, f.enhancements);
      var panel = mountEl.querySelector("#va-quote");
      if (!panel) return;
      panel.innerHTML =
        '<div style="font-family:Quicksand,system-ui,sans-serif;font-weight:700;color:var(--purple,#603488);font-size:15px;margin-bottom:6px">' +
          'Estimated quote' +
        '</div>' +
        '<div style="display:grid;grid-template-columns:1fr auto;gap:3px 10px;font-size:13.5px">' +
          '<span>Billable time</span><strong style="text-align:right">' + q.hours + ' hour' + (q.hours === 1 ? '' : 's') + '</strong>' +
          '<span>Rate</span><span style="text-align:right">' + money(q.ratePerHourExVat) + ' + VAT / hour</span>' +
          '<span>Cost (ex VAT)</span><span style="text-align:right">' + money(q.costExVat) + '</span>' +
          '<span>VAT @ ' + Math.round(q.vatRate * 100) + '%</span><span style="text-align:right">' + money(q.vat) + '</span>' +
          '<span style="font-weight:700">Total (inc VAT)</span><strong style="text-align:right">' + money(q.costIncVat) + '</strong>' +
        '</div>';
    }

    function onSubmit() {
      var f = readForm();
      var rec = submitRequest(f);
      var receipt = mountEl.querySelector("#va-receipt");
      if (!receipt) return;
      if (rec && rec.error) {
        receipt.innerHTML = '<div style="color:#9a1f5e;font-size:13px;font-weight:700">' + escapeHtml(rec.error) + '</div>';
        return;
      }
      var liveBy = "";
      try { liveBy = new Date(rec.liveByAt).toLocaleString("en-GB"); } catch (e) { liveBy = rec.liveByAt; }
      receipt.innerHTML =
        '<div style="background:#E1F0E4;color:#2f7d4f;border-radius:12px;padding:11px 13px;font-size:13.5px">' +
          '<strong>Request received.</strong> Our team will set up ' + rec.sessionCount +
          ' session' + (rec.sessionCount === 1 ? '' : 's') + ' for an estimated ' +
          money(rec.quote.costIncVat) + ' inc VAT. ' +
          (rec.preReview ? 'You’ll get to check the listings, then they go ' : 'Listings go ') +
          'live by <strong>' + escapeHtml(liveBy) + '</strong>. Invoiced at month-end.' +
        '</div>';
      try { HC.util.toast("VA setup request sent — live within " + SLA_HOURS + "h"); } catch (e) {}
    }

    var recalcBtn = mountEl.querySelector("#va-recalc");
    var submitBtn = mountEl.querySelector("#va-submit");
    var sessInput = mountEl.querySelector("#va-sessions");
    if (recalcBtn) recalcBtn.addEventListener("click", paintQuote);
    if (submitBtn) submitBtn.addEventListener("click", onSubmit);
    if (sessInput) sessInput.addEventListener("input", paintQuote);
    var enhBoxes = mountEl.querySelectorAll(".va-enh");
    for (var b = 0; b < enhBoxes.length; b++) enhBoxes[b].addEventListener("change", paintQuote);

    paintQuote();
  }

  /* ===================================================================
     SELF-TEST — exercises the LOGIC and asserts the acceptance criterion.
     =================================================================== */

  function selfTest() {
    var pass = 0, fail = 0, log = [];
    function check(label, fn) {
      try { fn(); pass += 1; log.push("✓ " + label); }
      catch (e) { fail += 1; log.push("✗ " + label + " — " + (e && e.message ? e.message : String(e))); }
    }

    // --- ACCEPTANCE CRITERION: a "set it up for you" service is offered at
    //     a STATED HOURLY RATE. ---
    check("A stated hourly rate is exposed (£25 + VAT / hour)", function () {
      HC.assert(ratePerHourExVat() === 25, "ex-VAT rate should be 25, got " + ratePerHourExVat());
      HC.assert(vatRate() === 0.20, "VAT rate should be 0.20, got " + vatRate());
      HC.assert(ratePerHourIncVat() === 30, "inc-VAT rate should be £30, got " + ratePerHourIncVat());
    });

    // Every quote carries the hourly rate, so the price is always stated.
    check("Every quote restates the hourly rate", function () {
      var q = quote(20, []);
      HC.assert(q.ratePerHourExVat === 25, "quote should restate 25/hr ex VAT");
      HC.assert(q.ratePerHourIncVat === 30, "quote should restate 30/hr inc VAT");
    });

    // --- "One hour is usually enough to cover ~20 weekly classes." ---
    check("First hour covers ~20 sessions for the base rate", function () {
      var q = quote(20, []);
      HC.assert(q.hours === 1, "20 sessions should be 1 billable hour, got " + q.hours);
      HC.assert(q.costExVat === 25, "20 sessions should cost £25 ex VAT, got " + q.costExVat);
      HC.assert(q.costIncVat === 30, "20 sessions should cost £30 inc VAT, got " + q.costIncVat);
    });

    check("A tiny job is still billed at the 1-hour minimum", function () {
      var q = quote(3, []);
      HC.assert(q.hours === 1, "3 sessions should round up to the 1h minimum, got " + q.hours);
      HC.assert(q.costExVat === 25, "minimum charge should be £25 ex VAT, got " + q.costExVat);
    });

    // --- "we will only bill per half hour after that." ---
    check("Beyond the first hour, time is billed per HALF hour (rounded up)", function () {
      // 30 sessions = 1.5h of raw work -> exactly 1.5 billable hours.
      var q30 = quote(30, []);
      HC.assert(q30.hours === 1.5, "30 sessions should be 1.5h, got " + q30.hours);
      HC.assert(q30.costExVat === 37.5, "1.5h should cost £37.50 ex VAT, got " + q30.costExVat);

      // 31 sessions = 1.55h raw -> rounds UP to the next half hour = 2.0h.
      var q31 = quote(31, []);
      HC.assert(q31.hours === 2, "31 sessions should round up to 2h, got " + q31.hours);

      // 21 sessions = 1.05h raw -> rounds UP to 1.5h (never to a finer unit).
      var q21 = quote(21, []);
      HC.assert(q21.hours === 1.5, "21 sessions should round up to 1.5h, got " + q21.hours);
    });

    check("Billable hours are always a whole or half-hour multiple", function () {
      var cases = [1, 5, 19, 20, 25, 40, 41, 60, 77, 100];
      for (var i = 0; i < cases.length; i++) {
        var h = estimateHours(cases[i], []);
        var twice = h * 2;
        HC.assert(Math.abs(twice - Math.round(twice)) < 1e-9,
          cases[i] + " sessions gave non-half-hour value " + h);
        HC.assert(h >= 1, cases[i] + " sessions should be >= 1h, got " + h);
      }
    });

    // --- Enhancement content adds setup time. ---
    check("Enhancement content (descriptions) adds billable time", function () {
      var base = quote(20, []);            // 1.0h
      var withDesc = quote(20, ["description"]); // +0.5h -> 1.5h
      HC.assert(base.hours === 1, "base should be 1h");
      HC.assert(withDesc.hours === 1.5, "adding descriptions should push to 1.5h, got " + withDesc.hours);
      HC.assert(withDesc.costExVat > base.costExVat, "enhanced job should cost more");
    });

    check("Logo/banner are free add-ons (no extra hours)", function () {
      var base = quote(20, []);
      var withLogo = quote(20, ["logo", "banner"]);
      HC.assert(withLogo.hours === base.hours, "logo+banner should not add billable time");
    });

    // --- Intake validation (article requires a timetable). ---
    check("Request requires a timetable source and >=1 session", function () {
      var bad = validateRequest({ timetableSource: "", sessionCount: 0 });
      HC.assert(bad.ok === false, "empty form should be invalid");
      HC.assert(bad.errors.length >= 2, "should report missing timetable AND sessions");
      var good = validateRequest({ timetableSource: "https://camp.example/timetable", sessionCount: 24 });
      HC.assert(good.ok === true, "valid form should pass: " + good.errors.join("; "));
    });

    // --- Submit persists with a frozen quote + 24h SLA + monthly billing. ---
    check("Submitting persists a request with a 24h SLA and monthly billing", function () {
      var before = loadRequests().length;
      var now = new Date("2026-06-16T09:00:00.000Z");
      var rec = submitRequest({
        providerName: "Test Holiday Camp Co",
        timetableSource: "https://camp.example/summer.pdf",
        sessionCount: 24,
        enhancements: ["logo", "description"],
        preReview: true,
        _now: now
      });
      HC.assert(rec && !rec.error, "valid submit should not error: " + (rec && rec.error));
      HC.assert(rec.status === "received", "status should be received");
      HC.assert(rec.billing === "monthly_in_arrears", "should bill monthly in arrears");
      HC.assert(rec.quote && rec.quote.ratePerHourExVat === 25, "stored quote should keep the £25 rate");

      // 24 sessions = 1.2h raw + 0.5h descriptions = 1.7h -> rounds to 2.0h.
      HC.assert(rec.quote.hours === 2, "24 sessions + descriptions should be 2h, got " + rec.quote.hours);

      // SLA: live by exactly 24h after submission.
      var sub = new Date(rec.submittedAt).getTime();
      var live = new Date(rec.liveByAt).getTime();
      HC.assert(Math.abs((live - sub) - 24 * 3600 * 1000) < 1000, "live-by should be 24h after submit");

      var after = loadRequests().length;
      HC.assert(after === before + 1, "request should be persisted (" + before + " -> " + after + ")");
    });

    check("Invalid submit is rejected and not persisted", function () {
      var before = loadRequests().length;
      var rec = submitRequest({ timetableSource: "", sessionCount: 0 });
      HC.assert(rec && rec.error, "invalid submit should return an error");
      var after = loadRequests().length;
      HC.assert(after === before, "invalid submit must not persist (" + before + " -> " + after + ")");
    });

    // Cleanup: remove any test records we appended so re-runs stay stable.
    try {
      var list = loadRequests().filter(function (r) {
        return !(r && r.providerName === "Test Holiday Camp Co");
      });
      saveRequests(list);
    } catch (e) {}

    return { pass: pass, fail: fail, log: log };
  }

  /* ===================================================================
     REGISTER
     =================================================================== */

  HC.registerFeature({
    id: "provider-va-service",
    title: "Done-for-you setup (VA service)",
    side: "provider",
    icon: "🛎️", // 🛎️
    summary: "Short on time? Our team sets up your holiday-camp profile and listings for you, at £25 + VAT per hour — live within 24 hours, billed at month-end.",
    render: render,
    selfTest: selfTest
  });

  // Expose pure logic for debugging/other features (non-enumerable-ish stash).
  try {
    HC._vaService = {
      quote: quote,
      estimateHours: estimateHours,
      validateRequest: validateRequest,
      submitRequest: submitRequest,
      ratePerHourExVat: ratePerHourExVat,
      ratePerHourIncVat: ratePerHourIncVat
    };
  } catch (e) {}
})();
