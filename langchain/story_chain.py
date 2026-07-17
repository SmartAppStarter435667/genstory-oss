"""
story_chain.py
------------------------------------------------------------------
LangChainを用いた「起承転結」構造の絵本ストーリー生成 + Milvus Lite による
キャラクター一貫性RAG。

依存関係:
    pip install langchain-core langchain-ollama langchain-milvus pymilvus pydantic

事前準備(OCI VM上、または docker-compose の ollama-pull サービスで実行):
    ollama pull llama3.1:8b-instruct-q4_K_M   # 本文生成用LLM
    ollama pull bge-m3                         # 埋め込み(多言語/日本語対応)

    ※ 日本語の児童書らしい文体を重視する場合は、Ollama Hub経由で入手できる
      日本語継続事前学習モデル(Llama-3.1-Swallow系、ELYZA系など)への
      差し替えも検討してください。
------------------------------------------------------------------
"""

from __future__ import annotations

import os
from enum import Enum
from typing import List, Optional

from langchain_core.prompts import ChatPromptTemplate
from langchain_milvus import Milvus
from langchain_ollama import ChatOllama, OllamaEmbeddings
from pydantic import BaseModel, Field

OLLAMA_BASE_URL = os.environ.get("OLLAMA_BASE_URL", "http://localhost:11434")
OLLAMA_MODEL = os.environ.get("OLLAMA_MODEL", "llama3.1:8b-instruct-q4_K_M")
EMBEDDING_MODEL = os.environ.get("EMBEDDING_MODEL", "bge-m3")
MILVUS_LITE_PATH = os.environ.get("MILVUS_LITE_PATH", "./data/character_store.db")


# ------------------------------------------------------------------
# 1. データモデル
# ------------------------------------------------------------------

class NarrativeStage(str, Enum):
    KI = "起"     # 導入: 主人公・舞台・日常を紹介する
    SHO = "承"    # 展開: 出来事が展開し、小さな課題や冒険が始まる
    TEN = "転"    # 転換: 予想外の出来事や最大の山場が訪れる
    KETSU = "結"  # 結末: 課題が解決し、温かい余韻で締めくくる


class StoryPage(BaseModel):
    page_number: int = Field(..., description="1始まりのページ番号")
    stage: NarrativeStage = Field(..., description="このページが担う起承転結の役割")
    text: str = Field(..., description="このページの本文(対象年齢に応じた語彙・文長)")
    illustration_prompt: str = Field(
        ...,
        description="このページの挿絵生成に使う英語プロンプト。構図・キャラクターの動作・"
        "背景を具体的に書き、既存キャラクターの visual_description を必ず反映すること。",
    )


class Storybook(BaseModel):
    title: str = Field(..., description="絵本のタイトル")
    pages: List[StoryPage]


class CharacterProfile(BaseModel):
    name: str
    visual_description: str = Field(
        ..., description="髪型・服装・色使いなど、絵の再現に必要な視覚的特徴"
    )
    personality: str = Field(..., description="性格・口調などストーリー生成に使う特徴")


# ------------------------------------------------------------------
# 2. Milvus Lite: キャラクター設定のベクトルストア
#    ローカルの .db パスを渡すだけで Milvus Lite が自動起動する
#    (etcd/MinIOは不要。ただし認証機能はないため、呼び出し元でuser_idを
#     必ず検証済みセッションから導出すること。story_chain.py自体は
#     渡されたuser_idをそのまま信頼する)
# ------------------------------------------------------------------

_embeddings = OllamaEmbeddings(model=EMBEDDING_MODEL, base_url=OLLAMA_BASE_URL)

character_store = Milvus(
    embedding_function=_embeddings,
    connection_args={"uri": MILVUS_LITE_PATH},
    collection_name="character_profiles",
    auto_id=True,
)


def save_character_profile(user_id: str, profile: CharacterProfile) -> None:
    """キャラクター設定をMilvus Liteへ保存する(次回作でも一貫した見た目・性格を再利用するため)"""
    document_text = f"{profile.name}: {profile.visual_description} / 性格: {profile.personality}"
    character_store.add_texts(
        texts=[document_text],
        metadatas=[
            {
                "user_id": user_id,
                "name": profile.name,
                "profile_json": profile.model_dump_json(),
            }
        ],
    )


def retrieve_character_context(
    user_id: str, character_name: str, k: int = 1
) -> Optional[CharacterProfile]:
    """既存キャラクターがいれば類似検索で取得し、同じ見た目・性格で再登場させる"""
    results = character_store.similarity_search(
        query=character_name,
        k=k,
        expr=f'user_id == "{user_id}"',
    )
    if not results:
        return None
    profile_json = results[0].metadata.get("profile_json")
    return CharacterProfile.model_validate_json(profile_json) if profile_json else None


def build_character_context(user_id: str, characters: List[CharacterProfile]) -> str:
    """既存キャラは過去設定を再利用し、新規キャラは今回の設定を保存してから返す"""
    lines: List[str] = []
    for c in characters:
        existing = retrieve_character_context(user_id, c.name)
        profile = existing or c
        if existing is None:
            save_character_profile(user_id, profile)
        lines.append(f"- {profile.name}: {profile.visual_description}(性格: {profile.personality})")
    return "\n".join(lines)


# ------------------------------------------------------------------
# 3. 起承転結プロンプトとチェーン定義
# ------------------------------------------------------------------

SYSTEM_PROMPT = """あなたは子供向け絵本のベテラン作家です。
「起承転結」の4部構成に厳密に従い、対象年齢に適した語彙と文の長さで物語を書いてください。

- 起(15〜20%): 主人公・舞台・日常を紹介する
- 承(30〜35%): 出来事が展開し、小さな課題や冒険が始まる
- 転(25〜30%): 予想外の出来事や最大の山場が訪れる
- 結(15〜20%): 課題が解決し、温かい余韻で締めくくる

安全上の注意:
- 暴力・恐怖描写・差別的表現は避けること
- 各ページの illustration_prompt は英語で、構図・キャラクターの動作・背景を具体的に書くこと
- illustration_prompt には既存キャラクターの visual_description を必ず反映し、
  ページ間で見た目が変わらないようにすること

出力は必ず指定されたJSON形式(Storybookスキーマ)に従ってください。
"""

USER_PROMPT = """テーマ: {theme}
対象年齢: {age_group}
ページ数: {page_count}

登場キャラクター:
{character_context}

上記の設定で、起承転結のある絵本を1冊作成してください。
"""

_prompt = ChatPromptTemplate.from_messages(
    [
        ("system", SYSTEM_PROMPT),
        ("human", USER_PROMPT),
    ]
)

_llm = ChatOllama(model=OLLAMA_MODEL, base_url=OLLAMA_BASE_URL, temperature=0.8)

# with_structured_output で Pydantic モデルへ直接パースする。
# 使用するOllamaモデル/バージョンがtool-calling(JSON mode)に対応している必要がある。
# 不安定な場合は PydanticOutputParser + フォーマット指示のプロンプト埋め込みに
# フォールバックすること。
_structured_llm = _llm.with_structured_output(Storybook)

_chain = _prompt | _structured_llm


def generate_storybook(
    user_id: str,
    theme: str,
    age_group: str,
    characters: List[CharacterProfile],
    page_count: int = 8,
) -> Storybook:
    """起承転結構造の絵本を1冊生成する。

    Args:
        user_id: 認証済みセッションから導出したユーザーID(キャラクター一貫性のスコープ)
        theme: 物語のテーマ(例: "森で迷子になった子ぎつねが、友達を作って家に帰る話")
        age_group: 対象年齢帯(例: "4〜6歳")
        characters: 登場キャラクターの初期設定
        page_count: 生成するページ数
    """
    character_context = build_character_context(user_id, characters)
    result = _chain.invoke(
        {
            "theme": theme,
            "age_group": age_group,
            "page_count": page_count,
            "character_context": character_context,
        }
    )
    return result


# ------------------------------------------------------------------
# 4. 実行例
# ------------------------------------------------------------------

if __name__ == "__main__":
    import json

    book = generate_storybook(
        user_id="user_123",
        theme="森で迷子になった子ぎつねが、友達を作って家に帰る話",
        age_group="4〜6歳",
        characters=[
            CharacterProfile(
                name="コン",
                visual_description="オレンジ色の毛並み、白いお腹、青いリュックを背負った子ぎつね",
                personality="好奇心旺盛だが少し臆病",
            )
        ],
        page_count=8,
    )
    print(json.dumps(book.model_dump(), ensure_ascii=False, indent=2))
