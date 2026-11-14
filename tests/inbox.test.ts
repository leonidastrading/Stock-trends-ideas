import { existsSync, readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setQuerierForTests } from "@/lib/db";
import { importTerm, parseImport } from "@/lib/scout/importer";
import { fileText, INBOX_JSON_SCHEMA, inboxConfig, parseInboxReply, pickFiles, pollInbox, sendToImport } from "@/lib/scout/inbox";
import type { CallModel } from "@/lib/scout/llm";
import { playerOf } from "@/lib/scout/scoreboard";
import * as store from "@/lib/scout/store";

const f = (path: string, sha = "a") => ({ name: path.split("/").pop()!, path, sha, size: 100 });

describe("GitHub inbox: pure parts", () => {
  it("config from the environment", () => {
    expect(inboxConfig({} as NodeJS.ProcessEnv)).toBeNull();
    expect(inboxConfig({ GITHUB_INBOX_REPO: "not a repo" } as unknown as NodeJS.ProcessEnv)).toBeNull();
    expect(inboxConfig({ GITHUB_INBOX_REPO: "vadim/scout-inbox", GITHUB_INBOX_TOKEN: "t" } as unknown as NodeJS.ProcessEnv)).toEqual({ repo: "vadim/scout-inbox", path: "inbox", branch: null, token: "t" });
  });

  it("new files only, oldest first; a text twin wins over its PDF", () => {
    const files = [f("inbox/2026-11-14.pdf"), f("inbox/2026-11-14.json"), f("inbox/2026-11-13.pdf"), f("inbox/old.md", "x")];
    const picked = pickFiles(files, new Set(["inbox/old.md@x"]));
    expect(picked.map((p) => [p.use.name, p.also.map((a) => a.name)])).toEqual([["2026-11-13.pdf", []], ["2026-11-14.json", ["2026-11-14.pdf"]]]);
    expect(pickFiles([f("inbox/old.md", "y")], new Set(["inbox/old.md@x"]))).toHaveLength(1); // a new commit is read again
  });

  it("the JSON block is found even after a '[context unclear]' in the prose", () => {
    const text = "Notes [context unclear] about NVDA... Machine-readable: [ {\"observation\":\"GTA VI pre-orders 11M, launch Nov 19\",\"term\":\"GTA VI launch\",\"kind\":\"consumer\",\"tickers\":[\"TTWO\"],\"source\":\"host\"} ]";
    const r = parseImport(text);
    expect(r.items.map((i) => i.term)).toEqual(["GTA VI launch"]);
  });

  it("model reply → import items marked as the bot's, scored as their own player", () => {
    expect(JSON.stringify(INBOX_JSON_SCHEMA)).not.toMatch(/"(minItems|maxItems|minimum|maximum|pattern)":/);
    const items = parseInboxReply(JSON.stringify({ ideas: [
      { observation: "Robinhood crypto volume fell 48% in October (company report, Nov 13)", term: "Robinhood crypto slump", kind: "second_order", tickers: ["COIN"], direction: "short", catalyst_date: "", confirmed: "" },
      { observation: "x", term: "too short", kind: "consumer", tickers: [], direction: "none", catalyst_date: "", confirmed: "" }, // observation under 5 chars: dropped
    ] }));
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ source: "bot", direction: "short", catalyst_date: undefined });
    expect(importTerm(items[0])).toBe("inbox: Robinhood crypto slump");
    expect(playerOf("human", "inbox: Robinhood crypto slump")).toBe("inbox_bot");
  });

  it.skipIf(!existsSync("/root/.claude/uploads/f423ae42-4b58-54f5-9731-1fdfbd3d54ee/480ca7d6-2026-11-13_TheStockMarket_daily.pdf"))("reads text out of a real PDF", async () => {
    const t = await fileText("daily.pdf", new Uint8Array(readFileSync("/root/.claude/uploads/f423ae42-4b58-54f5-9731-1fdfbd3d54ee/480ca7d6-2026-11-13_TheStockMarket_daily.pdf")));
    expect(t.length).toBeGreaterThan(5000);
    expect(t).toMatch(/Daily Research File/);
  });
});

describe("GitHub inbox: a poll (PGlite, fake GitHub and model)", () => {
  let pg: PGlite;
  beforeAll(() => {
    pg = new PGlite();
    setQuerierForTests({ query: async (text, params) => (await pg.query(text, params as unknown[])).rows as Record<string, unknown>[] });
  });
  afterAll(() => setQuerierForTests(null));

  it("reads a new file once, extracts ideas with the model when there is no block, and hands them to the import", async () => {
    const env = { GITHUB_INBOX_REPO: "vadim/scout-inbox", GITHUB_INBOX_TOKEN: "tok", DASHBOARD_URL: "https://scout.example", CRON_SECRET: "s" } as unknown as NodeJS.ProcessEnv;
    const seenAuth: string[] = [];
    const gh = (async (url: string, init?: RequestInit) => {
      seenAuth.push(String((init?.headers as Record<string, string>)?.authorization));
      if (url.endsWith("/contents/inbox")) return new Response(JSON.stringify([{ type: "file", name: "2026-11-14.md", path: "inbox/2026-11-14.md", sha: "s1", size: 200 }, { type: "dir", name: "old", path: "inbox/old", sha: "d", size: 0 }]));
      if (url.includes("/contents/inbox/2026-11-14.md")) return new Response("# Bot notes\nRobinhood's crypto trading volume fell 48% in October; Coinbase reports next week.");
      return new Response("?", { status: 404 });
    }) as unknown as typeof fetch;
    const prompts: string[] = [];
    const callModel: CallModel = async ({ user, purpose }) => {
      prompts.push(`${purpose}: ${user}`);
      return { text: JSON.stringify({ ideas: [{ observation: "Robinhood crypto volume fell 48% in October; Coinbase reports next week", term: "Coinbase retail slump", kind: "second_order", tickers: ["COIN"], direction: "short", catalyst_date: "", confirmed: "" }] }), stopReason: "end_turn", modelServed: "m", usage: { input_tokens: 10, output_tokens: 10 }, costUsd: 0.01 };
    };
    const delivered: Array<{ n: number; label: string }> = [];
    const deps = { data: null, sources: [], callModel, now: new Date("2026-11-14T21:00:00Z"), env };
    const r = await pollInbox(deps, 1, gh, async (items, label) => { delivered.push({ n: items.length, label }); return `${items.length} sent`; });
    expect(r).toMatchObject({ checked: true, files: 1, read: [{ file: "inbox/2026-11-14.md", via: "model", ideas: 1, sent: "1 sent" }] });
    expect(prompts[0]).toMatch(/^inbox: Document: 2026-11-14\.md/);
    expect(delivered).toEqual([{ n: 1, label: "2026-11-14" }]);
    expect(seenAuth.every((a) => a === "Bearer tok")).toBe(true);
    const again = await pollInbox(deps, 1, gh, async () => "should not run");
    expect(again.read).toEqual([]); // read once
    expect((await store.inboxRecent())[0]).toMatchObject({ path: "inbox/2026-11-14.md", result: { via: "model", ideas: 1 } });
  });

  it("hands ideas to the app's own import with the cron secret", async () => {
    let call: { url: string; auth: string; body: { text: string; label: string } } | null = null;
    const fake = (async (url: string, init: RequestInit) => {
      call = { url, auth: (init.headers as Record<string, string>).authorization, body: JSON.parse(String(init.body)) };
      return new Response(JSON.stringify({ ok: true, accepted: 1 }), { status: 202 });
    }) as unknown as typeof fetch;
    const out = await sendToImport({ DASHBOARD_URL: "https://scout.example/", CRON_SECRET: "s" } as unknown as NodeJS.ProcessEnv, fake)([{ observation: "Robinhood crypto volume fell 48%", term: "Coinbase retail slump", kind: "event", tickers: ["COIN"], source: "bot" }], "2026-11-14");
    expect(out).toBe("1 idea(s) sent to research");
    expect(call!.url).toBe("https://scout.example/api/cron/import");
    expect(call!.auth).toBe("Bearer s");
    expect(parseImport(call!.body.text).items[0]).toMatchObject({ source: "bot" });
  });
});

describe("Inbox format and track record", () => {
  it("the documented example file is read exactly, extras included", async () => {
    const { INBOX_EXAMPLE, botPrompt } = await import("@/lib/scout/inbox-spec");
    const { importObservation } = await import("@/lib/scout/importer");
    const r = parseImport(JSON.stringify(INBOX_EXAMPLE, null, 2));
    expect(r.errors).toEqual([]);
    expect(r.items).toHaveLength(1);
    const obs = importObservation({ ...r.items[0], source: "bot" }, "2026-11-16-my-research-bot");
    expect(obs).toMatch(/From the inbox document "2026-11-16-my-research-bot"/);
    expect(obs).toMatch(/company named: Coinbase Global, Inc\..*expected horizon 30 days.*would be proven wrong by: US retail crypto.*sources: https/);
    const p = botPrompt("vadim/scout-inbox", "inbox");
    expect(p).toMatch(/commit it to the GitHub repository https:\/\/github\.com\/vadim\/scout-inbox, folder inbox\//);
    expect(p).toMatch(/inbox\/YYYY-MM-DD-<your-name>\.json/);
    expect(p).toMatch(/"term" \(required\)/);
    expect(botPrompt(null, "inbox")).toMatch(/the GitHub repository and folder Vadim gives you/);
    // A bare array and prose with a block still work; junk does not.
    expect(parseImport(JSON.stringify(INBOX_EXAMPLE.ideas)).items).toHaveLength(1);
    expect(parseImport("{\"ideas\": 3}").items).toEqual([]);
  });

  it("track record joins each file to the research run it started, and lists pasted imports", async () => {
    const { trackRecord } = await import("@/lib/scout/inbox-record");
    const rows = trackRecord(
      [
        { path: "inbox/2026-11-16-bot.json", readAt: "2026-11-16T14:00:00Z", result: { via: "block", ideas: 2, sent: "2 idea(s) sent to research" } },
        { path: "inbox/2026-11-16-bot.pdf", readAt: "2026-11-16T14:00:00Z", result: { via: "twin of 2026-11-16-bot.json" } },
        { path: "inbox/broken.pdf", readAt: "2026-11-15T14:00:00Z", result: { error: "GitHub 404 reading inbox/broken.pdf" } },
      ],
      [
        { id: 2, startedAt: "2026-11-16T14:00:05Z", finishedAt: "2026-11-16T14:03:00Z", status: "ok", detail: { label: "2026-11-16-bot", results: [{ term: "inbox: Coinbase retail slump", outcome: "card: promoted", cardId: 41 }, { term: "inbox: Old news", outcome: "rejected", reason: "no evidence" }] }, error: null },
        { id: 1, startedAt: "2026-11-14T02:00:00Z", finishedAt: "2026-11-14T02:04:00Z", status: "ok", detail: { label: "2026-11-13", results: [{ term: "stream host: GTA VI launch", outcome: "card: late", cardId: 30 }] }, error: null },
      ],
    );
    expect(rows.map((r) => [r.label, r.how, r.ideas, r.outcomes.length])).toEqual([["2026-11-16-bot", "github", 2, 2], ["broken", "github", null, 0], ["2026-11-13", "pasted or posted", 1, 1]]);
    expect(rows[0]).toMatchObject({ read: "JSON ideas read directly", researchStatus: "ok", researchedAt: "2026-11-16T14:03:00Z" });
    expect(rows[1]).toMatchObject({ read: "could not be read", error: "GitHub 404 reading inbox/broken.pdf" });
  });
});

describe("a new inbox repo", () => {
  it("no inbox folder yet is an empty inbox; an unreadable repo says why", async () => {
    const { listInbox } = await import("@/lib/scout/inbox");
    const cfg = { repo: "leonidastrading/scout-inbox", path: "inbox", branch: null, token: "t" };
    const readable = (async (url: string) => (url.endsWith("/contents/inbox") ? new Response("{}", { status: 404 }) : new Response("{}", { status: 200 }))) as unknown as typeof fetch;
    expect(await listInbox(cfg, readable)).toEqual([]);
    const hidden = (async () => new Response("{}", { status: 404 })) as unknown as typeof fetch;
    await expect(listInbox(cfg, hidden)).rejects.toThrow(/cannot read leonidastrading\/scout-inbox with GITHUB_INBOX_TOKEN/);
    await expect(listInbox({ ...cfg, token: null }, hidden)).rejects.toThrow(/private repo: set GITHUB_INBOX_TOKEN/);
  });
});
