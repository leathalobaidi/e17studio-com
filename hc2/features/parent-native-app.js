/* HolidayCamp feature: parent-native-app
 * ------------------------------------------------------------------
 * Replicates Happity's "native mobile app" offering, reframed for
 * SCHOOL-AGE HOLIDAY CAMPS.
 *
 * Evidence (Happity support corpus):
 *  - Article 8255771 "Parents & Carers FAQs - Happity Newsletters,
 *    apps and updates", section "Do you have an app?":
 *      "Yes! You can find the Happity App for Android in your app
 *       store and we are looking into the possibility of releasing an
 *       Apple version in the future."
 *
 * So the real-world behaviour is:
 *   - There IS a native app, and it is AVAILABLE on Android (Google Play).
 *   - There is NOT (yet) an iOS app — it is "coming soon" / being looked into.
 *   - The native app is distinct from the responsive website (which works
 *     on any phone browser).
 *
 * Acceptance criterion (asserted in selfTest):
 *   App-store presence is represented: a discoverable Android app entry
 *   (installable / linkable) AND a 'coming soon' state for iOS. A
 *   'Get the app' surface links to / represents the native Android app
 *   distinct from the responsive website.
 *
 * Logic modelled (and exercised by selfTest):
 *   - A catalogue of app-store entries keyed by platform. Android is
 *     LIVE (has a store URL, isInstallable === true); iOS is COMING SOON
 *     (no store URL, isInstallable === false, allows "notify me").
 *   - Platform detection from a user-agent string -> recommended action.
 *   - getAppCta(ua): for Android returns an INSTALL cta pointing at the
 *     native app; for iOS returns a NOTIFY cta; for desktop/other returns
 *     a WEBSITE cta (use the responsive site).
 *   - The native Android entry is DISTINCT from the website surface
 *     (different `surface` value, different URL host).
 *   - iOS "notify me" registers an interest record (persisted via
 *     HC.store) and is idempotent per email.
 *   - "Continue on website" records that the user opted to use the
 *     responsive site instead — proving the two surfaces are distinct.
 *
 * Defensive: nothing throws at registration time. Persistence is via
 * HC.store only (namespaced under "hc_"); no global localStorage keys.
 * ------------------------------------------------------------------ */
(function () {
  "use strict";

  if (typeof window === "undefined" || !window.HC ||
      typeof window.HC.registerFeature !== "function") {
    // Core not present — fail silently rather than throwing.
    return;
  }
  var HC = window.HC;

  var STORE_KEY = "native_app_v1"; // { iosWaitlist:[{email,ts}], surfaceChoice, installs:[] }

  /* ============================================================
   * 1. App-store catalogue (static product facts).
   *
   * Mirrors Happity's stated reality: Android live, iOS coming soon,
   * both distinct from the responsive website. Reframed copy for
   * school-age HOLIDAY CAMPS.
   * ============================================================ */
  var APP_NAME = "HolidayCamp";
  var WEBSITE_URL = "https://holidaycamp.co.uk";

  var STORE_ENTRIES = {
    android: {
      platform: "android",
      label: "Android",
      store: "Google Play",
      surface: "native-app",            // distinct from "website"
      status: "live",
      isInstallable: true,
      // A discoverable, linkable store entry (the acceptance criterion).
      storeUrl: "https://play.google.com/store/apps/details?id=co.uk.holidaycamp.app",
      rating: 4.7,
      icon: "🤖",
      blurb: "Get holiday-camp alerts, one-tap rebooking and your child's " +
             "camp passes in the native Android app."
    },
    ios: {
      platform: "ios",
      label: "iPhone & iPad",
      store: "App Store",
      surface: "native-app",
      status: "coming-soon",            // "looking into the possibility"
      isInstallable: false,
      storeUrl: null,                   // no live store entry yet
      rating: null,
      icon: "🍏",
      blurb: "An Apple version is on the way. Pop your email in and we'll " +
             "tell you the moment the iPhone app lands."
    }
  };

  // The responsive website is a SEPARATE surface — works on any phone
  // browser, no install. This is what makes the native app "distinct".
  var WEBSITE_SURFACE = {
    platform: "web",
    label: "Any phone browser",
    store: null,
    surface: "website",                 // <-- distinct from "native-app"
    status: "live",
    isInstallable: false,
    storeUrl: WEBSITE_URL,
    icon: "🌐",
    blurb: "No app needed — the full HolidayCamp site works on any phone, " +
           "tablet or laptop browser."
  };

  /* ============================================================
   * 2. Platform detection + recommended call-to-action.
   * ============================================================ */
  function detectPlatform(ua) {
    var s = String(ua == null ? "" : ua).toLowerCase();
    if (/android/.test(s)) return "android";
    if (/iphone|ipad|ipod|ios/.test(s)) return "ios";
    return "other"; // desktop / unknown -> steer to responsive website
  }

  // The core of the feature's logic: given a device, what do we offer?
  // - Android  -> INSTALL the native app (distinct from website).
  // - iOS      -> NOTIFY (coming soon), meanwhile use the website.
  // - other    -> WEBSITE (responsive site).
  function getAppCta(ua) {
    var platform = detectPlatform(ua);
    if (platform === "android") {
      var a = STORE_ENTRIES.android;
      return {
        platform: "android",
        action: "install",
        surface: a.surface,            // "native-app"
        label: "Get it on " + a.store,
        url: a.storeUrl,
        installable: true
      };
    }
    if (platform === "ios") {
      var i = STORE_ENTRIES.ios;
      return {
        platform: "ios",
        action: "notify",             // coming-soon path
        surface: i.surface,
        label: "Notify me when the iPhone app is ready",
        url: null,
        installable: false
      };
    }
    return {
      platform: "other",
      action: "website",
      surface: WEBSITE_SURFACE.surface, // "website"
      label: "Open the responsive website",
      url: WEBSITE_SURFACE.storeUrl,
      installable: false
    };
  }

  /* ============================================================
   * 3. Persistence helpers (HC.store only).
   * ============================================================ */
  function readState() {
    var st = {};
    try { st = HC.store.get(STORE_KEY, {}) || {}; } catch (e) { st = {}; }
    return {
      iosWaitlist: Array.isArray(st.iosWaitlist) ? st.iosWaitlist : [],
      installs: Array.isArray(st.installs) ? st.installs : [],
      surfaceChoice: st.surfaceChoice || null
    };
  }
  function writeState(st) {
    try { return HC.store.set(STORE_KEY, st); } catch (e) { return false; }
  }

  function isValidEmail(email) {
    return typeof email === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  }

  // iOS "notify me" — idempotent per email. Returns the resulting record.
  function joinIosWaitlist(email) {
    var entry = String(email == null ? "" : email).trim().toLowerCase();
    if (!isValidEmail(entry)) {
      return { ok: false, reason: "invalid-email", count: readState().iosWaitlist.length };
    }
    var st = readState();
    var already = st.iosWaitlist.some(function (w) { return w.email === entry; });
    if (!already) {
      st.iosWaitlist.push({ email: entry, ts: Date.now() });
      writeState(st);
    }
    return { ok: true, duplicate: already, count: st.iosWaitlist.length, email: entry };
  }

  // Record that the user "installed" the Android app (mock telemetry) —
  // and confirm it targeted the native-app surface, not the website.
  function recordInstall(ua) {
    var cta = getAppCta(ua);
    if (cta.action !== "install") {
      return { ok: false, reason: "not-android", surface: cta.surface };
    }
    var st = readState();
    st.installs.push({ platform: cta.platform, surface: cta.surface, ts: Date.now() });
    writeState(st);
    return { ok: true, surface: cta.surface, url: cta.url, count: st.installs.length };
  }

  // Record the user choosing the responsive website instead of the app.
  function chooseWebsite() {
    var st = readState();
    st.surfaceChoice = "website";
    writeState(st);
    return { ok: true, surface: "website", url: WEBSITE_URL };
  }

  /* ============================================================
   * 4. Render (mock UI: a 'Get the app' surface).
   * ============================================================ */
  function render(mountEl) {
    try {
      var el = HC.util.el;
      mountEl.innerHTML = "";

      var wrap = el("div", { style: "font-family:'Nunito Sans',system-ui,sans-serif;color:var(--text,#383838)" });

      wrap.appendChild(el("p", {
        style: "font-size:14px;margin:0 0 14px"
      }, "Take HolidayCamp with you. The native app is the fastest way to " +
         "catch new holiday-camp drops, rebook last summer's favourites and " +
         "show your child's camp pass at the door."));

      // --- "Get the app" surface: store badges ---
      var grid = el("div", {
        style: "display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:16px"
      });

      // Android badge — LIVE, installable, distinct native-app surface.
      var a = STORE_ENTRIES.android;
      var androidCard = el("div", {
        style: "border:1.5px solid var(--line,#E6E6E6);border-radius:16px;padding:16px;background:#fff"
      });
      androidCard.appendChild(el("div", { style: "font-size:28px" }, a.icon));
      androidCard.appendChild(el("div", {
        style: "font-family:'Quicksand',system-ui,sans-serif;font-weight:700;color:var(--purple,#603488);font-size:16px;margin-top:4px"
      }, "HolidayCamp for " + a.label));
      androidCard.appendChild(el("div", {
        style: "font-size:12px;color:#2f7d4f;font-weight:700;margin:2px 0 6px"
      }, "★ " + a.rating + " · Available now on " + a.store));
      androidCard.appendChild(el("p", { style: "font-size:13px;margin:0 0 10px" }, a.blurb));
      var installBtn = el("button", {
        class: "hc-btn", type: "button",
        "data-surface": a.surface,
        "data-url": a.storeUrl
      }, "Get it on " + a.store);
      installBtn.addEventListener("click", function () {
        var r = recordInstall("Mozilla/5.0 (Linux; Android 14)");
        HC.util.toast(r.ok
          ? "Opening " + a.store + " (native app · " + r.surface + ")"
          : "Install only available on Android");
      });
      androidCard.appendChild(installBtn);
      grid.appendChild(androidCard);

      // iOS badge — COMING SOON, not installable, notify-me path.
      var i = STORE_ENTRIES.ios;
      var iosCard = el("div", {
        style: "border:1.5px dashed var(--line,#E6E6E6);border-radius:16px;padding:16px;background:var(--purple-tint,#F0E8F4)"
      });
      iosCard.appendChild(el("div", { style: "font-size:28px;opacity:.8" }, i.icon));
      iosCard.appendChild(el("div", {
        style: "font-family:'Quicksand',system-ui,sans-serif;font-weight:700;color:var(--purple,#603488);font-size:16px;margin-top:4px"
      }, "HolidayCamp for " + i.label));
      iosCard.appendChild(el("div", {
        style: "display:inline-block;font-size:11px;font-weight:700;color:var(--magenta,#F82488);background:#fff;border-radius:999px;padding:2px 10px;margin:2px 0 6px"
      }, "COMING SOON"));
      iosCard.appendChild(el("p", { style: "font-size:13px;margin:0 0 10px" }, i.blurb));

      var emailInput = el("input", {
        type: "email", placeholder: "you@example.com",
        style: "width:100%;box-sizing:border-box;border:1.5px solid var(--line,#E6E6E6);border-radius:10px;padding:8px 10px;font-size:13px;margin-bottom:8px"
      });
      var notifyBtn = el("button", { class: "hc-btn hc-btn-ghost", type: "button" }, "Notify me");
      notifyBtn.addEventListener("click", function () {
        var r = joinIosWaitlist(emailInput.value);
        if (!r.ok) { HC.util.toast("Please enter a valid email"); return; }
        HC.util.toast(r.duplicate
          ? "You're already on the iPhone waitlist"
          : "We'll email you when the iPhone app lands (" + r.count + " waiting)");
        renderWaitlistCount();
      });
      iosCard.appendChild(emailInput);
      iosCard.appendChild(notifyBtn);
      var waitCount = el("div", { style: "font-size:11px;color:var(--muted,#808080);margin-top:6px" });
      iosCard.appendChild(waitCount);
      grid.appendChild(iosCard);

      wrap.appendChild(grid);

      function renderWaitlistCount() {
        var n = readState().iosWaitlist.length;
        waitCount.textContent = n ? (n + " parent" + (n === 1 ? "" : "s") + " waiting for the iPhone app") : "";
      }
      renderWaitlistCount();

      // --- Distinct website surface ---
      var webRow = el("div", {
        style: "border-top:1px solid var(--line,#E6E6E6);padding-top:14px;display:flex;align-items:center;gap:10px;flex-wrap:wrap"
      });
      webRow.appendChild(el("div", { style: "font-size:22px" }, WEBSITE_SURFACE.icon));
      webRow.appendChild(el("div", {
        style: "flex:1;min-width:180px;font-size:13px"
      }, "<strong>Prefer not to install?</strong> " + WEBSITE_SURFACE.blurb));
      var webBtn = el("button", { class: "hc-btn hc-btn-ghost", type: "button", "data-surface": "website" },
        "Continue on the website");
      webBtn.addEventListener("click", function () {
        var r = chooseWebsite();
        HC.util.toast("Staying on the responsive website (" + r.surface + ")");
      });
      webRow.appendChild(webBtn);
      wrap.appendChild(webRow);

      // --- "What we'd recommend on this device" (live detection demo) ---
      var detected = getAppCta(navigator && navigator.userAgent);
      wrap.appendChild(el("p", {
        style: "font-size:12px;color:var(--muted,#808080);margin-top:14px"
      }, "On this device we'd point you to: <strong>" +
         (detected.action === "install" ? "the native Android app"
            : detected.action === "notify" ? "the iPhone waitlist (coming soon)"
            : "the responsive website") + "</strong>."));

      mountEl.appendChild(wrap);
    } catch (e) {
      mountEl.innerHTML = '<p style="color:#9a1f5e">Could not render: ' +
        (e && e.message ? e.message : String(e)) + "</p>";
    }
  }

  /* ============================================================
   * 5. selfTest — exercises the LOGIC and asserts the criterion.
   * ============================================================ */
  function selfTest() {
    var pass = 0, fail = 0, log = [];
    function check(label, fn) {
      try { fn(); pass += 1; log.push("✓ " + label); }
      catch (e) { fail += 1; log.push("✗ " + label + " — " + (e && e.message ? e.message : String(e))); }
    }

    // Clean slate for deterministic counts.
    try { HC.store.set(STORE_KEY, {}); } catch (e) {}

    // --- ACCEPTANCE: a discoverable Android app entry exists ---
    check("Android store entry is discoverable & installable", function () {
      var a = STORE_ENTRIES.android;
      HC.assert(a && a.status === "live", "Android entry should be live");
      HC.assert(a.isInstallable === true, "Android app must be installable");
      HC.assert(typeof a.storeUrl === "string" && /play\.google\.com/.test(a.storeUrl),
        "Android entry must have a Google Play store URL, got " + a.storeUrl);
    });

    // --- ACCEPTANCE: iOS is a 'coming soon' state ---
    check("iOS entry is a 'coming soon' state (not yet installable)", function () {
      var i = STORE_ENTRIES.ios;
      HC.assert(i && i.status === "coming-soon", "iOS entry should be coming-soon");
      HC.assert(i.isInstallable === false, "iOS app must NOT be installable yet");
      HC.assert(i.storeUrl === null, "iOS should have no live store URL");
    });

    // --- ACCEPTANCE: native app surface is DISTINCT from the website ---
    check("Native app surface is distinct from the responsive website", function () {
      HC.assert(STORE_ENTRIES.android.surface === "native-app",
        "Android should be on the native-app surface");
      HC.assert(WEBSITE_SURFACE.surface === "website",
        "Website should be on the website surface");
      HC.assert(STORE_ENTRIES.android.surface !== WEBSITE_SURFACE.surface,
        "native-app and website must be different surfaces");
      // Different URL host proves they are different destinations.
      HC.assert(STORE_ENTRIES.android.storeUrl.indexOf("play.google.com") !== -1 &&
        WEBSITE_SURFACE.storeUrl.indexOf("play.google.com") === -1,
        "app store URL and website URL must differ");
    });

    // --- platform detection routes correctly ---
    check("detectPlatform maps Android / iOS / desktop UAs", function () {
      HC.assert(detectPlatform("Mozilla/5.0 (Linux; Android 14; Pixel 8)") === "android", "android UA");
      HC.assert(detectPlatform("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)") === "ios", "iphone UA");
      HC.assert(detectPlatform("Mozilla/5.0 (iPad; CPU OS 17_0)") === "ios", "ipad UA");
      HC.assert(detectPlatform("Mozilla/5.0 (Macintosh; Intel Mac OS X)") === "other", "desktop UA");
      HC.assert(detectPlatform("") === "other", "empty UA falls back to other");
    });

    check("Android device gets an INSTALL cta on the native-app surface", function () {
      var cta = getAppCta("Mozilla/5.0 (Linux; Android 14)");
      HC.assert(cta.action === "install", "expected install, got " + cta.action);
      HC.assert(cta.surface === "native-app", "expected native-app surface");
      HC.assert(cta.installable === true, "Android cta should be installable");
      HC.assert(/play\.google\.com/.test(cta.url), "install cta should link to Google Play");
    });

    check("iOS device gets a NOTIFY (coming soon) cta, not an install", function () {
      var cta = getAppCta("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)");
      HC.assert(cta.action === "notify", "expected notify, got " + cta.action);
      HC.assert(cta.installable === false, "iOS cta must not be installable");
      HC.assert(cta.url === null, "iOS notify cta has no store URL yet");
    });

    check("Desktop / other device is steered to the responsive website", function () {
      var cta = getAppCta("Mozilla/5.0 (Macintosh; Intel Mac OS X)");
      HC.assert(cta.action === "website", "expected website cta");
      HC.assert(cta.surface === "website", "expected website surface");
      HC.assert(cta.url === WEBSITE_URL, "website cta points at the responsive site");
    });

    // --- iOS waitlist logic: registers + idempotent + validates ---
    check("iOS 'notify me' rejects an invalid email", function () {
      var r = joinIosWaitlist("not-an-email");
      HC.assert(r.ok === false && r.reason === "invalid-email", "should reject bad email");
      HC.assert(readState().iosWaitlist.length === 0, "nothing should be stored");
    });

    check("iOS 'notify me' registers a valid email (persisted via HC.store)", function () {
      var r = joinIosWaitlist("Parent@Example.com");
      HC.assert(r.ok === true && r.duplicate === false, "first join should succeed");
      HC.assert(r.count === 1, "expected 1 on waitlist, got " + r.count);
      var stored = HC.store.get(STORE_KEY, {});
      HC.assert(stored.iosWaitlist[0].email === "parent@example.com",
        "email should be stored normalised/lowercased");
    });

    check("iOS waitlist is idempotent per email (no duplicate)", function () {
      var r = joinIosWaitlist("parent@example.com"); // same email, different case handled
      HC.assert(r.ok === true && r.duplicate === true, "second join should be a duplicate");
      HC.assert(r.count === 1, "count should stay at 1, got " + r.count);
      var r2 = joinIosWaitlist("another@example.com");
      HC.assert(r2.count === 2, "a different email grows the list to 2, got " + r2.count);
    });

    // --- install telemetry only fires for the native Android surface ---
    check("recordInstall only succeeds for Android and tags native-app surface", function () {
      var ok = recordInstall("Mozilla/5.0 (Linux; Android 14)");
      HC.assert(ok.ok === true && ok.surface === "native-app", "Android install should record native-app");
      var bad = recordInstall("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)");
      HC.assert(bad.ok === false && bad.reason === "not-android", "iOS cannot 'install' the native app");
    });

    // --- choosing the website proves the two surfaces coexist & differ ---
    check("Choosing the website records the 'website' surface choice", function () {
      var r = chooseWebsite();
      HC.assert(r.ok === true && r.surface === "website", "should record website choice");
      HC.assert(HC.store.get(STORE_KEY, {}).surfaceChoice === "website",
        "surfaceChoice should persist as 'website'");
    });

    // Tidy up so we don't leave demo state behind.
    try { HC.store.set(STORE_KEY, {}); } catch (e) {}

    return { pass: pass, fail: fail, log: log };
  }

  /* ============================================================
   * 6. Register.
   * ============================================================ */
  HC.registerFeature({
    id: "parent-native-app",
    title: "Get the app (native Android, iOS coming soon)",
    side: "parent",
    icon: "📱",
    summary: "A 'Get the app' surface representing the native Android app " +
             "(live on Google Play) and an iOS 'coming soon' waitlist — " +
             "both distinct from the responsive holiday-camp website.",
    render: render,
    selfTest: selfTest
  });
})();
