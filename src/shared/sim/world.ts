import {
  BLOCK_DESTROY_TICKS,
  BLOCK_PUSH_TICKS,
  BOMB_FUSE_TICKS,
  BOMB_KICK_MAX_STEP_PX,
  BOMB_LOB_TICKS,
  BUBBLE_IMMUNE_TICKS,
  BUBBLE_MOVE_SPEED_PX,
  BUBBLE_SUFFOCATE_TICKS,
  BUBBLE_TOUCH_OVERLAP_PX2,
  CELL_SIZE,
  DEVIL_DURATION_TICKS,
  DIR_DX,
  DIR_DY,
  Direction,
  GameMode,
  GRID_COLS,
  GRID_ROWS,
  THROW_STEP_STAGE1,
  THROW_Y_STAGE1,
  anchorToCol,
  anchorToRow,
  cellToAnchorX,
  cellToAnchorY,
} from "../constants.ts";
import type { BomberCharacterAttr, ItemAttrEntry, ParsedGameMap, ShipAttr } from "../formats/gameData.ts";
import type { ObjectTemplateEntry, TileInfoDesc } from "../formats/objectTable.ts";
import { EMPTY_EQUIPPED, type EquippedAvatar, type RoomSlotDTO } from "../protocol.ts";

/** Deterministic Mulberry32 PRNG so client & server produce identical item drops */
export class DeterministicRNG {
  private state: number;
  constructor(seed: number) {
    this.state = seed >>> 0 || 0x12345678;
  }
  nextU32(): number {
    let t = (this.state += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0);
  }
  nextFloat(): number {
    return this.nextU32() / 4294967296;
  }
  nextInt(maxExclusive: number): number {
    if (maxExclusive <= 1) return 0;
    return this.nextU32() % maxExclusive;
  }
}

export const enum BomberStatus {
  SpawnInvuln = 0,
  Normal = 1,
  Jumping = 2,
  Trapped = 3,
  Dying = 4,
  Dead = 5,
  Ghost = 6,
  Victory = 7,
}

export const enum ActiveItemKind {
  None = 0,
  Needle = 1, // ItemNiddle / SJNeedle / CokeNeedle
  Dart = 2, // CGODart
  Spring = 3, // Spring jump
  Shield = 4, // Shield invulnerability
  Remote = 5, // Radio bomb trigger
  Radar = 6, // Reveals hidden items in blocks
  TankShot = 7, // Tank cannon
}

export interface SimBomber {
  slotIndex: number;
  userId: number;
  nickname: string;
  isBot: boolean;
  isLocal2P: boolean;
  team: number;
  charIndex: number;
  equipped: EquippedAvatar;

  // Pixel anchor coordinates: x in [0, 560], y in [39, 559] (cell anchor = (40*col, 40*row+39))
  prevX: number;
  prevY: number;
  x: number;
  y: number;
  zOffset: number; // vertical arc for jump / mount
  dir: Direction;
  moving: boolean;
  animTick: number;

  status: BomberStatus;
  statusTicks: number;
  trappedBySlot: number;

  // Core CA.exe stats (BomberAttr)
  bombsInit: number;
  bombsCur: number;
  bombsMax: number;
  powerInit: number;
  powerCur: number;
  powerMax: number;
  speedInit: number;
  speedCur: number;
  speedMax: number;
  speedDevilMax: number;

  // Abilities & mounts
  canKick: boolean;
  canThrow: boolean;
  mountType: number; // -1 = none, 0=Owl, 1=Turtle, 2=UFO, 3=Tank, 4=SuperTurtle
  mountSpeed: number;
  devilTicks: number;
  shieldTicks: number;
  supermanTicks: number;
  invulnTicks: number;
  warpCooldownTicks: number;
  pushHoldTicks: number;
  pushDir: Direction;

  // Jump state (Spring)
  jumpStartX: number;
  jumpStartY: number;
  jumpTargetX: number;
  jumpTargetY: number;
  jumpTotalTicks: number;

  // Active item slots (0 = Ctrl, 1 = Alt)
  ctrlItem: ActiveItemKind;
  ctrlCount: number;
  altItem: ActiveItemKind;
  altCount: number;

  // Mode-specific flags (Captain crown, Timebomb holder, Hedgehog, Kart lap/checkpoint)
  isCaptain: boolean;
  hasTimebomb: boolean;
  timebombTicks: number;
  isHedgehog: boolean;
  kartLap: number;
  kartCheckpoint: number;
  kartNitroTicks: number;

  // Match stats & collected items (scattered on suffocation per sub_586BC9)
  kills: number;
  saves: number;
  blocksDestroyed: number;
  bonusLucci: number;
  pickedUpItems: string[];
}

export interface SimBomb {
  uid: number;
  ownerSlot: number;
  row: number;
  col: number;
  prevX: number;
  prevY: number;
  x: number;
  y: number;
  zOffset: number;
  power: number;
  fuseTicks: number;
  maxFuseTicks: number;
  isRemote: boolean;
  bombSkin: number;
  /** Bitmask of bomber slots (1 << slot) that were overlapping when bomb was placed */
  passableMask: number;

  // Kick slide state (sub_442948)
  kickedDir: Direction;
  kickerSlot: number;

  // Throw lob state (sub_442BF1 / sub_443339)
  lobTicks: number;
  lobTotalTicks: number;
  lobStartX: number;
  lobStartY: number;
  lobTargetRow: number;
  lobTargetCol: number;
  lobDir: Direction;
}

export interface SimFlame {
  uid: number;
  ownerSlot: number;
  row: number;
  col: number;
  /** 0=Center, 1=MidLeft, 2=EndLeft, 3=MidUp, 4=EndUp, 5=MidRight, 6=EndRight, 7=MidDown, 8=EndDown */
  part: number;
  /**
   * Tile distance from the bomb (1..10). flame/flame exposes one state per reach
   * ("FireL01" .. "FireL10"), so the renderer needs this to pick the right one --
   * the centre cell carries the bomb's full power instead.
   */
  step: number;
  ticksLeft: number;
  totalTicks: number;
}

/**
 * Flame lifetime in ticks. flame/flame's states are all exactly 19 ticks long
 * (frames 0..18: the burst, then the 60..96 dissipation tail), and the object is
 * destroyed when its animation finishes -- so 19 is the authentic duration.
 */
export const FLAME_LIFETIME_TICKS = 19;

export interface SimGroundItem {
  uid: number;
  itemName: string; // e.g. "Item/ItemBomb", "Item/ItemWater", "Item/ItemSkate"...
  templateName: string;
  row: number;
  col: number;
  spawnGraceTicks: number;
  animTick: number;
}

export interface SimMeltingBlock {
  row: number;
  col: number;
  templateId: number;
  ticksLeft: number;
  dropItemName: string | null;
  destroyerSlot: number;
}

export interface SimPushingBlock {
  fromRow: number;
  fromCol: number;
  toRow: number;
  toCol: number;
  templateId: number;
  ticksLeft: number;
  totalTicks: number;
}

export interface SimDart {
  uid: number;
  ownerSlot: number;
  x: number;
  y: number;
  dir: Direction;
  ticksLeft: number;
}

/**
 * Real ObjectTable templates for every monster kind the sim can spawn.
 *
 * The map files only ever name "InnerSoul" / "OuterSoul", which are C++ classes
 * (CGOInnerSoul / CGOOuterSoul), not sprite paths -- CA.exe resolves them in
 * sub_4FC366 -> "Game/Mummy" (Game/Mst_N_*) and sub_4FCCBD -> "Game/BulaBat"
 * (Game/Mst_T_*). The hand-written names "Game/MonPenguin", "Game/MonBasic" and
 * "Game/Rabbit" that used to be here do not exist in ObjectTable at all, so every
 * monster fell back to a placeholder sprite.
 */
export const MONSTER_TEMPLATE_BY_KIND: Readonly<Record<string, string>> = {
  innersoul: "Game/Mummy",
  outersoul: "Game/BulaBat",
  monpenguinboss: "Game/PenguinMon",
  monnpc: "Game/SmallMonster",
  goldrabbit: "Game/Rabbit01",
  whiterabbit: "Game/Rabbit00",
};

export function resolveMonsterTemplate(kind: string): string {
  return MONSTER_TEMPLATE_BY_KIND[kind.toLowerCase()] ?? "Game/SmallMonster";
}

export interface SimMonster {
  uid: number;
  name: string;
  templateName: string;
  prevX: number;
  prevY: number;
  x: number;
  y: number;
  dir: Direction;
  hp: number;
  maxHp: number;
  speed: number;
  isBoss: boolean;
  trappedTicks: number;
  invulnTicks: number;
  aiTick: number;
  alive: boolean;
}

export interface SimSoundEvent {
  sfxId: number; // Index into SFX_WAVE_PATHS (0..142)
}

export interface StaticMapData {
  bombers: BomberCharacterAttr[];
  items: Map<string, ItemAttrEntry>;
  ships: ShipAttr[];
  fxTemplates: ObjectTemplateEntry[];
  tileInfos: Map<string, TileInfoDesc>;
}

export interface PlayerInputState {
  dir: Direction;
  placeBomb: boolean;
  useCtrl: boolean;
  useAlt: boolean;
}

export class GameWorld {
  public readonly mode: GameMode;
  public readonly map: ParsedGameMap;
  public readonly staticData: StaticMapData;
  public readonly rng: DeterministicRNG;

  public tick = 0;
  public timeRemainingTicks: number;
  public suddenDeathActive = false;
  public redZoneRing = 0;

  // Grid layers (13 * 15 = 195)
  public readonly groundIds: Int32Array;
  public readonly objectIds: Int32Array;
  public readonly solidGrid: Uint8Array;
  public readonly indestructGrid: Uint8Array;
  public readonly pushableGrid: Uint8Array;
  public readonly bushGrid: Uint8Array;
  public readonly redZoneGrid: Uint8Array;
  public readonly hiddenItemPool: string[] = [];

  public readonly bombers: SimBomber[] = [];
  public readonly bombs: SimBomb[] = [];
  public readonly flames: SimFlame[] = [];
  public readonly items: SimGroundItem[] = [];
  public readonly meltingBlocks: SimMeltingBlock[] = [];
  public readonly pushingBlocks: SimPushingBlock[] = [];
  public readonly darts: SimDart[] = [];
  public readonly monsters: SimMonster[] = [];
  public readonly soundEvents: SimSoundEvent[] = [];

  private nextUid = 1;
  public finished = false;
  public finishDelayTicks = 0;
  public winningTeam = -1; // -1 = draw, >=0 = winning team orFFA slot+100

  constructor(
    mode: GameMode,
    map: ParsedGameMap,
    slots: RoomSlotDTO[],
    seed: number,
    staticData: StaticMapData,
  ) {
    this.mode = mode;
    this.map = map;
    this.staticData = staticData;
    this.rng = new DeterministicRNG(seed);

    this.timeRemainingTicks = Math.max(60, map.timeLimitSec) * 33;
    this.groundIds = new Int32Array(map.groundIds);
    this.objectIds = new Int32Array(map.objectIds);
    this.solidGrid = new Uint8Array(GRID_ROWS * GRID_COLS);
    this.indestructGrid = new Uint8Array(GRID_ROWS * GRID_COLS);
    this.pushableGrid = new Uint8Array(GRID_ROWS * GRID_COLS);
    this.bushGrid = new Uint8Array(GRID_ROWS * GRID_COLS);
    this.redZoneGrid = new Uint8Array(GRID_ROWS * GRID_COLS);

    this.rebuildTileFlags();
    this.initItemPool();
    this.initBombers(slots);
    this.initModeEntities();
  }

  private allocUid(): number {
    return this.nextUid++;
  }

  public cellIdx(row: number, col: number): number {
    return row * GRID_COLS + col;
  }

  public inBounds(row: number, col: number): boolean {
    return row >= 0 && row < GRID_ROWS && col >= 0 && col < GRID_COLS;
  }

  public rebuildTileFlags(): void {
    this.solidGrid.fill(0);
    this.indestructGrid.fill(0);
    this.pushableGrid.fill(0);
    this.bushGrid.fill(0);

    for (let r = 0; r < GRID_ROWS; r++) {
      for (let c = 0; c < GRID_COLS; c++) {
        const idx = this.cellIdx(r, c);
        const objId = this.objectIds[idx]!;
        if (objId < 0) continue;
        const tpl = this.staticData.fxTemplates[objId];
        if (!tpl) continue;
        const ti =
          this.staticData.tileInfos.get(tpl.name) ??
          this.staticData.tileInfos.get(tpl.name.toLowerCase());
        if (!ti) {
          // Fallback by folder prefix if missing from TileInfoList
          const lower = tpl.name.toLowerCase();
          if (lower.includes("bush")) {
            this.bushGrid[idx] = 1;
          } else if (lower.includes("passble") || lower.includes("passable") || lower.includes("ground")) {
            // passable
          } else if (lower.includes("box")) {
            this.solidGrid[idx] = 1;
            if (lower.includes("gray") || lower.includes("push") || lower.includes("move")) {
              this.pushableGrid[idx] = 1;
            }
          } else {
            this.solidGrid[idx] = 1;
            this.indestructGrid[idx] = 1;
          }
          continue;
        }

        if (ti.isBush) {
          this.bushGrid[idx] = 1;
        }
        if (ti.isPushable) {
          this.pushableGrid[idx] = 1;
        }

        // Multi-tile footprint (sub_4E5845 L222815: anchor at bottom-left (r, c), spans up by spanRows & right by spanCols)
        const rStart = Math.max(0, r - ti.spanRows + 1);
        const cEnd = Math.min(GRID_COLS - 1, c + ti.spanCols - 1);
        for (let rr = rStart; rr <= r; rr++) {
          for (let cc = c; cc <= cEnd; cc++) {
            const subIdx = this.cellIdx(rr, cc);
            if (ti.isSolid) this.solidGrid[subIdx] = 1;
            if (ti.isIndestructible) this.indestructGrid[subIdx] = 1;
          }
        }
      }
    }
  }

  private initItemPool(): void {
    // Populate fixed items first
    for (const fi of this.map.fixedItems) {
      if (this.inBounds(fi.row, fi.col) && this.solidGrid[this.cellIdx(fi.row, fi.col)] === 0) {
        this.spawnGroundItem(fi.itemName, fi.row, fi.col);
      }
    }

    // Build weighted pool from Map.itemPool, or fallback standard BnB item pool if empty
    if (this.map.itemPool.length > 0) {
      for (const entry of this.map.itemPool) {
        for (let i = 0; i < entry.count; i++) {
          this.hiddenItemPool.push(entry.itemName);
        }
      }
    } else {
      // Exactly the Attr/ItemAttr "name" column from Fx.idd so every pickup
      // resolves to a real ObjectTable template (Item/*) and renders natively.
      const defaults: [string, number][] = [
        ["Item/ItemBomb", 14],
        ["Item/ItemPotion", 12],
        ["Item/ItemRoller", 12],
        ["Item/ItemMaxPower", 3],
        ["RedDevil", 2],
        ["Item/ItemShoe", 4],
        ["Item/ItemPunch", 2],
        ["Item/ItemNiddle", 3],
        ["Item/ItemDart", 2],
        ["Spring", 2],
        ["Item/ItemShield", 2],
        ["Item/ItemOwl", 2],
        ["Item/ItemTurtle0", 2],
        ["Item/ItemAirship", 1],
        ["LucciSilver", 6],
        ["LucciGold", 4],
      ];
      for (const [name, cnt] of defaults) {
        for (let i = 0; i < cnt; i++) this.hiddenItemPool.push(name);
      }
    }

    // Fisher-Yates shuffle with deterministic RNG
    for (let i = this.hiddenItemPool.length - 1; i > 0; i--) {
      const j = this.rng.nextInt(i + 1);
      const tmp = this.hiddenItemPool[i]!;
      this.hiddenItemPool[i] = this.hiddenItemPool[j]!;
      this.hiddenItemPool[j] = tmp;
    }
  }

  private resolveCharacterAttr(charIndex: number): BomberCharacterAttr {
    const effective = Math.max(0, Math.min(10, charIndex));
    const found = this.staticData.bombers[effective];
    return (
      found ??
      this.staticData.bombers[0] ?? {
        index: 0,
        rawId: "Character/C00",
        codeName: "Dao",
        prepareImage: "Prepare/C00",
        displayImage: "Character/C00_Display",
        portraitImage: "Character/C00_Portrait",
        emotionImage: "Character/C00_Emotion",
        category: 0,
        bombsInit: 1,
        bombsMax: 10,
        powerInit: 1,
        powerMax: 7,
        speedInit: 5,
        speedMax: 7,
        extra0: 10,
        extra1: 100,
        extra2: 9,
      }
    );
  }

  private initBombers(slots: RoomSlotDTO[]): void {
    const defaultSpawns: [number, number][] = [
      [1, 1],
      [1, 13],
      [11, 1],
      [11, 13],
      [1, 7],
      [11, 7],
      [6, 1],
      [6, 13],
    ];

    for (let i = 0; i < slots.length; i++) {
      const s = slots[i]!;
      if (s.state !== "human" && s.state !== "bot") continue;

      const sp = this.map.spawns[i % Math.max(1, this.map.spawns.length)] ?? {
        row: defaultSpawns[i % 8]![0],
        col: defaultSpawns[i % 8]![1],
      };

      // Clear spawn cell & immediate orthogonal neighbor if covered by soft block
      this.clearSoftBlockAt(sp.row, sp.col);

      const resolvedChar = s.charIndex === 8 ? this.rng.nextInt(8) : s.charIndex;
      const attr = this.resolveCharacterAttr(resolvedChar);
      const startX = cellToAnchorX(sp.col);
      const startY = cellToAnchorY(sp.row);
      this.bombers.push({
        slotIndex: s.slotIndex,
        userId: s.userId,
        nickname: s.nickname,
        isBot: s.state === "bot",
        isLocal2P: s.isLocal2P,
        team: s.team,
        charIndex: resolvedChar,
        equipped: s.equipped ?? EMPTY_EQUIPPED,
        prevX: startX,
        prevY: startY,
        x: startX,
        y: startY,
        zOffset: 0,
        dir: Direction.Down,
        moving: false,
        animTick: 0,
        status: BomberStatus.SpawnInvuln,
        statusTicks: 45, // 1.35s spawn protection
        trappedBySlot: -1,
        bombsInit: Math.max(1, attr.bombsInit),
        bombsCur: Math.max(1, attr.bombsInit),
        bombsMax: Math.max(1, attr.bombsMax),
        powerInit: Math.max(1, attr.powerInit),
        powerCur: Math.max(1, attr.powerInit),
        powerMax: Math.max(1, attr.powerMax),
        speedInit: Math.max(4, attr.speedInit),
        speedCur: Math.max(4, attr.speedInit),
        speedMax: Math.max(6, attr.speedMax),
        speedDevilMax: Math.max(attr.speedMax, attr.extra2 || 9),
        canKick: false,
        canThrow: false,
        mountType: this.mode === GameMode.Kart ? 2 : -1,
        mountSpeed: this.mode === GameMode.Kart ? 9 : 0,
        devilTicks: 0,
        shieldTicks: 0,
        supermanTicks: 0,
        invulnTicks: 45,
        warpCooldownTicks: 0,
        pushHoldTicks: 0,
        pushDir: Direction.None,
        jumpStartX: 0,
        jumpStartY: 0,
        jumpTargetX: 0,
        jumpTargetY: 0,
        jumpTotalTicks: 0,
        ctrlItem: ActiveItemKind.Needle,
        ctrlCount: 1, // Starter needle for snappy gameplay + shop needles add more
        altItem: ActiveItemKind.None,
        altCount: 0,
        isCaptain: false,
        hasTimebomb: false,
        timebombTicks: 0,
        isHedgehog: false,
        kartLap: 0,
        kartCheckpoint: 0,
        kartNitroTicks: 0,
        kills: 0,
        saves: 0,
        blocksDestroyed: 0,
        bonusLucci: 0,
        pickedUpItems: [],
      });
    }
  }

  private clearSoftBlockAt(row: number, col: number): void {
    if (!this.inBounds(row, col)) return;
    const idx = this.cellIdx(row, col);
    if (this.solidGrid[idx] !== 0 && this.indestructGrid[idx] === 0) {
      this.objectIds[idx] = -1;
      this.solidGrid[idx] = 0;
      this.pushableGrid[idx] = 0;
    }
  }

  private initModeEntities(): void {
    if (this.mode === GameMode.Captain) {
      // First player on each team is Captain!
      const seenTeams = new Set<number>();
      for (const b of this.bombers) {
        if (!seenTeams.has(b.team)) {
          seenTeams.add(b.team);
          b.isCaptain = true;
        }
      }
    } else if (this.mode === GameMode.Timebomb && this.bombers.length > 0) {
      const idx = this.rng.nextInt(this.bombers.length);
      const holder = this.bombers[idx]!;
      holder.hasTimebomb = true;
      holder.timebombTicks = 15 * 33; // 15 seconds hot-potato countdown
    } else if (this.mode === GameMode.Bonus) {
      // Scatter bonus coins across open cells
      for (let r = 0; r < GRID_ROWS; r++) {
        for (let c = 0; c < GRID_COLS; c++) {
          const idx = this.cellIdx(r, c);
          if (this.solidGrid[idx] === 0 && this.rng.nextInt(3) === 0) {
            const coin = this.rng.nextInt(4) === 0 ? "Item/CoinGold" : "Item/CoinSilver";
            this.spawnGroundItem(coin, r, c);
          }
        }
      }
      this.timeRemainingTicks = 45 * 33;
    } else if (this.mode === GameMode.Monster || this.map.monsters.length > 0) {
      if (this.map.monsters.length > 0) {
        for (const ms of this.map.monsters) {
          const isBoss = ms.monsterName.toLowerCase().includes("boss") || ms.monsterName.toLowerCase().includes("seal") || ms.monsterName.toLowerCase().includes("penguin");
          this.monsters.push({
            uid: this.allocUid(),
            name: ms.monsterName,
            templateName: resolveMonsterTemplate(ms.monsterName),
            prevX: cellToAnchorX(ms.col),
            prevY: cellToAnchorY(ms.row),
            x: cellToAnchorX(ms.col),
            y: cellToAnchorY(ms.row),
            dir: Direction.Down,
            hp: isBoss ? 5 : 1,
            maxHp: isBoss ? 5 : 1,
            speed: isBoss ? 3 : 2,
            isBoss,
            trappedTicks: 0,
            invulnTicks: 0,
            aiTick: 0,
            alive: true,
          });
        }
      } else if (this.mode === GameMode.Monster) {
        // Spawn classic StageClear monsters on open corners opposite players
        const spots: [number, number, boolean][] = [
          [6, 7, true],
          [3, 7, false],
          [9, 7, false],
          [6, 4, false],
          [6, 10, false],
        ];
        for (const [mr, mc, boss] of spots) {
          this.clearSoftBlockAt(mr, mc);
          this.monsters.push({
            uid: this.allocUid(),
            name: boss ? "MonPenguinBoss" : "MonNpc",
            templateName: resolveMonsterTemplate(boss ? "MonPenguinBoss" : "MonNpc"),
            prevX: cellToAnchorX(mc),
            prevY: cellToAnchorY(mr),
            x: cellToAnchorX(mc),
            y: cellToAnchorY(mr),
            dir: Direction.Down,
            hp: boss ? 5 : 1,
            maxHp: boss ? 5 : 1,
            speed: boss ? 3 : 2,
            isBoss: boss,
            trappedTicks: 0,
            invulnTicks: 0,
            aiTick: 0,
            alive: true,
          });
        }
      }
    } else if (this.mode === GameMode.RabbitCatch) {
      // Spawn golden/white rabbits to catch!
      for (let i = 0; i < 6; i++) {
        const rr = 2 + this.rng.nextInt(GRID_ROWS - 4);
        const cc = 2 + this.rng.nextInt(GRID_COLS - 4);
        this.clearSoftBlockAt(rr, cc);
        this.monsters.push({
          uid: this.allocUid(),
          name: i === 0 ? "GoldRabbit" : "WhiteRabbit",
          templateName: resolveMonsterTemplate(i === 0 ? "GoldRabbit" : "WhiteRabbit"),
          prevX: cellToAnchorX(cc),
          prevY: cellToAnchorY(rr),
          x: cellToAnchorX(cc),
          y: cellToAnchorY(rr),
          dir: (i % 4) as Direction,
          hp: 1,
          maxHp: 1,
          speed: i === 0 ? 5 : 3,
          isBoss: false,
          trappedTicks: 0,
          invulnTicks: 0,
          aiTick: 0,
          alive: true,
        });
      }
    }
  }

  public areAllies(a: SimBomber, b: SimBomber): boolean {
    if (a.slotIndex === b.slotIndex) return true;
    if (this.mode === GameMode.Monster || this.mode === GameMode.Bonus) return true;
    // Team 0..7: if two distinct players share the same team color AND not everyone is same color -> allies!
    const distinctTeams = new Set(this.bombers.map((p) => p.team));
    if (distinctTeams.size >= 2 && a.team === b.team) {
      return true;
    }
    return false;
  }

  public emitSound(sfxId: number): void {
    this.soundEvents.push({ sfxId });
  }

  /**
   * Exact port of CGOBomber::sub_44A30F + sub_4447B5:
   * Returns pixel step per 30 ms tick.
   */
  public getBomberStepPixels(b: SimBomber): number {
    if (
      b.status === BomberStatus.Dying ||
      b.status === BomberStatus.Dead ||
      b.status === BomberStatus.Victory
    ) {
      return 0;
    }
    if (b.status === BomberStatus.Trapped) {
      return BUBBLE_MOVE_SPEED_PX; // 2 px/tick
    }
    if (b.status === BomberStatus.Ghost) {
      return 4;
    }
    if (b.mountType >= 0) {
      let s = b.mountSpeed;
      if (b.kartNitroTicks > 0) s = Math.min(14, s + 4);
      return s;
    }
    if (b.supermanTicks > 0 || b.devilTicks > 0) {
      return b.speedMax;
    }
    return b.speedCur;
  }

  public getActiveBombCount(slotIndex: number): number {
    let cnt = 0;
    for (const bomb of this.bombs) {
      if (bomb.ownerSlot === slotIndex) cnt++;
    }
    return cnt;
  }

  public findBombAt(row: number, col: number): SimBomb | undefined {
    return this.bombs.find((b) => b.lobTicks === 0 && b.row === row && b.col === col);
  }

  public isCellBlockedForBomber(b: SimBomber, row: number, col: number): boolean {
    if (!this.inBounds(row, col)) return true;
    if (b.status === BomberStatus.Ghost) return false;

    const idx = this.cellIdx(row, col);
    // UFO mount (mountType === 2) flies over soft blocks & bombs (stopped only by indestructible high walls)
    if (b.mountType === 2) {
      return this.indestructGrid[idx] !== 0 && this.pushableGrid[idx] === 0;
    }

    if (this.solidGrid[idx] !== 0) return true;

    const bomb = this.findBombAt(row, col);
    if (bomb) {
      if ((bomb.passableMask & (1 << b.slotIndex)) !== 0) {
        return false;
      }
      return true;
    }
    return false;
  }

  /**
   * Exact port of CA.exe CCollisionDetect (sub_44FED9 + sub_44D146 + sub_44ED88 + sub_44EF3A)
   * including the exact +14 / +26 corner-sliding thresholds!
   */
  public moveBomberWithCornerSlide(b: SimBomber, rawDir: Direction, totalPx: number): void {
    if (rawDir === Direction.None || totalPx <= 0) return;

    // Devil reverses controls (sub_44FED9 L94851: n3 = (n3 + 2) % 4)
    const dir = b.devilTicks > 0 ? (((rawDir + 2) % 4) as Direction) : rawDir;
    b.dir = dir;

    let rem = totalPx;
    let guard = 0;

    while (rem > 0 && guard++ < 4) {
      const moved = this.stepAxisAligned(b, dir, rem);
      rem -= moved;
      if (rem <= 0) break;

      // Blocked! Attempt kick / block-push or corner slide
      const curCol = anchorToCol(b.x);
      const curRow = anchorToRow(b.y);
      const nextCol = curCol + DIR_DX[dir]!;
      const nextRow = curRow + DIR_DY[dir]!;

      // Kick bomb check (ItemShoe)
      if (b.status === BomberStatus.Normal && b.canKick && b.mountType < 0) {
        const hitBomb = this.findBombAt(nextRow, nextCol);
        if (hitBomb && (hitBomb.passableMask & (1 << b.slotIndex)) === 0 && hitBomb.kickedDir === Direction.None) {
          const afterR = nextRow + DIR_DY[dir]!;
          const afterC = nextCol + DIR_DX[dir]!;
          if (this.canBombEnterCell(afterR, afterC)) {
            hitBomb.kickedDir = dir;
            hitBomb.kickerSlot = b.slotIndex;
            this.emitSound(30); // UseMotor / Kick
          }
        }
      }

      // Pushable block hold check (sub_4ECD11)
      if (
        b.status === BomberStatus.Normal &&
        b.mountType < 0 &&
        this.inBounds(nextRow, nextCol) &&
        this.pushableGrid[this.cellIdx(nextRow, nextCol)] !== 0
      ) {
        if (b.pushDir === dir) {
          b.pushHoldTicks++;
          if (b.pushHoldTicks >= 8) {
            b.pushHoldTicks = 0;
            this.tryPushBlock(nextRow, nextCol, dir);
          }
        } else {
          b.pushDir = dir;
          b.pushHoldTicks = 1;
        }
      }

      // Corner sliding (sub_44ED88 horizontal / sub_44EF3A vertical)
      if (dir === Direction.Left || dir === Direction.Right) {
        const targetCol = dir === Direction.Left ? Math.floor((b.x - 1) / CELL_SIZE) : Math.floor((b.x + CELL_SIZE) / CELL_SIZE);
        if (targetCol < 0 || targetCol >= GRID_COLS) break;
        const yTop = b.y - 39;
        const rTop = Math.floor(yTop / CELL_SIZE);
        const rBot = Math.floor((yTop + CELL_SIZE - 1) / CELL_SIZE);
        if (rTop === rBot) break;

        const blockTop = this.isCellBlockedForBomber(b, rTop, targetCol);
        const blockBot = this.isCellBlockedForBomber(b, rBot, targetCol);
        if (blockTop && blockBot) break;

        if (!blockTop && blockBot) {
          // Slide UP if yTop + 30 < 40 * rBot + 14 (sub_44ED88 L94111)
          if (yTop + 30 < CELL_SIZE * rBot + 14) {
            const slideReq = Math.min(rem, yTop - CELL_SIZE * rTop);
            if (slideReq <= 0) break;
            const slid = this.stepAxisAligned(b, Direction.Up, slideReq);
            if (slid <= 0) break;
            rem -= slid;
            this.updateBombPassabilityForBomber(b);
            continue;
          }
        } else if (blockTop && !blockBot) {
          // Slide DOWN if yTop + 30 >= 40 * rTop + 26 (sub_44ED88 L94124)
          if (yTop + 30 >= CELL_SIZE * rTop + 26) {
            const slideReq = Math.min(rem, CELL_SIZE * rBot - yTop);
            if (slideReq <= 0) break;
            const slid = this.stepAxisAligned(b, Direction.Down, slideReq);
            if (slid <= 0) break;
            rem -= slid;
            this.updateBombPassabilityForBomber(b);
            continue;
          }
        }
        break;
      } else {
        const yTop = b.y - 39;
        const targetRow = dir === Direction.Up ? Math.floor((yTop - 1) / CELL_SIZE) : Math.floor((yTop + CELL_SIZE) / CELL_SIZE);
        if (targetRow < 0 || targetRow >= GRID_ROWS) break;
        const xLeft = b.x;
        const cLeft = Math.floor(xLeft / CELL_SIZE);
        const cRight = Math.floor((xLeft + CELL_SIZE - 1) / CELL_SIZE);
        if (cLeft === cRight) break;

        const blockLeft = this.isCellBlockedForBomber(b, targetRow, cLeft);
        const blockRight = this.isCellBlockedForBomber(b, targetRow, cRight);
        if (blockLeft && blockRight) break;

        if (!blockLeft && blockRight) {
          // Slide LEFT if xLeft + 20 < 40 * cRight + 14 (sub_44EF3A L94202)
          if (xLeft + 20 < CELL_SIZE * cRight + 14) {
            const slideReq = Math.min(rem, xLeft - CELL_SIZE * cLeft);
            if (slideReq <= 0) break;
            const slid = this.stepAxisAligned(b, Direction.Left, slideReq);
            if (slid <= 0) break;
            rem -= slid;
            this.updateBombPassabilityForBomber(b);
            continue;
          }
        } else if (blockLeft && !blockRight) {
          // Slide RIGHT if xLeft + 20 >= 40 * cLeft + 26 (sub_44EF3A L94213)
          if (xLeft + 20 >= CELL_SIZE * cLeft + 26) {
            const slideReq = Math.min(rem, CELL_SIZE * cRight - xLeft);
            if (slideReq <= 0) break;
            const slid = this.stepAxisAligned(b, Direction.Right, slideReq);
            if (slid <= 0) break;
            rem -= slid;
            this.updateBombPassabilityForBomber(b);
            continue;
          }
        }
        break;
      }
    }

    // Update bomb passability masks when bomber steps off a bomb cell
    this.updateBombPassabilityForBomber(b);
  }

  private stepAxisAligned(b: SimBomber, dir: Direction, maxPx: number): number {
    let moved = 0;
    for (let step = 0; step < maxPx; step++) {
      const nx = b.x + DIR_DX[dir]!;
      const ny = b.y + DIR_DY[dir]!;
      const yTop = ny - 39;

      // Playfield bounds: x in [0, 560], yTop in [0, 480]
      if (nx < 0 || nx > (GRID_COLS - 1) * CELL_SIZE || yTop < 0 || yTop > (GRID_ROWS - 1) * CELL_SIZE) {
        break;
      }

      const c0 = Math.floor(nx / CELL_SIZE);
      const c1 = Math.floor((nx + CELL_SIZE - 1) / CELL_SIZE);
      const r0 = Math.floor(yTop / CELL_SIZE);
      const r1 = Math.floor((yTop + CELL_SIZE - 1) / CELL_SIZE);

      let blocked = false;
      for (let rr = r0; rr <= r1 && !blocked; rr++) {
        for (let cc = c0; cc <= c1; cc++) {
          if (this.isCellBlockedForBomber(b, rr, cc)) {
            blocked = true;
            break;
          }
        }
      }
      if (blocked) break;
      b.x = nx;
      b.y = ny;
      moved++;
    }
    return moved;
  }

  private updateBombPassabilityForBomber(b: SimBomber): void {
    const bit = 1 << b.slotIndex;
    const bx0 = b.x;
    const by0 = b.y - 39;
    const bx1 = bx0 + CELL_SIZE;
    const by1 = by0 + CELL_SIZE;

    for (const bomb of this.bombs) {
      if ((bomb.passableMask & bit) === 0) continue;
      const cx0 = bomb.col * CELL_SIZE;
      const cy0 = bomb.row * CELL_SIZE;
      const overlaps = bx0 < cx0 + CELL_SIZE && bx1 > cx0 && by0 < cy0 + CELL_SIZE && by1 > cy0;
      if (!overlaps) {
        bomb.passableMask &= ~bit;
      }
    }
  }

  private canBombEnterCell(row: number, col: number): boolean {
    if (!this.inBounds(row, col)) return false;
    const idx = this.cellIdx(row, col);
    if (this.solidGrid[idx] !== 0) return false;
    if (this.findBombAt(row, col)) return false;
    // Check alive bomber occupying cell
    for (const b of this.bombers) {
      if (b.status === BomberStatus.Dead || b.status === BomberStatus.Ghost) continue;
      if (anchorToRow(b.y) === row && anchorToCol(b.x) === col) return false;
    }
    return true;
  }

  public tryPushBlock(row: number, col: number, dir: Direction): boolean {
    const dstR = row + DIR_DY[dir]!;
    const dstC = col + DIR_DX[dir]!;
    if (!this.canBombEnterCell(dstR, dstC)) return false;

    const srcIdx = this.cellIdx(row, col);
    const tplId = this.objectIds[srcIdx]!;
    if (tplId < 0) return false;

    this.objectIds[srcIdx] = -1;
    this.solidGrid[srcIdx] = 0;
    this.pushableGrid[srcIdx] = 0;

    // Reserve destination cell as solid while sliding
    const dstIdx = this.cellIdx(dstR, dstC);
    this.solidGrid[dstIdx] = 1;

    // Crush ground item on destination cell (sub_4ECD11 L229435)
    for (let i = this.items.length - 1; i >= 0; i--) {
      if (this.items[i]!.row === dstR && this.items[i]!.col === dstC) {
        this.items.splice(i, 1);
      }
    }

    this.pushingBlocks.push({
      fromRow: row,
      fromCol: col,
      toRow: dstR,
      toCol: dstC,
      templateId: tplId,
      ticksLeft: BLOCK_PUSH_TICKS,
      totalTicks: BLOCK_PUSH_TICKS,
    });
    this.emitSound(3); // BlockDown / slide
    return true;
  }

  public tryPlaceOrThrowBomb(b: SimBomber): SimBomb | null {
    if (
      b.status !== BomberStatus.Normal &&
      b.status !== BomberStatus.SpawnInvuln
    ) {
      return null;
    }

    const row = anchorToRow(b.y);
    const col = anchorToCol(b.x);
    if (!this.inBounds(row, col)) return null;

    // Glove throw check: if standing on an existing bomb and canThrow -> lob it forward!
    const existing = this.findBombAt(row, col);
    if (existing) {
      if (b.canThrow && existing.lobTicks === 0) {
        let targetR = row;
        let targetC = col;
        for (let step = 3; step <= GRID_COLS; step++) {
          const tr = (row + DIR_DY[b.dir]! * step + GRID_ROWS * 4) % GRID_ROWS;
          const tc = (col + DIR_DX[b.dir]! * step + GRID_COLS * 4) % GRID_COLS;
          if (this.solidGrid[this.cellIdx(tr, tc)] === 0 && !this.findBombAt(tr, tc)) {
            targetR = tr;
            targetC = tc;
            break;
          }
        }
        existing.lobStartX = existing.x;
        existing.lobStartY = existing.y;
        existing.lobTargetRow = targetR;
        existing.lobTargetCol = targetC;
        existing.lobDir = b.dir;
        existing.lobTotalTicks = BOMB_LOB_TICKS;
        existing.lobTicks = 1;
        existing.passableMask = 0;
        this.emitSound(32); // Spring / Throw
      }
      return null;
    }

    if (this.solidGrid[this.cellIdx(row, col)] !== 0) return null;
    if (this.getActiveBombCount(b.slotIndex) >= b.bombsCur) return null;

    // Compute initial passableMask for all bombers currently overlapping this cell
    let mask = 0;
    const cx0 = col * CELL_SIZE;
    const cy0 = row * CELL_SIZE;
    for (const p of this.bombers) {
      if (p.status === BomberStatus.Dead || p.status === BomberStatus.Ghost) continue;
      const px0 = p.x;
      const py0 = p.y - 39;
      if (px0 < cx0 + CELL_SIZE && px0 + CELL_SIZE > cx0 && py0 < cy0 + CELL_SIZE && py0 + CELL_SIZE > cy0) {
        mask |= 1 << p.slotIndex;
      }
    }

    const isRemote = b.ctrlItem === ActiveItemKind.Remote;
    const bomb: SimBomb = {
      uid: this.allocUid(),
      ownerSlot: b.slotIndex,
      row,
      col,
      prevX: cellToAnchorX(col),
      prevY: cellToAnchorY(row),
      x: cellToAnchorX(col),
      y: cellToAnchorY(row),
      zOffset: 0,
      power: b.powerCur,
      fuseTicks: isRemote ? 9999 : BOMB_FUSE_TICKS,
      maxFuseTicks: BOMB_FUSE_TICKS,
      isRemote,
      bombSkin: b.equipped.bombSkin,
      passableMask: mask,
      kickedDir: Direction.None,
      kickerSlot: -1,
      lobTicks: 0,
      lobTotalTicks: 0,
      lobStartX: 0,
      lobStartY: 0,
      lobTargetRow: row,
      lobTargetCol: col,
      lobDir: Direction.None,
    };

    this.bombs.push(bomb);
    this.emitSound(2); // Wave/BombIgnite
    return bomb;
  }

  public useActiveSlot(b: SimBomber, isAlt: boolean): void {
    const kind = isAlt ? b.altItem : b.ctrlItem;
    const count = isAlt ? b.altCount : b.ctrlCount;
    if (kind === ActiveItemKind.None || count <= 0) return;

    const consume = () => {
      if (isAlt) {
        b.altCount--;
        if (b.altCount <= 0) b.altItem = ActiveItemKind.None;
      } else {
        b.ctrlCount--;
        if (b.ctrlCount <= 0) b.ctrlItem = ActiveItemKind.None;
      }
    };

    if (kind === ActiveItemKind.Needle) {
      if (b.status === BomberStatus.Trapped) {
        b.status = BomberStatus.Normal;
        b.statusTicks = 0;
        b.invulnTicks = 20;
        consume();
        this.emitSound(27); // Wave/Release
      }
    } else if (kind === ActiveItemKind.Dart) {
      if (b.status === BomberStatus.Normal || b.status === BomberStatus.SpawnInvuln) {
        this.darts.push({
          uid: this.allocUid(),
          ownerSlot: b.slotIndex,
          x: b.x + 20,
          y: b.y - 19,
          dir: b.dir,
          ticksLeft: 28,
        });
        consume();
        this.emitSound(33);
      }
    } else if (kind === ActiveItemKind.Spring) {
      if (b.status === BomberStatus.Normal || b.status === BomberStatus.SpawnInvuln) {
        const curR = anchorToRow(b.y);
        const curC = anchorToCol(b.x);
        for (let dist = 2; dist >= 1; dist--) {
          const tr = curR + DIR_DY[b.dir]! * dist;
          const tc = curC + DIR_DX[b.dir]! * dist;
          if (this.inBounds(tr, tc) && this.solidGrid[this.cellIdx(tr, tc)] === 0) {
            b.status = BomberStatus.Jumping;
            b.statusTicks = 0;
            b.jumpTotalTicks = 14;
            b.jumpStartX = b.x;
            b.jumpStartY = b.y;
            b.jumpTargetX = cellToAnchorX(tc);
            b.jumpTargetY = cellToAnchorY(tr);
            consume();
            this.emitSound(32); // Wave/Spring
            break;
          }
        }
      }
    } else if (kind === ActiveItemKind.Shield) {
      if (b.status === BomberStatus.Normal) {
        b.shieldTicks = 90; // 2.7s shield
        consume();
        this.emitSound(71); // Wave/ShieldOn
      }
    } else if (kind === ActiveItemKind.Remote) {
      // Detonate oldest remote bomb owned by b
      const rb = this.bombs.find((bm) => bm.ownerSlot === b.slotIndex && bm.isRemote && bm.lobTicks === 0);
      if (rb) {
        this.detonateBombChain(rb);
      }
    }
  }

  /**
   * Exact port of CGameMap::sub_4E6AB4 chain-explosion solver!
   * Simultaneously resolves all chained bombs, spawns directional flames,
   * destroys soft blocks (queuing item drops), and burns exposed ground items.
   */
  public detonateBombChain(rootBomb: SimBomb): void {
    const queue: SimBomb[] = [rootBomb];
    const explodedUids = new Set<number>([rootBomb.uid]);
    const blockHitCells = new Map<number, number>(); // cellIdx -> ownerSlot
    const flameMap = new Map<number, { part: number; step: number; ownerSlot: number }>();

    while (queue.length > 0) {
      const bomb = queue.shift()!;
      const idx = this.bombs.indexOf(bomb);
      if (idx >= 0) this.bombs.splice(idx, 1);

      const centerIdx = this.cellIdx(bomb.row, bomb.col);
      const prevCenter = flameMap.get(centerIdx);
      flameMap.set(centerIdx, {
        part: 0,
        step: Math.max(prevCenter?.step ?? 0, bomb.power),
        ownerSlot: bomb.ownerSlot,
      });

      for (let d = 0; d < 4; d++) {
        const dx = DIR_DX[d]!;
        const dy = DIR_DY[d]!;
        for (let step = 1; step <= bomb.power; step++) {
          const r = bomb.row + dy * step;
          const c = bomb.col + dx * step;
          if (!this.inBounds(r, c)) break;

          const cIdx = this.cellIdx(r, c);
          if (this.solidGrid[cIdx] !== 0) {
            if (this.indestructGrid[cIdx] === 0 && !blockHitCells.has(cIdx)) {
              blockHitCells.set(cIdx, bomb.ownerSlot);
            }
            break; // Solid block stops flame ray
          }

          // Chain-detonate any bomb sitting on (r, c)
          for (const other of this.bombs) {
            if (other.lobTicks === 0 && other.row === r && other.col === c && !explodedUids.has(other.uid)) {
              explodedUids.add(other.uid);
              queue.push(other);
            }
          }

          const isEnd = step === bomb.power;
          const part = 1 + d * 2 + (isEnd ? 1 : 0);
          const prev = flameMap.get(cIdx);
          if (prev) {
            // Two rays crossing on this cell: the original renders the crossing as a
            // centre-style burst, keeping the longest reach of the two.
            flameMap.set(cIdx, {
              part: 0,
              step: Math.max(prev.step, step),
              ownerSlot: prev.ownerSlot,
            });
          } else {
            flameMap.set(cIdx, { part, step, ownerSlot: bomb.ownerSlot });
          }
        }
      }
    }

    // Spawn flames (FLAME_LIFETIME_TICKS = the native flame/flame animation length)
    for (const [cIdx, info] of flameMap) {
      const r = Math.floor(cIdx / GRID_COLS);
      const c = cIdx % GRID_COLS;
      this.flames.push({
        uid: this.allocUid(),
        ownerSlot: info.ownerSlot,
        row: r,
        col: c,
        part: info.part,
        step: info.step,
        ticksLeft: FLAME_LIFETIME_TICKS,
        totalTicks: FLAME_LIFETIME_TICKS,
      });

      // Burn ground items past spawn grace
      for (let i = this.items.length - 1; i >= 0; i--) {
        const it = this.items[i]!;
        if (it.row === r && it.col === c && it.spawnGraceTicks <= 0) {
          this.items.splice(i, 1);
        }
      }
    }

    // Queue soft blocks to melt & drop items
    for (const [cIdx, destroyerSlot] of blockHitCells) {
      const r = Math.floor(cIdx / GRID_COLS);
      const c = cIdx % GRID_COLS;
      const tplId = this.objectIds[cIdx]!;
      if (tplId < 0) continue;

      this.objectIds[cIdx] = -1;
      // Keep solid until melt finishes (14 ticks)
      let dropItemName: string | null = null;
      const roll = this.rng.nextInt(1000);
      const threshold = this.map.dropRatePermille > 0 ? this.map.dropRatePermille : 480;
      if (roll < threshold && this.hiddenItemPool.length > 0) {
        dropItemName = this.hiddenItemPool.pop()!;
      }

      const ownerBomber = this.bombers.find((b) => b.slotIndex === destroyerSlot);
      if (ownerBomber) ownerBomber.blocksDestroyed++;

      this.meltingBlocks.push({
        row: r,
        col: c,
        templateId: tplId,
        ticksLeft: BLOCK_DESTROY_TICKS,
        dropItemName,
        destroyerSlot,
      });
    }

    this.emitSound(1); // Wave/BombExplode
  }

  public spawnGroundItem(itemName: string, row: number, col: number): SimGroundItem {
    const attr =
      this.staticData.items.get(itemName) ??
      this.staticData.items.get(itemName.toLowerCase());
    const templateName = attr?.templateName ?? itemName;
    const it: SimGroundItem = {
      uid: this.allocUid(),
      itemName,
      templateName,
      row,
      col,
      spawnGraceTicks: 10,
      animTick: 0,
    };
    this.items.push(it);
    return it;
  }

  private applyItemEffect(b: SimBomber, itemName: string): void {
    const lower = itemName.toLowerCase();
    b.pickedUpItems.push(itemName);
    this.emitSound(23); // Wave/ItemEaten

    if (lower.includes("itembomb") || lower.includes("balloon")) {
      b.bombsCur = Math.min(b.bombsMax, b.bombsCur + 1);
    } else if (
      lower.includes("potionmax") ||
      lower.includes("watermax") ||
      lower.includes("powermax") ||
      lower.includes("maxpower")
    ) {
      b.powerCur = b.powerMax;
    } else if (lower.includes("itemwater") || lower.includes("potion")) {
      b.powerCur = Math.min(b.powerMax, b.powerCur + 1);
    } else if (lower.includes("reddevil") || lower.includes("rollermax")) {
      b.speedCur = b.speedDevilMax;
      if (lower.includes("reddevil")) b.powerCur = b.powerMax;
    } else if (lower.includes("skate") || lower.includes("roller")) {
      b.speedCur = Math.min(b.speedMax, b.speedCur + 1);
    } else if (lower.includes("shoe") || lower.includes("kick")) {
      b.canKick = true;
    } else if (lower.includes("glove") || lower.includes("throw") || lower.includes("punch")) {
      b.canThrow = true;
    } else if (lower.includes("niddle") || lower.includes("needle")) {
      b.ctrlItem = ActiveItemKind.Needle;
      b.ctrlCount = Math.min(9, b.ctrlCount + 1);
    } else if (lower.includes("dart")) {
      b.altItem = ActiveItemKind.Dart;
      b.altCount = Math.min(9, b.altCount + 3);
    } else if (lower.includes("spring")) {
      b.altItem = ActiveItemKind.Spring;
      b.altCount = Math.min(5, b.altCount + 2);
    } else if (lower.includes("shield")) {
      b.altItem = ActiveItemKind.Shield;
      b.altCount = Math.min(5, b.altCount + 1);
    } else if (lower.includes("radio") || lower.includes("remote")) {
      b.ctrlItem = ActiveItemKind.Remote;
      b.ctrlCount = 3;
    } else if (lower.includes("superman")) {
      b.supermanTicks = 330; // 10s
      b.bombsCur = b.bombsMax;
      b.powerCur = b.powerMax;
      b.speedCur = b.speedMax;
      this.emitSound(54); // Wave/SuperMan
    } else if (lower.includes("devil")) {
      b.devilTicks = DEVIL_DURATION_TICKS; // 244 ticks
      this.emitSound(55); // Wave/GreenDevil
    } else if (lower.includes("ufo") || lower.includes("airship")) {
      b.mountType = 2;
      b.mountSpeed = 10;
      this.emitSound(13); // Wave/ItemShip01
    } else if (lower.includes("owl")) {
      b.mountType = 0;
      b.mountSpeed = 6;
      this.emitSound(12); // Wave/ItemShip00
    } else if (
      lower.includes("superturtle") ||
      lower.includes("pirate") ||
      lower.includes("turtle1")
    ) {
      b.mountType = 4;
      b.mountSpeed = 8;
      this.emitSound(12);
    } else if (lower.includes("turtle")) {
      b.mountType = 1;
      b.mountSpeed = 4;
      this.emitSound(12);
    } else if (lower.includes("tank")) {
      b.mountType = 3;
      b.mountSpeed = 5;
      this.emitSound(13);
    } else if (lower.includes("coin") || lower.includes("lucci") || lower.includes("money") || lower.includes("bag")) {
      b.bonusLucci += lower.includes("gold") || lower.includes("bag") ? 150 : 50;
    }
  }

  /**
   * Exact 30 ms simulation step (CGameStage::sub_4F4733).
   */
  public stepTick(inputs: Map<number, PlayerInputState>): void {
    if (this.finished) return;
    this.tick++;

    // Snapshot previous positions for smooth sub-tick render interpolation (60/120/144Hz)
    for (const b of this.bombers) {
      b.prevX = b.x;
      b.prevY = b.y;
    }
    for (const bm of this.bombs) {
      bm.prevX = bm.x;
      bm.prevY = bm.y;
    }
    for (const m of this.monsters) {
      m.prevX = m.x;
      m.prevY = m.y;
    }

    // 1. Match countdown &Survival RedZone
    if (this.timeRemainingTicks > 0) {
      this.timeRemainingTicks--;
      if (this.timeRemainingTicks === 30 * 33) {
        this.suddenDeathActive = true;
        this.emitSound(46); // Wave/HurryUp
      }
      if (
        (this.mode === GameMode.Survival || this.suddenDeathActive) &&
        this.timeRemainingTicks > 0 &&
        this.timeRemainingTicks % 90 === 0 &&
        this.redZoneRing < 5
      ) {
        this.expandRedZoneRing(this.redZoneRing++);
      }
    }

    // 2. Tick melting blocks -> spawn hidden items
    for (let i = this.meltingBlocks.length - 1; i >= 0; i--) {
      const mb = this.meltingBlocks[i]!;
      mb.ticksLeft--;
      if (mb.ticksLeft <= 0) {
        const idx = this.cellIdx(mb.row, mb.col);
        this.solidGrid[idx] = 0;
        this.pushableGrid[idx] = 0;
        if (mb.dropItemName) {
          this.spawnGroundItem(mb.dropItemName, mb.row, mb.col);
          this.emitSound(24); // Wave/ItemPop
        }
        this.meltingBlocks.splice(i, 1);
      }
    }

    // 3. Tick pushing blocks
    for (let i = this.pushingBlocks.length - 1; i >= 0; i--) {
      const pb = this.pushingBlocks[i]!;
      pb.ticksLeft--;
      if (pb.ticksLeft <= 0) {
        const dstIdx = this.cellIdx(pb.toRow, pb.toCol);
        this.objectIds[dstIdx] = pb.templateId;
        this.solidGrid[dstIdx] = 1;
        this.pushableGrid[dstIdx] = 1;
        this.pushingBlocks.splice(i, 1);
      }
    }

    // 4. Tick ground items
    for (const it of this.items) {
      if (it.spawnGraceTicks > 0) it.spawnGraceTicks--;
      it.animTick++;
    }

    // 5. Tick bombs (fuse, kick slide, throw lob)
    for (let i = this.bombs.length - 1; i >= 0; i--) {
      const bomb = this.bombs[i];
      if (!bomb) continue;

      if (bomb.lobTicks > 0) {
        const targetX = cellToAnchorX(bomb.lobTargetCol);
        const targetY = cellToAnchorY(bomb.lobTargetRow);
        const t = bomb.lobTicks / bomb.lobTotalTicks;
        bomb.x = Math.round(bomb.lobStartX + (targetX - bomb.lobStartX) * t);
        bomb.y = Math.round(bomb.lobStartY + (targetY - bomb.lobStartY) * t);
        const arcIdx = Math.min(THROW_Y_STAGE1.length - 1, bomb.lobTicks - 1);
        bomb.zOffset = THROW_Y_STAGE1[arcIdx] ?? -24;
        bomb.lobTicks++;
        if (bomb.lobTicks > bomb.lobTotalTicks) {
          bomb.lobTicks = 0;
          bomb.zOffset = 0;
          bomb.row = bomb.lobTargetRow;
          bomb.col = bomb.lobTargetCol;
          bomb.x = targetX;
          bomb.y = targetY;
          void THROW_STEP_STAGE1;
        }
        continue;
      }

      if (bomb.kickedDir !== Direction.None) {
        const step = BOMB_KICK_MAX_STEP_PX; // 20 px/tick (sub_442948)
        const nextX = bomb.x + DIR_DX[bomb.kickedDir]! * step;
        const nextY = bomb.y + DIR_DY[bomb.kickedDir]! * step;
        const targetR = anchorToRow(nextY);
        const targetC = anchorToCol(nextX);

        if (targetR !== bomb.row || targetC !== bomb.col) {
          if (!this.canBombEnterCell(targetR, targetC)) {
            // Snap cleanly to current cell anchor & stop
            bomb.x = cellToAnchorX(bomb.col);
            bomb.y = cellToAnchorY(bomb.row);
            bomb.kickedDir = Direction.None;
          } else {
            bomb.x = nextX;
            bomb.y = nextY;
            bomb.row = targetR;
            bomb.col = targetC;
          }
        } else {
          bomb.x = nextX;
          bomb.y = nextY;
        }
      }

      if (!bomb.isRemote) {
        bomb.fuseTicks--;
        if (bomb.fuseTicks <= 0) {
          this.detonateBombChain(bomb);
        }
      }
    }

    // 6. Tick darts (CGODart)
    for (let i = this.darts.length - 1; i >= 0; i--) {
      const dart = this.darts[i]!;
      dart.x += DIR_DX[dart.dir]! * 24;
      dart.y += DIR_DY[dart.dir]! * 24;
      dart.ticksLeft--;

      const c = Math.floor(dart.x / CELL_SIZE);
      const r = Math.floor(dart.y / CELL_SIZE);
      if (!this.inBounds(r, c) || dart.ticksLeft <= 0) {
        this.darts.splice(i, 1);
        continue;
      }
      const hitBomb = this.findBombAt(r, c);
      if (hitBomb) {
        this.darts.splice(i, 1);
        this.detonateBombChain(hitBomb);
        continue;
      }
      if (this.solidGrid[this.cellIdx(r, c)] !== 0) {
        this.darts.splice(i, 1);
      }
    }

    // 7. Tick flames
    for (let i = this.flames.length - 1; i >= 0; i--) {
      const fl = this.flames[i]!;
      fl.ticksLeft--;
      if (fl.ticksLeft <= 0) {
        this.flames.splice(i, 1);
      }
    }

    // 8. Tick bombers (inputs, movement, foot item pickup, flame trap, bubble rescue/pop)
    for (const b of this.bombers) {
      b.animTick++;
      if (b.invulnTicks > 0) b.invulnTicks--;
      if (b.shieldTicks > 0) b.shieldTicks--;
      if (b.supermanTicks > 0) b.supermanTicks--;
      if (b.devilTicks > 0) b.devilTicks--;
      if (b.warpCooldownTicks > 0) b.warpCooldownTicks--;
      if (b.kartNitroTicks > 0) b.kartNitroTicks--;

      if (b.status === BomberStatus.SpawnInvuln && b.invulnTicks <= 0) {
        b.status = BomberStatus.Normal;
      }

      if (b.status === BomberStatus.Dead) continue;

      if (b.status === BomberStatus.Dying) {
        b.statusTicks--;
        if (b.statusTicks <= 0) {
          b.status = this.mode === GameMode.Normal ? BomberStatus.Ghost : BomberStatus.Dead;
          this.scatterDroppedItems(b);
        }
        continue;
      }

      if (b.status === BomberStatus.Jumping) {
        b.statusTicks++;
        const t = b.statusTicks / Math.max(1, b.jumpTotalTicks);
        b.x = Math.round(b.jumpStartX + (b.jumpTargetX - b.jumpStartX) * t);
        b.y = Math.round(b.jumpStartY + (b.jumpTargetY - b.jumpStartY) * t);
        b.zOffset = -Math.round(Math.sin(t * Math.PI) * 34);
        if (b.statusTicks >= b.jumpTotalTicks) {
          b.status = BomberStatus.Normal;
          b.zOffset = 0;
          b.x = b.jumpTargetX;
          b.y = b.jumpTargetY;
        }
        continue;
      }

      const inp = inputs.get(b.slotIndex);
      if (inp) {
        if (inp.useCtrl) this.useActiveSlot(b, false);
        if (inp.useAlt) this.useActiveSlot(b, true);
        if (inp.placeBomb || (b.devilTicks > 0 && this.tick % 18 === 0)) {
          this.tryPlaceOrThrowBomb(b);
        }
        if (inp.dir !== Direction.None) {
          b.moving = true;
          const px = this.getBomberStepPixels(b);
          this.moveBomberWithCornerSlide(b, inp.dir, px);
        } else {
          b.moving = false;
          b.pushHoldTicks = 0;
        }
      } else {
        b.moving = false;
      }

      // Warp portal check
      if (b.warpCooldownTicks === 0 && (b.status === BomberStatus.Normal || b.status === BomberStatus.Trapped)) {
        const cr = anchorToRow(b.y);
        const cc = anchorToCol(b.x);
        const wp = this.map.warps.find((w) => w.srcRow === cr && w.srcCol === cc);
        if (wp) {
          b.x = cellToAnchorX(wp.dstCol);
          b.y = cellToAnchorY(wp.dstRow);
          b.prevX = b.x;
          b.prevY = b.y;
          b.warpCooldownTicks = 25;
          this.emitSound(38); // Wave/Flash
        }
      }

      // 32x15 px foot hitbox item pickup at (x + 4, y - 15) (CA.exe sub_4EDB76!)
      if (b.status === BomberStatus.Normal || b.status === BomberStatus.SpawnInvuln) {
        const fx0 = b.x + 4;
        const fy0 = b.y - 15;
        const fx1 = fx0 + 32;
        const fy1 = fy0 + 15;
        for (let i = this.items.length - 1; i >= 0; i--) {
          const it = this.items[i]!;
          const ix0 = it.col * CELL_SIZE + 4;
          const iy0 = it.row * CELL_SIZE + 8;
          const ix1 = ix0 + 32;
          const iy1 = iy0 + 30;
          if (fx0 < ix1 && fx1 > ix0 && fy0 < iy1 && fy1 > iy0) {
            this.items.splice(i, 1);
            this.applyItemEffect(b, it.itemName);
          }
        }
      }

      // Flame & RedZone hazard check (sub_4F3D22)
      const bRow = anchorToRow(b.y);
      const bCol = anchorToCol(b.x);
      if (
        (b.status === BomberStatus.Normal || b.status === BomberStatus.SpawnInvuln) &&
        b.invulnTicks <= 0 &&
        b.shieldTicks <= 0 &&
        b.supermanTicks <= 0
      ) {
        const inRedZone = this.inBounds(bRow, bCol) && this.redZoneGrid[this.cellIdx(bRow, bCol)] !== 0;
        const hitFlame = this.flames.find((fl) => fl.row === bRow && fl.col === bCol);

        if (inRedZone) {
          this.killBomber(b, -1);
        } else if (hitFlame) {
          if (b.mountType >= 0) {
            // Ship absorbs hit! (sub_44721B)
            b.mountType = -1;
            b.mountSpeed = 0;
            b.invulnTicks = 28;
            this.emitSound(3);
          } else {
            b.status = BomberStatus.Trapped;
            b.statusTicks = 0;
            b.trappedBySlot = hitFlame.ownerSlot;
            b.devilTicks = 0;
            this.emitSound(26); // Wave/LockedIn
          }
        }
      }

      // Timebomb hot-potato check
      if (b.hasTimebomb && b.status === BomberStatus.Normal) {
        b.timebombTicks--;
        // Tag another player on contact to pass timebomb!
        for (const other of this.bombers) {
          if (other.slotIndex === b.slotIndex || other.status !== BomberStatus.Normal) continue;
          if (this.computeOverlapArea(b, other) >= BUBBLE_TOUCH_OVERLAP_PX2) {
            b.hasTimebomb = false;
            other.hasTimebomb = true;
            other.timebombTicks = Math.max(99, b.timebombTicks);
            b.invulnTicks = 20;
            this.emitSound(70); // Wave/TimebombTouch
            break;
          }
        }
        if (b.hasTimebomb && b.timebombTicks <= 0) {
          b.hasTimebomb = false;
          this.killBomber(b, -1);
          this.emitSound(68); // Wave/TimebombExplode
        }
      }

      // Trapped bubble logic (sub_4F3D22: <16 immune, 16..199 ally rescue / enemy pop, >=200 suffocate!)
      if (b.status === BomberStatus.Trapped) {
        b.statusTicks++;
        if (b.statusTicks >= BUBBLE_IMMUNE_TICKS && b.statusTicks < BUBBLE_SUFFOCATE_TICKS) {
          for (const other of this.bombers) {
            if (
              other.slotIndex === b.slotIndex ||
              (other.status !== BomberStatus.Normal && other.status !== BomberStatus.SpawnInvuln)
            ) {
              continue;
            }
            if (this.computeOverlapArea(b, other) >= BUBBLE_TOUCH_OVERLAP_PX2) {
              if (this.areAllies(b, other)) {
                // Ally rescue! (0x30)
                b.status = BomberStatus.Normal;
                b.statusTicks = 0;
                b.invulnTicks = 20;
                other.saves++;
                this.emitSound(27); // Wave/Release
              } else {
                // Enemy pop! (0x40)
                this.killBomber(b, other.slotIndex);
              }
              break;
            }
          }
        } else if (b.statusTicks >= BUBBLE_SUFFOCATE_TICKS) {
          // Suffocate at 200 ticks = 6.000s!
          this.killBomber(b, b.trappedBySlot);
        }
      }
    }

    // 9. Tick Monsters / Rabbits (StageClear / RabbitCatch)
    this.stepMonsters();

    // 10. Check Win / Lose / Draw condition
    this.evaluateMatchOutcome();
  }

  private computeOverlapArea(a: SimBomber, b: SimBomber): number {
    const ax0 = a.x;
    const ay0 = a.y - 39;
    const bx0 = b.x;
    const by0 = b.y - 39;
    const ox = Math.max(0, Math.min(ax0 + CELL_SIZE, bx0 + CELL_SIZE) - Math.max(ax0, bx0));
    const oy = Math.max(0, Math.min(ay0 + CELL_SIZE, by0 + CELL_SIZE) - Math.max(ay0, by0));
    return ox * oy;
  }

  private killBomber(b: SimBomber, killerSlot: number): void {
    b.status = BomberStatus.Dying;
    b.statusTicks = 28;
    if (killerSlot >= 0 && killerSlot !== b.slotIndex) {
      const killer = this.bombers.find((p) => p.slotIndex === killerSlot);
      if (killer && !this.areAllies(b, killer)) {
        killer.kills++;
      }
    }
    this.emitSound(28); // Wave/Die
  }

  private scatterDroppedItems(b: SimBomber): void {
    const count = Math.min(4, b.pickedUpItems.length);
    for (let i = 0; i < count; i++) {
      const itemName = b.pickedUpItems[i]!;
      for (let tries = 0; tries < 15; tries++) {
        const rr = this.rng.nextInt(GRID_ROWS);
        const cc = this.rng.nextInt(GRID_COLS);
        if (this.solidGrid[this.cellIdx(rr, cc)] === 0) {
          this.spawnGroundItem(itemName, rr, cc);
          break;
        }
      }
    }
    b.pickedUpItems.length = 0;
  }

  private expandRedZoneRing(ring: number): void {
    for (let r = 0; r < GRID_ROWS; r++) {
      for (let c = 0; c < GRID_COLS; c++) {
        if (r === ring || r === GRID_ROWS - 1 - ring || c === ring || c === GRID_COLS - 1 - ring) {
          const idx = this.cellIdx(r, c);
          this.redZoneGrid[idx] = 1;
          this.objectIds[idx] = -1;
          this.solidGrid[idx] = 1;
          this.indestructGrid[idx] = 1;
        }
      }
    }
  }

  private stepMonsters(): void {
    for (const m of this.monsters) {
      if (!m.alive) continue;
      m.aiTick++;
      if (m.invulnTicks > 0) m.invulnTicks--;

      const mr = anchorToRow(m.y);
      const mc = anchorToCol(m.x);

      if (m.trappedTicks > 0) {
        m.trappedTicks++;
        if (m.trappedTicks > 150) {
          m.trappedTicks = 0;
          m.invulnTicks = 20;
        } else {
          // Player touch pops trapped monster / catches rabbit!
          for (const b of this.bombers) {
            if (b.status !== BomberStatus.Normal && b.status !== BomberStatus.SpawnInvuln) continue;
            if (Math.abs(b.x - m.x) < 28 && Math.abs(b.y - m.y) < 28) {
              m.alive = false;
              b.kills++;
              b.bonusLucci += m.isBoss ? 300 : 80;
              this.emitSound(84); // Wave/MonsterDie
              break;
            }
          }
        }
        continue;
      }

      // Check flame hit on monster
      if (m.invulnTicks <= 0 && this.flames.some((fl) => fl.row === mr && fl.col === mc)) {
        m.hp--;
        m.invulnTicks = 25;
        if (m.hp <= 0) {
          m.trappedTicks = 1;
          this.emitSound(88); // Wave/MonsterLockIn
        } else {
          this.emitSound(85); // Wave/MonsterDamage
        }
        continue;
      }

      // Monster touches player -> traps player! (except RabbitCatch where rabbits flee)
      if (this.mode !== GameMode.RabbitCatch) {
        for (const b of this.bombers) {
          if (
            b.status === BomberStatus.Normal &&
            b.invulnTicks <= 0 &&
            b.shieldTicks <= 0 &&
            Math.abs(b.x - m.x) < 26 &&
            Math.abs(b.y - m.y) < 26
          ) {
            b.status = BomberStatus.Trapped;
            b.statusTicks = 0;
            b.trappedBySlot = -1;
            this.emitSound(26);
          }
        }
      }

      // Simple grid-aligned patrol / chase movement
      const nx = m.x + DIR_DX[m.dir]! * m.speed;
      const ny = m.y + DIR_DY[m.dir]! * m.speed;
      const yTop = ny - 39;
      const tr = anchorToRow(ny);
      const tc = anchorToCol(nx);
      const blocked =
        nx < 0 ||
        nx > (GRID_COLS - 1) * CELL_SIZE ||
        yTop < 0 ||
        yTop > (GRID_ROWS - 1) * CELL_SIZE ||
        ((tr !== mr || tc !== mc) &&
          (!this.inBounds(tr, tc) || this.solidGrid[this.cellIdx(tr, tc)] !== 0 || !!this.findBombAt(tr, tc)));

      if (blocked || m.aiTick % 45 === 0) {
        const dirs = [Direction.Left, Direction.Up, Direction.Right, Direction.Down];
        const openDirs = dirs.filter((d) => {
          const rr = mr + DIR_DY[d]!;
          const cc = mc + DIR_DX[d]!;
          return this.inBounds(rr, cc) && this.solidGrid[this.cellIdx(rr, cc)] === 0 && !this.findBombAt(rr, cc);
        });
        if (openDirs.length > 0) {
          m.dir = openDirs[this.rng.nextInt(openDirs.length)]!;
        }
      } else {
        m.x = nx;
        m.y = ny;
      }
    }
  }

  private evaluateMatchOutcome(): void {
    if (this.finishDelayTicks > 0) {
      this.finishDelayTicks--;
      if (this.finishDelayTicks === 0) {
        this.finished = true;
      }
      return;
    }

    const alive = this.bombers.filter(
      (b) =>
        b.status !== BomberStatus.Dead &&
        b.status !== BomberStatus.Ghost &&
        b.status !== BomberStatus.Dying,
    );

    if (this.mode === GameMode.Bonus) {
      if (this.timeRemainingTicks <= 0 || this.items.length === 0) {
        this.winningTeam = alive[0]?.team ?? 0;
        this.finishDelayTicks = 50;
      }
      return;
    }

    if (this.mode === GameMode.Monster || this.mode === GameMode.RabbitCatch) {
      const aliveMonsters = this.monsters.filter((m) => m.alive);
      if (aliveMonsters.length === 0) {
        this.winningTeam = this.bombers[0]?.team ?? 0;
        this.finishDelayTicks = 60;
        this.emitSound(22); // Wave/Win
        return;
      }
      if (alive.length === 0 || this.timeRemainingTicks <= 0) {
        this.winningTeam = -1;
        this.finishDelayTicks = 60;
        this.emitSound(14); // Wave/Lose
      }
      return;
    }

    if (this.timeRemainingTicks <= 0) {
      this.winningTeam = -1; // Draw
      this.finishDelayTicks = 60;
      this.emitSound(9); // Wave/Draw
      return;
    }

    if (this.bombers.length <= 1) {
      // Solo practice test: end only when dead
      if (alive.length === 0) {
        this.winningTeam = -1;
        this.finishDelayTicks = 50;
      }
      return;
    }

    // Captain mode: if a team's Captain dies, that team loses immediately!
    if (this.mode === GameMode.Captain) {
      const aliveCaptains = alive.filter((b) => b.isCaptain);
      if (aliveCaptains.length <= 1) {
        this.winningTeam = aliveCaptains[0]?.team ?? -1;
        this.finishDelayTicks = 60;
        return;
      }
    }

    // Standard PvP / Team check
    const initialTeams = new Set(this.bombers.map((b) => b.team));
    if (initialTeams.size >= 2) {
      const aliveTeams = new Set(alive.map((b) => b.team));
      if (aliveTeams.size === 0) {
        this.winningTeam = -1;
        this.finishDelayTicks = 60;
      } else if (aliveTeams.size === 1) {
        this.winningTeam = [...aliveTeams][0]!;
        this.finishDelayTicks = 60;
      }
    } else {
      // FFA when everyone picked same color
      if (alive.length <= 1) {
        this.winningTeam = alive[0] ? 100 + alive[0].slotIndex : -1;
        this.finishDelayTicks = 60;
      }
    }
  }
}
