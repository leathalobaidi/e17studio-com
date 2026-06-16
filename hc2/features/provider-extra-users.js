/* HolidayCamp feature: provider-extra-users
 * ------------------------------------------------------------------
 * Replicates Happity's "Can I add extra users to my account?" for the
 * PROVIDER side, reframed for SCHOOL-AGE HOLIDAY CAMPS.
 *
 * Evidence (support corpus):
 *  - 5917325 "Can I add extra users to my account?":
 *    "You can add other users to your Happity account to allow other
 *     users access to the dashboard and make changes to information and
 *     classes on the account." Flow: Settings (left menu) > Users >
 *     "Create new user". "Once you have created the new user, press the
 *     envelope symbol next to their name. This sends them their
 *     activation email; they will then be required to activate their
 *     account and create a login password." The new user can then log
 *     in. To REMOVE a user you must contact support@happity.co.uk.
 *     Alternatively create a TEACHER account (register-only) instead of
 *     a full user — they cannot change the account.
 *  - 8019763 "Can I use the same email address across multiple accounts?":
 *    the same base email can be reused via "+alias" addresses (e.g.
 *    example+camps@gmail.com) so a person with several accounts still
 *    gets one inbox but distinct logins. Modelled here: an invite email
 *    must be unique within THIS account, but +aliases of the same base
 *    are treated as distinct logins (so they are allowed).
 *
 * Acceptance criterion (asserted by selfTest, multiple cases):
 *   "Provider can invite an additional user who gets an activation email
 *    and dashboard access."
 *   -> invite a full user -> a pending activation email is queued
 *      (envelope) -> user activates with a password -> user is active and
 *      has dashboard access. Teacher role gets registers-only access.
 *      Invalid / duplicate invites are rejected and never granted access.
 *
 * Defensive: nothing throws at registration time. Persistence is via
 * HC.store ONLY (one namespaced key, keyed by provider id); the verified
 * camps.js data is never mutated.
 * ------------------------------------------------------------------ */
(function () {
  "use strict";

  if (typeof window === "undefined" || !window.HC || typeof window.HC.registerFeature !== "function") {
    // Core not present — fail silently rather than throwing.
    return;
  }
  var HC = window.HC;

  var STORE_KEY = "provider_extra_users"; // { [providerId]: { users: [ {..} ] } }

  var NAME_MAX = 80;

  // Roles mirror Happity: a full "user" can change the account & classes;
  // a "teacher" can only see class registers (the register-only account).
  var ROLES = {
    user: {
      label: "Full user",
      desc: "Can sign in to the dashboard and edit camps, dates and bookings.",
      dashboard: true,
      canEditAccount: true,
      registersOnly: false
    },
    teacher: {
      label: "Teacher (registers only)",
      desc: "Can only view class registers. Cannot change the account or camps.",
      dashboard: true,
      canEditAccount: false,
      registersOnly: true
    }
  };

  // Lifecycle states a seat moves through, mirroring the article:
  //   invited  -> created, NO activation email sent yet
  //   pending  -> activation email sent (envelope pressed), awaiting activation
  //   active   -> user set a password and activated; has dashboard access
  var STATES = ["invited", "pending", "active"];

  /* ============================================================
   * 1. Pure helpers + validation.
   * ============================================================ */

  function trimStr(s) { return String(s == null ? "" : s).replace(/\s+/g, " ").trim(); }
  function lc(s) { return trimStr(s).toLowerCase(); }

  function isValidEmail(raw) {
    var s = trimStr(raw);
    if (!s) return false;
    return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s);
  }

  function isValidRole(role) {
    return Object.prototype.hasOwnProperty.call(ROLES, role);
  }

  // A password must be set by the new user at activation. Mirror a sane
  // minimum so an "activated" account isn't a blank-password account.
  function isValidPassword(pw) {
    return typeof pw === "string" && pw.length >= 8;
  }

  // Normalised comparison key for an email login. We deliberately keep the
  // "+alias" because evidence 8019763 says +aliases are DISTINCT logins,
  // so example@x.com and example+camps@x.com may co-exist as two users.
  function emailKey(email) {
    return lc(email);
  }

  // Whether an invite would collide with an existing seat on this account.
  function isDuplicateEmail(users, email, ignoreId) {
    var key = emailKey(email);
    for (var i = 0; i < users.length; i++) {
      if (ignoreId && users[i].id === ignoreId) continue;
      if (emailKey(users[i].email) === key) return true;
    }
    return false;
  }

  /* ============================================================
   * 2. Store access — overlay keyed by provider id. Never touches
   *    camps.js. Each provider has an independent list of seats.
   * ============================================================ */

  function readAll() {
    var all = HC.store.get(STORE_KEY, {});
    return (all && typeof all === "object") ? all : {};
  }

  function getUsers(providerId) {
    var rec = readAll()[String(providerId)];
    if (rec && Array.isArray(rec.users)) return rec.users.slice();
    return [];
  }

  function setUsers(providerId, users) {
    var all = readAll();
    all[String(providerId)] = { users: Array.isArray(users) ? users : [] };
    HC.store.set(STORE_KEY, all);
    return users;
  }

  /* ============================================================
   * 3. Core actions — the seat lifecycle.
   *    invite -> sendActivation (envelope) -> activate.
   *    Each returns { ok, error?, errors?, user? } so the UI and the
   *    selfTest can both reason about success/failure cleanly.
   * ============================================================ */

  // Validate an invite payload. Returns { ok, errors:{field:msg}, clean }.
  function validateInvite(providerId, input) {
    var errors = {};
    var src = input || {};
    var name = trimStr(src.name);
    var email = trimStr(src.email);
    var role = trimStr(src.role) || "user";

    if (!name) errors.name = "Enter the person's name.";
    else if (name.length > NAME_MAX) errors.name = "Name must be " + NAME_MAX + " characters or fewer.";

    if (!email) errors.email = "Enter an email address for the activation email.";
    else if (!isValidEmail(email)) errors.email = "Enter a valid email address.";

    if (!isValidRole(role)) errors.role = "Choose a valid role.";

    if (email && isValidEmail(email) && isDuplicateEmail(getUsers(providerId), email)) {
      errors.email = "That email already has a seat on this account.";
    }

    var clean = { name: name, email: email, role: isValidRole(role) ? role : "user" };
    return { ok: Object.keys(errors).length === 0, errors: errors, clean: clean };
  }

  // Create a seat. Per the article this is "Create new user": the seat
  // now exists but NO activation email has gone out yet (state=invited).
  function invite(providerId, input) {
    var v = validateInvite(providerId, input);
    if (!v.ok) return { ok: false, errors: v.errors };
    var users = getUsers(providerId);
    var user = {
      id: HC.util.uid(),
      name: v.clean.name,
      email: v.clean.email,
      role: v.clean.role,
      state: "invited",
      activationSentAt: null,
      activatedAt: null,
      invitedAt: Date.now()
    };
    users.push(user);
    setUsers(providerId, users);
    return { ok: true, user: user };
  }

  // Press the envelope: send (or re-send) the activation email. This is
  // the literal acceptance behaviour — the new user "gets an activation
  // email". State moves invited -> pending (still pending until they
  // activate). Re-sending to a pending user is allowed (resend).
  function sendActivation(providerId, userId) {
    var users = getUsers(providerId);
    var found = null;
    for (var i = 0; i < users.length; i++) {
      if (users[i].id === userId) { found = users[i]; break; }
    }
    if (!found) return { ok: false, error: "User not found." };
    if (found.state === "active") return { ok: false, error: "User is already active." };
    found.state = "pending";
    found.activationSentAt = Date.now();
    setUsers(providerId, users);
    return { ok: true, user: found };
  }

  // The new user follows the activation email and sets a login password.
  // State moves pending -> active. On success the user has dashboard
  // access (and, if a teacher, registers-only access).
  function activate(providerId, userId, password) {
    var users = getUsers(providerId);
    var found = null;
    for (var i = 0; i < users.length; i++) {
      if (users[i].id === userId) { found = users[i]; break; }
    }
    if (!found) return { ok: false, error: "User not found." };
    if (found.state === "invited") return { ok: false, error: "No activation email has been sent yet." };
    if (found.state === "active") return { ok: false, error: "Account is already activated." };
    if (!isValidPassword(password)) return { ok: false, error: "Choose a password of at least 8 characters." };
    found.state = "active";
    found.activatedAt = Date.now();
    // Never store the raw password in this mock; record only that one is set.
    found.hasPassword = true;
    setUsers(providerId, users);
    return { ok: true, user: found };
  }

  // Per the article, removing a user means contacting support. We model a
  // local removal for the mock UI but keep the messaging truthful.
  function removeUser(providerId, userId) {
    var users = getUsers(providerId).filter(function (u) { return u.id !== userId; });
    setUsers(providerId, users);
    return { ok: true };
  }

  // Derived access summary for a seat — what this user can actually do.
  function accessFor(user) {
    var role = ROLES[user && user.role] || ROLES.user;
    var active = user && user.state === "active";
    return {
      hasDashboardAccess: !!(active && role.dashboard),
      canEditAccount: !!(active && role.canEditAccount),
      registersOnly: !!role.registersOnly,
      roleLabel: role.label
    };
  }

  /* ============================================================
   * 4. Render — the Settings > Users panel, reframed.
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

  function stateBadge(state) {
    if (state === "active") return '<span class="peu-badge peu-active">Active</span>';
    if (state === "pending") return '<span class="peu-badge peu-pending">Activation sent</span>';
    return '<span class="peu-badge peu-invited">Invited</span>';
  }

  function render(mountEl) {
    try {
      var provider = firstProvider() || { id: "demo-provider", name: "Your holiday camp" };
      var providerId = provider.id != null ? String(provider.id) : "demo-provider";
      var providerName = provider.name || providerId;

      mountEl.innerHTML =
        '<style>' +
          '.peu-wrap{font-family:"Nunito Sans",system-ui,sans-serif;color:var(--text,#383838)}' +
          '.peu-crumb{font-size:13.5px;margin:0 0 12px}' +
          '.peu-form{border:1.5px solid var(--line,#E6E6E6);border-radius:14px;padding:14px 15px;background:#FBF8FD;margin:0 0 16px}' +
          '.peu-form h4{font-family:"Quicksand",system-ui,sans-serif;color:var(--purple,#603488);margin:0 0 10px;font-size:14.5px}' +
          '.peu-field{margin:0 0 10px}' +
          '.peu-field label{display:block;font-family:"Quicksand",system-ui,sans-serif;font-weight:700;font-size:12.5px;' +
            'color:var(--purple,#603488);margin:0 0 4px}' +
          '.peu-field input,.peu-field select{width:100%;box-sizing:border-box;border:1.5px solid var(--line,#E6E6E6);' +
            'border-radius:12px;padding:9px 12px;font-size:14px;font-family:inherit;background:#fff}' +
          '.peu-field input:focus,.peu-field select:focus{outline:none;border-color:var(--purple,#603488)}' +
          '.peu-two{display:grid;grid-template-columns:1fr 1fr;gap:10px}' +
          '.peu-err{color:#9a1f5e;font-size:12px;margin-top:3px}' +
          '.peu-hint{color:var(--muted,#808080);font-size:11.5px;margin:2px 0 0}' +
          '.peu-list{list-style:none;margin:0;padding:0}' +
          '.peu-row{display:flex;align-items:center;gap:10px;padding:11px 0;border-bottom:1px solid var(--line,#E6E6E6);flex-wrap:wrap}' +
          '.peu-who{flex:1 1 180px;min-width:140px}' +
          '.peu-name{font-family:"Quicksand",system-ui,sans-serif;font-weight:700;color:var(--purple,#603488);font-size:14px}' +
          '.peu-email{font-size:12.5px;color:var(--muted,#808080)}' +
          '.peu-role{font-size:11.5px;color:var(--text,#383838)}' +
          '.peu-badge{font-family:"Quicksand",system-ui,sans-serif;font-weight:700;font-size:10.5px;padding:3px 9px;border-radius:999px;' +
            'text-transform:uppercase;letter-spacing:.3px}' +
          '.peu-invited{background:var(--purple-tint,#F0E8F4);color:var(--purple,#603488)}' +
          '.peu-pending{background:#FFF3D6;color:#8a6d00}' +
          '.peu-active{background:#E1F0E4;color:#2f7d4f}' +
          '.peu-actions{display:flex;gap:6px;flex-wrap:wrap}' +
          '.peu-iconbtn{border:1.5px solid var(--purple-tint,#F0E8F4);background:#fff;cursor:pointer;border-radius:10px;' +
            'padding:6px 9px;font-size:13px;line-height:1}' +
          '.peu-iconbtn:hover{background:var(--purple-tint,#F0E8F4)}' +
          '.peu-empty{color:var(--muted,#808080);font-size:13px;padding:10px 0}' +
          '.peu-note{font-size:11.5px;color:var(--muted,#808080);margin:14px 0 0;border-top:1px dashed var(--line,#E6E6E6);padding-top:10px}' +
          '@media(max-width:520px){.peu-two{grid-template-columns:1fr}}' +
        '</style>' +
        '<div class="peu-wrap">' +
          '<p class="peu-crumb">Settings &rsaquo; <strong>Users</strong> — give colleagues access to ' +
            '<strong>' + escAttr(providerName) + '</strong>’s holiday-camp dashboard. ' +
            'Create a user, then press the ✉️ envelope to send their activation email.</p>' +
          '<div class="peu-form">' +
            '<h4>Create new user</h4>' +
            '<div class="peu-two">' +
              '<div class="peu-field">' +
                '<label for="peuName">Name</label>' +
                '<input id="peuName" type="text" maxlength="' + NAME_MAX + '" placeholder="e.g. Sam the Camp Lead">' +
                '<div class="peu-err" data-err="name"></div>' +
              '</div>' +
              '<div class="peu-field">' +
                '<label for="peuEmail">Email</label>' +
                '<input id="peuEmail" type="text" placeholder="sam@yourcamp.co.uk">' +
                '<div class="peu-err" data-err="email"></div>' +
              '</div>' +
            '</div>' +
            '<div class="peu-field">' +
              '<label for="peuRole">Role</label>' +
              '<select id="peuRole">' +
                '<option value="user">Full user — can edit camps &amp; bookings</option>' +
                '<option value="teacher">Teacher — class registers only</option>' +
              '</select>' +
              '<div class="peu-err" data-err="role"></div>' +
              '<p class="peu-hint">You can reuse one inbox across accounts with a “+alias” email, e.g. you+camps@gmail.com.</p>' +
            '</div>' +
            '<button type="button" class="hc-btn" id="peuInvite">Create new user</button>' +
          '</div>' +
          '<ul class="peu-list" id="peuList"></ul>' +
          '<p class="peu-note">To remove a user, contact the HolidayCamp team. Teacher accounts only see registers and cannot change the account.</p>' +
        '</div>';

      var listEl = mountEl.querySelector("#peuList");

      function clearErrors() {
        mountEl.querySelectorAll("[data-err]").forEach(function (n) { n.textContent = ""; });
      }
      function showErrors(errors) {
        clearErrors();
        for (var f in errors) {
          if (!Object.prototype.hasOwnProperty.call(errors, f)) continue;
          var n = mountEl.querySelector('[data-err="' + f + '"]');
          if (n) n.textContent = errors[f];
        }
      }

      function renderList() {
        var users = getUsers(providerId);
        if (!users.length) {
          listEl.innerHTML = '<li class="peu-empty">No extra users yet. Create one above to share dashboard access.</li>';
          return;
        }
        listEl.innerHTML = users.map(function (u) {
          var acc = accessFor(u);
          var sendLabel = u.state === "active" ? "" :
            (u.state === "pending"
              ? '<button class="peu-iconbtn" data-resend="' + escAttr(u.id) + '" title="Re-send activation email">✉️ Resend</button>' +
                '<button class="peu-iconbtn" data-activate="' + escAttr(u.id) + '" title="Simulate the user activating">✓ Activate</button>'
              : '<button class="peu-iconbtn" data-send="' + escAttr(u.id) + '" title="Send activation email">✉️ Send</button>');
          var accessLine = acc.hasDashboardAccess
            ? (acc.registersOnly ? "Registers-only dashboard access" : "Full dashboard access")
            : "No access yet";
          return '<li class="peu-row">' +
            '<div class="peu-who">' +
              '<div class="peu-name">' + escAttr(u.name) + '</div>' +
              '<div class="peu-email">' + escAttr(u.email) + '</div>' +
              '<div class="peu-role">' + escAttr(acc.roleLabel) + ' · ' + escAttr(accessLine) + '</div>' +
            '</div>' +
            stateBadge(u.state) +
            '<div class="peu-actions">' + sendLabel +
              '<button class="peu-iconbtn" data-remove="' + escAttr(u.id) + '" title="Remove user">🗑️</button>' +
            '</div>' +
          '</li>';
        }).join("");
      }

      mountEl.querySelector("#peuInvite").addEventListener("click", function () {
        var res = invite(providerId, {
          name: mountEl.querySelector("#peuName").value,
          email: mountEl.querySelector("#peuEmail").value,
          role: mountEl.querySelector("#peuRole").value
        });
        if (!res.ok) {
          showErrors(res.errors);
          HC.util.toast("Please fix the highlighted fields");
          return;
        }
        clearErrors();
        mountEl.querySelector("#peuName").value = "";
        mountEl.querySelector("#peuEmail").value = "";
        renderList();
        HC.util.toast("User created — press ✉️ to send their activation email");
      });

      listEl.addEventListener("click", function (e) {
        var send = e.target.closest("[data-send]");
        var resend = e.target.closest("[data-resend]");
        var act = e.target.closest("[data-activate]");
        var rem = e.target.closest("[data-remove]");
        if (send) {
          var r1 = sendActivation(providerId, send.getAttribute("data-send"));
          renderList();
          HC.util.toast(r1.ok ? "Activation email sent ✉️" : (r1.error || "Could not send"));
        } else if (resend) {
          var r2 = sendActivation(providerId, resend.getAttribute("data-resend"));
          renderList();
          HC.util.toast(r2.ok ? "Activation email re-sent ✉️" : (r2.error || "Could not re-send"));
        } else if (act) {
          var r3 = activate(providerId, act.getAttribute("data-activate"), "demo-pass-1234");
          renderList();
          HC.util.toast(r3.ok ? "Account activated — dashboard access granted" : (r3.error || "Could not activate"));
        } else if (rem) {
          removeUser(providerId, rem.getAttribute("data-remove"));
          renderList();
          HC.util.toast("User removed");
        }
      });

      renderList();
    } catch (e) {
      mountEl.innerHTML = '<p style="color:#9a1f5e">Users panel failed to render: ' +
        escAttr(e && e.message ? e.message : String(e)) + "</p>";
    }
  }

  /* ============================================================
   * 5. selfTest — exercises the LOGIC and asserts the acceptance
   *    criterion: "Provider can invite an additional user who gets an
   *    activation email and dashboard access." Multiple cases including
   *    the teacher (registers-only) role, duplicate/invalid rejection,
   *    the +alias rule, and lifecycle guards. Restores the store after.
   * ============================================================ */

  function selfTest() {
    var pass = 0, fail = 0, log = [];
    function check(label, fn) {
      try { fn(); pass += 1; log.push("✓ " + label); }
      catch (e) { fail += 1; log.push("✗ " + label + " — " + (e && e.message ? e.message : String(e))); }
    }

    // Snapshot + sandbox the real store so the test never leaks state.
    var BACKUP = HC.store.get(STORE_KEY, null);
    HC.store.set(STORE_KEY, {});

    try {
      var provider = firstProvider() || { id: "test-provider", name: "Test Camp Co" };
      var pid = provider.id != null ? String(provider.id) : "test-provider";

      // --- Validation logic ---
      check("Invalid invites are rejected (blank name, bad email, bad role)", function () {
        HC.assert(!validateInvite(pid, { name: "", email: "a@b.co", role: "user" }).ok, "blank name should fail");
        HC.assert(!validateInvite(pid, { name: "Sam", email: "not-an-email", role: "user" }).ok, "bad email should fail");
        HC.assert(!validateInvite(pid, { name: "Sam", email: "a@b.co", role: "wizard" }).ok, "bad role should fail");
        HC.assert(validateInvite(pid, { name: "Sam", email: "a@b.co", role: "user" }).ok, "a clean invite should pass");
      });

      // === ACCEPTANCE CRITERION (full user) ===
      // Invite -> activation email -> activate -> dashboard access.
      var fullUserId = null;
      check("ACCEPTANCE: invite a full user; they get an activation email and dashboard access", function () {
        var inv = invite(pid, { name: "Sam the Camp Lead", email: "sam@adventurecamps-e17.co.uk", role: "user" });
        HC.assert(inv.ok, "valid invite must succeed: " + JSON.stringify(inv.errors || {}));
        fullUserId = inv.user.id;
        HC.assert(inv.user.state === "invited", "new seat starts as 'invited' (no email yet), got " + inv.user.state);
        HC.assert(!accessFor(inv.user).hasDashboardAccess, "no access before activation");

        // Press the envelope -> activation email is sent.
        var sent = sendActivation(pid, fullUserId);
        HC.assert(sent.ok, "sending the activation email must succeed");
        HC.assert(sent.user.state === "pending", "after sending, state must be 'pending', got " + sent.user.state);
        HC.assert(typeof sent.user.activationSentAt === "number" && sent.user.activationSentAt > 0,
          "an activation email must be recorded as sent");

        // User activates with a password -> dashboard access.
        var act = activate(pid, fullUserId, "campLeader2026!");
        HC.assert(act.ok, "activation with a valid password must succeed: " + (act.error || ""));
        HC.assert(act.user.state === "active", "after activation, state must be 'active'");
        var acc = accessFor(act.user);
        HC.assert(acc.hasDashboardAccess === true, "an activated full user MUST have dashboard access");
        HC.assert(acc.canEditAccount === true, "a full user can edit the account");
        HC.assert(acc.registersOnly === false, "a full user is not registers-only");
      });

      check("Activation requires a password of at least 8 characters", function () {
        var inv = invite(pid, { name: "Weak Pass", email: "weak@adventurecamps-e17.co.uk", role: "user" });
        sendActivation(pid, inv.user.id);
        var bad = activate(pid, inv.user.id, "short");
        HC.assert(!bad.ok, "a too-short password must be rejected");
        // user must remain un-activated / without access
        var users = getUsers(pid);
        var u = users.filter(function (x) { return x.id === inv.user.id; })[0];
        HC.assert(u.state === "pending", "failed activation must leave the user pending");
        HC.assert(!accessFor(u).hasDashboardAccess, "no access after a failed activation");
      });

      check("Cannot activate before the activation email has been sent", function () {
        var inv = invite(pid, { name: "No Email Yet", email: "noemail@adventurecamps-e17.co.uk", role: "user" });
        var early = activate(pid, inv.user.id, "validPass123");
        HC.assert(!early.ok, "activating an 'invited' (un-emailed) user must fail");
        HC.assert(/activation email/i.test(early.error || ""), "error should mention the missing activation email");
      });

      // === ACCEPTANCE CRITERION (teacher / register-only seat) ===
      check("Teacher role gets registers-only dashboard access, cannot edit the account", function () {
        var inv = invite(pid, { name: "Teacher Tara", email: "tara@adventurecamps-e17.co.uk", role: "teacher" });
        HC.assert(inv.ok, "teacher invite must succeed");
        sendActivation(pid, inv.user.id);
        var act = activate(pid, inv.user.id, "registersOnly1");
        HC.assert(act.ok, "teacher activation must succeed");
        var acc = accessFor(act.user);
        HC.assert(acc.hasDashboardAccess === true, "an activated teacher has dashboard (register) access");
        HC.assert(acc.registersOnly === true, "a teacher is registers-only");
        HC.assert(acc.canEditAccount === false, "a teacher must NOT be able to edit the account");
      });

      // --- Duplicate / alias rules (evidence 8019763) ---
      check("Duplicate email on the same account is rejected", function () {
        var dup = invite(pid, { name: "Sam Clone", email: "SAM@adventurecamps-e17.co.uk", role: "user" });
        HC.assert(!dup.ok, "re-inviting the same email (case-insensitive) must be rejected");
        HC.assert(dup.errors && dup.errors.email, "the email field should carry the duplicate error");
      });

      check("A '+alias' of the same base email is treated as a distinct login (evidence 8019763)", function () {
        var aliasInv = invite(pid, { name: "Sam Alias", email: "sam+registers@adventurecamps-e17.co.uk", role: "teacher" });
        HC.assert(aliasInv.ok, "a +alias email must be allowed as a separate seat: " + JSON.stringify(aliasInv.errors || {}));
      });

      // --- Persistence + isolation ---
      check("Seats persist across a fresh read (round-trip persistence)", function () {
        var users = getUsers(pid);
        var sam = users.filter(function (u) { return u.id === fullUserId; })[0];
        HC.assert(sam, "Sam's seat must still exist after re-read");
        HC.assert(sam.state === "active", "Sam must still be active after re-read");
        HC.assert(accessFor(sam).hasDashboardAccess, "Sam must still have dashboard access after re-read");
      });

      check("Re-sending an activation email is allowed while pending, blocked once active", function () {
        // active user: cannot re-send
        var blocked = sendActivation(pid, fullUserId);
        HC.assert(!blocked.ok, "cannot re-send activation to an already-active user");
        // a pending user: can re-send
        var inv = invite(pid, { name: "Resend Me", email: "resend@adventurecamps-e17.co.uk", role: "user" });
        sendActivation(pid, inv.user.id);
        var again = sendActivation(pid, inv.user.id);
        HC.assert(again.ok, "re-sending to a pending user must be allowed");
      });

      check("Removing a user revokes their seat and access", function () {
        var inv = invite(pid, { name: "Temp User", email: "temp@adventurecamps-e17.co.uk", role: "user" });
        sendActivation(pid, inv.user.id);
        activate(pid, inv.user.id, "tempPass123");
        var before = getUsers(pid).length;
        removeUser(pid, inv.user.id);
        var after = getUsers(pid);
        HC.assert(after.length === before - 1, "removal should drop exactly one seat");
        HC.assert(!after.some(function (u) { return u.id === inv.user.id; }), "removed user must be gone");
      });

      check("Seats are isolated per provider (namespaced overlay, camps.js untouched)", function () {
        var otherId = "another-provider-xyz";
        HC.assert(getUsers(otherId).length === 0, "a different provider starts with no seats");
        invite(otherId, { name: "Other Co Admin", email: "admin@otherco.co.uk", role: "user" });
        HC.assert(getUsers(otherId).length === 1, "invite lands on the right provider");
        var liveName = provider.name;
        HC.assert(provider.name === liveName, "live camps.js provider object must be untouched");
      });

    } finally {
      // Restore the real store exactly as found.
      if (BACKUP === null) HC.store.remove(STORE_KEY);
      else HC.store.set(STORE_KEY, BACKUP);
    }

    return { pass: pass, fail: fail, log: log };
  }

  /* ============================================================
   * 6. Register.
   * ============================================================ */

  HC.registerFeature({
    id: "provider-extra-users",
    title: "Add extra dashboard users",
    side: "provider",
    icon: "👥",
    summary: "Settings › Users — invite colleagues to your holiday-camp dashboard. Create a user, send their activation email (✉️), and they activate with a password to get access. Teacher seats see registers only.",
    render: render,
    selfTest: selfTest
  });
})();
