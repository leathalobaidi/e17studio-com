/*
 * E17 Holiday Camp Planner — structured enrichment layer.
 *
 * RULES FOR THIS FILE
 * - camps.js stays the verified source of truth and is never edited by the planner.
 * - Every field here is derived ONLY from the verified text already in camps.js
 *   or from the .firecrawl scrapes captured on 2026-06-09/10. Nothing is inferred.
 * - null / missing means "unknown — confirm with provider". The UI must say so.
 * - weeks: planner week numbers (1-6 + stub 7) the provider has CONFIRMED dates for.
 * - weeksLikely: provider runs summer camps but week-level dates are unconfirmed.
 * - price values are GBP numbers only where the source states an exact figure.
 * - *Basis strings are shown in the UI so parents can see where a number came from.
 */

window.E17_PLANNER = {
  updated: "2026-07-04",

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
      weeksBasis: "HAF programmes run each school holiday; Summer 2026 bookings opened at 9am on Monday 22 June and are live now on Eequ — eligible children get up to 8 sessions this summer (checked 2 Jul 2026).",
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
      weeksBasis: "Runs every school holiday from Lloyd Park and Higham Hill centres; Summer 2026 bookings opened 9am Mon 15 June and are live now — apply through the booking page (checked 2 Jul 2026).",
      price: { day: 48.3 },
      priceBasis: "£48.30 per day on the charity's fees page (checked 10 Jun 2026); one-off £24.08 registration fee also listed.",
      hours: { start: "08:00", end: "17:50" },
      coverage: "working",
      sendAware: true
    },

    "church-hill-playscheme": {
      weeks: [1, 2, 3, 4, 5],
      daysPerWeek: { "1": 4 },
      dayPattern: { "1": [2, 3, 4, 5] },
      weeksBasis: "Summer 2026 booking form: Tue 21–Fri 24 Jul (4 days), then Mon–Fri weeks 27–31 Jul, 3–7 Aug, 10–14 Aug, 17–21 Aug. Last booking date Fri 10 July; minimum 2 days.",
      bookBy: "2026-07-10",
      price: { day: 49, dayExtended: 65 },
      priceBasis: "Summer 2026 booking form: £49 core day (9:00–16:00) / £65 full day (8:00–18:00); breakfast £7, tea £14.",
      hours: { start: "09:00", end: "16:00", extStart: "08:00", extEnd: "18:00" },
      coverage: "working",
      earlyYears: true,
      tfc: true, vouchers: true,
      lunch: { policy: "bring", note: "Packed lunch needed — the nursery does not provide lunch. Tea is cooked on site for the 4–6pm block." }
    },

    "mission-grove": {
      weeks: [1, 2, 3, 4],
      weeksBasis: "School application form: Mon 20 July for four weeks until Fri 14 August 2026, booked day by day. 'Mission Grove Summer Holiday Club 2026' is also on the Eequ HAF feed.",
      price: { day: 25 },
      priceBasis: "£25 per day on the Summer 2026 application form; extra hours (7:45–8:45am / 4:45–5:45pm) £5 each; some trips £15 extra (ages 5+).",
      hours: { start: "08:45", end: "16:45", extStart: "07:45", extEnd: "17:45" },
      coverage: "working",
      haf: true,
      lunch: { policy: "buy", note: "Cooked lunch £3/day on the application form, or bring a packed lunch (HAF places include food)." }
    },

    "active-london": {
      weeksLikely: true,
      weeksBasis: "Runs WF holiday clubs every holiday across multiple sites (clubs page lists Thorpe Hall Primary) — summer weeks sit behind the iPAL booking login (checked 10 Jun 2026).",
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
      weeks: [1, 2, 3, 4, 5],
      weeksBasis: "ClassForKids summer listings (checked 2 Jul 2026): Gwyn Jones Primary (camp/117) five Mon–Fri weeks, 20 Jul – 21 Aug 2026, 9:00–4:30; a Henry Maynard Infants Site listing (camp/118) is now also live for the same five weeks, 9:00–5:00 — both bookable.",
      price: { day: 30, week: 140 },
      priceBasis: "Summer 2026 ClassForKids listings (checked 2 Jul 2026): Gwyn Jones £140 full week / £30 single day (the figures shown here); Henry Maynard Infants Site £150 full week / £32 single day.",
      hours: { start: "09:00", end: "16:30" },
      coverage: "standard",
      lunch: { policy: "bring", note: "Packed lunch needed (no nut content) plus a refillable water bottle." }
    },

    "future-stars-walthamstow": {
      weeks: [1, 2, 3, 4, 5, 6],
      weeksBasis: "Summer 2026 ClassForKids listings (camps 95-98, checked 2 Jul 2026): Weeks 1-6, Mon 20 Jul – Fri 28 Aug 2026 at Match Day Centres — full day 8am-6pm plus early (8-10am), main (10am-3pm) and late (3-6pm) sessions; the full-day option showed 'Limited Spaces Available'.",
      price: { day: 40, week: 160, halfDay: 20 },
      priceBasis: "Summer 2026 ClassForKids listings (checked 2 Jul 2026): full day £40/day or £160/week; main session 10am-3pm (shown as half-day) £20/day or £80/week; early or late sessions £10/day or £40/week.",
      hours: { start: "08:00", end: "18:00" },
      coverage: "working"
    },

    "wo-sports": {
      weeks: [1, 2, 3, 4, 5, 6, 7],
      weeksBasis: "Summer 2026 camps listed on bookings.wo-sports.co.uk (checked 2 Jul 2026): George Tomlinson multi-sports 20/07–21/08 (weeks 1-5), Score Leyton football 20/07–28/08 (weeks 1-6), Woodside multi-sports/football 20/07–21/08 (weeks 1-5), Leytonstone Leisure Centre multi-sports/swimming 24/08–01/09 (week 6 into the final stretch — check the bank-holiday Monday directly) and St Joseph's Catholic Junior 24–28/08 (week 6). Availability 'Good' or 'Limited' by venue; no prices in the list view. HAF camps at Woodside and George Tomlinson are on the Eequ feed.",
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
      weeksBasis: "NE London summer camp booking form shows all six Walthamstow School for Girls weeks (C–H, Mon 20 Jul – Fri 28 Aug 2026), each in stock and purchasable when checked 2 Jul 2026.",
      price: { week: 395 },
      priceBasis: "£395 per full week on the booking form for all six Walthamstow School for Girls weeks (checked 2 Jul 2026 — supersedes the £345 seen on the earlier check); extended hours +£10/day; multi-week/sibling basket discounts.",
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
      weeks: [2, 3, 4, 5, 6],
      daysPerWeek: { "2": 4, "3": 4, "4": 4, "5": 4, "6": 4 },
      weeksBasis: "Official soccer-schools listing: five Mon–Thu summer weeks at Roding Valley High School (27–30 Jul, 3–6 Aug, 10–13 Aug, 17–20 Aug, 24–27 Aug), 10am–3pm, ages 6–13. No Peter May/SCORE summer camp announced when checked 10 Jun; HAF places via Eequ.",
      price: { week: 100 },
      priceBasis: "£100 per Mon–Thu week on the official soccer-schools summer listings.",
      hours: { start: "10:00", end: "15:00" },
      haf: true,
      coverage: "short"
    },

    "camp-beaumont-woodbridge": {
      weeksLikely: true,
      weeksBasis: "Large commercial camp running through the summer holidays — week-by-week dates and prices only show inside the booking flow (checked 10 Jun 2026).",
      hours: { start: "08:30", end: "17:30" },
      coverage: "working",
      teen: true
    },

    "barracudas-woodford": {
      weeksLikely: true,
      weeksBasis: "Booking open for Summer 2026 at Woodford County High School — live Prices & Availability widget shows week 20-24 Jul 'Limited' throughout and week 27-31 Jul mixed 'Available'/'Limited'; SIBLING10 saves £5/day for 2+ children over 10+ days (checked 4 Jul 2026).",
      price: { week: 259, day: 59 },
      priceBasis: "£259 full week or £59 single day on the Barracudas Prices & Availability widget (checked 4 Jul 2026); SIBLING10 saves £5/day for 2+ children over 10+ days.",
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
      weeksBasis: "Community football camps with Aim2Gain — but as of 4 Jul 2026 no summer 2026 holiday camp dates or booking are live on the site (only an 'UPCOMING EVENT! Be the first to know!' email sign-up; book-online lists only football trials/team programmes). Contact the provider to check whether summer camps will run.",
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
      weeks: [1, 2, 3, 4, 7],
      daysPerWeek: { "1": 4, "2": 3, "3": 4, "7": 1 },
      dayPattern: { "1": [1, 2, 3, 4], "2": [1, 2, 3], "3": [2, 3, 4, 5], "7": [2] },
      weeksBasis: "Summer 2026 chapters (12 seats/day, 10am–3pm, checked 2 Jul 2026): Ch1 Art & Growth Mindset Mon–Thu 20–23 Jul (£260, FULL — waiting list), Ch2 Making Mon–Wed 27–29 Jul (£195, 6 seats left), Ch3 Making Tue–Fri 4–7 Aug (£260, 7 seats), Ch4 content-TBD Mon–Fri 10–14 Aug (not yet bookable — register interest; now listed ages 5–11), plus 2-day Back to Brave chapters Tue–Wed 1–2 Sep (3 seats; Tue 1 Sep is the final-stretch cover day) and Thu–Fri 3–4 Sep (6 seats). Odd single days run a waiting list.",
      price: { day: 65 },
      priceBasis: "£65/day; chapter prices £260 (4 days), £195 (3 days), £130 (2-day Sept chapters); 2nd & 3rd child 5% off (checked 2 Jul 2026).",
      hours: { start: "10:00", end: "15:00" },
      coverage: "short",
      siblingDiscount: true,
      smallGroup: true,
      lunch: { policy: "bring", note: "Packed lunch and water bottle daily; healthy fruit/veg snacks provided." }
    },

    "showkids-walthamstow": {
      weeks: [1, 6],
      weeksBasis: "Summer 2026 ShowWeeks listed 20–24 July and 24–28 August, 9:00–16:00. The 20–24 July week is SOLD OUT; the 24–28 August week was still open when checked 2 Jul 2026.",
      price: { weekByWeek: { "1": 295, "6": 265 } },
      priceBasis: "£295 for the July week; £265 for the August week (2026 Walthamstow listings).",
      hours: { start: "09:00", end: "16:00" },
      coverage: "standard",
      tfc: true, vouchers: true
    },

    "sylvestrian-leisure-holiday-activities": {
      weeks: [1, 2, 3, 4, 5, 6],
      weeksBasis: "Pembee lists eight Summer Camp weeks, Mon 6 Jul – Fri 28 Aug 2026 (planner weeks 1–6 = camp weeks 3–8). On 2 Jul only the 13–17 Jul week still showed 'Places available'; the 6–10 Jul week and all six school-holiday weeks showed 'Waitlist available' — join waitlists promptly.",
      price: { week: 246 },
      priceBasis: "£246 five-day week on the dates page; all eight summer weeks are five-day (the £197 rate applies only to four-day bank-holiday weeks, none this summer). Early/late add-ons £4 each; £15/week sibling discount.",
      hours: { start: "08:30", end: "17:30", extStart: "08:00", extEnd: "18:00" },
      coverage: "working",
      ofsted: true,
      swimming: true,
      siblingDiscount: true
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

    "vestry-school-of-dance": {
      weeks: [1, 6],
      weeksBasis: "Provider news page lists Summer School Week 1: 20–24 July and Week 2: 24–28 August 2026 — 'a few places left on both weeks' when checked 10 Jun. Hours, price and venue: contact the school.",
      coverage: "varies"
    },

    "study-right-stem": {
      weeksLikely: true,
      weeksBasis: "HAF-funded STEM club — as of 4 Jul 2026 the Eequ listing shows 'Next date: None - Register your interest', so no summer 2026 sessions are dated/bookable yet; listing shows a paid Non-HAF ticket at £30/session alongside free HAF places for eligible FSM children.",
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
    },

    "petite-productions": {
      weeks: [2, 3, 4, 5, 6],
      weeksBasis: "Director confirmed (email + flyer, 12 Jun 2026) the workshops run all five summer weeks at both Highams Park and Blackhorse Road: The SpongeBob Musical 27–31 Jul (week 2), Backstage to the Future 3–7 Aug (week 3), Uniquely Me 10–14 Aug (week 4), Seussical the Musical 17–21 Aug (week 5) and Broadway Beach Bash 24–28 Aug (week 6). 9am–4pm Mon–Fri; 3-day tickets also offered.",
      price: { day: 45, week: 225 },
      priceBasis: "£45/day, £225 for the full Mon–Fri week, £135 for a 3-day ticket, £405 sibling rate; flexible payments (director email + flyer, 12 Jun 2026).",
      hours: { start: "09:00", end: "16:00" },
      coverage: "standard"
    },

    "ryan-fc-girls": {
      weeks: [2, 3, 4],
      weeksBasis: "Sign-up form lists three girls-only weeks at Matchday Centres (E17 4LL, Pitch 10), ages 6-11, 9am–3pm: 27–31 Jul (week 2), 3–7 Aug (week 3), 10–14 Aug (week 4). Single days bookable.",
      price: { day: 30, week: 130 },
      priceBasis: "£30 per day or £130 for the full 5-day week (sign-up form, checked 12 Jun 2026).",
      hours: { start: "09:00", end: "15:00" },
      coverage: "standard",
      lunch: { policy: "bring", note: "Bring a packed lunch and a water bottle; astro surface, so suitable footwear." }
    },

    "myths-maps-monsters": {
      weeks: [1],
      weeksBasis: "Tickettailor lists a single 3-day camp in week 1 - 'The Labours of Heracles', Tue 21, Wed 22, Thu 23 July 2026, ages 5-11, 9.30am–3.30pm. The Tickettailor event showed 'Sold out' when checked 2 Jul 2026 — check for returns.",
      price: { day: 50, week: 135 },
      priceBasis: "£50/day or £135 for the three days (9.30am–3.30pm). Early drop-off from 8.30am: £60/day or £165 for three days. Limited low-income tickets £20/day on an honesty basis (Tickettailor, checked 14 Jun 2026).",
      daysPerWeek: 3,
      dayPattern: { "1": [2, 3, 4] },
      hours: { start: "09:30", end: "15:30", extStart: "08:30" },
      coverage: "standard"
    },

    "wee-movers-holiday": {
      weeks: [1, 2, 3],
      weeksBasis: "Creative Holiday Schools page lists three summer 2026 weeks at St Joseph's Infant School, Leyton (E10 7BL), ages 4-10, 10am–4pm: Mon 20–24 Jul (week 1), Mon 27–31 Jul (week 2), Mon 3–7 Aug (week 3). Full-week booking only.",
      price: { week: 318 },
      priceBasis: "£318 for the 5-day week incl. daily lunch (Deeney's) + afternoon snack; sibling discount (SUMMERSIBLING2026); packed-lunch option saves £6/day (NOLUNCHSUMMER). Subsidised places on request (provider page + week-one product, 14 Jun 2026).",
      hours: { start: "10:00", end: "16:00", extStart: "09:00", extEnd: "17:00" },
      coverage: "standard",
      sendAware: true,
      lunch: { policy: "included", note: "Daily lunch (Deeney's) and afternoon snack included; vegetarian or meat, free from nuts, sesame and raw egg. Bring your own to save £6/day." }
    },

    "make-it-do-it": {
      weeks: [2, 3, 6],
      weeksBasis: "Provider email, Linktree and summer flyers: three 4-day camps at Good Shepherd Studios, Leytonstone - 'Future Nature' Mon 27-Thu 30 Jul (week 2) and Mon 3-Thu 6 Aug (week 3), 'Colour Lab' Mon 24-Thu 27 Aug (week 6). Mon-Thu only.",
      price: { week: 220 },
      priceBasis: "£220 per 4-day camp (standard); £200 subsidised/sibling; optional wrap-around to 4.30pm £8/child (Linktree + provider email, 14 Jun 2026).",
      daysPerWeek: 4,
      dayPattern: { "2": [1, 2, 3, 4], "3": [1, 2, 3, 4], "6": [1, 2, 3, 4] },
      hours: { start: "09:30", end: "15:30", extEnd: "16:30" },
      coverage: "standard",
      lunch: { policy: "bring", note: "No lunch provided - bring a packed lunch and snacks." }
    },

    "infinite-jest": {
      weeks: [3],
      weeksBasis: "Provider confirmed (email 15 Jun 2026) one summer 2026 week at Cornerstone Church, Leyton (E10 6EH), ages 5-11: 'By the Seaside' Mon 3 - Fri 7 August, 9.30am-3.30pm. SOLD OUT on Pebble (zero spots on every date, no waitlist) when checked 2 Jul 2026.",
      price: { day: 43 },
      priceBasis: "£43 per day (5-day week = £215); sibling rate £38/day; Tax-Free Childcare accepted (provider email, 15 Jun 2026).",
      hours: { start: "09:30", end: "15:30", extStart: "08:30", extEnd: "17:30" },
      coverage: "standard"
    },

    "mb-summer-tottenham": {
      weeks: [1, 2, 3, 6],
      weeksBasis: "MB Community CIC email (June 2026): four 4-day weeks at Harris Academy Tottenham (N17 9LN) - Tue 21-Fri 24 Jul (week 1), Mon 27-Thu 30 Jul (week 2), Mon 3-Thu 6 Aug (week 3), Mon 24-Thu 27 Aug (week 6), 9.30am-3.30pm.",
      daysPerWeek: { "1": 4, "2": 4, "3": 4, "6": 4 },
      dayPattern: { "1": [2, 3, 4, 5], "2": [1, 2, 3, 4], "3": [1, 2, 3, 4], "6": [1, 2, 3, 4] },
      price: { day: 15 },
      priceBasis: "£15 per day; extended provision 3.30-5.00pm adds £7; hot meal £5; sibling, full-week and early-bird discounts; free HAF places for eligible FSM children (MB Community CIC email, June 2026).",
      hours: { start: "09:30", end: "15:30", extEnd: "17:00" },
      coverage: "standard",
      haf: true,
      tfc: false,
      siblingDiscount: true,
      lunch: { policy: "buy", note: "Hot meal £5/day, or bring a packed lunch; HAF places include food." }
    },

    "mb-summer-chingford": {
      weeks: [4, 5],
      weeksBasis: "MB Community CIC email (June 2026): two 4-day weeks at Salisbury Manor Primary, Chingford (E4 8YJ) - Mon 10-Thu 13 Aug (week 4) and Mon 17-Thu 20 Aug (week 5), 9.30am-3.30pm. Same provider as the Easter HAF camp at this Burnside Avenue venue.",
      daysPerWeek: { "4": 4, "5": 4 },
      dayPattern: { "4": [1, 2, 3, 4], "5": [1, 2, 3, 4] },
      price: { day: 20 },
      priceBasis: "£20 per day; hot meal £5; sibling and full-week discounts; free HAF places for eligible FSM children (MB Community CIC email, June 2026).",
      hours: { start: "09:30", end: "15:30" },
      coverage: "standard",
      haf: true,
      tfc: false,
      siblingDiscount: true,
      lunch: { policy: "buy", note: "Hot meal £5/day, or bring a packed lunch; HAF places include food." }
    },

    "build-a-band-sing17": {
      weeks: [6],
      weeksBasis: "Registration form (Sing17, checked 17 Jun 2026): one 5-day project, Mon 24 - Fri 28 August 2026, 9am-4pm, at Greenleaf Road Baptist Church (E17 6QQ). Family showcase Fri 28 Aug at 3pm.",
      price: { week: 250 },
      priceBasis: "£250 per child for the full week; siblings half price; £50 non-refundable deposit, balance due 12 July 2026 (bank transfer). Limited concessionary lower-cost places on request by email, no evidence required (registration form, 17 Jun 2026).",
      hours: { start: "09:00", end: "16:00" },
      coverage: "standard",
      siblingDiscount: true,
      lunch: { policy: "bring", note: "Bring a packed lunch, drinks and snacks - no food provided." }
    }
  }
};
