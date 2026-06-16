/* HolidayCamp feature: parent-complaint
 * ------------------------------------------------------------------
 * Replicates Happity's "Raise a complaint / payment-issue contact"
 * behaviour for the PARENT side.
 *
 * Evidence (Happity support corpus):
 *  - 8177452 "Complaints procedure":
 *      A reachable complaints route with a clear, staged process —
 *        1. INFORMAL: most complaints handled by the Customer Success
 *           team (support@happity.co.uk), overseen by the Head of
 *           Customer Success.
 *        2. FORMAL: if not resolved, raise a formal complaint IN
 *           WRITING to support@happity.co.uk. The written complaint
 *           "should include" a defined checklist: the facts/issue to
 *           investigate; dates & times of relevant conversations;
 *           copies of relevant correspondence; screenshots where
 *           relevant; details of anyone else to speak to; any other
 *           related information.
 *        3. INVESTIGATION then RESOLUTION — the outcome is detailed
 *           "by phone and/or email".
 *  - 8255720 "Parents & Carers FAQs — Support with Bookings":
 *      "If you cannot find the answer you need below, have experienced
 *       a payment issue or would like to make a complaint, then please
 *       email us [support@happity.co.uk]". Section "I have experienced
 *       payment issues with my booking" -> contact customer support
 *       "with as much information as possible".
 *
 * So the PARENT-side route is: a help/contact destination reachable
 * from Help that (a) exposes the platform support EMAIL, (b) describes
 * the staged PROCESS, and (c) lets a parent compose a complaint or
 * payment-issue contact (with the formal checklist) addressed to that
 * support mailbox.
 *
 * NOTE — refunds/cancellations go to the PROVIDER (see
 * parent-refund-request / parent-cancel-reschedule-route). THIS feature
 * is the route to the PLATFORM: serious complaints + checkout/payment
 * problems, which Happity's own Customer Success team handles.
 *
 * Side: parent. Framed for SCHOOL-AGE HOLIDAY CAMPS, not baby classes.
 *
 * ACCEPTANCE CRITERION (asserted in selfTest, multiple cases):
 *   A complaints/contact route is reachable from Help with an EMAIL and
 *   a PROCESS described. i.e. helpRoute() returns a route addressable
 *   from help that carries the support email AND the ordered process
 *   stages; and buildContact(...) composes a message to that email.
 *
 * Defensive: nothing throws at registration time; risky code is wrapped.
 * Persistence is via HC.store only (saved drafts / sent log), never
 * global localStorage.
 * ------------------------------------------------------------------ */
(function () {
  "use strict";

  if (typeof window === "undefined" || !window.HC || typeof window.HC.registerFeature !== "function") {
    // Core not present — fail silently rather than throwing.
    return;
  }
  var HC = window.HC;

  var STORE_KEY = "complaint_contacts"; // array of sent/saved contact records

  // Clearly-mock platform support mailbox (this is a mockup, not Happity live).
  var SUPPORT_EMAIL = "support@holidaycamp.example";
  var HEAD_OF_CS = "Head of Customer Success";

  // Two reasons a parent reaches the PLATFORM (not the provider).
  // - "payment": checkout / payment issue (8255720)
  // - "complaint": a serious complaint (8177452)
  var KINDS = {
    payment: {
      id: "payment",
      label: "Payment / checkout issue",
      blurb: "Something went wrong paying for a booking — a failed or double charge, " +
        "a missing booking after payment, or an error during checkout."
    },
    complaint: {
      id: "complaint",
      label: "Raise a complaint",
      blurb: "A serious issue with the service that you'd like us to investigate and resolve."
    }
  };

  // The staged process, lifted from the complaints procedure (8177452).
  // Reachable + described so the help route can render it.
  var PROCESS_STAGES = [
    {
      key: "informal",
      title: "1. Informal — talk to Customer Success",
      detail: "Most issues are resolved informally by emailing our Customer Success team at " +
        SUPPORT_EMAIL + ". The " + HEAD_OF_CS + " makes sure every issue is handled fairly and quickly."
    },
    {
      key: "formal",
      title: "2. Formal — put your complaint in writing",
      detail: "If it isn't resolved, raise a formal complaint in writing to " + SUPPORT_EMAIL +
        ". Include the checklist below so we can investigate properly."
    },
    {
      key: "investigation",
      title: "3. Investigation",
      detail: "The " + HEAD_OF_CS + " investigates — reading prior correspondence, speaking to you and to " +
        "any team members or providers involved."
    },
    {
      key: "resolution",
      title: "4. Resolution",
      detail: "Once the investigation is complete we implement a fair, proportionate resolution and " +
        "contact you by phone and/or email with the outcome."
    }
  ];

  // The "should include" checklist for a FORMAL written complaint (8177452).
  var FORMAL_CHECKLIST = [
    { key: "facts", label: "The facts of the complaint and the issue you'd like investigated", required: true },
    { key: "dates", label: "Dates and times of any relevant conversations", required: false },
    { key: "correspondence", label: "Copies of relevant correspondence", required: false },
    { key: "screenshots", label: "Screenshots where relevant", required: false },
    { key: "others", label: "Details of anyone else we'd benefit from speaking to", required: false },
    { key: "other", label: "Any other related information", required: false }
  ];

  /* ============================================================
   * 1. The HELP ROUTE — pure data describing the reachable route.
   *    This is the heart of the acceptance criterion: a route
   *    reachable from Help carrying the EMAIL and the PROCESS.
   * ============================================================ */

  function helpRoute() {
    return {
      // Reachable from Help: an entry that Help/FAQ links to.
      reachableFrom: "help",
      route: "/help/complaints",
      linkText: "Make a complaint or report a payment issue",
      // The EMAIL the route exposes.
      email: SUPPORT_EMAIL,
      // The PROCESS described, in order.
      process: PROCESS_STAGES.map(function (s) {
        return { key: s.key, title: s.title, detail: s.detail };
      }),
      // Supporting metadata used by the UI.
      kinds: [KINDS.payment, KINDS.complaint],
      formalChecklist: FORMAL_CHECKLIST.slice()
    };
  }

  function isObj(x) { return x && typeof x === "object"; }

  /* ============================================================
   * 2. buildContact — validate + compose the message addressed to
   *    the support EMAIL. Never throws; returns {ok,...}.
   *
   *    opts:
   *      kind:     "payment" | "complaint"
   *      formal:   boolean  (complaint only — formal written stage)
   *      summary:  string   (the facts / the issue)  [required]
   *      booking:  optional booking ({ ref, campName, paid, ... })
   *      details:  optional { dates, correspondence, screenshots,
   *                           others, other } strings for the checklist
   *      contactBack: optional "phone and/or email" preference
   * ============================================================ */

  function buildContact(opts) {
    opts = isObj(opts) ? opts : {};
    var kind = (opts.kind === "complaint") ? "complaint" : (opts.kind === "payment") ? "payment" : null;
    if (!kind) {
      return { ok: false, reason: "no-kind", message: "Choose what you're contacting us about." };
    }

    var summary = String(opts.summary == null ? "" : opts.summary).trim();
    if (!summary) {
      return {
        ok: false,
        reason: "no-summary",
        message: kind === "payment"
          ? "Tell us what went wrong with the payment."
          : "Describe the facts of your complaint."
      };
    }

    var formal = kind === "complaint" && opts.formal === true;
    var booking = isObj(opts.booking) ? opts.booking : null;
    var details = isObj(opts.details) ? opts.details : {};

    // Build the message body.
    var lines = [];
    lines.push("To: HolidayCamp Customer Success (" + SUPPORT_EMAIL + ")");
    lines.push("");
    if (kind === "payment") {
      lines.push("Type: Payment / checkout issue");
    } else {
      lines.push("Type: " + (formal ? "Formal complaint" : "Complaint"));
    }
    if (booking) {
      var ref = booking.ref || booking.id || "(no reference)";
      lines.push("Booking: " + (booking.campName || "holiday-camp place") + " — ref " + ref +
        (typeof booking.paid === "number" ? " — paid " + HC.util.money(booking.paid) : ""));
    }
    lines.push("");
    lines.push(kind === "payment" ? "What happened:" : "The facts / the issue to investigate:");
    lines.push(summary);

    // For a FORMAL complaint, append whichever checklist items were provided.
    var includedChecklist = [];
    if (formal) {
      lines.push("");
      lines.push("Supporting information:");
      var map = {
        dates: "Relevant dates & times",
        correspondence: "Relevant correspondence",
        screenshots: "Screenshots",
        others: "Others to speak to",
        other: "Other related information"
      };
      Object.keys(map).forEach(function (k) {
        var v = String(details[k] == null ? "" : details[k]).trim();
        if (v) {
          includedChecklist.push(k);
          lines.push("- " + map[k] + ": " + v);
        }
      });
      if (!includedChecklist.length) {
        lines.push("- (none provided)");
      }
    }

    var contactBack = (opts.contactBack === "phone" || opts.contactBack === "email" || opts.contactBack === "phone and/or email")
      ? opts.contactBack : "phone and/or email";
    lines.push("");
    lines.push("Please contact me by " + contactBack + " with the outcome.");

    var subject = (kind === "payment")
      ? "Payment issue" + (booking ? " — ref " + (booking.ref || booking.id) : "")
      : (formal ? "Formal complaint" : "Complaint") + (booking ? " — ref " + (booking.ref || booking.id) : "");

    var message = {
      to: SUPPORT_EMAIL,
      channel: "email",
      kind: kind,
      formal: formal,
      subject: subject,
      body: lines.join("\n"),
      bookingRef: booking ? (booking.ref || booking.id || null) : null,
      checklistIncluded: includedChecklist
    };

    return {
      ok: true,
      kind: kind,
      formal: formal,
      message: message,
      // What we'll tell the parent about what happens next (the process).
      note: kind === "payment"
        ? "Sent to our Customer Success team at " + SUPPORT_EMAIL +
          ". They'll investigate the payment and reply as soon as possible."
        : (formal
            ? "Your formal complaint has been sent to " + SUPPORT_EMAIL +
              ". The " + HEAD_OF_CS + " will investigate and contact you by " + contactBack + " with the outcome."
            : "Sent to our Customer Success team at " + SUPPORT_EMAIL +
              ". Most complaints are resolved informally; if not, you can escalate to a formal written complaint.")
    };
  }

  // Send = build + persist a record against the sent log.
  function sendContact(opts) {
    var built = buildContact(opts);
    if (!built.ok) return built;

    var record = {
      id: HC.util.uid(),
      kind: built.kind,
      formal: built.formal,
      to: built.message.to,
      subject: built.message.subject,
      body: built.message.body,
      bookingRef: built.message.bookingRef,
      checklistIncluded: built.message.checklistIncluded,
      status: "sent",
      sentAt: nowIso()
    };

    try {
      var all = HC.store.get(STORE_KEY, []) || [];
      if (!Array.isArray(all)) all = [];
      all.unshift(record);
      HC.store.set(STORE_KEY, all);
    } catch (e) { /* mock persistence is best-effort */ }

    built.record = record;
    return built;
  }

  function sentLog() {
    try {
      var all = HC.store.get(STORE_KEY, []) || [];
      return Array.isArray(all) ? all : [];
    } catch (e) { return []; }
  }

  function nowIso() {
    try { return new Date().toISOString(); } catch (e) { return "2026-06-15T00:00:00.000Z"; }
  }

  /* ============================================================
   * 3. UI — a Help > "Make a complaint / report a payment issue"
   *    panel. Shows the EMAIL, the staged PROCESS, and a composer.
   * ============================================================ */

  function render(mountEl) {
    try {
      var route = helpRoute();

      mountEl.innerHTML =
        '<div style="font-family:\'Nunito Sans\',system-ui,sans-serif;color:var(--text,#383838)">' +
          '<p style="font-size:12.5px;color:var(--muted,#808080);margin:0 0 4px">' +
            'Help · <strong>' + esc(route.linkText) + '</strong></p>' +
          '<p style="font-size:14px;margin:0 0 6px">Can\'t resolve something with a booking? You can reach our ' +
            'Customer Success team directly. <strong>Refunds and date changes are arranged with the camp provider</strong> — ' +
            'but <strong>payment problems and serious complaints</strong> come to us.</p>' +
          '<div style="background:var(--purple-tint,#F0E8F4);border-radius:12px;padding:10px 14px;margin:8px 0 14px;font-size:13.5px">' +
            'Email us: <a href="mailto:' + esc(route.email) + '" style="color:var(--purple,#603488);font-weight:700">' +
              esc(route.email) + '</a>' +
          '</div>' +
          '<div id="cmpProcess"></div>' +
          '<div id="cmpComposer" style="margin-top:16px"></div>' +
          '<div id="cmpLog" style="margin-top:16px"></div>' +
        '</div>';

      // ---- Process (described + reachable) ----
      var procHost = mountEl.querySelector("#cmpProcess");
      procHost.innerHTML =
        '<div style="font-family:\'Quicksand\',system-ui,sans-serif;font-weight:700;color:var(--magenta,#F82488);' +
          'text-transform:uppercase;letter-spacing:.5px;font-size:12px;margin:0 0 8px">How it works</div>' +
        route.process.map(function (s) {
          return '<div style="border-left:3px solid var(--purple-tint,#F0E8F4);padding:2px 0 6px 12px;margin-bottom:8px">' +
            '<div style="font-weight:700;font-size:13.5px;color:var(--purple,#603488)">' + esc(s.title) + '</div>' +
            '<div style="font-size:12.5px;color:var(--text,#383838)">' + esc(s.detail) + '</div>' +
          '</div>';
        }).join("");

      // ---- Composer ----
      var composer = mountEl.querySelector("#cmpComposer");

      function paintLog() {
        var log = sentLog();
        var logHost = mountEl.querySelector("#cmpLog");
        if (!log.length) { logHost.innerHTML = ""; return; }
        logHost.innerHTML =
          '<div style="font-family:\'Quicksand\',system-ui,sans-serif;font-weight:700;color:var(--purple,#603488);' +
            'font-size:13px;margin:0 0 6px">Sent to Customer Success</div>' +
          log.slice(0, 4).map(function (r) {
            return '<div style="border:1px solid var(--line,#E6E6E6);border-radius:10px;padding:8px 10px;margin-bottom:6px;font-size:12.5px">' +
              '<strong>' + esc(r.subject) + '</strong> → ' + esc(r.to) +
              '<span style="color:var(--muted,#808080)"> · ' + (r.formal ? "formal" : r.kind) + '</span>' +
            '</div>';
          }).join("");
      }

      function paintComposer() {
        composer.innerHTML =
          '<div style="background:#fff;border:1.5px solid var(--line,#E6E6E6);border-radius:14px;padding:14px 16px">' +
            '<label style="display:block;font-weight:700;font-size:12.5px;margin-bottom:4px">What\'s this about?</label>' +
            '<select id="cmpKind" style="width:100%;padding:8px;border:1.5px solid var(--line,#E6E6E6);border-radius:10px;font-size:13.5px;margin-bottom:6px">' +
              '<option value="payment">' + esc(KINDS.payment.label) + '</option>' +
              '<option value="complaint">' + esc(KINDS.complaint.label) + '</option>' +
            '</select>' +
            '<div id="cmpBlurb" style="font-size:12px;color:var(--muted,#808080);margin-bottom:10px"></div>' +
            '<div id="cmpFormalWrap" style="display:none;margin-bottom:10px">' +
              '<label style="display:flex;gap:8px;align-items:flex-start;font-size:12.5px">' +
                '<input id="cmpFormal" type="checkbox" style="margin-top:2px">' +
                '<span>Make this a <strong>formal written complaint</strong> (adds the supporting-information checklist).</span>' +
              '</label>' +
            '</div>' +
            '<label style="display:block;font-weight:700;font-size:12.5px;margin-bottom:4px" id="cmpSummaryLabel">The facts / the issue</label>' +
            '<textarea id="cmpSummary" rows="3" placeholder="Describe what happened, with as much detail as possible." ' +
              'style="width:100%;padding:8px;border:1.5px solid var(--line,#E6E6E6);border-radius:10px;font-size:13px;margin-bottom:10px"></textarea>' +
            '<div id="cmpChecklist" style="display:none"></div>' +
            '<div id="cmpMsg" style="font-size:12px;min-height:14px;margin-bottom:8px"></div>' +
            '<button id="cmpSend" class="hc-btn" type="button">Email Customer Success</button>' +
          '</div>';

        var kindSel = composer.querySelector("#cmpKind");
        var blurb = composer.querySelector("#cmpBlurb");
        var formalWrap = composer.querySelector("#cmpFormalWrap");
        var formalChk = composer.querySelector("#cmpFormal");
        var summaryLabel = composer.querySelector("#cmpSummaryLabel");
        var summaryEl = composer.querySelector("#cmpSummary");
        var checklistHost = composer.querySelector("#cmpChecklist");
        var msgEl = composer.querySelector("#cmpMsg");

        function syncKind() {
          var k = kindSel.value;
          blurb.textContent = (KINDS[k] && KINDS[k].blurb) || "";
          formalWrap.style.display = k === "complaint" ? "block" : "none";
          summaryLabel.textContent = k === "payment" ? "What happened?" : "The facts / the issue to investigate";
          if (k !== "complaint") { formalChk.checked = false; }
          syncFormal();
        }
        function syncFormal() {
          var on = kindSel.value === "complaint" && formalChk.checked;
          checklistHost.style.display = on ? "block" : "none";
          if (on && !checklistHost.dataset.built) {
            checklistHost.innerHTML =
              '<div style="font-size:12px;color:var(--muted,#808080);margin:0 0 6px">' +
                'A formal written complaint should include:</div>' +
              FORMAL_CHECKLIST.filter(function (c) { return c.key !== "facts"; }).map(function (c) {
                return '<input data-ck="' + esc(c.key) + '" placeholder="' + escAttr(c.label) + '" ' +
                  'style="width:100%;padding:7px;border:1.5px solid var(--line,#E6E6E6);border-radius:9px;font-size:12.5px;margin-bottom:6px">';
              }).join("");
            checklistHost.dataset.built = "1";
          }
        }

        kindSel.addEventListener("change", syncKind);
        formalChk.addEventListener("change", syncFormal);
        syncKind();

        composer.querySelector("#cmpSend").addEventListener("click", function () {
          var details = {};
          checklistHost.querySelectorAll("[data-ck]").forEach(function (inp) {
            details[inp.getAttribute("data-ck")] = inp.value;
          });
          var res = sendContact({
            kind: kindSel.value,
            formal: kindSel.value === "complaint" && formalChk.checked,
            summary: summaryEl.value,
            details: details
          });
          if (!res.ok) {
            msgEl.textContent = res.message || "Could not send.";
            msgEl.style.color = "#9a1f5e";
            return;
          }
          try { HC.util.toast("Sent to " + SUPPORT_EMAIL); } catch (e) {}
          paintComposer();
          paintLog();
        });
      }

      paintComposer();
      paintLog();
    } catch (e) {
      mountEl.innerHTML = '<p style="color:#9a1f5e">Complaint route preview failed to load: ' +
        esc(e && e.message ? e.message : String(e)) + "</p>";
    }
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
  function escAttr(s) { return esc(s).replace(/"/g, "&quot;"); }

  /* ============================================================
   * 4. selfTest — exercises the LOGIC and asserts the acceptance
   *    criterion across multiple cases:
   *    "A complaints/contact route is reachable from help with an
   *     EMAIL and PROCESS described."
   * ============================================================ */

  function selfTest() {
    var pass = 0, fail = 0, log = [];
    function check(label, fn) {
      try { fn(); pass += 1; log.push("✓ " + label); }
      catch (e) { fail += 1; log.push("✗ " + label + " — " + (e && e.message ? e.message : String(e))); }
    }

    function reset() { try { HC.store.set(STORE_KEY, []); } catch (e) {} }
    reset();

    /* ---- ACCEPTANCE: reachable from help, with an email + process ---- */
    check("Help route is reachable FROM HELP", function () {
      var r = helpRoute();
      HC.assert(isObj(r), "helpRoute() should return an object");
      HC.assert(r.reachableFrom === "help", "route must be reachable from 'help', got " + r.reachableFrom);
      HC.assert(typeof r.route === "string" && /complaint/i.test(r.route), "route path should reference complaints, got " + r.route);
      HC.assert(typeof r.linkText === "string" && r.linkText.length > 0, "route must expose link text for Help");
    });

    check("Help route exposes a valid support EMAIL", function () {
      var r = helpRoute();
      HC.assert(typeof r.email === "string", "email must be a string");
      HC.assert(/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(r.email), "email must look like an address, got " + r.email);
      HC.assert(r.email === SUPPORT_EMAIL, "email should be the support mailbox");
    });

    check("Help route DESCRIBES the process, in order", function () {
      var r = helpRoute();
      HC.assert(Array.isArray(r.process), "process must be an array");
      HC.assert(r.process.length >= 4, "process should have at least 4 stages, got " + r.process.length);
      var keys = r.process.map(function (s) { return s.key; });
      HC.assert(keys[0] === "informal", "stage 1 should be 'informal'");
      HC.assert(keys.indexOf("formal") !== -1, "process must include a 'formal' stage");
      HC.assert(keys.indexOf("investigation") !== -1, "process must include an 'investigation' stage");
      HC.assert(keys[keys.length - 1] === "resolution", "final stage should be 'resolution'");
      r.process.forEach(function (s) {
        HC.assert(typeof s.title === "string" && s.title.length > 0, "each stage needs a title");
        HC.assert(typeof s.detail === "string" && s.detail.length > 0, "each stage needs a described detail");
      });
    });

    check("The described process surfaces the email and resolution channel", function () {
      var r = helpRoute();
      var all = r.process.map(function (s) { return s.detail; }).join(" ");
      HC.assert(all.indexOf(SUPPORT_EMAIL) !== -1, "process detail should mention the support email");
      HC.assert(/phone and\/or email/i.test(all), "resolution should be by phone and/or email (8177452)");
    });

    /* ---- Composing a contact addressed to that email ---- */
    check("A payment-issue contact is composed to the support email", function () {
      reset();
      var res = buildContact({ kind: "payment", summary: "I was charged twice for Week 2 and only one booking shows." });
      HC.assert(res.ok === true, "valid payment contact should build");
      HC.assert(res.message.to === SUPPORT_EMAIL, "message must be addressed to the support email");
      HC.assert(res.message.channel === "email", "channel should be email");
      HC.assert(res.kind === "payment", "kind should be 'payment'");
      HC.assert(/payment/i.test(res.message.subject), "subject should mention payment");
    });

    check("A complaint contact is composed to the support email", function () {
      reset();
      var res = buildContact({ kind: "complaint", summary: "Camp was cancelled with no notice." });
      HC.assert(res.ok === true, "valid complaint should build");
      HC.assert(res.message.to === SUPPORT_EMAIL, "complaint must go to the support email");
      HC.assert(res.formal === false, "a plain complaint is not formal by default");
      HC.assert(/complaint/i.test(res.message.subject), "subject should mention complaint");
    });

    /* ---- Formal complaint includes the checklist (8177452) ---- */
    check("A FORMAL complaint appends the supporting-information checklist", function () {
      reset();
      var res = buildContact({
        kind: "complaint",
        formal: true,
        summary: "Repeated double-charges and no reply for two weeks.",
        details: {
          dates: "Called 1 June 10am; emailed 3 June",
          correspondence: "Two emails attached",
          screenshots: "Bank statement screenshot",
          others: "My partner was on the call"
        }
      });
      HC.assert(res.ok === true, "formal complaint should build");
      HC.assert(res.formal === true, "formal flag should be true");
      HC.assert(/Formal complaint/i.test(res.message.subject), "subject should mark it formal");
      HC.assert(res.message.body.indexOf("Supporting information:") !== -1, "body should contain the checklist header");
      HC.assert(res.message.body.indexOf("Bank statement screenshot") !== -1, "body should include provided screenshot note");
      HC.assert(res.message.checklistIncluded.indexOf("dates") !== -1, "dates checklist item should be recorded");
      HC.assert(res.message.checklistIncluded.indexOf("correspondence") !== -1, "correspondence item should be recorded");
      HC.assert(res.message.checklistIncluded.indexOf("screenshots") !== -1, "screenshots item should be recorded");
    });

    check("A formal complaint with no extra details still builds (checklist optional)", function () {
      reset();
      var res = buildContact({ kind: "complaint", formal: true, summary: "Service issue." });
      HC.assert(res.ok === true, "formal complaint with only the facts should still build");
      HC.assert(res.message.checklistIncluded.length === 0, "no checklist items provided -> empty list");
      HC.assert(res.message.body.indexOf("(none provided)") !== -1, "body should note none provided");
    });

    /* ---- The note describes the next steps (the process) ---- */
    check("Formal-complaint note names the investigation + resolution channel", function () {
      reset();
      var res = buildContact({ kind: "complaint", formal: true, summary: "Issue", contactBack: "email" });
      HC.assert(typeof res.note === "string", "a note should be returned");
      HC.assert(res.note.indexOf(SUPPORT_EMAIL) !== -1, "note should reference the support email");
      HC.assert(/investigate/i.test(res.note), "note should mention investigation");
      HC.assert(res.note.indexOf("email") !== -1, "note should reflect the chosen contact-back channel");
    });

    /* ---- Validation guards ---- */
    check("Missing kind is rejected", function () {
      var res = buildContact({ summary: "x" });
      HC.assert(res.ok === false && res.reason === "no-kind", "no kind -> 'no-kind', got " + res.reason);
    });

    check("Empty summary is rejected for both kinds", function () {
      var p = buildContact({ kind: "payment", summary: "   " });
      var c = buildContact({ kind: "complaint", summary: "" });
      HC.assert(p.ok === false && p.reason === "no-summary", "blank payment summary rejected");
      HC.assert(c.ok === false && c.reason === "no-summary", "blank complaint summary rejected");
    });

    check("Non-object / undefined opts are handled without throwing", function () {
      var a = buildContact(undefined);
      var b = buildContact("not-an-object");
      HC.assert(a.ok === false, "undefined opts -> graceful failure");
      HC.assert(b.ok === false, "string opts -> graceful failure");
    });

    /* ---- Booking context is woven in when present ---- */
    check("A booking reference is woven into the message when supplied", function () {
      reset();
      var res = buildContact({
        kind: "payment",
        summary: "Payment failed but money left my account.",
        booking: { ref: "HC-1042", campName: "Sunny Holiday Camp", paid: 180 }
      });
      HC.assert(res.message.bookingRef === "HC-1042", "booking ref should be captured");
      HC.assert(res.message.body.indexOf("HC-1042") !== -1, "body should reference the booking");
      HC.assert(res.message.body.indexOf("Sunny Holiday Camp") !== -1, "body should name the camp");
      HC.assert(res.message.subject.indexOf("HC-1042") !== -1, "subject should include the ref");
    });

    /* ---- Persistence via HC.store ---- */
    check("Sent contacts are persisted to HC.store and retrievable", function () {
      reset();
      HC.assert(sentLog().length === 0, "log should start empty");
      var res = sendContact({ kind: "complaint", formal: true, summary: "Persisted complaint." });
      HC.assert(res.ok === true, "send should succeed");
      HC.assert(res.record && res.record.status === "sent", "record should be marked sent");
      var log = sentLog();
      HC.assert(log.length === 1, "exactly one record should be stored, got " + log.length);
      HC.assert(log[0].to === SUPPORT_EMAIL, "stored record should be addressed to support email");
      HC.assert(log[0].formal === true, "stored record should preserve the formal flag");
    });

    check("Multiple sends accumulate, newest first", function () {
      reset();
      sendContact({ kind: "payment", summary: "First" });
      sendContact({ kind: "complaint", summary: "Second" });
      var log = sentLog();
      HC.assert(log.length === 2, "two records expected, got " + log.length);
      HC.assert(log[0].kind === "complaint", "newest (complaint) should be first");
    });

    check("A failed send does NOT persist anything", function () {
      reset();
      var res = sendContact({ kind: "complaint", summary: "" });
      HC.assert(res.ok === false, "invalid send should fail");
      HC.assert(sentLog().length === 0, "nothing should be persisted on failure");
    });

    /* ---- The two kinds map to the two evidence articles ---- */
    check("Both kinds (payment 8255720, complaint 8177452) are offered by the route", function () {
      var r = helpRoute();
      var ids = (r.kinds || []).map(function (k) { return k.id; });
      HC.assert(ids.indexOf("payment") !== -1, "payment-issue kind should be offered");
      HC.assert(ids.indexOf("complaint") !== -1, "complaint kind should be offered");
    });

    reset();
    return { pass: pass, fail: fail, log: log };
  }

  /* ============================================================
   * 5. Register (idempotent + defensive via core).
   * ============================================================ */
  HC.registerFeature({
    id: "parent-complaint",
    title: "Make a complaint / payment issue",
    side: "parent",
    icon: "📣", // 📣
    summary: "A Help route to Customer Success for serious complaints and payment/checkout problems. " +
      "Shows the support email and the staged process — informal first, then a formal written complaint " +
      "(with a supporting-information checklist), investigation, and a resolution by phone and/or email. " +
      "Refunds and date changes still go to the camp provider.",
    render: render,
    selfTest: selfTest
  });
})();
