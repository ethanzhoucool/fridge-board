// In-memory stand-in for Supabase so the UI can be previewed without signing in.
// Only used by `npm run demo`; production builds never import it.

const uid = "demo-user";
const db = {
  members: [
    { id: "m-ethan", name: "Ethan", user_id: uid, created_at: "1" },
    { id: "m-weston", name: "Weston", user_id: null, created_at: "2" },
    { id: "m-nathan", name: "Nathan", user_id: null, created_at: "3" },
  ],
  weeks: [{ id: 1, number: 1, starts_on: "2026-10-27", group_goal: "3k / person", group_done: false, fun: [{ label: "Ikea", done: false }, { label: "Halloween", done: false }], charity: "makeawish.com (end of Nov)", rules: [] }],
  goals: [
    [1, "m-ethan", "Gym", "one leg day", 3, 1], [2, "m-ethan", "LeetCode", "mediums", 4, 0], [3, "m-ethan", "Emails + video", null, 2, 0],
    [4, "m-weston", "Report on personal agents", "2 pages", 1, 0], [5, "m-weston", "Gym", null, 2, 0], [6, "m-weston", "Polisei chapters", null, 5, 0],
    [7, "m-nathan", "Gym", null, 2, 0], [8, "m-nathan", "Practice exams", "materials + mechanics", 2, 0], [9, "m-nathan", "Instagram reel", null, 1, 0],
  ].map(([id, member_id, label, note, target, done], i) => ({ id, week_id: 1, member_id, label, note, target, done, position: i % 3 })),
  posts: [
    { id: 3, week_id: 1, member_id: "m-weston", kind: "text", body: "Halfway through chapter 4. Ikea run Saturday?", created_at: new Date(Date.now() - 864e5).toISOString() },
    { id: 2, week_id: 1, member_id: "m-ethan", kind: "voice", media_path: "x.m4a", duration: 72, created_at: new Date(Date.now() - 18e6).toISOString() },
  ],
};

function query(table) {
  let rows = db[table] || [];
  let op = "select", payload, single = false;
  const q = {
    select: () => q, order: () => q,
    eq: (k, v) => { rows = rows.filter((r) => r[k] === v); return q; },
    in: (k, vs) => { rows = rows.filter((r) => vs.includes(r[k])); return q; },
    update: (p) => { op = "update"; payload = p; return q; },
    insert: (p) => { op = "insert"; payload = p; return q; },
    delete: () => { op = "delete"; return q; },
    single: () => { single = true; return q; }, maybeSingle: () => { single = true; return q; },
    then: (res) => {
      if (op === "update") rows.forEach((r) => Object.assign(r, payload));
      if (op === "insert") {
        const add = [].concat(payload).map((r) => ({ id: Date.now() + Math.random(), created_at: new Date().toISOString(), ...r }));
        db[table].unshift(...add); rows = add;
      }
      if (op === "delete") db[table] = db[table].filter((r) => !rows.includes(r));
      const data = rows.map((r) => ({ ...r }));
      return Promise.resolve({ data: single ? data[0] ?? null : data, error: null }).then(res);
    },
  };
  if (table === "members") q.eq = (k, v) => { rows = rows.filter((r) => r[k] === v); return q; };
  return q;
}

export function createClient() {
  const channel = { on: () => channel, subscribe: () => channel, unsubscribe() {} };
  return {
    auth: {
      onAuthStateChange: (cb) => setTimeout(() => cb("SIGNED_IN", { user: { id: uid, user_metadata: { full_name: "Ethan Zhou" } } })),
      signOut: async () => {}, signInWithOAuth: async () => {},
    },
    from: query,
    rpc: async (fn) => ({ data: fn === "join_code" ? "demo" : fn === "open_names" ? [] : false, error: null }),
    storage: { from: () => ({ createSignedUrls: async (ps) => ({ data: ps.map((path) => ({ path, signedUrl: "" })) }), upload: async () => ({ error: null }), remove: async () => ({}) }) },
    channel: () => channel,
  };
}
