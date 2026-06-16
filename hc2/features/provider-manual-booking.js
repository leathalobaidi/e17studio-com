/* HolidayCamp feature — provider-manual-booking
 *
 * Add a manual (offline) booking to a register.  (PROVIDER side)
 *
 * Replicates Happity's "How to add a manual booking to your registers"
 * (support article 5370930). Evidence, verbatim from the article:
 *   1. "Find the class on your registers and click on the eye/view icon."
 *   2. "Click on 'Add manual booking'."
 *   3. "Use the 'Find a previous customer' autofill feature to add an
 *       existing customer."
 *   4. "If they are a new customer, fill in their details and click save."
 *   - "If the customer has bought a term or block booking ticket then they
 *      will automatically be added to all the registers for that booking."
 *   - Note: "The autofill feature defaults to loading info from the LAST
 *      booking the customer made with that class provider and so look out for
 *      anything that needs to be updated/changed before saving!"
 *
 * Framed for SCHOOL-AGE HOLIDAY CAMPS: a camp provider takes a booking off
 * Happity (a parent pays cash at the gate, phones up, or is transferred from
 * a sister camp). The provider opens the day's register and adds the child
 * manually. If the family has camped with them before, "Find a previous
 * customer" autofills the child + parent details from their LAST booking so
 * the provider just checks the school year / allergies and saves. A brand-new
 * family is typed in from scratch. A term-ticket child is auto-added to every
 * register in the run (e.g. all 5 mornings of a half-term week).
 *
 * ACCEPTANCE CRITERION (exercised by selfTest):
 *   Provider can add an offline customer (with previous-customer autofill)
 *   to a register.
 *
 * Self-contained, defensive, no imports/exports. Calls HC.registerFeature.
 */
(function () {
  "use strict";

  // Defensive: never throw at module load if HC isn't present.
  if (typeof window === "undefined" || !window.HC || typeof window.HC.registerFeature !== "function") {
    if (typeof console !== "undefined" && console.warn) {
      console.warn("[HC] provider-manual-booking: HC core not found; skipping registration.");
    }
    return;
  }

  var HC = window.HC;

  var STORE_KEY = "provider_manual_booking_state";

  /* ---------------- tiny helpers ---------------- */
  function nowIso() {
    try { return new Date().toISOString(); } catch (e) { return "" + Date.now(); }
  }

  function safeUid() {
    try { return HC.util.uid(); } catch (e) { return "id_" + Math.random().toString(36).slice(2); }
  }

  function str(v) { return v === null || v === undefined ? "" : String(v); }
  function trimmed(v) { return str(v).trim(); }

  // Normalise a name/email key so "Jo  Bloggs" and "jo bloggs" match for autofill.
  function normKey(s) {
    return trimmed(s).toLowerCase().replace(/\s+/g, " ");
  }

  /* ================================================================
   * Data model (mock, all in HC.store under one namespaced key):
   *
   *   state = {
   *     registers: { <registerId>: { id, providerId, campName, dateLabel,
   *                                  runId|null, entries: [bookingId...] } },
   *     bookings:  { <bookingId>:  { id, registerId, providerId, childName,
   *                                  childYear, parentName, parentEmail,
   *                                  allergies, notes, source, ticketType,
   *                                  runId|null, createdAt } },
   *     customers: { <providerId>: { <custKey>: { ...lastBooking snapshot,
   *                                               lastBookedAt } } }
   *   }
   *
   * A "customer" is keyed per provider by parentEmail (preferred) or
   * parentName, mirroring "the last booking the customer made WITH THAT class
   * provider". The customers map IS the autofill source.
   * ================================================================ */

  function loadState() {
    var s = HC.store.get(STORE_KEY, null);
    if (!s || typeof s !== "object") s = {};
    if (!s.registers || typeof s.registers !== "object") s.registers = {};
    if (!s.bookings || typeof s.bookings !== "object") s.bookings = {};
    if (!s.customers || typeof s.customers !== "object") s.customers = {};
    return s;
  }

  function saveState(s) {
    try { HC.store.set(STORE_KEY, s); return true; } catch (e) { return false; }
  }

  function customerKey(parentEmail, parentName) {
    var email = normKey(parentEmail);
    if (email) return "e:" + email;
    var name = normKey(parentName);
    if (name) return "n:" + name;
    return "";
  }

  /* ---------------- previous-customer autofill ----------------
   *
   * The heart of the feature. Look up a previous customer FOR THIS PROVIDER
   * and return a snapshot of their LAST booking to pre-fill the form. Matches
   * by email first, then by name (case/space-insensitive). Returns null if no
   * previous booking exists (i.e. a genuinely new customer).
   *
   * The returned object is a *copy* the provider can edit before saving —
   * per the evidence note to "look out for anything that needs updating".
   */
  function findPreviousCustomer(state, providerId, query) {
    try {
      var book = (state.customers && state.customers[providerId]) || {};
      var q = query || {};
      // Try an exact key (email then name).
      var key = customerKey(q.parentEmail, q.parentName);
      if (key && book[key]) return autofillSnapshot(book[key]);

      // Fall back to a loose contains-match on name OR email, so typing
      // "bloggs" or "jo@" finds the family. Returns the most recent match.
      var needle = normKey(q.parentName || q.parentEmail || q.text || "");
      if (!needle) return null;
      var best = null;
      for (var k in book) {
        if (!Object.prototype.hasOwnProperty.call(book, k)) continue;
        var c = book[k];
        var hay = normKey((c.parentName || "") + " " + (c.parentEmail || "") + " " + (c.childName || ""));
        if (hay.indexOf(needle) === -1) continue;
        if (!best || str(c.lastBookedAt) > str(best.lastBookedAt)) best = c;
      }
      return best ? autofillSnapshot(best) : null;
    } catch (e) {
      return null;
    }
  }

  // List previous customers for this provider (autofill dropdown source),
  // most-recent first.
  function listPreviousCustomers(state, providerId) {
    var book = (state.customers && state.customers[providerId]) || {};
    var out = [];
    for (var k in book) {
      if (Object.prototype.hasOwnProperty.call(book, k)) out.push(book[k]);
    }
    out.sort(function (a, b) { return str(b.lastBookedAt).localeCompare(str(a.lastBookedAt)); });
    return out;
  }

  // A fresh, editable copy of the fields the form pre-fills.
  function autofillSnapshot(c) {
    return {
      childName: str(c.childName),
      childYear: str(c.childYear),
      parentName: str(c.parentName),
      parentEmail: str(c.parentEmail),
      allergies: str(c.allergies),
      notes: str(c.notes),
      _autofilled: true,
      _lastBookedAt: str(c.lastBookedAt)
    };
  }

  /* ---------------- registers ---------------- */
  function ensureRegister(state, reg) {
    var id = reg && reg.id ? str(reg.id) : safeUid();
    if (!state.registers[id]) {
      state.registers[id] = {
        id: id,
        providerId: str(reg && reg.providerId),
        campName: str(reg && reg.campName) || "Holiday camp",
        dateLabel: str(reg && reg.dateLabel) || "",
        runId: reg && reg.runId ? str(reg.runId) : null,
        entries: []
      };
    }
    return state.registers[id];
  }

  // All registers that belong to the same multi-date run (a term/block week).
  function registersInRun(state, runId, providerId) {
    var out = [];
    if (!runId) return out;
    for (var id in state.registers) {
      if (!Object.prototype.hasOwnProperty.call(state.registers, id)) continue;
      var r = state.registers[id];
      if (r.runId === runId && (!providerId || r.providerId === providerId)) out.push(r);
    }
    return out;
  }

  /* ---------------- add a manual / offline booking ----------------
   *
   * The acceptance action. Adds an OFFLINE customer to a register. Steps:
   *   - normalise + validate the form (childName + a parent identifier needed)
   *   - if autofilled from a previous customer, edited values win (the provider
   *     may have updated the school year / allergies before saving)
   *   - write the booking onto the target register
   *   - if ticketType is 'term' or 'block' AND the register has a runId, also
   *     add the child to every OTHER register in that run (evidence: term/block
   *     ticket -> auto-added to all the registers for that booking)
   *   - upsert the customer record so this becomes their "last booking" and is
   *     available for autofill next time
   *
   * Returns { ok, booking|null, alsoAddedTo:[registerId...], error|null }.
   * Never throws.
   */
  function addManualBooking(state, registerId, form) {
    try {
      var reg = state.registers[str(registerId)];
      if (!reg) return { ok: false, booking: null, alsoAddedTo: [], error: "register not found" };

      var f = form || {};
      var childName = trimmed(f.childName);
      var parentName = trimmed(f.parentName);
      var parentEmail = trimmed(f.parentEmail);

      // Minimum to put a child on a register: a child name and SOME way to
      // identify the family (a parent name or email).
      if (!childName) return { ok: false, booking: null, alsoAddedTo: [], error: "child name required" };
      if (!parentName && !parentEmail) {
        return { ok: false, booking: null, alsoAddedTo: [], error: "a parent name or email is required" };
      }

      var ticketType = (f.ticketType === "term" || f.ticketType === "block") ? f.ticketType : "single";
      var providerId = reg.providerId;

      var booking = {
        id: safeUid(),
        registerId: reg.id,
        providerId: providerId,
        childName: childName,
        childYear: trimmed(f.childYear),
        parentName: parentName,
        parentEmail: parentEmail,
        allergies: trimmed(f.allergies),
        notes: trimmed(f.notes),
        // Manual bookings are OFFLINE by definition (not booked through Happity).
        source: f.source ? trimmed(f.source) : "manual",
        // Was the form pre-filled from a previous customer? (provenance only)
        autofilled: !!f.autofilled,
        ticketType: ticketType,
        runId: reg.runId || null,
        createdAt: nowIso()
      };

      state.bookings[booking.id] = booking;
      reg.entries.push(booking.id);

      // Term / block booking: add to every other register in the run.
      var alsoAddedTo = [];
      if ((ticketType === "term" || ticketType === "block") && reg.runId) {
        var siblings = registersInRun(state, reg.runId, providerId);
        for (var i = 0; i < siblings.length; i++) {
          var sib = siblings[i];
          if (sib.id === reg.id) continue;
          var child = {
            id: safeUid(),
            registerId: sib.id,
            providerId: providerId,
            childName: booking.childName,
            childYear: booking.childYear,
            parentName: booking.parentName,
            parentEmail: booking.parentEmail,
            allergies: booking.allergies,
            notes: booking.notes,
            source: booking.source,
            autofilled: booking.autofilled,
            ticketType: ticketType,
            runId: reg.runId,
            linkedFrom: booking.id,
            createdAt: booking.createdAt
          };
          state.bookings[child.id] = child;
          sib.entries.push(child.id);
          alsoAddedTo.push(sib.id);
        }
      }

      // Upsert the customer record -> this booking becomes their "last booking",
      // which is what autofill loads next time (evidence note).
      upsertCustomer(state, providerId, booking);

      saveState(state);
      return { ok: true, booking: booking, alsoAddedTo: alsoAddedTo, error: null };
    } catch (e) {
      return { ok: false, booking: null, alsoAddedTo: [], error: e && e.message ? e.message : String(e) };
    }
  }

  // Record (or refresh) the family as a previous customer of this provider.
  function upsertCustomer(state, providerId, booking) {
    var pid = str(providerId);
    if (!state.customers[pid]) state.customers[pid] = {};
    var key = customerKey(booking.parentEmail, booking.parentName);
    if (!key) return;
    state.customers[pid][key] = {
      childName: booking.childName,
      childYear: booking.childYear,
      parentName: booking.parentName,
      parentEmail: booking.parentEmail,
      allergies: booking.allergies,
      notes: booking.notes,
      lastBookedAt: booking.createdAt
    };
  }

  // Count children currently on a register.
  function registerCount(state, registerId) {
    var r = state.registers[str(registerId)];
    return r ? r.entries.length : 0;
  }

  function isOnRegister(state, registerId, childName, parentKeyVal) {
    var r = state.registers[str(registerId)];
    if (!r) return false;
    for (var i = 0; i < r.entries.length; i++) {
      var b = state.bookings[r.entries[i]];
      if (!b) continue;
      if (normKey(b.childName) === normKey(childName)) {
        if (!parentKeyVal) return true;
        var bk = customerKey(b.parentEmail, b.parentName);
        if (bk === parentKeyVal) return true;
      }
    }
    return false;
  }

  /* ---------------- a sensible default provider from live data ---------------- */
  function defaultProvider() {
    try {
      var ps = HC.data.providers;
      if (ps && ps.length) {
        var p = ps[0];
        return { id: str(p.id || p.slug || p.name || "provider-0"), name: str(p.name || "Holiday camp"), venue: str(p.venue || "") };
      }
    } catch (e) { /* ignore */ }
    return { id: "provider-0", name: "Holiday camp", venue: "" };
  }

  /* ================================================================
   * UI — render(mountEl). A working "Add manual booking" panel:
   *  - shows a register with its current children
   *  - "Find a previous customer" dropdown that autofills the form
   *  - a form for a new offline customer
   *  - Save -> the child appears on the register (and on the whole run
   *    if a term ticket is chosen)
   *
   * The UI uses its OWN demo register/customers in a separate store slot so it
   * never collides with the selfTest fixtures.
   * ================================================================ */
  var DEMO_STORE_KEY = "provider_manual_booking_demo";

  function loadDemo() {
    var s = HC.store.get(DEMO_STORE_KEY, null);
    if (!s || typeof s !== "object") s = {};
    if (!s.registers || typeof s.registers !== "object") s.registers = {};
    if (!s.bookings || typeof s.bookings !== "object") s.bookings = {};
    if (!s.customers || typeof s.customers !== "object") s.customers = {};
    return s;
  }
  function saveDemo(s) { try { HC.store.set(DEMO_STORE_KEY, s); } catch (e) {} }

  function seedDemo() {
    var s = loadDemo();
    var prov = defaultProvider();
    // Seed once: a Monday register + a couple of previous customers.
    if (!s.registers["demo-reg-mon"]) {
      s.registers["demo-reg-mon"] = {
        id: "demo-reg-mon", providerId: prov.id, campName: prov.name || "Summer Multi-Sports Camp",
        dateLabel: "Mon 28 Jul · AM", runId: "demo-run-week", entries: []
      };
    }
    if (!s.registers["demo-reg-tue"]) {
      s.registers["demo-reg-tue"] = {
        id: "demo-reg-tue", providerId: prov.id, campName: prov.name || "Summer Multi-Sports Camp",
        dateLabel: "Tue 29 Jul · AM", runId: "demo-run-week", entries: []
      };
    }
    if (!s.customers[prov.id]) {
      s.customers[prov.id] = {
        "e:sam.okafor@example.com": {
          childName: "Ada Okafor", childYear: "Year 4",
          parentName: "Sam Okafor", parentEmail: "sam.okafor@example.com",
          allergies: "Peanuts", notes: "Picks up at 1pm", lastBookedAt: "2026-04-10T09:00:00.000Z"
        },
        "e:priya.shah@example.com": {
          childName: "Rohan Shah", childYear: "Year 2",
          parentName: "Priya Shah", parentEmail: "priya.shah@example.com",
          allergies: "", notes: "", lastBookedAt: "2026-04-02T09:00:00.000Z"
        }
      };
    }
    saveDemo(s);
    return { state: s, providerId: prov.id };
  }

  function esc(s) {
    return str(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function render(mountEl) {
    try {
      var seeded = seedDemo();
      var providerId = seeded.providerId;
      var REG_ID = "demo-reg-mon";

      function paint() {
        var s = loadDemo();
        var reg = s.registers[REG_ID];
        var prevs = listPreviousCustomers(s, providerId);

        var entriesHtml = "";
        if (reg.entries.length === 0) {
          entriesHtml = '<p style="margin:0;color:#808080;font-size:13px">No children on this register yet.</p>';
        } else {
          entriesHtml = '<ul style="margin:0;padding-left:18px;font-size:13.5px;line-height:1.7">';
          for (var i = 0; i < reg.entries.length; i++) {
            var b = s.bookings[reg.entries[i]];
            if (!b) continue;
            entriesHtml += '<li><strong>' + esc(b.childName) + '</strong>' +
              (b.childYear ? ' (' + esc(b.childYear) + ')' : '') +
              ' — ' + esc(b.parentName || b.parentEmail) +
              (b.allergies ? ' · <span style="color:#9a1f5e">⚠ ' + esc(b.allergies) + '</span>' : '') +
              ' <span style="color:#808080">[' + esc(b.source) + (b.ticketType !== "single" ? "/" + esc(b.ticketType) : "") + ']</span></li>';
          }
          entriesHtml += '</ul>';
        }

        var prevOpts = '<option value="">— New customer (type details below) —</option>';
        for (var j = 0; j < prevs.length; j++) {
          var c = prevs[j];
          var k = customerKey(c.parentEmail, c.parentName);
          prevOpts += '<option value="' + esc(k) + '">' + esc(c.parentName) + ' · ' + esc(c.childName) + '</option>';
        }

        mountEl.innerHTML =
          '<div style="font-family:Nunito Sans,system-ui,sans-serif;color:#383838;font-size:14px;line-height:1.55">' +
            '<p style="margin:0 0 12px">Took a booking <strong>off Happity</strong> — cash at the gate, over the phone, or transferred from another camp? ' +
            'Open the register and add the child manually.</p>' +

            '<div style="background:#F0E8F4;border-radius:14px;padding:14px 16px;margin:0 0 16px">' +
              '<div style="font-family:Quicksand,system-ui,sans-serif;font-weight:700;color:#603488;font-size:15px">👁 ' + esc(reg.campName) + '</div>' +
              '<div style="font-size:12.5px;color:#603488;margin:2px 0 8px">Register · ' + esc(reg.dateLabel) + ' · <span id="hcmbCount">' + reg.entries.length + '</span> booked</div>' +
              '<div id="hcmbEntries">' + entriesHtml + '</div>' +
            '</div>' +

            '<label style="display:block;font-family:Quicksand,system-ui,sans-serif;font-weight:700;color:#603488;margin:0 0 4px">Find a previous customer</label>' +
            '<select id="hcmbPrev" style="width:100%;padding:9px 11px;border:1.5px solid #E6E6E6;border-radius:12px;font-size:14px;font-family:inherit;margin:0 0 4px">' + prevOpts + '</select>' +
            '<p style="margin:0 0 14px;font-size:12px;color:#808080">Autofills from their <strong>last booking</strong> with you — check the school year &amp; allergies before saving.</p>' +

            '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">' +
              field("hcmbChild", "Child name", "e.g. Ada Okafor") +
              field("hcmbYear", "School year", "e.g. Year 4") +
              field("hcmbParent", "Parent name", "e.g. Sam Okafor") +
              field("hcmbEmail", "Parent email", "e.g. sam@example.com") +
              field("hcmbAllergies", "Allergies / medical", "e.g. Peanuts") +
              ticketField() +
            '</div>' +

            '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:14px">' +
              '<button id="hcmbSave" type="button" class="hc-btn">Save to register</button>' +
              '<button id="hcmbClear" type="button" class="hc-btn hc-btn-ghost">Clear form</button>' +
            '</div>' +
            '<div id="hcmbMsg" style="margin-top:10px;font-size:13px"></div>' +
          '</div>';

        wire();
      }

      function field(id, label, ph) {
        return '<div><label style="display:block;font-size:12.5px;color:#603488;font-weight:700;font-family:Quicksand,system-ui,sans-serif;margin:0 0 3px">' + esc(label) + '</label>' +
          '<input id="' + id + '" type="text" placeholder="' + esc(ph) + '" style="width:100%;padding:8px 10px;border:1.5px solid #E6E6E6;border-radius:10px;font-size:14px;font-family:inherit" /></div>';
      }
      function ticketField() {
        return '<div><label style="display:block;font-size:12.5px;color:#603488;font-weight:700;font-family:Quicksand,system-ui,sans-serif;margin:0 0 3px">Ticket</label>' +
          '<select id="hcmbTicket" style="width:100%;padding:8px 10px;border:1.5px solid #E6E6E6;border-radius:10px;font-size:14px;font-family:inherit">' +
          '<option value="single">Single day</option>' +
          '<option value="term">Whole-week / term (adds to every day)</option>' +
          '</select></div>';
      }

      function wire() {
        var prevSel = mountEl.querySelector("#hcmbPrev");
        var msg = mountEl.querySelector("#hcmbMsg");
        var get = function (id) { return mountEl.querySelector("#" + id); };
        var autofilledFlag = { v: false };

        prevSel.addEventListener("change", function () {
          var key = prevSel.value;
          if (!key) { autofilledFlag.v = false; return; }
          var s = loadDemo();
          var book = s.customers[providerId] || {};
          var c = book[key];
          if (!c) return;
          var snap = autofillSnapshot(c);
          get("hcmbChild").value = snap.childName;
          get("hcmbYear").value = snap.childYear;
          get("hcmbParent").value = snap.parentName;
          get("hcmbEmail").value = snap.parentEmail;
          get("hcmbAllergies").value = snap.allergies;
          autofilledFlag.v = true;
          if (msg) {
            msg.innerHTML = '<span style="color:#603488">Autofilled from last booking (' +
              esc((snap._lastBookedAt || "").slice(0, 10)) + ') — please double-check before saving.</span>';
          }
          try { HC.util.toast("Autofilled " + snap.childName); } catch (e) {}
        });

        get("hcmbSave").addEventListener("click", function () {
          var s = loadDemo();
          var res = addManualBooking(s, REG_ID, {
            childName: get("hcmbChild").value,
            childYear: get("hcmbYear").value,
            parentName: get("hcmbParent").value,
            parentEmail: get("hcmbEmail").value,
            allergies: get("hcmbAllergies").value,
            ticketType: get("hcmbTicket").value,
            source: "manual",
            autofilled: autofilledFlag.v
          });
          if (!res.ok) {
            if (msg) msg.innerHTML = '<span style="color:#9a1f5e">Could not save: ' + esc(res.error) + '</span>';
            return;
          }
          var extra = res.alsoAddedTo.length
            ? ' Also added to ' + res.alsoAddedTo.length + ' other register' + (res.alsoAddedTo.length > 1 ? 's' : '') + ' for the week.'
            : '';
          try { HC.util.toast("Added " + res.booking.childName + " to the register"); } catch (e) {}
          paint();
          var m2 = mountEl.querySelector("#hcmbMsg");
          if (m2) m2.innerHTML = '<span style="color:#2f7d4f;font-weight:700">✓ ' + esc(res.booking.childName) + ' added to the register.' + esc(extra) + '</span>';
        });

        get("hcmbClear").addEventListener("click", function () {
          ["hcmbChild", "hcmbYear", "hcmbParent", "hcmbEmail", "hcmbAllergies"].forEach(function (id) { get(id).value = ""; });
          get("hcmbTicket").value = "single";
          prevSel.value = "";
          autofilledFlag.v = false;
          if (msg) msg.innerHTML = "";
        });
      }

      // A small reset so the demo doesn't grow forever across opens.
      var resetBtnWrap = HC.util.el("div", { style: "margin-top:14px" });
      var resetBtn = HC.util.el("button", { type: "button", class: "hc-btn hc-btn-ghost", style: "font-size:11px" }, "Reset demo register");
      resetBtn.addEventListener("click", function () {
        HC.store.remove ? HC.store.remove(DEMO_STORE_KEY) : HC.store.set(DEMO_STORE_KEY, null);
        seedDemo();
        paint();
        mountEl.appendChild(resetBtnWrap);
      });
      resetBtnWrap.appendChild(resetBtn);

      paint();
      mountEl.appendChild(resetBtnWrap);
    } catch (e) {
      mountEl.innerHTML = '<p style="color:#9a1f5e">Preview unavailable: ' +
        (e && e.message ? e.message : String(e)) + "</p>";
    }
  }

  /* ================================================================
   * selfTest — exercises the LOGIC and asserts the acceptance criterion:
   *   Provider can add an offline customer (with previous-customer autofill)
   *   to a register.  Multiple cases.
   * ================================================================ */
  function selfTest() {
    var pass = 0, fail = 0, log = [];
    function check(label, fn) {
      try {
        fn();
        pass += 1; log.push("✓ " + label);
      } catch (e) {
        fail += 1; log.push("✗ " + label + " — " + (e && e.message ? e.message : String(e)));
      }
    }
    var A = HC.assert;

    // Build an isolated in-memory state for each scenario (no shared leakage).
    function freshState(providerId) {
      var s = { registers: {}, bookings: {}, customers: {} };
      ensureRegister(s, { id: "reg-mon", providerId: providerId, campName: "Summer Camp", dateLabel: "Mon AM", runId: "run-week" });
      ensureRegister(s, { id: "reg-tue", providerId: providerId, campName: "Summer Camp", dateLabel: "Tue AM", runId: "run-week" });
      ensureRegister(s, { id: "reg-wed", providerId: providerId, campName: "Summer Camp", dateLabel: "Wed AM", runId: "run-week" });
      return s;
    }

    // --- ACCEPTANCE (new offline customer): add to a register from scratch ---
    check("ACCEPTANCE: provider adds a NEW offline customer to a register", function () {
      var s = freshState("prov-A");
      A(registerCount(s, "reg-mon") === 0, "register starts empty");
      var res = addManualBooking(s, "reg-mon", {
        childName: "Maya Lewis", childYear: "Year 3",
        parentName: "Dee Lewis", parentEmail: "dee.lewis@example.com",
        allergies: "Dairy", source: "manual"
      });
      A(res.ok === true, "save succeeded: " + res.error);
      A(res.booking && res.booking.source === "manual", "booking is offline/manual");
      A(registerCount(s, "reg-mon") === 1, "child now on the register, count=" + registerCount(s, "reg-mon"));
      A(isOnRegister(s, "reg-mon", "Maya Lewis", "e:dee.lewis@example.com"), "Maya is on the register");
    });

    // --- ACCEPTANCE (previous-customer autofill): the headline criterion ---
    check("ACCEPTANCE: previous-customer autofill pre-fills from the LAST booking, then adds to register", function () {
      var s = freshState("prov-B");
      // First booking establishes the family as a previous customer.
      var first = addManualBooking(s, "reg-mon", {
        childName: "Ada Okafor", childYear: "Year 4",
        parentName: "Sam Okafor", parentEmail: "sam.okafor@example.com",
        allergies: "Peanuts"
      });
      A(first.ok, "seed booking saved");

      // Now, a LATER booking: autofill should find them and load last details.
      var snap = findPreviousCustomer(s, "prov-B", { parentEmail: "sam.okafor@example.com" });
      A(snap !== null, "previous customer found by email");
      A(snap.childName === "Ada Okafor", "autofill loaded child name, got " + snap.childName);
      A(snap.childYear === "Year 4", "autofill loaded school year");
      A(snap.allergies === "Peanuts", "autofill loaded allergies (safeguarding)");
      A(snap._autofilled === true, "snapshot flagged as autofilled");

      // Provider edits the school year before saving (the evidence's warning),
      // then adds the autofilled+edited customer to a DIFFERENT register.
      snap.childYear = "Year 5";
      var res = addManualBooking(s, "reg-tue", {
        childName: snap.childName, childYear: snap.childYear,
        parentName: snap.parentName, parentEmail: snap.parentEmail,
        allergies: snap.allergies, autofilled: true
      });
      A(res.ok, "autofilled booking saved: " + res.error);
      A(res.booking.autofilled === true, "booking records it was autofilled");
      A(res.booking.childYear === "Year 5", "edited year wins over autofill, got " + res.booking.childYear);
      A(isOnRegister(s, "reg-tue", "Ada Okafor", "e:sam.okafor@example.com"), "Ada now on Tuesday register");
    });

    // --- autofill defaults to the LAST booking, not an older one ---
    check("Autofill loads the customer's MOST RECENT booking details", function () {
      var s = freshState("prov-C");
      addManualBooking(s, "reg-mon", {
        childName: "Leo Park", childYear: "Year 1",
        parentName: "Min Park", parentEmail: "min.park@example.com", notes: "old note"
      });
      // A later booking updates the family's stored snapshot.
      addManualBooking(s, "reg-tue", {
        childName: "Leo Park", childYear: "Year 2",
        parentName: "Min Park", parentEmail: "min.park@example.com", notes: "new note"
      });
      var snap = findPreviousCustomer(s, "prov-C", { parentEmail: "min.park@example.com" });
      A(snap.childYear === "Year 2", "loaded the latest year, got " + snap.childYear);
      A(snap.notes === "new note", "loaded latest notes, got " + snap.notes);
    });

    // --- autofill is per-provider (article: "with THAT class provider") ---
    check("Autofill is scoped per provider (no cross-provider leak)", function () {
      var s = freshState("prov-D");
      ensureRegister(s, { id: "reg-other", providerId: "prov-OTHER", campName: "Other Camp", dateLabel: "x" });
      addManualBooking(s, "reg-mon", {
        childName: "Tess Doyle", parentName: "Ray Doyle", parentEmail: "ray@example.com"
      });
      A(findPreviousCustomer(s, "prov-D", { parentEmail: "ray@example.com" }) !== null, "found under own provider");
      A(findPreviousCustomer(s, "prov-OTHER", { parentEmail: "ray@example.com" }) === null, "NOT found under a different provider");
    });

    // --- loose search: typing a partial name finds the family ---
    check("'Find a previous customer' matches a partial name/email", function () {
      var s = freshState("prov-E");
      addManualBooking(s, "reg-mon", {
        childName: "Otis Bloggs", parentName: "Jo Bloggs", parentEmail: "jo.bloggs@example.com"
      });
      A(findPreviousCustomer(s, "prov-E", { text: "bloggs" }) !== null, "partial 'bloggs' matches");
      A(findPreviousCustomer(s, "prov-E", { text: "jo.bl" }) !== null, "partial email matches");
      A(findPreviousCustomer(s, "prov-E", { text: "nobody" }) === null, "unknown text -> no match (genuinely new)");
    });

    // --- term/block ticket: auto-added to every register in the run ---
    check("Term/block ticket auto-adds the child to ALL registers in the run", function () {
      var s = freshState("prov-F");
      var res = addManualBooking(s, "reg-mon", {
        childName: "Iris Hale", parentName: "Bea Hale", parentEmail: "bea@example.com",
        ticketType: "term"
      });
      A(res.ok, "term booking saved");
      A(res.alsoAddedTo.length === 2, "added to the other 2 registers in the week, got " + res.alsoAddedTo.length);
      A(isOnRegister(s, "reg-mon", "Iris Hale") , "on Monday");
      A(isOnRegister(s, "reg-tue", "Iris Hale"), "on Tuesday (auto)");
      A(isOnRegister(s, "reg-wed", "Iris Hale"), "on Wednesday (auto)");
    });

    check("Single-day ticket only adds to the ONE register", function () {
      var s = freshState("prov-G");
      var res = addManualBooking(s, "reg-mon", {
        childName: "Sol Reed", parentName: "Kit Reed", parentEmail: "kit@example.com",
        ticketType: "single"
      });
      A(res.ok, "single booking saved");
      A(res.alsoAddedTo.length === 0, "no other registers touched, got " + res.alsoAddedTo.length);
      A(registerCount(s, "reg-tue") === 0, "Tuesday untouched");
    });

    // --- validation: must not silently add a blank child ---
    check("Validation: rejects a booking with no child name", function () {
      var s = freshState("prov-H");
      var res = addManualBooking(s, "reg-mon", { parentName: "No Child", parentEmail: "x@example.com" });
      A(res.ok === false, "rejected");
      A(/child name/i.test(res.error || ""), "error mentions child name, got " + res.error);
      A(registerCount(s, "reg-mon") === 0, "nothing added");
    });

    check("Validation: rejects a booking with no parent identifier", function () {
      var s = freshState("prov-I");
      var res = addManualBooking(s, "reg-mon", { childName: "Orphan Field" });
      A(res.ok === false, "rejected");
      A(/parent/i.test(res.error || ""), "error mentions parent, got " + res.error);
    });

    check("Validation: rejects when register does not exist", function () {
      var s = freshState("prov-J");
      var res = addManualBooking(s, "no-such-register", { childName: "Ghost", parentName: "Boo" });
      A(res.ok === false, "rejected");
      A(/register/i.test(res.error || ""), "error mentions register, got " + res.error);
    });

    // --- persistence round-trips through HC.store (mock, hc_ namespaced) ---
    check("A manual booking round-trips via HC.store", function () {
      var pid = "test_prov_" + safeUid();
      var s = loadState();
      ensureRegister(s, { id: "rt-reg", providerId: pid, campName: "RT Camp", dateLabel: "rt" });
      var res = addManualBooking(s, "rt-reg", {
        childName: "Round Trip", parentName: "Persist Test", parentEmail: "rt@example.com"
      });
      A(res.ok, "saved");
      // Re-load fresh from the store and confirm it persisted.
      var back = loadState();
      A(back.registers["rt-reg"] && back.registers["rt-reg"].entries.length === 1, "register persisted with the child");
      A(findPreviousCustomer(back, pid, { parentEmail: "rt@example.com" }) !== null, "customer persisted for autofill");
      // Clean up so we don't leak test state into the live store.
      try {
        var c = loadState();
        delete c.registers["rt-reg"];
        delete c.bookings[res.booking.id];
        if (c.customers[pid]) delete c.customers[pid];
        saveState(c);
      } catch (e) { /* ignore */ }
    });

    return { pass: pass, fail: fail, log: log };
  }

  /* ---------------- register ---------------- */
  HC.registerFeature({
    id: "provider-manual-booking",
    title: "Add a manual booking",
    side: "provider",
    icon: "📝",
    summary: "Add an offline customer to a register in a few clicks — with a 'Find a previous customer' autofill that loads their last booking. Term/block tickets auto-add the child to every day of the run.",
    render: render,
    selfTest: selfTest
  });
})();
