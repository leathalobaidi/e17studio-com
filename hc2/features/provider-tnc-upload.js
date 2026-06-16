/* HolidayCamp feature — provider-tnc-upload
 *
 * Upload T&Cs + Privacy Policy (booking legals)  (provider side)
 *
 * Replicates Happity's "Adding your Terms and Conditions & Privacy Policy"
 * (support article 2381438) and the photo/video-consent toggle that lives on
 * the same page (article 9875228). Evidence highlights:
 *   - Booking legals are reached via Settings > Bookings > "Update your booking
 *     legals". A provider supplies TWO documents: Terms & Conditions AND a
 *     Privacy Policy.
 *   - Each document can be a PDF UPLOAD *or* written directly in as TEXT.
 *   - "Before a customer can book your class, they will need to accept your
 *     T&Cs and read your privacy policy." => bookings are gated on legals.
 *   - "It is important to always have the CURRENT version uploaded" => we track
 *     a version stamp and updated-at date.
 *   - Accepting the T&Cs "will enable customers to also sign up to your
 *     marketing" => a marketing-opt-in toggle on the same page.
 *   - Same page carries the photo/video-consent toggle, applied to ALL classes.
 *
 * Framed for SCHOOL-AGE HOLIDAY CAMPS (not baby classes): a holiday-camp
 * provider uploads/writes their booking legals once; those legals then apply to
 * every camp/session they take bookings for, and a camp's bookings cannot be
 * switched live until both documents are present and non-empty.
 *
 * ACCEPTANCE CRITERION (asserted in selfTest):
 *   Bookings cannot ACTIVATE until T&Cs/Privacy Policy are provided.
 *   activateBookings() must REFUSE when either legal is missing/blank and
 *   SUCCEED only once both a (valid) T&Cs and Privacy Policy exist.
 *
 * Self-contained, defensive, no imports/exports. Calls HC.registerFeature.
 */
(function () {
  "use strict";

  // Defensive: never throw at module load if HC isn't present.
  if (typeof window === "undefined" || !window.HC || typeof window.HC.registerFeature !== "function") {
    if (typeof console !== "undefined" && console.warn) {
      console.warn("[HC] provider-tnc-upload: HC core not found; skipping registration.");
    }
    return;
  }

  var HC = window.HC;

  var STORE_KEY = "provider_booking_legals"; // persisted booking-legals doc store

  // The two legal documents a provider must supply, mirroring article 2381438.
  var DOC_TYPES = ["terms", "privacy"];
  var DOC_LABELS = { terms: "Terms & Conditions", privacy: "Privacy Policy" };

  // A document is only "provided" if it actually carries content. A PDF must
  // have a filename; written text must be more than whitespace and long enough
  // to be a plausible policy (guards against a provider typing one stray char).
  var MIN_TEXT_LEN = 20;

  /* ---------------- pure logic (testable, DOM-free) ---------------- */

  function asText(v) {
    return typeof v === "string" ? v : (v == null ? "" : String(v));
  }

  function nowStamp() {
    try { return Date.now(); } catch (e) { return 0; }
  }

  // Build an empty booking-legals record for a provider.
  function emptyLegals(providerId) {
    return {
      providerId: asText(providerId) || "default",
      terms: emptyDoc(),
      privacy: emptyDoc(),
      marketingOptInEnabled: false, // T&C acceptance can also sign customers up to marketing
      photoConsentEnabled: false,   // same-page toggle (article 9875228), applies to ALL camps
      bookingsActive: false,        // have bookings been switched live?
      updatedAt: 0
    };
  }

  function emptyDoc() {
    return { mode: null, fileName: null, text: "", version: 0, updatedAt: 0 };
  }

  // Validate a single document. A doc is valid (provided) when:
  //   - mode 'pdf'  : a non-blank fileName is attached, OR
  //   - mode 'text' : the written text is non-blank and >= MIN_TEXT_LEN chars.
  function isDocProvided(doc) {
    if (!doc || typeof doc !== "object") return false;
    if (doc.mode === "pdf") {
      return !!(asText(doc.fileName).trim());
    }
    if (doc.mode === "text") {
      return asText(doc.text).trim().length >= MIN_TEXT_LEN;
    }
    return false;
  }

  // Normalise a loose document input into the canonical doc shape, bumping the
  // version + updatedAt whenever real content is supplied (article: "always
  // have the current version uploaded").
  function setDoc(prevDoc, input) {
    var prev = (prevDoc && typeof prevDoc === "object") ? prevDoc : emptyDoc();
    var i = (input && typeof input === "object") ? input : {};
    var doc = {
      mode: prev.mode, fileName: prev.fileName, text: prev.text,
      version: Number(prev.version) || 0, updatedAt: Number(prev.updatedAt) || 0
    };
    if (i.mode === "pdf") {
      doc.mode = "pdf";
      doc.fileName = asText(i.fileName).trim() || null;
      doc.text = ""; // a PDF replaces any previously written text
    } else if (i.mode === "text") {
      doc.mode = "text";
      doc.text = asText(i.text);
      doc.fileName = null; // text replaces any previously uploaded PDF
    } else {
      // Unknown/garbage mode: leave the previous doc untouched.
      return doc;
    }
    if (isDocProvided(doc)) {
      doc.version = (Number(prev.version) || 0) + 1;
      doc.updatedAt = nowStamp();
    }
    return doc;
  }

  // The CORE gate: are this provider's booking legals complete?
  // Returns a structured readiness report used by the activation gate + UI.
  function legalsStatus(legals) {
    var L = (legals && typeof legals === "object") ? legals : emptyLegals();
    var termsOk = isDocProvided(L.terms);
    var privacyOk = isDocProvided(L.privacy);
    var missing = [];
    if (!termsOk) missing.push(DOC_LABELS.terms);
    if (!privacyOk) missing.push(DOC_LABELS.privacy);
    var complete = termsOk && privacyOk;
    return {
      termsOk: termsOk,
      privacyOk: privacyOk,
      complete: complete,
      missing: missing,
      // Plain-English line shown to the provider + (would-be) blocking reason.
      message: complete
        ? "Booking legals are complete — your T&Cs and Privacy Policy are in place."
        : "Bookings can't go live yet: add your " + missing.join(" and ") + "."
    };
  }

  // THE ACCEPTANCE-CRITERION GATE.
  // Attempt to switch a provider's bookings live. This must FAIL whenever the
  // T&Cs or Privacy Policy are missing/blank, mirroring Happity's rule that a
  // customer cannot book until they can accept the T&Cs and read the privacy
  // policy — so there is no point taking a camp's bookings live without them.
  //
  // Pure: it returns the next legals object (does not itself persist) plus an
  // ok flag + reason, so callers/tests can assert on the decision.
  function activateBookings(legals) {
    var L = cloneLegals(legals);
    var status = legalsStatus(L);
    if (!status.complete) {
      L.bookingsActive = false;
      return {
        ok: false,
        activated: false,
        legals: L,
        status: status,
        reason: status.message
      };
    }
    L.bookingsActive = true;
    return {
      ok: true,
      activated: true,
      legals: L,
      status: status,
      reason: "Bookings are live. Customers will accept your T&Cs and see your Privacy Policy at checkout."
    };
  }

  // Deactivate (hide) bookings — always allowed.
  function deactivateBookings(legals) {
    var L = cloneLegals(legals);
    L.bookingsActive = false;
    return { ok: true, activated: false, legals: L, status: legalsStatus(L),
      reason: "Bookings are paused." };
  }

  function cloneLegals(legals) {
    var L = (legals && typeof legals === "object") ? legals : emptyLegals();
    return {
      providerId: asText(L.providerId) || "default",
      terms: cloneDoc(L.terms),
      privacy: cloneDoc(L.privacy),
      marketingOptInEnabled: !!L.marketingOptInEnabled,
      photoConsentEnabled: !!L.photoConsentEnabled,
      bookingsActive: !!L.bookingsActive,
      updatedAt: Number(L.updatedAt) || 0
    };
  }
  function cloneDoc(doc) {
    var d = (doc && typeof doc === "object") ? doc : emptyDoc();
    return {
      mode: d.mode || null,
      fileName: d.fileName || null,
      text: asText(d.text),
      version: Number(d.version) || 0,
      updatedAt: Number(d.updatedAt) || 0
    };
  }

  // Apply a document update to a legals object, returning the next legals.
  // If bookings were already live and an update leaves the legals incomplete
  // (shouldn't normally happen, but a provider could clear a doc), we defensively
  // drop bookings back to inactive — they can never be "live" without legals.
  function updateLegalsDoc(legals, type, input) {
    var L = cloneLegals(legals);
    if (DOC_TYPES.indexOf(type) === -1) return L; // ignore unknown doc types
    L[type] = setDoc(L[type], input);
    L.updatedAt = nowStamp();
    if (L.bookingsActive && !legalsStatus(L).complete) {
      L.bookingsActive = false;
    }
    return L;
  }

  /* ---------------- persistence (HC.store only) ---------------- */

  // Map of providerId -> legals record.
  function readAll() {
    try {
      var m = HC.store.get(STORE_KEY, {});
      return (m && typeof m === "object" && !Array.isArray(m)) ? m : {};
    } catch (e) { return {}; }
  }
  function writeAll(map) {
    try { return HC.store.set(STORE_KEY, (map && typeof map === "object") ? map : {}); }
    catch (e) { return false; }
  }
  function loadLegals(providerId) {
    var all = readAll();
    var rec = all[asText(providerId) || "default"];
    return cloneLegals(rec || emptyLegals(providerId));
  }
  function saveLegals(legals) {
    var L = cloneLegals(legals);
    var all = readAll();
    all[L.providerId] = L;
    writeAll(all);
    return L;
  }

  /* ---------------- live provider list (read-only) ---------------- */

  function providerOptions() {
    var out = [];
    try {
      var ps = HC.data.providers || [];
      for (var i = 0; i < ps.length && i < 60; i++) {
        var p = ps[i];
        if (p && p.id) out.push({ id: asText(p.id), name: asText(p.name) || asText(p.id) });
      }
    } catch (e) { /* ignore */ }
    if (!out.length) out.push({ id: "demo-camp", name: "Demo Holiday Camp" });
    return out;
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

  function docBadge(ok) {
    var bg = ok ? "#E1F0E4" : "#FCE8F0";
    var fg = ok ? "#2f7d4f" : "#9a1f5e";
    var txt = ok ? "✓ Provided" : "✕ Missing";
    return '<span style="display:inline-block;font-family:Quicksand,system-ui,sans-serif;' +
      "font-weight:700;font-size:11.5px;padding:3px 9px;border-radius:999px;background:" +
      bg + ";color:" + fg + '">' + txt + "</span>";
  }

  function docSummary(doc) {
    if (!isDocProvided(doc)) return '<span style="color:var(--muted,#808080)">Not added yet</span>';
    if (doc.mode === "pdf") {
      return "PDF: <strong>" + esc(doc.fileName) + "</strong> · v" + (doc.version || 1);
    }
    var t = asText(doc.text).trim();
    var preview = t.length > 60 ? t.slice(0, 60) + "…" : t;
    return "Written text (" + t.length + " chars) · v" + (doc.version || 1) +
      '<br><span style="color:var(--muted,#808080);font-size:12px">' + esc(preview) + "</span>";
  }

  function render(mountEl) {
    try {
      if (!mountEl) return;
      mountEl.innerHTML = "";

      var providers = providerOptions();
      var state = { providerId: providers[0].id, legals: loadLegals(providers[0].id) };

      var intro = el("div", null,
        '<p style="font-size:14px;color:var(--text,#383838);margin:0 0 6px">' +
          "Add your <strong>booking legals</strong> — your camp's Terms &amp; Conditions and " +
          "Privacy Policy. Each can be a <strong>PDF upload</strong> or <strong>written in as text</strong>. " +
          "Before a family can book, they accept your T&amp;Cs and read your Privacy Policy, so " +
          "<strong>bookings can't go live until both are in place</strong>.</p>");
      mountEl.appendChild(intro);

      // Provider picker (uses live camp data).
      var pick = el("div", { style: "margin:8px 0 14px" });
      var opts = "";
      for (var i = 0; i < providers.length; i++) {
        opts += '<option value="' + esc(providers[i].id) + '">' + esc(providers[i].name) + "</option>";
      }
      pick.innerHTML =
        '<label style="font-size:13px">Camp / provider ' +
          '<select id="tlProvider" style="margin-left:6px;max-width:320px">' + opts + "</select></label>";
      mountEl.appendChild(pick);

      var body = el("div", { id: "tlBody" });
      mountEl.appendChild(body);

      function paint() {
        var st = legalsStatus(state.legals);
        var banner =
          '<div style="border:1.5px solid ' + (st.complete ? "#CFE9D6" : "#F4CFE0") +
            ";border-radius:14px;padding:12px 14px;margin-bottom:14px;background:" +
            (st.complete ? "#F4FBF6" : "#FFF6FA") + '">' +
            '<div style="font-family:Quicksand,system-ui,sans-serif;font-weight:700;color:' +
              (st.complete ? "#2f7d4f" : "#9a1f5e") + '">' +
              (st.complete ? "✓ Legals complete" : "✕ Legals incomplete") + "</div>" +
            '<p style="margin:6px 0 0;font-size:13.5px;color:var(--text,#383838)">' + esc(st.message) + "</p>" +
          "</div>";

        var docsHtml = "";
        for (var d = 0; d < DOC_TYPES.length; d++) {
          var type = DOC_TYPES[d];
          var doc = state.legals[type];
          var ok = isDocProvided(doc);
          docsHtml +=
            '<div style="border:1.5px solid var(--line,#E6E6E6);border-radius:14px;padding:14px;margin-bottom:12px">' +
              '<div style="display:flex;justify-content:space-between;align-items:center">' +
                '<div style="font-family:Quicksand,system-ui,sans-serif;font-weight:700;color:var(--purple,#603488)">' +
                  esc(DOC_LABELS[type]) + "</div>" + docBadge(ok) +
              "</div>" +
              '<p style="margin:8px 0 10px;font-size:13px;color:var(--text,#383838)">' + docSummary(doc) + "</p>" +
              '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">' +
                '<button class="hc-btn hc-btn-ghost" type="button" data-tl-pdf="' + type + '">Upload PDF</button>' +
                '<button class="hc-btn hc-btn-ghost" type="button" data-tl-text="' + type + '">Write as text</button>' +
              "</div>" +
            "</div>";
        }

        var toggles =
          '<div style="border-top:1px solid var(--line,#E6E6E6);padding-top:12px;margin-top:4px">' +
            '<label style="display:block;font-size:13px;margin:0 0 8px">' +
              '<input type="checkbox" id="tlMarketing"' + (state.legals.marketingOptInEnabled ? " checked" : "") + "> " +
              "Let families opt in to my marketing when they accept the T&amp;Cs</label>" +
            '<label style="display:block;font-size:13px;margin:0 0 4px">' +
              '<input type="checkbox" id="tlPhoto"' + (state.legals.photoConsentEnabled ? " checked" : "") + "> " +
              "Ask for photo/video consent at checkout (applies to all my camps)</label>" +
          "</div>";

        var activate =
          '<div style="border-top:1px solid var(--line,#E6E6E6);padding-top:14px;margin-top:12px;' +
            'display:flex;gap:10px;align-items:center;flex-wrap:wrap">' +
            '<button class="hc-btn" type="button" id="tlActivate"' + (state.legals.bookingsActive ? " disabled" : "") + '>' +
              "Switch bookings live</button>" +
            (state.legals.bookingsActive
              ? '<button class="hc-btn hc-btn-ghost" type="button" id="tlPause">Pause bookings</button>' +
                '<span style="font-family:Quicksand,system-ui,sans-serif;font-weight:700;color:#2f7d4f;font-size:13px">● Bookings LIVE</span>'
              : '<span style="font-family:Quicksand,system-ui,sans-serif;font-weight:700;color:var(--muted,#808080);font-size:13px">○ Bookings paused</span>') +
          "</div>";

        body.innerHTML = banner + docsHtml + toggles + activate;
      }

      function persist() { state.legals = saveLegals(state.legals); }

      // Provider switch
      pick.querySelector("#tlProvider").addEventListener("change", function (e) {
        state.providerId = e.target.value;
        state.legals = loadLegals(state.providerId);
        paint();
      });

      // Delegated controls within the body.
      body.addEventListener("click", function (e) {
        var pdfBtn = e.target.closest && e.target.closest("[data-tl-pdf]");
        var textBtn = e.target.closest && e.target.closest("[data-tl-text]");
        if (pdfBtn) {
          var type = pdfBtn.getAttribute("data-tl-pdf");
          var fn = (state.providerId.replace(/[^a-z0-9]+/gi, "-") + "-" + type + ".pdf");
          state.legals = updateLegalsDoc(state.legals, type, { mode: "pdf", fileName: fn });
          persist(); paint();
          try { HC.util.toast(DOC_LABELS[type] + " PDF uploaded (mock)"); } catch (x) {}
          return;
        }
        if (textBtn) {
          var t2 = textBtn.getAttribute("data-tl-text");
          var sample = DOC_LABELS[t2] + " for " +
            (providerLabel(state.providerId, providers)) +
            ". Bookings, cancellations, refunds and data handling for our school-age holiday camps are set out here.";
          state.legals = updateLegalsDoc(state.legals, t2, { mode: "text", text: sample });
          persist(); paint();
          try { HC.util.toast(DOC_LABELS[t2] + " saved as text"); } catch (x) {}
          return;
        }
        if (e.target && e.target.id === "tlActivate") {
          var res = activateBookings(state.legals);
          state.legals = res.legals; persist(); paint();
          try { HC.util.toast(res.ok ? "Bookings are live!" : res.reason); } catch (x) {}
          return;
        }
        if (e.target && e.target.id === "tlPause") {
          state.legals = deactivateBookings(state.legals).legals; persist(); paint();
          try { HC.util.toast("Bookings paused"); } catch (x) {}
          return;
        }
      });

      body.addEventListener("change", function (e) {
        if (e.target && e.target.id === "tlMarketing") {
          state.legals.marketingOptInEnabled = !!e.target.checked; persist();
        } else if (e.target && e.target.id === "tlPhoto") {
          state.legals.photoConsentEnabled = !!e.target.checked; persist();
        }
      });

      paint();
    } catch (e) {
      try {
        mountEl.innerHTML = '<p style="color:#9a1f5e">Booking-legals upload failed to render: ' +
          esc(e && e.message ? e.message : String(e)) + "</p>";
      } catch (e2) { /* give up quietly */ }
    }
  }

  function providerLabel(id, providers) {
    for (var i = 0; i < providers.length; i++) {
      if (providers[i].id === id) return providers[i].name;
    }
    return id;
  }

  /* ---------------- selfTest ---------------- */

  function selfTest() {
    var pass = 0, fail = 0, log = [];
    function check(label, fn) {
      try { fn(); pass += 1; log.push("✓ " + label); }
      catch (e) { fail += 1; log.push("✗ " + label + " — " + (e && e.message ? e.message : String(e))); }
    }

    // ===== ACCEPTANCE CRITERION =====
    // Bookings cannot ACTIVATE until T&Cs/Privacy Policy are provided.

    check("ACCEPTANCE: empty legals cannot activate bookings", function () {
      var L = emptyLegals("camp-a");
      var res = activateBookings(L);
      HC.assert(res.ok === false, "activation must be refused with no legals");
      HC.assert(res.legals.bookingsActive === false, "bookingsActive must stay false");
      HC.assert(/can't go live|add your/i.test(res.reason), "reason must explain the block");
    });

    check("ACCEPTANCE: T&Cs only (no Privacy Policy) cannot activate", function () {
      var L = updateLegalsDoc(emptyLegals("camp-b"), "terms",
        { mode: "text", text: "Our holiday-camp terms and conditions, in full." });
      HC.assert(isDocProvided(L.terms) === true, "T&Cs should be provided");
      var res = activateBookings(L);
      HC.assert(res.ok === false, "must refuse with only T&Cs");
      HC.assert(/privacy/i.test(res.status.message), "block reason must name the missing Privacy Policy");
    });

    check("ACCEPTANCE: Privacy Policy only (no T&Cs) cannot activate", function () {
      var L = updateLegalsDoc(emptyLegals("camp-c"), "privacy",
        { mode: "pdf", fileName: "privacy.pdf" });
      HC.assert(isDocProvided(L.privacy) === true, "Privacy should be provided");
      var res = activateBookings(L);
      HC.assert(res.ok === false, "must refuse with only Privacy Policy");
      HC.assert(/terms/i.test(res.status.message), "block reason must name the missing T&Cs");
    });

    check("ACCEPTANCE: BOTH T&Cs + Privacy Policy provided => bookings activate", function () {
      var L = emptyLegals("camp-d");
      L = updateLegalsDoc(L, "terms", { mode: "pdf", fileName: "terms.pdf" });
      L = updateLegalsDoc(L, "privacy", { mode: "text",
        text: "How we handle your family's data at our holiday camps." });
      var res = activateBookings(L);
      HC.assert(res.ok === true, "must activate once both legals exist");
      HC.assert(res.legals.bookingsActive === true, "bookingsActive must be true");
      HC.assert(res.status.complete === true, "status.complete must be true");
    });

    // ===== Each doc: PDF *or* text are both valid ways to provide it =====

    check("A PDF upload counts as a provided document", function () {
      var doc = setDoc(emptyDoc(), { mode: "pdf", fileName: "tncs.pdf" });
      HC.assert(isDocProvided(doc) === true, "PDF with a filename is provided");
      HC.assert(doc.mode === "pdf" && doc.fileName === "tncs.pdf", "PDF fields stored");
    });

    check("Written text counts as a provided document", function () {
      var doc = setDoc(emptyDoc(), { mode: "text",
        text: "These are our full terms and conditions for holiday camps." });
      HC.assert(isDocProvided(doc) === true, "long-enough text is provided");
      HC.assert(doc.mode === "text", "text mode stored");
    });

    check("A PDF with no filename is NOT a provided document", function () {
      var doc = setDoc(emptyDoc(), { mode: "pdf", fileName: "   " });
      HC.assert(isDocProvided(doc) === false, "blank filename must not count");
    });

    check("Whitespace / too-short text is NOT a provided document", function () {
      HC.assert(isDocProvided(setDoc(emptyDoc(), { mode: "text", text: "   " })) === false,
        "whitespace text must not count");
      HC.assert(isDocProvided(setDoc(emptyDoc(), { mode: "text", text: "ok" })) === false,
        "a stray couple of chars must not count as a policy");
    });

    // ===== Versioning ("always have the current version uploaded") =====

    check("Re-uploading a document bumps its version", function () {
      var doc = setDoc(emptyDoc(), { mode: "text", text: "Holiday camp T&Cs v1, full text here." });
      HC.assert(doc.version === 1, "first valid save is version 1, got " + doc.version);
      var doc2 = setDoc(doc, { mode: "pdf", fileName: "terms-updated.pdf" });
      HC.assert(doc2.version === 2, "replacing with a PDF should bump to v2, got " + doc2.version);
      HC.assert(doc2.mode === "pdf" && doc2.text === "", "PDF replaces previous text");
    });

    // ===== Switching a doc back to blank pulls live bookings down =====

    check("Clearing a doc deactivates previously-live bookings", function () {
      var L = emptyLegals("camp-e");
      L = updateLegalsDoc(L, "terms", { mode: "pdf", fileName: "t.pdf" });
      L = updateLegalsDoc(L, "privacy", { mode: "pdf", fileName: "p.pdf" });
      var live = activateBookings(L);
      HC.assert(live.legals.bookingsActive === true, "should be live first");
      // Now overwrite the T&Cs with empty text (provider clears it).
      var cleared = updateLegalsDoc(live.legals, "terms", { mode: "text", text: "" });
      HC.assert(isDocProvided(cleared.terms) === false, "T&Cs now blank");
      HC.assert(cleared.bookingsActive === false,
        "bookings must drop to inactive once legals become incomplete");
    });

    // ===== Marketing opt-in + photo consent live on the same page =====

    check("Marketing opt-in and photo consent are toggleable on the legals record", function () {
      var L = emptyLegals("camp-f");
      HC.assert(L.marketingOptInEnabled === false && L.photoConsentEnabled === false,
        "both default off");
      L.marketingOptInEnabled = true;
      L.photoConsentEnabled = true;
      var saved = cloneLegals(L);
      HC.assert(saved.marketingOptInEnabled === true && saved.photoConsentEnabled === true,
        "toggles survive a clone (so they persist)");
    });

    // ===== Defensive: garbage input must not throw, must not activate =====

    check("Garbage / empty inputs are handled and never activate", function () {
      var bad = [null, undefined, {}, 42, "", [], { terms: 1, privacy: "x" }];
      for (var i = 0; i < bad.length; i++) {
        var res = activateBookings(bad[i]);
        HC.assert(res && typeof res === "object", "result object for input #" + i);
        HC.assert(res.ok === false, "garbage input #" + i + " must not activate");
        HC.assert(res.legals && res.legals.bookingsActive === false,
          "garbage input #" + i + " must leave bookings inactive");
      }
    });

    check("updateLegalsDoc ignores unknown doc types without throwing", function () {
      var L = emptyLegals("camp-g");
      var L2 = updateLegalsDoc(L, "not_a_doc", { mode: "text", text: "x".repeat(40) });
      HC.assert(isDocProvided(L2.terms) === false && isDocProvided(L2.privacy) === false,
        "unknown doc type must not populate either legal");
    });

    // ===== Persistence via HC.store (never raw localStorage) =====

    check("saveLegals/loadLegals round-trips through HC.store", function () {
      var pid = "selftest-camp-" + (function () { try { return HC.util.uid(); } catch (e) { return Date.now(); } })();
      var L = emptyLegals(pid);
      L = updateLegalsDoc(L, "terms", { mode: "pdf", fileName: "rt-terms.pdf" });
      L = updateLegalsDoc(L, "privacy", { mode: "text",
        text: "Round-trip privacy policy for a holiday camp." });
      saveLegals(L);
      var back = loadLegals(pid);
      HC.assert(back.terms.mode === "pdf" && back.terms.fileName === "rt-terms.pdf",
        "T&Cs PDF should round-trip");
      HC.assert(isDocProvided(back.privacy) === true, "Privacy text should round-trip");
      HC.assert(legalsStatus(back).complete === true, "loaded legals should read as complete");
      // And the loaded legals should be activatable.
      HC.assert(activateBookings(back).ok === true, "round-tripped complete legals must activate");
      // clean up the mock store entry.
      var all = readAll();
      delete all[pid];
      writeAll(all);
      HC.assert(!readAll()[pid], "selftest legals cleaned up from store");
    });

    return { pass: pass, fail: fail, log: log };
  }

  /* ---------------- register ---------------- */

  HC.registerFeature({
    id: "provider-tnc-upload",
    title: "Upload T&Cs + Privacy Policy (booking legals)",
    side: "provider",
    icon: "📜",
    summary: "Add your camp's booking legals — Terms & Conditions and Privacy Policy, as a PDF or written text. Bookings can't go live until both are provided; the same page carries the marketing opt-in and photo-consent toggles.",
    render: render,
    selfTest: selfTest
  });
})();
