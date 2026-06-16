/* HolidayCamp feature: provider-duplicate-camp
 * ------------------------------------------------------------------
 * Replicates Happity's "duplicate a class listing" behaviour
 * (support article 12132310 — "How can I duplicate a class listing?").
 *
 * Happity flow, faithful to the evidence:
 *   - My classes -> Weekly timetable -> the three-dots menu on the end
 *     column -> click "Duplicate".
 *   - "Once the listing has been duplicated, it will be 'awaiting
 *     review'." The clone opens so you can "add or amend class dates,
 *     amend the week day or class time", then "click save and continue".
 *
 * Side: provider. Framed for SCHOOL-AGE HOLIDAY CAMPS (day / full-week
 * places across the summer weeks), not baby classes.
 *
 * ACCEPTANCE CRITERION (verified by selfTest):
 *   A 'Duplicate' action clones a camp into a NEW DRAFT.
 *
 * What the clone is, faithful to the article:
 *   - A deep, independent copy of the source listing's details (name,
 *     venue, ages, categories, price) — editing the draft never mutates
 *     the original.
 *   - A brand-new unique id (so it is a separate listing).
 *   - status: "draft" with reviewState: "awaiting_review" (Happity's
 *     "awaiting review" state).
 *   - The schedule-specific fields a provider is told to re-set are
 *     CLEARED on the clone: confirmed week dates, week day and class
 *     time. The provider amends these before "save and continue".
 *   - A "(copy)" suffix on the name so the draft is distinguishable in
 *     the timetable.
 *
 * Defensive: nothing here throws at registration time. Persistence is
 * via HC.store only (the provider's saved drafts) — no global
 * localStorage keys are written.
 * ------------------------------------------------------------------ */
(function () {
  "use strict";

  if (typeof window === "undefined" || !window.HC || typeof window.HC.registerFeature !== "function") {
    // Core not present — fail silently rather than throwing.
    return;
  }
  var HC = window.HC;

  var STORE_KEY = "provider_duplicate_drafts"; // namespaced under hc_ by core.

  /* ============================================================
   * 1. Helpers — deep clone, id, store access (all defensive).
   * ============================================================ */

  // Structured deep clone with a safe fallback. We never want a shared
  // reference between an original listing and its duplicate.
  function deepClone(obj) {
    try {
      if (typeof structuredClone === "function") return structuredClone(obj);
    } catch (e) { /* fall through to JSON */ }
    try {
      return JSON.parse(JSON.stringify(obj));
    } catch (e2) {
      return {};
    }
  }

  function newId(baseId) {
    var base = String(baseId == null ? "camp" : baseId);
    var suffix;
    try { suffix = HC.util.uid(); } catch (e) { suffix = "d" + Date.now().toString(36); }
    return base + "--copy-" + suffix;
  }

  function loadDrafts() {
    try {
      var d = HC.store.get(STORE_KEY, []);
      return Array.isArray(d) ? d : [];
    } catch (e) {
      return [];
    }
  }

  function saveDrafts(list) {
    try { return HC.store.set(STORE_KEY, Array.isArray(list) ? list : []); }
    catch (e) { return false; }
  }

  /* ============================================================
   * 2. Core LOGIC — duplicateCamp().
   *
   * Clones a source listing into a new draft object. PURE: it does
   * not persist or mutate the source; the caller decides whether to
   * save the returned draft. This is what selfTest exercises.
   * ============================================================ */

  // Schedule-specific fields the provider is told to re-confirm on the
  // clone ("add or amend class dates, amend the week day or class time").
  var SCHEDULE_FIELDS = ["weeks", "weeksLikely", "weekDay", "classTime", "dates", "sessionTimes"];

  function duplicateCamp(source) {
    if (!source || typeof source !== "object") {
      return { ok: false, reason: "no-source", message: "Pick a listing to duplicate." };
    }

    var clone = deepClone(source);
    if (!clone || typeof clone !== "object") {
      return { ok: false, reason: "clone-failed", message: "Could not copy this listing." };
    }

    // Brand-new, unique id so this is a separate listing.
    clone.id = newId(source.id);

    // "(copy)" suffix so it is distinguishable in the timetable.
    var baseName = (source.name != null ? String(source.name) : "Untitled camp");
    clone.name = baseName + " (copy)";

    // Happity: a freshly duplicated listing is "awaiting review".
    clone.status = "draft";
    clone.reviewState = "awaiting_review";

    // Provenance — which listing this was cloned from, and when.
    clone.duplicatedFrom = source.id != null ? String(source.id) : null;
    clone.duplicatedFromName = baseName;
    clone.createdAt = new Date().toISOString();

    // Clear the schedule fields the provider must re-set before saving.
    for (var i = 0; i < SCHEDULE_FIELDS.length; i++) {
      var f = SCHEDULE_FIELDS[i];
      if (Object.prototype.hasOwnProperty.call(clone, f)) clone[f] = null;
    }
    // A new listing carries no live booking link until re-published.
    if (Object.prototype.hasOwnProperty.call(clone, "booking")) clone.booking = null;

    return {
      ok: true,
      draft: clone,
      message: "Duplicated “" + baseName + "” — the copy is awaiting review."
    };
  }

  // Persisting wrapper used by the UI: duplicate + save into the
  // provider's draft list. Returns the same result, with the draft
  // stored. Still defensive.
  function duplicateAndSave(source) {
    var res = duplicateCamp(source);
    if (!res.ok) return res;
    var drafts = loadDrafts();
    drafts.unshift(res.draft);
    saveDrafts(drafts);
    return res;
  }

  /* ============================================================
   * 3. Live-data source list — the provider's existing listings,
   *    pulled from HC.data so the UI duplicates real camps.
   * ============================================================ */

  function sourceListings() {
    var out = [];
    try {
      var providers = HC.data.providers || [];
      var byId = (HC.data.planner && HC.data.planner.byId) || {};
      for (var i = 0; i < providers.length; i++) {
        var p = providers[i];
        if (!p || !p.id) continue;
        // Merge the directory record with any planner enrichment (price,
        // weeks) so the duplicated listing carries the full picture.
        var merged = {};
        var k;
        for (k in p) { if (Object.prototype.hasOwnProperty.call(p, k)) merged[k] = p[k]; }
        var pl = byId[p.id];
        if (pl && typeof pl === "object") {
          if (pl.price !== undefined) merged.price = pl.price;
          if (pl.weeks !== undefined) merged.weeks = pl.weeks;
          if (pl.weeksLikely !== undefined) merged.weeksLikely = pl.weeksLikely;
        }
        out.push(merged);
      }
    } catch (e) { /* defensive: empty list is fine */ }
    return out;
  }

  /* ============================================================
   * 4. UI — a mock "Weekly timetable" row with the three-dots
   *    menu and a "Duplicate" action, plus a drafts panel.
   * ============================================================ */

  function esc(s) {
    return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
  function escAttr(s) { return esc(s).replace(/"/g, "&quot;"); }

  function priceLabel(listing) {
    try {
      var pr = listing && listing.price;
      if (pr && typeof pr === "object") {
        if (typeof pr.day === "number") return HC.util.money(pr.day) + " / day";
        if (typeof pr.week === "number") return HC.util.money(pr.week) + " / week";
      }
      if (typeof listing.price === "string" && listing.price) return listing.price;
    } catch (e) {}
    return "Price on the listing";
  }

  function render(mountEl) {
    try {
      var camps = sourceListings();
      if (!camps.length) {
        camps = [{
          id: "demo-camp",
          name: "Demo Summer Holiday Camp",
          venue: "Demo venue, E17",
          ageLabel: "5-11",
          categories: ["Multi-activity"],
          price: { day: 36 },
          weeks: [1, 2, 3],
          weekDay: "Mon-Fri",
          classTime: "09:00-15:30"
        }];
      }

      var options = camps.map(function (c, i) {
        return '<option value="' + i + '">' + escAttr(c.name) + "</option>";
      }).join("");

      mountEl.innerHTML =
        '<div style="font-family:\'Nunito Sans\',system-ui,sans-serif;color:var(--text,#383838)">' +
          '<p style="font-size:14px;margin:0 0 14px">Your <strong>Weekly timetable</strong>. ' +
          'Open the three-dots menu on a listing and choose <em>Duplicate</em> to clone it ' +
          'into a new draft (it lands as <strong>awaiting review</strong> so you can amend the ' +
          'dates, week day and class time before saving).</p>' +

          '<label style="display:block;font-weight:700;font-size:13px;margin-bottom:4px">Listing</label>' +
          '<select id="dupCamp" style="width:100%;padding:9px;border:1.5px solid var(--line,#E6E6E6);border-radius:12px;font-size:14px;margin-bottom:12px">' +
            options +
          "</select>" +

          // A single timetable row with the three-dots menu (Happity's "end column").
          '<div id="dupRow" style="display:flex;align-items:center;gap:10px;border:1.5px solid var(--line,#E6E6E6);' +
            'border-radius:14px;padding:12px 14px;margin-bottom:8px;position:relative">' +
            '<div style="flex:1;min-width:0">' +
              '<div id="dupRowName" style="font-family:\'Quicksand\',system-ui,sans-serif;font-weight:700;' +
                'color:var(--purple,#603488);font-size:15px"></div>' +
              '<div id="dupRowMeta" style="font-size:12.5px;color:var(--muted,#808080);margin-top:2px"></div>' +
            "</div>" +
            '<div style="position:relative">' +
              '<button id="dupDots" type="button" aria-haspopup="true" aria-expanded="false" aria-label="More actions" ' +
                'style="background:none;border:1.5px solid var(--line,#E6E6E6);border-radius:10px;cursor:pointer;' +
                'font-size:18px;line-height:1;padding:4px 10px;color:var(--purple,#603488)">⋯</button>' +
              '<div id="dupMenu" role="menu" style="display:none;position:absolute;right:0;top:38px;background:#fff;' +
                'border:1.5px solid var(--line,#E6E6E6);border-radius:12px;box-shadow:0 10px 28px rgba(96,52,136,.18);' +
                'min-width:150px;z-index:5;overflow:hidden">' +
                '<button id="dupAction" role="menuitem" type="button" ' +
                  'style="display:block;width:100%;text-align:left;background:none;border:none;cursor:pointer;' +
                  'font-family:\'Quicksand\',system-ui,sans-serif;font-weight:700;font-size:13.5px;' +
                  'color:var(--purple,#603488);padding:11px 14px">⧉ Duplicate</button>' +
              "</div>" +
            "</div>" +
          "</div>" +

          '<div id="dupMsg" style="font-size:12.5px;min-height:16px;margin:2px 0 14px;color:#2f7d4f"></div>' +

          // Drafts panel — "awaiting review".
          '<div style="display:flex;align-items:center;justify-content:space-between;margin:4px 0 8px">' +
            '<div style="font-family:\'Quicksand\',system-ui,sans-serif;font-weight:700;color:var(--purple,#603488);font-size:14px">' +
              'Drafts awaiting review</div>' +
            '<button id="dupClear" type="button" class="hc-btn hc-btn-ghost" style="padding:5px 11px;font-size:11px">Clear drafts</button>' +
          "</div>" +
          '<div id="dupDrafts"></div>' +
        "</div>";

      var $ = function (id) { return mountEl.querySelector("#" + id); };

      function currentCamp() {
        var idx = Math.max(0, parseInt($("dupCamp").value, 10) || 0);
        return camps[idx] || camps[0];
      }

      function paintRow() {
        var c = currentCamp();
        $("dupRowName").textContent = c.name;
        var bits = [];
        if (c.venue) bits.push(c.venue);
        if (c.ageLabel) bits.push("Ages " + c.ageLabel);
        bits.push(priceLabel(c));
        $("dupRowMeta").textContent = bits.join(" · ");
      }

      function paintDrafts() {
        var drafts = loadDrafts();
        var host = $("dupDrafts");
        if (!drafts.length) {
          host.innerHTML = '<p style="font-size:13px;color:var(--muted,#808080);margin:0">' +
            'No drafts yet. Duplicate a listing to create one.</p>';
          return;
        }
        host.innerHTML = drafts.map(function (d) {
          return '<div style="border:1.5px solid var(--line,#E6E6E6);border-radius:12px;padding:11px 13px;margin-bottom:8px">' +
            '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">' +
              '<span style="font-family:\'Quicksand\',system-ui,sans-serif;font-weight:700;color:var(--purple,#603488);font-size:14px">' +
                esc(d.name) + "</span>" +
              '<span style="font-size:10.5px;font-weight:700;padding:3px 9px;border-radius:999px;' +
                'background:var(--yellow,#FCD400);color:var(--ink,#1A1A1A);text-transform:uppercase;letter-spacing:.3px">Awaiting review</span>' +
            "</div>" +
            '<div style="font-size:12px;color:var(--muted,#808080);margin-top:4px">' +
              'Cloned from ' + esc(d.duplicatedFromName || "a listing") +
              ' · re-add your dates, week day and class time, then save and continue.' +
            "</div>" +
          "</div>";
        }).join("");
      }

      function closeMenu() {
        $("dupMenu").style.display = "none";
        $("dupDots").setAttribute("aria-expanded", "false");
      }

      $("dupCamp").addEventListener("change", function () { paintRow(); closeMenu(); });

      $("dupDots").addEventListener("click", function (e) {
        e.stopPropagation();
        var menu = $("dupMenu");
        var open = menu.style.display === "block";
        menu.style.display = open ? "none" : "block";
        $("dupDots").setAttribute("aria-expanded", open ? "false" : "true");
      });

      // Click-away closes the menu (scoped to this mount).
      mountEl.addEventListener("click", function (e) {
        if (!e.target.closest("#dupDots") && !e.target.closest("#dupMenu")) closeMenu();
      });

      $("dupAction").addEventListener("click", function () {
        closeMenu();
        var res = duplicateAndSave(currentCamp());
        var m = $("dupMsg");
        if (res.ok) {
          m.style.color = "#2f7d4f";
          m.textContent = res.message;
          try { HC.util.toast("Draft created — awaiting review"); } catch (e) {}
        } else {
          m.style.color = "#9a1f5e";
          m.textContent = res.message || "Could not duplicate this listing.";
        }
        paintDrafts();
      });

      $("dupClear").addEventListener("click", function () {
        saveDrafts([]);
        $("dupMsg").textContent = "";
        paintDrafts();
        try { HC.util.toast("Cleared all drafts"); } catch (e) {}
      });

      paintRow();
      paintDrafts();
    } catch (e) {
      mountEl.innerHTML = '<p style="color:#9a1f5e">Timetable preview failed to load: ' +
        esc(e && e.message ? e.message : String(e)) + "</p>";
    }
  }

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

    // A representative source listing (school-age holiday camp).
    function makeSource() {
      return {
        id: "summer-fun-camp",
        name: "Summer Fun Holiday Camp",
        venue: "St Mary's Hall, Walthamstow E17",
        ageLabel: "5-11",
        ageMin: 5,
        ageMax: 11,
        categories: ["Multi-activity", "Full day"],
        price: { day: 36, week: 160 },
        weeks: [1, 2, 3, 4],
        weekDay: "Mon-Fri",
        classTime: "09:00-15:30",
        booking: "https://example.com/book/summer-fun",
        source: { label: "Provider page", url: "https://example.com" }
      };
    }

    // --- ACCEPTANCE: Duplicate clones a camp into a NEW DRAFT. ---
    check("Duplicate clones a listing into a new draft", function () {
      var src = makeSource();
      var r = duplicateCamp(src);
      HC.assert(r.ok === true, "duplicate should succeed");
      HC.assert(r.draft && typeof r.draft === "object", "a draft object should be returned");
      HC.assert(r.draft.status === "draft", "clone status should be 'draft', got " + r.draft.status);
    });

    check("Duplicated draft is 'awaiting review' (Happity state)", function () {
      var r = duplicateCamp(makeSource());
      HC.assert(r.draft.reviewState === "awaiting_review",
        "expected reviewState 'awaiting_review', got " + r.draft.reviewState);
    });

    check("Clone gets a NEW, unique id (separate listing)", function () {
      var src = makeSource();
      var r = duplicateCamp(src);
      HC.assert(r.draft.id !== src.id, "clone id must differ from source id");
      // Two duplications of the same source yield two distinct ids.
      var a = duplicateCamp(src), b = duplicateCamp(src);
      HC.assert(a.draft.id !== b.draft.id, "each duplicate must get its own id");
      HC.assert(/copy/i.test(r.draft.id), "clone id should mark it as a copy, got " + r.draft.id);
    });

    check("Clone name carries a '(copy)' suffix", function () {
      var src = makeSource();
      var r = duplicateCamp(src);
      HC.assert(r.draft.name === "Summer Fun Holiday Camp (copy)",
        "expected name to gain '(copy)', got " + r.draft.name);
    });

    check("Clone copies the editable details (venue, ages, price)", function () {
      var src = makeSource();
      var r = duplicateCamp(src);
      HC.assert(r.draft.venue === src.venue, "venue should be carried over");
      HC.assert(r.draft.ageLabel === src.ageLabel, "age label should be carried over");
      HC.assert(r.draft.price && r.draft.price.day === 36, "day price should be carried over");
    });

    // --- DEEP-CLONE INDEPENDENCE: editing the draft must not touch the source. ---
    check("Draft is a DEEP copy — editing it never mutates the original", function () {
      var src = makeSource();
      var r = duplicateCamp(src);
      // Mutate nested structures on the draft.
      r.draft.price.day = 99;
      r.draft.categories.push("Tampered");
      r.draft.source.url = "https://tampered.example";
      HC.assert(src.price.day === 36, "source day price must be untouched, got " + src.price.day);
      HC.assert(src.categories.indexOf("Tampered") === -1, "source categories must be untouched");
      HC.assert(src.source.url === "https://example.com", "nested source object must be untouched");
    });

    // --- SCHEDULE FIELDS the provider must re-set are CLEARED on the clone. ---
    check("Schedule fields (weeks, week day, class time) are cleared for re-entry", function () {
      var src = makeSource();
      var r = duplicateCamp(src);
      HC.assert(r.draft.weeks === null, "weeks should be cleared, got " + JSON.stringify(r.draft.weeks));
      HC.assert(r.draft.weekDay === null, "weekDay should be cleared, got " + r.draft.weekDay);
      HC.assert(r.draft.classTime === null, "classTime should be cleared, got " + r.draft.classTime);
      HC.assert(r.draft.booking === null, "live booking link should be cleared on a new draft");
    });

    check("Clone records its provenance (duplicatedFrom)", function () {
      var src = makeSource();
      var r = duplicateCamp(src);
      HC.assert(r.draft.duplicatedFrom === src.id,
        "duplicatedFrom should be the source id, got " + r.draft.duplicatedFrom);
      HC.assert(r.draft.duplicatedFromName === src.name, "duplicatedFromName should record the original name");
      HC.assert(typeof r.draft.createdAt === "string" && r.draft.createdAt.length > 0,
        "createdAt timestamp should be set");
    });

    // --- DEFENSIVE: bad input is rejected, not thrown. ---
    check("Duplicating nothing is rejected (not thrown)", function () {
      var r = duplicateCamp(null);
      HC.assert(r.ok === false, "null source must be rejected");
      HC.assert(r.reason === "no-source", "reason should be 'no-source', got " + r.reason);
    });

    check("A nameless listing still duplicates with a safe default name", function () {
      var r = duplicateCamp({ id: "x" });
      HC.assert(r.ok === true, "should still duplicate");
      HC.assert(r.draft.name === "Untitled camp (copy)", "expected safe default name, got " + r.draft.name);
    });

    // --- PERSISTENCE: duplicateAndSave stores the draft via HC.store. ---
    check("duplicateAndSave persists the draft into HC.store", function () {
      // Snapshot then clear so the test is independent of prior runs.
      var before = loadDrafts();
      saveDrafts([]);
      try {
        var r = duplicateAndSave(makeSource());
        HC.assert(r.ok === true, "save-and-duplicate should succeed");
        var stored = loadDrafts();
        HC.assert(stored.length === 1, "exactly one draft should be stored, got " + stored.length);
        HC.assert(stored[0].id === r.draft.id, "stored draft should be the one returned");
        HC.assert(stored[0].reviewState === "awaiting_review", "stored draft should be awaiting review");
        // A second duplicate prepends, leaving two distinct drafts.
        duplicateAndSave(makeSource());
        var both = loadDrafts();
        HC.assert(both.length === 2, "two duplicates should yield two drafts, got " + both.length);
        HC.assert(both[0].id !== both[1].id, "the two stored drafts must have distinct ids");
      } finally {
        // Restore the provider's real drafts so the test leaves no residue.
        saveDrafts(before);
      }
    });

    // --- LIVE-DATA SANITY: real listings can be duplicated. ---
    check("A real listing from HC.data duplicates into an awaiting-review draft", function () {
      var listings = sourceListings();
      HC.assert(listings.length >= 1, "expected >=1 source listing from HC.data, got " + listings.length);
      var r = duplicateCamp(listings[0]);
      HC.assert(r.ok === true, "a live listing should duplicate");
      HC.assert(r.draft.status === "draft" && r.draft.reviewState === "awaiting_review",
        "live clone should be a draft awaiting review");
      HC.assert(r.draft.id !== listings[0].id, "live clone must get a new id");
    });

    return { pass: pass, fail: fail, log: log };
  }

  /* ============================================================
   * 6. Register (idempotent + defensive via core).
   * ============================================================ */
  HC.registerFeature({
    id: "provider-duplicate-camp",
    title: "Duplicate a listing",
    side: "provider",
    icon: "⧉",
    summary: "From the weekly timetable, open the three-dots menu and Duplicate a listing to clone it into a new draft. The copy lands 'awaiting review' so you can amend dates, week day and class time before saving — no need to build from scratch.",
    render: render,
    selfTest: selfTest
  });
})();
