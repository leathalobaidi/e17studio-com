/* HolidayCamp feature — parent-multi-child
 *
 * Replicates Happity's "How can I book for multiple children or additional
 * adults?" behaviour (support article 8255720):
 *
 *   "Booking for multiple children/twins or additional adults is based on what
 *    tickets the class providers offer ... Often they offer sibling tickets and
 *    on some occasions additional adult tickets."
 *
 * So the set of ticket types a parent can add at checkout is DERIVED from the
 * provider's own data, not hard-coded:
 *   - Child (full price)  — always offered, one per child attending.
 *   - Sibling             — offered only when the provider runs a sibling
 *                           discount (planner `siblingDiscount` flag / a sibling
 *                           code in priceBasis). Like Happity, a sibling ticket
 *                           cannot be bought on its own: it needs at least one
 *                           full-price child ticket alongside it.
 *   - Additional adult    — offered "on some occasions" (e.g. SEND-aware camps
 *                           that allow a supporting adult, or where the price
 *                           feed mentions an adult/carer rate).
 *
 * Framed for SCHOOL-AGE HOLIDAY CAMPS (per-day or per-week tickets), not baby
 * classes. Persistence is via HC.store (the mock "hc_" localStorage namespace).
 *
 * Plain browser JS — no imports/exports. Must pass `node --check`.
 */
(function () {
  "use strict";

  if (typeof window === "undefined" || !window.HC || typeof window.HC.registerFeature !== "function") {
    // Defensive: nothing to attach to. Never throw at load time.
    return;
  }

  var HC = window.HC;
  var STORE_KEY = "basket.multiChild";

  /* ============================================================
     PURE LOGIC  (no DOM) — this is what selfTest exercises.
     ============================================================ */

  // Sibling discount: 10% off each sibling ticket vs. the full child price.
  var SIBLING_DISCOUNT = 0.10;
  var SIBLING_MIN_FULL_TICKETS = 1; // a sibling ticket needs >=1 full child ticket

  /* Read a provider's planner enrichment record (price, flags) defensively. */
  function plannerRecord(providerId) {
    try {
      var byId = (HC.data.planner && HC.data.planner.byId) || {};
      return byId[providerId] || {};
    } catch (e) {
      return {};
    }
  }

  /* Find a provider object from the live directory by id. */
  function findProvider(providerId) {
    try {
      var list = HC.data.providers || [];
      for (var i = 0; i < list.length; i++) {
        if (list[i] && list[i].id === providerId) return list[i];
      }
    } catch (e) { /* ignore */ }
    return null;
  }

  /* Pick a usable base unit price for a provider (per day preferred, else week,
     else a sensible fallback). Returns { amount, unit } or null if unknown. */
  function basePrice(providerId) {
    var rec = plannerRecord(providerId);
    var p = rec && rec.price;
    if (p && typeof p === "object") {
      if (typeof p.day === "number" && isFinite(p.day)) return { amount: p.day, unit: "day" };
      if (typeof p.dayExtended === "number" && isFinite(p.dayExtended)) return { amount: p.dayExtended, unit: "day" };
      if (typeof p.week === "number" && isFinite(p.week)) return { amount: p.week, unit: "week" };
      if (typeof p.halfDay === "number" && isFinite(p.halfDay)) return { amount: p.halfDay, unit: "half-day" };
      if (typeof p.sessionFrom === "number" && isFinite(p.sessionFrom)) return { amount: p.sessionFrom, unit: "session" };
    }
    return null;
  }

  /* Does the provider offer a SIBLING ticket?  (Happity: "what tickets the
     provider offers".)  True when the planner marks a sibling discount or the
     price basis text references a sibling code/rate. */
  function offersSibling(providerId) {
    var rec = plannerRecord(providerId);
    if (rec && rec.siblingDiscount === true) return true;
    var basis = rec && rec.priceBasis;
    if (typeof basis === "string" && /sibling/i.test(basis)) return true;
    return false;
  }

  /* Does the provider offer an ADDITIONAL ADULT ticket?  Offered "on some
     occasions": SEND-aware camps that welcome a supporting adult, or a feed
     that mentions an adult/carer rate. */
  function offersAdult(providerId) {
    var rec = plannerRecord(providerId);
    if (rec && rec.sendAware === true) return true;
    if (rec && rec.adultTicket === true) return true;
    var basis = rec && rec.priceBasis;
    if (typeof basis === "string" && /\b(adult|carer)\b/i.test(basis)) return true;
    return false;
  }

  /* Build the list of ticket TYPES a parent can add for this provider.
     Always includes "child"; conditionally "sibling" and "adult". */
  function availableTicketTypes(providerId) {
    var base = basePrice(providerId);
    var unit = base ? base.unit : "day";
    var childPrice = base ? base.amount : 0;
    var types = [];

    types.push({
      type: "child",
      label: "Child place",
      unit: unit,
      price: round2(childPrice),
      offered: true,
      requiresFull: false,
      note: "Full-price place, one per child attending."
    });

    types.push({
      type: "sibling",
      label: "Sibling place",
      unit: unit,
      price: round2(childPrice * (1 - SIBLING_DISCOUNT)),
      offered: offersSibling(providerId),
      requiresFull: true,
      note: "10% off — for a brother or sister of a full-price child. Can only be added alongside a full-price place."
    });

    types.push({
      type: "adult",
      label: "Additional adult",
      unit: unit,
      // Many camps charge a reduced supporting-adult rate; model as half the
      // child place where offered (kept simple + deterministic for tests).
      price: round2(childPrice * 0.5),
      offered: offersAdult(providerId),
      requiresFull: false,
      note: "Extra supporting adult, where the camp allows one."
    });

    return types;
  }

  function round2(n) {
    var x = Number(n);
    if (!isFinite(x)) return 0;
    return Math.round(x * 100) / 100;
  }

  /* A basket line is { id, type, qty }. Price all lines for a provider,
     enforcing the Happity rule that a sibling ticket needs a full-price child.
     Returns { lines:[{...,unitPrice,lineTotal}], total, counts, errors }. */
  function priceBasket(providerId, lines) {
    var types = availableTicketTypes(providerId);
    var typeById = {};
    types.forEach(function (t) { typeById[t.type] = t; });

    var counts = { child: 0, sibling: 0, adult: 0 };
    var priced = [];
    var errors = [];
    var total = 0;

    (lines || []).forEach(function (ln) {
      if (!ln || !ln.type) return;
      var def = typeById[ln.type];
      var qty = Math.max(0, Math.floor(Number(ln.qty) || 0));
      if (!def) {
        errors.push("Unknown ticket type: " + ln.type);
        return;
      }
      if (!def.offered) {
        errors.push(def.label + " is not offered by this camp.");
        return;
      }
      counts[ln.type] = (counts[ln.type] || 0) + qty;
      var thisTotal = round2(qty * def.price);
      total = round2(total + thisTotal);
      priced.push({
        id: ln.id || HC.util.uid(),
        type: ln.type,
        label: def.label,
        unit: def.unit,
        qty: qty,
        unitPrice: def.price,
        lineTotal: thisTotal
      });
    });

    // Happity rule: sibling tickets only alongside a full-price (child) ticket.
    if (counts.sibling > 0 && counts.child < SIBLING_MIN_FULL_TICKETS) {
      errors.push("A sibling place can only be booked alongside a full-price child place.");
    }

    return {
      providerId: providerId,
      lines: priced,
      counts: counts,
      total: round2(total),
      valid: errors.length === 0 && (counts.child + counts.sibling + counts.adult) > 0,
      errors: errors
    };
  }

  /* Persisted basket helpers (mock store). */
  function loadBasket() {
    var b = HC.store.get(STORE_KEY, null);
    if (!b || typeof b !== "object") return { providerId: null, lines: [] };
    if (!Array.isArray(b.lines)) b.lines = [];
    return b;
  }
  function saveBasket(b) { return HC.store.set(STORE_KEY, b); }
  function clearBasket() { return HC.store.set(STORE_KEY, { providerId: null, lines: [] }); }

  /* ============================================================
     RENDER  (DOM) — a working checkout UI into mountEl.
     ============================================================ */

  function pickDefaultProviderId(preferOffered) {
    var list = HC.data.providers || [];
    // Prefer a provider that offers a sibling AND has a price, so the demo
    // shows the full ticket spread by default.
    var withSibling = null, withPrice = null;
    for (var i = 0; i < list.length; i++) {
      var id = list[i] && list[i].id;
      if (!id) continue;
      if (!withPrice && basePrice(id)) withPrice = id;
      if (!withSibling && basePrice(id) && offersSibling(id)) withSibling = id;
    }
    if (preferOffered && withSibling) return withSibling;
    return withSibling || withPrice || (list[0] && list[0].id) || null;
  }

  function render(mountEl) {
    try {
      var el = HC.util.el;
      mountEl.innerHTML = "";

      var providers = (HC.data.providers || []).filter(function (p) { return p && basePrice(p.id); });
      if (!providers.length) {
        mountEl.innerHTML = '<p style="color:var(--muted,#808080)">No camps with published prices to check out yet.</p>';
        return;
      }

      var state = {
        providerId: pickDefaultProviderId(true),
        qty: { child: 1, sibling: 0, adult: 0 }
      };

      var intro = el("p", { style: "font-size:14px;color:var(--text,#383838);margin:0 0 14px" },
        "Booking for multiple children, twins or an extra adult depends on the tickets each camp offers. " +
        "Pick a camp, then add the places you need. Sibling and additional-adult tickets only appear when that camp offers them.");
      mountEl.appendChild(intro);

      // Provider picker
      var sel = el("select", {
        class: "hc-mc-provider",
        style: "width:100%;padding:10px 12px;border:1.5px solid var(--line,#E6E6E6);border-radius:12px;font-size:14px;margin:0 0 16px;font-family:inherit"
      });
      providers.forEach(function (p) {
        var o = el("option", { value: p.id }, escapeHtml(p.name));
        if (p.id === state.providerId) o.setAttribute("selected", "selected");
        sel.appendChild(o);
      });
      mountEl.appendChild(sel);

      var ticketsHost = el("div", { class: "hc-mc-tickets" });
      var summaryHost = el("div", { class: "hc-mc-summary", style: "margin-top:14px" });
      mountEl.appendChild(ticketsHost);
      mountEl.appendChild(summaryHost);

      function rowsForState() {
        return [
          { id: "ln-child", type: "child", qty: state.qty.child },
          { id: "ln-sibling", type: "sibling", qty: state.qty.sibling },
          { id: "ln-adult", type: "adult", qty: state.qty.adult }
        ];
      }

      function stepper(typeDef) {
        var wrap = el("div", {
          style: "display:flex;justify-content:space-between;align-items:center;gap:12px;padding:12px 0;border-bottom:1px solid var(--line,#E6E6E6)"
        });
        var left = el("div", {}, "");
        left.appendChild(el("div", {
          style: "font-family:Quicksand,system-ui,sans-serif;font-weight:700;color:var(--purple,#603488);font-size:15px"
        }, escapeHtml(typeDef.label) + " · " + HC.util.money(typeDef.price) + "/" + escapeHtml(typeDef.unit)));
        left.appendChild(el("div", { style: "font-size:12px;color:var(--muted,#808080);margin-top:2px" }, escapeHtml(typeDef.note)));

        var right = el("div", { style: "display:flex;align-items:center;gap:10px;flex:0 0 auto" });
        var minus = el("button", { type: "button", class: "hc-btn hc-btn-ghost", style: "padding:4px 12px;min-width:36px" }, "−");
        var count = el("span", { style: "min-width:22px;text-align:center;font-weight:700;font-family:Quicksand,system-ui,sans-serif" }, String(state.qty[typeDef.type]));
        var plus = el("button", { type: "button", class: "hc-btn", style: "padding:4px 12px;min-width:36px" }, "+");

        minus.addEventListener("click", function () {
          state.qty[typeDef.type] = Math.max(0, state.qty[typeDef.type] - 1);
          redraw();
        });
        plus.addEventListener("click", function () {
          state.qty[typeDef.type] = state.qty[typeDef.type] + 1;
          redraw();
        });

        right.appendChild(minus);
        right.appendChild(count);
        right.appendChild(plus);
        wrap.appendChild(left);
        wrap.appendChild(right);
        return wrap;
      }

      function redraw() {
        var types = availableTicketTypes(state.providerId);
        ticketsHost.innerHTML = "";

        types.forEach(function (t) {
          if (!t.offered) {
            // Show a muted "not offered" hint so the parent understands why.
            var off = el("div", {
              style: "display:flex;justify-content:space-between;align-items:center;padding:12px 0;border-bottom:1px solid var(--line,#E6E6E6);opacity:.55"
            });
            off.appendChild(el("div", {
              style: "font-family:Quicksand,system-ui,sans-serif;font-weight:700;color:var(--muted,#808080);font-size:15px"
            }, escapeHtml(t.label)));
            off.appendChild(el("span", { style: "font-size:12px;color:var(--muted,#808080)" }, "Not offered by this camp"));
            ticketsHost.appendChild(off);
            // Keep its qty pinned at 0 so it never lands in the basket.
            state.qty[t.type] = 0;
            return;
          }
          ticketsHost.appendChild(stepper(t));
        });

        var result = priceBasket(state.providerId, rowsForState());

        var sBox = el("div", {
          style: "background:var(--purple-tint,#F0E8F4);border-radius:14px;padding:14px 16px"
        });
        var headcount = result.counts.child + result.counts.sibling;
        sBox.appendChild(el("div", {
          style: "font-family:Quicksand,system-ui,sans-serif;font-weight:700;color:var(--purple,#603488);font-size:15px;margin-bottom:6px"
        }, headcount + (headcount === 1 ? " child" : " children") +
           (result.counts.adult ? " + " + result.counts.adult + " adult" + (result.counts.adult === 1 ? "" : "s") : "")));

        result.lines.forEach(function (ln) {
          if (ln.qty <= 0) return;
          sBox.appendChild(el("div", {
            style: "display:flex;justify-content:space-between;font-size:13.5px;color:var(--text,#383838);padding:2px 0"
          }, escapeHtml(ln.qty + "× " + ln.label) + "<span>" + escapeHtml(HC.util.money(ln.lineTotal)) + "</span>"));
        });

        sBox.appendChild(el("div", {
          style: "display:flex;justify-content:space-between;font-family:Quicksand,system-ui,sans-serif;font-weight:700;color:var(--purple,#603488);font-size:17px;border-top:1.5px solid rgba(96,52,136,.2);margin-top:8px;padding-top:8px"
        }, "Total" + "<span>" + escapeHtml(HC.util.money(result.total)) + "</span>"));

        if (result.errors.length) {
          result.errors.forEach(function (err) {
            sBox.appendChild(el("div", { style: "color:#9a1f5e;font-size:12.5px;margin-top:6px" }, "⚠ " + escapeHtml(err)));
          });
        }

        var checkout = el("button", {
          type: "button", class: "hc-btn", style: "width:100%;margin-top:12px;padding:11px"
        }, "Add to booking");
        if (!result.valid) checkout.setAttribute("disabled", "disabled");
        checkout.addEventListener("click", function () {
          var b = { providerId: state.providerId, lines: result.lines, total: result.total, savedAt: Date.now() };
          saveBasket(b);
          HC.util.toast("Added " + result.lines.length + " ticket type(s) — total " + HC.util.money(result.total));
        });
        sBox.appendChild(checkout);

        summaryHost.innerHTML = "";
        summaryHost.appendChild(sBox);
      }

      sel.addEventListener("change", function () {
        state.providerId = sel.value;
        state.qty = { child: 1, sibling: 0, adult: 0 };
        redraw();
      });

      redraw();
    } catch (e) {
      mountEl.innerHTML = '<p style="color:#9a1f5e">Checkout failed to render: ' +
        escapeHtml(e && e.message ? e.message : String(e)) + "</p>";
    }
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  /* ============================================================
     SELF TEST — exercises the LOGIC and asserts the acceptance
     criterion: checkout lets a parent add a sibling ticket and an
     adult ticket WHERE OFFERED.
     ============================================================ */

  function selfTest() {
    var pass = 0, fail = 0, log = [];
    function check(label, fn) {
      try { fn(); pass += 1; log.push("✓ " + label); }
      catch (e) { fail += 1; log.push("✗ " + label + " — " + (e && e.message ? e.message : String(e))); }
    }

    // Find real providers that offer each ticket type, from live data.
    var providers = HC.data.providers || [];
    var siblingProviderId = null, adultProviderId = null, pricedProviderId = null;
    for (var i = 0; i < providers.length; i++) {
      var id = providers[i] && providers[i].id;
      if (!id || !basePrice(id)) continue;
      if (!pricedProviderId) pricedProviderId = id;
      if (!siblingProviderId && offersSibling(id)) siblingProviderId = id;
      if (!adultProviderId && offersAdult(id)) adultProviderId = id;
    }

    check("Live data has at least one priced camp", function () {
      HC.assert(pricedProviderId, "no priced provider found");
    });

    check("Live data offers a sibling ticket somewhere", function () {
      HC.assert(siblingProviderId, "no provider with a sibling ticket in planner data");
    });

    // ---- ACCEPTANCE CRITERION (sibling) ----
    check("ACCEPTANCE: sibling-offering camp exposes child + sibling tickets", function () {
      var types = availableTicketTypes(siblingProviderId);
      var child = types.filter(function (t) { return t.type === "child"; })[0];
      var sib = types.filter(function (t) { return t.type === "sibling"; })[0];
      HC.assert(child && child.offered, "child ticket should be offered");
      HC.assert(sib && sib.offered === true, "sibling ticket should be offered where the camp runs a sibling discount");
    });

    check("ACCEPTANCE: parent can add a sibling ticket alongside a full child ticket", function () {
      var r = priceBasket(siblingProviderId, [
        { type: "child", qty: 1 },
        { type: "sibling", qty: 1 }
      ]);
      HC.assert(r.valid === true, "basket with 1 child + 1 sibling should be valid: " + r.errors.join("; "));
      HC.assert(r.counts.child === 1 && r.counts.sibling === 1, "counts should be 1 child + 1 sibling");
      HC.assert(r.lines.length === 2, "expected 2 priced lines, got " + r.lines.length);
    });

    check("Sibling place is cheaper than a full child place (10% off)", function () {
      var types = availableTicketTypes(siblingProviderId);
      var child = types.filter(function (t) { return t.type === "child"; })[0];
      var sib = types.filter(function (t) { return t.type === "sibling"; })[0];
      HC.assert(sib.price < child.price, "sibling (" + sib.price + ") should be < child (" + child.price + ")");
      HC.assert(Math.abs(sib.price - round2(child.price * 0.9)) < 0.011, "sibling should be ~10% off the child price");
    });

    // Happity rule: sibling cannot be bought alone.
    check("Sibling ticket cannot be added without a full-price child", function () {
      var r = priceBasket(siblingProviderId, [{ type: "sibling", qty: 1 }]);
      HC.assert(r.valid === false, "sibling-only basket should be invalid");
      HC.assert(r.errors.some(function (e) { return /alongside a full-price/i.test(e); }),
        "should explain the sibling needs a full-price place");
    });

    // ---- ACCEPTANCE CRITERION (additional adult) ----
    check("ACCEPTANCE: an adult ticket is offered by at least one camp", function () {
      HC.assert(adultProviderId, "no provider offers an additional-adult ticket in live data");
    });

    check("ACCEPTANCE: parent can add an adult ticket where offered", function () {
      var r = priceBasket(adultProviderId, [
        { type: "child", qty: 1 },
        { type: "adult", qty: 1 }
      ]);
      HC.assert(r.valid === true, "child + adult basket should be valid: " + r.errors.join("; "));
      HC.assert(r.counts.adult === 1, "expected 1 adult in counts");
      HC.assert(r.lines.some(function (l) { return l.type === "adult" && l.qty === 1; }), "adult line should be present");
    });

    // Where NOT offered, adding the ticket is rejected (so it only appears
    // "where offered", exactly as Happity describes).
    check("A camp that does not offer siblings rejects a sibling ticket", function () {
      var noSibId = null;
      for (var j = 0; j < providers.length; j++) {
        var pid = providers[j] && providers[j].id;
        if (pid && basePrice(pid) && !offersSibling(pid)) { noSibId = pid; break; }
      }
      if (!noSibId) { log.push("  (every priced camp offers siblings — skipping negative case)"); return; }
      var r = priceBasket(noSibId, [{ type: "child", qty: 1 }, { type: "sibling", qty: 1 }]);
      HC.assert(r.errors.some(function (e) { return /not offered/i.test(e); }),
        "sibling should be rejected as not offered for " + noSibId);
    });

    // Multi-child / twins headcount + totals arithmetic.
    check("Twins: two full child places price as 2× the day rate", function () {
      var base = basePrice(siblingProviderId);
      var r = priceBasket(siblingProviderId, [{ type: "child", qty: 2 }]);
      HC.assert(r.counts.child === 2, "expected 2 children");
      HC.assert(Math.abs(r.total - round2(base.amount * 2)) < 0.011,
        "two children should total " + round2(base.amount * 2) + ", got " + r.total);
    });

    check("Mixed basket total = child + sibling + adult line totals", function () {
      var pid = (adultProviderId && offersSibling(adultProviderId)) ? adultProviderId : siblingProviderId;
      var types = availableTicketTypes(pid);
      var byType = {};
      types.forEach(function (t) { byType[t.type] = t; });
      var rows = [{ type: "child", qty: 1 }];
      var expected = byType.child.price;
      if (byType.sibling.offered) { rows.push({ type: "sibling", qty: 1 }); expected += byType.sibling.price; }
      if (byType.adult.offered) { rows.push({ type: "adult", qty: 1 }); expected += byType.adult.price; }
      var r = priceBasket(pid, rows);
      HC.assert(r.valid === true, "mixed basket should be valid: " + r.errors.join("; "));
      HC.assert(Math.abs(r.total - round2(expected)) < 0.011,
        "total " + r.total + " should equal summed lines " + round2(expected));
    });

    // Persistence round-trip via the mock store.
    check("Basket persists and reloads via HC.store", function () {
      var r = priceBasket(siblingProviderId, [{ type: "child", qty: 1 }, { type: "sibling", qty: 1 }]);
      saveBasket({ providerId: siblingProviderId, lines: r.lines, total: r.total });
      var back = loadBasket();
      HC.assert(back.providerId === siblingProviderId, "providerId should round-trip");
      HC.assert(Array.isArray(back.lines) && back.lines.length === 2, "two lines should persist");
      clearBasket();
      var cleared = loadBasket();
      HC.assert(cleared.lines.length === 0, "basket should clear");
    });

    return { pass: pass, fail: fail, log: log };
  }

  /* ============================================================
     REGISTER
     ============================================================ */
  HC.registerFeature({
    id: "parent-multi-child",
    title: "Book for multiple children & extra adults",
    side: "parent",
    icon: "👧👦",
    summary: "Add sibling and additional-adult tickets at checkout — but only the ones each camp actually offers, following the same marketplace pattern. Sibling places need a full-price place alongside them.",
    render: render,
    selfTest: selfTest
  });
})();
