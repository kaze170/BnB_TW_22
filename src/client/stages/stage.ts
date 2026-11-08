/** Stage system mirroring the original CStage scene flow. */
import type { Assets } from "../engine/assets.ts";
import type { Renderer } from "../engine/renderer.ts";
import type { Input } from "../engine/input.ts";
import type { NetClient } from "../net/client.ts";

export interface GameContext {
  assets: Assets;
  renderer: Renderer;
  input: Input;
  net: NetClient;
  changeStage(name: string, params?: Record<string, unknown>): void;
}

export abstract class Stage {
  constructor(protected ctx: GameContext) {}
  /** Load assets / initialise controls (async). */
  async enter(_params?: Record<string, unknown>): Promise<void> {}
  exit(): void {}
  /** dtMs: elapsed milliseconds (CA.exe timeGetTime domain). */
  abstract update(dtMs: number): void;
  abstract draw(): void;
}

export class StageManager {
  private current: Stage | null = null;
  private factories = new Map<string, (ctx: GameContext) => Stage>();
  private transitioning = false;

  constructor(private ctx: GameContext) {}

  register(name: string, factory: (ctx: GameContext) => Stage) {
    this.factories.set(name, factory);
  }

  async change(name: string, params?: Record<string, unknown>) {
    if (this.transitioning) return;
    this.transitioning = true;
    const factory = this.factories.get(name);
    if (!factory) {
      console.error(`[stage] unknown stage: ${name}`);
      this.transitioning = false;
      return;
    }
    this.current?.exit();
    const next = factory(this.ctx);
    await next.enter(params);
    this.current = next;
    this.transitioning = false;
    console.log(`[stage] -> ${name}`);
  }

  update(dtMs: number) {
    this.current?.update(dtMs);
  }
  draw() {
    this.current?.draw();
  }
}