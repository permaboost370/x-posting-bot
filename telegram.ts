import TelegramBot from "node-telegram-bot-api";
import { generateImageFromPromptOrReference, buildAltTextFromCaption, buildImagePromptFromCaption, trimTweet } from "./bot.js";
import { TwitterApi } from "twitter-api-v2";
import OpenAI from "openai";
import character from "./character.js";
import { buildTweetPrompt } from "./prompt.js";
import { logEvent, getRecentLogs } from "./util/logging.js";

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN!;
const ALLOWED_CHAT = process.env.TELEGRAM_CHAT_ID; // optional: limit to your own chat
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

const twitter = new TwitterApi({
  appKey: process.env.X_API_KEY!,
  appSecret: process.env.X_API_SECRET!,
  accessToken: process.env.X_ACCESS_TOKEN!,
  accessSecret: process.env.X_ACCESS_SECRET!,
});
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });

// Guard: only allow your chat
function guard(msg: TelegramBot.Message): boolean {
  if (!ALLOWED_CHAT) return true;
  return String(msg.chat.id) === ALLOWED_CHAT;
}

// /health → bot status
bot.onText(/^\/health$/, async (msg) => {
  if (!guard(msg)) return;
  bot.sendMessage(msg.chat.id, "✅ Bot is alive and connected.");
});

// /log → last 5 posts
bot.onText(/^\/log$/, async (msg) => {
  if (!guard(msg)) return;
  const logs = getRecentLogs(5);
  const out = logs.map(l => `${l.t} | ${l.caption} | tweetId=${l.tweet_id}`).join("\n");
  bot.sendMessage(msg.chat.id, out || "No recent posts.");
});

// /tweet → force auto-caption + optional image
bot.onText(/^\/tweet$/, async (msg) => {
  if (!guard(msg)) return;
  try {
    const { system, user, fewshot } = buildTweetPrompt(character as any);
    const messages: OpenAI.ChatCompletionMessageParam[] = [
      { role: "system", content: system },
      { role: "user", content: user },
    ];
    if (fewshot) messages.push({ role: "user", content: fewshot });

    const resp = await openai.chat.completions.create({
      model: process.env.OPENAI_MODEL || "gpt-4o-mini",
      temperature: 0.8,
      max_tokens: 200,
      messages,
    });
    let caption = trimTweet(resp.choices?.[0]?.message?.content ?? "", 280);

    const style = process.env.IMAGE_STYLE || "cinematic";
    const visualPrompt = await buildImagePromptFromCaption(caption);
    const finalPrompt = `${visualPrompt}\nStyle: ${style}`;
    const imgPath = await generateImageFromPromptOrReference(finalPrompt);
    const mediaId = await twitter.v1.uploadMedia(imgPath);
    const altText = await buildAltTextFromCaption(caption, finalPrompt);

    await twitter.v1.createMediaMetadata(mediaId, { alt_text: { text: altText } });
    const posted = await twitter.v2.tweet({ text: caption, media: { media_ids: [mediaId] } as any });

    await logEvent("posted_via_telegram", { caption, tweet_id: posted.data?.id });
    bot.sendMessage(msg.chat.id, `✅ Posted tweet: https://twitter.com/i/web/status/${posted.data?.id}`);
  } catch (e: any) {
    bot.sendMessage(msg.chat.id, `❌ Error posting: ${e?.message || e}`);
  }
});

// /custom CAPTION | PROMPT
bot.onText(/^\/custom (.+)$/, async (msg, match) => {
  if (!guard(msg)) return;
  try {
    const parts = (match?.[1] || "").split("|").map(s => s.trim());
    const caption = parts[0];
    const prompt = parts[1] || caption;

    const style = process.env.IMAGE_STYLE || "cinematic";
    const finalPrompt = `${prompt}\nStyle: ${style}`;
    const imgPath = await generateImageFromPromptOrReference(finalPrompt);
    const mediaId = await twitter.v1.uploadMedia(imgPath);
    const altText = await buildAltTextFromCaption(caption, finalPrompt);

    await twitter.v1.createMediaMetadata(mediaId, { alt_text: { text: altText } });
    const posted = await twitter.v2.tweet({ text: caption, media: { media_ids: [mediaId] } as any });

    await logEvent("custom_post", { caption, prompt, tweet_id: posted.data?.id });
    bot.sendMessage(msg.chat.id, `✅ Custom posted: https://twitter.com/i/web/status/${posted.data?.id}`);
  } catch (e: any) {
    bot.sendMessage(msg.chat.id, `❌ Error in custom post: ${e?.message || e}`);
  }
});

export function startTelegram() {
  console.log("🤖 Telegram bot started");
}
