/* HolidayCamp feature — provider-activate-bookings
 *
 * Activate / deactivate Happity Bookings  (provider side)
 *
 * Replicates Happity's "switch bookings on and off" behaviour. Evidence:
 *   - support article 4414888 ("How to activate and deactivate bookings"):
 *       "Classes are only bookable if:
 *          - You've connected to Stripe and uploaded your T&Cs / Privacy Policy
 *          - Your classes have forthcoming event dates on them
 *          - The event has got spaces available
 *          - There are valid ticket types"
 *       "You can check the status of any of your classes in your timetable by
 *        looking at the 'book' icon. It will be RED if bookings are switched
 *        off, ORANGE if some of the classes are inactive / there's an issue,
 *        or GREEN if they are good to go."
 *       "On the right hand side is a section titled 'Bookings Enabled' …
 *        Choose 'No' and the book icon will change to red." (per series)
 *   - support article 4805620 ("Why must Happity Bookings be activated …"):
 *        bookings must be ON for online/searchable listings — i.e. switching
 *        bookings off has consequences for the listing.
 *
 * Framed for SCHOOL-AGE HOLIDAY CAMPS (not baby classes). A provider runs one
 * or more SERIES (recurring camp listings, e.g. "Multi-Activity Camp — Mon–Fri
 * 09:00–16:00, St Mary's Hall"). Bookings are toggled ON/OFF PER SERIES, but a
 * series can only be switched ON when the four readiness gates are all met.
 *
 * ACCEPTANCE CRITERION (asserted in selfTest):
 *   Bookings switch on (needs Stripe + dates + tickets + spaces) and off per
 *   series; a status icon reflects state.
 * We verify:
 *   - A series cannot be switched ON unless ALL of: Stripe connected (with
 *     T&Cs/Privacy), at least one forthcoming dated event, at least one event
 *     with spaces available, and at least one valid ticket type.
 *   - When the gates are met the provider can enable bookings, and can disable
 *     them again, PER SERIES (toggling one series does not affect another).
 *   - The status icon is RED when bookings are off, GREEN when enabled and
 *     everything is good to go, and ORANGE when enabled-but-something-is-wrong
 *     (e.g. enabled then it sold out / dates passed) — exactly the red/orange/
 *     green book-icon semantics from article 4414888.
 *
 * Self-contained, defensive, no imports/exports. Calls HC.registerFeature.
 */
(function () {
  "use strict";

  // Defensive: never throw at module load if HC isn't present.
  if (typeof window === "undefined" || !window.HC || typeof window.HC.registerFeature !== "function") {
    if (typeof console !== "undefined" && console.warn) {
      console.warn("[HC] provider-activate-bookings: HC core not found; skipping registration.");
    }
    return;
  }

  var HC = window.HC;

  // Persisted shape: { account:{...stripe...}, series:{ <seriesId>:{...} } }
  var STORE_KEY = "provider_activate_bookings";

  /* ===================================================================
     PURE LOGIC (testable, DOM-free)
     =================================================================== */

  function asText(v) {
    return typeof v === "string" ? v : (v == null ? "" : String(v));
  }
  function toInt(v) {
    var n = Number(v);
    if (!isFinite(n)) return 0;
    return Math.floor(n);
  }

  // Strict YYYY-MM-DD validation that also rejects impossible calendar dates.
  function isValidISODate(s) {
    var str = asText(s);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(str)) return false;
    var p = str.split("-");
    var y = Number(p[0]), m = Number(p[1]), d = Number(p[2]);
    if (m < 1 || m > 12 || d < 1 || d > 31) return false;
    var dt = new Date(Date.UTC(y, m - 1, d));
    return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
  }

  // "Today" as an ISO string. A fixed reference can be passed in for
  // deterministic tests; otherwise we use the real clock.
  function todayISO(refISO) {
    if (isValidISODate(refISO)) return refISO;
    try {
      var d = new Date();
      var m = String(d.getMonth() + 1).padStart(2, "0");
      var day = String(d.getDate()).padStart(2, "0");
      return d.getFullYear() + "-" + m + "-" + day;
    } catch (e) {
      return "1970-01-01";
    }
  }

  var DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  var MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  function dateLabel(iso) {
    try {
      if (!isValidISODate(iso)) return asText(iso);
      var p = iso.split("-");
      var dt = new Date(Date.UTC(Number(p[0]), Number(p[1]) - 1, Number(p[2])));
      return DOW[dt.getUTCDay()] + " " + Number(p[2]) + " " + MON[Number(p[1]) - 1] + " " + p[0];
    } catch (e) { return asText(iso); }
  }

  /* ---- Account / Stripe readiness (article 4414888 gate #1) ---- */
  // A series can only be made bookable once the ACCOUNT is payment-ready:
  // connected to Stripe AND has uploaded T&Cs + Privacy Policy.
  function isStripeReady(account) {
    var a = (account && typeof account === "object") ? account : {};
    return a.stripeConnected === true && a.termsUploaded === true && a.privacyUploaded === true;
  }

  /* ---- Per-series readiness gates (article 4414888) ---- */

  // A forthcoming event is a dated instance whose date is today or later.
  function isForthcoming(ev, refISO) {
    if (!ev || !isValidISODate(ev.date)) return false;
    return ev.date >= todayISO(refISO);
  }
  // Spaces available on an event = capacity minus booked > 0.
  function eventSpaces(ev) {
    if (!ev) return 0;
    var cap = toInt(ev.capacity);
    var booked = toInt(ev.booked);
    return cap - booked;
  }
  function eventHasSpaces(ev) {
    return eventSpaces(ev) > 0;
  }
  // A ticket type is valid if it has a non-empty name and a numeric price >= 0.
  function isValidTicket(t) {
    if (!t || typeof t !== "object") return false;
    if (!asText(t.name).trim()) return false;
    var p = Number(t.price);
    return isFinite(p) && p >= 0;
  }

  // The four readiness gates, computed for a single series against the account.
  // Returns a structured object so the UI can show exactly what's missing —
  // mirroring the bulleted checklist in article 4414888.
  function readiness(account, series, refISO) {
    var s = (series && typeof series === "object") ? series : {};
    var events = Array.isArray(s.events) ? s.events : [];
    var tickets = Array.isArray(s.tickets) ? s.tickets : [];

    var forthcoming = events.filter(function (e) { return isForthcoming(e, refISO); });
    var withSpaces = forthcoming.filter(eventHasSpaces);
    var validTickets = tickets.filter(isValidTicket);

    var gates = {
      stripe: isStripeReady(account),                 // gate 1
      dates: forthcoming.length > 0,                  // gate 2
      spaces: withSpaces.length > 0,                  // gate 3
      tickets: validTickets.length > 0                // gate 4
    };
    var missing = [];
    if (!gates.stripe) missing.push("Connect Stripe and upload your T&Cs / Privacy Policy");
    if (!gates.dates) missing.push("Add at least one forthcoming camp date");
    if (!gates.spaces) missing.push("Make sure a forthcoming date still has spaces");
    if (!gates.tickets) missing.push("Add at least one valid ticket type");

    return {
      gates: gates,
      ready: gates.stripe && gates.dates && gates.spaces && gates.tickets,
      forthcomingCount: forthcoming.length,
      spacesCount: withSpaces.length,
      validTicketCount: validTickets.length,
      missing: missing
    };
  }

  /* ---- Status icon (article 4414888): red / orange / green ---- */
  // RED    = bookings switched off for this series.
  // GREEN  = bookings on AND all readiness gates currently pass (good to go).
  // ORANGE = bookings on BUT something is now wrong / inactive (e.g. it sold
  //          out, or the dates have passed since you switched it on).
  var STATUS = {
    RED: { key: "red", icon: "🔴", label: "Off", desc: "Bookings are switched off" },
    ORANGE: { key: "orange", icon: "🟠", label: "Issue", desc: "Bookings are on but something needs attention" },
    GREEN: { key: "green", icon: "🟢", label: "Good to go", desc: "Bookings are on and all set" }
  };

  function statusFor(account, series, refISO) {
    var s = (series && typeof series === "object") ? series : {};
    if (s.bookingsEnabled !== true) return STATUS.RED;
    var r = readiness(account, s, refISO);
    return r.ready ? STATUS.GREEN : STATUS.ORANGE;
  }

  /* ---- The on/off transition (article 4414888 'Bookings Enabled' Yes/No) ----
     Switching ON is GATED: you cannot enable a series whose readiness fails.
     Switching OFF is always allowed (sold out / taking a series down). */
  function setBookingsEnabled(account, series, enabled, refISO) {
    var s = (series && typeof series === "object") ? series : {};
    if (enabled) {
      var r = readiness(account, s, refISO);
      if (!r.ready) {
        return { ok: false, series: s, reason: "not_ready", missing: r.missing };
      }
      s.bookingsEnabled = true;
      return { ok: true, series: s, status: statusFor(account, s, refISO) };
    }
    // turning OFF — always permitted
    s.bookingsEnabled = false;
    return { ok: true, series: s, status: statusFor(account, s, refISO) };
  }

  function safeUid(prefix) {
    try { return HC.util.uid(); }
    catch (e) { return (prefix || "id") + "_" + Date.now() + "_" + Math.floor(Math.random() * 1e6); }
  }

  /* ===================================================================
     PERSISTENCE (HC.store only — never raw localStorage)
     Shape:
       { <providerId>: { account:{...}, series:{ <seriesId>:{...} } } }
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

  function defaultAccount() {
    return { stripeConnected: false, termsUploaded: false, privacyUploaded: false };
  }

  function providerBucket(map, providerId) {
    var pid = asText(providerId) || "_default";
    if (!map[pid] || typeof map[pid] !== "object") {
      map[pid] = { account: defaultAccount(), series: {} };
    }
    if (!map[pid].account || typeof map[pid].account !== "object") map[pid].account = defaultAccount();
    if (!map[pid].series || typeof map[pid].series !== "object") map[pid].series = {};
    return map[pid];
  }

  function getAccount(providerId) {
    return providerBucket(readAll(), providerId).account;
  }
  function setAccount(providerId, patch) {
    var map = readAll();
    var b = providerBucket(map, providerId);
    var p = (patch && typeof patch === "object") ? patch : {};
    if (typeof p.stripeConnected === "boolean") b.account.stripeConnected = p.stripeConnected;
    if (typeof p.termsUploaded === "boolean") b.account.termsUploaded = p.termsUploaded;
    if (typeof p.privacyUploaded === "boolean") b.account.privacyUploaded = p.privacyUploaded;
    writeAll(map);
    return b.account;
  }

  // Normalise a series record so downstream logic always sees the right shape.
  function normaliseSeries(input) {
    var a = (input && typeof input === "object") ? input : {};
    return {
      id: asText(a.id) || safeUid("series"),
      title: asText(a.title) || "Untitled camp series",
      venue: asText(a.venue) || "",
      pattern: asText(a.pattern) || "",         // e.g. "Mon–Fri 09:00–16:00"
      bookingsEnabled: a.bookingsEnabled === true,
      events: Array.isArray(a.events) ? a.events.map(normaliseEvent) : [],
      tickets: Array.isArray(a.tickets) ? a.tickets.map(normaliseTicket) : []
    };
  }
  function normaliseEvent(e) {
    var a = (e && typeof e === "object") ? e : {};
    return {
      id: asText(a.id) || safeUid("evt"),
      date: asText(a.date),
      capacity: toInt(a.capacity),
      booked: toInt(a.booked)
    };
  }
  function normaliseTicket(t) {
    var a = (t && typeof t === "object") ? t : {};
    return {
      id: asText(a.id) || safeUid("tkt"),
      name: asText(a.name),
      price: (function () { var p = Number(a.price); return isFinite(p) ? p : NaN; })()
    };
  }

  function upsertSeries(providerId, input) {
    var map = readAll();
    var b = providerBucket(map, providerId);
    var series = normaliseSeries(input);
    b.series[series.id] = series;
    writeAll(map);
    return series;
  }

  function getSeries(providerId, seriesId) {
    var b = providerBucket(readAll(), providerId);
    var s = b.series[asText(seriesId)];
    return s ? normaliseSeries(s) : null;
  }
  function getAllSeries(providerId) {
    var b = providerBucket(readAll(), providerId);
    return Object.keys(b.series).map(function (k) { return normaliseSeries(b.series[k]); });
  }

  // Persisted version of the gated toggle: mutate the stored series and save.
  function toggleSeries(providerId, seriesId, enabled, refISO) {
    var map = readAll();
    var b = providerBucket(map, providerId);
    var raw = b.series[asText(seriesId)];
    if (!raw) return { ok: false, reason: "no_such_series" };
    var series = normaliseSeries(raw);
    var res = setBookingsEnabled(b.account, series, enabled, refISO);
    if (res.ok) {
      b.series[series.id] = series;
      writeAll(map);
    }
    return res;
  }

  function clearProvider(providerId) {
    var map = readAll();
    delete map[asText(providerId) || "_default"];
    writeAll(map);
  }

  /* ===================================================================
     DEMO SEEDING (uses live data where available)
     =================================================================== */

  function demoProviderId() {
    try {
      var ps = HC.data.providers;
      if (ps && ps.length && ps[0] && ps[0].id) return "activate_demo__" + ps[0].id;
    } catch (e) {}
    return "activate_demo__provider";
  }

  // A near-future date derived from the live planner if possible.
  function soonISO() {
    try {
      var kd = HC.data.planner.keyDates || {};
      if (kd.holidayStart && isValidISODate(kd.holidayStart.iso)) return kd.holidayStart.iso;
      if (kd.bankHoliday && isValidISODate(kd.bankHoliday.iso)) return kd.bankHoliday.iso;
    } catch (e) {}
    // far-future fallback so the demo always has a "forthcoming" date
    return "2099-07-21";
  }

  function seedDemo(providerId) {
    // Account not yet payment-ready, so the provider must complete setup first.
    setAccount(providerId, { stripeConnected: false, termsUploaded: false, privacyUploaded: false });
    upsertSeries(providerId, {
      id: "series-multi-activity",
      title: "Multi-Activity Summer Camp",
      venue: "St Mary's Hall, Walthamstow",
      pattern: "Mon–Fri · 09:00–16:00",
      bookingsEnabled: false,
      events: [
        { id: "ev1", date: soonISO(), capacity: 24, booked: 10 }
      ],
      tickets: [
        { id: "t-full", name: "Full day", price: 35 },
        { id: "t-half", name: "Half day", price: 20 }
      ]
    });
    upsertSeries(providerId, {
      id: "series-forest",
      title: "Forest School Adventure Week",
      venue: "Epping Forest edge",
      pattern: "Tue–Thu · 10:00–15:00",
      bookingsEnabled: false,
      events: [
        { id: "ev2", date: soonISO(), capacity: 16, booked: 16 } // SOLD OUT — no spaces
      ],
      tickets: [
        { id: "t-day", name: "Day place", price: 30 }
      ]
    });
  }

  /* ===================================================================
     UI
     =================================================================== */

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
  function escAttr(s) { return esc(s).replace(/"/g, "&quot;"); }

  function el(tag, attrs, html) {
    try { return HC.util.el(tag, attrs, html); }
    catch (e) {
      var n = document.createElement(tag || "div");
      if (html != null) n.innerHTML = html;
      return n;
    }
  }

  function gateRow(ok, label) {
    return '<li style="list-style:none;margin:0 0 4px;font-size:13px;color:' +
      (ok ? "#2f7d4f" : "#9a1f5e") + '">' + (ok ? "✓ " : "✗ ") + esc(label) + "</li>";
  }

  function accountPanelHtml(providerId) {
    var a = getAccount(providerId);
    var ready = isStripeReady(a);
    return '' +
      '<div style="border:1.5px solid var(--line,#E6E6E6);border-radius:14px;padding:12px 14px;background:#F7F4FB;margin:0 0 14px">' +
        '<div style="font-family:Quicksand,system-ui,sans-serif;font-weight:700;color:var(--purple,#603488)">Payment setup ' +
          (ready ? "🟢 ready" : "🔴 incomplete") + "</div>" +
        '<p style="font-size:12.5px;color:var(--muted,#808080);margin:4px 0 8px">' +
          "Bookings can only be switched on once Stripe is connected and your T&amp;Cs + Privacy Policy are uploaded.</p>" +
        '<label style="display:block;font-size:13px;margin:0 0 4px"><input type="checkbox" id="abStripe"' +
          (a.stripeConnected ? " checked" : "") + "> Stripe connected</label>" +
        '<label style="display:block;font-size:13px;margin:0 0 4px"><input type="checkbox" id="abTerms"' +
          (a.termsUploaded ? " checked" : "") + "> T&amp;Cs uploaded</label>" +
        '<label style="display:block;font-size:13px;margin:0 0 0"><input type="checkbox" id="abPrivacy"' +
          (a.privacyUploaded ? " checked" : "") + "> Privacy Policy uploaded</label>" +
      "</div>";
  }

  function seriesCardHtml(providerId, series) {
    var account = getAccount(providerId);
    var st = statusFor(account, series);
    var r = readiness(account, series);
    var enabled = series.bookingsEnabled === true;

    var gates =
      gateRow(r.gates.stripe, "Stripe + T&Cs / Privacy") +
      gateRow(r.gates.dates, "Forthcoming camp date" + (r.forthcomingCount ? " (" + r.forthcomingCount + ")" : "")) +
      gateRow(r.gates.spaces, "Spaces available" + (r.spacesCount ? " (" + r.spacesCount + " date" + (r.spacesCount === 1 ? "" : "s") + ")" : "")) +
      gateRow(r.gates.tickets, "Valid ticket types" + (r.validTicketCount ? " (" + r.validTicketCount + ")" : ""));

    var toggleLabel = enabled ? "Switch bookings OFF" : "Switch bookings ON";
    var toggleDisabled = (!enabled && !r.ready);

    return '' +
      '<div class="hc-fcard" data-series="' + escAttr(series.id) + '" style="gap:6px">' +
        '<div style="display:flex;align-items:center;gap:8px">' +
          '<span style="font-size:22px" title="' + escAttr(st.desc) + '">' + st.icon + "</span>" +
          "<div>" +
            '<div style="font-family:Quicksand,system-ui,sans-serif;font-weight:700;color:var(--purple,#603488);font-size:16px">' +
              esc(series.title) + "</div>" +
            '<div style="font-size:12px;color:var(--muted,#808080)">' +
              esc(series.pattern || "") + (series.venue ? " · " + esc(series.venue) : "") + "</div>" +
          "</div>" +
        "</div>" +
        '<div style="display:flex;align-items:center;gap:6px;margin:2px 0">' +
          '<span style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.3px;padding:2px 8px;border-radius:999px;background:' +
            (st.key === "green" ? "#E1F0E4;color:#2f7d4f" : st.key === "orange" ? "#FCEFD9;color:#9a5a1f" : "#FCE8F0;color:#9a1f5e") +
            '" data-status="' + escAttr(st.key) + '">' + st.icon + " " + esc(st.label) + "</span>" +
          '<span style="font-size:11.5px;color:var(--muted,#808080)">Bookings Enabled: ' + (enabled ? "Yes" : "No") + "</span>" +
        "</div>" +
        '<ul style="margin:4px 0 6px;padding:0">' + gates + "</ul>" +
        '<button class="hc-btn' + (toggleDisabled ? " hc-btn-ghost" : "") + '" type="button" data-toggle="' +
          escAttr(series.id) + '"' + (toggleDisabled ? " disabled style=\"opacity:.5;cursor:not-allowed\"" : "") + ">" +
          esc(toggleLabel) + "</button>" +
        (toggleDisabled
          ? '<div style="font-size:11.5px;color:#9a1f5e;margin-top:4px">' + esc(r.missing.join("; ")) + "</div>"
          : "") +
      "</div>";
  }

  function render(mountEl) {
    try {
      if (!mountEl) return;
      var providerId = demoProviderId();
      clearProvider(providerId);
      seedDemo(providerId);
      mountEl.innerHTML = "";

      var intro = el("div", null,
        '<p style="font-size:14px;color:var(--text,#383838);margin:0 0 4px">' +
          "Switch Happity-style bookings <strong>on and off per camp series</strong>. A series is only " +
          "<em>bookable</em> once you've connected Stripe (with T&amp;Cs + Privacy), have a forthcoming camp " +
          "date with spaces, and at least one valid ticket type.</p>" +
        '<p style="font-size:12.5px;color:var(--muted,#808080);margin:0 0 10px">' +
          "The book icon is 🔴 red when bookings are off, 🟠 orange when something needs attention, " +
          "and 🟢 green when you're good to go.</p>");
      mountEl.appendChild(intro);

      var accountHost = el("div", { id: "abAccountHost" }, accountPanelHtml(providerId));
      mountEl.appendChild(accountHost);

      var listHost = el("div", { id: "abListHost", class: "hc-cards" });
      mountEl.appendChild(listHost);

      function refresh() {
        accountHost.innerHTML = accountPanelHtml(providerId);
        var series = getAllSeries(providerId);
        listHost.innerHTML = series.map(function (s) { return seriesCardHtml(providerId, s); }).join("");
      }
      refresh();

      // Account checkboxes (delegated within the account host).
      accountHost.addEventListener("change", function (e) {
        var t = e.target;
        if (!t || t.type !== "checkbox") return;
        var patch = {};
        if (t.id === "abStripe") patch.stripeConnected = t.checked;
        else if (t.id === "abTerms") patch.termsUploaded = t.checked;
        else if (t.id === "abPrivacy") patch.privacyUploaded = t.checked;
        else return;
        setAccount(providerId, patch);
        refresh();
      });

      // Toggle buttons (delegated within the list host).
      listHost.addEventListener("click", function (e) {
        var btn = e.target && e.target.closest ? e.target.closest("[data-toggle]") : null;
        if (!btn || btn.disabled) return;
        var sid = btn.getAttribute("data-toggle");
        var current = getSeries(providerId, sid);
        if (!current) return;
        var res = toggleSeries(providerId, sid, !current.bookingsEnabled);
        if (!res.ok) {
          try { HC.util.toast("Can't switch on yet: " + (res.missing || []).join("; ")); } catch (er) {}
        } else {
          var nowOn = res.series.bookingsEnabled;
          try { HC.util.toast("Bookings " + (nowOn ? "switched ON" : "switched OFF") + " for this series"); } catch (er) {}
        }
        refresh();
      });
    } catch (e) {
      try {
        mountEl.innerHTML = '<p style="color:#9a1f5e">Activate-bookings feature failed to render: ' +
          esc(e && e.message ? e.message : String(e)) + "</p>";
      } catch (e2) { /* give up quietly */ }
    }
  }

  /* ===================================================================
     selfTest — exercises the LOGIC and asserts the acceptance criterion
     =================================================================== */

  function selfTest() {
    var pass = 0, fail = 0, log = [];
    function check(label, fn) {
      try { fn(); pass += 1; log.push("✓ " + label); }
      catch (e) { fail += 1; log.push("✗ " + label + " — " + (e && e.message ? e.message : String(e))); }
    }

    var REF = "2026-07-01";           // fixed "today" so date gates are deterministic
    var FUTURE = "2026-08-10";        // forthcoming relative to REF
    var PAST = "2026-06-01";          // already gone relative to REF

    function readyAccount() {
      return { stripeConnected: true, termsUploaded: true, privacyUploaded: true };
    }
    function fullSeries(overrides) {
      var base = {
        id: "s1",
        title: "Multi-Activity Camp",
        bookingsEnabled: false,
        events: [{ id: "e1", date: FUTURE, capacity: 24, booked: 10 }],
        tickets: [{ id: "t1", name: "Full day", price: 35 }]
      };
      if (overrides) for (var k in overrides) if (Object.prototype.hasOwnProperty.call(overrides, k)) base[k] = overrides[k];
      return normaliseSeries(base);
    }

    /* ===== ACCEPTANCE CRITERION part A — the four gates block switch-on ===== */

    check("A fully-ready series passes all four readiness gates", function () {
      var r = readiness(readyAccount(), fullSeries(), REF);
      HC.assert(r.gates.stripe === true, "Stripe gate should pass");
      HC.assert(r.gates.dates === true, "dates gate should pass");
      HC.assert(r.gates.spaces === true, "spaces gate should pass");
      HC.assert(r.gates.tickets === true, "tickets gate should pass");
      HC.assert(r.ready === true, "series should be ready overall");
      HC.assert(r.missing.length === 0, "no missing items when ready");
    });

    check("Gate 1: no Stripe / T&Cs blocks switch-on", function () {
      var acct = { stripeConnected: false, termsUploaded: false, privacyUploaded: false };
      var s = fullSeries();
      var r = readiness(acct, s, REF);
      HC.assert(r.gates.stripe === false, "Stripe gate must fail without connection/T&Cs");
      HC.assert(r.ready === false, "series must not be ready without Stripe");
      var res = setBookingsEnabled(acct, s, true, REF);
      HC.assert(res.ok === false, "must NOT switch on without Stripe");
      HC.assert(s.bookingsEnabled !== true, "series must stay off");
      HC.assert(/stripe/i.test(res.missing.join(" ")), "reason should mention Stripe");
    });

    check("Gate 1b: Stripe connected but T&Cs/Privacy missing still blocks", function () {
      var acct = { stripeConnected: true, termsUploaded: false, privacyUploaded: true };
      HC.assert(isStripeReady(acct) === false, "missing T&Cs must fail the Stripe gate");
      var acct2 = { stripeConnected: true, termsUploaded: true, privacyUploaded: false };
      HC.assert(isStripeReady(acct2) === false, "missing Privacy must fail the Stripe gate");
    });

    check("Gate 2: no forthcoming dates blocks switch-on", function () {
      var s = fullSeries({ events: [{ id: "e1", date: PAST, capacity: 24, booked: 0 }] });
      var r = readiness(readyAccount(), s, REF);
      HC.assert(r.gates.dates === false, "a past-only series has no forthcoming dates");
      var res = setBookingsEnabled(readyAccount(), s, true, REF);
      HC.assert(res.ok === false, "must NOT switch on without forthcoming dates");
    });

    check("Gate 3: sold-out (no spaces) blocks switch-on", function () {
      var s = fullSeries({ events: [{ id: "e1", date: FUTURE, capacity: 16, booked: 16 }] });
      var r = readiness(readyAccount(), s, REF);
      HC.assert(r.gates.dates === true, "the date is forthcoming");
      HC.assert(r.gates.spaces === false, "no spaces when fully booked");
      var res = setBookingsEnabled(readyAccount(), s, true, REF);
      HC.assert(res.ok === false, "must NOT switch on when sold out");
    });

    check("Gate 4: no valid ticket types blocks switch-on", function () {
      var s1 = fullSeries({ tickets: [] });
      HC.assert(readiness(readyAccount(), s1, REF).gates.tickets === false, "no tickets fails the gate");
      var s2 = fullSeries({ tickets: [{ name: "", price: 10 }] });
      HC.assert(readiness(readyAccount(), s2, REF).gates.tickets === false, "a nameless ticket is invalid");
      var s3 = fullSeries({ tickets: [{ name: "Day", price: "free" }] });
      HC.assert(readiness(readyAccount(), s3, REF).gates.tickets === false, "a non-numeric price is invalid");
      var s4 = fullSeries({ tickets: [{ name: "Free taster", price: 0 }] });
      HC.assert(readiness(readyAccount(), s4, REF).gates.tickets === true, "a £0 named ticket IS valid");
      var res = setBookingsEnabled(readyAccount(), s1, true, REF);
      HC.assert(res.ok === false, "must NOT switch on without a valid ticket");
    });

    /* ===== ACCEPTANCE CRITERION part B — switch on, then off, per series ===== */

    check("A ready series switches ON, then OFF", function () {
      var acct = readyAccount();
      var s = fullSeries();
      var on = setBookingsEnabled(acct, s, true, REF);
      HC.assert(on.ok === true, "ready series should switch on");
      HC.assert(s.bookingsEnabled === true, "series should now be enabled");
      var off = setBookingsEnabled(acct, s, false, REF);
      HC.assert(off.ok === true, "switching off is always allowed");
      HC.assert(s.bookingsEnabled === false, "series should now be disabled");
    });

    check("Switching OFF is allowed even when readiness has since broken", function () {
      // enabled series that has since sold out — provider must still be able to turn it off
      var acct = readyAccount();
      var s = fullSeries({ bookingsEnabled: true, events: [{ id: "e1", date: FUTURE, capacity: 10, booked: 10 }] });
      var off = setBookingsEnabled(acct, s, false, REF);
      HC.assert(off.ok === true, "must always be able to switch off");
      HC.assert(s.bookingsEnabled === false, "series is now off");
    });

    /* ===== Per-series isolation (persisted) ===== */

    var TP = "__selftest_activate__";
    clearProvider(TP);

    check("Toggling one series does not affect another (per series)", function () {
      setAccount(TP, readyAccount());
      upsertSeries(TP, {
        id: "A", title: "Camp A", bookingsEnabled: false,
        events: [{ id: "a1", date: "2099-08-01", capacity: 20, booked: 5 }],
        tickets: [{ id: "ta", name: "Day", price: 30 }]
      });
      upsertSeries(TP, {
        id: "B", title: "Camp B", bookingsEnabled: false,
        events: [{ id: "b1", date: "2099-08-01", capacity: 20, booked: 5 }],
        tickets: [{ id: "tb", name: "Day", price: 30 }]
      });
      var resA = toggleSeries(TP, "A", true);
      HC.assert(resA.ok === true, "Camp A should switch on");
      HC.assert(getSeries(TP, "A").bookingsEnabled === true, "A persisted as on");
      HC.assert(getSeries(TP, "B").bookingsEnabled === false, "B must stay off — toggling is per series");
      // now turn A off, B on, and confirm independence again
      toggleSeries(TP, "A", false);
      toggleSeries(TP, "B", true);
      HC.assert(getSeries(TP, "A").bookingsEnabled === false, "A back off");
      HC.assert(getSeries(TP, "B").bookingsEnabled === true, "B independently on");
    });

    check("Gated switch-on is enforced through the persisted path too", function () {
      // a sold-out series stored for the provider must refuse to switch on
      upsertSeries(TP, {
        id: "C", title: "Camp C (sold out)", bookingsEnabled: false,
        events: [{ id: "c1", date: "2099-08-01", capacity: 12, booked: 12 }],
        tickets: [{ id: "tc", name: "Day", price: 30 }]
      });
      var res = toggleSeries(TP, "C", true);
      HC.assert(res.ok === false, "persisted toggle must refuse a sold-out series");
      HC.assert(getSeries(TP, "C").bookingsEnabled === false, "C must remain off in the store");
    });

    /* ===== ACCEPTANCE CRITERION part C — status icon reflects state ===== */

    check("Status icon is RED when bookings are off", function () {
      var st = statusFor(readyAccount(), fullSeries({ bookingsEnabled: false }), REF);
      HC.assert(st.key === "red", "off series must be red, got " + st.key);
      HC.assert(st.icon === "🔴", "red icon expected");
    });

    check("Status icon is GREEN when on and all good to go", function () {
      var st = statusFor(readyAccount(), fullSeries({ bookingsEnabled: true }), REF);
      HC.assert(st.key === "green", "ready+enabled series must be green, got " + st.key);
      HC.assert(st.icon === "🟢", "green icon expected");
    });

    check("Status icon is ORANGE when on but something is now wrong", function () {
      // enabled, but it has since SOLD OUT -> there's an issue
      var soldOut = fullSeries({ bookingsEnabled: true, events: [{ id: "e1", date: FUTURE, capacity: 8, booked: 8 }] });
      var st1 = statusFor(readyAccount(), soldOut, REF);
      HC.assert(st1.key === "orange", "enabled-but-sold-out must be orange, got " + st1.key);
      // enabled, but the only date has now PASSED -> there's an issue
      var passed = fullSeries({ bookingsEnabled: true, events: [{ id: "e1", date: PAST, capacity: 20, booked: 0 }] });
      var st2 = statusFor(readyAccount(), passed, REF);
      HC.assert(st2.key === "orange", "enabled-but-dates-passed must be orange, got " + st2.key);
      // enabled, but Stripe got disconnected -> there's an issue
      var noStripe = fullSeries({ bookingsEnabled: true });
      var st3 = statusFor({ stripeConnected: false, termsUploaded: false, privacyUploaded: false }, noStripe, REF);
      HC.assert(st3.key === "orange", "enabled-but-no-Stripe must be orange, got " + st3.key);
    });

    check("The status icon tracks a full on/off lifecycle", function () {
      var acct = readyAccount();
      var s = fullSeries();
      HC.assert(statusFor(acct, s, REF).key === "red", "starts red (off)");
      setBookingsEnabled(acct, s, true, REF);
      HC.assert(statusFor(acct, s, REF).key === "green", "green once switched on and ready");
      // simulate the series selling out while live
      s.events[0].booked = s.events[0].capacity;
      HC.assert(statusFor(acct, s, REF).key === "orange", "orange after it sells out");
      setBookingsEnabled(acct, s, false, REF);
      HC.assert(statusFor(acct, s, REF).key === "red", "red again after switching off");
    });

    /* ===== Defensive: garbage never throws ===== */

    check("Garbage inputs are handled without throwing", function () {
      var bad = [null, undefined, 42, "", [], {}, { events: "x", tickets: 7 }];
      for (var i = 0; i < bad.length; i++) {
        var r = readiness(bad[i], bad[i], REF);
        HC.assert(r && r.ready === false, "garbage #" + i + " must be not-ready");
        var st = statusFor(bad[i], bad[i], REF);
        HC.assert(st && st.key === "red", "garbage #" + i + " status must default to red/off");
        var res = setBookingsEnabled(bad[i], bad[i], true, REF);
        HC.assert(res && res.ok === false, "garbage #" + i + " must refuse switch-on");
      }
    });

    // cleanup so repeated runs stay stable
    clearProvider(TP);

    return { pass: pass, fail: fail, log: log };
  }

  /* ===================================================================
     register
     =================================================================== */

  HC.registerFeature({
    id: "provider-activate-bookings",
    title: "Activate / deactivate bookings",
    side: "provider",
    icon: "🔖",
    summary: "Switch Happity-style bookings on and off per camp series. A series only becomes bookable once Stripe (+ T&Cs/Privacy), a forthcoming date, spaces and a valid ticket type are all in place — and a red/orange/green book icon reflects the live state.",
    render: render,
    selfTest: selfTest
  });
})();
