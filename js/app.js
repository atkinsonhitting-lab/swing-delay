import { db } from "./db.js";
import { cam } from "./camera.js";

const $ = (id) => document.getElementById(id);
const S = {
  profile: null, role: null,
  hitters: [], hitter: null,      // current hitter context
  swings: [], swing: null, swingUrl: null,
  tagFilter: "all"
};

export function toast(msg){
  const t = $("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(t._t);
  t._t = setTimeout(() => t.classList.remove("show"), 2600);
}
function show(id){
  document.querySelectorAll(".screen").forEach((s) => { s.hidden = s.id !== id; });
}
function esc(s){
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
}
function fmtDate(ts){
  const d = new Date(ts);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) + " " +
         d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

/* ================= boot ================= */
async function boot(){
  cam.init();
  cam.onToast = toast;
  if (!db.init()){ show("screen-setup"); wireSetup(); return; }
  db.onAuthChange((sess) => route(sess));
  let session = null;
  try { session = await db.session(); } catch(e){}
  route(session);
}

function wireSetup(){
  $("setupSave").onclick = () => {
    const u = $("setupUrl").value.trim(), k = $("setupKey").value.trim();
    if (!u || !k){ toast("Paste both the URL and the anon key."); return; }
    db.saveCreds(u, k);
    location.reload();
  };
  $("copySqlBtn").onclick = async () => {
    try {
      const r = await fetch("supabase/schema.sql", { cache: "no-store" });
      if (!r.ok) throw new Error("fetch failed");
      const sql = await r.text();
      await navigator.clipboard.writeText(sql);
      toast("SQL copied — paste it in the Supabase SQL editor and run it");
    } catch(e){
      toast("Copy failed — open supabase/schema.sql in the repo instead");
    }
  };
}

async function route(session){
  if (!session){ show("screen-auth"); wireAuth(); return; }
  let profile;
  try { profile = await db.myProfile(); }
  catch(e){ toast("Couldn't load profile: " + e.message); await db.signOut(); return; }
  S.profile = profile; S.role = profile.role || "coach";
  if (S.role === "coach"){ await loadRoster(); show("screen-roster"); }
  else {
    try { S.hitter = await db.myHitterRow(); } catch(e){ S.hitter = null; }
    if (!S.hitter){ show("screen-library"); renderClaim(); return; }
    await loadLibrary(); show("screen-library");
  }
}

/* ================= auth ================= */
let authWired = false;
function wireAuth(){
  if (authWired) return; authWired = true;
  document.querySelectorAll("#authTabs button").forEach((b) => {
    b.onclick = () => {
      document.querySelectorAll("#authTabs button").forEach((x) => x.classList.toggle("on", x === b));
      const su = b.dataset.tab === "signup";
      $("authLogin").hidden = su; $("authSignup").hidden = !su;
      $("authErr").hidden = true;
    };
  });
  $("suRole").onchange = () => { $("inviteWrap").hidden = $("suRole").value !== "hitter"; };
  $("loginBtn").onclick = async () => {
    authErr("");
    try {
      await db.signIn($("loginEmail").value.trim(), $("loginPass").value);
      route(await db.session());
    } catch(e){ authErr(e.message); }
  };
  $("signupBtn").onclick = async () => {
    authErr("");
    const name = $("suName").value.trim(), email = $("suEmail").value.trim(),
          pass = $("suPass").value, role = $("suRole").value,
          code = $("suCode").value.trim();
    if (!name || !email || !pass){ authErr("Fill in name, email and password."); return; }
    if (role === "hitter" && !code){ authErr("Enter the invite code from your coach."); return; }
    try {
      await db.signUp(email, pass, name, role);
      if (role === "hitter" && code){
        try { await db.claimHitter(code); }
        catch(e){ authErr("Account created, but the invite code failed: " + e.message); return; }
      }
      toast(role === "coach" ? "Coach account created" : "Linked to your coach ✓");
      route(await db.session());
    } catch(e){ authErr(e.message); }
  };
}
function authErr(m){
  const e = $("authErr");
  e.hidden = !m; e.textContent = m || "";
}

/* ================= roster (coach) ================= */
async function loadRoster(){
  let hitters = [];
  try { hitters = await db.myHitters(); }
  catch(e){ toast("Couldn't load roster: " + e.message); }
  S.hitters = hitters;
  const list = $("rosterList");
  if (!hitters.length){
    list.innerHTML = '<div class="empty">No hitters yet.<br/>Add your first hitter above.</div>';
    return;
  }
  list.innerHTML = "";
  hitters.forEach((h) => {
    const n = (h.swings && h.swings[0] && h.swings[0].count) || 0;
    const row = document.createElement("div");
    row.className = "hrow";
    row.innerHTML =
      '<div class="nm"><b>' + esc(h.name) + '</b><small>' + n + ' swings · code ' + esc(h.invite_code || "") + '</small></div>' +
      '<span class="badge">' + esc(h.bats || "") + '</span>';
    const film = document.createElement("button");
    film.className = "btn primary sm"; film.textContent = "Film";
    film.onclick = () => { S.hitter = h; openCamera(); };
    const lib = document.createElement("button");
    lib.className = "btn sm"; lib.textContent = "Swings";
    lib.onclick = () => { S.hitter = h; loadLibrary().then(() => show("screen-library")); };
    row.appendChild(film); row.appendChild(lib);
    list.appendChild(row);
  });
}
function wireRoster(){
  $("rosterSignout").onclick = async () => { await db.signOut(); location.reload(); };
  $("addHitterBtn").onclick = () => { $("hitterForm").hidden = !$("hitterForm").hidden; };
  $("nhSave").onclick = async () => {
    const name = $("nhName").value.trim(), bats = $("nhBats").value;
    if (!name){ toast("Type the hitter's name."); return; }
    try {
      const h = await db.createHitter(name, bats);
      $("nhName").value = ""; $("hitterForm").hidden = true;
      $("inviteName").textContent = h.name;
      $("inviteCode").textContent = h.invite_code;
      $("inviteCard").hidden = false;
      await loadRoster();
    } catch(e){ toast("Couldn't add hitter: " + e.message); }
  };
  $("inviteCopy").onclick = async () => {
    try { await navigator.clipboard.writeText($("inviteCode").textContent); toast("Code copied"); }
    catch(e){ toast("Copy failed"); }
  };
  $("inviteDone").onclick = () => { $("inviteCard").hidden = true; };
}

/* ================= camera ================= */
function openCamera(){
  if (!S.hitter){ toast("Pick a hitter first."); return; }
  $("camHitterChip").textContent = S.hitter.name + " ▾";
  cam.hitter = { id: S.hitter.id, name: S.hitter.name };
  cam.onClip = uploadClip;
  show("screen-camera");
  cam.sync();
}
async function uploadClip(blob, mime, meta){
  toast("Uploading swing…");
  try {
    await db.uploadSwing(S.hitter.id, blob, mime, meta);
    toast("Saved to " + S.hitter.name + " ✓");
  } catch(e){
    toast("Upload failed: " + (e.message || e));
  }
}
function wireCamera(){
  $("camBack").onclick = () => {
    cam.stop();
    if (S.role === "coach"){ loadRoster().then(() => show("screen-roster")); }
    else { loadLibrary().then(() => show("screen-library")); }
  };
  $("camHitterChip").onclick = () => {
    cam.stop();
    if (S.role === "coach"){ loadRoster().then(() => show("screen-roster")); }
  };
}

/* ================= library ================= */
async function loadLibrary(){
  if (!S.hitter) return;
  $("libTitle").textContent = S.hitter.name;
  let swings = [];
  try { swings = await db.listSwings(S.hitter.id); }
  catch(e){ toast("Couldn't load swings: " + e.message); }
  S.swings = swings;
  renderLibrary();
}
function swingMatches(s){
  const tags = (s.tags || []).map((t) => t.tag);
  if (S.tagFilter === "all") return true;
  if (S.tagFilter === "fav") return !!s.favorite;
  return tags.includes(S.tagFilter);
}
function renderLibrary(){
  const grid = $("swingGrid");
  const list = S.swings.filter(swingMatches);
  if (!S.swings.length){
    grid.innerHTML = '<div class="empty">No swings yet.<br/>Film from the camera screen — clips save here automatically.</div>';
    return;
  }
  if (!list.length){
    grid.innerHTML = '<div class="empty">No swings match this filter.</div>';
    return;
  }
  grid.innerHTML = "";
  list.forEach((s) => {
    const card = document.createElement("div");
    card.className = "scard";
    const v = document.createElement("video");
    v.preload = "metadata"; v.muted = true; v.playsInline = true;
    const meta = document.createElement("div");
    meta.className = "meta";
    const tags = (s.tags || []).map((t) => t.tag).join(" · ");
    meta.innerHTML = "<b>" + esc(fmtDate(s.taken_at)) + (s.favorite ? ' <span class="fav">★</span>' : "") + "</b>" +
      "<small>" + esc((s.clip_source === "auto" ? "auto" : "manual") + (tags ? " · " + tags : "")) + "</small>";
    card.appendChild(v); card.appendChild(meta);
    card.onclick = () => openDetail(s);
    grid.appendChild(card);
    db.swingUrl(s.video_path).then((u) => { v.src = u; }).catch(() => {});
  });
}
function renderClaim(){
  $("libTitle").textContent = "My swings";
  $("swingGrid").innerHTML =
    '<div class="empty">Your account isn\'t linked to a hitter yet.<br/>Enter the invite code from your coach.</div>' +
    '<div class="card form"><label class="field"><span>Invite code</span><input id="claimCode" type="text" placeholder="SD-XXXXXX"/></label>' +
    '<button id="claimBtn" class="btn primary">Link my account</button></div>';
  $("claimBtn").onclick = async () => {
    try {
      await db.claimHitter($("claimCode").value);
      S.hitter = await db.myHitterRow();
      toast("Linked ✓");
      await loadLibrary();
    } catch(e){ toast("That code didn't work: " + e.message); }
  };
}
function wireLibrary(){
  document.querySelectorAll("#tagFilters .f").forEach((b) => {
    b.onclick = () => {
      document.querySelectorAll("#tagFilters .f").forEach((x) => x.classList.toggle("on", x === b));
      S.tagFilter = b.dataset.f;
      renderLibrary();
    };
  });
  $("libBack").onclick = () => {
    if (S.role === "coach"){ loadRoster().then(() => show("screen-roster")); }
    else { openCamera(); }
  };
}

/* ================= swing detail ================= */
async function openDetail(s){
  S.swing = s; S.swingUrl = null;
  $("detTitle").textContent = fmtDate(s.taken_at);
  $("detFav").textContent = s.favorite ? "★" : "☆";
  $("detNote").value = s.note || "";
  renderTags(s);
  const v = $("detVideo");
  v.removeAttribute("src"); v.load();
  show("screen-detail");
  try {
    S.swingUrl = await db.swingUrl(s.video_path);
    v.src = S.swingUrl;
  } catch(e){ toast("Couldn't load video: " + e.message); }
}
function renderTags(s){
  const box = $("tagList");
  const tags = (s.tags || []).map((t) => t.tag);
  document.querySelectorAll("#tagRow .tag").forEach((b) => {
    b.classList.toggle("on", tags.includes(b.dataset.t));
  });
  box.innerHTML = "";
  tags.forEach((t) => {
    const c = document.createElement("span");
    c.className = "tagchip";
    c.innerHTML = esc(t) + '<span class="x">✕</span>';
    c.querySelector(".x").onclick = async () => {
      try { await db.removeTag(s.id, t); } catch(e){ toast(e.message); return; }
      s.tags = s.tags.filter((x) => x.tag !== t);
      renderTags(s); renderLibrary();
    };
    box.appendChild(c);
  });
}
function wireDetail(){
  const v = $("detVideo");
  document.querySelectorAll("#rateSeg button").forEach((b) => {
    b.onclick = () => {
      document.querySelectorAll("#rateSeg button").forEach((x) => x.classList.toggle("on", x === b));
      v.playbackRate = parseFloat(b.dataset.r);
      v.play().catch(() => {});
    };
  });
  const scrub = $("scrub"), scrubT = $("scrubT");
  v.addEventListener("timeupdate", () => {
    if (v.duration && !scrub._drag){
      scrub.value = Math.round((v.currentTime / v.duration) * 1000);
      scrubT.textContent = v.currentTime.toFixed(1) + "s";
    }
  });
  scrub.addEventListener("pointerdown", () => { scrub._drag = true; });
  scrub.addEventListener("pointerup", () => { scrub._drag = false; });
  scrub.addEventListener("input", () => {
    if (v.duration) v.currentTime = (scrub.value / 1000) * v.duration;
  });
  const step = (d) => {
    v.pause();
    v.currentTime = Math.min(Math.max(0, v.currentTime + d), v.duration || 0);
  };
  $("frameBack").onclick = () => step(-1 / 30);
  $("frameFwd").onclick = () => step(1 / 30);
  document.querySelectorAll("#tagRow .tag").forEach((b) => {
    b.onclick = async () => {
      const t = b.dataset.t, s = S.swing;
      const has = (s.tags || []).some((x) => x.tag === t);
      try {
        if (has) await db.removeTag(s.id, t); else await db.addTag(s.id, t);
      } catch(e){ toast(e.message); return; }
      const fresh = await db.getSwing(s.id);
      S.swing = fresh;
      const i = S.swings.findIndex((x) => x.id === s.id);
      if (i >= 0) S.swings[i] = fresh;
      renderTags(fresh); renderLibrary();
    };
  });
  $("customTagBtn").onclick = async () => {
    const t = $("customTag").value.trim(), s = S.swing;
    if (!t) return;
    try { await db.addTag(s.id, t); } catch(e){ toast(e.message); return; }
    $("customTag").value = "";
    const fresh = await db.getSwing(s.id);
    S.swing = fresh;
    const i = S.swings.findIndex((x) => x.id === s.id);
    if (i >= 0) S.swings[i] = fresh;
    renderTags(fresh); renderLibrary();
  };
  $("noteSave").onclick = async () => {
    try {
      await db.setNote(S.swing.id, $("detNote").value.trim());
      S.swing.note = $("detNote").value.trim();
      toast("Note saved");
    } catch(e){ toast(e.message); }
  };
  $("detFav").onclick = async () => {
    const fav = !S.swing.favorite;
    try { await db.setFavorite(S.swing.id, fav); } catch(e){ toast(e.message); return; }
    S.swing.favorite = fav;
    $("detFav").textContent = fav ? "★" : "☆";
    const i = S.swings.findIndex((x) => x.id === S.swing.id);
    if (i >= 0) S.swings[i] = fav;
    renderLibrary();
  };
  $("detDownload").onclick = async () => {
    try {
      const r = await fetch(S.swingUrl);
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = "swing-" + S.swing.id.slice(0, 8) + ".mp4";
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 8000);
    } catch(e){ toast("Download failed"); }
  };
  $("detShare").onclick = async () => {
    try {
      const r = await fetch(S.swingUrl);
      const blob = await r.blob();
      const file = new File([blob], "swing.mp4", { type: blob.type || "video/mp4" });
      if (navigator.canShare && navigator.canShare({ files: [file] })){
        await navigator.share({ files: [file], title: "Swing" });
      } else toast("Sharing isn't supported here — use Download.");
    } catch(e){}
  };
  $("detDelete").onclick = async () => {
    if (!confirm("Delete this swing?")) return;
    try { await db.deleteSwing(S.swing); }
    catch(e){ toast("Delete failed: " + e.message); return; }
    S.swings = S.swings.filter((x) => x.id !== S.swing.id);
    renderLibrary();
    show("screen-library");
  };
  $("detBack").onclick = () => show("screen-library");
}

/* ================= go ================= */
wireRoster();
wireCamera();
wireLibrary();
wireDetail();
boot();
