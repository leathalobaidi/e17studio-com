/* HolidayCamp feature — provider-eligibility-gate
 *
 * Eligibility gating at sign-up  (provider side)
 *
 * Replicates Happity's "I would like to list my classes on Happity, am I
 * eligible?" gate (support article 11392600). Evidence highlights:
 *   - Happity "works best for public classes with a regular timetable, or
 *     one-off events" and is "less suitable for those offering private tuition
 *     or one-to-one consultations".
 *   - The article publishes TWO explicit lists at sign-up:
 *       * who CAN list   (group classes/activities — sensory play, forest
 *         school group classes, sports & gym classes, music/dance, festivals…)
 *       * who may NOT be a good fit (party entertainers for one-off PRIVATE
 *         parties, 1-2-1 sleep consultations, private tuition, childcare
 *         settings offering general childcare rather than timetabled sessions).
 *   - "you can't get found … unless you list at least one class/event with a
 *     day, time, and venue attached" — i.e. a public, timetabled, group offer.
 *
 * Framed for SCHOOL-AGE HOLIDAY CAMPS (not baby classes): at provider sign-up
 * we gate on the same shape. ELIGIBLE = a GROUP children's holiday camp /
 * activity that is open to the public with a timetable + venue. NOT ELIGIBLE =
 * 1-to-1 / private tuition, one-off PRIVATE parties (hire-an-entertainer for a
 * single family), and general childcare with no specific timetabled sessions.
 * A borderline case (e.g. a tutor who ALSO runs public group taster days, or a
 * party entertainer who runs public open sessions) can qualify by listing the
 * group/public part — exactly as the article advises taster sessions.
 *
 * ACCEPTANCE CRITERION (asserted in selfTest):
 *   Sign-up states who is eligible (group children's camps) vs not (1-to-1,
 *   private parties). The gate must ELIGIBLE-pass a public group camp and
 *   REJECT a 1-to-1 offering and a one-off private party.
 *
 * Self-contained, defensive, no imports/exports. Calls HC.registerFeature.
 */
(function () {
  "use strict";

  // Defensive: never throw at module load if HC isn't present.
  if (typeof window === "undefined" || !window.HC || typeof window.HC.registerFeature !== "function") {
    if (typeof console !== "undefined" && console.warn) {
      console.warn("[HC] provider-eligibility-gate: HC core not found; skipping registration.");
    }
    return;
  }

  var HC = window.HC;

  var STORE_KEY = "provider_eligibility_signups"; // persisted applications

  // The two sign-up lists parents-of-the-platform see, mirroring article 11392600
  // but reworded for school-age HOLIDAY CAMPS.
  var ELIGIBLE_EXAMPLES = [
    "Multi-activity holiday camps (group, open to the public)",
    "Sports & games camps for school-age children",
    "Forest school / outdoor adventure camps (group days, not childminding)",
    "Arts, drama, music & dance holiday workshops",
    "Coding / STEM / Lego camps with a set timetable",
    "Council / HAF holiday activity & food sessions",
    "Stage-school and performing-arts intensives",
    "One-off public events with a day, time and venue (e.g. a family activity day)"
  ];
  var NOT_ELIGIBLE_EXAMPLES = [
    "1-to-1 / private tuition or coaching (e.g. a personal sports or music tutor)",
    "One-off PRIVATE parties (hire-an-entertainer for a single family's party)",
    "Childminders / nurseries offering general childcare with no timetabled sessions",
    "Private 1-2-1 consultations (e.g. sleep or behaviour consultant)",
    "Anything with no public class/event carrying a day, time and venue"
  ];

  /* ---------------- pure logic (testable, DOM-free) ---------------- */

  function asText(v) {
    return typeof v === "string" ? v : (v == null ? "" : String(v));
  }

  // Sign-up answers. We model the questions the gate asks a new provider:
  //   format        : 'group' | 'one_to_one' | 'mixed'   (group vs 1-to-1)
  //   audience      : 'public' | 'private'                (open booking vs a
  //                                                         single private hire)
  //   hasTimetabled : Boolean — at least one class/event with day+time+venue
  //   offering      : free-text description (used as a backstop classifier)
  //   runsPublicGroupSessions : Boolean — the article's "taster session" escape
  //                                        hatch for borderline providers.
  //
  // Phrases that, in free text alone, look like an ineligible private/1-to-1
  // offering (used only when the structured answers are missing/ambiguous).
  var PRIVATE_PHRASES = [
    "1-to-1", "1 to 1", "one-to-one", "one to one", "1-2-1", "1 2 1",
    "private party", "private parties", "private tuition", "private tutor",
    "private lesson", "private coaching", "private consultation",
    "private consultations", "sleep consultant", "sleep consultation",
    "personal tutor", "personal coaching", "bespoke private", "single family",
    "hire me for your party", "party entertainer", "childminding",
    "general childcare"
  ];
  var GROUP_PHRASES = [
    "group", "holiday camp", "holiday club", "multi-activity", "multi activity",
    "workshop", "public sessions", "open sessions", "timetable", "stay and play",
    "stay & play", "drop-in sessions", "summer camp", "easter camp", "half term",
    "taster session", "taster day", "activity day", "festival"
  ];

  function hasPhrase(text, list) {
    var hay = asText(text).toLowerCase();
    if (!hay) return false;
    for (var i = 0; i < list.length; i++) {
      if (hay.indexOf(list[i]) !== -1) return true;
    }
    return false;
  }

  // Normalise a possibly-loose answer object into the canonical fields.
  function normalise(ans) {
    var a = (ans && typeof ans === "object") ? ans : {};
    var format = a.format;
    if (format !== "group" && format !== "one_to_one" && format !== "mixed") {
      // infer from free text if the explicit field is missing/garbage
      var grp = hasPhrase(a.offering, GROUP_PHRASES);
      var priv = hasPhrase(a.offering, PRIVATE_PHRASES);
      if (grp && !priv) format = "group";
      else if (priv && !grp) format = "one_to_one";
      else if (grp && priv) format = "mixed";
      else format = "unknown";
    }
    var audience = (a.audience === "public" || a.audience === "private") ? a.audience : null;
    if (audience === null) {
      // a "private party" note implies a private audience
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

  // The CORE gate decision. Given a provider's sign-up answers, decide whether
  // they may list, and tell them WHY — mirroring the article's two lists.
  //
  // Returns:
  //   eligible    : Boolean — can they create a listing?
  //   status      : 'eligible' | 'borderline' | 'ineligible'
  //   reason      : String — plain-English explanation shown at sign-up
  //   needsTimetable : Boolean — eligible-in-principle but must add a
  //                              day/time/venue class before they can be found
  //   cta         : String — the sign-up call-to-action
  function evaluate(answers) {
    var a = normalise(answers);

    // Hard NO: a one-off PRIVATE party / private hire is the article's
    // flagship "not a good fit" example. A private audience (a single family's
    // private booking) is ineligible whatever the internal format — what makes
    // it a fit is that the PUBLIC can find and book it.
    if (a.audience === "private") {
      return gateResult(false, "ineligible",
        "HolidayCamp lists camps the public can book. One-off private parties " +
        "(hire-an-entertainer for a single family) aren't a fit — there's no " +
        "public class with a day, time and venue to be found by.",
        false, "Sorry — private parties can't be listed");
    }

    // Pure 1-to-1 / private tuition: not a fit UNLESS they also run public
    // group sessions (the article's taster-session escape hatch).
    if (a.format === "one_to_one") {
      if (a.runsPublicGroupSessions) {
        return gateResult(true, "borderline",
          "1-to-1 tuition itself can't be listed, but you can list any public " +
          "GROUP taster days or holiday sessions you run to reach families.",
          true, "List your public group sessions");
      }
      return gateResult(false, "ineligible",
        "HolidayCamp is for GROUP children's camps, not private 1-to-1 tuition " +
        "or coaching. If you start running public group taster days, you'd be " +
        "welcome to list those.",
        false, "Sorry — 1-to-1 offerings can't be listed");
    }

    // Mixed (e.g. a tutor who also runs group camps): eligible via the group part.
    if (a.format === "mixed") {
      return gateResult(true, "borderline",
        "Great — you can list the GROUP holiday-camp part of what you offer. " +
        "(The private 1-to-1 side stays off HolidayCamp.)",
        !a.hasTimetabled, "List your group camps");
    }

    // Group + public = the clear YES.
    if (a.format === "group" && a.audience === "public") {
      if (!a.hasTimetabled) {
        return gateResult(true, "eligible",
          "You're eligible. To be found, add at least one camp/session with a " +
          "day, time and venue attached.",
          true, "Add your first camp");
      }
      return gateResult(true, "eligible",
        "You're eligible — a public group holiday camp is exactly what " +
        "HolidayCamp lists. Let's get your camps live.",
        false, "Create your listing");
    }

    // Group but unknown audience treated as public-leaning but flagged.
    if (a.format === "group") {
      return gateResult(true, "eligible",
        "You're eligible as a group children's camp. Make sure your sessions " +
        "are open for the public to book.",
        !a.hasTimetabled, "Create your listing");
    }

    // Everything else (couldn't tell what it is): ask for more, don't list yet.
    return gateResult(false, "ineligible",
      "We couldn't tell this is a public group children's camp. HolidayCamp " +
      "lists group camps with a day, time and venue — not 1-to-1 or private " +
      "bookings.",
      false, "Tell us more about your sessions");
  }

  function gateResult(eligible, status, reason, needsTimetable, cta) {
    return {
      eligible: !!eligible,
      status: status,
      reason: reason,
      needsTimetable: !!needsTimetable,
      cta: cta
    };
  }

  /* ---------------- persistence (HC.store only) ---------------- */

  function readSignups() {
    try {
      var s = HC.store.get(STORE_KEY, []);
      return Array.isArray(s) ? s : [];
    } catch (e) { return []; }
  }
  function writeSignups(list) {
    try { return HC.store.set(STORE_KEY, Array.isArray(list) ? list : []); }
    catch (e) { return false; }
  }

  // Persist a sign-up attempt + its gate outcome. Returns the saved record.
  function recordSignup(name, answers) {
    var res = evaluate(answers);
    var rec = {
      id: (function () { try { return HC.util.uid(); } catch (e) { return "su_" + Date.now(); } })(),
      name: asText(name) || "Unnamed provider",
      answers: normalise(answers),
      result: res,
      at: Date.now()
    };
    var list = readSignups();
    list.unshift(rec);
    if (list.length > 50) list = list.slice(0, 50); // keep the mock store small
    writeSignups(list);
    return rec;
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

  function listHtml(items, color) {
    var lis = "";
    for (var i = 0; i < items.length; i++) {
      lis += '<li style="margin:0 0 6px">' + esc(items[i]) + "</li>";
    }
    return '<ul style="margin:6px 0 0;padding-left:20px;color:var(--text,#383838);' +
      "font-size:13.5px;line-height:1.5;" + (color ? "" : "") + '">' + lis + "</ul>";
  }

  function statusBadge(res) {
    var bg, fg, txt;
    if (res.status === "eligible") { bg = "#E1F0E4"; fg = "#2f7d4f"; txt = "✓ Eligible"; }
    else if (res.status === "borderline") { bg = "#FFF4D6"; fg = "#8a6d00"; txt = "◐ List the group part"; }
    else { bg = "#FCE8F0"; fg = "#9a1f5e"; txt = "✕ Not a fit"; }
    return '<span style="display:inline-block;font-family:Quicksand,system-ui,sans-serif;' +
      "font-weight:700;font-size:12.5px;padding:4px 11px;border-radius:999px;background:" +
      bg + ";color:" + fg + '">' + txt + "</span>";
  }

  function renderResult(host, res) {
    host.innerHTML =
      '<div style="border:1.5px solid var(--line,#E6E6E6);border-radius:14px;padding:14px 16px;background:#fff">' +
        statusBadge(res) +
        '<p style="margin:10px 0 0;font-size:14px;color:var(--text,#383838);line-height:1.5">' +
          esc(res.reason) + "</p>" +
        (res.needsTimetable
          ? '<p style="margin:8px 0 0;font-size:12.5px;color:var(--magenta,#F82488);font-weight:700">' +
            "Reminder: you can't be found until you list at least one camp with a day, time &amp; venue.</p>"
          : "") +
        '<div style="margin-top:12px">' +
          '<button class="hc-btn' + (res.eligible ? "" : " hc-btn-ghost") + '" type="button" disabled ' +
            'style="opacity:.95;cursor:default">' + esc(res.cta) + "</button>" +
        "</div>" +
      "</div>";
  }

  function render(mountEl) {
    try {
      if (!mountEl) return;
      mountEl.innerHTML = "";

      var intro = el("div", null,
        '<p style="font-size:14px;color:var(--text,#383838);margin:0 0 6px">' +
          "Before you can list, HolidayCamp checks your offering is a good fit. " +
          "We welcome <strong>group children's holiday camps and activities</strong> " +
          "that the public can book.</p>");
      mountEl.appendChild(intro);

      // The two published lists — the heart of the acceptance criterion.
      var lists = el("div", {
        style: "display:grid;grid-template-columns:1fr 1fr;gap:14px;margin:12px 0 16px"
      });
      lists.innerHTML =
        '<div style="border:1.5px solid #CFE9D6;border-radius:14px;padding:12px 14px;background:#F4FBF6">' +
          '<div style="font-family:Quicksand,system-ui,sans-serif;font-weight:700;color:#2f7d4f">✓ You can list</div>' +
          listHtml(ELIGIBLE_EXAMPLES) +
        "</div>" +
        '<div style="border:1.5px solid #F4CFE0;border-radius:14px;padding:12px 14px;background:#FFF6FA">' +
          '<div style="font-family:Quicksand,system-ui,sans-serif;font-weight:700;color:#9a1f5e">✕ Not a fit</div>' +
          listHtml(NOT_ELIGIBLE_EXAMPLES) +
        "</div>";
      mountEl.appendChild(lists);

      // Mini self-check form (group vs 1-to-1, public vs private, timetable).
      var form = el("div", {
        style: "border-top:1px solid var(--line,#E6E6E6);padding-top:14px"
      });
      form.innerHTML =
        '<div style="font-family:Quicksand,system-ui,sans-serif;font-weight:700;color:var(--purple,#603488);margin-bottom:8px">' +
          "Check your eligibility</div>" +
        '<label style="display:block;font-size:13px;margin:0 0 8px">Format ' +
          '<select id="egFormat" style="margin-left:6px">' +
            '<option value="group">Group camp / class</option>' +
            '<option value="one_to_one">1-to-1 / private tuition</option>' +
            '<option value="mixed">Both (group + 1-to-1)</option>' +
          "</select></label>" +
        '<label style="display:block;font-size:13px;margin:0 0 8px">Who books ' +
          '<select id="egAudience" style="margin-left:6px">' +
            '<option value="public">The public (open booking)</option>' +
            '<option value="private">One private family (a private party)</option>' +
          "</select></label>" +
        '<label style="display:block;font-size:13px;margin:0 0 8px">' +
          '<input type="checkbox" id="egTimetable" checked> ' +
          "I have at least one camp with a day, time &amp; venue</label>" +
        '<label style="display:block;font-size:13px;margin:0 0 10px">' +
          '<input type="checkbox" id="egTaster"> ' +
          "I also run public group taster days</label>" +
        '<button class="hc-btn" id="egCheck" type="button">Check eligibility</button>' +
        '<div id="egResult" style="margin-top:14px"></div>';
      mountEl.appendChild(form);

      var resultHost = form.querySelector("#egResult");

      function runCheck() {
        try {
          var ans = {
            format: (form.querySelector("#egFormat") || {}).value,
            audience: (form.querySelector("#egAudience") || {}).value,
            hasTimetabled: !!(form.querySelector("#egTimetable") || {}).checked,
            runsPublicGroupSessions: !!(form.querySelector("#egTaster") || {}).checked
          };
          var res = evaluate(ans);
          renderResult(resultHost, res);
          try { HC.util.toast(res.eligible ? "Eligible to list" : "Not eligible — see why"); } catch (e) {}
        } catch (e) {
          resultHost.innerHTML = '<p style="color:#9a1f5e">Could not check: ' +
            esc(e && e.message ? e.message : String(e)) + "</p>";
        }
      }

      var btn = form.querySelector("#egCheck");
      if (btn) btn.addEventListener("click", runCheck);
      runCheck(); // show an initial (eligible) result
    } catch (e) {
      try {
        mountEl.innerHTML = '<p style="color:#9a1f5e">Eligibility gate failed to render: ' +
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

    // ===== ACCEPTANCE CRITERION =====
    // Sign-up states who IS eligible (group children's camps) vs who is NOT
    // (1-to-1, private parties). We verify both published lists exist AND the
    // gate actually accepts a group camp and rejects 1-to-1 + private parties.

    check("Sign-up publishes an 'eligible' list naming group children's camps", function () {
      HC.assert(Array.isArray(ELIGIBLE_EXAMPLES) && ELIGIBLE_EXAMPLES.length >= 3,
        "expected an eligible-examples list");
      var joined = ELIGIBLE_EXAMPLES.join(" | ").toLowerCase();
      HC.assert(joined.indexOf("group") !== -1 || joined.indexOf("camp") !== -1,
        "eligible list must describe group camps");
    });

    check("Sign-up publishes a 'not a fit' list naming 1-to-1 and private parties", function () {
      HC.assert(Array.isArray(NOT_ELIGIBLE_EXAMPLES) && NOT_ELIGIBLE_EXAMPLES.length >= 2,
        "expected a not-eligible list");
      var joined = NOT_ELIGIBLE_EXAMPLES.join(" | ").toLowerCase();
      HC.assert(joined.indexOf("1-to-1") !== -1 || joined.indexOf("1-2-1") !== -1,
        "not-eligible list must name 1-to-1");
      HC.assert(joined.indexOf("private part") !== -1,
        "not-eligible list must name private parties");
    });

    check("A public GROUP children's camp is ELIGIBLE", function () {
      var res = evaluate({ format: "group", audience: "public", hasTimetabled: true });
      HC.assert(res.eligible === true, "group public camp must be eligible");
      HC.assert(res.status === "eligible", "status should be 'eligible', got " + res.status);
    });

    check("A 1-to-1 / private tuition offering is NOT eligible", function () {
      var res = evaluate({ format: "one_to_one", audience: "public", hasTimetabled: false });
      HC.assert(res.eligible === false, "1-to-1 must be rejected");
      HC.assert(res.status === "ineligible", "status should be 'ineligible', got " + res.status);
      HC.assert(/1-to-1|group/i.test(res.reason), "reason should explain the group-vs-1to1 rule");
    });

    check("A one-off PRIVATE party is NOT eligible", function () {
      var res = evaluate({ format: "group", audience: "private", hasTimetabled: false });
      HC.assert(res.eligible === false, "private party must be rejected");
      HC.assert(res.status === "ineligible", "private party status should be ineligible");
      HC.assert(/private part/i.test(res.reason), "reason should mention private parties");
    });

    // ===== Borderline / escape-hatch cases (the article's taster advice) =====

    check("A 1-to-1 tutor who ALSO runs public group sessions becomes eligible", function () {
      var res = evaluate({ format: "one_to_one", audience: "public", runsPublicGroupSessions: true });
      HC.assert(res.eligible === true, "tutor with public group sessions should be eligible");
      HC.assert(res.status === "borderline", "should be borderline, got " + res.status);
      HC.assert(res.needsTimetable === true, "must still be reminded to add a timetabled session");
    });

    check("A mixed group+1to1 provider can list the group part", function () {
      var res = evaluate({ format: "mixed", audience: "public", hasTimetabled: true });
      HC.assert(res.eligible === true, "mixed provider should be eligible via the group part");
      HC.assert(res.status === "borderline", "mixed should be borderline");
    });

    // ===== "Must have a day/time/venue" rule from the article =====

    check("Eligible group camp with no timetabled session is flagged needsTimetable", function () {
      var res = evaluate({ format: "group", audience: "public", hasTimetabled: false });
      HC.assert(res.eligible === true, "still eligible in principle");
      HC.assert(res.needsTimetable === true,
        "must flag that a day/time/venue listing is required to be found");
    });

    check("Eligible group camp WITH a timetabled session does not nag", function () {
      var res = evaluate({ format: "group", audience: "public", hasTimetabled: true });
      HC.assert(res.needsTimetable === false, "no nag once a timetabled session exists");
    });

    // ===== Free-text inference backstop (loose sign-up answers) =====

    check("Free-text 'private party entertainer' is inferred ineligible", function () {
      var res = evaluate({ offering: "I'm a party entertainer for private parties at a single family's home" });
      HC.assert(res.eligible === false, "private party free-text must be rejected");
    });

    check("Free-text 'holiday camp, group, public timetable' is inferred eligible", function () {
      var res = evaluate({ offering: "Multi-activity holiday camp, group sessions on a public timetable", hasTimetabled: true });
      HC.assert(res.eligible === true, "group camp free-text should be eligible");
      HC.assert(res.status === "eligible", "group camp free-text status eligible");
    });

    check("Free-text 'private 1-2-1 sleep consultation' is inferred ineligible", function () {
      var res = evaluate({ offering: "Private 1-2-1 sleep consultation for one family" });
      HC.assert(res.eligible === false, "1-2-1 consultation must be rejected");
    });

    // ===== Defensive: garbage / empty input must not throw and must not pass =====

    check("Garbage / empty answers are handled and not eligible", function () {
      var bad = [null, undefined, {}, 42, "", [], { format: "???" }];
      for (var i = 0; i < bad.length; i++) {
        var res = evaluate(bad[i]);
        HC.assert(res && typeof res === "object", "must return a result object for input #" + i);
        HC.assert(res.eligible === false, "empty/garbage input #" + i + " must not be eligible");
        HC.assert(typeof res.reason === "string" && res.reason.length > 0,
          "input #" + i + " must carry a reason");
      }
    });

    check("Invariant: eligible<->status, ineligible never says 'eligible'", function () {
      var cases = [
        { format: "group", audience: "public", hasTimetabled: true },
        { format: "one_to_one", audience: "public" },
        { format: "group", audience: "private" },
        { format: "mixed", audience: "public", hasTimetabled: true }
      ];
      for (var i = 0; i < cases.length; i++) {
        var r = evaluate(cases[i]);
        HC.assert((r.status === "eligible" || r.status === "borderline") === r.eligible,
          "status/eligible must agree for case " + i);
        HC.assert(["eligible", "borderline", "ineligible"].indexOf(r.status) !== -1,
          "status must be one of the three known values, got " + r.status);
      }
    });

    // ===== Persistence via HC.store (never raw localStorage) =====

    check("recordSignup persists the application + its gate outcome", function () {
      var before = readSignups().length;
      var rec = recordSignup("Test Camp Co", { format: "group", audience: "public", hasTimetabled: true });
      HC.assert(rec && rec.result && rec.result.eligible === true,
        "saved record should carry an eligible outcome");
      var after = readSignups();
      HC.assert(after.length === before + 1, "sign-up should be persisted (len " + after.length + ")");
      HC.assert(after[0].name === "Test Camp Co", "most recent sign-up should be first");
      // clean up so repeated test runs stay stable
      writeSignups(after.slice(1));
    });

    return { pass: pass, fail: fail, log: log };
  }

  /* ---------------- register ---------------- */

  HC.registerFeature({
    id: "provider-eligibility-gate",
    title: "Eligibility gating at sign-up",
    side: "provider",
    icon: "🛂",
    summary: "At sign-up, HolidayCamp states who's eligible (group children's holiday camps, open to the public) vs not (1-to-1 tuition, one-off private parties) — and gates listing creation accordingly.",
    render: render,
    selfTest: selfTest
  });
})();
