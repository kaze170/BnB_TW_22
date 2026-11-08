/** Timing constants recovered from CA.exe.
 *
 * - ORIGINAL_TICK_MS: CPrepareStage::sub_4D2048 and CGameStage::sub_4F5658
 *   advance their fixed-step loops in 30 ms units (timeGetTime delta / 0x1E,
 *   catch-up capped at 15 updates).
 * - PRACTICE_FUSE_MS: CGameStage practice/explosion scheduling path
 *   sub_4E87D8(..., 2000). Online fuse is server-authoritative; the client
 *   clamps received schedule deltas to >= 1000 ms in sub_4E8597.
 * - EXPLOSION_BASE_MS: sub_442FF7 initializes its timing accumulator at 300.
 *   This is an effect-scheduling base, NOT a flame lifetime; the simulation
 *   now derives CGOFlame lifetimes from ObjectTable animation frame counts
 *   (src/shared/animations.ts, CA.exe sub_45FE8B/45436D).
 */
export const ORIGINAL_TICK_MS = 30;
export const PRACTICE_FUSE_MS = 2000;
export const MIN_FUSE_MS = 1000;
export const EXPLOSION_BASE_MS = 300;

/** Accumulator matching the exe's fixed-step catch-up (max 15 ticks/frame). */
export class FixedStepper {
  private acc = 0;
  constructor(readonly stepMs = ORIGINAL_TICK_MS, readonly maxSteps = 15) {}

  /** Add elapsed milliseconds; returns number of whole ticks to run. */
  add(dtMs: number): number {
    if (!Number.isFinite(dtMs) || dtMs <= 0) return 0;
    this.acc += dtMs;
    let n = Math.floor(this.acc / this.stepMs);
    if (n > this.maxSteps) n = this.maxSteps;
    this.acc -= n * this.stepMs;
    if (this.acc >= this.stepMs) this.acc = this.stepMs - 1; // drop debt after cap
    return n;
  }

  reset() {
    this.acc = 0;
  }
}
