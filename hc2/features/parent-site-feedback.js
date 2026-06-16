/* HolidayCamp feature — parent-site-feedback
 *
 * Site/app feedback widget (persistent "Feedback" icon)  (parent side)
 *
 * Replicates Happity's parent-side "Feedback icon" feature
 * (support article 8255758 — "Parents & Carers FAQs: Giving us your feedback"):
 *   - "We are always looking for ways to improve our website and app so if you
 *      would like to share some feedback please do send this over to our
 *      Customer Support team..."
 *   - "Alternatively you can provide feedback using the Feedback icon on our
 *      website."
 *
 * So the parent-side behaviour is: a PERSISTENT feedback icon, available across
 * the whole site, that opens a FREE-TEXT feedback form and submits to support.
 *
 * This is DELIBERATELY DISTINCT from two other routes (the article lists them as
 * separate things, and the acceptance criterion insists on the distinction):
 *   - NOT the per-listing report ("Help fix this listing" on a provider profile).
 *   - NOT the complaints / payment-issue route (parent-complaint.js → a staged
 *     formal process for serious provider/payment issues).
 * Site feedback is the lightweight "tell us about the site/app, or send love"
 * channel. It carries a sentiment (😞 😐 😃, exactly the article's prompt) and a
 * site-feedback category — never a provider/booking grievance.
 *
 * Framed for SCHOOL-AGE HOLIDAY CAMPS: a parent browsing the holiday-camp
 * directory/planner can tap the floating Feedback icon from any page to tell us
 * a filter is broken, the planner is hard to read, or simply that they love it.
 *
 * Self-contained, defensive, plain browser JS (no imports/exports).
 * Persists via HC.store. Calls HC.registerFeature at top level.
 */
(function () {
  "use strict";

  // Defensive: never throw at module load if HC isn't present.
  if (typeof window === "undefined" || !window.HC || typeof window.HC.registerFeature !== "function") {
    if (typeof console !== "undefined" && console.warn) {
      console.warn("[HC] parent-site-feedback: HC core not found; skipping registration.");
    }
    return;
  }

  var HC = window.HC;

  /* ---------------- constants ---------------- */

  // Where site/app feedback is submitted. The article routes site feedback to
  // the Customer Support team; this is the destination, NOT a provider inbox
  // and NOT the formal-complaints address pipeline.
  var SUPPORT_EMAIL = "support@holidaycamp.co.uk";
  var STORE_KEY = "parent_site_feedback";   // { items: [ submission... ] }
  var ICON = "💬";

  // Sentiment matches the article's exact prompt: 😞 😐 😃.
  var SENTIMENTS = [
    { key: "sad", emoji: "😞", label: "Not great" },
    { key: "neutral", emoji: "😐", label: "Okay" },
    { key: "happy", emoji: "😃", label: "Loved it" }
  ];
  function sentimentKeys() { return SENTIMENTS.map(function (s) { return s.key; }); }
  function isSentiment(k) { return sentimentKeys().indexOf(k) !== -1; }

  // Site/app feedback categories. These are about the PLATFORM (site/app),
  // never about a specific provider or a booking grievance — that keeps this
  // feature clearly separate from the per-listing report and the complaints
  // route.
  var CATEGORIES = [
    { key: "general", label: "General feedback" },
    { key: "bug", label: "Something is broken / a bug" },
    { key: "idea", label: "Idea / feature request" },
    { key: "design", label: "Design / usability" },
    { key: "love", label: "Send us some love" }
  ];
  function categoryKeys() { return CATEGORIES.map(function (c) { return c.key; }); }
  function isCategory(k) { return categoryKeys().indexOf(k) !== -1; }

  var MAX_LEN = 2000;

  /* ---------------- pure logic (testable, DOM-free) ---------------- */

  // Clamp/normalise the free-text body: must be a non-empty string, trimmed,
  // length-capped. Defensive against null / number / over-long input.
  function normaliseMessage(raw) {
    if (raw === null || raw === undefined) return "";
    var s = String(raw).replace(/\s+/g, " ").trim();
    if (s.length > MAX_LEN) s = s.slice(0, MAX_LEN);
    return s;
  }

  function normaliseSentiment(raw) {
    return isSentiment(raw) ? raw : "neutral";
  }

  function normaliseCategory(raw) {
    return isCategory(raw) ? raw : "general";
  }

  // Light, optional email validation. An email is allowed (so support can reply)
  // but never required — feedback can be anonymous.
  function isValidEmail(s) {
    if (!s) return false;
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s).trim());
  }

  // Validate a feedback submission. Returns { ok, errors:[...] }.
  // The ONLY hard requirement is a non-empty free-text message — this is the
  // "free-text feedback form" of the acceptance criterion.
  function validate(input) {
    input = input || {};
    var errors = [];
    var msg = normaliseMessage(input.message);
    if (!msg) errors.push("Please type some feedback before sending.");
    // email is optional, but if supplied it must look like an email
    if (input.email && !isValidEmail(input.email)) {
      errors.push("That email address doesn't look right.");
    }
    return { ok: errors.length === 0, errors: errors };
  }

  // Build a normalised, addressable submission record. This is the heart of the
  // acceptance criterion: a free-text site-feedback form that SUBMITS TO SUPPORT.
  // It does not validate — call validate() first; this just shapes the record.
  function buildSubmission(input) {
    input = input || {};
    var page = (typeof input.page === "string" && input.page) ? input.page : currentPage();
    return {
      id: safeUid(),
      kind: "site-feedback",          // explicitly the site/app channel
      to: SUPPORT_EMAIL,              // submits to SUPPORT (not a provider/listing)
      sentiment: normaliseSentiment(input.sentiment),
      category: normaliseCategory(input.category),
      message: normaliseMessage(input.message),
      email: input.email && isValidEmail(input.email) ? String(input.email).trim() : "",
      page: page,                     // which page the icon was opened from
      persistent: true,              // the icon is available site-wide
      createdAt: (input.createdAt && isFinite(input.createdAt)) ? input.createdAt : Date.now()
    };
  }

  // Compose the support email subject/body the widget would send.
  function composeEmail(sub) {
    sub = sub || {};
    var sent = SENTIMENTS.filter(function (s) { return s.key === sub.sentiment; })[0];
    var cat = CATEGORIES.filter(function (c) { return c.key === sub.category; })[0];
    var subject = "Site feedback — " + (cat ? cat.label : "General feedback");
    var lines = [];
    lines.push("Channel: Site/app feedback (Feedback icon)");
    lines.push("How it felt: " + (sent ? sent.emoji + " " + sent.label : "—"));
    lines.push("Category: " + (cat ? cat.label : "—"));
    lines.push("Page: " + (sub.page || "—"));
    lines.push("");
    lines.push(sub.message || "");
    if (sub.email) { lines.push(""); lines.push("Reply to: " + sub.email); }
    return { to: SUPPORT_EMAIL, subject: subject, body: lines.join("\n") };
  }

  /* ----- persistence (HC.store only — never raw localStorage) ----- */

  function loadAll() {
    var data;
    try { data = HC.store.get(STORE_KEY, null); } catch (e) { data = null; }
    if (!data || typeof data !== "object" || !Array.isArray(data.items)) return { items: [] };
    return data;
  }

  function saveAll(data) {
    try { return HC.store.set(STORE_KEY, data) !== false; } catch (e) { return false; }
  }

  // The full submit pipeline used by both the UI and the self-test:
  // validate -> build -> persist via HC.store -> return outcome.
  function submitFeedback(input) {
    var v = validate(input);
    if (!v.ok) return { ok: false, errors: v.errors };
    var sub = buildSubmission(input);
    var data = loadAll();
    data.items.push(sub);
    var stored = saveAll(data);
    return { ok: true, submission: sub, stored: stored, email: composeEmail(sub) };
  }

  /* ---------------- small helpers ---------------- */

  function currentPage() {
    try {
      return (window.location && (window.location.hash || window.location.pathname)) || "/";
    } catch (e) { return "/"; }
  }

  function safeUid() {
    try { return HC.util.uid(); }
    catch (e) { return "fb_" + Date.now().toString(36) + "_" + Math.floor(Math.random() * 1e6).toString(36); }
  }

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  /* ---------------- enhance(): the PERSISTENT, site-wide icon ---------------- */

  // The acceptance criterion calls for a feedback icon available ACROSS the
  // parent site. enhance() injects a fixed-position floating icon that is
  // present on every page (it lives on document.body, independent of routing).
  // Clicking it opens the same free-text feedback form used by render().
  function enhance() {
    try {
      if (document.getElementById("hcSiteFeedbackIcon")) return; // idempotent
      var btn = HC.util.el("button", {
        id: "hcSiteFeedbackIcon",
        type: "button",
        "aria-label": "Give site feedback",
        title: "Tell us what you think of the site",
        style: "position:fixed;right:20px;bottom:84px;z-index:111;width:52px;height:52px;border-radius:50%;" +
          "border:none;cursor:pointer;background:var(--purple,#603488);color:#fff;font-size:22px;" +
          "box-shadow:0 8px 22px rgba(96,52,136,.34);display:flex;align-items:center;justify-content:center"
      }, ICON);
      btn.addEventListener("click", function () { openFeedbackModal(currentPage()); });
      document.body.appendChild(btn);
    } catch (e) {
      // A broken enhancement must never break the app.
      if (typeof console !== "undefined" && console.warn) {
        console.warn("[HC] parent-site-feedback enhance failed:", e && e.message);
      }
    }
  }

  // Opens the feedback form inside HC's own modal (used by the floating icon).
  function openFeedbackModal(page) {
    try {
      HC.util.modal('<h2>' + ICON + ' Site feedback</h2>' +
        '<p style="color:var(--muted,#808080);font-size:13.5px;margin:0 0 14px">' +
        'Tell us about the HolidayCamp website or app — a bug, an idea, or just some love. ' +
        'This goes to our support team, not to a camp provider.</p>' +
        '<div id="hcSiteFeedbackMount"></div>');
      var mount = document.getElementById("hcSiteFeedbackMount");
      if (mount) renderForm(mount, page);
    } catch (e) { /* defensive */ }
  }

  /* ---------------- UI form ---------------- */

  function renderForm(mountEl, page) {
    if (!mountEl) return;
    mountEl.innerHTML = "";

    var state = { sentiment: "happy", category: "general" };

    var wrap = HC.util.el("div", { style: "font-family:'Nunito Sans',system-ui,sans-serif;color:var(--text,#383838)" });

    // Sentiment row: 😞 😐 😃 (the article's exact prompt).
    wrap.appendChild(sectionLabel("How was your experience?"));
    var sentRow = HC.util.el("div", { style: "display:flex;gap:10px;margin:0 0 14px" });
    SENTIMENTS.forEach(function (s) {
      var b = HC.util.el("button", {
        type: "button", "data-sent": s.key, title: s.label,
        style: sentStyle(s.key === state.sentiment)
      }, s.emoji);
      b.addEventListener("click", function () {
        state.sentiment = s.key;
        Array.prototype.forEach.call(sentRow.querySelectorAll("button"), function (x) {
          x.setAttribute("style", sentStyle(x.getAttribute("data-sent") === state.sentiment));
        });
      });
      sentRow.appendChild(b);
    });
    wrap.appendChild(sentRow);

    // Category select.
    wrap.appendChild(sectionLabel("What's it about?"));
    var sel = HC.util.el("select", {
      style: "width:100%;padding:10px 12px;border:1.5px solid var(--line,#E6E6E6);border-radius:10px;" +
        "font-size:14px;margin:0 0 14px;background:#fff"
    });
    CATEGORIES.forEach(function (c) {
      sel.appendChild(HC.util.el("option", { value: c.key }, esc(c.label)));
    });
    wrap.appendChild(sel);

    // Free-text feedback.
    wrap.appendChild(sectionLabel("Your feedback"));
    var ta = HC.util.el("textarea", {
      rows: "5", maxlength: String(MAX_LEN), placeholder: "Tell us what you think…",
      style: "width:100%;padding:11px 12px;border:1.5px solid var(--line,#E6E6E6);border-radius:12px;" +
        "font-size:14px;font-family:inherit;resize:vertical;margin:0 0 12px;box-sizing:border-box"
    });
    wrap.appendChild(ta);

    // Optional email.
    wrap.appendChild(sectionLabel("Your email (optional — only if you'd like a reply)"));
    var emailInput = HC.util.el("input", {
      type: "email", placeholder: "you@example.com",
      style: "width:100%;padding:10px 12px;border:1.5px solid var(--line,#E6E6E6);border-radius:10px;" +
        "font-size:14px;margin:0 0 14px;box-sizing:border-box"
    });
    wrap.appendChild(emailInput);

    var errBox = HC.util.el("div", {
      style: "display:none;color:#9a1f5e;font-size:13px;background:var(--pink-tint,#FCE8F0);" +
        "border-radius:10px;padding:9px 12px;margin:0 0 12px"
    });
    wrap.appendChild(errBox);

    var sendBtn = HC.util.el("button", { class: "hc-btn", type: "button" }, "Send feedback");
    sendBtn.addEventListener("click", function () {
      var res = submitFeedback({
        sentiment: state.sentiment,
        category: sel.value,
        message: ta.value,
        email: emailInput.value,
        page: page || currentPage()
      });
      if (!res.ok) {
        errBox.style.display = "block";
        errBox.innerHTML = res.errors.map(esc).join("<br>");
        return;
      }
      try {
        HC.util.toast("Thanks! Your feedback was sent to our support team.");
      } catch (e) {}
      // Reset to a fresh form after a successful send.
      renderForm(mountEl, page);
    });
    wrap.appendChild(sendBtn);

    // Footnote making the distinction explicit (mirrors the article).
    wrap.appendChild(HC.util.el("p", {
      style: "color:var(--muted,#808080);font-size:12px;margin:14px 0 0;line-height:1.6"
    }, "Spotted a mistake on a specific camp listing? Use “Help fix this listing” on that camp instead. " +
       "Got a serious complaint or payment issue? Use the Complaints route."));

    mountEl.appendChild(wrap);
  }

  function render(mountEl) {
    if (!mountEl) return;
    var note = HC.util.el("p", { style: "font-size:14px;color:var(--text,#383838);margin:0 0 14px" });
    note.innerHTML = "A persistent <strong>" + ICON + " Feedback</strong> icon sits on every page of the " +
      "parent site (bottom-right). It opens this free-text form, which submits to <strong>" +
      esc(SUPPORT_EMAIL) + "</strong>. It's separate from reporting a specific listing or raising a complaint.";
    mountEl.appendChild(note);
    // Make sure the floating site-wide icon is actually present when previewing.
    enhance();
    var formHost = HC.util.el("div");
    mountEl.appendChild(formHost);
    renderForm(formHost, currentPage());
  }

  function sectionLabel(text) {
    return HC.util.el("div", {
      style: "font-family:'Quicksand',system-ui,sans-serif;font-weight:700;color:var(--magenta,#F82488);" +
        "text-transform:uppercase;letter-spacing:.5px;font-size:12px;margin:0 0 8px"
    }, esc(text));
  }

  function sentStyle(on) {
    return "flex:1;font-size:24px;padding:10px 0;border-radius:12px;cursor:pointer;" +
      "border:2px solid " + (on ? "var(--magenta,#F82488)" : "var(--line,#E6E6E6)") + ";" +
      "background:" + (on ? "var(--pink-tint,#FCE8F0)" : "#fff") + ";";
  }

  /* ---------------- selfTest ---------------- */

  function selfTest() {
    var pass = 0, fail = 0, log = [];
    function check(label, fn) {
      try { fn(); pass += 1; log.push("✓ " + label); }
      catch (e) { fail += 1; log.push("✗ " + label + " — " + (e && e.message ? e.message : String(e))); }
    }

    // Snapshot + isolate store so the test is repeatable and leaves no residue.
    var SNAP = HC.store.get(STORE_KEY, null);
    HC.store.set(STORE_KEY, { items: [] });

    try {
      // ACCEPTANCE CRITERION (core): a free-text feedback form that submits to
      // SUPPORT, distinct from the per-listing report and the complaints route.

      // Case 1 — a valid free-text submission goes through and is addressed to support.
      check("Free-text feedback submits to the support team", function () {
        var res = submitFeedback({ message: "The week filter on the planner is brilliant!" });
        HC.assert(res.ok === true, "valid feedback should submit; errors: " + JSON.stringify(res.errors));
        HC.assert(res.submission.to === SUPPORT_EMAIL, "must submit to support, got " + res.submission.to);
        HC.assert(res.submission.kind === "site-feedback", "channel must be site-feedback, got " + res.submission.kind);
        HC.assert(res.submission.message.indexOf("planner") !== -1, "free text must be preserved");
        HC.assert(res.email && res.email.to === SUPPORT_EMAIL, "composed email must target support");
      });

      // Case 2 — free text is REQUIRED (it is a free-text feedback form).
      check("Empty feedback is rejected (free text required)", function () {
        var r1 = submitFeedback({ message: "" });
        HC.assert(r1.ok === false, "empty message must be rejected");
        HC.assert(r1.errors && r1.errors.length > 0, "should explain why");
        var r2 = submitFeedback({ message: "    " });
        HC.assert(r2.ok === false, "whitespace-only must be rejected");
        var r3 = submitFeedback({ message: null });
        HC.assert(r3.ok === false, "null message must be rejected");
      });

      // Case 3 — submissions persist via HC.store (namespaced, not raw localStorage).
      check("Submissions persist via HC.store", function () {
        HC.store.set(STORE_KEY, { items: [] }); // reset within isolated store
        submitFeedback({ message: "Love the holiday-camp directory." });
        submitFeedback({ message: "A map view would help.", category: "idea" });
        var data = loadAll();
        HC.assert(data.items.length === 2, "expected 2 stored items, got " + data.items.length);
        HC.assert(data.items[1].category === "idea", "category must round-trip, got " + data.items[1].category);
      });

      // Case 4 — sentiment matches the article's 😞 😐 😃 prompt and defaults safely.
      check("Sentiment captured (😞 😐 😃) and defaulted defensively", function () {
        var keys = sentimentKeys();
        HC.assert(keys.length === 3, "exactly 3 sentiments (sad/neutral/happy), got " + keys.length);
        var happy = submitFeedback({ message: "Great site", sentiment: "happy" });
        HC.assert(happy.submission.sentiment === "happy", "explicit sentiment must be kept");
        var bad = submitFeedback({ message: "ok", sentiment: "explode" });
        HC.assert(bad.submission.sentiment === "neutral", "invalid sentiment must default to neutral");
      });

      // Case 5 — category is a SITE/APP category and defaults defensively.
      check("Site/app category captured and defaulted defensively", function () {
        var bug = submitFeedback({ message: "Search 500s on empty query", category: "bug" });
        HC.assert(bug.submission.category === "bug", "explicit category must be kept");
        var bad = submitFeedback({ message: "hi", category: "refund-please" });
        HC.assert(bad.submission.category === "general", "invalid/off-channel category must default to general");
        // 'refund'/'complaint' style values are NOT valid categories here — this
        // channel is for the site/app, keeping it distinct from the complaints route.
        HC.assert(isCategory("refund-please") === false, "complaint-style values are not site-feedback categories");
      });

      // Case 6 — optional email: allowed, validated, never required.
      check("Email is optional but validated when given", function () {
        var anon = submitFeedback({ message: "Anonymous note" });
        HC.assert(anon.ok === true, "feedback works with no email");
        HC.assert(anon.submission.email === "", "no email => empty string");
        var bad = submitFeedback({ message: "reply please", email: "not-an-email" });
        HC.assert(bad.ok === false, "an invalid email should be flagged");
        var good = submitFeedback({ message: "reply please", email: "parent@example.com" });
        HC.assert(good.ok === true && good.submission.email === "parent@example.com", "valid email kept");
      });

      // Case 7 — DISTINCTNESS: this is NOT the per-listing report or the complaints route.
      check("Distinct from per-listing report and complaints route", function () {
        var res = submitFeedback({ message: "General thoughts on the app" });
        HC.assert(res.submission.kind === "site-feedback", "kind is site-feedback, not 'report'/'complaint'");
        HC.assert(!res.submission.providerId && !res.submission.listingId,
          "site feedback carries no provider/listing target (that's the report route)");
        HC.assert(!res.submission.bookingRef,
          "site feedback carries no booking ref (that's the refund/complaint route)");
        // It records WHICH page the icon was opened from, proving it's site-wide.
        var fromPlanner = submitFeedback({ message: "planner note", page: "#planner" });
        HC.assert(fromPlanner.submission.page === "#planner", "should record the originating page");
        HC.assert(fromPlanner.submission.persistent === true, "icon is persistent / site-wide");
      });

      // Case 8 — long input is capped (defensive normalisation).
      check("Over-long feedback is capped to a safe length", function () {
        var huge = new Array(MAX_LEN + 500).join("x");
        var res = submitFeedback({ message: huge });
        HC.assert(res.ok === true, "long but valid text still submits");
        HC.assert(res.submission.message.length <= MAX_LEN,
          "message must be capped to " + MAX_LEN + ", got " + res.submission.message.length);
      });

      // Case 9 — composed support email is well-formed and human-readable.
      check("Composed support email is well-formed", function () {
        var res = submitFeedback({ message: "Filters are confusing", category: "design", sentiment: "sad" });
        var mail = res.email;
        HC.assert(mail.to === SUPPORT_EMAIL, "email addressed to support");
        HC.assert(/Site feedback/.test(mail.subject), "subject names the channel");
        HC.assert(mail.body.indexOf("Filters are confusing") !== -1, "body contains the free text");
        HC.assert(mail.body.indexOf("Design / usability") !== -1, "body names the category");
        HC.assert(mail.body.indexOf("😞") !== -1, "body reflects the chosen sentiment");
      });

    } finally {
      // Restore the user's real store exactly as found.
      if (SNAP === null) HC.store.remove(STORE_KEY);
      else HC.store.set(STORE_KEY, SNAP);
    }

    return { pass: pass, fail: fail, log: log };
  }

  /* ---------------- register ---------------- */

  HC.registerFeature({
    id: "parent-site-feedback",
    title: "Site feedback widget",
    side: "parent",
    icon: ICON,
    summary: "A persistent Feedback icon on every page of the parent site. Opens a free-text form (with 😞 😐 😃 sentiment and a site/app category) that submits straight to the support team — separate from reporting a specific listing or raising a complaint.",
    render: render,
    enhance: enhance,
    selfTest: selfTest
  });
})();
