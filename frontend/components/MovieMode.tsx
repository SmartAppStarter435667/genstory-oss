// frontend/components/MovieMode.tsx
//
// 静止画の挿絵を、パン/ズーム(Ken Burns風)・ナレーション(Web Speech API)・
// 効果音(Web Audio API、音声ファイル不要)・字幕で「動画のように」再生する。
// ブラウザ内で完結し、追加のサーバー・GPUは一切不要。
//
// 「動画としてダウンロード」は MediaRecorder で canvas+効果音を録画する。
// Web Speech APIの音声はブラウザの制約上ストリームとして録画できないため、
// エクスポートした動画にはナレーション音声は含まれない(字幕+効果音のみ)。

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { getApiBaseUrl } from "@/lib/apiClient";
import { cancelNarration, isNarrationSupported, speak, waitForVoices } from "@/lib/narration";
import { SoundEffects } from "@/lib/soundEffects";
import type { StoryPageData } from "@/lib/useBookSocket";

interface Props {
  pages: Record<number, string>; // pageNumber -> imageUrl
  storyPages: StoryPageData[]; // ナレーション・字幕用の本文
}

const CANVAS_WIDTH = 1280;
const CANVAS_HEIGHT = 720;
const MIN_PAGE_DURATION_MS = 4500; // ナレーション非対応時/短文時の最低表示時間

const RECORDING_MIME_CANDIDATES = [
  "video/webm;codecs=vp9,opus",
  "video/webm;codecs=vp8,opus",
  "video/webm",
];

function pickSupportedMimeType(): string | null {
  if (typeof MediaRecorder === "undefined") return null;
  return RECORDING_MIME_CANDIDATES.find((t) => MediaRecorder.isTypeSupported(t)) ?? null;
}

function wrapText(
  ctx: CanvasRenderingContext2D,
  text: string,
  centerX: number,
  centerY: number,
  maxWidth: number,
  lineHeight: number,
): void {
  const lines: string[] = [];
  let line = "";
  for (const ch of text) {
    const test = line + ch;
    if (ctx.measureText(test).width > maxWidth && line) {
      lines.push(line);
      line = ch;
    } else {
      line = test;
    }
  }
  if (line) lines.push(line);

  const totalHeight = lines.length * lineHeight;
  lines.forEach((l, i) => {
    ctx.fillText(l, centerX, centerY - totalHeight / 2 + i * lineHeight + lineHeight / 2);
  });
}

export function MovieMode({ pages, storyPages }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imagesRef = useRef<Record<number, HTMLImageElement>>({});
  const soundRef = useRef<SoundEffects | null>(null);
  const stopRequestedRef = useRef(false);

  const [isPlaying, setIsPlaying] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
  const [exportUnsupported, setExportUnsupported] = useState(false);

  const orderedPages = [...storyPages].sort((a, b) => a.page_number - b.page_number);

  useEffect(() => {
    orderedPages.forEach(({ page_number }) => {
      if (imagesRef.current[page_number]) return;
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.src = `${getApiBaseUrl()}${pages[page_number]}`;
      imagesRef.current[page_number] = img;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pages]);

  useEffect(() => {
    soundRef.current = new SoundEffects();
    return () => {
      stopRequestedRef.current = true;
      cancelNarration();
      soundRef.current?.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const drawFrame = useCallback((pageNumber: number, progress: number, caption: string) => {
    const canvas = canvasRef.current;
    const img = imagesRef.current[pageNumber];
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx || !img || !img.complete || img.naturalWidth === 0) return;

    const direction = pageNumber % 2 === 0 ? 1 : -1;
    const scale = 1.08 + progress * 0.08;
    const dx = direction * progress * 24;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.save();
    ctx.translate(canvas.width / 2 + dx, canvas.height / 2);
    ctx.scale(scale, scale);

    const imgRatio = img.width / img.height;
    const canvasRatio = canvas.width / canvas.height;
    let drawW: number, drawH: number;
    if (imgRatio > canvasRatio) {
      drawH = canvas.height;
      drawW = drawH * imgRatio;
    } else {
      drawW = canvas.width;
      drawH = drawW / imgRatio;
    }
    ctx.drawImage(img, -drawW / 2, -drawH / 2, drawW, drawH);
    ctx.restore();

    if (caption) {
      const barHeight = 130;
      ctx.fillStyle = "rgba(0, 0, 0, 0.55)";
      ctx.fillRect(0, canvas.height - barHeight, canvas.width, barHeight);
      ctx.fillStyle = "#ffffff";
      ctx.font = "30px sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      wrapText(ctx, caption, canvas.width / 2, canvas.height - barHeight / 2, canvas.width - 100, 38);
    }
  }, []);

  const playPage = useCallback(
    async (page: StoryPageData, withNarration: boolean) => {
      if (stopRequestedRef.current) return;
      soundRef.current?.playPageTurn();

      const startTime = performance.now();
      const targetDuration = Math.max(MIN_PAGE_DURATION_MS, page.text.length * 180);
      let frameId: number;

      const tick = () => {
        const elapsed = performance.now() - startTime;
        const progress = Math.min(elapsed / targetDuration, 1);
        drawFrame(page.page_number, progress, page.text);
        if (progress < 1 && !stopRequestedRef.current) {
          frameId = requestAnimationFrame(tick);
        }
      };
      tick();

      if (withNarration && isNarrationSupported()) {
        await speak(page.text);
      } else {
        await new Promise((resolve) => setTimeout(resolve, targetDuration));
      }
      cancelAnimationFrame(frameId!);
      drawFrame(page.page_number, 1, page.text);
    },
    [drawFrame],
  );

  const playAll = useCallback(
    async (withNarration: boolean) => {
      stopRequestedRef.current = false;
      await waitForVoices();
      soundRef.current?.playSparkle();
      for (const page of orderedPages) {
        if (stopRequestedRef.current) break;
        await playPage(page, withNarration);
      }
      if (!stopRequestedRef.current) soundRef.current?.playSparkle();
    },
    [orderedPages, playPage],
  );

  const handlePlay = async () => {
    if (isRecording) return;
    setIsPlaying(true);
    await soundRef.current?.resume();
    await playAll(true);
    setIsPlaying(false);
  };

  const handleStop = () => {
    stopRequestedRef.current = true;
    cancelNarration();
    setIsPlaying(false);
  };

  const handleExport = async () => {
    if (isPlaying || isRecording) return;
    const canvas = canvasRef.current;
    const mimeType = pickSupportedMimeType();
    if (!canvas || !mimeType) {
      setExportUnsupported(true);
      return;
    }

    setIsRecording(true);
    setDownloadUrl(null);
    stopRequestedRef.current = false;

    const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const audioCtx = new AudioCtx();
    const destination = audioCtx.createMediaStreamDestination();
    const exportSound = new SoundEffects(audioCtx);
    exportSound.connectToDestination(destination);
    const previousSound = soundRef.current;
    soundRef.current = exportSound; // 録画中はこちらの効果音インスタンスを使う

    const canvasStream = (
      canvas as HTMLCanvasElement & { captureStream: (fps?: number) => MediaStream }
    ).captureStream(30);
    const combinedStream = new MediaStream([
      ...canvasStream.getVideoTracks(),
      ...destination.stream.getAudioTracks(),
    ]);

    const chunks: Blob[] = [];
    const recorder = new MediaRecorder(combinedStream, { mimeType });
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data);
    };
    const stopped = new Promise<void>((resolve) => {
      recorder.onstop = () => resolve();
    });

    recorder.start();
    // 録画中はWeb Speech(録音不可)を使わず、字幕+効果音のみで進行する
    await playAll(false);
    recorder.stop();
    await stopped;

    const blob = new Blob(chunks, { type: mimeType.split(";")[0] });
    setDownloadUrl(URL.createObjectURL(blob));
    setIsRecording(false);
    exportSound.close();
    soundRef.current = previousSound;
  };

  if (orderedPages.length === 0) {
    return null;
  }

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col items-center gap-4">
      <canvas
        ref={canvasRef}
        width={CANVAS_WIDTH}
        height={CANVAS_HEIGHT}
        className="w-full rounded-2xl bg-stone-900 shadow-lg"
        style={{ aspectRatio: "16 / 9" }}
      />

      <div className="flex flex-wrap items-center justify-center gap-3">
        {!isPlaying ? (
          <button
            type="button"
            onClick={handlePlay}
            disabled={isRecording}
            className="rounded-full bg-amber-500 px-6 py-3 text-sm font-semibold text-white hover:bg-amber-600 disabled:cursor-not-allowed disabled:opacity-50"
          >
            ▶ 動画で見る
          </button>
        ) : (
          <button
            type="button"
            onClick={handleStop}
            className="rounded-full bg-stone-500 px-6 py-3 text-sm font-semibold text-white hover:bg-stone-600"
          >
            ■ 止める
          </button>
        )}

        <button
          type="button"
          onClick={handleExport}
          disabled={isPlaying || isRecording}
          className="rounded-full border border-amber-500 px-6 py-3 text-sm font-semibold text-amber-600 hover:bg-amber-50 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {isRecording ? "動画を作成中..." : "⬇ 動画としてダウンロード"}
        </button>
      </div>

      {!isNarrationSupported() && (
        <p className="text-center text-xs text-stone-400">
          お使いのブラウザは読み上げに対応していないため、字幕のみで再生します。
        </p>
      )}

      {exportUnsupported && (
        <p className="text-center text-xs text-red-500">
          お使いの端末/ブラウザは動画エクスポートに対応していません。動画再生自体はご利用いただけます。
        </p>
      )}

      {downloadUrl && (
        <a
          href={downloadUrl}
          download="ehon.webm"
          className="text-sm font-medium text-amber-600 underline underline-offset-2"
        >
          動画ファイルを保存する(ナレーション音声は含まれません。字幕・効果音入り)
        </a>
      )}
    </div>
  );
}
