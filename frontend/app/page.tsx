// frontend/app/page.tsx
import { StoryForm } from "@/components/StoryForm";

export default function HomePage() {
  return (
    <main className="mx-auto min-h-screen max-w-xl px-6 py-16">
      <div className="mb-10 text-center">
        <h1 className="text-3xl font-bold text-stone-900">絵本をつくろう</h1>
        <p className="mt-2 text-stone-500">
          テーマとキャラクターを教えてください。AIが起承転結のあるお話と挿絵を作ります。
        </p>
      </div>
      <StoryForm />
    </main>
  );
}
