/* HolidayCamp feature — platform-provider-referral-credit
 *
 * Give-£10-Get-£10 provider referral CREDIT LEDGER  (PLATFORM side)
 *
 * Replicates Happity's referral-credit accounting, viewed from the PLATFORM's
 * side: the system of record that turns an approved referral into spendable
 * credit for BOTH parties and enforces what that credit can be spent on.
 * Evidence (support articles 4784863 & 6728942):
 *   - 4784863: "when they register using your unique link - we'll give you both
 *     £10 in Happity credit." -> an approved referral CREDITS BOTH PARTIES.
 *   - 4784863: "Credit can be used to: Upgrade to Membership / Renew your
 *     existing Membership / Promote your classes with Featured Listings."
 *     -> credit is spendable ONLY on PLATFORM SERVICES, nothing else.
 *   - T&C 03: "Following a SUCCESSFUL referral (... their registration is
 *     APPROVED) - a £10 credit will be added to both the ... account of the
 *     referrer and referee." -> credit lands ONLY on approval; pending /
 *     rejected award nothing.
 *   - T&C 05: "Credit can be used towards Membership payments (initial or
 *     renewal) and our Featured Listings service. The amount will automatically
 *     be removed from your next invoice." -> credit offsets a platform invoice.
 *   - T&C 06: "Credit will expire after 12 months and be removed."
 *   - T&C 07: "Credits are not transferable into cash." -> no cash-out.
 *   - T&C 08: only a "completely new registration (not a lapsed user) ...
 *     approved as eligible" counts -> the platform only books credit for a
 *     NEW + APPROVED referral.
 *
 * Framed for SCHOOL-AGE HOLIDAY CAMPS: providers are the holiday-camp operators
 * in the E17 directory (sports clubs, drama schools, forest-school runners).
 * The platform runs ONE credit ledger. When an existing camp operator refers a
 * brand-new operator and the platform APPROVES that new registration, the ledger
 * books two £10 credit entries — one to the referrer's wallet, one to the new
 * referee's wallet. Those wallets can only be spent against platform services
 * (Membership, Membership renewal, Featured Listings) — never cashed out, never
 * spent on a parent's camp booking. Credits expire 12 months after they land and
 * are spent oldest-first (FIFO) so they expire fairly.
 *
 * This is the PLATFORM ledger (balances, postings, the spend rule), distinct
 * from the provider-side "grab your unique link" widget (provider-referrals).
 *
 * ACCEPTANCE CRITERION (exercised by selfTest, multiple cases):
 *   An approved referral credits BOTH parties; credit is spendable ONLY on
 *   platform services.
 *
 * Self-contained, defensive, no imports/exports. Calls HC.registerFeature.
 */
(function () {
  "use strict";

  // Defensive: never throw at module load if HC isn't present.
  if (typeof window === "undefined" || !window.HC || typeof window.HC.registerFeature !== "function") {
    if (typeof console !== "undefined" && console.warn) {
      console.warn("[HC] platform-provider-referral-credit: HC core not found; skipping registration.");
    }
    return;
  }

  var HC = window.HC;
  var STORE_KEY = "platform_referral_credit_ledger";

  /* ----------------------------- constants ----------------------------- */

  var CREDIT_GIVE = 10;          // £ credited to the referrer on approval
  var CREDIT_GET = 10;           // £ credited to the new referee on approval
  var EXPIRY_MONTHS = 12;        // T&C 06: credit expires 12 months after it lands
  var MS_PER_DAY = 24 * 60 * 60 * 1000;

  // What a referral can resolve to. Only APPROVED books credit.
  var STATUS = { PENDING: "pending", APPROVED: "approved", REJECTED: "rejected" };

  // The ONLY things referral credit may be spent on (platform services).
  // Anything not in this set is a non-platform spend and must be refused.
  var SERVICES = {
    membership: { id: "membership", label: "Membership (new)", price: 60 },
    renewal: { id: "renewal", label: "Membership renewal", price: 60 },
    featured: { id: "featured", label: "Featured Listing", price: 25 }
  };
  function isPlatformService(serviceId) {
    return Object.prototype.hasOwnProperty.call(SERVICES, String(serviceId));
  }

  /* ===================================================================== *
   *  PURE LEDGER LOGIC (DOM-free, deterministic, testable)                *
   *  Every mutator returns a NEW state; nothing mutates inputs in place,  *
   *  so selfTest can run against fresh literals and a `now` can be passed *
   *  in to exercise expiry deterministically.                            *
   * ===================================================================== */

  // State shape:
  //   {
  //     wallets: { <providerId>: { id, name, entries:[ Entry ], spend:[ Spend ] } },
  //     referrals: [ Referral ]
  //   }
  //   Entry  = { id, amount, reason, refId, role:'referrer'|'referee',
  //              awardedAt, expiresAt }   // a credit POSTING into a wallet
  //   Spend  = { id, serviceId, amount, at }   // a debit against the wallet
  //   Referral = { id, referrerId, referrerName, refereeId, refereeName,
  //                isNewRegistration, status, createdAt, decidedAt }

  function emptyState() {
    return { wallets: {}, referrals: [] };
  }

  function clone(state) {
    try {
      return JSON.parse(JSON.stringify(state || emptyState()));
    } catch (e) {
      return emptyState();
    }
  }

  function uid(prefix) {
    try {
      if (HC.util && typeof HC.util.uid === "function") return HC.util.uid();
    } catch (e) { /* ignore */ }
    return (prefix || "id") + "_" + Math.random().toString(36).slice(2, 10);
  }

  function addMonths(ts, months) {
    var d = new Date(ts);
    if (isNaN(d.getTime())) d = new Date();
    d.setMonth(d.getMonth() + months);
    return d.getTime();
  }

  function ensureWallet(state, providerId, name) {
    var id = String(providerId);
    if (!state.wallets[id]) {
      state.wallets[id] = { id: id, name: name || id, entries: [], spend: [] };
    } else if (name && state.wallets[id].name === id) {
      state.wallets[id].name = name;
    }
    return state.wallets[id];
  }

  // ---- record a referral (does NOT credit; pending until reviewed) ----
  function recordReferral(state, referral) {
    var next = clone(state);
    var referrerId = String((referral && referral.referrerId) || "");
    var refereeId = String((referral && referral.refereeId) || "");
    if (!referrerId) throw new Error("recordReferral: referrerId required");
    if (!refereeId) throw new Error("recordReferral: refereeId required");
    if (referrerId === refereeId) throw new Error("recordReferral: cannot refer yourself");

    ensureWallet(next, referrerId, (referral && referral.referrerName) || referrerId);
    // The referee wallet is created lazily on approval (they may be brand new).

    var rec = {
      id: uid("ref"),
      referrerId: referrerId,
      referrerName: (referral && referral.referrerName) || referrerId,
      refereeId: refereeId,
      refereeName: (referral && referral.refereeName) || refereeId,
      // T&C 08: must be a completely new registration, not a lapsed user.
      isNewRegistration: referral && referral.isNewRegistration !== false,
      status: STATUS.PENDING,
      createdAt: (referral && referral.createdAt) || Date.now(),
      decidedAt: null
    };
    next.referrals.push(rec);
    return next;
  }

  // ---- post a credit entry to a wallet ----
  function postCredit(wallet, amount, reason, refId, role, awardedAt) {
    var when = awardedAt || Date.now();
    wallet.entries.push({
      id: uid("cr"),
      amount: amount,
      reason: reason,
      refId: refId,
      role: role,
      awardedAt: when,
      expiresAt: addMonths(when, EXPIRY_MONTHS)
    });
  }

  // ---- decide a pending referral: 'approved' | 'rejected' ----
  // On APPROVE of a NEW registration, BOTH parties are credited (give/get).
  function decideReferral(state, refId, decision, decidedAt) {
    var next = clone(state);
    var rec = next.referrals.filter(function (r) { return r.id === refId; })[0];
    if (!rec) throw new Error("decideReferral: referral not found");
    if (rec.status !== STATUS.PENDING) {
      throw new Error("decideReferral: already " + rec.status);
    }
    var when = decidedAt || Date.now();

    if (decision === STATUS.APPROVED) {
      // T&C 08: a lapsed / existing registration cannot be approved for credit.
      if (!rec.isNewRegistration) {
        rec.status = STATUS.REJECTED;
        rec.decidedAt = when;
        return next;
      }
      rec.status = STATUS.APPROVED;
      rec.decidedAt = when;

      var referrer = ensureWallet(next, rec.referrerId, rec.referrerName);
      var referee = ensureWallet(next, rec.refereeId, rec.refereeName);
      // GIVE £10 to referrer, GET £10 to referee — both parties credited.
      postCredit(referrer, CREDIT_GIVE, "Referral reward (give)", rec.id, "referrer", when);
      postCredit(referee, CREDIT_GET, "Welcome credit (get)", rec.id, "referee", when);
    } else {
      rec.status = STATUS.REJECTED;
      rec.decidedAt = when;
    }
    return next;
  }

  /* ---- balance helpers (live, non-expired credit only) ---- */

  function liveEntries(wallet, now) {
    var t = now || Date.now();
    return (wallet && wallet.entries ? wallet.entries : []).filter(function (e) {
      return e.expiresAt > t;
    });
  }

  function grossCredited(wallet) {
    return (wallet && wallet.entries ? wallet.entries : []).reduce(function (s, e) {
      return s + (Number(e.amount) || 0);
    }, 0);
  }

  function totalSpent(wallet) {
    return (wallet && wallet.spend ? wallet.spend : []).reduce(function (s, x) {
      return s + (Number(x.amount) || 0);
    }, 0);
  }

  // Spendable balance = live (non-expired) credit minus what's already spent.
  // Spend is applied FIFO (oldest entry first), so expired entries fall away
  // before they could have been used.
  function balance(wallet, now) {
    var live = liveEntries(wallet, now).reduce(function (s, e) {
      return s + (Number(e.amount) || 0);
    }, 0);
    var available = live - totalSpent(wallet);
    return available > 0 ? available : 0;
  }

  function expiredAmount(wallet, now) {
    var t = now || Date.now();
    return (wallet && wallet.entries ? wallet.entries : [])
      .filter(function (e) { return e.expiresAt <= t; })
      .reduce(function (s, e) { return s + (Number(e.amount) || 0); }, 0);
  }

  /* ---- spend credit against a PLATFORM SERVICE only ---- */
  // Returns { state, applied, charged, refused?, reason? }.
  // Hard rules:
  //   * serviceId MUST be a platform service (else refused — no cash-out, T&C 07).
  //   * credit covers up to the live balance; the rest is "charged" to card.
  function spendOnService(state, providerId, serviceId, now) {
    var next = clone(state);
    var id = String(providerId);
    var wallet = next.wallets[id];
    if (!wallet) throw new Error("spendOnService: no wallet for " + id);

    // ENFORCE: referral credit is spendable ONLY on platform services.
    if (!isPlatformService(serviceId)) {
      return {
        state: state, // unchanged
        applied: 0,
        charged: 0,
        refused: true,
        reason: "Referral credit can only be spent on platform services " +
          "(Membership, renewal, Featured Listings) — not " + serviceId + "."
      };
    }

    var svc = SERVICES[serviceId];
    var price = svc.price;
    var avail = balance(wallet, now);
    var applied = Math.min(avail, price);
    var charged = price - applied;

    if (applied > 0) {
      wallet.spend.push({
        id: uid("sp"),
        serviceId: serviceId,
        amount: applied,
        at: now || Date.now()
      });
    }
    return { state: next, applied: applied, charged: charged, refused: false, reason: null, service: svc };
  }

  /* ---- persistence (mock, via HC.store) ---- */
  function load() {
    try {
      var raw = HC.store.get(STORE_KEY, null);
      if (raw && typeof raw === "object" && raw.wallets) return raw;
    } catch (e) { /* ignore */ }
    return seedDemo();
  }
  function save(state) {
    try { HC.store.set(STORE_KEY, state); } catch (e) { /* ignore */ }
    return state;
  }

  // Seed a small demo from live providers so the UI has something to show.
  function seedDemo() {
    var s = emptyState();
    var providers = [];
    try { providers = HC.data.providers || []; } catch (e) { providers = []; }
    var referrer = providers[0] || { id: "camp-a", name: "Wildwood Forest Camp" };
    var refereeNew = providers[1] || { id: "camp-b", name: "Striker Soccer School" };
    var refereeLapsed = providers[2] || { id: "camp-c", name: "Encore Drama Holidays" };

    s = recordReferral(s, {
      referrerId: referrer.id, referrerName: referrer.name,
      refereeId: refereeNew.id, refereeName: refereeNew.name,
      isNewRegistration: true
    });
    s = recordReferral(s, {
      referrerId: referrer.id, referrerName: referrer.name,
      refereeId: refereeLapsed.id, refereeName: refereeLapsed.name,
      isNewRegistration: false // lapsed/existing — must be rejected on review
    });
    // Approve the first (credits both), leave the second pending for the demo UI.
    s = decideReferral(s, s.referrals[0].id, STATUS.APPROVED);
    return s;
  }

  /* ===================================================================== *
   *  RENDER (UI) — defensive, draws into mountEl only.                    *
   * ===================================================================== */

  function money(n) {
    try { return HC.util.money(n); } catch (e) { return "£" + n; }
  }
  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function render(mountEl) {
    if (!mountEl) return;
    var state = load();

    function persistAndRedraw(next) { save(next); draw(); }

    function draw() {
      state = load();
      var wallets = Object.keys(state.wallets).map(function (k) { return state.wallets[k]; });
      var pending = state.referrals.filter(function (r) { return r.status === STATUS.PENDING; });

      var html = "";
      html += '<p style="font-size:14px;color:var(--text,#383838);margin:0 0 14px">' +
        "When the platform <b>approves</b> a brand-new camp operator referred by an existing one, " +
        "the ledger books <b>" + money(CREDIT_GIVE) + " to the referrer</b> and <b>" + money(CREDIT_GET) +
        " to the new operator</b>. That credit can only be spent on <b>platform services</b> " +
        "(Membership, renewal, Featured Listings) — never cashed out, and never against a parent's booking." +
        "</p>";

      // Pending referrals — approve/reject controls.
      html += '<div style="font-family:Quicksand,system-ui,sans-serif;font-weight:700;color:var(--magenta,#F82488);' +
        'text-transform:uppercase;letter-spacing:.5px;font-size:12px;margin:6px 0 8px">Pending review</div>';
      if (!pending.length) {
        html += '<p style="color:var(--muted,#808080);font-size:13px;margin:0 0 14px">No referrals awaiting review.</p>';
      } else {
        html += '<div style="display:flex;flex-direction:column;gap:8px;margin-bottom:16px">';
        pending.forEach(function (r) {
          html += '<div style="border:1.5px solid var(--line,#E6E6E6);border-radius:14px;padding:11px 13px;' +
            'display:flex;align-items:center;gap:10px;flex-wrap:wrap">' +
            '<div style="flex:1;min-width:180px;font-size:13.5px">' +
              "<b>" + esc(r.referrerName) + "</b> referred <b>" + esc(r.refereeName) + "</b>" +
              '<div style="color:var(--muted,#808080);font-size:12px">' +
                (r.isNewRegistration ? "New registration" : "⚠ Lapsed / existing — not eligible") +
              "</div>" +
            "</div>" +
            '<button class="hc-btn" data-prc-approve="' + esc(r.id) + '">Approve</button>' +
            '<button class="hc-btn hc-btn-ghost" data-prc-reject="' + esc(r.id) + '">Reject</button>' +
            "</div>";
        });
        html += "</div>";
      }

      // Wallets / ledger.
      html += '<div style="font-family:Quicksand,system-ui,sans-serif;font-weight:700;color:var(--magenta,#F82488);' +
        'text-transform:uppercase;letter-spacing:.5px;font-size:12px;margin:6px 0 8px">Credit wallets</div>';
      if (!wallets.length) {
        html += '<p style="color:var(--muted,#808080);font-size:13px">No credit awarded yet.</p>';
      } else {
        html += '<div style="display:flex;flex-direction:column;gap:10px">';
        wallets.forEach(function (w) {
          var bal = balance(w);
          html += '<div style="border:1.5px solid var(--line,#E6E6E6);border-radius:16px;padding:13px 15px">' +
            '<div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap">' +
              '<div style="font-family:Quicksand,system-ui,sans-serif;font-weight:700;color:var(--purple,#603488);font-size:15px">' +
                esc(w.name) + "</div>" +
              '<div style="font-family:Quicksand,system-ui,sans-serif;font-weight:700;font-size:16px;color:' +
                (bal > 0 ? "#2f7d4f" : "var(--muted,#808080)") + '">' + money(bal) + " available</div>" +
            "</div>";
          // spend buttons (platform services only) + a deliberately blocked one
          if (bal > 0) {
            html += '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:9px">';
            Object.keys(SERVICES).forEach(function (sid) {
              var svc = SERVICES[sid];
              html += '<button class="hc-btn hc-btn-ghost" style="font-size:11px" ' +
                'data-prc-spend="' + esc(w.id) + '" data-prc-svc="' + esc(sid) + '">' +
                esc(svc.label) + " · " + money(svc.price) + "</button>";
            });
            // The refusal path, made visible: spending on a parent booking is blocked.
            html += '<button class="hc-btn hc-btn-ghost" style="font-size:11px;border-color:#f3c2d6;color:#9a1f5e" ' +
              'data-prc-spend="' + esc(w.id) + '" data-prc-svc="camp-booking">Camp booking (blocked)</button>';
            html += "</div>";
          }
          // ledger lines
          var lines = (w.entries || []).map(function (e) {
            return '<li style="color:#2f7d4f">+ ' + money(e.amount) + " · " + esc(e.reason) +
              ' <span style="color:var(--muted,#808080)">(' + esc(e.role) + ")</span></li>";
          }).concat((w.spend || []).map(function (sp) {
            var label = SERVICES[sp.serviceId] ? SERVICES[sp.serviceId].label : sp.serviceId;
            return '<li style="color:#9a1f5e">− ' + money(sp.amount) + " · " + esc(label) + "</li>";
          }));
          if (lines.length) {
            html += '<ul style="list-style:none;padding:0;margin:9px 0 0;font-size:12.5px;line-height:1.8">' +
              lines.join("") + "</ul>";
          }
          html += "</div>";
        });
        html += "</div>";
      }

      html += '<div style="margin-top:16px;display:flex;gap:8px;flex-wrap:wrap">' +
        '<button class="hc-btn hc-btn-ghost" data-prc-reset="1">Reset demo ledger</button>' +
        "</div>";

      mountEl.innerHTML = html;
    }

    // Delegated clicks, scoped to this mount.
    mountEl.addEventListener("click", function (e) {
      var t = e.target.closest("[data-prc-approve],[data-prc-reject],[data-prc-spend],[data-prc-reset]");
      if (!t || !mountEl.contains(t)) return;
      try {
        if (t.hasAttribute("data-prc-approve")) {
          persistAndRedraw(decideReferral(state, t.getAttribute("data-prc-approve"), STATUS.APPROVED));
          HC.util.toast("Approved — both parties credited " + money(CREDIT_GIVE));
        } else if (t.hasAttribute("data-prc-reject")) {
          persistAndRedraw(decideReferral(state, t.getAttribute("data-prc-reject"), STATUS.REJECTED));
          HC.util.toast("Referral rejected — no credit awarded");
        } else if (t.hasAttribute("data-prc-spend")) {
          var wid = t.getAttribute("data-prc-spend");
          var sid = t.getAttribute("data-prc-svc");
          var out = spendOnService(state, wid, sid);
          if (out.refused) {
            HC.util.toast("✗ " + out.reason);
          } else {
            persistAndRedraw(out.state);
            HC.util.toast("Applied " + money(out.applied) + " credit · " +
              money(out.charged) + " to card");
          }
        } else if (t.hasAttribute("data-prc-reset")) {
          var fresh = seedDemo();
          persistAndRedraw(fresh);
          HC.util.toast("Demo ledger reset");
        }
      } catch (err) {
        HC.util.toast("✗ " + (err && err.message ? err.message : String(err)));
      }
    });

    draw();
  }

  /* ===================================================================== *
   *  SELF-TEST — exercises the ledger LOGIC and the acceptance criterion. *
   * ===================================================================== */

  function selfTest() {
    var pass = 0, fail = 0, log = [];
    function check(label, fn) {
      try { fn(); pass += 1; log.push("✓ " + label); }
      catch (e) { fail += 1; log.push("✗ " + label + " — " + (e && e.message ? e.message : String(e))); }
    }

    var A = { id: "p_referrer", name: "Wildwood Forest Camp" };
    var B = { id: "p_referee", name: "Striker Soccer School" };

    // 1. ACCEPTANCE (part 1): an approved referral credits BOTH parties.
    check("Approved referral credits BOTH referrer and referee " +
      money(CREDIT_GIVE) + "/" + money(CREDIT_GET), function () {
      var s = recordReferral(emptyState(), {
        referrerId: A.id, referrerName: A.name,
        refereeId: B.id, refereeName: B.name, isNewRegistration: true
      });
      var refId = s.referrals[0].id;
      s = decideReferral(s, refId, STATUS.APPROVED);
      HC.assert(s.referrals[0].status === STATUS.APPROVED, "referral should be approved");
      HC.assert(balance(s.wallets[A.id]) === CREDIT_GIVE,
        "referrer balance should be " + CREDIT_GIVE + ", got " + balance(s.wallets[A.id]));
      HC.assert(balance(s.wallets[B.id]) === CREDIT_GET,
        "referee balance should be " + CREDIT_GET + ", got " + balance(s.wallets[B.id]));
      // two postings, one per party
      HC.assert(s.wallets[A.id].entries.length === 1 && s.wallets[A.id].entries[0].role === "referrer",
        "referrer should have one 'referrer' posting");
      HC.assert(s.wallets[B.id].entries.length === 1 && s.wallets[B.id].entries[0].role === "referee",
        "referee should have one 'referee' posting");
    });

    // 2. ACCEPTANCE (part 2): credit is spendable on a PLATFORM SERVICE.
    check("Credit is spendable on a platform service (Featured Listing)", function () {
      var s = approvedSample();
      var before = balance(s.wallets[A.id]);
      var out = spendOnService(s, A.id, "featured"); // £25 service, £10 credit
      HC.assert(!out.refused, "platform-service spend must not be refused");
      HC.assert(out.applied === Math.min(before, SERVICES.featured.price),
        "should apply " + Math.min(before, SERVICES.featured.price) + " credit, got " + out.applied);
      HC.assert(out.charged === SERVICES.featured.price - out.applied,
        "remainder should be charged to card");
      HC.assert(balance(out.state.wallets[A.id]) === before - out.applied,
        "balance should drop by the applied credit");
    });

    // 3. ACCEPTANCE (negative): credit is NOT spendable off-platform (no cash-out).
    check("Credit is NOT spendable on a non-platform thing (parent booking / cash)", function () {
      var s = approvedSample();
      var before = balance(s.wallets[A.id]);
      var booking = spendOnService(s, A.id, "camp-booking"); // a parent's booking
      HC.assert(booking.refused === true, "spending credit on a camp booking must be refused");
      HC.assert(booking.applied === 0, "no credit may be applied off-platform");
      var cash = spendOnService(s, A.id, "cash-out"); // T&C 07: not transferable to cash
      HC.assert(cash.refused === true, "cash-out must be refused (credit not transferable to cash)");
      // balance untouched by refused attempts
      HC.assert(balance(s.wallets[A.id]) === before, "refused spend must not move the balance");
    });

    // 4. Only APPROVAL books credit — pending awards nothing.
    check("A pending referral awards no credit", function () {
      var s = recordReferral(emptyState(), {
        referrerId: A.id, referrerName: A.name, refereeId: B.id, refereeName: B.name,
        isNewRegistration: true
      });
      HC.assert(s.referrals[0].status === STATUS.PENDING, "should start pending");
      HC.assert(!s.wallets[B.id] || balance(s.wallets[B.id]) === 0, "referee gets nothing while pending");
      HC.assert(balance(s.wallets[A.id]) === 0, "referrer gets nothing while pending");
    });

    // 5. Rejected referral books no credit.
    check("A rejected referral awards no credit to either party", function () {
      var s = recordReferral(emptyState(), {
        referrerId: A.id, referrerName: A.name, refereeId: B.id, refereeName: B.name,
        isNewRegistration: true
      });
      s = decideReferral(s, s.referrals[0].id, STATUS.REJECTED);
      HC.assert(s.referrals[0].status === STATUS.REJECTED, "should be rejected");
      HC.assert(balance(s.wallets[A.id]) === 0, "referrer balance must stay 0");
      HC.assert(!s.wallets[B.id] || balance(s.wallets[B.id]) === 0, "referee balance must stay 0");
    });

    // 6. T&C 08: a lapsed/existing (not new) registration is auto-rejected, no credit.
    check("Approving a lapsed/existing registration awards no credit (T&C 08)", function () {
      var s = recordReferral(emptyState(), {
        referrerId: A.id, referrerName: A.name, refereeId: B.id, refereeName: B.name,
        isNewRegistration: false // lapsed/existing
      });
      s = decideReferral(s, s.referrals[0].id, STATUS.APPROVED);
      HC.assert(s.referrals[0].status === STATUS.REJECTED,
        "lapsed registration must not be approved for credit");
      HC.assert(balance(s.wallets[A.id]) === 0, "no credit for a lapsed referral");
    });

    // 7. Self-referral is refused.
    check("A provider cannot refer themselves", function () {
      var threw = false;
      try {
        recordReferral(emptyState(), {
          referrerId: A.id, referrerName: A.name, refereeId: A.id, refereeName: A.name
        });
      } catch (e) { threw = true; }
      HC.assert(threw, "self-referral should throw");
    });

    // 8. T&C 06: credit expires after 12 months and stops being spendable.
    check("Credit expires after 12 months and is no longer spendable", function () {
      var t0 = Date.UTC(2025, 0, 1); // fixed award time
      var s = recordReferral(emptyState(), {
        referrerId: A.id, referrerName: A.name, refereeId: B.id, refereeName: B.name,
        isNewRegistration: true, createdAt: t0
      });
      s = decideReferral(s, s.referrals[0].id, STATUS.APPROVED, t0);
      var justBefore = t0 + (365 - 1) * MS_PER_DAY;
      var wellAfter = t0 + 400 * MS_PER_DAY;
      HC.assert(balance(s.wallets[A.id], justBefore) === CREDIT_GIVE,
        "credit live before 12 months");
      HC.assert(balance(s.wallets[A.id], wellAfter) === 0,
        "credit must be 0 after 12-month expiry");
      HC.assert(expiredAmount(s.wallets[A.id], wellAfter) === CREDIT_GIVE,
        "expired amount should be tracked");
      // an expired wallet cannot fund a platform service either
      var out = spendOnService(s, A.id, "featured", wellAfter);
      HC.assert(out.applied === 0, "expired credit must apply nothing");
      HC.assert(out.charged === SERVICES.featured.price, "full price charged once credit expired");
    });

    // 9. Multiple approved referrals accumulate; spend draws down the balance.
    check("Credits accumulate across referrals and draw down on spend", function () {
      var C = { id: "p_third", name: "Encore Drama Holidays" };
      var s = emptyState();
      s = recordReferral(s, { referrerId: A.id, referrerName: A.name, refereeId: B.id, refereeName: B.name, isNewRegistration: true });
      s = decideReferral(s, s.referrals[0].id, STATUS.APPROVED);
      s = recordReferral(s, { referrerId: A.id, referrerName: A.name, refereeId: C.id, refereeName: C.name, isNewRegistration: true });
      s = decideReferral(s, s.referrals[1].id, STATUS.APPROVED);
      HC.assert(balance(s.wallets[A.id]) === CREDIT_GIVE * 2,
        "referrer should have two rewards = " + (CREDIT_GIVE * 2));
      // spend on membership (£60): applies all £20 credit, charges £40
      var out = spendOnService(s, A.id, "membership");
      HC.assert(out.applied === 20, "should apply £20 of credit, got " + out.applied);
      HC.assert(out.charged === 40, "should charge £40 to card, got " + out.charged);
      HC.assert(balance(out.state.wallets[A.id]) === 0, "balance should be 0 after spend");
    });

    // 10. Credit never goes negative and can't be over-spent.
    check("A wallet cannot be over-spent (no negative balance)", function () {
      var s = approvedSample(); // £10 credit
      var out1 = spendOnService(s, A.id, "featured"); // applies £10, charges £15
      HC.assert(balance(out1.state.wallets[A.id]) === 0, "balance 0 after spend");
      var out2 = spendOnService(out1.state, A.id, "featured"); // nothing left
      HC.assert(out2.applied === 0, "no credit left to apply");
      HC.assert(out2.charged === SERVICES.featured.price, "whole price to card");
      HC.assert(balance(out2.state.wallets[A.id]) === 0, "balance stays at 0, never negative");
    });

    // helper: a state with A having exactly one approved £10 reward.
    function approvedSample() {
      var s = recordReferral(emptyState(), {
        referrerId: A.id, referrerName: A.name, refereeId: B.id, refereeName: B.name,
        isNewRegistration: true
      });
      return decideReferral(s, s.referrals[0].id, STATUS.APPROVED);
    }

    return { pass: pass, fail: fail, log: log };
  }

  /* ------------------------------ register ------------------------------ */
  HC.registerFeature({
    id: "platform-provider-referral-credit",
    title: "Give-£10-Get-£10 referral credit ledger",
    side: "platform",
    icon: "💷",
    summary: "The platform credit ledger behind Give-£10-Get-£10: an approved referral books " +
      money(CREDIT_GIVE) + " to the referrer and " + money(CREDIT_GET) + " to the new operator. " +
      "Credit is spendable only on platform services (Membership, renewal, Featured Listings), " +
      "never cashed out, and expires after 12 months.",
    render: render,
    selfTest: selfTest
  });
})();
