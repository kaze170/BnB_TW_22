import {
  CHARACTER_TW_NAMES,
  Direction,
  GameMode,
  SCREEN_WIDTH,
  TEAM_DISPLAY_NAMES,
} from "../../shared/constants.ts";
import {
  AvatarSlot,
  ClientOpcode,
  EMPTY_EQUIPPED,
  type EquippedAvatar,
  type RoomSlotDTO,
} from "../../shared/protocol.ts";
import { BomberStatus, GameWorld } from "../../shared/sim/world.ts";
import type { ClientAppState } from "../state.ts";

/* ------------------------------------------------------------------ *
 * Native CA.exe data tables
 * ------------------------------------------------------------------ */

/** CCreateRoomDlg / CRoomInfoDlg mode rows — Etc/Dlg_CreateBt_* + Etc/Dlg_Create_*Img */
const ROOM_MODE_ROWS: {
  mode: GameMode;
  label: string;
  bt: string;
  img: string;
}[] = [
  {
    mode: GameMode.Normal,
    label: "一般對戰",
    bt: "Etc/Dlg_CreateBt_Default",
    img: "Etc/Dlg_Create_DefaultImg",
  },
  {
    mode: GameMode.Monster,
    label: "怪物合作",
    bt: "Etc/Dlg_CreateBt_Rehab",
    img: "Etc/Dlg_Create_RehabImg",
  },
  {
    mode: GameMode.Hedgehog,
    label: "刺蝟模式",
    bt: "Etc/Dlg_CreateBt_hedgehog",
    img: "Etc/Dlg_Create_hedgehogImg",
  },
  {
    mode: GameMode.Timebomb,
    label: "定時炸彈",
    bt: "Etc/Dlg_CreateBt_Timebomb",
    img: "Etc/Dlg_Create_TimebombImg",
  },
  {
    mode: GameMode.Captain,
    label: "隊長模式",
    bt: "Etc/Dlg_CreateBt_Flag",
    img: "Etc/Dlg_Create_FlagImg",
  },
];

const MODE_LABELS = new Map<GameMode, string>([
  [GameMode.Normal, "一般對戰"],
  [GameMode.Practice, "AI 練習賽"],
  [GameMode.Monster, "怪物合作"],
  [GameMode.Bonus, "紅利金幣"],
  [GameMode.Survival, "生存縮圈"],
  [GameMode.Captain, "隊長模式"],
  [GameMode.Timebomb, "定時炸彈"],
  [GameMode.RabbitCatch, "抓兔子"],
  [GameMode.Bula, "布拉模式"],
  [GameMode.Hedgehog, "刺蝟模式"],
  [GameMode.Kart, "卡丁賽車"],
]);

/** 8 native emotion icons straight out of Fx.idd (Shop/Emot*). */
const EMOTION_ICONS = [
  "Shop/EmotSmile",
  "Shop/EmotAngry",
  "Shop/EmotSad",
  "Shop/EmotLove",
  "Shop/EmotGreet",
  "Shop/EmotShy",
  "Shop/EmotDance",
  "Shop/EmotSpecial",
];

const MP_TABS = [
  "MyInfo/MP_Tab_MyInfo",
  "MyInfo/MP_Tab_MyItem",
  "MyInfo/MP_Tab_Quest",
];

/* ------------------------------------------------------------------ *
 * Local (non-networked) view state
 * ------------------------------------------------------------------ */

let channelTab = 1;
let channelPage = 0;
let roomPage = 0;
let lobbyWaitOnly = false;
let onlineUserPage = 0;
let mapPickerOffset = 0;
let selectedMapInModal = "";
let createRoomMode: GameMode = GameMode.Normal;
let createRoomMapIdx = 0;
let createRoomUsePassword = false;
let practiceBotCount = 3;
let practiceMapIdx = 0;
let shopTab = 0;
let shopPage = 0;
let shopSelectedItemId = 0;
let tryOnEquipped: EquippedAvatar | null = null;
let gachaponSpinTicks = 0;
let creditScrollY = 520;
let creditPaused = false;
let creditSpeed = 1;
let creditLines: { text: string; color: number; image: number }[] | null = null;
let cafeX = 380;
let cafeY = 390;
let cafeDir: Direction = Direction.Down;
let marketSelectedInvItemId = 0;
let autoReadyChecked = false;
let titleBootTicks = 0;
let myPageTab = 0;
let tutorialPage = 0;
let messengerOpenUserId = 0;
let optionBgm = true;
let optionSfx = true;
let optionRefuseTrade = false;
let optionRefuseFriend = false;
let optionRefuseWhisper = false;

/* ------------------------------------------------------------------ *
 * CGlobalButtonDlg — GlobalUI/Dlg_Back (0, 566) + 9 native buttons
 * ------------------------------------------------------------------ */

function leaveCurrentScreen(state: ClientAppState): void {
  state.globalMenuOpen = false;
  state.modal = "none";
  if (state.stage === "Prepare") {
    state.net.sendJson(ClientOpcode.LeaveRoom, {});
    state.currentRoom = null;
    state.switchStage("Lobby");
  } else if (state.stage === "Lobby") {
    state.net.sendJson(ClientOpcode.RefreshChannels, {});
    state.switchStage("SelectServer");
  } else if (state.stage === "SelectServer") {
    state.switchStage("Login");
  } else if (state.stage === "Login") {
    state.switchStage("Title");
  } else if (state.stage === "Game") {
    state.switchStage("Lobby");
  } else {
    state.switchStage(state.currentRoom ? "Prepare" : "Lobby");
  }
}

function drawGlobalBottomBar(state: ClientAppState): void {
  const ui = state.ui;
  const backSheet = state.assets.getSpriteSync("Fx", "GlobalUI/Dlg_Back");
  if (backSheet) {
    state.assets.drawSpriteFrame(backSheet, 0, 0, 566);
  }

  // BtMenu (20, 572) 69x24
  if (ui.spriteButton(state.assets, "gui_menu", "GlobalUI/BtMenu", 20, 572, {
    tooltip: "功能選單",
  })) {
    state.globalMenuOpen = !state.globalMenuOpen;
  }

  // BtBack (101, 572) 31x24
  if (ui.spriteButton(state.assets, "gui_back", "GlobalUI/BtBack", 101, 572, {
    tooltip: "返回上一頁",
  })) {
    leaveCurrentScreen(state);
    return;
  }

  // BtShop (144, 572) 63x24
  if (ui.spriteButton(state.assets, "gui_shop", "GlobalUI/BtShop", 144, 572, {
    tooltip: "購物商城",
    disabled: state.stage === "SelectServer" || state.stage === "Shop",
  })) {
    state.globalMenuOpen = false;
    state.net.sendJson(ClientOpcode.ShopCatalogReq, {});
    state.switchStage("Shop");
    return;
  }

  // BtUserMarket (212, 572) 38x24
  if (ui.spriteButton(state.assets, "gui_market", "GlobalUI/BtUserMarket", 212, 572, {
    tooltip: "自由拍賣市場",
    disabled: state.stage === "SelectServer" || state.stage === "UserMarket",
  })) {
    state.globalMenuOpen = false;
    state.net.sendJson(ClientOpcode.MarketListReq, {});
    state.switchStage("UserMarket");
    return;
  }

  // Bt_IconHelp (255, 572) 38x24 — the original "Tutorial Button"
  if (ui.spriteButton(state.assets, "gui_help", "GlobalUI/Bt_IconHelp", 255, 572, {
    tooltip: "遊戲說明與新手教學",
  })) {
    state.globalMenuOpen = false;
    state.modal = "tutorial";
    return;
  }

  // BtBasket (545, 574) 77x22
  if (ui.spriteButton(state.assets, "gui_basket", "GlobalUI/BtBasket", 545, 574, {
    tooltip: "禮物盒與信箱",
  })) {
    state.globalMenuOpen = false;
    state.net.sendJson(ClientOpcode.NoteAction, { action: "list" });
    state.modal = "smsMail";
    return;
  }

  // BtMyitem (627, 572) 67x24
  if (ui.spriteButton(state.assets, "gui_myitem", "GlobalUI/BtMyitem", 627, 572, {
    tooltip: "個人資訊與背包",
  })) {
    state.globalMenuOpen = false;
    state.net.sendJson(ClientOpcode.MyInfoRequest, {});
    state.modal = "myPage";
    return;
  }

  // BtMessenger (706, 572) 31x24
  if (ui.spriteButton(state.assets, "gui_msg", "GlobalUI/BtMessenger", 706, 572, {
    tooltip: "好友名單",
  })) {
    state.globalMenuOpen = false;
    state.net.sendJson(ClientOpcode.FriendAction, { action: "list" });
    state.modal = "messenger";
    return;
  }

  // BtExit (749, 572) 31x24
  if (ui.spriteButton(state.assets, "gui_exit", "GlobalUI/BtExit", 749, 572, {
    tooltip: "離開目前畫面",
  })) {
    leaveCurrentScreen(state);
    return;
  }

  if (state.globalMenuOpen) {
    drawGlobalMenuPopup(state);
  }
}

/**
 * CGlobalButtonMenuDlg — GlobalUI/MenuDlg_Back_2 (117x271) at (20, 295)
 * with 10 CCtrlButtonWithText rows and GlobalUI/MenuIcon glyphs.
 */
function drawGlobalMenuPopup(state: ClientAppState): void {
  const ui = state.ui;
  const r = state.assets.renderer;

  const dx = 20;
  const dy = 295;

  const panel = state.assets.getSpriteSync("Fx", "GlobalUI/MenuDlg_Back_2");
  if (panel) {
    state.assets.drawSpriteFrame(panel, 0, dx, dy);
  }

  const rows: {
    y: number;
    h: number;
    bg: string;
    label: string;
    labelX: number;
    act: () => void;
  }[] = [
    {
      y: 0,
      h: 36,
      bg: "GlobalUI/MenuDlg_Back00",
      label: "購物商城",
      labelX: 58,
      act: () => {
        state.net.sendJson(ClientOpcode.ShopCatalogReq, {});
        state.switchStage("Shop");
      },
    },
    {
      y: 38,
      h: 25,
      bg: "GlobalUI/MenuDlg_Back01",
      label: "我的道具",
      labelX: 58,
      act: () => {
        myPageTab = 1;
        state.net.sendJson(ClientOpcode.MyInfoRequest, {});
        state.modal = "myPage";
      },
    },
    {
      y: 63,
      h: 25,
      bg: "GlobalUI/MenuDlg_Back01",
      label: "個人資訊",
      labelX: 58,
      act: () => {
        myPageTab = 0;
        state.net.sendJson(ClientOpcode.MyInfoRequest, {});
        state.modal = "myPage";
      },
    },
    {
      y: 88,
      h: 25,
      bg: "GlobalUI/MenuDlg_Back01",
      label: "每日任務",
      labelX: 58,
      act: () => {
        myPageTab = 2;
        state.net.sendJson(ClientOpcode.MyInfoRequest, {});
        state.modal = "myPage";
      },
    },
    {
      y: 115,
      h: 25,
      bg: "GlobalUI/MenuDlg_Back02",
      label: "拍賣市場",
      labelX: 44,
      act: () => {
        state.net.sendJson(ClientOpcode.MarketListReq, {});
        state.switchStage("UserMarket");
      },
    },
    {
      y: 140,
      h: 25,
      bg: "GlobalUI/MenuDlg_Back02",
      label: "好友名單",
      labelX: 44,
      act: () => {
        state.net.sendJson(ClientOpcode.FriendAction, { action: "list" });
        state.modal = "messenger";
      },
    },
    {
      y: 165,
      h: 25,
      bg: "GlobalUI/MenuDlg_Back02",
      label: "遊戲設定",
      labelX: 44,
      act: () => {
        state.modal = "option";
      },
    },
    {
      y: 190,
      h: 25,
      bg: "GlobalUI/MenuDlg_Back02",
      label: "新手教學",
      labelX: 44,
      act: () => {
        state.modal = "tutorial";
      },
    },
    {
      y: 218,
      h: 25,
      bg: "GlobalUI/MenuDlg_Back02",
      label: "休閒交誼廳",
      labelX: 44,
      act: () => {
        state.switchStage("Chatting");
      },
    },
    {
      y: 243,
      h: 25,
      bg: "GlobalUI/MenuDlg_Back02",
      label: "製作群名單",
      labelX: 44,
      act: () => {
        state.switchStage("Credit");
      },
    },
  ];

  const iconSheet = state.assets.getSpriteSync("Fx", "GlobalUI/MenuIcon");

  rows.forEach((row, idx) => {
    const bx = dx;
    const by = dy + row.y;
    const hovered = ui.hitRect(bx, by, 117, row.h);
    if (hovered) ui.markInteractiveHover(`gmenu_${idx}`);

    const bgSheet = state.assets.getSpriteSync("Fx", row.bg);
    if (bgSheet) {
      state.assets.drawSpriteFrame(bgSheet, hovered ? 1 : 0, bx, by);
    }
    if (iconSheet) {
      state.assets.drawSpriteFrame(
        iconSheet,
        (idx % 5) + 1,
        bx + 20,
        by + Math.floor((row.h - 14) * 0.5),
      );
    }
    r.drawText(row.label, bx + row.labelX, by + Math.floor((row.h - 12) * 0.5), [1, 1, 1, 1], {
      bold: hovered,
      outlined: true,
    });

    if (hovered && ui.mouseJustPressed) {
      ui.mouseClicked = false;
      state.globalMenuOpen = false;
      row.act();
    }
  });
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

function drawStageJpeg(state: ClientAppState, path: string): void {
  const bg = state.assets.getJpegSync("Fx", path);
  if (bg) {
    state.assets.renderer.drawQuad(bg, 0, 0, SCREEN_WIDTH, 600);
  }
}

async function startPracticeMatch(
  state: ClientAppState,
  mapNameArg?: string,
  botCount = 3,
  mode: GameMode = GameMode.Practice,
): Promise<void> {
  const mapName =
    mapNameArg ||
    state.assets.mapNames.find((m) => m.toLowerCase().includes("patrit_00")) ||
    state.assets.mapNames[0] ||
    "patrit_00";
  const mapObj = await state.assets.prefetchMapAssets(mapName);
  if (!mapObj) return;
  await Promise.all([
    state.assets.prefetchCharacterBase(0),
    state.assets.prefetchCharacterBase(1),
    state.assets.prefetchCharacterBase(2),
    state.assets.prefetchCharacterBase(4),
    state.assets.prefetchCharacterBase(5),
  ]);

  const myChar = state.profile?.defaultChar ?? 0;
  const slots: RoomSlotDTO[] = [
    {
      slotIndex: 0,
      state: "human",
      userId: state.profile?.userId ?? 1,
      nickname: state.profile?.nickname ?? "1P 藍寶",
      level: state.profile?.level ?? 10,
      isHost: true,
      isReady: true,
      isLocal2P: false,
      charIndex: myChar,
      team: 0,
      equipped: state.profile?.equipped ?? EMPTY_EQUIPPED,
    },
  ];

  let nextSlot = 1;
  if (state.local2PEnabled) {
    slots.push({
      slotIndex: nextSlot++,
      state: "human",
      userId: state.profile?.userId ?? 1,
      nickname: `${state.profile?.nickname ?? "1P"}_2P`,
      level: 10,
      isHost: false,
      isReady: true,
      isLocal2P: true,
      charIndex: 5,
      team: 0,
      equipped: EMPTY_EQUIPPED,
    });
  }

  const botChars = [5, 4, 1, 2, 6, 3, 7];
  for (let b = 0; b < botCount && nextSlot < 8; b++) {
    const ci = botChars[b % botChars.length]!;
    slots.push({
      slotIndex: nextSlot,
      state: "bot",
      userId: 0,
      nickname: `${CHARACTER_TW_NAMES[ci] ?? "電腦"}AI`,
      level: 5 + b * 2,
      isHost: false,
      isReady: true,
      isLocal2P: false,
      charIndex: ci,
      team: (b % 3) + 1,
      equipped: EMPTY_EQUIPPED,
    });
    nextSlot++;
  }

  state.isOfflineSolo = true;
  state.myPrimarySlot = 0;
  state.mySecondarySlot = state.local2PEnabled ? 1 : -1;
  state.matchResult = null;
  state.world = new GameWorld(
    mode,
    mapObj,
    slots,
    (Date.now() ^ 0x5a5a1234) >>> 0,
    state.assets.staticMapData,
  );
  state.switchStage("Game");
}

/* ------------------------------------------------------------------ *
 * CTitleStage — white intro card + Wave/Title, auto-enters CLoginStage
 * ------------------------------------------------------------------ */

function renderTitleStage(state: ClientAppState): void {
  const r = state.assets.renderer;
  const ui = state.ui;

  titleBootTicks++;
  if (titleBootTicks === 1) {
    state.audio.playSfxById(21); // Wave/Title
  }

  r.drawRect(0, 0, SCREEN_WIDTH, 600, [1, 1, 1, 1]);

  if (
    titleBootTicks >= 48 ||
    ui.mouseJustPressed ||
    ui.keysJustPressed.has("Enter") ||
    ui.keysJustPressed.has("Space") ||
    ui.keysJustPressed.has("Escape")
  ) {
    titleBootTicks = 0;
    state.switchStage("Login");
  }
}

/* ------------------------------------------------------------------ *
 * CLoginStage — LoginStage/CAStage + LO_LogTable00/01
 * ------------------------------------------------------------------ */

function renderLoginStage(state: ClientAppState): void {
  const ui = state.ui;
  drawStageJpeg(state, "LoginStage/CAStage");

  const dual = state.local2PEnabled;
  const tablePath = dual ? "LoginStage/LO_LogTable01" : "LoginStage/LO_LogTable00";
  const tx = dual ? 143 : 188;
  const ty = 405;

  const table = state.assets.getSpriteSync("Fx", tablePath);
  if (table) {
    state.assets.drawSpriteFrame(table, 0, tx, ty);
  }

  // 1P / 2P mode toggle carved into the left of the log table
  if (
    ui.spriteButton(
      state.assets,
      "login_mode",
      dual ? "LoginStage/LO_Bt2P" : "LoginStage/LO_Bt1P",
      dual ? 572 : 529,
      415,
      { tooltip: dual ? "目前：雙人同機（點擊切回單人）" : "目前：單人登入（點擊切換雙人同機）" },
    )
  ) {
    state.local2PEnabled = !state.local2PEnabled;
  }

  // Native carved white edit slots: 84x12 each
  const idX = dual ? 363 : 408;
  const id2X = 456;
  const userField = ui.carvedField("login_user", idX, 448, 84, 12, {
    defaultValue: "BazziTW",
    textColor: [0.04, 0.12, 0.3, 1],
    outlined: false,
  });
  const passField = ui.carvedField("login_pass", idX, 473, 84, 12, {
    defaultValue: "1234",
    password: true,
    textColor: [0.04, 0.12, 0.3, 1],
    outlined: false,
  });
  let user2Field: { value: string; submitted: boolean } | null = null;
  let pass2Field: { value: string; submitted: boolean } | null = null;
  if (dual) {
    user2Field = ui.carvedField("login_user2", id2X, 448, 84, 12, {
      defaultValue: "BazziTW2",
      textColor: [0.04, 0.12, 0.3, 1],
      outlined: false,
    });
    pass2Field = ui.carvedField("login_pass2", id2X, 473, 84, 12, {
      defaultValue: "1234",
      password: true,
      textColor: [0.04, 0.12, 0.3, 1],
      outlined: false,
    });
  }

  const doLogin = async () => {
    await state.net.connect();
    const uname = userField.value.trim() || "BazziTW";
    state.net.sendJson(ClientOpcode.Login1P, {
      username: uname,
      password: passField.value,
    });
    if (state.local2PEnabled) {
      state.net.sendJson(ClientOpcode.Login2P, {
        enable: true,
        nickname: user2Field?.value.trim() || `${uname}_2P`,
        charIndex: 5,
      });
    }
  };

  // LO_BTLogCred (0, 562) — 163x22 with pivot (-7,-11)
  if (
    ui.spriteButton(state.assets, "login_credit", "LoginStage/LO_BTLogCred", 0, 562, {
      tooltip: "製作群名單",
    })
  ) {
    state.switchStage("Credit");
  }

  // LO_BtLogNewId (242, 558) / LO_BtLogOk (351, 558) / LO_BtLogExit (460, 558) — 99x30
  if (
    ui.spriteButton(state.assets, "login_newid", "LoginStage/LO_BtLogNewId", 242, 558, {
      tooltip: "申請新帳號",
    })
  ) {
    state.modal = "newId";
  }

  if (
    ui.spriteButton(state.assets, "login_ok", "LoginStage/LO_BtLogOk", 351, 558, {
      tooltip: "連線進入伺服器",
    }) ||
    ((userField.submitted ||
      passField.submitted ||
      user2Field?.submitted ||
      pass2Field?.submitted) &&
      state.modal === "none")
  ) {
    void doLogin();
  }

  if (
    ui.spriteButton(state.assets, "login_exit", "LoginStage/LO_BtLogExit", 460, 558, {
      tooltip: "離開遊戲",
    })
  ) {
    state.switchStage("Title");
  }
}

/* ------------------------------------------------------------------ *
 * CSelectServerStage — CH_Tab_* + 2x5 CH_Bt_Channel grid
 * ------------------------------------------------------------------ */

function renderSelectServerStage(state: ClientAppState): void {
  const r = state.assets.renderer;
  const ui = state.ui;
  drawStageJpeg(state, "SelectServerStage/CAStage");

  const tabs = [
    "SelectServerStage/CH_Tab_Novice",
    "SelectServerStage/CH_Tab_Free",
    "SelectServerStage/CH_Tab_Ladder",
    "SelectServerStage/CH_Tab_Special",
    "SelectServerStage/CH_Tab_Event",
  ];
  tabs.forEach((sp, idx) => {
    if (
      ui.spriteButton(state.assets, `ch_tab_${idx}`, sp, 426 + idx * 69, 176, {
        selected: channelTab === idx,
        hitW: 71,
        hitH: 40,
      })
    ) {
      channelTab = idx;
      channelPage = 0;
    }
  });

  const perPage = 10;
  const channels = state.channels;
  const barSheet = state.assets.getSpriteSync("Fx", "SelectServerStage/CH_Bar_User");

  for (let i = 0; i < perPage; i++) {
    const ch = channels[channelPage * perPage + i];
    if (!ch) continue;
    const cx = i % 2 === 1 ? 595 : 428;
    const cy = 218 + 56 * (i >> 1);

    if (
      ui.spriteButton(state.assets, `ch_slot_${ch.id}`, "SelectServerStage/CH_Bt_Channel", cx, cy, {
        hitW: 161,
        hitH: 52,
        tooltip: ch.name,
      })
    ) {
      state.net.sendJson(ClientOpcode.SelectChannel, { channelId: ch.id });
    }

    ui.drawSpriteDigits(
      state.assets,
      "SelectServerStage/CH_Bt_ChNum",
      String(ch.id).padStart(2, "0"),
      cx + 12,
      cy + 11,
      9,
    );
    r.drawText(ch.name, cx + 38, cy + 10, [1, 1, 1, 1], { bold: true, maxWidth: 114 });

    const ratio = Math.min(1, ch.currentUsers / Math.max(1, ch.maxUsers));
    if (barSheet && barSheet.frames.length > 0) {
      const fi = Math.min(barSheet.frames.length - 1, Math.floor(ratio * (barSheet.frames.length - 1)));
      state.assets.drawSpriteFrame(barSheet, fi, cx + 38, cy + 31);
    }
  }

  if (
    ui.spriteButton(state.assets, "ch_prev", "SelectServerStage/CH_Bt_Left", 490, 508, {
      disabled: channelPage <= 0,
      hitW: 24,
      hitH: 25,
    })
  ) {
    channelPage = Math.max(0, channelPage - 1);
  }
  if (
    ui.spriteButton(state.assets, "ch_next", "SelectServerStage/CH_Bt_Right", 676, 508, {
      disabled: (channelPage + 1) * perPage >= channels.length,
      hitW: 24,
      hitH: 25,
    })
  ) {
    channelPage++;
  }

  drawGlobalBottomBar(state);
}

/* ------------------------------------------------------------------ *
 * CLobbyStage
 * ------------------------------------------------------------------ */

function renderLobbyStage(state: ClientAppState): void {
  const r = state.assets.renderer;
  const ui = state.ui;
  drawStageJpeg(state, "Lobby/CAStage");

  // Top action bar (sub_4BC7CE)
  if (
    ui.spriteButton(state.assets, "lb_create_nm", "Lobby/LB_Bt_T_Create-NM", 214, 59, {
      hitW: 92,
      hitH: 55,
      tooltip: "建立一般對戰房間",
    })
  ) {
    createRoomMode = GameMode.Normal;
    state.modal = "createRoom";
  }
  if (
    ui.spriteButton(state.assets, "lb_quick_nm", "Lobby/LB_Bt_T_QuickJoin-NM", 306, 59, {
      hitW: 92,
      hitH: 55,
      tooltip: "快速加入等待中的房間",
    })
  ) {
    state.net.sendJson(ClientOpcode.QuickJoin, {});
  }
  if (
    ui.spriteButton(state.assets, "lb_create_mm", "Lobby/LB_Bt_T_Create-MM", 404, 59, {
      hitW: 92,
      hitH: 55,
      tooltip: "建立怪物合作房間",
    })
  ) {
    createRoomMode = GameMode.Monster;
    state.modal = "createRoom";
  }
  if (
    ui.spriteButton(state.assets, "lb_quick_mm", "Lobby/LB_Bt_T_QuickJoin-MM", 496, 59, {
      hitW: 92,
      hitH: 55,
      tooltip: "快速加入合作模式",
    })
  ) {
    state.net.sendJson(ClientOpcode.QuickJoin, {});
  }
  if (
    ui.spriteButton(
      state.assets,
      "lb_filter",
      lobbyWaitOnly ? "Lobby/LB_Bt_T_ShowAll-MM" : "Lobby/LB_Bt_T_WaitRoom-MM",
      595,
      66,
      { hitW: 90, hitH: 47 },
    )
  ) {
    lobbyWaitOnly = !lobbyWaitOnly;
    roomPage = 0;
  }
  if (
    ui.spriteButton(state.assets, "lb_practice", "Lobby/LB_Bt_T_Practice-MM", 685, 66, {
      hitW: 90,
      hitH: 47,
      tooltip: "單人 AI 練習賽",
    })
  ) {
    state.modal = "practice";
  }

  // 6 room session slots (272x81) at (214|490, 121|205|289)
  const filteredRooms = lobbyWaitOnly
    ? state.rooms.filter((rm) => rm.status === "waiting")
    : state.rooms;
  const perPage = 6;
  const pageRooms = filteredRooms.slice(roomPage * perPage, (roomPage + 1) * perPage);
  const lbImg = state.assets.getSpriteSync("Fx", "Lobby/LB_Img");

  for (let i = 0; i < perPage; i++) {
    const rm = pageRooms[i];
    if (!rm) continue;
    const rx = i % 2 === 0 ? 214 : 490;
    const ry = 121 + Math.floor(i / 2) * 84;

    if (
      ui.spriteButton(state.assets, `lb_room_${rm.roomId}`, "Lobby/LB_Bt_SessionSlot", rx, ry, {
        hitW: 272,
        hitH: 81,
        disabled: rm.status !== "waiting",
        tooltip: rm.title,
      })
    ) {
      state.net.sendJson(ClientOpcode.JoinRoom, { roomId: rm.roomId, password: "" });
    }

    ui.drawSpriteDigits(
      state.assets,
      "Etc/Room_Num",
      String(rm.roomNumber).padStart(3, "0"),
      rx + 14,
      ry + 12,
      9,
    );

    if (lbImg && lbImg.frames.length > 1) {
      state.assets.drawSpriteFrame(lbImg, rm.status === "waiting" ? 0 : 1, rx + 14, ry + 50);
    }
    if (rm.hasPassword && lbImg && lbImg.frames.length > 2) {
      state.assets.drawSpriteFrame(lbImg, 2, rx + 218, ry + 12);
    }

    const modeLabel = MODE_LABELS.get(rm.mode) ?? "一般對戰";
    r.drawText(rm.title, rx + 58, ry + 12, [1, 1, 1, 1], { bold: true, maxWidth: 185 });
    r.drawText(`${modeLabel} · ${rm.mapName}`, rx + 66, ry + 36, [0.82, 0.95, 1, 1], {
      maxWidth: 168,
    });
    r.drawText(`${rm.playerCount}/${rm.maxPlayers}`, rx + 66, ry + 55, [1, 0.94, 0.45, 1], {
      bold: true,
    });

    ui.spriteButton(state.assets, `lb_rinfo_${rm.roomId}`, "Lobby/LB_Bt_RoomInfo", rx + 242, ry + 49, {
      hitW: 26,
      hitH: 24,
      tooltip: `${rm.title} (${rm.mapName})`,
    });
  }

  // Room pagination (431, 376) / (494, 376)
  if (
    ui.spriteButton(state.assets, "lb_rprev", "Lobby/LB_Bt_Left01", 431, 376, {
      disabled: roomPage <= 0,
      hitW: 59,
      hitH: 23,
    })
  ) {
    roomPage = Math.max(0, roomPage - 1);
  }
  ui.drawSpriteDigits(
    state.assets,
    "Etc/PageNum",
    String(roomPage + 1),
    470,
    380,
    12,
    0,
    [1, 0.95, 0.4, 1],
  );
  if (
    ui.spriteButton(state.assets, "lb_rnext", "Lobby/LB_Bt_Right01", 494, 376, {
      disabled: (roomPage + 1) * perPage >= filteredRooms.length,
      hitW: 59,
      hitH: 23,
    })
  ) {
    roomPage++;
  }

  // Left sidebar carved into Lobby/CAStage
  const p = state.profile;
  state.assets.drawCharacterPaperDoll({
    charIndex: p?.defaultChar ?? 0,
    team: 0,
    dir: Direction.Down,
    moving: false,
    status: BomberStatus.Normal,
    animTick: state.animTick,
    anchorX: 104,
    anchorY: 162,
    equipped: p?.equipped ?? EMPTY_EQUIPPED,
    lobbyPose: true,
  });

  if (p) {
    r.drawText(`Lv.${p.level} ${p.nickname}`, 34, 202, [1, 0.96, 0.55, 1], {
      bold: true,
      maxWidth: 140,
    });
    r.drawText(`${p.wins}勝 ${p.losses}敗 ${p.draws}和`, 34, 219, [0.85, 0.95, 1, 1]);
    r.drawText(`${p.lucci.toLocaleString()} Lucci`, 34, 235, [1, 0.9, 0.45, 1], {
      maxWidth: 140,
    });
  }

  const usersPerPage = 10;
  const sliceUsers = state.onlineUsers.slice(
    onlineUserPage * usersPerPage,
    (onlineUserPage + 1) * usersPerPage,
  );
  sliceUsers.forEach((u, idx) => {
    const uy = 268 + idx * 24;
    const isMe = p && u.userId === p.userId;
    const hovered = state.modal === "none" && ui.hitRect(32, uy, 144, 22);
    if (hovered && !isMe) {
      ui.markInteractiveHover(`lobby_user_${u.userId}`);
      ui.setTooltip(`與 ${u.nickname} 發起安全交易`);
      if (ui.mouseJustPressed) {
        ui.mouseClicked = false;
        state.net.sendJson(ClientOpcode.ExchangeRequest, { partnerNickname: u.nickname });
      }
    }
    r.drawText(
      `Lv.${u.level} ${u.nickname}`,
      36,
      uy + 3,
      isMe ? [1, 0.95, 0.45, 1] : hovered ? [0.6, 1, 0.75, 1] : [1, 1, 1, 1],
      { maxWidth: 136, bold: hovered },
    );
  });

  if (
    ui.spriteButton(state.assets, "lb_uprev", "Lobby/LB_Bt_Left02", 56, 524, {
      disabled: onlineUserPage <= 0,
      hitW: 45,
      hitH: 19,
    })
  ) {
    onlineUserPage = Math.max(0, onlineUserPage - 1);
  }
  if (
    ui.spriteButton(state.assets, "lb_unext", "Lobby/LB_Bt_Right02", 103, 524, {
      disabled: (onlineUserPage + 1) * usersPerPage >= state.onlineUsers.length,
      hitW: 45,
      hitH: 19,
    })
  ) {
    onlineUserPage++;
  }

  // Bottom carved chat history + Etc/TextBox input
  state.chatLog.slice(-6).forEach((c, idx) => {
    r.drawText(
      `${c.sender}: ${c.text}`,
      224,
      412 + idx * 17,
      c.isWhisper ? [0.58, 1.0, 0.74, 1] : [1, 1, 1, 1],
      { maxWidth: 540 },
    );
  });
  r.drawText("全體", 276, 529, [0.88, 0.96, 1, 1], { align: "center" });
  const chatField = ui.carvedField("lobby_chat", 300, 518, 410, 22, {
    placeholder: "輸入聊天訊息後按 Enter...",
    assets: state.assets,
    drawNineSliceBg: true,
  });
  if (chatField.submitted && state.modal === "none") {
    const txt = chatField.value.trim();
    if (txt) {
      state.net.sendJson(ClientOpcode.ChatMessage, { text: txt });
      ui.setFieldValue("lobby_chat", "");
    }
  }

  drawGlobalBottomBar(state);
}

/* ------------------------------------------------------------------ *
 * Native Etc/*_mm minimap thumbnail preview
 * ------------------------------------------------------------------ */

function drawMinimapPreview(
  state: ClientAppState,
  mapName: string,
  x: number,
  y: number,
  w: number,
  h: number,
): void {
  const r = state.assets.renderer;
  r.drawRect(x, y, w, h, [0.02, 0.06, 0.14, 1]);

  const mmKey = `Etc/${mapName.replace(/_/g, "")}_mm`;
  const mmSheet = state.assets.getSpriteSync("Fx", mmKey);
  if (mmSheet) {
    state.assets.drawSpriteFrame(mmSheet, 0, x + 2, y + 2);
    r.drawText(mapName, x + w * 0.5, y + h - 16, [1, 0.95, 0.55, 1], {
      align: "center",
      bold: true,
      maxWidth: w - 6,
    });
    return;
  }

  const mapObj = state.assets.mapCache.get(mapName.toLowerCase());
  if (!mapObj) {
    void state.assets.prefetchMapAssets(mapName);
    r.drawText(mapName, x + w * 0.5, y + h * 0.5 - 6, [0.85, 0.95, 1, 1], {
      align: "center",
      bold: true,
      maxWidth: w - 8,
    });
    return;
  }

  const cw = Math.floor((w - 8) / 15);
  const ch = Math.floor((h - 22) / 13);
  const ox = x + Math.floor((w - cw * 15) * 0.5);
  const oy = y + 4;

  for (let row = 0; row < 13; row++) {
    for (let col = 0; col < 15; col++) {
      const hasObj = (mapObj.objectIds[row * 15 + col] ?? -1) >= 0;
      r.drawRect(
        ox + col * cw,
        oy + row * ch,
        cw - 1,
        ch - 1,
        hasObj
          ? (row + col) % 2 === 0
            ? [0.88, 0.56, 0.24, 1]
            : [0.74, 0.44, 0.2, 1]
          : (row + col) % 2 === 0
            ? [0.22, 0.52, 0.28, 1]
            : [0.18, 0.45, 0.24, 1],
      );
    }
  }
  for (const pt of mapObj.spawns) {
    r.drawRect(ox + pt.col * cw + 1, oy + pt.row * ch + 1, cw - 2, ch - 2, [1, 0.95, 0.3, 1]);
  }
  r.drawText(mapName, x + w * 0.5, y + h - 16, [1, 0.95, 0.55, 1], {
    align: "center",
    bold: true,
    maxWidth: w - 6,
  });
}

/* ------------------------------------------------------------------ *
 * CPrepareStage
 * ------------------------------------------------------------------ */

const PREPARE_CHAR_CELLS: { x: number; y: number; charIndex: number; sprite: string }[] = [
  { x: 484, y: 61, charIndex: 0, sprite: "Etc/SelChara00" },
  { x: 581, y: 61, charIndex: 1, sprite: "Etc/SelChara01" },
  { x: 678, y: 61, charIndex: 2, sprite: "Etc/SelChara02" },
  { x: 484, y: 126, charIndex: 3, sprite: "Etc/SelChara03" },
  { x: 581, y: 126, charIndex: 8, sprite: "Prepare/PRE_SelChara" },
  { x: 678, y: 126, charIndex: 4, sprite: "Etc/SelChara04" },
  { x: 484, y: 191, charIndex: 5, sprite: "Etc/SelChara05" },
  { x: 581, y: 191, charIndex: 6, sprite: "Etc/SelChara06" },
  { x: 678, y: 191, charIndex: 7, sprite: "Etc/SelChara07" },
];

function renderPrepareStage(state: ClientAppState): void {
  const r = state.assets.renderer;
  const ui = state.ui;
  const rm = state.currentRoom;
  if (!rm) {
    state.switchStage("Lobby");
    return;
  }

  const isMonster = rm.mode === GameMode.Monster;
  drawStageJpeg(state, isMonster ? "Prepare/CAStageMonster" : "Prepare/CAStage");

  const mySlot = rm.slots.find(
    (s) => s.state === "human" && s.userId === state.profile?.userId && !s.isLocal2P,
  );
  const amHost = Boolean(mySlot?.isHost);
  const modeLabel = MODE_LABELS.get(rm.mode) ?? "一般對戰";

  // Room title carved bar + PRE_Bt_Roominfo (344, 61)
  r.drawText(
    `[${String(rm.roomNumber).padStart(3, "0")}] ${rm.title} (${modeLabel})`,
    36,
    63,
    [1, 0.96, 0.55, 1],
    { bold: true, maxWidth: 300 },
  );
  if (
    ui.spriteButton(state.assets, "pre_roominfo", "Prepare/PRE_Bt_Roominfo", 344, 61, {
      hitW: 100,
      hitH: 22,
      tooltip: "房間設定",
    })
  ) {
    createRoomMode = rm.mode;
    state.modal = "roomInfo";
  }

  // 8 player slots (4x2)
  const preImg = state.assets.getSpriteSync("Fx", "Prepare/PRE_Img");
  for (let i = 0; i < 8; i++) {
    const sl = rm.slots[i]!;
    const sx = 28 + 106 * (i % 4);
    const sy = i < 4 ? 85 : 230;

    if (sl.state === "open" || sl.state === "closed") {
      if (
        ui.spriteButton(
          state.assets,
          `pre_slot_${i}`,
          sl.state === "open" ? "Prepare/PRE_Bt_Slot-Open" : "Prepare/PRE_Bt_Slot-Close",
          sx,
          sy,
          { hitW: 98, hitH: 98, disabled: !amHost },
        )
      ) {
        state.net.sendJson(ClientOpcode.SlotStateChange, { slotIndex: i });
      }
      continue;
    }

    state.assets.drawCharacterPaperDoll({
      charIndex: sl.charIndex,
      team: sl.team,
      dir: Direction.Down,
      moving: false,
      status: BomberStatus.Normal,
      animTick: state.animTick,
      anchorX: sx + 49,
      anchorY: sy + 76,
      equipped: sl.equipped,
      lobbyPose: true,
    });

    // Master / Ready / Wait badge from Prepare/PRE_Img
    const badgeFrame = sl.isHost ? 0 : sl.isReady ? 1 : 2;
    if (preImg && preImg.frames.length > badgeFrame) {
      state.assets.drawSpriteFrame(preImg, badgeFrame, sx + 8, sy + 78);
    }
    r.drawText(sl.nickname, sx + 49, sy + 4, [1, 1, 1, 1], {
      align: "center",
      bold: true,
      maxWidth: 90,
    });

    const em = state.activeEmotions.get(sl.slotIndex);
    if (em) {
      const emSheet = state.assets.getSpriteSync("Fx", EMOTION_ICONS[em.emotionId % 8]!);
      if (emSheet) {
        // drawSpriteFrame renders at (x - pivotX, y - pivotY); pivot on Shop/Emot* is (dx, 59)
        const f0 = emSheet.frames[0]!;
        state.assets.drawSpriteFrame(emSheet, 0, sx + 60 + f0.pivotX, sy + 12 + f0.pivotY);
      }
    }

    if (amHost && sl.state === "bot" && state.modal === "none" && ui.hitRect(sx, sy, 98, 98)) {
      ui.markInteractiveHover(`pre_bot_${i}`);
      ui.setTooltip("點擊移除此電腦 AI 欄位");
      if (ui.mouseJustPressed) {
        ui.mouseClicked = false;
        state.net.sendJson(ClientOpcode.SlotStateChange, { slotIndex: i });
      }
    }
  }

  // 3x3 character selector
  for (const cell of PREPARE_CHAR_CELLS) {
    const isSel = mySlot?.charIndex === cell.charIndex;
    if (
      ui.spriteButton(state.assets, `pre_char_${cell.charIndex}`, cell.sprite, cell.x, cell.y, {
        selected: isSel,
        selectedBase: 4,
        hitW: 92,
        hitH: 61,
        tooltip: CHARACTER_TW_NAMES[cell.charIndex] ?? "隨機",
      })
    ) {
      void state.assets.prefetchCharacterBase(cell.charIndex);
      state.net.sendJson(ClientOpcode.SelectCharacterTeam, { charIndex: cell.charIndex });
    }
  }

  // Team colour buttons
  const maxTeams = isMonster ? 4 : 8;
  for (let t = 0; t < maxTeams; t++) {
    const tx = 486 + 36 * t;
    const spPath = isMonster
      ? `Prepare/PRE_SelTeam-4_0${t}`
      : `Prepare/PRE_SelTeam-Basic0${t}`;
    if (
      ui.spriteButton(state.assets, `pre_team_${t}`, spPath, tx, 280, {
        selected: mySlot?.team === t,
        hitW: 35,
        hitH: 37,
        tooltip: `${TEAM_DISPLAY_NAMES[t] ?? `第${t + 1}隊`}`,
      })
    ) {
      state.net.sendJson(ClientOpcode.SelectCharacterTeam, { team: t });
    }
  }

  // Minimap + PRE_Bt_Selectmap (646, 428)
  drawMinimapPreview(state, rm.mapName, 486, 348, 152, 128);
  r.drawText(rm.mapName, 561, 482, [0.9, 0.97, 1, 1], { align: "center", maxWidth: 148 });

  if (
    ui.spriteButton(state.assets, "pre_selmap", "Prepare/PRE_Bt_Selectmap", 646, 428, {
      disabled: !amHost,
      hitW: 123,
      hitH: 48,
      tooltip: amHost ? "選擇對戰地圖" : "僅房主可更換地圖",
    })
  ) {
    selectedMapInModal = rm.mapName;
    state.modal = "selectMap";
  }

  // START / READY (512, 494) + auto-ready checkbox (719, 525)
  if (amHost) {
    if (
      ui.spriteButton(state.assets, "pre_start", "Prepare/PRE_Bt_Start", 512, 494, {
        hitW: 193,
        hitH: 57,
      })
    ) {
      state.net.sendJson(ClientOpcode.StartMatch, {});
    }
  } else if (
    ui.spriteButton(state.assets, "pre_ready", "Prepare/PRE_Bt_Ready", 512, 494, {
      selected: Boolean(mySlot?.isReady),
      hitW: 193,
      hitH: 57,
    })
  ) {
    state.net.sendJson(ClientOpcode.ToggleReady, {});
  }

  if (
    ui.spriteButton(state.assets, "pre_autoready", "Prepare/PRE_Bt_CheckBox", 719, 525, {
      selected: autoReadyChecked,
      hitW: 25,
      hitH: 18,
      tooltip: "自動準備",
    })
  ) {
    autoReadyChecked = !autoReadyChecked;
  }

  // Emotion hotkeys F1..F8 (native CA.exe shortcut) + chat
  for (let k = 0; k < 8; k++) {
    if (ui.keysJustPressed.has(`F${k + 1}`)) {
      state.net.sendJson(ClientOpcode.EmotionTrigger, { emotionId: k });
    }
  }

  state.chatLog.slice(-6).forEach((c, idx) => {
    r.drawText(
      `${c.sender}: ${c.text}`,
      34,
      400 + idx * 18,
      c.isWhisper ? [0.58, 1.0, 0.74, 1] : [1, 1, 1, 1],
      { maxWidth: 380 },
    );
  });
  r.drawText("房內", 82, 530, [0.88, 0.96, 1, 1], { align: "center" });
  const chatField = ui.carvedField("prep_chat", 108, 518, 282, 22, {
    placeholder: "輸入訊息後按 Enter...",
    assets: state.assets,
    drawNineSliceBg: true,
  });
  if (chatField.submitted && state.modal === "none") {
    const txt = chatField.value.trim();
    if (txt) {
      state.net.sendJson(ClientOpcode.ChatMessage, { text: txt });
      ui.setFieldValue("prep_chat", "");
    }
  }

  drawGlobalBottomBar(state);
}

/* ------------------------------------------------------------------ *
 * CShopStageNew
 * ------------------------------------------------------------------ */

const SHOP_TABS: { sp: string; filter: string }[] = [
  { sp: "Shop/S_TabSet", filter: "all" },
  { sp: "Shop/S_TabChar", filter: "head_body" },
  { sp: "Shop/S_TabItem", filter: "deco" },
  { sp: "Shop/S_TabSpecial", filter: "bomb_fx" },
  { sp: "Shop/S_TabSlot", filter: "bg" },
];

function renderShopStage(state: ClientAppState): void {
  const r = state.assets.renderer;
  const ui = state.ui;
  drawStageJpeg(state, "Shop/Stage");

  SHOP_TABS.forEach((td, idx) => {
    if (
      ui.spriteButton(state.assets, `shop_tab_${idx}`, td.sp, 27 + idx * 82, 86, {
        selected: shopTab === idx,
        hitW: 82,
        hitH: 30,
      })
    ) {
      shopTab = idx;
      shopPage = 0;
    }
  });

  const filtered = state.assets.shopCatalog.filter((it) => {
    if (shopTab === 1)
      return [AvatarSlot.Cap, AvatarSlot.Head, AvatarSlot.Clothes, AvatarSlot.Face].includes(it.slot);
    if (shopTab === 2)
      return [AvatarSlot.Wing, AvatarSlot.Flag, AvatarSlot.Balloon].includes(it.slot);
    if (shopTab === 3) return [AvatarSlot.BombSkin, AvatarSlot.Effect].includes(it.slot);
    if (shopTab === 4) return it.tab >= 5;
    return true;
  });

  const perPage = 10;
  const pageItems = filtered.slice(shopPage * perPage, (shopPage + 1) * perPage);

  pageItems.forEach((item, idx) => {
    const ix = idx % 2 === 0 ? 27 : 256;
    const iy = 124 + Math.floor(idx / 2) * 80;
    const isSel = shopSelectedItemId === item.itemId;

    if (
      ui.spriteButton(state.assets, `shop_slot_${item.itemId}`, "Shop/S_BtItemSlot03", ix, iy, {
        selected: isSel,
        hitW: 221,
        hitH: 76,
      })
    ) {
      shopSelectedItemId = item.itemId;
      const base = { ...(tryOnEquipped ?? state.profile?.equipped ?? EMPTY_EQUIPPED) };
      if (item.slot === AvatarSlot.Cap) base.cap = item.itemId;
      else if (item.slot === AvatarSlot.Head) base.head = item.itemId;
      else if (item.slot === AvatarSlot.Clothes) base.body = item.itemId;
      else if (item.slot === AvatarSlot.Face) base.eyes = item.itemId;
      else if (item.slot === AvatarSlot.Flag) base.flag = item.itemId;
      else if (item.slot === AvatarSlot.Wing) base.wing = item.itemId;
      else if (item.slot === AvatarSlot.Effect) base.effect = item.itemId;
      else if (item.slot === AvatarSlot.BombSkin) base.bombSkin = item.itemId;
      else if (item.slot === AvatarSlot.Balloon) base.balloon = item.itemId;
      tryOnEquipped = base;
    }

    state.assets.drawShopItemPreview(item.itemId, ix + 38, iy + 48, state.animTick);

    r.drawText(item.name, ix + 76, iy + 10, [1, 1, 1, 1], { bold: true, maxWidth: 138 });
    r.drawText(
      item.priceCash > 0
        ? `${item.priceCash.toLocaleString()} 點`
        : `${item.priceLucci.toLocaleString()} L`,
      ix + 76,
      iy + 29,
      item.priceCash > 0 ? [1, 0.72, 0.88, 1] : [1, 0.94, 0.45, 1],
      { bold: true },
    );

    if (
      ui.spriteButton(state.assets, `shop_buy_${item.itemId}`, "Shop/S_BtPBuy", ix + 146, iy + 46, {
        hitW: 62,
        hitH: 22,
        tooltip: "購買",
      })
    ) {
      state.net.sendJson(ClientOpcode.ShopBuyItem, { itemId: item.itemId });
    }
  });

  if (
    ui.spriteButton(state.assets, "shop_prev", "Shop/S_BtScrLeft", 198, 528, {
      disabled: shopPage <= 0,
      hitW: 29,
      hitH: 22,
    })
  ) {
    shopPage = Math.max(0, shopPage - 1);
  }
  ui.drawSpriteDigits(
    state.assets,
    "Shop/S_ScrNum",
    String(shopPage + 1),
    240,
    532,
    12,
    0,
    [1, 0.95, 0.45, 1],
  );
  if (
    ui.spriteButton(state.assets, "shop_next", "Shop/S_BtScrRight", 282, 528, {
      disabled: (shopPage + 1) * perPage >= filtered.length,
      hitW: 29,
      hitH: 22,
    })
  ) {
    shopPage++;
  }

  // Right avatar preview road
  const roadSp = state.assets.getSpriteSync("Fx", "Shop/S_BackLight");
  if (roadSp && roadSp.frames.length > 0) {
    state.assets.drawSpriteFrame(
      roadSp,
      Math.floor(state.animTick / 6) % roadSp.frames.length,
      631,
      186,
    );
  }
  state.assets.drawCharacterPaperDoll({
    charIndex: state.profile?.defaultChar ?? 0,
    team: 0,
    dir: Direction.Down,
    moving: true,
    status: BomberStatus.Normal,
    animTick: state.animTick,
    anchorX: 703,
    anchorY: 286,
    equipped: tryOnEquipped ?? state.profile?.equipped ?? EMPTY_EQUIPPED,
    scale: 1.25,
  });

  if (
    ui.spriteButton(state.assets, "shop_revert", "Shop/S_BtUndo", 528, 287, {
      hitW: 100,
      hitH: 22,
      tooltip: "還原試穿",
    })
  ) {
    tryOnEquipped = null;
    shopSelectedItemId = 0;
  }

  const lucciStr = String(state.profile?.lucci ?? 0);
  const cashStr = String(state.profile?.cash ?? 0);
  ui.drawSpriteDigits(state.assets, "Shop/S_MoneyCount", lucciStr, 622, 362, 10);
  ui.drawSpriteDigits(state.assets, "Shop/S_MoneyCount", cashStr, 622, 400, 10);

  // Selected item actions: S_BtPSendGift -> sendGift modal
  const selItem = state.assets.shopCatalog.find((x) => x.itemId === shopSelectedItemId);
  if (selItem) {
    r.drawText(selItem.name, 560, 452, [1, 0.95, 0.5, 1], { bold: true, maxWidth: 210 });
    if (
      ui.spriteButton(state.assets, "shop_present", "Shop/S_BtPSendGift", 560, 474, {
        hitW: 110,
        hitH: 38,
        tooltip: "贈送給好友",
      })
    ) {
      state.modal = "sendGift";
    }
  }

  // S_BtLucky (558, 526) -> native gachapon dialog
  if (
    ui.spriteButton(state.assets, "shop_lucky", "Shop/S_BtLucky", 558, 526, {
      hitW: 190,
      hitH: 32,
      tooltip: "幸運轉蛋拉霸機",
    })
  ) {
    state.modal = "gachapon";
  }

  drawGlobalBottomBar(state);
}

/* ------------------------------------------------------------------ *
 * CExchangeStage
 * ------------------------------------------------------------------ */

function renderExchangeStage(state: ClientAppState): void {
  const r = state.assets.renderer;
  const ui = state.ui;
  drawStageJpeg(state, "Exchange/CAStage");

  const ex = state.exchangeState;
  if (!ex) {
    r.drawText("目前無進行中的交易，請於大廳左側點擊線上玩家發起交易。", 400, 286, [1, 1, 1, 1], {
      align: "center",
      bold: true,
    });
    drawGlobalBottomBar(state);
    return;
  }

  r.drawText(`我的出價${ex.myLocked ? "（已鎖定）" : ""}`, 118, 120, [0.6, 1, 0.7, 1], {
    bold: true,
  });
  ui.drawSpriteDigits(state.assets, "Exchange/Ex_MoneyCount", String(ex.myLucci), 118, 142, 10);
  ex.myItems.forEach((id, idx) => {
    r.drawText(`· ${state.assets.shopById.get(id)?.name ?? `道具#${id}`}`, 118, 174 + idx * 22, [
      1,
      1,
      1,
      1,
    ]);
  });

  r.drawText(`對方 ${ex.partnerName}${ex.partnerLocked ? "（已鎖定）" : ""}`, 436, 120, [
    1,
    0.88,
    0.45,
    1,
  ], { bold: true });
  r.drawText(`${ex.partnerLucci.toLocaleString()} Lucci`, 436, 142, [1, 0.92, 0.4, 1]);
  ex.partnerItems.forEach((id, idx) => {
    r.drawText(`· ${state.assets.shopById.get(id)?.name ?? `道具#${id}`}`, 436, 174 + idx * 22, [
      1,
      1,
      1,
      1,
    ]);
  });

  r.drawText("我的背包（點擊加入／移出交易）", 104, 336, [1, 0.95, 0.45, 1], { bold: true });
  state.inventory.slice(0, 4).forEach((inv, idx) => {
    const nm = state.assets.shopById.get(inv.itemId)?.name ?? `#${inv.itemId}`;
    const picked = ex.myItems.includes(inv.itemId);
    const bx = 104 + idx * 148;
    if (
      ui.spriteButton(state.assets, `ex_item_${inv.itemId}`, "Shop/S_BtItemSlot01", bx, 356, {
        selected: picked,
        disabled: ex.myLocked,
        hitW: 63,
        hitH: 66,
        tooltip: nm,
      })
    ) {
      const next = picked
        ? ex.myItems.filter((x) => x !== inv.itemId)
        : [...ex.myItems, inv.itemId];
      state.net.sendJson(ClientOpcode.ExchangeUpdateOffer, { items: next, lucci: ex.myLucci });
    }
    state.assets.drawShopItemPreview(inv.itemId, bx + 31, 356 + 34, state.animTick);
    r.drawText(nm, bx + 31, 356 + 52, picked ? [1, 0.9, 0.45, 1] : [1, 1, 1, 1], {
      align: "center",
      bold: picked,
      maxWidth: 60,
    });
  });

  if (
    ui.spriteButton(state.assets, "ex_lucci", "UserMarket/UM_BtLucciMax", 104, 444, {
      disabled: ex.myLocked,
      hitW: 78,
      hitH: 21,
      tooltip: "追加 10,000 Lucci",
    })
  ) {
    state.net.sendJson(ClientOpcode.ExchangeUpdateOffer, {
      items: ex.myItems,
      lucci: ex.myLucci + 10000,
    });
  }

  if (
    ui.spriteButton(state.assets, "ex_ok", "Exchange/Ex_BtConfirm", 290, 442, {
      disabled: ex.myLocked,
      hitW: 111,
      hitH: 31,
    })
  ) {
    state.net.sendJson(ClientOpcode.ExchangeConfirm, {});
  }
  if (
    ui.spriteButton(state.assets, "ex_cancel", "Exchange/Ex_BtCancel", 418, 442, {
      hitW: 111,
      hitH: 31,
    })
  ) {
    state.net.sendJson(ClientOpcode.ExchangeCancel, {});
  }

  drawGlobalBottomBar(state);
}

/* ------------------------------------------------------------------ *
 * CUserMarketStage
 * ------------------------------------------------------------------ */

const MARKET_TABS = ["UserMarket/UM_TabMain", "Shop/S_TabChar", "Shop/S_TabSlot", "UserMarket/UM_TabMyItem"];

function renderUserMarketStage(state: ClientAppState): void {
  const r = state.assets.renderer;
  const ui = state.ui;
  drawStageJpeg(state, "UserMarket/Stage");

  // UM_BtItemSlot01 (468x27) listing rows
  state.marketListings.slice(0, 7).forEach((ls, idx) => {
    const ly = 128 + idx * 32;
    if (
      ui.spriteButton(state.assets, `mkt_row_${ls.listingId}`, "UserMarket/UM_BtItemSlot01", 32, ly, {
        hitW: 468,
        hitH: 27,
      })
    ) {
      const isMine = state.profile?.userId === ls.sellerId;
      if (isMine) {
        state.net.sendJson(ClientOpcode.MarketCancelListing, { listingId: ls.listingId });
      } else {
        state.net.sendJson(ClientOpcode.MarketBuyListing, { listingId: ls.listingId });
      }
    }
    const nm = state.assets.shopById.get(ls.itemId)?.name ?? `道具#${ls.itemId}`;
    r.drawText(`${nm}　賣家 ${ls.sellerName}`, 44, ly + 6, [1, 1, 1, 1], { maxWidth: 300 });
    r.drawText(`${ls.priceLucci.toLocaleString()} L`, 360, ly + 6, [1, 0.92, 0.4, 1]);
    const isMine = state.profile?.userId === ls.sellerId;
    r.drawText(isMine ? "下架" : "購買", 450, ly + 6, isMine ? [0.75, 0.85, 0.95, 1] : [1, 0.8, 0.4, 1], {
      bold: true,
    });
  });

  // Right panel: my inventory in native Shop/S_BtItemSlot01 slots + sale registration
  r.drawText("我的背包", 544, 134, [1, 0.95, 0.45, 1], { bold: true });
  state.inventory.slice(0, 6).forEach((inv, idx) => {
    const nm = state.assets.shopById.get(inv.itemId)?.name ?? `道具#${inv.itemId}`;
    const bx = 544 + (idx % 3) * 72;
    const by = 148 + Math.floor(idx / 3) * 74;
    const isSel = marketSelectedInvItemId === inv.itemId;
    if (
      ui.spriteButton(state.assets, `mkt_inv_${inv.itemId}`, "Shop/S_BtItemSlot01", bx, by, {
        selected: isSel,
        hitW: 63,
        hitH: 66,
        tooltip: nm,
      })
    ) {
      marketSelectedInvItemId = inv.itemId;
    }
    state.assets.drawShopItemPreview(inv.itemId, bx + 31, by + 34, state.animTick);
    r.drawText(nm, bx + 31, by + 52, isSel ? [1, 0.9, 0.45, 1] : [1, 1, 1, 1], {
      align: "center",
      bold: isSel,
      maxWidth: 60,
    });
  });

  if (
    ui.spriteButton(state.assets, "mkt_reg", "UserMarket/UM_BtItemRegistration", 544, 412, {
      disabled: marketSelectedInvItemId <= 0,
      hitW: 192,
      hitH: 48,
      tooltip: "上架登記",
    })
  ) {
    state.modal = "saleReg";
  }

  drawGlobalBottomBar(state);
}

/* ------------------------------------------------------------------ *
 * CChattingStage (交誼廳)
 * ------------------------------------------------------------------ */

function renderChattingStage(state: ClientAppState): void {
  const r = state.assets.renderer;
  const ui = state.ui;
  drawStageJpeg(state, "Chatting/CAStage");

  const dir = ui.getP1Direction(true);
  if (dir === Direction.Left) {
    cafeX = Math.max(80, cafeX - 3);
    cafeDir = Direction.Left;
  } else if (dir === Direction.Right) {
    cafeX = Math.min(720, cafeX + 3);
    cafeDir = Direction.Right;
  } else if (dir === Direction.Up) {
    cafeY = Math.max(180, cafeY - 3);
    cafeDir = Direction.Up;
  } else if (dir === Direction.Down) {
    cafeY = Math.min(480, cafeY + 3);
    cafeDir = Direction.Down;
  }

  state.assets.drawCharacterPaperDoll({
    charIndex: state.profile?.defaultChar ?? 0,
    team: 0,
    dir: cafeDir,
    moving: dir !== Direction.None,
    status: BomberStatus.Normal,
    animTick: state.animTick,
    anchorX: cafeX,
    anchorY: cafeY,
    equipped: state.profile?.equipped ?? EMPTY_EQUIPPED,
  });
  r.drawText(state.profile?.nickname ?? "玩家", cafeX, cafeY + 4, [1, 0.96, 0.45, 1], {
    align: "center",
    bold: true,
  });

  const lastChat = state.chatLog[state.chatLog.length - 1];
  if (lastChat) {
    ui.drawChatBalloon(state.assets, "Etc/ChatBalloon", lastChat.text, cafeX, cafeY - 26);
  }

  const chatF = ui.carvedField("cafe_chat", 190, 518, 420, 22, {
    placeholder: "方向鍵自由漫步，輸入對話後按 Enter...",
    assets: state.assets,
    drawNineSliceBg: true,
  });
  if (chatF.submitted) {
    const txt = chatF.value.trim();
    if (txt) state.net.sendJson(ClientOpcode.ChatMessage, { text: txt });
    ui.setFieldValue("cafe_chat", "");
  }

  drawGlobalBottomBar(state);
}

/* ------------------------------------------------------------------ *
 * CCreditStage — native StageCredit/Credit EUC-KR roll script
 * ------------------------------------------------------------------ */

interface CreditLine {
  text: string;
  r: number;
  g: number;
  b: number;
  image: number;
}

function loadCreditLines(state: ClientAppState): CreditLine[] {
  if (creditLines) return creditLines as unknown as CreditLine[];
  const raw = state.assets.getRawEntrySync("Fx", "StageCredit/Credit");
  if (!raw) {
    creditLines = [];
    return [];
  }
  let text: string;
  try {
    text = new TextDecoder("euc-kr").decode(raw);
  } catch {
    text = new TextDecoder("utf-8").decode(raw);
  }
  let col = { r: 1, g: 1, b: 1 };
  let image = -1;
  const out: CreditLine[] = [];
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (t.startsWith("#ChangeColor")) {
      const v = Number.parseInt(t.slice(12).trim(), 10);
      if (Number.isFinite(v)) {
        col = {
          r: ((v >> 16) & 0xff) / 255,
          g: ((v >> 8) & 0xff) / 255,
          b: (v & 0xff) / 255,
        };
      }
      continue;
    }
    if (t.startsWith("!")) {
      const v = Number.parseInt(t.slice(1), 10);
      image = Number.isFinite(v) ? v : -1;
      out.push({ text: "", r: col.r, g: col.g, b: col.b, image });
      image = -1;
      continue;
    }
    out.push({ text: line, r: col.r, g: col.g, b: col.b, image: -1 });
  }
  creditLines = out as unknown as typeof creditLines;
  return out;
}

function renderCreditStage(state: ClientAppState): void {
  const r = state.assets.renderer;
  const ui = state.ui;
  drawStageJpeg(state, "StageCredit/CAStage");

  const lines = loadCreditLines(state);

  if (!creditPaused) {
    creditScrollY -= creditSpeed * 0.8;
    if (creditScrollY < -(lines.length * 20 + 80)) creditScrollY = 500;
    if (creditScrollY > 520) creditScrollY = -(lines.length * 20 + 60);
  }

  const imgSheet = state.assets.getSpriteSync("Fx", "StageCredit/CreditImg");
  let ly = Math.round(creditScrollY);
  for (const ln of lines) {
    ly += 20;
    if (ly < 60 || ly > 510) continue;
    if (ln.image >= 0) {
      if (imgSheet && ln.image < imgSheet.frames.length) {
        state.assets.drawSpriteFrame(imgSheet, ln.image, 400 - 100, ly - 8);
      }
      ly += 14;
      continue;
    }
    if (ln.text.trim().length === 0) continue;
    r.drawText(ln.text.trim(), 400, ly, [ln.r, ln.g, ln.b, 1], {
      align: "center",
      outlined: true,
      maxWidth: 700,
    });
  }

  if (ui.spriteButton(state.assets, "cr_rew", "StageCredit/BtREW", 330, 535, { hitW: 43, hitH: 24 })) {
    creditSpeed = -2;
    creditPaused = false;
  }
  if (
    ui.spriteButton(state.assets, "cr_play", creditPaused ? "StageCredit/BtPlay" : "StageCredit/BtPause", 378, 535, {
      hitW: 43,
      hitH: 24,
    })
  ) {
    creditPaused = !creditPaused;
    creditSpeed = 1;
  }
  if (ui.spriteButton(state.assets, "cr_ff", "StageCredit/BtFF", 426, 535, { hitW: 43, hitH: 24 })) {
    creditSpeed = 3;
    creditPaused = false;
  }
  if (ui.spriteButton(state.assets, "cr_exit", "StageCredit/BtExit", 660, 566, { hitW: 92, hitH: 25 })) {
    state.switchStage(state.profile ? "Lobby" : "Login");
  }
}

/* ------------------------------------------------------------------ *
 * Native .i16 dialogs
 * ------------------------------------------------------------------ */

function drawDialog(state: ClientAppState, path: string, dx: number, dy: number): void {
  const sheet = state.assets.getSpriteSync("Fx", path);
  if (sheet) state.assets.drawSpriteFrame(sheet, 0, dx, dy);
}

function drawCreateRoomBody(
  state: ClientAppState,
  dx: number,
  dy: number,
  title: string,
  password: string,
  mode: GameMode,
  mapName: string,
  opts: { editableTitle: boolean; editableMap: boolean },
): { title: string; password: string; mode: GameMode; mapName: string } {
  const r = state.assets.renderer;
  const ui = state.ui;

  // Room title carved slot (dx+121, dy+76, 275x19)
  const titleF = ui.carvedField(
    opts.editableTitle ? "create_room_title" : "roominfo_title",
    dx + 121,
    dy + 76,
    275,
    19,
    {
      defaultValue: title,
      textColor: [0.04, 0.12, 0.3, 1],
      outlined: false,
    },
  );

  // Password checkbox + carved slot
  if (opts.editableTitle) {
    if (
      ui.spriteButton(state.assets, "cr_pw_check", "Etc/BtCheckBox", dx + 119, dy + 101, {
        selected: createRoomUsePassword,
        hitW: 15,
        hitH: 15,
        tooltip: "設定房間密碼",
      })
    ) {
      createRoomUsePassword = !createRoomUsePassword;
    }
  } else {
    ui.spriteButton(state.assets, "cr_pw_check", "Etc/BtCheckBox", dx + 119, dy + 101, {
      selected: createRoomUsePassword,
      disabled: true,
      hitW: 15,
      hitH: 15,
    });
  }
  const passF = ui.carvedField("create_room_pass", dx + 145, dy + 102, 120, 18, {
    defaultValue: password,
    password: true,
    disabled: !createRoomUsePassword,
    textColor: [0.04, 0.12, 0.3, 1],
    outlined: false,
  });

  // Left mode preview (203x168) at (dx+22, dy+213)
  const activeRow =
    ROOM_MODE_ROWS.find((row) => row.mode === mode) ?? ROOM_MODE_ROWS[0]!;
  const prevSheet = state.assets.getSpriteSync("Fx", activeRow.img);
  if (prevSheet) {
    state.assets.drawSpriteFrame(prevSheet, 0, dx + 22, dy + 213);
  }

  // Right mode buttons (120x32) at (dx+238, dy+213 + 34*i)
  let nextMode = mode;
  const checkSheet = state.assets.getSpriteSync("Fx", "Etc/Dlg_Create_Check");
  ROOM_MODE_ROWS.forEach((row, idx) => {
    const bx = dx + 238;
    const by = dy + 213 + 34 * idx;
    if (
      ui.spriteButton(state.assets, `cr_mode_${idx}`, row.bt, bx, by, {
        hitW: 120,
        hitH: 32,
        disabled: !opts.editableTitle,
        tooltip: row.label,
      })
    ) {
      nextMode = row.mode;
    }
    if (row.mode === mode && checkSheet) {
      // Etc/Dlg_Create_Check pivot (-201,-8) -> top-left = (x+201, y+8)
      state.assets.drawSpriteFrame(checkSheet, 0, bx + 100 - 201, by + 8 - 8);
    }
  });

  r.drawText(mapName, dx + 22, dy + 396, [1, 0.95, 0.5, 1], { bold: true, maxWidth: 200 });
  if (opts.editableMap) {
    if (
      ui.spriteButton(state.assets, "cr_map_prev", "Prepare/Dlg_PRE-SelMapListIcon", dx + 22, dy + 414, {
        hitW: 9,
        hitH: 9,
      })
    ) {
      createRoomMapIdx =
        (createRoomMapIdx - 1 + state.assets.mapNames.length) %
        Math.max(1, state.assets.mapNames.length);
    }
    if (
      ui.spriteButton(state.assets, "cr_map_next", "Prepare/Dlg_PRE-SelMapListIcon", dx + 40, dy + 414, {
        hitW: 9,
        hitH: 9,
      })
    ) {
      createRoomMapIdx = (createRoomMapIdx + 1) % Math.max(1, state.assets.mapNames.length);
    }
  }

  return {
    title: titleF.value.trim() || title,
    password: passF.value.trim(),
    mode: nextMode,
    mapName: state.assets.mapNames[createRoomMapIdx] ?? mapName,
  };
}

function renderGlobalModals(state: ClientAppState): void {
  if (state.modal === "none") return;
  const r = state.assets.renderer;
  const ui = state.ui;

  r.drawRect(0, 0, SCREEN_WIDTH, 600, [0, 0, 0, 0.52]);

  switch (state.modal) {
    case "newId": {
      const dx = 213;
      const dy = 153;
      drawDialog(state, "LoginStage/Dlg_LO-NewID", dx, dy);

      const uF = ui.carvedField("reg_user", dx + 136, dy + 68, 128, 18, {
        defaultValue: "BazziTW",
        textColor: [0.04, 0.12, 0.3, 1],
        outlined: false,
      });
      ui.spriteButton(state.assets, "reg_idcheck", "LoginStage/LO_Bt_IDCheck", dx + 272, dy + 66, {
        hitW: 81,
        hitH: 21,
        tooltip: "檢查帳號是否可用",
      });
      const pF = ui.carvedField("reg_pass", dx + 136, dy + 104, 210, 18, {
        defaultValue: "1234",
        password: true,
        textColor: [0.04, 0.12, 0.3, 1],
        outlined: false,
      });
      const nF = ui.carvedField("reg_nick", dx + 136, dy + 136, 210, 18, {
        defaultValue: "台灣藍寶",
        textColor: [0.04, 0.12, 0.3, 1],
        outlined: false,
      });

      if (
        ui.spriteButton(state.assets, "reg_agree", "Etc/BtOk", dx + 80, dy + 248, {
          hitW: 102,
          hitH: 30,
          tooltip: "送出註冊",
        }) ||
        uF.submitted ||
        pF.submitted ||
        nF.submitted
      ) {
        void (async () => {
          await state.net.connect();
          state.net.sendJson(ClientOpcode.RegisterAccount, {
            username: uF.value.trim() || "BazziTW",
            password: pF.value || "1234",
            nickname: nF.value.trim() || uF.value.trim() || "台灣藍寶",
          });
          state.modal = "none";
        })();
      }
      if (
        ui.spriteButton(state.assets, "reg_oppo", "Etc/BtCancel", dx + 192, dy + 248, {
          hitW: 102,
          hitH: 30,
        })
      ) {
        state.modal = "none";
      }
      break;
    }

    case "createRoom":
    case "roomInfo": {
      const dx = 193;
      const dy = 62;
      const isCreate = state.modal === "createRoom";
      drawDialog(
        state,
        isCreate ? "Lobby/Dlg_LB-Create" : "Prepare/Dlg_PRE-Roominfo",
        dx,
        dy,
      );
      const rm = state.currentRoom;
      const body = drawCreateRoomBody(
        state,
        dx,
        dy,
        isCreate ? "台灣爆爆王歡樂房！" : (rm?.title ?? ""),
        "",
        isCreate ? createRoomMode : (rm?.mode ?? GameMode.Normal),
        rm?.mapName ?? state.assets.mapNames[0] ?? "patrit_00",
        { editableTitle: isCreate || Boolean(rm?.slots.some((s) => s.isHost && s.userId === state.profile?.userId)), editableMap: true },
      );

      if (
        ui.spriteButton(state.assets, "cr_room_ok", "Etc/BtOk", dx + 96, dy + 408, {
          hitW: 102,
          hitH: 30,
        })
      ) {
        if (isCreate) {
          state.net.sendJson(ClientOpcode.CreateRoom, {
            title: body.title,
            password: body.password,
            mode: body.mode,
            mapName: body.mapName,
          });
        } else {
          state.net.sendJson(ClientOpcode.RoomSettingChange, {
            mode: body.mode,
            mapName: body.mapName,
          });
        }
        state.modal = "none";
      }
      if (
        ui.spriteButton(state.assets, "cr_room_cancel", "Etc/BtCancel", dx + 216, dy + 408, {
          hitW: 102,
          hitH: 30,
        })
      ) {
        state.modal = "none";
      }
      break;
    }

    case "practice": {
      const dx = 240;
      const dy = 174;
      drawDialog(state, "Lobby/Dlg_LB-Practice", dx, dy);

      const titleSheet = state.assets.getSpriteSync("Fx", "PraticePrepare/Practice_Title");
      if (titleSheet) {
        state.assets.drawSpriteFrame(titleSheet, 0, dx + 111, dy + 30);
      }

      const pMap = state.assets.mapNames[practiceMapIdx] ?? "patrit_00";
      r.drawText(`電腦人數 ${practiceBotCount}`, dx + 34, dy + 84, [1, 1, 1, 1], { bold: true });
      if (
        ui.spriteButton(state.assets, "prac_down", "PraticePrepare/Lev_Bt-Down", dx + 200, dy + 80, {
          hitW: 19,
          hitH: 18,
        })
      ) {
        practiceBotCount = Math.max(1, practiceBotCount - 1);
      }
      if (
        ui.spriteButton(state.assets, "prac_up", "PraticePrepare/Lev_Bt-Up", dx + 226, dy + 80, {
          hitW: 19,
          hitH: 18,
        })
      ) {
        practiceBotCount = Math.min(7, practiceBotCount + 1);
      }

      r.drawText(pMap, dx + 34, dy + 118, [0.85, 0.96, 1, 1], { maxWidth: 250 });
      if (
        ui.spriteButton(state.assets, "prac_map_prev", "PraticePrepare/Lev_Bt-Down", dx + 200, dy + 114, {
          hitW: 19,
          hitH: 18,
        })
      ) {
        practiceMapIdx =
          (practiceMapIdx - 1 + state.assets.mapNames.length) %
          Math.max(1, state.assets.mapNames.length);
      }
      if (
        ui.spriteButton(state.assets, "prac_map_next", "PraticePrepare/Lev_Bt-Up", dx + 226, dy + 114, {
          hitW: 19,
          hitH: 18,
        })
      ) {
        practiceMapIdx = (practiceMapIdx + 1) % Math.max(1, state.assets.mapNames.length);
      }
      drawMinimapPreview(state, pMap, dx + 34, dy + 130, 110, 52);

      if (
        ui.spriteButton(state.assets, "prac_ok", "Etc/BtOk", dx + 34, dy + 204, {
          hitW: 102,
          hitH: 30,
        })
      ) {
        state.modal = "none";
        void startPracticeMatch(state, pMap, practiceBotCount, GameMode.Practice);
      }
      if (
        ui.spriteButton(state.assets, "prac_cancel", "Etc/BtCancel", dx + 184, dy + 204, {
          hitW: 102,
          hitH: 30,
        })
      ) {
        state.modal = "none";
      }
      break;
    }

    case "selectMap": {
      const dx = 168;
      const dy = 48;
      drawDialog(state, "Prepare/Dlg_PRE-SelMap", dx, dy);

      const curSel = selectedMapInModal || state.currentRoom?.mapName || "patrit_00";

      if (
        ui.spriteButton(
          state.assets,
          "selmap_avail",
          "Prepare/Dlg_PRE-SelMapBt_ListAvailable",
          dx + 22,
          dy + 42,
          { hitW: 124, hitH: 27 },
        )
      ) {
        mapPickerOffset = 0;
      }
      if (
        ui.spriteButton(
          state.assets,
          "selmap_all",
          "Prepare/Dlg_PRE-SelMapBt_ListAll",
          dx + 154,
          dy + 42,
          { hitW: 124, hitH: 27 },
        )
      ) {
        mapPickerOffset = 0;
      }

      drawMinimapPreview(state, curSel, dx + 22, dy + 80, 190, 150);
      r.drawText(`共 ${state.assets.mapNames.length} 張原版地圖`, dx + 117, dy + 240, [
        1,
        0.94,
        0.45,
        1,
      ], { align: "center", bold: true });

      const overBar = state.assets.getSpriteSync("Fx", "Prepare/Dlg_PRE-OverMapBar");
      const listIcon = state.assets.getSpriteSync("Fx", "Prepare/Dlg_PRE-SelMapListIcon");
      const sliceMaps = state.assets.mapNames.slice(mapPickerOffset, mapPickerOffset + 18);

      sliceMaps.forEach((mName, idx) => {
        const mx = dx + 224;
        const my = dy + 80 + idx * 20;
        const isSelected = curSel === mName;
        const hovered = ui.hitRect(mx, my, 224, 18);
        if (hovered) ui.markInteractiveHover(`selmap_${mName}`);
        if ((isSelected || hovered) && overBar) {
          state.assets.drawSpriteFrame(overBar, 0, mx, my + 1);
        }
        if (listIcon) {
          state.assets.drawSpriteFrame(listIcon, isSelected ? 1 : 0, mx + 4, my + 4);
        }
        r.drawText(mName, mx + 20, my + 2, isSelected ? [1, 0.96, 0.4, 1] : [1, 1, 1, 1], {
          bold: isSelected,
          maxWidth: 198,
        });
        if (hovered && ui.mouseJustPressed) {
          ui.mouseClicked = false;
          selectedMapInModal = mName;
        }
      });

      mapPickerOffset = ui.vScrollBar(
        state.assets,
        "selmap_scroll",
        dx + 430,
        dy + 80,
        360,
        mapPickerOffset,
        Math.max(0, state.assets.mapNames.length - 18),
        18,
      );

      if (
        ui.spriteButton(state.assets, "selmap_ok", "Etc/BtOk", dx + 124, dy + 448, {
          hitW: 102,
          hitH: 30,
        })
      ) {
        if (selectedMapInModal) {
          state.net.sendJson(ClientOpcode.RoomSettingChange, { mapName: selectedMapInModal });
        }
        state.modal = "none";
      }
      if (
        ui.spriteButton(state.assets, "selmap_cancel", "Etc/BtCancel", dx + 238, dy + 448, {
          hitW: 102,
          hitH: 30,
        })
      ) {
        state.modal = "none";
      }
      break;
    }

    case "myPage": {
      const dx = 102;
      const dy = 30;
      drawDialog(state, "MyInfo/MP_Stage", dx, dy);

      MP_TABS.forEach((sp, idx) => {
        if (
          ui.spriteButton(state.assets, `mp_tab_${idx}`, sp, dx + 62 + idx * 86, dy + 6, {
            selected: myPageTab === idx,
            hitW: 84,
            hitH: 37,
          })
        ) {
          myPageTab = idx;
        }
      });

      const p = state.profile;
      const profileSheet = state.assets.getSpriteSync("Fx", "MyInfo/MP_BackProfile");
      if (profileSheet) state.assets.drawSpriteFrame(profileSheet, 0, dx + 20, dy + 56);
      const recordSheet = state.assets.getSpriteSync("Fx", "MyInfo/MP_BackInfoRecord");
      if (recordSheet) state.assets.drawSpriteFrame(recordSheet, 0, dx + 20, dy + 208);
      const bagSheet = state.assets.getSpriteSync("Fx", "MyInfo/MP_ItemBag");
      if (bagSheet) state.assets.drawSpriteFrame(bagSheet, 0, dx + 352, dy + 56);

      if (myPageTab === 2) {
        state.quests.slice(0, 6).forEach((q, idx) => {
          const qy = dy + 226 + idx * 34;
          r.drawText(`${q.title} (${q.progress}/${q.target})`, dx + 34, qy, [1, 1, 1, 1], {
            bold: true,
            maxWidth: 290,
          });
          r.drawText(q.description, dx + 34, qy + 16, [0.8, 0.94, 1, 1], { maxWidth: 290 });
          const canClaim = !q.claimed && q.progress >= q.target;
          if (
            ui.spriteButton(state.assets, `mp_quest_${q.questId}`, "Shop/S_BtLotBuy", dx + 250, qy, {
              disabled: !canClaim,
              hitW: 57,
              hitH: 20,
              overlayLabel: q.claimed ? "已領" : "領取",
            })
          ) {
            state.net.sendJson(ClientOpcode.QuestAction, { questId: q.questId });
          }
        });
      } else if (myPageTab === 1) {
        if (p) {
          state.assets.drawCharacterPaperDoll({
            charIndex: p.defaultChar,
            team: 0,
            dir: Direction.Down,
            moving: true,
            status: BomberStatus.Normal,
            animTick: state.animTick,
            anchorX: dx + 130,
            anchorY: dy + 172,
            equipped: p.equipped,
            scale: 1.3,
          });
          ui.spriteButton(state.assets, "mp_selcha", "MyInfo/MP_BtSelChaDown", dx + 21, dy + 73, {
            hitW: 202,
            hitH: 35,
            tooltip: "更換代表角色",
          });
        }
        state.inventory.slice(0, 9).forEach((inv, idx) => {
          const slot = state.assets.getSpriteSync("Fx", "MyInfo/MP_BtItemBack00");
          const bx = dx + 360 + (idx % 3) * 106;
          const by = dy + 230 + Math.floor(idx / 3) * 84;
          const hovered = ui.hitRect(bx, by, 92, 78);
          if (hovered) ui.markInteractiveHover(`mp_inv_${inv.itemId}`);
          if (slot) state.assets.drawSpriteFrame(slot, hovered ? 1 : 0, bx, by);
          state.assets.drawShopItemPreview(inv.itemId, bx + 46, by + 40, state.animTick);
          const nm = state.assets.shopById.get(inv.itemId)?.name ?? `道具#${inv.itemId}`;
          r.drawText(inv.equippedSlot >= 0 ? `${nm}·裝備中` : nm, bx + 46, by + 62, [1, 0.95, 0.5, 1], {
            align: "center",
            maxWidth: 88,
          });
          if (hovered && ui.mouseJustPressed) {
            ui.mouseClicked = false;
            state.net.sendJson(ClientOpcode.EquipAvatarItem, { itemId: inv.itemId });
          }
        });
        ui.spriteButton(state.assets, "mp_bag_left", "MyInfo/MP_BtItemBagLeft", dx + 360, dy + 150, {
          hitW: 29,
          hitH: 21,
        });
        ui.spriteButton(state.assets, "mp_bag_right", "MyInfo/MP_BtItemBagRight", dx + 640, dy + 150, {
          hitW: 29,
          hitH: 21,
        });
      } else if (p) {
        state.assets.drawCharacterPaperDoll({
          charIndex: p.defaultChar,
          team: 0,
          dir: Direction.Down,
          moving: true,
          status: BomberStatus.Normal,
          animTick: state.animTick,
          anchorX: dx + 120,
          anchorY: dy + 168,
          equipped: p.equipped,
          scale: 1.3,
        });
        ui.spriteButton(state.assets, "mp_selcha2", "MyInfo/MP_BtSelChaDown", dx + 21, dy + 73, {
          hitW: 202,
          hitH: 35,
          tooltip: "更換代表角色",
        });
        r.drawText(`暱稱　${p.nickname}`, dx + 34, dy + 226, [1, 1, 1, 1], { bold: true });
        r.drawText(`等級　Lv.${p.level}（${p.exp}/${p.nextExp}）`, dx + 34, dy + 250, [0.8, 0.95, 1, 1]);
        r.drawText(`戰績　${p.wins} 勝 ${p.losses} 敗 ${p.draws} 和`, dx + 34, dy + 274, [1, 0.92, 0.5, 1]);
        r.drawText(`Lucci　${p.lucci.toLocaleString()}`, dx + 34, dy + 298, [1, 0.9, 0.4, 1]);
        r.drawText(`點數　${p.cash.toLocaleString()}`, dx + 34, dy + 322, [1, 0.78, 0.9, 1]);
        r.drawText(`情侶　${p.couplePartner ? p.couplePartner : "無"}`, dx + 34, dy + 346, [
          1,
          0.72,
          0.88,
          1,
        ]);
      }

      if (
        ui.spriteButton(state.assets, "mp_exit", "MyInfo/MP_BtExit", dx + 54, dy + 490, {
          hitW: 137,
          hitH: 31,
          tooltip: "關閉",
        })
      ) {
        state.modal = "none";
      }
      break;
    }

    case "messenger": {
      const dx = 251;
      const dy = 173;
      drawDialog(state, "NM/Dlg_NM-ListGlobal", dx, dy);

      const rowImg = state.assets.getSpriteSync("Fx", "NM/Dlg_NM-ListGlobalImg");
      const logonIcon = state.assets.getSpriteSync("Fx", "NM/Dlg_NM-ListIcon_Logon");
      const logoutIcon = state.assets.getSpriteSync("Fx", "NM/Dlg_NM-ListIcon_Logout");

      state.friends.slice(0, 6).forEach((fr, idx) => {
        const ry = dy + 73 + idx * 21;
        const hovered = ui.hitRect(dx + 16, ry, 245, 20);
        if (hovered) ui.markInteractiveHover(`msg_${fr.nickname}`);
        if (rowImg) state.assets.drawSpriteFrame(rowImg, hovered ? 1 : 0, dx + 16, ry);
        const icon = fr.online ? logonIcon : logoutIcon;
        if (icon) state.assets.drawSpriteFrame(icon, 0, dx + 22, ry + 3);
        r.drawText(`Lv.${fr.level} ${fr.nickname}`, dx + 44, ry + 4, [1, 1, 1, 1], {
          maxWidth: 200,
        });
        if (hovered && ui.mouseJustPressed) {
          ui.mouseClicked = false;
          messengerOpenUserId = fr.userId;
        }
        if (
          ui.spriteButton(state.assets, `msg_del_${fr.nickname}`, "NM/Dlg_NM-ListBt_Close", dx + 262, ry + 1, {
            hitW: 23,
            hitH: 20,
            tooltip: "刪除好友",
          })
        ) {
          state.net.sendJson(ClientOpcode.FriendAction, { action: "remove", nickname: fr.nickname });
        }
      });

      ui.vScrollBar(state.assets, "msg_scroll", dx + 268, dy + 73, 126, 0, Math.max(0, state.friends.length - 6), 1);

      const nickF = ui.carvedField("friend_nick", dx + 20, dy + 216, 150, 18, {
        placeholder: "輸入玩家暱稱...",
        assets: state.assets,
        drawNineSliceBg: true,
      });
      if (
        ui.spriteButton(state.assets, "msg_add", "Etc/BtOk", dx + 180, dy + 212, {
          hitW: 102,
          hitH: 30,
          tooltip: "加入好友",
        }) &&
        nickF.value.trim()
      ) {
        state.net.sendJson(ClientOpcode.FriendAction, { action: "add", nickname: nickF.value.trim() });
        ui.setFieldValue("friend_nick", "");
      }

      if (
        ui.spriteButton(state.assets, "msg_close", "NM/Dlg_NM-ListBt_Exit", dx + 258, dy + 224, {
          hitW: 23,
          hitH: 20,
          tooltip: "關閉",
        })
      ) {
        state.modal = "none";
      }

      if (messengerOpenUserId > 0) {
        const sel = state.friends.find((f) => f.userId === messengerOpenUserId);
        const mx = 162;
        const my = 83;
        drawDialog(state, "NM/Dlg_NM-MsgGlobal", mx, my);
        r.drawText(`致 ${sel?.nickname ?? ""}`, mx + 24, my + 60, [1, 0.95, 0.45, 1], { bold: true });
        const bodyF = ui.carvedField("msg_body", mx + 24, my + 300, 300, 60, {
          placeholder: "輸入訊息內容...",
          assets: state.assets,
          drawNineSliceBg: true,
        });
        if (
          (ui.spriteButton(state.assets, "msg_send", "NM/Dlg_NM-MsgBt_Send", mx + 340, my + 296, {
            hitW: 102,
            hitH: 30,
            tooltip: "寄出",
          }) ||
            bodyF.submitted) &&
          bodyF.value.trim() &&
          sel
        ) {
          state.net.sendJson(ClientOpcode.NoteAction, {
            action: "send",
            receiver: sel.nickname,
            content: bodyF.value.trim(),
          });
          ui.setFieldValue("msg_body", "");
          messengerOpenUserId = 0;
        }
        if (
          ui.spriteButton(state.assets, "msg_back", "NM/Dlg_NM-ListBt_Close", mx + 424, my + 300, {
            hitW: 23,
            hitH: 20,
            tooltip: "返回名單",
          })
        ) {
          messengerOpenUserId = 0;
        }
      }
      break;
    }

    case "smsMail": {
      const dx = 162;
      const dy = 83;
      drawDialog(state, "NM/Dlg_NM-MsgGlobal", dx, dy);

      const rowBar = state.assets.getSpriteSync("Fx", "NM/Dlg_NM-MsgBt_MsgSelBar");
      state.notes.slice(0, 8).forEach((n, idx) => {
        const ry = dy + 60 + idx * 26;
        const hovered = ui.hitRect(dx + 24, ry, 372, 24);
        if (hovered) ui.markInteractiveHover(`note_${n.noteId}`);
        if (rowBar) state.assets.drawSpriteFrame(rowBar, hovered ? 1 : 0, dx + 24, ry);
        r.drawText(`${n.sender}：${n.content}`, dx + 32, ry + 6, [1, 1, 1, 1], { maxWidth: 330 });
        if (
          ui.spriteButton(state.assets, `note_del_${n.noteId}`, "NM/Dlg_NM-MsgBt_Del", dx + 348, ry + 2, {
            hitW: 23,
            hitH: 20,
            tooltip: "刪除信件",
          })
        ) {
          state.net.sendJson(ClientOpcode.NoteAction, { action: "delete", noteId: n.noteId });
        }
      });

      const toF = ui.carvedField("note_to", dx + 24, dy + 300, 120, 22, {
        placeholder: "收件暱稱...",
        assets: state.assets,
        drawNineSliceBg: true,
      });
      const msgF = ui.carvedField("note_msg", dx + 156, dy + 300, 168, 22, {
        placeholder: "信件內容...",
        assets: state.assets,
        drawNineSliceBg: true,
      });
      if (
        (ui.spriteButton(state.assets, "note_send", "NM/Dlg_NM-MsgBt_Send", dx + 336, dy + 296, {
          hitW: 102,
          hitH: 30,
          tooltip: "寄出信件",
        }) ||
          msgF.submitted) &&
        toF.value.trim() &&
        msgF.value.trim()
      ) {
        state.net.sendJson(ClientOpcode.NoteAction, {
          action: "send",
          receiver: toF.value.trim(),
          content: msgF.value.trim(),
        });
        ui.setFieldValue("note_msg", "");
      }
      if (
        ui.spriteButton(state.assets, "note_close", "NM/Dlg_NM-MsgBt_DelAll", dx + 336, dy + 340, {
          hitW: 102,
          hitH: 30,
          tooltip: "關閉",
        })
      ) {
        state.modal = "none";
      }
      break;
    }

    case "tutorial": {
      const dx = 102;
      const dy = 60;
      drawDialog(state, "Tutorial/Tutorialback", dx, dy);
      const page = state.assets.getSpriteSync(
        "Fx",
        `Tutorial/${String(tutorialPage + 1).padStart(2, "0")}`,
      );
      if (page) state.assets.drawSpriteFrame(page, 0, dx + 81, dy + 58);

      if (
        ui.spriteButton(state.assets, "tut_prev", "Tutorial/back-button", dx + 102, dy + 436, {
          disabled: tutorialPage <= 0,
          hitW: 31,
          hitH: 27,
        })
      ) {
        tutorialPage = Math.max(0, tutorialPage - 1);
      }
      if (
        ui.spriteButton(state.assets, "tut_first", "Tutorial/end-button", dx + 140, dy + 436, {
          hitW: 31,
          hitH: 27,
          tooltip: "回到第一頁",
        })
      ) {
        tutorialPage = 0;
      }
      if (
        ui.spriteButton(state.assets, "tut_last", "Tutorial/front-button", dx + 500, dy + 436, {
          hitW: 31,
          hitH: 27,
          tooltip: "跳到最後一頁",
        })
      ) {
        tutorialPage = 12;
      }
      if (
        ui.spriteButton(state.assets, "tut_next", "Tutorial/next-button", dx + 462, dy + 434, {
          disabled: tutorialPage >= 12,
          hitW: 31,
          hitH: 27,
        })
      ) {
        tutorialPage = Math.min(12, tutorialPage + 1);
      }
      if (
        ui.spriteButton(state.assets, "tut_close", "Etc/BtClose", dx + 248, dy + 434, {
          hitW: 102,
          hitH: 30,
          tooltip: "關閉",
        })
      ) {
        state.modal = "none";
      }
      break;
    }

    case "option": {
      const dx = 197;
      const dy = 69;
      drawDialog(state, "Etc/Dlg_Option", dx, dy);

      const rows: {
        y: number;
        label: string;
        get: () => boolean;
        setA: () => void;
        setB: () => void;
      }[] = [
        {
          y: 188,
          label: "背景音樂",
          get: () => optionBgm,
          setA: () => {
            optionBgm = true;
          },
          setB: () => {
            optionBgm = false;
          },
        },
        {
          y: 215,
          label: "音效",
          get: () => optionSfx,
          setA: () => {
            optionSfx = true;
            state.audio.toggleMute();
          },
          setB: () => {
            optionSfx = false;
            state.audio.toggleMute();
          },
        },
        {
          y: 242,
          label: "拒絕所有交易提議",
          get: () => optionRefuseTrade,
          setA: () => {
            optionRefuseTrade = true;
          },
          setB: () => {
            optionRefuseTrade = false;
          },
        },
        {
          y: 269,
          label: "拒絕好友邀請",
          get: () => optionRefuseFriend,
          setA: () => {
            optionRefuseFriend = true;
          },
          setB: () => {
            optionRefuseFriend = false;
          },
        },
        {
          y: 296,
          label: "雙人同機 2P",
          get: () => state.local2PEnabled,
          setA: () => {
            state.net.sendJson(ClientOpcode.Login2P, {
              enable: true,
              nickname: `${state.profile?.nickname ?? "P1"}_2P`,
              charIndex: 5,
            });
          },
          setB: () => {
            state.net.sendJson(ClientOpcode.Login2P, { enable: false });
          },
        },
        {
          y: 323,
          label: "自動準備",
          get: () => autoReadyChecked,
          setA: () => {
            autoReadyChecked = true;
          },
          setB: () => {
            autoReadyChecked = false;
          },
        },
        {
          y: 350,
          label: "拒絕密語",
          get: () => optionRefuseWhisper,
          setA: () => {
            optionRefuseWhisper = true;
          },
          setB: () => {
            optionRefuseWhisper = false;
          },
        },
      ];

      rows.forEach((row, idx) => {
        r.drawText(row.label, dx + 30, dy + row.y + 2, [1, 1, 1, 1], { outlined: true });
        if (
          ui.spriteButton(state.assets, `opt_a_${idx}`, "Etc/BtCheckBox", dx + 157, dy + row.y, {
            selected: row.get(),
            hitW: 15,
            hitH: 15,
            tooltip: "開啟",
          })
        ) {
          row.setA();
        }
        if (
          ui.spriteButton(state.assets, `opt_b_${idx}`, "Etc/BtCheckBox", dx + 284, dy + row.y, {
            selected: !row.get(),
            hitW: 15,
            hitH: 15,
            tooltip: "關閉",
          })
        ) {
          row.setB();
        }
      });

      if (
        ui.spriteButton(state.assets, "opt_ok", "Etc/BtOk", dx + 94, dy + 417, {
          hitW: 102,
          hitH: 30,
        })
      ) {
        state.modal = "none";
      }
      if (
        ui.spriteButton(state.assets, "opt_cancel", "Etc/BtCancel", dx + 210, dy + 417, {
          hitW: 102,
          hitH: 30,
        })
      ) {
        state.modal = "none";
      }
      break;
    }

    case "sendGift": {
      const dx = 203;
      const dy = 97;
      drawDialog(state, "Shop/S_DlgSendGift", dx, dy);

      const selItem = state.assets.shopCatalog.find((x) => x.itemId === shopSelectedItemId);
      if (selItem) {
        state.assets.drawShopItemPreview(selItem.itemId, dx + 60, dy + 120, state.animTick, 1.1);
        r.drawText(selItem.name, dx + 110, dy + 112, [1, 0.95, 0.5, 1], { bold: true, maxWidth: 250 });
      }

      const giftTo = ui.carvedField("shop_gift_to", dx + 118, dy + 169, 210, 18, {
        placeholder: "收禮玩家暱稱",
        textColor: [0.04, 0.12, 0.3, 1],
        outlined: false,
      });
      const giftMsg = ui.carvedField("shop_gift_msg", dx + 118, dy + 198, 210, 18, {
        defaultValue: "送給你一份爆爆王禮物！",
        textColor: [0.04, 0.12, 0.3, 1],
        outlined: false,
      });

      if (
        ui.spriteButton(state.assets, "gift_ok", "Etc/BtOk", dx + 88, dy + 360, {
          hitW: 102,
          hitH: 30,
        }) ||
        giftTo.submitted ||
        giftMsg.submitted
      ) {
        if (selItem && giftTo.value.trim()) {
          state.net.sendJson(ClientOpcode.ShopGiftItem, {
            itemId: selItem.itemId,
            receiver: giftTo.value.trim(),
            message: giftMsg.value.trim() || "送給你一份爆爆王禮物！",
          });
          state.modal = "none";
        } else {
          ui.pushToast("請先輸入收禮玩家暱稱！");
        }
      }
      if (
        ui.spriteButton(state.assets, "gift_cancel", "Etc/BtCancel", dx + 204, dy + 360, {
          hitW: 102,
          hitH: 30,
        })
      ) {
        state.modal = "none";
      }
      break;
    }

    case "gachapon": {
      const dx = 154;
      const dy = 119;
      drawDialog(state, "Shop/S_DlgLot01", dx, dy);
      if (gachaponSpinTicks > 0) gachaponSpinTicks--;

      const cardSheet = state.assets.getSpriteSync("Fx", "Shop/S_LotCard01");
      for (let i = 0; i < 3; i++) {
        const cxp = dx + 96 + i * 112;
        const cyp = dy + 108;
        if (!cardSheet) continue;
        const idx =
          gachaponSpinTicks > 0
            ? (Math.floor(state.animTick / 2) + i * 3) % cardSheet.frames.length
            : (state.lastSlotResult?.reels[i] ?? i) % cardSheet.frames.length;
        if (gachaponSpinTicks > 0 || !state.lastSlotResult) {
          state.assets.drawSpriteFrame(cardSheet, idx, cxp, cyp);
        } else {
          state.assets.drawSpriteFrame(cardSheet, idx, cxp, cyp);
        }
      }

      const prize = state.lastSlotResult?.prizeItem;
      if (prize && gachaponSpinTicks === 0) {
        state.assets.drawShopItemPreview(prize.itemId, dx + 252, dy + 250, state.animTick, 1.1);
        r.drawText(`獲得獎品：${prize.name}`, dx + 252, dy + 232, [1, 0.95, 0.45, 1], {
          align: "center",
          bold: true,
        });
      }

      if (
        ui.spriteButton(state.assets, "gacha_spin", "Shop/S_BtLotBuy", dx + 207, dy + 291, {
          disabled: gachaponSpinTicks > 0,
          hitW: 57,
          hitH: 20,
          tooltip: "開始拉霸（1,500 Lucci）",
        })
      ) {
        gachaponSpinTicks = 24;
        state.net.sendJson(ClientOpcode.SlotMachinePlay, {});
      }
      if (
        ui.spriteButton(state.assets, "gacha_ok", "Etc/BtOk", dx + 207, dy + 321, {
          hitW: 102,
          hitH: 30,
        })
      ) {
        state.modal = "none";
      }
      break;
    }

    case "saleReg": {
      const dx = 207;
      const dy = 26;
      drawDialog(state, "UserMarket/UM_DlgSaleRegistration", dx, dy);

      const inv = state.inventory.find((x) => x.itemId === marketSelectedInvItemId);
      if (inv) {
        state.assets.drawShopItemPreview(inv.itemId, dx + 70, dy + 140, state.animTick, 1.1);
        r.drawText(state.assets.shopById.get(inv.itemId)?.name ?? `道具#${inv.itemId}`, dx + 130, dy + 132, [
          1,
          0.95,
          0.5,
          1,
        ], { bold: true, maxWidth: 220 });
      }

      const priceF = ui.carvedField("mkt_price", dx + 130, dy + 200, 200, 18, {
        defaultValue: "10000",
        textColor: [0.04, 0.12, 0.3, 1],
        outlined: false,
      });

      if (
        ui.spriteButton(state.assets, "salereg_ok", "Etc/BtOk", dx + 88, dy + 500, {
          hitW: 102,
          hitH: 30,
        }) ||
        priceF.submitted
      ) {
        state.net.sendJson(ClientOpcode.MarketCreateListing, {
          itemId: marketSelectedInvItemId,
          priceLucci: Math.max(100, Number(priceF.value) || 10000),
        });
        state.modal = "none";
      }
      if (
        ui.spriteButton(state.assets, "salereg_cancel", "Etc/BtCancel", dx + 204, dy + 500, {
          hitW: 102,
          hitH: 30,
        })
      ) {
        state.modal = "none";
      }
      break;
    }

    default:
      state.modal = "none";
      break;
  }
}

/* ------------------------------------------------------------------ *
 * Entry point
 * ------------------------------------------------------------------ */

export function renderNonGameStage(state: ClientAppState): void {
  switch (state.stage) {
    case "Title":
      renderTitleStage(state);
      break;
    case "Login":
      renderLoginStage(state);
      break;
    case "SelectServer":
      renderSelectServerStage(state);
      break;
    case "Lobby":
      renderLobbyStage(state);
      break;
    case "Prepare":
      renderPrepareStage(state);
      break;
    case "Shop":
      renderShopStage(state);
      break;
    case "Exchange":
      renderExchangeStage(state);
      break;
    case "UserMarket":
      renderUserMarketStage(state);
      break;
    case "Chatting":
      renderChattingStage(state);
      break;
    case "Credit":
      renderCreditStage(state);
      break;
    case "Game":
      break;
  }

  renderGlobalModals(state);
}
