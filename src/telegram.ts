// src/telegram.ts
import TelegramBot from "node-telegram-bot-api";
import fs from "node:fs";
import path from "node:path";
import OpenAI from "openai";
import { fileFromPath } from "openai/uploads";
import { TwitterApi } from "twitter-api-v2";
import character from "./character.js";
import { buildTweetPrompt } from "./prompt.js";
import { getState, setState, postsToday } from "./state.js";
import { fetchTrendingHashtags } from "./trending.js";


/* ========= Optional logging (safe fallbacks, no top-level await) ========= */
// NOTE: We declare typed no-op functions first, then try to replace them via dynamic import.
let logEvent: (t: string, data?: any) => Promise<void> = async () => {};
let getRecentLogs: (n: number) => Array<{ t: string; caption?: string; text?: string; tweet_id?: string }> = () => [];

(async () => {
  try {
    const logging = await import("./util/logging.js");
    // @ts-ignore - dynamic import of JS module
    logEvent = logging.logEvent;
    // @ts-ignore - dynamic import of JS module
    getRecentLogs = logging.getRecentLogs;
  } catch {
    // keep no-op fallbacks
  }
})();

/* ============================= ENV ============================= */
const {
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID, // optional allowlist (string chat id)
  OPENAI_API_KEY,
  OPENAI_BASE_URL,
  OPENAI_MODEL = "gpt-4o-mini",

  // Twitter
  X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_SECRET,

  // Image defaults / reference
  IMAGE_STYLE = "cinematic",
  IMAGE_SIZE = "1024x1024",
  IMAGE_REF_URL,
  IMAGE_REF_PATH,
  IMAGE_MASK_URL,
  IMAGE_MASK_PATH,
} = process.env;

if (!TELEGRAM_BOT_TOKEN) throw new Error("Missing env TELEGRAM_BOT_TOKEN");
if (!OPENAI_API_KEY) throw new Error("Missing env OPENAI_API_KEY");
if (!X_API_KEY || !X_API_SECRET || !X_ACCESS_TOKEN || !X_ACCESS_SECRET) {
  throw new Error("Missing one of X_API_KEY / X_API_SECRET / X_ACCESS_TOKEN / X_ACCESS_SECRET");
}

/* ============================= Clients ============================= */
const openai = new OpenAI({
  apiKey: OPENAI_API_KEY!,
  baseURL: OPENAI_BASE_URL, // leave undefined for native OpenAI
});

const twitter = new TwitterApi({
  appKey: X_API_KEY!, appSecret: X_API_SECRET!,
  accessToken: X_ACCESS_TOKEN!, accessSecret: X_ACCESS_SECRET!,
});

/* =================== Helpers (trim, prompts, files) =================== */
function trimTweet(s: string, limit: number) {
  const t = s.trim().replace(/^"|"$/g, "");
  if (t.length <= limit) return t;
  const cut = t.slice(0, limit - 1);
  const last = Math.max(cut.lastIndexOf("\n"), cut.lastIndexOf(". "), cut.lastIndexOf("."));
  return (last > 50 ? cut.slice(0, last + 1) : cut).trim();
}

async function buildImagePromptFromCaption(caption: string): Promise<string> {
  const baseSystem =
    "You write concise prompts for an image generator.\n" +
    "- Output 1–3 short lines, no more.\n" +
    "- Describe concrete subjects, setting, mood, lighting, camera.\n" +
    "- NO text overlays, logos, watermarks, or brand names.\n" +
    "- Keep it visually grounded; avoid abstract token-talk.\n";

  const personaCue =
    "tone: minimalist, clean composition; cinematic lighting; subtle metallic accents; dark background optional.";

  const userHybrid =
    `Caption:\n${caption}\n\n` +
    `Style cues (optional, light): ${personaCue}\n` +
    "Task: Convert the caption into a concrete visual scene, optionally seasoning with the style cues.\n" +
    "Return ONLY the visual prompt.";

  const resp = await openai.chat.completions.create({
    model: OPENAI_MODEL,
    temperature: 0.6,
    max_tokens: 160,
    messages: [
      { role: "system", content: baseSystem },
      { role: "user", content: userHybrid }
    ]
  });

  const prompt = (resp.choices?.[0]?.message?.content || "").trim();
  if (!prompt || prompt.length < 20) {
    return `${caption}\nDescribe concrete subjects and environment; cinematic lighting; clean composition; no text, no logos.`;
  }
  return prompt;
}

async function buildAltTextFromCaption(caption: string, conceptHint?: string): Promise<string> {
  try {
    const sys = "Write concise, objective ALT text for an image (<= 250 chars). No hashtags or emojis.";
    const user = `Caption: "${caption}"\nConcept hint: "${conceptHint || ""}"\nDescribe the likely image contents concisely.`;
    const resp = await openai.chat.completions.create({
      model: OPENAI_MODEL,
      temperature: 0.3,
      max_tokens: 120,
      messages: [
        { role: "system", content: sys },
        { role: "user", content: user }
      ]
    });
    const out = resp.choices?.[0]?.message?.content?.trim() || "";
    return out.slice(0, 240) || "Abstract visual aligned with caption; cinematic lighting; clean composition.";
  } catch {
    return "Abstract visual aligned with caption; cinematic lighting; clean composition.";
  }
}

function guessMimeByExt(p: string): string {
  const x = p.toLowerCase();
  if (x.endsWith(".jpg") || x.endsWith(".jpeg")) return "image/jpeg";
  if (x.endsWith(".png")) return "image/png";
  if (x.endsWith(".webp")) return "image/webp";
  return "image/png";
}

function resolveMaybeRelative(p?: string) {
  if (!p) return undefined as string | undefined;
  return path.isAbsolute(p) ? p : path.join(process.cwd(), p);
}

async function downloadToTmp(url: string, tag = "ref"): Promise<string> {
  const resp = await fetch(url, { redirect: "follow" });
  if (!resp.ok) throw new Error(`Download failed ${resp.status} ${resp.statusText} for ${url}`);
  const arrayBuf = await resp.arrayBuffer();

  const ct = (resp.headers.get("content-type") || "").toLowerCase();
  let ext = ".png";
  if (ct.includes("image/jpeg")) ext = ".jpg";
  else if (ct.includes("image/png")) ext = ".png";
  else if (ct.includes("image/webp")) ext = ".webp";
  else {
    if (/\.(jpe?g)(\?|$)/i.test(url)) ext = ".jpg";
    else if (/\.webp(\?|$)/i.test(url)) ext = ".webp";
    else ext = ".png";
  }

  const filePath = path.join("/tmp", `${tag}_${Date.now()}${ext}`);
  fs.writeFileSync(filePath, Buffer.from(arrayBuf));
  return filePath;
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
    console.warn("Reference image unavailable, proceeding without:", e);
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

async function generateImageFromPromptOrReference(derivedPrompt: string): Promise<string> {
  const finalPrompt = derivedPrompt;
  const { refPath, maskPath } = await resolveRefAndMask();

  if (!refPath) {
    // pure generate
    const res = await openai.images.generate({
      model: "gpt-image-1",
      prompt: finalPrompt,
      size: IMAGE_SIZE as "256x256" | "512x512" | "1024x1024",
    });
    const data = (res as any)?.data as Array<any> | undefined;
    if (!data || data.length === 0) throw new Error("Image generation failed: empty response");
    const b64 = data[0]?.b64_json as string | undefined;
    if (b64) {
      const bytes = Buffer.from(b64, "base64");
      const filePath = path.join("/tmp", `image_${Date.now()}.png`);
      fs.writeFileSync(filePath, bytes);
      return filePath;
    }
    const url = data[0]?.url as string | undefined;
    if (url) return await downloadToTmp(url, "image");
    throw new Error("Image generation failed: neither b64_json nor url");
  }

  // edit with reference
  try {
    const imageFile = await fileFromPath(refPath, { type: guessMimeByExt(refPath) });
    const maskFile = maskPath ? await fileFromPath(maskPath, { type: "image/png" }) : undefined;

    const res = await openai.images.edit({
      model: "gpt-image-1",
      prompt: finalPrompt,
      image: imageFile,
      ...(maskFile ? { mask: maskFile } : {}),
      size: IMAGE_SIZE as any,
    });

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
  } catch (e) {
    console.warn("images.edit failed; falling back to images.generate:", e);
    const res = await openai.images.generate({
      model: "gpt-image-1",
      prompt: finalPrompt,
      size: IMAGE_SIZE as any,
    });
    const data = (res as any)?.data as Array<any> | undefined;
    if (!data || data.length === 0) throw new Error("Fallback image generation failed: empty response");
    const b64 = data[0]?.b64_json as string | undefined;
    if (b64) {
      const file = path.join("/tmp", `image_${Date.now()}.png`);
      fs.writeFileSync(file, Buffer.from(b64, "base64"));
      return file;
    }
    const url = data[0]?.url as string | undefined;
    if (url) return await downloadToTmp(url, "image");
    throw new Error("Fallback image generation failed: neither b64_json nor url");
  }
}

/* ========================= Telegram wiring ========================= */
let bot: TelegramBot | null = null;

function guard(msg: TelegramBot.Message): boolean {
  if (!TELEGRAM_CHAT_ID) return true;
  return String(msg.chat.id) === TELEGRAM_CHAT_ID;
}

export function startTelegram() {
  if (bot) return; // already started
  bot = new TelegramBot(TELEGRAM_BOT_TOKEN!, { polling: true });

  // /health
  bot.onText(/^\/health$/, async (msg: TelegramBot.Message) => {
    if (!guard(msg)) return;
    bot!.sendMessage(msg.chat.id, "✅ Bot is alive and connected.", { reply_to_message_id: msg.message_id });
  });

  // /log
  bot.onText(/^\/log$/, async (msg: TelegramBot.Message) => {
    if (!guard(msg)) return;
    const logs = getRecentLogs ? getRecentLogs(5) : [];
    const out = logs.map(l => {
      const cap = l.caption || l.text || "(no caption)";
      return `${l.t} | ${cap} | tweetId=${l.tweet_id || "?"}`;
    }).join("\n");
    bot!.sendMessage(msg.chat.id, out || "No recent posts.", { reply_to_message_id: msg.message_id });
  });

  // /tweet → auto caption + image (using your character + prompt builder)
  bot.onText(/^\/tweet$/, async (msg: TelegramBot.Message) => {
    if (!guard(msg)) return;
    try {
      const { system, user, fewshot } = buildTweetPrompt(character as any);
      const messages: OpenAI.ChatCompletionMessageParam[] = [
        { role: "system", content: system },
        { role: "user", content: user },
      ];
      if (fewshot) messages.push({ role: "user", content: fewshot });

      const resp = await openai.chat.completions.create({
        model: OPENAI_MODEL,
        temperature: 0.8,
        max_tokens: 200,
        messages,
      });
      const caption = trimTweet(resp.choices?.[0]?.message?.content ?? "", 280);

      const visualPrompt = await buildImagePromptFromCaption(caption);
      const finalPrompt = `${visualPrompt}\nStyle: ${IMAGE_STYLE}`;
      const imgPath = await generateImageFromPromptOrReference(finalPrompt);

      const mediaId = await twitter.v1.uploadMedia(imgPath);
      try {
        const altText = await buildAltTextFromCaption(caption, finalPrompt);
        await twitter.v1.createMediaMetadata(mediaId, { alt_text: { text: altText } });
      } catch (e) {
        console.warn("ALT text set failed (non-fatal):", e);
      }

      const posted = await twitter.v2.tweet({ text: caption, media: { media_ids: [mediaId] } as any });

      await logEvent("posted_via_telegram", { caption, tweet_id: posted.data?.id });
      bot!.sendMessage(
        msg.chat.id,
        `✅ Posted: https://twitter.com/i/web/status/${posted.data?.id}`,
        { reply_to_message_id: msg.message_id }
      );
    } catch (e: any) {
      bot!.sendMessage(msg.chat.id, `❌ Error posting: ${e?.message || e}`, { reply_to_message_id: msg.message_id });
    }
  });

  // /custom CAPTION | PROMPT
  bot.onText(/^\/custom (.+)$/s, async (msg: TelegramBot.Message, match: RegExpExecArray | null) => {
    if (!guard(msg)) return;
    try {
      const body = (match?.[1] || "").trim();
      const parts = body.split("|").map(s => s.trim());
      const caption = parts[0];
      const prompt = parts[1] || caption;

      if (!caption) {
        bot!.sendMessage(
          msg.chat.id,
          "Usage:\n/custom CAPTION | PROMPT\n\nExample:\n/custom Under a starry sky | wide shot of a tranquil lake, lanterns, fireflies",
          { reply_to_message_id: msg.message_id }
        );
        return;
      }

      const finalPrompt = `${prompt}\nStyle: ${IMAGE_STYLE}`;
      const imgPath = await generateImageFromPromptOrReference(finalPrompt);

      const mediaId = await twitter.v1.uploadMedia(imgPath);
      try {
        const altText = await buildAltTextFromCaption(caption, finalPrompt);
        await twitter.v1.createMediaMetadata(mediaId, { alt_text: { text: altText } });
      } catch (e) {
        console.warn("ALT text set failed (non-fatal):", e);
      }

      const posted = await twitter.v2.tweet({ text: caption, media: { media_ids: [mediaId] } as any });

      await logEvent("custom_post", { caption, prompt, tweet_id: posted.data?.id });
      bot!.sendMessage(
        msg.chat.id,
        `✅ Custom posted: https://twitter.com/i/web/status/${posted.data?.id}`,
        { reply_to_message_id: msg.message_id }
      );
    } catch (e: any) {
      bot!.sendMessage(msg.chat.id, `❌ Error in custom post: ${e?.message || e}`, { reply_to_message_id: msg.message_id });
    }
  });


  /* ====== /pause & /resume ====== */
  bot.onText(/^\/pause$/, async (msg: TelegramBot.Message) => {
    const st = setState({ paused: true });
    return bot.sendMessage(msg.chat.id, `⏸️ Autoposting paused.`);
  });
  bot.onText(/^\/resume$/, async (msg: TelegramBot.Message) => {
    const st = setState({ paused: false });
    return bot.sendMessage(msg.chat.id, `▶️ Autoposting resumed.`);
  });

  /* ====== /status ====== */
  bot.onText(/^\/status$/, async (msg: TelegramBot.Message) => {
    const uptime = process.uptime();
    const hours = Math.floor(uptime/3600), mins = Math.floor((uptime%3600)/60);
    const st = getState();
    const posts = postsToday();
    const intervalMin = Number(process.env.POST_INTERVAL_MIN || 120);
    const intervalMax = Number(process.env.POST_INTERVAL_MAX || 240);
    const text = [
      "📡 *Status*",
      `• Uptime: ${hours}h ${mins}m`,
      `• Paused: ${st.paused ? "yes" : "no"} | Dry-run: ${(process.env.DRY_RUN ?? "false")}`,
      `• Posts today: ${posts}`,
      `• Interval window: ${intervalMin}-${intervalMax} min`
    ].join("\n");
    return bot.sendMessage(msg.chat.id, text, { parse_mode: "Markdown" });
  });

  /* ====== /stats [days] ====== */
  bot.onText(/^\/stats(?:\s+(\d+))?$/, async (msg: TelegramBot.Message, m: RegExpExecArray | null) => {
    const days = Math.min(90, Math.max(1, parseInt(m?.[1] || "7", 10)));
    const since = Date.now() - days*24*3600*1000;
    const st = getState();
    const ids = st.posts.filter(p => p.ts >= since).map(p => p.id);
    if (!ids.length) return bot.sendMessage(msg.chat.id, `No posts in the last ${days} days.`);

    try {
      const twitter = new TwitterApi({
        appKey: process.env.TWITTER_API_KEY!,
        appSecret: process.env.TWITTER_API_SECRET!,
        accessToken: process.env.TWITTER_ACCESS_TOKEN!,
        accessSecret: process.env.TWITTER_ACCESS_SECRET!,
      });
      const res: any = await twitter.v2.tweets(ids, { "tweet.fields": ["public_metrics","created_at"] });
      const rows = (res?.data ?? []) as any[];
      const totals = rows.reduce((a, r) => {
        const m = r.public_metrics || {};
        a.likes += m.like_count || 0;
        a.retweets += m.retweet_count || 0;
        a.replies += m.reply_count || 0;
        a.quotes += m.quote_count || 0;
        return a;
      }, { likes:0, retweets:0, replies:0, quotes:0 });
      const text = [
        `📊 *Stats (${days}d)*`,
        `Total posts: ${rows.length}`,
        `♥️ ${totals.likes}  🔁 ${totals.retweets}  💬 ${totals.replies}  🗣️ ${totals.quotes}`
      ].join("\n");
      return bot.sendMessage(msg.chat.id, text, { parse_mode: "Markdown" });
    } catch (e:any) {
      return bot.sendMessage(msg.chat.id, `Error fetching stats: ${e?.message || e}`);
    }
  });

  console.log("🤖 Telegram bot started");
}
