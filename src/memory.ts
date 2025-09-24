// src/memory.ts
import fs from "node:fs";
import crypto from "node:crypto";

export type MemoryOptions = {
  file?: string;                 // where to persist memory
  maxPosts?: number;             // sliding window size
  ttlDays?: number;              // forget old items after N days
  similarityThreshold?: number;  // 0..1 Jaccard threshold for near-dup
  topicCooldownMinutes?: number; // avoid same topic for N minutes
};

type PostRec = { hash: string; text: string; ts: number; topics: string[] };
type ImgRec  = { hash: string; prompt: string; ts: number };
type AuthorRec = { id: string; ts: number };

type Data = {
  posts: PostRec[];
  images: ImgRec[];
  authors: AuthorRec[]; // for reply throttling
  lastPruned?: number;
};

const DEFAULTS: Required<MemoryOptions> = {
  file: "/tmp/xbot_memory.json",
  maxPosts: 500,
  ttlDays: 14,
  similarityThreshold: 0.5,
  topicCooldownMinutes: 240,
};

const STOP = new Set([
  "the","a","an","and","or","but","if","on","in","to","for","of","with","from",
  "is","are","was","were","be","been","it","this","that","these","those","as",
  "at","by","we","you","i","they","he","she","them","our","your","their"
]);

function now() { return Date.now(); }
function days(n: number) { return n * 24 * 60 * 60 * 1000; }
function minutes(n: number) { return n * 60 * 1000; }

function normalizeText(s: string) {
  return s
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, "")     // strip urls
    .replace(/@[a-z0-9_]+/gi, "")       // strip handles
    .replace(/#[\p{L}\p{N}_-]+/gu, "")  // strip hashtags
    .replace(/[^\p{L}\p{N}\s]/gu, " ")  // punctuation -> space
    .replace(/\s+/g, " ")
    .trim();
}

function hash(s: string) {
  return crypto.createHash("sha256").update(s).digest("hex");
}

function tokens(s: string): string[] {
  return normalizeText(s).split(" ").filter(w => w && !STOP.has(w));
}

function bigrams(words: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < words.length - 1; i++) out.push(words[i] + " " + words[i+1]);
  return out;
}

function extractTopics(s: string): string[] {
  const t = tokens(s);
  const uni = t.slice(0, 6);                   // first few unigrams
  const bi = bigrams(t).slice(0, 4);           // first few bigrams
  return [...new Set([...bi, ...uni])].slice(0, 8);
}

function jaccard(a: Set<string>, b: Set<string>) {
  const inter = [...a].filter(x => b.has(x)).length;
  const uni = a.size + b.size - inter;
  return uni === 0 ? 0 : inter / uni;
}

export class Memory {
  private file: string;
  private maxPosts: number;
  private ttlDays: number;
  private similarityThreshold: number;
  private topicCooldownMinutes: number;
  private data: Data;

  constructor(opts: MemoryOptions = {}) {
    const cfg = { ...DEFAULTS, ...opts };
    this.file = cfg.file;
    this.maxPosts = cfg.maxPosts;
    this.ttlDays = cfg.ttlDays;
    this.similarityThreshold = cfg.similarityThreshold;
    this.topicCooldownMinutes = cfg.topicCooldownMinutes;
    this.data = { posts: [], images: [], authors: [] };
    this.load();
    this.prune();
  }

  private load() {
    try {
      if (fs.existsSync(this.file)) {
        this.data = JSON.parse(fs.readFileSync(this.file, "utf-8"));
      }
    } catch { /* ignore */ }
    this.data.posts ||= [];
    this.data.images ||= [];
    this.data.authors ||= [];
  }

  private save() {
    try {
      fs.writeFileSync(this.file, JSON.stringify(this.data), "utf-8");
    } catch { /* ignore */ }
  }

  private prune(force = false) {
    const t = now();
    if (!force && this.data.lastPruned && t - this.data.lastPruned < minutes(30)) return;

    const cutoff = t - days(this.ttlDays);
    this.data.posts = this.data.posts
      .filter(p => p.ts >= cutoff)
      .slice(-this.maxPosts);
    this.data.images = this.data.images
      .filter(i => i.ts >= cutoff)
      .slice(-this.maxPosts);
    // keep last ~2k authors
    this.data.authors = this.data.authors
      .filter(a => a.ts >= t - days(7))
      .slice(-2000);

    this.data.lastPruned = t;
    this.save();
  }

  /** True if text is exactly seen or similar to a recent post. */
  public isDuplicateText(text: string): boolean {
    const n = normalizeText(text);
    const h = hash(n);
    if (this.data.posts.some(p => p.hash === h)) return true;

    const A = new Set(tokens(n));
    for (const p of this.data.posts.slice(-this.maxPosts)) {
      const B = new Set(tokens(p.text));
      const sim = jaccard(A, B);
      if (sim >= this.similarityThreshold) return true;
    }
    return false;
  }

  /** True if text hits a recent topic that's still on cooldown. */
  public isTopicCooling(text: string): boolean {
    const t = now();
    const cooldown = this.topicCooldownMinutes ? minutes(this.topicCooldownMinutes) : 0;
    if (!cooldown) return false;

    const topics = new Set(extractTopics(text));
    for (const p of this.data.posts.slice(-this.maxPosts)) {
      if (t - p.ts > cooldown) continue;
      if (p.topics.some(tp => topics.has(tp))) return true;
    }
    return false;
  }

  public recordPost(text: string) {
    const n = normalizeText(text);
    const rec: PostRec = { hash: hash(n), text: n, ts: now(), topics: extractTopics(n) };
    this.data.posts.push(rec);
    if (this.data.posts.length > this.maxPosts) this.data.posts.shift();
    this.prune(true);
    this.save();
  }

  public seenImagePrompt(prompt: string): boolean {
    const n = normalizeText(prompt);
    const h = hash(n);
    if (this.data.images.some(i => i.hash === h)) return true;
    // very light similarity for prompts (use tokens Jaccard)
    const A = new Set(tokens(n));
    for (const i of this.data.images.slice(-this.maxPosts)) {
      const B = new Set(tokens(i.prompt));
      const sim = jaccard(A, B);
      if (sim >= Math.max(0.4, this.similarityThreshold - 0.1)) return true;
    }
    return false;
  }

  public recordImagePrompt(prompt: string) {
    const n = normalizeText(prompt);
    const rec: ImgRec = { hash: hash(n), prompt: n, ts: now() };
    this.data.images.push(rec);
    if (this.data.images.length > this.maxPosts) this.data.images.shift();
    this.prune(true);
    this.save();
  }

  /** Track authors we replied to (helps throttle). */
  public recordAuthorReplied(id: string) {
    this.data.authors.push({ id, ts: now() });
    if (this.data.authors.length > 2000) this.data.authors.shift();
    this.save();
  }
  public recentlyRepliedTo(id: string, minutesCooldown = 120): boolean {
    const cutoff = now() - minutes(minutesCooldown);
    return this.data.authors.some(a => a.id === id && a.ts >= cutoff);
  }
}
