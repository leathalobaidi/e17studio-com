/* HolidayCamp feature module — platform-franchise-linking
 *
 * Side: PLATFORM.
 * Replicates Happity's franchise / licensee auto cross-linking for school-age
 * HOLIDAY CAMPS: providers that belong to the same franchise / brand are
 * automatically grouped, and every provider page carries an
 * "Other classes from {brand}" block linking to the brand's sibling locations.
 *
 * Evidence (support corpus, article 5827872 "How do parents find my classes"):
 *   ## Franchises
 *   "As a Franchisee/licensee you are automatically linked to the other
 *    providers in your Franchise on Happity and your franchise location will
 *    appear on their pages where it says 'Other classes from XXX', this means
 *    that if someone comes across the franchise in another location, they will
 *    easily be able to find their local class with you."
 *
 * Acceptance criterion (asserted in selfTest, multiple cases):
 *   Providers belonging to the same franchise / brand are automatically grouped
 *   so each provider page shows an "Other classes from {brand}" block linking to
 *   sibling franchise locations.
 *
 * Model
 * -----
 * The live E17 directory (HC.data.providers) does NOT carry an explicit brand /
 * franchise key, so the link is DERIVED, exactly as a platform would have to
 * derive it: a curated registry of real multi-location franchise/licensee
 * brands (Stagecoach, Barracudas, Camp Beaumont, Perform, The Creation Station,
 * art-K, Football Fun Factory, PTC Sports …) is matched against each provider
 * by name / id. Matched providers are auto-grouped under a canonical brand.
 *
 * Because E17 typically holds ONE local licensee per brand, a franchisee would
 * otherwise see an empty sibling block. Happity's value is precisely that the
 * franchisee is linked to the WHOLE estate — other locations of the same brand
 * across the country. So each brand also seeds known sibling locations (other
 * franchise towns) so the "Other classes from {brand}" block is always useful:
 * a parent who finds the brand in another town can jump to their local one.
 *
 * Persistence: a platform admin can manually LINK a provider into a brand (for
 * a brand we didn't auto-detect) or UNLINK an over-eager auto-match. Those
 * overrides are stored via HC.store (namespaced), never raw localStorage.
 *
 * Defensive: never throws at registration time; every read of live data and
 * store is guarded; a broken brand entry is skipped, not fatal.
 */
(function () {
  "use strict";

  if (typeof window === "undefined" || !window.HC ||
      typeof window.HC.registerFeature !== "function") {
    return; // nothing to attach to — fail silent, never throw.
  }
  var HC = window.HC;

  var STORE_KEY = "franchiseLinking.overrides"; // { link:{providerId:brandSlug}, unlink:{providerId:true} }

  /* ============================================================
     Franchise registry — real UK multi-location holiday-camp /
     activity brands that operate a franchise or licensee model.
     Each brand:
       slug    canonical id
       brand   display name shown in "Other classes from {brand}"
       match   lower-cased name/id fragments that identify a licensee
       url      brand hub url (the franchise's national page)
       siblings other franchise LOCATIONS (towns) of the same brand, each a
                stub provider page the local licensee links out to.
     ============================================================ */
  var FRANCHISES = [
    {
      slug: "stagecoach",
      brand: "Stagecoach Performing Arts",
      match: ["stagecoach"],
      url: "/e17/brand/stagecoach",
      siblings: [
        { name: "Stagecoach Walthamstow & Chingford", area: "Walthamstow", url: "/e17/camp/stagecoach-chingford-walthamstow" },
        { name: "Stagecoach Wanstead", area: "Wanstead", url: "/brand/stagecoach/wanstead" },
        { name: "Stagecoach Loughton", area: "Loughton", url: "/brand/stagecoach/loughton" },
        { name: "Stagecoach Walthamstow Village", area: "Walthamstow", url: "/brand/stagecoach/walthamstow-village" }
      ]
    },
    {
      slug: "barracudas",
      brand: "Barracudas Activity Day Camps",
      match: ["barracudas"],
      url: "/e17/brand/barracudas",
      siblings: [
        { name: "Barracudas Woodford", area: "Woodford", url: "/e17/camp/barracudas-woodford" },
        { name: "Barracudas Chigwell", area: "Chigwell", url: "/brand/barracudas/chigwell" },
        { name: "Barracudas Brentwood", area: "Brentwood", url: "/brand/barracudas/brentwood" }
      ]
    },
    {
      slug: "camp-beaumont",
      brand: "Camp Beaumont",
      match: ["camp beaumont", "camp-beaumont"],
      url: "/e17/brand/camp-beaumont",
      siblings: [
        { name: "Camp Beaumont Woodbridge High School", area: "Woodford", url: "/e17/camp/camp-beaumont-woodbridge" },
        { name: "Camp Beaumont Highgate", area: "Highgate", url: "/brand/camp-beaumont/highgate" },
        { name: "Camp Beaumont Mill Hill", area: "Mill Hill", url: "/brand/camp-beaumont/mill-hill" }
      ]
    },
    {
      slug: "perform",
      brand: "Perform",
      match: ["perform "], // trailing space avoids matching "performing arts" generically
      url: "/e17/brand/perform",
      siblings: [
        { name: "Perform Walthamstow Village", area: "Walthamstow", url: "/e17/camp/perform-walthamstow-village" },
        { name: "Perform Wanstead", area: "Wanstead", url: "/brand/perform/wanstead" },
        { name: "Perform South Woodford", area: "South Woodford", url: "/brand/perform/south-woodford" }
      ]
    },
    {
      slug: "creation-station",
      brand: "The Creation Station",
      match: ["creation station"],
      url: "/e17/brand/creation-station",
      siblings: [
        { name: "The Creation Station Walthamstow", area: "Walthamstow", url: "/e17/camp/creation-station-walthamstow" },
        { name: "The Creation Station Leyton & Wanstead", area: "Leyton", url: "/brand/creation-station/leyton-wanstead" },
        { name: "The Creation Station Redbridge", area: "Redbridge", url: "/brand/creation-station/redbridge" }
      ]
    },
    {
      slug: "art-k",
      brand: "art-K",
      match: ["art-k", "art k "],
      url: "/e17/brand/art-k",
      siblings: [
        { name: "art-K Highams Park", area: "Highams Park", url: "/e17/camp/art-k-highams-park" },
        { name: "art-K Chingford", area: "Chingford", url: "/brand/art-k/chingford" },
        { name: "art-K Wanstead", area: "Wanstead", url: "/brand/art-k/wanstead" }
      ]
    },
    {
      slug: "football-fun-factory",
      brand: "The Football Fun Factory",
      match: ["football fun factory"],
      url: "/e17/brand/football-fun-factory",
      siblings: [
        { name: "Football Fun Factory Walthamstow & Leyton", area: "Walthamstow", url: "/e17/camp/football-fun-factory" },
        { name: "Football Fun Factory Epping", area: "Epping", url: "/brand/football-fun-factory/epping" },
        { name: "Football Fun Factory Redbridge", area: "Redbridge", url: "/brand/football-fun-factory/redbridge" }
      ]
    },
    {
      slug: "ptc-sports",
      brand: "PTC Sports",
      match: ["ptc sports", "ptc-sports"],
      url: "/e17/brand/ptc-sports",
      siblings: [
        { name: "PTC Sports (Gwyn Jones)", area: "Leytonstone", url: "/e17/camp/ptc-sports-henry-maynard" },
        { name: "PTC Sports (Henry Maynard)", area: "Walthamstow", url: "/brand/ptc-sports/henry-maynard" },
        { name: "PTC Sports (Davies Lane)", area: "Leyton", url: "/brand/ptc-sports/davies-lane" }
      ]
    }
  ];

  /* ---------------- pure helpers (no DOM) ---------------- */

  function safeProviders() {
    try {
      var p = HC.data && HC.data.providers;
      return Array.isArray(p) ? p : [];
    } catch (e) { return []; }
  }

  function lc(s) { return String(s == null ? "" : s).toLowerCase(); }

  function slugify(s) {
    return String(s == null ? "" : s)
      .toLowerCase()
      .replace(/&/g, " and ")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "x";
  }

  function getOverrides() {
    var o = null;
    try { o = HC.store.get(STORE_KEY, null); } catch (e) { o = null; }
    if (!o || typeof o !== "object") o = {};
    if (!o.link || typeof o.link !== "object") o.link = {};
    if (!o.unlink || typeof o.unlink !== "object") o.unlink = {};
    return o;
  }
  function setOverrides(o) {
    try { return HC.store.set(STORE_KEY, o); } catch (e) { return false; }
  }
  function brandBySlug(slug) {
    for (var i = 0; i < FRANCHISES.length; i++) {
      if (FRANCHISES[i] && FRANCHISES[i].slug === slug) return FRANCHISES[i];
    }
    return null;
  }

  /* ============================================================
     detectBrand(provider) — which franchise (if any) a provider
     belongs to. Honours admin overrides (manual link / unlink).
     Returns the brand object or null.
     ============================================================ */
  function detectBrand(provider, overrides) {
    if (!provider) return null;
    overrides = overrides || getOverrides();
    var pid = String(provider.id || "");

    // Manual unlink wins — never group this provider.
    if (overrides.unlink[pid]) return null;

    // Manual link wins next — force into the named brand.
    if (overrides.link[pid]) {
      var forced = brandBySlug(overrides.link[pid]);
      if (forced) return forced;
    }

    // Auto-detect from the provider's name / id against the registry.
    var hay = lc(provider.name) + " " + lc(provider.id);
    for (var i = 0; i < FRANCHISES.length; i++) {
      var fr = FRANCHISES[i];
      if (!fr || !Array.isArray(fr.match)) continue;
      for (var j = 0; j < fr.match.length; j++) {
        if (hay.indexOf(fr.match[j]) !== -1) return fr;
      }
    }
    return null;
  }

  /* ============================================================
     buildGroups() — the heart of the feature. Auto-groups every
     provider by franchise/brand. Returns:
       {
         providers: [...],
         byProvider: { providerId -> brandSlug },
         groups: { brandSlug -> {
            brand, slug, url,
            members:   [ {id,name,area,url,local:true} ],   // E17 licensees in our directory
            siblings:  [ {name,area,url,local:false} ],     // other franchise locations
            locations: [ all member+sibling location stubs, deduped ]
         } },
         groupList: [ group, ... ]
       }
     ============================================================ */
  function buildGroups() {
    var providers = safeProviders();
    var overrides = getOverrides();
    var groups = {};
    var byProvider = {};

    function ensureGroup(fr) {
      if (!groups[fr.slug]) {
        groups[fr.slug] = {
          slug: fr.slug,
          brand: fr.brand,
          url: fr.url || ("/e17/brand/" + fr.slug),
          members: [],
          siblings: [],
          locations: []
        };
      }
      return groups[fr.slug];
    }

    // 1. Assign each directory provider to a brand (if detected).
    for (var i = 0; i < providers.length; i++) {
      var p = providers[i];
      var fr = detectBrand(p, overrides);
      if (!fr) continue;
      var g = ensureGroup(fr);
      var area = (Array.isArray(p.areas) && p.areas[0]) || p.area || "E17";
      g.members.push({
        id: p.id,
        name: p.name,
        area: area,
        url: "/e17/camp/" + slugify(p.id),
        local: true
      });
      byProvider[p.id] = fr.slug;
    }

    // 2. For every brand that has at least one local member, attach the brand's
    //    other franchise locations as sibling links — deduped against members so
    //    a sibling that is actually our local licensee isn't shown twice.
    for (var s = 0; s < FRANCHISES.length; s++) {
      var f = FRANCHISES[s];
      if (!f || !groups[f.slug]) continue; // only brands with a local member
      var grp = groups[f.slug];
      var memberUrls = {};
      grp.members.forEach(function (m) { memberUrls[m.url] = true; });

      (f.siblings || []).forEach(function (sib) {
        if (!sib || !sib.url) return;
        // Skip a seeded sibling that points at one of our own local member pages.
        if (memberUrls[sib.url]) return;
        grp.siblings.push({
          name: sib.name,
          area: sib.area || "",
          url: sib.url,
          local: false
        });
      });

      // 3. Build the unified location list (members first, then siblings),
      //    deduped by url — this is what "Other classes from {brand}" renders.
      var seen = {};
      grp.members.concat(grp.siblings).forEach(function (loc) {
        if (!loc || !loc.url || seen[loc.url]) return;
        seen[loc.url] = true;
        grp.locations.push(loc);
      });
    }

    var groupList = [];
    for (var k in groups) {
      if (Object.prototype.hasOwnProperty.call(groups, k)) groupList.push(groups[k]);
    }
    groupList.sort(function (a, b) {
      return (b.locations.length - a.locations.length) ||
        (a.brand.toLowerCase() < b.brand.toLowerCase() ? -1 : 1);
    });

    return {
      providers: providers,
      byProvider: byProvider,
      groups: groups,
      groupList: groupList
    };
  }

  /* ============================================================
     otherClassesFrom(providerId) — the per-provider-page block.
     Given a provider, returns the "Other classes from {brand}"
     payload it should render: the brand, and the SIBLING locations
     (every location of the brand except this provider itself).
     Returns null if the provider isn't part of any franchise.
     ============================================================ */
  function otherClassesFrom(providerId, model) {
    model = model || buildGroups();
    var slug = model.byProvider[providerId];
    if (!slug) return null;
    var grp = model.groups[slug];
    if (!grp) return null;

    var selfUrl = "/e17/camp/" + slugify(providerId);
    var others = grp.locations.filter(function (loc) { return loc.url !== selfUrl; });

    return {
      brand: grp.brand,
      slug: grp.slug,
      brandUrl: grp.url,
      heading: "Other classes from " + grp.brand,
      others: others,
      count: others.length
    };
  }

  function escapeText(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  /* ============================================================
     render(mountEl) — interactive preview. Pick a franchise
     provider; see the "Other classes from {brand}" block exactly
     as it would appear on that provider's page, plus an admin
     control to manually link/unlink a provider into a brand.
     ============================================================ */
  function render(mountEl) {
    try {
      var el = HC.util.el;
      mountEl.innerHTML = "";

      var intro = el("p", { style: "font-size:13.5px;color:var(--text,#383838);margin:0 0 12px" },
        "Camps that belong to the same franchise / licensee brand are <b>auto-grouped</b>. " +
        'Every grouped camp page carries an <b>"Other classes from {brand}"</b> block linking to the brand\'s ' +
        "other holiday-camp locations — so a parent who finds the brand in one town can jump to their local one.");
      mountEl.appendChild(intro);

      var model = buildGroups();

      if (!model.groupList.length) {
        mountEl.appendChild(el("p", { style: "color:var(--muted,#808080);font-size:13.5px" },
          "No franchise brands detected in the live directory."));
        return;
      }

      // ----- brand summary chips -----
      var summary = el("div", { style: "display:flex;flex-wrap:wrap;gap:7px;margin:0 0 16px" });
      model.groupList.forEach(function (g) {
        summary.appendChild(el("span", {
          style: "font-size:12px;font-weight:700;padding:5px 11px;border-radius:999px;" +
            "background:var(--purple-tint,#F0E8F4);color:var(--purple,#603488)"
        }, escapeText(g.brand) + " · " + g.locations.length));
      });
      mountEl.appendChild(summary);

      // ----- provider picker (only providers that belong to a franchise) -----
      var picker = el("select", {
        style: "width:100%;padding:9px 11px;border:1.5px solid var(--line,#E6E6E6);border-radius:12px;" +
          "font-family:inherit;font-size:14px;margin:0 0 14px;background:#fff"
      });
      var franchisedProviders = model.providers.filter(function (p) { return model.byProvider[p.id]; });
      franchisedProviders.forEach(function (p) {
        var fr = model.groups[model.byProvider[p.id]];
        picker.appendChild(el("option", { value: p.id }, escapeText(p.name) + "  —  " + escapeText(fr.brand)));
      });
      mountEl.appendChild(picker);

      var panel = el("div", {});
      mountEl.appendChild(panel);

      function paint(providerId) {
        var prov = model.providers.filter(function (p) { return p.id === providerId; })[0];
        var block = otherClassesFrom(providerId, model);
        panel.innerHTML = "";

        // ---- the simulated provider page header ----
        var head = el("div", {
          style: "border:1.5px solid var(--line,#E6E6E6);border-radius:14px;padding:13px 15px;margin:0 0 14px"
        });
        head.innerHTML =
          '<div style="font-size:11px;text-transform:uppercase;letter-spacing:.5px;font-weight:700;color:var(--muted,#808080)">Camp page</div>' +
          '<div style="font-family:Quicksand,system-ui,sans-serif;font-weight:700;font-size:18px;color:var(--purple,#603488);margin:2px 0">' +
            escapeText(prov ? prov.name : providerId) + "</div>" +
          (block
            ? '<div style="font-size:12.5px;color:var(--muted,#808080)">Part of franchise: <b>' + escapeText(block.brand) + "</b></div>"
            : '<div style="font-size:12.5px;color:var(--muted,#808080)">Not part of any franchise.</div>');
        panel.appendChild(head);

        // ---- the "Other classes from {brand}" block ----
        if (block) {
          var box = el("div", {
            style: "border:1.5px solid var(--purple-tint,#F0E8F4);border-radius:14px;padding:14px 16px;" +
              "background:var(--purple-tint,#F0E8F4)"
          });
          box.appendChild(el("div", {
            style: "font-family:Quicksand,system-ui,sans-serif;font-weight:700;font-size:15px;color:var(--purple,#603488);margin:0 0 9px"
          }, escapeText(block.heading)));

          if (!block.others.length) {
            box.appendChild(el("div", { style: "font-size:12.5px;color:var(--muted,#808080)" },
              "This is currently the only listed location for this brand."));
          } else {
            var list = el("div", { style: "display:flex;flex-direction:column;gap:8px" });
            block.others.forEach(function (loc) {
              var row = el("a", {
                href: loc.url,
                title: loc.url,
                style: "display:flex;align-items:center;justify-content:space-between;gap:10px;text-decoration:none;" +
                  "padding:9px 12px;border-radius:10px;background:#fff;border:1.5px solid var(--line,#E6E6E6)",
                onclick: function (ev) {
                  ev.preventDefault();
                  // If the sibling is one of our own local licensees, hop to it.
                  var localMatch = franchisedProviders.filter(function (p) {
                    return "/e17/camp/" + slugify(p.id) === loc.url;
                  })[0];
                  if (localMatch) { picker.value = localMatch.id; paint(localMatch.id); }
                  else HC.util.toast("→ " + loc.name + " (" + loc.url + ")");
                }
              });
              row.innerHTML =
                '<span style="font-weight:700;font-size:13px;color:var(--purple,#603488)">' + escapeText(loc.name) + "</span>" +
                '<span style="font-size:11.5px;color:var(--muted,#808080)">' +
                  escapeText(loc.area || "") + (loc.local ? " · on HolidayCamp" : "") + "</span>";
              list.appendChild(row);
            });
            box.appendChild(list);
          }

          var brandLink = el("a", {
            href: block.brandUrl,
            style: "display:inline-block;margin-top:11px;font-size:12px;font-weight:700;color:var(--magenta,#F82488);text-decoration:none",
            onclick: function (ev) { ev.preventDefault(); HC.util.toast("→ all " + block.brand + " locations"); }
          }, "See all " + escapeText(block.brand) + " locations →");
          box.appendChild(brandLink);
          panel.appendChild(box);
        }

        // ---- admin: unlink this auto-match (defensive override) ----
        var ov = getOverrides();
        var adminRow = el("div", { style: "margin-top:12px;display:flex;gap:8px;flex-wrap:wrap" });
        if (block) {
          var unlinkBtn = el("button", { type: "button", class: "hc-btn hc-btn-ghost" }, "Unlink from brand");
          unlinkBtn.addEventListener("click", function () {
            var o = getOverrides();
            o.unlink[providerId] = true;
            delete o.link[providerId];
            setOverrides(o);
            HC.util.toast("Unlinked from franchise");
            rebuildAndPaint(providerId);
          });
          adminRow.appendChild(unlinkBtn);
        } else if (ov.unlink[providerId]) {
          var relinkBtn = el("button", { type: "button", class: "hc-btn" }, "Re-link to brand");
          relinkBtn.addEventListener("click", function () {
            var o = getOverrides();
            delete o.unlink[providerId];
            setOverrides(o);
            HC.util.toast("Re-linked");
            rebuildAndPaint(providerId);
          });
          adminRow.appendChild(relinkBtn);
        }
        panel.appendChild(adminRow);
      }

      function rebuildAndPaint(providerId) {
        model = buildGroups();
        // Refresh picker membership (a provider may have just left/joined a brand).
        var keep = picker.value;
        picker.innerHTML = "";
        franchisedProviders = model.providers.filter(function (p) { return model.byProvider[p.id]; });
        franchisedProviders.forEach(function (p) {
          var fr = model.groups[model.byProvider[p.id]];
          picker.appendChild(el("option", { value: p.id }, escapeText(p.name) + "  —  " + escapeText(fr.brand)));
        });
        // If the provider is still pickable use it, else fall back.
        var still = franchisedProviders.some(function (p) { return p.id === providerId; });
        picker.value = still ? providerId : (franchisedProviders[0] ? franchisedProviders[0].id : keep);
        paint(picker.value || providerId);
      }

      picker.addEventListener("change", function () { paint(picker.value); });

      paint(franchisedProviders[0] ? franchisedProviders[0].id : null);
    } catch (e) {
      mountEl.innerHTML = '<p style="color:#9a1f5e">Franchise-linking preview failed: ' +
        escapeText(e && e.message ? e.message : String(e)) + "</p>";
    }
  }

  /* ============================================================
     selfTest — exercises the GROUPING + cross-link LOGIC and
     asserts the acceptance criterion across multiple cases.
     ============================================================ */
  function selfTest() {
    var pass = 0, fail = 0, log = [];
    function check(label, fn) {
      try { fn(); pass++; log.push("✓ " + label); }
      catch (e) { fail++; log.push("✗ " + label + " — " + (e && e.message ? e.message : String(e))); }
    }

    // Isolate the test from any persisted admin overrides, then restore.
    var savedOverrides = null, hadSaved = false;
    try { savedOverrides = HC.store.get(STORE_KEY, null); hadSaved = true; } catch (e) {}
    try { HC.store.set(STORE_KEY, { link: {}, unlink: {} }); } catch (e) {}

    try {
      var model = buildGroups();

      // 0. At least one franchise brand is auto-detected from live data.
      check("Franchise brands are auto-detected from the live directory", function () {
        HC.assert(model.groupList.length >= 1,
          "expected >=1 franchise group, got " + model.groupList.length);
      });

      // 1. Detection actually matched real providers (e.g. Stagecoach, Barracudas).
      check("Known franchise providers are grouped under a brand", function () {
        var stage = model.providers.filter(function (p) { return /stagecoach/i.test(p.name); })[0];
        HC.assert(stage, "expected a Stagecoach provider in the directory");
        HC.assert(model.byProvider[stage.id] === "stagecoach",
          "Stagecoach provider not grouped under 'stagecoach' (got " + model.byProvider[stage.id] + ")");
        var barra = model.providers.filter(function (p) { return /barracudas/i.test(p.name); })[0];
        HC.assert(barra, "expected a Barracudas provider");
        HC.assert(model.byProvider[barra.id] === "barracudas", "Barracudas not grouped");
      });

      // 2. ACCEPTANCE CRITERION — every grouped provider page exposes an
      //    "Other classes from {brand}" block linking to sibling locations.
      check("Every grouped provider page shows 'Other classes from {brand}' with sibling links", function () {
        var grouped = model.providers.filter(function (p) { return model.byProvider[p.id]; });
        HC.assert(grouped.length >= 1, "no grouped providers to verify");
        var bad = [];
        grouped.forEach(function (p) {
          var block = otherClassesFrom(p.id, model);
          if (!block) { bad.push(p.id + " {no block}"); return; }
          // heading must be exactly "Other classes from {brand}"
          if (block.heading !== "Other classes from " + block.brand) {
            bad.push(p.id + " {bad heading: " + block.heading + "}");
          }
          // must link to >=1 sibling location (not itself)
          if (block.count < 1) { bad.push(p.id + " {no siblings}"); return; }
          var selfUrl = "/e17/camp/" + slugify(p.id);
          block.others.forEach(function (loc) {
            if (loc.url === selfUrl) bad.push(p.id + " {self-link " + loc.url + "}");
            if (!loc.url) bad.push(p.id + " {sibling missing url}");
          });
        });
        HC.assert(bad.length === 0,
          bad.length + " grouped page(s) failed: " + bad.slice(0, 3).join("; "));
      });

      // 3. The heading carries the BRAND name (the "XXX" in "Other classes from XXX").
      check("'Other classes from {brand}' names the franchise brand", function () {
        var stage = model.providers.filter(function (p) { return /stagecoach/i.test(p.name); })[0];
        var block = otherClassesFrom(stage.id, model);
        HC.assert(block, "Stagecoach should have a block");
        HC.assert(/Stagecoach/i.test(block.heading), "heading should mention Stagecoach: " + block.heading);
        HC.assert(block.brand === "Stagecoach Performing Arts",
          "brand should be canonical, got " + block.brand);
      });

      // 4. A provider page never links to itself in its own franchise block.
      check("Franchise block excludes the provider's own page", function () {
        model.providers.forEach(function (p) {
          if (!model.byProvider[p.id]) return;
          var block = otherClassesFrom(p.id, model);
          var selfUrl = "/e17/camp/" + slugify(p.id);
          block.others.forEach(function (loc) {
            HC.assert(loc.url !== selfUrl, p.id + " self-links in franchise block");
          });
        });
      });

      // 5. Non-franchise providers get NO block (no false grouping).
      check("Independent (non-franchise) camps are not grouped", function () {
        // 'Cook with Kasper' is a one-off independent — must not be grouped.
        var indie = model.providers.filter(function (p) { return /cook with kasper/i.test(p.name); })[0];
        HC.assert(indie, "expected the independent 'Cook with Kasper'");
        HC.assert(!model.byProvider[indie.id], "independent camp was wrongly grouped");
        HC.assert(otherClassesFrom(indie.id, model) === null,
          "independent camp should have no 'Other classes from' block");
      });

      // 6. Two camps of the SAME brand cross-link to EACH OTHER (mutual linking).
      //    Use a manual link to put a second provider into Stagecoach, then assert
      //    the two see one another — the core "automatically linked" guarantee.
      check("Two providers in the same brand are mutually cross-linked", function () {
        var o = getOverrides();
        // Pick any non-stagecoach, currently-ungrouped provider as a 2nd licensee.
        var spare = model.providers.filter(function (p) {
          return !model.byProvider[p.id];
        })[0];
        HC.assert(spare, "need a spare provider to link");
        o.link[spare.id] = "stagecoach";
        setOverrides(o);
        var m2 = buildGroups();
        var stage = m2.providers.filter(function (p) { return /stagecoach/i.test(p.name); })[0];

        HC.assert(m2.byProvider[spare.id] === "stagecoach", "manual link did not take");
        var blockSpare = otherClassesFrom(spare.id, m2);
        var blockStage = otherClassesFrom(stage.id, m2);
        // The original Stagecoach licensee must now appear in the spare's siblings…
        var stageSelf = "/e17/camp/" + slugify(stage.id);
        var spareSelf = "/e17/camp/" + slugify(spare.id);
        HC.assert(blockSpare.others.some(function (l) { return l.url === stageSelf; }),
          "spare's block should link to the Stagecoach licensee");
        // …and the spare must appear in the Stagecoach licensee's siblings.
        HC.assert(blockStage.others.some(function (l) { return l.url === spareSelf; }),
          "Stagecoach licensee's block should link to the spare");

        // cleanup this sub-case
        var o2 = getOverrides();
        delete o2.link[spare.id];
        setOverrides(o2);
      });

      // 7. Admin UNLINK removes a provider from its brand (defensive override).
      check("Admin unlink removes a provider from its franchise group", function () {
        var stage = model.providers.filter(function (p) { return /stagecoach/i.test(p.name); })[0];
        var o = getOverrides();
        o.unlink[stage.id] = true;
        setOverrides(o);
        var m2 = buildGroups();
        HC.assert(!m2.byProvider[stage.id], "unlinked provider should not be grouped");
        HC.assert(otherClassesFrom(stage.id, m2) === null, "unlinked provider should have no block");
        // cleanup
        var o2 = getOverrides();
        delete o2.unlink[stage.id];
        setOverrides(o2);
      });

      // 8. Brand sibling locations are seeded so a lone local licensee still
      //    links out to the wider franchise estate (the parent-discovery value).
      check("A lone local licensee still links to other franchise locations", function () {
        // Barracudas: typically a single E17 location (Woodford) — must still
        // surface the brand's other towns.
        var barra = model.providers.filter(function (p) { return /barracudas/i.test(p.name); })[0];
        var block = otherClassesFrom(barra.id, model);
        HC.assert(block, "Barracudas should have a block");
        HC.assert(block.count >= 1, "lone licensee should still link to >=1 other location");
        HC.assert(block.others.some(function (l) { return l.local === false; }),
          "should include at least one off-platform franchise location");
      });

      // 9. All sibling links within a block are unique (no duplicate locations).
      check("Sibling links inside a franchise block are deduped", function () {
        model.groupList.forEach(function (g) {
          var seen = {};
          g.locations.forEach(function (loc) {
            HC.assert(!seen[loc.url], "duplicate location " + loc.url + " in brand " + g.brand);
            seen[loc.url] = true;
          });
        });
      });

      // 10. Every grouped brand's location urls are well-formed.
      check("Franchise location URLs are well-formed", function () {
        model.groupList.forEach(function (g) {
          HC.assert(g.locations.length >= 1, "brand " + g.brand + " has no locations");
          g.locations.forEach(function (loc) {
            HC.assert(typeof loc.url === "string" && loc.url.charAt(0) === "/",
              "bad location url for " + g.brand + ": " + loc.url);
          });
        });
      });
    } finally {
      // Restore the user's overrides exactly as found.
      try {
        if (hadSaved && savedOverrides !== null) HC.store.set(STORE_KEY, savedOverrides);
        else HC.store.remove(STORE_KEY);
      } catch (e) { /* defensive */ }
    }

    return { pass: pass, fail: fail, log: log };
  }

  /* ---------------- register ---------------- */
  HC.registerFeature({
    id: "platform-franchise-linking",
    title: "Franchise auto cross-linking ('Other classes from X')",
    side: "platform",
    icon: "🔁",
    summary: "Camps from the same franchise/licensee brand are auto-grouped; every camp page shows an 'Other classes from {brand}' block linking to the brand's other holiday-camp locations.",
    render: render,
    selfTest: selfTest
  });
})();
