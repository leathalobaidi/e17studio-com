/* HolidayCamp feature — provider-zoom-online
 *
 * Run online camps via Zoom (recurring links, waiting room)  (PROVIDER side)
 *
 * Replicates Happity's provider-side "Happity@Home / run classes with Zoom"
 * set-up (support articles 3808253, 3807913, 3809195; also 4885596). This is
 * the SET-UP counterpart to parent-zoom-link.js (which is the parent-facing
 * "your link arrives ~1hr before" experience).
 *
 * Faithful to the evidence:
 *   3808253 "How to schedule regular classes using Zoom":
 *     - "select 'recurring meeting'. Then in the drop down select 'no fixed
 *        time'."                            -> a recurring room, no fixed time.
 *     - "choose 'Generate automatically'. This creates a UNIQUE Zoom link for
 *        your classes."                     -> one reusable link per camp.
 *     - "use the 'Waiting room' feature and leave this selected … allow you to
 *        check your register and only admit those who have paid."
 *     - "Leave 'Require meeting password' ticked ON (this is now required by
 *        Zoom)" … "Zoom will embed an encrypted version of your password into
 *        the link (the letters after 'pwd=')."  -> link carries ?pwd=…
 *     - "The Happity booking system will email your link to participants around
 *        an [hour] before the start of each class … it will also email YOU with
 *        the link and a list of your customers too … If you need to change your
 *        Zoom link for a class, be sure to do this at least 90 minutes before …
 *        You will also receive a list of last minute sign ups just before the
 *        class is due to start."
 *   3809195 "Add a logo and customise your waiting room":
 *     - waiting room can carry your own logo + a short welcome/holding message.
 *   4885596 "Confirmation emails for Online Zoom Classes":
 *     - "for security these [links] are only sent out an hour before the class
 *        starts (if you need to change the link … at least 90 minutes before)."
 *
 * Framed for SCHOOL-AGE HOLIDAY CAMPS, not baby classes: a provider running an
 * online holiday camp (virtual coding club, online chess/drama half-term
 * workshop) schedules ONE recurring Zoom room, turns on the waiting room (so
 * only paid-for children are admitted — a safeguarding control), and the
 * platform then emails that link to the booked attendees shortly before each
 * session starts.
 *
 * ACCEPTANCE CRITERION (asserted in selfTest):
 *   An online camp stores a recurring Zoom link; links are emailed to
 *   attendees before start. We verify the recurring room is stored against the
 *   camp, that the stored link is a recurring (no-fixed-time) link carrying the
 *   embedded ?pwd= password, and that the per-session email schedule sends that
 *   link to every attendee strictly BEFORE the session start time.
 *
 * Self-contained, defensive, no imports/exports. Persistence via HC.store only.
 * Calls HC.registerFeature at top level and never throws at registration time.
 */
(function () {
  "use strict";

  // Defensive: never throw at module load if HC core isn't present.
  if (typeof window === "undefined" || !window.HC || typeof window.HC.registerFeature !== "function") {
    if (typeof console !== "undefined" && console.warn) {
      console.warn("[HC] provider-zoom-online: HC core not found; skipping registration.");
    }
    return;
  }

  var HC = window.HC;

  var STORE_KEY = "provider_zoom_rooms";   // { [campId]: roomObj }

  // Timing rules straight from the Happity evidence (minutes before start).
  var LINK_LEAD_MIN = 60;          // link emailed ~1hr (60 min) before start
  var LINK_CHANGE_CUTOFF_MIN = 90; // link changes must land >=90 min before
  var LATE_LIST_LEAD_MIN = 5;      // host gets a late-joiner list ~5 min before
  var ONE_MIN_MS = 60 * 1000;

  /* ===================================================================
     PURE LOGIC (DOM-free, testable)
     =================================================================== */

  function asText(v) {
    return typeof v === "string" ? v : (v == null ? "" : String(v));
  }

  // --- online detection (mirrors parent-zoom-link so the two sides agree) ---
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
  function isOnlineCamp(camp, override) {
    if (override === true || override === false) return override;
    var c = camp || {};
    if (typeof c.online === "boolean") return c.online;
    if (typeof c.isOnline === "boolean") return c.isOnline;
    var cats = Array.isArray(c.categories) ? c.categories : [];
    for (var i = 0; i < cats.length; i++) {
      if (textSaysOnline(cats[i])) return true;
    }
    return textSaysOnline(c.kind) || textSaysOnline(c.venue) ||
      textSaysOnline(c.booking) || textSaysOnline(c.summary) ||
      textSaysOnline(c.name);
  }

  // --- Zoom room creation -------------------------------------------------
  // Generate a Zoom-style meeting id (9–11 digits) deterministically-ish.
  function genMeetingId() {
    var n = "";
    for (var i = 0; i < 11; i++) n += String(Math.floor(Math.random() * 10));
    // group like Zoom shows it: 3-4-4 but the URL uses the raw digits
    return n;
  }

  // Generate the encrypted-looking password token Zoom embeds after pwd=.
  function genPwdToken() {
    var chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    var t = "";
    for (var i = 0; i < 32; i++) t += chars.charAt(Math.floor(Math.random() * chars.length));
    return t;
  }

  // Build the canonical recurring Zoom link. Per Happity, Zoom embeds an
  // encrypted version of the password into the link (the letters after pwd=).
  function buildZoomLink(meetingId, pwdToken) {
    var id = asText(meetingId).replace(/[^0-9]/g, "") || genMeetingId();
    var pwd = asText(pwdToken).replace(/[^A-Za-z0-9]/g, "") || genPwdToken();
    return "https://us02web.zoom.us/j/" + id + "?pwd=" + pwd;
  }

  // Does a link look like a valid recurring Zoom join link with embedded pwd?
  function isValidZoomLink(link) {
    var s = asText(link);
    if (!/^https?:\/\/[a-z0-9.-]*zoom\.us\/j\/\d{9,11}/i.test(s)) return false;
    if (s.indexOf("pwd=") === -1) return false;               // password required ON
    var pwd = (s.split("pwd=")[1] || "").split("&")[0];
    return pwd.length >= 6;                                    // non-trivial token
  }

  // Create (or refresh) the recurring room object for a camp. This is the
  // "Schedule a Meeting -> recurring -> no fixed time -> generate
  // automatically -> waiting room ON -> require password ON" flow, captured as
  // a stored object. It is deliberately ONE link reused for every session.
  function createRoom(opts) {
    var o = opts || {};
    var meetingId = o.meetingId || genMeetingId();
    var pwdToken = o.pwdToken || genPwdToken();
    return {
      campId: asText(o.campId) || null,
      campName: asText(o.campName) || "Online holiday camp",
      meetingId: meetingId,
      pwdToken: pwdToken,
      link: buildZoomLink(meetingId, pwdToken),
      recurring: true,             // "recurring meeting"
      fixedTime: false,            // "no fixed time"
      autoGenerated: true,         // "Generate automatically" => unique link
      waitingRoom: o.waitingRoom !== false,   // recommend ON (safeguarding)
      requirePassword: true,       // "Require meeting password" ON (Zoom mandate)
      muteOnEntry: o.muteOnEntry !== false,   // optional advanced control
      camerasOnRequest: !!o.camerasOnRequest,
      waitingRoomLogo: asText(o.waitingRoomLogo) || "",       // 3809195
      waitingRoomMessage: asText(o.waitingRoomMessage) ||
        "Welcome! Your camp host will let you in from the waiting room shortly.",
      createdMs: typeof o.createdMs === "number" ? o.createdMs : Date.now()
    };
  }

  // Validate a room object before it is allowed to be stored / used.
  function validateRoom(room) {
    var errs = [];
    var r = room || {};
    if (!isValidZoomLink(r.link)) errs.push("Zoom link must be a valid recurring link with an embedded ?pwd= password.");
    if (r.recurring !== true) errs.push("Room must be a recurring meeting.");
    if (r.fixedTime !== false) errs.push("Recurring room must use 'no fixed time'.");
    if (r.requirePassword !== true) errs.push("'Require meeting password' must be ON (required by Zoom).");
    if (r.waitingRoom !== true) errs.push("Waiting room should be ON so only paid-for children are admitted.");
    return { ok: errs.length === 0, errors: errs };
  }

  // --- per-session email scheduling --------------------------------------
  // Given a stored room and a list of session start times + the booked
  // attendees, produce the schedule of "send link to attendees" jobs. Each
  // job's sendMs is LINK_LEAD_MIN before that session's start. The platform
  // also emails the HOST the link + register, and a late-joiner list ~5 min
  // before. THE LINK IS NEVER SENT AT OR AFTER START.
  //
  // session : { startMs:Number, attendees:[{email,name}, ...] }
  // returns : { jobs:[{ sessionStartMs, sendMs, link, recipients:[..emails],
  //                     hostRegister:Boolean }],
  //             lateLists:[{ sessionStartMs, sendMs }] }
  function scheduleLinkEmails(room, sessions, hostEmail) {
    var out = { jobs: [], lateLists: [] };
    var r = room || {};
    var link = asText(r.link);
    var list = Array.isArray(sessions) ? sessions : [];
    for (var i = 0; i < list.length; i++) {
      var s = list[i] || {};
      var startMs = typeof s.startMs === "number" ? s.startMs : null;
      if (startMs === null || isNaN(startMs)) continue;       // skip undated sessions
      var attendees = Array.isArray(s.attendees) ? s.attendees : [];
      var recipients = [];
      for (var a = 0; a < attendees.length; a++) {
        var att = attendees[a] || {};
        var email = asText(att.email || att);
        if (email) recipients.push(email);
      }
      // host gets the link too (article: "email YOU with the link and a list")
      var hostTo = asText(hostEmail);
      out.jobs.push({
        sessionStartMs: startMs,
        sendMs: startMs - LINK_LEAD_MIN * ONE_MIN_MS,   // ~60 min BEFORE start
        link: link,
        recipients: recipients,
        hostEmail: hostTo || null,
        hostRegister: true                              // host also gets the register
      });
      // late-joiner list to the host ~5 min before start
      out.lateLists.push({
        sessionStartMs: startMs,
        sendMs: startMs - LATE_LIST_LEAD_MIN * ONE_MIN_MS
      });
    }
    return out;
  }

  // Provider-side: can the link still be changed at nowMs for a session at
  // startMs? Mirrors "change it at least 90 minutes before the class starts".
  function canChangeLink(startMs, nowMs) {
    if (typeof startMs !== "number" || isNaN(startMs)) return false;
    var now = typeof nowMs === "number" ? nowMs : Date.now();
    return (startMs - now) / ONE_MIN_MS >= LINK_CHANGE_CUTOFF_MIN;
  }

  // Has the link been emailed yet for a session (within ~60-min window)?
  function linkSentYet(startMs, nowMs) {
    if (typeof startMs !== "number" || isNaN(startMs)) return false;
    var now = typeof nowMs === "number" ? nowMs : Date.now();
    return (startMs - now) / ONE_MIN_MS <= LINK_LEAD_MIN;
  }

  function clock(ms) {
    try {
      var d = new Date(ms);
      if (isNaN(d.getTime())) return "";
      return ("0" + d.getHours()).slice(-2) + ":" + ("0" + d.getMinutes()).slice(-2);
    } catch (e) { return ""; }
  }

  /* ===================================================================
     PERSISTENCE (HC.store, namespaced)
     =================================================================== */

  function readRooms() {
    try {
      var o = HC.store.get(STORE_KEY, {});
      return (o && typeof o === "object") ? o : {};
    } catch (e) { return {}; }
  }
  function writeRooms(obj) {
    try { return HC.store.set(STORE_KEY, obj || {}); } catch (e) { return false; }
  }
  // Store a room against its camp id and return the stored copy.
  function saveRoom(campId, room) {
    var id = asText(campId);
    if (!id) return null;
    var all = readRooms();
    all[id] = room;
    writeRooms(all);
    return room;
  }
  function getRoom(campId) {
    var all = readRooms();
    return all[asText(campId)] || null;
  }

  /* ===================================================================
     LIVE DATA SEED
     =================================================================== */

  function seedOnlineCamp() {
    var providers = [];
    try { providers = HC.data.providers || []; } catch (e) { providers = []; }
    for (var i = 0; i < providers.length; i++) {
      var p = providers[i];
      if (p && isOnlineCamp(p)) return p;
    }
    // Synthetic fallback so the demo + tests never depend on a live record.
    return {
      id: "demo-online-coding-camp",
      name: "E17 Online Coding Camp (Zoom)",
      kind: "Online coding club",
      categories: ["Online", "Coding"],
      venue: "Live online via Zoom",
      booking: "Join the daily online session via the Zoom link we email you before each class."
    };
  }

  /* ===================================================================
     UI
     =================================================================== */

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
    if (!mountEl) return;
    mountEl.innerHTML = "";

    var camp = seedOnlineCamp();
    var campId = asText(camp && camp.id) || "demo-online-camp";

    var wrap = el("div", { style: "font-family:'Nunito Sans',system-ui,sans-serif;color:var(--text,#383838)" });
    wrap.appendChild(el("p", { style: "font-size:14px;margin:0 0 14px;line-height:1.55" },
      "Run an <strong>online holiday camp</strong> on Zoom. Schedule <strong>one recurring room</strong> " +
      "(“no fixed time”), turn on the <strong>waiting room</strong> so only paid-for children are " +
      "admitted, and the platform emails that join link to your booked attendees <strong>~" + LINK_LEAD_MIN +
      " minutes before</strong> each session starts."));

    // --- set-up form ---
    var form = el("div", {
      style: "background:#fff;border:1.5px solid var(--line,#E6E6E6);border-radius:14px;padding:16px;margin:0 0 16px"
    });
    form.appendChild(el("div", { class: "hc-sidehead", style: "margin-top:0" },
      "Schedule a recurring Zoom room — " + esc(camp && camp.name ? camp.name : "Online camp")));
    form.innerHTML +=
      '<label style="display:block;font-size:12.5px;font-weight:700;color:var(--purple,#603488);margin:6px 0 4px">Waiting-room welcome message (3809195)</label>' +
      '<input id="hcZoomMsg" type="text" value="Welcome to E17 Online Coding Camp! We\'ll let your child in shortly." ' +
        'style="width:100%;box-sizing:border-box;padding:9px 11px;border:1.5px solid var(--line,#E6E6E6);border-radius:10px;font-size:13px" />' +
      '<div style="display:flex;gap:14px;flex-wrap:wrap;margin:12px 0 4px;font-size:13px">' +
        '<label style="display:flex;align-items:center;gap:7px"><input id="hcZoomWait" type="checkbox" checked /> Waiting room ON</label>' +
        '<label style="display:flex;align-items:center;gap:7px"><input id="hcZoomMute" type="checkbox" checked /> Mute on entry</label>' +
        '<label style="display:flex;align-items:center;gap:7px"><input id="hcZoomPwd" type="checkbox" checked disabled /> Require password (Zoom mandate)</label>' +
      '</div>';
    var genBtn = el("button", { class: "hc-btn", type: "button", style: "margin-top:10px" },
      "Generate recurring link");
    form.appendChild(genBtn);
    wrap.appendChild(form);

    var out = el("div", { id: "hcZoomOut" });
    wrap.appendChild(out);

    function drawRoom(room) {
      out.innerHTML = "";
      var v = validateRoom(room);
      var card = el("div", {
        style: "background:#fff;border:1.5px solid var(--line,#E6E6E6);border-radius:14px;padding:16px;margin:0 0 16px"
      });
      card.innerHTML =
        '<div style="font-family:\'Quicksand\',system-ui,sans-serif;font-weight:700;color:var(--purple,#603488);margin:0 0 6px">' +
          "🔗 Stored recurring Zoom room</div>" +
        '<div style="font-size:12.5px;word-break:break-all;background:var(--purple-tint,#F0E8F4);padding:9px 11px;border-radius:10px;color:var(--purple,#603488)">' +
          esc(room.link) + "</div>" +
        '<ul style="margin:10px 0 0;padding-left:18px;font-size:12.5px;line-height:1.7;color:var(--text,#383838)">' +
          "<li>Recurring meeting, <strong>no fixed time</strong> — one link reused every session.</li>" +
          "<li>Password embedded after <code>pwd=</code> (required by Zoom).</li>" +
          "<li>Waiting room <strong>" + (room.waitingRoom ? "ON" : "OFF") + "</strong>" +
            (room.waitingRoomMessage ? " — “" + esc(room.waitingRoomMessage) + "”" : "") + "</li>" +
          "<li>Stored against camp <code>" + esc(room.campId) + "</code>.</li>" +
        "</ul>" +
        '<div style="margin-top:8px;font-size:12px;color:' + (v.ok ? "#2f7d4f" : "#9a1f5e") + ';font-weight:700">' +
          (v.ok ? "✓ Valid — ready to email to attendees before each session." :
                  "✗ " + esc(v.errors.join(" "))) + "</div>";
      out.appendChild(card);

      // schedule preview against three demo attendees + two sessions
      var now = Date.now();
      var sessions = [
        { startMs: now + 3 * 60 * ONE_MIN_MS, attendees: [
          { email: "alex.parent@example.com" }, { email: "sam.carer@example.com" }, { email: "jo.guardian@example.com" }
        ] },
        { startMs: now + 27 * 60 * ONE_MIN_MS, attendees: [
          { email: "alex.parent@example.com" }, { email: "sam.carer@example.com" }
        ] }
      ];
      var sched = scheduleLinkEmails(room, sessions, "host@e17camps.example");
      var tl = el("div", {
        style: "background:#fff;border:1.5px solid var(--line,#E6E6E6);border-radius:14px;padding:14px 16px"
      });
      var rows = "";
      for (var i = 0; i < sched.jobs.length; i++) {
        var j = sched.jobs[i];
        rows +=
          '<li><strong>Session at ' + esc(clock(j.sessionStartMs)) + ':</strong> link emailed to <strong>' +
          j.recipients.length + " attendee" + (j.recipients.length === 1 ? "" : "s") + "</strong> at <strong>" +
          esc(clock(j.sendMs)) + "</strong> (≈" + LINK_LEAD_MIN + " min before). Host gets link + register.</li>";
      }
      tl.innerHTML =
        '<div style="font-family:\'Quicksand\',system-ui,sans-serif;font-weight:700;color:var(--purple,#603488);margin:0 0 8px">' +
          "Link-email schedule</div>" +
        '<ul style="margin:0;padding-left:18px;font-size:13px;line-height:1.7;color:var(--text,#383838)">' + rows +
          "<li style=\"color:var(--muted,#808080)\">Links go out <strong>before</strong> each start — never at or after it. " +
            "Change deadline: ≥" + LINK_CHANGE_CUTOFF_MIN + " min before. Late-joiner list to host ~" +
            LATE_LIST_LEAD_MIN + " min before.</li>" +
        "</ul>";
      out.appendChild(tl);
    }

    function generate() {
      try {
        var msg = "";
        var waiting = true, mute = true;
        var msgEl = document.getElementById("hcZoomMsg");
        var waitEl = document.getElementById("hcZoomWait");
        var muteEl = document.getElementById("hcZoomMute");
        if (msgEl) msg = msgEl.value;
        if (waitEl) waiting = !!waitEl.checked;
        if (muteEl) mute = !!muteEl.checked;
        var room = createRoom({
          campId: campId,
          campName: camp && camp.name,
          waitingRoom: waiting,
          muteOnEntry: mute,
          waitingRoomMessage: msg
        });
        saveRoom(campId, room);
        drawRoom(room);
        try { HC.util.toast("Recurring Zoom room saved for this camp"); } catch (e) {}
      } catch (e) {
        out.innerHTML = '<p style="color:#9a1f5e">Could not generate room: ' + esc(e && e.message) + "</p>";
      }
    }

    genBtn.addEventListener("click", generate);

    // Show an already-stored room if one exists, else create one for the demo.
    var existing = getRoom(campId);
    if (existing && isValidZoomLink(existing.link)) drawRoom(existing);
    else generate();

    mountEl.appendChild(wrap);
  }

  /* ===================================================================
     SELF TEST
     =================================================================== */

  function selfTest() {
    var pass = 0, fail = 0, log = [];
    function check(label, fn) {
      try { fn(); pass += 1; log.push("✓ " + label); }
      catch (e) { fail += 1; log.push("✗ " + label + " — " + (e && e.message ? e.message : String(e))); }
    }

    var HOUR = 60 * ONE_MIN_MS;

    // ===== ACCEPTANCE CRITERION (primary) =====
    // An online camp stores a recurring Zoom link; links are emailed to
    // attendees BEFORE start.
    check("ACCEPTANCE: online camp stores a recurring Zoom link emailed to attendees before start", function () {
      var campId = "__accept_test__";
      var room = createRoom({ campId: campId, campName: "E17 Online Coding Camp" });

      // (1) It is a RECURRING link, no fixed time, with the embedded pwd=.
      HC.assert(room.recurring === true, "room must be recurring");
      HC.assert(room.fixedTime === false, "recurring room must be 'no fixed time'");
      HC.assert(isValidZoomLink(room.link), "stored link must be a valid Zoom link with embedded ?pwd=");
      HC.assert(room.link.indexOf("pwd=") !== -1, "link must carry the embedded password (pwd=)");

      // (2) It is STORED against the camp and round-trips through HC.store.
      var saved = saveRoom(campId, room);
      HC.assert(saved && saved.link === room.link, "saveRoom returns the stored room");
      var got = getRoom(campId);
      HC.assert(got && got.link === room.link, "the recurring link is stored against the camp id");
      HC.assert(got.recurring === true && got.fixedTime === false, "stored room stays recurring/no-fixed-time");

      // (3) Links are EMAILED TO ATTENDEES BEFORE START.
      var now = Date.now();
      var start = now + 3 * HOUR;
      var attendees = [{ email: "a@x.com" }, { email: "b@x.com" }, { email: "c@x.com" }];
      var sched = scheduleLinkEmails(got, [{ startMs: start, attendees: attendees }], "host@x.com");
      HC.assert(sched.jobs.length === 1, "one email job per session");
      var job = sched.jobs[0];
      HC.assert(job.link === got.link, "the emailed link IS the stored recurring link");
      HC.assert(job.recipients.length === 3, "every attendee is a recipient (got " + job.recipients.length + ")");
      HC.assert(job.recipients.indexOf("a@x.com") !== -1 &&
                job.recipients.indexOf("b@x.com") !== -1 &&
                job.recipients.indexOf("c@x.com") !== -1, "all attendee emails included");
      // The crucial timing assertion: the send happens BEFORE the start.
      HC.assert(job.sendMs < start, "link email must be scheduled BEFORE the session start");
      HC.assert(Math.round((start - job.sendMs) / ONE_MIN_MS) === LINK_LEAD_MIN,
        "link email lands exactly " + LINK_LEAD_MIN + " min before start");

      // clean up our probe key
      var all = readRooms(); delete all[campId]; writeRooms(all);
    });

    // The generated link shape: zoom.us /j/<id> ?pwd=<token>.
    check("Generated recurring link has zoom.us/j/<id>?pwd=<token> shape", function () {
      var room = createRoom({ campId: "x" });
      HC.assert(/zoom\.us\/j\/\d{9,11}\?pwd=[A-Za-z0-9]{6,}/.test(room.link),
        "link should match the Zoom recurring-link pattern, got " + room.link);
      // password is genuinely embedded and non-trivial
      var pwd = room.link.split("pwd=")[1];
      HC.assert(pwd && pwd.length >= 6, "embedded pwd token should be >=6 chars");
    });

    // Each created room gets a UNIQUE link (Generate automatically).
    check("Each room is generated with a unique link", function () {
      var seen = {};
      for (var i = 0; i < 20; i++) {
        var l = createRoom({ campId: "u" + i }).link;
        HC.assert(!seen[l], "links should be unique across rooms");
        seen[l] = true;
      }
    });

    // validateRoom enforces the documented Zoom set-up.
    check("validateRoom enforces recurring + no-fixed-time + password + waiting room", function () {
      var good = createRoom({ campId: "g" });
      HC.assert(validateRoom(good).ok === true, "a fresh room should validate");

      HC.assert(validateRoom(Object.assign({}, good, { recurring: false })).ok === false,
        "non-recurring room should fail");
      HC.assert(validateRoom(Object.assign({}, good, { fixedTime: true })).ok === false,
        "fixed-time room should fail");
      HC.assert(validateRoom(Object.assign({}, good, { requirePassword: false })).ok === false,
        "password-off room should fail");
      HC.assert(validateRoom(Object.assign({}, good, { waitingRoom: false })).ok === false,
        "waiting-room-off room should fail");
      HC.assert(validateRoom(Object.assign({}, good, { link: "https://example.com/notzoom" })).ok === false,
        "non-zoom link should fail");
      HC.assert(validateRoom(Object.assign({}, good, { link: "https://us02web.zoom.us/j/12345678901" })).ok === false,
        "zoom link WITHOUT pwd= should fail");
    });

    // isValidZoomLink edge cases.
    check("isValidZoomLink accepts real recurring links and rejects bad ones", function () {
      HC.assert(isValidZoomLink("https://us02web.zoom.us/j/82345678901?pwd=abcDEF123456") === true, "valid link ok");
      HC.assert(isValidZoomLink("https://us02web.zoom.us/j/82345678901") === false, "missing pwd rejected");
      HC.assert(isValidZoomLink("https://us02web.zoom.us/j/82345678901?pwd=abc") === false, "short pwd rejected");
      HC.assert(isValidZoomLink("https://teams.microsoft.com/l/meetup/abc?pwd=longenough") === false, "non-zoom rejected");
      HC.assert(isValidZoomLink("not a link") === false, "garbage rejected");
      HC.assert(isValidZoomLink("") === false, "empty rejected");
      HC.assert(isValidZoomLink(null) === false, "null rejected");
    });

    // Waiting-room logo + message (3809195) are captured on the room.
    check("Waiting-room logo and welcome message are stored on the room (3809195)", function () {
      var room = createRoom({
        campId: "w", waitingRoomLogo: "logo.png",
        waitingRoomMessage: "Welcome to camp!"
      });
      HC.assert(room.waitingRoom === true, "waiting room on by default");
      HC.assert(room.waitingRoomLogo === "logo.png", "logo stored");
      HC.assert(room.waitingRoomMessage === "Welcome to camp!", "welcome message stored");
      // default message present when none supplied
      var room2 = createRoom({ campId: "w2" });
      HC.assert(room2.waitingRoomMessage.length > 0, "a default holding message is present");
    });

    // Scheduling: link sent to EVERY attendee, before EVERY session start.
    check("Link emailed to every attendee before every session start", function () {
      var room = createRoom({ campId: "s" });
      var now = Date.now();
      var sessions = [
        { startMs: now + 2 * HOUR, attendees: [{ email: "p1@x.com" }, { email: "p2@x.com" }] },
        { startMs: now + 26 * HOUR, attendees: [{ email: "p1@x.com" }, { email: "p3@x.com" }, { email: "p4@x.com" }] }
      ];
      var sched = scheduleLinkEmails(room, sessions, "host@x.com");
      HC.assert(sched.jobs.length === 2, "a job per session");
      for (var i = 0; i < sched.jobs.length; i++) {
        var j = sched.jobs[i];
        HC.assert(j.sendMs < j.sessionStartMs, "session " + i + ": send before start");
        HC.assert(j.link === room.link, "session " + i + ": emails the stored recurring link");
        HC.assert(j.recipients.length === sessions[i].attendees.length,
          "session " + i + ": one recipient per attendee");
        HC.assert(j.hostEmail === "host@x.com" && j.hostRegister === true,
          "session " + i + ": host also gets link + register");
      }
    });

    // Late-joiner list goes to host ~5 min before, also before start.
    check("Late-joiner list scheduled ~5 min before start (still before start)", function () {
      var room = createRoom({ campId: "l" });
      var now = Date.now();
      var start = now + 90 * ONE_MIN_MS;
      var sched = scheduleLinkEmails(room, [{ startMs: start, attendees: [{ email: "p@x.com" }] }], "host@x.com");
      HC.assert(sched.lateLists.length === 1, "one late list per session");
      var ll = sched.lateLists[0];
      HC.assert(ll.sendMs < start, "late list scheduled before start");
      HC.assert(Math.round((start - ll.sendMs) / ONE_MIN_MS) === LATE_LIST_LEAD_MIN,
        "late list is " + LATE_LIST_LEAD_MIN + " min before start");
      // ordering: link email (60 min before) goes out before the late list (5 min before)
      HC.assert(sched.jobs[0].sendMs < ll.sendMs, "link email precedes the late-joiner list");
    });

    // 90-minute change cutoff for providers.
    check("Provider can change link >=90 min before, not after", function () {
      var now = Date.now();
      HC.assert(canChangeLink(now + 200 * ONE_MIN_MS, now) === true, "200 min before => can change");
      HC.assert(canChangeLink(now + 90 * ONE_MIN_MS, now) === true, "exactly 90 min => can change");
      HC.assert(canChangeLink(now + 45 * ONE_MIN_MS, now) === false, "45 min before => too late");
      HC.assert(LINK_CHANGE_CUTOFF_MIN === 90, "cutoff is 90 min");
    });

    // The link is "sent" only inside the ~60-min window — not earlier.
    check("Link is not 'sent' until within the ~60-min window", function () {
      var now = Date.now();
      HC.assert(linkSentYet(now + 180 * ONE_MIN_MS, now) === false, "3h before => not sent");
      HC.assert(linkSentYet(now + 60 * ONE_MIN_MS, now) === true, "exactly 60 min => sent");
      HC.assert(linkSentYet(now + 30 * ONE_MIN_MS, now) === true, "30 min before => sent");
    });

    // Reusing the SAME stored link across sessions (recurring, no fixed time).
    check("Same recurring link is reused across all sessions", function () {
      var room = createRoom({ campId: "r" });
      var now = Date.now();
      var sched = scheduleLinkEmails(room, [
        { startMs: now + 1 * HOUR, attendees: [{ email: "a@x.com" }] },
        { startMs: now + 25 * HOUR, attendees: [{ email: "a@x.com" }] },
        { startMs: now + 49 * HOUR, attendees: [{ email: "a@x.com" }] }
      ], "host@x.com");
      HC.assert(sched.jobs.length === 3, "three sessions");
      HC.assert(sched.jobs[0].link === sched.jobs[1].link &&
                sched.jobs[1].link === sched.jobs[2].link, "all sessions use the one recurring link");
    });

    // Online detection (so the set-up only offers Zoom for online camps).
    check("Online camps detected from category/kind/venue/free text", function () {
      HC.assert(isOnlineCamp({ categories: ["Online", "Coding"] }) === true, "category online");
      HC.assert(isOnlineCamp({ kind: "Online coding club" }) === true, "kind online");
      HC.assert(isOnlineCamp({ venue: "Live online via Zoom" }) === true, "venue online");
      HC.assert(isOnlineCamp({ name: "Virtual Chess Camp" }) === true, "name online");
      HC.assert(isOnlineCamp({ categories: ["Multi-activity"], venue: "Leisure Centre" }) === false, "in-person not online");
      HC.assert(isOnlineCamp({ categories: ["Multi-activity"] }, true) === true, "explicit override wins");
    });

    // Defensive: junk input never throws; schedule skips undated sessions.
    check("Defensive: bad input does not throw; undated sessions skipped", function () {
      var bad = [null, undefined, {}, { link: 123 }, "oops"];
      for (var i = 0; i < bad.length; i++) {
        HC.assert(validateRoom(bad[i]).ok === false, "bad room #" + i + " invalid, not thrown");
        var s = scheduleLinkEmails(bad[i], null, null);
        HC.assert(s && Array.isArray(s.jobs) && s.jobs.length === 0, "bad schedule #" + i + " yields no jobs");
      }
      var room = createRoom({ campId: "d" });
      var sched = scheduleLinkEmails(room, [
        { startMs: Date.now() + HOUR, attendees: [{ email: "ok@x.com" }] },
        { startMs: null, attendees: [{ email: "skip@x.com" }] },          // undated -> skipped
        { attendees: [{ email: "skip2@x.com" }] }                          // no startMs -> skipped
      ], "host@x.com");
      HC.assert(sched.jobs.length === 1, "only the dated session schedules an email");
      HC.assert(isValidZoomLink(buildZoomLink(null, null)) === true, "buildZoomLink with no args still valid");
    });

    // Live seed: a real (or fallback) online camp can get a stored room.
    check("Seed online camp can store a valid recurring room", function () {
      var camp = seedOnlineCamp();
      HC.assert(camp && isOnlineCamp(camp), "seed should be an online camp");
      var room = createRoom({ campId: camp.id, campName: camp.name });
      HC.assert(validateRoom(room).ok === true, "seed room validates");
      var now = Date.now();
      var sched = scheduleLinkEmails(room, [{ startMs: now + 2 * HOUR, attendees: [{ email: "p@x.com" }] }], "host@x.com");
      HC.assert(sched.jobs[0].sendMs < (now + 2 * HOUR), "seed room: link emailed before start");
    });

    // Persistence round-trip for an arbitrary camp id via HC.store.
    check("Room round-trips through HC.store (namespaced)", function () {
      var campId = "__store_probe__";
      var room = createRoom({ campId: campId });
      saveRoom(campId, room);
      var got = getRoom(campId);
      HC.assert(got && got.link === room.link, "stored room is retrievable by camp id");
      var all = readRooms(); delete all[campId]; writeRooms(all);  // clean up
      HC.assert(getRoom(campId) === null, "probe room removed after cleanup");
    });

    return { pass: pass, fail: fail, log: log };
  }

  /* ===================================================================
     REGISTER
     =================================================================== */

  HC.registerFeature({
    id: "provider-zoom-online",
    title: "Run online camps via Zoom",
    side: "provider",
    icon: "📹",
    summary: "Schedule one recurring Zoom room for your online holiday camp (no fixed time, auto-generated link with embedded password, waiting room ON for safeguarding). The platform stores that link against the camp and emails it to your booked attendees ~1hr before each session starts.",
    render: render,
    selfTest: selfTest
  });
})();
