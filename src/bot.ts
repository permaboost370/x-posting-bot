// src/bot.ts
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { TwitterApi } from "twitter-api-v2";
import OpenAI from "openai";
import { buildTweetPrompt } from "./prompt.js";
import character from "./character.js";

const {
  // X / Twitter
  X_API_KEY,
  X_API_SECRET,
  X_ACCESS_TOKEN,
  X_ACCESS_SECRET,

  // LLM
  OPENAI_API_KEY,
  OPENAI_BASE_URL,
  OPENAI_MODEL = "gpt-4o-mini",

  // Posting cadence
  POST_INTERVAL_MIN = "120",
  POST_INTERVAL_MAX = "240",
  POST_IMMEDIATELY = "false",

  // Safety / ops
  MAX_TWEET_LENGTH = "280",
  DRY_RUN = "true",

  // (Optional) Active-hours — leave unset to post 24/7
  ACTIVE_HOURS_START,
  ACTIVE_HOURS_END,
  TIMEZONE = "Europe/Athens",

  // === NEW: Image posting controls ===
  ENABLE_IMAGE_POSTS = "false",   // "true" to enable image cycles
  IMAGE_FREQUENCY = "3",          // every Nth cycle uses an image (1 = every cycle)
  IMAGE_SIZE = "1024x1024",       // 256x256 | 512x512 | 1024x1024
  IMAGE_STYLE = "high-contrast, clean composition" // appended to image prompt
} = process.env;

// ----- guards -----
function need(name: string, val?: string) {
  if (!val) throw new Error(`Missing env ${name}`);
}
need("X_API_KEY", X_API_KEY);
need("X_API_SECRET", X_API_SECRET);
need("X_ACCESS_TOKEN", X_ACCESS_TOKEN);
need("X_ACCESS_SECRET", X_ACCESS_SECRET);
need("OPENAI_API_KEY", OPENAI_API_KEY);

// ----- clients -----
const twitter = new TwitterApi({
  appKey: X_API_KEY!,
  appSecret: X_API_SECRET!,
  accessToken: X_ACCESS_TOKEN!,
  accessSecret: X_ACCESS_SECRET!
});

const openai = new OpenAI({
  apiKey: OPENAI_API_KEY!,
  baseURL: OPENAI_BASE_URL // leave undefined for native OpenAI; set for OpenRouter-compatible
});

// ----- config -----
const minMin = Math.max(5, parseInt(POST_INTERVAL_MIN!, 10));
const maxMin = Math.max(minMin, parseInt(POST_INTERVAL_MAX!, 10));
const postImmediately = /^true$/i.test(POST_IMMEDIATELY!);
const maxLen = Math.min(1000, Math.max(80, parseInt(MAX_TWEET_LENGTH!, 10)));
const dryRun = /^true$/i.test(DRY_RUN!);

const enableImagePosts = /^true$/i.test(ENABLE_IMAGE_POSTS!);
const imageEvery = Math.max(1, parseInt(IMAGE_FREQUENCY!, 10));

// ----- helpers: time / intervals -----
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

// ----- helpers: text gen -----
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
    model: OPENAI_MODEL!,
    messages,
    temperature: 0.8,
    max_tokens: 200
  });
  return trimTweet(resp.choices?.[0]?.message?.content ?? "", maxLen);
}

// ----- NEW: caption → image prompt + alt text -----
async function buildImagePromptFromCaption(caption: string): Promise<string> {
  try {
    const sys =
      "You craft concise prompts for an image generator. 1–3 lines. " +
      "No text overlays or logos. High-contrast, clean composition. " +
      "Describe objects/scene/lighting/camera if relevant.";
    const user =
      `Caption:\n${caption}\n\nPersona cues: DAO/ledger/flywheel, metallic accents, minimalist dark background, cinematic rim light.\n` +
      `Return ONLY the prompt.`;

    const resp = await openai.chat.completions.create({
      model: OPENAI_MODEL || "gpt-4o-mini",
      temperature: 0.6,
      max_tokens: 120,
      messages: [
        { role: "system", content: sys },
        { role: "user", content: user }
      ]
    });
    const out = resp.choices?.[0]?.message?.content?.trim();
    if (out && out.length > 10) {
      return `${out}\nStyle: ${IMAGE_STYLE}`;
    }
  } catch (e) {
    console.warn("LLM image-prompt build failed, using heuristic:", e);
  }

  // Heuristic fallback
  const core = caption
    .replace(/[#@"'`_*~]/g, "")
    .split(/\s+/)
    .filter(w => w.length > 2 && /^[a-zA-Z\-]+$/.test(w))
    .slice(0, 10)
    .join(" ");
  return `Minimalist, high-contrast concept art inspired by: ${core}. Metallic accents, dark background, soft rim lighting, clean composition, no text, no logos. Style: ${IMAGE_STYLE}`;
}

async function buildAltTextFromCaption(caption: string, conceptHint?: string): Promise<string> {
  try {
    const sys = "Write concise, objective ALT text for an image (<= 250 chars). No hashtags or emojis.";
    const user = `Caption: "${caption}"\nConcept hint: "${conceptHint || ""}"\nDescribe the likely image contents concisely.`;
    const resp = await openai.chat.completions.create({
      model: OPENAI_MODEL || "gpt-4o-mini",
      temperature: 0.3,
      max_tokens: 120,
      messages: [
        { role: "system", content: sys },
        { role: "user", content: user }
      ]
    });
    const out = resp.choices?.[0]?.message?.content?.trim();
    if (out && out.length > 10) return out.slice(0, 240);
  } catch (e) {
    console.warn("ALT text build failed, using default:", e);
  }
  return "Abstract visual aligned with caption: DAO cash-flow flywheel motif with metallic accents on a dark minimalist background.";
}

// ----- NEW: image generation + posting -----
async function generateImage(prompt: string): Promise<string> {
  const img = await openai.images.generate({
    model: "gpt-image-1",
    prompt,
    size: IMAGE_SIZE as "256x256" | "512x512" | "1024x1024",
    response_format: "b64_json"
  });

  const b64 = img.data[0].b64_json!;
  const bytes = Buffer.from(b64, "base64");
  const filename = `image_${Date.now()}.png`;
  const filePath = path.join("/tmp", filename);
  fs.writeFileSync(filePath, bytes);
  return filePath;
}

async function postTweet(text: string) {
  if (dryRun) {
    console.log("[DRY RUN] Would post TEXT:\n" + text);
    return;
  }
  const res = await twitter.v2.tweet(text);
  console.log("Posted tweet id:", res.data?.id);
}

async function postImageTweet(imagePath: string, text: string, altText?: string) {
  if (dryRun) {
    console.log("[DRY RUN] Would post IMAGE:", imagePath);
    console.log("[DRY RUN] Caption:", text);
    return;
  }
  // Upload media (v1.1), then tweet (v2)
  const mediaId = await twitter.v1.uploadMedia(imagePath);
  if (altText && altText.trim()) {
    try {
      await twitter.v1.createMediaMetadata(mediaId, { alt_text: { text: altText.slice(0, 1000) } });
    } catch (e) {
      console.warn("ALT text set failed (non-fatal):", e);
    }
  }
  const res = await twitter.v2.tweet({ text, media: { media_ids: [mediaId] } as any });
  console.log("Posted image tweet id:", res.data?.id);
}

// ----- main loop -----
async function waitForActiveWindow() {
  if (withinActiveHours()) return;
  const ms = msUntilActiveStart();
  console.log(`Outside active hours; sleeping ${(ms / 60000).toFixed(0)} minutes...`);
  await new Promise(r => setTimeout(r, ms));
}

async function loop() {
  let cycleCount = 0;
  while (true) {
    try {
      await waitForActiveWindow();

      cycleCount += 1;
      const caption = await generateTweet();

      const shouldImage = enableImagePosts && (cycleCount % imageEvery === 0);

      if (shouldImage) {
        const imagePrompt = await buildImagePromptFromCaption(caption);
        const imgPath = await generateImage(imagePrompt);
        const altText = await buildAltTextFromCaption(caption, imagePrompt);

        console.log("Image prompt:", imagePrompt);
        console.log("Generated image:", imgPath);

        await postImageTweet(imgPath, caption, altText);
      } else {
        console.log("Generated:", caption);
        await postTweet(caption);
      }
    } catch (e) {
      console.error("Cycle error:", e);
    }

    const delay = randDelayMs();
    console.log(`Sleeping ${(delay / 60000).toFixed(0)} minutes...`);
    await new Promise(r => setTimeout(r, delay));
  }
}

// ----- bootstrap -----
(async () => {
  if (postImmediately) {
    try {
      await waitForActiveWindow();
      const caption = await generateTweet();

      if (enableImagePosts && imageEvery === 1) {
        const imagePrompt = await buildImagePromptFromCaption(caption);
        const imgPath = await generateImage(imagePrompt);
        const altText = await buildAltTextFromCaption(caption, imagePrompt);
        console.log("Image prompt (immediate):", imagePrompt);
        await postImageTweet(imgPath, caption, altText);
      } else {
        console.log("Generated (immediate):", caption);
        await postTweet(caption);
      }
    } catch (e) {
      console.error("Immediate post failed:", e);
    }
  }
  await loop();
})();
