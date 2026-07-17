// frontend/components/BookViewer.tsx
"use client";

import { useState } from "react";
import Image from "next/image";
import { getApiBaseUrl } from "@/lib/apiClient";

interface Props {
  pages: Record<number, string>;
}

export function BookViewer({ pages }: Props) {
  const pageNumbers = Object.keys(pages)
    .map(Number)
    .sort((a, b) => a - b);
  const [current, setCurrent] = useState(0);

  if (pageNumbers.length === 0) {
    return <p className="py-16 text-center text-stone-500">表示できるページがありません。</p>;
  }

  const pageNumber = pageNumbers[current];
  const imageUrl = `${getApiBaseUrl()}${pages[pageNumber]}`;

  return (
    <div className="mx-auto flex max-w-2xl flex-col items-center gap-6">
      <div className="relative aspect-[4/3] w-full overflow-hidden rounded-2xl bg-stone-100 shadow-lg">
        <Image
          src={imageUrl}
          alt={`${pageNumber}ページ目の挿絵`}
          fill
          className="object-cover"
          unoptimized
        />
      </div>

      <div className="flex w-full items-center justify-between">
        <button
          type="button"
          onClick={() => setCurrent((i) => Math.max(0, i - 1))}
          disabled={current === 0}
          className="rounded-full px-4 py-2 text-sm font-medium text-stone-600 disabled:opacity-30"
        >
          ← まえのページ
        </button>

        <span className="text-sm text-stone-400">
          {current + 1} / {pageNumbers.length}
        </span>

        <button
          type="button"
          onClick={() => setCurrent((i) => Math.min(pageNumbers.length - 1, i + 1))}
          disabled={current === pageNumbers.length - 1}
          className="rounded-full px-4 py-2 text-sm font-medium text-stone-600 disabled:opacity-30"
        >
          つぎのページ →
        </button>
      </div>
    </div>
  );
}
