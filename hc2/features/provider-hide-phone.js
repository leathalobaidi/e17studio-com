/* HolidayCamp feature — provider-hide-phone
 * ------------------------------------------------------------------
 * Replicates Happity's "My phone number is showing on the site, how
 * do I remove this?" behaviour for the PROVIDER side, reframed for
 * SCHOOL-AGE HOLIDAY CAMPS (not baby classes).
 *
 * Evidence (support corpus):
 *  - 6394536 "My phone number is showing on the site, how do I remove
 *    this?": a provider goes to Profile > Organisation > Contact, sees
 *    their contact information, and "At the bottom will be your phone
 *    number. If you select the red button, you can then remove your
 *    phone number and press save." i.e. a single toggle/red-button that
 *    REMOVES the phone number from the public-facing profile.
 *
 * Reframed: a holiday-camp provider has a public listing page. Their
 * booking/contact phone may be shown on it. This feature gives the
 * provider a Contact panel with a RED "Remove phone number" toggle.
 * When ON (hidden), the public camp/profile page shows NO phone number;
 * when OFF (shown), the public page shows the number. The setting is
 * saved per provider and persists.
 *
 * The verified camps.js data has no dedicated `phone` field — numbers
 * live inside free-text `booking` strings (e.g. "07906 446 849"). So we
 * DERIVE each provider's phone: parse a UK number out of booking text
 * if present, else mint a deterministic mock number. We NEVER mutate the
 * camps.js data; the hide flag and any provider-edited number live only
 * in HC.store.
 *
 * Acceptance criterion (asserted by selfTest, multiple cases):
 *   A toggle removes the provider's phone number from the public page.
 *   We assert: with the toggle OFF the public-page model exposes the
 *   number and the rendered public DOM contains it; flipping the toggle
 *   ON removes the number from the model AND from the rendered public
 *   DOM; flipping back restores it; the setting persists across reloads;
 *   and the toggle is per-provider (hiding one does not hide another).
 *
 * Defensive: nothing throws at registration time. Persistence is via
 * HC.store ONLY. Plain browser JS — no imports/exports.
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
   *    One namespaced key holds a map of providerId -> setting:
   *      { hidden:Boolean, phone:String|null }
   *    `hidden` mirrors Happity's red-button state (phone removed from
   *    the public page). `phone` lets a provider override the derived
   *    number; when absent we fall back to the derived number.
   * ============================================================ */

  var STORE_KEY = "provider_hide_phone"; // { [providerId]: { hidden, phone } }

  function readAll() {
    var v = HC.store.get(STORE_KEY, {});
    return (v && typeof v === "object") ? v : {};
  }
  function writeAll(map) {
    HC.store.set(STORE_KEY, map && typeof map === "object" ? map : {});
  }
  function readSetting(pid) {
    var all = readAll();
    var s = all[pid];
    return (s && typeof s === "object") ? s : null;
  }
  function writeSetting(pid, partial) {
    if (!pid) return;
    var all = readAll();
    var cur = (all[pid] && typeof all[pid] === "object") ? all[pid] : {};
    for (var k in partial) {
      if (Object.prototype.hasOwnProperty.call(partial, k)) cur[k] = partial[k];
    }
    all[pid] = cur;
    writeAll(all);
  }
  function clearSetting(pid) {
    var all = readAll();
    if (all[pid]) { delete all[pid]; writeAll(all); }
  }

  /* ============================================================
   * 2. Pure helpers — phone derivation, normalisation, formatting.
   * ============================================================ */

  function trimStr(s) { return String(s == null ? "" : s).replace(/\s+/g, " ").trim(); }

  // Strip a candidate down to a comparable digit string (keep leading +).
  function digitsOnly(s) {
    var str = String(s == null ? "" : s);
    var plus = /^\s*\+/.test(str) ? "+" : "";
    return plus + str.replace(/\D/g, "");
  }

  // Is this a plausible UK phone number? (mobile 07…, landline 01/02/03,
  // or +44 forms). We are deliberately permissive but require enough digits.
  function isValidPhone(s) {
    var d = digitsOnly(s).replace(/^\+/, "");
    if (d.length < 10 || d.length > 13) return false;
    // 44…, 0…  — first significant digit should be 0 or a 44 country code.
    if (/^44/.test(d)) return d.length >= 11;        // +44 7… / +44 1…
    if (/^0[1-9]/.test(d)) return d.length === 10 || d.length === 11;
    return false;
  }

  // Pull the first plausible UK phone number out of a free-text string
  // (e.g. a `booking` description). Returns the matched text or null.
  function extractPhone(text) {
    var str = String(text == null ? "" : text);
    // Match +44 / 0-led runs of digits with optional spaces, dashes, brackets.
    var re = /(\+?44[\s\-()]?|0)(?:[\d\s\-()]{8,14})\d/g;
    var m;
    while ((m = re.exec(str)) !== null) {
      var candidate = trimStr(m[0]);
      if (isValidPhone(candidate)) return candidate;
    }
    return null;
  }

  // Deterministic mock UK mobile from a provider id (no Math.random so
  // tests and previews are stable). Format: 07### ### ###.
  function mockPhoneFor(pid) {
    var seed = 0;
    var s = String(pid || "camp");
    for (var i = 0; i < s.length; i++) seed = (seed * 31 + s.charCodeAt(i)) >>> 0;
    var nine = String(700000000 + (seed % 99999999)).slice(0, 9); // 9 digits after the 0
    var d = ("0" + nine).slice(0, 11);
    // Pad/truncate defensively to 11 digits.
    while (d.length < 11) d += String(seed % 10);
    d = d.slice(0, 11);
    return d;
  }

  // Pretty-print a UK number: 07906 446 849 / 020 7946 0991.
  function formatPhone(raw) {
    var d = digitsOnly(raw);
    var plus = /^\+/.test(d) ? "+" : "";
    var n = d.replace(/^\+/, "");
    if (plus === "+" && /^44/.test(n)) n = "0" + n.slice(2); // show +44 as 0… locally
    if (/^07\d{9}$/.test(n)) return n.slice(0, 5) + " " + n.slice(5, 8) + " " + n.slice(8);
    if (/^0(20|11\d)\d{7,8}$/.test(n)) return n.slice(0, 3) + " " + n.slice(3, 7) + " " + n.slice(7);
    if (/^0\d{9,10}$/.test(n)) return n.slice(0, 5) + " " + n.slice(5);
    return trimStr(raw);
  }

  /* ============================================================
   * 3. Resolve a provider's phone (override -> booking-text -> mock).
   * ============================================================ */

  function findProvider(pid) {
    var list = HC.data.providers || [];
    for (var i = 0; i < list.length; i++) {
      if (list[i] && list[i].id === pid) return list[i];
    }
    return null;
  }

  // The number on file for a provider, regardless of hidden state.
  function resolvePhone(provider) {
    if (!provider) return null;
    var setting = readSetting(provider.id);
    if (setting && typeof setting.phone === "string" && isValidPhone(setting.phone)) {
      return setting.phone;
    }
    // Look for a real phone in the provider's free-text fields.
    var fields = [provider.phone, provider.booking, provider.contact, provider.summary];
    for (var i = 0; i < fields.length; i++) {
      var found = extractPhone(fields[i]);
      if (found) return found;
    }
    return mockPhoneFor(provider.id);
  }

  // Is the phone currently hidden from the public page for this provider?
  function isHidden(pid) {
    var s = readSetting(pid);
    return !!(s && s.hidden === true);
  }

  /* ============================================================
   * 4. THE ACCEPTANCE LOGIC — build the public-page contact model.
   *    This is exactly what a public visitor's page would render from.
   *    When hidden, `phone` is null and `showsPhone` is false.
   * ============================================================ */

  function buildPublicProfile(provider) {
    if (!provider) {
      return { id: null, name: "", showsPhone: false, phone: null };
    }
    var hidden = isHidden(provider.id);
    var number = resolvePhone(provider);
    var visible = !hidden && !!number;
    return {
      id: provider.id,
      name: provider.name || provider.id,
      hidden: hidden,
      // The raw number on file (used by the provider-side dashboard).
      phoneOnFile: number,
      phoneOnFileFormatted: number ? formatPhone(number) : null,
      // What the PUBLIC page is allowed to show:
      showsPhone: visible,
      phone: visible ? number : null,
      phoneFormatted: visible ? formatPhone(number) : null
    };
  }

  /* ============================================================
   * 5. Mutations — the toggle (Happity's red button) + override.
   * ============================================================ */

  // Hide the phone from the public page (red-button ON).
  function hidePhone(pid) {
    if (!pid) return { ok: false, error: "No provider" };
    writeSetting(pid, { hidden: true });
    return { ok: true, hidden: true };
  }
  // Show the phone on the public page again (red-button OFF).
  function showPhone(pid) {
    if (!pid) return { ok: false, error: "No provider" };
    writeSetting(pid, { hidden: false });
    return { ok: true, hidden: false };
  }
  // Flip whichever way it currently is.
  function togglePhone(pid) {
    return isHidden(pid) ? showPhone(pid) : hidePhone(pid);
  }
  // Let a provider set/correct the number on file (does not change hidden).
  function setPhone(pid, raw) {
    if (!pid) return { ok: false, error: "No provider" };
    var cleaned = trimStr(raw);
    if (!isValidPhone(cleaned)) return { ok: false, error: "That doesn't look like a valid UK phone number." };
    writeSetting(pid, { phone: cleaned });
    return { ok: true, phone: cleaned };
  }

  /* ============================================================
   * 6. Render — provider Contact panel + live public-page preview.
   *    Mirrors Profile > Organisation > Contact with a RED button to
   *    remove the phone from the public page.
   * ============================================================ */

  var el = (HC.util && HC.util.el) ? HC.util.el : function (t, a, h) {
    var n = document.createElement(t || "div");
    if (a) for (var k in a) { if (Object.prototype.hasOwnProperty.call(a, k)) { if (k === "class") n.className = a[k]; else n.setAttribute(k, a[k]); } }
    if (h != null) n.innerHTML = h;
    return n;
  };

  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function render(mountEl) {
    try {
      if (!mountEl) return;
      mountEl.innerHTML = "";

      var providers = HC.data.providers || [];

      var wrap = el("div", { class: "hp-wrap", style: "display:flex;flex-direction:column;gap:14px" });

      var intro = el("p", { style: "margin:0;color:var(--text,#383838);font-size:14px" },
        "Your booking phone number can show on your public camp page. Like Happity's " +
        "<em>Profile &rsaquo; Organisation &rsaquo; Contact</em>, the red button below <strong>removes your phone " +
        "number from the public page</strong>. Toggle it back on any time.");
      wrap.appendChild(intro);

      // Provider picker.
      var pickRow = el("div", { style: "display:flex;flex-direction:column;gap:6px" });
      pickRow.appendChild(el("label", { for: "hpProvider", style: "font-weight:700;font-size:13px;color:var(--purple,#603488)" }, "Your camp / organisation"));
      var sel = el("select", { id: "hpProvider", style: "padding:9px;border-radius:10px;border:1.5px solid var(--line,#E6E6E6);font-size:14px" });
      if (!providers.length) {
        sel.appendChild(el("option", { value: "" }, "No providers loaded"));
      } else {
        for (var i = 0; i < providers.length; i++) {
          var p = providers[i];
          if (!p || !p.id) continue;
          sel.appendChild(el("option", { value: p.id }, escapeHtml(p.name || p.id)));
        }
      }
      pickRow.appendChild(sel);
      wrap.appendChild(pickRow);

      // Contact panel (the editable provider side).
      var panel = el("div", { id: "hpPanel", class: "hp-panel",
        style: "border:1.5px solid var(--line,#E6E6E6);border-radius:16px;padding:16px;background:#fff;display:flex;flex-direction:column;gap:12px" });
      wrap.appendChild(panel);

      // Live PUBLIC PAGE preview (what a parent visiting the page would see).
      var pubHead = el("div", { class: "hc-sidehead", style: "margin:14px 0 0" }, "Public page preview");
      wrap.appendChild(pubHead);
      var pub = el("div", { id: "hpPublic", class: "hp-public",
        style: "border:1.5px dashed var(--purple,#603488);border-radius:16px;padding:16px;background:var(--purple-tint,#F7F2FB);display:flex;flex-direction:column;gap:6px" });
      wrap.appendChild(pub);

      mountEl.appendChild(wrap);

      function renderFor(pid) {
        var provider = findProvider(pid);
        var model = buildPublicProfile(provider);

        /* ---- provider-side contact panel ---- */
        panel.innerHTML = "";
        if (!provider) {
          panel.appendChild(el("p", { style: "margin:0;color:var(--muted,#808080)" }, "Select a camp to manage its contact details."));
        } else {
          panel.appendChild(el("div", { style: "font-weight:700;color:var(--purple,#603488)" }, "Contact details"));

          var phoneRow = el("div", { style: "display:flex;align-items:center;gap:10px;flex-wrap:wrap" });
          phoneRow.appendChild(el("span", { style: "font-size:13px;color:var(--muted,#808080)" }, "Phone on file:"));
          phoneRow.appendChild(el("strong", { id: "hpOnFile", style: "font-size:15px" },
            escapeHtml(model.phoneOnFileFormatted || "—")));
          panel.appendChild(phoneRow);

          // Status line.
          var status = el("div", { id: "hpStatus",
            style: "font-size:13px;font-weight:700;" + (model.hidden ? "color:#B00020" : "color:#1B7A3D") },
            model.hidden ? "Hidden — your phone number is NOT shown on your public page." :
                           "Showing — your phone number IS visible on your public page.");
          panel.appendChild(status);

          // The RED remove / restore button (Happity's red button).
          var btn = el("button", {
            id: "hpToggle",
            type: "button",
            class: "hc-btn",
            style: model.hidden
              ? "background:#1B7A3D;color:#fff;border:none;cursor:pointer"
              : "background:#D7263D;color:#fff;border:none;cursor:pointer"
          }, model.hidden ? "Show phone on public page" : "Remove phone from public page");
          btn.addEventListener("click", function () {
            togglePhone(provider.id);
            if (HC.util && HC.util.toast) {
              HC.util.toast(isHidden(provider.id) ? "Phone number removed from your public page" : "Phone number now showing on your public page");
            }
            renderFor(provider.id);
          });
          panel.appendChild(btn);
        }

        /* ---- public page preview ---- */
        pub.innerHTML = "";
        if (!provider) {
          pub.appendChild(el("p", { style: "margin:0;color:var(--muted,#808080)" }, "—"));
        } else {
          pub.appendChild(el("div", { style: "font-weight:800;color:var(--purple,#603488);font-size:16px" }, escapeHtml(model.name)));
          pub.appendChild(el("div", { style: "font-size:13px;color:var(--text,#383838)" }, escapeHtml(provider.area || provider.venue || "")));
          var contactLine = el("div", { id: "hpPublicPhone", style: "font-size:14px;margin-top:4px" });
          if (model.showsPhone) {
            contactLine.innerHTML = '📞 <a href="tel:' + escapeHtml(digitsOnly(model.phone)) + '" style="color:var(--magenta,#F82488);font-weight:700;text-decoration:none">' +
              escapeHtml(model.phoneFormatted) + "</a>";
          } else {
            contactLine.innerHTML = '<span style="color:var(--muted,#808080)">Contact this camp through the on-page booking/enquiry link.</span>';
          }
          pub.appendChild(contactLine);
        }
      }

      sel.addEventListener("change", function () { renderFor(sel.value); });
      renderFor(providers.length ? sel.value : "");
    } catch (e) {
      try {
        mountEl.innerHTML = '<p style="color:#B00020">Could not render hide-phone panel: ' +
          escapeHtml(e && e.message ? e.message : String(e)) + "</p>";
      } catch (e2) { /* never throw out of render */ }
    }
  }

  /* ============================================================
   * 7. selfTest — exercises the LOGIC and asserts the acceptance
   *    criterion across multiple cases.
   * ============================================================ */

  function selfTest() {
    var pass = 0, fail = 0, log = [];
    function check(label, fn) {
      try { fn(); pass += 1; log.push("✓ " + label); }
      catch (e) { fail += 1; log.push("✗ " + label + " — " + (e && e.message ? e.message : String(e))); }
    }

    var providers = HC.data.providers || [];
    // Use real providers where possible; fall back to synthetic ones so the
    // test is meaningful even if data isn't loaded (e.g. under node --check run).
    var PROV_A = providers[0] || { id: "test-camp-a", name: "Test Camp A", booking: "Call us on 07906 446 849 to book." };
    var PROV_B = providers[1] || { id: "test-camp-b", name: "Test Camp B" };
    var A = PROV_A.id, B = PROV_B.id;

    // Inject the synthetic providers into resolution if real data is absent,
    // by relying on findProvider over HC.data — but for synthetic ids we test
    // through the provider object directly via buildPublicProfile.
    function profile(prov) { return buildPublicProfile(prov); }

    // Clean slate.
    clearSetting(A);
    clearSetting(B);

    // --- Helper validity of derivation ---
    check("A provider always resolves to a phone number on file", function () {
      var ph = resolvePhone(PROV_A);
      HC.assert(typeof ph === "string" && ph.length > 0, "expected a phone string");
      HC.assert(isValidPhone(ph), "resolved phone should be valid: " + ph);
    });

    check("A phone embedded in booking text is extracted", function () {
      var found = extractPhone("Book through Pebble; contact Henry on 07906 446 849 or info@x.co.uk.");
      HC.assert(found && digitsOnly(found) === "07906446849", "expected 07906446849, got " + found);
    });

    check("Junk text yields no phone (falls back to mock)", function () {
      HC.assert(extractPhone("No number here, just words and 123.") === null, "should find no phone");
      var mock = mockPhoneFor("some-camp");
      HC.assert(isValidPhone(mock), "mock phone should be valid: " + mock);
    });

    // --- ACCEPTANCE core: default OFF shows the phone on the public page ---
    check("By default the public page SHOWS the phone number", function () {
      clearSetting(A);
      var m = profile(PROV_A);
      HC.assert(m.showsPhone === true, "public page should show phone by default");
      HC.assert(m.phone != null && m.phone.length > 0, "public phone should be present");
      HC.assert(m.hidden === false, "should not be hidden by default");
    });

    // --- ACCEPTANCE: the toggle REMOVES the phone from the public page ---
    check("Toggling hide REMOVES the phone from the public page", function () {
      clearSetting(A);
      var before = profile(PROV_A);
      HC.assert(before.showsPhone === true && before.phone, "precondition: phone shown");
      var res = hidePhone(A);
      HC.assert(res.ok === true && res.hidden === true, "hide should succeed");
      var after = profile(PROV_A);
      HC.assert(after.showsPhone === false, "public page must NOT show phone after hide");
      HC.assert(after.phone === null, "public phone must be null after hide");
      HC.assert(after.phoneFormatted === null, "formatted public phone must be null after hide");
      HC.assert(after.hidden === true, "model should report hidden");
    });

    // --- ACCEPTANCE: provider still sees their number on file when hidden ---
    check("Provider still has the number on file even when hidden from public", function () {
      // (hidden from earlier check)
      var m = profile(PROV_A);
      HC.assert(m.hidden === true, "precondition: hidden");
      HC.assert(m.phoneOnFile && isValidPhone(m.phoneOnFile), "number is still on file");
      HC.assert(m.phone === null, "but the PUBLIC number is null");
    });

    // --- ACCEPTANCE: toggling back RESTORES the phone on the public page ---
    check("Toggling show RESTORES the phone on the public page", function () {
      var res = showPhone(A);
      HC.assert(res.ok === true && res.hidden === false, "show should succeed");
      var m = profile(PROV_A);
      HC.assert(m.showsPhone === true, "public page should show phone again");
      HC.assert(m.phone != null, "public phone restored");
    });

    // --- ACCEPTANCE: togglePhone flips state correctly ---
    check("togglePhone flips hidden state each call", function () {
      clearSetting(A);
      HC.assert(isHidden(A) === false, "starts visible");
      togglePhone(A);
      HC.assert(isHidden(A) === true, "first toggle hides");
      HC.assert(profile(PROV_A).showsPhone === false, "public hidden after first toggle");
      togglePhone(A);
      HC.assert(isHidden(A) === false, "second toggle shows");
      HC.assert(profile(PROV_A).showsPhone === true, "public shown after second toggle");
    });

    // --- ACCEPTANCE: per-provider — hiding A does not hide B ---
    check("Hiding one provider's phone does not affect another's", function () {
      clearSetting(A);
      clearSetting(B);
      hidePhone(A);
      HC.assert(profile(PROV_A).showsPhone === false, "A should be hidden");
      HC.assert(profile(PROV_B).showsPhone === true, "B should still be shown");
    });

    // --- Persistence: the hidden setting survives a reload ---
    check("Hidden setting persists across reloads", function () {
      clearSetting(A);
      hidePhone(A);
      // Simulate a fresh read straight from the store.
      var s = readSetting(A);
      HC.assert(s && s.hidden === true, "store should hold hidden=true");
      HC.assert(buildPublicProfile(PROV_A).showsPhone === false, "reloaded public page stays hidden");
    });

    // --- Override: a provider can correct the number; still hideable ---
    check("Provider can set a valid number; invalid numbers are rejected", function () {
      clearSetting(A);
      var bad = setPhone(A, "12");
      HC.assert(bad.ok === false, "too-short number should be rejected");
      var good = setPhone(A, "020 7946 0991");
      HC.assert(good.ok === true, "valid landline should be accepted");
      var m = profile(PROV_A);
      HC.assert(digitsOnly(m.phoneOnFile) === "02079460991", "override should be on file");
      HC.assert(m.showsPhone === true, "override number shows by default");
      hidePhone(A);
      HC.assert(profile(PROV_A).phone === null, "override number is also removable from public page");
    });

    // --- Formatting sanity ---
    check("UK numbers format for display", function () {
      HC.assert(formatPhone("07906446849") === "07906 446 849", "mobile format wrong: " + formatPhone("07906446849"));
      HC.assert(/^020 7946 0991$/.test(formatPhone("02079460991")), "landline format wrong: " + formatPhone("02079460991"));
    });

    // --- DOM (browser only): rendered public page reflects the toggle ---
    check("Rendered public DOM contains the number, and loses it when hidden", function () {
      if (typeof document === "undefined") { return; } // node --check has no DOM
      if (!providers.length) { return; }                // need a real provider id in the picker
      var pid = providers[0].id;
      clearSetting(pid);
      var host = document.createElement("div");
      render(host);
      var sel = host.querySelector("#hpProvider");
      if (sel) {
        for (var i = 0; i < sel.options.length; i++) {
          if (sel.options[i].value === pid) { sel.selectedIndex = i; break; }
        }
        sel.dispatchEvent(new Event("change", { bubbles: true }));
      }
      var shownNumber = formatPhone(resolvePhone(providers[0]));
      var pubText1 = (host.querySelector("#hpPublic") || {}).textContent || "";
      HC.assert(pubText1.indexOf(shownNumber) !== -1, "public DOM should contain the number when shown");

      // Click the red remove button.
      var btn = host.querySelector("#hpToggle");
      HC.assert(!!btn, "toggle button should render");
      btn.click();
      var pubText2 = (host.querySelector("#hpPublic") || {}).textContent || "";
      HC.assert(pubText2.indexOf(shownNumber) === -1, "public DOM must NOT contain the number after hide");
      HC.assert(/booking\/enquiry/i.test(pubText2), "public DOM should show the fallback contact line");
      clearSetting(pid);
    });

    // Leave the store as found.
    clearSetting(A);
    clearSetting(B);

    return { pass: pass, fail: fail, log: log };
  }

  /* ============================================================
   * 8. Register (idempotent + defensive via core).
   * ============================================================ */
  HC.registerFeature({
    id: "provider-hide-phone",
    title: "Hide phone number from your page",
    side: "provider",
    icon: "📵",
    summary: "Your booking phone number can show on your public camp page. A red button removes it " +
      "from the public page (mirroring Happity's Profile › Organisation › Contact). Toggle it back " +
      "on any time; the setting is saved per camp. Your number stays on file for you either way.",
    render: render,
    selfTest: selfTest
  });
})();
