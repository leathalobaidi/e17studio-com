/* HolidayCamp feature: provider-social-feed
 * ------------------------------------------------------------------
 * Replicates Happity's "add a social media feed to your profile"
 * behaviour for the PROVIDER side, reframed for SCHOOL-AGE HOLIDAY
 * CAMPS (not baby classes).
 *
 * Evidence (support corpus):
 *  - 9155760 §1 "Add images, logos and social media to your profile
 *    page": "adding your banner image and social media feed will
 *    really help prospective customers to visualise what happens at a
 *    class... Head to Profile > Organisation ... to add an image, logo
 *    and social media feed to your profile."
 *  - 6212044 (the 'Contact' section under Organisation): "the Facebook
 *    link included on this page is what will be used for the Facebook
 *    widget, so it is important to keep this up to date." i.e. the
 *    single Facebook link drives a live Facebook *widget* on the page.
 *
 * Acceptance criterion (asserted by selfTest, multiple cases):
 *   The profile shows the provider's social link / feed; the Facebook
 *   link feeds a widget. Concretely: saved links surface on the profile
 *   preview, and a valid Facebook page URL is resolved into a Facebook
 *   widget (page handle + embeddable plugin/feed URL). No Facebook link
 *   => no widget. A bad URL is rejected and never feeds the widget.
 *
 * Defensive: nothing throws at registration time. Persistence is via
 * HC.store ONLY (one namespaced key, keyed by provider id); the
 * verified camps.js data is never mutated.
 * ------------------------------------------------------------------ */
(function () {
  "use strict";

  if (typeof window === "undefined" || !window.HC || typeof window.HC.registerFeature !== "function") {
    // Core not present — fail silently rather than throwing.
    return;
  }
  var HC = window.HC;

  var STORE_KEY = "provider_social_links"; // { [providerId]: { facebook, instagram, ... } }

  /* ============================================================
   * 1. Supported social platforms.
   *    Facebook is special: per Happity (6212044), the Facebook link
   *    is the one that feeds the on-profile Facebook WIDGET. The others
   *    render as simple "social link" chips on the profile.
   * ============================================================ */

  var PLATFORMS = [
    {
      key: "facebook",
      label: "Facebook",
      icon: "📘",
      // Accept facebook.com / fb.com page URLs (optionally with www / m / locale).
      host: /(^|\.)(facebook\.com|fb\.com|fb\.me)$/i,
      feedsWidget: true,
      placeholder: "https://www.facebook.com/YourCampPage"
    },
    { key: "instagram", label: "Instagram", icon: "📸", host: /(^|\.)instagram\.com$/i, feedsWidget: false, placeholder: "https://www.instagram.com/yourcamp" },
    { key: "tiktok",    label: "TikTok",    icon: "🎵", host: /(^|\.)tiktok\.com$/i,    feedsWidget: false, placeholder: "https://www.tiktok.com/@yourcamp" },
    { key: "youtube",   label: "YouTube",   icon: "▶️", host: /(^|\.)(youtube\.com|youtu\.be)$/i, feedsWidget: false, placeholder: "https://www.youtube.com/@yourcamp" },
    { key: "website",   label: "Website",   icon: "🌐", host: null, feedsWidget: false, placeholder: "https://yourcamp.co.uk" }
  ];

  function platform(key) {
    for (var i = 0; i < PLATFORMS.length; i++) {
      if (PLATFORMS[i].key === key) return PLATFORMS[i];
    }
    return null;
  }

  /* ============================================================
   * 2. Pure URL helpers — defensive, no exceptions escape.
   * ============================================================ */

  function trimStr(s) { return String(s == null ? "" : s).replace(/\s+/g, " ").trim(); }

  // Add a scheme if the provider pasted a bare "facebook.com/x" link.
  function withScheme(raw) {
    var s = trimStr(raw);
    if (!s) return "";
    if (/^https?:\/\//i.test(s)) return s;
    if (/^\/\//.test(s)) return "https:" + s;
    return "https://" + s;
  }

  // Parse a URL into { ok, host, path } without throwing.
  function parseUrl(raw) {
    var s = withScheme(raw);
    if (!s) return { ok: false };
    // Browser URL is available, but keep a regex fallback so node --check
    // / non-DOM contexts still behave. We only need host + path here.
    var m = /^https?:\/\/([^\/?#:]+)(?::\d+)?([^?#]*)/i.exec(s);
    if (!m) return { ok: false };
    var host = String(m[1] || "").toLowerCase();
    var path = String(m[2] || "");
    if (!host || host.indexOf(".") === -1) return { ok: false }; // need a real domain
    return { ok: true, url: s, host: host, path: path };
  }

  function hostMatches(host, rx) {
    if (!rx) return true; // website: any valid host
    return rx.test(host);
  }

  /* ============================================================
   * 3. Validate + normalise ONE platform link.
   *    Returns { ok, value?, error? }. A blank value is "ok" (cleared).
   * ============================================================ */
  function validateLink(key, raw) {
    var p = platform(key);
    if (!p) return { ok: false, error: "Unknown platform" };
    var s = trimStr(raw);
    if (!s) return { ok: true, value: "" }; // cleared / not set is fine
    var parsed = parseUrl(s);
    if (!parsed.ok) return { ok: false, error: "That doesn't look like a valid web address." };
    if (!hostMatches(parsed.host, p.host)) {
      return { ok: false, error: "That's not a " + p.label + " link." };
    }
    return { ok: true, value: parsed.url };
  }

  // Validate+normalise a whole set of links. Skips invalid ones into errors.
  function normaliseLinks(input) {
    var out = {}, errors = {}, ok = true;
    var src = input || {};
    for (var i = 0; i < PLATFORMS.length; i++) {
      var key = PLATFORMS[i].key;
      var res = validateLink(key, src[key]);
      if (!res.ok) { errors[key] = res.error; ok = false; continue; }
      if (res.value) out[key] = res.value;
    }
    return { ok: ok, links: out, errors: errors };
  }

  /* ============================================================
   * 4. THE FACEBOOK WIDGET (acceptance core).
   *    Happity: "the Facebook link ... is what will be used for the
   *    Facebook widget". We resolve a Facebook page URL into a widget
   *    descriptor: the page handle plus an embeddable Page-plugin feed
   *    URL. No facebook link => no widget (null).
   * ============================================================ */
  function facebookWidget(links) {
    var raw = links && links.facebook;
    var res = validateLink("facebook", raw);
    if (!res.ok || !res.value) return null;

    var parsed = parseUrl(res.value);
    if (!parsed.ok) return null;

    // Derive the page handle from the path: /YourCampPage or
    // /profile.php?id=... or /pages/Name/123 — take the first useful seg.
    var segs = parsed.path.split("/").filter(function (x) { return x; });
    var handle = "";
    for (var i = 0; i < segs.length; i++) {
      var seg = segs[i];
      if (seg === "pages" || seg === "pg" || seg === "people") continue;
      handle = seg.replace(/^@/, "");
      break;
    }
    if (!handle) handle = "page";

    // Embeddable Facebook Page-plugin "feed" URL (mock; this is exactly
    // the kind of href the FB Page plugin / widget consumes).
    var pageUrl = encodeURIComponent(res.value);
    var embedUrl =
      "https://www.facebook.com/plugins/page.php?href=" + pageUrl +
      "&tabs=timeline&width=340&height=500&small_header=true&adapt_container_width=true";

    return {
      enabled: true,
      type: "facebook-page-plugin",
      handle: handle,
      pageUrl: res.value,
      embedUrl: embedUrl,
      title: "Latest from our Facebook"
    };
  }

  /* ============================================================
   * 5. Build the PUBLIC PROFILE block from saved links.
   *    This is what a parent sees on the provider's profile: a row of
   *    social link chips + (if a Facebook link exists) the live widget.
   * ============================================================ */
  function buildProfileSocial(links) {
    var safe = (links && typeof links === "object") ? links : {};
    var chips = [];
    for (var i = 0; i < PLATFORMS.length; i++) {
      var p = PLATFORMS[i];
      var v = trimStr(safe[p.key]);
      if (!v) continue;
      var res = validateLink(p.key, v);
      if (!res.ok || !res.value) continue;
      chips.push({ key: p.key, label: p.label, icon: p.icon, url: res.value });
    }
    return {
      hasAnyLink: chips.length > 0,
      chips: chips,
      widget: facebookWidget(safe)
    };
  }

  /* ============================================================
   * 6. Persistence (HC.store only). Keyed by provider id.
   * ============================================================ */
  function readAll() {
    var v = HC.store.get(STORE_KEY, {});
    return (v && typeof v === "object") ? v : {};
  }
  function readLinks(providerId) {
    var all = readAll();
    var got = all[providerId];
    return (got && typeof got === "object") ? got : {};
  }
  function clearLinks(providerId) {
    var all = readAll();
    if (all[providerId]) { delete all[providerId]; HC.store.set(STORE_KEY, all); }
  }

  // Validate, then persist the valid subset. Returns the normalise result.
  function saveLinks(providerId, input) {
    var norm = normaliseLinks(input);
    if (!norm.ok) return norm; // reject: nothing written
    var all = readAll();
    all[providerId] = norm.links;
    HC.store.set(STORE_KEY, all);
    return norm;
  }

  /* ============================================================
   * 7. Pick a live provider to demo with (read-only).
   * ============================================================ */
  function demoProvider() {
    var ps = HC.data.providers || [];
    for (var i = 0; i < ps.length; i++) {
      if (ps[i] && ps[i].id && ps[i].name) return ps[i];
    }
    return { id: "demo-camp", name: "Demo Holiday Camp", area: "Walthamstow" };
  }

  /* ============================================================
   * 8. Render — the provider's "Profile > Organisation > Social"
   *    editor on the left, the live public-profile preview (chips +
   *    Facebook widget) on the right.
   * ============================================================ */
  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function render(mountEl) {
    try {
      var prov = demoProvider();
      var saved = readLinks(prov.id);

      var fieldsHtml = "";
      for (var i = 0; i < PLATFORMS.length; i++) {
        var p = PLATFORMS[i];
        var val = trimStr(saved[p.key]);
        fieldsHtml +=
          '<label style="display:block;margin:0 0 12px">' +
            '<span style="display:block;font-weight:700;color:var(--purple,#603488);font-size:13px;margin-bottom:4px">' +
              p.icon + " " + esc(p.label) +
              (p.feedsWidget ? ' <span style="color:var(--magenta,#F82488);font-size:11px">· feeds the widget</span>' : "") +
            "</span>" +
            '<input type="url" data-sf="' + esc(p.key) + '" value="' + esc(val) + '" placeholder="' + esc(p.placeholder) + '" ' +
              'style="width:100%;box-sizing:border-box;padding:9px 11px;border:1.5px solid var(--line,#E6E6E6);border-radius:12px;font-size:13px">' +
            '<span class="sf-err" data-sf-err="' + esc(p.key) + '" style="color:#9a1f5e;font-size:11.5px"></span>' +
          "</label>";
      }

      mountEl.innerHTML =
        '<p style="font-size:13.5px;color:var(--text,#383838);margin:0 0 14px">' +
          "Add your social media to <strong>" + esc(prov.name) + "</strong>'s profile " +
          "(Profile &gt; Organisation). Parents see your social links on the profile, and your " +
          "<strong>Facebook</strong> link feeds a live Facebook feed widget." +
        "</p>" +
        '<div style="display:grid;grid-template-columns:1fr 1fr;gap:18px;align-items:start" class="sf-grid">' +
          '<div>' +
            '<div style="font-weight:700;color:var(--purple,#603488);font-size:13px;text-transform:uppercase;letter-spacing:.4px;margin-bottom:10px">Your social links</div>' +
            fieldsHtml +
            '<button class="hc-btn" data-sf-save>Save to profile</button> ' +
            '<button class="hc-btn hc-btn-ghost" data-sf-clear>Clear</button>' +
          "</div>" +
          '<div>' +
            '<div style="font-weight:700;color:var(--purple,#603488);font-size:13px;text-transform:uppercase;letter-spacing:.4px;margin-bottom:10px">Profile preview</div>' +
            '<div data-sf-preview style="border:1.5px solid var(--line,#E6E6E6);border-radius:16px;padding:14px;background:#fff"></div>' +
          "</div>" +
        "</div>";

      var previewEl = mountEl.querySelector("[data-sf-preview]");

      function readForm() {
        var obj = {};
        var inputs = mountEl.querySelectorAll("input[data-sf]");
        for (var j = 0; j < inputs.length; j++) obj[inputs[j].getAttribute("data-sf")] = inputs[j].value;
        return obj;
      }

      function paintPreview(links) {
        var view = buildProfileSocial(links);
        var html = "";
        if (!view.hasAnyLink) {
          html += '<p style="color:var(--muted,#808080);font-size:13px;margin:0 0 8px">No social links yet — add one on the left.</p>';
        } else {
          html += '<div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:12px">';
          for (var c = 0; c < view.chips.length; c++) {
            var ch = view.chips[c];
            html += '<a href="' + esc(ch.url) + '" target="_blank" rel="noopener" ' +
              'style="display:inline-flex;align-items:center;gap:5px;text-decoration:none;font-size:12.5px;font-weight:700;' +
              'color:var(--purple,#603488);background:var(--purple-tint,#F0E8F4);padding:5px 11px;border-radius:999px">' +
              ch.icon + " " + esc(ch.label) + "</a>";
          }
          html += "</div>";
        }
        if (view.widget) {
          html +=
            '<div data-sf-widget style="border:1.5px solid var(--line,#E6E6E6);border-radius:14px;overflow:hidden">' +
              '<div style="background:#1877F2;color:#fff;font-weight:700;font-size:12.5px;padding:8px 12px">📘 ' +
                esc(view.widget.title) + " · @" + esc(view.widget.handle) + "</div>" +
              '<div style="padding:12px;font-size:12.5px;color:var(--text,#383838)">' +
                '<div style="background:#F0F2F5;border-radius:10px;padding:10px;margin-bottom:8px">📷 Photos from last week’s camp!</div>' +
                '<div style="background:#F0F2F5;border-radius:10px;padding:10px">🎉 A few places left for half term — book now.</div>' +
                '<div style="color:var(--muted,#808080);font-size:11px;margin-top:8px">Live feed embedded from ' +
                  esc(view.widget.pageUrl) + "</div>" +
              "</div>" +
            "</div>";
        } else {
          html += '<p style="color:var(--muted,#808080);font-size:11.5px;margin:6px 0 0">' +
            "Add a Facebook link to switch on the live Facebook feed widget.</p>";
        }
        previewEl.innerHTML = html;
      }

      function clearErrors() {
        var errs = mountEl.querySelectorAll("[data-sf-err]");
        for (var e = 0; e < errs.length; e++) errs[e].textContent = "";
      }

      // initial preview from saved
      paintPreview(saved);

      // live preview as the provider types
      mountEl.addEventListener("input", function (ev) {
        if (ev.target && ev.target.getAttribute && ev.target.getAttribute("data-sf")) {
          paintPreview(readForm());
        }
      });

      var saveBtn = mountEl.querySelector("[data-sf-save]");
      if (saveBtn) saveBtn.addEventListener("click", function () {
        clearErrors();
        var norm = saveLinks(prov.id, readForm());
        if (!norm.ok) {
          for (var k in norm.errors) {
            if (!Object.prototype.hasOwnProperty.call(norm.errors, k)) continue;
            var span = mountEl.querySelector('[data-sf-err="' + k + '"]');
            if (span) span.textContent = norm.errors[k];
          }
          HC.util.toast("Fix the highlighted link(s) before saving");
          return;
        }
        paintPreview(norm.links);
        HC.util.toast(norm.links.facebook ? "Saved — Facebook widget is live" : "Social links saved to your profile");
      });

      var clearBtn = mountEl.querySelector("[data-sf-clear]");
      if (clearBtn) clearBtn.addEventListener("click", function () {
        clearLinks(prov.id);
        var inputs = mountEl.querySelectorAll("input[data-sf]");
        for (var j = 0; j < inputs.length; j++) inputs[j].value = "";
        clearErrors();
        paintPreview({});
        HC.util.toast("Social links cleared");
      });
    } catch (e) {
      mountEl.innerHTML = '<p style="color:#9a1f5e">Social feed editor failed to load: ' + esc(e && e.message ? e.message : String(e)) + "</p>";
    }
  }

  /* ============================================================
   * 9. selfTest — exercises the LOGIC and asserts the acceptance
   *    criterion across multiple cases.
   * ============================================================ */
  function selfTest() {
    var pass = 0, fail = 0, log = [];
    function check(name, fn) {
      try { fn(); pass++; log.push("✓ " + name); }
      catch (e) { fail++; log.push("✗ " + name + " — " + (e && e.message ? e.message : String(e))); }
    }

    var TEST_ID = "__sf_test_provider__";
    clearLinks(TEST_ID); // start clean

    // --- URL validation / normalisation ---
    check("A bare facebook.com link is accepted and given a scheme", function () {
      var r = validateLink("facebook", "facebook.com/SummerCampE17");
      HC.assert(r.ok === true, "bare host should validate");
      HC.assert(/^https:\/\//.test(r.value), "should be normalised with https://, got " + r.value);
    });

    check("A non-Facebook host is rejected for the Facebook field", function () {
      var r = validateLink("facebook", "https://instagram.com/notfacebook");
      HC.assert(r.ok === false, "instagram URL must be rejected in the facebook field");
      HC.assert(!!r.error, "should carry an error message");
    });

    check("Garbage text is rejected as not a valid URL", function () {
      var r = validateLink("instagram", "not a url at all");
      HC.assert(r.ok === false, "garbage must be rejected");
    });

    check("A blank value is treated as 'cleared' (ok, empty)", function () {
      var r = validateLink("youtube", "   ");
      HC.assert(r.ok === true && r.value === "", "blank should be ok+empty");
    });

    check("A valid Instagram link is accepted", function () {
      var r = validateLink("instagram", "https://www.instagram.com/walthamcamp/");
      HC.assert(r.ok === true && /instagram\.com/.test(r.value), "instagram link should validate");
    });

    check("Website field accepts any valid domain", function () {
      var r = validateLink("website", "yourcamp.co.uk");
      HC.assert(r.ok === true && /yourcamp\.co\.uk/.test(r.value), "website should accept any host");
    });

    // --- ACCEPTANCE: profile shows the provider's social link/feed ---
    check("Saved social links surface on the profile preview", function () {
      var view = buildProfileSocial({ instagram: "https://instagram.com/campe17", website: "https://campe17.co.uk" });
      HC.assert(view.hasAnyLink === true, "profile should report links present");
      HC.assert(view.chips.length === 2, "expected 2 chips, got " + view.chips.length);
      var keys = view.chips.map(function (c) { return c.key; });
      HC.assert(keys.indexOf("instagram") !== -1 && keys.indexOf("website") !== -1, "both links should show on the profile");
    });

    check("Invalid links never appear on the public profile", function () {
      var view = buildProfileSocial({ instagram: "https://instagram.com/ok", facebook: "ftp://broken" });
      HC.assert(view.hasAnyLink === true, "the good instagram link should still show");
      var keys = view.chips.map(function (c) { return c.key; });
      HC.assert(keys.indexOf("facebook") === -1, "the broken facebook link must not show as a chip");
    });

    // --- ACCEPTANCE: the Facebook link feeds a widget ---
    check("A valid Facebook link feeds a Facebook widget", function () {
      var w = facebookWidget({ facebook: "https://www.facebook.com/SummerCampE17" });
      HC.assert(w !== null, "a widget should be produced");
      HC.assert(w.enabled === true && w.type === "facebook-page-plugin", "should be the FB page-plugin widget");
      HC.assert(w.handle === "SummerCampE17", "widget handle should derive from the page, got " + w.handle);
      HC.assert(w.embedUrl.indexOf("plugins/page.php") !== -1, "widget should expose an embeddable plugin URL");
      HC.assert(w.embedUrl.indexOf(encodeURIComponent(w.pageUrl)) !== -1, "embed URL should carry the page href");
    });

    check("No Facebook link => no widget", function () {
      var w = facebookWidget({ instagram: "https://instagram.com/campe17" });
      HC.assert(w === null, "without a facebook link there must be no widget");
    });

    check("An invalid Facebook link does NOT feed the widget", function () {
      var w = facebookWidget({ facebook: "https://twitter.com/notfb" });
      HC.assert(w === null, "a non-facebook URL must not produce a widget");
    });

    check("The widget is reachable through the full profile build", function () {
      var view = buildProfileSocial({ facebook: "https://facebook.com/pages/My-Camp/12345" });
      HC.assert(view.widget !== null, "profile build should include the widget");
      HC.assert(view.widget.handle === "My-Camp", "handle should skip the /pages/ segment, got " + view.widget.handle);
    });

    check("A bare facebook.com link still resolves to a widget", function () {
      var w = facebookWidget({ facebook: "facebook.com/E17Camp" });
      HC.assert(w !== null && w.handle === "E17Camp", "bare FB host should still feed the widget");
    });

    // --- Persistence round-trip via HC.store ---
    check("saveLinks persists a valid set to the store", function () {
      clearLinks(TEST_ID);
      var r = saveLinks(TEST_ID, { facebook: "https://facebook.com/CampPage", instagram: "instagram.com/camp" });
      HC.assert(r.ok === true, "valid save should succeed");
      var back = readLinks(TEST_ID);
      HC.assert(/facebook\.com\/CampPage/.test(back.facebook || ""), "facebook should persist");
      HC.assert(/instagram\.com\/camp/.test(back.instagram || ""), "instagram should persist");
    });

    check("A save with a bad link is rejected and nothing is written", function () {
      clearLinks(TEST_ID);
      var r = saveLinks(TEST_ID, { facebook: "https://example.com/notfb" });
      HC.assert(r.ok === false, "invalid save must be rejected");
      HC.assert(!!r.errors.facebook, "should report the facebook error");
      var back = readLinks(TEST_ID);
      HC.assert(!back.facebook, "nothing should be persisted on a rejected save");
    });

    check("Saved links re-read on next load drive the profile + widget (round-trip)", function () {
      clearLinks(TEST_ID);
      saveLinks(TEST_ID, { facebook: "https://www.facebook.com/PersistedCamp" });
      var reloaded = readLinks(TEST_ID);          // simulate a fresh page load
      var view = buildProfileSocial(reloaded);
      HC.assert(view.hasAnyLink === true, "reloaded profile should show the link");
      HC.assert(view.widget && view.widget.handle === "PersistedCamp", "reloaded widget should match the saved page");
      clearLinks(TEST_ID); // leave the store as found
    });

    // --- Live-data sanity: a real provider can carry a social feed ---
    check("A live provider profile can be given a social feed + widget", function () {
      var prov = demoProvider();
      HC.assert(prov && prov.id && prov.name, "should resolve a live provider");
      clearLinks(prov.id);
      var r = saveLinks(prov.id, { facebook: "https://facebook.com/" + prov.id });
      HC.assert(r.ok === true, "saving a social link to a live provider should succeed");
      var view = buildProfileSocial(readLinks(prov.id));
      HC.assert(view.widget !== null, "the live provider's profile should now show a Facebook widget");
      HC.assert(view.widget.handle === prov.id, "widget should be tied to the saved page");
      clearLinks(prov.id); // leave the store as found
    });

    return { pass: pass, fail: fail, log: log };
  }

  /* ============================================================
   * 10. Register (idempotent + defensive via core).
   * ============================================================ */
  HC.registerFeature({
    id: "provider-social-feed",
    title: "Add a social media feed",
    side: "provider",
    icon: "📣",
    summary: "Add your social media links (Facebook, Instagram, TikTok, YouTube, website) to your holiday-camp profile so parents can see your camp in action. Your Facebook link feeds a live Facebook feed widget on the profile.",
    render: render,
    selfTest: selfTest
  });
})();
