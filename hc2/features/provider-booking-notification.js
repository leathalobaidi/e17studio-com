/* HolidayCamp feature — provider-booking-notification
 *
 * Email the provider on EACH new booking, with the customer's details.
 * (PROVIDER side)
 *
 * Replicates Happity's "Will I get a notification when a customer makes a
 * booking?" (support article 5827735). Evidence, verbatim:
 *   "Every time you receive a booking through Happity bookings you will
 *    receive an email with the customer's details."
 *   "You can check who is booked on a class and view their details any time
 *    by taking a look at the register for a class."
 *
 * Framed for SCHOOL-AGE HOLIDAY CAMPS: when a parent books a child onto a
 * holiday camp (a single day, a whole-week run, or a HAF place), the camp
 * provider's bookings inbox immediately receives an email notification. The
 * email carries the customer's details — child name, school year, parent name
 * and contact, the camp/date booked, and any allergies/medical flags the
 * provider needs to read before the child turns up. One booking -> one email.
 *
 * ACCEPTANCE CRITERION (exercised by selfTest):
 *   Each booking emails the provider the customer's details.
 *
 * The "outbox" is a mock mail-sink in HC.store (no real email is sent). The
 * provider's notification email address is configurable and defaults to a
 * provider derived from live HC.data. A provider can mute notifications, but
 * the system still keeps a record so the register stays the source of truth.
 *
 * Self-contained, defensive, no imports/exports. Calls HC.registerFeature.
 */
(function () {
  "use strict";

  // Defensive: never throw at module load if HC isn't present.
  if (typeof window === "undefined" || !window.HC || typeof window.HC.registerFeature !== "function") {
    if (typeof console !== "undefined" && console.warn) {
      console.warn("[HC] provider-booking-notification: HC core not found; skipping registration.");
    }
    return;
  }

  var HC = window.HC;

  var STORE_KEY = "provider_booking_notification_state";
  var DEMO_STORE_KEY = "provider_booking_notification_demo";

  /* ---------------- tiny helpers ---------------- */
  function nowIso() {
    try { return new Date().toISOString(); } catch (e) { return "" + Date.now(); }
  }
  function safeUid() {
    try { return HC.util.uid(); } catch (e) { return "id_" + Math.random().toString(36).slice(2); }
  }
  function str(v) { return v === null || v === undefined ? "" : String(v); }
  function trimmed(v) { return str(v).trim(); }
  function esc(s) {
    return str(s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function isEmail(s) {
    // Deliberately permissive; just enough to flag obvious junk for the inbox.
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed(s));
  }

  /* ================================================================
   * Data model (mock, in HC.store under one namespaced key):
   *
   *   state = {
   *     settings: { <providerId>: { notifyEmail, muted:Boolean,
   *                                 includeAllergies:Boolean } },
   *     outbox:   [ { id, providerId, to, subject, body, bookingId,
   *                   customer:{...}, sentAt, delivered:Boolean,
   *                   suppressedReason|null } ],
   *     bookings: { <bookingId>: true }   // de-dupe guard: one email/booking
   *   }
   *
   * The OUTBOX is the heart of the feature — it is the provider's "bookings
   * inbox". Each entry is the email the provider receives, carrying the
   * customer's details. selfTest asserts against it.
   * ================================================================ */

  function loadState() {
    var s = HC.store.get(STORE_KEY, null);
    return normaliseState(s);
  }
  function normaliseState(s) {
    if (!s || typeof s !== "object") s = {};
    if (!s.settings || typeof s.settings !== "object") s.settings = {};
    if (!Array.isArray(s.outbox)) s.outbox = [];
    if (!s.bookings || typeof s.bookings !== "object") s.bookings = {};
    return s;
  }
  function saveState(s) {
    try { HC.store.set(STORE_KEY, s); return true; } catch (e) { return false; }
  }

  /* ---------------- provider notification settings ---------------- */
  function getSettings(state, providerId, fallbackEmail) {
    var pid = str(providerId);
    var cur = state.settings[pid];
    if (!cur || typeof cur !== "object") {
      cur = {
        notifyEmail: trimmed(fallbackEmail) || defaultEmailFor(pid),
        muted: false,
        includeAllergies: true
      };
      state.settings[pid] = cur;
    }
    // Backfill any missing fields defensively.
    if (!("notifyEmail" in cur)) cur.notifyEmail = defaultEmailFor(pid);
    if (!("muted" in cur)) cur.muted = false;
    if (!("includeAllergies" in cur)) cur.includeAllergies = true;
    return cur;
  }

  function setNotifyEmail(state, providerId, email) {
    var st = getSettings(state, providerId);
    st.notifyEmail = trimmed(email);
    return st;
  }
  function setMuted(state, providerId, muted) {
    var st = getSettings(state, providerId);
    st.muted = !!muted;
    return st;
  }

  function defaultEmailFor(providerId) {
    var slug = str(providerId).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    if (!slug) slug = "provider";
    return "bookings+" + slug + "@holidaycamp.example";
  }

  /* ---------------- the customer-details payload ----------------
   *
   * Distil a booking into the customer's details that the provider needs.
   * This is exactly what the evidence promises the email contains.
   */
  function customerDetails(booking) {
    var b = booking || {};
    return {
      childName: trimmed(b.childName),
      childYear: trimmed(b.childYear),
      parentName: trimmed(b.parentName),
      parentEmail: trimmed(b.parentEmail),
      parentPhone: trimmed(b.parentPhone),
      allergies: trimmed(b.allergies),
      campName: trimmed(b.campName),
      dateLabel: trimmed(b.dateLabel),
      ticketType: trimmed(b.ticketType) || "single",
      amount: b.amount === undefined || b.amount === null ? null : b.amount
    };
  }

  /* ---------------- compose the notification email ---------------- */
  function composeEmail(providerName, cust, includeAllergies) {
    var campBit = cust.campName ? cust.campName : "your holiday camp";
    var dateBit = cust.dateLabel ? " (" + cust.dateLabel + ")" : "";
    var subject = "New booking: " + (cust.childName || "a child") + " — " + campBit + dateBit;

    var lines = [];
    lines.push("You have a new booking for " + (providerName || "your camp") + ".");
    lines.push("");
    lines.push("CUSTOMER DETAILS");
    lines.push("Child: " + (cust.childName || "-") + (cust.childYear ? " (" + cust.childYear + ")" : ""));
    lines.push("Parent/carer: " + (cust.parentName || "-"));
    if (cust.parentEmail) lines.push("Email: " + cust.parentEmail);
    if (cust.parentPhone) lines.push("Phone: " + cust.parentPhone);
    lines.push("Camp: " + (cust.campName || "-") + (cust.dateLabel ? " — " + cust.dateLabel : ""));
    lines.push("Ticket: " + (cust.ticketType || "single"));
    if (includeAllergies && cust.allergies) {
      lines.push("⚠ Allergies / medical: " + cust.allergies);
    }
    if (cust.amount !== null && cust.amount !== undefined && cust.amount !== "") {
      try { lines.push("Paid: " + HC.util.money(cust.amount)); } catch (e) { lines.push("Paid: " + cust.amount); }
    }
    lines.push("");
    lines.push("You can view this child on the register for the class at any time.");

    return { subject: subject, body: lines.join("\n") };
  }

  /* ---------------- THE core action: notify on a new booking ----------------
   *
   * Called once per new booking. It:
   *   - validates there is a booking with a customer to describe
   *   - de-dupes: the SAME bookingId never produces two emails
   *   - reads the provider's notify settings (email + muted)
   *   - composes the email carrying the customer's details
   *   - "sends" it into the mock outbox (records it either way; if muted, the
   *     record is kept but flagged not-delivered so nothing is lost)
   *
   * Returns { ok, email|null, delivered:Boolean, suppressedReason|null,
   *           duplicate:Boolean, error|null }. Never throws.
   */
  function notifyNewBooking(state, providerId, booking, opts) {
    try {
      var b = booking || {};
      var pid = str(providerId);
      if (!pid) return result(false, null, false, null, false, "providerId required");

      var cust = customerDetails(b);
      if (!cust.childName && !cust.parentName && !cust.parentEmail) {
        return result(false, null, false, null, false, "booking has no customer details to send");
      }

      // De-dupe guard — one email per booking, even if the hook fires twice.
      var bookingId = trimmed(b.bookingId || b.id) || safeUid();
      if (state.bookings[bookingId]) {
        return result(true, null, false, null, true, null);
      }

      var o = opts || {};
      var providerName = trimmed(o.providerName);
      var settings = getSettings(state, pid, o.fallbackEmail);

      var to = trimmed(settings.notifyEmail);
      var suppressedReason = null;
      var delivered = true;

      if (settings.muted) {
        suppressedReason = "muted";
        delivered = false;
      } else if (!isEmail(to)) {
        // Can't deliver to a junk address — but still record it so the
        // provider can fix the address and resend (mirrors the confirmations
        // article's "correct the email address then resend").
        suppressedReason = "no-valid-email";
        delivered = false;
      }

      var composed = composeEmail(providerName, cust, settings.includeAllergies);

      var email = {
        id: safeUid(),
        providerId: pid,
        to: to,
        subject: composed.subject,
        body: composed.body,
        bookingId: bookingId,
        customer: cust,
        sentAt: nowIso(),
        delivered: delivered,
        suppressedReason: suppressedReason
      };

      state.outbox.push(email);
      state.bookings[bookingId] = true;

      return result(true, email, delivered, suppressedReason, false, null);
    } catch (e) {
      return result(false, null, false, null, false, e && e.message ? e.message : String(e));
    }
  }

  function result(ok, email, delivered, suppressedReason, duplicate, error) {
    return {
      ok: ok, email: email, delivered: delivered,
      suppressedReason: suppressedReason, duplicate: duplicate, error: error
    };
  }

  /* ---------------- outbox queries ---------------- */
  function outboxFor(state, providerId) {
    var pid = str(providerId);
    return state.outbox.filter(function (e) { return e.providerId === pid; });
  }
  function deliveredCount(state, providerId) {
    return outboxFor(state, providerId).filter(function (e) { return e.delivered; }).length;
  }
  function latestEmail(state, providerId) {
    var list = outboxFor(state, providerId);
    return list.length ? list[list.length - 1] : null;
  }
  // Re-send a previously-suppressed email after the address/mute is fixed
  // (evidence: correct the email then resend). Returns the updated record.
  function resend(state, emailId) {
    for (var i = 0; i < state.outbox.length; i++) {
      var e = state.outbox[i];
      if (e.id !== emailId) continue;
      var settings = getSettings(state, e.providerId);
      if (settings.muted) { e.delivered = false; e.suppressedReason = "muted"; return e; }
      e.to = trimmed(settings.notifyEmail);
      if (!isEmail(e.to)) { e.delivered = false; e.suppressedReason = "no-valid-email"; return e; }
      e.delivered = true; e.suppressedReason = null; e.sentAt = nowIso();
      return e;
    }
    return null;
  }

  /* ---------------- a sensible default provider from live data ---------------- */
  function defaultProvider() {
    try {
      var ps = HC.data.providers;
      if (ps && ps.length) {
        // Prefer a "real" camp provider over the council HAF aggregator at [0].
        var p = ps[1] || ps[0];
        return {
          id: str(p.id || p.slug || p.name || "provider-0"),
          name: str(p.name || "Holiday camp"),
          venue: str(p.venue || "")
        };
      }
    } catch (e) { /* ignore */ }
    return { id: "provider-0", name: "Holiday camp", venue: "" };
  }

  /* ================================================================
   * UI — render(mountEl). A working "Booking notifications" panel:
   *   - shows the notify email + a mute toggle
   *   - a "simulate a booking" form (child + parent + camp/date)
   *   - "Book it" fires notifyNewBooking and the email lands in the inbox
   *   - an inbox list rendering each email's subject + customer details
   *
   * Uses its OWN demo store slot so it never collides with selfTest fixtures.
   * ================================================================ */
  function loadDemo() { return normaliseState(HC.store.get(DEMO_STORE_KEY, null)); }
  function saveDemo(s) { try { HC.store.set(DEMO_STORE_KEY, s); } catch (e) {} }

  function render(mountEl) {
    try {
      var prov = defaultProvider();
      var providerId = "demo:" + prov.id;

      function paint() {
        var s = loadDemo();
        var settings = getSettings(s, providerId, defaultEmailFor(providerId));
        saveDemo(s); // persist any backfilled defaults
        var inbox = outboxFor(s, providerId).slice().reverse(); // newest first

        var inboxHtml = "";
        if (!inbox.length) {
          inboxHtml = '<p style="margin:0;color:#808080;font-size:13px">No booking emails yet. Take a booking below and one lands here instantly.</p>';
        } else {
          for (var i = 0; i < inbox.length; i++) {
            var e = inbox[i];
            var c = e.customer || {};
            var badge = e.delivered
              ? '<span style="background:#E1F0E4;color:#2f7d4f;font-weight:700;font-size:10.5px;padding:2px 8px;border-radius:999px">DELIVERED</span>'
              : '<span style="background:#FCE8F0;color:#9a1f5e;font-weight:700;font-size:10.5px;padding:2px 8px;border-radius:999px">' + esc((e.suppressedReason || "held").toUpperCase()) + '</span>';
            inboxHtml +=
              '<div style="border:1.5px solid #E6E6E6;border-radius:12px;padding:12px 14px;margin:0 0 10px">' +
                '<div style="display:flex;justify-content:space-between;gap:8px;align-items:center">' +
                  '<div style="font-family:Quicksand,system-ui,sans-serif;font-weight:700;color:#603488;font-size:14px">📧 ' + esc(e.subject) + '</div>' +
                  badge +
                '</div>' +
                '<div style="font-size:12px;color:#808080;margin:3px 0 8px">To: ' + esc(e.to || "—") + '</div>' +
                '<div style="font-size:13px;line-height:1.65;color:#383838">' +
                  '<strong>' + esc(c.childName || "-") + '</strong>' + (c.childYear ? ' (' + esc(c.childYear) + ')' : '') + '<br>' +
                  'Parent: ' + esc(c.parentName || "-") +
                  (c.parentEmail ? ' · ' + esc(c.parentEmail) : '') +
                  (c.parentPhone ? ' · ' + esc(c.parentPhone) : '') + '<br>' +
                  esc(c.campName || "-") + (c.dateLabel ? ' — ' + esc(c.dateLabel) : '') + ' · ' + esc(c.ticketType || "single") +
                  (c.allergies && settings.includeAllergies ? '<br><span style="color:#9a1f5e">⚠ Allergies: ' + esc(c.allergies) + '</span>' : '') +
                '</div>' +
              '</div>';
          }
        }

        mountEl.innerHTML =
          '<div style="font-family:Nunito Sans,system-ui,sans-serif;color:#383838;font-size:14px;line-height:1.55">' +
            '<p style="margin:0 0 12px">Every time a parent books a child onto <strong>' + esc(prov.name) + '</strong>, ' +
            'you get an <strong>email with the customer’s details</strong> — straight away. ' +
            'You can always re-check who is booked on the register too.</p>' +

            '<div style="background:#F0E8F4;border-radius:14px;padding:14px 16px;margin:0 0 16px">' +
              '<label style="display:block;font-family:Quicksand,system-ui,sans-serif;font-weight:700;color:#603488;font-size:13px;margin:0 0 3px">Notifications go to</label>' +
              '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">' +
                '<input id="hcbnEmail" type="text" value="' + esc(settings.notifyEmail) + '" style="flex:1;min-width:200px;padding:8px 10px;border:1.5px solid #E6E6E6;border-radius:10px;font-size:14px;font-family:inherit" />' +
                '<label style="display:flex;align-items:center;gap:6px;font-size:13px;color:#603488;font-weight:700">' +
                  '<input id="hcbnMute" type="checkbox"' + (settings.muted ? ' checked' : '') + ' /> Mute</label>' +
              '</div>' +
              '<p style="margin:6px 0 0;font-size:12px;color:#808080">A muted or invalid address still records the booking — fix it and re-send from the inbox.</p>' +
            '</div>' +

            '<div style="font-family:Quicksand,system-ui,sans-serif;font-weight:700;color:#603488;font-size:15px;margin:0 0 8px">Simulate a booking</div>' +
            '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">' +
              field("hcbnChild", "Child name", "e.g. Maya Lewis") +
              field("hcbnYear", "School year", "e.g. Year 3") +
              field("hcbnParent", "Parent name", "e.g. Dee Lewis") +
              field("hcbnPEmail", "Parent email", "e.g. dee@example.com") +
              field("hcbnPhone", "Parent phone", "e.g. 07700 900123") +
              field("hcbnAllergies", "Allergies / medical", "e.g. Dairy") +
              field("hcbnDate", "Camp / date", "e.g. Mon 28 Jul · AM") +
            '</div>' +
            '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:14px">' +
              '<button id="hcbnBook" type="button" class="hc-btn">Book it (send email)</button>' +
              '<button id="hcbnReset" type="button" class="hc-btn hc-btn-ghost" style="font-size:11px">Reset inbox</button>' +
            '</div>' +
            '<div id="hcbnMsg" style="margin-top:10px;font-size:13px"></div>' +

            '<div style="font-family:Quicksand,system-ui,sans-serif;font-weight:700;color:#603488;font-size:15px;margin:18px 0 8px">📥 Bookings inbox · <span id="hcbnCount">' + outboxFor(s, providerId).length + '</span></div>' +
            '<div id="hcbnInbox">' + inboxHtml + '</div>' +
          '</div>';

        wire();
      }

      function field(id, label, ph) {
        return '<div><label style="display:block;font-size:12.5px;color:#603488;font-weight:700;font-family:Quicksand,system-ui,sans-serif;margin:0 0 3px">' + esc(label) + '</label>' +
          '<input id="' + id + '" type="text" placeholder="' + esc(ph) + '" style="width:100%;padding:8px 10px;border:1.5px solid #E6E6E6;border-radius:10px;font-size:14px;font-family:inherit" /></div>';
      }

      function wire() {
        var get = function (id) { return mountEl.querySelector("#" + id); };
        var msg = get("hcbnMsg");

        get("hcbnEmail").addEventListener("change", function () {
          var s = loadDemo();
          setNotifyEmail(s, providerId, get("hcbnEmail").value);
          saveDemo(s);
        });
        get("hcbnMute").addEventListener("change", function () {
          var s = loadDemo();
          setMuted(s, providerId, get("hcbnMute").checked);
          saveDemo(s);
        });

        get("hcbnBook").addEventListener("click", function () {
          var s = loadDemo();
          // Make sure the latest typed email/mute are saved before sending.
          setNotifyEmail(s, providerId, get("hcbnEmail").value);
          setMuted(s, providerId, get("hcbnMute").checked);

          var res = notifyNewBooking(s, providerId, {
            bookingId: safeUid(),
            childName: get("hcbnChild").value,
            childYear: get("hcbnYear").value,
            parentName: get("hcbnParent").value,
            parentEmail: get("hcbnPEmail").value,
            parentPhone: get("hcbnPhone").value,
            allergies: get("hcbnAllergies").value,
            campName: prov.name,
            dateLabel: get("hcbnDate").value,
            ticketType: "single"
          }, { providerName: prov.name, fallbackEmail: get("hcbnEmail").value });

          if (!res.ok) {
            if (msg) msg.innerHTML = '<span style="color:#9a1f5e">Could not send: ' + esc(res.error) + '</span>';
            return;
          }
          saveDemo(s);
          try { HC.util.toast(res.delivered ? "📧 Email sent to provider" : "Booking recorded (email held)"); } catch (e) {}
          paint();
          var m2 = mountEl.querySelector("#hcbnMsg");
          if (m2) {
            m2.innerHTML = res.delivered
              ? '<span style="color:#2f7d4f;font-weight:700">✓ Email with the customer’s details sent to ' + esc(res.email.to) + '.</span>'
              : '<span style="color:#9a1f5e">Booking recorded but email held (' + esc(res.suppressedReason) + ') — fix the address or unmute, then re-send.</span>';
          }
        });

        get("hcbnReset").addEventListener("click", function () {
          if (HC.store.remove) HC.store.remove(DEMO_STORE_KEY); else saveDemo(normaliseState(null));
          paint();
        });
      }

      paint();
    } catch (e) {
      mountEl.innerHTML = '<p style="color:#9a1f5e">Preview unavailable: ' +
        (e && e.message ? e.message : String(e)) + "</p>";
    }
  }

  /* ================================================================
   * selfTest — exercises the LOGIC and asserts the acceptance criterion:
   *   "Each booking emails the provider the customer's details."
   * Multiple cases.
   * ================================================================ */
  function selfTest() {
    var pass = 0, fail = 0, log = [];
    function check(label, fn) {
      try { fn(); pass += 1; log.push("✓ " + label); }
      catch (e) { fail += 1; log.push("✗ " + label + " — " + (e && e.message ? e.message : String(e))); }
    }
    var A = HC.assert;

    function freshState() { return normaliseState(null); }

    var sampleBooking = {
      bookingId: "bk-1",
      childName: "Maya Lewis", childYear: "Year 3",
      parentName: "Dee Lewis", parentEmail: "dee.lewis@example.com",
      parentPhone: "07700 900123",
      allergies: "Dairy",
      campName: "Summer Multi-Sports Camp", dateLabel: "Mon 28 Jul · AM",
      ticketType: "single", amount: 32
    };

    // --- ACCEPTANCE: one booking -> one email carrying the customer details ---
    check("ACCEPTANCE: a booking emails the provider the customer's details", function () {
      var s = freshState();
      A(outboxFor(s, "prov-A").length === 0, "inbox starts empty");
      var res = notifyNewBooking(s, "prov-A", sampleBooking, { providerName: "Summer Camp" });
      A(res.ok === true, "notify succeeded: " + res.error);
      A(res.delivered === true, "email delivered to the provider");
      A(outboxFor(s, "prov-A").length === 1, "exactly one email in the provider's inbox");

      var email = res.email;
      A(email !== null, "an email object was produced");
      A(isEmail(email.to), "email addressed to a real address: " + email.to);
      // The customer's DETAILS must be in the email.
      var c = email.customer;
      A(c.childName === "Maya Lewis", "child name carried, got " + c.childName);
      A(c.parentName === "Dee Lewis", "parent name carried, got " + c.parentName);
      A(c.parentEmail === "dee.lewis@example.com", "parent email carried");
      A(c.parentPhone === "07700 900123", "parent phone carried");
      A(c.childYear === "Year 3", "school year carried");
      A(c.allergies === "Dairy", "allergies/medical carried (safeguarding)");
      A(c.campName === "Summer Multi-Sports Camp", "camp carried");
      A(c.dateLabel === "Mon 28 Jul · AM", "date carried");
      // And the rendered email body must actually mention them.
      A(email.body.indexOf("Maya Lewis") !== -1, "body names the child");
      A(email.body.indexOf("Dee Lewis") !== -1, "body names the parent");
      A(email.body.indexOf("dee.lewis@example.com") !== -1, "body shows contact email");
      A(email.body.indexOf("Dairy") !== -1, "body flags the allergy");
      A(/new booking/i.test(email.subject), "subject signals a new booking, got " + email.subject);
    });

    // --- EACH booking emails: two distinct bookings -> two emails ---
    check("ACCEPTANCE: EACH new booking produces its own email", function () {
      var s = freshState();
      notifyNewBooking(s, "prov-B", { bookingId: "b1", childName: "Ada Okafor", parentName: "Sam Okafor", parentEmail: "sam@example.com", campName: "Camp", dateLabel: "Mon" });
      notifyNewBooking(s, "prov-B", { bookingId: "b2", childName: "Leo Park", parentName: "Min Park", parentEmail: "min@example.com", campName: "Camp", dateLabel: "Tue" });
      var inbox = outboxFor(s, "prov-B");
      A(inbox.length === 2, "two bookings -> two emails, got " + inbox.length);
      A(inbox[0].customer.childName === "Ada Okafor", "first email is Ada's");
      A(inbox[1].customer.childName === "Leo Park", "second email is Leo's");
      A(inbox[0].bookingId !== inbox[1].bookingId, "each email tied to its own booking");
    });

    // --- de-dupe: the SAME booking fired twice still emails only once ---
    check("A repeated hook for the SAME booking emails only once (de-dupe)", function () {
      var s = freshState();
      var r1 = notifyNewBooking(s, "prov-C", sampleBooking, {});
      var r2 = notifyNewBooking(s, "prov-C", sampleBooking, {});
      A(r1.ok && r1.duplicate === false, "first fire sends");
      A(r2.ok && r2.duplicate === true, "second fire is a no-op duplicate");
      A(outboxFor(s, "prov-C").length === 1, "still only one email, got " + outboxFor(s, "prov-C").length);
    });

    // --- the email goes to the PROVIDER's configured notify address ---
    check("Email is addressed to the provider's notification address", function () {
      var s = freshState();
      setNotifyEmail(s, "prov-D", "ops@summercamp.example");
      var res = notifyNewBooking(s, "prov-D", { bookingId: "bd", childName: "Iris", parentName: "Bea", parentEmail: "bea@example.com" }, {});
      A(res.ok && res.delivered, "delivered");
      A(res.email.to === "ops@summercamp.example", "addressed to the provider, got " + res.email.to);
    });

    // --- notifications scoped per provider (no cross-provider leak) ---
    check("Inboxes are scoped per provider", function () {
      var s = freshState();
      notifyNewBooking(s, "prov-E", { bookingId: "e1", childName: "Tess", parentName: "Ray", parentEmail: "ray@example.com" }, {});
      A(outboxFor(s, "prov-E").length === 1, "provider E has their email");
      A(outboxFor(s, "prov-OTHER").length === 0, "a different provider sees nothing");
    });

    // --- muted: still recorded, but held (not delivered) ---
    check("Muted provider: booking still recorded but email held, then re-sendable", function () {
      var s = freshState();
      setMuted(s, "prov-F", true);
      var res = notifyNewBooking(s, "prov-F", { bookingId: "bf", childName: "Sol", parentName: "Kit", parentEmail: "kit@example.com" }, {});
      A(res.ok === true, "still records the booking");
      A(res.delivered === false, "but does not deliver while muted");
      A(res.suppressedReason === "muted", "reason is 'muted', got " + res.suppressedReason);
      A(outboxFor(s, "prov-F").length === 1, "email kept in inbox so nothing is lost");
      // Unmute and re-send -> now it delivers.
      setMuted(s, "prov-F", false);
      var sent = resend(s, res.email.id);
      A(sent && sent.delivered === true, "re-send delivers after unmute");
      A(sent.suppressedReason === null, "no longer suppressed");
    });

    // --- invalid notify address: held with a clear reason, then fix + resend ---
    check("Invalid notify address: held with reason, fixable and re-sendable", function () {
      var s = freshState();
      setNotifyEmail(s, "prov-G", "not-an-email");
      var res = notifyNewBooking(s, "prov-G", { bookingId: "bg", childName: "Otis", parentName: "Jo", parentEmail: "jo@example.com" }, {});
      A(res.ok === true, "booking recorded");
      A(res.delivered === false, "not delivered to a junk address");
      A(res.suppressedReason === "no-valid-email", "reason is 'no-valid-email', got " + res.suppressedReason);
      // Correct the address and re-send (mirrors the confirmations article).
      setNotifyEmail(s, "prov-G", "fixed@camp.example");
      var sent = resend(s, res.email.id);
      A(sent && sent.delivered === true, "re-send delivers after fixing the address");
      A(sent.to === "fixed@camp.example", "re-sent to the corrected address");
    });

    // --- allergies can be suppressed from the email if the provider opts out ---
    check("Allergy line obeys the includeAllergies setting", function () {
      var s = freshState();
      getSettings(s, "prov-H").includeAllergies = false;
      var res = notifyNewBooking(s, "prov-H", { bookingId: "bh", childName: "Nat", parentName: "Pat", parentEmail: "pat@example.com", allergies: "Nuts" }, {});
      A(res.ok, "sent");
      A(res.email.customer.allergies === "Nuts", "the detail is still captured for the register");
      A(res.email.body.indexOf("Allergies") === -1, "but the allergy line is omitted from this provider's email body");
    });

    // --- validation: a booking with no customer at all is rejected ---
    check("Validation: rejects a booking with no customer details", function () {
      var s = freshState();
      var res = notifyNewBooking(s, "prov-I", { bookingId: "bi" }, {});
      A(res.ok === false, "rejected");
      A(/customer details/i.test(res.error || ""), "error mentions customer details, got " + res.error);
      A(outboxFor(s, "prov-I").length === 0, "no email sent");
    });

    // --- validation: providerId is required ---
    check("Validation: rejects when providerId is missing", function () {
      var s = freshState();
      var res = notifyNewBooking(s, "", { childName: "Ghost", parentName: "Boo" }, {});
      A(res.ok === false, "rejected");
      A(/provider/i.test(res.error || ""), "error mentions provider, got " + res.error);
    });

    // --- subject/body are non-empty for a normal booking ---
    check("Composed email has a non-empty subject and body", function () {
      var s = freshState();
      var res = notifyNewBooking(s, "prov-J", { bookingId: "bj", childName: "Zed", parentName: "Wes", parentEmail: "wes@example.com" }, {});
      A(res.email.subject.length > 0, "subject not empty");
      A(res.email.body.length > 0, "body not empty");
      A(res.email.body.indexOf("Zed") !== -1, "body still names the child");
    });

    // --- persistence round-trips through HC.store (mock, hc_ namespaced) ---
    check("Notification round-trips via HC.store", function () {
      var pid = "test_prov_" + safeUid();
      var s = loadState();
      var before = outboxFor(s, pid).length;
      var res = notifyNewBooking(s, pid, {
        bookingId: "rt-" + pid, childName: "Round Trip", parentName: "Persist", parentEmail: "rt@example.com",
        campName: "RT Camp", dateLabel: "rt"
      }, {});
      A(res.ok, "sent");
      saveState(s);
      var back = loadState();
      A(outboxFor(back, pid).length === before + 1, "email persisted in the store");
      var got = latestEmail(back, pid);
      A(got && got.customer.childName === "Round Trip", "persisted email still carries the customer's details");
      // Clean up so we don't leak test state into the live store.
      try {
        var c = loadState();
        c.outbox = c.outbox.filter(function (e) { return e.providerId !== pid; });
        delete c.settings[pid];
        delete c.bookings["rt-" + pid];
        saveState(c);
      } catch (e) { /* ignore */ }
    });

    return { pass: pass, fail: fail, log: log };
  }

  /* ---------------- register ---------------- */
  HC.registerFeature({
    id: "provider-booking-notification",
    title: "Booking notifications",
    side: "provider",
    icon: "📧",
    summary: "Get an email the moment a parent books — carrying the customer's details (child, school year, parent contact, camp/date and any allergies). One booking, one email; mute or fix the address and re-send from your bookings inbox.",
    render: render,
    selfTest: selfTest
  });
})();
