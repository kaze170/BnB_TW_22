import {
  DIR_DX,
  DIR_DY,
  Direction,
  GRID_COLS,
  GRID_ROWS,
  anchorToCol,
  anchorToRow,
  cellToAnchorX,
  cellToAnchorY,
} from "../constants.ts";
import {
  ActiveItemKind,
  BomberStatus,
  type GameWorld,
  type PlayerInputState,
  type SimBomber,
} from "./world.ts";

const TOTAL_CELLS = GRID_ROWS * GRID_COLS;

export function buildDangerGrid(world: GameWorld): Uint8Array {
  const danger = new Uint8Array(TOTAL_CELLS);

  for (let i = 0; i < TOTAL_CELLS; i++) {
    if (world.redZoneGrid[i] !== 0) danger[i] = 255;
  }

  for (const fl of world.flames) {
    if (world.inBounds(fl.row, fl.col)) {
      danger[world.cellIdx(fl.row, fl.col)] = 255;
    }
  }

  for (const bomb of world.bombs) {
    const urgency = Math.max(1, 200 - Math.min(190, bomb.fuseTicks * 2));
    if (world.inBounds(bomb.row, bomb.col)) {
      const cIdx = world.cellIdx(bomb.row, bomb.col);
      danger[cIdx] = Math.max(danger[cIdx]!, urgency);
    }
    for (let d = 0; d < 4; d++) {
      const dx = DIR_DX[d]!;
      const dy = DIR_DY[d]!;
      for (let step = 1; step <= bomb.power; step++) {
        const r = bomb.row + dy * step;
        const c = bomb.col + dx * step;
        if (!world.inBounds(r, c)) break;
        const idx = world.cellIdx(r, c);
        if (world.solidGrid[idx] !== 0) break;
        danger[idx] = Math.max(danger[idx]!, urgency);
      }
    }
  }

  return danger;
}

function canBotTraverse(world: GameWorld, bot: SimBomber, row: number, col: number): boolean {
  if (!world.inBounds(row, col)) return false;
  return !world.isCellBlockedForBomber(bot, row, col);
}

function hasEscapeRouteAfterPlacing(
  world: GameWorld,
  bot: SimBomber,
  danger: Uint8Array,
  placeR: number,
  placeC: number,
): boolean {
  const simDanger = new Uint8Array(danger);
  simDanger[world.cellIdx(placeR, placeC)] = 180;
  for (let d = 0; d < 4; d++) {
    for (let step = 1; step <= bot.powerCur; step++) {
      const rr = placeR + DIR_DY[d]! * step;
      const cc = placeC + DIR_DX[d]! * step;
      if (!world.inBounds(rr, cc)) break;
      const idx = world.cellIdx(rr, cc);
      if (world.solidGrid[idx] !== 0) break;
      simDanger[idx] = Math.max(simDanger[idx]!, 180);
    }
  }

  const visited = new Uint8Array(TOTAL_CELLS);
  const queue: [number, number, number][] = [[placeR, placeC, 0]];
  visited[world.cellIdx(placeR, placeC)] = 1;

  while (queue.length > 0) {
    const [r, c, dist] = queue.shift()!;
    if (simDanger[world.cellIdx(r, c)] === 0) return true;
    if (dist >= 7) continue;

    for (let d = 0; d < 4; d++) {
      const nr = r + DIR_DY[d]!;
      const nc = c + DIR_DX[d]!;
      if (!world.inBounds(nr, nc)) continue;
      const nIdx = world.cellIdx(nr, nc);
      if (visited[nIdx] !== 0) continue;
      if (!canBotTraverse(world, bot, nr, nc)) continue;
      if (simDanger[nIdx]! >= 240) continue; // active flame
      visited[nIdx] = 1;
      queue.push([nr, nc, dist + 1]);
    }
  }
  return false;
}

function steerTowardCell(bot: SimBomber, targetR: number, targetC: number): Direction {
  const tx = cellToAnchorX(targetC);
  const ty = cellToAnchorY(targetR);
  const dx = tx - bot.x;
  const dy = ty - bot.y;
  if (Math.abs(dx) >= Math.abs(dy) && Math.abs(dx) > 2) {
    return dx < 0 ? Direction.Left : Direction.Right;
  }
  if (Math.abs(dy) > 2) {
    return dy < 0 ? Direction.Up : Direction.Down;
  }
  if (dx !== 0) return dx < 0 ? Direction.Left : Direction.Right;
  if (dy !== 0) return dy < 0 ? Direction.Up : Direction.Down;
  return Direction.None;
}

/**
 * Computes CAIPlayer input for a single bot on the current 30 ms tick.
 */
export function computeBotInput(world: GameWorld, bot: SimBomber): PlayerInputState {
  const idle: PlayerInputState = {
    dir: Direction.None,
    placeBomb: false,
    useCtrl: false,
    useAlt: false,
  };

  if (
    bot.status === BomberStatus.Dead ||
    bot.status === BomberStatus.Dying ||
    bot.status === BomberStatus.Ghost ||
    bot.status === BomberStatus.Jumping
  ) {
    return idle;
  }

  // Trapped in bubble: use needle if about to suffocate or enemy is close!
  if (bot.status === BomberStatus.Trapped) {
    if (bot.ctrlItem === ActiveItemKind.Needle && bot.ctrlCount > 0 && bot.statusTicks > 45) {
      return { ...idle, useCtrl: true };
    }
    // Drift toward nearest ally
    let bestAlly: SimBomber | null = null;
    let bestDist = 1e9;
    for (const p of world.bombers) {
      if (p.slotIndex !== bot.slotIndex && p.status === BomberStatus.Normal && world.areAllies(bot, p)) {
        const d = Math.abs(p.x - bot.x) + Math.abs(p.y - bot.y);
        if (d < bestDist) {
          bestDist = d;
          bestAlly = p;
        }
      }
    }
    if (bestAlly) {
      return { ...idle, dir: steerTowardCell(bot, anchorToRow(bestAlly.y), anchorToCol(bestAlly.x)) };
    }
    return idle;
  }

  const danger = buildDangerGrid(world);
  const startR = anchorToRow(bot.y);
  const startC = anchorToCol(bot.x);
  if (!world.inBounds(startR, startC)) return idle;

  const startIdx = world.cellIdx(startR, startC);

  // 1. Evasion mode if standing on a dangerous cell!
  if (danger[startIdx]! > 0) {
    const visited = new Uint8Array(TOTAL_CELLS);
    const firstStep = new Int8Array(TOTAL_CELLS).fill(-1);
    const queue: [number, number][] = [[startR, startC]];
    visited[startIdx] = 1;

    while (queue.length > 0) {
      const [r, c] = queue.shift()!;
      const idx = world.cellIdx(r, c);
      if (danger[idx] === 0) {
        const d = firstStep[idx]! as Direction;
        if (d >= 0) {
          return { ...idle, dir: steerTowardCell(bot, startR + DIR_DY[d]!, startC + DIR_DX[d]!) };
        }
        return { ...idle, dir: steerTowardCell(bot, r, c) };
      }

      for (let d = 0; d < 4; d++) {
        const nr = r + DIR_DY[d]!;
        const nc = c + DIR_DX[d]!;
        if (!world.inBounds(nr, nc)) continue;
        const nIdx = world.cellIdx(nr, nc);
        if (visited[nIdx] !== 0) continue;
        if (!canBotTraverse(world, bot, nr, nc)) continue;
        if (danger[nIdx]! >= 245) continue;
        visited[nIdx] = 1;
        firstStep[nIdx] = r === startR && c === startC ? d : firstStep[idx]!;
        queue.push([nr, nc]);
      }
    }
    return idle;
  }

  // 2. Check if adjacent to an enemy, monster, or destructible soft block -> place bomb if safe!
  let worthyBombTarget = false;
  for (let d = 0; d < 4; d++) {
    const nr = startR + DIR_DY[d]!;
    const nc = startC + DIR_DX[d]!;
    if (!world.inBounds(nr, nc)) continue;
    const nIdx = world.cellIdx(nr, nc);
    if (world.solidGrid[nIdx] !== 0 && world.indestructGrid[nIdx] === 0) {
      worthyBombTarget = true;
      break;
    }
  }
  if (!worthyBombTarget) {
    for (const enemy of world.bombers) {
      if (
        enemy.slotIndex !== bot.slotIndex &&
        !world.areAllies(bot, enemy) &&
        enemy.status === BomberStatus.Normal
      ) {
        const er = anchorToRow(enemy.y);
        const ec = anchorToCol(enemy.x);
        if (
          (er === startR && Math.abs(ec - startC) <= bot.powerCur) ||
          (ec === startC && Math.abs(er - startR) <= bot.powerCur)
        ) {
          worthyBombTarget = true;
          break;
        }
      }
    }
  }
  if (!worthyBombTarget) {
    for (const mon of world.monsters) {
      if (mon.alive && mon.trappedTicks === 0) {
        const mr = anchorToRow(mon.y);
        const mc = anchorToCol(mon.x);
        if (Math.abs(mr - startR) + Math.abs(mc - startC) <= 2) {
          worthyBombTarget = true;
          break;
        }
      }
    }
  }

  if (
    worthyBombTarget &&
    world.getActiveBombCount(bot.slotIndex) < bot.bombsCur &&
    !world.findBombAt(startR, startC) &&
    world.tick % 6 === bot.slotIndex % 6 &&
    hasEscapeRouteAfterPlacing(world, bot, danger, startR, startC)
  ) {
    return { ...idle, placeBomb: true };
  }

  // 3. BFS over safe cells to find highest-priority objective:
  //    (a) Trapped ally to rescue or trapped enemy/monster to pop
  //    (b) Ground item pickup
  //    (c) Cell adjacent to soft block or enemy
  const visited = new Uint8Array(TOTAL_CELLS);
  const firstDir = new Int8Array(TOTAL_CELLS).fill(-1);
  const queue: [number, number][] = [[startR, startC]];
  visited[startIdx] = 1;

  const trappedTargets = new Set<number>();
  for (const p of world.bombers) {
    if (p.slotIndex !== bot.slotIndex && p.status === BomberStatus.Trapped) {
      trappedTargets.add(world.cellIdx(anchorToRow(p.y), anchorToCol(p.x)));
    }
  }
  for (const m of world.monsters) {
    if (m.alive && m.trappedTicks > 0) {
      trappedTargets.add(world.cellIdx(anchorToRow(m.y), anchorToCol(m.x)));
    }
  }

  const itemTargets = new Set<number>();
  for (const it of world.items) {
    itemTargets.add(world.cellIdx(it.row, it.col));
  }

  let chosenDir = -1;

  while (queue.length > 0) {
    const [r, c] = queue.shift()!;
    const idx = world.cellIdx(r, c);

    if (idx !== startIdx) {
      if (trappedTargets.has(idx) || itemTargets.has(idx)) {
        chosenDir = firstDir[idx]!;
        break;
      }
      // Check if adjacent to soft block or enemy
      let adjTarget = false;
      for (let d = 0; d < 4; d++) {
        const ar = r + DIR_DY[d]!;
        const ac = c + DIR_DX[d]!;
        if (world.inBounds(ar, ac)) {
          const aIdx = world.cellIdx(ar, ac);
          if (world.solidGrid[aIdx] !== 0 && world.indestructGrid[aIdx] === 0) {
            adjTarget = true;
            break;
          }
        }
      }
      if (!adjTarget) {
        for (const en of world.bombers) {
          if (en.slotIndex !== bot.slotIndex && !world.areAllies(bot, en) && en.status === BomberStatus.Normal) {
            if (Math.abs(anchorToRow(en.y) - r) + Math.abs(anchorToCol(en.x) - c) <= 1) {
              adjTarget = true;
              break;
            }
          }
        }
      }
      if (adjTarget && chosenDir < 0) {
        chosenDir = firstDir[idx]!;
      }
    }

    for (let k = 0; k < 4; k++) {
      // Slightly vary search order by slotIndex so bots don't move in lockstep
      const d = (k + bot.slotIndex) & 3;
      const nr = r + DIR_DY[d]!;
      const nc = c + DIR_DX[d]!;
      if (!world.inBounds(nr, nc)) continue;
      const nIdx = world.cellIdx(nr, nc);
      if (visited[nIdx] !== 0) continue;
      if (!canBotTraverse(world, bot, nr, nc)) continue;
      if (danger[nIdx]! > 0) continue;
      visited[nIdx] = 1;
      firstDir[nIdx] = r === startR && c === startC ? d : firstDir[idx]!;
      queue.push([nr, nc]);
    }
  }

  if (chosenDir >= 0) {
    const nr = startR + DIR_DY[chosenDir]!;
    const nc = startC + DIR_DX[chosenDir]!;
    return { ...idle, dir: steerTowardCell(bot, nr, nc) };
  }

  return idle;
}
