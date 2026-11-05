import { SFX_WAVE_PATHS } from "../shared/constants.ts";

export class WebAudioEngine {
  private ctx: AudioContext | null = null;
  private bgmGain: GainNode | null = null;
  private sfxGain: GainNode | null = null;

  private currentBgmPath = "";
  private currentBgmSource: AudioBufferSourceNode | null = null;
  private readonly bufferCache = new Map<string, AudioBuffer>();
  private readonly pendingLoads = new Map<string, Promise<AudioBuffer | null>>();

  public muted = false;
  public bgmVolume = 0.45;
  public sfxVolume = 0.7;

  public unlock(): void {
    if (!this.ctx) {
      const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new AudioCtx();
      this.bgmGain = this.ctx.createGain();
      this.sfxGain = this.ctx.createGain();
      this.bgmGain.gain.value = this.muted ? 0 : this.bgmVolume;
      this.sfxGain.gain.value = this.muted ? 0 : this.sfxVolume;
      this.bgmGain.connect(this.ctx.destination);
      this.sfxGain.connect(this.ctx.destination);
    }
    if (this.ctx.state === "suspended") {
      void this.ctx.resume();
    }
    // Re-trigger pending BGM if unlocked after stage load
    if (this.currentBgmPath && !this.currentBgmSource) {
      const p = this.currentBgmPath;
      this.currentBgmPath = "";
      void this.playBgm(p);
    }
  }

  public toggleMute(): boolean {
    this.muted = !this.muted;
    if (this.bgmGain) this.bgmGain.gain.value = this.muted ? 0 : this.bgmVolume;
    if (this.sfxGain) this.sfxGain.gain.value = this.muted ? 0 : this.sfxVolume;
    return this.muted;
  }

  private async fetchAudioBuffer(fxPath: string): Promise<AudioBuffer | null> {
    if (!this.ctx) return null;
    const cached = this.bufferCache.get(fxPath);
    if (cached) return cached;

    const inflight = this.pendingLoads.get(fxPath);
    if (inflight) return inflight;

    const task = (async () => {
      try {
        const res = await fetch(`/api/pack/Fx/entry?path=${encodeURIComponent(fxPath)}`);
        if (!res.ok || !this.ctx) return null;
        const ab = await res.arrayBuffer();
        const decoded = await this.ctx.decodeAudioData(ab.slice(0));
        this.bufferCache.set(fxPath, decoded);
        return decoded;
      } catch {
        return null;
      } finally {
        this.pendingLoads.delete(fxPath);
      }
    })();

    this.pendingLoads.set(fxPath, task);
    return task;
  }

  public async playBgm(fxPath: string): Promise<void> {
    if (this.currentBgmPath === fxPath && this.currentBgmSource) return;
    this.currentBgmPath = fxPath;

    if (this.currentBgmSource) {
      try {
        this.currentBgmSource.stop();
        this.currentBgmSource.disconnect();
      } catch {
        // ignore
      }
      this.currentBgmSource = null;
    }

    if (!this.ctx || !this.bgmGain) return;
    const buf = await this.fetchAudioBuffer(fxPath);
    if (!buf || this.currentBgmPath !== fxPath || !this.ctx || !this.bgmGain) return;

    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    src.connect(this.bgmGain);
    src.start(0);
    this.currentBgmSource = src;
  }

  public playSfxById(sfxId: number): void {
    const wavePath = SFX_WAVE_PATHS[sfxId];
    if (wavePath) {
      this.playSfx(wavePath);
    }
  }

  public playSfx(fxPath: string): void {
    if (this.muted) return;
    this.unlock();
    if (!this.ctx || !this.sfxGain) return;

    void this.fetchAudioBuffer(fxPath).then((buf) => {
      if (!buf || !this.ctx || !this.sfxGain || this.muted) return;
      const src = this.ctx.createBufferSource();
      src.buffer = buf;
      src.connect(this.sfxGain);
      src.start(0);
    });
  }

  public selectMapBgm(mapName: string): string {
    const m = mapName.toLowerCase();
    if (m.includes("patrit") || m.includes("pirate")) return "MP3/Patrit";
    if (m.includes("village")) return "MP3/Village";
    if (m.includes("camp")) return "MP3/Camp";
    if (m.includes("fact")) return "MP3/Factory";
    if (m.includes("forest")) return "MP3/Forest";
    if (m.includes("ice") || m.includes("snow")) return "MP3/Ice";
    if (m.includes("desert")) return "MP3/Desert";
    if (m.includes("cemet")) return "MP3/Cemetery";
    if (m.includes("tomb")) return "MP3/Tomb";
    if (m.includes("mine")) return "MP3/Mine";
    if (m.includes("cookie")) return "MP3/Cookie";
    if (m.includes("ocean")) return "MP3/Ocean";
    if (m.includes("xmas")) return "MP3/Xmas";
    if (m.includes("kart")) return "MP3/Kart";
    if (m.includes("mon")) return "MP3/Monster";
    return "MP3/Village";
  }
}
