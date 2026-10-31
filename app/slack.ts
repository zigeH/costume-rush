// Slack bridge for the human supplier (#13).
// env: SLACK_BOT_TOKEN (xoxb-…), SLACK_CHANNEL_ID (C…)
// Bot scopes: chat:write, channels:history (public channel) or groups:history (private), files:read (photos), users:read (optional, for names)
import { join } from "path";
import { mkdirSync } from "fs";
export const FILES_DIR = join(import.meta.dir, "files");
export type SlackFile = { name: string; url: string; path: string; mime: string };
const TOKEN = process.env.SLACK_BOT_TOKEN, CHANNEL = process.env.SLACK_CHANNEL_ID;
export const slackEnabled = !!(TOKEN && CHANNEL);

async function api(method: string, body?: any, query?: Record<string, string>) {
  const url = (process.env.SLACK_API_BASE ?? "https://slack.com/api/") + method + (query ? "?" + new URLSearchParams(query) : "");
  const res = await fetch(url, {
    method: body ? "POST" : "GET",
    headers: { authorization: "Bearer " + TOKEN, ...(body ? { "content-type": "application/json; charset=utf-8" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j: any = await res.json();
  if (!j.ok) throw new Error("slack " + method + ": " + j.error);
  return j;
}

export async function slackPost(text: string, threadTs?: string): Promise<string> {
  const j = await api("chat.postMessage", { channel: CHANNEL, text, ...(threadTs ? { thread_ts: threadTs } : {}), unfurl_links: false });
  return j.ts;
}

const names: Record<string, string> = {};
async function userName(id: string) {
  if (names[id]) return names[id];
  try { const j = await api("users.info", undefined, { user: id }); names[id] = j.user?.profile?.display_name || j.user?.real_name || id; }
  catch { names[id] = id; }
  return names[id];
}

/** Poll a thread and call onReply for every new human (non-bot) message. Returns a stop() fn. */
/** Download a Slack-hosted file (url_private) with the bot token → app/files/<prefix>-<ts>-<i>.<ext>. Returns null on failure. */
async function downloadFile(f: any, prefix: string, ts: string, i: number): Promise<SlackFile | null> {
  const url = f.url_private_download || f.url_private;
  if (!url) return null;
  try {
    mkdirSync(FILES_DIR, { recursive: true });
    const res = await fetch(url, { headers: { authorization: "Bearer " + TOKEN }, signal: AbortSignal.timeout(10000) });
    const mime = res.headers.get("content-type") ?? f.mimetype ?? "";
    if (!res.ok || /text\/html/.test(mime)) throw new Error("http " + res.status + " " + mime + " (missing files:read scope?)");
    const ext = (f.filetype || (f.name ?? "").split(".").pop() || "jpg").toLowerCase().replace(/[^a-z0-9]/g, "") || "jpg";
    const name = `${prefix}-${ts.replace(".", "_")}-${i}.${ext}`;
    await Bun.write(join(FILES_DIR, name), new Uint8Array(await res.arrayBuffer()));
    return { name, url: "/files/" + name, path: join(FILES_DIR, name), mime: f.mimetype || mime || "image/jpeg" };
  } catch (e: any) { console.log("[slack] file download failed:", e.message); return null; }
}

export function watchThread(threadTs: string, onReply: (text: string, who: string, ts: string, files: SlackFile[]) => void, seen: Set<string> = new Set(), prefix = "s13") {
  let stopped = false;
  (async () => {
    while (!stopped) {
      try {
        const j = await api("conversations.replies", undefined, { channel: CHANNEL!, ts: threadTs, limit: "100" });
        for (const m of j.messages ?? []) {
          if (m.ts === threadTs || seen.has(m.ts) || m.bot_id || (m.subtype && m.subtype !== "file_share") || !m.user) continue;
          seen.add(m.ts);
          const files: SlackFile[] = [];
          for (const [i, f] of (m.files ?? []).entries()) {
            if (f.mimetype && !/^image\//.test(f.mimetype)) continue;
            const d = await downloadFile(f, prefix, m.ts, i);
            if (d) files.push(d);
          }
          onReply(m.text ?? "", await userName(m.user), m.ts, files);
        }
      } catch (e: any) { console.log("[slack]", e.message); }
      await new Promise((r) => setTimeout(r, 2000));
    }
  })();
  return () => { stopped = true; };
}
