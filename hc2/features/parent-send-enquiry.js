/* HolidayCamp feature: parent-send-enquiry
 * ------------------------------------------------------------------
 * Replicates Happity's "Send an enquiry" behaviour for camps that are
 * NOT bookable through the platform.
 *
 * Evidence (support article 8255669, "How to book a class and what to
 * do if the class is not bookable?"):
 *   - "If a class is not bookable through Happity you can use the
 *      'Send an enquiry' button to contact them..."
 *   - "You will be asked to enter your details and a message will be
 *      sent to the class provider letting them know you have asked
 *      about their class. The class provider will then be in touch..."
 *   - The same form is the fallback for parties and drop-in checks.
 * (also: 02-ia-ux §4.1)
 *
 * Side: parent. Framed for SCHOOL-AGE HOLIDAY CAMPS (day / full-week
 * places), not baby classes.
 *
 * ACCEPTANCE CRITERION (asserted in selfTest):
 *   Non-bookable camps show an enquiry form capturing the parent's
 *   message + contact. Bookable camps do NOT show it (they would book
 *   directly instead).
 *
 * Our live camp data (camps.js) has no structured "bookable" flag, so
 * bookability is DERIVED from the free-text `booking` string, exactly
 * the way Happity decides whether a listing has a working "Book Now"
 * tab. Camps routed through a known booking platform (ClassForKids,
 * MagicBooking, Pebble, Enrolmy, Eequ, etc.) are bookable; camps that
 * say "contact ...", point at Instagram/Facebook, a bare email/phone,
 * a Google form, or "register interest / watch the page" are NOT
 * bookable through the platform and therefore surface the enquiry form.
 *
 * Defensive: nothing here throws at registration time. Persistence is
 * via HC.store only (the parent's saved contact details + a log of
 * sent enquiries); no global localStorage keys are written.
 * ------------------------------------------------------------------ */
(function () {
  "use strict";

  if (typeof window === "undefined" || !window.HC || typeof window.HC.registerFeature !== "function") {
    // Core not present — fail silently rather than throwing.
    return;
  }
  var HC = window.HC;

  var STORE_CONTACT = "enquiry_contact";   // parent's saved name/email/phone
  var STORE_LOG = "enquiry_log";           // array of sent enquiries (mock outbox)

  /* ============================================================
   * 1. Bookability classification (the "is there a Book Now tab?"
   *    decision). Pure + deterministic so selfTest can assert it.
   * ============================================================ */

  // Phrases in the booking text that indicate a real platform booking
  // flow exists (=> "Book Now", NOT enquiry-only).
  var BOOKABLE_SIGNALS = [
    "classforkids", "magicbooking", "pebble", "enrolmy", "pembee",
    "ipal", "better online", "better app", "booking calendar",
    "booking portal", "booking platform", "booking system",
    "shopfront", "book through", "book the", "book via", "book by age",
    "book single", "book each", "book minis", "book holiday",
    "enrol", "application form", "booking form"
  ];

  // Phrases that mean "you can't book here — contact the provider"
  // (=> enquiry-only). These take precedence over weak booking signals.
  var ENQUIRY_SIGNALS = [
    "contact ", "instagram", "facebook", "social listing", "google form",
    "register interest", "watch the", "to appear", "linktree", "linked from",
    "email shown", "check happity"
  ];

  // Detect a bare phone number or a raw email address in the text — both
  // are Happity's classic "no online booking, get in touch" markers.
  var PHONE_RE = /\b0\d[\d\s]{7,}\d\b/;            // UK-ish phone
  var EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;

  function bookingText(provider) {
    return String((provider && provider.booking) || "").toLowerCase();
  }

  // Returns { bookable:Boolean, reason:String }.
  function classifyBookability(provider) {
    var t = bookingText(provider);
    if (!t) {
      // No booking guidance at all => safest fallback is "enquire".
      return { bookable: false, reason: "no-booking-info" };
    }

    var enquiryHit = ENQUIRY_SIGNALS.some(function (s) { return t.indexOf(s) !== -1; });
    var phoneOrEmail = PHONE_RE.test(t) || EMAIL_RE.test(t);

    // Strong enquiry signal: contact-only, social-only, a bare phone/email,
    // or a "not live yet / watch the page" listing. Wins over book signals.
    if (enquiryHit || phoneOrEmail) {
      return { bookable: false, reason: phoneOrEmail ? "direct-contact" : "enquiry-only" };
    }

    var bookableHit = BOOKABLE_SIGNALS.some(function (s) { return t.indexOf(s) !== -1; });
    if (bookableHit) return { bookable: true, reason: "platform-booking" };

    // Unknown route => enquiry fallback (Happity shows the enquiry button
    // whenever a working Book Now flow is not present).
    return { bookable: false, reason: "unknown-route" };
  }

  function isBookable(provider) { return classifyBookability(provider).bookable === true; }

  // Whether the "Send an enquiry" form should be shown for this camp.
  function shouldShowEnquiry(provider) { return !isBookable(provider); }

  /* ============================================================
   * 2. Enquiry validation + build (what selfTest exercises).
   *    Mirrors Happity: parent enters DETAILS (name + contact) and a
   *    MESSAGE; a message is then "sent" to the provider.
   * ============================================================ */

  var EMAIL_VALID_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  var PHONE_VALID_RE = /^[\d\s()+-]{7,}$/;

  function cleanStr(v) { return String(v == null ? "" : v).trim(); }

  // Validate an enquiry payload.
  // Returns { ok:Boolean, errors:{field:msg}, value:{...normalised} }.
  function validateEnquiry(input) {
    input = input || {};
    var name = cleanStr(input.name);
    var email = cleanStr(input.email);
    var phone = cleanStr(input.phone);
    var message = cleanStr(input.message);
    var child = cleanStr(input.childName);
    var childAge = input.childAge === "" || input.childAge == null ? null : Number(input.childAge);

    var errors = {};

    // CONTACT capture — name + at least one reachable channel.
    if (!name) errors.name = "Please enter your name.";
    var hasEmail = !!email;
    var hasPhone = !!phone;
    if (!hasEmail && !hasPhone) {
      errors.contact = "Add an email or phone so the camp can reply.";
    } else {
      if (hasEmail && !EMAIL_VALID_RE.test(email)) errors.email = "That email doesn’t look right.";
      if (hasPhone && !PHONE_VALID_RE.test(phone)) errors.phone = "That phone number doesn’t look right.";
    }

    // MESSAGE capture — Happity sends the parent's note to the provider.
    if (!message) errors.message = "Add a short message for the camp.";
    else if (message.length < 5) errors.message = "Your message is a little short.";
    else if (message.length > 1000) errors.message = "Please keep your message under 1000 characters.";

    // Optional child age sanity (school-age framing 4–17).
    if (childAge !== null) {
      if (!isFinite(childAge) || childAge < 4 || childAge > 17) {
        errors.childAge = "Enter your child’s age (4–17) or leave blank.";
      }
    }

    var ok = Object.keys(errors).length === 0;
    return {
      ok: ok,
      errors: errors,
      value: ok ? {
        name: name,
        email: hasEmail ? email : null,
        phone: hasPhone ? phone : null,
        message: message,
        childName: child || null,
        childAge: childAge
      } : null
    };
  }

  // "Send" an enquiry to a provider. Defensive: only sends for camps
  // that are genuinely not bookable (the Happity rule), and only when
  // the payload validates. Persists to a mock outbox via HC.store and
  // returns a receipt; never throws.
  function sendEnquiry(provider, input, opts) {
    opts = opts || {};
    if (!provider || !provider.id) {
      return { ok: false, reason: "no-provider", message: "No camp selected." };
    }
    if (isBookable(provider) && !opts.force) {
      // Bookable camps go through Book Now, not the enquiry form.
      return {
        ok: false,
        reason: "bookable",
        message: "This camp can be booked directly — no enquiry needed."
      };
    }

    var v = validateEnquiry(input);
    if (!v.ok) {
      return { ok: false, reason: "invalid", errors: v.errors, message: "Please fix the highlighted fields." };
    }

    var receipt = {
      id: safeUid(),
      providerId: provider.id,
      providerName: provider.name || provider.id,
      name: v.value.name,
      email: v.value.email,
      phone: v.value.phone,
      childName: v.value.childName,
      childAge: v.value.childAge,
      message: v.value.message,
      sentAt: opts.now || new Date().toISOString()
    };

    // Mock "send": append to the parent's enquiry log + remember contact.
    try {
      var log = HC.store.get(STORE_LOG, []);
      if (!Array.isArray(log)) log = [];
      log.push(receipt);
      HC.store.set(STORE_LOG, log);
    } catch (e) { /* persistence is best-effort */ }

    try {
      HC.store.set(STORE_CONTACT, {
        name: v.value.name, email: v.value.email, phone: v.value.phone
      });
    } catch (e) { /* ignore */ }

    return {
      ok: true,
      receipt: receipt,
      message: "Enquiry sent to " + receipt.providerName + " — they’ll be in touch."
    };
  }

  function safeUid() {
    try { return HC.util.uid(); } catch (e) { return "enq_" + Date.now() + "_" + Math.random().toString(36).slice(2); }
  }

  /* ============================================================
   * 3. Live-data helpers — find real non-bookable school-age camps.
   * ============================================================ */

  function allProviders() {
    try { return HC.data.providers || []; } catch (e) { return []; }
  }

  function nonBookableCamps() {
    return allProviders().filter(shouldShowEnquiry);
  }

  function bookableCamps() {
    return allProviders().filter(isBookable);
  }

  /* ============================================================
   * 4. UI — a camp detail panel that swaps "Book Now" for the
   *    "Send an enquiry" form when the camp is not bookable.
   * ============================================================ */

  function esc(s) {
    return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
  function escAttr(s) { return esc(s).replace(/"/g, "&quot;"); }

  function render(mountEl) {
    try {
      // Build the camp picker: non-bookable first (these show the form),
      // then a couple of bookable ones to demonstrate the contrast.
      var nb = nonBookableCamps();
      var bk = bookableCamps();
      var demoList = nb.slice(0, 12).concat(bk.slice(0, 4));
      if (!demoList.length) {
        demoList = [{ id: "demo", name: "Demo Holiday Camp", booking: "Contact the organiser via Instagram." }];
      }

      var saved = {};
      try { saved = HC.store.get(STORE_CONTACT, {}) || {}; } catch (e) { saved = {}; }

      var options = demoList.map(function (c, i) {
        var cls = classifyBookability(c);
        var tag = cls.bookable ? " (bookable — Book Now)" : " (enquiry only)";
        return '<option value="' + i + '">' + escAttr(c.name) + escAttr(tag) + "</option>";
      }).join("");

      mountEl.innerHTML =
        '<div style="font-family:\'Nunito Sans\',system-ui,sans-serif;color:var(--text,#383838)">' +
          '<p style="font-size:14px;margin:0 0 14px">When a holiday camp can’t be booked through the platform, ' +
          'the <strong>Book&nbsp;Now</strong> button is replaced by a <strong>Send an enquiry</strong> form. ' +
          'Pick a camp to see which it gets.</p>' +

          '<label style="display:block;font-weight:700;font-size:13px;margin-bottom:4px">Holiday camp</label>' +
          '<select id="enqCamp" style="width:100%;padding:9px;border:1.5px solid var(--line,#E6E6E6);border-radius:12px;font-size:14px;margin-bottom:14px">' +
            options +
          "</select>" +

          '<div id="enqPanel"></div>' +
        "</div>";

      var $ = function (id) { return mountEl.querySelector("#" + id); };

      function currentCamp() {
        var idx = Math.max(0, parseInt($("enqCamp").value, 10) || 0);
        return demoList[idx] || demoList[0];
      }

      function bookNowPanel(camp) {
        return '<div style="background:#E1F0E4;border-radius:14px;padding:16px">' +
          '<div style="font-family:\'Quicksand\',system-ui,sans-serif;font-weight:700;color:#2f7d4f;font-size:15px;margin-bottom:6px">' +
            "✓ Bookable through the platform</div>" +
          '<p style="font-size:13.5px;margin:0 0 12px">' + esc(camp.booking || "") + "</p>" +
          '<button type="button" class="hc-btn" disabled style="opacity:.9">Book Now</button>' +
        "</div>";
      }

      function enquiryFormPanel(camp) {
        return '<div style="border:1.5px solid var(--line,#E6E6E6);border-radius:14px;padding:16px">' +
          '<div style="font-family:\'Quicksand\',system-ui,sans-serif;font-weight:700;color:var(--purple,#603488);font-size:15px;margin-bottom:2px">' +
            "✉️ Send an enquiry</div>" +
          '<p style="font-size:12.5px;color:var(--muted,#808080);margin:0 0 14px">' +
            "This camp isn’t bookable here. Enter your details and a message will be sent to the camp — they’ll be in touch." +
            ' <em>(' + esc(camp.booking || "Contact the camp directly.") + ')</em></p>' +

          fieldRow("Your name", '<input id="enqName" type="text" value="' + escAttr(saved.name || "") + '" placeholder="e.g. Sam Carter" ' + inputStyle() + ">", "enqErrName") +

          '<div style="display:flex;gap:10px">' +
            '<div style="flex:1">' + fieldRow("Email", '<input id="enqEmail" type="email" value="' + escAttr(saved.email || "") + '" placeholder="you@example.com" ' + inputStyle() + ">", "enqErrEmail") + "</div>" +
            '<div style="flex:1">' + fieldRow("Phone", '<input id="enqPhone" type="tel" value="' + escAttr(saved.phone || "") + '" placeholder="07…" ' + inputStyle() + ">", "enqErrPhone") + "</div>" +
          "</div>" +
          '<div id="enqErrContact" style="font-size:12px;color:#9a1f5e;margin:-6px 0 10px;min-height:14px"></div>' +

          '<div style="display:flex;gap:10px">' +
            '<div style="flex:2">' + fieldRow("Child’s name (optional)", '<input id="enqChild" type="text" placeholder="e.g. Ada" ' + inputStyle() + ">", "enqErrChild") + "</div>" +
            '<div style="flex:1">' + fieldRow("Age (optional)", '<input id="enqAge" type="number" min="4" max="17" placeholder="8" ' + inputStyle() + ">", "enqErrAge") + "</div>" +
          "</div>" +

          fieldRow("Your message",
            '<textarea id="enqMsg" rows="3" placeholder="Hi! Is there space for week 3 (3–7 Aug) for an 8-year-old? Found you on HolidayCamp." ' +
            inputStyle() + ">Hi! Is there space this summer, and how do I book? Found you on HolidayCamp.</textarea>",
            "enqErrMsg") +

          '<button id="enqSend" type="button" class="hc-btn" style="margin-top:4px">Send enquiry</button>' +
          '<div id="enqResult" style="font-size:13px;margin-top:10px;min-height:18px"></div>' +
        "</div>";
      }

      function inputStyle() {
        return 'style="width:100%;box-sizing:border-box;padding:9px;border:1.5px solid var(--line,#E6E6E6);border-radius:12px;font-size:14px;font-family:inherit"';
      }
      function fieldRow(label, control, errId) {
        return '<label style="display:block;font-weight:700;font-size:12.5px;margin-bottom:4px">' + esc(label) + "</label>" +
          control +
          '<div id="' + errId + '" style="font-size:12px;color:#9a1f5e;margin:2px 0 10px;min-height:14px"></div>';
      }

      function paintErrors(errors) {
        var map = {
          name: "enqErrName", email: "enqErrEmail", phone: "enqErrPhone",
          contact: "enqErrContact", message: "enqErrMsg", childAge: "enqErrAge"
        };
        Object.keys(map).forEach(function (k) {
          var n = $(map[k]);
          if (n) n.textContent = (errors && errors[k]) ? errors[k] : "";
        });
      }

      function paintPanel() {
        var camp = currentCamp();
        var host = $("enqPanel");
        if (isBookable(camp)) {
          host.innerHTML = bookNowPanel(camp);
          return;
        }
        host.innerHTML = enquiryFormPanel(camp);

        $("enqSend").addEventListener("click", function () {
          var input = {
            name: $("enqName").value,
            email: $("enqEmail").value,
            phone: $("enqPhone").value,
            childName: $("enqChild").value,
            childAge: $("enqAge").value,
            message: $("enqMsg").value
          };
          paintErrors(null);
          var res = sendEnquiry(camp, input);
          var out = $("enqResult");
          if (res.ok) {
            out.style.color = "#2f7d4f";
            out.textContent = "✓ " + res.message;
            try { HC.util.toast("Enquiry sent to " + (camp.name || "camp")); } catch (e) {}
          } else if (res.reason === "invalid") {
            paintErrors(res.errors);
            out.style.color = "#9a1f5e";
            out.textContent = res.message;
          } else {
            out.style.color = "#9a1f5e";
            out.textContent = res.message;
          }
        });
      }

      $("enqCamp").addEventListener("change", paintPanel);
      paintPanel();
    } catch (e) {
      mountEl.innerHTML = '<p style="color:#9a1f5e">Enquiry form failed to load: ' +
        esc(e && e.message ? e.message : String(e)) + "</p>";
    }
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

    // Deterministic fixtures so the test does not depend on live data.
    var bookableCamp = { id: "fix-book", name: "Fixture Sports Camp", booking: "Book through the ClassForKids summer camp listing." };
    var enquiryCamp = { id: "fix-enq", name: "Fixture Social Camp", booking: "Contact through Instagram/Facebook or email shown on social listing." };
    var phoneCamp = { id: "fix-phone", name: "Vestry Fixture", booking: "Contact Vestry on 07933 314 415 or someone@gmail.com to book summer." };
    var emptyCamp = { id: "fix-empty", name: "No-Info Camp", booking: "" };

    // --- Bookability classification (drives whether the form shows). ---
    check("ClassForKids camp classifies as bookable (Book Now, not enquiry)", function () {
      HC.assert(isBookable(bookableCamp) === true, "platform-booked camp should be bookable");
      HC.assert(shouldShowEnquiry(bookableCamp) === false, "bookable camp must NOT show the enquiry form");
    });

    check("Instagram/contact-only camp classifies as NOT bookable", function () {
      HC.assert(isBookable(enquiryCamp) === false, "social/contact camp should not be bookable");
      HC.assert(shouldShowEnquiry(enquiryCamp) === true, "non-bookable camp MUST show the enquiry form");
    });

    check("Bare phone/email camp routes to enquiry (direct-contact)", function () {
      var cls = classifyBookability(phoneCamp);
      HC.assert(cls.bookable === false, "a phone/email-only camp is not platform-bookable");
      HC.assert(cls.reason === "direct-contact", "reason should be 'direct-contact', got " + cls.reason);
    });

    check("Camp with no booking info falls back to enquiry", function () {
      HC.assert(shouldShowEnquiry(emptyCamp) === true, "missing booking info should show enquiry as the safe fallback");
    });

    // --- ACCEPTANCE: the enquiry form captures MESSAGE + CONTACT. ---
    check("ACCEPTANCE — non-bookable camp accepts an enquiry with message + email contact", function () {
      var res = sendEnquiry(enquiryCamp, {
        name: "Sam Carter",
        email: "sam@example.com",
        message: "Is there space for week 3 for an 8-year-old?"
      });
      HC.assert(res.ok === true, "valid enquiry to a non-bookable camp should send: " + (res.message || res.reason));
      HC.assert(res.receipt.message.indexOf("week 3") !== -1, "the parent's MESSAGE must be captured");
      HC.assert(res.receipt.email === "sam@example.com", "the parent's CONTACT must be captured");
      HC.assert(res.receipt.providerId === enquiryCamp.id, "enquiry must be addressed to the right camp");
    });

    check("Phone is accepted as the contact channel (no email)", function () {
      var res = sendEnquiry(phoneCamp, {
        name: "Jo Patel",
        phone: "07700 900123",
        message: "Could I book a place for my daughter this August?"
      }, { force: true }); // force not needed (non-bookable) but harmless
      HC.assert(res.ok === true, "phone-only enquiry should send");
      HC.assert(res.receipt.phone === "07700 900123", "phone contact must be captured");
      HC.assert(res.receipt.email === null, "email may be omitted when phone is given");
    });

    // --- Validation: missing contact / message are rejected. ---
    check("Enquiry rejected when no contact channel is supplied", function () {
      var res = sendEnquiry(enquiryCamp, { name: "No Contact", message: "Do you have any spaces left this summer?" });
      HC.assert(res.ok === false, "must reject with neither email nor phone");
      HC.assert(res.reason === "invalid" && res.errors.contact, "should flag the missing contact channel");
    });

    check("Enquiry rejected when the message is empty", function () {
      var res = sendEnquiry(enquiryCamp, { name: "Sam", email: "sam@example.com", message: "" });
      HC.assert(res.ok === false, "must reject an empty message");
      HC.assert(res.errors && res.errors.message, "should flag the missing message");
    });

    check("Enquiry rejected when the name is missing", function () {
      var res = sendEnquiry(enquiryCamp, { email: "sam@example.com", message: "Is the camp running in week 2?" });
      HC.assert(res.ok === false, "must reject a nameless enquiry");
      HC.assert(res.errors && res.errors.name, "should flag the missing name");
    });

    check("Malformed email is rejected", function () {
      var res = sendEnquiry(enquiryCamp, { name: "Sam", email: "not-an-email", message: "Is there space this summer?" });
      HC.assert(res.ok === false, "bad email must be rejected");
      HC.assert(res.errors && res.errors.email, "should flag the bad email");
    });

    check("Out-of-range child age is rejected (toddler age on a school-age camp)", function () {
      var res = sendEnquiry(enquiryCamp, {
        name: "Sam", email: "sam@example.com", childAge: 2,
        message: "Is there space this summer?"
      });
      HC.assert(res.ok === false, "age 2 is outside the school-age 4–17 range");
      HC.assert(res.errors && res.errors.childAge, "should flag the child age");
    });

    check("Valid optional child age (8) is accepted and captured", function () {
      var res = sendEnquiry(enquiryCamp, {
        name: "Sam", email: "sam@example.com", childName: "Ada", childAge: 8,
        message: "Is there space this summer for an 8-year-old?"
      });
      HC.assert(res.ok === true, "a school-age child age should be accepted");
      HC.assert(res.receipt.childAge === 8 && res.receipt.childName === "Ada", "child details must be captured");
    });

    // --- Happity rule: bookable camps do NOT use the enquiry form. ---
    check("Enquiry is refused for a bookable camp (use Book Now instead)", function () {
      var res = sendEnquiry(bookableCamp, {
        name: "Sam", email: "sam@example.com", message: "Can I book a place?"
      });
      HC.assert(res.ok === false, "a bookable camp should not accept an enquiry");
      HC.assert(res.reason === "bookable", "reason should be 'bookable', got " + res.reason);
    });

    // --- Persistence: sent enquiries land in the mock outbox + contact saved. ---
    check("A sent enquiry is logged to the mock outbox and contact is remembered", function () {
      var before = HC.store.get(STORE_LOG, []);
      var beforeLen = Array.isArray(before) ? before.length : 0;
      var res = sendEnquiry(enquiryCamp, {
        name: "Persist Tester", email: "persist@example.com",
        message: "Logging check — is the August week available?"
      });
      HC.assert(res.ok === true, "enquiry should send for logging check");
      var after = HC.store.get(STORE_LOG, []);
      HC.assert(Array.isArray(after) && after.length === beforeLen + 1, "outbox should grow by one");
      HC.assert(after[after.length - 1].providerId === enquiryCamp.id, "logged enquiry should reference the camp");
      var contact = HC.store.get(STORE_CONTACT, null);
      HC.assert(contact && contact.email === "persist@example.com", "parent contact should be remembered for next time");
    });

    // --- Live-data sanity: real directory contains non-bookable camps. ---
    check("Live directory yields at least one non-bookable school-age camp", function () {
      var providers = allProviders();
      HC.assert(providers.length >= 1, "expected live providers, got " + providers.length);
      var nb = nonBookableCamps();
      HC.assert(nb.length >= 1, "expected >=1 non-bookable camp in the live directory, got " + nb.length);
      // And the form genuinely opens for that real camp.
      HC.assert(shouldShowEnquiry(nb[0]) === true, "the live non-bookable camp must show the enquiry form");
      // A valid enquiry to a real camp sends.
      var res = sendEnquiry(nb[0], {
        name: "Live Tester", email: "live@example.com",
        message: "Found you on HolidayCamp — is there summer space?"
      });
      HC.assert(res.ok === true, "should be able to enquire to a real non-bookable camp");
    });

    check("Live directory also contains genuinely bookable camps (contrast holds)", function () {
      var bk = bookableCamps();
      HC.assert(bk.length >= 1, "expected >=1 bookable camp so the Book Now contrast is real, got " + bk.length);
      HC.assert(shouldShowEnquiry(bk[0]) === false, "a live bookable camp must NOT show the enquiry form");
    });

    return { pass: pass, fail: fail, log: log };
  }

  /* ============================================================
   * 6. Register (idempotent + defensive via core).
   * ============================================================ */
  HC.registerFeature({
    id: "parent-send-enquiry",
    title: "Send an enquiry (when not bookable)",
    side: "parent",
    icon: "✉️",
    summary: "Camps that can’t be booked through the platform show a Send an enquiry form instead of Book Now — capturing the parent’s message and contact details, which are sent to the camp.",
    render: render,
    selfTest: selfTest
  });
})();
