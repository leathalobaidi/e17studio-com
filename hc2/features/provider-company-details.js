/* HolidayCamp feature: provider-company-details
 * ------------------------------------------------------------------
 * Replicates Happity's "Company details / website / contact" editing
 * for the PROVIDER side, reframed for SCHOOL-AGE HOLIDAY CAMPS.
 *
 * Evidence (support corpus):
 *  - 7338528 "How do I update the Company Details on my profile?":
 *    Profile icon -> Organisation. "Here you can update/amend details
 *    about your business and your contact details that are visible on
 *    your public Happity profile." Covers Contact, Social media and
 *    Company details.
 *  - 8310557 "How do I change my website link or other contact
 *    details?": Profile -> Organisation -> Contact tab. "Change your
 *    website / URL or any other contact details", then "remember to
 *    click 'Save'!".
 *  - 8217596 "How can I edit my email address?": Profile ->
 *    Organisation -> Contact button. Amend the customer-facing email
 *    address displayed, then Save.
 *  - 6394536 (related) "My phone number is showing on the site, how do
 *    I remove this?": contact fields can be shown/hidden from the
 *    public profile — modelled here as a per-field "show on public
 *    profile" toggle.
 *
 * Acceptance criterion (asserted by selfTest, multiple cases):
 *   "Provider can edit website link, contact details and company name."
 *   A valid edit to company name, website and contact details is
 *   validated, persisted via HC.store, and reflected back; invalid
 *   input (blank name, malformed website/email) is rejected and the
 *   saved record is left unchanged.
 *
 * Defensive: nothing throws at registration time. Persistence is via
 * HC.store ONLY (one namespaced overlay key); the verified camps.js
 * data is never mutated.
 * ------------------------------------------------------------------ */
(function () {
  "use strict";

  if (typeof window === "undefined" || !window.HC || typeof window.HC.registerFeature !== "function") {
    // Core not present — fail silently rather than throwing.
    return;
  }
  var HC = window.HC;

  var STORE_KEY = "provider_company_details"; // { [providerId]: {details...} }

  var NAME_MAX = 80;
  var TAGLINE_MAX = 120;

  /* ============================================================
   * 1. Pure helpers + validation.
   *    Field semantics mirror Happity's Organisation > Contact tab:
   *    company name, website/URL, public email, public phone, plus
   *    social handles. Each contact field can be shown or hidden on
   *    the public profile (see evidence 6394536).
   * ============================================================ */

  function trimStr(s) { return String(s == null ? "" : s).replace(/\s+/g, " ").trim(); }

  // Normalise a website. Accepts bare domains and adds https:// so a
  // provider typing "happycamp.co.uk" still saves a usable link.
  function normaliseUrl(raw) {
    var s = trimStr(raw);
    if (!s) return "";
    if (!/^https?:\/\//i.test(s)) s = "https://" + s;
    return s;
  }

  // A website is valid if, once normalised, it parses to an http(s) URL
  // with a dotted host (e.g. example.com). Rejects "not a url", spaces.
  function isValidUrl(raw) {
    var s = normaliseUrl(raw);
    if (!s) return false;
    var m = /^https?:\/\/([^\/\s?#]+)(?:[\/?#]|$)/i.exec(s);
    if (!m) return false;
    var host = m[1];
    // must contain a dot, no spaces, and a sane TLD-ish tail.
    if (/\s/.test(host)) return false;
    return /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(host);
  }

  // Email: standard-enough single-address check (customer-facing email).
  function isValidEmail(raw) {
    var s = trimStr(raw);
    if (!s) return false;
    return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s);
  }

  // Phone: optional; if present must look like a UK-ish number
  // (digits, spaces, +, (), -, min 7 digits). Empty is allowed.
  function isValidPhone(raw) {
    var s = trimStr(raw);
    if (!s) return true; // optional
    if (!/^[0-9+()\-\s]+$/.test(s)) return false;
    var digits = s.replace(/\D/g, "");
    return digits.length >= 7 && digits.length <= 15;
  }

  // Build a clean public-profile view of contact details, honouring
  // the per-field "public" flags. Hidden fields are omitted entirely —
  // this is what a parent would see on the live listing.
  function publicView(details) {
    var d = details || {};
    var out = { companyName: trimStr(d.companyName) };
    if (d.tagline) out.tagline = trimStr(d.tagline);
    if (d.websitePublic && d.website) out.website = d.website;
    if (d.emailPublic && d.email) out.email = d.email;
    if (d.phonePublic && d.phone) out.phone = d.phone;
    var socials = {};
    if (d.social && typeof d.social === "object") {
      ["instagram", "facebook"].forEach(function (k) {
        var v = trimStr(d.social[k]);
        if (v) socials[k] = v.replace(/^@+/, "");
      });
    }
    if (Object.keys(socials).length) out.social = socials;
    return out;
  }

  /* ============================================================
   * 2. Seed an editable record from the LIVE camp data, then layer
   *    any saved overlay on top — exactly as a provider would see
   *    their Organisation > Contact tab pre-filled with what is on
   *    their listing today.
   * ============================================================ */

  function seedFromProvider(provider) {
    var p = provider || {};
    var web = "";
    try {
      web = (p.url && trimStr(p.url)) ||
        (p.source && p.source.url && trimStr(p.source.url)) || "";
    } catch (e) { web = ""; }
    return {
      providerId: (p.id != null ? String(p.id) : HC.util.uid()),
      companyName: trimStr(p.name) || "Untitled provider",
      tagline: trimStr(p.goodFor || p.summary || "").slice(0, TAGLINE_MAX),
      website: web ? normaliseUrl(web) : "",
      websitePublic: true,
      email: "",                 // not in camps.js; provider fills in.
      emailPublic: true,
      phone: "",
      phonePublic: false,        // mirrors 6394536: phone hidden by default.
      social: { instagram: "", facebook: "" }
    };
  }

  function readOverlay() {
    var all = HC.store.get(STORE_KEY, {});
    return (all && typeof all === "object") ? all : {};
  }

  // The merged record a provider edits: seed + saved overlay.
  function getRecord(provider) {
    var seed = seedFromProvider(provider);
    var saved = readOverlay()[seed.providerId];
    if (saved && typeof saved === "object") {
      var merged = {};
      for (var k in seed) if (Object.prototype.hasOwnProperty.call(seed, k)) merged[k] = seed[k];
      for (var j in saved) if (Object.prototype.hasOwnProperty.call(saved, j)) merged[j] = saved[j];
      // social is nested — merge defensively.
      merged.social = {
        instagram: trimStr((saved.social && saved.social.instagram) || seed.social.instagram),
        facebook: trimStr((saved.social && saved.social.facebook) || seed.social.facebook)
      };
      return merged;
    }
    return seed;
  }

  /* ============================================================
   * 3. Validate an edit. Returns { ok, errors:{field:msg}, clean }.
   *    `clean` is the normalised record ready to persist.
   *    Acceptance-critical fields: companyName, website, contact
   *    details (email/phone).
   * ============================================================ */

  function validate(input) {
    var errors = {};
    var src = input || {};
    var name = trimStr(src.companyName);
    if (!name) errors.companyName = "Company name is required.";
    else if (name.length > NAME_MAX) errors.companyName = "Company name must be " + NAME_MAX + " characters or fewer.";

    var website = trimStr(src.website);
    if (website && !isValidUrl(website)) errors.website = "Enter a valid website, e.g. yourcamp.co.uk";

    var email = trimStr(src.email);
    if (email && !isValidEmail(email)) errors.email = "Enter a valid contact email address.";

    var phone = trimStr(src.phone);
    if (!isValidPhone(phone)) errors.phone = "Enter a valid phone number, or leave it blank.";

    // A public contact channel is good practice: at least one of
    // website / email should be present so parents can reach the camp.
    if (!website && !email) {
      errors._contact = "Add at least a website or a contact email so families can reach you.";
    }

    var clean = {
      providerId: src.providerId != null ? String(src.providerId) : "",
      companyName: name,
      tagline: trimStr(src.tagline).slice(0, TAGLINE_MAX),
      website: website ? normaliseUrl(website) : "",
      websitePublic: !!src.websitePublic,
      email: email,
      emailPublic: !!src.emailPublic,
      phone: phone,
      phonePublic: !!src.phonePublic,
      social: {
        instagram: trimStr(src.social && src.social.instagram).replace(/^@+/, ""),
        facebook: trimStr(src.social && src.social.facebook).replace(/^@+/, "")
      }
    };

    return { ok: Object.keys(errors).length === 0, errors: errors, clean: clean };
  }

  // Persist a validated record into the overlay (never mutates camps.js).
  function save(input) {
    var v = validate(input);
    if (!v.ok) return v;
    var all = readOverlay();
    all[v.clean.providerId] = v.clean;
    HC.store.set(STORE_KEY, all);
    return v;
  }

  /* ============================================================
   * 4. Render — the Organisation > Contact tab, reframed.
   * ============================================================ */

  function firstProvider() {
    var list = HC.data.providers || [];
    return list.length ? list[0] : null;
  }

  function escAttr(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function render(mountEl) {
    try {
      var provider = firstProvider();
      var rec = getRecord(provider);
      var providerName = provider ? (provider.name || rec.providerId) : "your provider";

      mountEl.innerHTML =
        '<style>' +
          '.pcd-wrap{font-family:"Nunito Sans",system-ui,sans-serif;color:var(--text,#383838)}' +
          '.pcd-tabs{display:flex;gap:6px;margin:0 0 14px;border-bottom:1.5px solid var(--line,#E6E6E6)}' +
          '.pcd-tab{background:none;border:none;cursor:default;font-family:"Quicksand",system-ui,sans-serif;font-weight:700;' +
            'font-size:13px;padding:8px 12px;color:var(--muted,#808080)}' +
          '.pcd-tab.on{color:var(--purple,#603488);border-bottom:2.5px solid var(--magenta,#F82488)}' +
          '.pcd-field{margin:0 0 13px}' +
          '.pcd-field label{display:block;font-family:"Quicksand",system-ui,sans-serif;font-weight:700;font-size:12.5px;' +
            'color:var(--purple,#603488);margin:0 0 4px}' +
          '.pcd-field input{width:100%;box-sizing:border-box;border:1.5px solid var(--line,#E6E6E6);border-radius:12px;' +
            'padding:9px 12px;font-size:14px;font-family:inherit}' +
          '.pcd-field input:focus{outline:none;border-color:var(--purple,#603488)}' +
          '.pcd-row{display:flex;gap:10px;align-items:center;margin-top:4px}' +
          '.pcd-row label{display:flex;align-items:center;gap:6px;font-weight:600;font-size:12px;color:var(--muted,#808080);margin:0}' +
          '.pcd-err{color:#9a1f5e;font-size:12px;margin-top:3px;min-height:0}' +
          '.pcd-hint{color:var(--muted,#808080);font-size:11.5px;margin:2px 0 0}' +
          '.pcd-two{display:grid;grid-template-columns:1fr 1fr;gap:10px}' +
          '.pcd-actions{display:flex;gap:10px;margin-top:8px}' +
          '.pcd-preview{margin-top:18px;border:1.5px dashed var(--purple-tint,#F0E8F4);border-radius:14px;padding:13px 15px;' +
            'background:#FBF8FD}' +
          '.pcd-preview h4{font-family:"Quicksand",system-ui,sans-serif;color:var(--magenta,#F82488);text-transform:uppercase;' +
            'letter-spacing:.5px;font-size:11px;margin:0 0 8px}' +
          '.pcd-preview .pcd-pname{font-family:"Quicksand",system-ui,sans-serif;font-weight:700;font-size:16px;color:var(--purple,#603488)}' +
          '.pcd-preview ul{margin:6px 0 0;padding-left:18px;font-size:13px;line-height:1.7}' +
          '@media(max-width:520px){.pcd-two{grid-template-columns:1fr}}' +
        '</style>' +
        '<div class="pcd-wrap">' +
          '<p style="font-size:13.5px;margin:0 0 12px">Profile &rsaquo; Organisation &rsaquo; <strong>Contact</strong> — edit the company ' +
            'details, website and contact info shown on <strong>' + escAttr(providerName) + '</strong>’s public holiday-camp profile.</p>' +
          '<div class="pcd-tabs">' +
            '<button type="button" class="pcd-tab">Company</button>' +
            '<button type="button" class="pcd-tab on">Contact</button>' +
            '<button type="button" class="pcd-tab">Social media</button>' +
          '</div>' +
          '<form id="pcdForm" novalidate>' +
            '<div class="pcd-field">' +
              '<label for="pcdName">Company / camp name *</label>' +
              '<input id="pcdName" name="companyName" type="text" maxlength="' + NAME_MAX + '" value="' + escAttr(rec.companyName) + '">' +
              '<div class="pcd-err" data-err="companyName"></div>' +
            '</div>' +
            '<div class="pcd-field">' +
              '<label for="pcdTagline">Short tagline</label>' +
              '<input id="pcdTagline" name="tagline" type="text" maxlength="' + TAGLINE_MAX + '" value="' + escAttr(rec.tagline) + '">' +
              '<p class="pcd-hint">A one-line summary shown under your name in search results.</p>' +
            '</div>' +
            '<div class="pcd-field">' +
              '<label for="pcdWebsite">Website / booking link</label>' +
              '<input id="pcdWebsite" name="website" type="text" placeholder="yourcamp.co.uk" value="' + escAttr(rec.website) + '">' +
              '<div class="pcd-row"><label><input type="checkbox" id="pcdWebPub"' + (rec.websitePublic ? ' checked' : '') + '> Show on public profile</label></div>' +
              '<div class="pcd-err" data-err="website"></div>' +
            '</div>' +
            '<div class="pcd-two">' +
              '<div class="pcd-field">' +
                '<label for="pcdEmail">Contact email</label>' +
                '<input id="pcdEmail" name="email" type="text" placeholder="hello@yourcamp.co.uk" value="' + escAttr(rec.email) + '">' +
                '<div class="pcd-row"><label><input type="checkbox" id="pcdEmailPub"' + (rec.emailPublic ? ' checked' : '') + '> Public</label></div>' +
                '<div class="pcd-err" data-err="email"></div>' +
              '</div>' +
              '<div class="pcd-field">' +
                '<label for="pcdPhone">Contact phone</label>' +
                '<input id="pcdPhone" name="phone" type="text" placeholder="020 7000 0000" value="' + escAttr(rec.phone) + '">' +
                '<div class="pcd-row"><label><input type="checkbox" id="pcdPhonePub"' + (rec.phonePublic ? ' checked' : '') + '> Public</label></div>' +
                '<div class="pcd-err" data-err="phone"></div>' +
              '</div>' +
            '</div>' +
            '<div class="pcd-err" data-err="_contact"></div>' +
            '<div class="pcd-two">' +
              '<div class="pcd-field">' +
                '<label for="pcdInsta">Instagram</label>' +
                '<input id="pcdInsta" name="instagram" type="text" placeholder="@yourcamp" value="' + escAttr(rec.social.instagram) + '">' +
              '</div>' +
              '<div class="pcd-field">' +
                '<label for="pcdFb">Facebook</label>' +
                '<input id="pcdFb" name="facebook" type="text" placeholder="yourcamp" value="' + escAttr(rec.social.facebook) + '">' +
              '</div>' +
            '</div>' +
            '<div class="pcd-actions">' +
              '<button type="submit" class="hc-btn">Save</button>' +
              '<button type="button" class="hc-btn hc-btn-ghost" id="pcdReset">Reset</button>' +
            '</div>' +
          '</form>' +
          '<div class="pcd-preview" id="pcdPreview"></div>' +
        '</div>';

      var form = mountEl.querySelector("#pcdForm");
      var preview = mountEl.querySelector("#pcdPreview");

      function collect() {
        return {
          providerId: rec.providerId,
          companyName: form.companyName.value,
          tagline: form.tagline.value,
          website: form.website.value,
          websitePublic: mountEl.querySelector("#pcdWebPub").checked,
          email: form.email.value,
          emailPublic: mountEl.querySelector("#pcdEmailPub").checked,
          phone: form.phone.value,
          phonePublic: mountEl.querySelector("#pcdPhonePub").checked,
          social: { instagram: form.instagram.value, facebook: form.facebook.value }
        };
      }

      function clearErrors() {
        mountEl.querySelectorAll("[data-err]").forEach(function (n) { n.textContent = ""; });
      }

      function showErrors(errors) {
        clearErrors();
        for (var f in errors) {
          if (!Object.prototype.hasOwnProperty.call(errors, f)) continue;
          var n = mountEl.querySelector('[data-err="' + f + '"]');
          if (n) n.textContent = errors[f];
        }
      }

      function renderPreview() {
        var pv = publicView(getRecord(provider));
        var items = [];
        if (pv.tagline) items.push("<li><em>" + escAttr(pv.tagline) + "</em></li>");
        if (pv.website) items.push("<li>🌐 " + escAttr(pv.website) + "</li>");
        if (pv.email) items.push("<li>✉️ " + escAttr(pv.email) + "</li>");
        if (pv.phone) items.push("<li>📞 " + escAttr(pv.phone) + "</li>");
        if (pv.social && pv.social.instagram) items.push("<li>📸 @" + escAttr(pv.social.instagram) + "</li>");
        if (pv.social && pv.social.facebook) items.push("<li>👥 " + escAttr(pv.social.facebook) + "</li>");
        preview.innerHTML =
          '<h4>What parents see</h4>' +
          '<div class="pcd-pname">' + escAttr(pv.companyName) + '</div>' +
          (items.length ? '<ul>' + items.join("") + '</ul>'
            : '<p class="pcd-hint">No public contact details yet.</p>');
      }

      form.addEventListener("submit", function (e) {
        e.preventDefault();
        var res = save(collect());
        if (!res.ok) {
          showErrors(res.errors);
          HC.util.toast("Please fix the highlighted fields");
          return;
        }
        clearErrors();
        renderPreview();
        HC.util.toast("Company details saved");
      });

      mountEl.querySelector("#pcdReset").addEventListener("click", function () {
        var all = readOverlay();
        delete all[rec.providerId];
        HC.store.set(STORE_KEY, all);
        render(mountEl); // re-seed from live data
        HC.util.toast("Reset to listing details");
      });

      renderPreview();
    } catch (e) {
      mountEl.innerHTML = '<p style="color:#9a1f5e">Company details editor failed to render: ' +
        escAttr(e && e.message ? e.message : String(e)) + "</p>";
    }
  }

  /* ============================================================
   * 5. selfTest — exercises the LOGIC and asserts the acceptance
   *    criterion: "Provider can edit website link, contact details
   *    and company name." Multiple cases, save/round-trip, and the
   *    invalid-input rejection path. Restores the store afterwards.
   * ============================================================ */

  function selfTest() {
    var pass = 0, fail = 0, log = [];
    function check(label, fn) {
      try { fn(); pass += 1; log.push("✓ " + label); }
      catch (e) { fail += 1; log.push("✗ " + label + " — " + (e && e.message ? e.message : String(e))); }
    }

    // Snapshot + sandbox the real store so the test never leaks state.
    var BACKUP = HC.store.get(STORE_KEY, null);
    HC.store.set(STORE_KEY, {});

    try {
      var provider = firstProvider() || { id: "test-provider", name: "Test Camp Co" };
      var pid = provider.id != null ? String(provider.id) : "test-provider";

      // --- URL validation logic ---
      check("Valid websites pass (bare domain, www, https)", function () {
        HC.assert(isValidUrl("happycamp.co.uk"), "bare domain should be valid");
        HC.assert(isValidUrl("www.happycamp.co.uk"), "www domain should be valid");
        HC.assert(isValidUrl("https://happycamp.co.uk/book"), "https path should be valid");
      });
      check("Invalid websites are rejected", function () {
        HC.assert(!isValidUrl("not a url"), "spaces should fail");
        HC.assert(!isValidUrl("happycamp"), "no TLD should fail");
        HC.assert(!isValidUrl("http://"), "empty host should fail");
      });
      check("Bare domains are normalised to https://", function () {
        HC.assert(normaliseUrl("happycamp.co.uk") === "https://happycamp.co.uk",
          "got " + normaliseUrl("happycamp.co.uk"));
      });

      // --- Email validation logic ---
      check("Email validation accepts valid, rejects invalid", function () {
        HC.assert(isValidEmail("hello@happycamp.co.uk"), "valid email should pass");
        HC.assert(!isValidEmail("hello@bad"), "missing TLD should fail");
        HC.assert(!isValidEmail("hello world@x.com"), "spaces should fail");
      });

      // --- Phone validation logic (optional field) ---
      check("Phone validation: optional, format-checked", function () {
        HC.assert(isValidPhone(""), "blank phone is allowed");
        HC.assert(isValidPhone("020 7000 0000"), "UK-style number is valid");
        HC.assert(!isValidPhone("abc"), "letters should fail");
        HC.assert(!isValidPhone("123"), "too short should fail");
      });

      // === ACCEPTANCE CRITERION ===
      // Provider edits company name, website link AND contact details,
      // saves, and the change is persisted + reflected back.
      check("ACCEPTANCE: provider edits name + website + contact, and it saves", function () {
        var edit = {
          providerId: pid,
          companyName: "Adventure Holiday Camps E17",
          tagline: "Action-packed school-holiday fun",
          website: "adventurecamps-e17.co.uk",          // bare domain
          websitePublic: true,
          email: "bookings@adventurecamps-e17.co.uk",   // contact detail
          emailPublic: true,
          phone: "020 8500 1234",                       // contact detail
          phonePublic: true,
          social: { instagram: "@adventurecampse17", facebook: "AdventureCampsE17" }
        };
        var res = save(edit);
        HC.assert(res.ok, "a valid full edit must save: " + JSON.stringify(res.errors));

        var saved = getRecord(provider);
        HC.assert(saved.companyName === "Adventure Holiday Camps E17", "company name not persisted: " + saved.companyName);
        HC.assert(saved.website === "https://adventurecamps-e17.co.uk", "website link not persisted/normalised: " + saved.website);
        HC.assert(saved.email === "bookings@adventurecamps-e17.co.uk", "contact email not persisted: " + saved.email);
        HC.assert(saved.phone === "020 8500 1234", "contact phone not persisted: " + saved.phone);
        HC.assert(saved.social.instagram === "adventurecampse17", "instagram handle (sans @) not persisted: " + saved.social.instagram);
      });

      check("Saved details survive a fresh read (round-trip persistence)", function () {
        var again = getRecord(provider);
        HC.assert(again.companyName === "Adventure Holiday Camps E17", "name lost on reload");
        HC.assert(again.website === "https://adventurecamps-e17.co.uk", "website lost on reload");
      });

      check("Public view hides fields flagged not-public (evidence 6394536)", function () {
        // Re-save with phone hidden; it must disappear from the public view.
        var res = save({
          providerId: pid,
          companyName: "Adventure Holiday Camps E17",
          website: "adventurecamps-e17.co.uk", websitePublic: true,
          email: "bookings@adventurecamps-e17.co.uk", emailPublic: true,
          phone: "020 8500 1234", phonePublic: false,
          social: { instagram: "", facebook: "" }
        });
        HC.assert(res.ok, "edit should save");
        var pv = publicView(getRecord(provider));
        HC.assert(!pv.phone, "hidden phone must not appear in public view");
        HC.assert(pv.website === "https://adventurecamps-e17.co.uk", "public website should still show");
        HC.assert(pv.email === "bookings@adventurecamps-e17.co.uk", "public email should still show");
      });

      // --- Rejection paths: invalid input must NOT corrupt the record ---
      check("Blank company name is rejected; saved record unchanged", function () {
        var before = getRecord(provider).companyName;
        var res = save({ providerId: pid, companyName: "   ", website: "x.co.uk", email: "a@b.co" });
        HC.assert(!res.ok, "blank name must be rejected");
        HC.assert(res.errors.companyName, "should flag companyName");
        HC.assert(getRecord(provider).companyName === before, "record must be unchanged after a rejected save");
      });

      check("Malformed website is rejected; saved record unchanged", function () {
        var before = getRecord(provider).website;
        var res = save({ providerId: pid, companyName: "Adventure Holiday Camps E17", website: "not a website", email: "a@b.co" });
        HC.assert(!res.ok, "bad website must be rejected");
        HC.assert(res.errors.website, "should flag website");
        HC.assert(getRecord(provider).website === before, "website must be unchanged after a rejected save");
      });

      check("Malformed contact email is rejected", function () {
        var res = save({ providerId: pid, companyName: "Adventure Holiday Camps E17", website: "x.co.uk", email: "nope@nope" });
        HC.assert(!res.ok, "bad email must be rejected");
        HC.assert(res.errors.email, "should flag email");
      });

      check("Editing requires at least one reachable channel", function () {
        var res = save({ providerId: pid, companyName: "Reachless Camp", website: "", email: "" });
        HC.assert(!res.ok, "no website AND no email must be rejected");
        HC.assert(res.errors._contact, "should flag the missing-contact rule");
      });

      check("Seed pre-fills the form from live camps.js data", function () {
        var seed = seedFromProvider(provider);
        HC.assert(seed.companyName && seed.companyName.length > 0, "seed should carry a company name");
        HC.assert(typeof seed.websitePublic === "boolean", "seed should carry public flags");
      });

      check("Overlay is namespaced and never mutates camps.js", function () {
        var liveName = provider.name;
        getRecord(provider); // touch
        HC.assert(provider.name === liveName, "live provider object must be untouched");
        var raw = HC.store.get(STORE_KEY, {});
        HC.assert(raw && raw[pid], "overlay must hold the edited record under the provider id");
      });

    } finally {
      // Restore the real store exactly as found.
      if (BACKUP === null) HC.store.remove(STORE_KEY);
      else HC.store.set(STORE_KEY, BACKUP);
    }

    return { pass: pass, fail: fail, log: log };
  }

  /* ============================================================
   * 6. Register.
   * ============================================================ */

  HC.registerFeature({
    id: "provider-company-details",
    title: "Edit company details & contact",
    side: "provider",
    icon: "🏢",
    summary: "Organisation › Contact tab — edit your company name, website / booking link, contact email & phone, and social handles shown on your public holiday-camp profile.",
    render: render,
    selfTest: selfTest
  });
})();
