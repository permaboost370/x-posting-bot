import character from "./character.js";
type Char = typeof character;

export function buildTweetPrompt(c: Char, opts?: { trending?: string[]; topics?: string[]; maxLen?: number }) {
  const name = (c as any).name ?? "Bot";
  const bio = Array.isArray((c as any).bio) ? (c as any).bio.join(" ") : ((c as any).bio ?? "");
  const style = [
    ...((c as any).style?.allStyles ?? []),
    ...((c as any).style?.chatStyle ?? []),
    ...((c as any).style?.postStyle ?? [])
  ].filter(Boolean);
  const examples: string[] = [
    ...(((c as any).postExamples ?? []).map((ex: any) => (typeof ex === "string" ? ex : ex?.[0] ?? ""))),
    ...(((c as any).messageExamples ?? []).flat().map((m: any) => (typeof m === "string" ? m : m?.content ?? "")))
  ].filter(Boolean);

  const system = [
    `${name} — voice:`,
    ...style.map((s: string) => `- ${s}`),
    "",
    "Constraints:",
    "- No hashtags or emojis unless explicitly on-brand.",
    "- 1–3 lines total; each line must stand alone.",
    "- Must fit within MAX_TWEET_LENGTH characters."
  ].join("\n");

  const trending = (opts?.trending ?? []).slice(0,3).join(" ");
  const topical = (opts?.topics ?? []).slice(0,5).join(", ");

  const user = [
    `Bio/context: ${bio}`,
    "",
    "Write ONE X post in this voice. Avoid links.",
    trending ? `If natural, you MAY include 1 relevant trending tag: ${"${trending}"}` : "",
    topical ? `Stay within topics: ${"${topical}"}` : "",
    "Return ONLY the post text—no explanations."
  ].join("\n");

  const fewshot = examples.slice(0, 5).map((e: string) => `EXAMPLE:\n${e}`).join("\n\n");
  return { system, user, fewshot };
}
