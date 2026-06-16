/* HolidayCamp feature: provider-facebook-community
 * ------------------------------------------------------------------
 * Replicates Happity's "join our Provider Facebook group" behaviour for
 * the PROVIDER side, reframed for SCHOOL-AGE HOLIDAY CAMPS (not baby
 * classes).
 *
 * Evidence (support corpus):
 *  - Article 6394546 "How do I find out about new features?":
 *      "You can also join our Provider Facebook group here, this is a
 *       great space for our class providers to ask each other for
 *       advice, share ideas and offer support."
 *    (The live link is https://www.facebook.com/groups/happityjourney —
 *     a CLOSED group for providers, distinct from Happity's public,
 *     parent-facing Facebook page / Instagram.)
 *
 * Acceptance criterion (asserted by selfTest, multiple cases):
 *   A link/CTA to the dedicated PROVIDER Facebook community GROUP is
 *   surfaced to providers (e.g. dashboard / help), and it is DISTINCT
 *   from the platform's public, parent-facing social channels (the
 *   public Facebook PAGE, Instagram, etc.). Concretely:
 *     - the surfaced community link points at a facebook.com/groups/...
 *       URL (a private group), audience = providers;
 *     - that URL is NOT equal to (and not the same kind as) any of the
 *       public parent-facing channels;
 *     - a provider can record that they have joined, and joined-state
 *       persists via HC.store (so we don't keep nagging them).
 *
 * Defensive: nothing throws at registration time. Persistence is via
 * HC.store ONLY (one namespaced key). Verified camps.js data is never
 * mutated.
 * ------------------------------------------------------------------ */
(function () {
  "use strict";

  if (typeof window === "undefined" || !window.HC || typeof window.HC.registerFeature !== "function") {
    // Core not present — fail silently rather than throwing.
    return;
  }
  var HC = window.HC;

  var STORE_KEY = "provider_fb_community"; // { joined:Bool, joinedAt:Number, dismissed:Bool }

  /* ============================================================
   * 1. Channel directory.
   *    The PROVIDER community group is what we surface to providers.
   *    The public channels exist ONLY so we can prove the provider
   *    group is distinct from them (the acceptance criterion).
   * ============================================================ */

  // The dedicated, provider-only community group (the thing we surface).
  var COMMUNITY = {
    id: "provider-group",
    audience: "provider",
    kind: "group",               // facebook.com/groups/... = a group, not a page
    label: "HolidayCamp Providers — Community Group",
    network: "facebook",
    url: "https://www.facebook.com/groups/holidaycampproviders",
    blurb: "A private space for camp providers to ask each other for advice, " +
      "share ideas and offer support — running school-holiday clubs, HAF places, " +
      "staffing ratios, pricing and more."
  };

  // Happity's public, PARENT-facing channels. These must NOT be confused
  // with the provider group. (We keep them so selfTest can prove the
  // distinction, and so render() can visibly contrast them.)
  var PUBLIC_CHANNELS = [
    {
      id: "public-fb-page",
      audience: "parent",
      kind: "page",              // facebook.com/<page> = a public Page
      label: "HolidayCamp (public Facebook page)",
      network: "facebook",
      url: "https://www.facebook.com/holidaycampuk"
    },
    {
      id: "public-instagram",
      audience: "parent",
      kind: "profile",
      label: "HolidayCamp on Instagram",
      network: "instagram",
      url: "https://www.instagram.com/holidaycampuk"
    }
  ];

  /* ============================================================
   * 2. Pure URL helpers — defensive, no exceptions escape.
   * ============================================================ */

  function trimStr(s) { return String(s == null ? "" : s).replace(/\s+/g, " ").trim(); }

  // Parse a URL into { ok, host, path } without throwing. Works in a DOM
  // (uses URL) and falls back to a regex so non-DOM / node --check is fine.
  function parseUrl(raw) {
    var s = trimStr(raw);
    if (!s) return { ok: false };
    if (!/^https?:\/\//i.test(s)) s = "https://" + s.replace(/^\/+/, "");
    try {
      if (typeof URL === "function") {
        var u = new URL(s);
        return {
          ok: true,
          host: (u.hostname || "").toLowerCase().replace(/^www\./, ""),
          path: u.pathname || "/"
        };
      }
    } catch (e) { /* fall through to regex */ }
    var m = /^https?:\/\/([^\/?#]+)([^?#]*)/i.exec(s);
    if (!m) return { ok: false };
    return {
      ok: true,
      host: (m[1] || "").toLowerCase().replace(/^www\./, ""),
      path: m[2] || "/"
    };
  }

  function isFacebook(parsed) {
    return !!(parsed && parsed.ok &&
      /(^|\.)(facebook\.com|fb\.com)$/i.test(parsed.host));
  }

  // Is this URL a Facebook *group* (the closed provider community) rather
  // than a public Page / profile? Groups live under /groups/<id>.
  function isFacebookGroup(url) {
    var p = parseUrl(url);
    if (!isFacebook(p)) return false;
    return /^\/groups\/[^\/]+/i.test(p.path || "");
  }

  // Normalise a URL for equality comparison (host + path, no trailing slash).
  function canonical(url) {
    var p = parseUrl(url);
    if (!p.ok) return "";
    var path = (p.path || "/").replace(/\/+$/, "");
    if (path === "") path = "/";
    return p.host + path;
  }

  function sameLink(a, b) {
    var ca = canonical(a), cb = canonical(b);
    return !!ca && ca === cb;
  }

  /* ============================================================
   * 3. State model — pure, testable, persisted via HC.store only.
   * ============================================================ */

  function loadState() {
    var s = null;
    try { s = HC.store.get(STORE_KEY, null); } catch (e) { s = null; }
    if (!s || typeof s !== "object") s = {};
    return {
      joined: !!s.joined,
      joinedAt: typeof s.joinedAt === "number" ? s.joinedAt : null,
      dismissed: !!s.dismissed
    };
  }

  function saveState(state) {
    try { HC.store.set(STORE_KEY, state); return true; }
    catch (e) { return false; }
  }

  // Mark the provider as having joined the community group. Idempotent.
  function markJoined(state) {
    var next = {
      joined: true,
      joinedAt: (state && typeof state.joinedAt === "number") ? state.joinedAt : Date.now(),
      dismissed: state ? !!state.dismissed : false
    };
    return next;
  }

  function markDismissed(state) {
    return {
      joined: state ? !!state.joined : false,
      joinedAt: state ? state.joinedAt : null,
      dismissed: true
    };
  }

  function reset() {
    return { joined: false, joinedAt: null, dismissed: false };
  }

  /* ============================================================
   * 4. The acceptance-criterion logic, as a pure function.
   *    Returns the community link surfaced to providers + proof it is
   *    distinct from every public, parent-facing channel.
   * ============================================================ */

  function resolveCommunity() {
    var community = COMMUNITY;
    var isGroup = isFacebookGroup(community.url);
    var forProviders = community.audience === "provider";

    // Distinctness: the provider group URL must differ from EVERY public
    // parent-facing channel, and must be a *group* where they are *pages/
    // profiles* (different kind of surface, not just a different slug).
    var distinct = PUBLIC_CHANNELS.every(function (ch) {
      var differentLink = !sameLink(community.url, ch.url);
      var differentKind = community.kind !== ch.kind;
      var differentAudience = community.audience !== ch.audience;
      return differentLink && (differentKind || differentAudience);
    });

    return {
      surfaced: !!(community.url && forProviders),
      forProviders: forProviders,
      isGroup: isGroup,
      distinctFromPublic: distinct,
      community: community,
      publicChannels: PUBLIC_CHANNELS.slice()
    };
  }

  /* ============================================================
   * 5. render(mountEl) — the provider-facing UI (dashboard/help card).
   * ============================================================ */

  function render(mountEl) {
    if (!mountEl) return;
    var el = HC.util.el;
    try {
      var resolved = resolveCommunity();
      var state = loadState();
      mountEl.innerHTML = "";

      var wrap = el("div", { style: "font-family:'Nunito Sans',system-ui,sans-serif;color:var(--text,#383838)" });

      wrap.appendChild(el("p", {
        style: "margin:0 0 14px;font-size:15px;max-width:640px"
      },
        "Running a holiday camp can be a lonely business. Join the private " +
        "<strong>provider community group</strong> to ask other camp organisers for " +
        "advice, share ideas, and get support — from HAF paperwork to wet-weather " +
        "plans. It's just for providers, so it's separate from our public, " +
        "parent-facing pages."
      ));

      // --- Provider community group card (the surfaced CTA) ---
      var card = el("div", {
        style: "border:1.5px solid var(--line,#E6E6E6);border-radius:16px;padding:18px;" +
          "background:#fff;box-shadow:var(--shadow,0 6px 22px rgba(96,52,136,.10));max-width:560px"
      });
      card.appendChild(el("div", { style: "font-size:30px" }, "📘"));
      card.appendChild(el("div", {
        style: "font-family:'Quicksand',system-ui,sans-serif;font-weight:700;color:var(--purple,#603488);font-size:18px;margin-top:4px"
      }, escapeHtml(resolved.community.label)));
      card.appendChild(el("span", {
        style: "display:inline-block;margin:6px 0;font-size:10.5px;font-weight:700;padding:3px 9px;border-radius:999px;" +
          "background:var(--purple-tint,#F0E8F4);color:var(--purple,#603488);text-transform:uppercase;letter-spacing:.3px"
      }, "Providers only · Private group"));
      card.appendChild(el("p", {
        style: "font-size:13.5px;margin:6px 0 14px;color:var(--text,#383838)"
      }, escapeHtml(resolved.community.blurb)));

      var statusRow = el("div", { style: "display:flex;align-items:center;gap:10px;flex-wrap:wrap" });

      function paintStatus() {
        var st = loadState();
        statusRow.innerHTML = "";
        var joinBtn = el("a", {
          href: resolved.community.url,
          target: "_blank",
          rel: "noopener noreferrer",
          class: "hc-btn",
          style: "text-decoration:none"
        }, st.joined ? "Open group" : "Join the group");
        // Clicking "Join" records joined-state (mock; real app would verify).
        joinBtn.addEventListener("click", function () {
          var cur = loadState();
          if (!cur.joined) {
            saveState(markJoined(cur));
            HC.util.toast("Marked as joined — welcome to the provider community!");
          }
          // Repaint shortly after so the label flips to "Open group".
          setTimeout(paintStatus, 50);
        });
        statusRow.appendChild(joinBtn);

        if (st.joined) {
          statusRow.appendChild(el("span", {
            style: "font-size:13px;color:#2f7d4f;font-weight:700"
          }, "✓ You're a member"));
          var leaveBtn = el("button", {
            class: "hc-btn hc-btn-ghost",
            type: "button"
          }, "I've left");
          leaveBtn.addEventListener("click", function () {
            saveState(reset());
            paintStatus();
          });
          statusRow.appendChild(leaveBtn);
        }
      }
      paintStatus();
      card.appendChild(statusRow);
      wrap.appendChild(card);

      // --- Contrast block: the public parent-facing channels ---
      var pub = el("div", { style: "margin-top:22px;max-width:560px" });
      pub.appendChild(el("div", {
        style: "font-family:'Quicksand',system-ui,sans-serif;color:var(--magenta,#F82488);text-transform:uppercase;" +
          "letter-spacing:.6px;font-size:12px;font-weight:700;margin-bottom:8px"
      }, "Not the same as our public channels"));
      pub.appendChild(el("p", {
        style: "font-size:13px;color:var(--muted,#808080);margin:0 0 10px"
      }, "These are for parents and families looking for camps — please don't post provider questions there:"));
      var list = el("div", { style: "display:flex;flex-direction:column;gap:6px" });
      resolved.publicChannels.forEach(function (ch) {
        list.appendChild(el("div", {
          style: "font-size:13px;color:var(--text,#383838)"
        }, (ch.network === "instagram" ? "📸 " : "🌐 ") +
          escapeHtml(ch.label) + " — <span style='color:var(--muted,#808080)'>" +
          escapeHtml(ch.url) + "</span>"));
      });
      pub.appendChild(list);
      wrap.appendChild(pub);

      mountEl.appendChild(wrap);
    } catch (e) {
      try {
        mountEl.innerHTML = '<p style="color:var(--muted)">Provider community group is temporarily unavailable.</p>';
      } catch (e2) { /* give up silently */ }
    }
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  /* ============================================================
   * 6. selfTest — exercises the LOGIC and asserts the acceptance
   *    criterion (multiple cases).
   * ============================================================ */

  function selfTest() {
    var pass = 0, fail = 0, log = [];
    function check(label, fn) {
      try { fn(); pass += 1; log.push("✓ " + label); }
      catch (e) { fail += 1; log.push("✗ " + label + " — " + (e && e.message ? e.message : String(e))); }
    }

    var resolved = resolveCommunity();

    /* ---- THE ACCEPTANCE CRITERION ----
       A link/CTA to the dedicated PROVIDER Facebook community GROUP is
       surfaced to providers, DISTINCT from public parent-facing channels. */
    check("A provider Facebook community group link is surfaced to providers", function () {
      HC.assert(resolved.surfaced, "community link is not surfaced");
      HC.assert(resolved.forProviders, "audience must be providers, got '" + resolved.community.audience + "'");
      HC.assert(isFacebook(parseUrl(resolved.community.url)), "community link must be a facebook.com URL");
      HC.assert(resolved.isGroup, "community link must be a Facebook GROUP (facebook.com/groups/...)");
    });

    check("The surfaced community link is DISTINCT from public parent-facing channels", function () {
      HC.assert(resolved.publicChannels.length >= 1, "expected public channels to contrast against");
      HC.assert(resolved.distinctFromPublic, "provider group must differ from every public channel");
      // Explicitly: not equal to any public channel URL.
      resolved.publicChannels.forEach(function (ch) {
        HC.assert(!sameLink(resolved.community.url, ch.url),
          "provider group URL collides with public channel: " + ch.id);
      });
    });

    // A public Facebook PAGE must NOT be mistaken for the provider GROUP.
    check("A public Facebook page is not classified as the provider group", function () {
      var page = resolved.publicChannels.filter(function (c) { return c.network === "facebook"; })[0];
      HC.assert(page, "expected a public facebook page in the directory");
      HC.assert(isFacebook(parseUrl(page.url)), "public page should still be a facebook.com URL");
      HC.assert(!isFacebookGroup(page.url), "public facebook PAGE wrongly detected as a group");
      HC.assert(page.audience === "parent", "public page audience should be parents");
    });

    // Group detection: positives and negatives.
    check("isFacebookGroup detects /groups/ URLs and rejects pages/other hosts", function () {
      HC.assert(isFacebookGroup("https://www.facebook.com/groups/holidaycampproviders"), "should detect a group URL");
      HC.assert(isFacebookGroup("facebook.com/groups/12345"), "should detect a bare group URL with id");
      HC.assert(!isFacebookGroup("https://www.facebook.com/holidaycampuk"), "a page is not a group");
      HC.assert(!isFacebookGroup("https://www.instagram.com/groups/x"), "instagram /groups/ is not a facebook group");
      HC.assert(!isFacebookGroup(""), "empty string is not a group");
      HC.assert(!isFacebookGroup("not a url"), "garbage is not a group");
    });

    // sameLink canonicalisation: trailing slash / scheme / www must not fool it.
    check("Link equality canonicalises scheme, www and trailing slash", function () {
      HC.assert(sameLink("https://www.facebook.com/groups/x/", "facebook.com/groups/x"),
        "equivalent URLs should compare equal");
      HC.assert(!sameLink("https://facebook.com/groups/x", "https://facebook.com/groups/y"),
        "different group ids should not compare equal");
    });

    /* ---- Join / persistence logic (mock 'joined' state via HC.store) ---- */
    check("Joining the community group records membership and persists via HC.store", function () {
      // Snapshot current store so the test is non-destructive.
      var snapshot = null;
      try { snapshot = HC.store.get(STORE_KEY, null); } catch (e) { snapshot = null; }
      try {
        // Start clean.
        saveState(reset());
        var s0 = loadState();
        HC.assert(s0.joined === false, "fresh state should be 'not joined'");

        var s1 = markJoined(s0);
        HC.assert(s1.joined === true, "markJoined should set joined=true");
        HC.assert(typeof s1.joinedAt === "number", "joinedAt should be stamped");
        var ok = saveState(s1);
        HC.assert(ok, "saveState should succeed");

        var reread = loadState();
        HC.assert(reread.joined === true, "joined-state must persist via HC.store");

        // Idempotent: joining again keeps the original timestamp.
        var s2 = markJoined(reread);
        HC.assert(s2.joinedAt === reread.joinedAt, "re-joining must not reset joinedAt");
      } finally {
        // Restore the user's real state.
        try {
          if (snapshot === null) HC.store.set(STORE_KEY, reset());
          else HC.store.set(STORE_KEY, snapshot);
        } catch (e) { /* best effort */ }
      }
    });

    // Dismiss logic: a provider can dismiss the prompt without joining.
    check("Provider can dismiss the prompt without joining", function () {
      var d = markDismissed(reset());
      HC.assert(d.dismissed === true, "dismiss should set dismissed=true");
      HC.assert(d.joined === false, "dismiss should not imply joined");
    });

    return { pass: pass, fail: fail, log: log };
  }

  /* ============================================================
   * 7. Registration — defensive; never throws at load time.
   * ============================================================ */

  HC.registerFeature({
    id: "provider-facebook-community",
    title: "Provider community group",
    side: "provider",
    icon: "📘",
    summary: "Surfaces a CTA to the private provider Facebook community group — " +
      "a space for camp organisers to swap advice and support, separate from " +
      "the public parent-facing pages.",
    render: render,
    selfTest: selfTest
  });
})();
