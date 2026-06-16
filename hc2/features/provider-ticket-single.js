/* HolidayCamp feature — provider-ticket-single
 *
 * Single / PAYG / drop-in tickets  (provider side)
 *
 * Replicates the Happity "Single ticket" concept. Evidence:
 *   - support article 10248958 ("Creating and Managing Tickets, Prices, and
 *     Term Bookings on Happity"):
 *       "Single Tickets: single tickets are ideal for one-off events or Pay As
 *        You Go (PAYG) drop-in sessions."
 *       Note: "You can toggle single tickets on and off for different class
 *        dates under the 'Customise' setting next to your Price List for
 *        individual class listings."
 *       FAQ: a single ticket can be made "valid for certain dates only" by
 *        choosing "All events" or "Selected events" and ticking the dates.
 *   - support article 6020405 ("Can I add single tickets to individual
 *     events?"): a single ticket defaults to "Any event" (every date) and can
 *     be switched to "Selected events" so parents "will only be able to choose
 *     this ticket type for those events."
 *
 * Framed for SCHOOL-AGE HOLIDAY CAMPS (not baby classes). A provider sells
 * a drop-in day pass for a multi-activity camp — one ISO date per booking.
 *
 * DOMAIN MODEL
 *   - A SINGLE ticket books exactly ONE date per purchase (PAYG / drop-in).
 *   - Its date scope is either:
 *       'all'      -> valid on every running date of the camp ("All events"),
 *       'selected' -> valid only on the dates the provider toggled ON via the
 *                     'Customise' panel ("Selected events").
 *   - A parent booking is only accepted when the chosen date is (a) a real
 *     running date of the camp and (b) currently enabled for the ticket.
 *
 * ACCEPTANCE CRITERION (asserted in selfTest):
 *   "A single ticket books one date and can be toggled per date via 'Customise'."
 *   We verify:
 *     1. booking a single ticket consumes exactly ONE date,
 *     2. by default (scope 'all') the ticket is available on every camp date,
 *     3. switching to 'selected' and toggling a date OFF makes that date
 *        unbookable while other selected dates remain bookable,
 *     4. toggling the same date back ON restores bookability,
 *     5. a date that is not a real camp date can never be booked.
 *
 * Self-contained, defensive, no imports/exports. Calls HC.registerFeature.
 */
(function () {
  "use strict";

  // Defensive: never throw at module load if HC isn't present.
  if (typeof window === "undefined" || !window.HC || typeof window.HC.registerFeature !== "function") {
    if (typeof console !== "undefined" && console.warn) {
      console.warn("[HC] provider-ticket-single: HC core not found; skipping registration.");
    }
    return;
  }

  var HC = window.HC;

  var STORE_KEY = "provider_single_tickets"; // persisted, keyed by providerId

  var SCOPE_ALL = "all";        // "All events" / "Any event" — valid every date
  var SCOPE_SELECTED = "selected"; // "Selected events" — valid only on chosen dates

  /* ===================================================================
     PURE LOGIC (testable, DOM-free)
     =================================================================== */

  function asText(v) {
    return typeof v === "string" ? v : (v == null ? "" : String(v));
  }

  // Strict YYYY-MM-DD validation that rejects impossible calendar dates.
  function isValidISODate(s) {
    var str = asText(s);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(str)) return false;
    var p = str.split("-");
    var y = Number(p[0]), m = Number(p[1]), d = Number(p[2]);
    if (m < 1 || m > 12 || d < 1 || d > 31) return false;
    var dt = new Date(Date.UTC(y, m - 1, d));
    return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
  }

  var DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  var MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  function dateLabel(iso) {
    try {
      if (!isValidISODate(iso)) return asText(iso);
      var p = iso.split("-");
      var dt = new Date(Date.UTC(Number(p[0]), Number(p[1]) - 1, Number(p[2])));
      return DOW[dt.getUTCDay()] + " " + Number(p[2]) + " " + MON[Number(p[1]) - 1] + " " + p[0];
    } catch (e) {
      return asText(iso);
    }
  }

  function toMoneyOrNull(v) {
    if (v === undefined || v === null || v === "") return null;
    var n = Number(v);
    if (!isFinite(n) || n < 0) return null;
    return n;
  }

  function safeUid(prefix) {
    try { return HC.util.uid(); }
    catch (e) { return (prefix || "id") + "_" + Date.now() + "_" + Math.floor(Math.random() * 1e6); }
  }

  // Normalise + de-duplicate a list of ISO dates, keeping only valid ones,
  // sorted ascending. This is the camp's set of running dates.
  function normaliseDates(list) {
    var seen = {};
    var out = [];
    if (!Array.isArray(list)) return out;
    for (var i = 0; i < list.length; i++) {
      var iso = asText(list[i]).trim();
      if (!isValidISODate(iso) || seen[iso]) continue;
      seen[iso] = true;
      out.push(iso);
    }
    out.sort();
    return out;
  }

  /* ---- ticket construction ------------------------------------------- */

  // Build a SINGLE / PAYG / drop-in ticket for a camp running on `dates`.
  //   input: { name, price, dates:[ISO...], scope?, enabledDates?, trial? }
  // By default scope is 'all' (mirrors Happity's "Any event" default), so the
  // ticket is valid on every camp date. `tags` is fixed to ['single'] plus an
  // optional 'trial' flag (single tickets can also be trial tickets).
  function makeSingleTicket(input) {
    var a = (input && typeof input === "object") ? input : {};
    var dates = normaliseDates(a.dates);
    var scope = (a.scope === SCOPE_SELECTED) ? SCOPE_SELECTED : SCOPE_ALL;

    // enabledDates is only meaningful under 'selected'. Default: all dates ON.
    var enabled;
    if (scope === SCOPE_SELECTED && Array.isArray(a.enabledDates)) {
      enabled = normaliseDates(a.enabledDates).filter(function (d) {
        return dates.indexOf(d) !== -1; // never enable a non-camp date
      });
    } else {
      enabled = dates.slice();
    }

    return {
      id: safeUid("tkt"),
      type: "single",            // <-- PAYG / drop-in: one date per purchase
      perPurchaseDates: 1,       // <-- a single ticket books exactly ONE date
      name: asText(a.name).trim() || "Drop-in day pass",
      price: toMoneyOrNull(a.price),
      trial: !!a.trial,          // single tickets can be offered as Trial too
      dates: dates,              // every date the camp runs
      scope: scope,              // 'all' | 'selected'  (the Customise toggle)
      enabledDates: enabled,     // which dates this ticket is valid on
      createdAt: Date.now()
    };
  }

  /* ---- the 'Customise' toggle (per-date availability) ---------------- */

  // Is the ticket currently bookable on `iso`? Must be a real camp date AND
  // (scope 'all' OR explicitly enabled under 'selected').
  function isDateAvailable(ticket, iso) {
    if (!ticket || !isValidISODate(iso)) return false;
    if (ticket.dates.indexOf(iso) === -1) return false; // not a camp date
    if (ticket.scope === SCOPE_ALL) return true;
    return ticket.enabledDates.indexOf(iso) !== -1;
  }

  // Set the customise scope. Switching to 'all' clears per-date selection
  // (everything becomes available); switching to 'selected' starts from the
  // current enabled set (or all dates if none recorded yet).
  function setScope(ticket, scope) {
    if (!ticket) return ticket;
    if (scope === SCOPE_SELECTED) {
      ticket.scope = SCOPE_SELECTED;
      if (!Array.isArray(ticket.enabledDates) || !ticket.enabledDates.length) {
        ticket.enabledDates = ticket.dates.slice();
      }
    } else {
      ticket.scope = SCOPE_ALL;
      ticket.enabledDates = ticket.dates.slice();
    }
    return ticket;
  }

  // Toggle one date ON/OFF for the ticket. Forces scope to 'selected' because
  // per-date control only exists there (Happity: tick the dates under
  // "Selected events"). Returns the new boolean state for that date.
  // Defensive: refuses dates that aren't real camp dates.
  function toggleDate(ticket, iso) {
    if (!ticket || !isValidISODate(iso)) return false;
    if (ticket.dates.indexOf(iso) === -1) return false; // can't toggle a non-camp date

    if (ticket.scope !== SCOPE_SELECTED) {
      // Entering per-date mode: seed from the full date set, then toggle.
      ticket.scope = SCOPE_SELECTED;
      ticket.enabledDates = ticket.dates.slice();
    }
    var idx = ticket.enabledDates.indexOf(iso);
    if (idx === -1) {
      ticket.enabledDates.push(iso);
      ticket.enabledDates.sort();
      return true;  // now ON
    }
    ticket.enabledDates.splice(idx, 1);
    return false;   // now OFF
  }

  // Explicit setter (used by checkboxes): make a date ON or OFF.
  function setDateEnabled(ticket, iso, on) {
    if (!ticket || !isValidISODate(iso)) return false;
    var currentlyOn = isDateAvailable(ticket, iso) && ticket.scope === SCOPE_SELECTED
      ? ticket.enabledDates.indexOf(iso) !== -1
      : (ticket.scope === SCOPE_ALL ? true : ticket.enabledDates.indexOf(iso) !== -1);
    if (!!on === currentlyOn && ticket.scope === SCOPE_SELECTED) return !!on;
    if (ticket.scope !== SCOPE_SELECTED) {
      ticket.scope = SCOPE_SELECTED;
      ticket.enabledDates = ticket.dates.slice();
    }
    var idx = ticket.enabledDates.indexOf(iso);
    if (on && idx === -1 && ticket.dates.indexOf(iso) !== -1) {
      ticket.enabledDates.push(iso);
      ticket.enabledDates.sort();
    } else if (!on && idx !== -1) {
      ticket.enabledDates.splice(idx, 1);
    }
    return !!on;
  }

  function availableDates(ticket) {
    if (!ticket) return [];
    return ticket.dates.filter(function (d) { return isDateAvailable(ticket, d); });
  }

  /* ---- booking a single ticket (parent side of the transaction) ------ */

  // Book ONE date with a single ticket. A single ticket consumes exactly one
  // date (perPurchaseDates === 1). Returns { ok, booking? } or { ok:false, error }.
  function bookSingle(ticket, iso) {
    if (!ticket || ticket.type !== "single") {
      return { ok: false, error: "Not a single ticket." };
    }
    if (!isValidISODate(iso)) {
      return { ok: false, error: "Pick a valid date." };
    }
    if (ticket.dates.indexOf(iso) === -1) {
      return { ok: false, error: "That date isn't a running camp date." };
    }
    if (!isDateAvailable(ticket, iso)) {
      return { ok: false, error: "The drop-in ticket isn't available on " + dateLabel(iso) + "." };
    }
    return {
      ok: true,
      booking: {
        id: safeUid("bk"),
        ticketId: ticket.id,
        type: "single",
        dates: [iso],            // <-- exactly ONE date
        datesBooked: 1,
        price: ticket.price,
        createdAt: Date.now()
      }
    };
  }

  /* ===================================================================
     PERSISTENCE (HC.store only — never raw localStorage)
     Shape: { <providerId>: [ ...tickets ] }
     =================================================================== */

  function readAll() {
    try {
      var s = HC.store.get(STORE_KEY, {});
      return (s && typeof s === "object" && !Array.isArray(s)) ? s : {};
    } catch (e) { return {}; }
  }
  function writeAll(map) {
    try { return HC.store.set(STORE_KEY, (map && typeof map === "object") ? map : {}); }
    catch (e) { return false; }
  }
  function getTickets(providerId) {
    var all = readAll();
    var list = all[providerId];
    return Array.isArray(list) ? list : [];
  }
  function saveTicket(providerId, ticket) {
    var all = readAll();
    var list = Array.isArray(all[providerId]) ? all[providerId] : [];
    var replaced = false;
    for (var i = 0; i < list.length; i++) {
      if (list[i] && list[i].id === ticket.id) { list[i] = ticket; replaced = true; break; }
    }
    if (!replaced) list.push(ticket);
    all[providerId] = list;
    writeAll(all);
    return ticket;
  }

  /* ===================================================================
     DEMO DATA — derive camp dates from the live planner so the preview
     is framed for school-age summer holiday camps.
     =================================================================== */

  // Build a handful of consecutive weekday camp dates from a planner week.
  function demoCampDates() {
    try {
      var weeks = (HC.data.planner && HC.data.planner.weeks) || [];
      var wk = null;
      for (var i = 0; i < weeks.length; i++) {
        if (weeks[i] && isValidISODate(weeks[i].mon) && !weeks[i].stub) { wk = weeks[i]; break; }
      }
      if (!wk) throw new Error("no week");
      var p = wk.mon.split("-");
      var base = new Date(Date.UTC(Number(p[0]), Number(p[1]) - 1, Number(p[2])));
      var out = [];
      var n = Math.min(5, Math.max(1, Number(wk.days) || 5));
      for (var d = 0; d < n; d++) {
        var dt = new Date(base.getTime() + d * 86400000);
        out.push(
          dt.getUTCFullYear() + "-" +
          ("0" + (dt.getUTCMonth() + 1)).slice(-2) + "-" +
          ("0" + dt.getUTCDate()).slice(-2)
        );
      }
      return out;
    } catch (e) {
      // Fallback: a fixed summer week if planner data is unavailable.
      return ["2026-07-27", "2026-07-28", "2026-07-29", "2026-07-30", "2026-07-31"];
    }
  }

  function demoProviderId() {
    try {
      var ps = HC.data.providers || [];
      for (var i = 0; i < ps.length; i++) {
        if (ps[i] && ps[i].id) return ps[i].id;
      }
    } catch (e) { /* ignore */ }
    return "demo-camp";
  }

  /* ===================================================================
     RENDER (UI into mountEl)
     =================================================================== */

  function render(mountEl) {
    try {
      if (!mountEl) return;
      var providerId = demoProviderId();
      var campDates = demoCampDates();

      // Working ticket for the preview (kept in a closure, persisted on Save).
      var ticket = makeSingleTicket({
        name: "Drop-in day pass",
        price: 35,
        dates: campDates,
        scope: SCOPE_ALL
      });

      var bookingLog = [];

      mountEl.innerHTML = "";

      var wrap = HC.util.el("div", { style: "font-family:'Nunito Sans',system-ui,sans-serif;color:var(--text,#383838)" });

      wrap.appendChild(HC.util.el("p", { style: "font-size:14px;margin:0 0 12px" },
        "A <b>Single</b> ticket is a PAYG / drop-in day pass — it books <b>one date</b> per purchase. " +
        "Use <b>Customise</b> to switch from <i>All events</i> to <i>Selected events</i> and toggle the ticket " +
        "on or off for individual camp dates."));

      // Ticket summary row.
      var summary = HC.util.el("div", {
        style: "display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin:0 0 14px"
      });
      function renderSummary() {
        var avail = availableDates(ticket).length;
        summary.innerHTML =
          '<span class="hc-pill hc-pill-total" style="font-size:13px">' +
            escapeHtml(ticket.name) + " · " + HC.util.money(ticket.price) + "</span>" +
          '<span class="hc-pill hc-pill-total" style="font-size:13px;background:var(--pink-tint,#FCE8F0);color:#9a1f5e">' +
            "Books 1 date / purchase</span>" +
          '<span class="hc-pill hc-pill-total" style="font-size:13px">' +
            (ticket.scope === SCOPE_ALL ? "All events" : "Selected events") +
            " · " + avail + "/" + ticket.dates.length + " dates on</span>";
      }
      renderSummary();
      wrap.appendChild(summary);

      // Customise panel: scope radios + per-date checkboxes.
      var panel = HC.util.el("div", {
        style: "border:1.5px solid var(--line,#E6E6E6);border-radius:14px;padding:14px;margin:0 0 14px"
      });
      var headRow = HC.util.el("div", {
        style: "display:flex;align-items:center;justify-content:space-between;gap:10px;margin:0 0 10px"
      });
      headRow.appendChild(HC.util.el("strong", {
        style: "font-family:'Quicksand',system-ui,sans-serif;color:var(--purple,#603488)"
      }, "Customise — which dates is this drop-in valid on?"));
      panel.appendChild(headRow);

      var scopeRow = HC.util.el("div", { style: "display:flex;gap:16px;margin:0 0 12px;font-size:13.5px" });
      var rAll = radio("hc-single-scope", "All events", ticket.scope === SCOPE_ALL);
      var rSel = radio("hc-single-scope", "Selected events", ticket.scope === SCOPE_SELECTED);
      scopeRow.appendChild(rAll.label);
      scopeRow.appendChild(rSel.label);
      panel.appendChild(scopeRow);

      var dateList = HC.util.el("div", {
        style: "display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:8px"
      });
      panel.appendChild(dateList);

      function renderDates() {
        dateList.innerHTML = "";
        var disabledAll = ticket.scope === SCOPE_ALL;
        ticket.dates.forEach(function (iso) {
          var on = isDateAvailable(ticket, iso);
          var row = HC.util.el("label", {
            style: "display:flex;align-items:center;gap:8px;font-size:13px;padding:6px 8px;border-radius:8px;" +
              "background:" + (on ? "var(--purple-tint,#F0E8F4)" : "#f4f4f4") + ";" +
              (disabledAll ? "opacity:.65;cursor:not-allowed" : "cursor:pointer")
          });
          var cb = HC.util.el("input", { type: "checkbox" });
          cb.checked = on;
          cb.disabled = disabledAll;
          cb.addEventListener("change", function () {
            setDateEnabled(ticket, iso, cb.checked);
            renderSummary();
            renderDates();
          });
          row.appendChild(cb);
          row.appendChild(HC.util.el("span", null, escapeHtml(dateLabel(iso))));
          dateList.appendChild(row);
        });
      }
      renderDates();

      rAll.input.addEventListener("change", function () {
        if (rAll.input.checked) { setScope(ticket, SCOPE_ALL); renderSummary(); renderDates(); }
      });
      rSel.input.addEventListener("change", function () {
        if (rSel.input.checked) { setScope(ticket, SCOPE_SELECTED); renderSummary(); renderDates(); }
      });

      wrap.appendChild(panel);

      // Parent booking simulator: pick a date, try to book one drop-in.
      var book = HC.util.el("div", {
        style: "border:1.5px solid var(--line,#E6E6E6);border-radius:14px;padding:14px"
      });
      book.appendChild(HC.util.el("strong", {
        style: "font-family:'Quicksand',system-ui,sans-serif;color:var(--purple,#603488);display:block;margin:0 0 8px"
      }, "Try a drop-in booking"));

      var selRow = HC.util.el("div", { style: "display:flex;gap:8px;flex-wrap:wrap;align-items:center" });
      var sel = HC.util.el("select", {
        style: "padding:8px 10px;border-radius:8px;border:1.5px solid var(--line,#E6E6E6);font-size:13.5px"
      });
      ticket.dates.forEach(function (iso) {
        sel.appendChild(HC.util.el("option", { value: iso }, escapeHtml(dateLabel(iso))));
      });
      var btn = HC.util.el("button", { class: "hc-btn", type: "button" }, "Book drop-in");
      btn.addEventListener("click", function () {
        var res = bookSingle(ticket, sel.value);
        if (res.ok) {
          bookingLog.push("✓ Booked 1 date: " + dateLabel(res.booking.dates[0]));
          HC.util.toast("Drop-in booked for " + dateLabel(res.booking.dates[0]));
        } else {
          bookingLog.push("✗ " + res.error);
          HC.util.toast(res.error);
        }
        renderLog();
      });
      selRow.appendChild(sel);
      selRow.appendChild(btn);
      book.appendChild(selRow);

      var log = HC.util.el("ul", {
        style: "margin:10px 0 0;padding-left:18px;font-size:13px;color:var(--text,#383838);line-height:1.7"
      });
      function renderLog() {
        log.innerHTML = bookingLog.slice(-6).map(function (l) {
          return "<li>" + escapeHtml(l) + "</li>";
        }).join("") || '<li style="color:var(--muted,#808080)">No bookings yet.</li>';
      }
      renderLog();
      book.appendChild(log);
      wrap.appendChild(book);

      // Save (persist via HC.store).
      var saveRow = HC.util.el("div", { style: "margin-top:14px" });
      var saveBtn = HC.util.el("button", { class: "hc-btn hc-btn-ghost", type: "button" }, "Save ticket");
      saveBtn.addEventListener("click", function () {
        saveTicket(providerId, ticket);
        HC.util.toast("Single ticket saved (" + availableDates(ticket).length + " dates on)");
      });
      saveRow.appendChild(saveBtn);
      wrap.appendChild(saveRow);

      mountEl.appendChild(wrap);
    } catch (e) {
      try {
        mountEl.innerHTML = '<p style="color:#9a1f5e">Preview unavailable: ' +
          escapeHtml(e && e.message ? e.message : String(e)) + "</p>";
      } catch (_) { /* give up quietly */ }
    }
  }

  function radio(name, labelText, checked) {
    var input = HC.util.el("input", { type: "radio", name: name });
    if (checked) input.checked = true;
    var label = HC.util.el("label", {
      style: "display:flex;align-items:center;gap:6px;cursor:pointer"
    });
    label.appendChild(input);
    label.appendChild(HC.util.el("span", null, escapeHtml(labelText)));
    return { input: input, label: label };
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  /* ===================================================================
     SELF TEST — exercises the LOGIC and asserts the acceptance criterion:
     "A single ticket books one date and can be toggled per date via Customise."
     =================================================================== */

  function selfTest() {
    var pass = 0, fail = 0, log = [];
    function check(label, fn) {
      try { fn(); pass += 1; log.push("✓ " + label); }
      catch (e) { fail += 1; log.push("✗ " + label + " — " + (e && e.message ? e.message : String(e))); }
    }

    var DATES = ["2026-07-27", "2026-07-28", "2026-07-29", "2026-07-30", "2026-07-31"];

    // 1. A single ticket is PAYG/drop-in: one date per purchase.
    check("Single ticket books exactly ONE date per purchase", function () {
      var t = makeSingleTicket({ name: "Drop-in", price: 35, dates: DATES });
      HC.assert(t.type === "single", "type should be 'single'");
      HC.assert(t.perPurchaseDates === 1, "perPurchaseDates should be 1");
      var res = bookSingle(t, DATES[0]);
      HC.assert(res.ok, "booking should succeed: " + (res.error || ""));
      HC.assert(res.booking.dates.length === 1, "booking should hold exactly 1 date");
      HC.assert(res.booking.dates[0] === DATES[0], "booked date should match the chosen date");
      HC.assert(res.booking.datesBooked === 1, "datesBooked should be 1");
    });

    // 2. Default scope 'all' => available on every camp date.
    check("Default 'All events' makes the ticket available on every camp date", function () {
      var t = makeSingleTicket({ name: "Drop-in", price: 35, dates: DATES });
      HC.assert(t.scope === SCOPE_ALL, "default scope should be 'all'");
      for (var i = 0; i < DATES.length; i++) {
        HC.assert(isDateAvailable(t, DATES[i]), "every date should be available under 'all': " + DATES[i]);
        HC.assert(bookSingle(t, DATES[i]).ok, "should be bookable under 'all': " + DATES[i]);
      }
      HC.assert(availableDates(t).length === DATES.length, "all dates should be available");
    });

    // 3. ACCEPTANCE CORE: toggle a date OFF via Customise -> that date is no
    //    longer bookable, while other selected dates still are.
    check("Customise: toggling a date OFF makes only that date unbookable", function () {
      var t = makeSingleTicket({ name: "Drop-in", price: 35, dates: DATES });
      var off = DATES[2]; // 2026-07-29
      var nowState = toggleDate(t, off);
      HC.assert(nowState === false, "toggling once should turn the date OFF");
      HC.assert(t.scope === SCOPE_SELECTED, "toggling a date should switch scope to 'selected'");
      HC.assert(!isDateAvailable(t, off), "toggled-off date must be unavailable");
      var booked = bookSingle(t, off);
      HC.assert(!booked.ok, "booking the toggled-off date must be rejected");
      // Other dates remain bookable.
      for (var i = 0; i < DATES.length; i++) {
        if (DATES[i] === off) continue;
        HC.assert(isDateAvailable(t, DATES[i]), "other dates should still be available: " + DATES[i]);
        HC.assert(bookSingle(t, DATES[i]).ok, "other dates should still book: " + DATES[i]);
      }
    });

    // 4. Toggling the same date back ON restores bookability (per-date control).
    check("Customise: toggling the date back ON restores bookability", function () {
      var t = makeSingleTicket({ name: "Drop-in", price: 35, dates: DATES });
      var d = DATES[1];
      HC.assert(toggleDate(t, d) === false, "first toggle OFF");
      HC.assert(!bookSingle(t, d).ok, "should be unbookable while OFF");
      HC.assert(toggleDate(t, d) === true, "second toggle ON");
      HC.assert(isDateAvailable(t, d), "date should be available again");
      HC.assert(bookSingle(t, d).ok, "date should book again once ON");
    });

    // 5. 'Selected events' built directly from an enabledDates subset.
    check("'Selected events' honours an explicit enabledDates subset", function () {
      var only = [DATES[0], DATES[4]];
      var t = makeSingleTicket({
        name: "Trial drop-in", price: 0, dates: DATES,
        scope: SCOPE_SELECTED, enabledDates: only, trial: true
      });
      HC.assert(t.scope === SCOPE_SELECTED, "scope should be 'selected'");
      HC.assert(t.trial === true, "single ticket can be a trial ticket");
      HC.assert(availableDates(t).length === 2, "only two dates should be on");
      HC.assert(bookSingle(t, DATES[0]).ok, "enabled date should book");
      HC.assert(!bookSingle(t, DATES[1]).ok, "non-enabled date should not book");
      HC.assert(bookSingle(t, DATES[4]).ok, "second enabled date should book");
    });

    // 6. Switching scope back to 'All events' re-enables every date.
    check("Switching back to 'All events' re-enables every date", function () {
      var t = makeSingleTicket({ name: "Drop-in", price: 35, dates: DATES });
      toggleDate(t, DATES[0]); // OFF, scope -> selected
      HC.assert(!isDateAvailable(t, DATES[0]), "date is off after toggle");
      setScope(t, SCOPE_ALL);
      HC.assert(t.scope === SCOPE_ALL, "scope back to 'all'");
      HC.assert(availableDates(t).length === DATES.length, "all dates available again");
    });

    // 7. A non-camp date can never be booked or toggled.
    check("A date outside the camp schedule can never be booked or toggled", function () {
      var t = makeSingleTicket({ name: "Drop-in", price: 35, dates: DATES });
      var bogus = "2026-12-25";
      HC.assert(!isDateAvailable(t, bogus), "bogus date must be unavailable");
      HC.assert(!bookSingle(t, bogus).ok, "bogus date must not book");
      HC.assert(toggleDate(t, bogus) === false, "toggling a non-camp date is a no-op");
      HC.assert(t.dates.indexOf(bogus) === -1, "bogus date must not enter the schedule");
    });

    // 8. Invalid date strings are rejected defensively.
    check("Invalid/garbage dates are rejected", function () {
      var t = makeSingleTicket({ name: "Drop-in", price: 35, dates: DATES });
      ["", "2026-02-30", "not-a-date", "2026-13-01", null].forEach(function (bad) {
        HC.assert(!bookSingle(t, bad).ok, "should reject: " + bad);
        HC.assert(!isDateAvailable(t, bad), "should be unavailable: " + bad);
      });
    });

    // 9. Persistence round-trip via HC.store keeps the customise state.
    check("Persists and reloads with its customise (per-date) state intact", function () {
      var pid = "selftest-provider-" + safeUid("p");
      var t = makeSingleTicket({ name: "Drop-in", price: 35, dates: DATES });
      toggleDate(t, DATES[2]); // turn one date OFF
      saveTicket(pid, t);
      var loaded = getTickets(pid);
      HC.assert(loaded.length === 1, "one ticket should persist");
      var lt = loaded[0];
      HC.assert(lt.type === "single" && lt.perPurchaseDates === 1, "reloaded ticket still books one date");
      HC.assert(lt.scope === SCOPE_SELECTED, "reloaded scope preserved");
      HC.assert(!isDateAvailable(lt, DATES[2]), "reloaded ticket keeps the OFF date");
      HC.assert(isDateAvailable(lt, DATES[0]), "reloaded ticket keeps the ON dates");
      // cleanup
      try {
        var all = readAll();
        delete all[pid];
        writeAll(all);
      } catch (e) { /* ignore cleanup failure */ }
    });

    // 10. Demo data derives real summer camp dates (school-age framing).
    check("Demo camp dates are valid consecutive summer dates", function () {
      var dd = demoCampDates();
      HC.assert(dd.length >= 1, "should derive at least one demo date");
      for (var i = 0; i < dd.length; i++) {
        HC.assert(isValidISODate(dd[i]), "demo date should be valid ISO: " + dd[i]);
      }
    });

    return { pass: pass, fail: fail, log: log };
  }

  /* ===================================================================
     REGISTER
     =================================================================== */

  HC.registerFeature({
    id: "provider-ticket-single",
    title: "Single / PAYG / drop-in tickets",
    side: "provider",
    icon: "🎟️",
    summary: "Sell a drop-in day pass that books one date per purchase, and toggle it on or off per camp date via 'Customise' (All events vs Selected events).",
    render: render,
    selfTest: selfTest
  });
})();
