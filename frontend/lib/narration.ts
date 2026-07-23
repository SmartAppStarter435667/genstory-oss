// frontend/lib/narration.ts
//
// ブラウザ標準のWeb Speech API(speechSynthesis)でナレーションを読み上げる。
// APIキー・サーバー不要。対応していない/日本語音声が無い端末では
// 無音でフォールバックし、字幕表示のみで進行を継続する。
//
// 制約: この方法で再生した音声は、技術的な理由(Web Speech APIの出力は
// MediaStreamとして直接キャプチャできない)によりMediaRecorderでの録画に
// 含めることができない。動画エクスポート時は字幕+効果音のみになる。

export function isNarrationSupported(): boolean {
  return typeof window !== "undefined" && "speechSynthesis" in window;
}

function pickJapaneseVoice(): SpeechSynthesisVoice | undefined {
  const voices = window.speechSynthesis.getVoices();
  return (
    voices.find((v) => v.lang.startsWith("ja")) ??
    voices.find((v) => v.lang.toLowerCase().includes("jp"))
  );
}

/** 一部ブラウザ(Chrome等)は音声リストが非同期に読み込まれるため、準備を待つ */
export function waitForVoices(): Promise<void> {
  return new Promise((resolve) => {
    if (!isNarrationSupported()) {
      resolve();
      return;
    }
    if (window.speechSynthesis.getVoices().length > 0) {
      resolve();
      return;
    }
    const handler = () => {
      window.speechSynthesis.removeEventListener("voiceschanged", handler);
      resolve();
    };
    window.speechSynthesis.addEventListener("voiceschanged", handler);
    // 一部端末はイベントが発火しないことがあるため保険のタイムアウトを入れる
    setTimeout(resolve, 1000);
  });
}

/** テキストを読み上げ、完了(または未対応/エラー)でresolveする */
export function speak(text: string, opts?: { rate?: number }): Promise<void> {
  return new Promise((resolve) => {
    if (!isNarrationSupported() || !text) {
      resolve();
      return;
    }
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = "ja-JP";
    utterance.rate = opts?.rate ?? 0.95;
    utterance.pitch = 1.05;

    const voice = pickJapaneseVoice();
    if (voice) utterance.voice = voice;

    utterance.onend = () => resolve();
    utterance.onerror = () => resolve(); // 読み上げに失敗しても再生自体は止めない

    window.speechSynthesis.speak(utterance);
  });
}

export function cancelNarration(): void {
  if (isNarrationSupported()) {
    window.speechSynthesis.cancel();
  }
}
