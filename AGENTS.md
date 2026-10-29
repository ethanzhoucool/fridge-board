# Fridge — context for agents

Read this before anything else. It should be enough to start work without reading the whole repo. **Keep it current:** when you change behaviour, files or conventions, update this file in the same commit, and add a line to the log at the bottom.

## What it is

A shared weekly-goals board for a small group of friends (Ethan, Weston, Nathan, …). It's a digital copy of the whiteboard on their fridge:
- Each **week** has a group goal, "fun" checkbox goals, a charity, and per-person **goals** with tally marks (e.g. Gym ×3).
- People post **notes**: text, voice or photo. A note can be linked to a goal and tagged.
- **Scan the board:** photograph the real whiteboard and Claude Haiku turns it into that week's goals.

Live: https://fridge-board-fawn.vercel.app. It's installable as a home-screen web app (PWA) and designed phone-first, max 440px wide.

## Stack and commands

- Vite + **plain JavaScript (no framework)**, with HTML built from template strings and set via `innerHTML`.
- Supabase: Google sign-in, Postgres with RLS, a private `media` storage bucket, realtime.
- `@anthropic-ai/sdk` called **from the browser** for scanning, with a user-supplied key kept in localStorage (`fridge.anthropicKey`). Model: `claude-haiku-5-5`.
- Deploy: Vercel builds `main` automatically. Pushing or merging to `main` ships it.

```
npm run dev     # real Supabase, port 5179, needs .env.local (VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY)
npm run demo    # in-memory fake backend, port 5180, no sign-in. Use this to test UI changes.
npm run build
```

`npm run demo` swaps `@supabase/supabase-js` for `dev/fake-supabase.js` (a Vite alias in `vite.config.js`). The fake supports `select/eq/in/order/insert/update/delete/single`, the RPCs, and storage, where uploads stay in memory as object URLs. Its seed data has 3 members, 9 goals and a few notes, including a photo and tagged notes. If the app starts using a new query method, add it to the fake.

There are no tests and no linter. To verify, run `npm run build` and click through `npm run demo` at phone width (375×812).

## Files

| File | What's in it |
|---|---|
| `src/main.js` | Almost everything: auth/join, data loading, board rendering, tally interaction, the notes sheet and composer, menu actions, scan results, editors. Split into `// ---------- Section ----------` blocks. |
| `src/media.js` | `resizeImage` (to JPEG, longest side 1600 by default), `blobToBase64`, `startRecording` (MediaRecorder: mp4 on Safari, webm elsewhere), `wave` (fake waveform from a seed), `fmt` (m:ss). |
| `src/scan.js` | Board photo → JSON using the Anthropic structured-output schema. The prompt holds the whiteboard's conventions. |
| `src/sfx.js` | Synthesized WebAudio sounds for `mark`, `erase` and `done`. No audio files. |
| `src/style.css` | All styles. Colour tokens on `:root` with a dark-mode override, and the spacing scale `--s1…--s6` (4/8/12/16/24/32). |
| `index.html` | The shell: `#app`, the sheet (`#sheetWrap` / `#sheet`), the menu (`#menu`), the photo viewer (`#lb`), `#toast`. Loads Shantell Sans and Phosphor icons from CDNs. |
| `supabase/schema.sql` | The whole database: tables, RLS, RPCs, storage bucket, realtime. **There is no migrations folder.** If you change the schema, edit this file *and* give the SQL to run in the Supabase SQL editor. |
| `dev/fake-supabase.js` | The demo backend described above. |

## Data model (`supabase/schema.sql`)

- `members(id uuid, name, user_id → auth.users, avatar_url)`: a member can exist before anyone claims it (created by a scan). Signing in claims a name through `join_group(code, name)`.
- `weeks(id, number, starts_on, group_goal, group_done, fun jsonb [{label, done}], charity, rules jsonb)`
- `goals(id, week_id, member_id, label, note, target 1–30, done, position)`
- `posts(id, week_id, member_id, kind 'text'|'voice'|'photo', body, media_path, duration, goal_id → goals, created_at)`
  - `goal_id` links a note to a goal (optional).
  - **Tags are `#hashtags` inside `body`.** There's no tags column. Voice posts store only their tags in `body`.
- `app_config`: holds `join_code`. Invite links are `/?join=<code>`, and the first person to sign in needs no code (`needs_setup()`).
- RLS: members can read everything and edit weeks and goals, but **can only insert and delete their own posts. There's no update policy on posts**, so notes can't be edited yet.
- Storage: the `media` bucket is private. Paths look like `<member_id>/<uuid>.<ext>` and are read through signed URLs (6h) cached in `S.urls`.

## How `main.js` works

- **State:** `S = { session, me, members, weeks, weekId, goals, posts, urls }`. Helpers: `week()`, `member(id)`, `esc()` (escape **every** user string you put into HTML), `$()`, `toast()`, `fail()`.
- **Loading:** `refresh()` fetches members and weeks, then the selected week's goals and posts plus signed URLs, then calls `render()`. If the notes sheet is open it also redraws it.
- **Realtime:** `subscribe()` triggers a debounced `refresh()` on any change to posts, goals or weeks. The `saving` counter holds the refresh back while an optimistic write is still in flight, so stale counts don't flash.
- **Board:** `render()` → header, shared chips (`toggleChip`), `personBlock()` for each member (goal rows with `badge(g)` and `tally(g)`), `lately()`, and `notesBar()`. Tally marks are hand-drawn SVG paths with jitter from `rnd(seed)`.
- **Tally interaction (your own goals only):**
  - Tap → `askConfirm()` shows the pending mark plus a `.cam.now` (camera) and `.ok` (✓) button, and times out after 5 seconds.
  - ✓ → `change(id, +1)`, then `offerPhoto()` shows `.cam.after` for 4 seconds. `showAfter()` adds it back after a re-render.
  - Camera → `snap(id, mark)`. It **opens the file picker before any `await`**, because iOS only opens pickers inside a user gesture.
  - Press and hold (450ms) → rub one mark out.
  - Finishing a goal → `celebrate()` (strike-through, ink burst, chime).
  - Tapping **someone else's** goal, or any badge, → `openNotes({ goal })`.
- **Notes sheet:** `openNotes(filter, file?, offerMark?)` is the only entry point (the menu "Notes" and "Add a photo" items both go through it).
  - `nf = { goal, view }`, where `view` is `all | photos | m:<memberId> | t:<tag>`.
  - `drawNotes()` draws the header (filters, or the goal's title with a back link) and the list grouped by `dayLabel`, then calls `markSeen()`.
- **Composer:**
  - `draft = { goalId, tags:Set, blob, url, mark, offerMark }` is the next post.
  - `drawCtx()` draws the button row above the input: photo thumbnail, `Mark` (adds a tally mark when a photo is linked to your own unfinished goal), goal chips and tag chips.
  - `compose()` (idle: close, mic, pen, camera), `write()` (text or photo caption) and `record()` (voice) swap the bottom bar. `withTags()` adds the selected tag chips to the end of the text.
- **Unread:** the newest `created_at` you've seen is stored in localStorage as `fridge.seen.<weekId>`. Per device.
- **Sheets:** `openSheet(html, kind)` / `closeSheet()`. `onClose` is a one-shot cleanup hook (stopping a recording, revoking object URLs). Opening a sheet replaces the current one.
- **Actions:** the `actions` object holds `menu, notes, mine, invite, photo, scan, blank, weeks, settings`. Any element with `data-act="name"` gets wired to it.
- **Scan:** `actions.scan` → `scanBoard()` → `showScan()` → `createWeek(board, existing?)`. That fills the current empty week or starts the next one, creates members for unknown names, and starts a blank week by copying the group goal, fun goals and charity.

## Conventions

- Match the existing style: terse, small helper functions, template strings, `querySelectorAll(...).forEach(b => b.onclick = ...)` wiring, and a short `//` comment explaining *why* above anything non-obvious. Don't add a framework or build tooling.
- Text written on the board (goals, notes, names) uses the `.hand` class (Shantell Sans, ink colour). App controls use the system font. Use colour tokens only (`--ink`, `--ink-2`, `--ink-3`, `--muted`, `--fill`, `--chrome`, …), which handles dark mode automatically.
- Icons are Phosphor classes (`ph ph-camera`, `ph-bold`, `ph-fill`).
- Tap targets should be ≥ 32px, 44px for main actions. Respect `prefers-reduced-motion`; the global rule already turns animations off.
- UI copy is short and plain ("Add your goals", "Nothing yet. Say how it's going.").
- Commits: imperative summary line, no AI attribution lines.

## Gotchas

- Open file pickers synchronously inside the tap handler (see `snap`, `compose`'s camera button).
- `render()` rebuilds `#app` completely. Any temporary UI on a row (pending mark, after-camera) has to survive or be re-added; see `showAfter`.
- `refresh()` runs on every realtime event, including your own writes. Don't redraw the composer's textarea inside it; `drawCtx()` only redraws the button row.
- Images are resized to JPEG before upload. The bucket limit is 15 MB.
- Signed URLs expire after 6 hours. A tab left open longer will show broken images until it refreshes.

## Status and ideas

Done: tally board, scanning, voice/text/photo notes, invite links, photos on check-off, goal threads, tags, filters, Lately, unread count, photo viewer.

Not verified yet: the photo / goal-thread / tags features against real Supabase and on a real iPhone (camera picker, HEIC photos).

Ideas, roughly in priority order:
1. Editing your own notes (needs an `update` RLS policy on `posts`).
2. More than one photo per post.
3. An end-of-week recap built from goal links and tags.
4. Notifications when someone posts on your goal or a goal you've commented on.

## Log

- 2026-10-28: First version: board, tallies, voice/text/photo notes, scanning with Haiku, confirm-to-mark with celebration.
- 2026-10-29: PR #1. Photo on check-off and afterwards, per-goal note threads, `#tag` tags, filters, Lately on the board, unread count, photo viewer, goal detail field. No schema change. Added this file.
