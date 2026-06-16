/* HolidayCamp feature module — platform-parent-referral
 *
 * Side: PLATFORM.
 * Replicates Happity's PARENT Referral Programme (evidence: support article
 * 7176277 "Terms and conditions for Parent Referral Programme"; 04-seo §3.2).
 *
 * What Happity does — verbatim from 7176277:
 *   - "Our referral programme allows you to refer local class providers to
 *      Happity. For every successful referral you will be rewarded with a £5
 *      Amazon voucher."                       -> a PARENT refers a PROVIDER; the
 *                                                 reward is a £5 Amazon VOUCHER.
 *   - "Rewards will be in Amazon Vouchers only. No requests for cash or credit
 *      will be accepted."                      -> voucher, NOT account credit.
 *   - "To be a Successful Registration the referral must be a New Provider to
 *      Happity whose registration is ACCEPTED on the platform."
 *                                              -> voucher ONLY once the provider
 *                                                 is approved (the acceptance
 *                                                 criterion).
 *   - "You will receive your voucher within 60 days of making the successful
 *      referral."                              -> a fulfilment SLA.
 *   - "Your Amazon vouchers will be issued to the email used by you during your
 *      referral."                              -> voucher goes to the parent's
 *                                                 email.
 *   - "A New Provider can only be referred once. The first referral received
 *      will be the successful one rewarded."   -> de-dupe by provider; first
 *                                                 referrer wins.
 *   - "A New Provider ... is not a current, previous or lapsed user of Happity
 *      [even] with a different email address ... [nor one] currently being
 *      processed."                             -> existing / pending / lapsed
 *                                                 providers do NOT qualify.
 *   - "We reserve the right to withhold and not release rewards to individuals
 *      who are found to be abusing these T&Cs."-> abusive referrers earn nothing.
 *
 * Reframed for SCHOOL-AGE HOLIDAY CAMPS: a PARENT browsing the E17 directory
 * knows a local holiday-camp operator (a sports club, forest school, drama camp,
 * coding club...) that isn't on HolidayCamp yet. They refer them. When that camp
 * registers as a genuinely NEW provider and the platform APPROVES it, the parent
 * earns a £5 Amazon voucher, emailed to the address they referred with, payable
 * within 60 days. Pending and rejected registrations pay nothing; a camp already
 * (or previously) on the platform doesn't qualify; the same camp can only be
 * referred once — the first parent to refer it wins.
 *
 * ACCEPTANCE CRITERION (exercised by selfTest, multiple cases):
 *   A parent referring a NEW provider earns a voucher ONCE the provider is
 *   APPROVED. (No voucher while pending; none if rejected; none for an
 *   existing/lapsed provider; one voucher, to the parent's email, on approval.)
 *
 * Self-contained, defensive, no imports/exports. Calls HC.registerFeature.
 */
(function () {
  "use strict";

  // Defensive: never throw at module load if HC isn't present.
  if (typeof window === "undefined" || !window.HC || typeof window.HC.registerFeature !== "function") {
    if (typeof console !== "undefined" && console.warn) {
      console.warn("[HC] platform-parent-referral: HC core not found; skipping registration.");
    }
    return;
  }

  var HC = window.HC;

  var STORE_KEY = "platform_parent_referral_state";

  /* ---------------- programme constants (mirror 7176277) ---------------- */

  var VOUCHER_AMOUNT = 5;           // "£5 Amazon voucher"
  var VOUCHER_KIND = "Amazon";      // "Rewards will be in Amazon Vouchers only"
  var FULFIL_SLA_DAYS = 60;         // "within 60 days of making the successful referral"

  // Referral lifecycle for the referred provider's registration:
  //   pending   — registration submitted / being processed, no reward yet
  //   approved  — accepted on the platform -> Successful Registration -> voucher
  //   rejected  — declined at due-diligence -> no voucher
  var STATUS = { PENDING: "pending", APPROVED: "approved", REJECTED: "rejected" };

  // Why a referral can fail to qualify (so the UI/tests can be precise).
  var REASON = {
    OK: "",
    NO_PROVIDER: "no-provider",
    NO_EMAIL: "no-email",                 // parent referred without their email
    ALREADY_REFERRED: "already-referred", // T&C: a provider can only be referred once
    EXISTING_PROVIDER: "existing-provider", // not a New Provider (current/previous/lapsed)
    NOT_FOUND: "not-found",
    NOT_NEW: "not-new",                   // approving a non-new registration
    ALREADY_DECIDED: "already-decided",   // idempotency guard
    ABUSE: "abuse"                        // referrer flagged for abusing the T&Cs
  };

  /* ============================================================ *
   *  PURE LOGIC (DOM-free, testable)                              *
   *  Every mutator clones first and returns a NEW state.         *
   * ============================================================ */

  // State shape:
  //   {
  //     referrals: [ {
  //       id,
  //       parentName, parentEmail,        // the referrer (voucher recipient)
  //       providerKey,                    // normalised identity of referred camp
  //       providerName,
  //       isNewProvider,                  // genuinely new to the platform?
  //       status,                         // pending | approved | rejected
  //       createdAt, decidedAt
  //     } ],
  //     vouchers: [ {                      // ledger of issued rewards
  //       id, referralId, parentEmail, parentName,
  //       amount, kind,                    // 5, "Amazon"
  //       code,                            // mock voucher code (e-voucher)
  //       issuedAt, payableBy             // issuedAt + 60 days
  //     } ],
  //     flaggedParents: [ "email", ... ]  // abusers; their referrals never pay
  //   }

  function emptyState() {
    return { referrals: [], vouchers: [], flaggedParents: [] };
  }

  function cloneState(state) {
    try {
      var c = JSON.parse(JSON.stringify(state || {}));
      if (!Array.isArray(c.referrals)) c.referrals = [];
      if (!Array.isArray(c.vouchers)) c.vouchers = [];
      if (!Array.isArray(c.flaggedParents)) c.flaggedParents = [];
      return c;
    } catch (e) {
      return emptyState();
    }
  }

  function nowIso() {
    try { return new Date().toISOString(); } catch (e) { return "" + Date.now(); }
  }
  function safeUid() {
    try { return HC.util.uid(); } catch (e) { return "id_" + Math.random().toString(36).slice(2); }
  }
  function normEmail(e) { return String(e == null ? "" : e).trim().toLowerCase(); }
  function safeStr(v) { return (v === null || v === undefined) ? "" : String(v); }

  // A stable, normalised key for a referred provider so "the same camp" referred
  // twice (by name, or by id) is detected as a duplicate regardless of casing /
  // punctuation. Prefer an explicit id; else slug the name.
  function providerKey(provider) {
    if (!provider) return "";
    var id = safeStr(provider.id).trim();
    if (id) return "id:" + id.toLowerCase();
    var name = safeStr(provider.name).trim().toLowerCase()
      .replace(/&/g, "and")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
    return name ? "name:" + name : "";
  }

  // ---- abuse controls (T&C: withhold rewards from abusers) ----------------
  function flagParent(state, parentEmail) {
    var next = cloneState(state);
    var em = normEmail(parentEmail);
    if (em && next.flaggedParents.indexOf(em) === -1) next.flaggedParents.push(em);
    return next;
  }
  function isFlagged(state, parentEmail) {
    if (!state || !Array.isArray(state.flaggedParents)) return false;
    return state.flaggedParents.indexOf(normEmail(parentEmail)) !== -1;
  }

  // ---- lookups -------------------------------------------------------------
  function findReferral(state, id) {
    if (!state || !Array.isArray(state.referrals)) return null;
    for (var i = 0; i < state.referrals.length; i++) {
      if (state.referrals[i] && state.referrals[i].id === id) return state.referrals[i];
    }
    return null;
  }

  // Has this provider already been referred? (T&C: only once; first wins.)
  function findReferralByProvider(state, key) {
    if (!state || !Array.isArray(state.referrals) || !key) return null;
    for (var i = 0; i < state.referrals.length; i++) {
      if (state.referrals[i] && state.referrals[i].providerKey === key) return state.referrals[i];
    }
    return null;
  }

  // ---- record a referral (a parent refers a provider) ----------------------
  // referral = {
  //   parentName, parentEmail,                    // the referrer
  //   provider: { id?, name },                    // the referred camp
  //   isNewProvider                               // genuinely new to platform?
  // }
  // Returns { state, added:Boolean, referral|null, reason }.
  function recordReferral(state, input) {
    var next = cloneState(state);
    input = input || {};

    var provider = input.provider || {};
    var key = providerKey(provider);
    if (!key) return { state: next, added: false, referral: null, reason: REASON.NO_PROVIDER };

    var parentEmail = normEmail(input.parentEmail);
    if (!parentEmail) return { state: next, added: false, referral: null, reason: REASON.NO_EMAIL };

    // T&C: a New Provider can only be referred ONCE — the first referral wins.
    var dup = findReferralByProvider(next, key);
    if (dup) return { state: next, added: false, referral: dup, reason: REASON.ALREADY_REFERRED };

    // An explicitly-not-new provider is recorded but flagged ineligible, so the
    // UI can show why it won't pay and approval is blocked. (Default true.)
    var isNew = input.isNewProvider === undefined ? true : !!input.isNewProvider;

    var ref = {
      id: safeUid(),
      parentName: safeStr(input.parentName),
      parentEmail: parentEmail,
      providerKey: key,
      providerName: safeStr(provider.name) || key.replace(/^(id:|name:)/, ""),
      isNewProvider: isNew,
      status: STATUS.PENDING,
      createdAt: nowIso(),
      decidedAt: null
    };
    next.referrals.push(ref);
    return {
      state: next,
      added: true,
      referral: ref,
      reason: isNew ? REASON.OK : REASON.EXISTING_PROVIDER
    };
  }

  // ---- approve a referred provider's registration --------------------------
  // THE CORE RULE: a voucher is issued to the PARENT only when the referred
  // provider is a genuinely NEW provider AND their registration is APPROVED
  // (a "Successful Registration"). Abusive referrers are withheld.
  // Returns { state, ok, reason, voucher|null }.
  function approveReferral(state, refId) {
    var next = cloneState(state);
    var ref = findReferral(next, refId);
    if (!ref) return { state: next, ok: false, reason: REASON.NOT_FOUND, voucher: null };

    if (ref.status === STATUS.APPROVED) {
      // Idempotent: already a Successful Registration; do not double-issue.
      return { state: next, ok: false, reason: REASON.ALREADY_DECIDED, voucher: null };
    }
    if (!ref.isNewProvider) {
      // Not a New Provider -> cannot be a Successful Registration. Reject it.
      ref.status = STATUS.REJECTED;
      ref.decidedAt = nowIso();
      return { state: next, ok: false, reason: REASON.NOT_NEW, voucher: null };
    }

    // Successful Registration.
    ref.status = STATUS.APPROVED;
    ref.decidedAt = nowIso();

    // T&C: withhold rewards from referrers found to be abusing the scheme. The
    // registration still stands; the referrer simply earns no voucher.
    if (isFlagged(next, ref.parentEmail)) {
      return { state: next, ok: true, reason: REASON.ABUSE, voucher: null };
    }

    var voucher = makeVoucher(ref);
    next.vouchers.push(voucher);
    return { state: next, ok: true, reason: REASON.OK, voucher: voucher };
  }

  // ---- reject a referred provider's registration ---------------------------
  function rejectReferral(state, refId) {
    var next = cloneState(state);
    var ref = findReferral(next, refId);
    if (!ref) return { state: next, ok: false, reason: REASON.NOT_FOUND };
    if (ref.status === STATUS.APPROVED) {
      return { state: next, ok: false, reason: REASON.ALREADY_DECIDED };
    }
    ref.status = STATUS.REJECTED;
    ref.decidedAt = nowIso();
    return { state: next, ok: true, reason: REASON.OK };
  }

  function makeVoucher(ref) {
    var issuedAt = nowIso();
    return {
      id: safeUid(),
      referralId: ref.id,
      parentEmail: ref.parentEmail,   // voucher emailed to the referral address
      parentName: ref.parentName,
      amount: VOUCHER_AMOUNT,
      kind: VOUCHER_KIND,
      code: voucherCode(),
      issuedAt: issuedAt,
      payableBy: plusDaysIso(issuedAt, FULFIL_SLA_DAYS)
    };
  }

  function voucherCode() {
    // Mock Amazon-style e-voucher code, e.g. HC-AMZ-XXXX-XXXX.
    function blk() {
      var s = Math.random().toString(36).toUpperCase().replace(/[^A-Z0-9]/g, "");
      while (s.length < 4) s += "X";
      return s.slice(0, 4);
    }
    return "HC-AMZ-" + blk() + "-" + blk();
  }

  function plusDaysIso(iso, days) {
    try {
      var d = new Date(iso);
      if (isNaN(d.getTime())) d = new Date();
      d.setDate(d.getDate() + (Number(days) || 0));
      return d.toISOString();
    } catch (e) { return iso; }
  }

  /* ---------------- queries ---------------- */

  function pendingReferrals(state) {
    if (!state || !Array.isArray(state.referrals)) return [];
    return state.referrals.filter(function (r) { return r && r.status === STATUS.PENDING; });
  }
  function approvedReferrals(state) {
    if (!state || !Array.isArray(state.referrals)) return [];
    return state.referrals.filter(function (r) { return r && r.status === STATUS.APPROVED; });
  }

  // Vouchers earned by a given parent (the reward they can claim).
  function vouchersForParent(state, parentEmail) {
    if (!state || !Array.isArray(state.vouchers)) return [];
    var em = normEmail(parentEmail);
    return state.vouchers.filter(function (v) { return v && normEmail(v.parentEmail) === em; });
  }

  // Total £ a parent has earned across all their successful referrals.
  function earnedTotal(state, parentEmail) {
    return vouchersForParent(state, parentEmail).reduce(function (sum, v) {
      return sum + (Number(v && v.amount) || 0);
    }, 0);
  }

  // All vouchers issued (platform-wide ledger).
  function allVouchers(state) {
    return (state && Array.isArray(state.vouchers)) ? state.vouchers.slice() : [];
  }

  /* ============================================================ *
   *  PERSISTENCE (HC.store only — never raw localStorage)         *
   * ============================================================ */

  function loadState() {
    var raw;
    try { raw = HC.store.get(STORE_KEY, null); } catch (e) { raw = null; }
    if (!raw || typeof raw !== "object") return emptyState();
    if (!Array.isArray(raw.referrals)) raw.referrals = [];
    if (!Array.isArray(raw.vouchers)) raw.vouchers = [];
    if (!Array.isArray(raw.flaggedParents)) raw.flaggedParents = [];
    return raw;
  }
  function saveState(state) {
    try { HC.store.set(STORE_KEY, state); } catch (e) { /* defensive */ }
  }

  /* ---------------- live camp data ---------------- */

  function providers() {
    try { return HC.data.providers || []; } catch (e) { return []; }
  }

  // Build a pool of "off-platform camps a parent might refer". We synthesise
  // plausible NEW operators (not in the live directory) and also include a known
  // EXISTING directory provider, so the UI can demonstrate the not-new path.
  function referralPool() {
    var existing = providers();
    var existingNames = {};
    for (var i = 0; i < existing.length; i++) {
      if (existing[i] && existing[i].name) existingNames[String(existing[i].name).toLowerCase()] = true;
    }
    var pool = [
      { name: "Walthamstow Wheelers Cycling Camp", isNew: true },
      { name: "E17 Forest School Holiday Days", isNew: true },
      { name: "Chingford Junior Tennis Camp", isNew: true },
      { name: "Leyton Lego Robotics Club", isNew: true },
      { name: "Highams Park Stage School", isNew: true }
    ];
    // Add one genuinely existing directory provider to show "won't qualify".
    if (existing.length) {
      var e = existing[Math.min(1, existing.length - 1)];
      if (e && e.name) pool.push({ id: e.id, name: e.name, isNew: false });
    }
    return pool;
  }

  /* ============================================================ *
   *  UI                                                           *
   * ============================================================ */

  function esc(s) {
    return safeStr(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function money(n) {
    try { return HC.util.money(n); } catch (e) { return "£" + (Number(n) || 0); }
  }

  function statusBadge(status, isNew) {
    if (status === STATUS.APPROVED) {
      return '<span style="font-size:11px;font-weight:700;color:#2f7d4f;background:#E1F0E4;padding:2px 8px;border-radius:999px">Approved · voucher issued</span>';
    }
    if (status === STATUS.REJECTED) {
      return '<span style="font-size:11px;font-weight:700;color:#9a1f5e;background:var(--pink-tint,#FCE8F0);padding:2px 8px;border-radius:999px">Not eligible</span>';
    }
    var newTag = isNew
      ? ""
      : ' <span style="font-size:11px;color:#9a1f5e">(already on platform — won\'t qualify)</span>';
    return '<span style="font-size:11px;font-weight:700;color:var(--purple,#603488);background:var(--purple-tint,#F0E8F4);padding:2px 8px;border-radius:999px">Pending review</span>' + newTag;
  }

  function render(mountEl) {
    if (!mountEl) return;
    try {
      var state = loadState();
      var pool = referralPool();
      var poolSeq = 0;

      // A demo "you" — the signed-in parent who refers camps.
      var DEMO_PARENT = { name: "You (parent)", email: "parent@example.com" };

      mountEl.innerHTML = "";
      var wrap = HC.util.el("div", {
        style: "font-family:'Nunito Sans',system-ui,sans-serif;color:var(--text,#383838)"
      });

      wrap.appendChild(HC.util.el("p", { style: "font-size:14px;margin:0 0 6px" },
        "Know a brilliant local holiday-camp provider that isn't on HolidayCamp yet? " +
        "<strong>Refer them.</strong> For every camp you refer that registers as a " +
        "<strong>new</strong> provider and is <strong>approved</strong>, we'll send you a " +
        "<strong>" + esc(money(VOUCHER_AMOUNT)) + " " + esc(VOUCHER_KIND) + " voucher</strong> — " +
        "Happity's Parent Referral Programme, reframed for school-age camps."));
      wrap.appendChild(HC.util.el("p", {
        style: "font-size:12px;color:var(--muted,#808080);margin:0 0 14px"
      }, "Rewards are " + esc(VOUCHER_KIND) + " vouchers only (no cash or credit), emailed to the address " +
        "you refer with, within " + FULFIL_SLA_DAYS + " days of a successful referral. A camp can only be " +
        "referred once — the first parent to refer it wins. Camps already (or previously) on HolidayCamp don't qualify."));

      // KPI row.
      var kpis = HC.util.el("div", { style: "display:flex;gap:12px;flex-wrap:wrap;margin:0 0 16px" });
      wrap.appendChild(kpis);

      // Controls.
      var controls = HC.util.el("div", {
        style: "display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin:0 0 14px"
      });
      var referBtn = HC.util.el("button", { class: "hc-btn", type: "button" }, "Refer a local camp");
      var resetBtn = HC.util.el("button", { class: "hc-btn hc-btn-ghost", type: "button" }, "Reset");
      controls.appendChild(referBtn);
      controls.appendChild(resetBtn);
      wrap.appendChild(controls);

      // Referrals table.
      var tableHost = HC.util.el("div", {});
      wrap.appendChild(tableHost);

      // Voucher wallet.
      var walletHost = HC.util.el("div", { style: "margin-top:16px" });
      wrap.appendChild(walletHost);

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

      function paint() {
        var earned = earnedTotal(state, DEMO_PARENT.email);
        var myVouchers = vouchersForParent(state, DEMO_PARENT.email);
        var approvedN = approvedReferrals(state).length;
        var pendingN = pendingReferrals(state).length;

        kpis.innerHTML =
          kpiCard("Vouchers earned", money(earned), "var(--purple-tint,#F0E8F4)") +
          kpiCard("Approved referrals", approvedN) +
          kpiCard("Pending review", pendingN, "var(--pink-tint,#FCE8F0)");

        var refs = Array.isArray(state.referrals) ? state.referrals.slice() : [];
        if (!refs.length) {
          tableHost.innerHTML = '<p style="font-size:13px;color:var(--muted,#808080)">' +
            "No referrals yet — click <strong>Refer a local camp</strong> to refer an off-platform " +
            "operator. It arrives as <em>pending</em>; approve it to issue your " + esc(money(VOUCHER_AMOUNT)) +
            " voucher.</p>";
        } else {
          var head = '<tr style="text-align:left;border-bottom:1.5px solid var(--line,#E6E6E6)">' +
            ['Referred camp', 'Status', 'Reward', 'Action'].map(function (h) {
              return '<th style="padding:8px 8px;font-size:11.5px;text-transform:uppercase;letter-spacing:.4px;color:var(--magenta,#F82488)">' + esc(h) + "</th>";
            }).join("") + "</tr>";
          var body = refs.map(function (r) {
            var action = "";
            if (r.status === STATUS.PENDING) {
              action =
                '<button class="hc-btn" type="button" data-hc-approve="' + esc(r.id) + '" style="padding:5px 10px;font-size:11px">Approve</button> ' +
                '<button class="hc-btn hc-btn-ghost" type="button" data-hc-reject="' + esc(r.id) + '" style="padding:5px 10px;font-size:11px">Decline</button>';
            } else {
              action = '<span style="color:var(--muted,#808080);font-size:12px">—</span>';
            }
            var reward = (r.status === STATUS.APPROVED)
              ? '<span style="color:#2f7d4f;font-weight:700">' + esc(money(VOUCHER_AMOUNT)) + " " + esc(VOUCHER_KIND) + "</span>"
              : '<span style="color:var(--muted,#808080)">—</span>';
            return '<tr style="border-bottom:1px solid var(--line,#E6E6E6)">' +
              '<td style="padding:8px 8px;font-size:13px">' + esc(r.providerName) + "</td>" +
              '<td style="padding:8px 8px;font-size:13px">' + statusBadge(r.status, r.isNewProvider) + "</td>" +
              '<td style="padding:8px 8px;font-size:13px">' + reward + "</td>" +
              '<td style="padding:8px 8px;font-size:13px">' + action + "</td>" +
            "</tr>";
          }).join("");
          tableHost.innerHTML =
            '<table style="width:100%;border-collapse:collapse">' + head + body + "</table>";
        }

        // Wallet of issued vouchers for this parent.
        if (!myVouchers.length) {
          walletHost.innerHTML = "";
        } else {
          walletHost.innerHTML =
            '<div style="font-family:Quicksand,system-ui,sans-serif;font-weight:700;font-size:12px;text-transform:uppercase;' +
              'letter-spacing:.5px;color:var(--magenta,#F82488);margin:0 0 8px">Your vouchers</div>' +
            myVouchers.map(function (v) {
              var by = "";
              try { by = new Date(v.payableBy).toLocaleDateString(); } catch (e) { by = String(v.payableBy); }
              return '<div style="border:1.5px dashed var(--magenta,#F82488);border-radius:14px;padding:12px 14px;margin:0 0 8px;background:var(--pink-tint,#FCE8F0)">' +
                '<div style="font-weight:700;color:var(--purple,#603488)">' + esc(money(v.amount)) + " " + esc(v.kind) + " voucher</div>" +
                '<code style="font-size:13px">' + esc(v.code) + "</code>" +
                '<div style="font-size:12px;color:var(--muted,#808080);margin-top:4px">Emailed to ' + esc(v.parentEmail) +
                  " · payable by " + esc(by) + "</div>" +
              "</div>";
            }).join("");
        }
      }

      referBtn.addEventListener("click", function () {
        var camp = pool[poolSeq % pool.length];
        poolSeq += 1;
        var res = recordReferral(state, {
          parentName: DEMO_PARENT.name,
          parentEmail: DEMO_PARENT.email,
          provider: { id: camp.id, name: camp.name },
          isNewProvider: camp.isNew
        });
        if (res.added) {
          state = res.state;
          saveState(state);
          try {
            HC.util.toast(camp.isNew
              ? "Referred — pending review. Approve it to earn your voucher."
              : "Referred, but this camp is already on HolidayCamp — it won't qualify.");
          } catch (e) {}
        } else if (res.reason === REASON.ALREADY_REFERRED) {
          try { HC.util.toast("That camp has already been referred — first referral wins."); } catch (e) {}
        } else {
          try { HC.util.toast("Couldn't record that referral."); } catch (e) {}
        }
        paint();
      });

      resetBtn.addEventListener("click", function () {
        state = emptyState();
        saveState(state);
        poolSeq = 0;
        try { HC.util.toast("Referrals reset"); } catch (e) {}
        paint();
      });

      // Delegated approve / reject within the mount.
      mountEl.addEventListener("click", function (e) {
        var ap = e.target && e.target.closest && e.target.closest("[data-hc-approve]");
        if (ap) {
          var res = approveReferral(state, ap.getAttribute("data-hc-approve"));
          state = res.state;
          saveState(state);
          if (res.ok && res.voucher) {
            try { HC.util.toast("Approved — " + money(VOUCHER_AMOUNT) + " " + VOUCHER_KIND + " voucher on its way to " + res.voucher.parentEmail); } catch (err) {}
          } else if (res.reason === REASON.NOT_NEW) {
            try { HC.util.toast("Not a new provider — no voucher (T&C)."); } catch (err) {}
          } else if (res.reason === REASON.ABUSE) {
            try { HC.util.toast("Approved, but reward withheld (referrer flagged)."); } catch (err) {}
          }
          paint();
          return;
        }
        var rj = e.target && e.target.closest && e.target.closest("[data-hc-reject]");
        if (rj) {
          var r2 = rejectReferral(state, rj.getAttribute("data-hc-reject"));
          state = r2.state;
          saveState(state);
          try { HC.util.toast("Registration declined — no voucher."); } catch (err) {}
          paint();
          return;
        }
      });

      paint();
    } catch (e) {
      mountEl.innerHTML = '<p style="color:#9a1f5e">Parent referral preview failed: ' +
        esc(e && e.message ? e.message : String(e)) + "</p>";
    }
  }

  /* ============================================================ *
   *  selfTest — exercises the LOGIC + the acceptance criterion    *
   * ============================================================ */

  function selfTest() {
    var pass = 0, fail = 0, log = [];
    function check(label, fn) {
      try { fn(); pass += 1; log.push("✓ " + label); }
      catch (e) { fail += 1; log.push("✗ " + label + " — " + (e && e.message ? e.message : String(e))); }
    }

    var PARENT = { name: "Aisha", email: "aisha@example.com" };

    // === ACCEPTANCE CRITERION ==============================================
    // A parent referring a NEW provider earns a voucher ONCE the provider is
    // APPROVED.
    check("ACCEPTANCE: parent earns a voucher once a new provider is approved", function () {
      var s = emptyState();
      var rec = recordReferral(s, {
        parentName: PARENT.name, parentEmail: PARENT.email,
        provider: { name: "New Sports Camp" }, isNewProvider: true
      });
      HC.assert(rec.added === true, "referral recorded");
      s = rec.state;

      // No voucher before approval.
      HC.assert(pendingReferrals(s).length === 1, "referral starts pending");
      HC.assert(earnedTotal(s, PARENT.email) === 0, "no voucher while pending");
      HC.assert(vouchersForParent(s, PARENT.email).length === 0, "wallet empty before approval");

      // Approve -> voucher issued.
      var out = approveReferral(s, s.referrals[0].id);
      HC.assert(out.ok === true, "approval succeeds for a new provider");
      HC.assert(!!out.voucher, "a voucher object is returned on approval");
      s = out.state;

      var vs = vouchersForParent(s, PARENT.email);
      HC.assert(vs.length === 1, "exactly one voucher issued, got " + vs.length);
      HC.assert(vs[0].amount === VOUCHER_AMOUNT, "voucher is £" + VOUCHER_AMOUNT + ", got " + vs[0].amount);
      HC.assert(vs[0].kind === VOUCHER_KIND, "voucher is an " + VOUCHER_KIND + " voucher, got " + vs[0].kind);
      HC.assert(earnedTotal(s, PARENT.email) === VOUCHER_AMOUNT, "parent has earned £" + VOUCHER_AMOUNT);
      HC.assert(approvedReferrals(s).length === 1, "the referral is now approved");
    });

    // The voucher goes to the email the parent referred with.
    check("Voucher is issued to the email used during the referral", function () {
      var s = recordReferral(emptyState(), {
        parentName: "Ben", parentEmail: "Ben.Carter@Example.com",
        provider: { name: "Coding Camp" }, isNewProvider: true
      }).state;
      var out = approveReferral(s, s.referrals[0].id);
      s = out.state;
      HC.assert(out.voucher && normEmail(out.voucher.parentEmail) === "ben.carter@example.com",
        "voucher recipient matches the referral email (normalised)");
      HC.assert(vouchersForParent(s, "BEN.CARTER@EXAMPLE.COM").length === 1,
        "voucher is retrievable by the parent's email, case-insensitively");
    });

    // The voucher is payable within 60 days (the fulfilment SLA).
    check("Voucher is payable within " + FULFIL_SLA_DAYS + " days of the successful referral", function () {
      var s = recordReferral(emptyState(), {
        parentName: PARENT.name, parentEmail: PARENT.email,
        provider: { name: "Tennis Camp" }, isNewProvider: true
      }).state;
      var out = approveReferral(s, s.referrals[0].id);
      var v = out.voucher;
      HC.assert(!!v.issuedAt && !!v.payableBy, "voucher has issuedAt and payableBy dates");
      var issued = new Date(v.issuedAt).getTime();
      var payable = new Date(v.payableBy).getTime();
      var diffDays = Math.round((payable - issued) / (1000 * 60 * 60 * 24));
      HC.assert(diffDays === FULFIL_SLA_DAYS,
        "payableBy is " + FULFIL_SLA_DAYS + " days after issue, got " + diffDays);
      HC.assert(/^HC-AMZ-/.test(v.code), "voucher carries an Amazon-style code, got " + v.code);
    });

    // === NEGATIVE CASES: no voucher unless approved & new ==================

    check("A pending referral earns NO voucher", function () {
      var s = recordReferral(emptyState(), {
        parentName: PARENT.name, parentEmail: PARENT.email,
        provider: { name: "Pending Camp" }, isNewProvider: true
      }).state;
      HC.assert(earnedTotal(s, PARENT.email) === 0, "pending earns nothing");
      HC.assert(allVouchers(s).length === 0, "no vouchers issued at all");
    });

    check("A rejected registration earns NO voucher", function () {
      var s = recordReferral(emptyState(), {
        parentName: PARENT.name, parentEmail: PARENT.email,
        provider: { name: "Declined Camp" }, isNewProvider: true
      }).state;
      var out = rejectReferral(s, s.referrals[0].id);
      HC.assert(out.ok === true, "rejection processed");
      s = out.state;
      HC.assert(s.referrals[0].status === STATUS.REJECTED, "status is rejected");
      HC.assert(earnedTotal(s, PARENT.email) === 0, "rejected earns nothing");
      HC.assert(allVouchers(s).length === 0, "no voucher in the ledger");
    });

    // === T&C: must be a NEW Provider (not current/previous/lapsed) =========

    check("An existing / lapsed provider does NOT qualify, even if approved", function () {
      var rec = recordReferral(emptyState(), {
        parentName: PARENT.name, parentEmail: PARENT.email,
        provider: { name: "Already Listed Camp" }, isNewProvider: false
      });
      HC.assert(rec.added === true, "the referral is still recorded");
      HC.assert(rec.reason === REASON.EXISTING_PROVIDER, "recorded with an existing-provider reason");
      var s = rec.state;
      var out = approveReferral(s, s.referrals[0].id);
      HC.assert(out.ok === false, "cannot approve a non-new provider for reward");
      HC.assert(out.reason === REASON.NOT_NEW, "reason cites the New-Provider rule");
      s = out.state;
      HC.assert(s.referrals[0].status === STATUS.REJECTED, "non-new referral ends rejected");
      HC.assert(earnedTotal(s, PARENT.email) === 0, "no voucher for an existing provider");
    });

    // === T&C: a provider can only be referred ONCE (first wins) ============

    check("The same provider cannot be referred twice — the first referral wins", function () {
      var s = emptyState();
      var first = recordReferral(s, {
        parentName: "First Parent", parentEmail: "first@example.com",
        provider: { id: "camp-x", name: "Camp X" }, isNewProvider: true
      });
      HC.assert(first.added === true, "first referral recorded");
      s = first.state;
      // Second parent refers the SAME camp (by id) — blocked.
      var second = recordReferral(s, {
        parentName: "Second Parent", parentEmail: "second@example.com",
        provider: { id: "camp-x", name: "Camp X (dup)" }, isNewProvider: true
      });
      HC.assert(second.added === false && second.reason === REASON.ALREADY_REFERRED,
        "the second referral of the same camp is blocked");
      s = second.state;
      HC.assert(s.referrals.length === 1, "still only one referral on record");
      // Approve; only the FIRST parent earns the voucher.
      var out = approveReferral(s, s.referrals[0].id);
      s = out.state;
      HC.assert(earnedTotal(s, "first@example.com") === VOUCHER_AMOUNT, "first parent earns the voucher");
      HC.assert(earnedTotal(s, "second@example.com") === 0, "second parent earns nothing");
    });

    check("Duplicate detection is case/punctuation-insensitive on provider name", function () {
      var s = recordReferral(emptyState(), {
        parentName: PARENT.name, parentEmail: PARENT.email,
        provider: { name: "Forest School Adventures!" }, isNewProvider: true
      }).state;
      var dup = recordReferral(s, {
        parentName: "Other", parentEmail: "other@example.com",
        provider: { name: "forest school adventures" }, isNewProvider: true
      });
      HC.assert(dup.added === false && dup.reason === REASON.ALREADY_REFERRED,
        "same camp by a differently-cased name is a duplicate");
    });

    // === Idempotency: approving twice never double-issues ==================

    check("Approving the same referral twice does not issue two vouchers", function () {
      var s = recordReferral(emptyState(), {
        parentName: PARENT.name, parentEmail: PARENT.email,
        provider: { name: "One Off Camp" }, isNewProvider: true
      }).state;
      var id = s.referrals[0].id;
      s = approveReferral(s, id).state;
      HC.assert(earnedTotal(s, PARENT.email) === VOUCHER_AMOUNT, "first approval issues one voucher");
      var again = approveReferral(s, id);
      HC.assert(again.ok === false && again.reason === REASON.ALREADY_DECIDED, "second approval is a no-op");
      s = again.state;
      HC.assert(allVouchers(s).length === 1, "still only one voucher in the ledger");
      HC.assert(earnedTotal(s, PARENT.email) === VOUCHER_AMOUNT, "balance unchanged after re-approval");
    });

    // === Rewards in vouchers only (never cash/credit) ======================

    check("Reward is an Amazon voucher only — never cash or account credit", function () {
      var s = recordReferral(emptyState(), {
        parentName: PARENT.name, parentEmail: PARENT.email,
        provider: { name: "Voucher Camp" }, isNewProvider: true
      }).state;
      var out = approveReferral(s, s.referrals[0].id);
      var v = out.voucher;
      HC.assert(v.kind === "Amazon", "kind is an Amazon voucher");
      HC.assert(!("cash" in v) && !("credit" in v), "no cash/credit fields exist on the reward");
      HC.assert(typeof v.code === "string" && v.code.length > 0, "voucher has a redeemable code");
    });

    // === Abuse controls: withhold rewards from flagged referrers ===========

    check("A flagged (abusive) referrer earns no voucher even on approval", function () {
      var s = emptyState();
      s = recordReferral(s, {
        parentName: "Cheater", parentEmail: "cheat@example.com",
        provider: { name: "Real New Camp" }, isNewProvider: true
      }).state;
      s = flagParent(s, "cheat@example.com");
      var out = approveReferral(s, s.referrals[0].id);
      HC.assert(out.ok === true, "the registration itself still stands");
      HC.assert(out.reason === REASON.ABUSE, "reason notes the reward was withheld");
      HC.assert(out.voucher === null, "no voucher object returned");
      s = out.state;
      HC.assert(earnedTotal(s, "cheat@example.com") === 0, "flagged referrer earns nothing");
      HC.assert(approvedReferrals(s).length === 1, "the provider is still approved");
    });

    // === Multiple successful referrals accumulate vouchers =================

    check("Multiple approved new-provider referrals accumulate vouchers", function () {
      var s = emptyState();
      for (var i = 1; i <= 4; i++) {
        s = recordReferral(s, {
          parentName: PARENT.name, parentEmail: PARENT.email,
          provider: { name: "New Camp " + i }, isNewProvider: true
        }).state;
      }
      HC.assert(s.referrals.length === 4, "four distinct referrals recorded");
      for (var j = 0; j < s.referrals.length; j++) {
        s = approveReferral(s, s.referrals[j].id).state;
      }
      HC.assert(approvedReferrals(s).length === 4, "all four approved");
      HC.assert(vouchersForParent(s, PARENT.email).length === 4, "four vouchers issued");
      HC.assert(earnedTotal(s, PARENT.email) === 4 * VOUCHER_AMOUNT,
        "parent earned £" + (4 * VOUCHER_AMOUNT) + ", got " + earnedTotal(s, PARENT.email));
    });

    // === Defensive against bad input =======================================

    check("Defensive: bad inputs never throw or corrupt state", function () {
      var s = emptyState();
      var r1 = recordReferral(s, null);
      HC.assert(r1.added === false && r1.reason === REASON.NO_PROVIDER, "null input is a safe no-op");
      var r2 = recordReferral(s, { parentEmail: "x@example.com", provider: {} });
      HC.assert(r2.added === false && r2.reason === REASON.NO_PROVIDER, "provider with no id/name is refused");
      var r3 = recordReferral(s, { provider: { name: "Camp" } }); // no parent email
      HC.assert(r3.added === false && r3.reason === REASON.NO_EMAIL, "parent without an email cannot refer");
      var ap = approveReferral(s, "does-not-exist");
      HC.assert(ap.ok === false && ap.reason === REASON.NOT_FOUND, "approving a missing referral is refused");
      HC.assert(earnedTotal(s, "x@example.com") === 0, "nothing was earned");
      HC.assert(earnedTotal(null, "x@example.com") === 0, "earnedTotal(null) is 0, not a throw");
      HC.assert(allVouchers(null).length === 0, "allVouchers(null) is [], not a throw");
      HC.assert(pendingReferrals(undefined).length === 0, "pendingReferrals(undefined) is safe");
    });

    // === Persistence round-trips through HC.store ==========================

    check("State persists via HC.store (namespaced, not raw localStorage)", function () {
      var s = recordReferral(emptyState(), {
        parentName: PARENT.name, parentEmail: PARENT.email,
        provider: { name: "Persist Camp" }, isNewProvider: true
      }).state;
      s = approveReferral(s, s.referrals[0].id).state;
      var beforeEarned = earnedTotal(s, PARENT.email);
      var ok = HC.store.set(STORE_KEY, s);
      HC.assert(ok !== false, "store.set should succeed");
      var got = HC.store.get(STORE_KEY, null);
      HC.assert(got && Array.isArray(got.referrals) && Array.isArray(got.vouchers),
        "referrals and vouchers survive a store round-trip");
      HC.assert(earnedTotal(got, PARENT.email) === beforeEarned, "earned total survives persistence");
      HC.assert(approvedReferrals(got).length === 1, "approval status survives persistence");
      try { HC.store.remove ? HC.store.remove(STORE_KEY) : HC.store.set(STORE_KEY, null); } catch (e) {}
    });

    // === Live data: the referral pool is framed for the real directory =====

    check("Referral pool draws on the live school-age holiday-camp directory", function () {
      var pool = referralPool();
      HC.assert(Array.isArray(pool) && pool.length > 0, "a referral pool is produced");
      var ps = providers();
      if (ps.length) {
        // The pool includes a genuinely-existing directory provider (not new).
        var hasExisting = pool.some(function (c) { return c && c.isNew === false; });
        HC.assert(hasExisting, "pool includes an existing directory camp that won't qualify");
        // And referring that existing camp + approving never pays out.
        var existing = pool.filter(function (c) { return c.isNew === false; })[0];
        var s = recordReferral(emptyState(), {
          parentName: PARENT.name, parentEmail: PARENT.email,
          provider: { id: existing.id, name: existing.name }, isNewProvider: existing.isNew
        }).state;
        var out = approveReferral(s, s.referrals[0].id);
        HC.assert(out.ok === false && out.reason === REASON.NOT_NEW,
          "a real existing directory camp cannot earn a voucher");
      }
    });

    return { pass: pass, fail: fail, log: log };
  }

  /* ============================================================ *
   *  register                                                     *
   * ============================================================ */

  HC.registerFeature({
    id: "platform-parent-referral",
    title: "Parent referral reward (£5 voucher)",
    side: "platform",
    icon: "🎟️",
    summary: "Parents refer local holiday-camp operators to HolidayCamp. When a referred camp registers as a NEW " +
      "provider and is approved, the parent earns a £5 Amazon voucher (vouchers only, no cash/credit), emailed to " +
      "their referral address within 60 days. A camp can only be referred once — first parent wins. Happity's " +
      "Parent Referral Programme, reframed for school-age camps.",
    render: render,
    selfTest: selfTest
  });
})();
