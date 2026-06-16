/* HolidayCamp feature — parent-map-view
 *
 * Map view with pins (featured camps get a star pin).
 *
 * Mirrors Happity's behaviour: a Featured Listing is "highlighted on the map
 * with a star" (support article 2278351; 04-seo §1.5). Happity caps featured
 * results at 3 per search; we keep that spirit — featured camps render a yellow
 * star pin, everything else a plain dot pin.
 *
 * Framed for SCHOOL-AGE HOLIDAY CAMPS in Waltham Forest (E17). The verified
 * camp data (HC.data.providers) has no lat/lng, so we project each camp onto a
 * lightweight schematic borough map using a fixed lookup of E17 localities
 * derived from each camp's `areas` / `area` fields. Nothing is geocoded live;
 * the map is an illustrative locator, not a survey-grade map.
 *
 * Featured set: the data has no `featured` flag, so this module owns it. It is
 * seeded deterministically (so the acceptance criterion always has featured
 * pins to show) and persisted/toggleable via HC.store — like a provider buying
 * a Featured Listing. Parents can toggle "Featured only" to filter the map.
 *
 * Self-contained, defensive, no imports/exports. Persistence via HC.store only.
 */
(function () {
  "use strict";

  if (typeof window === "undefined" || !window.HC || typeof window.HC.registerFeature !== "function") {
    return; // harness not present — fail quiet, never throw at load time.
  }
  var HC = window.HC;

  var STORE_KEY = "featuredCampIds";      // persisted featured set (array of camp ids)
  var STORE_FILTER = "mapFeaturedOnly";   // persisted "featured only" toggle

  /* ---------- E17 / Waltham Forest schematic locality grid ----------
   * x,y are percentages on a 0-100 viewport. Roughly geographic: Chingford
   * north, Walthamstow centre, Leyton/Leytonstone south, Wanstead/Woodford east.
   * Used only to place pins on the illustrative map. */
  var LOCALITIES = {
    "Chingford":      { x: 40, y: 12 },
    "Highams Park":   { x: 62, y: 26 },
    "Walthamstow":    { x: 42, y: 48 },
    "Leyton":         { x: 36, y: 74 },
    "Leytonstone":    { x: 56, y: 70 },
    "Woodford":       { x: 78, y: 30 },
    "Wanstead":       { x: 80, y: 58 },
    "Loughton":       { x: 58, y: 6  },
    "London":         { x: 50, y: 88 }
  };
  var DEFAULT_POS = { x: 50, y: 50 }; // Borough-wide / unknown -> centre.

  /* ---------- helpers ---------- */

  function providers() {
    try {
      var p = HC.data && HC.data.providers;
      return Array.isArray(p) ? p : [];
    } catch (e) { return []; }
  }

  // Deterministic small hash so seeding + pin jitter are stable across reloads.
  function hashStr(s) {
    s = String(s == null ? "" : s);
    var h = 2166136261;
    for (var i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = (h * 16777619) >>> 0;
    }
    return h >>> 0;
  }

  // Pick the primary locality for a camp and return its base map position.
  function localityFor(camp) {
    if (!camp || typeof camp !== "object") return { name: "Unknown", pos: DEFAULT_POS };
    var candidates = [];
    if (Array.isArray(camp.areas)) candidates = candidates.concat(camp.areas);
    if (camp.area) candidates.push(camp.area);
    for (var i = 0; i < candidates.length; i++) {
      var raw = String(candidates[i] || "");
      // match a known locality token inside the string (handles "Lloyd Park / Higham Hill")
      for (var key in LOCALITIES) {
        if (!Object.prototype.hasOwnProperty.call(LOCALITIES, key)) continue;
        if (raw.indexOf(key) !== -1) return { name: key, pos: LOCALITIES[key] };
      }
    }
    return { name: candidates[0] || "Borough-wide", pos: DEFAULT_POS };
  }

  // Final pin coordinates: base locality + deterministic jitter so co-located
  // camps don't stack exactly. Clamped to 4..96 so pins stay on the map.
  function pinPos(camp) {
    var loc = localityFor(camp);
    var h = hashStr((camp && camp.id) || (camp && camp.name) || "x");
    var jx = ((h % 1000) / 1000 - 0.5) * 12;        // +/-6
    var jy = (((h >> 10) % 1000) / 1000 - 0.5) * 12; // +/-6
    function clamp(v) { return Math.max(4, Math.min(96, v)); }
    return { x: clamp(loc.pos.x + jx), y: clamp(loc.pos.y + jy), locality: loc.name };
  }

  // Load the persisted featured set; if absent/empty, seed deterministically so
  // the map always has star pins to demonstrate (mirrors Happity capping at 3).
  function getFeaturedIds() {
    var stored = null;
    try { stored = HC.store.get(STORE_KEY, null); } catch (e) { stored = null; }
    if (Array.isArray(stored) && stored.length) {
      // keep only ids that still exist in the live data
      var live = {};
      providers().forEach(function (p) { if (p && p.id) live[p.id] = true; });
      var kept = stored.filter(function (id) { return live[id]; });
      if (kept.length) return kept;
    }
    return seedFeatured();
  }

  // Deterministic seed: up to 3 featured camps, chosen by hash rank (stable).
  function seedFeatured() {
    var ps = providers().filter(function (p) { return p && p.id; });
    if (!ps.length) return [];
    var ranked = ps.slice().sort(function (a, b) {
      return hashStr(a.id) - hashStr(b.id);
    });
    var ids = ranked.slice(0, Math.min(3, ranked.length)).map(function (p) { return p.id; });
    try { HC.store.set(STORE_KEY, ids); } catch (e) { /* persistence is best-effort */ }
    return ids;
  }

  function isFeatured(id, featuredIds) {
    if (!id) return false;
    var set = featuredIds || getFeaturedIds();
    for (var i = 0; i < set.length; i++) if (set[i] === id) return true;
    return false;
  }

  // Toggle a camp's featured status (like a provider buying/cancelling a
  // Featured Listing). Caps the featured set at 3 to mirror Happity. Persists.
  function toggleFeatured(id) {
    if (!id) return getFeaturedIds();
    var set = getFeaturedIds().slice();
    var idx = set.indexOf(id);
    if (idx !== -1) {
      set.splice(idx, 1);
    } else {
      if (set.length >= 3) set.shift(); // drop oldest to keep <=3 featured
      set.push(id);
    }
    try { HC.store.set(STORE_KEY, set); } catch (e) { /* ignore */ }
    return set;
  }

  // Build the renderable pin list for the map.
  function buildPins(opts) {
    opts = opts || {};
    var featuredIds = getFeaturedIds();
    var featuredOnly = !!opts.featuredOnly;
    var pins = [];
    providers().forEach(function (camp) {
      if (!camp || !camp.id) return;
      var feat = isFeatured(camp.id, featuredIds);
      if (featuredOnly && !feat) return;
      var pos = pinPos(camp);
      pins.push({
        id: camp.id,
        name: camp.name || camp.id,
        locality: pos.locality,
        x: pos.x,
        y: pos.y,
        featured: feat,
        price: camp.price || "",
        ageLabel: camp.ageLabel || ""
      });
    });
    return pins;
  }

  /* ---------- DOM helpers ---------- */
  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  // Build an SVG pin: featured -> yellow star; plain -> purple teardrop dot.
  function pinSvg(featured) {
    if (featured) {
      return '<svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true">' +
        '<path d="M12 2l2.9 6.1 6.6.8-4.9 4.5 1.3 6.6L12 17.8 6.1 20.6l1.3-6.6L2.5 8.9l6.6-.8z" ' +
        'fill="#FCD400" stroke="#603488" stroke-width="1.3" stroke-linejoin="round"/></svg>';
    }
    return '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">' +
      '<circle cx="12" cy="10" r="6" fill="#603488" stroke="#fff" stroke-width="1.6"/>' +
      '<path d="M12 16 L12 22" stroke="#603488" stroke-width="2" stroke-linecap="round"/></svg>';
  }

  /* ---------- render ---------- */
  function render(mountEl) {
    try {
      if (!mountEl) return;
      var featuredOnly = false;
      try { featuredOnly = !!HC.store.get(STORE_FILTER, false); } catch (e) { featuredOnly = false; }

      mountEl.innerHTML =
        '<style>' +
        '.hcmap-wrap{font-family:Quicksand,system-ui,sans-serif}' +
        '.hcmap-bar{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin:0 0 12px}' +
        '.hcmap-legend{display:flex;gap:14px;align-items:center;font-size:13px;color:#383838}' +
        '.hcmap-legend b{font-weight:700;color:#603488}' +
        '.hcmap-toggle{margin-left:auto;display:flex;align-items:center;gap:6px;font-size:13px;font-weight:700;color:#603488;cursor:pointer;user-select:none}' +
        '.hcmap-canvas{position:relative;width:100%;padding-top:62%;border-radius:18px;overflow:hidden;' +
          'background:linear-gradient(135deg,#EAF4EC 0%,#F0E8F4 55%,#FCE8F0 100%);border:1.5px solid #E6E6E6}' +
        '.hcmap-river{position:absolute;left:0;right:0;top:46%;height:7%;background:rgba(96,52,136,.10);transform:skewY(-3deg)}' +
        '.hcmap-label{position:absolute;font-size:10px;font-weight:700;color:rgba(96,52,136,.45);letter-spacing:.3px;text-transform:uppercase;transform:translate(-50%,-50%);pointer-events:none}' +
        '.hcmap-pin{position:absolute;transform:translate(-50%,-100%);cursor:pointer;line-height:0;filter:drop-shadow(0 2px 3px rgba(0,0,0,.18))}' +
        '.hcmap-pin.feat{z-index:5}' +
        '.hcmap-pin:hover{transform:translate(-50%,-100%) scale(1.18)}' +
        '.hcmap-tip{position:absolute;left:50%;bottom:100%;transform:translateX(-50%);margin-bottom:4px;white-space:nowrap;' +
          'background:#1A1A1A;color:#fff;font-size:11px;font-weight:600;padding:4px 8px;border-radius:8px;opacity:0;pointer-events:none;transition:opacity .15s;max-width:200px;overflow:hidden;text-overflow:ellipsis}' +
        '.hcmap-pin:hover .hcmap-tip{opacity:1}' +
        '.hcmap-tip .feat-tag{color:#FCD400;font-weight:800}' +
        '.hcmap-empty{position:absolute;inset:0;display:grid;place-items:center;color:#808080;font-size:14px;font-weight:700}' +
        '.hcmap-count{font-size:12px;color:#808080;margin-top:8px}' +
        '</style>' +
        '<div class="hcmap-wrap">' +
          '<div class="hcmap-bar">' +
            '<div class="hcmap-legend">' +
              '<span><b>' + pinSvg(true) + '</b> Featured camp (star pin)</span>' +
              '<span>' + pinSvg(false) + ' Camp</span>' +
            '</div>' +
            '<label class="hcmap-toggle"><input type="checkbox" id="hcmapFeatOnly"' +
              (featuredOnly ? ' checked' : '') + '> Featured only</label>' +
          '</div>' +
          '<div class="hcmap-canvas" id="hcmapCanvas" role="img" aria-label="Map of Waltham Forest holiday camps"></div>' +
          '<div class="hcmap-count" id="hcmapCount"></div>' +
        '</div>';

      var canvas = mountEl.querySelector("#hcmapCanvas");
      var countEl = mountEl.querySelector("#hcmapCount");
      var toggle = mountEl.querySelector("#hcmapFeatOnly");

      function paint() {
        var only = !!(toggle && toggle.checked);
        var pins = buildPins({ featuredOnly: only });
        var totalFeat = getFeaturedIds().length;

        // locality watermark labels
        var labels = "";
        var seen = {};
        Object.keys(LOCALITIES).forEach(function (k) {
          if (k === "London") return;
          seen[k] = true;
          var p = LOCALITIES[k];
          labels += '<div class="hcmap-label" style="left:' + p.x + '%;top:' + (p.y - 9) + '%">' + esc(k) + '</div>';
        });

        var html = '<div class="hcmap-river"></div>' + labels;
        if (!pins.length) {
          html += '<div class="hcmap-empty">No featured camps to show yet</div>';
        } else {
          pins.forEach(function (pin) {
            var tip = esc(pin.name) +
              (pin.featured ? ' <span class="feat-tag">★ Featured</span>' : '') +
              (pin.ageLabel ? ' · ' + esc(pin.ageLabel) : '');
            html += '<div class="hcmap-pin' + (pin.featured ? ' feat' : '') + '" ' +
              'data-camp-id="' + esc(pin.id) + '" ' +
              'data-featured="' + (pin.featured ? '1' : '0') + '" ' +
              'style="left:' + pin.x + '%;top:' + pin.y + '%" ' +
              'title="' + esc(pin.name) + '">' +
              '<div class="hcmap-tip">' + tip + '</div>' +
              pinSvg(pin.featured) +
            '</div>';
          });
        }
        canvas.innerHTML = html;

        var shownFeat = pins.filter(function (p) { return p.featured; }).length;
        if (countEl) {
          countEl.textContent = only
            ? (pins.length + " featured camp" + (pins.length === 1 ? "" : "s") + " shown")
            : (pins.length + " camps on the map · " + totalFeat + " featured (★) · " + shownFeat + " star pin" + (shownFeat === 1 ? "" : "s") + " visible");
        }
      }

      // Click a pin -> toggle its featured status (provider buys/cancels a
      // Featured Listing), persist, repaint. Demonstrates the live logic.
      canvas.addEventListener("click", function (e) {
        var pinEl = e.target.closest ? e.target.closest(".hcmap-pin") : null;
        if (!pinEl) return;
        var id = pinEl.getAttribute("data-camp-id");
        if (!id) return;
        var nowFeatured = !isFeatured(id);
        toggleFeatured(id);
        try {
          HC.util.toast(nowFeatured ? "★ Featured on map" : "Featured removed");
        } catch (e2) { /* toast is best-effort */ }
        paint();
      });

      if (toggle) {
        toggle.addEventListener("change", function () {
          try { HC.store.set(STORE_FILTER, !!toggle.checked); } catch (e3) { /* ignore */ }
          paint();
        });
      }

      paint();
    } catch (e) {
      try {
        mountEl.innerHTML = '<p style="color:#9a1f5e">Map failed to render: ' + esc(e && e.message ? e.message : String(e)) + '</p>';
      } catch (e4) { /* give up quietly */ }
    }
  }

  /* ---------- selfTest ---------- */
  // Exercises the feature LOGIC and asserts the acceptance criterion:
  // a map tab renders a pin per camp; featured camps show a star pin.
  function selfTest() {
    var pass = 0, fail = 0, log = [];
    function check(label, fn) {
      try { fn(); pass++; log.push("✓ " + label); }
      catch (e) { fail++; log.push("✗ " + label + " — " + (e && e.message ? e.message : String(e))); }
    }

    var ps = providers();

    // 1. One pin per camp (no featured filter).
    check("Map renders one pin per camp", function () {
      var pins = buildPins({ featuredOnly: false });
      HC.assert(pins.length === ps.length,
        "expected " + ps.length + " pins, got " + pins.length);
    });

    // 2. At least one featured camp exists (seeded if needed).
    check("Featured set is non-empty (seeded if absent)", function () {
      var feat = getFeaturedIds();
      HC.assert(feat.length >= 1, "expected >=1 featured camp, got " + feat.length);
      HC.assert(feat.length <= 3, "featured set should cap at 3 (Happity), got " + feat.length);
    });

    // 3. ACCEPTANCE: every featured camp produces a star pin.
    check("Each featured camp renders a star (featured) pin", function () {
      var feat = getFeaturedIds();
      var pins = buildPins({ featuredOnly: false });
      var byId = {};
      pins.forEach(function (p) { byId[p.id] = p; });
      HC.assert(feat.length > 0, "no featured camps to verify");
      feat.forEach(function (id) {
        HC.assert(byId[id], "featured camp " + id + " missing from pins");
        HC.assert(byId[id].featured === true,
          "featured camp " + id + " should have a star pin (featured=true)");
      });
      // and the star SVG differs from the plain dot SVG
      var starSvg = pinSvg(true), dotSvg = pinSvg(false);
      HC.assert(starSvg.indexOf("FCD400") !== -1, "star pin must use the yellow star fill");
      HC.assert(starSvg !== dotSvg, "featured pin SVG must differ from plain pin SVG");
    });

    // 4. Non-featured camps render plain (non-star) pins.
    check("Non-featured camps render plain pins", function () {
      var feat = getFeaturedIds();
      var featMap = {};
      feat.forEach(function (id) { featMap[id] = true; });
      var pins = buildPins({ featuredOnly: false });
      var plain = pins.filter(function (p) { return !featMap[p.id]; });
      HC.assert(plain.length === ps.length - feat.length,
        "plain pin count mismatch: " + plain.length);
      plain.forEach(function (p) {
        HC.assert(p.featured === false, "camp " + p.id + " should not be featured");
      });
    });

    // 5. "Featured only" filter shows exactly the star pins.
    check("Featured-only filter shows only star pins", function () {
      var feat = getFeaturedIds();
      var pins = buildPins({ featuredOnly: true });
      HC.assert(pins.length === feat.length,
        "featured-only should show " + feat.length + " pins, got " + pins.length);
      pins.forEach(function (p) {
        HC.assert(p.featured === true, "filtered pin " + p.id + " must be featured");
      });
    });

    // 6. Toggling featured status flips the star and persists, capped at 3.
    check("Toggling featured status flips the pin and caps at 3", function () {
      if (!ps.length) { HC.assert(true); return; }
      // find a camp not currently featured
      var feat0 = getFeaturedIds();
      var featSet = {}; feat0.forEach(function (id) { featSet[id] = true; });
      var target = null;
      for (var i = 0; i < ps.length; i++) {
        if (ps[i] && ps[i].id && !featSet[ps[i].id]) { target = ps[i].id; break; }
      }
      if (!target) { HC.assert(feat0.length >= 1, "all camps featured edge-case"); return; }

      var before = isFeatured(target);
      HC.assert(before === false, "target should start non-featured");
      toggleFeatured(target);
      HC.assert(isFeatured(target) === true, "target should be featured after toggle on");
      HC.assert(getFeaturedIds().length <= 3, "cap of 3 must hold after toggle on");
      // its pin is now a star
      var pinsAfter = buildPins({ featuredOnly: false });
      var match = pinsAfter.filter(function (p) { return p.id === target; })[0];
      HC.assert(match && match.featured === true, "toggled camp must now have a star pin");
      // toggle back off to leave state clean
      toggleFeatured(target);
      HC.assert(isFeatured(target) === false, "target should be non-featured after toggle off");
    });

    // 7. Every camp gets a valid on-canvas position (deterministic, clamped).
    check("Every pin has a valid clamped position", function () {
      var pins = buildPins({ featuredOnly: false });
      pins.forEach(function (p) {
        HC.assert(typeof p.x === "number" && p.x >= 4 && p.x <= 96, "x out of range for " + p.id);
        HC.assert(typeof p.y === "number" && p.y >= 4 && p.y <= 96, "y out of range for " + p.id);
        HC.assert(typeof p.locality === "string" && p.locality.length > 0, "locality missing for " + p.id);
      });
      // positions are deterministic across calls
      if (pins.length) {
        var again = buildPins({ featuredOnly: false })[0];
        HC.assert(again.x === pins[0].x && again.y === pins[0].y, "pin position should be deterministic");
      }
    });

    return { pass: pass, fail: fail, log: log };
  }

  /* ---------- register ---------- */
  HC.registerFeature({
    id: "parent-map-view",
    title: "Map view with featured star pins",
    side: "parent",
    icon: "🗺️",
    summary: "Browse E17 holiday camps on a map. Every camp is a pin; Featured camps get a yellow star pin (Happity-style). Toggle 'Featured only', or tap a pin to feature/unfeature it.",
    render: render,
    selfTest: selfTest
  });
})();
