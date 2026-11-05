import {
  CELL_SIZE,
  Direction,
  GRID_COLS,
  GRID_ROWS,
  PLAYFIELD_OFFSET_X,
  PLAYFIELD_OFFSET_Y,
  TEAM_DISPLAY_NAMES,
  anchorToCol,
  anchorToRow,
  cellToAnchorX,
  cellToAnchorY,
} from "../../shared/constants.ts";
import { ClientOpcode } from "../../shared/protocol.ts";
import {
  ActiveItemKind,
  BomberStatus,
  type PlayerInputState,
  type SimBomber,
} from "../../shared/sim/world.ts";
import type { RGBA } from "../gpu/renderer.ts";
import type { ClientAppState } from "../state.ts";

const TEAM_BADGE_COLORS: readonly RGBA[] = [
  [0.95, 0.25, 0.25, 1], // Red
  [0.98, 0.85, 0.18, 1], // Yellow
  [0.98, 0.55, 0.15, 1], // Orange
  [0.25, 0.82, 0.35, 1], // Green
  [0.28, 0.82, 0.96, 1], // Sky
  [0.25, 0.48, 0.98, 1], // Blue
  [0.68, 0.35, 0.95, 1], // Purple
  [0.96, 0.48, 0.78, 1], // Pink
  [0.65, 0.68, 0.72, 1], // Gray
];

export function sampleLocalPlayerInputs(state: ClientAppState): {
  p1: PlayerInputState;
  p2: PlayerInputState;
} {
  const ui = state.ui;
  const just = ui.keysJustPressed;

  // Toggle authentic CA.exe Enter chat bar during Game stage
  if (state.stage === "Game" && just.has("Enter") && !ui.activeFieldId && !ui.hasNoticeOpen) {
    just.delete("Enter");
    ui.focusField("game_chat");
  }

  // Last-Key-Wins direction stack! (Arrow keys + WASD fallback when solo)
  const p1Dir = ui.getP1Direction(!state.local2PEnabled);
  const p1: PlayerInputState = {
    dir: p1Dir,
    placeBomb: just.has("Space"),
    useCtrl:
      just.has("ControlLeft") ||
      just.has("ControlRight") ||
      (!state.local2PEnabled && just.has("KeyZ")),
    useAlt:
      just.has("AltLeft") ||
      just.has("AltRight") ||
      (!state.local2PEnabled && just.has("KeyX")),
  };

  const p2Dir = state.local2PEnabled ? ui.getP2Direction() : Direction.None;
  const p2: PlayerInputState = {
    dir: p2Dir,
    placeBomb: state.local2PEnabled && just.has("ShiftLeft"),
    useCtrl: state.local2PEnabled && just.has("KeyQ"),
    useAlt: state.local2PEnabled && just.has("KeyE"),
  };

  return { p1, p2 };
}

function lerpCoord(prev: number, cur: number, alpha: number): number {
  if (Math.abs(cur - prev) > 80) return cur;
  return prev + (cur - prev) * alpha;
}

function activeItemSpritePath(kind: ActiveItemKind): string | null {
  switch (kind) {
    case ActiveItemKind.Needle:
      return "Item/ItemNiddle";
    case ActiveItemKind.Dart:
      return "Item/ItemDart";
    case ActiveItemKind.Spring:
      return "Item/ItemSpring";
    case ActiveItemKind.Shield:
      return "Item/Shield";
    case ActiveItemKind.Remote:
      return "Bomb/BombRadio";
    default:
      return null;
  }
}

export function renderGameStage(state: ClientAppState, renderAlpha = 1): void {
  const r = state.assets.renderer;
  const ui = state.ui;
  const world = state.world;

  // 1. Verbatim 800x600 Game/CAStage JPEG frame
  const bg = state.assets.getJpegSync("Fx", "Game/CAStage");
  if (bg) {
    r.drawQuad(bg, 0, 0, 800, 600);
  } else {
    r.drawRect(0, 0, 800, 600, [0.05, 0.25, 0.56, 1]);
  }

  if (!world) {
    return;
  }

  const ox = PLAYFIELD_OFFSET_X; // 20
  const oy = PLAYFIELD_OFFSET_Y; // 41
  const myBomber = world.bombers.find((b) => b.slotIndex === state.myPrimarySlot);

  // Map Name in top-left carved badge (12, 6, 95, 22) of Game/CAStage
  r.drawText(world.map.mapName, 59, 12, [0.85, 0.95, 1, 1], {
    align: "center",
    maxWidth: 88,
  });

  // Top-right Messenger button at exact CA.exe coordinate (764, 5)
  if (
    ui.spriteButton(state.assets, "game_msg", "GlobalUI/BtMessenger", 764, 5, {
      tooltip: state.audio.muted ? "開啟音效" : "切換靜音",
    })
  ) {
    state.audio.toggleMute();
  }

  // Playfield base backdrop (20, 41, 600, 520)
  r.drawRect(ox, oy, GRID_COLS * CELL_SIZE, GRID_ROWS * CELL_SIZE, [0.16, 0.34, 0.18, 1]);

  // 2. Ground tiles (15x13) + Survival RedZone
  for (let row = 0; row < GRID_ROWS; row++) {
    for (let col = 0; col < GRID_COLS; col++) {
      const idx = world.cellIdx(row, col);
      const ax = ox + cellToAnchorX(col);
      const ay = oy + cellToAnchorY(row);

      const gid = world.groundIds[idx]!;
      let drewGround = false;
      if (gid >= 0) {
        const tpl = state.assets.fxTemplates[gid];
        if (tpl) {
          drewGround = state.assets.drawFxTemplateState(tpl, "Default", world.tick, ax, ay);
        }
      }
      if (!drewGround) {
        const checker = (row + col) % 2 === 0 ? 0.24 : 0.21;
        r.drawRect(ox + col * CELL_SIZE, oy + row * CELL_SIZE, CELL_SIZE, CELL_SIZE, [
          checker * 0.75,
          checker * 1.35,
          checker * 0.7,
          1,
        ]);
      }

      if (world.redZoneGrid[idx] !== 0) {
        r.drawRect(
          ox + col * CELL_SIZE,
          oy + row * CELL_SIZE,
          CELL_SIZE,
          CELL_SIZE,
          [0.72, 0.1, 0.1, 0.55],
        );
      }
    }
  }

  // 3. Active Directional Water Flames (Flame/Flame -> Bomb/Fire00)
  const flameTpl = state.assets.fxByName.get("flame/flame");
  for (const fl of world.flames) {
    const ax = ox + cellToAnchorX(fl.col);
    const ay = oy + cellToAnchorY(fl.row);
    if (flameTpl) {
      const stateBase =
        fl.part === 0
          ? 0
          : fl.part <= 2
            ? 15
            : fl.part <= 4
              ? 30
              : fl.part <= 6
                ? 45
                : 60;
      state.assets.drawFxTemplateState(
        flameTpl,
        stateBase + (fl.part % 2 === 0 && fl.part > 0 ? 5 : 0),
        fl.totalTicks - fl.ticksLeft,
        ax,
        ay,
      );
    }
  }

  // 4. Row-by-row (0..12) Y-Sorted Render Pass (Items, Bombs, Blocks, Monsters, Bombers, Bushes)
  const bombTpl = state.assets.fxByName.get("bomb/bomb");
  const shadowSheet = state.assets.getSpriteSync("Fx", "Shadow/Shadow");

  for (let row = 0; row < GRID_ROWS; row++) {
    // 4a. Ground items on this row
    for (const it of world.items) {
      if (it.row !== row) continue;
      const bob = Math.round(Math.sin(it.animTick * 0.18) * 3);
      const ax = ox + cellToAnchorX(it.col);
      const ay = oy + cellToAnchorY(it.row) + bob;

      if (shadowSheet) {
        state.assets.drawSpriteFrame(shadowSheet, 0, ax, oy + cellToAnchorY(it.row), [1, 1, 1, 0.45]);
      }

      const tpl =
        state.assets.fxByName.get(it.templateName.toLowerCase()) ??
        state.assets.fxByName.get(it.itemName.toLowerCase());
      let drew = false;
      if (tpl) {
        drew = state.assets.drawFxTemplateState(tpl, 0, it.animTick, ax, ay);
      }
      if (!drew) {
        const sheet = state.assets.getSpriteSync("Fx", it.itemName);
        if (sheet) {
          const fi = Math.floor(it.animTick / 6) % Math.max(1, sheet.frames.length);
          state.assets.drawSpriteFrame(sheet, fi, ax, ay);
        }
      }
    }

    // 4b. Landed / Kicked Bombs on this row (with smooth sub-tick interpolation!)
    for (const bm of world.bombs) {
      if (bm.lobTicks > 0 || bm.row !== row) continue;
      const ax = ox + lerpCoord(bm.prevX, bm.x, renderAlpha);
      const ay = oy + lerpCoord(bm.prevY, bm.y, renderAlpha);
      let drew = false;
      if (bm.bombSkin > 0) {
        drew = state.assets.drawShopItemPreview(bm.bombSkin, ax + 20, ay - 18, world.tick);
      }
      if (!drew && bombTpl) {
        state.assets.drawFxTemplateState(
          bombTpl,
          bm.isRemote ? "1 Remote" : "0 Default",
          world.tick,
          ax,
          ay,
        );
      }
    }

    // 4c. Blocks & Map Objects anchored on this row
    for (let col = 0; col < GRID_COLS; col++) {
      const idx = world.cellIdx(row, col);
      const oid = world.objectIds[idx]!;
      if (oid < 0) continue;
      const tpl = state.assets.fxTemplates[oid];
      if (!tpl) continue;

      const ax = ox + cellToAnchorX(col);
      const ay = oy + cellToAnchorY(row);
      if (world.bushGrid[idx] === 0) {
        state.assets.drawFxTemplateState(tpl, "Default", world.tick, ax, ay);
      }
    }

    // Melting blocks on this row
    for (const mb of world.meltingBlocks) {
      if (mb.row !== row) continue;
      const tpl = state.assets.fxTemplates[mb.templateId];
      const ax = ox + cellToAnchorX(mb.col);
      const ay = oy + cellToAnchorY(mb.row);
      if (tpl) {
        state.assets.drawFxTemplateState(tpl, "Broken", 14 - mb.ticksLeft, ax, ay, [
          1,
          1,
          1,
          mb.ticksLeft / 14,
        ]);
      }
    }

    // Pushing blocks crossing this row
    for (const pb of world.pushingBlocks) {
      if (pb.toRow !== row) continue;
      const tpl = state.assets.fxTemplates[pb.templateId];
      const t = 1 - (pb.ticksLeft - renderAlpha) / pb.totalTicks;
      const clampedT = Math.max(0, Math.min(1, t));
      const px =
        cellToAnchorX(pb.fromCol) +
        (cellToAnchorX(pb.toCol) - cellToAnchorX(pb.fromCol)) * clampedT;
      const py =
        cellToAnchorY(pb.fromRow) +
        (cellToAnchorY(pb.toRow) - cellToAnchorY(pb.fromRow)) * clampedT;
      if (tpl) {
        state.assets.drawFxTemplateState(tpl, "Default", world.tick, ox + px, oy + py);
      }
    }

    // 4d. Monsters on this row (sub-tick interpolated)
    for (const mon of world.monsters) {
      const interpY = lerpCoord(mon.prevY, mon.y, renderAlpha);
      if (!mon.alive || anchorToRow(interpY) !== row) continue;
      const interpX = lerpCoord(mon.prevX, mon.x, renderAlpha);
      const mx = ox + interpX + 20;
      const my = oy + interpY;

      const sheet =
        state.assets.getSpriteSync("Fx", `Monster/${mon.name}`) ??
        state.assets.getSpriteSync("Fx", "Game/Mst_N_Down") ??
        state.assets.getSpriteSync("Fx", "Game/Bat00");
      if (sheet) {
        const fi = Math.floor(mon.aiTick / 6) % Math.max(1, sheet.frames.length);
        state.assets.drawSpriteFrame(sheet, fi, mx - 20, my, [1, 1, 1, 1], mon.isBoss ? 1.35 : 1);
      }
      if (mon.trappedTicks > 0) {
        const bubTpl = state.assets.fxByName.get("bomb/bubble");
        if (bubTpl) state.assets.drawFxTemplateState(bubTpl, "00 Lock", mon.aiTick, mx - 20, my);
      }
      if (mon.maxHp > 1) {
        r.drawRect(mx - 22, my - 56, 44, 5, [0.05, 0.08, 0.14, 0.9]);
        r.drawRect(mx - 21, my - 55, Math.floor(42 * (mon.hp / mon.maxHp)), 3, [1, 0.28, 0.25, 1]);
      }
    }

    // 4e. Bombers on this row (sub-tick interpolated prevX/prevY -> x/y!)
    const rowBombers = world.bombers
      .filter(
        (b) =>
          b.status !== BomberStatus.Dead &&
          anchorToRow(lerpCoord(b.prevY, b.y, renderAlpha)) === row,
      )
      .sort(
        (a, b) =>
          lerpCoord(a.prevY, a.y, renderAlpha) - lerpCoord(b.prevY, b.y, renderAlpha),
      );

    for (const b of rowBombers) {
      const interpX = lerpCoord(b.prevX, b.x, renderAlpha);
      const interpY = lerpCoord(b.prevY, b.y, renderAlpha);
      const col = anchorToCol(interpX);
      const inBush = world.inBounds(row, col) && world.bushGrid[world.cellIdx(row, col)] !== 0;
      const isAllyOrSelf = !myBomber || world.areAllies(myBomber, b);

      // Authentic CA.exe bush stealth: enemies inside a bush are completely invisible!
      if (inBush && !isAllyOrSelf && b.status === BomberStatus.Normal) {
        continue;
      }

      // Spawn blink invulnerability flicker
      if (b.invulnTicks > 0 && Math.floor(b.invulnTicks / 2) % 2 === 1) {
        continue;
      }

      const bx = Math.round(ox + interpX + 20);
      const by = Math.round(oy + interpY);

      state.assets.drawCharacterPaperDoll({
        charIndex: b.charIndex,
        team: b.team,
        dir: b.dir,
        moving: b.moving,
        status: b.status,
        animTick: b.animTick,
        anchorX: bx,
        anchorY: by,
        zOffset: b.zOffset,
        mountType: b.mountType,
        shieldTicks: b.shieldTicks,
        isCaptain: b.isCaptain,
        hasTimebomb: b.hasTimebomb,
        timebombSec: Math.ceil(b.timebombTicks / 33),
        equipped: b.equipped,
      });

      const isSelf =
        b.slotIndex === state.myPrimarySlot || b.slotIndex === state.mySecondarySlot;

      // Authentic Game/SelfIndicator bouncing arrow above local player's head!
      if (isSelf && world.tick < 220) {
        const selfInd = state.assets.getSpriteSync("Fx", "Game/SelfIndicator");
        if (selfInd) {
          const bounce = Math.round(Math.sin((world.tick + renderAlpha) * 0.28) * 3);
          const frame = Math.min(selfInd.frames.length - 1, b.team);
          state.assets.drawSpriteFrame(selfInd, frame, bx, by - 22 + bounce);
        }
      }

      // Native Game/ChatBalloon speech bubble above bomber when chatting!
      const bubble = state.chatBubbles.get(b.nickname);
      if (bubble) {
        ui.drawChatBalloon(state.assets, "Game/ChatBalloon", bubble.text, bx, by - 52);
      }

      // Player nickname tag under feet (exact CA.exe style)
      const tagColor: RGBA = isSelf
        ? [0.55, 1.0, 0.55, 1]
        : TEAM_BADGE_COLORS[b.team] ?? [1, 1, 1, 1];
      r.drawText(b.nickname, bx, by + 2, tagColor, { align: "center" });
    }

    // 4f. Bush foliage drawn OVER bombers on this row!
    for (let col = 0; col < GRID_COLS; col++) {
      const idx = world.cellIdx(row, col);
      if (world.bushGrid[idx] === 0) continue;
      const oid = world.objectIds[idx]!;
      if (oid < 0) continue;
      const tpl = state.assets.fxTemplates[oid];
      if (!tpl) continue;

      const hasFriendlyInside = rowBombers.some(
        (b) =>
          anchorToCol(lerpCoord(b.prevX, b.x, renderAlpha)) === col &&
          (!myBomber || world.areAllies(myBomber, b)),
      );
      const ax = ox + cellToAnchorX(col);
      const ay = oy + cellToAnchorY(row);
      state.assets.drawFxTemplateState(
        tpl,
        "Default",
        world.tick,
        ax,
        ay,
        [1, 1, 1, hasFriendlyInside ? 0.55 : 1.0],
      );
    }
  }

  // 5. Airborne lobbed bombs & flying darts (Item/ItemDart native sprite!)
  for (const bm of world.bombs) {
    if (bm.lobTicks <= 0) continue;
    const ax = ox + lerpCoord(bm.prevX, bm.x, renderAlpha);
    const ay = oy + lerpCoord(bm.prevY, bm.y, renderAlpha) + bm.zOffset;
    if (bombTpl) {
      state.assets.drawFxTemplateState(bombTpl, "0 Default", world.tick, ax, ay);
    }
  }
  const dartSheet = state.assets.getSpriteSync("Fx", "Item/ItemDart");
  for (const dt of world.darts) {
    if (dartSheet && dartSheet.frames.length > 0) {
      state.assets.drawSpriteFrame(dartSheet, 0, ox + dt.x - 12, oy + dt.y + 8);
    } else {
      r.drawRect(ox + dt.x - 4, oy + dt.y - 4, 8, 8, [1, 0.95, 0.25, 1]);
    }
  }

  // 6. Authentic Right-Hand HUD inside Game/CAStage's carved slots (ZERO covering panels!)
  // 6a. Timer inside carved "剩餘時間 :" slot (655, 65, 126, 26) using Game/Timer .i16 digits!
  const totalSec = Math.max(0, Math.ceil(world.timeRemainingTicks / 33));
  const mm = String(Math.floor(totalSec / 60)).padStart(2, "0");
  const ss = String(totalSec % 60).padStart(2, "0");
  const timerTint: RGBA = world.suddenDeathActive ? [1, 0.45, 0.45, 1] : [1, 1, 1, 1];
  const drewMm = ui.drawSpriteDigits(state.assets, "Game/Timer", mm, 715, 73, 12, 0, timerTint);
  const drewSs = ui.drawSpriteDigits(state.assets, "Game/Timer", ss, 747, 73, 12, 0, timerTint);
  if (!drewMm || !drewSs) {
    r.drawText(mm, 716, 72, [1, 0.96, 0.55, 1], { bold: true });
    r.drawText(ss, 748, 72, [1, 0.96, 0.55, 1], { bold: true });
  }

  // 6b. 8 Carved Player Roster Slots (x=655, y = 96 + 43 * i) using Game/TeamColor & Etc/LevelIcons!
  const teamColSheet = state.assets.getSpriteSync("Fx", "Game/TeamColor");
  const lvlSheet = state.assets.getSpriteSync("Fx", "Etc/LevelIcons");

  for (let i = 0; i < 8; i++) {
    const sy = 96 + i * 43;
    const b: SimBomber | undefined = world.bombers.find((p) => p.slotIndex === i);
    if (!b) continue;

    const isDead = b.status === BomberStatus.Dead;
    const isTrapped = b.status === BomberStatus.Trapped;

    // Native Game/TeamColor slot plate
    if (teamColSheet && teamColSheet.frames.length > 0) {
      const tFrame = Math.min(teamColSheet.frames.length - 1, b.team);
      state.assets.drawSpriteFrame(teamColSheet, tFrame, 658, sy, [1, 1, 1, isDead ? 0.45 : 0.9]);
    }

    // Portrait inside left dark box (661, sy + 6, 42, 31)
    state.assets.drawCharacterPortrait(
      b.charIndex,
      b.team,
      670,
      sy + 12,
      isDead ? 0.35 : 1.0,
    );

    if (isTrapped) {
      const bubTpl = state.assets.fxByName.get("bomb/bubble");
      if (bubTpl) {
        state.assets.drawFxTemplateState(bubTpl, "00 Lock", world.tick, 665, sy + 36, [1, 1, 1, 0.72], 0.72);
      }
    }

    // Native LevelIcon in middle badge (706, sy + 6)
    if (lvlSheet && lvlSheet.frames.length > 0) {
      const li = Math.min(lvlSheet.frames.length - 1, Math.max(0, b.slotIndex * 3));
      state.assets.drawSpriteFrame(lvlSheet, li, 707, sy + 7);
    }

    // Status / KO count inside right dark pill (731, sy + 6, 44, 16)
    const rightTag = isDead ? "OUT" : isTrapped ? "HELP" : `KO:${b.kills}`;
    const rightCol: RGBA = isDead
      ? [0.65, 0.68, 0.72, 1]
      : isTrapped
        ? [1, 0.55, 0.4, 1]
        : [0.85, 0.96, 1, 1];
    r.drawText(rightTag, 753, sy + 8, rightCol, { align: "center", outlined: false });

    // Player nickname in bottom strip (707, sy + 24, 70, 14)
    const isSelf = b.slotIndex === state.myPrimarySlot || b.slotIndex === state.mySecondarySlot;
    r.drawText(b.nickname, 707, sy + 24, isSelf ? [1, 0.96, 0.45, 1] : [1, 1, 1, 1], {
      maxWidth: 70,
      outlined: true,
    });
  }

  // 6c. Carved "項目" Active Item Box (640..795, 449..554) using original Game/ItemBox00!
  const itemBoxName = state.local2PEnabled ? "Game/ItemBox01" : "Game/ItemBox00";
  const itemBoxSheet = state.assets.getSpriteSync("Fx", itemBoxName);
  if (itemBoxSheet) {
    state.assets.drawSpriteFrame(itemBoxSheet, 0, 648, 468);
  }

  if (myBomber) {
    const drawHeldItem = (kind: ActiveItemKind, count: number, ix: number, iy: number) => {
      if (kind === ActiveItemKind.None || count <= 0) return;
      const sp = activeItemSpritePath(kind);
      if (sp) {
        const sheet = state.assets.getSpriteSync("Fx", sp);
        if (sheet) {
          state.assets.drawSpriteFrame(sheet, 0, ix, iy);
        }
      }
      ui.drawSpriteDigits(state.assets, "Game/ItemCount", String(count), ix + 26, iy - 12, 11);
    };

    // Ctrl slot (left cell of ItemBox00) & Alt slot (right cell of ItemBox00)
    drawHeldItem(myBomber.ctrlItem, myBomber.ctrlCount, 660, 526);
    drawHeldItem(myBomber.altItem, myBomber.altCount, 724, 526);
  }

  // 6d. Exact CA.exe Exit Button: Game/BtExit (140x32) at (647, 561)!
  if (
    ui.spriteButton(state.assets, "game_exit", "Game/BtExit", 647, 561)
  ) {
    if (!state.isOfflineSolo) {
      state.net.sendJson(ClientOpcode.LeaveRoom, {});
    }
    state.world = null;
    state.matchResult = null;
    state.switchStage("Lobby");
    return;
  }

  // 7. Authentic CA.exe In-Game Floating Chat (sub_4A791F: history (25,463), input (25,539) via Etc/TextBox!)
  const recentChats = state.chatLog.slice(-4);
  let chatY = 478;
  for (const c of recentChats) {
    r.drawText(`${c.sender}: ${c.text}`, 28, chatY, c.isWhisper ? [0.55, 1, 0.75, 1] : [1, 1, 1, 0.95], {
      maxWidth: 440,
      outlined: true,
    });
    chatY += 15;
  }

  if (ui.activeFieldId === "game_chat") {
    const chatField = ui.carvedField("game_chat", 25, 535, 442, 20, {
      assets: state.assets,
      drawNineSliceBg: true,
      textColor: [0.05, 0.12, 0.26, 1],
      placeholderColor: [0.35, 0.45, 0.6, 0.9],
      placeholder: "Enter 送出對話...",
      outlined: false,
    });
    if (chatField.submitted) {
      const txt = chatField.value.trim();
      if (txt) {
        state.net.sendJson(ClientOpcode.ChatMessage, { text: txt });
        if (state.isOfflineSolo) {
          const me = state.profile?.nickname ?? "1P 藍寶";
          state.chatLog.push({ sender: me, text: txt });
          state.chatBubbles.set(me, { text: txt, ticks: 135 });
        }
      }
      ui.setFieldValue("game_chat", "");
      ui.blurField();
    }
  }

  // 8. Authentic Game/Start & Game/HurryUp Sprite Banners!
  if (world.tick < 54) {
    const startSheet = state.assets.getSpriteSync("Fx", "Game/Start");
    if (startSheet) {
      for (let li = 0; li < Math.min(5, startSheet.frames.length); li++) {
        const drop = Math.max(0, 12 - (world.tick - li * 3)) * 5;
        state.assets.drawSpriteFrame(startSheet, li, 162 + li * 64, 250 - drop);
      }
    }
  } else if (world.suddenDeathActive && world.timeRemainingTicks > 28 * 33) {
    const hurrySheet = state.assets.getSpriteSync("Fx", "Game/HurryUp");
    if (hurrySheet) {
      for (let li = 0; li < hurrySheet.frames.length; li++) {
        state.assets.drawSpriteFrame(hurrySheet, li, 168 + li * 42, 255);
      }
    }
  }

  // 9. Authentic Match Result Overlay using Game/Win, Game/Lose, Game/Draw & Game/ResultInfoBar!
  if (state.matchResult) {
    const mr = state.matchResult;
    r.drawRect(ox, oy, 600, 520, [0, 0, 0, 0.52]);

    const myWin =
      mr.winningTeam >= 100
        ? mr.winningTeam - 100 === state.myPrimarySlot
        : myBomber
          ? mr.winningTeam === myBomber.team
          : false;
    const bannerSprite =
      mr.winningTeam < 0 ? "Game/Draw" : myWin ? "Game/Win" : "Game/Lose";
    const bannerSheet = state.assets.getSpriteSync("Fx", bannerSprite);
    if (bannerSheet) {
      const startX = 320 - (bannerSheet.frames.length * 66) * 0.5;
      for (let li = 0; li < bannerSheet.frames.length; li++) {
        state.assets.drawSpriteFrame(bannerSheet, li, startX + li * 66, 98);
      }
    }

    const barSheet = state.assets.getSpriteSync("Fx", "Game/ResultInfoBar");
    mr.scores.forEach((sc, idx) => {
      const rx = 142;
      const ry = 188 + idx * 26;
      if (barSheet) {
        const fi = sc.slotIndex === state.myPrimarySlot ? 1 : 0;
        state.assets.drawSpriteFrame(barSheet, Math.min(barSheet.frames.length - 1, fi), rx, ry);
      }
      if (lvlSheet && lvlSheet.frames.length > 0) {
        state.assets.drawSpriteFrame(lvlSheet, Math.min(lvlSheet.frames.length - 1, sc.newLevel), rx + 6, ry + 3);
      }
      r.drawText(
        `${sc.nickname}${sc.leveledUp ? ` Lv.${sc.newLevel}` : ""}`,
        rx + 26,
        ry + 3,
        [1, 1, 1, 1],
        { maxWidth: 120, bold: true },
      );
      r.drawText(`${TEAM_DISPLAY_NAMES[sc.team] ?? ""}`, rx + 148, ry + 3, [0.8, 0.92, 1, 1]);
      r.drawText(`KO ${sc.kills}`, rx + 206, ry + 3, [1, 0.9, 0.45, 1]);
      r.drawText(`+${sc.expGain}EXP`, rx + 252, ry + 3, [0.65, 0.95, 1, 1]);
      r.drawText(`+${sc.lucciGain}L`, rx + 312, ry + 3, [1, 0.92, 0.4, 1]);
    });

    if (
      ui.spriteButton(state.assets, "res_ok", "Etc/BtOk", 269, 430) ||
      ui.keysJustPressed.has("Enter") ||
      ui.keysJustPressed.has("Space")
    ) {
      state.world = null;
      state.matchResult = null;
      state.switchStage(state.currentRoom ? "Prepare" : "Lobby");
    }
  }
}
