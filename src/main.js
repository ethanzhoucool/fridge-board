import { createClient } from "@supabase/supabase-js";
import { resizeImage, blobToBase64, startRecording, wave, fmt } from "./media.js";
import { scanBoard, getKey, setKey } from "./scan.js";

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
  render();
}

let channel, refreshT;
function subscribe() {
  if (channel) return;
  const later = () => { clearTimeout(refreshT); refreshT = setTimeout(() => refresh(), 400); };
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
  return `${f(d)} - ${f(e)}`;
}

function render() {
  const w = week();
  if (!w) {
    app.innerHTML = `<header><div><h1 class="hand">Fridge.</h1></div>${tools()}</header>
      <div class="center" style="min-height:50dvh"><p>No board yet. Snap the fridge and the goals fill in.</p>
      <button class="primary" data-act="scan"><i class="ph ph-camera"></i> Scan the board</button>
      <button class="ghost" data-act="blank">Start blank</button></div>`;
    return wire();
  }
  const chips = [];
  if (w.group_goal) chips.push({ label: w.group_goal, done: w.group_done, i: -1 });
  w.fun.forEach((f, i) => chips.push({ ...f, i }));
  const latest = w.id === S.weeks[0]?.id;

  app.innerHTML = `
    <header>
      <button style="text-align:left" data-act="weeks"><h1 class="hand">Week ${w.number}.</h1><small>${weekRange(w)}${latest ? "" : " · past week"}</small></button>
      ${tools()}
    </header>
    ${chips.length ? `<div class="strip">${chips.map((c) => `<button class="chip ${c.done ? "done" : ""}" data-chip="${c.i}"><span class="box">${c.done ? '<i class="ph-bold ph-check"></i>' : ""}</span>${esc(c.label)}</button>`).join("")}</div>` : ""}
    <section>${S.members.map(personBlock).join("")}</section>
    ${w.charity || w.rules.length ? `<div class="extras">${w.charity ? `<div><b>Charity</b>${esc(w.charity)}</div>` : ""}${w.rules.length ? `<div><b>Rules</b>${w.rules.map(esc).join(" · ")}</div>` : ""}</div>` : ""}
    <h2 class="feed-title hand">This week</h2>
    ${S.posts.length ? `<section class="feed">${S.posts.map(noteBlock).join("")}</section>` : `<div class="feed-empty">Nothing yet. Post a voice note, a thought, or proof.</div>`}
    <nav class="fab">
      <button title="Photo" data-act="photo"><i class="ph ph-camera"></i></button>
      <button class="rec" title="Voice note" data-act="voice"><i class="ph-fill ph-microphone"></i></button>
      <button title="Text" data-act="text"><i class="ph ph-pencil-simple"></i></button>
    </nav>`;
  wire();
}

const tools = () => `<div class="tools">
  <button class="icon-btn" title="Scan the board" data-act="scan"><i class="ph ph-scan"></i></button>
  <button class="icon-btn" title="Settings" data-act="settings"><i class="ph ph-gear-six"></i></button></div>`;

function personBlock(m) {
  const goals = S.goals.filter((g) => g.member_id === m.id);
  return `<div class="person">
    <div class="person-h">${m.avatar_url ? `<img src="${esc(m.avatar_url)}" alt="" referrerpolicy="no-referrer">` : ""}<h2 class="hand">${esc(m.name)}</h2>
      <button class="icon-btn" title="Edit goals" data-edit="${m.id}"><i class="ph ph-pencil-simple-line"></i></button></div>
    ${goals.length ? goals.map((g) => `<button class="goal ${g.done >= g.target ? "complete" : ""}" data-goal="${g.id}">
        <span>${esc(g.label)}${g.note ? `<small>${esc(g.note)}</small>` : ""}</span>
        <span class="tally" aria-label="${g.done} of ${g.target}">${Array.from({ length: g.target }, (_, k) => `<i class="${k < g.done ? "on" : ""}"></i>`).join("")}</span>
      </button>`).join("") : `<div class="empty-goals">No goals yet</div>`}
  </div>`;
}

function ago(ts) {
  const s = (Date.now() - new Date(ts)) / 1000;
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return new Date(ts).toLocaleDateString(undefined, { weekday: "short" });
}

function noteBlock(p) {
  const who = member(p.member_id);
  const goal = p.goal_id && S.goals.find((g) => g.id === p.goal_id);
  const mine = p.member_id === S.me.id;
  const meta = `<div class="meta"><b>${esc(who?.name)}</b><span>${p.kind === "voice" ? fmt(p.duration || 0) : ago(p.created_at)}</span>${mine ? `<button class="del" title="Delete" data-del="${p.id}"><i class="ph ph-x"></i></button>` : ""}</div>`;
  const tag = goal ? `<span class="tag">${esc(goal.label)}</span>` : "";
  if (p.kind === "photo") return `<article class="note"><img src="${esc(S.urls[p.media_path] || "")}" alt="${esc(who?.name)}${goal ? ": " + esc(goal.label) : ""}" loading="lazy">${tag}${p.body ? `<p>${esc(p.body)}</p>` : ""}${meta}</article>`;
  if (p.kind === "text") return `<article class="note"><p class="big">${esc(p.body)}</p>${meta}</article>`;
  return `<article class="note"><button class="voice" data-play="${p.id}"><span class="play"><i class="ph-fill ph-play"></i></span>
    <span class="wave">${wave(p.id).map((h) => `<i style="height:${Math.round(h * 100)}%"></i>`).join("")}</span></button>${tag}${meta}</article>`;
}

function wire() {
  app.querySelectorAll("[data-act]").forEach((b) => (b.onclick = () => actions[b.dataset.act]()));
  app.querySelectorAll("[data-goal]").forEach((b) => (b.onclick = () => tick(+b.dataset.goal)));
  app.querySelectorAll("[data-chip]").forEach((b) => (b.onclick = () => toggleChip(+b.dataset.chip)));
  app.querySelectorAll("[data-edit]").forEach((b) => (b.onclick = () => editPerson(b.dataset.edit)));
  app.querySelectorAll("[data-play]").forEach((b) => (b.onclick = () => play(b, +b.dataset.play)));
  app.querySelectorAll("[data-del]").forEach((b) => (b.onclick = () => delPost(+b.dataset.del)));
}

async function tick(id) {
  const g = S.goals.find((x) => x.id === id);
  g.done = g.done >= g.target ? 0 : g.done + 1;
  render();
  const { error } = await sb.from("goals").update({ done: g.done }).eq("id", id);
  if (error) fail(error);
}

async function toggleChip(i) {
  const w = week();
  const patch = i < 0 ? { group_done: !w.group_done } : { fun: w.fun.map((f, k) => (k === i ? { ...f, done: !f.done } : f)) };
  Object.assign(w, patch);
  render();
  const { error } = await sb.from("weeks").update(patch).eq("id", w.id);
  if (error) fail(error);
}

const audio = new Audio();
let playing = null;
function play(btn, id) {
  const p = S.posts.find((x) => x.id === id);
  const icon = btn.querySelector(".play");
  const bars = [...btn.querySelectorAll(".wave i")];
  const reset = () => { bars.forEach((b) => b.classList.remove("on")); icon.innerHTML = '<i class="ph-fill ph-play"></i>'; };
  if (playing === id) { audio.pause(); playing = null; return reset(); }
  app.querySelectorAll(".voice .play").forEach((el) => (el.innerHTML = '<i class="ph-fill ph-play"></i>'));
  app.querySelectorAll(".wave i.on").forEach((el) => el.classList.remove("on"));
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
  if (!confirm("Delete this post?")) return;
  const p = S.posts.find((x) => x.id === id);
  const { error } = await sb.from("posts").delete().eq("id", id);
  if (error) return fail(error);
  if (p.media_path) sb.storage.from("media").remove([p.media_path]);
  S.posts = S.posts.filter((x) => x.id !== id);
  render();
}

// ---------- Sheets ----------

let onClose = null;
function openSheet(html) {
  onClose?.();
  onClose = null;
  sheet.innerHTML = html;
  sheetWrap.classList.add("open");
}
function closeSheet() {
  onClose?.();
  onClose = null;
  sheetWrap.classList.remove("open");
}
$(".sheet-bg").onclick = closeSheet;

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

const actions = {
  async voice() {
    openSheet(`<h3>Recording</h3><div class="timer" id="t">0:00</div><div class="muted" style="font-size:13px">up to 2:00</div>
      <div class="wave live" id="live">${"<i></i>".repeat(28)}</div>
      <div class="row-btns"><button class="ghost" id="x">Cancel</button><button class="primary" id="ok">Post</button></div>`);
    let rec;
    try {
      rec = await startRecording({
        onLevel: (d) => sheet.querySelectorAll("#live i").forEach((b, k) => (b.style.height = 6 + (d[k % d.length] / 255) * 42 + "px")),
        onLimit: () => $("#ok", sheet)?.click(),
      });
    } catch {
      closeSheet();
      return toast("Microphone access is needed for voice notes");
    }
    const timer = setInterval(() => { const t = $("#t", sheet); if (t) t.textContent = fmt(rec.elapsed()); }, 250);
    onClose = () => { clearInterval(timer); rec.cancel(); };
    $("#x", sheet).onclick = closeSheet;
    $("#ok", sheet).onclick = async (e) => {
      onClose = null;
      clearInterval(timer);
      busy(e.currentTarget);
      try {
        const { blob, secs, type } = await rec.stop();
        if (secs < 1) { closeSheet(); return toast("Too short"); }
        const path = await upload(blob, type.includes("mp4") ? "m4a" : "webm");
        await addPost({ kind: "voice", media_path: path, duration: secs });
        closeSheet();
      } catch (err) { closeSheet(); fail(err); }
    };
  },

  text() {
    openSheet(`<h3>Jot it down</h3><textarea id="tx" placeholder="How's the week going?" maxlength="2000"></textarea>
      <button class="primary" id="ok">Post</button>`);
    setTimeout(() => $("#tx", sheet).focus(), 300);
    $("#ok", sheet).onclick = async (e) => {
      const body = $("#tx", sheet).value.trim();
      if (!body) return;
      busy(e.currentTarget);
      try { await addPost({ kind: "text", body }); closeSheet(); } catch (err) { fail(err); }
    };
  },

  async photo() {
    const file = await pickFile("image/*");
    if (!file) return;
    const mine = S.goals.filter((g) => g.member_id === S.me.id);
    const blob = await resizeImage(file).catch(() => null);
    if (!blob) return toast("Couldn't open that image");
    const url = URL.createObjectURL(blob);
    let goalId = null;
    openSheet(`<h3>Proof</h3><img class="preview-img" src="${url}" alt="Selected photo">
      ${mine.length ? `<div class="strip">${mine.map((g) => `<button class="chip" data-g="${g.id}">${esc(g.label)}</button>`).join("")}</div>` : ""}
      <input class="field" id="cap" placeholder="Caption (optional)" maxlength="300" style="margin:${mine.length ? 0 : 12}px 0 16px">
      <button class="primary" id="ok">Post</button>`);
    onClose = () => URL.revokeObjectURL(url);
    sheet.querySelectorAll("[data-g]").forEach((b) => (b.onclick = () => {
      goalId = goalId === +b.dataset.g ? null : +b.dataset.g;
      sheet.querySelectorAll("[data-g]").forEach((c) => c.classList.toggle("sel", +c.dataset.g === goalId));
    }));
    $("#ok", sheet).onclick = async (e) => {
      busy(e.currentTarget);
      try {
        const path = await upload(blob, "jpg");
        // Proof for a goal also adds a tally mark.
        const g = goalId && S.goals.find((x) => x.id === goalId);
        if (g && g.done < g.target) await sb.from("goals").update({ done: g.done + 1 }).eq("id", g.id);
        await addPost({ kind: "photo", media_path: path, goal_id: goalId, body: $("#cap", sheet).value.trim() || null });
        closeSheet();
      } catch (err) { fail(err); }
    };
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
    await createWeek({ group_goal: null, fun: [], charity: null, rules: [], people: [] });
  },

  weeks() {
    const w = week();
    openSheet(`<h3>Weeks</h3>
      <div class="list weeks-list">${S.weeks.map((x) => `<div><button data-w="${x.id}"><span><b>Week ${x.number}</b></span><span class="muted">${weekRange(x)}</span></button></div>`).join("")}</div>
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
    <p class="help" style="text-align:center;margin-bottom:16px">You can fix anything after with the pencil next to each name.</p>
    <div class="row-btns">${canFill ? `<button class="primary" id="fill">Fill Week ${w.number}</button>` : `<button class="primary" id="new">Start Week ${(S.weeks[0]?.number || 0) + 1}</button>`}</div>`);
  const go = async (e, fill) => {
    busy(e.currentTarget, "Saving");
    try { await createWeek(board, fill ? w : null); closeSheet(); } catch (err) { fail(err); }
  };
  $("#fill", sheet) && ($("#fill", sheet).onclick = (e) => go(e, true));
  $("#new", sheet) && ($("#new", sheet).onclick = (e) => go(e, false));
}

async function createWeek(board, existing = null) {
  const fields = { group_goal: board.group_goal, group_done: false, fun: board.fun, charity: board.charity, rules: board.rules };
  let w = existing;
  if (w) {
    const { error } = await sb.from("weeks").update(fields).eq("id", w.id);
    if (error) throw error;
  } else {
    const prev = S.weeks[0];
    // Carry over the group goal, charity and rules when starting blank.
    if (!board.people.length && prev) Object.assign(fields, { group_goal: prev.group_goal, charity: prev.charity, rules: prev.rules, fun: prev.fun.map((f) => ({ ...f, done: false })) });
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
        <span class="grow"><input data-i="${i}" data-f="label" value="${esc(g.label)}" placeholder="Goal" maxlength="60"></span>
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
        const row = { label: g.label.trim(), target: g.target, done: Math.min(g.done, g.target), position: i };
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
    <label class="lbl">Rules (one per line)</label><textarea id="ru" style="min-height:90px;font:15px/1.4 Geist,sans-serif;margin:0 0 16px">${esc(w.rules.join("\n"))}</textarea>
    <label class="lbl">Starts on</label><input class="field" id="st" type="date" value="${w.starts_on}" style="margin-bottom:18px">
    <button class="primary" id="sv">Save</button>`);
  $("#sv", sheet).onclick = async (e) => {
    busy(e.currentTarget, "Saving");
    const labels = $("#fun", sheet).value.split(",").map((s) => s.trim()).filter(Boolean);
    const patch = {
      group_goal: $("#gg", sheet).value.trim() || null,
      fun: labels.map((label) => ({ label, done: w.fun.find((f) => f.label === label)?.done || false })),
      charity: $("#ch", sheet).value.trim() || null,
      rules: $("#ru", sheet).value.split("\n").map((s) => s.trim()).filter(Boolean),
      starts_on: $("#st", sheet).value || w.starts_on,
    };
    const { error } = await sb.from("weeks").update(patch).eq("id", w.id);
    if (error) return fail(error);
    closeSheet();
    refresh();
  };
}
