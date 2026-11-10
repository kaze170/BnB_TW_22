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

  test("lethal fire drives faint -> die -> ghostAppear -> ghost", () => {
    const sim = new GameSimulation(MAP_NAMES.indexOf("Village00"), [
      { id: "a", slot: 0, character: 0 },
      { id: "b", slot: 1, character: 1 },
    ], () => 0.5);
    const victim = sim.bombers.find((b) => b.id === "b")!;
    // Ignite a flame under the victim via a bomb owned by a.
    sim.bombs.push({ id: 999, x: victim.tx, y: victim.ty, owner: "a", timer: ORIGINAL_TICK_MS, power: 1 });
    sim.tick(ORIGINAL_TICK_MS);
    let snap = sim.snapshot().bombers.find((b) => b.id === "b")!;
    expect(snap.alive).toBe(false);
    expect(snap.action).toBe("faint");
    expect(snap.animGroup).toBe(2);
    // faint lasts 85 ticks
    for (let i = 0; i < 85; i++) sim.tick(ORIGINAL_TICK_MS);
    snap = sim.snapshot().bombers.find((b) => b.id === "b")!;
    expect(snap.action).toBe("die");
    expect(snap.animGroup).toBe(1);
    for (let i = 0; i < 92; i++) sim.tick(ORIGINAL_TICK_MS);
    snap = sim.snapshot().bombers.find((b) => b.id === "b")!;
    expect(snap.action).toBe("ghostAppear");
    for (let i = 0; i < 24; i++) sim.tick(ORIGINAL_TICK_MS);
    snap = sim.snapshot().bombers.find((b) => b.id === "b")!;
    expect(snap.action).toBe("ghost");
    expect(snap.animAsset).toBe("Character/C01-Ghost");
  });

  test("post-match presentation grace freezes the clock but animates to ghost", () => {
    const sim = new GameSimulation(MAP_NAMES.indexOf("Village00"), [
      { id: "a", slot: 0, character: 0 },
      { id: "b", slot: 1, character: 1 },
    ], () => 0.5);
    const victim = sim.bombers.find((b) => b.id === "b")!;
    sim.bombs.push({ id: 999, x: victim.tx, y: victim.ty, owner: "a", timer: ORIGINAL_TICK_MS, power: 1 });
    sim.tick(ORIGINAL_TICK_MS);
    expect(sim.over).toBe(true);
    // faint 85 + die 92 + ghostAppear 24 = 201 action-only ticks.
    expect(sim.presentationTicksLeft).toBe(201);
    const frozenFrame = sim.frame;
    const frozenTime = sim.snapshot().timeMs;
    expect(sim.snapshot().presentation).toBe(true);
    for (let i = 0; i < 201; i++) sim.tick(ORIGINAL_TICK_MS);
    const snap = sim.snapshot();
    expect(sim.presentationTicksLeft).toBe(0);
    expect(snap.presentation).toBe(false);
    expect(snap.bombers.find((b) => b.id === "b")?.action).toBe("ghost");
    expect(snap.bombers.find((b) => b.id === "a")?.action).toBe("hurrah");
    expect(sim.frame).toBe(frozenFrame);
    expect(snap.timeMs).toBe(frozenTime);
    expect(sim.result().durationMs).toBe(frozenTime);
  });
});
