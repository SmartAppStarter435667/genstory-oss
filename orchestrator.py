"""
orchestrator.py
------------------------------------------------------------------
OCI VM上で稼働するFastAPIオーケストレーター。

Cloudflare Workers(API Gateway)からのジョブを受け取り、
  1. story_chain.py でストーリー生成(Ollama + Milvus Lite RAG)
  2. 各ページの挿絵を生成(既定: Cloudflare Workers AI / 任意: 自前ComfyUI)
  3. 完了ごとにCloudflare WorkerへWebhookで進捗を通知
  4. 生成した画像をR2(S3互換API)へアップロード
する。

依存関係:
    pip install fastapi uvicorn httpx boto3

環境変数:
    ORCHESTRATOR_TOKEN, CF_WEBHOOK_SECRET     : Cloudflare Worker側と共有するシークレット
    WORKERS_AI_ACCOUNT_ID, WORKERS_AI_API_TOKEN: 画像生成の既定経路(Workers AI)
    R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME
    COMFYUI_URL (任意)                          : 自前ComfyUIを使う場合のみ設定
------------------------------------------------------------------
"""

from __future__ import annotations

import asyncio
import base64
import os
from typing import Any

import boto3
import httpx
from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel

from story_chain import CharacterProfile, Storybook, generate_storybook

app = FastAPI(title="genstory-oss orchestrator")

ORCHESTRATOR_TOKEN = os.environ["ORCHESTRATOR_TOKEN"]
CF_WEBHOOK_SECRET = os.environ["CF_WEBHOOK_SECRET"]
WORKERS_AI_ACCOUNT_ID = os.environ.get("WORKERS_AI_ACCOUNT_ID")
WORKERS_AI_API_TOKEN = os.environ.get("WORKERS_AI_API_TOKEN")
COMFYUI_URL = os.environ.get("COMFYUI_URL")  # 未設定ならWorkers AIのみ使用

_r2 = boto3.client(
    "s3",
    endpoint_url=f"https://{os.environ['R2_ACCOUNT_ID']}.r2.cloudflarestorage.com",
    aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"],
    aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"],
    region_name="auto",
)
_R2_BUCKET = os.environ["R2_BUCKET_NAME"]


class GenerateRequest(BaseModel):
    bookId: str
    webhookUrl: str
    theme: str
    ageGroup: str
    characters: list[dict[str, Any]]
    pageCount: int = 8


# --------------------------------------------------------------------------
# Webhook通知
# --------------------------------------------------------------------------

async def notify_progress(webhook_url: str, payload: dict[str, Any]) -> None:
    async with httpx.AsyncClient(timeout=10) as client:
        try:
            await client.post(
                webhook_url, json=payload, headers={"X-Webhook-Secret": CF_WEBHOOK_SECRET}
            )
        except httpx.HTTPError as exc:
            # Webhook配信の失敗でパイプライン全体を止めない(ログのみ)
            print(f"[warn] webhook通知に失敗しました: {exc}")


# --------------------------------------------------------------------------
# 画像生成: 既定はCloudflare Workers AI、COMFYUI_URL設定時はそちらを優先
# --------------------------------------------------------------------------

async def generate_illustration(prompt: str, negative_prompt: str = "") -> bytes:
    if COMFYUI_URL:
        async with httpx.AsyncClient(timeout=180) as client:
            resp = await client.post(
                f"{COMFYUI_URL}/generate",
                json={"prompt": prompt, "negative_prompt": negative_prompt},
            )
            resp.raise_for_status()
            return resp.content

    if not (WORKERS_AI_ACCOUNT_ID and WORKERS_AI_API_TOKEN):
        raise RuntimeError(
            "COMFYUI_URLもWORKERS_AI_*も未設定です。どちらか一方を構成してください。"
        )

    async with httpx.AsyncClient(timeout=60) as client:
        resp = await client.post(
            f"https://api.cloudflare.com/client/v4/accounts/{WORKERS_AI_ACCOUNT_ID}"
            "/ai/run/@cf/black-forest-labs/flux-1-schnell",
            headers={"Authorization": f"Bearer {WORKERS_AI_API_TOKEN}"},
            json={"prompt": prompt, "steps": 6},
        )
        resp.raise_for_status()
        data = resp.json()
        return base64.b64decode(data["result"]["image"])


# --------------------------------------------------------------------------
# R2(S3互換API)への画像アップロード
# --------------------------------------------------------------------------

async def upload_to_r2(book_id: str, page_number: int, image_bytes: bytes) -> str:
    key = f"books/{book_id}/page-{page_number}.png"
    await asyncio.to_thread(
        _r2.put_object,
        Bucket=_R2_BUCKET,
        Key=key,
        Body=image_bytes,
        ContentType="image/png",
    )
    return key  # Cloudflare Worker の GET /api/assets/:key で配信される


# --------------------------------------------------------------------------
# エンドポイント
# --------------------------------------------------------------------------

@app.post("/generate")
async def generate(req: GenerateRequest, authorization: str = Header(None)):
    if authorization != f"Bearer {ORCHESTRATOR_TOKEN}":
        raise HTTPException(status_code=401, detail="unauthorized")

    # 即座に202を返し、生成はバックグラウンドで実行する(Cloudflare Worker側は
    # fire-and-forgetで呼び出し、進捗はWebhook経由で受け取る設計)
    asyncio.create_task(run_pipeline(req))
    return {"accepted": True}


async def run_pipeline(req: GenerateRequest) -> None:
    try:
        await notify_progress(req.webhookUrl, {"bookId": req.bookId, "status": "story_generating"})

        book: Storybook = generate_storybook(
            # 本来は認証済みセッションから導出したuser_idを使う。
            # ここでは簡易化のためbookIdをそのままスコープキーとして利用している。
            user_id=req.bookId,
            theme=req.theme,
            age_group=req.ageGroup,
            characters=[CharacterProfile(**c) for c in req.characters],
            page_count=req.pageCount,
        )

        await notify_progress(
            req.webhookUrl,
            {"bookId": req.bookId, "status": "illustrating", "totalPages": len(book.pages)},
        )

        for page in book.pages:
            image_bytes = await generate_illustration(page.illustration_prompt)
            image_key = await upload_to_r2(req.bookId, page.page_number, image_bytes)

            await notify_progress(
                req.webhookUrl,
                {
                    "bookId": req.bookId,
                    "status": "page_complete",
                    "pageNumber": page.page_number,
                    "totalPages": len(book.pages),
                    "imageUrl": f"/api/assets/{image_key}",
                },
            )

        await notify_progress(
            req.webhookUrl,
            {
                "bookId": req.bookId,
                "status": "complete",
                "message": book.model_dump_json(),
            },
        )

    except Exception as exc:  # noqa: BLE001 — パイプライン全体の失敗を必ずWebhookで通知する
        await notify_progress(
            req.webhookUrl, {"bookId": req.bookId, "status": "failed", "error": str(exc)}
        )


@app.get("/healthz")
async def healthz():
    return {"status": "ok"}
