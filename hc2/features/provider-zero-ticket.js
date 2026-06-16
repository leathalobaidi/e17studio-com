/* HolidayCamp feature — provider-zero-ticket
 *
 * Set a £0 / FREE ticket — booked with NO commission and NO fees.  (PROVIDER side)
 *
 * Replicates Happity's free-ticket behaviour. Evidence (support articles):
 *   - 4021041 "Setting a £0 ticket for online classes": providers can set a
 *     ticket price of £0 so a session is bookable (builds a register / knows
 *     who's turning up) without taking payment.
 *   - 6076060 "Are there Membership Discounts for Charities or CICs?":
 *       "Yes, anyone with a Happity Membership can offer free tickets to their
 *        customers. If you want to make your classes bookable so you can create
 *        a register and know who's turning up, you'll still need to activate
 *        bookings by connecting your Stripe account — but you WON'T be charged
 *        any commission or fees for tickets that are free. You also have the
 *        option of 'add donation option at checkout', for which commission,
 *        fees and VAT will apply."
 *   - 2381444 "Pricing, commission and fees": the fee model that a £0 ticket
 *     escapes — Commission 2.5% + VAT (20%) on the commission, Stripe 1.5% + 20p.
 *
 * Framed for SCHOOL-AGE HOLIDAY CAMPS: a holiday-camp provider lists a free
 * taster morning, a HAF-funded place, or a community open day. Setting the
 * ticket to £0 makes it bookable (so they get a register of which children are
 * turning up) while charging the provider nothing — no commission, no VAT, no
 * Stripe fee. If the provider switches the OPTIONAL donation-at-checkout on,
 * and a parent donates, then commission + VAT + Stripe fee apply to the
 * donation amount only (the ticket itself stays free).
 *
 * ACCEPTANCE CRITERION (exercised by selfTest):
 *   A £0 ticket books with NO fee charged.
 *
 * Self-contained, defensive, no imports/exports. Calls HC.registerFeature.
 */
(function () {
  "use strict";

  // Defensive: never throw at module load if HC isn't present.
  if (typeof window === "undefined" || !window.HC || typeof window.HC.registerFeature !== "function") {
    if (typeof console !== "undefined" && console.warn) {
      console.warn("[HC] provider-zero-ticket: HC core not found; skipping registration.");
    }
    return;
  }

  var HC = window.HC;

  var STORE_KEY = "provider_zero_ticket_state";

  /* ---------------- fee model (evidence 2381444) ---------------- */
  var COMMISSION_PCT = 0.025;   // 2.5% commission on the amount the customer pays
  var VAT_PCT = 0.20;           // 20% VAT, charged ON the commission
  var STRIPE_FEE_PCT = 0.015;   // 1.5% Stripe processing
  var STRIPE_FEE_FIXED = 0.20;  // + 20p, in pounds

  /* ---------------- tiny helpers ---------------- */
  function round2(n) {
    return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
  }

  function nowIso() {
    try { return new Date().toISOString(); } catch (e) { return "" + Date.now(); }
  }

  function safeUid() {
    try { return HC.util.uid(); } catch (e) { return "id_" + Math.random().toString(36).slice(2); }
  }

  // Coerce any price input to a clean, non-negative number of pounds.
  // "£0", "0", "", null, "free", "FREE" -> 0. "12.50" -> 12.5. Negatives clamp to 0.
  function normalisePrice(raw) {
    if (raw === null || raw === undefined) return 0;
    if (typeof raw === "number") return isFinite(raw) && raw > 0 ? round2(raw) : 0;
    var s = String(raw).trim().toLowerCase();
    if (s === "" || s === "free" || s === "£0" || s === "0") return 0;
    var cleaned = s.replace(/[£,\s]/g, "");
    var n = Number(cleaned);
    if (!isFinite(n) || n <= 0) return 0;
    return round2(n);
  }

  // Is this a free ticket? Free === price resolves to exactly £0.
  function isFree(rawPrice) {
    return normalisePrice(rawPrice) === 0;
  }

  /* ---------------- pure fee calculation (the heart of the feature) ----------------
   *
   * Given the amount the CUSTOMER PAYS (in £), return the fee breakdown the
   * PROVIDER bears. The single rule that makes the acceptance criterion true:
   * if the customer pays £0, every fee component is £0 (no commission, no VAT,
   * no Stripe fee) — because no money moves, so there is nothing to take a cut
   * of and Stripe never runs a charge.
   *
   * Returns (never throws):
   *   {
   *     customerPays, commission, vat, stripeFee, totalFee, providerReceives, free
   *   }
   */
  function feeBreakdown(amountPaid) {
    var pays = normalisePrice(amountPaid);

    if (pays === 0) {
      // FREE: nothing changes hands -> zero fees of every kind.
      return {
        customerPays: 0,
        commission: 0,
        vat: 0,
        stripeFee: 0,
        totalFee: 0,
        providerReceives: 0,
        free: true
      };
    }

    var commission = round2(pays * COMMISSION_PCT);
    var vat = round2(commission * VAT_PCT);
    var stripeFee = round2(pays * STRIPE_FEE_PCT + STRIPE_FEE_FIXED);
    var totalFee = round2(commission + vat + stripeFee);
    return {
      customerPays: pays,
      commission: commission,
      vat: vat,
      stripeFee: stripeFee,
      totalFee: totalFee,
      providerReceives: round2(pays - totalFee),
      free: false
    };
  }

  /* ---------------- booking a free ticket ----------------
   *
   * Book a place against a ticket. A £0 ticket books with NO fee charged.
   * If a donation is added at checkout (only possible when the ticket is free
   * AND the provider enabled donations), the donation is treated as a separate
   * PAID line: it attracts commission + VAT + Stripe fee per the evidence.
   *
   * ticket: { price, donationsEnabled }
   * opts:   { donation }  (parent's optional donation £, only honoured if enabled)
   *
   * Returns a booking record (never throws):
   *   {
   *     id, ticketPrice, free, donation,
   *     fee: feeBreakdown(amount actually charged),
   *     amountCharged, register: true, createdAt
   *   }
   */
  function bookTicket(ticket, opts) {
    ticket = ticket || {};
    opts = opts || {};
    var price = normalisePrice(ticket.price);
    var free = price === 0;

    // Donation only applies to a FREE ticket whose provider switched donations on.
    var donation = 0;
    if (free && ticket.donationsEnabled) {
      donation = normalisePrice(opts.donation);
    }

    // Amount actually charged to the card: the ticket price plus any donation.
    var amountCharged = round2(price + donation);
    var fee = feeBreakdown(amountCharged);

    return {
      id: safeUid(),
      ticketPrice: price,
      free: free,
      donation: donation,
      amountCharged: amountCharged,
      fee: fee,
      // Even a free ticket still builds a register (the whole point per evidence).
      register: true,
      createdAt: nowIso()
    };
  }

  /* ---------------- persisted ticket config (provider's saved choices) ---------------- */
  function loadState() {
    var s = HC.store.get(STORE_KEY, null);
    if (!s || typeof s !== "object") s = { byProvider: {} };
    if (!s.byProvider || typeof s.byProvider !== "object") s.byProvider = {};
    return s;
  }

  function saveTicketConfig(providerId, cfg) {
    try {
      var s = loadState();
      s.byProvider[providerId] = {
        price: normalisePrice(cfg && cfg.price),
        donationsEnabled: !!(cfg && cfg.donationsEnabled),
        label: (cfg && cfg.label) ? String(cfg.label) : "",
        savedAt: nowIso()
      };
      HC.store.set(STORE_KEY, s);
      return s.byProvider[providerId];
    } catch (e) {
      return null;
    }
  }

  function loadTicketConfig(providerId) {
    var s = loadState();
    return s.byProvider[providerId] || null;
  }

  /* ---------------- a sensible default provider id from live data ---------------- */
  function defaultProviderId() {
    try {
      var ps = HC.data.providers;
      if (ps && ps.length) return ps[0].id || ps[0].slug || ps[0].name || "provider-0";
    } catch (e) { /* ignore */ }
    return "provider-0";
  }

  /* ================================================================
   * UI — render(mountEl). A small interactive panel where a provider
   * sets a ticket price (try 0), optionally turns on donations, and
   * sees the live fee breakdown + a "book it" demo.
   * ================================================================ */
  function render(mountEl) {
    try {
      var pid = defaultProviderId();
      var saved = loadTicketConfig(pid) || { price: 0, donationsEnabled: false };

      mountEl.innerHTML =
        '<div style="font-family:Nunito Sans,system-ui,sans-serif;color:#383838;font-size:14px;line-height:1.55">' +
          '<p style="margin:0 0 14px">Set a ticket price for a holiday-camp session. ' +
          'Make it <strong>£0</strong> for a free taster, a HAF-funded place or a community open day — ' +
          'it stays fully bookable (you still get a register of who is turning up) but ' +
          '<strong>no commission and no fees</strong> are charged.</p>' +

          '<label style="display:block;font-family:Quicksand,system-ui,sans-serif;font-weight:700;color:#603488;margin:0 0 4px">Ticket price (£)</label>' +
          '<input id="hcztPrice" type="number" min="0" step="0.50" value="' + (saved.price || 0) + '" ' +
            'style="width:140px;padding:9px 11px;border:1.5px solid #E6E6E6;border-radius:12px;font-size:15px;font-family:inherit" />' +
          '<button id="hcztFreeBtn" type="button" class="hc-btn hc-btn-ghost" style="margin-left:8px">Make it free (£0)</button>' +

          '<label style="display:flex;align-items:center;gap:8px;margin:16px 0 4px;font-family:Quicksand,system-ui,sans-serif;font-weight:700;color:#603488">' +
            '<input id="hcztDon" type="checkbox" ' + (saved.donationsEnabled ? "checked" : "") + ' /> ' +
            'Add a donation option at checkout (optional)</label>' +
          '<p style="margin:0 0 14px;font-size:12.5px;color:#808080">' +
            'Donations are pay-as-you-want. Commission, VAT &amp; Stripe fees apply to any donation amount — ' +
            'never to the free ticket itself.</p>' +

          '<div id="hcztBreak" style="background:#F0E8F4;border-radius:14px;padding:14px 16px;margin:6px 0 14px"></div>' +

          '<div style="display:flex;gap:8px;flex-wrap:wrap">' +
            '<button id="hcztBook" type="button" class="hc-btn">Book this ticket (demo)</button>' +
            '<button id="hcztSave" type="button" class="hc-btn hc-btn-ghost">Save ticket</button>' +
          '</div>' +
          '<div id="hcztBooked" style="margin-top:12px;font-size:13.5px"></div>' +
        '</div>';

      var priceInput = mountEl.querySelector("#hcztPrice");
      var donInput = mountEl.querySelector("#hcztDon");
      var breakBox = mountEl.querySelector("#hcztBreak");
      var bookedBox = mountEl.querySelector("#hcztBooked");

      function gbp(n) {
        try { return "£" + Number(n).toFixed(2); } catch (e) { return "£0.00"; }
      }

      function refresh() {
        var price = normalisePrice(priceInput.value);
        var fee = feeBreakdown(price);
        if (fee.free) {
          breakBox.innerHTML =
            '<div style="font-family:Quicksand,system-ui,sans-serif;font-weight:700;color:#2f7d4f;font-size:16px">✓ Free ticket — £0 fees</div>' +
            '<p style="margin:6px 0 0;font-size:13px;color:#383838">Commission £0.00 · VAT £0.00 · Stripe £0.00 · ' +
            '<strong>Total fee £0.00</strong>. Bookable, builds a register, costs you nothing.</p>';
        } else {
          breakBox.innerHTML =
            '<div style="font-family:Quicksand,system-ui,sans-serif;font-weight:700;color:#603488;font-size:15px">Paid ticket — fees apply</div>' +
            '<p style="margin:6px 0 0;font-size:13px;color:#383838">Customer pays ' + gbp(fee.customerPays) +
            ' · Commission ' + gbp(fee.commission) + ' · VAT ' + gbp(fee.vat) +
            ' · Stripe ' + gbp(fee.stripeFee) + ' · <strong>Total fee ' + gbp(fee.totalFee) + '</strong>' +
            ' · You receive ' + gbp(fee.providerReceives) + '</p>';
        }
      }

      priceInput.addEventListener("input", refresh);
      donInput.addEventListener("change", refresh);

      mountEl.querySelector("#hcztFreeBtn").addEventListener("click", function () {
        priceInput.value = "0";
        refresh();
        try { HC.util.toast("Ticket set to free — no fees"); } catch (e) {}
      });

      mountEl.querySelector("#hcztBook").addEventListener("click", function () {
        var rec = bookTicket(
          { price: priceInput.value, donationsEnabled: donInput.checked },
          { donation: donInput.checked ? 5 : 0 }
        );
        var feeLine = rec.fee.totalFee === 0
          ? '<span style="color:#2f7d4f;font-weight:700">No fee charged ✓</span>'
          : '<span style="color:#603488;font-weight:700">Total fee ' + gbp(rec.fee.totalFee) + '</span>';
        bookedBox.innerHTML =
          'Booked place <code>' + rec.id.slice(0, 10) + '</code> · ' +
          (rec.free ? "free ticket" : "paid " + gbp(rec.ticketPrice)) +
          (rec.donation ? " + " + gbp(rec.donation) + " donation" : "") +
          ' · charged ' + gbp(rec.amountCharged) + ' · ' + feeLine +
          ' · on the register ✓';
        try { HC.util.toast(rec.free ? "Free place booked — £0 fees" : "Place booked"); } catch (e) {}
      });

      mountEl.querySelector("#hcztSave").addEventListener("click", function () {
        var cfg = saveTicketConfig(pid, {
          price: priceInput.value,
          donationsEnabled: donInput.checked,
          label: "Holiday-camp ticket"
        });
        try { HC.util.toast(cfg && cfg.price === 0 ? "Saved free ticket" : "Saved ticket"); } catch (e) {}
      });

      refresh();
    } catch (e) {
      mountEl.innerHTML = '<p style="color:#9a1f5e">Preview unavailable: ' +
        (e && e.message ? e.message : String(e)) + "</p>";
    }
  }

  /* ================================================================
   * selfTest — exercises the LOGIC and asserts the acceptance criterion:
   * a £0 ticket books with NO fee charged. Multiple cases.
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

    // --- price normalisation: many shapes of "free" all resolve to £0 ---
    check("normalisePrice treats £0 / 0 / '' / 'free' / null as £0", function () {
      A(normalisePrice(0) === 0, "0 -> 0");
      A(normalisePrice("0") === 0, "'0' -> 0");
      A(normalisePrice("£0") === 0, "'£0' -> 0");
      A(normalisePrice("") === 0, "'' -> 0");
      A(normalisePrice("free") === 0, "'free' -> 0");
      A(normalisePrice("FREE") === 0, "'FREE' -> 0");
      A(normalisePrice(null) === 0, "null -> 0");
      A(normalisePrice(-5) === 0, "negative clamps to 0");
    });

    check("isFree() is true for zero-priced tickets only", function () {
      A(isFree(0) === true, "0 is free");
      A(isFree("£0") === true, "'£0' is free");
      A(isFree(8) === false, "£8 is not free");
    });

    // --- ACCEPTANCE CRITERION: £0 ticket -> every fee component is £0 ---
    check("ACCEPTANCE: feeBreakdown(£0) charges NO commission, VAT or Stripe fee", function () {
      var f = feeBreakdown(0);
      A(f.free === true, "marked free");
      A(f.commission === 0, "commission must be £0, got " + f.commission);
      A(f.vat === 0, "VAT must be £0, got " + f.vat);
      A(f.stripeFee === 0, "Stripe fee must be £0, got " + f.stripeFee);
      A(f.totalFee === 0, "total fee must be £0, got " + f.totalFee);
    });

    // --- ACCEPTANCE CRITERION: booking a £0 ticket charges no fee ---
    check("ACCEPTANCE: booking a £0 ticket -> amountCharged 0 and totalFee 0", function () {
      var rec = bookTicket({ price: 0 });
      A(rec.free === true, "booking flagged free");
      A(rec.amountCharged === 0, "nothing charged, got " + rec.amountCharged);
      A(rec.fee.totalFee === 0, "no fee, got " + rec.fee.totalFee);
      A(rec.register === true, "free ticket still builds a register");
    });

    check("ACCEPTANCE: a '£0' string-priced ticket also books with no fee", function () {
      var rec = bookTicket({ price: "£0" });
      A(rec.free === true, "free");
      A(rec.fee.totalFee === 0, "no fee for £0 string price");
    });

    // --- contrast: a PAID ticket DOES attract the documented fees ---
    check("Contrast: a paid £8 ticket DOES attract commission + VAT + Stripe fee", function () {
      var f = feeBreakdown(8);
      A(f.free === false, "not free");
      // 2.5% of 8 = 0.20 ; VAT 20% of 0.20 = 0.04 ; Stripe 1.5%*8 + 0.20 = 0.32
      A(f.commission === 0.20, "commission 0.20, got " + f.commission);
      A(f.vat === 0.04, "VAT 0.04, got " + f.vat);
      A(f.stripeFee === 0.32, "Stripe 0.32, got " + f.stripeFee);
      A(f.totalFee === 0.56, "total 0.56 (matches evidence 2381444), got " + f.totalFee);
    });

    // --- donation on a free ticket: ticket stays free, donation is the only paid line ---
    check("Free ticket + donation: ticket free, but donation attracts fees", function () {
      var rec = bookTicket({ price: 0, donationsEnabled: true }, { donation: 10 });
      A(rec.free === true, "ticket itself is free");
      A(rec.donation === 10, "donation captured, got " + rec.donation);
      A(rec.amountCharged === 10, "only the donation is charged, got " + rec.amountCharged);
      A(rec.fee.totalFee > 0, "donation attracts a fee (commission+VAT+Stripe), got " + rec.fee.totalFee);
      // donation 10: commission 0.25, VAT 0.05, Stripe 0.15+0.20=0.35 -> 0.65
      A(rec.fee.totalFee === 0.65, "expected 0.65 on a £10 donation, got " + rec.fee.totalFee);
    });

    check("Donation ignored when provider has NOT enabled donations", function () {
      var rec = bookTicket({ price: 0, donationsEnabled: false }, { donation: 10 });
      A(rec.donation === 0, "donation dropped, got " + rec.donation);
      A(rec.amountCharged === 0, "still nothing charged, got " + rec.amountCharged);
      A(rec.fee.totalFee === 0, "still no fee, got " + rec.fee.totalFee);
    });

    // --- persistence round-trips through HC.store (mock, hc_ namespaced) ---
    check("Saving a free ticket config round-trips via HC.store", function () {
      var pid = "test_provider_" + safeUid();
      var saved = saveTicketConfig(pid, { price: "£0", donationsEnabled: true, label: "Taster" });
      A(saved && saved.price === 0, "saved price normalised to 0");
      var back = loadTicketConfig(pid);
      A(back && back.price === 0, "loaded price is 0");
      A(back.donationsEnabled === true, "loaded donations flag");
      // clean up so we don't leak test state into the demo
      try {
        var s = loadState();
        delete s.byProvider[pid];
        HC.store.set(STORE_KEY, s);
      } catch (e) { /* ignore */ }
    });

    return { pass: pass, fail: fail, log: log };
  }

  /* ---------------- register ---------------- */
  HC.registerFeature({
    id: "provider-zero-ticket",
    title: "Free (£0) tickets",
    side: "provider",
    icon: "🎟️",
    summary: "Set a ticket to £0 so a session is fully bookable (you still get a register) — with no commission and no fees charged. Optional donation-at-checkout does attract fees.",
    render: render,
    selfTest: selfTest
  });
})();
