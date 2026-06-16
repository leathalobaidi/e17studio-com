/* HolidayCamp feature — provider-trial-ticket
 *
 * Trial-price tickets (triggers the 'Trial' label)   (PROVIDER side)
 *
 * Replicates Happity's provider-facing ticket flow where a provider adds a
 * discounted TRIAL / taster ticket to a class, which automatically surfaces a
 * "Trial" label in the parent-facing search results.
 *
 * Evidence:
 *   - Article 10248958 ("Creating and managing tickets, prices and term
 *     bookings on Happity"): "Single tickets are ideal for one-off events or
 *     Pay As You Go (PAYG) drop-in sessions. You can also offer specific
 *     **Trial Tickets**, which triggers the 'Trial' label in Happity search
 *     results." and "Trial: Trial tickets can be offered for all your ticket
 *     types."
 *   - Article 4147863 ("How to add the different filters and labels"):
 *     "**Trial** — add a trial offer on to your class to get this label.
 *     (Choose 'Is this a trial offer?' when adding a new price)."
 *
 * So this is the PROVIDER half of the trial flow: the provider builds tickets
 * for a camp and flags ONE of them with "Is this a trial offer?". The moment a
 * trial-flagged ticket exists, the camp earns the Trial label that parents see
 * in search. (The parent-side label rendering lives in `parent-trial-label`;
 * this module owns the provider ticket-builder + persistence and the rule that
 * a trial ticket triggers the label.)
 *
 * Framed for SCHOOL-AGE HOLIDAY CAMPS (not baby classes). A "session" is one
 * camp day. Ticket types mirror Happity:
 *   - single : a single camp day / PAYG drop-in (1 session)
 *   - block  : a set number of consecutive camp days (a full week = 5)
 *   - term   : the whole holiday (all the weeks the camp runs)
 * Any of those can ALSO be flagged as a trial offer — but a trial is, by its
 * nature, a single discounted taster session, so a trial ticket is always
 * stored as a 1-session single ticket priced below the standard day rate.
 *
 * ACCEPTANCE CRITERION (asserted in selfTest):
 *   Adding a trial ticket shows the 'Trial' label in search.
 *   We verify: after a provider adds a ticket flagged "Is this a trial offer?",
 *   campHasTrialLabel(camp) === true and the derived search labels include
 *   'Trial' — and that a camp with only standard tickets shows NO Trial label.
 *
 * Self-contained, defensive, no imports/exports. Calls HC.registerFeature.
 */
(function () {
  "use strict";

  // Defensive: never throw at module load if HC isn't present.
  if (typeof window === "undefined" || !window.HC || typeof window.HC.registerFeature !== "function") {
    if (typeof console !== "undefined" && console.warn) {
      console.warn("[HC] provider-trial-ticket: HC core not found; skipping registration.");
    }
    return;
  }

  var HC = window.HC;

  // Persisted ticket lists keyed by providerId. Shape:
  //   { <providerId>: { tickets:[ ...ticket ] } }
  var STORE_KEY = "provider_trial_tickets";

  // A trial taster, per Happity, is a single discounted day. We cap it so a
  // misconfigured "trial" priced ABOVE the standard day rate is rejected (a
  // trial must actually be a cheaper taster to be a meaningful trial offer).
  var TRIAL_SESSIONS = 1;

  /* ===================================================================
     PURE LOGIC (DOM-free, testable)
     =================================================================== */

  function asText(v) {
    return typeof v === "string" ? v : (v == null ? "" : String(v));
  }

  function round2(n) {
    return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
  }

  var VALID_TYPES = ["single", "block", "term"];

  function safeUid(prefix) {
    try { return HC.util.uid(); }
    catch (e) { return (prefix || "id") + "_" + Date.now() + "_" + Math.floor(Math.random() * 1e6); }
  }

  // Number of camp sessions a ticket type covers by default.
  function defaultSessionsForType(type) {
    if (type === "block") return 5;   // a full camp week
    if (type === "term") return 30;   // ~6 weeks of the holiday
    return 1;                          // single
  }

  // Per-session price of a ticket (price / sessions). null if unusable.
  function perSession(ticket) {
    if (!ticket) return null;
    var price = Number(ticket.price);
    var sessions = Math.max(1, Math.floor(Number(ticket.sessions) || 1));
    if (!isFinite(price) || price < 0) return null;
    return round2(price / sessions);
  }

  // VALIDATE the inputs for a ticket BEFORE creating it.
  // `standardDayPrice` (optional) is the camp's standard per-day rate, used to
  // sanity-check that a TRIAL is actually a discount (a taster, not full price).
  // Returns { ok:Boolean, errors:[String] }. Pure — no side effects.
  function validateTicketInput(input, standardDayPrice) {
    var a = (input && typeof input === "object") ? input : {};
    var errors = [];

    if (!asText(a.label).trim()) errors.push("A ticket name is required.");

    var type = asText(a.type) || "single";
    if (VALID_TYPES.indexOf(type) === -1) {
      errors.push("Ticket type must be one of: " + VALID_TYPES.join(", ") + ".");
    }

    var price = Number(a.price);
    if (!isFinite(price) || price < 0) {
      errors.push("Price must be £0 or more.");
    }

    // Sessions, if supplied, must be a positive whole number.
    if (a.sessions !== undefined && a.sessions !== null && a.sessions !== "") {
      var s = Number(a.sessions);
      if (!isFinite(s) || s <= 0 || Math.floor(s) !== s) {
        errors.push("Sessions must be a whole number greater than zero.");
      }
    }

    // The trial-specific rule: a trial offer must be a genuine discount.
    if (a.isTrial === true && isFinite(price) && price >= 0) {
      var ref = Number(standardDayPrice);
      if (isFinite(ref) && ref > 0 && price >= ref) {
        errors.push("A trial offer must be cheaper than the standard day price (£" +
          ref + ") — a trial is a discounted taster.");
      }
    }

    return { ok: errors.length === 0, errors: errors };
  }

  // Create a ticket object. A ticket flagged isTrial:true is the Happity
  // "Is this a trial offer?" choice — it always becomes a single, 1-session
  // taster regardless of the chosen type, because a trial is one taster day.
  //
  // Returns { ok, ticket?, errors? }.
  function makeTicket(input, standardDayPrice) {
    var v = validateTicketInput(input, standardDayPrice);
    if (!v.ok) return { ok: false, errors: v.errors };
    var a = input;
    var isTrial = a.isTrial === true;
    var type = isTrial ? "single" : (asText(a.type) || "single");

    // Sessions: trials are always single-session tasters; otherwise honour an
    // explicit value or fall back to the type default.
    var sessions;
    if (isTrial) {
      sessions = TRIAL_SESSIONS;
    } else if (a.sessions !== undefined && a.sessions !== null && a.sessions !== "") {
      sessions = Math.max(1, Math.floor(Number(a.sessions)));
    } else {
      sessions = defaultSessionsForType(type);
    }

    var ticket = {
      id: safeUid("tkt"),
      label: asText(a.label).trim(),
      type: type,
      isTrial: isTrial,               // <-- "Is this a trial offer?"
      price: round2(Number(a.price)),
      sessions: sessions,
      createdAt: Date.now()
    };
    return { ok: true, ticket: ticket };
  }

  // Predicate: is this a trial-flagged ticket? (Robust to a legacy string flag.)
  function isTrialTicket(t) {
    return !!t && (t.isTrial === true || t.kind === "trial" || t.trial === true);
  }

  // THE acceptance-criterion core ------------------------------------------
  //
  // Does this camp carry the Trial label in search? On Happity the Trial label
  // is derived purely from the tickets: if ANY ticket is a trial offer, the
  // camp shows the Trial label. No separate provider toggle.
  function campHasTrialLabel(camp) {
    if (!camp) return false;
    var tickets = Array.isArray(camp.tickets) ? camp.tickets : [];
    for (var i = 0; i < tickets.length; i++) {
      if (isTrialTicket(tickets[i])) return true;
    }
    return false;
  }

  // The full set of search labels a camp earns from its tickets. Today the
  // only ticket-derived label this PROVIDER feature owns is 'Trial'; returning
  // an array keeps it forward-compatible with the parent-side label set.
  function searchLabelsFor(camp) {
    var out = [];
    try {
      if (campHasTrialLabel(camp)) out.push("Trial");
    } catch (e) { /* defensive: a malformed camp simply earns no labels */ }
    return out;
  }

  /* ===================================================================
     PERSISTENCE (HC.store only — never raw localStorage)
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

  function providerBucket(map, providerId) {
    var pid = asText(providerId) || "_default";
    if (!map[pid] || typeof map[pid] !== "object") map[pid] = { tickets: [] };
    if (!Array.isArray(map[pid].tickets)) map[pid].tickets = [];
    return map[pid];
  }

  function getTickets(providerId) {
    var map = readAll();
    return providerBucket(map, providerId).tickets.slice();
  }

  // Standard day price for a provider, from the live planner data, used to
  // validate that a trial price is a real discount.
  function standardDayPrice(providerId) {
    try {
      var byId = (HC.data.planner && HC.data.planner.byId) || {};
      var pl = byId[providerId];
      var pr = pl && pl.price;
      if (pr) {
        if (typeof pr.day === "number") return pr.day;
        if (typeof pr.dayExtended === "number") return pr.dayExtended;
        if (typeof pr.halfDay === "number") return pr.halfDay;
        if (typeof pr.week === "number") return round2(pr.week / 5);
        if (typeof pr.sessionFrom === "number") return pr.sessionFrom;
      }
    } catch (e) {}
    return null;
  }

  // Add a ticket for a provider. Returns { ok, ticket?, errors? }.
  function addTicket(providerId, input) {
    var res = makeTicket(input, standardDayPrice(providerId));
    if (!res.ok) return res;
    var map = readAll();
    var bucket = providerBucket(map, providerId);
    bucket.tickets.push(res.ticket);
    if (bucket.tickets.length > 100) bucket.tickets = bucket.tickets.slice(-100);
    writeAll(map);
    return res;
  }

  function removeTicket(providerId, ticketId) {
    var map = readAll();
    var bucket = providerBucket(map, providerId);
    var before = bucket.tickets.length;
    bucket.tickets = bucket.tickets.filter(function (t) { return t.id !== ticketId; });
    writeAll(map);
    return bucket.tickets.length < before;
  }

  function clearProvider(providerId) {
    var map = readAll();
    var pid = asText(providerId) || "_default";
    delete map[pid];
    writeAll(map);
  }

  // Build a camp-like object for label derivation from a provider's stored
  // tickets — this is exactly what the search index would see.
  function campFromStore(providerId, name) {
    return { id: asText(providerId), name: asText(name) || asText(providerId), tickets: getTickets(providerId) };
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
  function money(n) {
    try { return HC.util.money(n); } catch (e) { return "£" + n; }
  }

  function demoProvider() {
    try {
      var ps = HC.data.providers;
      if (ps && ps.length) {
        // Prefer a provider with a known standard day price so the trial
        // discount rule is meaningful in the demo.
        for (var i = 0; i < ps.length; i++) {
          if (ps[i] && ps[i].id && standardDayPrice(ps[i].id) != null) return ps[i];
        }
        if (ps[0] && ps[0].id) return ps[0];
      }
    } catch (e) {}
    return { id: "_demo_provider", name: "Demo Holiday Camp" };
  }

  var TRIAL_BADGE =
    '<span style="display:inline-flex;align-items:center;gap:4px;' +
    "font-family:'Quicksand',system-ui,sans-serif;font-weight:700;font-size:11px;line-height:1;" +
    'padding:4px 9px;border-radius:999px;color:#603488;background:#F0E8F4">🎟️ Trial</span>';

  function ticketTypeLabel(t) {
    if (t.isTrial) return "Trial / taster";
    if (t.type === "block") return "Block (" + t.sessions + " days)";
    if (t.type === "term") return "Term";
    return "Single day";
  }

  function ticketsHtml(providerId) {
    var tickets = getTickets(providerId);
    if (!tickets.length) {
      return '<li style="color:var(--muted,#808080);list-style:none;margin-left:-20px">No tickets yet — add one below.</li>';
    }
    return tickets.map(function (t) {
      var per = perSession(t);
      return '<li style="margin:0 0 7px" data-tkt="' + escAttr(t.id) + '">' +
        '<strong>' + esc(t.label) + "</strong>" +
        (t.isTrial ? " " + TRIAL_BADGE : "") +
        '<div style="font-size:12.5px;color:var(--muted,#808080)">' +
          esc(ticketTypeLabel(t)) + " · " + esc(money(t.price)) +
          (per !== null && t.sessions > 1 ? " (" + esc(money(per)) + "/day)" : "") +
        "</div>" +
        '<button class="hc-btn hc-btn-ghost" type="button" data-del="' + escAttr(t.id) +
          '" style="margin-top:4px;padding:3px 9px;font-size:11px">Remove</button>' +
      "</li>";
    }).join("");
  }

  // The parent-search preview: shows whether the Trial label fires right now.
  function searchPreviewHtml(providerId, name) {
    var camp = campFromStore(providerId, name);
    var labels = searchLabelsFor(camp);
    var has = labels.indexOf("Trial") !== -1;
    return '' +
      '<div style="font-family:Quicksand,system-ui,sans-serif;font-weight:700;color:var(--purple,#603488);margin-bottom:6px">' +
        "Parent search result preview</div>" +
      '<div style="border:1.5px solid var(--line,#E6E6E6);border-radius:14px;padding:12px 14px;background:#fff">' +
        '<div style="font-family:Quicksand,system-ui,sans-serif;font-weight:700;color:var(--purple,#603488)">' +
          esc(name) + "</div>" +
        '<div style="margin-top:6px;display:flex;flex-wrap:wrap;gap:6px">' +
          (has ? TRIAL_BADGE
               : '<span style="font-size:11px;color:var(--muted,#808080)">No Trial label — add a trial ticket to earn it.</span>') +
        "</div>" +
      "</div>" +
      '<div style="font-size:12px;color:var(--muted,#808080);margin-top:6px">' +
        (has ? "✓ A trial ticket is present, so this camp shows the Trial label in search."
             : "Tick “Is this a trial offer?” when adding a ticket to trigger the Trial label.") +
      "</div>";
  }

  function render(mountEl) {
    try {
      if (!mountEl) return;
      var prov = demoProvider();
      var providerId = prov.id;
      var name = prov.name;
      var dayPrice = standardDayPrice(providerId);
      // Sensible default trial price: half the day rate (min £5), else £10.
      var defTrial = (dayPrice != null) ? Math.max(5, round2(dayPrice * 0.5)) : 10;
      var defStd = (dayPrice != null) ? dayPrice : 40;

      mountEl.innerHTML = "";

      var intro = el("div", null,
        '<p style="font-size:14px;color:var(--text,#383838);margin:0 0 4px">' +
          "On Happity a <strong>trial ticket</strong> is a discounted taster session you add to a camp. " +
          "Tick <em>“Is this a trial offer?”</em> when adding a price and the camp automatically earns " +
          "the <strong>Trial</strong> label in parents’ search results.</p>" +
        '<p style="font-size:12.5px;color:var(--muted,#808080);margin:0 0 10px">' +
          "Building tickets for <strong>" + esc(name) + "</strong>" +
          (dayPrice != null ? " (standard day £" + esc(dayPrice) + ")." : ".") + "</p>");
      mountEl.appendChild(intro);

      // Add-a-ticket form.
      var form = el("div", {
        style: "border:1.5px solid var(--line,#E6E6E6);border-radius:14px;padding:14px;background:#F7F4FB"
      });
      form.innerHTML =
        '<div style="font-family:Quicksand,system-ui,sans-serif;font-weight:700;color:var(--purple,#603488);margin-bottom:8px">' +
          "Add a ticket</div>" +
        '<label style="display:block;font-size:13px;margin:0 0 8px">Ticket name<br>' +
          '<input id="ttLabel" type="text" value="Taster day" ' +
            'style="width:100%;padding:6px 8px;border:1.5px solid var(--line,#E6E6E6);border-radius:8px"></label>' +
        '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">' +
          '<label style="display:block;font-size:13px;margin:0 0 8px">Ticket type<br>' +
            '<select id="ttType" style="width:100%;padding:6px 8px;border:1.5px solid var(--line,#E6E6E6);border-radius:8px">' +
              '<option value="single">Single day / drop-in</option>' +
              '<option value="block">Block (full week)</option>' +
              '<option value="term">Term (whole holiday)</option>' +
            "</select></label>" +
          '<label style="display:block;font-size:13px;margin:0 0 8px">Price £<br>' +
            '<input id="ttPrice" type="number" min="0" step="0.5" value="' + escAttr(defTrial) + '" ' +
              'style="width:100%;padding:6px 8px;border:1.5px solid var(--line,#E6E6E6);border-radius:8px"></label>' +
        "</div>" +
        '<label style="display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer;margin:2px 0 10px">' +
          '<input id="ttTrial" type="checkbox" checked>' +
          "<span><strong>Is this a trial offer?</strong> <em>(triggers the Trial label)</em></span>" +
        "</label>" +
        '<button class="hc-btn" id="ttAdd" type="button">+ Add ticket</button>' +
        '<button class="hc-btn hc-btn-ghost" id="ttStd" type="button" style="margin-left:8px">+ Add a standard day (£' + esc(defStd) + ")</button>" +
        '<div id="ttErr" style="margin-top:8px;color:#9a1f5e;font-size:12.5px"></div>';
      mountEl.appendChild(form);

      // Live ticket list.
      var listWrap = el("div", { style: "margin-top:14px" });
      listWrap.innerHTML =
        '<div style="font-family:Quicksand,system-ui,sans-serif;font-weight:700;color:var(--purple,#603488)">Tickets for this camp</div>' +
        '<ul id="ttList" style="margin:8px 0 0;padding-left:20px;font-size:13.5px;color:var(--text,#383838)">' +
          ticketsHtml(providerId) + "</ul>";
      mountEl.appendChild(listWrap);

      // Search preview.
      var preview = el("div", { id: "ttPreview", style: "margin-top:16px;border-top:1px solid var(--line,#E6E6E6);padding-top:14px" },
        searchPreviewHtml(providerId, name));
      mountEl.appendChild(preview);

      function refresh() {
        var listEl = mountEl.querySelector("#ttList");
        if (listEl) listEl.innerHTML = ticketsHtml(providerId);
        var pv = mountEl.querySelector("#ttPreview");
        if (pv) pv.innerHTML = searchPreviewHtml(providerId, name);
      }
      function val(id) { var n = form.querySelector("#" + id); return n ? n.value : ""; }
      function checked(id) { var n = form.querySelector("#" + id); return !!(n && n.checked); }

      function add(isTrialOverride) {
        var errHost = form.querySelector("#ttErr");
        if (errHost) errHost.textContent = "";
        var isTrial = (isTrialOverride === undefined) ? checked("ttTrial") : isTrialOverride;
        var res = addTicket(providerId, {
          label: isTrialOverride === false ? "Standard day" : val("ttLabel"),
          type: isTrialOverride === false ? "single" : val("ttType"),
          price: isTrialOverride === false ? defStd : val("ttPrice"),
          isTrial: isTrial
        });
        if (!res.ok) {
          if (errHost) errHost.textContent = res.errors.join(" ");
          return;
        }
        refresh();
        try {
          HC.util.toast(res.ticket.isTrial
            ? "Trial ticket added — camp now shows the Trial label"
            : "Standard ticket added");
        } catch (e) {}
      }

      var addBtn = form.querySelector("#ttAdd");
      if (addBtn) addBtn.addEventListener("click", function () { add(); });
      var stdBtn = form.querySelector("#ttStd");
      if (stdBtn) stdBtn.addEventListener("click", function () { add(false); });

      // Toggling the trial checkbox swaps the suggested default price.
      var trialBox = form.querySelector("#ttTrial");
      var priceBox = form.querySelector("#ttPrice");
      if (trialBox && priceBox) {
        trialBox.addEventListener("change", function () {
          priceBox.value = trialBox.checked ? defTrial : defStd;
        });
      }

      // Delegated remove within this mount only.
      listWrap.addEventListener("click", function (e) {
        var btn = e.target && e.target.closest ? e.target.closest("[data-del]") : null;
        if (!btn) return;
        removeTicket(providerId, btn.getAttribute("data-del"));
        refresh();
        try { HC.util.toast("Ticket removed"); } catch (er) {}
      });
    } catch (e) {
      try {
        mountEl.innerHTML = '<p style="color:#9a1f5e">Trial-ticket feature failed to render: ' +
          esc(e && e.message ? e.message : String(e)) + "</p>";
      } catch (e2) { /* give up quietly */ }
    }
  }

  /* ===================================================================
     selfTest — exercises the LOGIC and asserts the acceptance criterion.
     =================================================================== */

  function selfTest() {
    var pass = 0, fail = 0, log = [];
    function check(label, fn) {
      try { fn(); pass += 1; log.push("✓ " + label); }
      catch (e) { fail += 1; log.push("✗ " + label + " — " + (e && e.message ? e.message : String(e))); }
    }

    var TP = "__selftest_trial_provider__";
    clearProvider(TP); // deterministic starting point

    // ===== ACCEPTANCE CRITERION =====
    // Adding a trial ticket shows the 'Trial' label in search.

    check("A fresh camp (no tickets) shows NO Trial label", function () {
      var camp = campFromStore(TP, "Fresh Camp");
      HC.assert(campHasTrialLabel(camp) === false, "no tickets => no Trial label");
      HC.assert(searchLabelsFor(camp).indexOf("Trial") === -1, "search labels must not include Trial");
    });

    check("A camp with only a STANDARD ticket shows NO Trial label", function () {
      var res = addTicket(TP, { label: "Standard day", type: "single", price: 40, isTrial: false });
      HC.assert(res.ok === true, "standard ticket should be created: " + (res.errors || []).join(" "));
      HC.assert(res.ticket.isTrial === false, "ticket should not be a trial");
      var camp = campFromStore(TP, "Standard Camp");
      HC.assert(campHasTrialLabel(camp) === false, "a standard-only camp must not show the Trial label");
      HC.assert(searchLabelsFor(camp).indexOf("Trial") === -1, "search labels must not include Trial yet");
    });

    check("ACCEPTANCE: adding a trial ticket shows the 'Trial' label in search", function () {
      var res = addTicket(TP, { label: "Taster day", type: "single", price: 15, isTrial: true });
      HC.assert(res.ok === true, "trial ticket should be created: " + (res.errors || []).join(" "));
      HC.assert(res.ticket.isTrial === true, "ticket must be flagged as a trial");
      var camp = campFromStore(TP, "Trial Camp");
      // THE acceptance assertion:
      HC.assert(campHasTrialLabel(camp) === true, "a trial ticket must make the camp earn the Trial label");
      HC.assert(searchLabelsFor(camp).indexOf("Trial") !== -1,
        "the 'Trial' label must appear in the camp's search labels");
    });

    check("Removing the trial ticket removes the Trial label again", function () {
      var trial = getTickets(TP).filter(isTrialTicket)[0];
      HC.assert(trial, "the trial ticket should exist before removal");
      var removed = removeTicket(TP, trial.id);
      HC.assert(removed === true, "removal should report success");
      var camp = campFromStore(TP, "Post-removal Camp");
      HC.assert(campHasTrialLabel(camp) === false, "with the trial gone, no Trial label");
      // The standard ticket should still be there.
      HC.assert(getTickets(TP).length === 1, "the standard ticket should remain, got " + getTickets(TP).length);
    });

    // ===== A trial flag is what matters, not the ticket TYPE =====

    check("Any ticket type flagged as a trial is normalised to a single taster session", function () {
      clearProvider(TP);
      // Provider tries to flag a 'block' as a trial — Happity treats a trial as
      // a single discounted taster, so it normalises to a 1-session single.
      var res = makeTicket({ label: "Block trial?", type: "block", price: 12, isTrial: true });
      HC.assert(res.ok === true, "trial-on-block should be accepted: " + (res.errors || []).join(" "));
      HC.assert(res.ticket.type === "single", "a trial must be stored as a single ticket");
      HC.assert(res.ticket.sessions === 1, "a trial taster covers exactly one session");
      HC.assert(res.ticket.isTrial === true, "the trial flag must be preserved");
    });

    check("Legacy trial flags (kind:'trial' / trial:true) still earn the Trial label", function () {
      var camp = {
        name: "Legacy", tickets: [
          { label: "Std", type: "single", price: 40 },
          { label: "Legacy trial", price: 10, kind: "trial" }
        ]
      };
      HC.assert(campHasTrialLabel(camp) === true, "kind:'trial' should be detected");
      var camp2 = { name: "Legacy2", tickets: [{ label: "t", price: 9, trial: true }] };
      HC.assert(campHasTrialLabel(camp2) === true, "trial:true should be detected");
    });

    // ===== A trial must be a genuine discount =====

    check("A trial priced AT/ABOVE the standard day rate is rejected (must be a discount)", function () {
      // TP currently has no tickets; standard day rate is supplied via the live
      // data only if TP existed there — it doesn't, so pass it explicitly.
      var atFull = makeTicket({ label: "Not a discount", price: 40, isTrial: true }, 40);
      HC.assert(atFull.ok === false, "a trial == standard price must be rejected");
      HC.assert(/cheaper|discount|trial/i.test(atFull.errors.join(" ")), "error should explain the discount rule");
      var above = makeTicket({ label: "Pricey trial", price: 55, isTrial: true }, 40);
      HC.assert(above.ok === false, "a trial above standard price must be rejected");
      var below = makeTicket({ label: "Good trial", price: 15, isTrial: true }, 40);
      HC.assert(below.ok === true, "a trial below standard price must be accepted");
    });

    check("A standard ticket at the same price is fine (the discount rule is trial-only)", function () {
      var std = makeTicket({ label: "Full day", price: 40, isTrial: false }, 40);
      HC.assert(std.ok === true, "a standard ticket at the day rate must be accepted");
    });

    // ===== Input validation =====

    check("A ticket with no name is rejected", function () {
      var res = makeTicket({ price: 10, isTrial: true });
      HC.assert(res.ok === false, "a nameless ticket must be rejected");
      HC.assert(/name/i.test(res.errors.join(" ")), "error should mention the missing name");
    });

    check("A ticket with a negative / non-numeric price is rejected", function () {
      HC.assert(makeTicket({ label: "Neg", price: -5 }).ok === false, "negative price must be rejected");
      HC.assert(makeTicket({ label: "NaN", price: "free" }).ok === false, "non-numeric price must be rejected");
    });

    check("Fractional / zero sessions on a non-trial ticket are rejected", function () {
      HC.assert(makeTicket({ label: "Frac", price: 30, sessions: 2.5 }).ok === false, "fractional sessions rejected");
      HC.assert(makeTicket({ label: "Zero", price: 30, sessions: 0 }).ok === false, "zero sessions rejected");
    });

    // ===== Per-session maths =====

    check("Per-session price is computed from price / sessions", function () {
      var blk = makeTicket({ label: "Week", type: "block", price: 150, sessions: 5, isTrial: false });
      HC.assert(blk.ok === true, "block ticket should be created");
      HC.assert(blk.ticket.sessions === 5, "block keeps its 5 sessions");
      HC.assert(perSession(blk.ticket) === 30, "expected £30/session, got " + perSession(blk.ticket));
    });

    check("A free (£0) trial keeps price 0 and still earns the Trial label", function () {
      var res = makeTicket({ label: "Free taster", price: 0, isTrial: true }, 40);
      HC.assert(res.ok === true, "a free trial taster should be accepted");
      HC.assert(res.ticket.price === 0, "an explicit £0 price must be preserved as 0, got " + res.ticket.price);
      var camp = { name: "FreeTrial", tickets: [res.ticket] };
      HC.assert(campHasTrialLabel(camp) === true, "a free trial still earns the Trial label");
    });

    // ===== Persistence via HC.store =====

    check("Tickets persist via HC.store and reload independently", function () {
      clearProvider(TP);
      addTicket(TP, { label: "Std day", type: "single", price: 40, isTrial: false });
      addTicket(TP, { label: "Taster", type: "single", price: 12, isTrial: true });
      var reloaded = getTickets(TP);
      HC.assert(reloaded.length === 2, "two tickets should persist, got " + reloaded.length);
      var camp = campFromStore(TP, "Persisted Camp");
      HC.assert(campHasTrialLabel(camp) === true, "the persisted trial ticket must still earn the Trial label");
    });

    check("Multiple trial tickets still yield exactly one Trial label", function () {
      addTicket(TP, { label: "Second taster", type: "single", price: 8, isTrial: true });
      var camp = campFromStore(TP, "Two-trials Camp");
      var labels = searchLabelsFor(camp);
      var trialCount = labels.filter(function (l) { return l === "Trial"; }).length;
      HC.assert(trialCount === 1, "the Trial label should appear once, got " + trialCount);
    });

    // ===== Live-data integration =====

    check("Live data: a real E17 provider can be flagged with a valid trial discount", function () {
      var prov = demoProvider();
      HC.assert(prov && prov.id, "a demo provider should be resolvable from live data");
      var day = standardDayPrice(prov.id);
      if (day != null) {
        var res = addTicket(prov.id, { label: "Summer taster", type: "single", price: Math.max(5, round2(day * 0.5)), isTrial: true });
        HC.assert(res.ok === true, "a half-price trial on a live camp should be accepted: " + (res.errors || []).join(" "));
        var camp = campFromStore(prov.id, prov.name);
        HC.assert(campHasTrialLabel(camp) === true, "the live camp should now show the Trial label");
        // leave the live provider's mock bucket clean
        clearProvider(prov.id);
      } else {
        // No usable price — the rule simply can't bite, but a trial should still create.
        var res2 = addTicket(prov.id, { label: "Taster", type: "single", price: 10, isTrial: true });
        HC.assert(res2.ok === true, "with no standard price, a trial should still be accepted");
        clearProvider(prov.id);
      }
    });

    // ===== Defensive: garbage input never throws and never persists =====

    check("Garbage input is handled and never persists", function () {
      var before = getTickets(TP).length;
      var bad = [null, undefined, 42, "", [], {}, { price: {} }, { label: "x", price: NaN }];
      for (var i = 0; i < bad.length; i++) {
        var res = addTicket(TP, bad[i]);
        HC.assert(res && res.ok === false, "garbage input #" + i + " must be rejected");
      }
      HC.assert(getTickets(TP).length === before, "garbage input must not change stored tickets");
      // And label logic on garbage camps must not throw.
      HC.assert(campHasTrialLabel(null) === false, "null camp => no Trial label");
      HC.assert(campHasTrialLabel({}) === false, "empty camp => no Trial label");
      HC.assert(searchLabelsFor(undefined).length === 0, "undefined camp => no labels");
    });

    // cleanup so repeated runs stay stable
    clearProvider(TP);

    return { pass: pass, fail: fail, log: log };
  }

  /* ===================================================================
     register (idempotent + defensive via core)
     =================================================================== */

  HC.registerFeature({
    id: "provider-trial-ticket",
    title: "Trial-price tickets (triggers Trial label)",
    side: "provider",
    icon: "🎟️",
    summary: "Add a discounted trial / taster ticket to a camp by ticking “Is this a trial offer?”. The moment a trial ticket exists, the camp automatically earns the Trial label parents see in search results.",
    render: render,
    selfTest: selfTest
  });
})();
