/* HolidayCamp feature — parent-pay-on-door
 *
 * 'Pay on the door' listings — no online payment  (parent side)
 *
 * Replicates Happity's "How can I make a class 'Pay on the door'?" feature
 * (support article 8255786). Evidence highlights:
 *   - a provider can "make it clear that you accept on the door payments
 *     without needing to pre book"
 *   - two mechanisms: (1) a free-text note in the booking information field
 *     ("add a small note to let customers know they can pay on the door"),
 *     and (2) a "Do you accept on-the-door drop-ins?" tick box on the class.
 *   - the net effect parents see: the listing is flagged as pay-on-door and
 *     there is NO online checkout — you turn up and pay at the venue.
 *
 * Framed for SCHOOL-AGE HOLIDAY CAMPS: some E17 camps (HAF / Eequ drop-ins,
 * council routes, ad-hoc single days) take payment at the door instead of an
 * online pre-pay flow. A pay-on-door camp shows a "Pay on the door" label and
 * suppresses the "Book & pay now" online checkout; a normal camp keeps it.
 *
 * ACCEPTANCE CRITERION (asserted in selfTest):
 *   A pay-on-door camp shows a 'pay on the door' label and no online checkout.
 *
 * Self-contained, defensive, no imports/exports. Calls HC.registerFeature.
 */
(function () {
  "use strict";

  // Defensive: never throw at module load if HC isn't present.
  if (typeof window === "undefined" || !window.HC || typeof window.HC.registerFeature !== "function") {
    if (typeof console !== "undefined" && console.warn) {
      console.warn("[HC] parent-pay-on-door: HC core not found; skipping registration.");
    }
    return;
  }

  var HC = window.HC;

  var STORE_KEY = "parent_pay_on_door_overrides";
  var DOOR_LABEL = "Pay on the door"; // the label parents see on the listing

  /* ---------------- pure logic (testable, DOM-free) ---------------- */

  // Phrases that, when present in a camp's free-text booking/price info,
  // mirror Happity's "small note to let customers know they can pay on the
  // door" — i.e. the provider has told parents no online pre-pay is needed.
  var DOOR_PHRASES = [
    "pay on the door",
    "pay on door",
    "on the door",
    "on-the-door",
    "drop-in",
    "drop in",
    "dropin",
    "pay at the door",
    "pay at venue",
    "pay on arrival",
    "no need to pre book",
    "no need to prebook",
    "no need to pre-book",
    "without needing to pre book",
    "without booking",
    "no booking needed",
    "no booking required",
    "turn up"
  ];

  function asText(v) {
    return typeof v === "string" ? v : (v == null ? "" : String(v));
  }

  // Mechanism (1) from the article: detect a "pay on the door" note in the
  // provider's own free-text booking information / price string.
  function noteSaysPayOnDoor(text) {
    var hay = asText(text).toLowerCase();
    if (!hay) return false;
    for (var i = 0; i < DOOR_PHRASES.length; i++) {
      if (hay.indexOf(DOOR_PHRASES[i]) !== -1) return true;
    }
    return false;
  }

  // Mechanism (2) from the article: the explicit "Do you accept on-the-door
  // drop-ins?" tick box. In our model this is a per-camp override the parent /
  // provider can toggle, persisted via HC.store (never raw localStorage).
  function readOverrides() {
    try {
      var o = HC.store.get(STORE_KEY, {});
      return (o && typeof o === "object") ? o : {};
    } catch (e) {
      return {};
    }
  }

  function writeOverrides(obj) {
    try { return HC.store.set(STORE_KEY, obj || {}); } catch (e) { return false; }
  }

  // The CORE decision. Given a camp record (+ any saved tick-box override),
  // decide what the parent-facing listing shows. This is the single source of
  // truth the acceptance criterion is checked against.
  //
  // Returns:
  //   payOnDoor          : Boolean — is this a pay-on-the-door listing?
  //   label              : String|null — the badge text shown, or null
  //   showOnlineCheckout : Boolean — is the online "Book & pay now" shown?
  //   ctaLabel           : String — the call-to-action text for the listing
  //   reason             : String — why it was classified this way (for UI)
  function listingFor(camp, override) {
    var c = camp || {};
    var tickBox; // mechanism (2): explicit tick box wins if set
    if (override === true || override === false) {
      tickBox = override;
    } else if (typeof c.acceptsOnTheDoor === "boolean") {
      tickBox = c.acceptsOnTheDoor; // a record could carry the flag directly
    } else {
      tickBox = null; // not explicitly set
    }

    // mechanism (1): a note in the booking/price free text
    var noteDoor = noteSaysPayOnDoor(c.booking) || noteSaysPayOnDoor(c.price);

    var payOnDoor;
    var reason;
    if (tickBox === true) {
      payOnDoor = true;
      reason = "Provider ticked 'accept on-the-door drop-ins'.";
    } else if (tickBox === false) {
      // An explicit "no" tick box overrides any ambiguous note.
      payOnDoor = false;
      reason = "Provider requires booking ahead.";
    } else if (noteDoor) {
      payOnDoor = true;
      reason = "Booking note says you can pay on the door.";
    } else {
      payOnDoor = false;
      reason = "Standard online booking.";
    }

    return {
      payOnDoor: payOnDoor,
      label: payOnDoor ? DOOR_LABEL : null,
      // No online checkout when paying on the door — that is the whole point.
      showOnlineCheckout: !payOnDoor,
      ctaLabel: payOnDoor ? "Just turn up & pay at the venue" : "Book & pay now",
      reason: reason
    };
  }

  // Find live camps that already read as pay-on-the-door from their real
  // booking/price text (school-age holiday camps in the E17 directory).
  function seedCamps() {
    var providers = [];
    try { providers = HC.data.providers || []; } catch (e) { providers = []; }

    var doorCamp = null;   // a real camp whose note implies pay-on-door
    var bookCamp = null;   // a real camp that needs online booking
    for (var i = 0; i < providers.length; i++) {
      var p = providers[i];
      if (!p) continue;
      var isDoor = noteSaysPayOnDoor(p.booking) || noteSaysPayOnDoor(p.price);
      if (isDoor && !doorCamp) doorCamp = p;
      if (!isDoor && !bookCamp) bookCamp = p;
      if (doorCamp && bookCamp) break;
    }

    // Always provide sensible synthetic fallbacks so the demo + tests never
    // depend on a specific live record existing.
    if (!doorCamp) {
      doorCamp = {
        id: "demo-door-camp",
        name: "E17 Summer Drop-in Camp",
        booking: "Drop-in sessions — no need to pre book, pay on the door at the venue.",
        price: "GBP 8 per session, pay on the door"
      };
    }
    if (!bookCamp) {
      bookCamp = {
        id: "demo-book-camp",
        name: "Walthamstow Multi-Sports Week",
        booking: "Book your week through the online camp page.",
        price: "GBP 140 full week"
      };
    }
    return { doorCamp: doorCamp, bookCamp: bookCamp };
  }

  /* ---------------- UI ---------------- */

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function el(tag, attrs, html) {
    try { return HC.util.el(tag, attrs, html); }
    catch (e) {
      var n = document.createElement(tag || "div");
      if (html != null) n.innerHTML = html;
      return n;
    }
  }

  // Render one listing card reflecting listingFor() output.
  function listingCard(camp, override, onToggle) {
    var info = listingFor(camp, override);

    var card = el("div", {
      style: "border:1.5px solid var(--line,#E6E6E6);border-radius:14px;padding:16px 18px;background:#fff;margin:0 0 14px"
    });

    // Title row + (optional) pay-on-door badge
    var titleRow = el("div", { style: "display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:0 0 6px" });
    titleRow.appendChild(el("span", {
      style: "font-family:'Quicksand',system-ui,sans-serif;font-weight:700;font-size:16px;color:var(--purple,#603488)"
    }, esc(camp && camp.name ? camp.name : "Holiday camp")));

    if (info.label) {
      // THE LABEL the acceptance criterion is about.
      titleRow.appendChild(el("span", {
        "data-hc-door-label": "1",
        style: "font-family:'Quicksand',system-ui,sans-serif;font-weight:700;font-size:11px;text-transform:uppercase;" +
          "letter-spacing:.4px;background:var(--yellow,#FCD400);color:var(--ink,#1A1A1A);padding:4px 10px;border-radius:999px"
      }, "💷 " + esc(DOOR_LABEL)));
    }
    card.appendChild(titleRow);

    card.appendChild(el("p", { style: "font-size:13px;color:var(--muted,#808080);margin:0 0 10px" },
      esc(info.reason)));

    // CTA area: online checkout vs door notice — exactly one of them.
    var ctaWrap = el("div", { "data-hc-cta": "1" });
    if (info.showOnlineCheckout) {
      var bookBtn = el("button", {
        type: "button", class: "hc-btn", "data-hc-online-checkout": "1"
      }, esc(info.ctaLabel));
      bookBtn.addEventListener("click", function () {
        try { HC.util.toast("Opening online checkout for " + (camp && camp.name ? camp.name : "this camp") + "…"); } catch (e) {}
      });
      ctaWrap.appendChild(bookBtn);
    } else {
      // No online checkout. A door-payment notice replaces it.
      ctaWrap.appendChild(el("div", {
        "data-hc-door-notice": "1",
        style: "display:flex;align-items:center;gap:8px;background:var(--purple-tint,#F0E8F4);color:var(--purple,#603488);" +
          "font-weight:700;font-size:13.5px;padding:10px 14px;border-radius:12px"
      }, "🚪 " + esc(info.ctaLabel) + " — no online payment needed."));
    }
    card.appendChild(ctaWrap);

    // Mechanism (2): the "Do you accept on-the-door drop-ins?" tick box.
    var tickRow = el("label", {
      style: "display:flex;align-items:center;gap:9px;font-size:13px;color:var(--text,#383838);margin:12px 0 0;cursor:pointer"
    });
    var tick = el("input", { type: "checkbox" });
    tick.checked = !!info.payOnDoor;
    tick.addEventListener("change", function () {
      if (typeof onToggle === "function") onToggle(tick.checked);
    });
    tickRow.appendChild(tick);
    tickRow.appendChild(el("span", null, "Accept on-the-door drop-ins (pay at the venue)"));
    card.appendChild(tickRow);

    return card;
  }

  function render(mountEl) {
    if (!mountEl) return;
    mountEl.innerHTML = "";

    var seeds = seedCamps();
    var overrides = readOverrides();

    var wrap = el("div", { style: "font-family:'Nunito Sans',system-ui,sans-serif;color:var(--text,#383838)" });
    wrap.appendChild(el("p", { style: "font-size:14px;margin:0 0 16px" },
      "Some holiday camps take payment <strong>at the door</strong> — you just turn up, no online pre-pay. " +
      "A pay-on-the-door camp shows a <strong>“" + esc(DOOR_LABEL) + "”</strong> label and hides the online checkout. " +
      "Toggle the drop-in tick box on any card to see the listing switch."));

    function rebuild() {
      list.innerHTML = "";
      overrides = readOverrides();

      // doorCamp: keyed by id so its tick-box state persists.
      list.appendChild(listingCard(seeds.doorCamp, ovr(seeds.doorCamp), function (on) {
        setOvr(seeds.doorCamp, on); rebuild();
      }));
      list.appendChild(listingCard(seeds.bookCamp, ovr(seeds.bookCamp), function (on) {
        setOvr(seeds.bookCamp, on); rebuild();
      }));
    }

    function ovr(camp) {
      var id = camp && camp.id;
      if (id && Object.prototype.hasOwnProperty.call(overrides, id)) return overrides[id];
      return undefined;
    }
    function setOvr(camp, on) {
      var id = camp && camp.id;
      if (!id) return;
      var o = readOverrides();
      o[id] = !!on;
      writeOverrides(o);
    }

    var list = el("div", null);
    wrap.appendChild(list);
    mountEl.appendChild(wrap);
    rebuild();
  }

  /* ---------------- selfTest ---------------- */

  function selfTest() {
    var pass = 0, fail = 0, log = [];
    function check(label, fn) {
      try { fn(); pass += 1; log.push("✓ " + label); }
      catch (e) { fail += 1; log.push("✗ " + label + " — " + (e && e.message ? e.message : String(e))); }
    }

    // ===== ACCEPTANCE CRITERION =====
    // A pay-on-door camp shows a 'pay on the door' label and no online checkout.
    check("ACCEPTANCE: pay-on-door camp shows the label AND no online checkout", function () {
      var camp = { name: "E17 Drop-in Camp", booking: "Drop-in — pay on the door, no need to pre book." };
      var info = listingFor(camp);
      HC.assert(info.payOnDoor === true, "camp should be classified pay-on-door");
      HC.assert(info.label === DOOR_LABEL, "label must read 'Pay on the door', got " + info.label);
      HC.assert(/pay on the door/i.test(info.label || ""), "label text must mention 'pay on the door'");
      HC.assert(info.showOnlineCheckout === false, "online checkout must be hidden for pay-on-door");
    });

    // Mirror image: a normal camp keeps online checkout and shows no door label.
    check("Normal online-booking camp keeps checkout and shows NO door label", function () {
      var camp = { name: "Multi-Sports Week", booking: "Book your week through the online camp page.", price: "GBP 140 full week" };
      var info = listingFor(camp);
      HC.assert(info.payOnDoor === false, "ordinary camp should not be pay-on-door");
      HC.assert(info.label === null, "no door label expected, got " + info.label);
      HC.assert(info.showOnlineCheckout === true, "online checkout must be shown for a normal camp");
    });

    // Mechanism (1): the free-text booking note (Happity's "small note").
    check("Booking note phrasing flips a listing to pay-on-door", function () {
      var phrases = [
        "You can pay on the door.",
        "Drop-in sessions, no need to pre book.",
        "Just turn up and pay at the venue.",
        "Pay on arrival — no booking required."
      ];
      for (var i = 0; i < phrases.length; i++) {
        var info = listingFor({ booking: phrases[i] });
        HC.assert(info.payOnDoor === true, "should detect door note in: " + phrases[i]);
        HC.assert(info.showOnlineCheckout === false, "no checkout for door note: " + phrases[i]);
      }
    });

    // A door note can also live in the PRICE string ("£8, pay on the door").
    check("Pay-on-door note in the price string is detected too", function () {
      var info = listingFor({ price: "GBP 8 per session, pay on the door", booking: "" });
      HC.assert(info.payOnDoor === true, "price-string door note should count");
      HC.assert(info.label === DOOR_LABEL, "label expected from price note");
    });

    // Mechanism (2): the explicit tick box overrides any ambiguous text.
    check("Tick box = true forces pay-on-door even with an online booking note", function () {
      var camp = { booking: "Book through the online camp page." };
      var info = listingFor(camp, true);
      HC.assert(info.payOnDoor === true, "tick box true => pay-on-door");
      HC.assert(info.showOnlineCheckout === false, "tick box true => no online checkout");
      HC.assert(info.label === DOOR_LABEL, "tick box true => door label");
    });

    check("Tick box = false forces online booking even with a door note", function () {
      var camp = { booking: "Drop-in, pay on the door." };
      var info = listingFor(camp, false);
      HC.assert(info.payOnDoor === false, "explicit false should override the note");
      HC.assert(info.showOnlineCheckout === true, "tick box false => online checkout stays");
      HC.assert(info.label === null, "tick box false => no door label");
    });

    // Invariant: label presence and checkout absence are always linked.
    check("Door label and online checkout are mutually exclusive (invariant)", function () {
      var cases = [
        { booking: "pay on the door" },
        { booking: "online booking only" },
        { booking: "drop-in welcome" },
        { price: "Free for eligible places" },
        {}
      ];
      for (var i = 0; i < cases.length; i++) {
        var info = listingFor(cases[i]);
        // exactly one of: (label present) or (checkout shown)
        var hasLabel = info.label !== null;
        HC.assert(hasLabel !== info.showOnlineCheckout,
          "label and checkout must be opposites for case " + i +
          " (label=" + hasLabel + ", checkout=" + info.showOnlineCheckout + ")");
        HC.assert(hasLabel === info.payOnDoor, "label presence must track payOnDoor for case " + i);
      }
    });

    // Defensive: rubbish / missing input must not throw and must default safe.
    check("Defensive: bad/empty input defaults to ordinary online booking", function () {
      var inputs = [null, undefined, {}, { booking: null }, { booking: 12345 }, { price: {} }];
      for (var i = 0; i < inputs.length; i++) {
        var info = listingFor(inputs[i]);
        HC.assert(info.payOnDoor === false, "bad input #" + i + " should default to not-door");
        HC.assert(info.showOnlineCheckout === true, "bad input #" + i + " keeps online checkout");
        HC.assert(info.label === null, "bad input #" + i + " has no door label");
      }
      // noteSaysPayOnDoor must be robust to non-strings.
      HC.assert(noteSaysPayOnDoor(null) === false, "null note => false");
      HC.assert(noteSaysPayOnDoor(42) === false, "number note => false");
      HC.assert(noteSaysPayOnDoor("") === false, "empty note => false");
    });

    // Live data: seed picks real school-age camps and both states are reachable.
    check("Seed camps drawn from live providers, both listing states reachable", function () {
      var seeds = seedCamps();
      HC.assert(seeds.doorCamp && seeds.bookCamp, "should seed a door camp and a booking camp");
      var doorInfo = listingFor(seeds.doorCamp);
      var bookInfo = listingFor(seeds.bookCamp);
      HC.assert(doorInfo.payOnDoor === true, "door seed must classify as pay-on-door");
      HC.assert(doorInfo.label === DOOR_LABEL && doorInfo.showOnlineCheckout === false,
        "door seed: label shown, checkout hidden");
      HC.assert(bookInfo.payOnDoor === false && bookInfo.showOnlineCheckout === true,
        "booking seed: online checkout shown, no label");
    });

    // Persistence: the tick-box override round-trips through HC.store.
    check("Tick-box override persists via HC.store (namespaced)", function () {
      var before = readOverrides();
      var snapshot = JSON.parse(JSON.stringify(before || {}));
      snapshot["__pod_test__"] = true;
      var ok = writeOverrides(snapshot);
      HC.assert(ok !== false, "writeOverrides should succeed");
      var got = readOverrides();
      HC.assert(got && got.__pod_test__ === true, "override should round-trip");
      // And it actually drives the decision when passed as the override arg.
      var info = listingFor({ booking: "online booking only" }, got.__pod_test__);
      HC.assert(info.payOnDoor === true && info.showOnlineCheckout === false,
        "persisted true override should force pay-on-door");
      // clean up our probe key so we don't pollute saved state.
      delete snapshot["__pod_test__"];
      writeOverrides(snapshot);
    });

    return { pass: pass, fail: fail, log: log };
  }

  /* ---------------- register ---------------- */

  HC.registerFeature({
    id: "parent-pay-on-door",
    title: "Pay on the door",
    side: "parent",
    icon: "💷",
    summary: "Spot camps you can just turn up to and pay at the venue. Pay-on-the-door camps show a 'Pay on the door' label and hide the online checkout — no pre-booking needed, following the source marketplace pattern for on-the-door drop-ins.",
    render: render,
    selfTest: selfTest
  });
})();
