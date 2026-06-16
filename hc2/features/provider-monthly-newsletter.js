/* HolidayCamp feature: provider-monthly-newsletter
 * ------------------------------------------------------------------
 * Replicates Happity's PROVIDER PRODUCT/UPDATES newsletter, reframed
 * for SCHOOL-AGE HOLIDAY CAMP operators (not baby classes).
 *
 * Evidence (support corpus):
 *  - Article 6394546 "How do I find out about new features?":
 *      "It is always an exciting time to find out what new features
 *       Happity has in the pipeline, which is why we have our monthly
 *       provider newsletter!"
 *      "Our newsletter is where we keep all our wonderful providers
 *       updated with any new information, updates and new features that
 *       may have been released or are in production!"
 *
 * What this module IS:
 *   The PROVIDER-FACING monthly product newsletter — a *different*
 *   mailing from the parent 'What's On' (which goes to families every
 *   Sunday and is built per-parent from the camp directory). This one:
 *     - goes to PROVIDERS (camp operators), not parents;
 *     - is sent MONTHLY (one edition per calendar month), not weekly;
 *     - announces PRODUCT updates / new features ("released" or "in
 *       production"), not camp listings;
 *     - is OPT-IN: a provider can subscribe / unsubscribe, and only
 *       subscribed providers are on the send list.
 *
 * Acceptance criterion (asserted by selfTest, multiple cases):
 *   PROVIDERS RECEIVE (AND CAN OPT INTO) A MONTHLY PROVIDER-FACING
 *   NEWSLETTER ANNOUNCING PRODUCT UPDATES / NEW FEATURES, DISTINCT FROM
 *   THE PARENT 'WHAT'S ON' NEWSLETTER.
 *   -> audience === "provider" (never "parent") and cadence === "monthly".
 *   -> Only opted-in providers are on the send list; opting out removes
 *      them; opting back in restores them.
 *   -> Each edition is keyed to a unique YYYY-MM month and carries
 *      product items, each tagged "released" or "in-production".
 *   -> The mailing is distinct from the parent What's On (different
 *      audience, different cadence, different content type).
 *
 * Scope: PROVIDER side. No real email is sent and no real backend
 * exists. The opt-in roster + the provider's last-read month persist via
 * HC.store only. Editions are derived from a static product-update log
 * (the "release notes") so selfTest is deterministic. Camp data is read
 * only, never mutated. Fully defensive: nothing throws at registration.
 * ------------------------------------------------------------------ */
(function () {
  "use strict";

  if (typeof window === "undefined" || !window.HC || typeof window.HC.registerFeature !== "function") {
    return; // Core not present — fail silently rather than throwing.
  }
  var HC = window.HC;

  var STORE_OPTIN = "provider_newsletter_optin";   // { providerId: boolean }
  var STORE_READ = "provider_newsletter_lastread";  // { providerId: "YYYY-MM" }

  // This mailing's fixed identity — the qualities that make it DISTINCT
  // from the parent 'What's On' newsletter.
  var AUDIENCE = "provider";   // What's On audience is "parent"
  var CADENCE = "monthly";     // What's On cadence is "weekly"
  var KIND = "product-updates"; // What's On kind is "whats-on-listings"

  /* ============================================================
   * 0. Defensive data access
   * ========================================================== */
  function providers() {
    try {
      var p = HC.data && HC.data.providers;
      return Array.isArray(p) ? p : [];
    } catch (e) { return []; }
  }

  /* ============================================================
   * 1. The product-update log ("release notes").
   *    Each item is a real HolidayCamp feature, tagged by status.
   *    Editions are assembled MONTHLY from this log. All HOLIDAY-CAMP
   *    framed (week/day places, registers, HAF), never baby classes.
   * ========================================================== */
  function updateLog() {
    return [
      { month: "2026-04", status: "released", title: "Smart term tickets for multi-week camps",
        body: "Sell a whole holiday week (or a block of days) as one ticket, with per-day capacity tracked automatically." },
      { month: "2026-04", status: "released", title: "Printable daily registers",
        body: "Download a tidy register per camp day with each child's allergies, emergency contact and pick-up name." },
      { month: "2026-05", status: "released", title: "HAF / free-place eligibility gate",
        body: "Flag free benefit-related places and collect the HAF reference at checkout so funded spots stay funded." },
      { month: "2026-05", status: "in-production", title: "Waiting lists for sold-out weeks",
        body: "When a popular summer week sells out, parents join a waiting list and you fill cancellations in one click." },
      { month: "2026-06", status: "released", title: "Drop-in day labels",
        body: "Mark single-day 'drop-in' places so parents can book just the Tuesday of a week-long camp." },
      { month: "2026-06", status: "in-production", title: "Sibling discount codes",
        body: "Auto-apply a discount when a family books a second child onto the same holiday week." }
    ];
  }

  function knownMonths() {
    var seen = {};
    var months = [];
    updateLog().forEach(function (it) {
      if (it && it.month && !seen[it.month]) { seen[it.month] = true; months.push(it.month); }
    });
    months.sort(); // ascending YYYY-MM
    return months;
  }

  function isValidMonth(m) {
    return typeof m === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(m);
  }

  // Assemble ONE monthly edition: the product items announced that month,
  // released first then in-production. Distinct audience/cadence/kind are
  // baked into every edition so a consumer can always tell it apart from
  // the parent What's On.
  function buildEdition(month) {
    if (!isValidMonth(month)) {
      return { month: month, audience: AUDIENCE, cadence: CADENCE, kind: KIND, items: [], valid: false };
    }
    var items = updateLog().filter(function (it) { return it && it.month === month; });
    items.sort(function (a, b) {
      // released before in-production, then by title
      var rank = function (s) { return s === "released" ? 0 : 1; };
      var d = rank(a.status) - rank(b.status);
      if (d !== 0) return d;
      return String(a.title).localeCompare(String(b.title));
    });
    return {
      month: month,
      audience: AUDIENCE,   // "provider" — NOT "parent"
      cadence: CADENCE,     // "monthly"  — NOT "weekly"
      kind: KIND,           // "product-updates" — NOT camp listings
      subject: "HolidayCamp monthly: what's new for providers (" + month + ")",
      items: items.map(function (it) {
        return { title: it.title, body: it.body, status: it.status, isNew: it.status === "released" };
      }),
      releasedCount: items.filter(function (i) { return i.status === "released"; }).length,
      inProductionCount: items.filter(function (i) { return i.status === "in-production"; }).length,
      valid: true
    };
  }

  function allEditions() {
    return knownMonths().map(buildEdition);
  }
  function latestMonth() {
    var m = knownMonths();
    return m.length ? m[m.length - 1] : null;
  }

  /* ============================================================
   * 2. Opt-in roster (persisted). A provider must opt IN to be on the
   *    monthly send list. Default: opted in (Happity newsletters every
   *    provider unless they unsubscribe), but the operator controls it.
   * ========================================================== */
  function readOptIn() {
    var raw = HC.store ? HC.store.get(STORE_OPTIN, null) : null;
    return (raw && typeof raw === "object") ? raw : {};
  }
  function writeOptIn(map) {
    if (HC.store) HC.store.set(STORE_OPTIN, map || {});
    return map || {};
  }

  // Default opt-in is TRUE: a provider is subscribed unless they've
  // explicitly opted out (an explicit `false` stored for their id).
  function isSubscribed(providerId) {
    if (!providerId) return false;
    var map = readOptIn();
    if (Object.prototype.hasOwnProperty.call(map, providerId)) return map[providerId] !== false;
    return true;
  }
  function setSubscribed(providerId, on) {
    if (!providerId) return false;
    var map = readOptIn();
    map[providerId] = !!on;
    writeOptIn(map);
    return !!on;
  }
  function toggleSubscribed(providerId) {
    return setSubscribed(providerId, !isSubscribed(providerId));
  }

  // The send list for a given month: all SUBSCRIBED providers. (A real
  // edition only goes to opted-in providers.)
  function sendList() {
    return providers().filter(function (p) { return isSubscribed(p.id); });
  }

  // Does a given provider RECEIVE a given edition? Yes iff they're
  // subscribed and the edition is a real, valid monthly edition.
  function receives(providerId, edition) {
    return isSubscribed(providerId) && !!(edition && edition.valid);
  }

  /* ============================================================
   * 3. Per-provider "unread" tracking — so a provider knows when a new
   *    monthly edition has landed (the "find out about new features"
   *    job). Persisted last-read month per provider.
   * ========================================================== */
  function readLastReadMap() {
    var raw = HC.store ? HC.store.get(STORE_READ, null) : null;
    return (raw && typeof raw === "object") ? raw : {};
  }
  function getLastRead(providerId) {
    var m = readLastReadMap();
    return (providerId && m[providerId]) || null;
  }
  function markRead(providerId, month) {
    if (!providerId || !isValidMonth(month)) return null;
    var m = readLastReadMap();
    m[providerId] = month;
    if (HC.store) HC.store.set(STORE_READ, m);
    return month;
  }
  // True if there is a later edition than the provider has read.
  function hasUnread(providerId) {
    if (!isSubscribed(providerId)) return false;
    var latest = latestMonth();
    if (!latest) return false;
    var read = getLastRead(providerId);
    return read == null || read < latest; // string compare works for YYYY-MM
  }

  /* ============================================================
   * 4. Distinctness from the parent What's On newsletter.
   *    A small descriptor a consumer (or a test) can use to assert the
   *    two mailings are genuinely different products.
   * ========================================================== */
  function whatsOnDescriptor() {
    // The parent mailing's identity, for contrast (see
    // platform-whats-on-newsletter.js / parent-whats-on-newsletter.js).
    return { audience: "parent", cadence: "weekly", kind: "whats-on-listings" };
  }
  function descriptor() {
    return { audience: AUDIENCE, cadence: CADENCE, kind: KIND };
  }
  function isDistinctFromWhatsOn() {
    var a = descriptor(), b = whatsOnDescriptor();
    return a.audience !== b.audience && a.cadence !== b.cadence && a.kind !== b.kind;
  }

  /* ============================================================
   * 5. UI — render(mountEl): a provider's view of the monthly newsletter.
   * ========================================================== */
  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  // Pick a representative provider to "be" in the preview.
  function previewProviderId() {
    var p = providers();
    return p.length ? p[0].id : "demo-provider";
  }

  function statusBadge(status) {
    if (status === "released") {
      return '<span style="font-size:10.5px;font-weight:700;background:#E1F0E4;color:#2f7d4f;padding:2px 9px;border-radius:999px;text-transform:uppercase;letter-spacing:.3px">New feature</span>';
    }
    return '<span style="font-size:10.5px;font-weight:700;background:var(--purple-tint,#F0E8F4);color:var(--purple,#603488);padding:2px 9px;border-radius:999px;text-transform:uppercase;letter-spacing:.3px">In production</span>';
  }

  function renderEditionHtml(edition) {
    if (!edition || !edition.valid || !edition.items.length) {
      return '<p style="font-size:13px;color:var(--muted,#808080);font-style:italic">No edition for this month.</p>';
    }
    var out = '<ul style="list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:12px">';
    for (var i = 0; i < edition.items.length; i++) {
      var it = edition.items[i];
      out +=
        '<li style="border:1.5px solid var(--line,#E6E6E6);border-radius:14px;padding:12px 14px">' +
          '<div style="display:flex;align-items:center;gap:8px;margin:0 0 4px">' +
            statusBadge(it.status) +
            '<span style="font-family:Quicksand,system-ui,sans-serif;font-weight:700;color:var(--purple,#603488);font-size:15px">' +
              esc(it.title) + "</span>" +
          "</div>" +
          '<div style="font-size:13.5px;color:var(--text,#383838);line-height:1.55">' + esc(it.body) + "</div>" +
        "</li>";
    }
    out += "</ul>";
    return out;
  }

  function render(mountEl) {
    if (!mountEl) return;
    try {
      var pid = previewProviderId();
      var months = knownMonths();
      var current = latestMonth();

      var wrap = HC.util.el("div", { class: "hc-prov-newsletter" });

      var intro =
        '<p style="font-size:14px;color:var(--text,#383838);line-height:1.6;margin:0 0 14px">' +
        "The <strong>monthly provider newsletter</strong> is how camp operators find out about " +
        "<strong>new features and product updates</strong> — released or in production. " +
        "It goes to <strong>providers</strong> once a <strong>month</strong>, and is a different mailing " +
        "from the parent <em>What's On</em> (which goes to families every week)." +
        "</p>";

      // Opt-in control + distinctness chips.
      var subscribed = isSubscribed(pid);
      var controls =
        '<div style="background:var(--purple-tint,#F0E8F4);border-radius:14px;padding:12px 14px;margin:0 0 16px;' +
          'display:flex;align-items:center;gap:14px;flex-wrap:wrap;font-size:13px">' +
          '<label style="display:inline-flex;align-items:center;gap:8px;cursor:pointer;font-weight:700">' +
            '<input type="checkbox" data-prov-optin ' + (subscribed ? "checked" : "") + '> ' +
            "Email me the monthly provider newsletter" +
          "</label>" +
          '<span data-prov-status style="font-size:12px;color:var(--muted,#808080)">' +
            (subscribed ? "You're subscribed — you'll get each month's update."
                        : "Unsubscribed — you won't be on the send list.") +
          "</span>" +
        "</div>";

      var chips =
        '<div style="display:flex;gap:8px;flex-wrap:wrap;margin:0 0 16px">' +
          chip("Audience: providers") +
          chip("Cadence: monthly") +
          chip("Content: product updates") +
          chip("Distinct from parent What's On", true) +
        "</div>";

      // Month selector.
      var selector = '<div style="margin:0 0 12px;font-size:13px">' +
        '<label style="font-weight:700;color:var(--purple,#603488)">Edition: </label>' +
        '<select data-prov-month style="padding:5px 8px;border:1px solid var(--line,#E6E6E6);border-radius:8px;font-size:13px">';
      for (var i = months.length - 1; i >= 0; i--) {
        selector += '<option value="' + esc(months[i]) + '"' + (months[i] === current ? " selected" : "") + ">" +
          esc(months[i]) + (months[i] === current ? "  (latest)" : "") + "</option>";
      }
      selector += "</select></div>";

      wrap.innerHTML = intro + controls + chips + selector;

      var sub = HC.util.el("div", {
        "data-prov-subject": "1",
        style: "font-family:Quicksand,system-ui,sans-serif;font-weight:700;color:var(--magenta,#F82488);font-size:13px;margin:0 0 10px;text-transform:uppercase;letter-spacing:.4px"
      });
      var body = HC.util.el("div", { "data-prov-edition": "1" });

      function paint(month) {
        var ed = buildEdition(month);
        sub.textContent = "✉ " + (ed.subject || "");
        body.innerHTML = renderEditionHtml(ed);
        markRead(pid, month); // viewing an edition marks it read
      }
      wrap.appendChild(sub);
      wrap.appendChild(body);

      mountEl.innerHTML = "";
      mountEl.appendChild(wrap);

      paint(current);

      var optin = wrap.querySelector("[data-prov-optin]");
      var statusEl = wrap.querySelector("[data-prov-status]");
      if (optin) {
        optin.addEventListener("change", function () {
          var on = setSubscribed(pid, !!optin.checked);
          if (statusEl) {
            statusEl.textContent = on
              ? "You're subscribed — you'll get each month's update."
              : "Unsubscribed — you won't be on the send list.";
          }
          if (HC.util.toast) HC.util.toast(on ? "Subscribed to the monthly provider newsletter" : "Unsubscribed");
        });
      }
      var monthSel = wrap.querySelector("[data-prov-month]");
      if (monthSel) {
        monthSel.addEventListener("change", function () { paint(monthSel.value); });
      }
    } catch (e) {
      mountEl.innerHTML = '<p style="color:#9a1f5e">Monthly provider newsletter failed to render: ' +
        esc(e && e.message ? e.message : String(e)) + "</p>";
    }
  }

  function chip(label, hot) {
    return '<span style="font-family:Quicksand,system-ui,sans-serif;font-weight:700;font-size:12px;' +
      "padding:6px 12px;border-radius:999px;background:" +
      (hot ? "#FCD400;color:#1A1A1A" : "var(--purple-tint,#F0E8F4);color:var(--purple,#603488)") + '">' +
      esc(label) + "</span>";
  }

  /* ============================================================
   * 6. selfTest — exercises the LOGIC and asserts the acceptance
   *    criterion across multiple cases.
   * ========================================================== */
  function selfTest() {
    var pass = 0, fail = 0, log = [];
    function check(label, fn) {
      try { fn(); pass += 1; log.push("✓ " + label); }
      catch (e) { fail += 1; log.push("✗ " + label + " — " + (e && e.message ? e.message : String(e))); }
    }

    // Snapshot + restore store state so the test is side-effect free.
    var savedOptIn = HC.store ? HC.store.get(STORE_OPTIN, null) : null;
    var savedRead = HC.store ? HC.store.get(STORE_READ, null) : null;
    function restore() {
      if (!HC.store) return;
      if (savedOptIn === null) { if (HC.store.remove) HC.store.remove(STORE_OPTIN); } else HC.store.set(STORE_OPTIN, savedOptIn);
      if (savedRead === null) { if (HC.store.remove) HC.store.remove(STORE_READ); } else HC.store.set(STORE_READ, savedRead);
    }

    try {
      var pr = providers();
      var months = knownMonths();
      var latest = latestMonth();

      // --- Edition assembly ---
      check("There is at least one monthly edition, keyed by unique YYYY-MM", function () {
        HC.assert(months.length > 0, "expected at least one edition month");
        var seen = {};
        months.forEach(function (m) {
          HC.assert(isValidMonth(m), "month '" + m + "' is not a valid YYYY-MM");
          HC.assert(!seen[m], "duplicate edition month " + m);
          seen[m] = true;
        });
      });

      check("Each edition carries product items tagged released | in-production", function () {
        var eds = allEditions();
        HC.assert(eds.length === months.length, "one edition per month");
        var totalItems = 0;
        eds.forEach(function (ed) {
          HC.assert(ed.valid, ed.month + " edition should be valid");
          HC.assert(ed.items.length > 0, ed.month + " edition has no items");
          ed.items.forEach(function (it) {
            HC.assert(it.status === "released" || it.status === "in-production",
              ed.month + " item '" + it.title + "' has bad status " + it.status);
          });
          totalItems += ed.items.length;
        });
        HC.assert(totalItems >= months.length, "expected product items across editions");
      });

      check("At least one edition announces a NEW (released) feature", function () {
        var released = allEditions().reduce(function (n, ed) { return n + ed.releasedCount; }, 0);
        HC.assert(released > 0, "no released features announced anywhere — newsletter has nothing 'new'");
      });

      check("Released items rank before in-production within an edition", function () {
        allEditions().forEach(function (ed) {
          var seenInProd = false;
          ed.items.forEach(function (it) {
            if (it.status === "in-production") seenInProd = true;
            else HC.assert(!seenInProd, ed.month + ": released item ranked below in-production");
          });
        });
      });

      check("Invalid month yields an empty, invalid edition (defensive)", function () {
        var bad = buildEdition("not-a-month");
        HC.assert(bad.valid === false, "garbage month should be invalid");
        HC.assert(bad.items.length === 0, "garbage month should have no items");
      });

      // --- ACCEPTANCE: audience + cadence (provider-facing, monthly) ---
      check("ACCEPTANCE: mailing is PROVIDER-facing and MONTHLY", function () {
        var d = descriptor();
        HC.assert(d.audience === "provider", "audience must be 'provider', got " + d.audience);
        HC.assert(d.cadence === "monthly", "cadence must be 'monthly', got " + d.cadence);
        allEditions().forEach(function (ed) {
          HC.assert(ed.audience === "provider", ed.month + ": edition audience must be provider");
          HC.assert(ed.cadence === "monthly", ed.month + ": edition cadence must be monthly");
          HC.assert(ed.kind === "product-updates", ed.month + ": edition kind must be product-updates");
        });
      });

      // --- ACCEPTANCE: distinct from the parent What's On ---
      check("ACCEPTANCE: distinct from the parent What's On newsletter", function () {
        HC.assert(isDistinctFromWhatsOn(), "monthly provider newsletter is not distinct from What's On");
        var d = descriptor(), w = whatsOnDescriptor();
        HC.assert(d.audience !== w.audience, "audience must differ from What's On (parent vs provider)");
        HC.assert(d.cadence !== w.cadence, "cadence must differ from What's On (weekly vs monthly)");
        HC.assert(d.kind !== w.kind, "content type must differ from What's On (listings vs product updates)");
      });

      // --- ACCEPTANCE: opt-in — providers can opt into the mailing ---
      check("ACCEPTANCE: providers default to subscribed and are on the send list", function () {
        restore(); // clean slate
        HC.assert(pr.length > 0, "directory should have providers to mail");
        var p0 = pr[0];
        HC.assert(isSubscribed(p0.id), "a provider should be subscribed by default");
        var list = sendList();
        HC.assert(list.length === pr.length, "with no opt-outs, every provider is on the send list");
        var onList = list.some(function (p) { return p.id === p0.id; });
        HC.assert(onList, "subscribed provider should be on the send list");
      });

      check("ACCEPTANCE: opting OUT removes a provider; opting back IN restores them", function () {
        restore();
        var p0 = pr[0];
        // Opt out
        setSubscribed(p0.id, false);
        HC.assert(!isSubscribed(p0.id), "opt-out should unsubscribe the provider");
        var listOut = sendList();
        HC.assert(!listOut.some(function (p) { return p.id === p0.id; }),
          "unsubscribed provider must NOT be on the send list");
        HC.assert(listOut.length === pr.length - 1, "send list should shrink by exactly one");
        // The edition is real, but they don't receive it.
        var ed = buildEdition(latest);
        HC.assert(!receives(p0.id, ed), "unsubscribed provider must not receive the edition");
        // Opt back in
        setSubscribed(p0.id, true);
        HC.assert(isSubscribed(p0.id), "opt-in should re-subscribe the provider");
        HC.assert(receives(p0.id, ed), "re-subscribed provider should receive the edition again");
        HC.assert(sendList().length === pr.length, "send list should restore to full size");
      });

      check("Opt-in roster persists through HC.store (round-trips)", function () {
        restore();
        var p0 = pr[0];
        setSubscribed(p0.id, false);
        var raw = HC.store.get(STORE_OPTIN, null);
        HC.assert(raw && raw[p0.id] === false, "opt-out should be persisted in HC.store");
        // A fresh read via the public API reflects the persisted value.
        HC.assert(!isSubscribed(p0.id), "persisted opt-out should be read back as unsubscribed");
      });

      // --- "Find out about new features": unread tracking ---
      check("A subscribed provider sees the latest edition as UNREAD until they read it", function () {
        restore();
        var p0 = pr[0];
        HC.assert(isSubscribed(p0.id), "precondition: subscribed");
        HC.assert(hasUnread(p0.id), "a never-read subscriber should have the latest edition unread");
        markRead(p0.id, latest);
        HC.assert(!hasUnread(p0.id), "after reading the latest, nothing should be unread");
        HC.assert(getLastRead(p0.id) === latest, "last-read month should persist");
      });

      check("An unsubscribed provider has no unread editions (they're off the list)", function () {
        restore();
        var p0 = pr[0];
        setSubscribed(p0.id, false);
        HC.assert(!hasUnread(p0.id), "unsubscribed provider should report no unread editions");
      });

      check("Two providers track read-state independently", function () {
        restore();
        if (pr.length < 2) { return; } // need two providers; skip cleanly if not
        var a = pr[0].id, b = pr[1].id;
        markRead(a, latest);
        HC.assert(!hasUnread(a), a + " read the latest, should be caught up");
        HC.assert(hasUnread(b), b + " hasn't read, should still be unread");
      });

    } finally {
      restore();
    }

    return { pass: pass, fail: fail, log: log };
  }

  /* ============================================================
   * 7. Register
   * ========================================================== */
  HC.registerFeature({
    id: "provider-monthly-newsletter",
    title: "Monthly provider newsletter (new features)",
    side: "provider",
    icon: "📰",
    summary: "An opt-in monthly newsletter that tells camp operators about new features and product updates (released or in production) — distinct from the parent weekly What's On.",
    render: render,
    selfTest: selfTest
  });
})();
