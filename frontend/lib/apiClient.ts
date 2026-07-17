// frontend/lib/apiClient.ts
//
// Cloudflare Workers(API Gateway)への薄いfetchラッパー。
// NEXT_PUBLIC_API_BASE_URL は .env.local / Cloudflareの環境変数で設定する。

export interface CharacterInput {
  name: string;
  visualDescription?: string;
  personality?: string;
}

export interface GenerateBookRequest {
  theme: string;
  ageGroup: "3-5" | "6-8" | "9-12";
  characters: CharacterInput[];
  pageCount?: number;
}

export interface GenerateBookResponse {
  bookId: string;
  wsUrl: string;
}

export function getApiBaseUrl(): string {
  const url = process.env.NEXT_PUBLIC_API_BASE_URL;
  if (!url) {
    throw new Error(
      "NEXT_PUBLIC_API_BASE_URL が未設定です。.env.local に API Gateway WorkerのURLを設定してください。",
    );
  }
  return url;
}

export async function createBook(req: GenerateBookRequest): Promise<GenerateBookResponse> {
  const res = await fetch(`${getApiBaseUrl()}/api/books`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(req),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `絵本の生成開始に失敗しました(status: ${res.status})`);
  }

  return res.json();
}
