/* HolidayCamp feature: provider-price-wizard
 * ------------------------------------------------------------------
 * Replicates Happity's "Price Wizard" (support articles 10248958 —
 * "Creating and Managing Tickets, Prices, and Term Bookings on
 * Happity"; and 2295670 — "Creating prices and assigning tickets").
 *
 * Happity, faithful to the evidence:
 *   "The Happity Price Wizard allows you to efficiently create, manage,
 *    and reuse Single, Block, and Term tickets for your classes."
 *   - Create new: pick a type (Single / Block / Term), then Continue to
 *     edit name, cost and booking info. You can include Trial on any
 *     type, and create discounted Sibling tickets.
 *   - Single: PAYG drop-ins / one-off; can be a Trial.
 *   - Block: a set number of CONSECUTIVE sessions; you set how many.
 *     "Customers can only purchase block tickets if there are enough
 *     remaining consecutive dates."
 *   - Term: books into all remaining dates in a term, with an
 *     "Automatic Pro-Rata Calculator" — "enter the cost per single
 *     session and the system handles the maths". Full-term or half-term.
 *   - Tags: First Child (default), Sibling, Adult.
 *   - Reuse: "Set up a ticket once, then assign it to as many classes as
 *     you need." Reused tickets are shared — a price change applies to
 *     every class using that ticket. The wizard's "View inactive prices"
 *     lets you tick existing tickets onto a class.
 *
 * Side: provider. Framed for SCHOOL-AGE HOLIDAY CAMPS (day places,
 * extended days, full weeks across the summer term), not baby classes.
 *
 * ACCEPTANCE CRITERION (verified by selfTest):
 *   The wizard creates Single/Block/Term tickets AND can reuse an
 *   existing price across classes.
 *
 * Defensive: nothing throws at registration time. Persistence is via
 * HC.store only (the provider's ticket library + per-class price
 * lists). No global localStorage keys are written.
 * ------------------------------------------------------------------ */
(function () {
  "use strict";

  if (typeof window === "undefined" || !window.HC || typeof window.HC.registerFeature !== "function") {
    // Core not present — fail silently rather than throwing.
    return;
  }
  var HC = window.HC;

  // Namespaced under hc_ by core. The library is the provider's set of
  // tickets; pricelists maps a class id -> array of assigned ticket ids.
  var STORE_TICKETS = "provider_price_wizard_tickets";
  var STORE_PRICELISTS = "provider_price_wizard_pricelists";

  /* ============================================================
   * 1. Constants — ticket types & tags (faithful to Happity).
   * ============================================================ */

  var TYPES = ["single", "block", "term"];
  var TAGS = ["first_child", "sibling", "adult"];
  var TERM_SCOPES = ["full_term", "half_term"];

  var TYPE_LABEL = { single: "Single", block: "Block", term: "Term" };
  var TAG_LABEL = { first_child: "First child", sibling: "Sibling", adult: "Adult" };

  /* ============================================================
   * 2. Store helpers (all defensive).
   * ============================================================ */

  function loadTickets() {
    try {
      var t = HC.store.get(STORE_TICKETS, []);
      return Array.isArray(t) ? t : [];
    } catch (e) { return []; }
  }
  function saveTickets(list) {
    try { return HC.store.set(STORE_TICKETS, Array.isArray(list) ? list : []); }
    catch (e) { return false; }
  }
  function loadPriceLists() {
    try {
      var p = HC.store.get(STORE_PRICELISTS, {});
      return (p && typeof p === "object" && !Array.isArray(p)) ? p : {};
    } catch (e) { return {}; }
  }
  function savePriceLists(map) {
    try { return HC.store.set(STORE_PRICELISTS, (map && typeof map === "object") ? map : {}); }
    catch (e) { return false; }
  }

  function newTicketId() {
    try { return "tkt_" + HC.util.uid(); }
    catch (e) { return "tkt_" + Date.now().toString(36) + "_" + Math.floor(Math.random() * 1e6).toString(36); }
  }

  function num(v) {
    var n = Number(v);
    return isFinite(n) ? n : NaN;
  }

  /* ============================================================
   * 3. Core LOGIC — createTicket().
   *
   * PURE constructor + validator. Returns { ok, ticket } or
   * { ok:false, reason, message }. Does NOT persist; the caller
   * decides whether to save. This is what selfTest exercises.
   *
   * spec = {
   *   type: 'single'|'block'|'term',
   *   name, cost (Number, >= 0),
   *   tag: 'first_child'|'sibling'|'adult'  (default first_child),
   *   trial: Boolean,            // can apply to any type
   *   donations: Boolean,        // "add a donation at checkout"
   *   info: String,              // booking info for customers
   *   // block-only:
   *   sessions: Number (>=2),    // consecutive sessions in the block
   *   // term-only:
   *   scope: 'full_term'|'half_term'  (default full_term)
   *   // (term cost is the cost-per-single-session; pro-rata uses it)
   * }
   * ============================================================ */

  function createTicket(spec) {
    spec = spec || {};

    var type = String(spec.type || "").toLowerCase();
    if (TYPES.indexOf(type) === -1) {
      return { ok: false, reason: "bad-type", message: "Pick a ticket type: Single, Block, or Term." };
    }

    var cost = num(spec.cost);
    if (!isFinite(cost) || cost < 0) {
      return { ok: false, reason: "bad-cost", message: "Enter a valid cost (£0 or more)." };
    }

    var tag = String(spec.tag || "first_child").toLowerCase();
    if (TAGS.indexOf(tag) === -1) tag = "first_child";

    var trial = !!spec.trial;

    var ticket = {
      id: newTicketId(),
      type: type,
      tag: tag,
      trial: trial,
      donations: !!spec.donations,
      cost: cost,
      info: spec.info != null ? String(spec.info) : "",
      // Reuse bookkeeping: which class ids this ticket is assigned to.
      assignedTo: [],
      createdAt: new Date().toISOString(),
      active: true
    };

    // Type-specific fields, validated.
    if (type === "block") {
      var sessions = num(spec.sessions);
      if (!isFinite(sessions) || sessions < 2 || Math.floor(sessions) !== sessions) {
        return { ok: false, reason: "bad-sessions",
          message: "A block needs a whole number of consecutive sessions (2 or more)." };
      }
      ticket.sessions = sessions;
    } else if (type === "term") {
      var scope = String(spec.scope || "full_term").toLowerCase();
      if (TERM_SCOPES.indexOf(scope) === -1) scope = "full_term";
      ticket.scope = scope;                 // full_term | half_term
      ticket.costPerSession = cost;         // term cost IS the per-session cost
      ticket.proRata = true;                // Automatic Pro-Rata Calculator
    }

    // Default name if none supplied (Happity pre-fills sensible names).
    ticket.name = (spec.name != null && String(spec.name).trim())
      ? String(spec.name).trim()
      : defaultTicketName(ticket);

    return { ok: true, ticket: ticket };
  }

  function defaultTicketName(t) {
    var parts = [];
    if (t.trial) parts.push("Trial");
    if (t.tag === "sibling") parts.push("Sibling");
    else if (t.tag === "adult") parts.push("Adult");
    if (t.type === "single") parts.push("Single session");
    else if (t.type === "block") parts.push("Block of " + (t.sessions || "?"));
    else if (t.type === "term") parts.push(t.scope === "half_term" ? "Half term" : "Full term");
    return parts.join(" ") || "Ticket";
  }

  /* ============================================================
   * 4. Pro-rata calculator (Term tickets).
   *
   * "enter the cost per single session and the system handles the
   *  maths" — a customer joining mid-term pays only for the remaining
   *  sessions. Returns the total for `remaining` of `total` dates.
   * ============================================================ */

  function termProRata(ticket, remainingSessions) {
    if (!ticket || ticket.type !== "term") return null;
    var per = num(ticket.costPerSession);
    var rem = num(remainingSessions);
    if (!isFinite(per) || per < 0) return null;
    if (!isFinite(rem) || rem < 0) return null;
    rem = Math.floor(rem);
    // Happity deactivates the term ticket when only one date remains, so
    // a term booking needs at least 2 remaining sessions to be valid.
    var bookable = rem >= 2;
    return {
      bookable: bookable,
      remaining: rem,
      total: Math.round(per * rem * 100) / 100
    };
  }

  /* ============================================================
   * 5. Block availability check.
   *
   * "Customers can only purchase block tickets if there are enough
   *  remaining CONSECUTIVE dates." remainingConsecutive is how many
   *  consecutive sessions are still on the schedule.
   * ============================================================ */

  function blockBookable(ticket, remainingConsecutive) {
    if (!ticket || ticket.type !== "block") return false;
    var need = num(ticket.sessions);
    var have = num(remainingConsecutive);
    if (!isFinite(need) || !isFinite(have)) return false;
    return have >= need;
  }

  /* ============================================================
   * 6. Sibling rule.
   *
   * "Sibling tickets can only be purchased alongside a full-price first
   *  child or adult ticket." Given the tickets in a basket, a sibling
   *  ticket is only valid if a non-trial first_child/adult is present.
   * ============================================================ */

  function siblingAllowed(basketTickets) {
    if (!Array.isArray(basketTickets)) return false;
    var hasSibling = basketTickets.some(function (t) { return t && t.tag === "sibling"; });
    if (!hasSibling) return true; // nothing to gate
    return basketTickets.some(function (t) {
      return t && !t.trial && (t.tag === "first_child" || t.tag === "adult");
    });
  }

  /* ============================================================
   * 7. Persisting wrappers — create+save, assign (reuse), update.
   * ============================================================ */

  // Create a ticket and store it in the library. Returns the result.
  function createAndSave(spec) {
    var res = createTicket(spec);
    if (!res.ok) return res;
    var lib = loadTickets();
    lib.unshift(res.ticket);
    saveTickets(lib);
    return res;
  }

  function getTicket(ticketId) {
    var lib = loadTickets();
    for (var i = 0; i < lib.length; i++) {
      if (lib[i] && lib[i].id === ticketId) return lib[i];
    }
    return null;
  }

  // REUSE: assign an existing ticket onto a class's price list. The
  // ticket is shared — the same ticket object now appears on multiple
  // classes. Idempotent: assigning twice is a no-op. Returns { ok }.
  function assignTicketToClass(ticketId, classId) {
    if (!ticketId || !classId) {
      return { ok: false, reason: "bad-args", message: "Need a ticket and a class." };
    }
    var lib = loadTickets();
    var ticket = null, i;
    for (i = 0; i < lib.length; i++) {
      if (lib[i] && lib[i].id === ticketId) { ticket = lib[i]; break; }
    }
    if (!ticket) return { ok: false, reason: "no-ticket", message: "That ticket no longer exists." };

    // Record on the ticket (reuse bookkeeping).
    if (!Array.isArray(ticket.assignedTo)) ticket.assignedTo = [];
    if (ticket.assignedTo.indexOf(classId) === -1) ticket.assignedTo.push(classId);
    saveTickets(lib);

    // Record on the class's price list.
    var lists = loadPriceLists();
    var arr = Array.isArray(lists[classId]) ? lists[classId] : [];
    if (arr.indexOf(ticketId) === -1) arr.push(ticketId);
    lists[classId] = arr;
    savePriceLists(lists);

    return { ok: true, ticketId: ticketId, classId: classId, assignedCount: ticket.assignedTo.length };
  }

  // Remove a ticket from one class's price list (un-tick). The ticket
  // itself survives (it may be reused elsewhere) — Happity's "inactive
  // prices" stay in the library.
  function unassignTicketFromClass(ticketId, classId) {
    var lib = loadTickets(), i;
    for (i = 0; i < lib.length; i++) {
      if (lib[i] && lib[i].id === ticketId && Array.isArray(lib[i].assignedTo)) {
        var idx = lib[i].assignedTo.indexOf(classId);
        if (idx !== -1) lib[i].assignedTo.splice(idx, 1);
      }
    }
    saveTickets(lib);
    var lists = loadPriceLists();
    if (Array.isArray(lists[classId])) {
      lists[classId] = lists[classId].filter(function (id) { return id !== ticketId; });
      savePriceLists(lists);
    }
    return { ok: true };
  }

  // Resolve a class's price list to full ticket objects.
  function priceListFor(classId) {
    var lists = loadPriceLists();
    var ids = Array.isArray(lists[classId]) ? lists[classId] : [];
    var lib = loadTickets();
    var byId = {};
    lib.forEach(function (t) { if (t && t.id) byId[t.id] = t; });
    var out = [];
    ids.forEach(function (id) { if (byId[id]) out.push(byId[id]); });
    return out;
  }

  // EDIT-IN-ONE-PLACE: update a ticket's price. Because the ticket is
  // shared, the change is reflected on every class it is assigned to —
  // this is the headline benefit of reuse in the article.
  function updateTicketCost(ticketId, newCost) {
    var cost = num(newCost);
    if (!isFinite(cost) || cost < 0) {
      return { ok: false, reason: "bad-cost", message: "Enter a valid cost (£0 or more)." };
    }
    var lib = loadTickets(), found = null;
    for (var i = 0; i < lib.length; i++) {
      if (lib[i] && lib[i].id === ticketId) {
        lib[i].cost = cost;
        if (lib[i].type === "term") lib[i].costPerSession = cost;
        found = lib[i];
      }
    }
    if (!found) return { ok: false, reason: "no-ticket", message: "That ticket no longer exists." };
    saveTickets(lib);
    return { ok: true, ticket: found, appliesTo: (found.assignedTo || []).slice() };
  }

  /* ============================================================
   * 8. Live-data — provider classes to assign tickets to, and a
   *    sensible default cost seeded from the planner price.
   * ============================================================ */

  function providerClasses() {
    var out = [];
    try {
      var providers = HC.data.providers || [];
      var byId = (HC.data.planner && HC.data.planner.byId) || {};
      for (var i = 0; i < providers.length; i++) {
        var p = providers[i];
        if (!p || !p.id) continue;
        var pl = byId[p.id] || {};
        var pr = pl.price || {};
        var dayCost = isFinite(Number(pr.day)) ? Number(pr.day)
          : (isFinite(Number(pr.week)) ? Math.round(Number(pr.week) / 5) : null);
        out.push({ id: p.id, name: p.name || p.id, suggestedDay: dayCost });
      }
    } catch (e) { /* defensive */ }
    return out;
  }

  /* ============================================================
   * 9. UI — the Price Wizard.
   *    Step 1: choose a class. Step 2: Create new (type -> details)
   *    OR Reuse (tick existing tickets onto this class).
   * ============================================================ */

  function esc(s) {
    return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
  function escAttr(s) { return esc(s).replace(/"/g, "&quot;"); }

  function ticketBadge(t) {
    var bits = [];
    bits.push(TYPE_LABEL[t.type] || t.type);
    if (t.trial) bits.push("Trial");
    if (t.tag && t.tag !== "first_child") bits.push(TAG_LABEL[t.tag] || t.tag);
    if (t.type === "block") bits.push("×" + t.sessions);
    if (t.type === "term") bits.push(t.scope === "half_term" ? "Half term" : "Full term");
    return bits.join(" · ");
  }

  function render(mountEl) {
    try {
      var classes = providerClasses();
      if (!classes.length) {
        classes = [{ id: "demo-camp", name: "Demo Summer Holiday Camp", suggestedDay: 36 }];
      }

      var classOpts = classes.map(function (c, i) {
        return '<option value="' + i + '">' + escAttr(c.name) + "</option>";
      }).join("");

      mountEl.innerHTML =
        '<div style="font-family:\'Nunito Sans\',system-ui,sans-serif;color:var(--text,#383838)">' +
          '<p style="font-size:14px;margin:0 0 14px">The <strong>Price Wizard</strong> creates ' +
          '<strong>Single</strong>, <strong>Block</strong> and <strong>Term</strong> tickets for your ' +
          'holiday camp — and lets you <strong>reuse</strong> a ticket across several camps so a price ' +
          'change updates everywhere at once.</p>' +

          // Class picker
          '<label style="display:block;font-weight:700;font-size:13px;margin-bottom:4px">Camp / class</label>' +
          '<select id="pwClass" style="width:100%;padding:9px;border:1.5px solid var(--line,#E6E6E6);border-radius:12px;font-size:14px;margin-bottom:14px">' +
            classOpts +
          "</select>" +

          // Mode tabs: Create new vs Reuse
          '<div style="display:flex;gap:8px;margin-bottom:14px">' +
            '<button id="pwTabCreate" type="button" class="hc-btn">＋ Create new</button>' +
            '<button id="pwTabReuse" type="button" class="hc-btn hc-btn-ghost">⟳ Reuse existing</button>' +
          "</div>" +

          // ---- CREATE panel ----
          '<div id="pwCreate">' +
            '<label style="display:block;font-weight:700;font-size:13px;margin-bottom:4px">Ticket type</label>' +
            '<select id="pwType" style="width:100%;padding:9px;border:1.5px solid var(--line,#E6E6E6);border-radius:12px;font-size:14px;margin-bottom:10px">' +
              '<option value="single">Single — PAYG drop-in / one-off day</option>' +
              '<option value="block">Block — set number of consecutive days</option>' +
              '<option value="term">Term — all remaining dates (auto pro-rata)</option>' +
            "</select>" +

            '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">' +
              '<div><label style="display:block;font-weight:700;font-size:13px;margin-bottom:4px">Ticket name</label>' +
                '<input id="pwName" type="text" placeholder="e.g. Full week" ' +
                'style="width:100%;padding:9px;border:1.5px solid var(--line,#E6E6E6);border-radius:12px;font-size:14px"></div>' +
              '<div><label id="pwCostLbl" style="display:block;font-weight:700;font-size:13px;margin-bottom:4px">Cost (£)</label>' +
                '<input id="pwCost" type="number" min="0" step="1" placeholder="36" ' +
                'style="width:100%;padding:9px;border:1.5px solid var(--line,#E6E6E6);border-radius:12px;font-size:14px"></div>' +
            "</div>" +

            // Block-only sessions
            '<div id="pwBlockRow" style="display:none;margin-top:10px">' +
              '<label style="display:block;font-weight:700;font-size:13px;margin-bottom:4px">Consecutive sessions in the block</label>' +
              '<input id="pwSessions" type="number" min="2" step="1" value="5" ' +
              'style="width:120px;padding:9px;border:1.5px solid var(--line,#E6E6E6);border-radius:12px;font-size:14px">' +
            "</div>" +

            // Term-only scope
            '<div id="pwTermRow" style="display:none;margin-top:10px">' +
              '<label style="display:block;font-weight:700;font-size:13px;margin-bottom:4px">Term scope</label>' +
              '<label style="font-size:13.5px;margin-right:14px"><input type="radio" name="pwScope" value="full_term" checked> Full term</label>' +
              '<label style="font-size:13.5px"><input type="radio" name="pwScope" value="half_term"> Half term</label>' +
              '<div style="font-size:12px;color:var(--muted,#808080);margin-top:4px">Cost above is the price ' +
                '<em>per single session</em> — the pro-rata calculator does the maths for mid-term joiners.</div>' +
            "</div>" +

            // Tag + Trial + Donations
            '<div style="display:flex;flex-wrap:wrap;gap:14px;align-items:center;margin-top:12px">' +
              '<div><label style="display:block;font-weight:700;font-size:13px;margin-bottom:4px">For</label>' +
                '<select id="pwTag" style="padding:8px;border:1.5px solid var(--line,#E6E6E6);border-radius:12px;font-size:13.5px">' +
                  '<option value="first_child">First child</option>' +
                  '<option value="sibling">Sibling (discount)</option>' +
                  '<option value="adult">Adult</option>' +
                "</select></div>" +
              '<label style="font-size:13.5px;margin-top:18px"><input id="pwTrial" type="checkbox"> Trial ticket</label>' +
              '<label style="font-size:13.5px;margin-top:18px"><input id="pwDonate" type="checkbox"> Donation at checkout</label>' +
            "</div>" +

            '<div style="margin-top:14px">' +
              '<button id="pwCreateBtn" type="button" class="hc-btn">Continue · add ticket</button>' +
            "</div>" +
            '<div id="pwCreateMsg" style="font-size:12.5px;min-height:16px;margin-top:8px;color:#2f7d4f"></div>' +
          "</div>" +

          // ---- REUSE panel ----
          '<div id="pwReuse" style="display:none">' +
            '<p style="font-size:13px;color:var(--muted,#808080);margin:0 0 8px">Tick existing tickets ' +
            'to apply them to this camp. The same ticket can sit on many camps — edit its price once and ' +
            'it updates everywhere.</p>' +
            '<div id="pwReuseList"></div>' +
          "</div>" +

          // ---- Current price list for the chosen class ----
          '<div style="margin-top:18px;border-top:1px solid var(--line,#E6E6E6);padding-top:12px">' +
            '<div style="font-family:\'Quicksand\',system-ui,sans-serif;font-weight:700;color:var(--purple,#603488);font-size:14px;margin-bottom:8px">' +
              'Price list for this camp</div>' +
            '<div id="pwList"></div>' +
          "</div>" +
        "</div>";

      var $ = function (id) { return mountEl.querySelector("#" + id); };

      function currentClass() {
        var idx = Math.max(0, parseInt($("pwClass").value, 10) || 0);
        return classes[idx] || classes[0];
      }

      function syncTypeRows() {
        var t = $("pwType").value;
        $("pwBlockRow").style.display = (t === "block") ? "block" : "none";
        $("pwTermRow").style.display = (t === "term") ? "block" : "none";
        $("pwCostLbl").textContent = (t === "term") ? "Cost per session (£)" : "Cost (£)";
      }

      function seedCost() {
        var c = currentClass();
        if (c && isFinite(Number(c.suggestedDay)) && !$("pwCost").value) {
          $("pwCost").value = Number(c.suggestedDay);
        }
      }

      function scopeValue() {
        var checked = mountEl.querySelector('input[name="pwScope"]:checked');
        return checked ? checked.value : "full_term";
      }

      function paintList() {
        var c = currentClass();
        var tickets = priceListFor(c.id);
        var host = $("pwList");
        if (!tickets.length) {
          host.innerHTML = '<p style="font-size:13px;color:var(--muted,#808080);margin:0">' +
            'No tickets on this camp yet. Create one above, or reuse an existing ticket.</p>';
          return;
        }
        host.innerHTML = tickets.map(function (t) {
          var reuseNote = (t.assignedTo && t.assignedTo.length > 1)
            ? ' · <span style="color:var(--magenta,#F82488)">shared with ' + (t.assignedTo.length - 1) + ' other camp' + (t.assignedTo.length - 1 === 1 ? "" : "s") + '</span>'
            : "";
          return '<div style="display:flex;align-items:center;gap:10px;border:1.5px solid var(--line,#E6E6E6);' +
              'border-radius:12px;padding:10px 12px;margin-bottom:8px">' +
            '<div style="flex:1;min-width:0">' +
              '<div style="font-family:\'Quicksand\',system-ui,sans-serif;font-weight:700;color:var(--purple,#603488);font-size:14px">' +
                esc(t.name) + ' — ' + esc(HC.util.money(t.cost)) + (t.type === "term" ? "/session" : "") + "</div>" +
              '<div style="font-size:12px;color:var(--muted,#808080);margin-top:2px">' + esc(ticketBadge(t)) + reuseNote + "</div>" +
            "</div>" +
            '<button type="button" class="hc-btn hc-btn-ghost" data-pw-remove="' + escAttr(t.id) + '" ' +
              'style="padding:5px 11px;font-size:11px">Remove</button>' +
          "</div>";
        }).join("");
      }

      function paintReuse() {
        var c = currentClass();
        var assigned = {};
        priceListFor(c.id).forEach(function (t) { assigned[t.id] = true; });
        var lib = loadTickets();
        var host = $("pwReuseList");
        if (!lib.length) {
          host.innerHTML = '<p style="font-size:13px;color:var(--muted,#808080);margin:0">' +
            'No tickets in your library yet — create one first, then it can be reused.</p>';
          return;
        }
        host.innerHTML = lib.map(function (t) {
          var on = !!assigned[t.id];
          return '<label style="display:flex;align-items:center;gap:10px;border:1.5px solid ' +
              (on ? "var(--magenta,#F82488)" : "var(--line,#E6E6E6)") + ';border-radius:12px;' +
              'padding:9px 12px;margin-bottom:8px;cursor:pointer">' +
            '<input type="checkbox" data-pw-reuse="' + escAttr(t.id) + '"' + (on ? " checked" : "") + ">" +
            '<span style="flex:1;min-width:0">' +
              '<span style="font-family:\'Quicksand\',system-ui,sans-serif;font-weight:700;color:var(--purple,#603488);font-size:14px">' +
                esc(t.name) + ' — ' + esc(HC.util.money(t.cost)) + "</span>" +
              '<span style="display:block;font-size:12px;color:var(--muted,#808080)">' + esc(ticketBadge(t)) +
                (t.assignedTo && t.assignedTo.length ? ' · on ' + t.assignedTo.length + ' camp' + (t.assignedTo.length === 1 ? "" : "s") : "") + "</span>" +
            "</span>" +
          "</label>";
        }).join("");
      }

      function showMode(mode) {
        var creating = mode === "create";
        $("pwCreate").style.display = creating ? "block" : "none";
        $("pwReuse").style.display = creating ? "none" : "block";
        $("pwTabCreate").className = creating ? "hc-btn" : "hc-btn hc-btn-ghost";
        $("pwTabReuse").className = creating ? "hc-btn hc-btn-ghost" : "hc-btn";
        if (!creating) paintReuse();
      }

      // Events
      $("pwType").addEventListener("change", syncTypeRows);
      $("pwClass").addEventListener("change", function () { paintList(); paintReuse(); });
      $("pwTabCreate").addEventListener("click", function () { showMode("create"); });
      $("pwTabReuse").addEventListener("click", function () { showMode("reuse"); });

      $("pwCreateBtn").addEventListener("click", function () {
        var c = currentClass();
        var spec = {
          type: $("pwType").value,
          name: $("pwName").value,
          cost: $("pwCost").value,
          tag: $("pwTag").value,
          trial: $("pwTrial").checked,
          donations: $("pwDonate").checked,
          sessions: $("pwSessions").value,
          scope: scopeValue()
        };
        var res = createAndSave(spec);
        var m = $("pwCreateMsg");
        if (!res.ok) {
          m.style.color = "#9a1f5e";
          m.textContent = res.message || "Could not create that ticket.";
          return;
        }
        // New tickets are assigned to the current class straight away.
        assignTicketToClass(res.ticket.id, c.id);
        m.style.color = "#2f7d4f";
        m.textContent = "Added “" + res.ticket.name + "” to " + c.name + ".";
        $("pwName").value = "";
        try { HC.util.toast("Ticket created and added"); } catch (e) {}
        paintList();
      });

      // Delegated: reuse checkboxes + remove buttons.
      mountEl.addEventListener("change", function (e) {
        var box = e.target.closest("[data-pw-reuse]");
        if (!box) return;
        var c = currentClass();
        var id = box.getAttribute("data-pw-reuse");
        if (box.checked) assignTicketToClass(id, c.id);
        else unassignTicketFromClass(id, c.id);
        paintList();
        try { HC.util.toast(box.checked ? "Ticket reused on this camp" : "Removed from this camp"); } catch (er) {}
      });
      mountEl.addEventListener("click", function (e) {
        var rm = e.target.closest("[data-pw-remove]");
        if (!rm) return;
        var c = currentClass();
        unassignTicketFromClass(rm.getAttribute("data-pw-remove"), c.id);
        paintList();
        if ($("pwReuse").style.display !== "none") paintReuse();
      });

      syncTypeRows();
      seedCost();
      showMode("create");
      paintList();
    } catch (e) {
      mountEl.innerHTML = '<p style="color:#9a1f5e">Price Wizard failed to load: ' +
        esc(e && e.message ? e.message : String(e)) + "</p>";
    }
  }

  /* ============================================================
   * 10. selfTest — exercises the LOGIC and asserts the acceptance
   *     criterion across multiple cases.
   * ============================================================ */

  function selfTest() {
    var pass = 0, fail = 0, log = [];
    function check(label, fn) {
      try { fn(); pass += 1; log.push("✓ " + label); }
      catch (e) { fail += 1; log.push("✗ " + label + " — " + (e && e.message ? e.message : String(e))); }
    }

    // ---- ACCEPTANCE PART A: creates Single / Block / Term tickets. ----

    check("Creates a SINGLE ticket (PAYG drop-in)", function () {
      var r = createTicket({ type: "single", name: "Drop-in day", cost: 38 });
      HC.assert(r.ok === true, "single should be created");
      HC.assert(r.ticket.type === "single", "type should be 'single'");
      HC.assert(r.ticket.cost === 38, "cost should be 38, got " + r.ticket.cost);
      HC.assert(r.ticket.tag === "first_child", "default tag should be first_child");
      HC.assert(Array.isArray(r.ticket.assignedTo) && r.ticket.assignedTo.length === 0,
        "a fresh ticket is assigned to no classes yet");
    });

    check("Creates a BLOCK ticket with a whole number of consecutive sessions", function () {
      var r = createTicket({ type: "block", name: "Full week (5 days)", cost: 160, sessions: 5 });
      HC.assert(r.ok === true, "block should be created");
      HC.assert(r.ticket.type === "block", "type should be 'block'");
      HC.assert(r.ticket.sessions === 5, "sessions should be 5, got " + r.ticket.sessions);
    });

    check("Creates a TERM ticket with full/half scope and pro-rata flag", function () {
      var full = createTicket({ type: "term", name: "Whole summer", cost: 18, scope: "full_term" });
      HC.assert(full.ok === true, "full-term should be created");
      HC.assert(full.ticket.type === "term", "type should be 'term'");
      HC.assert(full.ticket.scope === "full_term", "scope should be full_term, got " + full.ticket.scope);
      HC.assert(full.ticket.proRata === true, "term tickets carry the pro-rata calculator");
      HC.assert(full.ticket.costPerSession === 18, "term cost is the per-session cost");

      var half = createTicket({ type: "term", cost: 18, scope: "half_term" });
      HC.assert(half.ticket.scope === "half_term", "half-term scope should be honoured");
    });

    // ---- Trial + Sibling + Adult tags can apply to the types. ----

    check("Trial flag can be applied to any ticket type", function () {
      var s = createTicket({ type: "single", cost: 10, trial: true });
      var b = createTicket({ type: "block", cost: 50, sessions: 3, trial: true });
      var t = createTicket({ type: "term", cost: 12, trial: true });
      HC.assert(s.ticket.trial && b.ticket.trial && t.ticket.trial, "all three should be trial tickets");
    });

    check("Sibling and Adult tags are supported (sibling is the discounted one)", function () {
      var sib = createTicket({ type: "single", cost: 28, tag: "sibling" });
      var ad = createTicket({ type: "single", cost: 0, tag: "adult" });
      HC.assert(sib.ticket.tag === "sibling", "sibling tag should be set");
      HC.assert(ad.ticket.tag === "adult", "adult tag should be set");
    });

    check("Default names are generated when none is given", function () {
      var b = createTicket({ type: "block", cost: 90, sessions: 3 });
      HC.assert(/Block of 3/.test(b.ticket.name), "default block name should mention 'Block of 3', got " + b.ticket.name);
      var trialSib = createTicket({ type: "single", cost: 8, trial: true, tag: "sibling" });
      HC.assert(/Trial/.test(trialSib.ticket.name) && /Sibling/.test(trialSib.ticket.name),
        "default name should reflect trial + sibling, got " + trialSib.ticket.name);
    });

    // ---- Validation: bad specs are rejected, not thrown. ----

    check("Invalid type / cost / block-sessions are rejected (not thrown)", function () {
      HC.assert(createTicket({ type: "weekly", cost: 5 }).ok === false, "bad type should be rejected");
      HC.assert(createTicket({ type: "single", cost: -1 }).ok === false, "negative cost should be rejected");
      HC.assert(createTicket({ type: "single", cost: "abc" }).ok === false, "non-numeric cost should be rejected");
      HC.assert(createTicket({ type: "block", cost: 50, sessions: 1 }).ok === false, "block of 1 should be rejected");
      HC.assert(createTicket({ type: "block", cost: 50, sessions: 2.5 }).ok === false, "fractional sessions rejected");
      // A free single ticket (£0) IS allowed.
      HC.assert(createTicket({ type: "single", cost: 0 }).ok === true, "a £0 ticket should be allowed");
    });

    // ---- Term pro-rata calculator. ----

    check("Term pro-rata calculator charges only for remaining sessions", function () {
      var t = createTicket({ type: "term", cost: 18 }).ticket;
      var r = termProRata(t, 4);
      HC.assert(r.bookable === true, "4 remaining sessions should be bookable");
      HC.assert(r.total === 72, "4 × £18 should be £72, got " + r.total);
      // Happity deactivates the term ticket when only one date remains.
      var one = termProRata(t, 1);
      HC.assert(one.bookable === false, "1 remaining session must NOT be bookable as a term ticket");
    });

    // ---- Block availability (enough consecutive dates). ----

    check("Block is only bookable with enough remaining consecutive dates", function () {
      var b = createTicket({ type: "block", cost: 160, sessions: 6 }).ticket;
      HC.assert(blockBookable(b, 6) === true, "6 consecutive of 6 needed should be bookable");
      HC.assert(blockBookable(b, 4) === false, "only 4 consecutive should NOT satisfy a block of 6");
    });

    // ---- Sibling rule (needs a full-price first-child / adult in basket). ----

    check("Sibling ticket needs a full-price first-child/adult in the basket", function () {
      var sib = createTicket({ type: "single", cost: 25, tag: "sibling" }).ticket;
      var firstChild = createTicket({ type: "single", cost: 38, tag: "first_child" }).ticket;
      var trialFirst = createTicket({ type: "single", cost: 5, tag: "first_child", trial: true }).ticket;
      HC.assert(siblingAllowed([sib]) === false, "sibling alone should not be allowed");
      HC.assert(siblingAllowed([sib, firstChild]) === true, "sibling + full-price first child should be allowed");
      HC.assert(siblingAllowed([sib, trialFirst]) === false, "a trial first-child is not full-price, so sibling still blocked");
      HC.assert(siblingAllowed([firstChild]) === true, "no sibling in basket is fine");
    });

    // ---- ACCEPTANCE PART B: REUSE an existing price across classes. ----

    check("Reuse: one ticket assigned across MULTIPLE classes (acceptance)", function () {
      var beforeT = loadTickets(), beforeP = loadPriceLists();
      saveTickets([]); savePriceLists({});
      try {
        // Create one "Full week" ticket in the library.
        var made = createAndSave({ type: "block", name: "Full week", cost: 160, sessions: 5 });
        HC.assert(made.ok === true, "ticket should be created and saved");
        var id = made.ticket.id;

        // Reuse the SAME ticket on three different camps.
        var a = assignTicketToClass(id, "camp-alpha");
        var b = assignTicketToClass(id, "camp-beta");
        var c = assignTicketToClass(id, "camp-gamma");
        HC.assert(a.ok && b.ok && c.ok, "all three assignments should succeed");

        // Each class's price list now contains that one ticket.
        HC.assert(priceListFor("camp-alpha").length === 1, "alpha should have the ticket");
        HC.assert(priceListFor("camp-beta")[0].id === id, "beta should reference the SAME ticket id");
        HC.assert(priceListFor("camp-gamma")[0].id === id, "gamma should reference the SAME ticket id");

        // The ticket itself records all three assignments (true reuse).
        var shared = getTicket(id);
        HC.assert(shared.assignedTo.length === 3, "ticket should be assigned to 3 classes, got " + shared.assignedTo.length);

        // Idempotent: re-assigning to a class it's already on is a no-op.
        assignTicketToClass(id, "camp-alpha");
        HC.assert(getTicket(id).assignedTo.length === 3, "re-assigning should not duplicate");
        HC.assert(priceListFor("camp-alpha").length === 1, "alpha price list should not gain a duplicate");
      } finally {
        saveTickets(beforeT); savePriceLists(beforeP);
      }
    });

    check("Reuse: editing the shared ticket's price updates EVERY class at once", function () {
      var beforeT = loadTickets(), beforeP = loadPriceLists();
      saveTickets([]); savePriceLists({});
      try {
        var made = createAndSave({ type: "single", name: "Day place", cost: 36 });
        var id = made.ticket.id;
        assignTicketToClass(id, "camp-one");
        assignTicketToClass(id, "camp-two");

        // Edit in one place...
        var upd = updateTicketCost(id, 40);
        HC.assert(upd.ok === true, "price update should succeed");
        HC.assert(upd.appliesTo.length === 2, "update should report it applies to 2 classes");

        // ...and both classes see the new price (same shared object).
        HC.assert(priceListFor("camp-one")[0].cost === 40, "camp-one should see £40");
        HC.assert(priceListFor("camp-two")[0].cost === 40, "camp-two should see £40");

        // A bad price is rejected, not applied.
        var bad = updateTicketCost(id, -5);
        HC.assert(bad.ok === false, "negative price update should be rejected");
        HC.assert(priceListFor("camp-one")[0].cost === 40, "price should be unchanged after a rejected update");
      } finally {
        saveTickets(beforeT); savePriceLists(beforeP);
      }
    });

    check("Reuse: un-ticking a ticket removes it from ONE class but keeps it for others", function () {
      var beforeT = loadTickets(), beforeP = loadPriceLists();
      saveTickets([]); savePriceLists({});
      try {
        var made = createAndSave({ type: "term", name: "Term place", cost: 15 });
        var id = made.ticket.id;
        assignTicketToClass(id, "camp-x");
        assignTicketToClass(id, "camp-y");

        unassignTicketFromClass(id, "camp-x");
        HC.assert(priceListFor("camp-x").length === 0, "camp-x should no longer have the ticket");
        HC.assert(priceListFor("camp-y").length === 1, "camp-y should still have the ticket");
        // The ticket survives in the library (Happity's 'inactive prices').
        HC.assert(getTicket(id) !== null, "ticket should remain in the library for future reuse");
        HC.assert(getTicket(id).assignedTo.indexOf("camp-x") === -1, "assignment record should drop camp-x");
      } finally {
        saveTickets(beforeT); savePriceLists(beforeP);
      }
    });

    // ---- Defensive reuse-API edge cases. ----

    check("Assigning a non-existent ticket / bad args is rejected (not thrown)", function () {
      HC.assert(assignTicketToClass("nope", "camp-z").ok === false, "unknown ticket should be rejected");
      HC.assert(assignTicketToClass("", "camp-z").ok === false, "missing ticket id should be rejected");
      HC.assert(assignTicketToClass("tkt", "").ok === false, "missing class id should be rejected");
    });

    // ---- Persistence sanity: createAndSave writes via HC.store. ----

    check("createAndSave persists the ticket into the HC.store library", function () {
      var beforeT = loadTickets();
      saveTickets([]);
      try {
        var r = createAndSave({ type: "single", name: "Persist me", cost: 22 });
        HC.assert(r.ok === true, "create-and-save should succeed");
        var lib = loadTickets();
        HC.assert(lib.length === 1, "exactly one ticket should be stored, got " + lib.length);
        HC.assert(lib[0].id === r.ticket.id, "stored ticket should be the one returned");
      } finally {
        saveTickets(beforeT);
      }
    });

    // ---- Live-data sanity: real provider classes can take reused tickets. ----

    check("A real provider class from HC.data can have a reused ticket assigned", function () {
      var classes = providerClasses();
      HC.assert(classes.length >= 1, "expected >=1 provider class from HC.data, got " + classes.length);
      var beforeT = loadTickets(), beforeP = loadPriceLists();
      saveTickets([]); savePriceLists({});
      try {
        var made = createAndSave({ type: "single", name: "Live day place", cost: 35 });
        var res = assignTicketToClass(made.ticket.id, classes[0].id);
        HC.assert(res.ok === true, "assigning to a live class should succeed");
        HC.assert(priceListFor(classes[0].id).length === 1, "the live class should now have one ticket");
      } finally {
        saveTickets(beforeT); savePriceLists(beforeP);
      }
    });

    return { pass: pass, fail: fail, log: log };
  }

  /* ============================================================
   * 11. Register (idempotent + defensive via core).
   * ============================================================ */
  HC.registerFeature({
    id: "provider-price-wizard",
    title: "Price Wizard — tickets & prices",
    side: "provider",
    icon: "🎟️",
    summary: "Create Single, Block and Term tickets for your holiday camp — with Trial, Sibling and Adult variants and an automatic pro-rata calculator for term places. Reuse a ticket across several camps so a price change updates everywhere at once.",
    render: render,
    selfTest: selfTest
  });
})();
