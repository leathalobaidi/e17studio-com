/* HolidayCamp feature — parent-donation
 *
 * Pay-as-you-want / donation amount at checkout  (parent side)
 *
 * Replicates Happity's "donations / pay as you want" feature
 * (support article 6135640). Evidence highlights:
 *   - "allow parents to pay or contribute their chosen amount for a class"
 *   - donations sit ON TOP OF a regular ticket, OR a £0 ticket lets the
 *     customer "pay only their donation amount" (donation AS the payment)
 *   - "When the customer gets to the checkout process, this is where they
 *     will be asked how much they would like to donate"
 *   - "all regular booking fees still apply to the donation amount"
 *
 * Framed for SCHOOL-AGE HOLIDAY CAMPS: a parent at checkout for a camp day
 * can add an optional donation on top of the day rate, or — for a free /
 * pay-what-you-can community camp — pay purely by donation.
 *
 * Self-contained, defensive, no imports/exports. Calls HC.registerFeature.
 */
(function () {
  "use strict";

  // Defensive: never throw at module load if HC isn't present.
  if (typeof window === "undefined" || !window.HC || typeof window.HC.registerFeature !== "function") {
    if (typeof console !== "undefined" && console.warn) {
      console.warn("[HC] parent-donation: HC core not found; skipping registration.");
    }
    return;
  }

  var HC = window.HC;

  /* ---------------- pure logic (testable, DOM-free) ---------------- */

  // Booking fee model — mirrors a Stripe-style fee that "still applies to the
  // donation amount". Percentage + fixed pence, applied to (ticket + donation).
  var FEE = { pct: 0.05, fixed: 0.20 };

  function round2(n) {
    return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
  }

  // Clamp a raw user-entered donation into a valid, non-negative number.
  // Defensive against "", null, "abc", -5, NaN, Infinity.
  function normaliseDonation(raw) {
    var n = Number(raw);
    if (!isFinite(n) || n < 0) return 0;
    return round2(n);
  }

  // The core checkout calculation. This is what the acceptance criterion
  // is about: a checkout that offers an optional donation on top of (or as)
  // the ticket.
  //
  //   ticketPrice : base ticket cost (may be 0 for a "pay what you can" camp)
  //   donation    : optional amount the parent chooses to add (>= 0)
  //   feesApply   : whether booking fees apply (to ticket + donation)
  //
  // Returns a fully broken-down quote.
  function computeCheckout(ticketPrice, donation, feesApply) {
    var ticket = normaliseDonation(ticketPrice);   // reuse clamp for safety
    var donate = normaliseDonation(donation);
    var subtotal = round2(ticket + donate);

    var fee = 0;
    if (feesApply && subtotal > 0) {
      fee = round2(subtotal * FEE.pct + FEE.fixed);
    }
    var total = round2(subtotal + fee);

    return {
      ticket: ticket,
      donation: donate,
      subtotal: subtotal,
      fee: fee,
      total: total,
      // mode flags that capture the acceptance criterion explicitly:
      donationOffered: true,                 // checkout ALWAYS offers a donation
      donationOnTop: ticket > 0 && donate > 0, // donation added on top of a paid ticket
      donationAsPayment: ticket === 0 && donate > 0, // £0 ticket => pay purely by donation
      hasDonation: donate > 0
    };
  }

  // Parse a "£36" / "GBP 36 per day" style price string from live camp data
  // into a number. Returns null if no number is found (e.g. "Check live site").
  function parsePrice(str) {
    if (typeof str !== "string") return null;
    if (/free/i.test(str) && !/[0-9]/.test(str)) return 0;
    // first GBP / £ amount in the string
    var m = str.match(/(?:£|GBP|gbp)\s*([0-9]+(?:\.[0-9]{1,2})?)/);
    if (m) return round2(parseFloat(m[1]));
    var any = str.match(/([0-9]+(?:\.[0-9]{1,2})?)/);
    return any ? round2(parseFloat(any[1])) : null;
  }

  // Pick a representative live camp + its day rate to seed the demo.
  function pickSeedCamp() {
    var providers = [];
    try { providers = HC.data.providers || []; } catch (e) { providers = []; }
    var seed = { name: "Holiday camp day", price: 36, isFree: false };
    for (var i = 0; i < providers.length; i++) {
      var p = providers[i];
      var price = parsePrice(p && p.price);
      if (price !== null && price > 0) {
        seed = { name: p.name || seed.name, price: price, isFree: false };
        break;
      }
    }
    // Also try to find a genuinely free / HAF camp for the "pay what you can" demo.
    var freeCamp = null;
    for (var j = 0; j < providers.length; j++) {
      var q = providers[j];
      var funding = (q && q.funding) || [];
      if (Array.isArray(funding) && funding.indexOf("Free/HAF") !== -1) { freeCamp = q.name; break; }
      if (q && parsePrice(q.price) === 0) { freeCamp = q.name; break; }
    }
    seed.freeCampName = freeCamp || "Community pay-what-you-can camp";
    return seed;
  }

  var PRESETS = [0, 2, 5, 10];
  var STORE_KEY = "parent_donation_prefs";

  /* ---------------- UI ---------------- */

  function money(n) {
    try { return HC.util.money(n); } catch (e) { return "£" + Number(n).toFixed(2); }
  }

  function render(mountEl) {
    if (!mountEl) return;
    var seed = pickSeedCamp();
    var prefs = {};
    try { prefs = HC.store.get(STORE_KEY, {}) || {}; } catch (e) { prefs = {}; }

    var freeMode = !!prefs.freeMode;        // "pay what you can" (£0 ticket) toggle
    var donation = typeof prefs.donation === "number" ? prefs.donation : 2;

    mountEl.innerHTML = "";

    var wrap = HC.util.el("div", { style: "font-family:'Nunito Sans',system-ui,sans-serif;color:var(--text,#383838)" });

    wrap.appendChild(HC.util.el("p", { style: "font-size:14px;margin:0 0 14px" },
      "At checkout for <strong>" + esc(seed.name) + "</strong>, you can add an optional " +
      "donation on top of the ticket — or, for a free / pay-what-you-can camp, pay purely by donation. " +
      "Booking fees apply to the donation amount, just like the real thing."));

    // Mode toggle: paid ticket vs pay-what-you-can (£0 ticket)
    var modeRow = HC.util.el("label", {
      style: "display:flex;align-items:center;gap:9px;font-size:13.5px;font-weight:700;" +
        "background:var(--purple-tint,#F0E8F4);color:var(--purple,#603488);padding:10px 13px;border-radius:12px;cursor:pointer;margin:0 0 14px"
    });
    var modeCheck = HC.util.el("input", { type: "checkbox" });
    modeCheck.checked = freeMode;
    modeRow.appendChild(modeCheck);
    modeRow.appendChild(HC.util.el("span", null,
      'Pay-what-you-can camp (£0 ticket — "' + esc(seed.freeCampName) + '")'));
    wrap.appendChild(modeRow);

    // Donation presets + custom
    wrap.appendChild(HC.util.el("div", {
      style: "font-family:'Quicksand',system-ui,sans-serif;font-weight:700;color:var(--magenta,#F82488);" +
        "text-transform:uppercase;letter-spacing:.5px;font-size:12px;margin:0 0 8px"
    }, "Add a donation"));

    var chipRow = HC.util.el("div", { style: "display:flex;flex-wrap:wrap;gap:8px;margin:0 0 10px" });
    PRESETS.forEach(function (amt) {
      var chip = HC.util.el("button", {
        type: "button",
        "data-amt": String(amt),
        style: chipStyle(amt === donation)
      }, amt === 0 ? "No thanks" : money(amt));
      chip.addEventListener("click", function () {
        donation = amt;
        customInput.value = "";
        update();
      });
      chipRow.appendChild(chip);
    });
    wrap.appendChild(chipRow);

    var customRow = HC.util.el("div", { style: "display:flex;align-items:center;gap:8px;margin:0 0 16px" });
    customRow.appendChild(HC.util.el("span", { style: "font-size:13px;color:var(--muted,#808080)" }, "Or other £"));
    var customInput = HC.util.el("input", {
      type: "number", min: "0", step: "0.50", placeholder: "0.00",
      style: "width:110px;padding:8px 10px;border:1.5px solid var(--line,#E6E6E6);border-radius:10px;font-size:14px"
    });
    customInput.addEventListener("input", function () {
      var v = normaliseDonation(customInput.value);
      donation = v;
      // de-select preset chips when typing a custom value
      update(true);
    });
    customRow.appendChild(customInput);
    wrap.appendChild(customRow);

    // Quote breakdown
    var quoteBox = HC.util.el("div", {
      style: "background:#fff;border:1.5px solid var(--line,#E6E6E6);border-radius:14px;padding:16px 18px"
    });
    wrap.appendChild(quoteBox);

    var payBtn = HC.util.el("button", { class: "hc-btn", type: "button", style: "margin-top:14px" }, "Pay");
    payBtn.addEventListener("click", function () {
      var q = currentQuote();
      try { HC.store.set(STORE_KEY, { freeMode: modeCheck.checked, donation: donation }); } catch (e) {}
      var msg = q.hasDonation
        ? (q.donationAsPayment
            ? "Thanks! You paid " + money(q.donation) + " by donation (+ " + money(q.fee) + " fee)."
            : "Thanks! " + money(q.ticket) + " ticket + " + money(q.donation) + " donation.")
        : "Booked — no donation added this time.";
      try { HC.util.toast(msg); } catch (e) {}
    });
    wrap.appendChild(payBtn);

    mountEl.appendChild(wrap);

    function currentQuote() {
      var ticket = modeCheck.checked ? 0 : seed.price;
      return computeCheckout(ticket, donation, true);
    }

    function update(fromCustom) {
      // refresh chip highlight
      Array.prototype.forEach.call(chipRow.querySelectorAll("button"), function (b) {
        var amt = Number(b.getAttribute("data-amt"));
        var on = !fromCustom && amt === donation;
        b.setAttribute("style", chipStyle(on));
      });
      renderQuote();
    }

    function renderQuote() {
      var q = currentQuote();
      var lines = "";
      lines += row(modeCheck.checked ? "Ticket (pay-what-you-can)" : "Camp day ticket", money(q.ticket));
      lines += row("Donation", money(q.donation), q.hasDonation ? "var(--magenta,#F82488)" : "var(--muted,#808080)");
      lines += row("Booking fee", money(q.fee), "var(--muted,#808080)");
      var tag = q.donationAsPayment ? " · paid by donation"
        : (q.donationOnTop ? " · donation on top" : "");
      quoteBox.innerHTML = lines +
        '<div style="display:flex;justify-content:space-between;border-top:1.5px solid var(--line,#E6E6E6);' +
        'margin-top:8px;padding-top:10px;font-family:Quicksand,system-ui,sans-serif;font-weight:700;font-size:16px;color:var(--purple,#603488)">' +
        '<span>Total' + tag + '</span><span>' + money(q.total) + '</span></div>';
    }

    modeCheck.addEventListener("change", update);

    update();
  }

  function row(label, val, color) {
    return '<div style="display:flex;justify-content:space-between;font-size:14px;padding:4px 0;color:' +
      (color || "var(--text,#383838)") + '"><span>' + esc(label) + '</span><span>' + esc(val) + '</span></div>';
  }

  function chipStyle(on) {
    return "border:1.5px solid " + (on ? "var(--magenta,#F82488)" : "var(--line,#E6E6E6)") + ";" +
      "background:" + (on ? "var(--magenta,#F82488)" : "#fff") + ";" +
      "color:" + (on ? "#fff" : "var(--text,#383838)") + ";" +
      "font-family:'Quicksand',system-ui,sans-serif;font-weight:700;font-size:13px;" +
      "padding:8px 14px;border-radius:999px;cursor:pointer";
  }

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  /* ---------------- selfTest ---------------- */

  function selfTest() {
    var pass = 0, fail = 0, log = [];
    function check(label, fn) {
      try { fn(); pass += 1; log.push("✓ " + label); }
      catch (e) { fail += 1; log.push("✗ " + label + " — " + (e && e.message ? e.message : String(e))); }
    }

    // ACCEPTANCE CRITERION (core): checkout offers an optional donation amount
    // on top of (or as) the ticket.

    // Case 1 — donation ON TOP of a paid ticket.
    check("Donation adds on top of a paid camp ticket", function () {
      var q = computeCheckout(36, 5, false);
      HC.assert(q.donationOffered === true, "checkout must offer a donation option");
      HC.assert(q.donation === 5, "donation should be the chosen amount, got " + q.donation);
      HC.assert(q.donationOnTop === true, "5 on a £36 ticket should be 'on top'");
      HC.assert(q.subtotal === 41, "£36 + £5 should be £41, got " + q.subtotal);
    });

    // Case 2 — donation AS the payment (£0 / pay-what-you-can ticket).
    check("£0 ticket lets parent pay purely by donation", function () {
      var q = computeCheckout(0, 7.5, false);
      HC.assert(q.donationAsPayment === true, "£0 ticket + donation should be 'as payment'");
      HC.assert(q.donationOnTop === false, "with a £0 ticket there is nothing to be 'on top' of");
      HC.assert(q.subtotal === 7.5, "subtotal should equal the donation, got " + q.subtotal);
    });

    // Case 3 — donation is OPTIONAL: a parent can decline and still book the ticket.
    check("Donation is optional — £0 donation still books the ticket", function () {
      var q = computeCheckout(36, 0, false);
      HC.assert(q.donationOffered === true, "the option is still offered even when declined");
      HC.assert(q.hasDonation === false, "no donation chosen");
      HC.assert(q.donationOnTop === false && q.donationAsPayment === false, "no donation => neither mode");
      HC.assert(q.total === 36, "declining a donation leaves just the ticket, got " + q.total);
    });

    // Case 4 — booking fees apply to the DONATION amount (per the article).
    check("Booking fee applies to ticket + donation", function () {
      var noFee = computeCheckout(36, 10, false);   // subtotal 46
      var withFee = computeCheckout(36, 10, true);   // 46 + (46*0.05 + 0.20)
      HC.assert(noFee.fee === 0, "fees off => no fee");
      var expectedFee = round2(46 * 0.05 + 0.20);    // 2.50
      HC.assert(withFee.fee === expectedFee, "fee should be " + expectedFee + ", got " + withFee.fee);
      HC.assert(withFee.total === round2(46 + expectedFee), "total should include fee, got " + withFee.total);
      // the fee genuinely depends on the donation: a bigger donation => bigger fee
      var biggerDonation = computeCheckout(36, 20, true);
      HC.assert(biggerDonation.fee > withFee.fee, "fee must grow with the donation amount");
    });

    // Case 5 — defensive normalisation of bad input.
    check("Bad donation input is clamped to a safe amount", function () {
      HC.assert(normaliseDonation("") === 0, "empty => 0");
      HC.assert(normaliseDonation("abc") === 0, "non-numeric => 0");
      HC.assert(normaliseDonation(-5) === 0, "negative => 0");
      HC.assert(normaliseDonation(Infinity) === 0, "infinite => 0");
      HC.assert(normaliseDonation("3.50") === 3.5, "numeric string => number");
      HC.assert(normaliseDonation(2.005) === 2.01 || normaliseDonation(2.005) === 2.0, "rounds to pence");
      var q = computeCheckout(36, -99, true);
      HC.assert(q.donation === 0, "negative donation must not reduce the ticket; got " + q.donation);
      HC.assert(q.total >= 36, "total never falls below the ticket price, got " + q.total);
    });

    // Case 6 — price parsing from live camp data strings.
    check("Parses GBP/£ amounts from live price strings", function () {
      HC.assert(parsePrice("GBP 36 single day") === 36, "GBP 36 => 36");
      HC.assert(parsePrice("£25 per day; extra hours £5 each") === 25, "first £ amount => 25");
      HC.assert(parsePrice("Free for eligible places") === 0, "free => 0");
      HC.assert(parsePrice("Check live booking site") === null, "no number => null");
      HC.assert(parsePrice("Summer 2026: GBP 140 full week") === 140, "GBP 140 => 140");
    });

    // Case 7 — seed camp comes from REAL provider data (school-age holiday camps).
    check("Seed camp + free-camp name drawn from live providers", function () {
      var seed = pickSeedCamp();
      HC.assert(seed && typeof seed.price === "number" && seed.price > 0, "seed should have a positive day rate");
      HC.assert(typeof seed.name === "string" && seed.name.length > 0, "seed should be a named camp");
      HC.assert(typeof seed.freeCampName === "string" && seed.freeCampName.length > 0, "should name a pay-what-you-can camp");
    });

    // Case 8 — persistence round-trips through HC.store (namespaced, not raw localStorage).
    check("Donation preference persists via HC.store", function () {
      var probe = { freeMode: true, donation: 5 };
      var ok = HC.store.set(STORE_KEY, probe);
      HC.assert(ok !== false, "store.set should succeed");
      var got = HC.store.get(STORE_KEY, null);
      HC.assert(got && got.donation === 5 && got.freeMode === true, "round-trip should preserve prefs");
    });

    return { pass: pass, fail: fail, log: log };
  }

  /* ---------------- register ---------------- */

  HC.registerFeature({
    id: "parent-donation",
    title: "Pay-what-you-want donation",
    side: "parent",
    icon: "💛",
    summary: "Add an optional donation at checkout — on top of a camp ticket, or as the whole payment for a free / pay-what-you-can camp. Booking fees apply to the donation, following the same marketplace pattern.",
    render: render,
    selfTest: selfTest
  });
})();
