import { describe, expect, test } from "bun:test";
import { FixedStepper, ORIGINAL_TICK_MS } from "../src/shared/timing.ts";
import { GameSimulation } from "../src/server/simulation.ts";
import { MAP_NAMES } from "../src/server/gameData.ts";
import { mapOrigin } from "../src/client/stages/GameStage.ts";

describe("original fixed step", () => {
  test("30ms units and 15-step catch-up cap", () => {
    const s = new FixedStepper();
    expect(s.add(29)).toBe(0);
    expect(s.add(1)).toBe(1);
    expect(s.add(30 * 20)).toBe(15); // exe clamps catch-up to 15 updates
    expect(s.add(30)).toBe(1); // debt dropped after cap
    s.reset();
    expect(s.add(60)).toBe(2);
  });

  test("map viewport origin matches sub_4E47B4", () => {
    expect(mapOrigin(15, 13)).toEqual({ x: 20, y: 41 });
    expect(mapOrigin(13, 11)).toEqual({ x: 60, y: 81 });
  });

  test("practice fuse reference explodes at 2000ms, not 3000ms", () => {
    const sim = new GameSimulation(MAP_NAMES.indexOf("Village00"), [{ id: "p", slot: 0, character: 0 }], () => 0.5);
    sim.setInput("p", 0, 0, true);
    sim.tick(ORIGINAL_TICK_MS);
    sim.setInput("p", 0, 0, false);
    expect(sim.bombs.length).toBe(1);
    for (let i = 0; i < 65; i++) sim.tick(ORIGINAL_TICK_MS); // 1980ms total
    expect(sim.bombs.length).toBe(1);
    expect(sim.fires.length).toBe(0);
    sim.tick(ORIGINAL_TICK_MS); // 2010ms total crosses the 2000ms fuse
    expect(sim.bombs.length).toBe(0);
    expect(sim.fires.length).toBeGreaterThan(0);
    expect(sim.snapshot().timeMs).toBe(67 * ORIGINAL_TICK_MS);
  });
});
