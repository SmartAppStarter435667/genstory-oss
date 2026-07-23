// frontend/app/books/[id]/page.tsx
"use client";

import { use, useState } from "react";
import { GenerationProgress } from "@/components/GenerationProgress";
import { BookViewer } from "@/components/BookViewer";
import { MovieMode } from "@/components/MovieMode";
import type { BookData } from "@/lib/useBookSocket";

interface Props {
  params: Promise<{ id: string }>;
}

type ViewMode = "pages" | "movie";

export default function BookPage({ params }: Props) {
  const { id } = use(params);
  const [completedPages, setCompletedPages] = useState<Record<number, string> | null>(null);
  const [bookData, setBookData] = useState<BookData | null>(null);
  const [pageAudioUrls, setPageAudioUrls] = useState<Record<number, string>>({});
  const [viewMode, setViewMode] = useState<ViewMode>("movie");

  const handleComplete = (
    pages: Record<number, string>,
    data: BookData | null,
    audioUrls: Record<number, string>,
  ) => {
    setCompletedPages(pages);
    setBookData(data);
    setPageAudioUrls(audioUrls);
  };

  return (
    <main className="mx-auto min-h-screen max-w-3xl px-4 py-10 sm:px-6 sm:py-16">
      {completedPages ? (
        <div className="flex flex-col items-center gap-6">
          {bookData?.title && (
            <h1 className="text-center text-2xl font-bold text-stone-900 sm:text-3xl">{bookData.title}</h1>
          )}

          <div className="flex gap-2 rounded-full bg-stone-100 p-1">
            <button
              type="button"
              onClick={() => setViewMode("movie")}
              className={`rounded-full px-4 py-2 text-sm font-medium transition ${
                viewMode === "movie" ? "bg-white text-stone-900 shadow" : "text-stone-500"
              }`}
            >
              🎬 動画で見る
            </button>
            <button
              type="button"
              onClick={() => setViewMode("pages")}
              className={`rounded-full px-4 py-2 text-sm font-medium transition ${
                viewMode === "pages" ? "bg-white text-stone-900 shadow" : "text-stone-500"
              }`}
            >
              📖 ページをめくる
            </button>
          </div>

          {viewMode === "movie" && bookData ? (
            <MovieMode pages={completedPages} storyPages={bookData.pages} pageAudioUrls={pageAudioUrls} />
          ) : (
            <BookViewer pages={completedPages} />
          )}
        </div>
      ) : (
        <GenerationProgress bookId={id} onComplete={handleComplete} />
      )}
    </main>
  );
}
