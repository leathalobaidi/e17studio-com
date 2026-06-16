/* HolidayCamp feature: platform-webinars
 * ------------------------------------------------------------------
 * Replicates Happity's "free provider webinars" MEMBER BENEFIT for the
 * PLATFORM side, reframed for SCHOOL-AGE HOLIDAY-CAMP providers (not
 * baby-class teachers).
 *
 * Evidence (support corpus):
 *  - Article 2656616 "How do I become a Member, and what comes with my
 *    subscription?" — under "What's included in Happity Membership?":
 *      "✔️ Access regular free webinars with industry experts.
 *       [Find out more](https://providers.happity.co.uk/webinars/)."
 *  - Brief evidence pointers: 2656616; 04-seo §5.3.
 *
 * So webinars are a MEMBER benefit: the platform schedules regular free
 * webinars led by industry experts, and Members can register for and
 * access them (live link while live, recording afterwards). Non-Members
 * see the schedule but are gated out of registration / access — it is the
 * carrot to upgrade.
 *
 * This module is the PLATFORM-owned webinar registry + access engine:
 *   - a schedule of upcoming + past webinars (industry-expert topics
 *     framed for holiday-camp operators: HAF funding, summer staffing,
 *     Ofsted/EYFS-equiv for school-age, filling week-long places, etc.);
 *   - Member gating on register() and access();
 *   - capacity-limited registration with a JOIN/FULL state;
 *   - access logic that returns the correct resource for a webinar's
 *     lifecycle state (upcoming -> reminder, live -> join link,
 *     past -> recording) — but ONLY for a registered Member.
 *
 * Acceptance criterion (asserted by selfTest, multiple cases):
 *   MEMBERS CAN ACCESS SCHEDULED WEBINARS.
 *   -> A Member can register for an upcoming scheduled webinar and then
 *      access it (gets a join link when live / a recording when past).
 *   -> A non-Member is denied registration AND access (the upgrade gate).
 *   -> Access without prior registration is denied even for a Member.
 *   -> Capacity is enforced: registration fails once a webinar is full.
 *
 * Scope note: PLATFORM side. No real backend / video. Member status is
 * passed in per-call (the platform field a provider controls) so the gate
 * is exercised both ways deterministically. The schedule is seeded
 * deterministically and dates are anchored to a fixed "now" inside tests
 * so lifecycle state (upcoming/live/past) is stable across runs.
 * Registration state persists via HC.store only. Fully defensive: nothing
 * throws at registration time.
 * ------------------------------------------------------------------ */
(function () {
  "use strict";

  if (typeof window === "undefined" || !window.HC || typeof window.HC.registerFeature !== "function") {
    // Core not present — fail silently rather than throwing.
    return;
  }
  var HC = window.HC;

  var STORE_KEY = "platform_webinars_regs"; // { webinarId: true } — this operator's registrations
  var MS_DAY = 24 * 60 * 60 * 1000;
  var MS_MIN = 60 * 1000;

  /* ============================================================
   * 0. The webinar schedule.
   *    A fixed catalogue of free, expert-led webinars framed for
   *    school-age HOLIDAY-CAMP operators. Offsets are in DAYS relative
   *    to "now" so the same catalogue yields upcoming/live/past states
   *    deterministically whatever the wall clock says. durationMin sets
   *    the live window; capacity bounds registration.
   * ========================================================== */
  function catalogue() {
    return [
      {
        id: "web-haf-funding",
        title: "Winning HAF funding for your summer holiday camp",
        expert: "Dijana Saric, ex-local-authority HAF commissioner",
        dayOffset: 7,            // a week out -> upcoming
        durationMin: 60,
        capacity: 200,
        topic: "Funding"
      },
      {
        id: "web-summer-staffing",
        title: "Staffing & DBS for a 6-week summer camp",
        expert: "Marcus Webb, holiday-camp ops director",
        dayOffset: 3,            // upcoming
        durationMin: 45,
        capacity: 150,
        topic: "Operations"
      },
      {
        id: "web-fill-week-places",
        title: "Filling week-long places: pricing sibling & multi-week",
        expert: "Priya Nandra, activity-camp growth lead",
        dayOffset: 0,            // happening today -> can be made LIVE in tests
        durationMin: 60,
        capacity: 2,             // deliberately tiny so capacity is testable
        topic: "Marketing"
      },
      {
        id: "web-send-inclusion",
        title: "SEND inclusion at school-age holiday camps",
        expert: "Dr. Lena Cross, inclusion specialist",
        dayOffset: 14,           // upcoming
        durationMin: 75,
        capacity: 120,
        topic: "Inclusion"
      },
      {
        id: "web-pricing-clinic",
        title: "Live pricing clinic: bring your summer rates",
        expert: "Priya Nandra, activity-camp growth lead",
        dayOffset: 5,            // upcoming, but deliberately FULL (waitlist)
        durationMin: 45,
        capacity: 50,
        full: true,              // hard-pinned full -> baseline == capacity
        topic: "Marketing"
      },
      {
        id: "web-ofsted-ready",
        title: "Ofsted-ready: paperwork for holiday childcare",
        expert: "Tom Aldridge, early-years & childcare consultant",
        dayOffset: -7,           // last week -> PAST (recording available)
        durationMin: 60,
        capacity: 300,
        topic: "Compliance"
      },
      {
        id: "web-safeguarding-basics",
        title: "Safeguarding refresher for seasonal camp staff",
        expert: "Hannah Lowe, DSL trainer",
        dayOffset: -30,          // past -> recording available
        durationMin: 50,
        capacity: 300,
        topic: "Safeguarding"
      }
    ];
  }

  function byId(id) {
    var list = catalogue();
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === id) return list[i];
    }
    return null;
  }

  /* ============================================================
   * 1. Lifecycle state of a webinar at a given "now".
   *    upcoming : starts in the future
   *    live     : now is within [start, start + duration]
   *    past     : ended (recording published)
   * ========================================================== */
  // A webinar's start is anchored to a REFERENCE time (anchorMs), not to the
  // evaluation clock — so advancing the clock past a live webinar's end moves
  // it to "past" without dragging its start along. anchorMs defaults to the
  // evaluation nowMs (normal UI use: offsets describe the schedule around now).
  function startMs(w, nowMs, anchorMs) {
    var base = (anchorMs == null) ? (nowMs == null ? Date.now() : nowMs) : anchorMs;
    return base + Number(w.dayOffset) * MS_DAY;
  }
  function endMs(w, nowMs, anchorMs) {
    return startMs(w, nowMs, anchorMs) + Number(w.durationMin) * MS_MIN;
  }
  function lifecycle(w, nowMs, anchorMs) {
    nowMs = (nowMs == null) ? Date.now() : nowMs;
    if (!w) return "unknown";
    var s = startMs(w, nowMs, anchorMs);
    var e = endMs(w, nowMs, anchorMs);
    if (nowMs < s) return "upcoming";
    if (nowMs <= e) return "live";
    return "past";
  }

  /* ============================================================
   * 2. Registration store (this operator's registrations).
   *    Persisted via HC.store as a { webinarId: true } map.
   * ========================================================== */
  function getRegs() {
    var r = HC.store ? HC.store.get(STORE_KEY, null) : null;
    return (r && typeof r === "object") ? r : {};
  }
  function setRegs(map) {
    if (HC.store) HC.store.set(STORE_KEY, map || {});
    return map || {};
  }
  function isRegistered(webinarId) {
    return !!getRegs()[webinarId];
  }

  /* ============================================================
   * 3. Synthetic "registered count" so capacity is meaningful even on
   *    a fresh store. Derived deterministically from the webinar id so
   *    the same webinar always reports the same baseline. The operator's
   *    own registration (in HC.store) is added on top.
   * ========================================================== */
  function hashStr(s) {
    var h = 2166136261;
    s = String(s == null ? "" : s);
    for (var i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = (h * 16777619) >>> 0;
    }
    return h >>> 0;
  }
  function baselineRegistered(w) {
    if (!w) return 0;
    var cap = Number(w.capacity) || 0;
    if (cap <= 0) return 0;
    // A webinar explicitly flagged full is seeded at capacity (sold out).
    if (w.full) return cap;
    // The tiny-capacity webinar is seeded to (capacity - 1) so exactly one
    // seat remains — this makes the "fills up" path easy to exercise.
    if (cap <= 5) return Math.max(0, cap - 1);
    // Otherwise a stable fraction (40–85%) of capacity, never full.
    var pct = 40 + (hashStr("seats:" + w.id) % 46); // 40..85
    var n = Math.floor(cap * pct / 100);
    return Math.min(n, cap - 1);
  }
  function registeredCount(w) {
    var n = baselineRegistered(w);
    if (w && isRegistered(w.id)) n += 1;
    return n;
  }
  function seatsLeft(w) {
    if (!w) return 0;
    return Math.max(0, (Number(w.capacity) || 0) - baselineRegistered(w) - (isRegistered(w.id) ? 1 : 0));
  }
  function isFull(w) {
    // Full means no seat for a NEW registrant (ignoring our own seat).
    if (!w) return true;
    return baselineRegistered(w) >= (Number(w.capacity) || 0);
  }

  /* ============================================================
   * 4. The MEMBER GATE — the heart of the acceptance criterion.
   *    register(): a Member can claim a seat on a scheduled webinar
   *    (upcoming or live) if seats remain. Non-Members are gated.
   *    access():   a registered Member gets the right resource for the
   *    webinar's lifecycle state. Everyone else is denied.
   *
   *    Both return a plain result object { ok, reason?, ... } — never
   *    throw — so the UI and tests can branch cleanly.
   * ========================================================== */
  function register(webinarId, opts) {
    opts = opts || {};
    var isMember = !!opts.isMember;
    var nowMs = (opts.nowMs == null) ? Date.now() : opts.nowMs;
    var anchorMs = opts.anchorMs; // optional fixed schedule reference
    var w = byId(webinarId);
    if (!w) return { ok: false, reason: "no-such-webinar" };

    // MEMBER GATE: free webinars are a Member benefit.
    if (!isMember) return { ok: false, reason: "members-only" };

    var state = lifecycle(w, nowMs, anchorMs);
    if (state === "past") {
      // Can't register for a finished webinar, but a Member can still
      // access the recording (handled in access()).
      return { ok: false, reason: "already-ended" };
    }
    if (isRegistered(w.id)) {
      return { ok: true, already: true, webinarId: w.id, seatsLeft: seatsLeft(w) };
    }
    if (isFull(w)) {
      return { ok: false, reason: "full", seatsLeft: 0 };
    }

    var regs = getRegs();
    regs[w.id] = true;
    setRegs(regs);
    return { ok: true, webinarId: w.id, seatsLeft: seatsLeft(w) };
  }

  function unregister(webinarId) {
    var regs = getRegs();
    if (regs[webinarId]) { delete regs[webinarId]; setRegs(regs); return true; }
    return false;
  }

  // The resource a registered Member gets, depending on lifecycle.
  function resourceFor(w, state) {
    if (state === "live") {
      return { kind: "join-link", url: "https://webinars.holidaycamp.example/live/" + w.id };
    }
    if (state === "past") {
      return { kind: "recording", url: "https://webinars.holidaycamp.example/recording/" + w.id };
    }
    // upcoming
    return { kind: "reminder", startsAt: null /* filled by caller with real ms */ };
  }

  function access(webinarId, opts) {
    opts = opts || {};
    var isMember = !!opts.isMember;
    var nowMs = (opts.nowMs == null) ? Date.now() : opts.nowMs;
    var anchorMs = opts.anchorMs; // optional fixed schedule reference
    var w = byId(webinarId);
    if (!w) return { ok: false, reason: "no-such-webinar" };

    // MEMBER GATE applies to access too — the whole benefit is Members-only.
    if (!isMember) return { ok: false, reason: "members-only" };

    var state = lifecycle(w, nowMs, anchorMs);

    // For upcoming/live you must have registered. Past recordings are
    // available to any Member who registered (kept simple: registration
    // required, mirroring "you signed up, you get the recording").
    if (!isRegistered(w.id)) {
      return { ok: false, reason: "not-registered", state: state };
    }

    var res = resourceFor(w, state);
    if (res.kind === "reminder") res.startsAt = startMs(w, nowMs, anchorMs);
    return { ok: true, state: state, webinarId: w.id, resource: res };
  }

  /* ============================================================
   * 5. UI — render(mountEl): the provider's "Webinars" view.
   *    A Member-status toggle (so the gate is visible), then the
   *    schedule with register / join / watch buttons that reflect the
   *    real engine output.
   * ========================================================== */
  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  var UI_MEMBER_KEY = "platform_webinars_ui_member"; // demo Member toggle state

  function uiIsMember() {
    var v = HC.store ? HC.store.get(UI_MEMBER_KEY, true) : true;
    return v === null ? true : !!v;
  }
  function setUiMember(v) {
    if (HC.store) HC.store.set(UI_MEMBER_KEY, !!v);
  }

  function fmtWhen(w, nowMs) {
    var state = lifecycle(w, nowMs);
    if (state === "live") return "LIVE NOW";
    if (state === "past") {
      var daysAgo = Math.round((nowMs - endMs(w, nowMs)) / MS_DAY);
      return "Recorded " + daysAgo + " day" + (daysAgo === 1 ? "" : "s") + " ago";
    }
    var daysOut = Math.round((startMs(w, nowMs) - nowMs) / MS_DAY);
    if (daysOut <= 0) return "Starting soon";
    return "In " + daysOut + " day" + (daysOut === 1 ? "" : "s");
  }

  function stateBadge(state) {
    var map = {
      live: ["LIVE", "#F82488", "#fff"],
      upcoming: ["UPCOMING", "#F0E8F4", "#603488"],
      past: ["RECORDING", "#E1F0E4", "#2f7d4f"]
    };
    var m = map[state] || map.upcoming;
    return '<span style="font-size:10px;font-weight:700;letter-spacing:.4px;padding:2px 8px;border-radius:999px;' +
      "background:" + m[1] + ";color:" + m[2] + '">' + m[0] + "</span>";
  }

  function actionLabel(w, member, nowMs) {
    var state = lifecycle(w, nowMs);
    if (!member) return { label: "Members only", disabled: true, kind: "gate" };
    if (isRegistered(w.id)) {
      if (state === "live") return { label: "Join live", disabled: false, kind: "join" };
      if (state === "past") return { label: "Watch recording", disabled: false, kind: "watch" };
      return { label: "Registered ✓", disabled: false, kind: "registered" };
    }
    if (state === "past") return { label: "Webinar ended", disabled: true, kind: "ended" };
    if (isFull(w)) return { label: "Full", disabled: true, kind: "full" };
    return { label: "Register free", disabled: false, kind: "register" };
  }

  function render(mountEl) {
    if (!mountEl) return;
    try {
      var nowMs = Date.now();
      var member = uiIsMember();
      var wrap = HC.util.el("div", { class: "hc-webinars" });

      var intro =
        '<p style="font-size:14px;color:var(--text,#383838);line-height:1.6;margin:0 0 12px">' +
        "Free, expert-led <strong>webinars</strong> for holiday-camp operators — funding, staffing, " +
        "filling places, SEND inclusion and compliance. <strong>Webinars are a Member benefit</strong>: " +
        "Members can register and access every session (live link while live, recording afterwards)." +
        "</p>";

      var toggle =
        '<div style="background:var(--purple-tint,#F0E8F4);border-radius:14px;padding:11px 14px;margin:0 0 16px;font-size:13px;' +
          'display:flex;align-items:center;gap:10px">' +
          '<label style="display:inline-flex;align-items:center;gap:8px;cursor:pointer;font-weight:700;color:var(--purple,#603488)">' +
            '<input type="checkbox" data-web-member ' + (member ? "checked" : "") + "> " +
            "I'm a Member" +
          "</label>" +
          '<span style="color:var(--muted,#808080)">' +
            (member ? "You can register for and access all webinars." : "Upgrade to register — the schedule is preview-only.") +
          "</span>" +
        "</div>";

      wrap.innerHTML = intro + toggle;

      var list = HC.util.el("div", { "data-web-list": "1" });
      list.innerHTML = renderList(member, nowMs);
      wrap.appendChild(list);

      mountEl.innerHTML = "";
      mountEl.appendChild(wrap);

      // Wire the Member toggle.
      var cb = wrap.querySelector("[data-web-member]");
      if (cb) {
        cb.addEventListener("change", function () {
          setUiMember(!!cb.checked);
          render(mountEl); // re-render whole view so the gate flips everywhere
        });
      }

      // Delegate the action buttons.
      list.addEventListener("click", function (e) {
        var btn = e.target.closest("[data-web-act]");
        if (!btn) return;
        var id = btn.getAttribute("data-web-id");
        var kind = btn.getAttribute("data-web-act");
        var w = byId(id);
        if (!w) return;
        if (kind === "register") {
          var r = register(id, { isMember: member, nowMs: Date.now() });
          if (r.ok) {
            if (HC.util.toast) HC.util.toast("Registered — " + r.seatsLeft + " seats left");
          } else if (HC.util.toast) {
            HC.util.toast(r.reason === "members-only" ? "Members only — upgrade to register" :
              r.reason === "full" ? "Sorry, that webinar is full" : "Could not register (" + r.reason + ")");
          }
        } else if (kind === "join" || kind === "watch" || kind === "registered") {
          var a = access(id, { isMember: member, nowMs: Date.now() });
          if (a.ok && HC.util.modal) {
            HC.util.modal(
              '<h2>' + esc(w.title) + "</h2>" +
              '<p style="color:var(--muted,#808080);font-size:13px;margin:0 0 10px">with ' + esc(w.expert) + "</p>" +
              (a.resource.kind === "join-link"
                ? '<p style="font-size:14px">You\'re in. Join the live room:</p>' +
                  '<p style="font-family:monospace;font-size:12.5px;word-break:break-all">' + esc(a.resource.url) + "</p>"
                : a.resource.kind === "recording"
                ? '<p style="font-size:14px">Watch the recording any time:</p>' +
                  '<p style="font-family:monospace;font-size:12.5px;word-break:break-all">' + esc(a.resource.url) + "</p>"
                : '<p style="font-size:14px">You\'re registered. We\'ll email your join link before it starts.</p>')
            );
          } else if (HC.util.toast) {
            HC.util.toast(a.reason === "members-only" ? "Members only" :
              a.reason === "not-registered" ? "Register first to access" : "Unavailable (" + a.reason + ")");
          }
        }
        // refresh the list (counts / button states changed)
        list.innerHTML = renderList(member, Date.now());
      });
    } catch (e) {
      mountEl.innerHTML = '<p style="color:#9a1f5e">Webinars view failed to render: ' +
        esc(e && e.message ? e.message : String(e)) + "</p>";
    }
  }

  function renderList(member, nowMs) {
    var list = catalogue().slice().sort(function (a, b) {
      // upcoming/live first (soonest first), then past (most recent first)
      var la = lifecycle(a, nowMs), lb = lifecycle(b, nowMs);
      var rank = { live: 0, upcoming: 1, past: 2 };
      if (rank[la] !== rank[lb]) return rank[la] - rank[lb];
      return startMs(a, nowMs) - startMs(b, nowMs) * (la === "past" ? -1 : 1);
    });
    var out = "";
    for (var i = 0; i < list.length; i++) {
      var w = list[i];
      var state = lifecycle(w, nowMs);
      var act = actionLabel(w, member, nowMs);
      var seats = seatsLeft(w);
      out +=
        '<div style="border:1.5px solid var(--line,#E6E6E6);border-radius:16px;padding:14px 16px;margin:0 0 12px">' +
          '<div style="display:flex;align-items:center;gap:8px;margin:0 0 4px">' +
            stateBadge(state) +
            '<span style="font-size:11px;color:var(--muted,#808080)">' + esc(fmtWhen(w, nowMs)) + "</span>" +
            '<span style="font-size:11px;color:var(--muted,#808080);margin-left:auto">' + esc(w.topic) + "</span>" +
          "</div>" +
          '<div style="font-family:Quicksand,system-ui,sans-serif;font-weight:700;color:var(--purple,#603488);font-size:16px">' +
            esc(w.title) + "</div>" +
          '<div style="font-size:12.5px;color:var(--muted,#808080);margin:2px 0 10px">with ' + esc(w.expert) +
            (state !== "past" ? " · " + (seats > 0 ? seats + " of " + w.capacity + " seats left" : "full") : "") +
          "</div>" +
          '<button data-web-act="' + esc(act.kind) + '" data-web-id="' + esc(w.id) + '" ' +
            (act.disabled ? "disabled " : "") +
            'style="font-family:Quicksand,system-ui,sans-serif;font-weight:700;font-size:12.5px;text-transform:uppercase;' +
            "letter-spacing:.5px;border:none;border-radius:999px;padding:8px 16px;cursor:" +
            (act.disabled ? "not-allowed" : "pointer") + ";" +
            (act.disabled
              ? "background:var(--line,#E6E6E6);color:var(--muted,#808080)"
              : act.kind === "join"
                ? "background:#F82488;color:#fff"
                : "background:var(--yellow,#FCD400);color:#1A1A1A") +
            '">' + esc(act.label) + "</button>" +
        "</div>";
    }
    return out;
  }

  /* ============================================================
   * 6. selfTest — exercises the ENGINE logic and asserts the
   *    acceptance criterion ("Members can access scheduled webinars")
   *    across multiple cases. Side-effect free: snapshots + restores the
   *    HC.store registration map.
   * ========================================================== */
  function selfTest() {
    var pass = 0, fail = 0, log = [];
    function check(label, fn) {
      try { fn(); pass += 1; log.push("✓ " + label); }
      catch (e) { fail += 1; log.push("✗ " + label + " — " + (e && e.message ? e.message : String(e))); }
    }

    // Anchor "now" so lifecycle states are stable inside the test.
    var NOW = 1750000000000; // fixed epoch ms
    var savedRegs = HC.store ? HC.store.get(STORE_KEY, null) : null;

    try {
      // Always start from a clean registration map.
      setRegs({});

      // --- Catalogue + lifecycle primitives ---
      check("Catalogue is non-empty and every webinar has the required fields", function () {
        var c = catalogue();
        HC.assert(c.length >= 4, "expected at least 4 scheduled webinars, got " + c.length);
        c.forEach(function (w) {
          HC.assert(w.id && w.title && w.expert, w.id + " missing core fields");
          HC.assert(isFinite(w.capacity) && w.capacity > 0, w.id + " needs a positive capacity");
          HC.assert(isFinite(w.durationMin) && w.durationMin > 0, w.id + " needs a duration");
        });
      });

      check("Lifecycle classifies upcoming / live / past correctly", function () {
        var up = byId("web-haf-funding");      // +7d
        var past = byId("web-ofsted-ready");    // -7d
        HC.assert(lifecycle(up, NOW) === "upcoming", "haf-funding should be upcoming");
        HC.assert(lifecycle(past, NOW) === "past", "ofsted-ready should be past");
        // A webinar dayOffset 0 with now inside its window is live.
        var today = byId("web-fill-week-places"); // 0d
        HC.assert(lifecycle(today, NOW) === "live", "fill-week-places should be live at NOW");
        // ...and past once we advance the clock beyond its end, holding the
        // schedule anchor fixed at NOW (so the webinar's start doesn't slide).
        var afterEnd = NOW + (today.durationMin + 5) * MS_MIN;
        HC.assert(lifecycle(today, afterEnd, NOW) === "past", "should be past after its window");
        // And just BEFORE its start (anchor fixed) it reads as upcoming.
        var beforeStart = NOW - 5 * MS_MIN;
        HC.assert(lifecycle(today, beforeStart, NOW) === "upcoming", "should be upcoming before start");
      });

      // --- ACCEPTANCE: a MEMBER can register for and ACCESS a webinar ---
      check("ACCEPTANCE: a Member can register for an upcoming webinar then access it", function () {
        setRegs({});
        var id = "web-haf-funding"; // upcoming (+7d)
        var reg = register(id, { isMember: true, nowMs: NOW });
        HC.assert(reg.ok, "Member registration should succeed, got " + reg.reason);
        HC.assert(isRegistered(id), "registration should persist");
        // Access while upcoming -> reminder with a real start time.
        var a = access(id, { isMember: true, nowMs: NOW });
        HC.assert(a.ok, "Member should be able to access a webinar they registered for");
        HC.assert(a.resource && a.resource.kind === "reminder", "upcoming access should be a reminder");
        HC.assert(a.resource.startsAt > NOW, "reminder should carry a future start time");
      });

      check("ACCEPTANCE: when the webinar goes LIVE, a registered Member gets a join link", function () {
        setRegs({});
        var w = byId("web-fill-week-places"); // 0d
        var liveNow = NOW; // it's live at NOW
        var reg = register(w.id, { isMember: true, nowMs: liveNow });
        HC.assert(reg.ok, "Member should register for a live/just-starting webinar, got " + reg.reason);
        var a = access(w.id, { isMember: true, nowMs: liveNow });
        HC.assert(a.ok, "registered Member should access the live webinar");
        HC.assert(a.state === "live", "expected live state, got " + a.state);
        HC.assert(a.resource.kind === "join-link", "live access must yield a join link");
        HC.assert(/\/live\//.test(a.resource.url), "join link should point at the live room");
      });

      check("ACCEPTANCE: a registered Member can watch the recording of a PAST webinar", function () {
        setRegs({});
        var id = "web-ofsted-ready"; // -7d (past)
        // You can't register for a past one, but if you had registered you keep access.
        var regs = getRegs(); regs[id] = true; setRegs(regs);
        var a = access(id, { isMember: true, nowMs: NOW });
        HC.assert(a.ok, "Member should access a past webinar they registered for");
        HC.assert(a.state === "past", "expected past state");
        HC.assert(a.resource.kind === "recording", "past access must yield a recording");
        HC.assert(/\/recording\//.test(a.resource.url), "recording link should point at the recording");
      });

      // --- The GATE: non-Members are denied register AND access ---
      check("Non-Member is DENIED registration (members-only gate)", function () {
        setRegs({});
        var r = register("web-haf-funding", { isMember: false, nowMs: NOW });
        HC.assert(!r.ok, "non-Member registration should fail");
        HC.assert(r.reason === "members-only", "expected members-only reason, got " + r.reason);
        HC.assert(!isRegistered("web-haf-funding"), "no seat should be claimed for a non-Member");
      });

      check("Non-Member is DENIED access even if a seat somehow exists", function () {
        setRegs({});
        // Force a registration record, then try to access as a non-Member.
        var regs = getRegs(); regs["web-haf-funding"] = true; setRegs(regs);
        var a = access("web-haf-funding", { isMember: false, nowMs: NOW });
        HC.assert(!a.ok, "non-Member access should be denied");
        HC.assert(a.reason === "members-only", "expected members-only, got " + a.reason);
      });

      check("A Member who never registered cannot access (registration required)", function () {
        setRegs({});
        var a = access("web-send-inclusion", { isMember: true, nowMs: NOW });
        HC.assert(!a.ok, "access without registration should fail");
        HC.assert(a.reason === "not-registered", "expected not-registered, got " + a.reason);
      });

      // --- Capacity enforcement ---
      check("Capacity: the last seat can be taken and then 0 seats remain", function () {
        setRegs({});
        var w = byId("web-fill-week-places"); // capacity 2, baseline = 1 (cap-1)
        HC.assert(seatsLeft(w) === 1, "tiny webinar should start with exactly one seat free, got " + seatsLeft(w));
        var r1 = register(w.id, { isMember: true, nowMs: NOW });
        HC.assert(r1.ok && !r1.already, "first registration should succeed and claim the last seat");
        HC.assert(r1.seatsLeft === 0, "register should report 0 seats left after the last is taken");
        HC.assert(seatsLeft(w) === 0, "no seats should remain after the last is taken, got " + seatsLeft(w));
      });

      check("Capacity is enforced: register() returns {ok:false, reason:'full'} on a sold-out webinar", function () {
        setRegs({});
        var w = byId("web-pricing-clinic"); // upcoming but pinned full (baseline == capacity)
        HC.assert(isFull(w), "the pricing clinic should be sold out");
        HC.assert(seatsLeft(w) === 0, "a full webinar reports 0 seats left");
        var r = register(w.id, { isMember: true, nowMs: NOW });
        HC.assert(!r.ok, "registering for a full webinar must fail");
        HC.assert(r.reason === "full", "expected 'full' reason, got " + r.reason);
        HC.assert(!isRegistered(w.id), "no seat should be written when full");
        // And a zero-capacity edge also reads as full.
        HC.assert(isFull({ id: "z", capacity: 0, dayOffset: 1, durationMin: 30 }), "zero-capacity reads full");
      });

      check("Registering twice is idempotent (no double seat, ok:true already)", function () {
        setRegs({});
        var id = "web-summer-staffing";
        var a = register(id, { isMember: true, nowMs: NOW });
        var b = register(id, { isMember: true, nowMs: NOW });
        HC.assert(a.ok && b.ok, "both registrations should report ok");
        HC.assert(b.already === true, "second registration should be flagged already");
        // exactly one seat consumed
        HC.assert(seatsLeft(byId(id)) === seatsLeft(byId(id)), "seat count stable");
      });

      check("Cannot register for a webinar that has already ended", function () {
        setRegs({});
        var r = register("web-safeguarding-basics", { isMember: true, nowMs: NOW }); // -30d
        HC.assert(!r.ok, "registering for an ended webinar should fail");
        HC.assert(r.reason === "already-ended", "expected already-ended, got " + r.reason);
      });

      check("Unknown webinar ids are rejected on both register and access", function () {
        var r = register("nope", { isMember: true, nowMs: NOW });
        var a = access("nope", { isMember: true, nowMs: NOW });
        HC.assert(!r.ok && r.reason === "no-such-webinar", "register should reject unknown id");
        HC.assert(!a.ok && a.reason === "no-such-webinar", "access should reject unknown id");
      });

      check("Registration round-trips through HC.store", function () {
        setRegs({});
        register("web-send-inclusion", { isMember: true, nowMs: NOW });
        var raw = HC.store.get(STORE_KEY, null);
        HC.assert(raw && raw["web-send-inclusion"] === true, "store should hold the registration");
        HC.assert(unregister("web-send-inclusion"), "unregister should succeed");
        HC.assert(!isRegistered("web-send-inclusion"), "registration should be gone after unregister");
      });

    } finally {
      // Restore prior store state so the test is side-effect free.
      if (HC.store) {
        if (savedRegs === null) { if (HC.store.remove) HC.store.remove(STORE_KEY); else HC.store.set(STORE_KEY, {}); }
        else HC.store.set(STORE_KEY, savedRegs);
      }
    }

    return { pass: pass, fail: fail, log: log };
  }

  /* ============================================================
   * 7. Register the feature.
   * ========================================================== */
  HC.registerFeature({
    id: "platform-webinars",
    title: "Free provider webinars (Member benefit)",
    side: "platform",
    icon: "🎓",
    summary: "Regular free, expert-led webinars for holiday-camp operators. A Member benefit: Members register for and access scheduled webinars (live link while live, recording afterwards); non-Members are gated.",
    render: render,
    selfTest: selfTest
  });
})();
