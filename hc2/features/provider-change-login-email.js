/* HolidayCamp feature: provider-change-login-email
 * ------------------------------------------------------------------
 * Replicates Happity's two-tier email model for the PROVIDER side,
 * reframed for SCHOOL-AGE HOLIDAY CAMPS.
 *
 * Evidence (support corpus):
 *  - 8217596 "How can I edit my email address?":
 *      * The CUSTOMER-FACING / public contact email is self-serve:
 *        "Editing your email address on your Happity page is quick and
 *        easy to do! This is the email address that is customer facing"
 *        — Profile › Organisation › Contact › amend › Save.
 *      * The LOGIN email is NOT self-serve: "If you would like to amend
 *        the email address you use to log into your account, please
 *        contact our friendly customer support team who will get this
 *        updated for you" (support@happity.co.uk).
 *  - 8019763 "Can I use the same email address across multiple accounts?":
 *        A login email must be unique; the documented workaround is a
 *        "+" alias (e.g. you+camp@gmail.com) so one inbox can hold
 *        several distinct logins. Modelled here as a uniqueness check
 *        plus an alias suggestion.
 *
 * Acceptance criterion (asserted by selfTest, multiple cases):
 *   "Account settings distinguish the public contact email (self-serve)
 *    from the login email, and provide a request flow to change the
 *    login email. Distinct from editing the displayed contact email."
 *
 *   We assert that:
 *     (a) the public contact email can be changed *immediately* and
 *         self-serve (no support ticket), and that doing so does NOT
 *         alter the login email;
 *     (b) the login email CANNOT be changed self-serve — instead a
 *         support REQUEST is raised (status "pending"), validated, and
 *         the login email stays unchanged until support "applies" it;
 *     (c) the two channels are independent and the request flow is
 *         distinct from the contact-email edit.
 *
 * Defensive: nothing throws at registration time. Persistence is via
 * HC.store ONLY (namespaced keys). Verified camps.js data is never
 * mutated.
 * ------------------------------------------------------------------ */
(function () {
  "use strict";

  if (typeof window === "undefined" || !window.HC || typeof window.HC.registerFeature !== "function") {
    // Core not present — fail silently rather than throwing.
    return;
  }
  var HC = window.HC;

  // Two separate overlays — the whole point is that login email and
  // contact email are DISTINCT records on DISTINCT channels.
  var ACCOUNT_KEY = "provider_login_account";   // { [providerId]: { loginEmail, contactEmail } }
  var REQUEST_KEY = "provider_login_email_requests"; // { [requestId]: {request...} }

  var SUPPORT_EMAIL = "support@holidaycamp.co.uk";

  /* ============================================================
   * 1. Pure helpers + validation.
   * ============================================================ */

  function trimStr(s) { return String(s == null ? "" : s).replace(/\s+/g, " ").trim(); }
  function lower(s) { return trimStr(s).toLowerCase(); }

  function isValidEmail(raw) {
    var s = trimStr(raw);
    if (!s) return false;
    return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s);
  }

  // Normalise for *duplicate detection* only (NOT for storage/display).
  // Gmail-style "+" aliases collapse to the same inbox, so for the
  // "same email across accounts" rule we compare the base address.
  // (Evidence 8019763: aliases let one inbox back several logins.)
  function inboxBase(raw) {
    var s = lower(raw);
    var at = s.indexOf("@");
    if (at < 0) return s;
    var local = s.slice(0, at);
    var domain = s.slice(at + 1);
    var plus = local.indexOf("+");
    if (plus >= 0) local = local.slice(0, plus);
    return local + "@" + domain;
  }

  // Suggest a "+" alias so a provider who already uses their email on
  // another account can still create a distinct login (evidence 8019763).
  function suggestAlias(raw, tag) {
    var s = lower(raw);
    var at = s.indexOf("@");
    if (at < 0 || !isValidEmail(s)) return "";
    var local = s.slice(0, at);
    var domain = s.slice(at + 1);
    if (local.indexOf("+") >= 0) local = local.slice(0, local.indexOf("+"));
    var t = (trimStr(tag) || "camp").toLowerCase().replace(/[^a-z0-9]/g, "");
    if (!t) t = "camp";
    return local + "+" + t + "@" + domain;
  }

  function uid(prefix) {
    try { return (prefix || "req") + "_" + HC.util.uid(); }
    catch (e) { return (prefix || "req") + "_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2); }
  }

  /* ============================================================
   * 2. Account record (login email + contact email), seeded from
   *    live camp data and layered with any saved overlay.
   * ============================================================ */

  function readAccounts() {
    var all = HC.store.get(ACCOUNT_KEY, {});
    return (all && typeof all === "object") ? all : {};
  }

  function seedAccount(provider) {
    var p = provider || {};
    var pid = (p.id != null ? String(p.id) : "test-provider");
    // Derive a plausible default login + contact email from the camp's
    // name/slug. camps.js has no email field, so we synthesise a stable
    // demo address — never written back to camps.js.
    var slug = (trimStr(p.slug) || trimStr(p.name) || pid)
      .toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 24) || "camp";
    return {
      providerId: pid,
      providerName: trimStr(p.name) || "Your holiday camp",
      loginEmail: "owner@" + slug + ".co.uk",      // internal sign-in address
      contactEmail: "bookings@" + slug + ".co.uk"  // public, customer-facing
    };
  }

  function getAccount(provider) {
    var seed = seedAccount(provider);
    var saved = readAccounts()[seed.providerId];
    if (saved && typeof saved === "object") {
      return {
        providerId: seed.providerId,
        providerName: seed.providerName,
        loginEmail: trimStr(saved.loginEmail) || seed.loginEmail,
        contactEmail: trimStr(saved.contactEmail) || seed.contactEmail
      };
    }
    return seed;
  }

  function writeAccount(acc) {
    var all = readAccounts();
    all[acc.providerId] = {
      providerId: acc.providerId,
      providerName: acc.providerName,
      loginEmail: trimStr(acc.loginEmail),
      contactEmail: trimStr(acc.contactEmail)
    };
    HC.store.set(ACCOUNT_KEY, all);
    return all[acc.providerId];
  }

  /* ============================================================
   * 3. SELF-SERVE channel: change the PUBLIC contact email.
   *    Mirrors Happity 8217596 first half — immediate, no ticket.
   *    Returns { ok, error, account }.
   * ============================================================ */

  function changeContactEmail(provider, newEmail) {
    var acc = getAccount(provider);
    var email = trimStr(newEmail);
    if (!isValidEmail(email)) {
      return { ok: false, error: "Enter a valid contact email address.", account: acc };
    }
    acc.contactEmail = email;
    // NOTE: loginEmail is deliberately untouched here.
    var saved = writeAccount(acc);
    return { ok: true, error: null, account: getAccount(provider), self_serve: true };
  }

  /* ============================================================
   * 4. SUPPORT-ASSISTED channel: REQUEST a login-email change.
   *    Mirrors Happity 8217596 second half — NOT self-serve. We
   *    raise a ticket; the login email does not change until support
   *    "applies" it.
   * ============================================================ */

  function readRequests() {
    var all = HC.store.get(REQUEST_KEY, {});
    return (all && typeof all === "object") ? all : {};
  }

  function writeRequests(all) { HC.store.set(REQUEST_KEY, all); return all; }

  function requestsForProvider(pid) {
    var all = readRequests();
    var out = [];
    for (var id in all) {
      if (!Object.prototype.hasOwnProperty.call(all, id)) continue;
      if (all[id] && String(all[id].providerId) === String(pid)) out.push(all[id]);
    }
    out.sort(function (a, b) { return (b.createdAt || 0) - (a.createdAt || 0); });
    return out;
  }

  // Validate a proposed new login email against the account + corpus rules.
  // Returns { ok, errors:{field:msg}, clean }.
  function validateLoginEmailRequest(provider, input) {
    var acc = getAccount(provider);
    var errors = {};
    var src = input || {};
    var newEmail = trimStr(src.newLoginEmail);

    if (!isValidEmail(newEmail)) {
      errors.newLoginEmail = "Enter a valid email address to log in with.";
    } else if (lower(newEmail) === lower(acc.loginEmail)) {
      errors.newLoginEmail = "That is already your login email — no change needed.";
    }

    // Uniqueness rule (evidence 8019763): the same inbox can't back two
    // logins unless distinguished by a "+" alias. A "+" alias counts as a
    // DISTINCT login (that is the whole point of the workaround), so we
    // compare the FULL address, not the collapsed inbox base.
    if (!errors.newLoginEmail) {
      var clashWith = findLoginEmailClash(acc.providerId, newEmail);
      if (clashWith) {
        errors.newLoginEmail =
          "That email is already used to log in to another account. " +
          "Tip: use a “+” alias such as " + suggestAlias(newEmail, acc.providerName) +
          " so one inbox can hold several logins.";
      }
    }

    // A reason is optional but we keep a confirm box: the provider must
    // confirm they own the new inbox (support will action it).
    if (!src.confirmOwnership) {
      errors.confirmOwnership = "Please confirm you have access to the new inbox.";
    }

    var clean = {
      providerId: acc.providerId,
      providerName: acc.providerName,
      currentLoginEmail: acc.loginEmail,
      newLoginEmail: newEmail,
      reason: trimStr(src.reason).slice(0, 300)
    };
    return { ok: Object.keys(errors).length === 0, errors: errors, clean: clean };
  }

  // Does newEmail collide with another provider's login email?
  // Login uniqueness is on the EXACT address: "you@gmail.com" and
  // "you+camp@gmail.com" are different logins (evidence 8019763 — the
  // "+" alias is the documented way to reuse one inbox across accounts).
  // We still also block reusing another account's exact existing alias.
  function findLoginEmailClash(ownPid, newEmail) {
    var want = lower(newEmail);
    var accounts = readAccounts();
    for (var pid in accounts) {
      if (!Object.prototype.hasOwnProperty.call(accounts, pid)) continue;
      if (String(pid) === String(ownPid)) continue;
      var other = accounts[pid];
      if (other && other.loginEmail && lower(other.loginEmail) === want) {
        return String(pid);
      }
    }
    return null;
  }

  // Raise the support request. Login email is NOT changed — status pending.
  function submitLoginEmailRequest(provider, input) {
    var v = validateLoginEmailRequest(provider, input);
    if (!v.ok) return v;
    var all = readRequests();
    var id = uid("loginreq");
    var record = {
      id: id,
      providerId: v.clean.providerId,
      providerName: v.clean.providerName,
      currentLoginEmail: v.clean.currentLoginEmail,
      newLoginEmail: v.clean.newLoginEmail,
      reason: v.clean.reason,
      status: "pending",           // pending -> applied | cancelled
      createdAt: Date.now(),
      supportEmail: SUPPORT_EMAIL
    };
    all[id] = record;
    writeRequests(all);
    return { ok: true, errors: {}, clean: v.clean, request: record };
  }

  // Support "applies" the change (back-office action, modelled for the
  // test). Only now does the login email actually change.
  function applyLoginEmailRequest(provider, requestId) {
    var all = readRequests();
    var req = all[requestId];
    if (!req || req.status !== "pending") {
      return { ok: false, error: "No pending request with that id." };
    }
    var acc = getAccount(provider);
    if (String(acc.providerId) !== String(req.providerId)) {
      return { ok: false, error: "Request does not belong to this account." };
    }
    acc.loginEmail = req.newLoginEmail; // contactEmail deliberately untouched
    writeAccount(acc);
    req.status = "applied";
    req.appliedAt = Date.now();
    all[requestId] = req;
    writeRequests(all);
    return { ok: true, error: null, account: getAccount(provider), request: req };
  }

  function cancelLoginEmailRequest(requestId) {
    var all = readRequests();
    var req = all[requestId];
    if (!req || req.status !== "pending") {
      return { ok: false, error: "No pending request to cancel." };
    }
    req.status = "cancelled";
    req.cancelledAt = Date.now();
    all[requestId] = req;
    writeRequests(all);
    return { ok: true, error: null, request: req };
  }

  /* ============================================================
   * 5. Render — Account & Sign-in settings.
   *    Two clearly-separated panels:
   *      A) Public contact email  (self-serve, instant)
   *      B) Login email           (support-assisted request)
   * ============================================================ */

  function firstProvider() {
    var list = HC.data.providers || [];
    return list.length ? list[0] : null;
  }

  function escAttr(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function statusBadge(status) {
    var map = {
      pending: ['#9a6a00', '#FFF4D6', 'Pending support'],
      applied: ['#2f7d4f', '#E1F0E4', 'Updated'],
      cancelled: ['#808080', '#EEEEEE', 'Cancelled']
    };
    var s = map[status] || map.pending;
    return '<span style="font-family:Quicksand,system-ui,sans-serif;font-weight:700;font-size:10.5px;' +
      'padding:2px 9px;border-radius:999px;color:' + s[0] + ';background:' + s[1] + '">' + s[2] + '</span>';
  }

  function render(mountEl) {
    try {
      var provider = firstProvider();
      var acc = getAccount(provider);
      var pid = acc.providerId;

      mountEl.innerHTML =
        '<style>' +
          '.cle-wrap{font-family:"Nunito Sans",system-ui,sans-serif;color:var(--text,#383838)}' +
          '.cle-intro{font-size:13.5px;margin:0 0 14px}' +
          '.cle-panel{border:1.5px solid var(--line,#E6E6E6);border-radius:16px;padding:16px 16px 14px;margin:0 0 16px;background:#fff}' +
          '.cle-panel.support{border-color:var(--purple-tint,#F0E8F4);background:#FBF8FD}' +
          '.cle-ptitle{display:flex;align-items:center;gap:8px;font-family:"Quicksand",system-ui,sans-serif;' +
            'font-weight:700;font-size:15px;color:var(--purple,#603488);margin:0 0 2px}' +
          '.cle-tag{font-size:10px;font-weight:700;letter-spacing:.4px;text-transform:uppercase;padding:2px 8px;border-radius:999px}' +
          '.cle-tag.self{background:#E1F0E4;color:#2f7d4f}' +
          '.cle-tag.assist{background:#FFF4D6;color:#9a6a00}' +
          '.cle-sub{font-size:12.5px;color:var(--muted,#808080);margin:0 0 12px}' +
          '.cle-field{margin:0 0 11px}' +
          '.cle-field label{display:block;font-family:"Quicksand",system-ui,sans-serif;font-weight:700;font-size:12px;' +
            'color:var(--purple,#603488);margin:0 0 4px}' +
          '.cle-field input[type=email],.cle-field input[type=text],.cle-field textarea{width:100%;box-sizing:border-box;' +
            'border:1.5px solid var(--line,#E6E6E6);border-radius:12px;padding:9px 12px;font-size:14px;font-family:inherit}' +
          '.cle-field input:focus,.cle-field textarea:focus{outline:none;border-color:var(--purple,#603488)}' +
          '.cle-cur{font-family:"Quicksand",system-ui,sans-serif;font-weight:700;font-size:14px;color:var(--text,#383838)}' +
          '.cle-curwrap{display:flex;align-items:center;gap:8px;background:#F7F4FA;border-radius:10px;padding:8px 11px;margin:0 0 11px}' +
          '.cle-err{color:#9a1f5e;font-size:12px;margin-top:4px}' +
          '.cle-confirm{display:flex;align-items:flex-start;gap:8px;font-size:12.5px;color:var(--text,#383838);margin:2px 0 11px}' +
          '.cle-confirm input{margin-top:2px}' +
          '.cle-actions{display:flex;gap:10px;flex-wrap:wrap}' +
          '.cle-note{font-size:12px;color:var(--muted,#808080);margin:10px 0 0;line-height:1.6}' +
          '.cle-reqs{margin:12px 0 0;list-style:none;padding:0}' +
          '.cle-req{border:1px solid var(--line,#E6E6E6);border-radius:12px;padding:10px 12px;margin:0 0 8px;font-size:13px;background:#fff}' +
          '.cle-req .cle-reqhead{display:flex;align-items:center;justify-content:space-between;gap:8px}' +
          '.cle-req .cle-reqmeta{color:var(--muted,#808080);font-size:11.5px;margin-top:3px}' +
          '.cle-link{color:var(--magenta,#F82488);font-weight:700;text-decoration:none}' +
        '</style>' +
        '<div class="cle-wrap">' +
          '<p class="cle-intro">Profile &rsaquo; <strong>Account &amp; sign-in</strong>. ' +
            'Your <strong>public contact email</strong> (what families see) and the <strong>email you log in with</strong> ' +
            'are two different things — changed in two different ways.</p>' +

          // ---- Panel A: public contact email (self-serve) ----
          '<div class="cle-panel">' +
            '<div class="cle-ptitle">📣 Public contact email <span class="cle-tag self">Self-serve</span></div>' +
            '<p class="cle-sub">Shown on your camp listing so parents can reach you. Change it here — it updates instantly.</p>' +
            '<div class="cle-curwrap"><span>Current:</span><span class="cle-cur" id="cleContactCur">' + escAttr(acc.contactEmail) + '</span></div>' +
            '<form id="cleContactForm" novalidate>' +
              '<div class="cle-field">' +
                '<label for="cleContactNew">New public contact email</label>' +
                '<input id="cleContactNew" name="contactEmail" type="email" placeholder="bookings@yourcamp.co.uk">' +
                '<div class="cle-err" data-err="contactEmail"></div>' +
              '</div>' +
              '<div class="cle-actions"><button type="submit" class="hc-btn">Update contact email</button></div>' +
            '</form>' +
          '</div>' +

          // ---- Panel B: login email (support-assisted) ----
          '<div class="cle-panel support">' +
            '<div class="cle-ptitle">🔐 Login email <span class="cle-tag assist">Support-assisted</span></div>' +
            '<p class="cle-sub">The address you sign in with. For security this can’t be self-edited — ' +
              'send a request and our team will update it for you.</p>' +
            '<div class="cle-curwrap"><span>You log in as:</span><span class="cle-cur" id="cleLoginCur">' + escAttr(acc.loginEmail) + '</span></div>' +
            '<form id="cleLoginForm" novalidate>' +
              '<div class="cle-field">' +
                '<label for="cleLoginNew">Requested new login email</label>' +
                '<input id="cleLoginNew" name="newLoginEmail" type="email" placeholder="you@yourcamp.co.uk">' +
                '<div class="cle-err" data-err="newLoginEmail"></div>' +
              '</div>' +
              '<div class="cle-field">' +
                '<label for="cleReason">Reason (optional)</label>' +
                '<textarea id="cleReason" name="reason" rows="2" placeholder="e.g. switching from a personal to a business address"></textarea>' +
              '</div>' +
              '<label class="cle-confirm"><input id="cleConfirm" type="checkbox"> ' +
                'I confirm I have access to this new inbox.</label>' +
              '<div class="cle-err" data-err="confirmOwnership"></div>' +
              '<div class="cle-actions">' +
                '<button type="submit" class="hc-btn">Request login email change</button>' +
              '</div>' +
            '</form>' +
            '<p class="cle-note">Prefer email? Write to <a class="cle-link" href="mailto:' + escAttr(SUPPORT_EMAIL) + '">' +
              escAttr(SUPPORT_EMAIL) + '</a> from your current login address. ' +
              'Already use this email elsewhere? Add a “+” alias (e.g. you+camp@gmail.com) so one inbox can hold several logins.</p>' +
            '<div id="cleReqList"></div>' +
          '</div>' +
        '</div>';

      var contactForm = mountEl.querySelector("#cleContactForm");
      var loginForm = mountEl.querySelector("#cleLoginForm");

      function setErr(field, msg) {
        var n = mountEl.querySelector('[data-err="' + field + '"]');
        if (n) n.textContent = msg || "";
      }
      function clearErrs() {
        mountEl.querySelectorAll("[data-err]").forEach(function (n) { n.textContent = ""; });
      }

      function refreshCurrents() {
        var a = getAccount(provider);
        var c = mountEl.querySelector("#cleContactCur");
        var l = mountEl.querySelector("#cleLoginCur");
        if (c) c.textContent = a.contactEmail;
        if (l) l.textContent = a.loginEmail;
      }

      function renderRequests() {
        var host = mountEl.querySelector("#cleReqList");
        if (!host) return;
        var reqs = requestsForProvider(pid);
        if (!reqs.length) { host.innerHTML = ""; return; }
        var rows = reqs.map(function (r) {
          var when = new Date(r.createdAt || Date.now());
          var ctrl = "";
          if (r.status === "pending") {
            ctrl = '<a href="#" class="cle-link" data-cle-cancel="' + escAttr(r.id) + '">Cancel</a>';
          }
          return '<li class="cle-req">' +
            '<div class="cle-reqhead">' +
              '<span><strong>' + escAttr(r.newLoginEmail) + '</strong></span>' +
              statusBadge(r.status) +
            '</div>' +
            '<div class="cle-reqmeta">From ' + escAttr(r.currentLoginEmail) + ' · raised ' +
              escAttr(when.toLocaleDateString()) + (ctrl ? ' · ' + ctrl : '') + '</div>' +
          '</li>';
        }).join("");
        host.innerHTML =
          '<p class="cle-note" style="margin-top:14px;font-weight:700;color:var(--purple,#603488)">Your login-email requests</p>' +
          '<ul class="cle-reqs">' + rows + '</ul>';
      }

      // Self-serve contact email change.
      contactForm.addEventListener("submit", function (e) {
        e.preventDefault();
        clearErrs();
        var res = changeContactEmail(provider, contactForm.contactEmail.value);
        if (!res.ok) { setErr("contactEmail", res.error); return; }
        contactForm.reset();
        refreshCurrents();
        HC.util.toast("Public contact email updated");
      });

      // Support-assisted login email request.
      loginForm.addEventListener("submit", function (e) {
        e.preventDefault();
        clearErrs();
        var res = submitLoginEmailRequest(provider, {
          newLoginEmail: loginForm.newLoginEmail.value,
          reason: loginForm.reason.value,
          confirmOwnership: mountEl.querySelector("#cleConfirm").checked
        });
        if (!res.ok) {
          for (var f in res.errors) {
            if (Object.prototype.hasOwnProperty.call(res.errors, f)) setErr(f, res.errors[f]);
          }
          return;
        }
        loginForm.reset();
        mountEl.querySelector("#cleConfirm").checked = false;
        renderRequests();
        refreshCurrents(); // login email unchanged on purpose — request only
        HC.util.toast("Request sent — our team will update your login email");
      });

      // Cancel a pending request (delegated).
      mountEl.addEventListener("click", function (e) {
        var c = e.target.closest("[data-cle-cancel]");
        if (!c) return;
        e.preventDefault();
        cancelLoginEmailRequest(c.getAttribute("data-cle-cancel"));
        renderRequests();
        HC.util.toast("Request cancelled");
      });

      renderRequests();
    } catch (e) {
      mountEl.innerHTML = '<p style="color:#9a1f5e">Account email settings failed to render: ' +
        escAttr(e && e.message ? e.message : String(e)) + "</p>";
    }
  }

  /* ============================================================
   * 6. selfTest — exercises the LOGIC and asserts the acceptance
   *    criterion. Sandboxes BOTH store keys and restores them.
   * ============================================================ */

  function selfTest() {
    var pass = 0, fail = 0, log = [];
    function check(label, fn) {
      try { fn(); pass += 1; log.push("✓ " + label); }
      catch (e) { fail += 1; log.push("✗ " + label + " — " + (e && e.message ? e.message : String(e))); }
    }

    var BACKUP_ACC = HC.store.get(ACCOUNT_KEY, null);
    var BACKUP_REQ = HC.store.get(REQUEST_KEY, null);
    HC.store.set(ACCOUNT_KEY, {});
    HC.store.set(REQUEST_KEY, {});

    try {
      var provider = firstProvider() || { id: "test-provider", name: "Test Camp Co" };
      var pid = provider.id != null ? String(provider.id) : "test-provider";

      // --- Email validation logic ---
      check("Email validation accepts valid, rejects invalid", function () {
        HC.assert(isValidEmail("owner@happycamp.co.uk"), "valid email should pass");
        HC.assert(!isValidEmail("owner@bad"), "missing TLD should fail");
        HC.assert(!isValidEmail("owner @x.com"), "spaces should fail");
      });

      check("Inbox base collapses + aliases (evidence 8019763)", function () {
        HC.assert(inboxBase("you+camp@gmail.com") === "you@gmail.com", "alias should collapse to base");
        HC.assert(inboxBase("you@gmail.com") === "you@gmail.com", "base unchanged");
        HC.assert(inboxBase("YOU+Holiday@Gmail.com") === "you@gmail.com", "case + alias collapse");
      });

      check("Alias suggestion builds a valid distinct address", function () {
        var a = suggestAlias("owner@gmail.com", "E17 Camp");
        HC.assert(a === "owner+e17camp@gmail.com", "got " + a);
        HC.assert(isValidEmail(a), "suggested alias must itself be valid");
        HC.assert(inboxBase(a) === "owner@gmail.com", "alias must share the base inbox");
      });

      // --- Two distinct seeded channels exist ---
      check("Account seeds a DISTINCT login email and contact email", function () {
        var acc = getAccount(provider);
        HC.assert(isValidEmail(acc.loginEmail), "login email should be valid: " + acc.loginEmail);
        HC.assert(isValidEmail(acc.contactEmail), "contact email should be valid: " + acc.contactEmail);
        HC.assert(acc.loginEmail !== acc.contactEmail, "login and contact email must be distinct channels");
      });

      // === ACCEPTANCE (a): public contact email is SELF-SERVE and
      //     changing it does NOT touch the login email. ===
      check("ACCEPTANCE: contact email is self-serve & instant; login email untouched", function () {
        var before = getAccount(provider);
        var res = changeContactEmail(provider, "newbookings@adventurecamps-e17.co.uk");
        HC.assert(res.ok, "valid contact-email change must succeed instantly: " + res.error);
        HC.assert(res.self_serve === true, "contact change should be flagged self-serve");
        var after = getAccount(provider);
        HC.assert(after.contactEmail === "newbookings@adventurecamps-e17.co.uk", "contact email should update immediately");
        HC.assert(after.loginEmail === before.loginEmail, "login email must NOT change when editing contact email");
      });

      check("Invalid contact email is rejected, contact email unchanged", function () {
        var before = getAccount(provider).contactEmail;
        var res = changeContactEmail(provider, "not-an-email");
        HC.assert(!res.ok, "bad contact email must be rejected");
        HC.assert(getAccount(provider).contactEmail === before, "contact email unchanged after rejected save");
      });

      // === ACCEPTANCE (b): login email is NOT self-serve — it raises a
      //     support REQUEST and the login email stays the same until
      //     support applies it. ===
      var reqId = null;
      check("ACCEPTANCE: changing login email raises a support REQUEST (pending), not an instant edit", function () {
        var before = getAccount(provider);
        var res = submitLoginEmailRequest(provider, {
          newLoginEmail: "owner@adventurecamps-e17.co.uk",
          reason: "moving to a business address",
          confirmOwnership: true
        });
        HC.assert(res.ok, "a valid login-email request must be accepted: " + JSON.stringify(res.errors));
        HC.assert(res.request && res.request.status === "pending", "request must be pending support action");
        HC.assert(res.request.supportEmail === SUPPORT_EMAIL, "request should route to support");
        reqId = res.request.id;
        var after = getAccount(provider);
        HC.assert(after.loginEmail === before.loginEmail,
          "login email must NOT change just from raising a request (support-assisted, not self-serve)");
      });

      check("ACCEPTANCE: login email only changes once SUPPORT applies the request", function () {
        HC.assert(reqId, "need a pending request id");
        var res = applyLoginEmailRequest(provider, reqId);
        HC.assert(res.ok, "support apply must succeed: " + res.error);
        var after = getAccount(provider);
        HC.assert(after.loginEmail === "owner@adventurecamps-e17.co.uk", "login email should update only after support applies");
        HC.assert(res.request.status === "applied", "request should be marked applied");
      });

      check("Applying the login email did NOT disturb the contact email (channels independent)", function () {
        var acc = getAccount(provider);
        HC.assert(acc.contactEmail === "newbookings@adventurecamps-e17.co.uk",
          "contact email should still be the self-serve value, not overwritten by the login change");
      });

      // --- Request validation paths ---
      check("Login request rejects an invalid new email", function () {
        var res = submitLoginEmailRequest(provider, { newLoginEmail: "nope@nope", confirmOwnership: true });
        HC.assert(!res.ok, "invalid email must be rejected");
        HC.assert(res.errors.newLoginEmail, "should flag newLoginEmail");
      });

      check("Login request rejects re-requesting the current login email", function () {
        var cur = getAccount(provider).loginEmail;
        var res = submitLoginEmailRequest(provider, { newLoginEmail: cur, confirmOwnership: true });
        HC.assert(!res.ok, "no-op change must be rejected");
        HC.assert(res.errors.newLoginEmail, "should flag newLoginEmail as unchanged");
      });

      check("Login request requires ownership confirmation", function () {
        var res = submitLoginEmailRequest(provider, { newLoginEmail: "fresh@othercamp.co.uk", confirmOwnership: false });
        HC.assert(!res.ok, "unconfirmed ownership must be rejected");
        HC.assert(res.errors.confirmOwnership, "should flag confirmOwnership");
      });

      // --- Uniqueness / alias rule (evidence 8019763) ---
      check("Duplicate login email across accounts is blocked, with a + alias tip", function () {
        // Seed a SECOND account that already logs in with a base inbox.
        var all = readAccounts();
        all["other-camp"] = {
          providerId: "other-camp", providerName: "Other Camp",
          loginEmail: "shared@gmail.com", contactEmail: "hello@othercamp.co.uk"
        };
        HC.store.set(ACCOUNT_KEY, all);

        var res = submitLoginEmailRequest(provider, { newLoginEmail: "shared@gmail.com", confirmOwnership: true });
        HC.assert(!res.ok, "an email already used to log in elsewhere must be blocked");
        HC.assert(/already used to log in/i.test(res.errors.newLoginEmail || ""), "should explain the clash");
        HC.assert(/\+/.test(res.errors.newLoginEmail || ""), "should suggest a + alias workaround");

        // The documented workaround (a + alias) is accepted.
        var res2 = submitLoginEmailRequest(provider, { newLoginEmail: "shared+e17@gmail.com", confirmOwnership: true });
        HC.assert(res2.ok, "a + alias of the shared inbox should be allowed: " + JSON.stringify(res2.errors));
        // tidy up the pending alias request
        cancelLoginEmailRequest(res2.request.id);
      });

      check("Pending request can be cancelled", function () {
        var res = submitLoginEmailRequest(provider, { newLoginEmail: "cancelme@yourcamp.co.uk", confirmOwnership: true });
        HC.assert(res.ok, "request should submit");
        var c = cancelLoginEmailRequest(res.request.id);
        HC.assert(c.ok, "cancel should succeed");
        HC.assert(c.request.status === "cancelled", "status should be cancelled");
        // login email unchanged
        HC.assert(getAccount(provider).loginEmail === "owner@adventurecamps-e17.co.uk", "cancelling must not change login email");
      });

      check("Request history is recorded per provider", function () {
        var reqs = requestsForProvider(pid);
        HC.assert(reqs.length >= 1, "should have at least one request on record");
        HC.assert(reqs.some(function (r) { return r.status === "applied"; }), "should include the applied request");
      });

      check("Overlays are namespaced; live camps.js provider is never mutated", function () {
        var liveName = provider.name;
        getAccount(provider);
        changeContactEmail(provider, "x@y.co.uk");
        HC.assert(provider.name === liveName, "live provider object must be untouched");
        HC.assert(!('loginEmail' in provider), "must not add fields to the live provider record");
      });

    } finally {
      if (BACKUP_ACC === null) HC.store.remove(ACCOUNT_KEY); else HC.store.set(ACCOUNT_KEY, BACKUP_ACC);
      if (BACKUP_REQ === null) HC.store.remove(REQUEST_KEY); else HC.store.set(REQUEST_KEY, BACKUP_REQ);
    }

    return { pass: pass, fail: fail, log: log };
  }

  /* ============================================================
   * 7. Register.
   * ============================================================ */

  HC.registerFeature({
    id: "provider-change-login-email",
    title: "Change account login email",
    side: "provider",
    icon: "🔐",
    summary: "Account & sign-in settings that separate your public contact email (self-serve, instant) from your login email — with a support-assisted request flow to change the email you sign in with.",
    render: render,
    selfTest: selfTest
  });
})();
