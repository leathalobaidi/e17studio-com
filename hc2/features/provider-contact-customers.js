/* HolidayCamp feature — provider-contact-customers
 *
 * Contact / email the customers of a class, from the provider dashboard.
 * (PROVIDER side)
 *
 * Replicates Happity's "How do I contact my customers?" (support article
 * 4589730). Evidence, verbatim:
 *   - "There is a 'Contact Attendees' button at the top of every register -
 *      this will give you all the phone numbers and email addresses for
 *      customers attending a particular class on a specific day."
 *   - "If you need to contact everyone that is attending a specific class over
 *      the whole term ... you can retrieve the email addresses for all of your
 *      customers by downloading the 'Sales CSV' for this class."
 *   - "If your customers have booked in for multiple classes, then there will
 *      be duplicates in this list. To de-duplicate this list ... =UNIQUE(A:A)"
 *   - "You can now ... contact all of your affected customers via email
 *      (remember to use BCC!)."
 *
 * Framed for SCHOOL-AGE HOLIDAY CAMPS: a camp provider picks one of their
 * camps, chooses scope — a SINGLE DAY/register (e.g. "Mon 28 Jul · AM") or the
 * WHOLE WEEK/series — and the dashboard gathers every booked customer's email
 * and phone for that scope. The provider writes one message; the tool builds a
 * BCC blast (no parent sees another parent's address), de-duplicates carers who
 * booked more than one day or more than one child, and "sends" it into a mock
 * message log. It also exports the same recipient list as a Sales-style CSV.
 *
 * ACCEPTANCE CRITERION (exercised by selfTest):
 *   Provider can message customers of a class from the dashboard.
 *
 * No real email is sent: the "send" writes to a mock log in HC.store. Nothing
 * here imports/exports; it calls HC.registerFeature at top level and is
 * defensive — a failure never throws at registration time.
 */
(function () {
  "use strict";

  if (typeof window === "undefined" || !window.HC || typeof window.HC.registerFeature !== "function") {
    if (typeof console !== "undefined" && console.warn) {
      console.warn("[HC] provider-contact-customers: HC core not found; skipping registration.");
    }
    return;
  }

  var HC = window.HC;

  var STORE_KEY = "provider_contact_customers_log";   // selfTest + shared send log
  var DEMO_KEY = "provider_contact_customers_demo";    // UI demo scratch state

  /* ---------------- tiny helpers ---------------- */
  function nowIso() { try { return new Date().toISOString(); } catch (e) { return "" + Date.now(); } }
  function safeUid() { try { return HC.util.uid(); } catch (e) { return "id_" + Math.random().toString(36).slice(2); } }
  function str(v) { return v === null || v === undefined ? "" : String(v); }
  function trimmed(v) { return str(v).trim(); }
  function esc(s) {
    return str(s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function isEmail(s) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed(s)); }
  function lc(s) { return trimmed(s).toLowerCase(); }

  /* ================================================================
   * Data model (mock, HC.store under one namespaced key):
   *
   *   log = {
   *     bookings: { <providerId>: [ booking, ... ] },   // who is on each class
   *     messages: [ { id, providerId, campId, scope, dateLabel, subject, body,
   *                   channel:'email'|'sms', bcc:[email],
   *                   recipients:[{name,email,phone,childName,dateLabel}],
   *                   recipientCount, skipped:[{reason,...}], sentAt } ]
   *   }
   *
   * A "booking" is one child's place on one day of one camp:
   *   { id, providerId, campId, campName, dateLabel, childName, childYear,
   *     parentName, parentEmail, parentPhone, consentMarketing:Boolean }
   *
   * The MESSAGES log is the heart of the feature — each entry is a message the
   * provider sent to the customers of a class. selfTest asserts against it.
   * ================================================================ */

  function loadLog() { return normalise(HC.store.get(STORE_KEY, null)); }
  function saveLog(l) { try { HC.store.set(STORE_KEY, l); return true; } catch (e) { return false; } }
  function loadDemo() { return normalise(HC.store.get(DEMO_KEY, null)); }
  function saveDemo(l) { try { HC.store.set(DEMO_KEY, l); return true; } catch (e) { return false; } }

  function normalise(l) {
    if (!l || typeof l !== "object") l = {};
    if (!l.bookings || typeof l.bookings !== "object") l.bookings = {};
    if (!Array.isArray(l.messages)) l.messages = [];
    return l;
  }

  /* ---------------- booking roster helpers ---------------- */
  function setBookings(log, providerId, list) {
    log.bookings[str(providerId)] = Array.isArray(list) ? list.slice() : [];
    return log;
  }
  function addBooking(log, providerId, booking) {
    var pid = str(providerId);
    if (!Array.isArray(log.bookings[pid])) log.bookings[pid] = [];
    var b = booking || {};
    if (!b.id) b.id = safeUid();
    log.bookings[pid].push(b);
    return b;
  }
  function bookingsFor(log, providerId) {
    var pid = str(providerId);
    return Array.isArray(log.bookings[pid]) ? log.bookings[pid] : [];
  }

  /* ---------------- the core selection: customers of a class ----------------
   *
   * Gather the customers attending a class, scoped to either:
   *   - a single day/register: scope='day'  + dateLabel
   *   - the whole week/series: scope='series'
   *
   * Returns the matched bookings (pre de-dupe). campId required; an unknown
   * camp simply yields an empty list (defensive, never throws).
   */
  function attendeesFor(log, providerId, campId, scope, dateLabel) {
    var cid = str(campId);
    var sc = (scope === "day") ? "day" : "series";
    var dl = trimmed(dateLabel);
    return bookingsFor(log, providerId).filter(function (b) {
      if (str(b.campId) !== cid) return false;
      if (sc === "day") return trimmed(b.dateLabel) === dl;
      return true; // whole series
    });
  }

  /* ---------------- de-duplicate the recipient list ----------------
   *
   * Mirrors the evidence's =UNIQUE(A:A) step: one carer who booked multiple
   * days or multiple children should appear ONCE in the email blast. We key on
   * the (lowercased) email where present, else the phone, else the name.
   *
   * Returns { recipients:[{name,email,phone,childName,dateLabel,count}],
   *           skipped:[{reason, ...}] } where skipped collects rows with no
   *   usable contact channel (so the provider knows who they couldn't reach).
   */
  function dedupeRecipients(bookings, channel) {
    var ch = (channel === "sms") ? "sms" : "email";
    var seen = {};
    var recipients = [];
    var skipped = [];
    var listed = Array.isArray(bookings) ? bookings : [];

    for (var i = 0; i < listed.length; i++) {
      var b = listed[i] || {};
      var email = trimmed(b.parentEmail);
      var phone = trimmed(b.parentPhone);
      var name = trimmed(b.parentName);

      // The channel decides the *required* contact field.
      if (ch === "email" && !isEmail(email)) {
        skipped.push({ reason: "no-email", name: name, childName: trimmed(b.childName), phone: phone });
        continue;
      }
      if (ch === "sms" && !phone) {
        skipped.push({ reason: "no-phone", name: name, childName: trimmed(b.childName), email: email });
        continue;
      }

      var key = ch === "email" ? lc(email) : (phone || lc(name));
      if (seen[key]) {
        // Already have this carer — just note the extra booking on their row.
        var existing = seen[key];
        existing.count += 1;
        var dl = trimmed(b.dateLabel);
        if (dl && existing.dateLabels.indexOf(dl) === -1) existing.dateLabels.push(dl);
        var cn = trimmed(b.childName);
        if (cn && existing.childNames.indexOf(cn) === -1) existing.childNames.push(cn);
        continue;
      }

      var rec = {
        name: name,
        email: email,
        phone: phone,
        childNames: trimmed(b.childName) ? [trimmed(b.childName)] : [],
        dateLabels: trimmed(b.dateLabel) ? [trimmed(b.dateLabel)] : [],
        consentMarketing: b.consentMarketing !== false, // default opted-in for transactional camp comms
        count: 1
      };
      seen[key] = rec;
      recipients.push(rec);
    }

    // Flatten the helper arrays into friendly single fields too.
    for (var j = 0; j < recipients.length; j++) {
      var r = recipients[j];
      r.childName = r.childNames.join(", ");
      r.dateLabel = r.dateLabels.join(", ");
    }

    return { recipients: recipients, skipped: skipped };
  }

  /* ---------------- compose the message ---------------- */
  function classLabel(campName, scope, dateLabel) {
    var name = trimmed(campName) || "your holiday camp";
    if (scope === "day") return name + (dateLabel ? " — " + trimmed(dateLabel) : "");
    return name + " (whole week)";
  }

  function composeMessage(campName, scope, dateLabel, subject, body) {
    var label = classLabel(campName, scope, dateLabel);
    var subj = trimmed(subject) || ("A message about " + label);
    var lines = [];
    lines.push("Hello from " + (trimmed(campName) || "your holiday camp") + ",");
    lines.push("");
    lines.push(trimmed(body) || "We're getting in touch about your child's place at " + label + ".");
    lines.push("");
    lines.push("Re: " + label);
    return { subject: subj, body: lines.join("\n") };
  }

  /* ---------------- THE core action: message the class's customers ----------------
   *
   * From the dashboard, the provider picks camp + scope (+ day), writes a
   * subject/body, and sends. We:
   *   - resolve the attendees of that class
   *   - de-duplicate carers (UNIQUE), build the BCC list (one address each)
   *   - compose the message
   *   - "send" it into the mock message log
   *
   * Returns { ok, message|null, recipientCount, skipped:[...], error|null }.
   * Never throws.
   */
  function messageClassCustomers(log, providerId, opts) {
    try {
      var pid = str(providerId);
      if (!pid) return fail("providerId required");

      var o = opts || {};
      var campId = str(o.campId);
      if (!campId) return fail("campId required — pick a camp to message");

      var scope = (o.scope === "day") ? "day" : "series";
      var dateLabel = trimmed(o.dateLabel);
      if (scope === "day" && !dateLabel) return fail("a day/register scope needs a dateLabel");

      var channel = (o.channel === "sms") ? "sms" : "email";

      var attendees = attendeesFor(log, pid, campId, scope, dateLabel);
      if (!attendees.length) {
        return fail("no customers booked on this class" + (scope === "day" ? " for " + dateLabel : ""));
      }

      var dd = dedupeRecipients(attendees, channel);
      if (!dd.recipients.length) {
        return fail("no reachable " + (channel === "sms" ? "phone numbers" : "email addresses") + " for this class");
      }

      var campName = trimmed(o.campName) || trimmed(attendees[0].campName);
      var composed = composeMessage(campName, scope, dateLabel, o.subject, o.body);

      var bcc = [];
      var phones = [];
      for (var i = 0; i < dd.recipients.length; i++) {
        var r = dd.recipients[i];
        if (channel === "email" && r.email) bcc.push(r.email);
        if (channel === "sms" && r.phone) phones.push(r.phone);
      }

      var message = {
        id: safeUid(),
        providerId: pid,
        campId: campId,
        campName: campName,
        scope: scope,
        dateLabel: scope === "day" ? dateLabel : "",
        classLabel: classLabel(campName, scope, dateLabel),
        channel: channel,
        subject: composed.subject,
        body: composed.body,
        bcc: bcc,            // de-duped BCC list (email channel)
        phones: phones,      // de-duped numbers (sms channel)
        recipients: dd.recipients.map(function (r) {
          return {
            name: r.name, email: r.email, phone: r.phone,
            childName: r.childName, dateLabel: r.dateLabel, bookings: r.count
          };
        }),
        recipientCount: dd.recipients.length,
        attendeeCount: attendees.length,
        skipped: dd.skipped,
        sentAt: nowIso()
      };

      log.messages.push(message);

      return {
        ok: true,
        message: message,
        recipientCount: message.recipientCount,
        skipped: dd.skipped,
        error: null
      };
    } catch (e) {
      return fail(e && e.message ? e.message : String(e));
    }
  }

  function fail(error) {
    return { ok: false, message: null, recipientCount: 0, skipped: [], error: error };
  }

  /* ---------------- Sales-style CSV export (the evidence's "Sales CSV") ----------------
   *
   * Build a CSV of every booking for a class, grouped by event date — exactly
   * the raw list the provider would otherwise de-dupe by hand. Defensive
   * quoting so commas/quotes in names don't break columns.
   */
  function csvCell(v) {
    var s = str(v);
    if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  }
  function salesCsv(log, providerId, campId, scope, dateLabel) {
    var rows = attendeesFor(log, providerId, campId, scope, dateLabel);
    var header = ["Date", "Child", "School year", "Parent/Carer", "Email", "Phone"];
    var out = [header.join(",")];
    // Group by date, as the article describes ("grouped by each event date").
    rows.slice().sort(function (a, b) {
      return str(a.dateLabel).localeCompare(str(b.dateLabel));
    }).forEach(function (b) {
      out.push([
        csvCell(b.dateLabel), csvCell(b.childName), csvCell(b.childYear),
        csvCell(b.parentName), csvCell(b.parentEmail), csvCell(b.parentPhone)
      ].join(","));
    });
    return out.join("\n");
  }

  function messagesFor(log, providerId, campId) {
    var pid = str(providerId), cid = campId === undefined ? null : str(campId);
    return log.messages.filter(function (m) {
      if (m.providerId !== pid) return false;
      if (cid !== null && m.campId !== cid) return false;
      return true;
    });
  }

  /* ---------------- a sensible default provider + demo roster from live data ---------------- */
  function defaultProvider() {
    try {
      var ps = HC.data.providers;
      if (ps && ps.length) {
        var p = ps[1] || ps[0]; // skip the council HAF aggregator at [0]
        return {
          id: str(p.id || p.name || "provider-0"),
          name: str(p.name || "Holiday camp")
        };
      }
    } catch (e) { /* ignore */ }
    return { id: "provider-0", name: "Holiday camp" };
  }

  // A small, realistic demo roster: one camp, a Mon and a Tue register, with a
  // carer (Priya) who booked BOTH days and TWO children — the de-dupe case.
  function seedDemoBookings(prov) {
    var camp = { id: "demo-camp", name: prov.name };
    return [
      mk(prov.id, camp, "Mon 27 Jul · AM", "Maya Lewis", "Year 3", "Dee Lewis", "dee.lewis@example.com", "07700 900101"),
      mk(prov.id, camp, "Mon 27 Jul · AM", "Arlo Khan", "Year 1", "Priya Khan", "priya.khan@example.com", "07700 900102"),
      mk(prov.id, camp, "Mon 27 Jul · AM", "Sana Khan", "Year 4", "Priya Khan", "priya.khan@example.com", "07700 900102"),
      mk(prov.id, camp, "Tue 28 Jul · AM", "Arlo Khan", "Year 1", "Priya Khan", "priya.khan@example.com", "07700 900102"),
      mk(prov.id, camp, "Tue 28 Jul · AM", "Leo Park", "Year 2", "Min Park", "min.park@example.com", "07700 900103"),
      mk(prov.id, camp, "Tue 28 Jul · AM", "Otis Reed", "Year 5", "Jo Reed", "", "07700 900104") // no email on file
    ];
  }
  function mk(providerId, camp, dateLabel, childName, childYear, parentName, parentEmail, parentPhone) {
    return {
      id: safeUid(), providerId: providerId, campId: camp.id, campName: camp.name,
      dateLabel: dateLabel, childName: childName, childYear: childYear,
      parentName: parentName, parentEmail: parentEmail, parentPhone: parentPhone,
      consentMarketing: true
    };
  }

  /* ================================================================
   * UI — render(mountEl): a working "Contact customers" dashboard panel.
   *   - choose scope: a single day's register, or the whole week
   *   - see the de-duplicated recipient list (BCC count)
   *   - write subject + body, send -> message lands in the sent log
   *   - download the Sales CSV for the class
   * Uses its OWN demo store slot so it never collides with selfTest fixtures.
   * ================================================================ */
  function render(mountEl) {
    try {
      var prov = defaultProvider();

      // Seed the demo roster once.
      (function ensureSeed() {
        var d = loadDemo();
        if (!bookingsFor(d, prov.id).length) {
          setBookings(d, prov.id, seedDemoBookings(prov));
          saveDemo(d);
        }
      })();

      var dayOptions = ["Mon 27 Jul · AM", "Tue 28 Jul · AM"];

      function currentScope() {
        var sel = mountEl.querySelector("#hcccScope");
        return sel && sel.value === "day" ? "day" : "series";
      }
      function currentDay() {
        var sel = mountEl.querySelector("#hcccDay");
        return sel ? sel.value : dayOptions[0];
      }

      function preview() {
        var d = loadDemo();
        var scope = currentScope();
        var day = currentDay();
        var attendees = attendeesFor(d, prov.id, "demo-camp", scope, day);
        var dd = dedupeRecipients(attendees, "email");
        return { attendees: attendees, dd: dd, scope: scope, day: day };
      }

      function paint() {
        var d = loadDemo();
        var p = preview();
        var sent = messagesFor(d, prov.id, "demo-camp").slice().reverse();

        var recHtml = "";
        if (!p.dd.recipients.length) {
          recHtml = '<p style="margin:0;color:#808080;font-size:13px">No reachable customers for this scope.</p>';
        } else {
          for (var i = 0; i < p.dd.recipients.length; i++) {
            var r = p.dd.recipients[i];
            recHtml +=
              '<div style="display:flex;justify-content:space-between;gap:8px;padding:6px 0;border-bottom:1px solid #F0E8F4;font-size:13px">' +
                '<div><strong>' + esc(r.name || "—") + '</strong> · ' + esc(r.email || "no email") +
                  (r.count > 1 ? ' <span style="color:#603488">(' + r.count + ' bookings — merged)</span>' : '') +
                '</div>' +
                '<div style="color:#808080">' + esc(r.childName) + '</div>' +
              '</div>';
          }
        }

        var skipHtml = "";
        if (p.dd.skipped.length) {
          skipHtml = '<p style="margin:6px 0 0;font-size:12px;color:#9a1f5e">' + p.dd.skipped.length +
            ' booking(s) have no email on file and were skipped for an email blast (reach them by phone).</p>';
        }

        var sentHtml = "";
        if (!sent.length) {
          sentHtml = '<p style="margin:0;color:#808080;font-size:13px">No messages sent yet.</p>';
        } else {
          for (var j = 0; j < sent.length; j++) {
            var m = sent[j];
            sentHtml +=
              '<div style="border:1.5px solid #E6E6E6;border-radius:12px;padding:12px 14px;margin:0 0 10px">' +
                '<div style="font-family:Quicksand,system-ui,sans-serif;font-weight:700;color:#603488;font-size:14px">✉️ ' + esc(m.subject) + '</div>' +
                '<div style="font-size:12px;color:#808080;margin:3px 0 6px">' + esc(m.classLabel) +
                  ' · BCC ' + m.recipientCount + ' carer(s) · ' + esc(m.sentAt.slice(0, 10)) + '</div>' +
                '<div style="font-size:13px;color:#383838;white-space:pre-wrap">' + esc(m.body) + '</div>' +
              '</div>';
          }
        }

        mountEl.innerHTML =
          '<div style="font-family:Nunito Sans,system-ui,sans-serif;color:#383838;font-size:14px;line-height:1.55">' +
            '<p style="margin:0 0 12px">Message the customers booked onto <strong>' + esc(prov.name) + '</strong>. ' +
            'Pick a single day’s register or the whole week — we gather every booked carer, ' +
            '<strong>de-duplicate</strong> anyone who booked more than once, and send one <strong>BCC</strong> email ' +
            '(no parent sees another’s address).</p>' +

            '<div style="background:#F0E8F4;border-radius:14px;padding:14px 16px;margin:0 0 14px">' +
              '<div style="display:flex;gap:12px;flex-wrap:wrap;align-items:flex-end">' +
                '<div><label style="display:block;font-size:12.5px;font-weight:700;color:#603488;font-family:Quicksand,system-ui,sans-serif;margin:0 0 3px">Who to contact</label>' +
                  '<select id="hcccScope" style="padding:8px 10px;border:1.5px solid #E6E6E6;border-radius:10px;font-size:14px;font-family:inherit">' +
                    '<option value="series">Whole week (every register)</option>' +
                    '<option value="day">A single day / register</option>' +
                  '</select></div>' +
                '<div id="hcccDayWrap" style="display:none"><label style="display:block;font-size:12.5px;font-weight:700;color:#603488;font-family:Quicksand,system-ui,sans-serif;margin:0 0 3px">Which day</label>' +
                  '<select id="hcccDay" style="padding:8px 10px;border:1.5px solid #E6E6E6;border-radius:10px;font-size:14px;font-family:inherit">' +
                    dayOptions.map(function (x) { return '<option value="' + esc(x) + '">' + esc(x) + '</option>'; }).join("") +
                  '</select></div>' +
              '</div>' +
              '<div style="font-family:Quicksand,system-ui,sans-serif;font-weight:700;color:#603488;font-size:13px;margin:12px 0 4px">' +
                'Recipients · <span id="hcccCount">' + p.dd.recipients.length + '</span> carer(s) on BCC</div>' +
              '<div id="hcccRecips">' + recHtml + '</div>' +
              '<div id="hcccSkip">' + skipHtml + '</div>' +
            '</div>' +

            '<label style="display:block;font-size:12.5px;font-weight:700;color:#603488;font-family:Quicksand,system-ui,sans-serif;margin:0 0 3px">Subject</label>' +
            '<input id="hcccSubject" type="text" value="Important info about your camp place" style="width:100%;padding:8px 10px;border:1.5px solid #E6E6E6;border-radius:10px;font-size:14px;font-family:inherit;margin:0 0 10px" />' +
            '<label style="display:block;font-size:12.5px;font-weight:700;color:#603488;font-family:Quicksand,system-ui,sans-serif;margin:0 0 3px">Message</label>' +
            '<textarea id="hcccBody" rows="4" placeholder="e.g. Please arrive 10 minutes early on Monday and bring a sun hat and water bottle." style="width:100%;padding:8px 10px;border:1.5px solid #E6E6E6;border-radius:10px;font-size:14px;font-family:inherit;resize:vertical"></textarea>' +

            '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px">' +
              '<button id="hcccSend" type="button" class="hc-btn">Send to customers</button>' +
              '<button id="hcccCsv" type="button" class="hc-btn hc-btn-ghost">Download Sales CSV</button>' +
              '<button id="hcccReset" type="button" class="hc-btn hc-btn-ghost" style="font-size:11px">Reset</button>' +
            '</div>' +
            '<div id="hcccMsg" style="margin-top:10px;font-size:13px"></div>' +

            '<div style="font-family:Quicksand,system-ui,sans-serif;font-weight:700;color:#603488;font-size:15px;margin:18px 0 8px">📤 Sent messages</div>' +
            '<div id="hcccSent">' + sentHtml + '</div>' +
          '</div>';

        wire();
      }

      function wire() {
        var get = function (id) { return mountEl.querySelector("#" + id); };
        var msg = get("hcccMsg");

        function syncScope() {
          var wrap = get("hcccDayWrap");
          if (wrap) wrap.style.display = currentScope() === "day" ? "" : "none";
          paint(); // re-render recipients for the new scope
        }
        get("hcccScope").addEventListener("change", syncScope);
        var dayEl = get("hcccDay");
        if (dayEl) dayEl.addEventListener("change", paint);

        get("hcccSend").addEventListener("click", function () {
          var d = loadDemo();
          var res = messageClassCustomers(d, prov.id, {
            campId: "demo-camp",
            campName: prov.name,
            scope: currentScope(),
            dateLabel: currentDay(),
            channel: "email",
            subject: get("hcccSubject").value,
            body: get("hcccBody").value
          });
          if (!res.ok) {
            if (msg) msg.innerHTML = '<span style="color:#9a1f5e">Could not send: ' + esc(res.error) + '</span>';
            return;
          }
          saveDemo(d);
          try { HC.util.toast("✉️ Sent to " + res.recipientCount + " carer(s) on BCC"); } catch (e) {}
          paint();
          var m2 = mountEl.querySelector("#hcccMsg");
          if (m2) {
            m2.innerHTML = '<span style="color:#2f7d4f;font-weight:700">✓ Message sent to ' + res.recipientCount +
              ' carer(s) on BCC' + (res.skipped.length ? ' (' + res.skipped.length + ' had no email).' : '.') + '</span>';
          }
        });

        get("hcccCsv").addEventListener("click", function () {
          var d = loadDemo();
          var csv = salesCsv(d, prov.id, "demo-camp", currentScope(), currentDay());
          try {
            var blob = new Blob([csv], { type: "text/csv" });
            var a = document.createElement("a");
            a.href = URL.createObjectURL(blob);
            a.download = "sales-" + prov.id + ".csv";
            document.body.appendChild(a); a.click();
            setTimeout(function () { URL.revokeObjectURL(a.href); if (a.parentNode) a.parentNode.removeChild(a); }, 0);
            HC.util.toast("⬇️ Sales CSV downloaded");
          } catch (e) {
            if (msg) msg.innerHTML = '<pre style="white-space:pre-wrap;font-size:12px;background:#F7F4FA;padding:10px;border-radius:10px;overflow:auto">' + esc(csv) + '</pre>';
          }
        });

        get("hcccReset").addEventListener("click", function () {
          if (HC.store.remove) HC.store.remove(DEMO_KEY); else saveDemo(normalise(null));
          var d2 = loadDemo();
          setBookings(d2, prov.id, seedDemoBookings(prov));
          saveDemo(d2);
          paint();
        });
      }

      paint();
    } catch (e) {
      mountEl.innerHTML = '<p style="color:#9a1f5e">Preview unavailable: ' +
        (e && e.message ? e.message : String(e)) + "</p>";
    }
  }

  /* ================================================================
   * selfTest — exercises the LOGIC and asserts the acceptance criterion:
   *   "Provider can message customers of a class from the dashboard."
   * Multiple cases.
   * ================================================================ */
  function selfTest() {
    var pass = 0, fail = 0, log = [];
    function check(label, fn) {
      try { fn(); pass += 1; log.push("✓ " + label); }
      catch (e) { fail += 1; log.push("✗ " + label + " — " + (e && e.message ? e.message : String(e))); }
    }
    var A = HC.assert;

    function freshLog() { return normalise(null); }

    // A roster: one camp, two registers (Mon/Tue). Priya Khan booked BOTH days
    // and TWO children -> the de-dupe case. Otis Reed has no email on file.
    function seedRoster() {
      var l = freshLog();
      setBookings(l, "prov-A", [
        { id: "b1", providerId: "prov-A", campId: "camp-1", campName: "Summer Multi-Sports", dateLabel: "Mon 27 Jul", childName: "Maya Lewis", childYear: "Year 3", parentName: "Dee Lewis", parentEmail: "dee@example.com", parentPhone: "07700 900101" },
        { id: "b2", providerId: "prov-A", campId: "camp-1", campName: "Summer Multi-Sports", dateLabel: "Mon 27 Jul", childName: "Arlo Khan", childYear: "Year 1", parentName: "Priya Khan", parentEmail: "priya@example.com", parentPhone: "07700 900102" },
        { id: "b3", providerId: "prov-A", campId: "camp-1", campName: "Summer Multi-Sports", dateLabel: "Mon 27 Jul", childName: "Sana Khan", childYear: "Year 4", parentName: "Priya Khan", parentEmail: "priya@example.com", parentPhone: "07700 900102" },
        { id: "b4", providerId: "prov-A", campId: "camp-1", campName: "Summer Multi-Sports", dateLabel: "Tue 28 Jul", childName: "Arlo Khan", childYear: "Year 1", parentName: "Priya Khan", parentEmail: "Priya@Example.com", parentPhone: "07700 900102" },
        { id: "b5", providerId: "prov-A", campId: "camp-1", campName: "Summer Multi-Sports", dateLabel: "Tue 28 Jul", childName: "Leo Park", childYear: "Year 2", parentName: "Min Park", parentEmail: "min@example.com", parentPhone: "07700 900103" },
        { id: "b6", providerId: "prov-A", campId: "camp-1", campName: "Summer Multi-Sports", dateLabel: "Tue 28 Jul", childName: "Otis Reed", childYear: "Year 5", parentName: "Jo Reed", parentEmail: "", parentPhone: "07700 900104" },
        // A different camp by the same provider — must NOT bleed into camp-1 messages.
        { id: "b7", providerId: "prov-A", campId: "camp-2", campName: "Coding Club", dateLabel: "Mon 27 Jul", childName: "Eve Stone", childYear: "Year 6", parentName: "Ali Stone", parentEmail: "ali@example.com", parentPhone: "07700 900105" }
      ]);
      return l;
    }

    // --- ACCEPTANCE: provider can message the customers of a class ---
    check("ACCEPTANCE: provider messages a class's customers from the dashboard", function () {
      var l = seedRoster();
      A(messagesFor(l, "prov-A").length === 0, "no messages sent yet");

      var res = messageClassCustomers(l, "prov-A", {
        campId: "camp-1", campName: "Summer Multi-Sports", scope: "series",
        subject: "Bring a sun hat", body: "Please send your child with a sun hat and water bottle."
      });

      A(res.ok === true, "send succeeded: " + res.error);
      A(res.message !== null, "a message object was produced");
      A(messagesFor(l, "prov-A").length === 1, "exactly one message recorded");
      A(res.recipientCount > 0, "the message reached at least one customer");
      // It must carry the customers' addresses and the provider's content.
      A(res.message.bcc.length === res.recipientCount, "every recipient is on BCC");
      A(res.message.subject === "Bring a sun hat", "subject carried");
      A(res.message.body.indexOf("sun hat and water bottle") !== -1, "body carried the provider's content");
      A(res.message.campId === "camp-1", "tied to the chosen class");
    });

    // --- whole-week (series): de-dupe carers who booked multiple times ---
    check("Whole-week scope de-duplicates carers (UNIQUE) for the BCC list", function () {
      var l = seedRoster();
      var res = messageClassCustomers(l, "prov-A", { campId: "camp-1", scope: "series", subject: "s", body: "b" });
      A(res.ok, "sent");
      // camp-1 has 6 bookings across Mon+Tue, but only 3 carers WITH an email:
      // Dee, Priya (x3 bookings, one with mixed-case email), Min. Otis has none.
      A(res.message.attendeeCount === 6, "all 6 camp-1 bookings considered, got " + res.message.attendeeCount);
      A(res.recipientCount === 3, "de-duped to 3 reachable carers, got " + res.recipientCount);
      // Priya appears ONCE despite 3 bookings + a mixed-case duplicate email.
      var emails = res.message.bcc.map(function (e) { return e.toLowerCase(); });
      var priyaCount = emails.filter(function (e) { return e === "priya@example.com"; }).length;
      A(priyaCount === 1, "Priya appears once on BCC despite 3 bookings, got " + priyaCount);
      // No duplicates at all in the BCC list.
      var uniq = {}; var dupes = 0;
      emails.forEach(function (e) { if (uniq[e]) dupes += 1; uniq[e] = true; });
      A(dupes === 0, "BCC list has no duplicate addresses, found " + dupes);
    });

    // --- single day / register scope: only that day's customers ---
    check("Single-day scope contacts only that register's customers", function () {
      var l = seedRoster();
      var mon = messageClassCustomers(l, "prov-A", { campId: "camp-1", scope: "day", dateLabel: "Mon 27 Jul", subject: "Mon", body: "see you Monday" });
      A(mon.ok, "Monday send ok");
      // Mon has Maya(Dee), Arlo(Priya), Sana(Priya) -> 2 unique carers.
      A(mon.message.attendeeCount === 3, "3 Monday bookings, got " + mon.message.attendeeCount);
      A(mon.recipientCount === 2, "2 unique Monday carers, got " + mon.recipientCount);
      A(mon.message.scope === "day" && mon.message.dateLabel === "Mon 27 Jul", "scoped to the Monday register");

      var tue = messageClassCustomers(l, "prov-A", { campId: "camp-1", scope: "day", dateLabel: "Tue 28 Jul", subject: "Tue", body: "see you Tuesday" });
      // Tue has Arlo(Priya), Leo(Min), Otis(no email) -> 2 reachable carers.
      A(tue.recipientCount === 2, "2 reachable Tuesday carers, got " + tue.recipientCount);
      var tueEmails = tue.message.bcc.join(",");
      A(tueEmails.indexOf("dee@example.com") === -1, "Monday-only carer not contacted for Tuesday");
    });

    // --- a day scope needs a date; missing date is rejected ---
    check("Day scope without a dateLabel is rejected", function () {
      var l = seedRoster();
      var res = messageClassCustomers(l, "prov-A", { campId: "camp-1", scope: "day", subject: "x", body: "y" });
      A(res.ok === false, "rejected");
      A(/dateLabel/i.test(res.error || ""), "error mentions the missing day, got " + res.error);
    });

    // --- carers with no email are skipped for an email blast, and reported ---
    check("Customers with no email on file are skipped and reported", function () {
      var l = seedRoster();
      var res = messageClassCustomers(l, "prov-A", { campId: "camp-1", scope: "day", dateLabel: "Tue 28 Jul", subject: "s", body: "b" });
      A(res.ok, "sent");
      A(res.skipped.length === 1, "one skipped (Otis has no email), got " + res.skipped.length);
      A(res.skipped[0].reason === "no-email", "skip reason is no-email, got " + res.skipped[0].reason);
      A(res.skipped[0].name === "Jo Reed", "the skipped carer is named, got " + res.skipped[0].name);
      // And the skipped carer is NOT on the BCC list.
      A(res.message.bcc.join(",").indexOf("900104") === -1, "no phone leaked into an email blast");
    });

    // --- messaging is scoped to the chosen class only (no cross-camp leak) ---
    check("A message reaches only the chosen class, not the provider's other camps", function () {
      var l = seedRoster();
      var res = messageClassCustomers(l, "prov-A", { campId: "camp-1", scope: "series", subject: "s", body: "b" });
      A(res.message.bcc.indexOf("ali@example.com") === -1, "camp-2's customer (Ali) is NOT contacted for camp-1");
      // And messaging camp-2 reaches only Ali.
      var r2 = messageClassCustomers(l, "prov-A", { campId: "camp-2", scope: "series", subject: "s", body: "b" });
      A(r2.recipientCount === 1 && r2.message.bcc[0] === "ali@example.com", "camp-2 message reaches only Ali");
    });

    // --- empty class: nothing booked -> nothing to send, clear error ---
    check("Messaging a class with no customers is rejected cleanly", function () {
      var l = seedRoster();
      var res = messageClassCustomers(l, "prov-A", { campId: "camp-EMPTY", scope: "series", subject: "s", body: "b" });
      A(res.ok === false, "rejected");
      A(/no customers/i.test(res.error || ""), "error says no customers, got " + res.error);
      A(messagesFor(l, "prov-A", "camp-EMPTY").length === 0, "nothing recorded");
    });

    // --- validation: campId required ---
    check("Validation: campId is required to message a class", function () {
      var l = seedRoster();
      var res = messageClassCustomers(l, "prov-A", { scope: "series", subject: "s", body: "b" });
      A(res.ok === false, "rejected");
      A(/camp/i.test(res.error || ""), "error mentions the camp, got " + res.error);
    });

    // --- validation: providerId required ---
    check("Validation: providerId is required", function () {
      var l = seedRoster();
      var res = messageClassCustomers(l, "", { campId: "camp-1", scope: "series", subject: "s", body: "b" });
      A(res.ok === false, "rejected");
      A(/provider/i.test(res.error || ""), "error mentions the provider, got " + res.error);
    });

    // --- a default subject is supplied when the provider leaves it blank ---
    check("A blank subject still produces a sensible default", function () {
      var l = seedRoster();
      var res = messageClassCustomers(l, "prov-A", { campId: "camp-1", campName: "Summer Multi-Sports", scope: "series", body: "hi" });
      A(res.ok, "sent");
      A(trimmed(res.message.subject).length > 0, "a non-empty subject was composed");
      A(res.message.subject.indexOf("Summer Multi-Sports") !== -1, "default subject references the class");
    });

    // --- the Sales CSV export carries every booking, grouped by date ---
    check("Sales CSV export lists every booking for the class with contact columns", function () {
      var l = seedRoster();
      var csv = salesCsv(l, "prov-A", "camp-1", "series", "");
      var rows = csv.split("\n");
      A(rows.length === 7, "header + 6 camp-1 bookings, got " + rows.length + " rows");
      A(rows[0].indexOf("Email") !== -1 && rows[0].indexOf("Phone") !== -1, "CSV has Email and Phone columns");
      A(csv.indexOf("dee@example.com") !== -1, "CSV includes a customer's email");
      A(csv.indexOf("ali@example.com") === -1, "CSV is scoped to camp-1, not camp-2");
    });

    // --- CSV defensively quotes fields containing commas ---
    check("Sales CSV quotes fields containing commas", function () {
      var l = freshLog();
      setBookings(l, "prov-Q", [
        { id: "q1", providerId: "prov-Q", campId: "c", campName: "C", dateLabel: "Mon", childName: "A, B", childYear: "Y3", parentName: "Doe, Jane", parentEmail: "jane@example.com", parentPhone: "07700 900200" }
      ]);
      var csv = salesCsv(l, "prov-Q", "c", "series", "");
      A(csv.indexOf('"Doe, Jane"') !== -1, "comma-bearing name is quoted");
      A(csv.indexOf('"A, B"') !== -1, "comma-bearing child name is quoted");
    });

    // --- EACH send is logged separately; the provider has a sent history ---
    check("Each send is recorded so the provider has a sent history", function () {
      var l = seedRoster();
      messageClassCustomers(l, "prov-A", { campId: "camp-1", scope: "day", dateLabel: "Mon 27 Jul", subject: "Mon note", body: "x" });
      messageClassCustomers(l, "prov-A", { campId: "camp-1", scope: "day", dateLabel: "Tue 28 Jul", subject: "Tue note", body: "y" });
      var sent = messagesFor(l, "prov-A", "camp-1");
      A(sent.length === 2, "two distinct messages logged, got " + sent.length);
      A(sent[0].subject === "Mon note" && sent[1].subject === "Tue note", "each send kept its own content");
      A(sent[0].id !== sent[1].id, "each message has its own id");
    });

    // --- persistence round-trips through HC.store (mock, hc_ namespaced) ---
    check("Message round-trips via HC.store", function () {
      var pid = "test_prov_" + safeUid();
      var l = loadLog();
      addBooking(l, pid, { campId: "rt-camp", campName: "RT Camp", dateLabel: "Mon", childName: "Round Trip", parentName: "Persist", parentEmail: "rt@example.com", parentPhone: "07700 900900" });
      var res = messageClassCustomers(l, pid, { campId: "rt-camp", scope: "series", subject: "RT", body: "persist me" });
      A(res.ok, "sent");
      saveLog(l);

      var back = loadLog();
      var got = messagesFor(back, pid, "rt-camp");
      A(got.length === 1, "message persisted in the store, got " + got.length);
      A(got[0].bcc.indexOf("rt@example.com") !== -1, "persisted message still carries the customer's address");

      // Clean up so we never leak test state into the live store.
      try {
        var c = loadLog();
        c.messages = c.messages.filter(function (m) { return m.providerId !== pid; });
        delete c.bookings[pid];
        saveLog(c);
      } catch (e) { /* ignore */ }
    });

    return { pass: pass, fail: fail, log: log };
  }

  /* ---------------- register ---------------- */
  HC.registerFeature({
    id: "provider-contact-customers",
    title: "Contact customers",
    side: "provider",
    icon: "✉️",
    summary: "Message the customers booked onto a camp straight from your dashboard. Pick a single day's register or the whole week, and we gather every booked carer, de-duplicate anyone who booked twice, and send one BCC email (no parent sees another's address). Export the same list as a Sales CSV.",
    render: render,
    selfTest: selfTest
  });
})();
