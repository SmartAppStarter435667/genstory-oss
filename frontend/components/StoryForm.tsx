// frontend/components/StoryForm.tsx
"use client";

import { useState, type FormEvent } from "react";
import { createBook, type CharacterInput } from "@/lib/apiClient";
import { useRouter } from "next/navigation";

const AGE_GROUPS = [
  { value: "3-5", label: "3〜5歳" },
  { value: "6-8", label: "6〜8歳" },
  { value: "9-12", label: "9〜12歳" },
] as const;

export function StoryForm() {
  const router = useRouter();
  const [theme, setTheme] = useState("");
  const [ageGroup, setAgeGroup] = useState<(typeof AGE_GROUPS)[number]["value"]>("3-5");
  const [characters, setCharacters] = useState<CharacterInput[]>([{ name: "" }]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const updateCharacter = (index: number, patch: Partial<CharacterInput>) => {
    setCharacters((prev) => prev.map((c, i) => (i === index ? { ...c, ...patch } : c)));
  };

  const addCharacter = () => {
    if (characters.length >= 5) return;
    setCharacters((prev) => [...prev, { name: "" }]);
  };

  const removeCharacter = (index: number) => {
    setCharacters((prev) => prev.filter((_, i) => i !== index));
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);

    const validCharacters = characters.filter((c) => c.name.trim().length > 0);
    if (theme.trim().length === 0 || validCharacters.length === 0) {
      setError("テーマと、少なくとも1人のキャラクター名を入力してください。");
      return;
    }

    setIsSubmitting(true);
    try {
      const { bookId } = await createBook({
        theme: theme.trim(),
        ageGroup,
        characters: validCharacters,
      });
      router.push(`/books/${bookId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "絵本の作成を開始できませんでした。");
      setIsSubmitting(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-8">
      <div className="space-y-2">
        <label htmlFor="theme" className="block text-sm font-medium text-stone-700">
          どんなお話にしますか？
        </label>
        <textarea
          id="theme"
          value={theme}
          onChange={(e) => setTheme(e.target.value)}
          placeholder="例: 森で迷子になった子ぎつねが、友達を作って家に帰る話"
          maxLength={500}
          rows={3}
          className="w-full rounded-xl border border-stone-300 px-4 py-3 text-stone-900 placeholder:text-stone-400 focus:border-amber-500 focus:outline-none focus:ring-2 focus:ring-amber-200"
        />
      </div>

      <div className="space-y-2">
        <span className="block text-sm font-medium text-stone-700">対象年齢</span>
        <div className="flex gap-2">
          {AGE_GROUPS.map((group) => (
            <button
              key={group.value}
              type="button"
              onClick={() => setAgeGroup(group.value)}
              className={`rounded-full px-4 py-2 text-sm font-medium transition ${
                ageGroup === group.value
                  ? "bg-amber-500 text-white"
                  : "bg-stone-100 text-stone-600 hover:bg-stone-200"
              }`}
            >
              {group.label}
            </button>
          ))}
        </div>
      </div>

      <div className="space-y-3">
        <span className="block text-sm font-medium text-stone-700">登場キャラクター</span>
        {characters.map((character, index) => (
          <div key={index} className="flex flex-col gap-2 rounded-xl border border-stone-200 p-4 sm:flex-row sm:items-start">
            <div className="grid flex-1 gap-2 sm:grid-cols-2">
              <input
                type="text"
                value={character.name}
                onChange={(e) => updateCharacter(index, { name: e.target.value })}
                placeholder="名前（例: コン）"
                maxLength={30}
                className="rounded-lg border border-stone-300 px-3 py-2 text-sm focus:border-amber-500 focus:outline-none focus:ring-2 focus:ring-amber-200"
              />
              <input
                type="text"
                value={character.visualDescription ?? ""}
                onChange={(e) => updateCharacter(index, { visualDescription: e.target.value })}
                placeholder="見た目（任意・例: オレンジ色の毛並み、青いリュック）"
                maxLength={200}
                className="rounded-lg border border-stone-300 px-3 py-2 text-sm focus:border-amber-500 focus:outline-none focus:ring-2 focus:ring-amber-200 sm:col-span-1"
              />
            </div>
            {characters.length > 1 && (
              <button
                type="button"
                onClick={() => removeCharacter(index)}
                className="self-start text-sm text-stone-400 hover:text-stone-600 sm:pt-2"
              >
                削除
              </button>
            )}
          </div>
        ))}
        {characters.length < 5 && (
          <button
            type="button"
            onClick={addCharacter}
            className="text-sm font-medium text-amber-600 hover:text-amber-700"
          >
            + キャラクターを追加
          </button>
        )}
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}

      <button
        type="submit"
        disabled={isSubmitting}
        className="w-full rounded-xl bg-amber-500 px-6 py-3 text-base font-semibold text-white transition hover:bg-amber-600 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {isSubmitting ? "絵本を作りはじめています..." : "絵本を作る"}
      </button>
    </form>
  );
}
