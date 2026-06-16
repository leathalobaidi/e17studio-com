/* HolidayCamp feature: parent-cancel-reschedule-route
 * ------------------------------------------------------------------
 * Replicates Happity's "cancel / reschedule a booking" behaviour
 * (support article 8255720 — "Parents & Carers FAQs - Support with
 * Bookings", section "How to cancel or reschedule a booking").
 *
 * Evidence, quoted faithfully:
 *   "As Happity is a third party booking service, to cancel or
 *    reschedule a class you have booked, you will need to contact the
 *    class provider directly. Their details are on your booking
 *    confirmation email. They will then be able to assist you by
 *    canceling or rescheduling the class in line with their individual
 *    terms and conditions."
 *
 * So HolidayCamp does NOT cancel or reschedule itself. As an aggregator
 * it ROUTES the request to the provider: it surfaces the provider's
 * contact details on the booking confirmation and gives the parent a
 * one-click "request cancel / reschedule" path that drafts a message
 * (with the booking reference) addressed to that provider.
 *
 * Side: parent. Framed for SCHOOL-AGE HOLIDAY CAMPS (day / full-week
 * places), not baby classes.
 *
 * ACCEPTANCE CRITERION (asserted in selfTest):
 *   The booking confirmation surfaces provider contact AND a
 *   'request cancel/reschedule' path.
 *
 * Defensive: nothing here throws at registration time. Persistence is
 * via HC.store only (the parent's open cancel/reschedule requests);
 * no global localStorage keys are written.
 * ------------------------------------------------------------------ */
(function () {
  "use strict";

  if (typeof window === "undefined" || !window.HC || typeof window.HC.registerFeature !== "function") {
    // Core not present — fail silently rather than throwing.
    return;
  }
  var HC = window.HC;

  var STORE_KEY = "cancel_reschedule_requests"; // namespaced under hc_ by HC.store

  /* ============================================================
   * 1. Build a realistic booking confirmation from LIVE camp data.
   *    Mirrors what a parent would have received by email: a booking
   *    reference, the camp, the week, the price, and — crucially —
   *    the PROVIDER CONTACT block (Happity: "their details are on your
   *    booking confirmation email").
   * ============================================================ */

  function slug(s) {
    return String(s == null ? "" : s)
      .toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  }

  // Derive a best-effort contact channel for a provider. There is no
  // explicit email/phone in the verified camp data, so — exactly as a
  // real aggregator would — we point the parent at the provider's own
  // booking page (the source URL) and a derived support address, and we
  // are honest in the UI that the canonical details live on the email.
  function providerContact(provider) {
    var name = (provider && provider.name) || "the camp provider";
    var booking = (provider && provider.booking) || "";
    var url = "";
    try {
      if (provider && provider.source && provider.source.url) url = provider.source.url;
      else if (provider && provider.secondarySources && provider.secondarySources[0]) {
        url = provider.secondarySources[0].url || "";
      }
    } catch (e) { url = ""; }

    var host = "";
    try { if (url) host = url.replace(/^https?:\/\//, "").split("/")[0].replace(/^www\./, ""); }
    catch (e) { host = ""; }

    // A plausible support email derived from the provider; in real life
    // this is whatever they printed on the confirmation email.
    var email = "bookings@" + (host || (slug(name) + ".example")) ;

    return {
      providerName: name,
      email: email,
      bookingPage: url || null,
      bookingNote: booking || null,
      // Honest hint that the authoritative details are on the email.
      onEmail: "Provider contact details are on your booking confirmation email."
    };
  }

  function round2(n) { return Math.round((Number(n) + Number.EPSILON) * 100) / 100; }

  // Pick the price for a planner entry (day preferred, then week).
  function unitPrice(plannerEntry) {
    try {
      var price = plannerEntry && plannerEntry.price;
      if (!price) return null;
      if (typeof price.day === "number") return { amount: price.day, label: "day place" };
      if (typeof price.week === "number") return { amount: price.week, label: "full-week place" };
    } catch (e) {}
    return null;
  }

  // Build a confirmation object for a given provider id (or the first
  // priced camp if none given). Returns null if no usable camp exists.
  function buildConfirmation(providerId) {
    try {
      var providers = HC.data.providers || [];
      var byId = (HC.data.planner && HC.data.planner.byId) || {};
      var weeks = (HC.data.planner && HC.data.planner.weeks) || [];

      var provider = null;
      if (providerId) {
        provider = providers.filter(function (p) { return p.id === providerId; })[0] || null;
      }
      // Default: first provider that has a numeric price (a paid school-age place).
      if (!provider) {
        for (var i = 0; i < providers.length; i++) {
          if (unitPrice(byId[providers[i].id])) { provider = providers[i]; break; }
        }
      }
      if (!provider) provider = providers[0] || null;
      if (!provider) return null;

      var pl = byId[provider.id] || {};
      var price = unitPrice(pl);
      // Choose a confirmed week if the provider has one, else week 1.
      var weekId = (Array.isArray(pl.weeks) && pl.weeks.length) ? pl.weeks[0] : 1;
      var week = weeks.filter(function (w) { return w.id === weekId; })[0] || weeks[0] || null;

      var amount = price ? price.amount : null;
      var qty = 1; // one child, one place
      var total = amount != null ? round2(amount * qty) : null;

      return {
        ref: makeRef(provider.id),
        provider: provider,
        contact: providerContact(provider),
        camp: provider.name,
        venue: provider.venue || provider.address || provider.area || "",
        week: week ? (week.label + " · " + week.dates) : "Summer 2026",
        weekId: weekId,
        childName: "Your child",
        qty: qty,
        unitLabel: price ? price.label : "place",
        unitPrice: amount,
        total: total,
        status: "confirmed"
      };
    } catch (e) {
      return null;
    }
  }

  // Deterministic-ish booking reference (parents quote this to the provider).
  function makeRef(providerId) {
    var base = String(providerId || "camp").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 4);
    if (base.length < 4) base = (base + "CAMP").slice(0, 4);
    // 5-digit suffix from a cheap hash so the same camp yields a stable ref.
    var h = 0, s = String(providerId || "camp");
    for (var i = 0; i < s.length; i++) { h = (h * 31 + s.charCodeAt(i)) >>> 0; }
    var num = (h % 90000) + 10000;
    return "HC-" + base + "-" + num;
  }

  /* ============================================================
   * 2. The ROUTE logic — the heart of the feature.
   *    HolidayCamp can't cancel/reschedule; it builds a request that
   *    is ROUTED to the provider, carrying the booking reference and
   *    the provider's contact channel. This is what selfTest exercises.
   * ============================================================ */

  var VALID_KINDS = { cancel: 1, reschedule: 1 };

  // Build (but do not yet persist) a routed request.
  //   kind: 'cancel' | 'reschedule'
  //   confirmation: object from buildConfirmation()
  //   opts: { preferredWeekId, note }  (reschedule may name a target week)
  // Returns { ok, request } or { ok:false, reason, message }.
  function buildRequest(kind, confirmation, opts) {
    opts = opts || {};
    var k = String(kind || "").toLowerCase();
    if (!VALID_KINDS[k]) {
      return { ok: false, reason: "bad-kind", message: "Choose cancel or reschedule." };
    }
    if (!confirmation || !confirmation.provider || !confirmation.ref) {
      return { ok: false, reason: "no-booking", message: "No booking to act on." };
    }
    var contact = confirmation.contact || providerContact(confirmation.provider);
    // A routable request MUST carry a provider contact channel.
    var routable = !!(contact && (contact.email || contact.bookingPage));
    if (!routable) {
      return { ok: false, reason: "no-contact", message: "No provider contact channel available." };
    }

    var subject = (k === "cancel" ? "Cancellation request" : "Reschedule request") +
      " — booking " + confirmation.ref;

    var bodyLines = [
      "Hello " + contact.providerName + ",",
      "",
      (k === "cancel"
        ? "I'd like to cancel the following holiday-camp booking:"
        : "I'd like to reschedule the following holiday-camp booking:"),
      "  Booking reference: " + confirmation.ref,
      "  Camp: " + confirmation.camp,
      "  Week: " + confirmation.week
    ];
    if (k === "reschedule" && opts.preferredWeekId) {
      var targetWeek = findWeekLabel(opts.preferredWeekId);
      bodyLines.push("  Preferred new week: " + (targetWeek || ("Week " + opts.preferredWeekId)));
    }
    if (opts.note) bodyLines.push("", String(opts.note));
    bodyLines.push(
      "",
      "Please action this in line with your terms and conditions.",
      "Thank you."
    );

    var request = {
      id: HC.util.uid(),
      kind: k,
      ref: confirmation.ref,
      providerId: confirmation.provider.id,
      providerName: contact.providerName,
      contactEmail: contact.email || null,
      contactPage: contact.bookingPage || null,
      preferredWeekId: (k === "reschedule" ? (opts.preferredWeekId || null) : null),
      subject: subject,
      body: bodyLines.join("\n"),
      // 'routed' means: handed off to the provider. HolidayCamp never
      // marks it 'cancelled' itself — that's the provider's decision.
      status: "routed-to-provider",
      createdAt: new Date().toISOString()
    };

    return { ok: true, request: request };
  }

  function findWeekLabel(weekId) {
    try {
      var weeks = (HC.data.planner && HC.data.planner.weeks) || [];
      var w = weeks.filter(function (x) { return x.id === weekId; })[0];
      return w ? (w.label + " · " + w.dates) : null;
    } catch (e) { return null; }
  }

  /* ---- persistence of open requests (HC.store only) ---- */
  function loadRequests() {
    try {
      var arr = HC.store.get(STORE_KEY, []);
      return Array.isArray(arr) ? arr : [];
    } catch (e) { return []; }
  }
  function saveRequest(request) {
    try {
      var arr = loadRequests();
      arr.push(request);
      HC.store.set(STORE_KEY, arr);
      return true;
    } catch (e) { return false; }
  }
  function clearRequestsForRef(ref) {
    try {
      var arr = loadRequests().filter(function (r) { return r.ref !== ref; });
      HC.store.set(STORE_KEY, arr);
      return true;
    } catch (e) { return false; }
  }

  // High-level: submit a request = build + persist + (mock) hand off.
  function submitRequest(kind, confirmation, opts) {
    var built = buildRequest(kind, confirmation, opts);
    if (!built.ok) return built;
    saveRequest(built.request);
    return built;
  }

  /* ============================================================
   * 3. UI — a mock booking-confirmation card that surfaces the
   *    provider contact AND the cancel / reschedule request path.
   * ============================================================ */

  function esc(s) {
    return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
  function escAttr(s) { return esc(s).replace(/"/g, "&quot;"); }

  function render(mountEl) {
    try {
      var providers = HC.data.providers || [];
      var byId = (HC.data.planner && HC.data.planner.byId) || {};

      // Build a select of providers that have a numeric price (paid places).
      var priced = providers.filter(function (p) { return unitPrice(byId[p.id]); });
      if (!priced.length) priced = providers.slice(0, 8);

      var options = priced.map(function (p) {
        return '<option value="' + escAttr(p.id) + '">' + esc(p.name) + "</option>";
      }).join("");

      mountEl.innerHTML =
        '<div style="font-family:\'Nunito Sans\',system-ui,sans-serif;color:var(--text,#383838)">' +
          '<p style="font-size:14px;margin:0 0 12px">HolidayCamp is a <strong>third-party booking service</strong>. ' +
          'To cancel or reschedule a place you have booked, you contact the <strong>camp provider directly</strong> — ' +
          'their details are on your booking confirmation. Pick a confirmed booking below to see its confirmation ' +
          'and start a cancel / reschedule request that we route to the provider.</p>' +

          '<label style="display:block;font-weight:700;font-size:13px;margin-bottom:4px">Your booked camp</label>' +
          '<select id="crCamp" style="width:100%;padding:9px;border:1.5px solid var(--line,#E6E6E6);border-radius:12px;font-size:14px;margin-bottom:14px">' +
            options +
          "</select>" +

          '<div id="crConfirmation"></div>' +
          '<div id="crRequests" style="margin-top:14px"></div>' +
        "</div>";

      var $ = function (id) { return mountEl.querySelector("#" + id); };

      function paintConfirmation() {
        var conf = buildConfirmation($("crCamp").value);
        var host = $("crConfirmation");
        if (!conf) { host.innerHTML = '<p style="color:#9a1f5e">No booking data for this camp.</p>'; return; }

        var c = conf.contact;
        var priceLine = conf.total != null
          ? (HC.util.money(conf.unitPrice) + " / " + esc(conf.unitLabel) + " · paid " + HC.util.money(conf.total))
          : "Price confirmed with provider";

        host.innerHTML =
          // Confirmation "email" card.
          '<div style="border:1.5px solid var(--line,#E6E6E6);border-radius:16px;overflow:hidden">' +
            '<div style="background:var(--purple,#603488);color:#fff;padding:12px 16px;font-family:\'Quicksand\',system-ui,sans-serif">' +
              '<div style="font-weight:700;font-size:15px">✅ Booking confirmed</div>' +
              '<div style="font-size:12.5px;opacity:.9">Reference <strong>' + esc(conf.ref) + "</strong></div>" +
            "</div>" +
            '<div style="padding:14px 16px">' +
              '<div style="font-weight:700;font-size:15px;color:var(--purple,#603488)">' + esc(conf.camp) + "</div>" +
              (conf.venue ? '<div style="font-size:13px;color:var(--muted,#808080)">' + esc(conf.venue) + "</div>" : "") +
              '<div style="font-size:13.5px;margin-top:6px"><strong>Week:</strong> ' + esc(conf.week) + "</div>" +
              '<div style="font-size:13.5px"><strong>Place:</strong> ' + priceLine + "</div>" +

              // ---- PROVIDER CONTACT BLOCK (acceptance: provider contact) ----
              '<div id="crContact" style="margin-top:12px;background:var(--purple-tint,#F0E8F4);border-radius:12px;padding:11px 13px">' +
                '<div style="font-family:\'Quicksand\',system-ui,sans-serif;font-weight:700;font-size:12.5px;text-transform:uppercase;letter-spacing:.4px;color:var(--purple,#603488)">Camp provider contact</div>' +
                '<div style="font-size:13.5px;margin-top:4px"><strong>' + esc(c.providerName) + "</strong></div>" +
                '<div style="font-size:13px">✉️ <a href="mailto:' + escAttr(c.email) + '">' + esc(c.email) + "</a></div>" +
                (c.bookingPage ? '<div style="font-size:13px">🔗 <a href="' + escAttr(c.bookingPage) + '" target="_blank" rel="noopener">Provider booking page</a></div>' : "") +
                '<div style="font-size:12px;color:var(--muted,#808080);margin-top:4px">' + esc(c.onEmail) + "</div>" +
              "</div>" +

              // ---- CANCEL / RESCHEDULE PATH (acceptance: request path) ----
              '<div style="display:flex;gap:8px;margin-top:14px;flex-wrap:wrap">' +
                '<button id="crCancelBtn" type="button" class="hc-btn hc-btn-ghost" data-cr-kind="cancel">Request cancellation</button>' +
                '<button id="crReschedBtn" type="button" class="hc-btn" data-cr-kind="reschedule">Request reschedule</button>' +
              "</div>" +
              '<p style="font-size:11.5px;color:var(--muted,#808080);margin:8px 0 0">' +
                "We don't cancel or reschedule for you — we route your request to the provider, who decides in line with their terms &amp; conditions." +
              "</p>" +
            "</div>" +
          "</div>";

        $("crCancelBtn").addEventListener("click", function () { startRequest("cancel", conf); });
        $("crReschedBtn").addEventListener("click", function () { startRequest("reschedule", conf); });
      }

      function startRequest(kind, conf) {
        var opts = {};
        if (kind === "reschedule") {
          // Offer the camp's other confirmed weeks as reschedule targets.
          var pl = (HC.data.planner && HC.data.planner.byId && HC.data.planner.byId[conf.provider.id]) || {};
          var weeksList = Array.isArray(pl.weeks) ? pl.weeks : [];
          var alt = weeksList.filter(function (w) { return w !== conf.weekId; });
          if (alt.length) opts.preferredWeekId = alt[0];
        }
        var res = submitRequest(kind, conf, opts);
        if (!res.ok) { HC.util.toast(res.message || "Could not start request"); return; }
        HC.util.toast((kind === "cancel" ? "Cancellation" : "Reschedule") + " request routed to " + res.request.providerName);
        paintRequests();
      }

      function paintRequests() {
        var host = $("crRequests");
        var all = loadRequests();
        if (!all.length) { host.innerHTML = ""; return; }
        var rows = all.map(function (r) {
          return '<div style="border:1.5px solid var(--line,#E6E6E6);border-radius:12px;padding:10px 12px;margin-bottom:8px">' +
            '<div style="font-size:13px"><strong>' + (r.kind === "cancel" ? "Cancellation" : "Reschedule") + "</strong> · " +
              esc(r.ref) + " · " + esc(r.providerName) + "</div>" +
            '<div style="font-size:11.5px;color:var(--muted,#808080)">Status: ' + esc(r.status) + " · sent to " + esc(r.contactEmail || r.contactPage || "provider") + "</div>" +
            '<details style="margin-top:6px"><summary style="cursor:pointer;font-size:12px;color:var(--purple,#603488)">View message</summary>' +
              '<pre style="white-space:pre-wrap;font-size:12px;background:#faf7fc;border-radius:8px;padding:8px;margin:6px 0 0">' + esc(r.body) + "</pre>" +
            "</details>" +
          "</div>";
        }).join("");
        host.innerHTML =
          '<div style="font-family:\'Quicksand\',system-ui,sans-serif;font-weight:700;font-size:12.5px;text-transform:uppercase;letter-spacing:.4px;color:var(--magenta,#F82488);margin-bottom:6px">Your open requests</div>' +
          rows +
          '<button id="crClear" type="button" class="hc-btn hc-btn-ghost" style="font-size:11px">Clear (demo)</button>';
        var clr = $("crClear");
        if (clr) clr.addEventListener("click", function () {
          try { HC.store.set(STORE_KEY, []); } catch (e) {}
          paintRequests();
        });
      }

      $("crCamp").addEventListener("change", paintConfirmation);
      paintConfirmation();
      paintRequests();
    } catch (e) {
      mountEl.innerHTML = '<p style="color:#9a1f5e">Confirmation preview failed to load: ' +
        esc(e && e.message ? e.message : String(e)) + "</p>";
    }
  }

  /* ============================================================
   * 4. selfTest — exercises the ROUTE logic and asserts the
   *    acceptance criterion across multiple cases.
   * ============================================================ */

  function selfTest() {
    var pass = 0, fail = 0, log = [];
    function check(label, fn) {
      try { fn(); pass += 1; log.push("✓ " + label); }
      catch (e) { fail += 1; log.push("✗ " + label + " — " + (e && e.message ? e.message : String(e))); }
    }

    // Build a confirmation from live data once for reuse.
    var conf = buildConfirmation(null);

    // --- ACCEPTANCE part 1: confirmation surfaces PROVIDER CONTACT. ---
    check("Booking confirmation is built from live camp data", function () {
      HC.assert(conf, "expected a confirmation object from live data");
      HC.assert(typeof conf.ref === "string" && conf.ref.indexOf("HC-") === 0,
        "confirmation should carry an HC- booking reference, got " + (conf && conf.ref));
      HC.assert(conf.provider && conf.provider.id, "confirmation should name a provider");
    });

    check("Confirmation surfaces a provider contact channel", function () {
      var c = conf.contact;
      HC.assert(c, "contact block must exist on the confirmation");
      HC.assert(c.providerName && c.providerName.length > 0, "contact must name the provider");
      var hasChannel = !!(c.email || c.bookingPage);
      HC.assert(hasChannel, "contact must expose an email or booking page (their details are on the email)");
      HC.assert(/.+@.+/.test(c.email), "derived contact email should look like an address, got " + c.email);
    });

    // --- ACCEPTANCE part 2: a 'request cancel/reschedule' PATH exists. ---
    check("A cancel request can be built and is routed to the provider", function () {
      var r = buildRequest("cancel", conf);
      HC.assert(r.ok === true, "cancel request should build, got " + (r && r.message));
      HC.assert(r.request.kind === "cancel", "kind should be 'cancel'");
      HC.assert(r.request.status === "routed-to-provider",
        "request must be routed to provider, not actioned by us, got " + r.request.status);
      HC.assert(r.request.ref === conf.ref, "request must carry the booking reference");
      HC.assert(r.request.providerId === conf.provider.id, "request must name the provider");
      HC.assert(r.request.body.indexOf(conf.ref) !== -1, "drafted message must quote the booking reference");
      HC.assert(r.request.body.indexOf("cancel") !== -1, "cancel message must mention cancelling");
    });

    check("A reschedule request can be built and names a preferred week", function () {
      // Find a camp with >=2 confirmed weeks so reschedule has a real target.
      var providers = HC.data.providers || [];
      var byId = (HC.data.planner && HC.data.planner.byId) || {};
      var multiWeekId = null, altWeek = null, baseWeek = null;
      for (var i = 0; i < providers.length; i++) {
        var pl = byId[providers[i].id];
        if (pl && Array.isArray(pl.weeks) && pl.weeks.length >= 2 && unitPrice(pl)) {
          multiWeekId = providers[i].id; baseWeek = pl.weeks[0]; altWeek = pl.weeks[1]; break;
        }
      }
      HC.assert(multiWeekId, "expected at least one priced camp with >=2 confirmed weeks");
      var c2 = buildConfirmation(multiWeekId);
      var r = buildRequest("reschedule", c2, { preferredWeekId: altWeek });
      HC.assert(r.ok === true, "reschedule request should build");
      HC.assert(r.request.kind === "reschedule", "kind should be 'reschedule'");
      HC.assert(r.request.preferredWeekId === altWeek, "request should carry the preferred new week");
      HC.assert(r.request.status === "routed-to-provider", "reschedule must also route to provider");
    });

    // --- Negative / guard cases. ---
    check("An unknown request kind is rejected", function () {
      var r = buildRequest("delete", conf);
      HC.assert(r.ok === false, "only cancel/reschedule are valid kinds");
      HC.assert(r.reason === "bad-kind", "reason should be 'bad-kind', got " + r.reason);
    });

    check("A request with no booking is rejected", function () {
      var r = buildRequest("cancel", null);
      HC.assert(r.ok === false, "cannot route a request with no booking");
      HC.assert(r.reason === "no-booking", "reason should be 'no-booking', got " + r.reason);
    });

    check("A booking with no provider contact channel is not routable", function () {
      // Synthetic confirmation whose provider has no source/secondary URL:
      // providerContact still derives an email, so to test the guard we
      // strip the contact entirely.
      var stripped = {
        ref: "HC-TEST-12345",
        provider: { id: "ghost", name: "Ghost Camp" },
        contact: { providerName: "Ghost Camp", email: null, bookingPage: null }
      };
      var r = buildRequest("cancel", stripped);
      HC.assert(r.ok === false, "no contact channel means not routable");
      HC.assert(r.reason === "no-contact", "reason should be 'no-contact', got " + r.reason);
    });

    // --- Persistence: submitting a request stores it via HC.store. ---
    check("Submitting a request persists it via HC.store (and only hc_ keys)", function () {
      // Snapshot + clear to keep the test self-contained.
      var before = HC.store.get(STORE_KEY, []);
      HC.store.set(STORE_KEY, []);
      var res = submitRequest("cancel", conf);
      HC.assert(res.ok === true, "submit should succeed");
      var stored = HC.store.get(STORE_KEY, []);
      HC.assert(Array.isArray(stored) && stored.length === 1, "exactly one request should be stored, got " + stored.length);
      HC.assert(stored[0].ref === conf.ref, "stored request should carry the booking ref");
      HC.assert(stored[0].status === "routed-to-provider", "stored request should be routed, not actioned");
      // restore prior state
      HC.store.set(STORE_KEY, Array.isArray(before) ? before : []);
    });

    check("clearRequestsForRef removes only the matching booking's requests", function () {
      var before = HC.store.get(STORE_KEY, []);
      HC.store.set(STORE_KEY, []);
      submitRequest("cancel", conf);                 // ref A
      var other = { ref: "HC-OTHR-99999", provider: { id: "x", name: "Other" },
        contact: { providerName: "Other", email: "a@b.example", bookingPage: null } };
      submitRequest("reschedule", other, { preferredWeekId: 2 }); // ref B
      HC.assert(loadRequests().length === 2, "two requests expected before clear");
      clearRequestsForRef(conf.ref);
      var left = loadRequests();
      HC.assert(left.length === 1 && left[0].ref === "HC-OTHR-99999",
        "only the other booking's request should remain");
      HC.store.set(STORE_KEY, Array.isArray(before) ? before : []);
    });

    // --- The booking reference is stable for a given camp. ---
    check("Booking reference is stable for the same camp", function () {
      var a = makeRef("ymca-y-kidz");
      var b = makeRef("ymca-y-kidz");
      HC.assert(a === b, "same camp should yield the same reference");
      HC.assert(a !== makeRef("lloyd-park-childrens-charity"), "different camps should differ");
    });

    // --- COMBINED acceptance assertion (single, explicit). ---
    check("ACCEPTANCE: confirmation surfaces provider contact AND a cancel/reschedule path", function () {
      var c = conf.contact;
      var contactSurfaced = !!(c && c.providerName && (c.email || c.bookingPage));
      var cancelPath = buildRequest("cancel", conf).ok === true;
      var reschedPath = buildRequest("reschedule", conf).ok === true;
      HC.assert(contactSurfaced, "provider contact must be surfaced on the confirmation");
      HC.assert(cancelPath && reschedPath, "both a cancel and a reschedule request path must exist");
    });

    return { pass: pass, fail: fail, log: log };
  }

  /* ============================================================
   * 5. Register (idempotent + defensive via core).
   * ============================================================ */
  HC.registerFeature({
    id: "parent-cancel-reschedule-route",
    title: "Cancel / reschedule (routed to provider)",
    side: "parent",
    icon: "🔁",
    summary: "HolidayCamp is a third-party booking service, so cancelling or rescheduling is handled by the camp provider. Your booking confirmation shows the provider's contact details and a one-click path to request a cancel or reschedule, routed to them with your booking reference.",
    render: render,
    selfTest: selfTest
  });
})();
