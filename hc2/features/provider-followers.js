/* HolidayCamp feature — provider-followers
 *
 * Followers list — built-in email marketing  (PROVIDER side)
 *
 * Replicates Happity's "Followers" provider experience (support articles
 * 4291535 "How to use Happity Followers for zero-effort email marketing" and
 * 9155760 "How to use Happity's marketing platform to grow your audience", plus
 * 4147919 "How to build your customer email marketing list"). Evidence:
 *   - "When parents view your profile on Happity, we invite them to 'Follow'
 *      you for updates on your classes." -> followers ACCRUE FROM PROFILE VIEWS.
 *   - "Click on Customers > Followers to view your follower list and numbers."
 *      -> the provider SEES THE LIST and a follower count.
 *   - "If the customer's email address is starred out, this means that they
 *      have opted in to receive timetable information ... but they have NOT
 *      opted in for marketing." -> non-marketing followers are masked.
 *   - "We ask for their express permission to share their email addresses with
 *      you, so that you can EXPORT your followers to do your own email
 *      marketing if you wish." -> EXPORT is limited to OPTED-IN followers.
 *   - "if you have an uploaded Privacy Policy, you'll also be able to export
 *      this data." -> export is gated on a Privacy Policy being in place.
 *   - "Members are also able to retrieve extra data on where their followers
 *      are located." -> anonymised location is a member benefit.
 *
 * Framed for SCHOOL-AGE HOLIDAY CAMPS: a provider runs holiday-camp weeks, not
 * baby classes. Parents browsing the E17 directory open the provider's profile;
 * a share of those views convert to Followers (the camp sells out / no slot
 * works right now). The provider opens "Customers > Followers", sees the count,
 * sees timetable-only followers starred-out, and exports the marketing-opted-in
 * followers as CSV (only when a Privacy Policy is uploaded).
 *
 * ACCEPTANCE CRITERION (exercised by selfTest):
 *   Followers accrue from profile views; the provider sees the list and can
 *   export opted-in followers.
 *
 * Self-contained, defensive, no imports/exports. Calls HC.registerFeature.
 */
(function () {
  "use strict";

  // Defensive: never throw at module load if HC isn't present.
  if (typeof window === "undefined" || !window.HC || typeof window.HC.registerFeature !== "function") {
    if (typeof console !== "undefined" && console.warn) {
      console.warn("[HC] provider-followers: HC core not found; skipping registration.");
    }
    return;
  }

  var HC = window.HC;

  var STORE_KEY = "provider_followers_state";

  /* ============================================================ *
   *  PURE LOGIC (testable, DOM-free)                              *
   *  Functions take a state and return a NEW state — never mutate *
   *  in place, so tests run against fresh literals.               *
   * ============================================================ */

  // State shape:
  //   {
  //     providerId, providerName,
  //     privacyPolicy: Boolean,   // uploaded? gates export of personal data
  //     isMember: Boolean,        // member benefit: anonymised location data
  //     views: Number,            // total profile views recorded
  //     followers: [ {
  //        id, name, email, area,
  //        followedAt: ISOString,
  //        marketingOptIn: Boolean // express consent to provider's OWN newsletter
  //     } ]
  //   }

  function emptyState(provider) {
    return {
      providerId: (provider && provider.id) || "",
      providerName: (provider && provider.name) || "",
      privacyPolicy: false,
      isMember: false,
      views: 0,
      followers: []
    };
  }

  function cloneState(state) {
    try {
      return JSON.parse(JSON.stringify(state || {}));
    } catch (e) {
      return emptyState({ id: state && state.providerId, name: state && state.providerName });
    }
  }

  function nowIso() {
    try { return new Date().toISOString(); } catch (e) { return "" + Date.now(); }
  }
  function safeUid() {
    try { return HC.util.uid(); } catch (e) { return "id_" + Math.random().toString(36).slice(2); }
  }

  // Record a profile VIEW. Returns a new state with views incremented.
  function recordView(state) {
    var next = cloneState(state);
    next.views = (Number(next.views) || 0) + 1;
    return next;
  }

  // Convert a viewing parent into a FOLLOWER (the "Follow" tap on the profile).
  // Idempotent on email: the same parent can't follow twice. A follow does NOT
  // imply marketing consent — that is a separate express opt-in.
  //   parent = { name, email, area, marketingOptIn }
  // Returns { state, added: Boolean }.
  function addFollower(state, parent) {
    var next = cloneState(state);
    if (!Array.isArray(next.followers)) next.followers = [];
    if (!parent || !parent.email) return { state: next, added: false };

    var email = String(parent.email).trim().toLowerCase();
    if (!email) return { state: next, added: false };

    var existing = findFollower(next, email);
    if (existing) {
      // Re-follow: keep the original timestamp, but let them update consent.
      existing.marketingOptIn = !!parent.marketingOptIn || existing.marketingOptIn === true
        ? (parent.marketingOptIn !== undefined ? !!parent.marketingOptIn : existing.marketingOptIn)
        : existing.marketingOptIn;
      if (parent.name) existing.name = String(parent.name);
      if (parent.area) existing.area = String(parent.area);
      return { state: next, added: false };
    }

    next.followers.push({
      id: safeUid(),
      name: parent.name ? String(parent.name) : "",
      email: email,
      area: parent.area ? String(parent.area) : "",
      followedAt: nowIso(),
      marketingOptIn: !!parent.marketingOptIn
    });
    return { state: next, added: true };
  }

  function findFollower(state, email) {
    if (!state || !Array.isArray(state.followers)) return null;
    var target = String(email || "").trim().toLowerCase();
    for (var i = 0; i < state.followers.length; i++) {
      if (state.followers[i] && String(state.followers[i].email).toLowerCase() === target) {
        return state.followers[i];
      }
    }
    return null;
  }

  // Simulate a batch of profile views, some of which convert to followers.
  // rate in [0,1] — deterministic by index so tests are stable (every Nth view
  // converts). Returns { state, viewsAdded, followersAdded }.
  function simulateProfileViews(state, count, rate, marketingShare) {
    var next = cloneState(state);
    var n = Math.max(0, Math.floor(Number(count) || 0));
    var r = Math.min(1, Math.max(0, Number(rate)));
    if (r === 0 && count) r = 0; // explicit
    var mShare = (marketingShare === undefined) ? 0.5 : Math.min(1, Math.max(0, Number(marketingShare)));
    var followersAdded = 0;
    var baseline = Array.isArray(next.followers) ? next.followers.length : 0;
    for (var i = 0; i < n; i++) {
      next = recordView(next);
      // Deterministic conversion: convert when (i+1) crosses the rate threshold.
      var shouldConvert = r > 0 && Math.floor((i + 1) * r) > Math.floor(i * r);
      if (shouldConvert) {
        var idx = baseline + followersAdded + 1;
        // Deterministic marketing consent: every other converted follower, up to share.
        var marketing = mShare > 0 && (followersAdded % Math.max(1, Math.round(1 / mShare)) === 0);
        var res = addFollower(next, {
          name: "Parent " + idx,
          email: "parent" + idx + "+" + (next.providerId || "camp") + "@example.com",
          area: pickArea(idx),
          marketingOptIn: marketing
        });
        next = res.state;
        if (res.added) followersAdded += 1;
      }
    }
    return { state: next, viewsAdded: n, followersAdded: followersAdded };
  }

  var SAMPLE_AREAS = ["Walthamstow", "Leyton", "Leytonstone", "Chingford", "Highams Park", "Woodford"];
  function pickArea(i) { return SAMPLE_AREAS[(Math.abs(i) % SAMPLE_AREAS.length)]; }

  // Toggle whether the provider has uploaded a Privacy Policy (gates export).
  function setPrivacyPolicy(state, has) {
    var next = cloneState(state);
    next.privacyPolicy = !!has;
    return next;
  }
  function setMember(state, isMember) {
    var next = cloneState(state);
    next.isMember = !!isMember;
    return next;
  }

  function followerCount(state) {
    return (state && Array.isArray(state.followers)) ? state.followers.length : 0;
  }

  // The provider's list-view rows. Per Happity, an email that has NOT opted into
  // marketing is "starred out" (masked). Members additionally see area; non-
  // members see area masked.
  function listForProvider(state) {
    if (!state || !Array.isArray(state.followers)) return [];
    var isMember = !!state.isMember;
    return state.followers.map(function (f) {
      return {
        id: f.id,
        name: f.name || "(parent)",
        emailDisplay: f.marketingOptIn ? f.email : maskEmail(f.email),
        marketingOptIn: !!f.marketingOptIn,
        // area is a member-only data point (anonymised location)
        area: isMember ? (f.area || "") : "",
        followedAt: f.followedAt
      };
    });
  }

  // Mask an email so the local part is starred but the shape is recognisable:
  //   "parent3@example.com" -> "p*****@example.com"
  function maskEmail(email) {
    var s = String(email || "");
    var at = s.indexOf("@");
    if (at <= 0) return "*****";
    var local = s.slice(0, at);
    var domain = s.slice(at); // includes "@"
    var first = local.charAt(0);
    return first + "*****" + domain;
  }

  // Only followers who gave EXPRESS marketing consent are exportable.
  function optedInFollowers(state) {
    if (!state || !Array.isArray(state.followers)) return [];
    return state.followers.filter(function (f) { return f && f.marketingOptIn === true; });
  }

  // Whether export is permitted at all. Per article 4291535/4147919: you must
  // have a Privacy Policy uploaded, AND there must be at least one opted-in
  // follower to export.
  function canExport(state) {
    return !!(state && state.privacyPolicy) && optedInFollowers(state).length > 0;
  }

  // Build the CSV of OPTED-IN followers (the acceptance criterion's export).
  // Returns { ok, reason, csv, rows }. Never throws.
  function exportOptedInCsv(state) {
    try {
      if (!state || !state.privacyPolicy) {
        return { ok: false, reason: "no-privacy-policy", csv: "", rows: 0 };
      }
      var opted = optedInFollowers(state);
      if (!opted.length) {
        return { ok: false, reason: "no-opted-in-followers", csv: "", rows: 0 };
      }
      var header = ["name", "email", "area", "followed_at"];
      var lines = [header.join(",")];
      for (var i = 0; i < opted.length; i++) {
        var f = opted[i];
        lines.push([
          csvCell(f.name),
          csvCell(f.email),
          csvCell(f.area),
          csvCell(f.followedAt)
        ].join(","));
      }
      return { ok: true, reason: "", csv: lines.join("\n"), rows: opted.length };
    } catch (e) {
      return { ok: false, reason: "error", csv: "", rows: 0 };
    }
  }

  function csvCell(v) {
    var s = String(v == null ? "" : v);
    if (/[",\n]/.test(s)) {
      return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
  }

  // Member-only: anonymised location breakdown (areas + counts), no emails.
  function locationBreakdown(state) {
    var out = {};
    if (!state || !state.isMember || !Array.isArray(state.followers)) return out;
    for (var i = 0; i < state.followers.length; i++) {
      var a = (state.followers[i] && state.followers[i].area) || "Unknown";
      out[a] = (out[a] || 0) + 1;
    }
    return out;
  }

  /* ============================================================ *
   *  PERSISTENCE (HC.store only — never raw localStorage)         *
   * ============================================================ */

  function loadState(seed) {
    var raw;
    try { raw = HC.store.get(STORE_KEY, null); } catch (e) { raw = null; }
    if (!raw || typeof raw !== "object") return emptyState(seed);
    if (!Array.isArray(raw.followers)) raw.followers = [];
    if (typeof raw.views !== "number") raw.views = 0;
    raw.privacyPolicy = !!raw.privacyPolicy;
    raw.isMember = !!raw.isMember;
    if (!raw.providerId && seed) { raw.providerId = seed.id; raw.providerName = seed.name; }
    return raw;
  }

  function saveState(state) {
    try { HC.store.set(STORE_KEY, state); } catch (e) {}
  }

  /* ---------------- live camp data ---------------- */

  function providers() {
    try { return HC.data.providers || []; } catch (e) { return []; }
  }

  // Pick a representative live provider (the "you" whose profile parents view).
  function pickSeedProvider() {
    var ps = providers();
    for (var i = 0; i < ps.length; i++) {
      if (ps[i] && ps[i].id && ps[i].name) return ps[i];
    }
    return { id: "demo-camp", name: "Holiday Camp Provider", area: "Walthamstow" };
  }

  /* ============================================================ *
   *  UI                                                           *
   * ============================================================ */

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function render(mountEl) {
    if (!mountEl) return;
    var seed = pickSeedProvider();
    var state = loadState(seed);
    // Keep the persisted provider in sync with the live seed.
    if (!state.providerId) { state.providerId = seed.id; state.providerName = seed.name; }

    mountEl.innerHTML = "";
    var wrap = HC.util.el("div", {
      style: "font-family:'Nunito Sans',system-ui,sans-serif;color:var(--text,#383838)"
    });

    wrap.appendChild(HC.util.el("p", { style: "font-size:14px;margin:0 0 6px" },
      "Built-in email marketing for <strong>" + esc(seed.name) + "</strong>. When parents view your " +
      "camp profile we invite them to <strong>Follow</strong> you. Followers accrue automatically — " +
      "you see the list and numbers here, and can export the parents who opted into your own marketing."));
    wrap.appendChild(HC.util.el("p", {
      style: "font-size:12px;color:var(--muted,#808080);margin:0 0 14px"
    }, "Customers › Followers — like Happity. A starred email opted in to timetable alerts only, not marketing."));

    // ---- KPI row ----
    var kpis = HC.util.el("div", { style: "display:flex;gap:12px;flex-wrap:wrap;margin:0 0 16px" });
    wrap.appendChild(kpis);

    // ---- controls: simulate views, privacy policy, membership ----
    var controls = HC.util.el("div", {
      style: "display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin:0 0 14px"
    });
    var viewBtn = HC.util.el("button", { class: "hc-btn", type: "button" }, "Simulate 20 profile views");
    var ppLabel = HC.util.el("label", {
      style: "display:flex;align-items:center;gap:6px;font-size:13px;cursor:pointer"
    });
    var ppCheck = HC.util.el("input", { type: "checkbox" });
    ppCheck.checked = !!state.privacyPolicy;
    ppLabel.appendChild(ppCheck);
    ppLabel.appendChild(HC.util.el("span", null, "Privacy Policy uploaded"));
    var memLabel = HC.util.el("label", {
      style: "display:flex;align-items:center;gap:6px;font-size:13px;cursor:pointer"
    });
    var memCheck = HC.util.el("input", { type: "checkbox" });
    memCheck.checked = !!state.isMember;
    memLabel.appendChild(memCheck);
    memLabel.appendChild(HC.util.el("span", null, "Member (location data)"));
    var exportBtn = HC.util.el("button", { class: "hc-btn hc-btn-ghost", type: "button" }, "Export opted-in followers (CSV)");
    var resetBtn = HC.util.el("button", { class: "hc-btn hc-btn-ghost", type: "button" }, "Reset");
    controls.appendChild(viewBtn);
    controls.appendChild(ppLabel);
    controls.appendChild(memLabel);
    controls.appendChild(exportBtn);
    controls.appendChild(resetBtn);
    wrap.appendChild(controls);

    // ---- followers table ----
    var tableHost = HC.util.el("div", {});
    wrap.appendChild(tableHost);

    mountEl.appendChild(wrap);

    function kpiCard(label, value, tint) {
      return '<div style="flex:1;min-width:120px;border:1.5px solid var(--line,#E6E6E6);border-radius:12px;' +
        'padding:12px 14px;background:' + (tint || "#fff") + '">' +
        '<div style="font-family:Quicksand,system-ui,sans-serif;font-weight:700;font-size:24px;color:var(--purple,#603488)">' +
          esc(value) + "</div>" +
        '<div style="font-size:11.5px;color:var(--muted,#808080);text-transform:uppercase;letter-spacing:.4px">' +
          esc(label) + "</div>" +
      "</div>";
    }

    function paint() {
      var optedIn = optedInFollowers(state).length;
      kpis.innerHTML =
        kpiCard("Profile views", state.views) +
        kpiCard("Followers", followerCount(state), "var(--purple-tint,#F0E8F4)") +
        kpiCard("Marketing opt-ins", optedIn, "var(--pink-tint,#FCE8F0)");

      var ableToExport = canExport(state);
      exportBtn.disabled = !ableToExport;
      exportBtn.style.opacity = ableToExport ? "1" : "0.5";
      exportBtn.title = state.privacyPolicy
        ? (optedIn ? "Export " + optedIn + " opted-in follower(s)" : "No opted-in followers to export yet")
        : "Upload a Privacy Policy first";

      var rows = listForProvider(state);
      if (!rows.length) {
        tableHost.innerHTML = '<p style="font-size:13px;color:var(--muted,#808080)">' +
          "No followers yet — simulate some profile views to watch followers accrue.</p>";
        return;
      }
      var head = '<tr style="text-align:left;border-bottom:1.5px solid var(--line,#E6E6E6)">' +
        '<th style="padding:8px 8px;font-size:11.5px;text-transform:uppercase;letter-spacing:.4px;color:var(--magenta,#F82488)">Parent</th>' +
        '<th style="padding:8px 8px;font-size:11.5px;text-transform:uppercase;letter-spacing:.4px;color:var(--magenta,#F82488)">Email</th>' +
        '<th style="padding:8px 8px;font-size:11.5px;text-transform:uppercase;letter-spacing:.4px;color:var(--magenta,#F82488)">Area</th>' +
        '<th style="padding:8px 8px;font-size:11.5px;text-transform:uppercase;letter-spacing:.4px;color:var(--magenta,#F82488)">Marketing</th>' +
      "</tr>";
      var body = rows.map(function (r) {
        return '<tr style="border-bottom:1px solid var(--line,#E6E6E6)">' +
          '<td style="padding:8px 8px;font-size:13px">' + esc(r.name) + "</td>" +
          '<td style="padding:8px 8px;font-size:13px;font-family:ui-monospace,monospace">' + esc(r.emailDisplay) + "</td>" +
          '<td style="padding:8px 8px;font-size:13px;color:var(--muted,#808080)">' +
            (r.area ? esc(r.area) : (state.isMember ? "—" : "<span title=\"Members only\">🔒</span>")) + "</td>" +
          '<td style="padding:8px 8px;font-size:13px">' +
            (r.marketingOptIn
              ? '<span style="color:#2f7d4f;font-weight:700">opted in ✓</span>'
              : '<span style="color:var(--muted,#808080)">timetable only</span>') +
          "</td>" +
        "</tr>";
      }).join("");
      tableHost.innerHTML =
        '<table style="width:100%;border-collapse:collapse">' + head + body + "</table>";
    }

    viewBtn.addEventListener("click", function () {
      // 30% of views convert to a follower; half of those opt into marketing.
      var res = simulateProfileViews(state, 20, 0.3, 0.5);
      state = res.state;
      saveState(state);
      try { HC.util.toast(res.followersAdded + " new follower(s) from " + res.viewsAdded + " views"); } catch (e) {}
      paint();
    });

    ppCheck.addEventListener("change", function () {
      state = setPrivacyPolicy(state, ppCheck.checked);
      saveState(state);
      paint();
    });

    memCheck.addEventListener("change", function () {
      state = setMember(state, memCheck.checked);
      saveState(state);
      paint();
    });

    exportBtn.addEventListener("click", function () {
      var out = exportOptedInCsv(state);
      if (!out.ok) {
        var msg = out.reason === "no-privacy-policy"
          ? "Upload a Privacy Policy to export follower data"
          : "No opted-in followers to export yet";
        try { HC.util.toast(msg); } catch (e) {}
        return;
      }
      try {
        HC.util.modal('<h2>📤 Export — opted-in followers</h2>' +
          '<p style="font-size:13px;color:var(--muted,#808080);margin:0 0 10px">' +
          out.rows + " marketing-opted-in follower(s), ready for your email tool (CSV).</p>" +
          '<textarea readonly style="width:100%;height:160px;font-family:ui-monospace,monospace;font-size:12px;' +
          'border:1.5px solid var(--line,#E6E6E6);border-radius:10px;padding:10px;box-sizing:border-box">' +
          esc(out.csv) + "</textarea>");
      } catch (e) {
        try { HC.util.toast("Exported " + out.rows + " opted-in follower(s)"); } catch (e2) {}
      }
    });

    resetBtn.addEventListener("click", function () {
      state = emptyState(seed);
      saveState(state);
      ppCheck.checked = false;
      memCheck.checked = false;
      try { HC.util.toast("Followers reset"); } catch (e) {}
      paint();
    });

    paint();
  }

  /* ============================================================ *
   *  selfTest — exercises the LOGIC and the acceptance criterion  *
   * ============================================================ */

  function selfTest() {
    var pass = 0, fail = 0, log = [];
    function check(label, fn) {
      try { fn(); pass += 1; log.push("✓ " + label); }
      catch (e) { fail += 1; log.push("✗ " + label + " — " + (e && e.message ? e.message : String(e))); }
    }

    var seed = { id: "camp-x", name: "Lloyd Park Holiday Club" };

    // --- ACCEPTANCE CRITERION, part 1: followers ACCRUE FROM PROFILE VIEWS ---
    check("Followers accrue from profile views (a view can convert to a follow)", function () {
      var s = emptyState(seed);
      HC.assert(followerCount(s) === 0, "no followers to start");
      HC.assert(s.views === 0, "no views to start");
      var res = simulateProfileViews(s, 10, 0.5, 0.5); // half of views convert
      s = res.state;
      HC.assert(s.views === 10, "ten profile views recorded, got " + s.views);
      HC.assert(followerCount(s) > 0, "at least one view should convert to a follower");
      HC.assert(followerCount(s) === res.followersAdded, "follower count matches accrued followers");
      HC.assert(followerCount(s) <= s.views, "followers cannot exceed views");
    });

    check("recordView increments views without creating a follower", function () {
      var s = emptyState(seed);
      s = recordView(s);
      s = recordView(s);
      HC.assert(s.views === 2, "two views recorded");
      HC.assert(followerCount(s) === 0, "a bare view does not create a follower");
    });

    // --- ACCEPTANCE CRITERION, part 2: the provider SEES THE LIST ---
    check("Provider sees the follower list and count", function () {
      var s = emptyState(seed);
      s = addFollower(s, { name: "Asha", email: "asha@example.com", area: "Leyton", marketingOptIn: true }).state;
      s = addFollower(s, { name: "Ben", email: "ben@example.com", area: "Chingford", marketingOptIn: false }).state;
      HC.assert(followerCount(s) === 2, "two followers in the list");
      var list = listForProvider(s);
      HC.assert(list.length === 2, "list view returns a row per follower");
      HC.assert(list[0].name === "Asha", "follower name shown to provider");
    });

    // --- ACCEPTANCE CRITERION, part 3: EXPORT OPTED-IN FOLLOWERS ---
    check("Provider can export ONLY the opted-in followers as CSV", function () {
      var s = emptyState(seed);
      s = setPrivacyPolicy(s, true); // privacy policy in place
      s = addFollower(s, { name: "Asha", email: "asha@example.com", area: "Leyton", marketingOptIn: true }).state;
      s = addFollower(s, { name: "Ben", email: "ben@example.com", area: "Chingford", marketingOptIn: false }).state;
      s = addFollower(s, { name: "Cara", email: "cara@example.com", area: "Woodford", marketingOptIn: true }).state;
      HC.assert(optedInFollowers(s).length === 2, "two of three followers opted into marketing");
      HC.assert(canExport(s) === true, "export allowed: privacy policy + opted-in followers present");
      var out = exportOptedInCsv(s);
      HC.assert(out.ok === true, "export should succeed");
      HC.assert(out.rows === 2, "CSV carries exactly the two opted-in followers, got " + out.rows);
      HC.assert(out.csv.indexOf("asha@example.com") !== -1, "opted-in Asha is in the CSV");
      HC.assert(out.csv.indexOf("cara@example.com") !== -1, "opted-in Cara is in the CSV");
      HC.assert(out.csv.indexOf("ben@example.com") === -1, "non-opted-in Ben is NOT in the CSV");
      var lines = out.csv.split("\n");
      HC.assert(lines.length === 3, "CSV = header + 2 rows, got " + lines.length + " lines");
      HC.assert(lines[0].indexOf("email") !== -1, "CSV has a header row");
    });

    // --- Export gated on a Privacy Policy (Happity: must be uploaded) ---
    check("Export is blocked until a Privacy Policy is uploaded", function () {
      var s = emptyState(seed);
      s = addFollower(s, { name: "Asha", email: "asha@example.com", marketingOptIn: true }).state;
      HC.assert(s.privacyPolicy === false, "no privacy policy by default");
      HC.assert(canExport(s) === false, "cannot export without a privacy policy");
      var blocked = exportOptedInCsv(s);
      HC.assert(blocked.ok === false, "export refused");
      HC.assert(blocked.reason === "no-privacy-policy", "reason names the missing privacy policy");
      // upload it -> now allowed
      s = setPrivacyPolicy(s, true);
      HC.assert(canExport(s) === true, "export allowed once policy uploaded");
      HC.assert(exportOptedInCsv(s).ok === true, "export now succeeds");
    });

    // --- Export with no opted-in followers is refused even with a policy ---
    check("Export refused when nobody opted into marketing", function () {
      var s = emptyState(seed);
      s = setPrivacyPolicy(s, true);
      s = addFollower(s, { name: "Ben", email: "ben@example.com", marketingOptIn: false }).state;
      HC.assert(optedInFollowers(s).length === 0, "no opted-in followers");
      HC.assert(canExport(s) === false, "nothing to export");
      var out = exportOptedInCsv(s);
      HC.assert(out.ok === false && out.reason === "no-opted-in-followers", "refused for lack of opted-in followers");
    });

    // --- Timetable-only followers are STARRED OUT in the list (masked) ---
    check("Timetable-only (non-marketing) followers are starred out in the list", function () {
      var s = emptyState(seed);
      s = addFollower(s, { name: "Asha", email: "asha@example.com", marketingOptIn: true }).state;
      s = addFollower(s, { name: "Ben", email: "ben@example.com", marketingOptIn: false }).state;
      var list = listForProvider(s);
      var asha = list[0], ben = list[1];
      HC.assert(asha.emailDisplay === "asha@example.com", "opted-in email shown in full");
      HC.assert(ben.emailDisplay.indexOf("*") !== -1, "non-marketing email is masked");
      HC.assert(ben.emailDisplay.indexOf("ben@example.com") === -1, "raw non-marketing email is not shown");
      HC.assert(ben.emailDisplay === "b*****@example.com", "mask keeps first char + domain, got " + ben.emailDisplay);
    });

    // --- A follow is idempotent on email; no duplicate followers ---
    check("Following twice with the same email does not duplicate the follower", function () {
      var s = emptyState(seed);
      var r1 = addFollower(s, { name: "Asha", email: "Asha@Example.com", marketingOptIn: false });
      s = r1.state;
      HC.assert(r1.added === true, "first follow adds the follower");
      var r2 = addFollower(s, { name: "Asha", email: "asha@example.com", marketingOptIn: true });
      s = r2.state;
      HC.assert(r2.added === false, "re-following is not a new follower");
      HC.assert(followerCount(s) === 1, "still a single follower record");
      HC.assert(optedInFollowers(s).length === 1, "re-follow upgraded them to opted-in");
    });

    // --- A Follow does NOT imply marketing consent (separate express opt-in) ---
    check("A bare Follow does not imply marketing consent", function () {
      var s = emptyState(seed);
      s = addFollower(s, { name: "Ben", email: "ben@example.com" }).state; // no marketingOptIn
      HC.assert(followerCount(s) === 1, "they are a follower");
      HC.assert(optedInFollowers(s).length === 0, "but not a marketing opt-in");
    });

    // --- Member benefit: anonymised location breakdown (no emails) ---
    check("Member-only location breakdown aggregates areas without emails", function () {
      var s = emptyState(seed);
      s = addFollower(s, { name: "A", email: "a@x.com", area: "Leyton", marketingOptIn: false }).state;
      s = addFollower(s, { name: "B", email: "b@x.com", area: "Leyton", marketingOptIn: true }).state;
      s = addFollower(s, { name: "C", email: "c@x.com", area: "Chingford", marketingOptIn: false }).state;
      HC.assert(Object.keys(locationBreakdown(s)).length === 0, "non-members get no location data");
      s = setMember(s, true);
      var b = locationBreakdown(s);
      HC.assert(b.Leyton === 2, "two followers in Leyton, got " + b.Leyton);
      HC.assert(b.Chingford === 1, "one follower in Chingford");
      // and a non-member should not even see area in the list rows
      var sNon = setMember(s, false);
      HC.assert(listForProvider(sNon)[0].area === "", "non-member list hides area");
      HC.assert(listForProvider(s)[0].area !== "", "member list shows area");
    });

    // --- CSV escaping is safe for names with commas/quotes ---
    check("CSV export escapes commas and quotes safely", function () {
      var s = emptyState(seed);
      s = setPrivacyPolicy(s, true);
      s = addFollower(s, { name: "O'Hara, \"Sam\"", email: "sam@example.com", area: "Leyton", marketingOptIn: true }).state;
      var out = exportOptedInCsv(s);
      HC.assert(out.ok === true, "export succeeds");
      HC.assert(out.csv.indexOf('"O\'Hara, ""Sam"""') !== -1, "name with comma/quotes is CSV-quoted");
      var lines = out.csv.split("\n");
      HC.assert(lines.length === 2, "comma in a field did not split the row (header + 1 row)");
    });

    // --- Defensive: bad inputs never throw or corrupt state ---
    check("Defensive against missing email / bad inputs", function () {
      var s = emptyState(seed);
      var r1 = addFollower(s, null);
      HC.assert(r1.added === false && followerCount(r1.state) === 0, "null parent is a no-op");
      var r2 = addFollower(s, { name: "No Email" });
      HC.assert(r2.added === false && followerCount(r2.state) === 0, "a parent with no email cannot follow");
      var sim = simulateProfileViews(s, 0, 0.5, 0.5);
      HC.assert(sim.state.views === 0 && followerCount(sim.state) === 0, "zero views is a no-op");
      HC.assert(exportOptedInCsv(null).ok === false, "export on null state is safely refused");
    });

    // --- Persistence round-trips through HC.store (namespaced) ---
    check("Follower state persists via HC.store", function () {
      var s = emptyState(seed);
      s = setPrivacyPolicy(s, true);
      s = simulateProfileViews(s, 8, 0.5, 0.5).state;
      var beforeCount = followerCount(s);
      var ok = HC.store.set(STORE_KEY, s);
      HC.assert(ok !== false, "store.set should succeed");
      var got = HC.store.get(STORE_KEY, null);
      HC.assert(got && Array.isArray(got.followers), "followers survive a store round-trip");
      HC.assert(followerCount(got) === beforeCount, "follower count survives persistence");
      HC.assert(got.privacyPolicy === true, "privacy-policy flag survives persistence");
      HC.assert(got.views === 8, "view count survives persistence");
      // clean up so we don't leave probe state lying around
      try { HC.store.remove ? HC.store.remove(STORE_KEY) : HC.store.set(STORE_KEY, null); } catch (e) {}
    });

    // --- Seed provider comes from the LIVE school-age holiday-camp directory ---
    check("Seed provider comes from the live holiday-camp directory", function () {
      var s = pickSeedProvider();
      HC.assert(s && typeof s.id === "string" && s.id.length > 0, "seed has a provider id");
      HC.assert(typeof s.name === "string" && s.name.length > 0, "seed has a provider name");
      var ps = providers();
      if (ps.length) {
        var found = ps.some(function (p) { return p && p.id === s.id; });
        HC.assert(found, "seed should be a real directory provider when data is present");
      }
    });

    return { pass: pass, fail: fail, log: log };
  }

  /* ============================================================ *
   *  register                                                     *
   * ============================================================ */

  HC.registerFeature({
    id: "provider-followers",
    title: "Followers list (built-in email marketing)",
    side: "provider",
    icon: "📣",
    summary: "Parents who view your camp profile can Follow you — followers accrue automatically. " +
      "See your follower list and numbers, with timetable-only followers starred out, and export the " +
      "parents who opted into your own marketing as CSV (Privacy Policy required), following the same marketplace pattern.",
    render: render,
    selfTest: selfTest
  });
})();
