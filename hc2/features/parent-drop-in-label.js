/* HolidayCamp feature — parent-drop-in-label
 *
 * 'Drop-ins accepted' indicator — a 'Drop-ins welcome' label  (parent side)
 *
 * Replicates Happity's drop-in label/filter. Evidence:
 *   - Article 4147863 ("How to add the different filters and labels"):
 *       "Drop-in — click 'drop-ins accepted' when creating a new class. This
 *        is found on the 'Other' tab."  => the provider ticks a box and the
 *        class gets a DROP-IN LABEL/FILTER parents see in search results.
 *   - Article 8255669 ("Parents/Carers FAQs — Can I just turn up to a class?"):
 *       "Most providers recommend booking before you go ... However, they will
 *        specify on their profile if they accept drop-ins."  => the parent-side
 *        signal is exactly: does this listing say drop-ins are accepted?
 *
 * Framed for SCHOOL-AGE HOLIDAY CAMPS: some E17 camps run open/ad-hoc sessions
 * you can just turn up to (HAF open sessions, leisure-centre drop-in days,
 * single-day clubs). A drop-in camp shows a "Drop-ins welcome" label; parents
 * can also filter the directory to "Only drop-in camps".
 *
 * Two mechanisms decide the flag, mirroring Happity:
 *   (1) an explicit "drop-ins accepted" tick box (the 'Other' tab), persisted
 *       per-camp via HC.store; and
 *   (2) the camp's own free-text (booking / summary / categories) saying
 *       "drop-in", "just turn up", "no booking needed", etc.
 *
 * ACCEPTANCE CRITERION (asserted in selfTest):
 *   Camps flagged drop-in show a 'drop-ins welcome' label.
 *
 * Self-contained, defensive, no imports/exports. Calls HC.registerFeature.
 */
(function () {
  "use strict";

  // Defensive: never throw at module load if HC isn't present.
  if (typeof window === "undefined" || !window.HC || typeof window.HC.registerFeature !== "function") {
    if (typeof console !== "undefined" && console.warn) {
      console.warn("[HC] parent-drop-in-label: HC core not found; skipping registration.");
    }
    return;
  }

  var HC = window.HC;

  var STORE_KEY = "parent_drop_in_overrides"; // { campId: true|false }
  var DROP_IN_LABEL = "Drop-ins welcome";     // the label parents see (criterion)

  /* ---------------- pure logic (testable, DOM-free) ---------------- */

  // Free-text phrases that mirror a provider having said, in their own words,
  // that you can just turn up — Happity's "they will specify on their profile
  // if they accept drop-ins".
  var DROP_IN_PHRASES = [
    "drop-in",
    "drop in",
    "dropin",
    "drop-ins",
    "drop ins",
    "drop-ins accepted",
    "drop-ins welcome",
    "just turn up",
    "turn up on the day",
    "no need to book",
    "no need to pre book",
    "no need to pre-book",
    "no booking needed",
    "no booking required",
    "booking not required",
    "no advance booking",
    "pay and play",
    "open session",
    "open play"
  ];

  function asText(v) {
    return typeof v === "string" ? v : (v == null ? "" : String(v));
  }

  // Mechanism (2): does the camp's own free text read as drop-in friendly?
  // We scan booking info, summary, price and category tags — wherever a
  // provider would naturally say it.
  function textSaysDropIn(camp) {
    var c = camp || {};
    var parts = [c.booking, c.summary, c.price, c.goodFor, c.hours];
    try {
      if (Array.isArray(c.categories)) parts.push(c.categories.join(" "));
    } catch (e) { /* ignore */ }
    var hay = "";
    for (var i = 0; i < parts.length; i++) hay += " " + asText(parts[i]).toLowerCase();
    if (!hay.trim()) return false;
    for (var j = 0; j < DROP_IN_PHRASES.length; j++) {
      if (hay.indexOf(DROP_IN_PHRASES[j]) !== -1) return true;
    }
    return false;
  }

  // Mechanism (1): the explicit "drop-ins accepted" tick box (Happity's
  // 'Other' tab), stored per-camp. Persisted via HC.store (never raw
  // localStorage).
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

  function overrideFor(campId) {
    if (!campId) return undefined;
    var o = readOverrides();
    if (Object.prototype.hasOwnProperty.call(o, campId)) return o[campId];
    return undefined;
  }

  function setOverride(campId, on) {
    if (!campId) return false;
    var o = readOverrides();
    o[campId] = !!on;
    return writeOverrides(o);
  }

  function clearOverride(campId) {
    if (!campId) return false;
    var o = readOverrides();
    if (Object.prototype.hasOwnProperty.call(o, campId)) {
      delete o[campId];
      return writeOverrides(o);
    }
    return true;
  }

  // THE CORE DECISION. Given a camp (+ optional explicit tick-box override),
  // decide whether the drop-in label is shown. Single source of truth the
  // acceptance criterion is checked against.
  //
  // Returns:
  //   flagged : Boolean — is this camp flagged as accepting drop-ins?
  //   label   : String|null — "Drop-ins welcome" when flagged, else null
  //   reason  : String — why it was classified this way (for the UI)
  //   source  : 'tick'|'text'|'none' — which mechanism decided it
  function labelFor(camp, override) {
    var c = camp || {};

    // Resolve the explicit tick box: argument wins, else a flag carried on the
    // record, else any saved per-camp override.
    var tick;
    if (override === true || override === false) {
      tick = override;
    } else if (typeof c.acceptsDropIns === "boolean") {
      tick = c.acceptsDropIns;
    } else {
      var saved = overrideFor(c.id);
      tick = (saved === true || saved === false) ? saved : null;
    }

    var flagged, reason, source;
    if (tick === true) {
      flagged = true;
      reason = "Provider ticked 'drop-ins accepted'.";
      source = "tick";
    } else if (tick === false) {
      // An explicit "no" tick box overrides any ambiguous text.
      flagged = false;
      reason = "Provider asks you to book ahead.";
      source = "tick";
    } else if (textSaysDropIn(c)) {
      flagged = true;
      reason = "This camp's listing says drop-ins are accepted.";
      source = "text";
    } else {
      flagged = false;
      reason = "Booking recommended — no drop-in offer stated.";
      source = "none";
    }

    return {
      flagged: flagged,
      label: flagged ? DROP_IN_LABEL : null,
      reason: reason,
      source: source
    };
  }

  // Convenience boolean used by the directory filter ("Only drop-in camps").
  function acceptsDropIns(camp, override) {
    return labelFor(camp, override).flagged === true;
  }

  // The parent-side search filter from Happity: narrow a list to only the
  // camps that show the drop-in label.
  function filterDropInOnly(list) {
    var arr = [];
    try { arr = Array.isArray(list) ? list : []; } catch (e) { arr = []; }
    var out = [];
    for (var i = 0; i < arr.length; i++) {
      if (acceptsDropIns(arr[i])) out.push(arr[i]);
    }
    return out;
  }

  // Pick representative live camps for the demo + tests: one already flagged
  // (or marked via override) and one not. Synthetic fallbacks guarantee both
  // states exist regardless of the live directory.
  function seedCamps() {
    var providers = [];
    try { providers = HC.data.providers || []; } catch (e) { providers = []; }

    var dropCamp = null, bookCamp = null;
    for (var i = 0; i < providers.length; i++) {
      var p = providers[i];
      if (!p) continue;
      // Use the text mechanism only here, so the seed reflects the raw data
      // (independent of any override the demo itself sets later).
      var isDrop = textSaysDropIn(p);
      if (isDrop && !dropCamp) dropCamp = p;
      if (!isDrop && !bookCamp) bookCamp = p;
      if (dropCamp && bookCamp) break;
    }

    if (!bookCamp) {
      bookCamp = {
        id: "demo-book-camp",
        name: "Walthamstow Multi-Sports Week",
        booking: "Book your full week through the online camp page.",
        summary: "A structured five-day multi-sports week.",
        price: "GBP 140 full week"
      };
    }
    // If no live camp reads as drop-in, fall back to flagging a real booking
    // camp via the tick box so the demo always has a flagged example that maps
    // to a real E17 record where possible.
    if (!dropCamp) {
      var base = providers && providers[0];
      dropCamp = {
        id: (base && base.id) ? base.id : "demo-drop-camp",
        name: (base && base.name) ? base.name : "E17 Summer Open Sessions",
        booking: "Open drop-in sessions — just turn up, no need to book.",
        summary: "Pay-and-play open sessions across the summer.",
        price: "GBP 8 per session"
      };
    }
    return { dropCamp: dropCamp, bookCamp: bookCamp };
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

  // The label chip the acceptance criterion is about.
  function dropInBadge() {
    return el("span", {
      "data-hc-dropin-label": "1",
      style: "font-family:'Quicksand',system-ui,sans-serif;font-weight:700;font-size:11px;text-transform:uppercase;" +
        "letter-spacing:.4px;background:#E1F0E4;color:#2f7d4f;padding:4px 10px;border-radius:999px;white-space:nowrap"
    }, "🙌 " + esc(DROP_IN_LABEL));
  }

  // One directory-style listing card reflecting labelFor() output.
  function listingCard(camp, override, onToggle) {
    var info = labelFor(camp, override);

    var card = el("div", {
      "data-hc-camp-card": "1",
      style: "border:1.5px solid var(--line,#E6E6E6);border-radius:14px;padding:16px 18px;background:#fff;margin:0 0 14px"
    });

    var titleRow = el("div", { style: "display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:0 0 6px" });
    titleRow.appendChild(el("span", {
      style: "font-family:'Quicksand',system-ui,sans-serif;font-weight:700;font-size:16px;color:var(--purple,#603488)"
    }, esc(camp && camp.name ? camp.name : "Holiday camp")));

    // THE LABEL — present iff the camp is flagged drop-in.
    if (info.flagged) titleRow.appendChild(dropInBadge());
    card.appendChild(titleRow);

    card.appendChild(el("p", { style: "font-size:13px;color:var(--muted,#808080);margin:0 0 10px" },
      esc(info.reason)));

    // Parent guidance: when flagged, surface "you can just turn up".
    if (info.flagged) {
      card.appendChild(el("div", {
        "data-hc-dropin-note": "1",
        style: "display:flex;align-items:center;gap:8px;background:#E1F0E4;color:#2f7d4f;" +
          "font-weight:700;font-size:13px;padding:9px 13px;border-radius:12px;margin:0 0 6px"
      }, "✅ You can just turn up — booking not required."));
    }

    // Mechanism (1): the "drop-ins accepted" tick box (Happity's 'Other' tab).
    var tickRow = el("label", {
      style: "display:flex;align-items:center;gap:9px;font-size:13px;color:var(--text,#383838);margin:10px 0 0;cursor:pointer"
    });
    var tick = el("input", { type: "checkbox" });
    tick.checked = !!info.flagged;
    tick.addEventListener("change", function () {
      if (typeof onToggle === "function") onToggle(tick.checked);
    });
    tickRow.appendChild(tick);
    tickRow.appendChild(el("span", null, "Drop-ins accepted (parents can just turn up)"));
    card.appendChild(tickRow);

    return card;
  }

  function render(mountEl) {
    if (!mountEl) return;
    mountEl.innerHTML = "";

    var seeds = seedCamps();

    var wrap = el("div", { style: "font-family:'Nunito Sans',system-ui,sans-serif;color:var(--text,#383838)" });
    wrap.appendChild(el("p", { style: "font-size:14px;margin:0 0 14px" },
      "Some holiday camps accept <strong>drop-ins</strong> — you can just turn up, no advance booking. " +
      "Camps flagged drop-in show a <strong>“" + esc(DROP_IN_LABEL) + "”</strong> label, exactly like Happity's " +
      "‘drop-ins accepted’ tag. Tick the box on a card to flag it, or use the filter to show drop-in camps only."));

    // ---- parent-side "Only drop-in camps" filter, over LIVE directory ----
    var providers = [];
    try { providers = HC.data.providers || []; } catch (e) { providers = []; }

    var filterRow = el("div", {
      style: "display:flex;align-items:center;gap:10px;flex-wrap:wrap;background:var(--purple-tint,#F0E8F4);" +
        "padding:11px 14px;border-radius:12px;margin:0 0 16px"
    });
    var filterLabel = el("label", { style: "display:flex;align-items:center;gap:8px;cursor:pointer;font-size:13.5px;font-weight:700;color:var(--purple,#603488)" });
    var filterTick = el("input", { type: "checkbox", "data-hc-dropin-filter": "1" });
    filterLabel.appendChild(filterTick);
    filterLabel.appendChild(el("span", null, "Only show camps that accept drop-ins"));
    filterRow.appendChild(filterLabel);
    var countEl = el("span", { style: "font-size:12.5px;color:var(--muted,#808080)" }, "");
    filterRow.appendChild(countEl);
    wrap.appendChild(filterRow);

    var demoHead = el("div", { class: "hc-sidehead", style: "margin:4px 0 8px" }, "Try the label");
    wrap.appendChild(demoHead);

    var list = el("div", null);
    wrap.appendChild(list);

    function rebuild() {
      list.innerHTML = "";
      var showOnlyDropIn = !!filterTick.checked;

      var cards = [
        { camp: seeds.dropCamp },
        { camp: seeds.bookCamp }
      ];
      var shown = 0;
      cards.forEach(function (entry) {
        var camp = entry.camp;
        if (showOnlyDropIn && !acceptsDropIns(camp, ovr(camp))) return;
        shown += 1;
        list.appendChild(listingCard(camp, ovr(camp), function (on) {
          setOvr(camp, on); rebuild();
        }));
      });
      if (shown === 0) {
        list.appendChild(el("p", { style: "color:var(--muted,#808080);font-size:13px" },
          "No drop-in camps in this demo set. Untick the filter or flag a camp above."));
      }

      // Live-directory count for the filter (how many real E17 camps qualify).
      var liveDrop = filterDropInOnly(providers).length;
      countEl.innerHTML = esc(liveDrop + " of " + providers.length + " live E17 camps currently flagged drop-in");
    }

    function ovr(camp) {
      return overrideFor(camp && camp.id);
    }
    function setOvr(camp, on) {
      if (camp && camp.id) setOverride(camp.id, on);
    }

    filterTick.addEventListener("change", rebuild);

    mountEl.appendChild(wrap);
    rebuild();
  }

  /* ---------------- enhance (optional: live directory cards) ---------------- */
  // Defensive hook: if app.js has rendered directory cards, stamp the label on
  // any card whose camp reads as drop-in. Never throws; a failure is silent.
  function enhance() {
    try {
      var providers = HC.data.providers || [];
      var byId = {};
      for (var i = 0; i < providers.length; i++) {
        if (providers[i] && providers[i].id) byId[providers[i].id] = providers[i];
      }
      var cards = document.querySelectorAll("#grid .card[data-open]");
      for (var j = 0; j < cards.length; j++) {
        var cardEl = cards[j];
        if (cardEl.querySelector("[data-hc-dropin-label]")) continue; // already stamped
        var id = cardEl.getAttribute("data-open");
        var camp = byId[id];
        if (!camp) continue;
        if (!acceptsDropIns(camp)) continue;
        var badges = cardEl.querySelector(".badges") || cardEl.querySelector(".card-body") || cardEl;
        if (badges) badges.appendChild(dropInBadge());
      }
    } catch (e) { /* defensive: enhancement must never throw */ }
  }

  /* ---------------- selfTest ---------------- */

  function selfTest() {
    var pass = 0, fail = 0, log = [];
    function check(label, fn) {
      try { fn(); pass += 1; log.push("✓ " + label); }
      catch (e) { fail += 1; log.push("✗ " + label + " — " + (e && e.message ? e.message : String(e))); }
    }

    // ===== ACCEPTANCE CRITERION =====
    // Camps flagged drop-in show a 'drop-ins welcome' label.
    check("ACCEPTANCE: a camp flagged drop-in shows the 'Drop-ins welcome' label", function () {
      // Flagged via the explicit tick box (Happity's 'Other' tab).
      var byTick = labelFor({ id: "c1", name: "Open Sessions" }, true);
      HC.assert(byTick.flagged === true, "tick-box camp should be flagged drop-in");
      HC.assert(byTick.label === DROP_IN_LABEL, "label must read 'Drop-ins welcome', got " + byTick.label);
      HC.assert(/drop-?ins?\s+welcome/i.test(byTick.label || ""), "label text must say drop-ins welcome");

      // Flagged via the camp's own free text ("just turn up").
      var byText = labelFor({ name: "Pay & Play", booking: "Just turn up — no need to book." });
      HC.assert(byText.flagged === true, "free-text drop-in camp should be flagged");
      HC.assert(byText.label === DROP_IN_LABEL, "free-text flagged camp must show the label");
    });

    // Mirror image: a non-drop-in camp shows NO label.
    check("A non-drop-in camp shows NO 'Drop-ins welcome' label", function () {
      var info = labelFor({ name: "Multi-Sports Week", booking: "Book your full week through the online camp page.", price: "GBP 140 full week" });
      HC.assert(info.flagged === false, "ordinary booking camp should not be flagged");
      HC.assert(info.label === null, "no drop-in label expected, got " + info.label);
    });

    // Mechanism (2): assorted free-text phrasings all flip the flag.
    check("Free-text drop-in phrasing flags the label", function () {
      var camps = [
        { booking: "Drop-ins accepted all summer." },
        { booking: "Drop-in sessions, just turn up." },
        { summary: "Open session — no booking needed." },
        { booking: "No advance booking — pay and play." },
        { categories: ["Drop-in", "Multi-activity"] }
      ];
      for (var i = 0; i < camps.length; i++) {
        var info = labelFor(camps[i]);
        HC.assert(info.flagged === true, "should detect drop-in in case " + i);
        HC.assert(info.label === DROP_IN_LABEL, "label expected for case " + i);
        HC.assert(info.source === "text", "case " + i + " should be flagged by text, got " + info.source);
      }
    });

    // Mechanism (1): explicit tick box overrides ambiguous / contrary text.
    check("Tick box = true flags drop-in even when the text says 'book ahead'", function () {
      var camp = { id: "c2", booking: "Please book your place online in advance." };
      var info = labelFor(camp, true);
      HC.assert(info.flagged === true, "tick true => flagged");
      HC.assert(info.label === DROP_IN_LABEL, "tick true => label shown");
      HC.assert(info.source === "tick", "tick true => source 'tick'");
    });

    check("Tick box = false suppresses the label even when the text says 'drop-in'", function () {
      var camp = { id: "c3", booking: "Drop-in sessions, just turn up." };
      var info = labelFor(camp, false);
      HC.assert(info.flagged === false, "explicit false should override the text");
      HC.assert(info.label === null, "tick false => no label");
      HC.assert(info.source === "tick", "tick false => source 'tick'");
    });

    // Record-level flag (acceptsDropIns boolean carried on the camp) is honoured.
    check("A camp record carrying acceptsDropIns:true shows the label", function () {
      var info = labelFor({ name: "Council Open Play", acceptsDropIns: true, booking: "Book ahead online." });
      HC.assert(info.flagged === true, "record flag true => flagged");
      HC.assert(info.label === DROP_IN_LABEL, "record flag true => label shown");
    });

    // Invariant: label presence and the flag always agree.
    check("Label presence tracks the drop-in flag exactly (invariant)", function () {
      var cases = [
        { booking: "drop-in welcome" },
        { booking: "online booking only" },
        { summary: "just turn up" },
        { price: "Free for eligible places" },
        {}
      ];
      for (var i = 0; i < cases.length; i++) {
        var info = labelFor(cases[i]);
        var hasLabel = info.label !== null;
        HC.assert(hasLabel === info.flagged,
          "label presence must equal flagged for case " + i +
          " (label=" + hasLabel + ", flagged=" + info.flagged + ")");
        if (hasLabel) HC.assert(info.label === DROP_IN_LABEL, "label text must be canonical for case " + i);
      }
    });

    // The parent-side "Only drop-in camps" filter keeps flagged, drops the rest.
    check("Directory filter keeps only camps that show the drop-in label", function () {
      var list = [
        { id: "a", booking: "Drop-ins accepted." },                 // flagged (text)
        { id: "b", booking: "Book online in advance." },            // not flagged
        { id: "c", acceptsDropIns: true, booking: "Book ahead." },  // flagged (record)
        { id: "d", summary: "Structured five-day week." }           // not flagged
      ];
      var out = filterDropInOnly(list);
      HC.assert(out.length === 2, "exactly two camps should pass the drop-in filter, got " + out.length);
      var ids = out.map(function (x) { return x.id; }).sort().join(",");
      HC.assert(ids === "a,c", "filter should keep a and c, got " + ids);
      // every survivor genuinely shows the label
      for (var i = 0; i < out.length; i++) {
        HC.assert(labelFor(out[i]).label === DROP_IN_LABEL, "filtered camp must show the label: " + out[i].id);
      }
    });

    // Defensive: rubbish / missing input must not throw and defaults to no-label.
    check("Defensive: bad/empty input defaults to no drop-in label", function () {
      var inputs = [null, undefined, {}, { booking: null }, { booking: 12345 }, { summary: {} }, { categories: "nope" }];
      for (var i = 0; i < inputs.length; i++) {
        var info = labelFor(inputs[i]);
        HC.assert(info.flagged === false, "bad input #" + i + " should not be flagged");
        HC.assert(info.label === null, "bad input #" + i + " has no label");
      }
      HC.assert(textSaysDropIn(null) === false, "null camp => not drop-in");
      HC.assert(textSaysDropIn({ booking: 42 }) === false, "non-string text => not drop-in");
      HC.assert(filterDropInOnly(null).length === 0, "filtering null list => empty");
      HC.assert(filterDropInOnly("nope").length === 0, "filtering non-array => empty");
    });

    // Live data: seeds drawn from real providers; both states reachable.
    check("Seed camps drawn from live providers, both states reachable", function () {
      var seeds = seedCamps();
      HC.assert(seeds.dropCamp && seeds.bookCamp, "should seed a drop-in camp and a booking camp");
      // bookCamp must be a non-drop-in by its own text/record (no override applied).
      HC.assert(labelFor(seeds.bookCamp, overrideFor(seeds.bookCamp)).flagged === false ||
                typeof overrideFor(seeds.bookCamp) === "boolean",
        "booking seed should not be drop-in unless explicitly overridden");
      // dropCamp must be flaggable to drop-in (text or, via fallback, tick).
      var dropInfo = labelFor(seeds.dropCamp, true);
      HC.assert(dropInfo.flagged === true && dropInfo.label === DROP_IN_LABEL,
        "drop-in seed must be able to show the label");
    });

    // Persistence: the per-camp tick-box override round-trips through HC.store.
    check("Tick-box override persists via HC.store and drives the label", function () {
      var probe = "__dropin_test__";
      var before = readOverrides();
      var snapshot = JSON.parse(JSON.stringify(before || {}));
      // Set the probe camp's drop-in tick to true and confirm it drives label.
      setOverride(probe, true);
      var got = overrideFor(probe);
      HC.assert(got === true, "override should round-trip as true");
      var info = labelFor({ id: probe, booking: "Book online in advance." });
      HC.assert(info.flagged === true && info.label === DROP_IN_LABEL,
        "persisted true override should show the drop-in label");
      // Now set it to false and confirm the label disappears.
      setOverride(probe, false);
      var info2 = labelFor({ id: probe, booking: "Drop-in, just turn up." });
      HC.assert(info2.flagged === false && info2.label === null,
        "persisted false override should suppress the label");
      // Clean up our probe so we don't pollute saved state.
      clearOverride(probe);
      HC.assert(overrideFor(probe) === undefined, "probe override should be cleared");
      // Restore exactly what was there before.
      writeOverrides(snapshot);
    });

    return { pass: pass, fail: fail, log: log };
  }

  /* ---------------- register ---------------- */

  HC.registerFeature({
    id: "parent-drop-in-label",
    title: "Drop-ins welcome label",
    side: "parent",
    icon: "🙌",
    summary: "Spot camps you can just turn up to. Camps flagged 'drop-ins accepted' show a 'Drop-ins welcome' label, and you can filter the directory to drop-in camps only — exactly like Happity's drop-in tag.",
    render: render,
    enhance: enhance,
    selfTest: selfTest
  });
})();
