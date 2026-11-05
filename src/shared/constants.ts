// Exact constants extracted verbatim from CA.exe (BnB Taiwan v22)

export const SCREEN_WIDTH = 800;
export const SCREEN_HEIGHT = 600;

// CGameStage::sub_4F5658 / sub_4F4733: fixed 30 ms simulation step (33.333 Hz)
export const TICK_MS = 30;
export const MAX_STEPS_PER_FRAME = 15;

// CGameMap grid dimensions (sub_4E5845): 15 columns x 13 rows, 40x40 px cells
// Map viewport in CGameStage: top-left (20, 41) -> 600x520 playfield inside 800x600
export const GRID_COLS = 15;
export const GRID_ROWS = 13;
export const CELL_SIZE = 40;
export const PLAYFIELD_OFFSET_X = 20;
export const PLAYFIELD_OFFSET_Y = 41;

// Cell anchor convention in CA.exe: x = 40 * col, y = 40 * row + 39
export function cellToAnchorX(col: number): number {
  return CELL_SIZE * col;
}
export function cellToAnchorY(row: number): number {
  return CELL_SIZE * row + 39;
}
export function anchorToCol(x: number): number {
  return Math.floor((x + 20) / CELL_SIZE);
}
export function anchorToRow(y: number): number {
  return Math.floor((y - 39 + 20) / CELL_SIZE);
}

// Direction vectors at 0x91D7B8 (n2 / dword_91D7BC): 0=Left, 1=Up, 2=Right, 3=Down
export const enum Direction {
  Left = 0,
  Up = 1,
  Right = 2,
  Down = 3,
  None = -1,
}

export const DIR_DX: readonly number[] = [-1, 0, 1, 0];
export const DIR_DY: readonly number[] = [0, -1, 0, 1];

// Pack archive XOR keys (CPackSysMan::sub_673110 / sub_6731A0)
export const PACK_KEY_FX = 0x719cab30;
export const PACK_KEY_CHAR_EMO = 0x05b201fc;
export const PACK_IDD_CONST = 0x9c6c95ce;

// Planar HSL delta tables at 0x91C6D0..0x91C7A8 (9 teams: 0=Red, 1=Yellow, 2=Orange, 3=Green, 4=Sky, 5=Blue, 6=Purple, 7=Pink, 8=Gray)
export const TEAM_HUE_DEG: readonly number[] = [0.0, 45.0, 27.0, 128.0, -175.0, -155.0, -77.0, -40.0, 0.0];
export const TEAM_LIGHTNESS_DELTA: readonly number[] = [0.0, 0.0, 0.03, -0.01, 0.0, 0.0, 0.05, 0.0, 0.0];
export const TEAM_SATURATION_DELTA: readonly number[] = [0.0, 0.0, 0.45, -0.55, -0.33, 0.0, -0.16, 0.0, -1.0];

export const TEAM_DISPLAY_NAMES: readonly string[] = [
  "紅隊",
  "黃隊",
  "橘隊",
  "綠隊",
  "水藍隊",
  "藍隊",
  "紫隊",
  "粉紅隊",
  "觀戰",
];

export const TEAM_UI_HEX: readonly [number, number, number][] = [
  [235, 52, 52],
  [245, 208, 32],
  [245, 138, 32],
  [58, 198, 68],
  [56, 202, 232],
  [52, 112, 240],
  [168, 78, 235],
  [242, 108, 192],
  [164, 168, 176],
];

// CGOBomb wrap-around throw arc tables at 0x9150C0..0x915208 (sub_442BF1)
export const THROW_Y_STAGE1: readonly number[] = [-33, -33, -33, -33, -33, -33, -33, -33, -33, -33, -32, -30, -27, -23, -18];
export const THROW_STEP_STAGE1: readonly number[] = [16, 16, 16, 16, 16, 16, 16, 16, 16, 16, 16, 16, 16, 16, 16];
export const THROW_Y_STAGE2: readonly number[] = [-35, -55, -70, -80, -85, -80, -75, -70, -60, -45, -30, -18];
export const THROW_STEP_STAGE2: readonly number[] = [10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10];
export const THROW_Y_STAGE3: readonly number[] = [-12, -17, -20, -17, -12, -17, -20, -17, -12, -17, -20, -17];
export const THROW_STEP_STAGE3: readonly number[] = [10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10];
export const THROW_Y_STAGE4: readonly number[] = [-12, -17, -20, -17];
export const THROW_STEP_STAGE4: readonly number[] = [10, 10, 10, 10];

// Gameplay timing constants from CA.exe
export const BOMB_FUSE_TICKS = 96; // 4 loops x 24 ticks of Bomb/Bomb00 = 2,880 ms
export const BOMB_LOB_TICKS = 15; // CGOBomb::sub_443339 parabolic lob
export const BOMB_KICK_MAX_STEP_PX = 20; // sub_442948: <=152 px -> min(dist, 20) px/tick
export const BUBBLE_IMMUNE_TICKS = 16; // sub_4F3D22: n7_1[11642] < 16
export const BUBBLE_FADE_START_TICKS = 150; // alpha ramps 128 -> 255 over 150..200
export const BUBBLE_SUFFOCATE_TICKS = 200; // 200 * 30ms = 6.000s auto-pop
export const BUBBLE_TOUCH_OVERLAP_PX2 = 400; // >= 400 px^2 overlap rescues/pops
export const BUBBLE_MOVE_SPEED_PX = 1; // CGOBomber LockedInMove: 1 px / 30ms tick
export const DEVIL_DURATION_TICKS = 244; // sub_447B95: 244 ticks = 7.32s
export const BLOCK_DESTROY_TICKS = 14; // soft block melt animation
export const BLOCK_PUSH_TICKS = 10; // pushable block slide (4 px/tick * 10 = 40 px)

// Exact Attr/BomberAttr row order (0..10) + CCharacterNameMan::sub_49D498 + csysstr.ssd Taiwan names!
// Row 0=C00(Dao/藍寶), 1=C01(Dizini/痞子妹), 2=C03(Mos/工頭), 3=C05(Ethi/粟子),
// 4=C04(Marid/小蜜桃), 5=C06(Bazzi/睏寶), 6=C02(Uni/囡囡), 7=C07(Kephi/ㄚ肥),
// 8=C08(Random/隨機), 9=C09(Super/超人), 10=C10(LuxuryMarid/優雅小蜜桃)
export const CHARACTER_SPRITE_CODES: readonly string[] = [
  "C00",
  "C01",
  "C03",
  "C05",
  "C04",
  "C06",
  "C02",
  "C07",
  "C08",
  "C09",
  "C10",
];

export const CHARACTER_CODES = [
  "Dao",
  "Dizini",
  "Mos",
  "Ethi",
  "Marid",
  "Bazzi",
  "Uni",
  "Kephi",
  "Random",
  "Super",
  "LuxuryMarid",
] as const;

export const CHARACTER_TW_NAMES: readonly string[] = [
  "藍寶",
  "痞子妹",
  "工頭",
  "粟子",
  "小蜜桃",
  "睏寶",
  "囡囡",
  "ㄚ肥",
  "隨機",
  "超人",
  "優雅小蜜桃",
];

// Game modes matching CA.exe CComponent subclasses
export const enum GameMode {
  Normal = 0, // 一般對戰 (FFA / Team)
  Practice = 1, // 練習模式 (AI Bots)
  Monster = 2, // 怪物模式 / 闖關模式 (StageClear)
  Bonus = 3, // 獎勵金幣關 (Bonus Stage)
  Survival = 4, // 生存模式 (RedZone)
  Captain = 5, // 隊長模式 (King/Crown)
  Bula = 6, // 搶屋/幽靈模式 (Bula)
  Timebomb = 7, // 定時炸彈模式 (Timebomb)
  RabbitCatch = 8, // 抓兔模式 (RabbitCatch)
  Hedgehog = 9, // 刺蝟模式 (Hedgehog)
  Kart = 10, // 賽車模式 (Kart)
}

export const GAME_MODE_NAMES: Record<GameMode, string> = {
  [GameMode.Normal]: "一般對戰",
  [GameMode.Practice]: "練習模式 (AI)",
  [GameMode.Monster]: "合作闖關 (StageClear)",
  [GameMode.Bonus]: "獎勵關卡 (Bonus)",
  [GameMode.Survival]: "生存紅區 (Survival)",
  [GameMode.Captain]: "隊長決戰 (Captain)",
  [GameMode.Bula]: "搶屋對戰 (Bula)",
  [GameMode.Timebomb]: "定時水球 (Timebomb)",
  [GameMode.RabbitCatch]: "黃金抓兔 (Rabbit)",
  [GameMode.Hedgehog]: "刺蝟變身 (Hedgehog)",
  [GameMode.Kart]: "跑跑賽車 (Kart)",
};

// All 143 Wave/* sound effect paths from off_917F70 in CA.exe
export const SFX_WAVE_PATHS: readonly string[] = [
  "Wave/BomberWalk", "Wave/BombExplode", "Wave/BombIgnite", "Wave/BlockDown", "Wave/ButtonDown_0",
  "Wave/ButtonDown_1", "Wave/ButtonDown_2", "Wave/Close", "Wave/Connect", "Wave/Draw",
  "Wave/GameStart_0", "Wave/GameStart_1", "Wave/ItemShip00", "Wave/ItemShip01", "Wave/Lose",
  "Wave/MouseMove_0", "Wave/MouseMove_1", "Wave/MouseMove_2", "Wave/TimerExpired_0", "Wave/TimerExpired_1",
  "Wave/TimerGo", "Wave/Title", "Wave/Win", "Wave/ItemEaten", "Wave/ItemPop",
  "Wave/MineSet", "Wave/LockedIn", "Wave/Release", "Wave/Die", "Wave/ScreenShot",
  "Wave/UseMotor", "Wave/Banana", "Wave/Spring", "Wave/SpringShort", "Wave/Drill",
  "Wave/Ghost", "Wave/Bat", "Wave/GhostTrans", "Wave/Flash", "Wave/RallyPoint",
  "Wave/BonusStageEffect", "Wave/BonusStageVocal", "Wave/Refuel", "Wave/KartMove", "Wave/KartAccel",
  "Wave/KartNitro", "Wave/HurryUp", "Wave/FuelWarning", "Wave/BulaGhostWarning2", "Wave/BulaTookHouse",
  "Wave/BulaMummyCreate", "Wave/BulaMummyDie", "Wave/BulaBatCreate", "Wave/BulaBatDie", "Wave/SuperMan",
  "Wave/GreenDevil", "Wave/TankFire", "Wave/Ending", "Wave/La", "Wave/real_Timpani_Roll",
  "Wave/brass", "Wave/Revive", "Wave/HedgehogRebirth", "Wave/HedgehogStruggle", "Wave/Count1",
  "Wave/Count2", "Wave/Count3", "Wave/TimebombRoulette", "Wave/TimebombExplode", "Wave/TimebombCaution",
  "Wave/TimebombTouch", "Wave/ShieldOn", "Wave/ShieldFlash", "Wave/SOSItem", "Wave/Dash",
  "Wave/SprinklerBomb", "Wave/SpitOutLucci", "Wave/CoupleNiddle", "Wave/AutoLoadCpNiddle", "Wave/CoupleCongratulate",
  "Wave/GachaponReset", "Wave/GachaponChoice", "Wave/GachaponRotation", "Wave/GachaponMouseOver", "Wave/MonsterDie",
  "Wave/MonsterDamage", "Wave/MonsterAnger", "Wave/MonsterPrepareAttack", "Wave/MonsterLockIn", "Wave/MonsterMove",
  "Wave/MonsterHurrah", "Wave/NpcDie", "Wave/M_P_NpcDie", "Wave/M_P_NpcLockIn", "Wave/M_P_NpcRelease",
  "Wave/M_P_NpcEggIn", "Wave/M_P_NpcEggBreak", "Wave/M_PenguinMove", "Wave/M_PenguinMonsterDamage", "Wave/M_PenguinMonsterAnger",
  "Wave/M_PenguinLockIn", "Wave/M_PenguinDie", "Wave/M_PenguinHurrah", "Wave/M_PenguinCreateEgg", "Wave/M_SealMove",
  "Wave/M_SealMonsterDamage", "Wave/M_SealMonsterAnger", "Wave/M_SealLockIn", "Wave/M_SealDie", "Wave/M_SealHurrah",
  "Wave/M_SealRoll", "Wave/M_SealBomb", "Wave/M_S_NpcDie", "Wave/M_S_NpcAnger", "Wave/M_S_NpcAnger2",
  "Wave/RabbitAppear01", "Wave/RabbitAppear02", "Wave/RabbitAppear03", "Wave/RabbitDisappear", "Wave/RabbitDie01",
  "Wave/RabbitDie02", "Wave/RabbitDie03", "Wave/GoldRabbitAppear", "Wave/GoldRabbitLockin", "Wave/GoldRabbitDie",
  "Wave/SmallBird", "Wave/GameReady", "Wave/BasketEggCreate", "Wave/BasketEggMouseOver", "Wave/BasketEggClick",
  "Wave/BasketEggBreaking", "Wave/BasketDisplayItem", "Wave/BasketEggDisappear", "Wave/SJNeedle1", "Wave/SJNeedle2",
  "Wave/SJNeedle3", "Wave/SJNeedle4", "Wave/SJNeedle5", "Wave/SJNeedle6", "Wave/SJNeedle7",
  "Wave/Release_Coke", "Wave/RescueCoinUse", "Wave/Resurrection",
];
