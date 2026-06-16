/* HolidayCamp feature — platform-venue-pages
 *
 * Per-venue aggregation pages  (platform side)
 *
 * Replicates Happity's venue-page behaviour. Verbatim evidence from the
 * Happity support corpus (article 10225786, "How to add a class to your
 * timetable"):
 *
 *   "When you add a new venue, it gets its own page on Happity showing ALL
 *    classes at that location. These pages rank well in Google and help
 *    parents discover you."
 *
 * Also referenced: 02-ia-ux T3 (venue pages are a distinct node in the IA) and
 * 04-seo §1.5 (per-venue landing pages are an organic-search surface). On the
 * provider side, HolidayCamp already splits one programme into one listing per
 * venue (see provider-multi-venue). THIS feature is the PUBLIC, platform-owned
 * flip side: it aggregates EVERY camp running at a given site onto a single
 * indexable page — the thing Google ranks and parents land on.
 *
 * Framed for SCHOOL-AGE HOLIDAY CAMPS: a parent searching "holiday camp at
 * Lloyd Park" lands on the Lloyd Park venue page and sees every camp — across
 * different providers — that runs at Lloyd Park, with weeks, ages, funding and
 * a deep link to each provider.
 *
 * ACCEPTANCE CRITERION (asserted in selfTest):
 *   A page per venue lists EVERY camp running at that site.
 *
 * Self-contained, defensive, no imports/exports. Calls HC.registerFeature.
 */
(function () {
  "use strict";

  // Defensive: never throw at module load if HC isn't present.
  if (typeof window === "undefined" || !window.HC || typeof window.HC.registerFeature !== "function") {
    if (typeof console !== "undefined" && console.warn) {
      console.warn("[HC] platform-venue-pages: HC core not found; skipping registration.");
    }
    return;
  }

  var HC = window.HC;

  var STORE_KEY = "platform_venue_pages_pins"; // parent-pinned venue pages (mock persistence)

  /* ---------------- small helpers ---------------- */

  function asText(v) {
    return typeof v === "string" ? v : (v == null ? "" : String(v));
  }

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function el(tag, attrs, html) {
    try { return HC.util.el(tag, attrs, html); }
    catch (e) {
      var n = document.createElement(tag || "div");
      if (html != null) n.innerHTML = html;
      return n;
    }
  }

  function slugify(s) {
    return asText(s).toLowerCase()
      .replace(/&/g, " and ")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 70) || "venue";
  }

  // Pull a UK-ish postcode out of a string. "" if none.
  function extractPostcode(str) {
    var s = asText(str).toUpperCase();
    var full = s.match(/\b([A-Z]{1,2}\d[A-Z\d]?)\s?(\d[A-Z]{2})\b/);
    if (full) return full[1] + " " + full[2];
    var out = s.match(/\b([A-Z]{1,2}\d[A-Z\d]?)\b/);
    return out ? out[1] : "";
  }

  /* ---------------- venue-name parsing ---------------- */
  /*
   * Provider records carry a free-text `venue` string. Many real E17 camps run
   * one programme across several named sites, joined in prose, e.g.:
   *   "Whittingham Primary Academy and Handsworth Primary School"
   *   "Lloyd Park Centre and Higham Hill Centre"
   *   "Woodside, George Tomlinson, Score Leyton and other sites"
   *   "art-K Highams Park"
   *
   * splitVenues() turns that prose into discrete venue names so each named site
   * can own a page. It deliberately drops vague catch-alls ("other sites",
   * "multiple venues", "varies by holiday") which are not a real, page-able
   * location.
   */

  // Phrases that are NOT a concrete, page-able venue.
  var VAGUE_RE = /^(?:and\s+)?(?:other\s+sites?|multiple\s+(?:waltham\s+forest\s+)?venues?|local\s+(?:walthamstow\s+(?:and\s+chingford\s+)?)?sites?|various\s+venues?|venues?\s+vary(?:\s+by\s+holiday)?|club\s+sites?|match\s+day\s+centres?|walthamstow\s+and\s+surrounding\s+areas?|waltham\s+forest\s+venues?(?:\s+vary)?)$/i;

  function isVagueVenue(name) {
    var n = asText(name).trim();
    if (!n) return true;
    if (VAGUE_RE.test(n)) return true;
    // generic "multiple ... sites" style
    if (/\b(?:multiple|various|several)\b/i.test(n) && /\b(?:site|venue|centre|center)s?\b/i.test(n)) return true;
    return false;
  }

  function splitVenues(venueStr) {
    var s = asText(venueStr).trim();
    if (!s) return [];
    // Split on commas, " and ", " / ", semicolons — the connectors used in the data.
    var parts = s
      .split(/\s*(?:,|;|\/|\band\b|\&)\s*/i)
      .map(function (p) { return p.replace(/\s+/g, " ").trim(); })
      .filter(Boolean);

    if (!parts.length) parts = [s];

    var out = [];
    var seen = {};
    for (var i = 0; i < parts.length; i++) {
      var name = parts[i].replace(/^the\s+/i, "").trim();
      if (!name) continue;
      if (isVagueVenue(name)) continue;
      // Drop bare postcodes that survived the split (they're not a venue name).
      if (/^[A-Z]{1,2}\d[A-Z\d]?(\s?\d[A-Z]{2})?$/i.test(name)) continue;
      var key = name.toLowerCase();
      if (seen[key]) continue;
      seen[key] = true;
      out.push(name);
    }
    return out;
  }

  /* ---------------- planner glue (weeks running at a site) ---------------- */

  function plannerFor(providerId) {
    try {
      var p = HC.data.planner;
      var byId = (p && p.byId) || {};
      return byId[providerId] || null;
    } catch (e) { return null; }
  }

  // Human label for which summer weeks a camp confirms (best-effort, defensive).
  function weeksLabel(providerId) {
    var rec = plannerFor(providerId);
    if (!rec) return "";
    if (Array.isArray(rec.weeks) && rec.weeks.length) {
      return "Summer weeks " + rec.weeks.join(", ");
    }
    if (rec.weeksLikely) return "Runs summer camps (confirm weeks)";
    return "";
  }

  /* ---------------- THE CORE: build the venue index ---------------- */
  /*
   * buildVenueIndex(providers) returns an array of venue pages:
   *   { id, name, slug, postcode, areas:[...], camps:[ {camp...} ] }
   * Each venue page lists EVERY camp whose `venue` string names that site.
   * One camp can appear on several venue pages (it runs at several sites) — and
   * one venue page can list several camps from different providers. That
   * many-to-many fan-out is the whole point of an aggregation page.
   */
  function buildVenueIndex(providers) {
    var list = Array.isArray(providers) ? providers : [];
    var byVenue = {}; // slug -> page

    for (var i = 0; i < list.length; i++) {
      var prov = list[i] || {};
      var venueNames = splitVenues(prov.venue);
      // If the provider has no parseable named venue, it doesn't anchor a page
      // (it's a borough-wide / multi-site route) — but we still don't lose it:
      // it can be reached via its area. We simply don't invent a fake venue.
      for (var v = 0; v < venueNames.length; v++) {
        var vname = venueNames[v];
        var slug = slugify(vname);
        if (!byVenue[slug]) {
          byVenue[slug] = {
            id: slug,
            name: vname,
            slug: slug,
            postcode: extractPostcode(vname) || extractPostcode(prov.address),
            areas: [],
            _areaSeen: {},
            camps: [],
            _campSeen: {}
          };
        }
        var page = byVenue[slug];

        // Prefer the most specific postcode we can find for this page.
        if (!page.postcode) {
          page.postcode = extractPostcode(vname) || extractPostcode(prov.address);
        }

        // Collect the areas this venue serves.
        var areas = Array.isArray(prov.areas) ? prov.areas : (prov.area ? [prov.area] : []);
        for (var a = 0; a < areas.length; a++) {
          var ar = asText(areas[a]).trim();
          if (ar && !page._areaSeen[ar.toLowerCase()]) {
            page._areaSeen[ar.toLowerCase()] = true;
            page.areas.push(ar);
          }
        }

        // Add the camp to this venue page (de-duped by provider id).
        var campKey = asText(prov.id) || slugify(prov.name);
        if (!page._campSeen[campKey]) {
          page._campSeen[campKey] = true;
          page.camps.push({
            id: prov.id,
            name: prov.name,
            kind: prov.kind,
            ageLabel: prov.ageLabel || ((prov.ageMin != null && prov.ageMax != null) ? (prov.ageMin + "-" + prov.ageMax) : ""),
            categories: Array.isArray(prov.categories) ? prov.categories.slice() : [],
            funding: Array.isArray(prov.funding) ? prov.funding.slice() : [],
            hours: prov.hours || "",
            price: prov.price || "",
            free: isFreeOrHaf(prov),
            weeks: weeksLabel(prov.id),
            source: prov.source || null
          });
        }
      }
    }

    // Finalise: drop internal scratch fields, sort camps & pages stably.
    var pages = Object.keys(byVenue).map(function (k) {
      var p = byVenue[k];
      delete p._areaSeen;
      delete p._campSeen;
      p.camps.sort(function (x, y) { return asText(x.name).localeCompare(asText(y.name)); });
      return p;
    });
    pages.sort(function (x, y) {
      // Busiest venues first (most camps), then alphabetical.
      if (y.camps.length !== x.camps.length) return y.camps.length - x.camps.length;
      return asText(x.name).localeCompare(asText(y.name));
    });
    return pages;
  }

  function isFreeOrHaf(prov) {
    try {
      var cats = (Array.isArray(prov.categories) ? prov.categories : []).join(" ").toLowerCase();
      var fund = (Array.isArray(prov.funding) ? prov.funding : []).join(" ").toLowerCase();
      var blob = cats + " " + fund + " " + asText(prov.price).toLowerCase();
      return /haf|free/.test(blob);
    } catch (e) { return false; }
  }

  // Look one venue page up by slug.
  function getVenuePage(providers, slug) {
    var pages = buildVenueIndex(providers);
    for (var i = 0; i < pages.length; i++) {
      if (pages[i].slug === slug) return pages[i];
    }
    return null;
  }

  /* ---------------- a tiny SEO model (mirrors 04-seo §1.5) ---------------- */
  // These per-venue pages exist to be found in Google, so we model the
  // title/meta/H1 a venue page would publish. Pure + testable.
  function seoForVenue(page) {
    var name = asText(page && page.name) || "Venue";
    var pc = asText(page && page.postcode);
    var n = (page && page.camps) ? page.camps.length : 0;
    var areaBit = (page && page.areas && page.areas.length) ? (" in " + page.areas[0]) : "";
    return {
      title: "Holiday camps at " + name + (pc ? " (" + pc + ")" : "") + " | HolidayCamp",
      h1: "Holiday camps at " + name,
      metaDescription: n + " holiday camp" + (n === 1 ? "" : "s") +
        " running at " + name + areaBit + " these school holidays — compare ages, weeks, prices and funded places.",
      canonical: "/venue/" + (page && page.slug ? page.slug : "venue")
    };
  }

  /* ---------------- persistence (HC.store only) — pinned venues ---------------- */

  function readPins() {
    try {
      var s = HC.store.get(STORE_KEY, []);
      return Array.isArray(s) ? s : [];
    } catch (e) { return []; }
  }
  function writePins(list) {
    try { return HC.store.set(STORE_KEY, Array.isArray(list) ? list : []); }
    catch (e) { return false; }
  }
  function togglePin(slug) {
    var s = asText(slug);
    if (!s) return readPins();
    var list = readPins();
    var idx = list.indexOf(s);
    if (idx === -1) list.unshift(s); else list.splice(idx, 1);
    if (list.length > 50) list = list.slice(0, 50);
    writePins(list);
    return list;
  }
  function isPinned(slug) {
    return readPins().indexOf(asText(slug)) !== -1;
  }

  /* ---------------- UI ---------------- */

  function money(n) {
    try { return HC.util.money(n); } catch (e) { return "£" + n; }
  }

  function chip(text, kind) {
    var bg = kind === "free" ? "#E1F0E4" : "var(--purple-tint,#F0E8F4)";
    var fg = kind === "free" ? "#2f7d4f" : "var(--purple,#603488)";
    return '<span style="display:inline-block;font-family:Quicksand,system-ui,sans-serif;font-weight:700;font-size:11px;' +
      'padding:3px 9px;border-radius:999px;background:' + bg + ';color:' + fg + ';margin:0 6px 6px 0">' +
      esc(text) + "</span>";
  }

  function campRow(camp) {
    var tags = "";
    if (camp.free) tags += chip("Free / HAF", "free");
    (camp.categories || []).slice(0, 3).forEach(function (c) { tags += chip(c); });

    return '<div style="border:1.5px solid var(--line,#E6E6E6);border-radius:14px;padding:13px 15px;background:#fff;margin:0 0 10px">' +
      '<div style="display:flex;justify-content:space-between;gap:10px;align-items:baseline;flex-wrap:wrap">' +
        '<div style="font-family:Quicksand,system-ui,sans-serif;font-weight:700;color:var(--purple,#603488);font-size:15.5px">' +
          esc(camp.name) + "</div>" +
        (camp.ageLabel ? '<span style="font-size:12px;color:var(--muted,#808080)">ages ' + esc(camp.ageLabel) + "</span>" : "") +
      "</div>" +
      (camp.kind ? '<div style="font-size:12.5px;color:var(--muted,#808080);margin-top:2px">' + esc(camp.kind) + "</div>" : "") +
      '<div style="margin-top:8px">' + tags + "</div>" +
      '<div style="font-size:12.5px;color:var(--text,#383838);margin-top:2px">' +
        (camp.hours ? esc(camp.hours) : "") +
        (camp.price ? (camp.hours ? " · " : "") + esc(camp.price) : "") +
      "</div>" +
      (camp.weeks ? '<div style="font-size:12px;color:var(--magenta,#F82488);font-weight:700;margin-top:6px">' + esc(camp.weeks) + "</div>" : "") +
    "</div>";
  }

  // Render one venue page (the public aggregation page itself).
  function renderVenuePage(host, page, onBack) {
    var seo = seoForVenue(page);
    var pinned = isPinned(page.slug);

    var html =
      '<button class="hc-btn hc-btn-ghost" data-vp-back type="button" style="margin-bottom:12px">‹ All venues</button>' +
      // The SEO surface this page would publish (04-seo §1.5).
      '<div style="background:#FAF7FC;border:1.5px dashed var(--purple-tint,#F0E8F4);border-radius:12px;padding:10px 12px;margin:0 0 14px">' +
        '<div style="font-size:11px;text-transform:uppercase;letter-spacing:.4px;color:var(--magenta,#F82488);font-weight:700;font-family:Quicksand,system-ui,sans-serif">Public venue page · indexable in Google</div>' +
        '<div style="font-size:12px;color:var(--muted,#808080);margin-top:4px;word-break:break-word"><strong>' + esc(seo.canonical) + '</strong></div>' +
        '<div style="font-size:12px;color:var(--text,#383838);margin-top:4px">' + esc(seo.title) + "</div>" +
      "</div>" +
      '<h2 style="font-family:Quicksand,system-ui,sans-serif;color:var(--purple,#603488);margin:0 0 2px;font-size:22px">' +
        esc(seo.h1) + "</h2>" +
      '<div style="font-size:13px;color:var(--muted,#808080);margin:0 0 4px">' +
        (page.postcode ? esc(page.postcode) + " · " : "") +
        (page.areas && page.areas.length ? esc(page.areas.join(", ")) : "") + "</div>" +
      '<div style="display:flex;gap:10px;align-items:center;margin:6px 0 14px;flex-wrap:wrap">' +
        '<span style="font-family:Quicksand,system-ui,sans-serif;font-weight:700;color:var(--magenta,#F82488)">' +
          page.camps.length + " camp" + (page.camps.length === 1 ? "" : "s") + " running here</span>" +
        '<button class="hc-btn" data-vp-pin type="button">' + (pinned ? "★ Saved" : "☆ Save this venue") + "</button>" +
      "</div>" +
      '<div data-vp-camps>' + page.camps.map(campRow).join("") + "</div>";

    host.innerHTML = html;

    var backBtn = host.querySelector("[data-vp-back]");
    if (backBtn && typeof onBack === "function") backBtn.addEventListener("click", onBack);

    var pinBtn = host.querySelector("[data-vp-pin]");
    if (pinBtn) {
      pinBtn.addEventListener("click", function () {
        var list = togglePin(page.slug);
        var nowPinned = list.indexOf(page.slug) !== -1;
        pinBtn.textContent = nowPinned ? "★ Saved" : "☆ Save this venue";
        try { HC.util.toast(nowPinned ? "Saved " + page.name : "Removed " + page.name); } catch (e) {}
      });
    }
  }

  // Render the directory of all venue pages.
  function renderIndex(host, pages, onOpen) {
    if (!pages.length) {
      host.innerHTML = '<p style="color:var(--muted,#808080);font-size:13.5px">No named venues found in the live camp data.</p>';
      return;
    }
    var rows = pages.map(function (p) {
      return '<button class="hc-vp-row" data-vp-open="' + esc(p.slug) + '" type="button" ' +
        'style="display:block;width:100%;text-align:left;border:1.5px solid var(--line,#E6E6E6);background:#fff;cursor:pointer;' +
        'border-radius:14px;padding:13px 15px;margin:0 0 10px">' +
        '<div style="display:flex;justify-content:space-between;gap:10px;align-items:baseline">' +
          '<span style="font-family:Quicksand,system-ui,sans-serif;font-weight:700;color:var(--purple,#603488);font-size:15px">' +
            esc(p.name) + "</span>" +
          '<span style="font-family:Quicksand,system-ui,sans-serif;font-weight:700;font-size:12px;padding:3px 10px;border-radius:999px;' +
            'background:var(--magenta,#F82488);color:#fff;white-space:nowrap">' +
            p.camps.length + " camp" + (p.camps.length === 1 ? "" : "s") + "</span>" +
        "</div>" +
        '<div style="font-size:12.5px;color:var(--muted,#808080);margin-top:4px">' +
          (p.postcode ? esc(p.postcode) + " · " : "") +
          (p.areas && p.areas.length ? esc(p.areas.slice(0, 2).join(", ")) : "") + "</div>" +
      "</button>";
    }).join("");

    host.innerHTML =
      '<p style="font-size:14px;color:var(--text,#383838);margin:0 0 4px">' +
        "Every named site in the area gets its <strong>own public page</strong> listing <strong>all the camps that run there</strong> " +
        "— across different providers. These pages are built to rank in Google so parents searching " +
        "“holiday camp at [school]” land straight on the right site.</p>" +
      '<p style="font-size:12.5px;color:var(--muted,#808080);margin:0 0 14px;font-style:italic">' +
        "Mirrors Happity: “when you add a new venue, it gets its own page showing all classes at that location.”</p>" +
      '<div style="font-family:Quicksand,system-ui,sans-serif;font-weight:700;color:var(--magenta,#F82488);margin:0 0 10px">' +
        pages.length + " venue page" + (pages.length === 1 ? "" : "s") + "</div>" +
      rows;

    host.querySelectorAll("[data-vp-open]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        if (typeof onOpen === "function") onOpen(btn.getAttribute("data-vp-open"));
      });
    });
  }

  function render(mountEl) {
    try {
      if (!mountEl) return;
      mountEl.innerHTML = "";
      var pages = buildVenueIndex(HC.data.providers);

      var host = el("div", null, "");
      mountEl.appendChild(host);

      function showIndex() {
        renderIndex(host, pages, function (slug) { showPage(slug); });
      }
      function showPage(slug) {
        var page = null;
        for (var i = 0; i < pages.length; i++) { if (pages[i].slug === slug) { page = pages[i]; break; } }
        if (!page) { showIndex(); return; }
        renderVenuePage(host, page, showIndex);
        try { mountEl.scrollTop = 0; } catch (e) {}
      }

      showIndex();
    } catch (e) {
      try {
        mountEl.innerHTML = '<p style="color:#9a1f5e">Venue-pages feature failed to render: ' +
          esc(e && e.message ? e.message : String(e)) + "</p>";
      } catch (e2) { /* give up quietly */ }
    }
  }

  /* ---------------- selfTest ---------------- */

  function selfTest() {
    var pass = 0, fail = 0, log = [];
    function check(label, fn) {
      try { fn(); pass += 1; log.push("✓ " + label); }
      catch (e) { fail += 1; log.push("✗ " + label + " — " + (e && e.message ? e.message : String(e))); }
    }

    // A small synthetic directory we fully control, plus the live data below.
    // Two providers share "Lloyd Park", one runs at two sites, one is borough-wide.
    var fixture = [
      { id: "p-aaa", name: "Acme Sports Camp", area: "Walthamstow", areas: ["Walthamstow"],
        venue: "Lloyd Park Centre and Higham Hill Centre", address: "Lloyd Park, E17 4PP; Higham Hill Rd, E17 5RB",
        ageLabel: "5-11", categories: ["Multi-activity"], funding: ["Paid"], hours: "9-3", price: "£32 day" },
      { id: "p-bbb", name: "Bright Drama Club", area: "Walthamstow", areas: ["Walthamstow"],
        venue: "Lloyd Park Centre", address: "Lloyd Park, E17 4PP",
        ageLabel: "7-12", categories: ["Drama"], funding: ["Paid"], hours: "10-2", price: "£40 day" },
      { id: "p-ccc", name: "Council HAF Route", area: "Borough-wide", areas: ["Walthamstow", "Leyton"],
        venue: "Multiple Waltham Forest venues via Eequ", address: "Borough-wide",
        ageLabel: "5-16", categories: ["HAF", "Free places"], funding: ["Free/HAF"], hours: "Varies", price: "Free for eligible" }
    ];

    var idx = buildVenueIndex(fixture);

    // ===== ACCEPTANCE CRITERION =====
    // A page per venue lists EVERY camp running at that site.
    check("ACCEPTANCE: the Lloyd Park venue page lists EVERY camp running there", function () {
      var lloyd = null;
      for (var i = 0; i < idx.length; i++) { if (idx[i].slug === slugify("Lloyd Park Centre")) { lloyd = idx[i]; break; } }
      HC.assert(lloyd, "a Lloyd Park Centre page must exist");
      // Both Acme (runs at Lloyd Park + Higham Hill) and Bright (Lloyd Park only)
      // run at Lloyd Park, so BOTH must appear on the page.
      var names = lloyd.camps.map(function (c) { return c.name; }).sort();
      HC.assert(lloyd.camps.length === 2,
        "Lloyd Park page must list both camps running there, got " + lloyd.camps.length);
      HC.assert(names.indexOf("Acme Sports Camp") !== -1, "Acme Sports Camp must be listed at Lloyd Park");
      HC.assert(names.indexOf("Bright Drama Club") !== -1, "Bright Drama Club must be listed at Lloyd Park");
    });

    // ===== A second venue gets its OWN page with its OWN camp list =====
    check("Higham Hill gets its own page listing only the camp that runs there", function () {
      var higham = null;
      for (var i = 0; i < idx.length; i++) { if (idx[i].slug === slugify("Higham Hill Centre")) { higham = idx[i]; break; } }
      HC.assert(higham, "a Higham Hill Centre page must exist (multi-site camp fans out)");
      HC.assert(higham.camps.length === 1, "only Acme runs at Higham Hill, got " + higham.camps.length);
      HC.assert(higham.camps[0].name === "Acme Sports Camp", "the listed camp must be Acme");
    });

    // ===== Many-to-many: one camp appears on every site it runs at =====
    check("A camp running at two sites appears on BOTH venue pages", function () {
      var onLloyd = false, onHigham = false;
      for (var i = 0; i < idx.length; i++) {
        var has = idx[i].camps.some(function (c) { return c.id === "p-aaa"; });
        if (idx[i].slug === slugify("Lloyd Park Centre") && has) onLloyd = true;
        if (idx[i].slug === slugify("Higham Hill Centre") && has) onHigham = true;
      }
      HC.assert(onLloyd && onHigham, "Acme must appear on both the Lloyd Park and Higham Hill pages");
    });

    // ===== Vague / borough-wide venues do NOT spawn a page =====
    check("A borough-wide 'multiple venues' camp does not invent a fake venue page", function () {
      var slugs = idx.map(function (p) { return p.slug; });
      HC.assert(slugs.indexOf(slugify("Multiple Waltham Forest venues via Eequ")) === -1,
        "a vague multi-site string must not become a venue page");
      // The HAF camp has no named site, so it anchors no page in this fixture.
      var anyHaf = idx.some(function (p) { return p.camps.some(function (c) { return c.id === "p-ccc"; }); });
      HC.assert(!anyHaf, "the borough-wide HAF route should not be pinned to a fake venue");
    });

    // ===== Venue-name parsing handles the real connectors =====
    check("splitVenues parses commas, ' and ', ' / ' and drops vague catch-alls", function () {
      HC.assert(splitVenues("Lloyd Park Centre and Higham Hill Centre").length === 2, "'and' split");
      HC.assert(splitVenues("Whittingham Primary Academy and Handsworth Primary School").length === 2, "two schools");
      var multi = splitVenues("Woodside, George Tomlinson, Score Leyton and other sites");
      HC.assert(multi.length === 3, "comma + and split, dropping 'other sites', got " + multi.length);
      HC.assert(multi.indexOf("Woodside") !== -1 && multi.indexOf("George Tomlinson") !== -1, "named sites kept");
      HC.assert(splitVenues("Multiple Waltham Forest venues via Eequ").length === 0, "vague -> no venue");
      HC.assert(splitVenues("art-K Highams Park").length === 1, "single venue kept whole");
    });

    // ===== Postcode + SEO model =====
    check("Each venue page exposes a postcode and an indexable SEO title/H1 (04-seo §1.5)", function () {
      var lloyd = getVenuePage(fixture, slugify("Lloyd Park Centre"));
      HC.assert(lloyd, "page lookup by slug works");
      HC.assert(lloyd.postcode === "E17 4PP", "page derives a postcode, got " + lloyd.postcode);
      var seo = seoForVenue(lloyd);
      HC.assert(/Lloyd Park Centre/.test(seo.h1), "H1 names the venue");
      HC.assert(/Lloyd Park Centre/.test(seo.title) && /HolidayCamp/.test(seo.title), "title is venue-specific");
      HC.assert(seo.canonical === "/venue/" + slugify("Lloyd Park Centre"), "canonical URL is per-venue");
      HC.assert(/2 holiday camps/.test(seo.metaDescription), "meta counts the camps at this site");
    });

    // ===== Free/HAF detection surfaces on the page =====
    check("Funded (Free/HAF) camps are flagged on the venue page", function () {
      HC.assert(isFreeOrHaf({ categories: ["HAF"], funding: [], price: "" }) === true, "HAF category -> free");
      HC.assert(isFreeOrHaf({ categories: [], funding: ["Free/HAF"], price: "" }) === true, "Free/HAF funding -> free");
      HC.assert(isFreeOrHaf({ categories: ["Multi-activity"], funding: ["Paid"], price: "£32" }) === false, "paid camp not flagged");
    });

    // ===== Defensive: garbage input never throws =====
    check("buildVenueIndex / splitVenues handle garbage and never throw", function () {
      var bad = [null, undefined, {}, 42, "", [], { venue: null }, { venue: 7 }, { venue: ",,, and / ;" }];
      HC.assert(Array.isArray(buildVenueIndex(bad)), "index of garbage is still an array");
      HC.assert(Array.isArray(buildVenueIndex(null)), "null providers -> []");
      HC.assert(splitVenues(null).length === 0 && splitVenues(undefined).length === 0, "null venue -> []");
      HC.assert(splitVenues(123).length >= 0, "numeric venue does not throw");
    });

    // ===== Persistence via HC.store (pin/unpin a venue page) =====
    check("Pinning a venue page persists through HC.store and toggles cleanly", function () {
      var slug = "selftest-venue-" + Math.floor(Math.random() * 1e6);
      var before = readPins().length;
      HC.assert(isPinned(slug) === false, "starts unpinned");
      togglePin(slug);
      HC.assert(isPinned(slug) === true, "pin persists");
      HC.assert(readPins().length === before + 1, "pin list grew by one");
      togglePin(slug);
      HC.assert(isPinned(slug) === false, "unpin persists");
      HC.assert(readPins().length === before, "pin list restored");
    });

    // ===== LIVE DATA: the real directory produces real venue pages =====
    check("LIVE: the real camp directory yields venue pages, each listing its camps", function () {
      var providers = HC.data.providers || [];
      if (!providers.length) {
        // In a headless/node check there's no live data — don't fail the build.
        log.push("  (no live providers in this context — skipping live assertions)");
        return;
      }
      var live = buildVenueIndex(providers);
      HC.assert(live.length > 0, "at least one venue page from live data");
      // Every page must list at least one camp, and every listed camp must
      // genuinely name that venue in its source record (the acceptance criterion
      // applied to real data).
      for (var i = 0; i < live.length; i++) {
        var page = live[i];
        HC.assert(page.camps.length > 0, "venue page '" + page.name + "' lists at least one camp");
        for (var c = 0; c < page.camps.length; c++) {
          var camp = page.camps[c];
          var prov = null;
          for (var j = 0; j < providers.length; j++) { if (providers[j].id === camp.id) { prov = providers[j]; break; } }
          HC.assert(prov, "listed camp resolves to a real provider");
          var siteNames = splitVenues(prov.venue).map(function (s) { return slugify(s); });
          HC.assert(siteNames.indexOf(page.slug) !== -1,
            "camp '" + camp.name + "' really runs at venue '" + page.name + "'");
        }
      }
    });

    return { pass: pass, fail: fail, log: log };
  }

  /* ---------------- register ---------------- */

  HC.registerFeature({
    id: "platform-venue-pages",
    title: "Per-venue aggregation pages",
    side: "platform",
    icon: "🏫",
    summary: "Every named site gets its own public, Google-indexable page listing every holiday camp that runs there — across all providers — with ages, weeks, prices and funded places (mirrors Happity's per-venue pages).",
    render: render,
    selfTest: selfTest
  });
})();
