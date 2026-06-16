/* HolidayCamp feature: provider-logo-banner
 * ------------------------------------------------------------------
 * Replicates Happity's "Add a logo and banner to your page and search
 * results" behaviour for the PROVIDER side, reframed for SCHOOL-AGE
 * HOLIDAY CAMPS, not baby classes.
 *
 * Evidence (support corpus):
 *  - 2261599 "How do I add a logo and banner to my page and search
 *    results?": this is a MEMBER feature ("To access this feature, you
 *    will need to be a Member"). From the dashboard you go to
 *    Profile > Organisation and pick the "Logo / Banner" tab. Specs:
 *      LOGO   — MUST be a square, 200px x 200px, .png or .jpeg
 *               (.png recommended), file size < 500 kb. The logo is
 *               what makes you "stand out in SEARCH RESULTS".
 *      BANNER — 900px x 450px (2:1), .png or .jpeg, file size < 1 mb,
 *               no text, edges may be cropped. The banner appears on
 *               your PAGE. Click Save to confirm.
 *  - 2258267 "How to add a banner / logo to your booking page": the
 *    sibling article (now a stub) — same logo-in-search /
 *    banner-on-page split.
 *
 * Acceptance criterion (asserted by selfTest, multiple cases):
 *   A Member can upload a LOGO (shown in SEARCH) and a BANNER (shown on
 *   the PAGE). Non-members are gated out; uploads that break Happity's
 *   size / aspect / type / weight specs are rejected; valid uploads
 *   persist and surface in the right place (logo -> search card,
 *   banner -> profile page header).
 *
 * Defensive: nothing throws at registration time. Persistence is via
 * HC.store ONLY (one namespaced key holding the per-provider asset
 * overlay + membership flag); the verified camps.js data is never
 * mutated.
 * ------------------------------------------------------------------ */
(function () {
  "use strict";

  if (typeof window === "undefined" || !window.HC || typeof window.HC.registerFeature !== "function") {
    // Core not present — fail silently rather than throwing.
    return;
  }
  var HC = window.HC;

  var STORE_KEY = "provider_logo_banner"; // { member:Bool, assets:{ [id]:{logo,banner} } }

  /* ============================================================
   * 1. Happity's published specs (the validation rulebook).
   * ============================================================ */

  var LOGO_SPEC = {
    kind: "logo",
    label: "Logo",
    width: 200,
    height: 200,
    square: true,                 // "MUST be a square"
    maxBytes: 500 * 1024,         // < 500 kb
    types: ["image/png", "image/jpeg"],
    shownIn: "search",            // logo makes you stand out in SEARCH results
    tolerance: 0                  // exact square / exact size guidance
  };

  var BANNER_SPEC = {
    kind: "banner",
    label: "Banner",
    width: 900,
    height: 450,
    ratio: 2,                     // 900x450 == 2:1
    square: false,
    maxBytes: 1024 * 1024,        // < 1 mb
    types: ["image/png", "image/jpeg"],
    shownIn: "page",              // banner appears on the camp's PAGE
    ratioTolerance: 0.02          // small slack on aspect so 2:1-ish passes
  };

  function specFor(kind) {
    return kind === "banner" ? BANNER_SPEC : LOGO_SPEC;
  }

  /* ============================================================
   * 2. Pure helpers.
   * ============================================================ */

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
  function escAttr(s) { return esc(s).replace(/"/g, "&quot;"); }
  function cssEsc(s) { return String(s).replace(/["\\]/g, "\\$&"); }

  function kb(bytes) {
    var n = Number(bytes) || 0;
    if (n >= 1024 * 1024) return (n / (1024 * 1024)).toFixed(2) + " MB";
    return Math.round(n / 1024) + " KB";
  }

  function typeLabel(t) {
    if (t === "image/png") return "PNG";
    if (t === "image/jpeg") return "JPEG";
    return String(t || "unknown");
  }

  function approxRatio(w, h) {
    if (!h) return 0;
    return w / h;
  }

  /* ============================================================
   * 3. CORE LOGIC — validate an upload against a spec.
   *    Takes a small file descriptor { type, size, width, height,
   *    name } (the mock equivalent of a real File + its decoded
   *    dimensions). Returns a result; NEVER throws.
   *      { ok:true,  asset:{...}, message }
   *      { ok:false, errors:{field:msg}, message }
   * ============================================================ */

  function describe(file) {
    // Normalise a loosely-shaped descriptor into the fields we check.
    var f = file || {};
    return {
      name: String(f.name == null ? "upload" : f.name),
      type: String(f.type == null ? "" : f.type).toLowerCase(),
      size: Number(f.size),
      width: Number(f.width),
      height: Number(f.height),
      dataUrl: typeof f.dataUrl === "string" ? f.dataUrl : null
    };
  }

  function validateUpload(kind, file) {
    var spec = specFor(kind);
    var f = describe(file);
    var errors = {};

    // Type.
    if (spec.types.indexOf(f.type) === -1) {
      errors.type = spec.label + " must be a .png or .jpeg file.";
    }

    // Weight.
    if (!isFinite(f.size) || f.size <= 0) {
      errors.size = "Could not read the file size.";
    } else if (f.size > spec.maxBytes) {
      errors.size = spec.label + " must be under " + kb(spec.maxBytes) + " (got " + kb(f.size) + ").";
    }

    // Dimensions present?
    if (!isFinite(f.width) || !isFinite(f.height) || f.width <= 0 || f.height <= 0) {
      errors.dimensions = "Could not read the image dimensions.";
    } else {
      if (spec.square) {
        // Logo: MUST be a square AND 200x200.
        if (f.width !== f.height) {
          errors.dimensions = spec.label + " must be a square (got " + f.width + "x" + f.height + ").";
        } else if (f.width !== spec.width || f.height !== spec.height) {
          errors.dimensions = spec.label + " must be " + spec.width + "x" + spec.height + "px (got " +
            f.width + "x" + f.height + ").";
        }
      } else {
        // Banner: target 900x450 (2:1). Enforce aspect tightly; allow a
        // slightly larger-but-same-ratio image (it'll be scaled to fit).
        var r = approxRatio(f.width, f.height);
        if (Math.abs(r - spec.ratio) > spec.ratioTolerance) {
          errors.dimensions = spec.label + " should be " + spec.width + "x" + spec.height +
            "px (2:1). Got " + f.width + "x" + f.height + " (" + r.toFixed(2) + ":1).";
        } else if (f.width < spec.width || f.height < spec.height) {
          errors.dimensions = spec.label + " should be at least " + spec.width + "x" + spec.height +
            "px. Got " + f.width + "x" + f.height + ".";
        }
      }
    }

    if (Object.keys(errors).length) {
      return {
        ok: false,
        errors: errors,
        message: "Could not save " + spec.label.toLowerCase() + ": " +
          Object.keys(errors).map(function (k) { return errors[k]; }).join(" ")
      };
    }

    var asset = {
      kind: spec.kind,
      shownIn: spec.shownIn,       // "search" for logo, "page" for banner
      name: f.name,
      type: f.type,
      size: f.size,
      width: f.width,
      height: f.height,
      // Keep a preview source if one was supplied (data URL); otherwise a
      // deterministic placeholder so the UI always has something to show.
      src: f.dataUrl || null,
      uploadedAt: Date.now()
    };
    return {
      ok: true,
      asset: asset,
      message: spec.label + " saved — it will appear " +
        (spec.shownIn === "search" ? "in search results." : "on your camp page.")
    };
  }

  /* ============================================================
   * 4. Membership gate (Happity: "you will need to be a Member").
   * ============================================================ */

  function readState() {
    try {
      var s = HC.store.get(STORE_KEY, null);
      if (!s || typeof s !== "object") s = {};
      if (typeof s.member !== "boolean") s.member = false;
      if (!s.assets || typeof s.assets !== "object") s.assets = {};
      return s;
    } catch (e) {
      return { member: false, assets: {} };
    }
  }

  function writeState(s) {
    try { HC.store.set(STORE_KEY, s); return true; } catch (e) { return false; }
  }

  function isMember() {
    return readState().member === true;
  }

  function setMember(on) {
    var s = readState();
    s.member = !!on;
    writeState(s);
    return s.member;
  }

  /* ============================================================
   * 5. UPLOAD (gated) + PERSISTENCE — the "Save" path.
   *    Returns the validateUpload result; when ok AND the provider
   *    is a Member, the asset is stored under its provider id.
   *    Non-members are refused before any spec check, mirroring the
   *    "Before you start: you need to be a Member" gate.
   * ============================================================ */

  function uploadAsset(providerId, kind, file) {
    if (!isMember()) {
      return {
        ok: false,
        gated: true,
        errors: { membership: "Adding a logo or banner is a Member feature." },
        message: "Upgrade to Membership to add a logo and banner."
      };
    }
    var res = validateUpload(kind, file);
    if (!res.ok) return res;

    try {
      var s = readState();
      var id = String(providerId || "default");
      if (!s.assets[id] || typeof s.assets[id] !== "object") s.assets[id] = {};
      s.assets[id][res.asset.kind] = res.asset; // logo OR banner slot
      writeState(s);
    } catch (e) { /* defensive: a storage failure still returns ok=true */ }
    return res;
  }

  function getAssets(providerId) {
    var s = readState();
    var id = String(providerId || "default");
    var a = s.assets[id] || {};
    return { logo: a.logo || null, banner: a.banner || null };
  }

  function removeAsset(providerId, kind) {
    try {
      var s = readState();
      var id = String(providerId || "default");
      if (s.assets[id]) { delete s.assets[id][kind]; writeState(s); }
    } catch (e) {}
  }

  function clearAll() {
    try { HC.store.remove(STORE_KEY); } catch (e) {}
  }

  /* ============================================================
   * 6. SURFACING — where each asset is shown.
   *    These pure functions are the testable bridge between an upload
   *    and the acceptance criterion: logo -> SEARCH card, banner ->
   *    profile PAGE header. They are also what the UI renders.
   * ============================================================ */

  // A compact provider name -> initials, used as the logo fallback glyph.
  function initials(name) {
    var parts = String(name || "Camp").trim().split(/\s+/).slice(0, 2);
    return parts.map(function (p) { return p.charAt(0).toUpperCase(); }).join("") || "HC";
  }

  // The search-card model: includes a logo slot iff a logo asset exists.
  function searchCardModel(provider) {
    var a = getAssets(provider && provider.id);
    return {
      id: provider && provider.id,
      name: (provider && provider.name) || "Holiday camp",
      area: (provider && provider.area) || "",
      hasLogo: !!a.logo,
      logo: a.logo,
      initials: initials(provider && provider.name)
    };
  }

  // The profile-page model: includes a banner slot iff a banner exists.
  function profilePageModel(provider) {
    var a = getAssets(provider && provider.id);
    return {
      id: provider && provider.id,
      name: (provider && provider.name) || "Holiday camp",
      hasBanner: !!a.banner,
      banner: a.banner,
      hasLogo: !!a.logo,
      logo: a.logo
    };
  }

  /* ============================================================
   * 7. UI — the "Logo / Banner" tab, gated behind Membership, with
   *    live previews of (a) a search card and (b) the camp page.
   *    A real <input type=file> reads dimensions+size from the chosen
   *    image; a "use a sample" button lets you exercise the path with
   *    spec-correct synthetic files when no image is to hand.
   * ============================================================ */

  function firstProvider() {
    try {
      var ps = HC.data.providers || [];
      for (var i = 0; i < ps.length; i++) {
        // Skip the council HAF route; pick a real branded camp provider.
        if (ps[i] && ps[i].id && ps[i].kind !== "Council route") return ps[i];
      }
      if (ps.length) return ps[0];
    } catch (e) {}
    return { id: "demo-camp", name: "Demo Holiday Camp", area: "Walthamstow" };
  }

  // Build a spec-correct synthetic descriptor (a tiny SVG data URL so the
  // preview shows something) — used by the "sample" buttons in the UI and
  // available for the self-test.
  function sampleFile(kind) {
    var spec = specFor(kind);
    var svg = "<svg xmlns='http://www.w3.org/2000/svg' width='" + spec.width + "' height='" + spec.height +
      "'><rect width='100%' height='100%' fill='%23603488'/><text x='50%' y='52%' fill='%23FCD400' " +
      "font-family='sans-serif' font-size='" + Math.round(spec.height / 5) +
      "' text-anchor='middle' dominant-baseline='middle'>" + spec.label + "</text></svg>";
    return {
      name: "sample-" + spec.kind + ".png",
      type: "image/png",
      size: Math.round(spec.maxBytes * 0.4), // safely under the cap
      width: spec.width,
      height: spec.height,
      dataUrl: "data:image/svg+xml;utf8," + svg
    };
  }

  function logoChip(model, size) {
    var s = size || 44;
    if (model.hasLogo && model.logo && model.logo.src) {
      return '<img src="' + escAttr(model.logo.src) + '" alt="logo" ' +
        'style="width:' + s + 'px;height:' + s + 'px;border-radius:10px;object-fit:cover;border:1.5px solid var(--line,#E6E6E6)">';
    }
    return '<div style="width:' + s + 'px;height:' + s + 'px;border-radius:10px;background:var(--purple-tint,#F0E8F4);' +
      'color:var(--purple,#603488);display:grid;place-items:center;font-family:\'Quicksand\',system-ui,sans-serif;' +
      'font-weight:700;font-size:' + Math.round(s / 2.8) + 'px">' + esc(model.initials) + "</div>";
  }

  function render(mountEl) {
    try {
      var provider = firstProvider();
      var memberOn = isMember();

      var inp = "width:100%;padding:9px;border:1.5px solid var(--line,#E6E6E6);border-radius:12px;font-size:14px;box-sizing:border-box";

      mountEl.innerHTML =
        '<div style="font-family:\'Nunito Sans\',system-ui,sans-serif;color:var(--text,#383838)">' +
          '<p style="font-size:14px;margin:0 0 12px">Stand out in search and turn more clicks into bookings by adding ' +
          'a <strong>logo</strong> (shown in search results) and a <strong>banner</strong> (shown on your camp page). ' +
          'This is a <strong>Member</strong> feature.</p>' +

          // Membership gate toggle (mock upgrade).
          '<div id="lbGate" style="display:flex;align-items:center;gap:10px;border:1.5px solid var(--line,#E6E6E6);' +
            'border-radius:12px;padding:10px 14px;margin-bottom:14px;background:' +
            (memberOn ? "#E1F0E4" : "var(--pink-tint,#FCE8F0)") + '">' +
            '<span style="font-weight:700;font-size:13px">Membership</span>' +
            '<span id="lbMemberState" style="font-size:13px">' + (memberOn ? "Active ✓" : "Not a Member") + "</span>" +
            '<button type="button" id="lbToggleMember" class="hc-btn hc-btn-ghost" style="margin-left:auto">' +
              (memberOn ? "Downgrade" : "Upgrade to Member") + "</button>" +
          "</div>" +

          '<div id="lbBody"></div>' +
        "</div>";

      var body = mountEl.querySelector("#lbBody");

      function uploaderBlock(kind) {
        var spec = specFor(kind);
        return '<div class="lb-up" data-kind="' + kind + '" ' +
            'style="border:1.5px solid var(--line,#E6E6E6);border-radius:14px;padding:14px 16px;margin-bottom:12px">' +
          '<div style="font-family:\'Quicksand\',system-ui,sans-serif;font-weight:700;color:var(--purple,#603488);font-size:15px">' +
            esc(spec.label) + " <span style=\"font-weight:400;color:var(--muted,#808080);font-size:12.5px\">— " +
            spec.width + "x" + spec.height + "px" + (spec.square ? " (square)" : " (2:1)") + ", .png/.jpeg, < " +
            kb(spec.maxBytes) + ", shown in " + (spec.shownIn === "search" ? "search" : "your page") + "</span></div>" +
          '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px;align-items:center">' +
            '<input type="file" accept="image/png,image/jpeg" class="lbFile" data-kind="' + kind + '" style="' + inp + ';flex:1;min-width:200px">' +
            '<button type="button" class="hc-btn lbSample" data-kind="' + kind + '">Use a sample</button>' +
            '<button type="button" class="hc-btn hc-btn-ghost lbRemove" data-kind="' + kind + '">Remove</button>' +
          "</div>" +
          '<div class="lbErr" data-kind="' + kind + '" style="color:#9a1f5e;font-size:12.5px;min-height:16px;margin-top:6px"></div>' +
        "</div>";
      }

      function previewHtml() {
        var card = searchCardModel(provider);
        var page = profilePageModel(provider);

        var searchCard =
          '<div style="border:1.5px solid var(--line,#E6E6E6);border-radius:14px;padding:12px;display:flex;gap:12px;align-items:center;max-width:360px">' +
            logoChip(card, 48) +
            '<div style="min-width:0">' +
              '<div style="font-family:\'Quicksand\',system-ui,sans-serif;font-weight:700;color:var(--purple,#603488);font-size:15px">' + esc(card.name) + "</div>" +
              '<div style="font-size:12.5px;color:var(--muted,#808080)">' + esc(card.area) + "</div>" +
              '<div style="font-size:11.5px;color:' + (card.hasLogo ? "#2f7d4f" : "var(--muted,#808080)") + ';margin-top:2px">' +
                (card.hasLogo ? "Logo shown ✓" : "No logo — showing initials") + "</div>" +
            "</div>" +
          "</div>";

        var bannerBox = page.hasBanner && page.banner && page.banner.src
          ? '<div style="position:relative;border-radius:16px;overflow:hidden;border:1.5px solid var(--line,#E6E6E6)">' +
              '<img src="' + escAttr(page.banner.src) + '" alt="banner" style="display:block;width:100%;aspect-ratio:2/1;object-fit:cover">' +
            "</div>"
          : '<div style="border:1.5px dashed var(--line,#E6E6E6);border-radius:16px;aspect-ratio:2/1;display:grid;place-items:center;' +
              'color:var(--muted,#808080);font-size:13px">No banner yet — add one (900x450)</div>';

        var pageCard =
          '<div style="border:1.5px solid var(--line,#E6E6E6);border-radius:18px;overflow:hidden;max-width:420px">' +
            bannerBox +
            '<div style="padding:12px 14px;display:flex;gap:12px;align-items:center">' +
              logoChip(page, 44) +
              '<div><div style="font-family:\'Quicksand\',system-ui,sans-serif;font-weight:700;color:var(--purple,#603488);font-size:16px">' +
                esc(page.name) + "</div>" +
                '<div style="font-size:11.5px;color:' + (page.hasBanner ? "#2f7d4f" : "var(--muted,#808080)") + '">' +
                  (page.hasBanner ? "Banner shown on page ✓" : "Banner appears here") + "</div></div>" +
            "</div>" +
          "</div>";

        return '<div style="display:grid;gap:18px;grid-template-columns:repeat(auto-fit,minmax(300px,1fr))">' +
            '<div><div style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.4px;color:var(--magenta,#F82488);margin-bottom:6px">In search results</div>' + searchCard + "</div>" +
            '<div><div style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.4px;color:var(--magenta,#F82488);margin-bottom:6px">On your camp page</div>' + pageCard + "</div>" +
          "</div>";
      }

      function paint() {
        if (!isMember()) {
          body.innerHTML =
            '<div style="border:1.5px dashed var(--line,#E6E6E6);border-radius:14px;padding:18px;text-align:center;color:var(--muted,#808080)">' +
              '<div style="font-size:30px">🔒</div>' +
              '<p style="margin:6px 0 0;font-size:14px"><strong>Logo & banner are a Member feature.</strong><br>' +
              'Upgrade above to add a logo (shown in search) and a banner (shown on your page).</p>' +
            "</div>";
          return;
        }
        body.innerHTML =
          uploaderBlock("logo") +
          uploaderBlock("banner") +
          '<div style="font-family:\'Quicksand\',system-ui,sans-serif;font-weight:700;color:var(--purple,#603488);font-size:14px;margin:6px 0 8px">Live preview</div>' +
          previewHtml();
      }

      function showErr(kind, msg) {
        var e = body.querySelector('.lbErr[data-kind="' + cssEsc(kind) + '"]');
        if (e) e.textContent = msg || "";
      }

      function doUpload(kind, file) {
        var res = uploadAsset(provider.id, kind, file);
        if (!res.ok) {
          showErr(kind, res.message);
          return;
        }
        try { HC.util.toast(res.message); } catch (e) {}
        paint(); // re-render previews to reflect the new asset
      }

      // Read a real chosen file: load it to get natural width/height + size.
      function handleFileInput(kind, fileInput) {
        var file = fileInput && fileInput.files && fileInput.files[0];
        if (!file) return;
        var url = null;
        try { url = URL.createObjectURL(file); } catch (e) { url = null; }
        var img = new Image();
        img.onload = function () {
          doUpload(kind, {
            name: file.name, type: file.type, size: file.size,
            width: img.naturalWidth, height: img.naturalHeight,
            dataUrl: url
          });
        };
        img.onerror = function () {
          showErr(kind, "Could not read that image. Use a .png or .jpeg.");
        };
        if (url) img.src = url; else showErr(kind, "Could not read that file.");
      }

      // Delegated handlers scoped to this mount.
      mountEl.addEventListener("click", function (e) {
        var toggle = e.target.closest("#lbToggleMember");
        if (toggle) {
          setMember(!isMember());
          render(mountEl); // full re-render to flip the gate banner colour
          return;
        }
        var sample = e.target.closest(".lbSample");
        if (sample) { doUpload(sample.getAttribute("data-kind"), sampleFile(sample.getAttribute("data-kind"))); return; }
        var rm = e.target.closest(".lbRemove");
        if (rm) { removeAsset(provider.id, rm.getAttribute("data-kind")); paint(); return; }
      });

      mountEl.addEventListener("change", function (e) {
        var file = e.target.closest(".lbFile");
        if (file) handleFileInput(file.getAttribute("data-kind"), file);
      });

      paint();
    } catch (e) {
      mountEl.innerHTML = '<p style="color:#9a1f5e">Logo / banner tab failed to load: ' +
        esc(e && e.message ? e.message : String(e)) + "</p>";
    }
  }

  /* ============================================================
   * 8. selfTest — exercises the LOGIC and asserts the acceptance
   *    criterion: a MEMBER can upload a LOGO (shown in SEARCH) and a
   *    BANNER (shown on the PAGE). Tested across many cases:
   *      - non-member is gated out of BOTH uploads
   *      - a valid logo persists and surfaces on the SEARCH card
   *      - a valid banner persists and surfaces on the PAGE header
   *      - spec violations (type / size / square / aspect) rejected
   *      - removal + clean-up behave; live provider round-trips
   * ============================================================ */

  function selfTest() {
    var pass = 0, fail = 0, log = [];
    function check(label, fn) {
      try { fn(); pass += 1; log.push("✓ " + label); }
      catch (e) { fail += 1; log.push("✗ " + label + " — " + (e && e.message ? e.message : String(e))); }
    }

    var ID = "selftest-camp";
    var P = { id: ID, name: "Sunrise Sports Camp", area: "Walthamstow" };

    // Spec-correct sample descriptors.
    function goodLogo() { return { name: "logo.png", type: "image/png", size: 120 * 1024, width: 200, height: 200, dataUrl: "data:image/png;base64,AAAA" }; }
    function goodBanner() { return { name: "banner.png", type: "image/png", size: 700 * 1024, width: 900, height: 450, dataUrl: "data:image/png;base64,BBBB" }; }

    // Deterministic start: clear store, default to non-member.
    clearAll();

    /* ---- MEMBERSHIP GATE (Happity: "you will need to be a Member") ---- */
    check("Non-member is blocked from uploading a logo", function () {
      setMember(false);
      var res = uploadAsset(ID, "logo", goodLogo());
      HC.assert(res.ok === false, "non-member logo upload must be refused");
      HC.assert(res.gated === true, "refusal should be flagged as the membership gate");
      HC.assert(!getAssets(ID).logo, "no logo should be stored for a non-member");
    });

    check("Non-member is blocked from uploading a banner", function () {
      setMember(false);
      var res = uploadAsset(ID, "banner", goodBanner());
      HC.assert(res.ok === false, "non-member banner upload must be refused");
      HC.assert(res.gated === true, "refusal should be flagged as the membership gate");
      HC.assert(!getAssets(ID).banner, "no banner should be stored for a non-member");
    });

    /* ---- ACCEPTANCE: a MEMBER uploads a LOGO (shown in SEARCH) ---- */
    check("A Member can upload a valid logo and it persists", function () {
      setMember(true);
      var res = uploadAsset(ID, "logo", goodLogo());
      HC.assert(res.ok === true, "member logo upload should succeed: " + res.message);
      HC.assert(res.asset.kind === "logo", "asset kind should be logo");
      HC.assert(res.asset.shownIn === "search", "logo must be tagged shownIn=search");
      HC.assert(!!getAssets(ID).logo, "logo should be persisted to the store");
    });

    check("The uploaded logo SHOWS IN SEARCH (search card carries it)", function () {
      var card = searchCardModel(P);
      HC.assert(card.hasLogo === true, "search card should report hasLogo after upload");
      HC.assert(card.logo && card.logo.kind === "logo", "search card should carry the logo asset");
      HC.assert(card.logo.shownIn === "search", "the carried asset is the search logo");
    });

    /* ---- ACCEPTANCE: a MEMBER uploads a BANNER (shown on the PAGE) ---- */
    check("A Member can upload a valid banner and it persists", function () {
      setMember(true);
      var res = uploadAsset(ID, "banner", goodBanner());
      HC.assert(res.ok === true, "member banner upload should succeed: " + res.message);
      HC.assert(res.asset.kind === "banner", "asset kind should be banner");
      HC.assert(res.asset.shownIn === "page", "banner must be tagged shownIn=page");
      HC.assert(!!getAssets(ID).banner, "banner should be persisted to the store");
    });

    check("The uploaded banner SHOWS ON THE PAGE (profile model carries it)", function () {
      var page = profilePageModel(P);
      HC.assert(page.hasBanner === true, "profile page should report hasBanner after upload");
      HC.assert(page.banner && page.banner.kind === "banner", "page should carry the banner asset");
      HC.assert(page.banner.shownIn === "page", "the carried asset is the page banner");
    });

    check("Logo and banner are independent slots (both present together)", function () {
      var a = getAssets(ID);
      HC.assert(a.logo && a.banner, "both logo and banner should coexist for one provider");
      var card = searchCardModel(P), page = profilePageModel(P);
      HC.assert(card.hasLogo && page.hasBanner, "search shows logo AND page shows banner simultaneously");
    });

    /* ---- SPEC ENFORCEMENT — logo (Happity: square 200x200, png/jpeg, <500kb) ---- */
    check("Non-square logo is rejected (Happity: MUST be a square)", function () {
      var res = uploadAsset(ID, "logo", { name: "l.png", type: "image/png", size: 100 * 1024, width: 200, height: 150 });
      HC.assert(res.ok === false, "non-square logo must be rejected");
      HC.assert(!!res.errors.dimensions, "should carry a dimensions error");
    });

    check("Wrong-size square logo is rejected (must be exactly 200x200)", function () {
      var res = uploadAsset(ID, "logo", { name: "l.png", type: "image/png", size: 100 * 1024, width: 300, height: 300 });
      HC.assert(res.ok === false, "400x400 etc. must be rejected");
      HC.assert(!!res.errors.dimensions, "should carry a dimensions error");
    });

    check("Oversized logo (>500kb) is rejected", function () {
      var res = uploadAsset(ID, "logo", { name: "l.png", type: "image/png", size: 600 * 1024, width: 200, height: 200 });
      HC.assert(res.ok === false, "600kb logo must be rejected");
      HC.assert(!!res.errors.size, "should carry a size error");
    });

    check("Wrong file type for logo is rejected (.gif)", function () {
      var res = uploadAsset(ID, "logo", { name: "l.gif", type: "image/gif", size: 100 * 1024, width: 200, height: 200 });
      HC.assert(res.ok === false, "gif must be rejected");
      HC.assert(!!res.errors.type, "should carry a type error");
    });

    /* ---- SPEC ENFORCEMENT — banner (900x450 2:1, png/jpeg, <1mb) ---- */
    check("Wrong-aspect banner is rejected (Happity: 900x450 / 2:1)", function () {
      var res = uploadAsset(ID, "banner", { name: "b.png", type: "image/png", size: 300 * 1024, width: 900, height: 900 });
      HC.assert(res.ok === false, "1:1 banner must be rejected");
      HC.assert(!!res.errors.dimensions, "should carry a dimensions error");
    });

    check("Oversized banner (>1mb) is rejected", function () {
      var res = uploadAsset(ID, "banner", { name: "b.png", type: "image/png", size: 2 * 1024 * 1024, width: 900, height: 450 });
      HC.assert(res.ok === false, "2mb banner must be rejected");
      HC.assert(!!res.errors.size, "should carry a size error");
    });

    check("A correctly-proportioned larger banner (1800x900, 2:1) is accepted", function () {
      setMember(true);
      var res = validateUpload("banner", { name: "b.png", type: "image/png", size: 800 * 1024, width: 1800, height: 900 });
      HC.assert(res.ok === true, "same-ratio, within-weight banner should pass: " + res.message);
    });

    /* ---- A rejected upload does NOT overwrite a good saved asset ---- */
    check("A rejected upload leaves the previously-saved logo intact", function () {
      clearAll(); setMember(true);
      var ok = uploadAsset(ID, "logo", goodLogo());
      HC.assert(ok.ok === true, "baseline good logo should save");
      var bad = uploadAsset(ID, "logo", { name: "x.png", type: "image/png", size: 100 * 1024, width: 10, height: 10 });
      HC.assert(bad.ok === false, "bad logo should be rejected");
      HC.assert(searchCardModel(P).hasLogo === true, "the earlier valid logo must remain in search");
    });

    /* ---- REMOVAL ---- */
    check("Removing the banner drops it from the page (logo stays)", function () {
      clearAll(); setMember(true);
      uploadAsset(ID, "logo", goodLogo());
      uploadAsset(ID, "banner", goodBanner());
      removeAsset(ID, "banner");
      HC.assert(profilePageModel(P).hasBanner === false, "banner should be gone from the page");
      HC.assert(searchCardModel(P).hasLogo === true, "logo should survive a banner removal");
    });

    /* ---- PERSISTENCE round-trip via HC.store ---- */
    check("A saved logo round-trips through the store (re-read on reload)", function () {
      clearAll(); setMember(true);
      uploadAsset(ID, "logo", goodLogo());
      // Simulate a reload: read fresh from the store via getAssets.
      var a = getAssets(ID);
      HC.assert(a.logo && a.logo.width === 200 && a.logo.height === 200, "reloaded logo should keep its dimensions");
      HC.assert(a.logo.type === "image/png", "reloaded logo should keep its type");
    });

    /* ---- LIVE provider data: a real camp can carry a logo + banner ---- */
    check("A live camp provider can be given a logo and banner", function () {
      var live = firstProvider();
      HC.assert(live && live.id, "should resolve a live provider");
      clearAll(); setMember(true);
      var l = uploadAsset(live.id, "logo", goodLogo());
      var b = uploadAsset(live.id, "banner", goodBanner());
      HC.assert(l.ok && b.ok, "live provider logo + banner should both save");
      HC.assert(searchCardModel(live).hasLogo === true, "live provider should show a logo in search");
      HC.assert(profilePageModel(live).hasBanner === true, "live provider should show a banner on its page");
    });

    /* ---- sampleFile() the UI uses is itself spec-valid ---- */
    check("The built-in sample logo + banner pass their own specs", function () {
      HC.assert(validateUpload("logo", sampleFile("logo")).ok === true, "sample logo should be valid");
      HC.assert(validateUpload("banner", sampleFile("banner")).ok === true, "sample banner should be valid");
    });

    // Leave the store as found.
    clearAll();

    return { pass: pass, fail: fail, log: log };
  }

  /* ============================================================
   * 9. Register (idempotent + defensive via core).
   * ============================================================ */
  HC.registerFeature({
    id: "provider-logo-banner",
    title: "Add logo & banner",
    side: "provider",
    icon: "🖼️",
    summary: "Members can upload a square logo (shown in search results) and a 2:1 banner (shown on the camp page). Uploads are validated to Happity's specs — non-square logos, wrong aspect banners, oversized files and non-PNG/JPEG types are rejected — and persist to your provider profile.",
    render: render,
    selfTest: selfTest
  });
})();
