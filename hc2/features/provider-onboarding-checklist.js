/* HolidayCamp feature: provider-onboarding-checklist
 * ------------------------------------------------------------------
 * Replicates Happity's "I've just signed up — what do I do next?" /
 * "Have I set things up correctly?" guided setup flow for the
 * PROVIDER side, reframed for SCHOOL-AGE HOLIDAY CAMPS.
 *
 * Evidence (support corpus):
 *  - 6305972 "I've just signed up, what do I do next?": after a camp
 *    organiser registers and is verified, they "start to set up your
 *    classes" with help-centre guides; links straight to 5972946.
 *  - 5972946 "Have I set things up correctly?": the authoritative
 *    setup list. Free account: organisation About info (name +
 *    description), Contact details, create your activity, tag it with
 *    at least one category, add a schedule, create a price list +
 *    assign tickets. Member extras: logo & banner, Facebook link,
 *    connect Stripe, update legals (T&Cs / privacy), ensure event
 *    dates with enough spaces, then publish so it shows on the
 *    customer-facing site ("View on Happity").
 *
 * What this builds: a "what do I do next" onboarding checklist a new
 * holiday-camp provider works through, with COMPLETION STATE that
 * persists, dependency gating (you can't "publish" before the core
 * steps are done), live-data auto-detection (a step that's already
 * satisfied by camps.js is pre-ticked), and a percentage-complete
 * progress bar that culminates in a "ready to go live" state.
 *
 * Acceptance criterion (asserted by selfTest, multiple cases):
 *   "New providers see a guided setup checklist with completion
 *   state." A fresh provider starts at 0% with every required step
 *   incomplete; ticking steps advances persisted completion state and
 *   the progress percentage; the publish/go-live step is gated until
 *   its prerequisites are complete; completion round-trips through
 *   HC.store; resetting returns the provider to the start.
 *
 * Defensive: nothing throws at registration time. Persistence is via
 * HC.store ONLY (one namespaced overlay key); the verified camps.js
 * data is never mutated.
 * ------------------------------------------------------------------ */
(function () {
  "use strict";

  if (typeof window === "undefined" || !window.HC || typeof window.HC.registerFeature !== "function") {
    // Core not present — fail silently rather than throwing.
    return;
  }
  var HC = window.HC;

  var STORE_KEY = "provider_onboarding_checklist"; // { [providerId]: { steps:{id:true}, dismissed:bool } }

  /* ============================================================
   * 1. The checklist definition — mirrors evidence 5972946.
   *    Each step has:
   *      id        stable key (persisted)
   *      label     what the provider sees
   *      hint      one-line guidance, holiday-camp framed
   *      group     "essentials" (free account) | "members" (extras)
   *      required  counts toward "ready to go live"
   *      needs     ids that must be complete before this can be ticked
   *      detect(p) optional: returns true if live camps.js data already
   *                satisfies this step (so it is pre-ticked / auto-done)
   * ============================================================ */

  function trimStr(s) { return String(s == null ? "" : s).replace(/\s+/g, " ").trim(); }

  function hasText(v) { return !!trimStr(v); }

  var STEPS = [
    {
      id: "org_about",
      label: "Add your camp's About info",
      hint: "Organisation name, a description and a bit about who runs the holiday camp.",
      group: "essentials",
      required: true,
      needs: [],
      detect: function (p) {
        return p && hasText(p.name) && (hasText(p.goodFor) || hasText(p.summary) || hasText(p.description));
      }
    },
    {
      id: "org_contact",
      label: "Add your contact details",
      hint: "A website or booking link, email and (optionally) phone so families can reach you.",
      group: "essentials",
      required: true,
      needs: [],
      detect: function (p) {
        var web = "";
        try { web = (p && p.url) || (p && p.source && p.source.url) || ""; } catch (e) { web = ""; }
        return hasText(web);
      }
    },
    {
      id: "activity_create",
      label: "Create your holiday-camp activity",
      hint: "Set up the camp itself — e.g. Multi-Sports Camp or Forest School Week.",
      group: "essentials",
      required: true,
      needs: ["org_about"],
      detect: function (p) { return p && hasText(p.name); }
    },
    {
      id: "activity_category",
      label: "Tag it with at least one category",
      hint: "Pick up to two categories (Sports, Arts, STEM…) so parents can find your camp.",
      group: "essentials",
      required: true,
      needs: ["activity_create"],
      detect: function (p) {
        if (!p) return false;
        var c = p.categories || p.tags || p.category;
        if (Array.isArray(c)) return c.length > 0;
        return hasText(c);
      }
    },
    {
      id: "schedule_add",
      label: "Add a schedule (camp dates)",
      hint: "Add the weeks and days your holiday camp runs across the school break.",
      group: "essentials",
      required: true,
      needs: ["activity_create"],
      detect: function (p) {
        if (!p) return false;
        var d = p.dates || p.sessions || p.weeks || p.schedule;
        if (Array.isArray(d)) return d.length > 0;
        return false;
      }
    },
    {
      id: "prices_tickets",
      label: "Create prices & assign tickets",
      hint: "Set your day / week prices and the ticket types parents can book.",
      group: "essentials",
      required: true,
      needs: ["schedule_add"],
      detect: function (p) {
        if (!p) return false;
        var pr = p.price != null ? p.price : (p.prices || p.tickets);
        if (Array.isArray(pr)) return pr.length > 0;
        return pr != null && pr !== "" && pr !== false;
      }
    },
    // ---- Member extras (evidence 5972946 "For Happity members") ----
    {
      id: "logo_banner",
      label: "Add your logo & banner",
      hint: "Brand your booking page so it looks unmistakably yours.",
      group: "members",
      required: false,
      needs: [],
      detect: function (p) { return p && (hasText(p.logo) || hasText(p.banner) || hasText(p.image)); }
    },
    {
      id: "facebook_feed",
      label: "Add your Facebook link",
      hint: "Adds your Facebook feed to your profile — great social proof for parents.",
      group: "members",
      required: false,
      needs: ["org_contact"],
      detect: function (p) {
        try { return p && p.social && hasText(p.social.facebook); } catch (e) { return false; }
      }
    },
    {
      id: "stripe_connect",
      label: "Connect Stripe (if taking bookings)",
      hint: "Connect your Stripe account so parents can pay and book online.",
      group: "members",
      required: false,
      needs: [],
      detect: function () { return false; }
    },
    {
      id: "legals",
      label: "Update your legals (T&Cs & privacy)",
      hint: "Add your terms & conditions and privacy policy.",
      group: "members",
      required: false,
      needs: [],
      detect: function () { return false; }
    },
    {
      id: "dates_spaces",
      label: "Check event dates have enough spaces",
      hint: "Make sure each camp week has live dates and capacity for bookings.",
      group: "members",
      required: false,
      needs: ["schedule_add", "prices_tickets"],
      detect: function () { return false; }
    },
    // ---- The go-live gate. Mirrors "set to Published / View on Happity". ----
    {
      id: "publish",
      label: "Publish — go live on HolidayCamp",
      hint: "Once the essentials are ticked, publish so your camp shows to parents.",
      group: "golive",
      required: true,
      needs: ["org_about", "org_contact", "activity_create", "activity_category", "schedule_add", "prices_tickets"],
      detect: function () { return false; } // an explicit action, never auto-done
    }
  ];

  var STEP_BY_ID = {};
  STEPS.forEach(function (s) { STEP_BY_ID[s.id] = s; });

  var REQUIRED_IDS = STEPS.filter(function (s) { return s.required; }).map(function (s) { return s.id; });
  var PUBLISH_PREREQS = STEP_BY_ID.publish.needs.slice();

  /* ============================================================
   * 2. State: per-provider completion map, persisted via HC.store.
   *    Live-data detection seeds auto-completed steps so a provider
   *    who already has (say) a name + website doesn't start from
   *    absolute zero — but explicit ticks always win and persist.
   * ============================================================ */

  function readAll() {
    var all = HC.store.get(STORE_KEY, {});
    return (all && typeof all === "object") ? all : {};
  }

  function blankState() { return { steps: {}, dismissed: false }; }

  // Detected completion from live camps.js (not persisted; recomputed).
  function detectedSteps(provider) {
    var det = {};
    STEPS.forEach(function (s) {
      if (typeof s.detect !== "function") return;
      var ok = false;
      try { ok = !!s.detect(provider); } catch (e) { ok = false; }
      if (ok) det[s.id] = true;
    });
    return det;
  }

  function rawState(providerId) {
    var rec = readAll()[providerId];
    if (rec && typeof rec === "object") {
      return {
        steps: (rec.steps && typeof rec.steps === "object") ? rec.steps : {},
        dismissed: !!rec.dismissed
      };
    }
    return blankState();
  }

  // The effective completion map = persisted ticks OR'd with live detection.
  function effectiveSteps(provider, providerId) {
    var det = detectedSteps(provider);
    var saved = rawState(providerId).steps;
    var eff = {};
    STEPS.forEach(function (s) {
      eff[s.id] = !!(saved[s.id] || det[s.id]);
    });
    return eff;
  }

  function isComplete(eff, id) { return !!eff[id]; }

  // A step is unlocked once every prerequisite in `needs` is complete.
  function isUnlocked(eff, id) {
    var step = STEP_BY_ID[id];
    if (!step) return false;
    for (var i = 0; i < step.needs.length; i++) {
      if (!eff[step.needs[i]]) return false;
    }
    return true;
  }

  /* ============================================================
   * 3. Progress maths — the "completion state" the criterion needs.
   *    Percentage is over REQUIRED steps (the route to go-live);
   *    extras add credit but the headline number tracks essentials.
   * ============================================================ */

  function progress(eff) {
    var doneReq = 0;
    REQUIRED_IDS.forEach(function (id) { if (eff[id]) doneReq += 1; });
    var totalReq = REQUIRED_IDS.length;
    var pct = totalReq ? Math.round((doneReq / totalReq) * 100) : 0;

    var doneAll = 0;
    STEPS.forEach(function (s) { if (eff[s.id]) doneAll += 1; });

    var canPublish = PUBLISH_PREREQS.every(function (id) { return eff[id]; });
    var published = !!eff.publish;
    var live = published && canPublish;

    return {
      doneRequired: doneReq,
      totalRequired: totalReq,
      pct: pct,
      doneAll: doneAll,
      totalAll: STEPS.length,
      canPublish: canPublish,
      published: published,
      live: live,
      complete: doneReq === totalReq // every required step (incl. publish) done
    };
  }

  /* ============================================================
   * 4. Mutations — tick / untick / set, with persistence + gating.
   *    Returns { ok, reason?, state, progress }.
   * ============================================================ */

  function persist(providerId, state) {
    var all = readAll();
    all[providerId] = { steps: state.steps || {}, dismissed: !!state.dismissed };
    HC.store.set(STORE_KEY, all);
  }

  // Set a step's persisted completion. Honours dependency gating when
  // marking complete (cannot tick a locked step). Unticking is always
  // allowed but cascades: dependants that relied on it become locked
  // (their persisted tick is cleared so state stays consistent).
  function setStep(provider, providerId, id, done) {
    var step = STEP_BY_ID[id];
    if (!step) return { ok: false, reason: "unknown step", state: rawState(providerId), progress: progress(effectiveSteps(provider, providerId)) };

    var saved = rawState(providerId);
    var steps = {};
    for (var k in saved.steps) if (Object.prototype.hasOwnProperty.call(saved.steps, k)) steps[k] = saved.steps[k];

    if (done) {
      // Gate: prerequisites (via effective state) must be complete.
      var effNow = effectiveSteps(provider, providerId);
      if (!isUnlocked(effNow, id)) {
        return { ok: false, reason: "locked", state: saved, progress: progress(effNow) };
      }
      steps[id] = true;
    } else {
      delete steps[id];
      // Cascade: clear persisted ticks for steps that depend (directly or
      // transitively) on this one and are now no longer unlocked.
      var changed = true;
      while (changed) {
        changed = false;
        var effEval = effWith(provider, steps);
        STEPS.forEach(function (s) {
          if (steps[s.id] && !isUnlocked(effEval, s.id)) {
            delete steps[s.id];
            changed = true;
          }
        });
      }
    }

    var newState = { steps: steps, dismissed: saved.dismissed };
    persist(providerId, newState);
    return { ok: true, state: newState, progress: progress(effectiveSteps(provider, providerId)) };
  }

  // Effective steps given an arbitrary persisted-ticks object (used by
  // the un-tick cascade so detection still counts during evaluation).
  function effWith(provider, persistedSteps) {
    var det = detectedSteps(provider);
    var eff = {};
    STEPS.forEach(function (s) {
      eff[s.id] = !!(persistedSteps[s.id] || det[s.id]);
    });
    return eff;
  }

  function resetProvider(providerId) {
    var all = readAll();
    delete all[providerId];
    HC.store.set(STORE_KEY, all);
  }

  /* ============================================================
   * 5. Render — the "What do I do next?" onboarding panel.
   * ============================================================ */

  function firstProvider() {
    var list = HC.data.providers || [];
    return list.length ? list[0] : null;
  }

  function providerIdOf(provider) {
    if (provider && provider.id != null) return String(provider.id);
    return "demo-provider";
  }

  function escAttr(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  var GROUP_LABEL = {
    essentials: "Essentials — get listed",
    members: "Member extras — stand out",
    golive: "Go live"
  };

  function render(mountEl) {
    try {
      var provider = firstProvider();
      var providerId = providerIdOf(provider);
      var providerName = provider ? (provider.name || providerId) : "your camp";

      function draw() {
        var eff = effectiveSteps(provider, providerId);
        var prog = progress(eff);
        var det = detectedSteps(provider);

        var groupsOrder = ["essentials", "members", "golive"];
        var rowsHtml = "";
        groupsOrder.forEach(function (g) {
          var inGroup = STEPS.filter(function (s) { return s.group === g; });
          if (!inGroup.length) return;
          rowsHtml += '<div class="poc-group">' + escAttr(GROUP_LABEL[g] || g) + "</div>";
          inGroup.forEach(function (s) {
            var done = isComplete(eff, s.id);
            var unlocked = isUnlocked(eff, s.id);
            var auto = !!det[s.id] && !rawState(providerId).steps[s.id];
            var cls = "poc-step" + (done ? " done" : "") + (!unlocked && !done ? " locked" : "");
            rowsHtml +=
              '<label class="' + cls + '">' +
                '<input type="checkbox" class="poc-cb" data-step="' + escAttr(s.id) + '"' +
                  (done ? " checked" : "") + ((!unlocked && !done) ? " disabled" : "") + ">" +
                '<span class="poc-box" aria-hidden="true">' + (done ? "✓" : "") + "</span>" +
                '<span class="poc-text">' +
                  '<span class="poc-label">' + escAttr(s.label) +
                    (s.required ? '' : ' <span class="poc-opt">optional</span>') +
                    (auto ? ' <span class="poc-auto">auto-detected</span>' : '') +
                    ((!unlocked && !done) ? ' <span class="poc-lock">🔒 locked</span>' : '') +
                  "</span>" +
                  '<span class="poc-hint">' + escAttr(s.hint) + "</span>" +
                "</span>" +
              "</label>";
          });
        });

        var statusLine = prog.live
          ? "🎉 You're live! Parents can now find and book " + escAttr(providerName) + "."
          : (prog.canPublish
              ? "All essentials done — tick <strong>Publish</strong> to go live."
              : "Work through the essentials below. You can publish once they're all ticked.");

        mountEl.innerHTML =
          '<style>' +
            '.poc-wrap{font-family:"Nunito Sans",system-ui,sans-serif;color:var(--text,#383838)}' +
            '.poc-intro{font-size:13.5px;margin:0 0 12px}' +
            '.poc-bar{height:14px;border-radius:999px;background:var(--purple-tint,#F0E8F4);overflow:hidden;margin:4px 0 6px}' +
            '.poc-fill{height:100%;background:linear-gradient(90deg,var(--magenta,#F82488),var(--purple,#603488));' +
              'border-radius:999px;transition:width .3s;min-width:0}' +
            '.poc-meta{display:flex;justify-content:space-between;font-family:"Quicksand",system-ui,sans-serif;' +
              'font-weight:700;font-size:12.5px;color:var(--purple,#603488);margin:0 0 10px}' +
            '.poc-status{font-size:13px;background:#FBF8FD;border:1.5px solid var(--purple-tint,#F0E8F4);' +
              'border-radius:12px;padding:9px 12px;margin:0 0 14px}' +
            '.poc-status.live{background:#E1F0E4;border-color:#bfe3c9;color:#2f7d4f;font-weight:700}' +
            '.poc-group{font-family:"Quicksand",system-ui,sans-serif;color:var(--magenta,#F82488);text-transform:uppercase;' +
              'letter-spacing:.5px;font-size:11px;font-weight:700;margin:14px 0 6px}' +
            '.poc-step{display:flex;gap:10px;align-items:flex-start;padding:9px 11px;border:1.5px solid var(--line,#E6E6E6);' +
              'border-radius:12px;margin:0 0 7px;cursor:pointer;background:#fff}' +
            '.poc-step:hover{border-color:var(--purple-tint,#F0E8F4)}' +
            '.poc-step.done{background:#FBFCFB;border-color:#cfe8d6}' +
            '.poc-step.locked{opacity:.55;cursor:not-allowed}' +
            '.poc-cb{position:absolute;opacity:0;width:0;height:0}' +
            '.poc-box{flex:0 0 22px;height:22px;width:22px;border-radius:7px;border:2px solid var(--purple-tint,#C9B6D9);' +
              'display:grid;place-items:center;color:#fff;font-size:13px;font-weight:700;margin-top:1px}' +
            '.poc-step.done .poc-box{background:#2f7d4f;border-color:#2f7d4f}' +
            '.poc-text{display:flex;flex-direction:column;gap:2px}' +
            '.poc-label{font-family:"Quicksand",system-ui,sans-serif;font-weight:700;font-size:13.5px;color:var(--purple,#603488)}' +
            '.poc-hint{font-size:12px;color:var(--muted,#808080)}' +
            '.poc-opt,.poc-auto,.poc-lock{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.3px;' +
              'padding:2px 6px;border-radius:999px;margin-left:5px;vertical-align:middle}' +
            '.poc-opt{background:var(--purple-tint,#F0E8F4);color:var(--purple,#603488)}' +
            '.poc-auto{background:#E1F0E4;color:#2f7d4f}' +
            '.poc-lock{background:#FCE8F0;color:#9a1f5e}' +
            '.poc-actions{display:flex;gap:10px;margin-top:12px}' +
          '</style>' +
          '<div class="poc-wrap">' +
            '<p class="poc-intro">You\'ve signed up — here\'s <strong>what to do next</strong>. Work through this guided ' +
              'checklist to get <strong>' + escAttr(providerName) + '</strong> ready for parents. Your progress is saved as you go.</p>' +
            '<div class="poc-meta"><span>' + prog.doneRequired + ' of ' + prog.totalRequired + ' essentials</span>' +
              '<span>' + prog.pct + '% complete</span></div>' +
            '<div class="poc-bar"><div class="poc-fill" style="width:' + prog.pct + '%"></div></div>' +
            '<div class="poc-status' + (prog.live ? ' live' : '') + '">' + statusLine + '</div>' +
            rowsHtml +
            '<div class="poc-actions">' +
              '<button type="button" class="hc-btn hc-btn-ghost" id="pocReset">Start over</button>' +
            '</div>' +
          '</div>';

        mountEl.querySelectorAll(".poc-cb").forEach(function (cb) {
          cb.addEventListener("change", function () {
            var id = cb.getAttribute("data-step");
            var res = setStep(provider, providerId, id, cb.checked);
            if (!res.ok && res.reason === "locked") {
              HC.util.toast("Finish the earlier steps first");
            } else if (cb.checked && id === "publish" && res.ok) {
              HC.util.toast("🎉 You're live on HolidayCamp!");
            }
            draw(); // re-render to reflect gating + progress
          });
        });

        var resetBtn = mountEl.querySelector("#pocReset");
        if (resetBtn) {
          resetBtn.addEventListener("click", function () {
            resetProvider(providerId);
            HC.util.toast("Checklist reset");
            draw();
          });
        }
      }

      draw();
    } catch (e) {
      mountEl.innerHTML = '<p style="color:#9a1f5e">Onboarding checklist failed to render: ' +
        escAttr(e && e.message ? e.message : String(e)) + "</p>";
    }
  }

  /* ============================================================
   * 6. selfTest — exercises the LOGIC and asserts the acceptance
   *    criterion: "New providers see a guided setup checklist with
   *    completion state." Multiple cases. Sandboxes + restores store.
   * ============================================================ */

  function selfTest() {
    var pass = 0, fail = 0, log = [];
    function check(label, fn) {
      try { fn(); pass += 1; log.push("✓ " + label); }
      catch (e) { fail += 1; log.push("✗ " + label + " — " + (e && e.message ? e.message : String(e))); }
    }

    var BACKUP = HC.store.get(STORE_KEY, null);
    HC.store.set(STORE_KEY, {});

    try {
      // A clean synthetic provider with NO live-data hits, so detection
      // never pre-ticks anything — a true "brand new" provider.
      var BLANK = { id: "st-blank-provider", name: "" };
      var bid = providerIdOf(BLANK);

      check("Checklist is defined with grouped, ordered steps", function () {
        HC.assert(STEPS.length >= 8, "expected a substantive checklist, got " + STEPS.length);
        HC.assert(STEP_BY_ID.publish, "a go-live/publish step must exist");
        HC.assert(REQUIRED_IDS.length >= 5, "expected several required essentials, got " + REQUIRED_IDS.length);
      });

      // === ACCEPTANCE: a NEW provider sees the checklist at zero state. ===
      check("ACCEPTANCE: a brand-new provider starts at 0% with every required step incomplete", function () {
        var eff = effectiveSteps(BLANK, bid);
        REQUIRED_IDS.forEach(function (id) {
          HC.assert(eff[id] === false, "required step '" + id + "' should start incomplete");
        });
        var prog = progress(eff);
        HC.assert(prog.pct === 0, "fresh provider should be 0%, got " + prog.pct);
        HC.assert(prog.doneRequired === 0, "no required steps should be done, got " + prog.doneRequired);
        HC.assert(prog.complete === false, "fresh provider is not complete");
        HC.assert(prog.live === false, "fresh provider is not live");
      });

      // === ACCEPTANCE: ticking advances persisted completion state. ===
      check("ACCEPTANCE: ticking a step advances completion state and persists it", function () {
        var r1 = setStep(BLANK, bid, "org_about", true);
        HC.assert(r1.ok, "ticking the first step should succeed");
        var eff = effectiveSteps(BLANK, bid);
        HC.assert(eff.org_about === true, "org_about should now be complete");
        HC.assert(r1.progress.doneRequired === 1, "doneRequired should be 1, got " + r1.progress.doneRequired);
        HC.assert(r1.progress.pct > 0, "percentage should rise above 0, got " + r1.progress.pct);
        // persisted?
        var raw = HC.store.get(STORE_KEY, {});
        HC.assert(raw[bid] && raw[bid].steps && raw[bid].steps.org_about === true,
          "completion state must be persisted to the store");
      });

      check("Completion state round-trips through HC.store (fresh read)", function () {
        var eff = effectiveSteps(BLANK, bid);
        HC.assert(eff.org_about === true, "previously-ticked step must survive a fresh read");
      });

      // === Dependency gating: publish is locked until prereqs done. ===
      check("Publish/go-live is locked until its prerequisites are complete", function () {
        var eff = effectiveSteps(BLANK, bid);
        HC.assert(isUnlocked(eff, "publish") === false, "publish must be locked while essentials are incomplete");
        var blocked = setStep(BLANK, bid, "publish", true);
        HC.assert(blocked.ok === false && blocked.reason === "locked", "ticking publish early must be rejected as locked");
        HC.assert(effectiveSteps(BLANK, bid).publish === false, "publish must remain incomplete after a blocked attempt");
      });

      check("A step is locked until its own prerequisites are met", function () {
        // prices_tickets needs schedule_add needs activity_create needs org_about.
        var eff = effectiveSteps(BLANK, bid);
        HC.assert(isUnlocked(eff, "prices_tickets") === false, "prices should be locked before schedule exists");
        var blocked = setStep(BLANK, bid, "prices_tickets", true);
        HC.assert(blocked.ok === false, "cannot tick a locked step");
      });

      // === Walk the whole essentials chain to 100% and go live. ===
      check("ACCEPTANCE: completing all essentials unlocks publish and reaches 100% / live", function () {
        ["activity_create", "activity_category", "schedule_add", "prices_tickets", "org_contact"].forEach(function (id) {
          var r = setStep(BLANK, bid, id, true);
          HC.assert(r.ok, "step '" + id + "' should tick once unlocked");
        });
        var eff = effectiveSteps(BLANK, bid);
        HC.assert(progress(eff).canPublish === true, "publish should now be unlocked");
        var pub = setStep(BLANK, bid, "publish", true);
        HC.assert(pub.ok, "publish should succeed once prerequisites are done");
        var prog = progress(effectiveSteps(BLANK, bid));
        HC.assert(prog.pct === 100, "all essentials done should be 100%, got " + prog.pct);
        HC.assert(prog.complete === true, "checklist should report complete");
        HC.assert(prog.live === true, "provider should be live after publishing");
      });

      // === Unticking cascades so state stays consistent. ===
      check("Unticking a prerequisite cascades and re-locks dependants (incl. publish)", function () {
        var r = setStep(BLANK, bid, "schedule_add", false);
        HC.assert(r.ok, "unticking should succeed");
        var eff = effectiveSteps(BLANK, bid);
        HC.assert(eff.schedule_add === false, "schedule_add should now be incomplete");
        HC.assert(eff.prices_tickets === false, "prices_tickets depended on schedule and must re-lock");
        HC.assert(eff.publish === false, "publish must drop because a prerequisite was undone");
        HC.assert(progress(eff).live === false, "provider should no longer be live");
      });

      // === Live-data auto-detection for the real first provider. ===
      check("Live camps.js data auto-detects already-satisfied steps for the real provider", function () {
        var real = firstProvider();
        if (!real) { log.push("  (no live provider; detection check skipped)"); return; }
        var rid = providerIdOf(real);
        resetProvider(rid); // no persisted ticks — detection only
        var det = detectedSteps(real);
        // A real listing has a name + about/contact, so at least one
        // essential should be auto-detected without any manual ticks.
        var anyAuto = Object.keys(det).length > 0;
        HC.assert(anyAuto, "expected live data to auto-detect at least one completed step");
        var eff = effectiveSteps(real, rid);
        HC.assert(progress(eff).pct > 0, "auto-detection should lift a real provider above 0%");
        resetProvider(rid);
      });

      // === Reset returns the provider to the start. ===
      check("Resetting returns the provider to a clean 0% checklist", function () {
        resetProvider(bid);
        var eff = effectiveSteps(BLANK, bid);
        REQUIRED_IDS.forEach(function (id) {
          HC.assert(eff[id] === false, "step '" + id + "' should be clear after reset");
        });
        HC.assert(progress(eff).pct === 0, "reset should return to 0%");
        var raw = HC.store.get(STORE_KEY, {});
        HC.assert(!raw[bid], "no persisted record should remain after reset");
      });

      check("Persistence is namespaced and never mutates camps.js", function () {
        var real = firstProvider();
        if (real) {
          var liveName = real.name;
          effectiveSteps(real, providerIdOf(real)); // touch
          HC.assert(real.name === liveName, "live provider object must be untouched");
        }
        // Our store key lives under the hc_ namespace via HC.store only.
        HC.assert(typeof STORE_KEY === "string" && STORE_KEY.indexOf("provider_onboarding") === 0,
          "store key should be the namespaced onboarding key");
      });

    } finally {
      if (BACKUP === null) HC.store.remove(STORE_KEY);
      else HC.store.set(STORE_KEY, BACKUP);
    }

    return { pass: pass, fail: fail, log: log };
  }

  /* ============================================================
   * 7. Register.
   * ============================================================ */

  HC.registerFeature({
    id: "provider-onboarding-checklist",
    title: "Onboarding: what do I do next?",
    side: "provider",
    icon: "🧭",
    summary: "A guided 'what do I do next' setup checklist for new holiday-camp providers — work through the essentials (About, contact, activity, category, schedule, prices) then publish to go live. Tracks completion state, auto-detects steps already done, and gates publishing until you're ready.",
    render: render,
    selfTest: selfTest
  });
})();
