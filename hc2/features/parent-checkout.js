/* HolidayCamp feature — parent-checkout
 *
 * Replicates Happity's in-platform checkout for HOLIDAY CAMPS (school-age):
 *   ticket  →  child details  →  (simulated) payment  →  confirmation.
 *
 * Evidence (Happity support corpus):
 *   - 2443933 "Happity Bookings, created for you": parents "book your classes
 *     in seconds"; commission 2.5% per booking.
 *   - 6172207 "Can I add questions to the bookings process?": "During the
 *     checkout process parents will be asked for their contact information and
 *     information on the child(ren) ... known allergies, medical conditions."
 *   - 02-ia-ux §4.1 step 6: select ticket → details → pay → confirm.
 *
 * Framed for school-age camps: tickets are day / extended-day / week / half-day
 * passes priced from the live planner (HC.data.planner.byId[...].price), with a
 * defensive fallback to the provider's price string. Booking refs + the booked
 * tickets are persisted via HC.store (mock). No real payment is taken — the
 * "Pay" step is a deterministic simulation so the flow is fully testable.
 *
 * Self-contained, defensive, plain browser JS (passes `node --check`).
 */
(function () {
  "use strict";

  if (!window.HC || typeof HC.registerFeature !== "function") return;

  var STORE_KEY = "checkout_bookings"; // array of confirmed bookings
  var COMMISSION_RATE = 0.025;          // 2.5% per booking (evidence 2443933)

  /* ---------------- pure logic (exercised by selfTest) ---------------- */

  // Build the list of buyable tickets for a provider, from the planner price
  // object first, then a best-effort parse of the provider price string.
  function ticketsForProvider(provider) {
    var tickets = [];
    if (!provider || !provider.id) return tickets;

    var planner = (HC.data && HC.data.planner) || {};
    var byId = planner.byId || {};
    var pe = byId[provider.id] || {};
    var price = pe.price || null;

    function push(id, label, amount, note) {
      var amt = Number(amount);
      if (!isFinite(amt) || amt <= 0) return;
      tickets.push({
        id: id,
        label: label,
        price: Math.round(amt * 100) / 100,
        note: note || ""
      });
    }

    if (price && typeof price === "object") {
      push("day", "Single day", price.day, "One full camp day");
      push("dayExtended", "Extended day", price.dayExtended, "Earlier drop-off / later pick-up");
      push("halfDay", "Half day", price.halfDay, "Morning or afternoon session");
      push("week", "Full week", price.week, "Mon–Fri, best value");
    }

    // Fallback: pull the first "£NN" out of the verified provider price string.
    if (!tickets.length && provider.price && typeof provider.price === "string") {
      var m = provider.price.replace(/GBP\s?/gi, "£").match(/£\s?(\d+(?:\.\d{1,2})?)/);
      if (m) push("day", "Day place", parseFloat(m[1]), "From the provider's listed price");
    }

    // Last resort: a placeholder so the flow is always demonstrable, but only
    // for genuinely paid providers (skip free/HAF routes).
    if (!tickets.length) {
      var isFree = (provider.funding || []).some(function (f) {
        return /free|haf/i.test(String(f));
      }) || /free/i.test(String(provider.price || ""));
      if (!isFree) push("day", "Day place", 35, "Indicative — confirm with provider");
    }

    return tickets;
  }

  // Money maths for a chosen ticket + quantity. Returns a breakdown the UI and
  // the test both rely on. Commission is what the *provider* pays Happity-style;
  // the parent pays the face price (subtotal). We surface both for transparency.
  function quote(ticket, qty) {
    var q = Math.max(1, parseInt(qty, 10) || 1);
    var unit = (ticket && Number(ticket.price)) || 0;
    var subtotal = Math.round(unit * q * 100) / 100;
    var commission = Math.round(subtotal * COMMISSION_RATE * 100) / 100;
    var providerNet = Math.round((subtotal - commission) * 100) / 100;
    return {
      qty: q,
      unit: unit,
      subtotal: subtotal,
      total: subtotal,          // parent pays face value
      commission: commission,   // platform fee borne by provider
      providerNet: providerNet
    };
  }

  // Validation gate between the details step and the payment step. Mirrors the
  // Happity questions: parent contact + per-child name/age + medical/allergies
  // acknowledgement.
  function validateDetails(d) {
    var errors = [];
    d = d || {};
    if (!d.parentName || !String(d.parentName).trim()) errors.push("Parent name is required.");
    var email = String(d.parentEmail || "").trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.push("A valid email is required.");
    var children = Array.isArray(d.children) ? d.children : [];
    if (!children.length) errors.push("Add at least one child.");
    children.forEach(function (c, i) {
      if (!c || !String(c.name || "").trim()) errors.push("Child " + (i + 1) + ": name is required.");
      var age = parseInt(c && c.age, 10);
      if (!isFinite(age) || age < 0 || age > 18) errors.push("Child " + (i + 1) + ": a valid age (0–18) is required.");
    });
    // Medical field may be empty, but the parent must have actively confirmed
    // (the checkbox) that they've reviewed allergies/medical info.
    if (!d.medicalConfirmed) errors.push("Please confirm allergy / medical information.");
    return { ok: errors.length === 0, errors: errors };
  }

  // Deterministic "payment". A test card ending 0000 is declined so the test
  // can prove the failure path; everything else (16 digits) is approved.
  function simulatePay(card) {
    var digits = String((card && card.number) || "").replace(/\D/g, "");
    if (digits.length < 12) return { ok: false, reason: "Card number looks incomplete." };
    if (/0000$/.test(digits)) return { ok: false, reason: "Card declined (test card). Try another." };
    var ref = "HC-" + (HC.util && HC.util.uid ? HC.util.uid() : Date.now().toString(36))
      .replace(/[^a-z0-9]/gi, "").slice(-8).toUpperCase();
    return { ok: true, ref: ref, last4: digits.slice(-4) };
  }

  // Persist a confirmed booking (mock). Returns the stored record.
  function recordBooking(rec) {
    var list = HC.store.get(STORE_KEY, []);
    if (!Array.isArray(list)) list = [];
    list.push(rec);
    HC.store.set(STORE_KEY, list);
    return rec;
  }

  function getBookings() {
    var list = HC.store.get(STORE_KEY, []);
    return Array.isArray(list) ? list : [];
  }

  // End-to-end orchestration of one booking as pure data — this is the
  // canonical path the UI walks and the acceptance test asserts.
  function runCheckout(provider, opts) {
    opts = opts || {};
    var tickets = ticketsForProvider(provider);
    if (!tickets.length) return { stage: "ticket", ok: false, reason: "No tickets available." };

    var ticket = opts.ticket ||
      (tickets.filter(function (t) { return t.id === opts.ticketId; })[0]) ||
      tickets[0];

    var q = quote(ticket, opts.qty || 1);

    var v = validateDetails(opts.details);
    if (!v.ok) return { stage: "details", ok: false, errors: v.errors, ticket: ticket, quote: q };

    var pay = simulatePay(opts.card);
    if (!pay.ok) return { stage: "payment", ok: false, reason: pay.reason, ticket: ticket, quote: q };

    var rec = {
      ref: pay.ref,
      providerId: provider.id,
      providerName: provider.name,
      ticketId: ticket.id,
      ticketLabel: ticket.label,
      qty: q.qty,
      total: q.total,
      commission: q.commission,
      last4: pay.last4,
      parentName: String(opts.details.parentName).trim(),
      parentEmail: String(opts.details.parentEmail).trim(),
      children: (opts.details.children || []).map(function (c) {
        return { name: String(c.name).trim(), age: parseInt(c.age, 10), medical: String(c.medical || "").trim() };
      }),
      bookedAt: new Date().toISOString()
    };
    if (opts.persist !== false) recordBooking(rec);
    return { stage: "confirmation", ok: true, booking: rec, ticket: ticket, quote: q };
  }

  /* ---------------- UI (multi-step wizard inside mountEl) ---------------- */

  function firstPaidProvider() {
    var providers = (HC.data && HC.data.providers) || [];
    for (var i = 0; i < providers.length; i++) {
      if (ticketsForProvider(providers[i]).length) return providers[i];
    }
    return providers[0] || null;
  }

  function render(mountEl) {
    try {
      var providers = (HC.data && HC.data.providers) || [];
      var bookable = providers.filter(function (p) { return ticketsForProvider(p).length; });
      if (!bookable.length) {
        mountEl.innerHTML = '<p style="color:var(--muted,#808080)">No bookable camps in the live data right now.</p>';
        return;
      }

      // wizard state held in closure
      var state = {
        provider: bookable[0],
        ticket: null,
        qty: 1,
        details: { parentName: "", parentEmail: "", children: [{ name: "", age: "", medical: "" }], medicalConfirmed: false },
        card: { number: "", name: "" }
      };

      var root = HC.util.el("div", { class: "hcco" });
      mountEl.innerHTML = "";
      mountEl.appendChild(root);
      injectStyles();
      drawStepTicket();

      function steps(active) {
        var names = ["Ticket", "Details", "Payment", "Done"];
        return '<ol class="hcco-steps">' + names.map(function (n, i) {
          return '<li class="' + (i === active ? "on" : (i < active ? "done" : "")) + '">' +
            '<span>' + (i + 1) + '</span>' + n + "</li>";
        }).join("") + "</ol>";
      }

      function esc(s) {
        return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
      }
      function m(n) { return HC.util.money(n); }

      /* --- step 1: ticket --- */
      function drawStepTicket() {
        var provOpts = bookable.map(function (p) {
          return '<option value="' + esc(p.id) + '"' + (p.id === state.provider.id ? " selected" : "") + ">" + esc(p.name) + "</option>";
        }).join("");
        var tickets = ticketsForProvider(state.provider);
        if (!state.ticket || !tickets.some(function (t) { return t.id === state.ticket.id; })) {
          state.ticket = tickets[0];
        }
        var ticketHtml = tickets.map(function (t) {
          var on = state.ticket && t.id === state.ticket.id;
          return '<label class="hcco-ticket' + (on ? " on" : "") + '">' +
            '<input type="radio" name="hcco-tk" value="' + esc(t.id) + '"' + (on ? " checked" : "") + ">" +
            '<span class="hcco-tk-main"><b>' + esc(t.label) + "</b>" +
            (t.note ? '<small>' + esc(t.note) + "</small>" : "") + "</span>" +
            '<span class="hcco-tk-price">' + m(t.price) + "</span></label>";
        }).join("");

        root.innerHTML = steps(0) +
          '<h3 class="hcco-h">Choose your camp & ticket</h3>' +
          '<label class="hcco-field"><span>Camp</span>' +
          '<select id="hcco-prov">' + provOpts + "</select></label>" +
          '<div class="hcco-tickets">' + (ticketHtml || '<p class="hcco-muted">No tickets for this camp.</p>') + "</div>" +
          '<label class="hcco-field hcco-qty"><span>Children attending</span>' +
          '<input id="hcco-qty" type="number" min="1" max="6" value="' + esc(state.qty) + '"></label>' +
          '<div id="hcco-quote" class="hcco-quote"></div>' +
          '<div class="hcco-actions"><button class="hcco-btn" id="hcco-next1" type="button">Continue to details →</button></div>';

        var provSel = root.querySelector("#hcco-prov");
        provSel.addEventListener("change", function () {
          state.provider = bookable.filter(function (p) { return p.id === provSel.value; })[0] || state.provider;
          state.ticket = null;
          drawStepTicket();
        });
        root.querySelectorAll('input[name="hcco-tk"]').forEach(function (r) {
          r.addEventListener("change", function () {
            state.ticket = ticketsForProvider(state.provider).filter(function (t) { return t.id === r.value; })[0];
            drawStepTicket();
          });
        });
        var qtyEl = root.querySelector("#hcco-qty");
        qtyEl.addEventListener("input", function () { state.qty = qtyEl.value; refreshQuote(); });
        refreshQuote();
        root.querySelector("#hcco-next1").addEventListener("click", function () {
          if (!state.ticket) { HC.util.toast("Pick a ticket first"); return; }
          ensureChildren();
          drawStepDetails();
        });

        function refreshQuote() {
          var q = quote(state.ticket, state.qty);
          var box = root.querySelector("#hcco-quote");
          if (!state.ticket) { box.innerHTML = ""; return; }
          box.innerHTML = '<div class="hcco-line"><span>' + esc(state.ticket.label) + ' × ' + q.qty + "</span><span>" + m(q.subtotal) + "</span></div>" +
            '<div class="hcco-line hcco-total"><span>You pay today</span><span>' + m(q.total) + "</span></div>" +
            '<div class="hcco-fee">Provider keeps ' + m(q.providerNet) + " after a 2.5% platform fee (" + m(q.commission) + ").</div>";
        }
      }

      function ensureChildren() {
        var n = Math.max(1, parseInt(state.qty, 10) || 1);
        var kids = state.details.children;
        while (kids.length < n) kids.push({ name: "", age: "", medical: "" });
        if (kids.length > n) kids.length = n;
      }

      /* --- step 2: child details --- */
      function drawStepDetails() {
        ensureChildren();
        var kids = state.details.children.map(function (c, i) {
          return '<div class="hcco-kid"><div class="hcco-kid-h">Child ' + (i + 1) + "</div>" +
            '<div class="hcco-row">' +
              '<label class="hcco-field"><span>Name</span><input data-kid="' + i + '" data-f="name" value="' + esc(c.name) + '"></label>' +
              '<label class="hcco-field hcco-age"><span>Age</span><input data-kid="' + i + '" data-f="age" type="number" min="0" max="18" value="' + esc(c.age) + '"></label>' +
            "</div>" +
            '<label class="hcco-field"><span>Allergies / medical (optional)</span>' +
            '<input data-kid="' + i + '" data-f="medical" placeholder="e.g. asthma inhaler, nut allergy" value="' + esc(c.medical) + '"></label>' +
          "</div>";
        }).join("");

        root.innerHTML = steps(1) +
          '<h3 class="hcco-h">Your details</h3>' +
          '<div class="hcco-row">' +
            '<label class="hcco-field"><span>Parent / carer name</span><input id="hcco-pn" value="' + esc(state.details.parentName) + '"></label>' +
            '<label class="hcco-field"><span>Email</span><input id="hcco-pe" type="email" value="' + esc(state.details.parentEmail) + '"></label>' +
          "</div>" +
          '<div class="hcco-kids">' + kids + "</div>" +
          '<label class="hcco-check"><input id="hcco-med" type="checkbox"' + (state.details.medicalConfirmed ? " checked" : "") + "> " +
            "I confirm the allergy / medical details above are accurate.</label>" +
          '<div id="hcco-errs" class="hcco-errs"></div>' +
          '<div class="hcco-actions"><button class="hcco-btn-ghost" id="hcco-back2" type="button">← Back</button>' +
          '<button class="hcco-btn" id="hcco-next2" type="button">Continue to payment →</button></div>';

        root.querySelector("#hcco-pn").addEventListener("input", function (e) { state.details.parentName = e.target.value; });
        root.querySelector("#hcco-pe").addEventListener("input", function (e) { state.details.parentEmail = e.target.value; });
        root.querySelector("#hcco-med").addEventListener("change", function (e) { state.details.medicalConfirmed = e.target.checked; });
        root.querySelectorAll("[data-kid]").forEach(function (inp) {
          inp.addEventListener("input", function () {
            var i = parseInt(inp.getAttribute("data-kid"), 10);
            state.details.children[i][inp.getAttribute("data-f")] = inp.value;
          });
        });
        root.querySelector("#hcco-back2").addEventListener("click", drawStepTicket);
        root.querySelector("#hcco-next2").addEventListener("click", function () {
          var v = validateDetails(state.details);
          if (!v.ok) {
            root.querySelector("#hcco-errs").innerHTML = v.errors.map(function (x) { return "<div>• " + esc(x) + "</div>"; }).join("");
            return;
          }
          drawStepPayment();
        });
      }

      /* --- step 3: payment (simulated) --- */
      function drawStepPayment() {
        var q = quote(state.ticket, state.qty);
        root.innerHTML = steps(2) +
          '<h3 class="hcco-h">Payment</h3>' +
          '<div class="hcco-summary"><div class="hcco-line"><span>' + esc(state.provider.name) + "</span></div>" +
            '<div class="hcco-line"><span>' + esc(state.ticket.label) + " × " + q.qty + "</span><span>" + m(q.subtotal) + "</span></div>" +
            '<div class="hcco-line hcco-total"><span>Total</span><span>' + m(q.total) + "</span></div></div>" +
          '<p class="hcco-muted">This is a simulated payment — no card is charged. Use any 16-digit number; a number ending 0000 is declined.</p>' +
          '<label class="hcco-field"><span>Name on card</span><input id="hcco-cn" value="' + esc(state.card.name) + '"></label>' +
          '<label class="hcco-field"><span>Card number</span><input id="hcco-cc" inputmode="numeric" placeholder="4242 4242 4242 4242" value="' + esc(state.card.number) + '"></label>' +
          '<div id="hcco-perr" class="hcco-errs"></div>' +
          '<div class="hcco-actions"><button class="hcco-btn-ghost" id="hcco-back3" type="button">← Back</button>' +
          '<button class="hcco-btn" id="hcco-pay" type="button">Pay ' + m(q.total) + "</button></div>";

        root.querySelector("#hcco-cn").addEventListener("input", function (e) { state.card.name = e.target.value; });
        root.querySelector("#hcco-cc").addEventListener("input", function (e) { state.card.number = e.target.value; });
        root.querySelector("#hcco-back3").addEventListener("click", drawStepDetails);
        root.querySelector("#hcco-pay").addEventListener("click", function () {
          var res = runCheckout(state.provider, {
            ticketId: state.ticket.id, qty: state.qty,
            details: state.details, card: state.card
          });
          if (!res.ok) {
            root.querySelector("#hcco-perr").innerHTML = "<div>• " + esc(res.reason || "Payment could not be completed.") + "</div>";
            return;
          }
          drawStepDone(res.booking);
        });
      }

      /* --- step 4: confirmation --- */
      function drawStepDone(booking) {
        var kidLines = booking.children.map(function (c) {
          return "<li>" + esc(c.name) + " (age " + c.age + ")" + (c.medical ? " — " + esc(c.medical) : "") + "</li>";
        }).join("");
        root.innerHTML = steps(3) +
          '<div class="hcco-done">' +
            '<div class="hcco-tick">✓</div>' +
            "<h3 class=\"hcco-h\">You're booked in!</h3>" +
            '<p class="hcco-ref">Booking ref <b>' + esc(booking.ref) + "</b></p>" +
            '<div class="hcco-summary">' +
              '<div class="hcco-line"><span>' + esc(booking.providerName) + "</span></div>" +
              '<div class="hcco-line"><span>' + esc(booking.ticketLabel) + " × " + booking.qty + "</span><span>" + m(booking.total) + "</span></div>" +
              '<div class="hcco-line"><span>Card ending</span><span>•••• ' + esc(booking.last4) + "</span></div>" +
            "</div>" +
            "<p class=\"hcco-muted\">A confirmation email would be sent to <b>" + esc(booking.parentEmail) + "</b>.</p>" +
            "<ul class=\"hcco-kidlist\">" + kidLines + "</ul>" +
            '<div class="hcco-actions"><button class="hcco-btn" id="hcco-again" type="button">Book another</button></div>' +
          "</div>";
        HC.util.toast("Booked — ref " + booking.ref);
        root.querySelector("#hcco-again").addEventListener("click", function () {
          state.ticket = null; state.qty = 1;
          state.details = { parentName: "", parentEmail: "", children: [{ name: "", age: "", medical: "" }], medicalConfirmed: false };
          state.card = { number: "", name: "" };
          drawStepTicket();
        });
      }
    } catch (e) {
      mountEl.innerHTML = '<p style="color:#9a1f5e">Checkout failed to render: ' +
        String(e && e.message ? e.message : e) + "</p>";
    }
  }

  function injectStyles() {
    if (document.getElementById("hcco-styles")) return;
    var css =
      ".hcco{font-family:'Nunito Sans',system-ui,sans-serif;color:var(--text,#383838)}" +
      ".hcco-steps{display:flex;gap:6px;list-style:none;padding:0;margin:0 0 16px;font-size:12px;font-weight:700;font-family:'Quicksand',system-ui,sans-serif}" +
      ".hcco-steps li{flex:1;display:flex;align-items:center;gap:6px;color:var(--muted,#9a9a9a)}" +
      ".hcco-steps li span{width:22px;height:22px;border-radius:50%;display:grid;place-items:center;background:var(--line,#E6E6E6);color:#fff;font-size:12px}" +
      ".hcco-steps li.on{color:var(--purple,#603488)}.hcco-steps li.on span{background:var(--magenta,#F82488)}" +
      ".hcco-steps li.done span{background:#2f7d4f}" +
      ".hcco-h{font-family:'Quicksand',system-ui,sans-serif;color:var(--purple,#603488);font-size:19px;margin:0 0 12px}" +
      ".hcco-field{display:flex;flex-direction:column;gap:4px;font-size:13px;font-weight:700;color:var(--purple,#603488);margin:0 0 12px}" +
      ".hcco-field input,.hcco-field select{font:inherit;font-weight:400;color:var(--text,#383838);padding:9px 11px;border:1.5px solid var(--line,#E6E6E6);border-radius:12px}" +
      ".hcco-row{display:flex;gap:12px}.hcco-row .hcco-field{flex:1}.hcco-age{max-width:90px}.hcco-qty{max-width:200px}" +
      ".hcco-tickets{display:flex;flex-direction:column;gap:8px;margin:0 0 14px}" +
      ".hcco-ticket{display:flex;align-items:center;gap:10px;border:1.5px solid var(--line,#E6E6E6);border-radius:14px;padding:11px 13px;cursor:pointer}" +
      ".hcco-ticket.on{border-color:var(--magenta,#F82488);background:var(--pink-tint,#FCE8F0)}" +
      ".hcco-tk-main{flex:1;display:flex;flex-direction:column}.hcco-tk-main small{font-weight:400;color:var(--muted,#808080);font-size:12px}" +
      ".hcco-tk-price{font-family:'Quicksand',system-ui,sans-serif;font-weight:700;color:var(--purple,#603488)}" +
      ".hcco-quote,.hcco-summary{background:var(--purple-tint,#F0E8F4);border-radius:14px;padding:12px 14px;margin:0 0 14px;font-size:14px}" +
      ".hcco-line{display:flex;justify-content:space-between;padding:3px 0}" +
      ".hcco-total{font-family:'Quicksand',system-ui,sans-serif;font-weight:700;color:var(--purple,#603488);border-top:1px solid rgba(0,0,0,.08);margin-top:4px;padding-top:7px}" +
      ".hcco-fee{font-size:11.5px;color:var(--muted,#808080);margin-top:6px}" +
      ".hcco-kid{border:1px solid var(--line,#E6E6E6);border-radius:14px;padding:12px;margin:0 0 10px}" +
      ".hcco-kid-h{font-family:'Quicksand',system-ui,sans-serif;font-weight:700;color:var(--magenta,#F82488);font-size:12px;text-transform:uppercase;letter-spacing:.4px;margin:0 0 8px}" +
      ".hcco-check{display:flex;gap:8px;align-items:flex-start;font-size:13px;margin:0 0 12px;cursor:pointer}" +
      ".hcco-errs{color:#9a1f5e;font-size:12.5px;margin:0 0 10px}.hcco-errs div{margin:2px 0}" +
      ".hcco-actions{display:flex;gap:10px;margin-top:6px}" +
      ".hcco-btn{flex:1;border:none;cursor:pointer;font-family:'Quicksand',system-ui,sans-serif;font-weight:700;background:var(--yellow,#FCD400);color:var(--ink,#1A1A1A);padding:11px 16px;border-radius:999px;font-size:13.5px}" +
      ".hcco-btn:hover{background:#ffdf2e}" +
      ".hcco-btn-ghost{border:1.5px solid var(--purple-tint,#F0E8F4);cursor:pointer;font-family:'Quicksand',system-ui,sans-serif;font-weight:700;background:#fff;color:var(--purple,#603488);padding:11px 16px;border-radius:999px;font-size:13.5px}" +
      ".hcco-muted{color:var(--muted,#808080);font-size:12.5px}" +
      ".hcco-done{text-align:center}.hcco-tick{width:54px;height:54px;border-radius:50%;background:#2f7d4f;color:#fff;font-size:30px;display:grid;place-items:center;margin:0 auto 10px}" +
      ".hcco-ref{font-size:14px;margin:0 0 12px}.hcco-kidlist{text-align:left;font-size:13px;color:var(--text,#383838);padding-left:18px}";
    var s = HC.util.el("style", { id: "hcco-styles" }, css);
    document.head.appendChild(s);
  }

  /* ---------------- selfTest: exercises the LOGIC ---------------- */

  function selfTest() {
    var pass = 0, fail = 0, log = [];
    function check(label, fn) {
      try { fn(); pass++; log.push("✓ " + label); }
      catch (e) { fail++; log.push("✗ " + label + " — " + (e && e.message ? e.message : String(e))); }
    }

    // A deterministic fixture provider so the test never depends on live data
    // ordering, plus a check against a real provider when available.
    var fixture = { id: "__hcco_fixture__", name: "Test Camp", price: "From £40 day", funding: ["Paid"] };

    var goodDetails = {
      parentName: "Sam Carer",
      parentEmail: "sam@example.com",
      children: [{ name: "Ada", age: 8, medical: "" }],
      medicalConfirmed: true
    };
    var goodCard = { number: "4242 4242 4242 4242", name: "Sam Carer" };

    check("Tickets are derived for a paid provider", function () {
      var t = ticketsForProvider(fixture);
      HC.assert(t.length >= 1, "expected >=1 ticket, got " + t.length);
      HC.assert(t[0].price === 40, "fallback price should parse to 40, got " + t[0].price);
    });

    check("Free/HAF provider yields no purchasable ticket", function () {
      var free = { id: "__free__", name: "HAF Route", price: "Free for eligible", funding: ["Free/HAF"] };
      HC.assert(ticketsForProvider(free).length === 0, "free route should have no tickets");
    });

    check("Quote applies 2.5% provider commission on face value", function () {
      var q = quote({ price: 40 }, 2);
      HC.assert(q.subtotal === 80, "subtotal 40×2 should be 80, got " + q.subtotal);
      HC.assert(q.total === 80, "parent pays face value 80, got " + q.total);
      HC.assert(q.commission === 2, "2.5% of 80 should be 2.00, got " + q.commission);
      HC.assert(q.providerNet === 78, "provider nets 78, got " + q.providerNet);
    });

    check("Details validation rejects bad input", function () {
      HC.assert(!validateDetails({}).ok, "empty details should fail");
      HC.assert(!validateDetails({ parentName: "A", parentEmail: "bad", children: [{ name: "X", age: 7 }], medicalConfirmed: true }).ok, "bad email should fail");
      HC.assert(!validateDetails({ parentName: "A", parentEmail: "a@b.com", children: [], medicalConfirmed: true }).ok, "no children should fail");
      HC.assert(!validateDetails({ parentName: "A", parentEmail: "a@b.com", children: [{ name: "X", age: 7 }] }).ok, "unconfirmed medical should fail");
    });

    check("Details validation accepts good input", function () {
      HC.assert(validateDetails(goodDetails).ok, "valid details should pass");
    });

    check("Simulated payment declines a 0000 card, approves a normal one", function () {
      HC.assert(!simulatePay({ number: "4000 0000 0000 0000" }).ok, "0000 card should decline");
      var ok = simulatePay({ number: "4242 4242 4242 4242" });
      HC.assert(ok.ok && /^HC-/.test(ok.ref) && ok.last4 === "4242", "normal card should approve with ref+last4");
    });

    // === ACCEPTANCE CRITERION ===
    // Selecting a ticket walks ticket -> child-details -> payment -> confirmation.
    check("ACCEPTANCE: ticket → details → payment → confirmation", function () {
      // 1. ticket stage gate: a chosen ticket exists
      var tickets = ticketsForProvider(fixture);
      HC.assert(tickets.length >= 1, "ticket stage: a ticket must be selectable");

      // 2. attempting payment BEFORE valid details stops at the details stage
      var blocked = runCheckout(fixture, { ticketId: tickets[0].id, qty: 1, details: {}, card: goodCard, persist: false });
      HC.assert(blocked.stage === "details" && !blocked.ok, "must stop at details step when details invalid, got stage=" + blocked.stage);

      // 3. valid details but declined card stops at the payment stage
      var declined = runCheckout(fixture, { ticketId: tickets[0].id, qty: 1, details: goodDetails, card: { number: "4000 0000 0000 0000" }, persist: false });
      HC.assert(declined.stage === "payment" && !declined.ok, "must stop at payment step on decline, got stage=" + declined.stage);

      // 4. full happy path reaches the confirmation stage with a booking ref
      var before = getBookings().length;
      var done = runCheckout(fixture, { ticketId: tickets[0].id, qty: 2, details: goodDetails, card: goodCard });
      HC.assert(done.stage === "confirmation" && done.ok, "happy path must reach confirmation, got stage=" + done.stage);
      HC.assert(done.booking && /^HC-/.test(done.booking.ref), "confirmation must carry a booking ref");
      HC.assert(done.booking.total === tickets[0].price * 2, "confirmed total should be ticket×qty");
      HC.assert(getBookings().length === before + 1, "confirmed booking must be persisted via HC.store");
    });

    check("Confirmed booking persists child details (allergies/medical)", function () {
      var det = {
        parentName: "Jo Carer", parentEmail: "jo@example.com",
        children: [{ name: "Max", age: 9, medical: "asthma inhaler" }],
        medicalConfirmed: true
      };
      var res = runCheckout(fixture, { ticketId: "day", details: det, card: goodCard });
      HC.assert(res.ok, "booking should succeed");
      HC.assert(res.booking.children[0].medical === "asthma inhaler", "medical note must be stored");
      HC.assert(res.booking.parentEmail === "jo@example.com", "parent email must be stored");
    });

    // Bonus: the flow also works end-to-end against the FIRST live paid camp.
    check("Works against a live paid camp from HC.data", function () {
      var p = firstPaidProvider();
      if (!p || !ticketsForProvider(p).length) { log.push("  (no live paid camp — skipped)"); return; }
      var res = runCheckout(p, { details: goodDetails, card: goodCard, persist: false });
      HC.assert(res.stage === "confirmation" && res.ok, "live camp should reach confirmation");
    });

    return { pass: pass, fail: fail, log: log };
  }

  /* ---------------- register ---------------- */

  HC.registerFeature({
    id: "parent-checkout",
    title: "In-platform checkout",
    side: "parent",
    icon: "🛒",
    summary: "Book a camp in seconds: pick a ticket, add your child's details and any medical notes, pay (simulated), and get an instant booking confirmation.",
    render: render,
    selfTest: selfTest
  });
})();
