/* HolidayCamp feature — provider-hidden-mode
 * ------------------------------------------------------------------
 * Replicates Happity's "Hidden" / "secret" mode for the PROVIDER side,
 * reframed for SCHOOL-AGE HOLIDAY CAMPS (not baby classes).
 *
 * Evidence (support corpus):
 *  - 4518631 "How to pre-sell your classes" — "1. 'Hidden' mode: You can
 *    set a class to 'Hidden' in Happity to remove it from all of the public
 *    facing pages on Happity. This will also stop the site from submitting
 *    your class info to Google." The provider then still gets a booking link
 *    they can email to existing customers (pre-sale) even while hidden.
 *  - 3719394 "How to cancel, hide or disable bookings…" — "Unpublishing a
 *    class from public view … hides your 'weekly slot' — i.e. this class
 *    would no longer appear in search results … and it would not be shown
 *    anywhere on your Happity profile pages. However you can still send out
 *    your booking links by email to your customer base." Provider picks the
 *    'hidden' radio (vs 'published') on the class.
 *
 * Reframed: a holiday-camp provider has a camp that normally appears on the
 * public directory (search results) and on their public profile page, and
 * whose info is submitted to Google (structured-data / sitemap feed). This
 * feature gives the provider a Visibility panel with a Published / Hidden
 * radio (mirroring Happity's secret mode). When HIDDEN:
 *   - the camp is removed from the public directory / search results,
 *   - it does not appear on the public profile pages,
 *   - its info is NOT submitted to Google, AND
 *   - the direct booking link STILL works (so it can be emailed to existing
 *     customers for a pre-sale).
 *
 * We NEVER mutate the camps.js data. The hidden flag lives only in HC.store,
 * keyed per camp/provider id. Plain browser JS — no imports/exports.
 *
 * Acceptance criterion (asserted by selfTest, multiple cases):
 *   A hidden camp is removed from public pages and not submitted to Google.
 *   We assert: a published camp appears in the public directory, on the
 *   public profile, and in the Google feed; setting it Hidden removes it
 *   from ALL of those (directory, profile, Google feed); the direct booking
 *   link still resolves while hidden (pre-sale); setting it Published again
 *   restores it everywhere; the flag is per-camp; and it persists.
 *
 * Defensive: nothing throws at registration time. Persistence is via
 * HC.store ONLY.
 * ------------------------------------------------------------------ */
(function () {
  "use strict";

  if (typeof window === "undefined" || !window.HC || typeof window.HC.registerFeature !== "function") {
    // Core not present — fail silently rather than throwing.
    return;
  }
  var HC = window.HC;

  /* ============================================================
   * 1. Storage model.
   *    One namespaced key holds a map of campId -> { hidden:Boolean }.
   *    `hidden:true` mirrors Happity's "Hidden"/secret radio (the camp is
   *    removed from public pages and not submitted to Google). Absence or
   *    `hidden:false` means "Published" (the default).
   * ============================================================ */

  var STORE_KEY = "provider_hidden_mode"; // { [campId]: { hidden:Boolean } }

  function readAll() {
    var v = HC.store.get(STORE_KEY, {});
    return (v && typeof v === "object") ? v : {};
  }
  function writeAll(map) {
    HC.store.set(STORE_KEY, map && typeof map === "object" ? map : {});
  }
  function readSetting(id) {
    var all = readAll();
    var s = all[id];
    return (s && typeof s === "object") ? s : null;
  }
  function writeSetting(id, partial) {
    if (!id) return;
    var all = readAll();
    var cur = (all[id] && typeof all[id] === "object") ? all[id] : {};
    for (var k in partial) {
      if (Object.prototype.hasOwnProperty.call(partial, k)) cur[k] = partial[k];
    }
    all[id] = cur;
    writeAll(all);
  }
  function clearSetting(id) {
    var all = readAll();
    if (all[id]) { delete all[id]; writeAll(all); }
  }

  /* ============================================================
   * 2. Pure helpers — visibility state.
   * ============================================================ */

  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function getId(camp) {
    if (!camp) return null;
    return camp.id || null;
  }

  // Is the camp currently in Hidden / secret mode?
  function isHidden(id) {
    var s = readSetting(id);
    return !!(s && s.hidden === true);
  }

  // The current visibility status string, for UI + reporting.
  function statusOf(id) {
    return isHidden(id) ? "hidden" : "published";
  }

  /* ============================================================
   * 3. Mutations — the Published / Hidden radio (Happity secret mode).
   * ============================================================ */

  // Set the camp to Hidden (removed from public pages + not sent to Google).
  function setHidden(id) {
    if (!id) return { ok: false, error: "No camp" };
    writeSetting(id, { hidden: true });
    return { ok: true, hidden: true };
  }
  // Set the camp back to Published (the default public state).
  function setPublished(id) {
    if (!id) return { ok: false, error: "No camp" };
    writeSetting(id, { hidden: false });
    return { ok: true, hidden: false };
  }
  // Flip whichever way it currently is.
  function toggle(id) {
    return isHidden(id) ? setPublished(id) : setHidden(id);
  }

  /* ============================================================
   * 4. THE ACCEPTANCE LOGIC — the public-facing surfaces.
   *
   *    Hidden mode must gate THREE surfaces, exactly as the evidence says:
   *      a) public directory / search results
   *      b) public profile pages
   *      c) the feed submitted to Google (structured data / sitemap)
   *    …while the direct booking link STILL resolves (pre-sale).
   *
   *    Each function below is what the corresponding real surface would be
   *    built from. They all read the SAME hidden flag, so a single radio
   *    consistently removes the camp from every public surface at once.
   * ============================================================ */

  // All camps the provider has (the raw data; not visibility-filtered).
  function allCamps() {
    var list = HC.data.providers || [];
    return list.filter(function (c) { return c && c.id; });
  }

  function findCamp(id) {
    var list = allCamps();
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === id) return list[i];
    }
    return null;
  }

  // (a) PUBLIC DIRECTORY — what search results / browse would list.
  //     Hidden camps are excluded.
  function publicDirectory(camps) {
    var src = camps || allCamps();
    return src.filter(function (c) { return c && c.id && !isHidden(c.id); });
  }

  // Is a given camp visible in the public directory?
  function isInPublicDirectory(id) {
    return publicDirectory().some(function (c) { return c.id === id; });
  }

  // (b) PUBLIC PROFILE — what a public profile page would render for a camp.
  //     A hidden camp returns null (it is "not shown anywhere on your public
  //     profile pages").
  function publicProfile(id) {
    if (isHidden(id)) return null;
    var camp = findCamp(id);
    if (!camp) return null;
    return {
      id: camp.id,
      name: camp.name || camp.id,
      area: camp.area || camp.venue || "",
      ageLabel: camp.ageLabel || "",
      price: camp.price || "",
      visibility: "published"
    };
  }

  // (c) GOOGLE FEED — the structured-data / sitemap entries the site would
  //     submit to Google. Hidden camps are NOT submitted.
  function googleFeed(camps) {
    var src = camps || allCamps();
    return src
      .filter(function (c) { return c && c.id && !isHidden(c.id); })
      .map(function (c) {
        return {
          // Minimal schema.org/Event-style record the crawler would see.
          "@type": "Event",
          url: "/camps/" + c.id,
          name: c.name || c.id,
          id: c.id
        };
      });
  }

  // Is a given camp submitted to Google?
  function isSubmittedToGoogle(id) {
    return googleFeed().some(function (e) { return e.id === id; });
  }

  // DIRECT BOOKING LINK — this STILL works while hidden. It is the pre-sale
  // link a provider emails to existing customers. It resolves for ANY real
  // camp regardless of hidden state; it only fails for unknown ids.
  function bookingLink(id) {
    var camp = findCamp(id);
    if (!camp) return null;
    return {
      id: camp.id,
      url: "/book/" + camp.id,
      // Bookable even in secret mode — that is the whole point of pre-sale.
      bookable: true,
      hidden: isHidden(id)
    };
  }

  /* ============================================================
   * 5. Aggregate model for one camp — used by render + selfTest.
   *    This is the single source of truth a UI/preview reads from.
   * ============================================================ */
  function visibilityModel(id) {
    var camp = findCamp(id);
    if (!camp) {
      return {
        id: id || null, found: false, name: "",
        hidden: false, status: "published",
        inDirectory: false, onProfile: false, inGoogleFeed: false, bookable: false
      };
    }
    var hidden = isHidden(id);
    return {
      id: camp.id,
      found: true,
      name: camp.name || camp.id,
      area: camp.area || camp.venue || "",
      hidden: hidden,
      status: hidden ? "hidden" : "published",
      // The three PUBLIC surfaces (all false when hidden):
      inDirectory: isInPublicDirectory(id),
      onProfile: publicProfile(id) !== null,
      inGoogleFeed: isSubmittedToGoogle(id),
      // The booking link still works when hidden:
      bookable: !!(bookingLink(id) && bookingLink(id).bookable)
    };
  }

  /* ============================================================
   * 6. Render — provider Visibility panel with a Published / Hidden
   *    radio plus a live preview of each public surface and the
   *    still-working pre-sale booking link.
   * ============================================================ */

  var el = (HC.util && HC.util.el) ? HC.util.el : function (t, a, h) {
    var n = document.createElement(t || "div");
    if (a) for (var k in a) {
      if (Object.prototype.hasOwnProperty.call(a, k)) {
        if (k === "class") n.className = a[k]; else n.setAttribute(k, a[k]);
      }
    }
    if (h != null) n.innerHTML = h;
    return n;
  };

  function pill(label, on) {
    return '<span style="display:inline-block;font-size:12px;font-weight:700;padding:3px 10px;border-radius:999px;' +
      (on
        ? "background:#E1F0E4;color:#1B7A3D"
        : "background:#FCE3E6;color:#B00020") + '">' +
      (on ? "✓ " : "✗ ") + escapeHtml(label) + "</span>";
  }

  function render(mountEl) {
    try {
      if (!mountEl) return;
      mountEl.innerHTML = "";

      var camps = allCamps();

      var wrap = el("div", { class: "hm-wrap", style: "display:flex;flex-direction:column;gap:14px" });

      var intro = el("p", { style: "margin:0;color:var(--text,#383838);font-size:14px" },
        "Set a camp to <strong>Hidden</strong> (secret mode) to remove it from all public pages on " +
        "HolidayCamp — search results and your public profile — and to stop the site submitting it to " +
        "<strong>Google</strong>. Your <em>direct booking link still works</em>, so you can email it to " +
        "existing customers for a pre-sale before the camp goes on general sale. Mirrors Happity's " +
        "Published / Hidden radio.");
      wrap.appendChild(intro);

      // Camp picker.
      var pickRow = el("div", { style: "display:flex;flex-direction:column;gap:6px" });
      pickRow.appendChild(el("label", { for: "hmCamp", style: "font-weight:700;font-size:13px;color:var(--purple,#603488)" }, "Your camp"));
      var sel = el("select", { id: "hmCamp", style: "padding:9px;border-radius:10px;border:1.5px solid var(--line,#E6E6E6);font-size:14px" });
      if (!camps.length) {
        sel.appendChild(el("option", { value: "" }, "No camps loaded"));
      } else {
        for (var i = 0; i < camps.length; i++) {
          sel.appendChild(el("option", { value: camps[i].id }, escapeHtml(camps[i].name || camps[i].id)));
        }
      }
      pickRow.appendChild(sel);
      wrap.appendChild(pickRow);

      // Visibility control panel.
      var panel = el("div", { id: "hmPanel",
        style: "border:1.5px solid var(--line,#E6E6E6);border-radius:16px;padding:16px;background:#fff;display:flex;flex-direction:column;gap:12px" });
      wrap.appendChild(panel);

      // Live preview of the public surfaces.
      var prevHead = el("div", { class: "hc-sidehead", style: "margin:14px 0 0" }, "What's public right now");
      wrap.appendChild(prevHead);
      var preview = el("div", { id: "hmPreview",
        style: "border:1.5px dashed var(--purple,#603488);border-radius:16px;padding:16px;background:var(--purple-tint,#F7F2FB);display:flex;flex-direction:column;gap:8px" });
      wrap.appendChild(preview);

      mountEl.appendChild(wrap);

      function renderFor(id) {
        var camp = findCamp(id);
        var m = visibilityModel(id);

        /* ---- provider-side visibility radio ---- */
        panel.innerHTML = "";
        if (!camp) {
          panel.appendChild(el("p", { style: "margin:0;color:var(--muted,#808080)" }, "Select a camp to manage its visibility."));
        } else {
          panel.appendChild(el("div", { style: "font-weight:700;color:var(--purple,#603488)" }, "Visibility"));

          var radioRow = el("div", { style: "display:flex;flex-direction:column;gap:8px" });

          function radio(value, title, desc) {
            var checked = (m.status === value);
            var id2 = "hm-radio-" + value;
            var row = el("label", { for: id2,
              style: "display:flex;gap:10px;align-items:flex-start;padding:10px 12px;border-radius:12px;cursor:pointer;border:1.5px solid " +
                (checked ? "var(--purple,#603488)" : "var(--line,#E6E6E6)") + ";background:" + (checked ? "var(--purple-tint,#F7F2FB)" : "#fff") });
            var input = el("input", { type: "radio", name: "hmVisibility", id: id2, value: value });
            if (checked) input.setAttribute("checked", "checked");
            input.addEventListener("change", function () {
              if (value === "hidden") setHidden(camp.id); else setPublished(camp.id);
              if (HC.util && HC.util.toast) {
                HC.util.toast(value === "hidden"
                  ? "Hidden — removed from public pages and not sent to Google"
                  : "Published — now visible on public pages and submitted to Google");
              }
              renderFor(camp.id);
            });
            row.appendChild(input);
            var txt = el("div", null,
              '<div style="font-weight:700;color:var(--text,#383838)">' + escapeHtml(title) + "</div>" +
              '<div style="font-size:12.5px;color:var(--muted,#808080)">' + escapeHtml(desc) + "</div>");
            row.appendChild(txt);
            return row;
          }

          radioRow.appendChild(radio("published", "Published",
            "Visible in search results and on your profile; submitted to Google."));
          radioRow.appendChild(radio("hidden", "Hidden (secret mode)",
            "Removed from all public pages and NOT submitted to Google. Your booking link still works for pre-sales."));
          panel.appendChild(radioRow);

          var status = el("div", {
            style: "font-size:13px;font-weight:700;" + (m.hidden ? "color:#B00020" : "color:#1B7A3D") },
            m.hidden
              ? "This camp is HIDDEN. It is off your public pages and off Google. Share its booking link directly for a pre-sale."
              : "This camp is PUBLISHED and fully discoverable.");
          panel.appendChild(status);
        }

        /* ---- public-surface preview ---- */
        preview.innerHTML = "";
        if (!camp) {
          preview.appendChild(el("p", { style: "margin:0;color:var(--muted,#808080)" }, "—"));
        } else {
          preview.appendChild(el("div", { style: "font-weight:800;color:var(--purple,#603488);font-size:16px" }, escapeHtml(m.name)));
          var pills = el("div", { style: "display:flex;gap:8px;flex-wrap:wrap" });
          pills.innerHTML =
            pill("In search results", m.inDirectory) +
            pill("On public profile", m.onProfile) +
            pill("Submitted to Google", m.inGoogleFeed) +
            pill("Booking link works", m.bookable);
          preview.appendChild(pills);

          var link = bookingLink(camp.id);
          if (link) {
            var linkLine = el("div", { style: "font-size:13px;margin-top:4px" });
            linkLine.innerHTML = '🔗 Pre-sale booking link: <code style="background:#fff;border:1px solid var(--line,#E6E6E6);border-radius:6px;padding:2px 6px">' +
              escapeHtml(link.url) + "</code>" +
              (m.hidden ? ' <span style="color:#1B7A3D;font-weight:700">(still works while hidden)</span>' : "");
            preview.appendChild(linkLine);
          }

          var counts = el("div", { style: "font-size:12px;color:var(--muted,#808080);margin-top:2px" },
            "Public directory now lists " + publicDirectory().length + " of " + camps.length +
            " camps · Google feed has " + googleFeed().length + " entries.");
          preview.appendChild(counts);
        }
      }

      sel.addEventListener("change", function () { renderFor(sel.value); });
      renderFor(camps.length ? sel.value : "");
    } catch (e) {
      try {
        mountEl.innerHTML = '<p style="color:#B00020">Could not render hidden-mode panel: ' +
          escapeHtml(e && e.message ? e.message : String(e)) + "</p>";
      } catch (e2) { /* never throw out of render */ }
    }
  }

  /* ============================================================
   * 7. selfTest — exercises the LOGIC and asserts the acceptance
   *    criterion across multiple cases:
   *      "A hidden camp is removed from public pages and not
   *       submitted to Google."
   * ============================================================ */

  function selfTest() {
    var pass = 0, fail = 0, log = [];
    function check(label, fn) {
      try { fn(); pass += 1; log.push("✓ " + label); }
      catch (e) { fail += 1; log.push("✗ " + label + " — " + (e && e.message ? e.message : String(e))); }
    }

    var camps = allCamps();

    // Pick two real camps where possible; fall back to synthetic ids that we
    // seed into HC.store so the visibility logic is still exercised. (Note:
    // synthetic ids won't be in HC.data, so findCamp can't resolve them — we
    // therefore require real data for the directory/profile/Google checks and
    // guard those with a presence test, while the flag-level checks run always.)
    var A = camps[0] ? camps[0].id : null;
    var B = camps[1] ? camps[1].id : null;

    // Always-on: flag-level state machine works even with no data loaded.
    var SYN = "synthetic-hidden-mode-test-camp";
    clearSetting(SYN);

    check("Default state is published (not hidden)", function () {
      clearSetting(SYN);
      HC.assert(isHidden(SYN) === false, "should not be hidden by default");
      HC.assert(statusOf(SYN) === "published", "status should be 'published'");
    });

    check("setHidden / setPublished flip the stored flag", function () {
      clearSetting(SYN);
      var h = setHidden(SYN);
      HC.assert(h.ok === true && h.hidden === true, "setHidden should succeed");
      HC.assert(isHidden(SYN) === true, "flag should read hidden");
      var p = setPublished(SYN);
      HC.assert(p.ok === true && p.hidden === false, "setPublished should succeed");
      HC.assert(isHidden(SYN) === false, "flag should read published");
    });

    check("toggle() flips hidden state each call", function () {
      clearSetting(SYN);
      HC.assert(isHidden(SYN) === false, "starts published");
      toggle(SYN);
      HC.assert(isHidden(SYN) === true, "first toggle hides");
      toggle(SYN);
      HC.assert(isHidden(SYN) === false, "second toggle publishes");
    });

    check("Hidden flag persists across a reload (re-read from store)", function () {
      clearSetting(SYN);
      setHidden(SYN);
      var s = readSetting(SYN);
      HC.assert(s && s.hidden === true, "store should hold hidden=true after reload");
    });

    check("Empty/unknown id is handled defensively", function () {
      HC.assert(setHidden("").ok === false, "no id -> not ok");
      HC.assert(bookingLink("no-such-camp-xyz") === null, "unknown camp has no booking link");
      var m = visibilityModel("no-such-camp-xyz");
      HC.assert(m.found === false, "unknown camp model reports not found");
      HC.assert(m.inDirectory === false && m.onProfile === false && m.inGoogleFeed === false,
        "unknown camp is on no public surface");
    });

    // ---- Data-backed acceptance checks (need at least one real camp) ----
    if (A) {
      // Baseline: a published camp is on ALL public surfaces.
      check("By default a camp is in the public directory, profile AND Google feed", function () {
        clearSetting(A);
        var m = visibilityModel(A);
        HC.assert(m.found === true, "camp should resolve");
        HC.assert(m.status === "published", "should default to published");
        HC.assert(m.inDirectory === true, "should appear in public directory");
        HC.assert(m.onProfile === true, "should appear on public profile");
        HC.assert(m.inGoogleFeed === true, "should be submitted to Google");
        HC.assert(m.bookable === true, "should be bookable");
      });

      // *** ACCEPTANCE CRITERION ***
      check("ACCEPTANCE: a hidden camp is removed from public pages AND not submitted to Google", function () {
        clearSetting(A);
        var before = visibilityModel(A);
        HC.assert(before.inDirectory && before.onProfile && before.inGoogleFeed, "precondition: fully public");

        var res = setHidden(A);
        HC.assert(res.ok === true && res.hidden === true, "hide should succeed");

        var after = visibilityModel(A);
        // Removed from public pages:
        HC.assert(after.inDirectory === false, "hidden camp must NOT be in the public directory");
        HC.assert(after.onProfile === false, "hidden camp must NOT appear on the public profile");
        HC.assert(publicProfile(A) === null, "public profile must return null when hidden");
        HC.assert(isInPublicDirectory(A) === false, "directory helper must exclude the hidden camp");
        // Not submitted to Google:
        HC.assert(after.inGoogleFeed === false, "hidden camp must NOT be submitted to Google");
        HC.assert(isSubmittedToGoogle(A) === false, "Google helper must exclude the hidden camp");
        HC.assert(googleFeed().every(function (e) { return e.id !== A; }), "Google feed must contain no entry for the hidden camp");
      });

      // The Happity pre-sale nuance: the booking link still works when hidden.
      check("A hidden camp's direct booking link STILL works (pre-sale)", function () {
        // (A is hidden from previous check)
        HC.assert(isHidden(A) === true, "precondition: hidden");
        var link = bookingLink(A);
        HC.assert(link && link.bookable === true, "booking link must still resolve and be bookable while hidden");
        HC.assert(link.hidden === true, "link should report the camp is hidden");
        HC.assert(visibilityModel(A).bookable === true, "model should report bookable while hidden");
      });

      // The public directory genuinely shrinks by exactly one when hiding.
      check("Hiding a camp removes exactly one entry from directory and Google feed", function () {
        clearSetting(A);
        var dirBefore = publicDirectory().length;
        var googleBefore = googleFeed().length;
        setHidden(A);
        HC.assert(publicDirectory().length === dirBefore - 1, "directory should shrink by one");
        HC.assert(googleFeed().length === googleBefore - 1, "Google feed should shrink by one");
      });

      // Restoring puts it back on every surface.
      check("Setting a camp back to Published restores it everywhere", function () {
        // (A is hidden)
        setPublished(A);
        var m = visibilityModel(A);
        HC.assert(m.inDirectory === true, "restored to directory");
        HC.assert(m.onProfile === true, "restored to profile");
        HC.assert(m.inGoogleFeed === true, "restored to Google feed");
        HC.assert(publicProfile(A) !== null, "profile resolves again");
      });
    }

    if (A && B) {
      // Per-camp: hiding A does not hide B.
      check("Hidden mode is per-camp — hiding one does not hide another", function () {
        clearSetting(A);
        clearSetting(B);
        setHidden(A);
        var mA = visibilityModel(A);
        var mB = visibilityModel(B);
        HC.assert(mA.inDirectory === false && mA.inGoogleFeed === false, "A should be hidden everywhere public");
        HC.assert(mB.inDirectory === true && mB.onProfile === true && mB.inGoogleFeed === true,
          "B should remain fully public");
      });

      // The other public camps are untouched in the feeds.
      check("Other camps stay in the directory and Google feed when one is hidden", function () {
        clearSetting(A);
        clearSetting(B);
        setHidden(A);
        HC.assert(isInPublicDirectory(B) === true, "B still listed");
        HC.assert(isSubmittedToGoogle(B) === true, "B still submitted to Google");
      });
    }

    // DOM check (browser only): the radio actually removes the camp from the
    // rendered preview surfaces.
    check("Rendered radio hides the camp from the public-surface preview", function () {
      if (typeof document === "undefined") { return; } // node --check has no DOM
      if (!A) { return; }                               // need a real camp id
      clearSetting(A);
      var host = document.createElement("div");
      if (document.body) { document.body.appendChild(host); } // mount like the real app (radio events need an attached node)
      render(host);
      var sel = host.querySelector("#hmCamp");
      if (sel) {
        for (var i = 0; i < sel.options.length; i++) {
          if (sel.options[i].value === A) { sel.selectedIndex = i; break; }
        }
        sel.dispatchEvent(new Event("change", { bubbles: true }));
      }
      var text1 = (host.querySelector("#hmPreview") || {}).textContent || "";
      HC.assert(/✓ In search results/.test(text1), "preview should show camp in search results when published");
      HC.assert(/✓ Submitted to Google/.test(text1), "preview should show camp submitted to Google when published");

      // Click the Hidden radio.
      var hiddenRadio = host.querySelector("#hm-radio-hidden");
      HC.assert(!!hiddenRadio, "hidden radio should render");
      hiddenRadio.checked = true;
      hiddenRadio.dispatchEvent(new Event("change", { bubbles: true }));
      var text2 = (host.querySelector("#hmPreview") || {}).textContent || "";
      if (host.parentNode) { host.parentNode.removeChild(host); } // tidy up the mounted node before asserting
      HC.assert(/✗ In search results/.test(text2), "preview must show camp removed from search results when hidden");
      HC.assert(/✗ Submitted to Google/.test(text2), "preview must show camp NOT submitted to Google when hidden");
      HC.assert(/✓ Booking link works/.test(text2), "preview should show booking link still works while hidden");
      clearSetting(A);
    });

    // Leave the store as found.
    clearSetting(SYN);
    if (A) clearSetting(A);
    if (B) clearSetting(B);

    return { pass: pass, fail: fail, log: log };
  }

  /* ============================================================
   * 8. Register (idempotent + defensive via core).
   * ============================================================ */
  HC.registerFeature({
    id: "provider-hidden-mode",
    title: "Hidden / secret mode",
    side: "provider",
    icon: "🙈",
    summary: "Set a camp to Hidden (secret mode) to remove it from all public pages — search results and " +
      "your profile — and stop it being submitted to Google. Your direct booking link still works, so you " +
      "can email it to existing customers for a pre-sale. Per-camp and saved. Mirrors Happity's Published / " +
      "Hidden radio.",
    render: render,
    selfTest: selfTest
  });
})();
