/* HolidayCamp feature: parent-discount-code
 * ------------------------------------------------------------------
 * Replicates Happity's "apply a discount code at checkout" behaviour
 * (support article 9680970 — the code entry box lives behind a
 * dropdown arrow on the final checkout screen).
 *
 * Side: parent. Framed for SCHOOL-AGE HOLIDAY CAMPS (day / full-week
 * places), not baby classes.
 *
 * What it does, faithful to the evidence:
 *  - The entry box is collapsed behind a "Have a discount code?"
 *    disclosure (Happity's "click the dropdown arrow").
 *  - Codes are mainly PERCENT off (e.g. SUMMER50 = 50% off), exactly
 *    like the article. We also support a fixed-£ promo for completeness.
 *  - Codes can have start / end dates; an out-of-window code is rejected.
 *  - Happity's documented MINIMUM CHARGE of 30p per booking is honoured:
 *    a discount can never take a paid line below £0.30.
 *  - A valid code REDUCES the displayed total; an invalid code is
 *    rejected and the total is unchanged. (acceptance criterion)
 *
 * Defensive: nothing here throws at registration time. Persistence is
 * via HC.store only (the parent's "last used code"); no global
 * localStorage keys are written.
 * ------------------------------------------------------------------ */
(function () {
  "use strict";

  if (typeof window === "undefined" || !window.HC || typeof window.HC.registerFeature !== "function") {
    // Core not present — fail silently rather than throwing.
    return;
  }
  var HC = window.HC;

  /* ============================================================
   * 1. Promo-code catalogue (the "provider set these up" side).
   *    Today is fixed to the app's reference date so tests are
   *    deterministic regardless of when they run.
   * ============================================================ */
  var TODAY_ISO = "2026-06-15"; // matches the app's reference "today"

  // Each code: percent OR amount (fixed £ off), optional window + min spend.
  var PROMO_CODES = {
    SUMMER50:  { type: "percent", value: 50, label: "Half-price summer place", start: "2026-06-01", end: "2026-08-31" },
    EARLYBIRD: { type: "percent", value: 15, label: "Early-bird 15% off",       start: "2026-05-01", end: "2026-07-01" },
    SIBLING10: { type: "percent", value: 10, label: "Sibling discount",         start: "2026-01-01", end: null, minSpend: 100 },
    FIVER:     { type: "amount",  value: 5,  label: "£5 off your booking",       start: "2026-06-01", end: null },
    LASTYEAR:  { type: "percent", value: 20, label: "Expired 2025 code",         start: "2025-06-01", end: "2025-09-01" } // out of window on purpose
  };

  var MIN_CHARGE = 0.30; // Happity: 30p minimum charge per booking line.

  /* ============================================================
   * 2. Pure pricing logic (what selfTest exercises).
   * ============================================================ */

  function round2(n) {
    return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
  }

  function normaliseCode(raw) {
    return String(raw == null ? "" : raw).trim().toUpperCase().replace(/\s+/g, "");
  }

  function isWithinWindow(promo, todayIso) {
    var today = todayIso || TODAY_ISO;
    if (promo.start && today < promo.start) return false; // not started yet
    if (promo.end && today > promo.end) return false;     // expired
    return true;
  }

  /* Look up + validate a code against a subtotal.
   * Returns a result object — never throws.
   *   { ok:true,  code, promo, discount, newTotal, message }
   *   { ok:false, reason, message }                         */
  function applyCode(rawCode, subtotal, opts) {
    opts = opts || {};
    var todayIso = opts.todayIso || TODAY_ISO;
    var sub = Number(subtotal);
    var code = normaliseCode(rawCode);

    if (!code) {
      return { ok: false, reason: "empty", message: "Enter a discount code." };
    }
    if (!isFinite(sub) || sub <= 0) {
      return { ok: false, reason: "no-basket", message: "Add a camp place before applying a code." };
    }

    var promo = PROMO_CODES[code];
    if (!promo) {
      return { ok: false, reason: "unknown", message: "“" + code + "” is not a valid discount code." };
    }
    if (!isWithinWindow(promo, todayIso)) {
      return { ok: false, reason: "expired", message: "“" + code + "” has expired or is not active yet." };
    }
    if (promo.minSpend && sub < promo.minSpend) {
      return {
        ok: false,
        reason: "min-spend",
        message: "“" + code + "” needs a minimum spend of " + HC.util.money(promo.minSpend) + "."
      };
    }

    // Compute the raw discount.
    var rawDiscount = promo.type === "amount"
      ? Math.min(promo.value, sub)
      : sub * (promo.value / 100);

    // Honour the 30p minimum charge: the discounted total may not drop
    // below MIN_CHARGE while the booking is still a paid booking.
    var newTotal = round2(sub - rawDiscount);
    if (newTotal < MIN_CHARGE) newTotal = MIN_CHARGE;
    var discount = round2(sub - newTotal);

    if (discount <= 0) {
      return { ok: false, reason: "no-effect", message: "This code does not reduce your total." };
    }

    return {
      ok: true,
      code: code,
      promo: promo,
      discount: discount,
      newTotal: newTotal,
      message: promo.label + " applied — you saved " + HC.util.money(discount) + "."
    };
  }

  /* ============================================================
   * 3. Basket helper — builds a realistic school-age basket from
   *    the LIVE planner price data so the UI uses real numbers.
   * ============================================================ */

  // Pull camps that have a usable numeric day/week price from HC.data.
  function pricedCamps() {
    var out = [];
    try {
      var providers = HC.data.providers || [];
      var byId = (HC.data.planner && HC.data.planner.byId) || {};
      for (var i = 0; i < providers.length; i++) {
        var p = providers[i];
        var pl = byId[p.id];
        if (!pl || !pl.price) continue;
        var price = pl.price;
        var unit = null, unitLabel = null;
        if (typeof price.day === "number") { unit = price.day; unitLabel = "day place"; }
        else if (typeof price.week === "number") { unit = price.week; unitLabel = "full-week place"; }
        if (unit && unit > 0) {
          out.push({ id: p.id, name: p.name, unit: unit, unitLabel: unitLabel });
        }
        if (out.length >= 8) break;
      }
    } catch (e) { /* defensive: empty basket is fine */ }
    return out;
  }

  function computeSubtotal(unit, qty) {
    var u = Number(unit), q = Math.max(1, Math.floor(Number(qty) || 1));
    if (!isFinite(u) || u <= 0) return 0;
    return round2(u * q);
  }

  /* ============================================================
   * 4. UI — a mock final checkout screen with the collapsible
   *    code entry box (Happity's "dropdown arrow").
   * ============================================================ */

  function render(mountEl) {
    try {
      var camps = pricedCamps();
      // Fallback synthetic camp if live data is unavailable.
      if (!camps.length) camps = [{ id: "demo", name: "Demo Holiday Camp", unit: 36, unitLabel: "day place" }];

      var lastCode = "";
      try { lastCode = HC.store.get("discount_last_code", "") || ""; } catch (e) { lastCode = ""; }

      var options = camps.map(function (c, i) {
        return '<option value="' + i + '">' +
          escAttr(c.name) + " — " + HC.util.money(c.unit) + " / " + escAttr(c.unitLabel) +
        "</option>";
      }).join("");

      mountEl.innerHTML =
        '<div style="font-family:\'Nunito Sans\',system-ui,sans-serif;color:var(--text,#383838)">' +
          '<p style="font-size:14px;margin:0 0 14px">Final checkout screen. Pick a holiday-camp place, ' +
          'then expand <em>Have a discount code?</em> and enter one to claim your discount ' +
          '(try <strong>SUMMER50</strong>, <strong>EARLYBIRD</strong> or <strong>FIVER</strong>).</p>' +

          '<label style="display:block;font-weight:700;font-size:13px;margin-bottom:4px">Camp place</label>' +
          '<select id="dcCamp" style="width:100%;padding:9px;border:1.5px solid var(--line,#E6E6E6);border-radius:12px;font-size:14px;margin-bottom:12px">' +
            options +
          "</select>" +

          '<label style="display:block;font-weight:700;font-size:13px;margin-bottom:4px">Number of places</label>' +
          '<input id="dcQty" type="number" min="1" max="6" value="1" ' +
            'style="width:100%;padding:9px;border:1.5px solid var(--line,#E6E6E6);border-radius:12px;font-size:14px;margin-bottom:16px">' +

          // Collapsible discount-code disclosure (the "dropdown arrow").
          '<details id="dcDetails" style="border:1.5px solid var(--line,#E6E6E6);border-radius:12px;padding:0 12px;margin-bottom:16px">' +
            '<summary style="cursor:pointer;font-weight:700;font-size:13.5px;color:var(--purple,#603488);padding:11px 0;list-style:revert">' +
              "Have a discount code?" +
            "</summary>" +
            '<div style="display:flex;gap:8px;padding:0 0 12px">' +
              '<input id="dcCode" type="text" placeholder="e.g. SUMMER50" value="' + escAttr(lastCode) + '" ' +
                'autocomplete="off" spellcheck="false" ' +
                'style="flex:1;padding:9px;border:1.5px solid var(--line,#E6E6E6);border-radius:12px;font-size:14px;text-transform:uppercase">' +
              '<button id="dcApply" type="button" class="hc-btn">Apply</button>' +
            "</div>" +
            '<div id="dcCodeMsg" style="font-size:12.5px;min-height:16px;padding-bottom:8px"></div>' +
          "</details>" +

          // Totals panel.
          '<div style="background:var(--purple-tint,#F0E8F4);border-radius:14px;padding:14px 16px">' +
            '<div style="display:flex;justify-content:space-between;font-size:14px;margin-bottom:6px">' +
              "<span>Subtotal</span><span id=\"dcSubtotal\">£0</span></div>" +
            '<div id="dcDiscountRow" style="display:none;justify-content:space-between;font-size:14px;margin-bottom:6px;color:#2f7d4f">' +
              '<span id="dcDiscountLabel">Discount</span><span id="dcDiscountVal">−£0</span></div>' +
            '<div style="display:flex;justify-content:space-between;font-family:\'Quicksand\',system-ui,sans-serif;' +
              'font-weight:700;font-size:18px;color:var(--purple,#603488);border-top:1px solid rgba(96,52,136,.18);padding-top:8px">' +
              "<span>Total to pay</span><span id=\"dcTotal\">£0</span></div>" +
          "</div>" +
        "</div>";

      var $ = function (id) { return mountEl.querySelector("#" + id); };
      var state = { applied: null }; // currently-applied result, or null.

      function currentCamp() {
        var idx = Math.max(0, parseInt($("dcCamp").value, 10) || 0);
        return camps[idx] || camps[0];
      }
      function currentSubtotal() {
        return computeSubtotal(currentCamp().unit, $("dcQty").value);
      }

      function paint() {
        var sub = currentSubtotal();
        $("dcSubtotal").textContent = HC.util.money(sub);

        // If a code is applied, re-validate against the new subtotal.
        if (state.applied) {
          var re = applyCode(state.applied.code, sub);
          if (re.ok) {
            state.applied = re;
          } else {
            state.applied = null;
            setMsg(re.message, false);
            $("dcCode").value = "";
          }
        }

        if (state.applied) {
          $("dcDiscountRow").style.display = "flex";
          $("dcDiscountLabel").textContent = state.applied.code + " discount";
          $("dcDiscountVal").textContent = "−" + HC.util.money(state.applied.discount);
          $("dcTotal").textContent = HC.util.money(state.applied.newTotal);
        } else {
          $("dcDiscountRow").style.display = "none";
          $("dcTotal").textContent = HC.util.money(sub);
        }
      }

      function setMsg(text, ok) {
        var m = $("dcCodeMsg");
        m.textContent = text || "";
        m.style.color = ok ? "#2f7d4f" : "#9a1f5e";
      }

      function onApply() {
        var raw = $("dcCode").value;
        var res = applyCode(raw, currentSubtotal());
        if (res.ok) {
          state.applied = res;
          setMsg(res.message, true);
          try { HC.store.set("discount_last_code", res.code); } catch (e) {}
          try { HC.util.toast("Saved " + HC.util.money(res.discount) + " with " + res.code); } catch (e) {}
        } else {
          state.applied = null;
          setMsg(res.message, false);
        }
        paint();
      }

      $("dcApply").addEventListener("click", onApply);
      $("dcCode").addEventListener("keydown", function (e) {
        if (e.key === "Enter") { e.preventDefault(); onApply(); }
      });
      $("dcCamp").addEventListener("change", paint);
      $("dcQty").addEventListener("input", paint);

      paint();
    } catch (e) {
      mountEl.innerHTML = '<p style="color:#9a1f5e">Checkout preview failed to load: ' +
        esc(e && e.message ? e.message : String(e)) + "</p>";
    }
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
  function escAttr(s) { return esc(s).replace(/"/g, "&quot;"); }

  /* ============================================================
   * 5. selfTest — exercises the LOGIC and asserts the acceptance
   *    criterion across multiple cases.
   * ============================================================ */

  function selfTest() {
    var pass = 0, fail = 0, log = [];
    function check(label, fn) {
      try { fn(); pass += 1; log.push("✓ " + label); }
      catch (e) { fail += 1; log.push("✗ " + label + " — " + (e && e.message ? e.message : String(e))); }
    }

    var SUB = 100; // £100 basket (e.g. a full week place + extras)

    // --- ACCEPTANCE: a valid code reduces the displayed total. ---
    check("Valid percent code (SUMMER50) halves a £100 basket to £50", function () {
      var r = applyCode("SUMMER50", SUB);
      HC.assert(r.ok === true, "SUMMER50 should be accepted");
      HC.assert(r.newTotal === 50, "expected total £50, got " + r.newTotal);
      HC.assert(r.discount === 50, "expected discount £50, got " + r.discount);
      HC.assert(r.newTotal < SUB, "total must drop below subtotal");
    });

    check("Valid code is case- and space-insensitive ('  summer50 ')", function () {
      var r = applyCode("  summer50 ", SUB);
      HC.assert(r.ok === true, "lower-case/whitespace code should normalise and apply");
      HC.assert(r.newTotal === 50, "expected total £50, got " + r.newTotal);
    });

    check("EARLYBIRD takes 15% off (£100 -> £85)", function () {
      var r = applyCode("EARLYBIRD", SUB);
      HC.assert(r.ok === true, "EARLYBIRD should be accepted");
      HC.assert(r.newTotal === 85, "expected total £85, got " + r.newTotal);
    });

    check("Fixed-amount code FIVER takes £5 off (£100 -> £95)", function () {
      var r = applyCode("FIVER", SUB);
      HC.assert(r.ok === true, "FIVER should be accepted");
      HC.assert(r.discount === 5, "expected £5 discount, got " + r.discount);
      HC.assert(r.newTotal === 95, "expected total £95, got " + r.newTotal);
    });

    // --- ACCEPTANCE: an invalid code is rejected, total unchanged. ---
    check("Unknown code (NOPE123) is rejected", function () {
      var r = applyCode("NOPE123", SUB);
      HC.assert(r.ok === false, "unknown code must be rejected");
      HC.assert(r.reason === "unknown", "reason should be 'unknown', got " + r.reason);
      HC.assert(r.newTotal === undefined, "rejected code must not produce a new total");
    });

    check("Empty code is rejected with a prompt", function () {
      var r = applyCode("   ", SUB);
      HC.assert(r.ok === false, "blank code must be rejected");
      HC.assert(r.reason === "empty", "reason should be 'empty', got " + r.reason);
    });

    check("Expired code (LASTYEAR, 2025 window) is rejected", function () {
      var r = applyCode("LASTYEAR", SUB);
      HC.assert(r.ok === false, "out-of-window code must be rejected");
      HC.assert(r.reason === "expired", "reason should be 'expired', got " + r.reason);
    });

    check("Not-yet-started code is rejected (todayIso before start)", function () {
      // EARLYBIRD starts 2026-05-01; pretend today is April.
      var r = applyCode("EARLYBIRD", SUB, { todayIso: "2026-04-15" });
      HC.assert(r.ok === false, "future-dated code must be rejected before its start");
      HC.assert(r.reason === "expired", "reason should be 'expired', got " + r.reason);
    });

    // --- Min-spend gating. ---
    check("SIBLING10 rejected below its £100 minimum spend (£40 basket)", function () {
      var r = applyCode("SIBLING10", 40);
      HC.assert(r.ok === false, "should be rejected under min spend");
      HC.assert(r.reason === "min-spend", "reason should be 'min-spend', got " + r.reason);
    });

    check("SIBLING10 accepted at exactly the £100 minimum spend", function () {
      var r = applyCode("SIBLING10", 100);
      HC.assert(r.ok === true, "should apply at the threshold");
      HC.assert(r.newTotal === 90, "expected £90, got " + r.newTotal);
    });

    // --- 30p minimum-charge floor (Happity's documented rule). ---
    check("100% off scenario still leaves the 30p minimum charge", function () {
      // FIVER off a 30p basket would zero it; floor must hold at £0.30.
      var r = applyCode("FIVER", 0.30);
      // £0.30 basket - £5 fixed: clamps to 30p, so discount is 0 -> no effect.
      HC.assert(r.ok === false, "a code that cannot reduce below the 30p floor has no effect");
      HC.assert(r.reason === "no-effect", "reason should be 'no-effect', got " + r.reason);
    });

    check("Large fixed discount is floored at the 30p minimum charge", function () {
      var r = applyCode("FIVER", 5.10); // £5.10 - £5 = £0.10 -> floor to £0.30
      HC.assert(r.ok === true, "FIVER should apply to a £5.10 basket");
      HC.assert(r.newTotal === 0.30, "total must be floored to the 30p minimum, got " + r.newTotal);
      HC.assert(r.discount === 4.8, "discount should be £4.80 (£5.10 - £0.30), got " + r.discount);
    });

    // --- No-basket guard. ---
    check("Code rejected when basket is empty (£0 subtotal)", function () {
      var r = applyCode("SUMMER50", 0);
      HC.assert(r.ok === false, "cannot apply a code to an empty basket");
      HC.assert(r.reason === "no-basket", "reason should be 'no-basket', got " + r.reason);
    });

    // --- Re-apply stability: applying then re-validating keeps total. ---
    check("Re-validating an applied code against the same basket is stable", function () {
      var first = applyCode("SUMMER50", SUB);
      var again = applyCode(first.code, SUB);
      HC.assert(again.ok === true && again.newTotal === first.newTotal,
        "re-application should yield the same total");
    });

    // --- Live-data sanity: the priced-camp basket builder works. ---
    check("Live planner data yields at least one priced school-age camp", function () {
      var camps = pricedCamps();
      HC.assert(camps.length >= 1, "expected >=1 priced camp from HC.data, got " + camps.length);
      var c = camps[0];
      var sub = computeSubtotal(c.unit, 2);
      HC.assert(sub === round2(c.unit * 2), "subtotal should be unit*qty");
      // And a real code should reduce a real basket.
      var r = applyCode("SUMMER50", sub);
      if (sub > 0) HC.assert(r.ok && r.newTotal < sub, "SUMMER50 should reduce a live basket");
    });

    return { pass: pass, fail: fail, log: log };
  }

  /* ============================================================
   * 6. Register (idempotent + defensive via core).
   * ============================================================ */
  HC.registerFeature({
    id: "parent-discount-code",
    title: "Apply a discount code at checkout",
    side: "parent",
    icon: "🏷️",
    summary: "Enter a promo code (e.g. SUMMER50) on the final checkout screen to reduce your holiday-camp total. Valid codes apply; invalid, expired or under-minimum codes are rejected.",
    render: render,
    selfTest: selfTest
  });
})();
