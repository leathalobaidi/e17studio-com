/* HolidayCamp feature — provider-referrals
 *
 * Provider referral programme — "Give £10, get £10"  (PROVIDER side)
 *
 * Replicates Happity's provider referral programme (support articles
 * 4784863 "Give £10, get £10 - how to use referrals" and 6728942 "Give £10,
 * Get £10 - referral programme Terms & Conditions"). Evidence:
 *   - "Invite new providers to join our community and - when they register
 *      using your unique link - we'll give you both £10 in Happity credit."
 *      -> a UNIQUE LINK per provider; an approved referral CREDITS BOTH PARTIES.
 *   - "Grab your unique link from the widget which appears" -> each provider
 *      sees their own referral link.
 *   - "When someone registers ... using your link, we will credit £10 to your
 *      account, and £10 to theirs as well." -> give £10 / get £10.
 *   - T&C 02: "Unlimited referrals can be made by any registered provider."
 *   - T&C 03: "Following a SUCCESSFUL referral (the person is eligible ... and
 *      their registration is APPROVED) - a £10 credit will be added to both the
 *      ... account of the referrer and referee." -> credit only on APPROVAL.
 *   - T&C 08: "To count as a referral, the provider needs to be a COMPLETELY
 *      NEW REGISTRATION (not a lapsed user) ... and approved as eligible."
 *      -> existing/lapsed providers and duplicates do NOT qualify.
 *   - T&C 05: "Credit can be used towards Membership payments ... and Featured
 *      Listings." T&C 06: "Credit will expire after 12 months." T&C 07: credit
 *      is "not transferable into cash."
 *
 * Framed for SCHOOL-AGE HOLIDAY CAMPS: the "you" is a holiday-camp provider in
 * the E17 directory. You grab your unique referral link, share it with other
 * camp operators (sports clubs, drama schools, forest-school runners). When one
 * registers a NEW holiday-camp business with your link and the platform APPROVES
 * them, you both get £10 credit toward Membership / Featured Listings. Pending
 * and rejected referrals award nothing; duplicates and already-registered camps
 * don't qualify.
 *
 * ACCEPTANCE CRITERION (exercised by selfTest):
 *   Each provider gets a unique referral link; an approved referral credits
 *   both parties.
 *
 * Self-contained, defensive, no imports/exports. Calls HC.registerFeature.
 */
(function () {
  "use strict";

  // Defensive: never throw at module load if HC isn't present.
  if (typeof window === "undefined" || !window.HC || typeof window.HC.registerFeature !== "function") {
    if (typeof console !== "undefined" && console.warn) {
      console.warn("[HC] provider-referrals: HC core not found; skipping registration.");
    }
    return;
  }

  var HC = window.HC;

  var STORE_KEY = "provider_referrals_state";

  // Programme constants (mirrors Happity's "Give £10, get £10").
  var CREDIT_GIVE = 10;          // credited to the referrer on approval
  var CREDIT_GET = 10;           // credited to the referee on approval
  var CREDIT_EXPIRY_MONTHS = 12; // T&C 06: credit expires after 12 months
  var LINK_BASE = "https://holidaycamp.app/r/"; // mock referral URL base

  // Referral lifecycle states.
  //   pending  — referee used the link / submitted a registration, awaiting review
  //   approved — eligible NEW registration, approved -> both parties credited
  //   rejected — not eligible (lapsed/existing, wrong type, declined)
  var STATUS = { PENDING: "pending", APPROVED: "approved", REJECTED: "rejected" };

  /* ============================================================ *
   *  PURE LOGIC (testable, DOM-free)                              *
   *  Functions take a state and return a NEW state — never mutate *
   *  in place, so tests run against fresh literals.               *
   * ============================================================ */

  // State shape:
  //   {
  //     providerId, providerName,
  //     code,                 // this provider's unique referral code (stable)
  //     joined: Boolean,      // has the provider "Joined" the programme?
  //     referrals: [ {
  //        id, code,          // the referrer code the referee used
  //        refereeName, refereeEmail,
  //        status,            // pending | approved | rejected
  //        isNewBusiness,     // T&C 08: completely new registration?
  //        createdAt, decidedAt
  //     } ],
  //     // ledger of credit awarded TO THIS provider (the referrer side)
  //     credits: [ { id, amount, reason, refId, awardedAt, expiresAt } ]
  //   }

  function emptyState(provider) {
    var id = (provider && provider.id) || "";
    return {
      providerId: id,
      providerName: (provider && provider.name) || "",
      code: codeForProvider(id || "camp"),
      joined: false,
      referrals: [],
      credits: []
    };
  }

  function cloneState(state) {
    try {
      return JSON.parse(JSON.stringify(state || {}));
    } catch (e) {
      return emptyState({ id: state && state.providerId, name: state && state.providerName });
    }
  }

  function nowIso() {
    try { return new Date().toISOString(); } catch (e) { return "" + Date.now(); }
  }
  function safeUid() {
    try { return HC.util.uid(); } catch (e) { return "id_" + Math.random().toString(36).slice(2); }
  }

  // ---- unique referral code + link ----------------------------------------
  // Deterministic, collision-resistant code derived from the provider id, so a
  // given provider always gets the SAME link (it is their stable identity), and
  // two different providers get DIFFERENT links. We slug the id and append a
  // short hash so even near-identical ids diverge.
  function slug(s) {
    return String(s == null ? "" : s)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 24) || "camp";
  }

  // Tiny stable string hash (djb2) -> base36. Pure, deterministic.
  function hash36(s) {
    var str = String(s == null ? "" : s);
    var h = 5381;
    for (var i = 0; i < str.length; i++) {
      h = ((h << 5) + h + str.charCodeAt(i)) >>> 0; // h*33 + c, keep unsigned
    }
    return h.toString(36);
  }

  function codeForProvider(providerId) {
    var base = slug(providerId);
    var suffix = hash36("hc-referral:" + String(providerId)).slice(0, 6);
    return base + "-" + suffix;
  }

  function linkForCode(code) {
    return LINK_BASE + String(code == null ? "" : code);
  }

  // The provider's unique referral link (the acceptance criterion's "link").
  function referralLink(state) {
    var code = (state && state.code) || codeForProvider((state && state.providerId) || "camp");
    return linkForCode(code);
  }

  // ---- join the programme --------------------------------------------------
  // Happity step 2: "Click the Join button". You must join before the widget /
  // link is shareable. (We still derive a stable code regardless, so the link
  // is well-defined; joining just unlocks sharing.)
  function joinProgramme(state) {
    var next = cloneState(state);
    next.joined = true;
    if (!next.code) next.code = codeForProvider(next.providerId || "camp");
    return next;
  }

  // ---- record a referral (referee uses the link) ---------------------------
  // A referee registers using a referrer's link. Starts life as PENDING and
  // awards NOTHING until approved. Idempotent on referee email: the same person
  // cannot be referred twice (no double credit).
  //   referee = { name, email, isNewBusiness }
  // Returns { state, added: Boolean, reason: String }.
  function recordReferral(state, referee) {
    var next = cloneState(state);
    if (!Array.isArray(next.referrals)) next.referrals = [];
    if (!referee || !referee.email) return { state: next, added: false, reason: "no-email" };

    var email = normEmail(referee.email);
    if (!email) return { state: next, added: false, reason: "no-email" };

    if (findReferralByEmail(next, email)) {
      // Already referred — duplicate, no new referral (prevents double credit).
      return { state: next, added: false, reason: "duplicate" };
    }

    next.referrals.push({
      id: safeUid(),
      code: next.code || codeForProvider(next.providerId || "camp"),
      refereeName: referee.name ? String(referee.name) : "",
      refereeEmail: email,
      // T&C 08: only a completely-new registration can ever qualify.
      isNewBusiness: referee.isNewBusiness === undefined ? true : !!referee.isNewBusiness,
      status: STATUS.PENDING,
      createdAt: nowIso(),
      decidedAt: null
    });
    return { state: next, added: true, reason: "" };
  }

  function normEmail(e) { return String(e || "").trim().toLowerCase(); }

  function findReferralByEmail(state, email) {
    if (!state || !Array.isArray(state.referrals)) return null;
    var target = normEmail(email);
    for (var i = 0; i < state.referrals.length; i++) {
      if (state.referrals[i] && normEmail(state.referrals[i].refereeEmail) === target) {
        return state.referrals[i];
      }
    }
    return null;
  }
  function findReferral(state, refId) {
    if (!state || !Array.isArray(state.referrals)) return null;
    for (var i = 0; i < state.referrals.length; i++) {
      if (state.referrals[i] && state.referrals[i].id === refId) return state.referrals[i];
    }
    return null;
  }

  // ---- approve a referral (platform reviews the new registration) ----------
  // The CORE rule (T&C 03 + 08): credit is awarded to BOTH parties only on an
  // APPROVED, completely-new registration. Approving a non-new (lapsed/existing)
  // registration is not allowed and awards nothing.
  // Returns { state, ok, reason, referrerCredit, refereeCredit }.
  //   referrerCredit -> credit added to THIS provider (the referrer).
  //   refereeCredit  -> credit owed to the referee (the new provider).
  function approveReferral(state, refId) {
    var next = cloneState(state);
    var ref = findReferral(next, refId);
    if (!ref) return { state: next, ok: false, reason: "not-found", referrerCredit: 0, refereeCredit: 0 };

    if (ref.status === STATUS.APPROVED) {
      // Idempotent: already approved & credited; do not double-award.
      return { state: next, ok: false, reason: "already-approved", referrerCredit: 0, refereeCredit: 0 };
    }
    if (!ref.isNewBusiness) {
      // T&C 08 — not a new registration; cannot be approved for credit.
      ref.status = STATUS.REJECTED;
      ref.decidedAt = nowIso();
      return { state: next, ok: false, reason: "not-new-business", referrerCredit: 0, refereeCredit: 0 };
    }

    ref.status = STATUS.APPROVED;
    ref.decidedAt = nowIso();

    // Award the referrer's £10 to THIS provider's credit ledger.
    if (!Array.isArray(next.credits)) next.credits = [];
    next.credits.push(makeCredit(CREDIT_GIVE, "referral-referrer", ref.id));

    // The referee's £10 is owed to the new provider's own ledger (a separate
    // account). We return it so the caller / UI can show "both credited".
    return {
      state: next,
      ok: true,
      reason: "",
      referrerCredit: CREDIT_GIVE,
      refereeCredit: CREDIT_GET
    };
  }

  // ---- reject a referral ---------------------------------------------------
  function rejectReferral(state, refId) {
    var next = cloneState(state);
    var ref = findReferral(next, refId);
    if (!ref) return { state: next, ok: false, reason: "not-found" };
    if (ref.status === STATUS.APPROVED) {
      return { state: next, ok: false, reason: "already-approved" };
    }
    ref.status = STATUS.REJECTED;
    ref.decidedAt = nowIso();
    return { state: next, ok: true, reason: "" };
  }

  function makeCredit(amount, reason, refId) {
    var at = nowIso();
    return {
      id: safeUid(),
      amount: Number(amount) || 0,
      reason: reason || "referral",
      refId: refId || null,
      awardedAt: at,
      expiresAt: plusMonthsIso(at, CREDIT_EXPIRY_MONTHS)
    };
  }

  function plusMonthsIso(iso, months) {
    try {
      var d = new Date(iso);
      if (isNaN(d.getTime())) d = new Date();
      d.setMonth(d.getMonth() + (Number(months) || 0));
      return d.toISOString();
    } catch (e) { return iso; }
  }

  // ---- queries -------------------------------------------------------------
  function approvedReferrals(state) {
    if (!state || !Array.isArray(state.referrals)) return [];
    return state.referrals.filter(function (r) { return r && r.status === STATUS.APPROVED; });
  }
  function pendingReferrals(state) {
    if (!state || !Array.isArray(state.referrals)) return [];
    return state.referrals.filter(function (r) { return r && r.status === STATUS.PENDING; });
  }

  // Total NON-EXPIRED credit balance for this provider (the referrer side),
  // as shown "on the homepage of your Dashboard". asOf lets tests check expiry.
  function creditBalance(state, asOf) {
    if (!state || !Array.isArray(state.credits)) return 0;
    var when = asOf ? new Date(asOf).getTime() : Date.now();
    var total = 0;
    for (var i = 0; i < state.credits.length; i++) {
      var c = state.credits[i];
      if (!c) continue;
      var exp = c.expiresAt ? new Date(c.expiresAt).getTime() : Infinity;
      if (isFinite(exp) && exp <= when) continue; // expired -> excluded
      total += Number(c.amount) || 0;
    }
    return total;
  }

  // Lifetime credit earned (ignores expiry) — useful for the "you've earned"
  // headline figure.
  function lifetimeEarned(state) {
    if (!state || !Array.isArray(state.credits)) return 0;
    var total = 0;
    for (var i = 0; i < state.credits.length; i++) {
      total += (state.credits[i] && Number(state.credits[i].amount)) || 0;
    }
    return total;
  }

  // Referrals remaining to earn a full year's Membership for free. Happity:
  // "If you refer just 6 new providers across the year, you could get your
  // entire annual Membership for free!"
  var FREE_MEMBERSHIP_REFERRALS = 6;
  function referralsToFreeMembership(state) {
    var done = approvedReferrals(state).length;
    return Math.max(0, FREE_MEMBERSHIP_REFERRALS - done);
  }

  /* ============================================================ *
   *  PERSISTENCE (HC.store only — never raw localStorage)         *
   * ============================================================ */

  function loadState(seed) {
    var raw;
    try { raw = HC.store.get(STORE_KEY, null); } catch (e) { raw = null; }
    if (!raw || typeof raw !== "object") return emptyState(seed);
    if (!Array.isArray(raw.referrals)) raw.referrals = [];
    if (!Array.isArray(raw.credits)) raw.credits = [];
    raw.joined = !!raw.joined;
    if (!raw.providerId && seed) { raw.providerId = seed.id; raw.providerName = seed.name; }
    if (!raw.code) raw.code = codeForProvider(raw.providerId || "camp");
    return raw;
  }

  function saveState(state) {
    try { HC.store.set(STORE_KEY, state); } catch (e) {}
  }

  /* ---------------- live camp data ---------------- */

  function providers() {
    try { return HC.data.providers || []; } catch (e) { return []; }
  }

  // Pick a representative live provider (the "you" who refers others).
  function pickSeedProvider() {
    var ps = providers();
    for (var i = 0; i < ps.length; i++) {
      if (ps[i] && ps[i].id && ps[i].name) return ps[i];
    }
    return { id: "demo-camp", name: "Holiday Camp Provider", area: "Walthamstow" };
  }

  /* ============================================================ *
   *  UI                                                           *
   * ============================================================ */

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function money(n) {
    try { return HC.util.money(n); } catch (e) { return "£" + (Number(n) || 0); }
  }

  function statusBadge(status) {
    if (status === STATUS.APPROVED) {
      return '<span style="font-size:11px;font-weight:700;color:#2f7d4f;background:#E1F0E4;padding:2px 8px;border-radius:999px">Approved · both credited</span>';
    }
    if (status === STATUS.REJECTED) {
      return '<span style="font-size:11px;font-weight:700;color:#9a1f5e;background:var(--pink-tint,#FCE8F0);padding:2px 8px;border-radius:999px">Not eligible</span>';
    }
    return '<span style="font-size:11px;font-weight:700;color:var(--purple,#603488);background:var(--purple-tint,#F0E8F4);padding:2px 8px;border-radius:999px">Pending review</span>';
  }

  function render(mountEl) {
    if (!mountEl) return;
    var seed = pickSeedProvider();
    var state = loadState(seed);
    if (!state.providerId) { state.providerId = seed.id; state.providerName = seed.name; }
    if (!state.code) state.code = codeForProvider(state.providerId || "camp");

    mountEl.innerHTML = "";
    var wrap = HC.util.el("div", {
      style: "font-family:'Nunito Sans',system-ui,sans-serif;color:var(--text,#383838)"
    });

    wrap.appendChild(HC.util.el("p", { style: "font-size:14px;margin:0 0 6px" },
      "Invite other holiday-camp operators to join HolidayCamp. When one registers a " +
      "<strong>new</strong> camp business using your <strong>unique link</strong> and we approve them, " +
      "you both get <strong>" + esc(money(CREDIT_GIVE)) + "</strong> credit — Give " + esc(money(CREDIT_GIVE)) +
      ", Get " + esc(money(CREDIT_GET)) + ", just like Happity."));
    wrap.appendChild(HC.util.el("p", {
      style: "font-size:12px;color:var(--muted,#808080);margin:0 0 14px"
    }, "Refer a Friend · " + esc(seed.name) + ". Unlimited referrals. Credit goes toward Membership or " +
      "Featured Listings and expires after " + CREDIT_EXPIRY_MONTHS + " months. Not transferable to cash."));

    // ---- KPI row ----
    var kpis = HC.util.el("div", { style: "display:flex;gap:12px;flex-wrap:wrap;margin:0 0 16px" });
    wrap.appendChild(kpis);

    // ---- unique link widget ----
    var linkBox = HC.util.el("div", {
      style: "border:1.5px dashed var(--magenta,#F82488);border-radius:14px;padding:14px;margin:0 0 16px;background:var(--pink-tint,#FCE8F0)"
    });
    wrap.appendChild(linkBox);

    // ---- controls: simulate referral + decide ----
    var controls = HC.util.el("div", {
      style: "display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin:0 0 14px"
    });
    var joinBtn = HC.util.el("button", { class: "hc-btn", type: "button" }, "Join the programme");
    var addBtn = HC.util.el("button", { class: "hc-btn hc-btn-ghost", type: "button" }, "Simulate a sign-up via your link");
    var resetBtn = HC.util.el("button", { class: "hc-btn hc-btn-ghost", type: "button" }, "Reset");
    controls.appendChild(joinBtn);
    controls.appendChild(addBtn);
    controls.appendChild(resetBtn);
    wrap.appendChild(controls);

    // ---- referrals table ----
    var tableHost = HC.util.el("div", {});
    wrap.appendChild(tableHost);

    mountEl.appendChild(wrap);

    function kpiCard(label, value, tint) {
      return '<div style="flex:1;min-width:120px;border:1.5px solid var(--line,#E6E6E6);border-radius:12px;' +
        'padding:12px 14px;background:' + (tint || "#fff") + '">' +
        '<div style="font-family:Quicksand,system-ui,sans-serif;font-weight:700;font-size:24px;color:var(--purple,#603488)">' +
          esc(value) + "</div>" +
        '<div style="font-size:11.5px;color:var(--muted,#808080);text-transform:uppercase;letter-spacing:.4px">' +
          esc(label) + "</div>" +
      "</div>";
    }

    var sampleSeq = 0;
    var SAMPLE_CAMPS = [
      { name: "Lloyd Park Sports Camp", new: true },
      { name: "Forest School Adventures", new: true },
      { name: "Stage Stars Drama Camp", new: true },
      { name: "Aqua Splash Swim School", new: false }, // already on the platform -> won't qualify
      { name: "Code Ninjas E17", new: true }
    ];

    function paint() {
      var link = referralLink(state);
      var bal = creditBalance(state);
      var approvedN = approvedReferrals(state).length;
      var pendingN = pendingReferrals(state).length;
      var toFree = referralsToFreeMembership(state);

      kpis.innerHTML =
        kpiCard("Credit balance", money(bal), "var(--purple-tint,#F0E8F4)") +
        kpiCard("Approved referrals", approvedN) +
        kpiCard("Pending review", pendingN, "var(--pink-tint,#FCE8F0)");

      linkBox.innerHTML =
        '<div style="font-family:Quicksand,system-ui,sans-serif;font-weight:700;font-size:12px;text-transform:uppercase;' +
          'letter-spacing:.5px;color:var(--magenta,#F82488);margin:0 0 6px">Your unique referral link</div>' +
        (state.joined
          ? ('<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">' +
              '<code style="font-size:13px;background:#fff;border:1.5px solid var(--line,#E6E6E6);border-radius:8px;' +
                'padding:8px 10px;word-break:break-all;flex:1;min-width:220px">' + esc(link) + "</code>" +
              '<button class="hc-btn" type="button" data-hc-copylink>Copy link</button>' +
            "</div>" +
            '<div style="font-size:12px;color:var(--muted,#808080);margin-top:8px">Share via email, WhatsApp, ' +
              "social or text. " + (toFree > 0
                ? ("Refer " + toFree + " more new camp" + (toFree === 1 ? "" : "s") + " for a free year of Membership.")
                : "You've earned a free year of Membership! 🎉") + "</div>")
          : '<div style="font-size:13px;color:var(--text,#383838)">Click <strong>Join the programme</strong> to ' +
            "unlock your shareable link.</div>");

      var refs = Array.isArray(state.referrals) ? state.referrals.slice() : [];
      if (!refs.length) {
        tableHost.innerHTML = '<p style="font-size:13px;color:var(--muted,#808080)">' +
          "No referrals yet — share your link, then simulate a sign-up to see a referral arrive as " +
          "<em>pending</em>. Approve it to credit both parties.</p>";
        return;
      }
      var head = '<tr style="text-align:left;border-bottom:1.5px solid var(--line,#E6E6E6)">' +
        ['Camp / referee', 'Status', 'Action'].map(function (h) {
          return '<th style="padding:8px 8px;font-size:11.5px;text-transform:uppercase;letter-spacing:.4px;color:var(--magenta,#F82488)">' + esc(h) + "</th>";
        }).join("") + "</tr>";
      var body = refs.map(function (r) {
        var action = "";
        if (r.status === STATUS.PENDING) {
          action =
            '<button class="hc-btn" type="button" data-hc-approve="' + esc(r.id) + '" style="padding:5px 10px;font-size:11px">Approve</button> ' +
            '<button class="hc-btn hc-btn-ghost" type="button" data-hc-reject="' + esc(r.id) + '" style="padding:5px 10px;font-size:11px">Decline</button>';
        } else {
          action = '<span style="color:var(--muted,#808080);font-size:12px">' +
            (r.status === STATUS.APPROVED ? "+ " + money(CREDIT_GIVE) + " each" : "—") + "</span>";
        }
        var nameLine = esc(r.refereeName || r.refereeEmail) +
          (r.isNewBusiness ? "" : ' <span style="font-size:11px;color:#9a1f5e">(existing — won\'t qualify)</span>');
        return '<tr style="border-bottom:1px solid var(--line,#E6E6E6)">' +
          '<td style="padding:8px 8px;font-size:13px">' + nameLine + "</td>" +
          '<td style="padding:8px 8px;font-size:13px">' + statusBadge(r.status) + "</td>" +
          '<td style="padding:8px 8px;font-size:13px">' + action + "</td>" +
        "</tr>";
      }).join("");
      tableHost.innerHTML =
        '<table style="width:100%;border-collapse:collapse">' + head + body + "</table>";
    }

    joinBtn.addEventListener("click", function () {
      state = joinProgramme(state);
      saveState(state);
      try { HC.util.toast("You're in — share your link!"); } catch (e) {}
      paint();
    });

    addBtn.addEventListener("click", function () {
      if (!state.joined) { state = joinProgramme(state); }
      var c = SAMPLE_CAMPS[sampleSeq % SAMPLE_CAMPS.length];
      sampleSeq += 1;
      var n = approvedReferrals(state).length + pendingReferrals(state).length + sampleSeq;
      var res = recordReferral(state, {
        name: c.name + " #" + n,
        email: "camp" + n + "+" + (state.code || "ref") + "@example.com",
        isNewBusiness: c.new
      });
      if (res.added) {
        state = res.state;
        saveState(state);
        try { HC.util.toast("New sign-up via your link — pending review"); } catch (e) {}
      } else {
        try { HC.util.toast(res.reason === "duplicate" ? "Already referred" : "Couldn't record referral"); } catch (e) {}
      }
      paint();
    });

    resetBtn.addEventListener("click", function () {
      state = emptyState(seed);
      saveState(state);
      sampleSeq = 0;
      try { HC.util.toast("Referrals reset"); } catch (e) {}
      paint();
    });

    // Delegated handlers within the mount (approve / reject / copy).
    mountEl.addEventListener("click", function (e) {
      var copy = e.target && e.target.closest && e.target.closest("[data-hc-copylink]");
      if (copy) {
        var link = referralLink(state);
        try {
          if (navigator && navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(link);
          }
        } catch (err) {}
        try { HC.util.toast("Link copied"); } catch (err2) {}
        return;
      }
      var ap = e.target && e.target.closest && e.target.closest("[data-hc-approve]");
      if (ap) {
        var res = approveReferral(state, ap.getAttribute("data-hc-approve"));
        state = res.state;
        saveState(state);
        if (res.ok) {
          try { HC.util.toast("Approved — " + money(res.referrerCredit) + " to you, " + money(res.refereeCredit) + " to them"); } catch (err) {}
        } else if (res.reason === "not-new-business") {
          try { HC.util.toast("Not a new registration — no credit (T&C)"); } catch (err) {}
        }
        paint();
        return;
      }
      var rj = e.target && e.target.closest && e.target.closest("[data-hc-reject]");
      if (rj) {
        var r2 = rejectReferral(state, rj.getAttribute("data-hc-reject"));
        state = r2.state;
        saveState(state);
        try { HC.util.toast("Referral declined"); } catch (err) {}
        paint();
        return;
      }
    });

    paint();
  }

  /* ============================================================ *
   *  selfTest — exercises the LOGIC and the acceptance criterion  *
   * ============================================================ */

  function selfTest() {
    var pass = 0, fail = 0, log = [];
    function check(label, fn) {
      try { fn(); pass += 1; log.push("✓ " + label); }
      catch (e) { fail += 1; log.push("✗ " + label + " — " + (e && e.message ? e.message : String(e))); }
    }

    var seedA = { id: "lloyd-park-club", name: "Lloyd Park Holiday Club" };
    var seedB = { id: "leyton-sports-camp", name: "Leyton Sports Camp" };

    // --- ACCEPTANCE CRITERION, part 1: EACH PROVIDER GETS A UNIQUE LINK ------
    check("Each provider gets a referral link, and it is unique per provider", function () {
      var a = emptyState(seedA);
      var b = emptyState(seedB);
      var linkA = referralLink(a);
      var linkB = referralLink(b);
      HC.assert(typeof linkA === "string" && linkA.indexOf("http") === 0, "provider A has a URL link");
      HC.assert(typeof linkB === "string" && linkB.indexOf("http") === 0, "provider B has a URL link");
      HC.assert(linkA !== linkB, "two providers get DIFFERENT links (" + linkA + " vs " + linkB + ")");
      HC.assert(a.code !== b.code, "two providers get different codes");
      HC.assert(linkA.indexOf(a.code) !== -1, "the link embeds the provider's unique code");
    });

    check("The referral link is STABLE for a given provider (same id -> same link)", function () {
      var a1 = emptyState(seedA);
      var a2 = emptyState(seedA);
      HC.assert(referralLink(a1) === referralLink(a2), "same provider always gets the same link");
      // re-derive directly from the id
      HC.assert(codeForProvider(seedA.id) === a1.code, "code is a deterministic function of the id");
    });

    check("Distinct provider ids never collide on a referral code", function () {
      var ids = ["a", "b", "ab", "ba", "lloyd-park", "lloyd-park-2", "x", "x ", "camp-1", "camp-2"];
      var seen = {};
      for (var i = 0; i < ids.length; i++) {
        var code = codeForProvider(ids[i]);
        HC.assert(!seen[code], "code collision for id '" + ids[i] + "' -> " + code);
        seen[code] = true;
      }
    });

    // --- ACCEPTANCE CRITERION, part 2: AN APPROVED REFERRAL CREDITS BOTH -----
    check("An APPROVED referral credits BOTH parties £10 each", function () {
      var s = emptyState(seedA);
      s = joinProgramme(s);
      var rec = recordReferral(s, { name: "Sunny Days Camp", email: "sunny@example.com", isNewBusiness: true });
      HC.assert(rec.added === true, "the referral was recorded");
      s = rec.state;
      HC.assert(pendingReferrals(s).length === 1, "it starts as pending");
      HC.assert(creditBalance(s) === 0, "no credit before approval");

      var refId = s.referrals[0].id;
      var out = approveReferral(s, refId);
      HC.assert(out.ok === true, "approval succeeds for a new business");
      s = out.state;
      // BOTH parties credited £10:
      HC.assert(out.referrerCredit === 10, "referrer (you) credited £10, got " + out.referrerCredit);
      HC.assert(out.refereeCredit === 10, "referee (them) credited £10, got " + out.refereeCredit);
      HC.assert(creditBalance(s) === 10, "your ledger balance is £10 after approval, got " + creditBalance(s));
      HC.assert(approvedReferrals(s).length === 1, "the referral is now approved");
      HC.assert(s.referrals[0].status === "approved", "status flipped to approved");
    });

    // --- Credit is awarded ONLY on approval (pending / rejected award nothing)
    check("A pending referral awards no credit until approved", function () {
      var s = joinProgramme(emptyState(seedA));
      s = recordReferral(s, { name: "Pending Camp", email: "pending@example.com", isNewBusiness: true }).state;
      HC.assert(creditBalance(s) === 0, "pending referral has not credited anyone");
      HC.assert(approvedReferrals(s).length === 0, "nothing approved yet");
    });

    check("A rejected referral never credits anyone", function () {
      var s = joinProgramme(emptyState(seedA));
      s = recordReferral(s, { name: "Reject Me", email: "reject@example.com", isNewBusiness: true }).state;
      var id = s.referrals[0].id;
      var out = rejectReferral(s, id);
      HC.assert(out.ok === true, "rejection processed");
      s = out.state;
      HC.assert(s.referrals[0].status === "rejected", "status is rejected");
      HC.assert(creditBalance(s) === 0, "no credit for a rejected referral");
    });

    // --- T&C 08: must be a COMPLETELY NEW registration ----------------------
    check("An existing / lapsed registration does NOT qualify for credit", function () {
      var s = joinProgramme(emptyState(seedA));
      s = recordReferral(s, { name: "Existing Camp", email: "existing@example.com", isNewBusiness: false }).state;
      var id = s.referrals[0].id;
      var out = approveReferral(s, id);
      HC.assert(out.ok === false, "cannot approve a non-new registration for credit");
      HC.assert(out.reason === "not-new-business", "reason cites the new-registration rule");
      s = out.state;
      HC.assert(s.referrals[0].status === "rejected", "non-new referral ends up rejected");
      HC.assert(creditBalance(s) === 0, "no credit awarded for an existing business");
    });

    // --- Idempotency: cannot approve twice (no double credit) ---------------
    check("Approving the same referral twice does not double-credit", function () {
      var s = joinProgramme(emptyState(seedA));
      s = recordReferral(s, { name: "One Off", email: "oneoff@example.com", isNewBusiness: true }).state;
      var id = s.referrals[0].id;
      s = approveReferral(s, id).state;
      HC.assert(creditBalance(s) === 10, "first approval credits £10");
      var second = approveReferral(s, id);
      HC.assert(second.ok === false && second.reason === "already-approved", "second approval is a no-op");
      s = second.state;
      HC.assert(creditBalance(s) === 10, "balance unchanged after re-approving, got " + creditBalance(s));
      HC.assert(s.credits.length === 1, "only one credit entry exists");
    });

    // --- Duplicate referee email cannot be referred twice -------------------
    check("The same referee email cannot be referred twice", function () {
      var s = joinProgramme(emptyState(seedA));
      var r1 = recordReferral(s, { name: "Dup", email: "Dup@Example.com", isNewBusiness: true });
      HC.assert(r1.added === true, "first referral recorded");
      s = r1.state;
      var r2 = recordReferral(s, { name: "Dup again", email: "dup@example.com", isNewBusiness: true });
      HC.assert(r2.added === false && r2.reason === "duplicate", "duplicate email is rejected (case-insensitive)");
      s = r2.state;
      HC.assert(s.referrals.length === 1, "still only one referral record");
    });

    // --- Unlimited referrals (T&C 02), each approved one credits £10 --------
    check("Unlimited referrals — each approved one adds £10 to the balance", function () {
      var s = joinProgramme(emptyState(seedA));
      for (var i = 1; i <= 5; i++) {
        s = recordReferral(s, { name: "Camp " + i, email: "camp" + i + "@example.com", isNewBusiness: true }).state;
      }
      HC.assert(s.referrals.length === 5, "five referrals recorded");
      for (var j = 0; j < s.referrals.length; j++) {
        s = approveReferral(s, s.referrals[j].id).state;
      }
      HC.assert(approvedReferrals(s).length === 5, "all five approved");
      HC.assert(creditBalance(s) === 50, "five approvals -> £50, got " + creditBalance(s));
      HC.assert(referralsToFreeMembership(s) === 1, "one more referral for free Membership (6 - 5)");
    });

    // --- Credit expiry (T&C 06): 12 months ----------------------------------
    check("Credit is excluded from the balance after it expires (12 months)", function () {
      var s = joinProgramme(emptyState(seedA));
      s = recordReferral(s, { name: "Expiry Camp", email: "exp@example.com", isNewBusiness: true }).state;
      s = approveReferral(s, s.referrals[0].id).state;
      HC.assert(s.credits.length === 1, "one credit awarded");
      var c = s.credits[0];
      HC.assert(!!c.expiresAt, "credit has an expiry date");
      // before expiry: counts; after expiry: excluded
      var justBefore = new Date(c.expiresAt);
      justBefore.setDate(justBefore.getDate() - 1);
      var justAfter = new Date(c.expiresAt);
      justAfter.setDate(justAfter.getDate() + 1);
      HC.assert(creditBalance(s, justBefore.toISOString()) === 10, "credit counts before expiry");
      HC.assert(creditBalance(s, justAfter.toISOString()) === 0, "credit excluded after expiry");
      HC.assert(lifetimeEarned(s) === 10, "lifetime earned ignores expiry");
    });

    // --- Free-membership target (refer 6) -----------------------------------
    check("Referring 6 approved new camps reaches the free-Membership target", function () {
      var s = joinProgramme(emptyState(seedA));
      HC.assert(referralsToFreeMembership(s) === 6, "starts needing 6");
      for (var i = 1; i <= 6; i++) {
        s = recordReferral(s, { name: "C" + i, email: "c" + i + "@example.com", isNewBusiness: true }).state;
        s = approveReferral(s, s.referrals[i - 1].id).state;
      }
      HC.assert(approvedReferrals(s).length === 6, "six approved referrals");
      HC.assert(referralsToFreeMembership(s) === 0, "target reached");
      HC.assert(creditBalance(s) === 60, "£60 of credit, enough for a year, got " + creditBalance(s));
    });

    // --- Defensive against bad input ----------------------------------------
    check("Defensive: bad inputs never throw or corrupt state", function () {
      var s = emptyState(seedA);
      var r1 = recordReferral(s, null);
      HC.assert(r1.added === false && r1.reason === "no-email", "null referee is a safe no-op");
      var r2 = recordReferral(s, { name: "No Email" });
      HC.assert(r2.added === false && r2.reason === "no-email", "referee without an email cannot be referred");
      var ap = approveReferral(s, "does-not-exist");
      HC.assert(ap.ok === false && ap.reason === "not-found", "approving a missing referral is refused");
      HC.assert(creditBalance(s) === 0, "balance stays at zero");
      HC.assert(creditBalance(null) === 0, "creditBalance(null) is 0, not a throw");
      HC.assert(referralLink({}) .indexOf("http") === 0, "referralLink tolerates an empty state");
    });

    // --- Persistence round-trips through HC.store (namespaced) --------------
    check("Referral state persists via HC.store", function () {
      var s = joinProgramme(emptyState(seedA));
      s = recordReferral(s, { name: "Persist Camp", email: "persist@example.com", isNewBusiness: true }).state;
      s = approveReferral(s, s.referrals[0].id).state;
      var beforeBal = creditBalance(s);
      var beforeCode = s.code;
      var ok = HC.store.set(STORE_KEY, s);
      HC.assert(ok !== false, "store.set should succeed");
      var got = HC.store.get(STORE_KEY, null);
      HC.assert(got && Array.isArray(got.referrals), "referrals survive a store round-trip");
      HC.assert(got.code === beforeCode, "the unique code survives persistence");
      HC.assert(creditBalance(got) === beforeBal, "credit balance survives persistence");
      HC.assert(approvedReferrals(got).length === 1, "approval status survives persistence");
      try { HC.store.remove ? HC.store.remove(STORE_KEY) : HC.store.set(STORE_KEY, null); } catch (e) {}
    });

    // --- Seed provider comes from the LIVE school-age holiday-camp directory -
    check("Seed provider comes from the live holiday-camp directory", function () {
      var s = pickSeedProvider();
      HC.assert(s && typeof s.id === "string" && s.id.length > 0, "seed has a provider id");
      HC.assert(typeof s.name === "string" && s.name.length > 0, "seed has a provider name");
      var ps = providers();
      if (ps.length) {
        var found = ps.some(function (p) { return p && p.id === s.id; });
        HC.assert(found, "seed should be a real directory provider when data is present");
        // and that real provider gets a real, unique link
        var link = referralLink(emptyState(s));
        HC.assert(link.indexOf(slug(s.id)) !== -1, "live provider's link embeds its slug");
      }
    });

    return { pass: pass, fail: fail, log: log };
  }

  /* ============================================================ *
   *  register                                                     *
   * ============================================================ */

  HC.registerFeature({
    id: "provider-referrals",
    title: "Referral programme (Give £10, get £10)",
    side: "provider",
    icon: "🎁",
    summary: "Get your own unique referral link and invite other holiday-camp operators to join. When one " +
      "registers a NEW camp business with your link and we approve them, you both get £10 credit toward " +
      "Membership or Featured Listings — Give £10, Get £10, just like Happity. Unlimited referrals; credit " +
      "expires after 12 months.",
    render: render,
    selfTest: selfTest
  });
})();
