// frontend/lib/soundEffects.ts
//
// Web Audio APIで効果音を手続き的に生成する。音声ファイルを一切使わないため、
// 著作権・ホスティングの心配がなく、動画エクスポート(MediaRecorder)用の
// MediaStreamDestinationにも接続できる。

export class SoundEffects {
  private ctx: AudioContext;
  private destination: MediaStreamAudioDestinationNode | null = null;

  constructor(audioContext?: AudioContext) {
    this.ctx = audioContext ?? new (window.AudioContext || (window as any).webkitAudioContext)();
  }

  /** 動画エクスポート中は、効果音もこの録画用ストリームへ流す */
  connectToDestination(destination: MediaStreamAudioDestinationNode): void {
    this.destination = destination;
  }

  private routeToOutputs(node: AudioNode): void {
    node.connect(this.ctx.destination); // スピーカーへ
    if (this.destination) node.connect(this.destination); // 録画用ストリームへ
  }

  async resume(): Promise<void> {
    if (this.ctx.state === "suspended") {
      await this.ctx.resume();
    }
  }

  /** ページめくり音: 減衰する高域ノイズ */
  playPageTurn(): void {
    const duration = 0.25;
    const bufferSize = Math.floor(this.ctx.sampleRate * duration);
    const buffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      data[i] = (Math.random() * 2 - 1) * (1 - i / bufferSize);
    }

    const noise = this.ctx.createBufferSource();
    noise.buffer = buffer;

    const filter = this.ctx.createBiquadFilter();
    filter.type = "highpass";
    filter.frequency.value = 800;

    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0.25, this.ctx.currentTime);

    noise.connect(filter).connect(gain);
    this.routeToOutputs(gain);
    noise.start();
  }

  /** キラキラ音: 上昇アルペジオ(開始・完成時などの演出用) */
  playSparkle(): void {
    const notes = [880, 1108.73, 1318.51, 1760]; // A5, C#6, E6, A6
    notes.forEach((freq, i) => {
      const osc = this.ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.value = freq;

      const gain = this.ctx.createGain();
      const startTime = this.ctx.currentTime + i * 0.08;
      gain.gain.setValueAtTime(0, startTime);
      gain.gain.linearRampToValueAtTime(0.12, startTime + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, startTime + 0.4);

      osc.connect(gain);
      this.routeToOutputs(gain);
      osc.start(startTime);
      osc.stop(startTime + 0.4);
    });
  }

  /** 柔らかいチャイム音(ページ切り替え等の軽い演出用) */
  playChime(): void {
    const osc = this.ctx.createOscillator();
    osc.type = "triangle";
    osc.frequency.value = 660;

    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0, this.ctx.currentTime);
    gain.gain.linearRampToValueAtTime(0.15, this.ctx.currentTime + 0.05);
    gain.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + 0.6);

    osc.connect(gain);
    this.routeToOutputs(gain);
    osc.start();
    osc.stop(this.ctx.currentTime + 0.6);
  }

  close(): void {
    void this.ctx.close();
  }
}
