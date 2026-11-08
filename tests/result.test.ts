import { describe, expect, test } from "bun:test";
import { resultBarWidth, resultBarSegments, resultDialogHeight } from "../src/shared/resultLayout.ts";
import { GameSimulation } from "../src/server/simulation.ts";
import { MAP_NAMES } from "../src/server/gameData.ts";
import { ORIGINAL_TICK_MS } from "../src/shared/timing.ts";

describe("CGOGameResult bar geometry (sub_454B49)", () => {
  test("width = 60*value/999 capped at 60", () => {
    expect(resultBarWidth(0)).toBe(0);
    expect(resultBarWidth(-5)).toBe(0);
    expect(resultBarWidth(500)).toBe(30);
    expect(resultBarWidth(999)).toBe(60);
    expect(resultBarWidth(2000)).toBe(60);
  });

  test("fill segments use 30/15/10/rest thresholds", () => {
    expect(resultBarSegments(0)).toEqual([]);
    expect(resultBarSegments(500)).toEqual([{ image: 46, x: 0, w: 30 }]);
    expect(resultBarSegments(517)).toEqual([{ image: 46, x: 0, w: 30 }, { image: 47, x: 30, w: 1 }]);
    expect(resultBarSegments(999)).toEqual([
      { image: 46, x: 0, w: 30 },
      { image: 47, x: 30, w: 15 },
      { image: 48, x: 45, w: 10 },
      { image: 49, x: 55, w: 5 },
    ]);
  });

  test("dialog height fits up to 8 rows at 25px pitch", () => {
    expect(resultDialogHeight(4)).toBe(167);
    expect(resultDialogHeight(8)).toBe(267);
    expect(resultDialogHeight(12)).toBe(267);
  });
});

describe("server-original result stats", () => {
  function clearArea(sim: GameSimulation, cx: number, cy: number) {
    for (let y = cy - 2; y <= cy + 2; y++) {
      for (let x = cx - 2; x <= cx + 2; x++) {
        const cell = sim.cells[y * sim.width + x];
        if (cell) { cell.kind = 0; cell.object = null; }
      }
    }
  }
  function park(sim: GameSimulation, id: string, x: number, y: number) {
    const p = sim.bombers.find((b) => b.id === id)!;
    p.tx = x; p.ty = y; p.x = x * 40; p.y = y * 40; p.gx = x; p.gy = y; p.moving = false;
  }

  test("fire kill credits the bomb owner and ranks the winner first", () => {
    const sim = new GameSimulation(MAP_NAMES.indexOf("Village00"), [
      { id: "p0", slot: 0, character: 0 },
      { id: "p1", slot: 1, character: 1 },
    ], () => 0.5);
    clearArea(sim, 7, 6);
    park(sim, "p0", 0, 0);
    park(sim, "p1", 7, 6);
    sim.bombs.push({ id: 999, x: 7, y: 6, owner: "p0", timer: ORIGINAL_TICK_MS, power: 1 });
    sim.tick(ORIGINAL_TICK_MS);
    expect(sim.over).toBe(true);
    expect(sim.winner).toBe("p0");
    const res = sim.result();
    expect(res.rows?.length).toBe(2);
    const p0 = res.rows!.find((r) => r.id === "p0")!;
    const p1 = res.rows!.find((r) => r.id === "p1")!;
    expect(p0.kills).toBe(1);
    expect(p0.rank).toBe(1);
    expect(p0.award).toBe(57);
    expect(p1.deaths).toBe(1);
    expect(p1.alive).toBe(false);
    expect(res.durationMs).toBe(ORIGINAL_TICK_MS);
  });

  test("box destruction is credited to the bomb owner", () => {
    const sim = new GameSimulation(MAP_NAMES.indexOf("Village00"), [
      { id: "p0", slot: 0, character: 0 },
      { id: "p1", slot: 1, character: 1 },
    ], () => 0.5);
    clearArea(sim, 7, 6);
    park(sim, "p0", 0, 0);
    park(sim, "p1", 0, 1);
    const box = sim.cells[6 * sim.width + 8]!;
    box.kind = 2; box.object = "Tile00_Box/Box00";
    sim.bombs.push({ id: 999, x: 7, y: 6, owner: "p0", timer: ORIGINAL_TICK_MS, power: 1 });
    sim.tick(ORIGINAL_TICK_MS);
    const res = sim.result();
    const p0 = res.rows!.find((r) => r.id === "p0")!;
    expect(p0.boxes).toBe(1);
    expect(sim.destroyed).toContain(6 * sim.width + 8);
  });
});
