/* HolidayCamp feature: provider-categories
 * ------------------------------------------------------------------
 * Replicates Happity's "What are categories and how do I tag my
 * classes?" behaviour for the PROVIDER side, reframed for SCHOOL-AGE
 * HOLIDAY CAMPS (day / week places), not baby classes.
 *
 * Evidence (support corpus, article 3746856
 *   "What are categories and how do I tag my classes?"):
 *   - Categories help a listing appear in the right places on Happity,
 *     including high-traffic Category pages, so more parents find it.
 *   - "You can add up to two categories that best describe your class."
 *   - "If the category you need isn't listed, select Other and type
 *      your suggestion. This will be fed back to our product team for
 *      review."
 *   - You can come back and edit your categories at any time.
 *
 * Acceptance criterion (asserted by selfTest, multiple cases):
 *   A camp can be tagged with UP TO TWO categories; 'Other' captures a
 *   free-text suggestion.
 *
 * Scope note: this module owns ONLY the category tagging surface — the
 * "Categories" section a provider edits at the bottom of an activity.
 * (Full activity editing lives in provider-edit-camp.) It is defensive:
 * nothing throws at registration time, and persistence is via HC.store
 * only (the verified camps.js data is never mutated).
 * ------------------------------------------------------------------ */
(function () {
  "use strict";

  if (typeof window === "undefined" || !window.HC || typeof window.HC.registerFeature !== "function") {
    // Core not present — fail silently rather than throwing.
    return;
  }
  var HC = window.HC;

  var STORE_KEY = "provider_categories_overlay"; // { [campId]: { categories:[..], otherSuggestion:"" } }

  /* ============================================================
   * 1. The category vocabulary + rules.
   *    Happity allows UP TO TWO categories. 'Other' is a special
   *    pseudo-category that does NOT count as a tag on its own —
   *    it opens a free-text suggestion box fed back for review.
   * ============================================================ */

  var MAX_CATEGORIES = 2;     // Happity: "add up to two categories".
  var OTHER = "Other";        // Happity: select Other and type your suggestion.
  var SUGGESTION_MAX = 80;    // keep the free-text suggestion sane.

  // Holiday-camp category vocabulary (the equivalent of Happity's
  // class "Category pages" — themed pages parents browse).
  var CATEGORY_OPTIONS = [
    "Multi-activity",
    "Sports",
    "Football",
    "Arts & crafts",
    "Drama & performing arts",
    "Dance",
    "Music",
    "Outdoor / forest school",
    "Adventure & climbing",
    "STEM / coding",
    "Swimming",
    "Cooking",
    "SEND specialist",
    "HAF / free places"
  ];

  /* ============================================================
   * 2. Pure helpers — no DOM, no side effects.
   * ============================================================ */

  function trimStr(s) { return String(s == null ? "" : s).replace(/\s+/g, " ").trim(); }

  // De-duplicate (case-insensitive) while preserving first-seen casing,
  // and drop the OTHER sentinel — it is never a real stored tag.
  function cleanTags(arr) {
    var seen = {}, out = [];
    if (!Array.isArray(arr)) return out;
    for (var i = 0; i < arr.length; i++) {
      var v = trimStr(arr[i]);
      if (!v) continue;
      if (v.toLowerCase() === OTHER.toLowerCase()) continue; // 'Other' is not a tag
      var k = v.toLowerCase();
      if (seen[k]) continue;
      seen[k] = true;
      out.push(v);
    }
    return out;
  }

  /* ============================================================
   * 3. CORE LOGIC — apply a category selection to a camp.
   *    Pure: NEVER throws, NEVER mutates inputs. Returns a result:
   *      { ok:true,  categories:[..], otherSuggestion:"", message }
   *      { ok:false, errors:{field:msg}, message }
   *
   *    selection = {
   *      categories: [..],        // chosen category labels (may include 'Other')
   *      otherSelected: Boolean,  // was the 'Other' option ticked?
   *      otherSuggestion: ""      // free-text typed into the Other box
   *    }
   * ============================================================ */

  function applyCategories(selection) {
    var sel = selection || {};
    var errors = {};

    // Did the provider engage the 'Other' option? Either via the explicit
    // flag, or by leaving 'Other' in the categories list.
    var rawCats = Array.isArray(sel.categories) ? sel.categories : [];
    var otherInList = rawCats.some(function (c) {
      return trimStr(c).toLowerCase() === OTHER.toLowerCase();
    });
    var otherSelected = !!sel.otherSelected || otherInList;

    // Real tags = everything except the 'Other' sentinel.
    var tags = cleanTags(rawCats);

    // 'Other' free-text suggestion (only meaningful when Other is selected).
    var suggestion = trimStr(sel.otherSuggestion);
    if (suggestion.length > SUGGESTION_MAX) suggestion = suggestion.slice(0, SUGGESTION_MAX);

    // --- Rule: UP TO TWO categories. ---
    // 'Other' occupies one of the two slots while it is being suggested,
    // so the effective count is real tags + (1 if Other engaged).
    var effectiveCount = tags.length + (otherSelected ? 1 : 0);
    if (effectiveCount > MAX_CATEGORIES) {
      errors.categories = "You can add up to " + MAX_CATEGORIES + " categories.";
    }

    // --- Rule: if 'Other' is selected, a suggestion must be typed. ---
    if (otherSelected && !suggestion) {
      errors.other = "Type your category suggestion, or untick Other.";
    }

    // --- Rule: a stray suggestion with Other NOT selected is ignored, not an error. ---
    if (!otherSelected) suggestion = "";

    if (Object.keys(errors).length) {
      return {
        ok: false,
        errors: errors,
        message: "Could not save categories: " +
          Object.keys(errors).map(function (k) { return errors[k]; }).join(" ")
      };
    }

    return {
      ok: true,
      categories: tags,                 // 0..2 real tags (excludes 'Other')
      otherSelected: otherSelected,
      otherSuggestion: suggestion,      // free-text fed back for review
      // The visible chips a parent would see = real tags only.
      // (Capacity tells the UI whether more can be added.)
      remaining: Math.max(0, MAX_CATEGORIES - effectiveCount),
      message: buildSavedMessage(tags, otherSelected, suggestion)
    };
  }

  function buildSavedMessage(tags, otherSelected, suggestion) {
    var parts = [];
    if (tags.length) parts.push("Tagged: " + tags.join(", ") + ".");
    if (otherSelected && suggestion) {
      parts.push("Your suggestion “" + suggestion + "” has been sent to the product team for review.");
    }
    if (!parts.length) parts.push("No categories tagged yet.");
    return parts.join(" ");
  }

  /* ============================================================
   * 4. Load a camp's current category selection from LIVE data,
   *    with any saved overlay applied on top (HC.store only).
   * ============================================================ */

  function readOverlay() {
    try {
      var o = HC.store.get(STORE_KEY, {});
      return (o && typeof o === "object") ? o : {};
    } catch (e) { return {}; }
  }

  // Build the editable category state for a camp id, pre-filled from the
  // verified camps.js categories (capped at the 2-tag rule) unless the
  // provider has saved an overlay.
  function loadSelection(campId) {
    var overlay = readOverlay();
    if (overlay[campId] && Array.isArray(overlay[campId].categories)) {
      return {
        categories: overlay[campId].categories.slice(0, MAX_CATEGORIES),
        otherSelected: !!overlay[campId].otherSelected,
        otherSuggestion: trimStr(overlay[campId].otherSuggestion)
      };
    }
    // Fall back to the live provider record.
    var cats = [];
    try {
      var providers = HC.data.providers || [];
      for (var i = 0; i < providers.length; i++) {
        if (providers[i].id === campId) {
          cats = cleanTags(providers[i].categories || []).slice(0, MAX_CATEGORIES);
          break;
        }
      }
    } catch (e) { /* defensive */ }
    return { categories: cats, otherSelected: false, otherSuggestion: "" };
  }

  // Persist a VALID category selection. Returns the applyCategories result.
  function saveCategories(campId, selection) {
    var res = applyCategories(selection);
    if (!res.ok) return res;
    try {
      var overlay = readOverlay();
      overlay[campId] = {
        categories: res.categories,
        otherSelected: res.otherSelected,
        otherSuggestion: res.otherSuggestion
      };
      HC.store.set(STORE_KEY, overlay);
    } catch (e) { /* a storage failure still returns an ok result */ }
    return res;
  }

  function clearOverlay(campId) {
    try {
      var overlay = readOverlay();
      if (campId) { delete overlay[campId]; } else { overlay = {}; }
      HC.store.set(STORE_KEY, overlay);
    } catch (e) {}
  }

  // Every free-text 'Other' suggestion saved so far — the queue the
  // product team would review. Read straight off the overlay.
  function pendingSuggestions() {
    var out = [];
    try {
      var overlay = readOverlay();
      for (var id in overlay) {
        if (!Object.prototype.hasOwnProperty.call(overlay, id)) continue;
        var s = overlay[id];
        if (s && s.otherSelected && trimStr(s.otherSuggestion)) {
          out.push({ campId: id, suggestion: trimStr(s.otherSuggestion) });
        }
      }
    } catch (e) {}
    return out;
  }

  /* ============================================================
   * 5. UI — the "Categories" tagging section.
   *    Pick a camp, tick up to two categories, or tick 'Other' and
   *    type a suggestion, then Save. Mirrors Happity steps 3-6.
   * ============================================================ */

  function esc(s) {
    return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
  function escAttr(s) { return esc(s).replace(/"/g, "&quot;"); }

  function campChoices() {
    var out = [];
    try {
      var providers = HC.data.providers || [];
      for (var i = 0; i < providers.length && out.length < 12; i++) {
        out.push({ id: providers[i].id, name: providers[i].name });
      }
    } catch (e) {}
    if (!out.length) out.push({ id: "demo-camp", name: "Demo Holiday Camp" });
    return out;
  }

  function render(mountEl) {
    try {
      var camps = campChoices();
      var state = { campId: camps[0].id, sel: loadSelection(camps[0].id) };

      var inp = "width:100%;padding:9px;border:1.5px solid var(--line,#E6E6E6);border-radius:12px;font-size:14px;box-sizing:border-box";
      var lab = "display:block;font-weight:700;font-size:13px;margin:14px 0 4px";

      mountEl.innerHTML =
        '<div style="font-family:\'Nunito Sans\',system-ui,sans-serif;color:var(--text,#383838)">' +
          '<p style="font-size:14px;margin:0 0 6px">Categories help your camp show up in the right places — including ' +
            'high-traffic <strong>Category pages</strong> parents browse by theme. ' +
            'Pick the <strong>up to two</strong> categories that best describe your camp, then <strong>Save</strong>.</p>' +
          '<p style="font-size:12.5px;color:var(--muted,#808080);margin:0 0 12px">' +
            'Can’t see the right category? Tick <strong>Other</strong> and type a suggestion — it’s sent to the product team for review.</p>' +

          '<label style="' + lab + '">Camp to tag</label>' +
          '<select id="pcCamp" style="' + inp + '">' +
            camps.map(function (c) {
              return '<option value="' + escAttr(c.id) + '">' + esc(c.name) + "</option>";
            }).join("") +
          "</select>" +

          '<label style="' + lab + '">Categories (choose up to ' + MAX_CATEGORIES + ')</label>' +
          '<div id="pcCats" style="margin-top:2px"></div>' +

          '<div id="pcOtherWrap" style="margin-top:8px;display:none">' +
            '<label style="font-weight:700;font-size:13px;display:block;margin-bottom:4px">Your suggestion</label>' +
            '<input id="pcOther" type="text" maxlength="' + SUGGESTION_MAX + '" ' +
              'placeholder="e.g. Parkour camp" style="' + inp + '">' +
          "</div>" +

          '<div id="pcCount" style="font-size:12px;color:var(--muted,#808080);margin-top:8px"></div>' +
          '<div id="pcErr" style="color:#9a1f5e;font-size:12.5px;min-height:16px;margin-top:4px"></div>' +
          '<div style="display:flex;gap:8px;margin-top:8px">' +
            '<button type="button" id="pcSave" class="hc-btn">Save categories</button>' +
          "</div>" +
          '<div id="pcSaved" style="font-size:12.5px;color:#2f7d4f;margin-top:8px;min-height:16px"></div>' +
        "</div>";

      var campSel = mountEl.querySelector("#pcCamp");
      var catsBox = mountEl.querySelector("#pcCats");
      var otherWrap = mountEl.querySelector("#pcOtherWrap");
      var otherInput = mountEl.querySelector("#pcOther");
      var countEl = mountEl.querySelector("#pcCount");
      var errEl = mountEl.querySelector("#pcErr");
      var savedEl = mountEl.querySelector("#pcSaved");

      function options() {
        // Show every known category plus any saved custom tag not in the list.
        var extra = state.sel.categories.filter(function (c) {
          return CATEGORY_OPTIONS.indexOf(c) === -1;
        });
        return CATEGORY_OPTIONS.concat(extra).concat([OTHER]);
      }

      function selectedRealCount() {
        return cleanTags(state.sel.categories).length;
      }
      function otherOn() { return !!state.sel.otherSelected; }
      function effectiveCount() { return selectedRealCount() + (otherOn() ? 1 : 0); }

      function paintCats() {
        var atCap = effectiveCount() >= MAX_CATEGORIES;
        catsBox.innerHTML = options().map(function (cat) {
          var isOther = cat === OTHER;
          var on = isOther ? otherOn()
            : state.sel.categories.some(function (c) { return c.toLowerCase() === cat.toLowerCase(); });
          // Disable unticked options once at capacity (Happity caps at two).
          var disabled = !on && atCap;
          return '<label style="display:inline-flex;align-items:center;gap:5px;font-size:12.5px;' +
              'margin:0 10px 6px 0;' + (disabled ? "opacity:.45;" : "") + '">' +
            '<input type="checkbox" class="pcCat" value="' + escAttr(cat) + '"' +
              (on ? " checked" : "") + (disabled ? " disabled" : "") + "> " +
            esc(cat) + (isOther ? " …" : "") +
          "</label>";
        }).join("");

        otherWrap.style.display = otherOn() ? "block" : "none";
        if (otherInput) otherInput.value = state.sel.otherSuggestion || "";

        var n = effectiveCount();
        countEl.textContent = n + " of " + MAX_CATEGORIES + " selected" +
          (n >= MAX_CATEGORIES ? " — untick one to change." : ".");
      }

      function loadCamp(id) {
        state.campId = id;
        state.sel = loadSelection(id);
        errEl.textContent = "";
        savedEl.textContent = "";
        paintCats();
      }

      function onToggle(cat, checked) {
        errEl.textContent = "";
        savedEl.textContent = "";
        if (cat === OTHER) {
          state.sel.otherSelected = checked;
          if (!checked) state.sel.otherSuggestion = "";
        } else if (checked) {
          if (!state.sel.categories.some(function (c) { return c.toLowerCase() === cat.toLowerCase(); })) {
            state.sel.categories.push(cat);
          }
        } else {
          state.sel.categories = state.sel.categories.filter(function (c) {
            return c.toLowerCase() !== cat.toLowerCase();
          });
        }
        paintCats();
        if (cat === OTHER && checked && otherInput) otherInput.focus();
      }

      function onSave() {
        if (otherInput) state.sel.otherSuggestion = otherInput.value;
        var res = saveCategories(state.campId, {
          categories: state.sel.categories,
          otherSelected: state.sel.otherSelected,
          otherSuggestion: state.sel.otherSuggestion
        });
        if (!res.ok) {
          errEl.textContent = res.message;
          savedEl.textContent = "";
          return;
        }
        errEl.textContent = "";
        savedEl.textContent = res.message;
        // Reflect the cleaned, persisted state back into the UI.
        state.sel = loadSelection(state.campId);
        paintCats();
        try { HC.util.toast("Categories saved ✓"); } catch (e) {}
      }

      campSel.addEventListener("change", function () { loadCamp(campSel.value); });
      catsBox.addEventListener("change", function (e) {
        var cb = e.target.closest(".pcCat");
        if (cb) onToggle(cb.value, cb.checked);
      });
      if (otherInput) {
        otherInput.addEventListener("input", function () {
          state.sel.otherSuggestion = otherInput.value;
          savedEl.textContent = "";
        });
      }
      mountEl.querySelector("#pcSave").addEventListener("click", onSave);

      paintCats();
    } catch (e) {
      mountEl.innerHTML = '<p style="color:#9a1f5e">Category tagger failed to load: ' +
        esc(e && e.message ? e.message : String(e)) + "</p>";
    }
  }

  /* ============================================================
   * 6. selfTest — exercises the LOGIC and asserts the acceptance
   *    criterion across multiple cases:
   *      "A camp can be tagged with up to two categories;
   *       'Other' captures a free-text suggestion."
   * ============================================================ */

  function selfTest() {
    var pass = 0, fail = 0, log = [];
    function check(label, fn) {
      try { fn(); pass += 1; log.push("✓ " + label); }
      catch (e) { fail += 1; log.push("✗ " + label + " — " + (e && e.message ? e.message : String(e))); }
    }

    var TEST_ID = "test-camp-categories";
    clearOverlay(TEST_ID); // deterministic start

    // --- ACCEPTANCE: tag with ONE category. ---
    check("Tagging one category saves it", function () {
      var res = applyCategories({ categories: ["Sports"] });
      HC.assert(res.ok === true, "one category should save");
      HC.assert(res.categories.length === 1 && res.categories[0] === "Sports", "should hold the one tag");
      HC.assert(res.remaining === 1, "one slot should remain, got " + res.remaining);
    });

    // --- ACCEPTANCE: tag with EXACTLY TWO categories. ---
    check("Tagging exactly two categories saves both", function () {
      var res = applyCategories({ categories: ["Sports", "Multi-activity"] });
      HC.assert(res.ok === true, "two categories should save");
      HC.assert(res.categories.length === 2, "should hold two tags, got " + res.categories.length);
      HC.assert(res.remaining === 0, "no slots should remain, got " + res.remaining);
    });

    // --- ACCEPTANCE (cap): MORE than two is rejected. ---
    check("Three categories is rejected (cap is two)", function () {
      var res = applyCategories({ categories: ["Sports", "Dance", "Music"] });
      HC.assert(res.ok === false, "three categories must be rejected");
      HC.assert(!!res.errors.categories, "should carry a categories error");
    });

    // --- ACCEPTANCE ('Other'): captures a free-text suggestion. ---
    check("'Other' with a typed suggestion is captured", function () {
      var res = applyCategories({ otherSelected: true, otherSuggestion: "Parkour camp" });
      HC.assert(res.ok === true, "Other + suggestion should save");
      HC.assert(res.otherSuggestion === "Parkour camp", "suggestion text should be captured, got " + res.otherSuggestion);
      HC.assert(res.categories.length === 0, "'Other' is not a real tag");
      HC.assert(res.message.indexOf("review") !== -1, "message should say it's fed back for review");
    });

    // 'Other' passed inside the categories array (as the UI sends it) also works.
    check("'Other' arriving in the categories list is treated as a suggestion, not a tag", function () {
      var res = applyCategories({ categories: ["Sports", "Other"], otherSuggestion: "Bushcraft" });
      HC.assert(res.ok === true, "Sports + Other(suggestion) should save");
      HC.assert(res.categories.length === 1 && res.categories[0] === "Sports", "only Sports is a real tag");
      HC.assert(res.otherSuggestion === "Bushcraft", "suggestion captured from the Other box");
    });

    // --- ACCEPTANCE (combo cap): one real tag + 'Other' = the two-slot max. ---
    check("One category plus 'Other' fills the two slots", function () {
      var res = applyCategories({ categories: ["Sports"], otherSelected: true, otherSuggestion: "Bushcraft" });
      HC.assert(res.ok === true, "one tag + Other should save");
      HC.assert(res.remaining === 0, "the two slots should be full, got " + res.remaining);
    });

    check("Two categories plus 'Other' exceeds two and is rejected", function () {
      var res = applyCategories({ categories: ["Sports", "Dance"], otherSelected: true, otherSuggestion: "Bushcraft" });
      HC.assert(res.ok === false, "2 tags + Other = 3 effective, must be rejected");
      HC.assert(!!res.errors.categories, "should carry a categories error");
    });

    // --- 'Other' ticked but left blank is rejected (must type something). ---
    check("'Other' ticked with no suggestion is rejected", function () {
      var res = applyCategories({ otherSelected: true, otherSuggestion: "   " });
      HC.assert(res.ok === false, "blank Other suggestion must be rejected");
      HC.assert(!!res.errors.other, "should carry an 'other' error");
    });

    // --- A suggestion typed without ticking Other is ignored, not stored. ---
    check("A suggestion with 'Other' not selected is ignored", function () {
      var res = applyCategories({ categories: ["Sports"], otherSelected: false, otherSuggestion: "Ghost text" });
      HC.assert(res.ok === true, "should still save the real tag");
      HC.assert(res.otherSuggestion === "", "stray suggestion must be dropped, got " + res.otherSuggestion);
    });

    // --- De-duplication: the same category twice still counts once. ---
    check("Duplicate categories collapse to one tag", function () {
      var res = applyCategories({ categories: ["Sports", "sports"] });
      HC.assert(res.ok === true, "duplicates should not over-fill");
      HC.assert(res.categories.length === 1, "should collapse to one tag, got " + res.categories.length);
    });

    // --- Zero categories is allowed (a camp can be left untagged). ---
    check("Zero categories is a valid (untagged) save", function () {
      var res = applyCategories({ categories: [] });
      HC.assert(res.ok === true, "empty selection is allowed");
      HC.assert(res.categories.length === 0, "no tags");
      HC.assert(res.remaining === MAX_CATEGORIES, "both slots free, got " + res.remaining);
    });

    // --- Long suggestion is truncated, not rejected. ---
    check("An over-long suggestion is truncated to the limit", function () {
      var longText = new Array(200).join("x");
      var res = applyCategories({ otherSelected: true, otherSuggestion: longText });
      HC.assert(res.ok === true, "long suggestion should still save");
      HC.assert(res.otherSuggestion.length === SUGGESTION_MAX,
        "suggestion should be capped at " + SUGGESTION_MAX + ", got " + res.otherSuggestion.length);
    });

    // --- PERSISTENCE round-trip via HC.store. ---
    check("saveCategories persists a valid two-tag selection", function () {
      clearOverlay(TEST_ID);
      var res = saveCategories(TEST_ID, { categories: ["Sports", "Music"] });
      HC.assert(res.ok === true, "save should succeed");
      var reloaded = loadSelection(TEST_ID);
      HC.assert(reloaded.categories.length === 2, "reloaded should have two tags");
      HC.assert(reloaded.categories.indexOf("Sports") !== -1 && reloaded.categories.indexOf("Music") !== -1,
        "reloaded tags should match what was saved");
    });

    check("saveCategories persists the 'Other' suggestion for review", function () {
      clearOverlay(TEST_ID);
      var res = saveCategories(TEST_ID, { otherSelected: true, otherSuggestion: "Parkour" });
      HC.assert(res.ok === true, "save should succeed");
      var reloaded = loadSelection(TEST_ID);
      HC.assert(reloaded.otherSelected === true, "Other flag should persist");
      HC.assert(reloaded.otherSuggestion === "Parkour", "suggestion should persist");
      var queue = pendingSuggestions();
      HC.assert(queue.some(function (q) { return q.campId === TEST_ID && q.suggestion === "Parkour"; }),
        "suggestion should appear in the product-team review queue");
    });

    check("A rejected selection does NOT write to the store", function () {
      clearOverlay(TEST_ID);
      var res = saveCategories(TEST_ID, { categories: ["A", "B", "C"] }); // > 2
      HC.assert(res.ok === false, "invalid save should fail");
      var overlay = readOverlay();
      HC.assert(!overlay[TEST_ID], "no overlay should be written for a rejected selection");
    });

    check("A saved selection can be edited again (re-tag at any time)", function () {
      clearOverlay(TEST_ID);
      saveCategories(TEST_ID, { categories: ["Sports"] });
      var res2 = saveCategories(TEST_ID, { categories: ["Drama & performing arts", "Dance"] });
      HC.assert(res2.ok === true, "re-tagging should succeed");
      var reloaded = loadSelection(TEST_ID);
      HC.assert(reloaded.categories.length === 2 && reloaded.categories[0] === "Drama & performing arts",
        "re-tag should replace the previous selection");
      clearOverlay(TEST_ID); // leave the store as found
    });

    // --- Input must NOT be mutated by the pure logic. ---
    check("applyCategories does not mutate its input", function () {
      var input = { categories: ["Sports", "Other"], otherSuggestion: "Bushcraft" };
      applyCategories(input);
      HC.assert(input.categories.length === 2, "input array length unchanged");
      HC.assert(input.categories[1] === "Other", "input array contents unchanged");
    });

    // --- LIVE-data sanity: a real provider can be loaded + tagged. ---
    check("A live camp can be loaded and re-tagged within the two-tag rule", function () {
      var providers = HC.data.providers || [];
      var live = providers[0];
      HC.assert(live && live.id, "expected at least one live provider");
      clearOverlay(live.id);
      var current = loadSelection(live.id);
      HC.assert(current.categories.length <= MAX_CATEGORIES,
        "pre-filled live tags should respect the cap, got " + current.categories.length);
      var res = saveCategories(live.id, { categories: ["Multi-activity", "Sports"] });
      HC.assert(res.ok === true, "tagging a live camp should save");
      HC.assert(loadSelection(live.id).categories.length === 2, "live camp should now hold two tags");
      clearOverlay(live.id); // leave the store as found
    });

    return { pass: pass, fail: fail, log: log };
  }

  /* ============================================================
   * 7. Register (idempotent + defensive via core).
   * ============================================================ */
  HC.registerFeature({
    id: "provider-categories",
    title: "Tag camp categories",
    side: "provider",
    icon: "🏷️",
    summary: "Tag a holiday camp with up to two categories so the right families find it on themed Category pages. Can't see the right one? Pick 'Other' and type a suggestion, which is fed back to the product team for review.",
    render: render,
    selfTest: selfTest
  });
})();
