// src/bot.ts
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { TwitterApi } from "twitter-api-v2";
import OpenAI from "openai";
import { buildTweetPrompt } from "./prompt.js";
import character from "./character.js";

/* =========================
   ENV
========================= */
const {
  // X / Twitter
  X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_SECRET,

  // LLM
  OPENAI_API_KEY, OPENAI_BASE_URL, OPENAI_MODEL = "gpt-4o-mini",

  // Posting cadence
  POST_INTERVAL_MIN = "120", POST_INTERVAL_MAX = "240", POST_IMMEDIATELY = "false",

  // Safety / ops
  MAX_TWEET_LENGTH = "280", DRY_RUN = "true",

  // (Optional) Active-hours — leave unset to post 24/7
  ACTIVE_HOURS_START, ACTIVE_HOURS_END, TIMEZONE = "Europe/Athens",

  // Image posting controls
  ENABLE_IMAGE_POSTS = "false",   // "true" to enable image cycles
  IMAGE_FREQUENCY = "3",          // every Nth cycle uses an image (1 = every cycle)
  IMAGE_SIZE = "1024x1024",       // 256x256 | 512x512 | 1024x1024
  IMAGE_STYLE = "high-contrast, clean composition, cinematic lighting",

  // Image prompt steering
  IMAGE_PROMPT_MODE = "hybrid",           // text | hybrid | persona
  IMAGE_PROMPT_PERSONA_WEIGHT = "0.25",   // 0..1
  IMAGE_PROMPT_MAX_TOKENS = "120",

  // Reference image (edits)
  IMAGE_REF_URL,
  IMAGE_REF_PATH,
  IMAGE_MASK_URL,
  IMAGE_MASK_PATH,

  // Memory & Dedupe
  MEMORY_ENABLED = "true",
  MEMORY_FILE = "/tmp/post_memory.json",
  MEMORY_MAX_POSTS = "500",
  MEMORY_TTL_DAYS = "14",
  SIMILARITY_THRESHOLD = "0.5",           // token Jaccard, 0..1 (higher = stricter)
  TOPIC_COOLDOWN_MINUTES = "240",         // avoid same topic for N minutes
  MAX_REGEN_TRIES = "3",                  // tries to regenerate novel caption
  SKIP_ON_DUPLICATE = "true",             // skip cycle if still dup after retries

  // Discovery Sniper (auto replies)
  ENABLE_DISCOVERY_SNIPER = "true",
  DISCOVERY_QUERIES = "crypto,dao,defi,memecoin,airdrops",
  DISCOVERY_MIN_FOLLOWERS = "300000",
  DISCOVERY_REQUIRE_VERIFIED = "true",
  DISCOVERY_MIN_RETWEETS = "50",
  DISCOVERY_LOOKBACK_MINUTES = "360",
  DISCOVERY_CHECK_INTERVAL_MIN = "20",
  DISCOVERY_CHECK_INTERVAL_MAX = "60",
  DISCOVERY_PROBABILITY = "0.5",
  DISCOVERY_MAX_PER_RUN = "1",
  RECENT_AUTHOR_COOLDOWN_MINUTES = "240",

  // Reply caps / bounds
  REPLY_DAILY_CAP = "12",
  REPLY_MIN_LEN = "12",
  REPLY_MAX_LEN = "280",

  // LLM retry / cool-off
  LLM_RETRY_MAX = "4",
  LLM_RETRY_BASE_MS = "1500",
  LLM_ON_429_SLEEP_MIN = "60"
} = process.env;

/* =========================
   Guards
========================= */
function need(name: string, val?: string) { if (!val) throw new Error(`Missing env ${name}`); }
need("X_API_KEY", X_API_KEY);
need("X_API_SECRET", X_API_SECRET);
need("X_ACCESS_TOKEN", X_ACCESS_TOKEN);
need("X_ACCESS_SECRET", X_ACCESS_SECRET);
need("OPENAI_API_KEY", OPENAI_API_KEY);

/* =========================
   Clients
========================= */
const twitter = new TwitterApi({
  appKey: X_API_KEY!, appSecret: X_API_SECRET!,
  accessToken: X_ACCESS_TOKEN!, accessSecret: X_ACCESS_SECRET!
});

const openai = new OpenAI({
  apiKey: OPENAI_API_KEY!,
  baseURL: OPENAI_BASE_URL // leave undefined for native OpenAI; set for OpenRouter-compatible
});

/* =========================
   Config
========================= */
const minMin = Math.max(5, parseInt(POST_INTERVAL_MIN!, 10));
const maxMin = Math.max(minMin, parseInt(POST_INTERVAL_MAX!, 10));
const postImmediately = /^true$/i.test(POST_IMMEDIATELY!);
const maxLen = Math.min(1000, Math.max(80, parseInt(MAX_TWEET_LENGTH!, 10)));
const dryRun = /^true$/i.test(DRY_RUN!);

const enableImagePosts = /^true$/i.test(ENABLE_IMAGE_POSTS!);
const imageEvery = Math.max(1, parseInt(IMAGE_FREQUENCY!, 10));

/* ===== Discovery Sniper config ===== */
const enableDiscoverySniper = /^true$/i.test(ENABLE_DISCOVERY_SNIPER!);
const discoveryQueries = DISCOVERY_QUERIES.split(",").map(s => s.trim()).filter(Boolean);
const discoveryMinFollowers = Math.max(0, parseInt(DISCOVERY_MIN_FOLLOWERS!, 10));
const discoveryRequireVerified = /^true$/i.test(DISCOVERY_REQUIRE_VERIFIED!);
const discoveryMinRetweets = Math.max(0, parseInt(DISCOVERY_MIN_RETWEETS!, 10));
const discoveryLookbackMinutes = Math.max(15, parseInt(DISCOVERY_LOOKBACK_MINUTES!, 10));
const discoveryCheckMin = Math.max(5, parseInt(DISCOVERY_CHECK_INTERVAL_MIN!, 10));
const discoveryCheckMax = Math.max(discoveryCheckMin, parseInt(DISCOVERY_CHECK_INTERVAL_MAX!, 10));
const discoveryProb = Math.min(1, Math.max(0, parseFloat(DISCOVERY_PROBABILITY!)));
const discoveryMaxPerRun = Math.max(1, parseInt(DISCOVERY_MAX_PER_RUN!, 10));
const recentAuthorCooldownMin = Math.max(0, parseInt(RECENT_AUTHOR_COOLDOWN_MINUTES!, 10));

/* ===== Replies caps ===== */
const replyDailyCap = Math.max(0, parseInt(REPLY_DAILY_CAP!, 10));
const replyMinLen = Math.max(1, parseInt(REPLY_MIN_LEN!, 10));
const replyMaxLen = Math.min(280, Math.max(60, parseInt(REPLY_MAX_LEN!, 10)));

/* =========================
   Time helpers
========================= */
function withinActiveHours(): boolean {
  if (!ACTIVE_HOURS_START || !ACTIVE_HOURS_END) return true;
  try {
    const now = new Date();
    const tzNow = new Date(now.toLocaleString("en-US", { timeZone: TIMEZONE }));
    const toMins = (s: string) => { const [h, m] = s.split(":").map(Number); return h * 60 + m; };
    const minutes = tzNow.getHours() * 60 + tzNow.getMinutes();
    const start = toMins(ACTIVE_HOURS_START), end = toMins(ACTIVE_HOURS_END);
    return end >= start ? (minutes >= start && minutes <= end) : (minutes >= start || minutes <= end);
  } catch { return true; }
}
function msUntilActiveStart(): number {
  if (!ACTIVE_HOURS_START || !ACTIVE_HOURS_END) return 0;
  const now = new Date();
  const tzNow = new Date(now.toLocaleString("en-US", { timeZone: TIMEZONE }));
  const [sh, sm] = ACTIVE_HOURS_START.split(":").map(Number);
  const next = new Date(tzNow);
  next.setHours(sh, sm, 0, 0);
  if (next <= tzNow) next.setDate(next.getDate() + 1);
  return next.getTime() - tzNow.getTime();
}
function randDelayMs() {
  return (Math.floor(Math.random() * (maxMin - minMin + 1)) + minMin) * 60 * 1000;
}
function randRangeMs(minM: number, maxM: number) {
  const mins = Math.floor(Math.random() * (maxM - minM + 1)) + minM;
  return mins * 60 * 1000;
}

/* =========================
   LLM resilience (retry + 429 cool-off)
========================= */
const LLM_RETRY_MAX_N = Math.max(0, parseInt(LLM_RETRY_MAX!, 10));
const LLM_RETRY_BASE = Math.max(250, parseInt(LLM_RETRY_BASE_MS!, 10));
const LLM_COOL_MIN = Math.max(5, parseInt(LLM_ON_429_SLEEP_MIN!, 10));
let llmDisabledUntilMs = 0;

function jitter(ms: number) { return Math.floor(ms * (0.75 + Math.random() * 0.5)); }
async function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function withLlmRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
  if (Date.now() < llmDisabledUntilMs) {
    const mins = Math.ceil((llmDisabledUntilMs - Date.now()) / 60000);
    throw new Error(`[LLM disabled ${mins}m] ${label} skipped due to previous 429`);
  }
  let lastErr: any = null;
  for (let i = 0; i <= LLM_RETRY_MAX_N; i++) {
    try { return await fn(); }
    catch (e: any) {
      lastErr = e;
      const code = e?.code || e?.error?.code;
      const status = e?.status;
      const type = e?.error?.type;

      if (code === "insufficient_quota" || status === 429 || type === "rate_limit_exceeded") {
        llmDisabledUntilMs = Date.now() + LLM_COOL_MIN * 60000;
        console.error(`[${label}] 429/quota — cooling off for ${LLM_COOL_MIN} minutes.`);
        throw e;
      }
      if (status >= 500 || status === 408 || code === "ETIMEDOUT" || code === "ECONNRESET") {
        const delay = jitter(LLM_RETRY_BASE * Math.pow(2, i));
        console.warn(`[${label}] transient error; retry ${i+1}/${LLM_RETRY_MAX_N} in ${Math.round(delay/1000)}s`);
        await sleep(delay);
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}

/* =========================
   Text generation
========================= */
function trimTweet(s: string, limit: number) {
  const t = s.trim().replace(/^"|"$/g, "");
  if (t.length <= limit) return t;
  const cut = t.slice(0, limit - 1);
  const last = Math.max(cut.lastIndexOf("\n"), cut.lastIndexOf(". "), cut.lastIndexOf("."));
  return (last > 50 ? cut.slice(0, last + 1) : cut).trim();
}
async function generateTweet(): Promise<string> {
  const { system, user, fewshot } = buildTweetPrompt(character as any);
  const messages: OpenAI.ChatCompletionMessageParam[] = [
    { role: "system", content: system },
    { role: "user", content: user }
  ];
  if (fewshot) messages.push({ role: "user", content: fewshot });

  const resp = await withLlmRetry("chat.generateTweet", () =>
    openai.chat.completions.create({
      model: OPENAI_MODEL!,
      messages,
      temperature: 0.8,
      max_tokens: 200
    })
  );
  return trimTweet(resp.choices?.[0]?.message?.content ?? "", maxLen);
}

/* =========================
   Image prompt (caption-first)
========================= */
async function buildImagePromptFromCaption(caption: string): Promise<string> {
  const MODE = (IMAGE_PROMPT_MODE || "hybrid").toLowerCase(); // text | hybrid | persona
  const PERSONA_W = Math.max(0, Math.min(1, parseFloat(IMAGE_PROMPT_PERSONA_WEIGHT || "0.25")));
  const MAX_TOK = Math.max(60, Math.min(300, parseInt(IMAGE_PROMPT_MAX_TOKENS || "120", 10)));

  const safeCap = caption.replace(/\s+/g, " ").trim();
  const baseSystem =
    "You write concise prompts for an image generator.\n" +
    "- Output 1–3 short lines, no more.\n" +
    "- Describe concrete subjects, setting, mood, lighting, camera.\n" +
    "- NO text overlays, logos, watermarks, or brand names.\n" +
    "- Keep it visually grounded; avoid abstract token-talk.\n";

  const personaCue =
    "tone: minimalist, clean composition; cinematic lighting; subtle metallic accents; dark background optional.";

  const userCaptionOnly =
    `Caption:\n${safeCap}\n\n` +
    "Task: Convert the caption into a concrete visual scene.\n" +
    "Return ONLY the visual prompt (no extra commentary).";

  const userHybrid =
    `Caption:\n${safeCap}\n\n` +
    `Style cues (optional, light): ${personaCue}\n` +
    "Task: Convert the caption into a concrete visual scene, optionally seasoning with the style cues.\n" +
    "Return ONLY the visual prompt.";

  try {
    const useHybrid = MODE === "hybrid" || MODE === "persona";
    const sys = baseSystem;
    const usr = useHybrid ? userHybrid : userCaptionOnly;

    const resp = await withLlmRetry("chat.buildImagePrompt", () =>
      openai.chat.completions.create({
        model: OPENAI_MODEL || "gpt-4o-mini",
        temperature: 0.6,
        max_tokens: MAX_TOK,
        messages: [
          { role: "system", content: sys },
          { role: "user", content: usr }
        ]
      })
    );

    let prompt = resp.choices?.[0]?.message?.content?.trim() || "";

    if (MODE === "persona" && PERSONA_W > 0) {
      prompt = [
        prompt,
        PERSONA_W >= 0.66
          ? "look: high-contrast, cinematic; subtle metallic accents; dark minimalist set; no text"
          : "look: clean composition; cinematic lighting; no text"
      ].join("\n");
    }

    if (prompt.length < 20) throw new Error("Prompt too short");

    return `${prompt}\nStyle: ${IMAGE_STYLE}`;
  } catch (e) {
    console.warn("LLM image-prompt build failed, falling back to heuristic:", e);
    const base = safeCap
      .replace(/https?:\/\/\S+/g, "")
      .replace(/[#"*@`_~]/g, "")
      .trim();

    const parts = [
      `Visual inspired by: ${base}.`,
      "Describe concrete subjects and environment; cinematic lighting; clean composition; no text, no logos."
    ];
    if ((IMAGE_PROMPT_MODE || "hybrid") !== "text" && parseFloat(IMAGE_PROMPT_PERSONA_WEIGHT || "0.25") > 0) {
      parts.push("Subtle style: minimalist, high-contrast.");
    }
    return `${parts.join(" ")}\nStyle: ${IMAGE_STYLE}`;
  }
}

/* =========================
   ALT text
========================= */
async function buildAltTextFromCaption(caption: string, conceptHint?: string): Promise<string> {
  try {
    const sys = "Write concise, objective ALT text for an image (<= 250 chars). No hashtags or emojis.";
    const user = `Caption: "${caption}"\nConcept hint: "${conceptHint || ""}"\nDescribe the likely image contents concisely.`;
    const resp = await withLlmRetry("chat.altText", () =>
      openai.chat.completions.create({
        model: OPENAI_MODEL || "gpt-4o-mini",
        temperature: 0.3,
        max_tokens: 120,
        messages: [
          { role: "system", content: sys },
          { role: "user", content: user }
        ]
      })
    );
    const out = resp.choices?.[0]?.message?.content?.trim();
    if (out && out.length > 10) return out.slice(0, 240);
  } catch (e) {
    console.warn("ALT text build failed, using default:", e);
  }
  return "Abstract visual aligned with caption; cinematic lighting; clean composition.";
}

/* =========================
   File helpers (URL → /tmp) with correct extensions
========================= */
async function downloadToTmp(url: string, tag = "ref"): Promise<string> {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Download failed ${resp.status} ${resp.statusText} for ${url}`);
  const arrayBuf = await resp.arrayBuffer();

  // pick extension from URL, fallback to .png
  let ext = ".png";
  if (/\.(jpe?g)(\?|$)/i.test(url)) ext = ".jpg";
  else if (/\.webp(\?|$)/i.test(url)) ext = ".webp";

  const filePath = path.join("/tmp", `${tag}_${Date.now()}${ext}`);
  fs.writeFileSync(filePath, Buffer.from(arrayBuf));
  return filePath;
}
function resolveMaybeRelative(p?: string) {
  if (!p) return undefined as string | undefined;
  return path.isAbsolute(p) ? p : path.join(process.cwd(), p);
}
async function resolveRefAndMask(): Promise<{ refPath?: string; maskPath?: string }> {
  let refPath: string | undefined; 
  let maskPath: string | undefined;

  try {
    if (IMAGE_REF_URL) refPath = await downloadToTmp(IMAGE_REF_URL, "ref");
    else if (IMAGE_REF_PATH) {
      const rp = resolveMaybeRelative(IMAGE_REF_PATH);
      if (rp && fs.existsSync(rp)) refPath = rp; else console.warn("IMAGE_REF_PATH not found:", rp);
    }
  } catch (e) {
    console.warn("Reference image unavailable, falling back to generate:", e);
    refPath = undefined;
  }

  try {
    if (IMAGE_MASK_URL) maskPath = await downloadToTmp(IMAGE_MASK_URL, "mask");
    else if (IMAGE_MASK_PATH) {
      const mp = resolveMaybeRelative(IMAGE_MASK_PATH);
      if (mp && fs.existsSync(mp)) maskPath = mp; else console.warn("IMAGE_MASK_PATH not found:", mp);
    }
  } catch (e) {
    console.warn("Mask image unavailable, continuing without mask:", e);
    maskPath = undefined;
  }

  return { refPath, maskPath };
}

/* =========================
   Images: generate OR edit (with reference)
========================= */
async function generateImage(prompt: string): Promise<string> {
  const res = await withLlmRetry("images.generate", () =>
    openai.images.generate({
      model: "gpt-image-1",
      prompt,
      size: IMAGE_SIZE as "256x256" | "512x512" | "1024x1024"
    })
  );

  const data = (res as any)?.data as Array<any> | undefined;
  if (!data || data.length === 0) throw new Error("Image generation failed: empty response from Images API");

  const b64 = data[0]?.b64_json as string | undefined;
  if (b64) {
    const bytes = Buffer.from(b64, "base64");
    const filePath = path.join("/tmp", `image_${Date.now()}.png`);
    fs.writeFileSync(filePath, bytes);
    return filePath;
  }
  const url = data[0]?.url as string | undefined;
  if (url) {
    return await downloadToTmp(url, "image");
  }
  throw new Error("Image generation failed: neither b64_json nor url in response");
}
function buildFinalImagePrompt(derived: string): string {
  const IMAGE_PROMPT_OVERRIDE = process.env.IMAGE_PROMPT_OVERRIDE;
  const IMAGE_PROMPT_PREFIX = process.env.IMAGE_PROMPT_PREFIX || "";
  const IMAGE_PROMPT_SUFFIX = process.env.IMAGE_PROMPT_SUFFIX || "";
  if (IMAGE_PROMPT_OVERRIDE && IMAGE_PROMPT_OVERRIDE.trim()) return IMAGE_PROMPT_OVERRIDE.trim();
  const parts = [IMAGE_PROMPT_PREFIX.trim(), derived.trim(), IMAGE_PROMPT_SUFFIX.trim()].filter(Boolean);
  return parts.join("\n");
}
async function generateImageFromPromptOrReference(derivedPrompt: string): Promise<string> {
  const finalPrompt = buildFinalImagePrompt(derivedPrompt);
  const { refPath, maskPath } = await resolveRefAndMask();

  if (refPath) {
    const params: any = {
      model: "gpt-image-1",
      prompt: finalPrompt,
      image: fs.createReadStream(refPath),
      size: IMAGE_SIZE as any
    };
    if (maskPath) params.mask = fs.createReadStream(maskPath);

    const res = await withLlmRetry("images.edit", () =>
      openai.images.edit(params) // v4 SDK: .edit (singular)
    );

    const data = (res as any)?.data as Array<any> | undefined;
    if (!data || data.length === 0) throw new Error("Image edit failed: empty response");

    const b64 = data[0]?.b64_json as string | undefined;
    if (b64) {
      const file = path.join("/tmp", `edit_${Date.now()}.png`);
      fs.writeFileSync(file, Buffer.from(b64, "base64"));
      return file;
    }
    const url = data[0]?.url as string | undefined;
    if (url) return await downloadToTmp(url, "edit");

    throw new Error("Image edit failed: neither b64_json nor url");
  }

  return await generateImage(finalPrompt);
}

/* =========================
   Posting (text / image)
========================= */
async function postTweet(text: string) {
  if (dryRun) { console.log("[DRY RUN] Would post TEXT:\n" + text); return { id: "dryrun" }; }
  const res = await twitter.v2.tweet(text);
  console.log("Posted tweet id:", res.data?.id);
  return { id: res.data?.id as string | undefined };
}
async function postImageTweet(imagePath: string, text: string, altText?: string) {
  if (dryRun) { console.log("[DRY RUN] Would post IMAGE:", imagePath); console.log("[DRY RUN] Caption:", text); return { id: "dryrun" }; }
  const mediaId = await twitter.v1.uploadMedia(imagePath);
  if (altText && altText.trim()) {
    try { await twitter.v1.createMediaMetadata(mediaId, { alt_text: { text: altText.slice(0, 1000) } }); } catch (e) { console.warn("ALT text set failed (non-fatal):", e); }
  }
  const res = await twitter.v2.tweet({ text, media: { media_ids: [mediaId] } as any });
  console.log("Posted image tweet id:", res.data?.id);
  return { id: res.data?.id as string | undefined };
}

/* =========================
   Memory (posts, images, authors)
========================= */
const memoryOn = /^true$/i.test(MEMORY_ENABLED!);
const memoryFile = MEMORY_FILE!;
const maxMemPosts = Math.max(50, parseInt(MEMORY_MAX_POSTS!, 10));
const memTtlDays = Math.max(1, parseInt(MEMORY_TTL_DAYS!, 10));
const simThresh = Math.min(0.999, Math.max(0, parseFloat(SIMILARITY_THRESHOLD!)));
const topicCooldownMs = Math.max(0, parseInt(TOPIC_COOLDOWN_MINUTES!, 10)) * 60 * 1000;
const maxRegen = Math.max(1, parseInt(MAX_REGEN_TRIES!, 10));
const skipOnDup = /^true$/i.test(SKIP_ON_DUPLICATE!);

type PostRec = { hash: string; text: string; ts: number; topics: string[] };
type ImgRec  = { hash: string; prompt: string; ts: number };
type AuthorRec = { id: string; ts: number };
type MemoryData = { posts: PostRec[]; images: ImgRec[]; authors: AuthorRec[]; lastPruned?: number };

function nowMs() { return Date.now(); }
function days(n: number) { return n * 86400000; }
function normalizeText(s: string) {
  return s
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, "")
    .replace(/@[a-z0-9_]+/gi, "")
    .replace(/#[\p{L}\p{N}_-]+/gu, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}
function sha256(s: string) { return crypto.createHash("sha256").update(s).digest("hex"); }
const STOP = new Set(["the","a","an","and","or","but","if","on","in","to","for","of","with","from","is","are","was","were","be","been","it","this","that","these","those","as","at","by","we","you","i","they","he","she","them","our","your","their"]);
function tokens(s: string): string[] { return normalizeText(s).split(" ").filter(w => w && !STOP.has(w)); }
function bigrams(ws: string[]) { const out:string[]=[]; for (let i=0;i<ws.length-1;i++) out.push(ws[i]+" "+ws[i+1]); return out; }
function extractTopics(s: string): string[] {
  const t = tokens(s); const uni = t.slice(0,6); const bi = bigrams(t).slice(0,4);
  return [...new Set([...bi, ...uni])].slice(0,8);
}
function jaccard(a: Set<string>, b: Set<string>) {
  const inter = [...a].filter(x => b.has(x)).length;
  const uni = a.size + b.size - inter;
  return uni === 0 ? 0 : inter / uni;
}

function loadMem(): MemoryData {
  if (!memoryOn) return { posts: [], images: [], authors: [] };
  try {
    if (fs.existsSync(memoryFile)) {
      const d = JSON.parse(fs.readFileSync(memoryFile, "utf-8"));
      return { posts: d.posts ?? [], images: d.images ?? [], authors: d.authors ?? [], lastPruned: d.lastPruned };
    }
  } catch {}
  return { posts: [], images: [], authors: [] };
}
function saveMem(m: MemoryData) {
  if (!memoryOn) return;
  try { fs.writeFileSync(memoryFile, JSON.stringify(m), "utf-8"); } catch {}
}
const mem: MemoryData = loadMem();

function pruneMem(force=false) {
  if (!memoryOn) return;
  const t = nowMs();
  if (!force && mem.lastPruned && t - mem.lastPruned < 30*60000) return;
  const cutoff = t - days(memTtlDays);
  mem.posts = mem.posts.filter(p => p.ts >= cutoff).slice(-maxMemPosts);
  mem.images = mem.images.filter(i => i.ts >= cutoff).slice(-maxMemPosts);
  mem.authors = mem.authors.filter(a => a.ts >= t - days(7)).slice(-2000);
  mem.lastPruned = t;
  saveMem(mem);
}
pruneMem(true);

function isDuplicateText(text: string): boolean {
  const n = normalizeText(text);
  const h = sha256(n);
  if (mem.posts.some(p => p.hash === h)) return true;
  const A = new Set(tokens(n));
  for (const p of mem.posts) {
    const B = new Set(tokens(p.text));
    const sim = jaccard(A, B);
    if (sim >= simThresh) return true;
  }
  return false;
}
function isTopicCooling(text: string): boolean {
  if (!topicCooldownMs) return false;
  const now = nowMs();
  const topics = new Set(extractTopics(text));
  for (const p of mem.posts) {
    if (now - p.ts > topicCooldownMs) continue;
    if (p.topics.some(tp => topics.has(tp))) return true;
  }
  return false;
}
function rememberPost(text: string) {
  if (!memoryOn) return;
  const n = normalizeText(text);
  mem.posts.push({ hash: sha256(n), text: n, ts: nowMs(), topics: extractTopics(n) });
  pruneMem(true); saveMem(mem);
}
function seenImagePrompt(prompt: string): boolean {
  const n = normalizeText(prompt);
  const h = sha256(n);
  if (mem.images.some(i => i.hash === h)) return true;
  const A = new Set(tokens(n));
  for (const i of mem.images) {
    const B = new Set(tokens(i.prompt));
    const sim = jaccard(A, B);
    if (sim >= Math.max(0.4, simThresh - 0.1)) return true;
  }
  return false;
}
function rememberImagePrompt(prompt: string) {
  if (!memoryOn) return;
  const n = normalizeText(prompt);
  mem.images.push({ hash: sha256(n), prompt: n, ts: nowMs() });
  pruneMem(true); saveMem(mem);
}
function recordAuthorReplied(id: string) {
  mem.authors.push({ id, ts: nowMs() });
  pruneMem(true); saveMem(mem);
}
function recentlyRepliedTo(id: string, minutesCooldown: number) {
  const cutoff = nowMs() - minutesCooldown * 60000;
  return mem.authors.some(a => a.id === id && a.ts >= cutoff);
}

/* =========================
   Replies: generation
========================= */
async function generateReplyForTweet(sourceText: string, authorHandle?: string): Promise<string> {
  const sys = [
    `${(character as any).name || "Dao-Man"} — reply mode:`,
    ...((character as any).style?.chatStyle ?? []),
    ...((character as any).style?.allStyles ?? []),
    "",
    "Constraints:",
    "- Short, human, value-adding. No hashtags/emojis.",
    "- Add one lever, heuristic, or next action.",
    `- 1–3 lines; ${replyMaxLen} chars max.`
  ].join("\n");

  const usr = [
    `You're replying to ${authorHandle ? "@" + authorHandle : "a tweet"}:`,
    sourceText,
    "",
    "Write ONE reply in this voice. Return ONLY the reply text."
  ].join("\n");

  const resp = await withLlmRetry("chat.generateReply", () =>
    openai.chat.completions.create({
      model: OPENAI_MODEL!,
      temperature: 0.7,
      max_tokens: 160,
      messages: [
        { role: "system", content: sys },
        { role: "user", content: usr }
      ]
    })
  );

  const text = resp.choices?.[0]?.message?.content?.trim() || "";
  const trimmed = trimTweet(text, replyMaxLen);
  return trimmed.length >= replyMinLen ? trimmed : "";
}

/* =========================
   Posting loop
========================= */
let repliesToday = 0;
let repliesDayStamp = new Date().toISOString().slice(0, 10);
function resetDailyIfNeeded() {
  const d = new Date().toISOString().slice(0, 10);
  if (d !== repliesDayStamp) { repliesDayStamp = d; repliesToday = 0; }
}

async function waitForActiveWindow() {
  if (withinActiveHours()) return;
  const ms = msUntilActiveStart();
  console.log(`Outside active hours; sleeping ${(ms / 60000).toFixed(0)} minutes...`);
  await new Promise(r => setTimeout(r, ms));
}

async function ensureNovelCaption(): Promise<string | null> {
  let lastDraft = "";
  for (let attempt = 1; attempt <= Math.max(1, parseInt(MAX_REGEN_TRIES!, 10)); attempt++) {
    const draft = await generateTweet();
    lastDraft = draft;
    const dup = isDuplicateText(draft);
    const hot = isTopicCooling(draft);
    if (!dup && !hot) return draft;
    console.log(`Caption rejected (dup=${dup}, hotTopic=${hot}) — attempt ${attempt}/${MAX_REGEN_TRIES}`);
  }
  if (/^true$/i.test(SKIP_ON_DUPLICATE!)) {
    console.log("Caption remained duplicate after retries; skipping this cycle.");
    return null;
  }
  console.log("Caption remained duplicate; posting anyway.");
  return lastDraft;
}

async function postingLoop() {
  let cycleCount = 0;
  while (true) {
    try {
      if (Date.now() < llmDisabledUntilMs) {
        const mins = Math.ceil((llmDisabledUntilMs - Date.now()) / 60000);
        console.log(`LLM cooling off; sleeping ${mins} minutes...`);
        await sleep(Math.max(60000, llmDisabledUntilMs - Date.now()));
        continue;
      }

      await waitForActiveWindow();

      cycleCount += 1;
      const caption = await ensureNovelCaption();
      if (!caption) { await sleep(Math.min(15, minMin) * 60000); continue; }

      const shouldImage = enableImagePosts && (cycleCount % imageEvery === 0);

      if (shouldImage) {
        let imagePrompt = await buildImagePromptFromCaption(caption);
        if (seenImagePrompt(imagePrompt)) imagePrompt += `\nVariation: different angle, altered lighting, distinct color palette.`;
        const finalPrompt = buildFinalImagePrompt(imagePrompt);
        const imgPath = await generateImageFromPromptOrReference(finalPrompt);
        const altText = await buildAltTextFromCaption(caption, finalPrompt);
        console.log("Image prompt:", finalPrompt);
        console.log("Generated image:", imgPath);
        await postImageTweet(imgPath, caption, altText);
        rememberImagePrompt(finalPrompt);
        rememberPost(caption);
      } else {
        console.log("Generated:", caption);
        await postTweet(caption);
        rememberPost(caption);
      }
    } catch (e) {
      console.error("Cycle error:", e);
    }

    const delay = randDelayMs();
    console.log(`Sleeping ${(delay / 60000).toFixed(0)} minutes...`);
    await sleep(delay);
  }
}

/* =========================
   Discovery Sniper Loop
========================= */
async function discoverySniperLoop() {
  if (!enableDiscoverySniper || discoveryQueries.length === 0) {
    console.log("Discovery sniper disabled or no DISCOVERY_QUERIES.");
    return;
  }

  while (true) {
    try {
      if (Date.now() < llmDisabledUntilMs) {
        const mins = Math.ceil((llmDisabledUntilMs - Date.now()) / 60000);
        console.log(`(discovery) LLM cooling off; sleeping ${mins} minutes...`);
        await sleep(Math.max(60000, llmDisabledUntilMs - Date.now()));
        continue;
      }

      resetDailyIfNeeded();

      if (repliesToday >= replyDailyCap) {
        console.log(`discoveryLoop: daily cap reached (${repliesToday}/${replyDailyCap}).`);
      } else if (Math.random() < discoveryProb) {
        const q = discoveryQueries[Math.floor(Math.random() * discoveryQueries.length)];
        const sinceMs = Date.now() - discoveryLookbackMinutes * 60000;
        const lookbackIso = new Date(sinceMs).toISOString();
        const query = `${q} lang:en -is:retweet`;

        const res = await twitter.v2.search(query, {
          max_results: 50,
          "tweet.fields": ["author_id","created_at","public_metrics","referenced_tweets","conversation_id","text"],
          expansions: ["author_id"],
          "user.fields": ["username","verified","public_metrics"]
        });

        const users = new Map<string, any>();
        const incUsers = (res as any)?.includes?.users as any[] | undefined;
        if (incUsers) for (const u of incUsers) users.set(u.id, u);

        const tweets = (res.data?.data ?? []) as any[];

        const candidates = tweets.filter((t: any) => {
          const fresh = t.created_at && new Date(t.created_at).getTime() >= sinceMs && t.created_at >= lookbackIso;
          const isTopLevel = !(t.referenced_tweets && t.referenced_tweets.some((r: any) => r.type !== "replied_to"));
          const pm: any = t.public_metrics || {};
          const author = users.get(t.author_id as string);
          if (!author) return false;
          const followers = author.public_metrics?.followers_count ?? 0;
          const verified = !!author.verified;
          const fameOK = followers >= discoveryMinFollowers && (!discoveryRequireVerified || verified);
          const popOK = (pm.retweet_count ?? 0) >= discoveryMinRetweets;
          const authorId = t.author_id as string | undefined;
          if (!authorId) return false;
          const cooldownOK = !recentlyRepliedTo(authorId, recentAuthorCooldownMin);
          return fresh && isTopLevel && fameOK && popOK && cooldownOK;
        });

        if (candidates.length > 0) {
          const shuffled = candidates.sort(() => Math.random() - 0.5).slice(0, discoveryMaxPerRun);
          for (const t of shuffled) {
            if (repliesToday >= replyDailyCap) break;

            const authorId = t.author_id as string | undefined;
            const tweetId = t.id as string | undefined;
            if (!authorId || !tweetId) continue;

            const author = users.get(authorId);
            const handle = (author?.username as string | undefined) || "user";

            const replyText = await generateReplyForTweet(String(t.text || ""), handle);
            if (!replyText) continue;

            if (dryRun) {
              console.log(`[DRY RUN] Discovery reply to @${handle} (${tweetId}):\n${replyText}`);
            } else {
              const posted = await twitter.v2.reply(replyText, tweetId as string);
              console.log("Discovery replied to", handle, "tweetId:", tweetId, "→", posted.data?.id);
            }
            repliesToday += 1;
            recordAuthorReplied(authorId);
            await sleep(5000 + Math.floor(Math.random() * 10000));
          }
        } else {
          console.log("discoveryLoop: no suitable candidates this run.");
        }
      } else {
        console.log("discoveryLoop: probability gate skipped this run.");
      }
    } catch (e) {
      console.error("discoverySniperLoop error:", e);
    }

    const delay = randRangeMs(discoveryCheckMin, discoveryCheckMax);
    console.log(`discoveryLoop sleeping ${(delay / 60000).toFixed(0)} minutes...`);
    await sleep(delay);
  }
}

/* =========================
   Bootstrap
========================= */
(async () => {
  if (postImmediately) {
    try {
      await waitForActiveWindow();
      const caption = await ensureNovelCaption();

      if (caption) {
        if (enableImagePosts && imageEvery === 1) {
          let imagePrompt = await buildImagePromptFromCaption(caption);
          if (seenImagePrompt(imagePrompt)) imagePrompt += `\nVariation: different angle, altered lighting, distinct color palette.`;
          const finalPrompt = buildFinalImagePrompt(imagePrompt);
          const imgPath = await generateImageFromPromptOrReference(finalPrompt);
          const altText = await buildAltTextFromCaption(caption, finalPrompt);
          console.log("Image prompt (immediate):", finalPrompt);
          await postImageTweet(imgPath, caption, altText);
          rememberImagePrompt(finalPrompt);
          rememberPost(caption);
        } else {
          console.log("Generated (immediate):", caption);
          await postTweet(caption);
          rememberPost(caption);
        }
      }
    } catch (e) {
      console.error("Immediate post failed:", e);
    }
  }

  // Run posting + discovery in parallel
  await Promise.all([
    postingLoop(),
    discoverySniperLoop()
  ]);
})();
