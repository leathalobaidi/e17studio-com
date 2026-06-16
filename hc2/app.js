/* HolidayCamp mockup — Happity playbook + E17 planner, on live camp data.
   Sign-in & bookings are SIMULATED (localStorage). No backend, no real accounts/payments. */

const DIR = (window.E17_DIRECTORY && window.E17_DIRECTORY.providers) || [];
const PL  = (window.E17_PLANNER) || { byId:{}, weeks:[], keyDates:{} };
const WEEKS = PL.weeks || [];
const KEY = PL.keyDates || {};
const plannerOf = p => (PL.byId && PL.byId[p.id]) || {};

/* ---------- helpers ---------- */
const THEMES = [
  {k:["drama","theatre","perform"], e:"🎭", g:["#F0E8F4","#E5D2F0"]},
  {k:["dance","ballet"],            e:"💃", g:["#FCE8F0","#F7D2E6"]},
  {k:["art","craft","creative","make","fashion"], e:"🎨", g:["#FFF3D6","#FCE8C0"]},
  {k:["forest","outdoor","nature","adventure","sustain"], e:"🌲", g:["#E1F0E4","#CDE7D6"]},
  {k:["music","sing","song"],       e:"🎵", g:["#E6EEFB","#D5E4F7"]},
  {k:["science","stem","tech","lego","code","coding"], e:"🔬", g:["#E6EEFB","#DCE9F6"]},
  {k:["sport","football","multi-activity","active","tennis","gym","martial","swim"], e:"⚽", g:["#E1F0E4","#D2E9DB"]},
  {k:["cook","food","chef"],        e:"👩‍🍳", g:["#FFF3D6","#FBE6C4"]},
  {k:["haf","free","council"],      e:"🍎", g:["#FCE8F0","#F4D7E6"]},
  {k:["childcare","playscheme","play","early years"], e:"🧸", g:["#F0E8F4","#E7D6F2"]},
];
function theme(p){
  const hay=((p.categories||[]).join(" ")+" "+(p.kind||"")+" "+(p.name||"")).toLowerCase();
  for(const t of THEMES){ if(t.k.some(w=>hay.includes(w))) return t; }
  return {e:"⭐", g:["#F0E8F4","#E5D6F0"]};
}
const isFree = p => (p.funding||[]).some(f=>/free|haf/i.test(f));
const hasTFC = p => (p.funding||[]).includes("Tax-Free Childcare") || plannerOf(p).tfc;
const hasSibling = p => (p.funding||[]).includes("Sibling discount");
const hasSEND = p => (p.categories||[]).includes("SEND aware") || plannerOf(p).sendAware;
const mealsIncl = p => { const l=plannerOf(p).lunch; return l && l.policy==="included"; };
const isWorking = p => plannerOf(p).coverage==="working";
const money = n => "£"+(Number.isInteger(n)?n:n.toFixed(2));

function minDayPrice(p){
  const pr = plannerOf(p).price || {};
  if(Number.isFinite(pr.day)) return pr.day;
  if(Number.isFinite(pr.week)) return Math.round(pr.week/5);
  if(pr.weekByWeek){ const v=Object.values(pr.weekByWeek).filter(Number.isFinite); if(v.length) return Math.round(Math.min(...v)/5); }
  return null;
}
function dayMinutes(p){
  const h=plannerOf(p).hours||{};
  const start=h.extStart||h.start, end=h.extEnd||h.end;
  if(!start||!end) return 0;
  const mins=s=>{const m=String(s).match(/(\d{1,2}):(\d{2})/);return m?(+m[1]*60+ +m[2]):0;};
  return Math.max(0,mins(end)-mins(start));
}
function runsWeek(p,wid){
  const pl=plannerOf(p);
  if((pl.weeks||[]).includes(wid)) return "yes";
  if(pl.weeksLikely || pl.haf || pl.plannerRole==="route") return "maybe";
  return "no";
}
function runsDay(p,day){ // day 1=Mon..5=Fri
  const pl=plannerOf(p);
  if(pl.dayPattern){ return Object.values(pl.dayPattern).some(arr=>arr.includes(day)); }
  return true; // assume Mon–Fri unless a pattern says otherwise
}
function priceFact(p){
  if(isFree(p)) return "Free (HAF, if eligible)";
  const pr=plannerOf(p).price||{}; const bits=[];
  if(Number.isFinite(pr.day)) bits.push(money(pr.day)+"/day");
  if(Number.isFinite(pr.dayExtended)) bits.push(money(pr.dayExtended)+"/ext day");
  if(Number.isFinite(pr.week)) bits.push(money(pr.week)+"/wk");
  if(!bits.length) return (p.price||"Check provider").replace(/GBP/g,"£").slice(0,40);
  return bits.join(" · ");
}
function badgeRow(p){
  const pl=plannerOf(p), f=p.funding||[], b=[]; const wk=pl.weeks||[];
  if(wk.length) b.push(`<span class="badge badge-confirmed">2026 dates ✓ wk ${wk.filter(w=>w<=6).join("·")}</span>`);
  else if(pl.weeksLikely||pl.haf) b.push(`<span class="badge badge-tbc">Dates TBC</span>`);
  if(f.includes("Free/HAF")) b.push(`<span class="badge badge-haf">HAF free places</span>`);
  if(hasTFC(p)) b.push(`<span class="badge badge-tfc">Tax-Free Childcare</span>`);
  if(pl.ofsted) b.push(`<span class="badge badge-ofsted">Ofsted-registered</span>`);
  if(hasSibling(p)) b.push(`<span class="badge badge-sibling">Sibling discount</span>`);
  if(hasSEND(p)) b.push(`<span class="badge badge-send">SEND aware</span>`);
  if(mealsIncl(p)) b.push(`<span class="badge badge-food">Meals included</span>`);
  return b.join("");
}
const truncate=(s,n)=>{s=s||"";return s.length>n?s.slice(0,n-1).trim()+"…":s;};
const bookUrl=p=>(p.source&&p.source.url)||"#";
const FEATURED = DIR.filter(p=>!isFree(p)).slice(0,2).map(p=>p.id);

/* ---------- state ---------- */
const state = {
  view:"find", tab:"find",
  dashTab:"overview",
  flags:new Set(),
  session: JSON.parse(localStorage.getItem("hc_session")||"null"),
  saved: new Set(JSON.parse(localStorage.getItem("hc_saved")||"[]")),
  children: JSON.parse(localStorage.getItem("hc_camp_children")||"[]"),
  coverPlan: JSON.parse(localStorage.getItem("hc_camp_cover_plan")||"{}"),
  checklist: new Set(JSON.parse(localStorage.getItem("hc_camp_checklist")||"[]")),
  providerSetup: JSON.parse(localStorage.getItem("hc_provider_setup")||"{}"),
};
const persist=()=>{ localStorage.setItem("hc_session",JSON.stringify(state.session));
                    localStorage.setItem("hc_saved",JSON.stringify([...state.saved]));
                    localStorage.setItem("hc_camp_children",JSON.stringify(state.children));
                    localStorage.setItem("hc_camp_cover_plan",JSON.stringify(state.coverPlan));
                    localStorage.setItem("hc_camp_checklist",JSON.stringify([...state.checklist]));
                    localStorage.setItem("hc_provider_setup",JSON.stringify(state.providerSetup)); };
const $=id=>document.getElementById(id);

function esc(s){return String(s==null?"":s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");}
function toast(msg){ if(window.HC&&HC.util&&HC.util.toast) HC.util.toast(msg); else alert(msg); }
function dateAdd(iso,days){ const d=new Date(iso+"T00:00:00Z"); d.setUTCDate(d.getUTCDate()+days); return d.toISOString().slice(0,10); }
function icsDate(iso){ return (iso||"").replace(/-/g,""); }
function planKey(childId,weekId){ return childId+"::"+weekId; }
function planEntry(childId,weekId){ return state.coverPlan[planKey(childId,weekId)]||{}; }
function setPlanEntry(childId,weekId,next){ state.coverPlan[planKey(childId,weekId)] = next; persist(); }
function childAgeOk(p,age){ age=Number(age); return !isFinite(age) || (p.ageMin<=age && p.ageMax>=age); }
function estimateWeekCost(p,wid){
  if(!p) return null;
  if(isFree(p)) return 0;
  const pl=plannerOf(p), pr=pl.price||{}, week=String(wid);
  if(pr.weekByWeek && Number.isFinite(pr.weekByWeek[week])) return pr.weekByWeek[week];
  if(Number.isFinite(pr.week)) return pr.week;
  const days=(pl.daysPerWeek&&pl.daysPerWeek[week]) || (WEEKS.find(w=>w.id===+wid)||{}).days || 5;
  if(Number.isFinite(pr.day)) return Math.round(pr.day*days*100)/100;
  const min=minDayPrice(p); return Number.isFinite(min)?Math.round(min*days*100)/100:null;
}
function planChoiceLabel(entry){
  if(!entry||!entry.kind) return "Uncovered";
  if(entry.kind==="cover") return entry.label||"Family cover";
  const p=DIR.find(x=>x.id===entry.providerId);
  return p?p.name:"Camp";
}
function planSummary(){
  let total=0, unknown=0, covered=0, booked=0, uncovered=0, tfcEligible=0, haf=0;
  state.children.forEach(ch=>WEEKS.forEach(w=>{
    const e=planEntry(ch.id,w.id);
    if(e.kind==="provider"){
      covered++; if(e.booked) booked++;
      const p=DIR.find(x=>x.id===e.providerId), cost=estimateWeekCost(p,w.id);
      if(cost==null) unknown++; else total+=cost;
      if(p&&hasTFC(p)&&cost) tfcEligible+=cost;
      if(p&&isFree(p)) haf++;
    } else if(e.kind==="cover") {
      covered++; if(e.booked) booked++;
    } else uncovered++;
  }));
  return { total, unknown, covered, booked, uncovered, tfcSaving: Math.round(tfcEligible*.2), haf };
}
function clipboard(text,label){
  if(navigator.clipboard&&navigator.clipboard.writeText){
    navigator.clipboard.writeText(text).then(()=>toast(label||"Copied")).catch(()=>toast(text));
  } else {
    window.prompt(label||"Copy this", text);
  }
}
function campOptionsFor(ch,wid){
  const savedFirst=DIR.slice().sort((a,b)=>(state.saved.has(b.id)?1:0)-(state.saved.has(a.id)?1:0));
  return savedFirst.filter(p=>childAgeOk(p,ch.age)&&runsWeek(p,wid)!=="no").slice(0,18);
}
function seedDemo(){
  state.children=[
    {id:"child_"+Date.now()+"_1",name:"Ari",age:7},
    {id:"child_"+Date.now()+"_2",name:"Maya",age:10}
  ];
  state.saved=new Set(DIR.slice(1,7).map(p=>p.id));
  state.coverPlan={};
  state.children.forEach((ch,ci)=>WEEKS.forEach((w,wi)=>{
    const opts=campOptionsFor(ch,w.id);
    if(opts[(wi+ci)%Math.max(opts.length,1)]) state.coverPlan[planKey(ch.id,w.id)]={kind:"provider",providerId:opts[(wi+ci)%opts.length].id,booked:wi<2};
  }));
  persist(); renderAuth(); setView("planner"); toast("Demo family plan loaded");
}

/* ---------- filtering ---------- */
function matches(p){
  const q=$("q").value.trim().toLowerCase();
  if(q && !JSON.stringify(p).toLowerCase().includes(q)) return false;
  const cat=$("fCat").value; if(cat && !(p.categories||[]).includes(cat)) return false;
  const area=$("fArea").value; if(area && !((p.areas||[p.area]).includes(area))) return false;
  const age=$("fAge").value; if(age){ const[lo,hi]=age.split("-").map(Number); if(p.ageMax<lo||p.ageMin>hi) return false; }
  const wk=$("fWeek").value; if(wk){ if(runsWeek(p,+wk)==="no") return false; }
  const day=$("fDay").value; if(day && !runsDay(p,+day)) return false;
  const len=$("fLength").value; if(len && plannerOf(p).coverage!==len) return false;
  const pmax=$("fPrice").value; if(pmax){ const m=minDayPrice(p); if(m!=null && m>+pmax) return false; }
  if($("fConfirmed") && $("fConfirmed").checked && !(plannerOf(p).weeks||[]).length) return false;
  for(const fl of state.flags){
    if(fl==="free"&&!isFree(p))return false;
    if(fl==="tfc"&&!hasTFC(p))return false;
    if(fl==="sibling"&&!hasSibling(p))return false;
    if(fl==="send"&&!hasSEND(p))return false;
    if(fl==="ofsted"&&!plannerOf(p).ofsted)return false;
    if(fl==="meals"&&!mealsIncl(p))return false;
    if(fl==="working"&&!isWorking(p))return false;
  }
  return true;
}
function filtered(){
  const sort=$("fSort")?$("fSort").value:"featured";
  const list=DIR.filter(matches);
  return list.sort((a,b)=>{
    if(sort==="name") return a.name.localeCompare(b.name);
    if(sort==="price") return (minDayPrice(a)??9999)-(minDayPrice(b)??9999);
    if(sort==="hours") return dayMinutes(b)-dayMinutes(a);
    if(sort==="confirmed") return ((plannerOf(b).weeks||[]).length-(plannerOf(a).weeks||[]).length)||a.name.localeCompare(b.name);
    return (FEATURED.includes(b.id)?1:0)-(FEATURED.includes(a.id)?1:0)||a.name.localeCompare(b.name);
  });
}

/* ---------- card + directory ---------- */
function card(p){
  const t=theme(p), feat=FEATURED.includes(p.id), on=state.saved.has(p.id);
  return `<article class="card" data-open="${p.id}">
    <div class="media" style="background:linear-gradient(135deg,${t.g[0]},${t.g[1]})">
      ${feat?`<div class="ribbon"><span class="star">★</span> Featured</div>`:""}
      <button class="heart ${on?'on':''}" data-save="${p.id}" title="Save">${on?'♥':'♡'}</button>
      <span class="emoji">${t.e}</span>
    </div>
    <div class="card-body">
      <h3 class="card-title">${p.name}</h3>
      <div class="card-kind">${p.kind||""}${p.area?` · ${p.area}`:""}</div>
      <div class="badges">${badgeRow(p)}</div>
      <ul class="meta">
        <li><span class="mi">🎂</span><span>Ages ${(p.ageLabel||"").replace(/ages?\s*/i,"")||`${p.ageMin}–${p.ageMax}`}</span></li>
        <li><span class="mi">💷</span><span>${priceFact(p)}</span></li>
        <li><span class="mi">📍</span><span>${truncate(p.venue||p.address,42)}</span></li>
      </ul>
    </div>
    <div class="card-foot"><a class="btn" href="${bookUrl(p)}" target="_blank" rel="noopener" data-stop>Book now</a></div>
  </article>`;
}
function renderFind(){
  const list=filtered();
  $("grid").innerHTML=list.map(card).join("")||`<p style="color:var(--muted);grid-column:1/-1">No camps match — try clearing a filter.</p>`;
  $("count").textContent=`${list.length} camp${list.length!==1?"s":""}`;
}

/* ---------- parent planner cockpit ---------- */
function renderFamilyPlanner(){
  const s=planSummary();
  const childRows=state.children.map(ch=>{
    const cells=WEEKS.map(w=>{
      const e=planEntry(ch.id,w.id), opts=campOptionsFor(ch,w.id);
      const val=e.kind==="provider"?e.providerId:e.kind==="cover"?(e.coverId||"cover-family"):"";
      const campOpts=opts.map(p=>`<option value="${p.id}" ${val===p.id?"selected":""}>${esc(p.name)} · ${priceFact(p)}</option>`).join("");
      return `<td><div class="plan-cell">
        <select data-plan-select data-child="${ch.id}" data-week="${w.id}" aria-label="Choose cover for ${esc(ch.name)} ${esc(w.label)}">
          <option value="" ${!val?"selected":""}>Choose cover</option>
          <option value="cover-family" ${val==="cover-family"?"selected":""}>Family / grandparents</option>
          <option value="cover-leave" ${val==="cover-leave"?"selected":""}>Annual leave</option>
          <option value="cover-friend" ${val==="cover-friend"?"selected":""}>Friend / childcare swap</option>
          ${campOpts}
        </select>
        <label><input type="checkbox" data-plan-booked data-child="${ch.id}" data-week="${w.id}" ${e.booked?"checked":""}> booked</label>
        <small class="muted">${e.kind==="provider"?(()=>{const est=estimateWeekCost(DIR.find(p=>p.id===e.providerId),w.id);return est==null?"£?":money(est);})():e.kind==="cover"?"£0":"Needs cover"}</small>
      </div></td>`;
    }).join("");
    return `<tr><th class="sticky">${esc(ch.name)}<br><small class="muted">age ${esc(ch.age)}</small></th>${cells}</tr>`;
  }).join("");
  const table=state.children.length?`<div class="planner-wrap"><table class="plan-table"><thead><tr><th class="sticky">Child</th>${WEEKS.map(w=>`<th>${w.label}<br><small class="muted">${w.dates}</small></th>`).join("")}</tr></thead><tbody>${childRows}</tbody></table></div>`:
    `<div class="panel"><h3>Add a child to unlock the planner grid</h3><p class="lead" style="margin-bottom:14px">The grid builds one row per child and one column per summer week, then totals the cost locally on this device.</p><button class="btn" data-demo-seed>Load demo family plan</button></div>`;
  return `<section class="surface two" aria-label="Family planner">
    <div class="panel">
      <h3>Who are we planning for?</h3>
      <div class="inline-form">
        <div class="field" style="margin:0"><label>Name</label><input id="childName" placeholder="Optional" /></div>
        <div class="field" style="margin:0"><label>Age</label><input id="childAge" type="number" min="3" max="16" placeholder="Age" /></div>
        <button class="btn" data-add-child>Add child</button>
      </div>
      <div class="children">${state.children.map(ch=>`<span class="child-pill">${esc(ch.name)} · ${esc(ch.age)} <button class="iconbtn" data-remove-child="${ch.id}" title="Remove ${esc(ch.name)}">×</button></span>`).join("")}</div>
      <p class="muted" style="font-size:12.5px;margin:12px 0 0">Saved on this device only. Private plan links include child names and camp choices, so only send them to family.</p>
    </div>
    <div class="surface three" style="margin:0">
      <div class="stat"><div class="k">Planned cost</div><div class="v">${money(s.total)}${s.unknown?" + £?":""}</div><p>${s.booked} booked selections · ${s.covered} covered cells</p></div>
      <div class="stat"><div class="k">Needs cover</div><div class="v">${s.uncovered}</div><p>${state.children.length?state.children.length+" children × "+WEEKS.length+" weeks":"Add children to start"}</p></div>
      <div class="stat"><div class="k">Possible TFC help</div><div class="v">${money(s.tfcSaving)}</div><p>Rough 20% top-up on eligible planned spend</p></div>
    </div>
  </section>
  <div class="panel">
    <div style="display:flex;gap:9px;align-items:center;justify-content:space-between;flex-wrap:wrap">
      <h3 style="margin:0">Your summer, week by week</h3>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn btn-sm btn-ghost" data-plan-action="summary">Copy summary</button>
        <button class="btn btn-sm btn-ghost" data-plan-action="calendar">Add to calendar</button>
        <button class="btn btn-sm btn-ghost" data-plan-action="share">Private share link</button>
        <button class="btn btn-sm btn-ghost" data-plan-action="print">Print</button>
        <button class="btn btn-sm btn-ghost" data-plan-action="clear">Clear plan</button>
      </div>
    </div>
    ${table}
  </div>
  ${renderShortlistCompare()}
  ${renderMoneyHelp()}
  ${renderChecklist()}`;
}
function renderShortlistCompare(){
  const list=DIR.filter(p=>state.saved.has(p.id)).slice(0,8);
  if(!list.length) return `<div class="panel"><h3>Compare your shortlist</h3><p class="lead" style="margin-bottom:12px">Save camps with the heart button and they appear here side by side: hours, prices, food, funding and confidence in one table.</p><button class="btn btn-ghost" data-view="find">Browse camps</button></div>`;
  return `<div class="panel compare"><h3>Compare your shortlist</h3><table><thead><tr><th>Camp</th><th>Ages</th><th>Hours</th><th>Price</th><th>Funding</th><th>Food</th><th>Weeks</th></tr></thead><tbody>${list.map(p=>{
    const pl=plannerOf(p), hours=pl.hours?`${pl.hours.start}-${pl.hours.end}`:(p.hours||"Check"), food=mealsIncl(p)?"Included":(pl.lunch&&pl.lunch.policy==="bring"?"Bring lunch":"Check");
    return `<tr><td><strong>${esc(p.name)}</strong><br><a href="${bookUrl(p)}" target="_blank" rel="noopener">booking/source</a></td><td>${esc(p.ageLabel||`${p.ageMin}-${p.ageMax}`)}</td><td>${esc(hours)}</td><td>${esc(priceFact(p))}</td><td>${hasTFC(p)?"TFC ":""}${isFree(p)?"HAF ":""}${hasSibling(p)?"Sibling":""}</td><td>${food}</td><td>${(pl.weeks||[]).join(", ")||"TBC"}</td></tr>`;
  }).join("")}</tbody></table></div>`;
}
function renderMoneyHelp(){
  const hafCount=DIR.filter(isFree).length, tfcCount=DIR.filter(hasTFC).length;
  return `<div class="money-grid">
    <div class="mini-card"><h4>Free HAF places</h4><p>${hafCount} routes/listings flag HAF or free places. Eligibility and booking status stay with the council/Eequ source.</p></div>
    <div class="mini-card"><h4>Tax-Free Childcare</h4><p>${tfcCount} providers appear eligible or voucher-friendly in the verified data. Ask for registration details before paying.</p></div>
    <div class="mini-card"><h4>Sibling and early-bird</h4><p>Use the shortlist compare to spot sibling discounts, then anchor must-work weeks with working-day camps.</p></div>
    <div class="mini-card"><h4>Mix the week types</h4><p>Blend full-day childcare, one special-interest week and family cover. The planner prices the mix as you build it.</p></div>
  </div>`;
}
function renderChecklist(){
  const items=[
    ["dates","Dates, times and price are still current"],
    ["ofsted","Ofsted/TFC/HAF eligibility checked where relevant"],
    ["food","Food, packed-lunch and water rules known"],
    ["pickup","Drop-off, collection and late pickup policy known"],
    ["kit","Kit, suncream, medication and trip-day needs noted"],
    ["send","SEND, allergy and medical support discussed"],
    ["phones","Phone/photo rules and consent understood"],
    ["refund","Cancellation, refund and illness rules understood"]
  ];
  return `<div class="panel"><h3>Ask-the-provider checklist</h3><div class="checklist">${items.map(i=>`<label><input type="checkbox" data-check="${i[0]}" ${state.checklist.has(i[0])?"checked":""}> ${i[1]}</label>`).join("")}</div></div>`;
}

function planText(){
  const lines=["HolidayCamp summer plan", "Generated locally on this device", ""];
  state.children.forEach(ch=>{
    lines.push(`${ch.name} (age ${ch.age})`);
    WEEKS.forEach(w=>{
      const e=planEntry(ch.id,w.id);
      const p=e.kind==="provider"?DIR.find(x=>x.id===e.providerId):null;
      const est=p?estimateWeekCost(p,w.id):0;
      lines.push(`- ${w.label} ${w.dates}: ${planChoiceLabel(e)}${p?` (${est==null?"£?":money(est)})`:""}${e.booked?" [booked]":""}`);
    });
    lines.push("");
  });
  const s=planSummary();
  lines.push(`Total planned cost: ${money(s.total)}${s.unknown?" + unknown prices":""}`);
  lines.push(`Needs cover: ${s.uncovered}`);
  return lines.join("\n");
}
function downloadCalendar(){
  const events=[];
  state.children.forEach(ch=>WEEKS.forEach(w=>{
    const e=planEntry(ch.id,w.id);
    if(!e.kind||!w.mon) return;
    events.push("BEGIN:VEVENT\nUID:"+ch.id+"-"+w.id+"@holidaycamp\nDTSTAMP:20260616T090000Z\nDTSTART;VALUE=DATE:"+icsDate(w.mon)+"\nDTEND;VALUE=DATE:"+icsDate(dateAdd(w.mon,w.days||5))+"\nSUMMARY:"+ch.name+": "+planChoiceLabel(e)+"\nDESCRIPTION:HolidayCamp simulated local planner. Confirm dates, times and booking directly with the provider.\nEND:VEVENT");
  }));
  if(!events.length){ toast("Add cover to the planner first"); return; }
  const body="BEGIN:VCALENDAR\nVERSION:2.0\nPRODID:-//HolidayCamp//Local Planner//EN\n"+events.join("\n")+"\nEND:VCALENDAR\n";
  const blob=new Blob([body],{type:"text/calendar"});
  const a=document.createElement("a"); a.href=URL.createObjectURL(blob); a.download="holidaycamp-plan.ics"; a.click(); URL.revokeObjectURL(a.href);
}
function privateShare(){
  const payload={children:state.children,coverPlan:state.coverPlan,created:"2026-06-16"};
  const encoded=btoa(unescape(encodeURIComponent(JSON.stringify(payload))));
  const url=location.origin+location.pathname+"#plan="+encoded;
  clipboard(url,"Private plan link copied");
}
function trySharedPlan(){
  if(!location.hash.startsWith("#plan=")) return;
  try{
    const payload=JSON.parse(decodeURIComponent(escape(atob(location.hash.slice(6)))));
    if(!payload||!Array.isArray(payload.children)||!payload.coverPlan) return;
    modal(`<button class="x" data-close>×</button><div class="auth"><div class="mascot">⛺</div><h2>Load this shared plan?</h2><p class="s">This private link contains child names and camp choices. Loading stays on this device.</p><button class="btn" data-shared-plan="replace" style="width:100%;margin-bottom:9px">Use this plan</button><button class="sso" data-shared-plan="merge">Merge with mine</button><button class="sso" data-close>No thanks</button></div>`);
    modalRoot._sharedPlan=payload;
  }catch(e){}
}
function clearPlan(){
  state.coverPlan={}; persist(); renderBrowse(); toast("Planner cleared");
}
function openFeaturePreview(id){
  const f=window.HC&&HC.features&&HC.features.find(x=>x.id===id);
  if(!f){ toast("Feature module not found"); return; }
  modal(`<button class="x" data-close>×</button><div class="dbody"><h2>${esc(f.icon||"")} ${esc(f.title)}</h2><p class="card-kind">${esc(f.summary||"")}</p><div id="featurePreviewMount"></div></div>`);
  const host=$("featurePreviewMount");
  try{ f.render(host); }catch(e){ host.innerHTML=`<p style="color:var(--magenta)">Feature preview failed: ${esc(e.message||e)}</p>`; }
}

function renderPlanner(){
  const list=filtered();
  const dates = KEY.lastSchoolDay ? `<div class="datesbar">📌 <b>Summer holidays:</b> most Waltham Forest schools break up <b>${KEY.lastSchoolDay.label}</b> and return <b>${KEY.backToSchool?KEY.backToSchool.label:"early Sep"}</b>. Tap a camp to see details.</div>`:"";
  const legend=`<div class="legend"><span><span class="yes">✓</span> Confirmed 2026 dates</span><span><span class="maybe">~</span> Runs summer — week TBC</span><span>Blank = not this week</span></div>`;
  const head=`<tr><th class="camp">Camp</th>${WEEKS.map(w=>`<th>${w.label}<small>${w.dates}</small></th>`).join("")}</tr>`;
  const rows=list.map(p=>{
    const cells=WEEKS.map(w=>{const r=runsWeek(p,w.id);return `<td>${r==="yes"?'<span class="yes">✓</span>':r==="maybe"?'<span class="maybe">~</span>':''}</td>`;}).join("");
    return `<tr data-open="${p.id}"><td class="camp">${p.name}<small>${truncate(p.kind||"",30)} · ${priceFact(p)}</small></td>${cells}</tr>`;
  }).join("");
  $("plannerView").innerHTML=`${renderFamilyPlanner()}${dates}${legend}<div class="planner-wrap"><table class="planner"><thead>${head}</thead><tbody>${rows}</tbody></table></div>`;
  $("count").textContent=`${list.length} camp${list.length!==1?"s":""} · ${WEEKS.length} weeks`;
}
function renderBrowse(){ if(state.tab==="find"){renderFind();$("findView").classList.remove("hidden");$("plannerView").classList.add("hidden");$("resTitle").textContent="Holiday camps near E17";}
                         else {renderPlanner();$("plannerView").classList.remove("hidden");$("findView").classList.add("hidden");$("resTitle").textContent="Your summer, week by week";} }

/* ---------- camp detail modal ---------- */
function openCamp(id){
  const p=DIR.find(x=>x.id===id); if(!p)return; const t=theme(p), pl=plannerOf(p), on=state.saved.has(p.id);
  const wks=(pl.weeks||[]).map(id=>{const w=WEEKS.find(x=>x.id===id);return w?w.dates:null;}).filter(Boolean);
  const hours = pl.hours ? `${pl.hours.start}–${pl.hours.end}${pl.hours.extStart?` (wrap-around ${pl.hours.extStart}–${pl.hours.extEnd})`:""}` : (p.hours||"Check provider");
  modal(`<div class="dhead" style="background:linear-gradient(135deg,${t.g[0]},${t.g[1]})"><span class="emoji">${t.e}</span></div>
    <button class="x" data-close>×</button>
    <div class="dbody">
      <h2>${p.name}</h2>
      <div class="card-kind" style="margin-bottom:10px">${p.kind||""}${p.area?` · ${p.area}`:""}</div>
      <div class="badges" style="margin-bottom:14px">${badgeRow(p)}</div>
      <p style="color:var(--text);font-size:15px">${p.summary||p.goodFor||""}</p>
      <ul class="meta" style="margin:14px 0">
        <li><span class="mi">🎂</span><span>Ages ${(p.ageLabel||"").replace(/ages?\s*/i,"")||`${p.ageMin}–${p.ageMax}`}</span></li>
        <li><span class="mi">🕘</span><span>${hours}</span></li>
        <li><span class="mi">💷</span><span>${priceFact(p)}${pl.priceBasis?` — <span style="color:var(--muted)">${pl.priceBasis}</span>`:""}</span></li>
        <li><span class="mi">📍</span><span>${p.address||p.venue||""}</span></li>
        ${wks.length?`<li><span class="mi">📅</span><span>Confirmed weeks: ${wks.join("; ")}</span></li>`:""}
      </ul>
      <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:8px">
        <a class="btn" href="${bookUrl(p)}" target="_blank" rel="noopener">Book now</a>
        <button class="btn btn-ghost" data-save="${p.id}">${on?"♥ Saved":"♡ Save camp"}</button>
      </div>
      ${p.source?`<p class="auth note" style="text-align:left">Source: <a href="${p.source.url}" target="_blank" rel="noopener">${p.source.label}</a>${p.confidence?` · ${p.confidence}`:""}</p>`:""}
    </div>`);
}

/* ---------- auth (simulated) ---------- */
function renderAuth(){
  const a=$("authArea");
  if(state.session){
    const s=state.session, initial=(s.name||"U").trim()[0].toUpperCase();
    a.innerHTML=`<button class="acct-chip" id="acctBtn"><span class="avatar">${initial}</span>${s.name.split(" ")[0]} ▾</button>`;
    $("acctBtn").onclick=toggleMenu;
  } else {
    a.innerHTML=`<button class="linkbtn" data-auth="login">Log in</button> <button class="btn btn-sm" data-auth="signup">Sign up</button>`;
  }
}
function toggleMenu(){
  let m=$("acctMenu"); if(m){m.remove();return;}
  const s=state.session;
  const html=`<div class="menu" id="acctMenu">
    <button data-view="saved">♥ Saved camps (${state.saved.size})</button>
    ${s.role==="provider"?`<button data-view="dash">📊 Provider dashboard</button>`:`<button data-auth="provider">＋ List my camp</button>`}
    <div class="sep"></div>
    <button id="logoutBtn">Log out</button></div>`;
  document.body.insertAdjacentHTML("beforeend",html);
  $("logoutBtn").onclick=()=>{state.session=null;persist();$("acctMenu").remove();renderAuth();setView("find");};
}
function openAuth(mode){
  const provider = mode==="provider";
  const sso=(cls,icon,label)=>`<button class="sso ${cls}" data-sso="${label}"><span class="g">${icon}</span> Continue with ${label}</button>`;
  modal(`<button class="x" data-close>×</button>
    <div class="auth">
      <div class="mascot">⛺</div>
      <h2>${provider?"List your camp":(mode==="signup"?"Create your account":"Welcome back")}</h2>
      <p class="s">${provider?"Reach thousands of local parents — free to list.":"Save camps and plan your summer in seconds."}</p>
      <div class="seg"><button class="${mode!=='login'?'active':''}" data-mode="signup">Sign up</button><button class="${mode==='login'?'active':''}" data-mode="login">Log in</button></div>
      ${sso("apple","","Apple")}
      ${sso("google","G","Google")}
      ${sso("facebook","f","Facebook")}
      <div class="divider">or</div>
      <div class="field"><input id="authName" placeholder="Your name" /></div>
      <div class="field"><input id="authEmail" type="email" placeholder="Email address" /></div>
      <button class="btn" style="width:100%" id="authEmailBtn">Continue with email</button>
      <p class="note">🔒 Demo sign-in — this is a local prototype. No real account is created, nothing is sent, no password needed.</p>
    </div>`);
  modalRoot.dataset.provider = provider?"1":"";
}
function doLogin(name, via){
  const provider = modalRoot.dataset.provider==="1";
  state.session={ name:name||"Guest Parent", via, role:provider?"provider":"parent" };
  persist(); closeModal(); renderAuth();
  setView(provider?"dash":"find");
}

/* ---------- providers view ---------- */
function renderProviders(){
  $("providersView").innerHTML=`
    <h2>Get your camp in front of E17 parents</h2>
    <p class="lead">List your holiday camp for <strong>free</strong> and give local families clearer dates, prices, availability, booking routes and practical first-day information.</p>
    <div class="pricing">
      <div class="price-card"><h3>Free</h3><div class="amt">£0</div>
        <ul><li>Full camp listing</li><li>Appear in search &amp; planner</li><li>Link to your booking page</li><li>"Listed on HolidayCamp" badge</li></ul>
        <button class="btn btn-ghost" data-auth="provider">List for free</button></div>
      <div class="price-card featured"><h3>Membership</h3><div class="amt">£8<small>/mo</small></div>
        <ul><li>Everything in Free</li><li>Priority in search results</li><li>Photo gallery + rich profile</li><li>Booking widget for your site</li><li>Customer messaging</li></ul>
        <button class="btn" data-auth="provider">Start membership</button></div>
      <div class="price-card"><h3>Bookings</h3><div class="amt">2.5%<small>+VAT</small></div>
        <ul><li>Take bookings on HolidayCamp</li><li>One of the lowest fees around</li><li>Instant payouts via Stripe</li><li>Registers &amp; attendance</li></ul>
        <button class="btn btn-ghost" data-auth="provider">Take bookings</button></div>
      <div class="price-card"><h3>Featured</h3><div class="amt">1p<small>/view</small></div>
        <ul><li>Top of search with a ★ banner</li><li>Pay only when shown</li><li>Set your own daily budget</li><li>~6× more clicks</li></ul>
        <button class="btn btn-ghost" data-auth="provider">Promote my camp</button></div>
    </div>
    <div class="panel">
      <h3>Add your camp <span style="font-weight:600;color:var(--muted);font-size:13px">(demo form)</span></h3>
      <div class="field"><label>Camp name</label><input placeholder="e.g. Sunshine Drama Camp"/></div>
      <div class="field"><label>Area</label><input placeholder="e.g. Leyton, E10"/></div>
      <div class="field"><label>Age range</label><input placeholder="e.g. 5–11"/></div>
      <div class="field"><label>Price per day</label><input placeholder="e.g. £40"/></div>
      <div class="field"><label>About your camp</label><textarea rows="3" placeholder="What makes it great…"></textarea></div>
      <button class="btn" data-auth="provider">Submit &amp; create account</button>
    </div>
    <div class="panel">
      <h3>Your free promo badge</h3>
      <p style="font-size:14px;color:var(--text)">Members can display this on their own website as a visible trust and discovery signal for parents.</p>
      <div class="badge-embed">⛺ Listed on HolidayCamp <span class="b-star">★</span></div>
      <div class="codebox">&lt;a href="https://holidaycamp.uk/c/your-camp"&gt;&lt;img src="badge.svg" alt="Listed on HolidayCamp"&gt;&lt;/a&gt;</div>
    </div>`;
}

/* ---------- saved view ---------- */
function renderSaved(){
  if(!state.session){ $("savedView").innerHTML=`<h2>Saved camps</h2><p class="lead">Log in to save camps and build your shortlist.</p><button class="btn" data-auth="login">Log in</button>`; return; }
  const list=DIR.filter(p=>state.saved.has(p.id));
  $("savedView").innerHTML=`<h2>Your saved camps</h2><p class="lead">${list.length?`${list.length} camp${list.length!==1?"s":""} on your shortlist.`:"No saved camps yet — tap the ♡ on any camp."}</p><div class="grid">${list.map(card).join("")}</div>`;
}

/* ---------- provider dashboard ---------- */
function featureCount(side){ return window.HC&&HC.features?HC.features.filter(f=>f.side===side).length:0; }
function providerDemoBookings(){
  const names=["Ari Patel","Maya Khan","Leo Smith","Nina Brown","Samir Ali","Evie Jones","Zoe Lee","Rafi Green"];
  return names.map((n,i)=>({ref:"HC-"+(2041+i),child:n.split(" ")[0],parent:n.split(" ").slice(-1)[0]+" family",camp:DIR[(i+1)%DIR.length],week:WEEKS[i%WEEKS.length],paid:[36,49,140,0,65,30,48,25][i],status:i%3===0?"Needs note":"Booked",notes:i%4===0?"Allergy/SEND note":""}));
}
function dashTabs(){
  const tabs=[["overview","Overview"],["listings","Listings"],["bookings","Bookings"],["customers","Customers"],["growth","Growth"],["ops","Ops"],["research","Evidence"]];
  return `<div class="dash-tabs">${tabs.map(t=>`<button class="dash-tab ${state.dashTab===t[0]?"active":""}" data-dash-tab="${t[0]}">${t[1]}</button>`).join("")}</div>`;
}
function setupStep(id,label,feature){
  const on=!!state.providerSetup[id];
  return `<div class="ops-card"><h4>${on?"✓ ":"○ "}${label}</h4><p>${on?"Marked done in this demo workspace.":"Open the workflow or mark it complete."}</p><div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn btn-sm btn-ghost" data-provider-action="${id}">${on?"Undo":"Mark done"}</button>${feature?`<button class="btn btn-sm" data-open-feature="${feature}">Open</button>`:""}</div></div>`;
}
function renderDashOverview(mine){
  const done=Object.values(state.providerSetup).filter(Boolean).length;
  return `${dashTabs()}
    <div class="surface three">
      <div class="stat"><div class="k">Marketplace modules</div><div class="v">${featureCount("parent")+featureCount("provider")+featureCount("platform")}</div><p>${featureCount("provider")} provider · ${featureCount("parent")} parent · ${featureCount("platform")} platform</p></div>
      <div class="stat"><div class="k">Revenue demo</div><div class="v">£1,842</div><p>Bookings, widgets, featured placements and link-outs are simulated</p></div>
      <div class="stat"><div class="k">Action queue</div><div class="v">${Math.max(0,8-done)}</div><p>Setup steps remaining before bookings are fully switched on</p></div>
    </div>
    <div class="panel"><h3>Guided setup: main booking system or alongside your own</h3><div class="ops-grid">
      ${setupStep("fit","Choose booking-system mode","provider-activate-bookings")}
      ${setupStep("details","Complete company/profile details","provider-company-details")}
      ${setupStep("venues","Create venues and timetable","provider-venue-create")}
      ${setupStep("tickets","Build tickets, prices and capacity","provider-price-wizard")}
      ${setupStep("stripe","Connect simulated Stripe payouts","provider-stripe-connect")}
      ${setupStep("legals","Add T&Cs, privacy and consent wording","provider-tnc-upload")}
      ${setupStep("verify","Verify dates and publish freshness","provider-verify-classes")}
      ${setupStep("support","Set support/contact preferences","provider-help-centre")}
    </div></div>
    <div class="panel"><h3>Today at a glance</h3><div class="timeline">
      <div class="item"><strong>09:00</strong><span>Register opens for ${esc(mine[0].name)} with allergy/SEND notes visible.</span><button class="btn btn-sm btn-ghost" data-open-feature="provider-registers">Register</button></div>
      <div class="item"><strong>12:30</strong><span>Two parents joined waiting lists; one free place can be released.</span><button class="btn btn-sm btn-ghost" data-open-feature="parent-waiting-list">Waitlist</button></div>
      <div class="item"><strong>15:45</strong><span>Featured budget has 31 impressions left today.</span><button class="btn btn-sm btn-ghost" data-open-feature="provider-featured-budget">Budget</button></div>
    </div></div>`;
}
function renderDashListings(mine){
  return `${dashTabs()}<div class="panel"><h3>Your listings</h3>
    ${mine.map((p,i)=>`<div style="display:flex;align-items:center;gap:12px;padding:12px 0;border-bottom:1px solid var(--line)">
      <span style="font-size:24px">${theme(p).e}</span>
      <div style="flex:1"><strong style="color:var(--purple)">${esc(p.name)}</strong><br><span class="muted">${esc(priceFact(p))} · ${esc((plannerOf(p).weeks||[]).join(", ")||"dates TBC")}</span></div>
      <span class="badge ${i===0?"badge-confirmed":"badge-tbc"}">${i===0?"Verified":"Needs check"}</span>
      <button class="btn btn-ghost btn-sm" data-open-feature="provider-edit-camp">Edit</button>
      <button class="btn btn-ghost btn-sm" data-open-feature="provider-preview-public-page">Preview</button>
    </div>`).join("")}
    </div>
    <div class="ops-grid">
      ${setupStep("hidden","Pre-sell hidden booking links","provider-hidden-mode")}
      ${setupStep("duplicate","Duplicate a listing for a new venue","provider-duplicate-camp")}
      ${setupStep("photos","Add logo, banner and photos","provider-logo-banner")}
      ${setupStep("multiVenue","Run one activity at multiple venues","provider-multi-venue")}
    </div>`;
}
function renderDashBookings(){
  const rows=providerDemoBookings();
  return `${dashTabs()}<div class="panel"><h3>Bookings, registers and attendance</h3><div class="compare"><table><thead><tr><th>Ref</th><th>Child</th><th>Camp</th><th>Week</th><th>Paid</th><th>Status</th><th>Notes</th></tr></thead><tbody>${rows.map(r=>`<tr><td>${r.ref}</td><td>${r.child}</td><td>${esc(r.camp.name)}</td><td>${esc(r.week.label)}</td><td>${money(r.paid)}</td><td>${r.status}</td><td>${r.notes||"—"}</td></tr>`).join("")}</tbody></table></div></div>
    <div class="ops-grid">
      ${setupStep("manual","Add manual/offline booking","provider-manual-booking")}
      ${setupStep("refund","Issue refund or remove booking","provider-refund")}
      ${setupStep("transfer","Transfer customer to another date","provider-transfer-customer")}
      ${setupStep("print","Print day register for staff","provider-print-register")}
    </div>`;
}
function renderDashCustomers(){
  return `${dashTabs()}<div class="surface two">
    <div class="panel"><h3>Customers and followers CRM</h3><div class="timeline">
      <div class="item"><strong>37</strong><span>Parents have saved your camps or followed your profile.</span><button class="btn btn-sm btn-ghost" data-open-feature="provider-followers">Followers</button></div>
      <div class="item"><strong>18</strong><span>Marketing opt-ins available for newsletter export after privacy policy check.</span><button class="btn btn-sm btn-ghost" data-open-feature="provider-followers-export">Export</button></div>
      <div class="item"><strong>6</strong><span>Waiting-list parents matched to a newly opened space.</span><button class="btn btn-sm btn-ghost" data-open-feature="parent-waiting-list">Waitlist</button></div>
    </div></div>
    <div class="panel"><h3>Support launcher</h3><p class="lead">One route for ordinary help, booking issues, complaints, parent contact and provider troubleshooting.</p><button class="btn" data-open-feature="provider-help-centre">Open help centre</button> <button class="btn btn-ghost" data-open-feature="parent-complaint">Complaint route</button></div>
  </div>`;
}
function renderDashGrowth(){
  return `${dashTabs()}<div class="surface three">
    <div class="stat"><div class="k">Search appearances</div><div class="v">4,812</div><p>Area, category, venue and seasonal pages</p></div>
    <div class="stat"><div class="k">Click-through</div><div class="v">7.5%</div><p>Booking/source clicks from parent cards</p></div>
    <div class="stat"><div class="k">Featured ROI</div><div class="v">6.1×</div><p>Simulated lift vs ordinary placement</p></div>
  </div><div class="panel"><h3>Visibility catalogue</h3><div class="ops-grid">
    ${setupStep("featured","Featured listing budget","provider-featured-budget")}
    ${setupStep("newsletter","What's-on newsletter inclusion","platform-whats-on-newsletter")}
    ${setupStep("widget","Embeddable bookings widget","provider-booking-widget")}
    ${setupStep("badge","Badge/backlink credit","platform-badge-credit")}
    ${setupStep("referral","Provider and parent referrals","platform-provider-referral-credit")}
    ${setupStep("seo","Programmatic SEO pages","platform-programmatic-seo")}
  </div></div>`;
}
function renderDashOps(){
  return `${dashTabs()}<div class="panel"><h3>Platform/internal console simulation</h3><div class="ops-grid">
    ${setupStep("unclaimed","Unclaimed listing queue","platform-unclaimed-listings")}
    ${setupStep("complaints","Complaints and eligibility policy","platform-complaints-procedure")}
    ${setupStep("legal","Legal, T&Cs and account closure","platform-legal-tnc")}
    ${setupStep("campaigns","Seasonal switch campaigns","platform-campaigns")}
    ${setupStep("venueFinder","Venue finder expansion tool","provider-venue-finder")}
    ${setupStep("online","Online conversion and safeguarding","provider-online-safeguarding")}
  </div></div>`;
}
function renderDashResearch(){
  const idx=window.HC_RESEARCH_INDEX||{totals:{},links:[]};
  const sample=(idx.links||[]).filter(l=>l.source==="support").slice(0,18);
  return `${dashTabs()}<div class="surface three">
    <div class="stat"><div class="k">Imported URLs</div><div class="v">${idx.totals.links||0}</div><p>URL metadata only, no copied article bodies</p></div>
    <div class="stat"><div class="k">Support URLs</div><div class="v">${idx.totals.support||0}</div><p>Provider/parent help and logged-in workflow evidence</p></div>
    <div class="stat"><div class="k">Public URLs</div><div class="v">${idx.totals.public||0}</div><p>SEO, venue, schedule and category route fabric</p></div>
  </div><div class="panel"><h3>Evidence map</h3><p class="lead">Open the full searchable feature, or inspect a sample of support URLs below.</p><button class="btn" data-open-feature="platform-research-url-inventory">Open full URL inventory</button><div class="research-list" style="margin-top:14px">${sample.map(l=>`<div class="research-row"><strong>${esc(l.label)}</strong><a href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.url)}</a></div>`).join("")}</div></div>`;
}
function renderDash(){
  const mine=DIR.slice(0,3); // demo: pretend the provider owns the first 3
  const name=state.session?`, ${state.session.name.split(" ")[0]}`:"";
  const body={
    overview:renderDashOverview(mine),
    listings:renderDashListings(mine),
    bookings:renderDashBookings(),
    customers:renderDashCustomers(),
    growth:renderDashGrowth(),
    ops:renderDashOps(),
    research:renderDashResearch()
  }[state.dashTab]||renderDashOverview(mine);
  $("dashView").innerHTML=`<h2>Provider command centre</h2><p class="lead">Welcome back${name} — a simulated full-stack operating console for listings, bookings, registers, customers, growth, support and internal platform workflows.</p>${body}`;
}

/* ---------- view router ---------- */
function setView(v){
  state.view=v;
  const m=$("acctMenu"); if(m)m.remove();
  $("browse").classList.toggle("hidden", !(v==="find"||v==="planner"));
  $("providersView").classList.toggle("hidden", v!=="providers");
  $("savedView").classList.toggle("hidden", v!=="saved");
  $("dashView").classList.toggle("hidden", v!=="dash");
  document.querySelectorAll("#nav a").forEach(a=>a.classList.toggle("active", a.dataset.view===v || (v==="planner"&&a.dataset.view==="find")));
  if(v==="planner"){ state.tab="planner"; syncTabs(); renderBrowse(); }
  else if(v==="find"){ state.tab="find"; syncTabs(); renderBrowse(); }
  else if(v==="providers") renderProviders();
  else if(v==="saved") renderSaved();
  else if(v==="dash") renderDash();
  window.scrollTo({top:0,behavior:"smooth"});
}
function syncTabs(){ document.querySelectorAll(".tab").forEach(t=>t.classList.toggle("active",t.dataset.tab===state.tab)); }

/* ---------- modal plumbing ---------- */
const modalRoot=$("modalRoot");
function modal(inner){ modalRoot.innerHTML=`<div class="overlay" data-overlay><div class="dialog">${inner}</div></div>`; }
function closeModal(){ modalRoot.innerHTML=""; modalRoot.dataset.provider=""; }

/* ---------- filter population ---------- */
function uniqSorted(a){return [...new Set(a)].sort((x,y)=>x.localeCompare(y));}
function buildFilters(){
  uniqSorted(DIR.flatMap(p=>p.categories||[])).forEach(c=>$("fCat").insertAdjacentHTML("beforeend",`<option>${c}</option>`));
  uniqSorted(DIR.flatMap(p=>p.areas||[p.area]).filter(Boolean)).forEach(a=>$("fArea").insertAdjacentHTML("beforeend",`<option>${a}</option>`));
  [[0,4,"Under 5"],[5,7,"5–7"],[8,11,"8–11"],[12,16,"12+"]].forEach(a=>$("fAge").insertAdjacentHTML("beforeend",`<option value="${a[0]}-${a[1]}">${a[2]}</option>`));
  WEEKS.forEach(w=>$("fWeek").insertAdjacentHTML("beforeend",`<option value="${w.id}">${w.label} · ${w.dates}</option>`));
  [[1,"Mondays"],[2,"Tuesdays"],[3,"Wednesdays"],[4,"Thursdays"],[5,"Fridays"]].forEach(d=>$("fDay").insertAdjacentHTML("beforeend",`<option value="${d[0]}">${d[1]}</option>`));
  [25,35,45,55].forEach(v=>$("fPrice").insertAdjacentHTML("beforeend",`<option value="${v}">≤ £${v}/day</option>`));
  const FLAGS=[["free","🎟️ Free / HAF"],["tfc","💳 Tax-Free Childcare"],["sibling","👨‍👩‍👧 Sibling discount"],["send","🧩 SEND aware"],["ofsted","✅ Ofsted"],["meals","🍽️ Meals included"],["working","🕘 Working-hours"]];
  $("flagChips").innerHTML=FLAGS.map(f=>`<button class="chip" data-flag="${f[0]}"><span class="dot">+</span>${f[1]}</button>`).join("");
}
function resetFilters(){
  ["q","fCat","fArea","fAge","fWeek","fDay","fLength","fPrice"].forEach(id=>{ const el=$(id); if(el) el.value=""; });
  if($("fSort")) $("fSort").value="featured";
  if($("fConfirmed")) $("fConfirmed").checked=false;
  state.flags.clear();
  document.querySelectorAll("#flagChips .chip").forEach(c=>c.classList.remove("active"));
  renderBrowse();
}

/* ---------- events ---------- */
function toggleSave(id){
  if(!state.session){ openAuth("login"); return; }
  if(state.saved.has(id)) state.saved.delete(id); else state.saved.add(id);
  persist();
  renderBrowse(); if(state.view==="saved") renderSaved();
  const m=$("acctMenu"); if(m){m.remove();}
}
document.addEventListener("click",e=>{
  const t=e.target.closest("[data-view],[data-auth],[data-flag],[data-tab],[data-open],[data-save],[data-close],[data-overlay],[data-sso],[data-mode],[data-add-child],[data-remove-child],[data-plan-action],[data-demo-seed],[data-dash-tab],[data-provider-action],[data-open-feature],[data-shared-plan]");
  if(!t){ const m=$("acctMenu"); if(m && !e.target.closest("#acctBtn")) m.remove(); return; }
  if(t.hasAttribute("data-stop")) return;            // let Book-now link work
  if(t.matches("[data-save]")){ e.stopPropagation(); toggleSave(t.dataset.save); return; }
  if(t.matches("[data-open]")){ if(e.target.closest("[data-save],[data-stop]"))return; openCamp(t.dataset.open); return; }
  if(t.matches("[data-close],[data-overlay]")){ if(t.matches("[data-overlay]")&&e.target!==t)return; closeModal(); return; }
  if(t.matches("[data-view]")){ const v=t.dataset.view; setView(v); return; }
  if(t.matches("[data-auth]")){ openAuth(t.dataset.auth); return; }
  if(t.matches("[data-mode]")){ openAuth(t.dataset.mode); return; }
  if(t.matches("[data-sso]")){ doLogin(t.dataset.sso==="Apple"?"Apple User":t.dataset.sso==="Google"?"Google User":"Facebook User", t.dataset.sso); return; }
  if(t.matches("[data-flag]")){ const f=t.dataset.flag; if(state.flags.has(f)){state.flags.delete(f);t.classList.remove("active");} else {state.flags.add(f);t.classList.add("active");} renderBrowse(); return; }
  if(t.matches("[data-tab]")){ state.tab=t.dataset.tab; syncTabs(); renderBrowse(); return; }
  if(t.matches("[data-demo-seed]")){ seedDemo(); return; }
  if(t.matches("[data-add-child]")){ const name=($("childName").value||("Child "+(state.children.length+1))).trim(); const age=parseInt($("childAge").value,10); if(!isFinite(age)){toast("Add an age first");return;} state.children.push({id:"child_"+Date.now()+"_"+Math.random().toString(36).slice(2,6),name,age}); persist(); renderBrowse(); return; }
  if(t.matches("[data-remove-child]")){ const id=t.dataset.removeChild; state.children=state.children.filter(ch=>ch.id!==id); Object.keys(state.coverPlan).forEach(k=>{if(k.startsWith(id+"::")) delete state.coverPlan[k];}); persist(); renderBrowse(); return; }
  if(t.matches("[data-plan-action]")){ const a=t.dataset.planAction; if(a==="summary") clipboard(planText(),"Plan summary copied"); if(a==="calendar") downloadCalendar(); if(a==="share") privateShare(); if(a==="print") window.print(); if(a==="clear") clearPlan(); return; }
  if(t.matches("[data-dash-tab]")){ state.dashTab=t.dataset.dashTab; renderDash(); return; }
  if(t.matches("[data-provider-action]")){ state.providerSetup[t.dataset.providerAction]=!state.providerSetup[t.dataset.providerAction]; persist(); renderDash(); return; }
  if(t.matches("[data-open-feature]")){ openFeaturePreview(t.dataset.openFeature); return; }
  if(t.matches("[data-shared-plan]")){ const p=modalRoot._sharedPlan; if(p){ if(t.dataset.sharedPlan==="replace"){state.children=p.children; state.coverPlan=p.coverPlan;} else {state.children=state.children.concat(p.children); Object.assign(state.coverPlan,p.coverPlan);} persist(); closeModal(); setView("planner"); toast("Shared plan loaded"); } return; }
});
document.addEventListener("click",e=>{ if(e.target.id==="authEmailBtn"){ doLogin($("authName").value||"Guest Parent","email"); } if(e.target.id==="resetFilters"){ resetFilters(); } });
document.addEventListener("change",e=>{
  const select=e.target.closest("[data-plan-select]");
  if(select){
    const val=select.value, child=select.dataset.child, week=select.dataset.week;
    if(!val) setPlanEntry(child,week,{});
    else if(val.startsWith("cover-")) setPlanEntry(child,week,{kind:"cover",coverId:val,label:select.options[select.selectedIndex].textContent,booked:false});
    else setPlanEntry(child,week,{kind:"provider",providerId:val,booked:false});
    renderBrowse(); return;
  }
  const booked=e.target.closest("[data-plan-booked]");
  if(booked){ const e2=planEntry(booked.dataset.child,booked.dataset.week); e2.booked=booked.checked; setPlanEntry(booked.dataset.child,booked.dataset.week,e2); renderBrowse(); return; }
  const check=e.target.closest("[data-check]");
  if(check){ if(check.checked) state.checklist.add(check.dataset.check); else state.checklist.delete(check.dataset.check); persist(); return; }
});
["q","fCat","fArea","fAge","fWeek","fDay","fLength","fPrice","fSort","fConfirmed"].forEach(id=>{
  const el=$(id); el.addEventListener(id==="q"?"input":"change",renderBrowse);
});

/* ---------- boot ---------- */
buildFilters();
renderAuth();
setView("find");
trySharedPlan();
