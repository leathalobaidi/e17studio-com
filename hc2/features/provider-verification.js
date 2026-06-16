/* HolidayCamp feature — provider-verification
 *
 * Manual verification -> activation email -> set password  (PROVIDER side)
 *
 * Replicates Happity's onboarding-approval flow. Evidence (support articles):
 *   - 6305972 "I've just signed up, what do I do next?":
 *       "Once you are registered, your details will come through to our team who
 *        will VERIFY your details ensuring you are an eligible business. Once
 *        APPROVED you will receive an 'ACTIVATION EMAIL' and this will allow you
 *        to SET A PASSWORD for your account and login."
 *   - 6082049 "I have not received any login details yet?":
 *       "We check every registration before approving it ... Each approval should
 *        take no more than 24 hours." (Manual review precedes the activation email.)
 *   - 5917325 "Can I add extra users to my account?":
 *       "Once you have created the new user, press the envelope symbol next to
 *        their name. This sends them their ACTIVATION EMAIL; they will then be
 *        required to ACTIVATE their account and CREATE A LOGIN PASSWORD."
 *       (The same activation -> set-password step is reused for extra users, and
 *        the envelope symbol RE-SENDS it.)
 *
 * Framed for SCHOOL-AGE HOLIDAY CAMPS: a holiday-camp operator registers to list
 * their school-holiday camps. The account starts as 'pending verification'. A
 * human reviewer checks the business is eligible (a legitimate school-age camp
 * provider), then APPROVES it, which issues an activation email carrying a
 * single-use token. Following that token lets the provider set a password and
 * the account becomes active. Rejected registrations never get an activation
 * email. Extra dashboard users go through the identical activation/set-password
 * step, and their activation email can be re-sent.
 *
 * ACCEPTANCE CRITERION (exercised by selfTest):
 *   New accounts show 'pending verification'; activation issues a set-password step.
 *
 * Self-contained, defensive, no imports/exports. Calls HC.registerFeature.
 */
(function () {
  "use strict";

  // Defensive: never throw at module load if HC isn't present.
  if (typeof window === "undefined" || !window.HC || typeof window.HC.registerFeature !== "function") {
    if (typeof console !== "undefined" && console.warn) {
      console.warn("[HC] provider-verification: HC core not found; skipping registration.");
    }
    return;
  }

  var HC = window.HC;

  var STORE_KEY = "provider_verification_state";

  // Account lifecycle statuses (the state machine).
  var STATUS = {
    PENDING: "pending verification", // brand-new registration, awaiting human review
    REJECTED: "rejected",            // reviewer judged the business ineligible
    INVITED: "activation sent",      // approved: activation email issued, password not yet set
    ACTIVE: "active"                 // provider followed the link and set a password -> can log in
  };

  // Minimum password strength for the set-password step (mock policy).
  var MIN_PASSWORD = 8;

  /* ---------------- pure logic (testable, DOM-free) ----------------
   *
   * The whole feature state is a single object persisted via HC.store:
   *   {
   *     accounts: {
   *       <accountId>: {
   *         id, businessName, contactEmail, providerId,
   *         role: 'owner' | 'extra-user',
   *         status: one of STATUS.*,
   *         registeredAt: ISOString,
   *         reviewedAt: ISOString|null,
   *         reviewerNote: String|null,
   *         activation: null | {
   *           token: String,          // single-use activation token
   *           sentAt: ISOString,
   *           sendCount: Number,      // re-sends (the "envelope symbol")
   *           consumedAt: ISOString|null
   *         },
   *         passwordSet: Boolean,
   *         passwordHash: String|null // mock-only, never a real hash
   *       }
   *     }
   *   }
   *
   * Pure functions take a state and return a NEW state — never mutate in place,
   * so tests can run against fresh literals without touching storage.
   */

  function emptyState() {
    return { accounts: {} };
  }

  function cloneState(state) {
    try {
      return JSON.parse(JSON.stringify(state || {}));
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

  // A mock single-use token. Looks like an activation token in a real email link.
  function makeToken() {
    return "act_" + safeUid().replace(/[^a-z0-9]/gi, "").slice(0, 18);
  }

  // A deliberately fake, reversible "hash" — this is a mock, never real auth.
  function mockHash(pw) {
    return "mock$" + String(pw == null ? "" : pw).length + "$" + safeUid().slice(0, 6);
  }

  function getAccount(state, accountId) {
    return (state && state.accounts && state.accounts[accountId]) || null;
  }

  // STEP 1 — REGISTER. A brand-new account always starts 'pending verification'.
  // No activation email exists yet, and no password can be set.
  //   reg = { businessName, contactEmail, providerId, role }
  function registerAccount(state, reg) {
    var next = cloneState(state);
    if (!next.accounts) next.accounts = {};
    reg = reg || {};
    var id = reg.id || safeUid();
    next.accounts[id] = {
      id: id,
      businessName: String(reg.businessName || "Unnamed camp business"),
      contactEmail: String(reg.contactEmail || ""),
      providerId: reg.providerId || null,
      role: reg.role === "extra-user" ? "extra-user" : "owner",
      status: STATUS.PENDING,
      registeredAt: nowIso(),
      reviewedAt: null,
      reviewerNote: null,
      activation: null,
      passwordSet: false,
      passwordHash: null
    };
    return { state: next, accountId: id };
  }

  function isPending(account) {
    return !!account && account.status === STATUS.PENDING;
  }

  // STEP 2a — APPROVE (manual verification passes). This is the human reviewer
  // confirming the business is an eligible school-age holiday-camp provider.
  // Approval ISSUES THE ACTIVATION EMAIL: it mints a single-use token and sets
  // status to 'activation sent'. Returns { state, activation }.
  function approveAccount(state, accountId, reviewerNote) {
    var next = cloneState(state);
    var acc = getAccount(next, accountId);
    if (!acc) return { state: next, activation: null };
    // Only a pending account can be approved. (Idempotent guard: an already
    // invited/active/rejected account is left untouched.)
    if (acc.status !== STATUS.PENDING) return { state: next, activation: getAccountActivation(acc) };

    acc.status = STATUS.INVITED;
    acc.reviewedAt = nowIso();
    acc.reviewerNote = reviewerNote ? String(reviewerNote) : null;
    acc.activation = {
      token: makeToken(),
      sentAt: nowIso(),
      sendCount: 1,
      consumedAt: null
    };
    return { state: next, activation: { token: acc.activation.token, email: acc.contactEmail } };
  }

  // STEP 2b — REJECT (manual verification fails). No activation email is ever
  // issued; the provider cannot proceed to set a password.
  function rejectAccount(state, accountId, reviewerNote) {
    var next = cloneState(state);
    var acc = getAccount(next, accountId);
    if (!acc) return next;
    if (acc.status !== STATUS.PENDING) return next; // only pending can be rejected
    acc.status = STATUS.REJECTED;
    acc.reviewedAt = nowIso();
    acc.reviewerNote = reviewerNote ? String(reviewerNote) : "Not an eligible school-age camp provider";
    acc.activation = null;
    return next;
  }

  function getAccountActivation(acc) {
    if (!acc || !acc.activation) return null;
    return { token: acc.activation.token, email: acc.contactEmail };
  }

  // RE-SEND the activation email (the "envelope symbol" in evidence 5917325).
  // Only valid for an invited account whose token hasn't been consumed yet.
  // It re-issues a FRESH token (invalidating any older link) and bumps sendCount.
  function resendActivation(state, accountId) {
    var next = cloneState(state);
    var acc = getAccount(next, accountId);
    if (!acc || acc.status !== STATUS.INVITED || !acc.activation || acc.activation.consumedAt) {
      return { state: next, activation: getAccountActivation(acc), resent: false };
    }
    acc.activation.token = makeToken();
    acc.activation.sentAt = nowIso();
    acc.activation.sendCount = (Number(acc.activation.sendCount) || 0) + 1;
    return { state: next, activation: { token: acc.activation.token, email: acc.contactEmail }, resent: true };
  }

  // Does this token currently open the SET-PASSWORD step? True only when the
  // account is invited, the token matches, and it hasn't been consumed.
  function tokenOpensSetPassword(state, accountId, token) {
    var acc = getAccount(state, accountId);
    if (!acc || acc.status !== STATUS.INVITED || !acc.activation) return false;
    if (acc.activation.consumedAt) return false;
    return !!token && acc.activation.token === token;
  }

  function passwordError(password) {
    var pw = password == null ? "" : String(password);
    if (pw.length < MIN_PASSWORD) {
      return "Password must be at least " + MIN_PASSWORD + " characters.";
    }
    if (!/[0-9]/.test(pw)) return "Password must include at least one number.";
    return null;
  }

  // STEP 3 — ACTIVATE: follow the activation link's token and SET A PASSWORD.
  // Validates the token, enforces the password policy, then activates the
  // account, consumes the token (single-use), and records the password.
  // Returns { state, ok, error }.
  function activateWithPassword(state, accountId, token, password) {
    var next = cloneState(state);
    var acc = getAccount(next, accountId);
    if (!acc) return { state: next, ok: false, error: "Account not found." };
    if (acc.status === STATUS.PENDING) {
      return { state: next, ok: false, error: "Account is still pending verification — no activation email yet." };
    }
    if (acc.status === STATUS.REJECTED) {
      return { state: next, ok: false, error: "Account was not approved; it cannot be activated." };
    }
    if (acc.status === STATUS.ACTIVE) {
      return { state: next, ok: false, error: "Account is already active." };
    }
    if (!acc.activation || acc.activation.consumedAt) {
      return { state: next, ok: false, error: "This activation link has already been used." };
    }
    if (!token || acc.activation.token !== token) {
      return { state: next, ok: false, error: "Invalid or expired activation link." };
    }
    var pErr = passwordError(password);
    if (pErr) return { state: next, ok: false, error: pErr };

    acc.passwordHash = mockHash(password);
    acc.passwordSet = true;
    acc.activation.consumedAt = nowIso();
    acc.status = STATUS.ACTIVE;
    return { state: next, ok: true, error: null };
  }

  // Can the provider log in? Only an active account with a password set.
  function canLogin(state, accountId) {
    var acc = getAccount(state, accountId);
    return !!acc && acc.status === STATUS.ACTIVE && acc.passwordSet === true;
  }

  function listAccounts(state) {
    if (!state || !state.accounts) return [];
    return Object.keys(state.accounts).map(function (id) { return state.accounts[id]; });
  }

  function statusLabel(status) {
    if (status === STATUS.PENDING) return "Pending verification";
    if (status === STATUS.REJECTED) return "Rejected";
    if (status === STATUS.INVITED) return "Activation email sent";
    if (status === STATUS.ACTIVE) return "Active";
    return status || "Unknown";
  }

  /* ---------------- persistence helpers (HC.store only) ---------------- */

  function loadState() {
    var raw;
    try { raw = HC.store.get(STORE_KEY, null); } catch (e) { raw = null; }
    if (!raw || typeof raw !== "object" || !raw.accounts || typeof raw.accounts !== "object") {
      return emptyState();
    }
    return raw;
  }

  function saveState(state) {
    try { HC.store.set(STORE_KEY, state); } catch (e) {}
  }

  /* ---------------- live camp data ---------------- */

  function providers() {
    try { return HC.data.providers || []; } catch (e) { return []; }
  }

  // Pick a representative live school-age holiday-camp provider to pre-fill the demo.
  function pickSeedProvider() {
    var ps = providers();
    for (var i = 0; i < ps.length; i++) {
      if (ps[i] && ps[i].id && ps[i].name) return ps[i];
    }
    return { id: "demo-camp", name: "Lloyd Park Holiday Camp", area: "Walthamstow", ageLabel: "5-12" };
  }

  function seedEmail(seed) {
    var slug = String((seed && seed.id) || "camp").replace(/[^a-z0-9]/gi, "").slice(0, 16);
    return "hello@" + (slug || "camp") + ".example";
  }

  /* ---------------- UI ---------------- */

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
  function attr(s) { return esc(s).replace(/"/g, "&quot;"); }

  function statusPillStyle(status) {
    var base = "display:inline-block;font-family:'Quicksand',system-ui,sans-serif;font-weight:700;" +
      "font-size:11px;text-transform:uppercase;letter-spacing:.4px;padding:3px 10px;border-radius:999px;";
    if (status === STATUS.ACTIVE) return base + "background:#E1F0E4;color:#2f7d4f";
    if (status === STATUS.INVITED) return base + "background:var(--purple-tint,#F0E8F4);color:var(--purple,#603488)";
    if (status === STATUS.REJECTED) return base + "background:var(--pink-tint,#FCE8F0);color:#9a1f5e";
    return base + "background:#FFF4D6;color:#8a6d00"; // pending
  }

  function render(mountEl) {
    if (!mountEl) return;

    var state = loadState();
    var seed = pickSeedProvider();
    // The account currently in the on-screen wizard. Held in this closure;
    // persisted into state so it survives a re-render.
    var currentId = null;

    mountEl.innerHTML = "";
    var wrap = HC.util.el("div", {
      style: "font-family:'Nunito Sans',system-ui,sans-serif;color:var(--text,#383838)"
    });

    wrap.appendChild(HC.util.el("p", { style: "font-size:14px;margin:0 0 14px" },
      "How a holiday-camp business gets onto HolidayCamp, exactly like Happity: you " +
      "<strong>register</strong>, our team <strong>manually verifies</strong> you're an eligible " +
      "school-age camp provider, then we email you an <strong>activation link</strong> to " +
      "<strong>set your password</strong> and log in. No password can be set until you're approved."));

    // ---------- registration card ----------
    var regCard = HC.util.el("div", {
      style: "border:1.5px solid var(--line,#E6E6E6);border-radius:14px;padding:16px 18px;margin:0 0 16px;background:#fff"
    });
    regCard.appendChild(HC.util.el("div", {
      style: "font-family:'Quicksand',system-ui,sans-serif;font-weight:700;color:var(--magenta,#F82488);" +
        "text-transform:uppercase;letter-spacing:.5px;font-size:12px;margin:0 0 10px"
    }, "1 · Register your camp business"));

    var nameInput = HC.util.el("input", {
      type: "text", value: seed.name,
      style: "width:100%;padding:9px 11px;border:1.5px solid var(--line,#E6E6E6);border-radius:10px;" +
        "font-size:14px;box-sizing:border-box;margin:0 0 8px"
    });
    var emailInput = HC.util.el("input", {
      type: "email", value: seedEmail(seed),
      style: "width:100%;padding:9px 11px;border:1.5px solid var(--line,#E6E6E6);border-radius:10px;" +
        "font-size:14px;box-sizing:border-box;margin:0 0 10px"
    });
    regCard.appendChild(HC.util.el("label", {
      style: "display:block;font-size:11.5px;color:var(--muted,#808080);margin:0 0 3px"
    }, "Business name"));
    regCard.appendChild(nameInput);
    regCard.appendChild(HC.util.el("label", {
      style: "display:block;font-size:11.5px;color:var(--muted,#808080);margin:0 0 3px"
    }, "Contact email"));
    regCard.appendChild(emailInput);

    var registerBtn = HC.util.el("button", { class: "hc-btn", type: "button" }, "Register");
    regCard.appendChild(registerBtn);
    wrap.appendChild(regCard);

    // ---------- live status / wizard card ----------
    var wizCard = HC.util.el("div", {
      style: "border:1.5px solid var(--line,#E6E6E6);border-radius:14px;padding:16px 18px;margin:0 0 16px;background:#fff"
    });
    wrap.appendChild(wizCard);

    // ---------- reviewer queue (the manual verification list) ----------
    var queueHead = HC.util.el("div", {
      style: "font-family:'Quicksand',system-ui,sans-serif;font-weight:700;color:var(--magenta,#F82488);" +
        "text-transform:uppercase;letter-spacing:.5px;font-size:12px;margin:6px 0 8px"
    }, "Verification queue (reviewer view)");
    wrap.appendChild(queueHead);
    var queueBox = HC.util.el("div", {});
    wrap.appendChild(queueBox);

    mountEl.appendChild(wrap);

    function currentAccount() {
      return currentId ? getAccount(state, currentId) : null;
    }

    function paintWizard() {
      var acc = currentAccount();
      if (!acc) {
        wizCard.innerHTML =
          '<div style="font-family:Quicksand,system-ui,sans-serif;font-weight:700;color:var(--purple,#603488);font-size:15px">' +
          "Register above to begin</div>" +
          '<p style="font-size:13px;color:var(--muted,#808080);margin:6px 0 0">' +
          "New registrations land here as <strong>pending verification</strong>.</p>";
        return;
      }

      var html = '<div style="display:flex;justify-content:space-between;align-items:baseline;gap:10px">' +
        '<span style="font-family:Quicksand,system-ui,sans-serif;font-weight:700;color:var(--purple,#603488);font-size:16px">' +
        esc(acc.businessName) + "</span>" +
        '<span style="' + statusPillStyle(acc.status) + '">' + esc(statusLabel(acc.status)) + "</span>" +
        "</div>" +
        '<div style="font-size:12.5px;color:var(--muted,#808080);margin:3px 0 12px">' + esc(acc.contactEmail) + "</div>";

      if (acc.status === STATUS.PENDING) {
        html += '<p style="font-size:13px;margin:0">Your account is <strong>pending verification</strong>. ' +
          "Our team checks every registration (Happity quotes up to 24 hours) before any activation email is sent. " +
          "Use the reviewer queue below to approve or reject it.</p>";
      } else if (acc.status === STATUS.REJECTED) {
        html += '<p style="font-size:13px;margin:0;color:#9a1f5e">Registration was not approved' +
          (acc.reviewerNote ? " — " + esc(acc.reviewerNote) : "") + ". No activation email is issued.</p>";
      } else if (acc.status === STATUS.INVITED) {
        html += '<p style="font-size:13px;margin:0 0 10px">Approved! An <strong>activation email</strong> was sent to ' +
          esc(acc.contactEmail) + " (re-sent " + (acc.activation.sendCount - 1) + " time" +
          ((acc.activation.sendCount - 1) === 1 ? "" : "s") + "). " +
          "Follow it to <strong>set your password</strong>:</p>" +
          '<div style="background:var(--purple-tint,#F0E8F4);border-radius:10px;padding:10px 12px;margin:0 0 12px;' +
          'font-size:12px;color:var(--purple,#603488);word-break:break-all">' +
          "🔗 holidaycamp.app/activate?token=" + esc(acc.activation.token) + "</div>" +
          '<input id="hcpvPw" type="password" placeholder="Choose a password (min ' + MIN_PASSWORD + ', incl. a number)" ' +
          'style="width:100%;padding:9px 11px;border:1.5px solid var(--line,#E6E6E6);border-radius:10px;' +
          'font-size:14px;box-sizing:border-box;margin:0 0 10px">' +
          '<button class="hc-btn" type="button" data-hcpv="setpw">Set password & activate</button>';
      } else if (acc.status === STATUS.ACTIVE) {
        html += '<p style="font-size:13px;margin:0;color:#2f7d4f">✓ Password set — your account is <strong>active</strong> ' +
          "and you can log in to set up your school-holiday camps.</p>";
      }

      wizCard.innerHTML = html;

      var setBtn = wizCard.querySelector('[data-hcpv="setpw"]');
      if (setBtn) {
        setBtn.addEventListener("click", function () {
          var pwField = wizCard.querySelector("#hcpvPw");
          var pw = pwField ? pwField.value : "";
          var live = currentAccount();
          var res = activateWithPassword(state, currentId, live && live.activation ? live.activation.token : "", pw);
          state = res.state;
          saveState(state);
          if (res.ok) {
            try { HC.util.toast("Password set — account active. You can now log in."); } catch (e) {}
          } else {
            try { HC.util.toast(res.error || "Could not set password"); } catch (e) {}
          }
          paintWizard();
          paintQueue();
        });
      }
    }

    function paintQueue() {
      var rows = listAccounts(state);
      if (!rows.length) {
        queueBox.innerHTML = '<p style="font-size:13px;color:var(--muted,#808080);margin:0">No registrations yet.</p>';
        return;
      }
      queueBox.innerHTML = "";
      rows.forEach(function (acc) {
        var row = HC.util.el("div", {
          style: "border:1.5px solid var(--line,#E6E6E6);border-radius:12px;padding:11px 13px;margin:0 0 10px;background:#fff"
        });
        row.innerHTML =
          '<div style="display:flex;justify-content:space-between;align-items:baseline;gap:10px">' +
            '<span style="font-family:Quicksand,system-ui,sans-serif;font-weight:700;color:var(--purple,#603488);font-size:14.5px">' +
              esc(acc.businessName) +
              (acc.role === "extra-user" ? ' <span style="font-size:10.5px;color:var(--muted,#808080)">(extra user)</span>' : "") +
            "</span>" +
            '<span style="' + statusPillStyle(acc.status) + '">' + esc(statusLabel(acc.status)) + "</span>" +
          "</div>" +
          '<div style="font-size:12px;color:var(--muted,#808080);margin:2px 0 0">' + esc(acc.contactEmail) + "</div>";

        var btnRow = HC.util.el("div", { style: "display:flex;gap:8px;flex-wrap:wrap;margin-top:9px" });
        if (acc.status === STATUS.PENDING) {
          var approveBtn = HC.util.el("button", { class: "hc-btn", type: "button" }, "✓ Verify & approve");
          var rejectBtn = HC.util.el("button", { class: "hc-btn hc-btn-ghost", type: "button" }, "Reject");
          approveBtn.addEventListener("click", function () {
            var res = approveAccount(state, acc.id, "Verified eligible school-age camp provider");
            state = res.state;
            saveState(state);
            currentId = acc.id;
            try { HC.util.toast("Approved — activation email sent to " + acc.contactEmail); } catch (e) {}
            paintWizard(); paintQueue();
          });
          rejectBtn.addEventListener("click", function () {
            state = rejectAccount(state, acc.id, "Not an eligible school-age camp provider");
            saveState(state);
            if (currentId === acc.id) paintWizard();
            try { HC.util.toast("Registration rejected — no activation email sent"); } catch (e) {}
            paintWizard(); paintQueue();
          });
          btnRow.appendChild(approveBtn);
          btnRow.appendChild(rejectBtn);
        } else if (acc.status === STATUS.INVITED) {
          // The "envelope symbol" — re-send the activation email.
          var resendBtn = HC.util.el("button", { class: "hc-btn hc-btn-ghost", type: "button" }, "✉ Re-send activation");
          resendBtn.addEventListener("click", function () {
            var res = resendActivation(state, acc.id);
            state = res.state;
            saveState(state);
            if (res.resent) { try { HC.util.toast("Activation email re-sent (new link)"); } catch (e) {} }
            currentId = acc.id;
            paintWizard(); paintQueue();
          });
          btnRow.appendChild(resendBtn);
          var openBtn = HC.util.el("button", { class: "hc-btn", type: "button" }, "Open set-password step");
          openBtn.addEventListener("click", function () { currentId = acc.id; paintWizard(); });
          btnRow.appendChild(openBtn);
        }
        if (btnRow.childNodes.length) row.appendChild(btnRow);
        queueBox.appendChild(row);
      });
    }

    registerBtn.addEventListener("click", function () {
      var bn = (nameInput.value || "").trim();
      var em = (emailInput.value || "").trim();
      if (!bn || !em) {
        try { HC.util.toast("Enter a business name and contact email"); } catch (e) {}
        return;
      }
      var res = registerAccount(state, {
        businessName: bn, contactEmail: em, providerId: seed.id, role: "owner"
      });
      state = res.state;
      currentId = res.accountId;
      saveState(state);
      try { HC.util.toast("Registered — your account is pending verification"); } catch (e) {}
      paintWizard(); paintQueue();
    });

    paintWizard();
    paintQueue();
  }

  /* ---------------- selfTest ---------------- */

  function selfTest() {
    var pass = 0, fail = 0, log = [];
    function check(label, fn) {
      try { fn(); pass += 1; log.push("✓ " + label); }
      catch (e) { fail += 1; log.push("✗ " + label + " — " + (e && e.message ? e.message : String(e))); }
    }

    var reg = { businessName: "Lloyd Park Holiday Camp", contactEmail: "hello@lloydpark.example", providerId: "lloyd-park" };

    // ACCEPTANCE CRITERION, part A: a NEW account shows 'pending verification'.
    check("A new registration starts in 'pending verification'", function () {
      var r = registerAccount(emptyState(), reg);
      var acc = getAccount(r.state, r.accountId);
      HC.assert(acc, "account should be created");
      HC.assert(acc.status === STATUS.PENDING, "new account status must be 'pending verification', got " + acc.status);
      HC.assert(acc.status === "pending verification", "the human-readable label is exactly 'pending verification'");
      HC.assert(isPending(acc), "isPending() recognises the new account");
      HC.assert(acc.activation === null, "no activation email exists before approval");
      HC.assert(acc.passwordSet === false, "no password can be set yet");
    });

    // A pending account CANNOT set a password (no activation step exists yet).
    check("A pending account cannot set a password (no activation issued yet)", function () {
      var r = registerAccount(emptyState(), reg);
      HC.assert(!tokenOpensSetPassword(r.state, r.accountId, "anything"), "no token opens set-password while pending");
      var res = activateWithPassword(r.state, r.accountId, "anything", "Password1");
      HC.assert(res.ok === false, "activation must fail while still pending");
      HC.assert(/pending/i.test(res.error || ""), "error explains the account is pending, got: " + res.error);
      HC.assert(canLogin(res.state, r.accountId) === false, "cannot log in while pending");
    });

    // ACCEPTANCE CRITERION, part B: APPROVAL (manual verification) ISSUES the
    // activation email, which OPENS the set-password step.
    check("Manual approval issues an activation email that opens a set-password step", function () {
      var r = registerAccount(emptyState(), reg);
      var a = approveAccount(r.state, r.accountId, "Verified");
      var acc = getAccount(a.state, r.accountId);
      HC.assert(acc.status === STATUS.INVITED, "approved account moves to 'activation sent', got " + acc.status);
      HC.assert(acc.activation && typeof acc.activation.token === "string" && acc.activation.token.length > 0,
        "approval mints an activation token (the email's link)");
      HC.assert(a.activation && a.activation.email === reg.contactEmail, "activation email is addressed to the contact");
      HC.assert(acc.passwordSet === false, "password not yet set immediately after approval");
      HC.assert(tokenOpensSetPassword(a.state, r.accountId, acc.activation.token) === true,
        "the issued token opens the set-password step");
    });

    // The full happy path: register -> pending -> approve -> activation -> set
    // password -> active -> can log in.
    check("End-to-end: pending -> approve -> set password -> active & can log in", function () {
      var r = registerAccount(emptyState(), reg);
      HC.assert(getAccount(r.state, r.accountId).status === STATUS.PENDING, "step 1 pending");
      var a = approveAccount(r.state, r.accountId);
      HC.assert(getAccount(a.state, r.accountId).status === STATUS.INVITED, "step 2 activation sent");
      var token = getAccount(a.state, r.accountId).activation.token;
      var res = activateWithPassword(a.state, r.accountId, token, "Summer2026");
      HC.assert(res.ok === true, "set-password should succeed with a valid token + good password");
      var acc = getAccount(res.state, r.accountId);
      HC.assert(acc.status === STATUS.ACTIVE, "account becomes active after setting a password");
      HC.assert(acc.passwordSet === true, "passwordSet flag is true");
      HC.assert(typeof acc.passwordHash === "string" && acc.passwordHash.length > 0, "a (mock) password hash is stored");
      HC.assert(canLogin(res.state, r.accountId) === true, "an active account with a password can log in");
    });

    // The token is SINGLE-USE: once consumed, the link no longer works.
    check("Activation token is single-use (consumed on first password set)", function () {
      var r = registerAccount(emptyState(), reg);
      var a = approveAccount(r.state, r.accountId);
      var token = getAccount(a.state, r.accountId).activation.token;
      var res1 = activateWithPassword(a.state, r.accountId, token, "FirstPass1");
      HC.assert(res1.ok === true, "first activation succeeds");
      HC.assert(getAccount(res1.state, r.accountId).activation.consumedAt, "token marked consumed");
      HC.assert(tokenOpensSetPassword(res1.state, r.accountId, token) === false, "consumed token no longer opens set-password");
      var res2 = activateWithPassword(res1.state, r.accountId, token, "SecondPass1");
      HC.assert(res2.ok === false, "the same link cannot be used twice");
      HC.assert(/already (used|active)/i.test(res2.error || ""), "error says link used / already active, got: " + res2.error);
    });

    // A wrong/forged token must NOT open the set-password step.
    check("A wrong token cannot set a password", function () {
      var r = registerAccount(emptyState(), reg);
      var a = approveAccount(r.state, r.accountId);
      HC.assert(tokenOpensSetPassword(a.state, r.accountId, "act_forged000") === false, "forged token rejected");
      var res = activateWithPassword(a.state, r.accountId, "act_forged000", "GoodPass1");
      HC.assert(res.ok === false, "activation fails with a bad token");
      HC.assert(getAccount(res.state, r.accountId).status === STATUS.INVITED, "account remains invited, not activated");
    });

    // The set-password step enforces a password policy.
    check("Set-password step enforces a minimum-strength password policy", function () {
      var r = registerAccount(emptyState(), reg);
      var a = approveAccount(r.state, r.accountId);
      var token = getAccount(a.state, r.accountId).activation.token;
      var tooShort = activateWithPassword(a.state, r.accountId, token, "ab1");
      HC.assert(tooShort.ok === false, "a too-short password is rejected");
      HC.assert(getAccount(tooShort.state, r.accountId).status === STATUS.INVITED, "still invited after a rejected password");
      var noNumber = activateWithPassword(a.state, r.accountId, token, "passwordonly");
      HC.assert(noNumber.ok === false, "a password with no number is rejected");
      HC.assert(passwordError("Valid1Password") === null, "a strong password passes policy");
    });

    // REJECTION path: verification fails -> no activation email, never set-password.
    check("A rejected registration gets no activation email and cannot set a password", function () {
      var r = registerAccount(emptyState(), reg);
      var s = rejectAccount(r.state, r.accountId, "Adult fitness, not school-age camps");
      var acc = getAccount(s, r.accountId);
      HC.assert(acc.status === STATUS.REJECTED, "status is rejected");
      HC.assert(acc.activation === null, "no activation email issued for a rejected account");
      HC.assert(/Adult fitness/.test(acc.reviewerNote || ""), "reviewer note recorded");
      var res = activateWithPassword(s, r.accountId, "anything", "GoodPass1");
      HC.assert(res.ok === false, "a rejected account cannot be activated");
      HC.assert(canLogin(res.state, r.accountId) === false, "a rejected account cannot log in");
    });

    // Approval is only valid from pending; a rejected account can't be approved.
    check("Only a pending account can be approved or rejected", function () {
      var r = registerAccount(emptyState(), reg);
      var s = rejectAccount(r.state, r.accountId);
      var a = approveAccount(s, r.accountId); // attempt to approve a rejected account
      HC.assert(getAccount(a.state, r.accountId).status === STATUS.REJECTED, "rejected account stays rejected, not approved");
      // and a pending account can't be 'rejected' twice into a weird state
      var r2 = registerAccount(emptyState(), reg);
      var a2 = approveAccount(r2.state, r2.accountId);
      var s2 = rejectAccount(a2.state, r2.accountId); // attempt to reject an already-invited account
      HC.assert(getAccount(s2, r2.accountId).status === STATUS.INVITED, "an invited account is not retroactively rejected");
    });

    // RE-SEND the activation email (the "envelope symbol", evidence 5917325).
    check("Activation email can be re-sent, invalidating the previous link", function () {
      var r = registerAccount(emptyState(), reg);
      var a = approveAccount(r.state, r.accountId);
      var firstToken = getAccount(a.state, r.accountId).activation.token;
      HC.assert(getAccount(a.state, r.accountId).activation.sendCount === 1, "first send counted");
      var re = resendActivation(a.state, r.accountId);
      HC.assert(re.resent === true, "re-send succeeds for an invited account");
      var acc = getAccount(re.state, r.accountId);
      HC.assert(acc.activation.sendCount === 2, "send count incremented on re-send");
      HC.assert(acc.activation.token !== firstToken, "a fresh token is issued on re-send");
      HC.assert(tokenOpensSetPassword(re.state, r.accountId, firstToken) === false, "the OLD link no longer works");
      HC.assert(tokenOpensSetPassword(re.state, r.accountId, acc.activation.token) === true, "the NEW link works");
    });

    // EXTRA USERS go through the identical activation -> set-password step (5917325).
    check("Extra users use the same activation -> set-password flow", function () {
      // An owner is already active; they add an extra dashboard user.
      var r = registerAccount(emptyState(), reg);
      var a = approveAccount(r.state, r.accountId);
      var s = activateWithPassword(a.state, r.accountId, getAccount(a.state, r.accountId).activation.token, "OwnerPass1").state;
      // Add an extra user — they too start pending, then get the same flow.
      var u = registerAccount(s, { businessName: "Lloyd Park Holiday Camp", contactEmail: "helper@lloydpark.example", role: "extra-user" });
      var extra = getAccount(u.state, u.accountId);
      HC.assert(extra.role === "extra-user", "extra user is flagged as such");
      HC.assert(extra.status === STATUS.PENDING, "extra user also starts pending verification");
      var au = approveAccount(u.state, u.accountId);
      var token = getAccount(au.state, u.accountId).activation.token;
      var resU = activateWithPassword(au.state, u.accountId, token, "HelperPass1");
      HC.assert(resU.ok === true, "extra user sets their own password via the activation step");
      HC.assert(canLogin(resU.state, u.accountId) === true, "extra user can then log in");
      // The owner account is unaffected by the extra user's flow.
      HC.assert(canLogin(resU.state, r.accountId) === true, "owner remains active and independent");
      HC.assert(listAccounts(resU.state).length === 2, "two independent accounts exist");
    });

    // Defensive: bad inputs must not throw or corrupt state.
    check("Defensive against missing accounts and empty inputs", function () {
      var s = emptyState();
      HC.assert(getAccount(s, "nope") === null, "missing account returns null, not a throw");
      HC.assert(approveAccount(s, "nope").activation === null, "approving a missing account is a safe no-op");
      HC.assert(rejectAccount(s, "nope") && typeof rejectAccount(s, "nope") === "object", "rejecting a missing account is safe");
      var res = activateWithPassword(s, "nope", "t", "pw");
      HC.assert(res.ok === false && /not found/i.test(res.error || ""), "activating a missing account fails cleanly");
      var r = registerAccount(s, {}); // no fields at all
      var acc = getAccount(r.state, r.accountId);
      HC.assert(acc.status === STATUS.PENDING, "even an empty registration is pending");
      HC.assert(acc.businessName.length > 0, "a default business name is supplied");
    });

    // Persistence round-trips through HC.store (namespaced, not raw localStorage).
    check("Verification state persists via HC.store", function () {
      var r = registerAccount(emptyState(), reg);
      var a = approveAccount(r.state, r.accountId);
      var ok = HC.store.set(STORE_KEY, a.state);
      HC.assert(ok !== false, "store.set should succeed");
      var got = HC.store.get(STORE_KEY, null);
      HC.assert(got && got.accounts && got.accounts[r.accountId], "account survives a store round-trip");
      HC.assert(got.accounts[r.accountId].status === STATUS.INVITED, "status survives persistence");
      HC.assert(got.accounts[r.accountId].activation.token === a.state.accounts[r.accountId].activation.token,
        "activation token survives persistence");
      try { HC.store.remove ? HC.store.remove(STORE_KEY) : HC.store.set(STORE_KEY, null); } catch (e) {}
    });

    // Seed provider is drawn from the LIVE school-age holiday-camp directory.
    check("Seed provider comes from the live holiday-camp directory", function () {
      var seed = pickSeedProvider();
      HC.assert(seed && typeof seed.id === "string" && seed.id.length > 0, "seed has a provider id");
      HC.assert(typeof seed.name === "string" && seed.name.length > 0, "seed has a provider name");
      var ps = providers();
      if (ps.length) {
        var found = ps.some(function (p) { return p && p.id === seed.id; });
        HC.assert(found, "seed should be a real directory provider when data is present");
      }
    });

    return { pass: pass, fail: fail, log: log };
  }

  /* ---------------- register ---------------- */

  HC.registerFeature({
    id: "provider-verification",
    title: "Provider verification & activation",
    side: "provider",
    icon: "🛡️",
    summary: "Just like Happity: a new camp business registers and shows as 'pending verification'. " +
      "Our team manually verifies it's an eligible school-age camp provider, then issues an activation " +
      "email whose link opens a set-password step — only then can the provider log in. Extra dashboard " +
      "users get the same activation flow, and the email can be re-sent.",
    render: render,
    selfTest: selfTest
  });
})();
