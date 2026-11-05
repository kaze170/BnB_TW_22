import { Direction, TICK_MS } from "../shared/constants.ts";
import { ClientAssetManager } from "./assets.ts";
import { WebAudioEngine } from "./audio.ts";
import { WebGpuRenderer } from "./gpu/renderer.ts";
import { PacketSocketClient } from "./net.ts";
import { renderGameStage, sampleLocalPlayerInputs } from "./stages/gameStage.ts";
import { renderNonGameStage } from "./stages/menusAndSocial.ts";
import { ClientAppState } from "./state.ts";
import { UiInputSystem } from "./ui.ts";

async function boot(): Promise<void> {
  const canvas = document.getElementById("bnb-canvas") as HTMLCanvasElement | null;
  const statusEl = document.getElementById("boot-status");
  if (!canvas) return;

  let renderer: WebGpuRenderer;
  try {
    renderer = await WebGpuRenderer.init(canvas);
  } catch (err) {
    if (statusEl) {
      statusEl.style.display = "flex";
      statusEl.textContent = err instanceof Error ? err.message : String(err);
    }
    return;
  }

  const audio = new WebAudioEngine();
  const net = new PacketSocketClient();
  const ui = new UiInputSystem(canvas, renderer, audio);
  const assets = new ClientAssetManager(renderer);
  const state = new ClientAppState(assets, audio, net, ui);

  await assets.initCore((label, pct) => {
    if (statusEl) {
      statusEl.textContent = `${label} (${pct}%)`;
    }
  });

  if (statusEl) {
    statusEl.style.display = "none";
  }

  // Expose state on window for easy debugging / inspection
  (window as unknown as { __BNB_STATE__: ClientAppState }).__BNB_STATE__ = state;

  let lastTime = performance.now();
  let accumulator = 0;

  // Latch one-shot action keys across rAF frames until consumed by a 30ms simulation tick!
  let pendingP1Bomb = false;
  let pendingP1Ctrl = false;
  let pendingP1Alt = false;
  let pendingP2Bomb = false;
  let pendingP2Ctrl = false;
  let pendingP2Alt = false;

  const frame = (now: number) => {
    const dt = Math.min(120, Math.max(0, now - lastTime));
    lastTime = now;
    accumulator += dt;

    const sampled = sampleLocalPlayerInputs(state);
    if (sampled.p1.placeBomb) pendingP1Bomb = true;
    if (sampled.p1.useCtrl) pendingP1Ctrl = true;
    if (sampled.p1.useAlt) pendingP1Alt = true;
    if (sampled.p2.placeBomb) pendingP2Bomb = true;
    if (sampled.p2.useCtrl) pendingP2Ctrl = true;
    if (sampled.p2.useAlt) pendingP2Alt = true;

    while (accumulator >= TICK_MS) {
      accumulator -= TICK_MS;
      state.stepClientFixedTick(
        {
          dir: sampled.p1.dir,
          placeBomb: pendingP1Bomb,
          useCtrl: pendingP1Ctrl,
          useAlt: pendingP1Alt,
        },
        {
          dir: sampled.p2.dir,
          placeBomb: pendingP2Bomb,
          useCtrl: pendingP2Ctrl,
          useAlt: pendingP2Alt,
        },
      );
      pendingP1Bomb = false;
      pendingP1Ctrl = false;
      pendingP1Alt = false;
      pendingP2Bomb = false;
      pendingP2Ctrl = false;
      pendingP2Alt = false;
    }

    const renderAlpha = Math.max(0, Math.min(1, accumulator / TICK_MS));

    renderer.beginFrame();
    if (state.stage === "Game") {
      renderGameStage(state, renderAlpha);
    } else {
      renderNonGameStage(state);
    }
    ui.renderOverlays(state.assets, state.animTick);
    renderer.endFrame();
    ui.endFrameInputReset();

    void Direction.None;
    requestAnimationFrame(frame);
  };

  requestAnimationFrame(frame);
}

void boot();
