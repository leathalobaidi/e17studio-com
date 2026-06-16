/* HolidayCamp feature — provider-filters-labels
 * ------------------------------------------------------------------
 * PROVIDER side. Replicates Happity's "How to add the different filters
 * and labels" — the provider-side control panel where a provider marks a
 * listing as drop-in / trial / bring-your-baby / suitable-for-young, and
 * those marks surface to parents as labels/filters in search results.
 *
 * Evidence (support corpus): article 4147863
 *   "How to add the different filters and labels — Mark your class as a
 *    drop-in, bring your baby event or suitable for young babies."
 *     - Drop-in:        click 'drop-ins accepted' when creating a class
 *                       (found on the 'Other' tab) -> a manual TICK.
 *     - Trial:          add a trial offer onto the class to get this label
 *                       ('Is this a trial offer?' when adding a price) -> a
 *                       manual flag on a price/offer.
 *     - Bring Your Baby: a CATEGORY that can be added when creating/editing
 *                       an activity -> driven by a category tag.
 *     - Young (Young Babies): applied AUTOMATICALLY when the maximum age is
 *                       below a threshold -> derived from the listing's ages.
 *   (Article also documents "Under £2" — auto from price — which the
 *   parent-side price work owns; this provider panel covers the four labels
 *   the provider sets/controls.)
 *
 * Reframed for SCHOOL-AGE HOLIDAY CAMPS (not baby classes):
 *   - drop-in          -> "Drop-ins welcome"  (just turn up, no booking)
 *   - trial            -> "Try-out session"   (a one-off taster day/place)
 *   - bring-your-baby  -> "Bring younger sibling" (a parent can bring a
 *                          younger child along — the holiday-camp analogue
 *                          of Happity's 'bring your baby')
 *   - young            -> "Little ones"        (auto: caters for the
 *                          youngest end — max age at/under the young cap)
 *
 * ACCEPTANCE CRITERION (asserted in selfTest, multiple cases):
 *   Toggling 'drop-ins accepted' makes the camp show the drop-in label to
 *   parents.  (i.e. provider sets the tick -> parentLabels() includes the
 *   "Drop-ins welcome" label.)
 *
 * Self-contained, defensive (never throws at registration), no imports.
 * Persistence is via HC.store ONLY (one namespaced key); the verified
 * camps.js data is never mutated.
 * ------------------------------------------------------------------ */
(function () {
  "use strict";

  if (typeof window === "undefined" || !window.HC || typeof window.HC.registerFeature !== "function") {
    if (typeof console !== "undefined" && console.warn) {
      console.warn("[HC] provider-filters-labels: HC core not found; skipping registration.");
    }
    return;
  }

  var HC = window.HC;

  var STORE_KEY = "provider_filters_labels"; // { [campId]: { dropIn, trial, bringYoungerSibling } }

  // Happity: "Young Babies — applied automatically when the maximum age is
  // below 13 months." Holiday-camp analogue: a camp counts as catering for
  // the youngest end when its MAX age is at/under this cap (pre-/early-school).
  var YOUNG_MAX_AGE = 5;

  /* ============================================================
   * 1. The four labels this provider panel controls.
   *    Each has: a stable key, the parent-facing label text, an
   *    icon, and how it is decided ('tick' = manual, 'auto' = age).
   * ============================================================ */

  var LABELS = {
    dropIn:               { key: "dropIn",               label: "Drop-ins welcome",      icon: "🙌", mode: "tick", filter: "Only drop-in camps" },
    trial:                { key: "trial",                label: "Try-out session",       icon: "🎟️", mode: "tick", filter: "Only camps with a try-out" },
    bringYoungerSibling:  { key: "bringYoungerSibling",  label: "Bring younger sibling", icon: "👶", mode: "tick", filter: "Bring-younger-sibling camps" },
    young:                { key: "young",                label: "Little ones welcome",   icon: "🧸", mode: "auto", filter: "Suitable for little ones" }
  };

  // Ordered list for stable rendering / iteration.
  var LABEL_ORDER = ["dropIn", "trial", "bringYoungerSibling", "young"];

  /* ============================================================
   * 2. Persistence — per-camp tick overrides via HC.store.
   *    Shape: { campId: { dropIn:bool, trial:bool, bringYoungerSibling:bool } }
   *    NB: 'young' is never stored — it is always derived from ages.
   * ============================================================ */

  function readAll() {
    try {
      var o = HC.store.get(STORE_KEY, {});
      return (o && typeof o === "object") ? o : {};
    } catch (e) {
      return {};
    }
  }

  function writeAll(obj) {
    try { return HC.store.set(STORE_KEY, obj || {}); } catch (e) { return false; }
  }

  // The saved tick-state for one camp (manual labels only), defaulted false.
  function savedTicks(campId) {
    var base = { dropIn: false, trial: false, bringYoungerSibling: false };
    if (!campId) return base;
    var all = readAll();
    var rec = all[campId];
    if (rec && typeof rec === "object") {
      base.dropIn = rec.dropIn === true;
      base.trial = rec.trial === true;
      base.bringYoungerSibling = rec.bringYoungerSibling === true;
    }
    return base;
  }

  // Toggle / set one manual label for a camp. Returns the new boolean value.
  function setTick(campId, key, on) {
    if (!campId) return false;
    if (key !== "dropIn" && key !== "trial" && key !== "bringYoungerSibling") return false;
    var all = readAll();
    var rec = (all[campId] && typeof all[campId] === "object") ? all[campId] : {};
    rec[key] = !!on;
    all[campId] = rec;
    writeAll(all);
    return !!on;
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
   * 3. Pure decision logic.
   *    flagsFor(camp, overrides) -> the canonical flag-set for a camp:
   *      { dropIn, trial, bringYoungerSibling, young }  (all booleans)
   *    parentLabels(...) -> the array of label strings parents see.
   *
   *    'overrides' lets callers (tests/UI) pass explicit tick values
   *    without touching the store; falls back to record fields, then
   *    saved store state.
   * ============================================================ */

  function asNum(v) {
    // Treat null/undefined/empty as "unknown" — NOT as 0. (Number(null) === 0,
    // which would wrongly flag an ageless camp as catering for little ones.)
    if (v === null || v === undefined || v === "") return null;
    if (typeof v === "boolean") return null;
    var n = Number(v);
    return isFinite(n) ? n : null;
  }

  // Resolve a single manual tick: explicit override wins, then a boolean
  // carried on the camp record, then the saved store value.
  function resolveTick(camp, overrides, key, recordField) {
    if (overrides && (overrides[key] === true || overrides[key] === false)) {
      return overrides[key];
    }
    if (camp && typeof camp[recordField] === "boolean") {
      return camp[recordField];
    }
    var ticks = savedTicks(camp && camp.id);
    return ticks[key] === true;
  }

  // 'young' is automatic from the listing's max age (Happity: auto when max
  // age below the young threshold). A camp with an unknown max age is NOT
  // auto-flagged young (we only claim it when the data supports it).
  function isYoung(camp) {
    var c = camp || {};
    var max = asNum(c.ageMax);
    if (max === null) return false;
    return max <= YOUNG_MAX_AGE;
  }

  // THE CORE: the canonical flag-set for a camp.
  function flagsFor(camp, overrides) {
    var c = camp || {};
    return {
      dropIn:              resolveTick(c, overrides, "dropIn", "acceptsDropIns") === true,
      trial:               resolveTick(c, overrides, "trial", "hasTrial") === true,
      bringYoungerSibling: resolveTick(c, overrides, "bringYoungerSibling", "bringYoungerSibling") === true,
      young:               isYoung(c) === true
    };
  }

  // THE PARENT-FACING OUTPUT: the labels a parent sees on this listing,
  // in stable order. This is what the acceptance criterion checks.
  function parentLabels(camp, overrides) {
    var flags = flagsFor(camp, overrides);
    var out = [];
    for (var i = 0; i < LABEL_ORDER.length; i++) {
      var key = LABEL_ORDER[i];
      if (flags[key]) out.push(LABELS[key].label);
    }
    return out;
  }

  // Convenience: does a parent see a specific label on this camp?
  function showsLabel(camp, key, overrides) {
    var flags = flagsFor(camp, overrides);
    return flags[key] === true;
  }

  // The parent-side directory filter for a label: keep only camps showing it.
  function filterByLabel(list, key) {
    var arr = [];
    try { arr = Array.isArray(list) ? list : []; } catch (e) { arr = []; }
    if (!LABELS[key]) return [];
    var out = [];
    for (var i = 0; i < arr.length; i++) {
      if (showsLabel(arr[i], key)) out.push(arr[i]);
    }
    return out;
  }

  /* ============================================================
   * 4. Seed a representative live camp for the demo / tests.
   * ============================================================ */

  function seedCamp() {
    var providers = [];
    try { providers = HC.data.providers || []; } catch (e) { providers = []; }
    // Prefer a real school-age camp (max age above the young cap) so the
    // manual ticks are the interesting part of the demo.
    for (var i = 0; i < providers.length; i++) {
      var p = providers[i];
      if (p && p.id && asNum(p.ageMax) !== null && asNum(p.ageMax) > YOUNG_MAX_AGE) return p;
    }
    if (providers[0] && providers[0].id) return providers[0];
    return { id: "demo-camp", name: "Walthamstow Multi-Sports Week", ageMin: 5, ageMax: 12 };
  }

  /* ============================================================
   * 5. UI
   * ============================================================ */

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

  // A parent-facing label chip (this is what the criterion is about).
  function labelChip(key) {
    var def = LABELS[key] || { label: key, icon: "🏷️" };
    return el("span", {
      "data-hc-label": key,
      style: "font-family:'Quicksand',system-ui,sans-serif;font-weight:700;font-size:11px;text-transform:uppercase;" +
        "letter-spacing:.4px;background:#E1F0E4;color:#2f7d4f;padding:4px 10px;border-radius:999px;white-space:nowrap"
    }, esc(def.icon + " " + def.label));
  }

  // The provider-side parent preview: render every label this camp shows.
  function parentPreview(camp, overrides) {
    var labels = parentLabels(camp, overrides);
    var box = el("div", {
      "data-hc-parent-preview": "1",
      style: "border:1.5px solid var(--line,#E6E6E6);border-radius:14px;padding:14px 16px;background:#fff;margin:0 0 14px"
    });
    box.appendChild(el("div", {
      style: "font-family:'Quicksand',system-ui,sans-serif;font-weight:700;font-size:15px;color:var(--purple,#603488);margin:0 0 8px"
    }, esc(camp && camp.name ? camp.name : "Holiday camp")));
    box.appendChild(el("div", {
      style: "font-size:12px;color:var(--muted,#808080);margin:0 0 10px"
    }, "What parents see on this listing:"));

    var row = el("div", { style: "display:flex;gap:7px;flex-wrap:wrap" });
    if (!labels.length) {
      row.appendChild(el("span", { style: "font-size:12.5px;color:var(--muted,#808080)" },
        "No special labels yet — tick one below to add one."));
    } else {
      for (var i = 0; i < LABEL_ORDER.length; i++) {
        var key = LABEL_ORDER[i];
        if (parentLabels(camp, overrides).indexOf(LABELS[key].label) !== -1) {
          row.appendChild(labelChip(key));
        }
      }
    }
    box.appendChild(row);
    return box;
  }

  function render(mountEl) {
    if (!mountEl) return;
    mountEl.innerHTML = "";

    var camp = seedCamp();
    var campId = camp && camp.id;

    var wrap = el("div", { style: "font-family:'Nunito Sans',system-ui,sans-serif;color:var(--text,#383838)" });
    wrap.appendChild(el("p", { style: "font-size:14px;margin:0 0 14px" },
      "Set the <strong>filters &amp; labels</strong> on your camp — exactly like Happity's " +
      "‘drop-ins accepted’, trial, bring-your-baby and young tags. Manual labels are ticks you control; " +
      "the <strong>“" + esc(LABELS.young.label) + "”</strong> label is applied automatically from your camp's " +
      "age range (max age " + YOUNG_MAX_AGE + " or under). Whatever you tick here appears as a label to parents."));

    // Live preview of the parent-facing labels.
    var previewHost = el("div", null);
    wrap.appendChild(previewHost);

    // The provider tick controls (manual labels).
    var ctrlHead = el("div", { class: "hc-sidehead", style: "margin:4px 0 8px" }, "Your labels");
    wrap.appendChild(ctrlHead);

    var controls = el("div", { style: "display:flex;flex-direction:column;gap:8px;margin:0 0 14px" });
    wrap.appendChild(controls);

    function currentOverrides() {
      var t = savedTicks(campId);
      return { dropIn: t.dropIn, trial: t.trial, bringYoungerSibling: t.bringYoungerSibling };
    }

    function rebuild() {
      var ovr = currentOverrides();

      // Preview.
      previewHost.innerHTML = "";
      previewHost.appendChild(parentPreview(camp, ovr));

      // Controls — one row per manual label, plus an auto (read-only) note.
      controls.innerHTML = "";
      ["dropIn", "trial", "bringYoungerSibling"].forEach(function (key) {
        var def = LABELS[key];
        var rowLbl = el("label", {
          style: "display:flex;align-items:center;gap:10px;font-size:13.5px;color:var(--text,#383838);cursor:pointer;" +
            "border:1.5px solid var(--line,#E6E6E6);border-radius:12px;padding:10px 13px;background:#fff"
        });
        var box = el("input", { type: "checkbox", "data-hc-tick": key });
        box.checked = !!ovr[key];
        box.addEventListener("change", function () {
          setTick(campId, key, box.checked);
          try {
            HC.util.toast((box.checked ? "Added" : "Removed") + " “" + def.label + "” label");
          } catch (e) {}
          rebuild();
        });
        rowLbl.appendChild(box);
        rowLbl.appendChild(el("span", { style: "font-size:18px" }, def.icon));
        rowLbl.appendChild(el("span", null,
          "<strong>" + esc(def.label) + "</strong> — tick to show this label to parents"));
        controls.appendChild(rowLbl);
      });

      // The automatic 'young' label, shown read-only so the provider sees why.
      var youngOn = isYoung(camp);
      var autoRow = el("div", {
        style: "display:flex;align-items:center;gap:10px;font-size:13px;border:1.5px dashed var(--line,#E6E6E6);" +
          "border-radius:12px;padding:10px 13px;background:var(--purple-tint,#F0E8F4);color:var(--purple,#603488)"
      });
      autoRow.appendChild(el("span", { style: "font-size:18px" }, LABELS.young.icon));
      autoRow.appendChild(el("span", null,
        "<strong>" + esc(LABELS.young.label) + "</strong> — automatic. " +
        (youngOn
          ? "On, because the max age (" + esc(camp.ageMax) + ") is " + YOUNG_MAX_AGE + " or under."
          : "Off, because the max age (" + esc(camp.ageMax == null ? "n/a" : camp.ageMax) + ") is above " + YOUNG_MAX_AGE + ".")));
      controls.appendChild(autoRow);
    }

    mountEl.appendChild(wrap);
    rebuild();

    // Live-directory tally: how many real E17 camps would carry each label.
    var providers = [];
    try { providers = HC.data.providers || []; } catch (e) { providers = []; }
    var tally = el("div", {
      style: "font-size:12.5px;color:var(--muted,#808080);margin:10px 0 0;line-height:1.7"
    });
    var lines = [];
    for (var i = 0; i < LABEL_ORDER.length; i++) {
      var k = LABEL_ORDER[i];
      lines.push(esc(LABELS[k].icon + " " + LABELS[k].label + ": " +
        filterByLabel(providers, k).length + " of " + providers.length + " live camps"));
    }
    tally.innerHTML = "Across the live E17 directory — " + lines.join(" · ");
    wrap.appendChild(tally);
  }

  /* ============================================================
   * 6. enhance — stamp auto 'young' labels onto live directory cards.
   *    Defensive: never throws. Only stamps the automatic label so we
   *    don't fabricate manual claims the provider hasn't made.
   * ============================================================ */

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
        var id = cardEl.getAttribute("data-open");
        var camp = byId[id];
        if (!camp) continue;
        var labels = parentLabels(camp);
        if (!labels.length) continue;
        var host = cardEl.querySelector(".badges") || cardEl.querySelector(".card-body") || cardEl;
        if (!host) continue;
        for (var k = 0; k < LABEL_ORDER.length; k++) {
          var key = LABEL_ORDER[k];
          if (labels.indexOf(LABELS[key].label) === -1) continue;
          if (cardEl.querySelector('[data-hc-label="' + key + '"]')) continue; // already stamped
          host.appendChild(labelChip(key));
        }
      }
    } catch (e) { /* defensive: enhancement must never throw */ }
  }

  /* ============================================================
   * 7. selfTest
   * ============================================================ */

  function selfTest() {
    var pass = 0, fail = 0, log = [];
    function check(label, fn) {
      try { fn(); pass += 1; log.push("✓ " + label); }
      catch (e) { fail += 1; log.push("✗ " + label + " — " + (e && e.message ? e.message : String(e))); }
    }

    // ===== ACCEPTANCE CRITERION =====
    // Toggling 'drop-ins accepted' makes the camp show the drop-in label to parents.
    check("ACCEPTANCE: toggling 'drop-ins accepted' shows the drop-in label to parents", function () {
      var camp = { id: "acc-camp", name: "Summer Open Sessions", ageMin: 6, ageMax: 12 };

      // Before toggling: parent sees no drop-in label.
      var before = parentLabels(camp, { dropIn: false });
      HC.assert(before.indexOf(LABELS.dropIn.label) === -1,
        "before toggling, parents should NOT see the drop-in label");

      // Provider toggles 'drop-ins accepted' ON.
      var after = parentLabels(camp, { dropIn: true });
      HC.assert(after.indexOf(LABELS.dropIn.label) !== -1,
        "after toggling 'drop-ins accepted', parents MUST see the '" + LABELS.dropIn.label + "' label");
      HC.assert(showsLabel(camp, "dropIn", { dropIn: true }) === true,
        "showsLabel(dropIn) must be true once toggled on");
      HC.assert(/drop-?ins?\s+welcome/i.test(after.join(" ")),
        "the drop-in label text must read as 'Drop-ins welcome'");
    });

    // Round-trip through the real store path (what the UI does on a click).
    check("ACCEPTANCE via store: setTick('dropIn', true) surfaces the label to parents", function () {
      var probe = "__pfl_dropin_probe__";
      var all = readAll();
      var snapshot = JSON.parse(JSON.stringify(all || {}));
      try {
        clearCamp(probe);
        // Off by default -> no label.
        HC.assert(parentLabels({ id: probe, ageMax: 12 }).indexOf(LABELS.dropIn.label) === -1,
          "with no tick saved, no drop-in label should show");
        // Provider ticks the box (persisted) -> label shows.
        setTick(probe, "dropIn", true);
        HC.assert(savedTicks(probe).dropIn === true, "tick should persist as true");
        HC.assert(parentLabels({ id: probe, ageMax: 12 }).indexOf(LABELS.dropIn.label) !== -1,
          "persisted drop-in tick must make the label show to parents");
        // Untick -> label disappears.
        setTick(probe, "dropIn", false);
        HC.assert(parentLabels({ id: probe, ageMax: 12 }).indexOf(LABELS.dropIn.label) === -1,
          "unticking drop-in must remove the label");
      } finally {
        // Restore the store exactly as found.
        clearCamp(probe);
        writeAll(snapshot);
      }
    });

    // Each manual label toggles independently and surfaces its own text.
    check("Each manual label (drop-in / trial / bring-younger-sibling) toggles independently", function () {
      var camp = { id: "multi", name: "Holiday Club", ageMin: 6, ageMax: 12 };
      var keys = ["dropIn", "trial", "bringYoungerSibling"];
      for (var i = 0; i < keys.length; i++) {
        var key = keys[i];
        var ovr = {}; ovr[key] = true;
        var labels = parentLabels(camp, ovr);
        HC.assert(labels.indexOf(LABELS[key].label) !== -1,
          "toggling " + key + " on should show '" + LABELS[key].label + "'");
        // The OTHER manual labels must stay off (independence).
        for (var j = 0; j < keys.length; j++) {
          if (keys[j] === key) continue;
          HC.assert(labels.indexOf(LABELS[keys[j]].label) === -1,
            "toggling " + key + " must not switch on " + keys[j]);
        }
      }
    });

    // 'young' is AUTOMATIC from the max age (Happity: auto under threshold).
    check("'Little ones welcome' is automatic from max age (<= " + YOUNG_MAX_AGE + ")", function () {
      var youngCamp = { id: "y1", name: "Tots Camp", ageMin: 3, ageMax: 5 };
      var schoolCamp = { id: "y2", name: "Big Kids Camp", ageMin: 7, ageMax: 14 };
      HC.assert(parentLabels(youngCamp).indexOf(LABELS.young.label) !== -1,
        "a camp with max age <= " + YOUNG_MAX_AGE + " should auto-show the young label");
      HC.assert(parentLabels(schoolCamp).indexOf(LABELS.young.label) === -1,
        "a camp with max age above " + YOUNG_MAX_AGE + " should NOT show the young label");
      // The young label is not driven by ticks: an explicit tick can't add it.
      HC.assert(showsLabel(schoolCamp, "young", { young: true }) === false,
        "young must be age-derived, not tickable");
      // Boundary: exactly at the cap counts as young.
      HC.assert(isYoung({ ageMax: YOUNG_MAX_AGE }) === true, "max age == cap is young");
      HC.assert(isYoung({ ageMax: YOUNG_MAX_AGE + 1 }) === false, "max age == cap+1 is not young");
    });

    // Record-level boolean fields are honoured (e.g. acceptsDropIns:true).
    check("Camp record carrying acceptsDropIns/hasTrial true shows those labels", function () {
      var camp = { id: "rec", name: "Rec Camp", ageMax: 12, acceptsDropIns: true, hasTrial: true };
      var labels = parentLabels(camp);
      HC.assert(labels.indexOf(LABELS.dropIn.label) !== -1, "acceptsDropIns:true => drop-in label");
      HC.assert(labels.indexOf(LABELS.trial.label) !== -1, "hasTrial:true => trial label");
    });

    // Explicit override beats the saved store value.
    check("Explicit override beats the saved store state", function () {
      var probe = "__pfl_override_probe__";
      var all = readAll();
      var snapshot = JSON.parse(JSON.stringify(all || {}));
      try {
        setTick(probe, "trial", true); // store says trial ON
        // Override forces it OFF for this evaluation.
        HC.assert(showsLabel({ id: probe, ageMax: 12 }, "trial", { trial: false }) === false,
          "override trial:false should win over stored true");
        // And without the override, the stored true shows through.
        HC.assert(showsLabel({ id: probe, ageMax: 12 }, "trial") === true,
          "stored trial:true should show when no override is given");
      } finally {
        clearCamp(probe);
        writeAll(snapshot);
      }
    });

    // The parent-side directory filter keeps only camps showing a label.
    check("Directory filter keeps only camps showing the chosen label", function () {
      var list = [
        { id: "a", ageMax: 12, acceptsDropIns: true },   // drop-in (record)
        { id: "b", ageMax: 12 },                          // nothing
        { id: "c", ageMax: 4 },                           // young (auto)
        { id: "d", ageMax: 12, hasTrial: true }           // trial (record)
      ];
      var drop = filterByLabel(list, "dropIn").map(function (x) { return x.id; });
      HC.assert(drop.length === 1 && drop[0] === "a", "drop-in filter should keep only 'a', got " + drop.join(","));
      var young = filterByLabel(list, "young").map(function (x) { return x.id; });
      HC.assert(young.length === 1 && young[0] === "c", "young filter should keep only 'c', got " + young.join(","));
      var trial = filterByLabel(list, "trial").map(function (x) { return x.id; });
      HC.assert(trial.length === 1 && trial[0] === "d", "trial filter should keep only 'd', got " + trial.join(","));
      // Every survivor genuinely shows the label.
      filterByLabel(list, "dropIn").forEach(function (c) {
        HC.assert(parentLabels(c).indexOf(LABELS.dropIn.label) !== -1, "filtered drop-in camp must show the label");
      });
    });

    // A camp with everything on shows all four labels in stable order.
    check("All four labels can co-exist on one camp, in stable order", function () {
      var camp = { id: "all", name: "Everything Camp", ageMin: 3, ageMax: 5 }; // young auto-on
      var labels = parentLabels(camp, { dropIn: true, trial: true, bringYoungerSibling: true });
      HC.assert(labels.length === 4, "expected 4 labels, got " + labels.length + " (" + labels.join(", ") + ")");
      var expected = [LABELS.dropIn.label, LABELS.trial.label, LABELS.bringYoungerSibling.label, LABELS.young.label];
      HC.assert(labels.join("|") === expected.join("|"),
        "labels must be in canonical order; got " + labels.join("|"));
    });

    // Defensive: rubbish / missing input must not throw and yields no labels.
    check("Defensive: bad/empty input yields no labels and never throws", function () {
      var inputs = [null, undefined, {}, { ageMax: null }, { ageMax: "abc" }, { id: 5, ageMax: {} }];
      for (var i = 0; i < inputs.length; i++) {
        var labels = parentLabels(inputs[i]);
        HC.assert(Array.isArray(labels), "parentLabels must always return an array (case " + i + ")");
        // No manual ticks + unknown/absent age => no labels at all.
        HC.assert(labels.length === 0, "bad input #" + i + " should yield no labels, got " + labels.join(","));
      }
      HC.assert(isYoung(null) === false, "isYoung(null) => false");
      HC.assert(isYoung({ ageMax: undefined }) === false, "isYoung(no max) => false");
      HC.assert(filterByLabel(null, "dropIn").length === 0, "filtering null list => empty");
      HC.assert(filterByLabel("nope", "dropIn").length === 0, "filtering non-array => empty");
      HC.assert(filterByLabel([{ id: "x", ageMax: 4 }], "bogusLabel").length === 0, "unknown label key => empty");
      HC.assert(setTick(null, "dropIn", true) === false, "setTick with no campId is a no-op");
      HC.assert(setTick("x", "nope", true) === false, "setTick with unknown key is a no-op");
    });

    // Persistence isolation: writing one camp's ticks never leaks to another.
    check("Per-camp persistence is isolated", function () {
      var a = "__pfl_iso_a__", b = "__pfl_iso_b__";
      var all = readAll();
      var snapshot = JSON.parse(JSON.stringify(all || {}));
      try {
        clearCamp(a); clearCamp(b);
        setTick(a, "dropIn", true);
        HC.assert(savedTicks(a).dropIn === true, "camp A drop-in should be on");
        HC.assert(savedTicks(b).dropIn === false, "camp B drop-in should remain off");
        HC.assert(parentLabels({ id: b, ageMax: 12 }).indexOf(LABELS.dropIn.label) === -1,
          "camp B must not inherit camp A's drop-in label");
      } finally {
        clearCamp(a); clearCamp(b);
        writeAll(snapshot);
      }
    });

    // Live data: a real provider can carry the labels end-to-end.
    check("Seed camp from live providers supports the full toggle path", function () {
      var camp = seedCamp();
      HC.assert(camp && camp.id, "should seed a camp with an id");
      // Toggling drop-in on (via override) must surface the label.
      HC.assert(parentLabels(camp, { dropIn: true }).indexOf(LABELS.dropIn.label) !== -1,
        "live seed camp should be able to show the drop-in label");
    });

    return { pass: pass, fail: fail, log: log };
  }

  /* ============================================================
   * 8. register
   * ============================================================ */

  HC.registerFeature({
    id: "provider-filters-labels",
    title: "Set camp filters & labels",
    side: "provider",
    icon: "🏷️",
    summary: "Mark a camp as drop-in, try-out, bring-younger-sibling or little-ones — Happity's filters/labels for school-age camps. Manual ticks you control plus an automatic young-age label, all surfaced to parents.",
    render: render,
    enhance: enhance,
    selfTest: selfTest
  });
})();
