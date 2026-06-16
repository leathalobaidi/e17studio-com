/* HolidayCamp feature — provider-donations-setup
 *
 * Enable donations / pay-as-you-want  (PROVIDER side)
 *
 * Replicates Happity's "donations / pay as you want" SET-UP, which lives in the
 * provider's Pricing Wizard. Evidence (support article 6135640,
 * "How to use our donations/pay as you want feature."):
 *   - "This will then open your Pricing Wizard where you create all your tickets
 *      and can turn on the donations feature."
 *   - "It is important to note that to use the donations feature, you will still
 *      need regular ticket types in place. If you would like the customer to pay
 *      only their donation amount you can create a £0 ticket."
 *   - "Once these have been created you can then simply turn on your donations
 *      feature."
 *   - "When the customer gets to the checkout process, this is where they will
 *      be asked how much they would like to donate. It is important to note that
 *      all regular booking fees still apply to the donation amount and will be
 *      processed via Stripe."
 *
 * Framed for SCHOOL-AGE HOLIDAY CAMPS (not baby classes). A camp provider sets
 * up regular tickets for a holiday camp (e.g. "Full day £36", "Half day £22",
 * or a "£0 community place"), then flips ONE toggle to enable donations. With
 * the toggle ON, the parent's checkout gains a donation prompt that sits ATOP
 * the base ticket they chose.
 *
 * This is the PROVIDER-SIDE counterpart to parent-donation.js (which models the
 * parent's checkout maths). Here we model the SET-UP: the ticket list, the
 * donations toggle, optional suggested amounts and a minimum, plus the gate that
 * Happity enforces (you cannot enable donations with no regular ticket in
 * place). The output is the CHECKOUT CONFIG a parent would then see.
 *
 * ACCEPTANCE CRITERION (asserted in selfTest):
 *   Turning on donations adds a donation prompt at checkout atop a base ticket.
 *   We verify: with the toggle OFF, a built checkout config for a base ticket
 *   has NO donation prompt; with the toggle ON, the SAME base ticket's checkout
 *   config gains a donation prompt (donationPrompt.enabled === true) that is
 *   layered on top of the unchanged base ticket line. We also verify the Happity
 *   gate (no enabling donations without a regular ticket) and the £0-ticket case
 *   (donation becomes the whole payment).
 *
 * Self-contained, defensive, no imports/exports. Calls HC.registerFeature.
 */
(function () {
  "use strict";

  // Defensive: never throw at module load if HC isn't present.
  if (typeof window === "undefined" || !window.HC || typeof window.HC.registerFeature !== "function") {
    if (typeof console !== "undefined" && console.warn) {
      console.warn("[HC] provider-donations-setup: HC core not found; skipping registration.");
    }
    return;
  }

  var HC = window.HC;

  // Persisted shape, keyed by providerId:
  //   { <pid>: { tickets:[{id,label,price}], donations:{enabled,suggested:[..],min,prompt} } }
  var STORE_KEY = "provider_donations_setup";

  // Booking-fee model — mirrors the Stripe-style fee Happity says "still applies
  // to the donation amount". Percentage + fixed, applied to (ticket + donation).
  var FEE = { pct: 0.05, fixed: 0.20 };

  /* ===================================================================
     SMALL HELPERS
     =================================================================== */

  function asText(v) {
    return typeof v === "string" ? v : (v == null ? "" : String(v));
  }

  function round2(n) {
    var num = Number(n);
    if (!isFinite(num)) return 0;
    return Math.round((num + Number.EPSILON) * 100) / 100;
  }

  // Clamp an arbitrary money input to a valid, non-negative number (0 allowed —
  // a £0 community place is a legitimate Happity ticket).
  function normaliseMoney(raw) {
    var n = Number(raw);
    if (!isFinite(n) || n < 0) return 0;
    return round2(n);
  }

  function money(v) {
    try { return HC.util.money(v); }
    catch (e) {
      var n = Number(v);
      if (!isFinite(n)) return "£0";
      return "£" + (Number.isInteger(n) ? n : n.toFixed(2));
    }
  }

  function safeUid(prefix) {
    try { return HC.util.uid(); }
    catch (e) { return (prefix || "id") + "_" + Date.now() + "_" + Math.floor(Math.random() * 1e6); }
  }

  // Parse a "£36" / "GBP 36 per day" style live price string into a number.
  // Returns null when there is no number (e.g. "Check live site").
  function parsePrice(str) {
    if (typeof str !== "string") return null;
    if (/free/i.test(str) && !/[0-9]/.test(str)) return 0;
    var m = str.match(/(?:£|GBP|gbp)\s*([0-9]+(?:\.[0-9]{1,2})?)/);
    if (m) return round2(parseFloat(m[1]));
    var any = str.match(/([0-9]+(?:\.[0-9]{1,2})?)/);
    return any ? round2(parseFloat(any[1])) : null;
  }

  /* ===================================================================
     PURE LOGIC (testable, DOM-free) — the heart of the feature
     =================================================================== */

  // A regular ticket. `price` may be 0 (the Happity "£0 ticket" so the customer
  // "can pay only their donation amount").
  function makeTicket(label, price) {
    return {
      id: safeUid("tkt"),
      label: asText(label).trim() || "Ticket",
      price: normaliseMoney(price)
    };
  }

  // Default donations config (OFF until the provider turns it on).
  function defaultDonations() {
    return {
      enabled: false,
      // Suggested quick-pick amounts the checkout can surface (provider hint).
      suggested: [2, 5, 10],
      // Minimum donation a parent may enter (0 = donation is fully optional).
      min: 0,
      // The prompt text the parent sees at checkout.
      prompt: "Would you like to add a donation to support the camp?"
    };
  }

  // Normalise a raw donations-config object (defensive against junk).
  function normaliseDonations(raw) {
    var d = defaultDonations();
    if (!raw || typeof raw !== "object") return d;
    d.enabled = raw.enabled === true;
    if (Array.isArray(raw.suggested)) {
      var clean = [];
      for (var i = 0; i < raw.suggested.length; i++) {
        var n = normaliseMoney(raw.suggested[i]);
        if (n > 0 && clean.indexOf(n) === -1) clean.push(n);
      }
      clean.sort(function (a, b) { return a - b; });
      d.suggested = clean.length ? clean : defaultDonations().suggested;
    }
    d.min = normaliseMoney(raw.min);
    if (typeof raw.prompt === "string" && raw.prompt.trim()) d.prompt = raw.prompt.trim();
    return d;
  }

  // THE HAPPITY GATE: "to use the donations feature, you will still need regular
  // ticket types in place." Returns whether donations CAN be enabled, with a
  // reason when they cannot.
  function canEnableDonations(tickets) {
    var list = Array.isArray(tickets) ? tickets : [];
    var hasTicket = list.some(function (t) { return t && typeof t === "object"; });
    if (!hasTicket) {
      return {
        ok: false,
        code: "no_ticket",
        reason: "You need at least one regular ticket in place before you can turn on donations. " +
          "Tip: add a £0 ticket if you want parents to pay by donation only."
      };
    }
    return { ok: true };
  }

  // Apply a desired toggle state to a config. Refuses to turn donations ON when
  // the Happity gate is not met — nothing changes in that case.
  //   returns { ok, config?, code?, reason? }
  function setDonationsEnabled(config, wantOn) {
    var cfg = normaliseConfig(config);
    if (wantOn === true) {
      var gate = canEnableDonations(cfg.tickets);
      if (!gate.ok) return { ok: false, code: gate.code, reason: gate.reason };
    }
    cfg.donations.enabled = wantOn === true;
    return { ok: true, config: cfg };
  }

  // Normalise a whole setup config { tickets:[...], donations:{...} }.
  function normaliseConfig(raw) {
    var cfg = { tickets: [], donations: defaultDonations() };
    if (raw && typeof raw === "object") {
      if (Array.isArray(raw.tickets)) {
        for (var i = 0; i < raw.tickets.length; i++) {
          var t = raw.tickets[i];
          if (t && typeof t === "object") {
            cfg.tickets.push({
              id: asText(t.id) || safeUid("tkt"),
              label: asText(t.label).trim() || "Ticket",
              price: normaliseMoney(t.price)
            });
          }
        }
      }
      cfg.donations = normaliseDonations(raw.donations);
    }
    // Enforce the gate even on load: donations can't be ON without a ticket.
    if (cfg.donations.enabled && !canEnableDonations(cfg.tickets).ok) {
      cfg.donations.enabled = false;
    }
    return cfg;
  }

  // CORE / ACCEPTANCE: build the CHECKOUT CONFIG a parent would see for a chosen
  // base ticket, given the provider's setup. This is where the acceptance
  // criterion is proven:
  //
  //   - The checkout always carries the chosen base ticket line (label + price).
  //   - donationPrompt.enabled mirrors the provider's toggle: OFF -> no prompt;
  //     ON  -> a donation prompt is added ATOP the base ticket.
  //   - When the prompt is enabled it carries suggested amounts, a minimum, and
  //     the prompt text — and the base ticket line is unchanged (donation is
  //     additive, never a replacement of the ticket).
  //
  // `donation` (optional) lets a caller preview a chosen donation amount so the
  // totals reflect "fees still apply to the donation amount".
  function buildCheckout(config, ticketId, donation) {
    var cfg = normaliseConfig(config);

    // Resolve the base ticket the parent selected (default: the first ticket).
    var base = null;
    for (var i = 0; i < cfg.tickets.length; i++) {
      if (cfg.tickets[i].id === ticketId) { base = cfg.tickets[i]; break; }
    }
    if (!base && cfg.tickets.length) base = cfg.tickets[0];

    var baseLine = base
      ? { id: base.id, label: base.label, price: round2(base.price) }
      : { id: null, label: "No ticket", price: 0 };

    var donationsOn = cfg.donations.enabled === true && cfg.tickets.length > 0;

    // The donation prompt is ONLY present when the provider turned donations on.
    var donationPrompt = donationsOn
      ? {
          enabled: true,
          prompt: cfg.donations.prompt,
          suggested: cfg.donations.suggested.slice(),
          min: cfg.donations.min,
          // "atop the base ticket": the prompt is layered over, not instead of.
          atopTicketId: baseLine.id
        }
      : { enabled: false };

    // Optional preview of a chosen donation amount + fee maths.
    var chosen = donationsOn ? normaliseMoney(donation) : 0;
    if (donationsOn && chosen > 0 && cfg.donations.min > 0 && chosen < cfg.donations.min) {
      // honour the minimum if the parent picked a smaller (non-zero) amount
      chosen = cfg.donations.min;
    }
    var subtotal = round2(baseLine.price + chosen);
    var fee = subtotal > 0 ? round2(subtotal * FEE.pct + FEE.fixed) : 0;
    var total = round2(subtotal + fee);

    return {
      baseTicket: baseLine,
      donationPrompt: donationPrompt,
      // explicit, test-friendly acceptance flags:
      donationOfferedAtCheckout: donationPrompt.enabled === true,
      donationIsAtopTicket: donationPrompt.enabled === true && baseLine.id !== null,
      // £0 ticket => a chosen donation becomes the whole payment
      donationAsPayment: donationPrompt.enabled === true && baseLine.price === 0 && chosen > 0,
      // preview line:
      preview: {
        ticket: baseLine.price,
        donation: chosen,
        subtotal: subtotal,
        fee: fee,
        total: total,
        feesAppliedToDonation: donationsOn && chosen > 0 && fee > 0
      }
    };
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
    if (!map[pid] || typeof map[pid] !== "object") {
      map[pid] = { tickets: [], donations: defaultDonations() };
    }
    var norm = normaliseConfig(map[pid]);
    map[pid] = norm;
    return map[pid];
  }

  function getConfig(providerId) {
    var map = readAll();
    return normaliseConfig(providerBucket(map, providerId));
  }
  function saveConfig(providerId, cfg) {
    var map = readAll();
    var pid = asText(providerId) || "_default";
    map[pid] = normaliseConfig(cfg);
    writeAll(map);
    return map[pid];
  }

  function addTicket(providerId, label, price) {
    var cfg = getConfig(providerId);
    cfg.tickets.push(makeTicket(label, price));
    return saveConfig(providerId, cfg);
  }
  function removeTicket(providerId, ticketId) {
    var cfg = getConfig(providerId);
    cfg.tickets = cfg.tickets.filter(function (t) { return t.id !== ticketId; });
    // Removing the last ticket also auto-disables donations (gate enforced).
    if (!cfg.tickets.length) cfg.donations.enabled = false;
    return saveConfig(providerId, cfg);
  }
  // Toggle donations with the Happity gate enforced. Returns { ok, config?, reason? }.
  function toggleDonations(providerId, wantOn) {
    var cfg = getConfig(providerId);
    var res = setDonationsEnabled(cfg, wantOn);
    if (!res.ok) return res;
    saveConfig(providerId, res.config);
    return { ok: true, config: res.config };
  }
  function setSuggested(providerId, arr) {
    var cfg = getConfig(providerId);
    cfg.donations = normaliseDonations({
      enabled: cfg.donations.enabled,
      suggested: arr,
      min: cfg.donations.min,
      prompt: cfg.donations.prompt
    });
    return saveConfig(providerId, cfg);
  }
  function setMin(providerId, min) {
    var cfg = getConfig(providerId);
    cfg.donations.min = normaliseMoney(min);
    return saveConfig(providerId, cfg);
  }
  function clearProvider(providerId) {
    var map = readAll();
    var pid = asText(providerId) || "_default";
    delete map[pid];
    writeAll(map);
  }

  /* ===================================================================
     LIVE-DATA HELPERS (sensible demo defaults from camp data)
     =================================================================== */

  function demoProviderId() {
    try {
      var ps = HC.data.providers;
      if (ps && ps.length && ps[0] && ps[0].id) return ps[0].id;
    } catch (e) {}
    return "_demo_donations_provider";
  }

  // Seed a believable holiday-camp ticket list from live data: a real day rate
  // if we can find one, plus a half-day and a £0 community place.
  function demoTickets() {
    var dayRate = 36;
    try {
      var ps = HC.data.providers || [];
      for (var i = 0; i < ps.length; i++) {
        var price = parsePrice(ps[i] && ps[i].price);
        if (price !== null && price > 0) { dayRate = price; break; }
      }
    } catch (e) {}
    return [
      makeTicket("Full day", dayRate),
      makeTicket("Half day", round2(dayRate * 0.6)),
      makeTicket("£0 community place", 0)
    ];
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

  function ticketsHtml(cfg) {
    if (!cfg.tickets.length) {
      return '<li style="color:var(--muted,#808080);list-style:none;margin-left:-20px">' +
        "No tickets yet — add one to unlock donations.</li>";
    }
    return cfg.tickets.map(function (t) {
      var free = t.price === 0;
      return '<li style="margin:0 0 8px" data-tkt="' + escAttr(t.id) + '">' +
        '<strong>' + esc(t.label) + "</strong> — " +
        (free ? '<span style="color:#2f7d4f">' + money(0) + " (pay by donation only)</span>" : money(t.price)) +
        ' <button class="hc-btn hc-btn-ghost" type="button" data-del-tkt="' + escAttr(t.id) +
          '" style="margin-left:6px;padding:2px 8px;font-size:11px">Remove</button>' +
      "</li>";
    }).join("");
  }

  function checkoutPreviewHtml(cfg) {
    var base = cfg.tickets[0];
    var co = buildCheckout(cfg, base ? base.id : null, 0);
    var lines = '<div style="font-size:13px;color:var(--text,#383838)">' +
      "<div>🎟️ <strong>" + esc(co.baseTicket.label) + "</strong> — " + money(co.baseTicket.price) + "</div>";
    if (co.donationPrompt.enabled) {
      lines += '<div style="margin-top:6px;padding:8px 10px;border:1.5px dashed var(--magenta,#F82488);' +
        'border-radius:10px;background:#FEF2F8">' +
        "💝 <strong>" + esc(co.donationPrompt.prompt) + "</strong><br>" +
        '<span style="font-size:12px;color:var(--muted,#808080)">Suggested: ' +
          co.donationPrompt.suggested.map(function (a) { return money(a); }).join(" · ") +
          (co.donationPrompt.min > 0 ? "  ·  min " + money(co.donationPrompt.min) : "  ·  optional") +
        "</span></div>" +
        '<div style="font-size:11.5px;color:var(--muted,#808080);margin-top:4px">' +
          "Added <em>atop</em> the base ticket. Booking fees still apply to the donation amount.</div>";
    } else {
      lines += '<div style="margin-top:6px;font-size:12px;color:var(--muted,#808080)">' +
        "Donations are off — checkout shows the ticket only, no donation prompt.</div>";
    }
    lines += "</div>";
    return lines;
  }

  function render(mountEl) {
    try {
      if (!mountEl) return;
      var providerId = demoProviderId();

      // Seed a demo setup the first time so the preview is live.
      var seeded = getConfig(providerId);
      if (!seeded.tickets.length) {
        saveConfig(providerId, { tickets: demoTickets(), donations: defaultDonations() });
      }

      mountEl.innerHTML = "";

      var intro = el("div", null,
        '<p style="font-size:14px;color:var(--text,#383838);margin:0 0 4px">' +
          "In the <strong>Pricing Wizard</strong> you set up your regular camp tickets, then flip " +
          "<strong>one toggle</strong> to enable donations / pay-as-you-want. With it on, every " +
          "parent's checkout gains a <strong>donation prompt on top of the ticket</strong> they choose.</p>" +
        '<p style="font-size:12.5px;color:var(--muted,#808080);margin:0 0 6px">' +
          "You must have at least one regular ticket before donations can be turned on. Want parents to " +
          "pay <em>only</em> a donation? Add a £0 community place.</p>");
      mountEl.appendChild(intro);

      // --- tickets block ---
      var ticketsWrap = el("div", {
        style: "border:1.5px solid var(--line,#E6E6E6);border-radius:14px;padding:12px 14px;margin-top:12px"
      });
      mountEl.appendChild(ticketsWrap);

      // --- donations toggle block ---
      var donWrap = el("div", {
        style: "border:1.5px solid var(--line,#E6E6E6);border-radius:14px;padding:12px 14px;background:#FBF5FF;margin-top:12px"
      });
      mountEl.appendChild(donWrap);

      // --- checkout preview block ---
      var previewWrap = el("div", {
        style: "border:1.5px solid var(--line,#E6E6E6);border-radius:14px;padding:12px 14px;background:#F7F4FB;margin-top:12px"
      });
      mountEl.appendChild(previewWrap);

      var msg = el("div", { id: "dsMsg", style: "margin-top:8px;font-size:12.5px" });
      mountEl.appendChild(msg);

      function setMsg(html, good) {
        msg.innerHTML = html;
        msg.style.color = good ? "#2f7d4f" : "#9a1f5e";
      }

      function paint() {
        var cfg = getConfig(providerId);
        var gate = canEnableDonations(cfg.tickets);

        ticketsWrap.innerHTML =
          '<div style="font-family:Quicksand,system-ui,sans-serif;font-weight:700;color:var(--purple,#603488)">🎟️ Regular tickets</div>' +
          '<ul style="margin:8px 0 8px;padding-left:20px;font-size:13.5px;color:var(--text,#383838)">' +
            ticketsHtml(cfg) + "</ul>" +
          '<div style="display:grid;grid-template-columns:1.4fr .8fr auto;gap:8px;align-items:end">' +
            '<label style="font-size:12px">Label<br><input id="dsTktLabel" type="text" value="After-school club" ' +
              'style="width:100%;padding:6px 8px;border:1.5px solid var(--line,#E6E6E6);border-radius:8px"></label>' +
            '<label style="font-size:12px">Price £<br><input id="dsTktPrice" type="number" min="0" step="0.01" value="18" ' +
              'style="width:100%;padding:6px 8px;border:1.5px solid var(--line,#E6E6E6);border-radius:8px"></label>' +
            '<button class="hc-btn" id="dsAddTkt" type="button">Add ticket</button>' +
          "</div>";

        var on = cfg.donations.enabled === true;
        donWrap.innerHTML =
          '<div style="display:flex;align-items:center;justify-content:space-between;gap:10px">' +
            '<div style="font-family:Quicksand,system-ui,sans-serif;font-weight:700;color:var(--purple,#603488)">' +
              "💝 Donations / pay-as-you-want</div>" +
            '<button class="hc-btn" id="dsToggle" type="button"' +
              (gate.ok ? "" : " disabled") +
              ' style="' + (on ? "" : "background:#E9E2F0;color:var(--purple,#603488);") +
              (gate.ok ? "" : "opacity:.5;cursor:not-allowed;") + '">' +
              (on ? "ON · turn off" : "OFF · turn on") + "</button>" +
          "</div>" +
          (gate.ok
            ? '<div style="font-size:12px;color:var(--muted,#808080);margin-top:6px">' +
                (on
                  ? "Donations are ON — parents will be asked how much to add at checkout, atop their ticket."
                  : "Flip this on to add a donation prompt to every checkout.") + "</div>"
            : '<div style="font-size:12px;color:#9a1f5e;margin-top:6px">' + esc(gate.reason) + "</div>") +
          (on
            ? '<label style="display:block;font-size:12px;margin-top:8px">Suggested amounts (comma-separated £)<br>' +
                '<input id="dsSuggested" type="text" value="' + escAttr(cfg.donations.suggested.join(", ")) + '" ' +
                  'style="width:100%;padding:6px 8px;border:1.5px solid var(--line,#E6E6E6);border-radius:8px"></label>' +
              '<label style="display:block;font-size:12px;margin-top:6px">Minimum donation £ (0 = optional)<br>' +
                '<input id="dsMin" type="number" min="0" step="0.01" value="' + escAttr(cfg.donations.min) + '" ' +
                  'style="width:160px;padding:6px 8px;border:1.5px solid var(--line,#E6E6E6);border-radius:8px"></label>'
            : "");

        previewWrap.innerHTML =
          '<div style="font-family:Quicksand,system-ui,sans-serif;font-weight:700;color:var(--purple,#603488);margin-bottom:6px">' +
            "👀 What the parent sees at checkout</div>" + checkoutPreviewHtml(cfg);
      }

      paint();

      mountEl.addEventListener("click", function (e) {
        var t = e.target;
        if (!t || !t.closest) return;

        if (t.closest("#dsAddTkt")) {
          var labelEl = mountEl.querySelector("#dsTktLabel");
          var priceEl = mountEl.querySelector("#dsTktPrice");
          addTicket(providerId, labelEl ? labelEl.value : "Ticket", priceEl ? priceEl.value : 0);
          paint();
          setMsg("Ticket added.", true);
          return;
        }
        var delBtn = t.closest("[data-del-tkt]");
        if (delBtn) {
          removeTicket(providerId, delBtn.getAttribute("data-del-tkt"));
          paint();
          setMsg("Ticket removed.", true);
          return;
        }
        if (t.closest("#dsToggle")) {
          var cur = getConfig(providerId).donations.enabled === true;
          var res = toggleDonations(providerId, !cur);
          if (!res.ok) { setMsg("🚫 " + esc(res.reason), false); paint(); return; }
          paint();
          var nowOn = res.config.donations.enabled === true;
          setMsg(nowOn ? "✓ Donations ON — a donation prompt now appears atop every ticket at checkout." :
                         "Donations turned off.", true);
          try { HC.util.toast(nowOn ? "Donations enabled" : "Donations disabled"); } catch (er) {}
          return;
        }
      });

      mountEl.addEventListener("change", function (e) {
        var t = e.target;
        if (!t || !t.id) return;
        if (t.id === "dsSuggested") {
          var parts = String(t.value).split(",").map(function (s) { return parseFloat(s); });
          setSuggested(providerId, parts);
          paint();
          setMsg("Suggested amounts updated.", true);
        } else if (t.id === "dsMin") {
          setMin(providerId, t.value);
          paint();
          setMsg("Minimum donation updated.", true);
        }
      });
    } catch (e) {
      try {
        mountEl.innerHTML = '<p style="color:#9a1f5e">Donations-setup feature failed to render: ' +
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

    // A provider setup with one base ticket (a £36 full-day camp place).
    function baseConfig() {
      return {
        tickets: [{ id: "t_day", label: "Full day", price: 36 }],
        donations: defaultDonations()
      };
    }

    // ===== ACCEPTANCE CRITERION (the core claim) =====
    // Turning ON donations adds a donation prompt at checkout atop a base ticket.

    check("Donations OFF: checkout for a base ticket has NO donation prompt", function () {
      var cfg = baseConfig(); // donations.enabled === false by default
      var co = buildCheckout(cfg, "t_day", 0);
      HC.assert(co.baseTicket.price === 36, "base ticket should be £36, got " + co.baseTicket.price);
      HC.assert(co.donationPrompt.enabled === false, "no donation prompt expected when donations are OFF");
      HC.assert(co.donationOfferedAtCheckout === false, "donation must NOT be offered when OFF");
    });

    check("Turning ON donations adds a donation prompt ATOP the SAME base ticket", function () {
      var cfg = baseConfig();
      var res = setDonationsEnabled(cfg, true);
      HC.assert(res.ok === true, "enabling donations with a ticket present should succeed");
      var co = buildCheckout(res.config, "t_day", 0);
      // the prompt now exists...
      HC.assert(co.donationPrompt.enabled === true, "a donation prompt must appear once donations are ON");
      HC.assert(co.donationOfferedAtCheckout === true, "checkout should offer a donation when ON");
      // ...layered on top of the UNCHANGED base ticket...
      HC.assert(co.baseTicket.price === 36, "base ticket price must be unchanged (still £36)");
      HC.assert(co.baseTicket.label === "Full day", "base ticket label must be unchanged");
      HC.assert(co.donationIsAtopTicket === true, "donation prompt must sit ATOP the base ticket");
      HC.assert(co.donationPrompt.atopTicketId === "t_day", "prompt should reference the base ticket id");
    });

    check("The ONLY difference between OFF and ON is the added donation prompt", function () {
      var off = buildCheckout(baseConfig(), "t_day", 0);
      var on = buildCheckout(setDonationsEnabled(baseConfig(), true).config, "t_day", 0);
      // base ticket line identical either way
      HC.assert(off.baseTicket.price === on.baseTicket.price, "ticket price must not change");
      HC.assert(off.baseTicket.label === on.baseTicket.label, "ticket label must not change");
      // the delta is exactly the prompt
      HC.assert(off.donationPrompt.enabled === false && on.donationPrompt.enabled === true,
        "the prompt should be the only thing that toggles");
    });

    check("An enabled prompt carries suggested amounts, a minimum, and prompt text", function () {
      var cfg = setDonationsEnabled(baseConfig(), true).config;
      var co = buildCheckout(cfg, "t_day", 0);
      HC.assert(Array.isArray(co.donationPrompt.suggested) && co.donationPrompt.suggested.length > 0,
        "prompt should surface suggested amounts");
      HC.assert(typeof co.donationPrompt.prompt === "string" && co.donationPrompt.prompt.length > 0,
        "prompt should carry prompt text");
      HC.assert(typeof co.donationPrompt.min === "number", "prompt should carry a numeric minimum");
    });

    // ===== HAPPITY GATE: need a regular ticket before donations can be ON =====

    check("Cannot enable donations with NO regular ticket in place", function () {
      var empty = { tickets: [], donations: defaultDonations() };
      var gate = canEnableDonations(empty.tickets);
      HC.assert(gate.ok === false, "gate must refuse with no tickets");
      HC.assert(gate.code === "no_ticket", "gate code should be 'no_ticket', got " + gate.code);
      var res = setDonationsEnabled(empty, true);
      HC.assert(res.ok === false, "enabling donations with no ticket must be refused");
      HC.assert(res.code === "no_ticket", "refusal code should be 'no_ticket'");
    });

    check("With no ticket, a checkout offers no donation prompt at all", function () {
      var empty = { tickets: [], donations: { enabled: true, suggested: [5], min: 0, prompt: "x" } };
      // normaliseConfig should strip the impossible 'enabled' since no ticket exists
      var co = buildCheckout(empty, null, 0);
      HC.assert(co.donationPrompt.enabled === false, "no ticket => no donation prompt, even if 'enabled' was set");
    });

    check("Adding a ticket THEN enabling donations works (Happity setup order)", function () {
      var cfg = { tickets: [], donations: defaultDonations() };
      // first attempt fails
      HC.assert(setDonationsEnabled(cfg, true).ok === false, "should fail before a ticket exists");
      // add a ticket, then enable
      cfg.tickets.push({ id: "t1", label: "Half day", price: 22 });
      var res = setDonationsEnabled(cfg, true);
      HC.assert(res.ok === true, "should succeed once a ticket is in place");
      var co = buildCheckout(res.config, "t1", 0);
      HC.assert(co.donationPrompt.enabled === true, "prompt should now appear at checkout");
    });

    // ===== £0 TICKET: pay-by-donation-only =====

    check("A £0 ticket + donation => the donation becomes the whole payment", function () {
      var cfg = {
        tickets: [{ id: "t_free", label: "£0 community place", price: 0 }],
        donations: defaultDonations()
      };
      cfg = setDonationsEnabled(cfg, true).config;
      var co = buildCheckout(cfg, "t_free", 8); // parent chooses to donate £8
      HC.assert(co.baseTicket.price === 0, "base ticket should be £0");
      HC.assert(co.donationPrompt.enabled === true, "donation prompt should appear on the £0 ticket too");
      HC.assert(co.donationAsPayment === true, "with a £0 ticket the donation is the payment");
      HC.assert(co.preview.subtotal === 8, "subtotal should be the £8 donation, got " + co.preview.subtotal);
    });

    // ===== FEES STILL APPLY TO THE DONATION AMOUNT =====

    check("Booking fees apply to (ticket + donation), per the article", function () {
      var cfg = setDonationsEnabled(baseConfig(), true).config; // £36 ticket
      var co = buildCheckout(cfg, "t_day", 4); // + £4 donation
      HC.assert(co.preview.subtotal === 40, "subtotal should be 36 + 4 = 40, got " + co.preview.subtotal);
      // fee = 40 * 0.05 + 0.20 = 2.20
      HC.assert(co.preview.fee === 2.2, "fee on 40 should be 2.20, got " + co.preview.fee);
      HC.assert(co.preview.total === 42.2, "total should be 42.20, got " + co.preview.total);
      HC.assert(co.preview.feesAppliedToDonation === true, "fee must be flagged as applying to the donation");
    });

    check("A configured minimum donation is honoured at checkout preview", function () {
      var cfg = {
        tickets: [{ id: "t_day", label: "Full day", price: 36 }],
        donations: { enabled: true, suggested: [5, 10], min: 5, prompt: "Add a donation?" }
      };
      var co = buildCheckout(cfg, "t_day", 2); // parent tries £2, below the £5 min
      HC.assert(co.preview.donation === 5, "donation should be bumped to the £5 minimum, got " + co.preview.donation);
    });

    // ===== NORMALISATION / DEFENSIVE =====

    check("normaliseDonations cleans junk suggested amounts (sort, dedupe, drop bad)", function () {
      var d = normaliseDonations({ enabled: true, suggested: [10, -1, "abc", 5, 5, 0, 2], min: -3 });
      HC.assert(d.suggested.join(",") === "2,5,10", "suggested should be cleaned to 2,5,10, got " + d.suggested.join(","));
      HC.assert(d.min === 0, "negative minimum should clamp to 0");
    });

    check("normaliseConfig coerces a junk donations.enabled to a real boolean", function () {
      var cfg = normaliseConfig({ tickets: [{ id: "t", label: "X", price: 10 }], donations: { enabled: "yes" } });
      HC.assert(cfg.donations.enabled === false, "non-true 'enabled' should normalise to false");
    });

    check("buildCheckout never throws on wholly garbage arguments", function () {
      var inputs = [
        [null, null, null], [undefined, "x", -1], [42, {}, "y"],
        [{ tickets: "nope" }, 1, 2], [{ tickets: [null, 3, {}] }, null, null]
      ];
      for (var i = 0; i < inputs.length; i++) {
        var co = buildCheckout(inputs[i][0], inputs[i][1], inputs[i][2]);
        HC.assert(co && co.baseTicket && co.donationPrompt, "garbage input #" + i + " should still return a shape");
        HC.assert(co.donationPrompt.enabled === false, "garbage input #" + i + " should have no prompt");
      }
    });

    // ===== PERSISTENCE ROUND-TRIP via HC.store =====

    var TP = "__selftest_donations_provider__";
    clearProvider(TP);

    check("Provider adds a ticket, enables donations, and it persists", function () {
      addTicket(TP, "Full day", 36);
      var before = getConfig(TP);
      HC.assert(before.tickets.length === 1, "one ticket should persist");
      HC.assert(before.donations.enabled === false, "donations should start OFF");
      var res = toggleDonations(TP, true);
      HC.assert(res.ok === true, "toggle ON should succeed with a ticket present");
      var reloaded = getConfig(TP);
      HC.assert(reloaded.donations.enabled === true, "donations ON should persist across reload");
      var co = buildCheckout(reloaded, reloaded.tickets[0].id, 0);
      HC.assert(co.donationPrompt.enabled === true, "persisted-ON config must show a prompt at checkout");
    });

    check("Removing the last ticket auto-disables donations (gate stays honoured)", function () {
      var cfg = getConfig(TP);
      var tid = cfg.tickets[0].id;
      var after = removeTicket(TP, tid);
      HC.assert(after.tickets.length === 0, "the ticket should be removed");
      HC.assert(after.donations.enabled === false, "donations must auto-disable when no ticket remains");
      var co = buildCheckout(after, null, 0);
      HC.assert(co.donationPrompt.enabled === false, "checkout must show no prompt once tickets are gone");
    });

    check("Toggling donations ON without a ticket is refused and persists nothing", function () {
      // TP currently has no tickets
      var res = toggleDonations(TP, true);
      HC.assert(res.ok === false, "toggle ON with no ticket must be refused");
      HC.assert(res.code === "no_ticket", "refusal code should be 'no_ticket'");
      HC.assert(getConfig(TP).donations.enabled === false, "nothing should have been persisted as ON");
    });

    clearProvider(TP);

    return { pass: pass, fail: fail, log: log };
  }

  /* ===================================================================
     register
     =================================================================== */

  HC.registerFeature({
    id: "provider-donations-setup",
    title: "Enable donations / pay-as-you-want",
    side: "provider",
    icon: "💝",
    summary: "Set up your camp tickets in the Pricing Wizard, then flip one toggle to enable donations. With it on, every parent's checkout gains a donation prompt on top of the base ticket — and you need at least one regular ticket (a £0 place lets parents pay by donation only).",
    render: render,
    selfTest: selfTest
  });
})();
