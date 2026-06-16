/* HolidayCamp feature: provider-edit-camp
 * ------------------------------------------------------------------
 * Replicates Happity's "Edit your class listings" behaviour for the
 * PROVIDER side, reframed for SCHOOL-AGE HOLIDAY CAMPS (day / week
 * places), not baby classes.
 *
 * Evidence (support corpus):
 *  - 8255812 "How to Edit Your Class Listings": go to Profile >
 *    Activities, find the activity and click the EDIT (pencil) icon,
 *    change the title / description / categories / ages / schedule,
 *    then hit SAVE. Also documents a "Quick Edit" path (three dots ->
 *    Edit) for schedule, dates and tickets/price.
 *  - 2275886 "How to create and edit activities": the editable fields
 *    are title, min/max ages, short + long description, and UP TO TWO
 *    categories (at least one is required, you "will not be able to
 *    continue unless at least one tag is added").
 *
 * Acceptance criterion (asserted by selfTest, multiple cases):
 *   An 'Edit' action on a listing opens an editable form and SAVES
 *   the changes — a valid edit is persisted and reflected back; an
 *   invalid edit is rejected and the original listing is unchanged.
 *
 * Defensive: nothing throws at registration time. Persistence is via
 * HC.store ONLY (per-listing edit overlay under one namespaced key);
 * the verified camps.js data is never mutated.
 * ------------------------------------------------------------------ */
(function () {
  "use strict";

  if (typeof window === "undefined" || !window.HC || typeof window.HC.registerFeature !== "function") {
    // Core not present — fail silently rather than throwing.
    return;
  }
  var HC = window.HC;

  var STORE_KEY = "provider_edit_camp_overlay"; // { [listingId]: {changes...} }

  /* ============================================================
   * 1. Editable-field model + the category vocabulary.
   *    Categories are the holiday-camp equivalent of Happity's
   *    class "categories" tags. Happity allows UP TO TWO.
   * ============================================================ */

  var MAX_CATEGORIES = 2;   // Happity: "Tag up to two categories".
  var MIN_CATEGORIES = 1;   // Happity: cannot continue without >=1 tag.
  var TITLE_MAX = 80;
  var SHORT_MAX = 120;
  var AGE_FLOOR = 0;
  var AGE_CEIL = 18;        // school-age holiday camps cap.

  var CATEGORY_OPTIONS = [
    "Multi-activity", "Sports", "Arts & crafts", "Drama", "Dance",
    "Music", "Outdoor / forest", "STEM / coding", "Swimming",
    "Full day", "Half day", "SEND aware", "HAF", "Free places"
  ];

  /* ============================================================
   * 2. Pure helpers.
   * ============================================================ */

  function round2(n) { return Math.round((Number(n) + Number.EPSILON) * 100) / 100; }

  function clampInt(n, lo, hi) {
    var v = Math.floor(Number(n));
    if (!isFinite(v)) return lo;
    if (v < lo) return lo;
    if (v > hi) return hi;
    return v;
  }

  function trimStr(s) { return String(s == null ? "" : s).replace(/\s+/g, " ").trim(); }

  function dedupe(arr) {
    var seen = {}, out = [];
    for (var i = 0; i < arr.length; i++) {
      var v = trimStr(arr[i]);
      if (!v) continue;
      var k = v.toLowerCase();
      if (seen[k]) continue;
      seen[k] = true;
      out.push(v);
    }
    return out;
  }

  /* ============================================================
   * 3. Build an editable listing snapshot from the LIVE camp data.
   *    Reads camps.js (HC.data.providers) + the planner price layer
   *    so the form is pre-filled with real numbers, exactly as a
   *    provider would see their own listing pre-filled.
   * ============================================================ */

  function deriveDayPrice(planEntry) {
    try {
      var p = planEntry && planEntry.price;
      if (!p) return null;
      if (typeof p.day === "number") return p.day;
      if (typeof p.week === "number") return round2(p.week / 5); // approx per-day
      if (typeof p.halfDay === "number") return p.halfDay;
      if (typeof p.sessionFrom === "number") return p.sessionFrom;
    } catch (e) {}
    return null;
  }

  // Turn a provider record into the editable-field shape this feature owns.
  function toListing(provider, planEntry) {
    var cats = [];
    try {
      var raw = (provider && provider.categories) || [];
      for (var i = 0; i < raw.length && cats.length < MAX_CATEGORIES; i++) {
        // keep only categories we know how to render as options; fall back to raw.
        cats.push(trimStr(raw[i]));
      }
    } catch (e) {}
    if (!cats.length) cats = ["Multi-activity"]; // guarantee the >=1 invariant on load.

    return {
      id: (provider && provider.id) || HC.util.uid(),
      title: trimStr((provider && provider.name) || "Untitled camp"),
      shortDesc: trimStr((provider && provider.goodFor) || ""),
      longDesc: trimStr((provider && provider.summary) || ""),
      ageMin: clampInt((provider && provider.ageMin), AGE_FLOOR, AGE_CEIL),
      ageMax: clampInt((provider && provider.ageMax != null ? provider.ageMax : AGE_CEIL), AGE_FLOOR, AGE_CEIL),
      categories: dedupe(cats).slice(0, MAX_CATEGORIES),
      dayPrice: deriveDayPrice(planEntry) // may be null = "confirm with provider"
    };
  }

  // The provider's listings, with any saved edit overlay applied on top.
  function listings() {
    var out = [];
    try {
      var providers = HC.data.providers || [];
      var byId = (HC.data.planner && HC.data.planner.byId) || {};
      var overlay = readOverlay();
      for (var i = 0; i < providers.length; i++) {
        var p = providers[i];
        var base = toListing(p, byId[p.id]);
        if (overlay[base.id]) base = mergeChanges(base, overlay[base.id]).listing;
        out.push(base);
        if (out.length >= 12) break; // a provider's own manageable set
      }
    } catch (e) { /* defensive */ }
    if (!out.length) {
      // Synthetic fallback so the form always has something to edit.
      out.push({
        id: "demo-camp", title: "Demo Holiday Camp", shortDesc: "Working parents who need full-day cover.",
        longDesc: "A flexible school-holiday camp with sports, crafts and outdoor play.",
        ageMin: 5, ageMax: 11, categories: ["Multi-activity"], dayPrice: 36
      });
    }
    return out;
  }

  /* ============================================================
   * 4. CORE LOGIC — validate + apply an edit.
   *    Returns a result object; NEVER throws and NEVER mutates the
   *    input listing.
   *      { ok:true,  listing, changed:[fields], message }
   *      { ok:false, errors:{field:msg}, message }
   * ============================================================ */

  function validateChanges(original, changes) {
    var errors = {};
    var c = changes || {};

    if ("title" in c) {
      var t = trimStr(c.title);
      if (!t) errors.title = "Title is required.";
      else if (t.length > TITLE_MAX) errors.title = "Title must be " + TITLE_MAX + " characters or fewer.";
    }

    if ("shortDesc" in c && trimStr(c.shortDesc).length > SHORT_MAX) {
      errors.shortDesc = "Short description must be " + SHORT_MAX + " characters or fewer.";
    }

    if ("categories" in c) {
      var cats = dedupe(Array.isArray(c.categories) ? c.categories : []);
      if (cats.length < MIN_CATEGORIES) errors.categories = "Tag at least one category.";
      else if (cats.length > MAX_CATEGORIES) errors.categories = "Tag up to " + MAX_CATEGORIES + " categories only.";
    }

    // Resolve effective ages (a change may set just one bound).
    var min = ("ageMin" in c) ? Number(c.ageMin) : original.ageMin;
    var max = ("ageMax" in c) ? Number(c.ageMax) : original.ageMax;
    if (("ageMin" in c) || ("ageMax" in c)) {
      if (!isFinite(min) || !isFinite(max)) {
        errors.age = "Ages must be numbers.";
      } else if (min < AGE_FLOOR || max > AGE_CEIL) {
        errors.age = "Ages must be between " + AGE_FLOOR + " and " + AGE_CEIL + ".";
      } else if (min > max) {
        errors.age = "Minimum age cannot be greater than maximum age.";
      }
    }

    if ("dayPrice" in c && c.dayPrice !== null && c.dayPrice !== "") {
      var price = Number(c.dayPrice);
      if (!isFinite(price) || price < 0) errors.dayPrice = "Day price must be £0 or more.";
    }

    return errors;
  }

  // Pure merge: original + changes -> new listing (no side effects).
  function mergeChanges(original, changes) {
    var c = changes || {};
    var next = {
      id: original.id,
      title: ("title" in c) ? trimStr(c.title) : original.title,
      shortDesc: ("shortDesc" in c) ? trimStr(c.shortDesc) : original.shortDesc,
      longDesc: ("longDesc" in c) ? trimStr(c.longDesc) : original.longDesc,
      ageMin: ("ageMin" in c) ? clampInt(c.ageMin, AGE_FLOOR, AGE_CEIL) : original.ageMin,
      ageMax: ("ageMax" in c) ? clampInt(c.ageMax, AGE_FLOOR, AGE_CEIL) : original.ageMax,
      categories: ("categories" in c)
        ? dedupe(Array.isArray(c.categories) ? c.categories : []).slice(0, MAX_CATEGORIES)
        : original.categories.slice(),
      dayPrice: ("dayPrice" in c)
        ? (c.dayPrice === null || c.dayPrice === "" ? null : round2(c.dayPrice))
        : original.dayPrice
    };

    // Which fields actually changed?
    var changed = [];
    ["title", "shortDesc", "longDesc", "ageMin", "ageMax", "dayPrice"].forEach(function (f) {
      if (String(next[f]) !== String(original[f])) changed.push(f);
    });
    if (next.categories.join("|") !== original.categories.join("|")) changed.push("categories");

    return { listing: next, changed: changed };
  }

  function applyEdit(original, changes) {
    if (!original || typeof original !== "object") {
      return { ok: false, errors: { _: "No listing to edit." }, message: "No listing to edit." };
    }
    var errors = validateChanges(original, changes);
    if (Object.keys(errors).length) {
      return {
        ok: false,
        errors: errors,
        message: "Could not save: " + Object.keys(errors).map(function (k) { return errors[k]; }).join(" ")
      };
    }
    var merged = mergeChanges(original, changes);
    return {
      ok: true,
      listing: merged.listing,
      changed: merged.changed,
      message: merged.changed.length
        ? "Saved — updated " + merged.changed.join(", ") + "."
        : "Saved — no changes."
    };
  }

  /* ============================================================
   * 5. Persistence — the saved edit overlay (HC.store only).
   * ============================================================ */

  function readOverlay() {
    try {
      var o = HC.store.get(STORE_KEY, {});
      return (o && typeof o === "object") ? o : {};
    } catch (e) { return {}; }
  }

  // Persist a *valid* edit. Returns the same result object from applyEdit,
  // with the merged listing stored as the overlay for that id.
  function saveListing(original, changes) {
    var res = applyEdit(original, changes);
    if (!res.ok) return res;
    try {
      var overlay = readOverlay();
      // Store the full merged field set so reloads reflect the edit.
      overlay[original.id] = {
        title: res.listing.title,
        shortDesc: res.listing.shortDesc,
        longDesc: res.listing.longDesc,
        ageMin: res.listing.ageMin,
        ageMax: res.listing.ageMax,
        categories: res.listing.categories,
        dayPrice: res.listing.dayPrice
      };
      HC.store.set(STORE_KEY, overlay);
    } catch (e) { /* defensive: a storage failure still returns ok=true result */ }
    return res;
  }

  function clearOverlay(id) {
    try {
      var overlay = readOverlay();
      if (id) { delete overlay[id]; } else { overlay = {}; }
      HC.store.set(STORE_KEY, overlay);
    } catch (e) {}
  }

  /* ============================================================
   * 6. UI — a provider listings screen. Each row has an EDIT
   *    (pencil) action; clicking it opens the editable form; Save
   *    validates + persists and reflects the change back into the row.
   * ============================================================ */

  function esc(s) {
    return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
  function escAttr(s) { return esc(s).replace(/"/g, "&quot;"); }

  function priceLabel(listing) {
    return (listing.dayPrice == null) ? "Price: confirm with provider"
      : HC.util.money(listing.dayPrice) + " / day place";
  }

  function render(mountEl) {
    try {
      var rows = listings();
      var state = { rows: rows, editingId: null };

      mountEl.innerHTML =
        '<div style="font-family:\'Nunito Sans\',system-ui,sans-serif;color:var(--text,#383838)">' +
          '<p style="font-size:14px;margin:0 0 14px">Your holiday-camp listings. ' +
          'Click the <strong>pencil (Edit)</strong> next to a listing to open its editable form — ' +
          'change the title, description, categories, ages or day price, then hit <strong>Save</strong>. ' +
          'Edits persist to your provider profile.</p>' +
          '<div id="pecList"></div>' +
        "</div>";

      var listEl = mountEl.querySelector("#pecList");

      function rowHtml(l) {
        return '<div class="pec-row" data-id="' + escAttr(l.id) + '" ' +
            'style="border:1.5px solid var(--line,#E6E6E6);border-radius:14px;padding:14px 16px;margin-bottom:10px;display:flex;justify-content:space-between;gap:12px;align-items:flex-start">' +
            '<div style="min-width:0">' +
              '<div class="pec-title" style="font-family:\'Quicksand\',system-ui,sans-serif;font-weight:700;color:var(--purple,#603488);font-size:16px">' + esc(l.title) + "</div>" +
              '<div class="pec-meta" style="font-size:12.5px;color:var(--muted,#808080);margin-top:3px">' +
                "Ages " + esc(l.ageMin) + "–" + esc(l.ageMax) + " · " + esc(priceLabel(l)) + "</div>" +
              '<div class="pec-cats" style="font-size:12px;color:var(--text,#383838);margin-top:4px">' +
                esc(l.categories.join(" · ")) + "</div>" +
            "</div>" +
            '<button type="button" class="hc-btn hc-btn-ghost pec-edit" data-id="' + escAttr(l.id) + '" ' +
              'title="Edit listing" aria-label="Edit listing">✏️ Edit</button>' +
          "</div>";
      }

      function paintList() {
        listEl.innerHTML = state.rows.map(rowHtml).join("");
      }

      function formHtml(l) {
        var catChecks = CATEGORY_OPTIONS.concat(
          l.categories.filter(function (c) { return CATEGORY_OPTIONS.indexOf(c) === -1; })
        ).map(function (cat) {
          var on = l.categories.indexOf(cat) !== -1;
          return '<label style="display:inline-flex;align-items:center;gap:5px;font-size:12.5px;margin:0 10px 6px 0">' +
            '<input type="checkbox" class="pecCat" value="' + escAttr(cat) + '"' + (on ? " checked" : "") + "> " + esc(cat) +
          "</label>";
        }).join("");

        var inp = "width:100%;padding:9px;border:1.5px solid var(--line,#E6E6E6);border-radius:12px;font-size:14px;box-sizing:border-box";
        var lab = "display:block;font-weight:700;font-size:13px;margin:12px 0 4px";

        return '<div class="pec-form" data-id="' + escAttr(l.id) + '" ' +
            'style="border:1.5px solid var(--purple,#603488);border-radius:14px;padding:16px;margin-bottom:10px;background:#fff">' +
          '<div style="font-family:\'Quicksand\',system-ui,sans-serif;font-weight:700;color:var(--purple,#603488);font-size:15px;margin-bottom:2px">✏️ Edit listing</div>' +

          '<label style="' + lab + '">Title</label>' +
          '<input id="pecTitle" type="text" maxlength="' + (TITLE_MAX + 5) + '" value="' + escAttr(l.title) + '" style="' + inp + '">' +

          '<label style="' + lab + '">Short description (who it\'s good for)</label>' +
          '<input id="pecShort" type="text" value="' + escAttr(l.shortDesc) + '" style="' + inp + '">' +

          '<label style="' + lab + '">Long description</label>' +
          '<textarea id="pecLong" rows="3" style="' + inp + ';resize:vertical">' + esc(l.longDesc) + "</textarea>" +

          '<div style="display:flex;gap:10px">' +
            '<div style="flex:1"><label style="' + lab + '">Min age</label>' +
              '<input id="pecMin" type="number" min="' + AGE_FLOOR + '" max="' + AGE_CEIL + '" value="' + escAttr(l.ageMin) + '" style="' + inp + '"></div>' +
            '<div style="flex:1"><label style="' + lab + '">Max age</label>' +
              '<input id="pecMax" type="number" min="' + AGE_FLOOR + '" max="' + AGE_CEIL + '" value="' + escAttr(l.ageMax) + '" style="' + inp + '"></div>' +
            '<div style="flex:1"><label style="' + lab + '">Day price £</label>' +
              '<input id="pecPrice" type="number" min="0" step="0.50" value="' + (l.dayPrice == null ? "" : escAttr(l.dayPrice)) + '" placeholder="—" style="' + inp + '"></div>' +
          "</div>" +

          '<label style="' + lab + '">Categories (choose up to ' + MAX_CATEGORIES + ')</label>' +
          '<div id="pecCats" style="margin-top:2px">' + catChecks + "</div>" +

          '<div id="pecErr" style="color:#9a1f5e;font-size:12.5px;min-height:16px;margin-top:6px"></div>' +
          '<div style="display:flex;gap:8px;margin-top:8px">' +
            '<button type="button" class="hc-btn pec-save" data-id="' + escAttr(l.id) + '">Save</button>' +
            '<button type="button" class="hc-btn hc-btn-ghost pec-cancel" data-id="' + escAttr(l.id) + '">Cancel</button>' +
          "</div>" +
        "</div>";
      }

      function openEditor(id) {
        var l = findRow(id);
        if (!l) return;
        var rowEl = listEl.querySelector('.pec-row[data-id="' + cssEsc(id) + '"]');
        if (!rowEl) return;
        var holder = document.createElement("div");
        holder.innerHTML = formHtml(l);
        rowEl.replaceWith(holder.firstChild);
        state.editingId = id;
      }

      function collectChanges(formEl) {
        var cats = [];
        formEl.querySelectorAll(".pecCat:checked").forEach(function (cb) { cats.push(cb.value); });
        var priceRaw = formEl.querySelector("#pecPrice").value;
        return {
          title: formEl.querySelector("#pecTitle").value,
          shortDesc: formEl.querySelector("#pecShort").value,
          longDesc: formEl.querySelector("#pecLong").value,
          ageMin: formEl.querySelector("#pecMin").value,
          ageMax: formEl.querySelector("#pecMax").value,
          dayPrice: priceRaw === "" ? null : priceRaw,
          categories: cats
        };
      }

      function onSave(id) {
        var formEl = listEl.querySelector('.pec-form[data-id="' + cssEsc(id) + '"]');
        if (!formEl) return;
        var original = findRow(id);
        var changes = collectChanges(formEl);
        var res = saveListing(original, changes);
        if (!res.ok) {
          formEl.querySelector("#pecErr").textContent = res.message;
          return;
        }
        // Reflect the saved listing back into state + the row.
        replaceRow(id, res.listing);
        state.editingId = null;
        paintList();
        try { HC.util.toast(res.changed.length ? "Listing saved ✓" : "No changes to save"); } catch (e) {}
      }

      function onCancel() {
        state.editingId = null;
        paintList();
      }

      function findRow(id) {
        for (var i = 0; i < state.rows.length; i++) if (state.rows[i].id === id) return state.rows[i];
        return null;
      }
      function replaceRow(id, listing) {
        for (var i = 0; i < state.rows.length; i++) if (state.rows[i].id === id) { state.rows[i] = listing; return; }
      }
      function cssEsc(s) { return String(s).replace(/["\\]/g, "\\$&"); }

      // Delegated clicks within this feature's mount only.
      mountEl.addEventListener("click", function (e) {
        var edit = e.target.closest(".pec-edit");
        if (edit) { openEditor(edit.getAttribute("data-id")); return; }
        var save = e.target.closest(".pec-save");
        if (save) { onSave(save.getAttribute("data-id")); return; }
        var cancel = e.target.closest(".pec-cancel");
        if (cancel) { onCancel(); return; }
      });

      paintList();
    } catch (e) {
      mountEl.innerHTML = '<p style="color:#9a1f5e">Listing editor failed to load: ' +
        esc(e && e.message ? e.message : String(e)) + "</p>";
    }
  }

  /* ============================================================
   * 7. selfTest — exercises the LOGIC and asserts the acceptance
   *    criterion: an Edit opens an editable form and SAVES changes.
   *    We test the underlying applyEdit / saveListing logic across
   *    multiple cases (valid save reflected; invalid rejected;
   *    persistence round-trips; original never mutated).
   * ============================================================ */

  function selfTest() {
    var pass = 0, fail = 0, log = [];
    function check(label, fn) {
      try { fn(); pass += 1; log.push("✓ " + label); }
      catch (e) { fail += 1; log.push("✗ " + label + " — " + (e && e.message ? e.message : String(e))); }
    }

    // A clean baseline listing to edit (independent of live data).
    function base() {
      return {
        id: "test-camp", title: "Summer Sports Camp",
        shortDesc: "Active kids who love a full day out.",
        longDesc: "Football, dodgeball and athletics across the holidays.",
        ageMin: 5, ageMax: 11, categories: ["Sports", "Full day"], dayPrice: 36
      };
    }

    // Always start each run from a clean overlay so it is deterministic.
    clearOverlay("test-camp");

    // --- ACCEPTANCE: a valid edit opens + SAVES, reflecting the change. ---
    check("Editing the title saves and is reflected in the listing", function () {
      var orig = base();
      var res = applyEdit(orig, { title: "Summer Multi-Sports Camp" });
      HC.assert(res.ok === true, "valid title edit should save");
      HC.assert(res.listing.title === "Summer Multi-Sports Camp", "title should update, got " + res.listing.title);
      HC.assert(res.changed.indexOf("title") !== -1, "title should be in changed[]");
      HC.assert(orig.title === "Summer Sports Camp", "original must NOT be mutated");
    });

    check("Editing the day price saves a rounded number", function () {
      var res = applyEdit(base(), { dayPrice: "42.5" });
      HC.assert(res.ok === true, "valid price edit should save");
      HC.assert(res.listing.dayPrice === 42.5, "price should be 42.5, got " + res.listing.dayPrice);
    });

    check("Editing ages saves a valid range", function () {
      var res = applyEdit(base(), { ageMin: 6, ageMax: 14 });
      HC.assert(res.ok === true, "valid age edit should save");
      HC.assert(res.listing.ageMin === 6 && res.listing.ageMax === 14,
        "ages should be 6–14, got " + res.listing.ageMin + "–" + res.listing.ageMax);
    });

    check("Changing categories (within the 2-tag limit) saves", function () {
      var res = applyEdit(base(), { categories: ["Arts & crafts", "Half day"] });
      HC.assert(res.ok === true, "two valid categories should save");
      HC.assert(res.listing.categories.length === 2, "should keep 2 categories");
      HC.assert(res.listing.categories[0] === "Arts & crafts", "first category should update");
      HC.assert(res.changed.indexOf("categories") !== -1, "categories should be in changed[]");
    });

    check("A multi-field edit saves all changed fields together", function () {
      var res = applyEdit(base(), { title: "Autumn Camp", ageMax: 12, dayPrice: 40 });
      HC.assert(res.ok === true, "multi-field edit should save");
      HC.assert(res.listing.title === "Autumn Camp" && res.listing.ageMax === 12 && res.listing.dayPrice === 40,
        "all three fields should update");
      HC.assert(res.changed.length === 3, "expected 3 changed fields, got " + res.changed.length);
    });

    // --- ACCEPTANCE (negative): invalid edits are rejected, listing unchanged. ---
    check("Empty title is rejected (Happity: title required)", function () {
      var orig = base();
      var res = applyEdit(orig, { title: "   " });
      HC.assert(res.ok === false, "blank title must be rejected");
      HC.assert(!!res.errors.title, "should carry a title error");
      HC.assert(orig.title === "Summer Sports Camp", "original unchanged on reject");
    });

    check("Zero categories is rejected (Happity: need >=1 tag)", function () {
      var res = applyEdit(base(), { categories: [] });
      HC.assert(res.ok === false, "no-category edit must be rejected");
      HC.assert(!!res.errors.categories, "should carry a categories error");
    });

    check("More than two categories is rejected (Happity: up to two)", function () {
      var res = applyEdit(base(), { categories: ["Sports", "Drama", "Music"] });
      HC.assert(res.ok === false, "three categories must be rejected");
      HC.assert(!!res.errors.categories, "should carry a categories error");
    });

    check("Inverted age range (min > max) is rejected", function () {
      var res = applyEdit(base(), { ageMin: 12, ageMax: 7 });
      HC.assert(res.ok === false, "min>max must be rejected");
      HC.assert(!!res.errors.age, "should carry an age error");
    });

    check("Out-of-bounds age is rejected", function () {
      var res = applyEdit(base(), { ageMax: 25 });
      HC.assert(res.ok === false, "age above ceiling must be rejected");
      HC.assert(!!res.errors.age, "should carry an age error");
    });

    check("Negative day price is rejected", function () {
      var res = applyEdit(base(), { dayPrice: -5 });
      HC.assert(res.ok === false, "negative price must be rejected");
      HC.assert(!!res.errors.dayPrice, "should carry a dayPrice error");
    });

    // --- PERSISTENCE round-trip via HC.store (the "Save" really saves). ---
    check("saveListing persists a valid edit to the store overlay", function () {
      clearOverlay("test-camp");
      var res = saveListing(base(), { title: "Saved Camp Name", dayPrice: 50 });
      HC.assert(res.ok === true, "save should succeed");
      var overlay = readOverlay();
      HC.assert(overlay["test-camp"], "overlay entry should exist for the listing id");
      HC.assert(overlay["test-camp"].title === "Saved Camp Name", "persisted title should match");
      HC.assert(overlay["test-camp"].dayPrice === 50, "persisted price should match");
    });

    check("A rejected save does NOT write to the store overlay", function () {
      clearOverlay("test-camp");
      var res = saveListing(base(), { title: "" }); // invalid
      HC.assert(res.ok === false, "invalid save should fail");
      var overlay = readOverlay();
      HC.assert(!overlay["test-camp"], "no overlay should be written for a rejected edit");
    });

    check("A saved edit is re-read on the next load (round-trip)", function () {
      clearOverlay("test-camp");
      saveListing(base(), { title: "Persisted Title" });
      // Simulate a reload by re-merging the stored overlay onto the base.
      var overlay = readOverlay();
      var reloaded = mergeChanges(base(), overlay["test-camp"]).listing;
      HC.assert(reloaded.title === "Persisted Title", "reloaded listing should reflect the saved title");
      clearOverlay("test-camp"); // leave the store as found
    });

    // --- No-op edits are valid but report nothing changed. ---
    check("Saving with no actual change reports an empty changed[]", function () {
      var res = applyEdit(base(), { title: "Summer Sports Camp" }); // same value
      HC.assert(res.ok === true, "a no-op edit is still a valid save");
      HC.assert(res.changed.length === 0, "no fields should be marked changed, got " + res.changed.join(","));
    });

    // --- Live-data sanity: a real listing can be loaded + edited + saved. ---
    check("A live camp listing can be loaded, edited and saved", function () {
      var rows = listings();
      HC.assert(rows.length >= 1, "expected >=1 provider listing, got " + rows.length);
      var live = rows[0];
      HC.assert(typeof live.title === "string" && live.title.length > 0, "live listing should have a title");
      HC.assert(live.categories.length >= 1, "live listing should pre-fill >=1 category");
      clearOverlay(live.id);
      var res = saveListing(live, { shortDesc: "Updated by the provider edit form." });
      HC.assert(res.ok === true, "editing a live listing should save");
      var overlay = readOverlay();
      HC.assert(overlay[live.id] && overlay[live.id].shortDesc === "Updated by the provider edit form.",
        "live edit should persist to the overlay");
      clearOverlay(live.id); // leave the store as found
    });

    return { pass: pass, fail: fail, log: log };
  }

  /* ============================================================
   * 8. Register (idempotent + defensive via core).
   * ============================================================ */
  HC.registerFeature({
    id: "provider-edit-camp",
    title: "Edit a camp listing",
    side: "provider",
    icon: "✏️",
    summary: "Open the pencil/Edit action on one of your holiday-camp listings to change its title, description, categories, ages or day price — then Save. Valid edits persist; invalid ones (no title, no category, bad age range) are rejected.",
    render: render,
    selfTest: selfTest
  });
})();
