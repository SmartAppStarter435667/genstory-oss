// frontend/components/MovieMode.tsx
//
// 静止画の挿絵を、パン/ズーム(Ken Burns風)・ナレーション・効果音(Web Audio API、
// 音声ファイル不要)・字幕で「動画のように」再生する。ブラウザ内で完結し、
// 追加のサーバー・GPUは一切不要。
//
// ナレーションには2つの経路がある:
//   1. pageAudioUrls(Google Cloud TTSで生成された実音声ファイル)が利用可能な場合、
//      それを再生する。実ファイルなのでWeb Audio APIのグラフに載せられ、
//      「動画としてダウンロード」時の録画にも音声を含められる。
//   2. 利用できない場合はブラウザのWeb Speech APIで読み上げる(ライブ再生のみ、
//      ブラウザの制約により動画エクスポートには含められない)。

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { getApiBaseUrl } from "@/lib/apiClient";
import { cancelNarration, isNarrationSupported, speak, waitForVoices } from "@/lib/narration";
import { SoundEffects } from "@/lib/soundEffects";
import type { StoryPageData } from "@/lib/useBookSocket";

interface Props {
  pages: Record<number, string>; // pageNumber -> imageUrl
  storyPages: StoryPageData[]; // ナレーション・字幕用の本文
  pageAudioUrls?: Record<number, string>; // pageNumber -> ナレーション音声URL(任意)
}

const CANVAS_WIDTH = 1280;
const CANVAS_HEIGHT = 720;
const MIN_PAGE_DURATION_MS = 4500; // 音声が無い場合の最低表示時間

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

export function MovieMode({ pages, storyPages, pageAudioUrls = {} }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imagesRef = useRef<Record<number, HTMLImageElement>>({});
  const audioBuffersRef = useRef<Record<number, AudioBuffer>>({});
  const soundRef = useRef<SoundEffects | null>(null);
  const liveAudioCtxRef = useRef<AudioContext | null>(null);
  const stopRequestedRef = useRef(false);
  const activeSourceRef = useRef<AudioBufferSourceNode | null>(null);

  const [isPlaying, setIsPlaying] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [isPreparingAudio, setIsPreparingAudio] = useState(false);
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
  const [exportUnsupported, setExportUnsupported] = useState(false);

  const orderedPages = [...storyPages].sort((a, b) => a.page_number - b.page_number);
  const hasRealNarration = orderedPages.some((p) => pageAudioUrls[p.page_number]);

  // 画像を先読みしておく(captureStream使用時のtainted canvas対策でCORSを明示)
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
    liveAudioCtxRef.current = new (window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
    return () => {
      stopRequestedRef.current = true;
      cancelNarration();
      activeSourceRef.current?.stop();
      soundRef.current?.close();
      void liveAudioCtxRef.current?.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ナレーション音声ファイルを先読み・デコードしておく(あれば)
  useEffect(() => {
    if (!hasRealNarration || !liveAudioCtxRef.current) return;
    setIsPreparingAudio(true);
    const ctx = liveAudioCtxRef.current;

    Promise.all(
      orderedPages.map(async ({ page_number }) => {
        const url = pageAudioUrls[page_number];
        if (!url || audioBuffersRef.current[page_number]) return;
        try {
          const res = await fetch(`${getApiBaseUrl()}${url}`);
          const arrayBuffer = await res.arrayBuffer();
          const decoded = await ctx.decodeAudioData(arrayBuffer);
          audioBuffersRef.current[page_number] = decoded;
        } catch (err) {
          console.error(`ページ${page_number}のナレーション音声の読み込みに失敗:`, err);
        }
      }),
    ).finally(() => setIsPreparingAudio(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasRealNarration]);

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

  /** 実音声ファイルがあればそれを、無ければWeb Speech APIで読み上げ、終了までのPromiseを返す */
  const narratePageAndAnimate = useCallback(
    async (
      page: StoryPageData,
      audioCtx: AudioContext,
      recordingDestination: MediaStreamAudioDestinationNode | null,
    ) => {
      const buffer = audioBuffersRef.current[page.page_number];
      const startTime = performance.now();
      let frameId = 0;
      let targetDuration = buffer ? buffer.duration * 1000 : Math.max(MIN_PAGE_DURATION_MS, page.text.length * 180);

      const tick = () => {
        const elapsed = performance.now() - startTime;
        const progress = Math.min(elapsed / targetDuration, 1);
        drawFrame(page.page_number, progress, page.text);
        if (progress < 1 && !stopRequestedRef.current) {
          frameId = requestAnimationFrame(tick);
        }
      };
      tick();

      if (buffer) {
        await new Promise<void>((resolve) => {
          const source = audioCtx.createBufferSource();
          source.buffer = buffer;
          source.connect(audioCtx.destination);
          if (recordingDestination) source.connect(recordingDestination);
          activeSourceRef.current = source;
          source.onended = () => resolve();
          source.start();
        });
      } else if (!recordingDestination && isNarrationSupported()) {
        // 録画中でなければWeb Speech APIでライブ読み上げ(録画中は字幕+効果音のみで進行)
        await speak(page.text);
      } else {
        await new Promise((resolve) => setTimeout(resolve, targetDuration));
      }

      cancelAnimationFrame(frameId);
      drawFrame(page.page_number, 1, page.text);
    },
    [drawFrame],
  );

  const playAll = useCallback(
    async (audioCtx: AudioContext, recordingDestination: MediaStreamAudioDestinationNode | null) => {
      stopRequestedRef.current = false;
      if (!recordingDestination) await waitForVoices();
      soundRef.current?.playSparkle();
      for (const page of orderedPages) {
        if (stopRequestedRef.current) break;
        soundRef.current?.playPageTurn();
        await narratePageAndAnimate(page, audioCtx, recordingDestination);
      }
      if (!stopRequestedRef.current) soundRef.current?.playSparkle();
    },
    [orderedPages, narratePageAndAnimate],
  );

  const handlePlay = async () => {
    if (isRecording || !liveAudioCtxRef.current) return;
    setIsPlaying(true);
    await soundRef.current?.resume();
    if (liveAudioCtxRef.current.state === "suspended") await liveAudioCtxRef.current.resume();
    await playAll(liveAudioCtxRef.current, null);
    setIsPlaying(false);
  };

  const handleStop = () => {
    stopRequestedRef.current = true;
    cancelNarration();
    activeSourceRef.current?.stop();
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

    const AudioCtx =
      window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const recordingCtx = new AudioCtx();
    const destination = recordingCtx.createMediaStreamDestination();
    const exportSound = new SoundEffects(recordingCtx);
    exportSound.connectToDestination(destination);
    const previousSound = soundRef.current;
    soundRef.current = exportSound;

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
    await playAll(recordingCtx, destination);
    recorder.stop();
    await stopped;

    const blob = new Blob(chunks, { type: mimeType.split(";")[0] });
    setDownloadUrl(URL.createObjectURL(blob));
    setIsRecording(false);
    exportSound.close();
    void recordingCtx.close();
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
            disabled={isRecording || isPreparingAudio}
            className="rounded-full bg-amber-500 px-6 py-3 text-sm font-semibold text-white hover:bg-amber-600 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isPreparingAudio ? "準備中..." : "▶ 動画で見る"}
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
          disabled={isPlaying || isRecording || isPreparingAudio}
          className="rounded-full border border-amber-500 px-6 py-3 text-sm font-semibold text-amber-600 hover:bg-amber-50 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {isRecording ? "動画を作成中..." : "⬇ 動画としてダウンロード"}
        </button>
      </div>

      {!hasRealNarration && !isNarrationSupported() && (
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
          {hasRealNarration
            ? "動画ファイルを保存する(ナレーション音声・字幕・効果音入り)"
            : "動画ファイルを保存する(ナレーション音声は含まれません。字幕・効果音入り)"}
        </a>
      )}
    </div>
  );
}
