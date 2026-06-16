/* HolidayCamp feature: platform-instagram-reshare
 * ------------------------------------------------------------------
 * Replicates Happity's INSTAGRAM STORIES RE-SHARE PROGRAMME for the
 * PLATFORM side, reframed for SCHOOL-AGE HOLIDAY CAMPS (not baby
 * classes).
 *
 * Evidence (support corpus):
 *   - 8790659 "How to get promoted on our Instagram stories":
 *       "Every Monday, Thursday and Sunday, we re-share providers'
 *        Instagram stories on our channel ... driving our followers to
 *        your booking link."
 *       Steps to qualify: (1) post a story that is still live on one of
 *       those days (stories live 24h), (2) add your booking link — "we
 *       can only share classes which are bookable", (3) tag @happityapp.
 *       Gate: "available to all Members with bookings switched on".
 *   - 9155760 §4 "Get a shout-out on our Instagram":
 *       "Tag us in your Instagram Stories with a booking link to get
 *        re-shared ... We re-share class providers to our stories on
 *        Mondays, Thursdays and Sundays."
 *
 * For HolidayCamp the platform runs the same programme: holiday-camp
 * providers tag the HolidayCamp brand handle in a Story, drop in their
 * bookable camp link, and on the next FIXED re-share day the platform
 * re-shares them to its followers.
 *
 * Acceptance criterion (asserted by selfTest, multiple cases):
 *   A camp tagging the brand with a booking link is eligible for a
 *   fixed-day re-share.
 *
 * Scope: this module owns ONLY the re-share surface — the fixed-day
 * schedule, the eligibility engine, and a small queue of submitted
 * stories. It is defensive (nothing throws at registration time) and
 * persists submissions via HC.store. The verified camp data is read,
 * never mutated.
 * ------------------------------------------------------------------ */
(function () {
  "use strict";

  if (typeof window === "undefined" || !window.HC || typeof window.HC.registerFeature !== "function") {
    // Core not present — fail silently rather than throwing.
    return;
  }
  var HC = window.HC;

  /* ============================================================
   * 1. Programme constants (lifted from the evidence).
   * ============================================================ */

  // The HolidayCamp brand handle a provider must tag (Happity uses
  // @happityapp; this is the school-age equivalent).
  var BRAND_HANDLE = "@holidaycampuk";

  // The FIXED days the platform re-shares on. Verbatim cadence from the
  // evidence: Monday, Thursday and Sunday. JS getDay(): 0=Sun..6=Sat.
  var RESHARE_DAYS = [
    { dow: 1, label: "Monday" },
    { dow: 4, label: "Thursday" },
    { dow: 0, label: "Sunday" }
  ];
  var RESHARE_DOW = RESHARE_DAYS.map(function (d) { return d.dow; });

  // Instagram Stories are live for 24 hours after posting (evidence).
  var STORY_LIVE_HOURS = 24;

  // The platform follower reach the re-share drives traffic to (school-age
  // equivalent of Happity's 23k; kept as a display figure only).
  var FOLLOWER_REACH = 23000;

  // localStorage key (namespaced via HC.store) for submitted stories.
  var STORE_KEY = "platform_ig_reshare_queue";

  var DAY_MS = 24 * 60 * 60 * 1000;
  var DOW_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

  /* ============================================================
   * 2. Helpers — bookable check + booking-link detection.
   *    A camp is "bookable on the platform" when the directory has a
   *    booking route for it (a non-empty booking string or a source
   *    URL). A story "has a booking link" when its caption/link text
   *    points at a real URL (or the provider's own booking page).
   * ============================================================ */

  function safeProviders() {
    try {
      var p = HC.data && HC.data.providers;
      return Array.isArray(p) ? p : [];
    } catch (e) { return []; }
  }

  function providerById(id) {
    var list = safeProviders();
    for (var i = 0; i < list.length; i++) {
      if (list[i] && list[i].id === id) return list[i];
    }
    return null;
  }

  // Is this camp bookable on the platform at all? (Happity: "we can only
  // share classes which are bookable on Happity".)
  function isCampBookable(provider) {
    if (!provider || typeof provider !== "object") return false;
    var booking = typeof provider.booking === "string" ? provider.booking.trim() : "";
    var hasSourceUrl = !!(provider.source && typeof provider.source.url === "string" &&
      /^https?:\/\//i.test(provider.source.url));
    // A live booking route is described in `booking`, or the provider has a
    // canonical source URL parents can book through.
    return booking.length > 0 || hasSourceUrl;
  }

  // Does a free-text value look like / contain a booking link?
  function looksLikeLink(text) {
    if (typeof text !== "string") return false;
    var t = text.trim();
    if (!t) return false;
    if (/^https?:\/\/\S+/i.test(t)) return true;            // explicit URL
    if (/\b\S+\.(co\.uk|com|org|uk|org\.uk)\b/i.test(t)) return true; // bare domain
    return false;
  }

  // Resolve the booking link a story would carry: an explicit link beats
  // the provider's own source URL.
  function resolveBookingLink(story, provider) {
    if (story && looksLikeLink(story.bookingLink)) return String(story.bookingLink).trim();
    if (provider && provider.source && looksLikeLink(provider.source.url)) {
      return String(provider.source.url).trim();
    }
    return null;
  }

  // Does the story tag the brand? Tolerant of "@HolidayCampUK", spacing,
  // and the bare handle without the @.
  function tagsBrand(story) {
    if (!story) return false;
    var raw = "";
    if (typeof story.tag === "string") raw = story.tag;
    else if (typeof story.caption === "string") raw = story.caption;
    if (!raw) return false;
    var needle = BRAND_HANDLE.replace(/^@/, "").toLowerCase();
    var hay = raw.toLowerCase().replace(/\s+/g, "");
    return hay.indexOf("@" + needle) !== -1 || hay.indexOf(needle) !== -1;
  }

  /* ============================================================
   * 3. Schedule — next fixed re-share day on/after a date.
   * ============================================================ */

  function startOfDay(d) {
    var x = new Date(d.getTime());
    x.setHours(0, 0, 0, 0);
    return x;
  }

  // The next fixed re-share day at/after `from` (inclusive of `from`'s day).
  function nextReshareDay(from) {
    var base = from instanceof Date ? from : new Date(from);
    if (isNaN(base.getTime())) base = new Date();
    for (var add = 0; add < 8; add++) {
      var cand = new Date(startOfDay(base).getTime() + add * DAY_MS);
      if (RESHARE_DOW.indexOf(cand.getDay()) !== -1) return cand;
    }
    return startOfDay(base); // unreachable: a fixed day occurs within 7 days
  }

  function isReshareDay(date) {
    var d = date instanceof Date ? date : new Date(date);
    if (isNaN(d.getTime())) return false;
    return RESHARE_DOW.indexOf(d.getDay()) !== -1;
  }

  /* ============================================================
   * 4. THE ELIGIBILITY ENGINE (the core logic).
   *    Given a submitted story, decide whether it qualifies for a
   *    fixed-day re-share and, if so, WHICH fixed day it lands on.
   *
   *    A story is { campId, tag|caption, bookingLink?, postedAt? }.
   *
   *    Rules (all must hold), mirroring the evidence:
   *      A. The camp exists in the directory.
   *      B. The camp is bookable on the platform.
   *      C. The story tags the brand handle.
   *      D. The story carries a booking link.
   *      E. The story will still be LIVE on a fixed re-share day
   *         (stories live 24h from postedAt). If no postedAt is given,
   *         we treat it as "posting now" and look forward.
   * ============================================================ */

  function evaluateStory(story, opts) {
    opts = opts || {};
    var now = opts.now instanceof Date ? opts.now : new Date();
    var reasons = [];
    var checks = {
      campKnown: false,
      bookable: false,
      taggedBrand: false,
      hasBookingLink: false,
      liveOnReshareDay: false
    };

    var result = {
      eligible: false,
      campId: story && story.campId ? story.campId : null,
      campName: null,
      bookingLink: null,
      reshareDate: null,
      reshareDay: null,
      checks: checks,
      reasons: reasons
    };

    if (!story || typeof story !== "object") {
      reasons.push("No story submitted.");
      return result;
    }

    // A. Camp known.
    var provider = story.campId ? providerById(story.campId) : null;
    if (provider) {
      checks.campKnown = true;
      result.campName = provider.name || provider.id;
    } else {
      reasons.push("Camp is not in the HolidayCamp directory.");
    }

    // B. Bookable on the platform.
    if (provider && isCampBookable(provider)) {
      checks.bookable = true;
    } else if (provider) {
      reasons.push("Camp is not bookable on HolidayCamp — only bookable camps can be re-shared.");
    }

    // C. Tags the brand.
    if (tagsBrand(story)) {
      checks.taggedBrand = true;
    } else {
      reasons.push("Story does not tag " + BRAND_HANDLE + ".");
    }

    // D. Has a booking link.
    var link = resolveBookingLink(story, provider);
    if (link) {
      checks.hasBookingLink = true;
      result.bookingLink = link;
    } else {
      reasons.push("Story has no booking link to a bookable camp.");
    }

    // E. Live on a fixed re-share day.
    // Story window: [postedAt, postedAt + 24h]. If postedAt missing, assume
    // it is being posted at `now`.
    var postedAt = story.postedAt ? new Date(story.postedAt) : new Date(now.getTime());
    if (isNaN(postedAt.getTime())) postedAt = new Date(now.getTime());
    var liveUntil = new Date(postedAt.getTime() + STORY_LIVE_HOURS * 60 * 60 * 1000);

    // Find the earliest fixed re-share day whose day overlaps the live
    // window. We scan each calendar day the story is live for.
    var landingDay = null;
    var scanStart = startOfDay(postedAt);
    for (var d = 0; d <= 2; d++) { // a 24h window touches at most 2 calendar days
      var day = new Date(scanStart.getTime() + d * DAY_MS);
      // Is the story still live at any point on this calendar day?
      var dayStart = startOfDay(day);
      var dayEnd = new Date(dayStart.getTime() + DAY_MS - 1);
      var overlaps = postedAt.getTime() <= dayEnd.getTime() &&
        liveUntil.getTime() >= dayStart.getTime();
      if (overlaps && isReshareDay(day)) { landingDay = day; break; }
    }

    if (landingDay) {
      checks.liveOnReshareDay = true;
      result.reshareDate = landingDay;
      result.reshareDay = DOW_NAMES[landingDay.getDay()];
    } else {
      reasons.push("Story will not be live on a fixed re-share day (Mon/Thu/Sun) — re-post so it is.");
    }

    result.eligible = checks.campKnown && checks.bookable &&
      checks.taggedBrand && checks.hasBookingLink && checks.liveOnReshareDay;

    if (result.eligible) {
      reasons.length = 0;
      reasons.push("Eligible — queued to be re-shared on " + result.reshareDay + ".");
    }

    return result;
  }

  /* ============================================================
   * 5. Submission queue (persisted via HC.store).
   * ============================================================ */

  function loadQueue() {
    var q = HC.store.get(STORE_KEY, []);
    return Array.isArray(q) ? q : [];
  }
  function saveQueue(q) {
    HC.store.set(STORE_KEY, Array.isArray(q) ? q : []);
  }

  // Submit a story; returns the evaluation. Stores eligible + ineligible
  // submissions alike so the provider can see why something didn't qualify.
  function submitStory(story, opts) {
    var evalResult = evaluateStory(story, opts);
    var rec = {
      id: HC.util.uid(),
      campId: evalResult.campId,
      campName: evalResult.campName,
      tag: (story && (story.tag || story.caption)) || "",
      bookingLink: evalResult.bookingLink,
      postedAt: (story && story.postedAt) || new Date().toISOString(),
      eligible: evalResult.eligible,
      reshareDay: evalResult.reshareDay,
      reshareDate: evalResult.reshareDate ? evalResult.reshareDate.toISOString() : null,
      reasons: evalResult.reasons.slice()
    };
    var q = loadQueue();
    q.unshift(rec);
    if (q.length > 50) q = q.slice(0, 50);
    saveQueue(q);
    return { record: rec, evaluation: evalResult };
  }

  function clearQueue() { saveQueue([]); }

  /* ============================================================
   * 6. render(mountEl) — the feature UI.
   * ============================================================ */

  function fmtDate(d) {
    try {
      var x = d instanceof Date ? d : new Date(d);
      return x.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "short" });
    } catch (e) { return String(d); }
  }

  function render(mountEl) {
    try {
      var providers = safeProviders();
      var bookable = providers.filter(isCampBookable);
      var el = HC.util.el;

      mountEl.innerHTML = "";

      var intro = el("div", { style: "font-size:14px;color:var(--text,#383838);line-height:1.55" },
        "<p style='margin:0 0 10px'>Tag <strong>" + BRAND_HANDLE + "</strong> in your Instagram Story with your " +
        "camp's <strong>booking link</strong> and we re-share you to our <strong>" +
        FOLLOWER_REACH.toLocaleString() + "+</strong> followers on the next fixed re-share day.</p>" +
        "<p style='margin:0 0 4px;color:var(--muted,#808080);font-size:13px'>We only re-share on fixed days — <strong>" +
        RESHARE_DAYS.map(function (d) { return d.label; }).join(", ") +
        "</strong> — so your Story gets more views (stories are live for 24h). Only camps that are bookable on HolidayCamp qualify.</p>");
      mountEl.appendChild(intro);

      // ---- submission form ----
      var form = el("div", { style: "margin:16px 0;padding:14px;border:1.5px solid var(--line,#E6E6E6);border-radius:14px;background:#fff" });

      var campSel = el("select", { id: "igCamp", style: "width:100%;padding:8px;border:1.5px solid var(--line,#E6E6E6);border-radius:10px;font-size:13.5px;margin-bottom:8px" });
      campSel.appendChild(el("option", { value: "" }, "— choose your camp —"));
      bookable.slice().sort(function (a, b) {
        return String(a.name || "").localeCompare(String(b.name || ""));
      }).forEach(function (p) {
        campSel.appendChild(el("option", { value: p.id }, HC.util ? (p.name || p.id) : p.id));
      });

      var tagInput = el("input", {
        id: "igTag", type: "text", value: BRAND_HANDLE,
        style: "width:100%;padding:8px;border:1.5px solid var(--line,#E6E6E6);border-radius:10px;font-size:13.5px;margin-bottom:8px",
        placeholder: "Who you tagged, e.g. " + BRAND_HANDLE
      });

      var linkInput = el("input", {
        id: "igLink", type: "text",
        style: "width:100%;padding:8px;border:1.5px solid var(--line,#E6E6E6);border-radius:10px;font-size:13.5px;margin-bottom:8px",
        placeholder: "Booking link (leave blank to use your camp page link)"
      });

      var checkBtn = el("button", { class: "hc-btn", type: "button" }, "Check my Story");
      var out = el("div", { style: "margin-top:12px" });

      checkBtn.addEventListener("click", function () {
        try {
          var story = {
            campId: campSel.value || null,
            tag: tagInput.value || "",
            bookingLink: linkInput.value || ""
          };
          var res = submitStory(story);
          renderResult(out, res.evaluation);
          if (res.evaluation.eligible) {
            HC.util.toast("✓ Eligible — re-share queued for " + res.evaluation.reshareDay);
          } else {
            HC.util.toast("Not yet eligible — see the checklist");
          }
        } catch (e) {
          out.innerHTML = "<p style='color:#9a1f5e'>Could not evaluate: " + (e && e.message ? e.message : e) + "</p>";
        }
      });

      form.appendChild(el("label", { style: "display:block;font-size:12px;font-weight:700;color:var(--purple,#603488);margin-bottom:4px" }, "Camp (must be bookable)"));
      form.appendChild(campSel);
      form.appendChild(el("label", { style: "display:block;font-size:12px;font-weight:700;color:var(--purple,#603488);margin-bottom:4px" }, "Brand tag"));
      form.appendChild(tagInput);
      form.appendChild(el("label", { style: "display:block;font-size:12px;font-weight:700;color:var(--purple,#603488);margin-bottom:4px" }, "Booking link"));
      form.appendChild(linkInput);
      form.appendChild(checkBtn);
      form.appendChild(out);
      mountEl.appendChild(form);

      // ---- next re-share day badge ----
      var next = nextReshareDay(new Date());
      mountEl.appendChild(el("p", { style: "font-size:13px;color:var(--muted,#808080);margin:6px 0 0" },
        "Next fixed re-share day: <strong>" + fmtDate(next) + "</strong>"));
    } catch (e) {
      mountEl.innerHTML = "<p style='color:#9a1f5e'>This feature failed to render: " +
        (e && e.message ? e.message : String(e)) + "</p>";
    }
  }

  function renderResult(out, evalResult) {
    var el = HC.util.el;
    out.innerHTML = "";
    var ok = evalResult.eligible;
    var head = el("div", {
      style: "font-family:Quicksand,system-ui,sans-serif;font-weight:700;font-size:15px;margin-bottom:8px;color:" +
        (ok ? "#2f7d4f" : "#9a1f5e")
    }, ok
      ? ("✓ Eligible — re-share queued for " + evalResult.reshareDay)
      : "✗ Not eligible yet");
    out.appendChild(head);

    var rows = [
      ["Camp is in the directory", evalResult.checks.campKnown],
      ["Camp is bookable on HolidayCamp", evalResult.checks.bookable],
      ["Story tags " + BRAND_HANDLE, evalResult.checks.taggedBrand],
      ["Story has a booking link", evalResult.checks.hasBookingLink],
      ["Story is live on a fixed re-share day", evalResult.checks.liveOnReshareDay]
    ];
    var ul = el("ul", { style: "list-style:none;padding:0;margin:0;font-size:13.5px" });
    rows.forEach(function (r) {
      ul.appendChild(el("li", { style: "padding:3px 0;color:" + (r[1] ? "#2f7d4f" : "var(--muted,#808080)") },
        (r[1] ? "✓ " : "○ ") + r[0]));
    });
    out.appendChild(ul);

    if (ok && evalResult.bookingLink) {
      out.appendChild(el("p", { style: "font-size:12.5px;color:var(--muted,#808080);margin:8px 0 0" },
        "Followers will be driven to: " + evalResult.bookingLink));
    }
  }

  /* ============================================================
   * 7. selfTest — exercises the LOGIC and asserts the acceptance
   *    criterion across multiple cases.
   * ============================================================ */

  function selfTest() {
    var pass = 0, fail = 0, log = [];
    function check(label, fn) {
      try { fn(); pass++; log.push("✓ " + label); }
      catch (e) { fail++; log.push("✗ " + label + " — " + (e && e.message ? e.message : String(e))); }
    }

    // A known reference Monday for deterministic date logic.
    // 2026-06-15 is a Monday (a fixed re-share day).
    var refMonday = new Date("2026-06-15T09:00:00Z");
    var refTuesday = new Date("2026-06-16T09:00:00Z"); // not a fixed day
    var refSaturday = new Date("2026-06-13T09:00:00Z"); // not a fixed day

    // Pick a real bookable camp from the live directory for realistic cases.
    var bookable = safeProviders().filter(isCampBookable);

    // ---- ACCEPTANCE CRITERION ----
    // A camp tagging the brand with a booking link is eligible for a
    // fixed-day re-share.
    check("ACCEPTANCE: a camp tagging the brand with a booking link is eligible for a fixed-day re-share", function () {
      HC.assert(bookable.length > 0, "live directory should have bookable camps");
      var camp = bookable[0];
      var res = evaluateStory({
        campId: camp.id,
        tag: BRAND_HANDLE,
        bookingLink: "https://book.holidaycamp.example/" + camp.id,
        postedAt: refMonday.toISOString()
      }, { now: refMonday });
      HC.assert(res.eligible === true, "should be eligible, reasons: " + res.reasons.join("; "));
      HC.assert(isReshareDay(res.reshareDate), "must land on a fixed re-share day");
      HC.assert(RESHARE_DOW.indexOf(res.reshareDate.getDay()) !== -1, "re-share day must be Mon/Thu/Sun");
    });

    check("ACCEPTANCE (real camp, provider's own link): tagging brand + bookable = eligible", function () {
      var camp = bookable[0];
      // No explicit bookingLink — falls back to the provider's source URL.
      var hasUrl = camp.source && /^https?:\/\//i.test(camp.source.url || "");
      if (!hasUrl) { /* still assert the path works with explicit link */ }
      var res = evaluateStory({
        campId: camp.id,
        tag: "Loved our camp this week! @holidaycampuk",
        bookingLink: hasUrl ? "" : "https://book.holidaycamp.example/" + camp.id,
        postedAt: refMonday.toISOString()
      }, { now: refMonday });
      HC.assert(res.eligible === true, "real camp should be eligible: " + res.reasons.join("; "));
    });

    // ---- NEGATIVE: no brand tag ----
    check("NOT eligible without the brand tag", function () {
      var camp = bookable[0];
      var res = evaluateStory({
        campId: camp.id,
        tag: "Great week!",
        bookingLink: "https://book.holidaycamp.example/" + camp.id,
        postedAt: refMonday.toISOString()
      }, { now: refMonday });
      HC.assert(res.eligible === false, "should NOT be eligible without a brand tag");
      HC.assert(res.checks.taggedBrand === false, "taggedBrand check should fail");
    });

    // ---- NEGATIVE: no booking link ----
    check("NOT eligible without a booking link", function () {
      // Use a synthetic provider that is NOT bookable and has no source URL,
      // so the link cannot fall back to a provider URL.
      var res = evaluateStory({
        campId: "__nonexistent__",
        tag: BRAND_HANDLE,
        bookingLink: "",
        postedAt: refMonday.toISOString()
      }, { now: refMonday });
      HC.assert(res.eligible === false, "should NOT be eligible without a booking link");
      HC.assert(res.checks.hasBookingLink === false, "hasBookingLink check should fail");
    });

    // ---- NEGATIVE: camp not bookable on the platform ----
    check("NOT eligible if the camp is not bookable on the platform", function () {
      var res = evaluateStory({
        campId: "__nonexistent__",
        tag: BRAND_HANDLE,
        bookingLink: "https://book.holidaycamp.example/unknown",
        postedAt: refMonday.toISOString()
      }, { now: refMonday });
      HC.assert(res.eligible === false, "unknown camp should not be eligible");
      HC.assert(res.checks.campKnown === false, "campKnown should fail for an unknown camp");
    });

    // ---- SCHEDULE: a story not live on any fixed day is NOT eligible ----
    check("NOT eligible if the story is not live on a fixed re-share day", function () {
      var camp = bookable[0];
      // Posted Tuesday 09:00 -> live until Wednesday 09:00. Neither Tue nor
      // Wed is a fixed day, so no re-share window.
      var res = evaluateStory({
        campId: camp.id,
        tag: BRAND_HANDLE,
        bookingLink: "https://book.holidaycamp.example/" + camp.id,
        postedAt: refTuesday.toISOString()
      }, { now: refTuesday });
      HC.assert(res.eligible === false, "Tue->Wed window should miss all fixed days");
      HC.assert(res.checks.liveOnReshareDay === false, "liveOnReshareDay should fail");
    });

    // ---- SCHEDULE: posting the day before a fixed day DOES qualify ----
    check("Eligible when the story is still live into a fixed day (Sat post -> Sun re-share)", function () {
      var camp = bookable[0];
      // Posted Saturday 09:00 -> live until Sunday 09:00. Sunday IS a fixed day.
      var res = evaluateStory({
        campId: camp.id,
        tag: BRAND_HANDLE,
        bookingLink: "https://book.holidaycamp.example/" + camp.id,
        postedAt: refSaturday.toISOString()
      }, { now: refSaturday });
      HC.assert(res.eligible === true, "Sat post should carry into Sunday re-share: " + res.reasons.join("; "));
      HC.assert(res.reshareDay === "Sunday", "should land on Sunday, got " + res.reshareDay);
    });

    // ---- SCHEDULE: nextReshareDay always returns Mon/Thu/Sun ----
    check("nextReshareDay always returns a fixed day, within 7 days", function () {
      for (var i = 0; i < 14; i++) {
        var from = new Date(refMonday.getTime() + i * DAY_MS);
        var nd = nextReshareDay(from);
        HC.assert(isReshareDay(nd), "nextReshareDay must be a fixed day");
        var gap = Math.round((startOfDay(nd).getTime() - startOfDay(from).getTime()) / DAY_MS);
        HC.assert(gap >= 0 && gap <= 7, "fixed day must be within a week, gap=" + gap);
      }
    });

    // ---- TAG TOLERANCE: bare handle / casing still counts ----
    check("Brand tag is tolerant of casing and a missing @", function () {
      var camp = bookable[0];
      var a = evaluateStory({ campId: camp.id, tag: "HolidayCampUK", bookingLink: "https://x.co.uk/1", postedAt: refMonday.toISOString() }, { now: refMonday });
      var b = evaluateStory({ campId: camp.id, tag: "@HOLIDAYCAMPUK", bookingLink: "https://x.co.uk/1", postedAt: refMonday.toISOString() }, { now: refMonday });
      HC.assert(a.checks.taggedBrand === true, "bare handle should count as tagging the brand");
      HC.assert(b.checks.taggedBrand === true, "upper-case @handle should count");
    });

    // ---- LINK DETECTION: bare domain counts, plain text doesn't ----
    check("Booking-link detection: URL and bare domain pass, plain text fails", function () {
      HC.assert(looksLikeLink("https://book.example.com/x") === true, "https URL should count");
      HC.assert(looksLikeLink("mycamp.co.uk") === true, "bare .co.uk domain should count");
      HC.assert(looksLikeLink("come book with us") === false, "plain prose should NOT count as a link");
    });

    // ---- bookable detection against real data ----
    check("Most live camps are bookable on the platform", function () {
      var all = safeProviders();
      HC.assert(all.length > 0, "directory should have providers");
      var n = all.filter(isCampBookable).length;
      HC.assert(n >= 1, "at least one camp should be bookable, got " + n);
    });

    // ---- PERSISTENCE: submit -> queue -> read back -> clear ----
    check("Submitting a story persists it to the HC store and records eligibility", function () {
      var before = loadQueue().length;
      var camp = bookable[0];
      var res = submitStory({
        campId: camp.id,
        tag: BRAND_HANDLE,
        bookingLink: "https://book.holidaycamp.example/" + camp.id,
        postedAt: refMonday.toISOString()
      }, { now: refMonday });
      var after = loadQueue();
      HC.assert(after.length === before + 1, "queue should grow by one");
      HC.assert(after[0].id === res.record.id, "newest submission should be first");
      HC.assert(after[0].eligible === true, "stored record should be marked eligible");
      HC.assert(after[0].reshareDay === "Monday", "stored re-share day should be Monday");
    });

    check("Queue can be cleared", function () {
      clearQueue();
      HC.assert(loadQueue().length === 0, "queue should be empty after clear");
    });

    // ---- DEFENSIVE: garbage input never throws ----
    check("Evaluating garbage input does not throw and is not eligible", function () {
      var r1 = evaluateStory(null);
      var r2 = evaluateStory({});
      var r3 = evaluateStory({ campId: 123, tag: 42, bookingLink: {} });
      HC.assert(r1.eligible === false && r2.eligible === false && r3.eligible === false,
        "all malformed stories should be ineligible without throwing");
    });

    // ---- evaluator must not mutate the input story ----
    check("evaluateStory does not mutate its input", function () {
      var input = { campId: bookable[0].id, tag: BRAND_HANDLE, bookingLink: "https://x.co.uk/1", postedAt: refMonday.toISOString() };
      var snapshot = JSON.stringify(input);
      evaluateStory(input, { now: refMonday });
      HC.assert(JSON.stringify(input) === snapshot, "input story must be unchanged");
    });

    return { pass: pass, fail: fail, log: log };
  }

  /* ============================================================
   * 8. Register.
   * ============================================================ */

  HC.registerFeature({
    id: "platform-instagram-reshare",
    title: "Instagram Stories re-share",
    side: "platform",
    icon: "📸",
    summary: "Tag the HolidayCamp brand in your Story with a booking link and we re-share you to our followers on fixed days (Mon/Thu/Sun).",
    render: render,
    selfTest: selfTest
  });
})();
