/* HolidayCamp feature module — platform-eligibility-policy
 *
 * Side: PLATFORM.
 * Replicates Happity's published "who may list" policy page — the help-centre
 * article "I would like to list my classes on Happity, am I eligible?"
 * (support article 11392600). Where provider-eligibility-gate is the per-
 * provider GATE at sign-up, THIS feature is the PLATFORM's public-facing
 * POLICY PAGE: a single, versioned, indexable document that states, in plain
 * English, who may list on HolidayCamp and who is not a good fit — the
 * authoritative source the gate is derived from.
 *
 * Evidence (article 11392600):
 *   - "We welcome providers offering group classes and activities…" followed by
 *     an explicit "examples of those who can list" list.
 *   - A "[Happity] may not be the best fit if you are:" list (party entertainers
 *     for one-off private parties, 1-2-1 sleep consultations, childcare settings
 *     offering general childcare rather than timetabled sessions, etc.).
 *   - The core rule: "you can't get found … unless you list at least one
 *     class/event with a day, time, and venue attached."
 *
 * Framed for SCHOOL-AGE HOLIDAY CAMPS (not baby classes): the policy welcomes
 * GROUP children's holiday camps and activities the PUBLIC can book, with a
 * timetable + venue; it is not a fit for 1-to-1 / private tuition, one-off
 * PRIVATE parties, or general childcare with no timetabled sessions.
 *
 * ACCEPTANCE CRITERION (asserted in selfTest, multiple cases):
 *   A policy page STATES WHO MAY LIST. We verify the policy document renders a
 *   "who may list" section naming group children's camps, a "not a good fit"
 *   section naming 1-to-1 and private parties, a stated core rule, and that the
 *   page's structured policy correctly classifies real cases (a group camp may
 *   list; a 1-to-1 tutor and a private party may not).
 *
 * Self-contained, defensive, no imports/exports. Calls HC.registerFeature.
 */
(function () {
  "use strict";

  if (typeof window === "undefined" || !window.HC ||
      typeof window.HC.registerFeature !== "function") {
    if (typeof console !== "undefined" && console.warn) {
      console.warn("[HC] platform-eligibility-policy: HC core not found; skipping registration.");
    }
    return; // nothing to attach to — fail silent, never throw.
  }

  var HC = window.HC;

  var STORE_VERSION_KEY = "platform_eligibility_policy_acceptedVersion";
  var POLICY_URL = "/policy/who-can-list";

  /* ============================================================
     THE POLICY DOCUMENT — the page that states who may list.
     A single source of truth: version, intro, the welcome rule,
     two named lists (who CAN list / not a good fit), the core
     "day, time & venue" rule, and the borderline (taster) clause.
     ============================================================ */
  var POLICY = {
    version: "2026.1",
    url: POLICY_URL,
    title: "Who can list on HolidayCamp?",
    updated: "2026-06-15",
    lede:
      "HolidayCamp is the booking and discovery platform built for school-age " +
      "HOLIDAY CAMPS and holiday activities. We show families camps near them " +
      "with the days, times and venues — so it works best for GROUP camps the " +
      "public can book.",

    // The headline eligibility statement.
    welcome:
      "We welcome providers running GROUP holiday camps and activities for " +
      "school-age children (roughly 4–14) that the public can book.",

    // Examples of WHO MAY LIST (the article's "those who can list" list,
    // reworked for school-age holiday camps).
    canList: [
      "Multi-activity holiday camps (group days, open to the public)",
      "Sports, games & multi-sports holiday camps",
      "Forest school / outdoor adventure camps (group days, not childminding)",
      "Arts, drama, dance & music holiday workshops",
      "Coding / STEM / Lego camps with a set timetable",
      "Stage-school and performing-arts holiday intensives",
      "Council / HAF holiday activity & food (HAF) sessions",
      "One-off public events with a day, time and venue (e.g. a family activity day)"
    ],

    // Examples of who is NOT a good fit (the article's "may not be the best
    // fit if you are" list).
    notAFit: [
      "A private 1-to-1 tutor or coach (e.g. personal sports, music or maths tuition)",
      "A party entertainer hired for one-off PRIVATE parties (a single family's party)",
      "A childminder or nursery offering general childcare rather than timetabled camps",
      "A 1-2-1 consultant (e.g. a sleep or behaviour consultant)",
      "Anyone with no public camp/event carrying a day, time and venue"
    ],

    // The core rule, stated verbatim-in-spirit from the article.
    coreRule:
      "You can't be found on HolidayCamp unless you list at least one camp or " +
      "event with a day, time and venue attached.",

    // The article's escape-hatch: a borderline provider can still list the
    // public GROUP part of what they offer (e.g. taster days).
    borderlineClause:
      "Offer 1-to-1 tuition AND run public group taster days or holiday camps? " +
      "You're welcome to list the public GROUP sessions — the private 1-to-1 " +
      "side just stays off HolidayCamp.",

    contact: "support@holidaycamp.example"
  };

  /* ============================================================
     PURE POLICY LOGIC (DOM-free, testable).
     The page doesn't just *display* the policy — it APPLIES it, so
     a provider can check themselves against the stated rules.
     ============================================================ */

  function asText(v) { return typeof v === "string" ? v : (v == null ? "" : String(v)); }

  // Phrase banks used only as a backstop when structured answers are missing.
  var PRIVATE_PHRASES = [
    "1-to-1", "1 to 1", "one-to-one", "one to one", "1-2-1", "1 2 1",
    "private party", "private parties", "private tuition", "private tutor",
    "private lesson", "private coaching", "private consultation",
    "private consultations", "sleep consultant", "sleep consultation",
    "personal tutor", "personal coaching", "single family",
    "hire me for your party", "party entertainer", "childminding",
    "general childcare"
  ];
  var GROUP_PHRASES = [
    "group", "holiday camp", "holiday club", "multi-activity", "multi activity",
    "workshop", "public sessions", "open sessions", "timetable", "summer camp",
    "easter camp", "half term", "taster session", "taster day", "activity day",
    "festival", "forest school", "stem", "coding"
  ];

  function hasPhrase(text, list) {
    var hay = asText(text).toLowerCase();
    if (!hay) return false;
    for (var i = 0; i < list.length; i++) {
      if (hay.indexOf(list[i]) !== -1) return true;
    }
    return false;
  }

  // Normalise a loose answer object into canonical policy fields.
  //   format        : 'group' | 'one_to_one' | 'mixed' | 'unknown'
  //   audience      : 'public' | 'private'
  //   hasTimetabled : Boolean — at least one camp with day+time+venue
  //   runsPublicGroupSessions : Boolean — the taster escape hatch
  function normalise(ans) {
    var a = (ans && typeof ans === "object" && !Array.isArray(ans)) ? ans : {};
    var format = a.format;
    if (format !== "group" && format !== "one_to_one" && format !== "mixed") {
      var grp = hasPhrase(a.offering, GROUP_PHRASES);
      var priv = hasPhrase(a.offering, PRIVATE_PHRASES);
      if (grp && !priv) format = "group";
      else if (priv && !grp) format = "one_to_one";
      else if (grp && priv) format = "mixed";
      else format = "unknown";
    }
    var audience = (a.audience === "public" || a.audience === "private") ? a.audience : null;
    if (audience === null) {
      audience = hasPhrase(a.offering, ["private party", "private parties", "single family"])
        ? "private" : "public";
    }
    return {
      format: format,
      audience: audience,
      hasTimetabled: a.hasTimetabled === true,
      runsPublicGroupSessions: a.runsPublicGroupSessions === true,
      offering: asText(a.offering)
    };
  }

  // Apply the PUBLISHED policy to an offering. Returns:
  //   mayList        : Boolean
  //   verdict        : 'may-list' | 'list-group-part' | 'not-a-fit'
  //   policyClause   : String — which part of the policy decided it
  //   needsTimetable : Boolean — eligible but must add a day/time/venue listing
  function applyPolicy(answers) {
    var a = normalise(answers);

    // A one-off PRIVATE party / private hire is the flagship "not a fit" case.
    if (a.audience === "private") {
      return verdict(false, "not-a-fit",
        "Policy: HolidayCamp lists camps the public can book. One-off private " +
        "parties (a single family's private booking) aren't a fit — there's no " +
        "public camp with a day, time and venue to be found by.",
        false);
    }

    // Pure 1-to-1 / private tuition: not a fit unless they also run public group.
    if (a.format === "one_to_one") {
      if (a.runsPublicGroupSessions) {
        return verdict(true, "list-group-part",
          "Policy (borderline): 1-to-1 tuition itself can't be listed, but you " +
          "may list any public GROUP taster days or holiday camps you run.",
          true);
      }
      return verdict(false, "not-a-fit",
        "Policy: HolidayCamp is for GROUP children's camps, not private 1-to-1 " +
        "tuition or coaching.",
        false);
    }

    // Mixed (group + 1-to-1): list the group part.
    if (a.format === "mixed") {
      return verdict(true, "list-group-part",
        "Policy: you may list the GROUP holiday-camp part of what you offer. " +
        "(The private 1-to-1 side stays off HolidayCamp.)",
        !a.hasTimetabled);
    }

    // Group + public = the clear YES.
    if (a.format === "group" && a.audience === "public") {
      return verdict(true, "may-list",
        "Policy: a public group holiday camp is exactly what HolidayCamp lists.",
        !a.hasTimetabled);
    }

    // Group, audience not clearly stated — eligible but reminded to be public.
    if (a.format === "group") {
      return verdict(true, "may-list",
        "Policy: a group children's camp may list — make sure sessions are open " +
        "for the public to book.",
        !a.hasTimetabled);
    }

    // Couldn't classify — the policy can't say yes.
    return verdict(false, "not-a-fit",
      "Policy: we couldn't tell this is a public group children's camp. " +
      "HolidayCamp lists group camps with a day, time and venue.",
      false);
  }

  function verdict(mayList, code, clause, needsTimetable) {
    return {
      mayList: !!mayList,
      verdict: code,
      policyClause: clause,
      needsTimetable: !!needsTimetable
    };
  }

  /* ============================================================
     PERSISTENCE — record that this version of the policy was read
     / acknowledged (HC.store only, never raw localStorage).
     ============================================================ */
  function acceptedVersion() {
    try { return HC.store.get(STORE_VERSION_KEY, null); } catch (e) { return null; }
  }
  function acknowledgePolicy() {
    try { HC.store.set(STORE_VERSION_KEY, POLICY.version); return true; }
    catch (e) { return false; }
  }
  function isCurrentVersionAccepted() {
    return acceptedVersion() === POLICY.version;
  }

  /* ============================================================
     RENDER — the policy PAGE itself (the acceptance-criterion UI),
     plus a live "check yourself against this policy" widget.
     ============================================================ */

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

  function listHtml(items) {
    var lis = "";
    for (var i = 0; i < items.length; i++) {
      lis += '<li style="margin:0 0 6px">' + esc(items[i]) + "</li>";
    }
    return '<ul style="margin:6px 0 0;padding-left:20px;color:var(--text,#383838);' +
      'font-size:13.5px;line-height:1.5">' + lis + "</ul>";
  }

  function verdictBadge(res) {
    var bg, fg, txt;
    if (res.verdict === "may-list") { bg = "#E1F0E4"; fg = "#2f7d4f"; txt = "✓ You may list"; }
    else if (res.verdict === "list-group-part") { bg = "#FFF4D6"; fg = "#8a6d00"; txt = "◐ List the group part"; }
    else { bg = "#FCE8F0"; fg = "#9a1f5e"; txt = "✕ Not a good fit"; }
    return '<span style="display:inline-block;font-family:Quicksand,system-ui,sans-serif;' +
      "font-weight:700;font-size:12.5px;padding:4px 11px;border-radius:999px;background:" +
      bg + ";color:" + fg + '">' + txt + "</span>";
  }

  function renderCheckResult(host, res) {
    host.innerHTML =
      '<div style="border:1.5px solid var(--line,#E6E6E6);border-radius:14px;padding:14px 16px;background:#fff">' +
        verdictBadge(res) +
        '<p style="margin:10px 0 0;font-size:13.5px;color:var(--text,#383838);line-height:1.5">' +
          esc(res.policyClause) + "</p>" +
        (res.needsTimetable
          ? '<p style="margin:8px 0 0;font-size:12.5px;color:var(--magenta,#F82488);font-weight:700">' +
            "Core rule: you can't be found until you list at least one camp with a day, time &amp; venue.</p>"
          : "") +
      "</div>";
  }

  function render(mountEl) {
    try {
      if (!mountEl) return;
      mountEl.innerHTML = "";

      // ---- The policy page header ----
      var header = el("div", null,
        '<div style="font-size:11px;text-transform:uppercase;letter-spacing:.5px;font-weight:700;' +
          'color:var(--magenta,#F82488)">Platform policy · <code>' + esc(POLICY.url) + "</code></div>" +
        '<div style="font-family:Quicksand,system-ui,sans-serif;font-weight:700;font-size:21px;' +
          'color:var(--purple,#603488);margin:2px 0 2px">' + esc(POLICY.title) + "</div>" +
        '<div style="font-size:12px;color:var(--muted,#808080)">Version ' + esc(POLICY.version) +
          " · updated " + esc(POLICY.updated) + "</div>" +
        '<p style="font-size:14px;color:var(--text,#383838);line-height:1.55;margin:12px 0 0">' +
          esc(POLICY.lede) + "</p>");
      mountEl.appendChild(header);

      // ---- The headline "who may list" statement ----
      var welcome = el("div", {
        style: "margin:14px 0 4px;border-left:4px solid var(--purple,#603488);" +
          "background:var(--purple-tint,#F0E8F4);padding:11px 14px;border-radius:0 10px 10px 0"
      },
        '<div style="font-family:Quicksand,system-ui,sans-serif;font-weight:700;font-size:13px;' +
          'color:var(--purple,#603488)">Who may list</div>' +
        '<p style="margin:4px 0 0;font-size:13.5px;color:var(--text,#383838);line-height:1.5">' +
          esc(POLICY.welcome) + "</p>");
      mountEl.appendChild(welcome);

      // ---- The two named lists ----
      var lists = el("div", {
        style: "display:grid;grid-template-columns:1fr 1fr;gap:14px;margin:14px 0 14px"
      });
      lists.innerHTML =
        '<div style="border:1.5px solid #CFE9D6;border-radius:14px;padding:12px 14px;background:#F4FBF6">' +
          '<div style="font-family:Quicksand,system-ui,sans-serif;font-weight:700;color:#2f7d4f">✓ You can list</div>' +
          listHtml(POLICY.canList) +
        "</div>" +
        '<div style="border:1.5px solid #F4CFE0;border-radius:14px;padding:12px 14px;background:#FFF6FA">' +
          '<div style="font-family:Quicksand,system-ui,sans-serif;font-weight:700;color:#9a1f5e">✕ May not be a good fit</div>' +
          listHtml(POLICY.notAFit) +
        "</div>";
      mountEl.appendChild(lists);

      // ---- The core rule + borderline clause ----
      var rules = el("div", null,
        '<div style="border:1.5px solid var(--line,#E6E6E6);border-radius:12px;padding:11px 14px;margin:0 0 10px">' +
          '<div style="font-family:Quicksand,system-ui,sans-serif;font-weight:700;font-size:12.5px;' +
            'text-transform:uppercase;letter-spacing:.4px;color:var(--magenta,#F82488)">The core rule</div>' +
          '<p style="margin:5px 0 0;font-size:13.5px;color:var(--text,#383838);line-height:1.5">' +
            esc(POLICY.coreRule) + "</p>" +
        "</div>" +
        '<div style="border:1.5px solid var(--line,#E6E6E6);border-radius:12px;padding:11px 14px">' +
          '<div style="font-family:Quicksand,system-ui,sans-serif;font-weight:700;font-size:12.5px;' +
            'text-transform:uppercase;letter-spacing:.4px;color:var(--purple,#603488)">Run both group &amp; 1-to-1?</div>' +
          '<p style="margin:5px 0 0;font-size:13.5px;color:var(--text,#383838);line-height:1.5">' +
            esc(POLICY.borderlineClause) + "</p>" +
        "</div>");
      mountEl.appendChild(rules);

      // ---- "Check yourself against this policy" widget ----
      var form = el("div", {
        style: "border-top:1px solid var(--line,#E6E6E6);margin-top:16px;padding-top:14px"
      });
      form.innerHTML =
        '<div style="font-family:Quicksand,system-ui,sans-serif;font-weight:700;' +
          'color:var(--purple,#603488);margin-bottom:8px">Check yourself against this policy</div>' +
        '<label style="display:block;font-size:13px;margin:0 0 8px">Format ' +
          '<select id="polFormat" style="margin-left:6px">' +
            '<option value="group">Group holiday camp</option>' +
            '<option value="one_to_one">1-to-1 / private tuition</option>' +
            '<option value="mixed">Both (group + 1-to-1)</option>' +
          "</select></label>" +
        '<label style="display:block;font-size:13px;margin:0 0 8px">Who books ' +
          '<select id="polAudience" style="margin-left:6px">' +
            '<option value="public">The public (open booking)</option>' +
            '<option value="private">One private family (a private party)</option>' +
          "</select></label>" +
        '<label style="display:block;font-size:13px;margin:0 0 8px">' +
          '<input type="checkbox" id="polTimetable" checked> ' +
          "I have at least one camp with a day, time &amp; venue</label>" +
        '<label style="display:block;font-size:13px;margin:0 0 10px">' +
          '<input type="checkbox" id="polTaster"> ' +
          "I also run public group taster days</label>" +
        '<button class="hc-btn" id="polCheck" type="button">Check against policy</button>' +
        '<div id="polResult" style="margin-top:14px"></div>';
      mountEl.appendChild(form);

      var resultHost = form.querySelector("#polResult");
      function runCheck() {
        try {
          var ans = {
            format: (form.querySelector("#polFormat") || {}).value,
            audience: (form.querySelector("#polAudience") || {}).value,
            hasTimetabled: !!(form.querySelector("#polTimetable") || {}).checked,
            runsPublicGroupSessions: !!(form.querySelector("#polTaster") || {}).checked
          };
          renderCheckResult(resultHost, applyPolicy(ans));
        } catch (e) {
          resultHost.innerHTML = '<p style="color:#9a1f5e">Could not check: ' +
            esc(e && e.message ? e.message : String(e)) + "</p>";
        }
      }
      var btn = form.querySelector("#polCheck");
      if (btn) btn.addEventListener("click", runCheck);

      // ---- Acknowledge / footer ----
      var footer = el("div", {
        style: "border-top:1px solid var(--line,#E6E6E6);margin-top:16px;padding-top:14px;" +
          "display:flex;align-items:center;gap:12px;flex-wrap:wrap"
      });
      var ackBtn = el("button", { class: "hc-btn hc-btn-ghost", type: "button" },
        isCurrentVersionAccepted()
          ? "✓ Policy v" + esc(POLICY.version) + " acknowledged"
          : "I've read this policy");
      ackBtn.addEventListener("click", function () {
        acknowledgePolicy();
        ackBtn.textContent = "✓ Policy v" + POLICY.version + " acknowledged";
        try { HC.util.toast("Policy v" + POLICY.version + " acknowledged"); } catch (e) {}
      });
      footer.appendChild(ackBtn);
      footer.appendChild(el("span", { style: "font-size:12px;color:var(--muted,#808080)" },
        "Questions? " + esc(POLICY.contact)));
      mountEl.appendChild(footer);

      runCheck(); // show an initial (eligible) verdict
    } catch (e) {
      try {
        mountEl.innerHTML = '<p style="color:#9a1f5e">Policy page failed to render: ' +
          esc(e && e.message ? e.message : String(e)) + "</p>";
      } catch (e2) { /* give up quietly */ }
    }
  }

  /* ============================================================
     selfTest — asserts the ACCEPTANCE CRITERION (a policy page
     states who may list) and exercises the policy LOGIC.
     ============================================================ */
  function selfTest() {
    var pass = 0, fail = 0, log = [];
    function check(label, fn) {
      try { fn(); pass += 1; log.push("✓ " + label); }
      catch (e) { fail += 1; log.push("✗ " + label + " — " + (e && e.message ? e.message : String(e))); }
    }

    // ===== ACCEPTANCE CRITERION: the policy page STATES WHO MAY LIST =====

    check("Policy is a versioned, addressable page with a title", function () {
      HC.assert(POLICY && typeof POLICY === "object", "POLICY must exist");
      HC.assert(typeof POLICY.version === "string" && POLICY.version.length > 0, "needs a version");
      HC.assert(typeof POLICY.url === "string" && /^\/policy\//.test(POLICY.url),
        "needs a /policy/ url, got " + POLICY.url);
      HC.assert(/who can list|who may list/i.test(POLICY.title), "title must say who can/may list");
    });

    check("Policy STATES WHO MAY LIST (group children's camps)", function () {
      HC.assert(typeof POLICY.welcome === "string" && POLICY.welcome.length > 0,
        "policy must carry a 'who may list' statement");
      HC.assert(/group/i.test(POLICY.welcome), "welcome statement must say GROUP");
      var joined = POLICY.canList.join(" | ").toLowerCase();
      HC.assert(Array.isArray(POLICY.canList) && POLICY.canList.length >= 3,
        "needs a 'who can list' examples list");
      HC.assert(joined.indexOf("camp") !== -1, "examples must name holiday camps");
    });

    check("Policy states who is NOT a good fit (1-to-1, private parties)", function () {
      HC.assert(Array.isArray(POLICY.notAFit) && POLICY.notAFit.length >= 2,
        "needs a 'not a good fit' list");
      var joined = POLICY.notAFit.join(" | ").toLowerCase();
      HC.assert(joined.indexOf("1-to-1") !== -1 || joined.indexOf("1-2-1") !== -1,
        "not-a-fit list must name 1-to-1 / 1-2-1");
      HC.assert(joined.indexOf("private part") !== -1,
        "not-a-fit list must name private parties");
    });

    check("Policy states the core day/time/venue rule", function () {
      HC.assert(typeof POLICY.coreRule === "string", "core rule must be a string");
      HC.assert(/day/i.test(POLICY.coreRule) && /time/i.test(POLICY.coreRule) && /venue/i.test(POLICY.coreRule),
        "core rule must mention day, time AND venue");
    });

    // ===== The page RENDERS the policy (states it visibly) =====

    check("render() draws a page that states who may list", function () {
      if (typeof document === "undefined") { log.push("  (no DOM; render skipped)"); return; }
      var mount = document.createElement("div");
      render(mount);
      // Harvest text from textContent AND every appended node's innerHTML, so the
      // check reads the actual rendered markup regardless of how deeply the host
      // environment's textContent traverses innerHTML-assigned subtrees.
      var text = String(mount.textContent || "");
      try {
        var kids = mount.children || [];
        for (var i = 0; i < kids.length; i++) {
          if (kids[i] && typeof kids[i].innerHTML === "string") text += " " + kids[i].innerHTML;
          if (kids[i] && typeof kids[i].textContent === "string") text += " " + kids[i].textContent;
        }
      } catch (e) { /* textContent alone is fine in a real DOM */ }
      text = text.toLowerCase();
      HC.assert(text.indexOf("who may list") !== -1 || text.indexOf("who can list") !== -1,
        "rendered page must state who may list");
      HC.assert(text.indexOf("you can list") !== -1, "rendered page must show the 'you can list' list");
      HC.assert(text.indexOf("not be a good fit") !== -1 || text.indexOf("not a good fit") !== -1,
        "rendered page must show the 'may not be a good fit' list");
      HC.assert(text.indexOf("1-to-1") !== -1, "rendered page must name 1-to-1");
      HC.assert(text.indexOf("private part") !== -1, "rendered page must name private parties");
      HC.assert(/day, time/.test(text), "rendered page must state the day/time/venue rule");
    });

    // ===== The stated policy CLASSIFIES cases correctly =====

    check("Policy: a public GROUP holiday camp MAY list", function () {
      var res = applyPolicy({ format: "group", audience: "public", hasTimetabled: true });
      HC.assert(res.mayList === true, "group public camp must be allowed to list");
      HC.assert(res.verdict === "may-list", "verdict should be 'may-list', got " + res.verdict);
    });

    check("Policy: a private 1-to-1 tutor may NOT list", function () {
      var res = applyPolicy({ format: "one_to_one", audience: "public", hasTimetabled: false });
      HC.assert(res.mayList === false, "1-to-1 must not be allowed to list");
      HC.assert(res.verdict === "not-a-fit", "verdict should be 'not-a-fit', got " + res.verdict);
    });

    check("Policy: a one-off PRIVATE party may NOT list", function () {
      var res = applyPolicy({ format: "group", audience: "private", hasTimetabled: false });
      HC.assert(res.mayList === false, "private party must not be allowed to list");
      HC.assert(res.verdict === "not-a-fit", "verdict should be 'not-a-fit'");
      HC.assert(/private part/i.test(res.policyClause), "clause should cite private parties");
    });

    // ===== Borderline / escape-hatch clause from the article =====

    check("Policy: a 1-to-1 tutor running public group sessions may list the group part", function () {
      var res = applyPolicy({ format: "one_to_one", audience: "public", runsPublicGroupSessions: true });
      HC.assert(res.mayList === true, "tutor with public group sessions may list the group part");
      HC.assert(res.verdict === "list-group-part", "verdict should be 'list-group-part'");
      HC.assert(res.needsTimetable === true, "must still be reminded to add a timetabled session");
    });

    check("Policy: a mixed group+1to1 provider may list the group part", function () {
      var res = applyPolicy({ format: "mixed", audience: "public", hasTimetabled: true });
      HC.assert(res.mayList === true, "mixed provider may list via the group part");
      HC.assert(res.verdict === "list-group-part", "mixed should be list-group-part");
    });

    // ===== Core-rule flag: eligible-but-not-yet-findable =====

    check("Policy: eligible camp with no day/time/venue is flagged needsTimetable", function () {
      var res = applyPolicy({ format: "group", audience: "public", hasTimetabled: false });
      HC.assert(res.mayList === true, "still allowed in principle");
      HC.assert(res.needsTimetable === true, "must flag the day/time/venue requirement");
    });

    check("Policy: eligible camp WITH a day/time/venue is not nagged", function () {
      var res = applyPolicy({ format: "group", audience: "public", hasTimetabled: true });
      HC.assert(res.needsTimetable === false, "no nag once a timetabled camp exists");
    });

    // ===== Free-text backstop (loose answers) =====

    check("Free-text 'private party entertainer' resolves to not-a-fit", function () {
      var res = applyPolicy({ offering: "Party entertainer for private parties at a single family's home" });
      HC.assert(res.mayList === false, "private party free-text must not be allowed to list");
    });

    check("Free-text 'multi-activity holiday camp, group, public' resolves to may-list", function () {
      var res = applyPolicy({ offering: "Multi-activity holiday camp, group sessions on a public timetable", hasTimetabled: true });
      HC.assert(res.mayList === true, "group camp free-text must be allowed to list");
      HC.assert(res.verdict === "may-list", "group camp free-text verdict should be may-list");
    });

    // ===== Defensive: garbage / empty input must not throw and must not pass =====

    check("Garbage / empty input is handled and not allowed to list", function () {
      var bad = [null, undefined, {}, 42, "", [], { format: "???" }];
      for (var i = 0; i < bad.length; i++) {
        var res = applyPolicy(bad[i]);
        HC.assert(res && typeof res === "object", "must return a result for input #" + i);
        HC.assert(res.mayList === false, "garbage input #" + i + " must not be allowed to list");
        HC.assert(typeof res.policyClause === "string" && res.policyClause.length > 0,
          "input #" + i + " must carry a policy clause");
      }
    });

    check("Invariant: mayList agrees with the verdict code", function () {
      var cases = [
        { format: "group", audience: "public", hasTimetabled: true },
        { format: "one_to_one", audience: "public" },
        { format: "group", audience: "private" },
        { format: "mixed", audience: "public", hasTimetabled: true },
        { format: "one_to_one", audience: "public", runsPublicGroupSessions: true }
      ];
      for (var i = 0; i < cases.length; i++) {
        var r = applyPolicy(cases[i]);
        var allowed = (r.verdict === "may-list" || r.verdict === "list-group-part");
        HC.assert(allowed === r.mayList, "verdict/mayList must agree for case " + i);
        HC.assert(["may-list", "list-group-part", "not-a-fit"].indexOf(r.verdict) !== -1,
          "verdict must be a known value, got " + r.verdict);
      }
    });

    // ===== Persistence via HC.store (never raw localStorage) =====

    check("Acknowledging the policy persists the accepted version via HC.store", function () {
      var prior = acceptedVersion();
      try { HC.store.set(STORE_VERSION_KEY, null); } catch (e) {}
      HC.assert(isCurrentVersionAccepted() === false, "should start un-accepted for this version");
      var ok = acknowledgePolicy();
      HC.assert(ok === true, "acknowledge should report success");
      HC.assert(isCurrentVersionAccepted() === true, "current version should now be accepted");
      HC.assert(acceptedVersion() === POLICY.version, "stored version should equal POLICY.version");
      // restore prior state so repeated runs stay stable
      try { HC.store.set(STORE_VERSION_KEY, prior); } catch (e) {}
    });

    return { pass: pass, fail: fail, log: log };
  }

  /* ---------------- register ---------------- */
  HC.registerFeature({
    id: "platform-eligibility-policy",
    title: "Who-can-list eligibility policy page",
    side: "platform",
    icon: "📜",
    summary: "A public, versioned policy page that states who may list on HolidayCamp — group children's holiday camps the public can book — and who isn't a fit (1-to-1 tuition, one-off private parties), with a live self-check against the published rules.",
    render: render,
    selfTest: selfTest
  });
})();
