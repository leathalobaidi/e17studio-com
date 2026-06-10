/*
 * E17 Holiday Camp Planner — structured enrichment layer.
 *
 * RULES FOR THIS FILE
 * - camps.js stays the verified source of truth and is never edited by the planner.
 * - Every field here is derived ONLY from the verified text already in camps.js
 *   or from the .firecrawl scrapes captured on 2026-06-09. Nothing is inferred.
 * - null / missing means "unknown — confirm with provider". The UI must say so.
 * - weeks: planner week numbers (1-6 + stub 7) the provider has CONFIRMED dates for.
 * - weeksLikely: provider runs summer camps but week-level dates are unconfirmed.
 * - price values are GBP numbers only where the source states an exact figure.
 * - *Basis strings are shown in the UI so parents can see where a number came from.
 */

window.E17_PLANNER = {
  updated: "2026-06-09",

  // Term dates from Waltham Forest Council "Holiday pattern" PDFs 2025-26 and
  // 2026-27 (downloaded and checked 9 June 2026).
  keyDates: {
    lastSchoolDay: { iso: "2026-07-20", label: "Mon 20 July 2026", note: "Last school day for most Waltham Forest schools (some take it as INSET — check yours)." },
    holidayStart: { iso: "2026-07-21", label: "Tue 21 July 2026" },
    bankHoliday: { iso: "2026-08-31", label: "Mon 31 August 2026" },
    backToSchool: { iso: "2026-09-02", label: "Wed 2 September 2026", note: "Tue 1 Sep is a closure/INSET day on the council calendar — most children return Wed 2 Sep. Confirm your school." },
    octoberHalfTerm: { label: "Mon 26 – Fri 30 October 2026" },
    source: { label: "Waltham Forest Council holiday pattern 2025-26 / 2026-27", url: "https://www.walthamforest.gov.uk/schools-education-and-learning/school-term-and-closure-dates/school-holiday-and-term-dates" }
  },

  weeks: [
    { id: 1, label: "Week 1", dates: "Mon 20 – Fri 24 July", mon: "2026-07-20", days: 5,
      note: "Mon 20 July is the last school day for most WF schools, so many families only need Tue–Fri. Camps run the full week — independent schools have already broken up." },
    { id: 2, label: "Week 2", dates: "Mon 27 – Fri 31 July", mon: "2026-07-27", days: 5, note: "" },
    { id: 3, label: "Week 3", dates: "Mon 3 – Fri 7 August", mon: "2026-08-03", days: 5, note: "" },
    { id: 4, label: "Week 4", dates: "Mon 10 – Fri 14 August", mon: "2026-08-10", days: 5, note: "" },
    { id: 5, label: "Week 5", dates: "Mon 17 – Fri 21 August", mon: "2026-08-17", days: 5, note: "" },
    { id: 6, label: "Week 6", dates: "Mon 24 – Fri 28 August", mon: "2026-08-24", days: 5, note: "" },
    { id: 7, label: "Final stretch", dates: "Mon 31 Aug – Tue 1 Sep", mon: "2026-08-31", days: 2, stub: true,
      note: "Mon 31 Aug is a bank holiday and most WF schools return Wed 2 Sep — for most families only Tue 1 Sep needs cover. Few camps publish dates for this week; check directly." }
  ],

  byId: {
    "waltham-forest-haf": {
      plannerRole: "route",
      weeksLikely: true,
      weeksBasis: "HAF programmes run each school holiday; summer sessions appear on the Eequ feed closer to the holiday.",
      haf: true
    },

    "ymca-y-kidz": {
      weeks: [2, 3, 4, 5],
      weeksBasis: "Provider page lists themed weeks: Colour & Neon Mon 27–31 Jul, Emoji Mon 3–7 Aug, Fantasy Kingdom Mon 10–14 Aug, Under the Sea Mon 17–21 Aug.",
      price: { day: 36, dayExtended: 41 },
      priceBasis: "From £36 standard day (10:00–16:00) / £41 extended day (8:30–17:30) on the provider page.",
      hours: { start: "10:00", end: "16:00", extStart: "08:30", extEnd: "17:30" },
      coverage: "working",
      vouchers: true, tfc: true,
      lunch: { policy: "check", note: "Food arrangements not stated on the page checked — ask when booking." }
    },

    "lloyd-park-childrens-charity": {
      weeksLikely: true,
      weeksBasis: "Runs every school holiday from Lloyd Park and Higham Hill centres; week list and fees are on the provider's booking page.",
      hours: { start: "08:00", end: "17:50" },
      coverage: "working",
      sendAware: true
    },

    "church-hill-playscheme": {
      weeksLikely: true,
      weeksBasis: "School-run playscheme each holiday; return the booking form to the school office for summer weeks.",
      price: { day: 49, dayExtended: 65 },
      priceBasis: "Daytime day £49; whole day (8:00–18:00) £65; breakfast/tea add-ons — from the school page.",
      hours: { start: "08:00", end: "18:00" },
      coverage: "working",
      earlyYears: true
    },

    "mission-grove": {
      weeksLikely: true,
      weeksBasis: "School page links a live Summer 2026 application, and 'Mission Grove Summer Holiday Club 2026' appears on the Eequ HAF feed.",
      haf: true,
      lunch: { policy: "buy", note: "Cooked lunch listed at £3/day on the school page (HAF places include food)." }
    },

    "active-london": {
      weeksLikely: true,
      weeksBasis: "Runs WF holiday clubs every holiday across multiple sites — summer venues/dates appear on iPAL closer to the holiday.",
      haf: true
    },

    "360-active": {
      weeks: [3, 4],
      weeksBasis: "ClassForKids lists Mon 3 – Thu 6 Aug and Mon 10 – Thu 13 Aug 2026 (4-day weeks, Mon–Thu).",
      daysPerWeek: { "3": 4, "4": 4 },
      hours: { start: "10:00", end: "14:00" },
      coverage: "short",
      siblingDiscount: true
    },

    "ptc-sports-henry-maynard": {
      weeksLikely: true,
      weeksBasis: "Latest confirmed ClassForKids listing was May half-term (Mon 25–Fri 29 May, £120/wk, £32/day). Summer weeks not yet published when checked — watch the booking page.",
      price: { day: 32, week: 120 },
      priceBasis: "May 2026 half-term listing — treat as a guide for summer pricing.",
      priceStale: "May 2026 listing",
      hours: { start: "09:00", end: "17:00" },
      coverage: "standard"
    },

    "time-for-change-kids": {
      weeksLikely: true,
      weeksBasis: "Summer holiday club booking is live on Pembee; pick exact days/weeks there. Site states 8:00–18:00 with early drop-off and late pickup add-ons.",
      hours: { start: "08:00", end: "18:00" },
      coverage: "working",
      ofsted: true,
      haf: true,
      lunch: { policy: "buy", note: "Lunch and snacks listed as add-ons on the booking page." }
    },

    "future-stars-walthamstow": {
      weeksLikely: true,
      weeksBasis: "Runs full-day camps each holiday at Match Day Centres; the dated listing checked was May half-term — confirm summer weeks on ClassForKids.",
      price: { day: 36, week: 144, halfDay: 18 },
      priceBasis: "May 2026 listing: £36 day / £144 week / £18 half-day.",
      priceStale: "May 2026 listing",
      hours: { start: "08:00", end: "18:00" },
      coverage: "working"
    },

    "wo-sports": {
      weeksLikely: true,
      weeksBasis: "Recurring WF holiday programmes (paid + HAF); summer venues and dates go live on their booking site.",
      haf: true,
      coverage: "varies"
    },

    "all-about-dance": {
      weeks: [1, 2, 3, 4, 5],
      weeksBasis: "Camps page lists 20–24 Jul, 27–31 Jul, then Week 3: 3 Aug, Week 4: 10 Aug, Week 5: 17 Aug. Page also carries some stale older blocks — reconfirm your week before booking.",
      reconfirm: true,
      haf: true,
      hours: { start: "10:00", end: "15:00", extStart: "09:00", extEnd: "17:00" },
      coverage: "standard"
    },

    "gravity-performing-arts": {
      weeks: [1, 2, 4],
      weeksBasis: "ClassForKids lists Week 1 Mon 20–Fri 24 Jul, Week 2 Mon 27–31 Jul and Mon 10–14 Aug 2026, each split into ages 5–6 and 7–16.",
      price: { day: 40, week: 180 },
      priceBasis: "A current Gravity ClassForKids camp page shows £180/week and £40/day — confirm for your week and age band.",
      coverage: "standard"
    },

    "mother-nature-science-walthamstow": {
      weeks: [1, 2, 3, 4, 5, 6],
      weeksBasis: "NE London summer camp lists Weeks C–H: Mon 20 Jul – Fri 28 Aug 2026 (plus earlier weeks from 6 Jul). Confirm Walthamstow School for Girls shows your week in the booking form — weeks not shown for a venue aren't scheduled there.",
      reconfirm: true,
      price: { week: 345 },
      priceBasis: "£345 full week on the 2026 NE London summer listing; confirm by venue/week.",
      hours: { start: "09:00", end: "15:30", extStart: "08:30", extEnd: "16:00" },
      coverage: "standard",
      vouchers: true
    },

    "the-strings-club-walthamstow": {
      weeks: [6],
      weeksBasis: "Both Minis and Strum Stars Walthamstow camps are listed for w/c 24 August 2026.",
      price: { day: 61.5, dayExtended: 71.5 },
      priceBasis: "2026 listing: £61.50 standard day (9:30–16:00) / £71.50 extended day (8:00–17:30).",
      hours: { start: "09:30", end: "16:00", extStart: "08:00", extEnd: "17:30" },
      coverage: "working",
      tfc: true, vouchers: true,
      screenFree: true
    },

    "football-fun-factory": {
      weeksLikely: true,
      weeksBasis: "Holiday camps run 9:00–15:30 in school holidays; summer dates via the location page.",
      hours: { start: "09:00", end: "15:30" },
      coverage: "standard"
    },

    "little-soccer-stars-walthamstow": {
      weeks: [1, 2, 3, 4, 5, 6],
      weeksBasis: "2026 booking feed lists Walthamstow Lloyd Park summer dates from 20 July to 26 August (final week runs Mon–Wed only).",
      daysPerWeek: { "6": 3 },
      price: { day: 32.5 },
      priceBasis: "£32.50/day on the 2026 summer booking feed.",
      hours: { start: "09:15", end: "15:15" },
      coverage: "standard"
    },

    "leyton-orient-trust": {
      weeksLikely: true,
      weeksBasis: "Camps each school holiday at Peter May / SCORE centres; summer announcement and HAF places appear nearer the holiday.",
      haf: true,
      coverage: "varies"
    },

    "camp-beaumont-woodbridge": {
      weeksLikely: true,
      weeksBasis: "Large commercial camp running through the summer holidays — pick exact weeks on the Camp Beaumont booking site.",
      hours: { start: "08:30", end: "17:30" },
      coverage: "working",
      teen: true
    },

    "barracudas-woodford": {
      weeksLikely: true,
      weeksBasis: "Runs through the summer at Woodford County High School — live availability and week prices on the Barracudas site.",
      hours: { start: "08:30", end: "17:30", extStart: "08:00", extEnd: "18:00" },
      coverage: "working",
      tfc: true, vouchers: true, siblingDiscount: true
    },

    "break-tha-cycle": {
      weeksLikely: true,
      weeksBasis: "HAF-linked community club at Leytonstone School — summer sessions via Break tha Cycle / HAF routes.",
      haf: true, sendAware: true,
      lunch: { policy: "included", note: "Hot meals advertised as part of the club." }
    },

    "yellow-birds": {
      weeksLikely: true,
      weeksBasis: "Holiday club provider in Chingford/WF — contact for summer weeks; public details sparse.",
      coverage: "varies"
    },

    "ultra-fc": {
      weeksLikely: true,
      weeksBasis: "Community football camps with Aim2Gain; confirm current summer timetable on the booking page.",
      coverage: "varies"
    },

    "art-k-highams-park": {
      sessionBased: true,
      weeksBasis: "Studio workshops on selected holiday dates rather than full camp weeks — check the art-K portal.",
      vouchers: true
    },

    "creation-station-walthamstow": {
      sessionBased: true,
      weeksBasis: "Creative sessions and holiday clubs on selected dates — check the local booking portal."
    },

    "cook-with-kasper": {
      sessionBased: true,
      weeksBasis: "Cooking classes (usually 90 min – 2 hrs) and holiday collaborations on selected dates — see Happity/Instagram.",
      earlyYears: true
    },

    "better-walthamstow-leisure-centre": {
      sessionBased: true,
      weeksBasis: "Per-session holiday activities (junior gym, gymnastics courses, drop-ins) rather than camp weeks — book per session.",
      price: { sessionFrom: 4.5, sessionTo: 15.6 },
      priceBasis: "Examples: gymnastics £15.60; some junior sessions free for junior prepaid members or £4.50 pay-and-play."
    },

    "shining-starz-walthamstow": {
      weeksLikely: true,
      weeksBasis: "Holiday camps advertised through social channels; one listing shows 8:30–12:30 mornings — confirm summer dates by DM/email.",
      hours: { start: "08:30", end: "12:30" },
      coverage: "short"
    },

    "chillie-kids-club": {
      weeks: [1, 2, 3, 4, 5, 6],
      weeksBasis: "Walthamstow club at Orford House runs Fridays only, 24 July – 28 August 2026, 9:00–15:00.",
      fridaysOnly: true,
      daysPerWeek: { "1": 1, "2": 1, "3": 1, "4": 1, "5": 1, "6": 1 },
      price: { day: 60 },
      priceBasis: "£60/day on the Walthamstow summer 2026 booking page.",
      hours: { start: "09:00", end: "15:00" },
      coverage: "standard"
    },

    "noisy-book-club-summer": {
      weeksLikely: true,
      weeksBasis: "Summer 2026 chapters run 10:00–15:00 on listed July and August dates (12 seats/day) — pick exact dates on the summer site and check the chapter's age band.",
      price: { day: 65 },
      priceBasis: "£65/day; chapter bundles £195–£270 on the summer 2026 page.",
      hours: { start: "10:00", end: "15:00" },
      coverage: "short",
      siblingDiscount: true,
      smallGroup: true
    },

    "showkids-walthamstow": {
      weeks: [1, 6],
      weeksBasis: "Summer 2026 ShowWeeks listed 20–24 July and 24–28 August, 9:00–16:00.",
      price: { weekByWeek: { "1": 295, "6": 265 } },
      priceBasis: "£295 for the July week; £265 for the August week (2026 Walthamstow listings).",
      hours: { start: "09:00", end: "16:00" },
      coverage: "standard",
      tfc: true, vouchers: true
    },

    "sylvestrian-leisure-holiday-activities": {
      weeksLikely: true,
      weeksBasis: "Runs long-day camps through the summer at Forest School; the dates page lists £246 five-day weeks and £197 four-day bank-holiday weeks — pick exact weeks on Pembee.",
      price: { week: 246, weekAlt: 197, weekAltLabel: "4-day bank-holiday week" },
      priceBasis: "Summer 2026 dates page: £246 five-day week / £197 four-day bank-holiday week.",
      hours: { start: "08:30", end: "17:30", extStart: "08:00", extEnd: "18:00" },
      coverage: "working",
      ofsted: true,
      swimming: true
    },

    "perform-walthamstow-village": {
      weeks: [4],
      weeksBasis: "Peter Pan holiday course listed Mon 10 – Fri 14 August 2026, 10:00–15:00, ages 4–10.",
      hours: { start: "10:00", end: "15:00" },
      coverage: "short"
    },

    "stagecoach-chingford-walthamstow": {
      weeks: [2],
      weeksBasis: "Summer 2026 workshop week listed 27–31 July: Little Performers (4–7) 9:30–12:30; Magical Musicals (6–16) 10:00–16:00 Mon–Thu, to 19:00 Friday.",
      price: { weekBands: [ { band: "Ages 4–7 (mornings)", week: 150 }, { band: "Ages 6–16 (full days)", week: 199 } ] },
      priceBasis: "Summer 2026 listings: £150 (ages 4–7) / £199 (ages 6–16); sibling discounts listed.",
      hours: { start: "10:00", end: "16:00" },
      coverage: "standard",
      tfc: true, vouchers: true, siblingDiscount: true
    },

    "act-out-walthamstow": {
      weeksLikely: true,
      weeksBasis: "Holiday workshops run Mon–Fri 10:00–16:00 with a 9:00 drop-off option — confirm summer week dates on the booking links.",
      hours: { start: "10:00", end: "16:00", extStart: "09:00", extEnd: "16:00" },
      coverage: "standard",
      ofsted: true, tfc: true, vouchers: true
    },

    "study-right-stem": {
      weeksLikely: true,
      weeksBasis: "HAF-funded STEM club — summer sessions appear on the Eequ feed when the programme opens.",
      haf: true
    },

    "upscill-tech-bootcamp": {
      weeksLikely: true,
      weeksBasis: "The checked listing was Easter 2026 (6 sessions, £170 full / £90 three days) — watch for the summer bootcamp date.",
      price: { week: 170, weekAlt: 90, weekAltLabel: "3-day option" },
      priceBasis: "Easter 2026 listing — treat as a guide.",
      priceStale: "Easter 2026 listing",
      coverage: "varies"
    },

    "sck-martial-arts": {
      weeksLikely: true,
      weeksBasis: "HAF-funded martial arts camp — summer sessions appear on the Eequ feed when the programme opens.",
      haf: true
    }
  }
};
