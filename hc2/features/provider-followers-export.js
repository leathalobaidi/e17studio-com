/* HolidayCamp feature: provider-followers-export
 * ------------------------------------------------------------------
 * Replicates Happity's "Followers / zero-effort email marketing"
 * behaviour for the PROVIDER side, reframed for SCHOOL-AGE HOLIDAY
 * CAMPS (not baby classes).
 *
 * Evidence (support corpus):
 *  - 4291535 "How to use Happity Followers for zero-effort email
 *    marketing":
 *      §"Your ready-made email marketing list": "parents are also asked
 *      if they would like to opt-in to YOUR OWN newsletter too. We ask
 *      for their express permission to share their email addresses with
 *      you, so that you can export your followers to do your own email
 *      marketing if you wish."
 *      §"Member Benefits": "you'll be able to export a list of your
 *      opted-in followers to use in your own newsletter (provided
 *      you've got a Privacy Policy in place)."
 *      §"Accessing Your Follower List": "if you have an uploaded Privacy
 *      Policy, you'll also be able to export this data. If the customers
 *      email address is starred out, this means that they have opted in
 *      to receive timetable information ... but they have not opted in
 *      for marketing."
 *  - 5972958 "Can I see my customer's marketing preferences?": the
 *    opt-in is a "GDPR compliant marketing opt in"; only those who
 *    selected "Yes" can be contacted about marketing.
 *
 * Acceptance criterion (asserted by selfTest, multiple cases):
 *   Export is GATED on having a Privacy Policy, AND produces a
 *   CONTACTABLE list. Concretely:
 *     - With NO Privacy Policy, export is blocked (no file is produced,
 *       a reason is returned) regardless of how many opted-in followers
 *       exist.
 *     - With a Privacy Policy in place, export succeeds and the produced
 *       list contains ONLY marketing opt-ins with real (un-starred,
 *       contactable) email addresses; timetable-only followers are
 *       excluded and their emails are never leaked.
 *
 * Defensive: nothing throws at registration time. Persistence is via
 * HC.store ONLY (two namespaced keys, keyed by provider id); the
 * verified camps.js data is never mutated.
 * ------------------------------------------------------------------ */
(function () {
  "use strict";

  if (typeof window === "undefined" || !window.HC || typeof window.HC.registerFeature !== "function") {
    // Core not present — fail silently rather than throwing.
    return;
  }
  var HC = window.HC;

  // Per-provider follower roster: { [providerId]: [ follower, ... ] }
  var STORE_FOLLOWERS = "provider_followers";
  // Per-provider privacy-policy status: { [providerId]: { url, uploadedAt } }
  var STORE_PRIVACY = "provider_privacy_policy";

  /* ============================================================
   * 1. Pure helpers — defensive, no exceptions escape.
   * ============================================================ */

  function trimStr(s) { return String(s == null ? "" : s).replace(/\s+/g, " ").trim(); }

  // Minimal, defensive email check. Good enough to tell "contactable
  // address" from "starred out / blank". Not an RFC validator.
  var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  function isContactableEmail(email) {
    var e = trimStr(email);
    if (!e) return false;
    // A starred-out address (e.g. "j****@gmail.com" or "•••") is NOT
    // contactable — the '*'/'•' masking means we were never given it.
    if (e.indexOf("*") !== -1 || e.indexOf("•") !== -1) return false;
    return EMAIL_RE.test(e);
  }

  // Display form of an email for the *on-screen* list. Marketing opt-ins
  // see their real address; timetable-only followers are starred out,
  // exactly as Happity describes (4291535 §Accessing Your Follower List).
  function maskEmail(email) {
    var e = trimStr(email);
    var at = e.indexOf("@");
    if (at <= 0) return "*****";
    var name = e.slice(0, at);
    var domain = e.slice(at);
    var first = name.charAt(0);
    return first + "****" + domain;
  }

  /* ============================================================
   * 2. Privacy-policy state (the export GATE).
   * ============================================================ */

  function readPrivacy(providerId) {
    var all = HC.store.get(STORE_PRIVACY, {}) || {};
    var p = all[providerId];
    return (p && typeof p === "object") ? p : null;
  }

  function hasPrivacyPolicy(providerId) {
    var p = readPrivacy(providerId);
    return !!(p && trimStr(p.url));
  }

  function setPrivacyPolicy(providerId, url) {
    var clean = trimStr(url);
    if (!clean) return { ok: false, error: "Add a link to your Privacy Policy first." };
    var all = HC.store.get(STORE_PRIVACY, {}) || {};
    all[providerId] = { url: clean, uploadedAt: Date.now() };
    HC.store.set(STORE_PRIVACY, all);
    return { ok: true };
  }

  function clearPrivacyPolicy(providerId) {
    var all = HC.store.get(STORE_PRIVACY, {}) || {};
    delete all[providerId];
    HC.store.set(STORE_PRIVACY, all);
  }

  /* ============================================================
   * 3. Follower roster (read / write / normalise).
   *    A follower:
   *      { id, name, email, area, marketingOptIn:Boolean, followedAt }
   *    - Every follower opted in to TIMETABLE updates (that is what
   *      "Follow" means on Happity).
   *    - marketingOptIn === true means they additionally gave express
   *      permission to share their email for YOUR own newsletter — the
   *      only ones exportable.
   * ============================================================ */

  function normaliseFollower(raw) {
    var f = raw && typeof raw === "object" ? raw : {};
    return {
      id: trimStr(f.id) || HC.util.uid(),
      name: trimStr(f.name) || "Follower",
      email: trimStr(f.email),
      area: trimStr(f.area),
      marketingOptIn: f.marketingOptIn === true,
      followedAt: Number(f.followedAt) || Date.now()
    };
  }

  function readFollowers(providerId) {
    var all = HC.store.get(STORE_FOLLOWERS, {}) || {};
    var list = all[providerId];
    if (!Array.isArray(list)) return [];
    return list.map(normaliseFollower);
  }

  function writeFollowers(providerId, list) {
    var all = HC.store.get(STORE_FOLLOWERS, {}) || {};
    all[providerId] = (Array.isArray(list) ? list : []).map(normaliseFollower);
    HC.store.set(STORE_FOLLOWERS, all);
    return all[providerId];
  }

  function clearFollowers(providerId) {
    var all = HC.store.get(STORE_FOLLOWERS, {}) || {};
    delete all[providerId];
    HC.store.set(STORE_FOLLOWERS, all);
  }

  // A parent follows the camp. Defaults to timetable-only unless they
  // tick the marketing opt-in box.
  function addFollower(providerId, follower) {
    var list = readFollowers(providerId);
    var nf = normaliseFollower(follower);
    // De-dupe by email (case-insensitive) where one is present.
    if (nf.email) {
      var lower = nf.email.toLowerCase();
      list = list.filter(function (f) { return trimStr(f.email).toLowerCase() !== lower; });
    }
    list.push(nf);
    writeFollowers(providerId, list);
    return nf;
  }

  /* ============================================================
   * 4. Roster stats — what the Followers page shows.
   * ============================================================ */

  function followerStats(list) {
    var followers = Array.isArray(list) ? list : [];
    var optedIn = followers.filter(function (f) { return f.marketingOptIn === true; });
    // Of the opted-in, how many actually have a contactable email.
    var contactable = optedIn.filter(function (f) { return isContactableEmail(f.email); });
    // Anonymised location roll-up (the Member-only benefit, 4291535).
    var areas = {};
    followers.forEach(function (f) {
      var a = trimStr(f.area) || "Unknown";
      areas[a] = (areas[a] || 0) + 1;
    });
    return {
      total: followers.length,
      timetableOnly: followers.length - optedIn.length,
      marketingOptIns: optedIn.length,
      contactable: contactable.length,
      areas: areas
    };
  }

  // The on-screen roster: marketing opt-ins see their real email,
  // timetable-only followers are starred out.
  function rosterRows(list) {
    return (Array.isArray(list) ? list : []).map(function (f) {
      return {
        name: f.name,
        area: f.area || "—",
        marketingOptIn: f.marketingOptIn === true,
        emailDisplay: f.marketingOptIn === true && isContactableEmail(f.email)
          ? f.email
          : maskEmail(f.email)
      };
    });
  }

  /* ============================================================
   * 5. THE EXPORT — gated on a Privacy Policy, produces a
   *    contactable list. This is the acceptance criterion.
   * ============================================================ */

  function buildContactList(list) {
    // Only marketing opt-ins WITH a real, un-starred email are
    // contactable. Timetable-only followers are excluded outright and
    // their addresses are never placed in the output.
    return (Array.isArray(list) ? list : [])
      .filter(function (f) { return f.marketingOptIn === true && isContactableEmail(f.email); })
      .map(function (f) {
        return { name: f.name, email: trimStr(f.email), area: f.area || "" };
      });
  }

  function csvCell(s) {
    var v = String(s == null ? "" : s);
    if (/[",\n]/.test(v)) return '"' + v.replace(/"/g, '""') + '"';
    return v;
  }

  function toCsv(rows) {
    var head = ["Name", "Email", "Area"];
    var lines = [head.join(",")];
    rows.forEach(function (r) {
      lines.push([csvCell(r.name), csvCell(r.email), csvCell(r.area)].join(","));
    });
    return lines.join("\n");
  }

  // exportFollowers(providerId) -> result object.
  //  Blocked  : { ok:false, reason:'no-privacy-policy', count:0, csv:null }
  //  Empty    : { ok:false, reason:'no-contactable-followers', count:0, csv:null }
  //  Success  : { ok:true, count:N, rows:[...], csv:"..." }
  function exportFollowers(providerId) {
    // GATE 1: a Privacy Policy MUST be in place (4291535).
    if (!hasPrivacyPolicy(providerId)) {
      return { ok: false, reason: "no-privacy-policy", count: 0, rows: [], csv: null };
    }
    var rows = buildContactList(readFollowers(providerId));
    if (!rows.length) {
      return { ok: false, reason: "no-contactable-followers", count: 0, rows: [], csv: null };
    }
    return { ok: true, reason: null, count: rows.length, rows: rows, csv: toCsv(rows) };
  }

  /* ============================================================
   * 6. Demo seeding — a realistic mixed roster for a live provider.
   * ============================================================ */

  function demoProvider() {
    var ps = HC.data.providers || [];
    for (var i = 0; i < ps.length; i++) {
      if (ps[i] && ps[i].id && ps[i].name) return ps[i];
    }
    return { id: "demo-camp", name: "Demo Holiday Camp", area: "Walthamstow" };
  }

  function seedRoster() {
    // A spread of school-age holiday-camp parents: some opted in to
    // marketing, some timetable-only (their email is withheld/starred).
    return [
      { id: "f1", name: "Amara Okafor",   email: "amara.okafor@gmail.com",   area: "Walthamstow",  marketingOptIn: true },
      { id: "f2", name: "Tom Bridges",    email: "tom.bridges@outlook.com",  area: "Leyton",       marketingOptIn: true },
      { id: "f3", name: "Priya Shah",     email: "priya.shah@yahoo.co.uk",   area: "Leytonstone",  marketingOptIn: true },
      { id: "f4", name: "Daniel Reeves",  email: "d.reeves@me.com",          area: "Chingford",    marketingOptIn: true },
      // Timetable-only: followed for the term timetable, did NOT opt in
      // to the camp's own newsletter — email withheld (starred on screen).
      { id: "f5", name: "Sofia Marino",   email: "",                         area: "Walthamstow",  marketingOptIn: false },
      { id: "f6", name: "James Whitlock", email: "",                         area: "Highams Park", marketingOptIn: false },
      { id: "f7", name: "Lena Hoffmann",  email: "",                         area: "Leyton",       marketingOptIn: false }
    ];
  }

  function ensureSeeded(providerId) {
    var list = readFollowers(providerId);
    if (!list.length) writeFollowers(providerId, seedRoster());
    return readFollowers(providerId);
  }

  /* ============================================================
   * 7. Render — the provider's "Customers > Followers" page:
   *    follower roster + anonymised areas on the left, the
   *    privacy-policy-gated Export on the right.
   * ============================================================ */

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function areasHtml(areas) {
    var keys = Object.keys(areas || {}).sort(function (a, b) { return areas[b] - areas[a]; });
    if (!keys.length) return '<span style="color:var(--muted,#808080)">No follower locations yet.</span>';
    return keys.map(function (a) {
      return '<span style="display:inline-block;background:var(--purple-tint,#F0E8F4);color:var(--purple,#603488);' +
        'font-size:12px;font-weight:700;padding:3px 10px;border-radius:999px;margin:0 6px 6px 0">' +
        esc(a) + " · " + areas[a] + "</span>";
    }).join("");
  }

  function rosterTableHtml(rows) {
    if (!rows.length) return '<p style="color:var(--muted,#808080)">No followers yet.</p>';
    var body = rows.map(function (r) {
      var badge = r.marketingOptIn
        ? '<span style="color:#2f7d4f;font-weight:700;font-size:12px">✓ Marketing</span>'
        : '<span style="color:var(--muted,#808080);font-size:12px">Timetable only</span>';
      return "<tr>" +
        '<td style="padding:7px 8px;border-bottom:1px solid var(--line,#E6E6E6)">' + esc(r.name) + "</td>" +
        '<td style="padding:7px 8px;border-bottom:1px solid var(--line,#E6E6E6);font-family:monospace;font-size:12px">' + esc(r.emailDisplay) + "</td>" +
        '<td style="padding:7px 8px;border-bottom:1px solid var(--line,#E6E6E6)">' + esc(r.area) + "</td>" +
        '<td style="padding:7px 8px;border-bottom:1px solid var(--line,#E6E6E6)">' + badge + "</td>" +
        "</tr>";
    }).join("");
    return '<table style="width:100%;border-collapse:collapse;font-size:13px">' +
      '<thead><tr>' +
        '<th style="text-align:left;padding:7px 8px;color:var(--purple,#603488);font-size:12px">Parent</th>' +
        '<th style="text-align:left;padding:7px 8px;color:var(--purple,#603488);font-size:12px">Email</th>' +
        '<th style="text-align:left;padding:7px 8px;color:var(--purple,#603488);font-size:12px">Area</th>' +
        '<th style="text-align:left;padding:7px 8px;color:var(--purple,#603488);font-size:12px">Opt-in</th>' +
      "</tr></thead><tbody>" + body + "</tbody></table>";
  }

  function paintExportPanel(mountEl, prov) {
    var panel = mountEl.querySelector("[data-fx-panel]");
    if (!panel) return;
    var has = hasPrivacyPolicy(prov.id);
    var stats = followerStats(readFollowers(prov.id));
    var html = "";

    if (!has) {
      html =
        '<div style="background:var(--pink-tint,#FCE8F0);border:1.5px solid #f6b8d4;border-radius:14px;padding:14px">' +
          '<div style="font-weight:700;color:#9a1f5e;margin-bottom:4px">🔒 Export locked</div>' +
          '<p style="font-size:13px;color:#9a1f5e;margin:0 0 10px">' +
            "To export your opted-in followers for your own newsletter, you need a " +
            "<strong>Privacy Policy</strong> in place (GDPR). Add the link to unlock export." +
          "</p>" +
          '<input type="url" data-fx-pp placeholder="https://yourcamp.co.uk/privacy" ' +
            'style="width:100%;box-sizing:border-box;padding:9px 11px;border:1.5px solid #f6b8d4;border-radius:12px;font-size:13px;margin-bottom:8px">' +
          '<button class="hc-btn" data-fx-savepp type="button">Save Privacy Policy</button>' +
        "</div>";
    } else {
      html =
        '<div style="background:#E1F0E4;border:1.5px solid #a9d8ba;border-radius:14px;padding:14px;margin-bottom:12px">' +
          '<div style="font-weight:700;color:#2f7d4f;margin-bottom:2px">✓ Privacy Policy in place</div>' +
          '<p style="font-size:12.5px;color:#2f7d4f;margin:0">Export of opted-in followers is unlocked.</p>' +
        "</div>" +
        '<p style="font-size:13px;color:var(--text,#383838);margin:0 0 10px">' +
          "<strong>" + stats.contactable + "</strong> contactable follower(s) ready to export " +
          '(<span style="color:var(--muted,#808080)">' + stats.timetableOnly + " timetable-only followers are excluded</span>)." +
        "</p>" +
        '<button class="hc-btn" data-fx-export type="button">⬇ Export contactable list (CSV)</button> ' +
        '<button class="hc-btn hc-btn-ghost" data-fx-removepp type="button">Remove policy</button>' +
        '<pre data-fx-out style="display:none;background:#faf8fc;border:1px solid var(--line,#E6E6E6);border-radius:12px;' +
          'padding:12px;font-size:11.5px;margin-top:12px;white-space:pre-wrap;max-height:180px;overflow:auto"></pre>';
    }
    panel.innerHTML = html;
  }

  function render(mountEl) {
    try {
      var prov = demoProvider();
      ensureSeeded(prov.id);
      var list = readFollowers(prov.id);
      var stats = followerStats(list);

      mountEl.innerHTML =
        '<p style="font-size:13.5px;color:var(--text,#383838);margin:0 0 14px">' +
          "<strong>Customers &gt; Followers</strong> for <strong>" + esc(prov.name) + "</strong>. " +
          "Parents who follow your camp get your term timetables automatically. Those who also opted in to " +
          "your own newsletter can be <strong>exported</strong> — once you have a Privacy Policy in place." +
        "</p>" +
        '<div style="display:flex;gap:10px;flex-wrap:wrap;margin:0 0 14px">' +
          '<span class="hc-pill hc-pill-total" style="font-size:13px;padding:7px 12px">' + stats.total + " followers</span>" +
          '<span class="hc-pill hc-pill-pass" style="font-size:13px;padding:7px 12px">' + stats.marketingOptIns + " marketing opt-ins</span>" +
          '<span class="hc-pill hc-pill-total" style="font-size:13px;padding:7px 12px">' + stats.contactable + " contactable</span>" +
        "</div>" +
        '<div style="display:grid;grid-template-columns:1fr;gap:18px">' +
          "<div>" +
            '<div style="font-weight:700;color:var(--purple,#603488);font-size:13px;margin-bottom:6px">Follower list</div>' +
            '<div data-fx-roster style="border:1px solid var(--line,#E6E6E6);border-radius:14px;padding:8px 10px;overflow:auto">' +
              rosterTableHtml(rosterRows(list)) +
            "</div>" +
            '<div style="font-weight:700;color:var(--purple,#603488);font-size:13px;margin:14px 0 6px">' +
              "Where your followers are (anonymised · Member benefit)</div>" +
            "<div>" + areasHtml(stats.areas) + "</div>" +
          "</div>" +
          '<div data-fx-panel></div>' +
        "</div>";

      paintExportPanel(mountEl, prov);

      mountEl.addEventListener("click", function (ev) {
        var savePp = ev.target.closest("[data-fx-savepp]");
        if (savePp) {
          var input = mountEl.querySelector("[data-fx-pp]");
          var r = setPrivacyPolicy(prov.id, input ? input.value : "");
          if (!r.ok) { HC.util.toast(r.error); return; }
          HC.util.toast("Privacy Policy saved — export unlocked");
          paintExportPanel(mountEl, prov);
          return;
        }
        var removePp = ev.target.closest("[data-fx-removepp]");
        if (removePp) {
          clearPrivacyPolicy(prov.id);
          HC.util.toast("Privacy Policy removed — export locked");
          paintExportPanel(mountEl, prov);
          return;
        }
        var exportBtn = ev.target.closest("[data-fx-export]");
        if (exportBtn) {
          var res = exportFollowers(prov.id);
          var out = mountEl.querySelector("[data-fx-out]");
          if (!res.ok) {
            HC.util.toast(res.reason === "no-privacy-policy"
              ? "Add a Privacy Policy first"
              : "No contactable followers to export yet");
            return;
          }
          if (out) {
            out.style.display = "block";
            out.textContent = "followers-" + prov.id + ".csv  (" + res.count + " contactable)\n\n" + res.csv;
          }
          HC.util.toast("Exported " + res.count + " contactable follower(s)");
          return;
        }
      });
    } catch (e) {
      mountEl.innerHTML = '<p style="color:#9a1f5e">Followers export failed to load: ' +
        esc(e && e.message ? e.message : String(e)) + "</p>";
    }
  }

  /* ============================================================
   * 8. selfTest — exercises the LOGIC and asserts the acceptance
   *    criterion across multiple cases.
   * ============================================================ */
  function selfTest() {
    var pass = 0, fail = 0, log = [];
    function check(name, fn) {
      try { fn(); pass++; log.push("✓ " + name); }
      catch (e) { fail++; log.push("✗ " + name + " — " + (e && e.message ? e.message : String(e))); }
    }

    var TID = "__fx_test_provider__";
    clearFollowers(TID);
    clearPrivacyPolicy(TID);

    // --- contactable-email detection ---
    check("A real email is contactable", function () {
      HC.assert(isContactableEmail("a.parent@gmail.com") === true, "real email should be contactable");
    });
    check("A starred-out email is NOT contactable", function () {
      HC.assert(isContactableEmail("a****@gmail.com") === false, "masked email must not be contactable");
      HC.assert(isContactableEmail("•••@x.com") === false, "bullet-masked email must not be contactable");
    });
    check("A blank email is NOT contactable", function () {
      HC.assert(isContactableEmail("") === false && isContactableEmail("   ") === false, "blank is not contactable");
    });

    // --- privacy-policy gate state ---
    check("A fresh provider has no Privacy Policy", function () {
      HC.assert(hasPrivacyPolicy(TID) === false, "no policy should be present initially");
    });
    check("Setting a Privacy Policy URL flips the gate on", function () {
      var r = setPrivacyPolicy(TID, "https://camp.example/privacy");
      HC.assert(r.ok === true, "valid policy should save");
      HC.assert(hasPrivacyPolicy(TID) === true, "gate should now be open");
    });
    check("A blank Privacy Policy URL is rejected", function () {
      clearPrivacyPolicy(TID);
      var r = setPrivacyPolicy(TID, "   ");
      HC.assert(r.ok === false, "blank policy must be rejected");
      HC.assert(hasPrivacyPolicy(TID) === false, "gate must stay closed");
    });

    // --- roster + opt-in classification ---
    check("Following defaults to timetable-only (no marketing)", function () {
      clearFollowers(TID);
      var f = addFollower(TID, { name: "Pat", email: "pat@x.com" });
      HC.assert(f.marketingOptIn === false, "default follow must not opt into marketing");
    });
    check("Stats split marketing opt-ins from timetable-only", function () {
      clearFollowers(TID);
      writeFollowers(TID, seedRoster());
      var s = followerStats(readFollowers(TID));
      HC.assert(s.total === 7, "expected 7 seeded followers, got " + s.total);
      HC.assert(s.marketingOptIns === 4, "expected 4 marketing opt-ins, got " + s.marketingOptIns);
      HC.assert(s.timetableOnly === 3, "expected 3 timetable-only, got " + s.timetableOnly);
      HC.assert(s.contactable === 4, "all 4 opt-ins have real emails, got " + s.contactable);
    });
    check("On-screen roster stars out timetable-only emails", function () {
      var rows = rosterRows(readFollowers(TID));
      var optIn = rows.filter(function (r) { return r.marketingOptIn; })[0];
      var ttOnly = rows.filter(function (r) { return !r.marketingOptIn; })[0];
      HC.assert(optIn.emailDisplay.indexOf("@") !== -1 && optIn.emailDisplay.indexOf("*") === -1,
        "marketing opt-in should show a real email, got " + optIn.emailDisplay);
      HC.assert(ttOnly.emailDisplay.indexOf("*") !== -1 || ttOnly.emailDisplay === "*****",
        "timetable-only email must be starred out, got " + ttOnly.emailDisplay);
    });

    // --- ACCEPTANCE: export GATED on Privacy Policy ---
    check("ACCEPTANCE: with opted-in followers but NO Privacy Policy, export is BLOCKED", function () {
      clearPrivacyPolicy(TID);
      writeFollowers(TID, seedRoster()); // 4 contactable opt-ins present
      HC.assert(followerStats(readFollowers(TID)).contactable === 4, "precondition: contactable opt-ins exist");
      var res = exportFollowers(TID);
      HC.assert(res.ok === false, "export must be blocked without a Privacy Policy");
      HC.assert(res.reason === "no-privacy-policy", "reason should be no-privacy-policy, got " + res.reason);
      HC.assert(res.csv === null && res.count === 0, "no file/rows should be produced when blocked");
    });

    // --- ACCEPTANCE: with policy, export produces a CONTACTABLE list ---
    check("ACCEPTANCE: with a Privacy Policy, export succeeds and produces a contactable list", function () {
      setPrivacyPolicy(TID, "https://camp.example/privacy");
      var res = exportFollowers(TID);
      HC.assert(res.ok === true, "export should succeed once the policy is in place");
      HC.assert(res.count === 4, "exactly the 4 contactable opt-ins should export, got " + res.count);
      // Every exported row carries a real, contactable email.
      HC.assert(res.rows.length === 4, "should produce 4 rows");
      res.rows.forEach(function (row) {
        HC.assert(isContactableEmail(row.email), "every exported row must be contactable, got " + row.email);
      });
    });
    check("ACCEPTANCE: timetable-only followers are EXCLUDED and never leaked", function () {
      var res = exportFollowers(TID);
      var seeded = seedRoster();
      var ttOnlyNames = seeded.filter(function (f) { return !f.marketingOptIn; }).map(function (f) { return f.name; });
      var exportedNames = res.rows.map(function (r) { return r.name; });
      ttOnlyNames.forEach(function (n) {
        HC.assert(exportedNames.indexOf(n) === -1, "timetable-only follower " + n + " must not be exported");
      });
      // And none of the export emails is blank/starred.
      HC.assert(res.csv.indexOf("*") === -1, "no starred address may appear in the export file");
    });

    // --- opt-in WITHOUT a usable email is still not contactable ---
    check("A marketing opt-in with no email does NOT become contactable", function () {
      clearFollowers(TID);
      writeFollowers(TID, [
        { id: "g1", name: "No Email", email: "", area: "Leyton", marketingOptIn: true },
        { id: "g2", name: "Good", email: "good@x.com", area: "Leyton", marketingOptIn: true }
      ]);
      var res = exportFollowers(TID); // policy still set from prior case
      HC.assert(res.ok === true, "export should run with one good contact");
      HC.assert(res.count === 1, "only the opt-in WITH an email should export, got " + res.count);
      HC.assert(res.rows[0].name === "Good", "the emailed opt-in should be the one exported");
    });

    // --- empty contactable set is a clean, non-throwing block ---
    check("With a policy but zero contactable followers, export reports empty (not crash)", function () {
      clearFollowers(TID);
      writeFollowers(TID, [{ id: "h1", name: "TT", email: "", area: "Leyton", marketingOptIn: false }]);
      var res = exportFollowers(TID);
      HC.assert(res.ok === false && res.reason === "no-contactable-followers", "should report empty, got " + res.reason);
      HC.assert(res.csv === null, "no file when there is nothing contactable to export");
    });

    // --- gate honoured end-to-end: remove policy => export re-locks ---
    check("Removing the Privacy Policy re-locks export", function () {
      writeFollowers(TID, seedRoster());
      clearPrivacyPolicy(TID);
      var res = exportFollowers(TID);
      HC.assert(res.ok === false && res.reason === "no-privacy-policy", "export must re-lock when policy removed");
    });

    // --- CSV shape sanity ---
    check("Export CSV has a header row and one line per contactable follower", function () {
      writeFollowers(TID, seedRoster());
      setPrivacyPolicy(TID, "https://camp.example/privacy");
      var res = exportFollowers(TID);
      var lines = res.csv.split("\n");
      HC.assert(lines[0] === "Name,Email,Area", "header row should be present, got " + lines[0]);
      HC.assert(lines.length === res.count + 1, "one data line per contactable follower plus header");
    });

    // --- Live-data sanity: a real provider can run this flow ---
    check("A live provider can collect followers and export once compliant", function () {
      var prov = demoProvider();
      HC.assert(prov && prov.id && prov.name, "should resolve a live provider");
      clearFollowers(prov.id);
      clearPrivacyPolicy(prov.id);
      addFollower(prov.id, { name: "Real Parent", email: "real.parent@gmail.com", area: prov.area, marketingOptIn: true });
      addFollower(prov.id, { name: "Quiet Parent", email: "", area: prov.area, marketingOptIn: false });
      // Blocked until the policy is in place.
      HC.assert(exportFollowers(prov.id).ok === false, "blocked without policy on a live provider");
      setPrivacyPolicy(prov.id, "https://" + prov.id + ".example/privacy");
      var res = exportFollowers(prov.id);
      HC.assert(res.ok === true && res.count === 1, "live provider should export exactly the 1 contactable opt-in");
      // Leave the store as found.
      clearFollowers(prov.id);
      clearPrivacyPolicy(prov.id);
    });

    // Leave the test fixtures clean.
    clearFollowers(TID);
    clearPrivacyPolicy(TID);

    return { pass: pass, fail: fail, log: log };
  }

  /* ============================================================
   * 9. Register (idempotent + defensive via core).
   * ============================================================ */
  HC.registerFeature({
    id: "provider-followers-export",
    title: "Export opted-in followers",
    side: "provider",
    icon: "📥",
    summary: "View your camp's followers and export the ones who opted in to your own newsletter. " +
      "Export is unlocked once you have a Privacy Policy in place, and only ever includes marketing " +
      "opt-ins with a contactable email — timetable-only followers stay starred out.",
    render: render,
    selfTest: selfTest
  });
})();
