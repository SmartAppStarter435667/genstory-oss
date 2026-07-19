"""
brainstorm_ideas.py
------------------------------------------------------------------
絵本の「素材」(テーマ・キャラクター・舞台)をまとめて複数案生成し、
content/story-ideas/ 以下にJSONとして保存するコンテンツ運用スクリプト。

.github/workflows/brainstorm-content.yml から定期実行される想定
(story_chain.pyと同じOllamaインスタンスを再利用するため、OCI VM上の
self-hosted runnerで実行する)。

環境変数:
    OLLAMA_BASE_URL, OLLAMA_MODEL : story_chain.py と共通
    IDEA_COUNT                    : 生成するネタ数(既定5)
    THEME_HINT                    : テーマのヒント(例: "夏休み")。空でも可
------------------------------------------------------------------
"""

from __future__ import annotations

import json
import os
import re
from datetime import datetime, timezone, timedelta
from typing import List, Literal, Optional

from langchain_core.prompts import ChatPromptTemplate
from langchain_ollama import ChatOllama
from pydantic import BaseModel, Field

from story_chain import OLLAMA_BASE_URL, OLLAMA_MODEL, CharacterProfile


# ------------------------------------------------------------------
# 1. データモデル
# ------------------------------------------------------------------

class StoryIdea(BaseModel):
    id: str = Field(..., description="URLやファイル名に使えるスラッグ案(英数とハイフンのみ)")
    title_hint: str = Field(..., description="仮タイトル")
    theme: str = Field(..., description="story_chain.generate_storybook の theme にそのまま渡せる粒度の説明文")
    age_group: Literal["3-5", "6-8", "9-12"]
    characters: List[CharacterProfile]
    setting: str = Field(..., description="舞台設定")
    seasonal_tag: Optional[str] = Field(None, description="季節/行事に関連する場合のタグ(例: 夏休み, クリスマス)")
    pitch: str = Field(..., description="このネタの魅力を一言で")


class IdeaBatch(BaseModel):
    ideas: List[StoryIdea]


# ------------------------------------------------------------------
# 2. プロンプト
# ------------------------------------------------------------------

SYSTEM_PROMPT = """あなたは子供向け絵本のネタ出しを専門とする編集者です。
多様な年齢層・テーマ・舞台のアイデアを、既存作品と被らないよう独創的に考えてください。
各ネタには、友情・思いやり・好奇心・環境・多様性などの教育的価値を1つ以上含めてください。
暴力・恐怖・差別的表現は避けてください。
"""

USER_PROMPT = """{count}個の絵本ネタを提案してください。
{hint_section}
年齢層(3-5, 6-8, 9-12)をバランス良く混ぜ、テーマ・舞台・キャラクターが互いに重複しないようにしてください。
"""

_prompt = ChatPromptTemplate.from_messages(
    [
        ("system", SYSTEM_PROMPT),
        ("human", USER_PROMPT),
    ]
)


def generate_ideas(count: int = 5, theme_hint: Optional[str] = None) -> IdeaBatch:
    llm = ChatOllama(model=OLLAMA_MODEL, base_url=OLLAMA_BASE_URL, temperature=1.0)
    chain = _prompt | llm.with_structured_output(IdeaBatch)

    hint_section = f"次のテーマ/季節を意識してください: {theme_hint}" if theme_hint else ""
    return chain.invoke({"count": count, "hint_section": hint_section})


# ------------------------------------------------------------------
# 3. スラッグの安全な正規化(LLM出力を無条件に信頼しない)
# ------------------------------------------------------------------

def _slugify(text: str, fallback: str) -> str:
    slug = re.sub(r"[^a-zA-Z0-9]+", "-", text or "").strip("-").lower()
    return slug or fallback


def _dedupe_ids(ideas: List[StoryIdea]) -> None:
    seen: set[str] = set()
    for i, idea in enumerate(ideas):
        base = _slugify(idea.id or idea.title_hint, fallback=f"idea-{i+1}")
        slug, n = base, 2
        while slug in seen:
            slug = f"{base}-{n}"
            n += 1
        seen.add(slug)
        idea.id = slug


# ------------------------------------------------------------------
# 4. 実行
# ------------------------------------------------------------------

JST = timezone(timedelta(hours=9))

if __name__ == "__main__":
    count = int(os.environ.get("IDEA_COUNT", "5"))
    theme_hint = os.environ.get("THEME_HINT") or None

    batch = generate_ideas(count=count, theme_hint=theme_hint)
    _dedupe_ids(batch.ideas)

    today = datetime.now(JST).date().isoformat()
    out_dir = os.path.join(os.path.dirname(__file__), "..", "content", "story-ideas")
    os.makedirs(out_dir, exist_ok=True)
    out_path = os.path.abspath(os.path.join(out_dir, f"{today}.json"))

    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(batch.model_dump(), f, ensure_ascii=False, indent=2)

    print(f"{len(batch.ideas)}件のネタを {out_path} に書き出しました。")

    # GitHub Actionsの後続ステップ(Issue作成)へ値を渡す
    if "GITHUB_OUTPUT" in os.environ:
        with open(os.environ["GITHUB_OUTPUT"], "a", encoding="utf-8") as f:
            f.write(f"output_path={out_path}\n")
            f.write(f"idea_count={len(batch.ideas)}\n")
