/** Client bootstrap: engine init, stage flow, render loop. */
import { Assets } from "./engine/assets.ts";
import { createRenderer } from "./engine/renderer.ts";
import { Input } from "./engine/input.ts";
import { NetClient } from "./net/client.ts";
import { StageManager, type GameContext } from "./stages/stage.ts";
import { LoginStage } from "./stages/LoginStage.ts";
import { SelectServerStage } from "./stages/SelectServerStage.ts";
import { LobbyStage } from "./stages/LobbyStage.ts";
import { PrepareStage } from "./stages/PrepareStage.ts";
import { GameStage } from "./stages/GameStage.ts";
import { SCREEN_W, SCREEN_H } from "./engine/types.ts";
import { loadFonts } from "./ui/font.ts";

async function boot() {
  const canvas = document.getElementById("game") as HTMLCanvasElement;
  const statusEl = document.getElementById("status")!;
  const assets = new Assets();
  statusEl.textContent = "載入資產清單…";
  await assets.loadManifest();
  statusEl.textContent = "載入原版字型…";
  await loadFonts();

  const renderer = await createRenderer(canvas);
  statusEl.textContent = `渲染後端：${renderer.kind === "webgpu" ? "WebGPU" : "Canvas2D（fallback）"}`;
  const input = new Input(canvas);
  const net = new NetClient();

  const ctx: GameContext = {
    assets,
    renderer,
    input,
    net,
    changeStage: (name, params) => void stages.change(name, params),
  };
  const stages = new StageManager(ctx);
  stages.register("login", (c) => new LoginStage(c));
  stages.register("selectServer", (c) => new SelectServerStage(c));
  stages.register("lobby", (c) => new LobbyStage(c));
  stages.register("prepare", (c) => new PrepareStage(c));
  stages.register("game", (c) => new GameStage(c));

  // connect to the game server (same origin, proxied by Bun)
  const proto = location.protocol === "https:" ? "wss" : "ws";
  try {
    await net.connect(`${proto}://${location.host}/ws`);
    statusEl.textContent += " · 已連線伺服器";
  } catch {
    statusEl.textContent += " · 伺服器未連線（單機展示）";
  }

  await stages.change("login");

  let last = performance.now();
  function frame(now: number) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    stages.update(dt);
    stages.draw();
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

boot().catch((e) => {
  console.error(e);
  const s = document.getElementById("status");
  if (s) s.textContent = "啟動失敗：" + (e as Error).message;
});

export { SCREEN_W, SCREEN_H };