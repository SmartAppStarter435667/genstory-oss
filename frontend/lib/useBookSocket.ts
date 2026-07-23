// frontend/lib/useBookSocket.ts
//
// 絵本生成の進捗をCloudflare Workers(Durable Object)からWebSocketで購読するフック。
// 接続が切れた場合は指数バックオフで再接続する。

"use client";

import { useEffect, useRef, useState } from "react";

export type BookStatus =
  | "idle"
  | "story_generating"
  | "illustrating"
  | "page_complete"
  | "complete"
  | "failed";

export interface BookProgress {
  status: BookStatus;
  pageNumber?: number;
  totalPages?: number;
  imageUrl?: string;
  message?: string;
  error?: string;
}

export interface StoryPageData {
  page_number: number;
  stage: "起" | "承" | "転" | "結";
  text: string;
  illustration_prompt: string;
}

export interface BookData {
  title: string;
  pages: StoryPageData[];
}

interface UseBookSocketResult {
  progress: BookProgress;
  /** ページ番号 → 画像URL のマップ。完成したページから順に埋まっていく */
  pages: Record<number, string>;
  /** 完成時にWorker側から送られてくる、タイトル・各ページ本文(ナレーション用) */
  bookData: BookData | null;
}

export function useBookSocket(bookId: string | null, apiBaseUrl: string): UseBookSocketResult {
  const [progress, setProgress] = useState<BookProgress>({ status: "idle" });
  const [pages, setPages] = useState<Record<number, string>>({});
  const [bookData, setBookData] = useState<BookData | null>(null);
  const retryCount = useRef(0);
  const statusRef = useRef<BookStatus>("idle");

  useEffect(() => {
    statusRef.current = progress.status;
  }, [progress.status]);

  useEffect(() => {
    if (!bookId) return;

    let ws: WebSocket | null = null;
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    const connect = () => {
      const wsUrl = `${apiBaseUrl.replace(/^http/, "ws")}/api/books/${bookId}/ws`;
      ws = new WebSocket(wsUrl);

      ws.onopen = () => {
        retryCount.current = 0;
      };

      ws.onmessage = (event: MessageEvent<string>) => {
        const payload: BookProgress = JSON.parse(event.data);
        setProgress(payload);
        if (payload.status === "page_complete" && payload.pageNumber && payload.imageUrl) {
          setPages((prev) => ({ ...prev, [payload.pageNumber!]: payload.imageUrl! }));
        }
        if (payload.status === "complete" && payload.message) {
          try {
            setBookData(JSON.parse(payload.message) as BookData);
          } catch (err) {
            console.error("本文データのパースに失敗しました:", err);
          }
        }
      };

      ws.onclose = () => {
        if (cancelled) return;
        // 完了・失敗している場合は再接続しない
        if (statusRef.current === "complete" || statusRef.current === "failed") return;

        const delay = Math.min(1000 * 2 ** retryCount.current, 15000);
        retryCount.current += 1;
        retryTimer = setTimeout(connect, delay);
      };

      ws.onerror = () => {
        ws?.close();
      };
    };

    connect();

    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
      ws?.close();
    };
  }, [bookId, apiBaseUrl]);

  return { progress, pages, bookData };
}
