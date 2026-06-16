/* HolidayCamp feature: provider-profile-content
 * ------------------------------------------------------------------
 * Replicates Happity's "What information should I include on my
 * profile?" behaviour for the PROVIDER side, reframed for SCHOOL-AGE
 * HOLIDAY CAMPS (day / week places), not baby classes.
 *
 * Evidence (support corpus):
 *  - 5827832 "What information should I include on my profile?":
 *    asks "Why do I need to complete the 'About you' and description
 *    boxes?". Three content jobs:
 *      (1) ABOUT YOU — tell parents who they'll meet and what makes
 *          you unique / why choose you over the alternatives.
 *      (2) CLASS DESCRIPTION — describe the activity, emphasise the
 *          FUN as well as the developmental benefits children gain.
 *      (3) PRACTICAL INFO — "any practical information that parents
 *          need to know about attending or getting to your classes."
 *  - 6211783 "How do I get the most from my profile and help increase
 *    bookings?": a complete, well-filled profile drives bookings.
 *  - 6212044 "What are the different sections under 'Organisation'?" /
 *    photos: the profile is split into editable sections (Organisation,
 *    Contact, logo/banner) — i.e. structured profile content blocks.
 *
 * Acceptance criterion (asserted by selfTest, multiple cases):
 *   The profile captures 'about you', a class description AND practical
 *   booking info — three distinct content fields are stored, validated
 *   and reflected back; a profile missing any of the three is flagged
 *   incomplete and cannot be "published".
 *
 * Defensive: nothing throws at registration time. Persistence is via
 * HC.store ONLY (one namespaced key, keyed by provider id); the
 * verified camps.js data is never mutated — it only pre-fills the form.
 * ------------------------------------------------------------------ */
(function () {
  "use strict";

  if (typeof window === "undefined" || !window.HC || typeof window.HC.registerFeature !== "function") {
    // Core not present — fail silently rather than throwing at parse time.
    return;
  }
  var HC = window.HC;

  var STORE_KEY = "provider_profile_content"; // { [providerId]: { aboutYou, description, practical } }

  /* ============================================================
   * 1. Content model.
   *    The three Happity field groups, reframed for holiday camps:
   *      aboutYou    — who runs it / what makes the camp unique.
   *      description — what kids do + the fun + developmental benefits.
   *      practical   — booking + getting there + day-to-day logistics.
   *    Each has a sensible minimum length so an "empty" box (a few
   *    stray characters) does not count as complete — matching the
   *    spirit of Happity's "complete the boxes" guidance.
   * ============================================================ */

  var FIELDS = [
    { key: "aboutYou", label: "About you", min: 25, max: 1200,
      hint: "Who runs the camp and what makes you unique — the team parents will meet, your experience, why choose you over the alternatives." },
    { key: "description", label: "Camp description", min: 25, max: 2000,
      hint: "What children actually do each day. Emphasise the FUN as well as the skills and developmental benefits they gain." },
    { key: "practical", label: "Practical booking info", min: 20, max: 1500,
      hint: "Everything a parent needs to attend: how to book, drop-off / pick-up times, what to bring, lunch, the venue and how to get there, refunds." }
  ];

  var FIELD_KEYS = FIELDS.map(function (f) { return f.key; });

  /* ============================================================
   * 2. Pure helpers (never throw, never mutate inputs).
   * ============================================================ */

  function trimStr(s) { return String(s == null ? "" : s).replace(/\s+/g, " ").trim(); }

  // Length used for completeness checks — collapsed whitespace so a box
  // of spaces / newlines does not pass as "filled in".
  function contentLen(s) { return trimStr(s).length; }

  function fieldDef(key) {
    for (var i = 0; i < FIELDS.length; i++) if (FIELDS[i].key === key) return FIELDS[i];
    return null;
  }

  function emptyProfile() {
    return { aboutYou: "", description: "", practical: "" };
  }

  /* ============================================================
   * 3. Pre-fill a profile draft from the LIVE camp data.
   *    Reads camps.js (HC.data.providers) + the planner layer so the
   *    three boxes start populated with the real verified copy, exactly
   *    as a provider would see their own profile pre-filled.
   * ============================================================ */

  function deriveAboutYou(provider) {
    // "About you" = who they are + what makes them unique. We seed it
    // from the directory summary; the provider then personalises it.
    var bits = [];
    var summ = trimStr(provider && provider.summary);
    if (summ) bits.push(summ);
    var kind = trimStr(provider && provider.kind);
    var area = trimStr(provider && provider.area);
    if (kind || area) {
      bits.push("We are a " + (kind ? kind.toLowerCase() : "holiday camp") +
        (area ? " serving " + area : "") + ".");
    }
    return trimStr(bits.join(" "));
  }

  function deriveDescription(provider) {
    // Class/camp description = what kids do + who it's good for.
    var bits = [];
    var summ = trimStr(provider && provider.summary);
    if (summ) bits.push(summ);
    var good = trimStr(provider && provider.goodFor);
    if (good) bits.push("Great for: " + good);
    var cats = (provider && provider.categories) || [];
    if (cats.length) bits.push("Activities span " + cats.join(", ").toLowerCase() + ".");
    return trimStr(bits.join(" "));
  }

  function derivePractical(provider, planEntry) {
    // Practical info = booking + getting there + hours + price.
    var bits = [];
    var booking = trimStr(provider && provider.booking);
    if (booking) bits.push("Booking: " + booking);
    var hours = trimStr(provider && provider.hours);
    if (hours) bits.push("Hours: " + hours);
    var address = trimStr(provider && provider.address);
    if (address && address.toLowerCase() !== "borough-wide") bits.push("Venue: " + address);
    var price = trimStr(provider && provider.price);
    if (price) bits.push("Price: " + price);
    // Planner lunch note adds a genuinely practical detail when present.
    try {
      var lunch = planEntry && planEntry.lunch && trimStr(planEntry.lunch.note);
      if (lunch) bits.push("Lunch: " + lunch);
    } catch (e) {}
    return trimStr(bits.join(" "));
  }

  // Build the pre-filled draft for one provider (camps.js + overlay).
  function draftFor(provider, planEntry) {
    var seeded = {
      aboutYou: deriveAboutYou(provider),
      description: deriveDescription(provider),
      practical: derivePractical(provider, planEntry)
    };
    var saved = readSaved()[provider && provider.id];
    if (saved && typeof saved === "object") {
      // A saved overlay fully owns any field the provider has edited.
      ["aboutYou", "description", "practical"].forEach(function (k) {
        if (typeof saved[k] === "string") seeded[k] = saved[k];
      });
    }
    return {
      id: (provider && provider.id) || HC.util.uid(),
      name: trimStr((provider && provider.name) || "Your holiday camp"),
      aboutYou: seeded.aboutYou,
      description: seeded.description,
      practical: seeded.practical
    };
  }

  // The provider's own profile drafts (first handful — their manageable set).
  function drafts() {
    var out = [];
    try {
      var providers = HC.data.providers || [];
      var byId = (HC.data.planner && HC.data.planner.byId) || {};
      for (var i = 0; i < providers.length; i++) {
        var p = providers[i];
        out.push(draftFor(p, byId[p.id]));
        if (out.length >= 8) break;
      }
    } catch (e) { /* defensive */ }
    if (!out.length) {
      out.push({
        id: "demo-camp",
        name: "Demo Holiday Camp",
        aboutYou: "Run by qualified play and sports coaches with 10 years of holiday-camp experience.",
        description: "A full day of sports, crafts and outdoor play — children make friends, build confidence and try something new every day.",
        practical: "Book online. Drop-off 9am, pick-up 4pm. Bring a packed lunch, water bottle and sun cream. Free parking at the venue."
      });
    }
    return out;
  }

  /* ============================================================
   * 4. CORE LOGIC — validate + assess a profile.
   *    NEVER throws and NEVER mutates the input.
   * ============================================================ */

  // Per-field status: filled? long enough? over the max?
  function assessField(key, value) {
    var def = fieldDef(key) || { min: 1, max: 100000, label: key };
    var len = contentLen(value);
    var status = {
      key: key,
      label: def.label,
      length: len,
      filled: len > 0,
      complete: len >= def.min,
      tooLong: len > def.max,
      min: def.min,
      max: def.max
    };
    return status;
  }

  // Validate the whole profile. Returns:
  //   { ok, errors:{field:msg}, missing:[keys], statuses:{key:status},
  //     complete:Boolean, message }
  // "complete" (acceptance criterion) == all THREE boxes are filled
  // to their minimum AND none is over its max.
  function validateProfile(profile) {
    var p = profile || {};
    var errors = {};
    var missing = [];
    var statuses = {};
    var completeCount = 0;

    for (var i = 0; i < FIELDS.length; i++) {
      var f = FIELDS[i];
      var st = assessField(f.key, p[f.key]);
      statuses[f.key] = st;

      if (!st.filled) {
        missing.push(f.key);
        errors[f.key] = "Add your '" + f.label + "' — parents rely on it.";
      } else if (!st.complete) {
        errors[f.key] = "'" + f.label + "' is a little short — add at least " +
          f.min + " characters so parents know what to expect.";
      } else if (st.tooLong) {
        errors[f.key] = "'" + f.label + "' is too long — keep it under " + f.max + " characters.";
      } else {
        completeCount += 1;
      }
    }

    var complete = completeCount === FIELDS.length;
    var ok = Object.keys(errors).length === 0;

    var message;
    if (complete) {
      message = "Profile complete — 'About you', description and practical info are all filled in. Ready to publish.";
    } else if (missing.length) {
      message = "Profile incomplete — still need: " +
        missing.map(function (k) { return "'" + fieldDef(k).label + "'"; }).join(", ") + ".";
    } else {
      message = "Almost there — " + Object.keys(errors).map(function (k) { return errors[k]; }).join(" ");
    }

    return {
      ok: ok,
      complete: complete,
      errors: errors,
      missing: missing,
      statuses: statuses,
      filledCount: completeCount,
      total: FIELDS.length,
      message: message
    };
  }

  // Normalise a draft into the stored shape (trimmed, only our fields).
  function normalise(profile) {
    var p = profile || {};
    return {
      aboutYou: trimStr(p.aboutYou),
      description: trimStr(p.description),
      practical: trimStr(p.practical)
    };
  }

  /* ============================================================
   * 5. Persistence — saved profile content (HC.store only).
   * ============================================================ */

  function readSaved() {
    try {
      var o = HC.store.get(STORE_KEY, {});
      return (o && typeof o === "object") ? o : {};
    } catch (e) { return {}; }
  }

  // Save a profile. A provider may "save a draft" even if incomplete,
  // but "publish" requires all three boxes complete.
  //   saveProfile(id, profile, { publish:Boolean })
  // Returns the validateProfile() result + { saved, published }.
  function saveProfile(id, profile, opts) {
    opts = opts || {};
    var assessment = validateProfile(profile);

    // Publishing is gated on completeness (the acceptance criterion).
    if (opts.publish && !assessment.complete) {
      assessment.saved = false;
      assessment.published = false;
      return assessment;
    }

    try {
      var all = readSaved();
      all[id] = normalise(profile);
      HC.store.set(STORE_KEY, all);
      assessment.saved = true;
      assessment.published = !!opts.publish && assessment.complete;
    } catch (e) {
      assessment.saved = false;
      assessment.published = false;
    }
    return assessment;
  }

  function clearSaved(id) {
    try {
      var all = readSaved();
      if (id) { delete all[id]; } else { all = {}; }
      HC.store.set(STORE_KEY, all);
    } catch (e) {}
  }

  /* ============================================================
   * 6. UI — the provider profile-content editor.
   *    Three labelled boxes (About you / Description / Practical info),
   *    each pre-filled from the live listing. A live completeness meter
   *    shows X of 3 sections complete; "Save draft" persists; "Publish"
   *    is only enabled once all three are complete.
   * ============================================================ */

  function esc(s) {
    return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
  function escAttr(s) { return esc(s).replace(/"/g, "&quot;"); }
  function cssEsc(s) { return String(s).replace(/["\\]/g, "\\$&"); }

  function render(mountEl) {
    try {
      var rows = drafts();
      var state = { current: rows[0], rows: rows };

      var sel = rows.map(function (r) {
        return '<option value="' + escAttr(r.id) + '">' + esc(r.name) + "</option>";
      }).join("");

      mountEl.innerHTML =
        '<div style="font-family:\'Nunito Sans\',system-ui,sans-serif;color:var(--text,#383838)">' +
          '<p style="font-size:14px;margin:0 0 12px">Your camp profile has three boxes that parents read before booking — ' +
          'complete all three so families know <strong>who you are</strong>, <strong>what their child will do</strong> ' +
          'and the <strong>practical details</strong> of attending. You can save a draft anytime; ' +
          '<strong>Publish</strong> unlocks once all three are filled in.</p>' +
          '<label style="display:block;font-weight:700;font-size:13px;margin:6px 0 4px">Editing profile for</label>' +
          '<select id="ppcWhich" style="width:100%;padding:9px;border:1.5px solid var(--line,#E6E6E6);border-radius:12px;font-size:14px;box-sizing:border-box">' +
            sel + "</select>" +
          '<div id="ppcMeter" style="margin:12px 0 4px"></div>' +
          '<div id="ppcForm"></div>' +
        "</div>";

      var whichEl = mountEl.querySelector("#ppcWhich");
      var formEl = mountEl.querySelector("#ppcForm");
      var meterEl = mountEl.querySelector("#ppcMeter");

      var inp = "width:100%;padding:10px;border:1.5px solid var(--line,#E6E6E6);border-radius:12px;font-size:14px;box-sizing:border-box;resize:vertical;font-family:inherit";
      var lab = "display:block;font-weight:700;font-size:13px;margin:14px 0 3px";
      var hintCss = "font-size:11.5px;color:var(--muted,#808080);margin:0 0 5px";

      function meterHtml(assessment) {
        var n = assessment.filledCount, t = assessment.total;
        var pct = Math.round((n / t) * 100);
        var barColor = assessment.complete ? "#2f7d4f" : "var(--magenta,#F82488)";
        return '<div style="font-family:\'Quicksand\',system-ui,sans-serif;font-weight:700;font-size:13px;color:' +
            (assessment.complete ? "#2f7d4f" : "var(--purple,#603488)") + '">' +
            (assessment.complete ? "✓ " : "") + n + " of " + t + " sections complete</div>" +
          '<div style="height:8px;background:var(--line,#E6E6E6);border-radius:999px;overflow:hidden;margin-top:5px">' +
            '<div style="height:100%;width:' + pct + '%;background:' + barColor + ';transition:width .2s"></div>' +
          "</div>";
      }

      function fieldBlock(f, value, st) {
        var tag = st.complete ? '<span style="color:#2f7d4f">✓ done</span>'
          : (st.filled ? '<span style="color:#9a1f5e">needs ' + (f.min - st.length) + ' more chars</span>'
            : '<span style="color:#9a1f5e">empty</span>');
        return '<label style="' + lab + '">' + esc(f.label) +
            ' <span style="font-weight:400;font-size:11px">(' + tag + ")</span></label>" +
          '<p style="' + hintCss + '">' + esc(f.hint) + "</p>" +
          '<textarea class="ppcField" data-key="' + escAttr(f.key) + '" rows="4" maxlength="' + (f.max + 50) +
            '" style="' + inp + '">' + esc(value) + "</textarea>";
      }

      function repaint() {
        var d = state.current;
        var current = collect() || { aboutYou: d.aboutYou, description: d.description, practical: d.practical };
        var assessment = validateProfile(current);
        meterEl.innerHTML = meterHtml(assessment);

        var blocks = FIELDS.map(function (f) {
          return fieldBlock(f, current[f.key], assessment.statuses[f.key]);
        }).join("");

        formEl.innerHTML = blocks +
          '<div id="ppcMsg" style="font-size:12.5px;margin:10px 0 4px;color:' +
            (assessment.complete ? "#2f7d4f" : "var(--muted,#808080)") + '">' + esc(assessment.message) + "</div>" +
          '<div style="display:flex;gap:8px;margin-top:8px">' +
            '<button type="button" class="hc-btn hc-btn-ghost" id="ppcSave">Save draft</button>' +
            '<button type="button" class="hc-btn" id="ppcPublish"' + (assessment.complete ? "" : " disabled style=\"opacity:.5;cursor:not-allowed\"") + '>Publish profile</button>' +
          "</div>";
      }

      function collect() {
        var fields = formEl.querySelectorAll(".ppcField");
        if (!fields.length) return null;
        var out = {};
        fields.forEach(function (ta) { out[ta.getAttribute("data-key")] = ta.value; });
        return out;
      }

      function loadCurrent(id) {
        for (var i = 0; i < state.rows.length; i++) {
          if (state.rows[i].id === id) { state.current = state.rows[i]; break; }
        }
        repaint();
      }

      // Live recompute as the provider types (debounced via microtask-ish).
      var raf = null;
      formEl.addEventListener("input", function (e) {
        if (!e.target.classList || !e.target.classList.contains("ppcField")) return;
        // Update only the meter + message without rebuilding textareas (keeps focus).
        var current = collect();
        if (!current) return;
        var assessment = validateProfile(current);
        meterEl.innerHTML = meterHtml(assessment);
        var msg = formEl.querySelector("#ppcMsg");
        if (msg) {
          msg.textContent = assessment.message;
          msg.style.color = assessment.complete ? "#2f7d4f" : "var(--muted,#808080)";
        }
        var pub = formEl.querySelector("#ppcPublish");
        if (pub) {
          pub.disabled = !assessment.complete;
          pub.style.opacity = assessment.complete ? "" : ".5";
          pub.style.cursor = assessment.complete ? "" : "not-allowed";
        }
      });

      formEl.addEventListener("click", function (e) {
        var save = e.target.closest("#ppcSave");
        var pub = e.target.closest("#ppcPublish");
        if (!save && !pub) return;
        var current = collect();
        if (!current) return;
        var res = saveProfile(state.current.id, current, { publish: !!pub });
        // Reflect the normalised saved values back into local state.
        var norm = normalise(current);
        state.current.aboutYou = norm.aboutYou;
        state.current.description = norm.description;
        state.current.practical = norm.practical;
        try {
          if (pub && res.published) HC.util.toast("Profile published ✓");
          else if (pub && !res.published) HC.util.toast("Can't publish yet — " + res.missing.length + " section(s) to finish");
          else HC.util.toast("Draft saved ✓");
        } catch (ignore) {}
        repaint();
      });

      whichEl.addEventListener("change", function () { loadCurrent(whichEl.value); });

      repaint();
    } catch (e) {
      mountEl.innerHTML = '<p style="color:#9a1f5e">Profile editor failed to load: ' +
        esc(e && e.message ? e.message : String(e)) + "</p>";
    }
  }

  /* ============================================================
   * 7. selfTest — exercises the LOGIC and asserts the acceptance
   *    criterion across multiple cases:
   *      Profile captures 'about you', class description AND practical
   *      booking info — three distinct fields, validated, persisted,
   *      and gating "publish" on all three being complete.
   * ============================================================ */

  function selfTest() {
    var pass = 0, fail = 0, log = [];
    function check(label, fn) {
      try { fn(); pass += 1; log.push("✓ " + label); }
      catch (e) { fail += 1; log.push("✗ " + label + " — " + (e && e.message ? e.message : String(e))); }
    }

    // A fully-filled, valid profile baseline (all three boxes present).
    function fullProfile() {
      return {
        aboutYou: "Run by qualified play and sports coaches with ten years of holiday-camp experience.",
        description: "A full day of sports, crafts and outdoor play. Children have huge fun while building confidence, teamwork and new skills.",
        practical: "Book online at our website. Drop-off 9am, pick-up 4pm; bring a packed lunch, water and sun cream. Free parking on site."
      };
    }

    clearSaved("test-profile");

    /* ---- ACCEPTANCE: the model has all THREE distinct content fields. ---- */
    check("Model defines exactly three content fields: about you, description, practical", function () {
      HC.assert(FIELD_KEYS.length === 3, "expected 3 fields, got " + FIELD_KEYS.length);
      HC.assert(FIELD_KEYS.indexOf("aboutYou") !== -1, "must have an 'about you' field");
      HC.assert(FIELD_KEYS.indexOf("description") !== -1, "must have a class/camp description field");
      HC.assert(FIELD_KEYS.indexOf("practical") !== -1, "must have a practical booking-info field");
    });

    /* ---- ACCEPTANCE: a profile with all three filled is complete. ---- */
    check("A profile with all three boxes filled is COMPLETE and ok", function () {
      var res = validateProfile(fullProfile());
      HC.assert(res.complete === true, "all-three-filled profile should be complete");
      HC.assert(res.ok === true, "complete profile should have no errors");
      HC.assert(res.filledCount === 3, "should count 3 complete sections, got " + res.filledCount);
      HC.assert(res.missing.length === 0, "nothing should be missing");
    });

    check("Each of the three fields is independently captured + assessed", function () {
      var res = validateProfile(fullProfile());
      HC.assert(res.statuses.aboutYou && res.statuses.aboutYou.complete, "about you should be complete");
      HC.assert(res.statuses.description && res.statuses.description.complete, "description should be complete");
      HC.assert(res.statuses.practical && res.statuses.practical.complete, "practical should be complete");
    });

    /* ---- ACCEPTANCE (negative): missing ANY one of the three blocks it. ---- */
    check("Missing 'about you' makes the profile incomplete", function () {
      var p = fullProfile(); p.aboutYou = "";
      var res = validateProfile(p);
      HC.assert(res.complete === false, "missing about-you must be incomplete");
      HC.assert(res.missing.indexOf("aboutYou") !== -1, "aboutYou should be listed as missing");
      HC.assert(!!res.errors.aboutYou, "should carry an aboutYou error");
    });

    check("Missing class description makes the profile incomplete", function () {
      var p = fullProfile(); p.description = "";
      var res = validateProfile(p);
      HC.assert(res.complete === false, "missing description must be incomplete");
      HC.assert(res.missing.indexOf("description") !== -1, "description should be listed as missing");
    });

    check("Missing practical booking info makes the profile incomplete", function () {
      var p = fullProfile(); p.practical = "";
      var res = validateProfile(p);
      HC.assert(res.complete === false, "missing practical info must be incomplete");
      HC.assert(res.missing.indexOf("practical") !== -1, "practical should be listed as missing");
    });

    check("A totally empty profile lists all three as missing", function () {
      var res = validateProfile(emptyProfile());
      HC.assert(res.complete === false, "empty profile is not complete");
      HC.assert(res.missing.length === 3, "all 3 should be missing, got " + res.missing.length);
      HC.assert(res.filledCount === 0, "filledCount should be 0");
    });

    /* ---- Too-short and whitespace-only content does not count as filled. ---- */
    check("A box with only whitespace does not count as filled", function () {
      var p = fullProfile(); p.practical = "      \n   ";
      var res = validateProfile(p);
      HC.assert(res.statuses.practical.filled === false, "whitespace should not count as filled");
      HC.assert(res.missing.indexOf("practical") !== -1, "whitespace practical should be missing");
    });

    check("Content below the minimum length is flagged short (not complete)", function () {
      var p = fullProfile(); p.aboutYou = "Hi there"; // < 25 chars
      var res = validateProfile(p);
      HC.assert(res.statuses.aboutYou.filled === true, "short text is still 'filled'");
      HC.assert(res.statuses.aboutYou.complete === false, "but not 'complete'");
      HC.assert(res.complete === false, "overall profile should be incomplete");
      HC.assert(!!res.errors.aboutYou, "should carry a short-content error");
    });

    /* ---- PUBLISH GATE: only a complete profile can be published. ---- */
    check("Publish is BLOCKED while a section is missing (nothing persisted)", function () {
      clearSaved("test-profile");
      var p = fullProfile(); p.description = "";
      var res = saveProfile("test-profile", p, { publish: true });
      HC.assert(res.published === false, "incomplete profile must not publish");
      HC.assert(res.saved === false, "blocked publish should not persist");
      var saved = readSaved();
      HC.assert(!saved["test-profile"], "nothing should be stored for a blocked publish");
    });

    check("Publish SUCCEEDS once all three sections are complete", function () {
      clearSaved("test-profile");
      var res = saveProfile("test-profile", fullProfile(), { publish: true });
      HC.assert(res.complete === true, "profile should be complete");
      HC.assert(res.published === true, "complete profile should publish");
      HC.assert(res.saved === true, "publish should persist");
    });

    /* ---- DRAFT SAVE: an incomplete profile can still be saved as a draft. ---- */
    check("An incomplete profile can be SAVED as a draft (not published)", function () {
      clearSaved("test-profile");
      var p = fullProfile(); p.practical = ""; // missing one
      var res = saveProfile("test-profile", p, { publish: false });
      HC.assert(res.saved === true, "draft save should persist even when incomplete");
      HC.assert(res.published === false, "a draft is not published");
      var saved = readSaved();
      HC.assert(saved["test-profile"], "draft should be in the store");
      HC.assert(saved["test-profile"].aboutYou.length > 0, "draft should keep the about-you text");
    });

    /* ---- PERSISTENCE round-trip: saved content re-reads on reload. ---- */
    check("Saved profile content round-trips through the store", function () {
      clearSaved("test-profile");
      var p = fullProfile();
      p.aboutYou = "We are a friendly Walthamstow multi-activity holiday camp run by DBS-checked coaches.";
      saveProfile("test-profile", p, { publish: true });
      var saved = readSaved()["test-profile"];
      HC.assert(saved.aboutYou.indexOf("Walthamstow") !== -1, "about-you text should persist verbatim");
      HC.assert(saved.description.length >= 25, "description should persist");
      HC.assert(saved.practical.length >= 20, "practical should persist");
      clearSaved("test-profile"); // leave store as found
    });

    check("Saving normalises (trims) whitespace but keeps content", function () {
      clearSaved("test-profile");
      var p = fullProfile();
      p.aboutYou = "   Lots   of    spaces   here   to   trim   into   one   line   nicely.   ";
      saveProfile("test-profile", p, { publish: false });
      var saved = readSaved()["test-profile"];
      HC.assert(saved.aboutYou.indexOf("  ") === -1, "double spaces should be collapsed");
      HC.assert(saved.aboutYou.charAt(0) !== " ", "leading space should be trimmed");
      clearSaved("test-profile");
    });

    check("validateProfile never mutates its input", function () {
      var p = fullProfile();
      var before = JSON.stringify(p);
      validateProfile(p);
      HC.assert(JSON.stringify(p) === before, "input profile must be unchanged after validation");
    });

    /* ---- LIVE DATA: a real camp pre-fills all three boxes from camps.js. ---- */
    check("A live camp pre-fills all three profile boxes from the directory", function () {
      var rows = drafts();
      HC.assert(rows.length >= 1, "expected >=1 provider draft, got " + rows.length);
      var d = rows[0];
      HC.assert(typeof d.aboutYou === "string", "draft should expose aboutYou");
      HC.assert(typeof d.description === "string", "draft should expose description");
      HC.assert(typeof d.practical === "string", "draft should expose practical");
      // Real verified directory copy means these are non-trivially populated.
      HC.assert(contentLen(d.description) > 0, "a live camp should pre-fill its description");
      HC.assert(contentLen(d.practical) > 0, "a live camp should pre-fill practical booking info");
    });

    check("A pre-filled live camp profile validates as complete", function () {
      var rows = drafts();
      // Find a live draft whose three boxes are all complete out of the box.
      var anyComplete = false;
      for (var i = 0; i < rows.length; i++) {
        if (validateProfile(rows[i]).complete) { anyComplete = true; break; }
      }
      HC.assert(anyComplete === true, "at least one live camp should pre-fill a complete 3-box profile");
    });

    check("Editing a live camp's three boxes saves and re-reads", function () {
      var rows = drafts();
      var d = rows[0];
      clearSaved(d.id);
      var edited = {
        aboutYou: "Updated about-you: a long-running, much-loved local holiday camp team.",
        description: "Updated description: a packed day of fun activities with real developmental benefits.",
        practical: "Updated practical: book online, 9-4 daily, packed lunch needed, step-free venue."
      };
      var res = saveProfile(d.id, edited, { publish: true });
      HC.assert(res.complete === true, "edited live profile should be complete");
      HC.assert(res.published === true, "edited live profile should publish");
      var saved = readSaved()[d.id];
      HC.assert(saved.aboutYou.indexOf("Updated about-you") !== -1, "edited about-you should persist");
      HC.assert(saved.practical.indexOf("step-free") !== -1, "edited practical should persist");
      // The reload path: draftFor must surface the saved overlay back.
      var provider = (HC.data.providers || [])[0];
      if (provider) {
        var reloaded = draftFor(provider, {});
        HC.assert(reloaded.description.indexOf("developmental benefits") !== -1,
          "saved overlay should be reflected on reload");
      }
      clearSaved(d.id); // leave store as found
    });

    return { pass: pass, fail: fail, log: log };
  }

  /* ============================================================
   * 8. Register (idempotent + defensive via core).
   * ============================================================ */
  HC.registerFeature({
    id: "provider-profile-content",
    title: "Profile content (About / Description / Booking info)",
    side: "provider",
    icon: "📝",
    summary: "Fill the three boxes parents read before booking: 'About you' (who you are, what makes you unique), the camp description (the fun plus the developmental benefits), and practical booking info (how to book, times, what to bring, getting there). Publish unlocks only when all three are complete.",
    render: render,
    selfTest: selfTest
  });
})();
