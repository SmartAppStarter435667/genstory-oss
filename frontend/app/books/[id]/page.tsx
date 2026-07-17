// frontend/app/books/[id]/page.tsx
"use client";

import { use, useState } from "react";
import { GenerationProgress } from "@/components/GenerationProgress";
import { BookViewer } from "@/components/BookViewer";

interface Props {
  params: Promise<{ id: string }>;
}

export default function BookPage({ params }: Props) {
  const { id } = use(params);
  const [completedPages, setCompletedPages] = useState<Record<number, string> | null>(null);

  return (
    <main className="mx-auto min-h-screen max-w-3xl px-6 py-16">
      {completedPages ? (
        <BookViewer pages={completedPages} />
      ) : (
        <GenerationProgress bookId={id} onComplete={setCompletedPages} />
      )}
    </main>
  );
}
