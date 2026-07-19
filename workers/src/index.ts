// src/index.ts
//
// 絵本生成AIプラットフォーム — API Gateway Worker
// Hono + Durable Objects(WebSocket Hibernation API) + KV + R2
//
// 役割:
//   1. 絵本生成ジョブをOCI VM上のFastAPIオーケストレーターへ投入する
//   2. Durable Object(BookSession)で生成進捗をWebSocketにリアルタイム配信する
//   3. OCI側からのWebhook通知を受け取り、状態を更新・ブロードキャストする
//   4. 完成した挿絵をR2から配信する

import { DurableObject } from "cloudflare:workers";
import { Hono } from "hono";
import { cors } from "hono/cors";

export interface Env {
  BOOK_SESSION: DurableObjectNamespace<BookSession>;
  BOOK_CACHE: KVNamespace;
  BOOK_ASSETS: R2Bucket;
  ORCHESTRATOR_URL: string;
  ORCHESTRATOR_TOKEN: string;
  WEBHOOK_SECRET: string;
}

// --- OCIオーケストレーターと共有する型 -------------------------------------

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

interface ProgressWebhookPayload {
  bookId: string;
  status: BookStatus;
  pageNumber?: number;
  totalPages?: number;
  imageUrl?: string;
  message?: string;
  error?: string;
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

      // ハイバネーション対応で受理する。server.accept()(レガシーAPI)は使わない。
      this.ctx.acceptWebSocket(server);

      // 直近のステータスがあれば接続直後に1回送っておく(取りこぼし防止)
      const latest = await this.ctx.storage.get<ProgressWebhookPayload>("latestStatus");
      if (latest) {
        server.send(JSON.stringify(latest));
      }

      return new Response(null, { status: 101, webSocket: client });
    }

    if (url.pathname.endsWith("/progress") && request.method === "POST") {
      const payload = await request.json<ProgressWebhookPayload>();
      await this.ctx.storage.put("latestStatus", payload);
      this.broadcast(payload);
      return Response.json({ ok: true });
    }

    if (url.pathname.endsWith("/status") && request.method === "GET") {
      const latest = await this.ctx.storage.get<ProgressWebhookPayload>("latestStatus");
      return Response.json(latest ?? { status: "unknown" });
    }

    return new Response("Not found", { status: 404 });
  }

  private broadcast(payload: ProgressWebhookPayload): void {
    const message = JSON.stringify(payload);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(message);
      } catch (err) {
        console.error("WebSocket送信に失敗:", err);
      }
    }
  }

  // クライアントからの疎通確認(ping)のみサポート。双方向の指示送信は将来拡張用。
  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (message === "ping") {
      ws.send("pong");
    }
  }

  async webSocketClose(
    ws: WebSocket,
    code: number,
    reason: string,
    wasClean: boolean,
  ): Promise<void> {
    ws.close(code, "Durable Object is closing WebSocket");
  }

  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    console.error("WebSocketエラー:", error);
  }
}

// --- Hono アプリ本体 ---------------------------------------------------------

const app = new Hono<{ Bindings: Env }>();

app.use("*", cors());

// ヘルスチェック(CI/CDのデプロイ後検証、外形監視で使用)
app.get("/health", (c) => {
  return c.json({
    status: "ok",
    service: "genstory-oss-api-gateway",
    timestamp: new Date().toISOString(),
  });
});

/** IPごとに1時間あたりの生成リクエスト数を制限する簡易レート制限 */
async function checkRateLimit(env: Env, ip: string): Promise<boolean> {
  const hourBucket = new Date().toISOString().slice(0, 13); // "2026-07-16T05"
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

// 絵本生成を開始する
app.post("/api/books", async (c) => {
  const ip = c.req.header("CF-Connecting-IP") ?? "unknown";
  if (!(await checkRateLimit(c.env, ip))) {
    return c.json(
      { error: "レート制限を超えました。しばらくしてから再度お試しください。" },
      429,
    );
  }

  const body = await c.req.json();
  if (!validateGenerateRequest(body)) {
    return c.json({ error: "theme と characters(1〜5件)は必須です。" }, 400);
  }

  const bookId = crypto.randomUUID();
  const doId = c.env.BOOK_SESSION.idFromName(bookId);
  const stub = c.env.BOOK_SESSION.get(doId);

  // 初期ステータスを記録
  await stub.fetch("https://do/progress", {
    method: "POST",
    body: JSON.stringify({ bookId, status: "story_generating" } satisfies ProgressWebhookPayload),
  });

  // OCIオーケストレーターへジョブを投入(非同期・レスポンスは待たない)
  const webhookUrl = `${new URL(c.req.url).origin}/api/books/${bookId}/webhook`;
  c.executionCtx.waitUntil(
    fetch(`${c.env.ORCHESTRATOR_URL}/generate`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${c.env.ORCHESTRATOR_TOKEN}`,
      },
      body: JSON.stringify({ bookId, webhookUrl, ...body }),
    }).catch((err) => console.error("オーケストレーター呼び出しに失敗:", err)),
  );

  return c.json({ bookId, wsUrl: `/api/books/${bookId}/ws` }, 202);
});

// OCIオーケストレーターからの進捗Webhook
app.post("/api/books/:id/webhook", async (c) => {
  const secret = c.req.header("X-Webhook-Secret");
  if (secret !== c.env.WEBHOOK_SECRET) {
    return c.json({ error: "unauthorized" }, 401);
  }

  const bookId = c.req.param("id");
  const payload = await c.req.json<ProgressWebhookPayload>();

  const doId = c.env.BOOK_SESSION.idFromName(bookId);
  const stub = c.env.BOOK_SESSION.get(doId);
  await stub.fetch("https://do/progress", {
    method: "POST",
    body: JSON.stringify(payload),
  });

  if (payload.status === "complete") {
    await c.env.BOOK_CACHE.put(`book:${bookId}`, JSON.stringify(payload), {
      expirationTtl: 60 * 60 * 24 * 30, // 30日
    });
  }

  return c.json({ ok: true });
});

// 進捗購読用WebSocketへのアップグレード(Durable Objectへそのまま委譲)
app.get("/api/books/:id/ws", async (c) => {
  const bookId = c.req.param("id");
  const doId = c.env.BOOK_SESSION.idFromName(bookId);
  const stub = c.env.BOOK_SESSION.get(doId);
  return stub.fetch(new Request("https://do/ws", c.req.raw));
});

// 進捗のポーリング用フォールバック(WebSocket非対応クライアント向け)
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
