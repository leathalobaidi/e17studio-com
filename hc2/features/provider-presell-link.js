/* HolidayCamp feature — provider-presell-link
 *
 * Pre-sell via hidden booking link  (provider side)
 *
 * Replicates Happity's "How to pre-sell your classes" (support article
 * 4518631). Pre-sales let a provider open bookings to their EXISTING
 * customers before the general public, using a HIDDEN listing and a
 * shareable "Booking Link".
 *
 * Faithful to the evidence (article 4518631):
 *   §1 "'Hidden' mode … remove it from all of the public facing pages …
 *       This will also stop the site from submitting your class info to
 *       Google."  -> a camp can be set Hidden: off the public directory
 *       and off search-engine submission, but still bookable by link.
 *   §2 "Get your booking link … Click the Booking Link button to get your
 *       link. Copy and paste this into your WhatsApp groups / email
 *       newsletter and send to your existing customers."  -> a 'Booking
 *       Link' button copies a shareable URL.
 *   §3/§4 "Who/When to email … reward loyalty amongst your existing
 *       customers … before the new term begins."  -> the link is for
 *       existing customers, BEFORE the public launch date.
 *   Top tip: "only sell block / term tickets in the pre-sale initially."
 *       -> a pre-sale can be restricted to term/block tickets only.
 *
 * ACCEPTANCE CRITERION (asserted in selfTest):
 *   A 'Booking Link' copies a shareable URL to sell to existing customers
 *   before public launch. We verify the link is generated for a hidden
 *   camp, carries a pre-sale token, resolves as bookable while the camp is
 *   hidden / pre-public, is NOT in the public directory before launch, and
 *   that the copy action returns the exact URL it put on the clipboard.
 *
 * Framed for SCHOOL-AGE HOLIDAY CAMPS (summer term places), not baby
 * classes. Self-contained, defensive, no imports/exports. Persistence is
 * via HC.store only. Calls HC.registerFeature at top level and never throws
 * at registration time.
 */
(function () {
  "use strict";

  // Defensive: never throw at module load if HC core isn't present.
  if (typeof window === "undefined" || !window.HC || typeof window.HC.registerFeature !== "function") {
    if (typeof console !== "undefined" && console.warn) {
      console.warn("[HC] provider-presell-link: HC core not found; skipping registration.");
    }
    return;
  }

  var HC = window.HC;

  var STORE_KEY = "provider_presell";  // { [providerId]: presaleObj }
  var TODAY_ISO = "2026-06-15";         // app reference "today" (deterministic)
  // Base origin for booking links. In a real app this is the public site;
  // here it is a fixed, deterministic value so the link is testable.
  var BOOKING_BASE = "https://holidaycamp.app/book";

  /* ===================================================================
     PURE LOGIC (DOM-free, testable)
     =================================================================== */

  function asText(v) {
    return typeof v === "string" ? v : (v == null ? "" : String(v));
  }

  // Strict YYYY-MM-DD validation that rejects impossible calendar dates.
  function isValidISODate(s) {
    var str = asText(s);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(str)) return false;
    var parts = str.split("-");
    var y = Number(parts[0]), m = Number(parts[1]), d = Number(parts[2]);
    if (m < 1 || m > 12 || d < 1 || d > 31) return false;
    var dt = new Date(Date.UTC(y, m - 1, d));
    return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
  }

  // A short, URL-safe, non-guessable pre-sale token (the "hidden" part of
  // the hidden link). Deterministic shape, random value.
  function makeToken() {
    var s = "";
    try {
      s = HC.util.uid();
    } catch (e) {
      s = "t" + Date.now().toString(36) + Math.random().toString(36).slice(2);
    }
    // Keep only URL-safe chars and cap the length.
    return asText(s).replace(/[^a-zA-Z0-9]/g, "").slice(0, 24) || ("t" + Date.now().toString(36));
  }

  // Build the shareable booking URL for a pre-sale. The token is what makes
  // the link work while the camp is hidden — without it the camp is not
  // publicly findable. Returns a string; never throws.
  function buildBookingLink(presale) {
    if (!presale || !presale.providerId) return "";
    var pid = encodeURIComponent(asText(presale.providerId));
    var token = encodeURIComponent(asText(presale.token));
    var url = BOOKING_BASE + "/" + pid + "?presale=" + token;
    if (presale.termOnly) url += "&tickets=term";
    return url;
  }

  // Create (or refresh) a pre-sale config for a provider. Mirrors the
  // article: a hidden listing + a launch date when it goes public + an
  // optional "term/block tickets only in pre-sale" restriction.
  // Returns { ok, errors:[...], value }.
  function buildPresale(input) {
    input = input || {};
    var errors = [];

    var providerId = asText(input.providerId).trim();
    if (!providerId) errors.push("A camp is required to make a booking link.");

    // §1 Hidden mode is what enables a pre-sale: the camp must be hidden so
    // it is off the public pages until launch.
    var hidden = input.hidden !== false; // default true for a pre-sale

    // Launch date: when the camp becomes public. Required so we can tell
    // "before public launch" from "after".
    var launch = asText(input.launch).trim();
    if (!launch) {
      errors.push("Enter the public launch date.");
    } else if (!isValidISODate(launch)) {
      errors.push("Launch date must be a real date (YYYY-MM-DD).");
    }

    var termOnly = input.termOnly === true; // top-tip: term/block only in pre-sale

    var value = null;
    if (!errors.length) {
      value = {
        providerId: providerId,
        token: input.token ? asText(input.token) : makeToken(),
        hidden: hidden,
        launch: launch,            // ISO date the camp goes public
        termOnly: termOnly,
        createdAt: TODAY_ISO
      };
      value.link = buildBookingLink(value);
    }
    return { ok: !errors.length, errors: errors, value: value };
  }

  // Is the camp still in its pre-sale window on a given date? i.e. hidden
  // and not yet at its public launch date.
  function isPreLaunch(presale, todayIso) {
    if (!presale) return false;
    var today = todayIso || TODAY_ISO;
    return today < presale.launch;
  }

  // Would this camp appear in the PUBLIC directory on a given date?
  // §1: a hidden camp is off all public-facing pages until it goes public
  // at launch. After launch (or if never hidden) it is public.
  function isPubliclyListed(presale, todayIso) {
    if (!presale) return true; // no pre-sale config = ordinary public camp
    var today = todayIso || TODAY_ISO;
    if (!presale.hidden) return true;          // not hidden -> public
    return today >= presale.launch;            // hidden -> only after launch
  }

  // Resolve a booking link the way the server would for a customer who
  // clicked it. The whole point of the hidden link: it BOOKS even while the
  // camp is hidden / pre-public, as long as the pre-sale token matches.
  // Returns { bookable:Boolean, reason:String }.
  function resolveBookingLink(presale, suppliedToken, todayIso) {
    if (!presale) return { bookable: false, reason: "no-presale" };
    var token = asText(suppliedToken);
    if (!token || token !== asText(presale.token)) {
      // No / wrong token: behaves like a member of the public hitting a
      // hidden camp before launch — not bookable yet.
      if (isPubliclyListed(presale, todayIso)) {
        return { bookable: true, reason: "public" };
      }
      return { bookable: false, reason: "hidden-no-token" };
    }
    // Correct pre-sale token: bookable now, even pre-launch / hidden.
    return {
      bookable: true,
      reason: isPreLaunch(presale, todayIso) ? "presale" : "public"
    };
  }

  /* ===================================================================
     CLIPBOARD — the "Booking Link" copy action. Returns the exact string
     it placed on the clipboard so the behaviour is testable without a real
     clipboard (the acceptance criterion: the button COPIES the URL).
     =================================================================== */

  function copyToClipboard(text) {
    var value = asText(text);
    var copied = false;
    // 1) Async Clipboard API (best effort; fire and forget — don't await).
    try {
      if (typeof navigator !== "undefined" && navigator.clipboard &&
          typeof navigator.clipboard.writeText === "function") {
        navigator.clipboard.writeText(value);
        copied = true;
      }
    } catch (e) { /* fall through to execCommand */ }
    // 2) Legacy execCommand fallback for older / non-secure contexts.
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
      } catch (e2) { /* defensive: never throw from a copy */ }
    }
    // Always return the URL we tried to copy so callers can show / test it,
    // even when no clipboard exists (e.g. under Node in selfTest).
    return { copied: copied, text: value };
  }

  /* ===================================================================
     PERSISTENCE (HC.store only)
     =================================================================== */

  function allPresales() {
    var raw = null;
    try { raw = HC.store.get(STORE_KEY, {}); } catch (e) { raw = {}; }
    return (raw && typeof raw === "object") ? raw : {};
  }

  function presaleFor(providerId) {
    var map = allPresales();
    var p = map[providerId];
    return (p && typeof p === "object") ? p : null;
  }

  function savePresaleFor(providerId, value) {
    var map = allPresales();
    if (value === null) { delete map[providerId]; }
    else { map[providerId] = value; }
    try { HC.store.set(STORE_KEY, map); return true; } catch (e) { return false; }
  }

  // Create + persist a pre-sale for a provider. Returns the build result.
  function startPresale(providerId, input) {
    input = input || {};
    input.providerId = providerId;
    var res = buildPresale(input);
    if (res.ok) savePresaleFor(providerId, res.value);
    return res;
  }

  function endPresale(providerId) {
    return savePresaleFor(providerId, null);
  }

  // Flip a saved pre-sale public (the manual "go live now" action).
  function goPublic(providerId, todayIso) {
    var p = presaleFor(providerId);
    if (!p) return false;
    p.hidden = false;
    p.launch = todayIso || TODAY_ISO; // launched today
    p.link = buildBookingLink(p);
    return savePresaleFor(providerId, p);
  }

  /* ===================================================================
     LIVE DATA — pick a real school-age camp so the preview shows a genuine
     holiday-camp name and the link uses a real provider id.
     =================================================================== */

  function firstProvider() {
    try {
      var providers = HC.data.providers || [];
      // Prefer a paid, bookable camp over the council HAF route.
      for (var i = 0; i < providers.length; i++) {
        var p = providers[i];
        if (p && p.id && p.id !== "waltham-forest-haf") return p;
      }
      if (providers.length) return providers[0];
    } catch (e) {}
    return { id: "demo-provider", name: "your holiday camp" };
  }

  // The new term's first day, from the live planner — a faithful "before the
  // new term begins" launch context.
  function termStartLabel() {
    try {
      var weeks = (HC.data.planner && HC.data.planner.weeks) || [];
      if (weeks.length && weeks[0]) return weeks[0].dates || weeks[0].label || "";
    } catch (e) {}
    return "";
  }

  /* ===================================================================
     UI — a provider "Pre-sell (hidden link)" panel: toggle hidden, set a
     public launch date, optional term/block-only, then a 'Booking Link'
     button that copies the shareable URL.
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
      var termDates = termStartLabel();

      mountEl.innerHTML =
        '<div style="font-family:\'Nunito Sans\',system-ui,sans-serif;color:var(--text,#383838)">' +
          '<p style="font-size:14px;margin:0 0 14px">Provider dashboard → <strong>My Classes › Registers › Booking Link</strong>. ' +
          'Open bookings for <strong>' + esc(providerName) + '</strong> to your existing customers ' +
          '<strong>before the public launch</strong>. Set the camp to <strong>Hidden</strong> (off the public ' +
          'directory and off search engines), then copy the <strong>Booking Link</strong> into your WhatsApp ' +
          'group or email newsletter.' +
          (termDates ? ' New term starts <strong>' + esc(termDates) + '</strong>.' : "") + '</p>' +

          // --- Set-up panel ---
          '<div style="border:1.5px solid var(--line,#E6E6E6);border-radius:14px;padding:14px 16px;margin-bottom:16px">' +
            '<div style="font-family:\'Quicksand\',system-ui,sans-serif;font-weight:700;color:var(--purple,#603488);font-size:15px;margin-bottom:10px">Set up your pre-sale</div>' +

            '<label style="display:flex;align-items:center;gap:8px;font-size:13.5px;margin-bottom:10px;cursor:pointer">' +
              '<input id="ppHidden" type="checkbox" checked style="width:16px;height:16px">' +
              '<span><strong>Hidden mode</strong> — remove this camp from the public Happity-style listings and from Google until launch.</span>' +
            '</label>' +

            '<label style="display:block;font-weight:700;font-size:12.5px;margin-bottom:3px">Public launch date</label>' +
            '<input id="ppLaunch" type="date" value="2026-06-22" ' +
              'style="width:100%;padding:9px;border:1.5px solid var(--line,#E6E6E6);border-radius:12px;font-size:14px;margin-bottom:10px">' +

            '<label style="display:flex;align-items:center;gap:8px;font-size:13.5px;margin-bottom:12px;cursor:pointer">' +
              '<input id="ppTermOnly" type="checkbox" style="width:16px;height:16px">' +
              '<span><strong>Term / block tickets only</strong> in the pre-sale (top tip: sell the bulk in advance and save on fees).</span>' +
            '</label>' +

            '<button id="ppMake" type="button" class="hc-btn">Get booking link</button>' +
            '<div id="ppErr" style="font-size:12.5px;color:#9a1f5e;margin-top:8px;min-height:14px"></div>' +
          '</div>' +

          // --- Link panel (filled after generation) ---
          '<div id="ppLinkPanel"></div>' +
        '</div>';

      var $ = function (id) { return mountEl.querySelector("#" + id); };

      function renderLinkPanel() {
        var host = $("ppLinkPanel");
        if (!host) return;
        var presale = presaleFor(providerId);
        if (!presale) {
          host.innerHTML = '<p style="color:var(--muted,#808080);font-size:13px;margin:0">' +
            'No booking link yet. Set up your pre-sale above and press <strong>Get booking link</strong>.</p>';
          return;
        }

        var link = presale.link || buildBookingLink(presale);
        var preLaunch = isPreLaunch(presale, TODAY_ISO);
        var listed = isPubliclyListed(presale, TODAY_ISO);
        var statusTxt = listed
          ? '<span style="color:#2f7d4f">Public — listed for everyone</span>'
          : '<span style="color:var(--magenta,#F82488)">Hidden — pre-sale only until ' + esc(presale.launch) + '</span>';

        host.innerHTML =
          '<div style="font-family:\'Quicksand\',system-ui,sans-serif;font-weight:700;color:var(--purple,#603488);font-size:15px;margin:0 0 8px">Your booking link</div>' +
          '<div style="border:1.5px solid var(--line,#E6E6E6);border-radius:12px;padding:12px 14px">' +
            '<div style="font-size:12px;color:var(--muted,#808080);margin-bottom:6px">' + statusTxt +
              (presale.termOnly ? ' · <span style="color:var(--purple,#603488)">term/block only</span>' : "") + '</div>' +
            '<input id="ppLinkInput" type="text" readonly value="' + escAttr(link) + '" ' +
              'style="width:100%;padding:9px;border:1.5px solid var(--line,#E6E6E6);border-radius:12px;font-size:13px;background:#FAFAFA;margin-bottom:10px" ' +
              'onclick="this.select()">' +
            '<div style="display:flex;gap:8px;flex-wrap:wrap">' +
              '<button id="ppCopy" type="button" class="hc-btn">📋 Copy booking link</button>' +
              (preLaunch
                ? '<button id="ppGoPublic" type="button" class="hc-btn hc-btn-ghost">Go public now</button>'
                : "") +
              '<button id="ppEnd" type="button" class="hc-btn hc-btn-ghost">Remove link</button>' +
            '</div>' +
            '<p style="font-size:12px;color:var(--muted,#808080);margin:10px 0 0">' +
              'Paste this into your WhatsApp group or email newsletter and send to your existing customers. ' +
              'It books even while the camp is hidden — the public will only see it from ' + esc(presale.launch) + '.</p>' +
          '</div>';

        var copyBtn = $("ppCopy");
        if (copyBtn) copyBtn.addEventListener("click", function () {
          var res = copyToClipboard(link);
          try { HC.util.toast(res.copied ? "Booking link copied to clipboard" : "Select the link and copy it"); } catch (e) {}
          var input = $("ppLinkInput");
          if (input) { try { input.focus(); input.select(); } catch (e) {} }
        });

        var goBtn = $("ppGoPublic");
        if (goBtn) goBtn.addEventListener("click", function () {
          goPublic(providerId, TODAY_ISO);
          try { HC.util.toast("Camp is now public"); } catch (e) {}
          renderLinkPanel();
        });

        var endBtn = $("ppEnd");
        if (endBtn) endBtn.addEventListener("click", function () {
          endPresale(providerId);
          try { HC.util.toast("Booking link removed"); } catch (e) {}
          renderLinkPanel();
        });
      }

      $("ppMake").addEventListener("click", function () {
        var res = startPresale(providerId, {
          hidden: $("ppHidden").checked,
          launch: $("ppLaunch").value,
          termOnly: $("ppTermOnly").checked
        });
        if (res.ok) {
          $("ppErr").textContent = "";
          try { HC.util.toast("Booking link ready"); } catch (e) {}
          renderLinkPanel();
        } else {
          $("ppErr").innerHTML = res.errors.map(esc).join("<br>");
        }
      });

      renderLinkPanel();
    } catch (e) {
      mountEl.innerHTML = '<p style="color:#9a1f5e">Pre-sell panel failed to load: ' +
        esc(e && e.message ? e.message : String(e)) + "</p>";
    }
  }

  /* ===================================================================
     SELF-TEST — exercises the LOGIC and asserts the acceptance criterion.
     Uses an isolated in-memory provider id so it never disturbs real data.
     =================================================================== */

  function selfTest() {
    var pass = 0, fail = 0, log = [];
    function check(label, fn) {
      try { fn(); pass += 1; log.push("✓ " + label); }
      catch (e) { fail += 1; log.push("✗ " + label + " — " + (e && e.message ? e.message : String(e))); }
    }

    // --- ACCEPTANCE: a 'Booking Link' copies a shareable URL to sell to
    //     existing customers before public launch. ---
    check("Booking Link is generated for a hidden, pre-launch camp", function () {
      var res = buildPresale({ providerId: "ymca-y-kidz", hidden: true, launch: "2026-06-22" });
      HC.assert(res.ok === true, "pre-sale should build; errors: " + res.errors.join("; "));
      HC.assert(res.value.hidden === true, "camp should be hidden for a pre-sale");
      HC.assert(typeof res.value.link === "string" && res.value.link.length > 0, "a link string should be produced");
      HC.assert(res.value.link.indexOf("ymca-y-kidz") !== -1, "link should target the real provider id");
      HC.assert(/presale=/.test(res.value.link), "link must carry a pre-sale token, got " + res.value.link);
      HC.assert(res.value.link.indexOf(res.value.token) !== -1, "link must contain the token value");
    });

    check("Copying the Booking Link returns the exact shareable URL", function () {
      var res = buildPresale({ providerId: "ymca-y-kidz", hidden: true, launch: "2026-06-22" });
      var copied = copyToClipboard(res.value.link);
      HC.assert(copied.text === res.value.link, "clipboard text must equal the booking link");
      HC.assert(/^https:\/\//.test(copied.text), "shareable URL must be an absolute https link, got " + copied.text);
      HC.assert(copied.text.indexOf("presale=" + res.value.token) !== -1, "copied URL must carry the pre-sale token");
    });

    check("The link sells to existing customers BEFORE public launch", function () {
      var p = buildPresale({ providerId: "p1", hidden: true, launch: "2026-06-22" }).value;
      // A customer with the link, the day before launch, can book.
      var before = resolveBookingLink(p, p.token, "2026-06-21");
      HC.assert(before.bookable === true, "token holder should be able to book pre-launch");
      HC.assert(before.reason === "presale", "pre-launch booking reason should be 'presale', got " + before.reason);
      // It is still bookable for them on launch day too.
      var onDay = resolveBookingLink(p, p.token, "2026-06-22");
      HC.assert(onDay.bookable === true, "token holder should still book on/after launch");
    });

    check("Before launch the camp is NOT in the public directory", function () {
      var p = buildPresale({ providerId: "p1", hidden: true, launch: "2026-06-22" }).value;
      HC.assert(isPubliclyListed(p, "2026-06-21") === false, "hidden camp must be off public listings pre-launch");
      HC.assert(isPreLaunch(p, "2026-06-21") === true, "should report pre-launch the day before");
      // The public (no token) cannot book it yet.
      var publicHit = resolveBookingLink(p, "", "2026-06-21");
      HC.assert(publicHit.bookable === false, "the public should not be able to book a hidden pre-launch camp");
      HC.assert(publicHit.reason === "hidden-no-token", "reason should be 'hidden-no-token', got " + publicHit.reason);
    });

    check("After launch the camp goes public for everyone", function () {
      var p = buildPresale({ providerId: "p1", hidden: true, launch: "2026-06-22" }).value;
      HC.assert(isPubliclyListed(p, "2026-06-22") === true, "camp should be public on launch day");
      HC.assert(isPubliclyListed(p, "2026-07-01") === true, "camp should stay public after launch");
      // Even the public (no token) can book once it's live.
      var publicHit = resolveBookingLink(p, "", "2026-06-22");
      HC.assert(publicHit.bookable === true, "the public should book once it's launched");
      HC.assert(publicHit.reason === "public", "reason should be 'public' after launch");
    });

    check("A wrong token cannot book a hidden pre-launch camp", function () {
      var p = buildPresale({ providerId: "p1", hidden: true, launch: "2026-06-22" }).value;
      var bad = resolveBookingLink(p, "not-the-real-token", "2026-06-21");
      HC.assert(bad.bookable === false, "a guessed/wrong token must not unlock the pre-sale");
    });

    // --- Tokens are non-trivial and per-camp unique. ---
    check("Each pre-sale gets its own unguessable token", function () {
      var a = buildPresale({ providerId: "a", hidden: true, launch: "2026-06-22" }).value;
      var b = buildPresale({ providerId: "b", hidden: true, launch: "2026-06-22" }).value;
      HC.assert(a.token && a.token.length >= 8, "token should be reasonably long, got " + a.token);
      HC.assert(/^[a-zA-Z0-9]+$/.test(a.token), "token should be URL-safe alphanumeric");
      HC.assert(a.token !== b.token, "two pre-sales should not share a token");
    });

    // --- Top tip: term/block-only pre-sale is reflected in the link. ---
    check("Term/block-only pre-sale marks the booking link", function () {
      var p = buildPresale({ providerId: "p1", hidden: true, launch: "2026-06-22", termOnly: true }).value;
      HC.assert(p.termOnly === true, "termOnly flag should be stored");
      HC.assert(/tickets=term/.test(p.link), "term-only link should carry tickets=term, got " + p.link);
      var p2 = buildPresale({ providerId: "p2", hidden: true, launch: "2026-06-22", termOnly: false }).value;
      HC.assert(/tickets=term/.test(p2.link) === false, "non-term-only link should not carry tickets=term");
    });

    // --- Validation: launch date required + must be real. ---
    check("Launch date is required and must be a real date", function () {
      HC.assert(buildPresale({ providerId: "p1", launch: "" }).ok === false, "missing launch date must fail");
      HC.assert(buildPresale({ providerId: "p1", launch: "2026-02-30" }).ok === false, "impossible date must fail");
      HC.assert(buildPresale({ providerId: "", launch: "2026-06-22" }).ok === false, "missing camp must fail");
    });

    // --- A non-hidden camp is simply public (no pre-sale gating). ---
    check("A non-hidden listing is public regardless of launch date", function () {
      var p = buildPresale({ providerId: "p1", hidden: false, launch: "2099-01-01" }).value;
      HC.assert(p.hidden === false, "hidden flag should be false");
      HC.assert(isPubliclyListed(p, "2026-06-15") === true, "a non-hidden camp is always publicly listed");
    });

    // --- A camp with NO pre-sale config behaves as an ordinary public camp. ---
    check("A camp with no pre-sale is treated as ordinary/public", function () {
      HC.assert(isPubliclyListed(null, "2026-06-15") === true, "no pre-sale = public");
      HC.assert(resolveBookingLink(null, "x", "2026-06-15").bookable === false, "no pre-sale config = nothing to resolve");
    });

    // --- Persistence round-trip via HC.store (isolated test provider). ---
    check("Pre-sale CRUD round-trips through HC.store without touching real data", function () {
      var TEST_PID = "__selftest_presell__" + HC.util.uid();
      HC.assert(presaleFor(TEST_PID) === null, "test provider should start with no pre-sale");

      var res = startPresale(TEST_PID, { hidden: true, launch: "2026-06-22", termOnly: true });
      HC.assert(res.ok === true, "startPresale should succeed; errors: " + res.errors.join("; "));
      var saved = presaleFor(TEST_PID);
      HC.assert(saved !== null, "pre-sale should be persisted");
      HC.assert(saved.link === res.value.link, "saved link should match the generated link");

      // The stored link still books for a token holder pre-launch.
      var hit = resolveBookingLink(saved, saved.token, "2026-06-21");
      HC.assert(hit.bookable === true && hit.reason === "presale", "stored pre-sale should still book pre-launch");
      // And it is off the public directory pre-launch.
      HC.assert(isPubliclyListed(saved, "2026-06-21") === false, "stored hidden camp is off public listings pre-launch");

      // Manual "go public now".
      goPublic(TEST_PID, "2026-06-18");
      var live = presaleFor(TEST_PID);
      HC.assert(live.hidden === false, "goPublic should clear hidden");
      HC.assert(isPubliclyListed(live, "2026-06-18") === true, "camp should be public after goPublic");

      endPresale(TEST_PID);
      HC.assert(presaleFor(TEST_PID) === null, "endPresale should clear the config");
    });

    // --- Live-data sanity: a real school-age camp produces a real link. ---
    check("A real live holiday camp produces a valid booking link", function () {
      var provider = firstProvider();
      HC.assert(provider && provider.id, "should resolve a live provider");
      var res = buildPresale({ providerId: provider.id, hidden: true, launch: "2026-06-22" });
      HC.assert(res.ok === true, "live provider pre-sale should build");
      HC.assert(res.value.link.indexOf(encodeURIComponent(provider.id)) !== -1, "link should target the live provider id");
      var copied = copyToClipboard(res.value.link);
      HC.assert(copied.text === res.value.link, "copy of a live booking link must equal the link");
    });

    return { pass: pass, fail: fail, log: log };
  }

  /* ===================================================================
     REGISTER (idempotent + defensive via core).
     =================================================================== */
  HC.registerFeature({
    id: "provider-presell-link",
    title: "Pre-sell via hidden booking link",
    side: "provider",
    icon: "🔗",
    summary: "Open bookings to your existing customers before the public launch. Set a camp to Hidden (off the public listings and Google), then copy a shareable Booking Link to paste into your WhatsApp group or email newsletter — it books even while hidden. Optionally restrict the pre-sale to term/block tickets only.",
    render: render,
    selfTest: selfTest
  });
})();
