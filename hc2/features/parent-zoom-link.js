/* HolidayCamp feature — parent-zoom-link
 *
 * Online-class Zoom link emailed ~1hr before start  (parent side)
 *
 * Replicates Happity's "Confirmation emails for Online Zoom Classes" behaviour
 * (support articles 4885596, 3808253, 8255720). Evidence highlights:
 *   - "When a parent books an online class they will receive a confirmation
 *     email straightaway" with their booking info.
 *   - "This initial confirmation email WILL NOT contain the Zoom link; for
 *     security these are only sent out an hour before the class starts."
 *   - "If you need to change the link, then ensure to do this at least 90
 *     minutes before the class is due to begin."
 *   - The booking system "will email your link to participants around an [hour]
 *     before the start of each class, asking them to click to join".
 *
 * Framed for SCHOOL-AGE HOLIDAY CAMPS: some E17 holiday-camp providers run
 * online sessions (virtual coding clubs, online drama / chess camps, half-term
 * Zoom workshops). When a parent books an ONLINE camp, the instant confirmation
 * tells them the join link will arrive shortly before the session starts — it
 * is deliberately NOT in the booking confirmation, for child-safety reasons.
 * An IN-PERSON camp confirmation instead carries the venue address.
 *
 * ACCEPTANCE CRITERION (asserted in selfTest):
 *   An online booking's confirmation states the Zoom link arrives shortly
 *   before start, NOT at booking time.
 *
 * Self-contained, defensive, no imports/exports. Calls HC.registerFeature.
 */
(function () {
  "use strict";

  // Defensive: never throw at module load if HC isn't present.
  if (typeof window === "undefined" || !window.HC || typeof window.HC.registerFeature !== "function") {
    if (typeof console !== "undefined" && console.warn) {
      console.warn("[HC] parent-zoom-link: HC core not found; skipping registration.");
    }
    return;
  }

  var HC = window.HC;

  var STORE_KEY = "parent_zoom_link_overrides";

  // Timing rules straight from the Happity evidence (minutes before start).
  var LINK_LEAD_MIN = 60;          // link emailed ~1hr (60 min) before start
  var LINK_CHANGE_CUTOFF_MIN = 90; // link changes must land >=90 min before
  var ONE_MIN_MS = 60 * 1000;

  /* ---------------- pure logic (testable, DOM-free) ---------------- */

  function asText(v) {
    return typeof v === "string" ? v : (v == null ? "" : String(v));
  }

  // Phrases / category hints that mark a holiday camp as an ONLINE (Zoom)
  // session rather than an in-person one.
  var ONLINE_PHRASES = [
    "online", "zoom", "virtual", "remote", "live stream", "livestream",
    "video call", "join link", "from home", "at home", "web-based", "webinar"
  ];

  function textSaysOnline(text) {
    var hay = asText(text).toLowerCase();
    if (!hay) return false;
    for (var i = 0; i < ONLINE_PHRASES.length; i++) {
      if (hay.indexOf(ONLINE_PHRASES[i]) !== -1) return true;
    }
    return false;
  }

  // Decide whether a camp record is an online (Zoom) camp. An explicit boolean
  // override (the provider's "this is an online session" tick box) always wins;
  // otherwise we sniff the camp's free text + categories.
  function isOnlineCamp(camp, override) {
    if (override === true || override === false) return override;
    var c = camp || {};
    if (typeof c.online === "boolean") return c.online;
    if (typeof c.isOnline === "boolean") return c.isOnline;

    // category array (e.g. ["Online", "Coding"]) — Happity treats online as a
    // class type.
    var cats = Array.isArray(c.categories) ? c.categories : [];
    for (var i = 0; i < cats.length; i++) {
      if (textSaysOnline(cats[i])) return true;
    }
    // free-text fields a provider fills in
    return textSaysOnline(c.kind) || textSaysOnline(c.venue) ||
      textSaysOnline(c.booking) || textSaysOnline(c.summary) ||
      textSaysOnline(c.name);
  }

  // Format a clock time (HH:MM) from an ms timestamp, defensively.
  function clock(ms) {
    try {
      var d = new Date(ms);
      if (isNaN(d.getTime())) return "";
      var hh = ("0" + d.getHours()).slice(-2);
      var mm = ("0" + d.getMinutes()).slice(-2);
      return hh + ":" + mm;
    } catch (e) { return ""; }
  }

  // THE CORE decision. Given a booking (camp + the session start time + the
  // moment the email is generated) produce the confirmation email content.
  //
  // booking fields used:
  //   camp        : the camp record (or {})
  //   startMs     : session start time, ms epoch (optional)
  //   nowMs       : when the confirmation is generated, ms epoch (default Date.now)
  //   online      : optional Boolean override for "is this an online camp?"
  //
  // Returns an object describing what the parent's confirmation email says:
  //   isOnline           : Boolean
  //   linkIncludedNow    : Boolean — is the Zoom link IN this confirmation?
  //   linkDeliveryMin    : Number  — minutes before start the link is emailed
  //   linkChangeCutoffMin: Number  — provider link-change deadline (min before)
  //   linkEtaMs          : Number|null — when the link email is due (if start known)
  //   confirmationBody   : String  — the human-readable confirmation text
  //   linkLine           : String  — the exact sentence about the link timing
  //   joinDetail         : String  — venue address (in-person) or link-timing (online)
  function buildConfirmation(booking) {
    var b = booking || {};
    var camp = b.camp || {};
    var online = isOnlineCamp(camp, b.online);

    var nowMs = typeof b.nowMs === "number" ? b.nowMs : Date.now();
    var startMs = typeof b.startMs === "number" ? b.startMs : null;

    var name = camp && camp.name ? camp.name : "your holiday camp";

    if (!online) {
      // In-person camp: confirmation carries the venue address straightaway.
      var addr = (camp && (camp.address || camp.venue)) || "the venue (see your booking)";
      var inLine = "Your camp is in person at " + addr + ".";
      return {
        isOnline: false,
        linkIncludedNow: false,        // there is no Zoom link at all
        linkDeliveryMin: 0,
        linkChangeCutoffMin: 0,
        linkEtaMs: null,
        confirmationBody:
          "Thanks for booking " + name + "! This is an in-person camp. " + inLine +
          " Bring your child along on the day — see your booking for full details.",
        linkLine: "",
        joinDetail: inLine
      };
    }

    // ONLINE camp. Per Happity: the link is NOT in this confirmation; it is
    // emailed ~1hr before the session for child-safety / security reasons.
    var etaMs = (startMs != null) ? (startMs - LINK_LEAD_MIN * ONE_MIN_MS) : null;
    var whenPhrase = "around " + LINK_LEAD_MIN + " minutes before the session starts";
    if (startMs != null) {
      var startClock = clock(startMs);
      var etaClock = clock(etaMs);
      if (startClock && etaClock) {
        whenPhrase = "at about " + etaClock + " (around " + LINK_LEAD_MIN +
          " minutes before the " + startClock + " start)";
      }
    }

    // The single sentence the acceptance criterion is checked against. It must
    // make clear the link arrives shortly BEFORE START, and is NOT in this
    // confirmation (i.e. not at booking time).
    var linkLine =
      "Your Zoom join link is NOT in this confirmation. For your child's safety " +
      "we email the link " + whenPhrase + " — please look out for it shortly before start.";

    return {
      isOnline: true,
      linkIncludedNow: false,                 // explicitly withheld now
      linkDeliveryMin: LINK_LEAD_MIN,         // ~60 min before start
      linkChangeCutoffMin: LINK_CHANGE_CUTOFF_MIN, // provider edits >=90 min before
      linkEtaMs: etaMs,
      confirmationBody:
        "Thanks for booking " + name + "! This is an online (Zoom) camp. " +
        linkLine +
        " You'll also get a reminder, and any last-minute joiners are flagged just before the start.",
      linkLine: linkLine,
      joinDetail: linkLine
    };
  }

  // Provider-side check: can a Zoom link still be changed at `nowMs` for a
  // session starting at `startMs`? Mirrors "change it at least 90 minutes
  // before the class is due to begin".
  function canChangeLink(startMs, nowMs) {
    if (typeof startMs !== "number" || isNaN(startMs)) return false;
    var now = typeof nowMs === "number" ? nowMs : Date.now();
    var minutesBefore = (startMs - now) / ONE_MIN_MS;
    return minutesBefore >= LINK_CHANGE_CUTOFF_MIN;
  }

  // Has the link been emailed yet, given start + current time? (link goes out
  // ~60 min before; before that it has not been sent).
  function linkSentYet(startMs, nowMs) {
    if (typeof startMs !== "number" || isNaN(startMs)) return false;
    var now = typeof nowMs === "number" ? nowMs : Date.now();
    var minutesBefore = (startMs - now) / ONE_MIN_MS;
    // Sent once we are within the lead window (and not after the class is long over).
    return minutesBefore <= LINK_LEAD_MIN;
  }

  /* ---------------- persistence (HC.store, namespaced) ---------------- */

  function readOverrides() {
    try {
      var o = HC.store.get(STORE_KEY, {});
      return (o && typeof o === "object") ? o : {};
    } catch (e) { return {}; }
  }
  function writeOverrides(obj) {
    try { return HC.store.set(STORE_KEY, obj || {}); } catch (e) { return false; }
  }

  /* ---------------- live data seeds ---------------- */

  function seedCamps() {
    var providers = [];
    try { providers = HC.data.providers || []; } catch (e) { providers = []; }

    var onlineCamp = null, inPersonCamp = null;
    for (var i = 0; i < providers.length; i++) {
      var p = providers[i];
      if (!p) continue;
      if (isOnlineCamp(p) && !onlineCamp) onlineCamp = p;
      if (!isOnlineCamp(p) && !inPersonCamp) inPersonCamp = p;
      if (onlineCamp && inPersonCamp) break;
    }

    // Synthetic fallbacks so the demo + tests never depend on a live record.
    if (!onlineCamp) {
      onlineCamp = {
        id: "demo-online-camp",
        name: "E17 Online Coding Camp (Zoom)",
        kind: "Online coding club",
        categories: ["Online", "Coding"],
        venue: "Live online via Zoom",
        booking: "Join the daily online session via the Zoom link we email you before each class.",
        price: "GBP 12 per session"
      };
    }
    if (!inPersonCamp) {
      inPersonCamp = {
        id: "demo-inperson-camp",
        name: "Walthamstow Multi-Sports Week",
        kind: "Sports camp",
        categories: ["Multi-activity"],
        venue: "Walthamstow Leisure Centre",
        address: "Walthamstow Leisure Centre, E17",
        booking: "Book your week through the camp page and turn up at the venue.",
        price: "GBP 140 full week"
      };
    }
    return { onlineCamp: onlineCamp, inPersonCamp: inPersonCamp };
  }

  /* ---------------- UI ---------------- */

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

  // Render a mock confirmation-email card for one booking.
  function emailCard(camp, startMs, nowMs) {
    var info = buildConfirmation({ camp: camp, startMs: startMs, nowMs: nowMs });

    var card = el("div", {
      style: "border:1.5px solid var(--line,#E6E6E6);border-radius:14px;padding:0;background:#fff;margin:0 0 16px;overflow:hidden"
    });

    // email header bar
    var head = el("div", {
      style: "background:var(--purple-tint,#F0E8F4);padding:12px 16px;display:flex;align-items:center;gap:10px"
    });
    head.appendChild(el("span", { style: "font-size:20px" }, info.isOnline ? "💻" : "📍"));
    head.appendChild(el("div", null,
      '<div style="font-family:\'Quicksand\',system-ui,sans-serif;font-weight:700;font-size:14px;color:var(--purple,#603488)">' +
        "Booking confirmed — " + esc(camp && camp.name ? camp.name : "Holiday camp") + "</div>" +
      '<div style="font-size:11.5px;color:var(--muted,#808080)">' +
        (info.isOnline ? "Online (Zoom) camp" : "In-person camp") + "</div>"));
    card.appendChild(head);

    var body = el("div", { style: "padding:14px 16px" });
    body.appendChild(el("p", {
      style: "font-size:13.5px;color:var(--text,#383838);margin:0 0 10px;line-height:1.55"
    }, esc(info.confirmationBody)));

    // The join-detail callout — link-timing (online) or venue (in person).
    if (info.isOnline) {
      var eta = info.linkEtaMs != null ? clock(info.linkEtaMs) : "";
      var callout = el("div", {
        "data-hc-link-callout": "1",
        style: "display:flex;gap:9px;align-items:flex-start;background:#FFF8E1;border:1px dashed var(--yellow,#FCD400);" +
          "border-radius:12px;padding:11px 13px;font-size:13px;color:var(--ink,#1A1A1A)"
      });
      callout.appendChild(el("span", { style: "font-size:16px" }, "⏰"));
      callout.appendChild(el("div", null,
        '<strong>Your Zoom link isn\'t here yet.</strong> ' +
        "We send it around " + LINK_LEAD_MIN + " minutes before the session" +
        (eta ? " (about " + esc(eta) + ")" : "") +
        " for your child's safety — keep an eye on your inbox shortly before start."));
      body.appendChild(callout);
    } else {
      body.appendChild(el("div", {
        "data-hc-venue-callout": "1",
        style: "display:flex;gap:9px;align-items:center;background:var(--purple-tint,#F0E8F4);border-radius:12px;" +
          "padding:11px 13px;font-size:13px;color:var(--purple,#603488);font-weight:700"
      }, "📍 " + esc(info.joinDetail)));
    }
    card.appendChild(body);
    return card;
  }

  function render(mountEl) {
    if (!mountEl) return;
    mountEl.innerHTML = "";

    var seeds = seedCamps();
    // A session starting 4 hours from "now" so the link is not yet due.
    var nowMs = Date.now();
    var startMs = nowMs + 4 * 60 * ONE_MIN_MS;

    var wrap = el("div", { style: "font-family:'Nunito Sans',system-ui,sans-serif;color:var(--text,#383838)" });
    wrap.appendChild(el("p", { style: "font-size:14px;margin:0 0 16px;line-height:1.55" },
      "Book an <strong>online</strong> holiday camp and your confirmation lands straightaway — but the " +
      "<strong>Zoom join link is held back</strong> and emailed only <strong>~" + LINK_LEAD_MIN +
      " minutes before</strong> the session starts, for child-safety reasons. Compare the two " +
      "confirmations below."));

    wrap.appendChild(el("div", { class: "hc-sidehead", style: "margin-top:6px" }, "Online camp confirmation"));
    wrap.appendChild(emailCard(seeds.onlineCamp, startMs, nowMs));

    wrap.appendChild(el("div", { class: "hc-sidehead" }, "In-person camp confirmation"));
    wrap.appendChild(emailCard(seeds.inPersonCamp, startMs, nowMs));

    // A tiny timeline showing when the link is sent vs the change cutoff.
    var tl = el("div", {
      style: "margin-top:6px;background:#fff;border:1.5px solid var(--line,#E6E6E6);border-radius:14px;padding:14px 16px"
    });
    tl.innerHTML =
      '<div style="font-family:\'Quicksand\',system-ui,sans-serif;font-weight:700;color:var(--purple,#603488);margin:0 0 8px">' +
        "Online-class link timeline</div>" +
      '<ul style="margin:0;padding-left:18px;font-size:13px;line-height:1.7;color:var(--text,#383838)">' +
        "<li><strong>At booking:</strong> confirmation email sent — <em>no Zoom link</em>.</li>" +
        "<li><strong>" + LINK_CHANGE_CUTOFF_MIN + " min before:</strong> last moment a provider can change the link.</li>" +
        "<li><strong>~" + LINK_LEAD_MIN + " min before:</strong> Zoom link emailed to parents — click to join.</li>" +
        "<li><strong>Just before start:</strong> reminder + late-joiner list to the host.</li>" +
      "</ul>";
    wrap.appendChild(tl);

    mountEl.appendChild(wrap);
  }

  /* ---------------- selfTest ---------------- */

  function selfTest() {
    var pass = 0, fail = 0, log = [];
    function check(label, fn) {
      try { fn(); pass += 1; log.push("✓ " + label); }
      catch (e) { fail += 1; log.push("✗ " + label + " — " + (e && e.message ? e.message : String(e))); }
    }

    var HOUR = 60 * ONE_MIN_MS;

    // ===== ACCEPTANCE CRITERION =====
    // An online booking's confirmation states the Zoom link arrives shortly
    // before start, NOT at booking time.
    check("ACCEPTANCE: online confirmation says link arrives before start, not at booking", function () {
      var now = Date.now();
      var info = buildConfirmation({
        camp: { name: "E17 Online Drama Camp", categories: ["Online"] },
        startMs: now + 3 * HOUR,
        nowMs: now
      });
      HC.assert(info.isOnline === true, "camp should be detected as online");
      // Link is NOT in the confirmation (i.e. not delivered at booking time).
      HC.assert(info.linkIncludedNow === false, "Zoom link must NOT be in the booking confirmation");
      // The confirmation text must state the link comes shortly before start.
      var body = (info.confirmationBody + " " + info.linkLine).toLowerCase();
      HC.assert(/before (the )?(session|class|start)/.test(body) || body.indexOf("before start") !== -1,
        "confirmation must say the link arrives before the session starts");
      HC.assert(body.indexOf("not in this confirmation") !== -1,
        "confirmation must state the link is NOT in the confirmation (not at booking time)");
      // And the delivery lead time is the documented ~1hr (60 min) before start.
      HC.assert(info.linkDeliveryMin === LINK_LEAD_MIN,
        "link delivery lead must be " + LINK_LEAD_MIN + " min, got " + info.linkDeliveryMin);
    });

    // The ETA must be strictly before the start time — never at/after it, and
    // never at booking time.
    check("Link ETA is ~60 min BEFORE start, and after the booking moment", function () {
      var now = Date.now();
      var start = now + 5 * HOUR;
      var info = buildConfirmation({ camp: { categories: ["Online"] }, startMs: start, nowMs: now });
      HC.assert(typeof info.linkEtaMs === "number", "online booking with a start time should have a link ETA");
      HC.assert(info.linkEtaMs < start, "link ETA must be before the session start");
      HC.assert(info.linkEtaMs > now, "link ETA must be after the booking moment (not at booking time)");
      HC.assert(Math.round((start - info.linkEtaMs) / ONE_MIN_MS) === LINK_LEAD_MIN,
        "ETA should be exactly " + LINK_LEAD_MIN + " min before start");
    });

    // Mirror image: in-person confirmation carries the venue, no link talk.
    check("In-person confirmation carries the venue and has no Zoom link", function () {
      var info = buildConfirmation({
        camp: { name: "Multi-Sports Week", categories: ["Multi-activity"], address: "Walthamstow Leisure Centre, E17" },
        startMs: Date.now() + 2 * HOUR
      });
      HC.assert(info.isOnline === false, "sports camp should not be online");
      HC.assert(info.linkEtaMs === null, "in-person booking has no link ETA");
      HC.assert(info.linkDeliveryMin === 0, "in-person has no link delivery lead");
      HC.assert(/walthamstow leisure centre/i.test(info.joinDetail), "in-person detail should name the venue");
      HC.assert(!/zoom/i.test(info.confirmationBody), "in-person confirmation should not mention Zoom");
    });

    // Online detection across the various signals.
    check("Online camps are detected from category, kind, venue and free text", function () {
      var cases = [
        { categories: ["Online", "Coding"] },
        { kind: "Online coding club" },
        { venue: "Live online via Zoom" },
        { booking: "Join via the Zoom link we email you" },
        { name: "Virtual Chess Camp" },
        { summary: "A remote half-term workshop from home" }
      ];
      for (var i = 0; i < cases.length; i++) {
        HC.assert(isOnlineCamp(cases[i]) === true, "should detect online for case " + i);
        var info = buildConfirmation({ camp: cases[i], startMs: Date.now() + HOUR });
        HC.assert(info.isOnline === true && info.linkIncludedNow === false,
          "online case " + i + " withholds the link at booking");
      }
    });

    check("In-person camps are NOT misdetected as online", function () {
      var cases = [
        { categories: ["Multi-activity"], venue: "Walthamstow Leisure Centre" },
        { kind: "Sports camp", booking: "Book your week through the camp page" },
        { name: "Forest School Adventure Week" }
      ];
      for (var i = 0; i < cases.length; i++) {
        HC.assert(isOnlineCamp(cases[i]) === false, "should NOT detect online for case " + i);
      }
    });

    // Explicit override (the provider's "this is online" tick box) wins.
    check("Explicit online override wins over text", function () {
      var inPersonText = { categories: ["Multi-activity"], venue: "Leisure Centre" };
      HC.assert(isOnlineCamp(inPersonText, true) === true, "override true => online");
      var onlineText = { categories: ["Online"], venue: "Zoom" };
      HC.assert(isOnlineCamp(onlineText, false) === false, "override false => not online");
      // And it flows through buildConfirmation via booking.online.
      var info = buildConfirmation({ camp: inPersonText, online: true, startMs: Date.now() + HOUR });
      HC.assert(info.isOnline === true && info.linkIncludedNow === false,
        "online override should withhold the link");
    });

    // 90-minute change cutoff for providers (article: change link >=90 min before).
    check("Provider can change link >=90 min before, not after", function () {
      var start = Date.now() + 1000 * 60 * 200; // 200 min away
      HC.assert(canChangeLink(start, Date.now()) === true, "200 min before => can change");
      var start2 = Date.now() + 1000 * 60 * 120; // 120 min away
      HC.assert(canChangeLink(start2, Date.now()) === true, "120 min before => can change");
      var start3 = Date.now() + 1000 * 60 * 90; // exactly 90 min
      HC.assert(canChangeLink(start3, Date.now()) === true, "exactly 90 min before => still can change");
      var start4 = Date.now() + 1000 * 60 * 45; // 45 min away
      HC.assert(canChangeLink(start4, Date.now()) === false, "45 min before => too late to change");
      HC.assert(LINK_CHANGE_CUTOFF_MIN === 90, "change cutoff should be 90 min");
    });

    // The link is "sent" only inside the ~60-min window — not at booking time.
    check("Link is not 'sent' at booking, only within the ~60-min window", function () {
      var start = Date.now() + 1000 * 60 * 180; // 3hrs away (booking time)
      HC.assert(linkSentYet(start, Date.now()) === false, "3hrs before start => link not sent yet");
      var soon = Date.now() + 1000 * 60 * 30; // 30 min away
      HC.assert(linkSentYet(soon, Date.now()) === true, "30 min before start => link sent");
      var atLead = Date.now() + 1000 * 60 * 60; // exactly 60 min
      HC.assert(linkSentYet(atLead, Date.now()) === true, "exactly 60 min before => link sent");
    });

    // Invariant: the Zoom link is NEVER in the booking confirmation, online or not.
    check("Zoom link is never included in any booking confirmation (invariant)", function () {
      var cases = [
        { camp: { categories: ["Online"] }, startMs: Date.now() + HOUR },
        { camp: { categories: ["Multi-activity"] }, startMs: Date.now() + HOUR },
        { camp: { kind: "Online drama" } },
        { camp: {} },
        {}
      ];
      for (var i = 0; i < cases.length; i++) {
        var info = buildConfirmation(cases[i]);
        HC.assert(info.linkIncludedNow === false, "link must never be in confirmation, case " + i);
      }
    });

    // Confirmation works without a start time (link timing stated relatively).
    check("Online confirmation still states pre-start delivery with no start time", function () {
      var info = buildConfirmation({ camp: { categories: ["Online"] } });
      HC.assert(info.isOnline === true, "still online");
      HC.assert(info.linkEtaMs === null, "no ETA without a start time");
      HC.assert(/before the session starts/i.test(info.linkLine),
        "link line should still say it arrives before the session starts");
      HC.assert(info.linkIncludedNow === false, "still no link in the confirmation");
    });

    // Defensive: rubbish / missing input must not throw and defaults safe.
    check("Defensive: bad/empty input does not throw and defaults to in-person", function () {
      var inputs = [null, undefined, {}, { camp: null }, { camp: 12345 }, { camp: { categories: "oops" } }];
      for (var i = 0; i < inputs.length; i++) {
        var info = buildConfirmation(inputs[i]);
        HC.assert(info && typeof info === "object", "should return an object for bad input #" + i);
        HC.assert(info.linkIncludedNow === false, "bad input #" + i + " never includes a link");
        HC.assert(info.isOnline === false, "bad input #" + i + " defaults to in-person");
      }
      HC.assert(textSaysOnline(null) === false, "null => not online");
      HC.assert(textSaysOnline(42) === false, "number => not online");
      HC.assert(canChangeLink("nope") === false, "bad start => cannot change");
      HC.assert(canChangeLink(null) === false, "null start => cannot change");
      HC.assert(linkSentYet(undefined) === false, "undefined start => not sent");
    });

    // Live data: seed picks real (or fallback) camps and both states are right.
    check("Seed camps reachable; online seed withholds link, in-person carries venue", function () {
      var seeds = seedCamps();
      HC.assert(seeds.onlineCamp && seeds.inPersonCamp, "should seed an online camp and an in-person camp");
      var now = Date.now();
      var onInfo = buildConfirmation({ camp: seeds.onlineCamp, startMs: now + 3 * HOUR, nowMs: now });
      var ipInfo = buildConfirmation({ camp: seeds.inPersonCamp, startMs: now + 3 * HOUR, nowMs: now });
      HC.assert(onInfo.isOnline === true && onInfo.linkIncludedNow === false,
        "online seed: detected online, link withheld");
      HC.assert(onInfo.linkEtaMs < (now + 3 * HOUR) && onInfo.linkEtaMs > now,
        "online seed: link ETA before start, after booking");
      HC.assert(ipInfo.isOnline === false && ipInfo.linkEtaMs === null,
        "in-person seed: not online, no link ETA");
    });

    // Persistence: an override round-trips through HC.store (namespaced).
    check("Online override persists via HC.store (namespaced)", function () {
      var before = readOverrides();
      var snapshot = JSON.parse(JSON.stringify(before || {}));
      snapshot["__zoom_test__"] = true;
      var ok = writeOverrides(snapshot);
      HC.assert(ok !== false, "writeOverrides should succeed");
      var got = readOverrides();
      HC.assert(got && got.__zoom_test__ === true, "override should round-trip");
      // And it actually drives the decision when passed through buildConfirmation.
      var info = buildConfirmation({ camp: { categories: ["Multi-activity"] }, online: got.__zoom_test__, startMs: Date.now() + HOUR });
      HC.assert(info.isOnline === true && info.linkIncludedNow === false,
        "persisted true override forces online + withholds link");
      delete snapshot["__zoom_test__"];
      writeOverrides(snapshot); // clean up our probe key
    });

    return { pass: pass, fail: fail, log: log };
  }

  /* ---------------- register ---------------- */

  HC.registerFeature({
    id: "parent-zoom-link",
    title: "Online-class Zoom link",
    side: "parent",
    icon: "💻",
    summary: "Booked an online holiday camp? Your confirmation arrives straightaway, but the Zoom join link is emailed only ~1hr before the session starts — for child safety — following the source marketplace pattern for online Zoom classes. It is never in the booking confirmation.",
    render: render,
    selfTest: selfTest
  });
})();
