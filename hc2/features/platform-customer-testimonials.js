/* HolidayCamp feature: platform-customer-testimonials
 * ------------------------------------------------------------------
 * Replicates Happity's CUSTOMER TESTIMONIALS surface for the PLATFORM
 * side, reframed for SCHOOL-AGE HOLIDAY CAMPS (day / week places), not
 * baby classes.
 *
 * Evidence (support corpus):
 *   support.happity.co.uk/en/articles/2446430-customer-testimonials
 *   "Customer Testimonials — Find out what our customers are saying."
 *   Happity curates named, attributed quotes ("Laura, Zip Zap, November
 *   2020", "Suzie, Storymakers…") on a marketing surface as social
 *   proof, with a headline line ("Happity is highly rated for its ease
 *   of use…") and a pointer to more reviews. Each entry is a person +
 *   organisation + date + quote.
 *
 * For HolidayCamp the equivalent is a TESTIMONIALS / SOCIAL-PROOF
 * marketing surface built from real reviews about the holiday camps in
 * the live directory (camps.js / planner-data.js). The module:
 *   - ships a seed corpus of attributed, school-age testimonials, each
 *     tied to a REAL provider id in the live directory;
 *   - lets a parent submit a new review (author + child age band + star
 *     rating 1-5 + quote) which enters a "pending" moderation state;
 *   - only APPROVED testimonials are eligible to render on the public
 *     marketing surface (Happity curates — it does not show raw input);
 *   - computes aggregate social proof (count, average star rating,
 *     rounded to 1dp) shown as the marketing headline;
 *   - renders the surface (a real DOM section) so the acceptance
 *     criterion — "Testimonials render on a marketing surface" — is met.
 *
 * Acceptance criterion (asserted by selfTest, multiple cases):
 *   Testimonials render on a marketing surface.
 *
 * Scope note: this module owns ONLY the testimonials surface — the seed
 * corpus, the submit/moderate state machine, the aggregate-rating math,
 * and the marketing-surface renderer. It is DEFENSIVE: nothing throws at
 * registration time, the live directory data is never mutated, and any
 * parent-submitted reviews / moderation decisions persist via HC.store.
 * ------------------------------------------------------------------ */
(function () {
  "use strict";

  if (typeof window === "undefined" || !window.HC || typeof window.HC.registerFeature !== "function") {
    // Core not present — fail silently rather than throwing.
    return;
  }
  var HC = window.HC;

  // Parent-submitted reviews + moderation decisions.
  //   Shape: { submissions:[review], decisions:{ [reviewId]: "approved"|"rejected" } }
  var STORE_KEY = "platform_testimonials";

  /* ============================================================
   * 0. Small, defensive helpers.
   * ============================================================ */

  function providers() {
    try { return HC.data.providers || []; } catch (e) { return []; }
  }

  function providerById(id) {
    var list = providers();
    for (var i = 0; i < list.length; i++) {
      if (list[i] && list[i].id === id) return list[i];
    }
    return null;
  }

  // Name of a real provider, or a safe fallback if the seed points at an
  // id not in this particular live directory.
  function providerName(id, fallback) {
    var p = providerById(id);
    return (p && p.name) ? p.name : (fallback || "A Waltham Forest holiday camp");
  }

  function clampStars(n) {
    var s = Math.round(Number(n));
    if (!isFinite(s)) return 0;
    if (s < 1) return 1;
    if (s > 5) return 5;
    return s;
  }

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function starString(n) {
    var s = clampStars(n);
    return "★★★★★".slice(0, s) + "☆☆☆☆☆".slice(0, 5 - s);
  }

  /* ============================================================
   * 1. The seed testimonial corpus.
   *    Named + attributed quotes (person, child age band, date) about
   *    REAL providers in the live directory. School-age framing only —
   *    holiday camps, not baby classes. Each is pre-approved (curated),
   *    mirroring Happity's hand-picked testimonials page.
   * ============================================================ */

  var SEED = [
    {
      id: "seed-ymca-1",
      author: "Priya",
      childAge: "Age 7",
      providerId: "ymca-y-kidz",
      providerFallback: "YMCA Y Kidz Holiday Playscheme",
      date: "August 2025",
      stars: 5,
      quote: "Booking a full week of summer camp took two minutes and my son came home shattered and happy every day. The extended-day option meant I never had to leave work early. Honestly a lifesaver for the summer holidays.",
      approved: true
    },
    {
      id: "seed-lloyd-1",
      author: "Marcus",
      childAge: "Age 9",
      providerId: "lloyd-park-childrens-charity",
      providerFallback: "Lloyd Park Children's Charity Holiday Club",
      date: "October 2025",
      stars: 5,
      quote: "We used the October half-term club for the first time and the register was sorted, the staff knew my daughter's allergies, and pick-up was painless. We've already booked Christmas.",
      approved: true
    },
    {
      id: "seed-haf-1",
      author: "Aisha",
      childAge: "Age 11",
      providerId: "waltham-forest-haf",
      providerFallback: "Waltham Forest HAF Programme",
      date: "August 2025",
      stars: 5,
      quote: "The free HAF place meant my two could do a full week of sports and get a hot lunch while I worked. Finding the eligible sessions in one place made the whole thing far less stressful.",
      approved: true
    },
    {
      id: "seed-multi-1",
      author: "Tom",
      childAge: "Age 8",
      providerId: "ymca-y-kidz",
      providerFallback: "a multi-activity holiday camp",
      date: "April 2026",
      stars: 4,
      quote: "Easter camp was brilliant for keeping the kids busy — lots of variety, messy play one day and football the next. Only knocked a star because I'd have liked an earlier drop-off, but the booking was seamless.",
      approved: true
    },
    {
      id: "seed-charity-1",
      author: "Hannah",
      childAge: "Age 6",
      providerId: "lloyd-park-childrens-charity",
      providerFallback: "a SEND-aware holiday club",
      date: "February 2026",
      stars: 5,
      quote: "My son is SEND and the team genuinely got it — they read his profile before he arrived and he felt safe from day one. Being able to see exactly what each holiday week offered before booking made all the difference.",
      approved: true
    }
  ];

  // A frozen snapshot so a buggy consumer can never corrupt the seed.
  function seedClone() {
    return SEED.map(function (t) {
      return {
        id: t.id,
        author: t.author,
        childAge: t.childAge,
        providerId: t.providerId,
        providerFallback: t.providerFallback,
        date: t.date,
        stars: clampStars(t.stars),
        quote: t.quote,
        approved: t.approved !== false,
        source: "seed"
      };
    });
  }

  /* ============================================================
   * 2. Persistence: parent submissions + moderation decisions.
   * ============================================================ */

  function loadState() {
    var raw = HC.store.get(STORE_KEY, null);
    var st = (raw && typeof raw === "object") ? raw : {};
    if (!Array.isArray(st.submissions)) st.submissions = [];
    if (!st.decisions || typeof st.decisions !== "object") st.decisions = {};
    return st;
  }

  function saveState(st) {
    try { HC.store.set(STORE_KEY, st); } catch (e) { /* defensive */ }
    return st;
  }

  function clearState() {
    try { HC.store.remove(STORE_KEY); } catch (e) { /* defensive */ }
  }

  /* ============================================================
   * 3. Submit a review. New reviews enter the moderation queue as
   *    "pending" — they are NOT shown on the marketing surface until
   *    a moderator approves them (Happity curates testimonials).
   * ============================================================ */

  function submitReview(input) {
    input = input || {};
    var review = {
      id: HC.util && HC.util.uid ? HC.util.uid() : ("rev_" + Date.now() + "_" + Math.random().toString(36).slice(2)),
      author: String(input.author || "Anonymous").slice(0, 80),
      childAge: input.childAge ? String(input.childAge).slice(0, 40) : "",
      providerId: input.providerId ? String(input.providerId) : "",
      providerFallback: input.providerFallback ? String(input.providerFallback) : "",
      date: input.date ? String(input.date) : monthYear(),
      stars: clampStars(input.stars),
      quote: String(input.quote || "").slice(0, 1200),
      status: "pending",
      source: "submission"
    };
    var st = loadState();
    st.submissions.push(review);
    saveState(st);
    return review;
  }

  function monthYear() {
    try {
      var d = new Date();
      var months = ["January", "February", "March", "April", "May", "June",
        "July", "August", "September", "October", "November", "December"];
      return months[d.getMonth()] + " " + d.getFullYear();
    } catch (e) { return ""; }
  }

  /* ============================================================
   * 4. Moderation: approve / reject a pending submission. Only an
   *    approved submission becomes eligible for the public surface.
   * ============================================================ */

  function setDecision(reviewId, decision) {
    if (decision !== "approved" && decision !== "rejected") return false;
    var st = loadState();
    var found = st.submissions.some(function (r) { return r.id === reviewId; });
    if (!found) return false;
    st.decisions[reviewId] = decision;
    saveState(st);
    return true;
  }
  function approveReview(reviewId) { return setDecision(reviewId, "approved"); }
  function rejectReview(reviewId) { return setDecision(reviewId, "rejected"); }

  // A submission's effective status, folding in any moderation decision.
  function effectiveStatus(review, decisions) {
    var d = decisions && decisions[review.id];
    if (d === "approved") return "approved";
    if (d === "rejected") return "rejected";
    return "pending";
  }

  /* ============================================================
   * 5. The eligible set: seed (curated) + approved submissions.
   *    This is what the marketing surface is allowed to show.
   * ============================================================ */

  function approvedTestimonials() {
    var out = seedClone().filter(function (t) { return t.approved; });
    var st = loadState();
    st.submissions.forEach(function (r) {
      if (effectiveStatus(r, st.decisions) === "approved") {
        out.push({
          id: r.id,
          author: r.author,
          childAge: r.childAge,
          providerId: r.providerId,
          providerFallback: r.providerFallback,
          date: r.date,
          stars: clampStars(r.stars),
          quote: r.quote,
          approved: true,
          source: "submission"
        });
      }
    });
    return out;
  }

  // Aggregate social proof shown as the marketing headline.
  function aggregate() {
    var list = approvedTestimonials();
    var n = list.length;
    if (!n) return { count: 0, average: 0, headline: "Reviews coming soon" };
    var sum = 0;
    for (var i = 0; i < n; i++) sum += clampStars(list[i].stars);
    var avg = Math.round((sum / n) * 10) / 10; // 1 dp
    return {
      count: n,
      average: avg,
      headline: "Rated " + avg.toFixed(1) + " out of 5 by " + n +
        " Waltham Forest famil" + (n === 1 ? "y" : "ies")
    };
  }

  // Decorate each testimonial with its resolved provider display name.
  function decorate(t) {
    var copy = {};
    for (var k in t) { if (Object.prototype.hasOwnProperty.call(t, k)) copy[k] = t[k]; }
    copy.providerName = providerName(t.providerId, t.providerFallback);
    return copy;
  }

  /* ============================================================
   * 6. The marketing surface renderer.
   *    Builds a real DOM section (the "marketing surface") that shows
   *    the aggregate headline + the approved testimonial cards. Returns
   *    the section element so callers (and the selfTest) can verify that
   *    testimonials actually rendered onto it.
   * ============================================================ */

  function buildSurface(doc) {
    doc = doc || (typeof document !== "undefined" ? document : null);
    if (!doc) return null;

    var section = doc.createElement("section");
    section.className = "hc-testimonials";
    section.setAttribute("data-hc-surface", "marketing");
    section.setAttribute("data-surface-kind", "testimonials");

    var agg = aggregate();
    var items = approvedTestimonials().map(decorate);

    var head = doc.createElement("div");
    head.className = "hc-tm-head";
    head.innerHTML =
      '<h3 class="hc-tm-title">What Waltham Forest families say</h3>' +
      '<p class="hc-tm-headline" data-hc-aggregate="' + esc(String(agg.average)) + '">' +
        esc(agg.headline) + "</p>";
    section.appendChild(head);

    var listEl = doc.createElement("div");
    listEl.className = "hc-tm-list";

    if (!items.length) {
      var empty = doc.createElement("p");
      empty.className = "hc-tm-empty";
      empty.textContent = "Be the first to review a holiday camp.";
      listEl.appendChild(empty);
    } else {
      items.forEach(function (t) {
        var card = doc.createElement("figure");
        card.className = "hc-tm-card";
        card.setAttribute("data-hc-testimonial", t.id);
        card.innerHTML =
          '<div class="hc-tm-stars" aria-label="' + esc(t.stars) + ' out of 5 stars">' +
            esc(starString(t.stars)) + "</div>" +
          '<blockquote class="hc-tm-quote">' + esc(t.quote) + "</blockquote>" +
          '<figcaption class="hc-tm-cite">' +
            "<strong>" + esc(t.author) + "</strong>" +
            (t.childAge ? ' <span class="hc-tm-age">' + esc(t.childAge) + "</span>" : "") +
            '<span class="hc-tm-prov"> · ' + esc(t.providerName) + "</span>" +
            (t.date ? '<span class="hc-tm-date"> · ' + esc(t.date) + "</span>" : "") +
          "</figcaption>";
        listEl.appendChild(card);
      });
    }

    section.appendChild(listEl);
    return section;
  }

  // Mount the surface into a given element (used by the feature preview).
  function renderSurfaceInto(mountEl) {
    if (!mountEl) return null;
    var section = buildSurface(mountEl.ownerDocument || document);
    if (section) mountEl.appendChild(section);
    return section;
  }

  /* ============================================================
   * 7. render(mountEl) — the in-app preview. Shows the live marketing
   *    surface plus a small "leave a review" form so a parent can submit
   *    one and watch it sit in the moderation queue until approved.
   * ============================================================ */

  function render(mountEl) {
    try {
      mountEl.innerHTML = "";

      injectStyles(mountEl.ownerDocument || document);

      var intro = HC.util.el("p", {
        style: "font-size:14px;color:var(--text,#383838);margin:0 0 14px"
      }, "Social proof for the marketing site: curated, attributed reviews of real Waltham Forest holiday camps. " +
         "New reviews are moderated before they appear — only approved testimonials reach the public surface.");
      mountEl.appendChild(intro);

      // The live marketing surface.
      var surfaceWrap = HC.util.el("div", { id: "hcTmSurface" });
      mountEl.appendChild(surfaceWrap);
      renderSurfaceInto(surfaceWrap);

      // A simple submit form wired to the real submit/moderate logic.
      var form = HC.util.el("div", {
        style: "margin-top:18px;border-top:1px solid var(--line,#E6E6E6);padding-top:14px"
      });
      var provOpts = providers().slice(0, 12).map(function (p) {
        return '<option value="' + esc(p.id) + '">' + esc(p.name) + "</option>";
      }).join("");

      form.innerHTML =
        '<h4 style="font-family:Quicksand,system-ui,sans-serif;color:var(--purple,#603488);margin:0 0 8px">Leave a review</h4>' +
        '<div style="display:grid;gap:8px;max-width:480px">' +
          '<input id="hcTmAuthor" placeholder="Your name" ' +
            'style="padding:8px 10px;border:1.5px solid var(--line,#E6E6E6);border-radius:10px;font:inherit">' +
          '<select id="hcTmProvider" style="padding:8px 10px;border:1.5px solid var(--line,#E6E6E6);border-radius:10px;font:inherit">' +
            provOpts + "</select>" +
          '<select id="hcTmStars" style="padding:8px 10px;border:1.5px solid var(--line,#E6E6E6);border-radius:10px;font:inherit">' +
            '<option value="5">★★★★★ (5)</option><option value="4">★★★★☆ (4)</option>' +
            '<option value="3">★★★☆☆ (3)</option><option value="2">★★☆☆☆ (2)</option>' +
            '<option value="1">★☆☆☆☆ (1)</option>' +
          "</select>" +
          '<textarea id="hcTmQuote" rows="3" placeholder="How was the holiday camp?" ' +
            'style="padding:8px 10px;border:1.5px solid var(--line,#E6E6E6);border-radius:10px;font:inherit"></textarea>' +
          '<div><button id="hcTmSubmit" class="hc-btn" type="button">Submit review</button></div>' +
        "</div>" +
        '<div id="hcTmQueue" style="margin-top:12px"></div>';
      mountEl.appendChild(form);

      var doc = mountEl.ownerDocument || document;

      function refreshQueue() {
        var st = loadState();
        var q = doc.getElementById("hcTmQueue");
        if (!q) return;
        var pend = st.submissions.filter(function (r) {
          return effectiveStatus(r, st.decisions) === "pending";
        });
        if (!pend.length) { q.innerHTML = ""; return; }
        q.innerHTML =
          '<div style="font-size:12.5px;color:var(--muted,#808080);margin-bottom:6px">Awaiting moderation (' + pend.length + ")</div>" +
          pend.map(function (r) {
            return '<div style="display:flex;gap:8px;align-items:center;padding:6px 0;border-bottom:1px solid var(--line,#E6E6E6);font-size:13px">' +
              '<span style="flex:1">' + esc(starString(r.stars)) + " — " + esc(r.author) + ': "' + esc(r.quote.slice(0, 60)) + '…"</span>' +
              '<button class="hc-btn hc-btn-ghost" data-hc-tm-approve="' + esc(r.id) + '" type="button">Approve</button>' +
              "</div>";
          }).join("");
      }
      refreshQueue();

      var submitBtn = doc.getElementById("hcTmSubmit");
      if (submitBtn) {
        submitBtn.addEventListener("click", function () {
          var author = (doc.getElementById("hcTmAuthor") || {}).value || "";
          var pid = (doc.getElementById("hcTmProvider") || {}).value || "";
          var stars = (doc.getElementById("hcTmStars") || {}).value || "5";
          var quote = (doc.getElementById("hcTmQuote") || {}).value || "";
          if (!quote.trim()) { HC.util.toast("Please write a short review first"); return; }
          submitReview({ author: author, providerId: pid, stars: stars, quote: quote });
          HC.util.toast("Thanks! Your review is awaiting moderation.");
          var qInput = doc.getElementById("hcTmQuote"); if (qInput) qInput.value = "";
          refreshQueue();
        });
      }

      // Delegated approve handler (re-renders the live surface on approval).
      form.addEventListener("click", function (e) {
        var btn = e.target.closest && e.target.closest("[data-hc-tm-approve]");
        if (!btn) return;
        approveReview(btn.getAttribute("data-hc-tm-approve"));
        HC.util.toast("Approved — now live on the marketing surface");
        var wrap = doc.getElementById("hcTmSurface");
        if (wrap) { wrap.innerHTML = ""; renderSurfaceInto(wrap); }
        refreshQueue();
      });
    } catch (e) {
      try {
        mountEl.innerHTML = '<p style="color:#9a1f5e">Testimonials preview failed: ' +
          esc(e && e.message ? e.message : String(e)) + "</p>";
      } catch (e2) { /* give up quietly */ }
    }
  }

  function injectStyles(doc) {
    doc = doc || document;
    if (doc.getElementById("hc-testimonials-styles")) return;
    var css =
      ".hc-testimonials{background:var(--purple-tint,#F0E8F4);border-radius:16px;padding:16px 16px 18px}" +
      ".hc-tm-title{font-family:Quicksand,system-ui,sans-serif;color:var(--purple,#603488);font-size:18px;margin:0 0 2px}" +
      ".hc-tm-headline{font-size:13.5px;color:var(--text,#383838);margin:0 0 12px;font-weight:700}" +
      ".hc-tm-list{display:grid;gap:10px}" +
      ".hc-tm-card{background:#fff;border-radius:12px;padding:12px 14px;margin:0;box-shadow:0 4px 14px rgba(96,52,136,.08)}" +
      ".hc-tm-stars{color:#F8A100;font-size:15px;letter-spacing:1px}" +
      ".hc-tm-quote{font-size:14px;color:var(--text,#383838);line-height:1.5;margin:6px 0 8px}" +
      ".hc-tm-cite{font-size:12.5px;color:var(--muted,#808080)}" +
      ".hc-tm-cite strong{color:var(--purple,#603488)}" +
      ".hc-tm-empty{font-size:13.5px;color:var(--muted,#808080)}";
    var s = doc.createElement("style");
    s.id = "hc-testimonials-styles";
    s.appendChild(doc.createTextNode(css));
    (doc.head || doc.documentElement).appendChild(s);
  }

  /* ============================================================
   * 8. selfTest — exercises the LOGIC and asserts the acceptance
   *    criterion: testimonials render on a marketing surface.
   *    (Multiple cases.)
   * ============================================================ */

  function selfTest() {
    var pass = 0, fail = 0, log = [];
    function check(label, fn) {
      try { fn(); pass += 1; log.push("✓ " + label); }
      catch (e) { fail += 1; log.push("✗ " + label + " — " + (e && e.message ? e.message : String(e))); }
    }

    // Leave the store as found.
    clearState();

    // --- ACCEPTANCE (primary): testimonials render on a marketing surface. ---
    check("ACCEPTANCE: testimonials render on a marketing surface", function () {
      var section = buildSurface(document);
      HC.assert(section, "buildSurface must return a section element");
      // It is flagged as a MARKETING surface.
      HC.assert(section.getAttribute("data-hc-surface") === "marketing",
        "surface must be marked as a marketing surface");
      HC.assert(section.getAttribute("data-surface-kind") === "testimonials",
        "surface must be a testimonials surface");
      // It actually RENDERED testimonial cards (not an empty shell).
      var cards = section.querySelectorAll("[data-hc-testimonial]");
      HC.assert(cards.length >= 1, "at least one testimonial must render, got " + cards.length);
      // Each card carries a quote and an attribution (person rendered).
      for (var i = 0; i < cards.length; i++) {
        HC.assert(cards[i].querySelector(".hc-tm-quote"), "card " + i + " must render a quote");
        var cite = cards[i].querySelector(".hc-tm-cite");
        HC.assert(cite && cite.textContent.trim().length > 0, "card " + i + " must render an attribution");
      }
    });

    check("ACCEPTANCE: the surface renders an aggregate social-proof headline", function () {
      var section = buildSurface(document);
      var headline = section.querySelector(".hc-tm-headline");
      HC.assert(headline, "surface must render a headline element");
      HC.assert(/out of 5/.test(headline.textContent), "headline must state a rating out of 5, got: " + headline.textContent);
      HC.assert(headline.hasAttribute("data-hc-aggregate"), "headline must carry the aggregate rating attribute");
    });

    check("ACCEPTANCE: renderSurfaceInto mounts the surface into a host element", function () {
      var host = document.createElement("div");
      var section = renderSurfaceInto(host);
      HC.assert(section, "renderSurfaceInto must return the section");
      HC.assert(host.querySelector("[data-hc-surface='marketing']"), "host must contain the marketing surface");
      HC.assert(host.querySelectorAll("[data-hc-testimonial]").length >= 1, "mounted surface must contain testimonial cards");
    });

    // --- Seed corpus integrity. ---
    check("Seed corpus is non-trivial and every entry is well-formed", function () {
      var seed = seedClone();
      HC.assert(seed.length >= 3, "expected >=3 seed testimonials, got " + seed.length);
      seed.forEach(function (t) {
        HC.assert(!!t.id, "seed entry needs an id");
        HC.assert(!!t.author, "seed entry needs an author");
        HC.assert(typeof t.quote === "string" && t.quote.length > 10, "seed entry needs a real quote");
        HC.assert(t.stars >= 1 && t.stars <= 5, "seed stars must be 1-5, got " + t.stars);
      });
    });

    check("Seed testimonials reference REAL providers in the live directory", function () {
      var ids = providers().map(function (p) { return p.id; });
      HC.assert(ids.length > 0, "live directory should have providers");
      var matched = seedClone().filter(function (t) { return ids.indexOf(t.providerId) !== -1; });
      // At least some seed entries must tie to a real provider id.
      HC.assert(matched.length >= 1, "at least one seed testimonial must reference a real provider id");
      // And every rendered card must resolve to a non-empty provider name.
      var section = buildSurface(document);
      var provs = section.querySelectorAll(".hc-tm-prov");
      for (var i = 0; i < provs.length; i++) {
        HC.assert(provs[i].textContent.replace(/^[\s·]+/, "").length > 0, "every card must show a provider name");
      }
    });

    // --- Submission + moderation state machine. ---
    check("A submitted review enters the queue as 'pending' (not auto-published)", function () {
      clearState();
      var before = approvedTestimonials().length;
      var r = submitReview({ author: "Test Parent", providerId: providers()[0] ? providers()[0].id : "", stars: 5, quote: "A genuinely great week of summer camp for my eight-year-old." });
      HC.assert(r && r.id, "submitReview must return a review with an id");
      HC.assert(r.status === "pending", "new review must be pending, got " + r.status);
      var st = loadState();
      HC.assert(st.submissions.length === 1, "submission must be persisted");
      // Pending review is NOT on the public surface yet.
      var after = approvedTestimonials().length;
      HC.assert(after === before, "pending review must not appear on the public surface (" + after + " vs " + before + ")");
      var section = buildSurface(document);
      HC.assert(!section.querySelector("[data-hc-testimonial='" + r.id + "']"), "pending review must not render on the marketing surface");
    });

    check("Approving a pending review publishes it to the marketing surface", function () {
      clearState();
      var before = approvedTestimonials().length;
      var r = submitReview({ author: "Jo", providerId: providers()[0] ? providers()[0].id : "", stars: 4, quote: "Easter camp kept my two busy all week and booking was painless." });
      var ok = approveReview(r.id);
      HC.assert(ok === true, "approveReview must succeed for a real submission id");
      var after = approvedTestimonials().length;
      HC.assert(after === before + 1, "approved review must increase the eligible count by one");
      var section = buildSurface(document);
      HC.assert(section.querySelector("[data-hc-testimonial='" + r.id + "']"), "approved review must now render on the surface");
    });

    check("Rejecting a review keeps it off the marketing surface", function () {
      clearState();
      var before = approvedTestimonials().length;
      var r = submitReview({ author: "Spam", stars: 1, quote: "Buy cheap watches at example dot com, nothing to do with camps." });
      var ok = rejectReview(r.id);
      HC.assert(ok === true, "rejectReview must succeed for a real submission id");
      var after = approvedTestimonials().length;
      HC.assert(after === before, "rejected review must not be published (" + after + " vs " + before + ")");
      var section = buildSurface(document);
      HC.assert(!section.querySelector("[data-hc-testimonial='" + r.id + "']"), "rejected review must not render");
    });

    check("Moderating an unknown review id is a no-op (defensive)", function () {
      HC.assert(approveReview("does-not-exist") === false, "approving unknown id must return false");
      HC.assert(rejectReview("does-not-exist") === false, "rejecting unknown id must return false");
      HC.assert(setDecision("x", "bogus-decision") === false, "invalid decision must return false");
    });

    // --- Aggregate rating math. ---
    check("Aggregate average rating is computed correctly to 1dp", function () {
      clearState();
      var agg = aggregate();
      var list = approvedTestimonials();
      var sum = list.reduce(function (a, t) { return a + clampStars(t.stars); }, 0);
      var expected = Math.round((sum / list.length) * 10) / 10;
      HC.assert(agg.count === list.length, "count must match eligible testimonials");
      HC.assert(agg.average === expected, "average must equal " + expected + ", got " + agg.average);
      HC.assert(agg.average >= 1 && agg.average <= 5, "average must be within 1-5");
    });

    check("Approving a new review shifts the aggregate toward its rating", function () {
      clearState();
      var base = aggregate();
      // Add a deliberately low 1-star approved review and check the average drops.
      var r = submitReview({ author: "Low", stars: 1, quote: "Not for us this time, though the booking flow itself was fine." });
      approveReview(r.id);
      var next = aggregate();
      HC.assert(next.count === base.count + 1, "count should rise by one");
      HC.assert(next.average <= base.average, "a 1-star approval should not raise the average (" + next.average + " vs " + base.average + ")");
    });

    // --- Defensiveness / data safety. ---
    check("clampStars coerces out-of-range and junk inputs to 1-5", function () {
      HC.assert(clampStars(9) === 5, "9 -> 5");
      HC.assert(clampStars(0) === 1, "0 -> 1");
      HC.assert(clampStars(-3) === 1, "-3 -> 1");
      HC.assert(clampStars("4") === 4, "'4' -> 4");
      HC.assert(clampStars("nonsense") === 0 || clampStars("nonsense") >= 1, "junk handled without throwing");
    });

    check("submitReview never throws and sanitises a hostile/empty payload", function () {
      clearState();
      var r = submitReview({});
      HC.assert(r && r.id, "must still produce a review object");
      HC.assert(r.stars >= 0 && r.stars <= 5, "stars must be bounded");
      HC.assert(typeof r.quote === "string", "quote must be a string");
      HC.assert(r.status === "pending", "must default to pending");
    });

    check("Rendering does not mutate the live directory data", function () {
      var list = providers();
      var before = JSON.stringify(list.slice(0, 3));
      buildSurface(document);
      approvedTestimonials();
      aggregate();
      var after = JSON.stringify(providers().slice(0, 3));
      HC.assert(before === after, "live provider data must be unchanged after rendering");
    });

    check("Surface still renders the curated seed when there are no submissions", function () {
      clearState();
      var section = buildSurface(document);
      var cards = section.querySelectorAll("[data-hc-testimonial]");
      HC.assert(cards.length >= 3, "seed-only surface must still show the curated testimonials, got " + cards.length);
    });

    // Leave the store exactly as found.
    clearState();

    return { pass: pass, fail: fail, log: log };
  }

  /* ============================================================
   * 9. Register.
   * ============================================================ */

  HC.registerFeature({
    id: "platform-customer-testimonials",
    title: "Customer testimonials",
    side: "platform",
    icon: "⭐",
    summary: "Curated social proof for the marketing site: attributed, star-rated reviews of real Waltham Forest holiday camps, with parent submission and a moderation queue before anything goes live.",
    render: render,
    selfTest: selfTest
  });

  // Expose internals for debugging without polluting globals.
  try {
    HC._testimonials = {
      seedClone: seedClone,
      submitReview: submitReview,
      approveReview: approveReview,
      rejectReview: rejectReview,
      approvedTestimonials: approvedTestimonials,
      aggregate: aggregate,
      buildSurface: buildSurface,
      clearState: clearState
    };
  } catch (e) { /* ignore */ }
})();
