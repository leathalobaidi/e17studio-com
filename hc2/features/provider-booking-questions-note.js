/* HolidayCamp feature — provider-booking-questions-note
 *
 * Allergy/medical info captured at booking (no bespoke questions)  (provider side)
 *
 * Replicates Happity support article 6172207 ("Can I add questions to the
 * bookings process?"). Evidence highlights:
 *   - At checkout, parents are asked for their CONTACT info and info on the
 *     CHILD(REN) attending, plus "anything else you might need to know
 *     (known allergies, medical conditions)".
 *   - "Providers are not able to add bespoke questions." (Standard fields only.)
 *   - "You can however add links to your bespoke confirmation email and so if
 *     you have online forms that they need to complete, then you can add those
 *     in." — the documented escape hatch for extra data collection.
 *
 * Framed for SCHOOL-AGE HOLIDAY CAMPS (not baby classes): the booking form
 * collects a FIXED set of standard fields about the parent/guardian and each
 * child, including an allergy/medical free-text field — but the provider CANNOT
 * add custom questions to the checkout. Instead the provider manages a list of
 * LINKS (e.g. a consent form, kit list, medical-details Google Form) that get
 * appended to the bespoke confirmation email so families can complete them.
 *
 * ACCEPTANCE CRITERION (asserted in selfTest):
 *   Standard child + allergy/medical fields are collected; provider can add
 *   links via the custom email — and the provider CANNOT add bespoke questions
 *   to the booking form itself.
 *
 * Self-contained, defensive, no imports/exports. Calls HC.registerFeature.
 */
(function () {
  "use strict";

  // Defensive: never throw at module load if HC isn't present.
  if (typeof window === "undefined" || !window.HC || typeof window.HC.registerFeature !== "function") {
    if (typeof console !== "undefined" && console.warn) {
      console.warn("[HC] provider-booking-questions-note: HC core not found; skipping registration.");
    }
    return;
  }

  var HC = window.HC;

  var STORE_KEY = "provider_booking_email_links"; // persisted custom-email links

  /* ---------------- the FIXED booking schema (no bespoke questions) ----------------
   *
   * These are the ONLY fields the checkout collects. Providers cannot add to
   * this list — that's the whole point of the article. We model it as data so
   * the UI and the self-test share one source of truth.
   */

  // Standard PARENT / GUARDIAN contact fields.
  var PARENT_FIELDS = [
    { key: "parentName",  label: "Parent / guardian name", type: "text",  required: true },
    { key: "parentEmail", label: "Email address",          type: "email", required: true },
    { key: "parentPhone", label: "Mobile number",          type: "tel",   required: true }
  ];

  // Standard CHILD fields, collected per child attending. The allergy/medical
  // free-text field is the headline of the evidence ("known allergies, medical
  // conditions").
  var CHILD_FIELDS = [
    { key: "childName",        label: "Child's name",                 type: "text",     required: true,  group: "child" },
    { key: "childDob",         label: "Date of birth",                type: "date",     required: true,  group: "child" },
    { key: "childSchoolYear",  label: "School year",                  type: "text",     required: false, group: "child" },
    { key: "emergencyContact", label: "Emergency contact (name & no.)", type: "text",   required: true,  group: "emergency" },
    // The allergy/medical capture — required, free text, always present.
    { key: "allergiesMedical", label: "Allergies / medical conditions / dietary needs",
      type: "textarea", required: true, group: "medical",
      help: "Tell us anything we need to know to keep your child safe — allergies, medical conditions, medication, dietary needs. Leave 'None' if not applicable." }
  ];

  /* ---------------- pure logic (testable, DOM-free) ---------------- */

  function asText(v) {
    return typeof v === "string" ? v : (v == null ? "" : String(v));
  }

  // The full, immutable booking schema the checkout uses.
  function getBookingSchema() {
    return {
      parent: PARENT_FIELDS.slice(),
      child: CHILD_FIELDS.slice(),
      // Providers may NOT add bespoke questions. This is a hard product rule,
      // surfaced as a flag the UI/tests can rely on.
      allowsBespokeQuestions: false
    };
  }

  // Does the schema collect an allergy/medical field? (acceptance criterion)
  function collectsAllergyMedical() {
    return CHILD_FIELDS.some(function (f) {
      return f.group === "medical" || /allerg|medical/i.test(f.key) || /allerg|medical/i.test(f.label);
    });
  }

  // Does the schema collect the standard CHILD identity fields?
  function collectsStandardChildFields() {
    var names = CHILD_FIELDS.map(function (f) { return f.key; });
    return names.indexOf("childName") !== -1 && names.indexOf("childDob") !== -1;
  }

  // The product RULE: a provider attempting to add a bespoke checkout question
  // is rejected — bookings collect standard fields only. Returns a structured
  // result mirroring the article's wording, and points to the email-links
  // workaround.
  function tryAddBespokeQuestion(questionText) {
    return {
      accepted: false,
      reason: "Bespoke booking questions aren't available. The checkout " +
        "collects a standard set of details (your contact info, each child's " +
        "details, and an allergies / medical conditions field). To gather " +
        "anything else, add a link to your confirmation email instead.",
      attempted: asText(questionText),
      workaround: "email_link"
    };
  }

  /* --------- custom confirmation-email links (the documented workaround) ---------
   *
   * A provider can attach links (consent form, kit list, medical-details form…)
   * to their bespoke confirmation email. We validate + persist these.
   */

  // Loose URL validation: accept http(s) URLs (and bare domains we normalise).
  function normaliseUrl(raw) {
    var u = asText(raw).trim();
    if (!u) return null;
    if (/^https?:\/\//i.test(u)) return u;
    // bare domain or www. — assume https
    if (/^(www\.)?[a-z0-9][a-z0-9.-]*\.[a-z]{2,}(\/.*)?$/i.test(u)) return "https://" + u;
    return null; // anything else (e.g. "javascript:", plain words) is invalid
  }

  function readLinks() {
    try {
      var s = HC.store.get(STORE_KEY, []);
      return Array.isArray(s) ? s : [];
    } catch (e) { return []; }
  }
  function writeLinks(list) {
    try { return HC.store.set(STORE_KEY, Array.isArray(list) ? list : []); }
    catch (e) { return false; }
  }

  // Add a link to the confirmation email. Returns { ok, link?, error? }.
  function addEmailLink(label, url) {
    var clean = normaliseUrl(url);
    var text = asText(label).trim();
    if (!text) return { ok: false, error: "Give the link a label so families know what it is." };
    if (!clean) return { ok: false, error: "That doesn't look like a valid web link (use https://…)." };
    var link = {
      id: (function () { try { return HC.util.uid(); } catch (e) { return "lnk_" + Date.now(); } })(),
      label: text,
      url: clean,
      at: Date.now()
    };
    var list = readLinks();
    list.push(link);
    if (list.length > 50) list = list.slice(-50); // keep the mock store small
    writeLinks(list);
    return { ok: true, link: link };
  }

  function removeEmailLink(id) {
    var list = readLinks();
    var next = list.filter(function (l) { return l.id !== id; });
    var removed = next.length !== list.length;
    if (removed) writeLinks(next);
    return removed;
  }

  // Build a preview of the confirmation email body, showing how the provider's
  // links get appended after the standard booking summary.
  function buildConfirmationEmailPreview(links) {
    var l = Array.isArray(links) ? links : readLinks();
    var lines = [
      "Hi {parent_name},",
      "",
      "Thanks for booking {camp_name}! We've got {child_name} down for {dates}.",
      "We've noted what you told us about allergies / medical needs.",
      ""
    ];
    if (l.length) {
      lines.push("Before camp, please complete the following:");
      for (var i = 0; i < l.length; i++) {
        lines.push("• " + l[i].label + ": " + l[i].url);
      }
      lines.push("");
    }
    lines.push("See you soon!");
    return lines.join("\n");
  }

  /* ---------------- validation of a submitted booking ---------------- */

  // Validate a parent's submitted booking against the fixed schema. Used to
  // demonstrate that the allergy/medical field is actually enforced.
  function validateBooking(submission) {
    var s = (submission && typeof submission === "object") ? submission : {};
    var missing = [];
    var all = PARENT_FIELDS.concat(CHILD_FIELDS);
    for (var i = 0; i < all.length; i++) {
      var f = all[i];
      if (!f.required) continue;
      var val = asText(s[f.key]).trim();
      if (!val) missing.push(f.label);
    }
    return { valid: missing.length === 0, missing: missing };
  }

  /* ---------------- UI ---------------- */

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

  function fieldRowHtml(f) {
    var req = f.required
      ? '<span style="color:var(--magenta,#F82488);font-weight:700">*</span>'
      : '<span style="color:var(--muted,#808080);font-size:11px"> (optional)</span>';
    var medical = (f.group === "medical");
    return '<div style="padding:8px 10px;border:1px solid ' +
        (medical ? "#F4CFE0" : "var(--line,#E6E6E6)") + ";border-radius:10px;background:" +
        (medical ? "#FFF6FA" : "#fff") + ';margin:0 0 8px">' +
        '<div style="font-size:13px;font-weight:700;color:var(--text,#383838)">' +
          esc(f.label) + " " + req +
          (medical ? ' <span style="font-family:Quicksand,system-ui,sans-serif;font-size:10.5px;color:#9a1f5e">SAFETY</span>' : "") +
        "</div>" +
        (f.help ? '<div style="font-size:11.5px;color:var(--muted,#808080);margin-top:2px">' + esc(f.help) + "</div>" : "") +
      "</div>";
  }

  function renderLinks(host) {
    var links = readLinks();
    var rows = "";
    if (!links.length) {
      rows = '<p style="font-size:12.5px;color:var(--muted,#808080);margin:6px 0">' +
        "No links yet. Add a kit list, consent form or medical-details form below.</p>";
    } else {
      for (var i = 0; i < links.length; i++) {
        var lk = links[i];
        rows += '<div style="display:flex;align-items:center;gap:10px;padding:8px 10px;border:1px solid var(--line,#E6E6E6);' +
            'border-radius:10px;margin:0 0 6px">' +
          '<div style="flex:1;min-width:0">' +
            '<div style="font-size:13px;font-weight:700;color:var(--purple,#603488)">' + esc(lk.label) + "</div>" +
            '<div style="font-size:11.5px;color:var(--muted,#808080);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' +
              esc(lk.url) + "</div>" +
          "</div>" +
          '<button class="hc-btn hc-btn-ghost" type="button" data-bqn-remove="' + esc(lk.id) + '" ' +
            'style="font-size:11px;padding:5px 10px">Remove</button>' +
        "</div>";
      }
    }
    host.innerHTML = rows;
  }

  function renderEmailPreview(host) {
    host.textContent = buildConfirmationEmailPreview();
  }

  function render(mountEl) {
    try {
      if (!mountEl) return;
      mountEl.innerHTML = "";

      // ----- Intro / the product rule -----
      var intro = el("div", null,
        '<p style="font-size:14px;color:var(--text,#383838);margin:0 0 6px">' +
          "Your booking form collects a <strong>standard set of details</strong> from every " +
          "family — your contact info, each child's details, and an " +
          "<strong>allergies / medical conditions</strong> field. " +
          "You <strong>can't add bespoke questions</strong> to the checkout — but you " +
          "<strong>can add links</strong> to your confirmation email to gather anything else.</p>");
      mountEl.appendChild(intro);

      // ----- The fixed booking schema preview -----
      var schemaWrap = el("div", {
        style: "display:grid;grid-template-columns:1fr 1fr;gap:14px;margin:12px 0 16px"
      });
      var parentHtml = PARENT_FIELDS.map(fieldRowHtml).join("");
      var childHtml = CHILD_FIELDS.map(fieldRowHtml).join("");
      schemaWrap.innerHTML =
        '<div>' +
          '<div style="font-family:Quicksand,system-ui,sans-serif;font-weight:700;color:var(--purple,#603488);margin-bottom:8px">' +
            "Parent / guardian</div>" + parentHtml +
        "</div>" +
        '<div>' +
          '<div style="font-family:Quicksand,system-ui,sans-serif;font-weight:700;color:var(--purple,#603488);margin-bottom:8px">' +
            "Each child</div>" + childHtml +
        "</div>";
      mountEl.appendChild(schemaWrap);

      // ----- "Try to add a bespoke question" — shows the rule in action -----
      var bespoke = el("div", {
        style: "border:1.5px solid #F4CFE0;border-radius:14px;padding:12px 14px;background:#FFF6FA;margin:0 0 16px"
      });
      bespoke.innerHTML =
        '<div style="font-family:Quicksand,system-ui,sans-serif;font-weight:700;color:#9a1f5e">Add a custom booking question?</div>' +
        '<div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap">' +
          '<input id="bqnQuestion" type="text" placeholder="e.g. Can your child swim?" ' +
            'style="flex:1;min-width:180px;padding:8px 10px;border:1px solid var(--line,#E6E6E6);border-radius:8px;font-size:13px">' +
          '<button class="hc-btn" id="bqnTryAdd" type="button">Add question</button>' +
        "</div>" +
        '<div id="bqnQuestionMsg" style="margin-top:8px;font-size:12.5px"></div>';
      mountEl.appendChild(bespoke);

      var qMsg = bespoke.querySelector("#bqnQuestionMsg");
      var tryAddBtn = bespoke.querySelector("#bqnTryAdd");
      if (tryAddBtn) {
        tryAddBtn.addEventListener("click", function () {
          try {
            var q = (bespoke.querySelector("#bqnQuestion") || {}).value || "";
            var res = tryAddBespokeQuestion(q);
            qMsg.innerHTML = '<span style="color:#9a1f5e;font-weight:700">✕ Not available. </span>' +
              '<span style="color:var(--text,#383838)">' + esc(res.reason) + "</span>";
            try { HC.util.toast("Bespoke questions aren't available — use email links"); } catch (e) {}
          } catch (e) {
            qMsg.textContent = "Could not process: " + (e && e.message ? e.message : String(e));
          }
        });
      }

      // ----- Custom confirmation-email links (the workaround) -----
      var linksCard = el("div", {
        style: "border-top:1px solid var(--line,#E6E6E6);padding-top:14px"
      });
      linksCard.innerHTML =
        '<div style="font-family:Quicksand,system-ui,sans-serif;font-weight:700;color:var(--purple,#603488);margin-bottom:4px">' +
          "Links in your confirmation email</div>" +
        '<p style="font-size:12.5px;color:var(--muted,#808080);margin:0 0 10px">' +
          "Add online forms families should complete before camp (consent, kit list, " +
          "a fuller medical form). These are appended to your bespoke confirmation email.</p>" +
        '<div id="bqnLinks"></div>' +
        '<div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap">' +
          '<input id="bqnLinkLabel" type="text" placeholder="Link label (e.g. Medical details form)" ' +
            'style="flex:1;min-width:140px;padding:8px 10px;border:1px solid var(--line,#E6E6E6);border-radius:8px;font-size:13px">' +
          '<input id="bqnLinkUrl" type="text" placeholder="https://…" ' +
            'style="flex:1;min-width:140px;padding:8px 10px;border:1px solid var(--line,#E6E6E6);border-radius:8px;font-size:13px">' +
          '<button class="hc-btn" id="bqnAddLink" type="button">Add link</button>' +
        "</div>" +
        '<div id="bqnLinkMsg" style="margin-top:6px;font-size:12px;color:#9a1f5e"></div>' +
        '<div style="font-family:Quicksand,system-ui,sans-serif;font-weight:700;color:var(--purple,#603488);margin:16px 0 6px">' +
          "Confirmation email preview</div>" +
        '<pre id="bqnEmail" style="white-space:pre-wrap;font-family:ui-monospace,Menlo,monospace;font-size:12px;' +
          'background:#FAF8FC;border:1px solid var(--line,#E6E6E6);border-radius:10px;padding:12px;margin:0;color:var(--text,#383838)"></pre>';
      mountEl.appendChild(linksCard);

      var linksHost = linksCard.querySelector("#bqnLinks");
      var emailHost = linksCard.querySelector("#bqnEmail");
      var linkMsg = linksCard.querySelector("#bqnLinkMsg");

      function refresh() {
        renderLinks(linksHost);
        renderEmailPreview(emailHost);
      }
      refresh();

      var addLinkBtn = linksCard.querySelector("#bqnAddLink");
      if (addLinkBtn) {
        addLinkBtn.addEventListener("click", function () {
          try {
            var label = (linksCard.querySelector("#bqnLinkLabel") || {}).value || "";
            var url = (linksCard.querySelector("#bqnLinkUrl") || {}).value || "";
            var res = addEmailLink(label, url);
            if (res.ok) {
              linkMsg.style.color = "#2f7d4f";
              linkMsg.textContent = "✓ Link added to your confirmation email.";
              var lbl = linksCard.querySelector("#bqnLinkLabel"); if (lbl) lbl.value = "";
              var u = linksCard.querySelector("#bqnLinkUrl"); if (u) u.value = "";
              refresh();
              try { HC.util.toast("Link added to confirmation email"); } catch (e) {}
            } else {
              linkMsg.style.color = "#9a1f5e";
              linkMsg.textContent = "✕ " + res.error;
            }
          } catch (e) {
            linkMsg.textContent = "Could not add link: " + (e && e.message ? e.message : String(e));
          }
        });
      }

      // Delegated remove handling within this card.
      linksCard.addEventListener("click", function (e) {
        var btn = e.target && e.target.closest ? e.target.closest("[data-bqn-remove]") : null;
        if (!btn) return;
        try {
          removeEmailLink(btn.getAttribute("data-bqn-remove"));
          refresh();
        } catch (err) { /* defensive */ }
      });
    } catch (e) {
      try {
        mountEl.innerHTML = '<p style="color:#9a1f5e">Booking-questions note failed to render: ' +
          esc(e && e.message ? e.message : String(e)) + "</p>";
      } catch (e2) { /* give up quietly */ }
    }
  }

  /* ---------------- selfTest ---------------- */

  function selfTest() {
    var pass = 0, fail = 0, log = [];
    function check(label, fn) {
      try { fn(); pass += 1; log.push("✓ " + label); }
      catch (e) { fail += 1; log.push("✗ " + label + " — " + (e && e.message ? e.message : String(e))); }
    }

    // Snapshot + restore persisted links so the test is idempotent.
    var snapshot = readLinks();

    // ===== ACCEPTANCE CRITERION (part 1) =====
    // Standard child + allergy/medical fields ARE collected.

    check("Booking schema collects standard CHILD fields (name + DOB)", function () {
      HC.assert(collectsStandardChildFields() === true,
        "schema must collect childName and childDob");
      var schema = getBookingSchema();
      HC.assert(Array.isArray(schema.child) && schema.child.length >= 3,
        "child schema should have several standard fields");
    });

    check("Booking schema collects an ALLERGY / MEDICAL field", function () {
      HC.assert(collectsAllergyMedical() === true,
        "schema must collect allergies/medical conditions");
      var med = CHILD_FIELDS.filter(function (f) { return f.group === "medical"; })[0];
      HC.assert(med && med.required === true,
        "the allergy/medical field must be present and required");
      HC.assert(/allerg/i.test(med.label) && /medical/i.test(med.label),
        "the medical field label must name allergies AND medical conditions");
    });

    check("Booking schema also collects standard PARENT contact fields", function () {
      var schema = getBookingSchema();
      var keys = schema.parent.map(function (f) { return f.key; });
      HC.assert(keys.indexOf("parentName") !== -1, "must collect parent name");
      HC.assert(keys.indexOf("parentEmail") !== -1, "must collect parent email");
      HC.assert(keys.indexOf("parentPhone") !== -1, "must collect parent phone");
    });

    // ===== ACCEPTANCE CRITERION (part 2) =====
    // Provider CANNOT add bespoke questions (this is the article's core rule).

    check("Provider CANNOT add a bespoke booking question", function () {
      var schema = getBookingSchema();
      HC.assert(schema.allowsBespokeQuestions === false,
        "schema must declare bespoke questions are not allowed");
      var res = tryAddBespokeQuestion("Can your child swim 25m?");
      HC.assert(res.accepted === false, "adding a bespoke question must be rejected");
      HC.assert(/bespoke|standard/i.test(res.reason),
        "rejection must explain the standard-fields-only rule");
      HC.assert(res.workaround === "email_link",
        "rejection must point to the email-link workaround");
    });

    check("Adding a bespoke question does NOT mutate the booking schema", function () {
      var before = getBookingSchema().child.length;
      tryAddBespokeQuestion("Dietary preference?");
      tryAddBespokeQuestion("Favourite colour?");
      var after = getBookingSchema().child.length;
      HC.assert(before === after, "child schema length must be unchanged (no bespoke fields added)");
    });

    // ===== ACCEPTANCE CRITERION (part 3) =====
    // Provider CAN add links via the custom confirmation email.

    check("Provider CAN add a valid link to the confirmation email", function () {
      writeLinks([]); // clean slate for deterministic assertions
      var res = addEmailLink("Medical details form", "https://forms.gle/abc123");
      HC.assert(res.ok === true, "a valid link should be accepted: " + (res.error || ""));
      HC.assert(res.link && res.link.url === "https://forms.gle/abc123",
        "saved link must keep the URL");
      var list = readLinks();
      HC.assert(list.length === 1, "link should be persisted (got " + list.length + ")");
    });

    check("A bare domain is normalised to https://", function () {
      writeLinks([]);
      var res = addEmailLink("Kit list", "www.mycamp.co.uk/kit");
      HC.assert(res.ok === true, "bare domain should be accepted");
      HC.assert(/^https:\/\//.test(res.link.url),
        "URL must be normalised to https, got " + res.link.url);
    });

    check("Invalid links and blank labels are rejected", function () {
      writeLinks([]);
      var noLabel = addEmailLink("", "https://ok.com");
      HC.assert(noLabel.ok === false && /label/i.test(noLabel.error),
        "blank label must be rejected");
      var badUrl = addEmailLink("Bad", "not a url");
      HC.assert(badUrl.ok === false && /link/i.test(badUrl.error),
        "non-URL must be rejected");
      var jsUrl = addEmailLink("XSS", "javascript:alert(1)");
      HC.assert(jsUrl.ok === false, "javascript: scheme must be rejected");
      HC.assert(readLinks().length === 0, "no invalid links should have persisted");
    });

    check("Confirmation email preview includes the provider's links", function () {
      writeLinks([]);
      addEmailLink("Consent form", "https://forms.gle/consent");
      addEmailLink("Kit list", "https://mycamp.co.uk/kit");
      var body = buildConfirmationEmailPreview();
      HC.assert(typeof body === "string" && body.length > 0, "preview must be a non-empty string");
      HC.assert(body.indexOf("Consent form") !== -1, "preview must list the Consent form label");
      HC.assert(body.indexOf("https://forms.gle/consent") !== -1, "preview must include the consent URL");
      HC.assert(body.indexOf("Kit list") !== -1, "preview must list the Kit list label");
      // and it should reference the captured allergy/medical info
      HC.assert(/allerg|medical/i.test(body), "email should acknowledge the medical/allergy capture");
    });

    check("Removing a link drops it from the email preview", function () {
      writeLinks([]);
      var r1 = addEmailLink("Temp form", "https://temp.example/x");
      HC.assert(r1.ok === true, "setup link should be added");
      var removed = removeEmailLink(r1.link.id);
      HC.assert(removed === true, "remove should report success");
      var body = buildConfirmationEmailPreview();
      HC.assert(body.indexOf("Temp form") === -1, "removed link must not appear in the email");
      HC.assert(readLinks().length === 0, "store should be empty after removal");
    });

    // ===== Booking validation enforces the medical field =====

    check("A booking missing the allergy/medical field is INVALID", function () {
      var v = validateBooking({
        parentName: "Sam Lee", parentEmail: "s@l.com", parentPhone: "07000000000",
        childName: "Ada", childDob: "2016-05-01", emergencyContact: "Jo 07111"
        // allergiesMedical intentionally omitted
      });
      HC.assert(v.valid === false, "booking without medical info must be invalid");
      HC.assert(v.missing.some(function (m) { return /allerg|medical/i.test(m); }),
        "missing list must flag the allergy/medical field");
    });

    check("A complete booking (incl. medical='None') is VALID", function () {
      var v = validateBooking({
        parentName: "Sam Lee", parentEmail: "s@l.com", parentPhone: "07000000000",
        childName: "Ada", childDob: "2016-05-01", emergencyContact: "Jo 07111",
        allergiesMedical: "None"
      });
      HC.assert(v.valid === true, "complete booking should validate; missing=" + v.missing.join(", "));
    });

    // ===== Defensive: garbage input must not throw =====

    check("Garbage input to validateBooking / addEmailLink is handled", function () {
      var bad = [null, undefined, 42, "", []];
      for (var i = 0; i < bad.length; i++) {
        var v = validateBooking(bad[i]);
        HC.assert(v && v.valid === false, "garbage booking #" + i + " must be invalid, not throw");
        var a = addEmailLink(bad[i], bad[i]);
        HC.assert(a && a.ok === false, "garbage link #" + i + " must be rejected, not throw");
      }
      // none of those should have persisted anything
      HC.assert(readLinks().length === 0, "no garbage links should have persisted");
    });

    // restore the provider's real links so the test leaves no trace
    writeLinks(snapshot);

    return { pass: pass, fail: fail, log: log };
  }

  /* ---------------- register ---------------- */

  HC.registerFeature({
    id: "provider-booking-questions-note",
    title: "Allergy/medical info captured at booking",
    side: "provider",
    icon: "🩹",
    summary: "Bookings collect a fixed set of standard details — your contact info, each child's details, and an allergies / medical conditions field. Providers can't add bespoke checkout questions, but can add links to the confirmation email to gather anything else.",
    render: render,
    selfTest: selfTest
  });
})();
