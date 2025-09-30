// src/trending.ts
import { TwitterApi } from "twitter-api-v2";

export async function fetchTrendingHashtags(twitter: TwitterApi, candidates: string[], minutes = 60): Promise<string[]> {
  // Portable fallback: query counts for candidate list and return top few
  const out: { tag: string; count: number }[] = [];
  for (const tag of candidates) {
    try {
      const q = `#${tag} -is:retweet`;
      const res: any = await (twitter as any).v2.tweetCountRecent(q, { granularity: "minute" });
      const c = (res?.data ?? []).slice(-minutes).reduce((a: number, r: any) => a + (r?.tweet_count || 0), 0);
      out.push({ tag, count: c });
    } catch {}
  }
  out.sort((a, b) => b.count - a.count);
  return out.slice(0, 3).map(x => `#${x.tag}`);
}
