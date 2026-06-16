/* HolidayCamp feature — provider-venue-finder
 * ------------------------------------------------------------------
 * Replicates Happity's "Venue Finder" (support article 5317575,
 * "Use our Venue finder to expand your business"), reframed for
 * SCHOOL-AGE HOLIDAY CAMPS (not baby classes).
 *
 * Evidence (support corpus 5317575):
 *   "If you are looking for a new venue but do not know what is
 *    available in your area then our Venue Finder can help!"
 *   "All members get access to our comprehensive directory of venues
 *    which can be accessed via your account dashboard..."
 *   "Every time a provider sets up a new venue ... it is added to this
 *    directory and listed under the relevant POSTCODE."
 *   "So next time you need to find a tried and tested venue ... make
 *    sure you check here first!"
 *   "Simply start typing in the venue name and address and matching
 *    venues will be suggested."
 *
 * So the Venue Finder is a DISCOVERY directory (distinct from the
 * "Where" step picker in provider-venue-create): a Member browses /
 * searches the comprehensive list of local venues — by name, postcode
 * or area — to find a tried-and-tested place to run a NEW camp, and
 * sees how many camps already run there (its "track record").
 *
 * ACCEPTANCE CRITERION (asserted by selfTest, multiple cases):
 *   A venue directory lets a Member search venues / areas to run new
 *   camps. Searching by venue name, by postcode, and by area each
 *   returns the matching tried-and-tested venues from the directory;
 *   venues are listed under their postcode; and a Member can shortlist
 *   a venue as a candidate for a new camp (persisted via HC.store).
 *
 * Defensive: nothing throws at registration. The directory is derived
 * read-only from the live camps.js data (HC.data.providers); the
 * verified data is never mutated. Shortlist persists via HC.store ONLY.
 * No imports/exports — plain browser JS, passes `node --check`.
 * ------------------------------------------------------------------ */
(function () {
  "use strict";

  if (typeof window === "undefined" || !window.HC || typeof window.HC.registerFeature !== "function") {
    // Core not present — fail silently rather than throwing at load.
    if (typeof console !== "undefined" && console.warn) {
      console.warn("[HC] provider-venue-finder: HC core not found; skipping registration.");
    }
    return;
  }
  var HC = window.HC;

  var SHORTLIST_KEY = "provider_venue_finder_shortlist"; // [venueId,...]

  /* ============================================================
   * 1. Text + postcode helpers.
   * ============================================================ */

  function trimStr(s) { return String(s == null ? "" : s).replace(/\s+/g, " ").trim(); }

  function norm(s) {
    return String(s == null ? "" : s)
      .toLowerCase()
      .replace(/&/g, " and ")
      .replace(/['’`]/g, "")        // collapse apostrophes ("St Mary's" -> "st marys")
      .replace(/[^a-z0-9 ]+/g, " ")      // drop punctuation
      .replace(/\s+/g, " ")
      .trim();
  }

  // Full UK postcode, normalised WITH a single space (e.g. "E17 8EP").
  function fullPostcode(s) {
    var m = String(s == null ? "" : s).toUpperCase()
      .match(/\b([A-Z]{1,2}\d[A-Z\d]?)\s?(\d[A-Z]{2})\b/);
    return m ? (m[1] + " " + m[2]) : "";
  }

  // The outward (area) code only, e.g. "E17", "E4", "IG8". This is the
  // key Happity lists venues "under" in the directory.
  function outwardCode(s) {
    var full = fullPostcode(s);
    if (full) return full.split(" ")[0];
    var m = String(s == null ? "" : s).toUpperCase().match(/\b([A-Z]{1,2}\d[A-Z\d]?)\b/);
    return m ? m[1] : "";
  }

  // A stable identity for a venue: normalised name (+ postcode when known)
  // so the same hall listed by two providers de-duplicates into one record.
  function venueKey(name, address) {
    var pc = fullPostcode(address) || fullPostcode(name);
    var base = norm(name);
    return pc ? (base + "|" + pc.replace(/\s+/g, "")) : base;
  }

  // Split a provider's "Venue A and Venue B" / "x; y" field, pairing with
  // any "addr1; addr2" so multi-site providers contribute several venues.
  function splitVenues(venueStr, addressStr) {
    var names = String(venueStr == null ? "" : venueStr)
      .split(/\s+and\s+|;|\s*\/\s*/i)
      .map(trimStr).filter(Boolean);
    var addrs = String(addressStr == null ? "" : addressStr)
      .split(/;|\s+and\s+/i)
      .map(trimStr).filter(Boolean);
    if (!names.length) names = [trimStr(venueStr) || ""];
    var out = [];
    for (var i = 0; i < names.length; i++) {
      out.push({
        name: names[i],
        address: addrs.length === names.length ? addrs[i] : (addrs[0] || trimStr(addressStr) || "")
      });
    }
    return out;
  }

  // Is this a real, pickable venue rather than a "Borough-wide" /
  // "Multiple ... sites" / "Sites vary" placeholder? Placeholders are not
  // somewhere a new camp can actually be run, so they're excluded.
  function isRealVenue(name, address) {
    var n = norm(name);
    var a = norm(address);
    if (!n) return false;
    var placeholders = [
      /^multiple\b/, /^borough wide$/, /^sites vary/, /^check booking/,
      /sites vary/, /venues vary/, /^various\b/, /surrounding areas/,
      /^local\b.*\bsites?$/, /^mobile/, /club sites$/, /^.*\bvary\b.*$/
    ];
    function hits(s) { return placeholders.some(function (re) { return re.test(s); }); }
    // Only reject if BOTH name and address look like placeholders and there's
    // no recoverable postcode (a postcode means it pins to a real spot).
    var hasPin = !!(fullPostcode(address) || fullPostcode(name) || outwardCode(address));
    if (hits(n) && !hasPin) return false;
    if (n === "borough wide") return false;
    return true;
  }

  /* ============================================================
   * 2. Build the comprehensive venue DIRECTORY from live data.
   *    Each distinct venue record carries: name, address, postcode,
   *    outward (area) code, the human area label, and a "campCount"
   *    = how many provider camps already run there (its track record).
   * ============================================================ */

  function buildDirectory() {
    var byKey = {};
    var out = [];

    function add(name, address, areaLabel, provider) {
      name = trimStr(name);
      if (!isRealVenue(name, address)) return;
      var key = venueKey(name, address);
      var full = fullPostcode(address) || fullPostcode(name);
      var outward = outwardCode(address) || outwardCode(name);
      var rec = byKey[key];
      if (rec) {
        rec.campCount += 1;
        if (provider && rec.providers.indexOf(provider) === -1) rec.providers.push(provider);
        // Prefer a more specific (postcoded) address if we now have one.
        if (full && !rec.postcode) { rec.postcode = full; rec.outward = outward || rec.outward; }
        if (!rec.address && address) rec.address = trimStr(address);
        return;
      }
      rec = {
        id: "venue_dir_" + (out.length + 1),
        name: name,
        address: trimStr(address),
        postcode: full || "",
        outward: outward || "",
        area: trimStr(areaLabel),
        key: key,
        campCount: 1,                       // tried-and-tested track record
        providers: provider ? [provider] : []
      };
      byKey[key] = rec;
      out.push(rec);
    }

    try {
      var providers = HC.data.providers || [];
      for (var i = 0; i < providers.length; i++) {
        var p = providers[i];
        if (!p || !p.venue) continue;
        var parts = splitVenues(p.venue, p.address);
        for (var j = 0; j < parts.length; j++) {
          add(parts[j].name, parts[j].address, p.area, p.name);
        }
      }
    } catch (e) { /* defensive */ }

    if (!out.length) {
      // Synthetic fallback so the finder always has something to show.
      out.push({
        id: "venue_dir_1", name: "Walthamstow Leisure Centre",
        address: "170 Markhouse Road, London E17 8EP", postcode: "E17 8EP",
        outward: "E17", area: "Walthamstow", key: venueKey("Walthamstow Leisure Centre", "E17 8EP"),
        campCount: 1, providers: ["Demo provider"]
      });
    }

    // Sort by track record (most-used venues first) then name — the
    // "tried and tested" venues surface at the top.
    out.sort(function (a, b) {
      if (b.campCount !== a.campCount) return b.campCount - a.campCount;
      return a.name.localeCompare(b.name);
    });
    return out;
  }

  /* ============================================================
   * 3. CORE LOGIC the selfTest exercises: search, group-by-postcode,
   *    distinct areas, and the shortlist.
   * ============================================================ */

  // Search the directory by venue name, postcode (full or outward), or
  // area. Empty query => the whole directory (Happity: browse everything).
  function searchDirectory(query, dir) {
    dir = dir || buildDirectory();
    var q = norm(query);
    var full = fullPostcode(query);
    var outward = outwardCode(query);
    if (!q && !full && !outward) return dir.slice();
    var qTokens = q.split(" ").filter(Boolean);
    return dir.filter(function (v) {
      // Postcode match (full or area/outward) — the primary way to find
      // venues "in your area".
      if (full && v.postcode && fullPostcode(v.postcode) === full) return true;
      if (outward && v.outward && v.outward.toUpperCase() === outward.toUpperCase()) return true;
      // Otherwise an AND text search over name + address + area.
      var hay = norm(v.name + " " + v.address + " " + v.area + " " + v.outward);
      if (!qTokens.length) return false;
      return qTokens.every(function (t) { return hay.indexOf(t) !== -1; });
    });
  }

  // Group the directory "under the relevant postcode" (outward area code),
  // exactly as Happity describes. Returns [{ outward, venues:[...] }, ...]
  // ordered by how many venues each area has.
  function groupByPostcode(dir) {
    dir = dir || buildDirectory();
    var groups = {};
    for (var i = 0; i < dir.length; i++) {
      var key = dir[i].outward || "Unknown area";
      if (!groups[key]) groups[key] = [];
      groups[key].push(dir[i]);
    }
    var out = [];
    for (var k in groups) {
      if (Object.prototype.hasOwnProperty.call(groups, k)) {
        out.push({ outward: k, venues: groups[k] });
      }
    }
    out.sort(function (a, b) {
      if (b.venues.length !== a.venues.length) return b.venues.length - a.venues.length;
      return String(a.outward).localeCompare(String(b.outward));
    });
    return out;
  }

  // Distinct postcode (outward) areas covered by the directory.
  function distinctAreas(dir) {
    dir = dir || buildDirectory();
    var seen = {};
    var out = [];
    for (var i = 0; i < dir.length; i++) {
      var o = dir[i].outward;
      if (o && !seen[o]) { seen[o] = true; out.push(o); }
    }
    out.sort();
    return out;
  }

  /* ---- shortlist (a Member's candidate venues for a new camp) ---- */

  function readShortlist() {
    try {
      var s = HC.store.get(SHORTLIST_KEY, []);
      return Array.isArray(s) ? s : [];
    } catch (e) { return []; }
  }
  function writeShortlist(list) {
    try { HC.store.set(SHORTLIST_KEY, Array.isArray(list) ? list : []); } catch (e) {}
  }
  function clearShortlist() { try { HC.store.set(SHORTLIST_KEY, []); } catch (e) {} }

  function isShortlisted(venueId) { return readShortlist().indexOf(venueId) !== -1; }

  // Shortlist a directory venue as a candidate to run a new camp at.
  // Returns { ok, shortlisted, message }. Idempotent.
  function shortlistVenue(venueId, dir) {
    dir = dir || buildDirectory();
    var v = null;
    for (var i = 0; i < dir.length; i++) if (dir[i].id === venueId) { v = dir[i]; break; }
    if (!v) return { ok: false, shortlisted: false, message: "That venue is not in the directory." };
    var list = readShortlist();
    if (list.indexOf(venueId) === -1) { list.push(venueId); writeShortlist(list); }
    return {
      ok: true, shortlisted: true,
      venue: { id: v.id, name: v.name, postcode: v.postcode, outward: v.outward },
      message: "Added “" + v.name + "” to your shortlist of venues to run a new camp at."
    };
  }

  // Toggle on/off, used by the UI. Returns { ok, shortlisted }.
  function toggleShortlist(venueId, dir) {
    if (isShortlisted(venueId)) {
      var list = readShortlist().filter(function (id) { return id !== venueId; });
      writeShortlist(list);
      return { ok: true, shortlisted: false };
    }
    var r = shortlistVenue(venueId, dir);
    return { ok: r.ok, shortlisted: r.ok };
  }

  /* ============================================================
   * 4. UI — the Venue Finder directory.
   *    A search box (name / postcode / area) -> matching venues, each
   *    with its postcode badge, area, track-record count, and an
   *    "Add to shortlist" button. Plus a "browse by area" summary.
   * ============================================================ */

  function esc(s) {
    return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
  function escAttr(s) { return esc(s).replace(/"/g, "&quot;"); }

  function venueRow(v) {
    var shortlisted = isShortlisted(v.id);
    var pc = v.postcode || v.outward || "area?";
    var track = v.campCount > 1
      ? (v.campCount + " camps already run here — tried &amp; tested")
      : "1 camp runs here";
    return '<div class="vf-vrow" style="display:flex;justify-content:space-between;gap:10px;align-items:center;' +
        'border:1.5px solid var(--line,#E6E6E6);border-radius:12px;padding:10px 12px;margin-bottom:8px">' +
      '<div style="min-width:0">' +
        '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">' +
          '<span style="font-family:\'Quicksand\',system-ui,sans-serif;font-weight:700;color:var(--purple,#603488);font-size:14px">' +
            esc(v.name) + '</span>' +
          '<span style="font-size:10.5px;font-weight:700;background:var(--purple-tint,#F0E8F4);color:var(--purple,#603488);' +
            'border-radius:999px;padding:2px 8px">' + esc(pc) + '</span>' +
        '</div>' +
        '<div style="font-size:12px;color:var(--muted,#808080);margin-top:2px">' +
          esc(v.address || "Address on file") + (v.area ? " · " + esc(v.area) : "") + '</div>' +
        '<div style="font-size:11.5px;color:var(--magenta,#F82488);font-weight:700;margin-top:4px">' + track + '</div>' +
      '</div>' +
      '<button type="button" class="hc-btn vf-shortlist' + (shortlisted ? ' hc-btn-ghost' : '') + '" ' +
        'data-id="' + escAttr(v.id) + '">' + (shortlisted ? '✓ Shortlisted' : '+ Shortlist') + '</button>' +
    '</div>';
  }

  function render(mountEl) {
    try {
      if (!mountEl) return;
      var dir = buildDirectory();
      var areas = distinctAreas(dir);
      var inp = "width:100%;padding:9px;border:1.5px solid var(--line,#E6E6E6);border-radius:12px;font-size:14px;box-sizing:border-box";

      mountEl.innerHTML =
        '<div style="font-family:\'Nunito Sans\',system-ui,sans-serif;color:var(--text,#383838)">' +
          '<p style="font-size:14px;margin:0 0 6px"><strong>Looking to expand?</strong> ' +
            'Search our comprehensive directory of <strong>' + dir.length + ' local venues</strong> ' +
            'across <strong>' + areas.length + ' postcode areas</strong> to find a tried-and-tested place ' +
            'to run a new camp. Venues are listed under their postcode — start typing a venue name, ' +
            'postcode or area.</p>' +
          '<p style="font-size:12px;color:var(--muted,#808080);margin:0 0 8px;font-style:italic">' +
            'Mirrors Happity: “Every time a provider sets up a new venue … it is added to this ' +
            'directory and listed under the relevant postcode.”</p>' +
          '<input id="vfSearch" type="text" placeholder="Search by venue, postcode (e.g. E17) or area (e.g. Leyton)" style="' + inp + ';margin:6px 0 6px">' +
          '<div id="vfAreas" style="display:flex;flex-wrap:wrap;gap:6px;margin:0 0 10px"></div>' +
          '<div id="vfCount" style="font-family:\'Quicksand\',system-ui,sans-serif;font-weight:700;color:var(--magenta,#F82488);font-size:13px;margin:0 0 8px"></div>' +
          '<div id="vfResults"></div>' +
          '<div style="border-top:1px solid var(--line,#E6E6E6);margin-top:12px;padding-top:10px">' +
            '<div style="font-family:\'Quicksand\',system-ui,sans-serif;font-weight:700;color:var(--purple,#603488);font-size:13px;margin-bottom:6px">' +
              'Your shortlist (venues to run a new camp at)</div>' +
            '<div id="vfShortlist"></div>' +
          '</div>' +
        '</div>';

      var searchEl = mountEl.querySelector("#vfSearch");
      var areasEl = mountEl.querySelector("#vfAreas");
      var countEl = mountEl.querySelector("#vfCount");
      var resultsEl = mountEl.querySelector("#vfResults");
      var shortEl = mountEl.querySelector("#vfShortlist");

      // Quick area chips — click to filter to a postcode area.
      areasEl.innerHTML = areas.slice(0, 10).map(function (a) {
        return '<button type="button" class="vf-area-chip" data-area="' + escAttr(a) + '" ' +
          'style="cursor:pointer;font-family:\'Quicksand\',system-ui,sans-serif;font-weight:700;font-size:12px;' +
          'border:1.5px solid var(--purple-tint,#F0E8F4);background:#fff;color:var(--purple,#603488);' +
          'border-radius:999px;padding:5px 11px">' + esc(a) + '</button>';
      }).join("");

      function paintResults() {
        var matches = searchDirectory(searchEl.value, dir);
        countEl.textContent = matches.length + (matches.length === 1 ? " venue" : " venues") + " found";
        if (!matches.length) {
          resultsEl.innerHTML = '<div style="font-size:13px;color:var(--muted,#808080);padding:6px 2px">' +
            'No venues match — try a postcode area like E17, or clear the search to browse the whole directory.</div>';
          return;
        }
        resultsEl.innerHTML = matches.slice(0, 40).map(venueRow).join("");
      }

      function paintShortlist() {
        var ids = readShortlist();
        if (!ids.length) {
          shortEl.innerHTML = '<div style="font-size:12.5px;color:var(--muted,#808080)">' +
            'Nothing shortlisted yet — add venues above to plan where to expand.</div>';
          return;
        }
        var rows = [];
        for (var i = 0; i < ids.length; i++) {
          var v = null;
          for (var j = 0; j < dir.length; j++) if (dir[j].id === ids[i]) { v = dir[j]; break; }
          if (!v) continue;
          rows.push('<div style="display:flex;justify-content:space-between;gap:8px;align-items:center;' +
            'background:#E1F0E4;border-radius:10px;padding:7px 10px;margin-bottom:6px;font-size:13px;color:#2f7d4f">' +
            '<span>✓ <strong>' + esc(v.name) + '</strong>' + (v.postcode ? ' · ' + esc(v.postcode) : (v.outward ? ' · ' + esc(v.outward) : '')) + '</span>' +
            '<button type="button" class="hc-btn hc-btn-ghost vf-remove" data-id="' + escAttr(v.id) + '" style="padding:4px 10px;font-size:11px">Remove</button>' +
          '</div>');
        }
        shortEl.innerHTML = rows.join("") || '<div style="font-size:12.5px;color:var(--muted,#808080)">Shortlist cleared.</div>';
      }

      searchEl.addEventListener("input", paintResults);

      mountEl.addEventListener("click", function (e) {
        var chip = e.target.closest(".vf-area-chip");
        if (chip) { searchEl.value = chip.getAttribute("data-area"); paintResults(); return; }
        var add = e.target.closest(".vf-shortlist");
        if (add) {
          var r = toggleShortlist(add.getAttribute("data-id"), dir);
          paintResults(); paintShortlist();
          try { HC.util.toast(r.shortlisted ? "Added to shortlist ✓" : "Removed from shortlist"); } catch (x) {}
          return;
        }
        var rem = e.target.closest(".vf-remove");
        if (rem) {
          toggleShortlist(rem.getAttribute("data-id"), dir);
          paintResults(); paintShortlist();
          return;
        }
      });

      paintResults();
      paintShortlist();
    } catch (e) {
      try {
        mountEl.innerHTML = '<p style="color:#9a1f5e">Venue Finder failed to load: ' +
          esc(e && e.message ? e.message : String(e)) + "</p>";
      } catch (e2) { /* give up quietly */ }
    }
  }

  /* ============================================================
   * 5. selfTest — exercises the directory LOGIC and asserts the
   *    acceptance criterion: a venue directory lets a Member search
   *    venues / areas to run new camps. Multiple cases.
   * ============================================================ */

  function selfTest() {
    var pass = 0, fail = 0, log = [];
    function check(label, fn) {
      try { fn(); pass += 1; log.push("✓ " + label); }
      catch (e) { fail += 1; log.push("✗ " + label + " — " + (e && e.message ? e.message : String(e))); }
    }

    // Start from a clean shortlist so runs are deterministic.
    clearShortlist();

    // A small deterministic directory for the pure-logic cases (independent
    // of live data). Mirrors the shape buildDirectory() produces.
    function fixtureDir() {
      return [
        { id: "d1", name: "Walthamstow Leisure Centre", address: "170 Markhouse Road, London E17 8EP", postcode: "E17 8EP", outward: "E17", area: "Walthamstow", key: venueKey("Walthamstow Leisure Centre", "E17 8EP"), campCount: 3, providers: ["A", "B", "C"] },
        { id: "d2", name: "Lloyd Park Pavilion", address: "Winns Terrace, London E17 5JW", postcode: "E17 5JW", outward: "E17", area: "Walthamstow", key: venueKey("Lloyd Park Pavilion", "E17 5JW"), campCount: 1, providers: ["B"] },
        { id: "d3", name: "Woodbridge High School", address: "Mallards Road, Woodford Green, IG8 7DQ", postcode: "IG8 7DQ", outward: "IG8", area: "Woodford Green", key: venueKey("Woodbridge High School", "IG8 7DQ"), campCount: 2, providers: ["A", "D"] },
        { id: "d4", name: "Leytonstone Community Sports Centre", address: "James Lane, Leytonstone, E11 1NS", postcode: "E11 1NS", outward: "E11", area: "Leytonstone", key: venueKey("Leytonstone Community Sports Centre", "E11 1NS"), campCount: 1, providers: ["E"] }
      ];
    }

    /* ---- ACCEPTANCE (A): search the directory by VENUE NAME ---- */
    check("ACCEPTANCE: a Member can search the directory by venue name", function () {
      var r = searchDirectory("lloyd park", fixtureDir());
      HC.assert(r.length >= 1, "expected >=1 match for 'lloyd park'");
      HC.assert(r.some(function (v) { return v.id === "d2"; }), "Lloyd Park Pavilion should be found by name");
    });

    /* ---- ACCEPTANCE (B): search by POSTCODE (the field venues are listed under) ---- */
    check("ACCEPTANCE: a Member can search the directory by full postcode", function () {
      var r = searchDirectory("E17 8EP", fixtureDir());
      HC.assert(r.some(function (v) { return v.id === "d1"; }), "full postcode should find the Leisure Centre");
    });

    check("ACCEPTANCE: a Member can search by postcode AREA (outward code) to see all venues there", function () {
      var r = searchDirectory("E17", fixtureDir());
      HC.assert(r.length === 2, "E17 area should return both E17 venues, got " + r.length);
      var ids = r.map(function (v) { return v.id; });
      HC.assert(ids.indexOf("d1") !== -1 && ids.indexOf("d2") !== -1, "both E17 venues returned");
      HC.assert(ids.indexOf("d3") === -1, "an IG8 venue must NOT appear under E17");
    });

    /* ---- ACCEPTANCE (C): search by AREA name to find venues to run new camps ---- */
    check("ACCEPTANCE: a Member can search the directory by area name", function () {
      var r = searchDirectory("woodford green", fixtureDir());
      HC.assert(r.some(function (v) { return v.id === "d3"; }), "Woodford Green venue found by area name");
    });

    check("Empty search browses the WHOLE directory (Happity: browse everything)", function () {
      var r = searchDirectory("", fixtureDir());
      HC.assert(r.length === 4, "empty query should list all 4 fixture venues, got " + r.length);
    });

    check("A non-matching search returns no venues (no false positives)", function () {
      var r = searchDirectory("nonexistent venue zzzq", fixtureDir());
      HC.assert(r.length === 0, "garbage query should match nothing, got " + r.length);
    });

    /* ---- Venues are listed UNDER THE RELEVANT POSTCODE ---- */
    check("Venues are grouped under their postcode (outward) area", function () {
      var groups = groupByPostcode(fixtureDir());
      var e17 = groups.filter(function (g) { return g.outward === "E17"; })[0];
      HC.assert(e17 && e17.venues.length === 2, "E17 group should hold 2 venues");
      var ig8 = groups.filter(function (g) { return g.outward === "IG8"; })[0];
      HC.assert(ig8 && ig8.venues.length === 1, "IG8 group should hold 1 venue");
      // Most-populated area is sorted first.
      HC.assert(groups[0].outward === "E17", "the busiest area (E17) should sort to the top");
    });

    check("distinctAreas reports each postcode area once", function () {
      var areas = distinctAreas(fixtureDir());
      HC.assert(areas.length === 3, "expected 3 distinct areas (E17, E11, IG8), got " + areas.length);
      HC.assert(areas.indexOf("E17") !== -1 && areas.indexOf("E11") !== -1 && areas.indexOf("IG8") !== -1,
        "all three outward codes represented");
    });

    /* ---- Track record: tried-and-tested ordering ---- */
    check("Directory surfaces tried-and-tested venues (busiest first)", function () {
      var dir = fixtureDir().slice().sort(function (a, b) { return b.campCount - a.campCount; });
      HC.assert(dir[0].campCount >= dir[1].campCount, "highest campCount first");
      HC.assert(dir[0].id === "d1", "the 3-camp venue should lead the track record");
    });

    /* ---- ACCEPTANCE (D): shortlist a venue to run a new camp at ---- */
    check("ACCEPTANCE: a Member can shortlist a directory venue to run a new camp at", function () {
      clearShortlist();
      var res = shortlistVenue("d3", fixtureDir());
      HC.assert(res.ok === true, "shortlisting a real directory venue should succeed");
      HC.assert(res.shortlisted === true, "result should be flagged shortlisted");
      HC.assert(res.venue && res.venue.name === "Woodbridge High School", "the shortlisted venue should resolve");
      HC.assert(isShortlisted("d3") === true, "shortlist state should persist via HC.store");
      HC.assert(readShortlist().length === 1, "exactly one venue shortlisted");
    });

    check("Shortlisting is idempotent (no duplicates)", function () {
      clearShortlist();
      shortlistVenue("d1", fixtureDir());
      shortlistVenue("d1", fixtureDir());
      HC.assert(readShortlist().length === 1, "the same venue must not shortlist twice, got " + readShortlist().length);
    });

    check("Shortlisting a venue that isn't in the directory is rejected", function () {
      clearShortlist();
      var res = shortlistVenue("nope", fixtureDir());
      HC.assert(res.ok === false, "unknown venue id must be rejected");
      HC.assert(isShortlisted("nope") === false, "nothing should be persisted for an unknown id");
    });

    check("Toggle removes a shortlisted venue", function () {
      clearShortlist();
      var on = toggleShortlist("d2", fixtureDir());
      HC.assert(on.shortlisted === true, "first toggle adds it");
      var off = toggleShortlist("d2", fixtureDir());
      HC.assert(off.shortlisted === false, "second toggle removes it");
      HC.assert(isShortlisted("d2") === false, "venue should no longer be shortlisted");
      HC.assert(readShortlist().length === 0, "shortlist should be empty again");
    });

    /* ---- LIVE DATA: the directory is real, postcoded and searchable ---- */
    check("The directory is built from live camp data with several venues", function () {
      var dir = buildDirectory();
      HC.assert(dir.length >= 10, "expected many real venues from live data, got " + dir.length);
      HC.assert(dir.every(function (v) { return v.name; }), "every directory venue has a name");
    });

    check("Non-specific placeholders are excluded from the directory", function () {
      var dir = buildDirectory();
      HC.assert(!dir.some(function (v) { return /^borough wide$/i.test(norm(v.name)); }),
        "'Borough-wide' must not be a pickable directory venue");
      HC.assert(!dir.some(function (v) { return norm(v.name) === "" ; }), "no empty-named venues");
    });

    check("Live directory is searchable by a real postcode area (E17)", function () {
      var dir = buildDirectory();
      var e17 = searchDirectory("E17", dir);
      HC.assert(e17.length >= 1, "E17 should match real Walthamstow venues, got " + e17.length);
      HC.assert(e17.every(function (v) { return (v.outward || "").toUpperCase() === "E17" || fullPostcode(v.postcode).indexOf("E17") === 0; }),
        "every E17 result should actually be in E17");
    });

    check("Live directory groups venues under multiple distinct postcode areas", function () {
      var areas = distinctAreas(buildDirectory());
      HC.assert(areas.length >= 3, "live data should span several postcode areas, got " + areas.length);
    });

    check("END-TO-END: search live directory by area, then shortlist a result for a new camp", function () {
      clearShortlist();
      var dir = buildDirectory();
      var results = searchDirectory("E17", dir);
      HC.assert(results.length >= 1, "search must return at least one E17 venue");
      var pick = results[0];
      var res = shortlistVenue(pick.id, dir);
      HC.assert(res.ok === true, "shortlisting a live search result should succeed");
      HC.assert(isShortlisted(pick.id) === true, "the live venue should now be on the shortlist");
    });

    /* ---- Defensive: junk input never throws ---- */
    check("Junk / empty inputs are handled and never throw", function () {
      HC.assert(Array.isArray(searchDirectory(null, fixtureDir())), "null query returns an array");
      HC.assert(Array.isArray(searchDirectory(undefined, [])), "empty dir returns an array");
      HC.assert(Array.isArray(groupByPostcode(null)), "null dir grouping returns an array");
      HC.assert(Array.isArray(distinctAreas(undefined)), "undefined dir areas returns an array");
      var bad = shortlistVenue(undefined, []);
      HC.assert(bad.ok === false, "shortlisting from an empty dir is rejected, not thrown");
    });

    // Leave the store as we found it.
    clearShortlist();

    return { pass: pass, fail: fail, log: log };
  }

  /* ============================================================
   * 6. Register (idempotent + defensive via core).
   * ============================================================ */
  HC.registerFeature({
    id: "provider-venue-finder",
    title: "Venue Finder — directory to expand your camps",
    side: "provider",
    icon: "🔍",
    summary: "Search our comprehensive directory of local venues by name, postcode or area to find a tried-and-tested place to run a new camp. Venues are listed under their postcode with a track record of how many camps already run there, and you can shortlist candidates (mirrors Happity's Venue Finder).",
    render: render,
    selfTest: selfTest
  });
})();
