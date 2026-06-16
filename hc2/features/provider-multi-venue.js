/* HolidayCamp feature — provider-multi-venue
 *
 * One activity across multiple venues = SEPARATE listings  (provider side)
 *
 * Replicates Happity support article 5827801 ("Can I set up one listing with
 * multiple venues?"). The verbatim Happity rule:
 *
 *   "You will need to list each class individually that differs by time/day,
 *    age or location. Happity search results are displayed according to
 *    location using a postcode search so it is really important that you list
 *    the specific venues for each activity that you run."
 *
 * Evidence: 5827801 (the multi-venue rule) and 5827735 (each listing/class has
 * its own register & booking notifications — i.e. listings are the bookable
 * unit, so a venue split is a real, separately-bookable thing).
 *
 * Framed for SCHOOL-AGE HOLIDAY CAMPS: a provider designs ONE camp programme
 * (e.g. "Summer Multi-Sports Camp", ages 5-11, 9am-3pm) and runs it at several
 * E17 venues. Because parents search by postcode, HolidayCamp does NOT publish
 * a single listing with a venue dropdown — it EXPANDS the programme into one
 * distinct, postcode-tagged, separately-bookable listing per venue. Two camps
 * at the same venue that differ by day/age/time also split (matching the
 * "differs by time/day, age or location" rule).
 *
 * ACCEPTANCE CRITERION (asserted in selfTest):
 *   Adding a second venue creates a DISTINCT listing for that location.
 *
 * Self-contained, defensive, no imports/exports. Calls HC.registerFeature.
 */
(function () {
  "use strict";

  // Defensive: never throw at module load if HC isn't present.
  if (typeof window === "undefined" || !window.HC || typeof window.HC.registerFeature !== "function") {
    if (typeof console !== "undefined" && console.warn) {
      console.warn("[HC] provider-multi-venue: HC core not found; skipping registration.");
    }
    return;
  }

  var HC = window.HC;

  var STORE_KEY = "provider_multi_venue_programmes"; // persisted draft programmes

  /* ---------------- helpers ---------------- */

  function asText(v) {
    return typeof v === "string" ? v : (v == null ? "" : String(v));
  }

  function slugify(s) {
    return asText(s).toLowerCase()
      .replace(/&/g, " and ")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "item";
  }

  // Pull a UK-ish postcode out of an address string. Returns "" if none found.
  // Used to tag each listing with the postcode parents actually search by.
  function extractPostcode(address) {
    var s = asText(address).toUpperCase();
    // Full outward+inward (e.g. E17 5QX), tolerant of optional space.
    var full = s.match(/\b([A-Z]{1,2}\d[A-Z\d]?)\s?(\d[A-Z]{2})\b/);
    if (full) return full[1] + " " + full[2];
    // Outward only (e.g. E17, E4, N15) as a fallback.
    var out = s.match(/\b([A-Z]{1,2}\d[A-Z\d]?)\b/);
    return out ? out[1] : "";
  }

  /* ---------------- pure logic (testable, DOM-free) ---------------- */
  /*
   * A "programme" is the ONE activity a provider designs once:
   *   { name, ageMin, ageMax, time, price, venues: [ {name, address, day?, ...} ] }
   *
   * expandToListings(programme) implements the Happity rule: it returns ONE
   * listing per venue (and per day/age/time variant) — never a single listing
   * carrying many venues. Each listing is independently bookable and carries
   * the postcode used for location search.
   */

  // Normalise one venue entry into a canonical shape.
  function normaliseVenue(v) {
    var o = (v && typeof v === "object") ? v : { name: asText(v) };
    var name = asText(o.name) || asText(o.venue) || "Unnamed venue";
    var address = asText(o.address) || asText(o.addr) || "";
    return {
      name: name,
      address: address,
      postcode: asText(o.postcode) || extractPostcode(address) || extractPostcode(name),
      // Per-venue overrides — the article's "differs by time/day, age" axes.
      day: asText(o.day),
      time: asText(o.time),
      ageMin: (o.ageMin === 0 || o.ageMin) ? Number(o.ageMin) : null,
      ageMax: (o.ageMax === 0 || o.ageMax) ? Number(o.ageMax) : null
    };
  }

  // Normalise a whole programme (the single activity the provider designs once).
  function normaliseProgramme(p) {
    var src = (p && typeof p === "object") ? p : {};
    var venuesIn = Array.isArray(src.venues) ? src.venues : [];
    return {
      id: asText(src.id) || "",
      name: asText(src.name) || "Untitled holiday camp",
      ageMin: (src.ageMin === 0 || src.ageMin) ? Number(src.ageMin) : null,
      ageMax: (src.ageMax === 0 || src.ageMax) ? Number(src.ageMax) : null,
      time: asText(src.time),
      day: asText(src.day),
      price: (src.price === 0 || src.price) ? Number(src.price) : null,
      venues: venuesIn.map(normaliseVenue)
    };
  }

  // THE CORE RULE. Expand a single programme into one distinct, bookable
  // listing per venue. Each listing inherits programme defaults, overlays any
  // per-venue overrides, and gets its own id, slug and postcode. Listings that
  // differ by location/day/age/time are therefore distinct rows — exactly what
  // Happity requires for postcode search.
  function expandToListings(programme) {
    var p = normaliseProgramme(programme);
    var listings = [];
    var seen = {}; // de-dupe identical venue+variant rows defensively

    for (var i = 0; i < p.venues.length; i++) {
      var v = p.venues[i];
      var ageMin = (v.ageMin === 0 || v.ageMin != null) ? v.ageMin : p.ageMin;
      var ageMax = (v.ageMax === 0 || v.ageMax != null) ? v.ageMax : p.ageMax;
      var time = v.time || p.time;
      var day = v.day || p.day;

      // A listing's identity = programme + venue + the variant axes that the
      // article says force a new listing (time/day, age, location).
      var variantKey = [
        slugify(p.name),
        slugify(v.name + "|" + v.postcode),
        day, time, ageMin, ageMax
      ].join("::");
      if (seen[variantKey]) continue;
      seen[variantKey] = true;

      var listing = {
        id: (function () { try { return HC.util.uid(); } catch (e) { return "lst_" + i + "_" + Date.now(); } })(),
        programmeId: p.id || slugify(p.name),
        programmeName: p.name,
        slug: slugify(p.name) + "--" + slugify(v.name + " " + v.postcode),
        // The location fields that make this a DISTINCT listing.
        venueName: v.name,
        address: v.address,
        postcode: v.postcode,
        // Bookable details (per-venue override wins, else programme default).
        day: day,
        time: time,
        ageMin: ageMin,
        ageMax: ageMax,
        ageLabel: (ageMin != null && ageMax != null) ? (ageMin + "-" + ageMax) : "",
        price: p.price,
        // Each listing has its own register (article 5827735).
        register: [],
        bookings: 0
      };
      listings.push(listing);
    }
    return listings;
  }

  // Convenience: take a programme with N venues, "add" one more, and return the
  // newly created listings count delta. Used to prove the acceptance criterion.
  function addVenueAndExpand(programme, newVenue) {
    var p = normaliseProgramme(programme);
    var before = expandToListings(p);
    var next = normaliseProgramme(p);
    next.venues = next.venues.concat([normaliseVenue(newVenue)]);
    var after = expandToListings(next);
    return {
      before: before,
      after: after,
      added: after.length - before.length,
      newListings: after.slice(before.length)
    };
  }

  /* ---------------- persistence (HC.store only) ---------------- */

  function readProgrammes() {
    try {
      var s = HC.store.get(STORE_KEY, []);
      return Array.isArray(s) ? s : [];
    } catch (e) { return []; }
  }
  function writeProgrammes(list) {
    try { return HC.store.set(STORE_KEY, Array.isArray(list) ? list : []); }
    catch (e) { return false; }
  }
  function saveProgramme(programme) {
    var p = normaliseProgramme(programme);
    if (!p.id) p.id = slugify(p.name) + "-" + (function () { try { return HC.util.uid(); } catch (e) { return Date.now(); } })();
    var rec = { id: p.id, programme: p, listings: expandToListings(p), at: Date.now() };
    var list = readProgrammes();
    list.unshift(rec);
    if (list.length > 30) list = list.slice(0, 30);
    writeProgrammes(list);
    return rec;
  }

  /* ---------------- seed a realistic programme from live data ---------------- */
  // Find a real provider whose address names more than one site, so the demo
  // mirrors an actual E17 camp running one programme across several venues.
  function seedProgramme() {
    var prog = {
      name: "Summer Multi-Sports Camp",
      ageMin: 5, ageMax: 11, time: "9:00am-3:00pm", price: 32,
      venues: [
        { name: "Whittingham Primary Academy", address: "340 Higham Hill Road, Walthamstow, E17 5QX" },
        { name: "Handsworth Primary School", address: "Handsworth Avenue, Highams Park, E4 9PJ" }
      ]
    };
    try {
      var providers = HC.data.providers || [];
      // Look for a provider whose address has two postcodes / a semicolon list.
      for (var i = 0; i < providers.length; i++) {
        var addr = asText(providers[i].address);
        var pcs = (addr.toUpperCase().match(/\b[A-Z]{1,2}\d[A-Z\d]?\s?\d[A-Z]{2}\b/g) || []);
        if (pcs.length >= 2) {
          var parts = addr.split(/;|\band\b/i).map(function (s) { return s.trim(); }).filter(Boolean);
          if (parts.length >= 2) {
            prog.name = (providers[i].name || prog.name).replace(/holiday.*$/i, "").trim() + " — Holiday Camp";
            prog.venues = parts.slice(0, 3).map(function (part) {
              return { name: part, address: part };
            });
          }
          break;
        }
      }
    } catch (e) { /* fall back to the default seed */ }
    return prog;
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

  function listingCard(listing) {
    return '<div style="border:1.5px solid var(--line,#E6E6E6);border-radius:14px;padding:12px 14px;background:#fff;margin:0 0 10px">' +
      '<div style="display:flex;justify-content:space-between;gap:10px;align-items:baseline">' +
        '<div style="font-family:Quicksand,system-ui,sans-serif;font-weight:700;color:var(--purple,#603488);font-size:15px">' +
          esc(listing.venueName) + "</div>" +
        '<span style="font-family:Quicksand,system-ui,sans-serif;font-weight:700;font-size:12px;padding:3px 10px;' +
          'border-radius:999px;background:var(--purple-tint,#F0E8F4);color:var(--purple,#603488)">' +
          esc(listing.postcode || "postcode?") + "</span>" +
      "</div>" +
      '<div style="font-size:13px;color:var(--text,#383838);margin-top:4px">' + esc(listing.address || "Address to confirm") + "</div>" +
      '<div style="font-size:12.5px;color:var(--muted,#808080);margin-top:6px">' +
        esc(listing.programmeName) +
        (listing.ageLabel ? " · ages " + esc(listing.ageLabel) : "") +
        (listing.time ? " · " + esc(listing.time) : "") +
        (listing.price != null ? " · " + esc(money(listing.price)) : "") +
      "</div>" +
      '<div style="font-size:11.5px;color:var(--magenta,#F82488);font-weight:700;margin-top:6px">' +
        "Distinct listing · own postcode search &amp; booking register</div>" +
    "</div>";
  }

  function money(n) {
    try { return HC.util.money(n); } catch (e) { return "£" + n; }
  }

  function render(mountEl) {
    try {
      if (!mountEl) return;
      mountEl.innerHTML = "";

      var prog = seedProgramme();

      var intro = el("div", null,
        '<p style="font-size:14px;color:var(--text,#383838);margin:0 0 6px">' +
          "Running <strong>one camp programme across several venues</strong>? HolidayCamp doesn't " +
          "bundle them into a single listing with a venue dropdown. Because parents search by " +
          "<strong>postcode</strong>, each venue becomes its own <strong>distinct listing</strong> — so your camp " +
          "shows up for families searching near every site you run.</p>" +
        '<p style="font-size:12.5px;color:var(--muted,#808080);margin:0 0 4px;font-style:italic">' +
          "Mirrors Happity: “you will need to list each class individually that differs by time/day, age or location.”</p>");
      mountEl.appendChild(intro);

      // Programme summary (the single activity, designed once).
      var head = el("div", { style: "border:1.5px dashed var(--purple-tint,#F0E8F4);border-radius:14px;padding:12px 14px;background:#FAF7FC;margin:10px 0 12px" });
      head.innerHTML =
        '<div style="font-family:Quicksand,system-ui,sans-serif;font-weight:700;color:var(--purple,#603488)">' +
          "Your programme (designed once)</div>" +
        '<div style="font-size:13.5px;color:var(--text,#383838);margin-top:4px">' +
          esc(prog.name) +
          (prog.ageMin != null ? " · ages " + esc(prog.ageMin + "-" + prog.ageMax) : "") +
          (prog.time ? " · " + esc(prog.time) : "") +
          (prog.price != null ? " · " + esc(money(prog.price)) : "") +
        "</div>";
      mountEl.appendChild(head);

      // Live count + listings host.
      var countLine = el("div", { style: "font-family:Quicksand,system-ui,sans-serif;font-weight:700;color:var(--magenta,#F82488);margin:0 0 8px" });
      mountEl.appendChild(countLine);

      var listHost = el("div", null, "");
      mountEl.appendChild(listHost);

      // Add-a-venue control — the interaction behind the acceptance criterion.
      var adder = el("div", { style: "border-top:1px solid var(--line,#E6E6E6);padding-top:12px;margin-top:6px" });
      adder.innerHTML =
        '<div style="font-family:Quicksand,system-ui,sans-serif;font-weight:700;color:var(--purple,#603488);margin-bottom:8px">' +
          "Add another venue</div>" +
        '<input id="mvName" placeholder="Venue name (e.g. Forest School Hall)" ' +
          'style="width:100%;box-sizing:border-box;padding:8px 10px;border:1.5px solid var(--line,#E6E6E6);border-radius:10px;margin:0 0 8px;font-size:13px">' +
        '<input id="mvAddr" placeholder="Address incl. postcode (e.g. Hale End Rd, E4 9PT)" ' +
          'style="width:100%;box-sizing:border-box;padding:8px 10px;border:1.5px solid var(--line,#E6E6E6);border-radius:10px;margin:0 0 10px;font-size:13px">' +
        '<button class="hc-btn" id="mvAdd" type="button">+ Add venue &amp; create listing</button>';
      mountEl.appendChild(adder);

      function repaint() {
        var listings = expandToListings(prog);
        countLine.innerHTML = listings.length + " distinct listing" + (listings.length === 1 ? "" : "s") +
          " from " + prog.venues.length + " venue" + (prog.venues.length === 1 ? "" : "s");
        listHost.innerHTML = listings.map(listingCard).join("") ||
          '<p style="color:var(--muted,#808080);font-size:13px">No venues yet — add one to create your first listing.</p>';
      }

      function addVenue() {
        try {
          var name = (adder.querySelector("#mvName") || {}).value;
          var addr = (adder.querySelector("#mvAddr") || {}).value;
          if (!asText(name).trim() && !asText(addr).trim()) {
            try { HC.util.toast("Enter a venue name or address first"); } catch (e) {}
            return;
          }
          var beforeCount = expandToListings(prog).length;
          prog.venues.push(normaliseVenue({ name: name, address: addr }));
          var afterCount = expandToListings(prog).length;
          repaint();
          var added = afterCount - beforeCount;
          try {
            HC.util.toast(added > 0
              ? "Created a distinct listing for " + (asText(name).trim() || "the new venue")
              : "That venue already has a listing");
          } catch (e) {}
          var ni = adder.querySelector("#mvName"); if (ni) ni.value = "";
          var ai = adder.querySelector("#mvAddr"); if (ai) ai.value = "";
        } catch (e) {
          try { HC.util.toast("Could not add venue"); } catch (e2) {}
        }
      }

      var addBtn = adder.querySelector("#mvAdd");
      if (addBtn) addBtn.addEventListener("click", addVenue);

      repaint();
    } catch (e) {
      try {
        mountEl.innerHTML = '<p style="color:#9a1f5e">Multi-venue feature failed to render: ' +
          esc(e && e.message ? e.message : String(e)) + "</p>";
      } catch (e2) { /* give up quietly */ }
    }
  }

  /* ---------------- selfTest ---------------- */

  function selfTest() {
    var pass = 0, fail = 0, log = [];
    function check(label, fn) {
      try { fn(); pass += 1; log.push("✓ " + label); }
      catch (e) { fail += 1; log.push("✗ " + label + " — " + (e && e.message ? e.message : String(e))); }
    }

    var baseProgramme = {
      name: "Summer Multi-Sports Camp",
      ageMin: 5, ageMax: 11, time: "9:00am-3:00pm", price: 32,
      venues: [
        { name: "Whittingham Primary Academy", address: "340 Higham Hill Road, Walthamstow, E17 5QX" }
      ]
    };

    // ===== ACCEPTANCE CRITERION =====
    // Adding a second venue creates a DISTINCT listing for that location.
    check("ACCEPTANCE: adding a second venue creates a distinct listing for that location", function () {
      var res = addVenueAndExpand(baseProgramme,
        { name: "Handsworth Primary School", address: "Handsworth Avenue, Highams Park, E4 9PJ" });
      HC.assert(res.before.length === 1, "one venue -> one listing, got " + res.before.length);
      HC.assert(res.after.length === 2, "two venues -> two listings, got " + res.after.length);
      HC.assert(res.added === 1, "adding a venue must add exactly one listing, added " + res.added);
      var newOne = res.newListings[0];
      HC.assert(newOne && newOne.venueName === "Handsworth Primary School",
        "the new listing must be for the new venue");
      HC.assert(newOne.postcode === "E4 9PJ", "new listing carries the new venue's postcode, got " + newOne.postcode);
      // The two listings must be genuinely DISTINCT (different ids, slugs, postcodes).
      HC.assert(res.after[0].id !== res.after[1].id, "listings must have distinct ids");
      HC.assert(res.after[0].slug !== res.after[1].slug, "listings must have distinct slugs");
      HC.assert(res.after[0].postcode !== res.after[1].postcode, "listings must have distinct postcodes");
    });

    // ===== One listing is NOT a single row carrying many venues =====
    check("A 3-venue programme expands to 3 separate listings (not 1 with a dropdown)", function () {
      var p = {
        name: "Easter Forest Camp", ageMin: 6, ageMax: 12,
        venues: [
          { name: "Lloyd Park Centre", address: "Lloyd Park, E17 4PP" },
          { name: "Higham Hill Centre", address: "Higham Hill Rd, E17 5RB" },
          { name: "Leyton Hall", address: "High Rd Leyton, E10 5QN" }
        ]
      };
      var listings = expandToListings(p);
      HC.assert(listings.length === 3, "expected 3 listings, got " + listings.length);
      var postcodes = listings.map(function (l) { return l.postcode; });
      HC.assert(postcodes.indexOf("E17 4PP") !== -1 && postcodes.indexOf("E17 5RB") !== -1 &&
        postcodes.indexOf("E10 5QN") !== -1, "each venue's postcode is represented once");
    });

    // ===== Each listing inherits the shared programme but is independent =====
    check("Each venue listing inherits programme age/time/price yet is its own bookable row", function () {
      var listings = expandToListings({
        name: "Coding Camp", ageMin: 8, ageMax: 14, time: "10-2", price: 40,
        venues: [
          { name: "Hub A", address: "A St, E17 6AA" },
          { name: "Hub B", address: "B St, E11 1BB" }
        ]
      });
      for (var i = 0; i < listings.length; i++) {
        HC.assert(listings[i].ageLabel === "8-14", "age inherited from programme");
        HC.assert(listings[i].price === 40, "price inherited from programme");
        HC.assert(listings[i].programmeName === "Coding Camp", "carries shared programme name");
        HC.assert(Array.isArray(listings[i].register), "each listing has its own register (article 5827735)");
      }
    });

    // ===== Per-venue overrides: a venue that differs by age/time/day still splits =====
    check("A venue with a different age range produces its own distinct listing", function () {
      var listings = expandToListings({
        name: "Drama Camp", ageMin: 7, ageMax: 11,
        venues: [
          { name: "Studio 1", address: "S1, E17 7AA" },
          { name: "Studio 2", address: "S2, E17 8BB", ageMin: 12, ageMax: 16 }
        ]
      });
      HC.assert(listings.length === 2, "two venues -> two listings");
      HC.assert(listings[0].ageLabel === "7-11", "venue 1 uses programme ages");
      HC.assert(listings[1].ageLabel === "12-16", "venue 2 override age range applied");
      HC.assert(listings[0].slug !== listings[1].slug, "distinct slugs for distinct venues");
    });

    // ===== Postcode extraction (the field parents search by) =====
    check("Postcode is extracted from the venue address for location search", function () {
      HC.assert(extractPostcode("340 Higham Hill Road, Walthamstow, E17 5QX") === "E17 5QX",
        "full postcode extracted");
      HC.assert(extractPostcode("Handsworth Avenue, E4 9PJ") === "E4 9PJ", "short-area postcode extracted");
      HC.assert(extractPostcode("Hale End Rd E4") === "E4", "outward-only fallback");
      HC.assert(extractPostcode("no postcode here") === "", "no false positive when absent");
    });

    // ===== De-dupe: adding the SAME venue twice does not double-list =====
    check("Re-adding the identical venue does not create a duplicate listing", function () {
      var p = {
        name: "Tennis Camp", ageMin: 5, ageMax: 10,
        venues: [
          { name: "Court Lane", address: "Court Lane, E17 9ZZ" },
          { name: "Court Lane", address: "Court Lane, E17 9ZZ" }
        ]
      };
      var listings = expandToListings(p);
      HC.assert(listings.length === 1, "identical venue+variant should collapse to one listing, got " + listings.length);
    });

    // ===== Same venue but a different DAY is a distinct listing (article axis) =====
    check("Same venue on a different day yields a separate listing", function () {
      var p = {
        name: "Football Camp", ageMin: 6, ageMax: 12, time: "9-12",
        venues: [
          { name: "Pitch", address: "Pitch Rd, E17 1AA", day: "Mon" },
          { name: "Pitch", address: "Pitch Rd, E17 1AA", day: "Tue" }
        ]
      };
      var listings = expandToListings(p);
      HC.assert(listings.length === 2, "different day -> different listing, got " + listings.length);
      HC.assert(listings[0].day === "Mon" && listings[1].day === "Tue", "each carries its own day");
    });

    // ===== Defensive: garbage / empty input must not throw =====
    check("Garbage / empty programmes are handled and never throw", function () {
      var bad = [null, undefined, {}, 42, "", [], { venues: "nope" }, { venues: [null, 7, {}] }];
      for (var i = 0; i < bad.length; i++) {
        var listings = expandToListings(bad[i]);
        HC.assert(Array.isArray(listings), "must always return an array for input #" + i);
      }
      // A programme with no venues yields zero listings (nothing to be found by).
      HC.assert(expandToListings({ name: "Empty", venues: [] }).length === 0,
        "no venues -> no listings");
    });

    // ===== Persistence via HC.store (never raw localStorage) =====
    check("saveProgramme persists the programme and its expanded listings", function () {
      var before = readProgrammes().length;
      var rec = saveProgramme({
        name: "Persistence Test Camp", ageMin: 5, ageMax: 11,
        venues: [
          { name: "Venue One", address: "One St, E17 2AA" },
          { name: "Venue Two", address: "Two St, E11 3BB" }
        ]
      });
      HC.assert(rec && Array.isArray(rec.listings) && rec.listings.length === 2,
        "saved record should expand to 2 listings");
      var after = readProgrammes();
      HC.assert(after.length === before + 1, "programme should be persisted (len " + after.length + ")");
      HC.assert(after[0].listings.length === 2, "persisted listings round-trip");
      // clean up so repeated test runs stay stable
      writeProgrammes(after.slice(1));
    });

    return { pass: pass, fail: fail, log: log };
  }

  /* ---------------- register ---------------- */

  HC.registerFeature({
    id: "provider-multi-venue",
    title: "One activity, multiple venues = separate listings",
    side: "provider",
    icon: "📍",
    summary: "Design one camp programme, run it at several venues — HolidayCamp expands it into one distinct, postcode-tagged, separately-bookable listing per location, so families find you near every site (mirrors Happity's per-venue listing rule).",
    render: render,
    selfTest: selfTest
  });
})();
