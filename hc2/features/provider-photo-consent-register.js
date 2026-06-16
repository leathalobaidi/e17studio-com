/* HolidayCamp feature — provider-photo-consent-register
 *
 * "See photo-consent status on register"  (PROVIDER side)
 *
 * Replicates Happity support article 9875228 ("Asking for consent to photos
 * and videos"). The provider-facing half of that article reads:
 *
 *   "You can see who has given consent and who has opted-out on your class
 *    register. Head to My Classes > Registers and click on the class to see a
 *    list of all your attendees. Parents of attendees with a camera icon next
 *    to their name have consented to photos and videos. Those with the camera
 *    icon crossed through have opted-out, and should not appear in your
 *    marketing content."
 *
 * Framed for SCHOOL-AGE HOLIDAY CAMPS (not baby classes): a camp leader opens
 * the register for a running DATE and, beside each child, sees a camera icon
 * (photos OK) or a crossed-through camera (opted out) so they know which
 * children must NOT appear in any marketing photo/video.
 *
 * ACCEPTANCE CRITERION (asserted in selfTest):
 *   Register shows a camera icon (consented) vs crossed-out (opted out) per
 *   attendee. We verify per-attendee icon mapping for consented / opted-out /
 *   undecided rows, that the marketing-safe filter excludes opted-out children,
 *   and that consent counts are summarised correctly.
 *
 * Interop: where the parent-side `parent-photo-consent` feature has written
 * `booking:<id>` records into HC.store, this register reads their photoConsent
 * so the two halves line up. It is also fully self-sufficient with its own
 * seeded register data, so it works in isolation.
 *
 * Self-contained, defensive, no imports/exports — plain browser JS.
 */
(function () {
  "use strict";

  // Defensive: never throw at module load if HC isn't present.
  if (typeof window === "undefined" || !window.HC || typeof window.HC.registerFeature !== "function") {
    if (typeof console !== "undefined" && console.warn) {
      console.warn("[HC] provider-photo-consent-register: HC core not found; skipping registration.");
    }
    return;
  }

  var HC = window.HC;

  var STORE_KEY = "provider_consent_registers"; // { <providerId>: { date, attendees:[...] } }

  // Consent states.
  var YES = "yes", NO = "no", PENDING = "pending";

  // The icons that ARE the acceptance criterion.
  var ICON_CONSENTED = "📷";   // camera          -> photos & videos OK
  var ICON_OPTED_OUT = "🚫📷"; // crossed camera   -> do NOT use in marketing
  var ICON_PENDING   = "⏳";   // not chosen yet

  /* ===================================================================
     PURE LOGIC (DOM-free, testable)
     =================================================================== */

  function asText(v) { return typeof v === "string" ? v : (v == null ? "" : String(v)); }

  function safeUid(prefix) {
    try { return HC.util.uid(); }
    catch (e) { return (prefix || "id") + "_" + Date.now() + "_" + Math.floor(Math.random() * 1e6); }
  }

  // Normalise any consent shape the booking/checkout side might hand us into one
  // of YES / NO / PENDING. Mirrors the parent feature's normaliser but is
  // self-contained (the two modules must not depend on each other to load).
  function normaliseConsent(v) {
    if (v === true || v === YES || v === "Yes" || v === "YES" || v === 1 || v === "1") return YES;
    if (v === false || v === NO || v === "No" || v === "NO" || v === 0 || v === "0") return NO;
    return PENDING; // null / undefined / "maybe" / anything else -> undecided
  }

  // The single mapping that the acceptance criterion is about: a consent state
  // -> the icon shown on the register row.
  function consentIcon(state) {
    var s = normaliseConsent(state);
    if (s === YES) return ICON_CONSENTED;
    if (s === NO) return ICON_OPTED_OUT;
    return ICON_PENDING;
  }

  // Is this icon the "crossed-out" (opted-out) marker? Used by tests and the UI
  // to prove a row is visibly opted out, not merely "not consented".
  function isCrossedOut(icon) {
    return asText(icon).indexOf("🚫") !== -1;
  }

  function consentLabel(state) {
    var s = normaliseConsent(state);
    if (s === YES) return "Photos & videos OK";
    if (s === NO) return "Opted out — do not use";
    return "Not chosen yet";
  }

  // Normalise one attendee row. childName + the photo-consent state are the
  // load-bearing fields; age is shown for the leader's benefit.
  function normaliseAttendee(input) {
    var a = (input && typeof input === "object") ? input : {};
    // Accept either an explicit `photoConsent` (parent/booking field) or a
    // looser `consent` alias.
    var raw = (a.photoConsent !== undefined) ? a.photoConsent : a.consent;
    return {
      id: a.id != null ? String(a.id) : safeUid("att"),
      childName: asText(a.childName || a.name).trim(),
      age: (a.age != null && isFinite(Number(a.age))) ? Number(a.age) : null,
      adultName: asText(a.adultName).trim(),
      photoConsent: normaliseConsent(raw)
    };
  }

  // Build the per-date register: ordered attendee rows, each carrying its
  // consent icon, plus a consent summary. Ordered by child's first name
  // (Happity's default register order).
  function buildConsentRegister(input) {
    var src = (input && typeof input === "object") ? input : {};
    var rowsIn = Array.isArray(src.attendees) ? src.attendees : [];
    var rows = [];
    for (var i = 0; i < rowsIn.length; i++) {
      var att = normaliseAttendee(rowsIn[i]);
      att.icon = consentIcon(att.photoConsent);
      att.consentLabel = consentLabel(att.photoConsent);
      att.optedOut = att.photoConsent === NO;
      rows.push(att);
    }
    rows.sort(function (a, b) {
      var an = a.childName.toLowerCase(), bn = b.childName.toLowerCase();
      if (an < bn) return -1;
      if (an > bn) return 1;
      return 0;
    });
    return {
      providerId: src.providerId != null ? String(src.providerId) : "",
      providerName: asText(src.providerName).trim(),
      date: asText(src.date).trim(),
      attendees: rows,
      summary: summarise(rows)
    };
  }

  function summarise(rows) {
    var consented = 0, optedOut = 0, pending = 0;
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].photoConsent === YES) consented += 1;
      else if (rows[i].photoConsent === NO) optedOut += 1;
      else pending += 1;
    }
    return { total: rows.length, consented: consented, optedOut: optedOut, pending: pending };
  }

  // The marketing-safe list: children who may appear in photos/videos. Anyone
  // opted out (and, conservatively, anyone undecided) is excluded. This is the
  // practical reason a provider reads the consent column off the register.
  function marketingSafeAttendees(register, opts) {
    var o = opts || {};
    var includePending = o.includePending === true; // default: be cautious
    var out = [];
    var rows = (register && Array.isArray(register.attendees)) ? register.attendees : [];
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      if (r.photoConsent === YES) out.push(r);
      else if (r.photoConsent === PENDING && includePending) out.push(r);
      // NO is never safe.
    }
    return out;
  }

  /* ===================================================================
     DATA: pull consent from booking store, else seed a demo register
     =================================================================== */

  // Read any booking records the parent-photo-consent feature persisted, so the
  // register reflects real checkout decisions when they exist.
  function attendeesFromBookingStore(providerId) {
    var out = [];
    try {
      var idx = HC.store.get("bookingIndex", []) || [];
      for (var i = 0; i < idx.length; i++) {
        var bk = HC.store.get("booking:" + idx[i], null);
        if (!bk) continue;
        if (providerId != null && asText(bk.providerId) !== asText(providerId)) continue;
        out.push({
          id: bk.id,
          childName: bk.childName,
          age: bk.childAge,
          photoConsent: bk.photoConsent
        });
      }
    } catch (e) { /* store may be empty / absent */ }
    return out;
  }

  // A deterministic demo register for a school-age summer camp. Mix of consent
  // states so the register visibly shows camera vs crossed-camera vs pending.
  function seedDemoAttendees() {
    return [
      { id: "d1", childName: "Amara",  age: 8,  adultName: "Priya O.",  photoConsent: "yes" },
      { id: "d2", childName: "Bilal",  age: 10, adultName: "Sana K.",   photoConsent: "no" },
      { id: "d3", childName: "Chloe",  age: 7,  adultName: "Mark D.",   photoConsent: "yes" },
      { id: "d4", childName: "Dev",    age: 11, adultName: "Anita R.",  photoConsent: null },   // not chosen
      { id: "d5", childName: "Esme",   age: 9,  adultName: "Joanne T.", photoConsent: "no" },
      { id: "d6", childName: "Finley", age: 8,  adultName: "Greg P.",   photoConsent: "yes" }
    ];
  }

  function getRegisterFor(provider) {
    var p = provider || {};
    var pid = p.id != null ? String(p.id) : "demo-camp";
    var fromStore = attendeesFromBookingStore(pid);
    var attendees = fromStore.length ? fromStore : seedDemoAttendees();
    return buildConsentRegister({
      providerId: pid,
      providerName: p.name || "Demo Holiday Camp",
      date: "2026-07-20", // Summer week 1, Mon
      attendees: attendees
    });
  }

  /* ===================================================================
     RENDER: the register view with per-attendee consent icons
     =================================================================== */

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function render(mountEl) {
    try {
      var el = HC.util.el;
      var providers = HC.data.providers || [];
      var provider = providers[0] || { id: "demo-camp", name: "Demo Holiday Camp" };

      var register = getRegisterFor(provider);

      mountEl.innerHTML = "";
      var wrap = el("div", { style: "font-family:'Nunito Sans',system-ui,sans-serif;color:var(--text,#383838)" });

      wrap.appendChild(el("p", { style: "font-size:14px;margin:0 0 4px" },
        "Register for <strong>" + esc(register.providerName) + "</strong> — " +
        "Mon 20 Jul 2026 (Summer week 1)."));
      wrap.appendChild(el("p", { style: "font-size:13px;color:var(--muted,#808080);margin:0 0 12px" },
        "A " + ICON_CONSENTED + " camera means the parent has consented to photos &amp; videos. A " +
        ICON_OPTED_OUT + " crossed-out camera means they have opted out — that child must not appear in marketing."));

      // Consent summary chips.
      var s = register.summary;
      var chips = el("div", { style: "display:flex;gap:8px;flex-wrap:wrap;margin:0 0 14px" });
      chips.appendChild(chip(ICON_CONSENTED + " " + s.consented + " consented", "#2f7d4f", "#e7f4ec"));
      chips.appendChild(chip(ICON_OPTED_OUT + " " + s.optedOut + " opted out", "#9a1f5e", "#fce8f0"));
      chips.appendChild(chip(ICON_PENDING + " " + s.pending + " pending", "#7a6a00", "#fbf4d6"));
      wrap.appendChild(chips);

      // The register table — one row per attendee with its consent icon.
      var table = el("table", {
        style: "width:100%;border-collapse:collapse;font-size:13.5px;border:1.5px solid var(--line,#E6E6E6);border-radius:14px;overflow:hidden"
      });
      table.innerHTML =
        "<thead><tr style='background:var(--purple-tint,#F0E8F4);text-align:left'>" +
        "<th style='padding:9px 12px'>Child</th>" +
        "<th style='padding:9px 12px'>Age</th>" +
        "<th style='padding:9px 12px'>Booked by</th>" +
        "<th style='padding:9px 12px'>Photos</th>" +
        "</tr></thead>";
      var tbody = el("tbody");
      register.attendees.forEach(function (a) {
        var tr = el("tr", { style: "border-top:1px solid var(--line,#E6E6E6)" });
        var crossed = isCrossedOut(a.icon);
        var iconColor = a.photoConsent === YES ? "#2f7d4f" : (crossed ? "#9a1f5e" : "#7a6a00");
        tr.innerHTML =
          "<td style='padding:9px 12px;font-weight:700'>" + esc(a.childName || "—") + "</td>" +
          "<td style='padding:9px 12px'>" + (a.age != null ? esc(a.age) : "—") + "</td>" +
          "<td style='padding:9px 12px;color:var(--muted,#808080)'>" + esc(a.adultName || "—") + "</td>" +
          "<td style='padding:9px 12px'>" +
            "<span title='" + esc(a.consentLabel) + "' " +
                  "aria-label='" + esc(a.consentLabel) + "' " +
                  "style='font-size:17px;color:" + iconColor + "'>" + a.icon + "</span> " +
            "<span style='font-size:12px;color:" + iconColor + ";font-weight:700'>" + esc(a.consentLabel) + "</span>" +
          "</td>";
        tbody.appendChild(tr);
      });
      table.appendChild(tbody);
      wrap.appendChild(table);

      // Marketing-safe action: list only the children who may appear in photos.
      var actions = el("div", { style: "margin-top:14px;display:flex;gap:10px;align-items:center;flex-wrap:wrap" });
      var safeBtn = el("button", { type: "button", class: "hc-btn" }, "📸 Show marketing-safe list");
      actions.appendChild(safeBtn);
      var safeOut = el("div", { style: "font-size:13px;color:var(--muted,#808080)" }, "");
      actions.appendChild(safeOut);
      wrap.appendChild(actions);

      safeBtn.addEventListener("click", function () {
        try {
          var safe = marketingSafeAttendees(register);
          var names = safe.map(function (r) { return r.childName; });
          safeOut.style.color = "#2f7d4f";
          safeOut.innerHTML = names.length
            ? "OK to photograph: <strong>" + esc(names.join(", ")) + "</strong> " +
              "(" + safe.length + " of " + register.summary.total + "; " +
              register.summary.optedOut + " opted out excluded)"
            : "No children have consented yet.";
          if (HC.util && HC.util.toast) {
            HC.util.toast("Marketing-safe list: " + safe.length + " of " + register.summary.total + " children");
          }
        } catch (e) { /* defensive */ }
      });

      mountEl.appendChild(wrap);
    } catch (e) {
      try {
        mountEl.innerHTML =
          '<p style="color:#9a1f5e">Consent-register preview failed: ' + esc(e && e.message) + "</p>";
      } catch (_) { /* swallow */ }
    }
  }

  function chip(text, fg, bg) {
    return HC.util.el("span", {
      style: "font-size:12.5px;font-weight:700;padding:5px 11px;border-radius:999px;" +
             "color:" + fg + ";background:" + bg + ";font-family:'Quicksand',system-ui,sans-serif"
    }, text);
  }

  /* ===================================================================
     selfTest — exercises the LOGIC + the acceptance criterion
     =================================================================== */

  function selfTest() {
    var pass = 0, fail = 0, log = [];
    function check(label, fn) {
      try { fn(); pass += 1; log.push("✓ " + label); }
      catch (e) { fail += 1; log.push("✗ " + label + " — " + (e && e.message ? e.message : String(e))); }
    }

    // 1. ACCEPTANCE CRITERION (core mapping): a consented attendee shows a
    //    camera icon; an opted-out attendee shows the crossed-out camera.
    check("Per-attendee icon: camera for consent, crossed camera for opt-out", function () {
      HC.assert(consentIcon("yes") === ICON_CONSENTED, "consent -> camera");
      HC.assert(consentIcon("no") === ICON_OPTED_OUT, "opt-out -> crossed camera");
      HC.assert(isCrossedOut(consentIcon("no")) === true, "opt-out icon must be visibly crossed out");
      HC.assert(isCrossedOut(consentIcon("yes")) === false, "consent icon must NOT be crossed out");
    });

    // 2. ACCEPTANCE CRITERION (on the built register, row by row): each row's
    //    icon reflects that row's consent state.
    check("Built register renders the correct icon per attendee row", function () {
      var reg = buildConsentRegister({
        providerId: "p1", providerName: "Test Camp", date: "2026-07-20",
        attendees: [
          { childName: "Yara", age: 8, photoConsent: "yes" },
          { childName: "Noah", age: 9, photoConsent: "no" },
          { childName: "Posy", age: 7, photoConsent: null }
        ]
      });
      // Sorted by first name: Noah, Posy, Yara.
      var byName = {};
      reg.attendees.forEach(function (r) { byName[r.childName] = r; });
      HC.assert(byName.Yara.icon === ICON_CONSENTED, "Yara (yes) shows camera");
      HC.assert(byName.Noah.icon === ICON_OPTED_OUT, "Noah (no) shows crossed camera");
      HC.assert(isCrossedOut(byName.Noah.icon), "Noah's icon is the crossed-out variant");
      HC.assert(byName.Posy.icon === ICON_PENDING, "Posy (undecided) shows pending marker");
      HC.assert(byName.Noah.optedOut === true, "opted-out flag set for No");
      HC.assert(byName.Yara.optedOut === false, "opted-out flag clear for Yes");
    });

    // 3. Consent summary counts are correct.
    check("Register summarises consented / opted-out / pending counts", function () {
      var reg = buildConsentRegister({
        attendees: [
          { childName: "A", photoConsent: "yes" },
          { childName: "B", photoConsent: "yes" },
          { childName: "C", photoConsent: "no" },
          { childName: "D", photoConsent: null }
        ]
      });
      HC.assert(reg.summary.total === 4, "total 4");
      HC.assert(reg.summary.consented === 2, "2 consented");
      HC.assert(reg.summary.optedOut === 1, "1 opted out");
      HC.assert(reg.summary.pending === 1, "1 pending");
    });

    // 4. Marketing-safe filter EXCLUDES opted-out (and, by default, pending).
    check("Marketing-safe list excludes opted-out children", function () {
      var reg = buildConsentRegister({
        attendees: [
          { childName: "Sam", photoConsent: "yes" },
          { childName: "Tia", photoConsent: "no" },
          { childName: "Uma", photoConsent: null }
        ]
      });
      var safe = marketingSafeAttendees(reg);
      var names = safe.map(function (r) { return r.childName; });
      HC.assert(names.indexOf("Sam") !== -1, "consented child included");
      HC.assert(names.indexOf("Tia") === -1, "opted-out child MUST be excluded");
      HC.assert(names.indexOf("Uma") === -1, "pending child excluded by default (cautious)");
      HC.assert(safe.length === 1, "exactly one marketing-safe child");

      var withPending = marketingSafeAttendees(reg, { includePending: true });
      HC.assert(withPending.length === 2, "pending included when explicitly allowed");
      HC.assert(withPending.map(function (r) { return r.childName; }).indexOf("Tia") === -1,
        "opted-out still excluded even when pending allowed");
    });

    // 5. Consent normalisation accepts the shapes the booking/checkout side
    //    might pass (bool, string variants, 0/1), defaulting to pending.
    check("Consent normalisation handles bool/string/number variants", function () {
      HC.assert(normaliseConsent(true) === YES && normaliseConsent("Yes") === YES && normaliseConsent(1) === YES, "truthy -> yes");
      HC.assert(normaliseConsent(false) === NO && normaliseConsent("No") === NO && normaliseConsent(0) === NO, "falsy -> no");
      HC.assert(normaliseConsent(undefined) === PENDING && normaliseConsent("maybe") === PENDING, "unknown -> pending");
    });

    // 6. Interop: a register built from persisted booking records surfaces each
    //    booking's stored consent as the right icon (the parent feature writes
    //    `booking:<id>` + `bookingIndex`; we read them here).
    check("Register reads consent from persisted booking records", function () {
      var pid = "interop-camp-" + Math.floor(Math.random() * 1e6);
      var idxKey = "bookingIndex";
      var prevIdx = HC.store.get(idxKey, []) || [];
      var b1 = "bk_test_yes_" + Math.floor(Math.random() * 1e6);
      var b2 = "bk_test_no_" + Math.floor(Math.random() * 1e6);
      HC.store.set("booking:" + b1, { id: b1, providerId: pid, childName: "Wren", childAge: 8, photoConsent: "yes" });
      HC.store.set("booking:" + b2, { id: b2, providerId: pid, childName: "Zane", childAge: 9, photoConsent: "no" });
      HC.store.set(idxKey, prevIdx.concat([b1, b2]));

      var attendees = attendeesFromBookingStore(pid);
      HC.assert(attendees.length === 2, "found both bookings for this provider, got " + attendees.length);
      var reg = buildConsentRegister({ providerId: pid, attendees: attendees });
      var byName = {};
      reg.attendees.forEach(function (r) { byName[r.childName] = r; });
      HC.assert(byName.Wren && byName.Wren.icon === ICON_CONSENTED, "stored 'yes' booking -> camera");
      HC.assert(byName.Zane && byName.Zane.icon === ICON_OPTED_OUT, "stored 'no' booking -> crossed camera");

      // cleanup so we don't pollute the store across runs
      try {
        HC.store.set(idxKey, prevIdx);
        if (HC.store.remove) { HC.store.remove("booking:" + b1); HC.store.remove("booking:" + b2); }
      } catch (e) { /* best effort */ }
    });

    // 7. Register is robust to junk attendee input (defensive).
    check("buildConsentRegister tolerates missing/garbage attendees", function () {
      var reg = buildConsentRegister({ attendees: [null, {}, { childName: "Ivy", photoConsent: "yes" }, 42] });
      HC.assert(reg.attendees.length === 4, "all rows normalised, got " + reg.attendees.length);
      var ivy = reg.attendees.filter(function (r) { return r.childName === "Ivy"; })[0];
      HC.assert(ivy && ivy.icon === ICON_CONSENTED, "valid row still mapped correctly");
      // rows with no consent default to pending
      var pendingCount = reg.attendees.filter(function (r) { return r.photoConsent === PENDING; }).length;
      HC.assert(pendingCount === 3, "junk/empty rows default to pending, got " + pendingCount);
    });

    return { pass: pass, fail: fail, log: log };
  }

  /* ===================================================================
     register
     =================================================================== */

  HC.registerFeature({
    id: "provider-photo-consent-register",
    title: "Photo-consent status on register",
    side: "provider",
    icon: "📷",
    summary: "On the class register, each attendee shows a camera icon (parent consented to photos & videos) or a crossed-out camera (opted out — keep out of marketing), with a one-click marketing-safe list.",
    render: render,
    selfTest: selfTest
  });
})();
