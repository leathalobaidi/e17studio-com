/* HolidayCamp feature — parent-guest-checkout
 *
 * Replicates Happity's "no account required" checkout choice for HOLIDAY CAMPS
 * (school-age). At checkout the parent can finish a booking WITHOUT creating an
 * account, picking one of two modes:
 *   1. "Guest checkout"  — book once, nothing remembered.
 *   2. "Save my details" — store contact + children on this device so future
 *      bookings prefill automatically (keyed by email; still no account/login).
 *
 * Evidence (Happity support corpus):
 *   - 8255740 "Parents & Carers FAQs – Login Queries":
 *       "Customer accounts for parents are not currently available on Happity
 *        and are not required to book a class. However when you book a class on
 *        Happity, you can choose to save your information for the future or
 *        simply click 'Guest checkout'."
 *       "You may have checked out as a guest previously." (guest leaves no
 *        retrievable account / password).
 *
 * Distinct from a parent-account feature: there is NO sign-in, NO password, NO
 * saved-favourites surface here. "Save my details" is a local convenience cache
 * only — exactly the Happity model.
 *
 * Self-contained, defensive, plain browser JS (passes `node --check`).
 * All persistence goes through HC.store (mock localStorage under "hc_").
 */
(function () {
  "use strict";

  if (!window.HC || typeof HC.registerFeature !== "function") return;

  // Where the "saved details" convenience cache lives (mock; NOT an account).
  // Shape: { profilesByEmail: { "<lower email>": {profile} }, lastEmail: "..." }
  var STORE_KEY = "guest_checkout_saved";

  var MODE_GUEST = "guest";  // book once, remember nothing
  var MODE_SAVE = "save";    // cache details on this device for next time

  /* ---------------- pure logic (exercised by selfTest) ---------------- */

  function emptyVault() {
    return { profilesByEmail: {}, lastEmail: null };
  }

  function readVault() {
    var v = HC.store.get(STORE_KEY, null);
    if (!v || typeof v !== "object") return emptyVault();
    if (!v.profilesByEmail || typeof v.profilesByEmail !== "object") v.profilesByEmail = {};
    if (typeof v.lastEmail !== "string") v.lastEmail = null;
    return v;
  }

  function writeVault(v) {
    HC.store.set(STORE_KEY, v || emptyVault());
    return v;
  }

  function normEmail(email) {
    return String(email == null ? "" : email).trim().toLowerCase();
  }

  function isValidEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || "").trim());
  }

  // Validate the contact info a guest must provide to book. Children name/age
  // are required because a holiday camp must know who is attending.
  function validateContact(c) {
    var errors = [];
    c = c || {};
    if (!c.parentName || !String(c.parentName).trim()) errors.push("Your name is required.");
    if (!isValidEmail(c.parentEmail)) errors.push("A valid email is required.");
    var phone = String(c.parentPhone || "").replace(/\D/g, "");
    if (phone.length < 7) errors.push("A contact phone number is required.");
    var kids = Array.isArray(c.children) ? c.children : [];
    if (!kids.length) errors.push("Add at least one child.");
    kids.forEach(function (k, i) {
      if (!k || !String(k.name || "").trim()) errors.push("Child " + (i + 1) + ": name is required.");
      var age = parseInt(k && k.age, 10);
      if (!isFinite(age) || age < 4 || age > 17) {
        errors.push("Child " + (i + 1) + ": a school-age (4–17) is required.");
      }
    });
    return { ok: errors.length === 0, errors: errors };
  }

  // Normalise a contact object into the stored/returned profile shape.
  function toProfile(c) {
    c = c || {};
    return {
      parentName: String(c.parentName || "").trim(),
      parentEmail: String(c.parentEmail || "").trim(),
      parentPhone: String(c.parentPhone || "").trim(),
      children: (Array.isArray(c.children) ? c.children : []).map(function (k) {
        return {
          name: String((k && k.name) || "").trim(),
          age: parseInt(k && k.age, 10)
        };
      })
    };
  }

  // Look up previously-saved details for an email (no login — just a local
  // convenience lookup). Returns null if nothing saved or email blank.
  function lookupSaved(email) {
    var key = normEmail(email);
    if (!key) return null;
    var v = readVault();
    var p = v.profilesByEmail[key];
    return p ? toProfile(p) : null;
  }

  function lastSavedEmail() {
    return readVault().lastEmail || null;
  }

  // Whether ANY details are saved on this device.
  function hasAnySaved() {
    var v = readVault();
    return Object.keys(v.profilesByEmail).length > 0;
  }

  // Persist details for future prefilling (the "save my info" branch).
  function saveProfile(c) {
    var prof = toProfile(c);
    var key = normEmail(prof.parentEmail);
    if (!key) return null;
    var v = readVault();
    v.profilesByEmail[key] = prof;
    v.lastEmail = prof.parentEmail.trim();
    writeVault(v);
    return prof;
  }

  // Forget saved details for one email (or all). Mirrors the Happity reality
  // that a guest can clear what was remembered — no account to delete.
  function forgetSaved(email) {
    var v = readVault();
    if (email === undefined) {
      writeVault(emptyVault());
      return true;
    }
    var key = normEmail(email);
    if (key && v.profilesByEmail[key]) {
      delete v.profilesByEmail[key];
      if (normEmail(v.lastEmail) === key) v.lastEmail = null;
      writeVault(v);
      return true;
    }
    return false;
  }

  // === The core acceptance behaviour ===
  // Complete a booking with NO account. `saveInfo` chooses between the two modes.
  // Returns the completed booking plus the mode used, and whether the device now
  // remembers the details. NEVER creates an account / password / session.
  function completeGuestBooking(contact, opts) {
    opts = opts || {};
    var v = validateContact(contact);
    if (!v.ok) {
      return { ok: false, stage: "contact", errors: v.errors };
    }

    var saveInfo = !!opts.saveInfo;
    var prof = toProfile(contact);

    if (saveInfo) {
      saveProfile(prof);
    }

    var ref = "HC-" + (HC.util && HC.util.uid ? HC.util.uid() : Date.now().toString(36))
      .replace(/[^a-z0-9]/gi, "").slice(-8).toUpperCase();

    return {
      ok: true,
      stage: "confirmation",
      mode: saveInfo ? MODE_SAVE : MODE_GUEST,
      account: false,            // <- hard guarantee: never an account
      saved: saveInfo,           // device remembers details only if asked
      ref: ref,
      profile: prof,
      providerId: opts.providerId || null,
      providerName: opts.providerName || null,
      bookedAt: new Date().toISOString()
    };
  }

  /* ---------------- UI (inside mountEl) ---------------- */

  function firstProvider() {
    var providers = (HC.data && HC.data.providers) || [];
    return providers[0] || { id: "demo", name: "Demo Holiday Camp" };
  }

  function render(mountEl) {
    try {
      injectStyles();
      var providers = (HC.data && HC.data.providers) || [];
      var provider = providers[0] || { id: "demo", name: "Demo Holiday Camp" };

      var state = {
        mode: MODE_GUEST, // default to guest checkout
        contact: {
          parentName: "", parentEmail: "", parentPhone: "",
          children: [{ name: "", age: "" }]
        }
      };

      var root = HC.util.el("div", { class: "hcgc" });
      mountEl.innerHTML = "";
      mountEl.appendChild(root);
      draw();

      function esc(s) {
        return String(s == null ? "" : s)
          .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
      }

      function draw() {
        var saved = hasAnySaved();
        var lastEmail = lastSavedEmail();
        var kids = state.contact.children.map(function (k, i) {
          return '<div class="hcgc-row">' +
            '<label class="hcgc-field"><span>Child ' + (i + 1) + ' name</span>' +
              '<input data-kid="' + i + '" data-f="name" value="' + esc(k.name) + '" placeholder="e.g. Ada"></label>' +
            '<label class="hcgc-field hcgc-age"><span>Age</span>' +
              '<input data-kid="' + i + '" data-f="age" type="number" min="4" max="17" value="' + esc(k.age) + '"></label>' +
            (state.contact.children.length > 1
              ? '<button class="hcgc-kidx" type="button" data-rmkid="' + i + '" aria-label="Remove child">×</button>'
              : "") +
          "</div>";
        }).join("");

        var prefillBanner = "";
        if (saved) {
          prefillBanner =
            '<div class="hcgc-prefill">' +
              '<span>📓 Booked before on this device' + (lastEmail ? ' as <b>' + esc(lastEmail) + "</b>" : "") + "?</span> " +
              '<button class="hcgc-link" type="button" id="hcgc-prefill-btn">Use my saved details</button>' +
              ' · <button class="hcgc-link hcgc-link-mut" type="button" id="hcgc-forget-btn">Forget</button>' +
            "</div>";
        }

        root.innerHTML =
          '<div class="hcgc-head">' +
            '<h3 class="hcgc-h">Checkout — ' + esc(provider.name) + "</h3>" +
            '<p class="hcgc-note">No account needed. Book as a guest, or save your details on this ' +
              "device so next time fills in for you.</p>" +
          "</div>" +
          prefillBanner +
          '<div class="hcgc-modes" role="radiogroup" aria-label="Checkout type">' +
            modeCard(MODE_GUEST, "👤 Guest checkout", "Book now. Nothing is remembered — no password, no account.") +
            modeCard(MODE_SAVE, "💾 Save my details", "Keep my info on this device to make future bookings faster.") +
          "</div>" +
          '<div class="hcgc-form">' +
            '<div class="hcgc-row">' +
              '<label class="hcgc-field"><span>Your name</span><input id="hcgc-pn" value="' + esc(state.contact.parentName) + '"></label>' +
              '<label class="hcgc-field"><span>Phone</span><input id="hcgc-pp" inputmode="tel" value="' + esc(state.contact.parentPhone) + '"></label>' +
            "</div>" +
            '<label class="hcgc-field"><span>Email (for your confirmation)</span>' +
              '<input id="hcgc-pe" type="email" value="' + esc(state.contact.parentEmail) + '" placeholder="you@example.com"></label>' +
            '<div class="hcgc-kids">' + kids + "</div>" +
            '<button class="hcgc-addkid" type="button" id="hcgc-addkid">+ Add another child</button>' +
            '<div id="hcgc-errs" class="hcgc-errs"></div>' +
            '<button class="hcgc-btn" type="button" id="hcgc-book"></button>' +
            '<p class="hcgc-fineprint" id="hcgc-fine"></p>' +
          "</div>";

        updateModeUI();
        wire();
      }

      function modeCard(mode, title, body) {
        var on = state.mode === mode;
        return '<button class="hcgc-mode' + (on ? " on" : "") + '" type="button" role="radio" ' +
          'aria-checked="' + (on ? "true" : "false") + '" data-mode="' + mode + '">' +
          '<span class="hcgc-mode-dot"></span>' +
          '<span class="hcgc-mode-txt"><b>' + title + "</b><small>" + body + "</small></span>" +
        "</button>";
      }

      function updateModeUI() {
        root.querySelectorAll(".hcgc-mode").forEach(function (b) {
          var on = b.getAttribute("data-mode") === state.mode;
          b.classList.toggle("on", on);
          b.setAttribute("aria-checked", on ? "true" : "false");
        });
        var btn = root.querySelector("#hcgc-book");
        var fine = root.querySelector("#hcgc-fine");
        if (state.mode === MODE_SAVE) {
          btn.textContent = "Save details & book";
          fine.textContent = "Your details stay on this device only. No account or password is created.";
        } else {
          btn.textContent = "Book as guest";
          fine.textContent = "Quickest option. We won't remember anything after this booking.";
        }
      }

      function wire() {
        root.querySelectorAll(".hcgc-mode").forEach(function (b) {
          b.addEventListener("click", function () {
            state.mode = b.getAttribute("data-mode");
            updateModeUI();
          });
        });

        var pn = root.querySelector("#hcgc-pn");
        var pe = root.querySelector("#hcgc-pe");
        var pp = root.querySelector("#hcgc-pp");
        if (pn) pn.addEventListener("input", function (e) { state.contact.parentName = e.target.value; });
        if (pe) pe.addEventListener("input", function (e) { state.contact.parentEmail = e.target.value; });
        if (pp) pp.addEventListener("input", function (e) { state.contact.parentPhone = e.target.value; });

        root.querySelectorAll("[data-kid]").forEach(function (inp) {
          inp.addEventListener("input", function () {
            var i = parseInt(inp.getAttribute("data-kid"), 10);
            state.contact.children[i][inp.getAttribute("data-f")] = inp.value;
          });
        });

        root.querySelectorAll("[data-rmkid]").forEach(function (b) {
          b.addEventListener("click", function () {
            var i = parseInt(b.getAttribute("data-rmkid"), 10);
            if (state.contact.children.length > 1) {
              state.contact.children.splice(i, 1);
              draw();
            }
          });
        });

        var addKid = root.querySelector("#hcgc-addkid");
        if (addKid) addKid.addEventListener("click", function () {
          state.contact.children.push({ name: "", age: "" });
          draw();
        });

        var prefillBtn = root.querySelector("#hcgc-prefill-btn");
        if (prefillBtn) prefillBtn.addEventListener("click", function () {
          var email = lastSavedEmail();
          var prof = email ? lookupSaved(email) : null;
          if (prof) {
            state.contact = {
              parentName: prof.parentName,
              parentEmail: prof.parentEmail,
              parentPhone: prof.parentPhone,
              children: prof.children.length
                ? prof.children.map(function (k) { return { name: k.name, age: k.age }; })
                : [{ name: "", age: "" }]
            };
            state.mode = MODE_SAVE; // they clearly want their info kept
            draw();
            HC.util.toast("Filled in your saved details");
          } else {
            HC.util.toast("No saved details found");
          }
        });

        var forgetBtn = root.querySelector("#hcgc-forget-btn");
        if (forgetBtn) forgetBtn.addEventListener("click", function () {
          forgetSaved();
          HC.util.toast("Saved details cleared from this device");
          draw();
        });

        var book = root.querySelector("#hcgc-book");
        if (book) book.addEventListener("click", function () {
          var res = completeGuestBooking(state.contact, {
            saveInfo: state.mode === MODE_SAVE,
            providerId: provider.id,
            providerName: provider.name
          });
          if (!res.ok) {
            root.querySelector("#hcgc-errs").innerHTML =
              res.errors.map(function (x) { return "<div>• " + esc(x) + "</div>"; }).join("");
            return;
          }
          drawDone(res);
        });
      }

      function drawDone(res) {
        var kidList = res.profile.children.map(function (k) {
          return "<li>" + esc(k.name) + " (age " + k.age + ")</li>";
        }).join("");
        root.innerHTML =
          '<div class="hcgc-done">' +
            '<div class="hcgc-tick">✓</div>' +
            "<h3 class=\"hcgc-h\">You're booked in!</h3>" +
            '<p class="hcgc-ref">Booking ref <b>' + esc(res.ref) + "</b></p>" +
            '<div class="hcgc-summary">' +
              '<div class="hcgc-line"><span>' + esc(res.providerName || "Holiday camp") + "</span></div>" +
              '<div class="hcgc-line"><span>Booked by</span><span>' + esc(res.profile.parentName) + "</span></div>" +
              '<div class="hcgc-line"><span>Confirmation to</span><span>' + esc(res.profile.parentEmail) + "</span></div>" +
            "</div>" +
            '<ul class="hcgc-kidlist">' + kidList + "</ul>" +
            '<div class="hcgc-modebadge ' + (res.saved ? "save" : "guest") + '">' +
              (res.saved
                ? "💾 Details saved on this device — your next booking will prefill. (Still no account.)"
                : "👤 Booked as a guest — nothing was remembered.") +
            "</div>" +
            '<button class="hcgc-btn" type="button" id="hcgc-again">Book another</button>' +
          "</div>";
        HC.util.toast(res.saved
          ? "Booked — details saved for next time"
          : "Booked as guest — ref " + res.ref);
        var again = root.querySelector("#hcgc-again");
        if (again) again.addEventListener("click", function () {
          state.contact = { parentName: "", parentEmail: "", parentPhone: "", children: [{ name: "", age: "" }] };
          state.mode = MODE_GUEST;
          draw();
        });
      }
    } catch (e) {
      mountEl.innerHTML = '<p style="color:#9a1f5e">Guest checkout failed to render: ' +
        String(e && e.message ? e.message : e) + "</p>";
    }
  }

  function injectStyles() {
    if (document.getElementById("hcgc-styles")) return;
    var css =
      ".hcgc{font-family:'Nunito Sans',system-ui,sans-serif;color:var(--text,#383838)}" +
      ".hcgc-h{font-family:'Quicksand',system-ui,sans-serif;color:var(--purple,#603488);font-size:19px;margin:0 0 6px}" +
      ".hcgc-note{font-size:13px;color:var(--muted,#808080);margin:0 0 14px}" +
      ".hcgc-prefill{background:var(--yellow-tint,#FFF7CC);border:1.5px solid var(--yellow,#FCD400);border-radius:12px;padding:9px 12px;font-size:12.5px;margin:0 0 14px}" +
      ".hcgc-modes{display:flex;gap:10px;margin:0 0 16px;flex-wrap:wrap}" +
      ".hcgc-mode{flex:1;min-width:200px;display:flex;align-items:flex-start;gap:10px;text-align:left;border:1.5px solid var(--line,#E6E6E6);" +
        "background:#fff;border-radius:14px;padding:12px 13px;cursor:pointer;font:inherit}" +
      ".hcgc-mode.on{border-color:var(--magenta,#F82488);background:var(--pink-tint,#FCE8F0)}" +
      ".hcgc-mode-dot{flex:0 0 18px;height:18px;width:18px;border-radius:50%;border:2px solid var(--line,#CFCFCF);margin-top:2px}" +
      ".hcgc-mode.on .hcgc-mode-dot{border-color:var(--magenta,#F82488);background:var(--magenta,#F82488);box-shadow:inset 0 0 0 3px #fff}" +
      ".hcgc-mode-txt{display:flex;flex-direction:column;gap:2px}" +
      ".hcgc-mode-txt b{font-family:'Quicksand',system-ui,sans-serif;color:var(--purple,#603488);font-size:14px}" +
      ".hcgc-mode-txt small{color:var(--muted,#808080);font-size:11.5px;line-height:1.35}" +
      ".hcgc-field{display:flex;flex-direction:column;gap:4px;font-size:13px;font-weight:700;color:var(--purple,#603488);margin:0 0 12px}" +
      ".hcgc-field input{font:inherit;font-weight:400;color:var(--text,#383838);padding:9px 11px;border:1.5px solid var(--line,#E6E6E6);border-radius:12px}" +
      ".hcgc-row{display:flex;gap:12px;align-items:flex-end}.hcgc-row .hcgc-field{flex:1}.hcgc-age{max-width:90px}" +
      ".hcgc-kidx{flex:0 0 auto;height:38px;width:38px;border-radius:10px;border:1.5px solid var(--line,#E6E6E6);background:#fff;color:var(--muted,#808080);cursor:pointer;font-size:18px;margin-bottom:12px}" +
      ".hcgc-addkid{background:none;border:none;color:var(--magenta,#F82488);font-family:'Quicksand',system-ui,sans-serif;font-weight:700;font-size:13px;cursor:pointer;padding:0;margin:0 0 14px}" +
      ".hcgc-errs{color:#9a1f5e;font-size:12.5px;margin:0 0 10px}.hcgc-errs div{margin:2px 0}" +
      ".hcgc-btn{width:100%;border:none;cursor:pointer;font-family:'Quicksand',system-ui,sans-serif;font-weight:700;background:var(--yellow,#FCD400);color:var(--ink,#1A1A1A);padding:12px 16px;border-radius:999px;font-size:14px}" +
      ".hcgc-btn:hover{background:#ffdf2e}" +
      ".hcgc-fineprint{font-size:11.5px;color:var(--muted,#808080);text-align:center;margin:8px 0 0}" +
      ".hcgc-link{background:none;border:none;color:var(--purple,#603488);font-weight:700;cursor:pointer;padding:0;font-size:12.5px;text-decoration:underline}" +
      ".hcgc-link-mut{color:var(--muted,#808080)}" +
      ".hcgc-done{text-align:center}.hcgc-tick{width:54px;height:54px;border-radius:50%;background:#2f7d4f;color:#fff;font-size:30px;display:grid;place-items:center;margin:0 auto 10px}" +
      ".hcgc-ref{font-size:14px;margin:0 0 12px}" +
      ".hcgc-summary{background:var(--purple-tint,#F0E8F4);border-radius:14px;padding:12px 14px;margin:0 0 12px;font-size:14px;text-align:left}" +
      ".hcgc-line{display:flex;justify-content:space-between;padding:3px 0}" +
      ".hcgc-kidlist{text-align:left;font-size:13px;color:var(--text,#383838);padding-left:18px;margin:0 0 12px}" +
      ".hcgc-modebadge{font-size:12.5px;border-radius:12px;padding:10px 12px;margin:0 0 14px}" +
      ".hcgc-modebadge.save{background:#E1F0E4;color:#2f7d4f}.hcgc-modebadge.guest{background:var(--purple-tint,#F0E8F4);color:var(--purple,#603488)}";
    var s = HC.util.el("style", { id: "hcgc-styles" }, css);
    document.head.appendChild(s);
  }

  /* ---------------- selfTest: exercises the LOGIC ---------------- */

  function selfTest() {
    var pass = 0, fail = 0, log = [];
    function check(label, fn) {
      try { fn(); pass++; log.push("✓ " + label); }
      catch (e) { fail++; log.push("✗ " + label + " — " + (e && e.message ? e.message : String(e))); }
    }

    // Use a private email namespace + always clean up so the test is repeatable
    // and never leaves residue in the shared vault.
    var EMAIL = "guesttest+" + Date.now() + "@example.com";
    var EMAIL2 = "savetest+" + Date.now() + "@example.com";
    forgetSaved(EMAIL);
    forgetSaved(EMAIL2);

    var goodContact = {
      parentName: "Sam Carer",
      parentEmail: EMAIL,
      parentPhone: "07700 900123",
      children: [{ name: "Ada", age: 8 }]
    };

    check("Contact validation rejects bad input", function () {
      HC.assert(!validateContact({}).ok, "empty contact should fail");
      HC.assert(!validateContact({ parentName: "A", parentEmail: "bad", parentPhone: "07700900123", children: [{ name: "X", age: 8 }] }).ok, "bad email should fail");
      HC.assert(!validateContact({ parentName: "A", parentEmail: "a@b.com", parentPhone: "07700900123", children: [] }).ok, "no children should fail");
      HC.assert(!validateContact({ parentName: "A", parentEmail: "a@b.com", parentPhone: "123", children: [{ name: "X", age: 8 }] }).ok, "short phone should fail");
      HC.assert(!validateContact({ parentName: "A", parentEmail: "a@b.com", parentPhone: "07700900123", children: [{ name: "X", age: 2 }] }).ok, "toddler age should fail (school-age camp)");
    });

    check("Contact validation accepts a valid school-age guest", function () {
      HC.assert(validateContact(goodContact).ok, "valid contact should pass");
    });

    // === ACCEPTANCE CRITERION ===
    // A parent can complete a booking WITHOUT an account via 'Guest checkout',
    // AND has an explicit option to save details for the future.
    check("ACCEPTANCE: guest checkout completes a booking with NO account", function () {
      var res = completeGuestBooking(goodContact, { saveInfo: false, providerName: "Test Camp" });
      HC.assert(res.ok, "guest booking should succeed");
      HC.assert(res.stage === "confirmation", "should reach confirmation, got " + res.stage);
      HC.assert(res.account === false, "guest checkout must NOT create an account");
      HC.assert(res.mode === MODE_GUEST, "mode should be guest, got " + res.mode);
      HC.assert(res.saved === false, "guest mode must not remember details");
      HC.assert(/^HC-/.test(res.ref), "must issue a booking ref");
      // Guest mode left NOTHING saved for this email:
      HC.assert(lookupSaved(EMAIL) === null, "guest checkout must not persist details");
    });

    check("ACCEPTANCE: 'save my details' is an explicit, working option", function () {
      HC.assert(lookupSaved(EMAIL2) === null, "precondition: nothing saved yet");
      var saveContact = {
        parentName: "Jo Carer", parentEmail: EMAIL2,
        parentPhone: "07700 900456", children: [{ name: "Max", age: 9 }]
      };
      var res = completeGuestBooking(saveContact, { saveInfo: true, providerName: "Test Camp" });
      HC.assert(res.ok && res.stage === "confirmation", "save-mode booking should complete");
      HC.assert(res.account === false, "saving details still must NOT be an account");
      HC.assert(res.mode === MODE_SAVE && res.saved === true, "mode should be save & saved=true");
      // The details are now retrievable on-device for the NEXT booking:
      var saved = lookupSaved(EMAIL2);
      HC.assert(saved, "details should be retrievable after saving");
      HC.assert(saved.parentName === "Jo Carer", "saved name should round-trip");
      HC.assert(saved.children.length === 1 && saved.children[0].age === 9, "saved children should round-trip");
    });

    check("Saved details prefill a SUBSEQUENT booking (no re-typing, no login)", function () {
      // Simulate the parent returning: their saved profile is the prefill source.
      var prof = lookupSaved(EMAIL2);
      HC.assert(prof, "saved profile must exist from previous test");
      // Re-book straight from the saved profile — no account/login step involved.
      var res2 = completeGuestBooking(prof, { saveInfo: true, providerName: "Another Camp" });
      HC.assert(res2.ok && res2.account === false, "returning parent re-books without an account");
      HC.assert(res2.profile.parentEmail === prof.parentEmail, "prefilled email is reused");
    });

    check("lastSavedEmail tracks the most recent save (convenience, not a session)", function () {
      HC.assert(normEmail(lastSavedEmail()) === normEmail(EMAIL2), "last saved email should be the save-mode one");
      HC.assert(hasAnySaved() === true, "device should report it has saved details");
    });

    check("Forgetting saved details removes them (no account to keep)", function () {
      HC.assert(lookupSaved(EMAIL2) !== null, "precondition: details exist");
      var removed = forgetSaved(EMAIL2);
      HC.assert(removed === true, "forget should report success");
      HC.assert(lookupSaved(EMAIL2) === null, "details should be gone after forget");
    });

    check("Guest mode never writes to the saved vault (isolation)", function () {
      var EMAIL3 = "isolate+" + Date.now() + "@example.com";
      forgetSaved(EMAIL3);
      var before = readVault();
      var beforeCount = Object.keys(before.profilesByEmail).length;
      completeGuestBooking({
        parentName: "Guest Only", parentEmail: EMAIL3,
        parentPhone: "07700900789", children: [{ name: "Kit", age: 10 }]
      }, { saveInfo: false });
      var after = readVault();
      HC.assert(Object.keys(after.profilesByEmail).length === beforeCount,
        "guest booking must not grow the saved vault");
      HC.assert(lookupSaved(EMAIL3) === null, "guest email must not be saved");
    });

    check("Invalid contact blocks the booking at the contact stage", function () {
      var res = completeGuestBooking({ parentName: "", parentEmail: "x", parentPhone: "", children: [] }, { saveInfo: true });
      HC.assert(!res.ok && res.stage === "contact", "invalid contact should stop at contact stage");
      HC.assert(Array.isArray(res.errors) && res.errors.length > 0, "should return contact errors");
    });

    // cleanup: leave the shared vault as we found it for these test emails
    forgetSaved(EMAIL);
    forgetSaved(EMAIL2);

    return { pass: pass, fail: fail, log: log };
  }

  /* ---------------- register ---------------- */

  HC.registerFeature({
    id: "parent-guest-checkout",
    title: "Guest checkout (no account needed)",
    side: "parent",
    icon: "👤",
    summary: "Book a holiday camp without creating an account. Click 'Guest checkout' to book once, or tick 'Save my details' to have this device prefill your next booking — no password, ever.",
    render: render,
    selfTest: selfTest
  });
})();
