/* HolidayCamp feature — parent-booking-confirmation
 *
 * Replicates Happity's "Booking confirmation email + reference number" for
 * HOLIDAY CAMPS (school-age). When a booking is completed the parent gets a
 * confirmation carrying a UNIQUE booking reference, plus a rendered preview of
 * the confirmation email with all the details of the booking.
 *
 * Evidence (Happity support corpus):
 *   - 4805594 "Customer booking confirmations": "When a customer makes a
 *     booking, the system will send them a confirmation email with all the
 *     details of their booking." Email also enables a provider-side RESEND.
 *   - 8255720 "Parents & Carers FAQs - Support with Bookings":
 *       · "Where can I find my booking reference?" → "you will receive a
 *         confirmation email and the reference number will be displayed on
 *         this email."
 *       · cancel / refund: "Their details are on your booking confirmation
 *         email" → so the email must surface the provider's contact/link.
 *   - 4400048 "How to set custom confirmation emails": the confirmation email
 *     "will always include all the basic information about your class - where,
 *     when and what ticket they have purchased, as well as your terms &
 *     conditions and privacy policy", plus an optional personalised message.
 *
 * Framed for school-age camps: "where / when" is pulled from the live planner
 * (HC.data.planner.weeks gives real Summer-2026 WF week dates) and the chosen
 * camp's listed venue/area; "what ticket" is a day / extended-day / week pass.
 * No real email is sent — composeEmail() builds the message as data so the
 * whole thing is testable; persistence is mock via HC.store.
 *
 * Self-contained, defensive, plain browser JS (passes `node --check`).
 */
(function () {
  "use strict";

  if (!window.HC || typeof HC.registerFeature !== "function") return;

  var STORE_KEY = "confirmations";        // array of confirmation records
  var REF_INDEX_KEY = "confirmation_refs"; // map ref -> true, to guarantee uniqueness

  /* ============================================================
     PURE LOGIC (this is what selfTest exercises)
     ============================================================ */

  /* ---- unique booking reference ----
     Happity refs are short, human-readable, and unique. We build a grouped
     code (e.g. "HAP-7K3M-2Q9X") from an unambiguous alphabet (no 0/O/1/I) and
     guarantee uniqueness against an index kept in HC.store, regenerating on the
     astronomically-unlikely collision. */
  var REF_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"; // 32 chars, no 0 O 1 I

  function randomBlock(len) {
    var s = "";
    for (var i = 0; i < len; i++) {
      s += REF_ALPHABET.charAt(Math.floor(Math.random() * REF_ALPHABET.length));
    }
    return s;
  }

  function refIndex() {
    var idx = HC.store.get(REF_INDEX_KEY, {});
    return (idx && typeof idx === "object") ? idx : {};
  }

  function isRefValid(ref) {
    return typeof ref === "string" && /^HAP-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/.test(ref);
  }

  // Generate a reference that is not already present in the store index.
  function generateRef(opts) {
    opts = opts || {};
    var idx = opts.index || refIndex();
    var ref, tries = 0;
    do {
      ref = "HAP-" + randomBlock(4) + "-" + randomBlock(4);
      tries++;
    } while (idx[ref] && tries < 50);
    return ref;
  }

  // Reserve a reference in the persistent index so it can never be re-issued.
  function reserveRef(ref) {
    var idx = refIndex();
    idx[ref] = true;
    HC.store.set(REF_INDEX_KEY, idx);
    return ref;
  }

  /* ---- where / when, from the live planner ---- */
  function weekById(weekId) {
    var weeks = (HC.data && HC.data.planner && HC.data.planner.weeks) || [];
    for (var i = 0; i < weeks.length; i++) {
      if (String(weeks[i].id) === String(weekId)) return weeks[i];
    }
    return weeks[0] || null;
  }

  // "Where" line: the camp's venue + area, defensively.
  function whereLine(provider) {
    if (!provider) return "Venue to be confirmed";
    var bits = [];
    if (provider.venue) bits.push(String(provider.venue));
    if (provider.area && bits.indexOf(String(provider.area)) === -1) bits.push(String(provider.area));
    if (!bits.length && provider.address) bits.push(String(provider.address));
    return bits.length ? bits.join(", ") : "Venue to be confirmed";
  }

  // "When" line: a real Summer-2026 WF week range from the planner.
  function whenLine(weekId) {
    var w = weekById(weekId);
    if (!w) return "Dates to be confirmed";
    var label = w.label || ("Week " + w.id);
    return label + (w.dates ? " · " + w.dates : "");
  }

  // Provider contact block — evidence: parents cancel/refund via the provider,
  // whose details live on the confirmation email.
  function providerContact(provider) {
    var src = (provider && provider.source) || {};
    return {
      name: (provider && provider.name) || "Your camp provider",
      link: src.url || "",
      linkLabel: src.label || (src.url ? "Provider listing" : ""),
      booking: (provider && typeof provider.booking === "string") ? provider.booking : ""
    };
  }

  /* ---- build a confirmation record from a completed booking ---- */
  // `booking` is the minimal completed-booking payload (as produced by checkout
  // or any other flow). We enrich it into a full confirmation with a ref.
  function buildConfirmation(booking, opts) {
    opts = opts || {};
    booking = booking || {};
    var providers = (HC.data && HC.data.providers) || [];
    var provider = booking.provider ||
      providers.filter(function (p) { return p.id === booking.providerId; })[0] ||
      null;

    // Reference: honour a pre-issued one if (and only if) it is valid + unused,
    // otherwise mint a fresh unique one.
    var idx = refIndex();
    var ref = (isRefValid(booking.ref) && !idx[booking.ref]) ? booking.ref : generateRef({ index: idx });

    var contact = providerContact(provider);
    var children = Array.isArray(booking.children) ? booking.children : [];

    var rec = {
      ref: ref,
      providerId: booking.providerId || (provider && provider.id) || "",
      providerName: (provider && provider.name) || booking.providerName || "Your camp",
      where: whereLine(provider),
      when: whenLine(booking.weekId),
      weekId: booking.weekId != null ? booking.weekId : null,
      ticketLabel: booking.ticketLabel || "Camp place",
      qty: Math.max(1, parseInt(booking.qty, 10) || 1),
      total: Number(booking.total) || 0,
      parentName: String(booking.parentName || "").trim(),
      parentEmail: String(booking.parentEmail || "").trim(),
      children: children.map(function (c) {
        return { name: String((c && c.name) || "").trim(), age: (c && c.age != null) ? c.age : null };
      }),
      provider: {
        name: contact.name,
        link: contact.link,
        linkLabel: contact.linkLabel,
        booking: contact.booking
      },
      personalMessage: String(opts.personalMessage || booking.personalMessage || "").trim(),
      bookedAt: booking.bookedAt || new Date().toISOString(),
      status: "confirmed"
    };
    return rec;
  }

  /* ---- compose the confirmation EMAIL (as data, then text/html) ----
     Mirrors evidence 4400048: where, when, what ticket, T&Cs/privacy line,
     plus the optional personalised message and the all-important reference. */
  var TERMS_LINE =
    "Cancellations, reschedules and refunds are handled by the camp provider " +
    "directly, in line with their terms & conditions and privacy policy. Their " +
    "contact details are below.";

  function composeEmail(rec) {
    rec = rec || {};
    var to = rec.parentEmail || "";
    var subject = "Booking confirmed: " + (rec.providerName || "your camp") +
      " — " + (rec.ref || "");

    var lines = [];
    lines.push("Hi " + (rec.parentName || "there") + ",");
    lines.push("");
    lines.push("You're booked in! Here are the details of your holiday-camp booking.");
    lines.push("");
    lines.push("Booking reference: " + (rec.ref || ""));
    lines.push("");
    lines.push("What:  " + (rec.ticketLabel || "Camp place") + " × " + (rec.qty || 1) +
      " — " + (rec.providerName || ""));
    lines.push("Where: " + (rec.where || ""));
    lines.push("When:  " + (rec.when || ""));
    if (rec.children && rec.children.length) {
      lines.push("Who:   " + rec.children.map(function (c) {
        return c.name + (c.age != null && c.age !== "" ? " (age " + c.age + ")" : "");
      }).join(", "));
    }
    lines.push("Paid:  " + (HC.util && HC.util.money ? HC.util.money(rec.total) : ("£" + rec.total)));
    lines.push("");
    if (rec.personalMessage) {
      lines.push(rec.personalMessage);
      lines.push("");
    }
    lines.push(TERMS_LINE);
    var contactBits = [];
    if (rec.provider && rec.provider.name) contactBits.push("Provider: " + rec.provider.name);
    if (rec.provider && rec.provider.booking) contactBits.push(rec.provider.booking);
    if (rec.provider && rec.provider.link) {
      contactBits.push((rec.provider.linkLabel || "Listing") + ": " + rec.provider.link);
    }
    if (contactBits.length) {
      lines.push("");
      lines.push(contactBits.join("\n"));
    }
    lines.push("");
    lines.push("Quote your booking reference " + (rec.ref || "") + " in any message about this booking.");

    var body = lines.join("\n");
    return { to: to, subject: subject, body: body, ref: rec.ref };
  }

  /* ---- persistence (mock, via HC.store) ---- */
  function getConfirmations() {
    var list = HC.store.get(STORE_KEY, []);
    return Array.isArray(list) ? list : [];
  }

  function saveConfirmation(rec) {
    var list = getConfirmations();
    list.push(rec);
    HC.store.set(STORE_KEY, list);
    reserveRef(rec.ref);
    return rec;
  }

  // Look up a stored confirmation by its reference (powers "Where can I find my
  // booking reference?" / resend flows). Case-insensitive.
  function findByRef(ref) {
    var needle = String(ref || "").trim().toUpperCase();
    if (!needle) return null;
    var list = getConfirmations();
    for (var i = 0; i < list.length; i++) {
      if (String(list[i].ref).toUpperCase() === needle) return list[i];
    }
    return null;
  }

  // Look up all confirmations for an email (a parent's bookings).
  function findByEmail(email) {
    var needle = String(email || "").trim().toLowerCase();
    if (!needle) return [];
    return getConfirmations().filter(function (r) {
      return String(r.parentEmail).toLowerCase() === needle;
    });
  }

  /* ---- the one call a completed booking makes ---- */
  // Confirms a booking: builds the record, persists it, composes the email,
  // and returns everything the UI needs. This is the canonical path the
  // acceptance test asserts.
  function confirmBooking(booking, opts) {
    opts = opts || {};
    var rec = buildConfirmation(booking, opts);
    if (opts.persist !== false) saveConfirmation(rec);
    else reserveRef(rec.ref); // still reserve so two non-persisted refs differ
    var email = composeEmail(rec);
    return { ok: true, confirmation: rec, email: email, ref: rec.ref };
  }

  // "Resend" simply re-composes the email for a stored ref (evidence 4805594).
  function resend(ref) {
    var rec = findByRef(ref);
    if (!rec) return { ok: false, reason: "No booking found for that reference." };
    return { ok: true, email: composeEmail(rec), confirmation: rec };
  }

  /* ============================================================
     UI — complete a demo booking, see the confirmation + email
     ============================================================ */

  function bookableProviders() {
    var providers = (HC.data && HC.data.providers) || [];
    // Prefer paid, non-HAF camps for a realistic priced confirmation, but fall
    // back to anything so the demo always has something to show.
    var paid = providers.filter(function (p) {
      var free = (p.funding || []).some(function (f) { return /free|haf/i.test(String(f)); });
      return !free;
    });
    return paid.length ? paid : providers;
  }

  function priceForProvider(provider) {
    var byId = (HC.data && HC.data.planner && HC.data.planner.byId) || {};
    var pe = (provider && byId[provider.id]) || {};
    if (pe.price && typeof pe.price === "object") {
      if (pe.price.day) return { label: "Single day", amount: pe.price.day };
      if (pe.price.week) return { label: "Full week", amount: pe.price.week };
      if (pe.price.halfDay) return { label: "Half day", amount: pe.price.halfDay };
    }
    if (provider && typeof provider.price === "string") {
      var m = provider.price.replace(/GBP\s?/gi, "£").match(/£\s?(\d+(?:\.\d{1,2})?)/);
      if (m) return { label: "Day place", amount: parseFloat(m[1]) };
    }
    return { label: "Day place", amount: 35 };
  }

  function render(mountEl) {
    try {
      injectStyles();
      var providers = bookableProviders();
      if (!providers.length) {
        mountEl.innerHTML = '<p class="hcbc-muted">No camps in the live data right now.</p>';
        return;
      }

      var state = {
        provider: providers[0],
        weekId: ((HC.data.planner.weeks || [])[0] || {}).id || 1,
        parentName: "Sam Carer",
        parentEmail: "sam@example.com",
        childName: "Ada",
        childAge: 8
      };

      var root = HC.util.el("div", { class: "hcbc" });
      mountEl.innerHTML = "";
      mountEl.appendChild(root);
      drawForm();

      function esc(s) {
        return String(s == null ? "" : s)
          .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
      }

      function drawForm() {
        var weeks = (HC.data.planner.weeks) || [];
        var provOpts = providers.map(function (p) {
          return '<option value="' + esc(p.id) + '"' + (p.id === state.provider.id ? " selected" : "") + ">" + esc(p.name) + "</option>";
        }).join("");
        var weekOpts = weeks.map(function (w) {
          return '<option value="' + esc(w.id) + '"' + (String(w.id) === String(state.weekId) ? " selected" : "") + ">" +
            esc((w.label || ("Week " + w.id)) + (w.dates ? " · " + w.dates : "")) + "</option>";
        }).join("");

        root.innerHTML =
          '<p class="hcbc-intro">Complete a booking and we\'ll show the confirmation — ' +
            'with a <b>unique booking reference</b> and a preview of the email that would be sent. ' +
            'Then look a reference up, following the same marketplace pattern\'s "Where can I find my booking reference?".</p>' +
          '<div class="hcbc-grid">' +
            '<label class="hcbc-field"><span>Camp</span><select id="hcbc-prov">' + provOpts + "</select></label>" +
            '<label class="hcbc-field"><span>Week</span><select id="hcbc-week">' + weekOpts + "</select></label>" +
            '<label class="hcbc-field"><span>Parent / carer</span><input id="hcbc-pn" value="' + esc(state.parentName) + '"></label>' +
            '<label class="hcbc-field"><span>Email</span><input id="hcbc-pe" type="email" value="' + esc(state.parentEmail) + '"></label>' +
            '<label class="hcbc-field"><span>Child</span><input id="hcbc-cn" value="' + esc(state.childName) + '"></label>' +
            '<label class="hcbc-field hcbc-narrow"><span>Age</span><input id="hcbc-ca" type="number" min="0" max="18" value="' + esc(state.childAge) + '"></label>' +
          "</div>" +
          '<button class="hcbc-btn" id="hcbc-go" type="button">Complete booking →</button>' +
          '<div class="hcbc-lookup">' +
            '<span>Already booked?</span>' +
            '<input id="hcbc-find" placeholder="HAP-XXXX-XXXX">' +
            '<button class="hcbc-btn-ghost" id="hcbc-findbtn" type="button">Find my booking</button>' +
          "</div>" +
          '<div id="hcbc-out"></div>';

        bind("#hcbc-prov", "change", function (e) {
          state.provider = providers.filter(function (p) { return p.id === e.target.value; })[0] || state.provider;
        });
        bind("#hcbc-week", "change", function (e) { state.weekId = e.target.value; });
        bind("#hcbc-pn", "input", function (e) { state.parentName = e.target.value; });
        bind("#hcbc-pe", "input", function (e) { state.parentEmail = e.target.value; });
        bind("#hcbc-cn", "input", function (e) { state.childName = e.target.value; });
        bind("#hcbc-ca", "input", function (e) { state.childAge = e.target.value; });
        bind("#hcbc-go", "click", onComplete);
        bind("#hcbc-findbtn", "click", onFind);
      }

      function bind(sel, evt, fn) {
        var n = root.querySelector(sel);
        if (n) n.addEventListener(evt, fn);
      }

      function onComplete() {
        var price = priceForProvider(state.provider);
        var booking = {
          providerId: state.provider.id,
          weekId: state.weekId,
          ticketLabel: price.label,
          qty: 1,
          total: price.amount,
          parentName: state.parentName,
          parentEmail: state.parentEmail,
          children: [{ name: state.childName, age: state.childAge }]
        };
        var res = confirmBooking(booking, {
          personalMessage: "Please send your child in comfortable clothes and bring a named water bottle and a packed lunch."
        });
        showConfirmation(res.confirmation, res.email, "Booking complete");
        if (HC.util && HC.util.toast) HC.util.toast("Booked — ref " + res.ref);
      }

      function onFind() {
        var input = root.querySelector("#hcbc-find");
        var ref = input ? input.value : "";
        var res = resend(ref);
        var out = root.querySelector("#hcbc-out");
        if (!res.ok) {
          out.innerHTML = '<div class="hcbc-err">' + esc(res.reason) + '</div>';
          return;
        }
        showConfirmation(res.confirmation, res.email, "Booking found — confirmation re-sent");
      }

      function showConfirmation(rec, email, heading) {
        var out = root.querySelector("#hcbc-out");
        var kids = (rec.children || []).map(function (c) {
          return esc(c.name) + (c.age != null && c.age !== "" ? " (age " + esc(c.age) + ")" : "");
        }).join(", ");
        var contactRows = "";
        if (rec.provider && rec.provider.booking) contactRows += "<div>" + esc(rec.provider.booking) + "</div>";
        if (rec.provider && rec.provider.link) {
          contactRows += '<div><a href="' + esc(rec.provider.link) + '" target="_blank" rel="noopener">' +
            esc(rec.provider.linkLabel || "Provider listing") + "</a></div>";
        }

        out.innerHTML =
          '<div class="hcbc-card">' +
            '<div class="hcbc-tick">✓</div>' +
            "<h3 class=\"hcbc-h\">" + esc(heading) + "</h3>" +
            '<div class="hcbc-ref">Booking reference<b>' + esc(rec.ref) + "</b></div>" +
            '<table class="hcbc-tbl">' +
              row("What", esc(rec.ticketLabel) + " × " + rec.qty + " — " + esc(rec.providerName)) +
              row("Where", esc(rec.where)) +
              row("When", esc(rec.when)) +
              (kids ? row("Who", kids) : "") +
              row("Paid", esc(HC.util.money ? HC.util.money(rec.total) : ("£" + rec.total))) +
            "</table>" +
            '<div class="hcbc-emailwrap">' +
              '<div class="hcbc-emailhd">📧 Confirmation email preview</div>' +
              '<div class="hcbc-emailmeta"><b>To:</b> ' + esc(email.to) + "<br><b>Subject:</b> " + esc(email.subject) + "</div>" +
              '<pre class="hcbc-emailbody">' + esc(email.body) + "</pre>" +
            "</div>" +
            (contactRows ? '<div class="hcbc-contact"><b>Provider contact (for changes / refunds):</b>' + contactRows + "</div>" : "") +
          "</div>";
      }

      function row(k, v) {
        return '<tr><th>' + k + "</th><td>" + v + "</td></tr>";
      }
    } catch (e) {
      mountEl.innerHTML = '<p style="color:#9a1f5e">Confirmation view failed to render: ' +
        String(e && e.message ? e.message : e) + "</p>";
    }
  }

  function injectStyles() {
    if (document.getElementById("hcbc-styles")) return;
    var css =
      ".hcbc{font-family:'Nunito Sans',system-ui,sans-serif;color:var(--text,#383838)}" +
      ".hcbc-intro{font-size:13.5px;margin:0 0 14px}" +
      ".hcbc-muted{color:var(--muted,#808080)}" +
      ".hcbc-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin:0 0 12px}" +
      ".hcbc-field{display:flex;flex-direction:column;gap:4px;font-size:12.5px;font-weight:700;color:var(--purple,#603488)}" +
      ".hcbc-field input,.hcbc-field select{font:inherit;font-weight:400;color:var(--text,#383838);padding:9px 11px;border:1.5px solid var(--line,#E6E6E6);border-radius:12px}" +
      ".hcbc-narrow{max-width:120px}" +
      ".hcbc-btn{border:none;cursor:pointer;font-family:'Quicksand',system-ui,sans-serif;font-weight:700;background:var(--yellow,#FCD400);color:var(--ink,#1A1A1A);padding:11px 18px;border-radius:999px;font-size:13.5px}" +
      ".hcbc-btn:hover{background:#ffdf2e}" +
      ".hcbc-btn-ghost{border:1.5px solid var(--purple-tint,#F0E8F4);cursor:pointer;font-family:'Quicksand',system-ui,sans-serif;font-weight:700;background:#fff;color:var(--purple,#603488);padding:9px 14px;border-radius:999px;font-size:12.5px}" +
      ".hcbc-lookup{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:16px 0 0;padding:12px;background:var(--purple-tint,#F0E8F4);border-radius:14px;font-size:12.5px;font-weight:700;color:var(--purple,#603488)}" +
      ".hcbc-lookup input{font:inherit;font-weight:400;color:var(--text,#383838);padding:8px 11px;border:1.5px solid var(--line,#E6E6E6);border-radius:10px;letter-spacing:1px;text-transform:uppercase;flex:1;min-width:150px}" +
      ".hcbc-err{color:#9a1f5e;font-size:13px;margin-top:12px;font-weight:700}" +
      ".hcbc-card{margin-top:16px;border:1.5px solid var(--line,#E6E6E6);border-radius:18px;padding:18px;background:#fff;text-align:center}" +
      ".hcbc-tick{width:48px;height:48px;border-radius:50%;background:#2f7d4f;color:#fff;font-size:26px;display:grid;place-items:center;margin:0 auto 8px}" +
      ".hcbc-h{font-family:'Quicksand',system-ui,sans-serif;color:var(--purple,#603488);font-size:18px;margin:0 0 10px}" +
      ".hcbc-ref{display:inline-flex;flex-direction:column;gap:2px;background:var(--pink-tint,#FCE8F0);border:1.5px dashed var(--magenta,#F82488);border-radius:12px;padding:8px 18px;margin:0 0 14px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;color:var(--magenta,#F82488)}" +
      ".hcbc-ref b{font-family:'Quicksand',system-ui,sans-serif;font-size:22px;letter-spacing:2px;color:var(--purple,#603488)}" +
      ".hcbc-tbl{width:100%;border-collapse:collapse;text-align:left;font-size:13.5px;margin:0 0 14px}" +
      ".hcbc-tbl th{width:64px;color:var(--magenta,#F82488);font-family:'Quicksand',system-ui,sans-serif;font-size:11px;text-transform:uppercase;letter-spacing:.4px;vertical-align:top;padding:5px 0}" +
      ".hcbc-tbl td{padding:5px 0 5px 8px;color:var(--text,#383838)}" +
      ".hcbc-emailwrap{text-align:left;border:1px solid var(--line,#E6E6E6);border-radius:14px;overflow:hidden;margin:0 0 12px}" +
      ".hcbc-emailhd{background:var(--purple-tint,#F0E8F4);color:var(--purple,#603488);font-family:'Quicksand',system-ui,sans-serif;font-weight:700;font-size:12.5px;padding:9px 13px}" +
      ".hcbc-emailmeta{padding:10px 13px;font-size:12px;color:var(--muted,#808080);border-bottom:1px solid var(--line,#E6E6E6)}" +
      ".hcbc-emailbody{margin:0;padding:13px;font-family:'Nunito Sans',ui-monospace,monospace;font-size:12.5px;line-height:1.55;color:var(--text,#383838);white-space:pre-wrap;word-break:break-word}" +
      ".hcbc-contact{text-align:left;font-size:12.5px;color:var(--text,#383838);background:#FFF8E1;border-radius:12px;padding:10px 13px}" +
      ".hcbc-contact a{color:var(--purple,#603488)}" +
      "@media(max-width:520px){.hcbc-grid{grid-template-columns:1fr}}";
    var s = HC.util.el("style", { id: "hcbc-styles" }, css);
    document.head.appendChild(s);
  }

  /* ============================================================
     selfTest — exercises the LOGIC and asserts the acceptance
     criterion: a completed booking shows a confirmation with a
     UNIQUE booking reference.
     ============================================================ */
  function selfTest() {
    var pass = 0, fail = 0, log = [];
    function check(label, fn) {
      try { fn(); pass++; log.push("✓ " + label); }
      catch (e) { fail++; log.push("✗ " + label + " — " + (e && e.message ? e.message : String(e))); }
    }

    var providers = (HC.data && HC.data.providers) || [];
    var sample = bookableProviders()[0] || providers[0] || { id: "__demo__", name: "Demo Camp" };

    var baseBooking = {
      providerId: sample.id,
      weekId: ((HC.data.planner.weeks || [])[0] || { id: 1 }).id,
      ticketLabel: "Single day",
      qty: 1,
      total: 36,
      parentName: "Sam Carer",
      parentEmail: "sam@example.com",
      children: [{ name: "Ada", age: 8 }]
    };

    check("Reference format is HAP-XXXX-XXXX with an unambiguous alphabet", function () {
      var ref = generateRef();
      HC.assert(isRefValid(ref), "ref did not match expected format: " + ref);
      HC.assert(!/[01OI]/.test(ref.replace(/^HAP-/, "")), "ref must avoid 0/O/1/I, got " + ref);
    });

    // === ACCEPTANCE CRITERION ===
    check("ACCEPTANCE: a completed booking shows a confirmation with a unique booking reference", function () {
      var res = confirmBooking(baseBooking, { persist: false });
      HC.assert(res.ok, "confirmation should succeed");
      HC.assert(res.confirmation && isRefValid(res.confirmation.ref),
        "confirmation must carry a valid booking reference, got " + (res.confirmation && res.confirmation.ref));
      HC.assert(res.email && res.email.ref === res.confirmation.ref,
        "the confirmation email must display the same reference");
      HC.assert(res.email.body.indexOf(res.confirmation.ref) !== -1,
        "the reference must literally appear in the email body");
      HC.assert(res.email.subject.indexOf(res.confirmation.ref) !== -1,
        "the reference should also appear in the subject");
    });

    check("ACCEPTANCE: references are unique across many bookings", function () {
      var seen = {};
      for (var i = 0; i < 200; i++) {
        var r = confirmBooking(baseBooking, { persist: false }).ref;
        HC.assert(isRefValid(r), "generated an invalid ref: " + r);
        HC.assert(!seen[r], "duplicate reference issued: " + r);
        seen[r] = true;
      }
    });

    check("Persisted confirmation is retrievable by its reference", function () {
      var before = getConfirmations().length;
      var res = confirmBooking(baseBooking); // persists
      HC.assert(getConfirmations().length === before + 1, "confirmation must be persisted via HC.store");
      var found = findByRef(res.ref);
      HC.assert(found && found.ref === res.ref, "should find the booking by its exact ref");
      var foundLower = findByRef(res.ref.toLowerCase());
      HC.assert(foundLower && foundLower.ref === res.ref, "ref lookup should be case-insensitive");
      HC.assert(findByRef("HAP-ZZZZ-ZZZZ") === null, "unknown ref should return null");
    });

    check("A reserved reference is never re-issued (uniqueness across sessions)", function () {
      var res = confirmBooking(baseBooking); // persists + reserves
      var idx = refIndex();
      HC.assert(idx[res.ref] === true, "issued ref must be recorded in the persistent index");
      // generateRef must avoid the reserved ref when handed the live index
      for (var i = 0; i < 30; i++) {
        HC.assert(generateRef() !== res.ref, "generateRef re-issued a reserved ref");
      }
    });

    check("Confirmation email includes where / when / what ticket (evidence 4400048)", function () {
      var res = confirmBooking(baseBooking, { persist: false });
      var b = res.email.body;
      HC.assert(/What:/.test(b) && b.indexOf(res.confirmation.ticketLabel) !== -1, "email must state the ticket");
      HC.assert(/Where:/.test(b), "email must state where");
      HC.assert(/When:/.test(b), "email must state when");
      HC.assert(b.indexOf(TERMS_LINE) !== -1, "email must carry the T&Cs / privacy line");
    });

    check("When line resolves to a real planner week range when weeks exist", function () {
      var weeks = (HC.data.planner.weeks) || [];
      if (!weeks.length) { log.push("  (no planner weeks in data — skipped)"); return; }
      var line = whenLine(weeks[0].id);
      HC.assert(line.indexOf(weeks[0].label) !== -1, "when line should include the week label");
      if (weeks[0].dates) HC.assert(line.indexOf(weeks[0].dates) !== -1, "when line should include the real dates");
    });

    check("Where line uses the camp's live venue / area", function () {
      if (!sample || sample.id === "__demo__") { log.push("  (no live provider — skipped)"); return; }
      var res = confirmBooking({ providerId: sample.id, weekId: baseBooking.weekId, parentEmail: "a@b.com" }, { persist: false });
      var expected = whereLine(sample);
      HC.assert(res.confirmation.where === expected, "where line should match the provider's venue/area");
      HC.assert(res.confirmation.where !== "Venue to be confirmed" || !(sample.venue || sample.area || sample.address),
        "a provider with a venue should not fall back to placeholder");
    });

    check("Provider contact (for cancel/refund) is surfaced on the confirmation (evidence 8255720)", function () {
      if (!sample || sample.id === "__demo__") { log.push("  (no live provider — skipped)"); return; }
      var res = confirmBooking({ providerId: sample.id, parentEmail: "a@b.com" }, { persist: false });
      HC.assert(res.confirmation.provider && res.confirmation.provider.name, "provider name must be present");
      // At least one contact channel should be present for a real provider.
      var c = res.confirmation.provider;
      HC.assert(!!(c.link || c.booking), "a contact channel (link or booking note) should be present");
    });

    check("Resend re-composes the email for a stored reference (evidence 4805594)", function () {
      var res = confirmBooking(baseBooking); // persisted
      var again = resend(res.ref);
      HC.assert(again.ok, "resend should succeed for a known ref");
      HC.assert(again.email.ref === res.ref, "resent email must carry the same ref");
      var miss = resend("HAP-ZZZZ-ZZZZ");
      HC.assert(!miss.ok, "resend should fail for an unknown ref");
    });

    check("Personalised message is included when provided (evidence 4400048)", function () {
      var msg = "Bring a named water bottle and a packed lunch.";
      var res = confirmBooking(baseBooking, { persist: false, personalMessage: msg });
      HC.assert(res.email.body.indexOf(msg) !== -1, "custom message must appear in the email body");
    });

    check("findByEmail returns a parent's confirmations", function () {
      var email = "lookup_" + Date.now() + "@example.com";
      confirmBooking({ providerId: sample.id, parentEmail: email, weekId: baseBooking.weekId });
      confirmBooking({ providerId: sample.id, parentEmail: email, weekId: baseBooking.weekId });
      var list = findByEmail(email);
      HC.assert(list.length === 2, "expected 2 confirmations for the email, got " + list.length);
      HC.assert(list[0].ref !== list[1].ref, "the two bookings must have different references");
    });

    return { pass: pass, fail: fail, log: log };
  }

  /* ---------------- register ---------------- */
  HC.registerFeature({
    id: "parent-booking-confirmation",
    title: "Booking confirmation & reference",
    side: "parent",
    icon: "📧",
    summary: "Every completed booking gets an instant confirmation with a unique booking reference (HAP-XXXX-XXXX) and a preview of the email — where, when, which ticket, plus the provider's contact details for changes or refunds. Look a reference up any time.",
    render: render,
    selfTest: selfTest
  });
})();
