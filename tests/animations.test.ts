import { describe, expect, test } from "bun:test";
import {
  OBJECT_ANIMATIONS, FLAME_OBJECT, BOMB_OBJECT,
  animationGroup, animationImageAtTicks, flameCenterGroup, flameArmGroup, flameLifetimeMs,
} from "../src/shared/animations.ts";
import { GameSimulation } from "../src/server/simulation.ts";
import { MAP_NAMES } from "../src/server/gameData.ts";
import { ORIGINAL_TICK_MS } from "../src/shared/timing.ts";

describe("ObjectTable animation tables (sub_4625B7)", () => {
  test("Flame/Flame has 76 one-tick groups; center lifetime scales with power", () => {
    const flame = OBJECT_ANIMATIONS[FLAME_OBJECT]!;
    expect(flame.length).toBe(76);
    expect(flame.every((g) => g.frames.every(([, d]) => d === 1))).toBe(true);
    expect(flame[0]!.frames.length).toBe(9);   // FireC01, power 1 -> 270ms
    expect(flame[6]!.frames.length).toBe(15);  // FireC07, power 7 -> 450ms
    expect(flame[14]!.frames.length).toBe(18); // FireC10 cap
    expect(flame[15]!.frames.length).toBe(19); // FireL01 -> 570ms
    expect(flame[30]!.asset).toBe("Bomb/Fire00");
    expect(flame[75]!.asset).toBe("Bomb/TimebombFrame");
    expect(flame[75]!.frames.length).toBe(20);
    expect(flameLifetimeMs(FLAME_OBJECT, 0)).toBe(270);
    expect(flameLifetimeMs(FLAME_OBJECT, 15)).toBe(570);
  });

  test("normal bomb group selection matches sub_4E61E3 / sub_4E3CBE", () => {
    expect(flameCenterGroup(1)).toBe(0);
    expect(flameCenterGroup(7)).toBe(6);
    // sim dirs: 0 down, 1 up, 2 left, 3 right -> Flame blocks L/U/R/D
    expect(flameArmGroup(1, 2, 1)).toBe(15); // FireL01
    expect(flameArmGroup(1, 1, 1)).toBe(30); // FireU01
    expect(flameArmGroup(1, 3, 1)).toBe(45); // FireR01
    expect(flameArmGroup(1, 0, 1)).toBe(60); // FireD01
    expect(flameArmGroup(7, 2, 1)).toBe(21); // FireL07 (remaining range 7)
    expect(flameArmGroup(7, 2, 7)).toBe(15); // tip uses FireL01
  });

  test("generic playback advances by duration ticks and loops (sub_45F608)", () => {
    const bomb = animationGroup(BOMB_OBJECT, 0)!;
    expect(bomb.frames).toEqual([[0, 6], [1, 6], [2, 6], [3, 6]]);
    expect(animationImageAtTicks(bomb, 0)).toBe(0);
    expect(animationImageAtTicks(bomb, 5)).toBe(0);
    expect(animationImageAtTicks(bomb, 6)).toBe(1);
    expect(animationImageAtTicks(bomb, 12)).toBe(2);
    expect(animationImageAtTicks(bomb, 18)).toBe(3);
    expect(animationImageAtTicks(bomb, 24)).toBe(0);
    const walk = animationGroup("Character/C00_A", 20)!; // WalkLeft
    expect(walk.frames).toEqual([[0, 3], [1, 3], [2, 3], [0, 3], [3, 3], [4, 3]]);
    expect(animationImageAtTicks(walk, 2)).toBe(0);
    expect(animationImageAtTicks(walk, 3)).toBe(1);
    expect(animationImageAtTicks(walk, 9)).toBe(0);
    expect(animationImageAtTicks(walk, 12)).toBe(3);
    expect(animationImageAtTicks(walk, 18)).toBe(0);
  });
});

describe("CGOFlame simulation lifetime", () => {
  function clearArea(sim: GameSimulation, cx: number, cy: number) {
    for (let y = cy - 2; y <= cy + 2; y++) {
      for (let x = cx - 2; x <= cx + 2; x++) {
        const cell = sim.cells[y * sim.width + x];
        if (cell) { cell.kind = 0; cell.object = null; }
      }
    }
  }

  test("power-1 center lives 9 ticks, arms 19 ticks, frame = counter", () => {
    const sim = new GameSimulation(MAP_NAMES.indexOf("Village00"), [{ id: "p", slot: 0, character: 0 }], () => 0.5);
    clearArea(sim, 7, 6);
    const p = sim.bombers[0]!;
    p.tx = 0; p.ty = 0; p.x = 0; p.y = 0; p.gx = 0; p.gy = 0; p.moving = false;
    sim.bombs.push({ id: 999, x: 7, y: 6, owner: "p", timer: ORIGINAL_TICK_MS, power: 1 });
    sim.tick(ORIGINAL_TICK_MS); // detonates; new segments start at counter 0
    let snap = sim.snapshot();
    const center = snap.explosions.find((e) => e.x === 7 && e.y === 6)!;
    expect(center).toBeDefined();
    expect(center.group).toBe(0);
    expect(center.frame).toBe(0);
    expect(center.ttl).toBe(270);
    expect(center.asset).toBe("Bomb/Fire00");
    expect(snap.explosions.length).toBe(5); // center + 4 immediate arms

    for (let i = 0; i < 8; i++) sim.tick(ORIGINAL_TICK_MS);
    snap = sim.snapshot();
    const c8 = snap.explosions.find((e) => e.x === 7 && e.y === 6)!;
    expect(c8.frame).toBe(8);
    expect(c8.ttl).toBe(30);
    sim.tick(ORIGINAL_TICK_MS); // 9th tick removes the center
    snap = sim.snapshot();
    expect(snap.explosions.some((e) => e.x === 7 && e.y === 6)).toBe(false);
    const arm = snap.explosions.find((e) => e.x === 6 && e.y === 6)!;
    expect(arm.frame).toBe(9);
    expect(arm.group).toBe(15);
    expect(arm.ttl).toBe(300); // 19 - 9 = 10 ticks remain
  });

  test("power-2 propagation delays the second ring by one tick", () => {
    const sim = new GameSimulation(MAP_NAMES.indexOf("Village00"), [{ id: "p", slot: 0, character: 0 }], () => 0.5);
    clearArea(sim, 7, 6);
    const p = sim.bombers[0]!;
    p.tx = 0; p.ty = 0; p.x = 0; p.y = 0; p.gx = 0; p.gy = 0; p.moving = false;
    sim.bombs.push({ id: 999, x: 7, y: 6, owner: "p", timer: ORIGINAL_TICK_MS, power: 2 });
    sim.tick(ORIGINAL_TICK_MS);
    let snap = sim.snapshot();
    expect(snap.explosions.some((e) => e.x === 5 && e.y === 6)).toBe(false); // delayed
    expect(snap.explosions.some((e) => e.x === 6 && e.y === 6)).toBe(true);
    sim.tick(ORIGINAL_TICK_MS);
    snap = sim.snapshot();
    const tip = snap.explosions.find((e) => e.x === 5 && e.y === 6)!;
    expect(tip).toBeDefined();
    expect(tip.frame).toBe(0);
    expect(tip.group).toBe(15); // remaining range 1 -> FireL01
  });
});
