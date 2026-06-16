/* HolidayCamp feature: parent-report-listing
 * ------------------------------------------------------------------
 * Replicates Happity's parent-side "Help fix this listing" behaviour.
 *
 * Evidence (Happity support corpus):
 *  - Article 8255758 "Parents & Carers FAQs — Giving us your feedback",
 *    section "I noticed a mistake with a listing, how can I report this?":
 *      "We always welcome and appreciate feedback about classes listed on
 *       Happity. If you notice an error or mistake, on the class provider's
 *       profile there is a link 'Help fix this listing'."
 *
 * So the PARENT-side route is: every provider/camp profile page exposes a
 * link/action labelled "Help fix this listing" which opens a small
 * report-an-error form. The form is PREFILLED with a reference to the
 * listing being reported (the provider id + a generated listing reference),
 * so the platform can locate exactly which listing the parent means.
 *
 * DISTINCT from the provider-side correction flow: a provider edits their
 * own listing in their dashboard (see provider-edit-camp / provider-profile-
 * content). THIS is an outside reader (parent/carer) flagging a suspected
 * error on a listing they do NOT own — it produces a *report* addressed to
 * the platform, not a direct edit. We assert that distinction in selfTest.
 *
 * Side: parent. Framed for SCHOOL-AGE HOLIDAY CAMPS, not baby classes.
 *
 * ACCEPTANCE CRITERION (asserted in selfTest, multiple cases):
 *   Every provider/camp page exposes a 'Help fix this listing' action that
 *   opens a report-an-error form prefilled with the listing reference.
 *   i.e. for EVERY live provider, listingAction(provider) returns an action
 *   labelled "Help fix this listing", and openReportForm(provider) returns a
 *   form whose `listingRef` is prefilled and resolves back to that provider.
 *   The flow is parent-origin (origin:"parent"), distinct from a provider
 *   self-edit (which would carry origin:"provider").
 *
 * Defensive: nothing throws at registration time; risky code is wrapped.
 * Persistence is via HC.store only (submitted reports), never global
 * localStorage.
 * ------------------------------------------------------------------ */
(function () {
  "use strict";

  if (typeof window === "undefined" || !window.HC || typeof window.HC.registerFeature !== "function") {
    // Core not present — fail silently rather than throwing.
    return;
  }
  var HC = window.HC;

  var STORE_KEY = "listing_reports";        // array of submitted report records
  var ACTION_LABEL = "Help fix this listing";
  // Clearly-mock platform feedback mailbox (this is a mockup, not Happity live).
  var FEEDBACK_EMAIL = "feedback@holidaycamp.example";

  /* What kinds of error a parent can flag. Framed for holiday camps. */
  var REASONS = [
    { key: "dates", label: "Wrong dates or week", hint: "The camp says it runs a week it doesn't (or has finished)." },
    { key: "price", label: "Wrong price", hint: "The price shown doesn't match what the camp actually charges." },
    { key: "ages", label: "Wrong age range", hint: "The 5–16 age range looks wrong for this camp." },
    { key: "venue", label: "Wrong venue or address", hint: "The location or address is out of date." },
    { key: "hours", label: "Wrong hours / drop-off times", hint: "The session times look incorrect." },
    { key: "closed", label: "Camp no longer running", hint: "This holiday club seems to have closed or moved away." },
    { key: "contact", label: "Wrong contact or booking link", hint: "The phone, email or booking link doesn't work." },
    { key: "other", label: "Something else", hint: "Any other mistake on this listing." }
  ];
  var REASON_KEYS = REASONS.map(function (r) { return r.key; });

  function isObj(x) { return x && typeof x === "object"; }
  function str(x) { return String(x == null ? "" : x); }

  /* ============================================================
   * Listing reference. Stable, derived from the provider id so a
   * report can always be resolved back to the listing it concerns.
   * ============================================================ */
  function listingRefFor(provider) {
    var id = provider && (provider.id || provider.slug || provider.name);
    if (!id) return null;
    // e.g. "LC-WALTHAM-FOREST-HAF" — human-readable, deterministic.
    var slug = str(id).toUpperCase().replace(/[^A-Z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    return "LC-" + slug;
  }

  // Resolve a listing reference back to a live provider (proves prefilled
  // ref is meaningful, not decorative).
  function providerForRef(ref) {
    var want = str(ref).trim();
    if (!want) return null;
    var providers = liveProviders();
    for (var i = 0; i < providers.length; i++) {
      if (listingRefFor(providers[i]) === want) return providers[i];
    }
    return null;
  }

  function liveProviders() {
    try {
      var p = HC.data.providers;
      return Array.isArray(p) ? p : [];
    } catch (e) { return []; }
  }

  /* ============================================================
   * 1. listingAction — the "Help fix this listing" action that
   *    EVERY provider/camp page exposes. Pure data; the page UI
   *    binds it. This is the heart of the acceptance criterion.
   * ============================================================ */
  function listingAction(provider) {
    if (!isObj(provider)) return null;
    var ref = listingRefFor(provider);
    if (!ref) return null;
    return {
      label: ACTION_LABEL,
      // Parent-origin: an outside reader flagging an error, NOT a self-edit.
      origin: "parent",
      providerId: provider.id || null,
      providerName: provider.name || "this camp",
      listingRef: ref,
      route: "/report-listing/" + ref,
      // The action's job is to OPEN the report form (prefilled).
      opens: "report-error-form"
    };
  }

  /* ============================================================
   * 2. openReportForm — the report-an-error form, PREFILLED with
   *    the listing reference. Returns a plain form model the UI
   *    renders; never throws.
   * ============================================================ */
  function openReportForm(provider) {
    var action = listingAction(provider);
    if (!action) {
      return { ok: false, reason: "no-listing", message: "We couldn't identify this listing." };
    }
    return {
      ok: true,
      title: ACTION_LABEL,
      intro: "Spotted a mistake on this camp's listing? Let us know and we'll get it checked and fixed.",
      origin: "parent",
      // PREFILLED, read-only reference to the exact listing being reported.
      listingRef: action.listingRef,
      providerId: action.providerId,
      providerName: action.providerName,
      to: FEEDBACK_EMAIL,
      // Editable fields the parent fills in.
      fields: {
        reason: "",          // one of REASON_KEYS
        details: "",         // free text describing the error
        correctValue: "",    // optional: what it should say instead
        reporterEmail: ""    // optional: so we can follow up
      },
      reasons: REASONS.slice()
    };
  }

  /* ============================================================
   * 3. buildReport — validate + compose the report addressed to
   *    the platform feedback mailbox. Never throws; returns {ok,...}.
   *
   *    opts:
   *      provider:     the live provider object (required)
   *      reason:       one of REASON_KEYS                  [required]
   *      details:      string describing the error         [required]
   *      correctValue: optional — what it should say
   *      reporterEmail:optional — parent's email for follow-up
   * ============================================================ */
  function buildReport(opts) {
    opts = isObj(opts) ? opts : {};
    var provider = isObj(opts.provider) ? opts.provider : null;
    var ref = provider ? listingRefFor(provider) : (opts.listingRef ? str(opts.listingRef) : null);
    if (!ref) {
      return { ok: false, reason: "no-listing", message: "We couldn't identify which listing to fix." };
    }

    var reason = str(opts.reason).trim();
    if (!reason || REASON_KEYS.indexOf(reason) === -1) {
      return { ok: false, reason: "no-reason", message: "Choose what's wrong with this listing." };
    }

    var details = str(opts.details).trim();
    if (!details) {
      return { ok: false, reason: "no-details", message: "Tell us a little about the mistake so we can fix it." };
    }

    var correctValue = str(opts.correctValue).trim();
    var reporterEmail = str(opts.reporterEmail).trim();
    var reasonDef = REASONS.filter(function (r) { return r.key === reason; })[0] || { label: reason };
    var providerName = (provider && provider.name) || opts.providerName || "this camp";

    var lines = [];
    lines.push("To: HolidayCamp Listings (" + FEEDBACK_EMAIL + ")");
    lines.push("");
    lines.push("Report: " + ACTION_LABEL);
    lines.push("Listing: " + providerName + " — ref " + ref);
    lines.push("Origin: Parent / carer (reader-reported)");
    lines.push("What's wrong: " + reasonDef.label);
    lines.push("");
    lines.push("Details:");
    lines.push(details);
    if (correctValue) {
      lines.push("");
      lines.push("Suggested correction: " + correctValue);
    }
    lines.push("");
    lines.push(reporterEmail
      ? "Reply to: " + reporterEmail
      : "Reporter did not leave contact details.");

    var report = {
      to: FEEDBACK_EMAIL,
      channel: "report",
      origin: "parent",
      // PREFILLED listing reference — resolvable back to the listing.
      listingRef: ref,
      providerId: (provider && provider.id) || opts.providerId || null,
      providerName: providerName,
      reason: reason,
      reasonLabel: reasonDef.label,
      details: details,
      correctValue: correctValue || null,
      reporterEmail: reporterEmail || null,
      subject: "Listing fix — " + reasonDef.label + " — ref " + ref,
      body: lines.join("\n")
    };

    return { ok: true, report: report };
  }

  // Submit = build + persist a record against the reports log.
  function submitReport(opts) {
    var built = buildReport(opts);
    if (!built.ok) return built;

    var record = {
      id: HC.util.uid(),
      origin: built.report.origin,
      listingRef: built.report.listingRef,
      providerId: built.report.providerId,
      providerName: built.report.providerName,
      reason: built.report.reason,
      reasonLabel: built.report.reasonLabel,
      details: built.report.details,
      correctValue: built.report.correctValue,
      reporterEmail: built.report.reporterEmail,
      subject: built.report.subject,
      body: built.report.body,
      status: "received",
      sentAt: nowIso()
    };

    try {
      var all = HC.store.get(STORE_KEY, []) || [];
      if (!Array.isArray(all)) all = [];
      all.unshift(record);
      HC.store.set(STORE_KEY, all);
    } catch (e) { /* mock persistence is best-effort */ }

    built.record = record;
    built.note = "Thanks — your report has been sent to our listings team. " +
      "We'll check it against the camp and fix the listing if needed.";
    return built;
  }

  function reportLog() {
    try {
      var all = HC.store.get(STORE_KEY, []) || [];
      return Array.isArray(all) ? all : [];
    } catch (e) { return []; }
  }

  function nowIso() {
    try { return new Date().toISOString(); } catch (e) { return "2026-06-16T00:00:00.000Z"; }
  }

  function esc(s) {
    return str(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
  function escAttr(s) { return esc(s).replace(/"/g, "&quot;"); }

  /* ============================================================
   * 4. UI — a provider/camp page with its "Help fix this listing"
   *    action, and the prefilled report form it opens.
   * ============================================================ */
  function render(mountEl) {
    try {
      var providers = liveProviders();
      if (!providers.length) {
        mountEl.innerHTML = '<p style="color:var(--muted,#808080)">No camp listings are loaded.</p>';
        return;
      }

      var pickerOpts = providers.map(function (p, i) {
        return '<option value="' + escAttr(p.id || String(i)) + '">' + esc(p.name || p.id) + '</option>';
      }).join("");

      mountEl.innerHTML =
        '<div style="font-family:\'Nunito Sans\',system-ui,sans-serif;color:var(--text,#383838)">' +
          '<p style="font-size:14px;margin:0 0 10px">Every camp listing carries a small <strong>“' + esc(ACTION_LABEL) +
            '”</strong> link. If you spot a mistake on a listing — wrong dates, price or age range — you can flag it for us to fix. ' +
            'This is for <strong>parents and carers</strong>; camp providers edit their own listing from their dashboard.</p>' +
          '<label style="display:block;font-size:12.5px;font-weight:700;color:var(--purple,#603488);margin:0 0 4px">Preview a camp page</label>' +
          '<select id="rlPick" style="width:100%;padding:9px 10px;border:1.5px solid var(--line,#E6E6E6);border-radius:10px;font-size:14px;margin-bottom:14px">' +
            pickerOpts +
          '</select>' +
          '<div id="rlPage"></div>' +
          '<div id="rlForm" style="margin-top:14px"></div>' +
          '<div id="rlLog" style="margin-top:16px"></div>' +
        '</div>';

      var pick = mountEl.querySelector("#rlPick");
      pick.addEventListener("change", function () { drawPage(mountEl); });
      drawPage(mountEl);
      drawLog(mountEl);
    } catch (e) {
      mountEl.innerHTML = '<p style="color:#9a1f5e">Couldn\'t render this feature: ' +
        esc(e && e.message ? e.message : String(e)) + '</p>';
    }
  }

  function selectedProvider(mountEl) {
    var pick = mountEl.querySelector("#rlPick");
    var id = pick ? pick.value : null;
    var providers = liveProviders();
    return providers.filter(function (p) { return (p.id || "") === id; })[0] || providers[0] || null;
  }

  function drawPage(mountEl) {
    var provider = selectedProvider(mountEl);
    var host = mountEl.querySelector("#rlPage");
    if (!host) return;
    if (!provider) { host.innerHTML = ""; return; }

    var action = listingAction(provider);
    host.innerHTML =
      '<div style="border:1.5px solid var(--line,#E6E6E6);border-radius:14px;padding:14px 16px;background:#fff">' +
        '<div style="font-family:\'Quicksand\',system-ui,sans-serif;font-weight:700;font-size:16px;color:var(--purple,#603488)">' +
          esc(provider.name || "Camp") + '</div>' +
        '<div style="font-size:12.5px;color:var(--muted,#808080);margin:2px 0 10px">' +
          esc(provider.area || "Waltham Forest") + ' · ages ' + esc(provider.ageLabel || "5–16") +
          ' · listing ref <strong>' + esc(action.listingRef) + '</strong></div>' +
        '<button class="hc-btn hc-btn-ghost" id="rlOpen" type="button" style="font-size:11.5px">⚑ ' +
          esc(ACTION_LABEL) + '</button>' +
      '</div>';

    var openBtn = host.querySelector("#rlOpen");
    if (openBtn) openBtn.addEventListener("click", function () { drawForm(mountEl, provider); });
  }

  function drawForm(mountEl, provider) {
    var host = mountEl.querySelector("#rlForm");
    if (!host) return;
    var form = openReportForm(provider);
    if (!form.ok) { host.innerHTML = '<p style="color:#9a1f5e">' + esc(form.message) + '</p>'; return; }

    var reasonOpts = '<option value="">— choose —</option>' + form.reasons.map(function (r) {
      return '<option value="' + escAttr(r.key) + '">' + esc(r.label) + '</option>';
    }).join("");

    host.innerHTML =
      '<div style="border:1.5px solid var(--purple-tint,#F0E8F4);border-radius:14px;padding:14px 16px;background:var(--purple-tint,#F0E8F4)">' +
        '<div style="font-family:\'Quicksand\',system-ui,sans-serif;font-weight:700;font-size:15px;color:var(--purple,#603488);margin:0 0 2px">' +
          esc(form.title) + '</div>' +
        '<p style="font-size:12.5px;margin:0 0 10px;color:var(--text,#383838)">' + esc(form.intro) + '</p>' +
        '<div style="font-size:12px;color:var(--muted,#808080);margin:0 0 10px">Reporting: <strong>' + esc(form.providerName) +
          '</strong> — listing ref <strong>' + esc(form.listingRef) + '</strong> (prefilled)</div>' +
        '<label style="display:block;font-size:12px;font-weight:700;margin:0 0 3px">What\'s wrong?</label>' +
        '<select id="rlReason" style="width:100%;padding:8px 10px;border:1.5px solid var(--line,#E6E6E6);border-radius:9px;font-size:13.5px;margin-bottom:8px;background:#fff">' +
          reasonOpts +
        '</select>' +
        '<label style="display:block;font-size:12px;font-weight:700;margin:0 0 3px">Details</label>' +
        '<textarea id="rlDetails" rows="3" placeholder="What did you notice?" style="width:100%;padding:8px 10px;border:1.5px solid var(--line,#E6E6E6);border-radius:9px;font-size:13.5px;margin-bottom:8px;resize:vertical"></textarea>' +
        '<label style="display:block;font-size:12px;font-weight:700;margin:0 0 3px">What should it say? (optional)</label>' +
        '<input id="rlCorrect" type="text" placeholder="e.g. summer week runs 28 Jul–1 Aug" style="width:100%;padding:8px 10px;border:1.5px solid var(--line,#E6E6E6);border-radius:9px;font-size:13.5px;margin-bottom:8px">' +
        '<label style="display:block;font-size:12px;font-weight:700;margin:0 0 3px">Your email (optional, so we can follow up)</label>' +
        '<input id="rlEmail" type="email" placeholder="you@example.com" style="width:100%;padding:8px 10px;border:1.5px solid var(--line,#E6E6E6);border-radius:9px;font-size:13.5px;margin-bottom:10px">' +
        '<button class="hc-btn" id="rlSubmit" type="button">Send report</button>' +
        '<div id="rlMsg" style="font-size:12.5px;margin-top:8px"></div>' +
      '</div>';

    var submit = host.querySelector("#rlSubmit");
    if (submit) submit.addEventListener("click", function () {
      var out = submitReport({
        provider: provider,
        reason: (host.querySelector("#rlReason") || {}).value,
        details: (host.querySelector("#rlDetails") || {}).value,
        correctValue: (host.querySelector("#rlCorrect") || {}).value,
        reporterEmail: (host.querySelector("#rlEmail") || {}).value
      });
      var msg = host.querySelector("#rlMsg");
      if (out.ok) {
        if (msg) { msg.style.color = "#2f7d4f"; msg.textContent = "✓ " + out.note; }
        HC.util.toast("Report sent — ref " + out.record.listingRef);
        drawLog(mountEl);
      } else {
        if (msg) { msg.style.color = "#9a1f5e"; msg.textContent = "✗ " + out.message; }
      }
    });
  }

  function drawLog(mountEl) {
    var host = mountEl.querySelector("#rlLog");
    if (!host) return;
    var log = reportLog();
    if (!log.length) { host.innerHTML = ""; return; }
    host.innerHTML =
      '<div style="font-family:\'Quicksand\',system-ui,sans-serif;font-weight:700;color:var(--magenta,#F82488);' +
        'text-transform:uppercase;letter-spacing:.5px;font-size:11.5px;margin:0 0 6px">Reports submitted</div>' +
      log.slice(0, 6).map(function (r) {
        return '<div style="font-size:12.5px;border-bottom:1px solid var(--line,#E6E6E6);padding:6px 0">' +
          '<strong>' + esc(r.providerName) + '</strong> — ' + esc(r.reasonLabel) +
          ' <span style="color:var(--muted,#808080)">(' + esc(r.listingRef) + ')</span></div>';
      }).join("");
  }

  /* ============================================================
   * 5. selfTest — exercises the LOGIC and asserts the acceptance
   *    criterion across multiple cases.
   * ============================================================ */
  function selfTest() {
    var pass = 0, fail = 0, log = [];
    function check(label, fn) {
      try { fn(); pass += 1; log.push("✓ " + label); }
      catch (e) { fail += 1; log.push("✗ " + label + " — " + (e && e.message ? e.message : String(e))); }
    }

    var providers = liveProviders();

    // 1. There is live camp data to test against.
    check("Live camp listings are present", function () {
      HC.assert(providers.length > 0, "expected at least one provider, got " + providers.length);
    });

    // 2. ACCEPTANCE: EVERY provider/camp page exposes a "Help fix this listing"
    //    action that opens a report form prefilled with the listing reference,
    //    and that reference resolves back to the same provider.
    check("Every camp page exposes a prefilled 'Help fix this listing' action", function () {
      HC.assert(providers.length > 0, "no providers to check");
      for (var i = 0; i < providers.length; i++) {
        var p = providers[i];
        var action = listingAction(p);
        HC.assert(action, "no action for provider " + (p && p.id));
        HC.assert(action.label === ACTION_LABEL,
          "action label should be '" + ACTION_LABEL + "', got '" + action.label + "'");
        HC.assert(action.opens === "report-error-form", "action should open the report form");
        HC.assert(action.listingRef, "action must carry a listing reference for " + p.id);

        var form = openReportForm(p);
        HC.assert(form.ok, "form should open for " + p.id);
        HC.assert(form.title === ACTION_LABEL, "form title should be the action label");
        // PREFILLED reference, matching the action's reference.
        HC.assert(form.listingRef === action.listingRef,
          "form listingRef should be prefilled to match the action (" + p.id + ")");
        // And the prefilled reference resolves back to THIS provider.
        var resolved = providerForRef(form.listingRef);
        HC.assert(resolved && resolved.id === p.id,
          "prefilled listingRef must resolve back to " + p.id);
      }
    });

    // 3. DISTINCT from the provider-side correction flow: this is parent-origin
    //    (a reader flagging), not a provider self-edit.
    check("Report flow is parent-origin, distinct from provider self-edit", function () {
      var p = providers[0];
      var action = listingAction(p);
      HC.assert(action.origin === "parent", "action origin should be 'parent', got " + action.origin);
      var built = buildReport({ provider: p, reason: "price", details: "Price looks wrong." });
      HC.assert(built.ok, "report should build");
      HC.assert(built.report.origin === "parent",
        "report origin should be 'parent' (reader-reported), got " + built.report.origin);
      HC.assert(built.report.origin !== "provider", "must NOT be a provider self-edit");
    });

    // 4. Listing references are stable and unique per provider.
    check("Listing references are stable and unique", function () {
      var seen = {};
      for (var i = 0; i < providers.length; i++) {
        var ref = listingRefFor(providers[i]);
        HC.assert(ref, "no ref for " + providers[i].id);
        // stable: computing twice gives the same value
        HC.assert(ref === listingRefFor(providers[i]), "ref should be deterministic for " + providers[i].id);
        HC.assert(!seen[ref], "duplicate listing ref " + ref);
        seen[ref] = true;
      }
    });

    // 5. buildReport validates: needs a listing, a reason, and details.
    check("buildReport rejects missing reason and missing details", function () {
      var p = providers[0];
      var noReason = buildReport({ provider: p, details: "Something is off." });
      HC.assert(!noReason.ok && noReason.reason === "no-reason", "should reject when no reason chosen");
      var badReason = buildReport({ provider: p, reason: "not-a-real-reason", details: "x" });
      HC.assert(!badReason.ok && badReason.reason === "no-reason", "should reject an unknown reason");
      var noDetails = buildReport({ provider: p, reason: "dates", details: "   " });
      HC.assert(!noDetails.ok && noDetails.reason === "no-details", "should reject empty details");
      var noListing = buildReport({ reason: "dates", details: "x" });
      HC.assert(!noListing.ok && noListing.reason === "no-listing", "should reject when no listing identified");
    });

    // 6. A valid report composes a message addressed to the platform with the
    //    prefilled listing reference embedded in the body and subject.
    check("Valid report composes a message carrying the listing reference", function () {
      var p = providers[0];
      var built = buildReport({
        provider: p, reason: "dates",
        details: "The summer week shown has already finished.",
        correctValue: "Runs 28 Jul–1 Aug 2026",
        reporterEmail: "parent@example.com"
      });
      HC.assert(built.ok, "valid report should build");
      var ref = listingRefFor(p);
      HC.assert(built.report.listingRef === ref, "report should carry the listing ref");
      HC.assert(built.report.body.indexOf(ref) !== -1, "ref should appear in the body");
      HC.assert(built.report.subject.indexOf(ref) !== -1, "ref should appear in the subject");
      HC.assert(built.report.to === FEEDBACK_EMAIL, "report should be addressed to the platform mailbox");
      HC.assert(built.report.body.indexOf("parent@example.com") !== -1, "follow-up email should be included");
      HC.assert(built.report.body.indexOf("28 Jul") !== -1, "suggested correction should be included");
    });

    // 7. submitReport persists via HC.store and the record is retrievable.
    check("submitReport persists a retrievable record", function () {
      var p = providers[0];
      var before = reportLog().length;
      var out = submitReport({ provider: p, reason: "venue", details: "Venue moved last term." });
      HC.assert(out.ok, "submit should succeed");
      HC.assert(out.record && out.record.id, "a record with an id should be returned");
      HC.assert(out.record.status === "received", "record status should be 'received'");
      var after = reportLog();
      HC.assert(after.length === before + 1, "log should grow by one (" + before + " -> " + after.length + ")");
      HC.assert(after[0].id === out.record.id, "newest record should be at the front");
      HC.assert(after[0].listingRef === listingRefFor(p), "persisted record should keep the listing ref");
    });

    return { pass: pass, fail: fail, log: log };
  }

  /* ---------- register ---------- */
  HC.registerFeature({
    id: "parent-report-listing",
    title: "Help fix this listing",
    side: "parent",
    icon: "⚑",
    summary: "Every camp listing carries a parent-facing 'Help fix this listing' link that opens a " +
      "report-an-error form prefilled with the listing reference — distinct from the provider's own edit flow.",
    render: render,
    selfTest: selfTest
  });
})();
