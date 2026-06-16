/* HolidayCamp feature — provider-preview-public-page
 *
 * 'View on Happity' — preview your public page as a customer  (provider side)
 *
 * Replicates Happity's "View on Happity" button, documented in two support
 * articles:
 *
 *   Article 5972946 ("Have I set things up correctly"):
 *     "Once all of the above has been checked, you can use your 'View on
 *      Happity' button to view this from the customer facing site."
 *      -> the button lets a provider SEE their own listing exactly as a
 *         customer would, on the public/customer-facing site.
 *
 *   Article 3807913 ("How to get started and set up bookings…"):
 *     "Now that you're all set, you can find the booking link for your class
 *      by clicking 'View on Happity'."
 *      -> the same button is also how a provider FETCHES the live public
 *         booking link / URL for a class to advertise it everywhere.
 *
 * ACCEPTANCE CRITERION (asserted in selfTest):
 *   The provider dashboard exposes a 'View on Happity' control that opens the
 *   live customer-facing listing/page for the selected activity or profile.
 *   We verify, for both targets (a single ACTIVITY/camp and the whole
 *   PROFILE), that the control resolves an absolute live customer-facing URL,
 *   that "opening" it returns that exact URL (and routes to the public site,
 *   not the dashboard), and that a DRAFT/unpublished listing has no live page
 *   to view (so the control is correctly disabled with a helpful reason).
 *
 * Framed for SCHOOL-AGE HOLIDAY CAMPS (summer holiday camps), not baby
 * classes. Self-contained, defensive, no imports/exports. Persistence is via
 * HC.store only. Calls HC.registerFeature at top level and never throws at
 * registration time.
 */
(function () {
  "use strict";

  // Defensive: never throw at module load if HC core isn't present.
  if (typeof window === "undefined" || !window.HC || typeof window.HC.registerFeature !== "function") {
    if (typeof console !== "undefined" && console.warn) {
      console.warn("[HC] provider-preview-public-page: HC core not found; skipping registration.");
    }
    return;
  }

  var HC = window.HC;

  var STORE_KEY = "provider_public_status"; // { [providerId]: { published, activities:{[campId]:bool} } }

  // The public, customer-facing site origin. In a real deployment this is the
  // live consumer site (Happity's equivalent); here it is a fixed,
  // deterministic value so the resolved URL is testable. Crucially it is a
  // DIFFERENT origin from the provider dashboard, so we can assert that
  // "View on Happity" routes to the customer-facing site, not the dashboard.
  var PUBLIC_BASE = "https://holidaycamp.app";
  var DASHBOARD_BASE = "https://dashboard.holidaycamp.app";

  /* ===================================================================
     PURE LOGIC (DOM-free, testable)
     =================================================================== */

  function asText(v) {
    return typeof v === "string" ? v : (v == null ? "" : String(v));
  }

  // Make a URL-safe slug from an id or name. Deterministic.
  function slugify(s) {
    return asText(s)
      .toLowerCase()
      .replace(/['’]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80);
  }

  // The customer-facing URL for a provider's WHOLE profile (their public page
  // on the consumer site). Article 5972946: "view this from the customer
  // facing site". Returns "" for an invalid provider.
  function profileUrl(providerId) {
    var slug = slugify(providerId);
    if (!slug) return "";
    return PUBLIC_BASE + "/provider/" + slug;
  }

  // The customer-facing URL for a single ACTIVITY (one holiday-camp listing /
  // class) belonging to a provider. Article 3807913: "find the booking link
  // for your class by clicking 'View on Happity'". Returns "" if either part
  // is missing.
  function activityUrl(providerId, activityId) {
    var pSlug = slugify(providerId);
    var aSlug = slugify(activityId);
    if (!pSlug || !aSlug) return "";
    return PUBLIC_BASE + "/provider/" + pSlug + "/camp/" + aSlug;
  }

  // Is a given target live (published) on the customer-facing site? A draft /
  // unpublished listing has no live public page to "View on Happity" yet.
  //   target = { kind:'profile'|'activity', providerId, activityId? }
  // status comes from HC.store via getStatus(); pass it in so the resolver is
  // pure and testable.
  function isLive(target, status) {
    if (!target) return false;
    status = status || {};
    if (target.kind === "profile") {
      return status.published === true;
    }
    if (target.kind === "activity") {
      // An activity is only viewable on the customer site if BOTH the profile
      // is published AND that specific activity is published.
      if (status.published !== true) return false;
      var acts = (status.activities && typeof status.activities === "object") ? status.activities : {};
      // Default: an activity is considered published unless explicitly set false.
      var v = acts[target.activityId];
      return v !== false;
    }
    return false;
  }

  // Resolve the live customer-facing URL for a target, or "" if not live.
  function liveUrlFor(target, status) {
    if (!target) return "";
    if (!isLive(target, status)) return "";
    if (target.kind === "profile") return profileUrl(target.providerId);
    if (target.kind === "activity") return activityUrl(target.providerId, target.activityId);
    return "";
  }

  // THE 'View on Happity' ACTION. Given a target + its publish status, this is
  // what the button does: it resolves the live customer-facing URL and
  // "opens" it. Returns a structured result so the behaviour is fully testable
  // without a real browser window.
  //   { ok, url, opened, target, site, reason }
  // - ok/opened false (with a reason) when there is no live page to view.
  // - site is always the customer-facing public site when ok, NEVER the
  //   dashboard — that is the whole point of the control.
  function viewOnHappity(target, status, opener) {
    var result = {
      ok: false,
      url: "",
      opened: false,
      target: target || null,
      site: "",
      reason: ""
    };
    try {
      if (!target || (target.kind !== "profile" && target.kind !== "activity")) {
        result.reason = "no-target";
        return result;
      }
      if (target.kind === "activity" && !asText(target.activityId)) {
        result.reason = "no-activity-selected";
        return result;
      }
      if (!asText(target.providerId)) {
        result.reason = "no-provider";
        return result;
      }
      if (!isLive(target, status)) {
        // Draft / unpublished: there is no live customer-facing page yet.
        result.reason = "not-published";
        return result;
      }
      var url = liveUrlFor(target, status);
      if (!url) {
        result.reason = "no-url";
        return result;
      }
      result.ok = true;
      result.url = url;
      result.site = "customer-facing";
      // Sanity: must be the public site, not the dashboard.
      if (url.indexOf(DASHBOARD_BASE) === 0) {
        result.ok = false;
        result.site = "";
        result.reason = "wrong-site";
        return result;
      }
      // "Open" the live page. In a browser this is a new tab; in a test the
      // opener is a stub. Either way we report the exact URL that was opened.
      var openFn = typeof opener === "function" ? opener : defaultOpener;
      var didOpen = false;
      try { didOpen = openFn(url) !== false; } catch (e) { didOpen = false; }
      result.opened = didOpen === true;
      result.reason = "opened";
      return result;
    } catch (e) {
      result.reason = "error:" + (e && e.message ? e.message : String(e));
      return result;
    }
  }

  // Default browser opener — a new tab to the public site. Defensive: never
  // throws, returns true/false for "did we open it".
  function defaultOpener(url) {
    try {
      if (typeof window !== "undefined" && typeof window.open === "function") {
        var w = window.open(url, "_blank", "noopener");
        return !!w || true; // popup blockers return null; treat the attempt as made
      }
    } catch (e) {}
    return false;
  }

  /* ===================================================================
     CLIPBOARD — article 3807913 also uses this button to FETCH the booking
     link. Copying the live URL returns the exact string put on the clipboard
     so the behaviour is testable without a real clipboard.
     =================================================================== */

  function copyToClipboard(text) {
    var value = asText(text);
    var copied = false;
    try {
      if (typeof navigator !== "undefined" && navigator.clipboard &&
          typeof navigator.clipboard.writeText === "function") {
        navigator.clipboard.writeText(value);
        copied = true;
      }
    } catch (e) { /* fall through */ }
    if (!copied) {
      try {
        if (typeof document !== "undefined" && document.body) {
          var ta = document.createElement("textarea");
          ta.value = value;
          ta.setAttribute("readonly", "");
          ta.style.position = "absolute";
          ta.style.left = "-9999px";
          document.body.appendChild(ta);
          ta.select();
          if (typeof document.execCommand === "function") {
            copied = document.execCommand("copy");
          }
          document.body.removeChild(ta);
        }
      } catch (e2) { /* never throw from a copy */ }
    }
    return { copied: copied, text: value };
  }

  /* ===================================================================
     PERSISTENCE (HC.store only) — per-provider publish status.
     =================================================================== */

  function allStatus() {
    var raw = null;
    try { raw = HC.store.get(STORE_KEY, {}); } catch (e) { raw = {}; }
    return (raw && typeof raw === "object") ? raw : {};
  }

  // Default status: a provider's profile is published, and activities are
  // published unless explicitly turned off. This matches a live directory
  // where most real camps are visible.
  function getStatus(providerId) {
    var map = allStatus();
    var s = map[providerId];
    if (!s || typeof s !== "object") {
      return { published: true, activities: {} };
    }
    return {
      published: s.published !== false,
      activities: (s.activities && typeof s.activities === "object") ? s.activities : {}
    };
  }

  function saveStatus(providerId, status) {
    var map = allStatus();
    map[providerId] = {
      published: status.published !== false,
      activities: (status.activities && typeof status.activities === "object") ? status.activities : {}
    };
    try { HC.store.set(STORE_KEY, map); return true; } catch (e) { return false; }
  }

  function setProfilePublished(providerId, published) {
    var s = getStatus(providerId);
    s.published = published === true;
    return saveStatus(providerId, s);
  }

  function setActivityPublished(providerId, activityId, published) {
    var s = getStatus(providerId);
    s.activities[activityId] = published === true;
    return saveStatus(providerId, s);
  }

  /* ===================================================================
     LIVE DATA — real school-age camps, so the preview & URLs use genuine
     holiday-camp names/ids.
     =================================================================== */

  function firstProvider() {
    try {
      var providers = HC.data.providers || [];
      for (var i = 0; i < providers.length; i++) {
        var p = providers[i];
        if (p && p.id && p.id !== "waltham-forest-haf") return p;
      }
      if (providers.length) return providers[0];
    } catch (e) {}
    return { id: "demo-provider", name: "your holiday camp" };
  }

  // A provider's bookable activities. The live camp objects don't carry a
  // separate "activities" list, so we model each provider as offering the
  // school holiday weeks from the planner as their dated holiday-camp
  // sessions. Falls back to a single "summer-holiday-camp" activity.
  function activitiesFor(provider) {
    var out = [];
    try {
      var weeks = (HC.data.planner && HC.data.planner.weeks) || [];
      for (var i = 0; i < weeks.length && i < 6; i++) {
        var w = weeks[i];
        if (!w) continue;
        out.push({
          id: (provider.id || "camp") + "-week-" + (w.id != null ? w.id : (i + 1)),
          name: (w.label || ("Week " + (i + 1))) + (w.dates ? " · " + w.dates : "")
        });
      }
    } catch (e) {}
    if (!out.length) {
      out.push({ id: (provider.id || "camp") + "-summer-holiday-camp", name: "Summer Holiday Camp" });
    }
    return out;
  }

  /* ===================================================================
     UI — a provider "View on Happity" panel. Pick a target (whole profile, or
     one activity), see the resolved live customer-facing URL, and click
     'View on Happity' to open it. A draft toggle proves the control is
     correctly disabled when there is no live page.
     =================================================================== */

  function esc(s) {
    return asText(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
  function escAttr(s) { return esc(s).replace(/"/g, "&quot;"); }

  function render(mountEl) {
    try {
      var provider = firstProvider();
      var providerId = provider.id;
      var providerName = provider.name || "your holiday camp";
      var activities = activitiesFor(provider);

      mountEl.innerHTML =
        '<div style="font-family:\'Nunito Sans\',system-ui,sans-serif;color:var(--text,#383838)">' +
          '<p style="font-size:14px;margin:0 0 14px">Provider dashboard → <strong>My Classes</strong>. ' +
          'Once your setup checks out, use the <strong>View on Happity</strong> button to see ' +
          '<strong>' + esc(providerName) + '</strong> exactly as a customer would on the public site — ' +
          'and to grab the live booking link to advertise everywhere.</p>' +

          // --- Target picker ---
          '<div style="border:1.5px solid var(--line,#E6E6E6);border-radius:14px;padding:14px 16px;margin-bottom:16px">' +
            '<div style="font-family:\'Quicksand\',system-ui,sans-serif;font-weight:700;color:var(--purple,#603488);font-size:15px;margin-bottom:10px">What do you want to view?</div>' +

            '<label style="display:block;font-weight:700;font-size:12.5px;margin-bottom:3px">Page</label>' +
            '<select id="vpTarget" style="width:100%;padding:9px;border:1.5px solid var(--line,#E6E6E6);border-radius:12px;font-size:14px;margin-bottom:12px">' +
              '<option value="profile">Whole profile — ' + esc(providerName) + '</option>' +
              activities.map(function (a) {
                return '<option value="activity:' + escAttr(a.id) + '">Activity — ' + esc(a.name) + '</option>';
              }).join("") +
            '</select>' +

            '<label style="display:flex;align-items:center;gap:8px;font-size:13.5px;margin-bottom:4px;cursor:pointer">' +
              '<input id="vpPublished" type="checkbox" checked style="width:16px;height:16px">' +
              '<span><strong>Published</strong> — live on the customer-facing site. Untick to see a <em>draft</em> (no public page to view yet).</span>' +
            '</label>' +
          '</div>' +

          // --- Result panel ---
          '<div id="vpResult"></div>' +
        '</div>';

      var $ = function (id) { return mountEl.querySelector("#" + id); };

      function currentTarget() {
        var raw = $("vpTarget").value;
        if (raw === "profile") {
          return { kind: "profile", providerId: providerId };
        }
        var actId = raw.indexOf("activity:") === 0 ? raw.slice("activity:".length) : "";
        return { kind: "activity", providerId: providerId, activityId: actId };
      }

      function currentStatus() {
        var published = $("vpPublished").checked;
        // Build a status object reflecting the toggle for the chosen target.
        var target = currentTarget();
        var status = { published: true, activities: {} };
        if (target.kind === "profile") {
          status.published = published;
        } else {
          status.published = true; // profile live; the toggle controls the activity
          status.activities[target.activityId] = published;
        }
        return status;
      }

      function renderResult() {
        var host = $("vpResult");
        if (!host) return;
        var target = currentTarget();
        var status = currentStatus();
        var live = isLive(target, status);
        var url = liveUrlFor(target, status);

        if (!live) {
          host.innerHTML =
            '<div style="border:1.5px solid var(--line,#E6E6E6);border-radius:12px;padding:14px;background:#FCE8F0">' +
              '<div style="font-family:\'Quicksand\',system-ui,sans-serif;font-weight:700;color:#9a1f5e;font-size:14px;margin-bottom:4px">Not published yet</div>' +
              '<p style="font-size:13px;color:var(--text,#383838);margin:0 0 10px">There is no live customer-facing page to view while this is a draft. ' +
              'Publish it first, then <strong>View on Happity</strong> will open your public page.</p>' +
              '<button type="button" class="hc-btn" disabled style="opacity:.5;cursor:not-allowed">View on Happity</button>' +
            '</div>';
          return;
        }

        host.innerHTML =
          '<div style="font-family:\'Quicksand\',system-ui,sans-serif;font-weight:700;color:var(--purple,#603488);font-size:15px;margin:0 0 8px">Your live customer-facing page</div>' +
          '<div style="border:1.5px solid var(--line,#E6E6E6);border-radius:12px;padding:12px 14px">' +
            '<div style="font-size:12px;color:#2f7d4f;margin-bottom:6px">● Published — customers can see and book this</div>' +
            '<input id="vpUrl" type="text" readonly value="' + escAttr(url) + '" ' +
              'style="width:100%;padding:9px;border:1.5px solid var(--line,#E6E6E6);border-radius:12px;font-size:13px;background:#FAFAFA;margin-bottom:10px" ' +
              'onclick="this.select()">' +
            '<div style="display:flex;gap:8px;flex-wrap:wrap">' +
              '<button id="vpView" type="button" class="hc-btn">👀 View on Happity</button>' +
              '<button id="vpCopy" type="button" class="hc-btn hc-btn-ghost">📋 Copy booking link</button>' +
            '</div>' +
            '<p style="font-size:12px;color:var(--muted,#808080);margin:10px 0 0">' +
              'This is exactly what a customer sees. Advertise this link everywhere to tell parents you are taking bookings.</p>' +
          '</div>';

        var viewBtn = $("vpView");
        if (viewBtn) viewBtn.addEventListener("click", function () {
          var res = viewOnHappity(currentTarget(), currentStatus());
          if (res.ok) {
            try { HC.util.toast(res.opened ? "Opening your public page on Happity…" : "Live page ready: " + res.url); } catch (e) {}
          } else {
            try { HC.util.toast("Can't view: " + res.reason); } catch (e) {}
          }
        });

        var copyBtn = $("vpCopy");
        if (copyBtn) copyBtn.addEventListener("click", function () {
          var res = copyToClipboard(url);
          try { HC.util.toast(res.copied ? "Booking link copied to clipboard" : "Select the link and copy it"); } catch (e) {}
          var input = $("vpUrl");
          if (input) { try { input.focus(); input.select(); } catch (e) {} }
        });
      }

      $("vpTarget").addEventListener("change", renderResult);
      $("vpPublished").addEventListener("change", renderResult);
      renderResult();
    } catch (e) {
      mountEl.innerHTML = '<p style="color:#9a1f5e">View on Happity panel failed to load: ' +
        esc(e && e.message ? e.message : String(e)) + "</p>";
    }
  }

  /* ===================================================================
     SELF-TEST — exercises the LOGIC and asserts the acceptance criterion.
     Uses isolated in-memory provider ids so it never disturbs real data.
     =================================================================== */

  function selfTest() {
    var pass = 0, fail = 0, log = [];
    function check(label, fn) {
      try { fn(); pass += 1; log.push("✓ " + label); }
      catch (e) { fail += 1; log.push("✗ " + label + " — " + (e && e.message ? e.message : String(e))); }
    }

    // --- ACCEPTANCE: 'View on Happity' opens the live customer-facing page
    //     for the selected ACTIVITY. ---
    check("View on Happity opens the live customer page for a published ACTIVITY", function () {
      var target = { kind: "activity", providerId: "ymca-y-kidz", activityId: "ymca-y-kidz-week-1" };
      var status = { published: true, activities: { "ymca-y-kidz-week-1": true } };
      var opened = "";
      var res = viewOnHappity(target, status, function (u) { opened = u; return true; });
      HC.assert(res.ok === true, "control should succeed for a published activity; reason: " + res.reason);
      HC.assert(res.opened === true, "the activity's public page should be opened");
      HC.assert(res.reason === "opened", "reason should be 'opened', got " + res.reason);
      HC.assert(typeof res.url === "string" && /^https:\/\//.test(res.url), "should resolve an absolute https URL, got " + res.url);
      HC.assert(res.url.indexOf("ymca-y-kidz") !== -1, "URL should target the real provider");
      HC.assert(res.url.indexOf("/camp/") !== -1, "an activity URL should be a per-camp page");
      HC.assert(opened === res.url, "the opener must receive the exact resolved URL");
    });

    // --- ACCEPTANCE: 'View on Happity' opens the live customer-facing page
    //     for the whole PROFILE. ---
    check("View on Happity opens the live customer page for a published PROFILE", function () {
      var target = { kind: "profile", providerId: "lloyd-park-childrens-charity" };
      var status = { published: true, activities: {} };
      var opened = "";
      var res = viewOnHappity(target, status, function (u) { opened = u; return true; });
      HC.assert(res.ok === true, "control should succeed for a published profile; reason: " + res.reason);
      HC.assert(res.opened === true, "the profile public page should be opened");
      HC.assert(/^https:\/\//.test(res.url), "profile URL must be absolute https, got " + res.url);
      HC.assert(res.url.indexOf("/provider/") !== -1, "profile URL should be a /provider/ page");
      HC.assert(res.url.indexOf("/camp/") === -1, "a profile URL is not a per-camp page");
      HC.assert(opened === res.url, "opener must receive the exact profile URL");
    });

    // --- ACCEPTANCE: it routes to the CUSTOMER-FACING site, not the dashboard. ---
    check("View on Happity routes to the customer-facing site, never the dashboard", function () {
      var res = viewOnHappity(
        { kind: "profile", providerId: "active-london" },
        { published: true, activities: {} }
      );
      HC.assert(res.ok === true, "should resolve");
      HC.assert(res.site === "customer-facing", "site should be the customer-facing public site, got " + res.site);
      HC.assert(res.url.indexOf(PUBLIC_BASE) === 0, "URL should be on the public base " + PUBLIC_BASE + ", got " + res.url);
      HC.assert(res.url.indexOf(DASHBOARD_BASE) !== 0, "URL must NOT be on the dashboard origin");
    });

    // --- A DRAFT/unpublished target has no live page to view. ---
    check("A draft PROFILE has no live page — control is disabled with a reason", function () {
      var res = viewOnHappity(
        { kind: "profile", providerId: "p1" },
        { published: false, activities: {} }
      );
      HC.assert(res.ok === false, "an unpublished profile cannot be viewed");
      HC.assert(res.opened === false, "nothing should be opened for a draft");
      HC.assert(res.url === "", "no URL should be resolved for a draft");
      HC.assert(res.reason === "not-published", "reason should be 'not-published', got " + res.reason);
    });

    check("A draft ACTIVITY (profile live) has no live page to view", function () {
      var res = viewOnHappity(
        { kind: "activity", providerId: "p1", activityId: "a1" },
        { published: true, activities: { a1: false } }
      );
      HC.assert(res.ok === false, "an unpublished activity cannot be viewed even if the profile is live");
      HC.assert(res.reason === "not-published", "reason should be 'not-published', got " + res.reason);
    });

    check("An activity on an UNPUBLISHED profile is not viewable", function () {
      var res = viewOnHappity(
        { kind: "activity", providerId: "p1", activityId: "a1" },
        { published: false, activities: { a1: true } }
      );
      HC.assert(res.ok === false, "if the profile is a draft, its activities aren't public");
      HC.assert(res.reason === "not-published", "reason should be 'not-published', got " + res.reason);
    });

    // --- isLive logic, isolated. ---
    check("isLive: profile follows published flag; activity needs profile + activity", function () {
      HC.assert(isLive({ kind: "profile", providerId: "p" }, { published: true }) === true, "published profile is live");
      HC.assert(isLive({ kind: "profile", providerId: "p" }, { published: false }) === false, "draft profile is not live");
      HC.assert(isLive({ kind: "activity", providerId: "p", activityId: "a" }, { published: true, activities: {} }) === true,
        "activity defaults to live when profile is published and not explicitly turned off");
      HC.assert(isLive({ kind: "activity", providerId: "p", activityId: "a" }, { published: true, activities: { a: false } }) === false,
        "an explicitly-unpublished activity is not live");
    });

    // --- URL builders are well-formed and customer-facing. ---
    check("URL builders produce slugged, absolute customer-facing URLs", function () {
      HC.assert(profileUrl("Lloyd Park Children's Charity") === PUBLIC_BASE + "/provider/lloyd-park-childrens-charity",
        "profile URL should slugify the provider, got " + profileUrl("Lloyd Park Children's Charity"));
      HC.assert(activityUrl("ymca-y-kidz", "Week 1 · Mon 20 July") === PUBLIC_BASE + "/provider/ymca-y-kidz/camp/week-1-mon-20-july",
        "activity URL should slugify both parts, got " + activityUrl("ymca-y-kidz", "Week 1 · Mon 20 July"));
      HC.assert(profileUrl("") === "", "empty provider yields no URL");
      HC.assert(activityUrl("p", "") === "", "missing activity yields no URL");
    });

    // --- Article 3807913: the same control FETCHES the booking link; copying
    //     it returns the exact live URL. ---
    check("The control yields a copyable live booking link (article 3807913)", function () {
      var status = { published: true, activities: {} };
      var url = liveUrlFor({ kind: "activity", providerId: "active-london", activityId: "active-london-week-2" }, status);
      HC.assert(url !== "", "a published activity should resolve a booking link");
      var copied = copyToClipboard(url);
      HC.assert(copied.text === url, "clipboard text must equal the live booking link");
      HC.assert(/^https:\/\//.test(copied.text), "the booking link must be an absolute https URL");
    });

    // --- Guard rails: bad / missing targets are handled, not thrown. ---
    check("Bad or empty targets are handled defensively (no throw)", function () {
      HC.assert(viewOnHappity(null, {}).ok === false, "null target -> not ok");
      HC.assert(viewOnHappity(null, {}).reason === "no-target", "null target reason");
      HC.assert(viewOnHappity({ kind: "activity", providerId: "p", activityId: "" }, { published: true }).reason === "no-activity-selected",
        "activity with no id selected -> reason");
      HC.assert(viewOnHappity({ kind: "profile", providerId: "" }, { published: true }).reason === "no-provider",
        "profile with no provider -> reason");
      HC.assert(viewOnHappity({ kind: "weird", providerId: "p" }, { published: true }).reason === "no-target",
        "unknown kind -> no-target");
    });

    // --- A popup-blocked open still counts as resolved (ok), with the URL. ---
    check("If the opener is blocked, the URL is still resolved (ok=true)", function () {
      var res = viewOnHappity(
        { kind: "profile", providerId: "p" },
        { published: true, activities: {} },
        function () { return false; } // simulate a blocked / failed open
      );
      HC.assert(res.ok === true, "resolving the live URL should still succeed");
      HC.assert(res.url !== "", "URL should be present even if the tab didn't open");
      HC.assert(res.opened === false, "opened should reflect the blocked open");
    });

    // --- Persistence round-trip via HC.store (isolated test provider). ---
    check("Publish status round-trips through HC.store without touching real data", function () {
      var TEST_PID = "__selftest_viewhappity__" + HC.util.uid();
      // Default: a fresh provider is published.
      var s0 = getStatus(TEST_PID);
      HC.assert(s0.published === true, "default status should be published");
      var defaultView = viewOnHappity({ kind: "profile", providerId: TEST_PID }, s0);
      HC.assert(defaultView.ok === true, "default-published profile should be viewable");

      // Unpublish the profile -> not viewable.
      setProfilePublished(TEST_PID, false);
      var s1 = getStatus(TEST_PID);
      HC.assert(s1.published === false, "profile should now be a draft");
      HC.assert(viewOnHappity({ kind: "profile", providerId: TEST_PID }, s1).ok === false, "draft profile not viewable");

      // Re-publish + add a published activity -> activity viewable.
      setProfilePublished(TEST_PID, true);
      setActivityPublished(TEST_PID, "wk1", true);
      var s2 = getStatus(TEST_PID);
      var actView = viewOnHappity({ kind: "activity", providerId: TEST_PID, activityId: "wk1" }, s2,
        function () { return true; });
      HC.assert(actView.ok === true && actView.opened === true, "published activity should open its public page");
      HC.assert(actView.url.indexOf("/camp/wk1") !== -1, "activity URL should target the activity, got " + actView.url);

      // Turn the activity into a draft -> not viewable.
      setActivityPublished(TEST_PID, "wk1", false);
      var s3 = getStatus(TEST_PID);
      HC.assert(viewOnHappity({ kind: "activity", providerId: TEST_PID, activityId: "wk1" }, s3).ok === false,
        "draft activity not viewable");

      // Cleanup so we never leave test data behind.
      try {
        var map = allStatus();
        delete map[TEST_PID];
        HC.store.set(STORE_KEY, map);
      } catch (e) {}
      HC.assert(true, "cleanup done");
    });

    // --- Live-data sanity: a real school-age camp + activity resolves and
    //     opens a valid customer-facing page. ---
    check("A real live holiday camp can be viewed on the customer-facing site", function () {
      var provider = firstProvider();
      HC.assert(provider && provider.id, "should resolve a live provider");
      var acts = activitiesFor(provider);
      HC.assert(acts.length > 0, "the live provider should have at least one activity");

      // Profile view.
      var pView = viewOnHappity({ kind: "profile", providerId: provider.id },
        { published: true, activities: {} }, function () { return true; });
      HC.assert(pView.ok === true && pView.opened === true, "real provider profile should open");
      HC.assert(pView.url.indexOf(slugify(provider.id)) !== -1, "profile URL should target the live provider id");

      // Activity view.
      var aView = viewOnHappity({ kind: "activity", providerId: provider.id, activityId: acts[0].id },
        { published: true, activities: {} }, function () { return true; });
      HC.assert(aView.ok === true && aView.opened === true, "real provider activity should open");
      HC.assert(aView.url.indexOf("/camp/") !== -1, "activity URL should be a per-camp page");

      // The fetched link is copyable (article 3807913).
      var copied = copyToClipboard(aView.url);
      HC.assert(copied.text === aView.url, "copy of the live booking link must equal the link");
    });

    return { pass: pass, fail: fail, log: log };
  }

  /* ===================================================================
     REGISTER (idempotent + defensive via core).
     =================================================================== */
  HC.registerFeature({
    id: "provider-preview-public-page",
    title: "View on Happity (preview public page)",
    side: "provider",
    icon: "👀",
    summary: "Use the 'View on Happity' button to see your holiday-camp profile or a single activity exactly as a customer would on the public site — and to grab the live booking link to advertise everywhere. Draft listings have no public page yet, so the control is correctly disabled until you publish.",
    render: render,
    selfTest: selfTest
  });
})();
