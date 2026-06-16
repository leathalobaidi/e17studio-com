/* HolidayCamp feature: parent-quick-check
 * ------------------------------------------------------------------
 * Replicates Happity's "Quick Check" feature.
 *
 * Evidence:
 *  - Article 3792405 ("Happity's 'Quick Check' Feature"): "Parents can
 *    check if a class is running as advertised, and class providers can
 *    respond at the click of a button. When the class provider clicks a
 *    response in their Quick Check email, we'll automatically email the
 *    person who enquired, AND UPDATE THE PUBLISHED DATE ON THE CLASS too,
 *    so that everyone can see whether info is currently up to date."
 *  - Article 8255669 (parent FAQs): "there is a Quick check button: You
 *    will be asked to ENTER YOUR DETAILS and a message will be sent to
 *    the class provider letting them know you have asked about their
 *    class. The class provider will then be in touch to confirm the
 *    class is still running."
 *
 * Side: parent. Framed for SCHOOL-AGE HOLIDAY CAMPS (day / full-week
 * holiday-club places), not baby classes. The parent's question is
 * "is this camp still running this summer?".
 *
 * Acceptance criterion (asserted in selfTest):
 *   Quick-check submits parent details; provider one-click response
 *   updates the published date.
 *
 * Model of the flow (all in-memory + HC.store, no real backend):
 *   1. submitQuickCheck(campId, parent) -> validates parent details,
 *      creates a pending enquiry, sends a (mock) "Quick Check email" to
 *      the provider. Published date is UNCHANGED at this point.
 *   2. providerRespond(enquiryId, response) -> the provider's one-click
 *      reply ("still-running" / "changed" / "not-running"). This:
 *        a. marks the enquiry answered + records the provider response,
 *        b. emails the enquirer (mock — captured on the enquiry),
 *        c. UPDATES THE PUBLISHED DATE on the camp to "today".
 *   3. publishedDateFor(campId) reads the live (possibly updated) date.
 *
 * Defensive: nothing throws at registration time; risky paths are
 * wrapped. Persistence is HC.store only (namespaced "hc_").
 * ------------------------------------------------------------------ */
(function () {
  "use strict";

  if (typeof window === "undefined" || !window.HC || typeof window.HC.registerFeature !== "function") {
    // Core not present — fail silently rather than throwing.
    return;
  }
  var HC = window.HC;

  /* ============================================================
   * 0. Constants + storage keys.
   * ============================================================ */
  var TODAY_ISO = "2026-06-15"; // app reference "today" (deterministic)
  var ENQUIRIES_KEY = "quickcheck_enquiries";   // array of enquiry records
  var PUBLISHED_KEY = "quickcheck_published";    // map campId -> ISO date override
  var LAST_PARENT_KEY = "quickcheck_last_parent"; // convenience prefill

  // The one-click responses a provider can give from their Quick Check email.
  var RESPONSES = {
    "still-running": {
      label: "Yes — still running as advertised",
      parentEmail: "Good news! The provider confirmed this holiday camp is still running as advertised.",
      tone: "ok"
    },
    "changed": {
      label: "Running, but details have changed",
      parentEmail: "The provider says this camp is running, but some details have changed — please re-check the dates, times or price.",
      tone: "warn"
    },
    "not-running": {
      label: "No — this camp is not running",
      parentEmail: "Unfortunately the provider says this holiday camp is not running. Try another camp on the planner.",
      tone: "bad"
    }
  };

  /* ============================================================
   * 1. Tiny helpers.
   * ============================================================ */
  function esc(s) {
    return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
  function escAttr(s) { return esc(s).replace(/"/g, "&quot;"); }

  function isValidEmail(s) {
    // Deliberately simple — enough to reject obvious junk in a mockup.
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s == null ? "" : s).trim());
  }

  function loadEnquiries() {
    try {
      var arr = HC.store.get(ENQUIRIES_KEY, []);
      return Array.isArray(arr) ? arr : [];
    } catch (e) { return []; }
  }
  function saveEnquiries(arr) {
    try { HC.store.set(ENQUIRIES_KEY, Array.isArray(arr) ? arr : []); } catch (e) {}
  }
  function loadPublishedOverrides() {
    try {
      var m = HC.store.get(PUBLISHED_KEY, {});
      return (m && typeof m === "object") ? m : {};
    } catch (e) { return {}; }
  }
  function savePublishedOverrides(m) {
    try { HC.store.set(PUBLISHED_KEY, (m && typeof m === "object") ? m : {}); } catch (e) {}
  }

  /* ============================================================
   * 2. Camp lookup + published-date model.
   *
   * Individual camps in the live directory don't carry a per-camp
   * published date, so we DERIVE a baseline from E17_DIRECTORY.updated
   * (the date the directory was last published) and let a Quick Check
   * response override it per-camp via HC.store. This is exactly the
   * Happity model: the provider's reply updates the published date.
   * ============================================================ */
  function baselinePublished() {
    try {
      var d = window.E17_DIRECTORY && window.E17_DIRECTORY.updated;
      if (typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d)) return d;
    } catch (e) {}
    return "2026-06-12";
  }

  function campById(id) {
    try {
      var list = HC.data.providers || [];
      for (var i = 0; i < list.length; i++) {
        if (list[i] && list[i].id === id) return list[i];
      }
    } catch (e) {}
    return null;
  }

  // The CURRENT published date for a camp: an override if a Quick Check
  // response has updated it, else the directory baseline.
  function publishedDateFor(campId) {
    var overrides = loadPublishedOverrides();
    if (overrides && typeof overrides[campId] === "string") return overrides[campId];
    return baselinePublished();
  }

  function setPublishedDate(campId, iso) {
    var overrides = loadPublishedOverrides();
    overrides[campId] = iso;
    savePublishedOverrides(overrides);
    return iso;
  }

  function prettyDate(iso) {
    // Format an ISO date as e.g. "15 Jun 2026" without locale surprises.
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ""));
    if (!m) return String(iso || "");
    var months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    var d = parseInt(m[3], 10), mo = parseInt(m[2], 10) - 1, y = m[1];
    if (mo < 0 || mo > 11) return String(iso || "");
    return d + " " + months[mo] + " " + y;
  }

  /* ============================================================
   * 3. Core logic — submit a quick check + provider response.
   *    These are pure-ish (they touch HC.store) and are what
   *    selfTest exercises. They never throw.
   * ============================================================ */

  // Validate parent details. Returns { ok, errors:[...], parent }.
  function validateParent(parent) {
    parent = parent || {};
    var name = String(parent.name == null ? "" : parent.name).trim();
    var email = String(parent.email == null ? "" : parent.email).trim();
    var message = String(parent.message == null ? "" : parent.message).trim();
    var errors = [];
    if (!name) errors.push("name");
    if (!email) errors.push("email-missing");
    else if (!isValidEmail(email)) errors.push("email-invalid");
    return {
      ok: errors.length === 0,
      errors: errors,
      parent: { name: name, email: email, message: message }
    };
  }

  /* Submit a Quick Check enquiry for a camp.
   *   ok:    { ok:true, enquiry }
   *   error: { ok:false, reason, errors }
   * Publishing date is NOT changed here (provider hasn't replied yet). */
  function submitQuickCheck(campId, parent, opts) {
    opts = opts || {};
    var nowIso = opts.todayIso || TODAY_ISO;

    var camp = campById(campId);
    if (!camp) {
      return { ok: false, reason: "unknown-camp", errors: ["unknown-camp"] };
    }

    var v = validateParent(parent);
    if (!v.ok) {
      return { ok: false, reason: "invalid-details", errors: v.errors };
    }

    var enquiry = {
      id: HC.util.uid(),
      campId: campId,
      campName: camp.name || campId,
      parent: v.parent,
      createdIso: nowIso,
      status: "pending",                 // pending until the provider clicks
      providerResponse: null,            // one of RESPONSES keys
      respondedIso: null,
      parentEmailSent: false,
      parentEmailBody: null,
      // The published date captured at submit-time (so we can prove it changed).
      publishedAtSubmit: publishedDateFor(campId),
      // The mock "Quick Check email" we send to the provider.
      providerEmail: {
        to: "provider",
        subject: "Quick Check: is “" + (camp.name || campId) + "” still running?",
        from: v.parent.name + " <" + v.parent.email + ">",
        sentIso: nowIso
      }
    };

    var all = loadEnquiries();
    all.push(enquiry);
    saveEnquiries(all);

    // Prefill convenience for next time.
    try { HC.store.set(LAST_PARENT_KEY, { name: v.parent.name, email: v.parent.email }); } catch (e) {}

    return { ok: true, enquiry: enquiry };
  }

  /* Provider's one-click response from their Quick Check email.
   * This is the heart of the acceptance criterion: it emails the
   * enquirer AND updates the camp's published date.
   *   ok:    { ok:true, enquiry, publishedBefore, publishedAfter }
   *   error: { ok:false, reason } */
  function providerRespond(enquiryId, responseKey, opts) {
    opts = opts || {};
    var nowIso = opts.todayIso || TODAY_ISO;

    if (!RESPONSES[responseKey]) {
      return { ok: false, reason: "invalid-response" };
    }

    var all = loadEnquiries();
    var enquiry = null;
    for (var i = 0; i < all.length; i++) {
      if (all[i] && all[i].id === enquiryId) { enquiry = all[i]; break; }
    }
    if (!enquiry) {
      return { ok: false, reason: "unknown-enquiry" };
    }
    if (enquiry.status === "answered") {
      // Idempotent-ish: a second click shouldn't double-process.
      return { ok: false, reason: "already-answered", enquiry: enquiry };
    }

    var publishedBefore = publishedDateFor(enquiry.campId);

    // a. Mark the enquiry answered + record the provider's response.
    enquiry.status = "answered";
    enquiry.providerResponse = responseKey;
    enquiry.respondedIso = nowIso;

    // b. "Email" the enquirer (captured on the enquiry record).
    enquiry.parentEmailSent = true;
    enquiry.parentEmailBody = RESPONSES[responseKey].parentEmail;

    // c. UPDATE THE PUBLISHED DATE on the camp to "today" — the headline
    //    Happity behaviour. Any one-click response refreshes the date,
    //    because the provider has just confirmed the current state.
    var publishedAfter = setPublishedDate(enquiry.campId, nowIso);

    saveEnquiries(all);

    return {
      ok: true,
      enquiry: enquiry,
      publishedBefore: publishedBefore,
      publishedAfter: publishedAfter
    };
  }

  // Lookups used by the UI.
  function enquiryById(id) {
    var all = loadEnquiries();
    for (var i = 0; i < all.length; i++) if (all[i] && all[i].id === id) return all[i];
    return null;
  }
  function pendingEnquiries() {
    return loadEnquiries().filter(function (e) { return e && e.status === "pending"; });
  }

  // Pick a sensible default camp from the live directory.
  function defaultCamps(limit) {
    var out = [];
    try {
      var list = HC.data.providers || [];
      for (var i = 0; i < list.length && out.length < (limit || 8); i++) {
        if (list[i] && list[i].id && list[i].name) out.push(list[i]);
      }
    } catch (e) {}
    if (!out.length) out = [{ id: "demo-camp", name: "Demo Holiday Camp" }];
    return out;
  }

  /* ============================================================
   * 4. UI — parent-facing Quick Check, with a provider "email"
   *    panel so you can see the full round-trip in one screen.
   * ============================================================ */
  function render(mountEl) {
    try {
      var camps = defaultCamps(10);
      var last = {};
      try { last = HC.store.get(LAST_PARENT_KEY, {}) || {}; } catch (e) { last = {}; }

      var options = camps.map(function (c, i) {
        return '<option value="' + escAttr(c.id) + '"' + (i === 0 ? " selected" : "") + ">" +
          esc(c.name) + "</option>";
      }).join("");

      mountEl.innerHTML =
        '<div style="font-family:\'Nunito Sans\',system-ui,sans-serif;color:var(--text,#383838)">' +
          '<p style="font-size:14px;margin:0 0 14px">Not sure a holiday camp is still on this summer? ' +
          'Send a <strong>Quick Check</strong>. Enter your details and we\'ll message the provider. ' +
          'When they reply with one click, we email you back <em>and</em> refresh the camp\'s ' +
          '<strong>published date</strong> so everyone can see the info is current.</p>' +

          // --- Parent form ---
          '<label style="display:block;font-weight:700;font-size:13px;margin-bottom:4px">Which camp?</label>' +
          '<select id="qcCamp" style="width:100%;padding:9px;border:1.5px solid var(--line,#E6E6E6);border-radius:12px;font-size:14px;margin-bottom:6px">' +
            options +
          "</select>" +
          '<div id="qcPublished" style="font-size:12px;color:var(--muted,#808080);margin-bottom:12px"></div>' +

          '<label style="display:block;font-weight:700;font-size:13px;margin-bottom:4px">Your name</label>' +
          '<input id="qcName" type="text" value="' + escAttr(last.name || "") + '" placeholder="e.g. Sam Carter" ' +
            'autocomplete="name" style="width:100%;padding:9px;border:1.5px solid var(--line,#E6E6E6);border-radius:12px;font-size:14px;margin-bottom:10px">' +

          '<label style="display:block;font-weight:700;font-size:13px;margin-bottom:4px">Your email</label>' +
          '<input id="qcEmail" type="email" value="' + escAttr(last.email || "") + '" placeholder="you@example.com" ' +
            'autocomplete="email" style="width:100%;padding:9px;border:1.5px solid var(--line,#E6E6E6);border-radius:12px;font-size:14px;margin-bottom:10px">' +

          '<label style="display:block;font-weight:700;font-size:13px;margin-bottom:4px">Message (optional)</label>' +
          '<textarea id="qcMessage" rows="2" placeholder="Is this camp still running in week 2 (27–31 July)?" ' +
            'style="width:100%;padding:9px;border:1.5px solid var(--line,#E6E6E6);border-radius:12px;font-size:14px;margin-bottom:12px;resize:vertical"></textarea>' +

          '<button id="qcSubmit" type="button" class="hc-btn">Send Quick Check</button>' +
          '<div id="qcFormMsg" style="font-size:12.5px;min-height:16px;margin-top:8px"></div>' +

          // --- Provider "Quick Check email" round-trip panel ---
          '<div id="qcProviderPanel" style="display:none;margin-top:18px;border:1.5px solid var(--line,#E6E6E6);border-radius:14px;padding:14px 16px;background:#fff">' +
            '<div style="font-family:\'Quicksand\',system-ui,sans-serif;font-weight:700;color:var(--purple,#603488);font-size:14px;margin-bottom:4px">' +
              "📧 Provider’s Quick Check email" + "</div>" +
            '<div id="qcProviderSubject" style="font-size:13px;margin-bottom:10px;color:var(--text,#383838)"></div>' +
            '<div style="font-size:12.5px;color:var(--muted,#808080);margin-bottom:8px">They reply with one click:</div>' +
            '<div style="display:flex;flex-wrap:wrap;gap:8px">' +
              '<button class="hc-btn" data-qc-resp="still-running" type="button">✅ Still running</button>' +
              '<button class="hc-btn hc-btn-ghost" data-qc-resp="changed" type="button">✏️ Details changed</button>' +
              '<button class="hc-btn hc-btn-ghost" data-qc-resp="not-running" type="button">🚫 Not running</button>' +
            "</div>" +
          "</div>" +

          // --- Outcome (parent email + updated published date) ---
          '<div id="qcOutcome" style="display:none;margin-top:14px;border-radius:14px;padding:14px 16px"></div>' +
        "</div>";

      var $ = function (id) { return mountEl.querySelector("#" + id); };
      var state = { enquiryId: null };

      function refreshPublishedLine() {
        var campId = $("qcCamp").value;
        var d = publishedDateFor(campId);
        $("qcPublished").innerHTML = "Published date on this camp: <strong>" + esc(prettyDate(d)) + "</strong>";
      }

      function setFormMsg(text, tone) {
        var m = $("qcFormMsg");
        m.textContent = text || "";
        m.style.color = tone === "ok" ? "#2f7d4f" : "#9a1f5e";
      }

      function onSubmit() {
        var campId = $("qcCamp").value;
        var res = submitQuickCheck(campId, {
          name: $("qcName").value,
          email: $("qcEmail").value,
          message: $("qcMessage").value
        });
        if (!res.ok) {
          var why = "Please check your details.";
          if (res.errors.indexOf("name") !== -1) why = "Please enter your name.";
          else if (res.errors.indexOf("email-missing") !== -1) why = "Please enter your email.";
          else if (res.errors.indexOf("email-invalid") !== -1) why = "That email doesn’t look right.";
          setFormMsg(why, "bad");
          return;
        }
        state.enquiryId = res.enquiry.id;
        setFormMsg("Sent! We’ve messaged the provider. Awaiting their one-click reply…", "ok");
        try { HC.util.toast("Quick Check sent to the provider"); } catch (e) {}

        // Reveal the provider email panel.
        $("qcProviderSubject").textContent = res.enquiry.providerEmail.subject;
        $("qcProviderPanel").style.display = "block";
        $("qcOutcome").style.display = "none";
      }

      function onProviderRespond(responseKey) {
        if (!state.enquiryId) return;
        var before = publishedDateFor($("qcCamp").value);
        var res = providerRespond(state.enquiryId, responseKey);
        var out = $("qcOutcome");
        if (!res.ok) {
          out.style.display = "block";
          out.style.background = "var(--pink-tint,#FCE8F0)";
          out.style.color = "#9a1f5e";
          out.innerHTML = "Could not record that response (" + esc(res.reason) + ").";
          return;
        }
        var tone = RESPONSES[responseKey].tone;
        var bg = tone === "ok" ? "#E1F0E4" : (tone === "warn" ? "var(--purple-tint,#F0E8F4)" : "var(--pink-tint,#FCE8F0)");
        out.style.display = "block";
        out.style.background = bg;
        out.style.color = "var(--text,#383838)";
        out.innerHTML =
          '<div style="font-family:\'Quicksand\',system-ui,sans-serif;font-weight:700;margin-bottom:6px">' +
            "✓ Provider replied: " + esc(RESPONSES[responseKey].label) + "</div>" +
          '<div style="font-size:13px;margin-bottom:8px">📨 We emailed you: ' +
            esc(res.enquiry.parentEmailBody) + "</div>" +
          '<div style="font-size:13px">📅 Published date updated: <strong>' +
            esc(prettyDate(before)) + "</strong> → <strong>" + esc(prettyDate(res.publishedAfter)) +
            "</strong></div>";

        // Refresh the published line so the change is visible immediately,
        // and hide the now-used provider panel.
        refreshPublishedLine();
        $("qcProviderPanel").style.display = "none";
        try { HC.util.toast("Published date refreshed to today"); } catch (e) {}
      }

      $("qcSubmit").addEventListener("click", onSubmit);
      $("qcCamp").addEventListener("change", function () {
        refreshPublishedLine();
        // Switching camp resets the in-flight enquiry view.
        state.enquiryId = null;
        $("qcProviderPanel").style.display = "none";
        $("qcOutcome").style.display = "none";
        setFormMsg("", "ok");
      });
      mountEl.querySelectorAll("[data-qc-resp]").forEach(function (btn) {
        btn.addEventListener("click", function () {
          onProviderRespond(btn.getAttribute("data-qc-resp"));
        });
      });

      refreshPublishedLine();
    } catch (e) {
      mountEl.innerHTML = '<p style="color:#9a1f5e">Quick Check preview failed to load: ' +
        esc(e && e.message ? e.message : String(e)) + "</p>";
    }
  }

  /* ============================================================
   * 5. selfTest — exercises the LOGIC and asserts the acceptance
   *    criterion across multiple cases. Uses an isolated store
   *    namespace so it never pollutes a real parent's enquiries.
   * ============================================================ */
  function selfTest() {
    var pass = 0, fail = 0, log = [];
    function check(label, fn) {
      try { fn(); pass += 1; log.push("✓ " + label); }
      catch (e) { fail += 1; log.push("✗ " + label + " — " + (e && e.message ? e.message : String(e))); }
    }

    // --- Snapshot + reset the store so the test is hermetic. ---
    var snapEnq = HC.store.get(ENQUIRIES_KEY, []);
    var snapPub = HC.store.get(PUBLISHED_KEY, {});
    var snapLast = HC.store.get(LAST_PARENT_KEY, {});
    saveEnquiries([]);
    savePublishedOverrides({});

    try {
      // A real camp id from the live directory (fallback handled in helpers).
      var camps = defaultCamps(3);
      var campId = camps[0] && camps[0].id;
      HC.assert(campId, "should resolve at least one camp id from live data");

      var GOOD_PARENT = { name: "Sam Carter", email: "sam@example.com", message: "Still on in week 2?" };

      // --- ACCEPTANCE part 1: submit parent details creates an enquiry. ---
      check("Quick Check submits valid parent details and creates a pending enquiry", function () {
        var r = submitQuickCheck(campId, GOOD_PARENT);
        HC.assert(r.ok === true, "valid submission should succeed");
        HC.assert(r.enquiry && r.enquiry.id, "an enquiry record should be created");
        HC.assert(r.enquiry.status === "pending", "new enquiry should be pending, got " + r.enquiry.status);
        HC.assert(r.enquiry.parent.name === "Sam Carter", "parent name should be captured");
        HC.assert(r.enquiry.parent.email === "sam@example.com", "parent email should be captured");
        HC.assert(r.enquiry.providerEmail && /Quick Check/.test(r.enquiry.providerEmail.subject),
          "a Quick Check email to the provider should be prepared");
      });

      // --- Submitting does NOT yet change the published date. ---
      check("Submitting a Quick Check does NOT change the published date yet", function () {
        var before = publishedDateFor(campId);
        submitQuickCheck(campId, GOOD_PARENT);
        var after = publishedDateFor(campId);
        HC.assert(before === after, "published date must be unchanged before the provider replies");
      });

      // --- ACCEPTANCE part 2 (HEADLINE): provider one-click response
      //     emails the parent AND updates the published date. ---
      check("Provider one-click response updates the published date (ACCEPTANCE)", function () {
        // Baseline published date is the directory date, NOT today.
        var baseline = publishedDateFor(campId);
        HC.assert(baseline !== TODAY_ISO,
          "precondition: baseline published date should differ from today (" + baseline + ")");

        var sub = submitQuickCheck(campId, GOOD_PARENT);
        HC.assert(sub.ok, "submit should succeed");

        var resp = providerRespond(sub.enquiry.id, "still-running");
        HC.assert(resp.ok === true, "provider response should succeed");

        // The published date must now be TODAY (refreshed).
        HC.assert(resp.publishedBefore === baseline,
          "publishedBefore should equal the prior date, got " + resp.publishedBefore);
        HC.assert(resp.publishedAfter === TODAY_ISO,
          "publishedAfter should be today (" + TODAY_ISO + "), got " + resp.publishedAfter);
        HC.assert(publishedDateFor(campId) === TODAY_ISO,
          "the live published date for the camp must read today after the response");
        HC.assert(resp.publishedAfter !== resp.publishedBefore,
          "the published date must actually change");

        // And the enquirer must have been emailed.
        HC.assert(resp.enquiry.parentEmailSent === true, "the parent must be emailed on response");
        HC.assert(typeof resp.enquiry.parentEmailBody === "string" && resp.enquiry.parentEmailBody.length > 0,
          "a parent email body must be recorded");
        HC.assert(resp.enquiry.status === "answered", "enquiry should be marked answered");
      });

      // --- All three one-click responses refresh the date (not just 'yes'). ---
      check("Every one-click response refreshes the published date", function () {
        Object.keys(RESPONSES).forEach(function (key) {
          // Reset overrides so each starts from baseline.
          savePublishedOverrides({});
          saveEnquiries([]);
          var sub = submitQuickCheck(campId, GOOD_PARENT);
          var resp = providerRespond(sub.enquiry.id, key);
          HC.assert(resp.ok, "response '" + key + "' should succeed");
          HC.assert(resp.publishedAfter === TODAY_ISO,
            "response '" + key + "' should set published date to today, got " + resp.publishedAfter);
        });
      });

      // --- Response with a fixed 'today' override proves the date tracks it. ---
      check("Published date is set to the response date (custom todayIso)", function () {
        savePublishedOverrides({});
        saveEnquiries([]);
        var sub = submitQuickCheck(campId, GOOD_PARENT, { todayIso: "2026-06-10" });
        var resp = providerRespond(sub.enquiry.id, "still-running", { todayIso: "2026-07-01" });
        HC.assert(resp.ok, "response should succeed");
        HC.assert(resp.publishedAfter === "2026-07-01",
          "published date should track the response date, got " + resp.publishedAfter);
        HC.assert(publishedDateFor(campId) === "2026-07-01", "live read should reflect the response date");
      });

      // --- Validation: missing name / email rejected, no enquiry created. ---
      check("Submission without a name is rejected", function () {
        saveEnquiries([]);
        var r = submitQuickCheck(campId, { name: "", email: "a@b.com" });
        HC.assert(r.ok === false, "missing name should be rejected");
        HC.assert(r.errors.indexOf("name") !== -1, "errors should flag the name");
        HC.assert(loadEnquiries().length === 0, "no enquiry should be created on invalid details");
      });

      check("Submission with an invalid email is rejected", function () {
        var r = submitQuickCheck(campId, { name: "Jo", email: "not-an-email" });
        HC.assert(r.ok === false, "invalid email should be rejected");
        HC.assert(r.errors.indexOf("email-invalid") !== -1, "errors should flag the invalid email");
      });

      check("Submission with a missing email is rejected", function () {
        var r = submitQuickCheck(campId, { name: "Jo", email: "  " });
        HC.assert(r.ok === false, "missing email should be rejected");
        HC.assert(r.errors.indexOf("email-missing") !== -1, "errors should flag the missing email");
      });

      // --- Unknown camp guard. ---
      check("Quick Check for an unknown camp is rejected", function () {
        var r = submitQuickCheck("no-such-camp-xyz", GOOD_PARENT);
        HC.assert(r.ok === false, "unknown camp should be rejected");
        HC.assert(r.reason === "unknown-camp", "reason should be 'unknown-camp', got " + r.reason);
      });

      // --- Provider-response guards. ---
      check("Provider response to an unknown enquiry is rejected", function () {
        var r = providerRespond("does-not-exist", "still-running");
        HC.assert(r.ok === false, "unknown enquiry should be rejected");
        HC.assert(r.reason === "unknown-enquiry", "reason should be 'unknown-enquiry', got " + r.reason);
      });

      check("An invalid response key is rejected", function () {
        saveEnquiries([]);
        savePublishedOverrides({});
        var sub = submitQuickCheck(campId, GOOD_PARENT);
        var r = providerRespond(sub.enquiry.id, "maybe-dunno");
        HC.assert(r.ok === false, "invalid response key should be rejected");
        HC.assert(r.reason === "invalid-response", "reason should be 'invalid-response', got " + r.reason);
        // And the published date must NOT have moved on a rejected response.
        HC.assert(publishedDateFor(campId) === baselinePublished(),
          "a rejected response must not change the published date");
      });

      check("A second response to an already-answered enquiry is rejected (no double-publish)", function () {
        saveEnquiries([]);
        savePublishedOverrides({});
        var sub = submitQuickCheck(campId, GOOD_PARENT);
        var first = providerRespond(sub.enquiry.id, "still-running", { todayIso: "2026-06-20" });
        HC.assert(first.ok, "first response should succeed");
        var second = providerRespond(sub.enquiry.id, "still-running", { todayIso: "2026-07-15" });
        HC.assert(second.ok === false, "second response should be rejected");
        HC.assert(second.reason === "already-answered", "reason should be 'already-answered', got " + second.reason);
        HC.assert(publishedDateFor(campId) === "2026-06-20",
          "published date must stay at the first response date, got " + publishedDateFor(campId));
      });

      // --- Persistence: enquiry survives a fresh load from the store. ---
      check("Enquiry persists in HC.store and can be looked up", function () {
        saveEnquiries([]);
        savePublishedOverrides({});
        var sub = submitQuickCheck(campId, GOOD_PARENT);
        var found = enquiryById(sub.enquiry.id);
        HC.assert(found && found.id === sub.enquiry.id, "enquiry should be retrievable from the store");
        var pend = pendingEnquiries();
        HC.assert(pend.length === 1 && pend[0].status === "pending", "one pending enquiry should be listed");
      });

      // --- Two different camps keep independent published dates. ---
      check("Updating one camp's published date does not affect another", function () {
        if (camps.length >= 2 && camps[1] && camps[1].id && camps[1].id !== campId) {
          saveEnquiries([]);
          savePublishedOverrides({});
          var otherId = camps[1].id;
          var sub = submitQuickCheck(campId, GOOD_PARENT);
          providerRespond(sub.enquiry.id, "still-running");
          HC.assert(publishedDateFor(campId) === TODAY_ISO, "responded camp should be refreshed");
          HC.assert(publishedDateFor(otherId) === baselinePublished(),
            "untouched camp should keep the baseline date");
        } else {
          // Only one camp available — assert the single-camp invariant instead.
          HC.assert(publishedDateFor(campId) !== undefined, "single-camp published date should resolve");
        }
      });

    } finally {
      // --- Restore the original store state. ---
      try { HC.store.set(ENQUIRIES_KEY, snapEnq); } catch (e) {}
      try { HC.store.set(PUBLISHED_KEY, snapPub); } catch (e) {}
      try { HC.store.set(LAST_PARENT_KEY, snapLast); } catch (e) {}
    }

    return { pass: pass, fail: fail, log: log };
  }

  /* ============================================================
   * 6. Register (idempotent + defensive via core).
   * ============================================================ */
  HC.registerFeature({
    id: "parent-quick-check",
    title: "Quick Check — is this still running?",
    side: "parent",
    icon: "🔎",
    summary: "Enter your details to ask a provider whether a holiday camp is still running. Their one-click reply emails you back and refreshes the camp's published date so everyone sees current info.",
    render: render,
    selfTest: selfTest
  });
})();
