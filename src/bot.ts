import "dotenv/config";
import { TwitterApi } from "twitter-api-v2";
import OpenAI from "openai";
import { buildTweetPrompt } from "./prompt.js";
import character from "./character.js";

const {
  X_API_KEY,
  X_API_SECRET,
  X_ACCESS_TOKEN,
  X_ACCESS_SECRET,
  OPENAI_API_KEY,
  OPENAI_BASE_URL,
  OPENAI_MODEL = "gpt-4o-mini",
  POST_INTERVAL_MIN = "120",
  POST_INTERVAL_MAX = "240",
  POST_IMMEDIATELY = "false",
  MAX_TWEET_LENGTH = "280",
  DRY_RUN = "true",
  ACTIVE_HOURS_START,
  ACTIVE_HOURS_END,
  TIMEZONE = "Europe/Athens"
} = process.env;

function need(name: string, val?: string) { if (!val) throw new Error(`Missing env ${name}`); }
need("X_API_KEY", X_API_KEY);
need("X_API_SECRET", X_API_SECRET);
need("X_ACCESS_TOKEN", X_ACCESS_TOKEN);
need("X_ACCESS_SECRET", X_ACCESS_SECRET);
need("OPENAI_API_KEY", OPENAI_API_KEY);

const twitter = new TwitterApi({
  appKey: X_API_KEY!, appSecret: X_API_SECRET!,
  accessToken: X_ACCESS_TOKEN!, accessSecret: X_ACCESS_SECRET!
});

const openai = new OpenAI({ apiKey: OPENAI_API_KEY!, baseURL: OPENAI_BASE_URL });

const minMin = Math.max(5, parseInt(POST_INTERVAL_MIN!, 10));
const maxMin = Math.max(minMin, parseInt(POST_INTERVAL_MAX!, 10));
const postImmediately = /^true$/i.test(POST_IMMEDIATELY!);
const maxLen = Math.min(1000, Math.max(80, parseInt(MAX_TWEET_LENGTH!, 10)));
const dryRun = /^true$/i.test(DRY_RUN!);

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
  const next = new Date(tzNow); next.setHours(sh, sm, 0, 0); if (next <= tzNow) next.setDate(next.getDate() + 1);
  return next.getTime() - tzNow.getTime();
}
function randDelayMs() { return (Math.floor(Math.random() * (maxMin - minMin + 1)) + minMin) * 60 * 1000; }
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

  const resp = await openai.chat.completions.create({
    model: OPENAI_MODEL!, messages, temperature: 0.8, max_tokens: 200
  });
  return trimTweet(resp.choices?.[0]?.message?.content ?? "", maxLen);
}

async function postTweet(text: string) {
  if (dryRun) { console.log("[DRY RUN] Would post:\n" + text); return; }
  const res = await twitter.v2.tweet(text);
  console.log("Posted tweet id:", res.data?.id);
}

async function waitForActiveWindow() {
  if (withinActiveHours()) return;
  const ms = msUntilActiveStart();
  console.log(`Outside active hours; sleeping ${(ms / 60000).toFixed(0)} minutes...`);
  await new Promise(r => setTimeout(r, ms));
}

async function loop() {
  while (true) {
    try {
      await waitForActiveWindow();
      const t = await generateTweet();
      if (t.length < 5) throw new Error("Generated text too short.");
      console.log("Generated:", t);
      await postTweet(t);
    } catch (e) {
      console.error("Cycle error:", e);
    }
    const delay = randDelayMs();
    console.log(`Sleeping ${(delay / 60000).toFixed(0)} minutes...`);
    await new Promise(r => setTimeout(r, delay));
  }
}

(async () => {
  if (postImmediately) {
    try { await waitForActiveWindow(); const t = await generateTweet(); console.log("Generated (immediate):", t); await postTweet(t); }
    catch (e) { console.error("Immediate post failed:", e); }
  }
  await loop();
})();
