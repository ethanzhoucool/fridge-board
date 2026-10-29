import { createClient } from "@supabase/supabase-js";
import { resizeImage, blobToBase64, startRecording, wave, fmt } from "./media.js";
import { scanBoard, getKey, setKey } from "./scan.js";
import { sfx } from "./sfx.js";

const sb = createClient(import.meta.env.VITE_SUPABASE_URL, import.meta.env.VITE_SUPABASE_ANON_KEY);
const app = document.getElementById("app");
const sheet = document.getElementById("sheet");
const sheetWrap = document.getElementById("sheetWrap");

const S = { session: null, me: null, members: [], weeks: [], weekId: null, goals: [], posts: [], urls: {} };
const week = () => S.weeks.find((w) => w.id === S.weekId);
const member = (id) => S.members.find((m) => m.id === id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const $ = (sel, root = document) => root.querySelector(sel);

function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toast.t);
  toast.t = setTimeout(() => t.classList.remove("show"), 2600);
}
const fail = (e) => { console.error(e); toast(e?.message || "Something went wrong"); };

// ---------- Auth & membership ----------

const JOIN = "fridge.join";
const urlJoin = new URLSearchParams(location.search).get("join");
if (urlJoin) { try { localStorage.setItem(JOIN, urlJoin); } catch {} history.replaceState(null, "", location.pathname); }
const joinCode = () => { try { return localStorage.getItem(JOIN); } catch { return null; } };

let started = false;
sb.auth.onAuthStateChange((_e, session) => {
  const changed = !started || session?.user?.id !== S.session?.user?.id;
  started = true;
  S.session = session;
  if (changed) setTimeout(boot);
});

async function boot() {
  if (!S.session) return renderSignIn();
  app.innerHTML = `<div class="skeleton" style="width:40%;height:34px"></div><div class="skeleton"></div><div class="skeleton"></div><div class="skeleton" style="width:70%"></div>`;
  const { data } = await sb.from("members").select("*").eq("user_id", S.session.user.id).maybeSingle();
  S.me = data;
  if (!S.me) return renderJoin();
  await refresh();
  subscribe();
}

function renderSignIn() {
  app.innerHTML = `<div class="center">
    <h1 class="hand">Fridge.</h1>
    <p>Our weekly board. Goals, voice notes, proof.</p>
    <button class="google" id="g"><i class="ph-bold ph-google-logo"></i>Continue with Google</button>
  </div>`;
  $("#g").onclick = () => sb.auth.signInWithOAuth({ provider: "google", options: { redirectTo: location.origin } });
}

async function renderJoin() {
  const code = joinCode();
  const { data: setup } = await sb.rpc("needs_setup");
  if (!code && !setup) {
    app.innerHTML = `<div class="center"><h1 class="hand">Almost.</h1><p>Ask someone on the board for the invite link, then open it here.</p>
      <button class="ghost" id="out">Sign out</button></div>`;
    $("#out").onclick = () => sb.auth.signOut();
    return;
  }
  const { data: names, error } = await sb.rpc("open_names", { code });
  if (error) return fail(error);
  const first = S.session.user.user_metadata?.full_name?.split(" ")[0] || "";
  app.innerHTML = `<div class="center"><h1 class="hand">Who are you?</h1>
    ${names.length ? `<div class="strip" style="justify-content:center;flex-wrap:wrap">${names.map((n) => `<button class="chip pick" data-n="${esc(n)}">${esc(n)}</button>`).join("")}</div><p>or</p>` : ""}
    <input class="field" id="nm" placeholder="Your name" value="${names.length ? "" : esc(first)}" style="max-width:260px;text-align:center">
    <button class="primary" id="go">Join the board</button>
    <button class="ghost" id="out">Sign out</button></div>`;
  const join = async (name) => {
    if (!name.trim()) return toast("Type your name");
    const { error } = await sb.rpc("join_group", { code, member_name: name });
    if (error) return fail(error);
    try { localStorage.removeItem(JOIN); } catch {}
    boot();
  };
  app.querySelectorAll(".pick").forEach((b) => (b.onclick = () => join(b.dataset.n)));
  $("#go").onclick = () => join($("#nm").value);
  $("#out").onclick = () => sb.auth.signOut();
}

// ---------- Data ----------

async function refresh(keepWeek = true) {
  const [m, w] = await Promise.all([
    sb.from("members").select("*").order("created_at"),
    sb.from("weeks").select("*").order("number", { ascending: false }),
  ]);
  if (m.error || w.error) return fail(m.error || w.error);
  S.members = m.data;
  S.weeks = w.data;
  if (!keepWeek || !week()) S.weekId = S.weeks[0]?.id ?? null;
  if (S.weekId) {
    const [g, p] = await Promise.all([
      sb.from("goals").select("*").eq("week_id", S.weekId).order("position"),
      sb.from("posts").select("*").eq("week_id", S.weekId).order("created_at", { ascending: false }),
    ]);
    if (g.error || p.error) return fail(g.error || p.error);
    S.goals = g.data;
    S.posts = p.data;
    const need = S.posts.map((x) => x.media_path).filter((path) => path && !S.urls[path]);
    if (need.length) {
      const { data } = await sb.storage.from("media").createSignedUrls(need, 60 * 60 * 6);
      data?.forEach((d) => d.signedUrl && (S.urls[d.path] = d.signedUrl));
    }
  } else {
    S.goals = [];
    S.posts = [];
  }
  if (notesOpen) markSeen();
  render();
  if (notesOpen) { drawNotes(); drawCtx(); }
}

let channel, refreshT;
let saving = 0; // optimistic taps still in flight; refreshing now would show stale counts
function subscribe() {
  if (channel) return;
  const later = () => { clearTimeout(refreshT); refreshT = setTimeout(() => (saving ? later() : refresh()), 400); };
  channel = sb.channel("board");
  for (const table of ["posts", "goals", "weeks"]) channel.on("postgres_changes", { event: "*", schema: "public", table }, later);
  channel.subscribe();
  document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && later());
}

// ---------- Board ----------

function weekRange(w) {
  const d = new Date(w.starts_on + "T00:00");
  const e = new Date(d); e.setDate(d.getDate() + 6);
  const f = (x) => x.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return `${f(d)} – ${f(e)}`;
}

const menuBtn = `<button class="menu-btn" data-act="menu" aria-label="Menu"><i class="ph ph-list"></i></button>`;

function render() {
  const w = week();
  clearTimeout(pendingT);
  pending = null;
  if (!w) {
    app.innerHTML = `<header><h1 class="hand">Fridge.</h1>${menuBtn}</header>
      <div class="center" style="min-height:60dvh"><p>No board yet. Snap the fridge and the goals fill in.</p>
      <button class="primary" data-act="scan">Scan the board</button>
      <button class="ghost" data-act="blank">Start blank</button></div>`;
    return wire();
  }
  const shared = [];
  if (w.group_goal) shared.push({ label: w.group_goal, done: w.group_done, i: -1 });
  w.fun.forEach((f, i) => shared.push({ ...f, i }));
  const latest = w.id === S.weeks[0]?.id;
  const sub = w.charity ? `Charity · ${esc(w.charity)}` : weekRange(w);

  app.innerHTML = `
    <header>
      <div><h1 class="hand">Week ${w.number}.</h1><p class="sub">${latest ? sub : `Past week · ${weekRange(w)}`}</p></div>
      ${menuBtn}
    </header>
    ${shared.length ? `<section class="shared hand">${shared.map((c) => `<button class="chk ${c.done ? "on" : ""}" data-chip="${c.i}">${esc(c.label)}${box}</button>`).join("")}</section>` : ""}
    <section class="people">${S.members.map(personBlock).join("")}</section>
    ${lately()}
    ${notesBar()}`;
  wire();
  showAfter();
}

const box = `<svg class="box" viewBox="0 0 17 17" aria-hidden="true"><path d="M1.6 2.2 L15.2 1.6 L15.6 15.1 L1.9 15.6 Z"/><path class="tick" d="M4.5 9.2 L7.4 12.4 L14.8 3.2"/></svg>`;

function notesBar() {
  const fresh = unread();
  return `<button class="bar" data-act="notes"><i class="ph ph-notepad"></i>Notes${fresh ? `<span class="new">${fresh} new</span>` : S.posts.length ? `<span class="n">${S.posts.length}</span>` : ""}</button>`;
}

// The week so far, right on the board: a strip of photos and the last few notes.
function lately() {
  if (!S.posts.length) return "";
  const pics = S.posts.filter((p) => p.kind === "photo" && S.urls[p.media_path]);
  const recent = S.posts.slice(0, 3);
  const line = (p) => {
    const g = p.goal_id && S.goals.find((x) => x.id === p.goal_id);
    const what = p.kind === "voice" ? `<i class="ph ph-waveform"></i>${fmt(p.duration || 0)}` : p.kind === "photo" ? `<i class="ph ph-image"></i>${esc(p.body || "Photo")}` : esc(p.body);
    return `<button class="line" data-line="${p.goal_id || ""}"><b>${esc(member(p.member_id)?.name)}</b><span class="what">${what}</span>${g ? `<span class="on">${esc(g.label)}</span>` : ""}<span class="when">${ago(p.created_at)}</span></button>`;
  };
  return `<section class="lately">
    <h2 class="hand">Lately</h2>
    ${pics.length ? `<div class="pics">${pics.map((p) => `<button data-pic="${esc(p.media_path)}"><img src="${esc(S.urls[p.media_path])}" alt="" loading="lazy"></button>`).join("")}</div>` : ""}
    ${recent.map(line).join("")}
  </section>`;
}

// Notes and photos on a goal show as a small badge on its row; tap it for the goal's thread.
function badge(g) {
  const ps = goalPosts(g.id);
  if (!ps.length) return "";
  const pic = ps.find((p) => p.kind === "photo" && S.urls[p.media_path]);
  return `<button class="att ${pic ? "pic" : ""}" data-open="${g.id}" aria-label="${ps.length} on ${esc(g.label)}">${pic ? `<img src="${esc(S.urls[pic.media_path])}" alt="">` : `<i class="ph ph-chat-circle"></i>`}${ps.length > 1 || !pic ? `<span>${ps.length}</span>` : ""}</button>`;
}

function personBlock(m) {
  const goals = S.goals.filter((g) => g.member_id === m.id);
  if (!goals.length && m.id !== S.me.id) return "";
  const mine = m.id === S.me.id;
  return `<div class="person hand ${mine ? "mine" : ""}">
    <h2>${esc(m.name)}</h2>
    ${goals.length ? goals.map((g) => `<div class="goal ${g.done >= g.target ? "full" : ""}" data-goal="${g.id}" role="button" tabindex="0">
        <span class="t">${esc(g.label)}${g.note ? `<small>${esc(g.note)}</small>` : ""}${strike}</span>${badge(g)}${tally(g)}</div>`).join("")
      : `<button class="goal empty" data-act="mine">Add your goals</button>`}
  </div>`;
}

const strike = `<svg class="strike" viewBox="0 0 100 10" preserveAspectRatio="none" aria-hidden="true"><path d="M1 6.5 C 18 3.5, 34 8, 52 5.5 S 84 3.5, 99 5"/></svg>`;

// Hand-drawn tally: four strokes and a slash per group of five. Marks still to go are drawn faintly,
// and a mark waiting for confirmation pulses.
const rnd = (s) => { const x = Math.sin(s * 999.7) * 43758.5453; return x - Math.floor(x); };
function tally(g, fresh = false, pending = false) {
  const W = 8.5, GAP = 10, H = 20, parts = [];
  let x = 1, start = 1;
  for (let k = 0; k < g.target; k++) {
    const cls = (k < g.done ? "on" : pending && k === g.done ? "pend" : "off") + (fresh && k === g.done - 1 ? " new" : "");
    const j = (n) => (rnd(g.id * 31 + k * 7 + n) - 0.5) * 2.4;
    if (k % 5 === 4) {
      parts.push(`<path class="${cls}" d="M${start - 3 + j(1)} ${H - 4 + j(2)} Q${(start + x) / 2} ${H / 2 + j(3)} ${x + 1 + j(4)} ${4 + j(5)}"/>`);
      x += GAP; start = x;
    } else {
      parts.push(`<path class="${cls}" d="M${x + j(1)} ${2 + j(2) * 0.6} Q${x + j(3)} ${H / 2} ${x + 1.2 + j(4)} ${H - 2 + j(5) * 0.6}"/>`);
      x += W;
    }
  }
  return `<svg class="tally" viewBox="-4 0 ${x + 4} ${H}" width="${x + 4}" height="${H}" aria-label="${g.done} of ${g.target}">${parts.join("")}</svg>`;
}

function wire() {
  app.querySelectorAll("[data-act]").forEach((b) => (b.onclick = () => actions[b.dataset.act]()));
  app.querySelectorAll("[data-chip]").forEach((b) => (b.onclick = () => toggleChip(+b.dataset.chip, b)));
  app.querySelectorAll("[data-pic]").forEach((b) => (b.onclick = () => zoom(S.urls[b.dataset.pic])));
  app.querySelectorAll("[data-line]").forEach((b) => (b.onclick = () => openNotes(b.dataset.line ? { goal: +b.dataset.line } : {})));
}

// Your own tallies only. Tap shows the next mark with confirm and photo buttons; press and hold rubs one out.
// Anyone else's goal opens its notes.
const SKIP = ".ok, .cam, .att";
let hold, held, downAt, pending = null, pendingT, afterT, afterId = null;
app.addEventListener("pointerdown", (e) => {
  const r = e.target.closest(".mine .goal[data-goal]");
  if (!r || e.target.closest(SKIP)) return;
  held = false; downAt = [e.clientX, e.clientY];
  hold = setTimeout(() => { held = true; navigator.vibrate?.(10); cancelPending(); change(+r.dataset.goal, -1); }, 450);
});
app.addEventListener("pointermove", (e) => { if (downAt && Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 8) { clearTimeout(hold); downAt = null; } });
app.addEventListener("pointercancel", () => { clearTimeout(hold); downAt = null; });
app.addEventListener("pointerup", (e) => {
  clearTimeout(hold);
  const r = e.target.closest(".mine .goal[data-goal]");
  if (r && downAt && !held && !e.target.closest(SKIP)) {
    const id = +r.dataset.goal;
    pending === id ? cancelPending() : askConfirm(id);
  }
  downAt = null;
});
app.addEventListener("click", (e) => {
  const att = e.target.closest("[data-open]");
  if (att) return openNotes({ goal: +att.dataset.open });
  const cam = e.target.closest(".cam");
  if (cam) return snap(+cam.closest("[data-goal]").dataset.goal, cam.classList.contains("now"));
  if (e.target.closest(".ok")) { const id = pending; cancelPending(); change(id, 1); return offerPhoto(id); }
  const other = e.target.closest(".goal[data-goal]");
  if (other && !other.closest(".mine")) openNotes({ goal: +other.dataset.goal });
});
app.addEventListener("keydown", (e) => {
  const r = e.target.closest?.(".goal[data-goal]");
  if (r && (e.key === "Enter" || e.key === " ") && e.target === r) { e.preventDefault(); r.closest(".mine") ? askConfirm(+r.dataset.goal) : openNotes({ goal: +r.dataset.goal }); }
});
document.addEventListener("pointerdown", (e) => { if (pending && !e.target.closest(`[data-goal="${pending}"]`)) cancelPending(); });
app.addEventListener("contextmenu", (e) => e.target.closest(".mine .goal") && e.preventDefault());

function askConfirm(id) {
  cancelPending();
  const g = S.goals.find((x) => x.id === id);
  if (!g || g.done >= g.target) return toast("Done. Hold to rub one out.");
  pending = id;
  const row = app.querySelector(`[data-goal="${id}"]`);
  row.classList.add("pending");
  row.querySelector(".tally").outerHTML = tally(g, false, true);
  clearAfter();
  row.insertAdjacentHTML("beforeend", `<button class="cam now" aria-label="Mark ${esc(g.label)} with a photo"><i class="ph ph-camera"></i></button><button class="ok" aria-label="Confirm ${esc(g.label)}"><i class="ph-bold ph-check"></i></button>`);
  pendingT = setTimeout(cancelPending, 5000);
}

function cancelPending() {
  clearTimeout(pendingT);
  if (pending == null) return;
  const row = app.querySelector(`[data-goal="${pending}"]`);
  const g = S.goals.find((x) => x.id === pending);
  pending = null;
  if (!row || !g) return;
  row.classList.remove("pending");
  row.querySelectorAll(".ok, .cam").forEach((b) => b.remove());
  row.querySelector(".tally").outerHTML = tally(g);
}

// Just marked without a photo: a camera lingers on the row for a few seconds to add one after.
function offerPhoto(id) {
  clearAfter();
  afterId = id;
  showAfter();
  afterT = setTimeout(clearAfter, 4000);
}
// Also called after a re-render, so a realtime refresh doesn't take the camera away.
function showAfter() {
  const row = afterId != null && app.querySelector(`[data-goal="${afterId}"]`);
  if (row && !$(".cam.after", row)) row.insertAdjacentHTML("beforeend", `<button class="cam after" aria-label="Add a photo"><i class="ph ph-camera-plus"></i></button>`);
}
function clearAfter() {
  clearTimeout(afterT);
  afterId = null;
  app.querySelectorAll(".cam.after").forEach((b) => b.remove());
}

// Camera on a goal row. The file picker has to open inside the tap, so it goes first.
function snap(id, mark) {
  const file = pickFile("image/*");
  if (mark) { cancelPending(); change(id, 1); } else clearAfter();
  file.then((f) => f && openNotes({ goal: id }, f, !mark));
}

async function change(id, d) {
  const g = S.goals.find((x) => x.id === id);
  const next = Math.min(g.target, Math.max(0, g.done + d));
  if (!g || next === g.done) return;
  const finished = next === g.target && g.done < g.target;
  g.done = next;
  const row = app.querySelector(`[data-goal="${id}"]`);
  row.querySelector(".tally").outerHTML = tally(g, d > 0);
  row.classList.toggle("full", g.done >= g.target);
  if (finished) celebrate(row);
  else d > 0 ? sfx.mark() : sfx.erase();
  saving++;
  const { error } = await sb.from("goals").update({ done: g.done }).eq("id", id);
  saving--;
  if (error) fail(error);
}

// Goal finished: the strike draws through, the line bounces, ink flecks fly off the tally, and it chimes.
function celebrate(row) {
  sfx.done();
  navigator.vibrate?.([12, 60, 18]);
  row.classList.remove("celebrate");
  void row.offsetWidth;
  row.classList.add("celebrate");
  const t = row.querySelector(".tally").getBoundingClientRect(), r = row.getBoundingClientRect();
  const burst = document.createElement("span");
  burst.className = "burst";
  burst.style.left = `${t.left - r.left + t.width / 2}px`;
  burst.style.top = `${t.top - r.top + t.height / 2}px`;
  burst.innerHTML = Array.from({ length: 10 }, (_, i) => {
    const a = (i / 10) * Math.PI * 2 + Math.random() * 0.5, dist = 18 + Math.random() * 16;
    return `<i style="--x:${Math.cos(a) * dist}px;--y:${Math.sin(a) * dist}px;--s:${0.6 + Math.random() * 0.7}"></i>`;
  }).join("");
  row.append(burst);
  setTimeout(() => burst.remove(), 800);
}

async function toggleChip(i, btn) {
  const w = week();
  const patch = i < 0 ? { group_done: !w.group_done } : { fun: w.fun.map((f, k) => (k === i ? { ...f, done: !f.done } : f)) };
  Object.assign(w, patch);
  btn.classList.toggle("on");
  saving++;
  const { error } = await sb.from("weeks").update(patch).eq("id", w.id);
  saving--;
  if (error) fail(error);
}

// ---------- Notes ----------

function ago(ts) {
  const s = (Date.now() - new Date(ts)) / 1000;
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return new Date(ts).toLocaleDateString(undefined, { weekday: "short" });
}

function dayLabel(ts) {
  const d = new Date(ts), today = new Date();
  const days = Math.round((new Date(today.toDateString()) - new Date(d.toDateString())) / 864e5);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  return d.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
}

// Tags live in the note text as #hashtags, so they need nothing extra in the database.
const TAG = /(^|\s)#([\p{L}\p{N}_-]{1,24})/gu;
const QUICK_TAGS = ["win", "stuck", "idea", "proud", "help"];
const tagsOf = (body) => [...String(body || "").matchAll(TAG)].map((m) => m[2].toLowerCase());
const rich = (body) => esc(body).replace(TAG, (_, sp, t) => `${sp}<button class="tag" data-tag="${t.toLowerCase()}">#${t}</button>`);
const goalPosts = (id) => S.posts.filter((p) => p.goal_id === id);

// Unread: the newest note you've seen this week, kept on this device.
const seenKey = () => `fridge.seen.${S.weekId}`;
const seenAt = () => { try { return localStorage.getItem(seenKey()) || ""; } catch { return ""; } };
const unread = () => S.posts.filter((p) => p.member_id !== S.me.id && p.created_at > seenAt()).length;
function markSeen() {
  const top = S.posts[0]?.created_at;
  if (top && top > seenAt()) try { localStorage.setItem(seenKey(), top); } catch {}
}

function noteBlock(p) {
  const who = member(p.member_id);
  const goal = p.goal_id && S.goals.find((g) => g.id === p.goal_id);
  const head = `<div class="who"><b>${esc(who?.name)}</b>${ago(p.created_at)}
    ${goal && nf.goal !== goal.id ? `<button class="about" data-about="${goal.id}"><i class="ph ph-target"></i>${esc(goal.label)}</button>` : ""}
    ${p.member_id === S.me.id ? `<button class="del" data-del="${p.id}" aria-label="Delete"><i class="ph ph-x"></i></button>` : ""}</div>`;
  const text = p.body ? `<p class="hand">${rich(p.body)}</p>` : "";
  if (p.kind === "photo") return `<div class="note">${head}<img src="${esc(S.urls[p.media_path] || "")}" alt="" loading="lazy" data-zoom="${esc(p.media_path)}">${text}</div>`;
  if (p.kind === "text") return `<div class="note">${head}${text}</div>`;
  return `<div class="note">${head}<button class="vn" data-play="${p.id}"><span class="play"><i class="ph-fill ph-play"></i></span>
    <span class="wave">${wave(p.id, 32).map((h) => `<i style="height:${Math.round(h * 100)}%"></i>`).join("")}</span><span class="len">${fmt(p.duration || 0)}</span></button>${text}</div>`;
}

// What the notes sheet is showing: everything, or one goal's thread, narrowed by a filter chip.
let notesOpen = false;
let nf = { goal: null, view: "all" };

function shown() {
  return S.posts.filter((p) => {
    if (nf.goal && p.goal_id !== nf.goal) return false;
    if (nf.view === "photos") return p.kind === "photo";
    if (nf.view.startsWith("m:")) return p.member_id === nf.view.slice(2);
    if (nf.view.startsWith("t:")) return tagsOf(p.body).includes(nf.view.slice(2));
    return true;
  });
}

function drawNotes() {
  const list = $("#notes", sheet), head = $("#nhead", sheet);
  if (!list) return;
  const g = nf.goal && S.goals.find((x) => x.id === nf.goal);
  if (nf.goal && !g) nf.goal = null;
  if (g) {
    const who = member(g.member_id);
    head.innerHTML = `<button class="back" data-clear><i class="ph ph-caret-left"></i>All notes</button>
      <h3>${esc(g.label)}</h3><p class="sub">${esc(who?.name)} · ${g.done} of ${g.target}${g.note ? ` · ${esc(g.note)}` : ""}</p>`;
  } else {
    const people = S.members.filter((m) => S.posts.some((p) => p.member_id === m.id));
    const tags = [...new Set(S.posts.flatMap((p) => tagsOf(p.body)))];
    const chip = (v, label) => `<button class="chip ${nf.view === v ? "sel" : ""}" data-view="${esc(v)}">${label}</button>`;
    head.innerHTML = S.posts.length ? `<div class="filters">${chip("all", "All")}${S.posts.some((p) => p.kind === "photo") ? chip("photos", '<i class="ph ph-image"></i>Photos') : ""}
      ${people.map((m) => chip(`m:${m.id}`, esc(m.name))).join("")}${tags.map((t) => chip(`t:${t}`, `#${esc(t)}`)).join("")}</div>` : "";
  }
  const items = shown();
  let last = "";
  list.innerHTML = items.length
    ? items.map((p) => { const d = dayLabel(p.created_at); const h = d !== last ? `<h4 class="day">${d}</h4>` : ""; last = d; return h + noteBlock(p); }).join("")
    : `<p class="none">${g ? `Nothing on ${esc(g.label)} yet. Add a photo or say how it went.` : S.posts.length ? "Nothing matches." : "Nothing yet. Say how it's going."}</p>`;
  head.querySelectorAll("[data-view]").forEach((b) => (b.onclick = () => { nf.view = b.dataset.view; drawNotes(); }));
  $("[data-clear]", head) && ($("[data-clear]", head).onclick = () => { nf = { goal: null, view: "all" }; draft.goalId = null; drawNotes(); drawCtx(); });
  list.querySelectorAll("[data-play]").forEach((b) => (b.onclick = () => play(b, +b.dataset.play)));
  list.querySelectorAll("[data-del]").forEach((b) => (b.onclick = () => delPost(+b.dataset.del)));
  list.querySelectorAll("[data-zoom]").forEach((im) => (im.onclick = () => zoom(S.urls[im.dataset.zoom])));
  list.querySelectorAll("[data-tag]").forEach((b) => (b.onclick = () => { nf = { goal: null, view: `t:${b.dataset.tag}` }; drawNotes(); list.scrollTo(0, 0); }));
  list.querySelectorAll("[data-about]").forEach((b) => (b.onclick = () => { nf = { goal: +b.dataset.about, view: "all" }; draft.goalId = nf.goal; drawNotes(); drawCtx(); list.scrollTo(0, 0); }));
  markSeen();
}

function openNotes(filter = {}, file = null, offerMark = true) {
  openSheet(`<div class="nhead" id="nhead"></div><div class="notes" id="notes"></div><div class="ctx" id="ctx" hidden></div><div class="compose" id="cmp"></div>`, "notes-sheet");
  nf = { goal: null, view: "all", ...filter };
  resetDraft();
  notesOpen = true;
  onClose = resetDraft;
  drawNotes();
  render();
  compose();
  if (file) attachPhoto(file, false, offerMark);
}

const lb = $("#lb");
function zoom(src) {
  if (!src) return;
  $("img", lb).src = src;
  lb.classList.add("open");
}
lb.onclick = () => lb.classList.remove("open");
document.addEventListener("keydown", (e) => e.key === "Escape" && lb.classList.remove("open"));

const audio = new Audio();
let playing = null;
function play(btn, id) {
  const p = S.posts.find((x) => x.id === id);
  const icon = btn.querySelector(".play");
  const bars = [...btn.querySelectorAll(".wave i")];
  const reset = () => { bars.forEach((b) => b.classList.remove("on")); icon.innerHTML = '<i class="ph-fill ph-play"></i>'; };
  if (playing === id) { audio.pause(); playing = null; return reset(); }
  sheet.querySelectorAll(".vn .play").forEach((el) => (el.innerHTML = '<i class="ph-fill ph-play"></i>'));
  sheet.querySelectorAll(".wave i.on").forEach((el) => el.classList.remove("on"));
  playing = id;
  audio.src = S.urls[p.media_path];
  audio.ontimeupdate = () => {
    const dur = isFinite(audio.duration) ? audio.duration : p.duration || 1;
    const n = Math.round((audio.currentTime / dur) * bars.length);
    bars.forEach((b, k) => b.classList.toggle("on", k < n));
  };
  audio.onended = () => { playing = null; reset(); };
  icon.innerHTML = '<i class="ph-fill ph-pause"></i>';
  audio.play().catch(fail);
}

async function delPost(id) {
  if (!confirm("Delete this note?")) return;
  const p = S.posts.find((x) => x.id === id);
  const { error } = await sb.from("posts").delete().eq("id", id);
  if (error) return fail(error);
  if (p.media_path) sb.storage.from("media").remove([p.media_path]);
  S.posts = S.posts.filter((x) => x.id !== id);
  drawNotes();
  render();
}

// ---------- Sheets ----------

let onClose = null;
function openSheet(html, kind = "") {
  onClose?.();
  onClose = null;
  notesOpen = false;
  closeMenu();
  sheet.className = `sheet ${kind}`;
  sheet.innerHTML = html;
  sheetWrap.classList.add("open");
}
function closeSheet() {
  onClose?.();
  onClose = null;
  notesOpen = false;
  audio.pause(); playing = null;
  sheetWrap.classList.remove("open");
}
$(".sheet-bg").onclick = closeSheet;

const menu = $("#menu");
function closeMenu() { document.body.classList.remove("menu-open"); }
$(".menu-bg").onclick = closeMenu;
menu.querySelectorAll("[data-act]").forEach((b) => (b.onclick = () => { closeMenu(); actions[b.dataset.act](); }));

function pickFile(accept, capture) {
  return new Promise((res) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    if (capture) input.capture = "environment";
    input.onchange = () => res(input.files[0] || null);
    input.click();
  });
}

async function upload(blob, ext) {
  const path = `${S.me.id}/${crypto.randomUUID()}.${ext}`;
  const { error } = await sb.storage.from("media").upload(path, blob, { contentType: blob.type });
  if (error) throw error;
  return path;
}

async function addPost(row) {
  const { error } = await sb.from("posts").insert({ week_id: S.weekId, member_id: S.me.id, ...row });
  if (error) throw error;
  await refresh();
}

function busy(btn, label = "Posting") {
  btn.disabled = true;
  btn.innerHTML = `<i class="ph ph-circle-notch spin"></i> ${label}`;
}

// What the next note will carry: a photo, the goal it's about, tags, and whether it also adds a tally mark.
let draft;
function resetDraft() {
  if (draft?.url) URL.revokeObjectURL(draft.url);
  draft = { goalId: nf.goal, tags: new Set(), blob: null, url: null, mark: false, offerMark: true };
}
resetDraft();

async function attachPhoto(file, mark = false, offerMark = true) {
  const blob = await resizeImage(file).catch(() => null);
  if (!blob) return toast("Couldn't open that image");
  if (draft.url) URL.revokeObjectURL(draft.url);
  Object.assign(draft, { blob, url: URL.createObjectURL(blob), mark, offerMark });
  write();
}

// Above the input while writing or recording: the attached photo, which goal it's about, and tags.
function drawCtx() {
  const c = $("#ctx", sheet), mode = $("#cmp", sheet)?.className || "";
  if (!c) return;
  c.hidden = !/write|rec/.test(mode);
  if (c.hidden) return;
  const mine = S.goals.filter((g) => g.member_id === S.me.id);
  const others = S.goals.filter((g) => g.member_id !== S.me.id);
  const tags = [...new Set([...QUICK_TAGS, ...S.posts.flatMap((p) => tagsOf(p.body))])];
  const g = S.goals.find((x) => x.id === draft.goalId);
  const canMark = draft.blob && draft.offerMark && g?.member_id === S.me.id && g.done < g.target;
  const goalChip = (x) => `<button class="chip ${draft.goalId === x.id ? "sel" : ""}" data-g="${x.id}"><i class="ph ph-target"></i>${esc(x.label)}${x.member_id !== S.me.id ? ` <small>${esc(member(x.member_id)?.name?.[0] || "")}</small>` : ""}</button>`;
  c.innerHTML = `${draft.url ? `<span class="thumb"><img src="${draft.url}" alt="Attached photo"><button data-unpic aria-label="Remove photo"><i class="ph-bold ph-x"></i></button></span>` : ""}
    <div class="chips">
      ${!draft.blob && /write/.test(mode) ? `<button class="chip" data-pic><i class="ph ph-camera"></i>Photo</button>` : ""}
      ${canMark ? `<button class="chip ${draft.mark ? "sel" : ""}" data-mark><i class="ph ph-plus"></i>Mark</button>` : ""}
      ${nf.goal ? (g ? goalChip(g) : "") : [...mine, ...others].map(goalChip).join("")}
      ${tags.map((t) => `<button class="chip ${draft.tags.has(t) ? "sel" : ""}" data-t="${esc(t)}">#${esc(t)}</button>`).join("")}
    </div>`;
  c.querySelectorAll("[data-g]").forEach((b) => (b.onclick = () => { draft.goalId = draft.goalId === +b.dataset.g ? null : +b.dataset.g; drawCtx(); }));
  c.querySelectorAll("[data-t]").forEach((b) => (b.onclick = () => { draft.tags.has(b.dataset.t) ? draft.tags.delete(b.dataset.t) : draft.tags.add(b.dataset.t); b.classList.toggle("sel"); }));
  $("[data-mark]", c) && ($("[data-mark]", c).onclick = () => { draft.mark = !draft.mark; drawCtx(); });
  $("[data-unpic]", c) && ($("[data-unpic]", c).onclick = () => { URL.revokeObjectURL(draft.url); Object.assign(draft, { blob: null, url: null, mark: false }); write(); });
  $("[data-pic]", c) && ($("[data-pic]", c).onclick = () => pickFile("image/*").then((f) => f && attachPhoto(f)));
  if (draft.url) $("[data-unpic]", c).previousElementSibling.onclick = () => zoom(draft.url);
}

// Selected tag chips go on the end of the text, unless already typed.
function withTags(body) {
  const have = tagsOf(body);
  const extra = [...draft.tags].filter((t) => !have.includes(t)).map((t) => `#${t}`).join(" ");
  return [body, extra].filter(Boolean).join(" ") || null;
}

// The bottom of the notes sheet: close, camera, mic, pen. Each swaps in place.
function compose() {
  const c = $("#cmp", sheet);
  if (!c) return;
  c.className = "compose";
  c.innerHTML = `<button class="round" id="x" aria-label="Close"><i class="ph ph-x"></i></button>
    <button class="round mic" id="mic" aria-label="Record a voice note"><i class="ph-fill ph-microphone"></i></button>
    <button class="round" id="pen" aria-label="Write a note"><i class="ph ph-pen-nib"></i></button>
    <button class="round" id="cam" aria-label="Add a photo"><i class="ph ph-camera"></i></button>`;
  $("#x", c).onclick = closeSheet;
  $("#mic", c).onclick = record;
  $("#pen", c).onclick = write;
  $("#cam", c).onclick = () => pickFile("image/*").then((f) => f && attachPhoto(f));
  drawCtx();
}

function write() {
  const c = $("#cmp", sheet);
  if (!c) return;
  const kept = $("#tx", c)?.value || "";
  c.className = "compose write";
  c.innerHTML = `<button class="round sm" id="back" aria-label="Back"><i class="ph ph-caret-left"></i></button>
    <textarea id="tx" class="hand" rows="1" maxlength="2000" placeholder="${draft.blob ? "Add a caption" : "Write it on the board"}"></textarea>
    <button class="round sm send" id="ok" aria-label="Post"><i class="ph ph-arrow-up"></i></button>`;
  const tx = $("#tx", c);
  tx.value = kept;
  tx.oninput = () => { tx.style.height = "auto"; tx.style.height = Math.min(tx.scrollHeight, 140) + "px"; };
  tx.oninput();
  tx.focus();
  drawCtx();
  $("#back", c).onclick = () => { Object.assign(draft, { blob: null, url: null, mark: false }); compose(); };
  $("#ok", c).onclick = async (e) => {
    const text = tx.value.trim();
    if (!text && !draft.blob) return tx.focus();
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      const row = { body: withTags(text), goal_id: draft.goalId };
      if (draft.blob) Object.assign(row, { kind: "photo", media_path: await upload(draft.blob, "jpg") });
      else row.kind = "text";
      const g = draft.mark && S.goals.find((x) => x.id === draft.goalId);
      if (g && g.done < g.target) await sb.from("goals").update({ done: g.done + 1 }).eq("id", g.id);
      await addPost(row);
      resetDraft();
      compose();
      $("#notes", sheet)?.scrollTo(0, 0);
    } catch (err) { btn.disabled = false; fail(err); }
  };
}

async function record() {
  const c = $("#cmp", sheet);
  c.className = "compose rec";
  c.innerHTML = `<button class="round sm" id="x" aria-label="Cancel"><i class="ph ph-x"></i></button>
    <span class="dot"></span><span class="time" id="t">0:00</span><span class="live" id="live">${"<i></i>".repeat(24)}</span>
    <button class="round sm send" id="ok" aria-label="Post voice note"><i class="ph ph-arrow-up"></i></button>`;
  drawCtx();
  let rec;
  try {
    rec = await startRecording({
      onLevel: (d) => c.querySelectorAll("#live i").forEach((b, k) => (b.style.height = 12 + (d[k % d.length] / 255) * 88 + "%")),
      onLimit: () => $("#ok", c)?.click(),
    });
  } catch {
    compose();
    return toast("Microphone access is needed for voice notes");
  }
  const timer = setInterval(() => { const t = $("#t", c); if (t) t.textContent = fmt(rec.elapsed()); }, 250);
  onClose = () => { clearInterval(timer); rec.cancel(); resetDraft(); };
  $("#x", c).onclick = () => { onClose(); onClose = resetDraft; compose(); };
  $("#ok", c).onclick = async (e) => {
    onClose = resetDraft;
    clearInterval(timer);
    e.currentTarget.disabled = true;
    try {
      const { blob, secs, type } = await rec.stop();
      if (secs < 1) { compose(); return toast("Too short"); }
      const path = await upload(blob, type.includes("mp4") ? "m4a" : "webm");
      await addPost({ kind: "voice", media_path: path, duration: secs, goal_id: draft.goalId, body: withTags("") });
      resetDraft();
      compose();
      $("#notes", sheet)?.scrollTo(0, 0);
    } catch (err) { compose(); fail(err); }
  };
}

const actions = {
  menu() { document.body.classList.add("menu-open"); },

  notes() { openNotes(); },

  mine() { editPerson(S.me.id); },

  async invite() {
    const { data: code, error } = await sb.rpc("join_code");
    if (error) return fail(error);
    const link = `${location.origin}/?join=${code}`;
    if (navigator.share) return navigator.share({ title: "Join our board", url: link }).catch(() => {});
    await navigator.clipboard.writeText(link);
    toast("Invite link copied");
  },

  // A photo from the menu: pick the goal it's for in the composer. Proof for one of your goals adds a mark unless you untick it.
  async photo() {
    const file = await pickFile("image/*");
    if (!file) return;
    openNotes();
    attachPhoto(file, true);
  },

  async scan() {
    if (!getKey()) {
      toast("Add a Claude API key to scan the board");
      return actions.settings();
    }
    const file = await pickFile("image/*");
    if (!file) return;
    const blob = await resizeImage(file, 2000, 0.85).catch(() => null);
    if (!blob) return toast("Couldn't open that image");
    const url = URL.createObjectURL(blob);
    openSheet(`<h3>Reading the board</h3><img class="preview-img" src="${url}" alt="Board photo">
      <p class="muted" style="margin-top:14px"><i class="ph ph-circle-notch spin"></i> This takes a few seconds</p>`);
    onClose = () => URL.revokeObjectURL(url);
    let board;
    try {
      board = await scanBoard(await blobToBase64(blob), S.members.map((m) => m.name));
    } catch (err) { closeSheet(); return fail(err); }
    showScan(board);
  },

  async blank() {
    await createWeek({ group_goal: null, fun: [], charity: null, people: [] });
  },

  weeks() {
    const w = week();
    openSheet(`<h3>Weeks</h3>
      <div class="list weeks-list">${S.weeks.map((x) => `<div><button data-w="${x.id}"><span><b>Week ${x.number}</b>${x.id === w.id ? '<i class="ph-bold ph-check" style="color:var(--ink)"></i>' : ""}</span><span class="muted">${weekRange(x)}</span></button></div>`).join("")}</div>
      <div class="row-btns"><button class="ghost" id="new">New blank week</button><button class="primary" id="ed">Edit Week ${w.number}</button></div>`);
    sheet.querySelectorAll("[data-w]").forEach((b) => (b.onclick = () => { S.weekId = +b.dataset.w; closeSheet(); refresh(); }));
    $("#ed", sheet).onclick = editWeek;
    $("#new", sheet).onclick = () => { closeSheet(); actions.blank(); };
  },

  async settings() {
    const { data: code } = await sb.rpc("join_code");
    const link = `${location.origin}/?join=${code}`;
    openSheet(`<h3>Settings</h3>
      <label class="lbl">Invite link</label>
      <div style="display:flex;gap:8px"><input class="field" readonly value="${esc(link)}" id="ln"><button class="primary" id="cp" style="padding:12px 16px"><i class="ph ph-share-network"></i></button></div>
      <p class="help">Anyone with this link can join after signing in with Google.</p>
      <label class="lbl">Claude API key (for scanning the board)</label>
      <input class="field" id="key" type="password" autocomplete="off" placeholder="sk-ant-..." value="${esc(getKey())}">
      <p class="help">Saved only on this device. Get one at console.anthropic.com.</p>
      <div class="row-btns" style="margin-top:20px"><button class="ghost" id="out">Sign out</button><button class="primary" id="sv">Save</button></div>`);
    $("#cp", sheet).onclick = async () => {
      if (navigator.share) return navigator.share({ title: "Join our board", url: link }).catch(() => {});
      await navigator.clipboard.writeText(link);
      toast("Link copied");
    };
    $("#sv", sheet).onclick = () => { setKey($("#key", sheet).value); closeSheet(); toast("Saved"); };
    $("#out", sheet).onclick = async () => { closeSheet(); channel?.unsubscribe(); channel = null; await sb.auth.signOut(); };
  },
};

// ---------- Scan result ----------

function showScan(board) {
  const w = week();
  const canFill = w && !S.goals.length;
  openSheet(`<h3>Got it</h3>
    <div class="list">
      ${board.people.map((p) => `<div><span class="grow"><b>${esc(p.name)}</b>${p.goals.map((g) => esc(g.target > 1 ? `${g.label} ×${g.target}` : g.label)).join(", ")}</span></div>`).join("")}
      ${board.group_goal || board.fun.length ? `<div><span class="grow"><b>Group</b>${[board.group_goal, ...board.fun.map((f) => f.label)].filter(Boolean).map(esc).join(", ")}</span></div>` : ""}
    </div>
    <p class="help" style="text-align:center;margin-bottom:16px">Everyone can fix their own goals after from the menu.</p>
    <div class="row-btns">${canFill ? `<button class="primary" id="fill">Fill Week ${w.number}</button>` : `<button class="primary" id="new">Start Week ${(S.weeks[0]?.number || 0) + 1}</button>`}</div>`);
  const go = async (e, fill) => {
    busy(e.currentTarget, "Saving");
    try { await createWeek(board, fill ? w : null); closeSheet(); } catch (err) { fail(err); }
  };
  $("#fill", sheet) && ($("#fill", sheet).onclick = (e) => go(e, true));
  $("#new", sheet) && ($("#new", sheet).onclick = (e) => go(e, false));
}

async function createWeek(board, existing = null) {
  const fields = { group_goal: board.group_goal, group_done: false, fun: board.fun, charity: board.charity };
  let w = existing;
  if (w) {
    const { error } = await sb.from("weeks").update(fields).eq("id", w.id);
    if (error) throw error;
  } else {
    const prev = S.weeks[0];
    // Carry over the group goal, fun goals and charity when starting blank.
    if (!board.people.length && prev) Object.assign(fields, { group_goal: prev.group_goal, charity: prev.charity, fun: prev.fun.map((f) => ({ ...f, done: false })) });
    const { data, error } = await sb.from("weeks").insert({ number: (prev?.number || 0) + 1, ...fields }).select().single();
    if (error) throw error;
    w = data;
  }
  const byName = new Map(S.members.map((m) => [m.name.toLowerCase(), m]));
  const rows = [];
  for (const p of board.people) {
    let m = byName.get(p.name.trim().toLowerCase());
    if (!m) {
      const { data, error } = await sb.from("members").insert({ name: p.name.trim() }).select().single();
      if (error) throw error;
      m = data;
      byName.set(m.name.toLowerCase(), m);
    }
    p.goals.forEach((g, i) => rows.push({
      week_id: w.id, member_id: m.id, label: g.label, note: g.note || null,
      target: Math.min(30, Math.max(1, g.target || 1)), done: Math.max(0, g.done || 0), position: i,
    }));
  }
  if (rows.length) {
    const { error } = await sb.from("goals").insert(rows);
    if (error) throw error;
  }
  S.weekId = w.id;
  await refresh();
}

// ---------- Editing ----------

function editPerson(memberId) {
  const m = member(memberId);
  const rows = S.goals.filter((g) => g.member_id === memberId).map((g) => ({ ...g }));
  const draw = () => {
    openSheet(`<h3>${esc(m.name)}</h3>
      <div class="list" id="rows">${rows.map((g, i) => `<div>
        <span class="grow"><input data-i="${i}" data-f="label" value="${esc(g.label)}" placeholder="Goal" maxlength="60">
          <input class="detail" data-i="${i}" data-f="note" value="${esc(g.note || "")}" placeholder="Detail (optional)" maxlength="60"></span>
        <input class="num" data-i="${i}" data-f="target" type="number" inputmode="numeric" min="1" max="30" value="${g.target}" aria-label="Times">
        <button data-rm="${i}" title="Remove"><i class="ph ph-trash"></i></button></div>`).join("")}
        <div><button id="add" style="color:var(--marker)"><i class="ph ph-plus"></i> Add goal</button></div>
      </div>
      <button class="primary" id="sv">Save</button>`);
    sheet.querySelectorAll("input[data-i]").forEach((el) => (el.oninput = () => {
      const g = rows[+el.dataset.i];
      g[el.dataset.f] = el.dataset.f === "target" ? Math.min(30, Math.max(1, +el.value || 1)) : el.value;
    }));
    sheet.querySelectorAll("[data-rm]").forEach((b) => (b.onclick = () => { rows.splice(+b.dataset.rm, 1); draw(); }));
    $("#add", sheet).onclick = () => { rows.push({ label: "", target: 1, done: 0 }); draw(); sheet.querySelector(`input[data-i="${rows.length - 1}"]`).focus(); };
    $("#sv", sheet).onclick = save;
  };
  const save = async (e) => {
    busy(e.currentTarget, "Saving");
    const keep = rows.filter((g) => g.label.trim());
    const gone = S.goals.filter((g) => g.member_id === memberId && !keep.some((k) => k.id === g.id)).map((g) => g.id);
    try {
      if (gone.length) { const { error } = await sb.from("goals").delete().in("id", gone); if (error) throw error; }
      for (const [i, g] of keep.entries()) {
        const row = { label: g.label.trim(), note: g.note?.trim() || null, target: g.target, done: Math.min(g.done, g.target), position: i };
        const { error } = g.id
          ? await sb.from("goals").update(row).eq("id", g.id)
          : await sb.from("goals").insert({ ...row, week_id: S.weekId, member_id: memberId });
        if (error) throw error;
      }
      closeSheet();
      refresh();
    } catch (err) { fail(err); }
  };
  draw();
}

function editWeek() {
  const w = week();
  openSheet(`<h3>Week ${w.number}</h3>
    <label class="lbl">Group goal</label><input class="field" id="gg" value="${esc(w.group_goal || "")}" maxlength="60">
    <label class="lbl">Fun goals (comma separated)</label><input class="field" id="fun" value="${esc(w.fun.map((f) => f.label).join(", "))}">
    <label class="lbl">Charity</label><input class="field" id="ch" value="${esc(w.charity || "")}" maxlength="80">
    <label class="lbl">Starts on</label><input class="field" id="st" type="date" value="${w.starts_on}" style="margin-bottom:18px">
    <button class="primary" id="sv">Save</button>`);
  $("#sv", sheet).onclick = async (e) => {
    busy(e.currentTarget, "Saving");
    const labels = $("#fun", sheet).value.split(",").map((s) => s.trim()).filter(Boolean);
    const patch = {
      group_goal: $("#gg", sheet).value.trim() || null,
      fun: labels.map((label) => ({ label, done: w.fun.find((f) => f.label === label)?.done || false })),
      charity: $("#ch", sheet).value.trim() || null,
      starts_on: $("#st", sheet).value || w.starts_on,
    };
    const { error } = await sb.from("weeks").update(patch).eq("id", w.id);
    if (error) return fail(error);
    closeSheet();
    refresh();
  };
}
