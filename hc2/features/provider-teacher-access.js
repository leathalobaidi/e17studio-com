/* HolidayCamp feature — provider-teacher-access
 *
 * Share a register with an external teacher (limited login)  (PROVIDER side)
 *
 * Replicates Happity's "Sharing a register with an external teacher" behaviour.
 * Evidence (support articles):
 *   - 4147796 "Sharing a register with an external teacher":
 *       "you can give them LIMITED ACCESS to your registers, so that they can see
 *        the register for the class they are leading, but NO OTHER INFORMATION on
 *        your profile. Teachers can ONLY see the 'Print register' view — they can
 *        see the names of the adults and children attending the class, and the age
 *        of the children — as well as any important notes on SEN or allergies.
 *        ... go to Profile > Teachers ... choose which classes in your timetable
 *        they should have access to. ... Teachers will be able to see ALL of the
 *        registers for FUTURE DATES for that weekly slot."
 *   - 5917325 "Can I add extra users to my account?":
 *       "Alternatively, you can create a TEACHER account rather than a user. This
 *        means that they will only be able to access class registers and will NOT
 *        be able to make any changes to the account."
 *
 * Framed for SCHOOL-AGE HOLIDAY CAMPS: a provider runs camp "classes" (one per
 * camp week / age-band slot). The provider invites an external camp leader
 * ("teacher") and ticks which classes that teacher is leading. The teacher gets a
 * limited login that resolves ONLY to the Print-register view of their ASSIGNED
 * classes — every other surface (edit camp, bookings, payouts, other classes,
 * other teachers, account settings) is denied. The register shows the child name,
 * the booking adult, the child's age, and any SEN / allergy notes — and nothing
 * more sensitive (no parent phone/email, no payment data).
 *
 * ACCEPTANCE CRITERION (exercised by selfTest):
 *   A teacher login sees ONLY assigned classes' print registers and NOTHING else.
 *
 * Self-contained, defensive, no imports/exports. Calls HC.registerFeature.
 */
(function () {
  "use strict";

  // Defensive: never throw at module load if HC isn't present.
  if (typeof window === "undefined" || !window.HC || typeof window.HC.registerFeature !== "function") {
    if (typeof console !== "undefined" && console.warn) {
      console.warn("[HC] provider-teacher-access: HC core not found; skipping registration.");
    }
    return;
  }

  var HC = window.HC;

  var STORE_KEY = "provider_teacher_access_state";

  // The ONLY view a teacher login may ever resolve to (evidence 4147796:
  // "Teachers can only see the 'Print register' view").
  var TEACHER_VIEW = "print-register";

  // Everything else on a provider profile a teacher must NOT reach. This is the
  // explicit deny-list the acceptance test asserts against ("...and nothing else").
  var PROVIDER_SURFACES = [
    "edit-camp", "bookings", "payouts", "stripe-connect", "account-settings",
    "company-details", "teachers", "messages", "refunds", "discount-codes",
    "venue-create", "timetable-edit"
  ];

  // Fields a teacher is permitted to see on each register row. Anything outside
  // this whitelist (parent phone, parent email, amount paid, payment ref) is
  // stripped before the row is handed to a teacher login.
  var TEACHER_FIELDS = ["childName", "bookingAdult", "childAge", "notes"];
  var SENSITIVE_FIELDS = ["parentPhone", "parentEmail", "amountPaid", "paymentRef"];

  /* ---------------- small helpers ---------------- */

  function safeUid() {
    try { return HC.util.uid(); } catch (e) { return "id_" + Math.random().toString(36).slice(2); }
  }
  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
  function providers() {
    try { return HC.data.providers || []; } catch (e) { return []; }
  }
  function plannerWeeks() {
    try {
      var w = HC.data.planner && HC.data.planner.weeks;
      return Array.isArray(w) ? w : [];
    } catch (e) { return []; }
  }

  /* ---------------- state shape ----------------
   *
   * state = {
   *   classes: { <classId>: { id, providerId, name, week, ageBand, roster:[row], futureDates:[iso] } },
   *   teachers: { <teacherId>: { id, name, email, token, active, classIds:[...] } }
   * }
   *
   * A register row:
   *   { childName, bookingAdult, childAge, notes,           // teacher-visible
   *     parentPhone, parentEmail, amountPaid, paymentRef }   // provider-only
   *
   * All transition functions are PURE (clone-in/clone-out) so tests run on
   * fresh literals and the original is never mutated.
   */

  function emptyState() { return { classes: {}, teachers: {} }; }

  function cloneState(state) {
    try { return JSON.parse(JSON.stringify(state || emptyState())); }
    catch (e) { return emptyState(); }
  }

  function classesArr(state) {
    if (!state || !state.classes) return [];
    return Object.keys(state.classes).map(function (id) { return state.classes[id]; });
  }
  function teachersArr(state) {
    if (!state || !state.teachers) return [];
    return Object.keys(state.teachers).map(function (id) { return state.teachers[id]; });
  }

  /* ---------------- teacher lifecycle (pure) ---------------- */

  // Create a teacher record with a limited login (an activation token, mirroring
  // Happity's "press the envelope to send their activation email"). Starts with
  // NO class assignments — access is granted explicitly, class by class.
  function addTeacher(state, name, email) {
    var next = cloneState(state);
    var id = safeUid();
    next.teachers[id] = {
      id: id,
      name: String(name || "Camp leader"),
      email: String(email || ""),
      token: safeUid(),     // the limited-login credential
      active: true,
      classIds: []
    };
    return { state: next, teacherId: id };
  }

  // Tick / untick a class for a teacher (Profile > Teachers: "choose which classes
  // in your timetable they should have access to"). Idempotent + safe on bad ids.
  function assignClass(state, teacherId, classId) {
    var next = cloneState(state);
    var t = next.teachers[teacherId];
    if (!t || !next.classes[classId]) return next;
    if (t.classIds.indexOf(classId) === -1) t.classIds.push(classId);
    return next;
  }
  function unassignClass(state, teacherId, classId) {
    var next = cloneState(state);
    var t = next.teachers[teacherId];
    if (!t) return next;
    t.classIds = t.classIds.filter(function (c) { return c !== classId; });
    return next;
  }

  // Remove a teacher's access entirely (Happity: contact support to remove a
  // teacher). Here we deactivate so the login resolves to nothing.
  function revokeTeacher(state, teacherId) {
    var next = cloneState(state);
    var t = next.teachers[teacherId];
    if (t) { t.active = false; t.classIds = []; }
    return next;
  }

  /* ---------------- authentication (pure) ---------------- */

  // Resolve a login token to the teacher it belongs to (or null). An inactive
  // teacher or unknown token resolves to null — the login fails closed.
  function authTeacher(state, token) {
    var ts = teachersArr(state);
    for (var i = 0; i < ts.length; i++) {
      if (ts[i] && ts[i].active && ts[i].token === token) return ts[i];
    }
    return null;
  }

  /* ---------------- the PERMISSION GATE (the heart of the feature) ----------------
   *
   * canTeacherSee(state, token, request) is the single chokepoint every teacher
   * request passes through. It returns true ONLY when:
   *   - the token resolves to an active teacher, AND
   *   - request.view === 'print-register' (the one allowed view), AND
   *   - request.classId is in that teacher's own assignment list.
   * Every other view, and every unassigned/other-provider class, is denied.
   */
  function canTeacherSee(state, token, request) {
    var teacher = authTeacher(state, token);
    if (!teacher) return false;                       // bad/inactive login
    if (!request || typeof request !== "object") return false;
    if (request.view !== TEACHER_VIEW) return false;  // only the print-register view
    if (!request.classId) return false;
    return teacher.classIds.indexOf(request.classId) !== -1; // only assigned classes
  }

  // Strip a register row down to only the teacher-visible fields. Sensitive
  // contact / payment fields never leave the gate.
  function teacherSafeRow(row) {
    var out = {};
    if (!row || typeof row !== "object") return out;
    for (var i = 0; i < TEACHER_FIELDS.length; i++) {
      var f = TEACHER_FIELDS[i];
      if (Object.prototype.hasOwnProperty.call(row, f)) out[f] = row[f];
    }
    return out;
  }

  // The print-register a teacher actually receives for ONE class. Returns null if
  // the gate denies the request (so a denied class yields no data at all). The
  // returned rows carry ONLY whitelisted fields.
  function teacherRegister(state, token, classId) {
    var req = { view: TEACHER_VIEW, classId: classId };
    if (!canTeacherSee(state, token, req)) return null;
    var cls = state.classes[classId];
    if (!cls) return null;
    return {
      classId: cls.id,
      className: cls.name,
      week: cls.week,
      ageBand: cls.ageBand,
      futureDates: Array.isArray(cls.futureDates) ? cls.futureDates.slice() : [],
      rows: (cls.roster || []).map(teacherSafeRow)
    };
  }

  // The COMPLETE set of registers a given teacher login can see — i.e. exactly
  // their assigned classes, each as a print register, and NOTHING else. This is
  // what the acceptance criterion is about.
  function teacherVisibleRegisters(state, token) {
    var teacher = authTeacher(state, token);
    if (!teacher) return [];
    var out = [];
    for (var i = 0; i < teacher.classIds.length; i++) {
      var reg = teacherRegister(state, token, teacher.classIds[i]);
      if (reg) out.push(reg);
    }
    return out;
  }

  // The set of classIds a teacher login is allowed to open (assigned + still
  // existing). Handy for the UI and for asserting "only assigned".
  function teacherVisibleClassIds(state, token) {
    return teacherVisibleRegisters(state, token).map(function (r) { return r.classId; });
  }

  /* ---------------- persistence (HC.store only) ---------------- */

  function loadState() {
    var raw;
    try { raw = HC.store.get(STORE_KEY, null); } catch (e) { raw = null; }
    if (!raw || typeof raw !== "object" || !raw.classes || !raw.teachers) return null;
    return raw;
  }
  function saveState(state) {
    try { HC.store.set(STORE_KEY, state); } catch (e) {}
  }
  function clearState() {
    try { HC.store.remove ? HC.store.remove(STORE_KEY) : HC.store.set(STORE_KEY, null); }
    catch (e) {}
  }

  /* ---------------- demo seed from the live directory ---------------- */

  // Plausible school-age camp roster rows. Kept short; the point is structure,
  // not volume. SEN/allergy notes land on some rows (evidence: "important notes
  // on SEN or allergies").
  function sampleRoster(seedNames, ageMin, ageMax) {
    var lo = Number(ageMin) || 5, hi = Number(ageMax) || 11;
    var notes = [
      "", "Nut allergy — EpiPen in bag", "", "ASD — needs quiet space at lunch",
      "Asthma inhaler in rucksack", "", "Hearing aid (left ear)", ""
    ];
    var adults = ["Sarah Okafor", "James Whitfield", "Priya Patel", "Tom Brennan",
      "Aisha Rahman", "Daniel Cole", "Megan Lloyd", "Carlos Mendez"];
    var rows = [];
    for (var i = 0; i < seedNames.length; i++) {
      var age = lo + (i % Math.max(1, (hi - lo + 1)));
      rows.push({
        childName: seedNames[i],
        bookingAdult: adults[i % adults.length],
        childAge: age,
        notes: notes[i % notes.length],
        // provider-only fields — must never reach a teacher:
        parentPhone: "07700 9000" + (10 + i),
        parentEmail: seedNames[i].toLowerCase().replace(/[^a-z]/g, ".") + "@example.com",
        amountPaid: 165 + i,
        paymentRef: "pi_" + safeUid().slice(3, 12)
      });
    }
    return rows;
  }

  // Build a demo provider with a couple of camp classes, plus one teacher who is
  // assigned to ONE of them, so the gate has something meaningful to allow/deny.
  function seedFromProviders() {
    var ps = providers();
    var weeks = plannerWeeks();
    var p = ps[0] || { id: "lloyd-park-childrens-charity", name: "Lloyd Park Holiday Club", ageMin: 4, ageMax: 11 };
    var p2 = ps[1] || { id: "active-london", name: "Active London Camp", ageMin: 5, ageMax: 12 };
    var wk1 = (weeks[0] && weeks[0].label) || "Week 1";
    var wk2 = (weeks[1] && weeks[1].label) || "Week 2";

    var c1 = "cls_" + (p.id || "p1") + "_w1";
    var c2 = "cls_" + (p.id || "p1") + "_w2";
    var c3 = "cls_" + (p2.id || "p2") + "_w1"; // a DIFFERENT provider's class

    var state = emptyState();
    state.classes[c1] = {
      id: c1, providerId: p.id, name: (p.name || "Holiday Club") + " — " + wk1 + " (Juniors)",
      week: wk1, ageBand: (p.ageMin || 4) + "–" + Math.min((p.ageMax || 11), 8),
      futureDates: ["2026-07-20", "2026-07-21", "2026-07-22", "2026-07-23", "2026-07-24"],
      roster: sampleRoster(["Olivia B.", "Noah K.", "Amelia R.", "Leo M.", "Sofia T."], p.ageMin, 8)
    };
    state.classes[c2] = {
      id: c2, providerId: p.id, name: (p.name || "Holiday Club") + " — " + wk2 + " (Seniors)",
      week: wk2, ageBand: "9–" + (p.ageMax || 11),
      futureDates: ["2026-07-27", "2026-07-28", "2026-07-29", "2026-07-30", "2026-07-31"],
      roster: sampleRoster(["Harry W.", "Isla P.", "George D.", "Maya L."], 9, p.ageMax)
    };
    state.classes[c3] = {
      id: c3, providerId: p2.id, name: (p2.name || "Other Camp") + " — " + wk1,
      week: wk1, ageBand: (p2.ageMin || 5) + "–" + (p2.ageMax || 12),
      futureDates: ["2026-07-20"],
      roster: sampleRoster(["Ethan S.", "Grace F."], p2.ageMin, p2.ageMax)
    };

    var added = addTeacher(state, "Jess Cover (external leader)", "jess@coverteachers.example");
    state = added.state;
    // Assign Jess to the Week-1 Juniors class ONLY.
    state = assignClass(state, added.teacherId, c1);
    return { state: state, teacherId: added.teacherId, classIds: [c1, c2, c3] };
  }

  /* ---------------- UI ---------------- */

  function renderRegisterTable(reg) {
    var head =
      '<div style="font-family:Quicksand,system-ui,sans-serif;font-weight:700;color:var(--purple,#603488);font-size:15px">' +
        esc(reg.className) + "</div>" +
      '<div style="font-size:12px;color:var(--muted,#808080);margin:2px 0 8px">' +
        esc(reg.week) + " · ages " + esc(reg.ageBand) +
        " · " + (reg.futureDates.length) + " future date" + (reg.futureDates.length === 1 ? "" : "s") +
      "</div>";
    var rows = (reg.rows || []).map(function (r) {
      var noteCell = r.notes
        ? '<span style="color:#9a1f5e;font-weight:700">' + esc(r.notes) + "</span>"
        : '<span style="color:var(--muted,#808080)">—</span>';
      return "<tr>" +
        '<td style="padding:6px 8px;border-bottom:1px solid var(--line,#E6E6E6)">' + esc(r.childName) + "</td>" +
        '<td style="padding:6px 8px;border-bottom:1px solid var(--line,#E6E6E6)">' + esc(r.bookingAdult) + "</td>" +
        '<td style="padding:6px 8px;border-bottom:1px solid var(--line,#E6E6E6);text-align:center">' + esc(r.childAge) + "</td>" +
        '<td style="padding:6px 8px;border-bottom:1px solid var(--line,#E6E6E6)">' + noteCell + "</td>" +
      "</tr>";
    }).join("");
    return '<div style="border:1.5px solid var(--line,#E6E6E6);border-radius:12px;padding:12px 14px;margin:0 0 12px;background:#fff">' +
      head +
      '<table style="width:100%;border-collapse:collapse;font-size:13px">' +
        '<thead><tr style="text-align:left;color:var(--purple,#603488);font-family:Quicksand,system-ui,sans-serif">' +
          '<th style="padding:6px 8px">Child</th>' +
          '<th style="padding:6px 8px">Booked by</th>' +
          '<th style="padding:6px 8px;text-align:center">Age</th>' +
          '<th style="padding:6px 8px">SEN / allergy notes</th>' +
        "</tr></thead><tbody>" + (rows || '<tr><td colspan="4" style="padding:8px;color:var(--muted)">No children booked yet.</td></tr>') +
      "</tbody></table>" +
    "</div>";
  }

  function render(mountEl) {
    if (!mountEl) return;

    var seed = (loadState() && { state: loadState() }) || seedFromProviders();
    var state = seed.state;

    mountEl.innerHTML = "";
    var wrap = HC.util.el("div", {
      style: "font-family:'Nunito Sans',system-ui,sans-serif;color:var(--text,#383838)"
    });

    wrap.appendChild(HC.util.el("p", { style: "font-size:14px;margin:0 0 12px" },
      "Just like Happity's <strong>Profile &gt; Teachers</strong>: invite an external camp leader and tick which " +
      "classes they lead. They get a <strong>limited login</strong> that only ever opens the <strong>Print register</strong> " +
      "for those classes — child name, who booked them, the child's age, and any SEN / allergy notes — and " +
      "<strong>nothing else</strong> on your account. Parent contact details and payment data never reach a teacher."));

    // Two stacked panels: provider control on top, the teacher's-eye view below.
    var ctrl = HC.util.el("div", {
      style: "border:1.5px solid var(--line,#E6E6E6);border-radius:14px;padding:14px 16px;margin:0 0 16px;background:#fff"
    });
    var teacherView = HC.util.el("div", {});
    wrap.appendChild(ctrl);
    wrap.appendChild(teacherView);

    var foot = HC.util.el("div", { style: "margin-top:14px;display:flex;gap:8px;flex-wrap:wrap" });
    var resetBtn = HC.util.el("button", { class: "hc-btn hc-btn-ghost", type: "button" }, "Reset demo");
    foot.appendChild(resetBtn);
    wrap.appendChild(foot);
    mountEl.appendChild(wrap);

    function paint() {
      var teacher = teachersArr(state)[0] || null;
      var allClasses = classesArr(state);

      // ----- provider control: tick the classes this teacher leads -----
      var rows = allClasses.map(function (c) {
        var assigned = teacher && teacher.classIds.indexOf(c.id) !== -1;
        return '<label style="display:flex;align-items:center;gap:9px;padding:7px 0;border-bottom:1px solid var(--line,#E6E6E6);font-size:13.5px">' +
          '<input type="checkbox" data-cls="' + esc(c.id) + '" ' + (assigned ? "checked" : "") + ' />' +
          '<span style="flex:1">' + esc(c.name) +
            ' <span style="color:var(--muted,#808080);font-size:12px">· ' + esc(c.week) + " · ages " + esc(c.ageBand) + "</span></span>" +
          (assigned ? '<span style="font-size:11px;font-weight:700;color:#2f7d4f">leading</span>' : '<span style="font-size:11px;color:var(--muted,#808080)">no access</span>') +
        "</label>";
      }).join("");

      ctrl.innerHTML =
        '<div style="font-family:Quicksand,system-ui,sans-serif;font-weight:700;color:var(--purple,#603488);font-size:15px;margin:0 0 2px">' +
          "👩‍🏫 " + esc(teacher ? teacher.name : "No teacher") + "</div>" +
        '<div style="font-size:12px;color:var(--muted,#808080);margin:0 0 10px">' +
          "Limited login " + (teacher && teacher.active ? "active" : "revoked") +
          (teacher ? " · token <code>" + esc(String(teacher.token).slice(0, 10)) + "…</code>" : "") +
          " · tick the classes they lead</div>" +
        rows;

      // wire the checkboxes
      ctrl.querySelectorAll("input[data-cls]").forEach(function (cb) {
        cb.addEventListener("change", function () {
          var cid = cb.getAttribute("data-cls");
          if (!teacher) return;
          state = cb.checked ? assignClass(state, teacher.id, cid) : unassignClass(state, teacher.id, cid);
          saveState(state);
          paint();
        });
      });

      // ----- teacher's-eye view: exactly what the limited login resolves to -----
      var token = teacher ? teacher.token : null;
      var visible = teacherVisibleRegisters(state, token);
      var deniedCount = allClasses.length - visible.length;

      var tv =
        '<div class="hc-sidehead" style="margin-top:0">What the teacher login sees</div>' +
        '<p style="font-size:13px;color:var(--text,#383838);margin:0 0 10px">' +
          "Signed in as <strong>" + esc(teacher ? teacher.name : "—") + "</strong> — this login resolves to " +
          "<strong>" + visible.length + " print register" + (visible.length === 1 ? "" : "s") + "</strong>" +
          (deniedCount > 0 ? ", and is denied " + deniedCount + " other class" + (deniedCount === 1 ? "" : "es") + " plus the whole rest of the account." : ".") +
        "</p>";

      if (!visible.length) {
        tv += '<p style="font-size:13px;color:var(--muted,#808080)">No classes assigned — the login opens nothing.</p>';
      } else {
        tv += visible.map(renderRegisterTable).join("");
      }

      // A small "denied" strip to make the boundary visible.
      tv += '<div style="margin-top:6px;font-size:12px;color:#9a1f5e">' +
        "🔒 Blocked for this login: edit camp, bookings, payouts, account settings, other teachers, " +
        "other providers' classes, and any class not ticked above." +
      "</div>";

      teacherView.innerHTML = tv;
    }

    resetBtn.addEventListener("click", function () {
      clearState();
      var s = seedFromProviders();
      state = s.state;
      saveState(state);
      try { HC.util.toast("Demo reset"); } catch (e) {}
      paint();
    });

    saveState(state);
    paint();
  }

  /* ---------------- selfTest ---------------- */

  function selfTest() {
    var pass = 0, fail = 0, log = [];
    function check(label, fn) {
      try { fn(); pass += 1; log.push("✓ " + label); }
      catch (e) { fail += 1; log.push("✗ " + label + " — " + (e && e.message ? e.message : String(e))); }
    }

    // ---- a deterministic fixture: one provider with 2 classes, plus a SECOND
    //      provider's class, and a teacher assigned to exactly one class. ----
    function fixture() {
      var s = emptyState();
      s.classes.c1 = {
        id: "c1", providerId: "prov-A", name: "Lloyd Park — Week 1 Juniors",
        week: "Week 1", ageBand: "4–8", futureDates: ["2026-07-20", "2026-07-21"],
        roster: [
          { childName: "Olivia B.", bookingAdult: "Sarah Okafor", childAge: 6, notes: "Nut allergy — EpiPen in bag",
            parentPhone: "07700 900111", parentEmail: "sarah@example.com", amountPaid: 165, paymentRef: "pi_aaa" },
          { childName: "Noah K.", bookingAdult: "James Whitfield", childAge: 7, notes: "",
            parentPhone: "07700 900112", parentEmail: "james@example.com", amountPaid: 165, paymentRef: "pi_bbb" }
        ]
      };
      s.classes.c2 = {
        id: "c2", providerId: "prov-A", name: "Lloyd Park — Week 2 Seniors",
        week: "Week 2", ageBand: "9–11", futureDates: ["2026-07-27"],
        roster: [
          { childName: "Harry W.", bookingAdult: "Priya Patel", childAge: 10, notes: "Asthma inhaler in rucksack",
            parentPhone: "07700 900113", parentEmail: "priya@example.com", amountPaid: 170, paymentRef: "pi_ccc" }
        ]
      };
      s.classes.c3 = {
        id: "c3", providerId: "prov-B", name: "Other Provider — Week 1",
        week: "Week 1", ageBand: "5–12", futureDates: ["2026-07-20"],
        roster: [
          { childName: "Ethan S.", bookingAdult: "Tom Brennan", childAge: 8, notes: "",
            parentPhone: "07700 900114", parentEmail: "tom@example.com", amountPaid: 150, paymentRef: "pi_ddd" }
        ]
      };
      var added = addTeacher(s, "Jess Cover", "jess@example.com");
      s = added.state;
      s = assignClass(s, added.teacherId, "c1"); // assigned to c1 ONLY
      return { state: s, teacherId: added.teacherId, token: s.teachers[added.teacherId].token };
    }

    // ----- the limited login authenticates (fail-closed) -----
    check("A teacher login authenticates by its own token; bad tokens fail closed", function () {
      var f = fixture();
      HC.assert(authTeacher(f.state, f.token) !== null, "valid token resolves to the teacher");
      HC.assert(authTeacher(f.state, "not-a-real-token") === null, "unknown token is rejected");
      HC.assert(authTeacher(f.state, null) === null, "null token is rejected");
    });

    // ===== ACCEPTANCE CRITERION =====
    // "A teacher login sees ONLY assigned classes' print registers and NOTHING else."
    check("ACCEPTANCE: the login sees ONLY its assigned class's print register", function () {
      var f = fixture();
      var visibleIds = teacherVisibleClassIds(f.state, f.token);
      HC.assert(visibleIds.length === 1, "exactly one register is visible, got " + visibleIds.length);
      HC.assert(visibleIds[0] === "c1", "the one visible register is the assigned class c1, got " + visibleIds[0]);
      // Assigned class IS reachable...
      HC.assert(teacherRegister(f.state, f.token, "c1") !== null, "assigned class c1 register is returned");
      // ...every OTHER class (same provider AND other provider) is denied.
      HC.assert(teacherRegister(f.state, f.token, "c2") === null, "unassigned same-provider class c2 is DENIED");
      HC.assert(teacherRegister(f.state, f.token, "c3") === null, "other-provider class c3 is DENIED");
    });

    check("ACCEPTANCE: only the 'print-register' VIEW is permitted — every other surface is denied", function () {
      var f = fixture();
      // The one allowed combination:
      HC.assert(canTeacherSee(f.state, f.token, { view: TEACHER_VIEW, classId: "c1" }) === true,
        "print-register on the assigned class is allowed");
      // The same class, but ANY other provider surface → denied.
      for (var i = 0; i < PROVIDER_SURFACES.length; i++) {
        var v = PROVIDER_SURFACES[i];
        HC.assert(canTeacherSee(f.state, f.token, { view: v, classId: "c1" }) === false,
          "view '" + v + "' must be denied to a teacher login even on an assigned class");
      }
      // print-register but on a class they're NOT assigned to → denied.
      HC.assert(canTeacherSee(f.state, f.token, { view: TEACHER_VIEW, classId: "c2" }) === false,
        "print-register on an unassigned class is denied");
      // a request with no view / no class → denied.
      HC.assert(canTeacherSee(f.state, f.token, { classId: "c1" }) === false, "missing view denied");
      HC.assert(canTeacherSee(f.state, f.token, { view: TEACHER_VIEW }) === false, "missing classId denied");
      HC.assert(canTeacherSee(f.state, f.token, null) === false, "null request denied");
    });

    check("ACCEPTANCE: a register handed to a teacher carries ONLY whitelisted fields — no contact/payment data", function () {
      var f = fixture();
      var reg = teacherRegister(f.state, f.token, "c1");
      HC.assert(reg && reg.rows && reg.rows.length === 2, "c1 register has its 2 children");
      reg.rows.forEach(function (row) {
        // present: the teacher-visible fields
        HC.assert(Object.prototype.hasOwnProperty.call(row, "childName"), "row keeps childName");
        HC.assert(Object.prototype.hasOwnProperty.call(row, "bookingAdult"), "row keeps bookingAdult (the booking adult)");
        HC.assert(Object.prototype.hasOwnProperty.call(row, "childAge"), "row keeps childAge");
        HC.assert(Object.prototype.hasOwnProperty.call(row, "notes"), "row keeps SEN/allergy notes");
        // absent: every sensitive field
        SENSITIVE_FIELDS.forEach(function (sf) {
          HC.assert(!Object.prototype.hasOwnProperty.call(row, sf),
            "row must NOT expose '" + sf + "' to a teacher");
        });
      });
      // The SEN/allergy note specifically survives (evidence: teachers see SEN/allergy notes).
      HC.assert(reg.rows[0].notes === "Nut allergy — EpiPen in bag", "the allergy note is visible to the teacher");
    });

    // ----- assignment changes flow straight through the gate -----
    check("Ticking a second class adds exactly that register; unticking removes it", function () {
      var f = fixture();
      var s = assignClass(f.state, f.teacherId, "c2"); // now leads c1 + c2
      var ids = teacherVisibleClassIds(s, f.token).sort();
      HC.assert(ids.join(",") === "c1,c2", "after assigning c2, both c1 and c2 are visible, got " + ids.join(","));
      HC.assert(teacherRegister(s, f.token, "c3") === null, "c3 (other provider) is still denied");
      // untick c1
      var s2 = unassignClass(s, f.teacherId, "c1");
      var ids2 = teacherVisibleClassIds(s2, f.token);
      HC.assert(ids2.length === 1 && ids2[0] === "c2", "after unticking c1, only c2 remains, got " + ids2.join(","));
    });

    check("Assignment functions are pure — the original state is never mutated", function () {
      var f = fixture();
      var before = teacherVisibleClassIds(f.state, f.token).join(",");
      assignClass(f.state, f.teacherId, "c2"); // discard result
      var after = teacherVisibleClassIds(f.state, f.token).join(",");
      HC.assert(before === after, "calling assignClass did not mutate the original (was " + before + ", now " + after + ")");
    });

    // ----- revoked teacher loses everything (fail-closed) -----
    check("Revoking the teacher closes the login entirely — no register at all", function () {
      var f = fixture();
      var s = revokeTeacher(f.state, f.teacherId);
      HC.assert(authTeacher(s, f.token) === null, "a revoked teacher no longer authenticates");
      HC.assert(teacherVisibleRegisters(s, f.token).length === 0, "a revoked login sees zero registers");
      HC.assert(canTeacherSee(s, f.token, { view: TEACHER_VIEW, classId: "c1" }) === false,
        "even the previously-assigned class is now denied");
    });

    // ----- multiple teachers stay isolated from each other -----
    check("Two teachers each see ONLY their own assigned class — never each other's", function () {
      var f = fixture(); // Jess -> c1
      var addB = addTeacher(f.state, "Marcus Relief", "marcus@example.com");
      var s = addB.state;
      s = assignClass(s, addB.teacherId, "c2"); // Marcus -> c2
      var jessToken = f.token;
      var marcusToken = s.teachers[addB.teacherId].token;

      var jessIds = teacherVisibleClassIds(s, jessToken);
      var marcusIds = teacherVisibleClassIds(s, marcusToken);
      HC.assert(jessIds.join(",") === "c1", "Jess sees only c1, got " + jessIds.join(","));
      HC.assert(marcusIds.join(",") === "c2", "Marcus sees only c2, got " + marcusIds.join(","));
      // Cross-checks: neither can open the other's class.
      HC.assert(teacherRegister(s, jessToken, "c2") === null, "Jess cannot open Marcus's class c2");
      HC.assert(teacherRegister(s, marcusToken, "c1") === null, "Marcus cannot open Jess's class c1");
    });

    // ----- "all future dates for that weekly slot" (evidence 4147796) -----
    check("The print register lists ALL future dates for the class's weekly slot", function () {
      var f = fixture();
      var reg = teacherRegister(f.state, f.token, "c1");
      HC.assert(reg.futureDates.length === 2, "c1 carries its 2 future dates");
      HC.assert(reg.futureDates[0] === "2026-07-20", "future dates are passed through to the teacher view");
    });

    // ----- defensive -----
    check("Defensive: bad inputs never throw and always fail closed", function () {
      HC.assert(canTeacherSee(emptyState(), "x", { view: TEACHER_VIEW, classId: "c1" }) === false,
        "empty state denies everything");
      HC.assert(teacherRegister(null, null, null) === null, "null everything -> null register, no throw");
      HC.assert(teacherVisibleRegisters(emptyState(), null).length === 0, "no teachers -> no registers");
      HC.assert(assignClass(emptyState(), "nope", "nope") && typeof assignClass(emptyState(), "nope", "nope") === "object",
        "assigning with bad ids is a safe no-op object");
      // stripping a non-object row yields {} rather than throwing
      HC.assert(JSON.stringify(teacherSafeRow(null)) === "{}", "teacherSafeRow(null) is {}");
    });

    // ----- persistence round-trip through HC.store -----
    check("Teacher access state persists via HC.store and the gate still holds after reload", function () {
      var f = fixture();
      var ok = HC.store.set(STORE_KEY, f.state);
      HC.assert(ok !== false, "store.set should succeed");
      var got = HC.store.get(STORE_KEY, null);
      HC.assert(got && got.teachers && got.classes, "state survives a store round-trip");
      var sameTeacher = teachersArr(got)[0];
      HC.assert(sameTeacher && sameTeacher.classIds.join(",") === "c1", "the assignment survives persistence");
      // The gate gives the same answer after reload: only c1, nothing else.
      var ids = teacherVisibleClassIds(got, sameTeacher.token);
      HC.assert(ids.length === 1 && ids[0] === "c1", "after reload the login still sees only c1");
      try { HC.store.remove ? HC.store.remove(STORE_KEY) : HC.store.set(STORE_KEY, null); } catch (e) {}
    });

    // ----- seed comes from the LIVE holiday-camp directory when present -----
    check("Demo seed draws classes from the live directory and assigns the teacher to ONE", function () {
      var seeded = seedFromProviders();
      var s = seeded.state;
      var teacher = teachersArr(s)[0];
      HC.assert(teacher, "seed produces a teacher with a limited login");
      HC.assert(teacher.classIds.length === 1, "seeded teacher is assigned exactly one class");
      HC.assert(classesArr(s).length >= 2, "seed creates more than one class so there is something to deny");
      // The teacher login sees ONLY its one assigned class — the acceptance criterion on live-shaped data.
      var ids = teacherVisibleClassIds(s, teacher.token);
      HC.assert(ids.length === 1, "the seeded login sees exactly its one assigned register, got " + ids.length);
      HC.assert(ids[0] === teacher.classIds[0], "and it is precisely the assigned class");
      // If the live directory loaded, the class maps to a real provider id.
      var ps = providers();
      if (ps.length) {
        var cls = s.classes[ids[0]];
        var found = ps.some(function (p) { return p && p.id === cls.providerId; });
        HC.assert(found, "the seeded assigned class maps to a real directory provider");
      }
    });

    return { pass: pass, fail: fail, log: log };
  }

  /* ---------------- register ---------------- */

  HC.registerFeature({
    id: "provider-teacher-access",
    title: "Share register with an external teacher",
    side: "provider",
    icon: "👩‍🏫",
    summary: "Just like Happity's Profile > Teachers: give an external camp leader a limited login that only ever opens " +
      "the Print register for the classes they lead — child names, booking adult, ages, and SEN / allergy notes — and " +
      "nothing else on your account. Parent contact and payment data never reach a teacher.",
    render: render,
    selfTest: selfTest
  });
})();
