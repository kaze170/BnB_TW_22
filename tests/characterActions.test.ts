import { describe, expect, test } from "bun:test";
import { GameSimulation } from "../src/server/simulation.ts";
import { MAP_NAMES } from "../src/server/gameData.ts";
import { ORIGINAL_TICK_MS } from "../src/shared/timing.ts";
import {
  characterActionGroup, characterActionLoops, animationGroup, animationDurationMs,
  CHARACTER_THROW_GROUP, CHARACTER_DIE_GROUP, CHARACTER_FAINT_GROUP,
  CHARACTER_GHOST_APPEAR_GROUP, CHARACTER_GHOST_STOP_GROUP,
} from "../src/shared/animations.ts";

function sim1() {
  return new GameSimulation(MAP_NAMES.indexOf("Village00"), [{ id: "p", slot: 0, character: 0 }], () => 0.5);
}

describe("CGOBomber action groups (ObjectTable)", () => {
  test("throw/die/faint/ghost group indices match the recovered tables", () => {
    // sim dirs down/up/left/right -> Throw 18/17/16/19
    expect(characterActionGroup("throw", 0)).toBe(18);
    expect(characterActionGroup("throw", 1)).toBe(17);
    expect(characterActionGroup("throw", 2)).toBe(16);
    expect(characterActionGroup("throw", 3)).toBe(19);
    expect(characterActionGroup("die", 0)).toBe(CHARACTER_DIE_GROUP);
    expect(characterActionGroup("faint", 0)).toBe(CHARACTER_FAINT_GROUP);
    expect(characterActionGroup("ghostAppear", 0)).toBe(CHARACTER_GHOST_APPEAR_GROUP);
    expect(characterActionGroup("ghost", 2)).toBe(CHARACTER_GHOST_STOP_GROUP[2]);
    expect(CHARACTER_THROW_GROUP).toEqual([18, 17, 16, 19]);
  });

  test("action durations: throw 180ms, faint 2550ms, die 2760ms, ghostAppear 720ms", () => {
    const dur = (action: Parameters<typeof characterActionGroup>[0]) =>
      animationDurationMs(animationGroup("Character/C00_A", characterActionGroup(action, 0)));
    expect(dur("throw")).toBe(180);
    expect(dur("faint")).toBe(2550);
    expect(dur("die")).toBe(2760);
    expect(dur("ghostAppear")).toBe(720);
    expect(characterActionLoops("die")).toBe(false);
    expect(characterActionLoops("ghost")).toBe(true);
    expect(characterActionLoops("walk")).toBe(true);
  });
});

describe("authoritative action playback", () => {
  test("bomb placement enters Throw and returns to idle after 6 ticks", () => {
    const sim = sim1();
    sim.setInput("p", 0, 0, true);
    sim.tick(ORIGINAL_TICK_MS);
    sim.setInput("p", 0, 0, false);
    let b = sim.snapshot().bombers[0]!;
    expect(sim.bombs.length).toBe(1);
    expect(b.action).toBe("throw");
    expect(b.animGroup).toBe(18); // facing down
    expect(b.animAsset).toBe("Character/C00-Throw_A");
    for (let i = 0; i < 6; i++) sim.tick(ORIGINAL_TICK_MS);
    b = sim.snapshot().bombers[0]!;
    expect(b.action).toBe("idle");
  });

  test("lethal fire enters Die directly and hides when the ghost flag is off", () => {
    const sim = new GameSimulation(MAP_NAMES.indexOf("Village00"), [
      { id: "a", slot: 0, character: 0 },
      { id: "b", slot: 1, character: 1 },
    ], () => 0.5);
    const victim = sim.bombers.find((b) => b.id === "b")!;
    sim.bombs.push({ id: 999, x: victim.tx, y: victim.ty, owner: "a", timer: ORIGINAL_TICK_MS, power: 1 });
    sim.tick(ORIGINAL_TICK_MS);
    let snap = sim.snapshot().bombers.find((b) => b.id === "b")!;
    expect(snap.alive).toBe(false);
    expect(snap.action).toBe("die");
    expect(snap.animGroup).toBe(1);
    expect(sim.presentationTicksLeft).toBe(92);
    const frozenFrame = sim.frame, frozenTime = sim.snapshot().timeMs;
    for (let i = 0; i < 91; i++) sim.tick(ORIGINAL_TICK_MS);
    expect(sim.snapshot().bombers.find((b) => b.id === "b")?.action).toBe("die");
    expect(sim.snapshot().presentation).toBe(true);
    sim.tick(ORIGINAL_TICK_MS);
    const state = sim.snapshot();
    snap = state.bombers.find((b) => b.id === "b")!;
    expect(snap.action).toBe("hidden");
    expect(snap.animAsset).toBeUndefined();
    expect(snap.animGroup).toBeUndefined();
    expect(snap.animFrame).toBeUndefined();
    expect(state.presentation).toBe(false);
    expect(state.bombers.find((b) => b.id === "a")?.action).toBe("hurrah");
    expect(sim.frame).toBe(frozenFrame);
    expect(state.timeMs).toBe(frozenTime);
    expect(sim.result().durationMs).toBe(frozenTime);
  });

  test("Die transitions to GhostAppear only with the ghost flag enabled", () => {
    const sim = new GameSimulation(MAP_NAMES.indexOf("Village00"), [
      { id: "a", slot: 0, character: 0 }, { id: "b", slot: 1, character: 1 },
    ], () => 0.5);
    const victim = sim.bombers.find((b) => b.id === "b")!;
    // Explicitly exercise the recovered conditional branch; no gameplay event
    // currently enables this flag or claims the original packet semantics.
    victim.ghostAfterDeath = true;
    sim.bombs.push({ id: 999, x: victim.tx, y: victim.ty, owner: "a", timer: ORIGINAL_TICK_MS, power: 1 });
    sim.tick(ORIGINAL_TICK_MS);
    expect(sim.presentationTicksLeft).toBe(92 + 24);
    for (let i = 0; i < 92; i++) sim.tick(ORIGINAL_TICK_MS);
    expect(sim.snapshot().bombers.find((b) => b.id === "b")?.action).toBe("ghostAppear");
    for (let i = 0; i < 24; i++) sim.tick(ORIGINAL_TICK_MS);
    const snap = sim.snapshot();
    expect(snap.bombers.find((b) => b.id === "b")?.action).toBe("ghost");
    expect(snap.bombers.find((b) => b.id === "b")?.animAsset).toBe("Character/C01-Ghost");
    expect(snap.presentation).toBe(false);
  });

  test("Faint uses the recovered state counter, not the 85-tick sheet duration", () => {
    const sim = sim1();
    const b = sim.bombers[0]!;
    // sub_4470AF sets the counter to 1 on entry, then 79 updates reach 80.
    b.action = "faint"; b.actionTicks = 0; b.dir = 2;
    for (let i = 0; i < 78; i++) sim.tick(ORIGINAL_TICK_MS);
    expect(b.action).toBe("faint");
    expect(b.dir).toBe(2);
    sim.tick(ORIGINAL_TICK_MS);
    expect(b.action).toBe("idle");
    expect(b.dir).toBe(0);
    expect(sim.snapshot().bombers[0]?.animGroup).toBe(15);
    expect(b.alive).toBe(true);
  });
});
