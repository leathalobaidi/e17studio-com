/* HolidayCamp feature module — platform-legal-tnc
 *
 * Side: PLATFORM.
 * Replicates Happity's public "Legal / Terms & Conditions / Privacy" hub for
 * school-age HOLIDAY CAMPS.
 *
 * Evidence:
 *   - Collection 3709365 ("Terms & Conditions") is a PLATFORM-level hub listing
 *     8 legal documents: Badge T&Cs, "Give £10 Get £10" referral T&Cs, Parent
 *     Referral Programme T&Cs, Complaints procedure, campaign T&Cs (Small
 *     Businesses Are Superstars, Add-your-timetable competition, Summer Switch),
 *     and "How to cancel your Happity services".
 *   - Article 2381438 ("Adding your Terms and Conditions & Privacy Policy"):
 *     "Before a customer can book your class, they will need to accept your
 *     T&Cs and read your privacy policy." => the public site MUST expose, at
 *     minimum, Terms & Conditions, a Privacy Policy, and the programme terms.
 *
 * This is the PLATFORM side of the legal story (the public-facing hub of legal
 * documents), distinct from the PROVIDER side (provider-tnc-upload.js, where a
 * provider uploads their OWN booking legals). Here HolidayCamp publishes its own
 * platform/programme legals and exposes them as a searchable, categorised hub
 * with anchored sections and a "last reviewed" stamp per document.
 *
 * ACCEPTANCE CRITERION (asserted in selfTest, multiple cases):
 *   The site exposes T&Cs, privacy and programme terms.
 *   => buildHub() must always surface a Terms & Conditions document, a Privacy
 *      Policy document, AND at least one programme-terms document; and the
 *      category index must contain the 'terms', 'privacy' and 'programme'
 *      categories. Search/filter must never be able to hide ALL of these
 *      mandatory documents (the core three are pinned and always findable).
 *
 * Self-contained, defensive, no imports/exports. Calls HC.registerFeature.
 * Parse target: plain browser JS. Must pass `node --check`.
 */
(function () {
  "use strict";

  // Defensive: never throw at module load if HC isn't present.
  if (typeof window === "undefined" || !window.HC ||
      typeof window.HC.registerFeature !== "function") {
    if (typeof console !== "undefined" && console.warn) {
      console.warn("[HC] platform-legal-tnc: HC core not found; skipping registration.");
    }
    return;
  }

  var HC = window.HC;

  var STORE_KEY = "platform_legal_hub"; // persisted: per-doc acceptance + last opened

  /* ============================================================
     Category taxonomy. The three MANDATORY categories that satisfy
     the acceptance criterion are 'terms', 'privacy' and 'programme'.
     ============================================================ */
  var CATEGORIES = [
    { id: "terms",      label: "Terms & Conditions", icon: "📜", mandatory: true },
    { id: "privacy",    label: "Privacy & data",     icon: "🔒", mandatory: true },
    { id: "programme",  label: "Programme terms",    icon: "🎟️", mandatory: true },
    { id: "complaints", label: "Complaints",         icon: "📣", mandatory: false },
    { id: "account",    label: "Account & billing",  icon: "💳", mandatory: false }
  ];
  var MANDATORY_CATEGORIES = ["terms", "privacy", "programme"];

  /* ============================================================
     The legal document catalogue. Framed for school-age HOLIDAY
     CAMPS. Each doc has: id, category, title, summary, an ordered
     list of {h, body} sections (so a doc has anchored sub-sections,
     mirroring the Happity articles' "Table of contents"), a
     lastReviewed ISO date, and whether acceptance is required.
     `pinned` docs are the core legals that must ALWAYS be findable.
     ============================================================ */
  function buildCatalogue() {
    return [
      {
        id: "platform-terms",
        category: "terms",
        title: "HolidayCamp Terms & Conditions",
        summary: "The agreement between you and HolidayCamp when you use the site to find or book a school-age holiday camp.",
        pinned: true,
        acceptanceRequired: true,
        lastReviewed: "2026-04-12",
        sections: [
          { h: "About these terms", body: "These terms govern your use of HolidayCamp. By booking a holiday camp through the site you agree to them, and to the individual camp provider's own booking terms." },
          { h: "Bookings & payment", body: "HolidayCamp connects families with independent holiday-camp providers. Each booking is a contract between you and that provider. Payment is taken at checkout; prices include any platform fee shown before you pay." },
          { h: "Your account", body: "You are responsible for the accuracy of the child and contact details you give, and for keeping your login secure." },
          { h: "Liability", body: "HolidayCamp is a booking platform, not the camp operator. Care of your child during a session is the provider's responsibility under their own terms and safeguarding policy." },
          { h: "Changes to these terms", body: "We may update these terms; the current version is always the one published here with the latest review date." }
        ]
      },
      {
        id: "privacy-policy",
        category: "privacy",
        title: "Privacy Policy",
        summary: "How HolidayCamp collects, uses and protects the personal data of parents, carers and children.",
        pinned: true,
        acceptanceRequired: false,
        lastReviewed: "2026-04-12",
        sections: [
          { h: "What we collect", body: "Contact details for the booking parent/carer, and the child's first name, age and any medical or dietary needs you choose to share for a camp." },
          { h: "How we use it", body: "To process and confirm your camp bookings, to pass essential details to the camp provider so they can run the session safely, and to contact you about a booking." },
          { h: "Children's data", body: "We hold children's details only to deliver the booking. We never sell children's data and never use it for advertising." },
          { h: "Sharing with providers", body: "The camp provider you book receives the registration details needed to run the session (e.g. emergency contact, allergies). They are independent data controllers for those details." },
          { h: "Your rights", body: "You can ask us for a copy of your data, correct it, or have it deleted, subject to records we must keep for bookings and refunds." }
        ]
      },
      {
        id: "cookie-policy",
        category: "privacy",
        title: "Cookie Policy",
        summary: "The cookies HolidayCamp uses and how to control them.",
        pinned: false,
        acceptanceRequired: false,
        lastReviewed: "2026-03-01",
        sections: [
          { h: "Essential cookies", body: "Needed to keep you signed in and to hold your basket while you book a camp." },
          { h: "Analytics cookies", body: "Help us understand which camps and areas families search for, so we can improve the site. You can opt out." }
        ]
      },
      {
        id: "programme-badges-terms",
        category: "programme",
        title: "Verified-Provider Badge — Terms",
        summary: "The rules for earning and displaying HolidayCamp verification badges (DBS, safeguarding, Ofsted/HAF) on a camp listing.",
        pinned: true,
        acceptanceRequired: false,
        lastReviewed: "2026-02-18",
        sections: [
          { h: "Earning a badge", body: "Badges are awarded once a provider supplies valid evidence (e.g. enhanced DBS, public liability insurance, HAF approval). Badges are tied to the provider, not an individual camp." },
          { h: "Keeping a badge", body: "Evidence must be current. An expired DBS or lapsed insurance removes the badge until renewed." },
          { h: "Misuse", body: "Displaying a badge without valid evidence is a breach of these terms and the platform Terms & Conditions, and can lead to removal from HolidayCamp." }
        ]
      },
      {
        id: "programme-parent-referral-terms",
        category: "programme",
        title: "Parent Referral Programme — Terms",
        summary: "Give a friend camp credit, get camp credit — the rules of the parent referral scheme.",
        pinned: false,
        acceptanceRequired: false,
        lastReviewed: "2026-01-20",
        sections: [
          { h: "How it works", body: "Share your referral link. When a new family books their first holiday camp using it, you both receive camp credit." },
          { h: "Eligibility", body: "The referred family must be new to HolidayCamp and book a paid camp. Credit applies to a future school-age camp booking." },
          { h: "Fair use", body: "Self-referrals and bulk/automated sign-ups are not eligible and may void credit." }
        ]
      },
      {
        id: "programme-provider-referral-terms",
        category: "programme",
        title: "Provider Referral Programme — Terms",
        summary: "Refer another camp provider to HolidayCamp and earn platform credit.",
        pinned: false,
        acceptanceRequired: false,
        lastReviewed: "2026-01-20",
        sections: [
          { h: "How it works", body: "Invite another holiday-camp provider. When they list and take their first booking, you receive credit against your HolidayCamp fees." },
          { h: "Eligibility", body: "The referred provider must be new to the platform and pass verification." }
        ]
      },
      {
        id: "programme-seasonal-campaign-terms",
        category: "programme",
        title: "Summer Switch 2026 — Campaign Terms",
        summary: "Terms for the seasonal Summer Switch promotion encouraging families to try a new camp this summer.",
        pinned: false,
        acceptanceRequired: false,
        lastReviewed: "2026-05-02",
        sections: [
          { h: "The offer", body: "During the promotion window, eligible summer holiday-camp bookings can claim the advertised discount or credit." },
          { h: "Dates & limits", body: "The promotion runs only within the published summer window and may be limited per family. HolidayCamp may withdraw it at any time." }
        ]
      },
      {
        id: "complaints-procedure",
        category: "complaints",
        title: "Complaints Procedure",
        summary: "How to raise a serious issue about a camp or about HolidayCamp, and how we handle it.",
        pinned: false,
        acceptanceRequired: false,
        lastReviewed: "2026-03-15",
        sections: [
          { h: "Making a complaint", body: "We take all complaints seriously. There should be no barrier to raising an issue; every complaint is handled fairly and efficiently." },
          { h: "The process", body: "Contact our support team with the booking reference and what went wrong. We acknowledge, investigate, and respond within a published timeframe." },
          { h: "Raising a formal complaint", body: "If you are not satisfied with the outcome you can escalate to a formal review." }
        ]
      },
      {
        id: "cancellation-policy",
        category: "account",
        title: "Cancelling & Refunds",
        summary: "How to cancel a camp booking or a provider subscription, and when refunds apply.",
        pinned: false,
        acceptanceRequired: false,
        lastReviewed: "2026-04-01",
        sections: [
          { h: "Cancelling a camp booking", body: "Cancellation and refund eligibility for a booked camp follow the provider's own published booking terms and the cut-off they set." },
          { h: "Cancelling a provider subscription", body: "Provider memberships include a 30-day cooling-off period. Use the cancellation form and we will action it within five working days." }
        ]
      }
    ];
  }

  /* ============================================================
     Pure logic (no DOM) — testable.
     ============================================================ */

  function asText(v) { return typeof v === "string" ? v : (v == null ? "" : String(v)); }

  function categoryById(id) {
    for (var i = 0; i < CATEGORIES.length; i++) {
      if (CATEGORIES[i].id === id) return CATEGORIES[i];
    }
    return { id: asText(id) || "other", label: "Other", icon: "📄", mandatory: false };
  }

  // Build the public legal hub model from the catalogue. Returns a structured
  // object: docs (validated), byId, categories (only those that actually have
  // docs, with counts), and a flag set proving the mandatory docs are present.
  // DEFENSIVE: any malformed catalogue entry is skipped, never thrown on.
  function buildHub() {
    var raw = [];
    try { raw = buildCatalogue(); } catch (e) { raw = []; }
    if (!Array.isArray(raw)) raw = [];

    var docs = [];
    var byId = {};
    for (var i = 0; i < raw.length; i++) {
      var d = normaliseDoc(raw[i]);
      if (!d) continue;
      if (byId[d.id]) continue; // de-dupe by id
      docs.push(d);
      byId[d.id] = d;
    }

    // Category index — only categories that have at least one doc, in taxonomy
    // order, each with its doc count.
    var catIndex = [];
    for (var c = 0; c < CATEGORIES.length; c++) {
      var cat = CATEGORIES[c];
      var list = docs.filter(function (x) { return x.category === cat.id; });
      if (!list.length) continue;
      catIndex.push({
        id: cat.id, label: cat.label, icon: cat.icon,
        mandatory: !!cat.mandatory, count: list.length
      });
    }

    // Prove the acceptance criterion at build time.
    var hasTerms = docs.some(function (x) { return x.category === "terms"; });
    var hasPrivacy = docs.some(function (x) { return x.category === "privacy"; });
    var hasProgramme = docs.some(function (x) { return x.category === "programme"; });

    return {
      docs: docs,
      byId: byId,
      categories: catIndex,
      exposes: {
        terms: hasTerms,
        privacy: hasPrivacy,
        programme: hasProgramme,
        // The headline acceptance flag.
        all: hasTerms && hasPrivacy && hasProgramme
      }
    };
  }

  // Validate + canonicalise one catalogue entry. Returns null if unusable.
  function normaliseDoc(d) {
    if (!d || typeof d !== "object") return null;
    var id = asText(d.id).trim();
    var title = asText(d.title).trim();
    if (!id || !title) return null;
    var category = asText(d.category).trim() || "other";
    var sections = [];
    if (Array.isArray(d.sections)) {
      for (var i = 0; i < d.sections.length; i++) {
        var s = d.sections[i];
        if (!s || typeof s !== "object") continue;
        var h = asText(s.h).trim();
        var body = asText(s.body).trim();
        if (!h && !body) continue;
        sections.push({ h: h, body: body, anchor: slugify(id + "-" + (h || ("section-" + i))) });
      }
    }
    return {
      id: id,
      category: category,
      title: title,
      summary: asText(d.summary).trim(),
      pinned: !!d.pinned,
      acceptanceRequired: !!d.acceptanceRequired,
      lastReviewed: asText(d.lastReviewed).trim() || "—",
      sections: sections,
      slug: slugify(id),
      url: "/legal/" + slugify(id)
    };
  }

  function slugify(s) {
    return String(s == null ? "" : s)
      .toLowerCase()
      .replace(/&/g, " and ")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "x";
  }

  // Search / filter the hub. `query` matches title + summary + section text;
  // `category` (optional) restricts to one category. Returns the matching docs.
  // CRUCIAL GUARANTEE for the acceptance criterion: a search that matches NOTHING
  // never hides the core legals — the pinned core docs (T&Cs, Privacy, a
  // programme-terms doc) are always appended so they remain findable. With an
  // explicit category filter we respect it, but an empty/garbage free-text query
  // can never make the mandatory legals disappear from the public hub.
  function searchDocs(hub, query, category) {
    var H = (hub && Array.isArray(hub.docs)) ? hub : buildHub();
    var q = asText(query).trim().toLowerCase();
    var cat = asText(category).trim();

    var pool = H.docs;
    if (cat) pool = pool.filter(function (d) { return d.category === cat; });

    var matched;
    if (!q) {
      matched = pool.slice();
    } else {
      matched = pool.filter(function (d) { return docMatches(d, q); });
    }

    // Pin guarantee: when NO category filter is applied, ensure the core pinned
    // legals are always present in the result, even if the free-text query
    // matched nothing. This is what makes "the site exposes T&Cs, privacy and
    // programme terms" hold under any free-text search.
    if (!cat) {
      var have = {};
      for (var i = 0; i < matched.length; i++) have[matched[i].id] = true;
      var pinned = H.docs.filter(function (d) { return d.pinned; });
      for (var p = 0; p < pinned.length; p++) {
        if (!have[pinned[p].id]) { matched.push(pinned[p]); have[pinned[p].id] = true; }
      }
    }
    return matched;
  }

  function docMatches(d, qLower) {
    if (!d) return false;
    var hay = (d.title + " " + d.summary + " " + d.category).toLowerCase();
    if (hay.indexOf(qLower) !== -1) return true;
    for (var i = 0; i < d.sections.length; i++) {
      var sec = d.sections[i];
      if ((sec.h + " " + sec.body).toLowerCase().indexOf(qLower) !== -1) return true;
    }
    return false;
  }

  /* ============================================================
     Acceptance tracking (mirrors Happity: "they will need to accept
     your T&Cs"). A family can record acceptance of acceptance-required
     docs; we store which docs they've accepted + a version stamp.
     Persisted via HC.store only.
     ============================================================ */

  function readState() {
    try {
      var s = HC.store.get(STORE_KEY, {});
      if (!s || typeof s !== "object" || Array.isArray(s)) s = {};
      if (!s.accepted || typeof s.accepted !== "object") s.accepted = {};
      return s;
    } catch (e) { return { accepted: {} }; }
  }
  function writeState(s) {
    try { return HC.store.set(STORE_KEY, (s && typeof s === "object") ? s : { accepted: {} }); }
    catch (e) { return false; }
  }

  // Which acceptance-required docs has the family NOT yet accepted?
  function outstandingAcceptances(hub, state) {
    var H = (hub && Array.isArray(hub.docs)) ? hub : buildHub();
    var st = (state && state.accepted && typeof state.accepted === "object") ? state : readState();
    var out = [];
    for (var i = 0; i < H.docs.length; i++) {
      var d = H.docs[i];
      if (d.acceptanceRequired && !st.accepted[d.id]) out.push(d);
    }
    return out;
  }

  function acceptDoc(docId, state) {
    var st = (state && state.accepted && typeof state.accepted === "object") ? state : readState();
    var id = asText(docId).trim();
    if (id) st.accepted[id] = { at: nowIso() };
    return st;
  }

  // The booking-gate: a family can only proceed to a camp checkout once every
  // acceptance-required platform legal (the T&Cs) is accepted. Mirrors article
  // 2381438: "Before a customer can book ... they will need to accept your T&Cs".
  function canProceedToCheckout(hub, state) {
    return outstandingAcceptances(hub, state).length === 0;
  }

  function nowIso() {
    try { return new Date().toISOString().slice(0, 10); } catch (e) { return "—"; }
  }

  /* ============================================================
     UI — render(mountEl). Public legal hub: category rail, search,
     a list of legal documents, an expandable doc reader with anchored
     sections, and an "accept T&Cs" action. Defensive throughout.
     ============================================================ */

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

  function render(mountEl) {
    try {
      if (!mountEl) return;
      mountEl.innerHTML = "";

      var hub = buildHub();
      var ui = { query: "", category: "", openId: null };
      var state = readState();

      var intro = el("div", null,
        '<p style="font-size:14px;color:var(--text,#383838);margin:0 0 6px">' +
          "HolidayCamp's <strong>legal hub</strong> — every public policy in one place. " +
          "Families can read our <strong>Terms &amp; Conditions</strong>, <strong>Privacy Policy</strong> " +
          "and our <strong>programme terms</strong> (badges, referrals and seasonal campaigns) before they " +
          "book a school-age holiday camp.</p>");
      mountEl.appendChild(intro);

      // Acceptance banner (the gate).
      var gate = el("div", { id: "lhGate", style: "margin:6px 0 12px" });
      mountEl.appendChild(gate);

      // Search + category rail.
      var controls = el("div", { style: "margin:8px 0 12px" });
      var catBtns = '<button class="hc-btn hc-btn-ghost" type="button" data-lh-cat="" ' +
        'style="margin:0 6px 6px 0">All</button>';
      for (var c = 0; c < hub.categories.length; c++) {
        var cc = hub.categories[c];
        catBtns += '<button class="hc-btn hc-btn-ghost" type="button" data-lh-cat="' +
          esc(cc.id) + '" style="margin:0 6px 6px 0">' + esc(cc.icon + " " + cc.label) +
          " (" + cc.count + ")</button>";
      }
      controls.innerHTML =
        '<input id="lhSearch" type="search" placeholder="Search policies (e.g. refund, child, privacy)…" ' +
          'style="width:100%;max-width:420px;padding:9px 12px;border:1.5px solid var(--line,#E6E6E6);' +
          'border-radius:12px;font-size:14px;margin-bottom:10px"><br>' + catBtns;
      mountEl.appendChild(controls);

      var list = el("div", { id: "lhList" });
      mountEl.appendChild(list);

      function paintGate() {
        var outstanding = outstandingAcceptances(hub, state);
        if (!outstanding.length) {
          gate.innerHTML =
            '<div style="border:1.5px solid #CFE9D6;background:#F4FBF6;border-radius:14px;padding:10px 14px">' +
              '<span style="font-family:Quicksand,system-ui,sans-serif;font-weight:700;color:#2f7d4f">' +
              "✓ You've accepted our Terms &amp; Conditions — you're ready to book.</span></div>";
        } else {
          var names = outstanding.map(function (d) { return esc(d.title); }).join(", ");
          gate.innerHTML =
            '<div style="border:1.5px solid #F4CFE0;background:#FFF6FA;border-radius:14px;padding:10px 14px;' +
              'display:flex;gap:10px;align-items:center;flex-wrap:wrap">' +
              '<span style="font-family:Quicksand,system-ui,sans-serif;font-weight:700;color:#9a1f5e">' +
                "✕ Accept to book: " + names + "</span>" +
              '<button class="hc-btn" type="button" id="lhAcceptAll">Accept &amp; continue</button>' +
            "</div>";
        }
      }

      function paintList() {
        var results = searchDocs(hub, ui.query, ui.category);
        if (!results.length) {
          list.innerHTML = '<p style="color:var(--muted,#808080)">No policies match that search.</p>';
          return;
        }
        // Group results by category for a tidy hub layout.
        var html = "";
        var order = hub.categories.map(function (x) { return x.id; });
        for (var oi = 0; oi < order.length; oi++) {
          var catId = order[oi];
          var inCat = results.filter(function (d) { return d.category === catId; });
          if (!inCat.length) continue;
          var meta = categoryById(catId);
          html += '<div class="hc-sidehead" style="margin-top:14px">' +
            esc(meta.icon + " " + meta.label) + "</div>";
          for (var di = 0; di < inCat.length; di++) {
            html += docCard(inCat[di], ui.openId === inCat[di].id);
          }
        }
        list.innerHTML = html;
      }

      function docCard(d, open) {
        var secHtml = "";
        if (open) {
          secHtml = '<div style="margin-top:10px;border-top:1px solid var(--line,#E6E6E6);padding-top:10px">';
          for (var i = 0; i < d.sections.length; i++) {
            var s = d.sections[i];
            secHtml +=
              '<div id="' + esc(s.anchor) + '" style="margin:0 0 10px">' +
                '<div style="font-family:Quicksand,system-ui,sans-serif;font-weight:700;' +
                  'color:var(--purple,#603488);font-size:14px">' + esc(s.h) + "</div>" +
                '<p style="margin:3px 0 0;font-size:13px;color:var(--text,#383838)">' + esc(s.body) + "</p>" +
              "</div>";
          }
          secHtml += "</div>";
        }
        var pin = d.pinned
          ? '<span style="display:inline-block;font-family:Quicksand,system-ui,sans-serif;font-weight:700;' +
            'font-size:10.5px;padding:2px 8px;border-radius:999px;background:#F0E8F4;color:#603488;' +
            'margin-left:8px">CORE</span>'
          : "";
        var accept = d.acceptanceRequired
          ? '<button class="hc-btn hc-btn-ghost" type="button" data-lh-accept="' + esc(d.id) + '" ' +
            'style="margin-left:8px">' +
            (state.accepted[d.id] ? "✓ Accepted" : "Accept") + "</button>"
          : "";
        return '<div style="border:1.5px solid var(--line,#E6E6E6);border-radius:14px;padding:14px;margin-bottom:10px">' +
            '<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px">' +
              "<div>" +
                '<div style="font-family:Quicksand,system-ui,sans-serif;font-weight:700;' +
                  'color:var(--purple,#603488);font-size:15.5px">' + esc(d.title) + pin + "</div>" +
                '<p style="margin:4px 0 0;font-size:13px;color:var(--text,#383838)">' + esc(d.summary) + "</p>" +
                '<div style="margin-top:4px;font-size:11.5px;color:var(--muted,#808080)">' +
                  "Last reviewed " + esc(d.lastReviewed) + " · " + esc(d.url) + "</div>" +
              "</div>" +
            "</div>" +
            '<div style="margin-top:8px">' +
              '<button class="hc-btn hc-btn-ghost" type="button" data-lh-open="' + esc(d.id) + '">' +
                (open ? "Hide" : "Read") + "</button>" + accept +
            "</div>" +
            secHtml +
          "</div>";
      }

      // Delegated interactions.
      controls.addEventListener("input", function (e) {
        if (e.target && e.target.id === "lhSearch") {
          ui.query = e.target.value || "";
          paintList();
        }
      });
      controls.addEventListener("click", function (e) {
        var catBtn = e.target.closest && e.target.closest("[data-lh-cat]");
        if (catBtn) {
          ui.category = catBtn.getAttribute("data-lh-cat") || "";
          paintList();
        }
      });
      list.addEventListener("click", function (e) {
        var openBtn = e.target.closest && e.target.closest("[data-lh-open]");
        var accBtn = e.target.closest && e.target.closest("[data-lh-accept]");
        if (openBtn) {
          var id = openBtn.getAttribute("data-lh-open");
          ui.openId = (ui.openId === id) ? null : id;
          paintList();
          return;
        }
        if (accBtn) {
          state = acceptDoc(accBtn.getAttribute("data-lh-accept"), state);
          writeState(state);
          paintGate(); paintList();
          try { HC.util.toast("Accepted"); } catch (x) {}
          return;
        }
      });
      gate.addEventListener("click", function (e) {
        if (e.target && e.target.id === "lhAcceptAll") {
          var out = outstandingAcceptances(hub, state);
          for (var i = 0; i < out.length; i++) state = acceptDoc(out[i].id, state);
          writeState(state);
          paintGate(); paintList();
          try { HC.util.toast("Thanks — you can now book a camp"); } catch (x) {}
        }
      });

      paintGate();
      paintList();
    } catch (e) {
      try {
        mountEl.innerHTML = '<p style="color:#9a1f5e">Legal hub failed to render: ' +
          esc(e && e.message ? e.message : String(e)) + "</p>";
      } catch (e2) { /* give up quietly */ }
    }
  }

  /* ============================================================
     selfTest — exercises the LOGIC and asserts the acceptance
     criterion: "The site exposes T&Cs, privacy and programme terms."
     ============================================================ */

  function selfTest() {
    var pass = 0, fail = 0, log = [];
    function check(label, fn) {
      try { fn(); pass += 1; log.push("✓ " + label); }
      catch (e) { fail += 1; log.push("✗ " + label + " — " + (e && e.message ? e.message : String(e))); }
    }

    // ===== ACCEPTANCE CRITERION =====
    // The site exposes T&Cs, privacy and programme terms.

    check("ACCEPTANCE: hub exposes a Terms & Conditions document", function () {
      var hub = buildHub();
      HC.assert(hub.exposes.terms === true, "hub must expose a terms document");
      var terms = hub.docs.filter(function (d) { return d.category === "terms"; });
      HC.assert(terms.length >= 1, "expected >=1 T&Cs doc, got " + terms.length);
      HC.assert(/terms/i.test(terms[0].title), "the T&Cs doc title should mention Terms");
    });

    check("ACCEPTANCE: hub exposes a Privacy Policy document", function () {
      var hub = buildHub();
      HC.assert(hub.exposes.privacy === true, "hub must expose a privacy document");
      var priv = hub.docs.filter(function (d) { return d.category === "privacy"; });
      HC.assert(priv.length >= 1, "expected >=1 privacy doc, got " + priv.length);
      HC.assert(priv.some(function (d) { return /privacy/i.test(d.title); }),
        "a privacy doc title should mention Privacy");
    });

    check("ACCEPTANCE: hub exposes programme terms", function () {
      var hub = buildHub();
      HC.assert(hub.exposes.programme === true, "hub must expose programme terms");
      var prog = hub.docs.filter(function (d) { return d.category === "programme"; });
      HC.assert(prog.length >= 1, "expected >=1 programme-terms doc, got " + prog.length);
    });

    check("ACCEPTANCE: the headline 'all' flag is true (T&Cs + privacy + programme)", function () {
      var hub = buildHub();
      HC.assert(hub.exposes.all === true,
        "hub.exposes.all must be true — all three mandatory legals present");
    });

    check("ACCEPTANCE: category index contains terms, privacy AND programme", function () {
      var hub = buildHub();
      var ids = hub.categories.map(function (c) { return c.id; });
      for (var i = 0; i < MANDATORY_CATEGORIES.length; i++) {
        HC.assert(ids.indexOf(MANDATORY_CATEGORIES[i]) !== -1,
          "category index missing mandatory category: " + MANDATORY_CATEGORIES[i]);
      }
      // Every mandatory category must be flagged mandatory and have count>=1.
      hub.categories.forEach(function (c) {
        if (MANDATORY_CATEGORIES.indexOf(c.id) !== -1) {
          HC.assert(c.mandatory === true, c.id + " should be flagged mandatory");
          HC.assert(c.count >= 1, c.id + " must have >=1 doc, got " + c.count);
        }
      });
    });

    // ===== Search/filter must never hide the core legals =====

    check("ACCEPTANCE holds under search: a no-match query still surfaces T&Cs, privacy & programme", function () {
      var hub = buildHub();
      // A free-text query that matches nothing in the catalogue.
      var res = searchDocs(hub, "zzz-nonexistent-query-xyzzy", "");
      HC.assert(res.length >= 3, "core pinned legals must remain, got " + res.length);
      HC.assert(res.some(function (d) { return d.category === "terms"; }), "T&Cs still surfaced");
      HC.assert(res.some(function (d) { return d.category === "privacy"; }), "Privacy still surfaced");
      HC.assert(res.some(function (d) { return d.category === "programme"; }), "Programme terms still surfaced");
    });

    check("ACCEPTANCE holds under empty query: every category's docs are returned", function () {
      var hub = buildHub();
      var res = searchDocs(hub, "", "");
      HC.assert(res.length === hub.docs.length,
        "empty query should return all " + hub.docs.length + " docs, got " + res.length);
    });

    // ===== Functional search behaviour =====

    check("Free-text search matches section bodies, not just titles", function () {
      var hub = buildHub();
      var res = searchDocs(hub, "refund", "");
      // "refund" appears in the cancellation doc's section body / summary.
      HC.assert(res.some(function (d) { return d.id === "cancellation-policy"; }),
        "search for 'refund' should find the cancellation policy");
    });

    check("Search matching 'child' finds the Privacy Policy", function () {
      var hub = buildHub();
      var res = searchDocs(hub, "child", "");
      HC.assert(res.some(function (d) { return d.category === "privacy"; }),
        "'child' should surface a privacy doc (children's data)");
    });

    check("Category filter restricts results to that category", function () {
      var hub = buildHub();
      var res = searchDocs(hub, "", "programme");
      HC.assert(res.length >= 1, "programme filter should return programme docs");
      HC.assert(res.every(function (d) { return d.category === "programme"; }),
        "every result must be in the programme category");
      // With a category filter, the pin-guarantee must NOT inject other-category docs.
      HC.assert(!res.some(function (d) { return d.category === "terms"; }),
        "category filter must not leak T&Cs into a programme-only view");
    });

    // ===== Document integrity =====

    check("Every document has a stable slug, url and a last-reviewed stamp", function () {
      var hub = buildHub();
      HC.assert(hub.docs.length >= 5, "expected a real catalogue, got " + hub.docs.length);
      hub.docs.forEach(function (d) {
        HC.assert(d.slug && /^[a-z0-9-]+$/.test(d.slug), "bad slug for " + d.id + ": " + d.slug);
        HC.assert(d.url.indexOf("/legal/") === 0, "url must be under /legal/ for " + d.id);
        HC.assert(d.lastReviewed && d.lastReviewed !== "", "missing review date for " + d.id);
      });
    });

    check("Every document has at least one anchored section", function () {
      var hub = buildHub();
      hub.docs.forEach(function (d) {
        HC.assert(d.sections.length >= 1, d.id + " should have >=1 section");
        d.sections.forEach(function (s) {
          HC.assert(s.anchor && /^[a-z0-9-]+$/.test(s.anchor), "bad anchor in " + d.id);
        });
      });
    });

    check("Document ids are unique", function () {
      var hub = buildHub();
      var seen = {};
      hub.docs.forEach(function (d) {
        HC.assert(!seen[d.id], "duplicate doc id: " + d.id);
        seen[d.id] = true;
      });
    });

    // ===== Acceptance gate (mirrors "accept T&Cs before booking") =====

    check("A fresh family has an outstanding T&Cs acceptance and cannot checkout", function () {
      var hub = buildHub();
      var st = { accepted: {} };
      var out = outstandingAcceptances(hub, st);
      HC.assert(out.length >= 1, "T&Cs acceptance should be outstanding for a new family");
      HC.assert(out.some(function (d) { return d.category === "terms"; }),
        "the outstanding acceptance must be the Terms & Conditions");
      HC.assert(canProceedToCheckout(hub, st) === false,
        "a family must not be able to checkout before accepting T&Cs");
    });

    check("Accepting the required legals clears the gate", function () {
      var hub = buildHub();
      var st = { accepted: {} };
      var out = outstandingAcceptances(hub, st);
      for (var i = 0; i < out.length; i++) st = acceptDoc(out[i].id, st);
      HC.assert(outstandingAcceptances(hub, st).length === 0, "no acceptances should remain");
      HC.assert(canProceedToCheckout(hub, st) === true,
        "family can checkout once all required legals accepted");
    });

    check("Only acceptance-required docs gate checkout (privacy is read-only)", function () {
      var hub = buildHub();
      var priv = hub.byId["privacy-policy"];
      HC.assert(priv, "privacy doc should exist");
      HC.assert(priv.acceptanceRequired === false,
        "privacy is read, not accepted (article 2381438: 'read your privacy policy')");
      var terms = hub.byId["platform-terms"];
      HC.assert(terms && terms.acceptanceRequired === true,
        "T&Cs must be acceptance-required");
    });

    // ===== Persistence via HC.store (never raw localStorage) =====

    check("Acceptance state round-trips through HC.store", function () {
      var hub = buildHub();
      // snapshot + clear any prior state so the test is hermetic
      var prior = readState();
      writeState({ accepted: {} });
      var st = readState();
      HC.assert(canProceedToCheckout(hub, st) === false, "cleared state should block checkout");
      var out = outstandingAcceptances(hub, st);
      for (var i = 0; i < out.length; i++) st = acceptDoc(out[i].id, st);
      writeState(st);
      var back = readState();
      HC.assert(canProceedToCheckout(hub, back) === true,
        "accepted state must persist via HC.store and clear the gate");
      // restore prior state so we leave the store as we found it
      writeState(prior && prior.accepted ? prior : { accepted: {} });
    });

    // ===== Defensive: malformed catalogue entries never break the hub =====

    check("normaliseDoc rejects junk and keeps the hub well-formed", function () {
      HC.assert(normaliseDoc(null) === null, "null doc rejected");
      HC.assert(normaliseDoc({}) === null, "empty doc rejected (no id/title)");
      HC.assert(normaliseDoc({ id: "x" }) === null, "doc with no title rejected");
      var ok = normaliseDoc({ id: "y", title: "Y", sections: [null, { h: "", body: "" }, { h: "Hi", body: "There" }] });
      HC.assert(ok && ok.sections.length === 1, "only the real section should survive");
    });

    check("searchDocs/outstanding tolerate garbage inputs without throwing", function () {
      var garbage = [null, undefined, 42, "", [], {}, { docs: "no" }];
      for (var i = 0; i < garbage.length; i++) {
        var res = searchDocs(garbage[i], "terms", "");
        HC.assert(Array.isArray(res), "searchDocs must return an array for input #" + i);
        var out = outstandingAcceptances(garbage[i], garbage[i]);
        HC.assert(Array.isArray(out), "outstandingAcceptances must return an array for input #" + i);
      }
    });

    return { pass: pass, fail: fail, log: log };
  }

  /* ---------------- register ---------------- */

  HC.registerFeature({
    id: "platform-legal-tnc",
    title: "Legal / T&Cs / privacy hub",
    side: "platform",
    icon: "⚖️",
    summary: "HolidayCamp's public legal hub — Terms & Conditions, Privacy Policy and programme terms (badges, referrals, seasonal campaigns), plus complaints and cancellation. Searchable and categorised, with a T&Cs acceptance gate before booking.",
    render: render,
    selfTest: selfTest
  });
})();
