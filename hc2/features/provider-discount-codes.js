/* HolidayCamp feature — provider-discount-codes
 *
 * Create discount codes (% off, dates, notes)  (provider side)
 *
 * Replicates Happity's "How to create discount codes for your classes"
 * (support article 9680970). This is the PROVIDER set-up side — the
 * counterpart to parent-discount-code.js, which is the parent redemption
 * side at checkout.
 *
 * Faithful to the evidence (article 9680970, "How to set-up a new
 * discount code"):
 *   3. "Enter a Redeemable code … any string of numbers/letters … e.g.
 *      SUMMER50."  -> a free-text code, normalised + uniqueness-checked.
 *   4. "Enter the discount you want to offer with this code as a
 *      percentage. E.g. for a half-price class, enter 50. (You don't need
 *      the % symbol)"  -> percent off, 1..100, no % symbol required.
 *   5. "Enter a start date. The end date is optional, if you want the
 *      offer to carry on indefinitely, you can leave it blank."
 *      -> required start, optional open-ended end.
 *   6. "The notes section is optional, and won't be visible to your
 *      customers."  -> private provider-only notes.
 *   Min-charge note: "there is a minimum charge of 30p per booking … In
 *      the unlikely event that you discount your class to below the 30p
 *      minimum, we will charge this to your customers as a booking fee."
 *      -> a code can never take a paid line below £0.30.
 *
 * ACCEPTANCE CRITERION (asserted in selfTest):
 *   A code like SUMMER50 applies 50% off within its active dates; the 30p
 *   minimum charge is enforced. We verify the provider can create such a
 *   code, that it discounts only inside its window, and that no discounted
 *   line ever drops below £0.30.
 *
 * Framed for SCHOOL-AGE HOLIDAY CAMPS (day / full-week places), not baby
 * classes. Self-contained, defensive, no imports/exports. Persistence is
 * via HC.store only (no global localStorage keys). Calls HC.registerFeature
 * at top level and never throws at registration time.
 */
(function () {
  "use strict";

  // Defensive: never throw at module load if HC core isn't present.
  if (typeof window === "undefined" || !window.HC || typeof window.HC.registerFeature !== "function") {
    if (typeof console !== "undefined" && console.warn) {
      console.warn("[HC] provider-discount-codes: HC core not found; skipping registration.");
    }
    return;
  }

  var HC = window.HC;

  var STORE_KEY = "provider_discount_codes"; // { [providerId]: [codeObj, ...] }
  var TODAY_ISO = "2026-06-15";              // app reference "today" (deterministic)
  var MIN_CHARGE = 0.30;                     // Happity: 30p minimum charge per booking line

  /* ===================================================================
     PURE LOGIC (DOM-free, testable)
     =================================================================== */

  function asText(v) {
    return typeof v === "string" ? v : (v == null ? "" : String(v));
  }

  function round2(n) {
    return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
  }

  // Codes are case-insensitive and whitespace-stripped: "  summer50 " -> "SUMMER50".
  function normaliseCode(raw) {
    return asText(raw).trim().toUpperCase().replace(/\s+/g, "");
  }

  // Strict YYYY-MM-DD validation that rejects impossible calendar dates
  // (e.g. 2026-02-30). Returns true only for a real Gregorian date.
  function isValidISODate(s) {
    var str = asText(s);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(str)) return false;
    var parts = str.split("-");
    var y = Number(parts[0]), m = Number(parts[1]), d = Number(parts[2]);
    if (m < 1 || m > 12 || d < 1 || d > 31) return false;
    var dt = new Date(Date.UTC(y, m - 1, d));
    return dt.getUTCFullYear() === y &&
      dt.getUTCMonth() === m - 1 &&
      dt.getUTCDate() === d;
  }

  // Validate the provider's intended new code BEFORE saving. Mirrors the
  // article's required/optional fields. Returns { ok, errors:[...], value }.
  // `existing` is the list of codes already saved for the provider (for the
  // uniqueness check). Returns errors rather than throwing.
  function validateCode(input, existing) {
    input = input || {};
    existing = Array.isArray(existing) ? existing : [];
    var errors = [];

    var code = normaliseCode(input.code);
    // Step 3: a redeemable code — letters/numbers only, non-empty.
    if (!code) {
      errors.push("Enter a redeemable code (e.g. SUMMER50).");
    } else if (!/^[A-Z0-9]+$/.test(code)) {
      errors.push("Codes can only contain letters and numbers.");
    } else if (code.length > 24) {
      errors.push("Codes must be 24 characters or fewer.");
    } else if (existing.some(function (c) { return c.code === code; })) {
      errors.push("“" + code + "” already exists — codes must be unique.");
    }

    // Step 4: percentage discount, 1..100, no % symbol.
    var pct = Number(asText(input.percent).replace(/%/g, "").trim());
    if (!isFinite(pct)) {
      errors.push("Enter the discount as a percentage (e.g. 50).");
    } else if (!Number.isInteger(pct)) {
      errors.push("Discount percentage must be a whole number.");
    } else if (pct < 1 || pct > 100) {
      errors.push("Discount must be between 1% and 100%.");
    }

    // Step 5: start required, end optional. If both present, end >= start.
    var start = asText(input.start).trim();
    var end = asText(input.end).trim();
    if (!start) {
      errors.push("Enter a start date.");
    } else if (!isValidISODate(start)) {
      errors.push("Start date must be a real date (YYYY-MM-DD).");
    }
    if (end) {
      if (!isValidISODate(end)) {
        errors.push("End date must be a real date (YYYY-MM-DD).");
      } else if (start && isValidISODate(start) && end < start) {
        errors.push("End date cannot be before the start date.");
      }
    }

    // Step 6: notes optional, provider-private.
    var notes = asText(input.notes).trim();
    if (notes.length > 280) {
      errors.push("Notes must be 280 characters or fewer.");
    }

    var value = null;
    if (!errors.length) {
      value = {
        id: HC.util.uid(),
        code: code,
        percent: pct,
        start: start,
        end: end || null,         // null = open-ended ("carry on indefinitely")
        notes: notes,             // private, never shown to customers
        active: true,
        createdAt: TODAY_ISO
      };
    }
    return { ok: !errors.length, errors: errors, value: value };
  }

  // Is a code live on a given date? Article step 5: active from start, and
  // open-ended unless an end date is set. A deactivated code is never live.
  function isActiveOn(codeObj, todayIso) {
    if (!codeObj || codeObj.active === false) return false;
    var today = todayIso || TODAY_ISO;
    if (codeObj.start && today < codeObj.start) return false; // not started
    if (codeObj.end && today > codeObj.end) return false;     // expired
    return true;
  }

  // Apply a saved code to a per-booking line price. Honours the dates and the
  // 30p minimum charge. Returns a result object — never throws.
  //   { ok:true,  discount, newTotal, percent }
  //   { ok:false, reason, message }
  function applyToLine(codeObj, linePrice, todayIso) {
    var price = Number(linePrice);
    if (!codeObj) {
      return { ok: false, reason: "unknown", message: "No such discount code." };
    }
    if (!isFinite(price) || price <= 0) {
      return { ok: false, reason: "no-line", message: "Add a paid camp place first." };
    }
    if (!isActiveOn(codeObj, todayIso)) {
      return { ok: false, reason: "inactive", message: "“" + codeObj.code + "” is not active on this date." };
    }

    var rawDiscount = price * (codeObj.percent / 100);
    var newTotal = round2(price - rawDiscount);

    // Happity 30p minimum charge: a paid line may not drop below £0.30.
    // Anything below the floor is clamped up to the 30p booking fee.
    if (newTotal < MIN_CHARGE) newTotal = MIN_CHARGE;
    var discount = round2(price - newTotal);

    return {
      ok: true,
      percent: codeObj.percent,
      discount: discount,
      newTotal: newTotal,
      minChargeApplied: round2(price - rawDiscount) < MIN_CHARGE
    };
  }

  /* ===================================================================
     PERSISTENCE (HC.store only)
     =================================================================== */

  function allCodes() {
    var raw = null;
    try { raw = HC.store.get(STORE_KEY, {}); } catch (e) { raw = {}; }
    return (raw && typeof raw === "object") ? raw : {};
  }

  function codesFor(providerId) {
    var map = allCodes();
    var list = map[providerId];
    return Array.isArray(list) ? list : [];
  }

  function saveCodesFor(providerId, list) {
    var map = allCodes();
    map[providerId] = Array.isArray(list) ? list : [];
    try { HC.store.set(STORE_KEY, map); return true; } catch (e) { return false; }
  }

  // Add a validated code for a provider. Returns the validation result.
  function addCode(providerId, input) {
    var existing = codesFor(providerId);
    var res = validateCode(input, existing);
    if (res.ok) {
      existing = existing.concat([res.value]);
      saveCodesFor(providerId, existing);
    }
    return res;
  }

  function removeCode(providerId, codeId) {
    var list = codesFor(providerId).filter(function (c) { return c.id !== codeId; });
    return saveCodesFor(providerId, list);
  }

  function toggleCode(providerId, codeId) {
    var list = codesFor(providerId).map(function (c) {
      if (c.id === codeId) { c.active = c.active === false ? true : false; }
      return c;
    });
    return saveCodesFor(providerId, list);
  }

  /* ===================================================================
     DEMO BASKET — a real school-age line price from LIVE data, so the
     preview discounts a genuine holiday-camp number.
     =================================================================== */

  function sampleLinePrice() {
    try {
      var providers = HC.data.providers || [];
      var byId = (HC.data.planner && HC.data.planner.byId) || {};
      for (var i = 0; i < providers.length; i++) {
        var pl = byId[providers[i].id];
        if (pl && pl.price) {
          if (typeof pl.price.day === "number" && pl.price.day > 0) return round2(pl.price.day);
          if (typeof pl.price.week === "number" && pl.price.week > 0) return round2(pl.price.week);
        }
      }
    } catch (e) { /* fall through */ }
    return 36; // sensible day-place fallback
  }

  function firstProviderId() {
    try {
      var providers = HC.data.providers || [];
      if (providers.length && providers[0] && providers[0].id != null) return providers[0].id;
    } catch (e) {}
    return "demo-provider";
  }

  /* ===================================================================
     UI — a provider "Customers > Discount Codes" panel: add-code form
     (code, %, start, optional end, optional notes) + a live list with a
     redemption preview on a real camp price.
     =================================================================== */

  function esc(s) {
    return asText(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
  function escAttr(s) { return esc(s).replace(/"/g, "&quot;"); }

  function fmtDate(iso) {
    if (!iso) return "open-ended";
    return esc(iso);
  }

  function render(mountEl) {
    try {
      var providerId = firstProviderId();
      var providerName = "your camps";
      try {
        var p = (HC.data.providers || [])[0];
        if (p && p.name) providerName = p.name;
      } catch (e) {}

      var line = sampleLinePrice();

      mountEl.innerHTML =
        '<div style="font-family:\'Nunito Sans\',system-ui,sans-serif;color:var(--text,#383838)">' +
          '<p style="font-size:14px;margin:0 0 14px">Provider dashboard → <strong>Customers › Discount Codes</strong>. ' +
          'Create a promo code for <strong>' + esc(providerName) + '</strong> — a redeemable code, a ' +
          'percentage off, a start date (end date optional), and private notes. ' +
          'Codes apply only inside their active dates, and a paid place can never drop below the ' +
          HC.util.money(MIN_CHARGE) + ' minimum charge.</p>' +

          // --- Add-code form ---
          '<div style="border:1.5px solid var(--line,#E6E6E6);border-radius:14px;padding:14px 16px;margin-bottom:16px">' +
            '<div style="font-family:\'Quicksand\',system-ui,sans-serif;font-weight:700;color:var(--purple,#603488);font-size:15px;margin-bottom:10px">Add discount code</div>' +

            '<label style="display:block;font-weight:700;font-size:12.5px;margin-bottom:3px">Redeemable code</label>' +
            '<input id="pdcCode" type="text" placeholder="e.g. SUMMER50" autocomplete="off" spellcheck="false" ' +
              'style="width:100%;padding:9px;border:1.5px solid var(--line,#E6E6E6);border-radius:12px;font-size:14px;text-transform:uppercase;margin-bottom:10px">' +

            '<label style="display:block;font-weight:700;font-size:12.5px;margin-bottom:3px">Discount (% off — no % symbol)</label>' +
            '<input id="pdcPct" type="number" min="1" max="100" step="1" placeholder="50" ' +
              'style="width:100%;padding:9px;border:1.5px solid var(--line,#E6E6E6);border-radius:12px;font-size:14px;margin-bottom:10px">' +

            '<div style="display:flex;gap:10px;margin-bottom:10px">' +
              '<div style="flex:1">' +
                '<label style="display:block;font-weight:700;font-size:12.5px;margin-bottom:3px">Start date</label>' +
                '<input id="pdcStart" type="date" value="' + escAttr(TODAY_ISO) + '" ' +
                  'style="width:100%;padding:9px;border:1.5px solid var(--line,#E6E6E6);border-radius:12px;font-size:14px">' +
              '</div>' +
              '<div style="flex:1">' +
                '<label style="display:block;font-weight:700;font-size:12.5px;margin-bottom:3px">End date <span style="color:var(--muted,#808080);font-weight:400">(optional)</span></label>' +
                '<input id="pdcEnd" type="date" ' +
                  'style="width:100%;padding:9px;border:1.5px solid var(--line,#E6E6E6);border-radius:12px;font-size:14px">' +
              '</div>' +
            '</div>' +

            '<label style="display:block;font-weight:700;font-size:12.5px;margin-bottom:3px">Notes <span style="color:var(--muted,#808080);font-weight:400">(private — not shown to customers)</span></label>' +
            '<textarea id="pdcNotes" rows="2" placeholder="e.g. promote in the summer newsletter" ' +
              'style="width:100%;padding:9px;border:1.5px solid var(--line,#E6E6E6);border-radius:12px;font-size:14px;resize:vertical;margin-bottom:10px"></textarea>' +

            '<button id="pdcAdd" type="button" class="hc-btn">Add discount code</button>' +
            '<div id="pdcErr" style="font-size:12.5px;color:#9a1f5e;margin-top:8px;min-height:14px"></div>' +
          '</div>' +

          '<div style="font-family:\'Quicksand\',system-ui,sans-serif;font-weight:700;color:var(--purple,#603488);font-size:15px;margin:0 0 8px">' +
            'Your codes <span style="color:var(--muted,#808080);font-weight:400;font-size:12.5px">(preview on a ' + HC.util.money(line) + ' place)</span></div>' +
          '<div id="pdcList"></div>' +
        '</div>';

      var $ = function (id) { return mountEl.querySelector("#" + id); };

      function renderList() {
        var host = $("pdcList");
        if (!host) return;
        var list = codesFor(providerId);
        if (!list.length) {
          host.innerHTML = '<p style="color:var(--muted,#808080);font-size:13px;margin:0">No discount codes yet. Add one above.</p>';
          return;
        }
        host.innerHTML = list.map(function (c) {
          var res = applyToLine(c, line, TODAY_ISO);
          var liveNow = isActiveOn(c, TODAY_ISO);
          var window = fmtDate(c.start) + " → " + fmtDate(c.end);
          var preview;
          if (res.ok) {
            preview = HC.util.money(line) + " → <strong>" + HC.util.money(res.newTotal) + "</strong> " +
              '<span style="color:#2f7d4f">(−' + HC.util.money(res.discount) + ")</span>" +
              (res.minChargeApplied ? ' <span style="color:#9a1f5e">' + HC.util.money(MIN_CHARGE) + " min charge</span>" : "");
          } else {
            preview = '<span style="color:var(--muted,#808080)">' + esc(res.message) + "</span>";
          }
          return '<div style="border:1.5px solid var(--line,#E6E6E6);border-radius:12px;padding:11px 13px;margin-bottom:8px">' +
            '<div style="display:flex;justify-content:space-between;align-items:center;gap:8px">' +
              '<div style="font-family:\'Quicksand\',system-ui,sans-serif;font-weight:700;color:var(--purple,#603488);font-size:15px">' +
                esc(c.code) + ' <span style="color:var(--magenta,#F82488)">−' + c.percent + "%</span></div>" +
              '<div style="display:flex;gap:6px">' +
                '<button type="button" class="hc-btn hc-btn-ghost" data-pdc-toggle="' + escAttr(c.id) + '" style="padding:5px 10px;font-size:11px">' +
                  (c.active === false ? "Enable" : "Disable") + "</button>" +
                '<button type="button" class="hc-btn hc-btn-ghost" data-pdc-del="' + escAttr(c.id) + '" style="padding:5px 10px;font-size:11px">Delete</button>' +
              "</div>" +
            "</div>" +
            '<div style="font-size:12px;color:var(--muted,#808080);margin-top:3px">Active: ' + window +
              (liveNow ? ' · <span style="color:#2f7d4f">live today</span>' : ' · <span style="color:#9a1f5e">' + (c.active === false ? "disabled" : "not live today") + "</span>") + "</div>" +
            '<div style="font-size:13px;margin-top:4px">' + preview + "</div>" +
            (c.notes ? '<div style="font-size:11.5px;color:var(--muted,#808080);margin-top:4px;font-style:italic">Note: ' + esc(c.notes) + "</div>" : "") +
            "</div>";
        }).join("");
      }

      $("pdcAdd").addEventListener("click", function () {
        var res = addCode(providerId, {
          code: $("pdcCode").value,
          percent: $("pdcPct").value,
          start: $("pdcStart").value,
          end: $("pdcEnd").value,
          notes: $("pdcNotes").value
        });
        if (res.ok) {
          $("pdcErr").textContent = "";
          $("pdcCode").value = "";
          $("pdcPct").value = "";
          $("pdcNotes").value = "";
          try { HC.util.toast("Saved code " + res.value.code); } catch (e) {}
          renderList();
        } else {
          $("pdcErr").innerHTML = res.errors.map(esc).join("<br>");
        }
      });

      mountEl.addEventListener("click", function (e) {
        var del = e.target.closest("[data-pdc-del]");
        if (del) { removeCode(providerId, del.getAttribute("data-pdc-del")); renderList(); return; }
        var tog = e.target.closest("[data-pdc-toggle]");
        if (tog) { toggleCode(providerId, tog.getAttribute("data-pdc-toggle")); renderList(); return; }
      });

      renderList();
    } catch (e) {
      mountEl.innerHTML = '<p style="color:#9a1f5e">Discount-codes panel failed to load: ' +
        esc(e && e.message ? e.message : String(e)) + "</p>";
    }
  }

  /* ===================================================================
     SELF-TEST — exercises the LOGIC and asserts the acceptance criterion.
     Uses an isolated in-memory provider id so it never disturbs real
     stored data; verifies the 30p minimum-charge floor across cases.
     =================================================================== */

  function selfTest() {
    var pass = 0, fail = 0, log = [];
    function check(label, fn) {
      try { fn(); pass += 1; log.push("✓ " + label); }
      catch (e) { fail += 1; log.push("✗ " + label + " — " + (e && e.message ? e.message : String(e))); }
    }

    // --- ACCEPTANCE: SUMMER50 = 50% off inside its active dates. ---
    check("Provider can create SUMMER50 (50% off, dates, notes)", function () {
      var res = validateCode({
        code: "summer50", percent: "50", start: "2026-06-01", end: "2026-08-31",
        notes: "promote in summer newsletter"
      }, []);
      HC.assert(res.ok === true, "SUMMER50 should validate; errors: " + res.errors.join("; "));
      HC.assert(res.value.code === "SUMMER50", "code should normalise to SUMMER50, got " + res.value.code);
      HC.assert(res.value.percent === 50, "percent should be 50, got " + res.value.percent);
      HC.assert(res.value.end === "2026-08-31", "end date should be stored");
      HC.assert(res.value.notes === "promote in summer newsletter", "notes should be stored");
    });

    var SUMMER50 = { code: "SUMMER50", percent: 50, start: "2026-06-01", end: "2026-08-31", active: true };

    check("SUMMER50 applies 50% off within its active dates (£100 -> £50)", function () {
      var r = applyToLine(SUMMER50, 100, "2026-07-15"); // mid-window
      HC.assert(r.ok === true, "should apply inside the window");
      HC.assert(r.newTotal === 50, "expected £50, got " + r.newTotal);
      HC.assert(r.discount === 50, "expected £50 discount, got " + r.discount);
    });

    check("SUMMER50 is rejected after its end date (2026-09-01)", function () {
      var r = applyToLine(SUMMER50, 100, "2026-09-01");
      HC.assert(r.ok === false, "should not apply after end date");
      HC.assert(r.reason === "inactive", "reason should be 'inactive', got " + r.reason);
    });

    check("SUMMER50 is rejected before its start date (2026-05-15)", function () {
      var r = applyToLine(SUMMER50, 100, "2026-05-15");
      HC.assert(r.ok === false, "should not apply before start date");
      HC.assert(r.reason === "inactive", "reason should be 'inactive', got " + r.reason);
    });

    check("isActiveOn is true on the exact start and end boundaries", function () {
      HC.assert(isActiveOn(SUMMER50, "2026-06-01") === true, "start boundary should be live");
      HC.assert(isActiveOn(SUMMER50, "2026-08-31") === true, "end boundary should be live");
    });

    // --- ACCEPTANCE: 30p minimum charge enforced. ---
    check("30p minimum charge: 100% off a £0.50 place clamps to £0.30", function () {
      var full = { code: "FREE100", percent: 100, start: "2026-01-01", end: null, active: true };
      var r = applyToLine(full, 0.50, "2026-06-15");
      HC.assert(r.ok === true, "100% code should apply");
      HC.assert(r.newTotal === 0.30, "total must floor to the 30p minimum, got " + r.newTotal);
      HC.assert(r.minChargeApplied === true, "minChargeApplied flag should be set");
    });

    check("30p minimum charge: SUMMER50 on a £0.50 place clamps to £0.30 (not £0.25)", function () {
      var r = applyToLine(SUMMER50, 0.50, "2026-07-01"); // 50% would be £0.25 < floor
      HC.assert(r.ok === true, "should apply");
      HC.assert(r.newTotal === 0.30, "expected floor £0.30, got " + r.newTotal);
      HC.assert(r.discount === 0.20, "discount should be £0.20 (£0.50 - £0.30), got " + r.discount);
    });

    check("30p floor untouched when the discounted total stays above it", function () {
      var r = applyToLine(SUMMER50, 40, "2026-07-01"); // 50% of £40 = £20 (well above 30p)
      HC.assert(r.ok === true, "should apply");
      HC.assert(r.newTotal === 20, "expected £20, got " + r.newTotal);
      HC.assert(r.minChargeApplied === false, "min charge should NOT be flagged here");
    });

    // --- Validation rules from the article. ---
    check("Percentage is required and bounded (0 and 101 rejected, '50%' accepted)", function () {
      HC.assert(validateCode({ code: "A", percent: "0", start: "2026-06-01" }, []).ok === false, "0% must be rejected");
      HC.assert(validateCode({ code: "B", percent: "101", start: "2026-06-01" }, []).ok === false, "101% must be rejected");
      var withSymbol = validateCode({ code: "C", percent: "50%", start: "2026-06-01" }, []);
      HC.assert(withSymbol.ok === true, "a '%' symbol should be tolerated");
      HC.assert(withSymbol.value.percent === 50, "percent should parse to 50");
    });

    check("Start date is required; end date is optional (open-ended)", function () {
      HC.assert(validateCode({ code: "NOSTART", percent: "10", start: "" }, []).ok === false, "missing start must fail");
      var openEnded = validateCode({ code: "FOREVER", percent: "10", start: "2026-06-01", end: "" }, []);
      HC.assert(openEnded.ok === true, "blank end date should be allowed");
      HC.assert(openEnded.value.end === null, "open-ended end should store as null, got " + openEnded.value.end);
      // open-ended code is live well into the future
      HC.assert(isActiveOn(openEnded.value, "2030-01-01") === true, "open-ended code should be live indefinitely");
    });

    check("End-before-start is rejected", function () {
      var r = validateCode({ code: "BACKWARDS", percent: "10", start: "2026-08-01", end: "2026-06-01" }, []);
      HC.assert(r.ok === false, "end before start must fail");
    });

    check("Invalid calendar dates are rejected (2026-02-30)", function () {
      var r = validateCode({ code: "BADDATE", percent: "10", start: "2026-02-30" }, []);
      HC.assert(r.ok === false, "impossible date must be rejected");
    });

    check("Code must be alphanumeric and non-empty", function () {
      HC.assert(validateCode({ code: "", percent: "10", start: "2026-06-01" }, []).ok === false, "empty code must fail");
      HC.assert(validateCode({ code: "SAVE 50!", percent: "10", start: "2026-06-01" }, []).ok === false, "punctuation must fail");
    });

    check("Codes are normalised (case/whitespace) and must be unique", function () {
      var existing = [{ code: "SUMMER50" }];
      var dup = validateCode({ code: "  summer50 ", percent: "20", start: "2026-06-01" }, existing);
      HC.assert(dup.ok === false, "duplicate (after normalisation) must be rejected");
    });

    // --- Persistence round-trip via HC.store (isolated test provider). ---
    check("CRUD round-trips through HC.store without disturbing real data", function () {
      var TEST_PID = "__selftest_provider__" + HC.util.uid();
      HC.assert(codesFor(TEST_PID).length === 0, "test provider should start empty");

      var add = addCode(TEST_PID, { code: "TESTSUMMER50", percent: "50", start: "2026-06-01", end: "2026-08-31", notes: "x" });
      HC.assert(add.ok === true, "add should succeed; errors: " + add.errors.join("; "));
      HC.assert(codesFor(TEST_PID).length === 1, "one code should be stored");

      // Uniqueness enforced through the store path too.
      var dup = addCode(TEST_PID, { code: "testsummer50", percent: "10", start: "2026-06-01" });
      HC.assert(dup.ok === false, "duplicate add should be rejected");
      HC.assert(codesFor(TEST_PID).length === 1, "duplicate should not be stored");

      var saved = codesFor(TEST_PID)[0];
      var applied = applyToLine(saved, 100, "2026-07-01");
      HC.assert(applied.ok && applied.newTotal === 50, "stored SUMMER50 should still discount 50%");

      toggleCode(TEST_PID, saved.id);
      HC.assert(codesFor(TEST_PID)[0].active === false, "toggle should disable the code");
      HC.assert(applyToLine(codesFor(TEST_PID)[0], 100, "2026-07-01").ok === false, "disabled code must not apply");

      removeCode(TEST_PID, saved.id);
      HC.assert(codesFor(TEST_PID).length === 0, "remove should clear the code");
      saveCodesFor(TEST_PID, []); // tidy up the isolated key
    });

    // --- Guard: no paid line means no discount. ---
    check("Applying to a £0 / empty line is rejected", function () {
      var r = applyToLine(SUMMER50, 0, "2026-07-01");
      HC.assert(r.ok === false && r.reason === "no-line", "empty line should be rejected");
    });

    // --- Live-data sanity: real school-age camp price discounts cleanly. ---
    check("A real live camp price is discounted by SUMMER50 inside its window", function () {
      var price = sampleLinePrice();
      HC.assert(price > 0, "expected a positive sample line price, got " + price);
      var r = applyToLine(SUMMER50, price, "2026-07-01");
      HC.assert(r.ok === true, "SUMMER50 should apply to a live camp price");
      HC.assert(r.newTotal >= MIN_CHARGE, "discounted total must respect the 30p floor");
      HC.assert(r.newTotal < price, "discounted total must be below the original price");
    });

    return { pass: pass, fail: fail, log: log };
  }

  /* ===================================================================
     REGISTER (idempotent + defensive via core).
     =================================================================== */
  HC.registerFeature({
    id: "provider-discount-codes",
    title: "Create discount codes",
    side: "provider",
    icon: "🏷️",
    summary: "Set up promo codes for your holiday camps — a redeemable code (e.g. SUMMER50), a percentage off, a start date with an optional end date, and private notes. Codes apply only inside their active dates and never take a place below the 30p minimum charge.",
    render: render,
    selfTest: selfTest
  });
})();
