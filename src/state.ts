// src/state.ts
import fs from "node:fs";
import path from "node:path";

type PostRec = { id: string; ts: number };
type State = {
  paused: boolean;
  dryRun: boolean;
  trendingEnabled: boolean;
  autoEngageEnabled: boolean;
  posts: PostRec[];
};

const FILE = process.env.STATE_FILE || path.join(process.cwd(), ".bot_state.json");

const DEFAULTS: State = {
  paused: false,
  dryRun: (process.env.DRY_RUN ?? "true").toLowerCase() === "true",
  trendingEnabled: true,
  autoEngageEnabled: false,
  posts: []
};

function read(): State {
  try {
    const raw = fs.readFileSync(FILE, "utf-8");
    const parsed = JSON.parse(raw);
    return { ...DEFAULTS, ...parsed, posts: Array.isArray(parsed.posts) ? parsed.posts : [] };
  } catch {
    return { ...DEFAULTS };
  }
}

function write(s: State) {
  fs.writeFileSync(FILE, JSON.stringify(s, null, 2));
}

export function getState(): State { return read(); }
export function setState(patch: Partial<State>): State {
  const cur = read();
  const next = { ...cur, ...patch };
  write(next);
  return next;
}
export function recordPost(id: string, ts = Date.now()) {
  const cur = read();
  cur.posts.push({ id, ts });
  if (cur.posts.length > 2000) cur.posts.shift();
  write(cur);
}
export function postsSince(ms: number): PostRec[] {
  const cur = read();
  return cur.posts.filter(p => p.ts >= ms);
}
export function postsToday(): number {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  return postsSince(start).length;
}
