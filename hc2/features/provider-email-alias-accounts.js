/* HolidayCamp feature: provider-email-alias-accounts
 * ------------------------------------------------------------------
 * Replicates Happity's "Can I use the same email address across
 * multiple accounts?" for the PROVIDER side, reframed for SCHOOL-AGE
 * HOLIDAY CAMPS.
 *
 * Evidence (support corpus article 8019763, "Can I use the same email
 * address across multiple accounts?"):
 *   "We know that many of our providers are also parent users or have
 *    multiple accounts ... and want to use the same email address for
 *    everything Happity related. To do this you will need to use
 *    'alias' email addresses, which will mean that all your emails come
 *    into the same place, but you will have different logins for your
 *    different accounts."
 *   "Many email providers support the use of '+' aliases ... add a '+'
 *    followed by any text of your choice before the '@' symbol." It then
 *    lists Gmail, Outlook.com, Yahoo Mail, ProtonMail and FastMail as
 *    supporting '+ aliases', e.g. example+alias@gmail.com.
 *
 * Acceptance criterion (asserted by selfTest, multiple cases):
 *   "The platform supports one person holding multiple distinct accounts
 *    (parent and provider, or several provider accounts) keyed by alias
 *    emails, each with its own login, documented at sign-up."
 *   ->  one base inbox (jess@gmail.com) -> several +alias logins
 *       (jess+camps@gmail.com, jess+parent@gmail.com, ...) -> each is a
 *       SEPARATE account with its own login, but every alias delivers to
 *       the SAME inbox base. A bare base email can be used once; further
 *       accounts on that inbox MUST carry a distinct +alias.
 *
 * Defensive: nothing throws at registration time. Persistence is via
 * HC.store ONLY (one namespaced key); the verified camps.js data is
 * never mutated. selfTest uses an isolated store key it tidies up.
 * ------------------------------------------------------------------ */
(function () {
  "use strict";

  if (typeof window === "undefined" || !window.HC || typeof window.HC.registerFeature !== "function") {
    // Core not present — fail silently rather than throwing.
    return;
  }
  var HC = window.HC;

  var STORE_KEY = "provider_email_alias_accounts"; // { accounts: [ {..} ] }

  // Email providers the article confirms support "+" aliasing.
  var ALIAS_PROVIDERS = {
    "gmail.com": "Gmail",
    "googlemail.com": "Gmail",
    "outlook.com": "Outlook.com",
    "hotmail.com": "Outlook.com",
    "live.com": "Outlook.com",
    "yahoo.com": "Yahoo Mail",
    "yahoo.co.uk": "Yahoo Mail",
    "protonmail.com": "ProtonMail",
    "proton.me": "ProtonMail",
    "pm.me": "ProtonMail",
    "fastmail.com": "FastMail",
    "fastmail.co.uk": "FastMail"
  };

  // Account "kinds" a single person may hold side by side. Mirrors the
  // article's "providers are also parent users or have multiple accounts".
  var KINDS = {
    provider: { label: "Provider account", desc: "Manage your holiday-camp listings, bookings and registers." },
    parent:   { label: "Parent account",   desc: "Book camps for your own school-age children." }
  };

  var ALIAS_MAX = 30;

  /* ===================================================================
     PURE LOGIC — email/alias parsing & the multi-account registry.
     All functions are total and never throw (defensive by construction).
     =================================================================== */

  // Parse an email into { ok, base, alias, localBase, domain, provider,
  // canonical, raw }. `localBase` is the part before any "+"; `canonical`
  // is localBase@domain (the shared inbox key). `alias` is the text after
  // "+", or "" when none.
  function parseEmail(raw) {
    var out = { ok: false, base: "", alias: "", localBase: "", domain: "", provider: null, canonical: "", raw: String(raw == null ? "" : raw) };
    var s = out.raw.trim().toLowerCase();
    if (!s) { out.reason = "empty"; return out; }
    var at = s.indexOf("@");
    // Exactly one "@", with non-empty local + domain parts.
    if (at <= 0 || at !== s.lastIndexOf("@") || at === s.length - 1) { out.reason = "format"; return out; }
    var local = s.slice(0, at);
    var domain = s.slice(at + 1);
    // Domain must look like name.tld (no spaces, at least one dot).
    if (domain.indexOf(".") < 1 || /\s/.test(domain) || domain.indexOf("..") !== -1) { out.reason = "domain"; return out; }
    if (/\s/.test(local)) { out.reason = "local"; return out; }
    var plus = local.indexOf("+");
    var localBase = plus === -1 ? local : local.slice(0, plus);
    var alias = plus === -1 ? "" : local.slice(plus + 1);
    if (!localBase) { out.reason = "local"; return out; } // "+tag@x" with no base
    // Alias may not itself contain another "+" tag fragment that is empty,
    // e.g. "a++b" -> treat the whole thing after the first "+" as alias text
    // but reject a trailing/leading-only empty alias when a "+" was typed.
    if (plus !== -1 && !alias) { out.reason = "empty-alias"; return out; }
    out.ok = true;
    out.localBase = localBase;
    out.domain = domain;
    out.alias = alias;
    out.base = localBase + "@" + domain;        // the inbox without any tag
    out.canonical = localBase + "@" + domain;   // shared-inbox key
    out.provider = ALIAS_PROVIDERS[domain] || null;
    return out;
  }

  // True when the domain is a known "+ alias"-supporting provider.
  function supportsAlias(email) {
    var p = parseEmail(email);
    return p.ok && !!p.provider;
  }

  // Build a +alias address from a base email and an alias tag.
  // makeAlias("jess@gmail.com", "camps") -> "jess+camps@gmail.com".
  function makeAlias(baseEmail, aliasTag) {
    var p = parseEmail(baseEmail);
    var tag = normaliseAlias(aliasTag);
    if (!p.ok || !tag) return null;
    return p.localBase + "+" + tag + "@" + p.domain;
  }

  // Normalise an alias tag: lowercase, trim, spaces->dashes, strip a
  // leading "+", keep [a-z0-9._-], cap length. Returns "" if nothing left.
  function normaliseAlias(tag) {
    var s = String(tag == null ? "" : tag).trim().toLowerCase();
    if (s.charAt(0) === "+") s = s.slice(1);
    s = s.replace(/\s+/g, "-").replace(/[^a-z0-9._-]/g, "");
    return s.slice(0, ALIAS_MAX);
  }

  // Two emails share an inbox when their canonical (localBase@domain) match.
  function sameInbox(a, b) {
    var pa = parseEmail(a), pb = parseEmail(b);
    return pa.ok && pb.ok && pa.canonical === pb.canonical;
  }

  // Two LOGINS are the same when their full address (base+alias) matches,
  // case-insensitively. This is the login key — DISTINCT per account.
  function sameLogin(a, b) {
    var pa = parseEmail(a), pb = parseEmail(b);
    if (!pa.ok || !pb.ok) return false;
    return loginKey(pa) === loginKey(pb);
  }

  function loginKey(p) {
    // Full local part (with +alias) @ domain — what the user types to log in.
    return (p.alias ? (p.localBase + "+" + p.alias) : p.localBase) + "@" + p.domain;
  }

  /* ---------- the multi-account registry ---------- */

  function readAll() {
    var raw = HC.store.get(STORE_KEY, { accounts: [] });
    if (!raw || typeof raw !== "object" || !Array.isArray(raw.accounts)) return { accounts: [] };
    return raw;
  }
  function writeAll(state) {
    HC.store.set(STORE_KEY, { accounts: Array.isArray(state.accounts) ? state.accounts : [] });
    return state;
  }
  function accounts() { return readAll().accounts.slice(); }

  // Validate a proposed account against the existing set.
  // { ok, value:{ email, loginKey, canonical, kind, name, provider }, reason, msg }
  function validateAccount(input, existing) {
    existing = Array.isArray(existing) ? existing : accounts();
    var email = input && input.email;
    var kind = input && input.kind;
    var name = String((input && input.name) || "").trim().slice(0, 80);

    var p = parseEmail(email);
    if (!p.ok) return { ok: false, reason: "email", msg: "That doesn't look like a valid email address." };
    if (!KINDS[kind]) return { ok: false, reason: "kind", msg: "Choose an account type." };

    var key = loginKey(p);

    // 1) If this inbox is ALREADY in use and the NEW login carries NO alias,
    //    force a +alias so each account stays distinct on the shared inbox.
    //    (Checked first: a bare second account on a used inbox is always
    //    resolved by adding a +alias, whether or not it collides exactly.)
    var inboxInUse = existing.some(function (a) { return a.canonical === p.canonical; });
    if (inboxInUse && !p.alias) {
      return {
        ok: false,
        reason: "needs-alias",
        msg: "You already have an account on " + p.canonical + ". Use a +alias (e.g. " + suggestAlias(p, existing) + ") so each account has its own login while sharing one inbox.",
        suggestion: suggestAlias(p, existing)
      };
    }

    // 2) A login must be UNIQUE — you cannot create two accounts with the
    //    exact same +alias login address.
    for (var i = 0; i < existing.length; i++) {
      if (existing[i].loginKey === key) {
        return { ok: false, reason: "duplicate-login", msg: "An account with this exact email already exists. Add a different +alias (e.g. " + suggestAlias(p, existing) + ") to keep them separate." };
      }
    }

    return {
      ok: true,
      value: {
        id: HC.util.uid(),
        email: key,
        loginKey: key,
        canonical: p.canonical,
        alias: p.alias || "",
        kind: kind,
        name: name,
        provider: p.provider || null,
        createdAt: Date.now()
      }
    };
  }

  // Suggest a sensible alias for a new account on an inbox already in use.
  function suggestAlias(p, existing) {
    var prefer = ["camps", "camps2", "parent", "venue", "team", "alt"];
    for (var i = 0; i < prefer.length; i++) {
      var candidate = p.localBase + "+" + prefer[i] + "@" + p.domain;
      var taken = existing.some(function (a) { return a.loginKey === candidate; });
      if (!taken) return candidate;
    }
    return p.localBase + "+camps" + (existing.length + 1) + "@" + p.domain;
  }

  function addAccount(input) {
    var v = validateAccount(input);
    if (!v.ok) return v;
    var state = readAll();
    state.accounts.push(v.value);
    writeAll(state);
    return { ok: true, value: v.value };
  }

  function removeAccount(id) {
    var state = readAll();
    var before = state.accounts.length;
    state.accounts = state.accounts.filter(function (a) { return a.id !== id; });
    writeAll(state);
    return before !== state.accounts.length;
  }

  // Group accounts by shared inbox -> [{ canonical, accounts:[...] }].
  function groupByInbox(list) {
    list = Array.isArray(list) ? list : accounts();
    var map = {};
    var order = [];
    for (var i = 0; i < list.length; i++) {
      var c = list[i].canonical;
      if (!map[c]) { map[c] = []; order.push(c); }
      map[c].push(list[i]);
    }
    return order.map(function (c) { return { canonical: c, accounts: map[c] }; });
  }

  /* ===================================================================
     RENDER — sign-up-style UI documenting the alias mechanism, plus a
     working "create another account on this inbox" demo.
     =================================================================== */
  function render(mountEl) {
    try {
      mountEl.innerHTML = "";

      var wrap = HC.util.el("div", { class: "pea-wrap" });
      wrap.appendChild(HC.util.el("h2", null, "Run several HolidayCamp accounts from one inbox"));
      wrap.appendChild(HC.util.el("p", { style: "color:var(--text,#383838);max-width:640px" },
        "Lots of camp providers are also parents, or run more than one camp business. " +
        "You can keep using the <strong>same email inbox</strong> for everything &mdash; just give each " +
        "account its own <strong>+alias login</strong>. All the emails still land in one place, but each " +
        "account has a separate login."));

      // --- documented-at-sign-up explainer ---
      var doc = HC.util.el("div", { class: "pea-doc", style: "background:var(--purple-tint,#F0E8F4);border-radius:16px;padding:16px 18px;margin:14px 0" });
      doc.innerHTML =
        '<div style="font-weight:700;color:var(--purple,#603488);margin-bottom:6px">How +alias logins work</div>' +
        '<p style="margin:0 0 8px;font-size:14px">If your inbox is <code>jess@gmail.com</code>, you can sign up separate accounts as:</p>' +
        '<ul style="margin:0;padding-left:18px;font-size:14px">' +
          '<li><code>jess+camps@gmail.com</code> &mdash; your provider account</li>' +
          '<li><code>jess+parent@gmail.com</code> &mdash; your parent account</li>' +
          '<li><code>jess+forestcamp@gmail.com</code> &mdash; a second camp business</li>' +
        '</ul>' +
        '<p style="margin:8px 0 0;font-size:13px;color:var(--muted,#808080)">Supported by Gmail, Outlook.com, Yahoo Mail, ProtonMail and FastMail.</p>';
      wrap.appendChild(doc);

      // --- create-account form ---
      var form = HC.util.el("div", { class: "pea-form", style: "display:grid;gap:10px;max-width:520px;margin:6px 0 18px" });
      form.innerHTML =
        '<label style="font-weight:700;font-size:13px">Inbox or +alias email' +
        '<input class="pea-email" type="email" placeholder="jess@gmail.com" ' +
          'style="display:block;width:100%;margin-top:4px;padding:9px 11px;border:1.5px solid var(--line,#E6E6E6);border-radius:12px;font-size:14px"></label>' +
        '<label style="font-weight:700;font-size:13px">Account type' +
        '<select class="pea-kind" style="display:block;width:100%;margin-top:4px;padding:9px 11px;border:1.5px solid var(--line,#E6E6E6);border-radius:12px;font-size:14px">' +
          '<option value="provider">Provider account (run camps)</option>' +
          '<option value="parent">Parent account (book camps)</option>' +
        '</select></label>' +
        '<label style="font-weight:700;font-size:13px">Account name (optional)' +
        '<input class="pea-name" type="text" placeholder="Forest Explorers Summer Camp" ' +
          'style="display:block;width:100%;margin-top:4px;padding:9px 11px;border:1.5px solid var(--line,#E6E6E6);border-radius:12px;font-size:14px"></label>' +
        '<button class="hc-btn pea-add" type="button">Create account</button>' +
        '<div class="pea-msg" style="font-size:13px;min-height:18px"></div>';
      wrap.appendChild(form);

      var listHost = HC.util.el("div", { class: "pea-list" });
      wrap.appendChild(listHost);

      mountEl.appendChild(wrap);

      var emailIn = form.querySelector(".pea-email");
      var kindIn = form.querySelector(".pea-kind");
      var nameIn = form.querySelector(".pea-name");
      var msg = form.querySelector(".pea-msg");

      function paintList() {
        var groups = groupByInbox();
        if (!groups.length) {
          listHost.innerHTML = '<p style="color:var(--muted,#808080);font-size:14px">No accounts yet. Create one above to see how aliases keep them separate.</p>';
          return;
        }
        var html = "";
        for (var g = 0; g < groups.length; g++) {
          var grp = groups[g];
          html += '<div style="border:1.5px solid var(--line,#E6E6E6);border-radius:16px;padding:14px 16px;margin-bottom:12px">';
          html += '<div style="font-size:12px;color:var(--muted,#808080)">One inbox</div>';
          html += '<div style="font-weight:700;color:var(--purple,#603488);margin-bottom:8px">' + escapeHtml(grp.canonical) + ' &middot; ' + grp.accounts.length + ' login' + (grp.accounts.length === 1 ? '' : 's') + '</div>';
          for (var a = 0; a < grp.accounts.length; a++) {
            var acc = grp.accounts[a];
            html += '<div style="display:flex;align-items:center;gap:8px;padding:6px 0;border-top:1px solid var(--line,#E6E6E6)">' +
              '<span class="hc-badge-side" style="background:' + (acc.kind === "parent" ? "var(--pink-tint,#FCE8F0)" : "var(--purple-tint,#F0E8F4)") + ';color:' + (acc.kind === "parent" ? "#9a1f5e" : "var(--purple,#603488)") + '">' + escapeHtml((KINDS[acc.kind] || {}).label || acc.kind) + '</span>' +
              '<code style="font-size:13px">' + escapeHtml(acc.loginKey) + '</code>' +
              (acc.name ? '<span style="font-size:12px;color:var(--muted,#808080)">' + escapeHtml(acc.name) + '</span>' : '') +
              '<button class="hc-btn hc-btn-ghost pea-del" data-id="' + escapeAttr(acc.id) + '" style="margin-left:auto;padding:5px 10px;font-size:11px">Remove</button>' +
              '</div>';
          }
          html += '</div>';
        }
        listHost.innerHTML = html;
        var dels = listHost.querySelectorAll(".pea-del");
        for (var d = 0; d < dels.length; d++) {
          dels[d].addEventListener("click", function () {
            removeAccount(this.getAttribute("data-id"));
            paintList();
          });
        }
      }

      form.querySelector(".pea-add").addEventListener("click", function () {
        msg.style.color = "var(--magenta,#F82488)";
        var res = addAccount({ email: emailIn.value, kind: kindIn.value, name: nameIn.value });
        if (!res.ok) {
          msg.textContent = res.msg || "Could not create that account.";
          // Offer a one-click alias suggestion when relevant.
          if (res.suggestion) {
            emailIn.value = res.suggestion;
          }
          return;
        }
        msg.style.color = "#2f7d4f";
        msg.textContent = "Account created: " + res.value.loginKey + " — emails still go to " + res.value.canonical + ".";
        emailIn.value = "";
        nameIn.value = "";
        HC.util.toast("Account added on shared inbox");
        paintList();
      });

      paintList();
    } catch (e) {
      try { mountEl.innerHTML = '<p style="color:var(--muted)">This feature failed to render: ' + escapeHtml(e && e.message) + "</p>"; } catch (e2) { /* noop */ }
    }
  }

  /* ---------- tiny escapers (no app.js dependency) ---------- */
  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function escapeAttr(s) { return escapeHtml(s).replace(/`/g, "&#96;"); }

  /* ===================================================================
     SELF TEST — exercises the alias LOGIC and asserts the acceptance
     criterion across multiple cases.
     =================================================================== */
  function selfTest() {
    var pass = 0, fail = 0, log = [];
    function check(name, fn) {
      try { fn(); pass += 1; log.push("PASS " + name); }
      catch (e) { fail += 1; log.push("FAIL " + name + " — " + (e && e.message ? e.message : e)); }
    }

    // --- email/alias parsing ---
    check("parseEmail splits a bare Gmail address into base/alias", function () {
      var p = parseEmail("Jess@Gmail.com");
      HC.assert(p.ok === true, "should parse");
      HC.assert(p.localBase === "jess", "localBase should lowercase to 'jess', got " + p.localBase);
      HC.assert(p.alias === "", "no alias expected, got '" + p.alias + "'");
      HC.assert(p.canonical === "jess@gmail.com", "canonical should be jess@gmail.com, got " + p.canonical);
      HC.assert(p.provider === "Gmail", "Gmail should be detected, got " + p.provider);
    });

    check("parseEmail extracts the +alias tag", function () {
      var p = parseEmail("jess+camps@gmail.com");
      HC.assert(p.ok === true, "should parse");
      HC.assert(p.alias === "camps", "alias should be 'camps', got " + p.alias);
      HC.assert(p.canonical === "jess@gmail.com", "alias must NOT change the canonical inbox, got " + p.canonical);
    });

    check("parseEmail rejects malformed input (no '@', double '@', empty alias)", function () {
      HC.assert(parseEmail("jessgmail.com").ok === false, "missing @ must fail");
      HC.assert(parseEmail("a@@b.com").ok === false, "double @ must fail");
      HC.assert(parseEmail("jess+@gmail.com").ok === false, "trailing '+' with no alias must fail");
      HC.assert(parseEmail("+camps@gmail.com").ok === false, "no local base must fail");
      HC.assert(parseEmail("").ok === false, "empty must fail");
    });

    check("supportsAlias is true for listed providers and false otherwise", function () {
      HC.assert(supportsAlias("a@gmail.com") === true, "gmail supported");
      HC.assert(supportsAlias("a@outlook.com") === true, "outlook supported");
      HC.assert(supportsAlias("a@protonmail.com") === true, "protonmail supported");
      HC.assert(supportsAlias("a@fastmail.com") === true, "fastmail supported");
      HC.assert(supportsAlias("a@yahoo.co.uk") === true, "yahoo.co.uk supported");
      HC.assert(supportsAlias("a@randomcorp.io") === false, "unknown provider not flagged");
    });

    check("makeAlias builds example+tag@domain and normalises the tag", function () {
      HC.assert(makeAlias("jess@gmail.com", "camps") === "jess+camps@gmail.com", "basic alias build");
      HC.assert(makeAlias("jess@gmail.com", " Forest Camp ") === "jess+forest-camp@gmail.com", "spaces -> dashes + lowercase");
      HC.assert(makeAlias("jess@gmail.com", "+already") === "jess+already@gmail.com", "leading + stripped");
      HC.assert(makeAlias("bad-email", "camps") === null, "invalid base returns null");
    });

    // --- inbox vs login identity (the heart of the feature) ---
    check("sameInbox: all +aliases of one base share the inbox", function () {
      HC.assert(sameInbox("jess+camps@gmail.com", "jess+parent@gmail.com") === true, "two aliases of jess share the inbox");
      HC.assert(sameInbox("jess@gmail.com", "jess+camps@gmail.com") === true, "base + alias share the inbox");
      HC.assert(sameInbox("jess@gmail.com", "amir@gmail.com") === false, "different locals are different inboxes");
    });

    check("sameLogin: +aliases are DISTINCT logins even on one inbox", function () {
      HC.assert(sameLogin("jess+camps@gmail.com", "jess+parent@gmail.com") === false, "different aliases = different logins");
      HC.assert(sameLogin("jess+camps@gmail.com", "JESS+CAMPS@gmail.com") === true, "login key is case-insensitive");
      HC.assert(sameLogin("jess@gmail.com", "jess+camps@gmail.com") === false, "base and alias are different logins");
    });

    // --- ACCEPTANCE: one person, multiple distinct accounts on one inbox ---
    var TEST_KEY = "__selftest_alias__" + HC.util.uid();
    var realKey = STORE_KEY;
    function withIsolatedStore(run) {
      // Redirect the registry's store key to an isolated one for the test,
      // then restore + tidy up afterwards.
      var saved = HC.store.get(realKey, null);
      try {
        STORE_KEY = TEST_KEY;
        HC.store.set(TEST_KEY, { accounts: [] });
        run();
      } finally {
        HC.store.remove(TEST_KEY);
        STORE_KEY = realKey;
        if (saved !== null) HC.store.set(realKey, saved);
      }
    }

    check("ACCEPTANCE: a person holds a provider AND a parent account on one inbox, each with its own login", function () {
      withIsolatedStore(function () {
        var prov = addAccount({ email: "jess+camps@gmail.com", kind: "provider", name: "Forest Explorers" });
        HC.assert(prov.ok === true, "provider alias account should be created");

        var parent = addAccount({ email: "jess+parent@gmail.com", kind: "parent", name: "Jess (mum)" });
        HC.assert(parent.ok === true, "parent alias account should be created");

        var all = accounts();
        HC.assert(all.length === 2, "two distinct accounts expected, got " + all.length);

        // Distinct logins...
        HC.assert(prov.value.loginKey !== parent.value.loginKey, "the two accounts must have DIFFERENT logins");
        HC.assert(sameLogin(prov.value.loginKey, parent.value.loginKey) === false, "logins must not collide");

        // ...but ONE shared inbox.
        HC.assert(sameInbox(prov.value.loginKey, parent.value.loginKey) === true, "both must deliver to the same inbox");
        var groups = groupByInbox(all);
        HC.assert(groups.length === 1, "the two accounts should group under ONE inbox, got " + groups.length);
        HC.assert(groups[0].canonical === "jess@gmail.com", "shared inbox should be jess@gmail.com, got " + groups[0].canonical);
        HC.assert(groups[0].accounts.length === 2, "the shared inbox should hold both accounts");
      });
    });

    check("ACCEPTANCE: a person can run MULTIPLE provider accounts on one inbox via aliases", function () {
      withIsolatedStore(function () {
        var a = addAccount({ email: "jess+forestcamp@gmail.com", kind: "provider", name: "Forest Camp" });
        var b = addAccount({ email: "jess+beachcamp@gmail.com", kind: "provider", name: "Beach Camp" });
        HC.assert(a.ok && b.ok, "both provider accounts should be created");
        HC.assert(a.value.loginKey !== b.value.loginKey, "the two provider logins must differ");
        HC.assert(groupByInbox().length === 1, "both should still share the one inbox");
        HC.assert(accounts().length === 2, "two provider accounts expected");
      });
    });

    check("Exact-duplicate login is rejected (cannot create the same account twice)", function () {
      withIsolatedStore(function () {
        var first = addAccount({ email: "jess+camps@gmail.com", kind: "provider" });
        HC.assert(first.ok === true, "first creation should succeed");
        var dup = addAccount({ email: "JESS+camps@gmail.com", kind: "parent" });
        HC.assert(dup.ok === false, "duplicate login must be rejected");
        HC.assert(dup.reason === "duplicate-login", "reason should be duplicate-login, got " + dup.reason);
        HC.assert(accounts().length === 1, "the duplicate must not be stored");
      });
    });

    check("A SECOND account on an in-use inbox with no alias is forced to add a +alias", function () {
      withIsolatedStore(function () {
        var base = addAccount({ email: "jess@gmail.com", kind: "provider", name: "First" });
        HC.assert(base.ok === true, "bare base email may be used for the FIRST account");

        var second = addAccount({ email: "jess@gmail.com", kind: "parent", name: "Second" });
        HC.assert(second.ok === false, "a second account on the same bare inbox must be blocked");
        HC.assert(second.reason === "needs-alias", "reason should be needs-alias, got " + second.reason);
        HC.assert(typeof second.suggestion === "string" && second.suggestion.indexOf("+") !== -1, "a +alias suggestion should be offered, got " + second.suggestion);
        HC.assert(accounts().length === 1, "the un-aliased second account must not be stored");

        // Following the suggestion succeeds.
        var fixed = addAccount({ email: second.suggestion, kind: "parent", name: "Second" });
        HC.assert(fixed.ok === true, "using the suggested +alias should now succeed");
        HC.assert(accounts().length === 2, "two accounts should now share the inbox");
      });
    });

    check("removeAccount deletes a login without touching the other account on the inbox", function () {
      withIsolatedStore(function () {
        var a = addAccount({ email: "jess+camps@gmail.com", kind: "provider" });
        var b = addAccount({ email: "jess+parent@gmail.com", kind: "parent" });
        HC.assert(accounts().length === 2, "two to start");
        HC.assert(removeAccount(a.value.id) === true, "remove should report success");
        var left = accounts();
        HC.assert(left.length === 1, "one should remain");
        HC.assert(left[0].loginKey === b.value.loginKey, "the OTHER account must be untouched");
      });
    });

    check("Persistence round-trips through HC.store under an isolated key", function () {
      withIsolatedStore(function () {
        addAccount({ email: "jess+camps@gmail.com", kind: "provider", name: "Camp" });
        // Re-read straight from the store to prove it persisted (not just in memory).
        var raw = HC.store.get(STORE_KEY, null);
        HC.assert(raw && Array.isArray(raw.accounts) && raw.accounts.length === 1, "store should hold exactly one account");
        HC.assert(raw.accounts[0].loginKey === "jess+camps@gmail.com", "stored loginKey should match");
      });
      // Confirm the isolated key was cleaned up.
      HC.assert(HC.store.get(TEST_KEY, null) === null, "isolated test key must be removed after the test");
    });

    return { pass: pass, fail: fail, log: log };
  }

  /* ===================================================================
     REGISTER (idempotent + defensive via core).
     =================================================================== */
  HC.registerFeature({
    id: "provider-email-alias-accounts",
    title: "One inbox, multiple accounts (+alias logins)",
    side: "provider",
    icon: "📧",
    summary: "Many camp providers are also parents, or run more than one camp. Use '+alias' email addresses (e.g. jess+camps@gmail.com, jess+parent@gmail.com) so one inbox serves several HolidayCamp accounts — each with its own separate login. Supported by Gmail, Outlook.com, Yahoo, ProtonMail and FastMail.",
    render: render,
    selfTest: selfTest
  });
})();
