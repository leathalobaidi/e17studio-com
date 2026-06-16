/* HolidayCamp feature: provider-venue-create
 * ------------------------------------------------------------------
 * Replicates Happity's "Add venue details" / "Where" step for the
 * PROVIDER side, reframed for SCHOOL-AGE HOLIDAY CAMPS, not baby
 * classes. When a provider sets up (or edits) a camp schedule they
 * reach a venue step where they either PICK an existing venue from
 * the shared database or REQUEST a new one to be added.
 *
 * Evidence (support corpus):
 *  - 10485559 "The venue I need isn't listed, what should I do?":
 *      On the **'Add venue details'** page you "add your class venue;
 *      if you have searched the database and the venue does not
 *      already exist you can click 'Add a new one to our database'."
 *      A form follows; you "search for the address using the top
 *      field ... taken from google maps". If the address you enter
 *      matches an existing venue, "this will pop and you can then
 *      select this and carry on." Repeatedly warns: "Always double
 *      check that your venue is not already in the database before
 *      creating a new one."
 *  - 6172244 (older variant): the **'Where'** section is where you
 *      add your class venue; if it doesn't exist "click 'Add a new
 *      one'". Same duplicate-pop behaviour.
 *  - 8217618 "How can I edit my class venue?": from a class you click
 *      the **'Where'** section; "search our database for the new
 *      venue, as we may already have this"; "if the venue is not
 *      already in our database ... click 'Add a new one'"; then Save.
 *
 * Acceptance criterion (asserted by selfTest, multiple cases):
 *   The venue step lets a provider PICK an existing venue OR REQUEST
 *   a new one. A pick resolves to a real database venue; a request
 *   for a genuinely-new venue is accepted, persisted and becomes the
 *   schedule's selected venue; a request that duplicates an existing
 *   venue is intercepted ("pops") so the provider selects the
 *   existing record instead of creating a duplicate.
 *
 * Defensive: nothing throws at registration time. The shared venue
 * database is derived (read-only) from the live camps.js data; any
 * provider-requested venues persist via HC.store ONLY. The verified
 * camps.js data is never mutated.
 * ------------------------------------------------------------------ */
(function () {
  "use strict";

  if (typeof window === "undefined" || !window.HC || typeof window.HC.registerFeature !== "function") {
    // Core not present — fail silently rather than throwing.
    return;
  }
  var HC = window.HC;

  var STORE_KEY = "provider_venue_requests"; // [ {id,name,address,...} ]
  var SEL_KEY = "provider_venue_selection";  // { [scheduleId]: venueId }

  /* ============================================================
   * 1. Text helpers + a normaliser used for duplicate detection.
   *    Happity's "this will pop" behaviour = match an entered
   *    address/name against existing venues. We normalise hard so
   *    "St. Mary's Hall, E17 9NH" == "st marys hall e17 9nh".
   * ============================================================ */

  function trimStr(s) { return String(s == null ? "" : s).replace(/\s+/g, " ").trim(); }

  function norm(s) {
    return String(s == null ? "" : s)
      .toLowerCase()
      .replace(/&/g, " and ")
      .replace(/['’`]/g, "")        // collapse apostrophes so "St Mary's" == "St Marys"
      .replace(/[^a-z0-9 ]+/g, " ") // drop remaining punctuation (commas, dots, etc.)
      .replace(/\s+/g, " ")
      .trim();
  }

  // A UK-postcode-ish token, normalised (no spaces) for matching.
  function postcodeKey(s) {
    var m = String(s == null ? "" : s).toUpperCase()
      .match(/[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}/);
    return m ? m[0].replace(/\s+/g, "") : "";
  }

  // A stable matching signature for a venue: normalised name + any postcode.
  function venueKey(name, address) {
    var pc = postcodeKey(address) || postcodeKey(name);
    var base = norm(name);
    return pc ? (base + "|" + pc) : base;
  }

  /* ============================================================
   * 2. Build the shared venue DATABASE from live camp data.
   *    Each provider record carries `venue` and `address`. A single
   *    provider may list several venues ("A and B"; "x; y"), so we
   *    split and de-duplicate into distinct venue records — exactly
   *    the shared, searchable database a provider picks from.
   * ============================================================ */

  function splitVenues(venueStr, addressStr) {
    // Pair up "Venue A and Venue B" with "addr1; addr2" where we can,
    // else fall back to a single combined venue.
    var names = String(venueStr == null ? "" : venueStr)
      .split(/\s+and\s+|;|\s*\/\s*/i)
      .map(trimStr).filter(Boolean);
    var addrs = String(addressStr == null ? "" : addressStr)
      .split(/;/)
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

  // The read-only database of venues already known to HolidayCamp.
  function databaseVenues() {
    var byKey = {};
    var out = [];
    function add(name, address, ownerId) {
      name = trimStr(name);
      if (!name || /^multiple\b/i.test(name) || /^borough-wide$/i.test(name)) {
        // Skip non-specific placeholders so they aren't pickable as a real venue.
        if (!address || /^borough-wide$/i.test(trimStr(address))) return;
      }
      if (!name) return;
      var key = venueKey(name, address);
      if (byKey[key]) {
        // Record that another provider also uses this venue (usage count).
        byKey[key].usedBy.push(ownerId);
        return;
      }
      var rec = {
        id: "venue_db_" + (out.length + 1),
        name: name,
        address: trimStr(address),
        key: key,
        source: "database",       // vs "requested"
        usedBy: [ownerId]
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
        for (var j = 0; j < parts.length; j++) add(parts[j].name, parts[j].address, p.id);
      }
    } catch (e) { /* defensive */ }

    if (!out.length) {
      // Synthetic fallback so the picker always has a database to search.
      out.push({
        id: "venue_db_1", name: "Walthamstow Leisure Centre",
        address: "170 Markhouse Road, London E17 8EP",
        key: venueKey("Walthamstow Leisure Centre", "E17 8EP"),
        source: "database", usedBy: ["demo"]
      });
    }
    return out;
  }

  /* ============================================================
   * 3. Provider-requested venues (persisted) + the full pool.
   *    The "pool" = database venues + any venues this provider has
   *    successfully requested. Both are pickable.
   * ============================================================ */

  function readRequests() {
    try {
      var r = HC.store.get(STORE_KEY, []);
      return Array.isArray(r) ? r : [];
    } catch (e) { return []; }
  }
  function writeRequests(list) {
    try { HC.store.set(STORE_KEY, Array.isArray(list) ? list : []); } catch (e) {}
  }
  function clearRequests() { try { HC.store.set(STORE_KEY, []); } catch (e) {} }

  // Full searchable pool: database first, then requested venues.
  function venuePool() {
    var db = databaseVenues();
    var reqs = readRequests().map(function (r) {
      return {
        id: r.id, name: r.name, address: r.address,
        key: venueKey(r.name, r.address),
        source: "requested", usedBy: [], status: r.status || "pending"
      };
    });
    return db.concat(reqs);
  }

  /* ============================================================
   * 4. CORE LOGIC — search / pick / request.
   *    These pure-ish functions are what the selfTest exercises.
   * ============================================================ */

  // Search the database (and requested venues) by name/address text.
  function searchVenues(query, pool) {
    pool = pool || venuePool();
    var q = norm(query);
    var pc = postcodeKey(query);
    if (!q && !pc) return pool.slice(); // empty query shows everything
    var qTokens = q.split(" ").filter(Boolean);
    return pool.filter(function (v) {
      var hay = norm(v.name + " " + v.address);
      var vpc = postcodeKey(v.address) || postcodeKey(v.name);
      if (pc && vpc && pc === vpc) return true;
      // every query token must appear (AND search), like a typeahead.
      return qTokens.every(function (t) { return hay.indexOf(t) !== -1; });
    });
  }

  // PICK an existing venue by id. Returns a selection result.
  function pickVenue(venueId, pool) {
    pool = pool || venuePool();
    var v = null;
    for (var i = 0; i < pool.length; i++) { if (pool[i].id === venueId) { v = pool[i]; break; } }
    if (!v) {
      return { ok: false, message: "That venue is not in the database.", venue: null };
    }
    return {
      ok: true,
      action: "picked",
      venue: { id: v.id, name: v.name, address: v.address, source: v.source },
      message: "Selected " + v.name + " — carry on setting up your camp."
    };
  }

  // Find a database/pool venue that duplicates a proposed new venue.
  // Mirrors Happity's "if we already have that venue listed, this will
  // pop and you can then select this".
  function findDuplicate(name, address, pool) {
    pool = pool || venuePool();
    var key = venueKey(name, address);
    var pc = postcodeKey(address);
    var nName = norm(name);
    for (var i = 0; i < pool.length; i++) {
      var v = pool[i];
      if (v.key === key) return v;
      var vpc = postcodeKey(v.address) || postcodeKey(v.name);
      // Same postcode AND same normalised name => same venue.
      if (pc && vpc && pc === vpc && norm(v.name) === nName) return v;
    }
    return null;
  }

  function validateNewVenue(name, address) {
    var errors = {};
    if (!trimStr(name)) errors.name = "Give the venue a name.";
    // Address is taken from "google maps" in Happity; we require some
    // address text (a postcode is strongly encouraged for the map pin).
    if (!trimStr(address)) errors.address = "Add the venue address (used for the map pin).";
    return errors;
  }

  /* REQUEST a new venue to be added to the database.
   *  - Validates name + address.
   *  - If it duplicates an existing venue => DOES NOT create; instead
   *    returns a "duplicate" result carrying the existing venue so the
   *    UI can prompt the provider to select it ("this will pop").
   *  - Otherwise persists the new venue (status: pending) and returns
   *    it as the schedule's selected venue.
   * Returns one of:
   *   { ok:false, errors }                               (invalid)
   *   { ok:false, duplicate:true, existing, message }    (already listed)
   *   { ok:true, action:'requested', venue, message }    (created)
   */
  function requestVenue(name, address, opts) {
    opts = opts || {};
    var errors = validateNewVenue(name, address);
    if (Object.keys(errors).length) {
      return {
        ok: false, errors: errors,
        message: "Could not add venue: " +
          Object.keys(errors).map(function (k) { return errors[k]; }).join(" ")
      };
    }

    var pool = opts.pool || venuePool();
    var dupe = findDuplicate(name, address, pool);
    if (dupe && !opts.forceCreate) {
      return {
        ok: false,
        duplicate: true,
        existing: { id: dupe.id, name: dupe.name, address: dupe.address, source: dupe.source },
        message: "Looks like “" + dupe.name + "” is already in our database — select it instead of adding a duplicate."
      };
    }

    var rec = {
      id: "venue_req_" + HC.util.uid(),
      name: trimStr(name),
      address: trimStr(address),
      status: "pending",       // a real backend would review/geocode it
      requestedAt: Date.now()
    };
    var reqs = readRequests();
    reqs.push(rec);
    writeRequests(reqs);

    return {
      ok: true,
      action: "requested",
      venue: { id: rec.id, name: rec.name, address: rec.address, source: "requested", status: "pending" },
      message: "Added “" + rec.name + "” — it's now selected for your camp (pending map check)."
    };
  }

  /* The venue STEP: a provider either picks an existing venue or
   * requests a new one, then the chosen venue is recorded against the
   * schedule. This is the function the acceptance criterion targets. */
  function selectForSchedule(scheduleId, choice) {
    // choice = { mode:'pick', venueId } | { mode:'request', name, address, forceCreate? }
    var res;
    if (choice && choice.mode === "pick") {
      res = pickVenue(choice.venueId);
    } else if (choice && choice.mode === "request") {
      res = requestVenue(choice.name, choice.address, { forceCreate: !!choice.forceCreate });
    } else {
      return { ok: false, message: "Choose to pick an existing venue or request a new one." };
    }
    if (res.ok && scheduleId) {
      try {
        var sel = HC.store.get(SEL_KEY, {});
        if (!sel || typeof sel !== "object") sel = {};
        sel[scheduleId] = res.venue.id;
        HC.store.set(SEL_KEY, sel);
      } catch (e) { /* defensive */ }
    }
    return res;
  }

  function selectedVenueId(scheduleId) {
    try {
      var sel = HC.store.get(SEL_KEY, {});
      return (sel && sel[scheduleId]) || null;
    } catch (e) { return null; }
  }
  function clearSelection(scheduleId) {
    try {
      var sel = HC.store.get(SEL_KEY, {});
      if (!sel || typeof sel !== "object") return;
      if (scheduleId) delete sel[scheduleId]; else sel = {};
      HC.store.set(SEL_KEY, sel);
    } catch (e) {}
  }

  /* ============================================================
   * 5. UI — the 'Add venue details' / 'Where' step.
   *    Search box -> list of matching database venues, each Selectable.
   *    A "Can't find it? Add a new one" panel collects name+address;
   *    on submit it either pops a duplicate to select, or adds + selects.
   * ============================================================ */

  function esc(s) {
    return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
  function escAttr(s) { return esc(s).replace(/"/g, "&quot;"); }

  function render(mountEl) {
    try {
      var SCHEDULE_ID = "demo-schedule"; // a single in-progress camp schedule
      var inp = "width:100%;padding:9px;border:1.5px solid var(--line,#E6E6E6);border-radius:12px;font-size:14px;box-sizing:border-box";
      var lab = "display:block;font-weight:700;font-size:13px;margin:12px 0 4px";

      mountEl.innerHTML =
        '<div style="font-family:\'Nunito Sans\',system-ui,sans-serif;color:var(--text,#383838)">' +
          '<p style="font-size:14px;margin:0 0 6px"><strong>Where is your camp?</strong> ' +
          'Search our venue database and <strong>select</strong> the venue. ' +
          'Always check it isn\'t already listed before adding a new one — that keeps the map accurate for parents.</p>' +
          '<input id="pvcSearch" type="text" placeholder="Search venue name or postcode (e.g. E17)" style="' + inp + ';margin:6px 0 4px">' +
          '<div id="pvcResults" style="margin-top:6px"></div>' +
          '<div id="pvcSelected" style="margin-top:10px"></div>' +
          '<div style="border-top:1px solid var(--line,#E6E6E6);margin-top:14px;padding-top:12px">' +
            '<button type="button" id="pvcAddToggle" class="hc-btn hc-btn-ghost">+ Can\'t find it? Add a new one</button>' +
            '<div id="pvcAddPanel" style="display:none;margin-top:10px">' +
              '<label style="' + lab + '">Venue name</label>' +
              '<input id="pvcName" type="text" placeholder="e.g. Lloyd Park Pavilion" style="' + inp + '">' +
              '<label style="' + lab + '">Address (used for the map pin)</label>' +
              '<input id="pvcAddr" type="text" placeholder="Street, town, postcode" style="' + inp + '">' +
              '<div id="pvcAddErr" style="color:#9a1f5e;font-size:12.5px;min-height:16px;margin-top:6px"></div>' +
              '<div id="pvcDupe" style="margin-top:4px"></div>' +
              '<button type="button" id="pvcAddSubmit" class="hc-btn" style="margin-top:8px">Add this venue</button>' +
            '</div>' +
          '</div>' +
        '</div>';

      var searchEl = mountEl.querySelector("#pvcSearch");
      var resultsEl = mountEl.querySelector("#pvcResults");
      var selectedEl = mountEl.querySelector("#pvcSelected");
      var addPanel = mountEl.querySelector("#pvcAddPanel");
      var dupeEl = mountEl.querySelector("#pvcDupe");
      var addErr = mountEl.querySelector("#pvcAddErr");

      function paintResults() {
        var matches = searchVenues(searchEl.value).slice(0, 8);
        if (!matches.length) {
          resultsEl.innerHTML = '<div style="font-size:13px;color:var(--muted,#808080);padding:6px 2px">' +
            'No venues match — try a different search, or add a new one below.</div>';
          return;
        }
        resultsEl.innerHTML = matches.map(function (v) {
          var badge = v.source === "requested"
            ? '<span style="font-size:10px;font-weight:700;background:var(--purple-tint,#F0E8F4);color:var(--purple,#603488);border-radius:999px;padding:2px 7px;margin-left:6px">YOURS</span>'
            : "";
          return '<div class="pvc-vrow" style="display:flex;justify-content:space-between;gap:10px;align-items:center;border:1.5px solid var(--line,#E6E6E6);border-radius:12px;padding:10px 12px;margin-bottom:8px">' +
            '<div style="min-width:0">' +
              '<div style="font-family:\'Quicksand\',system-ui,sans-serif;font-weight:700;color:var(--purple,#603488);font-size:14px">' + esc(v.name) + badge + '</div>' +
              '<div style="font-size:12px;color:var(--muted,#808080);margin-top:2px">' + esc(v.address || "Address on file") + '</div>' +
            '</div>' +
            '<button type="button" class="hc-btn pvc-pick" data-id="' + escAttr(v.id) + '">Select</button>' +
          '</div>';
        }).join("");
      }

      function paintSelected() {
        var id = selectedVenueId(SCHEDULE_ID);
        if (!id) { selectedEl.innerHTML = ""; return; }
        var pool = venuePool();
        var v = null;
        for (var i = 0; i < pool.length; i++) if (pool[i].id === id) { v = pool[i]; break; }
        if (!v) { selectedEl.innerHTML = ""; return; }
        selectedEl.innerHTML =
          '<div style="background:#E1F0E4;border-radius:12px;padding:10px 12px;font-size:13px;color:#2f7d4f">' +
            '✓ Selected venue: <strong>' + esc(v.name) + '</strong>' +
            (v.address ? ' — ' + esc(v.address) : "") +
            (v.source === "requested" ? ' <em>(new, pending map check)</em>' : "") +
          '</div>';
      }

      function doPick(id) {
        var res = selectForSchedule(SCHEDULE_ID, { mode: "pick", venueId: id });
        if (res.ok) { paintSelected(); try { HC.util.toast("Venue selected ✓"); } catch (e) {} }
        else { try { HC.util.toast(res.message); } catch (e) {} }
      }

      function doAdd(force) {
        addErr.textContent = "";
        dupeEl.innerHTML = "";
        var name = mountEl.querySelector("#pvcName").value;
        var addr = mountEl.querySelector("#pvcAddr").value;
        var res = selectForSchedule(SCHEDULE_ID, {
          mode: "request", name: name, address: addr, forceCreate: !!force
        });
        if (res.ok) {
          paintSelected();
          paintResults();
          addPanel.style.display = "none";
          try { HC.util.toast("Venue added & selected ✓"); } catch (e) {}
          return;
        }
        if (res.duplicate && res.existing) {
          // "this will pop and you can then select this" — offer the existing one.
          dupeEl.innerHTML =
            '<div style="background:var(--purple-tint,#F0E8F4);border-radius:12px;padding:10px 12px;font-size:13px;color:var(--purple,#603488)">' +
              esc(res.message) +
              '<div style="margin-top:8px;display:flex;gap:8px">' +
                '<button type="button" class="hc-btn pvc-usedupe" data-id="' + escAttr(res.existing.id) + '">Use existing venue</button>' +
              '</div>' +
            '</div>';
          return;
        }
        addErr.textContent = res.message || "Could not add that venue.";
      }

      searchEl.addEventListener("input", paintResults);
      mountEl.querySelector("#pvcAddToggle").addEventListener("click", function () {
        addPanel.style.display = addPanel.style.display === "none" ? "block" : "none";
      });
      mountEl.querySelector("#pvcAddSubmit").addEventListener("click", function () { doAdd(false); });

      mountEl.addEventListener("click", function (e) {
        var pick = e.target.closest(".pvc-pick");
        if (pick) { doPick(pick.getAttribute("data-id")); return; }
        var use = e.target.closest(".pvc-usedupe");
        if (use) { doPick(use.getAttribute("data-id")); dupeEl.innerHTML = ""; addPanel.style.display = "none"; return; }
      });

      paintResults();
      paintSelected();
    } catch (e) {
      mountEl.innerHTML = '<p style="color:#9a1f5e">Venue step failed to load: ' +
        esc(e && e.message ? e.message : String(e)) + "</p>";
    }
  }

  /* ============================================================
   * 6. selfTest — exercises the LOGIC and asserts the acceptance
   *    criterion: the venue step lets a provider PICK an existing
   *    venue OR REQUEST a new one. Multiple cases, including the
   *    duplicate-pop behaviour and persistence round-trips.
   * ============================================================ */

  function selfTest() {
    var pass = 0, fail = 0, log = [];
    function check(label, fn) {
      try { fn(); pass += 1; log.push("✓ " + label); }
      catch (e) { fail += 1; log.push("✗ " + label + " — " + (e && e.message ? e.message : String(e))); }
    }

    // Always start each run from a clean store so it is deterministic.
    clearRequests();
    clearSelection();

    // A small, deterministic pool independent of live data for the pure-logic cases.
    function pool() {
      return [
        { id: "v1", name: "Walthamstow Leisure Centre", address: "170 Markhouse Road, London E17 8EP", key: venueKey("Walthamstow Leisure Centre", "E17 8EP"), source: "database", usedBy: ["a"] },
        { id: "v2", name: "Lloyd Park Pavilion", address: "Winns Terrace, London E17 5JW", key: venueKey("Lloyd Park Pavilion", "E17 5JW"), source: "database", usedBy: ["b"] },
        { id: "v3", name: "St Mary's Church Hall", address: "Church End, London E17 9RL", key: venueKey("St Mary's Church Hall", "E17 9RL"), source: "database", usedBy: ["c"] }
      ];
    }

    /* ---- SEARCH the database ---- */
    check("Search finds an existing venue by name", function () {
      var r = searchVenues("lloyd park", pool());
      HC.assert(r.length >= 1, "expected >=1 match for 'lloyd park'");
      HC.assert(r.some(function (v) { return v.id === "v2"; }), "Lloyd Park Pavilion should be found");
    });

    check("Search finds an existing venue by postcode", function () {
      var r = searchVenues("E17 8EP", pool());
      HC.assert(r.some(function (v) { return v.id === "v1"; }), "postcode search should find the Leisure Centre");
    });

    check("Search with no query returns the whole database", function () {
      HC.assert(searchVenues("", pool()).length === 3, "empty query should list all venues");
    });

    /* ---- ACCEPTANCE (A): PICK an existing venue ---- */
    check("Provider can PICK an existing venue from the database", function () {
      var res = pickVenue("v2", pool());
      HC.assert(res.ok === true, "picking an existing venue should succeed");
      HC.assert(res.action === "picked", "action should be 'picked'");
      HC.assert(res.venue && res.venue.name === "Lloyd Park Pavilion", "picked venue should resolve to the record");
    });

    check("Picking a non-existent venue id is rejected", function () {
      var res = pickVenue("nope", pool());
      HC.assert(res.ok === false, "unknown venue id must be rejected");
      HC.assert(res.venue === null, "no venue should be returned");
    });

    /* ---- ACCEPTANCE (B): REQUEST a brand-new venue ---- */
    check("Provider can REQUEST a brand-new venue (added + selected)", function () {
      clearRequests();
      var res = requestVenue("Higham Hill Hub", "Higham Hill Road, London E17 6EB", { pool: pool() });
      HC.assert(res.ok === true, "a genuinely new venue should be accepted");
      HC.assert(res.action === "requested", "action should be 'requested'");
      HC.assert(res.venue && res.venue.name === "Higham Hill Hub", "new venue should be returned as selected");
      HC.assert(res.venue.source === "requested", "new venue should be tagged 'requested'");
      var saved = readRequests();
      HC.assert(saved.length === 1 && saved[0].name === "Higham Hill Hub", "new venue should persist to the store");
    });

    /* ---- Validation of a new-venue request ---- */
    check("A venue request with no name is rejected", function () {
      var res = requestVenue("", "Somewhere, E17", { pool: pool() });
      HC.assert(res.ok === false, "missing name must be rejected");
      HC.assert(!!res.errors.name, "should carry a name error");
    });

    check("A venue request with no address is rejected", function () {
      var res = requestVenue("Nameless Venue", "", { pool: pool() });
      HC.assert(res.ok === false, "missing address must be rejected");
      HC.assert(!!res.errors.address, "should carry an address error");
    });

    /* ---- DUPLICATE detection: "this will pop, select the existing one" ---- */
    check("Requesting a venue that already exists POPS the existing record", function () {
      // Same venue, different punctuation/spacing — must be caught.
      var res = requestVenue("Lloyd Park Pavilion", "Winns Terrace, E17 5JW", { pool: pool() });
      HC.assert(res.ok === false, "a duplicate request must not create a new venue");
      HC.assert(res.duplicate === true, "should be flagged as a duplicate");
      HC.assert(res.existing && res.existing.id === "v2", "should surface the existing venue to select");
    });

    check("Duplicate detection matches on postcode + name despite formatting", function () {
      var res = requestVenue("st marys church hall", "church end london e17 9rl", { pool: pool() });
      HC.assert(res.duplicate === true, "differently-formatted same venue should still pop");
      HC.assert(res.existing.id === "v3", "should resolve to St Mary's");
    });

    check("A duplicate request creates NOTHING in the store", function () {
      clearRequests();
      requestVenue("Lloyd Park Pavilion", "Winns Terrace, E17 5JW", { pool: pool() });
      HC.assert(readRequests().length === 0, "no venue should be persisted for a duplicate");
    });

    check("forceCreate overrides the duplicate guard when the provider insists", function () {
      clearRequests();
      var res = requestVenue("Lloyd Park Pavilion", "Winns Terrace, E17 5JW", { pool: pool(), forceCreate: true });
      HC.assert(res.ok === true, "forceCreate should allow creation");
      clearRequests();
    });

    /* ---- THE STEP: pick OR request, recorded against the schedule ---- */
    check("ACCEPTANCE: the venue step lets a provider PICK an existing venue", function () {
      clearRequests(); clearSelection();
      // Use the real live pool here (no injected pool) to prove end-to-end.
      var live = venuePool();
      HC.assert(live.length >= 1, "live venue database should be non-empty");
      var target = live[0];
      var res = selectForSchedule("sch-pick", { mode: "pick", venueId: target.id });
      HC.assert(res.ok === true, "picking should succeed");
      HC.assert(selectedVenueId("sch-pick") === target.id, "the schedule should record the picked venue");
    });

    check("ACCEPTANCE: the venue step lets a provider REQUEST a new one", function () {
      clearRequests(); clearSelection();
      var res = selectForSchedule("sch-req", {
        mode: "request", name: "Brand New Camp Hall", address: "1 New Road, London E17 0AA"
      });
      HC.assert(res.ok === true, "requesting a new venue should succeed");
      HC.assert(res.venue.source === "requested", "selected venue should be the requested one");
      HC.assert(selectedVenueId("sch-req") === res.venue.id, "the schedule should record the requested venue");
    });

    check("A requested venue becomes pickable in the pool afterwards", function () {
      clearRequests(); clearSelection();
      var made = requestVenue("Reusable Hall", "9 Reuse Street, London E17 1AB");
      HC.assert(made.ok === true, "request should succeed");
      var found = searchVenues("reusable hall");
      HC.assert(found.some(function (v) { return v.id === made.venue.id; }),
        "the newly requested venue should now be searchable/pickable");
      // And picking it works (so a later schedule can reuse it).
      var pick = pickVenue(made.venue.id);
      HC.assert(pick.ok === true, "the requested venue should be pickable");
    });

    check("Requesting the SAME new venue twice pops it the second time (no dup)", function () {
      clearRequests(); clearSelection();
      var first = requestVenue("One Off Hall", "5 Single Lane, London E17 2CD");
      HC.assert(first.ok === true, "first request creates it");
      var second = requestVenue("One Off Hall", "5 Single Lane, London E17 2CD");
      HC.assert(second.ok === false && second.duplicate === true,
        "second identical request should pop as a duplicate");
      HC.assert(second.existing.id === first.venue.id, "the pop should point at the venue just created");
      HC.assert(readRequests().length === 1, "only one venue should exist in the store");
    });

    /* ---- Live-data sanity: the derived database is real + clean ---- */
    check("The venue database is derived from live camp data", function () {
      var db = databaseVenues();
      HC.assert(db.length >= 3, "expected several real venues from live data, got " + db.length);
      HC.assert(db.every(function (v) { return v.name && v.source === "database"; }),
        "every database venue should have a name and be tagged 'database'");
      // Placeholder 'Borough-wide' / 'Multiple ...' venues must not be pickable.
      HC.assert(!db.some(function (v) { return /^borough-wide$/i.test(v.name); }),
        "non-specific placeholders should be excluded from the pickable database");
    });

    // Leave the store as we found it.
    clearRequests();
    clearSelection();

    return { pass: pass, fail: fail, log: log };
  }

  /* ============================================================
   * 7. Register (idempotent + defensive via core).
   * ============================================================ */
  HC.registerFeature({
    id: "provider-venue-create",
    title: "Create / select a venue",
    side: "provider",
    icon: "📍",
    summary: "At the 'Where' step, search the shared venue database and select your camp's venue — or, if it isn't listed, request a new one. Duplicate addresses are caught so you pick the existing venue instead of creating a copy.",
    render: render,
    selfTest: selfTest
  });
})();
