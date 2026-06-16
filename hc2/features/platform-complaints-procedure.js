/* HolidayCamp feature module — platform-complaints-procedure
 *
 * Side: PLATFORM.
 * Replicates Happity's published "Complaints procedure" (a governance artefact
 * the platform owns and publishes), reframed for school-age HOLIDAY CAMPS.
 *
 * Evidence:
 *   - 8177452 "Complaints procedure" (support.happity.co.uk/.../8177452):
 *       "At Happity we take all complaints very seriously ... every complaint
 *        should be dealt with fairly and efficiently."
 *       Stage 1 — informal, Customer Success team (support@).
 *       Stage 2 — formal, in writing to support@, owned by Head of Customer
 *        Success; Co-Founders kept up to date / escalated to if the complaint
 *        concerns the Head of CS.
 *       Stage 3 — investigation by Head of Customer Success.
 *       Stage 4 — resolution, contacted by phone and/or email, in line with T&Cs.
 *       "Policy review — issued July 2023 and reviewed regularly."
 *
 * This is the PLATFORM side: the *published policy document itself* — its
 * escalation ladder (owners, channels, target response times), its scope, and
 * its review/version metadata. (The separate parent-complaint feature is the
 * parent-facing composer that *files* a complaint into this process.)
 *
 * Acceptance criterion (asserted in selfTest, multiple cases):
 *   A documented complaints process WITH ESCALATION is PUBLISHED.
 *   -> the policy has status "published", a stable public URL, an ordered
 *      escalation ladder of >=2 stages each with a distinct owner + channel +
 *      target response time, an unambiguous final/decision stage, and a
 *      review/version block. validate()/isPublished() prove all of this.
 *
 * Design notes
 * - Self-contained & DEFENSIVE: never throws at registration time; the policy
 *   is a static, in-module document so it is well-defined even with no live
 *   camp data. Live data (provider count) is read only to colour the preview.
 * - render(mountEl) draws the published policy page with its escalation ladder,
 *   a "publish / unpublish" toggle (persisted), and a live acceptance badge.
 * - Persistence (published flag + acknowledged version) via HC.store, never raw
 *   localStorage.
 */
(function () {
  "use strict";

  if (typeof window === "undefined" || !window.HC ||
      typeof window.HC.registerFeature !== "function") {
    return; // nothing to attach to — fail silent, never throw.
  }
  var HC = window.HC;

  var STORE_KEY = "complaintsProcedure";

  /* ============================================================
     The PUBLISHED policy document.
     A single source of truth: scope, the ordered escalation
     ladder, and the review/version block. Framed for holiday camps.
     ============================================================ */
  var POLICY = {
    id: "complaints-procedure",
    title: "Complaints procedure",
    subtitle: "How to raise a serious issue with HolidayCamp",
    // Public, indexable URL — proves the policy is genuinely published.
    url: "/policies/complaints-procedure",
    version: "1.0",
    issued: "2026-01-01",
    reviewCadenceMonths: 12,
    nextReview: "2027-01-01",
    owner: "Head of Customer Success",
    // Anyone who comes into contact with HolidayCamp (parents, camp providers,
    // staff, volunteers) can raise a complaint — mirrors the Happity scope line.
    appliesTo: ["parents", "camp providers", "staff", "volunteers", "suppliers"],
    aims: [
      "Deal with every complaint about a holiday camp booking in a timely way.",
      "Make sure no parent or provider is disadvantaged for raising an issue.",
      "Feed lessons back to the camps and to the platform so things improve.",
      "Resolve complaints in line with our Terms & Conditions."
    ],
    // The ESCALATION LADDER — ordered stages, each with a distinct owner,
    // channel and target response time. This is what makes the process
    // "with escalation".
    stages: [
      {
        key: "informal",
        order: 1,
        title: "Informal — talk to Customer Success",
        owner: "Customer Success team",
        channel: "support@holidaycamp.example",
        targetResponseHours: 24,
        escalation: false,
        decision: false,
        detail: "Most issues with a camp booking are sorted informally. Email " +
          "the Customer Success team and they'll aim to put it right within one working day."
      },
      {
        key: "formal",
        order: 2,
        title: "Formal — put your complaint in writing",
        owner: "Head of Customer Success",
        channel: "support@holidaycamp.example (marked FORMAL COMPLAINT)",
        targetResponseHours: 72,
        escalation: true,
        decision: false,
        detail: "If Customer Success can't resolve it, escalate: send a written " +
          "complaint to support@ with the facts, dates, correspondence and screenshots. " +
          "The Head of Customer Success takes ownership and acknowledges within three working days."
      },
      {
        key: "investigation",
        order: 3,
        title: "Investigation",
        owner: "Head of Customer Success",
        channel: "phone and/or email",
        targetResponseHours: 240, // ~10 working days
        escalation: true,
        decision: false,
        detail: "The Head of Customer Success investigates — speaking to you, the " +
          "camp provider and any HolidayCamp staff involved, and reading the booking history."
      },
      {
        key: "review",
        order: 4,
        title: "Senior review (if the Head of CS is involved)",
        owner: "Co-Founders / Senior Management",
        channel: "phone and/or email",
        targetResponseHours: 240,
        escalation: true,
        decision: false,
        detail: "If the complaint concerns the Head of Customer Success, a Co-Founder " +
          "or another member of the senior team takes it over. Co-Founders are kept " +
          "informed throughout the formal process."
      },
      {
        key: "resolution",
        order: 5,
        title: "Resolution",
        owner: "Head of Customer Success",
        channel: "phone and/or email",
        targetResponseHours: 360, // ~15 working days, end-to-end
        escalation: false,
        decision: true, // the final, binding decision stage
        detail: "We implement a reasonable, proportionate resolution in line with our " +
          "Terms & Conditions and contact you by phone and/or email to explain the outcome."
      }
    ]
  };

  /* ---------------- published-state (mock persistence) ---------------- */
  // Default state: the policy ships PUBLISHED (a platform must publish it).
  function defaultState() {
    return {
      status: "published",        // "published" | "draft" | "unpublished"
      publishedVersion: POLICY.version,
      publishedAt: POLICY.issued
    };
  }

  function readState() {
    try {
      var s = HC.store.get(STORE_KEY, null);
      if (!s || typeof s !== "object") return defaultState();
      // normalise
      return {
        status: (s.status === "draft" || s.status === "unpublished") ? s.status : "published",
        publishedVersion: s.publishedVersion || POLICY.version,
        publishedAt: s.publishedAt || POLICY.issued
      };
    } catch (e) {
      return defaultState();
    }
  }

  function writeState(s) {
    try { HC.store.set(STORE_KEY, s); return true; } catch (e) { return false; }
  }

  function setPublished(published) {
    var s = readState();
    if (published) {
      s.status = "published";
      s.publishedVersion = POLICY.version;
      s.publishedAt = POLICY.issued;
    } else {
      s.status = "unpublished";
    }
    writeState(s);
    return s;
  }

  /* ============================================================
     LOGIC — the bit selfTest exercises.
     ============================================================ */

  // The escalation ladder, sorted by order. Pure function, no DOM.
  function ladder(policy) {
    policy = policy || POLICY;
    var stages = Array.isArray(policy.stages) ? policy.stages.slice() : [];
    stages.sort(function (a, b) { return (a.order || 0) - (b.order || 0); });
    return stages;
  }

  // Given a current stage key, what's the next escalation stage? null at the end.
  function nextStage(policy, fromKey) {
    var l = ladder(policy);
    var idx = -1;
    for (var i = 0; i < l.length; i++) { if (l[i].key === fromKey) { idx = i; break; } }
    if (idx === -1 || idx + 1 >= l.length) return null;
    return l[idx + 1];
  }

  // The single decision/final stage.
  function decisionStage(policy) {
    var l = ladder(policy);
    for (var i = 0; i < l.length; i++) { if (l[i].decision) return l[i]; }
    return l.length ? l[l.length - 1] : null;
  }

  // Does this policy describe a real ESCALATION path? (>=2 stages, owners change
  // as you climb, response targets are non-decreasing, and there is exactly one
  // final decision stage that is the last stage.)
  function hasEscalation(policy) {
    var l = ladder(policy);
    if (l.length < 2) return false;
    // at least one stage flagged as an escalation step
    var anyEsc = l.some(function (s) { return s.escalation === true; });
    if (!anyEsc) return false;
    // ownership genuinely changes somewhere up the ladder (not all one owner)
    var owners = {};
    l.forEach(function (s) { if (s.owner) owners[String(s.owner).toLowerCase()] = true; });
    if (Object.keys(owners).length < 2) return false;
    // exactly one decision stage, and it is the last in the ladder
    var decisions = l.filter(function (s) { return s.decision === true; });
    if (decisions.length !== 1) return false;
    if (decisions[0].key !== l[l.length - 1].key) return false;
    return true;
  }

  // Validate the published policy against the acceptance criterion. Returns
  // { ok, errors:[...], checks:{...} } — render() and selfTest() both use it.
  function validate(policy, state) {
    policy = policy || POLICY;
    state = state || readState();
    var errors = [];
    var checks = {};

    checks.hasTitle = !!(policy.title && String(policy.title).trim());
    if (!checks.hasTitle) errors.push("policy has no title");

    checks.published = state.status === "published";
    if (!checks.published) errors.push("policy is not published (status=" + state.status + ")");

    checks.hasUrl = typeof policy.url === "string" && /^\/[a-z0-9\-\/]+$/.test(policy.url);
    if (!checks.hasUrl) errors.push("policy has no valid public URL");

    var l = ladder(policy);
    checks.multiStage = l.length >= 2;
    if (!checks.multiStage) errors.push("escalation ladder needs >=2 stages, got " + l.length);

    // every stage fully specified: owner + channel + target response time + detail
    checks.stagesComplete = l.every(function (s) {
      return s.owner && String(s.owner).trim() &&
        s.channel && String(s.channel).trim() &&
        typeof s.targetResponseHours === "number" && s.targetResponseHours > 0 &&
        s.detail && String(s.detail).trim();
    });
    if (!checks.stagesComplete) errors.push("a stage is missing owner / channel / response target / detail");

    checks.hasEscalation = hasEscalation(policy);
    if (!checks.hasEscalation) errors.push("ladder does not describe a real escalation path");

    checks.hasDecision = !!decisionStage(policy);
    if (!checks.hasDecision) errors.push("no final decision/resolution stage");

    checks.hasReview = typeof policy.reviewCadenceMonths === "number" &&
      policy.reviewCadenceMonths > 0 && !!policy.nextReview;
    if (!checks.hasReview) errors.push("policy has no review cadence / next-review date");

    checks.hasVersion = !!(policy.version && policy.issued);
    if (!checks.hasVersion) errors.push("policy has no version / issued date");

    checks.hasScope = Array.isArray(policy.appliesTo) && policy.appliesTo.length > 0;
    if (!checks.hasScope) errors.push("policy has no scope (appliesTo)");

    var ok = errors.length === 0;
    return { ok: ok, errors: errors, checks: checks };
  }

  // The headline acceptance predicate: documented process w/ escalation, published.
  function isPublished(policy, state) {
    var v = validate(policy, state);
    return v.ok && v.checks.published && v.checks.hasEscalation && v.checks.multiStage;
  }

  /* ============================================================
     render(mountEl) — the published policy page + publish toggle.
     ============================================================ */
  function render(mountEl) {
    try {
      var el = HC.util.el;
      mountEl.innerHTML = "";

      var providerCount = 0;
      try { providerCount = (HC.data.providers || []).length; } catch (e) {}

      var intro = el("p", { style: "font-size:13.5px;color:var(--text,#383838);margin:0 0 14px" },
        "This is the <b>published platform policy</b> every parent and camp provider can read. " +
        "It documents how to raise a serious issue about a holiday-camp booking and the " +
        "<b>escalation ladder</b> a complaint climbs until it is resolved" +
        (providerCount ? " — covering all " + providerCount + " camps in the directory." : "."));
      mountEl.appendChild(intro);

      // Status / publish control.
      var statusBar = el("div", { style: "margin:0 0 16px" });
      mountEl.appendChild(statusBar);

      var ladderHost = el("div", {});
      var policyHost = el("div", {});
      var badgeHost = el("div", {});

      function paint() {
        var state = readState();
        var v = validate(POLICY, state);
        var published = state.status === "published";

        // status bar
        statusBar.innerHTML = "";
        var pill = el("span", {
          style: "display:inline-block;font-family:Quicksand,system-ui,sans-serif;font-weight:700;" +
            "font-size:12px;text-transform:uppercase;letter-spacing:.5px;padding:5px 11px;border-radius:999px;margin-right:10px;" +
            (published ? "background:#E1F0E4;color:#2f7d4f" : "background:#FCE8F0;color:#9a1f5e")
        }, published ? "● Published" : "○ Unpublished");
        statusBar.appendChild(pill);
        statusBar.appendChild(el("span", { style: "font-size:12.5px;color:var(--muted,#808080)" },
          "v" + escapeText(POLICY.version) + " · issued " + escapeText(POLICY.issued) +
          " · next review " + escapeText(POLICY.nextReview)));

        var btn = el("button", {
          class: "hc-btn hc-btn-ghost",
          type: "button",
          style: "margin-left:12px",
          onclick: function () {
            setPublished(!published);
            paint();
            try { HC.util.toast(published ? "Policy unpublished" : "Policy published"); } catch (e) {}
          }
        }, published ? "Unpublish" : "Publish");
        statusBar.appendChild(btn);

        // policy body
        policyHost.innerHTML =
          '<div style="border:1.5px solid var(--purple-tint,#F0E8F4);border-radius:14px;padding:16px 18px;margin:0 0 16px;background:#fff">' +
            '<div style="font-size:11px;text-transform:uppercase;letter-spacing:.5px;font-weight:700;color:var(--magenta,#F82488)">' +
              "Published policy</div>" +
            '<div style="font-family:Quicksand,system-ui,sans-serif;font-weight:700;font-size:20px;color:var(--purple,#603488);margin:2px 0">' +
              escapeText(POLICY.title) + "</div>" +
            '<div style="font-size:13px;color:var(--text,#383838);margin:0 0 6px">' + escapeText(POLICY.subtitle) + "</div>" +
            '<div style="font-size:12px;color:var(--muted,#808080)"><code>' + escapeText(POLICY.url) + "</code> · owned by " +
              escapeText(POLICY.owner) + "</div>" +
            '<div style="font-size:12.5px;color:var(--text,#383838);margin:10px 0 0">' +
              "<b>Who it covers:</b> " + escapeText(POLICY.appliesTo.join(", ")) + ".</div>" +
          "</div>";

        // escalation ladder
        var l = ladder(POLICY);
        var rows = l.map(function (s, i) {
          var isLast = i === l.length - 1;
          var tag = s.decision ? "Decision" : (s.escalation ? "Escalation" : "First contact");
          var tagColor = s.decision ? "#2f7d4f" : (s.escalation ? "#F82488" : "#603488");
          return '<div style="display:flex;gap:12px;padding:12px 0;' +
              (isLast ? "" : "border-bottom:1px solid var(--line,#E6E6E6)") + '">' +
            '<div style="flex:0 0 26px;height:26px;width:26px;border-radius:50%;background:var(--purple,#603488);' +
              'color:#fff;font-family:Quicksand,system-ui,sans-serif;font-weight:700;font-size:13px;display:grid;place-items:center">' +
              s.order + "</div>" +
            "<div style=\"flex:1\">" +
              '<div style="font-family:Quicksand,system-ui,sans-serif;font-weight:700;font-size:14.5px;color:var(--purple,#603488)">' +
                escapeText(s.title) +
                ' <span style="font-size:10.5px;font-weight:700;text-transform:uppercase;letter-spacing:.4px;color:' + tagColor + '">· ' + tag + "</span></div>" +
              '<div style="font-size:12.5px;color:var(--text,#383838);margin:3px 0 5px">' + escapeText(s.detail) + "</div>" +
              '<div style="font-size:11.5px;color:var(--muted,#808080)">' +
                "<b>Owner:</b> " + escapeText(s.owner) + " · <b>Via:</b> " + escapeText(s.channel) +
                " · <b>Responds within:</b> " + fmtHours(s.targetResponseHours) + "</div>" +
            "</div>" +
          "</div>";
        }).join("");
        ladderHost.innerHTML =
          '<div style="font-family:Quicksand,system-ui,sans-serif;font-weight:700;font-size:12.5px;text-transform:uppercase;' +
            'letter-spacing:.4px;color:var(--magenta,#F82488);margin:0 0 4px">Escalation ladder · ' + l.length + " stages</div>" +
          '<div style="border:1.5px solid var(--line,#E6E6E6);border-radius:14px;padding:4px 16px">' + rows + "</div>";

        // acceptance badge
        badgeHost.innerHTML = "";
        var ok = isPublished(POLICY, state);
        var badge = el("div", {
          style: "margin-top:14px;font-size:12.5px;font-weight:700;padding:10px 13px;border-radius:10px;" +
            (ok ? "background:#E1F0E4;color:#2f7d4f" : "background:#FCE8F0;color:#9a1f5e")
        }, ok
          ? "✓ A documented complaints process with escalation is published."
          : "✗ Not published as a documented, escalating process — " + escapeText(v.errors[0] || "unknown"));
        badgeHost.appendChild(badge);
      }

      mountEl.appendChild(policyHost);
      mountEl.appendChild(ladderHost);
      mountEl.appendChild(badgeHost);
      paint();
    } catch (e) {
      mountEl.innerHTML = '<p style="color:#9a1f5e">Complaints-procedure preview failed: ' +
        escapeText(e && e.message ? e.message : String(e)) + "</p>";
    }
  }

  function fmtHours(h) {
    if (typeof h !== "number" || !isFinite(h)) return "—";
    if (h < 24) return h + " hour" + (h === 1 ? "" : "s");
    var d = Math.round(h / 24);
    return d + " day" + (d === 1 ? "" : "s");
  }

  function escapeText(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  /* ============================================================
     selfTest — exercises the policy LOGIC and asserts the
     acceptance criterion across multiple cases.
     ============================================================ */
  function selfTest() {
    var pass = 0, fail = 0, log = [];
    function check(label, fn) {
      try { fn(); pass++; log.push("✓ " + label); }
      catch (e) { fail++; log.push("✗ " + label + " — " + (e && e.message ? e.message : String(e))); }
    }

    // Use a clean, default published state for deterministic logic tests so we
    // don't depend on whatever the UI toggle last left in the store.
    var pub = defaultState();

    // 0. The policy is a well-formed document.
    check("Policy document has title, subtitle, owner, scope and aims", function () {
      HC.assert(POLICY.title && POLICY.subtitle, "title/subtitle required");
      HC.assert(POLICY.owner, "owner required");
      HC.assert(Array.isArray(POLICY.appliesTo) && POLICY.appliesTo.length >= 3,
        "scope should cover parents, providers and staff at least");
      HC.assert(Array.isArray(POLICY.aims) && POLICY.aims.length >= 3, "policy should state its aims");
    });

    // 1. Published to a stable public URL.
    check("Policy is published to a stable public URL", function () {
      HC.assert(pub.status === "published", "default state should be published");
      HC.assert(/^\/policies\//.test(POLICY.url), "public URL should live under /policies/, got " + POLICY.url);
    });

    // 2. The escalation ladder is ordered and multi-stage.
    check("Escalation ladder is ordered and has >=2 stages", function () {
      var l = ladder(POLICY);
      HC.assert(l.length >= 2, "expected >=2 stages, got " + l.length);
      for (var i = 1; i < l.length; i++) {
        HC.assert(l[i].order > l[i - 1].order, "stages must be strictly ordered at " + i);
      }
      HC.assert(l[0].key === "informal", "first stage should be the informal contact");
    });

    // 3. Each stage is fully specified (owner + channel + response target + detail).
    check("Every stage names an owner, a channel, a response target and detail", function () {
      ladder(POLICY).forEach(function (s) {
        HC.assert(s.owner && String(s.owner).trim(), "stage " + s.key + " missing owner");
        HC.assert(s.channel && String(s.channel).trim(), "stage " + s.key + " missing channel");
        HC.assert(typeof s.targetResponseHours === "number" && s.targetResponseHours > 0,
          "stage " + s.key + " missing/zero response target");
        HC.assert(s.detail && String(s.detail).length > 10, "stage " + s.key + " missing detail");
      });
    });

    // 4. Ownership genuinely escalates: front line -> Head of CS -> Co-Founders.
    check("Ownership escalates up the ladder (Customer Success -> Head of CS -> Co-Founders)", function () {
      HC.assert(hasEscalation(POLICY), "policy must describe a real escalation path");
      var l = ladder(POLICY);
      var owners = l.map(function (s) { return String(s.owner).toLowerCase(); });
      HC.assert(owners[0].indexOf("customer success team") !== -1, "stage 1 owned by Customer Success team");
      HC.assert(owners.some(function (o) { return o.indexOf("head of customer success") !== -1; }),
        "ladder must reach the Head of Customer Success");
      HC.assert(owners.some(function (o) { return o.indexOf("co-founder") !== -1; }),
        "ladder must reach a Co-Founder / senior escalation owner");
      HC.assert(Object.keys(owners.reduce(function (m, o) { m[o] = 1; return m; }, {})).length >= 3,
        "at least three distinct owners across the ladder");
    });

    // 5. nextStage() walks the ladder; the last stage has no next.
    check("nextStage() walks the ladder and terminates at the final stage", function () {
      var l = ladder(POLICY);
      HC.assert(nextStage(POLICY, "informal").key === "formal", "informal should escalate to formal");
      HC.assert(nextStage(POLICY, l[l.length - 1].key) === null, "last stage must have no next stage");
      HC.assert(nextStage(POLICY, "does-not-exist") === null, "unknown stage yields no next stage");
    });

    // 6. There is exactly one final decision/resolution stage, and it is last.
    check("Exactly one final decision (resolution) stage, and it is the last", function () {
      var l = ladder(POLICY);
      var decisions = l.filter(function (s) { return s.decision === true; });
      HC.assert(decisions.length === 1, "expected exactly one decision stage, got " + decisions.length);
      HC.assert(decisions[0].key === "resolution", "decision stage should be 'resolution'");
      HC.assert(decisionStage(POLICY).key === l[l.length - 1].key, "decision stage must be the last stage");
    });

    // 7. Response targets are non-decreasing as the complaint escalates.
    check("Target response times do not shrink as a complaint escalates", function () {
      var l = ladder(POLICY);
      for (var i = 1; i < l.length; i++) {
        HC.assert(l[i].targetResponseHours >= l[i - 1].targetResponseHours,
          "response target dropped on escalation at stage " + l[i].key);
      }
    });

    // 8. Review / version block present (a maintained, not orphaned, policy).
    check("Policy carries a version and a scheduled review", function () {
      HC.assert(POLICY.version && POLICY.issued, "version + issued date required");
      HC.assert(typeof POLICY.reviewCadenceMonths === "number" && POLICY.reviewCadenceMonths > 0,
        "review cadence required");
      HC.assert(!!POLICY.nextReview, "next review date required");
    });

    // 9. ACCEPTANCE CRITERION — validate() passes and isPublished() is true.
    check("ACCEPTANCE: a documented complaints process with escalation is PUBLISHED", function () {
      var v = validate(POLICY, pub);
      HC.assert(v.ok, "validate() failed: " + v.errors.join("; "));
      HC.assert(v.checks.published, "must be published");
      HC.assert(v.checks.multiStage, "must be multi-stage");
      HC.assert(v.checks.hasEscalation, "must have an escalation path");
      HC.assert(v.checks.hasDecision, "must have a final decision stage");
      HC.assert(v.checks.hasReview && v.checks.hasVersion, "must be versioned + reviewed");
      HC.assert(isPublished(POLICY, pub) === true, "isPublished() should be true for the published policy");
    });

    // 10. Negative case — an UNPUBLISHED policy fails the acceptance criterion.
    check("Negative: an unpublished policy is NOT accepted as published", function () {
      var draft = { status: "unpublished", publishedVersion: POLICY.version, publishedAt: POLICY.issued };
      HC.assert(isPublished(POLICY, draft) === false, "unpublished policy must not pass");
      var v = validate(POLICY, draft);
      HC.assert(v.ok === false, "validate() should fail when unpublished");
      HC.assert(v.checks.published === false, "published check should be false");
    });

    // 11. Negative case — a single-stage policy has no escalation.
    check("Negative: a single-stage policy has no escalation path", function () {
      var flat = {
        title: "X", subtitle: "x", url: "/policies/x", version: "1", issued: "2026-01-01",
        reviewCadenceMonths: 12, nextReview: "2027-01-01", owner: "X", appliesTo: ["parents"],
        stages: [{ key: "only", order: 1, title: "Only stage", owner: "Team",
          channel: "support@", targetResponseHours: 24, escalation: false, decision: true,
          detail: "Single contact only, nowhere to escalate." }]
      };
      HC.assert(hasEscalation(flat) === false, "one-stage policy must not count as escalating");
      HC.assert(isPublished(flat, defaultState()) === false, "one-stage policy must fail acceptance");
    });

    // 12. Persistence round-trips through HC.store (mock backend), then restore.
    check("Publish toggle persists via HC.store and round-trips", function () {
      var before = readState();
      setPublished(false);
      HC.assert(readState().status === "unpublished", "unpublish should persist");
      HC.assert(isPublished(POLICY) === false, "live state should now fail acceptance");
      setPublished(true);
      HC.assert(readState().status === "published", "republish should persist");
      HC.assert(isPublished(POLICY) === true, "live state should pass again");
      // leave the store as we found it
      try { HC.store.set(STORE_KEY, before); } catch (e) {}
    });

    return { pass: pass, fail: fail, log: log };
  }

  /* ---------------- register ---------------- */
  HC.registerFeature({
    id: "platform-complaints-procedure",
    title: "Complaints procedure (published policy)",
    side: "platform",
    icon: "📜",
    summary: "The platform's published complaints policy for holiday-camp bookings: a documented, multi-stage escalation ladder (Customer Success -> Head of CS -> Co-Founders -> resolution) with owners, channels, response targets and a scheduled review.",
    render: render,
    selfTest: selfTest
  });
})();
