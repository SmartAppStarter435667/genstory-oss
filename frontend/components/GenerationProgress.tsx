// frontend/components/GenerationProgress.tsx
"use client";

import { useBookSocket } from "@/lib/useBookSocket";
import { getApiBaseUrl } from "@/lib/apiClient";

const STATUS_LABEL: Record<string, string> = {
  idle: "準備しています...",
  story_generating: "お話を考えています...",
  illustrating: "絵を描く準備をしています...",
  page_complete: "イラストを描いています...",
  complete: "できあがりました！",
  failed: "うまく作れませんでした",
};

interface Props {
  bookId: string;
  onComplete: (pages: Record<number, string>) => void;
}

export function GenerationProgress({ bookId, onComplete }: Props) {
  const { progress, pages } = useBookSocket(bookId, getApiBaseUrl());

  const completedCount = Object.keys(pages).length;
  const total = progress.totalPages ?? 0;
  const percent = total > 0 ? Math.round((completedCount / total) * 100) : 0;

  if (progress.status === "complete") {
    // 親コンポーネントへ完成ページを引き渡し、ビューア表示に切り替える
    onComplete(pages);
  }

  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-6 py-16 text-center">
      <div className="h-16 w-16 animate-spin rounded-full border-4 border-amber-200 border-t-amber-500" />

      <div className="space-y-2">
        <p className="text-lg font-medium text-stone-800">
          {STATUS_LABEL[progress.status] ?? "生成中..."}
        </p>
        {total > 0 && progress.status !== "failed" && (
          <p className="text-sm text-stone-500">
            {completedCount} / {total} ページ
          </p>
        )}
      </div>

      {total > 0 && (
        <div className="h-2 w-full overflow-hidden rounded-full bg-stone-100">
          <div
            className="h-full rounded-full bg-amber-500 transition-all duration-500"
            style={{ width: `${percent}%` }}
          />
        </div>
      )}

      {progress.status === "failed" && (
        <p className="text-sm text-red-600">{progress.error ?? "しばらくしてからもう一度お試しください。"}</p>
      )}
    </div>
  );
}
