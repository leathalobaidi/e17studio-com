/* HolidayCamp feature — provider-online-safeguarding
 *
 * Online-class safeguarding: waiting room, no link at booking  (provider side)
 *
 * Replicates Happity's online-class safeguarding behaviour for the PROVIDER.
 * Evidence (support corpus):
 *   - 3831043 "Safeguarding measures for online classes":
 *       · "Don't let people in unless they have booked!"
 *       · "We strongly recommend using the waiting room feature, as this will
 *          give you the option to 'Admit' or 'Remove' each person as they join
 *          the class (click 'Participants' to open this box)."
 *       · Happity emails the host "a list of who to expect in your class before
 *          it starts" — the register to check joiners against.
 *       · Parents are asked to "keep their camera switched on and … you reserve
 *          the right to remove them … if they refuse to switch it on".
 *       · "customise your waiting room … remind them to check their onscreen
 *          name matches their booking".
 *       · "update the link … more than two hours before … automatically sent to
 *          all your registered attendees".
 *   - 4885596 "Confirmation emails for Online Zoom Classes":
 *       · "This initial confirmation email will not contain the Zoom link; for
 *          security these are only sent out an hour before the class starts (if
 *          you need to change the link … at least 90 minutes before)."
 *       · "You will also be sent a reminder along with your register … 5 mins
 *          before your class starts we'll also send you a … list of any late
 *          joiners. You could also use the live register within the dashboard
 *          and tick off people as they join."
 *
 * Framed for SCHOOL-AGE HOLIDAY CAMPS (not baby classes). An E17 provider runs
 * an ONLINE half-term / holiday camp session (virtual coding club, online drama
 * or chess camp) over Zoom. This is the HOST's safeguarding console:
 *   1. The join link is WITHHELD at booking and only released ~60 min before the
 *      session (auto-emailed with the register). Link edits must land >=90 min
 *      before to count, and >=120 min before to auto-propagate to attendees.
 *   2. A WAITING ROOM holds every joiner. The host ADMITS people who match a
 *      booked child on the register, and REMOVES gate-crashers (not booked),
 *      anyone refusing to turn their camera on, or otherwise unsuitable joiners.
 *
 * ACCEPTANCE CRITERION (asserted in selfTest):
 *   Online bookings withhold the Zoom link until shortly before; a waiting-room
 *   admit flow is described. We verify: the link is NOT released at booking and
 *   only becomes available within the ~60-min window; AND a joiner in the
 *   waiting room can be ADMITTED only when matched to the booked register, with
 *   non-booked / no-camera joiners blocked/removed.
 *
 * Self-contained, defensive, no imports/exports. Calls HC.registerFeature.
 */
(function () {
  "use strict";

  // Defensive: never throw at module load if HC isn't present.
  if (typeof window === "undefined" || !window.HC || typeof window.HC.registerFeature !== "function") {
    if (typeof console !== "undefined" && console.warn) {
      console.warn("[HC] provider-online-safeguarding: HC core not found; skipping registration.");
    }
    return;
  }

  var HC = window.HC;

  var STORE_KEY = "provider_online_safeguarding"; // { <sessionId>: { admitted:[joinerId,...] } }

  // Timing policy from the evidence (minutes before session start).
  var LINK_RELEASE_MIN = 60;     // link auto-emailed ~1 hour before start
  var LINK_CHANGE_MIN = 90;      // a link edit "counts" only if >=90 min before
  var LINK_PROPAGATE_MIN = 120;  // edit auto-resends to attendees only if >=2 hrs before
  var LATE_JOINER_MIN = 5;       // 5-min-before late-joiner follow-up
  var ONE_MIN_MS = 60 * 1000;

  // Waiting-room decisions.
  var ADMIT = "admit";
  var REMOVE = "remove";
  var WAIT = "wait";

  /* ===================================================================
     PURE LOGIC (testable, DOM-free)
     =================================================================== */

  function asText(v) { return typeof v === "string" ? v : (v == null ? "" : String(v)); }

  function clamp01Name(s) {
    // Normalise a display / booked name for tolerant matching: lowercase, trim,
    // collapse whitespace, strip punctuation. "Ava B." ~ "ava b".
    return asText(s).toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
  }

  // ---- link-release policy ------------------------------------------------

  // minutesBefore: positive when the session is in the future. Returns a struct
  // describing the link state at `nowMs` for a session starting at `startMs`.
  function minutesBefore(startMs, nowMs) {
    if (typeof startMs !== "number" || isNaN(startMs)) return null;
    var now = typeof nowMs === "number" ? nowMs : Date.now();
    return (startMs - now) / ONE_MIN_MS;
  }

  // Is the Zoom link released to attendees yet? It is WITHHELD at booking and
  // only released once we are within the ~60-min window before start (and not
  // long after the session has ended).
  function isLinkReleased(startMs, nowMs) {
    var mb = minutesBefore(startMs, nowMs);
    if (mb === null) return false;
    // released from 60 min before, through to ~3hrs after start (still valid).
    return mb <= LINK_RELEASE_MIN && mb >= -180;
  }

  // At BOOKING time (typically hours/days before), is the link in the parent's
  // confirmation? Always false — the acceptance criterion. We treat "at booking"
  // as any time earlier than the release window.
  function isLinkAtBooking(startMs, nowMs) {
    var mb = minutesBefore(startMs, nowMs);
    if (mb === null) return false;
    return mb > LINK_RELEASE_MIN; // before the release window => still withheld
  }

  // Can a link edit be made at all (>=90 min before)?
  function canEditLink(startMs, nowMs) {
    var mb = minutesBefore(startMs, nowMs);
    return mb !== null && mb >= LINK_CHANGE_MIN;
  }

  // Will a link edit auto-propagate to registered attendees (>=2 hrs before)?
  function linkEditPropagates(startMs, nowMs) {
    var mb = minutesBefore(startMs, nowMs);
    return mb !== null && mb >= LINK_PROPAGATE_MIN;
  }

  // Full policy snapshot for one session at a given moment.
  function linkPolicy(startMs, nowMs) {
    var now = typeof nowMs === "number" ? nowMs : Date.now();
    var mb = minutesBefore(startMs, now);
    var released = isLinkReleased(startMs, now);
    return {
      startMs: typeof startMs === "number" ? startMs : null,
      nowMs: now,
      minutesBefore: mb,
      atBooking: isLinkAtBooking(startMs, now),
      linkReleased: released,
      // link is in the booking confirmation? NEVER.
      linkInConfirmation: false,
      releaseEtaMs: (typeof startMs === "number") ? (startMs - LINK_RELEASE_MIN * ONE_MIN_MS) : null,
      canEdit: canEditLink(startMs, now),
      editPropagates: linkEditPropagates(startMs, now),
      releaseLeadMin: LINK_RELEASE_MIN,
      changeCutoffMin: LINK_CHANGE_MIN,
      propagateCutoffMin: LINK_PROPAGATE_MIN
    };
  }

  // ---- register matching --------------------------------------------------

  // A register is an array of expected attendees:
  //   { bookingId, childName, parentName }
  // A joiner is who appears in the waiting room:
  //   { id, displayName, cameraOn:Boolean }
  //
  // Match a joiner against the register by tolerant name matching on either the
  // child's name or the parent's name (parents often join under their own name).
  function matchRegister(joiner, register) {
    var reg = Array.isArray(register) ? register : [];
    var disp = clamp01Name(joiner && joiner.displayName);
    if (!disp) return null;
    for (var i = 0; i < reg.length; i++) {
      var r = reg[i] || {};
      var child = clamp01Name(r.childName);
      var parent = clamp01Name(r.parentName);
      if (!child && !parent) continue;
      // exact, or display contains the booked name, or booked name contains display.
      if (child && (disp === child || disp.indexOf(child) !== -1 || child.indexOf(disp) !== -1)) return r;
      if (parent && (disp === parent || disp.indexOf(parent) !== -1 || parent.indexOf(disp) !== -1)) return r;
    }
    return null;
  }

  // THE WAITING-ROOM DECISION. Given a joiner + the booked register, decide
  // whether the host should ADMIT, REMOVE, or hold (WAIT). Mirrors:
  //   - "Don't let people in unless they have booked!" => no match => REMOVE.
  //   - camera must be on => camera off => WAIT (ask to start video), and
  //     a matched-but-still-camera-off joiner cannot be admitted.
  // Returns { decision, reason, matched:Boolean, booking:Object|null }.
  function decideWaitingRoom(joiner, register) {
    var j = joiner || {};
    var booking = matchRegister(j, register);
    if (!booking) {
      return {
        decision: REMOVE,
        reason: "Not on the register — no booking matches this name. Do not admit.",
        matched: false,
        booking: null
      };
    }
    // Matched a booking. Camera policy: must be on to be admitted.
    if (j.cameraOn === false) {
      return {
        decision: WAIT,
        reason: "Booked, but camera is off. Ask to start video before admitting.",
        matched: true,
        booking: booking
      };
    }
    return {
      decision: ADMIT,
      reason: "Matched booking for " + (booking.childName || booking.parentName || "this attendee") + ". Safe to admit.",
      matched: true,
      booking: booking
    };
  }

  // Apply the host's action to a waiting-room session state. `state.admitted` is
  // the set of joiner ids currently in the room. We never admit a joiner the
  // policy says to REMOVE/WAIT, even if asked — defensive against mis-clicks.
  function applyAction(state, action, joiner, register) {
    var s = state && typeof state === "object" ? state : {};
    var admitted = Array.isArray(s.admitted) ? s.admitted.slice() : [];
    var id = joiner && joiner.id;
    if (!id) return { admitted: admitted, changed: false, blocked: true, reason: "joiner has no id" };

    function idx() { for (var i = 0; i < admitted.length; i++) { if (admitted[i] === id) return i; } return -1; }

    if (action === REMOVE) {
      var at = idx();
      if (at !== -1) admitted.splice(at, 1);
      return { admitted: admitted, changed: at !== -1, blocked: false, reason: "removed" };
    }
    if (action === ADMIT) {
      var verdict = decideWaitingRoom(joiner, register);
      if (verdict.decision !== ADMIT) {
        // Refuse to admit anyone the safeguarding policy blocks.
        return { admitted: admitted, changed: false, blocked: true, reason: verdict.reason };
      }
      if (idx() === -1) admitted.push(id);
      return { admitted: admitted, changed: true, blocked: false, reason: "admitted" };
    }
    return { admitted: admitted, changed: false, blocked: false, reason: "no-op" };
  }

  // Late-joiner detection: who is still in the waiting room (not yet admitted)
  // within the last LATE_JOINER_MIN minutes before / after start.
  function lateJoiners(joiners, state, startMs, nowMs) {
    var mb = minutesBefore(startMs, nowMs);
    if (mb === null || mb > LATE_JOINER_MIN) return []; // not in the late window yet
    var admitted = (state && Array.isArray(state.admitted)) ? state.admitted : [];
    var list = Array.isArray(joiners) ? joiners : [];
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var j = list[i];
      if (!j) continue;
      if (admitted.indexOf(j.id) === -1) out.push(j);
    }
    return out;
  }

  /* ===================================================================
     PERSISTENCE (HC.store, namespaced) — admitted set per session
     =================================================================== */

  function readAll() {
    try { var o = HC.store.get(STORE_KEY, {}); return (o && typeof o === "object") ? o : {}; }
    catch (e) { return {}; }
  }
  function writeAll(obj) {
    try { return HC.store.set(STORE_KEY, obj || {}); } catch (e) { return false; }
  }
  function readState(sessionId) {
    var all = readAll();
    var s = all[sessionId];
    return (s && typeof s === "object" && Array.isArray(s.admitted)) ? s : { admitted: [] };
  }
  function writeState(sessionId, state) {
    var all = readAll();
    all[sessionId] = { admitted: (state && Array.isArray(state.admitted)) ? state.admitted : [] };
    return writeAll(all);
  }

  /* ===================================================================
     LIVE-DATA SEED — an online camp + a booked register + waiting room
     =================================================================== */

  function looksOnline(p) {
    if (!p) return false;
    if (p.online === true || p.isOnline === true) return true;
    var hay = (asText(p.name) + " " + asText(p.kind) + " " + asText(p.venue) + " " +
      (Array.isArray(p.categories) ? p.categories.join(" ") : "")).toLowerCase();
    return /online|zoom|virtual|remote/.test(hay);
  }

  function seedSession() {
    var providers = [];
    try { providers = HC.data.providers || []; } catch (e) { providers = []; }

    var camp = null;
    for (var i = 0; i < providers.length; i++) { if (looksOnline(providers[i])) { camp = providers[i]; break; } }
    if (!camp) {
      camp = {
        id: "demo-online-coding",
        name: "E17 Online Coding Camp (Zoom)",
        kind: "Online coding club",
        categories: ["Online", "Coding"]
      };
    }

    var sessionId = "sess-" + (camp.id || "demo");

    // Booked register: the children whose parents booked this online session.
    var register = [
      { bookingId: "BK-201", childName: "Ava Bennett", parentName: "Sarah Bennett" },
      { bookingId: "BK-202", childName: "Noah Clarke", parentName: "James Clarke" },
      { bookingId: "BK-203", childName: "Priya Shah", parentName: "Anita Shah" },
      { bookingId: "BK-204", childName: "Leo Murphy", parentName: "Dana Murphy" }
    ];

    // Waiting room: a mix of matched booked joiners + a gate-crasher + a camera-off.
    var joiners = [
      { id: "J1", displayName: "Ava B.", cameraOn: true },     // matches Ava Bennett
      { id: "J2", displayName: "James Clarke", cameraOn: true },// parent of Noah -> matches
      { id: "J3", displayName: "Anita Shah", cameraOn: false }, // booked but camera off -> WAIT
      { id: "J4", displayName: "RandomUser99", cameraOn: true } // NOT booked -> REMOVE
    ];

    return { camp: camp, sessionId: sessionId, register: register, joiners: joiners };
  }

  /* ===================================================================
     UI
     =================================================================== */

  function esc(s) {
    return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
  function el(tag, attrs, html) {
    try { return HC.util.el(tag, attrs, html); }
    catch (e) { var n = document.createElement(tag || "div"); if (html != null) n.innerHTML = html; return n; }
  }
  function toast(m) { try { HC.util.toast(m); } catch (e) { /* noop */ } }

  function badge(text, bg, fg) {
    return '<span style="display:inline-block;font-size:10.5px;font-weight:700;padding:3px 9px;border-radius:999px;' +
      'background:' + bg + ';color:' + fg + ';text-transform:uppercase;letter-spacing:.3px">' + esc(text) + "</span>";
  }

  function render(mountEl) {
    if (!mountEl) return;
    try {
      mountEl.innerHTML = "";
      var seed = seedSession();

      // "Now" pinned so the demo is deterministic: 3 hrs before start (link still
      // withheld, edits still propagate). Start time 3 hrs out.
      var nowMs = Date.now();
      var startMs = nowMs + 3 * 60 * ONE_MIN_MS;
      var policy = linkPolicy(startMs, nowMs);

      var state = { admitted: [] }; // fresh demo room, not persisted unless host clicks

      var wrap = el("div", { style: "font-family:'Nunito Sans',system-ui,sans-serif;color:var(--text,#383838)" });

      wrap.appendChild(el("p", { style: "font-size:14px;margin:0 0 14px;line-height:1.55" },
        "Hosting an <strong>online</strong> holiday camp over Zoom? This is your safeguarding console. " +
        "The <strong>join link is withheld at booking</strong> and only released <strong>~" + LINK_RELEASE_MIN +
        " min before</strong> the session. Then you run a <strong>waiting room</strong>: admit only joiners " +
        "who match your booked register, and remove anyone who hasn't booked or won't turn their camera on."));

      // --- link policy panel ---
      var lp = el("div", {
        style: "background:#fff;border:1.5px solid var(--line,#E6E6E6);border-radius:14px;padding:14px 16px;margin:0 0 16px"
      });
      var relTxt = policy.linkReleased ? "released to attendees now" :
        "withheld — releases ~" + LINK_RELEASE_MIN + " min before start";
      lp.innerHTML =
        '<div style="font-family:\'Quicksand\',system-ui,sans-serif;font-weight:700;color:var(--purple,#603488);margin:0 0 8px">' +
          "🔒 Join-link policy</div>" +
        '<div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:8px">' +
          badge("Not in booking confirmation", "#FCE8F0", "#9a1f5e") +
          badge(policy.linkReleased ? "Link released" : "Link withheld",
            policy.linkReleased ? "#E1F0E4" : "#FFF8E1", policy.linkReleased ? "#2f7d4f" : "#7a5b00") +
          badge(policy.canEdit ? "Editable" : "Edit locked", "#F0E8F4", "#603488") +
        "</div>" +
        '<ul style="margin:0;padding-left:18px;font-size:13px;line-height:1.7">' +
          "<li><strong>At booking:</strong> confirmation sent, <em>no Zoom link</em> (status now: " + esc(relTxt) + ").</li>" +
          "<li><strong>" + LINK_PROPAGATE_MIN + " min before:</strong> last point a link edit auto-resends to attendees.</li>" +
          "<li><strong>" + LINK_CHANGE_MIN + " min before:</strong> last point you can change the link at all.</li>" +
          "<li><strong>~" + LINK_RELEASE_MIN + " min before:</strong> link + register auto-emailed to you and parents.</li>" +
          "<li><strong>" + LATE_JOINER_MIN + " min before:</strong> late-joiner follow-up list sent to the host.</li>" +
        "</ul>";
      wrap.appendChild(lp);

      // --- waiting room ---
      wrap.appendChild(el("div", { class: "hc-sidehead", style: "margin-top:4px" }, "Waiting room · admit / remove"));

      var room = el("div", {
        style: "background:#fff;border:1.5px solid var(--line,#E6E6E6);border-radius:14px;overflow:hidden"
      });

      function statusLine() {
        return '<div data-hc-room-status style="padding:9px 14px;background:var(--purple-tint,#F0E8F4);font-size:12.5px;' +
          'color:var(--purple,#603488);font-weight:700">In room: ' + state.admitted.length + " · waiting: " +
          (seed.joiners.length - state.admitted.length) + "</div>";
      }

      function rowFor(j) {
        var verdict = decideWaitingRoom(j, seed.register);
        var inRoom = state.admitted.indexOf(j.id) !== -1;
        var pill, pillBg, pillFg;
        if (inRoom) { pill = "In room"; pillBg = "#E1F0E4"; pillFg = "#2f7d4f"; }
        else if (verdict.decision === ADMIT) { pill = "Ready"; pillBg = "#E1F0E4"; pillFg = "#2f7d4f"; }
        else if (verdict.decision === WAIT) { pill = "Camera off"; pillBg = "#FFF8E1"; pillFg = "#7a5b00"; }
        else { pill = "Not booked"; pillBg = "#FCE8F0"; pillFg = "#9a1f5e"; }

        var row = el("div", {
          style: "display:flex;align-items:center;gap:10px;padding:11px 14px;border-top:1px solid var(--line,#E6E6E6)"
        });
        row.innerHTML =
          '<div style="flex:1">' +
            '<div style="font-family:\'Quicksand\',system-ui,sans-serif;font-weight:700;font-size:14px;color:var(--ink,#1A1A1A)">' +
              esc(j.displayName) + "</div>" +
            '<div style="font-size:11.5px;color:var(--muted,#808080)">' +
              (j.cameraOn ? "📷 camera on" : "🚫 camera off") +
              (verdict.matched ? " · booking " + esc(verdict.booking.bookingId) : " · no booking match") + "</div>" +
          "</div>" +
          badge(pill, pillBg, pillFg);

        var btns = el("div", { style: "display:flex;gap:6px;margin-left:8px" });
        var admitBtn = el("button", {
          class: "hc-btn",
          style: (verdict.decision === ADMIT && !inRoom) ? "" : "opacity:.4;cursor:not-allowed"
        }, inRoom ? "Admitted" : "Admit");
        admitBtn.addEventListener("click", function () {
          var res = applyAction(state, ADMIT, j, seed.register);
          if (res.blocked) { toast("Blocked: " + res.reason); return; }
          state.admitted = res.admitted;
          writeState(seed.sessionId, state);
          redraw();
          toast("Admitted " + j.displayName);
        });
        var removeBtn = el("button", { class: "hc-btn hc-btn-ghost" }, "Remove");
        removeBtn.addEventListener("click", function () {
          var res = applyAction(state, REMOVE, j, seed.register);
          state.admitted = res.admitted;
          writeState(seed.sessionId, state);
          redraw();
          toast("Removed " + j.displayName);
        });
        btns.appendChild(admitBtn);
        btns.appendChild(removeBtn);
        row.appendChild(btns);
        return row;
      }

      function redraw() {
        room.innerHTML = statusLine();
        for (var i = 0; i < seed.joiners.length; i++) room.appendChild(rowFor(seed.joiners[i]));
      }
      redraw();
      wrap.appendChild(room);

      wrap.appendChild(el("p", { style: "font-size:12px;color:var(--muted,#808080);margin:12px 0 0;line-height:1.5" },
        "Camera-off and not-booked joiners cannot be admitted — the console refuses the action. " +
        "This mirrors Happity's online-class safeguarding: don't let people in unless they've booked, " +
        "and keep cameras on."));

      mountEl.appendChild(wrap);
    } catch (e) {
      mountEl.innerHTML = '<p style="color:#9a1f5e">Safeguarding console failed to render: ' +
        esc(e && e.message ? e.message : String(e)) + "</p>";
    }
  }

  /* ===================================================================
     selfTest
     =================================================================== */

  function selfTest() {
    var pass = 0, fail = 0, log = [];
    function check(label, fn) {
      try { fn(); pass += 1; log.push("✓ " + label); }
      catch (e) { fail += 1; log.push("✗ " + label + " — " + (e && e.message ? e.message : String(e))); }
    }

    var HOUR = 60 * ONE_MIN_MS;
    var now = Date.now();

    var register = [
      { bookingId: "BK-1", childName: "Ava Bennett", parentName: "Sarah Bennett" },
      { bookingId: "BK-2", childName: "Noah Clarke", parentName: "James Clarke" }
    ];

    // ===== ACCEPTANCE CRITERION (part A): link withheld until shortly before ==
    check("ACCEPTANCE A: Zoom link is withheld at booking, released only ~60 min before start", function () {
      var start = now + 5 * HOUR;
      // At booking time (5 hrs before): link is NOT released, NOT in confirmation.
      var atBook = linkPolicy(start, now);
      HC.assert(atBook.linkReleased === false, "link must NOT be released 5 hrs before start");
      HC.assert(atBook.atBooking === true, "5 hrs before is the 'at booking' phase");
      HC.assert(atBook.linkInConfirmation === false, "link must never be in the booking confirmation");
      HC.assert(typeof atBook.releaseEtaMs === "number" && atBook.releaseEtaMs < start && atBook.releaseEtaMs > now,
        "release ETA must be before start and after now");
      HC.assert(Math.round((start - atBook.releaseEtaMs) / ONE_MIN_MS) === LINK_RELEASE_MIN,
        "release must be exactly " + LINK_RELEASE_MIN + " min before start");

      // 30 min before start: link IS now released.
      var soon = linkPolicy(start, start - 30 * ONE_MIN_MS);
      HC.assert(soon.linkReleased === true, "link must be released 30 min before start");
      HC.assert(soon.atBooking === false, "30 min before is no longer the booking phase");

      // exactly 60 min before: released boundary.
      var atLead = linkPolicy(start, start - LINK_RELEASE_MIN * ONE_MIN_MS);
      HC.assert(atLead.linkReleased === true, "link released at exactly 60 min before");
    });

    // ===== ACCEPTANCE CRITERION (part B): a waiting-room admit flow ==========
    check("ACCEPTANCE B: waiting-room admit flow — admit only booked + camera-on joiners", function () {
      // Booked + camera on => ADMIT.
      var ok = decideWaitingRoom({ id: "x", displayName: "Ava B.", cameraOn: true }, register);
      HC.assert(ok.decision === ADMIT, "booked, camera on => admit");
      HC.assert(ok.matched === true && ok.booking.bookingId === "BK-1", "should match Ava's booking");

      // Parent name match (parent joins under own name) => ADMIT.
      var parent = decideWaitingRoom({ id: "y", displayName: "James Clarke", cameraOn: true }, register);
      HC.assert(parent.decision === ADMIT, "parent name match => admit");
      HC.assert(parent.booking.bookingId === "BK-2", "James Clarke is Noah's parent (BK-2)");

      // Not booked => REMOVE (don't let people in unless they've booked).
      var crasher = decideWaitingRoom({ id: "z", displayName: "RandomUser99", cameraOn: true }, register);
      HC.assert(crasher.decision === REMOVE, "unbooked joiner => remove");
      HC.assert(crasher.matched === false, "crasher has no register match");

      // Booked but camera off => WAIT (cannot admit yet).
      var noCam = decideWaitingRoom({ id: "w", displayName: "Ava Bennett", cameraOn: false }, register);
      HC.assert(noCam.decision === WAIT, "booked but camera off => wait, not admit");
      HC.assert(noCam.matched === true, "still a matched booking");
    });

    // applyAction enforces the policy: cannot admit a non-booked joiner.
    check("Console refuses to admit a non-booked joiner even if asked", function () {
      var state = { admitted: [] };
      var crasher = { id: "C1", displayName: "Gatecrasher", cameraOn: true };
      var res = applyAction(state, ADMIT, crasher, register);
      HC.assert(res.blocked === true, "admit must be blocked for unbooked joiner");
      HC.assert(res.admitted.indexOf("C1") === -1, "crasher must not be in the room");
    });

    // applyAction enforces camera policy: cannot admit a camera-off joiner.
    check("Console refuses to admit a booked-but-camera-off joiner", function () {
      var state = { admitted: [] };
      var noCam = { id: "N1", displayName: "Ava Bennett", cameraOn: false };
      var res = applyAction(state, ADMIT, noCam, register);
      HC.assert(res.blocked === true, "admit blocked while camera off");
      HC.assert(res.admitted.length === 0, "no one admitted");
      // Turn camera on, retry => admitted.
      noCam.cameraOn = true;
      var res2 = applyAction(state, ADMIT, noCam, register);
      HC.assert(res2.blocked === false && res2.admitted.indexOf("N1") !== -1, "camera on => now admitted");
    });

    // admit then remove round-trip.
    check("Admit then remove updates the room set correctly", function () {
      var state = { admitted: [] };
      var j = { id: "A1", displayName: "Noah Clarke", cameraOn: true };
      var a = applyAction(state, ADMIT, j, register);
      HC.assert(a.admitted.indexOf("A1") !== -1, "admitted into room");
      var r = applyAction({ admitted: a.admitted }, REMOVE, j, register);
      HC.assert(r.admitted.indexOf("A1") === -1, "removed from room");
      HC.assert(r.changed === true, "remove reported a change");
    });

    // double-admit is idempotent (no duplicate id).
    check("Re-admitting an already-admitted joiner is idempotent", function () {
      var j = { id: "D1", displayName: "Ava Bennett", cameraOn: true };
      var s1 = applyAction({ admitted: [] }, ADMIT, j, register);
      var s2 = applyAction({ admitted: s1.admitted }, ADMIT, j, register);
      var count = s2.admitted.filter(function (x) { return x === "D1"; }).length;
      HC.assert(count === 1, "id should appear exactly once, got " + count);
    });

    // tolerant name matching: initials, punctuation, parent vs child.
    check("Register matching is tolerant of initials and punctuation", function () {
      HC.assert(matchRegister({ displayName: "Ava B." }, register) !== null, "'Ava B.' matches Ava Bennett");
      HC.assert(matchRegister({ displayName: "ava bennett" }, register) !== null, "lowercase matches");
      HC.assert(matchRegister({ displayName: "Sarah Bennett" }, register) !== null, "parent name matches");
      HC.assert(matchRegister({ displayName: "Zoe Nobody" }, register) === null, "unrelated name does not match");
      HC.assert(matchRegister({ displayName: "" }, register) === null, "empty display name never matches");
    });

    // link edit cutoffs: 90 min to edit, 120 min to auto-propagate.
    check("Link edit cutoffs: editable >=90 min, propagates >=120 min before", function () {
      var start = now;
      HC.assert(canEditLink(start + 150 * ONE_MIN_MS, now) === true, "150 min before => editable");
      HC.assert(canEditLink(start + 90 * ONE_MIN_MS, now) === true, "exactly 90 min => editable");
      HC.assert(canEditLink(start + 45 * ONE_MIN_MS, now) === false, "45 min before => locked");
      HC.assert(linkEditPropagates(start + 150 * ONE_MIN_MS, now) === true, "150 min => propagates");
      HC.assert(linkEditPropagates(start + 120 * ONE_MIN_MS, now) === true, "exactly 120 min => propagates");
      HC.assert(linkEditPropagates(start + 100 * ONE_MIN_MS, now) === false, "100 min => edit allowed but does not auto-resend");
      HC.assert(LINK_CHANGE_MIN === 90 && LINK_PROPAGATE_MIN === 120, "documented cutoffs");
    });

    // late joiners surface only in the last 5-min window, and only if unadmitted.
    check("Late-joiner list surfaces unadmitted joiners only inside the 5-min window", function () {
      var start = now + 3 * ONE_MIN_MS; // 3 min before start => inside window
      var joiners = [
        { id: "L1", displayName: "Ava Bennett", cameraOn: true },
        { id: "L2", displayName: "Noah Clarke", cameraOn: true }
      ];
      var state = { admitted: ["L1"] };
      var late = lateJoiners(joiners, state, start, now);
      HC.assert(late.length === 1 && late[0].id === "L2", "only the unadmitted joiner is flagged late");
      // Far from start => no late list yet.
      var early = lateJoiners(joiners, state, now + 2 * HOUR, now);
      HC.assert(early.length === 0, "no late list 2 hrs before start");
    });

    // Defensive: rubbish input must not throw and must fail safe (no admit).
    check("Defensive: bad input never throws and never admits", function () {
      var inputs = [null, undefined, {}, { displayName: 123 }, { displayName: "x", cameraOn: "yes" }];
      for (var i = 0; i < inputs.length; i++) {
        var v = decideWaitingRoom(inputs[i], register);
        HC.assert(v && typeof v === "object", "returns an object for bad input #" + i);
        // None of these match a real booking, so all must be REMOVE/WAIT (never ADMIT).
        HC.assert(v.decision !== ADMIT || v.matched === true, "bad input #" + i + " must not be wrongly admitted");
      }
      HC.assert(decideWaitingRoom({ id: "x", displayName: "Ava Bennett", cameraOn: true }, null).decision === REMOVE,
        "null register => no match => remove");
      HC.assert(linkPolicy(null, now).linkReleased === false, "no start time => link not released");
      HC.assert(linkPolicy(null, now).linkInConfirmation === false, "no start time => still never in confirmation");
      HC.assert(applyAction(null, ADMIT, null, register).blocked === true, "no joiner id => blocked");
    });

    // Live-data seed: an online camp + booked register + a realistic waiting room.
    check("Seed reachable: online camp, booked register, mixed waiting room classified", function () {
      var seed = seedSession();
      HC.assert(seed && seed.camp && Array.isArray(seed.register) && seed.register.length >= 1,
        "seed should yield a camp and a non-empty register");
      HC.assert(looksOnline(seed.camp) === true, "seed camp must be an online camp");
      var decisions = seed.joiners.map(function (j) { return decideWaitingRoom(j, seed.register).decision; });
      HC.assert(decisions.indexOf(ADMIT) !== -1, "at least one joiner should be admittable");
      HC.assert(decisions.indexOf(REMOVE) !== -1, "at least one gate-crasher should be removed");
      HC.assert(decisions.indexOf(WAIT) !== -1, "at least one camera-off joiner should wait");
    });

    // Persistence: the admitted set round-trips through HC.store (namespaced).
    check("Admitted set persists via HC.store (namespaced)", function () {
      var sid = "__safeguard_test__";
      writeState(sid, { admitted: ["J1", "J2"] });
      var back = readState(sid);
      HC.assert(back && Array.isArray(back.admitted) && back.admitted.length === 2, "admitted set should round-trip");
      HC.assert(back.admitted.indexOf("J1") !== -1 && back.admitted.indexOf("J2") !== -1, "ids should persist");
      // clean up probe key
      var all = readAll();
      delete all[sid];
      writeAll(all);
      var gone = readAll();
      HC.assert(!gone.__safeguard_test__, "probe key should be cleaned up");
    });

    return { pass: pass, fail: fail, log: log };
  }

  /* ===================================================================
     register
     =================================================================== */

  HC.registerFeature({
    id: "provider-online-safeguarding",
    title: "Online-class safeguarding",
    side: "provider",
    icon: "🛡️",
    summary: "Run online holiday camps safely: the Zoom link is withheld at booking and released only ~1hr before, then you run a waiting room — admitting only joiners who match your booked register, and removing anyone not booked or refusing to turn their camera on. Mirrors Happity's online-class safeguarding.",
    render: render,
    selfTest: selfTest
  });
})();
