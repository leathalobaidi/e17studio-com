/* HolidayCamp feature — provider-ticket-tags
 * ------------------------------------------------------------------
 * PROVIDER side. Replicates Happity's ticket-TAG system from
 * "Creating and managing tickets, prices and term bookings on Happity"
 * (support corpus article 10248958). Every ticket a provider creates
 * can carry one of three booking tags — First Child, Sibling, Adult —
 * and each tag changes (a) what data the booking collects and (b) the
 * rules for whether the ticket can be bought.
 *
 * Evidence (article 10248958, verbatim mechanics):
 *   - First Child : Happity's DEFAULT. "collects details about the child,
 *                   including age and whether or not a customer gives photo
 *                   consent" and "automatically includes an accompanying
 *                   adult". A full-price ticket.
 *   - Sibling     : "Sibling tickets can only be purchased alongside a
 *                   full-price first child or adult ticket. If a customer
 *                   tries to select a sibling ticket on its own, a message
 *                   will appear at checkout asking a full-price ticket to be
 *                   added to the order." A discounted ticket; collects child
 *                   data (it IS a child place).
 *   - Adult       : "When a customer purchases an adult ticket, it asks only
 *                   for their details and doesn't take any information about
 *                   their child." A full-price ticket. Collects NO child data.
 *
 * Reframed for SCHOOL-AGE HOLIDAY CAMPS (not baby classes):
 *   - First Child : the standard camp place for one school-age child —
 *                   collects the child's name, age and photo consent, and
 *                   the booking adult's contact details.
 *   - Sibling     : a discounted second/third place for another child in the
 *                   same family — only sold when a full-price place is also in
 *                   the basket (Happity's exact rule).
 *   - Adult       : an adult-only place (e.g. a parent joining a family
 *                   adventure day / climbing taster) — collects only the
 *                   adult's details, never any child data.
 *
 * ACCEPTANCE CRITERION (asserted in selfTest, multiple cases):
 *   "A sibling ticket is purchasable only with a full-price ticket; adult
 *    tickets collect no child data."
 *      -> canCheckout(basket) REJECTS a basket containing a sibling place
 *         unless it also contains >=1 full-price place (First Child OR Adult),
 *         and ACCEPTS it once a full-price place is added.
 *      -> collectsChildData(tag) is FALSE for 'adult' (and the adult line
 *         carries no child fields), TRUE for first-child and sibling.
 *
 * Self-contained, defensive (never throws at registration), no imports.
 * Persistence is via HC.store ONLY (one namespaced key). The verified
 * camps.js data is never mutated.
 * ------------------------------------------------------------------ */
(function () {
  "use strict";

  if (typeof window === "undefined" || !window.HC || typeof window.HC.registerFeature !== "function") {
    if (typeof console !== "undefined" && console.warn) {
      console.warn("[HC] provider-ticket-tags: HC core not found; skipping registration.");
    }
    return;
  }

  var HC = window.HC;

  // Per-camp ticket definitions the provider has authored.
  // Shape: { [campId]: [ { id, name, tag, price, info } ] }
  var STORE_KEY = "provider_ticket_tags";

  /* ============================================================
   * 1. The three booking tags and their fixed semantics.
   *    Each tag declares:
   *      - fullPrice      : does it satisfy the "a full-price ticket is
   *                         present" rule for siblings? (First Child + Adult)
   *      - collectsChild  : does the booking flow collect child data?
   *      - includesAdult  : does the place include an accompanying adult?
   *      - requiresFullPrice : must another full-price place be in the basket?
   * ============================================================ */

  var TAGS = {
    "first-child": {
      key: "first-child",
      label: "First Child",
      icon: "🧒",
      fullPrice: true,
      collectsChild: true,
      includesAdult: true,
      requiresFullPrice: false,
      blurb: "Default place. Collects the child's name, age and photo consent, and includes an accompanying adult."
    },
    "sibling": {
      key: "sibling",
      label: "Sibling",
      icon: "👧",
      fullPrice: false,
      collectsChild: true,
      includesAdult: true,
      requiresFullPrice: true,
      blurb: "Discounted place for another child in the same family. Only sells alongside a full-price place."
    },
    "adult": {
      key: "adult",
      label: "Adult",
      icon: "🧑",
      fullPrice: true,
      collectsChild: false,
      includesAdult: false,
      requiresFullPrice: false,
      blurb: "Adult-only place. Asks for the adult's details only — never collects any child data."
    }
  };

  var TAG_ORDER = ["first-child", "sibling", "adult"];

  // The exact at-checkout message Happity shows when a sibling ticket is
  // selected on its own (reframed for camps; kept faithful to the rule).
  var FULL_PRICE_REQUIRED_MSG =
    "Please add a full-price place (First Child or Adult) to your basket — " +
    "a Sibling place can only be booked alongside one.";

  // The child-data fields a child place collects (First Child / Sibling).
  // Adult places never carry these.
  var CHILD_FIELDS = ["childName", "childAge", "photoConsent"];

  /* ============================================================
   * 2. Pure tag helpers — the canonical semantics, no DOM, no store.
   * ============================================================ */

  function normTag(tag) {
    var t = String(tag == null ? "" : tag).toLowerCase().trim();
    if (t === "firstchild" || t === "first" || t === "child" || t === "full") t = "first-child";
    if (t === "sib" || t === "siblings") t = "sibling";
    if (t === "adults") t = "adult";
    return Object.prototype.hasOwnProperty.call(TAGS, t) ? t : null;
  }

  function tagDef(tag) {
    var t = normTag(tag);
    return t ? TAGS[t] : null;
  }

  // Is this tag a full-price place (counts towards the sibling rule)?
  function isFullPrice(tag) {
    var d = tagDef(tag);
    return !!(d && d.fullPrice);
  }

  // Does a place with this tag collect child data?
  // ACCEPTANCE: adult => false; first-child & sibling => true.
  function collectsChildData(tag) {
    var d = tagDef(tag);
    return !!(d && d.collectsChild);
  }

  // Does the tag require a full-price place to also be present?
  function requiresFullPrice(tag) {
    var d = tagDef(tag);
    return !!(d && d.requiresFullPrice);
  }

  /* ============================================================
   * 3. Per-line data model.
   *    Build the data a single booked place should carry given its tag.
   *    Adult lines are guaranteed to carry NO child fields.
   * ============================================================ */

  // Strip any child fields that may have been (wrongly) supplied for a tag
  // that does not collect child data. Returns a shallow-cleaned copy.
  function lineDataFor(tag, supplied) {
    var src = (supplied && typeof supplied === "object") ? supplied : {};
    var out = { adultName: src.adultName || "", adultEmail: src.adultEmail || "" };
    if (collectsChildData(tag)) {
      out.childName = src.childName || "";
      out.childAge = (src.childAge === 0 || src.childAge) ? src.childAge : "";
      out.photoConsent = src.photoConsent === true;
    }
    // For an adult line, deliberately omit all CHILD_FIELDS.
    return out;
  }

  // True iff a built line carries NONE of the child fields.
  function lineHasNoChildData(line) {
    if (!line || typeof line !== "object") return true;
    for (var i = 0; i < CHILD_FIELDS.length; i++) {
      if (Object.prototype.hasOwnProperty.call(line, CHILD_FIELDS[i])) return false;
    }
    return true;
  }

  /* ============================================================
   * 4. THE CORE RULE — basket validation at checkout.
   *
   *    A basket is an array of lines: { tag, qty } (qty defaults to 1).
   *    validateBasket(basket) -> {
   *      ok:Boolean,                 // can it be checked out?
   *      reasons:[String],           // blocking messages (Happity-style)
   *      counts:{ fullPrice, sibling, total },
   *      childDataLines:Number       // how many lines collect child data
   *    }
   *
   *    Rules (from article 10248958):
   *      - Sibling places require >= 1 full-price place (First Child OR Adult)
   *        IN THE SAME BASKET. Otherwise: block with FULL_PRICE_REQUIRED_MSG.
   *      - A basket with no recognised places cannot be checked out.
   * ============================================================ */

  function lineQty(line) {
    if (!line) return 0;
    var q = Number(line.qty);
    if (!isFinite(q)) return 1;             // a present line defaults to qty 1
    return q < 0 ? 0 : Math.floor(q);
  }

  function validateBasket(basket) {
    var lines = Array.isArray(basket) ? basket : [];
    var fullPriceQty = 0, siblingQty = 0, totalQty = 0, childDataLines = 0;
    var unknown = 0;

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      var t = normTag(line && line.tag);
      var q = lineQty(line);
      if (!t) { if (q > 0) unknown += 1; continue; }
      if (q <= 0) continue;
      totalQty += q;
      if (isFullPrice(t)) fullPriceQty += q;
      if (t === "sibling") siblingQty += q;
      if (collectsChildData(t)) childDataLines += q;
    }

    var reasons = [];
    var ok = true;

    if (totalQty === 0) {
      ok = false;
      reasons.push("Your basket is empty — add a place to continue.");
    }

    // THE sibling rule.
    if (siblingQty > 0 && fullPriceQty < 1) {
      ok = false;
      reasons.push(FULL_PRICE_REQUIRED_MSG);
    }

    if (unknown > 0) {
      ok = false;
      reasons.push("Some places have an unrecognised ticket type.");
    }

    return {
      ok: ok,
      reasons: reasons,
      counts: { fullPrice: fullPriceQty, sibling: siblingQty, total: totalQty },
      childDataLines: childDataLines
    };
  }

  // Boolean convenience used by the acceptance test and the UI.
  function canCheckout(basket) {
    return validateBasket(basket).ok === true;
  }

  /* ============================================================
   * 5. Pricing helpers — derive a sensible base price per camp so the UI
   *    can seed default tickets. Defensive parse of the free-text price.
   * ============================================================ */

  function basePriceFor(camp) {
    var c = camp || {};
    // Try to pull the first £-amount out of the free-text price string.
    var s = String(c.price == null ? "" : c.price);
    var m = s.match(/£\s*([0-9]+(?:\.[0-9]{1,2})?)/);
    if (m) {
      var n = Number(m[1]);
      if (isFinite(n) && n > 0) return n;
    }
    if (/free/i.test(s)) return 0;
    return 30; // sensible default day-rate for a holiday camp place
  }

  // The default ticket set a provider starts from for a camp: a full-price
  // First Child, a discounted Sibling, and an Adult place.
  function defaultTickets(camp) {
    var base = basePriceFor(camp);
    var siblingPrice = base > 0 ? Math.max(0, Math.round(base * 0.8)) : 0; // 20% sibling discount
    return [
      { id: "first-child", name: "Child place", tag: "first-child", price: base, info: "One school-age child for the day." },
      { id: "sibling", name: "Sibling place", tag: "sibling", price: siblingPrice, info: "Discounted place for a brother or sister." },
      { id: "adult", name: "Adult place", tag: "adult", price: base, info: "An adult joining the session." }
    ];
  }

  /* ============================================================
   * 6. Persistence (HC.store only) — provider-authored tickets per camp.
   * ============================================================ */

  function readAll() {
    try {
      var o = HC.store.get(STORE_KEY, {});
      return (o && typeof o === "object") ? o : {};
    } catch (e) { return {}; }
  }
  function writeAll(obj) {
    try { return HC.store.set(STORE_KEY, obj || {}); } catch (e) { return false; }
  }

  // Tickets for a camp: saved set if present, else the default set.
  function ticketsFor(camp) {
    var id = camp && camp.id;
    if (id) {
      var all = readAll();
      var rec = all[id];
      if (Array.isArray(rec) && rec.length) {
        return rec.map(function (t) {
          return {
            id: t.id || HC.util.uid(),
            name: t.name || "Place",
            tag: normTag(t.tag) || "first-child",
            price: isFinite(Number(t.price)) ? Number(t.price) : 0,
            info: t.info || ""
          };
        });
      }
    }
    return defaultTickets(camp);
  }

  function saveTickets(campId, tickets) {
    if (!campId) return false;
    var all = readAll();
    all[campId] = (Array.isArray(tickets) ? tickets : []).map(function (t) {
      return {
        id: t.id || HC.util.uid(),
        name: t.name || "Place",
        tag: normTag(t.tag) || "first-child",
        price: isFinite(Number(t.price)) ? Number(t.price) : 0,
        info: t.info || ""
      };
    });
    return writeAll(all);
  }

  function clearCamp(campId) {
    if (!campId) return false;
    var all = readAll();
    if (Object.prototype.hasOwnProperty.call(all, campId)) {
      delete all[campId];
      return writeAll(all);
    }
    return true;
  }

  /* ============================================================
   * 7. render(mountEl) — provider authoring panel + live checkout sim.
   * ============================================================ */

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
  function el(tag, attrs, html) { return HC.util.el(tag, attrs, html); }

  function tagBadge(tag) {
    var d = tagDef(tag);
    if (!d) return el("span", null, "");
    var bg = d.key === "sibling" ? "#FCE8F0" : (d.key === "adult" ? "#E8EEFB" : "#F0E8F4");
    var fg = d.key === "sibling" ? "#9a1f5e" : (d.key === "adult" ? "#274a9a" : "#603488");
    return el("span", {
      style: "display:inline-flex;align-items:center;gap:5px;font-size:11px;font-weight:700;padding:3px 9px;" +
        "border-radius:999px;background:" + bg + ";color:" + fg + ";text-transform:uppercase;letter-spacing:.3px"
    }, esc(d.icon + " " + d.label));
  }

  function render(mountEl) {
    try {
      mountEl.innerHTML = "";
      var wrap = el("div", { style: "font-family:'Nunito Sans',system-ui,sans-serif" });

      // Pick a live camp to author tickets for.
      var providers = [];
      try { providers = HC.data.providers || []; } catch (e) { providers = []; }
      var camp = providers[0] || { id: "demo", name: "Demo Holiday Camp", price: "£32 per day", ageMin: 6, ageMax: 12 };

      wrap.appendChild(el("p", { style: "font-size:14px;color:var(--text,#383838);margin:0 0 12px" },
        "Tag each ticket on <strong>" + esc(camp.name) + "</strong> as " +
        "<strong>First Child</strong>, <strong>Sibling</strong> or <strong>Adult</strong> — exactly like Happity. " +
        "The tag decides what the booking collects and how it can be bought."));

      // ---- Ticket list (the provider's authored tickets) ----
      var tickets = ticketsFor(camp);
      wrap.appendChild(el("div", { class: "hc-sidehead", style: "margin:4px 0 8px" }, "Tickets on this camp"));
      var list = el("div", { style: "display:flex;flex-direction:column;gap:8px;margin:0 0 16px" });
      tickets.forEach(function (t) {
        var d = tagDef(t.tag) || TAGS["first-child"];
        var row = el("div", {
          style: "border:1.5px solid var(--line,#E6E6E6);border-radius:12px;padding:11px 13px;background:#fff"
        });
        var top = el("div", { style: "display:flex;align-items:center;gap:10px;flex-wrap:wrap" });
        top.appendChild(el("strong", { style: "color:var(--purple,#603488)" }, esc(t.name)));
        top.appendChild(tagBadge(t.tag));
        top.appendChild(el("span", { style: "margin-left:auto;font-weight:700" },
          esc(t.price > 0 ? HC.util.money(t.price) : "Free")));
        row.appendChild(top);
        row.appendChild(el("div", { style: "font-size:12.5px;color:var(--muted,#808080);margin-top:5px" },
          esc(d.blurb) +
          (collectsChildData(t.tag)
            ? " <span style='color:#2f7d4f'>Collects child data.</span>"
            : " <span style='color:#274a9a'>No child data collected.</span>")));
        list.appendChild(row);
      });
      wrap.appendChild(list);

      // ---- Live checkout simulator (parent's basket) ----
      wrap.appendChild(el("div", { class: "hc-sidehead", style: "margin:4px 0 8px" }, "Try it — parent basket"));
      wrap.appendChild(el("p", { style: "font-size:12.5px;color:var(--muted,#808080);margin:0 0 8px" },
        "Add quantities and press <em>Check out</em>. A Sibling place is blocked unless a full-price place is in the basket."));

      var basketState = {};
      tickets.forEach(function (t) { basketState[t.tag] = 0; });

      var controls = el("div", { style: "display:flex;flex-direction:column;gap:8px;margin:0 0 12px" });
      tickets.forEach(function (t) {
        var d = tagDef(t.tag) || TAGS["first-child"];
        var rowq = el("label", {
          style: "display:flex;align-items:center;gap:10px;font-size:13.5px;border:1.5px solid var(--line,#E6E6E6);" +
            "border-radius:12px;padding:9px 12px;background:#fff"
        });
        rowq.appendChild(tagBadge(t.tag));
        rowq.appendChild(el("span", null, esc(t.name)));
        var qty = el("input", {
          type: "number", min: "0", value: "0",
          style: "margin-left:auto;width:64px;padding:6px 8px;border:1.5px solid var(--line,#E6E6E6);border-radius:8px;font-size:14px"
        });
        qty.addEventListener("input", function () {
          var v = parseInt(qty.value, 10);
          basketState[t.tag] = (isFinite(v) && v > 0) ? v : 0;
        });
        rowq.appendChild(qty);
        controls.appendChild(rowq);
      });
      wrap.appendChild(controls);

      var result = el("div", { style: "min-height:24px;margin:0 0 8px" });
      wrap.appendChild(result);

      var btn = el("button", { class: "hc-btn", type: "button" }, "Check out");
      btn.addEventListener("click", function () {
        var basket = TAG_ORDER.map(function (tag) { return { tag: tag, qty: basketState[tag] || 0 }; });
        var v = validateBasket(basket);
        result.innerHTML = "";
        if (v.ok) {
          result.appendChild(el("div", {
            style: "background:#E1F0E4;color:#2f7d4f;border-radius:12px;padding:11px 13px;font-size:13.5px;font-weight:700"
          }, "✓ Checkout allowed — " + v.counts.total + " place(s), " +
            v.childDataLines + " collecting child data."));
          try { HC.util.toast("Checkout allowed"); } catch (e) {}
        } else {
          result.appendChild(el("div", {
            style: "background:var(--pink-tint,#FCE8F0);color:#9a1f5e;border-radius:12px;padding:11px 13px;font-size:13.5px"
          }, "✗ " + v.reasons.map(esc).join("<br>")));
          try { HC.util.toast("Checkout blocked"); } catch (e) {}
        }
      });
      wrap.appendChild(btn);

      mountEl.appendChild(wrap);
    } catch (e) {
      mountEl.innerHTML = '<p style="color:#9a1f5e">Ticket-tags preview failed: ' +
        esc(e && e.message ? e.message : String(e)) + "</p>";
    }
  }

  /* ============================================================
   * 8. selfTest — exercises the LOGIC and the acceptance criterion.
   * ============================================================ */

  function selfTest() {
    var pass = 0, fail = 0, log = [];
    function check(label, fn) {
      try { fn(); pass += 1; log.push("✓ " + label); }
      catch (e) { fail += 1; log.push("✗ " + label + " — " + (e && e.message ? e.message : String(e))); }
    }

    // ===== ACCEPTANCE CRITERION, part A =====
    // A sibling ticket is purchasable only with a full-price ticket.
    check("ACCEPTANCE A: a Sibling-only basket is BLOCKED at checkout", function () {
      var v = validateBasket([{ tag: "sibling", qty: 1 }]);
      HC.assert(v.ok === false, "a sibling-only basket must not be checkout-able");
      HC.assert(canCheckout([{ tag: "sibling", qty: 1 }]) === false, "canCheckout must be false for sibling-only");
      HC.assert(v.reasons.indexOf(FULL_PRICE_REQUIRED_MSG) !== -1,
        "the Happity full-price-required message must be shown");
    });

    check("ACCEPTANCE A: Sibling becomes purchasable once a First Child (full-price) is added", function () {
      var basket = [{ tag: "sibling", qty: 1 }, { tag: "first-child", qty: 1 }];
      var v = validateBasket(basket);
      HC.assert(v.ok === true, "sibling + first-child must be allowed (full-price present)");
      HC.assert(canCheckout(basket) === true, "canCheckout must be true once a full-price place is present");
      HC.assert(v.counts.fullPrice === 1 && v.counts.sibling === 1, "counts should reflect 1 full-price + 1 sibling");
    });

    check("ACCEPTANCE A: an ADULT place also satisfies the full-price requirement for a sibling", function () {
      // Article: "alongside a full-price first child OR adult ticket".
      var basket = [{ tag: "sibling", qty: 2 }, { tag: "adult", qty: 1 }];
      HC.assert(canCheckout(basket) === true,
        "an adult full-price place must unlock sibling places");
      // ...but two siblings with NO full-price place is still blocked.
      HC.assert(canCheckout([{ tag: "sibling", qty: 2 }]) === false,
        "multiple siblings with no full-price place must still be blocked");
    });

    check("ACCEPTANCE A: another sibling does NOT count as the required full-price place", function () {
      // Two sibling lines must not satisfy each other.
      var v = validateBasket([{ tag: "sibling", qty: 1 }, { tag: "sibling", qty: 1 }]);
      HC.assert(v.ok === false, "siblings cannot satisfy the full-price rule for each other");
      HC.assert(v.counts.fullPrice === 0, "two siblings means zero full-price places");
    });

    // ===== ACCEPTANCE CRITERION, part B =====
    // Adult tickets collect no child data.
    check("ACCEPTANCE B: collectsChildData('adult') is FALSE; first-child & sibling are TRUE", function () {
      HC.assert(collectsChildData("adult") === false, "adult tickets must collect NO child data");
      HC.assert(collectsChildData("first-child") === true, "first-child collects child data");
      HC.assert(collectsChildData("sibling") === true, "sibling is a child place and collects child data");
    });

    check("ACCEPTANCE B: a built ADULT line carries none of the child fields, even if supplied", function () {
      // Hostile input: caller wrongly tries to attach child data to an adult line.
      var line = lineDataFor("adult", {
        adultName: "Sam", adultEmail: "sam@x.com",
        childName: "Mo", childAge: 8, photoConsent: true
      });
      HC.assert(lineHasNoChildData(line) === true, "adult line must strip ALL child fields");
      HC.assert(!("childName" in line) && !("childAge" in line) && !("photoConsent" in line),
        "no child field may survive on an adult line");
      HC.assert(line.adultName === "Sam", "adult line must keep the adult's own details");
    });

    check("ACCEPTANCE B: a First Child line DOES carry child fields (age + photo consent)", function () {
      var line = lineDataFor("first-child", { childName: "Mo", childAge: 8, photoConsent: true });
      HC.assert(line.childName === "Mo" && line.childAge === 8, "first-child must keep child name + age");
      HC.assert(line.photoConsent === true, "first-child must keep the photo-consent flag");
      HC.assert(lineHasNoChildData(line) === false, "a first-child line must report that it has child data");
    });

    // ===== Supporting logic =====
    check("First Child is full-price; Sibling is not; Adult is full-price", function () {
      HC.assert(isFullPrice("first-child") === true, "first-child is full-price");
      HC.assert(isFullPrice("adult") === true, "adult is full-price");
      HC.assert(isFullPrice("sibling") === false, "sibling is discounted, not full-price");
    });

    check("requiresFullPrice is true ONLY for sibling", function () {
      HC.assert(requiresFullPrice("sibling") === true, "sibling requires a full-price place");
      HC.assert(requiresFullPrice("first-child") === false, "first-child has no such requirement");
      HC.assert(requiresFullPrice("adult") === false, "adult has no such requirement");
    });

    check("Tag normalisation accepts common aliases and rejects junk", function () {
      HC.assert(normTag("FirstChild") === "first-child", "FirstChild -> first-child");
      HC.assert(normTag("siblings") === "sibling", "siblings -> sibling");
      HC.assert(normTag("Adults") === "adult", "Adults -> adult");
      HC.assert(normTag("wizard") === null, "unknown tag -> null");
      // An unknown tag in a basket blocks checkout (defensive).
      HC.assert(canCheckout([{ tag: "wizard", qty: 1 }]) === false, "unknown ticket type blocks checkout");
    });

    check("An empty basket cannot be checked out", function () {
      HC.assert(canCheckout([]) === false, "empty basket is not checkout-able");
      HC.assert(canCheckout([{ tag: "sibling", qty: 0 }]) === false, "all-zero-qty basket is empty");
      // A lone full-price place is fine.
      HC.assert(canCheckout([{ tag: "first-child", qty: 1 }]) === true, "a single full-price place is fine");
      HC.assert(canCheckout([{ tag: "adult", qty: 1 }]) === true, "a single adult place is fine");
    });

    check("childDataLines counts every child place, ignoring adult places", function () {
      var v = validateBasket([
        { tag: "first-child", qty: 1 },
        { tag: "sibling", qty: 2 },
        { tag: "adult", qty: 3 }
      ]);
      HC.assert(v.ok === true, "mixed basket with a full-price place is allowed");
      HC.assert(v.childDataLines === 3, "child-data places = 1 first-child + 2 siblings = 3, got " + v.childDataLines);
      HC.assert(v.counts.fullPrice === 4, "full-price places = 1 first-child + 3 adults = 4, got " + v.counts.fullPrice);
    });

    // ===== Persistence round-trip via HC.store (what the UI saves) =====
    check("Provider-authored tickets round-trip through HC.store and default set is well-formed", function () {
      var probe = "__ptt_probe_camp__";
      var all = readAll();
      var snapshot = JSON.parse(JSON.stringify(all || {}));
      try {
        clearCamp(probe);
        // Default set: one of each tag, sibling cheaper than first-child.
        var defs = defaultTickets({ id: probe, price: "£40 per day" });
        var tags = defs.map(function (t) { return t.tag; }).sort().join(",");
        HC.assert(tags === "adult,first-child,sibling", "default set must contain all three tags, got " + tags);
        var fc = defs.filter(function (t) { return t.tag === "first-child"; })[0];
        var sib = defs.filter(function (t) { return t.tag === "sibling"; })[0];
        HC.assert(fc.price === 40, "first-child should take the £40 base price, got " + fc.price);
        HC.assert(sib.price < fc.price, "sibling must be discounted below the full price");

        // Save a custom set, read it back.
        saveTickets(probe, [{ name: "Day place", tag: "first-child", price: 25 }]);
        var back = ticketsFor({ id: probe });
        HC.assert(back.length === 1 && back[0].tag === "first-child" && back[0].price === 25,
          "saved ticket must round-trip with its tag and price");
      } finally {
        clearCamp(probe);
        writeAll(snapshot);
      }
    });

    check("basePriceFor parses £ amounts and handles free/unknown defensively", function () {
      HC.assert(basePriceFor({ price: "£35 per day" }) === 35, "£35 -> 35");
      HC.assert(basePriceFor({ price: "Free for eligible HAF places" }) === 0, "free -> 0");
      HC.assert(basePriceFor({ price: "Ask provider" }) === 30, "unparseable -> 30 default");
      HC.assert(basePriceFor({}) === 30, "missing price -> 30 default");
    });

    check("Live directory: every provider yields a valid default ticket set", function () {
      var providers = [];
      try { providers = HC.data.providers || []; } catch (e) { providers = []; }
      // Don't hard-fail if data isn't loaded in a headless run; just assert the
      // shape for whatever we do have, and prove the generator on a synthetic camp.
      var sample = providers.length ? providers.slice(0, 5) : [{ id: "syn", price: "£30" }];
      sample.forEach(function (c) {
        var defs = defaultTickets(c);
        HC.assert(defs.length === 3, "every camp should seed exactly 3 tagged tickets");
        // A basket of the seeded sibling alone is blocked; sibling + first-child passes.
        var sibTag = defs.filter(function (t) { return t.tag === "sibling"; })[0].tag;
        HC.assert(canCheckout([{ tag: sibTag, qty: 1 }]) === false,
          "seeded sibling alone must be blocked for camp " + (c.id || "?"));
        HC.assert(canCheckout([{ tag: "sibling", qty: 1 }, { tag: "first-child", qty: 1 }]) === true,
          "seeded sibling + first-child must pass for camp " + (c.id || "?"));
      });
    });

    return { pass: pass, fail: fail, log: log };
  }

  /* ============================================================
   * 9. Register.
   * ============================================================ */

  HC.registerFeature({
    id: "provider-ticket-tags",
    title: "Ticket tags — First Child / Sibling / Adult",
    side: "provider",
    icon: "🏷️",
    summary: "Tag each ticket as First Child, Sibling or Adult. Sibling places only sell alongside a full-price place; adult places collect no child data.",
    render: render,
    selfTest: selfTest
  });
})();
