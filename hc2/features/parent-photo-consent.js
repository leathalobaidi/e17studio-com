/* HolidayCamp feature — parent-photo-consent
 *
 * Replicates Happity's "Asking for consent to photos and videos" (support
 * article 9875228), reframed for school-age HOLIDAY CAMPS.
 *
 * Happity behaviour (evidence): after a parent selects tickets and enters their
 * child's details at checkout, they see Yes/No photo/video consent buttons —
 * "Yes" gives the provider permission to use photos/videos, "No" opts out. The
 * choice is stored against the booking and surfaces on the provider's register
 * (camera icon = consented; crossed-through camera = opted out).
 *
 * Here we model that as a checkout step: a Yes/No toggle whose value is written
 * onto the booking record and persisted via HC.store under "booking:<id>".
 *
 * Self-contained, defensive, no imports/exports — plain browser JS.
 */
(function () {
  "use strict";

  if (typeof window === "undefined" || !window.HC || typeof window.HC.registerFeature !== "function") {
    return; // nothing to register against
  }

  var HC = window.HC;

  /* ---------- pure logic (testable without DOM) ---------- */

  // Consent is a tri-state until the parent decides: null = not yet chosen.
  var YES = "yes", NO = "no";

  function normaliseConsent(v) {
    if (v === true || v === YES || v === "Yes" || v === "YES") return YES;
    if (v === false || v === NO || v === "No" || v === "NO") return NO;
    return null; // undecided
  }

  // Build a booking record for a camp + child. photoConsent starts undecided so
  // checkout is forced to make an explicit Yes/No choice (mirrors Happity).
  function makeBooking(provider, child) {
    var p = provider || {};
    var c = child || {};
    return {
      id: (HC.util && HC.util.uid) ? HC.util.uid() : ("bk_" + Date.now() + "_" + Math.random().toString(36).slice(2)),
      providerId: p.id != null ? String(p.id) : "",
      providerName: p.name || "",
      childName: (c.name || "").trim(),
      childAge: c.age != null ? c.age : null,
      photoConsent: null,            // <- the field the acceptance criterion is about
      consentAt: null,
      createdAt: Date.now()
    };
  }

  // Apply a Yes/No choice to a booking and persist it against the booking id.
  // Returns the updated booking. Defensive: rejects undecided input.
  function setPhotoConsent(booking, choice) {
    HC.assert(booking && typeof booking === "object", "setPhotoConsent: booking required");
    var v = normaliseConsent(choice);
    HC.assert(v === YES || v === NO, "photo consent must be an explicit Yes or No");
    booking.photoConsent = v;
    booking.consentAt = Date.now();
    persist(booking);
    return booking;
  }

  function persist(booking) {
    try {
      HC.store.set("booking:" + booking.id, booking);
      // maintain an index so the provider register can enumerate bookings
      var idx = HC.store.get("bookingIndex", []) || [];
      if (idx.indexOf(booking.id) === -1) { idx.push(booking.id); HC.store.set("bookingIndex", idx); }
    } catch (e) { /* mock persistence must never throw checkout */ }
    return booking;
  }

  function loadBooking(id) {
    try { return HC.store.get("booking:" + id, null); } catch (e) { return null; }
  }

  // A booking can only be confirmed once an explicit consent choice exists.
  function canConfirm(booking) {
    return !!booking && (booking.photoConsent === YES || booking.photoConsent === NO);
  }

  // Register-row presentation: camera vs crossed-through camera (Happity parity).
  function registerIcon(booking) {
    if (!booking) return "";
    if (booking.photoConsent === YES) return "📷";       // consented
    if (booking.photoConsent === NO) return "🚫📷";      // opted out
    return "⏳";                                          // not yet chosen
  }

  function consentLabel(v) {
    var n = normaliseConsent(v);
    if (n === YES) return "Yes — photos & videos OK";
    if (n === NO) return "No — please don't use our photos";
    return "Not chosen yet";
  }

  /* ---------- render: a working checkout consent step ---------- */

  function render(mountEl) {
    try {
      var el = HC.util.el;
      var providers = HC.data.providers || [];
      var demoProvider = providers[0] || { id: "demo-camp", name: "Demo Holiday Camp" };

      // Seed a booking for the demo so the toggle has something to write to.
      var booking = makeBooking(demoProvider, { name: "Sample Child", age: 8 });

      mountEl.innerHTML = "";

      var wrap = el("div", { style: "font-family:'Nunito Sans',system-ui,sans-serif;color:var(--text,#383838)" });

      wrap.appendChild(el("p", { style: "font-size:14px;margin:0 0 6px" },
        "Final step of checkout for <strong>" + esc(demoProvider.name) + "</strong> — after tickets and " +
        "your child's details, choose whether the camp may use photos &amp; videos of your child in its marketing."));

      var childLine = el("p", { style: "font-size:13px;color:var(--muted,#808080);margin:0 0 14px" },
        "Child: <strong>" + esc(booking.childName) + "</strong>" + (booking.childAge != null ? " · age " + esc(booking.childAge) : ""));
      wrap.appendChild(childLine);

      // The Yes/No toggle.
      var q = el("div", { style: "border:1.5px solid var(--line,#E6E6E6);border-radius:16px;padding:16px;background:#fff" });
      q.appendChild(el("div", {
        style: "font-family:'Quicksand',system-ui,sans-serif;font-weight:700;color:var(--purple,#603488);font-size:15px;margin-bottom:4px"
      }, "📷 Photo &amp; video consent"));
      q.appendChild(el("div", { style: "font-size:13px;color:var(--text,#383838);margin-bottom:12px" },
        "Can " + esc(demoProvider.name) + " use photos and videos that include your child on their socials, website and listings?"));

      var btnRow = el("div", { style: "display:flex;gap:10px" });
      var yesBtn = el("button", { type: "button", class: "hc-btn" }, "✓ Yes, that's fine");
      var noBtn = el("button", { type: "button", class: "hc-btn hc-btn-ghost" }, "✗ No, opt out");
      btnRow.appendChild(yesBtn);
      btnRow.appendChild(noBtn);
      q.appendChild(btnRow);

      var status = el("div", {
        style: "margin-top:12px;font-size:13px;font-weight:700;font-family:'Quicksand',system-ui,sans-serif"
      }, "");
      q.appendChild(status);

      var confirmBtn = el("button", { type: "button", class: "hc-btn", disabled: "disabled",
        style: "margin-top:14px;opacity:.5" }, "Confirm booking");
      q.appendChild(confirmBtn);

      function paint() {
        var v = booking.photoConsent;
        yesBtn.style.background = v === YES ? "var(--purple,#603488)" : "";
        yesBtn.style.color = v === YES ? "#fff" : "";
        noBtn.style.background = v === NO ? "var(--magenta,#F82488)" : "";
        noBtn.style.color = v === NO ? "#fff" : "";
        if (v === YES) {
          status.style.color = "#2f7d4f";
          status.innerHTML = registerIcon(booking) + " Stored against booking: " + esc(consentLabel(v));
        } else if (v === NO) {
          status.style.color = "#9a1f5e";
          status.innerHTML = registerIcon(booking) + " Stored against booking: " + esc(consentLabel(v));
        } else {
          status.style.color = "var(--muted,#808080)";
          status.innerHTML = "Choose Yes or No to continue.";
        }
        var ready = canConfirm(booking);
        if (ready) { confirmBtn.removeAttribute("disabled"); confirmBtn.style.opacity = "1"; }
        else { confirmBtn.setAttribute("disabled", "disabled"); confirmBtn.style.opacity = ".5"; }
      }

      yesBtn.addEventListener("click", function () {
        try { setPhotoConsent(booking, YES); paint(); } catch (e) { /* defensive */ }
      });
      noBtn.addEventListener("click", function () {
        try { setPhotoConsent(booking, NO); paint(); } catch (e) { /* defensive */ }
      });
      confirmBtn.addEventListener("click", function () {
        if (!canConfirm(booking)) return;
        persist(booking);
        var saved = loadBooking(booking.id);
        var ok = saved && saved.photoConsent === booking.photoConsent;
        if (HC.util && HC.util.toast) {
          HC.util.toast(ok
            ? "Booking confirmed — consent (" + booking.photoConsent.toUpperCase() + ") saved to register"
            : "Booking saved");
        }
      });

      wrap.appendChild(q);

      // A tiny register preview, echoing Happity's camera / crossed-camera idea.
      var reg = el("div", { style: "margin-top:16px;font-size:12.5px;color:var(--muted,#808080)" },
        "On the provider register this booking shows as: " +
        "<span style='font-size:16px'>📷</span> consented · " +
        "<span style='font-size:16px'>🚫📷</span> opted out.");
      wrap.appendChild(reg);

      mountEl.appendChild(wrap);
      paint();
    } catch (e) {
      try { mountEl.innerHTML = '<p style="color:#9a1f5e">Photo-consent preview failed: ' + esc(e && e.message) + "</p>"; }
      catch (_) { /* swallow */ }
    }
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  /* ---------- selfTest: exercises the LOGIC + acceptance criterion ---------- */

  function selfTest() {
    var pass = 0, fail = 0, log = [];
    function check(label, fn) {
      try { fn(); pass += 1; log.push("✓ " + label); }
      catch (e) { fail += 1; log.push("✗ " + label + " — " + (e && e.message ? e.message : String(e))); }
    }

    var providers = HC.data.providers || [];
    var camp = providers[0] || { id: "test-camp", name: "Test Camp" };

    // 1. A fresh checkout booking starts undecided — no implicit consent.
    check("New booking has no photo-consent decision yet", function () {
      var b = makeBooking(camp, { name: "Ada", age: 9 });
      HC.assert(b.photoConsent === null, "expected null, got " + b.photoConsent);
      HC.assert(canConfirm(b) === false, "should not be confirmable before a choice");
    });

    // 2. ACCEPTANCE CRITERION (Yes): toggling Yes stores consent on the booking.
    check("Selecting Yes stores 'yes' against the booking", function () {
      var b = makeBooking(camp, { name: "Ben", age: 7 });
      setPhotoConsent(b, YES);
      HC.assert(b.photoConsent === YES, "in-memory booking should be 'yes'");
      var saved = loadBooking(b.id);
      HC.assert(saved && saved.photoConsent === YES, "persisted booking should be 'yes'");
      HC.assert(typeof saved.consentAt === "number", "consent timestamp should be recorded");
    });

    // 3. ACCEPTANCE CRITERION (No): toggling No stores opt-out against the booking.
    check("Selecting No stores 'no' (opt-out) against the booking", function () {
      var b = makeBooking(camp, { name: "Cara", age: 11 });
      setPhotoConsent(b, NO);
      HC.assert(b.photoConsent === NO, "in-memory booking should be 'no'");
      var saved = loadBooking(b.id);
      HC.assert(saved && saved.photoConsent === NO, "persisted booking should be 'no'");
    });

    // 4. The toggle is binary: undecided input is rejected, decision can flip.
    check("Consent is an explicit binary that can be changed", function () {
      var b = makeBooking(camp, { name: "Dee", age: 8 });
      var threw = false;
      try { setPhotoConsent(b, "maybe"); } catch (e) { threw = true; }
      HC.assert(threw, "undecided/garbage input must be rejected");
      setPhotoConsent(b, YES);
      HC.assert(b.photoConsent === YES, "Yes applied");
      setPhotoConsent(b, NO);  // parent changes their mind
      HC.assert(b.photoConsent === NO, "choice should flip to No");
      var saved = loadBooking(b.id);
      HC.assert(saved.photoConsent === NO, "flip should persist");
    });

    // 5. Booking can only be confirmed once a Yes/No choice exists.
    check("Booking is confirmable only after a Yes/No choice", function () {
      var b = makeBooking(camp, { name: "Eli", age: 10 });
      HC.assert(canConfirm(b) === false, "undecided booking not confirmable");
      setPhotoConsent(b, YES);
      HC.assert(canConfirm(b) === true, "decided booking confirmable");
    });

    // 6. Register presentation mirrors Happity's camera / crossed-camera icons.
    check("Register icon reflects consent (camera vs crossed camera)", function () {
      var yes = makeBooking(camp, { name: "Fi" }); setPhotoConsent(yes, YES);
      var no = makeBooking(camp, { name: "Gus" }); setPhotoConsent(no, NO);
      HC.assert(registerIcon(yes) === "📷", "consented row should show a camera");
      HC.assert(registerIcon(no).indexOf("🚫") === 0, "opted-out row should show a crossed camera");
      HC.assert(registerIcon(makeBooking(camp, {})) === "⏳", "undecided row should show a pending marker");
    });

    // 7. normaliseConsent accepts the shapes the UI / API might pass.
    check("Consent normalisation handles bool/string variants", function () {
      HC.assert(normaliseConsent(true) === YES && normaliseConsent("Yes") === YES, "truthy -> yes");
      HC.assert(normaliseConsent(false) === NO && normaliseConsent("No") === NO, "falsy -> no");
      HC.assert(normaliseConsent(undefined) === null && normaliseConsent("") === null, "unknown -> null");
    });

    return { pass: pass, fail: fail, log: log };
  }

  /* ---------- register ---------- */

  HC.registerFeature({
    id: "parent-photo-consent",
    title: "Photo & video consent at checkout",
    side: "parent",
    icon: "📷",
    summary: "At checkout, after child details, a Yes/No photo & video consent toggle. The choice is stored against the booking and shown on the provider's register.",
    render: render,
    selfTest: selfTest
  });
})();
