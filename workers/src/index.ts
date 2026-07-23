// src/index.ts
//
// 絵本生成AIプラットフォーム — Cloudflare単体構成のAPI Worker
//
// v2: OCI VM(Ollama/LangChain/Milvus/FastAPI)を廃止し、Cloudflare Workers AI
// (テキスト生成・画像生成)+ R2 + KV + Durable Objectsのみで完結させた構成。
// サーバー・Docker・SSH・Terraform・Ansibleが一切不要になり、
// `wrangler deploy` だけでデプロイが完了する。
//
// 役割:
//   1. 絵本生成リクエストを受け、Workers AIで起承転結ストーリーを生成
//   2. ページごとにWorkers AIで挿絵を生成し、R2へ保存
//   3. Durable Object(BookSession)で進捗をWebSocketにリアルタイム配信する
//   4. 完成した挿絵をR2から配信する

import { DurableObject } from "cloudflare:workers";
import { Hono } from "hono";
import { cors } from "hono/cors";

export interface Env {
  AI: Ai;
  BOOK_SESSION: DurableObjectNamespace<BookSession>;
  BOOK_CACHE: KVNamespace;
  BOOK_ASSETS: R2Bucket;
  // 任意: 設定されていればストーリー生成にNVIDIA NIM(build.nvidia.com)を優先使用し、
  // 失敗時/未設定時はWorkers AIへフォールバックする。
  NVIDIA_NIM_API_KEY?: string;
  NVIDIA_NIM_MODEL?: string;
  // 任意: 設定されていればページごとのナレーション音声(MP3)をGoogle Cloud
  // Text-to-Speechで生成しR2へ保存する。未設定ならナレーション音声は生成されず、
  // フロントエンドはブラウザのWeb Speech APIでの読み上げにフォールバックする
  // (その場合、動画エクスポートにはナレーション音声を含められない)。
  GOOGLE_TTS_API_KEY?: string;
  GOOGLE_TTS_VOICE?: string;
}

// --- 型定義 ------------------------------------------------------------------

interface CharacterInput {
  name: string;
  visualDescription?: string;
  personality?: string;
}

interface GenerateBookRequest {
  theme: string;
  ageGroup: "3-5" | "6-8" | "9-12";
  characters: CharacterInput[];
  pageCount?: number;
}

type BookStatus =
  | "story_generating"
  | "illustrating"
  | "page_complete"
  | "complete"
  | "failed";

interface ProgressPayload {
  bookId: string;
  status: BookStatus;
  pageNumber?: number;
  totalPages?: number;
  imageUrl?: string;
  audioUrl?: string;
  message?: string;
  error?: string;
}

interface StoryPage {
  page_number: number;
  stage: "起" | "承" | "転" | "結";
  text: string;
  illustration_prompt: string;
}

interface Storybook {
  title: string;
  pages: StoryPage[];
}

// --- Durable Object: 1冊の生成セッションを管理し、WebSocketへfan-outする ----

export class BookSession extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname.endsWith("/ws")) {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("Expected WebSocket", { status: 426 });
      }
      const webSocketPair = new WebSocketPair();
      const [client, server] = Object.values(webSocketPair);
      this.ctx.acceptWebSocket(server); // server.accept()(レガシーAPI)は使わない

      const latest = await this.ctx.storage.get<ProgressPayload>("latestStatus");
      if (latest) {
        server.send(JSON.stringify(latest));
      }

      return new Response(null, { status: 101, webSocket: client });
    }

    if (url.pathname.endsWith("/progress") && request.method === "POST") {
      const payload = await request.json<ProgressPayload>();
      await this.ctx.storage.put("latestStatus", payload);
      this.broadcast(payload);
      return Response.json({ ok: true });
    }

    if (url.pathname.endsWith("/status") && request.method === "GET") {
      const latest = await this.ctx.storage.get<ProgressPayload>("latestStatus");
      return Response.json(latest ?? { status: "unknown" });
    }

    return new Response("Not found", { status: 404 });
  }

  private broadcast(payload: ProgressPayload): void {
    const message = JSON.stringify(payload);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(message);
      } catch (err) {
        console.error("WebSocket送信に失敗:", err);
      }
    }
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (message === "ping") ws.send("pong");
  }

  async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    ws.close(code, "Durable Object is closing WebSocket");
  }

  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    console.error("WebSocketエラー:", error);
  }
}

// --- ストーリー生成(Workers AI, JSON Mode) ----------------------------------

const STORY_SYSTEM_PROMPT = `あなたは子供向け絵本のベテラン作家です。
「起承転結」の4部構成に厳密に従い、対象年齢に適した語彙と文の長さで物語を書いてください。

- 起(15〜20%): 主人公・舞台・日常を紹介する
- 承(30〜35%): 出来事が展開し、小さな課題や冒険が始まる
- 転(25〜30%): 予想外の出来事や最大の山場が訪れる
- 結(15〜20%): 課題が解決し、温かい余韻で締めくくる

安全上の注意:
- 暴力・恐怖描写・差別的表現は避けること
- 各ページの illustration_prompt は英語で、構図・キャラクターの動作・背景を具体的に書くこと
- illustration_prompt にはキャラクターの visual_description を必ず反映し、ページ間で見た目が変わらないようにすること
- 出力は指定されたJSON schemaに厳密に従うこと`;

const STORY_JSON_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string" },
    pages: {
      type: "array",
      items: {
        type: "object",
        properties: {
          page_number: { type: "number" },
          stage: { type: "string", enum: ["起", "承", "転", "結"] },
          text: { type: "string" },
          illustration_prompt: { type: "string" },
        },
        required: ["page_number", "stage", "text", "illustration_prompt"],
      },
    },
  },
  required: ["title", "pages"],
} as const;

const TEXT_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const IMAGE_MODEL = "@cf/black-forest-labs/flux-1-schnell";

// NVIDIA NIM(build.nvidia.com)のデフォルトモデル。無料ホスト型APIで利用可能な
// テキストモデルのcatalog ID。build.nvidia.com/models で最新のIDを確認し、
// 必要なら wrangler.jsonc の vars.NVIDIA_NIM_MODEL で上書きすること。
const DEFAULT_NIM_MODEL = "meta/llama-3.3-70b-instruct";

/** JSON schemaを満たす想定のJSON文字列を安全にパースする(コードフェンス等の混入に対応) */
function parseStorybookJson(text: string): Storybook {
  const cleaned = text.trim().replace(/^```json\s*/i, "").replace(/```\s*$/, "");
  const parsed = JSON.parse(cleaned);
  if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as Storybook).pages)) {
    throw new Error("パース結果が期待した形式ではありません。");
  }
  return parsed as Storybook;
}

/** NVIDIA NIM(OpenAI互換API)でストーリー生成を試みる。設定/成否はcaller側で判定する。 */
async function tryGenerateStoryWithNim(
  env: Env,
  systemPrompt: string,
  userPrompt: string,
): Promise<Storybook> {
  const model = env.NVIDIA_NIM_MODEL || DEFAULT_NIM_MODEL;
  const res = await fetch("https://integrate.api.nvidia.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.NVIDIA_NIM_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: "system",
          content: `${systemPrompt}\n\n出力は必ずJSONオブジェクトのみとし、前後に説明文やコードフェンスを付けないこと。`,
        },
        { role: "user", content: userPrompt },
      ],
      // NIMのモデルによりjson_schemaの厳密対応が不安定なため、
      // 広く互換性のあるjson_objectモード + プロンプト側でのschema明示に寄せている。
      response_format: { type: "json_object" },
      temperature: 0.8,
    }),
  });

  if (!res.ok) {
    throw new Error(`NVIDIA NIM API error: ${res.status} ${await res.text()}`);
  }

  const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error("NVIDIA NIMのレスポンスにcontentがありません。");
  return parseStorybookJson(content);
}

/** Workers AI(JSON Mode)でストーリー生成する(既定経路・フォールバック先) */
async function generateStoryWithWorkersAi(
  ai: Ai,
  systemPrompt: string,
  userPrompt: string,
): Promise<Storybook> {
  const result = await ai.run(TEXT_MODEL, {
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    response_format: { type: "json_schema", json_schema: STORY_JSON_SCHEMA },
  });

  // Workers AIはJSON schemaへの準拠を保証しないため、パース失敗に備える
  const raw = (result as { response?: unknown }).response;
  const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
  if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as Storybook).pages)) {
    throw new Error("ストーリー生成の出力が期待した形式ではありませんでした。");
  }
  return parsed as Storybook;
}

async function generateStory(
  env: Env,
  req: GenerateBookRequest,
  pageCount: number,
): Promise<Storybook> {
  const characterLines = req.characters
    .map((c) => `- ${c.name}: ${c.visualDescription ?? "(見た目未指定)"}(性格: ${c.personality ?? "未指定"})`)
    .join("\n");

  const userPrompt = `テーマ: ${req.theme}
対象年齢: ${req.ageGroup}
ページ数: ${pageCount}

登場キャラクター:
${characterLines}

上記の設定で、起承転結のある絵本を1冊作成してください。
JSON形式: {"title": string, "pages": [{"page_number": number, "stage": "起"|"承"|"転"|"結", "text": string, "illustration_prompt": string}, ...]}`;

  if (env.NVIDIA_NIM_API_KEY) {
    try {
      return await tryGenerateStoryWithNim(env, STORY_SYSTEM_PROMPT, userPrompt);
    } catch (err) {
      console.error("NVIDIA NIMでの生成に失敗、Workers AIにフォールバックします:", err);
    }
  }

  return generateStoryWithWorkersAi(env.AI, STORY_SYSTEM_PROMPT, userPrompt);
}

// --- ナレーション音声生成(Google Cloud Text-to-Speech, 任意) ----------------
//
// Cloudflare Workers AIのTTS(@cf/deepgram/aura-1)は英語・スペイン語のみで
// 日本語非対応のため使えない。ブラウザのWeb Speech APIは動画エクスポート用の
// ストリームとしてキャプチャできない制約があるため、「ナレーション入り動画を
// エクスポートしたい」場合のみ、実ファイルを返すGoogle Cloud TTSを使う。
// 未設定でもアプリ自体は動作する(Web Speech APIでのライブ読み上げにフォールバック)。

const DEFAULT_GOOGLE_TTS_VOICE = "ja-JP-Wavenet-B";

async function generateNarrationAudio(env: Env, text: string): Promise<Uint8Array | null> {
  if (!env.GOOGLE_TTS_API_KEY) return null;

  const voiceName = env.GOOGLE_TTS_VOICE || DEFAULT_GOOGLE_TTS_VOICE;
  const res = await fetch(
    `https://texttospeech.googleapis.com/v1/text:synthesize?key=${env.GOOGLE_TTS_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        input: { text },
        voice: { languageCode: "ja-JP", name: voiceName },
        audioConfig: { audioEncoding: "MP3", speakingRate: 0.92, pitch: 1.0 },
      }),
    },
  );

  if (!res.ok) {
    // ナレーション生成に失敗しても絵本生成自体は止めない(字幕+効果音のみで動画は成立する)
    console.error("Google Cloud TTS error:", res.status, await res.text());
    return null;
  }

  const data = (await res.json()) as { audioContent?: string };
  if (!data.audioContent) return null;

  const binary = atob(data.audioContent);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// --- 挿絵生成(Workers AI, FLUX) ---------------------------------------------

const ILLUSTRATION_STYLE_SUFFIX =
  ", soft watercolor children's book illustration, pastel palette, gentle lighting, simple shapes, no text, no watermark";
const NEGATIVE_PROMPT =
  "scary, violent, weapon, blood, horror, dark themes, realistic human face, photorealistic, text, watermark, extra limbs, deformed hands, nsfw";

async function generateIllustration(ai: Ai, prompt: string): Promise<Uint8Array> {
  const result = await ai.run(IMAGE_MODEL, {
    prompt: `${prompt}${ILLUSTRATION_STYLE_SUFFIX}`,
    negative_prompt: NEGATIVE_PROMPT,
    steps: 6,
  } as Record<string, unknown>);

  // Workers AIの画像モデルは、レスポンスが { image: "base64..." } の場合と、
  // 直接バイト列/ストリームで返る場合の両方が確認されているため、両対応にする。
  if (result && typeof result === "object" && "image" in (result as Record<string, unknown>)) {
    const base64 = (result as { image: string }).image;
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  const buffer = await new Response(result as BodyInit).arrayBuffer();
  return new Uint8Array(buffer);
}

// --- 生成パイプライン本体(WorkerからwaitUntilでバックグラウンド実行) --------

async function runGenerationPipeline(env: Env, bookId: string, req: GenerateBookRequest): Promise<void> {
  const doId = env.BOOK_SESSION.idFromName(bookId);
  const stub = env.BOOK_SESSION.get(doId);
  const notify = (payload: ProgressPayload) =>
    stub.fetch("https://do/progress", { method: "POST", body: JSON.stringify(payload) });

  try {
    await notify({ bookId, status: "story_generating" });

    const pageCount = req.pageCount ?? 8;
    const book = await generateStory(env, req, pageCount);

    await notify({ bookId, status: "illustrating", totalPages: book.pages.length });

    for (const page of book.pages) {
      const [image, audio] = await Promise.all([
        generateIllustration(env.AI, page.illustration_prompt),
        generateNarrationAudio(env, page.text),
      ]);

      const imageKey = `books/${bookId}/page-${page.page_number}.png`;
      await env.BOOK_ASSETS.put(imageKey, image, {
        httpMetadata: { contentType: "image/png" },
      });

      let audioUrl: string | undefined;
      if (audio) {
        const audioKey = `books/${bookId}/page-${page.page_number}.mp3`;
        await env.BOOK_ASSETS.put(audioKey, audio, {
          httpMetadata: { contentType: "audio/mpeg" },
        });
        audioUrl = `/api/assets/${audioKey}`;
      }

      await notify({
        bookId,
        status: "page_complete",
        pageNumber: page.page_number,
        totalPages: book.pages.length,
        imageUrl: `/api/assets/${imageKey}`,
        audioUrl,
      });
    }

    await notify({ bookId, status: "complete", message: JSON.stringify(book) });
  } catch (err) {
    console.error("生成パイプラインでエラー:", err);
    await notify({ bookId, status: "failed", error: err instanceof Error ? err.message : String(err) });
  }
}

// --- Hono アプリ本体 ---------------------------------------------------------

const app = new Hono<{ Bindings: Env }>();

app.use("*", cors());

app.get("/health", (c) => {
  return c.json({
    status: "ok",
    service: "genstory-oss-api-gateway",
    timestamp: new Date().toISOString(),
  });
});

async function checkRateLimit(env: Env, ip: string): Promise<boolean> {
  const hourBucket = new Date().toISOString().slice(0, 13);
  const key = `ratelimit:${ip}:${hourBucket}`;
  const current = parseInt((await env.BOOK_CACHE.get(key)) ?? "0", 10);
  if (current >= 10) return false;
  await env.BOOK_CACHE.put(key, String(current + 1), { expirationTtl: 3600 });
  return true;
}

function validateGenerateRequest(body: unknown): body is GenerateBookRequest {
  if (typeof body !== "object" || body === null) return false;
  const b = body as Record<string, unknown>;
  return (
    typeof b.theme === "string" &&
    b.theme.length > 0 &&
    b.theme.length <= 500 &&
    Array.isArray(b.characters) &&
    b.characters.length > 0 &&
    b.characters.length <= 5
  );
}

// 絵本生成を開始する(同一Worker内でWorkers AIを呼び、バックグラウンドで処理する)
app.post("/api/books", async (c) => {
  const ip = c.req.header("CF-Connecting-IP") ?? "unknown";
  if (!(await checkRateLimit(c.env, ip))) {
    return c.json({ error: "レート制限を超えました。しばらくしてから再度お試しください。" }, 429);
  }

  const body = await c.req.json();
  if (!validateGenerateRequest(body)) {
    return c.json({ error: "theme と characters(1〜5件)は必須です。" }, 400);
  }

  const bookId = crypto.randomUUID();
  const doId = c.env.BOOK_SESSION.idFromName(bookId);
  const stub = c.env.BOOK_SESSION.get(doId);
  await stub.fetch("https://do/progress", {
    method: "POST",
    body: JSON.stringify({ bookId, status: "story_generating" } satisfies ProgressPayload),
  });

  c.executionCtx.waitUntil(runGenerationPipeline(c.env, bookId, body));

  return c.json({ bookId, wsUrl: `/api/books/${bookId}/ws` }, 202);
});

// 進捗購読用WebSocketへのアップグレード
app.get("/api/books/:id/ws", async (c) => {
  const bookId = c.req.param("id");
  const doId = c.env.BOOK_SESSION.idFromName(bookId);
  const stub = c.env.BOOK_SESSION.get(doId);
  return stub.fetch(new Request("https://do/ws", c.req.raw));
});

// 進捗のポーリング用フォールバック
app.get("/api/books/:id/status", async (c) => {
  const bookId = c.req.param("id");
  const doId = c.env.BOOK_SESSION.idFromName(bookId);
  const stub = c.env.BOOK_SESSION.get(doId);
  const res = await stub.fetch("https://do/status");
  return new Response(res.body, res);
});

// 挿絵をR2から配信
app.get("/api/assets/:key{.+}", async (c) => {
  const key = c.req.param("key");
  const object = await c.env.BOOK_ASSETS.get(key);
  if (!object) return c.notFound();

  return new Response(object.body, {
    headers: {
      "Content-Type": object.httpMetadata?.contentType ?? "image/png",
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
});

app.onError((err, c) => {
  console.error("未処理のエラー:", err);
  return c.json({ error: "internal_server_error" }, 500);
});

export default app;
